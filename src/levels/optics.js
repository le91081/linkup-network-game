// 第四章補充：光纖收發器（SR / LR、1G / 10G、第三方的收發器、光功率不夠）
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { fiberLink } from '../engine/model.js';
import { OPTICS } from '../engine/optics.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const cableOf = (s, a, b) => s.cables.find((c) => [c.a.dev, c.b.dev].sort().join('|') === [a, b].sort().join('|'));
/** 把 devId 那一端的收發器換成 pn */
const swap = (s, a, b, devId, pn) => { const c = cableOf(s, a, b), f = fiberLink(s, c); c.optics = { ...f.optics, [c.a.dev === devId ? 'a' : 'b']: pn }; };

export const LEVELS35 = [
  // ════════════════════════ 4-5 ════════════════════════
  {
    id: 'l115', chapter: 4, title: '光纖接好了，燈還是不亮', subtitle: '收發器：波長、速率、原廠編碼與光功率', tags: ['光纖', '收發器', 'SFP', 'err-disabled', 'CRC'],
    brief: '新的三條光纖都由廠商施工完畢：A 棟到 B 棟（單模 2 公里）、A 棟到倉庫（多模 250 公尺）、A 棟到研發機房（多模 200 公尺）。結果 B 棟和倉庫完全連不上，研發機房雖然連得上，備份卻慢得不得了。光纖本身都量測過沒問題。請讓三個地點都正常連回 A 棟的伺服器；公司規定一律使用原廠的收發器。',
    given: [
      ['A 棟 ↔ B 棟', '單模光纖 2 公里 · A 棟 Te1/1/1 ↔ B 棟 Te1/1/1'], ['A 棟 ↔ 倉庫', '多模光纖 250 公尺 · A 棟 Te1/1/2（10G SFP+）↔ 倉庫 Gi0/11（1G SFP）'],
      ['A 棟 ↔ 研發機房', '多模光纖 200 公尺 · A 棟 Te1/1/3 ↔ 研發 Te1/1/1'], ['伺服器', '192.168.1.10（A 棟）'],
      ['收發器', '點一下光纖就看得到兩端插的收發器，也可以更換'],
    ],
    learn: [
      { t: '收發器 (SFP)', d: '交換器的光纖埠本身沒有雷射，要插收發器：SFP 是 1G、SFP+ 是 10G、SFP28 是 25G、QSFP28 是 100G。收發器決定了波長、能跑多遠、要配哪一種光纖：SR 是 850 nm 配多模，LR 是 1310 nm 配單模。兩端的波長和速率都要一樣。' },
      { t: '速率要一樣', d: '10G 的 SFP+ 埠通常可以插 1G 的 SFP（埠就跑 1G），反過來 1G 的埠插不了 10G。光纖兩端一端是 1G、一端是 10G 的收發器，連線建立不起來，兩端都沒有燈號。' },
      { t: '原廠編碼', d: 'Cisco 的交換器會讀收發器裡的編碼，不是原廠的就記一筆 %PHY-4-UNSUPPORTED_TRANSCEIVER，並把埠關成 err-disabled (gbic-invalid)。隱藏指令 service unsupported-transceiver 可以讓它上線，但出了問題原廠不保證；換成原廠的收發器之後，err-disabled 的埠還是要 shutdown 再 no shutdown。' },
      { t: '光功率與 CRC', d: 'show interfaces transceiver 看得到收發器的數位診斷 (DOM)：發射 (Tx) 與接收 (Rx) 的光功率，單位 dBm。收到的光比收發器的靈敏度還弱時會標 --：燈還亮著，但訊框有位元錯誤 (CRC)、會掉封包，TCP 就慢下來。最常見的原因是接頭髒了，用光纖清潔筆清一清就好；再弱就整個斷線 (LOS)。' },
    ],
    setup() {
      const s = makeState([
        D('c9300', 'core', { name: 'A 棟核心', host: 'CORE-A', pos: [-7, -3] }),
        D('tower', 'srv', { name: '伺服器', pos: [-11, 2.5], ip: '192.168.1.10' }),
        D('c9300', 'sw-b', { name: 'B 棟交換器', host: 'SW-B', pos: [8, -4] }),
        D('pc', 'pc-b', { name: 'B 棟 PC', pos: [11.5, 1], ip: '192.168.1.21' }),
        D('c2960', 'sw-w', { name: '倉庫交換器', host: 'SW-WH', pos: [1, 4.5] }),
        D('pc', 'pc-w', { name: '倉庫 PC', pos: [1, 9], ip: '192.168.1.31' }),
        D('c9300', 'sw-r', { name: '研發機房', host: 'SW-RD', pos: [-6, 7] }),
        D('pc', 'pc-r', { name: '研發 PC', pos: [-10, 10], ip: '192.168.1.41' }),
      ], [
        ['srv:eth0', 'core:Gi1/0/1'], ['pc-b:eth0', 'sw-b:Gi1/0/1'], ['pc-w:eth0', 'sw-w:Gi0/1'], ['pc-r:eth0', 'sw-r:Gi1/0/1'],
        ['core:Te1/1/1', 'sw-b:Te1/1/1', 'smf'], ['core:Te1/1/2', 'sw-w:Gi0/11', 'mmf'], ['core:Te1/1/3', 'sw-r:Te1/1/1', 'mmf'],
      ]);
      s.dist = { 'core|sw-b': 2000, 'core|sw-w': 250, 'core|sw-r': 200, 'sw-b|sw-w': 1900, 'sw-r|sw-w': 300, 'sw-b|sw-r': 2100 };
      // B 棟那一端：便宜的第三方 LR；倉庫：A 棟插 10G SR、倉庫插 1G SX；研發：研發那端的接頭沒清乾淨
      const set = (a, b, opt, dirty) => { const c = cableOf(s, a, b); c.optics = { [c.a.dev === a ? 'a' : 'b']: opt[0], [c.a.dev === a ? 'b' : 'a']: opt[1] }; if (dirty) c.dirty = { [c.a.dev === b ? 'a' : 'b']: true }; };
      set('core', 'sw-b', ['SFP-10G-LR', 'SFP-10GLR-31']);
      set('core', 'sw-w', ['SFP-10G-SR', 'GLC-SX-MMD']);
      set('core', 'sw-r', ['SFP-10G-SR', 'SFP-10G-SR'], true);
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc-b', to: 'srv', label: 'B 棟 PC 可以 ping 到伺服器' },
      { type: 'ping', from: 'pc-w', to: 'srv', label: '倉庫 PC 可以 ping 到伺服器' },
      { type: 'speed', from: 'pc-r', to: 'srv', min: 500, label: '研發 PC 到伺服器至少 500 Mbps' },
      {
        type: 'check', label: '研發那條光纖收到的光功率正常（沒有 CRC 錯誤）',
        test(s) {
          const f = fiberLink(s, cableOf(s, 'core', 'sw-r'));
          if (!f || f.link.down) return `A 棟到研發機房的光纖沒有連線${f && f.link.down ? '：' + f.link.down : ''}`;
          return !f.link.marginal || `研發那條光纖有一端收到的光太弱（${f.link.rx[f.link.marginal]} dBm）：訊框會有 CRC 錯誤`;
        },
      },
      {
        type: 'check', label: '三條光纖都使用原廠 (Cisco) 的收發器',
        test(s) {
          for (const [b, name] of [['sw-b', 'B 棟'], ['sw-w', '倉庫'], ['sw-r', '研發機房']]) {
            const f = fiberLink(s, cableOf(s, 'core', b));
            const bad = f && Object.values(f.optics).find((pn) => (OPTICS[pn] || {}).vendor !== 'Cisco');
            if (bad) return `${name}那條光纖還插著第三方的收發器 ${bad}${dev(s, b).unsupportedXcvr ? '（service unsupported-transceiver 讓它上線了，但公司規定要用原廠的）' : ''}`;
          }
          return true;
        },
      },
    ],
    hints: [
      '先看哪條沒有燈號：點一下 A 棟到 B 棟那條黃色的光纖。B 棟交換器的 CLI：show interfaces status 會看到 Te1/1/1 是 err-disabled，show logging 有 %PHY-4-UNSUPPORTED_TRANSCEIVER — 插的是第三方的收發器。',
      '點那條光纖，把 B 棟那一端換成原廠的 SFP-10G-LR，再到 B 棟交換器：interface te1/1/1 → shutdown → no shutdown（err-disabled 不會自己恢復）。',
      '倉庫那條：A 棟插的是 10G 的 SFP-10G-SR，倉庫的 Gi0/11 只有 1G、插的是 GLC-SX-MMD。兩端速率要一樣：把 A 棟那一端也換成 GLC-SX-MMD（10G 的 SFP+ 埠可以插 1G 的收發器）。',
      '研發那條燈有亮，但研發機房的 show interfaces te1/1/1 的 CRC 一直增加，show interfaces transceiver 的 Rx Power 標著 --：收到的光太弱。點那條光纖，按「清潔兩端的光纖接頭」。',
    ],
    solve(s) {
      swap(s, 'core', 'sw-b', 'sw-b', 'SFP-10G-LR');
      swap(s, 'core', 'sw-w', 'core', 'GLC-SX-MMD');
      delete cableOf(s, 'core', 'sw-r').dirty;
      recompute(s);
      typeIn(s, 'sw-b', ['configure terminal', 'interface te1/1/1', 'shutdown', 'no shutdown', 'end']);
      recompute(s);
    },
    recap: ['光纖兩端的收發器要成對：波長一樣（SR 850 nm 配多模、LR 1310 nm 配單模）、速率一樣；Cisco 預設只接受原廠編碼的收發器。', 'show interfaces transceiver 看光功率：Rx 低於靈敏度，燈還亮著但有 CRC 錯誤、會掉封包 — 先清接頭。'],
  },
];
