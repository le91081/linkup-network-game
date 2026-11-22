// 第四章補充：機房的 A / B 兩路電
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const CRIT = ['fg', 'core', 'srv1', 'srv2'];

export const LEVELS45 = [
  // ════════════════════════ 4-6 ════════════════════════
  {
    id: 'l125', chapter: 4, title: 'A 路的電一跳，機房就全黑了', subtitle: '雙電源供應器與 A / B 兩路供電', tags: ['電力備援', 'PSU', 'PDU', 'UPS', '機房'],
    brief: `上週大樓的 A 路電箱跳電，機房的防火牆、核心交換器和一台伺服器全部關機，網站停了半小時 — 可是每台設備明明都有兩個電源供應器。機房有 A、B 兩路電（各有自己的 PDU 與 UPS）。請檢查每台設備的電源，讓 A 路或 B 路任何一路斷電時，網站和伺服器都照常運作。`,
    given: [
      ['供電', 'A 路、B 路兩組 PDU，各接不同的 UPS 與電箱'], ['防火牆 FG-100F', '兩個電源供應器'], ['核心交換器 Catalyst 9300', '第二個電源供應器還在包裝盒裡'],
      ['伺服器', 'Dell R650 × 2，各兩個電源供應器'], ['網站', '伺服器 10.0.0.11 · 對外 https'],
    ],
    learn: [
      { t: '雙電源與 A / B 兩路', d: '機房的設備多半有兩個電源供應器 (PSU)，一個就夠整台運作。兩個要分別接到 A、B 兩路電（不同的 PDU、UPS、電箱）：任何一路跳電、維修，另一路照樣供電。' },
      { t: '常見的假備援', d: '兩個 PSU 都插在同一條 PDU（或同一路）、第二個 PSU 買了沒裝、或裝了沒接電：平常看不出來，那一路一斷就全黑。show environment power 會顯示每個 PSU 的狀態。' },
      { t: 'UPS 與 PDU', d: 'UPS 在停電時用電池撐一段時間（讓發電機啟動或安全關機）；PDU 是機櫃裡的電源排插。A、B 兩路各自有 UPS，才不會因為一台 UPS 故障就全斷。' },
    ],
    setup() {
      const inet = setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -10] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34' });
      return makeState([
        inet,
        D('fg100f', 'fg', {
          name: 'FG-100F', pos: [0, -5.5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33' });
            Object.assign(g('x1'), { ip: '10.0.0.1', mask: '255.255.255.0' });
            d.policies.push(allow('伺服器上網', 'x1', 'wan1', { nat: true }));
            d.psu = [{ on: true, feed: 'A' }, { on: true, feed: 'A' }]; // 兩個都插在 A 路的 PDU 上
          },
        }),
        D('c9300', 'core', { name: '核心交換器', pos: [0, -1], init(d) { d.psu = [{ on: true, feed: 'A' }, { on: false, feed: '' }]; } }),
        D('rack1u', 'srv1', { name: '網站伺服器', pos: [-5, 4], ip: '10.0.0.11', gw: '10.0.0.1', dns: '8.8.8.8', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }], init(d) { d.psu = [{ on: true, feed: 'A' }, { on: true, feed: 'B' }]; } }),
        D('rack1u', 'srv2', { name: '資料庫伺服器', pos: [5, 4], ip: '10.0.0.12', gw: '10.0.0.1', dns: '8.8.8.8', services: [{ proto: 'tcp', port: 5432, name: 'PostgreSQL' }], init(d) { d.psu = [{ on: true, feed: 'A' }, { on: true, feed: '' }]; } }),
      ], [['inet:line1', 'fg:wan1'], ['fg:x1', 'core:Te1/1/1'], ['srv1:eth0', 'core:Te1/1/2'], ['srv2:eth0', 'core:Te1/1/3']]);
    },
    objectives: [
      { type: 'tcp', from: 'srv1', name: 'www.example.com', port: 443, label: '平常：網站伺服器連得到網際網路' },
      { type: 'failover', feed: ['A'], test: { type: 'tcp', from: 'srv1', name: 'www.example.com', port: 443 }, label: 'A 路斷電：網站伺服器照樣連得到網際網路' },
      { type: 'failover', feed: ['A'], test: { type: 'tcp', from: 'srv1', ip: '10.0.0.12', port: 5432 }, label: 'A 路斷電：網站伺服器照樣連得到資料庫' },
      { type: 'failover', feed: ['B'], test: { type: 'tcp', from: 'srv1', name: 'www.example.com', port: 443 }, label: 'B 路斷電（維修）：網站照常' },
      {
        type: 'check', label: '防火牆、核心交換器、兩台伺服器都有兩個電源供應器，分別接在 A 路與 B 路',
        test(s) {
          for (const id of CRIT) {
            const d = dev(s, id), on = (d.psu || []).filter((p) => p.on);
            if (on.length < 2) return `${d.name} 只裝了 ${on.length} 個電源供應器`;
            const feeds = new Set(on.map((p) => p.feed).filter(Boolean));
            if (on.some((p) => !p.feed)) return `${d.name} 有電源供應器裝了但沒接電`;
            if (feeds.size < 2) return `${d.name} 的兩個電源供應器都接在 ${[...feeds][0]} 路`;
          }
          return true;
        },
      },
    ],
    hints: [
      '點每台設備 →「電源」分頁，看 PSU 1、PSU 2 各接在哪一路。核心交換器的 CLI 也可以用 show environment power。',
      'FG-100F 的兩個 PSU 都插在 A 路：把 PSU 2 改接 B 路。',
      '核心交換器的 PSU 2 還沒裝：裝上去、接 B 路。資料庫伺服器的 PSU 2 裝了但沒接電。',
    ],
    solve(s) {
      dev(s, 'fg').psu[1].feed = 'B';
      dev(s, 'core').psu[1] = { on: true, feed: 'B' };
      dev(s, 'srv2').psu[1].feed = 'B';
      recompute(s);
    },
    recap: ['有兩個電源供應器不等於有備援：兩個要都裝上、都接電，而且分別接在 A、B 兩路。', '故障演練時一路一路斷電測試，才知道哪台設備其實只靠一路電。'],
  },
];
