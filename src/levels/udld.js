// 第八章補充：UDLD — 光纖的一芯斷了（單向的連線），兩端燈號都亮，STP 收不到 BPDU 就打開迴圈
import { makeDevice as D, makeState } from '../engine/model.js';
import { udldOn } from '../engine/stpcfg.js';
import { dev, WEB } from './util.js';

export const LEVELS86 = [
  {
    id: 'l166', chapter: 8, title: '燈都亮著，網路卻一直風暴', subtitle: 'UDLD：單向的光纖連線', tags: ['UDLD', 'STP', '光纖', '迴圈', 'Loop Guard'],
    brief: '大樓裝修之後，Dist-A 和 Dist-B 之間那條光纖的燈號照樣亮著，show interfaces 也是 up，可是網路三不五時就廣播風暴、整個停擺。光纖測試報告說其中一芯的衰減大到不行。在光纖換新之前，請讓這種「一個方向通、一個方向不通」的連線自動被關掉，不要再造成迴圈。',
    given: [
      ['Dist-A ↔ Dist-B', 'Gi0/11 ↔ Gi0/11（多模光纖）· Dist-A 是 Root（優先權 4096）'],
      ['Access', 'Gi0/1 → Dist-A、Gi0/2 → Dist-B'], ['伺服器', '192.168.10.10（Dist-A Gi0/5）'], ['PC', '192.168.10.50（Access Gi0/5）'],
    ],
    learn: [
      { t: '單向的連線', d: '光纖是兩芯：一芯送、一芯收。其中一芯斷了、收發器的 TX 壞了、或接線接錯，兩端的燈號可能都還亮著（尤其經過媒體轉換器），但只有一個方向傳得過去。' },
      { t: '為什麼會變成迴圈', d: 'STP 靠 BPDU 決定哪個埠要擋下來。收不到 BPDU 的那一端以為對面沒有交換器，把本來應該擋住的埠打開轉送：一個方向通的線就成了迴圈，廣播在網路裡繞個不停。' },
      { t: 'UDLD', d: 'UniDirectional Link Detection：兩端互相送 UDLD 的封包，確認「我收得到你、你也收得到我」。兩端都要開：udld enable（所有光纖埠，normal）或 udld aggressive，也可以在介面上 udld port [aggressive]。偵測到單向就把埠 err-disable（原因 udld），修好之後 udld reset 或 shutdown / no shutdown。' },
      { t: 'Loop Guard', d: 'Loop Guard 是 STP 這一邊的保護：本來應該是 Root / Alternate 的埠收不到 BPDU，就擋下來（loop-inconsistent），而不是打開轉送。和 UDLD 一起用最保險。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'dsa', { name: 'Dist-A', pos: [-5, -5], init(d) { Object.assign(d.sw.stp, { prio: 4096, portfastDefault: true }); } }),
        D('c2960', 'dsb', { name: 'Dist-B', pos: [5, -5], init(d) { Object.assign(d.sw.stp, { prio: 8192, portfastDefault: true }); } }),
        D('c2960', 'acc', { name: 'Access', pos: [0, 0], init(d) { d.sw.stp.portfastDefault = true; } }),
        D('tower', 'srv', { name: '伺服器', pos: [-8, 0], ip: '192.168.10.10', services: WEB }),
        D('pc', 'pc', { name: 'PC', pos: [0, 4.5], ip: '192.168.10.50' }),
      ], [['dsa:Gi0/11', 'dsb:Gi0/11'], ['dsa:Gi0/1', 'acc:Gi0/1'], ['dsb:Gi0/1', 'acc:Gi0/2'], ['srv:eth0', 'dsa:Gi0/5'], ['pc:eth0', 'acc:Gi0/5']]);
      const f = s.cables.find((c) => c.a.dev === 'dsa' && c.a.port === 'Gi0/11');
      Object.assign(f, { kind: 'mmf', uni: 'b' }); // Dist-A → Dist-B 的那一芯斷了：Dist-B 收不到
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'srv', port: 443, label: 'PC 連得到伺服器（沒有廣播風暴）' },
      {
        type: 'check', label: 'Dist-A 和 Dist-B 的光纖埠都開了 UDLD，單向的光纖被關掉 (err-disabled)',
        test(s) {
          for (const id of ['dsa', 'dsb']) if (!udldOn(dev(s, id), 'Gi0/11')) return `${dev(s, id).name} 的 Gi0/11 沒有開 UDLD（兩端都要開才偵測得到）`;
          const e = ((s.dyn && s.dyn.errdis) || {})['dsb:Gi0/11'];
          return (e && e.cause === 'udld') || '單向的光纖還沒有被 UDLD 關掉';
        },
      },
    ],
    hints: [
      'Dist-B：show spanning-tree，Gi0/11 收不到 Dist-A 的 BPDU，自己當了 Designated 打開轉送；Access 那邊也在轉送：迴圈。光纖的燈號兩端都亮，show interfaces 看不出問題。',
      'Dist-A 和 Dist-B 都要開 UDLD：configure terminal → udld aggressive（所有光纖埠），或 interface Gi0/11 → udld port aggressive。開好之後 show udld neighbors。',
      'UDLD 把兩端的 Gi0/11 關成 err-disabled（原因 udld），流量改走 Access 那一條，STP 正常擋下一個埠。另外可以在 Gi0/11 加 spanning-tree guard loop 當第二道保護。光纖換新之後 udld reset。',
    ],
    solve(s) {
      for (const id of ['dsa', 'dsb']) dev(s, id).sw.udld = { on: true, aggressive: true };
    },
    recap: ['單向的光纖兩端燈號都亮，但 BPDU 只傳得過去一邊：收不到的那一端打開轉送，就成了迴圈。', 'UDLD 兩端都開才偵測得到，偵測到就 err-disable；搭配 Loop Guard 更保險。'],
  },
];
