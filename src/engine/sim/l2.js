// 第二層：VLAN 與 Trunk 的標籤、廣播網域的探索、MAC 位址表、ARP 快取
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { parseIp, parseVlanList } from '../ip.js';
import { spanDest } from '../wire.js';
import { DROP, bridgeKey, isTrunk, isVlanSw, macList, phoneEgress, phoneIngress } from './core.js';

// ───────────────────────────── L2 ─────────────────────────────

export const isBridgePort = (dev, pid) => !!(dev.sw && dev.sw.ports[pid] && dev.sw.ports[pid].mode !== 'routed');

export function ifaceActive(dev, i) {
  const b = i.bind;
  if (b.t === 'port' || b.t === 'sub') return dev.ports.some((p) => p.id === b.port) && !isBridgePort(dev, b.port);
  if (b.t === 'svi') return isVlanSw(dev) && dev.sw.vlans.some((v) => v.id === b.vlan);
  return true;
}

export function vlanAllowed(pc, v) {
  const l = parseVlanList(pc.allowed);
  return l == null || l.includes(v);
}
export const vlanExists = (dev, v) => dev.sw.vlans.some((x) => x.id === v);
export const psAllowed = (pc, mac) => macList(pc.ps.macs).includes(mac);

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
  if (sw.mode === 'phone') return phoneIngress(dev, pid, tag);
  if (sw.mode !== 'vlan') return tag == null ? 'u' : tag;
  if (pc.ps && pc.ps.on && mac && !psAllowed(pc, mac)) { notes.ps = `${dev.name} 的 ${pid}`; return DROP; }
  let v;
  if (isTrunk(dev, pid)) {
    v = tag == null ? pc.native : tag;
    if (!vlanAllowed(pc, v)) return DROP;
  } else if (tag != null && tag !== 0) {
    // Access 埠只收不帶標籤的訊框；設了 Voice VLAN 的埠另外收帶著語音 VLAN 標籤的訊框（IP 電話送的）
    if (!pc.voice || tag !== pc.voice) return DROP;
    v = pc.voice;
  } else {
    v = pc.vlan; // 不帶標籤，或只帶優先權的 802.1p 標籤 (VLAN 0)
  }
  if (!vlanExists(dev, v) || stpBlocked(dev, pid, v)) return DROP;
  return v;
}

/** 內部 VLAN 的訊框要從某埠送出 → 回傳線上的 tag（null = untagged），或 DROP */
function egressTag(dev, pid, key) {
  const sw = dev.sw, pc = sw.ports[pid];
  if (!portUsable(dev, pid)) return DROP;
  if (sw.mode === 'phone') return phoneEgress(dev, pid, key);
  if (sw.mode !== 'vlan') return key === 'u' ? null : key;
  if (stpBlocked(dev, pid, key)) return DROP;
  if (isTrunk(dev, pid)) {
    if (!vlanAllowed(pc, key)) return DROP;
    return key === pc.native ? null : key;
  }
  if (pc.voice && key === pc.voice && key !== pc.vlan) return key; // 語音 VLAN 帶著標籤送給電話
  return pc.vlan === key ? null : DROP;
}

export const wifiHop = (from, to) => ({ wifi: true, cable: null, from, to, fromPort: null, toPort: null, tag: null });

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
      if ((i.bind.t === 'svi' && d.sw.mode === 'vlan' && i.bind.vlan === key) || (i.bind.t === 'bridge' && key === bridgeKey(d))) {
        out.push({ dev: d.id, iface: i, path });
      }
    }
    for (const c of rt.clients[d.id] || []) {
      if (c.key !== key || c.iface === iface) continue;
      if (viaWifi && (viaWifi.isolate || c.isolate)) continue; // 用戶端隔離
      out.push({ dev: c.dev, iface: c.iface, path: [...path, ...(c.back || [wifiHop(d.id, c.dev)])] });
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
  else if (b.t === 'bridge') flood(dev, bridgeKey(dev), null, []);
  else if (b.t === 'wlan') {
    const a = iface.rt.assoc;
    if (a) flood(state.devices[a.via || a.ap], a.key, null, a.path || [wifiHop(devId, a.ap)], a);
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
export const learns = (d) => !!d && !!d.sw && d.sw.mode !== 'hub'; // Hub 不看位址，什麼都不學

function macLearn(state, d, key, mac, port) {
  if (!learns(d) || !mac) return;
  (state.dyn.mac[d.id] ||= {})[key + '|' + mac] = { port, t: state.clock };
}

export function macKnown(state, d, key, mac) {
  const e = (state.dyn.mac[d.id] || {})[key + '|' + mac];
  return e && state.clock - e.t < macAgeOf(d) ? e : null;
}

/** 訊框沿著 path 走：路上每一台交換器都從進來的那個埠學到來源 MAC。回傳訊框在每一站的內部 VLAN */
export function learnPath(state, path, mac) {
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
export const reversed = (path) => [...path].reverse().map((h) => ({ ...h, from: h.to, fromPort: h.toPort, to: h.from, toPort: h.fromPort }));

/** 不認得目的 MAC 時，訊框還會被送往哪些埠（進來的埠和原本就要走的埠除外） */
export function floodPorts(state, sw, key, inPort, outPort) {
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
      for (const m of macList(pc.ps.macs)) rows.push({ vlan: isTrunk(d, pid) ? pc.native : pc.vlan, mac: m, port: pid, label: label(pid), type: 'STATIC' });
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

// ── ARP 快取 ──
/** ARP 項目多久沒用到就會被清掉：個人電腦大約兩分鐘，防火牆五分鐘，路由器與交換器四小時 */
export const arpTtl = (dev) => (dev.kind === 'host' ? 120 : dev.kind === 'firewall' || dev.kind === 'homerouter' ? 300 : 14400);
export const VRRP_MAC = '00:00:5e:00:01:01'; // VRRP 的虛擬 MAC：換手之後主機不需要重新學
export const answerMac = (e, ip) => (e.iface.rt.ip !== ip && e.iface.vrrp && e.iface.vrrp.on && parseIp(e.iface.vrrp.vip || '') === ip ? VRRP_MAC : e.iface.rt.mac);
export const arpRows = (state, dev) => Object.entries((state.dyn && state.dyn.arp[dev.id]) || {})
  .filter(([, e]) => state.clock - e.t < arpTtl(dev))
  .map(([ip, e]) => ({ ip: +ip, mac: e.mac, age: Math.floor(state.clock - e.t), left: Math.ceil(arpTtl(dev) - (state.clock - e.t)) }));
/** arp -d / clear arp-cache */
export function clearArp(state, dev) { if (state.dyn) delete state.dyn.arp[dev.id]; }
