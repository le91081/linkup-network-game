// 第十章補充：配線架 — 牆上的網路孔 3F-12 沒有網路：機櫃裡的跳線插到別的孔了
import { makeDevice as D, makeState } from '../engine/model.js';
import { jackInfo } from '../engine/patch.js';
import { dev, WEB } from './util.js';

export const LEVELS84 = [
  {
    id: 'l164', chapter: 10, title: '3F-12 的網路孔沒有網路', subtitle: '配線架：前面的跳線與後面的水平佈線', tags: ['配線架', '結構化佈線', '實體層', '跳線'],
    brief: '三樓的新同事坐在 3F-12，電腦接上牆上的網路孔，網路卡的燈都不亮。機房的交換器上 Gi0/5 已經設好給他用，工班說「跳線早就接好了」。隔壁 3F-01 的同事一切正常。請找出問題並修好（不要動三樓的牆和網路線）。',
    given: [
      ['配線架 PP-3F', '後面打線到三樓的網路孔（3F-01 → 第 1 孔、3F-12 → 第 12 孔、3F-21 → 第 21 孔）'], ['交換器 SW-3F', 'Gi0/1 給 3F-01、Gi0/5 給 3F-12'],
      ['伺服器', '192.168.30.10'], ['3F-12 的電腦', '192.168.30.112'],
    ],
    learn: [
      { t: '結構化佈線', d: '牆上的網路孔用水平佈線（最長 90 公尺）拉到機房的配線架，打線在配線架的後面；配線架前面的孔再用短跳線接到交換器。配線架是被動的：前面第 n 孔和後面第 n 孔直接相通。' },
      { t: '標籤很重要', d: '配線架每一孔要貼上牆上網路孔的編號（3F-12），交換器的埠也要記錄接到哪一孔。沒有標籤，換一台交換器、整理一次跳線，就沒人知道哪條線通到哪裡。' },
      { t: '整條通道 100 公尺', d: '交換器 → 跳線 → 配線架 → 水平佈線 → 牆上的網路孔 → 跳線 → 電腦，整條通道 (channel) 加起來不能超過 100 公尺。' },
      { t: '怎麼查', d: '交換器的埠沒有燈號：從配線架的標籤找到那一孔，看前面有沒有插跳線。show interfaces status、show cdp / lldp neighbors 看得到接的是哪一台。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'sw', { name: 'SW-3F', pos: [-5, -5], init(d) { d.sw.stp.portfastDefault = true; } }),
        D('patch24', 'pp', { name: 'PP-3F', pos: [1, -5], init(d) { d.patch.labels = { 1: '3F-01', 12: '3F-12', 21: '3F-21' }; } }),
        D('tower', 'srv', { name: '伺服器', pos: [-8, 1], ip: '192.168.30.10', services: WEB }),
        D('pc', 'pc01', { name: '3F-01 的電腦', pos: [-1, 3.5], ip: '192.168.30.101' }),
        D('pc', 'pc12', { name: '3F-12 的電腦', pos: [4, 3.5], ip: '192.168.30.112' }),
      ], [['sw:Gi0/2', 'srv:eth0'], ['sw:Gi0/1', 'pp:f1'], ['sw:Gi0/5', 'pp:f21'], ['pp:r1', 'pc01:eth0'], ['pp:r12', 'pc12:eth0']]);
      s.dist = { 'pc01|pp': 42, 'pc12|pp': 78 };
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc01', to: 'srv', port: 443, label: '3F-01 的電腦照常連得到伺服器' },
      { type: 'tcp', from: 'pc12', to: 'srv', port: 443, label: '3F-12 的電腦連得到伺服器' },
      {
        type: 'check', label: 'SW-3F 的 Gi0/5 經過配線架第 12 孔接到 3F-12',
        test(s) {
          const j = jackInfo(s, dev(s, 'pp'), 12);
          if (!j.front) return '配線架第 12 孔（3F-12）的前面沒有插跳線';
          if (j.front.dev !== 'sw' || j.front.port !== 'Gi0/5') return `第 12 孔的跳線接到 ${dev(s, j.front.dev).name} 的 ${j.front.port}，應該是 SW-3F 的 Gi0/5`;
          return j.up || `第 12 孔不通：${j.why}`;
        },
      },
    ],
    hints: [
      '點配線架 PP-3F →「配線」分頁：第 12 孔（3F-12）後面接著 3F-12 的電腦，前面卻沒有跳線；SW-3F 的 Gi0/5 插在第 21 孔，第 21 孔後面什麼都沒接。',
      '把 SW-3F Gi0/5 那條跳線從配線架的「前 21」拔起來，改插「前 12」（拖曳 SW-3F 到配線架上接線時選 Gi0/5 和 前 12）。',
    ],
    solve(s) {
      const c = s.cables.find((x) => [x.a, x.b].some((e) => e.dev === 'pp' && e.port === 'f21'));
      const e = c.a.dev === 'pp' ? c.a : c.b;
      e.port = 'f12';
    },
    recap: ['配線架是被動的：後面接牆上的網路孔，前面用跳線接交換器，兩面都要接好才有燈號。', '配線架和交換器的埠都要貼標籤、留紀錄，才查得到哪一條線通到哪裡。'],
  },
];
