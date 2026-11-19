// 設備的維運面：每台設備自己的時鐘、NTP 對時、事件紀錄 (logging) 與 Syslog
//
// state.dyn.clk[設備]   = { boot, set?, ntp? }        開機時間、手動設定的時間、NTP 的狀態
// state.dyn.log[設備]   = [{ n, t, sev, line }]       設備自己的紀錄緩衝區（RAM，重開機就沒了）
// state.dyn.syslog[伺服器] = [{ n, t, ip, dev, sev, line }]   Syslog 伺服器收到的訊息
// state.dyn.ev[設備]    = 上一次看到的狀態，用來比對出「發生了什麼事」
import { parseIp, fmtIp } from './ip.js';
import { transact, macsBehind, closeFlow } from './sim.js';
import { isIos } from './ios.js';
import { linkInfo } from './model.js';
import { ensureFlash, bootPick, isCiscoOs, IMAGES } from './files.js';

export const SIM_EPOCH = Date.UTC(2026, 0, 5, 1, 0, 0); // 模擬世界開始的那一刻：2026-01-05 09:00（UTC+8）
const FACTORY = Date.UTC(1993, 2, 1, 0, 0, 0); // 沒有硬體時鐘的 IOS 交換器，每次開機都從這一刻算起
export const UPTIME0 = 273600; // 關卡開始時，設備已經開機 3 天 4 小時
export const INET_NTP = '216.239.35.0'; // time.google.com
export const NTP_POLL = 64; // 兩次輪詢的間隔（秒）
const NO_RTC = new Set(['c2960', 'c2960p']); // 這些機型沒有電池供電的時鐘
const LOG_MAX = 60, SYSLOG_MAX = 200;

export const SEVERITY = ['emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging'];
const FORTI_LEVEL = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'information', 'debug'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n) => String(n).padStart(2, '0');
const dotMac = (m) => String(m || '').replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** 硬體時鐘也不準：每台設備固定快或慢三分鐘以內 */
const drift = (d) => ((hashStr(d.id + '/rtc') % 361) - 180) * 1000;

/** 網際網路上要有一台公用的 NTP 伺服器（舊存檔裡沒有，這裡補上） */
export function ensureInetNtp(d) {
  if (!d.inet) return;
  if (!d.inet.hosts.some((h) => h.ip === INET_NTP)) d.inet.hosts.push({ ip: INET_NTP, name: 'time.google.com', services: [{ proto: 'udp', port: 123 }] });
  if (!d.inet.dns['time.google.com']) d.inet.dns['time.google.com'] = INET_NTP;
}

// ───────────────────────── 設備的時鐘 ─────────────────────────

/**
 * 這台設備「以為」現在幾點。回傳 { ms, src, auth, sync, tz }
 *  src：ntp（已對時）、manual（clock set）、rtc（硬體時鐘）、boot（從開機算起）、os（電腦與伺服器）
 *  auth：時間可不可信（IOS 不可信時前面會有 *）；sync：目前是否和 NTP 同步
 */
export function deviceTime(state, d, depth = 0) {
  const now = state.clock || 0, wall = SIM_EPOCH + now * 1000;
  const c = (state.dyn && state.dyn.clk && state.dyn.clk[d.id]) || {};
  const tz = (d.mgmt && d.mgmt.tz) || { name: 'UTC', off: 0 };
  const out = (ms, src, auth, sync) => ({ ms, src, auth, sync, tz });
  if (!d.mgmt) return out(wall, 'os', true, true);
  const n = c.ntp;
  if (n && n.synced && depth < 6) {
    // 對時對的是「上游那一台的時間」：上游自己的時鐘是錯的，下游就跟著錯
    const ref = state.devices[n.ref];
    return out(ref && ref.mgmt ? deviceTime(state, ref, depth + 1).ms : wall, 'ntp', true, true);
  }
  if (c.set) return out(c.set.wall + (now - c.set.at) * 1000, c.set.free ? 'ntp' : 'manual', true, false);
  if (NO_RTC.has(d.model)) return out(FACTORY + (now - (c.boot ?? now - UPTIME0)) * 1000, 'boot', false, false);
  return out(wall + drift(d), 'rtc', false, false);
}

const parts = (t) => {
  const x = new Date(t.ms + t.tz.off * 3600000);
  return { x, hms: `${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())}`, ms: String(x.getUTCMilliseconds()).padStart(3, '0') };
};
/** IOS 在時間前面加的記號：* 不可信；. 曾經對過時但目前失去同步 */
const flagOf = (t) => (!t.auth ? '*' : t.src === 'ntp' && !t.sync ? '.' : '');

/** show clock 的格式：*00:01:23.000 UTC Mon Mar 1 1993 */
export function iosClock(state, d) {
  const t = deviceTime(state, d), p = parts(t);
  return `${flagOf(t)}${p.hms}.${p.ms} ${t.tz.name} ${DAY[p.x.getUTCDay()]} ${MON[p.x.getUTCMonth()]} ${p.x.getUTCDate()} ${p.x.getUTCFullYear()}`;
}
/** 紀錄用的時間戳記：*Mar  1 00:01:23.000 */
export function iosStamp(state, d) {
  const t = deviceTime(state, d), p = parts(t);
  return `${flagOf(t)}${MON[p.x.getUTCMonth()]} ${String(p.x.getUTCDate()).padStart(2)} ${p.hms}.${p.ms}`;
}
/** 一般的日期時間：2026-01-05 09:00:12 */
export function plainStamp(state, d) {
  const p = parts(deviceTime(state, d));
  return { date: `${p.x.getUTCFullYear()}-${two(p.x.getUTCMonth() + 1)}-${two(p.x.getUTCDate())}`, time: p.hms, day: DAY[p.x.getUTCDay()], mon: MON[p.x.getUTCMonth()], dd: p.x.getUTCDate(), yyyy: p.x.getUTCFullYear() };
}
/** 開機到現在多久（秒） */
export function uptimeOf(state, d) {
  const c = (state.dyn && state.dyn.clk && state.dyn.clk[d.id]) || {};
  return Math.max(0, (state.clock || 0) - (c.boot ?? (state.clock || 0) - UPTIME0));
}
/** clock set：手動設定時間（wallMs 是 UTC 的毫秒） */
export function setClock(state, d, wallMs) {
  const c = (state.dyn.clk[d.id] ||= {});
  c.set = { at: state.clock, wall: wallMs };
}

// ───────────────────────── NTP ─────────────────────────

/** IOS 要連續幾次輪詢都收到回應才採信（大約四到五分鐘）；FortiGate 第一次收到就校時 */
export const ntpNeed = (d) => (d.kind === 'firewall' ? 0 : 4 * NTP_POLL);

function stratumOf(state, ref) {
  if (!ref || ref.kind === 'internet') return 1;
  if (!ref.mgmt) return 2; // 內部的 NTP 伺服器，通常再向公用的伺服器對時
  const n = ((state.dyn.clk[ref.id] || {}).ntp) || {};
  return n.synced ? n.stratum : +ref.mgmt.ntpMaster || 8;
}

/** NTP 目前的狀態，給 show ntp status 與設定頁面用 */
export function ntpInfo(state, d) {
  const c = (state.dyn && state.dyn.clk && state.dyn.clk[d.id]) || {};
  const srv = d.mgmt ? parseIp(d.mgmt.ntp || '') : null;
  const n = c.ntp && c.ntp.srv === srv ? c.ntp : null;
  const master = d.mgmt && +d.mgmt.ntpMaster > 0 ? +d.mgmt.ntpMaster : 0;
  const now = state.clock || 0;
  return {
    server: srv, master, synced: !!(n && n.synced), lost: !!(n && n.synced && n.lostAt != null),
    stratum: n && n.synced ? n.stratum : master || 16, serverStratum: n && n.stratum ? n.stratum - 1 : 16,
    reach: n ? n.reach || 0 : 0, why: n ? n.why || '' : '',
    // 還在累積輪詢次數：再多久會採信
    wait: n && !n.synced && n.okSince != null ? Math.max(0, n.okSince + ntpNeed(d) - now) : 0,
    reachable: !!(n && n.okSince != null), when: n ? Math.floor(now - n.poll) : 0, next: n ? Math.max(0, Math.ceil(n.poll + NTP_POLL - now)) : 0,
  };
}

function ntpTick(state, boot) {
  // 關卡一開始當作已經運作很久：一層一層往下對時都已經完成，所以多跑幾輪
  for (let round = 0; round < (boot ? 3 : 1); round++) ntpRound(state, boot, round);
}

function ntpRound(state, boot, round) {
  const now = state.clock, down = state.down || {}, devs = Object.values(state.devices);
  const dead = (d) => !!down[d.id] || !!state.rt.off[d.id];
  // 哪些設備可以回答 NTP：設成 ntp master，或自己已經向上游對好時的 IOS 設備
  for (const d of devs) {
    if (!d.mgmt || !d.rt) continue;
    const n = (state.dyn.clk[d.id] || {}).ntp;
    d.rt.ntpServe = !dead(d) && isIos(d) && !!(+d.mgmt.ntpMaster > 0 || (n && n.synced));
  }
  for (const d of devs) {
    if (!d.mgmt) continue;
    const c = (state.dyn.clk[d.id] ||= {});
    const srv = parseIp(d.mgmt.ntp || '');
    if (srv == null || dead(d)) { delete c.ntp; continue; }
    let n = c.ntp;
    if (!n || n.srv !== srv) n = c.ntp = { srv, poll: -1e9, okSince: null, synced: false, reach: 0 };
    if (now - n.poll >= NTP_POLL || (boot && (round === 0 || n.okSince == null))) {
      n.poll = now;
      const r = transact(state, d.id, { proto: 'udp', dst: srv, dport: 123, quiet: true });
      if (r.ok) {
        n.ref = r.responder; n.why = '';
        n.stratum = stratumOf(state, state.devices[r.responder]) + 1;
        if (n.okSince == null) n.okSince = boot ? -1e9 : now;
        n.reach = ((n.reach << 1) | 1) & 255;
        n.lostAt = null;
        n.lastOk = now;
      } else {
        n.why = r.reason; n.okSince = null;
        n.reach = (n.reach << 1) & 255;
        // 第一次沒收到回應的那一次輪詢，是上一次成功之後的下一輪（時間一次跳很多的時候也要算對）
        if (n.synced && n.lostAt == null) n.lostAt = Math.min(now, (n.lastOk ?? now) + NTP_POLL);
      }
      if (boot && r.ok) n.reach = 255;
    }
    if (!n.synced && n.okSince != null && now - n.okSince >= ntpNeed(d)) {
      n.synced = true;
      delete c.set;
      if (!boot) logEvent(state, d, 5, 'NTP-5-PEERSYNC', `NTP synced to peer ${fmtIp(srv)}`, `logid="0100020027" type="event" subtype="system" level="notice" vd="root" logdesc="NTP server status" msg="The system time has been synchronized with NTP server ${fmtIp(srv)}"`);
    }
    // 連續八次輪詢都沒有回應：不再算是同步。時鐘不會跳回去，而是照原本的速度自己走下去
    if (n.synced && n.lostAt != null && now - n.lostAt >= 8 * NTP_POLL) {
      c.set = { at: now, wall: deviceTime(state, d).ms, free: true };
      n.synced = false;
      logEvent(state, d, 4, 'NTP-4-UNSYNC', 'NTP sync is lost', `logid="0100020027" type="event" subtype="system" level="warning" vd="root" logdesc="NTP server status" msg="NTP server ${fmtIp(srv)} is unreachable"`);
    }
  }
}

// ───────────────────────── 紀錄與 Syslog ─────────────────────────

/**
 * 設備記下一筆事件。sev 是嚴重程度（0 最嚴重，7 是除錯訊息），tag 是 IOS 的「設施-嚴重度-代碼」。
 * forti 是 FortiGate 那一種格式的內容（沒有就不記）。
 */
export function logEvent(state, d, sev, tag, msg, forti) {
  if (!state.dyn || !state.dyn.log || !d || !d.mgmt || (state.down || {})[d.id]) return;
  let line;
  if (isIos(d)) {
    if (!tag) return; // 只有 FortiGate 才有的事件
    line = `${iosStamp(state, d)}: %${tag}: ${msg}`;
  } else if (d.kind === 'firewall' && forti) {
    const s = plainStamp(state, d);
    line = `date=${s.date} time=${s.time} devname="${d.name}" ${forti}`;
  } else return;
  const n = (state.dyn.logSeq = (state.dyn.logSeq || 0) + 1);
  const buf = (state.dyn.log[d.id] ||= []);
  buf.push({ n, t: state.clock, sev, line });
  if (buf.length > LOG_MAX) buf.shift();
  // 嚴重程度在門檻以內的才送到 Syslog 伺服器（logging trap，預設 informational）
  const srv = parseIp(d.mgmt.syslog || '');
  const trap = d.mgmt.logTrap == null || d.mgmt.logTrap === '' ? 6 : +d.mgmt.logTrap;
  if (srv != null && sev <= trap) (state.dyn.outbox ||= []).push({ dev: d.id, srv, n, sev, line });
}

/** 把還沒送出的訊息送到 Syslog 伺服器（UDP 514）。UDP 不會重送：這一刻送不到，訊息就掉了 */
function flushSyslog(state) {
  const box = state.dyn.outbox;
  if (!box || !box.length) return;
  state.dyn.outbox = [];
  const reach = {};
  for (const m of box) {
    const d = state.devices[m.dev];
    if (!d) continue;
    const key = m.dev + '>' + m.srv;
    reach[key] ??= transact(state, m.dev, { proto: 'udp', dst: m.srv, dport: 514, quiet: true });
    const r = reach[key], c = (state.dyn.clk[m.dev] ||= {});
    if (!r.ok) { c.lost = (c.lost || 0) + 1; c.lostWhy = r.reason; continue; }
    c.sent = (c.sent || 0) + 1;
    const buf = (state.dyn.syslog[r.responder] ||= []);
    buf.push({ n: m.n, t: state.clock, ip: fmtIp(r.seenSrc ?? r.srcIp), dev: m.dev, sev: m.sev, line: isIos(d) ? `<${184 + m.sev}>${m.n}: ${m.line}` : `<${184 + m.sev}>${m.line}` });
    if (buf.length > SYSLOG_MAX) buf.shift();
  }
}

/** IOS 的 debug 輸出：沒有 %設施-嚴重度-代碼，嚴重度是 7 (debugging)。會進紀錄緩衝區，也會出現在 console */
export function debugLog(state, d, text) { rawLog(state, d, 7, text); }
/** 沒有 %設施-嚴重度-代碼 的訊息（debug、開機過程） */
export function rawLog(state, d, sev, text) {
  if (!state.dyn || !state.dyn.log || !d || !isIos(d)) return;
  const n = (state.dyn.logSeq = (state.dyn.logSeq || 0) + 1);
  const buf = (state.dyn.log[d.id] ||= []);
  const line = `${iosStamp(state, d)}: ${text}`;
  buf.push({ n, t: state.clock, sev, line });
  if (buf.length > LOG_MAX) buf.shift();
  const srv = d.mgmt && parseIp(d.mgmt.syslog || ''), trap = d.mgmt && d.mgmt.logTrap != null && d.mgmt.logTrap !== '' ? +d.mgmt.logTrap : 6;
  if (srv != null && trap >= sev) (state.dyn.outbox ||= []).push({ dev: d.id, srv, n, sev, line });
}

export const logRows = (state, d) => ((state.dyn && state.dyn.log && state.dyn.log[d.id]) || []);
export const syslogRows = (state, d) => ((state.dyn && state.dyn.syslog && state.dyn.syslog[d.id]) || []);
export function clearLog(state, d) { if (state.dyn && state.dyn.log) delete state.dyn.log[d.id]; }
export function clearSyslog(state, d) { if (state.dyn && state.dyn.syslog) delete state.dyn.syslog[d.id]; }
/** 這台主機有沒有在收 Syslog（UDP 514） */
export const isSyslogServer = (d) => (d.services || []).some((s) => s.proto === 'udp' && s.port === 514);
/** 送往 Syslog 伺服器的統計 */
export function syslogStats(state, d) {
  const c = (state.dyn && state.dyn.clk && state.dyn.clk[d.id]) || {};
  return { sent: c.sent || 0, lost: c.lost || 0, why: c.lostWhy || '' };
}

// ───────────────────────── 登入的連線 (vty) ─────────────────────────

/** 登入之後可以閒置多久（秒）。0 代表不會自動登出。IOS 預設 10 分鐘 (exec-timeout 10 0)，FortiGate 預設 5 分鐘 (admintimeout 5) */
export function idleLimit(d) {
  const m = d.mgmt || {};
  if (isIos(d)) return m.execTimeout == null || m.execTimeout === '' ? 600 : +m.execTimeout;
  return (+m.adminTimeout > 0 ? +m.adminTimeout : 5) * 60;
}
/** 目前登入在這台設備上的遠端連線 */
export const vtyRows = (state, d) => ((state.dyn && state.dyn.vty && state.dyn.vty[d.id]) || []);

/** 設備這一端：閒置太久的登入連線主動切斷 */
function pruneVty(state) {
  const now = state.clock, down = state.down || {};
  for (const [id, list] of Object.entries(state.dyn.vty || {})) {
    const d = state.devices[id];
    if (!d || down[id] || state.rt.off[id]) { delete state.dyn.vty[id]; continue; }
    const lim = idleLimit(d);
    state.dyn.vty[id] = list.filter((v) => {
      if (v.busy || !(lim > 0) || now - v.last < lim) return true;
      closeFlow(state, v.cid);
      logEvent(state, d, 6, '', '', `logid="0100032003" type="event" subtype="system" level="information" vd="root" logdesc="Admin logout successful" user="${v.user}" ui="${v.proto}(${v.ip})" action="logout" status="success" reason="timeout" msg="Administrator ${v.user} timed out on ${v.proto}(${v.ip})"`);
      return false;
    });
  }
  // login block-for 的安靜期結束
  for (const [id, L] of Object.entries(state.dyn.login || {})) {
    const d = state.devices[id];
    if (!d) { delete state.dyn.login[id]; continue; }
    if (L.quiet != null && now >= L.quiet) {
      delete L.quiet; L.fails = [];
      logEvent(state, d, 5, 'SEC_LOGIN-5-QUIET_MODE_OFF', `Quiet Mode is OFF, because block period timed out at ${iosClock(state, d)}`);
    }
  }
}

// ───────────────────────── 重新開機 ─────────────────────────

/** reload 指令：下一次計算時把這台設備當成剛開機 */
export function markReboot(state, devId) {
  if (!state.dyn) return;
  ((state.dyn.clk ||= {})[devId] ||= {}).reload = true;
}

/** 從按下電源（或 reload）到可以開始工作要多久（秒） */
const BOOT_TIME = {
  hub4: 2, sw5: 5, sw8: 5, homerouter: 60, ap: 60, erx: 60, c2960: 120, c2960p: 120, isr4321: 180, isr4331: 180, c9300: 240, n93180: 240, n9332: 240,
  fg60f: 70, fg100f: 90, pc: 30, laptop: 20, phone: 20, printer: 30, wprinter: 30, nas: 90, tower: 90, rack1u: 150,
};
export const bootTime = (d) => BOOT_TIME[d.model] ?? 30;

/** 記憶體裡的東西全部消失：ARP、MAC 位址表、連線表、VPN 的 SA、紀錄緩衝區、登入的連線；連接埠要重新走一次 STP */
function wipe(state, d) {
  const dyn = state.dyn, c = (dyn.clk[d.id] ||= {});
  for (const k of ['arp', 'mac', 'ct', 'log', 'vty', 'login', 'ifc', 'dbg', 'sniff', 'dflow', 'con', 'cap']) if (dyn[k]) delete dyn[k][d.id];
  for (const k of Object.keys(dyn.sa || {})) if (k.startsWith(d.id + '/')) delete dyn.sa[k];
  for (const cb of state.cables) {
    if (cb.a.dev !== d.id && cb.b.dev !== d.id) continue;
    delete dyn.port[cb.a.dev + ':' + cb.a.port];
    delete dyn.port[cb.b.dev + ':' + cb.b.port];
  }
  // OSPF 的鄰居關係要從頭建立
  for (const k of Object.keys(dyn.adj || {})) if (k.split('~').some((x) => x.startsWith(d.id + '/'))) delete dyn.adj[k];
  delete c.ntp; delete c.set; delete c.reload;
  delete (dyn.ev || {})[d.id];
}

/**
 * 在每次重新計算之前呼叫：處理 reload，以及「關機之後又開機」。
 * 開機需要時間：這段期間設備和關機沒有兩樣。回傳 { 設備 id: 還要幾秒 }。
 */
export function opsBefore(state) {
  const dyn = state.dyn, down = state.down || {}, first = !!dyn.boot, now = state.clock;
  const booting = {};
  for (const d of Object.values(state.devices)) {
    const c = (dyn.clk[d.id] ||= {});
    if (c.boot == null) c.boot = first ? now - UPTIME0 : now;
    const dead = !!down[d.id];
    ensureFlash(d);
    // 按下 reload，或剛從關機變成開機：記憶體清空，開始計算開機時間
    if (!dead && (c.reload || c.off)) {
      wipe(state, d);
      delete c.rommon;
      if (d.fwNext) { d.fw = d.fwNext; delete d.fwNext; } // FortiGate：新韌體在重新開機時生效
      // Cisco：依 boot system 的順序找映像檔，都找不到就停在 ROMMON
      const b = isCiscoOs(d) && d.flash ? bootPick(d) : null;
      if (b && b.rommon) { c.rommon = { why: b.rommon, notes: b.notes }; c.up = Infinity; }
      else {
        if (b) { d.fw = { image: b.image, ver: IMAGES[d.flash.files[b.image].img].ver }; c.bootNotes = b.notes; }
        c.up = now + bootTime(d);
      }
    }
    c.off = dead || undefined;
    if (dead) delete c.up;
    if (c.up != null) {
      if (now >= c.up) { c.boot = c.up; c.restarted = true; delete c.up; } // 開機完成：時鐘從這一刻重新開始
      else booting[d.id] = c.up - now;
    }
    if (d.kind === 'internet') ensureInetNtp(d);
  }
  return booting;
}

// ───────────────────────── 事件：比對前後兩次的狀態 ─────────────────────────

/** Gi0/1 → GigabitEthernet0/1 */
export const longIf = (s) => String(s).replace(/^Gi(?=\d)/, 'GigabitEthernet').replace(/^Te(?=\d)/, 'TenGigabitEthernet').replace(/^Fa(?=\d)/, 'FastEthernet')
  .replace(/^Eth(?=\d)/, 'Ethernet').replace(/^Po(?=\d)/, 'Port-channel');
/** OSPF 的 Router ID：手動指定的，不然就是介面上最大的 IP */
export function routerId(d) {
  const set = parseIp(d.ospfRid || '');
  if (set != null) return set;
  let best = null;
  for (const i of d.ifaces) if (i.rt && i.rt.ip != null && (best == null || i.rt.ip > best)) best = i.rt.ip;
  return best;
}

function snapshot(state, d) {
  const s = { port: {}, nbr: {}, vrrp: {}, tun: {}, dup: {}, dupIp: {}, pool: [], auth: {} };
  const shutIf = (pid) => d.ifaces.some((i) => i.shut && i.bind.t === 'port' && i.bind.port === pid);
  for (const p of d.ports) {
    const pc = d.sw && d.sw.ports[p.id], err = d.rt.err && d.rt.err[p.id];
    s.port[p.id] = (pc && pc.shut) || shutIf(p.id) ? 'admin' : err === 'root' ? 'rootinc' : err === 'bpdu' ? 'bpdu' : err ? 'psec' : state.rt.links[d.id + ':' + p.id] ? 'up' : 'down';
    const li = state.rt.links[d.id + ':' + p.id] && linkInfo(state, d.id, p.id);
    if (li && li.mismatch) s.dup[p.id] = li.duplex + '|' + li.peerDuplex;
    const a = pc && pc.dot1x && state.rt.auth && state.rt.auth.dot1x[d.id + ':' + p.id];
    if (a && state.rt.links[d.id + ':' + p.id]) s.auth[p.id] = a.ok ? 'ok' : 'fail';
  }
  for (const n of d.rt.nbrs || []) if (n.state !== 'forming') s.nbr[n.dev + '|' + n.iface] = { st: n.state, rid: routerId(state.devices[n.dev]) ?? n.ip };
  for (const i of d.ifaces) {
    if (i.vrrp && i.vrrp.on && i.rt.vrrp) s.vrrp[i.id] = i.rt.vrrp.state;
    if (i.rt.conflict) s.dupIp[i.id] = i.rt.ip;
  }
  for (const t of d.rt.tunnels || []) if (t.cfg) s.tun[t.name] = { up: !!t.up && !t.stale, peer: t.peerIp };
  for (const [k, v] of Object.entries(state.rt.dhcpConflict || {})) if (k.startsWith(d.id + '/')) s.pool.push(...v);
  return s;
}

const CAP = { init: 'Init', backup: 'Backup', master: 'Master' };

function diffDevice(state, d, a, b) {
  const ios = isIos(d);
  const ev = (sev, tag, msg, forti) => logEvent(state, d, sev, tag, msg, forti);
  const label = (pid) => (d.ports.find((p) => p.id === pid) || {}).label || pid;
  const ifLabel = (id) => (d.ifaces.find((i) => i.id === id) || {}).label || id;
  const fgIf = (pid) => { const i = d.ifaces.find((x) => x.bind.port === pid); return i ? i.id : pid; };
  const linkMsg = (pid, up) => {
    const L = longIf(label(pid));
    ev(3, 'LINK-3-UPDOWN', `Interface ${L}, changed state to ${up ? 'up' : 'down'}`,
      `logid="0100020099" type="event" subtype="system" level="information" vd="root" logdesc="Interface status changed" action="interface-stat-change" status="${up ? 'UP' : 'DOWN'}" msg="Link monitor: Interface ${fgIf(pid)} was turned ${up ? 'up' : 'down'}"`);
    if (ios) ev(5, 'LINEPROTO-5-UPDOWN', `Line protocol on Interface ${L}, changed state to ${up ? 'up' : 'down'}`);
  };
  // 埠已經被關掉了，所以從接線去找這個埠後面有哪些 MAC：對面是電腦就是它自己，是交換器或基地台就是接在它後面的設備
  const macsOn = (pid) => {
    const c = state.cables.find((x) => (x.a.dev === d.id && x.a.port === pid) || (x.b.dev === d.id && x.b.port === pid));
    const o = c && (c.a.dev === d.id ? c.b : c.a), x = o && state.devices[o.dev];
    if (!x) return [];
    const i = x.ifaces.find((y) => (y.bind.t === 'port' || y.bind.t === 'sub') && y.bind.port === o.port);
    if (i && i.rt && i.rt.mac) return [i.rt.mac];
    const out = [];
    for (const y of x.ifaces) if ((y.bind.t === 'svi' || y.bind.t === 'bridge') && y.rt && y.rt.ip != null) out.push(y.rt.mac);
    for (const cl of state.rt.clients[x.id] || []) out.push(cl.iface.rt.mac);
    if (x.sw) for (const p of Object.keys(x.sw.ports)) if (p !== o.port) for (const m of macsBehind(state, x, p)) out.push(m.mac);
    return out;
  };
  const peerMac = (pid) => macsOn(pid)[0];
  const badMac = (pid) => {
    const pc = d.sw.ports[pid], ok = String((pc.ps && pc.ps.macs) || '').toLowerCase();
    const all = macsOn(pid), m = all.find((x) => !ok.includes(x)) || all[0];
    return m ? dotMac(m) : 'unknown';
  };
  for (const [pid, now] of Object.entries(b.port)) {
    const was = a.port[pid];
    if (was === now || was == null) continue;
    const L = longIf(label(pid)), S = label(pid);
    const wasUp = was === 'up';
    if (now === 'up') {
      if (was === 'rootinc') { ev(2, 'SPANTREE-2-ROOTGUARD_UNBLOCK', `Root guard unblocking port ${L} on VLAN0001.`); continue; }
      linkMsg(pid, true);
    } else if (now === 'admin') {
      ev(5, 'LINK-5-CHANGED', `Interface ${L}, changed state to administratively down`,
        `logid="0100020099" type="event" subtype="system" level="information" vd="root" logdesc="Interface status changed" action="interface-stat-change" status="DOWN" msg="Link monitor: Interface ${fgIf(pid)} was turned down"`);
      if (ios && wasUp) ev(5, 'LINEPROTO-5-UPDOWN', `Line protocol on Interface ${L}, changed state to down`);
    } else if (now === 'rootinc') {
      ev(2, 'SPANTREE-2-ROOTGUARD_BLOCK', `Root guard blocking port ${L} on VLAN0001.`);
    } else if (now === 'bpdu') {
      ev(2, 'SPANTREE-2-BLOCK_BPDUGUARD', `Received BPDU on port ${S} with BPDU Guard enabled. Disabling port.`);
      ev(4, 'PM-4-ERR_DISABLE', `bpduguard error detected on ${S}, putting ${S} in err-disable state`);
      if (wasUp) linkMsg(pid, false);
    } else if (now === 'psec') {
      ev(4, 'PM-4-ERR_DISABLE', `psecure-violation error detected on ${S}, putting ${S} in err-disable state`);
      ev(2, 'PORT_SECURITY-2-PSECURE_VIOLATION', `Security violation occurred, caused by MAC address ${badMac(pid)} on port ${L}.`);
      if (wasUp) linkMsg(pid, false);
    } else if (wasUp) linkMsg(pid, false);
    else if (was === 'admin') ev(3, 'LINK-3-UPDOWN', `Interface ${L}, changed state to down`); // no shutdown，但線還沒接
  }
  // OSPF 鄰居
  for (const [k, n] of Object.entries(b.nbr)) {
    if (!a.nbr[k]) ev(5, 'OSPF-5-ADJCHG', `Process 1, Nbr ${fmtIp(n.rid)} on ${longIf(ifLabel(k.split('|')[1]))} from LOADING to FULL, Loading Done`);
  }
  for (const [k, n] of Object.entries(a.nbr)) {
    if (!b.nbr[k]) ev(5, 'OSPF-5-ADJCHG', `Process 1, Nbr ${fmtIp(n.rid)} on ${longIf(ifLabel(k.split('|')[1]))} from FULL to DOWN, Neighbor Down: ${n.st === 'dying' ? 'Dead timer expired' : 'Interface down or detached'}`);
  }
  // VRRP
  for (const [id, st] of Object.entries(b.vrrp)) {
    const was = a.vrrp[id];
    if (was && was !== st) ev(6, 'VRRP-6-STATECHANGE', `${ifLabel(id)} Grp 1 state ${CAP[was]} -> ${CAP[st]}`);
  }
  // VPN 通道
  for (const [name, t] of Object.entries(b.tun)) {
    const was = a.tun[name];
    if (!was || was.up === t.up || t.peer == null) continue;
    ev(5, 'CRYPTO-5-SESSION_STATUS', `Crypto tunnel is ${t.up ? 'UP' : 'DOWN'}  .  Peer ${fmtIp(t.peer)}:500       Id: ${fmtIp(t.peer)}`,
      `logid="0101037138" type="event" subtype="vpn" level="notice" vd="root" logdesc="IPsec connection status changed" msg="IPsec connection status change" action="tunnel-${t.up ? 'up' : 'down'}" remip=${fmtIp(t.peer)} vpntunnel="${name}"`);
  }
  // IP 位址衝突、DHCP 發放前 ping 到有人在用
  for (const [id, ip] of Object.entries(b.dupIp)) {
    if (a.dupIp[id] === ip) continue;
    const i = d.ifaces.find((x) => x.id === id), other = i && state.devices[i.rt.conflict];
    const mac = other && (other.ifaces.find((x) => x.rt && x.rt.ip === ip) || {}).rt;
    ev(4, 'IP-4-DUPADDR', `Duplicate address ${fmtIp(ip)} on ${longIf(ifLabel(id))}, sourced by ${mac ? dotMac(mac.mac) : 'unknown'}`);
  }
  for (const ip of b.pool) if (!a.pool.includes(ip)) ev(4, 'DHCPD-4-PING_CONFLICT', `DHCP address conflict:  server pinged ${fmtIp(ip)}.`);
  // 802.1X
  for (const [pid, st] of Object.entries(b.auth)) {
    if (a.auth[pid] === st) continue;
    const m = peerMac(pid);
    ev(5, st === 'ok' ? 'DOT1X-5-SUCCESS' : 'DOT1X-5-FAIL', `Authentication ${st === 'ok' ? 'successful' : 'failed'} for client (${m ? dotMac(m) : 'Unknown MAC'}) on Interface ${label(pid)}`);
  }
}

/** Duplex mismatch：CDP 每分鐘發現一次就抱怨一次，直到修好為止 */
function duplexNag(state, d, snap, at) {
  if (!isIos(d)) return;
  for (const [pid, v] of Object.entries(snap.dup)) {
    if (at[pid] != null && state.clock - at[pid] < 60) continue;
    at[pid] = state.clock;
    const l = state.rt.links[d.id + ':' + pid], x = l && state.devices[l.dev];
    if (!x || !isIos(x)) continue; // CDP 是 Cisco 的協定：對面不是 Cisco 就不知道對方的雙工
    const [mine, peer] = v.split('|');
    const txt = (dx) => (dx === 'half' ? 'half duplex' : 'not half duplex');
    const label = (dev, p) => longIf((dev.ports.find((q) => q.id === p) || {}).label || p);
    logEvent(state, d, 4, 'CDP-4-DUPLEX_MISMATCH', `duplex mismatch discovered on ${label(d, pid)} (${txt(mine)}), with ${x.name} ${label(x, l.port)} (${txt(peer)}).`);
  }
  for (const pid of Object.keys(at)) if (!snap.dup[pid]) delete at[pid];
}

/** 每次重新計算之後呼叫：NTP 輪詢、找出這一次發生的事件並記下來、把訊息送到 Syslog 伺服器 */
export function opsAfter(state) {
  const dyn = state.dyn, boot = !!dyn.boot, down = state.down || {};
  ntpTick(state, boot);
  for (const d of Object.values(state.devices)) {
    if (!d.mgmt || !(isIos(d) || d.kind === 'firewall')) continue;
    const c = (dyn.clk[d.id] ||= {});
    if (down[d.id] || state.rt.off[d.id]) { delete dyn.ev[d.id]; continue; }
    if (c.restarted) {
      // 開機過程中遇到的問題（指定的映像檔不能用，改用別的）會先印在 console 上
      for (const n of c.bootNotes || []) rawLog(state, d, 3, n);
      delete c.bootNotes;
      logEvent(state, d, 5, 'SYS-5-RESTART', 'System restarted --', `logid="0100032009" type="event" subtype="system" level="information" vd="root" logdesc="System restarted" msg="Fortigate started${d.fw ? ' v' + d.fw.ver : ''}"`);
    }
    const snap = snapshot(state, d);
    let prev = dyn.ev[d.id];
    if (c.restarted) {
      // 剛開完機：有接線的介面會一個一個亮起來
      delete c.restarted;
      prev = { port: Object.fromEntries(d.ports.map((p) => [p.id, 'down'])), nbr: {}, vrrp: {}, tun: {}, dup: {}, dupIp: {}, pool: [], auth: {} };
    }
    if (prev && !boot) diffDevice(state, d, prev, snap);
    snap.dupAt = (prev && prev.dupAt) || {};
    if (!boot) duplexNag(state, d, snap, snap.dupAt);
    dyn.ev[d.id] = snap;
  }
  for (const id of Object.keys(dyn.ev)) if (!state.devices[id]) delete dyn.ev[id];
  pruneVty(state);
  flushSyslog(state);
}
