// AAA（認證 Authentication、授權 Authorization、記錄 Accounting）與 TACACS+。
// 設備把「誰能登入、登入之後能做什麼、做了什麼」交給集中的伺服器（例如 Cisco ISE）。TACACS+ 走 TCP 49，整個封包內容都加密。
//
// aaa new-model 之後，vty 的登入改用方法清單，例如 aaa authentication login default group tacacs+ local：
//   依序嘗試。伺服器連不到、或沒有回應（ERROR）才換下一個方法；伺服器回答「帳號或密碼錯誤」（FAIL）就直接拒絕，不會再試本機帳號。
// 授權：aaa authorization exec — 登入之後的權限等級由伺服器（或本機帳號的 privilege）決定；沒有設定的話一律是 1（使用者模式 >）。
//       aaa authorization commands 15 — 每一行 15 級的指令都先問伺服器能不能執行。
// 記錄：aaa accounting commands 15 default start-stop group tacacs+ — 每一行 15 級的指令都送到伺服器記下來（誰、何時、在哪台、打了什麼）。
//
// 設備：d.aaa = { on, authn: { default: [方法…], 名稱: [...] }, authzExec: [...], authzCmd: [...], acctCmd: bool, acctExec: bool, src: 介面 id }
//       d.tacacs = [{ name, ip, key }]（tacacs server <名稱>）；方法：'tacacs'（group tacacs+）、'local'、'none'
// 伺服器：d.tacacsServer = { key, clients: [IP…]（空的代表誰都接受）, users: [{ user, pass, priv, cmds: 'all' | 'show' }], log: [] }
import { parseIp, fmtIp } from './ip.js';
import { transact } from './sim.js';
import { localUsers } from './ops.js';

export const METHOD_TEXT = { tacacs: 'group tacacs+', local: 'local', none: 'none' };
/** 方法清單的文字 → [方法]：'group tacacs+ local' → ['tacacs', 'local']；不認得回傳 null */
export function parseMethods(words) {
  const out = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k].toLowerCase();
    if (w === 'group' && /^tacacs\+?$/i.test(words[k + 1] || '')) { out.push('tacacs'); k++; }
    else if (w === 'local' || w === 'none') out.push(w);
    else return null;
  }
  return out.length ? out : null;
}

/** 等級 1 就能用的指令（不受 aaa authorization commands 15 管）：一般的 show、ping、traceroute、離開 */
export const LEVEL1 = (text) => {
  const t = text.trim().split(/\s+/), a = (t[0] || '').toLowerCase(), b = (t[1] || '').toLowerCase();
  if (/^(ping|tracer|traceroute|exit|logout|quit|end|enable|disable|terminal)$/.test(a)) return true;
  return /^sh/.test(a) && !/^(run|start|arch|tech)/.test(b);
};

/**
 * 問 TACACS+ 伺服器（依序試 tacacs server 設定的每一台）。
 * 回傳 { srv（伺服器設備）, user（伺服器上的帳號，可能是 undefined）} 或 { error: 原因 }
 */
function tacQuery(state, d, user) {
  const list = (d.tacacs || []).filter((x) => x.ip);
  if (!list.length) return { error: `${d.name} 沒有設定任何 TACACS+ 伺服器（tacacs server <名稱> → address ipv4 <IP>）` };
  const why = [];
  for (const t of list) {
    const src = srcIp(d);
    const r = transact(state, d.id, { proto: 'tcp', dst: parseIp(t.ip), dport: 49, quiet: true, ...(src != null ? { srcIp: src } : {}) });
    if (!r.ok) { why.push(`${t.ip}：${r.reason}`); continue; }
    const host = state.devices[r.responder], srv = host && host.tacacsServer;
    if (!srv) { why.push(`${t.ip} 不是 TACACS+ 伺服器`); continue; }
    const seen = fmtIp(r.seenSrc ?? r.srcIp);
    // 伺服器只回應登記過的網路設備（ISE 的 Network Devices）；沒登記的來源直接丟掉，設備等到逾時
    if ((srv.clients || []).length && !srv.clients.includes(seen)) { why.push(`${host.name} 沒有登記 ${seen} 這個網路設備，不回應（逾時）`); continue; }
    // 共用密鑰不一致：伺服器解不開封包，設備收到的回應也解不開 — 當成錯誤 (ERROR)
    if (!t.key || t.key !== srv.key) { why.push(`${host.name} 與 ${d.name} 的 TACACS+ 共用密鑰不一致（Invalid AUTHEN/START packet, check keys）`); continue; }
    return { srv: host, user: (srv.users || []).find((u) => u.user === user), seen };
  }
  return { error: why.join('；') };
}
/** 送 TACACS+ 用的來源位址：ip tacacs source-interface */
function srcIp(d) {
  const id = d.aaa && d.aaa.src;
  if (!id) return null;
  const i = d.ifaces.find((x) => x.id === id);
  return i && i.rt && i.rt.ip != null ? i.rt.ip : null;
}

const listFor = (d, name) => (d.aaa.authn || {})[name || 'default'] || null;

/**
 * 登入：回傳 { ok, priv, via: 'tacacs' | 'local' | 'none', trail: [每個方法的結果], reason }
 * 沒有設定 aaa authentication login 的話，預設用本機帳號
 */
export function aaaLogin(state, d, user, pass) {
  const m = d.mgmt || {}, trail = [];
  const methods = listFor(d, m.vtyAuthList) || (m.vtyAuthList ? null : ['local']);
  if (!methods) return { ok: false, trail, reason: `line vty 的 login authentication ${m.vtyAuthList} 沒有對應的 aaa authentication login ${m.vtyAuthList}` };
  for (const k of methods) {
    if (k === 'tacacs') {
      const q = tacQuery(state, d, user);
      if (q.error) { trail.push(`TACACS+：ERROR（${q.error}）→ 試下一個方法`); continue; }
      if (q.user && q.user.pass === pass) { trail.push(`TACACS+（${q.srv.name}）：PASS`); return { ok: true, via: 'tacacs', trail, priv: execPriv(state, d, user, 'tacacs', q) }; }
      trail.push(`TACACS+（${q.srv.name}）：FAIL — 帳號或密碼錯誤，不會再試下一個方法`);
      return { ok: false, trail, reason: `${q.srv.name} 拒絕了 ${user}（TACACS+ 回答 FAIL）` };
    }
    if (k === 'local') {
      const u = localUsers(m).find((x) => x.user === user && x.pass === pass);
      if (u) { trail.push('本機帳號：PASS'); return { ok: true, via: 'local', trail, priv: execPriv(state, d, user, 'local', null) }; }
      trail.push('本機帳號：FAIL');
      return { ok: false, trail, reason: `${d.name} 上沒有這個本機帳號，或密碼錯誤` };
    }
    if (k === 'none') { trail.push('none：不驗證'); return { ok: true, via: 'none', trail, priv: execPriv(state, d, user, 'none', null) }; }
  }
  return { ok: false, trail, reason: `方法清單 ${methods.map((x) => METHOD_TEXT[x]).join(' ')} 全部出錯，沒有方法可以驗證` };
}

/** 登入之後的權限等級：aaa authorization exec 決定；沒有設定就是 1 */
function execPriv(state, d, user, via, q) {
  const list = d.aaa.authzExec;
  if (!list) return 1;
  for (const k of list) {
    if (k === 'tacacs') {
      const r = q && !q.error ? q : tacQuery(state, d, user);
      if (r.error) continue;
      return r.user ? +r.user.priv || 1 : 1;
    }
    if (k === 'local') { const u = localUsers(d.mgmt || {}).find((x) => x.user === user); return u ? u.priv : 1; }
    if (k === 'none') return 15;
  }
  return 1;
}

/**
 * 15 級的指令要不要先問伺服器（aaa authorization commands 15）。回傳 null（可以執行）或錯誤訊息
 */
export function aaaAuthorize(state, d, user, priv, text) {
  const list = d.aaa && d.aaa.on && d.aaa.authzCmd;
  if (!list || priv < 15 || LEVEL1(text)) return null;
  for (const k of list) {
    if (k === 'tacacs') {
      const q = tacQuery(state, d, user);
      if (q.error) continue;
      if (!q.user) return 'Command authorization failed.';
      if ((q.user.cmds || 'all') === 'show' && !/^sh/i.test(text.trim())) return 'Command authorization failed.';
      return null;
    }
    if (k === 'local' || k === 'none') return null;
  }
  return 'Command authorization failed.';
}

/** aaa accounting commands 15：把這一行送到伺服器記下來 */
export function aaaAccount(state, d, who, priv, text) {
  if (!(d.aaa && d.aaa.on && d.aaa.acctCmd) || priv < 15 || LEVEL1(text)) return;
  const q = tacQuery(state, d, who.user);
  if (q.error) return;
  const log = (q.srv.tacacsServer.log ||= []);
  log.push({ t: state.clock, dev: d.name, nas: q.seen, user: who.user, line: who.line, ip: who.ip, cmd: text.trim(), priv });
  if (log.length > 200) log.splice(0, log.length - 200);
}
