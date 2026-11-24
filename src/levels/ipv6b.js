// 第九章補充：AAAA 記錄與雙協定（IPv6 優先、Happy Eyeballs）、IPv6 經過 IPv4 的 VPN（VTI 只載 IPv4、GRE 都可以）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute, dualStack } from '../engine/sim.js';
import { fmtIp6 } from '../engine/ip6.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
const WEB = 'www.corp.local';

export const LEVELS23 = [
  // ─────────────────────────────────────────────── AAAA 與雙協定
  {
    id: 'l93', chapter: 9, title: '內部網站加了 IPv6 之後', subtitle: 'AAAA 記錄、雙協定與 IPv6 優先', tags: ['IPv6', 'DNS', 'AAAA', '雙協定', 'Happy Eyeballs'],
    brief: '上週 IT 替內部網站 www.corp.local 加上了 IPv6，DNS 也多了一筆 AAAA 記錄。之後陸續有人反映：ping www.corp.local 逾時，瀏覽器雖然打得開，但每次都要「卡一下」；用 IP 位址 ping 網站卻都正常。還沒換新的舊電腦（只有 IPv4）完全沒事。請找出原因，讓雙協定的電腦真的用 IPv6 連上網站。',
    given: [
      ['R1', '使用者 10.10.0.0/24、2001:db8:10::/64（RA，SLAAC）· 伺服器 10.20.0.0/24、2001:db8:20::/64'],
      ['DNS 伺服器', `10.20.0.53 · ${WEB} 的 A 與 AAAA`], ['網站', '10.20.0.10、2001:db8:20::10（HTTPS）'],
      ['同事的電腦', 'Ubuntu，雙協定（IPv6 自動取得）'], ['舊電腦', '只有 IPv4'],
    ],
    learn: [
      { t: 'A 與 AAAA', d: 'A 記錄是 IPv4 位址，AAAA（quad-A）是 IPv6 位址。同一個名稱可以兩種都有：用戶端會兩種都問（nslookup 會把兩個位址都列出來，nslookup -type=aaaa 只問 AAAA）。' },
      { t: 'IPv6 優先', d: '電腦有全域的 IPv6 位址、名稱又有 AAAA 時，依 RFC 6724 的預設政策會先用 IPv6。ping 不會自己改用 IPv4：AAAA 寫錯或 IPv6 不通，ping 主機名稱就直接逾時。ping -4 / ping -6 可以指定用哪一種。' },
      { t: 'Happy Eyeballs', d: '瀏覽器和 curl 用 Happy Eyeballs（RFC 8305）：先試 IPv6，兩三百毫秒沒有回應就同時改試 IPv4，誰先連上用誰。所以 IPv6 壞掉時網頁照樣打得開，只是慢一點 — 這種問題很容易被忽略好幾個月。' },
      { t: '只有 IPv4 的電腦為什麼沒事', d: '沒有全域 IPv6 位址的電腦根本不會用 AAAA。所以「新電腦有問題、舊電腦沒事」「用 IP 正常、用名稱不行」，常常就是 IPv6 那一條路壞了。' },
      { t: '手動設定的伺服器', d: '伺服器的 IPv6 通常是手動設定，預設閘道也要手動填（或讓路由器在那個網段送 RA）。少了閘道，同網段沒事，跨網段的回應就送不回去。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'r1', { name: 'R1', pos: [0, -5] }),
        D('sw8', 'usw', { name: 'SW-Users', pos: [-6, -1] }), D('sw5', 'ssw', { name: 'SW-Servers', pos: [6, -1] }),
        D('pc', 'pca', { name: '同事的電腦', pos: [-8.5, 4], ip: '10.10.0.21', gw: '10.10.0.1', dns: '10.20.0.53' }),
        D('pc', 'old', { name: '舊電腦', pos: [-3.5, 4], ip: '10.10.0.40', gw: '10.10.0.1', dns: '10.20.0.53', init(d) { d.ifaces[0].mode6 = 'off'; } }),
        D('tower', 'dns', { name: 'DNS 伺服器', pos: [3.5, 4], ip: '10.20.0.53', gw: '10.20.0.1', services: [{ proto: 'udp', port: 53, name: 'DNS' }], init(d) {
          Object.assign(d.ifaces[0], { mode6: 'static', ip6: '2001:db8:20::53/64', gw6: '2001:db8:20::1' });
          d.dnsZone = { records: [{ name: WEB, type: 'A', value: '10.20.0.10', ttl: 300 }, { name: WEB, type: 'AAAA', value: '2001:db8:20::100', ttl: 300 }] };
        } }),
        D('tower', 'web', { name: '網站', pos: [8.5, 4], ip: '10.20.0.10', gw: '10.20.0.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS 網站' }], init(d) {
          Object.assign(d.ifaces[0], { mode6: 'static', ip6: '2001:db8:20::10/64' }); // 忘了填 IPv6 的預設閘道
        } }),
      ], [['r1:Gi0/0/0', 'usw:1'], ['r1:Gi0/0/1', 'ssw:1'], ['pca:eth0', 'usw:2'], ['old:eth0', 'usw:3'], ['dns:eth0', 'ssw:2'], ['web:eth0', 'ssw:3']]);
      s.v6 = true;
      recompute(s);
      typeIn(s, 'r1', ['configure terminal', 'ipv6 unicast-routing',
        'interface Gi0/0/0', 'ip address 10.10.0.1 255.255.255.0', 'ipv6 address 2001:db8:10::1/64', 'no shutdown',
        'interface Gi0/0/1', 'ip address 10.20.0.1 255.255.255.0', 'ipv6 address 2001:db8:20::1/64', 'ipv6 nd ra suppress all', 'no shutdown', 'end', 'write memory']);
      return fresh(s);
    },
    objectives: [
      {
        type: 'check', label: '同事的電腦 ping www.corp.local 會通，而且用的是 IPv6',
        test(s) {
          const r = dualStack(s, 'pca', WEB, { proto: 'icmp' });
          if (!r.ok) return `ping ${WEB} 逾時：${r.reason}`;
          if (r.family !== 6) return `用的是 IPv4（${r.why || '電腦沒有用 IPv6'}）`;
          return true;
        },
      },
      {
        type: 'check', label: '同事的瀏覽器直接用 IPv6 連上網站（不用等 Happy Eyeballs 改用 IPv4）',
        test(s) {
          const r = dualStack(s, 'pca', WEB, { proto: 'tcp', dport: 443, happy: true });
          if (!r.ok) return '打不開網站：' + r.reason;
          if (r.fallback) return `先試 IPv6 ${r.ip6 != null ? fmtIp6(r.ip6) : ''} 失敗（${r.fallback}），兩百多毫秒後才改用 IPv4 連上：這就是「卡一下」`;
          return true;
        },
      },
      { type: 'tcp', from: 'old', to: 'web', port: 443, label: '只有 IPv4 的舊電腦照常打得開網站' },
    ],
    hints: [
      '同事的電腦：ping www.corp.local 逾時，ping -4 www.corp.local 卻會通；nslookup www.corp.local 會列出兩個位址。ping 2001:db8:20::10（網站真正的 IPv6）也試試看。',
      'nslookup -type=aaaa www.corp.local：AAAA 記錄是 2001:db8:20::100，可是網站設定的是 2001:db8:20::10。到 DNS 伺服器的「DNS」分頁把 AAAA 改成 2001:db8:20::10。',
      '改好 AAAA 之後 ping -6 還是逾時：網站手動設定的 IPv6 沒有預設閘道，回應送不出伺服器網段。網站的「網路設定」把 IPv6 預設閘道填 2001:db8:20::1。（同事的電腦 DNS 快取還記著舊的 AAAA 的話，resolvectl flush-caches）',
    ],
    solve(s) {
      const rec = dev(s, 'dns').dnsZone.records.find((r) => r.type === 'AAAA');
      rec.value = '2001:db8:20::10';
      dev(s, 'web').ifaces[0].gw6 = '2001:db8:20::1';
      if (s.dyn && s.dyn.dnsCache) delete s.dyn.dnsCache.pca;
    },
    recap: ['有全域 IPv6 位址的電腦會優先用 AAAA；ping 不會改用 IPv4，瀏覽器的 Happy Eyeballs 會（所以只是變慢）。', '「用名稱不行、用 IP 可以、舊電腦沒事」先查 AAAA 和 IPv6 的路：nslookup -type=aaaa、ping -6。'],
  },
  // ─────────────────────────────────────────────── IPv6 經過 IPv4 的 VPN
  {
    id: 'l94', chapter: 9, title: 'IPv6 過不了 VPN', subtitle: 'VTI 只載 IPv4：改成 GRE over IPsec，在上面跑 OSPFv3', tags: ['IPv6', 'VTI', 'GRE', 'OSPFv3', 'IPsec'],
    brief: '總公司和分公司的內網都已經是雙協定，兩地之間是一條 VTI（IPsec），上面跑 OSPF。兩地的網際網路線路都只有 IPv4。同事在兩邊的 Tunnel0 加了 IPv6 位址、也開了 OSPFv3，可是分公司還是連不到總公司伺服器的 IPv6，OSPFv3 的鄰居也一直沒有出現。請讓分公司用 IPv6 連得到總公司的伺服器，兩地之間的流量（IPv4 與 IPv6）都要繼續加密。',
    given: [
      ['HQ-RT', 'WAN 203.0.113.2/30 · 內網 10.1.0.0/24、2001:db8:1::/64（伺服器 2001:db8:1::10，HTTPS）'],
      ['BR-RT', 'WAN 198.51.100.2/30 · 內網 10.2.0.0/24、2001:db8:2::/64（SLAAC）'],
      ['Tunnel0', 'HQ 10.255.0.1/30、2001:db8:ffff::1/64 ↔ BR 10.255.0.2/30、2001:db8:ffff::2/64 · tunnel protection ipsec profile VPN'],
      ['路由', 'OSPFv2 area 0（IPv4）、OSPFv3 process 1 area 0（IPv6）'],
    ],
    learn: [
      { t: 'VTI 只載送一種位址家族', d: 'tunnel mode ipsec ipv4 的 VTI，IPsec 的 proxy ID 是 0.0.0.0/0 ↔ 0.0.0.0/0：只有 IPv4 的封包能進去。在上面設 IPv6 位址不會報錯，但 IPv6 的封包（包括 OSPFv3 的 Hello）根本送不過去。' },
      { t: 'GRE 什麼都能載', d: 'GRE 的標頭裡有一個「協定類型」欄位（IPv4 是 0x0800、IPv6 是 0x86DD），同一條 Tunnel 可以同時載 IPv4 與 IPv6、也能帶 multicast。把 Tunnel 改成 tunnel mode gre ip，保留 tunnel protection，就成了 GRE over IPsec：兩種位址家族一起加密。' },
      { t: 'IPv6 跨過只有 IPv4 的網路', d: '常見的作法：GRE（協定 47）、6in4（tunnel mode ipv6ip，協定 41，只載 IPv6、少 4 位元組）、或兩端都支援的話用 IPv6 的 VTI。網際網路業者還沒提供 IPv6 時，這是讓分支機構先用起來的辦法。' },
      { t: 'OSPFv3 在 Tunnel 上', d: 'OSPFv3 用 link-local 位址建立鄰居，Tunnel 介面一樣會有 fe80:: 位址；直接在介面上 ipv6 ospf 1 area 0。Tunnel 預設是 point-to-point、cost 1000。' },
    ],
    setup() {
      const lines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
      const inet = D('internet', 'inet', { name: '網際網路（只有 IPv4）', pos: [0, -9.5], ports: lines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' });
      setLine(inet, 'line2', { type: 'static', gw: '198.51.100.1', mask: '255.255.255.252', assign: '198.51.100.2' });
      const s = makeState([
        inet, D('isr4331', 'hq', { name: 'HQ-RT', pos: [-7, -4] }), D('isr4331', 'br', { name: 'BR-RT', pos: [7, -4] }),
        D('tower', 'srv', { name: '總公司的伺服器', pos: [-7, 3], ip: '10.1.0.10', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS 網站' }], init(d) { Object.assign(d.ifaces[0], { mode6: 'static', ip6: '2001:db8:1::10/64', gw6: '2001:db8:1::1' }); } }),
        D('pc', 'bpc', { name: '分公司的電腦', pos: [7, 3], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [['inet:line1', 'hq:Gi0/0/0'], ['inet:line2', 'br:Gi0/0/0'], ['srv:eth0', 'hq:Gi0/0/1'], ['bpc:eth0', 'br:Gi0/0/1']]);
      s.v6 = true;
      recompute(s);
      const side = (id, wan, gw, lan4, lan6, t4, t6, peer, rid) => typeIn(s, id, ['configure terminal', 'ipv6 unicast-routing',
        'interface Gi0/0/0', `ip address ${wan} 255.255.255.252`, 'no shutdown',
        'interface Gi0/0/1', `ip address ${lan4} 255.255.255.0`, `ipv6 address ${lan6}`, 'ipv6 ospf 1 area 0', 'no shutdown', 'exit',
        `ip route 0.0.0.0 0.0.0.0 ${gw}`,
        'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit', `crypto isakmp key V6over4!26 address ${peer}`,
        'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'exit', 'crypto ipsec profile VPN', 'set transform-set TS', 'exit',
        'interface Tunnel0', `ip address ${t4} 255.255.255.252`, `ipv6 address ${t6}`, 'ipv6 ospf 1 area 0', 'tunnel source Gi0/0/0', `tunnel destination ${peer}`, 'tunnel mode ipsec ipv4', 'tunnel protection ipsec profile VPN', 'exit',
        'router ospf 1', `router-id ${rid}`, 'network 10.255.0.0 0.0.0.3 area 0', `network ${lan4.replace(/\.1$/, '.0')} 0.0.0.255 area 0`, 'exit', 'ipv6 router ospf 1', `router-id ${rid}`, 'end', 'write memory']);
      side('hq', '203.0.113.2', '203.0.113.1', '10.1.0.1', '2001:db8:1::1/64', '10.255.0.1', '2001:db8:ffff::1/64', '198.51.100.2', '1.1.1.1');
      side('br', '198.51.100.2', '198.51.100.1', '10.2.0.1', '2001:db8:2::1/64', '10.255.0.2', '2001:db8:ffff::2/64', '203.0.113.2', '2.2.2.2');
      return fresh(s);
    },
    objectives: [
      { type: 'ping6', from: 'bpc', to: 'srv', port: 443, label: '分公司的電腦用 IPv6 連得到總公司的伺服器（HTTPS）' },
      { type: 'tcp', from: 'bpc', to: 'srv', port: 443, label: 'IPv4 照常連得到總公司的伺服器' },
      {
        type: 'check', label: 'OSPFv3 在 Tunnel0 上是 FULL，而且兩地之間還是加密的（IPsec SA 還在）',
        test(s) {
          if (!(dev(s, 'hq').rt.nbrs6 || []).some((n) => n.dev === 'br' && n.state === 'full')) return 'HQ-RT 和 BR-RT 沒有 OSPFv3 的 FULL 鄰居';
          for (const id of ['hq', 'br']) {
            const t = dev(s, id).ifaces.find((i) => i.id === 'Tu0');
            if (!t || !t.tun.prot) return `${dev(s, id).name} 的 Tunnel0 沒有 tunnel protection：兩地之間的流量要加密`;
            if (!dev(s, id).rt.tunnels.some((x) => x.tif === 'Tu0' && x.up)) return `${dev(s, id).name} 的 Tunnel0 沒有建立 IPsec SA`;
          }
          return true;
        },
      },
    ],
    hints: [
      'HQ-RT：show ipv6 ospf neighbor 是空的，show ip ospf neighbor（IPv4）卻正常。show interfaces tunnel 0：Tunnel protocol/transport IPSEC/IP。',
      'tunnel mode ipsec ipv4 的 VTI 只載送 IPv4。兩邊的 Tunnel0 都改成 tunnel mode gre ip（tunnel protection 留著，就變成 GRE over IPsec），IPv4 與 IPv6 都能過。',
      '兩邊都要改：interface Tunnel0 → tunnel mode gre ip。IPsec 的 proxy ID 從 0.0.0.0/0 變成 gre host … host …，兩端一起改才對得上。',
    ],
    solve(s) {
      for (const id of ['hq', 'br']) typeIn(s, id, ['configure terminal', 'interface Tunnel0', 'tunnel mode gre ip', 'end', 'write memory']);
    },
    recap: ['VTI（tunnel mode ipsec ipv4）只載 IPv4；GRE 什麼都能載，加上 tunnel protection 一樣加密。', 'IPv6 要跨過只有 IPv4 的網路：GRE、6in4（ipv6ip），OSPFv3 照樣在 Tunnel 上用 link-local 建鄰居。'],
  },
];
