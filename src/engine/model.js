// 設備型錄（以現實世界的機型為藍本）與設備物件工廠
import { parseIp } from './ip.js';

const rj = (id, label = id, extra) => ({ id, label, media: 'rj45', ...extra });
const sfp = (id, label = id) => ({ id, label, media: 'sfp' });
const qsfp = (id, label = id) => ({ id, label, media: 'qsfp' });
const seq = (n, f, from = 1) => Array.from({ length: n }, (_, i) => f(i + from));

export const MEDIA = {
  rj45: { name: 'RJ45', cable: 'Cat6 網路線', color: 0x4f9cf9 },
  sfp: { name: 'SFP+/SFP28', cable: 'DAC 直連銅纜', color: 0xf5b547 },
  qsfp: { name: 'QSFP28', cable: '100G 光纖', color: 0x35d6c1 },
};

/** 線材種類：最大傳輸距離（公尺）與適用的接頭 */
export const CABLES = {
  cat6: { name: 'Cat6 銅纜', max: 100, media: ['rj45'], color: 0x4f9cf9 },
  dac: { name: 'DAC 直連銅纜', max: 5, media: ['sfp', 'qsfp'], color: 0xf5b547 },
  mmf: { name: '多模光纖 (OM4) + SR 收發器', max: 300, media: ['sfp', 'qsfp'], color: 0x35d6c1 },
  smf: { name: '單模光纖 (OS2) + LR 收發器', max: 10000, media: ['sfp', 'qsfp'], color: 0xf7e04a },
};
export const cableKinds = (media) => Object.keys(CABLES).filter((k) => CABLES[k].media.includes(media));
export const cableKind = (c) => c.kind || ((c.media || 'rj45') === 'rj45' ? 'cat6' : 'dac');
/** 兩台設備之間的佈線距離（公尺）。關卡沒有特別指定時視為同一個機房內的 3 公尺 */
export const pairDist = (state, a, b) => (state.dist && state.dist[[a, b].sort().join('|')]) || 3;
export const cableDist = (state, c) => pairDist(state, c.a.dev, c.b.dev);

/**
 * kind:
 *  host       終端設備（PC / 伺服器 / 手機 / 印表機…）
 *  hub        集線器（L1，全部埠共用）
 *  switch     非網管型交換器
 *  mswitch    網管型 L2 交換器（VLAN / Trunk / STP / LACP / Port Security）
 *  l3switch   L3 交換器（SVI / Routed port / OSPF）
 *  router     路由器
 *  homerouter 家用無線路由器（WAN + LAN 橋接 + DHCP + NAT + Wi-Fi）
 *  firewall   次世代防火牆（政策、VIP、VPN）
 *  ap         無線基地台
 *  internet   ISP / 網際網路
 */
export const CATALOG = {
  pc: {
    kind: 'host', shape: 'pc', vendor: 'Dell', title: 'Dell OptiPlex 7010',
    tagline: '桌上型電腦 · 1GbE', ports: [rj('eth0', '乙太網路')],
  },
  laptop: {
    kind: 'host', shape: 'laptop', vendor: 'Lenovo', title: 'Lenovo ThinkPad T14',
    tagline: '筆記型電腦 · 1GbE + Wi-Fi 6', ports: [rj('eth0', '乙太網路')], wlan: true,
  },
  phone: {
    kind: 'host', shape: 'phone', vendor: 'Apple', title: 'Apple iPhone 15',
    tagline: '智慧型手機 · Wi-Fi 6', ports: [], wlan: true,
  },
  printer: {
    kind: 'host', shape: 'printer', vendor: 'HP', title: 'HP LaserJet Pro M404dn',
    tagline: '網路雷射印表機', ports: [rj('eth0', '乙太網路')],
    services: [{ proto: 'tcp', port: 9100, name: 'RAW 列印' }, { proto: 'tcp', port: 631, name: 'IPP' }],
  },
  wprinter: {
    kind: 'host', shape: 'printer', vendor: 'HP', title: 'HP LaserJet Pro M404dw',
    tagline: '無線雷射印表機 · 無線只支援到 WPA2', ports: [rj('eth0', '乙太網路')], wlan: true, wifiCaps: ['open', 'wep', 'wpa2'],
    services: [{ proto: 'tcp', port: 9100, name: 'RAW 列印' }, { proto: 'tcp', port: 631, name: 'IPP' }],
  },
  nas: {
    kind: 'host', shape: 'nas', vendor: 'Synology', title: 'Synology DS224+',
    tagline: '2-Bay NAS · 2×1GbE', ports: [rj('eth0', 'LAN 1'), rj('eth1', 'LAN 2')],
    services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }, { proto: 'tcp', port: 5001, name: 'DSM (HTTPS)' }],
  },
  tower: {
    kind: 'host', shape: 'tower', vendor: 'Dell', title: 'Dell PowerEdge T150',
    tagline: '直立式伺服器 · 2×1GbE', ports: [rj('eth0', 'NIC 1'), rj('eth1', 'NIC 2')],
  },
  rack1u: {
    kind: 'host', shape: 'rack1u', vendor: 'Dell', title: 'Dell PowerEdge R650',
    tagline: '1U 機架伺服器 · 2×25GbE SFP28', ports: [sfp('eth0', 'NIC 1'), sfp('eth1', 'NIC 2')],
  },
  hub4: {
    kind: 'hub', shape: 'hub', vendor: 'NETGEAR', title: 'NETGEAR EN104TP',
    tagline: '4 埠 10BASE-T 集線器 (Hub)', ports: seq(4, (i) => rj(String(i))),
  },
  sw5: {
    kind: 'switch', shape: 'switch-s', vendor: 'TP-Link', title: 'TP-Link TL-SG105',
    tagline: '5 埠 Gigabit 非網管型交換器', ports: seq(5, (i) => rj(String(i))),
  },
  sw8: {
    kind: 'switch', shape: 'switch-s', vendor: 'TP-Link', title: 'TP-Link TL-SG108',
    tagline: '8 埠 Gigabit 非網管型交換器', ports: seq(8, (i) => rj(String(i))),
  },
  homerouter: {
    kind: 'homerouter', shape: 'router-home', vendor: 'ASUS', title: 'ASUS RT-AX58U',
    tagline: 'Wi-Fi 6 家用路由器 · 1 WAN + 4 LAN',
    ports: [rj('wan', 'WAN'), ...seq(4, (i) => rj('lan' + i, 'LAN ' + i))],
  },
  ap: {
    kind: 'ap', shape: 'ap', vendor: 'Ubiquiti', title: 'Ubiquiti UniFi U6 Lite',
    tagline: 'Wi-Fi 6 無線基地台 · 需要 PoE 供電 (802.3af)', ports: [rj('eth0', 'LAN / PoE')], needsPoe: true,
  },
  erx: {
    kind: 'router', shape: 'router-s', vendor: 'Ubiquiti', title: 'Ubiquiti EdgeRouter X',
    tagline: '5 埠 Gigabit 路由器', ports: seq(5, (i) => rj('eth' + i), 0),
  },
  isr4321: {
    kind: 'router', shape: 'router-r', vendor: 'Cisco', title: 'Cisco ISR 4321',
    tagline: '整合服務路由器 · 2×GE', ports: [rj('Gi0/0/0'), rj('Gi0/0/1')],
  },
  isr4331: {
    kind: 'router', shape: 'router-r', vendor: 'Cisco', title: 'Cisco ISR 4331',
    tagline: '整合服務路由器 · 3×GE', ports: [rj('Gi0/0/0'), rj('Gi0/0/1'), rj('Gi0/0/2')],
  },
  c2960: {
    kind: 'mswitch', shape: 'switch-r', vendor: 'Cisco', title: 'Cisco Catalyst 2960-CX-8TC-L',
    tagline: '網管型 L2 交換器 · 8×GE + 2×GE 上行 + 2×SFP',
    ports: [...seq(10, (i) => rj('Gi0/' + i)), sfp('Gi0/11'), sfp('Gi0/12')],
  },
  c2960p: {
    kind: 'mswitch', shape: 'switch-r', vendor: 'Cisco', title: 'Cisco Catalyst 2960-CX-8PC-L',
    tagline: '網管型 PoE+ 交換器 · 8×GE PoE+ + 2×GE 上行 + 2×SFP',
    ports: [...seq(8, (i) => rj('Gi0/' + i, 'Gi0/' + i, { poe: true })), rj('Gi0/9'), rj('Gi0/10'), sfp('Gi0/11'), sfp('Gi0/12')],
  },
  c9300: {
    kind: 'l3switch', shape: 'switch-r', vendor: 'Cisco', title: 'Cisco Catalyst 9300-24T',
    tagline: '園區核心 L3 交換器 · 24×GE + 4×10G SFP+',
    ports: [...seq(24, (i) => rj('Gi1/0/' + i)), ...seq(4, (i) => sfp('Te1/1/' + i))],
  },
  fg60f: {
    kind: 'firewall', shape: 'firewall', vendor: 'Fortinet', title: 'Fortinet FortiGate 60F',
    tagline: '次世代防火牆 · 2 WAN + DMZ + 5 Internal',
    ports: [rj('wan1', 'WAN1'), rj('wan2', 'WAN2'), rj('dmz', 'DMZ'), ...seq(5, (i) => rj(String(i)))],
    bridge: ['1', '2', '3', '4', '5'],
    l3: [['wan1', 'wan1'], ['wan2', 'wan2'], ['dmz', 'dmz']],
  },
  fg100f: {
    kind: 'firewall', shape: 'firewall', vendor: 'Fortinet', title: 'Fortinet FortiGate 100F',
    tagline: '資料中心邊界防火牆 · 2×10G SFP+',
    ports: [rj('wan1', 'WAN1'), rj('wan2', 'WAN2'), rj('dmz', 'DMZ'), sfp('x1', 'X1'), sfp('x2', 'X2')],
    bridge: [],
    l3: [['wan1', 'wan1'], ['wan2', 'wan2'], ['dmz', 'dmz'], ['x1', 'x1'], ['x2', 'x2']],
  },
  n93180: {
    kind: 'l3switch', shape: 'switch-dc', vendor: 'Cisco', title: 'Cisco Nexus 93180YC-FX',
    tagline: 'Leaf / ToR 交換器 · 48×25G SFP28 + 6×100G QSFP28',
    ports: [...seq(48, (i) => sfp('Eth1/' + i)), ...seq(6, (i) => qsfp('Eth1/' + i), 49)],
  },
  n9332: {
    kind: 'l3switch', shape: 'switch-dc', vendor: 'Cisco', title: 'Cisco Nexus 9332C',
    tagline: 'Spine / 核心交換器 · 32×100G QSFP28', ports: seq(32, (i) => qsfp('Eth1/' + i)),
  },
  internet: {
    kind: 'internet', shape: 'globe', vendor: 'ISP', title: '網際網路 (ISP)',
    tagline: '電信業者線路', ports: [rj('line1', '線路 1')],
  },
};

function iface(id, label, bind, extra = {}) {
  return {
    id, label, bind,
    mode: 'static', // static | dhcp | pppoe
    ip: '', mask: '', gateway: '', dns: '',
    user: '', pass: '',
    nat: false, ospf: false, ping: true,
    dhcp: { on: false, start: '', end: '', dns: '', gw: '' },
    ...extra,
  };
}
export const newIface = iface;

const swPort = () => ({ mode: 'access', vlan: 1, native: 1, allowed: 'all', shut: false });
// 原廠預設：SNMP 沒有開（snmp 不寫就是關閉）。關卡裡的設備由 levels/index.js 補上前任管理員留下的設定
const mgmt = () => ({ ssh: true, telnet: true, http: true, https: true, allow: '', ntp: '', syslog: '', user: 'admin', pass: 'admin' });
export const newWifi = (ssids = []) => ({ ssids, ch24: 1, ch5: 36, power: 'mid' });
export const newSsid = (o = {}) => ({ name: '', sec: 'wpa2', pass: '', vlan: '', isolate: false, ...o });

/** 建立一台設備。o: { name, pos, ip, mask, gw, dns, dhcp, wifi, services, locked, init(d) } */
export function makeDevice(model, id, o = {}) {
  const m = CATALOG[model];
  if (!m) throw new Error('unknown model ' + model);
  const d = {
    id, model, kind: m.kind, name: o.name || id, pos: o.pos || [0, 0],
    ports: (o.ports || m.ports).map((p) => ({ ...p })),
    ifaces: [], routes: [], services: [...(m.services || []), ...(o.services || [])],
    locked: !!o.locked, note: o.note || '',
  };
  switch (m.kind) {
    case 'host':
      d.ifaces = d.ports.map((p) => iface(p.id, p.label, { t: 'port', port: p.id }));
      if (m.wlan) d.ifaces.push(iface('wlan0', 'Wi-Fi', { t: 'wlan' }, { mode: 'dhcp', wifi: { ssid: '', pass: '' } }));
      break;
    case 'hub':
    case 'switch':
      d.sw = { mode: m.kind === 'hub' ? 'hub' : 'plain', ports: Object.fromEntries(d.ports.map((p) => [p.id, {}])) };
      break;
    case 'ap':
      d.sw = { mode: 'plain', ports: Object.fromEntries(d.ports.map((p) => [p.id, {}])) };
      d.wifi = newWifi();
      d.ifaces = [iface('mgmt', '管理介面', { t: 'bridge' }, { mode: 'dhcp' })];
      d.radius = { ip: '', secret: '' };
      break;
    case 'mswitch':
    case 'l3switch':
      d.sw = {
        mode: 'vlan', vlans: [{ id: 1, name: 'default' }],
        ports: Object.fromEntries(d.ports.map((p) => [p.id, swPort()])),
        stp: { on: true, prio: 32768 }, snoop: { on: false }, dai: { on: false },
      };
      d.mgmt = mgmt();
      d.radius = { ip: '', secret: '' };
      if (m.kind === 'l3switch') { d.routing = true; d.ospfDefault = false; }
      else d.ifaces = [iface('mgmt', '管理介面', { t: 'svi', vlan: 1 })];
      break;
    case 'router':
      d.ifaces = d.ports.map((p) => iface(p.id, p.label, { t: 'port', port: p.id }));
      d.routing = true; d.portForwards = []; d.vpns = []; d.ospfDefault = false; d.mgmt = mgmt();
      d.staticNat = []; d.routes6 = []; d.v6routing = false;
      break;
    case 'homerouter':
      d.sw = { mode: 'plain', ports: Object.fromEntries(d.ports.filter((p) => p.id !== 'wan').map((p) => [p.id, {}])) };
      d.ifaces = [
        iface('wan', 'WAN', { t: 'port', port: 'wan' }, { mode: 'dhcp', nat: true, ping: false }),
        iface('lan', 'LAN', { t: 'bridge' }, { ip: '192.168.50.1', mask: '255.255.255.0' }),
      ];
      d.routing = true; d.dnsProxy = true; d.portForwards = []; d.wifi = newWifi(); d.wifi.ch24 = 6;
      break;
    case 'firewall':
      d.sw = { mode: 'plain', ports: Object.fromEntries(m.bridge.map((p) => [p, {}])) };
      d.ifaces = m.l3.map(([pid, name]) => iface(name, name, { t: 'port', port: pid }));
      if (m.bridge.length) d.ifaces.push(iface('internal', 'internal', { t: 'bridge' }));
      d.routing = true; d.policies = []; d.portForwards = []; d.vpns = []; d.mgmt = mgmt();
      d.vpnServer = { on: false, start: '', end: '', subnets: '', users: [] };
      break;
    case 'internet':
      d.routing = true; d.locked = true;
      d.inet = {
        hosts: [
          { ip: '8.8.8.8', name: 'Google Public DNS', services: [{ proto: 'udp', port: 53 }] },
          { ip: '1.1.1.1', name: 'Cloudflare DNS', services: [{ proto: 'udp', port: 53 }] },
          { ip: '168.95.1.1', name: 'HiNet DNS', services: [{ proto: 'udp', port: 53 }] },
          { ip: '93.184.216.34', name: 'www.example.com', services: [{ proto: 'tcp', port: 80 }, { proto: 'tcp', port: 443 }] },
          { ip: '198.51.100.77', name: '外部使用者', services: [] },
        ],
        dns: { 'www.example.com': '93.184.216.34', 'example.com': '93.184.216.34', 'dns.google': '8.8.8.8' },
        client: '198.51.100.77',
      };
      d.ifaces = d.ports.map((p) => iface(p.id, p.label, { t: 'port', port: p.id }));
      break;
  }
  // 主機快速設定
  if (m.kind === 'host') {
    const i = d.ifaces[0];
    if (o.dhcp) i.mode = 'dhcp';
    if (o.ip) { i.mode = 'static'; i.ip = o.ip; i.mask = o.mask || '255.255.255.0'; }
    if (o.gw) i.gateway = o.gw;
    if (o.dns) i.dns = o.dns;
    if (o.wifi) Object.assign(d.ifaces.find((x) => x.bind.t === 'wlan').wifi, o.wifi);
  }
  if (o.init) o.init(d);
  return d;
}

/** ISP 線路設定：line = { type:'dhcp'|'static'|'pppoe', gw, mask, assign, user, pass, dns } */
export function setLine(inet, portId, line) {
  const i = inet.ifaces.find((x) => x.id === portId);
  i.ip = line.gw; i.mask = line.mask || '255.255.255.0';
  i.line = { dns: '168.95.1.1, 8.8.8.8', ...line };
  return inet;
}

export function makeState(devices, cables = []) {
  const state = { devices: {}, cables: [], leases: {}, seq: 1 };
  for (const d of devices) state.devices[d.id] = d;
  for (const c of cables) {
    const [a, b] = c;
    const [ad, ap] = a.split(':'), [bd, bp] = b.split(':');
    const err = addCable(state, ad, ap, bd, bp);
    if (err) throw new Error(`cable ${a} - ${b}: ${err}`);
  }
  return state;
}

export const portOf = (dev, pid) => dev.ports.find((p) => p.id === pid);

export function cableAt(state, devId, pid) {
  return state.cables.find((c) => (c.a.dev === devId && c.a.port === pid) || (c.b.dev === devId && c.b.port === pid));
}
export function peerOf(state, devId, pid) {
  const c = cableAt(state, devId, pid);
  if (!c) return null;
  const o = c.a.dev === devId && c.a.port === pid ? c.b : c.a;
  return { dev: o.dev, port: o.port, cable: c.id };
}

/** 接線；成功回傳 null，失敗回傳原因字串 */
export function addCable(state, aDev, aPort, bDev, bPort, kind) {
  const A = state.devices[aDev], B = state.devices[bDev];
  if (!A || !B) return '找不到設備';
  if (aDev === bDev) return '不能把線接回同一台設備';
  const pa = portOf(A, aPort), pb = portOf(B, bPort);
  if (!pa || !pb) return '找不到連接埠';
  if (pa.media !== pb.media) return `接頭規格不同（${MEDIA[pa.media].name} ↔ ${MEDIA[pb.media].name}）`;
  if (cableAt(state, aDev, aPort)) return `${A.name} 的 ${pa.label} 已經插了線`;
  if (cableAt(state, bDev, bPort)) return `${B.name} 的 ${pb.label} 已經插了線`;
  const k = kind && CABLES[kind] && CABLES[kind].media.includes(pa.media) ? kind : pa.media === 'rj45' ? 'cat6' : 'dac';
  state.cables.push({ id: 'c' + state.seq++, a: { dev: aDev, port: aPort }, b: { dev: bDev, port: bPort }, media: pa.media, kind: k });
  return null;
}

export function removeCable(state, cableId) {
  state.cables = state.cables.filter((c) => c.id !== cableId);
}

/** 可序列化的深層複製（去掉執行期計算結果 rt） */
export function cloneState(state) {
  const devs = state.devices; // 設備 id 也可能剛好叫 "rt"，所以要排除 devices 這一層
  return JSON.parse(JSON.stringify(state, function (k, v) {
    return k === 'rt' && this !== devs ? undefined : v;
  }));
}

/** 設備「主要」的 L3 介面：優先挑有連線、不是 APIPA 的那一個 */
export function primaryIface(dev) {
  const withIp = dev.ifaces.filter((i) => i.rt && i.rt.ip != null);
  return withIp.find((i) => i.rt.link && i.rt.src !== 'apipa') || withIp.find((i) => i.rt.link) || withIp[0] || null;
}
export function primaryIp(dev) {
  const i = primaryIface(dev);
  return i ? i.rt.ip : null;
}

export const isIp = (s) => parseIp(s) != null;

// ── 連接埠速率 ──
const MEDIA_SPEED = { rj45: 1000, sfp: 10000, qsfp: 100000 };
const SFP_SPEED = { rack1u: 25000, n93180: 25000, c2960: 1000, c2960p: 1000 };
export const portSpeed = (dev, p) => (dev.kind === 'hub' ? 10 : p.media === 'sfp' ? SFP_SPEED[dev.model] || 10000 : MEDIA_SPEED[p.media]);
export const fmtSpeed = (m) => (m >= 1000 ? m / 1000 + ' Gbps' : m + ' Mbps');
/** 連接埠手動設定的速率與雙工（沒設定就是 null，代表自動協商）。交換器的設定在埠上，路由器在介面上 */
export function phyConfig(dev, pid) {
  if (dev.kind === 'hub') return { speed: 10, duplex: 'half' }; // Hub 不會協商，永遠是 10 Mbps 半雙工
  const pc = dev.sw && dev.sw.ports && dev.sw.ports[pid];
  const c = pc || dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === pid) || {};
  return { speed: c.speed && c.speed !== 'auto' ? +c.speed : null, duplex: c.duplex && c.duplex !== 'auto' ? c.duplex : null };
}
const DUP = { full: '全雙工', half: '半雙工' };
/**
 * 一條線兩端協商的結果，從 devId 這一端來看。
 * - 兩端都自動協商：用兩端都支援的最高速率、全雙工。
 * - 一端把速率和雙工都寫死（關閉協商）、另一端自動：自動的那一端量得出速率，但不知道對方的雙工，
 *   10 / 100 Mbps 會退回半雙工 — 對方如果寫死全雙工，就是雙工不一致 (duplex mismatch)。
 * - 兩端的速率寫死成不同的值：連線建立不起來。
 * 回傳 { speed, duplex, peerDuplex, half, mismatch, text }，連線建立不起來則是 { down: 原因 }。
 */
export function linkInfo(state, devId, pid) {
  const peer = peerOf(state, devId, pid);
  if (!peer) return null;
  const A = state.devices[devId], B = state.devices[peer.dev];
  const pa = portOf(A, pid), pb = portOf(B, peer.port);
  const max = Math.min(portSpeed(A, pa), portSpeed(B, pb));
  const done = (speed, da, db) => ({
    speed, duplex: da, peerDuplex: db, half: da === 'half' && db === 'half', mismatch: da !== db,
    text: `${fmtSpeed(speed)} · ${da === db ? DUP[da] : `雙工不一致（這一端${DUP[da]}、對端${DUP[db]}）`}`,
  });
  if (pa.media !== 'rj45') return done(max, 'full', 'full'); // 光纖與 DAC：速率由收發器決定，一律全雙工
  const ca = phyConfig(A, pid), cb = phyConfig(B, peer.port);
  if (ca.speed != null && cb.speed != null && ca.speed !== cb.speed) return { down: `兩端的速率設定不同（${A.name} 是 ${ca.speed} Mbps、${B.name} 是 ${cb.speed} Mbps），連線建立不起來` };
  const speed = ca.speed ?? cb.speed ?? max;
  if (speed > max) return { down: `速率被設定成 ${speed} Mbps，但對面的連接埠最高只支援 ${max} Mbps` };
  const fixA = ca.speed != null && ca.duplex != null, fixB = cb.speed != null && cb.duplex != null;
  const fallback = speed >= 1000 ? 'full' : 'half';
  if (fixA && !fixB) return done(speed, ca.duplex, cb.duplex ?? fallback);
  if (fixB && !fixA) return done(speed, ca.duplex ?? fallback, cb.duplex);
  if (fixA && fixB) return done(speed, ca.duplex, cb.duplex);
  // 兩端都還在協商：有人只肯用半雙工就是半雙工；各自堅持不同的雙工則是不一致
  if (ca.duplex && cb.duplex) return done(speed, ca.duplex, cb.duplex);
  const d = ca.duplex || cb.duplex || 'full';
  return done(speed, d, d);
}

/** 自由模式用：替新設備找一個還沒被用掉的 id */
export function uniqueId(state, base) {
  let n = 1;
  while (state.devices[base + '-' + n]) n++;
  return base + '-' + n;
}
