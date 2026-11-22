// 路由政策：route-map 套在「路由」上（重分配進 OSPF / BGP、BGP 鄰居的進出）時要用到的比對
//
// d.routeMaps = { 名稱: [{ seq, action, match: { pl?, acl?, fl?, tag? }, set: { med?, metricType?, tag?, lp?, weight?, prepend?, nh?, defNh? } }] }
//   重分配：set metric（存在 med）、set metric-type type-1、set tag
//   政策路由 (PBR)：match ip address <ACL>、set ip next-hop / set ip default next-hop（在 sim/forward.js 處理）
// d.prefixLists = { 名稱: [{ seq, action, net, bits, ge?, le? }] }
// d.aclDefs[名稱] = [{ action, proto, src, dst, port }]（編號與具名的延伸 ACL、編號的標準 ACL）；d.stdAcls[名稱] = ['網段', …]（具名的標準 ACL，只有 permit）
import { netOf, parseIp, parseCidr } from './ip.js';

/** prefix-list：這個網段符不符合（沒有任何一條符合就是隱含的 deny） */
export function plHit(d, name, r) {
  const list = ((d.prefixLists || {})[name] || []).slice().sort((a, b) => a.seq - b.seq);
  for (const e of list) {
    if (netOf(r.net, e.bits) !== e.net) continue;
    const lo = e.ge || e.bits, hi = e.le || (e.ge ? 32 : e.bits);
    if (r.bits < lo || r.bits > hi) continue;
    return e.action === 'permit';
  }
  return false;
}

/** ACL 的規則清單（還沒套用的在 aclDefs；套用在介面上的跟著介面）。不存在就回傳 null */
export function aclRules(d, name) {
  const N = String(name), U = N.toUpperCase(), defs = d.aclDefs || {};
  if (defs[N]) return defs[N];
  if (defs[U]) return defs[U];
  for (const i of d.ifaces || []) for (const [dir, k] of [['in', 'aclIn'], ['out', 'aclOut']]) if (i.aclNames && (i.aclNames[dir] === N || i.aclNames[dir] === U) && i[k]) return i[k];
  return null;
}

const addrHit = (spec, ip) => {
  const s = String(spec || 'any').trim().toLowerCase();
  if (s === 'any') return true;
  const c = parseCidr(s.includes('/') ? s : s + '/32');
  return !!c && netOf(ip, c.bits) === c.net;
};

/** 重分配與 BGP 用的 ACL 比對：標準 ACL 比的是網段的位址；不存在的 ACL 當作全部符合（和 IOS 一樣） */
export function aclRouteHit(d, name, r) {
  const std = (d.stdAcls || {})[name] || (d.stdAcls || {})[String(name).toUpperCase()];
  if (std) return std.some((c) => addrHit(c, r.net));
  const rules = aclRules(d, name);
  if (!rules) return true;
  for (const x of rules) if (addrHit(x.src, r.net)) return x.action === 'permit';
  return false;
}

/**
 * route-map 套在一筆路由上：被擋掉回傳 null，放行就回傳這一條的 set（可能是空的 {}）。
 * 一條都沒有符合 → 隱含的 deny；參照了不存在的 route-map → 什麼都不放行
 */
export function rmRoute(d, name, r) {
  const rm = (d.routeMaps || {})[name];
  if (!rm) return null;
  for (const e of rm.slice().sort((a, b) => a.seq - b.seq)) {
    const m = e.match || {};
    if (m.pl && !plHit(d, m.pl, r)) continue;
    if (m.acl && !aclRouteHit(d, m.acl, r)) continue;
    if (m.tag != null && +m.tag !== +(r.tag || 0)) continue;
    if (m.fl) continue; // 重分配進來的路沒有 AS path，比不到
    return e.action === 'deny' ? null : (e.set || {});
  }
  return null;
}

/** OSPF 預設的種子 metric：connected / static 是 20，從 BGP 來的是 1 */
export const SEED = { static: 20, connected: 20, bgp: 1 };

/**
 * 重分配進 OSPF 的外部路由（這台是 ASBR）：[{ net, bits, metric, type: 1 | 2, tag, src }]
 * ospfOn(d, i)：這個介面有沒有跑 OSPF（跑 OSPF 的直連網段本來就在區域裡，不用再當成外部路由）
 */
export function ospfExternals(d, ospfOn, vrf = '') {
  const out = [];
  const c = vrf ? (d.ospfVrf || {})[vrf] : d;
  // redistribute bgp：預設只有 eBGP 學到的路，iBGP 的路不會被重分配進 IGP（要 bgp redistribute-internal）
  const bgpOk = (r) => r.type === 'B' && (!r.ibgp || !!(d.bgp && d.bgp.redistInternal));
  for (const rd of (c && c.ospfRedist) || []) {
    const pick = (r) => (rd.src === 'static' ? r.type === 'S' : rd.src === 'connected' ? r.type === 'C' && !(r.iface && ospfOn(d, r.iface)) : rd.src === 'bgp' ? bgpOk(r) : false);
    for (const r of (d.rt && d.rt.routes) || []) {
      // 預設路由不會跟著 redistribute 出去：要用 default-information originate
      if (r.bad || (r.vrf || '') !== vrf || r.bits === 0 || !pick(r) || out.some((x) => x.net === r.net && x.bits === r.bits)) continue;
      const e = { net: r.net, bits: r.bits, metric: rd.metric != null ? +rd.metric : SEED[rd.src], type: +rd.type === 1 ? 1 : 2, tag: +rd.tag || 0, src: rd.src };
      if (rd.rm) {
        const s = rmRoute(d, rd.rm, e);
        if (!s) continue;
        if (s.med != null) e.metric = +s.med;
        if (s.metricType) e.type = s.metricType;
        if (s.tag != null) e.tag = +s.tag;
      }
      out.push(e);
    }
  }
  return out;
}

/** 從 OSPF 重分配進 BGP 時要不要包含這一筆：預設只有區域內與區域間的路（外部的要 match external） */
export const ospfInternal = (r) => r.type === 'O' && (!r.sub || r.sub === 'IA');

export const parseNh = (list) => String(list || '').split(/\s+/).filter((x) => parseIp(x) != null);
