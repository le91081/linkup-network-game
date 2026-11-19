// 第十三章：進階路由。OSPF 的 DR 選舉、cost 與參考頻寬、等價多路徑、多區域與彙總；雙 ISP 的 BGP
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { parseIp, netOf } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { egressOf } from '../engine/qos.js';
import { lookupRoute } from '../engine/sim.js';
import { dev } from './util.js';

export const CHAPTERS7 = [
  { id: 13, title: '進階路由', desc: 'OSPF 的 DR 選舉、cost 與參考頻寬、等價多路徑、多區域與彙總；用 BGP 同時接兩家 ISP。' },
];

const typeIn = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); for (const l of lines) sess.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
/** L3 交換器的 routed port */
const routed = (d, pid, ip, mask, extra = {}) => { d.sw.ports[pid].mode = 'routed'; d.ifaces.push(newIface(pid, (d.ports.find((p) => p.id === pid) || {}).label || pid, { t: 'port', port: pid }, { ip, mask, ...extra })); };
const loop = (d, n, ip) => d.ifaces.push(newIface('Lo' + n, 'Loopback' + n, { t: 'loop', n }, { ip, mask: '255.255.255.255' }));
const net = (s) => { const [a, b] = s.split('/'); return { net: netOf(parseIp(a), +b), bits: +b }; };
const ospf = (d, ...nets) => { d.ospfNets = nets.map(([c, area]) => ({ ...net(c), area })); };
const ospfIf = (s, id, port) => ((dev(s, id).rt.ospf || { ifs: {} }).ifs[port]) || {};
const two = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];

export const LEVELS7 = [
  // ─────────────────────────────────────────────── 13-1
  {
    id: 'l47', chapter: 13, reelect: true, title: '誰當 DR？', subtitle: 'DR / BDR 選舉、Router ID、被動介面', tags: ['OSPF', 'DR / BDR', 'Router ID', 'passive-interface'],
    brief: '總部的三台路由器接在同一台核心交換器上。實驗室那台老路由器 Lab-RT 不知道為什麼當上了 DR，所有 LSA 都要經過它；而且三台路由器都對著使用者的網段送 OSPF Hello。請照公司規定整理好。',
    given: [
      ['核心網段', '10.1.0.0/24（SW-Core）'], ['Router ID 規定', 'Core-1 用 Loopback0 10.255.0.1、Core-2 用 Loopback0 10.255.0.2'],
      ['DR / BDR', 'Core-1 當 DR、Core-2 當 BDR，Lab-RT 永遠不能當'], ['使用者網段', 'Core-1 10.1.10.0/24、Core-2 10.1.20.0/24、Lab-RT 10.1.99.0/24'],
    ],
    learn: [
      { t: 'DR 與 BDR', d: '廣播網段上，每台路由器只和 DR、BDR 建立完整的鄰接 (FULL)，彼此之間停在 2WAY，省掉大量的 LSA 交換。priority 最高的當 DR（相同時比 Router ID），priority 0 永遠不參加。' },
      { t: 'DR 不會被搶', d: 'DR 選出來之後，後來 priority 更高的路由器也搶不走，要等 DR 不在了才會重選（BDR 升上來）。所以改了 priority 之後，通常要在現任 DR / BDR 上 clear ip ospf process 才看得到效果。' },
      { t: 'Router ID', d: 'OSPF 程序啟動時決定：router-id 指令 > 最大的 Loopback 位址 > 最大的實體介面位址。之後換了位址也不會變，要 clear ip ospf process（或重新開機）才會換。' },
      { t: '被動介面', d: 'passive-interface 讓這個介面的網段照樣被通告，但不送 Hello、不會和任何人成為鄰居。接使用者的介面都應該設成被動，避免有人在那裡假冒路由器。' },
    ],
    setup() {
      const rtr = (id, name, n, lanIp, extra) => D(n === 3 ? 'isr4321' : 'isr4331', id, {
        name, pos: [(n - 2) * 8, -3],
        init(d) {
          ip4(d, 'Gi0/0/0', `10.1.0.${n}`); ip4(d, 'Gi0/0/1', lanIp);
          ospf(d, ['10.1.0.0/16', 0]);
          if (extra) extra(d);
        },
      });
      const s = makeState([
        D('c2960', 'sw', { name: 'SW-Core', pos: [0, -8.5] }),
        rtr('c1', 'Core-1', 1, '10.1.10.1'), rtr('c2', 'Core-2', 2, '10.1.20.1'),
        rtr('lab', 'Lab-RT', 3, '10.1.99.1', (d) => { loop(d, 0, '192.168.255.254'); d.ospfNets.push({ ...net('192.168.255.254/32'), area: 0 }); }),
        D('pc', 'pc1', { name: '業務 PC', pos: [-8, 3.5], ip: '10.1.10.10', gw: '10.1.10.1' }),
        D('pc', 'pc2', { name: '研發 PC', pos: [0, 3.5], ip: '10.1.20.10', gw: '10.1.20.1' }),
        D('pc', 'pc3', { name: '實驗室 PC', pos: [8, 3.5], ip: '10.1.99.10', gw: '10.1.99.1' }),
      ], [['c1:Gi0/0/0', 'sw:Gi0/1'], ['c2:Gi0/0/0', 'sw:Gi0/2'], ['lab:Gi0/0/0', 'sw:Gi0/3'], ['pc1:eth0', 'c1:Gi0/0/1'], ['pc2:eth0', 'c2:Gi0/0/1'], ['pc3:eth0', 'lab:Gi0/0/1']]);
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc1', to: 'pc3', label: '業務 PC 連得到實驗室 PC' },
      { type: 'ping', from: 'pc2', to: 'pc1', label: '研發 PC 連得到業務 PC' },
      {
        type: 'check', label: 'Core-1 與 Core-2 的 Router ID 是各自的 Loopback0',
        test(s) {
          for (const [id, want] of [['c1', '10.255.0.1'], ['c2', '10.255.0.2']]) {
            const o = dev(s, id).rt.ospf, w = parseIp(want);
            if (!o) return `${dev(s, id).name} 沒有在跑 OSPF`;
            if (o.rid !== w) return `${dev(s, id).name} 的 Router ID 還不是 ${want}${o.pending || dev(s, id).ifaces.some((i) => i.rt && i.rt.ip === w) ? '（設定好了，但要 clear ip ospf process 才會換）' : ''}`;
          }
          return true;
        },
      },
      {
        type: 'check', label: 'Core-1 是 DR、Core-2 是 BDR，Lab-RT 永遠不當',
        test(s) {
          const r1 = ospfIf(s, 'c1', 'Gi0/0/0').state, r2 = ospfIf(s, 'c2', 'Gi0/0/0').state, lab = dev(s, 'lab').ifaces.find((i) => i.id === 'Gi0/0/0');
          if (!(lab.ospfPrio === 0)) return 'Lab-RT 的 Gi0/0/0 還會參加選舉：ip ospf priority 0';
          if (r1 !== 'DR' || r2 !== 'BDR') return `現在 Core-1 是 ${r1 || '—'}、Core-2 是 ${r2 || '—'}${ospfIf(s, 'lab', 'Gi0/0/0').state === 'DR' || ospfIf(s, 'lab', 'Gi0/0/0').state === 'BDR' ? `、Lab-RT 還是 ${ospfIf(s, 'lab', 'Gi0/0/0').state}（DR 不會被搶，要讓它重新選）` : ''}`;
          return true;
        },
      },
      {
        type: 'check', label: '接使用者的介面是被動介面（不送 Hello，但網段照樣通告）',
        test(s) {
          for (const id of ['c1', 'c2', 'lab']) if (!ospfIf(s, id, 'Gi0/0/1').passive) return `${dev(s, id).name} 的 Gi0/0/1 還在對使用者送 OSPF Hello（passive-interface）`;
          return true;
        },
      },
    ],
    hints: [
      'Core-1：interface loopback0 → ip address 10.255.0.1 255.255.255.255；interface gi0/0/0 → ip ospf priority 100。Core-2 一樣，Loopback 10.255.0.2、priority 50。Lab-RT 的 gi0/0/0 → ip ospf priority 0。',
      '三台的 router ospf 1 → passive-interface gi0/0/1（網段還是會被通告，只是不送 Hello）。',
      'Router ID 和 DR 都不會自己換：在三台上 clear ip ospf process（回答 yes），之後等 Wait timer，就會照新的 priority 重新選。',
    ],
    solve(s) {
      typeIn(s, 'c1', ['configure terminal', 'interface loopback0', 'ip address 10.255.0.1 255.255.255.255', 'interface gi0/0/0', 'ip ospf priority 100', 'router ospf 1', 'network 10.255.0.1 0.0.0.0 area 0', 'passive-interface gi0/0/1', 'end']);
      typeIn(s, 'c2', ['configure terminal', 'interface loopback0', 'ip address 10.255.0.2 255.255.255.255', 'interface gi0/0/0', 'ip ospf priority 50', 'router ospf 1', 'network 10.255.0.2 0.0.0.0 area 0', 'passive-interface gi0/0/1', 'end']);
      typeIn(s, 'lab', ['configure terminal', 'interface gi0/0/0', 'ip ospf priority 0', 'router ospf 1', 'passive-interface gi0/0/1', 'end']);
      for (const id of ['lab', 'c2', 'c1']) typeIn(s, id, ['clear ip ospf process', 'yes']);
    },
    recap: ['DR 是「先上任的就不讓位」：改了 priority 之後要讓現任的重新選。', 'Router ID 用 Loopback 最穩定；換 Router ID 要 clear ip ospf process。', '接使用者的介面設成被動，網段照樣通告。'],
  },

  // ─────────────────────────────────────────────── 13-2
  {
    id: 'l48', chapter: 13, title: '10G 和 1G 一樣快？', subtitle: '參考頻寬、OSPF cost 與等價多路徑', tags: ['OSPF cost', 'reference-bandwidth', 'ECMP'],
    brief: '機房的兩台匯聚交換器之間有一條舊的 1G 線，另外透過兩台 Spine 各有一條 10G 的路。可是伺服器之間的備份只跑到 1G，兩台 Spine 閒著沒事做。請讓流量走 10G，而且兩台 Spine 都要分擔。',
    given: [
      ['DC-1 ↔ DC-2', '直連 1G（Gi1/0/24），經過 Spine-1 或 Spine-2 都是 10G'], ['伺服器', 'SRV-A 10.10.1.10（接 DC-1）、SRV-B 10.10.2.10（接 DC-2）'],
      ['OSPF', 'area 0，交換器之間都是點對點'],
    ],
    learn: [
      { t: 'OSPF 的 cost', d: 'cost = 參考頻寬 ÷ 介面頻寬。IOS 預設的參考頻寬是 100 Mbps，所以 100M、1G、10G、100G 的 cost 全都是 1：OSPF 只會挑「經過最少台」的路，完全分不出快慢。' },
      { t: 'auto-cost reference-bandwidth', d: '把參考頻寬調大（例如 100000 = 100G），1G 的 cost 變成 100、10G 變成 10。整個 OSPF 網域的路由器都要改成一樣，不然大家算出來的路不一致。' },
      { t: '等價多路徑 (ECMP)', d: '兩條 cost 一樣的路，OSPF 兩條都放進路由表（預設最多 4 條）。路由器依來源與目的位址雜湊，不同的連線分散到不同的路；同一條連線永遠走同一條路，不會亂序。' },
    ],
    setup() {
      const sw = (id, name, pos, init) => D('c9300', id, { name, pos, init(d) { d.ospfRefBw = undefined; init(d); } });
      const p2p = { ospfNet: 'p2p' };
      const s = makeState([
        sw('dc1', 'DC-1', [-8, 0], (d) => { routed(d, 'Te1/1/1', '10.0.11.1', '255.255.255.252', p2p); routed(d, 'Te1/1/2', '10.0.12.1', '255.255.255.252', p2p); routed(d, 'Gi1/0/24', '10.0.99.1', '255.255.255.252', p2p); routed(d, 'Te1/1/4', '10.10.1.1', '255.255.255.0'); ospf(d, ['10.0.0.0/8', 0]); }),
        sw('dc2', 'DC-2', [8, 0], (d) => { routed(d, 'Te1/1/1', '10.0.21.1', '255.255.255.252', p2p); routed(d, 'Te1/1/2', '10.0.22.1', '255.255.255.252', p2p); routed(d, 'Gi1/0/24', '10.0.99.2', '255.255.255.252', p2p); routed(d, 'Te1/1/4', '10.10.2.1', '255.255.255.0'); ospf(d, ['10.0.0.0/8', 0]); }),
        sw('sp1', 'Spine-1', [0, -6], (d) => { routed(d, 'Te1/1/1', '10.0.11.2', '255.255.255.252', p2p); routed(d, 'Te1/1/2', '10.0.21.2', '255.255.255.252', p2p); ospf(d, ['10.0.0.0/8', 0]); }),
        sw('sp2', 'Spine-2', [0, 6], (d) => { routed(d, 'Te1/1/1', '10.0.12.2', '255.255.255.252', p2p); routed(d, 'Te1/1/2', '10.0.22.2', '255.255.255.252', p2p); ospf(d, ['10.0.0.0/8', 0]); }),
        D('rack1u', 'sa', { name: 'SRV-A', pos: [-14, 0], ip: '10.10.1.10', gw: '10.10.1.1' }),
        D('rack1u', 'sb', { name: 'SRV-B', pos: [14, 0], ip: '10.10.2.10', gw: '10.10.2.1', services: [{ proto: 'tcp', port: 5201, name: 'iperf3' }, { proto: 'tcp', port: 445, name: 'SMB 備份' }] }),
      ], [['dc1:Te1/1/1', 'sp1:Te1/1/1'], ['dc1:Te1/1/2', 'sp2:Te1/1/1'], ['dc2:Te1/1/1', 'sp1:Te1/1/2'], ['dc2:Te1/1/2', 'sp2:Te1/1/2'], ['dc1:Gi1/0/24', 'dc2:Gi1/0/24'], ['sa:eth0', 'dc1:Te1/1/4'], ['sb:eth0', 'dc2:Te1/1/4']]);
      return s;
    },
    objectives: [
      { type: 'speed', from: 'sa', to: 'sb', port: 5201, min: 5000, label: 'SRV-A 到 SRV-B 的傳輸速率至少 5 Gbps' },
      {
        type: 'check', label: 'DC-1 到 SRV-B 的網段有兩條等價的路（兩台 Spine 都分擔）',
        test(s) {
          const rs = dev(s, 'dc1').rt.routes.filter((r) => r.type === 'O' && r.net === parseIp('10.10.2.0') && r.bits === 24);
          if (!rs.length) return 'DC-1 沒有 SRV-B 網段的 OSPF 路由';
          if (rs.length < 2) return `DC-1 只有一條路（經由 ${rs[0].iface.label}，cost ${rs[0].metric}）`;
          return true;
        },
      },
      {
        type: 'check', label: '四台交換器的參考頻寬一致',
        test(s) {
          const v = ['dc1', 'dc2', 'sp1', 'sp2'].map((id) => +dev(s, id).ospfRefBw || 100);
          if (v.some((x) => x !== v[0])) return `參考頻寬不一致（${['DC-1', 'DC-2', 'Spine-1', 'Spine-2'].map((n, k) => n + ' ' + v[k]).join('、')}）：大家算出來的 cost 不一樣，路可能會繞`;
          return v[0] >= 10000 ? true : `參考頻寬還是 ${v[0]} Mbps：10G 和 1G 的 cost 一樣`;
        },
      },
    ],
    hints: [
      'show ip route 10.10.2.0：DC-1 走的是 Gi1/0/24（1G），因為預設參考頻寬 100 Mbps，1G 和 10G 的 cost 都是 1，直連的那條只要 1。',
      '四台都要：router ospf 1 → auto-cost reference-bandwidth 100000。之後 1G 的 cost 是 100、10G 是 10。',
      '經過 Spine-1 和 Spine-2 都是 10 + 10 = 20，兩條等價，OSPF 會兩條都用（maximum-paths 預設 4）。',
    ],
    solve(s) {
      for (const id of ['dc1', 'dc2', 'sp1', 'sp2']) typeIn(s, id, ['configure terminal', 'router ospf 1', 'auto-cost reference-bandwidth 100000', 'end']);
    },
    recap: ['預設的參考頻寬 (100 Mbps) 分不出 1G 和 10G；整個網域都要改成一樣。', 'cost 一樣的路會同時使用（ECMP），依位址雜湊分散連線。'],
  },

  // ─────────────────────────────────────────────── 13-3
  {
    id: 'l49', chapter: 13, title: '分公司自成一區', subtitle: '多區域 OSPF、ABR 彙總、卡在 EXSTART', tags: ['OSPF 多區域', 'ABR', 'area range', 'MTU'],
    brief: '分公司的路由器已經設成 area 10，可是總部和它們之間的 Dist-RT 還沒改，所以兩邊一直建立不起鄰居。改好之後，總部的路由表要看到分公司「一筆」彙總的路由就好。另外 BR-2 那條線好像有點怪。',
    given: [
      ['骨幹 (area 0)', 'HQ-RT ↔ Dist-RT 10.0.1.0/30，總部網段 10.0.0.0/24'], ['area 10', 'Dist-RT ↔ BR-1 10.10.255.0/30、Dist-RT ↔ BR-2 10.10.255.4/30'],
      ['分公司網段', 'BR-1 10.10.1.0/24、BR-2 10.10.2.0/24 → 彙總成 10.10.0.0/16'],
    ],
    learn: [
      { t: '為什麼要分區', d: 'OSPF 每台路由器都要知道整個區域的拓撲。分成好幾個區域之後，拓撲的變化只在區域裡面重算，其他區域只看到一筆一筆的網段 (Type 3 Summary LSA)。' },
      { t: 'ABR', d: '同時有介面在 area 0 和其他區域的路由器。所有的非骨幹區域都要接到 area 0，區域之間的流量都經過骨幹。' },
      { t: '區域要一致', d: '同一條線的兩端必須在同一個區域，不然 Hello 會被丟掉（mismatched area），鄰居永遠建立不起來。' },
      { t: 'MTU 不一致', d: '兩端的 MTU 不同時，Hello 照樣通，但交換資料庫的 DBD 封包會被丟，鄰居卡在 EXSTART / EXCHANGE。把 MTU 改成一樣，或 ip ospf mtu-ignore。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'hq', { name: 'HQ-RT', pos: [-10, -3], init(d) { ip4(d, 'Gi0/0/0', '10.0.1.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.0.1'); ospf(d, ['10.0.0.0/16', 0]); } }),
        D('isr4331', 'dist', { name: 'Dist-RT', pos: [-2, -3], init(d) { ip4(d, 'Gi0/0/0', '10.0.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.10.255.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.10.255.5', '255.255.255.252'); ospf(d, ['10.0.0.0/8', 0]); } }),
        D('isr4321', 'br1', { name: 'BR-1', pos: [6, -7], init(d) { ip4(d, 'Gi0/0/0', '10.10.255.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.10.1.1'); ospf(d, ['10.10.0.0/16', 10]); } }),
        D('isr4321', 'br2', { name: 'BR-2', pos: [6, 1], init(d) { ip4(d, 'Gi0/0/0', '10.10.255.6', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.10.2.1'); ospf(d, ['10.10.0.0/16', 10]); d.ifaces.find((i) => i.id === 'Gi0/0/0').mtu = 1400; } }),
        D('pc', 'pchq', { name: '總部 PC', pos: [-15, 2], ip: '10.0.0.10', gw: '10.0.0.1' }),
        D('pc', 'pcb1', { name: 'BR-1 的 PC', pos: [13, -7], ip: '10.10.1.10', gw: '10.10.1.1' }),
        D('pc', 'pcb2', { name: 'BR-2 的 PC', pos: [13, 1], ip: '10.10.2.10', gw: '10.10.2.1' }),
      ], [['hq:Gi0/0/0', 'dist:Gi0/0/0'], ['dist:Gi0/0/1', 'br1:Gi0/0/0'], ['dist:Gi0/0/2', 'br2:Gi0/0/0'], ['pchq:eth0', 'hq:Gi0/0/1'], ['pcb1:eth0', 'br1:Gi0/0/1'], ['pcb2:eth0', 'br2:Gi0/0/1']]);
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pchq', to: 'pcb1', label: '總部 PC 連得到 BR-1 的 PC' },
      { type: 'ping', from: 'pchq', to: 'pcb2', label: '總部 PC 連得到 BR-2 的 PC' },
      {
        type: 'check', label: 'HQ-RT 只看到一筆 10.10.0.0/16（O IA），看不到分公司的 /24',
        test(s) {
          const rs = dev(s, 'hq').rt.routes.filter((r) => r.type === 'O' && netOf(r.net, 16) === parseIp('10.10.0.0'));
          if (!rs.length) return 'HQ-RT 還沒有任何分公司的路由';
          if (rs.some((r) => r.bits !== 16)) return `HQ-RT 看到的是 ${[...new Set(rs.map((r) => `${r.bits === 16 ? '' : ''}/${r.bits}`))].join('、')} 的路由：Dist-RT 還沒有彙總（area 10 range 10.10.0.0 255.255.0.0）`;
          return rs[0].sub === 'IA' ? true : '這筆路由不是區域間 (O IA) 的路由';
        },
      },
      { type: 'check', label: 'Dist-RT 是 ABR（area 0 和 area 10 都有介面）', test: (s) => (dev(s, 'dist').rt.ospf && dev(s, 'dist').rt.ospf.abr ? true : 'Dist-RT 的介面還全部在 area 0') },
    ],
    hints: [
      'Dist-RT：router ospf 1 → no network 10.0.0.0 0.255.255.255 area 0 → network 10.0.1.0 0.0.0.3 area 0 → network 10.10.255.0 0.0.0.7 area 10。',
      '同一個 router ospf 底下：area 10 range 10.10.0.0 255.255.0.0。',
      'BR-2 的鄰居卡在 EXSTART：show ip ospf neighbor。BR-2 的 Gi0/0/0 被設了 ip mtu 1400，改回預設（no ip mtu）。',
    ],
    solve(s) {
      typeIn(s, 'dist', ['configure terminal', 'router ospf 1', 'no network 10.0.0.0 0.255.255.255 area 0', 'network 10.0.1.0 0.0.0.3 area 0', 'network 10.10.255.0 0.0.0.7 area 10', 'area 10 range 10.10.0.0 255.255.0.0', 'end']);
      typeIn(s, 'br2', ['configure terminal', 'interface gi0/0/0', 'no ip mtu', 'end']);
    },
    recap: ['同一條線兩端要在同一個區域；ABR 連接骨幹和其他區域。', 'area range 讓骨幹只看到一筆彙總的路由。', '鄰居卡在 EXSTART，先查兩端的 MTU。'],
  },

  // ─────────────────────────────────────────────── 13-4
  {
    id: 'l50', chapter: 13, title: '兩家 ISP 都要用', subtitle: 'eBGP、local-preference、AS-path prepend、不當轉運站', tags: ['BGP', 'eBGP', 'local-preference', 'AS path'],
    brief: '公司有自己的 AS（65010）和網段 192.0.2.0/24，同時接了 ISP-A（AS 64500，1 Gbps）和 ISP-B（AS 64510，200 Mbps 備援）。前任工程師只設定了一半：ISP-B 的鄰居一直建立不起來。請讓兩邊都通，平常進出都走 ISP-A，ISP-A 斷了自動改走 ISP-B，而且公司不能變成兩家 ISP 之間的轉運站。',
    given: [
      ['R1', 'AS 65010 · Gi0/0/0 203.0.113.2/30 → ISP-A 203.0.113.1 · Gi0/0/1 198.51.100.2/30 → ISP-B 198.51.100.1'], ['公司網段', '192.0.2.0/24（網站伺服器 192.0.2.10）'],
      ['ISP-A', 'AS 64500'], ['ISP-B', 'AS 64510'],
    ],
    learn: [
      { t: 'eBGP', d: '不同 AS 之間交換路由用 BGP。鄰居要兩端都設定（neighbor x remote-as y），用 TCP 179 連線，AS 號碼寫錯就停在 Idle。' },
      { t: '出去走哪家：local-preference', d: '同一個目的地從兩家都學得到時，BGP 先比 weight、再比 local-preference（越高越好，預設 100），之後才比 AS path 的長短。在 ISP-A 進來的路由上設高一點的 local-preference，出去就都走 ISP-A。' },
      { t: '進來走哪家：AS-path prepend', d: '別人怎麼走到你，是別人決定的。能做的是讓 ISP-B 那條路看起來比較長：送給 ISP-B 的路由在 AS path 多加幾次自己的 AS，網際網路上的其他人就會偏好從 ISP-A 進來。' },
      { t: '不要變成轉運站', d: '如果把從 ISP-A 學到的路由又送給 ISP-B，ISP-B（偏好客戶給的路由）就會把往 ISP-A 的流量丟給你。送出去的只能有自己的網段：prefix-list，或 as-path access-list 的 ^$。' },
    ],
    setup() {
      const isp = (id, name, pos, asn, custIp, custPeer, coreIp, corePeer, block) => D('internet', id, {
        name, pos, ports: two,
        init(d) {
          d.inet.hosts = []; d.inet.transit = true;
          Object.assign(d.ifaces[0], { ip: custIp, mask: '255.255.255.252' });
          Object.assign(d.ifaces[1], { ip: coreIp, mask: '255.255.255.252' });
          d.inet.bgp = { asn, neighbors: [{ ip: custPeer, remoteAs: 65010, role: 'customer', defOrig: true }, { ip: corePeer, remoteAs: 64999, role: 'peer' }], networks: [net(block)] };
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
            d.inet.bgp = { asn: 64999, neighbors: [{ ip: '203.0.113.9', remoteAs: 64500, role: 'peer' }, { ip: '198.51.100.9', remoteAs: 64510, role: 'peer' }], networks: ['8.8.8.0/24', '1.1.1.0/24', '93.184.216.0/24', '216.239.35.0/24', '168.95.1.0/24'].map(net) };
          },
        }),
        isp('ispa', 'ISP-A（1 Gbps）', [-8, -9], 64500, '203.0.113.1', '203.0.113.2', '203.0.113.9', '203.0.113.10', '203.0.113.0/24'),
        isp('ispb', 'ISP-B（200 Mbps 備援）', [8, -9], 64510, '198.51.100.1', '198.51.100.2', '198.51.100.9', '198.51.100.10', '198.51.100.0/24'),
        D('isr4331', 'r1', {
          name: 'R1', pos: [0, -3.5],
          init(d) {
            ip4(d, 'Gi0/0/0', '203.0.113.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '198.51.100.2', '255.255.255.252'); ip4(d, 'Gi0/0/2', '192.0.2.1');
            d.bgp = { asn: 65010, neighbors: [{ ip: '203.0.113.1', remoteAs: 64500, desc: 'ISP-A' }, { ip: '198.51.100.1', remoteAs: 64501, desc: 'ISP-B' }], networks: [net('192.0.2.0/24')] };
          },
        }),
        D('c9300', 'sw', { name: 'SW', pos: [0, 2] }),
        D('rack1u', 'web', { name: '網站伺服器', pos: [-6, 6], ip: '192.0.2.10', gw: '192.0.2.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS 網站' }] }),
        D('pc', 'pc', { name: '員工 PC', pos: [6, 6], ip: '192.0.2.50', gw: '192.0.2.1', dns: '8.8.8.8' }),
      ], [['net:line1', 'ispa:line2'], ['net:line2', 'ispb:line2'], ['ispa:line1', 'r1:Gi0/0/0'], ['ispb:line1', 'r1:Gi0/0/1'], ['r1:Gi0/0/2', 'sw:Gi1/0/1'], ['web:eth0', 'sw:Te1/1/1'], ['pc:eth0', 'sw:Gi1/0/2']]);
      // 業者的線路：ISP-A 1 Gbps、ISP-B 合約 200 Mbps
      s.cables.find((c) => [c.a.dev, c.b.dev].sort().join() === 'ispb,r1').cir = 200;
      return s;
    },
    objectives: [
      {
        type: 'check', label: '和 ISP-A、ISP-B 的 BGP 鄰居都是 Established',
        test(s) {
          const p = (dev(s, 'r1').rt.bgp || { peers: [] }).peers;
          const bad = p.find((x) => x.state !== 'Established');
          return !p.length ? 'R1 沒有在跑 BGP' : bad ? `${bad.desc || bad.ip}：${bad.state}${bad.why ? '（' + bad.why + '）' : ''}` : true;
        },
      },
      { type: 'tcp', from: 'net', ip: '192.0.2.10', port: 443, label: '網際網路上的使用者連得到公司的網站' },
      {
        type: 'check', label: '出去的流量走 ISP-A',
        test(s) {
          const r = lookupRoute(dev(s, 'r1'), parseIp('8.8.8.8'));
          return r && r.via === parseIp('203.0.113.1') ? true : `R1 往外走的是 ${r ? (r.via === parseIp('198.51.100.1') ? 'ISP-B' : '其他路') : '（沒有路由）'}：兩家都學得到同樣的路由時，提高 ISP-A 那邊的 local-preference`;
        },
      },
      {
        type: 'check', label: '進來的流量也走 ISP-A',
        test(s) {
          const r = lookupRoute(dev(s, 'net'), parseIp('192.0.2.10'));
          if (!r) return '網際網路上沒有公司網段的路由（R1 沒有通告 192.0.2.0/24）';
          return r.via === parseIp('203.0.113.9') ? true : `網際網路從 ISP-B 進來（AS path ${(r.aspath || []).join(' ')}）：送給 ISP-B 的路由要 prepend，讓那條路看起來比較長`;
        },
      },
      {
        type: 'check', label: '公司不是兩家 ISP 之間的轉運站',
        test(s) {
          const r = lookupRoute(dev(s, 'ispb'), parseIp('203.0.113.5'));
          if (r && r.via === parseIp('198.51.100.2')) return 'ISP-B 往 ISP-A 網段的流量會經過公司（R1 把 ISP-A 給的路由送給了 ISP-B）：送出去的只能有自己的網段';
          const r2 = lookupRoute(dev(s, 'ispa'), parseIp('198.51.100.5'));
          if (r2 && r2.via === parseIp('203.0.113.2')) return 'ISP-A 往 ISP-B 網段的流量會經過公司：送給 ISP-A 的也只能有自己的網段';
          return true;
        },
      },
      {
        type: 'failover', label: 'ISP-A 的線斷了，網站照樣連得到（改走 ISP-B）', cut: [['r1', 'Gi0/0/0']],
        test: { type: 'tcp', from: 'net', ip: '192.0.2.10', port: 443 },
      },
    ],
    hints: [
      'show ip bgp summary：198.51.100.1 停在 Idle，ISP-B 的 AS 是 64510，不是 64501。router bgp 65010 → neighbor 198.51.100.1 remote-as 64510。',
      'ip prefix-list OWN permit 192.0.2.0/24；route-map FROM-A permit 10 → set local-preference 200；route-map TO-B permit 10 → match ip address prefix-list OWN → set as-path prepend 65010 65010 65010。',
      'router bgp 65010 → neighbor 203.0.113.1 route-map FROM-A in、neighbor 203.0.113.1 prefix-list OWN out、neighbor 198.51.100.1 route-map TO-B out。（路由器「路由」分頁的 BGP 卡片也可以做同樣的事）',
    ],
    solve(s) {
      typeIn(s, 'r1', ['configure terminal', 'ip prefix-list OWN seq 5 permit 192.0.2.0/24', 'route-map FROM-A permit 10', 'set local-preference 200', 'route-map TO-B permit 10', 'match ip address prefix-list OWN', 'set as-path prepend 65010 65010 65010',
        'router bgp 65010', 'neighbor 198.51.100.1 remote-as 64510', 'neighbor 203.0.113.1 route-map FROM-A in', 'neighbor 203.0.113.1 prefix-list OWN out', 'neighbor 198.51.100.1 route-map TO-B out', 'end', 'write memory']);
    },
    recap: ['BGP 的鄰居兩端都要設定，AS 號碼要對。', '出去走哪家用 local-preference；進來走哪家只能影響別人，例如 AS-path prepend。', '多接幾家 ISP 時，送出去的只能有自己的網段，不然會變成轉運站。'],
  },
];
void egressOf;
