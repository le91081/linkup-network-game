// 第八章補充：MST（多個 VLAN 對應到 instance、區域設定要完全一樣）
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev, addVlan } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const SW = ['core1', 'core2', 'swa', 'swb'];
const region = (mapping, rev = 1) => ['spanning-tree mode mst', 'spanning-tree mst configuration', 'name CORP', `revision ${rev}`, ...mapping, 'exit'];

export const LEVELS58 = [
  {
    id: 'l138', chapter: 8, title: '兩台核心說好分擔，結果全擠在 Core-1', subtitle: 'MST：instance、區域名稱與 revision', tags: ['STP', 'MST', 'instance', 'revision', '負載分擔'],
    brief: '兩台核心交換器都接到每一台存取交換器。設計是用 MST 分擔：VLAN 10（辦公室）的根橋是 Core-1、VLAN 20（研發）的根橋是 Core-2，兩條上行都有在用。可是網管發現 VLAN 20 的流量也全部走 Core-1，Core-2 的上行完全閒著。請讓兩個 VLAN 照設計各走各的核心。',
    given: [
      ['MST 區域', 'name CORP · revision 1 · instance 1 = VLAN 10、instance 2 = VLAN 20'],
      ['Core-1', 'instance 0 與 1 的優先權 4096、instance 2 是 8192'], ['Core-2', 'instance 2 的優先權 4096、instance 0 與 1 是 8192'],
      ['存取交換器', 'SW-A、SW-B：兩條上行分別接 Core-1、Core-2（Trunk）'],
    ],
    learn: [
      { t: 'MST', d: 'Rapid PVST+ 每個 VLAN 各跑一棵生成樹，VLAN 一多就很耗資源。MST 把很多 VLAN 對應到少數幾個 instance，每個 instance 跑一棵樹：instance 1 的根橋在 Core-1、instance 2 的根橋在 Core-2，兩條上行就各自有人用。' },
      { t: '同一個區域', d: '交換器要「名稱、revision、VLAN 對應」三樣都一模一樣，才算同一個 MST 區域，各 instance 才會照設定選根橋。只要差一個字（revision 打錯、少對應一個 VLAN），對方就被當成另一個區域，邊界上只看得到 CIST（instance 0）。' },
      { t: '怎麼查', d: 'show spanning-tree mst configuration 比對每一台的名稱、revision 與對應表（最後一行還有 digest，可以直接比）。show spanning-tree vlan 20 看根橋是誰。' },
      { t: '改設定的順序', d: 'MST 的區域設定改了就會重新計算整個區域。實務上會先在所有交換器上準備好同樣的設定，再在維護時段一起套用。' },
    ],
    setup() {
      const s = makeState([
        D('c9300', 'core1', { name: 'Core-1', pos: [-5, -4] }),
        D('c9300', 'core2', { name: 'Core-2', pos: [5, -4] }),
        D('c2960', 'swa', { name: 'SW-A', pos: [-5, 1.5] }),
        D('c2960', 'swb', { name: 'SW-B', pos: [5, 1.5] }),
        D('pc', 'pca', { name: '辦公室 PC', pos: [-7, 5.5], ip: '10.10.10.21', mask: '255.255.255.0' }),
        D('pc', 'pcb', { name: '研發 PC-1', pos: [-3, 5.5], ip: '10.10.20.21', mask: '255.255.255.0' }),
        D('pc', 'pcc', { name: '研發 PC-2', pos: [5, 5.5], ip: '10.10.20.22', mask: '255.255.255.0' }),
      ], [['core1:Gi1/0/24', 'core2:Gi1/0/24'], ['swa:Gi0/9', 'core1:Gi1/0/1'], ['swa:Gi0/10', 'core2:Gi1/0/1'], ['swb:Gi0/9', 'core1:Gi1/0/2'], ['swb:Gi0/10', 'core2:Gi1/0/2'],
        ['pca:eth0', 'swa:Gi0/1'], ['pcb:eth0', 'swa:Gi0/2'], ['pcc:eth0', 'swb:Gi0/2']]);
      for (const id of SW) { addVlan(s, id, 10, 'OFFICE'); addVlan(s, id, 20, 'RD'); }
      for (const [id, ports] of [['core1', ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/24']], ['core2', ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/24']], ['swa', ['Gi0/9', 'Gi0/10']], ['swb', ['Gi0/9', 'Gi0/10']]]) for (const p of ports) dev(s, id).sw.ports[p].mode = 'trunk';
      dev(s, 'swa').sw.ports['Gi0/1'].vlan = 10; dev(s, 'swa').sw.ports['Gi0/2'].vlan = 20; dev(s, 'swb').sw.ports['Gi0/2'].vlan = 20;
      recompute(s);
      const both = ['instance 1 vlan 10', 'instance 2 vlan 20'];
      typeIn(s, 'core1', ['enable', 'configure terminal', ...region(both), 'spanning-tree mst 0 priority 4096', 'spanning-tree mst 1 priority 4096', 'spanning-tree mst 2 priority 8192', 'end', 'write memory']);
      typeIn(s, 'core2', ['enable', 'configure terminal', ...region(both, 2), 'spanning-tree mst 0 priority 8192', 'spanning-tree mst 1 priority 8192', 'spanning-tree mst 2 priority 4096', 'end', 'write memory']); // revision 打成 2
      typeIn(s, 'swa', ['enable', 'configure terminal', ...region(both), 'end', 'write memory']);
      typeIn(s, 'swb', ['enable', 'configure terminal', ...region(['instance 1 vlan 10']), 'end', 'write memory']); // 少了 instance 2
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'check', label: 'VLAN 10 的根橋是 Core-1', test(s) { const bad = SW.filter((id) => (dev(s, id).rt.stp.root || {})[10] !== 'core1'); return !bad.length || `${bad.map((id) => dev(s, id).name).join('、')} 認為 VLAN 10 的根橋不是 Core-1`; } },
      { type: 'check', label: 'VLAN 20 的根橋是 Core-2（研發的流量走 Core-2）', test(s) { const bad = SW.filter((id) => (dev(s, id).rt.stp.root || {})[20] !== 'core2'); return !bad.length || `${bad.map((id) => dev(s, id).name).join('、')} 認為 VLAN 20 的根橋是 ${dev(s, (dev(s, bad[0]).rt.stp.root || {})[20] || bad[0]).name}`; } },
      { type: 'check', label: '四台交換器在同一個 MST 區域', test(s) { const bad = SW.filter((id) => dev(s, id).rt.stp.region !== 'same'); return !bad.length || '還有交換器的區域設定不一樣（名稱、revision 或 VLAN 對應）'; } },
      { type: 'ping', from: 'pcb', to: 'pcc', label: '研發的兩台 PC 互相 ping 得到（VLAN 20）' },
    ],
    hints: [
      'SW-B 的 CLI：show spanning-tree vlan 20，根橋的位址是 Core-1 的。show spanning-tree mst 最後一行說不在同一個 MST 區域。',
      '每一台都打 show spanning-tree mst configuration 比對：Core-2 的 Revision 是 2，其他是 1；SW-B 的 instance 2 沒有對應 VLAN 20。',
      'Core-2：spanning-tree mst configuration → revision 1。',
      'SW-B：spanning-tree mst configuration → instance 2 vlan 20。四台一致之後，VLAN 20 的根橋就變成 Core-2。',
    ],
    solve(s) {
      typeIn(s, 'core2', ['enable', 'configure terminal', 'spanning-tree mst configuration', 'revision 1', 'exit', 'end', 'write memory']);
      typeIn(s, 'swb', ['enable', 'configure terminal', 'spanning-tree mst configuration', 'instance 2 vlan 20', 'exit', 'end', 'write memory']);
    },
    recap: [
      'MST 把很多 VLAN 對應到少數 instance，每個 instance 可以有不同的根橋：兩台核心各扛一部分。',
      '同一個區域的條件：名稱、revision、VLAN 對應完全一樣；差一點就變成不同的區域，各 instance 的設定在邊界上失效。',
    ],
  },
];
