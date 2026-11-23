// 第七章補充：MPLS L3VPN（業者的 PE 與客戶的 CE 跑 eBGP，每個據點同一個 AS）
import { makeDevice as D, makeState } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });

export const LEVELS54 = [
  {
    id: 'l134', chapter: 7, title: '換成 MPLS 專線之後，分公司和總公司互相看不到', subtitle: 'MPLS L3VPN：CE 與 PE 的 eBGP、同一個 AS 與 allowas-in', tags: ['MPLS', 'L3VPN', 'BGP', 'allowas-in', 'as-override'],
    brief: '公司把總公司和分公司之間的專線換成業者的 MPLS VPN。業者給的規格是：每個據點的 CE 路由器用 eBGP 跟業者的 PE 交換路由，客戶所有據點都用同一個 AS 65010。兩邊的 BGP 鄰居都是 Established，業者那邊也看得到兩個網段，可是分公司的電腦就是連不到總公司的 ERP。請讓兩個據點互通，AS 號碼照業者的規定不能改。',
    given: [
      ['總公司 HQ-CE', 'AS 65010 · Gi0/0/0 172.16.1.2 ↔ PE 172.16.1.1 · 10.1.0.0/24（ERP 10.1.0.10）'],
      ['分公司 BR-CE', 'AS 65010 · Gi0/0/0 172.16.2.2 ↔ PE 172.16.2.1 · 10.2.0.0/24'],
      ['業者的 PE', 'AS 64500（業者的設備，客戶通常不能登入；這一關為了看清楚，可以看但最好不要改）'],
      ['規定', '所有據點都用 AS 65010；不可以用靜態路由'],
    ],
    learn: [
      { t: 'MPLS L3VPN', d: '業者在自己的骨幹裡替每個客戶開一個 VRF：客戶的路由只在自己的 VPN 裡流動，骨幹用 MPLS 標籤轉送，不同客戶的網段可以重疊。客戶這端的路由器叫 CE，業者那端的叫 PE；CE 和 PE 之間常用 eBGP（也可以用靜態路由或 OSPF）。' },
      { t: 'BGP 的迴圈偵測', d: 'eBGP 收到的路，AS_PATH 裡如果已經有自己的 AS，代表繞了一圈回來，直接丟掉。總公司送出的 10.1.0.0/24，經過業者到了分公司是「64500 65010」：分公司自己也是 65010，就把它當成迴圈丟掉了。' },
      { t: 'allowas-in 與 as-override', d: '客戶這端：neighbor <PE> allowas-in，允許 AS_PATH 裡出現自己的 AS（預設最多 3 次）。業者那端：neighbor <CE> as-override，送給 CE 之前把客戶的 AS 換成業者的 AS（變成 64500 64500）。兩種做法擇一；另一種做法是每個據點用不同的私有 AS。' },
      { t: '怎麼查', d: '業者那端 show ip bgp 看得到兩個網段；分公司 show ip bgp 只有自己的網段。show ip bgp summary 的 PfxRcd 是 0，最後會寫出有幾筆因為 AS_PATH loop 被丟掉。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'pe', { name: '業者 PE（MPLS）', pos: [0, -5], init(d) { ip4(d, 'Gi0/0/0', '172.16.1.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.16.2.1', '255.255.255.252'); } }),
        D('isr4321', 'hq', { name: 'HQ-CE', pos: [-7, -1.5], init(d) { ip4(d, 'Gi0/0/0', '172.16.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.1.0.1'); } }),
        D('isr4321', 'br', { name: 'BR-CE', pos: [7, -1.5], init(d) { ip4(d, 'Gi0/0/0', '172.16.2.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.2.0.1'); } }),
        D('sw8', 'hsw', { name: 'HQ-Switch', pos: [-9, 2.5] }),
        D('sw8', 'bsw', { name: 'BR-Switch', pos: [9, 2.5] }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-10.5, 6], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('pc', 'pc', { name: '分公司 PC', pos: [10.5, 6], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [['pe:Gi0/0/0', 'hq:Gi0/0/0'], ['pe:Gi0/0/1', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'hsw:1'], ['erp:eth0', 'hsw:2'], ['br:Gi0/0/1', 'bsw:1'], ['pc:eth0', 'bsw:2']]);
      recompute(s);
      typeIn(s, 'pe', ['configure terminal', 'router bgp 64500', 'neighbor 172.16.1.2 remote-as 65010', 'neighbor 172.16.2.2 remote-as 65010', 'end', 'write memory']);
      typeIn(s, 'hq', ['configure terminal', 'router bgp 65010', 'neighbor 172.16.1.1 remote-as 64500', 'network 10.1.0.0 mask 255.255.255.0', 'end', 'write memory']);
      typeIn(s, 'br', ['configure terminal', 'router bgp 65010', 'neighbor 172.16.2.1 remote-as 64500', 'network 10.2.0.0 mask 255.255.255.0', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'erp', port: 443, label: '分公司的電腦打得開總公司的 ERP（https://10.1.0.10）' },
      { type: 'ping', from: 'erp', to: 'pc', label: '總公司 ping 得到分公司的電腦' },
      {
        type: 'check', label: '兩個 CE 都還是 AS 65010，路是從 BGP 學到的（沒有靜態路由）',
        test(s) {
          for (const [id, other] of [['hq', '10.2.0.0'], ['br', '10.1.0.0']]) {
            const d = dev(s, id);
            if (!d.bgp || +d.bgp.asn !== 65010) return `${d.name} 的 BGP 不是 AS 65010：業者規定所有據點用同一個 AS`;
            if ((d.routes || []).some((r) => r.dst && /^10\./.test(r.dst))) return `${d.name} 有往另一個據點的靜態路由：規定要用 BGP 學到`;
            const r = d.rt.routes.find((x) => x.net === parseIp(other) && x.bits === 24);
            if (!r || r.type !== 'B') return `${d.name} 沒有從 BGP 學到 ${other}/24`;
          }
          return true;
        },
      },
    ],
    hints: [
      'BR-CE 的 CLI：show ip bgp summary 的鄰居是 Established，可是 show ip bgp 只有自己的 10.2.0.0/24。業者 PE 的 show ip bgp 兩個網段都有。',
      '業者送給分公司的 10.1.0.0/24，AS_PATH 是「64500 65010」。分公司自己也是 AS 65010：BGP 看到自己的 AS，當成迴圈丟掉了（show ip bgp summary 的最後一行就寫著被當成迴圈丟掉的筆數）。',
      'AS 不能改，就讓 CE 接受 AS_PATH 裡有自己的 AS：BR-CE → router bgp 65010 → neighbor 172.16.2.1 allowas-in。',
      '總公司也一樣：HQ-CE → router bgp 65010 → neighbor 172.16.1.1 allowas-in。（另一種做法是請業者在 PE 上 neighbor <CE> as-override。）',
    ],
    solve(s) {
      typeIn(s, 'br', ['configure terminal', 'router bgp 65010', 'neighbor 172.16.2.1 allowas-in', 'end', 'write memory']);
      typeIn(s, 'hq', ['configure terminal', 'router bgp 65010', 'neighbor 172.16.1.1 allowas-in', 'end', 'write memory']);
    },
    recap: [
      'BGP 用 AS_PATH 防止迴圈：看到自己的 AS 就丟掉。MPLS VPN 的每個據點用同一個 AS 時，要 allowas-in（客戶端）或 as-override（業者端）。',
      'MPLS L3VPN 對客戶來說就是「業者幫你跑 BGP」：CE 送出自己的網段，PE 在 VRF 裡轉給其他據點。',
    ],
  },
];
