// 第十章補充：接觸不良的網路線（介面 flapping、CRC 錯誤）與 PortFast
import { makeDevice as D, makeState, removeCable } from '../engine/model.js';
import { portfastOn } from '../engine/sim.js';
import { dev, link } from './util.js';

const SMB = [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }];
const pcPort = (s) => { const c = s.cables.find((x) => (x.a.dev === 'pc1' && x.b.dev === 'sw') || (x.b.dev === 'pc1' && x.a.dev === 'sw')); return c ? (c.a.dev === 'sw' ? c.a.port : c.b.port) : null; };

export const LEVELS55 = [
  {
    id: 'l135', chapter: 10, title: '會議室的電腦每隔一分鐘就斷一次', subtitle: '接觸不良的網路線、介面計數器與 PortFast', tags: ['flapping', 'CRC', 'show logging', 'PortFast', '實體層'],
    brief: '三樓會議室那台電腦開視訊會議，大概每一分鐘就斷一次，每次斷掉都要等半分鐘才恢復。同一台交換器上的其他電腦都正常，電腦也重灌過了。請找出原因、修好它，而且以後這種接電腦的埠，線一接上就要能用。',
    given: [
      ['SW-3F', 'Catalyst 2960，三樓的存取交換器（原廠設定：沒有開 PortFast）'],
      ['會議室 PC', '10.10.0.51 · 接在 SW-3F 的 Gi0/5'], ['業務 PC', '10.10.0.52 · Gi0/6（正常）'], ['NAS', '10.10.0.20（SMB 445）· Gi0/1'],
    ],
    learn: [
      { t: '介面 flapping', d: '介面一下 up、一下 down，show logging 會看到一直重複的 %LINK-3-UPDOWN 與 %LINEPROTO-5-UPDOWN。最常見的原因是實體層：水晶頭鬆了、線被椅子壓到、模組或網卡快壞了。' },
      { t: '介面計數器', d: 'show interfaces 的 input errors、CRC 一直增加，代表收到的訊框壞了（電氣訊號不好）。show interfaces counters errors 一次看所有埠。CRC 在半雙工、雙工不一致時也會出現，要一起看雙工。' },
      { t: '為什麼每次都要等半分鐘', d: '沒有 PortFast 的埠，連上之後 STP 要經過 listening（15 秒）與 learning（15 秒）才開始轉送。線每斷一次，電腦就多斷 30 秒。接電腦、印表機的存取埠應該開 spanning-tree portfast（再搭配 BPDU Guard）。' },
      { t: '換線', d: '實體層的問題設定改不好：先換一條確定是好的跳線（patch cord）；還是不行再換牆上的資訊插座、交換器的埠。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'sw', { name: 'SW-3F', pos: [0, -3], init(d) { d.sw.stp.portfastDefault = false; } }),
        D('nas', 'nas', { name: 'NAS', pos: [-7, 3], ip: '10.10.0.20', mask: '255.255.255.0', services: SMB }),
        D('pc', 'pc1', { name: '會議室 PC', pos: [0, 4], ip: '10.10.0.51', mask: '255.255.255.0' }),
        D('pc', 'pc2', { name: '業務 PC', pos: [7, 3], ip: '10.10.0.52', mask: '255.255.255.0' }),
      ], [['nas:eth0', 'sw:Gi0/1'], ['pc1:eth0', 'sw:Gi0/5'], ['pc2:eth0', 'sw:Gi0/6']]);
      s.cables.find((c) => c.a.dev === 'pc1').loose = 'b'; // 交換器那一端的水晶頭鬆了
      s.flows = [{ id: 'rec', from: 'pc1', ip: '10.10.0.20', port: 445, mbps: 15, label: '會議錄影同步到 NAS', on: true }];
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc1', to: 'nas', port: 445, label: '會議室 PC 開得了 NAS 的檔案分享' },
      {
        type: 'check', label: '會議室 PC 的網路線換好了：不會再一分鐘斷一次',
        test(s) {
          if (!pcPort(s)) return '會議室 PC 沒有接到 SW-3F';
          return !s.cables.some((c) => c.loose) || '會議室 PC 的那條線還是同一條：show interfaces 的 CRC 還在增加，show logging 每分鐘一次 up / down';
        },
      },
      {
        type: 'check', label: '接電腦的埠開了 PortFast：線一接上就能用，不用等 30 秒的 STP',
        test(s) {
          const sw = dev(s, 'sw'), pid = pcPort(s);
          if (!pid) return '會議室 PC 沒有接到 SW-3F';
          return portfastOn(sw, sw.sw.ports[pid], pid) || `SW-3F 的 ${pid} 沒有開 PortFast：每次接上都要等 listening 15 秒 + learning 15 秒`;
        },
      },
    ],
    hints: [
      'SW-3F 的 CLI：show logging，Gi0/5 大約每一分鐘 down 一次、過幾秒又 up（%LINK-3-UPDOWN）。讓時間前進幾分鐘看得更清楚。',
      'show interfaces Gi0/5：input errors 與 CRC 一直增加；其他埠都是 0。這是實體層的問題（線或水晶頭），不是設定。',
      '把會議室 PC 的網路線拔掉，換一條新的接回 Gi0/5（點那條線 → 拔掉，再重新拉一條）。',
      '接上之後還要等 30 秒才通：interface Gi0/5 → spanning-tree portfast（或全域 spanning-tree portfast default，只對 access 埠生效）。',
    ],
    solve(s) {
      const c = s.cables.find((x) => x.loose);
      removeCable(s, c.id);
      link(s, 'pc1:eth0', 'sw:Gi0/5');
      dev(s, 'sw').sw.ports['Gi0/5'].portfast = true;
    },
    recap: [
      '介面一直 up / down、CRC 一直增加：先懷疑實體層，換一條好的線。',
      '接終端設備的存取埠開 PortFast，連上就轉送，不用等 STP 的 30 秒。',
    ],
  },
];
