// 訪客入口 (Captive Portal / Web Auth)
//
// SSID（或 WLC 的 WLAN）設定 portal = { on, ip（入口網頁伺服器）, preauth（認證前允許的位址，逗號分隔，通常是 DNS 伺服器） }。
// 用戶端連上之後、在入口網頁按下同意之前，只能連：入口網頁伺服器、preauth 列出的位址。
// 其他的 HTTP / HTTPS 會被導向入口網頁 (302)，別的流量直接丟掉。
// 作業系統偵測「需不需要登入」要先查 DNS（captive.apple.com、www.msftconnecttest.com）：DNS 不在 preauth 裡，就不會跳出登入頁面。
// state.dyn.webauth[設備] = { at（同意的時間）, ssid }；session 逾時 8 小時要重新同意
import { fmtIp, parseIp } from './ip.js';

export const WEBAUTH_TTL = 8 * 3600;
const ipList = (s) => String(s || '').split(/[,\s]+/).map(parseIp).filter((x) => x != null);

/** 這台設備連著的 Wi-Fi 是不是有訪客入口、而且還沒同意：回傳 { assoc, iface, portal } 或 null */
export function portalPending(state, d) {
  for (const i of d.ifaces || []) {
    const a = i.rt && i.rt.assoc;
    if (!a || !a.portal || !a.portal.on) continue;
    const w = ((state.dyn && state.dyn.webauth) || {})[d.id];
    if (w && w.ssid === a.ssid && state.clock - w.at < WEBAUTH_TTL) return null;
    return { assoc: a, iface: i, portal: a.portal };
  }
  return null;
}

/** transact 送出之前：還沒同意的訪客只能連入口網頁與 preauth 的位址。回傳 null（放行）或 { reason, redirect } */
export function portalGate(state, d, spec) {
  const p = portalPending(state, d);
  if (!p) return null;
  const portalIp = parseIp(p.portal.ip || '');
  if (spec.dst === portalIp) return null;
  if (ipList(p.portal.preauth).includes(spec.dst)) return null;
  const web = spec.proto === 'tcp' && (spec.dport === 80 || spec.dport === 443);
  return web
    ? { redirect: portalIp, reason: `被導向訪客入口網頁${portalIp != null ? ` http://${fmtIp(portalIp)}/` : ''}：還沒有在入口網頁按下同意（HTTP 302）` }
    : { reason: `訪客入口還沒有通過：認證前只能連入口網頁${p.portal.preauth ? '與 ' + p.portal.preauth : ''}，${fmtIp(spec.dst)} 的封包被丟掉` };
}

/**
 * 訪客在入口網頁按下同意（模擬用戶端的瀏覽器）：作業系統先查 DNS（captive.apple.com）偵測入口，
 * 再連到入口網頁。transactFn 由呼叫的人傳進來（避免互相引入）。回傳 { ok, why }
 */
export function portalAccept(state, devId, transactFn) {
  const d = state.devices[devId], p = portalPending(state, d);
  if (!p) return { ok: true, already: true };
  const dns = (p.iface.rt.dns || [])[0];
  if (dns == null) return { ok: false, why: '這台設備沒有 DNS 伺服器，作業系統查不到 captive.apple.com，不會跳出登入頁面' };
  const q = transactFn(state, devId, { proto: 'udp', dst: dns, dport: 53, quiet: true });
  if (!q.ok) return { ok: false, why: `沒有跳出登入頁面：作業系統要先查 DNS（captive.apple.com）才知道有訪客入口，可是 DNS 伺服器 ${fmtIp(dns)} 連不到（${q.reason}）。認證前允許的位址 (pre-auth ACL) 要包含 DNS 伺服器` };
  const ip = parseIp(p.portal.ip || '');
  if (ip == null) return { ok: false, why: '訪客入口沒有設定入口網頁伺服器' };
  const r = transactFn(state, devId, { proto: 'tcp', dst: ip, dport: 80, quiet: true });
  if (!r.ok) return { ok: false, why: `入口網頁 http://${fmtIp(ip)}/ 打不開：${r.reason}` };
  (state.dyn.webauth ||= {})[devId] = { at: state.clock, ssid: p.assoc.ssid };
  return { ok: true };
}
