// 第十三章補充：路由重分配（靜態路由進 OSPF）與政策路由 (PBR)
import { makeDevice as D, makeState } from '../engine/model.js';
import { parseIp, netOf } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute, transact } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
const net = (c) => { const [a, b] = c.split('/'); return { net: netOf(parseIp(a), +b), bits: +b }; };
const ospf = (d, ...nets) => { d.ospfNets = nets.map(([c, area]) => ({ ...net(c), area })); };
/** 這一筆連線從某台設備的哪個埠出去（看封包實際走的路） */
const outPort = (s, from, ip, port, devId) => {
  const r = transact(s, from, { proto: 'tcp', dst: parseIp(ip), dport: port, quiet: true });
  const h = r.hops.find((x) => x.from === devId && !x.reply && !x.wave);
  return { ok: r.ok, port: h ? h.fromPort : null, reason: r.reason };
};

export const LEVELS19 = [
  // ─────────────────────────────────────────────── 路由重分配
  {
    id: 'l77', chapter: 13, title: '併購的工廠只會靜態路由', subtitle: '路由重分配與 route-map 過濾', tags: ['路由重分配', 'ASBR', 'O E2', 'route-map', 'prefix-list'],
    brief: '公司併購了一家工廠。工廠的路由器很舊、不會跑 OSPF，同事在總公司的邊界路由器 R-Edge 上加了一條往工廠的靜態路由就收工了。結果只有 R-Edge 自己連得到工廠，總公司的使用者都連不到工廠的生產系統。請讓 OSPF 裡的每台路由器都學到工廠的網段，但 R-Edge 上還有一條給實驗室用的靜態路由，那個網段不能讓公司其他人連得到。',
    given: [
      ['OSPF 區域 0', 'R-Edge ↔ Core（10.0.0.0/30）· 使用者 10.1.10.0/24'], ['工廠', '10.50.0.0/16 · 生產系統 10.50.1.10（HTTPS）'],
      ['R-Edge 的靜態路由', 'ip route 10.50.0.0 255.255.0.0 172.31.0.2（工廠）\nip route 192.168.99.0 255.255.255.0 10.0.99.2（實驗室，不能公開）'],
      ['工廠的路由器', 'FAC-RT · 預設路由指向 R-Edge（172.31.0.1）'], ['規定', '其他路由器不可以手動加靜態路由'],
    ],
    learn: [
      { t: '路由重分配', d: '把一種來源的路（直連、靜態、另一個路由協定學到的）放進另一個路由協定裡，讓其他路由器也學到。做這件事的路由器叫 ASBR（Autonomous System Boundary Router）。' },
      { t: 'O E2 與 O E1', d: '重分配進 OSPF 的路是外部路由 (Type-5 LSA)。E2（預設）的 metric 固定不變，不管離 ASBR 多遠；E1 會再加上往 ASBR 的內部 cost，有好幾個出口時比較準。種子 metric：靜態與直連是 20、從 BGP 來的是 1。' },
      { t: '用 route-map 挑', d: 'redistribute static 會把這台所有的靜態路由都送出去（預設路由除外，要用 default-information originate）。用 prefix-list 寫出要送的網段，再用 route-map 的 match ip address prefix-list 只放行它們；沒有符合的就被最後那條隱含的 deny 擋掉。' },
      { t: 'subnets', d: '舊版的 IOS 沒加 subnets 只會重分配主網段（classful，例如 10.0.0.0/8）；IOS XE 會自動補上 subnets。' },
      { t: '雙向重分配要小心', d: '兩個協定在兩個地方互相重分配，路有可能繞回來形成迴圈。實務上會用 route-map 加上 tag 標記「這是我送進去的」，回來的時候擋掉。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'edge', {
          name: 'R-Edge', pos: [0, -5],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.0.0.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.31.0.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.0.99.1');
            ospf(d, ['10.0.0.0/30', 0]);
            d.routes.push({ dst: '10.50.0.0', mask: '255.255.0.0', via: '172.31.0.2' }, { dst: '192.168.99.0', mask: '255.255.255.0', via: '10.0.99.2' });
          },
        }),
        D('isr4331', 'core', { name: 'Core', pos: [-7, -1], init(d) { ip4(d, 'Gi0/0/0', '10.0.0.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.1.10.1'); ospf(d, ['10.0.0.0/30', 0], ['10.1.10.0/24', 0]); d.ospfPassive = ['Gi0/0/1']; } }),
        D('sw8', 'sw', { name: 'SW-Users', pos: [-9.5, 3] }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-11, 6.5], ip: '10.1.10.50', gw: '10.1.10.1' }),
        D('isr4321', 'fac', { name: 'FAC-RT', pos: [7.5, -1], init(d) { ip4(d, 'Gi0/0/0', '172.31.0.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.50.1.1'); d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '172.31.0.1' }); } }),
        D('tower', 'mes', { name: '生產系統 MES', pos: [9.5, 4.5], ip: '10.50.1.10', gw: '10.50.1.1', services: WEB }),
        D('isr4321', 'lab', { name: 'Lab-RT', pos: [1.5, 1.5], init(d) { ip4(d, 'Gi0/0/0', '10.0.99.2'); ip4(d, 'Gi0/0/1', '192.168.99.1'); d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.0.99.1' }); } }),
        D('pc', 'labpc', { name: '實驗室電腦', pos: [2.5, 6], ip: '192.168.99.10', gw: '192.168.99.1' }),
      ], [['edge:Gi0/0/0', 'core:Gi0/0/0'], ['edge:Gi0/0/1', 'fac:Gi0/0/0'], ['edge:Gi0/0/2', 'lab:Gi0/0/0'], ['core:Gi0/0/1', 'sw:1'], ['pc:eth0', 'sw:2'], ['fac:Gi0/0/1', 'mes:eth0'], ['lab:Gi0/0/1', 'labpc:eth0']]);
      recompute(s);
      for (const id of ['edge', 'core', 'fac', 'lab']) typeIn(s, id, ['write memory']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'mes', port: 443, label: '使用者打得開工廠的生產系統（https://10.50.1.10）' },
      {
        type: 'check', label: 'Core 是從 OSPF 學到工廠的網段（外部路由 O E1 / O E2，不是手動加的）',
        test(s) {
          const c = dev(s, 'core');
          if ((c.routes || []).some((r) => r.dst && netOf(parseIp(r.dst), 16) === netOf(parseIp('10.50.0.0'), 16))) return 'Core 上有手動加的靜態路由：規定是要讓 OSPF 自己學到，不在每台路由器上各加一條';
          const r = c.rt.routes.find((x) => x.net === parseIp('10.50.0.0') && x.bits === 16);
          if (!r) return 'Core 的路由表裡沒有 10.50.0.0/16';
          return (r.type === 'O' && /^E[12]$/.test(r.sub || '')) || `Core 的 10.50.0.0/16 是 ${r.type} 路由，不是 OSPF 的外部路由`;
        },
      },
      { type: 'ping', from: 'pc', to: 'labpc', expect: false, label: '實驗室的網段不會被送進 OSPF（使用者連不到 192.168.99.0/24）' },
    ],
    hints: [
      'Core 的 CLI：show ip route 裡沒有 10.50.0.0/16。R-Edge 是用靜態路由連到工廠，靜態路由不會自己出現在 OSPF 裡。',
      'R-Edge：router ospf 1 → redistribute static subnets。Core 就會學到 O E2 10.50.0.0/16 [110/20]（R-Edge 變成 ASBR，show ip ospf 看得到）。',
      '可是這樣實驗室的 192.168.99.0/24 也被一起送出去了。先寫一個只有工廠的 prefix-list：ip prefix-list FACTORY seq 5 permit 10.50.0.0/16。',
      'route-map STATIC-TO-OSPF permit 10 → match ip address prefix-list FACTORY → exit → router ospf 1 → redistribute static subnets route-map STATIC-TO-OSPF。在 Core 上 show ip ospf database 只會看到一筆 Type-5。',
    ],
    solve(s) {
      typeIn(s, 'edge', ['configure terminal', 'ip prefix-list FACTORY seq 5 permit 10.50.0.0/16', 'route-map STATIC-TO-OSPF permit 10', 'match ip address prefix-list FACTORY', 'exit',
        'router ospf 1', 'redistribute static subnets route-map STATIC-TO-OSPF', 'end', 'write memory']);
    },
    recap: ['靜態路由要重分配進 OSPF，其他路由器才學得到；做這件事的路由器是 ASBR，學到的是 O E2（或 E1）。', '重分配一定要用 route-map 挑，只送該送的網段。'],
  },

  // ─────────────────────────────────────────────── 政策路由
  {
    id: 'l78', chapter: 13, title: '備份走另一條線', subtitle: '政策路由 (PBR)', tags: ['PBR', 'route-map', 'set ip next-hop', 'ACL'],
    brief: '分公司和總公司之間有兩條線：20 Mbps 的 MPLS 專線（延遲低，給 ERP 和語音用）、500 Mbps 的寬頻（便宜但延遲高）。OSPF 讓所有流量都走專線，結果每天晚上 NAS 備份到總公司時把專線塞爆，ERP 慢到不能用。請讓 NAS 的備份改走寬頻，其他流量照樣走專線。',
    given: [
      ['專線 (MPLS)', 'Branch-RT Gi0/0/0 10.255.1.2 ↔ HQ-RT 10.255.1.1 · 20 Mbps · OSPF cost 10'],
      ['寬頻', 'Branch-RT Gi0/0/1 10.255.2.2 ↔ HQ-RT 10.255.2.1 · 500 Mbps · OSPF cost 100'],
      ['分公司', '10.2.0.0/24 · NAS 10.2.0.20 · 同事的電腦 10.2.0.50'], ['總公司', '10.1.0.0/24 · ERP 10.1.0.10 · 備份伺服器 10.1.0.20（SMB 445）'],
    ],
    learn: [
      { t: '一般的路由只看目的地', d: '路由表只用「目的位址」決定下一站。想讓「某一台主機的某一種流量」走另一條路，路由表做不到，要用政策路由 (Policy-Based Routing)。' },
      { t: '設定的三個步驟', d: '① 用 ACL 選出流量（ip access-list extended BACKUP → permit ip host 10.2.0.20 host 10.1.0.20）② route-map 裡 match ip address BACKUP、set ip next-hop <下一站> ③ 在流量「進來」的介面上 ip policy route-map <名稱>。只影響從那個介面進來的封包；路由器自己送出的封包要用 ip local policy route-map。' },
      { t: 'next-hop 不通的時候', d: 'set ip next-hop 指定的位址不是直連網段、或那個介面斷了，封包就照一般的路由表走。set ip default next-hop 則相反：只有路由表裡沒有更明確的路時才用。' },
      { t: '不對稱路由', d: 'PBR 只改這一個方向。回程的封包照對方的路由表走，可能走另一條線（不對稱）。中間有有狀態的防火牆時會出問題；要對稱就在對面的路由器也做一份。' },
      { t: '怎麼確認', d: 'show route-map 的「Policy routing matches」看有沒有封包被比對到；show ip policy 看哪些介面套用了；traceroute 從 NAS 送看看走哪一條。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'br', {
          name: 'Branch-RT', pos: [6, -4],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.255.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.255.2.2', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.2.0.1');
            ospf(d, ['10.255.1.0/30', 0], ['10.255.2.0/30', 0], ['10.2.0.0/24', 0]); d.ospfPassive = ['Gi0/0/2'];
            d.ifaces.find((i) => i.id === 'Gi0/0/0').ospfCost = 10; d.ifaces.find((i) => i.id === 'Gi0/0/1').ospfCost = 100;
          },
        }),
        D('isr4331', 'hq', {
          name: 'HQ-RT', pos: [-6, -4],
          init(d) {
            ip4(d, 'Gi0/0/0', '10.255.1.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.255.2.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.1.0.1');
            ospf(d, ['10.255.1.0/30', 0], ['10.255.2.0/30', 0], ['10.1.0.0/24', 0]); d.ospfPassive = ['Gi0/0/2'];
            d.ifaces.find((i) => i.id === 'Gi0/0/0').ospfCost = 10; d.ifaces.find((i) => i.id === 'Gi0/0/1').ospfCost = 100;
          },
        }),
        D('sw8', 'bsw', { name: 'BR-Switch', pos: [6, 1] }),
        D('sw8', 'hsw', { name: 'HQ-Switch', pos: [-6, 1] }),
        D('nas', 'nas', { name: 'NAS', pos: [3.5, 5.5], ip: '10.2.0.20', gw: '10.2.0.1' }),
        D('pc', 'pc', { name: '同事的電腦', pos: [8.5, 5.5], ip: '10.2.0.50', gw: '10.2.0.1' }),
        D('tower', 'erp', { name: 'ERP', pos: [-8.5, 5.5], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('tower', 'bk', { name: '備份伺服器', pos: [-3.5, 5.5], ip: '10.1.0.20', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 445, name: 'SMB 備份' }] }),
      ], [['br:Gi0/0/0', 'hq:Gi0/0/0'], ['br:Gi0/0/1', 'hq:Gi0/0/1'], ['br:Gi0/0/2', 'bsw:1'], ['nas:eth0', 'bsw:2'], ['pc:eth0', 'bsw:3'], ['hq:Gi0/0/2', 'hsw:1'], ['erp:eth0', 'hsw:2'], ['bk:eth0', 'hsw:3']]);
      // 營運商的合約頻寬：專線 20 Mbps、寬頻 500 Mbps
      const cab = (port) => s.cables.find((c) => (c.a.dev === 'br' && c.a.port === port) || (c.b.dev === 'br' && c.b.port === port));
      cab('Gi0/0/0').cir = 20; cab('Gi0/0/1').cir = 500;
      recompute(s);
      for (const id of ['br', 'hq']) typeIn(s, id, ['write memory']);
      return s;
    },
    objectives: [
      { type: 'speed', from: 'nas', to: 'bk', port: 445, min: 300, label: 'NAS 備份到總公司跑得到 300 Mbps 以上（走寬頻）' },
      {
        type: 'check', label: '同事的電腦連 ERP 照樣走 MPLS 專線（Branch-RT 的 Gi0/0/0）',
        test(s) {
          const r = outPort(s, 'pc', '10.1.0.10', 443, 'br');
          if (!r.ok) return `同事的電腦連不到 ERP：${r.reason}`;
          return r.port === 'Gi0/0/0' || `往 ERP 的流量從 Branch-RT 的 ${r.port} 出去，不是專線：OSPF 的 cost 不要改，只讓 NAS 的備份改道`;
        },
      },
      {
        type: 'check', label: 'NAS 連 ERP 也照樣走專線（只有備份改道）',
        test(s) {
          const r = outPort(s, 'nas', '10.1.0.10', 443, 'br');
          if (!r.ok) return `NAS 連不到 ERP：${r.reason}`;
          return r.port === 'Gi0/0/0' || 'NAS 往 ERP 的流量也走了寬頻：ACL 只要選「NAS → 備份伺服器」這一種流量';
        },
      },
    ],
    hints: [
      '從 NAS 的終端機 tracert 10.1.0.20：走的是 10.255.1.1（專線）。OSPF 只看目的位址，cost 比較小的專線永遠贏。',
      'Branch-RT：ip access-list extended BACKUP → permit ip host 10.2.0.20 host 10.1.0.20（只選 NAS 到備份伺服器）。',
      'route-map PBR-BACKUP permit 10 → match ip address BACKUP → set ip next-hop 10.255.2.1（寬頻那一端）。',
      '套用在流量「進來」的介面，也就是接分公司 LAN 的 Gi0/0/2：interface gi0/0/2 → ip policy route-map PBR-BACKUP。show route-map 的 Policy routing matches 會開始增加（也可以在「路由」分頁的政策路由卡片設定）。',
    ],
    solve(s) {
      typeIn(s, 'br', ['configure terminal', 'ip access-list extended BACKUP', 'permit ip host 10.2.0.20 host 10.1.0.20', 'exit',
        'route-map PBR-BACKUP permit 10', 'match ip address BACKUP', 'set ip next-hop 10.255.2.1', 'exit',
        'interface gi0/0/2', 'ip policy route-map PBR-BACKUP', 'end', 'write memory']);
    },
    recap: ['路由表只看目的地；要依來源或應用程式選路，用政策路由 (PBR)：ACL 選流量、route-map set ip next-hop、套在進來的介面上。', 'PBR 只改一個方向，回程照對方的路由表走。'],
  },
];
