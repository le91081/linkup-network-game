// 名稱解析：DNS 查詢、用戶端快取、CNAME
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { INET_TTL, cacheGet, cachePut, isDnsServer, serverAnswer } from '../dns.js';
import { fmtIp, parseIp } from '../ip.js';
import { fmtIp6, parseIp6, parseCidr6, net6 } from '../ip6.js';
import { transact6 } from '../sim6.js';
import { noRouteReason } from './forward.js';
import { transact } from './transact.js';

function devDns(dev) {
  for (const i of dev.ifaces) if (i.rt.dns && i.rt.dns.length && i.rt.link) return i.rt.dns;
  return [];
}
/** IPv6 的 DNS 伺服器（DHCPv6 給的）：只有 IPv6 的電腦就用它 */
function devDns6(dev) {
  for (const i of dev.ifaces) if (i.rt.v6 && i.rt.v6.dns && i.rt.v6.dns.length && i.rt.link) return i.rt.v6.dns;
  return [];
}

/** 名稱解析：回傳 { ok, ip, reason, failDev, log, hops } */
export function resolveName(state, devId, name, depth = 0, opts = {}) {
  const dev = state.devices[devId];
  const log = [], hops = [];
  const six = opts.type === 'AAAA'; // 查 AAAA（IPv6 位址）
  const lit = parseIp(name);
  if (lit != null && !six) return { ok: true, ip: lit, log, hops };
  const lit6 = six ? parseIp6(name) : null;
  if (lit6 != null) return { ok: true, ip6: lit6, log, hops };
  const show = (x) => (six ? fmtIp6(x.ip6) : fmtIp(x.ip));
  name = String(name).trim().toLowerCase();
  const fail = (reason, failDev = devId) => {
    log.push({ dev: failDev, kind: 'drop', text: reason });
    return { ok: false, reason, failDev, log, hops };
  };
  if (depth > 3) return fail('DNS 查詢迴圈');
  // 快取：TTL 還沒到就直接用，不會再問伺服器（伺服器上的記錄改了也看不到）
  // nslookup 不看快取，直接問伺服器（所以 nslookup 看到新的位址，瀏覽器卻還連到舊的）
  const hit = !opts.nocache && cacheGet(state, dev, name, six ? 'AAAA' : 'A');
  if (hit) {
    log.push({ dev: devId, kind: 'dns', text: `${name} 的 ${six ? 'AAAA' : 'A'} 在 DNS 快取裡：${show(hit)}（還有 ${Math.ceil(hit.exp - state.clock)} 秒才到期，不會向伺服器查詢）` });
    return { ok: true, ip: hit.ip, ...(six ? { ip6: hit.ip6 } : {}), cached: true, alias: hit.alias, log, hops };
  }
  const servers = devDns(dev), servers6 = servers.length ? [] : devDns6(dev);
  if (!servers.length && !servers6.length) {
    const up = dev.ifaces.some((i) => i.rt.ip != null && i.rt.link && i.rt.src !== 'apipa');
    return fail(up ? `${dev.name} 沒有設定 DNS 伺服器，無法把 ${name} 轉成 IP 位址` : noRouteReason(state, dev, 0));
  }
  const server = servers[0] ?? servers6[0], v6t = !servers.length;
  log.push({ dev: devId, kind: 'dns', text: `向 DNS 伺服器 ${v6t ? fmtIp6(server) : fmtIp(server)} 查詢 ${name}${six ? ' 的 AAAA（IPv6 位址）' : ''}${v6t ? '（用 IPv6 查詢）' : ''}` });
  const r = v6t ? transact6(state, devId, server, { proto: 'udp', dport: 53 }) : transact(state, devId, { proto: 'udp', dst: server, dport: 53 });
  log.push(...r.log); hops.push(...r.hops);
  if (!r.ok) return { ok: false, reason: `DNS 查詢失敗：${r.reason}`, failDev: r.failDev, log, hops };
  const sd = state.devices[r.responder];
  let ip = null, ip6 = null, ttl = INET_TTL, alias = null, auth = false, canonical = name, nodata = false, fwdNodata = false;
  if (sd.kind === 'internet') { if (six) ip6 = parseIp6((sd.inet.dns6 || {})[name] || ''); else ip = parseIp(sd.inet.dns[name] || ''); nodata = six && !!sd.inet.dns[name]; }
  else if (sd.dnsProxy) {
    log.push({ dev: sd.id, kind: 'dns', text: `${sd.name} 代為向上游 DNS 查詢` });
    const up = resolveName(state, sd.id, name, depth + 1, six ? { type: 'AAAA' } : {});
    log.push(...up.log); hops.push(...up.hops);
    if (!up.ok) return { ok: false, reason: up.reason, failDev: up.failDev, log, hops, nodata: up.nodata };
    ip = up.ip; ip6 = up.ip6 ?? null;
  } else if (isDnsServer(sd)) {
    const a = serverAnswer(sd, name, six ? 'AAAA' : 'A');
    if (!a.nx) {
      ip = a.ip ?? null; ip6 = a.ip6 ?? null; ttl = a.ttl; auth = true;
      canonical = a.final;
      if (a.chain.length) { alias = a.chain[0]; log.push({ dev: sd.id, kind: 'dns', text: `${a.chain.join(' → ')} 是 ${a.final} 的別名 (CNAME)` }); }
    } else {
      // 自己的區域裡沒有：開了轉送 (forwarder) 的話，用伺服器自己的 DNS 設定往上游查
      if (sd.dnsForward && serverAnswer(sd, name).nx) {
        log.push({ dev: sd.id, kind: 'dns', text: `${sd.name} 的區域裡沒有 ${name}，轉送給上游的 DNS 伺服器查詢` });
        const up = resolveName(state, sd.id, name, depth + 1, six ? { type: 'AAAA', nocache: true } : { nocache: true });
        log.push(...up.log); hops.push(...up.hops);
        if (up.ok) { ip = up.ip ?? null; ip6 = up.ip6 ?? null; } else if (!six) return fail(up.reason, up.failDev);
        else {
          // 上游說「名稱存在，但沒有 AAAA」：照實回給用戶端（DNS64 也許還能用 A 記錄合成）
          fwdNodata = !!up.nodata;
          const last = log[log.length - 1];
          if (last && last.kind === 'drop') last.kind = 'dns';
        }
      }
      if (six && ip6 == null) nodata = !!a.nodata || !serverAnswer(sd, name).nx || fwdNodata;
    }
    // DNS64：名稱只有 IPv4（A）的話，用 NAT64 的前綴 + IPv4 位址合成一個 AAAA
    if (six && ip6 == null && sd.dns64) {
      const c = parseCidr6(sd.dns64);
      const a4 = serverAnswer(sd, name, 'A');
      let v4 = a4.nx ? null : a4.ip;
      if (v4 == null && sd.dnsForward) {
        const upA = resolveName(state, sd.id, name, depth + 1, { nocache: true });
        log.push(...upA.log); hops.push(...upA.hops);
        if (upA.ok) v4 = upA.ip;
      }
      if (c && c.bits === 96 && v4 != null) {
        ip6 = net6(c.ip, c.bits) | BigInt(v4 >>> 0);
        nodata = false;
        log.push({ dev: sd.id, kind: 'dns', text: `DNS64：${name} 沒有 AAAA，用 A 記錄 ${fmtIp(v4)} 合成 ${fmtIp6(ip6)}（前綴 ${sd.dns64}）` });
      }
    }
  }
  if (six ? ip6 == null : ip == null) {
    if (six) { const r = fail(`DNS 伺服器回覆：${name} 沒有 IPv6 位址（${nodata ? '名稱存在，但沒有 AAAA 記錄' : '找不到這個名稱'}）`, sd.id); r.nodata = nodata; return r; }
    return fail(`DNS 伺服器回覆：找不到 ${name} (NXDOMAIN)`, sd.id);
  }
  log.push({ dev: devId, kind: 'dns', text: `${name} ${six ? 'AAAA ' : ''}= ${six ? fmtIp6(ip6) : fmtIp(ip)}（TTL ${ttl} 秒${opts.nocache ? '' : '，記進快取'}）` });
  if (!opts.nocache) cachePut(state, dev, name, six ? { ip6, ttl, alias, srv: sd.id } : { ip, ttl, alias, srv: sd.id });
  return { ok: true, ip, ...(six ? { ip6 } : {}), ttl, alias, canonical, auth, server: sd.id, serverIp: server, log, hops };
}

/** nslookup -type=mx / 反查 (PTR)：直接問設定的第一台 DNS 伺服器。回傳 { ok, records, server, serverIp, reason, log, hops } */
export function dnsQuery(state, devId, name, type) {
  const dev = state.devices[devId];
  const servers = devDns(dev);
  if (!servers.length) return { ok: false, reason: `${dev.name} 沒有設定 DNS 伺服器`, log: [], hops: [] };
  const r = transact(state, devId, { proto: 'udp', dst: servers[0], dport: 53 });
  if (!r.ok) return { ok: false, reason: `DNS 查詢失敗：${r.reason}`, log: r.log, hops: r.hops, serverIp: servers[0] };
  const sd = state.devices[r.responder];
  const a = isDnsServer(sd) ? serverAnswer(sd, name, type) : { nx: true };
  return a.nx ? { ok: false, reason: `${sd.name} 找不到 ${name} 的 ${type} 記錄 (Non-existent domain)`, log: r.log, hops: r.hops, server: sd.id, serverIp: servers[0] }
    : { ok: true, records: a.records, server: sd.id, serverIp: servers[0], log: r.log, hops: r.hops };
}

/**
 * 用名稱連線（雙協定）：電腦有全域 IPv6 位址、名稱又有 AAAA 時優先用 IPv6（RFC 6724 的預設政策）。
 * spec.happy：瀏覽器 / curl 的 Happy Eyeballs（RFC 8305）— IPv6 連不上就改用 IPv4，會通但慢一點；ping 不會改用 IPv4。
 * spec.family：4 或 6 強制只用一種（ping -4 / ping -6）。
 * 回傳 { ok, family, ip, ip6, fallback, why, reason, res, log, hops }
 */
export function dualStack(state, devId, name, spec = {}) {
  const dev = state.devices[devId];
  const log = [], hops = [];
  const has6 = !!state.v6 && dev.ifaces.some((i) => i.rt.v6 && i.rt.v6.addrs.some((a) => !a.rogue));
  const want6 = spec.family === 6 || (spec.family !== 4 && has6);
  const proto = spec.proto || 'icmp';
  const go4 = (r4, note) => {
    const res = transact(state, devId, { proto, dst: r4.ip, ...(proto !== 'icmp' ? { dport: spec.dport } : {}) });
    log.push(...res.log); hops.push(...res.hops);
    return { ok: res.ok, family: 4, ip: r4.ip, reason: res.reason, res, log, hops, ...note };
  };
  let r6 = null;
  if (want6) {
    r6 = resolveName(state, devId, name, 0, { type: 'AAAA', nocache: spec.nocache });
    log.push(...r6.log); hops.push(...r6.hops);
  }
  if (spec.family === 6) {
    if (!r6.ok) return { ok: false, family: 6, reason: r6.reason, log, hops };
  }
  if (r6 && r6.ok) {
    const t = transact6(state, devId, r6.ip6, proto === 'icmp' ? {} : { proto, dport: spec.dport });
    log.push(...t.log); hops.push(...t.hops);
    if (t.ok || !spec.happy) return { ok: t.ok, family: 6, ip6: r6.ip6, reason: t.reason, res: t, log, hops };
    // Happy Eyeballs：IPv6 等不到回應，兩百多毫秒後改試 IPv4
    log.push({ dev: devId, kind: 'info', text: `Happy Eyeballs：IPv6 ${fmtIp6(r6.ip6)} 沒有回應（${t.reason}），250 毫秒後改用 IPv4` });
    const r4 = resolveName(state, devId, name, 0, { nocache: spec.nocache });
    log.push(...r4.log); hops.push(...r4.hops);
    if (!r4.ok) return { ok: false, family: 6, ip6: r6.ip6, reason: t.reason, log, hops };
    return go4(r4, { ip6: r6.ip6, fallback: t.reason });
  }
  const r4 = resolveName(state, devId, name, 0, { nocache: spec.nocache });
  log.push(...r4.log); hops.push(...r4.hops);
  if (!r4.ok) return { ok: false, family: 4, reason: r4.reason, log, hops };
  return go4(r4, { why: !has6 ? '這台電腦沒有全域的 IPv6 位址' : r6 && !r6.ok ? `沒有 AAAA（${r6.reason}）` : '' });
}
