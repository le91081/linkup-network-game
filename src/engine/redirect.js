// ICMP Redirect（type 5）：路由器發現封包從同一個介面進來又要從同一個介面出去，而且下一站和來源在同一個網段，
// 就照樣轉送，同時告訴來源「往這個目的地，直接送給那台」。電腦收到之後在目的地快取 (destination cache)
// 記一筆主機路由，之後的封包不再繞經這台路由器（Windows 與 Linux 預設都接受；大約 10 分鐘後過期）。
//
// state.dyn.redirect[主機] = { 目的地IP: { gw, by（哪台路由器）, at } }
// 介面上的 no ip redirects（i.redirects === false）就不送
import { netOf } from './ip.js';

export const REDIRECT_TTL = 600;

const ifOn = (d, ip) => d.ifaces.find((i) => i.rt && i.rt.ip != null && i.rt.link !== false && netOf(ip, i.rt.bits) === netOf(i.rt.ip, i.rt.bits));

/**
 * 路由器要不要送 Redirect：同一個介面進出、介面沒有 no ip redirects、來源就在這個介面的網段（直接相連）、下一站也在。
 * origin 是送出這個封包的主機（只有主機會照 Redirect 改路）。回傳 { host, gw } 或 null
 */
export function redirectFor(state, dev, inIf, outIf, nh, pkt, origin) {
  if (!inIf || inIf !== outIf || inIf.redirects === false || (dev.kind !== 'router' && dev.kind !== 'l3switch')) return null;
  if (pkt.icmpErr || pkt.proto === 'arp' || nh == null) return null;
  const r = inIf.rt;
  if (!r || r.ip == null || r.bits == null) return null;
  const net = netOf(r.ip, r.bits);
  if (netOf(pkt.src, r.bits) !== net || netOf(nh, r.bits) !== net || nh === pkt.src) return null;
  const h = state.devices[origin];
  if (!h || h.kind !== 'host' || !h.ifaces.some((i) => i.rt && i.rt.ip === pkt.src)) return null;
  return { host: h.id, gw: nh };
}

/** 主機記下 Redirect */
export function learnRedirect(state, hostId, dst, gw, by) {
  const t = ((state.dyn.redirect ||= {})[hostId] ||= {});
  t[dst] = { gw, by, at: state.clock };
}

/** 主機往這個目的地有沒有還沒過期的 Redirect：{ iface, via, net, bits: 32, redirect } */
export function redirectRoute(state, host, dst) {
  const e = ((state.dyn && state.dyn.redirect) || {})[host.id] && state.dyn.redirect[host.id][dst];
  if (!e) return null;
  if (state.clock - e.at >= REDIRECT_TTL) { delete state.dyn.redirect[host.id][dst]; return null; }
  const i = ifOn(host, e.gw);
  if (!i) return null; // 換了網段、拔了線：這一筆用不上
  return { iface: i, via: e.gw, net: dst, bits: 32, ad: 0, metric: 0, redirect: e };
}

/** 目的地快取裡的 Redirect（給 netsh interface ip show destinationcache、ip route get） */
export function redirectRows(state, host) {
  const t = ((state.dyn && state.dyn.redirect) || {})[host.id] || {};
  return Object.entries(t).filter(([, e]) => state.clock - e.at < REDIRECT_TTL).map(([dst, e]) => ({ dst: +dst, gw: e.gw, by: e.by, left: Math.ceil(REDIRECT_TTL - (state.clock - e.at)) }));
}
export function clearRedirects(state, host) { if (state.dyn && state.dyn.redirect) delete state.dyn.redirect[host.id]; }
