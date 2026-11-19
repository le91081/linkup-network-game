// 遠端登入：從一台設備用 SSH / Telnet 進另一台設備的命令列。
//
// 這是一條長時間保持的 TCP 連線。路上每一台有狀態的設備都要一直記得它；
// 閒置太久，設備那一端會主動登出 (exec-timeout / admintimeout)，路上的防火牆也可能先把連線忘了。
import { transact, flowSend, closeFlow } from './sim.js';
import { logEvent, iosClock, idleLimit, vtyRows } from './ops.js';
import { isIos } from './ios.js';
import { fmtIp } from './ip.js';

const PORT = { ssh: 22, telnet: 23 };
const MAX_TRIES = 3;

function hashHex(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
/** 設備的 SSH 主機金鑰指紋。換了一台設備，或重新產生過金鑰，指紋就不一樣 */
export const hostKey = (d) => {
  const g = d.mgmt && d.mgmt.sshKey ? d.mgmt.sshKey.gen : 0;
  return 'SHA256:' + (hashHex(d.id + '/k1/' + g) + hashHex(d.id + '/k2/' + g) + hashHex(d.id + '/k3/' + g) + hashHex(d.id + '/k4/' + g)).slice(0, 27);
};
/**
 * vty 的登入方式：local（login local，用 username 建的帳號）、line（login，只問 line 底下設定的密碼）、
 * none（no login，不驗證）。原廠預設是 line，而且沒有設密碼，所以 Telnet 進不去
 */
export const vtyMode = (d) => (isIos(d) ? (d.mgmt && d.mgmt.vtyLogin) || 'line' : 'local');

/**
 * 產生 SSH 用的 RSA 金鑰（crypto key generate rsa）。IOS 要先有自己的主機名稱與網域名稱，因為金鑰的名稱就是 主機名稱.網域名稱。
 * 成功回傳 null，失敗回傳 IOS 的錯誤訊息
 */
export function genKey(state, d, bits) {
  const m = d.mgmt, host = d.name.replace(/[^\w-]+/g, '-');
  if (/^(Router|Switch)$/i.test(host)) return `% Please define a hostname other than ${host}.`;
  if (!m.domain) return '% Please define a domain-name first.';
  const had = m.sshKey;
  // 每次產生的金鑰都不一樣：指紋跟著換，連過的用戶端會發現「主機金鑰變了」
  m.sshKey = { bits, gen: ((had && had.gen) || 0) * 31 + ((state.dyn.keySeq = (state.dyn.keySeq || 0) + 1) * 7919) % 100000 + 1 };
  if (bits >= 768) logEvent(state, d, 5, 'SSH-5-ENABLED', `SSH ${m.sshVer === 2 ? '2.0' : '1.99'} has been enabled`);
  return null;
}

/** 登入失敗太多次之後的封鎖規則。IOS 要自己設 login block-for；FortiGate 預設三次失敗鎖 60 秒 */
function blockRule(d) {
  if (isIos(d)) { const b = d.mgmt.block; return b && +b.sec > 0 ? { sec: +b.sec, tries: +b.tries || 3, within: +b.within || 60 } : null; }
  return { sec: 60, tries: 3, within: 60 };
}
const loginState = (state, d) => ((state.dyn.login ||= {})[d.id] ||= { fails: [] });
/** 設備目前是不是在拒絕登入的安靜期。回傳剩下的秒數，不是就回傳 0 */
export function quietLeft(state, d) {
  const L = (state.dyn.login || {})[d.id];
  return L && L.quiet != null && L.quiet > state.clock ? Math.ceil(L.quiet - state.clock) : 0;
}

// SSH 送出去的內容全部加密，線路上只看得到「一個加密的封包」；Telnet 是明文
/** 登入成功：設備記下這條 vty 連線 */
function grant(state, d, conn) {
  const m = d.mgmt, now = state.clock, at = isIos(d) ? iosClock(state, d) : '';
  conn.authed = true;
  ((state.dyn.vty ||= {})[d.id] ||= []).push({ cid: conn.cid, user: conn.user || '(line)', ip: conn.seen, proto: conn.proto, t0: now, last: now });
  if (m.loginLog && m.loginLog.ok) logEvent(state, d, 5, 'SEC_LOGIN-5-LOGIN_SUCCESS', `Login Success [user: ${conn.user}] [Source: ${conn.seen}] [localport: ${conn.dport}] at ${at}`);
  logEvent(state, d, 6, '', '', `logid="0100032001" type="event" subtype="system" level="information" vd="root" logdesc="Admin login successful" user="${conn.user}" ui="${ui(conn)}" method="${conn.proto}" srcip=${conn.seen} action="login" status="success" reason="none" msg="Administrator ${conn.user} logged in successfully from ${ui(conn)}"`);
}
const flowOf = (c, data) => ({ cid: c.cid, to: c.to, src: c.src, sport: c.sport, dst: c.ip, dport: c.dport, data: c.proto === 'ssh' ? { kind: 'enc' } : data, echo: { kind: 'out' } });
const ui = (c) => `${c.proto}(${c.seen})`;

/**
 * 開始連線：完成 TCP 三向交握。回傳 { ok, reason, res（給動畫用的追蹤結果）, conn }。
 * 連得上不代表可以登入：接下來還要用 remoteLogin 驗證帳號密碼。
 */
export function remoteOpen(state, fromId, proto, ip, user) {
  const dport = PORT[proto];
  const cid = 'c' + (state.dyn.cseq = (state.dyn.cseq || 0) + 1);
  const res = transact(state, fromId, { proto: 'tcp', dst: ip, dport, keep: cid });
  if (!res.ok) return { ok: false, res, reason: res.reason };
  const d = state.devices[res.responder];
  const conn = { cid, from: fromId, to: d.id, proto, ip, user: user || '', src: res.srcIp, sport: res.sport, dport, seen: fmtIp(res.seenSrc ?? res.srcIp), tries: 0, authed: false };
  const kind = isIos(d) ? 'ios' : d.kind === 'firewall' ? 'forti' : null;
  if (!d.mgmt || !kind) { closeFlow(state, cid); return { ok: false, res, reason: `${d.name} 接受了連線，但這個模擬沒有它的命令列可以登入`, refused: true }; }
  const q = quietLeft(state, d);
  if (q) { closeFlow(state, cid); return { ok: false, res, reason: `${d.name} 因為登入失敗太多次，正在拒絕所有登入（還要 ${q} 秒）`, refused: true }; }
  const auth = vtyMode(d);
  if (proto === 'telnet' && auth === 'line' && !d.mgmt.vtyPass) {
    closeFlow(state, cid);
    return { ok: false, res, noPass: true, reason: `${d.name} 的 line vty 是 login（用線路密碼登入），但還沒有設定密碼。原廠預設就是這樣：一定要先設定，才能遠端登入` };
  }
  if (auth === 'none') { grant(state, d, conn); return { ok: true, res, conn, kind, key: hostKey(d), auth, open: true }; }
  return { ok: true, res, conn, kind, key: hostKey(d), auth };
}

/** 驗證帳號密碼。回傳 { ok, closed, reason }：closed 代表連線已經被切斷，不能再試 */
export function remoteLogin(state, conn, pass) {
  const d = state.devices[conn.to];
  const sent = flowSend(state, conn.from, flowOf(conn, conn.proto === 'telnet' ? { kind: 'login', user: conn.user, pass } : null));
  if (!sent.ok) { closeFlow(state, conn.cid); return { ok: false, closed: true, reason: sent.reason }; }
  const m = d.mgmt, now = state.clock;
  const mode = vtyMode(d);
  // SSH 一定要有帳號：line vty 只設 login（線路密碼）的話，SSH 登入不了
  const sshNeedsLocal = conn.proto === 'ssh' && mode !== 'local';
  const good = !sshNeedsLocal && (mode === 'line' ? pass === (m.vtyPass || '') && !!m.vtyPass : conn.user === (m.user ?? 'admin') && pass === (m.pass ?? 'admin'));
  const at = isIos(d) ? iosClock(state, d) : '';
  if (good) { grant(state, d, conn); return { ok: true }; }
  conn.tries++;
  const L = loginState(state, d), rule = blockRule(d);
  L.fails.push(now);
  if (m.loginLog && m.loginLog.fail) logEvent(state, d, 4, 'SEC_LOGIN-4-LOGIN_FAILED', `Login failed [user: ${conn.user}] [Source: ${conn.seen}] [localport: ${conn.dport}] [Reason: Login Authentication Failed] at ${at}`);
  logEvent(state, d, 1, '', '', `logid="0100032002" type="event" subtype="system" level="alert" vd="root" logdesc="Admin login failed" user="${conn.user}" ui="${ui(conn)}" method="${conn.proto}" srcip=${conn.seen} action="login" status="failed" reason="passwd_invalid" msg="Administrator ${conn.user} login failed from ${ui(conn)} because of invalid password"`);
  if (rule) {
    L.fails = L.fails.filter((t) => now - t < rule.within);
    if (L.fails.length >= rule.tries) {
      L.quiet = now + rule.sec;
      logEvent(state, d, 1, 'SEC_LOGIN-1-QUIET_MODE_ON', `Still timeleft for watching failures is ${Math.max(0, Math.ceil(rule.within - (now - L.fails[0])))} secs, [user: ${conn.user}] [Source: ${conn.seen}] [localport: ${conn.dport}] [Reason: Login Authentication Failed] [ACL: sl_def_acl] at ${at}`,
        `logid="0100032021" type="event" subtype="system" level="alert" vd="root" logdesc="Admin login disabled" ui="${ui(conn)}" action="login" status="failed" reason="exceed_limit" msg="Login disabled from IP ${conn.seen} for ${rule.sec} seconds because of ${rule.tries} bad attempts"`);
      closeFlow(state, conn.cid);
      return { ok: false, closed: true, locked: rule.sec, reason: `登入失敗太多次，${d.name} 接下來 ${rule.sec} 秒拒絕所有登入` };
    }
  }
  const max = conn.proto === 'ssh' && isIos(d) ? +m.sshRetries || MAX_TRIES : MAX_TRIES;
  if (sshNeedsLocal && conn.tries >= max) return { ok: false, closed: true, reason: `${d.name} 的 line vty 沒有設定 login local：SSH 要用 username 建立的帳號登入，只設 login（線路密碼）的話永遠登入不了` };
  if (conn.tries >= max) { closeFlow(state, conn.cid); return { ok: false, closed: true, reason: `密碼錯了 ${max} 次，連線被切斷` }; }
  return { ok: false, closed: false, hint: sshNeedsLocal ? 'line vty 沒有設定 login local' : '' };
}

/** 設備正在執行一個要花時間的指令（例如 copy）：這段時間不算閒置 */
export function remoteBusy(state, conn, on) {
  const v = vtyRows(state, state.devices[conn.to] || {}).find((x) => x.cid === conn.cid);
  if (!v) return;
  if (on) v.busy = true; else { delete v.busy; v.last = state.clock; }
  if (!on) for (const list of Object.values(state.dyn.ct || {})) for (const e of list) if (e.cid === conn.cid) e.t = state.clock;
}

/** 登入之後的連線還在不在（不送任何資料）。設備重開機、被設備閒置登出都會讓它消失 */
export function remoteAlive(state, conn) {
  const d = state.devices[conn.to];
  if (!d) return { ok: false, by: 'device', reason: '設備已經不存在' };
  const v = vtyRows(state, d).find((x) => x.cid === conn.cid);
  if (v) return { ok: true, idle: Math.floor(state.clock - v.last), limit: idleLimit(d) };
  return { ok: false, by: 'device', limit: idleLimit(d) };
}

/**
 * 在登入的連線上送出一行指令。先確認封包真的到得了對方（路上的防火牆可能已經把這條連線忘了）。
 * 回傳 { ok } 或 { ok: false, by: 'device' | 'net', reason }
 */
export function remoteSend(state, conn, text) {
  const alive = remoteAlive(state, conn);
  const sent = flowSend(state, conn.from, flowOf(conn, conn.proto === 'telnet' ? { kind: 'cmd', text } : null));
  if (!sent.ok) return { ok: false, by: 'net', reason: sent.reason, res: sent };
  if (!alive.ok) return alive;
  const v = vtyRows(state, state.devices[conn.to]).find((x) => x.cid === conn.cid);
  v.last = state.clock;
  return { ok: true, res: sent };
}

/** 自己登出 (exit) */
export function remoteClose(state, conn) {
  const d = state.devices[conn.to];
  closeFlow(state, conn.cid);
  if (!d || !state.dyn.vty || !state.dyn.vty[d.id]) return;
  const had = state.dyn.vty[d.id].some((v) => v.cid === conn.cid);
  state.dyn.vty[d.id] = state.dyn.vty[d.id].filter((v) => v.cid !== conn.cid);
  if (had) logEvent(state, d, 6, '', '', `logid="0100032003" type="event" subtype="system" level="information" vd="root" logdesc="Admin logout successful" user="${conn.user}" ui="${ui(conn)}" action="logout" status="success" reason="exit" msg="Administrator ${conn.user} logged out from ${ui(conn)}"`);
}
