// 第十三章補充：EIGRP（鄰居條件、MD5 驗證、metric 與 feasible successor）
import { makeDevice as D, makeState } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
const KEY = ['key chain EIGRP-KEY', 'key 1', 'key-string Lnk#2026', 'exit', 'exit'];
const AUTH = ['interface Gi0/0/0', 'ip authentication mode eigrp 100 md5', 'ip authentication key-chain eigrp 100 EIGRP-KEY', 'exit'];

export const LEVELS49 = [
  {
    id: 'l129', chapter: 13, title: '分公司的 EIGRP 鄰居起不來，訊務都擠在 4G', subtitle: 'EIGRP 的鄰居條件、MD5 驗證與 feasible successor', tags: ['EIGRP', 'DUAL', 'MD5', 'key chain', 'feasible successor'],
    brief: '總公司和分公司之間剛拉好 1 Gbps 的光纖專線，原本的 4G 線路（10 Mbps）留著當備援。兩邊的路由器都跑 EIGRP AS 100，可是分公司的同事抱怨連總公司的 ERP 還是一樣慢：看起來訊務全部還在走 4G。請讓分公司走光纖、照總公司的規定在光纖上做 MD5 驗證，而且光纖斷掉的時候要能自動退回 4G。',
    given: [
      ['光纖專線', 'HQ-RT Gi0/0/0 10.0.12.1 ↔ BR-RT Gi0/0/0 10.0.12.2（/30）· 1 Gbps'],
      ['4G 備援', 'HQ-RT Gi0/0/1 10.0.13.1 ↔ LTE-RT ↔ BR-RT Gi0/0/1 10.0.23.2 · 介面都設了 bandwidth 10000（10 Mbps）'],
      ['EIGRP', 'AS 100 · HQ-RT 的 router-id 1.1.1.1、BR-RT 2.2.2.2、LTE-RT 3.3.3.3'],
      ['總公司的規定', '光纖上的 EIGRP 要做 MD5 驗證：key chain EIGRP-KEY · key 1 · key-string Lnk#2026（HQ-RT 已經設好）'],
      ['總公司', '10.1.0.0/24 · ERP 10.1.0.10（HTTPS）'], ['分公司', '10.2.0.0/24 · 同事的電腦 10.2.0.50'], ['規定', '不可以用靜態路由'],
    ],
    learn: [
      { t: 'EIGRP 是什麼', d: 'Cisco 開發的進階距離向量路由協定（RFC 7868 公開了基本規格）。只跟鄰居交換路由、有變化才送更新，收斂快。內部路由的 AD 是 90（路由表裡標 D），重分配進來的外部路由 (D EX) 是 170。' },
      { t: '成為鄰居的條件', d: '兩邊介面都在 network 敘述的範圍內、不是 passive、在同一個子網路、AS 號碼相同、K 值相同、驗證相同。任何一個對不上，show ip eigrp neighbors 就看不到對方；Hello 每 5 秒一次，Hold time 15 秒沒收到就拆掉鄰居。' },
      { t: 'metric', d: '預設 (K1 = K3 = 1) 只看兩樣東西：路徑上「最慢的頻寬」和「延遲的總和」。metric = 256 × (10⁷ / 最小頻寬 kbps + 延遲總和 / 10 µs)。bandwidth 指令只是告訴路由協定這條線有多快（不會真的限速），4G、ADSL 這類慢線一定要設對，不然 EIGRP 以為它跟 GE 一樣快。' },
      { t: 'FD、RD 與 feasible successor', d: 'FD (Feasible Distance) 是自己到目的地的 metric；RD (Reported Distance) 是鄰居報給你的、它自己到目的地的 metric。最好的那條叫 successor；其他鄰居只要 RD < 目前的 FD（feasibility condition），就保證不會繞回自己，叫 feasible successor，successor 一斷馬上換過去。沒有 feasible successor 的路要先向鄰居查詢 (Query，進入 Active 狀態) 才換得過去。' },
      { t: 'MD5 驗證', d: '先建 key chain：key chain <名稱> → key <編號> → key-string <密碼>；再到介面上 ip authentication mode eigrp <AS> md5 和 ip authentication key-chain eigrp <AS> <名稱>。只有一邊設、或兩邊的 key 編號 / 密碼不一樣，Hello 都會被丟掉，鄰居起不來（debug eigrp packets 會看到 authentication failure）。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'hq', { name: 'HQ-RT', pos: [-7, -4], init(d) { ip4(d, 'Gi0/0/0', '10.0.12.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.13.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.1.0.1'); } }),
        D('isr4331', 'br', { name: 'BR-RT', pos: [7, -4], init(d) { ip4(d, 'Gi0/0/0', '10.0.12.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.23.2', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.2.0.1'); } }),
        D('isr4321', 'lte', { name: 'LTE-RT（4G 備援）', pos: [0, 2], init(d) { ip4(d, 'Gi0/0/0', '10.0.13.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.23.1', '255.255.255.252'); } }),
        D('sw8', 'hsw', { name: 'HQ-Switch', pos: [-9.5, 1] }),
        D('sw8', 'bsw', { name: 'BR-Switch', pos: [9.5, 1] }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-11, 5.5], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('pc', 'pc', { name: '分公司 PC', pos: [11, 5.5], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [['hq:Gi0/0/0', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'lte:Gi0/0/0'], ['lte:Gi0/0/1', 'br:Gi0/0/1'], ['hq:Gi0/0/2', 'hsw:1'], ['erp:eth0', 'hsw:2'], ['br:Gi0/0/2', 'bsw:1'], ['pc:eth0', 'bsw:2']]);
      recompute(s);
      typeIn(s, 'hq', ['configure terminal', ...KEY, ...AUTH, 'interface Gi0/0/1', 'bandwidth 10000', 'exit',
        'router eigrp 100', 'eigrp router-id 1.1.1.1', 'network 10.0.12.0 0.0.0.3', 'network 10.0.13.0 0.0.0.3', 'network 10.1.0.0 0.0.0.255', 'passive-interface Gi0/0/2', 'end', 'write memory']);
      typeIn(s, 'lte', ['configure terminal', 'interface Gi0/0/0', 'bandwidth 10000', 'exit', 'interface Gi0/0/1', 'bandwidth 10000', 'exit',
        'router eigrp 100', 'eigrp router-id 3.3.3.3', 'network 10.0.13.0 0.0.0.3', 'network 10.0.23.0 0.0.0.3', 'end', 'write memory']);
      // 分公司：光纖那一條 network 打錯了（10.0.21.0），也還沒做 MD5 驗證
      typeIn(s, 'br', ['configure terminal', 'interface Gi0/0/1', 'bandwidth 10000', 'exit',
        'router eigrp 100', 'eigrp router-id 2.2.2.2', 'network 10.0.21.0 0.0.0.3', 'network 10.0.23.0 0.0.0.3', 'network 10.2.0.0 0.0.0.255', 'passive-interface Gi0/0/2', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'erp', port: 443, avoid: 'lte', label: '分公司開 ERP 走光纖，不再繞 4G（https://10.1.0.10）' },
      {
        type: 'check', label: 'BR-RT 和 HQ-RT 在光纖上是 EIGRP 鄰居，而且照規定做了 MD5 驗證',
        test(s) {
          const b = dev(s, 'br'), h = dev(s, 'hq');
          if ((b.routes || []).some((r) => /^10\.1\./.test(r.dst || '') || r.dst === '0.0.0.0')) return 'BR-RT 上有往總公司的靜態路由：規定是要讓 EIGRP 自己學到';
          const isMd5 = (d) => { const i = d.ifaces.find((x) => x.id === 'Gi0/0/0'); return !!(i && i.eigrpAuth && i.eigrpAuth.md5 && i.eigrpAuth.chain); };
          if (!isMd5(h)) return 'HQ-RT 光纖介面上的 MD5 驗證被拿掉了：總公司規定光纖上的 EIGRP 一定要驗證';
          const e = b.rt && b.rt.eigrp;
          if (!e) return 'BR-RT 沒有在跑 EIGRP';
          if (!e.ifs['Gi0/0/0']) return 'BR-RT 的 Gi0/0/0（光纖）沒有在跑 EIGRP：show ip eigrp interfaces 看看，network 敘述有沒有涵蓋 10.0.12.2';
          if (!e.nbrs.some((n) => n.dev === 'hq' && n.iface === 'Gi0/0/0' && !n.stale)) return `BR-RT 在光纖上還沒有和 HQ-RT 成為鄰居${e.ifs['Gi0/0/0'].why.length ? '：' + e.ifs['Gi0/0/0'].why[0] : ''}`;
          if (!isMd5(b)) return 'BR-RT 的光纖介面沒有設 MD5 驗證';
          const r = b.rt.routes.find((x) => x.net === parseIp('10.1.0.0') && x.bits === 24);
          return (r && r.type === 'E' && r.iface.id === 'Gi0/0/0') || 'BR-RT 往 10.1.0.0/24 的路不是從光纖上的 EIGRP 學到的';
        },
      },
      { type: 'failover', cut: [['br', 'Gi0/0/0']], label: '光纖斷掉時，分公司仍然連得到 ERP（自動改走 4G）', test: { type: 'tcp', from: 'pc', to: 'erp', port: 443 } },
    ],
    hints: [
      'BR-RT 的 CLI：show ip eigrp neighbors 只看得到 LTE-RT；show ip route 裡 10.1.0.0/24 是 D … via 10.0.23.1（4G）。再看 show ip eigrp interfaces：Gi0/0/0 根本沒有在跑 EIGRP。',
      'show running-config | section eigrp：network 10.0.21.0 0.0.0.3 打錯了，光纖是 10.0.12.0/30。router eigrp 100 → no network 10.0.21.0 0.0.0.3 → network 10.0.12.0 0.0.0.3。',
      '改好之後鄰居還是起不來：HQ-RT 的光纖介面要求 MD5 驗證，BR-RT 這邊送的 Hello 沒有驗證資料。路由卡片或 show ip eigrp interfaces 的說明會寫 authentication failure。',
      'BR-RT：key chain EIGRP-KEY → key 1 → key-string Lnk#2026 → exit → exit → interface Gi0/0/0 → ip authentication mode eigrp 100 md5 → ip authentication key-chain eigrp 100 EIGRP-KEY。show ip eigrp topology all-links 可以看到兩條路的 FD 與 RD。',
    ],
    solve(s) {
      typeIn(s, 'br', ['configure terminal', ...KEY, ...AUTH, 'router eigrp 100', 'no network 10.0.21.0 0.0.0.3', 'network 10.0.12.0 0.0.0.3', 'end', 'write memory']);
    },
    recap: [
      'EIGRP 要成為鄰居：network 涵蓋到介面、同一個子網路、AS 與 K 值相同、驗證一致；show ip eigrp neighbors / interfaces 是第一步。',
      'metric 看最慢的頻寬與延遲總和；慢的線路要設對 bandwidth。4G 那條的 RD 比光纖的 FD 大，不是 feasible successor：光纖斷掉時要先查詢 (Active) 才換過去。',
    ],
  },
];
