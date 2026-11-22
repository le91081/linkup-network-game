// 鄰居探索：CDP 與 LLDP（含 LLDP-MED）
//
// 每台會講這些協定的設備，依自己的計時器在每個有接線的埠送出通告（CDP 預設 60 秒、LLDP 30 秒），
// 收到的一方把它記在鄰居表裡，holdtime 內沒有再收到就刪掉。所以：
//   - 剛接上線的兩台設備馬上就看得到對方（接線時會立刻送一次）
//   - 對面把 CDP 關掉，這一邊要等 holdtime（預設 180 秒）過了才會忘記它
//   - 自己的埠斷線，從那個埠學到的鄰居馬上清掉
//   - 中間隔著 Hub 或非網管交換器，一個埠上可以看到好幾個鄰居
//
// state.dyn.nb[設備][埠]   = { 'cdp|對方id': { proto, dev, port, t, hold, info } }   收到的鄰居
// state.dyn.ndTx[設備][埠] = { cdp: { t, cable }, lldp: { t, cable } }               上一次送出
// state.dyn.ndCnt[設備]    = { cdpOut, cdpIn, lldpOut, lldpIn }                       show cdp / lldp traffic
import { CATALOG, linkInfo } from './model.js';
import { fmtIp } from './ip.js';
import { isCiscoOs, PLATFORM } from './files.js';

const isPhone = (d) => !!(CATALOG[d.model] || {}).phone;

/** 會講 CDP 的設備：Cisco 的路由器、交換器與 IP 電話 */
/** Cisco 的輕量型 AP 也送 CDP（交換器靠它知道 AP 實際要多少瓦） */
const ciscoAp = (d) => d.kind === 'ap' && (CATALOG[d.model] || {}).vendor === 'Cisco';
export const speaksCdp = (d) => isCiscoOs(d) || ciscoAp(d) || (isPhone(d) && CATALOG[d.model].vendor === 'Cisco');
/** 會講 LLDP 的設備：上面那些，加上基地台 */
export const speaksLldp = (d) => speaksCdp(d) || isPhone(d) || d.kind === 'ap';
// 原廠預設：IOS 的設備 CDP 開、LLDP 關（要 lldp run）；Nexus 兩個都開；IP 電話兩個都開；UniFi 基地台只有 LLDP
const lldpDefault = (d) => PLATFORM[d.model] === 'n9k' || isPhone(d) || d.kind === 'ap';

export const CDP_TIMER = 60, CDP_HOLD = 180, LLDP_TIMER = 30, LLDP_HOLD = 120;

export function cdpCfg(d) {
  const c = d.cdp || {};
  return { run: speaksCdp(d) && c.run !== false, timer: +c.timer || CDP_TIMER, hold: +c.hold || CDP_HOLD, v2: c.v2 !== false };
}
export function lldpCfg(d) {
  const c = d.lldp || {};
  return { run: speaksLldp(d) && (c.run != null ? !!c.run : lldpDefault(d)), timer: +c.timer || LLDP_TIMER, hold: +c.hold || LLDP_HOLD };
}
/** 介面上個別關掉的設定：{ cdp: false }（no cdp enable）、{ tx: false }（no lldp transmit）、{ rx: false }（no lldp receive） */
export const portNd = (d, pid) => ((d.ndPorts || {})[pid]) || {};
export function setPortNd(d, pid, key, on) {
  const p = ((d.ndPorts ||= {})[pid] ||= {});
  if (on) delete p[key]; else p[key] = false;
  if (!Object.keys(p).length) delete d.ndPorts[pid];
  if (!Object.keys(d.ndPorts).length) delete d.ndPorts;
}
export const cdpOn = (d, pid) => cdpCfg(d).run && portNd(d, pid).cdp !== false;
export const lldpTxOn = (d, pid) => lldpCfg(d).run && portNd(d, pid).tx !== false;
export const lldpRxOn = (d, pid) => lldpCfg(d).run && portNd(d, pid).rx !== false;

// ───────────────────────── 通告的內容 ─────────────────────────

const PLATFORM_ID = {
  isr4321: 'ISR4321/K9', isr4331: 'ISR4331/K9', c2960: 'WS-C2960CX-8TC-L', c2960p: 'WS-C2960CX-8PC-L', c9300: 'C9300-24T',
  n93180: 'N9K-C93180YC-FX', n9332: 'N9K-C9332C', ipphone: 'Cisco IP Phone 8841', t54w: 'Yealink SIP-T54W', c9120: 'C9120AXI-B',
};
/** CDP 的能力代碼：R 路由器、S 交換器、I IGMP、H 主機、P 電話、M 兩埠 MAC Relay（電話的電腦埠） */
function cdpCaps(d) {
  if (isPhone(d)) return ['H', 'P', 'M'];
  if (d.kind === 'ap') return ['T', 'B', 'I'];
  if (d.kind === 'router') return ['R', 'B', 'S', 'I'];
  if (d.kind === 'l3switch') return PLATFORM[d.model] === 'n9k' ? ['R', 'S', 'I', 's'] : ['R', 'S', 'I'];
  return ['S', 'I'];
}
const CDP_CAP_NAME = { T: 'Trans-Bridge', R: 'Router', B: 'Source-Route-Bridge', S: 'Switch', I: 'IGMP', H: 'Host', P: 'Phone', M: 'Two-port Mac Relay', s: 'Supports-STP-Dispute' };
export const cdpCapText = (caps) => caps.map((c) => CDP_CAP_NAME[c] || c).join(' ');
/** LLDP 的能力：B Bridge、R Router、T Telephone、W WLAN Access Point */
function lldpCaps(d) {
  if (isPhone(d)) return ['B', 'T'];
  if (d.kind === 'ap') return ['B', 'W'];
  if (d.kind === 'router' || d.kind === 'firewall') return ['R'];
  if (d.kind === 'l3switch') return ['B', 'R'];
  return ['B'];
}
const longName = (s) => String(s).replace(/^Gi(?=\d)/, 'GigabitEthernet').replace(/^Te(?=\d)/, 'TenGigabitEthernet').replace(/^Eth(?=\d)/, 'Ethernet');

function versionOf(d) {
  const v = (d.fw && d.fw.ver) || '';
  if (isPhone(d)) return CATALOG[d.model].vendor === 'Cisco' ? 'sip88xx.14-2-1-0101-27' : 'Yealink SIP-T54W 96.86.0.70';
  if (PLATFORM[d.model] === 'n9k') return `Cisco Nexus Operating System (NX-OS) Software, Version ${v || '10.3(4a)'}`;
  if (PLATFORM[d.model] === 'c2960cx') return `Cisco IOS Software, C2960CX Software (C2960c405ex-UNIVERSALK9-M), Version ${v || '15.2(7)E10'}, RELEASE SOFTWARE (fc2)`;
  if (ciscoAp(d)) return 'Cisco AP Software, (ap1g7), C9120, RELEASE SOFTWARE, Version 17.9.5.47';
  if (d.kind === 'ap') return 'UniFi U6-Lite 6.6.77';
  return `Cisco IOS XE Software, Version ${v || '17.09.05a'}`;
}
/** 通告裡的管理位址：交換器是管理用的 SVI，其他設備用送出的那個介面，沒有就用第一個有 IP 的介面 */
function mgmtAddr(d, pid) {
  const own = d.ifaces.find((i) => i.rt && i.rt.ip != null && (i.bind.t === 'port' || i.bind.t === 'sub') && i.bind.port === pid);
  const any = d.ifaces.find((i) => i.rt && i.rt.ip != null);
  const i = own || any;
  return i ? fmtIp(i.rt.ip) : '';
}
/** 設備的名稱：IOS 有設定網域名稱時，CDP 的 Device ID 是完整的 FQDN；電話是 SEP 加上 MAC */
export function deviceIdOf(d) {
  if (isPhone(d)) {
    const i = d.ifaces[0], mac = (i && i.rt && i.rt.mac) || '';
    return CATALOG[d.model].vendor === 'Cisco' ? 'SEP' + mac.replace(/:/g, '').toUpperCase() : 'SIP-T54W-' + mac.replace(/:/g, '').slice(-6);
  }
  const host = d.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'Device';
  return d.mgmt && d.mgmt.domain && isCiscoOs(d) ? `${host}.${d.mgmt.domain}` : host;
}

/** 這台設備從 pid 送出去的通告內容 */
function advert(state, d, pid, proto) {
  const p = d.ports.find((x) => x.id === pid) || { label: pid };
  const pc = d.sw && d.sw.mode === 'vlan' ? d.sw.ports[pid] : null;
  const op = pc && d.rt && d.rt.dtp && d.rt.dtp[pid] ? d.rt.dtp[pid].oper : pc ? (pc.mode === 'trunk' ? 'trunk' : 'access') : null;
  const li = linkInfo(state, d.id, pid);
  return {
    id: proto === 'cdp' ? deviceIdOf(d) : deviceIdOf(d).split('.')[0],
    platform: PLATFORM_ID[d.model] || CATALOG[d.model].title,
    caps: proto === 'cdp' ? cdpCaps(d) : lldpCaps(d),
    port: proto === 'cdp' ? (isPhone(d) ? 'Port 1' : longName(p.label)) : isPhone(d) ? 'Port 1' : p.label,
    ip: mgmtAddr(d, pid),
    ver: versionOf(d),
    native: pc && op && op !== 'down' ? (op === 'trunk' ? pc.native : pc.vlan) : null,
    duplex: li && li.duplex ? li.duplex : 'full',
    voice: pc && op === 'access' && pc.voice ? pc.voice : null, // CDP 的 Appliance VLAN / LLDP-MED 的 Network Policy
    med: isPhone(d), // LLDP-MED 端點
    power: isPhone(d) ? CATALOG[d.model].poe.watts : null,
  };
}

// ───────────────────────── 送與收 ─────────────────────────

/**
 * 從 d 的 pid 送出的通告會被誰收到。Hub 什麼都往外送；非網管交換器不認得 CDP 的目的位址，也照樣泛洪，
 * 但 LLDP 用的 01:80:c2:00:00:0e 是 802.1D 保留給「最近的那一台橋接器」的位址，交換器不會轉送
 */
function receivers(state, d, pid, proto) {
  const out = [], seen = new Set([d.id + ':' + pid]);
  const walk = (devId, port) => {
    const k = devId + ':' + port;
    if (seen.has(k)) return;
    seen.add(k);
    const x = state.devices[devId];
    if (!x) return;
    const relay = x.sw && (x.sw.mode === 'hub' || (proto === 'cdp' && x.kind === 'switch'));
    if (relay) {
      for (const q of Object.keys(x.sw.ports)) {
        if (q === port) continue;
        const l = state.rt.links[x.id + ':' + q];
        if (l) walk(l.dev, l.port);
      }
      return;
    }
    if (x.id !== d.id) out.push({ dev: x, port });
  };
  const l = state.rt.links[d.id + ':' + pid];
  if (l) walk(l.dev, l.port);
  return out;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const isSpanDst = (d, pid) => !!(d.sw && d.sw.span && Object.values(d.sw.span).some((s) => s.dst === pid));

/** 每次重新計算之後：該送的通告送出去，過期的鄰居刪掉 */
export function discTick(state) {
  const dyn = state.dyn, now = state.clock, boot = !!dyn.boot;
  const nb = (dyn.nb ||= {}), tx = (dyn.ndTx ||= {}), cnt = (dyn.ndCnt ||= {});
  const down = state.down || {}, booting = state.rt.booting || {};
  const dead = (id) => down[id] || state.rt.off[id] || booting[id] > 0;
  // 1. 自己關機、自己的埠斷線、自己不再收這個協定：從那裡學到的鄰居馬上清掉
  for (const [id, ports] of Object.entries(nb)) {
    const d = state.devices[id];
    if (!d || dead(id)) { delete nb[id]; continue; }
    for (const [pid, tbl] of Object.entries(ports)) {
      if (!state.rt.links[id + ':' + pid]) { delete ports[pid]; continue; }
      for (const [k, e] of Object.entries(tbl)) if (!(e.proto === 'cdp' ? cdpOn(d, pid) : lldpRxOn(d, pid))) delete tbl[k];
    }
  }
  // 2. 送出通告
  for (const d of Object.values(state.devices)) {
    if (dead(d.id) || !(speaksCdp(d) || speaksLldp(d))) { delete tx[d.id]; continue; }
    const c = (cnt[d.id] ||= { cdpOut: 0, cdpIn: 0, lldpOut: 0, lldpIn: 0 });
    for (const p of d.ports) {
      const l = state.rt.links[d.id + ':' + p.id];
      const rec = ((tx[d.id] ||= {})[p.id] ||= {});
      for (const proto of ['cdp', 'lldp']) {
        const on = l && !isSpanDst(d, p.id) && (proto === 'cdp' ? cdpOn(d, p.id) : lldpTxOn(d, p.id));
        if (!on) {
          // LLDP 關掉的那一刻會送一個 TTL = 0 的 shutdown 通告，對方立刻把這筆刪掉（CDP 沒有這個機制，只能等 holdtime）
          if (proto === 'lldp' && rec.lldp && l && rec.lldp.cable === l.cable) {
            for (const r of receivers(state, d, p.id, proto)) { const t = ((nb[r.dev.id] || {})[r.port]) || {}; delete t['lldp|' + d.id]; }
          }
          delete rec[proto];
          continue;
        }
        const cfg = proto === 'cdp' ? cdpCfg(d) : lldpCfg(d);
        const last = rec[proto];
        let at = null, n = 0;
        if (!last || last.cable !== l.cable) { at = boot ? now - (hashStr(d.id + p.id + proto) % cfg.timer) : now; n = 1; }
        else if (now - last.t >= cfg.timer) { n = Math.floor((now - last.t) / cfg.timer); at = last.t + n * cfg.timer; }
        if (at == null) continue;
        rec[proto] = { t: at, cable: l.cable };
        c[proto + 'Out'] += n;
        const info = advert(state, d, p.id, proto);
        for (const r of receivers(state, d, p.id, proto)) {
          if (dead(r.dev.id) || !(proto === 'cdp' ? cdpOn(r.dev, r.port) : lldpRxOn(r.dev, r.port))) continue;
          const tbl = ((nb[r.dev.id] ||= {})[r.port] ||= {});
          tbl[proto + '|' + d.id] = { proto, dev: d.id, port: p.id, t: at, hold: cfg.hold, info };
          const rc = (cnt[r.dev.id] ||= { cdpOut: 0, cdpIn: 0, lldpOut: 0, lldpIn: 0 });
          rc[proto + 'In'] += n;
        }
      }
    }
  }
  // 3. holdtime 過了還沒有再收到：刪掉
  for (const ports of Object.values(nb)) {
    for (const [pid, tbl] of Object.entries(ports)) {
      for (const [k, e] of Object.entries(tbl)) if (now - e.t >= e.hold) delete tbl[k];
      if (!Object.keys(tbl).length) delete ports[pid];
    }
  }
}

/** 某台設備的鄰居表：[{ proto, pid, dev, port, left, info }]，依本地埠排序 */
export function neighbors(state, d, proto) {
  const out = [], now = state.clock;
  const ports = ((state.dyn && state.dyn.nb) || {})[d.id] || {};
  for (const p of d.ports) {
    for (const e of Object.values(ports[p.id] || {})) {
      if (proto && e.proto !== proto) continue;
      out.push({ ...e, pid: p.id, label: p.label, left: Math.max(1, Math.ceil(e.hold - (now - e.t))) });
    }
  }
  return out;
}
export const ndCounters = (state, d) => ((state.dyn && state.dyn.ndCnt) || {})[d.id] || { cdpOut: 0, cdpIn: 0, lldpOut: 0, lldpIn: 0 };
/** clear cdp table / clear lldp table：清掉，等對方下一次通告再學回來 */
export function clearNeighbors(state, d, proto) {
  const ports = ((state.dyn && state.dyn.nb) || {})[d.id];
  if (!ports) return;
  for (const tbl of Object.values(ports)) for (const k of Object.keys(tbl)) if (tbl[k].proto === proto) delete tbl[k];
}
/** 這個埠有沒有從 CDP 聽到某一台設備（duplex / native VLAN 不一致的訊息要靠它） */
export const heardVia = (state, d, pid, proto, peerId) => !!(((((state.dyn && state.dyn.nb) || {})[d.id] || {})[pid] || {})[proto + '|' + peerId]);
