// FortiGate 的 HA（FGCP，Active-Passive）
//
// 兩台同型號、同版本的 FortiGate 用 heartbeat 線（hbdev）互相確認，群組名稱、群組 ID、密碼都一樣才會組成叢集。
// 選出主要機 (primary) 的順序（override disable，預設）：
//   1. 監控的介面 (monitor) 連線正常的數量多的
//   2. HA uptime 長的：這裡簡化成「本來就是主要機的那台」（監控的介面斷過、整台重開的就不算）
//   3. priority 大的
//   4. 序號大的
// override enable 的話 priority 排在 uptime 前面：主要機回來之後會把角色搶回去。
//
// 叢集組成之後：
//   - 設定由主要機同步給次要機（主機名稱、priority、override 不同步）
//   - 只有主要機的介面在運作，用虛擬 MAC（00:09:0f:09:<群組 ID>:<介面序號>）；次要機的資料介面不回應
//   - session-pickup enable：連線表同步給次要機，切換之後進行中的連線不會斷
//   - heartbeat 線斷了：兩台都以為對方掛了，都當主要機（split brain），同一個 IP 出現在兩台上
//
// d.ha = { mode: 'standalone' | 'a-p', group, gid, pass, hbdev: [介面], monitor: [介面], prio, override, pickup }
// d.rt.ha = { role: 'primary' | 'secondary' | 'standalone', peer, alone, why, by }
// state.dyn.ha[設備] = { role, peer, since, took, from }：記住上一次的角色（uptime 與接手的時間）
import { hash } from './sim/core.js';
import { logEvent } from './ops.js';

export const newHa = () => ({ mode: 'standalone', group: '', gid: 0, pass: '', hbdev: [], monitor: [], prio: 128, override: false, pickup: false });
export const haOn = (d) => !!(d && d.ha && d.ha.mode === 'a-p');
/** 這台的序號（依設備 id 固定產生） */
export const serialOf = (d) => (d.model === 'fg100f' ? 'FG100FTK' : 'FGT60FTK') + String(hash('sn:' + d.id) % 100000000).padStart(8, '0');
const modelName = (d) => (d.model === 'fg100f' ? '100F' : '60F');
/** 叢集的虛擬 MAC：00:09:0f:09:<群組 ID>:<介面序號> */
export const haVmac = (gid, idx) => ['00', '09', '0f', '09', (gid & 255).toString(16).padStart(2, '0'), (idx & 255).toString(16).padStart(2, '0')].join(':');

// 這些欄位是每一台自己的，不會從主要機同步過來
const LOCAL = new Set(['id', 'model', 'kind', 'name', 'pos', 'ports', 'rt', 'locked', 'note', 'fw', 'ha', 'shape']);

/** 介面目前有沒有連線（internal 這種硬體交換器：任何一個成員埠有連線就算） */
export function haIfUp(state, d, name) {
  const i = d.ifaces.find((x) => x.id === name);
  if (!i) return false;
  if (i.bind.t === 'port' || i.bind.t === 'sub') return !!state.rt.links[d.id + ':' + i.bind.port];
  if (i.bind.t === 'bridge') return Object.keys((d.sw && d.sw.ports) || {}).some((p) => state.rt.links[d.id + ':' + p]);
  return !!i.rt && !!i.rt.link;
}
/** heartbeat 介面接到哪一台的哪一個介面 */
function hbPeer(state, d, name) {
  const i = d.ifaces.find((x) => x.id === name);
  if (!i || i.bind.t !== 'port') return null;
  const l = state.rt.links[d.id + ':' + i.bind.port];
  if (!l) return null;
  const p = state.devices[l.dev];
  const pi = p && p.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === l.port);
  return p ? { dev: p, iface: pi } : null;
}
export const isHb = (d, i) => haOn(d) && (d.ha.hbdev || []).includes(i.id);
/** 次要機的資料介面：不運作 */
export const haIdle = (d, i) => !!(d.rt && d.rt.ha && d.rt.ha.role === 'secondary' && !isHb(d, i));

/** 依序比較，回傳 [贏的那台, 原因] */
function elect(state, a, b) {
  const mon = (d) => (d.ha.monitor || []).filter((n) => haIfUp(state, d, n)).length;
  const was = (d) => ((state.dyn.ha || {})[d.id] || {}).role === 'primary';
  const ma = mon(a), mb = mon(b);
  if (ma !== mb) return [ma > mb ? a : b, 'monitor'];
  const age = was(a) !== was(b) ? (was(a) ? a : b) : null;
  const pri = a.ha.prio !== b.ha.prio ? (a.ha.prio > b.ha.prio ? a : b) : null;
  const ovr = a.ha.override || b.ha.override;
  for (const [w, why] of ovr ? [[pri, 'priority'], [age, 'uptime']] : [[age, 'uptime'], [pri, 'priority']]) if (w) return [w, why];
  return [serialOf(a) > serialOf(b) ? a : b, 'serial'];
}

/** 主要機把設定同步給次要機 */
function syncConfig(pri, sec, fresh) {
  for (const k of Object.keys(sec)) if (!LOCAL.has(k) && !(k in pri)) delete sec[k];
  for (const [k, v] of Object.entries(pri)) {
    if (LOCAL.has(k)) continue;
    if (k === 'ifaces') {
      const old = Object.fromEntries(sec.ifaces.map((i) => [i.id, i.rt]));
      sec.ifaces = v.map((i) => { const { rt, ...cfg } = i; const c = JSON.parse(JSON.stringify(cfg)); c.rt = old[i.id] || fresh(sec, c); return c; });
    } else if (k === 'mgmt') {
      sec.mgmt = { ...JSON.parse(JSON.stringify(v)) };
    } else sec[k] = JSON.parse(JSON.stringify(v));
  }
  // HA 的設定裡，priority 與 override 是每台自己的
  const { prio, override } = sec.ha;
  sec.ha = { ...JSON.parse(JSON.stringify(pri.ha)), prio, override };
}

const evt = (state, d, level, msg) => logEvent(state, d, level === 'critical' ? 2 : level === 'warning' ? 4 : 5, '', '', `type="event" subtype="ha" level="${level}" vd="root" logdesc="HA state change" msg="${msg}"`);

/** 接手成為主要機：session-pickup 的話把對方的連線表搬過來 */
function takeOver(state, d, from, why) {
  const m = ((state.dyn.ha ||= {})[d.id] ||= {});
  m.took = state.clock; m.from = from ? from.id : null;
  if (d.ha.pickup && from) {
    const src = (state.dyn.ct[from.id] || []).filter((e) => e.st !== 'fin');
    const tbl = (state.dyn.ct[d.id] ||= []);
    for (const e of src) if (!tbl.some((x) => x.cid && x.cid === e.cid && x.sport === e.sport)) tbl.push({ ...e });
  }
  if (!state.dyn.boot) evt(state, d, 'critical', `${d.name} 成為主要機：${why}${d.ha.pickup ? '（session-pickup：連線表已經同步，進行中的連線照常）' : '（沒有 session-pickup：進行中的連線要重新建立）'}`);
}

/**
 * 計算每一組叢集的角色，並把主要機的設定同步給次要機。在實體層（連線燈號）算好之後、介面拿位址之前呼叫。
 * fresh(d, i)：替新的介面產生一份 i.rt
 */
export function prepHa(state, fresh) {
  const down = state.down || {}, off = state.rt.off || {};
  const fgs = Object.values(state.devices).filter((d) => d.kind === 'firewall' && haOn(d) && !down[d.id] && !off[d.id]);
  const mem = (state.dyn.ha ||= {});
  const done = new Set();
  for (const d of fgs) d.rt.ha = { role: 'standalone', peer: null, why: '', alone: true };
  for (const a of fgs) {
    if (done.has(a.id)) continue;
    const hbs = (a.ha.hbdev || []).map((n) => hbPeer(state, a, n)).filter(Boolean);
    let why = '', b = null;
    if (!(a.ha.hbdev || []).length) why = '沒有設定 heartbeat 介面 (hbdev)';
    else if (!hbs.length) why = `heartbeat 介面（${a.ha.hbdev.join('、')}）沒有連線`;
    else {
      const h = hbs.find((x) => x.dev.kind === 'firewall') || hbs[0];
      const p = h.dev;
      if (p.kind !== 'firewall') why = `heartbeat 介面接到的是 ${p.name}，不是另一台 FortiGate（這個模擬的 heartbeat 要兩台直接對接）`;
      else if (!haOn(p)) why = `heartbeat 線另一端的 ${p.name} 沒有啟用 HA（mode 還是 standalone）`;
      else if (!fgs.includes(p)) why = `${p.name} 沒有開機`;
      else if (!h.iface || !(p.ha.hbdev || []).includes(h.iface.id)) why = `heartbeat 線接到 ${p.name} 的 ${h.iface ? h.iface.label : '?'}，但那不是它的 heartbeat 介面`;
      else if (p.model !== a.model) why = `型號不同（${modelName(a)} 和 ${modelName(p)}）：HA 叢集要同一個型號`;
      else if ((a.fw && a.fw.ver) !== (p.fw && p.fw.ver) && a.fw && p.fw) why = `FortiOS 版本不同（${a.fw.ver} 和 ${p.fw.ver}）：要先升級成同一個版本`;
      else if (a.ha.group !== p.ha.group || +a.ha.gid !== +p.ha.gid) why = `群組名稱或群組 ID 不同（${a.ha.group || '(空白)'} / ${a.ha.gid} 和 ${p.ha.group || '(空白)'} / ${p.ha.gid}）：heartbeat 收得到，但不是同一個叢集`;
      else if ((a.ha.pass || '') !== (p.ha.pass || '')) why = 'HA 密碼不一樣：heartbeat 的驗證失敗，不會組成叢集';
      else b = p;
    }
    if (!b) {
      a.rt.ha.why = why;
      continue;
    }
    done.add(a.id); done.add(b.id);
    const [pri, by] = elect(state, a, b), sec = pri === a ? b : a;
    const before = mem[pri.id] && mem[pri.id].role;
    // 次要機變成主要機：接手（主要機的監控介面斷了、或重新選舉）
    if (before === 'secondary' && (mem[sec.id] || {}).role === 'primary') takeOver(state, pri, sec, by === 'monitor' ? `${sec.name} 監控的介面斷線（${(sec.ha.monitor || []).filter((n) => !haIfUp(state, sec, n)).join('、')}）` : by === 'priority' ? `priority 比較高（override enable 會搶回主要機）` : '重新選舉');
    const formed = !(mem[pri.id] && mem[pri.id].peer === sec.id && mem[sec.id] && mem[sec.id].peer === pri.id);
    if (formed && !state.dyn.boot) for (const d of [pri, sec]) evt(state, d, 'notice', `HA 叢集 ${pri.ha.group} 組成：${pri.name} 是主要機、${sec.name} 是次要機，設定由主要機同步`);
    syncConfig(pri, sec, fresh);
    mem[pri.id] = { ...(mem[pri.id] || {}), role: 'primary', peer: sec.id, since: before === 'primary' ? mem[pri.id].since : state.clock };
    mem[sec.id] = { ...(mem[sec.id] || {}), role: 'secondary', peer: pri.id, since: (mem[sec.id] || {}).role === 'secondary' ? mem[sec.id].since : state.clock };
    pri.rt.ha = { role: 'primary', peer: sec.id, by, why: '', alone: false };
    sec.rt.ha = { role: 'secondary', peer: pri.id, by, why: '', alone: false };
  }
  // 沒有組成叢集、但原本是次要機：對方不見了（關機、heartbeat 斷了），自己當主要機
  for (const d of fgs) {
    if (d.rt.ha.role !== 'standalone') continue;
    const m = mem[d.id];
    if (m && m.role === 'secondary') {
      const from = state.devices[m.peer];
      takeOver(state, d, from, from && (down[from.id] || off[from.id]) ? `${from.name} 沒有回應（關機或故障）` : `heartbeat 斷了，收不到 ${from ? from.name : '對方'} 的訊號`);
    }
    if (m && m.peer) { d.rt.ha.role = 'primary'; d.rt.ha.peer = m.peer; d.rt.ha.lost = true; }
    mem[d.id] = { ...(m || {}), role: m && m.peer ? 'primary' : 'standalone', since: m && m.role === 'primary' ? m.since : state.clock };
  }
}

/** 主要機的介面用虛擬 MAC（介面拿位址之後呼叫） */
export function haMacs(state) {
  for (const d of Object.values(state.devices)) {
    if (!d.rt || !d.rt.ha || d.rt.ha.role !== 'primary' || d.rt.ha.lost) continue;
    d.ifaces.forEach((i, n) => { if (!isHb(d, i) && i.rt) i.rt.mac = haVmac(+d.ha.gid || 0, n); });
  }
}

/** 剛接手的主要機：連線表裡沒有的連線被丟掉時，說明原因 */
export function haLostNote(state, d) {
  const m = (state.dyn.ha || {})[d.id];
  if (!m || m.took == null || !d.rt.ha || d.rt.ha.role !== 'primary' || d.ha.pickup) return '';
  const from = state.devices[m.from];
  return `${d.name} 剛接手成為 HA 的主要機，連線表裡沒有這條連線：沒有開 session-pickup，${from ? from.name : '原本的主要機'}上進行中的連線沒有同步過來，要重新連線`;
}

/** get system ha status */
export function haStatusLines(state, d) {
  if (!haOn(d)) return ['HA Health Status: OK', `Model: FortiGate-${modelName(d)}`, 'Mode: standalone'];
  const r = d.rt.ha || { role: 'standalone' }, peer = r.peer && state.devices[r.peer];
  const both = peer && !r.lost && r.role !== 'standalone' ? [d, peer] : [d];
  const pri = r.role === 'primary' ? d : r.role === 'secondary' ? peer : d;
  const m = (state.dyn.ha || {})[pri.id] || {};
  const up = Math.max(0, Math.floor(state.clock - (m.since || 0)));
  const dur = `${Math.floor(up / 86400)} days ${Math.floor((up % 86400) / 3600)}:${String(Math.floor((up % 3600) / 60)).padStart(2, '0')}:${String(up % 60).padStart(2, '0')}`;
  const byText = { monitor: 'it has the largest value of monitored interfaces', uptime: 'it has the largest value of uptime', priority: 'it has the largest value of override priority', serial: 'it has the largest value of serialno' };
  const o = [`HA Health Status: ${both.length === 2 ? 'OK' : `ERROR（${r.why || (r.lost ? '收不到對方的 heartbeat' : '沒有組成叢集')}）`}`, `Model: FortiGate-${modelName(d)}`, 'Mode: HA A-P', `Group Name: ${d.ha.group}`, `Group ID: ${d.ha.gid}`, 'Debug: 0',
    `Cluster Uptime: ${dur}`];
  if (both.length === 2) o.push('Primary selected using:', `    vcluster-1: ${serialOf(pri)} is selected as the primary because ${byText[r.by] || byText.serial}.`);
  o.push(`ses_pickup: ${d.ha.pickup ? 'enable' : 'disable'}, ses_pickup_delay=disable`, `override: ${d.ha.override ? 'enable' : 'disable'}`);
  if (both.length === 2) {
    const sec = both.find((x) => x !== pri);
    o.push('Configuration Status:', `    ${serialOf(pri)}(updated 1 seconds ago): in-sync`, `    ${serialOf(sec)}(updated 2 seconds ago): in-sync`,
      `Primary     : ${pri.name.padEnd(16)}, ${serialOf(pri)}, HA cluster index = 0`, `Secondary   : ${sec.name.padEnd(16)}, ${serialOf(sec)}, HA cluster index = 1`,
      'number of vcluster: 1', 'vcluster 1: work 169.254.0.1', `Primary: ${serialOf(pri)}, HA operating index = 0`, `Secondary: ${serialOf(sec)}, HA operating index = 1`);
  } else o.push(`Primary     : ${d.name.padEnd(16)}, ${serialOf(d)}, HA cluster index = 0`, 'number of vcluster: 1', `vcluster 1: work 169.254.0.1`, `Primary: ${serialOf(d)}, HA operating index = 0`);
  return o;
}
