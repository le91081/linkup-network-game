// 第十三章補充：OSPF 的 stub / totally stubby / NSSA、iBGP、VRF 裡的 OSPF 與路由洩漏
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { parseIp, netOf } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
const loop = (d, n, ip, mask = '255.255.255.255') => d.ifaces.push(newIface('Lo' + n, 'Loopback' + n, { t: 'loop', n }, { ip, mask }));
const net = (c) => { const [a, b] = c.split('/'); return { net: netOf(parseIp(a), +b), bits: +b }; };
const ospf = (d, ...nets) => { d.ospfNets = nets.map(([c, area]) => ({ ...net(c), area })); };
const two = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
const saveAll = (s, ids) => { for (const id of ids) typeIn(s, id, ['write memory']); };
const fullWith = (s, id, peer, key = 'nbrs') => (dev(s, id).rt[key] || []).some((n) => n.dev === peer && n.state === 'full');

/**
 * 分支區域的路由器「路由表夠小」：外面的路只剩一條預設路由（O*IA），沒有外部路由 (O E1 / E2)、也沒有其他區域間的路。
 * allowN：NSSA 裡自己區域的 Type-7 (O N1 / N2) 可以有
 */
function smallTable(s, id, allowN = false) {
  const d = dev(s, id);
  if (!(d.rt.nbrs || []).some((n) => n.state === 'full')) return `${d.name} 沒有任何 FULL 的 OSPF 鄰居（show ip ospf neighbor）`;
  const o = d.rt.routes.filter((r) => r.type === 'O');
  const ext = o.filter((r) => /^E/.test(r.sub || '') || (!allowN && /^N/.test(r.sub || '')));
  if (ext.length) return `${d.name} 的路由表裡還有 ${new Set(ext.map((r) => r.net)).size} 筆外部路由（O ${ext[0].sub}，例如 ${[ext[0].net >>> 24, (ext[0].net >>> 16) & 255, (ext[0].net >>> 8) & 255, ext[0].net & 255].join('.')}/${ext[0].bits}）`;
  const ia = o.filter((r) => r.sub === 'IA' && r.bits > 0);
  if (ia.length) return `${d.name} 還有 ${new Set(ia.map((r) => r.net + '/' + r.bits)).size} 筆區域間的路由 (O IA)：連這些也不要，ABR 那一台要加 no-summary`;
  if (!o.some((r) => r.bits === 0)) return `${d.name} 沒有往外的預設路由`;
  return true;
}
const kv = (s, id) => { const d = dev(s, id); return d.rt.routes.filter((r) => r.type === 'O').length; };

/** 總公司那一側：R-Edge 把合作廠商的四個網段重分配進 OSPF（給分支區域「路由表太大」的理由） */
function hq(extra = []) {
  return [
    D('isr4331', 'edge', {
      name: 'R-Edge', pos: [-11, -6],
      init(d) {
        ip4(d, 'Gi0/0/0', '10.0.0.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.31.0.1', '255.255.255.252'); loop(d, 0, '10.255.0.1');
        ospf(d, ['10.0.0.0/30', 0], ['10.255.0.1/32', 0]);
        for (const n of [1, 2, 3, 4]) d.routes.push({ dst: `10.200.${n}.0`, mask: '255.255.255.0', via: '172.31.0.2' });
        d.ospfRedist = [{ src: 'static' }];
      },
    }),
    D('isr4321', 'pt', {
      name: '合作廠商 PT-RT', pos: [-15, 0],
      init(d) {
        ip4(d, 'Gi0/0/0', '172.31.0.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.200.1.1');
        for (const n of [2, 3, 4]) loop(d, n, `10.200.${n}.1`, '255.255.255.0');
        d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '172.31.0.1' });
      },
    }),
    D('isr4331', 'core', {
      name: 'Core', pos: [-4, -6],
      init(d) {
        ip4(d, 'Gi0/0/0', '10.0.0.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.1.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.1.0.1'); loop(d, 0, '10.255.0.2');
        ospf(d, ['10.0.0.0/30', 0], ['10.0.1.0/30', 0], ['10.1.0.0/24', 0], ['10.255.0.2/32', 0]); d.ospfPassive = ['Gi0/0/2'];
      },
    }),
    D('tower', 'erp', { name: '總公司 ERP', pos: [-4, 1], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
    ...extra,
  ];
}
const HQ_CABLES = [['edge:Gi0/0/0', 'core:Gi0/0/0'], ['edge:Gi0/0/1', 'pt:Gi0/0/0'], ['core:Gi0/0/2', 'erp:eth0']];

export const LEVELS20 = [
  // ─────────────────────────────────────────────── stub / totally stubby
  {
    id: 'l79', chapter: 13, title: '分公司的路由表太大了', subtitle: 'stub 與 totally stubby 區域', tags: ['OSPF', 'stub', 'totally stubby', 'ABR', 'Hello'],
    brief: '分公司的兩台路由器在 OSPF 的 area 10。總公司把合作廠商的網段重分配進 OSPF 之後，分公司的路由表跟著塞滿了外部路由，舊型的 BR-1 記憶體快撐不住。上週新裝的 BR-2 是照總公司的範本設定的，可是一直沒有和 Dist-RT 建立鄰居，分公司二的同事完全連不到總公司。請讓兩間分公司都連得到總公司與合作廠商，而且分公司路由器的路由表只留自己區域的路，外面的一律走一條預設路由。',
    given: [
      ['area 0', 'R-Edge · Core · Dist-RT 的 Gi0/0/0 · 總公司 ERP 10.1.0.10'], ['area 10', 'Dist-RT ↔ BR-1（10.10.255.0/30）· Dist-RT ↔ BR-2（10.10.255.4/30）'],
      ['分公司', 'BR-1：10.10.1.0/24 · BR-2：10.10.2.0/24'], ['合作廠商', '10.200.1.0 – 10.200.4.0/24（R-Edge 用靜態路由重分配進 OSPF）· 訂單系統 10.200.1.10'],
      ['規定', '骨幹 (area 0) 的設定不要動；R-Edge 照樣重分配'],
    ],
    learn: [
      { t: 'stub 區域', d: '分支區域只有一個出口（ABR），根本不需要知道外面每一條外部路由。把它設成 stub：ABR 不再把 Type-5 (O E1 / E2) 送進來，改送一筆 O*IA 的預設路由。代價是區域裡不能有 ASBR（不能重分配）。' },
      { t: 'totally stubby', d: '再進一步，連區域間的路 (O IA) 也不送，整個區域只剩自己的網段加一條預設路由。寫法是在 ABR 上 area 10 stub no-summary；區域裡的其他路由器照樣只寫 area 10 stub。' },
      { t: '每一台都要一樣', d: '區域是不是 stub 寫在 Hello 封包的選項位元裡。同一個區域裡有一台設了、另一台沒設，兩邊根本不會成為鄰居：show ip ospf neighbor 是空的，show ip ospf interface 會寫出 Hello 的選項位元不同（真的 IOS 要開 debug ip ospf hello 才看得到 mismatched Stub/Transit area option bit）。' },
      { t: '骨幹不行', d: 'area 0 不能設成 stub：所有區域間的路都要經過它。IOS 會直接拒絕：% OSPF: Backbone can not be configured as stub area。' },
      { t: '怎麼確認', d: 'show ip ospf 會寫 It is a stub area, no summary LSA in this area；ABR 的 show ip ospf database 在 Summary Net Link States (Area 10) 只剩一筆 0.0.0.0；分支路由器的 show ip route 只剩 O*IA 0.0.0.0/0。' },
    ],
    setup() {
      const s = makeState([
        ...hq([D('tower', 'papp', { name: '合作廠商的訂單系統', pos: [-15, 6], ip: '10.200.1.10', gw: '10.200.1.1', services: WEB })]),
        D('isr4331', 'dist', {
          name: 'Dist-RT（ABR）', pos: [3, -6],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.0.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.10.255.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.10.255.5', '255.255.255.252'); loop(d, 0, '10.255.0.3');
            ospf(d, ['10.0.1.0/30', 0], ['10.255.0.3/32', 0], ['10.10.255.0/30', 10], ['10.10.255.4/30', 10]);
          },
        }),
        D('isr4321', 'br1', {
          name: 'BR-1', pos: [10, -9],
          init(d) { ip4(d, 'Gi0/0/0', '10.10.255.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.10.1.1'); ospf(d, ['10.10.255.0/30', 10], ['10.10.1.0/24', 10]); d.ospfPassive = ['Gi0/0/1']; },
        }),
        D('isr4321', 'br2', {
          name: 'BR-2（新的）', pos: [10, -1],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.10.255.6', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.10.2.1'); ospf(d, ['10.10.255.4/30', 10], ['10.10.2.0/24', 10]); d.ospfPassive = ['Gi0/0/1'];
            d.ospfAreas = { 10: { stub: true } }; // 總公司的範本已經寫了 area 10 stub
          },
        }),
        D('pc', 'pc1', { name: '分公司一的電腦', pos: [15.5, -9], ip: '10.10.1.50', gw: '10.10.1.1' }),
        D('pc', 'pc2', { name: '分公司二的電腦', pos: [15.5, -1], ip: '10.10.2.50', gw: '10.10.2.1' }),
      ], [...HQ_CABLES, ['pt:Gi0/0/1', 'papp:eth0'], ['core:Gi0/0/1', 'dist:Gi0/0/0'], ['dist:Gi0/0/1', 'br1:Gi0/0/0'], ['dist:Gi0/0/2', 'br2:Gi0/0/0'], ['br1:Gi0/0/1', 'pc1:eth0'], ['br2:Gi0/0/1', 'pc2:eth0']]);
      recompute(s);
      saveAll(s, ['edge', 'pt', 'core', 'dist', 'br1', 'br2']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc2', to: 'erp', port: 443, label: '分公司二的電腦打得開總公司的 ERP' },
      { type: 'tcp', from: 'pc1', to: 'papp', port: 443, label: '分公司一照樣連得到合作廠商的訂單系統' },
      { type: 'check', label: 'BR-1 的路由表只剩分公司的路，外面的走一條預設路由', test: (s) => smallTable(s, 'br1') },
      { type: 'check', label: 'BR-2 也一樣', test: (s) => smallTable(s, 'br2') },
      {
        type: 'check', label: '總公司那邊照常：Core 還是學得到合作廠商的網段（O E2）',
        test(s) { const r = dev(s, 'core').rt.routes.find((x) => x.net === parseIp('10.200.1.0') && x.bits === 24); return (r && r.type === 'O' && r.sub === 'E2') || 'Core 學不到 10.200.1.0/24：骨幹與 R-Edge 的重分配不要動'; },
      },
    ],
    hints: [
      'BR-2 的 CLI：show ip ospf neighbor 是空的。show ip ospf interface gi0/0/0 最後一行寫了原因：area 10 在 BR-2 是 stub，在 Dist-RT 卻是一般區域。',
      'BR-1：show ip route 有一大串 O E2（合作廠商的網段）和 O IA。分公司只有 Dist-RT 這一個出口，其實一條預設路由就夠了。',
      'area 10 的每一台都要設成 stub：Dist-RT 與 BR-1 → router ospf 1 → area 10 stub。BR-1 的 O E2 會消失，換成一筆 O*IA 0.0.0.0/0；BR-2 也和 Dist-RT 成為鄰居了。',
      '要連 O IA 也拿掉，在 ABR（Dist-RT）加上 no-summary：area 10 stub no-summary（totally stubby）。BR-1、BR-2 不用加。也可以在路由器「路由」分頁的 OSPF 卡片設定區域的種類。',
    ],
    solve(s) {
      typeIn(s, 'dist', ['configure terminal', 'router ospf 1', 'area 10 stub no-summary', 'end', 'write memory']);
      typeIn(s, 'br1', ['configure terminal', 'router ospf 1', 'area 10 stub', 'end', 'write memory']);
    },
    recap: ['只有一個出口的區域設成 stub：外部路由換成一條預設路由；ABR 再加 no-summary 就是 totally stubby。', '區域的種類寫在 Hello 裡，同一個區域的每一台都要設定一樣，不然不會成為鄰居。'],
  },

  // ─────────────────────────────────────────────── NSSA
  {
    id: 'l80', chapter: 13, title: '工廠接了一條供應商專線', subtitle: 'NSSA 與 Type-7 LSA', tags: ['OSPF', 'NSSA', 'Type-7', 'ASBR', '路由重分配'],
    brief: '工廠在 OSPF 的 area 20，為了讓路由表保持精簡，早就設成 totally stubby。這個月供應商拉了一條專線接到工廠的 FAC-Edge，同事在 FAC-Edge 上加了往供應商的靜態路由，也下了 redistribute static，結果總公司和工廠的電腦都連不到供應商的出貨系統。請讓兩邊都連得到，而且工廠路由器的路由表照樣精簡：外面的路只能有一條預設路由。',
    given: [
      ['area 0', 'R-Edge · Core · Dist-RT 的 Gi0/0/0 · 總公司 ERP 10.1.0.10'], ['area 20（totally stubby）', 'Dist-RT ↔ FAC-Core（10.20.255.0/30）↔ FAC-Edge（10.20.255.4/30）· 工廠 10.20.1.0/24'],
      ['供應商', 'FAC-Edge Gi0/0/1 172.30.0.1/30 ↔ SUP-RT 172.30.0.2 · 172.20.0.0/16 · 出貨系統 172.20.1.10'],
      ['FAC-Edge', 'ip route 172.20.0.0 255.255.0.0 172.30.0.2 · router ospf 1 → redistribute static subnets'], ['規定', '其他路由器不可以手動加往供應商的靜態路由'],
    ],
    learn: [
      { t: 'stub 區域不能有 ASBR', d: 'stub 區域裡不能有 Type-5 LSA，所以區域裡的路由器重分配了也送不出去：FAC-Edge 自己是 ASBR，可是 Dist-RT 的資料庫裡根本沒有那筆 172.20.0.0/16。' },
      { t: 'NSSA', d: 'Not-So-Stubby Area：外面的 Type-5 一樣進不來，但區域裡的 ASBR 可以用 Type-7 LSA 送出重分配的路（區域裡看到的是 O N2 / N1）。NSSA 的 ABR 再把 Type-7 轉成 Type-5 送進骨幹，其他區域看到的就是一般的 O E2。' },
      { t: '誰負責轉換', d: '一個 NSSA 有好幾台 ABR 時，由 Router ID 最大的那一台負責轉換（show ip ospf 會寫 Perform type-7/type-5 LSA translation）。轉出來的 Type-5 帶著 forwarding address，其他路由器照樣往原本的 ASBR 走。' },
      { t: 'NSSA 的預設路由', d: 'stub 會自動送預設路由，NSSA 不會。要嘛在 ABR 上 area 20 nssa default-information-originate（Type-7，O*N2），要嘛 area 20 nssa no-summary（totally NSSA：區域間的路也不送，改送 O*IA 預設路由）。' },
      { t: '改區域種類的順序', d: '同一個區域不能同時是 stub 又是 NSSA：先 no area 20 stub，再 area 20 nssa。改的時候這個區域的鄰居會短暫中斷，正式環境要排在維護時段。' },
    ],
    setup() {
      const s = makeState([
        ...hq(),
        D('isr4321', 'dist', {
          name: 'Dist-RT（ABR）', pos: [3, -6],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.0.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.20.255.1', '255.255.255.252'); loop(d, 0, '10.255.0.3');
            ospf(d, ['10.0.1.0/30', 0], ['10.255.0.3/32', 0], ['10.20.255.0/30', 20]);
            d.ospfAreas = { 20: { stub: true, noSum: true } };
          },
        }),
        D('isr4331', 'fcore', {
          name: 'FAC-Core', pos: [9, -6],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.20.255.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.20.255.5', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.20.1.1');
            ospf(d, ['10.20.255.0/30', 20], ['10.20.255.4/30', 20], ['10.20.1.0/24', 20]); d.ospfPassive = ['Gi0/0/2'];
            d.ospfAreas = { 20: { stub: true } };
          },
        }),
        D('isr4321', 'fedge', {
          name: 'FAC-Edge', pos: [9, 1],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.20.255.6', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.30.0.1', '255.255.255.252'); loop(d, 0, '10.20.0.2');
            ospf(d, ['10.20.255.4/30', 20], ['10.20.0.2/32', 20]);
            d.ospfAreas = { 20: { stub: true } };
            d.routes.push({ dst: '172.20.0.0', mask: '255.255.0.0', via: '172.30.0.2' });
            d.ospfRedist = [{ src: 'static' }];
          },
        }),
        D('isr4321', 'sup', {
          name: '供應商 SUP-RT', pos: [15, 1],
          init(d) { ip4(d, 'Gi0/0/0', '172.30.0.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.20.1.1'); d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '172.30.0.1' }); },
        }),
        D('tower', 'ship', { name: '供應商的出貨系統', pos: [15, 7], ip: '172.20.1.10', gw: '172.20.1.1', services: WEB }),
        D('pc', 'fpc', { name: '工廠的電腦', pos: [15, -6], ip: '10.20.1.50', gw: '10.20.1.1' }),
      ], [...HQ_CABLES, ['core:Gi0/0/1', 'dist:Gi0/0/0'], ['dist:Gi0/0/1', 'fcore:Gi0/0/0'], ['fcore:Gi0/0/1', 'fedge:Gi0/0/0'], ['fcore:Gi0/0/2', 'fpc:eth0'], ['fedge:Gi0/0/1', 'sup:Gi0/0/0'], ['sup:Gi0/0/1', 'ship:eth0']]);
      recompute(s);
      saveAll(s, ['edge', 'pt', 'core', 'dist', 'fcore', 'fedge', 'sup']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'erp', to: 'ship', port: 443, label: '總公司的 ERP 連得到供應商的出貨系統' },
      { type: 'tcp', from: 'fpc', to: 'ship', port: 443, label: '工廠的電腦也連得到' },
      {
        type: 'check', label: 'Core 是從 OSPF 學到供應商的網段（O E2，由 NSSA 的 ABR 轉換）',
        test(s) {
          const c = dev(s, 'core');
          if ((c.routes || []).some((r) => r.dst && netOf(parseIp(r.dst), 16) === parseIp('172.20.0.0'))) return 'Core 上有手動加的靜態路由：規定是要讓 OSPF 自己學到';
          const r = c.rt.routes.find((x) => x.net === parseIp('172.20.0.0') && x.bits === 16);
          return !r ? 'Core 的路由表裡沒有 172.20.0.0/16（show ip ospf database 也看不到這筆 Type-5）' : (r.type === 'O' && /^E[12]$/.test(r.sub || '')) || `Core 的 172.20.0.0/16 是 ${r.type}${r.sub ? ' ' + r.sub : ''}，不是 OSPF 的外部路由`;
        },
      },
      {
        type: 'check', label: 'FAC-Core 的路由表照樣精簡：外面的路只有一條預設路由（區域裡的 O N2 可以有）',
        test(s) {
          const r = smallTable(s, 'fcore', true);
          if (r !== true) return r;
          const n = dev(s, 'fcore').rt.routes.find((x) => x.net === parseIp('172.20.0.0') && x.bits === 16);
          return (n && n.type === 'O' && /^N[12]$/.test(n.sub || '')) || 'FAC-Core 沒有從 FAC-Edge 學到 172.20.0.0/16（區域裡應該是 O N2）';
        },
      },
    ],
    hints: [
      'FAC-Edge：show ip ospf 寫著它是 ASBR，可是 Dist-RT 的 show ip ospf database 完全沒有 172.20.0.0 的 Type-5：area 20 是 stub，Type-5 不能出現在這個區域裡。',
      '把 area 20 改成 NSSA：三台都要先 no area 20 stub，再 area 20 nssa。FAC-Edge 改用 Type-7 送，FAC-Core 學到 O N2 172.20.0.0/16，Dist-RT 轉成 Type-5，Core 學到 O E2。',
      '改成 NSSA 之後，FAC-Core 又收到一堆 O IA，而且沒有預設路由了（NSSA 不會自動送）。在 ABR（Dist-RT）上改成 area 20 nssa no-summary（totally NSSA）：區域間的路換成一筆 O*IA 預設路由。',
      '驗證：Dist-RT 的 show ip ospf 會寫 Perform type-7/type-5 LSA translation；Core 的 show ip route 172.20.0.0 是 extern 2，show ip ospf database 的 Type-5 那一筆，ADV Router 是 Dist-RT。',
    ],
    solve(s) {
      typeIn(s, 'dist', ['configure terminal', 'router ospf 1', 'no area 20 stub', 'area 20 nssa no-summary', 'end', 'write memory']);
      for (const id of ['fcore', 'fedge']) typeIn(s, id, ['configure terminal', 'router ospf 1', 'no area 20 stub', 'area 20 nssa', 'end', 'write memory']);
    },
    recap: ['stub 區域裡不能重分配；需要 ASBR 又要保持精簡，就改成 NSSA：區域裡用 Type-7 (O N2)，ABR 轉成 Type-5 送出去。', 'NSSA 不會自動送預設路由：用 no-summary（totally NSSA）或 default-information-originate。'],
  },

  // ─────────────────────────────────────────────── iBGP
  {
    id: 'l81', chapter: 13, title: '兩個出口，同一個 AS', subtitle: 'iBGP：update-source、next-hop-self、全網狀', tags: ['BGP', 'iBGP', 'update-source', 'next-hop-self', 'route reflector'],
    brief: '公司（AS 65010，網段 192.0.2.0/24）有兩台邊界路由器：R-A 接 ISP-A、R-B 接 ISP-B，中間是跑 OSPF 的 Core。兩條 eBGP 都已經 Established，前任工程師也在 R-A 和 R-B 之間設了 iBGP，可是一直停在 Active。員工連不到兩家 ISP 的雲端服務。請讓員工往 ISP-A 的服務走 R-A、往 ISP-B 的服務走 R-B，任何一條 ISP 的線斷了，照樣繞得過去。規定：不可以把 BGP 重分配進 OSPF（正式環境是整張網際網路路由表，OSPF 撐不住）。',
    given: [
      ['R-A', 'Gi0/0/0 203.0.113.2/30 → ISP-A（AS 64500）· Loopback0 10.255.0.1'], ['R-B', 'Gi0/0/0 198.51.100.2/30 → ISP-B（AS 64510）· Loopback0 10.255.0.2'],
      ['Core', 'Loopback0 10.255.0.3 · 員工 192.0.2.0/24'], ['OSPF area 0', 'R-A ↔ Core 10.0.1.0/30 · Core ↔ R-B 10.0.2.0/30 · 三台的 Loopback'],
      ['雲端服務', 'ISP-A：203.0.113.80 · ISP-B：198.51.100.80（HTTPS）'],
    ],
    learn: [
      { t: 'iBGP', d: '同一個 AS 裡的路由器之間也用 BGP 交換從外面學到的路（remote-as 和自己一樣）。iBGP 不要求直連，所以通常用 Loopback 建立鄰居：只要 IGP 有路，任何一條實體線斷了都不影響。' },
      { t: 'update-source', d: '用 Loopback 建立鄰居時，TCP 179 預設從出口介面的位址送出，對方設定的鄰居卻是你的 Loopback，連線被拒絕，停在 Active。兩端都要 neighbor <對方 Loopback> update-source Loopback0。' },
      { t: 'next-hop-self', d: 'iBGP 送路由時下一站不會變，還是 ISP 那一端的位址。AS 裡的其他路由器查不到它（inaccessible），那條路就不能用。邊界路由器對 iBGP 鄰居加 next-hop-self，下一站就變成自己的 Loopback。' },
      { t: 'iBGP 的 split horizon', d: '從 iBGP 學到的路不會再送給其他 iBGP 鄰居（防止迴圈）。所以 AS 裡每一台跑 BGP 的路由器要兩兩建立鄰居（全網狀），或指定一台 route reflector，讓它替 client 轉送。中間的 Core 如果沒有 BGP 的路，封包到了它那裡就沒有路可走（BGP 黑洞）。' },
      { t: '管理距離', d: 'eBGP 學到的路是 20、iBGP 是 200，比 OSPF 的 110 還大：內部的網段永遠以 IGP 為準。show ip bgp 第一欄的 i 代表從 iBGP 學到，r 代表路由表裡有更好的路 (RIB-failure)。' },
    ],
    setup() {
      const isp = (id, name, pos, asn, custIp, custPeer, coreIp, corePeer, block, svc) => D('internet', id, {
        name, pos, ports: two,
        init(d) {
          d.inet.hosts = [{ ip: svc, name: `${name.split('（')[0]} 的雲端服務`, services: WEB }]; d.inet.transit = true;
          Object.assign(d.ifaces[0], { ip: custIp, mask: '255.255.255.252' });
          Object.assign(d.ifaces[1], { ip: coreIp, mask: '255.255.255.252' });
          d.inet.bgp = { asn, neighbors: [{ ip: custPeer, remoteAs: 65010, role: 'customer' }, { ip: corePeer, remoteAs: 64999, role: 'peer' }], networks: [net(block)] };
        },
      });
      const edge = (id, name, pos, wan, wanPeer, ispAs, desc, lo, other, lan, lanNet) => D('isr4331', id, {
        name, pos,
        init(d) {
          ip4(d, 'Gi0/0/0', wan, '255.255.255.252'); ip4(d, 'Gi0/0/1', lan, '255.255.255.252'); loop(d, 0, lo);
          ospf(d, [lanNet, 0], [lo + '/32', 0]);
          d.bgp = { asn: 65010, neighbors: [{ ip: wanPeer, remoteAs: ispAs, desc }, { ip: other, remoteAs: 65010, desc: 'iBGP' }], networks: [net('192.0.2.0/24')] };
        },
      });
      const s = makeState([
        D('internet', 'net', {
          name: '網際網路', pos: [0, -15], ports: two,
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.252' });
            Object.assign(d.ifaces[1], { ip: '198.51.100.10', mask: '255.255.255.252' });
            d.inet.client = '93.184.216.10';
            d.inet.hosts.push({ ip: '93.184.216.10', name: '外部使用者', services: [] });
            d.inet.bgp = { asn: 64999, neighbors: [{ ip: '203.0.113.9', remoteAs: 64500, role: 'peer' }, { ip: '198.51.100.9', remoteAs: 64510, role: 'peer' }], networks: ['8.8.8.0/24', '93.184.216.0/24'].map(net) };
          },
        }),
        isp('ispa', 'ISP-A（AS 64500）', [-9, -10], 64500, '203.0.113.1', '203.0.113.2', '203.0.113.9', '203.0.113.10', '203.0.113.0/24', '203.0.113.80'),
        isp('ispb', 'ISP-B（AS 64510）', [9, -10], 64510, '198.51.100.1', '198.51.100.2', '198.51.100.9', '198.51.100.10', '198.51.100.0/24', '198.51.100.80'),
        edge('ra', 'R-A', [-7, -4], '203.0.113.2', '203.0.113.1', 64500, 'ISP-A', '10.255.0.1', '10.255.0.2', '10.0.1.1', '10.0.1.0/30'),
        edge('rb', 'R-B', [7, -4], '198.51.100.2', '198.51.100.1', 64510, 'ISP-B', '10.255.0.2', '10.255.0.1', '10.0.2.1', '10.0.2.0/30'),
        D('isr4331', 'core', {
          name: 'Core', pos: [0, 1],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.0.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.2.2', '255.255.255.252'); ip4(d, 'Gi0/0/2', '192.0.2.1'); loop(d, 0, '10.255.0.3');
            ospf(d, ['10.0.1.0/30', 0], ['10.0.2.0/30', 0], ['192.0.2.0/24', 0], ['10.255.0.3/32', 0]); d.ospfPassive = ['Gi0/0/2'];
          },
        }),
        D('pc', 'pc', { name: '員工 PC', pos: [0, 7], ip: '192.0.2.50', gw: '192.0.2.1', dns: '8.8.8.8' }),
      ], [['net:line1', 'ispa:line2'], ['net:line2', 'ispb:line2'], ['ispa:line1', 'ra:Gi0/0/0'], ['ispb:line1', 'rb:Gi0/0/0'], ['ra:Gi0/0/1', 'core:Gi0/0/0'], ['rb:Gi0/0/1', 'core:Gi0/0/1'], ['core:Gi0/0/2', 'pc:eth0']]);
      recompute(s);
      saveAll(s, ['ra', 'rb', 'core']);
      return s;
    },
    objectives: [
      {
        type: 'check', label: 'Core 和 R-A、R-B 都有 iBGP 鄰居（用 Loopback 建立），設定了的 iBGP 鄰居全部是 Established',
        test(s) {
          for (const id of ['ra', 'rb', 'core']) {
            const d = dev(s, id), p = ((d.rt.bgp || {}).peers || []).filter((x) => x.ibgp);
            const bad = p.find((x) => x.state !== 'Established');
            if (bad) return `${d.name} 的 iBGP 鄰居 ${bad.ip} 是 ${bad.state}${bad.why ? '（' + bad.why + '）' : ''}`;
            if (p.some((x) => !/^10\.255\.0\./.test(x.ip))) return `${d.name} 的 iBGP 鄰居要用 Loopback（10.255.0.x）建立：實體線斷了鄰居關係才不會跟著斷`;
          }
          const peersOf = (id) => ((dev(s, id).rt.bgp || {}).peers || []).filter((x) => x.ibgp && x.state === 'Established').map((x) => x.ip);
          if (!peersOf('core').length) return 'Core 沒有跑 BGP：iBGP 學到的路不會再轉送給別的 iBGP 鄰居，中間的 Core 也要有 BGP 的路';
          for (const [id, lo] of [['ra', '10.255.0.1'], ['rb', '10.255.0.2']]) if (!peersOf(id).includes('10.255.0.3') && !peersOf('core').includes(lo)) return `${dev(s, id).name} 和 Core 之間沒有 iBGP`;
          return true;
        },
      },
      { type: 'tcp', from: 'pc', ip: '203.0.113.80', port: 443, label: '員工連得到 ISP-A 的雲端服務' },
      { type: 'tcp', from: 'pc', ip: '198.51.100.80', port: 443, label: '員工連得到 ISP-B 的雲端服務' },
      {
        type: 'check', label: 'Core 是從 BGP 學到兩家 ISP 的網段，往 ISP-B 走 R-B、往 ISP-A 走 R-A',
        test(s) {
          const c = dev(s, 'core');
          for (const [p, want, name] of [['203.0.113.0', '10.0.1.1', 'R-A'], ['198.51.100.0', '10.0.2.1', 'R-B']]) {
            const r = c.rt.routes.find((x) => x.net === parseIp(p) && x.bits === 24 && !x.bad);
            if (!r) return `Core 的路由表裡沒有 ${p}/24`;
            if (r.type !== 'B') return `Core 的 ${p}/24 是 ${r.type}${r.sub ? ' ' + r.sub : ''} 路由：規定要用 iBGP 學到（不要重分配進 OSPF、也不要加靜態路由）`;
            if (r.via !== parseIp(want)) return `Core 往 ${p}/24 不是走 ${name}：AS path 比較短的那家應該贏`;
          }
          return true;
        },
      },
      {
        type: 'failover', label: 'ISP-A 的線斷了，員工照樣連得到 ISP-A 的服務（改走 R-B → ISP-B → 網際網路）', cut: [['ra', 'Gi0/0/0']],
        test: { type: 'tcp', from: 'pc', ip: '203.0.113.80', port: 443 },
      },
    ],
    hints: [
      'R-A：show ip bgp summary，10.255.0.2 停在 Active，最後一行寫了原因：R-A 從 10.0.1.1（實體介面）連過去，R-B 設定的鄰居卻是 10.255.0.1。兩端都要 neighbor … update-source Loopback0。',
      'iBGP 起來之後，R-A 的 show ip bgp 198.51.100.0：從 R-B 學到的那一條（下一站 198.51.100.1）標著 inaccessible，第一欄沒有 *。198.51.100.1 是 ISP-B 那一端的位址，R-A 查不到。R-B 要 neighbor 10.255.0.1 next-hop-self（R-A 對 R-B 也一樣）。',
      '員工 PC 還是連不到：Core 的 show ip route 沒有 203.0.113.0/24 和 198.51.100.0/24，因為 Core 沒有跑 BGP。iBGP 學到的路不會再轉送給別的 iBGP 鄰居，所以 Core 要和 R-A、R-B 各建立 iBGP（全網狀），或在 Core 上把 R-A、R-B 設成 route-reflector-client。',
      'Core：router bgp 65010 → neighbor 10.255.0.1 remote-as 65010 → neighbor 10.255.0.1 update-source loopback0（10.255.0.2 也一樣）。R-A、R-B 也加上 neighbor 10.255.0.3 remote-as 65010、update-source loopback0、next-hop-self。',
    ],
    solve(s) {
      for (const [id, other] of [['ra', '10.255.0.2'], ['rb', '10.255.0.1']]) {
        typeIn(s, id, ['configure terminal', 'router bgp 65010', `neighbor ${other} update-source loopback0`, `neighbor ${other} next-hop-self`,
          'neighbor 10.255.0.3 remote-as 65010', 'neighbor 10.255.0.3 update-source loopback0', 'neighbor 10.255.0.3 next-hop-self', 'end', 'write memory']);
      }
      typeIn(s, 'core', ['configure terminal', 'router bgp 65010', 'neighbor 10.255.0.1 remote-as 65010', 'neighbor 10.255.0.1 update-source loopback0',
        'neighbor 10.255.0.2 remote-as 65010', 'neighbor 10.255.0.2 update-source loopback0', 'end', 'write memory']);
    },
    recap: ['iBGP 用 Loopback 建立：兩端都要 update-source；邊界路由器對 iBGP 鄰居 next-hop-self。', 'iBGP 學到的路不會轉送給別的 iBGP 鄰居：AS 裡跑 BGP 的路由器要全網狀，或用 route reflector。'],
  },

  // ─────────────────────────────────────────────── VRF 裡的 OSPF 與路由洩漏
  {
    id: 'l82', chapter: 13, title: '共用服務放在全域的路由表', subtitle: 'VRF 裡的 OSPF 與路由洩漏', tags: ['VRF', 'OSPF', '路由洩漏', 'VRF-Lite', '多租戶'],
    brief: '機房的 DC-PE 用 VRF 隔開兩家客戶：A 公司在 TENANT-A、B 公司在 TENANT-B，兩家都用自己的路由器 (CE) 和 DC-PE 跑 OSPF。共用的更新伺服器放在全域的路由表，接在 SVC-RT 後面。前任工程師只在 DC-PE 上寫了 router ospf 1，結果兩家公司的 OSPF 鄰居都起不來。請讓兩家公司都連得到更新伺服器，而且兩家公司之間還是完全隔開。',
    given: [
      ['DC-PE', 'Gi0/0/0（VRF TENANT-A）10.0.1.1/30 ↔ CE-A · Gi0/0/1（VRF TENANT-B）10.0.2.1/30 ↔ CE-B · Gi0/0/2（全域）10.0.99.1/30 ↔ SVC-RT'],
      ['A 公司', '10.1.0.0/16（電腦 10.1.0.50）'], ['B 公司', '10.2.0.0/16（電腦 10.2.0.50）'], ['共用服務', '10.99.0.0/24 · 更新伺服器 10.99.0.10（HTTPS）· SVC-RT 的預設路由指向 DC-PE'],
      ['規定', '客戶的 CE 不可以手動加靜態路由；只洩漏共用服務這個網段'],
    ],
    learn: [
      { t: '每個 VRF 自己的 OSPF 程序', d: 'router ospf 1 只屬於全域的路由表：VRF 裡的介面就算 IP 落在 network 敘述的範圍裡，也不會被涵蓋。每個 VRF 要有自己的程序（router ospf 2 vrf TENANT-A），學到的路裝進那個 VRF 的路由表，彼此互不相干。' },
      { t: 'VRF 的名稱只在這台有意義', d: 'CE 不知道自己接到的是 VRF：它照樣用全域的 router ospf 1。兩端只要網段、區域、計時器對得上就是鄰居。' },
      { t: '路由洩漏 (route leaking)', d: 'VRF 預設完全隔離。要讓客戶連到共用服務，就在兩個方向各補一條靜態路由：ip route vrf TENANT-A 10.99.0.0 255.255.255.0 10.0.99.2 global（下一站到全域的路由表找），回程 ip route 10.1.0.0 255.255.0.0 GigabitEthernet0/0/0 10.0.1.2（出口介面在 TENANT-A）。' },
      { t: '讓 CE 也知道', d: '洩漏進 VRF 的靜態路由只在 DC-PE 上。在 VRF 的 OSPF 程序裡 redistribute static subnets，CE 就會學到 O E2 10.99.0.0/24。' },
      { t: '只洩漏需要的', d: '如果把預設路由洩漏進 VRF，A 公司的封包就能經過全域的路由表再進到 B 公司，隔離就破了。也因為回程靠全域的路由表分辨，共用服務的客戶網段不能重疊；真的重疊就要搭配 NAT。正式的做法是 MP-BGP 的 route-target import / export。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'pe', {
          name: 'DC-PE', pos: [0, -5],
          init(d) {
            d.vrfs = { 'TENANT-A': { style: 'def', af4: true, rd: '65000:1' }, 'TENANT-B': { style: 'def', af4: true, rd: '65000:2' } };
            ip4(d, 'Gi0/0/0', '10.0.1.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.2.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.0.99.1', '255.255.255.252');
            d.ifaces.find((i) => i.id === 'Gi0/0/0').vrf = 'TENANT-A';
            d.ifaces.find((i) => i.id === 'Gi0/0/1').vrf = 'TENANT-B';
            // 前任工程師的設定：一條 network 想涵蓋全部（實際上只涵蓋全域的 Gi0/0/2）
            ospf(d, ['10.0.0.0/8', 0]);
          },
        }),
        D('isr4321', 'cea', {
          name: 'A 公司 CE-A', pos: [-8, 0],
          init(d) { ip4(d, 'Gi0/0/0', '10.0.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.1.0.1', '255.255.0.0'); ospf(d, ['10.0.1.0/30', 0], ['10.1.0.0/16', 0]); d.ospfPassive = ['Gi0/0/1']; },
        }),
        D('isr4321', 'ceb', {
          name: 'B 公司 CE-B', pos: [8, 0],
          init(d) { ip4(d, 'Gi0/0/0', '10.0.2.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.2.0.1', '255.255.0.0'); ospf(d, ['10.0.2.0/30', 0], ['10.2.0.0/16', 0]); d.ospfPassive = ['Gi0/0/1']; },
        }),
        D('isr4321', 'svc', {
          name: 'SVC-RT（共用服務）', pos: [0, -11],
          init(d) { ip4(d, 'Gi0/0/0', '10.0.99.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.99.0.1'); ospf(d, ['10.0.99.0/30', 0], ['10.99.0.0/24', 0]); d.ospfPassive = ['Gi0/0/1']; d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.0.99.1' }); },
        }),
        D('tower', 'upd', { name: '更新伺服器', pos: [7, -11], ip: '10.99.0.10', gw: '10.99.0.1', services: WEB }),
        D('pc', 'apc', { name: 'A 公司的電腦', pos: [-8, 6], ip: '10.1.0.50', mask: '255.255.0.0', gw: '10.1.0.1' }),
        D('pc', 'bpc', { name: 'B 公司的電腦', pos: [8, 6], ip: '10.2.0.50', mask: '255.255.0.0', gw: '10.2.0.1' }),
      ], [['pe:Gi0/0/0', 'cea:Gi0/0/0'], ['pe:Gi0/0/1', 'ceb:Gi0/0/0'], ['pe:Gi0/0/2', 'svc:Gi0/0/0'], ['svc:Gi0/0/1', 'upd:eth0'], ['cea:Gi0/0/1', 'apc:eth0'], ['ceb:Gi0/0/1', 'bpc:eth0']]);
      recompute(s);
      saveAll(s, ['pe', 'cea', 'ceb', 'svc']);
      return s;
    },
    objectives: [
      {
        type: 'check', label: 'DC-PE 和 CE-A、CE-B 的 OSPF 鄰居都是 FULL（各自在自己的 VRF 裡）',
        test(s) {
          if (!fullWith(s, 'pe', 'cea', 'nbrs@TENANT-A')) return fullWith(s, 'pe', 'cea') ? 'CE-A 是全域程序的鄰居？介面應該在 VRF TENANT-A 裡' : 'DC-PE 和 CE-A 不是 OSPF 鄰居：VRF TENANT-A 的介面沒有被任何 OSPF 程序涵蓋（router ospf 1 只看全域的介面）';
          if (!fullWith(s, 'pe', 'ceb', 'nbrs@TENANT-B')) return 'DC-PE 和 CE-B 不是 OSPF 鄰居：VRF TENANT-B 也要有自己的 OSPF 程序';
          return true;
        },
      },
      { type: 'tcp', from: 'apc', to: 'upd', port: 443, label: 'A 公司連得到更新伺服器' },
      { type: 'tcp', from: 'bpc', to: 'upd', port: 443, label: 'B 公司連得到更新伺服器' },
      { type: 'ping', from: 'apc', to: 'bpc', expect: false, label: 'A 公司和 B 公司還是彼此連不到' },
      {
        type: 'check', label: 'CE-A、CE-B 是從 OSPF 學到共用服務的網段（不是手動加的）',
        test(s) {
          for (const id of ['cea', 'ceb']) {
            const d = dev(s, id);
            if ((d.routes || []).some((r) => r.dst)) return `${d.name} 上有手動加的靜態路由：規定是讓它從 OSPF 學到`;
            const r = d.rt.routes.find((x) => x.net === parseIp('10.99.0.0') && x.bits === 24);
            if (!r || r.type !== 'O') return `${d.name} 沒有從 OSPF 學到 10.99.0.0/24：DC-PE 上洩漏進 VRF 的靜態路由，要在那個 VRF 的 OSPF 程序裡 redistribute static`;
          }
          return true;
        },
      },
    ],
    hints: [
      'DC-PE：show ip ospf neighbor 只有 SVC-RT；show ip ospf interface brief 只列出 Gi0/0/2。router ospf 1 是全域路由表的程序，VRF 裡的介面就算落在 network 10.0.0.0 0.255.255.255 的範圍裡也不會被涵蓋。',
      '每個 VRF 要有自己的程序：router ospf 2 vrf TENANT-A → network 10.0.1.0 0.0.0.3 area 0；router ospf 3 vrf TENANT-B → network 10.0.2.0 0.0.0.3 area 0。show ip route vrf TENANT-A 會出現 O 10.1.0.0/16。（「路由」分頁的 OSPF 卡片也可以建立 VRF 的程序）',
      '洩漏共用服務：ip route vrf TENANT-A 10.99.0.0 255.255.255.0 10.0.99.2 global（下一站在全域找）；回程 ip route 10.1.0.0 255.255.0.0 GigabitEthernet0/0/0 10.0.1.2（出口介面在 VRF TENANT-A）。B 公司照做（10.2.0.0/16、Gi0/0/1、10.0.2.2）。',
      'CE-A 還不知道 10.99.0.0/24：在 router ospf 2 vrf TENANT-A 與 router ospf 3 vrf TENANT-B 底下 redistribute static subnets。不要洩漏預設路由，不然 A 公司可以經過全域的路由表連到 B 公司。',
    ],
    solve(s) {
      typeIn(s, 'pe', ['configure terminal',
        'router ospf 2 vrf TENANT-A', 'network 10.0.1.0 0.0.0.3 area 0', 'redistribute static subnets', 'exit',
        'router ospf 3 vrf TENANT-B', 'network 10.0.2.0 0.0.0.3 area 0', 'redistribute static subnets', 'exit',
        'ip route vrf TENANT-A 10.99.0.0 255.255.255.0 10.0.99.2 global', 'ip route vrf TENANT-B 10.99.0.0 255.255.255.0 10.0.99.2 global',
        'ip route 10.1.0.0 255.255.0.0 GigabitEthernet0/0/0 10.0.1.2', 'ip route 10.2.0.0 255.255.0.0 GigabitEthernet0/0/1 10.0.2.2', 'end', 'write memory']);
    },
    recap: ['VRF 裡的介面要由 router ospf <pid> vrf <名稱> 涵蓋，學到的路只進那個 VRF 的路由表。', 'VRF 之間的路由洩漏：兩個方向各一條靜態路由（global、或出口介面在另一個 VRF），再重分配給客戶；只洩漏需要的網段。'],
  },
];
void kv;
