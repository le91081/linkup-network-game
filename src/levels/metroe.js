// 第七章補充：Metro Ethernet 專線（EVPL）— 業者只把 CE-VLAN 100 對應到這條 EVC：路由器要用 802.1Q 子介面
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip) => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask: '255.255.255.0' });

export const LEVELS83 = [
  {
    id: 'l163', chapter: 7, title: '專線拉好了，兩邊卻不通', subtitle: 'Metro Ethernet：EVPL 與 CE-VLAN', tags: ['Metro Ethernet', 'E-Line', 'EVPL', '802.1Q', '專線'],
    brief: '總公司和分公司之間申請了電信業者的乙太網路專線（Metro Ethernet），業者說「線路測過了，燈都亮著」。工程師把兩邊路由器的 Gi0/0/0 設好 172.16.100.1 / .2，靜態路由也寫了，可是 ping 不過去。業者的服務文件上寫著：EVPL，CE-VLAN 100。請讓分公司連得到總公司的伺服器。',
    given: [
      ['專線', 'EVPL · CE-VLAN ID 100 · MTU 1522'], ['R-HQ Gi0/0/0 ↔ UNI A', '172.16.100.1/30（要用 VLAN 100）'], ['R-BR Gi0/0/0 ↔ UNI B', '172.16.100.2/30'],
      ['總公司', '10.1.0.0/24 · 伺服器 10.1.0.10'], ['分公司', '10.2.0.0/24 · PC 10.2.0.50'],
    ],
    learn: [
      { t: 'Metro Ethernet', d: '電信業者用乙太網路提供的專線：客戶端看到的就是一個乙太網路埠（UNI），兩個據點之間是一條 EVC（Ethernet Virtual Connection）。點對點的叫 E-Line，多點的叫 E-LAN（像一台很大的交換器）。' },
      { t: 'EPL 與 EVPL', d: 'EPL（Port-based）：整個埠透通，客戶送什麼標籤都過。EVPL（VLAN-based）：同一個埠可以有好幾條 EVC，業者用 CE-VLAN ID（客戶送的 802.1Q 標籤）決定送到哪一條，沒有對應的標籤（包括不帶標籤的）就丟掉。' },
      { t: '路由器怎麼接', d: 'EVPL 給的是 CE-VLAN 100：路由器要用子介面帶標籤送 — interface Gi0/0/0.100 → encapsulation dot1Q 100 → ip address。實體介面本身不設 IP。' },
      { t: 'MTU', d: 'Metro Ethernet 常見的 MTU 是 1522（1500 的資料加上 802.1Q 標籤）。客戶自己再加一層標籤（Q-in-Q）或封裝的話，要問業者支不支援更大的 MTU。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'hq', { name: 'R-HQ', pos: [-7, -5], init(d) { ip4(d, 'Gi0/0/1', '10.1.0.1'); } }),
        D('isr4321', 'br', { name: 'R-BR', pos: [7, -5], init(d) { ip4(d, 'Gi0/0/1', '10.2.0.1'); } }),
        D('metroe', 'me', {
          name: 'Metro Ethernet（業者）', pos: [0, -7.5], locked: true,
          init(d) {
            d.evc = { type: 'EVPL', ceVlans: [100], mtu: 1522 };
            d.sw.vlans.push({ id: 100, name: 'EVC-100' });
            for (const p of ['uni-a', 'uni-b']) Object.assign(d.sw.ports[p], { mode: 'trunk', allowed: '100', native: 0 });
            d.sw.stp.on = false;
          },
        }),
        D('tower', 'srv', { name: '伺服器', pos: [-7, 2.5], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('pc', 'pc', { name: '分公司 PC', pos: [7, 2.5], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [['hq:Gi0/0/0', 'me:uni-a'], ['br:Gi0/0/0', 'me:uni-b'], ['hq:Gi0/0/1', 'srv:eth0'], ['br:Gi0/0/1', 'pc:eth0']]);
      typeIn(s, 'hq', ['enable', 'configure terminal', 'interface Gi0/0/0', 'ip address 172.16.100.1 255.255.255.252', 'no shutdown', 'exit', 'ip route 10.2.0.0 255.255.255.0 172.16.100.2', 'end']);
      typeIn(s, 'br', ['enable', 'configure terminal', 'interface Gi0/0/0', 'ip address 172.16.100.2 255.255.255.252', 'no shutdown', 'exit', 'ip route 10.1.0.0 255.255.255.0 172.16.100.1', 'end']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'srv', port: 443, label: '分公司的 PC 連得到總公司的伺服器' },
      {
        type: 'check', label: '兩邊的路由器都用 VLAN 100 的子介面接專線',
        test(s) {
          for (const id of ['hq', 'br']) {
            const i = dev(s, id).ifaces.find((x) => x.bind.t === 'sub' && x.bind.port === 'Gi0/0/0' && x.bind.vlan === 100 && x.ip);
            if (!i) return `${dev(s, id).name} 還沒有 Gi0/0/0.100（encapsulation dot1Q 100）`;
          }
          return true;
        },
      },
    ],
    hints: [
      '點業者的 Metro Ethernet 看「專線資訊」：EVPL，只有 CE-VLAN 100 會送到對面，不帶標籤的訊框直接丟掉。路由器現在在實體介面上設 IP，送的是不帶標籤的訊框。',
      'R-HQ：interface Gi0/0/0 → no ip address；interface Gi0/0/0.100 → encapsulation dot1Q 100 → ip address 172.16.100.1 255.255.255.252。',
      'R-BR 也一樣（172.16.100.2）。靜態路由的下一站不用改：子介面還是同一個網段。',
    ],
    solve(s) {
      typeIn(s, 'hq', ['enable', 'configure terminal', 'interface Gi0/0/0', 'no ip address', 'interface Gi0/0/0.100', 'encapsulation dot1Q 100', 'ip address 172.16.100.1 255.255.255.252', 'end']);
      typeIn(s, 'br', ['enable', 'configure terminal', 'interface Gi0/0/0', 'no ip address', 'interface Gi0/0/0.100', 'encapsulation dot1Q 100', 'ip address 172.16.100.2 255.255.255.252', 'end']);
    },
    recap: ['Metro Ethernet 的 EVPL 依 CE-VLAN（802.1Q 標籤）決定送到哪一條 EVC，沒有對應的標籤就丟掉。', '業者給的是 VLAN 100，路由器就用 Gi0/0/0.100（encapsulation dot1Q 100）接專線。'],
  },
];
