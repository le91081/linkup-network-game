// 第八章補充：BPDU Filter 讓交換器之間的線不跑 STP（迴圈），Loop Guard 擋住收不到 BPDU 的埠
import { makeDevice as D, makeState, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute, settle, transact, portfastOn } from '../engine/sim.js';
import { parseIp } from '../engine/ip.js';
import { bpduFilterIf, bpduGuardOn, loopGuardOn } from '../engine/stpcfg.js';
import { dev, addVlan } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const SW = ['core', 'sw2', 'sw3'];
// 交換器之間的線
const UPLINKS = [['core', 'Gi1/0/1'], ['core', 'Gi1/0/2'], ['sw2', 'Gi0/9'], ['sw2', 'Gi0/10'], ['sw3', 'Gi0/9'], ['sw3', 'Gi0/10']];
const reach = (s, from) => transact(s, from, { proto: 'icmp', dst: parseIp('10.10.10.10'), quiet: true });

export const LEVELS59 = [
  {
    id: 'l139', chapter: 8, title: '備援線一接上，整棟樓斷網', subtitle: 'BPDU Filter、Loop Guard 與 BPDU Guard', tags: ['STP', 'BPDU Filter', 'Loop Guard', 'BPDU Guard', '迴圈'],
    brief: '上週在 2F 與 3F 的交換器之間多拉了一條備援線，平常應該由 STP 擋著、主線斷了才用。今天早上那條線一插上，整棟樓的電腦都連不到伺服器，交換器的燈號狂閃。前一任網管習慣用一份「接電腦的埠」範本設定 SW-2F 的每一個埠。請找出原因、讓網路恢復，而且備援線要保留；之後就算又有人犯同樣的錯，也要擋得住迴圈。',
    given: [
      ['Core', '根橋（VLAN 10 的優先權 4096），伺服器 10.10.10.10 接在 Gi1/0/10'],
      ['SW-2F', 'Gi0/9 上行到 Core；Gi0/10 是新拉的備援線，接到 SW-3F 的 Gi0/10；VLAN 10 的優先權 28672'],
      ['SW-3F', 'Gi0/9 上行到 Core；Gi0/10 接 SW-2F'],
      ['範本', 'SW-2F 的 Gi0/1–Gi0/10 都套了：spanning-tree portfast、spanning-tree bpdufilter enable'],
    ],
    learn: [
      { t: 'BPDU Filter', d: '介面上的 spanning-tree bpdufilter enable 讓這個埠不送、也不處理收到的 BPDU，等於這個埠沒有 STP。接電腦時沒事，接到另一台交換器就可能形成迴圈：對面收不到 BPDU，以為自己是 Designated、開始轉送；這一端也不理對面的 BPDU，同樣一直轉送。' },
      { t: '全域的 portfast bpdufilter default', d: '只套在 PortFast 的埠上，而且一收到 BPDU 就失去 PortFast、恢復正常的 STP。比介面上的 bpdufilter enable 安全得多；但接電腦的埠更常用的是 BPDU Guard：收到 BPDU 就把埠關掉 (err-disabled)。' },
      { t: 'Loop Guard', d: 'Root Port 或 Alternate Port 本來一直收得到上游的 BPDU。BPDU 突然不見了（對面開了 BPDU Filter、光纖單向斷掉、對面的 STP 當掉），一般的 STP 會把它變成 Designated 開始轉送，造成迴圈；開了 Loop Guard 的埠則進入 loop-inconsistent、繼續擋著，等 BPDU 回來才自動恢復。' },
      { t: '怎麼查', d: 'show spanning-tree：迴圈的那條線兩端都是 Desg FWD（應該要有一端是 Altn BLK）。show running-config interface 看得到 bpdufilter。被 Loop Guard 擋下的埠顯示 BKN* 與 *LOOP_Inc，show spanning-tree inconsistentports 也列得出來；紀錄裡有 %SPANTREE-2-LOOPGUARD_BLOCK。' },
    ],
    setup() {
      const s = makeState([
        D('c9300', 'core', { name: 'Core', pos: [0, -5] }),
        D('c2960', 'sw2', { name: 'SW-2F', pos: [-5, 1] }),
        D('c2960', 'sw3', { name: 'SW-3F', pos: [5, 1] }),
        D('tower', 'srv', { name: '伺服器', pos: [5, -8], ip: '10.10.10.10', mask: '255.255.255.0' }),
        D('pc', 'pc2', { name: '2F PC', pos: [-6, 5.5], ip: '10.10.10.21', mask: '255.255.255.0' }),
        D('pc', 'pc3', { name: '3F PC', pos: [6, 5.5], ip: '10.10.10.31', mask: '255.255.255.0' }),
      ], [['sw2:Gi0/9', 'core:Gi1/0/1'], ['sw3:Gi0/9', 'core:Gi1/0/2'], ['sw2:Gi0/10', 'sw3:Gi0/10'], ['srv:eth0', 'core:Gi1/0/10'], ['pc2:eth0', 'sw2:Gi0/1'], ['pc3:eth0', 'sw3:Gi0/1']]);
      for (const id of SW) addVlan(s, id, 10, 'STAFF');
      for (const [id, p] of UPLINKS) dev(s, id).sw.ports[p].mode = 'trunk';
      dev(s, 'core').sw.ports['Gi1/0/10'].vlan = 10; dev(s, 'sw2').sw.ports['Gi0/1'].vlan = 10; dev(s, 'sw3').sw.ports['Gi0/1'].vlan = 10;
      recompute(s);
      typeIn(s, 'core', ['enable', 'configure terminal', 'spanning-tree vlan 1,10 priority 4096', 'end', 'write memory']);
      typeIn(s, 'sw3', ['enable', 'configure terminal', 'interface Gi0/1', 'spanning-tree portfast', 'end', 'write memory']);
      // 前一任網管的範本：每一個埠都 portfast + bpdufilter（連後來接到 SW-3F 的 Gi0/10 也是）
      typeIn(s, 'sw2', ['enable', 'configure terminal', 'spanning-tree vlan 1,10 priority 28672',
        ...[1, 2, 3, 4, 5, 6, 7, 8, 10].flatMap((n) => [`interface Gi0/${n}`, 'spanning-tree portfast', 'spanning-tree bpdufilter enable', 'exit']), 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc2', to: 'srv', label: '2F 的電腦連得到伺服器' },
      { type: 'ping', from: 'pc3', to: 'srv', label: '3F 的電腦連得到伺服器' },
      {
        type: 'check', label: '備援線還接著，平常由 STP 擋著（有一端是 Alternate）',
        test(s) {
          const c = s.cables.find((x) => [x.a.dev, x.b.dev].sort().join() === 'sw2,sw3');
          if (!c) return 'SW-2F 與 SW-3F 之間的備援線被拔掉了：要保留，主線斷了才有路走';
          const ends = [[c.a.dev, c.a.port], [c.b.dev, c.b.port]];
          const f = ends.find(([id, p]) => bpduFilterIf(dev(s, id), p));
          if (f) return `${dev(s, f[0]).name} 的 ${f[1]} 還開著 BPDU Filter：這條線不跑 STP`;
          const alt = ends.some(([id, p]) => Object.values(((dev(s, id).rt.stp || {}).roles || {})[p] || {}).includes('altn'));
          return alt || `備援線的兩端都不是 Alternate（${s.rt.cable[c.id] === 'up' ? '兩端都在轉送' : '沒有正常運作'}）`;
        },
      },
      {
        type: 'check', label: '接電腦的埠改用 PortFast + BPDU Guard，不再用 BPDU Filter',
        test(s) {
          const sw2 = dev(s, 'sw2'), left = Object.keys(sw2.sw.ports).filter((p) => bpduFilterIf(sw2, p));
          if (left.length) return `SW-2F 還有埠開著 spanning-tree bpdufilter enable：${left.join('、')}`;
          const pc = sw2.sw.ports['Gi0/1'];
          if (!portfastOn(sw2, pc, 'Gi0/1')) return 'SW-2F 接電腦的 Gi0/1 要保留 PortFast（開機後立刻能用）';
          return bpduGuardOn(sw2, 'Gi0/1', true) || 'SW-2F 接電腦的埠沒有 BPDU Guard：有人在辦公桌接了一台交換器也不會被擋（spanning-tree portfast bpduguard default）';
        },
      },
      {
        type: 'check', label: '就算又有人在 SW-2F 的 Gi0/10 開了 BPDU Filter，Loop Guard 也擋得住迴圈',
        test(s) {
          const bad = SW.filter((id) => UPLINKS.some(([d, p]) => d === id && !loopGuardOn(dev(s, id), p)));
          if (bad.length) return `${bad.map((id) => dev(s, id).name).join('、')} 交換器之間的埠沒有開 Loop Guard（spanning-tree loopguard default）`;
          // 實際試一次：把同樣的錯誤做回去，3F 的電腦還連得到伺服器
          const t = cloneState(s);
          t.devices.sw2.sw.ports['Gi0/10'].bpdufilter = true;
          settle(t);
          const r = reach(t, 'pc3');
          return r.ok || `試著在 SW-2F 的 Gi0/10 開 BPDU Filter：${r.reason}`;
        },
      },
    ],
    hints: [
      '2F PC 的終端機 ping 10.10.10.10：廣播風暴，網段形成了迴圈。SW-3F 的 CLI：show spanning-tree，Gi0/10 是 Desg FWD（應該是 Altn BLK）。',
      'SW-2F：show running-config interface Gi0/10，看得到 spanning-tree bpdufilter enable：這個埠不送 BPDU，SW-3F 收不到，以為自己是 Designated。',
      'SW-2F：interface range Gi0/1 - 8 與 interface Gi0/10 → no spanning-tree bpdufilter；Gi0/10 是交換器之間的線，也要 no spanning-tree portfast。全域 spanning-tree portfast bpduguard default，接電腦的埠就有 BPDU Guard。',
      '三台交換器都下 spanning-tree loopguard default。之後在 SW-3F 的 show spanning-tree inconsistentports 可以看到 Loop Guard 擋下的埠。',
    ],
    solve(s) {
      typeIn(s, 'sw2', ['enable', 'configure terminal', ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [`interface Gi0/${n}`, 'no spanning-tree bpdufilter', 'exit']),
        'interface Gi0/10', 'no spanning-tree bpdufilter', 'no spanning-tree portfast', 'exit', 'spanning-tree portfast bpduguard default', 'spanning-tree loopguard default', 'end', 'write memory']);
      for (const id of ['core', 'sw3']) typeIn(s, id, ['enable', 'configure terminal', 'spanning-tree loopguard default', 'end', 'write memory']);
    },
    recap: [
      '介面上的 bpdufilter enable 等於關掉那個埠的 STP：接到交換器就會形成迴圈。接電腦的埠用 PortFast 加 BPDU Guard。',
      'Loop Guard 讓本來是 Root / Alternate 的埠在 BPDU 消失時繼續擋著 (loop-inconsistent)，不會自己變成 Designated。',
      '它只保護「收 BPDU 的那一端」：BPDU Filter 開在 Designated 那一端時，對面的 Loop Guard 才擋得住。',
    ],
  },
];
