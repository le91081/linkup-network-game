// LDAP / Active Directory：FortiGate 的 SSL-VPN 改用 AD 的帳號登入
//
// AD 伺服器：d.ad = { domain: 'corp.local', base: 'DC=corp,DC=local', ldaps: true | false,
//                    users: [{ user（sAMAccountName）, name（顯示名稱 / cn）, pass, groups: ['VPN-Users'…], disabled }] }
//   服務帳號（給 FortiGate bind 用）也是 users 裡的一個帳號。LDAP 是 TCP 389，LDAPS 是 TCP 636（伺服器要有憑證）。
// FortiGate：d.ldap = { 名稱: { server, port, cnid, dn, username, password, secure: 'disable' | 'ldaps' } }
//   SSL-VPN 的使用者群組：d.vpnServer.ldapMatch = [{ server: 名稱, group: 'CN=VPN-Users,OU=Groups,DC=corp,DC=local' }]
// 登入的流程：連得到 AD 的 389 / 636 → 用服務帳號 bind → 在 dn 底下用 cnid 找使用者 → 帳號沒有停用 → 用使用者的密碼再 bind 一次 → 在指定的群組裡
import { parseIp, fmtIp } from './ip.js';
import { transact } from './sim/transact.js';
import { findOwner } from './sim/forward.js';

/** 'CN=svc-ldap,CN=Users,DC=corp,DC=local'、'svc-ldap@corp.local'、'CORP\\svc-ldap'、'svc-ldap' → 'svc-ldap' */
export const acctOf = (s) => {
  const t = String(s || '').trim();
  const cn = t.match(/^CN=([^,]+)/i);
  if (cn) return cn[1].trim().toLowerCase();
  return t.replace(/^[^\\]*\\/, '').replace(/@.*$/, '').toLowerCase();
};
/** 'CN=VPN-Users,OU=Groups,DC=corp,DC=local' → 'vpn-users' */
const groupCn = (s) => { const m = String(s || '').match(/^CN=([^,]+)/i); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
const findUser = (ad, cnid, who) => (ad.users || []).find((u) => (/^cn$/i.test(cnid || '') ? String(u.name || u.user).toLowerCase() === String(who).toLowerCase() : String(u.user).toLowerCase() === String(who).toLowerCase()));

/** 用一台 LDAP 伺服器的設定驗證：{ ok, why } */
export function ldapCheck(state, fg, cfg, user, pass, group) {
  const ip = parseIp(cfg.server || '');
  if (ip == null) return { ok: false, why: 'LDAP 伺服器的位址不正確' };
  const ldaps = cfg.secure === 'ldaps', port = +cfg.port || (ldaps ? 636 : 389);
  const res = transact(state, fg.id, { proto: 'tcp', dst: ip, dport: port, quiet: true });
  if (!res.ok) return { ok: false, why: `連不到 LDAP 伺服器 ${fmtIp(ip)} 的 TCP ${port}：${res.reason}` };
  const srv = findOwner(state, ip), ad = srv && srv.ad;
  if (!ad) return { ok: false, why: `${fmtIp(ip)} 不是 LDAP / AD 伺服器` };
  if (ldaps && !ad.ldaps) return { ok: false, why: `${srv.name} 沒有 LDAPS 用的憑證：TLS 交握失敗` };
  // 服務帳號 bind
  const svc = (ad.users || []).find((u) => u.user.toLowerCase() === acctOf(cfg.username));
  if (!cfg.username) return { ok: false, why: 'FortiGate 的 LDAP 設定沒有 username（bind 用的服務帳號）：AD 不允許匿名查詢' };
  if (!svc || svc.pass !== (cfg.password || '') || svc.disabled) return { ok: false, why: `LDAP bind 失敗 (Invalid credentials)：服務帳號 ${cfg.username} 的帳號或密碼不對${svc && svc.disabled ? '（帳號已停用）' : ''}` };
  // dn：要在 AD 的網域底下找
  const base = String(ad.base || '').toLowerCase().replace(/\s+/g, ''), dn = String(cfg.dn || '').toLowerCase().replace(/\s+/g, '');
  if (!dn || !(dn === base || dn.endsWith(',' + base))) return { ok: false, why: `在 dn「${cfg.dn || '（空的）'}」底下找不到 ${user}：AD 的網域是 ${ad.base}` };
  const u = findUser(ad, cfg.cnid || 'cn', user);
  if (!u) return { ok: false, why: `AD 裡找不到 ${user}（cnid 是 ${cfg.cnid || 'cn'}：${/^samaccountname$/i.test(cfg.cnid || '') ? '比對登入名稱' : '比對顯示名稱，AD 的登入名稱要用 sAMAccountName'}）` };
  if (u.disabled) return { ok: false, why: `${user} 在 AD 裡已經停用` };
  if (u.pass !== pass) return { ok: false, why: `${user} 的密碼不對（AD 的密碼）` };
  if (group && !(u.groups || []).map((g) => g.toLowerCase()).includes(groupCn(group))) return { ok: false, why: `${user} 不在 AD 的 ${groupCn(group)} 群組裡` };
  return { ok: true, why: '', srv: srv.id };
}

/** SSL-VPN 的登入：先看 FortiGate 本機的帳號，再看群組對應的 LDAP 伺服器 */
export function vpnLogin(state, fg, user, pass) {
  const vs = fg.vpnServer || {};
  if (!user) return { ok: false, why: 'VPN 帳號或密碼錯誤' };
  const local = (vs.users || []).find((u) => u.user === user && (!vs.members || vs.members.includes(u.user)));
  if (local) return local.pass === pass ? { ok: true, why: '', local: true } : { ok: false, why: 'VPN 帳號或密碼錯誤（FortiGate 本機的帳號）' };
  const ms = vs.ldapMatch || [];
  if (!ms.length) return { ok: false, why: 'VPN 帳號或密碼錯誤' };
  let why = '';
  for (const m of ms) {
    const cfg = (fg.ldap || {})[m.server];
    if (!cfg) { why = `群組參照的 LDAP 伺服器 ${m.server} 不存在`; continue; }
    const r = ldapCheck(state, fg, cfg, user, pass, m.group);
    if (r.ok) return r;
    why = r.why;
  }
  return { ok: false, why: `VPN 登入失敗：${why}` };
}
