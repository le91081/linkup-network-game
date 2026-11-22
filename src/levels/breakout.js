// 第四章補充：QSFP28 的埠拆成 4 × 25G（breakout）
import { makeDevice as D, makeState, linkInfo } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { breakoutPort } from '../engine/breakout.js';
import { dev, link } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const STORE = '10.0.0.50';
const port = (s, id) => { const c = s.cables.find((x) => x.a.dev === id || x.b.dev === id); return c ? (c.a.dev === id ? c.a : c.b) : null; };

export const LEVELS48 = [
  // ════════════════════════ 4-7 ════════════════════════
  {
    id: 'l128', chapter: 4, title: '新的 GPU 伺服器接不上', subtitle: 'QSFP28 的 breakout：一個 100G 拆成 4 × 25G', tags: ['breakout', 'QSFP28', 'SFP28', 'Nexus', '資料中心'],
    brief: `機房到了兩台新的 GPU 伺服器，網卡是 25G 的 SFP28。機櫃頂的 Nexus 9332C 只有 100G 的 QSFP28 埠，線一插就說接頭不合。儲存伺服器早就用分歧線接在 Eth1/32 上了。請讓兩台 GPU 伺服器用 25G 接上交換器，連得到儲存伺服器 (${STORE})。`,
    given: [
      ['ToR', 'Nexus 9332C · 32 × QSFP28（100G）'], ['GPU 伺服器 × 2', 'Dell R650 · SFP28（25G）· 10.0.0.11、10.0.0.12'],
      ['儲存伺服器', `${STORE} · 接在 Eth1/32/1（Eth1/32 已經拆成 4 × 25G）`], ['線材', 'QSFP28 → 4 × SFP28 分歧線（DAC）'],
    ],
    learn: [
      { t: 'QSFP28 與 SFP28', d: 'QSFP28 裡面其實是 4 條 25G 的通道，合起來是 100G；SFP28 是單一條 25G。所以一個 QSFP28 埠可以用分歧線 (breakout cable) 拆成 4 個 25G 的埠，接 4 台 SFP28 的伺服器（40G 的 QSFP+ 一樣可以拆成 4 × 10G）。' },
      { t: 'breakout', d: 'NX-OS：interface breakout module 1 port 1 map 25g-4x。拆開之後 Ethernet1/1 不見了，變成 Ethernet1/1/1 – 1/1/4 四個子埠，各自設定 VLAN、速率。拆之前要先拔掉原本的 100G 線；no interface breakout … 合回去。' },
      { t: '10g-4x 或 25g-4x', d: '分歧線的速率要和伺服器的網卡一樣：25G 的網卡用 25g-4x；拆成 10g-4x 也連得上，但只有 10G。' },
    ],
    setup() {
      return makeState([
        D('n9332', 'tor', { name: 'ToR (Nexus 9332C)', pos: [0, -3], init(d) { breakoutPort(null, d, 'Eth1/32', '25g-4x'); } }),
        D('rack1u', 'store', { name: '儲存伺服器', pos: [7, 2], ip: STORE, services: [{ proto: 'tcp', port: 2049, name: 'NFS' }] }),
        D('rack1u', 'gpu1', { name: 'GPU 伺服器 1', pos: [-7.5, 3.5], ip: '10.0.0.11' }),
        D('rack1u', 'gpu2', { name: 'GPU 伺服器 2', pos: [-1.5, 5.5], ip: '10.0.0.12' }),
      ], [['tor:Eth1/32/1', 'store:eth0']]);
    },
    objectives: [
      { type: 'tcp', from: 'gpu1', ip: STORE, port: 2049, label: 'GPU 伺服器 1 連得到儲存伺服器（NFS）' },
      { type: 'tcp', from: 'gpu2', ip: STORE, port: 2049, label: 'GPU 伺服器 2 連得到儲存伺服器（NFS）' },
      {
        type: 'check', label: '兩台 GPU 伺服器都跑在 25 Gbps',
        test(s) {
          for (const id of ['gpu1', 'gpu2']) {
            const p = port(s, id), d = dev(s, id);
            if (!p) return `${d.name} 還沒有接線`;
            const li = linkInfo(s, id, p.port);
            if (!li || li.down) return `${d.name} 的連線沒有起來${li && li.down ? '：' + li.down : ''}`;
            if (li.speed !== 25000) return `${d.name} 只跑 ${li.speed / 1000} Gbps：分歧線要拆成 25g-4x（10g-4x 只有 10G）`;
          }
          return true;
        },
      },
    ],
    hints: [
      '試著把 GPU 伺服器接到 ToR：接頭規格不同（SFP28 ↔ QSFP28）。',
      'ToR →「連接埠」分頁的「QSFP 分歧 (breakout)」：Eth1/1 選「拆成 4 × 25G」；或 CLI：configure terminal → interface breakout module 1 port 1 map 25g-4x。',
      '再把 GPU 伺服器 1 接到 Eth1/1/1、GPU 伺服器 2 接到 Eth1/1/2（分歧線的四個 SFP28 頭）。',
    ],
    solve(s) {
      typeIn(s, 'tor', ['configure terminal', 'interface breakout module 1 port 1 map 25g-4x', 'end']);
      link(s, 'gpu1:eth0', 'tor:Eth1/1/1');
      link(s, 'gpu2:eth0', 'tor:Eth1/1/2');
      recompute(s);
    },
    recap: ['QSFP28 是 4 條 25G 的通道：用 breakout 拆成 4 個 25G 的子埠，一條分歧線接 4 台 SFP28 的伺服器。', '拆之前先拔線；拆開之後原本的埠不見了，變成 /1 – /4；速率要和網卡一樣（25g-4x 或 10g-4x）。'],
  },
];
