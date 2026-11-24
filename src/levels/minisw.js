// 第八章補充：會議室的小交換器 — 兩個牆上的網路孔接到同一台小交換器；BPDU Filter 讓 STP 看不到，BPDU Guard 才擋得住
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { bpduGuardOn, bpduFilterIf } from '../engine/stpcfg.js';
import { portfastOn } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };

export const LEVELS87 = [
  {
    id: 'l167', chapter: 8, title: '會議室的小交換器', subtitle: '經過不跑 STP 的交換器形成的迴圈：BPDU Filter 與 BPDU Guard', tags: ['STP', 'BPDU Guard', 'BPDU Filter', '迴圈', 'PortFast'],
    brief: '業務部開會時，有人帶了一台五埠的小交換器，把會議室牆上的兩個網路孔（3F-05、3F-06）都插了上去，「這樣比較穩」。幾秒之後整層樓的網路就停了。之前的管理員為了「不要把 BPDU 送給使用者的設備」，在牆上網路孔的埠都加了 spanning-tree bpdufilter enable。請讓這種事以後不會再讓整層樓斷線。',
    given: [
      ['SW-3F', 'Gi0/1 → 業務 PC、Gi0/2 → 伺服器、Gi0/5 → 3F-05、Gi0/6 → 3F-06（會議室）'], ['會議室', '小交換器（不跑 STP）接了 3F-05 和 3F-06'],
      ['使用者的埠', 'spanning-tree portfast，而且 spanning-tree bpdufilter enable'],
    ],
    learn: [
      { t: '不跑 STP 的交換器', d: '一般的小交換器、Hub 不跑 STP，但會把 BPDU 當成一般的群播轉送出去。所以一台跑 STP 的交換器接了兩條線到同一台小交換器，會在另一個埠收到自己送出去的 BPDU，把其中一個埠擋下來。' },
      { t: 'BPDU Filter 的陷阱', d: '介面上的 spanning-tree bpdufilter enable 不送也不收 BPDU：交換器完全看不到小交換器形成的迴圈，兩個埠都轉送，廣播在迴圈裡越繞越多。（全域的 spanning-tree portfast bpdufilter default 收到 BPDU 就會失去 PortFast、回到正常的 STP，比較安全）' },
      { t: 'BPDU Guard', d: '接使用者的 PortFast 埠開 BPDU Guard（spanning-tree portfast bpduguard default，或介面 spanning-tree bpduguard enable）：只要收到 BPDU 就把埠關成 err-disabled。有人接了交換器、或接成迴圈，那個埠就被關掉，不會影響其他人。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'sw', { name: 'SW-3F', pos: [-3, -4] }),
        D('sw5', 'mini', { name: '會議室的小交換器', pos: [5, 1] }),
        D('pc', 'pc', { name: '業務 PC', pos: [-8, 2], ip: '192.168.3.21' }),
        D('tower', 'srv', { name: '伺服器', pos: [-3, 3.5], ip: '192.168.3.10', services: WEB }),
        D('laptop', 'nb', { name: '會議室的筆電', pos: [8, 4.5], ip: '192.168.3.88' }),
      ], [['pc:eth0', 'sw:Gi0/1'], ['srv:eth0', 'sw:Gi0/2'], ['sw:Gi0/5', 'mini:1'], ['sw:Gi0/6', 'mini:2'], ['nb:eth0', 'mini:3']]);
      typeIn(s, 'sw', ['enable', 'configure terminal', 'interface range Gi0/1 - 8', 'switchport mode access', 'spanning-tree portfast', 'spanning-tree bpdufilter enable', 'end']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'srv', port: 443, label: '業務 PC 連得到伺服器（沒有廣播風暴）' },
      {
        type: 'check', label: '使用者的埠沒有 BPDU Filter、開了 BPDU Guard',
        test(s) {
          const d = dev(s, 'sw');
          for (const p of ['Gi0/1', 'Gi0/5', 'Gi0/6']) {
            if (bpduFilterIf(d, p) && d.sw.ports[p].bpdufilter) return `${p} 還有 spanning-tree bpdufilter enable：STP 看不到經過小交換器的迴圈`;
            if (!bpduGuardOn(d, p, portfastOn(d, d.sw.ports[p], p))) return `${p} 沒有 BPDU Guard`;
          }
          return true;
        },
      },
    ],
    hints: [
      'SW-3F：show spanning-tree，Gi0/5、Gi0/6 都在轉送 (FWD)。show running-config 看得到它們有 spanning-tree bpdufilter enable：交換器不收 BPDU，看不到會議室的迴圈。',
      'interface range Gi0/1 - 8 → no spanning-tree bpdufilter enable。STP 會在其中一個埠收到自己的 BPDU，把它擋下來 (BLK)。',
      '再加一道保險：spanning-tree portfast bpduguard default（全域）。Gi0/5、Gi0/6 收到 BPDU 就被關成 err-disabled，會議室的小交換器拔掉之後再 shutdown / no shutdown。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['enable', 'configure terminal', 'interface range Gi0/1 - 8', 'no spanning-tree bpdufilter enable', 'exit', 'spanning-tree portfast bpduguard default', 'end']);
    },
    recap: ['不跑 STP 的小交換器照樣轉送 BPDU：STP 收得到自己的 BPDU 就會擋下迴圈，除非埠上開了 BPDU Filter。', '接使用者的 PortFast 埠用 BPDU Guard：收到 BPDU 就關掉那個埠，不會拖垮整層樓。'],
  },
];
