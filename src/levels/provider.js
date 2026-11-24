// 第七章補充：站在業者那一端 — PE 的 VRF、route-target、PE 之間的 VPNv4，以及骨幹的 LDP 標籤
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { ldpNeighbors } from '../engine/mplsvpn.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });

/** 一台 PE：兩個客戶的 VRF、Loopback、骨幹介面、往 CE 的靜態路由、VPNv4 */
function pe(lo, core, coreIp, peer, cust, rtA) {
  return ['configure terminal',
    'vrf definition CUST-A', 'rd 64500:1', 'address-family ipv4', 'route-target export 64500:1', `route-target import ${rtA}`, 'exit-address-family', 'exit',
    'vrf definition CUST-B', 'rd 64500:2', 'address-family ipv4', 'route-target both 64500:2', 'exit-address-family', 'exit',
    'interface Loopback0', `ip address ${lo} 255.255.255.255`, 'exit',
    `interface ${core}`, `ip address ${coreIp} 255.255.255.252`, 'mpls ip', 'exit',
    'interface Gi0/0/1', 'vrf forwarding CUST-A', `ip address ${cust.a} 255.255.255.252`, 'exit',
    'interface Gi0/0/2', 'vrf forwarding CUST-B', `ip address ${cust.b} 255.255.255.252`, 'exit',
    `ip route vrf CUST-A ${cust.lan} 255.255.255.0 ${cust.ceA}`, `ip route vrf CUST-B ${cust.lan} 255.255.255.0 ${cust.ceB}`,
    'router ospf 1', 'router-id ' + lo, 'network 10.0.0.0 0.255.255.255 area 0', 'exit',
    'router bgp 64500', `neighbor ${peer} remote-as 64500`, `neighbor ${peer} update-source Loopback0`,
    'address-family vpnv4', `neighbor ${peer} activate`, 'exit-address-family',
    'address-family ipv4 vrf CUST-A', 'redistribute connected', 'redistribute static', 'exit-address-family',
    'address-family ipv4 vrf CUST-B', 'redistribute connected', 'redistribute static', 'exit-address-family',
    'end', 'write memory'];
}
const ce = (wan, lan, gw) => (d) => { ip4(d, 'Gi0/0/0', wan, '255.255.255.252'); ip4(d, 'Gi0/0/1', lan); (d.routes ||= []).push({ dst: '0.0.0.0', mask: '0.0.0.0', via: gw }); };

export const LEVELS91 = [
  {
    id: 'l171', chapter: 7, title: '兩家客戶，同一組位址', subtitle: '業者的 MPLS 骨幹：VRF、route-target、VPNv4 與 LDP', tags: ['MPLS', 'L3VPN', 'VRF', 'route-target', 'VPNv4', 'LDP'],
    brief: '這次你站在電信業者這一端。骨幹是 PE1 — P1 — PE2，兩家客戶（A 公司、B 公司）都在台北、台中各有一個據點，而且兩家剛好都用 10.1.0.0/24（台北）與 10.2.0.0/24（台中）。昨晚 P1 換了一台新的，今天早上兩家客戶都打電話來說台中連不到台北。另外，上週有人替 A 公司在 PE2 開通了 VRF。請修好，而且兩家公司的網路絕對不能混在一起。',
    given: [
      ['骨幹', 'OSPF area 0 · PE1 Lo0 10.255.0.1 · P1 Lo0 10.255.0.2 · PE2 Lo0 10.255.0.3 · AS 64500'],
      ['VRF', 'CUST-A：RD 64500:1、RT 64500:1 · CUST-B：RD 64500:2、RT 64500:2'],
      ['A 公司', '台北 ERP 10.1.0.10（CE 172.16.1.2）· 台中 PC 10.2.0.50（CE 172.16.2.2）'],
      ['B 公司', '台北伺服器 10.1.0.10（CE 172.16.101.2）· 台中 PC 10.2.0.50（CE 172.16.102.2）'],
    ],
    learn: [
      { t: 'VRF、RD 與 RT', d: '每個客戶一個 VRF（自己的路由表），所以位址可以重疊。RD（route distinguisher）讓兩家公司一樣的 10.1.0.0/24 在 BGP 裡變成不同的路（64500:1:10.1.0.0/24、64500:2:10.1.0.0/24）；RT（route-target）決定哪些路要放進哪個 VRF：export 是送出去時貼上的標記，import 是收進來時要找的標記。' },
      { t: 'VPNv4（MP-BGP）', d: 'PE 之間用 iBGP（Loopback 對 Loopback，update-source Loopback0）在 address-family vpnv4 底下交換客戶的路；address-family ipv4 vrf 底下的 redistribute connected / static 決定這個 VRF 要送出哪些路。show bgp vpnv4 unicast all 看得到每個 RD 底下的路。' },
      { t: 'LDP 與標籤', d: '核心的 P 路由器不知道客戶的路：PE 在封包上貼兩層標籤，內層是 VPN 標籤（給對面的 PE 看是哪個 VRF），外層是往對面 PE Loopback 的 LDP 標籤。骨幹每一段線的兩端都要 mpls ip，LDP 才會交換標籤；少一段，BGP 照樣是 Established、路也都在，封包卻在那一站被丟掉。' },
      { t: '怎麼查', d: 'show mpls ldp neighbor、show mpls interfaces 看 LDP；show bgp vpnv4 unicast all summary 看 VPNv4 鄰居與收到幾筆；show ip route vrf <名稱> 看 VRF 的路由表；show vrf detail 看 RD 與 RT；ping vrf <名稱> <IP> 從 VRF 裡測試。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'pe1', { name: 'PE1（台北）', pos: [-6, -6] }),
        D('isr4331', 'p1', { name: 'P1（新換的）', pos: [0, -8.5] }),
        D('isr4331', 'pe2', { name: 'PE2（台中）', pos: [6, -6] }),
        D('isr4321', 'cea1', { name: 'A 台北 CE', host: 'A-TPE-CE', pos: [-10, -1.5], init: ce('172.16.1.2', '10.1.0.1', '172.16.1.1') }),
        D('isr4321', 'ceb1', { name: 'B 台北 CE', host: 'B-TPE-CE', pos: [-3.5, -1.5], init: ce('172.16.101.2', '10.1.0.1', '172.16.101.1') }),
        D('isr4321', 'cea2', { name: 'A 台中 CE', host: 'A-TXG-CE', pos: [10, -1.5], init: ce('172.16.2.2', '10.2.0.1', '172.16.2.1') }),
        D('isr4321', 'ceb2', { name: 'B 台中 CE', host: 'B-TXG-CE', pos: [3.5, -1.5], init: ce('172.16.102.2', '10.2.0.1', '172.16.102.1') }),
        D('tower', 'srva', { name: 'A 公司的 ERP', pos: [-11, 3], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('tower', 'srvb', { name: 'B 公司的伺服器', pos: [-4, 3], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('pc', 'pca', { name: 'A 公司台中的 PC', pos: [11, 3], ip: '10.2.0.50', gw: '10.2.0.1' }),
        D('pc', 'pcb', { name: 'B 公司台中的 PC', pos: [4, 3], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [
        ['pe1:Gi0/0/0', 'p1:Gi0/0/0'], ['p1:Gi0/0/1', 'pe2:Gi0/0/0'],
        ['pe1:Gi0/0/1', 'cea1:Gi0/0/0'], ['pe1:Gi0/0/2', 'ceb1:Gi0/0/0'], ['pe2:Gi0/0/1', 'cea2:Gi0/0/0'], ['pe2:Gi0/0/2', 'ceb2:Gi0/0/0'],
        ['cea1:Gi0/0/1', 'srva:eth0'], ['ceb1:Gi0/0/1', 'srvb:eth0'], ['cea2:Gi0/0/1', 'pca:eth0'], ['ceb2:Gi0/0/1', 'pcb:eth0'],
      ]);
      recompute(s);
      typeIn(s, 'pe1', pe('10.255.0.1', 'Gi0/0/0', '10.0.12.1', '10.255.0.3', { a: '172.16.1.1', b: '172.16.101.1', lan: '10.1.0.0', ceA: '172.16.1.2', ceB: '172.16.101.2' }, '64500:1'));
      // PE2 的 CUST-A 是照著 CUST-B 複製的：匯入的 RT 忘了改
      typeIn(s, 'pe2', pe('10.255.0.3', 'Gi0/0/0', '10.0.23.2', '10.255.0.1', { a: '172.16.2.1', b: '172.16.102.1', lan: '10.2.0.0', ceA: '172.16.2.2', ceB: '172.16.102.2' }, '64500:2'));
      // 新換的 P1：往 PE2 那一段忘了 mpls ip
      typeIn(s, 'p1', ['configure terminal', 'interface Loopback0', 'ip address 10.255.0.2 255.255.255.255', 'exit',
        'interface Gi0/0/0', 'ip address 10.0.12.2 255.255.255.252', 'mpls ip', 'exit',
        'interface Gi0/0/1', 'ip address 10.0.23.1 255.255.255.252', 'exit',
        'router ospf 1', 'router-id 10.255.0.2', 'network 10.0.0.0 0.255.255.255 area 0', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pca', to: 'srva', port: 443, exact: true, label: 'A 公司台中的 PC 打得開自己台北的 ERP（https://10.1.0.10）' },
      { type: 'tcp', from: 'pcb', to: 'srvb', port: 443, exact: true, label: 'B 公司台中的 PC 打得開自己台北的伺服器' },
      {
        type: 'check', label: '兩家公司的 VRF 沒有混在一起，P1 和兩台 PE 都是 LDP 鄰居',
        test(s) {
          for (const id of ['pe1', 'pe2']) {
            const d = dev(s, id);
            const bad = (d.rt.routes || []).find((r) => r.mpls && r.vrf !== r.mpls.vrf);
            if (bad) return `${d.name} 的 VRF ${bad.vrf} 收進了 ${bad.mpls.vrf} 的路：兩家公司的網路混在一起了（看 route-target import）`;
          }
          const n = ldpNeighbors(s, dev(s, 'p1'));
          const up = n.filter((x) => x.up).map((x) => x.dev.id);
          if (!up.includes('pe1') || !up.includes('pe2')) return 'P1 還沒有和兩台 PE 都建立 LDP 鄰居（show mpls ldp neighbor）';
          return true;
        },
      },
    ],
    hints: [
      'PE1：show bgp vpnv4 unicast all summary，鄰居 10.255.0.3 是 Established、也收到了路；show ip route vrf CUST-B 有 10.2.0.0/24。控制平面都好好的，ping vrf CUST-B 10.2.0.1 卻不通。',
      'P1：show mpls ldp neighbor 只有 PE1；show mpls interfaces 少了 Gi0/0/1。interface Gi0/0/1 → mpls ip。',
      'B 公司通了，A 公司台中卻連到「B 公司的伺服器」？PE2：show vrf detail CUST-A，import 的 RT 是 64500:2（B 公司的）。vrf definition CUST-A → address-family ipv4 → no route-target import 64500:2 → route-target import 64500:1。',
    ],
    solve(s) {
      dev(s, 'p1').ifaces.find((i) => i.id === 'Gi0/0/1').mpls = true;
      Object.assign(dev(s, 'pe2').vrfs['CUST-A'], { rtImp: ['64500:1'] });
    },
    recap: ['RD 讓重疊的位址在 BGP 裡分得開，RT 決定路要放進哪個 VRF：import 打錯就會收到別家公司的路。', 'BGP Established、路由表也有路，不代表封包過得去：骨幹每一段都要有 LDP 標籤（mpls ip）。'],
  },
];
