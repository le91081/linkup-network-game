// 網站與 HTTPS 憑證
//
// 伺服器：d.web = { title, redirect（HTTP 轉到 HTTPS）, cert: { cn, san: [名稱], issuer, from, to（毫秒）} }
//   issuer 是簽發的 CA；和 cn 一樣（或 'self'）就是自簽憑證
// 用戶端：d.trust = [信任的 CA]（加入公司網域的電腦會自動裝好公司的根憑證），公開的 CA 每台都信任
// 驗證的順序和瀏覽器、curl 一樣：誰簽的（信不信任）→ 有效期間（用「用戶端自己的時鐘」判斷）→ 名稱對不對
import { deviceTime, SIM_EPOCH } from './ops.js';

export const PUBLIC_CAS = ['DigiCert Global Root G2', 'ISRG Root X1', 'GlobalSign Root R3'];
export const CORP_CA = 'Corp Root CA';
const DAY = 86400000;
export const certSelf = (c) => !c.issuer || c.issuer === 'self' || c.issuer === c.cn;

/** 名稱比對：支援萬用字元 *.corp.local（只比對一層） */
export function nameMatch(pattern, host) {
  const p = String(pattern).toLowerCase(), h = String(host).toLowerCase();
  if (p.startsWith('*.')) { const rest = p.slice(2); return h.endsWith('.' + rest) && !h.slice(0, -rest.length - 1).includes('.'); }
  return p === h;
}

/** 網際網路上的網站用的憑證：公開 CA 簽的，前後都還有很久 */
const PUBLIC_CERT = (host) => ({ cn: host, san: [host], issuer: PUBLIC_CAS[0], from: SIM_EPOCH - 60 * DAY, to: SIM_EPOCH + 300 * DAY });

/**
 * 用戶端 client 連到 server 的 HTTPS（網址的主機名稱是 host）：憑證可不可以接受
 * 回傳 { ok, cert, code（curl 的錯誤號碼）, msg（curl 的訊息）, why（中文說明）}
 */
/**
 * 伺服器出示的憑證：
 * - 網際網路上的網站：公開 CA 簽的
 * - 有設定 d.web 的伺服器：它安裝的那一張（沒有就是 null）
 * - 網路設備的管理網頁（Cisco、ESXi、FortiGate）：出廠時自己產生的自簽憑證
 * - 其他沒有特別設定的網站：當作已經裝好正確的憑證
 */
export function certOf(server, host) {
  if (server.kind === 'internet') return PUBLIC_CERT(host);
  if (server.web) return server.web.cert || null;
  if (server.kind !== 'host') {
    const vendor = server.vendor || '';
    if (server.kind === 'firewall') return { cn: 'FortiGate', san: ['FortiGate'], issuer: 'Fortinet_CA_SSL', from: SIM_EPOCH - 400 * DAY, to: SIM_EPOCH + 3000 * DAY, factory: true };
    const cn = server.kind === 'hypervisor' ? (server.name || 'localhost.localdomain') : `IOS-Self-Signed-Certificate-${(server.id.length * 2654435761 >>> 0) % 1e10}`;
    return { cn, san: [cn], issuer: 'self', from: SIM_EPOCH - 400 * DAY, to: SIM_EPOCH + 3000 * DAY, factory: true, vendor };
  }
  return { ...PUBLIC_CERT(host), assumed: true };
}

export function tlsCheck(state, client, server, host, deepBy) {
  const real = certOf(server, host);
  // SSL deep inspection：FortiGate 先和網站完成 TLS，再用自己的 CA 簽一張同名的憑證給電腦
  const cert = deepBy && real ? { cn: host, san: [host], issuer: 'Fortinet_CA_SSL', from: real.from, to: real.to, resigned: deepBy.name } : real;
  if (!cert) return { ok: false, code: 35, msg: 'OpenSSL SSL_connect: SSL_ERROR_SYSCALL', why: `${server.name} 的 443 有在聽，但沒有設定 HTTPS 憑證，TLS 交握失敗` };
  const trust = new Set([...PUBLIC_CAS, ...(client.trust || [])]);
  if (certSelf(cert)) return { ok: false, cert, code: 60, msg: 'SSL certificate problem: self-signed certificate', why: `${server.name} 的憑證是自簽的（簽發者就是它自己），${client.name} 不信任${cert.factory ? '。網路設備的管理網頁出廠都是自簽憑證，正式環境要換成內部 CA 簽的' : ''}` };
  if (!trust.has(cert.issuer)) return { ok: false, cert, code: 60, msg: 'SSL certificate problem: unable to get local issuer certificate', why: cert.resigned ? `${cert.resigned} 做 SSL deep inspection：連線被它解密，電腦收到的是 FortiGate 用「Fortinet_CA_SSL」重新簽發的憑證，${client.name}沒有安裝這張 CA（要用群組原則發給每台電腦，或改用 certificate-inspection）` : `${server.name} 的憑證是「${cert.issuer}」簽的，${client.name} 的信任清單裡沒有這個 CA` };
  const now = deviceTime(state, client).ms;
  if (now < cert.from) return { ok: false, cert, code: 60, msg: 'SSL certificate problem: certificate is not yet valid', why: `${client.name} 的時鐘是 ${fmtDate(now)}，憑證 ${fmtDate(cert.from)} 才開始生效（用戶端的時間不對，也會讓憑證「還沒生效」）` };
  if (now > cert.to) return { ok: false, cert, code: 60, msg: 'SSL certificate problem: certificate has expired', why: `${server.name} 的憑證 ${fmtDate(cert.to)} 就到期了` };
  const names = cert.san && cert.san.length ? cert.san : [cert.cn];
  if (!names.some((n) => nameMatch(n, host))) return { ok: false, cert, code: 60, msg: `SSL: no alternative certificate subject name matches target host name '${host}'`, why: `憑證上的名稱是 ${names.join('、')}，網址用的是 ${host}` };
  return { ok: true, cert };
}

export function fmtDate(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}
/** 憑證還有幾天到期（用模擬世界的時間） */
export const certDaysLeft = (state, cert) => Math.floor((cert.to - (SIM_EPOCH + (state.clock || 0) * 1000)) / DAY);
/** 由某個 CA 簽發一張新的憑證（有效一年） */
export function issueCert(state, { cn, san, issuer, days = 365 }) {
  const now = SIM_EPOCH + (state.clock || 0) * 1000;
  return { cn, san: san && san.length ? san : [cn], issuer, from: now - 3600000, to: now + days * DAY };
}
