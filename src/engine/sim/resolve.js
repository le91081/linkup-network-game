// 名稱解析：DNS 查詢、用戶端快取、CNAME
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { INET_TTL, cacheGet, cachePut, isDnsServer, serverAnswer } from '../dns.js';
import { fmtIp, parseIp } from '../ip.js';
import { noRouteReason } from './forward.js';
import { transact } from './transact.js';

function devDns(dev) {
  for (const i of dev.ifaces) if (i.rt.dns && i.rt.dns.length && i.rt.link) return i.rt.dns;
  return [];
}

/** 名稱解析：回傳 { ok, ip, reason, failDev, log, hops } */
export function resolveName(state, devId, name, depth = 0, opts = {}) {
  const dev = state.devices[devId];
  const log = [], hops = [];
  const lit = parseIp(name);
  if (lit != null) return { ok: true, ip: lit, log, hops };
  name = String(name).trim().toLowerCase();
  const fail = (reason, failDev = devId) => {
    log.push({ dev: failDev, kind: 'drop', text: reason });
    return { ok: false, reason, failDev, log, hops };
  };
  if (depth > 3) return fail('DNS 查詢迴圈');
  // 快取：TTL 還沒到就直接用，不會再問伺服器（伺服器上的記錄改了也看不到）
  // nslookup 不看快取，直接問伺服器（所以 nslookup 看到新的位址，瀏覽器卻還連到舊的）
  const hit = !opts.nocache && cacheGet(state, dev, name);
  if (hit) {
    log.push({ dev: devId, kind: 'dns', text: `${name} 在 DNS 快取裡：${fmtIp(hit.ip)}（還有 ${Math.ceil(hit.exp - state.clock)} 秒才到期，不會向伺服器查詢）` });
    return { ok: true, ip: hit.ip, cached: true, alias: hit.alias, log, hops };
  }
  const servers = devDns(dev);
  if (!servers.length) {
    const up = dev.ifaces.some((i) => i.rt.ip != null && i.rt.link && i.rt.src !== 'apipa');
    return fail(up ? `${dev.name} 沒有設定 DNS 伺服器，無法把 ${name} 轉成 IP 位址` : noRouteReason(state, dev, 0));
  }
  const server = servers[0];
  log.push({ dev: devId, kind: 'dns', text: `向 DNS 伺服器 ${fmtIp(server)} 查詢 ${name}` });
  const r = transact(state, devId, { proto: 'udp', dst: server, dport: 53 });
  log.push(...r.log); hops.push(...r.hops);
  if (!r.ok) return { ok: false, reason: `DNS 查詢失敗：${r.reason}`, failDev: r.failDev, log, hops };
  const sd = state.devices[r.responder];
  let ip = null, ttl = INET_TTL, alias = null, auth = false, canonical = name;
  if (sd.kind === 'internet') ip = parseIp(sd.inet.dns[name] || '');
  else if (sd.dnsProxy) {
    log.push({ dev: sd.id, kind: 'dns', text: `${sd.name} 代為向上游 DNS 查詢` });
    const up = resolveName(state, sd.id, name, depth + 1);
    log.push(...up.log); hops.push(...up.hops);
    if (!up.ok) return { ok: false, reason: up.reason, failDev: up.failDev, log, hops };
    ip = up.ip;
  } else if (isDnsServer(sd)) {
    const a = serverAnswer(sd, name);
    if (!a.nx) {
      ip = a.ip; ttl = a.ttl; auth = true;
      canonical = a.final;
      if (a.chain.length) { alias = a.chain[0]; log.push({ dev: sd.id, kind: 'dns', text: `${a.chain.join(' → ')} 是 ${a.final} 的別名 (CNAME)` }); }
    }
  }
  if (ip == null) return fail(`DNS 伺服器回覆：找不到 ${name} (NXDOMAIN)`, sd.id);
  log.push({ dev: devId, kind: 'dns', text: `${name} = ${fmtIp(ip)}（TTL ${ttl} 秒${opts.nocache ? '' : '，記進快取'}）` });
  if (!opts.nocache) cachePut(state, dev, name, { ip, ttl, alias, srv: sd.id });
  return { ok: true, ip, ttl, alias, canonical, auth, server: sd.id, serverIp: server, log, hops };
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
