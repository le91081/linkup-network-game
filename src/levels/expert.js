// 第十九章：進階實作（CCNP 等級）。每一關把幾項技術放在同一張拓撲裡，除了「通」之外還有設計上的要求
// （不能用全網狀、流量要走指定的出口、任何一台壞掉都不能斷…），用 check 目標驗證。
// 設備的設定全部用 CLI 打進去（typeIn），和玩家在 CLI 分頁看到的 running-config 一致。
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { parseIp, netOf } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute, settle, transact } from '../engine/sim.js';
import { dev, WEB } from './util.js';
import { setCapture, captureOf, rspanReach } from '../engine/wire.js';
import { coppRoutingWhy } from '../engine/copp.js';

export const CHAPTERS13 = [
  { id: 19, title: '進階實作', desc: 'CCNP 等級：路由反射器、BGP 的流量工程、EIGRP 與 OSPF 的進階設計、MPLS 的共用服務、園區核心的對齊。除了會通，還要符合設計上的要求。' },
];

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
/** 進設定模式打一串指令，最後存檔 */
const cfg = (s, id, lines) => typeIn(s, id, ['enable', 'configure terminal', ...lines, 'end', 'write memory']);
const net = (c) => { const [a, b] = c.split('/'); return { net: netOf(parseIp(a), +b), bits: +b }; };
const two = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
const ifIp = (name, ip, mask = '255.255.255.252', more = []) => [`interface ${name}`, `ip address ${ip} ${mask}`, ...more, 'exit'];
const lo0 = (ip) => ['interface Loopback0', `ip address ${ip} 255.255.255.255`, 'exit'];
/** 這台的 iBGP 鄰居（執行期）：[{ ip, state, why }] */
const ibgpPeers = (s, id) => (((dev(s, id).rt || {}).bgp || {}).peers || []).filter((p) => p.ibgp);
/** 一家 ISP（玩家不能改）：line1 接客戶、line2 接網際網路，自己的網段裡有一個雲端服務 */
const ispDev = (id, name, pos, asn, cust, custPeer, custAs, up, upPeer, block, svc) => D('internet', id, {
  name, pos, ports: two,
  init(d) {
    d.inet.hosts = [{ ip: svc, name: `${name.split('（')[0]} 的雲端服務`, services: WEB }]; d.inet.transit = true;
    Object.assign(d.ifaces[0], { ip: cust, mask: '255.255.255.252' });
    Object.assign(d.ifaces[1], { ip: up, mask: '255.255.255.252' });
    d.inet.bgp = { asn, neighbors: [{ ip: custPeer, remoteAs: custAs, role: 'customer' }, { ip: upPeer, remoteAs: 64999, role: 'peer' }], networks: [net(block)] };
  },
});
/** 網際網路的核心（AS 64999）：接兩家 ISP */
const inetCore = (pos) => D('internet', 'net', {
  name: '網際網路', pos, ports: two,
  init(d) {
    Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.252' });
    Object.assign(d.ifaces[1], { ip: '198.51.100.10', mask: '255.255.255.252' });
    d.inet.client = '93.184.216.10';
    d.inet.hosts.push({ ip: '93.184.216.10', name: '外部使用者', services: [] });
    d.inet.bgp = { asn: 64999, neighbors: [{ ip: '203.0.113.9', remoteAs: 64500, role: 'peer' }, { ip: '198.51.100.9', remoteAs: 64510, role: 'peer' }], networks: ['8.8.8.0/24', '93.184.216.0/24'].map(net) };
  },
});

// ───────────────────────── 19-1：路由反射器 ─────────────────────────
const RR = { c1: '10.255.0.11', c2: '10.255.0.12' };
const CLIENTS = { ea: '10.255.0.1', eb: '10.255.0.2', d1: '10.255.0.21', d2: '10.255.0.22' };
const ospfAll = ['router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'exit'];
const ibgpTo = (ip, extra = []) => [`neighbor ${ip} remote-as 65010`, `neighbor ${ip} update-source Loopback0`, ...extra.map((x) => `neighbor ${ip} ${x}`)];

/** 在複製出來的狀態上打幾條測試連線，回傳某台主機（接在鏡像目的埠上）擷取到的訊框 */
const spanSeen = (s, host, flows) => {
  const c = cloneState(s); recompute(c);
  setCapture(c, host, true);
  for (const [from, ip, port] of flows) transact(c, from, { proto: 'tcp', dst: parseIp(ip), dport: port });
  return (captureOf(c, host) || { frames: [] }).frames.filter((x) => x.how === 'span');
};

export const LEVELS96 = [
  {
    id: 'l180', chapter: 19, title: '多一台路由器，要多打五條 neighbor', subtitle: 'BGP 路由反射器：client、反射的規則與兩台互為備援', tags: ['BGP', 'iBGP', 'route reflector', 'next-hop-self', 'update-source'],
    brief: '公司（AS 65010）有兩台邊界路由器各接一家 ISP，底下是兩台核心與兩台分配層。跑 BGP 的路由器從三台變成六台，全網狀要 15 條 iBGP，前任工程師決定改用路由反射器：Core-1 當反射器，其他四台只和它建立 iBGP。他只做到一半就離職了：鄰居全部是 Established，使用者卻上不了網。請把它做完，而且要有第二台反射器（Core-2），任何一台核心壞掉都不能斷網。',
    given: [
      ['AS 65010', '邊界：Edge-A Lo0 10.255.0.1、Edge-B Lo0 10.255.0.2 · 核心：Core-1 10.255.0.11、Core-2 10.255.0.12 · 分配層：Dist-1 10.255.0.21、Dist-2 10.255.0.22'],
      ['IGP', 'OSPF area 0：所有的互連網段與 Loopback 都已經通了'],
      ['使用者', 'Dist-1：192.0.2.0/25（PC-1 .50）· Dist-2：192.0.2.128/25（PC-2 .150）'],
      ['ISP', 'Edge-A ↔ ISP-A（AS 64500，雲端服務 203.0.113.80）· Edge-B ↔ ISP-B（AS 64510，雲端服務 198.51.100.80）'],
      ['設計要求', 'Core-1、Core-2 是路由反射器；其他四台只和這兩台建立 iBGP（不要全網狀）'],
    ],
    learn: [
      { t: '為什麼需要路由反射器', d: 'iBGP 學到的路不會再送給別的 iBGP 鄰居（split horizon，因為 AS 裡面 AS path 不會變長，沒辦法靠它防迴圈）。所以 n 台路由器要 n(n−1)/2 條 iBGP：6 台 15 條、20 台 190 條。路由反射器 (RR) 打破這條規則：它可以把 iBGP 學到的路「反射」給別的 iBGP 鄰居，其他路由器只要和 RR 建立鄰居就好。' },
      { t: '反射的規則', d: 'RR 上的鄰居分成 client（neighbor … route-reflector-client）與 non-client。從 client 學到的路：反射給所有 client 與 non-client。從 non-client 學到的路：只反射給 client。從 eBGP 學到的：送給所有人。所以「鄰居都是 Established，卻沒有人被設成 client」時，RR 自己學得到所有的路，卻一條也不會轉給別人。' },
      { t: 'RR 不會改下一站', d: '反射的時候，下一站、local-preference、MED 都原封不動。邊界路由器要自己對 iBGP 鄰居設 next-hop-self，不然底下的路由器拿到的下一站是 ISP 那一端的位址，查不到（inaccessible）就不能用。在 RR 上對 client 設 next-hop-self 沒有用（它只影響 eBGP 學來的路）。' },
      { t: '防迴圈：ORIGINATOR_ID 與 CLUSTER_LIST', d: 'RR 反射時會加上兩個屬性：ORIGINATOR_ID（這條路最早是 AS 裡哪一台送出來的）與 CLUSTER_LIST（經過了哪些 RR）。路由器收到 ORIGINATOR_ID 是自己的路就丟掉；RR 收到 CLUSTER_LIST 裡有自己 cluster-id 的路也丟掉。show ip bgp <網段> 看得到這兩個屬性。' },
      { t: '兩台 RR', d: '只有一台 RR 的話它一壞，全 AS 的 BGP 路由就沒了。正式環境至少兩台：每個 client 同時和兩台 RR 建立鄰居，兩台 RR 之間也互相建立（一般的 iBGP 就好）。client 會從兩台各收到一份一樣的路，選一條當最佳路徑，另一條留著備用。' },
    ],
    setup() {
      const s = makeState([
        inetCore([0, -17]),
        ispDev('ispa', 'ISP-A（AS 64500）', [-8, -13], 64500, '203.0.113.1', '203.0.113.2', 65010, '203.0.113.9', '203.0.113.10', '203.0.113.0/24', '203.0.113.80'),
        ispDev('ispb', 'ISP-B（AS 64510）', [8, -13], 64510, '198.51.100.1', '198.51.100.2', 65010, '198.51.100.9', '198.51.100.10', '198.51.100.0/24', '198.51.100.80'),
        D('isr4331', 'ea', { name: 'Edge-A', pos: [-6, -8] }),
        D('isr4331', 'eb', { name: 'Edge-B', pos: [6, -8] }),
        D('isr4331', 'c1', { name: 'Core-1', pos: [-6, -3] }),
        D('isr4331', 'c2', { name: 'Core-2', pos: [6, -3] }),
        D('isr4331', 'd1', { name: 'Dist-1', pos: [-6, 2] }),
        D('isr4331', 'd2', { name: 'Dist-2', pos: [6, 2] }),
        D('pc', 'pc1', { name: 'PC-1', pos: [-6, 7], ip: '192.0.2.50', mask: '255.255.255.128', gw: '192.0.2.1', dns: '8.8.8.8' }),
        D('pc', 'pc2', { name: 'PC-2', pos: [6, 7], ip: '192.0.2.150', mask: '255.255.255.128', gw: '192.0.2.129', dns: '8.8.8.8' }),
      ], [
        ['net:line1', 'ispa:line2'], ['net:line2', 'ispb:line2'], ['ispa:line1', 'ea:Gi0/0/0'], ['ispb:line1', 'eb:Gi0/0/0'],
        ['ea:Gi0/0/2', 'eb:Gi0/0/2'], ['ea:Gi0/0/1', 'c1:Gi0/0/0'], ['eb:Gi0/0/1', 'c2:Gi0/0/0'], ['c1:Gi0/0/2', 'c2:Gi0/0/2'],
        ['c1:Gi0/0/1', 'd1:Gi0/0/0'], ['c2:Gi0/0/1', 'd2:Gi0/0/0'], ['d1:Gi0/0/2', 'd2:Gi0/0/2'], ['d1:Gi0/0/1', 'pc1:eth0'], ['d2:Gi0/0/1', 'pc2:eth0'],
      ]);
      recompute(s);
      const ebgp = (peer, asn) => [`neighbor ${peer} remote-as ${asn}`, 'network 192.0.2.0 mask 255.255.255.128', 'network 192.0.2.128 mask 255.255.255.128'];
      // 邊界：eBGP 都好了；iBGP 只接到 Core-1。Edge-A 記得 next-hop-self，Edge-B 忘了
      cfg(s, 'ea', [...lo0(CLIENTS.ea), ...ifIp('Gi0/0/0', '203.0.113.2'), ...ifIp('Gi0/0/1', '10.0.1.1'), ...ifIp('Gi0/0/2', '10.0.0.1'), ...ospfAll,
        'router bgp 65010', ...ebgp('203.0.113.1', 64500), ...ibgpTo(RR.c1, ['next-hop-self']), 'exit']);
      cfg(s, 'eb', [...lo0(CLIENTS.eb), ...ifIp('Gi0/0/0', '198.51.100.2'), ...ifIp('Gi0/0/1', '10.0.2.1'), ...ifIp('Gi0/0/2', '10.0.0.2'), ...ospfAll,
        'router bgp 65010', ...ebgp('198.51.100.1', 64510), ...ibgpTo(RR.c1), 'exit']);
      // Core-1：四個鄰居都設了，卻沒有一個是 route-reflector-client
      cfg(s, 'c1', [...lo0(RR.c1), ...ifIp('Gi0/0/0', '10.0.1.2'), ...ifIp('Gi0/0/1', '10.0.4.1'), ...ifIp('Gi0/0/2', '10.0.3.1'), ...ospfAll,
        'router bgp 65010', ...Object.values(CLIENTS).flatMap((ip) => ibgpTo(ip)), 'exit']);
      // Core-2：只有 OSPF，BGP 還沒設
      cfg(s, 'c2', [...lo0(RR.c2), ...ifIp('Gi0/0/0', '10.0.2.2'), ...ifIp('Gi0/0/1', '10.0.5.1'), ...ifIp('Gi0/0/2', '10.0.3.2'), ...ospfAll]);
      const dist = (id, lo, up, upIp, side, sideIp, lan) => cfg(s, id, [...lo0(lo), ...ifIp(up, upIp), ...ifIp(side, sideIp), ...ifIp('Gi0/0/1', lan, '255.255.255.128'),
        'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'network 192.0.2.0 0.0.0.255 area 0', 'passive-interface Gi0/0/1', 'exit',
        'router bgp 65010', ...ibgpTo(RR.c1), 'exit']);
      dist('d1', CLIENTS.d1, 'Gi0/0/0', '10.0.4.2', 'Gi0/0/2', '10.0.6.1', '192.0.2.1');
      dist('d2', CLIENTS.d2, 'Gi0/0/0', '10.0.5.2', 'Gi0/0/2', '10.0.6.2', '192.0.2.129');
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc1', ip: '203.0.113.80', port: 443, label: 'PC-1 連得到 ISP-A 的雲端服務（https://203.0.113.80）' },
      { type: 'tcp', from: 'pc2', ip: '198.51.100.80', port: 443, avoid: 'ispa', label: 'PC-2 連 ISP-B 的雲端服務直接從 Edge-B 出去，不繞 ISP-A' },
      {
        type: 'check', label: '設計符合要求：Core-1、Core-2 是路由反射器，其他四台只和它們建立 iBGP，全部 Established',
        test(s) {
          for (const [id, lo] of Object.entries(CLIENTS)) {
            const d = dev(s, id), p = ibgpPeers(s, id);
            const extra = p.find((x) => !Object.values(RR).includes(x.ip));
            if (extra) return `${d.name} 還有一條往 ${extra.ip} 的 iBGP：改用路由反射器之後，它只需要和 Core-1、Core-2 建立鄰居`;
            for (const [rid, rip] of Object.entries(RR)) {
              const x = p.find((y) => y.ip === rip);
              if (!x) return `${d.name} 沒有往 ${dev(s, rid).name}（${rip}）的 iBGP 鄰居`;
              if (x.state !== 'Established') return `${d.name} 往 ${dev(s, rid).name} 的 iBGP 是 ${x.state}${x.why ? '（' + x.why + '）' : ''}`;
              const n = ((dev(s, rid).bgp || {}).neighbors || []).find((y) => y.ip === lo);
              if (!n || !n.rrClient) return `${dev(s, rid).name} 沒有把 ${d.name}（${lo}）設成 route-reflector-client：它學得到路，卻不會反射給別人`;
            }
          }
          return true;
        },
      },
      { type: 'failover', label: 'Core-1 整台故障，PC-1 照樣連得到 ISP-A 的服務', down: ['c1'], test: { type: 'tcp', from: 'pc1', ip: '203.0.113.80', port: 443 } },
      { type: 'failover', label: 'Core-2 整台故障，PC-2 照樣連得到 ISP-B 的服務', down: ['c2'], test: { type: 'tcp', from: 'pc2', ip: '198.51.100.80', port: 443 } },
    ],
    hints: [
      'Dist-1：show ip bgp summary，鄰居 10.255.0.11 是 Established，可是 PfxRcd 是 0。Core-1：show ip bgp 有 ISP 的路，show running-config | section bgp 裡四個 neighbor 都沒有 route-reflector-client — 從 non-client 學到的路不會反射給 non-client。router bgp 65010 → neighbor 10.255.0.1 route-reflector-client（.2、.21、.22 也要）。',
      'PC-2 往 ISP-B 還是繞路：Dist-2 的 show ip bgp 198.51.100.0，從 Edge-B 來的那一條下一站是 198.51.100.1（ISP 那一端），不在路由表裡，不能用。Edge-B：neighbor 10.255.0.11 next-hop-self。在反射器上設沒有用，反射不會改下一站。',
      'Core-2：router bgp 65010，四台各 neighbor <Loopback> remote-as 65010、update-source Loopback0、route-reflector-client，再加上往 Core-1（10.255.0.11）的一般 iBGP；Core-1 也要補上往 10.255.0.12 的鄰居。',
      '四台 client 各加一組往 10.255.0.12 的鄰居（remote-as 65010、update-source Loopback0），兩台邊界對 Core-2 一樣要 next-hop-self。完成後 show ip bgp 每個網段會有兩條路（兩台反射器各一份）。',
    ],
    solve(s) {
      cfg(s, 'c1', ['router bgp 65010', ...Object.values(CLIENTS).map((ip) => `neighbor ${ip} route-reflector-client`), ...ibgpTo(RR.c2)]);
      cfg(s, 'c2', ['router bgp 65010', ...Object.values(CLIENTS).flatMap((ip) => ibgpTo(ip, ['route-reflector-client'])), ...ibgpTo(RR.c1)]);
      cfg(s, 'ea', ['router bgp 65010', ...ibgpTo(RR.c2, ['next-hop-self'])]);
      cfg(s, 'eb', ['router bgp 65010', `neighbor ${RR.c1} next-hop-self`, ...ibgpTo(RR.c2, ['next-hop-self'])]);
      for (const id of ['d1', 'd2']) cfg(s, id, ['router bgp 65010', ...ibgpTo(RR.c2)]);
    },
    recap: ['路由反射器把 n(n−1)/2 條 iBGP 變成每台兩條：從 client 學到的路反射給所有人，從 non-client 學到的只反射給 client。', '反射不改下一站：邊界路由器自己要 next-hop-self。反射器至少兩台，client 同時接兩台。'],
  },
  {
    id: 'l181', chapter: 19, title: '備援線路比主線還忙', subtitle: 'BGP 流量工程：local-preference 管出去、MED 與 community 管進來', tags: ['BGP', 'local-preference', 'MED', 'community', 'no-export', 'send-community'],
    brief: '公司（AS 65020）向同一家 ISP（AS 64500）租了兩條線：R1 的 1 Gbps 是主線，R2 的 100 Mbps 只是備援。上個月有人「整理」過兩台的 route-map，從那之後下載只剩一百出頭 Mbps，而且資安發現實驗室的網段出現在網際網路的路由表上。請讓進出的流量都走主線（主線斷了才走備援），實驗室的網段只讓 ISP 自己的網路看到。ISP 的三台路由器你不能改。',
    given: [
      ['AS 65020', 'R1 Lo0 10.255.0.1（主線，往 PE1 203.0.113.1）· R2 Lo0 10.255.0.2（備援 100 Mbps，往 PE2 203.0.113.5）· Core Lo0 10.255.0.3 · 三台之間是 iBGP 全網狀'],
      ['網段', '辦公室 192.0.2.0/25（PC .50）· 實驗室 192.0.2.128/25（Core 的 Loopback1 .129）'],
      ['ISP 的說明', '客戶送來的 MED 會被採用；路由帶著 community 64500:80 時，ISP 會把 local-preference 設成 80（當備援）'],
      ['測試', '下載伺服器 93.184.216.34（在網際網路上）· ISP 的 CDN 203.0.113.80（在 ISP 自己的網路裡，接在 PE1）'],
    ],
    learn: [
      { t: '出去的流量：local-preference', d: '出去走哪一條是「自己」決定的：從 ISP 收進來的路由用 route-map … in 設 local-preference，越大越優先（預設 100）。它會跟著 iBGP 傳給 AS 裡的每一台，所以全公司對「哪個出口比較好」的看法一致。weight 也可以，但只在設定的那一台有效，不會傳出去。' },
      { t: '進來的流量：只能「建議」', d: '進來走哪一條是對方決定的，你只能影響它。兩條線接同一個 AS：送出去的路由設 MED（set metric），越小越好。接不同的 AS：MED 不會被拿來比（只比同一個鄰居 AS 來的路），改用 AS-path prepend 把備援那一條的路徑拉長。或是用 ISP 提供的 community，請它替你調 local-preference。' },
      { t: 'community 預設不會送出去', d: 'route-map 裡 set community 只是把標籤貼在路由上；要對鄰居設 neighbor … send-community，標籤才會跟著 UPDATE 送過去。最常見的錯誤就是 route-map 寫好了、鄰居卻沒有 send-community，對方什麼都沒收到。' },
      { t: 'no-export', d: '公認的 community：帶著 no-export 的路由只在收到它的那個 AS 裡流通，不會再送給別的 AS（eBGP 鄰居）。用來「只讓直接相連的 ISP 知道這個網段」。no-advertise 更嚴格：收到的那一台誰都不送。' },
      { t: '怎麼驗證', d: 'show ip bgp <網段> 看每一條路的 local-preference、MED、community 與為什麼被選中；show ip bgp neighbors <IP> advertised-routes 看自己送了什麼出去。改了 route-map 之後 clear ip bgp * soft（這個模擬會自動重新套用）。' },
    ],
    setup() {
      const s = makeState([
        D('internet', 'net', {
          name: '網際網路（AS 64999）', pos: [0, -18], ports: two,
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.252' });
            d.inet.hosts = [{ ip: '93.184.216.34', name: '下載伺服器', services: [...WEB, { proto: 'tcp', port: 5201, name: 'iperf3' }] }];
            d.inet.bgp = { asn: 64999, neighbors: [{ ip: '203.0.113.9', remoteAs: 64500, role: 'peer' }], networks: ['8.8.8.0/24', '93.184.216.0/24'].map(net) };
          },
        }),
        D('isr4331', 'ispp', { name: 'ISP-P', host: 'ISP-P', pos: [0, -13], locked: true, note: 'ISP 的核心路由器（AS 64500），不是你管的' }),
        D('isr4331', 'pe1', { name: 'ISP-PE1', host: 'ISP-PE1', pos: [-7, -9], locked: true, note: 'ISP 的邊界路由器：主線接在這一台' }),
        D('isr4331', 'pe2', { name: 'ISP-PE2', host: 'ISP-PE2', pos: [7, -9], locked: true, note: 'ISP 的邊界路由器：備援線接在這一台' }),
        D('tower', 'cdn', { name: 'ISP 的 CDN', pos: [-12, -5], ip: '203.0.113.80', mask: '255.255.255.192', gw: '203.0.113.65', services: WEB }),
        D('isr4331', 'r1', { name: 'R1（主線 1G）', host: 'R1', pos: [-5, -3.5] }),
        D('isr4331', 'r2', { name: 'R2（備援 100M）', host: 'R2', pos: [5, -3.5] }),
        D('isr4331', 'core', { name: 'Core', pos: [0, 1.5] }),
        D('pc', 'pc', { name: '辦公室 PC', pos: [0, 7], ip: '192.0.2.50', mask: '255.255.255.128', gw: '192.0.2.1', dns: '8.8.8.8' }),
      ], [
        ['net:line1', 'ispp:Gi0/0/2'], ['ispp:Gi0/0/0', 'pe1:Gi0/0/1'], ['ispp:Gi0/0/1', 'pe2:Gi0/0/1'], ['pe1:Gi0/0/2', 'cdn:eth0'],
        ['pe1:Gi0/0/0', 'r1:Gi0/0/0'], ['pe2:Gi0/0/0', 'r2:Gi0/0/0'], ['r1:Gi0/0/2', 'r2:Gi0/0/2'], ['r1:Gi0/0/1', 'core:Gi0/0/0'], ['r2:Gi0/0/1', 'core:Gi0/0/1'], ['core:Gi0/0/2', 'pc:eth0'],
      ]);
      recompute(s);
      // ── ISP（AS 64500）：OSPF + iBGP 全網狀，community 在 AS 裡一路帶著；客戶送來 64500:80 就把 local-preference 降成 80 ──
      const ispIbgp = (ips) => ips.flatMap((ip) => [`neighbor ${ip} remote-as 64500`, `neighbor ${ip} update-source Loopback0`, `neighbor ${ip} next-hop-self`, `neighbor ${ip} send-community`]);
      const ispOspf = ['router ospf 1', 'network 172.31.0.0 0.0.255.255 area 0', 'exit'];
      cfg(s, 'ispp', [...lo0('172.31.255.1'), ...ifIp('Gi0/0/0', '172.31.1.1'), ...ifIp('Gi0/0/1', '172.31.2.1'), ...ifIp('Gi0/0/2', '203.0.113.9'), ...ispOspf,
        'router bgp 64500', 'neighbor 203.0.113.10 remote-as 64999', ...ispIbgp(['172.31.255.11', '172.31.255.12']), 'exit']);
      const pe = (id, lo, up, cust, custPeer, more = []) => cfg(s, id, [...lo0(lo), ...ifIp('Gi0/0/1', up), ...more,
        'ip community-list standard BACKUP permit 64500:80',
        'route-map CUST-IN permit 10', 'match community BACKUP', 'set local-preference 80', 'exit', 'route-map CUST-IN permit 20', 'exit',
        ...ispOspf,
        'router bgp 64500', `neighbor ${custPeer} remote-as 65020`, `neighbor ${custPeer} route-map CUST-IN in`, `neighbor ${custPeer} send-community`,
        ...ispIbgp(['172.31.255.1', lo === '172.31.255.11' ? '172.31.255.12' : '172.31.255.11']), ...cust, 'exit']);
      pe('pe1', '172.31.255.11', '172.31.1.2', ['network 203.0.113.64 mask 255.255.255.192'], '203.0.113.2', [...ifIp('Gi0/0/0', '203.0.113.1'), ...ifIp('Gi0/0/2', '203.0.113.65', '255.255.255.192')]);
      pe('pe2', '172.31.255.12', '172.31.2.2', [], '203.0.113.6', ifIp('Gi0/0/0', '203.0.113.5', '255.255.255.252', ['speed 100', 'duplex full']));
      // ── 公司（AS 65020）──
      const inOspf = ['router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'exit'];
      const mesh = (ips) => ips.flatMap((ip) => [`neighbor ${ip} remote-as 65020`, `neighbor ${ip} update-source Loopback0`, `neighbor ${ip} next-hop-self`]);
      const toIsp = (med) => ['ip prefix-list LAB seq 5 permit 192.0.2.128/25',
        'route-map TO-ISP permit 5', 'match ip address prefix-list LAB', 'set community no-export', `set metric ${med}`, 'exit',
        'route-map TO-ISP permit 10', `set metric ${med}`, 'exit'];
      // R1（主線）：MED 被改成 100；R2（備援）：MED 10，而且收進來的路由 local-preference 200 —— 兩台的設定貼反了。兩台都沒有 send-community
      cfg(s, 'r1', [...lo0('10.255.0.1'), ...ifIp('Gi0/0/0', '203.0.113.2'), ...ifIp('Gi0/0/1', '10.0.1.1'), ...ifIp('Gi0/0/2', '10.0.0.1'), ...inOspf, ...toIsp(100),
        'router bgp 65020', 'neighbor 203.0.113.1 remote-as 64500', 'neighbor 203.0.113.1 route-map TO-ISP out', ...mesh(['10.255.0.2', '10.255.0.3']), 'exit']);
      cfg(s, 'r2', [...lo0('10.255.0.2'), ...ifIp('Gi0/0/0', '203.0.113.6', '255.255.255.252', ['speed 100', 'duplex full']), ...ifIp('Gi0/0/1', '10.0.2.1'), ...ifIp('Gi0/0/2', '10.0.0.2'), ...inOspf, ...toIsp(10),
        'route-map FROM-ISP permit 10', 'set local-preference 200', 'exit',
        'router bgp 65020', 'neighbor 203.0.113.5 remote-as 64500', 'neighbor 203.0.113.5 route-map TO-ISP out', 'neighbor 203.0.113.5 route-map FROM-ISP in', ...mesh(['10.255.0.1', '10.255.0.3']), 'exit']);
      cfg(s, 'core', [...lo0('10.255.0.3'), 'interface Loopback1', 'description LAB', 'ip address 192.0.2.129 255.255.255.128', 'exit',
        ...ifIp('Gi0/0/0', '10.0.1.2'), ...ifIp('Gi0/0/1', '10.0.2.2'), ...ifIp('Gi0/0/2', '192.0.2.1', '255.255.255.128'), ...inOspf,
        'router bgp 65020', 'network 192.0.2.0 mask 255.255.255.128', 'network 192.0.2.128 mask 255.255.255.128',
        ...['10.255.0.1', '10.255.0.2'].flatMap((ip) => [`neighbor ${ip} remote-as 65020`, `neighbor ${ip} update-source Loopback0`]), 'exit']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'speed', from: 'pc', ip: '93.184.216.34', min: 300, bulk: 'down', label: '辦公室 PC 從網際網路下載跑得到 300 Mbps 以上（去回都走 1G 的主線）' },
      {
        type: 'check', label: '從 ISP 進來的流量走主線（PE1 → R1），不走 100 Mbps 的備援',
        test(s) {
          const c = cloneState(s); recompute(c);
          const r = transact(c, 'cdn', { proto: 'icmp', dst: parseIp('192.0.2.50') });
          if (!r.ok) return `ISP 的 CDN ping 不到辦公室 PC：${r.reason}`;
          const via = r.hops.filter((h) => !h.reply && !h.wave && h.proto !== 'arp').map((h) => h.to);
          return via.includes('r2') ? `進來的封包走的是 ${via.map((x) => c.devices[x].name).join(' → ')}：ISP 覺得 R2 那一條比較好（在 ISP-P 上看不到，從自己送出去的 MED 或 community 找原因）` : true;
        },
      },
      {
        type: 'check', label: '實驗室的網段 192.0.2.128/25 只有 ISP 看得到：網際網路的路由表沒有它，ISP 的 CDN 照樣連得到',
        test(s) {
          const has = (id, c) => (((dev(s, id).rt || {}).bgp || {}).table || []).some((r) => r.net === net(c).net && r.bits === net(c).bits);
          if (!has('net', '192.0.2.0/25')) return '網際網路沒有收到辦公室的網段 192.0.2.0/25：只有實驗室的網段要擋，辦公室要照常公告';
          if (has('net', '192.0.2.128/25')) return '網際網路（AS 64999）的 BGP 表裡還有 192.0.2.128/25：ISP 沒有收到 no-export（R1、R2 對 ISP 的鄰居有沒有 send-community？）';
          if (!has('ispp', '192.0.2.128/25')) return 'ISP 自己也沒有 192.0.2.128/25 了：它還是要送給 ISP，只是不讓 ISP 再往外送';
          const c = cloneState(s); recompute(c);
          const r = transact(c, 'cdn', { proto: 'icmp', dst: parseIp('192.0.2.129') });
          return r.ok || `ISP 的 CDN 連不到實驗室（192.0.2.129）：${r.reason}`;
        },
      },
      { type: 'failover', label: '主線斷了，辦公室照樣連得到網際網路（自動改走備援）', cut: [['r1', 'Gi0/0/0']], test: { type: 'tcp', from: 'pc', ip: '93.184.216.34', port: 443 } },
    ],
    hints: [
      '先看出去的方向。Core：show ip bgp 93.184.216.0，兩條路裡被選中的那一條下一站是 10.255.0.2（R2），LocPrf 200。R2 的 show running-config | section route-map：FROM-ISP 把收進來的路由設成 local-preference 200 — 這段應該在 R1。R2：router bgp 65020 → no neighbor 203.0.113.5 route-map FROM-ISP in；R1：建一樣的 route-map，neighbor 203.0.113.1 route-map FROM-ISP in。',
      '再看進來的方向。R1 的 route-map TO-ISP 是 set metric 100，R2 是 set metric 10：MED 越小越好，ISP 當然選 R2。把兩台對調（R1 兩個序號都改成 set metric 10，R2 改成 100）。',
      '實驗室的網段：route-map TO-ISP permit 5 已經 set community no-export，可是 R1、R2 的 show running-config | section bgp 裡，往 ISP 的鄰居沒有 send-community，標籤根本沒有送出去。兩台都加 neighbor <ISP 的位址> send-community。',
      '另一種做法：備援那一台送出去的路由加上 ISP 的 community 64500:80（set community 64500:80，實驗室那一條要寫成 set community 64500:80 no-export），ISP 就會把它的 local-preference 降成 80。兩種都可以，重點是 ISP 要「看得到」你的意思。',
    ],
    solve(s) {
      cfg(s, 'r1', ['route-map TO-ISP permit 5', 'set metric 10', 'exit', 'route-map TO-ISP permit 10', 'set metric 10', 'exit', 'route-map FROM-ISP permit 10', 'set local-preference 200', 'exit',
        'router bgp 65020', 'neighbor 203.0.113.1 route-map FROM-ISP in', 'neighbor 203.0.113.1 send-community']);
      cfg(s, 'r2', ['route-map TO-ISP permit 5', 'set metric 100', 'exit', 'route-map TO-ISP permit 10', 'set metric 100', 'exit',
        'router bgp 65020', 'no neighbor 203.0.113.5 route-map FROM-ISP in', 'neighbor 203.0.113.5 send-community']);
    },
    recap: ['出去的方向自己決定：local-preference 會傳遍整個 AS。進來的方向只能建議：同一個 AS 用 MED，不同的 AS 用 AS-path prepend，或用 ISP 提供的 community。', 'set community 之後還要 neighbor … send-community；no-export 讓路由只留在直接相連的那個 AS。'],
  },
  {
    id: 'l182', chapter: 19, title: '一台更新伺服器，兩家客戶都要用', subtitle: 'MPLS L3VPN 的共用服務 (extranet)：route-target 的匯入與匯出怎麼設計', tags: ['MPLS', 'L3VPN', 'VRF', 'route-target', 'extranet', 'VPNv4'],
    brief: '你在電信業者的維運中心。骨幹上有兩家客戶（A 公司兩個據點、B 公司一個據點），業者另外提供一台「更新伺服器」放在自己的 VRF（SHARED）裡，兩家客戶都付了錢要用。昨天有人為了讓 B 公司連得到伺服器，在 PE2 上「把 route-target 都加一加」。結果 B 公司還是連不到，A 公司和 B 公司卻互相看得到對方的網路了。請改成正確的設計：兩家都連得到更新伺服器，彼此完全隔離。',
    given: [
      ['骨幹', 'PE1 Lo0 10.255.0.1 — P1 — PE2 Lo0 10.255.0.3 · OSPF + LDP + VPNv4（AS 64500）都正常'],
      ['A 公司', 'VRF CUST-A · RD 64500:1 · 台北 10.1.0.0/24（接 PE1）· 台中 10.2.0.0/24（接 PE2）'],
      ['B 公司', 'VRF CUST-B · RD 64500:2 · 高雄 10.3.0.0/24（接 PE2）'],
      ['共用服務', 'VRF SHARED · RD 64500:99 · 更新伺服器 10.99.0.10（接 PE1）'],
      ['RT 的規劃', 'A 公司 64500:1 · B 公司 64500:2 · 共用服務 64500:99'],
    ],
    learn: [
      { t: 'RD 不決定誰看得到誰', d: 'RD 只是把 IPv4 位址變成在 BGP 裡不會重複的 VPNv4 位址（64500:1:10.1.0.0/24）。「這條路要放進哪些 VRF」完全由 route-target 決定：送出去的時候貼上 export 的 RT，每個 VRF 只收進帶著自己 import 清單裡任何一個 RT 的路。一個 VRF 可以匯入、匯出好幾個 RT。' },
      { t: '共用服務的設計', d: '「大家都連得到中間，彼此連不到」：客戶的 VRF 匯出自己的 RT、匯入自己的 RT 加上共用服務的 RT；共用服務的 VRF 匯出自己的 RT、匯入每一家客戶的 RT。客戶 A 的 VRF 從來沒有匯入客戶 B 的 RT，所以 A 的路由表裡沒有 B 的路。' },
      { t: '兩個方向都要有路', d: '連線是雙向的。客戶匯入了共用服務的 RT，只代表「去」的路有了；共用服務的 VRF 沒有匯入這家客戶的 RT，伺服器回應時就沒有路可走。症狀是伺服器收得到請求、回不來。' },
      { t: '為什麼不能重疊', d: '兩家客戶各自的 VPN 裡位址可以一模一樣。但只要匯進同一個 VRF（這裡是 SHARED），位址就不能重疊，不然伺服器不知道回給誰。真的遇到重疊，要在 CE 或 PE 上做 NAT。' },
      { t: '怎麼查', d: 'show vrf detail <名稱> 看 RD 與 import / export 的 RT；show ip route vrf <名稱> 看這個 VRF 收進了哪些路；show bgp vpnv4 unicast all 看每個 RD 底下有哪些路。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'pe1', { name: 'PE1', pos: [-7, -6] }),
        D('isr4331', 'p1', { name: 'P1', pos: [0, -9] }),
        D('isr4331', 'pe2', { name: 'PE2', pos: [7, -6] }),
        D('tower', 'srv', { name: '更新伺服器', pos: [-11, 0], ip: '10.99.0.10', gw: '10.99.0.1', services: WEB }),
        D('pc', 'pca1', { name: 'A 公司（台北）', pos: [-4, 0], ip: '10.1.0.50', gw: '10.1.0.1' }),
        D('pc', 'pca2', { name: 'A 公司（台中）', pos: [4, 0], ip: '10.2.0.50', gw: '10.2.0.1' }),
        D('pc', 'pcb', { name: 'B 公司（高雄）', pos: [11, 0], ip: '10.3.0.50', gw: '10.3.0.1' }),
      ], [
        ['pe1:Gi0/0/0', 'p1:Gi0/0/0'], ['p1:Gi0/0/1', 'pe2:Gi0/0/0'],
        ['pe1:Gi0/0/1', 'srv:eth0'], ['pe1:Gi0/0/2', 'pca1:eth0'], ['pe2:Gi0/0/1', 'pca2:eth0'], ['pe2:Gi0/0/2', 'pcb:eth0'],
      ]);
      recompute(s);
      const vrf = (name, rd, exp, imp) => [`vrf definition ${name}`, `rd ${rd}`, 'address-family ipv4', `route-target export ${exp}`, ...imp.map((x) => `route-target import ${x}`), 'exit-address-family', 'exit'];
      const acc = (port, v, ip) => [`interface ${port}`, `vrf forwarding ${v}`, `ip address ${ip} 255.255.255.0`, 'exit'];
      const core = (lo, ip, peer, vrfs) => [...lo0(lo), 'interface Gi0/0/0', `ip address ${ip} 255.255.255.252`, 'mpls ip', 'exit',
        'router ospf 1', `router-id ${lo}`, 'network 10.0.0.0 0.0.0.255 area 0', `network ${lo} 0.0.0.0 area 0`, 'exit',
        'router bgp 64500', `neighbor ${peer} remote-as 64500`, `neighbor ${peer} update-source Loopback0`, 'address-family vpnv4', `neighbor ${peer} activate`, 'exit-address-family',
        ...vrfs.flatMap((v) => [`address-family ipv4 vrf ${v}`, 'redistribute connected', 'exit-address-family']), 'exit'];
      // PE1：共用服務只匯入了 A 公司（B 公司是後來才簽約的）
      cfg(s, 'pe1', [...vrf('SHARED', '64500:99', '64500:99', ['64500:99', '64500:1']), ...vrf('CUST-A', '64500:1', '64500:1', ['64500:1', '64500:99']),
        ...acc('Gi0/0/1', 'SHARED', '10.99.0.1'), ...acc('Gi0/0/2', 'CUST-A', '10.1.0.1'), ...core('10.255.0.1', '10.0.0.1', '10.255.0.3', ['SHARED', 'CUST-A'])]);
      // PE2：昨天「都加一加」的結果 —— 兩家客戶互相匯入了對方，B 公司反而沒有匯入共用服務
      cfg(s, 'pe2', [...vrf('CUST-A', '64500:1', '64500:1', ['64500:1', '64500:99', '64500:2']), ...vrf('CUST-B', '64500:2', '64500:2', ['64500:2', '64500:1']),
        ...acc('Gi0/0/1', 'CUST-A', '10.2.0.1'), ...acc('Gi0/0/2', 'CUST-B', '10.3.0.1'), ...core('10.255.0.3', '10.0.0.6', '10.255.0.1', ['CUST-A', 'CUST-B'])]);
      cfg(s, 'p1', [...lo0('10.255.0.2'), 'interface Gi0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'mpls ip', 'exit', 'interface Gi0/0/1', 'ip address 10.0.0.5 255.255.255.252', 'mpls ip', 'exit',
        'router ospf 1', 'router-id 10.255.0.2', 'network 10.0.0.0 0.0.0.255 area 0', 'network 10.255.0.2 0.0.0.0 area 0', 'exit']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pca1', to: 'srv', port: 443, label: 'A 公司（台北）連得到更新伺服器' },
      { type: 'tcp', from: 'pca2', to: 'srv', port: 443, label: 'A 公司（台中）連得到更新伺服器' },
      { type: 'tcp', from: 'pcb', to: 'srv', port: 443, label: 'B 公司（高雄）連得到更新伺服器' },
      { type: 'ping', from: 'pca2', to: 'pca1', label: 'A 公司自己的兩個據點照常互通' },
      {
        type: 'check', label: '兩家客戶完全隔離：誰的 VRF 裡都沒有對方的路',
        test(s) {
          const other = { 'CUST-A': ['10.3.0.0'], 'CUST-B': ['10.1.0.0', '10.2.0.0'] };
          for (const id of ['pe1', 'pe2']) {
            const d = dev(s, id);
            for (const [v, nets] of Object.entries(other)) {
              const hit = (d.rt.routes || []).find((r) => r.vrf === v && nets.some((n) => r.net === parseIp(n)));
              if (hit) return `${d.name} 的 VRF ${v} 裡有另一家公司的網段 ${nets.find((n) => hit.net === parseIp(n))}/24（show ip route vrf ${v}）：這個 VRF 匯入了不該匯入的 route-target`;
            }
          }
          const c = cloneState(s); recompute(c);
          for (const [a, ip] of [['pca1', '10.3.0.50'], ['pca2', '10.3.0.50'], ['pcb', '10.1.0.50'], ['pcb', '10.2.0.50']]) {
            if (transact(c, a, { proto: 'icmp', dst: parseIp(ip) }).ok) return `${c.devices[a].name} ping 得到 ${ip}：兩家客戶的網路是通的`;
          }
          return true;
        },
      },
    ],
    hints: [
      'PE2：show vrf detail CUST-B，Import VPN route-target 是 64500:2 與 64500:1 — 匯入了 A 公司的 RT，卻沒有共用服務的 64500:99。vrf definition CUST-B → address-family ipv4 → no route-target import 64500:1、route-target import 64500:99。',
      'PE2 的 CUST-A 也多匯入了 64500:2：no route-target import 64500:2。客戶的 VRF 只匯入「自己的」加上「共用服務的」。',
      'B 公司有了去伺服器的路，還是不通：伺服器回不來。PE1：show ip route vrf SHARED 沒有 10.3.0.0/24。vrf definition SHARED → address-family ipv4 → route-target import 64500:2。',
      '檢查：show ip route vrf CUST-A 只有 10.1、10.2 與 10.99；show ip route vrf CUST-B 只有 10.3 與 10.99；show ip route vrf SHARED 三家的網段都有。',
    ],
    solve(s) {
      cfg(s, 'pe2', ['vrf definition CUST-B', 'address-family ipv4', 'no route-target import 64500:1', 'route-target import 64500:99', 'exit-address-family', 'exit',
        'vrf definition CUST-A', 'address-family ipv4', 'no route-target import 64500:2', 'exit-address-family', 'exit']);
      cfg(s, 'pe1', ['vrf definition SHARED', 'address-family ipv4', 'route-target import 64500:2', 'exit-address-family', 'exit']);
    },
    recap: ['route-target 決定路由進哪個 VRF：客戶匯入「自己 + 共用服務」，共用服務匯入「每一家客戶」，客戶之間從不互相匯入。', '去與回各要一條路：只在一邊匯入，請求到得了、回應回不來。'],
  },
  {
    id: 'l183', chapter: 19, title: '兩台核心各做各的', subtitle: '園區核心的對齊：STP 根橋、HSRP、EtherChannel 與上行追蹤', tags: ['STP', 'HSRP', 'EtherChannel', 'LACP', 'track', 'preempt', '根橋'],
    brief: '新大樓的核心是兩台 Catalyst 9300（DSW-1、DSW-2），兩台樓層交換器各有一條上行接到它們。網路「會通」，但驗收沒過：使用者 VLAN 的流量先繞到 DSW-2 再回 DSW-1 才出去、兩台核心之間的兩條線只有一條在用、DSW-1 的上行一斷整個使用者 VLAN 就斷網。請照設計把它對齊：VLAN 10 以 DSW-1 為主、VLAN 20 以 DSW-2 為主，互為備援。',
    given: [
      ['VLAN 10 USERS', '10.10.10.0/24 · 虛擬閘道 .1 · DSW-1 .2 · DSW-2 .3 · PC-10 .50（接 ASW-1）'],
      ['VLAN 20 RD', '10.10.20.0/24 · 虛擬閘道 .1 · DSW-1 .2 · DSW-2 .3 · PC-20 .50（接 ASW-2）'],
      ['設計', 'VLAN 10：根橋與 HSRP Active 都在 DSW-1 · VLAN 20：都在 DSW-2 · 上行斷了要讓出閘道'],
      ['核心之間', 'Gi1/0/21、Gi1/0/22 組成 Port-channel 1（LACP、Trunk）'],
      ['上行', 'DSW-1 Gi1/0/24 10.0.1.2/30、DSW-2 Gi1/0/24 10.0.2.2/30 → WAN-RT（OSPF area 0）· ERP 10.50.0.10'],
    ],
    learn: [
      { t: '第二層與第三層要對齊', d: 'STP 決定訊框在交換器之間怎麼走（往根橋的方向），HSRP 決定哪一台是閘道。兩個不在同一台時，訊框會先被 STP 帶到根橋，再穿過核心之間的線回到真正的閘道，多繞一段、也把核心之間的線塞滿。每個 VLAN 的根橋和 HSRP Active 要放在同一台。' },
      { t: '依 VLAN 分擔', d: 'Rapid PVST+ 每個 VLAN 一棵樹：spanning-tree vlan 10 root primary（或 priority 4096）讓 DSW-1 當 VLAN 10 的根橋，另一台設 secondary（28672）當備援。HSRP 也是每個 VLAN 一組：standby 10 priority 110 的那一台是 Active。兩個 VLAN 交錯放，兩台核心、兩條上行就都用到了。' },
      { t: 'preempt 與上行追蹤', d: 'HSRP 預設不搶回轉送權，要 standby … preempt。閘道那一台只是「上行斷了」的話它自己還活著，照樣當 Active，封包送到它那裡卻出不去：track 1 interface Gi1/0/24 line-protocol 加上 standby 10 track 1 decrement 20，上行一斷優先權就降到比對方低，對方（要有 preempt）接手。' },
      { t: 'Port-channel 的成員', d: '兩端的每一條成員線都要在同一個 channel-group 裡，而且速率、雙工、Trunk 與允許的 VLAN 都要一樣。只有一端把埠加進去的話，那一條會被停用 (suspended)，Port-channel 只剩一條線在撐，頻寬少一半、也沒有備援。LACP 的 mode active 會主動協商、passive 只回應：兩端都是 passive 就組不起來。' },
      { t: '怎麼驗證', d: 'show spanning-tree vlan 10 看根橋是誰、哪個埠被擋；show standby brief 看每個群組誰是 Active；show etherchannel summary 的成員後面要是 (P)；traceroute 與下方的封包追蹤看實際經過哪幾台。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'wan', { name: 'WAN-RT', pos: [0, -10] }),
        D('tower', 'erp', { name: 'ERP', pos: [8, -10], ip: '10.50.0.10', gw: '10.50.0.1', services: WEB }),
        D('c9300', 'dsw1', { name: 'DSW-1', pos: [-6, -4] }),
        D('c9300', 'dsw2', { name: 'DSW-2', pos: [6, -4] }),
        D('c2960', 'asw1', { name: 'ASW-1', pos: [-6, 2] }),
        D('c2960', 'asw2', { name: 'ASW-2', pos: [6, 2] }),
        D('pc', 'pc10', { name: 'PC-10', pos: [-6, 7], ip: '10.10.10.50', gw: '10.10.10.1' }),
        D('pc', 'pc20', { name: 'PC-20', pos: [6, 7], ip: '10.10.20.50', gw: '10.10.20.1' }),
      ], [
        ['wan:Gi0/0/0', 'dsw1:Gi1/0/24'], ['wan:Gi0/0/1', 'dsw2:Gi1/0/24'], ['wan:Gi0/0/2', 'erp:eth0'],
        ['dsw1:Gi1/0/21', 'dsw2:Gi1/0/21'], ['dsw1:Gi1/0/22', 'dsw2:Gi1/0/22'],
        ['dsw1:Gi1/0/1', 'asw1:Gi0/9'], ['dsw2:Gi1/0/1', 'asw1:Gi0/10'], ['dsw1:Gi1/0/2', 'asw2:Gi0/9'], ['dsw2:Gi1/0/2', 'asw2:Gi0/10'],
        ['asw1:Gi0/1', 'pc10:eth0'], ['asw2:Gi0/1', 'pc20:eth0'],
      ]);
      recompute(s);
      cfg(s, 'wan', [...ifIp('Gi0/0/0', '10.0.1.1'), ...ifIp('Gi0/0/1', '10.0.2.1'), ...ifIp('Gi0/0/2', '10.50.0.1', '255.255.255.0'),
        'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'passive-interface Gi0/0/2', 'exit']);
      const vlans = ['vlan 10', 'name USERS', 'exit', 'vlan 20', 'name RD', 'exit'];
      const trunk = (p) => [`interface ${p}`, 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit'];
      // 兩台核心：cost10 / cost20 是這台在兩個 VLAN 的 OSPF cost（回程要跟去程走同一台）、h10 / h20 是 HSRP 的設定；stp 是根橋的設定；po 是 Port-channel 的成員
      const dsw = (id, n, up, o) => cfg(s, id, ['ip routing', ...vlans, ...o.stp,
        'interface range Gi1/0/21 - 22', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit', ...o.po,
        ...trunk('Gi1/0/1'), ...trunk('Gi1/0/2'),
        'interface Gi1/0/24', 'no switchport', `ip address ${up} 255.255.255.252`, 'exit',
        'interface Vlan10', `ip address 10.10.10.${n} 255.255.255.0`, `ip ospf cost ${o.cost10}`, 'standby 10 ip 10.10.10.1', ...o.h10.map((x) => `standby 10 ${x}`), 'exit',
        'interface Vlan20', `ip address 10.10.20.${n} 255.255.255.0`, `ip ospf cost ${o.cost20}`, 'standby 20 ip 10.10.20.1', ...o.h20.map((x) => `standby 20 ${x}`), 'exit',
        'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'passive-interface Vlan10', 'passive-interface Vlan20', 'exit']);
      // DSW-1：兩個 VLAN 的 HSRP 都是 110（都想當 Active），沒有追蹤上行；STP 沒有設（優先權 32768）；兩條線都進了 Port-channel
      dsw('dsw1', 2, '10.0.1.2', { stp: [], po: ['interface range Gi1/0/21 - 22', 'channel-group 1 mode active', 'exit'], cost10: 10, cost20: 100, h10: ['priority 110', 'preempt'], h20: ['priority 110', 'preempt'] });
      // DSW-2：兩個 VLAN 的根橋都在這裡（priority 4096）；HSRP 用預設的 100、沒有 preempt；Gi1/0/22 忘了加進 Port-channel
      dsw('dsw2', 3, '10.0.2.2', { stp: ['spanning-tree vlan 10,20 priority 4096'], po: ['interface Gi1/0/21', 'channel-group 1 mode active', 'exit'], cost10: 100, cost20: 10, h10: [], h20: [] });
      const asw = (id, vlan) => cfg(s, id, [...vlans, ...trunk('Gi0/9'), ...trunk('Gi0/10'), 'interface Gi0/1', 'switchport mode access', `switchport access vlan ${vlan}`, 'exit']);
      asw('asw1', 10); asw('asw2', 20);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc10', to: 'erp', port: 443, avoid: 'dsw2', label: 'PC-10（VLAN 10）連 ERP 直接從 DSW-1 出去，不繞經 DSW-2' },
      { type: 'tcp', from: 'pc20', to: 'erp', port: 443, avoid: 'dsw1', label: 'PC-20（VLAN 20）連 ERP 直接從 DSW-2 出去，不繞經 DSW-1' },
      {
        type: 'check', label: '核心之間的 Port-channel 1：兩台都是兩條成員線路',
        test(s) {
          for (const id of ['dsw1', 'dsw2']) {
            const lag = Object.values(dev(s, id).rt.lag || {});
            const bad = lag.find((l) => l.state === 'suspended');
            if (bad) return `${dev(s, id).name} 的 Port-channel 有成員被停用：${bad.why}`;
            if (lag.filter((l) => l.state === 'bundled').length !== 2) return `${dev(s, id).name} 的 Port-channel 1 沒有 2 條成員（show etherchannel summary）：兩台的 Gi1/0/21、Gi1/0/22 都要在 channel-group 1 裡`;
          }
          return true;
        },
      },
      { type: 'failover', label: 'DSW-1 的上行斷了，PC-10 照樣連得到 ERP（閘道讓給 DSW-2）', cut: [['dsw1', 'Gi1/0/24']], test: { type: 'tcp', from: 'pc10', to: 'erp', port: 443 } },
      { type: 'failover', label: 'DSW-2 的上行斷了，PC-20 照樣連得到 ERP（閘道讓給 DSW-1）', cut: [['dsw2', 'Gi1/0/24']], test: { type: 'tcp', from: 'pc20', to: 'erp', port: 443 } },
    ],
    hints: [
      'ASW-1：show spanning-tree vlan 10，Root ID 是 DSW-2、往 DSW-1 的 Gi0/9 被擋（Altn BLK）。DSW-1 卻是 VLAN 10 的 HSRP Active（show standby brief），所以訊框要先到 DSW-2 再過核心之間的線。DSW-1：spanning-tree vlan 10 priority 4096；DSW-2：spanning-tree vlan 10 priority 28672（當備援）。VLAN 20 的根橋留在 DSW-2。',
      'VLAN 20 的 HSRP 要搬到 DSW-2。DSW-2：interface Vlan20 → standby 20 priority 110、standby 20 preempt；DSW-1 的 Vlan20 改回 standby 20 priority 100（留著 preempt）。',
      '核心之間：DSW-1 的 show etherchannel summary，Gi1/0/22 是 (s) 被停用；DSW-2 上 Gi1/0/22 根本不在 Port-channel 裡。DSW-2：interface Gi1/0/22 → channel-group 1 mode active。',
      '上行追蹤：DSW-1 上 track 1 interface Gi1/0/24 line-protocol，interface Vlan10 → standby 10 track 1 decrement 20（110 − 20 = 90）；DSW-2 的 Vlan10 要 standby 10 preempt 才會接手。VLAN 20 反過來：DSW-2 追蹤自己的 Gi1/0/24，DSW-1 的 Vlan20 要有 preempt。',
    ],
    solve(s) {
      cfg(s, 'dsw1', ['spanning-tree vlan 10 priority 4096', 'spanning-tree vlan 20 priority 28672', 'track 1 interface Gi1/0/24 line-protocol',
        'interface Vlan10', 'standby 10 track 1 decrement 20', 'exit', 'interface Vlan20', 'standby 20 priority 100', 'exit']);
      cfg(s, 'dsw2', ['spanning-tree vlan 10 priority 28672', 'spanning-tree vlan 20 priority 4096', 'track 1 interface Gi1/0/24 line-protocol',
        'interface Gi1/0/22', 'channel-group 1 mode active', 'exit',
        'interface Vlan10', 'standby 10 preempt', 'exit', 'interface Vlan20', 'standby 20 priority 110', 'standby 20 preempt', 'standby 20 track 1 decrement 20', 'exit']);
    },
    recap: ['每個 VLAN 的 STP 根橋與 HSRP Active 放在同一台，回程的路由 cost 也對齊；不同的 VLAN 交錯放在兩台上分擔。', 'HSRP 要 preempt 才會搶、要追蹤上行才會讓；Port-channel 兩端的每一條成員都要加進去。'],
  },
  {
    id: 'l185', chapter: 19, title: '兩條專線，只有慢的那條在跑', subtitle: 'EIGRP 進階：彙總與最長前綴、不等價負載分擔 (variance)、重分配的種子 metric', tags: ['EIGRP', 'variance', '彙總', 'summary-address', '路由重分配', 'feasible successor'],
    brief: '分公司用兩條專線連回總公司：A 線 100 Mbps、B 線 50 Mbps，全公司跑 EIGRP。網管報表顯示總公司往分公司的流量全部擠在比較慢的 B 線，A 線幾乎是空的；另外，分公司一直連不到合作廠商的訂單系統。合作廠商的路由器跑的是 OSPF，由 HQ-Core 負責和它交換路由。請讓兩條專線依頻寬比例分擔流量、總公司只看到分公司的一條彙總路由，並讓分公司連得到合作廠商。',
    given: [
      ['專線', 'A 線 10.0.12.0/30（100 Mbps）· B 線 10.0.21.0/30（50 Mbps）· HQ-RT 是 .1、BR-RT 是 .2'],
      ['分公司', '10.2.0.0/24（PC .50）、10.2.1.0/24、10.2.2.0/24、10.2.3.0/24 → 彙總成 10.2.0.0/22'],
      ['總公司', 'HQ-RT ↔ HQ-Core 10.0.0.0/30 · ERP 10.1.0.10'],
      ['合作廠商', 'HQ-Core ↔ PT-RT 172.31.0.0/30（OSPF area 0）· 訂單系統 172.20.0.10'],
      ['設計要求', 'EIGRP AS 100 · 兩條專線都要有流量（比例約 2：1）· 總公司的路由表裡分公司只有一條 10.2.0.0/22'],
    ],
    learn: [
      { t: '彙總只做一半的後果', d: '彙總是寫在介面上的（ip summary-address eigrp）。只在 A 線的介面上設，B 線照樣送出四條 /24 的明細。總公司於是同時有 A 線來的 /22 與 B 線來的 /24：最長前綴比對永遠選 /24，所有往分公司的流量都走 B 線，和頻寬、metric 完全無關。每一條往外的線都要設一樣的彙總。' },
      { t: '彙總的那一台多一條 Null0', d: '設了彙總的路由器自己會多一筆「D 10.2.0.0/22 is a summary, Null0」（管理距離 5）。範圍裡已經不存在的網段，封包到這裡就丟掉，不會順著預設路由又被送回總公司、在兩台之間來回到 TTL 歸零。這筆彙總和其他的路一樣會送給所有鄰居，設了彙總的那個介面另外把明細壓掉。' },
      { t: '可行條件與 variance', d: 'EIGRP 預設只用 metric 最好的那條路。variance 2 讓 metric 在最佳路徑兩倍以內的路也裝進路由表，並依 metric 的反比分配流量 —— 但只限 feasible successor：鄰居回報的距離 (RD) 要小於自己目前的最佳距離 (FD)。兩條平行的線接到同一台鄰居時一定符合。' },
      { t: 'metric 看最窄的頻寬', d: 'metric = 256 ×（10⁷ ÷ 路徑上最小的頻寬 kbps ＋ 延遲總和 ÷ 10）。介面上的 bandwidth 要照實際的合約頻寬設（它不會改變實際的速率，只是告訴路由協定與 QoS）。100 Mbps 與 50 Mbps 的 metric 大約差兩倍，所以 variance 要 2。' },
      { t: '種子 metric', d: '把別的協定的路倒進 EIGRP 時，EIGRP 不知道它的頻寬與延遲是多少。沒有指定的話 metric 是無限大，路由根本不會送出去：redistribute ospf 1 metric 100000 100 255 1 1500（頻寬 kbps、延遲、可靠度、負載、MTU），或用 default-metric 一次設定。倒進 OSPF 則有預設值（20），不指定也會出現。' },
      { t: '怎麼驗證', d: 'show ip eigrp topology 看每個網段的 FD 與每個鄰居的 RD（括號裡的兩個數字）；show ip route <網段> 看有幾個下一站、traffic share count 各是多少；show ip protocols 看 variance 與重分配的設定；D EX 是從外部重分配進來的路（AD 170）。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'pt', { name: 'PT-RT（合作廠商）', host: 'PT-RT', pos: [-13, -7], locked: true, note: '合作廠商的路由器：跑 OSPF，不是你管的' }),
        D('tower', 'order', { name: '訂單系統', pos: [-13, -1.5], ip: '172.20.0.10', gw: '172.20.0.1', services: WEB }),
        D('isr4331', 'core', { name: 'HQ-Core', pos: [-7, -4] }),
        D('tower', 'erp', { name: 'ERP', pos: [-7, 1.5], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('isr4331', 'hq', { name: 'HQ-RT', pos: [-1, -4] }),
        D('isr4331', 'br', { name: 'BR-RT', pos: [8, -4] }),
        D('pc', 'pc', { name: '分公司 PC', pos: [8, 1.5], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [
        ['pt:Gi0/0/0', 'core:Gi0/0/2'], ['pt:Gi0/0/1', 'order:eth0'], ['core:Gi0/0/1', 'erp:eth0'], ['core:Gi0/0/0', 'hq:Gi0/0/2'],
        ['hq:Gi0/0/0', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'br:Gi0/0/1'], ['br:Gi0/0/2', 'pc:eth0'],
      ]);
      recompute(s);
      cfg(s, 'pt', [...ifIp('Gi0/0/0', '172.31.0.2'), ...ifIp('Gi0/0/1', '172.20.0.1', '255.255.255.0'),
        'router ospf 1', 'network 172.31.0.0 0.0.0.3 area 0', 'network 172.20.0.0 0.0.0.255 area 0', 'passive-interface Gi0/0/1', 'exit']);
      // HQ-Core：兩個方向的重分配都設了，但 OSPF → EIGRP 沒有給 metric
      cfg(s, 'core', [...ifIp('Gi0/0/0', '10.0.0.2'), ...ifIp('Gi0/0/1', '10.1.0.1', '255.255.255.0'), ...ifIp('Gi0/0/2', '172.31.0.1'),
        'router eigrp 100', 'network 10.0.0.0 0.0.0.3', 'network 10.1.0.0 0.0.0.255', 'passive-interface Gi0/0/1', 'redistribute ospf 1', 'exit',
        'router ospf 1', 'network 172.31.0.0 0.0.0.3 area 0', 'redistribute eigrp 100 subnets', 'exit']);
      const wan = (a, b) => [...ifIp('Gi0/0/0', a, '255.255.255.252', ['bandwidth 100000', 'description LINE-A 100M']), ...ifIp('Gi0/0/1', b, '255.255.255.252', ['bandwidth 50000', 'description LINE-B 50M'])];
      cfg(s, 'hq', [...wan('10.0.12.1', '10.0.21.1'), ...ifIp('Gi0/0/2', '10.0.0.1'),
        'router eigrp 100', 'network 10.0.0.0 0.0.0.3', 'network 10.0.12.0 0.0.0.3', 'network 10.0.21.0 0.0.0.3', 'exit']);
      // BR-RT：彙總只設在 A 線的介面上；B 線照樣送出四條 /24
      cfg(s, 'br', [...wan('10.0.12.2', '10.0.21.2'), ...ifIp('Gi0/0/2', '10.2.0.1', '255.255.255.0'),
        ...[1, 2, 3].flatMap((n) => [`interface Loopback${n}`, `ip address 10.2.${n}.1 255.255.255.0`, 'exit']),
        'interface Gi0/0/0', 'ip summary-address eigrp 100 10.2.0.0 255.255.252.0', 'exit',
        'router eigrp 100', 'network 10.0.12.0 0.0.0.3', 'network 10.0.21.0 0.0.0.3', 'network 10.2.0.0 0.0.3.255', 'passive-interface Gi0/0/2', 'exit']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'order', port: 443, label: '分公司連得到合作廠商的訂單系統（https://172.20.0.10）' },
      {
        type: 'check', label: '總公司只看到分公司的一條彙總 10.2.0.0/22，沒有 /24 的明細',
        test(s) {
          for (const id of ['hq', 'core']) {
            const d = dev(s, id), r = (d.rt.routes || []).filter((x) => !x.bad && (x.net >>> 10) === (parseIp('10.2.0.0') >>> 10));
            const fine = r.find((x) => x.bits > 22);
            if (fine) return `${d.name} 的路由表裡還有 ${[fine.net >>> 24, (fine.net >>> 16) & 255, (fine.net >>> 8) & 255, fine.net & 255].join('.')}/${fine.bits}（從 ${fine.iface ? fine.iface.label : '?'} 學到）：每一條往總公司的線都要設彙總，不然比較長的前綴一定贏`;
            if (!r.some((x) => x.bits === 22)) return `${d.name} 沒有 10.2.0.0/22 這條彙總路由`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '兩條專線都有流量：兩個方向的路由都有兩個下一站（A 線與 B 線）',
        test(s) {
          const hops = (id, net, bits) => new Set((dev(s, id).rt.routes || []).filter((x) => !x.bad && x.net === parseIp(net) && x.bits === bits && x.iface).map((x) => x.iface.id));
          const a = hops('br', '10.1.0.0', 24), b = hops('hq', '10.2.0.0', 22);
          if (a.size < 2) return `BR-RT 往 ERP 的網段（10.1.0.0/24）只走 ${[...a].join('、') || '？'}：B 線的 metric 大約是 A 線的兩倍，要 variance 2 才會一起用`;
          if (b.size < 2) return `HQ-RT 往分公司（10.2.0.0/22）只走 ${[...b].join('、') || '？'}：HQ-RT 也要設 variance（兩個方向各自決定）`;
          return true;
        },
      },
      { type: 'tcp', from: 'pc', to: 'erp', port: 443, label: '分公司照常打得開 ERP' },
      { type: 'failover', label: 'A 線斷了，分公司照樣連得到 ERP 與合作廠商', cut: [['hq', 'Gi0/0/0']], test: { type: 'tcp', from: 'pc', to: 'order', port: 443 } },
    ],
    hints: [
      'HQ-RT：show ip route 10.2.0.0 255.255.252.0 longer-prefixes。10.2.0.0/22 從 A 線來，另外還有四條 /24 從 B 線（Gi0/0/1）來：比較長的前綴永遠贏，所以流量全走 B 線。BR-RT：interface Gi0/0/1 → ip summary-address eigrp 100 10.2.0.0 255.255.252.0。',
      '彙總一致之後，HQ-RT 的 show ip eigrp topology 10.2.0.0/22 有兩條路，但只有 A 線的被選中。router eigrp 100 → variance 2；BR-RT 也一樣（它往總公司的方向）。show ip route 之後同一個網段會有兩個下一站，traffic share count 大約 2：1。',
      '合作廠商：BR-RT 的路由表沒有 172.20.0.0/24。HQ-Core 的 show running-config | section eigrp 有 redistribute ospf 1，卻沒有 metric：EIGRP 不知道這些路的頻寬與延遲，當成無限大、不送出去。改成 redistribute ospf 1 metric 100000 100 255 1 1500（或加一行 default-metric 100000 100 255 1 1500）。',
    ],
    solve(s) {
      cfg(s, 'br', ['interface Gi0/0/1', 'ip summary-address eigrp 100 10.2.0.0 255.255.252.0', 'exit', 'router eigrp 100', 'variance 2']);
      cfg(s, 'hq', ['router eigrp 100', 'variance 2']);
      cfg(s, 'core', ['router eigrp 100', 'redistribute ospf 1 metric 100000 100 255 1 1500']);
    },
    recap: ['彙總要在每一條往外的介面上都設：少一條，對面就會收到比較長的明細，流量全部走那一條。', 'variance 讓 feasible successor 一起分擔流量；倒進 EIGRP 的路一定要有種子 metric。'],
  },
  {
    id: 'l186', chapter: 19, title: '兩個路由協定、兩個交界', subtitle: '雙向重分配：管理距離造成的迴圈、路由標籤、用種子 metric 決定主線與備援', tags: ['路由重分配', 'OSPF', 'EIGRP', '管理距離', 'route tag', 'distribute-list', '路徑控制'],
    brief: '工廠的舊網路跑 EIGRP，新的資料中心跑 OSPF。上個月為了備援，把兩邊用兩台邊界路由器（ASBR-1、ASBR-2）接起來，兩台都做雙向重分配。上線之後：資料中心的監控主機連得到工廠的 MES 伺服器，卻一直連不到產線的 HMI —— traceroute 看到封包在 DC-Core 和邊界路由器之間來回。產線閘道是設備商管的，FAB-Core 用一條靜態路由指過去，再重分配進 EIGRP。請找出原因修好，並讓 ASBR-1 成為兩個方向的主線、ASBR-2 只在 ASBR-1 故障時接手。',
    given: [
      ['資料中心 (OSPF area 0)', 'DC-Core ↔ ASBR-1 10.0.14.0/30 · DC-Core ↔ ASBR-2 10.0.24.0/30 · 監控主機 10.40.0.50'],
      ['工廠 (EIGRP AS 100)', 'FAB-Core ↔ ASBR-1 10.0.13.0/30 · FAB-Core ↔ ASBR-2 10.0.23.0/30 · MES 10.30.0.10'],
      ['產線', '192.168.50.0/24（HMI .10），在設備商的閘道 10.30.0.2 後面 —— FAB-Core 上是靜態路由，重分配進 EIGRP'],
      ['設計要求', '平常兩個方向都走 ASBR-1；ASBR-1 整台故障時自動改走 ASBR-2'],
      ['不能動', '產線閘道是設備商管的；FAB-Core 的靜態路由與重分配不用改'],
    ],
    learn: [
      { t: '管理距離決定相信誰', d: '同一個網段從兩個協定學到時，路由器不比 metric（單位不一樣，沒辦法比），只看管理距離：EIGRP 內部 90、OSPF 110、EIGRP 外部 170。MES 的網段是 EIGRP 內部的路（90），邊界路由器會直接走 EIGRP；產線的網段是重分配進 EIGRP 的外部路由（170）—— 另一台邊界路由器把它倒進 OSPF 之後，這一台從 OSPF 也學到一份（110），於是相信 OSPF，把封包往資料中心送。兩台都這樣想，封包就在中間來回。' },
      { t: '修法一：調整管理距離', d: '在兩台邊界路由器的 router ospf 底下 distance ospf external 171：OSPF 外部路由比 EIGRP 外部（170）還不可信，產線的網段就會回到 EIGRP 這一邊。只動 external，OSPF 區域內的路還是 110。反過來把 EIGRP 外部調到比 110 小（distance eigrp 90 105）是常見的錯誤：資料中心自己的網段也會被倒進 EIGRP 再繞回來。' },
      { t: '修法二：路由標籤', d: '重分配的時候貼上標籤（route-map 裡 set tag 100，或 redistribute … tag 100），另一台邊界路由器看到這個標籤就知道「這是從 EIGRP 來的」：router ospf 底下 distribute-list route-map <名稱> in，route-map 第一條 deny、match tag 100，第二條 permit。LSA 還是在資料庫裡，只是不放進這一台的路由表。這個做法不必記各協定的管理距離，協定再多也適用。' },
      { t: '種子 metric 決定走哪一台', d: '倒進 OSPF 的外部路由預設是 E2、metric 20，兩台都一樣，資料中心就把流量分給兩台。讓備援那一台用比較大的 metric（redistribute eigrp 100 subnets metric 100），主線的 20 就贏了。倒進 EIGRP 的方向一樣：備援那一台給比較小的頻寬或比較大的延遲，FAB-Core 算出來的 metric 比較差，平常就只走主線。' },
      { t: '怎麼查', d: 'show ip route <網段> 看 Known via 是哪一個協定、distance 多少；show ip ospf database external 看是誰（Advertising Router）送出這筆外部路由、Tag 是多少；show ip eigrp topology <網段> 看外部路由的來源協定與標籤；traceroute 看封包在哪兩台之間來回。' },
    ],
    setup() {
      const s = makeState([
        D('pc', 'mon', { name: '監控主機', pos: [-13, 2], ip: '10.40.0.50', gw: '10.40.0.1' }),
        D('isr4331', 'r4', { name: 'DC-Core', pos: [-9, -3] }),
        D('isr4331', 'r1', { name: 'ASBR-1', pos: [-2, -7] }),
        D('isr4331', 'r2', { name: 'ASBR-2', pos: [-2, 1] }),
        D('isr4331', 'r3', { name: 'FAB-Core', pos: [5, -3] }),
        D('sw5', 'sw', { name: '工廠的交換器', pos: [10, -3] }),
        D('tower', 'mes', { name: 'MES 伺服器', pos: [10, -8], ip: '10.30.0.10', gw: '10.30.0.1', services: WEB }),
        D('isr4321', 'gw', { name: '產線閘道（設備商）', host: 'LINE-GW', pos: [14, -3], locked: true, note: '設備商管理的閘道：不跑路由協定，預設路由指向 FAB-Core' }),
        D('tower', 'hmi', { name: '產線 HMI', pos: [14, 2], ip: '192.168.50.10', gw: '192.168.50.1', services: WEB }),
      ], [
        ['mon:eth0', 'r4:Gi0/0/2'], ['r4:Gi0/0/0', 'r1:Gi0/0/0'], ['r4:Gi0/0/1', 'r2:Gi0/0/0'],
        ['r1:Gi0/0/1', 'r3:Gi0/0/0'], ['r2:Gi0/0/1', 'r3:Gi0/0/1'], ['r3:Gi0/0/2', 'sw:1'], ['sw:2', 'mes:eth0'], ['sw:3', 'gw:Gi0/0/0'], ['gw:Gi0/0/1', 'hmi:eth0'],
      ]);
      recompute(s);
      cfg(s, 'gw', [...ifIp('Gi0/0/0', '10.30.0.2', '255.255.255.0'), ...ifIp('Gi0/0/1', '192.168.50.1', '255.255.255.0'), 'ip route 0.0.0.0 0.0.0.0 10.30.0.1']);
      cfg(s, 'r4', [...ifIp('Gi0/0/0', '10.0.14.2'), ...ifIp('Gi0/0/1', '10.0.24.2'), ...ifIp('Gi0/0/2', '10.40.0.1', '255.255.255.0'), ...lo0('4.4.4.4'),
        'router ospf 1', 'router-id 4.4.4.4', 'network 10.0.14.0 0.0.0.3 area 0', 'network 10.0.24.0 0.0.0.3 area 0', 'network 10.40.0.0 0.0.0.255 area 0', 'passive-interface Gi0/0/2', 'exit']);
      // 兩台邊界路由器：一模一樣的雙向重分配
      const asbr = (n) => [...ifIp('Gi0/0/0', `10.0.${n}4.1`), ...ifIp('Gi0/0/1', `10.0.${n}3.1`), ...lo0(`${n}.${n}.${n}.${n}`),
        'router eigrp 100', `eigrp router-id ${n}.${n}.${n}.${n}`, `network 10.0.${n}3.0 0.0.0.3`, 'redistribute ospf 1 metric 100000 100 255 1 1500', 'exit',
        'router ospf 1', `router-id ${n}.${n}.${n}.${n}`, `network 10.0.${n}4.0 0.0.0.3 area 0`, 'redistribute eigrp 100 subnets', 'exit'];
      cfg(s, 'r1', asbr(1));
      cfg(s, 'r2', asbr(2));
      cfg(s, 'r3', [...ifIp('Gi0/0/0', '10.0.13.2'), ...ifIp('Gi0/0/1', '10.0.23.2'), ...ifIp('Gi0/0/2', '10.30.0.1', '255.255.255.0'), ...lo0('3.3.3.3'),
        'ip route 192.168.50.0 255.255.255.0 10.30.0.2',
        'router eigrp 100', 'eigrp router-id 3.3.3.3', 'network 10.0.13.0 0.0.0.3', 'network 10.0.23.0 0.0.0.3', 'network 10.30.0.0 0.0.0.255', 'passive-interface Gi0/0/2',
        'redistribute static metric 100000 100 255 1 1500', 'exit']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'mon', to: 'hmi', port: 443, label: '監控主機連得到產線的 HMI（https://192.168.50.10）' },
      {
        type: 'check', label: '兩台邊界路由器往產線（192.168.50.0/24）都直接交給 FAB-Core，不會繞回資料中心',
        test(s) {
          for (const id of ['r1', 'r2']) {
            const d = dev(s, id), all = (d.rt.routes || []).filter((x) => !x.bad && x.net === parseIp('192.168.50.0') && x.bits === 24);
            if (!all.length) return `${d.name} 的路由表裡沒有 192.168.50.0/24`;
            const best = all.reduce((a, b) => (b.ad < a.ad ? b : a));
            if (best.type !== 'E') return `${d.name} 往 192.168.50.0/24 用的是 OSPF 的外部路由（管理距離 ${best.ad}，從另一台邊界路由器倒進 OSPF 的那一份），EIGRP 的外部路由（${(all.find((x) => x.type === 'E') || { ad: 170 }).ad}）輸了：封包被送回資料中心`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '邊界路由器往資料中心的網段（10.40.0.0/24）還是走 OSPF，沒有被倒回來的路蓋掉',
        test(s) {
          for (const id of ['r1', 'r2']) {
            const d = dev(s, id), all = (d.rt.routes || []).filter((x) => !x.bad && x.net === parseIp('10.40.0.0') && x.bits === 24);
            if (!all.length) return `${d.name} 的路由表裡沒有 10.40.0.0/24`;
            const best = all.reduce((a, b) => (b.ad < a.ad ? b : a));
            if (best.type !== 'O') return `${d.name} 往資料中心的 10.40.0.0/24 走的是 EIGRP 外部路由（管理距離 ${best.ad}）：這是另一台邊界路由器倒進 EIGRP 的那一份，把 EIGRP 外部調得比 OSPF（110）還小就會這樣`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '平常兩個方向都只走 ASBR-1（主線）',
        test(s) {
          const hops = (id, ip) => { const all = (dev(s, id).rt.routes || []).filter((x) => !x.bad && x.net === parseIp(ip) && x.bits === 24), ad = Math.min(...all.map((x) => x.ad)); return all.filter((x) => x.ad === ad); };
          const out = hops('r4', '192.168.50.0'), back = hops('r3', '10.40.0.0');
          if (!out.length) return 'DC-Core 的路由表裡沒有 192.168.50.0/24';
          if (!back.length) return 'FAB-Core 的路由表裡沒有 10.40.0.0/24';
          if (out.some((x) => x.iface.id !== 'Gi0/0/0')) return `DC-Core 往產線的路${out.length > 1 ? '同時走兩台邊界路由器（兩筆 E2 的 metric 一樣）' : '走的是 ASBR-2'}：讓 ASBR-2 倒進 OSPF 的 metric 比 ASBR-1 大`;
          if (back.some((x) => x.iface.id !== 'Gi0/0/0')) return `FAB-Core 往資料中心的路${back.length > 1 ? '同時走兩台邊界路由器（兩邊的種子 metric 一樣）' : '走的是 ASBR-2'}：讓 ASBR-2 倒進 EIGRP 的種子 metric 比 ASBR-1 差（頻寬小一點或延遲大一點）`;
          return true;
        },
      },
      { type: 'tcp', from: 'mon', to: 'mes', port: 443, label: '監控主機照常連得到 MES 伺服器' },
      { type: 'failover', label: 'ASBR-1 整台故障：監控主機照樣連得到產線的 HMI', down: ['r1'], test: { type: 'tcp', from: 'mon', to: 'hmi', port: 443 } },
    ],
    hints: [
      'ASBR-1：show ip route 192.168.50.0。Known via "ospf 1"、distance 110 —— 它相信的是 ASBR-2 倒進 OSPF 的那一份，不是 FAB-Core 給的 EIGRP 外部路由（170）。ASBR-2 也一樣，所以封包在 DC-Core 與邊界路由器之間來回。MES 的 10.30.0.0/24 是 EIGRP 內部路由（90），所以沒事。',
      '兩台邊界路由器都要改，擇一：(1) router ospf 1 → distance ospf external 171；(2) 重分配時貼標籤、另一台擋掉：route-map TAG-EIGRP permit 10 / set tag 100，redistribute eigrp 100 subnets route-map TAG-EIGRP；route-map NO-BACK deny 10 / match tag 100、route-map NO-BACK permit 20，router ospf 1 → distribute-list route-map NO-BACK in。',
      '主線與備援：只改 ASBR-2。router ospf 1 → redistribute eigrp 100 subnets metric 100（原本有 route-map 的話要一起寫）；router eigrp 100 → redistribute ospf 1 metric 10000 1000 255 1 1500。DC-Core 的 show ip route 192.168.50.0 與 FAB-Core 的 show ip route 10.40.0.0 都只剩往 ASBR-1 的那一條。',
    ],
    solve(s) {
      for (const id of ['r1', 'r2']) cfg(s, id, ['router ospf 1', 'distance ospf external 171']);
      cfg(s, 'r2', ['router ospf 1', 'redistribute eigrp 100 subnets metric 100', 'exit', 'router eigrp 100', 'redistribute ospf 1 metric 10000 1000 255 1 1500']);
    },
    recap: ['同一個網段從兩個協定學到時只看管理距離：兩個交界的雙向重分配，要用 distance 或路由標籤避免相信倒回來的那一份。', '種子 metric 決定對面走哪一台邊界路由器：主線給好的、備援給差的。'],
  },
  {
    id: 'l188', chapter: 19, title: '鏡像埠上，要看的封包一個都沒有', subtitle: 'SPAN 與 RSPAN：鏡像的來源、方向、remote-span 的 VLAN 怎麼沿著 Trunk 送到感測器', tags: ['SPAN', 'RSPAN', 'remote-span', '封包擷取', 'NDR', 'Trunk'],
    brief: '資安團隊在核心交換器上接了一台 NDR 感測器，要側錄財務伺服器的流量。上週有人在 Core 上設了 SPAN，把往財務交換器的上行埠鏡像給感測器。結果：財務部的電腦連財務伺服器的流量，感測器一個封包都沒看到；經過上行埠的流量只看得到一個方向；反而一般使用者往檔案伺服器的流量全部被送了過去，把感測器的儲存空間吃光。請改成「只鏡像財務伺服器那一個埠、進出兩個方向都要」，其他人的流量不要送過去。',
    given: [
      ['Core (C9300)', 'Gi1/0/1 Trunk → SW-FIN · Gi1/0/10 檔案伺服器（VLAN 20）· Gi1/0/24 NDR 感測器 · VLAN 10 / 20 的閘道在這裡'],
      ['SW-FIN (C2960)', 'Gi0/1 Trunk → Core（只允許 VLAN 10,20）· Gi0/5 財務伺服器 · Gi0/6 財務 PC（都在 VLAN 10）· Gi0/7 一般 PC（VLAN 20）'],
      ['位址', '財務伺服器 10.10.10.10 · 財務 PC 10.10.10.50 · 一般 PC 10.10.20.50 · 檔案伺服器 10.10.20.10'],
      ['RSPAN 用的 VLAN', '900（還沒有建立）'],
      ['要求', '感測器只收財務伺服器那個埠的流量（進與出）；不能動到使用者的連線'],
    ],
    learn: [
      { t: 'SPAN 只看得到經過那個埠的訊框', d: '鏡像的是「來源埠」上進出的訊框。財務 PC 和財務伺服器接在同一台交換器上，彼此的流量在 SW-FIN 裡就轉送完了，根本不會走到 Core 的上行埠 —— 在 Core 上鏡像再多也看不到。要看哪個埠的流量，來源就要設在那個埠所在的交換器上。' },
      { t: 'rx、tx、both', d: 'monitor session 1 source interface Gi0/5 後面不寫就是 both。rx 只複製從那個埠「進來」的訊框，tx 只複製「送出去」的。只設 rx 會只看到一個方向，TCP 的連線在分析工具裡變成只有請求沒有回應。' },
      { t: 'RSPAN：用一個 VLAN 把鏡像載到遠端', d: '感測器不在來源的那一台交換器上時，用 RSPAN：建一個專用的 VLAN 並標成 remote-span，來源的交換器把鏡像的訊框放進這個 VLAN（destination remote vlan 900），沿著 Trunk 送到感測器所在的交換器，那一台再把這個 VLAN 當成來源（source remote vlan 900）送到目的埠。' },
      { t: '路上每一段都要通', d: 'RSPAN VLAN 和一般的 VLAN 一樣要在路上每一台交換器上存在（而且都要標 remote-span），每一條 Trunk 兩端都要允許它。Trunk 有限制允許的 VLAN 時最容易漏掉：show interfaces trunk、show vlan remote-span、show monitor 逐一對。' },
      { t: '目的埠不是一般的埠', d: 'SPAN 的目的埠只送出複製的訊框，不學 MAC、不跑生成樹、接在上面的設備也不能用它上網，所以感測器通常另外有一個管理用的網路卡。要跨第三層送鏡像（感測器在另一個站點）用 ERSPAN：把鏡像的訊框包進 GRE，用 IP 路由送過去。' },
    ],
    setup() {
      const s = makeState([
        D('c9300', 'core', { name: 'Core', pos: [0, -6] }),
        D('c2960', 'fin', { name: 'SW-FIN', pos: [-7, -1] }),
        D('tower', 'ndr', { name: 'NDR 感測器', pos: [8, -9], ip: '192.168.99.10', note: '側錄用的網路卡：開著混雜模式收鏡像的訊框，不用它上網' }),
        D('nas', 'nas', { name: '檔案伺服器', pos: [8, -2], ip: '10.10.20.10', gw: '10.10.20.1', services: WEB }),
        D('tower', 'srv', { name: '財務伺服器', pos: [-12, 4], ip: '10.10.10.10', gw: '10.10.10.1', services: WEB }),
        D('pc', 'finpc', { name: '財務 PC', pos: [-7, 5], ip: '10.10.10.50', gw: '10.10.10.1' }),
        D('pc', 'gen', { name: '一般 PC', pos: [-2, 4], ip: '10.10.20.50', gw: '10.10.20.1' }),
      ], [
        ['core:Gi1/0/1', 'fin:Gi0/1'], ['core:Gi1/0/10', 'nas:eth0'], ['core:Gi1/0/24', 'ndr:eth0'],
        ['fin:Gi0/5', 'srv:eth0'], ['fin:Gi0/6', 'finpc:eth0'], ['fin:Gi0/7', 'gen:eth0'],
      ]);
      recompute(s);
      const vlans = ['vlan 10', 'name FINANCE', 'exit', 'vlan 20', 'name USERS', 'exit'];
      const acc = (p, v) => [`interface ${p}`, 'switchport mode access', `switchport access vlan ${v}`, 'spanning-tree portfast', 'exit'];
      // Core：上週設的本機 SPAN —— 來源是往 SW-FIN 的上行埠，而且只有 rx
      cfg(s, 'core', ['ip routing', ...vlans, 'interface Gi1/0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit', ...acc('Gi1/0/10', 20),
        'interface Vlan10', 'ip address 10.10.10.1 255.255.255.0', 'exit', 'interface Vlan20', 'ip address 10.10.20.1 255.255.255.0', 'exit',
        'monitor session 1 source interface Gi1/0/1 rx', 'monitor session 1 destination interface Gi1/0/24']);
      cfg(s, 'fin', [...vlans, 'interface Gi0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit', ...acc('Gi0/5', 10), ...acc('Gi0/6', 10), ...acc('Gi0/7', 20)]);
      recompute(s);
      return s;
    },
    objectives: [
      {
        type: 'check', label: '感測器收得到財務伺服器的流量，而且進、出兩個方向都有（包含同一台交換器上的財務 PC 連它）',
        test(s) {
          const f = spanSeen(s, 'ndr', [['finpc', '10.10.10.10', 443], ['gen', '10.10.10.10', 443]]);
          const srv = parseIp('10.10.10.10'), pc = parseIp('10.10.10.50');
          const to = f.some((x) => x.src === pc && x.dst === srv), from = f.some((x) => x.src === srv && x.dst === pc);
          if (!to && !from) {
            const fin = dev(s, 'fin'), ses = Object.values(fin.sw.span || {});
            if (!ses.some((x) => x.src && x.src['Gi0/5'])) return '財務 PC 連財務伺服器的流量，感測器一個封包都沒收到：兩台都接在 SW-FIN 上，流量不會經過 Core 的上行埠。鏡像的來源要設在 SW-FIN 的 Gi0/5（財務伺服器那個埠）';
            const rv = ses.find((x) => x.src && x.src['Gi0/5'] && x.dstVlan != null);
            if (!rv) return 'SW-FIN 的 session 有來源埠，但沒有把鏡像送出去：感測器接在 Core，要用 RSPAN（monitor session <n> destination remote vlan 900）';
            return `鏡像的訊框到不了感測器：${rspanReach(s, 'fin', rv.dstVlan).why.join('；')}`;
          }
          if (!to || !from) return `感測器只收到一個方向（${to ? '財務 PC → 伺服器' : '伺服器 → 財務 PC'}）：來源埠的方向要是 both，不是只有 rx 或 tx`;
          return true;
        },
      },
      {
        type: 'check', label: '其他人的流量不會送到感測器：一般 PC 連檔案伺服器的封包不在鏡像裡',
        test(s) {
          const f = spanSeen(s, 'ndr', [['gen', '10.10.20.10', 443]]);
          const a = parseIp('10.10.20.50'), b = parseIp('10.10.20.10');
          if (f.some((x) => (x.src === a && x.dst === b) || (x.src === b && x.dst === a))) return '一般 PC 連檔案伺服器的封包也被送到感測器：來源不要用整個上行埠，只鏡像財務伺服器那一個埠';
          return true;
        },
      },
      { type: 'tcp', from: 'finpc', to: 'srv', port: 443, label: '財務 PC 照常連得到財務伺服器' },
      { type: 'tcp', from: 'gen', to: 'nas', port: 443, label: '一般 PC 照常連得到檔案伺服器' },
    ],
    hints: [
      'Core：show monitor。Session 1 的來源是 Gi1/0/1、RX Only：只看得到從 SW-FIN 進來的訊框。財務 PC 與財務伺服器都在 SW-FIN，它們之間的流量不會上來；VLAN 20 的使用者要到檔案伺服器卻一定經過這裡。先 no monitor session 1。',
      'SW-FIN：vlan 900 → remote-span；monitor session 1 source interface Gi0/5（不寫方向就是 both）；monitor session 1 destination remote vlan 900；interface Gi0/1 → switchport trunk allowed vlan add 900。',
      'Core：vlan 900 → remote-span；interface Gi1/0/1 → switchport trunk allowed vlan add 900；monitor session 2 source remote vlan 900；monitor session 2 destination interface Gi1/0/24。兩台的 show monitor 都看不到「鏡像送不到任何目的埠」的說明就對了。',
    ],
    solve(s) {
      cfg(s, 'fin', ['vlan 900', 'name RSPAN', 'remote-span', 'exit', 'monitor session 1 source interface Gi0/5', 'monitor session 1 destination remote vlan 900', 'interface Gi0/1', 'switchport trunk allowed vlan add 900']);
      cfg(s, 'core', ['no monitor session 1', 'vlan 900', 'name RSPAN', 'remote-span', 'exit', 'interface Gi1/0/1', 'switchport trunk allowed vlan add 900', 'exit',
        'monitor session 2 source remote vlan 900', 'monitor session 2 destination interface Gi1/0/24']);
    },
    recap: ['鏡像的來源要設在流量真的經過的那個埠；感測器在別台交換器上就用 RSPAN。', 'RSPAN VLAN 要在路上每一台都是 remote-span，每一條 Trunk 都要允許它。'],
  },
  {
    id: 'l189', chapter: 19, title: '核心一被掃，SSH 就進不去', subtitle: 'CoPP：保護設備自己的 CPU —— 分類、限速、路由協定與管理流量要分開', tags: ['CoPP', 'control-plane', 'police', '設備加固', 'DoS', 'OSPF'],
    brief: '辦公區有一台中毒的電腦，正在對核心路由器 Core-RT 的 Loopback 位址狂送 ICMP（每秒兩萬個）。資料還轉得動（使用者照常連得到 ERP），但 Core-RT 的 CPU 滿載：網管工作站 SSH 進不去、監控系統 ping 不到它，告警響個不停。請在 Core-RT 上設定 CoPP：把洪水壓下來，同時保住路由協定、網管工作站的 SSH 與監控的 ping。資安規範另外要求：不能只靠介面上的 ACL 擋（攻擊換一個方向進來就沒用了），control-plane 一定要有限速。',
    given: [
      ['Core-RT', 'Lo0 10.255.0.1 · Gi0/0/0 辦公區 10.10.0.1/24 · Gi0/0/1 → DIST-RT 10.0.0.1/30（OSPF）· Gi0/0/2 管理網段 10.99.0.1/24'],
      ['DIST-RT', '10.0.0.2/30 · ERP 的網段 10.20.0.0/24（ERP 10.20.0.10）'],
      ['網管工作站', '10.99.0.10：用 SSH 管理 Core-RT（帳號 netops），監控系統也在這台，每分鐘 ping Core-RT 的 Loopback'],
      ['攻擊', '中毒的電腦 10.10.0.66 → 10.255.0.1，ICMP，每秒 20,000 個'],
      ['Core-RT 的 CPU', '每秒大約處理得了 3,000 個送給它自己的封包'],
    ],
    learn: [
      { t: '轉送和 CPU 是兩回事', d: '經過路由器的封包由轉送平面（CEF、硬體）處理，不太吃 CPU；但「目的位址就是路由器自己」的封包（ping 它、SSH、SNMP、路由協定）全部要交給 CPU。所以對路由器自己的位址灌封包，資料照樣轉得動，管理卻進不去 —— 而且任何一台能送封包給它的設備都做得到。' },
      { t: 'CoPP 的組成', d: '和介面上的 QoS 是同一套語法（MQC）：用 ACL 把送給自己的封包分類（class-map match access-group name …），在 policy-map 裡替每個 class 設限速（police rate 100 pps，或 police 64000）或直接 drop，最後套在 control-plane 底下（service-policy input）。它對所有介面進來、要交給 CPU 的封包都生效，這是它比介面 ACL 好的地方。' },
      { t: 'policer 不分好壞', d: '限速是照 class 算的：同一個 class 裡擠著洪水時，正常的封包和攻擊的封包一樣照比例被丟。所以分類要夠細 —— 路由協定一個 class、來自管理網段的 SSH / SNMP / ping 一個 class、其他來源的 ICMP 另一個 class（限得很緊）。要保護的流量絕對不能和「可能被灌爆的流量」放在一起。' },
      { t: '順序與 class-default', d: 'policy-map 裡的 class 由上往下比對，第一個符合的生效。路由協定放最前面，而且通常不限速（或限得很寬）：把 OSPF 的 Hello 丟掉，鄰居四十秒後就斷，比被攻擊還慘。class-default 收剩下的全部，給一個保守的限速；不要直接 drop，除非前面已經把所有要用的協定列完。' },
      { t: '怎麼驗證', d: 'show policy-map control-plane 看每個 class 進來多少、通過 (conformed) 多少、丟掉 (exceeded) 多少；show processes cpu 看 CPU 降下來了沒；show ip ospf neighbor 確認鄰居還在。先用寬鬆的限速上線、觀察幾天計數器再收緊，是實務上的做法。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'core', { name: 'Core-RT', pos: [0, -5], init(d) { Object.assign(d.mgmt, { user: 'netops', pass: 'N3t0ps!26', priv: 15, sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local', telnet: false, ssh: true }); } }),
        D('isr4331', 'dist', { name: 'DIST-RT', pos: [8, -5] }),
        D('tower', 'erp', { name: 'ERP', pos: [12, 0], ip: '10.20.0.10', gw: '10.20.0.1', services: WEB }),
        D('tower', 'nms', { name: '網管工作站', pos: [0, -11], ip: '10.99.0.10', gw: '10.99.0.1' }),
        D('sw8', 'sw', { name: '辦公區交換器', pos: [-7, -1] }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-11, 4], ip: '10.10.0.50', gw: '10.10.0.1' }),
        D('pc', 'bot', { name: '中毒的電腦', pos: [-4, 4], ip: '10.10.0.66', gw: '10.10.0.1', locked: true, note: '已經通報使用者關機，但人還沒找到：這台不能動' }),
      ], [
        ['core:Gi0/0/0', 'sw:1'], ['sw:2', 'pc:eth0'], ['sw:3', 'bot:eth0'], ['core:Gi0/0/1', 'dist:Gi0/0/0'], ['core:Gi0/0/2', 'nms:eth0'], ['dist:Gi0/0/1', 'erp:eth0'],
      ]);
      recompute(s);
      cfg(s, 'core', [...lo0('10.255.0.1'), ...ifIp('Gi0/0/0', '10.10.0.1', '255.255.255.0'), ...ifIp('Gi0/0/1', '10.0.0.1'), ...ifIp('Gi0/0/2', '10.99.0.1', '255.255.255.0'),
        'router ospf 1', 'router-id 10.255.0.1', 'network 10.0.0.0 0.0.0.3 area 0', 'network 10.10.0.0 0.0.0.255 area 0', 'network 10.99.0.0 0.0.0.255 area 0', 'network 10.255.0.1 0.0.0.0 area 0',
        'passive-interface Gi0/0/0', 'passive-interface Gi0/0/2', 'exit']);
      cfg(s, 'dist', [...lo0('10.255.0.2'), ...ifIp('Gi0/0/0', '10.0.0.2'), ...ifIp('Gi0/0/1', '10.20.0.1', '255.255.255.0'),
        'router ospf 1', 'router-id 10.255.0.2', 'network 10.0.0.0 0.0.0.3 area 0', 'network 10.20.0.0 0.0.0.255 area 0', 'network 10.255.0.2 0.0.0.0 area 0', 'passive-interface Gi0/0/1', 'exit']);
      s.attacks = [{ id: 'flood', from: 'bot', ip: '10.255.0.1', kind: 'icmp', pps: 20000, on: true, cp: true, label: '中毒的電腦送出的 ICMP 洪水' }];
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'login', from: 'nms', ip: '10.255.0.1', proto: 'ssh', user: 'netops', pass: 'N3t0ps!26', label: '網管工作站 SSH 得進 Core-RT' },
      { type: 'ping', from: 'nms', ip: '10.255.0.1', label: '監控系統 ping 得到 Core-RT 的 Loopback' },
      {
        type: 'check', label: 'Core-RT 的 control-plane 有限速，洪水被壓在 CPU 處理得了的範圍內',
        test(s) {
          const d = dev(s, 'core'), cp = (s.rt.copp || {}).core;
          if (!d.copp) return cp ? 'control-plane 底下沒有 service-policy：只靠介面的 ACL 擋，攻擊換一個方向進來就沒用了' : 'control-plane 底下沒有 service-policy（資安規範要求一定要有 CoPP，就算洪水已經被別的方法擋掉）';
          if (!(d.policyMaps || {})[d.copp]) return `policy-map ${d.copp} 還沒有建立`;
          if (cp && cp.hog) return `Core-RT 的 CPU 還是忙不過來（${cp.cpu}%）：每秒還有 ${Math.round(cp.passed)} 個封包通過 CoPP 交給 CPU。洪水分到的那個 class 限速要更緊（幾十到幾百 pps）`;
          return true;
        },
      },
      {
        type: 'check', label: 'OSPF 的鄰居還在：CoPP 沒有把路由協定的封包丟掉',
        test(s) {
          const n = ((dev(s, 'core').rt.nbrs) || []).find((x) => x.dev === 'dist');
          if (n && n.state === 'full') return true;
          const w = coppRoutingWhy(dev(s, 'core'), 'ospf', parseIp('10.0.0.2'), parseIp('224.0.0.5'));
          return `Core-RT 和 DIST-RT 的 OSPF 鄰居不是 FULL${w ? '：' + w : n && n.why ? '：' + n.why : ''}`;
        },
      },
      { type: 'tcp', from: 'pc', to: 'erp', port: 443, label: '使用者照常連得到 ERP' },
    ],
    hints: [
      'Core-RT：show processes cpu（IP Input 把 CPU 佔滿）、show policy-map control-plane（沒有 service-policy）。先用 ACL 分類：ip access-list extended CP-ROUTING → permit ospf any any；ip access-list extended CP-MGMT → permit tcp 10.99.0.0 0.0.0.255 any eq 22、permit icmp 10.99.0.0 0.0.0.255 any；ip access-list extended CP-ICMP → permit icmp any any。',
      'class-map match-all CM-ROUTING → match access-group name CP-ROUTING（CM-MGMT、CM-ICMP 照做）。policy-map COPP：class CM-ROUTING（不限速）、class CM-MGMT → police rate 500 pps、class CM-ICMP → police rate 50 pps、class class-default → police rate 200 pps。順序很重要：CM-MGMT 要在 CM-ICMP 前面，管理網段的 ping 才不會和洪水擠在一起。',
      'control-plane → service-policy input COPP。show policy-map control-plane：CM-ICMP 每秒進來 20,000、conformed 50、其餘 exceeded；show processes cpu 降回個位數。不要對 class-default 或路由協定下 drop。',
    ],
    solve(s) {
      cfg(s, 'core', ['ip access-list extended CP-ROUTING', 'permit ospf any any', 'exit',
        'ip access-list extended CP-MGMT', 'permit tcp 10.99.0.0 0.0.0.255 any eq 22', 'permit icmp 10.99.0.0 0.0.0.255 any', 'exit',
        'ip access-list extended CP-ICMP', 'permit icmp any any', 'exit',
        'class-map match-all CM-ROUTING', 'match access-group name CP-ROUTING', 'exit', 'class-map match-all CM-MGMT', 'match access-group name CP-MGMT', 'exit', 'class-map match-all CM-ICMP', 'match access-group name CP-ICMP', 'exit',
        'policy-map COPP', 'class CM-ROUTING', 'exit', 'class CM-MGMT', 'police rate 500 pps', 'exit', 'class CM-ICMP', 'police rate 50 pps', 'exit', 'class class-default', 'police rate 200 pps', 'exit', 'exit',
        'control-plane', 'service-policy input COPP']);
    },
    recap: ['送給設備自己的封包都要 CPU 處理：用 CoPP 分類限速，路由協定、管理、其他各一個 class。', 'policer 不分好壞：要保護的流量不能和可能被灌爆的流量放在同一個 class。'],
  },
  {
    id: 'l190', chapter: 19, noDrill: true, title: '4G 備援照流量計費，平常要關著', subtitle: 'EEM：事件發生時自動下指令 —— 主線不通才打開備援介面，恢復之後再關掉', tags: ['EEM', 'event manager', 'IP SLA', 'track', '自動化', '備援'],
    brief: '門市的路由器有兩條對外線路：光纖主線，以及一條 4G 備援。4G 是照流量計費的，介面只要開著，系統更新、背景同步就會偷偷走它，上個月的帳單因此多了好幾千元 —— 所以規定 4G 的介面平常要 shutdown。問題是主線一斷就得有人半夜爬起來手動打開。IP SLA 與追蹤物件（track 1）前人已經設好了，請用 EEM 讓路由器自己處理：track 1 一 Down 就打開 4G 的介面，回到 Up 就關掉，而且每次切換都要留下一筆紀錄。',
    given: [
      ['主線', 'Gi0/0/0 → 光纖 ISP，閘道 203.0.113.1 · 預設路由綁 track 1'],
      ['備援', 'Gi0/0/1 → 4G 業者，閘道 198.51.100.1 · 浮動靜態路由（AD 10）· 介面平常 shutdown'],
      ['探測', 'ip sla 1：每 10 秒從主線 ping 1.1.1.1 · track 1 ip sla 1 reachability（都已經設好）'],
      ['要求', '平常 Gi0/0/1 是 administratively down；主線不通時自動打開、恢復之後自動關掉；每次切換寫一筆 syslog'],
    ],
    learn: [
      { t: 'EEM 是設備自己的「如果…就…」', d: 'event manager applet 由一個事件 (event) 加上一串動作 (action) 組成：事件可以是某一筆 syslog（event syslog pattern "…"，用正規表示式比對）、追蹤物件改變狀態（event track 1 state down）、計時器、SNMP 的數值…。事件發生時，設備在自己身上照順序執行動作，不需要外部的管理主機。' },
      { t: 'cli command 從使用者模式開始', d: 'action 1.0 cli command "enable" 幾乎永遠是第一步，接著才是 configure terminal、interface …、no shutdown、end。少了 enable，後面的指令全部失敗，而且不會有任何提示 —— show event manager history events 看得到 applet 有被觸發，設定卻沒有變。' },
      { t: 'action 的標籤照字串排序', d: '標籤（1.0、2.0…）決定執行順序，但比較的是字串：10.0 會排在 2.0 前面。超過九步時用 01、02… 或 1.0、1.5、2.0 這種寫法。' },
      { t: '一個方向一個 applet', d: '「斷了就打開」與「好了就關掉」是兩個事件，寫成兩個 applet。只寫前一個的話，主線恢復之後 4G 還開著 —— 路由已經切回主線（因為 track 回到 Up），但介面開著就有背景流量在計費。' },
      { t: '什麼時候該用、什麼時候不該', d: 'EEM 適合「設備自己就該處理、等不到人」的事：開關備援介面、故障當下自動收集 show 的輸出、把特定的錯誤轉成明確的告警。能用協定本身的機制（追蹤的靜態路由、HSRP 的 track）解決的事不要用 EEM 重做；大範圍的設定變更交給 Ansible 這類集中式的工具。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'isp', { name: '光纖 ISP', pos: [-6, -10] }), 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' }),
        setLine(D('internet', 'lte', { name: '4G 業者（照流量計費）', pos: [6, -10] }), 'line1', { type: 'static', gw: '198.51.100.1', mask: '255.255.255.252', assign: '198.51.100.2' }),
        D('isr4331', 'rt', {
          name: 'Store-RT', pos: [0, -5],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.2', mask: '255.255.255.252', nat: true });
            Object.assign(d.ifaces[1], { ip: '198.51.100.2', mask: '255.255.255.252', nat: true, shut: true });
            Object.assign(d.ifaces[2], { ip: '192.168.1.1', mask: '255.255.255.0' });
          },
        }),
        D('sw5', 'sw', { name: '門市的交換器', pos: [0, 0] }),
        D('pc', 'pos', { name: 'POS 收銀機', pos: [-4, 4.5], ip: '192.168.1.20', gw: '192.168.1.1', dns: '8.8.8.8' }),
        D('pc', 'pc', { name: '店長的電腦', pos: [4, 4.5], ip: '192.168.1.30', gw: '192.168.1.1', dns: '8.8.8.8' }),
      ], [['isp:line1', 'rt:Gi0/0/0'], ['lte:line1', 'rt:Gi0/0/1'], ['rt:Gi0/0/2', 'sw:1'], ['pos:eth0', 'sw:2'], ['pc:eth0', 'sw:3']]);
      recompute(s);
      cfg(s, 'rt', ['ip sla 1', 'icmp-echo 1.1.1.1 source-interface Gi0/0/0', 'frequency 10', 'exit', 'ip sla schedule 1 life forever start-time now', 'track 1 ip sla 1 reachability',
        'ip route 0.0.0.0 0.0.0.0 203.0.113.1 track 1', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1 10', 'ip route 1.1.1.1 255.255.255.255 203.0.113.1']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pos', name: 'www.example.com', port: 443, label: '平常：POS 收銀機連得到雲端的服務（走光纖）' },
      {
        type: 'check', label: '平常 4G 的介面是關著的（administratively down），不會有流量被計費',
        test(s) {
          const i = dev(s, 'rt').ifaces.find((x) => x.id === 'Gi0/0/1');
          return i.shut ? true : 'Gi0/0/1（4G）現在是開著的：背景流量會被計費。它平常要 shutdown，由 EEM 在主線不通的時候才打開';
        },
      },
      { type: 'failover', label: '光纖 ISP 的骨幹故障（介面燈號正常）：路由器自己打開 4G，POS 照樣連得到雲端', ispFail: ['isp'], test: { type: 'tcp', from: 'pos', name: 'www.example.com', port: 443 } },
      {
        type: 'check', label: '主線恢復之後，4G 的介面自動關回去，而且兩次切換都有留下紀錄',
        test(s) {
          const c = cloneState(s);
          settle(c);
          c.devices.isp.inet = { ...c.devices.isp.inet, fault: true };
          settle(c);
          const g = () => c.devices.rt.ifaces.find((x) => x.id === 'Gi0/0/1');
          if (g().shut) return '模擬主線故障：track 1 變成 Down 之後，Gi0/0/1 沒有被打開（show event manager history events 看 applet 有沒有被觸發、第一步是不是 enable）';
          c.devices.isp.inet = { ...c.devices.isp.inet, fault: false };
          settle(c);
          if (!g().shut) return '模擬主線恢復：track 1 回到 Up 之後，Gi0/0/1 還開著。「好了就關掉」要另外寫一個 applet（event track 1 state up）';
          const logs = ((c.dyn.log || {}).rt || []).filter((x) => /HA_EM-6-LOG/.test(x.line));
          if (logs.length < 2) return `切換的時候沒有留下紀錄（只看到 ${logs.length} 筆 %HA_EM-6-LOG）：兩個 applet 都要有 action … syslog msg "…"`;
          return true;
        },
      },
    ],
    hints: [
      'Store-RT：show track（track 1 目前 Up）、show ip interface brief（Gi0/0/1 是 administratively down）。主線一故障，track 1 變 Down、往光纖的預設路由撤掉，但備援的介面是關的，浮動路由也用不了。',
      'event manager applet LTE-UP → event track 1 state down → action 1.0 cli command "enable"、action 2.0 cli command "configure terminal"、action 3.0 cli command "interface GigabitEthernet0/0/1"、action 4.0 cli command "no shutdown"、action 5.0 cli command "end"、action 6.0 syslog msg "Primary down, LTE backup enabled"。',
      '再寫一個 LTE-DOWN：event track 1 state up，動作一樣，只是第四步改成 shutdown、訊息改成 "Primary restored, LTE backup disabled"。寫完用 show event manager policy registered 檢查；不要自己手動 no shutdown Gi0/0/1。',
    ],
    solve(s) {
      const applet = (name, st, cmd, msg) => [`event manager applet ${name}`, `event track 1 state ${st}`, 'action 1.0 cli command "enable"', 'action 2.0 cli command "configure terminal"',
        'action 3.0 cli command "interface GigabitEthernet0/0/1"', `action 4.0 cli command "${cmd}"`, 'action 5.0 cli command "end"', `action 6.0 syslog msg "${msg}"`, 'exit'];
      cfg(s, 'rt', [...applet('LTE-UP', 'down', 'no shutdown', 'Primary down, LTE backup enabled'), ...applet('LTE-DOWN', 'up', 'shutdown', 'Primary restored, LTE backup disabled')]);
    },
    recap: ['EEM：事件（syslog、track…）加上一串動作，設備自己處理等不到人的事。', 'cli command 的第一步是 enable；「發生」與「恢復」各寫一個 applet。'],
  },
];
