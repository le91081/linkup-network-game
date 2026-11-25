// MAC 位址的廠商碼 (OUI)
//
// MAC 位址有 6 個位元組：前 3 個是 IEEE 分配給製造商的廠商碼 (OUI)，後 3 個由廠商自己編，
// 所以從 ARP 表或 MAC 位址表的前半段，就看得出「這是哪一家的設備」（Wireshark 也是這樣把位址顯示成 Cisco_xx:xx:xx）。
// 這裡每一組前綴都是那家廠商真的登記過的（對照 IEEE 的公開登記資料），遊戲裡的設備依型號使用。
//
// 第一個位元組的倒數第二個位元是 1（第二個十六進位數字是 2、6、A、E）的位址不是廠商碼，而是「本機管理位址」：
// 雲端的虛擬網卡、容器，還有手機為了不被追蹤、對每個 Wi-Fi 隨機產生的私人位址都是這一種。

export const OUI = {
  cisco: ['00:1b:54', '00:1e:49', '00:23:eb', '2c:54:2d', '58:97:bd', '70:db:98', 'f8:72:ea'],
  fortinet: ['00:09:0f', '70:4c:a5', '90:6c:ac', '08:5b:0e', 'e8:1c:ba'],
  mikrotik: ['4c:5e:0c', '64:d1:54', 'b8:69:f4', 'cc:2d:e0', '48:8f:5a', '74:4d:28'],
  ubiquiti: ['24:a4:3c', 'fc:ec:da', '78:8a:20', 'b4:fb:e4', '74:83:c2'],
  juniper: ['2c:6b:f5', '3c:61:04', '00:05:85'],
  aruba: ['00:0b:86', '94:b4:0f', '20:4c:03'],
  dell: ['f8:bc:12', 'd4:be:d9', 'b8:ca:3a', '18:db:f2', '14:fe:b5', 'f8:b1:56'],
  lcfc: ['54:e1:ad', '8c:16:45', 'e8:6a:64'],
  intel: ['00:1b:21', 'a0:36:9f', '3c:fd:fe'],
  intelwifi: ['8c:8d:28', 'a4:c3:f0', '34:13:e8', 'f8:63:3f', '70:1c:e7', 'dc:a9:71'],
  hp: ['3c:52:82', '70:5a:0f', 'a0:d3:c1', '3c:d9:2b'],
  synology: ['00:11:32', '90:09:d0'],
  hikvision: ['c0:56:e3', '44:19:b6', '28:57:be', 'bc:ad:28'],
  yealink: ['00:15:65', '80:5e:c0', '80:5e:0c'],
  apc: ['00:c0:b7'],
  f5: ['00:01:d7', '00:23:e9'],
  vmware: ['00:0c:29'],
  tplink: ['50:c7:bf', 'ec:08:6b', 'f4:f2:6d', '14:cc:20', 'c0:25:e9'],
  asus: ['04:d9:f5', '2c:fd:a1', 'ac:9e:17'],
  netgear: ['a0:40:a0', '20:e5:2a', '9c:3d:cf'],
  zte: ['00:19:c6', '34:4b:50', 'd0:15:4a', 'c8:64:c7'],
};

/** 登記的廠商名稱（給畫面顯示） */
export const OUI_NAME = {
  cisco: 'Cisco', fortinet: 'Fortinet', mikrotik: 'MikroTik (Routerboard)', ubiquiti: 'Ubiquiti', juniper: 'Juniper', aruba: 'HPE Aruba',
  dell: 'Dell', lcfc: 'LCFC（聯想筆電的製造廠）', intel: 'Intel', intelwifi: 'Intel（無線網卡）', hp: 'HP', synology: 'Synology', hikvision: 'Hikvision',
  yealink: 'Yealink', apc: 'APC', f5: 'F5', vmware: 'VMware（虛擬網卡）', tplink: 'TP-Link', asus: 'ASUS', netgear: 'NETGEAR', zte: 'ZTE',
};

// 每種型號的網卡是哪一家的。'private'：手機對每個 Wi-Fi 隨機產生的私人位址；'aws'：雲端的虛擬網卡（都是本機管理位址）
const BY_MODEL = {
  pc: 'dell', tower: 'dell', rack1u: 'dell', gpusrv: 'dell', laptop: 'lcfc', laptop6e: 'lcfc', phone: 'private',
  ipphone: 'cisco', t54w: 'yealink', printer: 'hp', wprinter: 'hp', ipcam: 'hikvision', nvr: 'hikvision', nas: 'synology',
  bigip: 'f5', ups: 'apc', esxi: 'intel', vm: 'vmware',
  hub4: 'netgear', sw5: 'tplink', sw8: 'tplink', homerouter: 'asus', ap: 'ubiquiti', ap6e: 'ubiquiti', ont: 'zte',
  hex: 'mikrotik', erx: 'ubiquiti', isr4321: 'cisco', isr4331: 'cisco', c2960: 'cisco', c2960p: 'cisco', c9300: 'cisco',
  n93180: 'cisco', n9332: 'cisco', c9800: 'cisco', c9120: 'cisco', cx6100: 'aruba', ex2300: 'juniper',
  fg60f: 'fortinet', fg100f: 'fortinet', metroe: 'juniper', metroelan: 'juniper', internet: 'juniper', tgw: 'aws', vpc: 'aws',
};

// 會跑 STP 的交換器：同一家的都用同一組廠商碼（同一批採購的交換器本來就常常是同一組），
// 這樣優先權一樣時「MAC 最小的當根橋」只看後半段，結果不會因為抽到哪一組廠商碼而變
export const ONE_OUI = new Set(['c2960', 'c2960p', 'c9300', 'n93180', 'n9332', 'cx6100', 'ex2300', 'metroe', 'metroelan']);

/** 這個型號的這個介面用哪一家的廠商碼（筆電的無線網卡是另外一家做的） */
export function ouiKey(model, key) {
  const v = BY_MODEL[model];
  return key === 'wlan' && v === 'lcfc' ? 'intelwifi' : v;
}

const REV = new Map(Object.entries(OUI).flatMap(([k, list]) => list.map((p) => [p, k])));
// 不屬於任何一台設備的位址：虛擬閘道、群播
const SPECIAL = [
  ['ff:ff:ff:ff:ff:ff', '廣播'], ['00:00:0c:07:ac', 'HSRP 的虛擬 MAC (Cisco)'], ['00:00:5e:00:01', 'VRRP 的虛擬 MAC (IANA)'], ['00:07:b4:00', 'GLBP 的虛擬 MAC (Cisco)'],
  ['01:00:5e', 'IPv4 群播'], ['33:33', 'IPv6 群播'], ['01:80:c2', 'STP / LLDP 等第二層協定的群播'], ['01:00:0c', 'Cisco 的第二層協定（CDP、VTP、PVST+）'],
];

/**
 * 一個 MAC 位址是誰的：登記的廠商名稱、特殊用途的位址，或「本機管理位址」。認不出來回傳 ''
 * （接受 aa:bb:cc:dd:ee:ff、AA-BB-CC-DD-EE-FF、aabb.ccdd.eeff）
 */
export function macVendor(mac) {
  const hex = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return '';
  const m = hex.match(/../g).join(':');
  for (const [p, name] of SPECIAL) if (m.startsWith(p)) return name;
  const k = REV.get(m.slice(0, 8));
  if (k) return OUI_NAME[k];
  if (parseInt(hex.slice(0, 2), 16) & 2) return '本機管理位址（隨機或虛擬的，不是廠商碼）';
  return '';
}
