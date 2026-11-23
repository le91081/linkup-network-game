// 第十七章補充：IP hash 的 NIC teaming — 實體交換器要用靜態的 EtherChannel（mode on），標準 vSwitch 不會 LACP
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { dev, WEB, DB } from './util.js';

const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
const attach = (s, host, n, vm, pg) => { s.cables.push({ id: 'c' + s.seq++, a: { dev: vm, port: 'eth0' }, b: { dev: host, port: 'vp' + n }, media: 'virt', kind: 'virtual' }); s.devices[host].sw.ports['vp' + n].pg = pg; };
const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };

export const LEVELS80 = [
  {
    id: 'l160', chapter: 17, title: '想要兩倍頻寬，結果整台斷線', subtitle: 'IP hash 的 NIC teaming 與靜態 EtherChannel', tags: ['虛擬化', 'NIC teaming', 'IP hash', 'EtherChannel', 'LACP'],
    brief: '備份的時候 ESXi-01 的上行常常塞滿，同事聽說「把負載平衡改成 IP hash，兩張網卡就能一起用」，就在 vSwitch 上改了，順便把交換器上接 ESXi 的兩個埠綁成 EtherChannel（他用的是平常的 LACP）。改完之後，ESXi-01 上的虛擬機器全部斷線。請修好，而且兩張上行都要繼續一起用（IP hash）。',
    given: [
      ['ESXi-01', 'vmnic0 → SW-Core Gi0/11、vmnic1 → SW-Core Gi0/12 · 負載平衡：Route based on IP hash'],
      ['SW-Core', 'Gi0/11 – 12：Trunk，channel-group 1 mode active (LACP)'],
      ['VLAN 10 Web', 'web-vm 10.0.10.10'], ['VLAN 20 DB', 'db-vm 10.0.20.10'], ['VLAN 30 使用者', '10.0.30.0/24'],
    ],
    learn: [
      { t: 'IP hash', d: 'Route based on IP hash：vSwitch 把兩張上行當成一條 EtherChannel，每一條連線依來源與目的 IP 算出要走哪一張。同一台 VM 的不同連線可以分散到兩張網卡，才真的用得到兩倍的頻寬（預設的「依虛擬埠」一台 VM 只走一張）。' },
      { t: '交換器要設靜態的 EtherChannel', d: '標準 vSwitch 不會 LACP：交換器那一端一定要 channel-group … mode on（靜態）。設成 mode active（LACP）的話，交換器一直等不到 LACP 的封包，兩個埠都被暫停 (suspended)，整台主機就斷線了。要用 LACP 得改用 Distributed Switch 的 LAG。' },
      { t: '兩張上行要接同一台', d: 'EtherChannel 的成員要接到同一台交換器（或堆疊、vPC 這種對外是一台的）。兩張上行分別接兩台獨立的交換器，就不能用 IP hash，要用預設的「依虛擬埠」。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [-7, -6], init(d) { for (const v of [10, 20, 30]) sub(d, 'Gi0/0/1', v, `10.0.${v}.1`); } }),
        D('c2960', 'sw', { name: 'SW-Core', pos: [0, -2] }),
        D('esxi', 'esx', {
          name: 'ESXi-01', pos: [7.5, -3],
          init(d) { d.vsw.pgs = [{ name: 'Web', vlan: 10 }, { name: 'DB', vlan: 20 }, { name: 'Management Network', vlan: 0 }]; d.vsw.teaming = 'iphash'; },
        }),
        D('vm', 'web', { name: 'web-vm', pos: [5, 3], ip: '10.0.10.10', gw: '10.0.10.1', services: WEB }),
        D('vm', 'db', { name: 'db-vm', pos: [10, 3], ip: '10.0.20.10', gw: '10.0.20.1', services: DB }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-6, 4], ip: '10.0.30.50', gw: '10.0.30.1' }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['esx:vmnic0', 'sw:Gi0/11'], ['esx:vmnic1', 'sw:Gi0/12'], ['pc:eth0', 'sw:Gi0/1']]);
      attach(s, 'esx', 1, 'web', 'Web');
      attach(s, 'esx', 2, 'db', 'DB');
      typeIn(s, 'sw', ['enable', 'configure terminal', 'vlan 10', 'vlan 20', 'vlan 30', 'exit', 'spanning-tree portfast default',
        'interface Gi0/9', 'switchport mode trunk', 'exit', 'interface Gi0/1', 'switchport access vlan 30', 'exit',
        'interface range Gi0/11 - 12', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'channel-group 1 mode active', 'end']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'web', port: 443, label: '使用者打得開網站（web-vm）' },
      { type: 'tcp', from: 'web', to: 'db', port: 3306, label: '網站連得到資料庫（db-vm）' },
      {
        type: 'check', label: 'ESXi-01 用 IP hash，兩張上行綁成一條 EtherChannel，兩條都在用',
        test(s) {
          const e = dev(s, 'esx'), sw = dev(s, 'sw');
          if (e.vsw.teaming !== 'iphash') return 'ESXi-01 的負載平衡不是 IP hash：同一台 VM 只會用到一張網卡';
          const bad = ['Gi0/11', 'Gi0/12'].find((p) => !sw.rt.lag[p] || sw.rt.lag[p].state !== 'bundled');
          return !bad || `SW-Core 的 ${bad} 沒有綁進 Port-channel（${(sw.rt.lag[bad] || {}).why || '沒有加入 Port-channel'}）`;
        },
      },
    ],
    hints: [
      'SW-Core：show etherchannel summary，Gi0/11 和 Gi0/12 都是 (s) suspended。原因：一端是靜態 (on)、另一端是 LACP — ESXi 的標準 vSwitch 不會送 LACP。',
      'SW-Core：interface range Gi0/11 - 12 → channel-group 1 mode on（先 no channel-group 也可以）。',
      '改回「依虛擬埠」、拿掉 EtherChannel 也會通，但一台 VM 只用得到一張網卡：這一關要保留 IP hash。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['enable', 'configure terminal', 'interface range Gi0/11 - 12', 'channel-group 1 mode on', 'end']);
    },
    recap: ['IP hash 把兩張上行當成一條 EtherChannel：交換器那一端要設靜態的 mode on，兩張上行接同一台。', '標準 vSwitch 不會 LACP；要 LACP 用 Distributed Switch 的 LAG。'],
  },
];
