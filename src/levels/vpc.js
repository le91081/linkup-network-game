// 第四章補充：兩台 Nexus 的 vPC — 下面的交換器雙歸、LACP 兩條都綁起來、vPC 編號要對、peer-keepalive 要通
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
/** 兩台 Nexus 共同的設定（vPC 編號與 keepalive 的目的位址由參數決定） */
const leafCfg = (me, peer, acc1Vpc, kaDst) => ['enable', 'configure terminal', 'feature lacp', 'feature vpc', 'vlan 10', 'name Prod', 'exit',
  'interface Eth1/48', 'no switchport', `ip address 10.255.255.${me} 255.255.255.252`, 'no shutdown', 'exit',
  `vpc domain 10`, `peer-keepalive destination ${kaDst} source 10.255.255.${me} vrf default`, 'exit',
  'interface range Eth1/49 - 50', 'switchport mode trunk', 'channel-group 1 mode active', 'exit', 'interface port-channel 1', 'vpc peer-link', 'exit',
  'interface Eth1/1', 'switchport mode trunk', 'channel-group 20 mode active', 'exit', 'interface port-channel 20', `vpc ${acc1Vpc}`, 'exit',
  'interface Eth1/2', 'switchport mode trunk', 'channel-group 30 mode active', 'exit', 'interface port-channel 30', 'vpc 30', 'end'];
const accCfg = ['enable', 'configure terminal', 'vlan 10', 'name Prod', 'exit', 'interface range Gi0/11 - 12', 'switchport mode trunk', 'channel-group 1 mode active', 'exit', 'interface Gi0/1', 'switchport access vlan 10', 'end'];

export const LEVELS75 = [
  {
    id: 'l155', chapter: 4, title: '兩台 Nexus，一條線在睡覺', subtitle: 'vPC：跨兩台交換器的 Port-channel', tags: ['vPC', 'Nexus', 'LACP', 'peer-link', 'peer-keepalive'],
    brief: '機房的兩台 Leaf（Nexus 93180）做了 vPC，下面的使用者交換器 ACC-1 與伺服器交換器 ACC-2 各拉兩條線，一條到 Leaf-1、一條到 Leaf-2，綁成一個 Port-channel。網路是通的，可是 ACC-1 的兩條上行只有一條在用，另一條是 suspended。網路主管還要你做一次演練：Leaf 之間的 peer-link 斷掉時，使用者也不能斷線。請修好 vPC。',
    given: [
      ['Leaf-1 / Leaf-2', 'vpc domain 10 · peer-link：Po1（Eth1/49 – 50）'], ['peer-keepalive', 'Eth1/48 直接對接：Leaf-1 10.255.255.1/30、Leaf-2 10.255.255.2/30（vrf default）'],
      ['ACC-1（使用者）', 'Gi0/11 → Leaf-1 Eth1/1、Gi0/12 → Leaf-2 Eth1/1 · 兩台 Leaf 上是 Po20 / vPC 20'],
      ['ACC-2（伺服器）', 'Gi0/11 → Leaf-1 Eth1/2、Gi0/12 → Leaf-2 Eth1/2 · Po30 / vPC 30'],
      ['VLAN 10', 'PC 10.0.10.50 · 伺服器 10.0.10.100'],
    ],
    learn: [
      { t: 'vPC 是什麼', d: '兩台 Nexus 各自有自己的設定和控制平面，但對下面的交換器來說，它們報出同一個 LACP 的身分，所以下面那台可以把接到兩台的線綁成同一個 Port-channel：兩條都在用、不用 STP 擋，一台 Leaf 壞了另一條照樣通。和堆疊不一樣：兩台不是同一台交換器。' },
      { t: 'peer-link 與 vPC 編號', d: 'peer-link 是兩台之間的 Port-channel（vpc peer-link），同步 MAC 表、轉送只接在其中一台的流量。下面每一個雙歸的 Port-channel，兩台 Leaf 上都要設同一個 vPC 編號（interface port-channel 20 → vpc 20），成員埠的模式和 VLAN 也要一致（consistency check）。對不上，secondary 那一邊就被暫停。' },
      { t: 'peer-keepalive', d: '另一條獨立的線（通常是管理網路或一條直接對接的線）送心跳。peer-link 斷了、keepalive 還收得到：對方還活著，secondary 把自己全部的 vPC 埠暫停，所有流量走 primary，避免兩邊各做各的 (split brain)。keepalive 也不通的話，兩台都以為對方死了，各自繼續轉送 (dual-active)。' },
      { t: 'primary 與 secondary', d: 'role priority 小的當 primary（預設 32667），一樣就看系統 MAC。只接在一台上的設備 (orphan port) 最好接在 primary 上：peer-link 斷線時 secondary 會被隔離。' },
      { t: '常用的指令', d: 'show vpc（peer 狀態、keepalive、每個 vPC 的狀態與一致性）、show vpc peer-keepalive、show port-channel summary（NX-OS 的 Po 狀態）、show vpc consistency-parameters。' },
    ],
    setup() {
      const s = makeState([
        D('n93180', 'n1', { name: 'Leaf-1', pos: [-4.5, -5.5] }),
        D('n93180', 'n2', { name: 'Leaf-2', pos: [4.5, -5.5] }),
        D('c2960', 'acc1', { name: 'ACC-1（使用者）', pos: [-6, 0.5] }),
        D('c2960', 'acc2', { name: 'ACC-2（伺服器）', pos: [6, 0.5] }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-7.5, 5], ip: '10.0.10.50' }),
        D('tower', 'srv', { name: '伺服器', pos: [7.5, 5], ip: '10.0.10.100', services: WEB }),
      ], [['n1:Eth1/49', 'n2:Eth1/49'], ['n1:Eth1/50', 'n2:Eth1/50'], ['n1:Eth1/48', 'n2:Eth1/48'],
        ['acc1:Gi0/11', 'n1:Eth1/1'], ['acc1:Gi0/12', 'n2:Eth1/1'], ['acc2:Gi0/11', 'n1:Eth1/2'], ['acc2:Gi0/12', 'n2:Eth1/2'],
        ['pc:eth0', 'acc1:Gi0/1'], ['srv:eth0', 'acc2:Gi0/1']]);
      typeIn(s, 'n1', leafCfg(1, 2, 20, '10.255.255.2'));
      typeIn(s, 'n2', leafCfg(2, 1, 21, '10.255.255.5')); // 打錯：vpc 21、keepalive 的目的位址
      for (const id of ['acc1', 'acc2']) typeIn(s, id, accCfg);
      for (const id of ['n1', 'n2', 'acc1', 'acc2']) s.devices[id].sw.stp.portfastDefault = true;
      s.devices.n1.sw.stp.prio = 4096; s.devices.n2.sw.stp.prio = 8192;
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'srv', port: 443, label: '使用者 PC 連得到伺服器' },
      {
        type: 'check', label: 'ACC-1、ACC-2 的兩條上行都綁進 Port-channel（都是 P）',
        test(s) {
          for (const id of ['acc1', 'acc2']) {
            const d = dev(s, id), bad = ['Gi0/11', 'Gi0/12'].filter((p) => !d.rt.lag[p] || d.rt.lag[p].state !== 'bundled');
            if (bad.length) return `${d.name} 的 ${bad.join('、')} 沒有綁進 Port-channel（${(d.rt.lag[bad[0]] || {}).why || '沒有連線'}）`;
          }
          return true;
        },
      },
      { type: 'failover', down: ['n1'], label: 'Leaf-1 故障：使用者照樣連得到伺服器', test: { type: 'tcp', from: 'pc', to: 'srv', port: 443 } },
      { type: 'failover', cut: [['n1', 'Eth1/49'], ['n1', 'Eth1/50']], label: 'peer-link 斷了：secondary 暫停 vPC，使用者照樣連得到伺服器', test: { type: 'tcp', from: 'pc', to: 'srv', port: 443 } },
      {
        type: 'check', label: '兩台的 peer-keepalive 都收得到對方（peer is alive）',
        test(s) {
          for (const id of ['n1', 'n2']) { const r = dev(s, id).rt.vpc; if (!r || !r.keepalive) return `${dev(s, id).name} 的 peer-keepalive 不通：${(r && r.kaWhy) || 'vPC 沒有起來'}`; }
          return true;
        },
      },
    ],
    hints: [
      'ACC-1：show etherchannel summary，其中一條是 (s) suspended。到 Leaf-2：show vpc，vPC 21 和 Leaf-1 對不上（Leaf-1 是 vPC 20）。',
      'Leaf-2：interface port-channel 20 → vpc 20（兩台 Leaf 上同一個雙歸的 Port-channel，vPC 編號要一樣）。',
      'Leaf-2：show vpc peer-keepalive，目的位址打成 10.255.255.5 了。vpc domain 10 → peer-keepalive destination 10.255.255.1 source 10.255.255.2 vrf default。',
      '演練 peer-link 斷線：keepalive 通的話，secondary 會暫停自己的 vPC，流量全部走 primary；keepalive 不通的話兩台都以為對方死了 (dual-active)。',
    ],
    solve(s) {
      typeIn(s, 'n2', ['enable', 'configure terminal', 'interface port-channel 20', 'vpc 20', 'exit', 'vpc domain 10', 'peer-keepalive destination 10.255.255.1 source 10.255.255.2 vrf default', 'end']);
    },
    recap: ['vPC 讓下面的設備把接到兩台 Nexus 的線綁成一個 Port-channel：兩台上同一個 Po 的 vPC 編號、模式與 VLAN 要一致。', 'peer-keepalive 分辨「peer-link 斷了」和「對方死了」：通的話 secondary 暫停 vPC，避免 split brain。'],
  },
];
