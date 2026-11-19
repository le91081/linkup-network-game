// SNMP：網路設備上的代理 (agent)、網管伺服器 (NMS) 的輪詢、設備主動送出的 Trap
//
// 設備（mgmt）：snmp 'v2c' | 'v3' | 'off'、community、snmpAcl（只允許這個標準 ACL 的來源查詢）、
//               snmpUser { user, auth, priv }（v3，authPriv）、trapHosts [{ ip, ver, name }]、traps（開啟 Trap）、
//               location、contact；FortiGate 另外要 snmpAgent（config system snmp sysinfo 的 status enable）
// 網管伺服器：  d.nms = { targets: [{ ip, ver, community, user, auth, priv }] }，services 裡有 UDP 162（接收 Trap）
// 結果：        state.dyn.nms[伺服器][目標 IP] = { ok, why, t, sys, ifs, hist }，以及 state.dyn.nms[伺服器].traps
import { transact } from './sim.js';
import { counters } from './wire.js';
import { linkInfo } from './model.js';
import { parseIp, parseCidr, netOf, fmtIp } from './ip.js';
import { uptimeOf } from './ops.js';
import { isIos } from './ios.js';

export const POLL = 60; // 網管伺服器每 60 秒輪詢一次
const HIST = 30;

/** 這台設備的 SNMP 代理有沒有在 UDP 161 上聽 */
export function agentOn(d) {
  const m = d.mgmt;
  if (!m) return false;
  if (d.kind === 'firewall') return !!m.snmpAgent && (m.snmp === 'v2c' || m.snmp === 'v3');
  return m.snmp === 'v2c' || m.snmp === 'v3';
}

const inList = (list, ip) => list.some((s) => {
  const c = parseCidr(String(s).includes('/') ? s : s + '/32');
  return c && netOf(ip, c.bits) === c.net;
});

/**
 * 收到一個查詢之後，代理要不要回答。回傳 null 代表回答，否則回傳原因。
 * v1 / v2c 的 community 不對、來源不在允許的清單裡：設備什麼都不回（對方只會等到逾時）
 */
export function authorize(state, d, req, src) {
  const m = d.mgmt;
  if (req.ver === 'v3') {
    if (m.snmp !== 'v3' || !m.snmpUser) return `${d.name} 沒有設定 SNMPv3 使用者（unknown user name）`;
    const u = m.snmpUser;
    if (req.user !== u.user) return `${d.name} 沒有 ${req.user} 這個 SNMPv3 使用者（usmStatsUnknownUserNames）`;
    if (req.auth !== u.auth) return `SNMPv3 的認證密碼不對（usmStatsWrongDigests）`;
    if (req.priv !== u.priv) return 'SNMPv3 的加密密碼不對：回應解不開（decryption error）';
    return null;
  }
  if (m.snmp !== 'v2c') return `${d.name} 的 SNMP 是 ${m.snmp === 'v3' ? 'v3（不接受 v2c 的 community）' : '關閉的'}，沒有回應`;
  if (req.community !== (m.community || '')) {
    const bad = (state.dyn.snmpBad ||= {});
    bad[d.id] = (bad[d.id] || 0) + 1;
    queueTrap(state, d, 'authenticationFailure', {});
    return `community「${req.community}」不對，${d.name} 直接丟掉這個查詢（沒有回應，只會等到逾時）`;
  }
  if (d.kind === 'firewall' && (m.snmpHosts || []).length && !inList(m.snmpHosts, src)) return `來源 ${fmtIp(src)} 不在 FortiGate 的 SNMP hosts 清單裡`;
  if (m.snmpAcl && !aclPermits(d, m.snmpAcl, src)) return `來源 ${fmtIp(src)} 不在 community 綁定的 ACL「${m.snmpAcl}」允許的範圍裡`;
  return null;
}

/** 標準 ACL（具名的或編號的）有沒有放行這個來源；找不到這個 ACL 就全部拒絕 */
function aclPermits(d, name, ip) {
  const std = (d.stdAcls || {})[name];
  if (std) return inList(std, ip);
  for (const r of (d.aclDefs || {})[name] || []) {
    const s = String(r.src || 'any');
    if (s === 'any' || inList([s], ip)) return r.action === 'permit';
  }
  return false;
}

/** 代理回答的內容：系統資訊與每個介面的計數器（64 位元的 ifHCInOctets / ifHCOutOctets） */
function walk(state, d) {
  const ifs = {};
  for (const p of d.ports) {
    const up = !!state.rt.links[d.id + ':' + p.id];
    const li = up && linkInfo(state, d.id, p.id), c = counters(state, d.id, p.id);
    ifs[p.id] = { name: p.label, up, speed: li ? li.speed : 0, duplex: li ? li.duplex : '', in: c.ib, out: c.ob, inErr: c.crc + c.runts, outErr: c.late };
  }
  return { sys: { name: d.name, uptime: uptimeOf(state, d), descr: `${d.model} ${d.fw ? d.fw.ver : ''}`.trim(), location: d.mgmt.location || '', contact: d.mgmt.contact || '' }, ifs };
}

/** 網管伺服器輪詢一台設備；回傳這一次的結果（網管裡的紀錄之後還會被下一次輪詢更新） */
export function pollOne(state, nms, t) {
  const ip = parseIp(t.ip || '');
  const store = ((state.dyn.nms ||= {})[nms.id] ||= { targets: {}, traps: [] });
  const rec = (store.targets[t.ip] ||= { hist: {} });
  rec.t = state.clock;
  if (ip == null) { Object.assign(rec, { ok: false, why: 'IP 位址不正確' }); return { ...rec }; }
  const req = t.ver === 'v3' ? { ver: 'v3', user: t.user || '', auth: t.auth || '', priv: t.priv || '' } : { ver: 'v2c', community: t.community || '' };
  const res = transact(state, nms.id, { proto: 'udp', dst: ip, dport: 161, data: { snmp: req } });
  if (!res.ok) { Object.assign(rec, { ok: false, why: res.reason }); return { ...rec }; }
  const d = state.devices[res.responder];
  const why = authorize(state, d, req, res.seenSrc ?? res.srcIp);
  if (why) { Object.assign(rec, { ok: false, why, dev: d.id }); return { ...rec }; }
  const now = walk(state, d), prev = rec.raw, dt = prev ? state.clock - prev.t : 0;
  // 使用率 = 這段時間多出來的位元組 × 8 ÷ (時間 × 速率)
  for (const [pid, x] of Object.entries(now.ifs)) {
    const p = prev && prev.ifs[pid];
    x.util = p && dt > 0 && x.speed ? { in: Math.min(100, ((x.in - p.in) * 8 * 100) / (dt * x.speed * 1e6)), out: Math.min(100, ((x.out - p.out) * 8 * 100) / (dt * x.speed * 1e6)) } : null;
    x.errD = p && dt > 0 ? x.inErr - p.inErr + (x.outErr - p.outErr) : 0;
    if (x.util) { const h = (rec.hist[pid] ||= []); h.push({ t: state.clock, in: x.util.in, out: x.util.out }); if (h.length > HIST) h.shift(); }
  }
  Object.assign(rec, { ok: true, why: '', dev: d.id, sys: now.sys, ifs: now.ifs, raw: { t: state.clock, ifs: now.ifs } });
  return { ...rec };
}

/** 每次重新計算之後：到了輪詢的時間就把每一個目標問一次 */
export function nmsTick(state) {
  const down = state.down || {}, booting = state.rt.booting || {};
  for (const d of Object.values(state.devices)) {
    if (!d.nms || down[d.id] || state.rt.off[d.id] || booting[d.id] > 0) continue;
    const store = ((state.dyn.nms ||= {})[d.id] ||= { targets: {}, traps: [] });
    if (store.last != null && state.clock - store.last < POLL) continue;
    store.last = state.clock;
    for (const t of d.nms.targets || []) if (t.ip) pollOne(state, d, t);
    for (const k of Object.keys(store.targets)) if (!(d.nms.targets || []).some((t) => t.ip === k)) delete store.targets[k];
  }
}

// ───────────────────────── Trap ─────────────────────────

/** 設備發生事件（介面斷線、重新開機、community 錯誤）時，送給設定好的 Trap 接收端 */
export function queueTrap(state, d, kind, info) {
  const m = d.mgmt;
  if (!m || !agentOn(d) || !state.dyn) return;
  const hosts = d.kind === 'firewall' ? (m.snmpHosts || []).map((h) => ({ ip: h.split('/')[0], ver: m.snmp, name: m.snmp === 'v3' ? (m.snmpUser || {}).user : m.community })) : m.traps ? m.trapHosts || [] : [];
  for (const h of hosts) (state.dyn.trapbox ||= []).push({ dev: d.id, ip: h.ip, ver: h.ver || 'v2c', name: h.name || '', kind, info, t: state.clock });
}

/** 把排隊的 Trap 送出去（UDP 162，沒有確認，送不到就掉了） */
export function flushTraps(state) {
  const box = state.dyn.trapbox;
  if (!box || !box.length) return;
  state.dyn.trapbox = [];
  for (const x of box) {
    const d = state.devices[x.dev], ip = parseIp(x.ip || '');
    if (!d || ip == null) continue;
    const r = transact(state, x.dev, { proto: 'udp', dst: ip, dport: 162, quiet: true, data: { snmp: { ver: x.ver, community: x.name, user: x.name, trap: x.kind } } });
    if (!r.ok) continue;
    const recv = state.devices[r.responder];
    if (!recv || !recv.nms) continue;
    const store = ((state.dyn.nms ||= {})[recv.id] ||= { targets: {}, traps: [] });
    store.traps.push({ t: state.clock, from: fmtIp(r.seenSrc ?? r.srcIp), dev: d.id, kind: x.kind, info: x.info, ver: x.ver });
    if (store.traps.length > 100) store.traps.shift();
  }
}

/** show snmp 的統計 */
export const snmpStats = (state, d) => ({ bad: ((state.dyn && state.dyn.snmpBad) || {})[d.id] || 0 });
export const nmsOf = (state, id) => ((state.dyn && state.dyn.nms) || {})[id] || { targets: {}, traps: [] };
void isIos;
