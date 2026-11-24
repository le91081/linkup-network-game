// DNS：伺服器上的記錄（A / AAAA / CNAME / MX / PTR，各自有 TTL）與用戶端的快取
//
// 伺服器：d.dnsZone = { records: [{ name, type, value, ttl, pref? }] }（相容舊的 d.dnsRecords：名稱 → IP）
//   名稱一律寫完整的網域名稱，例如 www.corp.local；PTR 的名稱是 10.0.10.20.in-addr.arpa
// 用戶端：查到之後依 TTL 記在快取裡，TTL 到之前都直接用快取，不會再問伺服器。
//   所以伺服器上的記錄改了，用戶端要等 TTL 到期（或 resolvectl flush-caches）才會看到新的位址。
//   state.dyn.dnsCache[設備] = { 名稱: { ip, exp, alias?, srv } }
import { parseIp, fmtIp } from './ip.js';
import { parseIp6 } from './ip6.js';

export const DNS_TTL = 3600;
export const INET_TTL = 300;
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'PTR'];
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\.$/, '');

/** 伺服器上的所有記錄 */
export function zoneRecords(d) {
  const out = (d.dnsZone && d.dnsZone.records) || [];
  const legacy = Object.entries(d.dnsRecords || {}).map(([name, value]) => ({ name, type: 'A', value, ttl: DNS_TTL }));
  return [...out, ...legacy.filter((x) => !out.some((r) => norm(r.name) === norm(x.name)))];
}
export const isDnsServer = (d) => !!(d.dnsZone || d.dnsRecords);
export const ptrName = (ip) => fmtIp(ip).split('.').reverse().join('.') + '.in-addr.arpa';

/**
 * 在這台伺服器上找答案（CNAME 會在同一台伺服器上一路追下去）。
 * 回傳 { ip, ttl, chain: [別名…], final } 或 { nx: true }；type 是 MX / PTR 時回傳 { records }
 */
export function serverAnswer(d, name, type = 'A') {
  const recs = zoneRecords(d);
  let q = norm(name), ttl = Infinity;
  const chain = [];
  if (type === 'AAAA') {
    // AAAA 也會沿著 CNAME 追下去；回傳 { ip6, ttl, chain, final }
    for (let k = 0; k < 8; k++) {
      const a = recs.find((r) => norm(r.name) === q && r.type === 'AAAA');
      if (a) { const ip6 = parseIp6(a.value); return ip6 == null ? { nx: true } : { ip6, ttl: Math.min(ttl, +a.ttl || DNS_TTL), chain, final: q }; }
      const c = recs.find((r) => norm(r.name) === q && r.type === 'CNAME');
      if (!c) return { nx: true, nodata: recs.some((r) => norm(r.name) === q) };
      chain.push(q);
      ttl = Math.min(ttl, +c.ttl || DNS_TTL);
      q = norm(c.value);
    }
    return { nx: true, loop: true };
  }
  if (type !== 'A') {
    const rs = recs.filter((r) => norm(r.name) === q && r.type === type);
    return rs.length ? { records: rs } : { nx: true };
  }
  for (let k = 0; k < 8; k++) {
    const a = recs.find((r) => norm(r.name) === q && r.type === 'A');
    if (a) { const ip = parseIp(a.value); return ip == null ? { nx: true } : { ip, ttl: Math.min(ttl, +a.ttl || DNS_TTL), chain, final: q }; }
    const c = recs.find((r) => norm(r.name) === q && r.type === 'CNAME');
    if (!c) return { nx: true };
    chain.push(q);
    ttl = Math.min(ttl, +c.ttl || DNS_TTL);
    q = norm(c.value);
  }
  return { nx: true, loop: true };
}

/** 快取裡還有效的那一筆 */
export function cacheGet(state, dev, name, type = 'A') {
  const c = ((state.dyn && state.dyn.dnsCache) || {})[dev.id];
  const k = norm(name) + (type === 'AAAA' ? '|AAAA' : '');
  const e = c && c[k];
  if (!e) return null;
  if (e.exp <= state.clock) { delete c[k]; return null; }
  return type === 'AAAA' ? { ...e, ip6: BigInt(e.ip6) } : e;
}
export function cachePut(state, dev, name, e) {
  if (!state.dyn || !(e.ttl > 0)) return;
  const all = (state.dyn.dnsCache ||= {});
  (all[dev.id] ||= {})[norm(name) + (e.ip6 != null ? '|AAAA' : '')] = { ip: e.ip ?? null, ...(e.ip6 != null ? { ip6: e.ip6.toString() } : {}), exp: state.clock + e.ttl, alias: e.alias || null, srv: e.srv };
}
export function cacheFlush(state, dev) { if (state.dyn && state.dyn.dnsCache) delete state.dyn.dnsCache[dev.id]; }
/** resolvectl show-cache 用：[{ name, ip, left, alias }] */
export function cacheRows(state, dev) {
  const c = ((state.dyn && state.dyn.dnsCache) || {})[dev.id] || {};
  return Object.entries(c).filter(([, e]) => e.exp > state.clock).map(([name, e]) => ({ name: name.replace(/\|AAAA$/, ''), ip: e.ip, ...(e.ip6 != null ? { ip6: BigInt(e.ip6) } : {}), left: Math.ceil(e.exp - state.clock), alias: e.alias }));
}
export { norm as dnsNorm };
