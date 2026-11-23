// 第十七章補充：ESXi 的第二張上行接到另一台交換器（NIC teaming）— 每台 VM 固定走一張上行，兩邊交換器的 VLAN 要一模一樣
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { isTrunk, vlanAllowed } from '../engine/sim.js';
import { dev, swp, WEB, DB } from './util.js';

const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
const attach = (s, host, n, vm, pg) => { s.cables.push({ id: 'c' + s.seq++, a: { dev: vm, port: 'eth0' }, b: { dev: host, port: 'vp' + n }, media: 'virt', kind: 'virtual' }); s.devices[host].sw.ports['vp' + n].pg = pg; };
const APP = [{ proto: 'tcp', port: 8080, name: '應用程式 (HTTP 8080)' }];
const NEED = [10, 20, 99];

export const LEVELS71 = [
  {
    id: 'l151', chapter: 17, title: '同一個 VLAN，一台通一台不通', subtitle: 'ESXi 的 NIC teaming：兩張上行接兩台交換器', tags: ['虛擬化', 'NIC teaming', 'vSwitch', '802.1Q', '備援'],
    brief: '為了不讓一台交換器壞掉就讓整台 ESXi 斷線，機房同事昨晚替 ESXi-01 接上第二張網卡 vmnic1，拉到新的交換器 SW-B，順手把 SW-B 也設好了。今天早上：app-vm 從使用者那邊打不開，網站也連不到它；可是跟它在同一個 VLAN 的 db-vm 好好的。請找出原因並修好，而且要確定任何一張上行斷掉時，所有虛擬機器和 ESXi 的管理介面都照樣連得到。',
    given: [
      ['VLAN 10 Web', '10.0.10.0/24 · web-vm 10.0.10.10'], ['VLAN 20 App/DB', '10.0.20.0/24 · db-vm 10.0.20.10、app-vm 10.0.20.20'],
      ['VLAN 99 管理', '10.0.99.0/24 · ESXi 的 vmk0 10.0.99.11'], ['VLAN 30 使用者', '10.0.30.0/24'],
      ['ESXi 的上行', 'vmnic0 → SW-A 的 Gi0/11、vmnic1 → SW-B 的 Gi0/11'], ['交換器之間', 'SW-A Gi0/12 ↔ SW-B Gi0/12（Trunk）'],
      ['負載平衡', 'Route based on originating virtual port（ESXi 的預設）'],
    ],
    learn: [
      { t: 'NIC teaming', d: '一個 vSwitch 可以有好幾張上行 (vmnic)。最常見的做法是兩張接到兩台不同的交換器：一台交換器、一條線或一張網卡壞掉，虛擬機器都還連得到。' },
      { t: '依虛擬埠分配 (originating virtual port)', d: 'ESXi 預設的負載平衡：每個虛擬埠固定走一張上行，依虛擬埠的編號輪流分配。所以同一台主機、同一個 VLAN 的兩台 VM，可能一台走 vmnic0、一台走 vmnic1。那張上行斷線，它的 VM 才換到另一張。' },
      { t: '兩邊交換器要一模一樣', d: '哪台 VM 走哪張上行不是你決定的，而且隨時會換（斷線、重開機、vMotion）。所以每一張上行接到的交換器埠，VLAN、Trunk 放行清單、Native VLAN 都要一樣，兩台交換器也都要建好這些 VLAN。只要有一邊少了一個 VLAN，就會出現「同一個 VLAN 有的通、有的不通」。' },
      { t: '不用 LACP，也不跑 STP', d: '這種 teaming 不需要交換器做任何設定（不用 EtherChannel / LACP）：vSwitch 不會把一張上行收到的訊框從另一張送出去，所以不會有迴圈，也不送 BPDU。從上行收到的廣播只交給固定走那張上行的 VM，不會收到兩份。接 ESXi 的埠習慣加上 spanning-tree portfast trunk。' },
      { t: 'Active / Standby', d: '上行也可以設成備用 (standby)：平常不用，作用中的都斷了才接手。斷線偵測預設只看 link status；交換器另一端的上行斷了但這條線還亮著，就要用 beacon probing 或 Link State Tracking。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [-8, -5.5], init(d) { for (const v of [10, 20, 30, 99]) sub(d, 'Gi0/0/1', v, `10.0.${v}.1`); } }),
        D('c2960', 'swa', {
          name: 'SW-A', pos: [-3, -1.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'Web' }, { id: 20, name: 'App-DB' }, { id: 30, name: 'Users' }, { id: 99, name: 'Mgmt' });
            d.sw.ports['Gi0/9'].mode = 'trunk';
            Object.assign(d.sw.ports['Gi0/11'], { mode: 'trunk', allowed: '10,20,99', portfast: true, desc: 'ESXi-01 vmnic0' });
            Object.assign(d.sw.ports['Gi0/12'], { mode: 'trunk', desc: 'SW-B' });
            d.sw.ports['Gi0/1'].vlan = 30; d.sw.ports['Gi0/2'].vlan = 99;
            Object.assign(d.sw.stp, { portfastDefault: true, prio: 4096 });
          },
        }),
        D('c2960', 'swb', {
          name: 'SW-B', pos: [3, -5.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'Web' }, { id: 30, name: 'Users' }, { id: 99, name: 'Mgmt' }); // 昨晚照著舊的表建的：少了 VLAN 20
            Object.assign(d.sw.ports['Gi0/11'], { mode: 'trunk', allowed: '10,20', portfast: true, desc: 'ESXi-01 vmnic1' }); // 少了管理的 99
            Object.assign(d.sw.ports['Gi0/12'], { mode: 'trunk', desc: 'SW-A' });
            d.sw.stp.portfastDefault = true;
          },
        }),
        D('esxi', 'esx', {
          name: 'ESXi-01', pos: [8, -1.5],
          init(d) {
            d.vsw.pgs = [{ name: 'Web', vlan: 10 }, { name: 'App-DB', vlan: 20 }, { name: 'Management Network', vlan: 99 }];
            d.vsw.vmkPg = 'Management Network';
            Object.assign(d.ifaces[0], { ip: '10.0.99.11', mask: '255.255.255.0', gateway: '10.0.99.1' });
          },
        }),
        D('vm', 'web', { name: 'web-vm', pos: [5, 4], ip: '10.0.10.10', gw: '10.0.10.1', services: WEB }),
        D('vm', 'db', { name: 'db-vm', pos: [8, 4.6], ip: '10.0.20.10', gw: '10.0.20.1', services: DB }),
        D('vm', 'app', { name: 'app-vm', pos: [11, 4], ip: '10.0.20.20', gw: '10.0.20.1', services: APP }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-8.5, 3.5], ip: '10.0.30.50', gw: '10.0.30.1' }),
        D('laptop', 'adm', { name: '管理員筆電', pos: [-3.5, 4.5], ip: '10.0.99.50', gw: '10.0.99.1' }),
      ], [['rt:Gi0/0/1', 'swa:Gi0/9'], ['swa:Gi0/12', 'swb:Gi0/12'], ['esx:vmnic0', 'swa:Gi0/11'], ['esx:vmnic1', 'swb:Gi0/11'], ['pc:eth0', 'swa:Gi0/1'], ['adm:eth0', 'swa:Gi0/2']]);
      attach(s, 'esx', 1, 'web', 'Web');
      attach(s, 'esx', 2, 'db', 'App-DB');
      attach(s, 'esx', 3, 'app', 'App-DB');
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'app', port: 8080, label: '使用者打得開 app-vm 的應用程式（10.0.20.20:8080）' },
      { type: 'tcp', from: 'web', to: 'app', port: 8080, label: 'web-vm 連得到 app-vm' },
      { type: 'failover', cut: [['esx', 'vmnic0']], label: 'vmnic0 斷線：管理員照樣登得進 ESXi（vmk0 改走 vmnic1）', test: { type: 'tcp', from: 'adm', ip: '10.0.99.11', port: 443 } },
      { type: 'failover', cut: [['esx', 'vmnic0']], label: 'vmnic0 斷線：網站照樣連得到資料庫（db-vm 改走 vmnic1）', test: { type: 'tcp', from: 'web', to: 'db', port: 3306 } },
      { type: 'failover', cut: [['esx', 'vmnic1']], label: 'vmnic1 斷線：使用者照樣打得開網站與 app-vm（改走 vmnic0）', test: { type: 'tcp', from: 'pc', to: 'app', port: 8080 } },
      {
        type: 'check', label: 'SW-A 與 SW-B 接 ESXi 的埠設定一樣：Trunk，只放行 10、20、99',
        test(s) {
          for (const id of ['swa', 'swb']) {
            const d = dev(s, id), pc = swp(s, id, 'Gi0/11');
            if (!isTrunk(d, 'Gi0/11')) return `${d.name} 的 Gi0/11 不是 Trunk`;
            const miss = NEED.filter((v) => !vlanAllowed(pc, v) || !d.sw.vlans.some((x) => x.id === v));
            if (miss.length) return `${d.name} 的 Gi0/11 還沒有帶 VLAN ${miss.join('、')}（Trunk 沒放行，或交換器上根本沒有這個 VLAN）`;
            const extra = [1, 30].filter((v) => vlanAllowed(pc, v) && v !== +(pc.native || 1));
            if (String(pc.allowed || 'all') === 'all' || extra.length) return `${d.name} 的 Gi0/11 放行了不需要的 VLAN：只放 10、20、99（switchport trunk allowed vlan 10,20,99）`;
          }
          return true;
        },
      },
    ],
    hints: [
      'ESXi-01 →「虛擬交換器」分頁的「上行（NIC teaming）」：db-vm 走 vmnic0、app-vm 走 vmnic1。同一個 VLAN、一台通一台不通，問題就在 vmnic1 接的 SW-B。（也可以把 vmnic1 勾成備用試試：app-vm 改走 vmnic0 就通了）',
      'SW-B：show vlan brief 裡沒有 VLAN 20，show interfaces trunk 的「allowed and active」也就沒有 20。configure terminal → vlan 20 → name App-DB。',
      'SW-B 的 Gi0/11 只放行 10,20：vmk0 現在走 vmnic0 所以沒事，vmnic0 一斷管理介面就連不到了。interface Gi0/11 → switchport trunk allowed vlan add 99。兩台交換器接 ESXi 的埠要一模一樣。',
    ],
    solve(s) {
      dev(s, 'swb').sw.vlans.push({ id: 20, name: 'App-DB' });
      swp(s, 'swb', 'Gi0/11').allowed = '10,20,99';
    },
    recap: ['NIC teaming 預設依虛擬埠分配上行：同一個 VLAN 的 VM 可能走不同的上行。', '每一張上行接到的交換器埠，VLAN 與 Trunk 設定都要一模一樣；不然只有走某一張的 VM 會不通，或要等斷線時才發現。'],
  },
];
