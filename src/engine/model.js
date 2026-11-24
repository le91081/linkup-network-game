// 設備型錄（以現實世界的機型為藍本）與設備物件工廠
import { JUNOS_DEFAULT, applyJunos } from './junos.js';
import { parseIp } from './ip.js';
import { newVpc, CLOUD_REGION } from './cloud.js';
import { opticsOf, opticLink, rejectsOptic } from './optics.js';

const rj = (id, label = id, extra) => ({ id, label, media: 'rj45', ...extra });
const sfp = (id, label = id) => ({ id, label, media: 'sfp' });
const qsfp = (id, label = id) => ({ id, label, media: 'qsfp' });
/** 虛擬網卡：只能接在虛擬化主機的虛擬埠上 */
const virt = (id, label = id) => ({ id, label, media: 'virt' });
const seq = (n, f, from = 1) => Array.from({ length: n }, (_, i) => f(i + from));

export const MEDIA = {
  rj45: { name: 'RJ45', cable: 'Cat6 網路線', color: 0x4f9cf9 },
  sfp: { name: 'SFP+/SFP28', cable: 'DAC 直連銅纜', color: 0xf5b547 },
  qsfp: { name: 'QSFP28', cable: '100G 光纖', color: 0x35d6c1 },
  virt: { name: '虛擬網卡', cable: '虛擬連線', color: 0xb48cff },
};

/** 線材種類：最大傳輸距離（公尺）與適用的接頭 */
export const CABLES = {
  cat6: { name: 'Cat6 銅纜', max: 100, media: ['rj45'], color: 0x4f9cf9 },
  dac: { name: 'DAC 直連銅纜', max: 5, media: ['sfp', 'qsfp'], color: 0xf5b547 },
  mmf: { name: '多模光纖 (OM4) + SR 收發器', max: 300, media: ['sfp', 'qsfp'], color: 0x35d6c1 },
  smf: { name: '單模光纖 (OS2) + LR 收發器', max: 10000, media: ['sfp', 'qsfp'], color: 0xf7e04a },
  virtual: { name: '虛擬連線（主機內部）', max: Infinity, media: ['virt'], color: 0xb48cff },
};
export const cableKinds = (media) => Object.keys(CABLES).filter((k) => CABLES[k].media.includes(media));
export const cableKind = (c) => c.kind || ((c.media || 'rj45') === 'rj45' ? 'cat6' : c.media === 'virt' ? 'virtual' : 'dac');
/** 兩台設備之間的佈線距離（公尺）。關卡沒有特別指定時視為同一個機房內的 3 公尺 */
export const pairDist = (state, a, b) => (state.dist && state.dist[[a, b].sort().join('|')]) || 3;
export const cableDist = (state, c) => pairDist(state, c.a.dev, c.b.dev);

/**
 * kind:
 *  host       終端設備（PC / 伺服器 / 手機 / 印表機 / IP 電話…）
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
  laptop6e: {
    kind: 'host', shape: 'laptop', vendor: 'Lenovo', title: 'Lenovo ThinkPad T14 Gen 5',
    tagline: '筆記型電腦 · 1GbE + Wi-Fi 6E（支援 6 GHz）', ports: [rj('eth0', '乙太網路')], wlan: true, band6: true,
  },
  phone: {
    kind: 'host', shape: 'phone', vendor: 'Apple', title: 'Apple iPhone 15',
    tagline: '智慧型手機 · Wi-Fi 6', ports: [], wlan: true,
  },
  ipphone: {
    kind: 'host', shape: 'ipphone', vendor: 'Cisco', title: 'Cisco IP Phone 8841',
    tagline: 'IP 電話 · SW 埠接交換器、PC 埠接電腦 · PoE Class 2 (802.3af)',
    ports: [rj('sw', 'SW'), rj('pc', 'PC')], needsPoe: true, poeIn: 'sw', poe: { cls: 2, watts: 6.3 }, phone: true,
    services: [{ proto: 'udp', port: 5060, name: 'SIP' }, { proto: 'udp', port: 16384, name: 'RTP 語音' }],
  },
  t54w: {
    kind: 'host', shape: 'ipphone', vendor: 'Yealink', title: 'Yealink SIP-T54W',
    tagline: 'SIP 電話 · 只會 LLDP-MED（沒有 CDP）· PoE Class 3',
    ports: [rj('sw', 'Internet'), rj('pc', 'PC')], needsPoe: true, poeIn: 'sw', poe: { cls: 3, watts: 7.4 }, phone: true,
    services: [{ proto: 'udp', port: 5060, name: 'SIP' }, { proto: 'udp', port: 16384, name: 'RTP 語音' }],
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
  ipcam: {
    kind: 'host', shape: 'camera', vendor: 'Hikvision', title: 'Hikvision DS-2CD2043G2-I',
    tagline: '4MP 槍型網路攝影機 · 紅外線夜視 · PoE Class 3 (802.3af)', ports: [rj('eth0', 'LAN / PoE')], needsPoe: true, poe: { cls: 3, watts: 6.5 }, cam: true,
    services: [{ proto: 'tcp', port: 554, name: 'RTSP 影像串流' }, { proto: 'tcp', port: 443, name: '網頁管理 (HTTPS)' }],
  },
  nvr: {
    kind: 'host', shape: 'nas', vendor: 'Hikvision', title: 'Hikvision DS-7608NXI-K2',
    tagline: '8 路網路錄影機 (NVR) · 2 顆硬碟 · 1×1GbE', ports: [rj('eth0', 'LAN')], nvr: true,
    services: [{ proto: 'tcp', port: 554, name: 'RTSP 錄影' }, { proto: 'tcp', port: 443, name: '網頁管理 (HTTPS)' }],
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
  bigip: {
    kind: 'lb', shape: 'bigip', vendor: 'F5', title: 'F5 BIG-IP i2800',
    tagline: '應用程式交付控制器（負載平衡器 LTM）· 4×1GbE + 2×10GbE SFP+', ports: [rj('1.1'), rj('1.2'), rj('1.3'), rj('1.4'), sfp('2.1'), sfp('2.2')],
  },
  ups: {
    kind: 'host', shape: 'ups', vendor: 'APC', title: 'APC Smart-UPS SMT1500RMI2U',
    tagline: '不斷電系統 · 1500 VA / 1000 W · 機架式 2U · 網路管理卡 (NMC)', ports: [rj('mgmt', 'NMC（網路管理卡）')],
    ups: { va: 1500, watts: 1000, wh: 165 }, services: [{ proto: 'tcp', port: 443, name: 'NMC 網頁' }, { proto: 'udp', port: 161, name: 'SNMP' }],
  },
  esxi: {
    kind: 'hypervisor', shape: 'esxi', vendor: 'VMware', title: 'VMware ESXi 8',
    tagline: 'Dell PowerEdge R650 · 2×25GbE 上行（NIC teaming）· 8 個虛擬埠', ports: [sfp('vmnic0', 'vmnic0'), sfp('vmnic1', 'vmnic1'), ...seq(8, (i) => virt('vp' + i, '虛擬埠 ' + i))],
    services: [{ proto: 'tcp', port: 443, name: 'ESXi Host Client (HTTPS)' }, { proto: 'tcp', port: 8000, name: 'vMotion' }],
  },
  vm: {
    kind: 'host', shape: 'vm', vendor: 'VM', title: '虛擬機器', vm: true,
    tagline: '在虛擬化主機上執行 · 1 張虛擬網卡 (vmxnet3)', ports: [virt('eth0', 'vNIC')],
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
    tagline: 'Wi-Fi 6 無線基地台 · 需要 PoE 供電 (802.3af)', ports: [rj('eth0', 'LAN / PoE')], needsPoe: true, poe: { cls: 0, watts: 12 },
  },
  ap6e: {
    kind: 'ap', shape: 'ap', vendor: 'Ubiquiti', title: 'Ubiquiti UniFi U6 Enterprise',
    tagline: 'Wi-Fi 6E 三頻基地台（2.4 / 5 / 6 GHz）· 需要 PoE+ 供電 (802.3at)', ports: [rj('eth0', 'LAN / PoE')], needsPoe: true, poe: { cls: 4, watts: 22 }, band6: true,
  },
  ont: {
    kind: 'homerouter', shape: 'router-s', vendor: 'ZTE', title: 'ZTE F670L 光纖數據機 (GPON ONT)', ont: true,
    tagline: '電信業者的光纖數據機 · PON + 4 LAN · 路由模式（撥接、NAT、DHCP）/ 橋接模式',
    ports: [rj('wan', 'PON（光纖）'), ...seq(4, (i) => rj('lan' + i, 'LAN ' + i))],
  },
  hex: {
    kind: 'router', shape: 'router-s', vendor: 'MikroTik', title: 'MikroTik hEX (RB750Gr3)', ros: true,
    tagline: '5 埠 Gigabit 路由器 · RouterOS（指令改了立刻生效）', ports: seq(5, (i) => rj('ether' + i)),
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
    poeBudget: 124, // PoE+ 的總預算（瓦）：每個埠最多 30 W，但八個埠加起來只有 124 W
  },
  patch24: {
    kind: 'patch', shape: 'switch-r', vendor: '配線架', title: '24 埠 Cat6 配線架 (Patch Panel)',
    tagline: '被動元件：前面第 n 孔和後面第 n 孔直接相通（後面打線到牆上的網路孔，前面用跳線接交換器）',
    ports: [...seq(24, (i) => rj('f' + i, '前 ' + i)), ...seq(24, (i) => rj('r' + i, '後 ' + i))],
  },
  metroe: {
    kind: 'mswitch', shape: 'switch-r', vendor: '電信業者', title: 'Metro Ethernet 專線（E-Line）', evc: true,
    tagline: '電信業者的第二層專線：兩個據點之間的 EVC，客戶端的介面叫 UNI', ports: [rj('uni-a', 'UNI A'), rj('uni-b', 'UNI B')],
  },
  metroelan: {
    kind: 'mswitch', shape: 'switch-r', vendor: '電信業者', title: 'Metro Ethernet 專線（E-LAN）', evc: true,
    tagline: '電信業者的多點第二層專線：好幾個據點在同一個廣播網域（像一台很大的交換器）', ports: [rj('uni-a', 'UNI A'), rj('uni-b', 'UNI B'), rj('uni-c', 'UNI C'), rj('uni-d', 'UNI D')],
  },
  cx6100: {
    kind: 'mswitch', shape: 'switch-r', vendor: 'Aruba', title: 'Aruba CX 6100 24G', aoscx: true, lldp: true,
    tagline: '網管型 L2 交換器 · 24×GE + 4×10G SFP+ · AOS-CX（只講 LLDP，不講 CDP、不會 DTP）',
    ports: [...seq(24, (i) => rj('1/1/' + i)), ...seq(4, (i) => sfp('1/1/' + i), 25)],
  },
  ex2300: {
    kind: 'mswitch', shape: 'switch-r', vendor: 'Juniper', title: 'Juniper EX2300-24T', junos: true, lldp: true,
    tagline: '網管型 L2 交換器 · 24×GE + 4×10G SFP+ · Junos（commit 才生效、不會 DTP）',
    ports: [...seq(24, (i) => rj('ge-0/0/' + i), 0), ...seq(4, (i) => sfp('xe-0/1/' + i), 0)],
  },
  c9300: {
    kind: 'l3switch', shape: 'switch-r', vendor: 'Cisco', title: 'Cisco Catalyst 9300-24T',
    tagline: '園區核心 L3 交換器 · 24×GE + 4×10G SFP+ · 管理埠 Gi0/0',
    // Gi0/0 是帶外管理埠：不是交換埠，出廠就在 Mgmt-vrf 裡（自己的路由表）
    ports: [...seq(24, (i) => rj('Gi1/0/' + i)), ...seq(4, (i) => sfp('Te1/1/' + i)), rj('Gi0/0', 'Gi0/0', { mgmt: true })],
    stackable: true, // StackWise-480：最多 8 台堆疊成一台（engine/stack.js）
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
    ports: [...seq(48, (i) => sfp('Eth1/' + i)), ...seq(6, (i) => qsfp('Eth1/' + i), 49), rj('mgmt0', 'mgmt0', { mgmt: true })],
  },
  n9332: {
    kind: 'l3switch', shape: 'switch-dc', vendor: 'Cisco', title: 'Cisco Nexus 9332C',
    tagline: 'Spine / 核心交換器 · 32×100G QSFP28', ports: [...seq(32, (i) => qsfp('Eth1/' + i)), rj('mgmt0', 'mgmt0', { mgmt: true })],
  },
  c9800: {
    kind: 'wlc', shape: 'switch-r', vendor: 'Cisco', title: 'Cisco Catalyst 9800-L',
    tagline: '無線控制器 (WLC) · 4×10G 上行', ports: seq(4, (i) => rj('Te0/1/' + i), 0),
  },
  c9120: {
    kind: 'ap', shape: 'ap', vendor: 'Cisco', title: 'Cisco Catalyst 9120AXI',
    tagline: '輕量型基地台 · 要由無線控制器管理 · 802.3at PoE', ports: [rj('Gi0', 'Gi0 / PoE')], needsPoe: true, poe: { cls: 4, watts: 20.9 }, lwap: true,
  },
  tgw: {
    kind: 'cloud', shape: 'cloud', vendor: 'AWS', title: 'AWS Transit Gateway',
    tagline: '區域裡的雲端路由器 · 把很多個 VPC（與 VPN）接在一起', ports: [], tgw: true,
  },
  vpc: {
    kind: 'cloud', shape: 'cloud', vendor: 'AWS', title: 'Amazon VPC',
    tagline: '公有雲的虛擬私有雲 · 東京區域', ports: [rj('inet', '網際網路')],
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
/** Catalyst 9300 的堆疊：每台成員 24×GE + 4×10G，埠名稱的第一個數字是成員編號（Gi2/0/1、Te2/1/1）；管理埠 Gi0/0 在 Active 上 */
export const stackPorts = (n) => [...seq(n, (k) => [...seq(24, (i) => rj(`Gi${k}/0/${i}`)), ...seq(4, (i) => sfp(`Te${k}/1/${i}`))]).flat(), rj('Gi0/0', 'Gi0/0', { mgmt: true })];

// Catalyst 的連接埠出廠是 dynamic auto（會用 DTP 和對面協商要不要變成 Trunk）；Nexus 沒有 DTP，出廠是 access
export const DTP_MODELS = new Set(['c2960', 'c2960p', 'c9300']);
export const defaultPortMode = (model) => (DTP_MODELS.has(model) ? 'dynamic-auto' : 'access');
const swPort = (model) => ({ mode: defaultPortMode(model), vlan: 1, native: 1, allowed: 'all', shut: false });
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
    ports: (o.ports || (o.stack > 1 && m.stackable ? stackPorts(o.stack) : m.ports)).map((p) => ({ ...p })),
    ifaces: [], routes: [], services: [...(m.services || []), ...(o.services || [])],
    locked: !!o.locked, note: o.note || '',
  };
  switch (m.kind) {
    case 'host':
      if (m.phone) {
        // IP 電話裡面是一台三埠的小交換器：SW 埠、PC 埠、電話自己。電話的介面接在這台小交換器上
        d.sw = { mode: 'phone', ports: { sw: {}, pc: {} } };
        d.ifaces = [iface('voice', '電話', { t: 'bridge' }, { mode: 'dhcp' })];
        d.phone = { vlan: '', tftp: '', pcPort: true };
        break;
      }
      d.ifaces = d.ports.map((p) => iface(p.id, p.label, { t: 'port', port: p.id }));
      if (m.cam) d.cam = { nvr: '', mbps: 4 }; // 網路攝影機：影像送到哪一台 NVR、位元率
      if (m.ups) d.ups = { feed: '', ext: 0 }; // UPS：供應哪一路電（engine/power.js）、外接電池組
      if (m.wlan) d.ifaces.push(iface('wlan0', 'Wi-Fi', { t: 'wlan' }, { mode: 'dhcp', wifi: { ssid: '', pass: '' } }));
      break;
    case 'patch':
      d.patch = { labels: {} };
      break;
    case 'hub':
    case 'switch':
      d.sw = { mode: m.kind === 'hub' ? 'hub' : 'plain', ports: Object.fromEntries(d.ports.map((p) => [p.id, {}])) };
      break;
    case 'ap':
      d.sw = { mode: 'plain', ports: Object.fromEntries(d.ports.map((p) => [p.id, {}])) };
      d.wifi = newWifi();
      if (m.band6) d.wifi.ch6 = 37; // 6 GHz 的 PSC 頻道
      d.ifaces = [iface('mgmt', '管理介面', { t: 'bridge' }, { mode: 'dhcp' })];
      d.radius = { ip: '', secret: '' };
      if (m.lwap) d.lwap = { mode: 'local', primary: '' };
      break;
    case 'wlc':
      // 無線控制器：連接埠是 Trunk（接核心交換器），無線管理介面 (WMI) 是一個 SVI；WLAN 由控制器推給輕量型 AP
      d.sw = {
        mode: 'vlan', vlans: [{ id: 1, name: 'default' }],
        ports: Object.fromEntries(d.ports.map((p) => [p.id, { mode: 'trunk', vlan: 1, native: 1, allowed: 'all', shut: false }])),
        stp: { on: false, prio: 32768 }, snoop: { on: false }, dai: { on: false },
      };
      d.ifaces = [iface('wmi', '無線管理介面', { t: 'svi', vlan: 1 })];
      d.wlc = { wlans: [] };
      d.mgmt = mgmt();
      d.radius = { ip: '', secret: '' };
      break;
    case 'hypervisor':
      // 虛擬化主機：裡面是一台虛擬交換器。實體網卡是 Trunk 上行，虛擬埠的 VLAN 由連接埠群組決定（engine/virt.js）
      d.sw = {
        mode: 'vlan', vlans: [{ id: 1, name: 'native' }],
        ports: Object.fromEntries(d.ports.map((p) => [p.id, p.media === 'virt' ? { mode: 'access', vlan: 1, native: 1, allowed: 'all', shut: false, pg: 'VM Network' } : { mode: 'trunk', vlan: 1, native: 1, allowed: 'all', shut: false }])),
        stp: { on: false, prio: 32768 }, snoop: { on: false }, dai: { on: false },
      };
      d.vsw = { pgs: [{ name: 'VM Network', vlan: 0 }, { name: 'Management Network', vlan: 0 }], vmkPg: 'Management Network' };
      d.ifaces = [iface('vmk0', 'vmk0', { t: 'svi', vlan: 1 })];
      break;
    case 'mswitch':
    case 'l3switch':
      d.sw = {
        mode: 'vlan', vlans: [{ id: 1, name: 'default' }],
        ports: Object.fromEntries(d.ports.map((p) => [p.id, swPort(model)])),
        stp: { on: true, prio: 32768 }, snoop: { on: false }, dai: { on: false },
      };
      d.mgmt = mgmt();
      d.radius = { ip: '', secret: '' };
      if (m.kind === 'l3switch') { d.routing = true; d.ospfDefault = false; }
      else d.ifaces = [iface('mgmt', '管理介面', { t: 'svi', vlan: 1 })];
      // Juniper EX：設定用 Junos 的 set / commit（engine/junos.js），出廠所有的埠在 default VLAN、開著 RSTP
      if (m.junos) d.junos = { active: [...JUNOS_DEFAULT], candidate: null, commits: [] };
      // 帶外管理埠：Routed、在管理用的 VRF 裡（Catalyst 9300 的 Gi0/0 在 Mgmt-vrf；Nexus 的 mgmt0 在 vrf context management）
      for (const p of d.ports.filter((x) => x.mgmt)) {
        const nx = /^n9/.test(model), vn = nx ? 'management' : 'Mgmt-vrf';
        d.sw.ports[p.id] = { ...d.sw.ports[p.id], mode: 'routed' };
        d.vrfs = { ...(d.vrfs || {}), [vn]: nx ? { style: 'ctx', af4: true, mgmt: true } : { style: 'def', af4: true, af6: true, mgmt: true } };
        d.ifaces.push(iface(p.id, p.label, { t: 'port', port: p.id }, { vrf: vn }));
      }
      break;
    case 'lb':
      // 負載平衡器（engine/ltm.js）：每個埠是一個 VLAN 加一個 self IP；virtual server、pool、健康檢查在 d.ltm
      d.ifaces = d.ports.map((p) => iface(p.id, p.label, { t: 'port', port: p.id }));
      d.routing = true; d.mgmt = mgmt();
      d.ltm = { monitors: [], pools: [], virtuals: [] };
      break;
    case 'router':
      d.ifaces = d.ports.map((p) => iface(p.id, p.label, { t: 'port', port: p.id }));
      d.routing = true; d.portForwards = []; d.vpns = []; d.ospfDefault = false; d.mgmt = mgmt();
      d.staticNat = []; d.routes6 = []; d.v6routing = false;
      if (m.ros) d.ros = { identity: 'MikroTik', nat: [], dns: '' }; // MikroTik RouterOS（ui/roscli.js）
      break;
    case 'homerouter':
      d.sw = { mode: 'plain', ports: Object.fromEntries(d.ports.filter((p) => p.id !== 'wan').map((p) => [p.id, {}])) };
      d.ifaces = [
        iface('wan', 'WAN', { t: 'port', port: 'wan' }, { mode: 'dhcp', nat: true, ping: false }),
        iface('lan', 'LAN', { t: 'bridge' }, { ip: '192.168.50.1', mask: '255.255.255.0' }),
      ];
      d.routing = true; d.dnsProxy = true; d.portForwards = []; d.wifi = newWifi(); d.wifi.ch24 = 6;
      // 光纖數據機：出廠是路由模式（自己撥接、NAT、LAN 發 192.168.1.x）；橋接模式時只把光纖轉成乙太網路
      if (m.ont) { d.ont = { bridge: false }; Object.assign(d.ifaces[1], { ip: '192.168.1.1' }); d.ifaces[1].dhcp = { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '', gw: '' }; }
      break;
    case 'firewall':
      d.sw = { mode: 'plain', ports: Object.fromEntries(m.bridge.map((p) => [p, {}])) };
      d.ifaces = m.l3.map(([pid, name]) => iface(name, name, { t: 'port', port: pid }));
      if (m.bridge.length) d.ifaces.push(iface('internal', 'internal', { t: 'bridge' }));
      d.routing = true; d.policies = []; d.portForwards = []; d.vpns = []; d.mgmt = mgmt();
      d.vpnServer = { on: false, start: '', end: '', subnets: '', users: [] };
      break;
    case 'cloud':
      // Transit Gateway：沒有實體的線，VPC 用 attachment 接上來；路由表由各 VPC 的網段傳播而來（也可以加靜態路由）
      if (m.tgw) { d.routing = true; d.ifaces = []; d.tgw = { id: 'tgw-0' + (id.length * 2654435761 >>> 0).toString(16).padStart(8, '0') + 'a1b2c3d4', attach: [], routes: [], noProp: [] }; break; }
      // 雲端業者那一端：「網際網路閘道」介面接 ISP，VPC 裡的東西都在 d.vpc；站對站 VPN 沿用 d.vpns
      d.ifaces = [iface('igw', '網際網路閘道', { t: 'port', port: 'inet' }, { ping: false })];
      d.routing = true; d.vpns = []; d.vpc = newVpc();
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
  if (d.junos) applyJunos(d);
  // 堆疊（engine/stack.js）：o.stack = 成員的台數
  if (o.stack > 1 && m.stackable) d.stack = { members: seq(o.stack, (n) => ({ num: n, prio: 1 })), active: 1, cables: [true, true] };
  if (o.init) o.init(d);
  return d;
}
/** PoE 的等級 → 交換器要先保留多少瓦（Cisco 的作法：CDP 協商出實際用量之前，依等級的上限保留） */
export const POE_CLASS_W = { 0: 15.4, 1: 4.0, 2: 7.0, 3: 15.4, 4: 30.0 };

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
    const [a, b, kind] = c; // 第三個可以指定線材（mmf、smf、dac…）
    const [ad, ap] = a.split(':'), [bd, bp] = b.split(':');
    const err = addCable(state, ad, ap, bd, bp, kind);
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
  if (pa.media !== pb.media) return `接頭規格不同（${MEDIA[pa.media].name} ↔ ${MEDIA[pb.media].name}）${[pa.media, pb.media].sort().join() === 'qsfp,sfp' ? '。QSFP28 的埠可以用 breakout 拆成 4 個 25G / 10G 的子埠（Nexus：interface breakout module 1 port <n> map 25g-4x），再用分歧線接 SFP28' : ''}`;
  if (cableAt(state, aDev, aPort)) return `${A.name} 的 ${pa.label} 已經插了線`;
  if (cableAt(state, bDev, bPort)) return `${B.name} 的 ${pb.label} 已經插了線`;
  const k = kind && CABLES[kind] && CABLES[kind].media.includes(pa.media) ? kind : pa.media === 'rj45' ? 'cat6' : pa.media === 'virt' ? 'virtual' : 'dac';
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
const MEDIA_SPEED = { rj45: 1000, sfp: 10000, qsfp: 100000, virt: 10000 };
const SFP_SPEED = { rack1u: 25000, esxi: 25000, n93180: 25000, c2960: 1000, c2960p: 1000 };
export const portSpeed = (dev, p) => (p.speed ? p.speed : dev.kind === 'hub' ? 10 : p.media === 'sfp' ? SFP_SPEED[dev.model] || 10000 : MEDIA_SPEED[p.media]); // breakout 拆出來的子埠有自己的速率
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
 * 光纖線材兩端的收發器與光的狀態：{ optics: { a, b }, link: opticLink 的結果（{ down } 或 { speed, rx, margin, marginal }） }；不是光纖回傳 null。
 * Cisco 的路由器插第三方收發器：介面起不來（交換器則是 err-disabled，見 sim/phys.js）
 */
export function fiberLink(state, c) {
  if (c.kind !== 'mmf' && c.kind !== 'smf') return null;
  const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
  const pa = portOf(A, c.a.port), pb = portOf(B, c.b.port);
  if (!pa || !pb) return null;
  const sa = portSpeed(A, pa), sb = portSpeed(B, pb);
  const optics = opticsOf(c, sa, sb, pa.media);
  for (const [d, k] of [[A, 'a'], [B, 'b']]) {
    if (!d.sw && rejectsOptic(d, optics[k], (CATALOG[d.model] || {}).vendor)) return { optics, link: { down: `${d.name} 不接受第三方的收發器 ${optics[k]}（%PHY-4-UNSUPPORTED_TRANSCEIVER）：換成原廠的，或設定 service unsupported-transceiver` } };
  }
  return { optics, link: opticLink(c, { optics, portA: sa, portB: sb, media: pa.media, nameA: `${A.name} 的 ${pa.label}`, nameB: `${B.name} 的 ${pb.label}` }, cableDist(state, c)) };
}

/**
 * 一條線兩端協商的結果，從 devId 這一端來看。
 * - 兩端都自動協商：用兩端都支援的最高速率、全雙工。
 * - 一端把速率和雙工都寫死（關閉協商）、另一端自動：自動的那一端量得出速率，但不知道對方的雙工，
 *   10 / 100 Mbps 會退回半雙工 — 對方如果寫死全雙工，就是雙工不一致 (duplex mismatch)。
 * - 兩端的速率寫死成不同的值：連線建立不起來。
 * 回傳 { speed, duplex, peerDuplex, half, mismatch, text }，連線建立不起來則是 { down: 原因 }。
 */
/** 接觸不良的網路線：每 LOOSE.period 秒有 LOOSE.down 秒斷線（每條線的時間點錯開） */
export const LOOSE = { period: 60, down: 4 };
const looseOff = (c) => [...String(c.id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % LOOSE.period;
const loosePhase = (state, c) => (((state.clock || 0) + looseOff(c)) % LOOSE.period + LOOSE.period) % LOOSE.period;
export const looseDown = (state, c) => loosePhase(state, c) < LOOSE.down;
/** 下一次斷線或恢復的時間 */
export function looseNext(state, c) {
  const p = loosePhase(state, c), now = state.clock || 0;
  return p < LOOSE.down ? now + (LOOSE.down - p) : now + (LOOSE.period - p);
}
export function linkInfo(state, devId, pid) {
  const peer = peerOf(state, devId, pid);
  if (!peer) return null;
  const A = state.devices[devId], B = state.devices[peer.dev];
  const pa = portOf(A, pid), pb = portOf(B, peer.port);
  // 線接著的埠不存在了（例如 breakout 合回去、設定還沒貼上）：沒有燈號
  if (!pa || !pb) return { down: `${!pa ? A.name : B.name} 上沒有 ${!pa ? pid : peer.port} 這個連接埠` };
  const max0 = Math.min(portSpeed(A, pa), portSpeed(B, pb));
  // 網路線有線對斷了：1000BASE-T 要四對線都正常，只剩兩對能用的時候自動降到 100 Mbps (speed downshift)
  const cab = state.cables.find((x) => x.id === peer.cable);
  const broken = !!(cab && cab.damaged) && pa.media === 'rj45';
  const max = broken ? Math.min(max0, 100) : max0;
  const loose = !!(cab && cab.loose) && pa.media === 'rj45' && pb.media === 'rj45';
  if (loose && looseDown(state, cab)) return { down: '網路線接觸不良（水晶頭鬆了）：連線時有時無，每分鐘會斷幾秒', flap: true };
  const looseAt = loose ? cab[cab.loose === 'a' ? 'a' : 'b'] : null;
  const done = (speed, da, db) => ({
    ...(looseAt ? { crcAt: { dev: looseAt.dev, port: looseAt.port }, copperCrc: true } : {}),
    speed, duplex: da, peerDuplex: db, half: da === 'half' && db === 'half', mismatch: da !== db, downshift: broken && max0 > 100,
    text: `${fmtSpeed(speed)} · ${da === db ? DUP[da] : `雙工不一致（這一端${DUP[da]}、對端${DUP[db]}）`}${broken && max0 > 100 ? `（兩端都支援 ${fmtSpeed(max0)}，但只協商到 ${fmtSpeed(speed)}）` : ''}`,
  });
  // 光纖：兩端的收發器要相容、收到的光要夠強（見 optics.js）；光功率差一點點就有 CRC 錯誤
  const fo = cab && fiberLink(state, cab);
  if (fo) {
    if (fo.link.down) return { down: fo.link.down };
    const m = fo.link.marginal;
    return { ...done(Math.min(max, fo.link.speed), 'full', 'full'), optic: fo, crcAt: m ? { dev: cab[m].dev, port: cab[m].port } : null };
  }
  if (pa.media !== 'rj45') return done(max, 'full', 'full'); // DAC：速率由埠決定，一律全雙工
  const ca = phyConfig(A, pid), cb = phyConfig(B, peer.port);
  if (broken && (ca.speed === 1000 || cb.speed === 1000)) return { down: '速率被寫死成 1000 Mbps，但這條網路線有線對斷了（1000BASE-T 要四對線都正常），連線建立不起來' };
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
