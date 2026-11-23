// BGP-4：鄰居關係（TCP 179）、eBGP 與 iBGP、路徑向量的傳遞、最佳路徑選擇、route-map / prefix-list / as-path / community 過濾、route reflector
//
// 設定（IOS 路由器）：
//   d.bgp = { asn, rid, redistInternal?, neighbors: [...], networks: [{ net, bits }], redist: [{ src: 'connected' | 'static' | 'ospf', metric?, rm? }] }
//     neighbor = { ip, remoteAs, desc, rmIn, rmOut, plIn, plOut, flIn, flOut, shut, defOrig, weight,
//                  updSrc（update-source 的介面 id）, nhSelf（next-hop-self）, rrClient（route-reflector-client）,
//                  multihop（ebgp-multihop 的 TTL）, dcc（disable-connected-check）, sendComm（send-community） }
//   d.routeMaps   = { 名稱: [{ seq, action, match: { pl?, fl?, acl?, cl? }, set: { lp?, prepend?: [as…], med?, weight?, comm?: [...], commAdd? } }] }
//   d.prefixLists = { 名稱: [{ seq, action, net, bits, ge?, le? }] }
//   d.asPathAcl   = { 編號: [{ action, re }] }
//   d.commLists   = { 名稱或編號: [{ action, values: ['65000:100', 'no-export', …] }] }（standard：每一個值都要有才算符合）
// 網際網路那一端（internet 設備，玩家不能改）：d.inet.bgp = { asn, neighbors: [{ ip, remoteAs, role: 'customer' | 'peer', defOrig }], networks: [{ net, bits }] }
//   ISP 對客戶學來的路由給比較高的 local-preference（200）；「其他網路」則單純比 AS path 的長短。
//
// eBGP 與 iBGP 的差別（和真的 BGP 一樣）：
//   - eBGP 預設 TTL 1，只和直連的鄰居建立關係；用 Loopback 建立要 ebgp-multihop（或 disable-connected-check）。iBGP 可以隔好幾台路由器
//   - 送給 eBGP 鄰居：AS path 前面加上自己的 AS、下一站改成自己；送給 iBGP 鄰居：AS path 不變、下一站不變（要 next-hop-self 才改成自己）
//   - iBGP 學到的路不會再送給其他 iBGP 鄰居（split horizon）：要全網狀 (full mesh)，或用 route reflector
//   - 下一站在路由表裡查不到（inaccessible）的路不能當最佳路徑；裝進路由表時要再查一次往下一站的路（遞迴）
//   - 管理距離：eBGP 20、iBGP 200
//
// 執行期：state.dyn.bgp[兩端] = { since, up, last }；d.rt.bgp = { rid, asn, peers: [...], table: [...] }
import { parseIp, fmtIp, netOf, sameNet } from './ip.js';
import { plHit, aclRouteHit, rmRoute, ospfInternal } from './policy.js';
import { bfdDetect } from './ospf.js';

export const BGP_UP = 10; // 設定好之後：TCP 三向交握、OPEN、KEEPALIVE，大約十秒進到 Established
export const BGP_HOLD = 180; // 對方沒有消息（線路沒斷，只是路上不通）：hold time 到了才斷
const AD_EBGP = 20, AD_IBGP = 200;

/** 這台設備的 BGP 設定（路由器或網際網路那一端） */
export function bgpCfg(d) {
  if (d.bgp && d.bgp.asn) return d.bgp;
  if (d.inet && d.inet.bgp) return d.inet.bgp;
  return null;
}
const isInet = (d) => d.kind === 'internet';
const gIf = (i) => i.rt && i.rt.ip != null && !i.vrf; // BGP 只跑在全域的路由表

/** BGP 的 Router ID：bgp router-id，不然和 OSPF 一樣挑 Loopback、再來是最大的介面 IP */
export function bgpRid(d) {
  const c = bgpCfg(d);
  const set = parseIp((c && c.rid) || '');
  if (set != null) return set;
  const loops = d.ifaces.filter((i) => i.bind.t === 'loop' && gIf(i)).map((i) => i.rt.ip >>> 0);
  if (loops.length) return Math.max(...loops);
  const all = d.ifaces.filter(gIf).map((i) => i.rt.ip >>> 0);
  return all.length ? Math.max(...all) : 0;
}
export const isIbgp = (d, n) => { const c = bgpCfg(d); return !!c && +n.remoteAs === +c.asn; };

/** 這台設備有沒有把 src 設成鄰居（決定要不要接受 TCP 179 的連線） */
export function bgpAccepts(d, src) {
  const c = bgpCfg(d);
  return !!c && c.neighbors.some((n) => parseIp(n.ip) === src && !n.shut);
}

// ───────────────────────── community ─────────────────────────

export const WELL_KNOWN = { internet: 0, 'no-export': 0xffffff01, 'no-advertise': 0xffffff02, 'local-as': 0xffffff03 };
/** community 的文字（65000:100、no-export…）→ 32 位元的數字；格式不對回傳 null */
export function parseComm(s) {
  const t = String(s).toLowerCase();
  if (t in WELL_KNOWN) return WELL_KNOWN[t];
  const m = t.match(/^(\d+):(\d+)$/);
  if (m && +m[1] <= 65535 && +m[2] <= 65535) return ((+m[1] << 16) | +m[2]) >>> 0;
  if (/^\d+$/.test(t) && +t <= 0xffffffff) return +t >>> 0;
  return null;
}
/** 顯示用：ip bgp-community new-format 之後是 AA:NN，不然 IOS 會印成一個十進位的大數字 */
export function fmtComm(v, newFormat) {
  for (const [k, x] of Object.entries(WELL_KNOWN)) if (x === v && k !== 'internet') return k;
  return newFormat ? `${v >>> 16}:${v & 0xffff}` : String(v >>> 0);
}
/** ip community-list：standard 的每一條要「全部的值都在」才算符合 */
function clHit(d, name, r) {
  const list = (d.commLists || {})[name];
  if (!list) return false;
  const have = new Set(r.comm || []);
  for (const e of list) {
    const want = e.values.map(parseComm);
    if (want.every((v) => v === 0 || have.has(v))) return e.action === 'permit';
  }
  return false;
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
    if (m.cl && !clHit(d, m.cl, r)) continue;
    if (e.action === 'deny') return null;
    const x = { ...r, aspath: r.aspath.slice(), comm: (r.comm || []).slice() };
    const s = e.set || {};
    if (s.lp != null) x.lp = s.lp;
    if (s.med != null) x.med = s.med;
    if (s.weight != null) x.weight = s.weight;
    if (s.prepend && s.prepend.length) x.prepend = s.prepend.slice();
    // set community：預設是取代原本的；加了 additive 才是附加上去
    if (s.comm) x.comm = [...new Set([...(s.commAdd ? x.comm : []), ...s.comm.map(parseComm).filter((v) => v != null && v !== 0)])];
    return x;
  }
  return null;
}

// ───────────────────────── 最佳路徑 ─────────────────────────

const ORIGIN = { i: 0, e: 1, '?': 2 };
const firstAs = (r) => (r.aspath.length ? r.aspath[0] : null);
/**
 * 比較兩條路：負數表示 a 比較好。
 * weight → local-preference → 自己發出的 → AS path 短 → origin → MED（同一個鄰居 AS 才比）→ eBGP 比 iBGP 好 → 往下一站的 IGP metric → Router ID 小
 */
export function bgpCompare(a, b) {
  return (b.weight || 0) - (a.weight || 0) || (b.lp ?? 100) - (a.lp ?? 100) || (b.local ? 1 : 0) - (a.local ? 1 : 0)
    || a.aspath.length - b.aspath.length || ORIGIN[a.origin] - ORIGIN[b.origin]
    || (firstAs(a) === firstAs(b) ? (a.med || 0) - (b.med || 0) : 0)
    || (a.ibgp ? 1 : 0) - (b.ibgp ? 1 : 0) || (a.igp || 0) - (b.igp || 0)
    || ((a.peerRid >>> 0) - (b.peerRid >>> 0));
}
export const BEST_REASON = (a, b) => {
  if ((a.weight || 0) !== (b.weight || 0)) return 'weight 比較大';
  if ((a.lp ?? 100) !== (b.lp ?? 100)) return `local-preference 比較高（${a.lp ?? 100} 對 ${b.lp ?? 100}）`;
  if (!!a.local !== !!b.local) return '是自己發出的';
  if (a.aspath.length !== b.aspath.length) return `AS path 比較短（${a.aspath.length} 對 ${b.aspath.length}）`;
  if (ORIGIN[a.origin] !== ORIGIN[b.origin]) return 'origin 比較好（i > e > ?）';
  if (firstAs(a) === firstAs(b) && (a.med || 0) !== (b.med || 0)) return 'MED 比較小';
  if (!!a.ibgp !== !!b.ibgp) return 'eBGP 學到的比 iBGP 優先';
  if ((a.igp || 0) !== (b.igp || 0)) return `往下一站的 IGP metric 比較小（${a.igp || 0} 對 ${b.igp || 0}）`;
  return 'Router ID 比較小';
};

// ───────────────────────── 主要的計算 ─────────────────────────

/**
 * 每次重新計算路由時呼叫（在 OSPF 之後）。transact 用來確認 TCP 179 通不通；lookupRoute 查往鄰居與往下一站的路
 */
export function computeBgp(state, { transact, logEvent, ospfOn = () => false, lookupRoute }) {
  const dyn = state.dyn, now = state.clock;
  const tbl = (dyn.bgp ||= {});
  const speakers = Object.values(state.devices).filter((d) => bgpCfg(d) && !(state.down || {})[d.id] && !state.rt.off[d.id]);
  if (!speakers.length) { for (const k of Object.keys(tbl)) delete tbl[k]; return; }
  const byIp = new Map();
  for (const d of speakers) for (const i of d.ifaces) if (gIf(i)) byIp.set(i.rt.ip, d);
  const connIf = (d, ip) => d.ifaces.find((i) => gIf(i) && i.rt.link && sameNet(ip, i.rt.ip, i.rt.bits) && ip !== i.rt.ip);
  const ownIps = (d) => new Set(d.ifaces.filter(gIf).map((i) => i.rt.ip));
  /** 往某個位址的路（BGP 自己的路不算，避免遞迴到自己身上）：{ via, iface, metric } */
  const igpTo = (d, ip) => {
    const ci = connIf(d, ip);
    if (ci) return { via: ip, iface: ci, metric: 0 };
    if (!lookupRoute || isInet(d)) return null;
    const r = lookupRoute(d, ip, undefined, '');
    return r && r.iface && r.type !== 'B' ? { via: r.via ?? ip, iface: r.iface, metric: r.metric || 0 } : null;
  };
  /** 送 TCP 179 用的來源位址：update-source 的介面，不然是往鄰居那個方向的出口介面 */
  const srcOf = (d, n) => {
    if (n.updSrc) {
      const i = d.ifaces.find((x) => x.id === n.updSrc);
      if (!i) return { why: `update-source 的介面 ${n.updSrc} 不存在` };
      if (!gIf(i) || !i.rt.link) return { why: `update-source ${i.label} 沒有 IP 或沒有連線` };
      return { ip: i.rt.ip, iface: i };
    }
    if (isInet(d)) { const ci = connIf(d, parseIp(n.ip)); return ci ? { ip: ci.rt.ip, iface: ci } : { why: '沒有直連的介面' }; }
    const p = igpTo(d, parseIp(n.ip));
    return p ? { ip: p.iface.rt.ip, iface: p.iface } : { why: `路由表裡沒有通往 ${n.ip} 的路` };
  };
  const ebgpTtl = (n) => (n.multihop ? +n.multihop : 1);

  // 1. 鄰居關係
  const sessions = []; // { a, b, na, nb, key, ibgp, aIp, bIp }
  const seen = new Set(), touched = new Set();
  for (const d of speakers) {
    const c = bgpCfg(d);
    d.rt.bgp = { rid: bgpRid(d), asn: c.asn, peers: [], table: [] };
    for (const n of c.neighbors) {
      const ip = parseIp(n.ip), ibgp = +n.remoteAs === +c.asn;
      const peer = { ip: n.ip, remoteAs: n.remoteAs, desc: n.desc || '', ibgp, state: 'Idle', why: '', up: 0, pfx: 0, sent: 0 };
      d.rt.bgp.peers.push(peer);
      if (ip == null) { peer.why = '鄰居的 IP 位址不正確'; continue; }
      if (n.shut) { peer.state = 'Idle (Admin)'; peer.why = 'neighbor shutdown'; continue; }
      // eBGP：TTL 1，對方要在直連的網段上（ebgp-multihop、disable-connected-check 例外）
      if (!ibgp && !n.multihop && !n.dcc && !connIf(d, ip)) {
        peer.why = `沒有直連的介面通往 ${n.ip}：eBGP 預設只和直連的鄰居建立關係（TTL 1）。用 Loopback 建立 eBGP 要 neighbor ${n.ip} ebgp-multihop 2，再加上 update-source 與往對方 Loopback 的路由`;
        continue;
      }
      const src = srcOf(d, n);
      const o = byIp.get(ip);
      if (src.why) { peer.state = 'Active'; peer.why = `${src.why}，TCP 179 連不出去`; continue; }
      if (!o || !bgpCfg(o)) { peer.state = 'Active'; peer.why = `${n.ip} 沒有回應 TCP 179（對面沒有跑 BGP）`; continue; }
      const co = bgpCfg(o), mine = ownIps(d);
      // 對面設定的、指向這台的那一筆鄰居：剛好是這一端的來源位址最好；不然任何一個這台的位址都算（再看反方向連不連得過來）
      const back = co.neighbors.find((x) => parseIp(x.ip) === src.ip && !x.shut) || co.neighbors.find((x) => mine.has(parseIp(x.ip)) && !x.shut);
      if (!back) { peer.state = 'Active'; peer.why = `${o.name} 沒有把這台（${fmtIp(src.ip)}）設成鄰居，拒絕了連線`; continue; }
      const key = [d.id + '>' + n.ip, o.id + '>' + back.ip].sort().join('|');
      const rec = tbl[key];
      if (+n.remoteAs !== +co.asn) { peer.state = 'Idle'; peer.why = `對方的 AS 是 ${co.asn}，不是設定的 ${n.remoteAs}（OPEN 訊息裡的 AS 不符：Bad Peer AS）`; if (rec) delete tbl[key]; continue; }
      if (+back.remoteAs !== +c.asn) { peer.state = 'Idle'; peer.why = `${o.name} 以為這一端是 AS ${back.remoteAs}，但這一端是 AS ${c.asn}`; if (rec) delete tbl[key]; continue; }
      // 兩個方向任何一個連得起來就行：這一端主動連（從 src 到 n.ip，對面要認得 src），或對面主動連過來（對面的來源要剛好是 n.ip）
      const srcO = srcOf(o, back);
      const tcp = (from, fromIp, to, nb) => transact(state, from.id, { proto: 'tcp', dst: to, dport: 179, srcIp: fromIp, quiet: true, ...(isIbgp(from, nb) ? {} : { ttl: ebgpTtl(nb) }) });
      let t = null, why = '';
      if (parseIp(back.ip) === src.ip) { t = tcp(d, src.ip, ip, n); if (!t.ok) why = t.reason; }
      if (!(t && t.ok) && !srcO.why && srcO.ip === ip && !back.shut) {
        const t2 = tcp(o, srcO.ip, parseIp(back.ip), back);
        if (t2.ok) t = t2; else why ||= t2.reason;
      }
      if (!t) {
        // 兩個方向都對不上：典型的情況是一端用 Loopback、另一端用實體介面的位址
        peer.state = 'Active';
        peer.why = `來源位址對不上：這一端從 ${fmtIp(src.ip)} 連到 ${n.ip}，但 ${o.name} 設定的鄰居是 ${back.ip}${!srcO.why ? `；${o.name} 從 ${fmtIp(srcO.ip)} 連過來，這一端設定的鄰居卻是 ${n.ip}` : ''}。用 Loopback 建立鄰居時，兩端都要 neighbor … update-source Loopback0`;
        if (rec) delete tbl[key];
        continue;
      }
      if (!t.ok) {
        // 已經建立的連線：線路沒斷只是路上不通，要等 hold time 到期才會斷
        // fall-over bfd：兩端都設、出去的介面也都有 bfd interval，對方一失聯 BFD 一秒內就通知 BGP，不用等 hold time
        const bfdMs = n.bfd && back.bfd && src.iface && srcO.iface ? bfdDetect(src.iface, srcO.iface) : null;
        const holdT = bfdMs != null ? Math.max(1, Math.ceil(bfdMs / 1000)) : BGP_HOLD;
        if (rec && rec.up && now - rec.last < holdT) {
          touched.add(key);
          peer.state = 'Established'; peer.up = now - (rec.upAt ?? rec.since); peer.hold = holdT - (now - rec.last);
          state.rt.pending.push({ at: rec.last + holdT, dev: d.id, kind: 'bgp', text: `${d.name}：BGP 鄰居 ${n.ip} 沒有消息，${bfdMs != null ? 'BFD 偵測中' : 'hold time 到了才會斷'}` });
          sessionOf(d, o, n, back, key, ibgp);
          continue;
        }
        peer.state = 'Active'; peer.why = /TTL/.test(why) ? `TCP 179 連不過去：${why}（eBGP 的 TTL 是 ${ebgpTtl(n)}，中間每經過一台路由器減 1：ebgp-multihop 要設大一點）` : `TCP 179 連不過去：${why}`;
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
        if (!dyn.boot) for (const [x, ip2] of [[d, n.ip], [o, back.ip]]) if (!isInet(x)) logEvent(state, x, 5, 'BGP-5-ADJCHANGE', `neighbor ${ip2} Up `);
      }
      peer.state = 'Established'; peer.up = now - (r.upAt ?? r.since);
      sessionOf(d, o, n, back, key, ibgp);
    }
  }
  function sessionOf(d, o, n, back, key, ibgp) {
    const k = d.id + '>' + o.id + '>' + key;
    if (seen.has(k) || seen.has(o.id + '>' + d.id + '>' + key)) return;
    seen.add(k);
    // aIp：d 在這個鄰居關係裡的位址（也就是對面設定的鄰居位址），送路由給對面時當作下一站
    sessions.push({ a: d, b: o, na: n, nb: back, key, ibgp, aIp: parseIp(back.ip), bIp: parseIp(n.ip) });
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
      // network：路由表裡要有一模一樣的網段；MED 是那條路在路由表裡的 metric（直連、靜態是 0，OSPF 的是 cost）
      const hit = isInet(d) ? { metric: 0 } : d.rt.routes.filter((r) => !r.vrf && r.net === n.net && r.bits === n.bits && !r.bad && r.type !== 'B').sort((a, b) => a.ad - b.ad)[0];
      if (hit) out.push({ net: n.net, bits: n.bits, aspath: [], origin: 'i', local: true, weight: 32768, nh: 0, from: null, valid: true, med: hit.metric || 0 });
    }
    // redistribute：路由表裡那一種的路全部送出去（origin 是 ?，incomplete）；預設路由不會跟著出去
    for (const rd of (!isInet(d) && c.redist) || []) {
      for (const r of d.rt.routes) {
        if (r.bad || r.vrf || r.bits === 0 || out.some((x) => x.net === r.net && x.bits === r.bits)) continue;
        if (!(rd.src === 'static' ? r.type === 'S' : rd.src === 'connected' ? r.type === 'C' : rd.src === 'ospf' ? ospfInternal(r) || (r.type === 'C' && r.iface && ospfOn(d, r.iface)) : false)) continue; // 跑 OSPF 的直連網段也算 OSPF 的路（和 IOS 一樣）
        let med = rd.metric != null ? +rd.metric : rd.src === 'ospf' ? r.metric : 0; // 從 OSPF 來的路，MED 是原本的 cost
        if (rd.rm) { const st = rmRoute(d, rd.rm, r); if (!st) continue; if (st.med != null) med = +st.med; }
        out.push({ net: r.net, bits: r.bits, aspath: [], origin: '?', local: true, weight: 32768, nh: 0, from: null, med, redist: rd.src, valid: true });
      }
    }
  }
  // 3. 路徑向量：一輪一輪地把最佳路徑送給鄰居，直到沒有變化
  const ribIn = {}; // 設備 → 鄰居 id → [路由]
  const best = {}; // 設備 → '網段' → 路由
  const pick = (d) => {
    const cands = {};
    for (const r of local[d.id]) (cands[r.net + '/' + r.bits] ||= []).push(r);
    for (const list of Object.values(ribIn[d.id] || {})) for (const r of list) if (r.valid) (cands[r.net + '/' + r.bits] ||= []).push(r);
    const b = {};
    for (const [k, list] of Object.entries(cands)) b[k] = list.slice().sort(bgpCompare)[0];
    return b;
  };
  for (const d of speakers) best[d.id] = pick(d);
  const NO_EXPORT = WELL_KNOWN['no-export'], NO_ADV = WELL_KNOWN['no-advertise'];
  for (let round = 0; round < 16; round++) {
    let changed = false;
    for (const s of sessions) {
      for (const [A, B, nA, nB, aIp] of [[s.a, s.b, s.na, s.nb, s.aIp], [s.b, s.a, s.nb, s.na, s.bIp]]) {
        const cA = bgpCfg(A), cB = bgpCfg(B), ib = s.ibgp;
        const sent = [];
        // 預設路由：neighbor x default-originate（ISP 送給客戶的通常就是這一條）
        if (nA.defOrig) sent.push({ net: 0, bits: 0, aspath: [], origin: 'i', nh: aIp, comm: [] });
        for (const r of Object.values(best[A.id])) {
          if (r.from === B.id) continue; // 不送回給學到它的那個鄰居
          const comm = r.comm || [];
          if (comm.includes(NO_ADV)) continue; // no-advertise：不送給任何鄰居
          if (!ib && comm.includes(NO_EXPORT)) continue; // no-export：不送出這個 AS
          // iBGP 的 split horizon：從 iBGP 學到的路不送給其他 iBGP 鄰居，除非自己是 route reflector（從 client 學到的、或要送給 client）
          let reflect = false;
          if (ib && r.ibgp) { if (!(r.fromClient || nA.rrClient)) continue; reflect = true; }
          // 下一站：eBGP 一律換成自己；iBGP 不變（自己發出的路用自己的位址），除非 next-hop-self（被反射的路不受影響）
          const nh = !ib || r.local || (nA.nhSelf && !r.ibgp) ? aIp : r.nh;
          let x = { net: r.net, bits: r.bits, aspath: r.aspath.slice(), origin: r.origin, nh, comm: nA.sendComm ? comm.slice() : [],
            med: ib ? r.med : r.local ? r.med : undefined, lp: ib ? r.lp ?? 100 : undefined,
            ...(reflect ? { originator: r.originator ?? r.peerRid, cluster: [bgpRid(A), ...(r.cluster || [])] } : r.originator != null && ib ? { originator: r.originator, cluster: r.cluster } : {}) };
          if (nA.plOut && !plHit(A, nA.plOut, x)) continue;
          if (nA.flOut && !flHit(A, nA.flOut, x)) continue;
          if (nA.rmOut) { x = applyRm(A, nA.rmOut, x); if (!x) continue; if (!nA.sendComm) x.comm = []; }
          sent.push(x);
        }
        // 送出去之前：eBGP 加上自己的 AS（再加上 route-map 指定的 prepend）；iBGP 不加
        const recv = [];
        const ridB = bgpRid(B);
        (s.loops ||= {})[A.id] = 0; // 這一輪被當成迴圈丟掉的筆數（show ip bgp summary 會提到）
        for (const r of sent) {
          let path = ib ? [...(r.prepend || []), ...r.aspath] : [cA.asn, ...(r.prepend || []), ...r.aspath];
          // as-override（MPLS 業者的 PE）：送給客戶之前，把路徑裡客戶自己的 AS 換成業者的 AS
          if (!ib && nA.asOverride) path = path.map((a) => (+a === +cB.asn ? cA.asn : a));
          // 路徑裡已經有自己的 AS：迴圈，丟掉（allowas-in n：最多允許出現 n 次）
          if (!ib && path.filter((a) => +a === +cB.asn).length > (+nB.allowAs || 0)) { (s.loops ||= {})[A.id] = (s.loops[A.id] || 0) + 1; continue; }
          if (ib && (r.originator === ridB || (r.cluster || []).includes(ridB))) continue; // 反射回來的：ORIGINATOR_ID 或 CLUSTER_LIST 裡有自己
          let x = { net: r.net, bits: r.bits, aspath: path, origin: r.origin, med: r.med, lp: ib ? r.lp ?? 100 : 100, weight: 0, nh: r.nh, from: A.id, peerRid: bgpRid(A), peerIp: aIp, comm: r.comm || [],
            ...(ib ? { ibgp: true, fromClient: !!nB.rrClient } : {}), ...(r.originator != null ? { originator: r.originator, cluster: r.cluster } : {}) };
          if (nB.plIn && !plHit(B, nB.plIn, x)) continue;
          if (nB.flIn && !flHit(B, nB.flIn, x)) continue;
          if (isInet(B) && nB.role === 'customer') x.lp = 200; // ISP 偏好從客戶學來的路由
          if (nB.rmIn) { x = applyRm(B, nB.rmIn, x); if (!x) continue; }
          if (nB.weight != null) x.weight = +nB.weight;
          // 下一站要查得到（不能是自己的位址）才是有效的路
          const p = ownIps(B).has(x.nh) ? null : igpTo(B, x.nh);
          x.valid = !!p; x.igp = p ? p.metric : 0;
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

  // 4. 裝進路由表（eBGP 的管理距離 20、iBGP 200；下一站不在直連網段上就再查一次路由表）、整理給 show ip bgp 用
  for (const d of speakers) {
    const all = [];
    for (const r of local[d.id]) all.push(r);
    for (const list of Object.values(ribIn[d.id] || {})) for (const r of list) all.push(r);
    const b = best[d.id];
    for (const r of Object.values(b)) {
      if (r.local) continue;
      const p = igpTo(d, r.nh);
      if (!p) continue;
      d.rt.routes.push({ net: r.net, bits: r.bits, via: p.via, iface: p.iface, type: 'B', ad: r.ibgp ? AD_IBGP : AD_EBGP, metric: r.med || 0, aspath: r.aspath, bnh: r.nh, ...(r.ibgp ? { ibgp: true } : {}) });
    }
    // 同一個網段已經有管理距離更小的路（例如 iBGP 200 對 OSPF 110）：show ip bgp 標成 r（RIB-failure）
    const ribFail = (r) => !r.local && d.rt.routes.some((x) => !x.vrf && !x.bad && x.type !== 'B' && x.net === r.net && x.bits === r.bits && x.ad < (r.ibgp ? AD_IBGP : AD_EBGP));
    d.rt.bgp.table = all.map((r) => ({ ...r, best: b[r.net + '/' + r.bits] === r, ...(b[r.net + '/' + r.bits] === r && ribFail(r) ? { ribFail: true } : {}) }))
      .sort((x, y) => (x.net >>> 0) - (y.net >>> 0) || x.bits - y.bits || (y.best ? 1 : 0) - (x.best ? 1 : 0));
    for (const p of d.rt.bgp.peers) {
      const s = sessions.find((x) => (x.a === d && x.bIp === parseIp(p.ip)) || (x.b === d && x.aIp === parseIp(p.ip)));
      const o = s ? (s.a === d ? s.b : s.a) : null;
      p.pfx = o && p.state === 'Established' ? ((ribIn[d.id] || {})[o.id] || []).length : 0;
      p.sent = s && s.sent ? s.sent[d.id] || 0 : 0;
      p.loops = o && s.loops ? s.loops[o.id] || 0 : 0;
      if (o) p.peerRid = bgpRid(o);
    }
  }
}
