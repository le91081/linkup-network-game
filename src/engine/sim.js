// 網路模擬引擎
// L1 供電 / 連線狀態、L2 橋接 / VLAN / STP / LACP / Port Security / DHCP Snooping / Wi-Fi、
// L3 路由 / OSPF / VRRP、DHCP（含 Relay）、PPPoE、NAT、ACL、防火牆政策、IPsec 與遠端存取 VPN、DNS
import { parseIp, fmtIp, parseMask, netOf, sameNet, isPrivate, parseCidr, parseVlanList, hostAddrProblem } from './ip.js';
import { cloneState, primaryIface, CATALOG, CABLES, cableKind, cableDist } from './model.js';
import { recompute6, transact6, globalIp6 } from './sim6.js';
import { parseIp6 } from './ip6.js';

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
  if (d.rt.unauth && d.rt.unauth[pid]) return false; // 802.1X 尚未通過驗證
  const l = d.rt.lag && d.rt.lag[pid];
  return !l || (l.state === 'bundled' && l.carrier);
}
const stpBlocked = (d, pid, v) => !!(d.rt.stp && d.rt.stp.blocked.has(pid + '|' + v));

/** 訊框從某埠進入交換器 → 回傳內部 VLAN 鍵值，或 DROP */
function ingressKey(dev, pid, tag, mac, notes) {
  const sw = dev.sw, pc = sw.ports[pid];
  if (dev.rt.unauth && dev.rt.unauth[pid]) { notes.dot1x = `${dev.name} 的 ${pid}：${dev.rt.unauth[pid]}`; return DROP; }
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

// ───────────────────── 供電、連線、LACP、STP、Wi-Fi ─────────────────────

function prepPhysical(state) {
  const rt = state.rt, down = state.down || {}, cut = state.cut || {};
  const shut = (D, pid) => !!(D.sw && D.sw.ports[pid] && D.sw.ports[pid].shut);
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
      continue;
    }
    const kind = CABLES[cableKind(c)], meters = cableDist(state, c);
    if (meters > kind.max) {
      rt.cable[c.id] = 'down';
      rt.why[c.id] = `${kind.name}最長只能拉 ${kind.max} 公尺，但這兩台設備相距 ${meters} 公尺`;
      continue;
    }
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

function leaseFrom(state, old, key, start, end, exclude, clientKey) {
  if (start == null || end == null || end < start) return null;
  const tbl = (state.leases[key] ||= {});
  const used = new Set(Object.values(tbl));
  if (exclude != null) used.add(exclude);
  let ip = old[key] ? old[key][clientKey] : null;
  if (ip != null && (ip < start || ip > end || used.has(ip))) ip = null;
  if (ip == null) {
    const reserved = new Set(Object.entries(old[key] || {}).filter(([k]) => k !== clientKey).map(([, v]) => v));
    for (let c = start; c <= end && c - start < 4096; c++) if (!used.has(c) && !reserved.has(c)) { ip = c; break; }
    if (ip == null) for (let c = start; c <= end && c - start < 4096; c++) if (!used.has(c)) { ip = c; break; }
  }
  if (ip == null) return null;
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
    if (s.line) return set(parseIp(s.line.assign), s.rt.bits, s.rt.ip, dnsList(s.line.dns), 'dhcp', sd.id);
    const start = parseIp(s.dhcp.start), end = parseIp(s.dhcp.end);
    const inNet = start != null && end != null && sameNet(start, s.rt.ip, s.rt.bits) && sameNet(end, s.rt.ip, s.rt.bits);
    const ip = inNet ? leaseFrom(state, old, sd.id + '/' + s.id, start, end, s.rt.ip, d.id + '/' + i.id) : null;
    if (ip == null) { i.rt.note = `${sd.name} 的 DHCP 位址池設定有誤或已用完`; continue; }
    let dns = dnsList(s.dhcp.dns);
    if (!dns.length && sd.dnsProxy) dns = [s.rt.ip];
    return set(ip, s.rt.bits, parseIp(s.dhcp.gw) ?? s.rt.ip, dns, 'dhcp', sd.id);
  }
  if (!i.rt.note) {
    i.rt.note = !i.rt.link ? (i.bind.t === 'wlan' ? i.rt.note || 'Wi-Fi 尚未連線' : '網路線沒有接上，或對端連接埠沒有啟用')
      : eps.dot1x ? `連接埠還沒有通過 802.1X 驗證（${eps.dot1x}）`
      : snooped ? `${snooped.server.name} 的 DHCP 回應被 ${snooped.by.name} 的 DHCP Snooping 擋下（進來的埠不是信任埠）`
        : eps.some((x) => x.iface.line && x.iface.line.type === 'pppoe') ? 'DHCP 沒有回應：這條 ISP 線路要用 PPPoE 撥接'
          : eps.some((x) => x.iface.line && x.iface.line.type === 'static') ? 'DHCP 沒有回應：這條 ISP 線路是固定 IP，需要手動設定'
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
        const res = transact(state, rd.id, { proto: 'udp', dst: helper, dport: 67, srcIp: r.rt.ip });
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
        changed = true;
        break;
      }
    }
  }
  return changed;
}

function prepVrrp(state) {
  const c = [];
  for (const d of Object.values(state.devices)) {
    for (const i of d.ifaces) {
      if (!i.vrrp || !i.vrrp.on) continue;
      const vip = parseIp(i.vrrp.vip || '');
      if (i.rt.ip == null || !i.rt.link) { i.rt.vrrp = { state: 'init', why: '介面沒有 IP 或沒有連線' }; continue; }
      if (vip == null || !sameNet(vip, i.rt.ip, i.rt.bits)) { i.rt.vrrp = { state: 'init', why: '虛擬 IP 必須和介面位於同一個子網路' }; continue; }
      c.push({ d, i, vip, k: [+i.vrrp.prio || 100, i.rt.ip] });
    }
  }
  for (const x of c) {
    const peers = l2Explore(state, x.d.id, x.i).map((e) => c.find((y) => y.i === e.iface && y.vip === x.vip)).filter(Boolean);
    const top = peers.find((p) => cmp(p.k, x.k) > 0);
    x.i.rt.vrrp = { state: top ? 'backup' : 'master', peers: peers.length };
    if (!top) x.i.rt.vips.push(x.vip);
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

function computeOspf(state) {
  const nodes = Object.values(state.devices).filter((d) => d.ifaces.some((i) => i.ospf && i.rt.ip != null && i.rt.link));
  const adj = {}, nets = {};
  for (const d of nodes) {
    adj[d.id] = []; nets[d.id] = [];
    for (const i of d.ifaces) {
      if (!i.ospf || i.rt.ip == null || !i.rt.link) continue;
      nets[d.id].push({ net: netOf(i.rt.ip, i.rt.bits), bits: i.rt.bits });
      for (const e of l2Explore(state, d.id, i)) {
        const j = e.iface;
        if (!j.ospf || j.rt.ip == null || j.rt.bits !== i.rt.bits || !sameNet(j.rt.ip, i.rt.ip, i.rt.bits)) continue;
        adj[d.id].push({ to: e.dev, iface: i, via: j.rt.ip, cost: Math.max(1, +i.ospfCost || 1) });
      }
    }
    if (d.ospfDefault && d.rt.routes.some((r) => r.bits === 0 && !r.bad && r.type !== 'O')) nets[d.id].push({ net: 0, bits: 0 });
    d.rt.nbrs = adj[d.id].map((a) => ({ dev: a.to, iface: a.iface.id, ip: a.via, cost: a.cost }));
  }
  for (const d of nodes) {
    const dist = { [d.id]: 0 }, first = {}, done = new Set();
    for (;;) {
      let u = null;
      for (const k of Object.keys(dist)) if (!done.has(k) && (u == null || dist[k] < dist[u])) u = k;
      if (u == null) break;
      done.add(u);
      for (const e of adj[u]) {
        const nd = dist[u] + e.cost;
        if (dist[e.to] == null || nd < dist[e.to]) { dist[e.to] = nd; first[e.to] = u === d.id ? e : first[u]; }
      }
    }
    for (const o of nodes) {
      if (o === d || dist[o.id] == null) continue;
      for (const n of nets[o.id]) {
        if (d.rt.routes.some((r) => r.type === 'C' && r.net === n.net && r.bits === n.bits)) continue;
        const metric = dist[o.id] + 1;
        const ex = d.rt.routes.findIndex((r) => r.type === 'O' && r.net === n.net && r.bits === n.bits);
        if (ex >= 0) {
          if (d.rt.routes[ex].metric <= metric) continue;
          d.rt.routes.splice(ex, 1);
        }
        d.rt.routes.push({ net: n.net, bits: n.bits, via: first[o.id].via, iface: first[o.id].iface, type: 'O', ad: 110, metric });
      }
    }
  }
}

function routesAll(state) {
  for (const d of Object.values(state.devices)) buildRoutes(d);
  computeOspf(state);
}

// ───────────────────────────── VPN 通道 ─────────────────────────────

const PROPOSAL = (t) => `${(t.enc || 'aes128').toUpperCase()} / ${(t.hash || 'sha1').toUpperCase()} / DH ${t.dh || '2'}`;
const sameSel = (a, b) => a.length === b.length && a.every((x) => b.some((y) => y.net === x.net && y.bits === x.bits));
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
        else T.localIp = r.iface.rt.ip;
      }
    }
  }
  for (const T of all) {
    if (T.why) continue;
    const pd = findOwner(state, T.peerIp);
    const P = pd && all.find((x) => x.dev === pd.id && x.peerIp === T.localIp);
    if (!pd) T.why = `對端 ${fmtIp(T.peerIp)} 沒有回應`;
    else if (!P) T.why = `${pd.name} 上沒有指向 ${fmtIp(T.localIp)} 的通道設定`;
    else if (P.cfg.off) T.why = `${pd.name} 那一端的通道已停用`;
    else if (P.cfg.psk !== T.cfg.psk) T.why = '兩端的預先共用金鑰 (PSK) 不一致 — IKE 驗證失敗';
    else if (PROPOSAL(P.cfg) !== PROPOSAL(T.cfg)) T.why = `加密提案不一致（本端 ${PROPOSAL(T.cfg)}，對端 ${PROPOSAL(P.cfg)}）— IKE 協商失敗`;
    else if (!sameSel(T.local, P.remote) || !sameSel(T.remote, P.local)) T.why = '兩端的本地 / 遠端網段沒有互相對應';
    else {
      const r = transact(state, T.dev, { proto: 'udp', dst: T.peerIp, dport: 500 });
      if (!r.ok) T.why = 'IKE 封包到不了對端：' + r.reason;
    }
  }
  for (const T of all) { T.up = !T.why; T.cfg.rt = { up: T.up, why: T.why }; }

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
    const res = transact(state, d.id, { proto: 'udp', dst: server, dport: 4500 });
    if (!res.ok) { d.rt.vpn.why = '連不到 VPN 伺服器：' + res.reason; continue; }
    const vs = sd.vpnServer;
    if (!vs || !vs.on) { d.rt.vpn.why = `${sd.name} 沒有開啟遠端存取 VPN`; continue; }
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
  const res = transact(state, nas.id, { proto: 'udp', dst: ip, dport: 1812 });
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
  let auth = { dot1x: {}, ent: {} };
  for (let round = 0; round < 3; round++) {
    computePass(state, auth);
    const next = computeAuth(state);
    if (JSON.stringify(next) === JSON.stringify(auth)) break;
    auth = next; // 802.1X 的結果改變了連接埠的狀態，要重算一次
  }
  if (state.v6) recompute6(state);
  return state;
}

function computePass(state, auth) {
  const devs = Object.values(state.devices);
  const down = state.down || {};
  state.rt = { links: {}, off: {}, clients: {}, cable: {}, why: {}, auth };
  for (const d of devs) {
    d.rt = { routes: [], nbrs: [], tunnels: [], lag: {}, err: {}, stp: null, interf: [], vpn: null, unauth: null };
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
  const dyn = (i) => i.rt.active && i.rt.ip == null && (i.mode === 'dhcp' || i.mode === 'pppoe');
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const d of devs) for (const i of d.ifaces) if (dyn(i) && acquire(state, old, d, i)) changed = true;
    if (!changed) break;
  }
  prepVrrp(state);
  routesAll(state);
  let again = relayPass(state, old);
  for (const d of devs) {
    if (d.kind !== 'host') continue;
    for (const i of d.ifaces) {
      if (!dyn(i) || i.mode !== 'dhcp' || !i.rt.link) continue;
      const h = hash(d.id + i.id);
      Object.assign(i.rt, { ip: parseIp(`169.254.${(h % 254) + 1}.${((h >>> 8) % 254) + 1}`), bits: 16, src: 'apipa' });
      again = true;
    }
  }
  if (again) routesAll(state);
  prepTunnels(state);
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
    return r.action === 'permit' ? null : `ACL 第 ${n + 1} 條規則拒絕了這個封包`;
  }
  return 'ACL 沒有任何規則符合，隱含拒絕 (implicit deny any)';
}

function pktDesc(p) {
  const what =
    p.proto === 'icmp' ? (p.reply ? 'ICMP Echo Reply' : 'ICMP Echo Request')
      : p.proto === 'tcp' ? (p.reply ? `TCP SYN-ACK（來自埠 ${p.sport}）` : `TCP SYN → 埠 ${p.dport}`)
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
  if (bad) return `${dev.name} 的${bad.bad}`;
  const wan = dev.ifaces.find((x) => x.rt.ip == null && x.rt.note && (x.mode === 'dhcp' || x.mode === 'pppoe'));
  return `${dev.name} 的路由表裡沒有通往 ${fmtIp(dst)} 的路由${wan ? `（${wan.label}：${wan.rt.note}）` : ''}`;
}

function arpFail(state, dev, outIf, nh, viaGw, eps) {
  const b = outIf.bind;
  if ((b.t === 'port' || b.t === 'sub') && !state.rt.links[dev.id + ':' + b.port]) return `${dev.name} 的 ${outIf.label} 沒有連線`;
  const owner = findOwner(state, nh);
  const who = viaGw ? `下一站（閘道）${fmtIp(nh)}` : fmtIp(nh);
  if (eps.dot1x) return `ARP 沒有回應：連接埠還沒有通過 802.1X 驗證（${eps.dot1x}）`;
  if (eps.ps) return `ARP 沒有回應：${dev.name} 的訊框被 ${eps.ps} 的 Port Security 擋下（不是允許的 MAC 位址）`;
  if (!owner) return `ARP 沒有回應：找不到 ${who}，沒有任何設備使用這個 IP`;
  // 路徑上如果有沒燈號的線，把原因一起說出來
  const dead = state.cables.find((c) => state.rt.why[c.id]);
  const extra = dead ? `。另外，${state.devices[dead.a.dev].name} ↔ ${state.devices[dead.b.dev].name} 的連線沒有燈號：${state.rt.why[dead.id]}` : '';
  return `ARP 沒有回應：${owner.name} 是 ${fmtIp(nh)}，但從 ${dev.name} 的第二層（接線 / VLAN / 無線）到不了它${extra}`;
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
      if (!(SERVICES[p.service] || SERVICES.ALL)(pkt)) continue;
      if (p.action === 'accept') return { ok: true, nat: !!p.nat, rule: n + 1 };
      return { ok: false, reason: `${dev.name} 的政策 #${n + 1}「${p.name || '未命名'}」拒絕了這個連線` };
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
    if (owner && owner.ping === false && inIf === owner) return no(`${dev.name} 的 ${owner.label} 介面不回應來自外部的 ping（安全性預設值）`);
    return ok;
  }
  if (pkt.proto === 'udp') {
    if (pkt.dport === 53 && dev.dnsProxy && !fromWan) return ok;
    if (pkt.dport === 67 && dev.dhcpScopes) return ok;
    if ((pkt.dport === 1812 || pkt.dport === 1813) && dev.radiusServer) return ok;
    if ((pkt.dport === 500 || pkt.dport === 4500) && ((dev.vpns && dev.vpns.length) || (dev.vpnServer && dev.vpnServer.on))) return ok;
  }
  if (pkt.proto === 'tcp' && dev.mgmt && MGMT[pkt.dport]) {
    const [k, name] = MGMT[pkt.dport];
    if (!dev.mgmt[k]) return no(`${dev.name} 沒有開啟 ${name} 管理服務（連線被拒絕）`);
    if (fromWan) return no(`${dev.name} 的管理介面不對 WAN 開放`);
    if (!addrMatch(String(dev.mgmt.allow || '').replace(/[,\s]+/g, ','), pkt.src)) return no(`來源 ${fmtIp(pkt.src)} 不在 ${dev.name} 允許管理的位址範圍內`);
    return ok;
  }
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
  if (state.rt.off[dev.id]) return drop(`${dev.name} 沒有電 — 它需要接在有 PoE 供電的連接埠上`);
  for (let n = 0; n < 48; n++) {
    let established = false, dnat = null;
    const o = { src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport };
    const stateful = dev.kind === 'firewall' || dev.kind === 'homerouter';
    if (inIf) {
      const deny = aclCheck(inIf.aclIn, pkt);
      if (deny) return drop(`${dev.name} 的 ${inIf.label}（進入方向）：${deny}`);
      const ct = ctx.ct[dev.id];
      const e = ct && ct.find((x) => x.proto === pkt.proto && x.nDst === pkt.src && x.nSrc === pkt.dst && x.nDport === pkt.sport && x.nSport === pkt.dport);
      if (e && pkt.reply) {
        established = true;
        if (e.src !== pkt.dst || e.dst !== pkt.src) {
          log.push({ dev: dev.id, kind: 'nat', text: `NAT 還原：${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}　改回　${fmtIp(e.dst)} → ${fmtIp(e.src)}` });
        }
        pkt.src = e.dst; pkt.sport = e.dport; pkt.dst = e.src; pkt.dport = e.sport;
      } else if (!pkt.reply) {
        const sn = (dev.staticNat || []).find((x) => parseIp(x.pub || '') === pkt.dst && parseIp(x.priv || '') != null);
        dnat = sn ? { ip: parseIp(sn.priv), port: pkt.dport, stat: true } : matchPortForward(dev, inIf, pkt);
        if (dnat) {
          log.push({ dev: dev.id, kind: 'nat', text: dnat.stat ? `靜態 NAT：目的位址 ${fmtIp(pkt.dst)} 換成 ${fmtIp(dnat.ip)}` : `連接埠轉發：${fmtIp(pkt.dst)}:${pkt.dport} → ${fmtIp(dnat.ip)}:${dnat.port}` });
          pkt.dst = dnat.ip; pkt.dport = dnat.port;
        }
      }
      if (dev.kind === 'internet' && !pkt.reply && isPrivate(pkt.src)) {
        return drop(`來源 ${fmtIp(pkt.src)} 是私有 IP，ISP 直接丟棄 — 出口路由器沒有做 NAT`);
      }
      if (isLocal(dev, pkt.dst)) {
        const r = deliver(dev, inIf, pkt);
        if (!r.ok) log.push({ dev: dev.id, kind: 'drop', text: r.reason });
        return r;
      }
      if (!dev.routing) return drop(`${dev.name} 收到不是給自己的封包（目的 ${fmtIp(pkt.dst)}），它不是路由器所以直接丟棄`);
      if (--pkt.ttl <= 0) return drop('TTL 歸零，封包被丟棄（可能有路由迴圈）');
      if (!pkt.reply && pkt.proto !== 'esp') ctx.l3.push({ dev: dev.id, ip: inIf.rt.ip });
    } else if (isLocal(dev, pkt.dst)) {
      return { ok: true, dev: dev.id };
    }

    // VPN：符合通道的本地 / 遠端網段就加密後送給對端
    const tun = pkt.proto !== 'esp' && findTunnel(dev, pkt);
    if (tun) {
      if (!tun.up) return drop(`VPN 通道「${tun.name}」沒有建立：${tun.why}`);
      if (inIf && !established) {
        const v = filter(dev, inIf, tun.iface, pkt, dnat);
        if (!v.ok) return drop(v.reason);
        if (v.rule) log.push({ dev: dev.id, kind: 'fwd', text: `符合政策 #${v.rule}，放行（${inIf.label} → ${tun.iface.label}）` });
        if (!pkt.reply && stateful) (ctx.ct[dev.id] ||= []).push({ proto: pkt.proto, ...o, nSrc: pkt.src, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport });
      }
      log.push({ dev: dev.id, kind: 'vpn', text: `加密：整個封包包進 ESP，外層位址 ${fmtIp(tun.localIp)} → ${fmtIp(tun.peerIp)}` });
      const r = forward(state, ctx, dev.id, { proto: 'esp', src: tun.localIp, dst: tun.peerIp, sport: 0, dport: 0, ttl: 64, reply: pkt.reply });
      if (!r.ok) return r;
      dev = state.devices[r.dev];
      inIf = r.tun.iface;
      log.push({ dev: dev.id, kind: 'vpn', text: `解密：還原出內層封包 ${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}（從 ${inIf.label} 進來）` });
      continue;
    }

    if (dev.kind === 'internet' && isPrivate(pkt.dst)) {
      return drop(`${fmtIp(pkt.dst)} 是私有 IP，在網際網路上無法路由（上一台路由器把它交給了預設路由 — 是不是少了通往這個網段的路由或 VPN？）`);
    }

    const route = lookupRoute(dev, pkt.dst);
    if (!route) return drop(noRouteReason(state, dev, pkt.dst));
    const outIf = route.iface;
    const nh = route.via ?? pkt.dst;

    if (inIf && !established) {
      const v = filter(dev, inIf, outIf, pkt, dnat);
      if (!v.ok) return drop(v.reason);
      if (v.rule) log.push({ dev: dev.id, kind: 'fwd', text: `符合政策 #${v.rule}，放行（${inIf.label} → ${outIf.label}）` });
      if (!pkt.reply) {
        let nSrc = pkt.src;
        const st = (dev.staticNat || []).find((x) => parseIp(x.priv || '') === pkt.src && outIf.rt.vips.includes(parseIp(x.pub || '')));
        if (st) nSrc = parseIp(st.pub); // 靜態 NAT 的主機固定用自己的公用 IP 出去
        else if (v.nat && outIf !== inIf && outIf.rt.ip != null) nSrc = outIf.rt.ip;
        if (nSrc !== pkt.src || dnat || stateful) {
          (ctx.ct[dev.id] ||= []).push({ proto: pkt.proto, ...o, nSrc, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport });
        }
        if (nSrc !== pkt.src) {
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
    if (!tgt) return drop(dai || arpFail(state, dev, outIf, nh, route.via != null, eps));
    if (cands.length > 1 && !dai) {
      log.push({ dev: dev.id, kind: 'info', text: `注意：這個網段上有 ${cands.length} 台設備都聲稱自己是 ${fmtIp(nh)}（IP 衝突或 ARP 欺騙），封包被送往最先回應的 ${state.devices[tgt.dev].name}` });
    }
    const names = [dev.name, ...tgt.path.map((h) => state.devices[h.to].name)];
    const tags = [...new Set(tgt.path.map((h) => h.tag).filter((t) => t != null))];
    log.push({
      dev: dev.id, kind: 'l2',
      text: (route.via != null ? `查路由 → 下一站 ${fmtIp(nh)}：` : '') + names.join(' → ') + (tags.length ? `　[802.1Q VLAN ${tags.join(',')}]` : '')
        + (tgt.path.some((h) => h.wifi) ? '　[Wi-Fi]' : ''),
    });
    for (const h of tgt.path) hops.push({ ...h, reply: pkt.reply, proto: pkt.proto });
    dev = state.devices[tgt.dev];
    inIf = tgt.iface;
  }
  return drop('封包繞了太多站仍未抵達（路由迴圈）');
}

let pktSeq = 0;

/**
 * 模擬一次「請求 + 回應」。spec: { proto:'icmp'|'tcp'|'udp', dst:number, dport?, srcIp? }
 * 回傳 { ok, reason, failDev, phase, responder, srcIp, seenSrc, log, hops, l3 }
 */
export function transact(state, fromId, spec) {
  const ctx = { ct: {}, log: [], hops: [], l3: [] };
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
  const pkt = { proto: spec.proto, src: srcIp, dst: spec.dst, sport: icmp ? id : 30000 + id, dport: icmp ? 0 : spec.dport, ttl: 64, reply: false };
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
  ctx.log.push({ dev: fromId, kind: 'ok', text: '收到回應，連線成功' });
  return done({ ok: true, responder: a.dev, srcIp, seenSrc: pkt.src });
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
    const log = [{ dev: d.id, kind: reason ? 'drop' : 'ok', text: reason || `透過 DHCP 取得 ${fmtIp(i.rt.ip)}/${i.rt.bits}（${state.devices[i.rt.server].name}）` }];
    return { pass: !reason, ok: !reason, reason, failDev: reason ? d.id : null, log, hops: [] };
  }
  if (o.type === 'failover') {
    const s2 = cloneState(state);
    s2.down = Object.fromEntries((o.down || []).map((id) => [id, true]));
    s2.cut = {};
    const what = (o.down || []).map((id) => state.devices[id].name + ' 斷電');
    for (const [dv, pid] of o.cut || []) {
      const c = s2.cables.find((x) => (x.a.dev === dv && x.a.port === pid) || (x.b.dev === dv && x.b.port === pid));
      if (c) s2.cut[c.id] = true;
      what.push(`${state.devices[dv].name} 的 ${pid} 斷線`);
    }
    recompute(s2);
    const r = runObjective(s2, o.test);
    r.log.unshift({ dev: (o.down || [])[0] || (o.cut || [[]])[0][0], kind: 'info', text: `故障演練：${what.join('、')}` });
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
  const proto = o.type === 'ping' ? 'icmp' : o.type;
  const r = transact(state, o.from, { proto, dst, dport: o.port ?? 443, srcIp });
  log.push(...r.log); hops.push(...r.hops);
  if (r.ok && o.via) {
    const seen = new Set();
    for (const h of r.hops) if (!h.reply) { seen.add(h.from); seen.add(h.to); }
    if (!seen.has(o.via)) {
      const reason = `連線是通的，但封包沒有經過 ${state.devices[o.via].name}`;
      log.push({ dev: o.from, kind: 'drop', text: reason });
      return { pass: false, ok: true, reason, failDev: o.from, log, hops };
    }
  }
  return finish(r.ok, r.reason, r.failDev);
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
