// 第十章補充：新的存取交換器是 Aruba CX — AOS-CX 的 VLAN 寫法、先建 VLAN 才能用、Cisco 要開 LLDP 才看得到它
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { neighbors, lldpRxOn, lldpTxOn } from '../engine/disc.js';
import { dev, WEB } from './util.js';

const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };

export const LEVELS90 = [
  {
    id: 'l170', chapter: 10, title: '新的交換器是 Aruba', subtitle: 'AOS-CX 的 VLAN 與 LLDP', tags: ['Aruba', 'AOS-CX', 'VLAN', 'Trunk', 'LLDP'],
    brief: '二樓的存取交換器換成了 Aruba CX 6100（SW-2F），上游還是 Cisco 的 SW-Core。廠商只建了 VLAN 10、把業務的 PC-A 接好就交差了：研發的 PC-B 還沒設，往 SW-Core 的上行也還是出廠的樣子。另外，網管規定每台交換器都要在 SW-Core 的鄰居表裡看得到，可是 show cdp neighbors 裡沒有 SW-2F。',
    given: [
      ['SW-2F（Aruba CX 6100）', '1/1/1 → PC-A（VLAN 10）、1/1/2 → PC-B（VLAN 20）、1/1/24 → SW-Core Gi0/8'],
      ['SW-Core（Cisco）', 'Gi0/8 是 Trunk（10、20）、Gi0/9 → R1、Gi0/2 → 伺服器（VLAN 30）'], ['伺服器', '10.0.30.10'],
    ],
    learn: [
      { t: 'AOS-CX 的寫法', d: '介面是 成員/插槽/埠（1/1/1）。Access 埠：vlan access 10；Trunk：vlan trunk native 1 加上 vlan trunk allowed 10,20（IOS 是 switchport mode trunk、switchport trunk allowed vlan）。改了立刻生效，write memory 存檔。' },
      { t: 'VLAN 要先建', d: 'AOS-CX 不會自動建 VLAN：vlan access 20 之前，要先在設定模式下 vlan 20（不然會說 VLAN 20 does not exist）。IOS 則會自動幫你建。' },
      { t: 'CDP 與 LLDP', d: 'CDP 是 Cisco 自己的協定，Aruba、Juniper 這些設備只講 LLDP（IEEE 802.1AB）。Catalyst 出廠 LLDP 是關的：全域下 lldp run，show lldp neighbors 才看得到別家的設備。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [-8, -6], init(d) { for (const v of [10, 20, 30]) sub(d, 'Gi0/0/1', v, `10.0.${v}.1`); } }),
        D('c2960', 'core', { name: 'SW-Core', pos: [-2, -3] }),
        D('cx6100', 'cx', { name: 'SW-2F', pos: [5, -3], init(d) { d.cxHost = 'SW-2F'; d.sw.vlans.push({ id: 10, name: 'Sales' }); d.sw.ports['1/1/1'].vlan = 10; } }),
        D('tower', 'srv', { name: '伺服器', pos: [-4, 3.5], ip: '10.0.30.10', gw: '10.0.30.1', services: WEB }),
        D('pc', 'pca', { name: 'PC-A（業務）', pos: [3, 4], ip: '10.0.10.21', gw: '10.0.10.1' }),
        D('pc', 'pcb', { name: 'PC-B（研發）', pos: [8, 4], ip: '10.0.20.22', gw: '10.0.20.1' }),
      ], [['rt:Gi0/0/1', 'core:Gi0/9'], ['core:Gi0/8', 'cx:1/1/24'], ['srv:eth0', 'core:Gi0/2'], ['pca:eth0', 'cx:1/1/1'], ['pcb:eth0', 'cx:1/1/2']]);
      typeIn(s, 'core', ['enable', 'configure terminal', 'vlan 10', 'vlan 20', 'vlan 30', 'exit', 'spanning-tree portfast default',
        'interface Gi0/9', 'switchport mode trunk', 'exit', 'interface Gi0/2', 'switchport access vlan 30', 'exit',
        'interface Gi0/8', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'end']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pca', to: 'srv', port: 443, label: 'PC-A（VLAN 10）連得到伺服器' },
      { type: 'tcp', from: 'pcb', to: 'srv', port: 443, label: 'PC-B（VLAN 20）連得到伺服器' },
      {
        type: 'check', label: 'SW-Core 的鄰居表（LLDP）看得到 SW-2F',
        test(s) {
          // 鄰居表是每 30 秒一次的通告學來的；這裡看的是「通告收得到」：SW-2F 的上行在送、SW-Core 那一頭在收
          const core = dev(s, 'core'), l = s.rt.links['cx:1/1/24'];
          if (neighbors(s, core, 'lldp').some((n) => n.dev === 'cx')) return true;
          if (!l || l.dev !== 'core') return 'SW-2F 的 1/1/24 沒有接到 SW-Core';
          return (lldpTxOn(dev(s, 'cx'), '1/1/24') && lldpRxOn(core, l.port)) || 'SW-Core 還看不到 SW-2F：Aruba 只講 LLDP，Catalyst 要 lldp run';
        },
      },
    ],
    hints: [
      'SW-2F 的 CLI：show interface brief，1/1/24 還是 access、VLAN 1。configure terminal → interface 1/1/24 → vlan trunk native 1 → vlan trunk allowed 10,20（VLAN 20 要先建：vlan 20 → name RD → exit）。',
      'PC-B：interface 1/1/2 → vlan access 20。',
      'SW-Core：configure terminal → lldp run。等一下再 show lldp neighbors，就看得到 SW-2F（show cdp neighbors 永遠看不到別家的設備）。',
    ],
    solve(s) {
      const d = dev(s, 'cx');
      d.sw.vlans.push({ id: 20, name: 'RD' });
      Object.assign(d.sw.ports['1/1/2'], { vlan: 20 });
      Object.assign(d.sw.ports['1/1/24'], { mode: 'trunk', native: 1, allowed: '10,20', cxAllowed: true });
      typeIn(s, 'core', ['enable', 'configure terminal', 'lldp run', 'end']);
    },
    recap: ['AOS-CX：vlan access、vlan trunk native、vlan trunk allowed，VLAN 要先建。', '別家的設備只講 LLDP：Catalyst 要 lldp run 才看得到它們。'],
  },
];
