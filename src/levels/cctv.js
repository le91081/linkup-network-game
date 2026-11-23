// 第十二章補充：網路攝影機與 NVR（固定位元率的影像、上行頻寬）
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const CAMS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => 'cam' + n);

export const LEVELS57 = [
  {
    id: 'l137', chapter: 12, title: '監視器的錄影一卡一卡', subtitle: '網路攝影機、NVR 與上行頻寬', tags: ['監控', 'IP Camera', 'NVR', 'PoE', '頻寬', 'speed'],
    brief: '倉庫裝了 8 支 4K 網路攝影機，接在一台 PoE 交換器上，再往機房的 NVR 錄影。保全說每一支的畫面都一卡一卡、回放常常跳格。攝影機都有電、也都連得上 NVR。請讓 8 支攝影機都錄得順，而且維持 4K 畫質。',
    given: [
      ['SW-WH（倉庫）', 'Catalyst 2960-CX-8PC-L：Gi0/1 – 8 接攝影機（PoE），Gi0/9 上行到機房的 Core'],
      ['攝影機', '8 支 · 4K H.264 · 每支 16 Mbps · 10.10.50.101 – 108'], ['NVR', '10.10.50.10 · 接在 Core 的 Gi1/0/2'],
      ['規定', '畫質要維持 4K（每支至少 8 Mbps）'],
    ],
    learn: [
      { t: '影像是固定位元率', d: '網路攝影機不像檔案傳輸會「慢慢傳完」：它每秒就是要送那麼多（4K H.264 大約 16 Mbps）。線路剩下的頻寬比加起來的位元率少，多出來的封包就被丟掉，畫面卡頓、回放跳格。規劃時要把每一支的位元率加起來，看每一段上行夠不夠。' },
      { t: 'H.264 與 H.265', d: 'H.265 (HEVC) 在同樣的畫質下大約只要一半的位元率。8 支 4K 攝影機改用 H.265，總量就從 128 Mbps 降到大約 64 Mbps。NVR 也要支援 H.265 才看得到畫面。' },
      { t: '寫死的速率', d: 'show interfaces 看協商出來的速率：兩端都是 Gigabit 埠，卻跑在 100 Mbps，八成是有人寫死了 speed 100。兩端一起改回 auto（no speed、no duplex），才不會變成雙工不一致。' },
      { t: 'PoE 預算', d: '攝影機用 PoE 供電：Class 3 大約 6.5 W，夜間紅外線開著會更多。8 支加起來要在交換器的 PoE 預算之內（2960-CX-8PC-L 是 124 W）。' },
    ],
    setup() {
      const s = makeState([
        D('c9300', 'core', { name: 'Core', pos: [-6, -4] }),
        D('c2960p', 'sw', { name: 'SW-WH（倉庫）', pos: [4, -4] }),
        D('nvr', 'nvr', { name: 'NVR', pos: [-9, 1], ip: '10.10.50.10', mask: '255.255.255.0' }),
        ...CAMS.map((id, k) => D('ipcam', id, { name: `CAM-${k + 1}`, pos: [-1.5 + (k % 4) * 3.2, 1.5 + Math.floor(k / 4) * 3.5], ip: `10.10.50.${101 + k}`, mask: '255.255.255.0', init(d) { d.cam = { nvr: '10.10.50.10', mbps: 16 }; } })),
      ], [['core:Gi1/0/1', 'sw:Gi0/9'], ['nvr:eth0', 'core:Gi1/0/2'], ...CAMS.map((id, k) => [`${id}:eth0`, `sw:Gi0/${k + 1}`])]);
      recompute(s);
      // 前任為了「穩定」把上行埠寫死成 100 Mbps 全雙工（兩端都寫了，所以沒有雙工不一致，只是慢）
      typeIn(s, 'sw', ['enable', 'configure terminal', 'interface Gi0/9', 'speed 100', 'duplex full', 'end', 'write memory']);
      typeIn(s, 'core', ['enable', 'configure terminal', 'interface Gi1/0/1', 'speed 100', 'duplex full', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      {
        type: 'check', label: '8 支攝影機都錄得順（NVR 收到每一支要的位元率）',
        test(s) {
          const bad = CAMS.map((id) => dev(s, id)).filter((d) => { const f = (s.rt.cams || {})[d.id]; return !f || !f.rt || f.rt.mbps < +d.cam.mbps - 0.5; });
          if (!bad.length) return true;
          const f = (s.rt.cams || {})[bad[0].id], r = f && f.rt;
          return `${bad.map((d) => d.name).join('、')} 的畫面會卡：${r ? (r.mbps > 0 ? `只送得出 ${r.mbps} Mbps（要 ${bad[0].cam.mbps}）：${r.where}` : r.why) : '送不到 NVR'}`;
        },
      },
      {
        type: 'check', label: '維持 4K 畫質（每支至少 8 Mbps）',
        test(s) { const low = CAMS.map((id) => dev(s, id)).filter((d) => +d.cam.mbps < 8); return !low.length || `${low.map((d) => d.name).join('、')} 的位元率低於 8 Mbps：畫質不是 4K 了`; },
      },
    ],
    hints: [
      'NVR 的「錄影」分頁：8 個頻道每一支都只收到大約 12 Mbps（要 16 Mbps），合計剛好碰到 100 Mbps。',
      'SW-WH 的 CLI：show interfaces Gi0/9 是 100Mb/s、Full-duplex；兩端都是 Gigabit 埠。show running-config interface Gi0/9 看得到 speed 100 / duplex full。',
      '兩端都要改：SW-WH 的 Gi0/9 與 Core 的 Gi1/0/1 → no speed、no duplex（回到自動協商，1 Gbps）。只改一端會變成雙工不一致。',
      '另一種做法：每支攝影機的「攝影機」分頁改成 4K · H.265 · 8 Mbps，8 支只要 64 Mbps。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['enable', 'configure terminal', 'interface Gi0/9', 'no speed', 'no duplex', 'end', 'write memory']);
      typeIn(s, 'core', ['enable', 'configure terminal', 'interface Gi1/0/1', 'no speed', 'no duplex', 'end', 'write memory']);
    },
    recap: [
      '影像是固定位元率：把每一支攝影機的位元率加起來，每一段上行都要夠。',
      '燈亮著不代表夠快：用 show interfaces 看協商出來的速率，寫死的 speed / duplex 兩端要一起改回 auto。',
    ],
  },
];
