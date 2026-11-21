// BGP-4（eBGP）：鄰居關係（TCP 179）、路徑向量的傳遞、最佳路徑選擇、route-map / prefix-list / as-path 過濾
//
// 設定（IOS 路由器）：
//   d.bgp = { asn, rid, log, neighbors: [{ ip, remoteAs, desc, rmIn, rmOut, plIn, plOut, flIn, flOut, shut, defOrig }], networks: [{ net, bits }],
//             redist: [{ src: 'connected' | 'static' | 'ospf', metric?, rm? }] }
//   d.routeMaps   = { 名稱: [{ seq, action, match: { pl?, fl? }, set: { lp?, prepend?: [as…], med?, weight? } }] }
//   d.prefixLists = { 名稱: [{ seq, action, net, bits, ge?, le? }] }
//   d.asPathAcl   = { 編號: [{ action, re }] }
// 網際網路那一端（internet 設備，玩家不能改）：d.inet.bgp = { asn, neighbors: [{ ip, remoteAs, role: 'customer' | 'peer', defOrig }], networks: [{ net, bits }] }
//   ISP 對客戶學來的路由給比較高的 local-preference（200）；「其他網路」則單純比 AS path 的長短。
//
// 執行期：state.dyn.bgp[兩端] = { since, up, last }；d.rt.bgp = { rid, peers: [...], table: [...] }
import { parseIp, fmtIp, netOf, sameNet } from './ip.js';
import { plHit, aclRouteHit, rmRoute, ospfInternal } from './policy.js';

export const BGP_UP = 10; // 設定好之後：TCP 三向交握、OPEN、KEEPALIVE，大約十秒進到 Established
export const BGP_HOLD = 180; // 對方沒有消息（線路沒斷，只是路上不通）：hold time 到了才斷
const AD_EBGP = 20;

/** 這台設備的 BGP 設定（路由器或網際網路那一端） */
export function bgpCfg(d) {
  if (d.bgp && d.bgp.asn) return d.bgp;
  if (d.inet && d.inet.bgp) return d.inet.bgp;
  return null;
}
const isInet = (d) => d.kind === 'internet';

/** BGP 的 Router ID：bgp router-id，不然和 OSPF 一樣挑 Loopback、再來是最大的介面 IP */
export function bgpRid(d) {
  const c = bgpCfg(d);
  const set = parseIp((c && c.rid) || '');
  if (set != null) return set;
  const loops = d.ifaces.filter((i) => i.bind.t === 'loop' && i.rt && i.rt.ip != null).map((i) => i.rt.ip >>> 0);
  if (loops.length) return Math.max(...loops);
  const all = d.ifaces.filter((i) => i.rt && i.rt.ip != null).map((i) => i.rt.ip >>> 0);
  return all.length ? Math.max(...all) : 0;
}

/** 這台設備有沒有把 src 設成鄰居（決定要不要接受 TCP 179 的連線） */
export function bgpAccepts(d, src) {
  const c = bgpCfg(d);
  return !!c && c.neighbors.some((n) => parseIp(n.ip) === src && !n.shut);
}

// ───────────────────────── 政策：prefix-list、as-path、route-map ─────────────────────────

function flHit(d, num, r) {
  const path = r.aspath.join(' ');
  for (const e of (d.asPathAcl || {})[num] || []) {
    let re;
    try { re = new RegExp(e.re.replace(/_/g, '(^| |$)')); } catch { continue; }
    if (re.test(path)) return e.action === 'permit';
  }
  return false;
}
/** 套用 route-map：回傳修改過的路由，或 null（被擋掉） */
function applyRm(d, name, r) {
  const rm = (d.routeMaps || {})[name];
  if (!rm) return null; // 參照了不存在的 route-map：什麼都不放行（和 IOS 一樣）
  for (const e of rm.slice().sort((a, b) => a.seq - b.seq)) {
    const m = e.match || {};
    if (m.pl && !plHit(d, m.pl, r)) continue;
    if (m.fl && !flHit(d, m.fl, r)) continue;
    if (m.acl && !aclRouteHit(d, m.acl, r)) continue;
    if (e.action === 'deny') return null;
    const x = { ...r, aspath: r.aspath.slice() };
    const s = e.set || {};
    if (s.lp != null) x.lp = s.lp;
    if (s.med != null) x.med = s.med;
    if (s.weight != null) x.weight = s.weight;
    if (s.prepend && s.prepend.length) x.prepend = s.prepend.slice();
    return x;
  }
  return null;
}

// ───────────────────────── 最佳路徑 ─────────────────────────

const ORIGIN = { i: 0, e: 1, '?': 2 };
/** 比較兩條路：負數表示 a 比較好（weight → local-preference → 自己發出的 → AS path 短 → origin → MED → Router ID 小） */
export function bgpCompare(a, b) {
  return (b.weight || 0) - (a.weight || 0) || (b.lp ?? 100) - (a.lp ?? 100) || (b.local ? 1 : 0) - (a.local ? 1 : 0)
    || a.aspath.length - b.aspath.length || ORIGIN[a.origin] - ORIGIN[b.origin] || (a.med || 0) - (b.med || 0) || ((a.peerRid >>> 0) - (b.peerRid >>> 0));
}
export const BEST_REASON = (a, b) => {
  if ((a.weight || 0) !== (b.weight || 0)) return 'weight 比較大';
  if ((a.lp ?? 100) !== (b.lp ?? 100)) return `local-preference 比較高（${a.lp ?? 100} 對 ${b.lp ?? 100}）`;
  if (a.aspath.length !== b.aspath.length) return `AS path 比較短（${a.aspath.length} 對 ${b.aspath.length}）`;
  if ((a.med || 0) !== (b.med || 0)) return 'MED 比較小';
  return 'Router ID 比較小';
};

// ───────────────────────── 主要的計算 ─────────────────────────

/**
 * 每次重新計算路由時呼叫（在 OSPF 之後）。transact 用來確認 TCP 179 通不通，
 * linkUp(d, ip) 判斷通往鄰居的直連介面是不是還亮著（fast-external-fallover）
 */
export function computeBgp(state, { transact, logEvent, ospfOn = () => false }) {
  const dyn = state.dyn, now = state.clock;
  const tbl = (dyn.bgp ||= {});
  const speakers = Object.values(state.devices).filter((d) => bgpCfg(d) && !(state.down || {})[d.id] && !state.rt.off[d.id]);
  if (!speakers.length) { for (const k of Object.keys(tbl)) delete tbl[k]; return; }
  const byIp = new Map();
  for (const d of speakers) for (const i of d.ifaces) if (i.rt && i.rt.ip != null) byIp.set(i.rt.ip, d);
  const connIf = (d, ip) => d.ifaces.find((i) => i.rt && i.rt.ip != null && i.rt.link && sameNet(ip, i.rt.ip, i.rt.bits) && ip !== i.rt.ip);

  // 1. 鄰居關係
  const sessions = []; // { a, b, na, nb, key }
  const seen = new Set(), touched = new Set();
  for (const d of speakers) {
    const c = bgpCfg(d);
    d.rt.bgp = { rid: bgpRid(d), asn: c.asn, peers: [], table: [] };
    for (const n of c.neighbors) {
      const ip = parseIp(n.ip);
      const peer = { ip: n.ip, remoteAs: n.remoteAs, desc: n.desc || '', state: 'Idle', why: '', up: 0, pfx: 0, sent: 0 };
      d.rt.bgp.peers.push(peer);
      if (ip == null) { peer.why = '鄰居的 IP 位址不正確'; continue; }
      if (n.shut) { peer.state = 'Idle (Admin)'; peer.why = 'neighbor shutdown'; continue; }
      const o = byIp.get(ip);
      const ci = connIf(d, ip);
      if (!ci) { peer.why = `沒有直連的介面通往 ${n.ip}（eBGP 預設只和直連的鄰居建立關係）`; continue; }
      const key = [d.id + '>' + n.ip, (o ? o.id : '?') + '>' + fmtIp(ci.rt.ip)].sort().join('|');
      const rec = tbl[key];
      if (!o || !bgpCfg(o)) { peer.state = 'Active'; peer.why = `${n.ip} 沒有回應 TCP 179（對面沒有跑 BGP）`; continue; }
      const back = bgpCfg(o).neighbors.find((x) => parseIp(x.ip) === ci.rt.ip && !x.shut);
      if (!back) { peer.state = 'Active'; peer.why = `${o.name} 沒有把 ${fmtIp(ci.rt.ip)} 設成鄰居，拒絕了連線`; continue; }
      if (+n.remoteAs !== +bgpCfg(o).asn) { peer.state = 'Idle'; peer.why = `對方的 AS 是 ${bgpCfg(o).asn}，不是設定的 ${n.remoteAs}（OPEN 訊息裡的 AS 不符：Bad Peer AS）`; if (rec) delete tbl[key]; continue; }
      if (+back.remoteAs !== +c.asn) { peer.state = 'Idle'; peer.why = `${o.name} 以為這一端是 AS ${back.remoteAs}，但這一端是 AS ${c.asn}`; if (rec) delete tbl[key]; continue; }
      // TCP 179 要真的通（ACL、防火牆都可能擋）
      // 任何一端都可以主動連線：只要有一個方向的 TCP 179 通，鄰居關係就建立得起來
      let t = transact(state, d.id, { proto: 'tcp', dst: ip, dport: 179, quiet: true });
      if (!t.ok) { const back2 = transact(state, o.id, { proto: 'tcp', dst: ci.rt.ip, dport: 179, quiet: true }); if (back2.ok) t = back2; }
      if (!t.ok) {
        // 已經建立的連線：線路沒斷只是路上不通，要等 hold time 到期才會斷
        if (rec && rec.up && now - rec.last < BGP_HOLD) {
          touched.add(key);
          peer.state = 'Established'; peer.up = now - (rec.upAt ?? rec.since); peer.hold = BGP_HOLD - (now - rec.last);
          state.rt.pending.push({ at: rec.last + BGP_HOLD, dev: d.id, kind: 'bgp', text: `${d.name}：BGP 鄰居 ${n.ip} 沒有消息，hold time 到了才會斷` });
          sessionOf(d, o, n, back, key, peer);
          continue;
        }
        peer.state = 'Active'; peer.why = `TCP 179 連不過去：${t.reason}`;
        if (rec) delete tbl[key];
        continue;
      }
      let r = rec;
      if (!r) r = tbl[key] = { since: dyn.boot ? -1e9 : now, up: false, last: now };
      r.last = now;
      touched.add(key);
      if (r.since + BGP_UP > now) {
        peer.state = 'OpenSent'; peer.why = `正在建立（TCP 已經連上，交換 OPEN 與 KEEPALIVE），再 ${Math.ceil(r.since + BGP_UP - now)} 秒`;
        state.rt.pending.push({ at: r.since + BGP_UP, dev: d.id, kind: 'bgp', text: `${d.name} ↔ ${o.name}：BGP 鄰居關係建立中` });
        continue;
      }
      if (!r.up) {
        r.up = true; r.upAt = now;
        if (!dyn.boot) for (const [x, ip2] of [[d, n.ip], [o, fmtIp(ci.rt.ip)]]) if (!isInet(x)) logEvent(state, x, 5, 'BGP-5-ADJCHANGE', `neighbor ${ip2} Up `);
      }
      peer.state = 'Established'; peer.up = now - (r.upAt ?? r.since);
      sessionOf(d, o, n, back, key, peer);
    }
  }
  function sessionOf(d, o, n, back, key, peer) {
    const k = d.id + '>' + o.id;
    if (seen.has(k)) return;
    seen.add(k);
    sessions.push({ a: d, b: o, na: n, nb: back, key, peer, aip: connIf(d, parseIp(n.ip)).rt.ip });
  }
  // 這一次沒有走到的鄰居關係：已經 Established 的記一筆 Down，然後刪掉（下次要從頭建立）
  for (const [k, r] of Object.entries(tbl)) {
    if (touched.has(k)) continue;
    if (r.up && !dyn.boot) {
      for (const side of k.split('|')) {
        const [id, peerIp] = side.split('>');
        const d = state.devices[id];
        if (d && !isInet(d)) logEvent(state, d, 5, 'BGP-5-ADJCHANGE', `neighbor ${peerIp} Down Interface flap`);
      }
    }
    delete tbl[k];
  }

  // 2. 每台自己發出的路由（network 敘述要在路由表裡有一模一樣的網段才會送出去）
  const local = {};
  for (const d of speakers) {
    const c = bgpCfg(d), out = (local[d.id] = []);
    for (const n of c.networks || []) {
      const has = isInet(d) || d.rt.routes.some((r) => r.net === n.net && r.bits === n.bits && !r.bad && r.type !== 'B');
      if (has) out.push({ net: n.net, bits: n.bits, aspath: [], origin: 'i', local: true, weight: 32768, nh: 0, from: null });
    }
    // redistribute：路由表裡那一種的路全部送出去（origin 是 ?，incomplete）；預設路由不會跟著出去
    for (const rd of (!isInet(d) && c.redist) || []) {
      for (const r of d.rt.routes) {
        if (r.bad || r.vrf || r.bits === 0 || out.some((x) => x.net === r.net && x.bits === r.bits)) continue;
        if (!(rd.src === 'static' ? r.type === 'S' : rd.src === 'connected' ? r.type === 'C' : rd.src === 'ospf' ? ospfInternal(r) || (r.type === 'C' && r.iface && ospfOn(d, r.iface)) : false)) continue; // 跑 OSPF 的直連網段也算 OSPF 的路（和 IOS 一樣）
        let med = rd.metric != null ? +rd.metric : rd.src === 'ospf' ? r.metric : 0; // 從 OSPF 來的路，MED 是原本的 cost
        if (rd.rm) { const st = rmRoute(d, rd.rm, r); if (!st) continue; if (st.med != null) med = +st.med; }
        out.push({ net: r.net, bits: r.bits, aspath: [], origin: '?', local: true, weight: 32768, nh: 0, from: null, med, redist: rd.src });
      }
    }
  }
  // 3. 路徑向量：一輪一輪地把最佳路徑送給鄰居，直到沒有變化
  const ribIn = {}; // 設備 → 鄰居 id → [路由]
  const best = {}; // 設備 → '網段' → 路由
  const pick = (d) => {
    const cands = {};
    for (const r of local[d.id]) (cands[r.net + '/' + r.bits] ||= []).push(r);
    for (const list of Object.values(ribIn[d.id] || {})) for (const r of list) (cands[r.net + '/' + r.bits] ||= []).push(r);
    const b = {};
    for (const [k, list] of Object.entries(cands)) b[k] = list.slice().sort(bgpCompare)[0];
    return b;
  };
  for (const d of speakers) best[d.id] = pick(d);
  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const s of sessions) {
      for (const [A, B, nA, nB] of [[s.a, s.b, s.na, s.nb], [s.b, s.a, s.nb, s.na]]) {
        const cA = bgpCfg(A), cB = bgpCfg(B);
        const sent = [];
        const aIp = connIfOf(A, parseIp(nA.ip));
        // 預設路由：neighbor x default-originate（ISP 送給客戶的通常就是這一條）
        if (nA.defOrig) sent.push({ net: 0, bits: 0, aspath: [], origin: 'i' });
        for (const r of Object.values(best[A.id])) {
          if (r.from === B.id) continue; // 不送回給學到它的那個鄰居
          let x = { net: r.net, bits: r.bits, aspath: r.aspath.slice(), origin: r.origin, med: r.local ? r.med : undefined };
          if (nA.plOut && !plHit(A, nA.plOut, x)) continue;
          if (nA.flOut && !flHit(A, nA.flOut, x)) continue;
          if (nA.rmOut) { x = applyRm(A, nA.rmOut, x); if (!x) continue; }
          sent.push(x);
        }
        // 送出去之前加上自己的 AS（再加上 route-map 指定的 prepend）
        const recv = [];
        for (const r of sent) {
          const path = [cA.asn, ...(r.prepend || []), ...r.aspath];
          if (path.includes(cB.asn)) continue; // 路徑裡已經有自己的 AS：迴圈，丟掉
          let x = { net: r.net, bits: r.bits, aspath: path, origin: r.origin, med: r.med, lp: 100, weight: 0, nh: aIp, from: A.id, peerRid: bgpRid(A), peerIp: aIp };
          if (nB.plIn && !plHit(B, nB.plIn, x)) continue;
          if (nB.flIn && !flHit(B, nB.flIn, x)) continue;
          if (isInet(B) && nB.role === 'customer') x.lp = 200; // ISP 偏好從客戶學來的路由
          if (nB.rmIn) { x = applyRm(B, nB.rmIn, x); if (!x) continue; }
          if (nB.weight != null) x.weight = +nB.weight;
          recv.push(x);
        }
        const prev = JSON.stringify(((ribIn[B.id] ||= {})[A.id]) || []);
        ribIn[B.id][A.id] = recv;
        if (prev !== JSON.stringify(recv)) changed = true;
        s.sent = s.sent || {}; s.sent[A.id] = sent.length;
      }
    }
    for (const d of speakers) best[d.id] = pick(d);
    if (!changed) break;
  }
  function connIfOf(d, ip) { const i = connIf(d, ip); return i ? i.rt.ip : null; }

  // 4. 裝進路由表（eBGP 的管理距離 20）、整理給 show ip bgp 用
  for (const d of speakers) {
    const all = [];
    for (const r of local[d.id]) all.push(r);
    for (const list of Object.values(ribIn[d.id] || {})) for (const r of list) all.push(r);
    const b = best[d.id];
    d.rt.bgp.table = all.map((r) => ({ ...r, best: b[r.net + '/' + r.bits] === r })).sort((x, y) => (x.net >>> 0) - (y.net >>> 0) || x.bits - y.bits || (y.best ? 1 : 0) - (x.best ? 1 : 0));
    for (const p of d.rt.bgp.peers) {
      const o = byIp.get(parseIp(p.ip));
      p.pfx = o && p.state === 'Established' ? ((ribIn[d.id] || {})[o.id] || []).length : 0;
      const s = sessions.find((x) => (x.a === d && x.b === o) || (x.b === d && x.a === o));
      p.sent = s && s.sent ? s.sent[d.id] || 0 : 0;
    }
    for (const r of Object.values(b)) {
      if (r.local) continue;
      const i = connIf(d, r.nh);
      if (!i) continue;
      d.rt.routes.push({ net: r.net, bits: r.bits, via: r.nh, iface: i, type: 'B', ad: AD_EBGP, metric: r.med || 0, aspath: r.aspath });
    }
  }
}
