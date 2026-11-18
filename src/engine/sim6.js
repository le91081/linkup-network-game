// IPv6 模擬：link-local、手動位址、SLAAC（靠 Router Advertisement）、靜態路由、鄰居探索
// 只在關卡開啟 state.v6 時才會執行。目前沒有模擬 IPv6 的 ACL、防火牆與動態路由。
import { parseIp6, fmtIp6, parseCidr6, net6, linkLocal, eui64 } from './ip6.js';
import { l2Explore } from './sim.js';

export const mode6 = (dev, i) => i.mode6 || (dev.kind === 'host' ? 'auto' : 'static');
const owns6 = (i, ip) => !!i.rt.v6 && (i.rt.v6.ll === ip || i.rt.v6.addrs.some((a) => a.ip === ip));
const isLocal6 = (dev, ip) => dev.ifaces.some((i) => owns6(i, ip));

export function recompute6(state) {
  const devs = Object.values(state.devices);
  for (const d of devs) {
    d.rt.routes6 = [];
    for (const i of d.ifaces) {
      const v = (i.rt.v6 = { ll: null, addrs: [], gw: null, note: '', router: null });
      const m = mode6(d, i);
      if (!i.rt.active || !i.rt.link || m === 'off') continue;
      v.ll = linkLocal(i.rt.mac);
      if (m !== 'static') continue;
      const c = parseCidr6(i.ip6 || '');
      if (c && c.bits < 128) v.addrs.push({ ip: c.ip, bits: c.bits, src: 'static' });
      else if ((i.ip6 || '').trim()) v.note = 'IPv6 位址要寫成「位址/前綴長度」，例如 2001:db8:a::1/64';
      v.gw = parseIp6(i.gw6 || '');
    }
  }
  for (const d of devs) {
    for (const i of d.ifaces) {
      const v = i.rt.v6;
      if (mode6(d, i) !== 'auto' || v.ll == null) continue;
      const ra = l2Explore(state, d.id, i).find((e) => {
        const r = e.iface, rd = state.devices[e.dev];
        return rd.routing && rd.v6routing && r.ra && r.rt.v6 && r.rt.v6.addrs.length;
      });
      if (!ra) { v.note = '沒有收到 Router Advertisement — 路由器要啟用 IPv6 路由，並在這個網段的介面上開啟 RA'; continue; }
      v.addrs.push({ ip: eui64(net6(ra.iface.rt.v6.addrs[0].ip, 64), i.rt.mac), bits: 64, src: 'slaac' });
      v.gw = ra.iface.rt.v6.ll;
      v.router = ra.dev;
    }
  }
  for (const d of devs) {
    const r = d.rt.routes6;
    for (const i of d.ifaces) {
      const v = i.rt.v6;
      for (const a of v.addrs) r.push({ net: net6(a.ip, a.bits), bits: a.bits, via: null, iface: i, type: 'C' });
      if (v.gw != null && v.ll != null) r.push({ net: 0n, bits: 0, via: v.gw, iface: i, type: 'S' });
    }
    for (const s of d.routes6 || []) {
      const c = parseCidr6(s.dst || ''), via = parseIp6(s.via || '');
      if (!c || via == null) continue;
      const i = d.ifaces.find((x) => x.rt.v6 && x.rt.v6.addrs.some((a) => net6(via, a.bits) === net6(a.ip, a.bits) && via !== a.ip));
      r.push({ net: net6(c.ip, c.bits), bits: c.bits, via, iface: i || null, type: 'S', bad: i ? null : `下一站 ${fmtIp6(via)} 不在任何直連的 IPv6 網段上` });
    }
  }
}

function lookup6(d, ip) {
  let best = null;
  for (const r of d.rt.routes6 || []) {
    if (r.bad || net6(ip, r.bits) !== r.net) continue;
    if (!best || r.bits > best.bits) best = r;
  }
  return best;
}

function forward6(state, ctx, startId, pkt) {
  let dev = state.devices[startId], inIf = null;
  const drop = (reason) => {
    ctx.log.push({ dev: dev.id, kind: 'drop', text: reason });
    return { ok: false, dev: dev.id, reason };
  };
  for (let n = 0; n < 32; n++) {
    if (isLocal6(dev, pkt.dst)) return { ok: true, dev: dev.id };
    if (inIf) {
      if (!dev.routing) return drop(`${dev.name} 收到不是給自己的 IPv6 封包，它不是路由器所以直接丟棄`);
      if (!dev.v6routing) return drop(`${dev.name} 沒有啟用 IPv6 路由 (ipv6 unicast-routing)，不會轉送 IPv6 封包`);
      if (--pkt.hl <= 0) return drop('Hop Limit 歸零，封包被丟棄（可能有路由迴圈）');
      if (!pkt.reply) ctx.l3.push({ dev: dev.id, ip6: inIf.rt.v6.addrs[0] ? inIf.rt.v6.addrs[0].ip : inIf.rt.v6.ll });
    }
    const r = lookup6(dev, pkt.dst);
    if (!r) {
      const any = dev.ifaces.some((i) => i.rt.v6 && i.rt.v6.addrs.length);
      const note = dev.ifaces.map((i) => i.rt.v6 && i.rt.v6.note).find(Boolean);
      if (dev.kind === 'host') return drop(any ? `${fmtIp6(pkt.dst)} 不在 ${dev.name} 的網段內，而且沒有 IPv6 預設閘道` : `${dev.name} 沒有可用的 IPv6 位址${note ? '（' + note + '）' : ''}`);
      const bad = (dev.rt.routes6 || []).find((x) => x.bad);
      return drop(`${dev.name} 的 IPv6 路由表裡沒有通往 ${fmtIp6(pkt.dst)} 的路由${bad ? '（' + bad.bad + '）' : ''}`);
    }
    const nh = r.via ?? pkt.dst;
    const eps = l2Explore(state, dev.id, r.iface);
    if (eps.storm) return drop(`廣播風暴！${state.devices[eps.storm].name} 所在的網段形成了迴圈`);
    const tgt = eps.find((e) => owns6(e.iface, nh));
    if (!tgt) return drop(`鄰居探索 (NDP) 沒有回應：這個網段上找不到 ${fmtIp6(nh)}`);
    ctx.log.push({ dev: dev.id, kind: 'l2', text: (r.via != null ? `查路由 → 下一站 ${fmtIp6(nh)}：` : '') + [dev.name, ...tgt.path.map((h) => state.devices[h.to].name)].join(' → ') });
    for (const h of tgt.path) ctx.hops.push({ ...h, reply: pkt.reply, proto: 'icmp6' });
    dev = state.devices[tgt.dev];
    inIf = tgt.iface;
  }
  return drop('封包繞了太多站仍未抵達（路由迴圈）');
}

/** IPv6 ping：dst 是 BigInt。回傳 { ok, reason, failDev, log, hops, l3 } */
export function transact6(state, fromId, dst) {
  const ctx = { log: [], hops: [], l3: [] };
  const src = state.devices[fromId];
  const done = (r) => ({ ...r, log: ctx.log, hops: ctx.hops, l3: ctx.l3 });
  if (isLocal6(src, dst)) {
    ctx.log.push({ dev: fromId, kind: 'ok', text: `${fmtIp6(dst)} 就是自己，本機迴路成功` });
    return done({ ok: true, responder: fromId });
  }
  const r = lookup6(src, dst);
  let from = null;
  if (r) {
    const v = r.iface.rt.v6;
    const same = v.addrs.find((a) => net6(dst, a.bits) === net6(a.ip, a.bits));
    from = (same || v.addrs[0] || { ip: v.ll }).ip;
  } else {
    const any = src.ifaces.find((i) => i.rt.v6 && i.rt.v6.addrs.length);
    from = any ? any.rt.v6.addrs[0].ip : 0n;
  }
  ctx.log.push({ dev: fromId, kind: 'tx', text: `送出 ICMPv6 Echo Request　${fmtIp6(from)} → ${fmtIp6(dst)}` });
  const a = forward6(state, ctx, fromId, { src: from, dst, hl: 64, reply: false });
  if (!a.ok) return done({ ok: false, reason: a.reason, failDev: a.dev, phase: 'request' });
  ctx.log.push({ dev: a.dev, kind: 'rx', text: `收到請求，回覆 ICMPv6 Echo Reply　${fmtIp6(dst)} → ${fmtIp6(from)}` });
  const b = forward6(state, ctx, a.dev, { src: dst, dst: from, hl: 64, reply: true });
  if (!b.ok) return done({ ok: false, reason: '回程失敗：' + b.reason, failDev: b.dev, phase: 'reply', responder: a.dev });
  ctx.log.push({ dev: fromId, kind: 'ok', text: '收到回應，連線成功' });
  return done({ ok: true, responder: a.dev });
}

/** 設備第一個全域 IPv6 位址（沒有就回傳 null） */
export function globalIp6(dev) {
  for (const i of dev.ifaces) if (i.rt.v6 && i.rt.v6.addrs.length) return i.rt.v6.addrs[0].ip;
  return null;
}

export function route6Rows(dev) {
  return (dev.rt.routes6 || []).map((r) => ({
    type: r.type, typeName: r.type === 'C' ? '直連' : '靜態',
    dst: r.bits === 0 ? '::/0（預設）' : `${fmtIp6(r.net)}/${r.bits}`,
    via: r.via == null ? '直連' : fmtIp6(r.via), iface: r.iface ? r.iface.label : '—', bad: r.bad || '',
  }));
}
