// 第十一章補充：機櫃裡的線全部沒有標籤 — 看不到接線，只能用 CDP / LLDP 與 MAC 位址表找出每個埠接了什麼
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { deviceIdOf } from '../engine/disc.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
// SW-1F 的埠 → 接著的設備（關卡裡看不到線，玩家要自己找出來）
const MAP = { 'Gi0/1': 'fin', 'Gi0/2': 'ap1', 'Gi0/4': 'ph2', 'Gi0/5': 'ap2', 'Gi0/7': 'ph1', 'Gi0/9': 'r1', 'Gi0/10': 'sw2' };
/** description 裡要有對面的名稱：場景上的名字、CDP 的 Device ID 或 LLDP 的系統名稱都可以 */
const names = (d) => [d.name, deviceIdOf(d), deviceIdOf(d).split('.')[0]].map((x) => x.toLowerCase()).filter((x) => x.length >= 2);

export const LEVELS31 = [
  {
    id: 'l103', chapter: 11, title: '機櫃裡的線全部沒有標籤', subtitle: '看不到接線：用 CDP、LLDP 與 MAC 位址表畫出拓撲', tags: ['CDP', 'LLDP', 'MAC 位址表', '文件', '維運'],

    brief: '公司剛接手一間分公司，前一家廠商沒有留下任何拓撲圖，機櫃裡的線也沒有標籤（這一關看不到接線）。一樓交換器 SW-1F 上接了路由器、二樓的交換器、兩台 AP、兩支 IP 電話和財務的電腦。請在 SW-1F 每個有接設備的埠寫上 description（寫出對面設備的名稱），之後交接的人才知道哪個埠接什麼。',
    given: [
      ['SW-1F', 'Catalyst 2960-CX-8PC-L（Gi0/1 – Gi0/8 有 PoE）'], ['會送 CDP 的', 'R1、SW-2F、AP-2F-01（Cisco 9120）、業務電話（Cisco 8841）'],
      ['只送 LLDP 的', '會議室電話（Yealink）、倉庫的 AP-WH-01（UniFi）'], ['不送 CDP / LLDP 的', '財務 PC（MAC 位址在它的「網路設定」或 ip addr 的 link/ether 那一行）'],
    ],
    learn: [
      { t: 'CDP', d: 'Cisco 設備每 60 秒向每個埠送一次 CDP：自己的名稱 (Device ID)、型號、從哪個埠送出來、IP 位址。show cdp neighbors 一眼看出每個埠接了什麼；show cdp neighbors detail 還有 IP 與軟體版本。Cisco 電話的 Device ID 是 SEP 加上 MAC。' },
      { t: 'LLDP', d: '各廠牌通用的版本（IEEE 802.1AB）。IOS 預設沒開，要 lldp run；之後 show lldp neighbors 就看得到 Yealink 電話、UniFi 的 AP 這些不懂 CDP 的設備。' },
      { t: '不送 CDP / LLDP 的電腦', d: '電腦通常不送這些通告。找它接在哪個埠：先查它的 MAC（ip addr 的 link/ether 那一行），再到交換器 show mac address-table address <MAC>，看是從哪個埠學到的。' },
      { t: 'description', d: 'interface Gi0/x → description <對面的名稱與埠>。show interfaces status、show interfaces description 都會列出來，是交接時最基本的文件。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'r1', { name: 'R1', pos: [-9, -6] }),
        D('c2960p', 'sw', { name: 'SW-1F', pos: [0, -4] }),
        D('c2960', 'sw2', { name: 'SW-2F', pos: [9, -6] }),
        D('c9120', 'ap1', { name: 'AP-2F-01', pos: [9, 1] }),
        D('ap', 'ap2', { name: 'AP-WH-01', pos: [-10, 1.5] }),
        D('ipphone', 'ph1', { name: '業務電話', pos: [5.5, 4.5] }),
        D('t54w', 'ph2', { name: '會議室電話', pos: [-6, 5] }),
        D('pc', 'fin', { name: '財務 PC', pos: [0, 8.5], ip: '192.168.10.31', gw: '192.168.10.1' }),
      ], Object.entries(MAP).map(([p, id]) => [`${id}:${{ r1: 'Gi0/0/1', sw2: 'Gi0/9', ap1: 'Gi0', ap2: 'eth0', ph1: 'sw', ph2: 'sw', fin: 'eth0' }[id]}`, `sw:${p}`]));
      recompute(s);
      typeIn(s, 'r1', ['configure terminal', 'interface Gi0/0/1', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'end', 'write memory']);
      typeIn(s, 'sw', ['configure terminal', 'interface vlan 1', 'ip address 192.168.10.2 255.255.255.0', 'no shutdown', 'end', 'write memory']);
      typeIn(s, 'sw2', ['configure terminal', 'interface vlan 1', 'ip address 192.168.10.3 255.255.255.0', 'no shutdown', 'end', 'write memory']);
      // 這一關看不到接線（場景、2D 拓撲圖、連接埠的說明都不顯示對面是誰）
      s.hideCables = true;
      return fresh(s);
    },
    objectives: Object.entries(MAP).map(([p, id]) => ({
      type: 'check', label: `SW-1F 的 ${p} 寫了 description，而且寫對了`,
      test(s) {
        const pc = dev(s, 'sw').sw.ports[p] || {}, d = dev(s, id), desc = String(pc.desc || '').toLowerCase();
        if (!desc) return `${p} 還沒有 description`;
        if (names(d).some((n) => n && desc.includes(n))) return true;
        const other = Object.values(s.devices).find((x) => x.id !== id && x.id !== 'sw' && names(x).some((n) => n && n.length > 2 && desc.includes(n)));
        return other ? `${p} 寫的是 ${other.name}，可是它不是接在這個埠` : `${p} 的 description「${pc.desc}」看不出接的是哪一台`;
      },
    })),
    hints: [
      'SW-1F 的 CLI：show cdp neighbors。R1、SW-2F、AP-2F-01 和業務電話（Device ID 是 SEP 開頭）都看得到，Local Intrfce 就是 SW-1F 的埠。',
      '看不到 Yealink 電話和 UniFi 的 AP？它們只會 LLDP：configure terminal → lldp run，等一下再 show lldp neighbors。',
      '財務 PC 不送 CDP / LLDP：在它的終端機 ip addr 看 MAC（link/ether 後面），先 ping 一下閘道 192.168.10.1（交換器收到訊框才學得到 MAC），再到 SW-1F show mac address-table。最後每個埠 interface Gi0/x → description <名稱>。',
    ],
    solve(s) {
      const lines = ['configure terminal', 'lldp run'];
      for (const [p, id] of Object.entries(MAP)) lines.push(`interface ${p}`, `description ${dev(s, id).name}`);
      typeIn(s, 'sw', [...lines, 'end', 'write memory']);
    },
    recap: ['CDP / LLDP 告訴你每個埠對面是誰；電腦不送的話，用 MAC 位址表反查。', '把找到的結果寫進 description，就是最基本、也最常被忽略的網路文件。'],
  },
];
