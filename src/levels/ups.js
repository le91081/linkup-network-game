// 第四章補充：UPS 的負載與電池 — 市電中斷時 B 路沒有 UPS，所有的負載壓到 A 路的 UPS 上，過載；不重要的設備不要接 UPS
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { dev } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const CRIT = ['fg', 'core', 'srv1'];
const AB = () => [{ on: true, feed: 'A' }, { on: true, feed: 'B' }];

export const LEVELS77 = [
  {
    id: 'l157', chapter: 4, title: '停電了，UPS 撐不到發電機', subtitle: 'UPS 的負載、過載與電池時間', tags: ['UPS', '電力備援', '負載', '停電演練', '機房'],
    brief: '機房的 A 路接一台 APC Smart-UPS 1500，B 路直接接市電。大樓的發電機在停電後 10 分鐘才會供電。上個月停電，所有設備在停電的那一刻就全部關機了，連 10 秒都沒撐住。管理處要再做一次停電演練：防火牆、核心交換器和網站伺服器至少要撐 10 分鐘；備份伺服器和實驗室的 ESXi 停電時關機沒關係。重要設備的雙電源要保留。',
    given: [
      ['A 路', 'APC Smart-UPS SMT1500（1500 VA / 1000 W，電池 165 Wh）'], ['B 路', '市電，沒有 UPS（停電就沒電）'],
      ['重要設備', 'FG-100F（約 60 W）、核心 Catalyst 9300（約 150 W）、網站伺服器 R650（約 300 W）'],
      ['不重要的設備', '備份伺服器 R650（約 300 W）、實驗室 ESXi（約 380 W）'], ['發電機', '停電後 10 分鐘才會接手'],
    ],
    learn: [
      { t: 'UPS 在做什麼', d: '平常把市電整理乾淨送給設備，停電時改用電池供電，撐到發電機啟動，或讓設備安全關機。能撐多久看電池的能量和負載：大約是電池的 Wh × 0.9 ÷ 負載的瓦數。' },
      { t: '過載', d: 'UPS 有額定瓦數（這台 1000 W）。超過就是過載：平常市電正常時看不出來，停電那一刻切換到電池，UPS 發現撐不住就直接停止輸出，所有設備一起關機。外接電池組只能讓它撐久一點，不能解決過載。' },
      { t: '雙電源的陷阱', d: '平常兩個電源供應器各分一半的負載，UPS 看起來只用了六成。可是 B 路沒有 UPS：一停電，B 路沒電，所有雙電源的設備把全部的負載都壓到 A 路的 UPS 上。算 UPS 的容量要用「另一路斷電時」的負載來算。' },
      { t: '負載分級', d: '不是每台設備都需要接 UPS：備份、測試、實驗室的設備停電時可以關機，把 UPS 留給防火牆、核心、重要的伺服器。真的都要保，就要更大的 UPS，或者 B 路也接一台。' },
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
            d.psu = AB();
          },
        }),
        D('c9300', 'core', { name: '核心交換器', host: 'CORE-SW', pos: [0, -1], init(d) { d.psu = AB(); } }),
        D('rack1u', 'srv1', { name: '網站伺服器', pos: [-6.5, 4], ip: '10.0.0.11', gw: '10.0.0.1', dns: '8.8.8.8', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }], init(d) { d.psu = AB(); } }),
        D('rack1u', 'bak', { name: '備份伺服器', pos: [0, 4.5], ip: '10.0.0.21', gw: '10.0.0.1', services: [{ proto: 'tcp', port: 445, name: 'SMB' }], init(d) { d.psu = AB(); } }),
        D('esxi', 'lab', { name: '實驗室 ESXi', pos: [6.5, 4], init(d) { d.psu = AB(); Object.assign(d.ifaces[0], { ip: '10.0.0.31', mask: '255.255.255.0', gateway: '10.0.0.1' }); } }),
        D('ups', 'ups', { name: 'UPS-A', pos: [-7.5, -5], init(d) { d.ups.feed = 'A'; } }),
      ], [['inet:line1', 'fg:wan1'], ['fg:x1', 'core:Te1/1/1'], ['srv1:eth0', 'core:Te1/1/2'], ['bak:eth0', 'core:Te1/1/3'], ['lab:vmnic0', 'core:Te1/1/4']]);
    },
    objectives: [
      { type: 'tcp', from: 'srv1', name: 'www.example.com', port: 443, label: '平常：網站伺服器連得到網際網路' },
      { type: 'failover', utility: true, wait: 10, test: { type: 'tcp', from: 'srv1', name: 'www.example.com', port: 443 }, label: '停電 10 秒：重要設備還在運作（UPS 沒有過載）' },
      { type: 'failover', utility: true, wait: 600, test: { type: 'tcp', from: 'srv1', name: 'www.example.com', port: 443 }, label: '停電 10 分鐘：發電機接手之前，防火牆、核心、網站伺服器都還撐著' },
      {
        type: 'check', label: '防火牆、核心交換器、網站伺服器還是 A / B 雙電源',
        test(s) {
          for (const id of CRIT) {
            const d = dev(s, id), on = (d.psu || []).filter((p) => p.on && p.feed);
            if (new Set(on.map((p) => p.feed)).size < 2) return `${d.name} 不再是 A / B 雙電源：重要設備的備援不能拿掉`;
          }
          return true;
        },
      },
    ],
    hints: [
      'UPS-A →「UPS」分頁：平常的負載大約 595 W（雙電源的設備各分一半）。打開「模擬市電中斷」看看：B 路沒電，五台的負載都壓到 A 路，1190 W 超過 1000 W，UPS 過載、直接停止輸出。',
      '不重要的設備不要接 UPS：備份伺服器、實驗室 ESXi →「電源」分頁，把接在 A 路的電源供應器改接 B 路（兩個都在 B 路，停電時它們關機）。',
      '剩下防火牆、核心、網站伺服器大約 510 W：165 Wh × 0.9 ÷ 510 W ≈ 17 分鐘，撐得到發電機。外接電池組只能撐久一點，解決不了過載。',
    ],
    solve(s) {
      for (const id of ['bak', 'lab']) dev(s, id).psu = [{ on: true, feed: 'B' }, { on: true, feed: 'B' }];
    },
    recap: ['停電時沒有 UPS 的那一路會斷，雙電源設備的負載全部壓到有 UPS 的那一路：UPS 的容量要用這個負載來算。', '超過額定就過載、停止輸出；不重要的設備不要接 UPS，把電池留給重要的設備。'],
  },
];
