// 網路模擬引擎
// L1 供電 / 連線狀態、L2 橋接 / VLAN / STP / LACP / Port Security / DHCP Snooping / Wi-Fi、
// L3 路由 / OSPF / VRRP、DHCP（含 Relay）、PPPoE、NAT、ACL、防火牆政策、IPsec 與遠端存取 VPN、DNS
import { parseIp, fmtIp, parseMask, netOf, sameNet, isPrivate, parseCidr, parseVlanList, hostAddrProblem } from './ip.js';
import { cloneState, primaryIface, CATALOG, CABLES, cableKind, cableDist, linkInfo } from './model.js';
import { recompute6, transact6, globalIp6 } from './sim6.js';
import { parseIp6 } from './ip6.js';
import { opsBefore, opsAfter, logEvent, debugLog, longIf, UPTIME0 } from './ops.js';
import { onHop, BCAST, spanDest, background, flowTraceStart, debugOf, countBytes } from './wire.js';
import { agentOn } from './snmp.js';

const DROP = Symbol('drop');
const isVlanSw = (d) => !!d.sw && d.sw.mode === 'vlan';

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 每個介面固定的 MAC 位址（由設備 id 推導，重開遊戲也不會變） */
export function macOf(devId, key) {
  const a = hash(devId + '/' + key), b = hash(key + '#' + devId);
  return [0x02, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255].map((x) => x.toString(16).padStart(2, '0')).join(':');
}
export function ifaceMac(dev, i) {
  const b = i.bind;
  return macOf(dev.id, b.t === 'port' || b.t === 'sub' ? b.port : b.t === 'wlan' ? 'wlan' : 'br');
}

const cidrList = (s) => String(s || '').split(/[,\s]+/).map(parseCidr).filter(Boolean);
const selMatch = (list, ip) => list.some((c) => netOf(ip, c.bits) === c.net);
const dnsList = (s) => String(s || '').split(/[,\s]+/).map(parseIp).filter((x) => x != null);
const macList = (s) => String(s || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
function cmp(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// ───────────────────────────── L2 ─────────────────────────────

export const isBridgePort = (dev, pid) => !!(dev.sw && dev.sw.ports[pid] && dev.sw.ports[pid].mode !== 'routed');

export function ifaceActive(dev, i) {
  const b = i.bind;
  if (b.t === 'port' || b.t === 'sub') return dev.ports.some((p) => p.id === b.port) && !isBridgePort(dev, b.port);
  if (b.t === 'svi') return isVlanSw(dev) && dev.sw.vlans.some((v) => v.id === b.vlan);
  return true;
}

function vlanAllowed(pc, v) {
  const l = parseVlanList(pc.allowed);
  return l == null || l.includes(v);
}
const vlanExists = (dev, v) => dev.sw.vlans.some((x) => x.id === v);
const psAllowed = (pc, mac) => macList(pc.ps.macs).includes(mac);

function portUsable(d, pid) {
  if (d.sw.ports[pid].shut || (d.rt.err && d.rt.err[pid])) return false;
  if (d.sw.span && spanDest(d, pid)) return false; // SPAN 的目的埠只送出鏡像的訊框，不轉送一般流量
  if (d.rt.wait && d.rt.wait[pid] > 0) return false; // 還在 STP 的 listening / learning，不轉送資料
  if (d.rt.unauth && d.rt.unauth[pid]) return false; // 802.1X 尚未通過驗證
  const l = d.rt.lag && d.rt.lag[pid];
  return !l || (l.state === 'bundled' && l.carrier);
}
const stpBlocked = (d, pid, v) => !!(d.rt.stp && d.rt.stp.blocked.has(pid + '|' + v));

/** 訊框從某埠進入交換器 → 回傳內部 VLAN 鍵值，或 DROP */
function ingressKey(dev, pid, tag, mac, notes) {
  const sw = dev.sw, pc = sw.ports[pid];
  if (dev.rt.unauth && dev.rt.unauth[pid]) { notes.dot1x = `${dev.name} 的 ${pid}：${dev.rt.unauth[pid]}`; return DROP; }
  if (dev.rt.wait && dev.rt.wait[pid] > 0) { notes.stp ||= { dev: dev.id, pid, left: dev.rt.wait[pid] }; return DROP; }
  if (sw.span && spanDest(dev, pid)) { notes.span ||= { dev: dev.id, pid }; return DROP; }
  if (!portUsable(dev, pid)) return DROP;
  if (sw.mode !== 'vlan') return tag == null ? 'u' : tag;
  if (pc.ps && pc.ps.on && mac && !psAllowed(pc, mac)) { notes.ps = `${dev.name} 的 ${pid}`; return DROP; }
  let v;
  if (pc.mode === 'trunk') {
    v = tag == null ? pc.native : tag;
    if (!vlanAllowed(pc, v)) return DROP;
  } else {
    if (tag != null) return DROP;
    v = pc.vlan;
  }
  if (!vlanExists(dev, v) || stpBlocked(dev, pid, v)) return DROP;
  return v;
}

/** 內部 VLAN 的訊框要從某埠送出 → 回傳線上的 tag（null = untagged），或 DROP */
function egressTag(dev, pid, key) {
  const sw = dev.sw, pc = sw.ports[pid];
  if (!portUsable(dev, pid)) return DROP;
  if (sw.mode !== 'vlan') return key === 'u' ? null : key;
  if (stpBlocked(dev, pid, key)) return DROP;
  if (pc.mode === 'trunk') {
    if (!vlanAllowed(pc, key)) return DROP;
    return key === pc.native ? null : key;
  }
  return pc.vlan === key ? null : DROP;
}

const wifiHop = (from, to) => ({ wifi: true, cable: null, from, to, fromPort: null, toPort: null, tag: null });

/**
 * 從某個 L3 介面出發，找出同一個廣播網域內所有可到達的 L3 介面。
 * 回傳陣列 [{ dev, iface, path }]；另外帶有 .storm（偵測到迴圈）與 .ps（被 Port Security 擋下）兩個屬性。
 */
export function l2Explore(state, devId, iface) {
  const rt = state.rt, links = rt.links;
  const out = [];
  const seen = new Set();
  const queue = [];
  const dev = state.devices[devId];
  if (!ifaceActive(dev, iface) || rt.off[devId] || (state.down || {})[devId]) return out;
  const mac = iface.rt && iface.rt.mac;

  const emit = (d, pid, tag, path) => {
    const l = links[d.id + ':' + pid];
    if (l) queue.push({ from: d.id, fromPort: pid, to: l.dev, toPort: l.port, cable: l.cable, tag, path });
  };
  const flood = (d, key, exceptPort, path, viaWifi) => {
    const k = d.id + '|' + key;
    if (seen.has(k)) { out.storm = d.id; return; } // 同一個網段被走到第二次 = 有迴圈
    seen.add(k);
    for (const i of d.ifaces) {
      if (i === iface) continue;
      if ((i.bind.t === 'svi' && d.sw.mode === 'vlan' && i.bind.vlan === key) || (i.bind.t === 'bridge' && key === 'u')) {
        out.push({ dev: d.id, iface: i, path });
      }
    }
    for (const c of rt.clients[d.id] || []) {
      if (c.key !== key || c.iface === iface) continue;
      if (viaWifi && (viaWifi.isolate || c.isolate)) continue; // 用戶端隔離
      out.push({ dev: c.dev, iface: c.iface, path: [...path, wifiHop(d.id, c.dev)] });
    }
    for (const pid of Object.keys(d.sw.ports)) {
      if (pid === exceptPort || !isBridgePort(d, pid)) continue;
      if (d.rt.wait && d.rt.wait[pid] > 0 && links[d.id + ':' + pid]) { out.stp ||= { dev: d.id, pid, left: d.rt.wait[pid] }; continue; }
      const t = egressTag(d, pid, key);
      if (t !== DROP) emit(d, pid, t, path);
    }
  };

  const b = iface.bind;
  if (b.t === 'port') emit(dev, b.port, null, []);
  else if (b.t === 'sub') emit(dev, b.port, b.vlan, []);
  else if (b.t === 'svi') flood(dev, b.vlan, null, []);
  else if (b.t === 'bridge') flood(dev, 'u', null, []);
  else if (b.t === 'wlan') {
    const a = iface.rt.assoc;
    if (a) flood(state.devices[a.ap], a.key, null, [wifiHop(devId, a.ap)], a);
  }

  while (queue.length) {
    const q = queue.shift();
    const d = state.devices[q.to];
    const path = [...q.path, { cable: q.cable, from: q.from, fromPort: q.fromPort, to: q.to, toPort: q.toPort, tag: q.tag }];
    if (isBridgePort(d, q.toPort)) {
      const key = ingressKey(d, q.toPort, q.tag, mac, out);
      if (key !== DROP) flood(d, key, q.toPort, path);
    } else {
      const i = d.ifaces.find((x) =>
        q.tag == null
          ? x.bind.t === 'port' && x.bind.port === q.toPort
          : x.bind.t === 'sub' && x.bind.port === q.toPort && x.bind.vlan === q.tag,
      );
      if (i && i !== iface) out.push({ dev: d.id, iface: i, path });
    }
  }
  return out;
}

/** 某個交換器連接埠後面看得到的 MAC 位址（給 MAC 位址表與 Port Security 用） */
export function macsBehind(state, d, pid) {
  const res = [], seen = new Set([d.id]);
  const start = state.rt.links[d.id + ':' + pid];
  if (!start) return res;
  const q = [start];
  while (q.length) {
    const l = q.shift();
    const x = state.devices[l.dev];
    if (isBridgePort(x, l.port)) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      for (const i of x.ifaces) if ((i.bind.t === 'svi' || i.bind.t === 'bridge') && i.rt.ip != null) res.push({ mac: i.rt.mac, dev: x.id });
      for (const c of state.rt.clients[x.id] || []) res.push({ mac: c.iface.rt.mac, dev: c.dev });
      for (const p of Object.keys(x.sw.ports)) {
        if (p === l.port || !isBridgePort(x, p)) continue;
        const n = state.rt.links[x.id + ':' + p];
        if (n) q.push(n);
      }
    } else {
      const i = x.ifaces.find((y) => (y.bind.t === 'port' || y.bind.t === 'sub') && y.bind.port === l.port);
      if (i) res.push({ mac: i.rt.mac, dev: x.id });
    }
  }
  return res.filter((m, n) => res.findIndex((y) => y.mac === m.mac) === n);
}

// ── MAC 位址表 ──
// 交換器從收到的訊框學到「這個來源 MAC 在哪個埠」，一段時間沒有再看到就忘記。
// 表是空的並不代表不通：不認得的目的 MAC 會被送往整個 VLAN（泛洪），對方一回覆就學起來了。
export const MAC_AGE = 300;
export const macAgeOf = (d) => (d.sw && +d.sw.macAge > 0 ? +d.sw.macAge : MAC_AGE);
const learns = (d) => !!d && !!d.sw && d.sw.mode !== 'hub'; // Hub 不看位址，什麼都不學

function macLearn(state, d, key, mac, port) {
  if (!learns(d) || !mac) return;
  (state.dyn.mac[d.id] ||= {})[key + '|' + mac] = { port, t: state.clock };
}

function macKnown(state, d, key, mac) {
  const e = (state.dyn.mac[d.id] || {})[key + '|' + mac];
  return e && state.clock - e.t < macAgeOf(d) ? e : null;
}

/** 訊框沿著 path 走：路上每一台交換器都從進來的那個埠學到來源 MAC。回傳訊框在每一站的內部 VLAN */
function learnPath(state, path, mac) {
  const keys = [];
  for (const h of path) {
    const d = state.devices[h.to];
    let key = null;
    if (h.wifi) {
      // 無線用戶端 → 基地台：學在無線介面上
      const c = (state.rt.clients[h.to] || []).find((x) => x.dev === h.from);
      if (c) { key = c.key; macLearn(state, d, key, mac, 'wlan'); }
    } else if (d && d.sw && isBridgePort(d, h.toPort)) {
      const k = ingressKey(d, h.toPort, h.tag, null, {});
      if (k !== DROP) { key = k; macLearn(state, d, key, mac, h.toPort); }
    }
    keys.push(key);
  }
  return keys;
}
/** 同一條路反過來走 */
const reversed = (path) => [...path].reverse().map((h) => ({ ...h, from: h.to, fromPort: h.toPort, to: h.from, toPort: h.fromPort }));

/** 不認得目的 MAC 時，訊框還會被送往哪些埠（進來的埠和原本就要走的埠除外） */
function floodPorts(state, sw, key, inPort, outPort) {
  const out = [];
  for (const pid of Object.keys(sw.sw.ports)) {
    if (pid === inPort || pid === outPort || !isBridgePort(sw, pid)) continue;
    const l = state.rt.links[sw.id + ':' + pid];
    if (l && egressTag(sw, pid, key) !== DROP) out.push({ cable: l.cable, from: sw.id, to: l.dev });
  }
  return out;
}

/** MAC 位址表目前的內容（過期的不算）。STATIC 是 Port Security 指定的位址 */
export function macRows(state, d) {
  const rows = [];
  const label = (pid) => (pid === 'wlan' ? 'Wi-Fi' : (d.ports.find((p) => p.id === pid) || {}).label || pid);
  const vlan = (k) => (k === 'u' ? 1 : +k);
  if (isVlanSw(d)) {
    for (const [pid, pc] of Object.entries(d.sw.ports)) {
      if (!pc.ps || !pc.ps.on) continue;
      for (const m of macList(pc.ps.macs)) rows.push({ vlan: pc.mode === 'trunk' ? pc.native : pc.vlan, mac: m, port: pid, label: label(pid), type: 'STATIC' });
    }
  }
  const age = macAgeOf(d);
  for (const [k, e] of Object.entries((state.dyn && state.dyn.mac && state.dyn.mac[d.id]) || {})) {
    const cut = k.indexOf('|'), key = k.slice(0, cut), mac = k.slice(cut + 1), old = state.clock - e.t;
    if (old >= age || rows.some((r) => r.mac === mac && r.vlan === vlan(key))) continue;
    rows.push({ vlan: vlan(key), mac, port: e.port, label: label(e.port), type: 'DYNAMIC', age: Math.floor(old), left: Math.ceil(age - old) });
  }
  return rows.sort((a, b) => a.vlan - b.vlan || a.label.localeCompare(b.label, 'en', { numeric: true }) || a.mac.localeCompare(b.mac));
}
/** clear mac address-table dynamic */
export function clearMac(state, d) { if (state.dyn && state.dyn.mac) delete state.dyn.mac[d.id]; }

// ───────────────────── 供電、連線、LACP、STP、Wi-Fi ─────────────────────

function prepPhysical(state) {
  const rt = state.rt, down = state.down || {}, cut = state.cut || {};
  // 交換器的連接埠，或路由器的實體介面被 shutdown
  const shut = (D, pid) => !!(D.sw && D.sw.ports[pid] && D.sw.ports[pid].shut) || D.ifaces.some((i) => i.shut && i.bind.t === 'port' && i.bind.port === pid);
  for (const d of Object.values(state.devices)) {
    if (!CATALOG[d.model] || !CATALOG[d.model].needsPoe) continue;
    let ok = false;
    for (const c of state.cables) {
      if (cut[c.id]) continue;
      const me = c.a.dev === d.id ? c.a : c.b.dev === d.id ? c.b : null;
      if (!me) continue;
      const o = me === c.a ? c.b : c.a, od = state.devices[o.dev];
      const op = od.ports.find((p) => p.id === o.port);
      if (op && op.poe && !down[od.id] && !shut(od, o.port)) ok = true;
    }
    if (!ok) rt.off[d.id] = true;
  }
  for (const c of state.cables) {
    const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
    if (cut[c.id] || down[A.id] || down[B.id] || rt.off[A.id] || rt.off[B.id] || shut(A, c.a.port) || shut(B, c.b.port)) {
      rt.cable[c.id] = 'down';
      const dead = [A, B].find((x) => down[x.id]);
      const adm = shut(A, c.a.port) ? [A, c.a.port] : shut(B, c.b.port) ? [B, c.b.port] : null;
      if (dead) rt.why[c.id] = `${dead.name} 已經關機`;
      else if (adm) rt.why[c.id] = `${adm[0].name} 的 ${(adm[0].ports.find((p) => p.id === adm[1]) || {}).label || adm[1]} 被停用 (shutdown)`;
      continue;
    }
    const kind = CABLES[cableKind(c)], meters = cableDist(state, c);
    if (meters > kind.max) {
      rt.cable[c.id] = 'down';
      rt.why[c.id] = `${kind.name}最長只能拉 ${kind.max} 公尺，但這兩台設備相距 ${meters} 公尺`;
      continue;
    }
    const neg = linkInfo(state, A.id, c.a.port);
    if (neg && neg.down) { rt.cable[c.id] = 'down'; rt.why[c.id] = neg.down; continue; }
    rt.links[A.id + ':' + c.a.port] = { dev: B.id, port: c.b.port, cable: c.id };
    rt.links[B.id + ':' + c.b.port] = { dev: A.id, port: c.a.port, cable: c.id };
    rt.cable[c.id] = 'up';
  }
  // Port Security 的 shutdown 模式：發現不認識的 MAC 就把整個埠關掉 (err-disabled)
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const [pid, pc] of Object.entries(d.sw.ports)) {
      const l = rt.links[d.id + ':' + pid];
      if (!l || !pc.ps || !pc.ps.on || pc.ps.mode !== 'shutdown') continue;
      if (macsBehind(state, d, pid).some((m) => !psAllowed(pc, m.mac))) {
        d.rt.err[pid] = true;
        delete rt.links[d.id + ':' + pid];
        delete rt.links[l.dev + ':' + l.port];
        rt.cable[l.cable] = 'down';
        rt.why[l.cable] = `${d.name} 的 ${pid} 因為 Port Security 違規而被關閉 (err-disabled)`;
      }
    }
  }
  // Root Guard：啟用的埠只能是 Designated。如果從這個埠收到「根橋在對面」的 BPDU（superior BPDU），
  // 埠就進入 root-inconsistent 而被擋下。擋下之後拓撲改變，所以要重複檢查到穩定為止。
  {
    const swOn = (x) => isVlanSw(x) && !(x.sw.stp && x.sw.stp.on === false) && !down[x.id];
    const bridgeId = (x) => { const s = x.sw.stp || {}; return [s.prio == null || s.prio === '' ? 32768 : +s.prio, macOf(x.id, 'br')]; };
    const better = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    /** 從 start 出發、不經過 skipDev 這台交換器，能走到的所有交換器 */
    const reach = (start, skipDev) => {
      const seen = new Map([[start.id, start]]), todo = [start];
      while (todo.length) {
        const x = todo.pop();
        for (const p of x.ports) {
          const l = rt.links[x.id + ':' + p.id];
          if (!l || l.dev === skipDev || seen.has(l.dev)) continue;
          const y = state.devices[l.dev];
          if (!swOn(y) || !isBridgePort(x, p.id) || !isBridgePort(y, l.port)) continue;
          seen.set(y.id, y); todo.push(y);
        }
      }
      return seen;
    };
    for (let round = 0, again = true; again && round < 16; round++) {
      again = false;
      scan: for (const d of Object.values(state.devices)) {
        if (!swOn(d)) continue;
        for (const [pid, pc] of Object.entries(d.sw.ports)) {
          const l = rt.links[d.id + ':' + pid];
          if (!l || !pc.rootguard || !isBridgePort(d, pid)) continue;
          const x = state.devices[l.dev];
          if (!swOn(x) || !isBridgePort(x, l.port)) continue;
          let root = d;
          for (const y of reach(d, null).values()) if (better(bridgeId(y), bridgeId(root))) root = y;
          if (root === d || !reach(x, d.id).has(root.id)) continue; // 自己就是根橋，或對面不會送來根橋的 BPDU
          d.rt.err[pid] = 'root';
          delete rt.links[d.id + ':' + pid];
          delete rt.links[l.dev + ':' + l.port];
          rt.cable[l.cable] = 'down';
          rt.why[l.cable] = `${d.name} 的 ${pid} 啟用了 Root Guard，卻從這個埠收到更優先的根橋 BPDU（${root.name}），連接埠已被擋下 (root-inconsistent)`;
          again = true;
          break scan;
        }
      }
    }
  }
  // BPDU Guard：接使用者的埠如果收到 BPDU（對面是一台交換器），就把埠關掉
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const [pid, pc] of Object.entries(d.sw.ports)) {
      const l = rt.links[d.id + ':' + pid];
      if (!l || !pc.bpduguard) continue;
      const x = state.devices[l.dev];
      if (!isVlanSw(x) || (x.sw.stp && x.sw.stp.on === false) || !isBridgePort(x, l.port)) continue;
      d.rt.err[pid] = 'bpdu';
      delete rt.links[d.id + ':' + pid];
      delete rt.links[l.dev + ':' + l.port];
      rt.cable[l.cable] = 'down';
      rt.why[l.cable] = `${d.name} 的 ${pid} 啟用了 BPDU Guard，偵測到對面是交換器，連接埠已被關閉 (err-disabled)`;
    }
  }
}

function prepLag(state) {
  const rt = state.rt, groups = new Map();
  const lagOf = (D, pid) => (isVlanSw(D) && isBridgePort(D, pid) && +D.sw.ports[pid].lag > 0 ? D.sw.ports[pid] : null);
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const [pid, pc] of Object.entries(d.sw.ports)) if (+pc.lag > 0) d.rt.lag[pid] = { state: 'down', why: '沒有連線', id: +pc.lag };
  }
  const suspend = (c, why) => {
    for (const e of [c.a, c.b]) {
      const D = state.devices[e.dev];
      if (lagOf(D, e.port)) D.rt.lag[e.port] = { state: 'suspended', why, id: +D.sw.ports[e.port].lag };
    }
    rt.cable[c.id] = 'susp';
  };
  for (const c of state.cables) {
    if (rt.cable[c.id] !== 'up') continue;
    const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
    const la = lagOf(A, c.a.port), lb = lagOf(B, c.b.port);
    if (!la && !lb) continue;
    if (!la || !lb) { suspend(c, `對端 ${(la ? B : A).name} 的連接埠沒有加入 Port-channel`); continue; }
    const ma = la.lagMode || 'active', mb = lb.lagMode || 'active';
    if ((ma === 'on') !== (mb === 'on')) { suspend(c, '一端是靜態 (on)、另一端是 LACP，模式不相容'); continue; }
    if (ma === 'passive' && mb === 'passive') { suspend(c, '兩端都是 LACP passive，沒有任何一端主動發起協商'); continue; }
    const sa = `${A.id}#${la.lag}`, sb = `${B.id}#${lb.lag}`;
    const key = sa < sb ? sa + '|' + sb : sb + '|' + sa;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const owner = {};
  for (const key of groups.keys()) for (const s of key.split('|')) (owner[s] ||= []).push(key);
  for (const [key, list] of groups) {
    let why = key.split('|').some((s) => owner[s].length > 1) ? '同一個 Port-channel 的成員接到了不同的對端' : '';
    if (!why) {
      const sig = {};
      for (const c of list) {
        for (const e of [c.a, c.b]) {
          const pc = state.devices[e.dev].sw.ports[e.port];
          (sig[e.dev] ||= new Set()).add(`${pc.mode}/${pc.vlan}/${pc.native}/${pc.allowed}`);
        }
      }
      if (Object.values(sig).some((s) => s.size > 1)) why = '成員埠的模式或 VLAN 設定不一致';
    }
    if (why) { list.forEach((c) => suspend(c, why)); continue; }
    list.forEach((c, n) => {
      for (const e of [c.a, c.b]) {
        const D = state.devices[e.dev];
        D.rt.lag[e.port] = { state: 'bundled', carrier: n === 0, id: +D.sw.ports[e.port].lag, size: list.length };
      }
      if (n > 0) rt.cable[c.id] = 'lag';
    });
  }
}

/** 每個 VLAN 各算一棵生成樹（近似 Rapid PVST+） */
function prepStp(state) {
  const rt = state.rt, down = state.down || {};
  const sws = Object.values(state.devices).filter((d) => isVlanSw(d) && !down[d.id]);
  for (const d of sws) {
    const s = d.sw.stp || {};
    d.rt.stp = { on: s.on !== false, prio: s.prio == null || s.prio === '' ? 32768 : +s.prio, mac: macOf(d.id, 'br'), blocked: new Set(), roles: {}, root: {} };
  }
  const bid = (d) => [d.rt.stp.prio, d.rt.stp.mac];
  const edges = [];
  for (const c of state.cables) {
    if (rt.cable[c.id] !== 'up') continue;
    const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
    if (!isVlanSw(A) || !isVlanSw(B) || !A.rt.stp.on || !B.rt.stp.on) continue;
    if (!isBridgePort(A, c.a.port) || !isBridgePort(B, c.b.port)) continue;
    edges.push({ c, A, B, pa: c.a.port, pb: c.b.port });
  }
  if (!edges.length) return;
  const vlans = new Set();
  for (const d of sws) for (const v of d.sw.vlans) vlans.add(v.id);
  const carries = (D, pid, v) => {
    const pc = D.sw.ports[pid];
    return vlanExists(D, v) && (pc.mode === 'trunk' ? vlanAllowed(pc, v) : pc.vlan === v);
  };
  const pidx = (D, pid) => D.ports.findIndex((p) => p.id === pid);
  const role = (D, pid, v, r) => { (D.rt.stp.roles[pid] ||= {})[v] = r; };
  for (const v of vlans) {
    const es = edges.filter((e) => carries(e.A, e.pa, v) && carries(e.B, e.pb, v));
    if (!es.length) continue;
    const adj = new Map();
    const add = (x, a) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push(a); };
    for (const e of es) {
      add(e.A, { e, port: e.pa, nb: e.B, nport: e.pb });
      add(e.B, { e, port: e.pb, nb: e.A, nport: e.pa });
    }
    const todo = new Set(adj.keys());
    while (todo.size) {
      const first = todo.values().next().value;
      todo.delete(first);
      const comp = [], st = [first];
      while (st.length) {
        const x = st.pop();
        comp.push(x);
        for (const a of adj.get(x)) if (todo.has(a.nb)) { todo.delete(a.nb); st.push(a.nb); }
      }
      let root = comp[0];
      for (const x of comp) if (cmp(bid(x), bid(root)) < 0) root = x;
      const dist = new Map([[root, 0]]), q = [root];
      while (q.length) {
        const x = q.shift();
        for (const a of adj.get(x)) if (!dist.has(a.nb)) { dist.set(a.nb, dist.get(x) + 1); q.push(a.nb); }
      }
      const rootEdge = new Map();
      for (const x of comp) {
        x.rt.stp.root[v] = root.id;
        if (x === root) continue;
        let best = null;
        for (const a of adj.get(x)) {
          const k = [dist.get(a.nb), ...bid(a.nb), pidx(a.nb, a.nport), pidx(x, a.port)];
          if (!best || cmp(k, best.k) < 0) best = { a, k };
        }
        rootEdge.set(x, best.a.e);
        role(x, best.a.port, v, 'root');
      }
      for (const e of es) {
        if (!comp.includes(e.A)) continue;
        if (rootEdge.get(e.A) === e) { role(e.B, e.pb, v, 'desg'); continue; }
        if (rootEdge.get(e.B) === e) { role(e.A, e.pa, v, 'desg'); continue; }
        const aWins = cmp([dist.get(e.A), ...bid(e.A)], [dist.get(e.B), ...bid(e.B)]) <= 0;
        const [D, dp, X, xp] = aWins ? [e.A, e.pa, e.B, e.pb] : [e.B, e.pb, e.A, e.pa];
        role(D, dp, v, 'desg');
        role(X, xp, v, 'altn');
        X.rt.stp.blocked.add(xp + '|' + v);
        rt.cable[e.c.id] = 'blocked';
      }
    }
  }
}

// ───────────────────────── 模擬時鐘 ─────────────────────────
// state.clock 是從關卡開始算起的秒數。state.dyn 是「需要時間才會改變」的狀態，跨次計算保留下來：
// 連接埠什麼時候啟用、OSPF 鄰居什麼時候建立、DHCP 租約什麼時候到期、ARP 快取什麼時候學到。
// 關卡一開始的狀態當作已經運作很久（全部收斂完成），之後的變動才需要等待。

/** 讓模擬時間前進 secs 秒，再重新計算網路的狀態 */
export function advance(state, secs) {
  state.clock = (state.clock || 0) + Math.max(0, secs);
  return recompute(state);
}
/** 還沒走完的收斂計時（STP、OSPF、VRRP），最快完成的排在前面 */
export const pendingOf = (state) => ((state.rt && state.rt.pending) || []).slice().sort((a, b) => a.at - b.at);
/** 重新計算，並讓時間前進到網路穩定為止（最多前進 max 秒） */
export function settle(state, max = 300) {
  recompute(state);
  const end = state.clock + max;
  for (let n = 0; n < 400; n++) {
    const p = pendingOf(state)[0];
    if (!p || p.at > end) break;
    state.clock = Math.max(state.clock, p.at);
    recompute(state);
  }
  return state;
}
export const fmtDur = (s) => {
  s = Math.max(0, Math.ceil(s));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分${s % 60 ? ` ${s % 60} 秒` : '鐘'}`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} 分` : ''}`;
  return `${Math.floor(s / 86400)} 天${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} 小時` : ''}`;
};

// ── STP 的連接埠狀態 ──
const STP_EDGE_DELAY = 30; // 沒有 PortFast 的埠：listening 15 秒 + learning 15 秒
const STP_P2P_DELAY = 2; // 交換器之間用 RSTP 的 proposal / agreement 快速協商
/** PortFast：這個埠接的是終端設備，連線後直接開始轉送 */
export const portfastOn = (d, pc) => (pc.portfast != null ? !!pc.portfast : !!(d.sw.stp && d.sw.stp.portfastDefault) && pc.mode !== 'trunk');

function prepStpTimers(state) {
  const rt = state.rt, dyn = state.dyn, now = state.clock, live = new Set();
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d) || (d.sw.stp && d.sw.stp.on === false) || (state.down || {})[d.id]) continue;
    for (const [pid, pc] of Object.entries(d.sw.ports)) {
      const l = rt.links[d.id + ':' + pid];
      if (!l || pc.mode === 'routed' || (d.sw.span && spanDest(d, pid))) continue; // SPAN 的目的埠不跑 STP
      const key = d.id + ':' + pid;
      live.add(key);
      // 連線剛建立，或這個埠換了 VLAN / 模式：STP 要重新走一次
      const sig = pc.mode === 'trunk' ? `t|${pc.native}|${pc.allowed}` : `a|${pc.vlan}`;
      let rec = dyn.port[key];
      if (!rec || rec.sig !== sig) rec = dyn.port[key] = { since: dyn.boot ? -1e9 : now, sig };
      const x = state.devices[l.dev];
      const toSwitch = isVlanSw(x) && !(x.sw.stp && x.sw.stp.on === false) && isBridgePort(x, l.port);
      const delay = toSwitch ? STP_P2P_DELAY : portfastOn(d, pc) ? 0 : STP_EDGE_DELAY;
      const left = rec.since + delay - now;
      if (left <= 0) continue;
      d.rt.wait[pid] = left;
      rt.wait[l.cable] = Math.max(rt.wait[l.cable] || 0, left);
      rt.pending.push({ at: rec.since + delay, dev: d.id, kind: 'stp', text: `${d.name} 的 ${pid}：STP ${toSwitch ? '協商中' : left > 15 ? 'listening' : 'learning'}` });
    }
  }
  for (const k of Object.keys(dyn.port)) if (!live.has(k)) delete dyn.port[k];
}

// ── ARP 快取 ──
/** ARP 項目多久沒用到就會被清掉：個人電腦大約兩分鐘，防火牆五分鐘，路由器與交換器四小時 */
const arpTtl = (dev) => (dev.kind === 'host' ? 120 : dev.kind === 'firewall' || dev.kind === 'homerouter' ? 300 : 14400);
export const VRRP_MAC = '00:00:5e:00:01:01'; // VRRP 的虛擬 MAC：換手之後主機不需要重新學
const answerMac = (e, ip) => (e.iface.rt.ip !== ip && e.iface.vrrp && e.iface.vrrp.on && parseIp(e.iface.vrrp.vip || '') === ip ? VRRP_MAC : e.iface.rt.mac);
export const arpRows = (state, dev) => Object.entries((state.dyn && state.dyn.arp[dev.id]) || {})
  .filter(([, e]) => state.clock - e.t < arpTtl(dev))
  .map(([ip, e]) => ({ ip: +ip, mac: e.mac, age: Math.floor(state.clock - e.t), left: Math.ceil(arpTtl(dev) - (state.clock - e.t)) }));
/** arp -d / clear arp-cache */
export function clearArp(state, dev) { if (state.dyn) delete state.dyn.arp[dev.id]; }

export const WIFI_SEC = { open: '開放（無加密）', wep: 'WEP', wpa2: 'WPA2-Personal', wpa2wpa3: 'WPA2 / WPA3 混合', wpa3: 'WPA3-Personal', wpa2ent: 'WPA2-Enterprise (802.1X)' };
const SEC_MODES = { open: ['open'], wep: ['wep'], wpa2: ['wpa2'], wpa2wpa3: ['wpa3', 'wpa2'], wpa3: ['wpa3'], wpa2ent: ['wpa2'] };
export const apRange = (d) => ({ low: 6, mid: 9, high: 12 })[(d.wifi && d.wifi.power) || 'mid'];
const distOf = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
const apsOf = (state) =>
  Object.values(state.devices).filter((d) => d.wifi && !state.rt.off[d.id] && !(state.down || {})[d.id] && d.wifi.ssids.some((s) => !s.off && s.name));

function prepWifi(state) {
  const rt = state.rt, aps = apsOf(state);
  for (let i = 0; i < aps.length; i++) {
    for (let j = i + 1; j < aps.length; j++) {
      const a = aps[i], b = aps[j];
      if (distOf(a, b) >= apRange(a) + apRange(b)) continue;
      const bands = [];
      if (Math.abs((+a.wifi.ch24 || 1) - (+b.wifi.ch24 || 1)) < 5) bands.push('2.4GHz');
      if ((+a.wifi.ch5 || 36) === (+b.wifi.ch5 || 36)) bands.push('5GHz');
      for (const band of bands) { a.rt.interf.push({ dev: b.id, band }); b.rt.interf.push({ dev: a.id, band }); }
    }
  }
  for (const d of Object.values(state.devices)) {
    for (const i of d.ifaces) {
      if (i.bind.t !== 'wlan') continue;
      const w = i.wifi || {};
      if (!w.ssid) { i.rt.note = '尚未選擇無線網路'; continue; }
      const caps = CATALOG[d.model].wifiCaps || ['open', 'wep', 'wpa2', 'wpa3'];
      let best = null, why = `找不到無線網路「${w.ssid}」— 不在任何基地台的訊號範圍內`;
      for (const ap of aps) {
        const dist = distOf(d, ap);
        if (dist > apRange(ap)) continue;
        ap.wifi.ssids.forEach((s, idx) => {
          if (s.off || s.name !== w.ssid) return;
          if (!SEC_MODES[s.sec || 'open'].some((m) => caps.includes(m))) { why = `${d.name} 不支援 ${WIFI_SEC[s.sec]}，連不上「${s.name}」`; return; }
          if (s.sec === 'wpa2ent') {
            const a = rt.auth.ent[d.id + '/' + i.id];
            if (!a || !a.ok) { why = `「${s.name}」的 802.1X 驗證沒有通過：${(a && a.why) || '等待驗證'}`; return; }
          } else if (s.sec && s.sec !== 'open') {
            if ((s.pass || '').length < 8) { why = `「${s.name}」的密碼少於 8 個字元，基地台無法啟用加密`; return; }
            if ((w.pass || '') !== s.pass) { why = `無線網路「${s.name}」的密碼錯誤`; return; }
          }
          if (!best || dist < best.dist) best = { ap: ap.id, idx, dist, key: +s.vlan > 0 ? +s.vlan : 'u', isolate: !!s.isolate, sec: s.sec || 'open' };
        });
      }
      if (!best) { i.rt.note = why; continue; }
      // 訊號強度、頻段與速率（依距離估算）
      const apd = state.devices[best.ap], rng = apRange(apd);
      best.band = best.dist <= rng * 0.75 ? '5GHz' : '2.4GHz'; // 5GHz 比較快但傳不遠，靠近邊緣時退回 2.4GHz
      best.ch = best.band === '5GHz' ? +apd.wifi.ch5 || 36 : +apd.wifi.ch24 || 1;
      best.rssi = Math.round(-38 - 40 * (best.dist / rng)); // 涵蓋範圍的邊緣大約是 -78 dBm
      const noisy = apd.rt.interf.some((x) => x.band === best.band);
      best.rate = Math.round((best.band === '5GHz' ? (best.rssi > -52 ? 866 : best.rssi > -62 ? 585 : 292) : best.rssi > -72 ? 144 : 72) * (noisy ? 0.5 : 1));
      best.noisy = noisy;
      i.rt.assoc = best;
      (rt.clients[best.ap] ||= []).push({ dev: d.id, iface: i, key: best.key, isolate: best.isolate });
    }
  }
}

/** 某台設備掃描得到的無線網路清單 */
export function visibleSsids(state, dev) {
  const out = new Map();
  for (const ap of apsOf(state)) {
    const dist = distOf(dev, ap), r = apRange(ap);
    if (dist > r) continue;
    for (const s of ap.wifi.ssids) {
      if (s.off || !s.name) continue;
      const cur = out.get(s.name);
      if (!cur || dist < cur.dist) out.set(s.name, { name: s.name, sec: s.sec || 'open', ap: ap.name, dist, bars: dist < r * 0.4 ? 3 : dist < r * 0.75 ? 2 : 1 });
    }
  }
  return [...out.values()].sort((a, b) => a.dist - b.dist);
}

// ───────────────────────── 位址取得 / 路由表 ─────────────────────────

/**
 * busy：這個網段上已經有人手動在用的位址。伺服器發出「新的」位址之前會先 ping 確認沒有人回應，
 * 有人在用就跳過並記成衝突。已經發出去的租約不會重新檢查 — 所以設備離線期間被發走的位址，回來之後還是會衝突。
 */
// ── DHCP 租約 ──
export const DEFAULT_LEASE = 86400; // 一天
/** 某個位址池的租約長度（秒）。key 是「伺服器 id/介面 id」或「伺服器 id/scope/起始 IP」 */
function leaseLen(state, key) {
  const cut = key.indexOf('/'), d = state.devices[key.slice(0, cut)], rest = key.slice(cut + 1);
  if (!d) return DEFAULT_LEASE;
  if (rest.startsWith('scope/')) return +((d.dhcpScopes || []).find((x) => x.start === rest.slice(6)) || {}).lease || DEFAULT_LEASE;
  const i = d.ifaces.find((x) => x.id === rest);
  return +(i && i.dhcp && i.dhcp.lease) || DEFAULT_LEASE;
}
/** 伺服器記下（或續約）一筆租約，回傳到期時間。用戶端在租約過了一半時會自動續約 */
function touchLease(state, key, clientKey, ip) {
  const hold = (state.dyn.hold[key] ||= {}), now = state.clock, len = leaseLen(state, key), h = hold[clientKey];
  if (!h || h.ip !== ip) hold[clientKey] = { ip, t0: now, exp: now + len };
  else if (now >= h.t0 + len / 2) { h.t0 = now; h.exp = now + len; }
  return hold[clientKey].exp;
}
/** 用戶端記下自己拿到的租約：之後就算連不到伺服器，到期之前都可以繼續用 */
function rememberLease(state, d, i, key, exp) {
  state.dyn.lease[d.id + '/' + i.id] = { ip: i.rt.ip, bits: i.rt.bits, gw: i.rt.gw, dns: i.rt.dns, server: i.rt.server, relay: i.rt.relay || null, key, exp };
  i.rt.exp = exp;
}
/** ipconfig /release：歸還位址，之後要 /renew 才會再去要 */
export function dhcpRelease(state, devId) {
  const d = state.devices[devId];
  for (const i of d.ifaces) {
    if (i.mode !== 'dhcp') continue;
    const ck = d.id + '/' + i.id, L = state.dyn.lease[ck];
    if (L && L.key) { if (state.leases[L.key]) delete state.leases[L.key][ck]; if (state.dyn.hold[L.key]) delete state.dyn.hold[L.key][ck]; }
    delete state.dyn.lease[ck];
    i.released = true;
  }
}
/** ipconfig /renew：馬上向伺服器續約（或重新要一個位址） */
export function dhcpRenew(state, devId) {
  const d = state.devices[devId];
  for (const i of d.ifaces) {
    if (i.mode !== 'dhcp') continue;
    delete i.released;
    const L = state.dyn.lease[d.id + '/' + i.id], h = L && L.key && (state.dyn.hold[L.key] || {})[d.id + '/' + i.id];
    if (h) h.t0 = -1e9; // 讓伺服器把這次請求當成續約
  }
}

function leaseFrom(state, old, key, start, end, exclude, clientKey, busy = []) {
  if (start == null || end == null || end < start) return null;
  const tbl = (state.leases[key] ||= {});
  const used = new Set(Object.entries(tbl).filter(([k]) => k !== clientKey).map(([, v]) => v)); // 別人還沒到期的租約不能動
  for (const x of [].concat(exclude ?? [])) used.add(x);
  let ip = old[key] ? old[key][clientKey] : null;
  if (ip != null && (ip < start || ip > end || used.has(ip))) ip = null;
  if (ip == null) {
    const reserved = new Set(Object.entries(old[key] || {}).filter(([k]) => k !== clientKey).map(([, v]) => v));
    const taken = new Set(busy);
    for (let c = start; c <= end && c - start < 4096; c++) if (!used.has(c) && !taken.has(c) && !reserved.has(c)) { ip = c; break; }
    if (ip == null) for (let c = start; c <= end && c - start < 4096; c++) if (!used.has(c) && !taken.has(c)) { ip = c; break; }
    if (busy.length && state.rt) {
      const seen = ((state.rt.dhcpConflict ||= {})[key] ||= []);
      for (const c of busy) if (c >= start && c <= end && !used.has(c) && (ip == null || c < ip) && !seen.includes(c)) seen.push(c);
    }
  }
  if (ip == null) { delete tbl[clientKey]; return null; }
  tbl[clientKey] = ip;
  return ip;
}

/** DHCP 伺服器的回應會從哪些交換器埠進來？若該埠不是 Snooping 信任埠就會被丟掉 */
function snoopBlock(state, path) {
  for (const h of path) {
    if (h.wifi) continue;
    const d = state.devices[h.from];
    if (isVlanSw(d) && d.sw.snoop && d.sw.snoop.on && !d.sw.ports[h.fromPort].trust) return d;
  }
  return null;
}

function acquire(state, old, d, i) {
  const eps = l2Explore(state, d.id, i);
  const set = (ip, bits, gw, dns, src, server) => {
    Object.assign(i.rt, { ip, bits, gw, dns, src, server, note: '' });
    return true;
  };
  if (eps.storm) { i.rt.note = `廣播風暴：${state.devices[eps.storm].name} 所在的網段有迴圈，DHCP 完全不通`; return false; }
  if (i.mode === 'pppoe') {
    const e = eps.find((x) => x.iface.line && x.iface.line.type === 'pppoe');
    if (!e) { i.rt.note = 'PPPoE 沒有回應：對面不是 PPPoE 線路，或線還沒接'; return false; }
    const ln = e.iface.line;
    if ((i.user || '').trim() !== ln.user || (i.pass || '') !== ln.pass) { i.rt.note = 'PPPoE 驗證失敗：帳號或密碼錯誤'; return false; }
    return set(parseIp(ln.assign), e.iface.rt.bits, e.iface.rt.ip, dnsList(ln.dns), 'pppoe', e.dev);
  }
  let snooped = null;
  for (const e of eps) {
    const s = e.iface, sd = state.devices[e.dev];
    if (s.rt.ip == null) continue;
    const isServer = s.line ? s.line.type === 'dhcp' : s.dhcp && s.dhcp.on;
    if (!isServer) continue;
    const blk = snoopBlock(state, e.path);
    if (blk) { snooped = { by: blk, server: sd }; continue; }
    if (s.line) {
      // ISP 配發的位址：租約一天，過了一半會自動續約
      const prev = state.dyn.lease[d.id + '/' + i.id], t0 = prev && prev.isp && state.clock < prev.t0 + DEFAULT_LEASE / 2 ? prev.t0 : state.clock;
      set(parseIp(s.line.assign), s.rt.bits, s.rt.ip, dnsList(s.line.dns), 'dhcp', sd.id);
      rememberLease(state, d, i, null, t0 + DEFAULT_LEASE);
      Object.assign(state.dyn.lease[d.id + '/' + i.id], { isp: true, t0 });
      return true;
    }
    const start = parseIp(s.dhcp.start), end = parseIp(s.dhcp.end);
    const inNet = start != null && end != null && sameNet(start, s.rt.ip, s.rt.bits) && sameNet(end, s.rt.ip, s.rt.bits);
    // 保留位址：指定的 MAC 永遠拿到同一個 IP
    const rsv = (s.dhcp.reserved || []).map((r) => ({ mac: String(r.mac || '').trim().toLowerCase(), ip: parseIp(r.ip || '') }))
      .filter((r) => r.mac && r.ip != null && sameNet(r.ip, s.rt.ip, s.rt.bits));
    const mine = rsv.find((r) => r.mac === i.rt.mac);
    let ip;
    if (mine) { ip = mine.ip; (state.leases[sd.id + '/' + s.id] ||= {})[d.id + '/' + i.id] = ip; }
    else {
      // 同一個網段上手動設定了 IP 的設備：伺服器 ping 得到它們，不會把這些位址發出去
      const busy = eps.filter((x) => x.iface !== s && x.iface.rt.ip != null && x.iface.rt.src !== 'dhcp' && x.iface.rt.src !== 'apipa').map((x) => x.iface.rt.ip);
      ip = inNet ? leaseFrom(state, old, sd.id + '/' + s.id, start, end, [s.rt.ip, ...rsv.map((r) => r.ip)], d.id + '/' + i.id, busy) : null;
    }
    if (ip == null) { i.rt.note = `${sd.name} 的 DHCP 位址池設定有誤或已用完`; continue; }
    let dns = dnsList(s.dhcp.dns);
    if (!dns.length && sd.dnsProxy) dns = [s.rt.ip];
    set(ip, s.rt.bits, parseIp(s.dhcp.gw) ?? s.rt.ip, dns, 'dhcp', sd.id);
    const lk = sd.id + '/' + s.id, ck = d.id + '/' + i.id;
    rememberLease(state, d, i, lk, touchLease(state, lk, ck, ip));
    // 這一刻真的有 DHCP 封包在走（新的租約或續約）：沿路的交換器學到用戶端與伺服器的 MAC
    if (state.dyn.hold[lk][ck].t0 === state.clock && !state.dyn.boot) {
      for (const x of eps) learnPath(state, x.path, i.rt.mac);
      learnPath(state, reversed(e.path), s.rt.mac);
    }
    return true;
  }
  if (!i.rt.note) {
    i.rt.note = !i.rt.link ? (i.bind.t === 'wlan' ? i.rt.note || 'Wi-Fi 尚未連線' : '網路線沒有接上，或對端連接埠沒有啟用')
      : eps.dot1x ? `連接埠還沒有通過 802.1X 驗證（${eps.dot1x}）`
      : snooped ? `${snooped.server.name} 的 DHCP 回應被 ${snooped.by.name} 的 DHCP Snooping 擋下（進來的埠不是信任埠）`
        : eps.some((x) => x.iface.line && x.iface.line.type === 'pppoe') ? 'DHCP 沒有回應：這條 ISP 線路要用 PPPoE 撥接'
          : eps.some((x) => x.iface.line && x.iface.line.type === 'static') ? 'DHCP 沒有回應：這條 ISP 線路是固定 IP，需要手動設定'
            : eps.stp ? `DHCP 還沒有回應：${state.devices[eps.stp.dev].name} 的 ${eps.stp.pid} 還在 STP 的 listening / learning 狀態，再 ${Math.ceil(eps.stp.left)} 秒才會開始轉送`
              : eps.span ? `DHCP 沒有回應：${state.devices[eps.span.dev].name} 的 ${eps.span.pid} 是 SPAN（連接埠鏡像）的目的埠，交換器只會從這個埠送出複製的訊框，不轉送一般流量`
              : 'DHCP 沒有回應：這個網段上找不到 DHCP 伺服器';
  }
  return false;
}

/** 透過 DHCP Relay (ip helper-address) 向遠端的 DHCP 伺服器要位址。需要路由表，所以排在後面做 */
function relayPass(state, old) {
  let changed = false;
  for (const d of Object.values(state.devices)) {
    for (const i of d.ifaces) {
      if (!i.rt.active || i.rt.ip != null || i.mode !== 'dhcp' || !i.rt.link) continue;
      const eps = l2Explore(state, d.id, i);
      if (eps.storm) continue;
      for (const e of eps) {
        const r = e.iface, rd = state.devices[e.dev];
        const helper = parseIp(r.helper || '');
        if (helper == null || r.rt.ip == null) continue;
        const res = transact(state, rd.id, { proto: 'udp', dst: helper, dport: 67, srcIp: r.rt.ip, quiet: true });
        if (!res.ok) { i.rt.note = `DHCP Relay：${rd.name} 連不到 DHCP 伺服器 ${fmtIp(helper)} — ${res.reason}`; continue; }
        const sd = state.devices[res.responder];
        const sc = (sd.dhcpScopes || []).find((s) => {
          const a = parseIp(s.start), b = parseIp(s.end);
          return a != null && b != null && a <= b && sameNet(a, r.rt.ip, r.rt.bits) && sameNet(b, r.rt.ip, r.rt.bits);
        });
        if (!sc) { i.rt.note = `${sd.name} 沒有適用於 ${fmtIp(netOf(r.rt.ip, r.rt.bits))}/${r.rt.bits} 的位址範圍 (Scope)`; continue; }
        const ip = leaseFrom(state, old, sd.id + '/scope/' + sc.start, parseIp(sc.start), parseIp(sc.end), null, d.id + '/' + i.id);
        if (ip == null) { i.rt.note = `${sd.name} 的位址範圍已經用完`; continue; }
        Object.assign(i.rt, { ip, bits: r.rt.bits, gw: parseIp(sc.gw) ?? r.rt.ip, dns: dnsList(sc.dns), src: 'dhcp', server: sd.id, relay: rd.id, note: '' });
        rememberLease(state, d, i, sd.id + '/scope/' + sc.start, touchLease(state, sd.id + '/scope/' + sc.start, d.id + '/' + i.id, ip));
        changed = true;
        break;
      }
    }
  }
  return changed;
}

const VRRP_DOWN = 3; // Master_Down_Interval：大約三個通告間隔沒聽到 Master，Backup 才會接手

function prepVrrp(state) {
  const dyn = state.dyn, now = state.clock;
  const c = [];
  for (const d of Object.values(state.devices)) {
    for (const i of d.ifaces) {
      if (!i.vrrp || !i.vrrp.on) continue;
      const vip = parseIp(i.vrrp.vip || '');
      if (i.rt.ip == null || !i.rt.link) { i.rt.vrrp = { state: 'init', why: '介面沒有 IP 或沒有連線' }; continue; }
      if (vip == null || !sameNet(vip, i.rt.ip, i.rt.bits)) { i.rt.vrrp = { state: 'init', why: '虛擬 IP 必須和介面位於同一個子網路' }; continue; }
      c.push({ d, i, vip, key: d.id + '/' + i.id, k: [+i.vrrp.prio || 100, i.rt.ip] });
    }
  }
  const prev = Object.fromEntries(c.map((x) => [x.key, dyn.vrrp[x.key] && dyn.vrrp[x.key].state]));
  const live = new Set(c.map((x) => x.key));
  for (const k of Object.keys(dyn.vrrp)) if (!live.has(k)) delete dyn.vrrp[k];
  for (const x of c) {
    const peers = l2Explore(state, x.d.id, x.i).map((e) => c.find((y) => y.i === e.iface && y.vip === x.vip)).filter(Boolean);
    const top = peers.find((p) => cmp(p.k, x.k) > 0);
    let rec = dyn.vrrp[x.key];
    if (!rec) rec = dyn.vrrp[x.key] = dyn.boot ? { state: top ? 'backup' : 'master', lost: null } : { state: 'backup', lost: null };
    let st, wait = 0;
    if (top) st = 'backup';
    else if (rec.state === 'master') st = 'master';
    else if (peers.some((p) => prev[p.key] === 'master')) st = 'master'; // 原本的 Master 還活著，只是優先權比我低：直接搶回來 (preempt)
    else {
      // 聽不到 Master 的通告了：要等 Master_Down_Interval 才接手，這段時間沒有人回應虛擬 IP
      if (rec.lost == null) rec.lost = now;
      wait = rec.lost + VRRP_DOWN - now;
      st = wait > 0 ? 'backup' : 'master';
      if (wait > 0) state.rt.pending.push({ at: rec.lost + VRRP_DOWN, dev: x.d.id, kind: 'vrrp', text: `${x.d.name}：聽不到 VRRP Master，等待接手` });
    }
    if (st === 'master' || top) rec.lost = null;
    rec.state = st;
    x.i.rt.vrrp = { state: st, peers: peers.length, wait: wait > 0 ? wait : 0 };
    if (st === 'master') x.i.rt.vips.push(x.vip);
  }
}

function buildRoutes(d) {
  const r = [];
  const up = (i) => i.rt.ip != null && i.rt.link;
  for (const i of d.ifaces) {
    if (up(i)) r.push({ net: netOf(i.rt.ip, i.rt.bits), bits: i.rt.bits, via: null, iface: i, type: 'C', ad: 0, metric: 0 });
  }
  for (const i of d.ifaces) {
    if (!up(i) || i.rt.gw == null) continue;
    const ok = sameNet(i.rt.gw, i.rt.ip, i.rt.bits) && i.rt.gw !== i.rt.ip;
    r.push({
      net: 0, bits: 0, via: i.rt.gw, iface: i, type: i.rt.src === 'static' ? 'S' : 'D', ad: 1, metric: 0,
      bad: ok ? null : `預設閘道 ${fmtIp(i.rt.gw)} 和 ${fmtIp(i.rt.ip)}/${i.rt.bits} 不在同一個子網路`,
    });
  }
  for (const s of d.routes || []) {
    const dst = parseIp(s.dst), bits = parseMask(s.mask), via = parseIp(s.via);
    if (dst == null || bits == null || via == null) continue;
    const i = d.ifaces.find((x) => up(x) && sameNet(via, x.rt.ip, x.rt.bits) && via !== x.rt.ip);
    r.push({
      net: netOf(dst, bits), bits, via, iface: i || null, type: 'S', ad: Math.max(1, +s.ad || 1), metric: 0,
      bad: i ? null : `下一站 ${fmtIp(via)} 不在任何已連線的直連網段上`,
    });
  }
  d.rt.routes = r;
}

export function lookupRoute(d, ip) {
  let best = null;
  for (const r of d.rt.routes) {
    if (r.bad || netOf(ip, r.bits) !== r.net) continue;
    if (!best || r.bits > best.bits || (r.bits === best.bits && (r.ad < best.ad || (r.ad === best.ad && r.metric < best.metric)))) best = r;
  }
  return best;
}

/**
 * 這個介面有沒有跑 OSPF：在介面上直接啟用，或它的 IP 落在某一條 network 敘述的範圍內。
 * network 敘述是持續生效的 — 之後才設定 IP 的介面，只要位址符合就會自動加入。
 */
export function ospfOn(d, i) {
  if (i.ospf) return true;
  const ip = i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || '');
  return ip != null && (d.ospfNets || []).some((n) => netOf(ip, n.bits) === n.net);
}
/** 圖形介面的開關：關閉時連同涵蓋它的 network 敘述一起移除（其他被同一條敘述涵蓋的介面維持啟用） */
export function setOspf(d, i, on) {
  if (on) { i.ospf = true; return; }
  const ip = i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || '');
  const hit = (n) => ip != null && netOf(ip, n.bits) === n.net;
  for (const x of d.ifaces) if (x !== i && !x.ospf && ospfOn(d, x) && (d.ospfNets || []).some((n) => hit(n) && netOf(x.rt && x.rt.ip != null ? x.rt.ip : parseIp(x.ip || '') ?? -1, n.bits) === n.net)) x.ospf = true;
  if (d.ospfNets) d.ospfNets = d.ospfNets.filter((n) => !hit(n));
  i.ospf = false;
}

const OSPF_WAIT = 40; // 乙太網路上要先等 DR / BDR 選舉（Wait timer 和 Dead interval 一樣長），鄰居才會進到 FULL
const OSPF_DEAD = 40; // 四個 Hello 間隔沒聽到對方，才判定鄰居失聯

function computeOspf(state) {
  const dyn = state.dyn, now = state.clock, devs = state.devices;
  const running = (d, i) => !!i && ospfOn(d, i) && i.rt.ip != null && i.rt.link;
  const nodes = Object.values(devs).filter((d) => d.ifaces.some((i) => running(d, i)));
  const isNode = new Set(nodes.map((d) => d.id));
  const adj = {}, nets = {}, seen = new Set();
  for (const d of nodes) {
    adj[d.id] = []; nets[d.id] = []; d.rt.nbrs = [];
    for (const i of d.ifaces) {
      if (!running(d, i)) continue;
      nets[d.id].push({ net: netOf(i.rt.ip, i.rt.bits), bits: i.rt.bits });
      const cost = Math.max(1, +i.ospfCost || 1);
      for (const e of l2Explore(state, d.id, i)) {
        const j = e.iface;
        if (!ospfOn(devs[e.dev], j) || j.rt.ip == null || j.rt.bits !== i.rt.bits || !sameNet(j.rt.ip, i.rt.ip, i.rt.bits)) continue;
        const me = d.id + '/' + i.id, other = e.dev + '/' + j.id, key = me < other ? me + '~' + other : other + '~' + me;
        let rec = dyn.adj[key];
        if (!rec) rec = dyn.adj[key] = { since: dyn.boot ? -1e9 : now };
        if (rec.gone) { rec.since = now; delete rec.gone; } // 中斷過又聽到對方：鄰居關係要從頭建立
        rec.last = now;
        rec[me] = { ip: i.rt.ip, cost }; // 記下這一端的資訊，對方失聯之後還用得到
        seen.add(key);
        const left = rec.since + OSPF_WAIT - now;
        if (left > 0) {
          d.rt.nbrs.push({ dev: e.dev, iface: i.id, ip: j.rt.ip, cost, state: 'forming', left });
          state.rt.pending.push({ at: rec.since + OSPF_WAIT, dev: d.id, kind: 'ospf', text: `${d.name} ↔ ${devs[e.dev].name}：OSPF 鄰居關係建立中` });
          continue;
        }
        adj[d.id].push({ to: e.dev, iface: i, via: j.rt.ip, cost });
        d.rt.nbrs.push({ dev: e.dev, iface: i.id, ip: j.rt.ip, cost, state: 'full', dead: OSPF_DEAD - ((now - Math.max(rec.since, 0)) % 10) });
      }
    }
    if (d.ospfDefault && d.rt.routes.some((r) => r.bits === 0 && !r.bad && r.type !== 'O')) nets[d.id].push({ net: 0, bits: 0 });
    dyn.lsa[d.id] = nets[d.id];
  }
  // 這一次沒聽到的鄰居：介面還亮著的那一端，要等 Dead timer 到期才會把它從資料庫拿掉。
  // 在那之前路由還指向已經不在的鄰居，封包會被送進黑洞。
  const ghosts = new Set();
  for (const [key, rec] of Object.entries(dyn.adj)) {
    if (seen.has(key)) continue;
    if (now - rec.last >= OSPF_DEAD || rec.since + OSPF_WAIT > rec.last) { delete dyn.adj[key]; continue; }
    rec.gone = true;
    const sides = key.split('~').map((s) => ({ s, dev: s.slice(0, s.indexOf('/')), iface: s.slice(s.indexOf('/') + 1) }));
    for (const [a, b] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
      const d = devs[a.dev], other = devs[b.dev];
      if (!d || !other || !rec[b.s]) continue;
      const i = d.ifaces.find((x) => x.id === a.iface);
      const believes = isNode.has(d.id) && running(d, i);
      if (!believes && isNode.has(d.id)) continue; // 自己的介面也斷了：立刻知道鄰居不見了
      if (!isNode.has(d.id)) ghosts.add(d.id); // 已經失聯的那一台：它發過的 LSA 還留在別人的資料庫裡
      (adj[d.id] ||= []).push({ to: b.dev, iface: i, via: rec[b.s].ip, cost: rec[a.s] ? rec[a.s].cost : 1, stale: true });
      if (!believes) continue;
      const left = rec.last + OSPF_DEAD - now;
      d.rt.nbrs.push({ dev: b.dev, iface: a.iface, ip: rec[b.s].ip, cost: rec[a.s] ? rec[a.s].cost : 1, state: 'dying', left });
      state.rt.pending.push({ at: rec.last + OSPF_DEAD, dev: d.id, kind: 'ospf', text: `${d.name} 還沒發現 ${other.name} 已經失聯（OSPF Dead timer）` });
    }
  }
  for (const id of ghosts) nets[id] = dyn.lsa[id] || [];
  for (const id of Object.keys(dyn.lsa)) if (!isNode.has(id) && !ghosts.has(id)) delete dyn.lsa[id];
  const everyone = [...nodes.map((d) => d.id), ...ghosts];
  for (const d of nodes) {
    const dist = { [d.id]: 0 }, first = {}, done = new Set();
    for (;;) {
      let u = null;
      for (const k of Object.keys(dist)) if (!done.has(k) && (u == null || dist[k] < dist[u])) u = k;
      if (u == null) break;
      done.add(u);
      for (const e of adj[u] || []) {
        const nd = dist[u] + e.cost;
        if (dist[e.to] == null || nd < dist[e.to]) { dist[e.to] = nd; first[e.to] = u === d.id ? e : first[u]; }
      }
    }
    for (const oid of everyone) {
      if (oid === d.id || dist[oid] == null) continue;
      for (const n of nets[oid]) {
        if (d.rt.routes.some((r) => r.type === 'C' && r.net === n.net && r.bits === n.bits)) continue;
        const metric = dist[oid] + 1;
        const ex = d.rt.routes.findIndex((r) => r.type === 'O' && r.net === n.net && r.bits === n.bits);
        if (ex >= 0) {
          if (d.rt.routes[ex].metric <= metric) continue;
          d.rt.routes.splice(ex, 1);
        }
        d.rt.routes.push({ net: n.net, bits: n.bits, via: first[oid].via, iface: first[oid].iface, type: 'O', ad: 110, metric });
      }
    }
  }
}

function routesAll(state) {
  for (const d of Object.values(state.devices)) buildRoutes(d);
  computeOspf(state);
}

// ───────────────────────────── VPN 通道 ─────────────────────────────

// IPsec 分兩個階段協商：第一階段 (IKE) 建立管理通道，第二階段 (IPsec SA) 才是真正加密資料的通道
export const P1 = (t) => `${(t.enc || 'aes128').toUpperCase()} / ${(t.hash || 'sha1').toUpperCase()} / DH ${t.dh || '2'}`;
export const P2 = (t) => `${(t.enc2 || t.enc || 'aes128').toUpperCase()} / ${(t.hash2 || t.hash || 'sha1').toUpperCase()}${t.pfs ? ' / PFS ' + t.pfs : ''}`;
/**
 * 一台設備願意接受的提案。IOS 的 crypto isakmp policy 是整台共用、可以有好幾組；
 * FortiGate 每個通道可以列出好幾組提案與 DH 群組（用 CLI 設定時存在 props / dhs）。兩端只要有一組相同就能談成。
 */
const p1set = (d, t) => {
  if (d.isakmp && d.isakmp.length) return d.isakmp.map(P1);
  const props = t.props && t.props.length ? t.props.map((x) => x.split('-')) : [[t.enc || 'aes128', t.hash || 'sha1']];
  const dhs = t.dhs && t.dhs.length ? t.dhs : [t.dh || '2'];
  return props.flatMap(([e, h]) => dhs.map((g) => `${e.toUpperCase()} / ${h.toUpperCase()} / DH ${g}`));
};
const p2set = (t) => {
  const props = t.props2 && t.props2.length ? t.props2.map((x) => x.split('-')) : [[t.enc2 || t.enc || 'aes128', t.hash2 || t.hash || 'sha1']];
  const pfs = t.pfsList && t.pfsList.length ? t.pfsList : [t.pfs || ''];
  return props.flatMap(([e, h]) => pfs.map((g) => `${e.toUpperCase()} / ${h.toUpperCase()}${g ? ' / PFS ' + g : ''}`));
};
const sameSel = (a, b) => a.length === b.length && a.every((x) => b.some((y) => y.net === x.net && y.bits === x.bits));

// ── IPsec 的時間面 ──
export const IKE_TIME = 2; // 兩個階段協商完成大約要這麼久
/** 第一階段 (IKE SA) 的壽命，預設一天。IOS 的 isakmp policy 整台共用 */
const life1Of = (d, t) => (d.isakmp && d.isakmp.length ? Math.min(...d.isakmp.map((p) => +p.life || 86400)) : +t.life1 || 86400);
/** 第二階段 (IPsec SA) 的壽命：IOS 預設一小時，FortiGate 預設十二小時 */
const life2Of = (d, t) => +t.life2 || +d.ipsecLife || (d.kind === 'firewall' ? 43200 : 3600);
/**
 * 對端失聯之後多久才會發現 (Dead Peer Detection)。回傳 null 代表沒有這個機制，只能等 SA 到期。
 * FortiGate 預設開啟：每 20 秒探測一次、三次沒回應就判定失聯。IOS 要自己設定 crypto isakmp keepalive。
 */
function dpdTime(d, t) {
  if (d.kind === 'firewall') return t.dpd === 'disable' ? null : (+t.dpdRetry || 3) * (+t.dpdInterval || 20);
  const k = d.ikeKeepalive;
  return k && +k.sec > 0 ? +k.sec + 5 * (+k.retry || 2) : null;
}

function tunnelTimers(state, all) {
  const sa = state.dyn.sa, now = state.clock, down = state.down || {}, live = new Set();
  for (const T of all) {
    const d = state.devices[T.dev], key = T.dev + '/' + T.name;
    if (down[T.dev] || state.rt.off[T.dev]) continue; // 設備關機：SA 跟著消失
    let rec = sa[key];
    if (!T.why) {
      const pd = state.devices[T.peer.dev];
      const sig = JSON.stringify([T.peerIp, T.localIp, T.cfg.psk, T.cfg.local, T.cfg.remote, p1set(d, T.cfg), p2set(T.cfg)]);
      // 第一次建立、設定改過、或對端曾經失聯：重新協商
      if (!rec || rec.sig !== sig || rec.lost != null) rec = sa[key] = { sig, since: state.dyn.boot ? -1e9 : now, tx: 0, rx: 0, r1: 0, r2: 0 };
      live.add(key);
      rec.life1 = Math.min(life1Of(d, T.cfg), life1Of(pd, T.peer.cfg));
      rec.life2 = Math.min(life2Of(d, T.cfg), life2Of(pd, T.peer.cfg));
      const ready = rec.since + IKE_TIME;
      if (now < ready) {
        T.nego = ready - now;
        T.why = `IKE 協商中，再 ${Math.ceil(T.nego)} 秒建立`;
        state.rt.pending.push({ at: ready, dev: d.id, kind: 'vpn', text: `${d.name}：VPN 通道「${T.name}」協商中 (IKE)` });
        continue;
      }
      if (rec.t1 == null) rec.t1 = rec.t2 = state.dyn.boot ? now : ready;
      // 金鑰到期就重新協商。新的 SA 先建好才換過去，流量不會中斷
      while (now >= rec.t1 + rec.life1) { rec.t1 += rec.life1; rec.r1++; }
      while (now >= rec.t2 + rec.life2) { rec.t2 += rec.life2; rec.r2++; }
      rec.up = true;
    } else if (rec && rec.up && T.dead) {
      // 對端突然失聯：手上的 SA 還在，封包照樣加密送出去。要等 DPD 探測失敗（或 SA 到期）才會把通道拆掉
      if (rec.lost == null) rec.lost = now;
      const dpd = dpdTime(d, T.cfg);
      const until = dpd != null ? rec.lost + dpd : rec.t2 + rec.life2;
      if (now >= until) continue;
      live.add(key);
      T.stale = { until, why: T.why, dpd: dpd != null };
      T.why = '';
      state.rt.pending.push({ at: until, dev: d.id, kind: 'vpn', text: `${d.name}：還沒發現 VPN 通道「${T.name}」的對端已經失聯（${dpd != null ? 'DPD 探測中' : '沒有設定 keepalive，要等 SA 到期'}）` });
    }
  }
  for (const k of Object.keys(sa)) if (!live.has(k)) delete sa[k];
}

/** 站對站通道目前的 SA：剩餘壽命、重新協商的次數、加解密的封包數。還沒建立就回傳 null */
export function saInfo(state, devId, name) {
  const r = state.dyn && state.dyn.sa && state.dyn.sa[devId + '/' + name];
  if (!r || !r.up) return null;
  const now = state.clock;
  return {
    life1: r.life1, life2: r.life2, left1: Math.ceil(r.t1 + r.life1 - now), left2: Math.ceil(r.t2 + r.life2 - now),
    rekey1: r.r1, rekey2: r.r2, tx: r.tx, rx: r.rx, age: Math.floor(now - r.t2), lost: r.lost != null ? Math.floor(now - r.lost) : null,
  };
}
const tunIface = (id, label) => ({ id, label, bind: { t: 'tun' }, rt: { ip: null, vips: [], link: true }, nat: false });

function prepTunnels(state) {
  const devs = Object.values(state.devices);
  const all = [];
  for (const d of devs) {
    for (const t of d.vpns || []) {
      const name = t.name || 'VPN';
      const T = {
        name, cfg: t, dev: d.id, up: false, why: '', local: cidrList(t.local), remote: cidrList(t.remote),
        iface: tunIface('vpn:' + name, 'VPN ' + name), peerIp: parseIp(t.peer || ''), localIp: null,
      };
      d.rt.tunnels.push(T);
      all.push(T);
      if (t.off) T.why = '通道已停用';
      else if (T.peerIp == null) T.why = '尚未設定對端的公用 IP';
      else if (!T.local.length || !T.remote.length) T.why = '尚未設定本地 / 遠端網段';
      else if (!t.psk) T.why = '尚未設定預先共用金鑰 (PSK)';
      else {
        const r = lookupRoute(d, T.peerIp);
        if (!r) T.why = `沒有通往對端 ${fmtIp(T.peerIp)} 的路由`;
        else if (t.cmap && r.iface.cmap !== t.cmap) T.why = `crypto map ${t.cmap} 還沒有套用到對外的介面 ${r.iface.label}（在介面模式下輸入 crypto map ${t.cmap}）`;
        else T.localIp = r.iface.rt.ip;
      }
    }
  }
  for (const T of all) {
    if (T.why) continue;
    const pd = findOwner(state, T.peerIp);
    const P = pd && all.find((x) => x.dev === pd.id && x.peerIp === T.localIp);
    if (!pd) { T.why = `對端 ${fmtIp(T.peerIp)} 沒有回應`; T.dead = true; }
    else if (!P) T.why = `${pd.name} 上沒有指向 ${fmtIp(T.localIp)} 的通道設定`;
    else if (P.cfg.off) T.why = `${pd.name} 那一端的通道已停用`;
    else if (P.cfg.psk !== T.cfg.psk) T.why = '兩端的預先共用金鑰 (PSK) 不一致 — IKE 驗證失敗';
    else if (!p1set(state.devices[T.dev], T.cfg).some((x) => p1set(pd, P.cfg).includes(x))) T.why = `第一階段的加密提案不一致（本端 ${p1set(state.devices[T.dev], T.cfg).join('、')}，對端 ${p1set(pd, P.cfg).join('、')}）— IKE 協商失敗`;
    else if (!p2set(T.cfg).some((x) => p2set(P.cfg).includes(x))) T.why = `第二階段 (IPsec) 的加密提案不一致（本端 ${p2set(T.cfg).join('、')}，對端 ${p2set(P.cfg).join('、')}）— IKE 通過了，但資料通道建不起來`;
    else if (!sameSel(T.local, P.remote) || !sameSel(T.remote, P.local)) T.why = '兩端的本地 / 遠端網段沒有互相對應';
    else {
      const r = transact(state, T.dev, { proto: 'udp', dst: T.peerIp, dport: 500, quiet: true });
      if (!r.ok) { T.why = 'IKE 封包到不了對端：' + r.reason; T.dead = true; }
      else T.peer = P;
    }
  }
  tunnelTimers(state, all);
  for (const T of all) {
    T.up = !T.why;
    T.cfg.rt = { up: T.up, why: T.why, nego: T.nego || 0, stale: T.stale ? T.stale.until : 0, staleWhy: T.stale ? T.stale.why : '' };
  }

  // 遠端存取 VPN（用戶端撥入）
  const old = state.vpnLeases || {};
  state.vpnLeases = {};
  for (const d of devs) {
    const c = d.vpnClient;
    if (!c) continue;
    d.rt.vpn = { up: false, why: '' };
    if (!c.on) { d.rt.vpn.why = '尚未連線'; continue; }
    const server = parseIp(c.server || '');
    if (server == null) { d.rt.vpn.why = '請填入 VPN 伺服器的位址'; continue; }
    const sd = findOwner(state, server);
    if (sd && !(sd.vpnServer && sd.vpnServer.on)) { d.rt.vpn.why = `${sd.name} 沒有開啟遠端存取 VPN`; continue; }
    // 遠端存取用的是 SSL-VPN：用戶端對伺服器的 TCP 連接埠（預設 10443）建立 TLS 連線
    const res = transact(state, d.id, { proto: 'tcp', dst: server, dport: +c.port || 10443, quiet: true });
    if (!res.ok) { d.rt.vpn.why = '連不到 VPN 伺服器：' + res.reason; continue; }
    const vs = sd.vpnServer;
    if (!c.user || !(vs.users || []).some((u) => u.user === c.user && u.pass === c.pass)) { d.rt.vpn.why = 'VPN 帳號或密碼錯誤'; continue; }
    const subnets = cidrList(vs.subnets);
    if (!subnets.length) { d.rt.vpn.why = `${sd.name} 沒有設定 VPN 用戶可以存取的內部網段`; continue; }
    const key = sd.id;
    const st = { leases: state.vpnLeases };
    const vip = leaseFrom(st, old, key, parseIp(vs.start || ''), parseIp(vs.end || ''), null, d.id);
    if (vip == null) { d.rt.vpn.why = `${sd.name} 的 VPN 位址池還沒設定或已用完`; continue; }
    const mine = [{ net: vip, bits: 32 }];
    d.rt.tunnels.push({ name: 'VPN', dev: d.id, up: true, vip, localIp: res.srcIp, peerIp: server, local: mine, remote: subnets, iface: tunIface('vpn0', 'VPN') });
    sd.rt.tunnels.push({ name: 'ra:' + d.id, dev: sd.id, up: true, localIp: server, peerIp: res.seenSrc, local: subnets, remote: mine, iface: tunIface('vpn:remote', '遠端使用者 VPN') });
    d.rt.vpn = { up: true, vip, server: sd.id };
  }
}

function findTunnel(dev, pkt) {
  let hit = null;
  for (const t of dev.rt.tunnels) {
    if (!selMatch(t.local, pkt.src) || !selMatch(t.remote, pkt.dst)) continue;
    // 用 CLI 建立的 FortiGate 通道是 route-based：除了第二階段的網段要符合，還要有一筆靜態路由把目的地指向通道
    if (t.cfg && t.cfg.manualRoute && !selMatch(cidrList((t.cfg.routes || []).join(',')), pkt.dst)) continue;
    if (t.up) return t;
    hit ||= t;
  }
  return hit;
}

// ───────────────────────────── 重新計算 ─────────────────────────────

// ───────────────────────── 802.1X / RADIUS ─────────────────────────

/** 由驗證者（交換器或基地台）向 RADIUS 伺服器查詢帳密。回傳 null 代表通過，否則回傳原因 */
function radiusCheck(state, nas, user, pass) {
  const r = nas.radius || {};
  const ip = parseIp(r.ip || '');
  if (ip == null) return `${nas.name} 還沒有設定 RADIUS 伺服器`;
  const res = transact(state, nas.id, { proto: 'udp', dst: ip, dport: 1812, quiet: true });
  if (!res.ok) return `${nas.name} 連不到 RADIUS 伺服器 ${fmtIp(ip)}（${res.reason}）`;
  const srv = state.devices[res.responder].radiusServer;
  if (!r.secret || r.secret !== srv.secret) return `${nas.name} 與 RADIUS 伺服器的共用密鑰 (shared secret) 不一致`;
  if (!user) return '用戶端沒有提供帳號';
  if (!(srv.users || []).some((u) => u.user === user && u.pass === pass)) return `RADIUS 拒絕了帳號「${user}」：帳號或密碼錯誤`;
  return null;
}

function computeAuth(state) {
  const auth = { dot1x: {}, ent: {} };
  const res = (why) => (why ? { ok: false, why } : { ok: true });
  for (const d of Object.values(state.devices)) {
    if (isVlanSw(d)) {
      for (const [pid, pc] of Object.entries(d.sw.ports)) {
        if (!pc.dot1x) continue;
        const l = state.rt.links[d.id + ':' + pid];
        const h = l && state.devices[l.dev];
        const sup = (h && h.dot1x) || {};
        auth.dot1x[d.id + ':' + pid] = res(!l ? '沒有設備接上' : h.kind !== 'host' ? `對面的 ${h.name} 不是支援 802.1X 的終端設備`
          : !sup.user ? `${h.name} 沒有提供 802.1X 帳號` : radiusCheck(state, d, sup.user, sup.pass));
      }
    }
    for (const i of d.ifaces) {
      if (i.bind.t !== 'wlan' || !i.wifi || !i.wifi.ssid) continue;
      const key = d.id + '/' + i.id;
      for (const ap of apsOf(state)) {
        if (distOf(d, ap) > apRange(ap) || !ap.wifi.ssids.some((s) => !s.off && s.name === i.wifi.ssid && s.sec === 'wpa2ent')) continue;
        if (auth.ent[key] && auth.ent[key].ok) continue;
        auth.ent[key] = res(radiusCheck(state, ap, i.wifi.user, i.wifi.pass));
      }
    }
  }
  return auth;
}

/** DAI：交換器在不信任的埠上，只接受和 DHCP Snooping 綁定表相符的 ARP */
function daiBlock(state, path, srcIf, dstIf) {
  const on = (d) => isVlanSw(d) && d.sw.dai && d.sw.dai.on;
  const bound = (i) => i.rt.src === 'dhcp';
  for (const h of path) {
    if (h.wifi) continue;
    const a = state.devices[h.to], b = state.devices[h.from];
    if (on(a) && !a.sw.ports[h.toPort].trust && !bound(srcIf)) return `ARP 被 ${a.name} 的 Dynamic ARP Inspection 丟棄：${h.toPort} 不是信任埠，而且來源沒有 DHCP 綁定紀錄`;
    if (on(b) && !b.sw.ports[h.fromPort].trust && !bound(dstIf)) return `${state.devices[path[path.length - 1].to].name} 的 ARP 回應被 ${b.name} 的 Dynamic ARP Inspection 丟棄：${h.fromPort} 不是信任埠，而且它沒有 DHCP 綁定紀錄`;
  }
  return null;
}

/** 設定或接線變動後呼叫：重新計算所有執行期狀態 */
export function recompute(state) {
  if (typeof state.clock !== 'number') state.clock = 0;
  if (!state.dyn) state.dyn = { boot: true }; // 第一次計算：目前的狀態當作已經運作很久
  for (const k of ['port', 'adj', 'lsa', 'vrrp', 'lease', 'hold', 'arp', 'mac', 'ct', 'sa', 'clk', 'log', 'syslog', 'ev', 'vty', 'login']) state.dyn[k] ||= {};
  // 擷取到的封包、命令列上的輸出可能很多，而且和這次計算無關：先拿出來，算完再放回去
  const side = {};
  for (const k of ['cap', 'con']) if (state.dyn[k]) { side[k] = state.dyn[k]; delete state.dyn[k]; }
  // 還在開機的設備：這一次計算把它當成關機（沒有燈號、不轉送、不回應），算完再把 state.down 還原
  const booting = opsBefore(state), realDown = state.down, ids = Object.keys(booting);
  if (ids.length) state.down = { ...(realDown || {}), ...Object.fromEntries(ids.map((id) => [id, true])) };
  try {
    let auth = { dot1x: {}, ent: {} };
    // 802.1X 可能要算好幾輪。前幾輪只是試算，計時的狀態以最後一輪為準，所以每一輪都從同一份起點開始
    const dyn0 = JSON.stringify(state.dyn);
    for (let round = 0; round < 3; round++) {
      if (round) state.dyn = JSON.parse(dyn0);
      computePass(state, auth);
      const next = computeAuth(state);
      if (JSON.stringify(next) === JSON.stringify(auth)) break;
      auth = next; // 802.1X 的結果改變了連接埠的狀態，要重算一次
    }
    if (state.v6) recompute6(state);
    state.rt.booting = booting;
    for (const id of ids) if (isFinite(booting[id])) state.rt.pending.push({ at: state.clock + booting[id], dev: id, kind: 'boot', text: `${state.devices[id].name}：開機中` });
    state.rt.rommon = Object.fromEntries(ids.filter((id) => !isFinite(booting[id])).map((id) => [id, state.dyn.clk[id].rommon.why]));
    Object.assign(state.dyn, side);
    opsAfter(state);
    background(state, { isBridge: isBridgePort, ospfOn, uptime0: UPTIME0 });
    flowsTick(state);
  } finally {
    if (realDown === undefined) delete state.down; else state.down = realDown;
  }
  delete state.dyn.boot;
  return state;
}

function computePass(state, auth) {
  const devs = Object.values(state.devices);
  const down = state.down || {};
  state.rt = { links: {}, off: {}, clients: {}, cable: {}, why: {}, auth, wait: {}, pending: [] };
  for (const d of devs) {
    d.rt = { routes: [], nbrs: [], tunnels: [], lag: {}, err: {}, stp: null, interf: [], vpn: null, unauth: null, wait: {} };
    if (isVlanSw(d)) {
      for (const [pid, pc] of Object.entries(d.sw.ports)) {
        const a = auth.dot1x[d.id + ':' + pid];
        if (pc.dot1x && !(a && a.ok)) (d.rt.unauth ||= {})[pid] = (a && a.why) || '等待 802.1X 驗證';
      }
    }
    for (const i of d.ifaces) {
      i.rt = { ip: null, bits: 0, gw: null, dns: [], src: null, note: '', active: ifaceActive(d, i), link: true, mac: ifaceMac(d, i), vips: [], assoc: null };
    }
  }
  prepPhysical(state);
  prepLag(state);
  prepStp(state);
  prepStpTimers(state);
  prepWifi(state);
  for (const d of devs) {
    const dead = down[d.id] || state.rt.off[d.id];
    for (const i of d.ifaces) {
      const b = i.bind;
      if (dead) i.rt.link = false;
      else if (b.t === 'port' || b.t === 'sub') i.rt.link = !!state.rt.links[d.id + ':' + b.port];
      else if (b.t === 'wlan') i.rt.link = !!i.rt.assoc;
      if (!i.rt.active || i.mode !== 'static') continue;
      const ip = parseIp(i.ip), bits = parseMask(i.mask);
      if (ip == null || bits == null) continue;
      const prob = hostAddrProblem(ip, bits);
      if (prob) { i.rt.note = prob; continue; }
      Object.assign(i.rt, { ip, bits, src: 'static', gw: parseIp(i.gateway), dns: dnsList(i.dns) });
    }
  }
  for (const d of devs) {
    for (const n of d.staticNat || []) {
      const pub = parseIp(n.pub || '');
      const i = pub != null && d.ifaces.find((x) => x.rt.ip != null && x.rt.ip !== pub && sameNet(pub, x.rt.ip, x.rt.bits));
      if (i) i.rt.vips.push(pub); // 讓這個介面替靜態 NAT 的公用 IP 回應 ARP
    }
  }
  const old = state.leases || {};
  state.leases = {};
  // 伺服器手上還沒到期的租約：就算用戶端現在不在線上，那個位址也不會發給別人
  const now = state.clock;
  for (const [key, tbl] of Object.entries(old)) {
    const hold = (state.dyn.hold[key] ||= {});
    for (const [ck, ip] of Object.entries(tbl)) {
      if (!state.devices[ck.slice(0, ck.indexOf('/'))]) { delete hold[ck]; continue; } // 設備已經不存在
      if (!hold[ck] || hold[ck].ip !== ip) hold[ck] = { ip, t0: now, exp: now + leaseLen(state, key) }; // 舊存檔，或關卡預先放進去的租約
      if (hold[ck].exp > now) (state.leases[key] ||= {})[ck] = ip; else delete hold[ck];
    }
    for (const ck of Object.keys(hold)) if (!(ck in tbl)) delete hold[ck];
  }
  const dyn = (i) => i.rt.active && i.rt.ip == null && !i.released && (i.mode === 'dhcp' || i.mode === 'pppoe');
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const d of devs) for (const i of d.ifaces) if (dyn(i) && acquire(state, old, d, i)) changed = true;
    if (!changed) break;
  }
  prepVrrp(state);
  routesAll(state);
  let again = relayPass(state, old);
  for (const d of devs) {
    for (const i of d.ifaces) {
      if (!dyn(i) || i.mode !== 'dhcp' || !i.rt.link) continue;
      // 這一次沒有要到位址。手上的租約還沒到期的話繼續用（伺服器暫時連不到並不會讓電腦馬上斷線）
      const ck = d.id + '/' + i.id, L = state.dyn.lease[ck];
      if (L && L.exp > now && state.devices[L.server]) {
        Object.assign(i.rt, { ip: L.ip, bits: L.bits, gw: L.gw, dns: L.dns, src: 'dhcp', server: L.server, relay: L.relay, exp: L.exp, held: i.rt.note || 'DHCP 伺服器沒有回應' });
        if (L.key) (state.leases[L.key] ||= {})[ck] = L.ip;
        again = true;
        continue;
      }
      delete state.dyn.lease[ck];
      if (d.kind !== 'host') continue;
      const h = hash(d.id + i.id);
      Object.assign(i.rt, { ip: parseIp(`169.254.${(h % 254) + 1}.${((h >>> 8) % 254) + 1}`), bits: 16, src: 'apipa' });
      again = true;
    }
  }
  if (again) routesAll(state);
  // IP 位址衝突：同一個廣播網域裡有另一個介面用了一樣的 IP
  for (const d of devs) {
    for (const i of d.ifaces) {
      if (i.rt.ip == null || !i.rt.link || i.rt.src === 'apipa') continue;
      const dup = l2Explore(state, d.id, i).find((e) => e.iface.rt.ip === i.rt.ip);
      if (dup) i.rt.conflict = dup.dev;
    }
  }
  prepTunnels(state);
  // 介面斷線時，從那個介面學到的 ARP 項目會被清掉
  for (const d of devs) {
    const cache = state.dyn.arp[d.id];
    if (!cache) continue;
    for (const [ip, e] of Object.entries(cache)) {
      const i = d.ifaces.find((x) => x.id === e.i);
      if (!i || !i.rt.link || down[d.id]) delete cache[ip];
    }
  }
  // MAC 位址表：連接埠斷線時，從那個埠學到的位址馬上清掉；設備關機整張表就沒了。
  // 生成樹的拓撲一變 (Topology Change)，所有交換器都會把學到的位址清掉重學
  const stpSig = devs.filter(isVlanSw).map((d) => d.id + ':' + (d.rt.stp && d.rt.stp.blocked ? [...d.rt.stp.blocked].sort().join(',') : '')).join(';');
  const tc = state.dyn.stpSig != null && state.dyn.stpSig !== stpSig;
  state.dyn.stpSig = stpSig;
  for (const d of devs) {
    const tbl = state.dyn.mac[d.id];
    if (tbl) {
      if (down[d.id] || state.rt.off[d.id] || tc) delete state.dyn.mac[d.id];
      else for (const [k, e] of Object.entries(tbl)) if (now - e.t >= macAgeOf(d) || (e.port !== 'wlan' && !state.rt.links[d.id + ':' + e.port])) delete tbl[k];
    }
    // 連線表：閒置太久的項目移除
    const ct = state.dyn.ct[d.id];
    if (ct) {
      if (down[d.id] || state.rt.off[d.id]) delete state.dyn.ct[d.id];
      else state.dyn.ct[d.id] = ct.filter((e) => now - e.t < sessionTtl(d, e));
    }
  }
  return state;
}

// ───────────────────────────── 封包轉送 ─────────────────────────────

const SERVICES = {
  ALL: () => true,
  PING: (p) => p.proto === 'icmp',
  HTTP: (p) => p.proto === 'tcp' && p.dport === 80,
  HTTPS: (p) => p.proto === 'tcp' && p.dport === 443,
  DNS: (p) => p.dport === 53 && (p.proto === 'udp' || p.proto === 'tcp'),
  SSH: (p) => p.proto === 'tcp' && p.dport === 22,
  MYSQL: (p) => p.proto === 'tcp' && p.dport === 3306,
  RDP: (p) => p.proto === 'tcp' && p.dport === 3389,
  SMB: (p) => p.proto === 'tcp' && p.dport === 445,
};
export const SERVICE_NAMES = Object.keys(SERVICES);
const MGMT = { 22: ['ssh', 'SSH'], 23: ['telnet', 'Telnet'], 80: ['http', 'HTTP'], 443: ['https', 'HTTPS'] };

/** 政策的服務欄位可以列出好幾個服務 */
const svcMatch = (spec, pkt) => {
  const list = String(spec || 'ALL').split(/[,\s]+/).filter((s) => SERVICES[s.toUpperCase()]);
  return !list.length || list.some((s) => SERVICES[s.toUpperCase()](pkt));
};

/**
 * 防火牆每個介面各自決定開放哪些管理協定（FortiGate 的 allowaccess）。
 * 還沒有個別設定過的介面沿用舊的規則：WAN 只看 ping 的開關，其他介面依管理頁的全域開關。
 */
export function accessOf(dev, i) {
  if (Array.isArray(i.access)) return i.access;
  const mgmt = /^wan/.test(i.id) ? [] : ['https', 'ssh', 'http', 'telnet'].filter((k) => dev.mgmt && dev.mgmt[k]);
  return [...(i.ping !== false ? ['ping'] : []), ...mgmt];
}

function addrMatch(spec, ip) {
  const s = String(spec || '').trim().toLowerCase();
  if (s === '' || s === 'any' || s === 'all') return true;
  return selMatch(cidrList(s), ip);
}

/** 無狀態 ACL：回傳 null 代表放行，否則回傳被拒絕的原因 */
function aclCheck(list, pkt) {
  if (!list || !list.length) return null;
  for (let n = 0; n < list.length; n++) {
    const r = list[n];
    if (r.proto && r.proto !== 'ip' && r.proto !== pkt.proto) continue;
    if (!addrMatch(r.src, pkt.src) || !addrMatch(r.dst, pkt.dst)) continue;
    if (r.port && (pkt.proto === 'tcp' || pkt.proto === 'udp') && +r.port !== pkt.dport) continue;
    hit(r);
    return r.action === 'permit' ? null : `ACL 第 ${n + 1} 條規則拒絕了這個封包`;
  }
  return 'ACL 沒有任何規則符合，隱含拒絕 (implicit deny any)';
}

function pktDesc(p) {
  const what =
    p.proto === 'icmp' ? (p.reply ? 'ICMP Echo Reply' : 'ICMP Echo Request')
      : p.proto === 'tcp' ? (p.ack ? `TCP ACK → 埠 ${p.dport}` : p.reply ? `TCP SYN-ACK（來自埠 ${p.sport}）` : `TCP SYN → 埠 ${p.dport}`)
        : p.proto === 'esp' ? 'ESP 加密封包'
          : (p.reply ? `UDP 回應（來自埠 ${p.sport}）` : `UDP → 埠 ${p.dport}`);
  return `${what}　${fmtIp(p.src)} → ${fmtIp(p.dst)}`;
}

function isLocal(dev, ip) {
  if (dev.ifaces.some((i) => i.rt.ip === ip || i.rt.vips.includes(ip))) return true;
  if (dev.rt.tunnels.some((t) => t.vip === ip)) return true;
  return dev.kind === 'internet' && dev.inet.hosts.some((h) => parseIp(h.ip) === ip);
}

function findOwner(state, ip) {
  for (const d of Object.values(state.devices)) if (isLocal(d, ip)) return d;
  return null;
}

/** 這台設備身上如果有一條「有原因的」斷線（被 shutdown、對面關機、線太長），附在錯誤訊息後面 */
function deadLink(state, dev) {
  const c = state.cables.find((x) => (x.a.dev === dev.id || x.b.dev === dev.id) && state.rt.why[x.id]);
  return c ? `（${state.rt.why[c.id]}）` : '';
}

function noRouteReason(state, dev, dst) {
  const bad = dev.rt.routes.find((r) => r.bad && r.bits === 0);
  if (dev.kind === 'host') {
    const i = dev.ifaces.find((x) => x.rt.ip != null && x.rt.link);
    if (!i) {
      const cfg = dev.ifaces.find((x) => x.rt.ip != null);
      if (cfg && cfg.bind.t === 'wlan') return `${dev.name} 的 Wi-Fi 沒有連線：${cfg.rt.note || '尚未連上基地台'}`;
      if (cfg) {
        const cb = state.cables.find((c) => (c.a.dev === dev.id && c.a.port === cfg.bind.port) || (c.b.dev === dev.id && c.b.port === cfg.bind.port));
        return cb ? `${dev.name} 的網路孔沒有燈號：${state.rt.why[cb.id] || '對端的連接埠被停用，或對端設備沒有電'}` : `${dev.name} 的網路線沒有接上`;
      }
      const n = dev.ifaces.map((x) => x.rt.note).find(Boolean);
      return `${dev.name} 還沒有 IP 位址${n ? '（' + n + '）' : ''}`;
    }
    if (i.rt.src === 'apipa') return `${dev.name} 只拿到 APIPA 位址 ${fmtIp(i.rt.ip)}，代表 DHCP 沒有成功${i.rt.note ? '（' + i.rt.note + '）' : ''}`;
    if (bad) return `${dev.name} 的${bad.bad}`;
    return `${fmtIp(dst)} 不在 ${dev.name} 自己的子網路內，而且沒有設定預設閘道`;
  }
  if (bad) return `${dev.name} 的${bad.bad}${deadLink(state, dev)}`;
  const forming = (dev.rt.nbrs || []).filter((n) => n.state === 'forming');
  if (forming.length) return `${dev.name} 的路由表裡還沒有通往 ${fmtIp(dst)} 的路由：OSPF 鄰居關係還在建立，再 ${Math.ceil(Math.max(...forming.map((n) => n.left)))} 秒才會交換路由`;
  const wan = dev.ifaces.find((x) => x.rt.ip == null && x.rt.note && (x.mode === 'dhcp' || x.mode === 'pppoe'));
  return `${dev.name} 的路由表裡沒有通往 ${fmtIp(dst)} 的路由${wan ? `（${wan.label}：${wan.rt.note}）` : deadLink(state, dev)}`;
}

function arpFail(state, dev, outIf, nh, viaGw, eps) {
  const b = outIf.bind;
  if ((b.t === 'port' || b.t === 'sub') && !state.rt.links[dev.id + ':' + b.port]) return `${dev.name} 的 ${outIf.label} 沒有連線`;
  const owner = findOwner(state, nh);
  const who = viaGw ? `下一站（閘道）${fmtIp(nh)}` : fmtIp(nh);
  if (eps.dot1x) return `ARP 沒有回應：連接埠還沒有通過 802.1X 驗證（${eps.dot1x}）`;
  if (eps.ps) return `ARP 沒有回應：${dev.name} 的訊框被 ${eps.ps} 的 Port Security 擋下（不是允許的 MAC 位址）`;
  if (!owner) return `ARP 沒有回應：找不到 ${who}，沒有任何設備使用這個 IP`;
  if (eps.span) return `ARP 沒有回應：${state.devices[eps.span.dev].name} 的 ${eps.span.pid} 是 SPAN（連接埠鏡像）的目的埠。交換器只會從這個埠送出複製的訊框，接在上面的設備送進來的封包一律不轉送`;
  if (eps.stp) {
    const s = eps.stp;
    return `${state.devices[s.dev].name} 的 ${s.pid} 剛連上，還在 STP 的${s.left > 15 ? ' listening ' : s.left > 2 ? ' learning ' : '協商'}狀態，再 ${Math.ceil(s.left)} 秒才會開始轉送資料${s.left > 2 ? '（接電腦或伺服器的埠可以啟用 PortFast，跳過這段等待）' : ''}`;
  }
  // 路徑上如果有沒燈號的線，把原因一起說出來
  const dead = state.cables.find((c) => state.rt.why[c.id]);
  const extra = dead ? `。另外，${state.devices[dead.a.dev].name} ↔ ${state.devices[dead.b.dev].name} 的連線沒有燈號：${state.rt.why[dead.id]}` : '';
  return `ARP 沒有回應：${owner.name} 是 ${fmtIp(nh)}，但從 ${dev.name} 的第二層（接線 / VLAN / 無線）到不了它${extra}`;
}

/**
 * 從 outIf 出去時要不要做 NAT。路由器可以用 ACL 指定哪些流量才轉換（ip nat inside source list），
 * 或在圖形介面填「NAT 例外」的目的網段；兩者都沒有就是全部轉換。
 */
function natPermits(dev, outIf, pkt) {
  if (selMatch(cidrList(outIf.natSkip), pkt.dst)) return false;
  const rules = outIf.natAcl && (dev.aclDefs || {})[outIf.natAcl];
  return !rules || !rules.length || aclCheck(rules, pkt) === null;
}

function matchPortForward(dev, inIf, pkt) {
  for (const f of dev.portForwards || []) {
    if (f.off || (f.proto || 'tcp') !== pkt.proto || +f.port !== pkt.dport) continue;
    const ext = parseIp(f.extIp || '');
    if (ext != null ? ext !== pkt.dst : pkt.dst !== inIf.rt.ip) continue;
    const ip = parseIp(f.toIp);
    if (ip == null) continue;
    return { ip, port: +(f.toPort || f.port) };
  }
  return null;
}

function filter(dev, inIf, outIf, pkt, dnat) {
  if (dev.kind === 'homerouter') {
    if (inIf.id === 'wan' && !dnat) return { ok: false, reason: `${dev.name} 的防火牆擋下來自 WAN 的主動連線（沒有對應的連接埠轉發）` };
    return { ok: true, nat: outIf.nat };
  }
  if (dev.kind === 'firewall') {
    const list = dev.policies || [];
    for (let n = 0; n < list.length; n++) {
      const p = list[n];
      if (p.off) continue;
      if (p.srcIf !== 'any' && p.srcIf !== inIf.id) continue;
      if (p.dstIf !== 'any' && p.dstIf !== outIf.id) continue;
      if (!addrMatch(p.src, pkt.src) || !addrMatch(p.dst, pkt.dst)) continue;
      if (!svcMatch(p.service, pkt)) continue;
      hit(p);
      if (p.action === 'accept') return { ok: true, nat: !!p.nat, rule: n + 1 };
      return { ok: false, rule: n + 1, reason: `${dev.name} 的政策 #${n + 1}「${p.name || '未命名'}」拒絕了這個連線` };
    }
    return { ok: false, reason: `${dev.name} 沒有符合的政策（${inIf.label} → ${outIf.label}），預設全部拒絕 (implicit deny)` };
  }
  return { ok: true, nat: outIf.nat };
}

function deliver(dev, inIf, pkt) {
  const ok = { ok: true, dev: dev.id };
  const no = (reason) => ({ ok: false, dev: dev.id, reason });
  if (pkt.proto === 'esp') {
    const t = dev.rt.tunnels.find((x) => x.up && x.peerIp === pkt.src);
    return t ? { ok: true, dev: dev.id, tun: t } : no(`${dev.name} 收到來源不明的加密封包，直接丟棄`);
  }
  if (pkt.reply) return ok;
  const PROTO = pkt.proto.toUpperCase();
  if (dev.kind === 'internet') {
    const h = dev.inet.hosts.find((x) => parseIp(x.ip) === pkt.dst);
    if (pkt.proto === 'icmp') return ok;
    if (h && h.services.some((s) => s.proto === pkt.proto && s.port === pkt.dport)) return ok;
    return no(`${h ? h.name : fmtIp(pkt.dst)} 沒有在 ${PROTO}/${pkt.dport} 提供服務`);
  }
  const owner = dev.ifaces.find((i) => i.rt.ip === pkt.dst);
  const fromWan = inIf && /^wan/.test(inIf.id) && (dev.kind === 'firewall' || dev.kind === 'homerouter');
  if (pkt.proto === 'icmp') {
    if (dev.kind === 'firewall' && owner && inIf === owner && !accessOf(dev, owner).includes('ping')) return no(`${dev.name} 的 ${owner.label} 介面沒有開放 ping（allowaccess 裡沒有 ping）`);
    if (dev.kind !== 'firewall' && owner && owner.ping === false && inIf === owner) return no(`${dev.name} 的 ${owner.label} 介面不回應來自外部的 ping（安全性預設值）`);
    return ok;
  }
  if (pkt.proto === 'udp') {
    if (pkt.dport === 53 && dev.dnsProxy && !fromWan) return ok;
    if (pkt.dport === 67 && dev.dhcpScopes) return ok;
    if ((pkt.dport === 1812 || pkt.dport === 1813) && dev.radiusServer) return ok;
    if ((pkt.dport === 500 || pkt.dport === 4500) && dev.vpns && dev.vpns.length) return ok;
    if (pkt.dport === 123 && dev.rt.ntpServe) return ok; // 設成 ntp master，或自己已經對好時的設備可以替別人報時
    if (pkt.dport === 161 && dev.mgmt && agentOn(dev)) {
      // FortiGate 每個介面要在 allowaccess 開放 snmp，代理才會回答
      if (dev.kind === 'firewall' && inIf && !accessOf(dev, inIf).includes('snmp')) return no(`${dev.name} 的 ${inIf.label} 介面沒有開放 SNMP（allowaccess 裡沒有 snmp）`);
      return ok;
    }
  }
  if (pkt.proto === 'tcp' && dev.vpnServer && dev.vpnServer.on && pkt.dport === (+dev.vpnServer.port || 10443)) return ok; // SSL-VPN
  if (pkt.proto === 'tcp' && dev.mgmt && MGMT[pkt.dport]) {
    const [k, name] = MGMT[pkt.dport];
    if (dev.kind === 'firewall' && inIf) {
      if (!accessOf(dev, inIf).includes(k)) return no(`${dev.name} 的 ${inIf.label} 介面沒有開放 ${name} 管理（allowaccess 裡沒有 ${k}）`);
    } else {
      if (!dev.mgmt[k]) return no(`${dev.name} 沒有開啟 ${name} 管理服務（連線被拒絕）`);
      if (fromWan) return no(`${dev.name} 的管理介面不對 WAN 開放`);
      // IOS 沒有 RSA 金鑰就沒有 SSH 伺服器在聽
      const cisco = !dev.locked && CATALOG[dev.model].vendor === 'Cisco' && ['router', 'mswitch', 'l3switch'].includes(dev.kind);
      if (k === 'ssh' && cisco && !(dev.mgmt.sshKey && dev.mgmt.sshKey.bits >= 768)) {
        return no(`${dev.name} 的 SSH 沒有啟用（連線被拒絕）：${dev.mgmt.sshKey ? 'RSA 金鑰只有 ' + dev.mgmt.sshKey.bits + ' 位元，SSH 2 至少要 768' : '還沒有 RSA 金鑰。先設定 ip domain name，再 crypto key generate rsa modulus 2048'}`);
      }
    }
    if (!addrMatch(String(dev.mgmt.allow || '').replace(/[,\s]+/g, ','), pkt.src)) return no(`來源 ${fmtIp(pkt.src)} 不在 ${dev.name} 允許管理的位址範圍內`);
    return ok;
  }
  if (pkt.proto === 'tcp' && pkt.dport === 5201 && dev.kind === 'host') return ok; // 每台主機都當作有跑 iperf3 -s，可以拿來測速
  if ((dev.services || []).some((s) => s.proto === pkt.proto && s.port === pkt.dport)) return ok;
  return no(`${dev.name} 沒有在 ${PROTO}/${pkt.dport} 提供服務（連線被拒絕）`);
}

function forward(state, ctx, startId, pkt) {
  const { log, hops } = ctx;
  let dev = state.devices[startId];
  let inIf = null;
  const drop = (reason) => {
    log.push({ dev: dev.id, kind: 'drop', text: reason });
    return { ok: false, dev: dev.id, reason };
  };
  if ((state.down || {})[dev.id]) return drop(`${dev.name} 已經關機`);
  if (state.rt.rommon && state.rt.rommon[dev.id]) return drop(`${dev.name} 停在 ROMMON，沒有開機成功：${state.rt.rommon[dev.id]}`);
  if (state.rt.booting && state.rt.booting[dev.id] > 0) return drop(`${dev.name} 還在開機中（還要 ${Math.ceil(state.rt.booting[dev.id])} 秒）`);
  if (state.rt.off[dev.id]) return drop(`${dev.name} 沒有電 — 它需要接在有 PoE 供電的連接埠上`);
  for (let n = 0; n < 48; n++) {
    let established = false, dnat = null;
    const o = { src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport };
    const stateful = dev.kind === 'firewall' || dev.kind === 'homerouter';
    // FortiGate 的 diagnose debug flow：記下這個封包在防火牆裡的每一步
    const tr = !QUIET && inIf ? flowTraceStart(state, dev, pkt) : null;
    const T = (fn, msg) => { if (tr) tr(fn, msg); };
    // IOS 的 debug ip packet / debug ip icmp
    const dbg = !QUIET ? debugOf(state, dev.id) : null;
    const D = (what, text) => { if (dbg && dbg[what]) debugLog(state, dev, text); };
    if (inIf) {
      if (tr) {
        const n = PROTO_NUM[pkt.proto] || 0, dp = pkt.proto === 'icmp' ? (pkt.reply ? 0 : 2048) : pkt.dport;
        const extra = pkt.proto === 'icmp' ? ` type=${pkt.reply ? 0 : 8}, code=0, id=${pkt.reply ? pkt.dport : pkt.sport}, seq=1.`
          : pkt.proto === 'tcp' ? ` flag [${pkt.data ? 'P.' : pkt.ack ? '.' : pkt.reply ? 'S.' : 'S'}], seq 1, ack ${pkt.ack || pkt.reply ? 1 : 0}, win 64240` : '';
        T('print_pkt_detail', `vd-root:0 received a packet(proto=${n}, ${fmtIp(pkt.src)}:${pkt.sport}->${fmtIp(pkt.dst)}:${dp}) tun_id=0.0.0.0 from ${inIf.id.replace(/^vpn:/, '')}.${extra}`);
      }
      const deny = aclCheck(inIf.aclIn, pkt);
      if (deny) {
        D('packet', `IP: s=${fmtIp(pkt.src)} (${longIf(inIf.label)}), d=${fmtIp(pkt.dst)}, len ${ipLen(pkt)}, access denied`);
        return drop(`${dev.name} 的 ${inIf.label}（進入方向）：${deny}`);
      }
      const ct = ctx.ct[dev.id];
      const e = ct && ct.find((x) => x.proto === pkt.proto && x.nDst === pkt.src && x.nSrc === pkt.dst && x.nDport === pkt.sport && x.nSport === pkt.dport);
      // 同一條連線後續的封包（三向交握的 ACK）：有連線紀錄的設備直接比對紀錄，套用同樣的位址轉換，不再重新比對政策
      const flow = !pkt.reply && pkt.ack && ct && ct.find((x) => x.proto === pkt.proto && x.src === pkt.src && x.sport === pkt.sport && x.dst === pkt.dst && x.dport === pkt.dport);
      if (flow) {
        established = true;
        T('resolve_ip_tuple_fast', `Find an existing session, id-${sessId(flow)}, original direction`);
        flow.t = state.clock; flow.st = 'est';
        pkt.src = flow.nSrc; pkt.sport = flow.nSport; pkt.dst = flow.nDst; pkt.dport = flow.nDport;
      } else if (e && pkt.reply) {
        established = true;
        T('resolve_ip_tuple_fast', `Find an existing session, id-${sessId(e)}, reply direction`);
        if (e.nSrc !== e.src) T('__ip_session_run_tuple', `DNAT ${fmtIp(pkt.dst)}:${pkt.dport}->${fmtIp(e.src)}:${e.sport}`);
        e.t = state.clock; // 有封包經過，閒置的計時重新開始
        if (e.src !== pkt.dst || e.dst !== pkt.src) {
          log.push({ dev: dev.id, kind: 'nat', text: `NAT 還原：${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}　改回　${fmtIp(e.dst)} → ${fmtIp(e.src)}` });
        }
        pkt.src = e.dst; pkt.sport = e.dport; pkt.dst = e.src; pkt.dport = e.sport;
      } else if (!pkt.reply) {
        const sn = (dev.staticNat || []).find((x) => parseIp(x.pub || '') === pkt.dst && parseIp(x.priv || '') != null);
        dnat = sn ? { ip: parseIp(sn.priv), port: pkt.dport, stat: true } : matchPortForward(dev, inIf, pkt);
        if (dnat) {
          sess(dev, { act: 'dnat', proto: pkt.proto, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport, ndst: dnat.ip, ndport: dnat.port });
          log.push({ dev: dev.id, kind: 'nat', text: dnat.stat ? `靜態 NAT：目的位址 ${fmtIp(pkt.dst)} 換成 ${fmtIp(dnat.ip)}` : `連接埠轉發：${fmtIp(pkt.dst)}:${pkt.dport} → ${fmtIp(dnat.ip)}:${dnat.port}` });
          pkt.dst = dnat.ip; pkt.dport = dnat.port;
        }
      }
      if (dev.kind === 'internet' && !pkt.reply && isPrivate(pkt.src)) {
        return drop(`來源 ${fmtIp(pkt.src)} 是私有 IP，ISP 直接丟棄 — 出口路由器沒有做 NAT`);
      }
      if (isLocal(dev, pkt.dst)) {
        T('vf_ip_route_input_common', `find a route: flag=84000000 gw-${fmtIp(pkt.dst)} via root`);
        const r = deliver(dev, inIf, pkt);
        if (!r.ok) { log.push({ dev: dev.id, kind: 'drop', text: r.reason }); T('fw_local_in_handler', 'iprope_in_check() check failed on policy 0, drop'); }
        else if (pkt.proto !== 'esp') {
          D('packet', `IP: s=${fmtIp(pkt.src)} (${longIf(inIf.label)}), d=${fmtIp(pkt.dst)} (${longIf(inIf.label)}), len ${ipLen(pkt)}, rcvd 3`);
          if (pkt.proto === 'icmp') D('icmp', pkt.reply ? `ICMP: echo reply rcvd, src ${fmtIp(pkt.src)}, dst ${fmtIp(pkt.dst)}, topology BASE, dscp 0 topoid 0` : `ICMP: echo reply sent, src ${fmtIp(pkt.dst)}, dst ${fmtIp(pkt.src)}, topology BASE, dscp 0 topoid 0`);
        }
        return r;
      }
      if (!dev.routing) return drop(`${dev.name} 收到不是給自己的封包（目的 ${fmtIp(pkt.dst)}），它不是路由器所以直接丟棄`);
      if (--pkt.ttl <= 0) return drop('TTL 歸零，封包被丟棄（可能有路由迴圈）');
      if (!pkt.reply && !pkt.ack && pkt.proto !== 'esp') ctx.l3.push({ dev: dev.id, ip: inIf.rt.ip });
    } else if (isLocal(dev, pkt.dst)) {
      return { ok: true, dev: dev.id };
    }

    // VPN：符合通道的本地 / 遠端網段就加密後送給對端
    let tun = pkt.proto !== 'esp' && findTunnel(dev, pkt);
    if (tun && dev.kind === 'router' && inIf && !pkt.reply && tun.up) {
      // 路由器的處理順序是「先 NAT，再比對要不要加密」。來源位址一旦被換掉，就不再符合 VPN 的加密範圍
      const wan = lookupRoute(dev, tun.peerIp);
      if (wan && wan.iface !== inIf && wan.iface.nat && natPermits(dev, wan.iface, pkt)) {
        log.push({ dev: dev.id, kind: 'info', text: `注意：${dev.name} 會先做 NAT 再檢查 VPN。這個封包的來源會被換成 ${wan.iface.label} 的位址，就不符合通道「${tun.name}」的加密範圍了 — 往對端內網的流量要設成 NAT 例外` });
        tun = null;
      }
    }
    // 已經建立的連線，半路上的封包來到防火牆時連線表裡卻沒有它（閒置太久被移除了）：FortiGate 不會把它當成新連線
    if (tr && !established && !pkt.reply && !ctx.mid) T('init_ip_session_common', `allocate a new session-${sessId({ proto: pkt.proto, ...o })}, tun_id=0.0.0.0`);
    const lostSession = () => (T('ip_session_handler', 'no session matched'), drop(`${dev.name} 的連線表裡已經沒有這條連線：閒置超過 ${sessionTtl(dev, { proto: 'tcp', st: 'est' })} 秒就會被移除。防火牆不會讓半路出現、不是 SYN 的 TCP 封包通過，直接丟棄 (no session matched)`));
    if (tun) {
      if (!tun.up) return drop(`VPN 通道「${tun.name}」沒有建立：${tun.why}`);
      if (inIf && !established && ctx.mid && dev.kind === 'firewall') return lostSession();
      T('vf_ip_route_input_common', `find a route: flag=04000000 gw-${fmtIp(tun.peerIp)} via ${tun.name}`);
      if (inIf && !established) {
        const v = filter(dev, inIf, tun.iface, pkt, dnat);
        T('fw_forward_handler', v.ok ? `Allowed by Policy-${v.rule || 0}:` : `Denied by forward policy check (policy ${v.rule || 0})`);
        if (stateful) sess(dev, { act: v.ok ? 'allow' : 'deny', proto: pkt.proto, ...o, rule: v.rule || 0, inIf: inIf.label, outIf: tun.iface.label });
        if (!v.ok) { denyLog(state, dev, pkt, o, inIf, tun.iface, v.rule); return drop(v.reason); }
        if (v.rule) log.push({ dev: dev.id, kind: 'fwd', text: `符合政策 #${v.rule}，放行（${inIf.label} → ${tun.iface.label}）` });
        if (!pkt.reply && stateful) track(state, ctx, dev, { proto: pkt.proto, ...o, nSrc: pkt.src, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport, inIf: inIf.label, outIf: tun.iface.label, rule: v.rule || 0 });
      }
      const ssl = !tun.cfg; // 遠端存取是 SSL-VPN（包在 TLS 裡），站對站是 IPsec（包在 ESP 裡）
      T('ipsecdev_hard_start_xmit', `enter IPsec interface-${tun.name}`);
      T('esp_output4', `IPsec encrypt/auth`);
      T('ipsec_output_finish', `send to ${fmtIp(tun.peerIp)} via intf-${tun.cfg && tun.cfg.wan ? tun.cfg.wan : 'wan1'}`);
      log.push({ dev: dev.id, kind: 'vpn', text: `加密：整個封包包進 ${ssl ? 'TLS（SSL-VPN 的 TCP 連線）' : 'ESP'}，外層位址 ${fmtIp(tun.localIp)} → ${fmtIp(tun.peerIp)}` });
      const r = forward(state, ctx, dev.id, { proto: 'esp', src: tun.localIp, dst: tun.peerIp, sport: 0, dport: 0, ttl: 64, reply: pkt.reply, ssl, spi: hash(dev.id + '/' + tun.name) });
      if (!r.ok) {
        if (!tun.stale) return r;
        return drop(`VPN 通道「${tun.name}」在 ${dev.name} 上看起來還是 Up（SA 還沒過期），封包照樣加密送了出去，但對端已經失聯：${tun.stale.why}。${dev.name} 還要 ${fmtDur(tun.stale.until - state.clock)} 才會發現${tun.stale.dpd ? '（DPD 探測中）' : '（沒有設定 keepalive，只能等 SA 到期）'}`);
      }
      if (!QUIET && tun.cfg) {
        // 加密、解密的封包數（show crypto ipsec sa 的 #pkts encaps / decaps）
        const sa1 = state.dyn.sa[dev.id + '/' + tun.name], sa2 = r.tun && state.dyn.sa[r.dev + '/' + r.tun.name];
        if (sa1) sa1.tx++;
        if (sa2) sa2.rx++;
      }
      dev = state.devices[r.dev];
      inIf = r.tun.iface;
      log.push({ dev: dev.id, kind: 'vpn', text: `解密：還原出內層封包 ${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}（從 ${inIf.label} 進來）` });
      continue;
    }

    if (dev.kind === 'internet' && isPrivate(pkt.dst)) {
      return drop(`${fmtIp(pkt.dst)} 是私有 IP，在網際網路上無法路由（上一台路由器把它交給了預設路由 — 是不是少了通往這個網段的路由或 VPN？）`);
    }

    const route = lookupRoute(dev, pkt.dst);
    if (!route) {
      D('packet', `IP: s=${fmtIp(pkt.src)} (${inIf ? longIf(inIf.label) : 'local'}), d=${fmtIp(pkt.dst)}, len ${ipLen(pkt)}, unroutable`);
      return drop(noRouteReason(state, dev, pkt.dst));
    }
    const outIf = route.iface;
    const nh = route.via ?? pkt.dst;
    // 路由器自己送出的封包才會出現在 debug ip packet；經過它轉送的封包由 CEF 處理，不會出現
    if (!inIf) D('packet', `IP: s=${fmtIp(pkt.src)} (local), d=${fmtIp(pkt.dst)} (${longIf(outIf.label)}), len ${ipLen(pkt)}, sending`);


    if (inIf && !established && ctx.mid && dev.kind === 'firewall') return lostSession();
    T('vf_ip_route_input_common', `find a route: flag=04000000 gw-${fmtIp(nh)} via ${outIf.id}`);
    if (inIf && !established) {
      const v = filter(dev, inIf, outIf, pkt, dnat);
      T('fw_forward_handler', v.ok ? `Allowed by Policy-${v.rule || 0}:${v.nat ? ' SNAT' : ''}` : `Denied by forward policy check (policy ${v.rule || 0})`);
      if (stateful && !ctx.mid) sess(dev, { act: v.ok ? 'allow' : 'deny', proto: pkt.proto, ...o, rule: v.rule || 0, inIf: inIf.label, outIf: outIf.label });
      if (!v.ok) { denyLog(state, dev, pkt, o, inIf, outIf, v.rule); return drop(v.reason); }
      if (v.rule) log.push({ dev: dev.id, kind: 'fwd', text: `符合政策 #${v.rule}，放行（${inIf.label} → ${outIf.label}）` });
      if (!pkt.reply) {
        let nSrc = pkt.src;
        const st = (dev.staticNat || []).find((x) => parseIp(x.priv || '') === pkt.src && outIf.rt.vips.includes(parseIp(x.pub || '')));
        if (st) nSrc = parseIp(st.pub); // 靜態 NAT 的主機固定用自己的公用 IP 出去
        else if (v.nat && outIf !== inIf && outIf.rt.ip != null && natPermits(dev, outIf, pkt)) nSrc = outIf.rt.ip;
        if (nSrc !== pkt.src || dnat || stateful) {
          track(state, ctx, dev, { proto: pkt.proto, ...o, nSrc, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport, inIf: inIf.label, outIf: outIf.label, rule: v.rule || 0 });
        }
        if (nSrc !== pkt.src) {
          T('__ip_session_run_tuple', `SNAT ${fmtIp(pkt.src)}->${fmtIp(nSrc)}:${pkt.sport}`);
          sess(dev, { act: 'snat', proto: pkt.proto, src: pkt.src, sport: pkt.sport, nsrc: nSrc, dst: pkt.dst, dport: pkt.dport });
          log.push({ dev: dev.id, kind: 'nat', text: `NAT：來源位址 ${fmtIp(pkt.src)} 換成 ${fmtIp(nSrc)}（${outIf.label}）` });
          pkt.src = nSrc;
        }
      }
    }
    if (inIf) {
      const deny = aclCheck(outIf.aclOut, pkt);
      if (deny) return drop(`${dev.name} 的 ${outIf.label}（離開方向）：${deny}`);
    }

    const eps = l2Explore(state, dev.id, outIf);
    if (eps.storm) return drop(`廣播風暴！${state.devices[eps.storm].name} 所在的網段形成了迴圈，訊框不斷繞圈把網路塞爆`);
    const cands = eps.filter((e) => e.iface.rt.ip === nh || e.iface.rt.vips.includes(nh));
    let tgt = null, dai = null;
    for (const e of cands) {
      const blk = daiBlock(state, e.path, outIf, e.iface);
      if (!blk) { tgt = e; break; }
      dai ||= blk;
    }
    // 真實網路裡，第一次要和某個 IP 通訊前得先用 ARP 廣播問出它的 MAC；問到之後會記在 ARP 快取裡
    const cache = (state.dyn.arp[dev.id] ||= {});
    const known = cache[nh];
    // 快取裡有、還沒過期、而且那個 MAC 現在仍然是這個 IP 的主人，才不用重新詢問
    const needArp = !(known && state.clock - known.t < arpTtl(dev) && cands.some((e) => answerMac(e, nh) === known.mac));
    if (needArp) {
      log.push({ dev: dev.id, kind: 'arp', text: `ARP 廣播：誰是 ${fmtIp(nh)}？同一個廣播網域的每台設備都會收到` });
      const wave = buildWave(eps);
      if (wave.length) hops.push({ wave, proto: 'arp' });
      for (const e of eps) learnPath(state, e.path, outIf.rt.mac); // 廣播經過的每一台交換器都學到發問者的 MAC
      if (!QUIET) {
        const req = { proto: 'arp', smac: outIf.rt.mac, dmac: BCAST, arp: { op: 1, sip: outIf.rt.ip, tip: nh, sha: outIf.rt.mac } };
        for (const lvl of wave) for (const x of lvl) onHop(state, x, req, null);
      }
    }
    if (!tgt) return drop(dai || arpFail(state, dev, outIf, nh, route.via != null, eps));
    const tmac = answerMac(tgt, nh);
    if (!needArp) known.t = state.clock; // 有流量在走，項目就會一直被確認、不會過期
    if (needArp) {
      cache[nh] = { mac: tmac, t: state.clock, i: outIf.id };
      if (outIf.rt.ip != null) (state.dyn.arp[tgt.dev] ||= {})[outIf.rt.ip] = { mac: outIf.rt.mac, t: state.clock, i: tgt.iface.id }; // 被問的那一方也順便記下發問者
      log.push({ dev: tgt.dev, kind: 'arp', text: `ARP 回覆：${fmtIp(nh)} 的 MAC 位址是 ${tmac}${tmac === VRRP_MAC ? '（VRRP 的虛擬 MAC）' : ''}（${dev.name} 記入 ARP 快取）` });
      for (const h of [...tgt.path].reverse()) hops.push({ cable: h.cable, wifi: h.wifi, from: h.to, to: h.from, tag: h.tag, reply: true, proto: 'arp' });
      learnPath(state, reversed(tgt.path), tmac); // ARP 回覆是單點傳送：沿路的交換器學到回覆者的 MAC
      if (!QUIET) {
        const rep = { proto: 'arp', smac: tmac, dmac: outIf.rt.mac, arp: { op: 2, sip: nh, tip: outIf.rt.ip, sha: tmac } };
        for (const x of reversed(tgt.path)) onHop(state, x, rep, null);
      }
    }
    if (cands.length > 1 && !dai) {
      log.push({ dev: dev.id, kind: 'info', text: `注意：這個網段上有 ${cands.length} 台設備都聲稱自己是 ${fmtIp(nh)}（IP 衝突或 ARP 欺騙），封包被送往最先回應的 ${state.devices[tgt.dev].name}` });
    }
    const names = [dev.name, ...tgt.path.map((h) => state.devices[h.to].name)];
    const tags = [...new Set(tgt.path.map((h) => h.tag).filter((t) => t != null))];
    log.push({
      dev: dev.id, kind: 'l2',
      text: (route.via != null ? `查路由 → 下一站 ${fmtIp(nh)}：` : '') + names.join(' → ') + (tags.length ? `　[802.1Q VLAN ${tags.join(',')}]` : '')
        + (tgt.path.some((h) => h.wifi) ? '　[Wi-Fi]' : ''),
      // 這一段第二層旅程上的訊框內容，給「封包檢視」用
      frame: { smac: outIf.rt.mac, dmac: tmac, tags, src: pkt.src, dst: pkt.dst, ttl: pkt.ttl, proto: pkt.proto, sport: pkt.sport, dport: pkt.dport, reply: pkt.reply, ack: !!pkt.ack, ssl: !!pkt.ssl, wifi: tgt.path.some((h) => h.wifi) },
    });
    // 沿路的交換器從進來的埠學到來源 MAC。目的 MAC 不在表裡（太久沒看到而過期）的話，只能往整個 VLAN 泛洪
    const keys = learnPath(state, tgt.path, outIf.rt.mac);
    let leaked = false, flooded = false;
    tgt.path.forEach((h, n) => {
      const hub = hubLeak(state, tgt.path, n);
      let leak = hub;
      const sw = state.devices[h.from];
      if (n > 0 && !h.wifi && learns(sw) && keys[n - 1] != null && !macKnown(state, sw, keys[n - 1], tmac)) {
        const extra = floodPorts(state, sw, keys[n - 1], tgt.path[n - 1].toPort, h.fromPort);
        if (extra.length) leak = [...(leak || []), ...extra];
        if (!flooded) {
          flooded = true;
          log.push({ dev: sw.id, kind: 'info', text: `${sw.name} 的 MAC 位址表裡沒有 ${tmac}（超過 ${macAgeOf(sw)} 秒沒看到它送出的訊框，項目已經過期）：不知道它在哪個埠，只好送往這個 VLAN 的每一個埠 (unknown unicast flooding)。對方一回覆，交換器就會重新學起來` });
        }
      }
      if (hub && !leaked) {
        leaked = true;
        log.push({ dev: h.from, kind: 'info', text: `${state.devices[h.from].name} 是 Hub：訊框被複製到其他所有連接埠，${leak.map((x) => state.devices[x.to].name).join('、')} 也收到了，發現不是給自己的就丟棄` });
      }
      hops.push({ ...h, reply: pkt.reply, proto: pkt.proto, ssl: !!pkt.ssl, leak });
      if (!QUIET) {
        onHop(state, h, {
          proto: pkt.proto, smac: outIf.rt.mac, dmac: tmac, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport, ttl: pkt.ttl,
          reply: !!pkt.reply, ack: !!pkt.ack, ssl: !!pkt.ssl, data: pkt.data || null, spi: pkt.spi,
        }, leak);
      }
    });
    dev = state.devices[tgt.dev];
    inIf = tgt.iface;
  }
  return drop('封包繞了太多站仍未抵達（路由迴圈）');
}

// ───────────────────── 連線紀錄、命中次數、廣播 ─────────────────────

// ── 連線表：防火牆的 session、路由器的 NAT 轉換 ──
// 每一筆都有閒置逾時：沒有新的封包經過，時間到就從表裡移除。
const SESSION_TTL = {
  // 路由器 (IOS)：ip nat translation 的預設值
  router: { tcp: 86400, syn: 60, fin: 60, udp: 300, dns: 60, icmp: 60 },
  // FortiGate：session-ttl 預設 3600 秒、UDP 180 秒、半開的連線 10 秒
  firewall: { tcp: 3600, syn: 10, fin: 120, udp: 180, dns: 180, icmp: 60 },
  // 家用路由器
  homerouter: { tcp: 1800, syn: 120, fin: 120, udp: 180, dns: 180, icmp: 30 },
};
/** 這一筆連線可以閒置多久（秒）。可以用 ip nat translation … 或 config system session-ttl 調整 */
export function sessionTtl(dev, e) {
  const base = SESSION_TTL[dev.kind] || SESSION_TTL.router, o = dev.natTimeout || {};
  const k = e.proto === 'tcp' ? (e.st === 'est' ? 'tcp' : e.st === 'fin' ? 'fin' : 'syn') : e.proto === 'udp' ? (e.dport === 53 ? 'dns' : 'udp') : 'icmp';
  return +o[k] > 0 ? +o[k] : base[k];
}
function track(state, ctx, dev, e) {
  (ctx.ct[dev.id] ||= []).push(e);
  if (QUIET) return;
  e.t0 = e.t = state.clock;
  e.st = e.proto === 'tcp' ? (ctx.mid ? 'est' : 'syn') : 'new';
  if (ctx.cid) e.cid = ctx.cid; // 屬於哪一條長時間保持的連線（SSH / Telnet）
  const tbl = (state.dyn.ct[dev.id] ||= []);
  tbl.push(e);
  if (tbl.length > 200) tbl.shift();
}
/** 連線表目前的內容（過期的不算），最新的在前面。left 是還能閒置幾秒 */
export function sessionRows(state, dev) {
  const now = state.clock;
  return ((state.dyn && state.dyn.ct && state.dyn.ct[dev.id]) || [])
    .map((e) => { const ttl = sessionTtl(dev, e); return { ...e, ttl, left: Math.ceil(ttl - (now - e.t)), age: Math.floor(now - e.t0) }; })
    .filter((e) => e.left > 0).reverse();
}
/** clear ip nat translation * / diagnose sys session clear */
export function clearSessions(state, dev) { if (state.dyn && state.dyn.ct) delete state.dyn.ct[dev.id]; }

const PROTO_NUM = { icmp: 1, tcp: 6, udp: 17, esp: 50 };
/** IP 封包的長度（debug ip packet 的 len） */
const ipLen = (p) => (p.proto === 'icmp' ? 60 : p.proto === 'tcp' ? (p.data ? 96 : p.ack ? 40 : 44) : p.proto === 'udp' ? 68 : 120);
/** FortiGate 連線的編號（同一條連線固定） */
const sessId = (e) => hash(`${e.proto}|${e.src}|${e.sport}|${e.dst}|${e.dport}`).toString(16).padStart(8, '0');
/** 防火牆拒絕連線時留下的流量紀錄（會送到 Syslog 伺服器） */
function denyLog(state, dev, pkt, o, inIf, outIf, rule) {
  if (QUIET || dev.kind !== 'firewall') return;
  logEvent(state, dev, 5, '', '', `logid="0000000013" type="traffic" subtype="forward" level="notice" vd="root" srcip=${fmtIp(o.src)} srcport=${o.sport} srcintf="${inIf.id}" dstip=${fmtIp(o.dst)} dstport=${o.dport} dstintf="${outIf.id}" policyid=${rule || 0} proto=${PROTO_NUM[pkt.proto] || 0} action="deny"`);
}

let QUIET = false; // 引擎內部的控制流量（IKE、RADIUS、DHCP Relay）不記入紀錄
let logSeq = 0;
const LOGS = new WeakMap(), HITS = new WeakMap();
/** 設備最近處理過的連線（防火牆放行 / 拒絕、NAT 轉換），最新的在前面 */
export const sessionLog = (dev) => LOGS.get(dev) || [];
/** 某條政策或 ACL 規則被命中的次數 */
export const hitsOf = (rule) => HITS.get(rule) || 0;
export const clearSessionLog = (dev) => { LOGS.delete(dev); };
function sess(dev, e) {
  if (QUIET) return;
  let l = LOGS.get(dev);
  if (!l) LOGS.set(dev, (l = []));
  l.unshift({ n: ++logSeq, ...e });
  if (l.length > 40) l.pop();
}
function hit(rule) { if (!QUIET) HITS.set(rule, (HITS.get(rule) || 0) + 1); }

/** 把廣播會走到的每一段線，依距離分層（給動畫一波一波播放） */
function buildWave(eps) {
  const levels = [], seen = new Set();
  for (const e of eps) {
    e.path.forEach((h, n) => {
      const k = (h.cable || 'air:' + h.from + ':' + h.to) + '>' + h.to;
      if (seen.has(k)) return;
      seen.add(k);
      (levels[n] ||= []).push({ cable: h.cable, wifi: h.wifi, from: h.from, fromPort: h.fromPort, to: h.to, toPort: h.toPort, tag: h.tag });
    });
  }
  return levels.filter(Boolean);
}

/** Hub 不看位址：訊框從它送出時，其他有接線的埠也會收到一份 */
function hubLeak(state, path, n) {
  const h = path[n], hub = state.devices[h.from];
  if (!hub || hub.kind !== 'hub') return undefined;
  const inPort = n > 0 ? path[n - 1].toPort : null;
  const out = [];
  for (const p of hub.ports) {
    if (p.id === h.fromPort || p.id === inPort) continue;
    const l = state.rt.links[hub.id + ':' + p.id];
    if (l) out.push({ cable: l.cable, from: hub.id, to: l.dev });
  }
  return out.length ? out : undefined;
}



/** DHCP 的四個步驟 (DORA)：依目前的租約重建過程，給動畫與終端機的 ipconfig /renew 用 */
export function dhcpTrace(state, devId) {
  const d = state.devices[devId];
  const log = [], hops = [];
  const i = d.ifaces.find((x) => x.rt.src === 'dhcp') || d.ifaces.find((x) => x.mode === 'dhcp' && x.rt.active && x.rt.link) || d.ifaces.find((x) => x.mode === 'dhcp');
  if (!i) return { ok: false, reason: `${d.name} 沒有設成「自動取得 IP (DHCP)」`, log, hops };
  const eps = i.rt.link ? l2Explore(state, d.id, i) : [];
  const wave = buildWave(eps);
  log.push({ dev: d.id, kind: 'dhcp', text: 'DHCP Discover（廣播）：我需要一個 IP，有 DHCP 伺服器嗎？' });
  if (wave.length) hops.push({ wave, proto: 'dhcp' });
  // 線路上真正的 DHCP 訊框（計數器、封包擷取）
  const xid = hash(d.id + '/' + i.id + '@' + Math.floor(state.clock)).toString(16).padStart(8, '0');
  const bcast = (type) => ({ proto: 'dhcp', smac: i.rt.mac, dmac: BCAST, src: 0, dst: 0xffffffff, sport: 68, dport: 67, dhcp: { type, xid } });
  for (const lvl of wave) for (const x of lvl) onHop(state, x, bcast('discover'), null);
  if (i.rt.src !== 'dhcp') {
    const reason = i.rt.note || 'DHCP 沒有回應';
    log.push({ dev: d.id, kind: 'drop', text: reason });
    return { ok: false, reason, log, hops, iface: i };
  }
  const sd = state.devices[i.rt.server];
  const via = i.rt.relay ? state.devices[i.rt.relay] : sd;
  const e = eps.find((x) => x.dev === via.id && (i.rt.relay ? x.iface.helper : x.iface.line || (x.iface.dhcp && x.iface.dhcp.on))) || eps.find((x) => x.dev === via.id);
  const back = e ? [...e.path].reverse().map((h) => ({ cable: h.cable, wifi: h.wifi, from: h.to, to: h.from, tag: h.tag, reply: true, proto: 'dhcp' })) : [];
  if (i.rt.relay) log.push({ dev: via.id, kind: 'dhcp', text: `DHCP Relay：${via.name} 把廣播改成單點傳送，轉交給 ${sd.name}` });
  log.push({ dev: sd.id, kind: 'dhcp', text: `DHCP Offer：${sd.name} 提供 ${fmtIp(i.rt.ip)}` });
  hops.push(...back);
  const uni = (type) => ({ proto: 'dhcp', smac: e ? e.iface.rt.mac : '', dmac: i.rt.mac, src: e ? e.iface.rt.ip : 0, dst: i.rt.ip, sport: 67, dport: 68, dhcp: { type, xid, ip: i.rt.ip } });
  if (e) for (const x of reversed(e.path)) onHop(state, x, uni('offer'), null);
  log.push({ dev: d.id, kind: 'dhcp', text: `DHCP Request（廣播）：我要使用 ${fmtIp(i.rt.ip)}` });
  if (wave.length) hops.push({ wave, proto: 'dhcp' });
  for (const lvl of wave) for (const x of lvl) onHop(state, x, bcast('request'), null);
  log.push({ dev: sd.id, kind: 'ok', text: `DHCP Ack：租約成立 — ${fmtIp(i.rt.ip)}/${i.rt.bits}、閘道 ${i.rt.gw != null ? fmtIp(i.rt.gw) : '無'}、DNS ${i.rt.dns.map(fmtIp).join(', ') || '無'}` });
  hops.push(...back);
  if (e) for (const x of reversed(e.path)) onHop(state, x, uni('ack'), null);
  return { ok: true, log, hops, iface: i };
}

let pktSeq = 0;

/**
 * 模擬一次「請求 + 回應」。spec: { proto:'icmp'|'tcp'|'udp', dst:number, dport?, srcIp? }
 * 回傳 { ok, reason, failDev, phase, responder, srcIp, seenSrc, log, hops, l3 }
 */
export function transact(state, fromId, spec) {
  const prev = QUIET;
  QUIET = prev || !!spec.quiet;
  try { return transactInner(state, fromId, spec); } finally { QUIET = prev; }
}

/** 還沒過期的連線（每台設備一份），給「在既有的連線上繼續送資料」用 */
function liveSessions(state) {
  const out = {};
  for (const [id, list] of Object.entries(state.dyn.ct || {})) {
    const d = state.devices[id];
    if (d) out[id] = list.filter((e) => state.clock - e.t < sessionTtl(d, e));
  }
  return out;
}

/**
 * 在一條已經建立的 TCP 連線上再送一次資料並等對方回應（例如在 SSH 裡打了一行指令）。
 * flow: { cid, to, src, sport, dst, dport }。路上有狀態的設備如果已經把這條連線忘了，封包會被丟掉。
 */
export function flowSend(state, fromId, flow) {
  const ctx = { ct: liveSessions(state), log: [], hops: [], l3: [], mid: true, cid: flow.cid };
  const done = (r) => ({ ...r, log: ctx.log, hops: ctx.hops, l3: ctx.l3 });
  const pkt = { proto: 'tcp', src: flow.src, dst: flow.dst, sport: flow.sport, dport: flow.dport, ttl: 64, reply: false, ack: true, data: flow.data || null };
  const a = forward(state, ctx, fromId, pkt);
  if (!a.ok) return done({ ok: false, reason: a.reason, failDev: a.dev, phase: 'request' });
  if (a.dev !== flow.to) return done({ ok: false, reason: `封包被送到 ${state.devices[a.dev].name}，不是原本連線的那一台`, failDev: a.dev, phase: 'request' });
  const rp = { proto: 'tcp', src: pkt.dst, dst: pkt.src, sport: pkt.dport, dport: pkt.sport, ttl: 64, reply: true, ack: true, data: flow.echo || null };
  const b = forward(state, ctx, a.dev, rp);
  if (!b.ok) return done({ ok: false, reason: '回程失敗：' + b.reason, failDev: b.dev, phase: 'reply' });
  if (b.dev !== fromId) return done({ ok: false, reason: `回應被送到 ${state.devices[b.dev].name}`, failDev: b.dev, phase: 'reply' });
  return done({ ok: true });
}

/** 連線結束 (FIN)：連線表裡的項目進入關閉中的狀態，很快就會被清掉 */
export function closeFlow(state, cid) {
  for (const list of Object.values((state.dyn && state.dyn.ct) || {})) for (const e of list) if (e.cid === cid) { e.st = 'fin'; e.t = state.clock; }
}

function transactInner(state, fromId, spec) {
  const ctx = { ct: {}, log: [], hops: [], l3: [], cid: spec.keep || null };
  const src = state.devices[fromId];
  const done = (r) => ({ ...r, log: ctx.log, hops: ctx.hops, l3: ctx.l3 });
  let srcIp = spec.srcIp;
  if (srcIp == null) {
    if (isLocal(src, spec.dst)) {
      ctx.log.push({ dev: fromId, kind: 'ok', text: `${fmtIp(spec.dst)} 就是自己，本機迴路成功` });
      return done({ ok: true, responder: fromId });
    }
    const t = src.rt.tunnels.find((x) => x.up && x.vip != null && selMatch(x.remote, spec.dst));
    const r = t ? null : lookupRoute(src, spec.dst);
    if (!t && !r) {
      const reason = state.rt.off[fromId] ? `${src.name} 沒有電` : noRouteReason(state, src, spec.dst);
      ctx.log.push({ dev: fromId, kind: 'drop', text: reason });
      return done({ ok: false, reason, failDev: fromId, phase: 'request' });
    }
    srcIp = t ? t.vip : r.iface.rt.ip;
  }
  const id = 1000 + (pktSeq++ % 20000);
  const icmp = spec.proto === 'icmp';
  const pkt = { proto: spec.proto, src: srcIp, dst: spec.dst, sport: icmp ? id : 30000 + id, dport: icmp ? 0 : spec.dport, ttl: 64, reply: false, data: spec.data || null };
  ctx.log.push({ dev: fromId, kind: 'tx', text: `送出 ${pktDesc(pkt)}` });
  const a = forward(state, ctx, fromId, pkt);
  if (!a.ok) {
    let reason = a.reason;
    const v = src.rt.vpn;
    if (v && !v.up && v.why && isPrivate(spec.dst) && src.vpnClient && a.dev !== fromId) {
      reason = `${src.name} 的 VPN 沒有連上（${v.why}），所以封包沒有走加密通道`;
      ctx.log.push({ dev: fromId, kind: 'drop', text: reason });
    }
    return done({ ok: false, reason, failDev: a.dev, phase: 'request' });
  }

  const rp = { proto: pkt.proto, src: pkt.dst, dst: pkt.src, sport: pkt.dport, dport: pkt.sport, ttl: 64, reply: true };
  ctx.log.push({ dev: a.dev, kind: 'rx', text: `收到請求，回覆 ${pktDesc(rp)}` });
  const b = forward(state, ctx, a.dev, rp);
  if (!b.ok) return done({ ok: false, reason: '回程失敗：' + b.reason, failDev: b.dev, phase: 'reply', responder: a.dev });
  if (b.dev !== fromId) {
    const reason = `回應被送到 ${state.devices[b.dev].name}，而不是 ${src.name}（IP 位址衝突？）`;
    ctx.log.push({ dev: b.dev, kind: 'drop', text: reason });
    return done({ ok: false, reason, failDev: b.dev, phase: 'reply', responder: a.dev });
  }
  const seenSrc = pkt.src;
  if (spec.proto === 'tcp') {
    // TCP 要三個封包才算建立連線：SYN → SYN-ACK → ACK
    const ack = { proto: 'tcp', src: srcIp, dst: spec.dst, sport: 30000 + id, dport: spec.dport, ttl: 64, reply: false, ack: true };
    ctx.log.push({ dev: fromId, kind: 'tx', text: `收到 SYN-ACK，送出 ${pktDesc(ack)}（三向交握的第三步）` });
    const c = forward(state, ctx, fromId, ack);
    if (!c.ok) return done({ ok: false, reason: '三向交握的最後一步 (ACK) 沒有送達：' + c.reason, failDev: c.dev, phase: 'ack', responder: a.dev });
    ctx.log.push({ dev: c.dev, kind: 'ok', text: 'TCP 連線建立完成（SYN → SYN-ACK → ACK），可以開始傳送資料' });
    // 測試用的連線建立之後就由用戶端關閉 (FIN)：連線表裡的項目進入關閉中的狀態，很快就會被清掉
    // 要保持的連線（SSH / Telnet）不關閉，之後每送一次資料，閒置的計時就重新開始
    if (!spec.keep) for (const l of Object.values(ctx.ct)) for (const e of l) if (e.st === 'est') e.st = 'fin';
    return done({ ok: true, responder: a.dev, srcIp, seenSrc, sport: 30000 + id });
  }
  ctx.log.push({ dev: fromId, kind: 'ok', text: '收到回應，連線成功' });
  return done({ ok: true, responder: a.dev, srcIp, seenSrc });
}

function devDns(dev) {
  for (const i of dev.ifaces) if (i.rt.dns && i.rt.dns.length && i.rt.link) return i.rt.dns;
  return [];
}

/** 名稱解析：回傳 { ok, ip, reason, failDev, log, hops } */
export function resolveName(state, devId, name, depth = 0) {
  const dev = state.devices[devId];
  const log = [], hops = [];
  const lit = parseIp(name);
  if (lit != null) return { ok: true, ip: lit, log, hops };
  name = String(name).trim().toLowerCase();
  const fail = (reason, failDev = devId) => {
    log.push({ dev: failDev, kind: 'drop', text: reason });
    return { ok: false, reason, failDev, log, hops };
  };
  if (depth > 3) return fail('DNS 查詢迴圈');
  const servers = devDns(dev);
  if (!servers.length) {
    const up = dev.ifaces.some((i) => i.rt.ip != null && i.rt.link && i.rt.src !== 'apipa');
    return fail(up ? `${dev.name} 沒有設定 DNS 伺服器，無法把 ${name} 轉成 IP 位址` : noRouteReason(state, dev, 0));
  }
  const server = servers[0];
  log.push({ dev: devId, kind: 'dns', text: `向 DNS 伺服器 ${fmtIp(server)} 查詢 ${name}` });
  const r = transact(state, devId, { proto: 'udp', dst: server, dport: 53 });
  log.push(...r.log); hops.push(...r.hops);
  if (!r.ok) return { ok: false, reason: `DNS 查詢失敗：${r.reason}`, failDev: r.failDev, log, hops };
  const sd = state.devices[r.responder];
  let ip = null;
  if (sd.kind === 'internet') ip = parseIp(sd.inet.dns[name] || '');
  else if (sd.dnsProxy) {
    log.push({ dev: sd.id, kind: 'dns', text: `${sd.name} 代為向上游 DNS 查詢` });
    const up = resolveName(state, sd.id, name, depth + 1);
    log.push(...up.log); hops.push(...up.hops);
    if (!up.ok) return { ok: false, reason: up.reason, failDev: up.failDev, log, hops };
    ip = up.ip;
  } else if (sd.dnsRecords) ip = parseIp(sd.dnsRecords[name] || '');
  if (ip == null) return fail(`DNS 伺服器回覆：找不到 ${name} (NXDOMAIN)`, sd.id);
  log.push({ dev: devId, kind: 'dns', text: `${name} = ${fmtIp(ip)}` });
  return { ok: true, ip, log, hops };
}

// ───────────────────────────── 任務目標 ─────────────────────────────

/**
 * 目標格式：
 *  { type:'ping'|'tcp'|'udp', from, to | ip | name, port, expect:true|false, via?:devId }
 *  { type:'dhcp', dev, subnet? }
 *  { type:'check', test(state) → true | '原因' }
 *  { type:'failover', down?:[devId], cut?:[[devId, portId]], test:{...} }
 */
export function runObjective(state, o) {
  if (o.type === 'check') {
    const r = o.test(state);
    return { pass: r === true, ok: r === true, reason: r === true ? '' : r, log: [], hops: [] };
  }
  if (o.type === 'ping6') {
    const expect = o.expect ?? true;
    const dst = o.ip6 ? parseIp6(o.ip6) : globalIp6(state.devices[o.to]);
    if (dst == null) {
      const t = state.devices[o.to];
      const reason = `${t.name} 還沒有 IPv6 位址${t.ifaces.map((i) => i.rt.v6 && i.rt.v6.note).find(Boolean) ? '（' + t.ifaces.map((i) => i.rt.v6 && i.rt.v6.note).find(Boolean) + '）' : ''}`;
      return { pass: !expect, ok: false, reason, failDev: t.id, log: [{ dev: t.id, kind: 'drop', text: reason }], hops: [] };
    }
    const r = transact6(state, o.from, dst);
    return { pass: r.ok === expect, ok: r.ok, reason: r.reason, failDev: r.failDev, log: r.log, hops: r.hops };
  }
  if (o.type === 'dhcp') {
    const d = state.devices[o.dev];
    const i = d.ifaces.find((x) => x.rt.src === 'dhcp') || d.ifaces.find((x) => x.mode === 'dhcp' && x.rt.link) || d.ifaces[0];
    let reason = '';
    if (i.mode !== 'dhcp') reason = `${d.name} 沒有設成「自動取得 IP (DHCP)」`;
    else if (i.rt.src !== 'dhcp') reason = `${d.name} 沒有拿到 DHCP 租約${i.rt.note ? '：' + i.rt.note : ''}`;
    else if (o.subnet) {
      const c = parseCidr(o.subnet);
      if (netOf(i.rt.ip, c.bits) !== c.net) reason = `${d.name} 拿到 ${fmtIp(i.rt.ip)}（由 ${state.devices[i.rt.server].name} 發出），不在 ${o.subnet} 裡`;
    }
    const tr = dhcpTrace(state, o.dev); // 播放 Discover → Offer → Request → Ack
    const log = [...tr.log];
    if (reason && !log.some((l) => l.text === reason)) log.push({ dev: d.id, kind: 'drop', text: reason });
    return { pass: !reason, ok: !reason, reason, failDev: reason ? d.id : null, log, hops: tr.hops };
  }
  if (o.type === 'failover') {
    const s2 = cloneState(state);
    s2.down = { ...(state.down || {}), ...Object.fromEntries((o.down || []).map((id) => [id, true])) };
    s2.cut = {};
    const what = (o.down || []).map((id) => state.devices[id].name + ' 斷電');
    for (const [dv, pid] of o.cut || []) {
      const c = s2.cables.find((x) => (x.a.dev === dv && x.a.port === pid) || (x.b.dev === dv && x.b.port === pid));
      if (c) s2.cut[c.id] = true;
      what.push(`${state.devices[dv].name} 的 ${pid} 斷線`);
    }
    // 故障發生後要等網路重新收斂（VRRP 換手、OSPF 的 Dead timer…）才測試
    recompute(s2);
    const t0 = s2.clock;
    settle(s2);
    const took = Math.round(s2.clock - t0);
    const r = runObjective(s2, o.test);
    r.log.unshift({ dev: (o.down || [])[0] || (o.cut || [[]])[0][0], kind: 'info', text: `故障演練：${what.join('、')}${took ? `；${fmtDur(took)}後網路重新收斂，再進行測試` : ''}` });
    if (!r.pass && r.reason) r.reason = `故障演練（${what.join('、')}）：${r.reason}`;
    return r;
  }
  const from = state.devices[o.from];
  const log = [], hops = [];
  const expect = o.expect ?? true;
  const finish = (ok, reason, failDev) => ({ pass: ok === expect, ok, reason, failDev, log, hops });
  let dst;
  if (o.name) {
    const r = resolveName(state, o.from, o.name);
    log.push(...r.log); hops.push(...r.hops);
    if (!r.ok) return finish(false, r.reason, r.failDev);
    dst = r.ip;
  } else if (o.ip) {
    dst = parseIp(o.ip);
  } else {
    const t = state.devices[o.to];
    const i = o.toIface ? t.ifaces.find((x) => x.id === o.toIface) : primaryIface(t);
    if (!i || i.rt.ip == null) {
      const why = state.rt.off[t.id] ? '它沒有電' : t.ifaces.map((x) => x.rt.note).find(Boolean);
      const reason = `${t.name} 還沒有 IP 位址${why ? '（' + why + '）' : ''}`;
      log.push({ dev: t.id, kind: 'drop', text: reason });
      return finish(false, reason, t.id);
    }
    dst = i.rt.ip;
  }
  const srcIp = o.srcIp ? parseIp(o.srcIp) : from.kind === 'internet' ? parseIp(from.inet.client) : undefined;
  const proto = o.type === 'ping' ? 'icmp' : o.type === 'speed' ? 'tcp' : o.type;
  const r = transact(state, o.from, { proto, dst, dport: o.type === 'speed' ? 5201 : o.port ?? 443, srcIp });
  log.push(...r.log); hops.push(...r.hops);
  if (r.ok && o.type === 'speed') {
    // 傳輸速率測試（iperf3）：連得上之後，看路徑上最慢的那一段
    const t = throughput(state, r.hops), min = o.min || 0, pass = t.mbps >= min;
    log.push({ dev: pass ? o.from : t.dev || o.from, kind: pass ? 'ok' : 'drop', text: `iperf3：${t.mbps} Mbps${t.retr ? `，重傳 ${t.retr} 次` : ''}。最慢的一段是 ${t.where}` });
    if (!pass) return { pass: false, ok: true, reason: `只跑得到 ${t.mbps} Mbps（目標 ${min} Mbps 以上）。最慢的一段：${t.where}`, failDev: t.dev || o.from, log, hops, speed: t };
    return { pass: true, ok: true, reason: '', failDev: null, log, hops, speed: t };
  }
  if (r.ok && o.via) {
    const seen = new Set();
    for (const h of r.hops) if (!h.reply && !h.wave) { seen.add(h.from); seen.add(h.to); }
    if (!seen.has(o.via)) {
      const reason = `連線是通的，但封包沒有經過 ${state.devices[o.via].name}`;
      log.push({ dev: o.from, kind: 'drop', text: reason });
      return { pass: false, ok: true, reason, failDev: o.from, log, hops };
    }
  }
  return finish(r.ok, r.reason, r.failDev);
}

// ───────────────────────── 頻寬 ─────────────────────────

/**
 * 沿著一條已經走通的路徑，估算 TCP 實際跑得到多快。瓶頸是路徑上最慢的那一段：
 * - 全雙工的線大約跑得到標稱速率的九成多（扣掉標頭）。
 * - 半雙工（Hub）同一時間只能有一端在送，還會碰撞，實際只有四成左右。
 * - 雙工不一致：全雙工的那端不會等對方，半雙工的那端不斷碰撞、重傳，幾乎不能用。
 * - Wi-Fi 的實際吞吐量大約是連線速率的一半。
 */
/** 一段線路單方向實際跑得到的速率（Mbps）與說明 */
function linkCap(state, h) {
  const li = linkInfo(state, h.from, h.fromPort);
  if (!li || li.down) return null;
  if (li.mismatch) return { mbps: Math.min(li.speed * 0.01, 2), note: `${li.speed} Mbps，但兩端的雙工不一致 (duplex mismatch)`, loss: 35, retr: 1800 };
  if (li.half) return { mbps: li.speed * 0.4, note: `${li.speed} Mbps 半雙工，會發生碰撞`, loss: 3, retr: 60 };
  return { mbps: li.speed * 0.94, note: `${li.speed >= 1000 ? li.speed / 1000 + ' Gbps' : li.speed + ' Mbps'} 全雙工`, loss: 0, retr: 0 };
}
const dirKey = (h) => h.cable + '>' + h.to;

/**
 * 背景流量（例如夜間備份）：每一條持續地從一台主機送資料到另一個位址。
 * state.flows = [{ id, from, ip, port, mbps（想要的速率）, label, on }]
 * 依路徑上每一段剩下的頻寬分配（小的先滿足，近似 TCP 的公平分享），算進介面計數器，
 * 也記在 state.rt.load：之後的 iperf3、檔案傳輸會和它們搶同一條線
 */
function flowsTick(state) {
  const dyn = state.dyn, now = state.clock;
  const dt = dyn.flowT == null ? 0 : Math.max(0, now - dyn.flowT);
  dyn.flowT = now;
  const load = {}, count = {};
  state.rt.load = load; state.rt.loadN = count;
  const flows = (state.flows || []).filter((f) => f.on !== false && state.devices[f.from]).sort((a, b) => (+a.mbps || 0) - (+b.mbps || 0));
  for (const f of flows) {
    const ip = typeof f.ip === 'number' ? f.ip : parseIp(f.ip || '');
    const res = ip == null ? null : transact(state, f.from, { proto: 'tcp', dst: ip, dport: +f.port || 5201, quiet: true });
    if (!res || !res.ok) { f.rt = { mbps: 0, why: res ? res.reason : '目的位址不正確' }; continue; }
    // TCP 的 SYN 與 ACK 走同一條路：每一段只算一次
    const once = new Set();
    const hops = res.hops.filter((h) => !h.wave && !h.reply && h.proto !== 'arp' && h.cable && !h.wifi && !once.has(dirKey(h)) && once.add(dirKey(h)));
    let rate = Math.max(0, +f.mbps || 0), where = '';
    for (const h of hops) {
      const c = linkCap(state, h);
      if (!c) continue;
      const free = Math.max(0, c.mbps - (load[dirKey(h)] || 0));
      if (free < rate) { rate = free; where = `${state.devices[h.from].name} ↔ ${state.devices[h.to].name}（${c.note}）`; }
    }
    for (const h of hops) { load[dirKey(h)] = (load[dirKey(h)] || 0) + rate; count[dirKey(h)] = (count[dirKey(h)] || 0) + 1; }
    f.rt = { mbps: Math.round(rate * 10) / 10, where, full: rate < (+f.mbps || 0) - 0.5 };
    if (dt > 0) for (const h of hops) countBytes(state, h, (rate * 1e6 * dt) / 8);
  }
}

export function throughput(state, hops) {
  let best = Infinity, where = '', dev = null, loss = 0, retr = 0;
  const seen = new Set();
  for (const h of hops) {
    if (h.wave || h.reply || h.proto === 'arp' || h.proto === 'dhcp') continue;
    let mbps, note;
    if (h.wifi) {
      const a = [state.devices[h.from], state.devices[h.to]].flatMap((d) => d.ifaces).map((i) => i.rt.assoc).find((x) => x && (x.ap === h.from || x.ap === h.to));
      const rate = a ? a.rate : 54;
      mbps = rate * 0.5;
      note = `Wi-Fi 連線速率 ${rate} Mbps${a && a.noisy ? '（頻道互相干擾）' : ''}`;
    } else {
      if (!h.cable || seen.has(h.cable)) continue;
      seen.add(h.cable);
      const c = linkCap(state, h);
      if (!c) continue;
      ({ mbps, note } = c);
      loss = Math.max(loss, c.loss); retr = Math.max(retr, c.retr);
      // 這條線上已經有背景流量：TCP 大致上平分，但別人用不完的也拿得到
      const L = (state.rt.load || {})[dirKey(h)] || 0, n = (state.rt.loadN || {})[dirKey(h)] || 0;
      if (L > 0.5) {
        const share = Math.max(mbps - L, mbps / (n + 1));
        if (share < mbps) { mbps = share; note += `，和 ${n} 條背景流量共用（已經用掉 ${Math.round(L)} Mbps）`; }
      }
    }
    if (mbps < best) { best = mbps; dev = h.from; where = `${state.devices[h.from].name} ↔ ${state.devices[h.to].name}（${note}）`; }
  }
  if (best === Infinity) return { mbps: 0, where: '', dev: null, loss: 0, retr: 0 };
  if (hops.some((h) => h.proto === 'esp')) best *= 0.9; // 加密與多一層標頭的負擔
  return { mbps: best >= 10 ? Math.round(best) : Math.round(best * 10) / 10, where, dev, loss, retr };
}

export function evaluate(state, objectives) {
  return objectives.map((o) => runObjective(state, o));
}

/** 給「狀態」分頁用的路由表文字 */
export function routeRows(dev) {
  const name = { C: '直連', S: '靜態', D: '自動', O: 'OSPF' };
  return dev.rt.routes
    .slice()
    .sort((a, b) => a.ad - b.ad || a.net - b.net)
    .map((r) => ({
      type: r.type, typeName: name[r.type],
      dst: r.bits === 0 ? '0.0.0.0/0（預設）' : `${fmtIp(r.net)}/${r.bits}`,
      via: r.via == null ? '直連' : fmtIp(r.via),
      iface: r.iface ? r.iface.label : '—',
      ad: r.ad, metric: r.metric, bad: r.bad || '',
    }));
}
