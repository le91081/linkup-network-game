// 備援進階：IP SLA 追蹤業者內部故障（第 7 章）、HSRP 追蹤上行（第 8 章）
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { settle, advance, runObjective } from '../engine/sim.js';
import { dev, ifc } from './util.js';

const ISP_A = '203.0.113.1', ISP_B = '198.51.100.1';
/** 目前生效的預設路由（最長相符一樣時看管理距離） */
const dflt = (s) => (dev(s, 'rt').rt.routes || []).filter((r) => r.bits === 0 && !r.bad).sort((a, b) => a.ad - b.ad)[0];
/** 主要預設路由（往 ISP-A 的那一條靜態路由） */
const primary = (s) => dev(s, 'rt').routes.find((r) => parseIp(r.dst) === 0 && parseIp(r.via || '') === parseIp(ISP_A));

export const LEVELS13 = [
  {
    id: 'l63', chapter: 7, title: '線路燈還亮著', subtitle: 'IP SLA 與追蹤的靜態路由', tags: ['IP SLA', 'Object Tracking', '浮動靜態路由'], noDrill: true,
    brief: 'ISP-A 的機房又出事了：光纖燈號正常、路由器的 Gi0/0/0 也是 up，可是封包出了門就石沉大海。上次做的浮動靜態路由完全沒有反應，因為它只看介面有沒有斷線。請讓路由器定期確認 ISP-A 真的通，不通就自動改走 ISP-B，修好了再自己切回來。',
    given: [
      ['ISP-A（主要）', `閘道 ${ISP_A} · 目前骨幹故障中`], ['ISP-B（備援）', `閘道 ${ISP_B} · 浮動靜態路由 AD 10（已完成）`],
      ['探測目標', '1.1.1.1（只拿來探測；員工的 DNS 是 8.8.8.8）'], ['探測頻率', '10 秒'],
    ],
    learn: [
      { t: '介面 up 不等於網路通', d: '浮動靜態路由只在介面 down 時接手。業者內部故障、對方設備當機、上游的路由出錯，路由器的介面都還是 up，主要路由也就一直留在路由表裡。' },
      { t: 'IP SLA', d: '路由器自己定期送 ping 到遠端的目標：ip sla 1 → icmp-echo 1.1.1.1 source-interface Gi0/0/0 → frequency 10，最後 ip sla schedule 1 life forever start-time now 才會開始（沒寫 start-time now 會一直停在 pending）。' },
      { t: 'track 與靜態路由', d: 'track 1 ip sla 1 reachability 把探測結果變成 Up / Down；ip route 0.0.0.0 0.0.0.0 203.0.113.1 track 1 讓這條路由在 Down 時撤掉，AD 10 的備援路由就浮上來。網路變了要等下一次探測才知道，所以切換最多慢一個頻率的時間。' },
      { t: '探測自己也要走對的路', d: '主要路由撤掉之後，探測封包也照著路由表改走 ISP-B。如果從 ISP-B 探測是通的，主要路由又會回來，然後再失敗……來回跳。加一條不追蹤的主機路由 ip route 1.1.1.1 255.255.255.255 203.0.113.1，探測就永遠走 ISP-A。' },
      { t: '不要拿員工在用的位址當探測目標', d: '那條主機路由會把往探測目標的流量全部綁在 ISP-A。如果目標是大家的 DNS（8.8.8.8），ISP-A 一故障 DNS 也跟著不能用。' },
    ],
    setup: () => {
      const s = makeState([
        setLine(D('internet', 'isp-a', { name: 'ISP-A 光纖', pos: [-6, -9.5] }), 'line1', { type: 'static', gw: ISP_A, mask: '255.255.255.252', assign: '203.0.113.2' }),
        setLine(D('internet', 'isp-b', { name: 'ISP-B 備援', pos: [6, -9.5] }), 'line1', { type: 'static', gw: ISP_B, mask: '255.255.255.252', assign: '198.51.100.2' }),
        D('isr4331', 'rt', {
          name: 'Router', pos: [0, -4.5],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.2', mask: '255.255.255.252', nat: true });
            Object.assign(d.ifaces[1], { ip: '198.51.100.2', mask: '255.255.255.252', nat: true });
            Object.assign(d.ifaces[2], { ip: '192.168.1.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces[2].dhcp, { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '8.8.8.8' });
            d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: ISP_A, ad: '' }, { dst: '0.0.0.0', mask: '0.0.0.0', via: ISP_B, ad: '10' });
          },
        }),
        D('sw5', 'sw', { name: 'Switch', pos: [0, 0] }),
        D('pc', 'pc-1', { name: 'PC-1', pos: [-4.5, 4.5], dhcp: true }),
        D('pc', 'pc-2', { name: 'PC-2', pos: [4.5, 4.5], dhcp: true }),
      ], [['isp-a:line1', 'rt:Gi0/0/0'], ['isp-b:line1', 'rt:Gi0/0/1'], ['rt:Gi0/0/2', 'sw:1'], ['pc-1:eth0', 'sw:2'], ['pc-2:eth0', 'sw:3']]);
      dev(s, 'isp-a').inet.fault = true; // 故障進行中（ISP-A 的設定頁可以切換，用來測試）
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc-1', ip: '8.8.8.8', label: 'ISP-A 骨幹故障中，PC-1 還是可以上網' },
      { type: 'tcp', from: 'pc-2', name: 'www.example.com', port: 443, label: 'PC-2 可以開啟 https://www.example.com' },
      {
        type: 'check', label: '往 ISP-A 的預設路由由 IP SLA 追蹤',
        test(s) {
          const r = primary(s), d = dev(s, 'rt');
          if (!r) return `找不到往 ${ISP_A} 的預設路由`;
          if (r.track == null || r.track === '') return `往 ${ISP_A} 的預設路由還沒有綁 track（ip route 0.0.0.0 0.0.0.0 ${ISP_A} track <物件>）`;
          const t = (d.track || {})[r.track];
          if (!t) return `預設路由綁的 track ${r.track} 不存在`;
          if (t.type !== 'sla') return `track ${r.track} 追蹤的是介面：介面 up 的業者內部故障一樣偵測不到，要改成 IP SLA`;
          const op = (d.sla || {})[t.sla];
          if (!op || !op.dst) return `track ${r.track} 用的 IP SLA ${t.sla} 還沒有設定探測目標`;
          if (!op.sched) return `IP SLA ${t.sla} 還沒有開始探測（ip sla schedule ${t.sla} life forever start-time now）`;
          if (op.dst === '8.8.8.8') return '探測目標是員工的 DNS 8.8.8.8：綁住探測的主機路由會讓 ISP-A 故障時連 DNS 都不通，請改用 1.1.1.1';
          return true;
        },
      },
      {
        type: 'check', label: '連續三次探測都穩定走 ISP-B，不會來回切換',
        test(s) {
          const s2 = cloneState(s);
          settle(s2);
          const r = primary(s2), t = r && (dev(s2, 'rt').track || {})[r.track], op = t && (dev(s2, 'rt').sla || {})[t.sla];
          const f = (op && +op.freq) || 60;
          for (let k = 0; k < 3; k++) {
            advance(s2, f); settle(s2, f);
            const d = dflt(s2);
            if (!d || d.via !== parseIp(ISP_B)) return `第 ${k + 1} 次探測之後預設路由又回到 ISP-A：探測改走 ISP-B 時「成功」了，主要路由跟著回來。替探測目標加一條綁在 ISP-A 的主機路由`;
          }
          return true;
        },
      },
      {
        type: 'check', label: 'ISP-A 修好之後，自動切回 ISP-A',
        test(s) {
          if (!primary(s) || primary(s).track == null || primary(s).track === '') return '主要預設路由還沒有綁 track：還談不上「自動」切換';
          const s2 = cloneState(s);
          delete dev(s2, 'isp-a').inet.fault;
          settle(s2);
          const r = primary(s2), t = r && (dev(s2, 'rt').track || {})[r.track], op = t && (dev(s2, 'rt').sla || {})[t.sla];
          advance(s2, ((op && +op.freq) || 60) + 1); settle(s2);
          const d = dflt(s2);
          if (!d || d.via !== parseIp(ISP_A)) return 'ISP-A 恢復之後，預設路由沒有切回 ISP-A';
          const p = runObjective(s2, { type: 'ping', from: 'pc-1', ip: '8.8.8.8', via: 'isp-a' });
          return p.pass || '切回 ISP-A 之後 PC-1 上不了網：' + p.reason;
        },
      },
    ],
    hints: [
      'Router →「路由」分頁 →「物件追蹤與 IP SLA」：新增 IP SLA，目標 1.1.1.1、來源介面 Gi0/0/0、頻率 10，勾選「開始探測」。',
      '新增追蹤物件（類型 IP SLA，選 ip sla 1）。靜態路由會多出「追蹤」欄：往 203.0.113.1 的那條預設路由填 1。',
      '再新增一條靜態路由 1.1.1.1 / 255.255.255.255 → 203.0.113.1（不要追蹤），讓探測永遠走 ISP-A。網路變了要等下一次探測：按時鐘旁的「收斂中」快轉。',
    ],
    solve(s) {
      const r = dev(s, 'rt');
      r.sla = { 1: { dst: '1.1.1.1', src: 'Gi0/0/0', freq: 10, sched: true, life: 'forever' } };
      r.track = { 1: { type: 'sla', sla: 1 } };
      primary(s).track = 1;
      r.routes.push({ dst: '1.1.1.1', mask: '255.255.255.255', via: ISP_A, ad: '' });
    },
    recap: ['介面狀態只代表「線還在」，IP SLA 才看得出「路通不通」。', '探測的路徑要固定，目標也不要和使用者共用，不然備援自己會變成新的故障。'],
  },
  {
    id: 'l64', chapter: 8, title: '閘道還活著，但出不去', subtitle: 'HSRP 的介面追蹤與 preempt', tags: ['HSRP', 'Object Tracking', 'preempt'],
    brief: '上個月 Edge 和 GW-A 之間的線被施工的人勾斷。GW-A 自己好好的，HSRP 完全沒有切換：全公司的閘道還是 GW-A，封包全部丟在它手上出不去。請讓 GW-A 的上行斷掉時把轉送權交給 GW-B，上行修好之後再拿回來。',
    given: [
      ['虛擬閘道', '10.0.10.1（HSRP 群組 1，已設定）'], ['GW-A', '優先權 110，preempt'], ['GW-B', '優先權 100'],
      ['GW-A 的上行', 'Gi0/0/0 → Edge'], ['LAN 的 OSPF', '被動介面（只宣告網段，不建立鄰居）'],
    ],
    learn: [
      { t: 'HSRP 只看得到 LAN', d: 'HSRP 的 Hello 在 LAN 上交換。只要 GW-A 還活著、LAN 介面還在，它就繼續當 Active，不管自己的上行斷了沒有。' },
      { t: '物件追蹤 (track)', d: 'track 1 interface Gi0/0/0 line-protocol 把上行的狀態變成 Up / Down；standby 1 track 1 decrement 20 讓上行 down 時優先權 110 → 90，比 GW-B 的 100 還低。' },
      { t: 'preempt 兩邊都要', d: 'HSRP 預設不搶轉送權。GW-A 的優先權降下來之後，GW-B 要有 standby 1 preempt 才會接手；GW-A 自己也要 preempt，上行恢復時才會搶回來。VRRP 則預設就會搶。' },
      { t: '為什麼不讓 LAN 也跑 OSPF', d: '如果 GW-A 和 GW-B 在 LAN 上也建立 OSPF 鄰居，上行斷了的 GW-A 可以把封包繞到 GW-B，看起來「也會通」。但使用者的網段上不該有路由協定的鄰居（任何人接上來都能送路由給你），所以實務上會設成被動介面。' },
    ],
    setup: () => {
      const gw = (id, name, pos, up, lan, fhrp) => D('isr4331', id, {
        name, pos,
        init(d) {
          Object.assign(d.ifaces[0], { ip: up, mask: '255.255.255.252', ospf: true });
          Object.assign(d.ifaces[1], { ip: lan, mask: '255.255.255.0', ospf: true, vrrp: { on: true, vip: '10.0.10.1', proto: 'hsrp', ...fhrp } });
          d.ospfPassive = ['Gi0/0/1'];
        },
      });
      return makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -12] }), 'line1', { type: 'static', gw: '203.0.113.65', mask: '255.255.255.252', assign: '203.0.113.66' }),
        D('isr4331', 'edge', {
          name: 'Edge', pos: [0, -7.5],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.66', mask: '255.255.255.252', gateway: '203.0.113.65', nat: true });
            Object.assign(d.ifaces[1], { ip: '10.0.1.1', mask: '255.255.255.252', ospf: true });
            Object.assign(d.ifaces[2], { ip: '10.0.2.1', mask: '255.255.255.252', ospf: true });
            d.ospfDefault = true;
          },
        }),
        gw('gw-a', 'GW-A', [-5.5, -3], '10.0.1.2', '10.0.10.2', { prio: '110', preempt: true }),
        gw('gw-b', 'GW-B', [5.5, -3], '10.0.2.2', '10.0.10.3', { prio: '100' }),
        D('sw8', 'sw', { name: 'Switch', pos: [0, 1.5] }),
        D('pc', 'pc-1', { name: 'PC-1', pos: [-4.5, 6], ip: '10.0.10.21', gw: '10.0.10.1', dns: '8.8.8.8' }),
        D('pc', 'pc-2', { name: 'PC-2', pos: [4.5, 6], ip: '10.0.10.22', gw: '10.0.10.1', dns: '8.8.8.8' }),
      ], [
        ['inet:line1', 'edge:Gi0/0/0'], ['edge:Gi0/0/1', 'gw-a:Gi0/0/0'], ['edge:Gi0/0/2', 'gw-b:Gi0/0/0'],
        ['gw-a:Gi0/0/1', 'sw:1'], ['gw-b:Gi0/0/1', 'sw:2'], ['pc-1:eth0', 'sw:3'], ['pc-2:eth0', 'sw:4'],
      ]);
    },
    objectives: [
      { type: 'ping', from: 'pc-1', ip: '8.8.8.8', via: 'gw-a', label: '平常由 GW-A 轉送' },
      { type: 'failover', cut: [['gw-a', 'Gi0/0/0']], label: 'GW-A 的上行斷掉時，PC-1 仍然可以開網站', test: { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443 } },
      { type: 'failover', cut: [['gw-a', 'Gi0/0/0']], label: 'GW-A 的上行斷掉時，PC-2 仍然可以 ping 到 8.8.8.8', test: { type: 'ping', from: 'pc-2', ip: '8.8.8.8' } },
      {
        type: 'check', label: '上行斷掉時 GW-B 接手，修好之後 GW-A 搶回 Active',
        test(s) {
          const s2 = cloneState(s), c = s2.cables.find((x) => [x.a, x.b].some((e) => e.dev === 'gw-a' && e.port === 'Gi0/0/0'));
          s2.cut = { [c.id]: true }; settle(s2);
          const b = ifc(s2, 'gw-b', 'Gi0/0/1').rt.vrrp;
          if (!b || b.state !== 'master') return 'GW-A 的上行斷掉時，GW-B 沒有成為 Active';
          delete s2.cut; settle(s2);
          const a = ifc(s2, 'gw-a', 'Gi0/0/1').rt.vrrp;
          if (!a || a.state !== 'master') return 'GW-A 的上行恢復了，但沒有搶回 Active（GW-A 的 preempt 還在嗎？）';
          return runObjective(s2, { type: 'ping', from: 'pc-1', ip: '8.8.8.8', via: 'gw-a' }).pass || '恢復之後流量沒有回到 GW-A';
        },
      },
      { type: 'failover', down: ['gw-b'], label: 'GW-B 故障時，PC-2 也不受影響', test: { type: 'ping', from: 'pc-2', ip: '8.8.8.8' } },
    ],
    hints: [
      'GW-A →「路由」分頁 →「物件追蹤與 IP SLA」：新增追蹤物件，類型「介面線路」，選 Gi0/0/0。（CLI：track 1 interface Gi0/0/0 line-protocol）',
      'GW-A →「介面」→ Gi0/0/1 的 HSRP：加入追蹤 track 1，扣 20（110 − 20 = 90，比 GW-B 的 100 低）。（CLI：standby 1 track 1 decrement 20）',
      'GW-B 的 Gi0/0/1 勾選「搶回轉送權 (preempt)」：HSRP 預設不搶，GW-A 的優先權降下來 GW-B 也不會接手。（CLI：standby 1 preempt）',
    ],
    solve(s) {
      dev(s, 'gw-a').track = { 1: { type: 'iface', iface: 'Gi0/0/0' } };
      ifc(s, 'gw-a', 'Gi0/0/1').vrrp.track = [{ obj: 1, dec: 20 }];
      ifc(s, 'gw-b', 'Gi0/0/1').vrrp.preempt = true;
    },
    recap: ['FHRP 只防「閘道本身故障」；上行斷了要靠 track 讓出轉送權。', 'HSRP 的 preempt 預設是關的：追蹤要搭配兩邊的 preempt 才有用。'],
  },
];
