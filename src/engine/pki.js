// IOS 的 PKI：trustpoint、向 CA 取得根憑證 (authenticate)、申請自己的憑證 (enroll)，給 IKEv2 的 rsa-sig 驗證用
//
// 設備：d.pki = { tps: { 名稱: { url, subject, revoke, rsakey, ca: 憑證 | null, cert: 憑證 | null } } }
// CA 伺服器：d.ca = { name, scep: true }，在 TCP 80 提供 SCEP（Windows 的 NDES 或 IOS 的 CA 都一樣）
// 憑證：{ cn, issuer, serial, from, to }（毫秒，UTC）。根憑證的 issuer 就是自己
//
// 驗證的順序和 IOS 一樣：有沒有自己的憑證 → 對方的憑證是不是我信任的 CA 簽的 → 用「自己的時鐘」看有效期間
import { deviceTime } from './ops.js';
import { parseIp } from './ip.js';

const DAY = 86400000;
export const CA_FROM = Date.UTC(2024, 0, 1), CA_TO = Date.UTC(2034, 0, 1);
/** CA 伺服器的根憑證 */
export const caCert = (ca) => ({ cn: ca.name, issuer: ca.name, serial: '01', from: CA_FROM, to: CA_TO });
export const tpOf = (d, name) => ((d.pki && d.pki.tps) || {})[name] || null;

/** enrollment url http://10.10.0.7:80/certsrv/mscep/mscep.dll → { ip, port } */
export function urlTarget(url) {
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?/i.exec(url || '');
  if (!m) return null;
  const ip = parseIp(m[1]);
  return ip == null ? null : { ip, port: +(m[2] || 80) };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
/** IOS 的憑證時間：08:00:00 UTC Jun 1 2025 */
export function pkiDate(ms) {
  const x = new Date(ms);
  return `${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())} UTC ${MON[x.getUTCMonth()]} ${x.getUTCDate()} ${x.getUTCFullYear()}`;
}

/** 用某台設備自己的時鐘檢查一張憑證：回傳 '' 或 IOS 的錯誤 */
export function validityError(state, d, cert) {
  const now = deviceTime(state, d).ms;
  if (now < cert.from) return { code: 'NOT_YET_VALID', log: `%PKI-3-CERTIFICATE_INVALID_NOT_YET_VALID: Certificate chain validation has failed.  The certificate (SN: ${cert.serial}) is not yet valid   Validity period starts on ${pkiDate(cert.from)}`, why: `${d.name} 的時鐘是 ${pkiDate(now)}，憑證（${cert.cn}）${pkiDate(cert.from)} 才開始生效：時鐘不對，憑證就「還沒生效」` };
  if (now > cert.to) return { code: 'EXPIRED', log: `%PKI-3-CERTIFICATE_INVALID_EXPIRED: Certificate chain validation has failed.  The certificate (SN: ${cert.serial}) has expired.    Validity period ended on ${pkiDate(cert.to)}`, why: `${d.name} 的時鐘是 ${pkiDate(now)}，憑證（${cert.cn}）${pkiDate(cert.to)} 就到期了` };
  return null;
}

/** CA 簽一張憑證給設備：用 CA 伺服器自己的時鐘（一般的伺服器自動校時），效期兩年 */
export function issue(state, caDev, subject) {
  const ca = caDev.ca;
  ca.next = (ca.next || 1) + 1;
  const now = deviceTime(state, caDev).ms;
  const cn = (/CN=([^,]+)/i.exec(subject || '') || [])[1] || subject || caDev.name;
  // 和 Windows 的 CA 一樣往前推 10 分鐘，時鐘差一點點的設備才不會拿到「還沒生效」的憑證
  return { cn, issuer: ca.name, serial: two(ca.next).toUpperCase(), from: now - 600000, to: now - 600000 + 730 * DAY };
}

/** 憑證的內容換成 running-config 裡的十六進位（貼回去的時候可以還原） */
export function certHex(cert) {
  const json = JSON.stringify([cert.cn, cert.issuer, cert.serial, cert.from, cert.to]);
  const bytes = Array.from(new TextEncoder().encode(json));
  // 前面加上 DER 的 SEQUENCE 開頭，看起來像真的憑證
  const hex = '3082' + bytes.length.toString(16).padStart(4, '0').toUpperCase() + bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return hex.match(/.{1,64}/g).map((l) => l.match(/.{1,8}/g).join(' '));
}
export function hexCert(lines) {
  try {
    const hex = lines.join('').replace(/\s+/g, '');
    if (!hex.startsWith('3082')) return null;
    const body = hex.slice(8), bytes = new Uint8Array(body.match(/../g).map((h) => parseInt(h, 16)));
    const [cn, issuer, serial, from, to] = JSON.parse(new TextDecoder().decode(bytes));
    return { cn, issuer, serial, from, to };
  } catch { return null; }
}

/**
 * IKEv2 rsa-sig：a 送自己的憑證給 b，b 用 trustpoint 的 CA 與自己的時鐘驗證。
 * 回傳 null（通過）或 { why, log }
 */
export function verifyPeer(state, a, tpA, b, tpB) {
  const ta = tpOf(a, tpA), tb = tpOf(b, tpB);
  if (!ta) return { why: `${a.name} 的 ikev2 profile 指定的 trustpoint ${tpA || '（沒有指定 pki trustpoint）'} 不存在`, log: `IKEv2:Failed to retrieve Certificate Issuer list` };
  if (!ta.cert) return { why: `${a.name} 的 trustpoint ${tpA} 還沒有自己的憑證（crypto pki authenticate ${tpA}，再 crypto pki enroll ${tpA}）`, log: `IKEv2:(SESSION ID = 1,SA ID = 1):Failed to obtain own certificate` };
  if (!tb) return { why: `${b.name} 的 ikev2 profile 指定的 trustpoint ${tpB || '（沒有指定 pki trustpoint）'} 不存在`, log: `IKEv2:Failed to retrieve Certificate Issuer list` };
  if (!tb.ca) return { why: `${b.name} 的 trustpoint ${tpB} 還沒有 CA 的根憑證（crypto pki authenticate ${tpB}）：沒辦法驗證 ${a.name} 的憑證`, log: `IKEv2:(SESSION ID = 1,SA ID = 1):Verification of peer's certificate failed: no trusted CA` };
  if (ta.cert.issuer !== tb.ca.cn) return { why: `${a.name} 的憑證是「${ta.cert.issuer}」簽的，${b.name} 的 trustpoint ${tpB} 信任的是「${tb.ca.cn}」`, log: `%CRYPTO-5-IKEV2_CERT_INVALID: unable to validate peer certificate chain: issuer not trusted` };
  const v = validityError(state, b, ta.cert) || validityError(state, b, tb.ca);
  if (v) return { why: v.why, log: v.log };
  return null;
}

