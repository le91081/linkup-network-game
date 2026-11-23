// 多點傳送 (multicast)：第二層的 IGMP snooping，與跨網段的 PIM 多點傳送路由
//
// 來源：d.mcastSrc = [{ group, mbps, name }]（IPTV 編碼器、數位看板的播放伺服器）：固定速率的 UDP 串流，不會因為塞車而降速。
// 接收端：d.igmp = [群組…]（加入的群組：電腦送出 IGMP Membership Report）。
//
// 第二層：交換器沒有 IGMP snooping（非網管型、或 no ip igmp snooping）：多點傳送和廣播一樣，送往這個 VLAN 的每一個埠。
// 有 snooping、而且這個 VLAN 有 IGMP querier：只送往有人加入的埠（和要把串流送到別的網段的路由器）。
// querier 是開了 PIM 的路由器介面，或 ip igmp snooping querier 的交換器（在那個 VLAN 要有 IP）。
// 沒有 querier：電腦只在加入時送一次 Report，表項大約 260 秒後過期，之後的多點傳送又變成泛洪 (unregistered multicast)。
//
// 第三層 (PIM)：接收端在別的網段時，從它的閘道（last-hop router）照「往來源的單點傳送路由」一站一站往回找 (RPF)：
// 每一台都要 ip multicast-routing、經過的介面都要 ip pim，sparse-mode 還要設定同一個 RP（ip pim rp-address），
// 往來源的路由走的介面沒有 PIM 就是 RPF 失敗。找到直接接著來源網段的路由器 (first-hop router) 就算通了，串流沿著這條路送下來。
//
// 結果記在 state.rt.mcast（每一段線路、每個方向被多點傳送佔掉的 Mbps，也算進 rt.bcast 讓 TCP 拿不到）、
// rt.mstreams（每一道串流送到了哪些主機、沒收到的原因）、rt.mgroups（交換器的 snooping 表）、rt.mroutes（路由器的 mroute 表）、rt.mair（基地台的空中時間）
import { l2Explore } from './l2.js';
import { lookupRoute } from './l3.js';
import { findOwner } from './forward.js';
import { fmtIp } from '../ip.js';

export const isMcast = (ip) => ip != null && (ip >>> 28) === 14;
/** 交換器有沒有開 IGMP snooping（Catalyst 出廠就開著；非網管型的交換器沒有） */
export const snoopOn = (d) => !!(d && d.sw && d.sw.mode === 'vlan' && !(d.sw.igmp && d.sw.igmp.off));
const snoopVlan = (d, v) => !!(d && d.sw && d.sw.mode === 'vlan' && !(d.sw.igmp && d.sw.igmp.off) && !((d.sw.igmp && d.sw.igmp.vlanOff) || []).includes(+v));
/** 介面有沒有跑 PIM（同時也是那個網段的 IGMP querier） */
export const pimOn = (i) => !!(i && i.pim);

/** 路由器的介面接在哪個 VLAN：SVI、子介面看自己的 VLAN；實體埠看對面交換器那個埠的 VLAN */
function ifaceVlan(state, d, i) {
  if (i.bind.t === 'svi' || i.bind.t === 'sub') return +i.bind.vlan;
  if (i.bind.t !== 'port') return null;
  const l = state.rt.links[d.id + ':' + i.bind.port], x = l && state.devices[l.dev];
  const pc = x && x.sw && x.sw.mode === 'vlan' && x.sw.ports[l.port];
  return pc ? (pc.mode === 'trunk' ? +pc.native || 1 : +pc.vlan || 1) : null;
}

/** 這個 VLAN 的 IGMP querier（IP 最小的當選）：開了 PIM 的路由器介面，或 ip igmp snooping querier 的交換器 */
export function querierOf(state, vlan) {
  let best = null;
  for (const d of Object.values(state.devices)) {
    if ((state.down || {})[d.id]) continue;
    if (d.sw && d.sw.igmp && d.sw.igmp.querier && snoopVlan(d, vlan)) {
      const i = d.ifaces.find((x) => x.bind.t === 'svi' && x.bind.vlan === +vlan && x.rt && x.rt.ip != null);
      if (i && (!best || i.rt.ip < best.ip)) best = { dev: d.id, ip: i.rt.ip };
    }
    if (d.routing) for (const i of d.ifaces) if (pimOn(i) && i.rt && i.rt.ip != null && ifaceVlan(state, d, i) === +vlan && (!best || i.rt.ip < best.ip)) best = { dev: d.id, ip: i.rt.ip, pim: true };
  }
  return best;
}

/** sparse-mode 要 RP；sparse-dense-mode 有 RP 用 sparse、沒有用 dense */
const sparse = (d, i) => i.pim === 'sparse' || (i.pim === 'sparse-dense' && !!d.pimRp);

/**
 * 從接收端的閘道往來源一站一站找回去 (RPF)。回傳 { ok, why, fhr, fhrIf, hops: [{ up, upIf, down, downIf }] }
 * down / downIf：下游的路由器與它往來源的介面（RPF 介面）；up / upIf：上游的路由器與它朝下游的介面
 */
function rpfChain(state, srcIp, lhr, lhrIf) {
  const hops = [];
  let cur = lhr, out = lhrIf;
  const rps = new Set();
  for (let k = 0; k < 16; k++) {
    if (!cur.mcastRouting) return { ok: false, why: `${cur.name} 沒有 ip multicast-routing：不轉送多點傳送` };
    if (!pimOn(out)) return { ok: false, why: `${cur.name} 的 ${out.label} 沒有 ip pim：不會把串流送到這個網段` };
    const r = lookupRoute(cur, srcIp);
    if (!r) return { ok: false, why: `${cur.name} 沒有往來源 ${fmtIp(srcIp)} 的路由：RPF 檢查找不到該從哪個介面收` };
    const rpf = r.iface;
    if (!pimOn(rpf)) return { ok: false, why: `RPF 失敗：${cur.name} 往來源 ${fmtIp(srcIp)} 的路由走 ${rpf.label}，那個介面沒有 PIM，從別的介面收到的串流會被丟掉` };
    for (const i of [out, rpf]) if (sparse(cur, i)) { if (!cur.pimRp) return { ok: false, why: `${cur.name} 用 sparse-mode，但沒有設定 RP（ip pim rp-address）：不知道要向誰加入` }; rps.add(cur.pimRp); }
    if (rps.size > 1) return { ok: false, why: `路徑上的路由器設定的 RP 不一樣（${[...rps].join('、')}）：加入的訊息送到不同的 RP，樹接不起來` };
    if (r.via == null) return { ok: true, fhr: cur, fhrIf: rpf, hops };
    const nb = findOwner(state, r.via), nbIf = nb && nb.ifaces.find((i) => i.rt && i.rt.ip === r.via);
    if (!nb || !nb.routing || !nbIf) return { ok: false, why: `${cur.name} 往來源的下一站 ${fmtIp(r.via)} 不是路由器` };
    if (!pimOn(nbIf)) return { ok: false, why: `${nb.name} 的 ${nbIf.label} 沒有 PIM：${cur.name} 和它不是 PIM 鄰居，PIM Join 送不上去` };
    hops.push({ up: nb, upIf: nbIf, down: cur, downIf: rpf });
    cur = nb; out = nbIf;
  }
  return { ok: false, why: '往來源的路徑太長（可能有路由迴圈）' };
}

export function prepMcast(state) {
  const rt = state.rt;
  rt.mcast = {}; rt.mstreams = []; rt.mgroups = {}; rt.mair = {}; rt.mroutes = {};
  rt.bcast ||= {};
  const down = state.down || {};
  const alive = (d) => d && !down[d.id] && !(rt.off || {})[d.id];
  const addLoad = (k, mbps) => { rt.mcast[k] = (rt.mcast[k] || 0) + mbps; rt.bcast[k] = (rt.bcast[k] || 0) + mbps; };

  /** 在一個廣播網域裡送：從 from 的 iface 出發，members 是要收的設備（主機、要轉送出去的路由器）。回傳收到的設備 */
  const l2deliver = (from, iface, group, mbps, members, used) => {
    const e = l2Explore(state, from.id, iface, { trace: true });
    const keyOf = new Map((e.sws || []).map((w) => [w.dev, w.key]));
    const kids = new Map();
    for (const l of e.links || []) { if (!kids.has(l.from)) kids.set(l.from, []); kids.get(l.from).push(l); }
    const memo = new Map();
    const hasMember = (id, seen = new Set()) => {
      if (memo.has(id)) return memo.get(id);
      if (seen.has(id)) return false;
      seen.add(id);
      const v = members.has(id) || (kids.get(id) || []).some((l) => hasMember(l.to, seen));
      memo.set(id, v);
      return v;
    };
    const got = new Set([from.id]);
    for (const l of e.links || []) {
      if (!got.has(l.from)) continue;
      const f = state.devices[l.from], key = keyOf.get(l.from);
      const q = f.sw && key != null && snoopVlan(f, key) ? querierOf(state, key) : null;
      if (q && !hasMember(l.to)) continue; // snooping：沒有人加入的埠不送
      if (q) (((rt.mgroups[f.id] ||= {})[key + '|' + group] ||= [])).push(l.fromPort);
      got.add(l.to);
      const k = l.cable + '>' + l.to;
      if (!used.has(k)) { used.add(k); addLoad(k, mbps); }
      // 送到基地台：無線上要用最低的基本速率送給每一台（5 GHz 6 Mbps、2.4 GHz 1 Mbps），佔掉很多空中時間。
      // 基地台開了「多點傳送轉單點傳送」：只送給有加入的用戶端，用它們各自的速率
      const ap = state.devices[l.to];
      if (ap && ap.kind === 'ap' && ap.wifi) {
        const cl = (rt.clients[ap.id] || []).map((c) => c.iface.rt.assoc).filter(Boolean);
        const air = ap.wifi.m2u
          ? (rt.clients[ap.id] || []).filter((c) => members.has(c.dev)).reduce((a, c) => a + mbps / Math.max(6, ((c.iface.rt.assoc || {}).rate || 54) * 0.5), 0)
          : cl.length ? mbps / (cl.some((a) => a.band === '2.4GHz') ? 1 : 6) : 0;
        rt.mair[ap.id] = (rt.mair[ap.id] || 0) + air;
      }
    }
    // 基地台收到了：它的無線用戶端也收到（多點傳送轉單點傳送只送給有加入的）
    for (const id of [...got]) {
      const ap = state.devices[id];
      if (ap && ap.kind === 'ap') for (const c of rt.clients[id] || []) if (!ap.wifi.m2u || members.has(c.dev)) got.add(c.dev);
    }
    const vlan = keyOf.size ? keyOf.values().next().value : null;
    return { got, ends: new Set(e.map((x) => x.dev)), vlan, eps: e };
  };
  const mroute = (d, o) => {
    const l = (rt.mroutes[d.id] ||= []);
    let m = l.find((x) => x.group === o.group && x.src === o.src);
    if (!m) { m = { group: o.group, src: o.src, iif: o.iif, rpf: o.rpf ?? null, oil: [], mode: o.mode }; l.push(m); }
    for (const x of o.oil || []) if (!m.oil.includes(x)) m.oil.push(x);
  };

  for (const d of Object.values(state.devices)) {
    if (!(d.mcastSrc || []).length || !alive(d)) continue;
    const iface = d.ifaces.find((i) => i.bind.t === 'port' && rt.links[d.id + ':' + i.bind.port]);
    if (!iface || iface.rt.ip == null) continue;
    const srcIp = iface.rt.ip;
    const scout = l2Explore(state, d.id, iface, {});
    const localEnds = new Set(scout.map((x) => x.dev));
    for (const s of d.mcastSrc) {
      const mbps = +s.mbps || 0;
      if (!(mbps > 0)) continue;
      const used = new Set(), why = {};
      const recv = Object.values(state.devices).filter((h) => h.kind === 'host' && alive(h) && (h.igmp || []).includes(s.group)).map((h) => h.id);
      // 別的網段的接收端：從它的閘道往來源找回去
      const remote = recv.filter((id) => !localEnds.has(id) && !(rt.clients[id]));
      const branches = new Map(); // LHR 的介面 → { lhr, lhrIf, chain, hosts }
      for (const id of remote) {
        const h = state.devices[id], hi = h.ifaces.find((i) => i.rt && i.rt.ip != null && i.rt.gw != null);
        const gw = hi && findOwner(state, hi.rt.gw), gwIf = gw && gw.ifaces.find((i) => i.rt && i.rt.ip === hi.rt.gw);
        if (!gw || !gw.routing || !gwIf) { why[id] = `${h.name} 在別的網段，閘道不是路由器：多點傳送過不去`; continue; }
        const key = gw.id + '/' + gwIf.id;
        if (!branches.has(key)) branches.set(key, { lhr: gw, lhrIf: gwIf, chain: rpfChain(state, srcIp, gw, gwIf), hosts: [] });
        const b = branches.get(key);
        b.hosts.push(id);
        if (!b.chain.ok) why[id] = b.chain.why;
      }
      const ok = [...branches.values()].filter((b) => b.chain.ok);
      // 來源的網段：本地的接收端，加上要把串流往外送的 first-hop router
      const localMembers = new Set([...recv.filter((id) => localEnds.has(id) || rt.clients[id]), ...ok.map((b) => b.chain.fhr.id)]);
      const A = l2deliver(d, iface, s.group, mbps, localMembers, used);
      const got = new Set(A.got);
      for (const b of ok) {
        const c = b.chain;
        if (!A.got.has(c.fhr.id)) { for (const id of b.hosts) why[id] = `串流沒有送到 ${c.fhr.name}（來源網段裡被擋下了）`; continue; }
        // 路由器之間：上游的介面送到下游的 RPF 介面（同一段只算一次）
        let broke = '';
        for (const hp of [...c.hops].reverse()) {
          const e = l2Explore(state, hp.up.id, hp.upIf, { trace: false });
          const ep = e.find((x) => x.dev === hp.down.id && x.iface === hp.downIf);
          if (!ep) { broke = `${hp.up.name} 和 ${hp.down.name} 之間不通`; break; }
          for (const h of ep.path) { if (!h.cable) continue; const k = h.cable + '>' + h.to; if (!used.has(k)) { used.add(k); addLoad(k, mbps); } }
          mroute(hp.up, { group: s.group, src: srcIp, oil: [hp.upIf.label], mode: sparse(hp.up, hp.upIf) ? 'S' : 'D' });
        }
        if (broke) { for (const id of b.hosts) why[id] = broke; continue; }
        // 每一台的 (S,G)：從哪個介面收（RPF）、往哪些介面送
        mroute(c.fhr, { group: s.group, src: srcIp, iif: c.fhrIf.label, rpf: null, oil: [], mode: sparse(c.fhr, c.fhrIf) ? 'S' : 'D' });
        for (const hp of c.hops) mroute(hp.down, { group: s.group, src: srcIp, iif: hp.downIf.label, rpf: hp.upIf.rt.ip, oil: [], mode: sparse(hp.down, hp.downIf) ? 'S' : 'D' });
        mroute(b.lhr, { group: s.group, src: srcIp, oil: [b.lhrIf.label] });
        // 接收端的網段：從 last-hop router 送出去
        const B = l2deliver(b.lhr, b.lhrIf, s.group, mbps, new Set(b.hosts), used);
        for (const id of B.got) got.add(id);
        for (const id of b.hosts) if (!B.got.has(id)) why[id] = `${b.lhr.name} 送出來了，但在 ${state.devices[id].name} 那個網段被擋下`;
      }
      for (const id of recv) if (!got.has(id) && !why[id]) why[id] = '收不到這個串流';
      rt.mstreams.push({ src: d.id, srcIp, group: s.group, name: s.name || s.group, mbps, vlan: A.vlan, members: recv.filter((id) => got.has(id)), missed: recv.filter((id) => !got.has(id)), why,
        extra: [...got].filter((id) => !recv.includes(id) && state.devices[id] && state.devices[id].kind === 'host' && id !== d.id), flooded: !querierOf(state, A.vlan), links: used.size });
    }
  }
}
