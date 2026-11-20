// 第十七章：虛擬化。一台實體伺服器跑好幾台虛擬機器：vSwitch、連接埠群組與 VLAN 標籤、接實體交換器的 Trunk
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { isTrunk } from '../engine/sim.js';
import { pgOf, pgVlan } from '../engine/virt.js';
import { dev, swp, WEB, DB } from './util.js';

export const CHAPTERS11 = [
  { id: 17, title: '虛擬化', desc: '一台實體伺服器跑很多台虛擬機器：Hypervisor、虛擬交換器 (vSwitch)、連接埠群組與 VLAN 標籤，以及接實體交換器的 Trunk。' },
];

const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
/** 虛擬機器接在主機的第 n 個虛擬埠上，並放進某個連接埠群組 */
const attach = (s, host, n, vm, pg) => { s.cables.push({ id: 'c' + s.seq++, a: { dev: vm, port: 'eth0' }, b: { dev: host, port: 'vp' + n }, media: 'virt', kind: 'virtual' }); s.devices[host].sw.ports['vp' + n].pg = pg; };

export const LEVELS16 = [
  {
    id: 'l70', chapter: 17, title: '一台主機，三個網段', subtitle: 'vSwitch、連接埠群組與 VLAN 標籤', tags: ['虛擬化', 'Hypervisor', 'vSwitch', '802.1Q'],
    brief: '機房只剩一個機櫃位置，公司買了一台高階伺服器裝 VMware ESXi，把網站、資料庫兩台舊伺服器變成虛擬機器搬進去。虛擬化的同事裝好之後就休假了：網站從使用者那邊打不開，網站連不到資料庫，管理員也連不進 ESXi 的管理介面。請把虛擬交換器和實體交換器之間的設定對好。',
    given: [
      ['VLAN 10 Web', '10.0.10.0/24 · web-vm 10.0.10.10'], ['VLAN 20 DB', '10.0.20.0/24 · db-vm 10.0.20.10'],
      ['VLAN 99 管理', '10.0.99.0/24 · ESXi 的 vmk0 10.0.99.11'], ['VLAN 30 使用者', '10.0.30.0/24'],
      ['ESXi 的上行', 'vmnic0 → SW-Core 的 Gi0/11'], ['閘道', 'R1 的子介面，每個 VLAN 的 .1'],
    ],
    learn: [
      { t: 'Hypervisor', d: 'Type 1（ESXi、Hyper-V Server、KVM）直接裝在伺服器上，Type 2（VirtualBox、VMware Workstation）裝在一般的作業系統上。每台虛擬機器有自己的 CPU、記憶體、磁碟和網卡，彼此隔離，可以在主機之間搬移。' },
      { t: '虛擬交換器 (vSwitch)', d: '主機裡面有一台軟體交換器：虛擬機器的網卡接在它的虛擬埠上，實體網卡 (vmnic) 是它的上行。同一台主機上的兩台虛擬機器如果在同一個 VLAN，封包根本不會離開主機。' },
      { t: '連接埠群組與 VLAN 標籤', d: '連接埠群組 (port group) 決定虛擬機器在哪個 VLAN。VLAN ID 填 10，從 vmnic0 出去的封包就帶著 802.1Q 標籤 10（VST）；填 0 就不加標籤，落在實體交換器那個埠的 native VLAN。' },
      { t: '實體交換器那一端', d: '有好幾個 VLAN 的虛擬機器時，接主機的那個埠一定要是 Trunk，而且允許這些 VLAN。Catalyst 預設是 dynamic auto，ESXi 不送 DTP，所以會一直停在 Access。vSwitch 也不送 BPDU。' },
      { t: '容器與 VRF', d: '容器 (Docker) 共用主機的作業系統核心，比虛擬機器輕，常用橋接網路加上連接埠發佈 (-p 8443:443) 對外。VRF 則是路由器上的「虛擬化」：一台路由器切成好幾份獨立的路由表。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', {
          name: 'R1', pos: [-7, -6],
          init(d) { for (const [v, ip] of [[10, '10.0.10.1'], [20, '10.0.20.1'], [30, '10.0.30.1'], [99, '10.0.99.1']]) sub(d, 'Gi0/0/1', v, ip); },
        }),
        D('c2960', 'sw', {
          name: 'SW-Core', pos: [0, -2],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'Web' }, { id: 20, name: 'DB' }, { id: 30, name: 'Users' }, { id: 99, name: 'Mgmt' });
            d.sw.ports['Gi0/9'].mode = 'trunk';
            d.sw.ports['Gi0/1'].vlan = 30; d.sw.ports['Gi0/2'].vlan = 99;
            d.sw.stp.portfastDefault = true;
          },
        }),
        D('esxi', 'esx', {
          name: 'ESXi-01', pos: [7.5, -3],
          init(d) {
            d.vsw.pgs = [{ name: 'Web', vlan: 10 }, { name: 'DB', vlan: 0 }, { name: 'Management Network', vlan: 0 }];
            d.vsw.vmkPg = 'Management Network';
            Object.assign(d.ifaces[0], { ip: '10.0.99.11', mask: '255.255.255.0', gateway: '10.0.99.1' });
          },
        }),
        D('vm', 'web', { name: 'web-vm', pos: [4.6, 2.8], ip: '10.0.10.10', gw: '10.0.10.1', services: WEB }),
        D('vm', 'db', { name: 'db-vm', pos: [10.4, 2.8], ip: '10.0.20.10', gw: '10.0.20.1', services: DB }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-6, 4], ip: '10.0.30.50', gw: '10.0.30.1' }),
        D('laptop', 'adm', { name: '管理員筆電', pos: [-1.5, 4.6], ip: '10.0.99.50', gw: '10.0.99.1' }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['esx:vmnic0', 'sw:Gi0/11'], ['pc:eth0', 'sw:Gi0/1'], ['adm:eth0', 'sw:Gi0/2']]);
      attach(s, 'esx', 1, 'web', 'Web');
      attach(s, 'esx', 2, 'db', 'DB');
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'web', port: 443, label: '使用者可以開啟網站（web-vm，HTTPS）' },
      { type: 'tcp', from: 'web', to: 'db', port: 3306, label: '網站連得到資料庫（db-vm，MySQL 3306）' },
      { type: 'tcp', from: 'adm', ip: '10.0.99.11', port: 443, label: '管理員可以登入 ESXi 的管理介面 (https://10.0.99.11)' },
      {
        type: 'check', label: 'SW-Core 接 ESXi 的埠是 Trunk，只放行需要的 VLAN（10、20、99）',
        test(s) {
          const sw = dev(s, 'sw'), pc = swp(s, 'sw', 'Gi0/11');
          if (!isTrunk(sw, 'Gi0/11')) return 'SW-Core 的 Gi0/11 還不是 Trunk：帶著 VLAN 標籤的封包到了 Access 埠就被丟掉';
          const allowed = String(pc.allowed || 'all');
          if (allowed === 'all') return 'Gi0/11 的 Trunk 放行了所有 VLAN：最小權限的做法是只放 10、20、99（switchport trunk allowed vlan 10,20,99）';
          const vs = new Set(allowed.split(',').flatMap((x) => { const [a, b] = x.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, k) => a + k) : [a]; }));
          const miss = [10, 20, 99].filter((v) => !vs.has(v)), extra = [...vs].filter((v) => ![10, 20, 99].includes(v));
          if (miss.length) return `Gi0/11 的 Trunk 沒有放行 VLAN ${miss.join('、')}`;
          return !extra.length || `Gi0/11 的 Trunk 多放行了 VLAN ${extra.join('、')}`;
        },
      },
      {
        type: 'check', label: '每個連接埠群組都在正確的 VLAN（DB 20、管理 99）',
        test(s) {
          const d = dev(s, 'esx');
          if (pgVlan(pgOf(d, 'DB')) !== 20) return '連接埠群組「DB」的 VLAN ID 不是 20';
          if (pgVlan(pgOf(d, d.vsw.vmkPg)) !== 99) return `vmk0 所在的連接埠群組「${d.vsw.vmkPg}」的 VLAN ID 不是 99`;
          return true;
        },
      },
    ],
    hints: [
      '先看實體交換器：SW-Core 的 show interfaces trunk 裡沒有 Gi0/11，它還是 Access 埠（dynamic auto，ESXi 不送 DTP）。interface Gi0/11 → switchport mode trunk → switchport trunk allowed vlan 10,20,99。',
      'ESXi-01 →「虛擬交換器」分頁：連接埠群組「DB」的 VLAN ID 還是 0（不加標籤），改成 20。',
      '「Management Network」也是 0，改成 99：vmk0 才會在管理 VLAN 裡，管理員的筆電才連得到 https://10.0.99.11。',
    ],
    solve(s) {
      Object.assign(swp(s, 'sw', 'Gi0/11'), { mode: 'trunk', allowed: '10,20,99' });
      const d = dev(s, 'esx');
      pgOf(d, 'DB').vlan = 20;
      pgOf(d, 'Management Network').vlan = 99;
    },
    recap: ['虛擬機器的 VLAN 由連接埠群組決定，標籤在 vSwitch 加上去。', '接虛擬化主機的實體交換器埠要設成 Trunk，只放行需要的 VLAN。'],
  },
];
