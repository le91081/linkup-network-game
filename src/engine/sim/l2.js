// 第二層：VLAN 與 Trunk 的標籤、廣播網域的探索、MAC 位址表、ARP 快取
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { parseIp, parseVlanList } from '../ip.js';
import { spanDest } from '../wire.js';
import { DROP, bridgeKey, isTrunk, isVlanSw, macList, phoneEgress, phoneIngress } from './core.js';
import { staticMac, camFull, camSize, bogusMacs, stormLimit } from '../l2sec.js';
import { linkInfo } from '../model.js';

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
export const psAllowed = (pc, mac) => macList(pc.ps.macs).includes(mac) || macList(pc.ps.stickyMacs).includes(mac);
/** 這個 MAC 能不能從這個埠進來：Port Security 的安全位址（執行期算好的，包括動態學到的） */
const psOk = (dev, pid, pc, mac) => { const r = dev.rt.psec && dev.rt.psec[pid]; return r ? r.allowed.has(mac) : psAllowed(pc, mac); };
/** Private VLAN：VLAN 的種類（primary / isolated / community），不是就回傳 null */
export const pvType = (dev, v) => { const x = dev.sw && dev.sw.vlans.find((y) => y.id === +v); return (x && x.pvlan) || null; };
/** secondary VLAN 屬於哪一個 primary */
export const pvPrimaryOf = (dev, sec) => { const p = dev.sw.vlans.find((y) => y.pvlan === 'primary' && (y.assoc || []).includes(+sec)); return p ? p.id : null; };

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
  if (pc.ps && pc.ps.on && mac && !psOk(dev, pid, pc, mac)) { notes.ps = `${dev.name} 的 ${pid}`; return DROP; }
  let v;
  if (pc.mode === 'pvlan-host' || pc.mode === 'pvlan-promisc') {
    // Private VLAN：host 埠進來的算在 secondary VLAN，promiscuous 埠進來的算在 primary VLAN
    if (tag != null && tag !== 0) return DROP;
    const h = pc.pvHost || {}, m = pc.pvMap || {};
    v = pc.mode === 'pvlan-host' ? +h.secondary : +m.primary;
    if (pc.mode === 'pvlan-host' && (pvPrimaryOf(dev, v) !== +h.primary || !pvType(dev, v))) return DROP;
    if (pc.mode === 'pvlan-promisc' && pvType(dev, v) !== 'primary') return DROP;
  } else if (isTrunk(dev, pid)) {
    v = tag == null ? pc.native : tag;
    if (!vlanAllowed(pc, v)) return DROP;
  } else if (tag != null && tag !== 0) {
    // Access 埠只收不帶標籤的訊框；設了 Voice VLAN 的埠另外收帶著語音 VLAN 標籤的訊框（IP 電話送的）。
    // 標籤剛好是這個埠的 Access VLAN 的訊框，Catalyst 也照收（雙重標籤攻擊就是利用這一點：外層的標籤被拿掉，裡面那層留著）
    if (tag === pc.vlan) v = pc.vlan;
    else if (!pc.voice || tag !== pc.voice) return DROP;
    else v = pc.voice;
  } else {
    v = pc.vlan; // 不帶標籤，或只帶優先權的 802.1p 標籤 (VLAN 0)
  }
  if (!vlanExists(dev, v) || stpBlocked(dev, pid, v)) return DROP;
  // mac address-table static … drop：這個 MAC 送來的訊框直接丟掉
  if (mac) { const st = staticMac(dev, v, mac); if (st && st.drop) { notes.drop ||= `${dev.name}（mac address-table static ${mac} vlan ${v} drop）`; return DROP; } }
  return v;
}

/** 內部 VLAN 的訊框要從某埠送出 → 回傳線上的 tag（null = untagged），或 DROP */
function egressTag(dev, pid, key) {
  const sw = dev.sw, pc = sw.ports[pid];
  if (!portUsable(dev, pid)) return DROP;
  if (sw.mode === 'phone') return phoneEgress(dev, pid, key);
  if (sw.mode !== 'vlan') return key === 'u' ? null : key;
  if (stpBlocked(dev, pid, key)) return DROP;
  if (pc.mode === 'pvlan-host') {
    // host 埠收得到：primary VLAN（從 promiscuous 埠或 SVI 來的）、自己的 community；isolated 的彼此收不到
    const h = pc.pvHost || {};
    if (+key === +h.primary && pvPrimaryOf(dev, h.secondary) === +h.primary) return null;
    if (+key === +h.secondary && pvType(dev, key) === 'community') return null;
    return DROP;
  }
  if (pc.mode === 'pvlan-promisc') {
    const m = pc.pvMap || {};
    return +key === +m.primary || (m.secondaries || []).map(Number).includes(+key) ? null : DROP;
  }
  if (isTrunk(dev, pid)) {
    if (!vlanAllowed(pc, key)) return DROP;
    // vlan dot1q tag native：連 Native VLAN 的訊框也加上標籤送出去
    return key === pc.native && !dev.sw.tagNative ? null : key;
  }
  if (pc.voice && key === pc.voice && key !== pc.vlan) return key; // 語音 VLAN 帶著標籤送給電話
  return pc.vlan === key ? null : DROP;
}

export const wifiHop = (from, to) => ({ wifi: true, cable: null, from, to, fromPort: null, toPort: null, tag: null });

/**
 * 從某個 L3 介面出發，找出同一個廣播網域內所有可到達的 L3 介面。
 * 回傳陣列 [{ dev, iface, path }]；另外帶有 .storm（偵測到迴圈）與 .ps（被 Port Security 擋下）兩個屬性。
 */
export function l2Explore(state, devId, iface, opts = {}) {
  const rt = state.rt, links = rt.links;
  const out = [];
  const seen = new Set();
  const queue = [];
  const dev = state.devices[devId];
  if (!ifaceActive(dev, iface) || rt.off[devId] || (state.down || {})[devId]) return out;
  // opts.mac：用別的來源 MAC 送（macof 亂造的 MAC）；opts.trace：記下走過的交換器 (out.sws) 與每一段線路 (out.links)
  const mac = opts.mac || (iface.rt && iface.rt.mac);
  if (opts.trace) { out.sws = []; out.links = []; }

  // inner：雙重標籤的訊框裡面那一層標籤（外層被拿掉之後才看得到）
  const emit = (d, pid, tag, path, inner) => {
    const l = links[d.id + ':' + pid];
    if (l) queue.push({ from: d.id, fromPort: pid, to: l.dev, toPort: l.port, cable: l.cable, tag, path, inner });
  };
  const flood = (d, key, exceptPort, path, viaWifi, inner) => {
    const k = d.id + '|' + key + (inner != null ? '|' + inner : '');
    if (seen.has(k)) { out.storm = d.id; return; } // 同一個網段被走到第二次 = 有迴圈
    seen.add(k);
    if (out.sws) out.sws.push({ dev: d.id, key, port: exceptPort });
    // switchport protected：從 protected 埠進來的訊框，不會送往同一台交換器的其他 protected 埠
    const prot = exceptPort && d.sw.ports[exceptPort] && d.sw.ports[exceptPort].protected;
    if (inner == null) {
      for (const i of d.ifaces) {
        if (i === iface) continue;
        const pvSvi = i.bind.t === 'svi' && d.sw.mode === 'vlan' && (i.pvMap || []).map(Number).includes(+key) && pvPrimaryOf(d, key) === i.bind.vlan;
        if ((i.bind.t === 'svi' && d.sw.mode === 'vlan' && i.bind.vlan === key) || pvSvi || (i.bind.t === 'bridge' && key === bridgeKey(d))) {
          out.push({ dev: d.id, iface: i, path });
        }
      }
      for (const c of rt.clients[d.id] || []) {
        if (c.key !== key || c.iface === iface) continue;
        if (viaWifi && (viaWifi.isolate || c.isolate)) continue; // 用戶端隔離
        out.push({ dev: c.dev, iface: c.iface, path: [...path, ...(c.back || [wifiHop(d.id, c.dev)])] });
      }
    }
    for (const pid of Object.keys(d.sw.ports)) {
      if (pid === exceptPort || !isBridgePort(d, pid)) continue;
      if (prot && d.sw.ports[pid].protected) continue;
      if (d.rt.wait && d.rt.wait[pid] > 0 && links[d.id + ':' + pid]) { out.stp ||= { dev: d.id, pid, left: d.rt.wait[pid] }; continue; }
      const t = egressTag(d, pid, key);
      if (t === DROP) continue;
      // 雙重標籤：交換器送出去時只處理外層（Native VLAN 不加標籤），裡面那層原封不動，對面看到的就是裡面那層
      if (inner != null && t == null) emit(d, pid, inner, path);
      else emit(d, pid, t, path, inner);
    }
  };

  const b = iface.bind;
  if (b.t === 'port') emit(dev, b.port, null, []);
  else if (b.t === 'sub' && b.outer != null) emit(dev, b.port, b.outer, [], b.vlan); // 攻擊工具：外層 b.outer、裡面 b.vlan
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
    const path = [...q.path, { cable: q.cable, from: q.from, fromPort: q.fromPort, to: q.to, toPort: q.toPort, tag: q.tag, ...(q.inner != null ? { inner: q.inner } : {}) }];
    if (out.links) out.links.push({ cable: q.cable, from: q.from, fromPort: q.fromPort, to: q.to, toPort: q.toPort });
    if (isBridgePort(d, q.toPort)) {
      const key = ingressKey(d, q.toPort, q.tag, mac, out);
      if (key !== DROP) flood(d, key, q.toPort, path, null, q.inner);
    } else if (q.inner == null) {
      // 還帶著兩層標籤的訊框，路由器與主機都不認得
      const i = d.ifaces.find((x) =>
        q.tag == null
          ? x.bind.t === 'port' && x.bind.port === q.toPort
          : x.bind.t === 'sub' && x.bind.port === q.toPort && x.bind.vlan === q.tag && x.bind.outer == null,
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
  if (d.sw && d.sw.mode === 'vlan' && staticMac(d, key === 'u' ? 1 : key, mac)) return; // 靜態的項目不會被動態學習蓋掉（MAC 偽造也搬不走它）
  const tbl = (state.dyn.mac[d.id] ||= {}), k = key + '|' + mac;
  // 表被 MAC flooding 塞滿了：已經在表裡的照樣更新時間，新的 MAC 學不進來
  if (!tbl[k] && camFull(state, d, macAgeOf(d))) return;
  tbl[k] = { port, t: state.clock };
}

export function macKnown(state, d, key, mac) {
  const st = d.sw && d.sw.mode === 'vlan' && staticMac(d, key === 'u' ? 1 : key, mac);
  if (st) return st.drop ? null : { port: st.port, t: state.clock, static: true };
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
      const v = isTrunk(d, pid) ? pc.native : pc.vlan;
      for (const m of macList(pc.ps.macs)) rows.push({ vlan: v, mac: m, port: pid, label: label(pid), type: 'STATIC' });
      for (const m of macList(pc.ps.stickyMacs)) rows.push({ vlan: v, mac: m, port: pid, label: label(pid), type: 'STATIC', sticky: true });
      // 動態學到的安全位址也顯示成 STATIC（和 IOS 一樣）
      for (const m of (((state.dyn && state.dyn.psec) || {})[d.id + ':' + pid] || { dyn: [] }).dyn) if (!rows.some((r) => r.mac === m && r.vlan === v)) rows.push({ vlan: v, mac: m, port: pid, label: label(pid), type: 'STATIC', secure: true });
    }
    for (const e of d.sw.staticMacs || []) rows.push({ vlan: +e.vlan, mac: e.mac, port: e.drop ? 'drop' : e.port, label: e.drop ? 'Drop' : label(e.port), type: 'STATIC' });
  }
  const age = macAgeOf(d);
  for (const [k, e] of Object.entries((state.dyn && state.dyn.mac && state.dyn.mac[d.id]) || {})) {
    const cut = k.indexOf('|'), key = k.slice(0, cut), mac = k.slice(cut + 1), old = state.clock - e.t;
    if (old >= age || rows.some((r) => r.mac === mac && r.vlan === vlan(key))) continue;
    rows.push({ vlan: vlan(key), mac, port: e.port, label: label(e.port), type: 'DYNAMIC', age: Math.floor(old), left: Math.ceil(age - old) });
  }
  rows.sort((a, b) => a.vlan - b.vlan || a.label.localeCompare(b.label, 'en', { numeric: true }) || a.mac.localeCompare(b.mac));
  // MAC flooding：表的其他空間全是攻擊工具亂造的位址，學在攻擊者的那個埠
  const full = learns(d) ? camFull(state, d, age) : null;
  if (full) {
    const n = Math.max(0, camSize(d) - rows.length);
    rows.bogus = { n, port: full.port, label: label(full.port), vlan: vlan(full.key), sample: bogusMacs(d.id + full.by, 6) };
  }
  return rows;
}
/** clear mac address-table dynamic */
export function clearMac(state, d) { if (state.dyn && state.dyn.mac) delete state.dyn.mac[d.id]; if (state.dyn && state.dyn.cam) delete state.dyn.cam[d.id]; }

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

// ── 攻擊工具與壞掉的網卡 ──
/**
 * macof：每秒送出幾千個來源 MAC 都不一樣的訊框。走得到的每一台交換器都把它們學進表裡，表一滿，新的 MAC 就學不進來，
 * 目的地不在表裡的訊框只能往整個 VLAN 泛洪（攻擊者因此收到別人的流量）。Port Security 會在第一個埠就把它們擋掉。
 * 狂送廣播（中毒的電腦、壞掉的網卡）：整個 VLAN 的每一段線路都被這些廣播佔掉；storm-control 會在進來的埠把超過門檻的丟掉。
 * 要在 STP、Wi-Fi 與介面的連線狀態算好之後才算（要知道訊框走得到哪裡）
 */
export function prepL2Attacks(state) {
  const rt = state.rt, now = state.clock, down = state.down || {};
  const cam = (state.dyn.cam ||= {});
  rt.bcast = {}; rt.storms = [];
  for (const d of Object.values(state.devices)) {
    if (down[d.id] || rt.off[d.id]) { delete cam[d.id]; continue; } // 關機：整張表都沒了
    if (!d.macFlood && !(+d.bcastFlood > 0)) continue;
    const iface = d.ifaces.find((x) => x.bind.t === 'port' && rt.links[d.id + ':' + x.bind.port]);
    if (!iface) continue;
    if (d.macFlood) {
      const e = l2Explore(state, d.id, iface, { mac: 'macof', trace: true });
      for (const w of e.sws) { const x = state.devices[w.dev]; if (learns(x)) cam[x.id] = { t: now, by: d.id, port: w.port, key: w.key }; }
    }
    if (+d.bcastFlood > 0) {
      const li = linkInfo(state, d.id, iface.bind.port), rate = Math.min(+d.bcastFlood, (li && li.speed) || 1000);
      const e = l2Explore(state, d.id, iface, { trace: true });
      // 依走到的順序：每一台交換器送出去的量 = 進來的量，進來的埠有 storm-control 的話先砍到門檻
      const at = { [d.id]: rate };
      let lim = null;
      for (const h of e.links) {
        const inc = at[h.from] ?? 0;
        if (inc <= 0) continue;
        rt.bcast[h.cable + '>' + h.to] = (rt.bcast[h.cable + '>' + h.to] || 0) + inc;
        let r = inc;
        const x = state.devices[h.to], pc = x.sw && x.sw.ports && x.sw.ports[h.toPort];
        if (pc && pc.storm) {
          const sp = (linkInfo(state, x.id, h.toPort) || {}).speed || 1000, L = stormLimit(pc, sp);
          if (L != null && L < r) { r = L; if (lim == null) lim = { dev: x.id, port: h.toPort, mbps: L }; }
        }
        at[h.to] = Math.max(at[h.to] || 0, r);
      }
      rt.storms.push({ dev: d.id, rate, lim });
    }
  }
  for (const k of Object.keys(cam)) if (!state.devices[k] || now - cam[k].t >= macAgeOf(state.devices[k])) delete cam[k];
}
