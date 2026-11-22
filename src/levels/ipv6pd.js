// 第九章補充：網際網路的 IPv6 與 DHCPv6 Prefix Delegation（ISP 委派一整段前綴，路由器自己切成各個網段）
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { transact6, globalIp6 } from '../engine/sim6.js';
import { parseIp6, parseCidr6, net6, fmtIp6 } from '../engine/ip6.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
export const WEB6 = '2606:2800:220:1:248:1893:25c8:1946';
const PD = '2001:db8:4f20:7a00::/56', OLD = '2001:db8:1111:1::1/64';
const two = [{ id: 'line1', label: '線路 1', media: 'rj45' }];

/** 網際網路上的主機加上 IPv6 位址（AAAA） */
export function inet6(inet) {
  const six = { '8.8.8.8': '2001:4860:4860::8888', '1.1.1.1': '2606:4700:4700::1111', '93.184.216.34': WEB6 };
  for (const h of inet.inet.hosts) if (six[h.ip]) h.ip6 = six[h.ip];
  inet.inet.dns6 = { 'www.example.com': WEB6, 'example.com': WEB6, 'dns.google': '2001:4860:4860::8888' };
}

/** 從某台電腦 ping 網站的 IPv6 位址 */
const ping6 = (s, from) => transact6(s, from, parseIp6(WEB6), { quiet: true });
const inPd = (ip, pd) => { const c = parseCidr6(pd); return ip != null && net6(ip, c.bits) === net6(c.ip, c.bits); };

export const LEVELS38 = [
  // ════════════════════════ 9-9 ════════════════════════
  {
    id: 'l118', chapter: 9, title: '換了 ISP，IPv6 就上不了網', subtitle: 'DHCPv6 Prefix Delegation 與一般前綴', tags: ['IPv6', 'DHCPv6-PD', '一般前綴', 'SLAAC', 'ISP'],
    brief: `公司換了新的光纖業者。IPv4 一切正常，IPv6 卻完全上不了網：辦公室的電腦還拿著舊業者的 ${OLD.replace(/::1\/64$/, '::/64')} 位址。新業者不給固定的前綴，而是用 DHCPv6 Prefix Delegation 委派一段 /56 給路由器（日後可能會換）。請讓辦公室與訪客網路的電腦都能用 IPv6 連到 www.example.com；業者換了委派的前綴時，網路要自己跟著換，不用改設定。`,
    given: [
      ['R1 的 WAN (Gi0/0/0)', 'IPv4 203.0.113.34/30 · IPv6：業者送 RA（SLAAC），用 DHCPv6 PD 委派 /56'], ['R1 的辦公室 (Gi0/0/1)', `192.168.1.1/24 · 目前寫死舊業者的 ${OLD.toUpperCase()}`],
      ['R1 的訪客網路 (Gi0/0/2)', '192.168.2.1/24 · 還沒有 IPv6'], ['網站', `www.example.com · ${WEB6}`],
    ],
    learn: [
      { t: 'Prefix Delegation', d: 'ISP 不是只給路由器一個位址，而是用 DHCPv6 委派一整段前綴（家用常見 /56 或 /60，企業 /48），路由器自己切成好幾個 /64 給不同的網段。ISP 會把這段前綴的路由指回你的路由器，回程才找得到路。' },
      { t: '一般前綴 (general prefix)', d: 'IOS 在 WAN 上用 ipv6 dhcp client pd HOME 要前綴，存成名稱 HOME；LAN 介面寫 ipv6 address HOME ::1:0:0:0:1/64 — 前面 /56 由 ISP 決定，後面「子網路編號 1、主機 ::1」由你決定。ISP 換前綴時，所有用到 HOME 的位址自動跟著換。' },
      { t: '路由器的 WAN 也用 SLAAC', d: 'ipv6 address autoconfig default：WAN 依 ISP 的 RA 自己產生位址，並把 ISP 的路由器當成 IPv6 預設路由。路由器啟用了 ipv6 unicast-routing 之後，沒寫 default 就不會有預設路由。' },
      { t: '為什麼舊前綴不能用', d: '舊業者的前綴在新業者的網路上沒有路由：封包出得去，回程卻沒有人知道要送回你這裡。IPv6 沒有 NAT 可以幫你「換成自己的位址」，前綴一定要是 ISP 給的。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: two });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34', v6: { link: '2001:db8:ff00:12::/64', pd: PD } });
      inet.ifaces.find((i) => i.id === 'line1').ra = true;
      inet6(inet);
      const s = makeState([
        inet,
        D('isr4331', 'r1', {
          name: 'R1', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33', nat: true });
            Object.assign(d.ifaces[1], { ip: '192.168.1.1', mask: '255.255.255.0', ip6: OLD, ra: true });
            Object.assign(d.ifaces[2], { ip: '192.168.2.1', mask: '255.255.255.0' });
            d.v6routing = true;
          },
        }),
        D('sw8', 'sw1', { name: '辦公室交換器', pos: [-6, 0.5] }),
        D('sw8', 'sw2', { name: '訪客交換器', pos: [6, 0.5] }),
        D('pc', 'pc1', { name: '辦公室 PC', pos: [-8, 5], ip: '192.168.1.21', gw: '192.168.1.1', dns: '8.8.8.8' }),
        D('laptop', 'pc2', { name: '訪客筆電', pos: [8, 5], ip: '192.168.2.31', gw: '192.168.2.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'r1:Gi0/0/0'], ['r1:Gi0/0/1', 'sw1:1'], ['r1:Gi0/0/2', 'sw2:1'], ['pc1:eth0', 'sw1:2'], ['pc2:eth0', 'sw2:2']]);
      s.v6 = true;
      return s;
    },
    objectives: [
      { type: 'ping6', from: 'pc1', ip6: WEB6, label: '辦公室 PC 用 IPv6 連得到 www.example.com' },
      { type: 'ping6', from: 'pc2', ip6: WEB6, label: '訪客筆電用 IPv6 連得到 www.example.com' },
      {
        type: 'check', label: `兩個網段的電腦都拿到業者委派的前綴（${PD}）裡、不同的 /64`,
        test(s) {
          const a = globalIp6(dev(s, 'pc1')), b = globalIp6(dev(s, 'pc2'));
          if (!inPd(a, PD)) return `辦公室 PC 的 IPv6 位址是 ${a != null ? fmtIp6(a) : '（沒有）'}，不在業者委派的 ${PD} 裡`;
          if (!inPd(b, PD)) return `訪客筆電的 IPv6 位址是 ${b != null ? fmtIp6(b) : '（沒有）'}，不在業者委派的 ${PD} 裡`;
          return net6(a, 64) !== net6(b, 64) || '兩個網段用了同一個 /64：每個網段要從 /56 裡切一個不同的子網路';
        },
      },
      {
        type: 'check', label: '業者換了委派的前綴，網路自己跟著換（不用改設定）',
        test(s) {
          const s2 = cloneState(s), NEW = '2001:db8:9c31:b500::/56';
          s2.devices.inet.ifaces.find((i) => i.id === 'line1').line.v6.pd = NEW;
          recompute(s2); recompute(s2);
          for (const id of ['pc1', 'pc2']) {
            const r = ping6(s2, id);
            if (!r.ok) return `業者把委派的前綴換成 ${NEW} 之後，${s2.devices[id].name} 就連不上了：${r.reason}（LAN 的位址要用一般前綴 ipv6 address <名稱> ::1:0:0:0:1/64，不要寫死）`;
            if (!inPd(globalIp6(s2.devices[id]), NEW)) return `業者換了前綴之後，${s2.devices[id].name} 還在用舊的位址`;
          }
          return true;
        },
      },
    ],
    hints: [
      'R1 的 CLI：show ipv6 interface brief、ping 一下網站的 IPv6 位址。辦公室用的是舊業者的前綴：封包出得去，回程卻沒有路（新業者不知道這段前綴在你這裡）。',
      'WAN：interface gi0/0/0 → ipv6 address autoconfig default（用業者的 RA 自動取得位址與預設路由）→ ipv6 dhcp client pd ISP-PD（向業者要前綴，存成 ISP-PD）。show ipv6 general-prefix 看看拿到哪一段。',
      `辦公室：interface gi0/0/1 → no ipv6 address ${OLD} → ipv6 address ISP-PD ::1:0:0:0:1/64（子網路 1）。`,
      '訪客：interface gi0/0/2 → ipv6 address ISP-PD ::2:0:0:0:1/64（子網路 2）。電腦會依路由器的 RA 自己產生位址 (SLAAC)。',
    ],
    solve(s) {
      typeIn(s, 'r1', ['configure terminal', 'interface gi0/0/0', 'ipv6 address autoconfig default', 'ipv6 dhcp client pd ISP-PD', 'exit',
        'interface gi0/0/1', `no ipv6 address ${OLD}`, 'ipv6 address ISP-PD ::1:0:0:0:1/64', 'exit', 'interface gi0/0/2', 'ipv6 address ISP-PD ::2:0:0:0:1/64', 'end']);
      recompute(s);
    },
    recap: ['ISP 用 DHCPv6 Prefix Delegation 委派一段前綴（例如 /56），路由器用一般前綴把它切成各網段的 /64，ISP 再把這段前綴的路由指回來。', 'LAN 的位址寫成「一般前綴 + 子網路編號」：ISP 換前綴時自動跟著換；自己編或舊業者的前綴在網際網路上沒有回程路由。'],
  },
];
