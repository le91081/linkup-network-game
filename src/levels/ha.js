// 第八章補充：BFD 讓 OSPF 一秒內發現鄰居不見了、GLBP 讓兩台閘道一起轉送
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { advance, recompute, settle, transact } from '../engine/sim.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
const ipOf = (s, id) => dev(s, id).ifaces[0].rt.ip;

export const LEVELS24 = [
  // ─────────────────────────────────────────────── BFD
  {
    id: 'l95', chapter: 8, title: '主線斷了，電話斷了四十秒', subtitle: 'BFD：讓 OSPF 一秒內發現鄰居不見了', tags: ['BFD', 'OSPF', 'Dead timer', '備援', '收斂時間'],
    brief: '總公司 HQ-RT 和分公司 BR-RT 之間有兩條路：主線是電信業者的專線（Metro Ethernet，中間經過業者的交換器），備援是走網際網路的 GRE 通道，兩條都跑 OSPF。上週業者在分公司那一端施工切斷了線，總公司的路由器介面燈號卻還亮著：整整四十秒，分公司打回總公司的電話全斷，過了一陣子才自己切到備援。老闆要求：主線不管在哪裡斷掉，兩秒內要切到備援。',
    given: [
      ['HQ-RT', '主線 Gi0/0/2 10.255.9.1/30 · 內網 10.1.0.0/24（電話系統 10.1.0.20）· 備援 Tunnel0 10.255.0.1/30'],
      ['BR-RT', '主線 Gi0/0/2 10.255.9.2/30 · 內網 10.2.0.0/24 · 備援 Tunnel0 10.255.0.2/30'],
      ['電信業者的交換器', '專線中間的設備（你沒有權限）'], ['OSPF', 'area 0；主線 cost 1、Tunnel cost 1000'],
    ],
    learn: [
      { t: '燈號亮著，對面卻不在了', d: '兩台路由器中間只要隔著一台交換器（業者的設備、媒體轉換器），對面那一段斷掉時，這一端的介面還是 up。路由協定只能靠「多久沒聽到對方」來判斷：OSPF 的 Dead timer 預設 40 秒（Hello 10 秒的 4 倍），BGP 的 hold time 180 秒。' },
      { t: 'BFD', d: 'Bidirectional Forwarding Detection：兩台路由器之間每幾十到幾百毫秒互送一個很小的封包，連續幾個沒收到就判定對方失聯，馬上通知 OSPF、BGP、靜態路由。偵測時間 = 間隔 × multiplier，例如 300 毫秒 × 3 = 0.9 秒。' },
      { t: '設定', d: '介面上 bfd interval 300 min_rx 300 multiplier 3；再讓路由協定用它：router ospf 1 底下 bfd all-interfaces（或介面上 ip ospf bfd）、BGP 是 neighbor … fall-over bfd。兩端都要設，BFD session 才會建立（show bfd neighbors）。' },
      { t: '另一種作法', d: 'OSPF 的 fast hello：ip ospf dead-interval minimal hello-multiplier 4（一秒內送 4 個 Hello、Dead timer 1 秒），但 Hello 由路由器的 CPU 處理，介面一多負擔很重；BFD 比較輕、很多平台由硬體處理，而且一次給所有路由協定用。' },
    ],
    setup() {
      const lines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: lines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' });
      setLine(inet, 'line2', { type: 'static', gw: '198.51.100.1', mask: '255.255.255.252', assign: '198.51.100.2' });
      const s = makeState([
        inet, D('isr4331', 'hq', { name: 'HQ-RT', pos: [-7, -4] }), D('isr4331', 'br', { name: 'BR-RT', pos: [7, -4] }),
        D('sw5', 'carrier', { name: '電信業者的交換器', pos: [0, -1], locked: true }),
        D('tower', 'pbx', { name: '電話系統', pos: [-7, 3.5], ip: '10.1.0.20', gw: '10.1.0.1', services: [{ proto: 'udp', port: 5060, name: 'SIP' }, { proto: 'tcp', port: 5060, name: 'SIP（TCP）' }] }),
        D('pc', 'bpc', { name: '分公司的電腦', pos: [7, 3.5], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [['inet:line1', 'hq:Gi0/0/0'], ['inet:line2', 'br:Gi0/0/0'], ['hq:Gi0/0/2', 'carrier:1'], ['carrier:2', 'br:Gi0/0/2'], ['pbx:eth0', 'hq:Gi0/0/1'], ['bpc:eth0', 'br:Gi0/0/1']]);
      recompute(s);
      const side = (id, wan, gw, lan, metro, t4, peer, rid) => typeIn(s, id, ['configure terminal',
        'interface Gi0/0/0', `ip address ${wan} 255.255.255.252`, 'no shutdown', 'interface Gi0/0/1', `ip address ${lan} 255.255.255.0`, 'no shutdown',
        'interface Gi0/0/2', `ip address ${metro} 255.255.255.252`, 'no shutdown', 'exit', `ip route 0.0.0.0 0.0.0.0 ${gw}`,
        'interface Tunnel0', `ip address ${t4} 255.255.255.252`, 'tunnel source Gi0/0/0', `tunnel destination ${peer}`, 'exit',
        'router ospf 1', `router-id ${rid}`, 'network 10.255.9.0 0.0.0.3 area 0', 'network 10.255.0.0 0.0.0.3 area 0', `network ${lan.replace(/\.1$/, '.0')} 0.0.0.255 area 0`, 'end', 'write memory']);
      side('hq', '203.0.113.2', '203.0.113.1', '10.1.0.1', '10.255.9.1', '10.255.0.1', '198.51.100.2', '1.1.1.1');
      side('br', '198.51.100.2', '198.51.100.1', '10.2.0.1', '10.255.9.2', '10.255.0.2', '203.0.113.2', '2.2.2.2');
      return fresh(s);
    },
    objectives: [
      { type: 'udp', from: 'bpc', to: 'pbx', port: 5060, label: '分公司的電話連得到總公司的電話系統' },
      {
        type: 'check', label: '主線在分公司那一端斷掉：兩秒內改走備援，電話照常',
        test(s) {
          const t = cloneState(s);
          settle(t);
          const c = t.cables.find((x) => (x.a.dev === 'carrier' && x.b.dev === 'br') || (x.b.dev === 'carrier' && x.a.dev === 'br'));
          t.cut = { ...(t.cut || {}), [c.id]: true };
          recompute(t);
          advance(t, 2);
          const r = transact(t, 'bpc', { proto: 'udp', dst: ipOf(t, 'pbx'), dport: 5060, quiet: true });
          if (!r.ok) return `斷線 2 秒後還是不通：${r.reason}`;
          return true;
        },
      },
      {
        type: 'check', label: '平常走主線（專線），不是網際網路的通道',
        test(s) {
          const r = transact(s, 'bpc', { proto: 'udp', dst: ipOf(s, 'pbx'), dport: 5060, quiet: true });
          if (!r.ok) return '連不到電話系統：' + r.reason;
          return r.hops.some((h) => h.proto === 'gre') ? '平常就走了網際網路的 GRE 通道：主線應該是 OSPF 的最佳路徑' : true;
        },
      },
    ],
    hints: [
      'HQ-RT：show ip ospf neighbor 的 Dead Time 是 30 幾秒。業者那一端斷掉時，HQ-RT 的 Gi0/0/2 還是 up，只能等 Dead timer 到期才知道 BR-RT 不見了。',
      '兩台的 Gi0/0/2：bfd interval 300 min_rx 300 multiplier 3；router ospf 1 → bfd all-interfaces。show bfd neighbors 看到 Up 就對了。',
      '（另一種作法：兩台的 Gi0/0/2 都 ip ospf dead-interval minimal hello-multiplier 4，Dead timer 變成 1 秒。）',
    ],
    solve(s) {
      for (const id of ['hq', 'br']) typeIn(s, id, ['configure terminal', 'interface Gi0/0/2', 'bfd interval 300 min_rx 300 multiplier 3', 'exit', 'router ospf 1', 'bfd all-interfaces', 'end', 'write memory']);
    },
    recap: ['中間隔著交換器時，對面斷掉這一端的介面還是 up：OSPF 要等 Dead timer（40 秒）。', 'BFD 每幾百毫秒互送一次，一秒內發現對方失聯、通知 OSPF / BGP；兩端都要設，路由協定也要指定用它。'],
  },
  // ─────────────────────────────────────────────── GLBP
  {
    id: 'l96', chapter: 8, title: '兩台閘道，只有一台在做事', subtitle: 'GLBP：一個虛擬 IP、好幾台一起轉送', tags: ['GLBP', 'HSRP', 'FHRP', '負載平衡', '備援'],
    brief: '辦公室的預設閘道是 R1、R2 兩台路由器組成的 HSRP（虛擬 IP 10.10.0.1），各自有一條 100 Mbps 的線路接到總部。現在所有人的流量都擠在 R1 的線路上，R2 那條幾乎沒在用。經理問：花錢買了兩條線，能不能讓兩台都分擔流量？但任何一台壞掉，大家還是要能上線。',
    given: [
      ['R1', 'Gi0/0/1 10.10.0.2/24 · 上行 Gi0/0/0 10.0.1.2/30'], ['R2', 'Gi0/0/1 10.10.0.3/24 · 上行 Gi0/0/0 10.0.2.2/30'],
      ['虛擬閘道', '10.10.0.1（目前是 HSRP group 1，R1 priority 110、preempt）'], ['電腦', 'PC-1 ～ PC-4，預設閘道 10.10.0.1'], ['總部的伺服器', '10.99.0.10（HTTPS）'],
    ],
    learn: [
      { t: 'HSRP / VRRP 只有一台在轉送', d: '同一個群組裡只有 Active（Master）回應虛擬 IP 的 ARP，所有主機的流量都送到它；Standby 只是待命。要分擔流量，傳統作法是開兩個群組、一半主機用 .1、一半用 .254 當閘道 — 主機的設定要分兩批，很麻煩。' },
      { t: 'GLBP', d: 'Gateway Load Balancing Protocol（Cisco）：一個虛擬 IP，最多四台一起轉送。AVG（Active Virtual Gateway，優先權最高的那台）負責回答虛擬 IP 的 ARP，輪流把不同的虛擬 MAC（0007.b400.<群組><編號>）交給不同的主機；每台 AVF（Active Virtual Forwarder）負責轉送送到自己虛擬 MAC 的封包。' },
      { t: '負載分配方式', d: '預設 round-robin：每個來問 ARP 的主機依序拿到下一台 AVF 的 MAC。host-dependent：同一台主機永遠拿到同一個；weighted：依權重分配。主機的設定完全不用改，閘道還是 10.10.0.1。' },
      { t: '壞掉一台', d: '某台 AVF 失聯，其他 AVF 會接手它的虛擬 MAC（大約 10 秒的 holdtime），主機的 ARP 快取不用改；AVG 壞掉則由優先權次高的接手 AVG。和 HSRP 一樣，preempt 預設是關的。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'r0', { name: '總部路由器', host: 'HQ-RT', pos: [0, -8] }),
        D('isr4331', 'r1', { name: 'R1', pos: [-5, -4] }), D('isr4331', 'r2', { name: 'R2', pos: [5, -4] }),
        D('sw8', 'sw', { name: 'SW-Office', pos: [0, 0] }),
        D('tower', 'srv', { name: '總部的伺服器', pos: [7, -8], ip: '10.99.0.10', gw: '10.99.0.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }] }),
        ...[1, 2, 3, 4].map((n) => D('pc', 'pc' + n, { name: 'PC-' + n, pos: [-7.5 + (n - 1) * 5, 5], ip: '10.10.0.' + (10 + n), gw: '10.10.0.1' })),
      ], [['r0:Gi0/0/0', 'r1:Gi0/0/0'], ['r0:Gi0/0/1', 'r2:Gi0/0/0'], ['r0:Gi0/0/2', 'srv:eth0'], ['r1:Gi0/0/1', 'sw:1'], ['r2:Gi0/0/1', 'sw:2'],
        ...[1, 2, 3, 4].map((n) => ['pc' + n + ':eth0', 'sw:' + (2 + n)])]);
      recompute(s);
      typeIn(s, 'r0', ['configure terminal', 'interface Gi0/0/0', 'ip address 10.0.1.1 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.0.2.1 255.255.255.252', 'no shutdown',
        'interface Gi0/0/2', 'ip address 10.99.0.1 255.255.255.0', 'no shutdown', 'exit', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end', 'write memory']);
      for (const [id, ip, up, prio] of [['r1', '10.10.0.2', '10.0.1.2', 110], ['r2', '10.10.0.3', '10.0.2.2', 100]]) {
        typeIn(s, id, ['configure terminal', 'interface Gi0/0/0', `ip address ${up} 255.255.255.252`, 'no shutdown', 'interface Gi0/0/1', `ip address ${ip} 255.255.255.0`, 'no shutdown',
          'standby 1 ip 10.10.0.1', `standby 1 priority ${prio}`, 'standby 1 preempt', 'exit', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end', 'write memory']);
      }
      return fresh(s);
    },
    objectives: [
      {
        type: 'check', label: '兩台路由器都在轉送辦公室的流量（有些電腦經過 R1、有些經過 R2）',
        test(s) {
          const via = {};
          for (const n of [1, 2, 3, 4]) {
            const r = transact(s, 'pc' + n, { proto: 'tcp', dst: ipOf(s, 'srv'), dport: 443, quiet: true });
            if (!r.ok) return `PC-${n} 連不到總部的伺服器：${r.reason}`;
            const hop = r.l3.find((h) => h.dev === 'r1' || h.dev === 'r2');
            via['PC-' + n] = hop ? hop.dev.toUpperCase() : '?';
          }
          const used = new Set(Object.values(via));
          return used.has('R1') && used.has('R2') ? true : `所有電腦都經過 ${[...used].join('、')}（${Object.entries(via).map(([k, v]) => `${k} → ${v}`).join('，')}）`;
        },
      },
      { type: 'failover', down: ['r1'], label: 'R1 壞掉：大家照樣連得到總部（R2 接手）', test: { type: 'tcp', from: 'pc1', to: 'srv', port: 443 } },
      { type: 'failover', down: ['r2'], label: 'R2 壞掉：大家照樣連得到總部（R1 接手）', test: { type: 'tcp', from: 'pc2', to: 'srv', port: 443 } },
    ],
    hints: [
      'R1：show standby brief，R1 是 Active、R2 是 Standby — HSRP 同一個群組只有 Active 在轉送。PC 的 ip neigh：10.10.0.1 的 MAC 是 00:00:0c:07:ac:01（HSRP 的虛擬 MAC）。',
      '改用 GLBP（兩台都要）：interface Gi0/0/1 → no standby 1 → glbp 1 ip 10.10.0.1 → glbp 1 preempt；R1 再加 glbp 1 priority 110 讓它當 AVG。',
      '改完之後 PC 的 ARP 快取還記著舊的 HSRP 虛擬 MAC：sudo ip neigh flush all 清掉，或等它過期。show glbp brief 看得到兩台各負責一個虛擬 MAC（Fwd 1、Fwd 2）。',
    ],
    solve(s) {
      for (const [id, prio] of [['r1', 110], ['r2', 100]]) typeIn(s, id, ['configure terminal', 'interface Gi0/0/1', 'no standby 1', 'glbp 1 ip 10.10.0.1', ...(prio !== 100 ? [`glbp 1 priority ${prio}`] : []), 'glbp 1 preempt', 'end', 'write memory']);
      for (const n of [1, 2, 3, 4]) if (s.dyn && s.dyn.arp) delete s.dyn.arp['pc' + n];
    },
    recap: ['HSRP / VRRP 一個群組只有一台在轉送；GLBP 一個虛擬 IP、最多四台一起轉送，主機的設定不用改。', 'GLBP 的 AVG 回答 ARP、輪流發不同的虛擬 MAC；AVF 壞掉時其他台接手它的虛擬 MAC。'],
  },
];
