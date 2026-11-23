// 郵件 (SMTP)：員工用 587 把信交給公司的郵件伺服器，伺服器查收件人網域的 MX，再用 TCP 25 交給對方的伺服器
//
// 郵件伺服器：d.mail = { domain, users: ['amy'…], boxes: { 帳號: [{ from, to, t }] }, queue: [{ from, to, why, t }] }，服務 TCP 25 與 587
// 員工的電腦：d.mailClient = { addr: 'amy@corp.com.tw', server: 'mail.corp.com.tw' 或 IP, port: 587 }
// 網際網路上的郵件伺服器：inet.hosts 裡的 { ip, name, services: [TCP 25], mail: { domain, users } }；MX 記錄在 inet.mx[網域] = 主機名稱
// 外面的人寄進來：從網際網路上那台伺服器（inet.hosts 裡有 mail 的）連到我們 MX 的公用位址 TCP 25
import { parseIp, fmtIp } from './ip.js';
import { transact } from './sim/transact.js';
import { resolveName } from './sim/resolve.js';
import { serverAnswer, isDnsServer } from './dns.js';

const split = (addr) => { const m = String(addr || '').trim().toLowerCase().match(/^([^@\s]+)@([^@\s]+)$/); return m ? { user: m[1], domain: m[2] } : null; };
const hasMail = (d) => !!(d && d.mail && d.mail.domain);

/** 從某台設備查 MX：問它設定的 DNS 伺服器（網際網路的 DNS 看 inet.mx；公司的 DNS 看自己的 MX 記錄，沒有就轉送） */
function mxOf(state, devId, domain, depth = 0) {
  const d = state.devices[devId];
  const dns = (d.ifaces.find((i) => i.rt && i.rt.dns && i.rt.dns.length) || {}).rt;
  const srv = dns && dns.dns[0];
  if (srv == null) return { ok: false, why: `${d.name} 沒有設定 DNS 伺服器，查不到 ${domain} 的 MX` };
  const r = transact(state, devId, { proto: 'udp', dst: srv, dport: 53, quiet: true });
  if (!r.ok) return { ok: false, why: `${d.name} 問不到 DNS（${fmtIp(srv)}）：${r.reason}` };
  const sd = state.devices[r.responder];
  if (sd.kind === 'internet') {
    const host = (sd.inet.mx || {})[domain];
    return host ? { ok: true, host } : { ok: false, why: `網際網路上查不到 ${domain} 的 MX 記錄` };
  }
  if (isDnsServer(sd)) {
    const a = serverAnswer(sd, domain, 'MX');
    if (!a.nx) { const best = [...a.records].sort((x, y) => (+x.pref || 10) - (+y.pref || 10))[0]; return { ok: true, host: String(best.value).replace(/^\d+\s+/, '') }; }
    if (sd.dnsForward && depth < 3) return mxOf(state, sd.id, domain, depth + 1);
  }
  return { ok: false, why: `${sd.name} 找不到 ${domain} 的 MX 記錄` };
}

/** 收件端：這台設備（或網際網路上的那台）是不是這個網域的郵件伺服器、有沒有這個帳號 */
function accept(state, devId, ip, rcpt) {
  const d = state.devices[devId];
  if (d && d.kind === 'internet') {
    const h = d.inet.hosts.find((x) => parseIp(x.ip) === ip && x.mail);
    if (!h) return { ok: false, why: `${fmtIp(ip)} 不是郵件伺服器` };
    if (h.mail.domain !== rcpt.domain) return { ok: false, why: `${h.name} 不收 ${rcpt.domain} 的信 (550 Relaying denied)` };
    if (!(h.mail.users || []).includes(rcpt.user)) return { ok: false, why: `${h.name} 沒有 ${rcpt.user} 這個帳號 (550 User unknown)` };
    ((state.dyn.extMail ||= {})[rcpt.user + '@' + rcpt.domain] ||= []).push({ t: state.clock });
    return { ok: true, where: h.name };
  }
  if (!hasMail(d)) return { ok: false, why: `${d ? d.name : fmtIp(ip)} 不是郵件伺服器` };
  if (d.mail.domain !== rcpt.domain) return { ok: false, why: `${d.name} 不收 ${rcpt.domain} 的信 (550 Relaying denied)` };
  if (!(d.mail.users || []).includes(rcpt.user)) return { ok: false, why: `${d.name} 沒有 ${rcpt.user} 這個信箱 (550 User unknown)` };
  return { ok: true, where: d.name, box: d };
}

/**
 * 寄一封信：from 是員工的電腦（有 mailClient），或 'inet'（外面的人從網際網路上的郵件伺服器寄進來，opts.via 指定是哪一台）。
 * 回傳 { ok, why, log, hops }；送不出去的信放進寄件伺服器的佇列，原因寫在上面
 */
export function sendMail(state, fromId, to, opts = {}) {
  const log = [], hops = [], rcpt = split(to);
  const fail = (why, server) => {
    if (server && server.mail) { (server.mail.queue ||= []).push({ from: opts.from || '', to, why, t: state.clock }); if (server.mail.queue.length > 20) server.mail.queue.shift(); }
    log.push({ dev: (server || state.devices[fromId] || {}).id || fromId, kind: 'drop', text: why });
    return { ok: false, why, log, hops };
  };
  if (!rcpt) return fail(`收件人的位址不正確：${to}`);
  const src = state.devices[fromId];
  let server = null;
  if (src && src.kind === 'internet') {
    // 外面的人寄進來：從網際網路上的那台郵件伺服器出發
    const ext = src.inet.hosts.find((h) => h.mail && (!opts.via || h.mail.domain === opts.via));
    if (!ext) return fail('網際網路上沒有寄件的郵件伺服器');
    const mx = (src.inet.mx || {})[rcpt.domain], ip = mx && parseIp(src.inet.dns[mx] || '');
    if (!mx || ip == null) return fail(`網際網路上查不到 ${rcpt.domain} 的 MX（或 MX 主機沒有 A 記錄）：外面的人寄不進來`);
    log.push({ dev: src.id, kind: 'info', text: `${ext.name}：${rcpt.domain} 的 MX 是 ${mx}（${fmtIp(ip)}），用 TCP 25 送過去` });
    const r = transact(state, src.id, { proto: 'tcp', dst: ip, dport: 25, srcIp: parseIp(ext.ip) });
    log.push(...r.log); hops.push(...r.hops);
    if (!r.ok) return fail(`${ext.name} 連不到 ${mx} 的 TCP 25：${r.reason}`);
    const a = accept(state, r.responder, ip, rcpt);
    if (!a.ok) return fail(a.why);
    ((a.box.mail.boxes ||= {})[rcpt.user] ||= []).push({ from: `someone@${ext.mail.domain}`, to, t: state.clock });
    log.push({ dev: r.responder, kind: 'ok', text: `${a.where} 收下了，放進 ${rcpt.user} 的信箱` });
    return { ok: true, why: '', log, hops };
  }
  // 1. 員工的電腦把信交給公司的郵件伺服器（submission，TCP 587）
  const c = src && src.mailClient;
  if (!c || !c.server) return fail(`${src ? src.name : fromId} 沒有設定寄件伺服器 (SMTP)`);
  let sip = parseIp(c.server);
  if (sip == null) {
    const n = resolveName(state, fromId, c.server);
    log.push(...n.log); hops.push(...n.hops);
    if (!n.ok) return fail(`查不到寄件伺服器 ${c.server}：${n.reason}`);
    sip = n.ip;
  }
  const port = +c.port || 587;
  const r1 = transact(state, fromId, { proto: 'tcp', dst: sip, dport: port });
  log.push(...r1.log); hops.push(...r1.hops);
  if (!r1.ok) return fail(`連不到寄件伺服器 ${c.server} 的 TCP ${port}：${r1.reason}`);
  server = state.devices[r1.responder];
  if (!hasMail(server)) return fail(`${server.name} 不是郵件伺服器`);
  opts.from ||= c.addr || '';
  log.push({ dev: server.id, kind: 'info', text: `${server.name} 收下了寄件者 ${c.addr || src.name} 的信` });
  // 2. 收件人在自己的網域：直接放進信箱
  if (rcpt.domain === server.mail.domain) {
    const a = accept(state, server.id, sip, rcpt);
    if (!a.ok) return fail(a.why, server);
    ((server.mail.boxes ||= {})[rcpt.user] ||= []).push({ from: c.addr || '', to, t: state.clock });
    log.push({ dev: server.id, kind: 'ok', text: `收件人在自己的網域：放進 ${rcpt.user} 的信箱` });
    return { ok: true, why: '', log, hops };
  }
  // 3. 別的網域：查 MX，用 TCP 25 交給對方
  const mx = mxOf(state, server.id, rcpt.domain);
  if (!mx.ok) return fail(`信卡在 ${server.name} 的佇列：${mx.why}`, server);
  const n2 = resolveName(state, server.id, mx.host);
  if (!n2.ok) return fail(`信卡在 ${server.name} 的佇列：查不到 MX 主機 ${mx.host} 的位址（${n2.reason}）`, server);
  log.push({ dev: server.id, kind: 'info', text: `${rcpt.domain} 的 MX 是 ${mx.host}（${fmtIp(n2.ip)}）` });
  const r2 = transact(state, server.id, { proto: 'tcp', dst: n2.ip, dport: 25 });
  log.push(...r2.log); hops.push(...r2.hops);
  if (!r2.ok) return fail(`信卡在 ${server.name} 的佇列：連不到 ${mx.host} 的 TCP 25（${r2.reason}）`, server);
  const a = accept(state, r2.responder, n2.ip, rcpt);
  if (!a.ok) return fail(`退信：${a.why}`, server);
  log.push({ dev: r2.responder, kind: 'ok', text: `${a.where} 收下了 ${to} 的信` });
  return { ok: true, why: '', log, hops };
}
