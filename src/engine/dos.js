// DoS：洪水攻擊（SYN flood）與 FortiGate 的 DoS 政策（config firewall DoS-policy）
//
// 攻擊：state.attacks = [{ id, from: 設備 id, ip: 目的位址, port, kind: 'syn', pps, on, label }]
//   由關卡放進來。每次重新計算時看它「打不打得到」：照一般的轉送規則送一個 SYN 過去（不留紀錄），
//   被政策或 ACL 擋下就打不到；打得到的話，看路上每一台 FortiGate 進來的那個介面有沒有 DoS 政策把它丟掉。
//   沒有被丟掉：目的主機那個埠的半開連線佇列被塞滿，新的 TCP 連線排不進去（sim/forward.js 的 deliver 會擋）。
// DoS 政策：d.dos = [{ id, name, iface, on, anomaly: { tcp_syn_flood: { on, action: 'pass' | 'block', threshold } } }]
//   threshold：每秒送往同一個目的位址的封包數。超過之後 action 是 pass 只記錄（FortiOS 的預設值），block 才丟掉。
// 結果：state.rt.dos = { list: [攻擊的狀況], hit: { '主機 id|埠': 攻擊 } }
import { parseIp } from './ip.js';

/** 這個模擬認得的異常種類：[FortiOS 的名稱, 中文, 預設門檻（每秒封包數）] */
export const ANOMALIES = [
  ['tcp_syn_flood', 'SYN flood（大量只送 SYN 的半開連線）', 2000],
  ['udp_flood', 'UDP flood', 2000],
  ['icmp_flood', 'ICMP flood', 250],
];
const KIND = { syn: 'tcp_syn_flood', udp: 'udp_flood', icmp: 'icmp_flood' };
const DEFAULT = Object.fromEntries(ANOMALIES.map(([k, , th]) => [k, th]));
/** TCP 半開連線在防火牆的連線表裡留多久（FortiOS 的 tcp-halfopen-timer） */
export const HALFOPEN = 10;
/** 連線表的容量（筆） */
export const SESSION_MAX = { fg60f: 700000, fg100f: 1500000 };

export const anomalyOf = (pol, name) => ({ on: false, action: 'pass', threshold: DEFAULT[name], ...((pol.anomaly || {})[name] || {}) });
export const newDosPolicy = (d, iface) => ({ id: Math.max(0, ...(d.dos || []).map((p) => +p.id || 0)) + 1, name: '', iface, on: true, anomaly: {} });
export const fmtCount = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtN = fmtCount;

/**
 * 算出每一個攻擊現在的狀況。probe(from, spec) 是一次不留紀錄的 transact。
 * 回傳 { list, hit }；list 的每一筆：
 *   { id, label, kind, anomaly, ip, port, pps, reach, why, victim, cables, seen: [{ dev, iface, policy, on, action, threshold, over, drop }], stop }
 */
export function computeDos(state, probe) {
  const out = { list: [], hit: {} };
  for (const a of state.attacks || []) {
    if (!a || a.on === false || a.cp || !state.devices[a.from]) continue; // cp：打設備自己的洪水，在 copp.js 處理
    const dst = parseIp(a.ip || ''), anomaly = KIND[a.kind || 'syn'] || 'tcp_syn_flood';
    if (dst == null) continue;
    const r = probe(a.from, { proto: 'tcp', dst, dport: a.port, quiet: true, flood: true });
    const e = { id: a.id, label: a.label || '', kind: a.kind || 'syn', anomaly, ip: a.ip, port: a.port, pps: +a.pps || 0, reach: !!r.ok, why: r.ok ? '' : r.reason || '', victim: null, cables: [], seen: [], stop: null };
    // 路上的每一台 FortiGate：進來的那個介面有沒有 DoS 政策
    const reqHops = (r.hops || []).filter((h) => h.cable && !h.reply && !h.wave);
    for (const hop of r.l3 || []) {
      const d = state.devices[hop.dev];
      if (!d || d.kind !== 'firewall') continue;
      const inIf = d.ifaces.find((i) => i.rt && i.rt.ip === hop.ip);
      const pols = (d.dos || []).filter((p) => p.on !== false && inIf && p.iface === inIf.id);
      if (!pols.length) { e.seen.push({ dev: d.id, iface: inIf ? inIf.id : '', policy: null }); continue; }
      for (const p of pols) {
        const an = anomalyOf(p, anomaly), over = an.on && e.pps > +an.threshold, drop = over && an.action === 'block';
        e.seen.push({ dev: d.id, iface: inIf.id, policy: p.id, on: an.on, action: an.action, threshold: +an.threshold, over, drop });
        if (drop && !e.stop) e.stop = { dev: d.id, policy: p.id };
      }
      if (e.stop) break;
    }
    // 攻擊流量走過的線：被某台防火牆丟掉的話，只畫到那一台為止
    for (const h of reqHops) { if (!e.cables.includes(h.cable)) e.cables.push(h.cable); if (e.stop && h.to === e.stop.dev) break; }
    if (!r.ok && r.failDev) { const n = reqHops.findIndex((h) => h.to === r.failDev); if (n >= 0) e.cables = [...new Set(reqHops.slice(0, n + 1).map((h) => h.cable))]; }
    if (e.reach && !e.stop && r.responder && e.kind === 'syn') { e.victim = r.responder; out.hit[r.responder + '|' + a.port] = e; }
    out.list.push(e);
  }
  return out;
}

/** 這個封包要交給的服務是不是正在被 SYN flood 塞滿（新的連線排不進去）。回傳原因或 null */
export function floodedWhy(state, dev, pkt) {
  if (pkt.proto !== 'tcp' || pkt.reply || pkt.ack || pkt.flood) return null;
  const e = state.rt && state.rt.dos && state.rt.dos.hit[dev.id + '|' + pkt.dport];
  if (!e) return null;
  return `${dev.name} 的 TCP ${pkt.dport} 正被 SYN flood 塞滿：每秒 ${fmtN(e.pps)} 個只送 SYN、不完成交握的連線佔住了半開連線的佇列，新的連線排不進去（等到逾時）`;
}

/** 防火牆上：經過它的攻擊在連線表裡佔了幾筆半開連線 */
export function floodSessions(state, d) {
  let n = 0;
  for (const e of ((state.rt && state.rt.dos) || { list: [] }).list) {
    if (!e.reach || e.kind !== 'syn') continue;
    const mine = e.seen.filter((x) => x.dev === d.id);
    if (!mine.length || mine.some((x) => x.drop)) continue;
    n += e.pps * HALFOPEN;
  }
  return Math.min(n, SESSION_MAX[d.model] || 700000);
}

/** 異常紀錄：狀況改變的時候各記一筆（log(dev, 嚴重程度, FortiGate 格式的內容)） */
export function dosLog(state, log) {
  const seen = (state.dyn.dosSeen ||= {}), now = {};
  for (const e of ((state.rt && state.rt.dos) || { list: [] }).list) {
    for (const x of e.seen) {
      if (!x.policy || !x.over) continue;
      const k = `${x.dev}|${e.id}|${x.policy}`, sig = x.action;
      now[k] = sig;
      if (seen[k] === sig) continue;
      const d = state.devices[x.dev], from = state.devices[(state.attacks.find((a) => a.id === e.id) || {}).from];
      log(d, 1, `logid="0720018432" type="utm" subtype="anomaly" eventtype="anomaly" level="alert" vd="root" severity="critical" srcintf="${x.iface}" dstip=${e.ip} dstport=${e.port} policyid=${x.policy} policytype="DoS-policy" attack="${e.anomaly}" action="${x.drop ? 'clear_session' : 'detected'}" count=${e.pps} msg="anomaly: ${e.anomaly}, ${e.pps} > threshold ${x.threshold}${x.drop ? ', repeats, dropped' : ''}"${from ? ` srcname="${from.name}"` : ''}`);
    }
  }
  state.dyn.dosSeen = now;
}

// ── FortiOS：config firewall DoS-policy ──
export function dosConfigLines(d) {
  const o = [];
  if (!(d.dos || []).length) return o;
  o.push('config firewall DoS-policy');
  for (const p of d.dos) {
    o.push(`    edit ${p.id}`);
    if (p.name) o.push(`        set name "${p.name}"`);
    if (p.on === false) o.push('        set status disable');
    o.push(`        set interface "${p.iface}"`, '        set srcaddr "all"', '        set dstaddr "all"', '        set service "ALL"');
    const used = ANOMALIES.filter(([k]) => (p.anomaly || {})[k]);
    if (used.length) {
      o.push('        config anomaly');
      for (const [k] of used) {
        const a = anomalyOf(p, k);
        o.push(`            edit "${k}"`);
        if (a.on) o.push('                set status enable', '                set log enable');
        if (a.action !== 'pass') o.push(`                set action ${a.action}`);
        o.push(`                set threshold ${a.threshold}`, '            next');
      }
      o.push('        end');
    }
    o.push('    next');
  }
  o.push('end');
  return o;
}

/** 套用 config firewall DoS-policy 的內容（整段收下來，最後的 end 才套用）。回傳錯誤訊息或 null */
export function applyDosCli(d, lines) {
  const all = JSON.parse(JSON.stringify(d.dos || []));
  const tok = (l) => (l.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, ''));
  let cur = null, an = null, inAn = false;
  for (const l of lines) {
    const t = tok(l), w = (t[0] || '').toLowerCase();
    if (!inAn && w === 'edit') {
      const id = +t[1];
      if (!(id >= 0)) return `value parse error before '${t[1] || ''}'（DoS 政策的編號是數字）`;
      cur = all.find((p) => +p.id === id);
      if (!cur) { cur = { id: id || Math.max(0, ...all.map((p) => +p.id || 0)) + 1, name: '', iface: '', on: true, anomaly: {} }; all.push(cur); }
      continue;
    }
    if (!inAn && w === 'delete') { const n = all.findIndex((p) => +p.id === +t[1]); if (n < 0) return `entry not found in datasource（沒有編號 ${t[1]} 的 DoS 政策）`; all.splice(n, 1); continue; }
    if (!cur) return `command parse error before '${t[0]}'`;
    if (w === 'config') { if ((t[1] || '').toLowerCase() !== 'anomaly') return `command parse error before '${t[1] || ''}'`; inAn = true; continue; }
    if (w === 'end') { if (inAn) { inAn = false; an = null; } continue; }
    if (inAn) {
      if (w === 'edit') {
        if (!(t[1] in DEFAULT)) return `value parse error before '${t[1] || ''}'（這個模擬認得的異常：${ANOMALIES.map((x) => x[0]).join('、')}）`;
        an = (cur.anomaly[t[1]] ||= { on: false, action: 'pass', threshold: DEFAULT[t[1]] });
        continue;
      }
      if (w === 'next') { an = null; continue; }
      if (!an) return `command parse error before '${t[0]}'`;
      if (w === 'set' && t[1] === 'status') { if (!['enable', 'disable'].includes(t[2])) return `value parse error before '${t[2] || ''}'`; an.on = t[2] === 'enable'; continue; }
      if (w === 'set' && t[1] === 'action') { if (!['pass', 'block', 'proxy'].includes(t[2])) return `value parse error before '${t[2] || ''}'（action：pass 只記錄、block 丟掉）`; an.action = t[2] === 'proxy' ? 'block' : t[2]; continue; }
      if (w === 'set' && t[1] === 'threshold') { if (!/^\d+$/.test(t[2] || '') || +t[2] < 1) return `value parse error before '${t[2] || ''}'（threshold：每秒的封包數，1 以上）`; an.threshold = +t[2]; continue; }
      if (w === 'unset' && t[1] === 'action') { an.action = 'pass'; continue; }
      continue; // set log enable、quarantine…：收下，不影響模擬
    }
    if (w === 'next') { cur = null; continue; }
    if (w === 'set' && t[1] === 'interface') {
      if (!d.ifaces.some((i) => i.id === t[2])) return `entry not found in datasource（沒有介面 ${t[2] || ''}）`;
      cur.iface = t[2]; continue;
    }
    if (w === 'set' && t[1] === 'name') { cur.name = t.slice(2).join(' '); continue; }
    if (w === 'set' && t[1] === 'status') { if (!['enable', 'disable'].includes(t[2])) return `value parse error before '${t[2] || ''}'`; cur.on = t[2] === 'enable'; continue; }
  }
  const bad = all.find((p) => !p.iface);
  if (bad) return `DoS 政策 ${bad.id} 沒有 set interface：一定要指定它保護哪一個介面進來的流量`;
  if (all.length) d.dos = all; else delete d.dos;
  return null;
}

/** diagnose ips anomaly list：每一條 DoS 政策目前量到的速率 */
export function diagAnomaly(state, d) {
  const out = ['list nids meter:'];
  const list = ((state.rt && state.rt.dos) || { list: [] }).list;
  for (const p of d.dos || []) {
    for (const [k] of ANOMALIES) {
      const a = anomalyOf(p, k);
      if (!a.on) continue;
      const e = list.find((x) => x.anomaly === k && x.seen.some((s) => s.dev === d.id && s.policy === p.id));
      out.push(`id=${k.padEnd(16)} ip=${e ? e.ip : '0.0.0.0'} dos_id=${p.id} exp=${e ? 1 : 0} pps=${e ? e.pps : 0} freq=${e ? e.pps : 0} threshold=${a.threshold} action=${a.action}`);
    }
  }
  if (out.length === 1) out.push('（沒有啟用任何異常偵測：config firewall DoS-policy → config anomaly → set status enable）');
  return out;
}

