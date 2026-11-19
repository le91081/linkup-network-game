// 第九章補充：DHCPv6（RA 的 M / O / A 旗標）、OSPFv3、IPv6 ACL
import { makeDevice as D, makeState } from '../engine/model.js';
import { parseIp6 } from '../engine/ip6.js';
import { dhcp6Bindings } from '../engine/sim6.js';
import { dev } from './util.js';

/** 路由器介面：IPv4 與 IPv6 位址一起設定 */
const rif = (d, n, o) => Object.assign(d.ifaces[n], o);
const DNS6 = '2001:db8:f::53';

export const LEVELS8 = [
  // ════════════════════════ 9-3 DHCPv6 ════════════════════════
  {
    id: 'l51', chapter: 9, title: '位址從哪裡來？', subtitle: 'RA 的 M / O / A 旗標、Stateless 與 Stateful DHCPv6', tags: ['DHCPv6', 'Router Advertisement', 'SLAAC'],
    brief: '辦公室的電腦用 SLAAC 自動產生 IPv6 位址，但沒有人告訴它們 DNS 伺服器在哪裡。實驗室為了稽核，要求每台電腦的位址都由 DHCPv6 發放、查得到紀錄，不准自己用 SLAAC 產生；前任管理員以為「有 DHCPv6 就夠了」，把實驗室介面的 RA 關掉了，結果實驗室的電腦有位址卻連不出去。',
    given: [
      ['辦公室（Gi0/0/0）', '2001:db8:10::/64，位址用 SLAAC，DNS 要從 DHCPv6 拿（stateless）'],
      ['實驗室（Gi0/0/1）', '2001:db8:20::/64，位址只能由 DHCPv6 發（stateful），已經有位址池 LAB'],
      ['伺服器網段（Gi0/0/2）', '2001:db8:f::/64 · DNS 伺服器 2001:db8:f::53'],
      ['網域名稱', 'corp.example'],
    ],
    learn: [
      { t: 'RA 的三個旗標', d: '路由器在 Router Advertisement 裡告訴主機怎麼設定：前綴的 A 旗標 = 可以用 SLAAC 自己產生位址；M 旗標 = 位址去問 DHCPv6（stateful）；O 旗標 = 位址自己產生，但 DNS 這些「其他設定」去問 DHCPv6（stateless）。' },
      { t: 'DHCPv6 不給預設閘道', d: '和 DHCPv4 最大的不同：DHCPv6 沒有「預設閘道」這個選項。主機的閘道永遠來自 RA（路由器的 link-local 位址）。所以就算全部改用 DHCPv6，RA 也不能關。' },
      { t: 'Windows 收不到 RA 時', d: '還是會自己試 stateful DHCPv6。如果網段上剛好有 DHCPv6 伺服器，就會拿到一個 /128 的位址 — 看起來設定好了，其實沒有閘道，出不了這個網段。' },
      { t: 'IOS 的寫法', d: 'ipv6 dhcp pool 建位址池（address prefix 給 stateful、dns-server、domain-name）；介面上 ipv6 dhcp server <位址池>，再用 ipv6 nd managed-config-flag / other-config-flag 設定旗標，ipv6 nd prefix default no-autoconfig 關掉 A 旗標。' },
    ],
    setup: () => {
      const s = makeState([
        D('isr4331', 'rt', {
          name: 'R1', pos: [0, -4.5],
          init(d) {
            d.v6routing = true;
            rif(d, 0, { ip6: '2001:db8:10::1/64', ra: true });
            // 前任管理員：「實驗室改用 DHCPv6 了，RA 用不到」→ 關掉了 RA
            rif(d, 1, { ip6: '2001:db8:20::1/64', ra: false, dhcp6: 'LAB' });
            rif(d, 2, { ip6: '2001:db8:f::1/64', ra: true });
            d.dhcp6Pools = { LAB: { prefix: '2001:db8:20::/64', dns: [DNS6], domain: 'corp.example' } };
          },
        }),
        D('sw5', 'swo', { name: '辦公室交換器', pos: [-6.5, 0] }),
        D('pc', 'pc1', { name: 'PC-1', pos: [-9.5, 4.5] }),
        D('pc', 'pc2', { name: 'PC-2', pos: [-4, 4.8] }),
        D('sw5', 'swl', { name: '實驗室交換器', pos: [6.5, 0] }),
        D('pc', 'lab', { name: '實驗室電腦', pos: [6.5, 4.8] }),
        D('tower', 'dns', {
          name: 'DNS 伺服器', pos: [0, 4.5], services: [{ proto: 'udp', port: 53, name: 'DNS' }, { proto: 'tcp', port: 80, name: '內部網站' }],
          init(d) { Object.assign(d.ifaces[0], { mode6: 'static', ip6: DNS6 + '/64', gw6: '2001:db8:f::1' }); },
        }),
      ], [['rt:Gi0/0/0', 'swo:1'], ['pc1:eth0', 'swo:2'], ['pc2:eth0', 'swo:3'], ['rt:Gi0/0/1', 'swl:1'], ['lab:eth0', 'swl:2'], ['dns:eth0', 'rt:Gi0/0/2']]);
      s.v6 = true;
      return s;
    },
    objectives: [
      {
        type: 'check', label: '辦公室電腦：位址用 SLAAC 產生，DNS 伺服器從 DHCPv6 拿到 2001:db8:f::53（stateless）',
        test(s) {
          for (const id of ['pc1', 'pc2']) {
            const d = dev(s, id), v = d.ifaces[0].rt.v6;
            if (!v.addrs.some((a) => a.src === 'slaac')) return `${d.name} 沒有 SLAAC 位址：${v.note || '沒有收到 RA'}`;
            if (v.addrs.some((a) => a.src === 'dhcp6')) return `${d.name} 從 DHCPv6 拿到了位址，但辦公室只要 DNS（應該設 O 旗標，不是 M 旗標）`;
            if (!v.dns.includes(parseIp6(DNS6))) return `${d.name} 沒有 IPv6 的 DNS 伺服器${v.dhcp && !v.dhcp.ok ? '：' + v.dhcp.why : v.ra && !v.ra.O ? '（RA 沒有設 O 旗標，主機不會去問 DHCPv6）' : ''}`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '實驗室電腦：位址只來自 DHCPv6（沒有自己用 SLAAC 產生的位址），而且有預設閘道',
        test(s) {
          const d = dev(s, 'lab'), v = d.ifaces[0].rt.v6;
          if (!v.addrs.some((a) => a.src === 'dhcp6')) return `實驗室電腦沒有 DHCPv6 位址${v.dhcp && !v.dhcp.ok ? '：' + v.dhcp.why : v.ra && !v.ra.M ? '（RA 沒有設 M 旗標）' : ''}`;
          if (v.addrs.some((a) => a.src === 'slaac')) return '實驗室電腦還自己用 SLAAC 產生了位址（稽核查不到）：要把 RA 前綴的 A 旗標關掉';
          if (v.gw == null) return '實驗室電腦沒有預設閘道：DHCPv6 不提供閘道，閘道只能從 RA 學到，而實驗室介面的 RA 被關掉了';
          return true;
        },
      },
      { type: 'ping6', from: 'lab', ip6: DNS6, label: '實驗室電腦 ping 得到 DNS 伺服器' },
      { type: 'ping6', from: 'pc1', ip6: DNS6, label: 'PC-1 ping 得到 DNS 伺服器' },
      {
        type: 'check', label: 'R1 的 DHCPv6 binding 查得到實驗室電腦（show ipv6 dhcp binding）',
        test(s) {
          const ll = dev(s, 'lab').ifaces[0].rt.v6.ll;
          return dhcp6Bindings(s, 'rt').some((b) => parseIp6(b.client) === ll) || 'R1 上沒有實驗室電腦的 binding';
        },
      },
    ],
    hints: [
      'R1 →「介面」最下方新增 DHCPv6 位址池 OFFICE：位址前綴留空（stateless 不發位址），DNS 2001:db8:f::53，網域 corp.example。Gi0/0/0 的 DHCPv6 選「這台當伺服器」、位址池 OFFICE，並打開 O 旗標。',
      '實驗室 Gi0/0/1：把「發送 Router Advertisement」打開（主機的閘道只能從 RA 學到），打開 M 旗標，關掉 A 旗標。',
      'CLI：ipv6 dhcp pool OFFICE → dns-server 2001:db8:f::53、domain-name corp.example；interface gi0/0/0 → ipv6 dhcp server OFFICE、ipv6 nd other-config-flag；interface gi0/0/1 → no ipv6 nd ra suppress、ipv6 nd managed-config-flag、ipv6 nd prefix default no-autoconfig。',
    ],
    solve(s) {
      const r = dev(s, 'rt');
      r.dhcp6Pools.OFFICE = { prefix: '', dns: [DNS6], domain: 'corp.example' };
      Object.assign(r.ifaces[0], { dhcp6: 'OFFICE', raO: true });
      Object.assign(r.ifaces[1], { ra: true, raM: true, raNoAuto: true });
    },
    recap: ['A 旗標管 SLAAC、M 旗標管位址、O 旗標管 DNS；三者可以自由組合。', 'DHCPv6 從來不給預設閘道，RA 永遠要開。在電腦上用 ipconfig /all 看得到 DHCPv6 的 DUID 與 IAID，在路由器上用 show ipv6 dhcp binding 查是誰拿了哪個位址。'],
  },

  // ════════════════════════ 9-4 OSPFv3 ════════════════════════
  {
    id: 'l52', chapter: 9, title: 'IPv6 也要動態路由', subtitle: 'OSPFv3、link-local 鄰居、Router ID', tags: ['OSPFv3', 'Router ID', 'passive-interface'],
    brief: '總部和兩個分公司三角形互連，IPv6 的位址都設定好了，但只有直連的網段通。請用 OSPFv3 讓三個網段互通，而且任何一條線斷了都還能繞路。分公司 B 是新設的純 IPv6 據點，路由器上沒有任何 IPv4 位址；分公司 A 的路由器則是前任管理員拿來測試過的。',
    given: [
      ['總部 R1', 'LAN 2001:db8:1::/64 · 往 R2 2001:db8:12::/64 · 往 R3 2001:db8:13::/64'],
      ['分公司 A R2', 'LAN 2001:db8:2::/64 · 往 R3 2001:db8:23::/64'],
      ['分公司 B R3', 'LAN 2001:db8:3::/64 · 純 IPv6，沒有 IPv4 位址'],
      ['OSPFv3', '全部 area 0，process 1；R3 的 Router ID 用 3.3.3.3'],
    ],
    learn: [
      { t: '在介面上啟用', d: 'OSPFv3 沒有 network 敘述，直接在每個介面下 ipv6 ospf 1 area 0。整台路由器也要先有 ipv6 unicast-routing。' },
      { t: 'link-local 鄰居', d: 'OSPFv3 的 Hello 用 link-local 位址送到 FF02::5，鄰居也用 link-local 認識彼此，路由的下一站是對方的 FE80:: 位址。兩端的全域前綴就算打錯，鄰居照樣建立得起來。' },
      { t: 'Router ID 還是 32 位元', d: 'OSPFv3 的 Router ID 和 OSPFv2 一樣是 IPv4 格式。路由器上有 IPv4 位址時會自動挑最大的；純 IPv6 的路由器選不出來，程序起不來（%OSPFv3-4-NORTRID），一定要手動設 router-id。' },
      { t: '被動介面', d: '接使用者的網段不需要送 Hello：passive-interface 讓網段照樣通告出去，但不會有人在那裡假冒成 OSPF 鄰居。' },
    ],
    setup: () => {
      const r = (id, name, pos, lan4, ifs) => D('isr4331', id, {
        name, pos,
        init(d) {
          d.v6routing = true;
          rif(d, 0, { ...(lan4 ? { ip: lan4, mask: '255.255.255.0' } : {}), ip6: ifs[0], ra: true });
          rif(d, 1, { ip6: ifs[1] });
          rif(d, 2, { ip6: ifs[2] });
        },
      });
      const s = makeState([
        r('r1', '總部 R1', [0, -6], '10.1.0.1', ['2001:db8:1::1/64', '2001:db8:12::1/64', '2001:db8:13::1/64']),
        r('r2', '分公司 A R2', [-7.5, 1], '10.2.0.1', ['2001:db8:2::1/64', '2001:db8:12::2/64', '2001:db8:23::2/64']),
        r('r3', '分公司 B R3', [7.5, 1], null, ['2001:db8:3::1/64', '2001:db8:13::3/64', '2001:db8:23::3/64']),
        D('pc', 'pc1', { name: '總部 PC', pos: [-6, -9] }),
        D('pc', 'pc2', { name: '分公司 A 的 PC', pos: [-12.5, 6] }),
        D('pc', 'pc3', { name: '分公司 B 的 PC', pos: [12.5, 6] }),
      ], [['r1:Gi0/0/1', 'r2:Gi0/0/1'], ['r1:Gi0/0/2', 'r3:Gi0/0/1'], ['r2:Gi0/0/2', 'r3:Gi0/0/2'],
        ['pc1:eth0', 'r1:Gi0/0/0'], ['pc2:eth0', 'r2:Gi0/0/0'], ['pc3:eth0', 'r3:Gi0/0/0']]);
      // 前任管理員測試時調過 R2 往總部那條線的 Hello，忘了改回來
      dev(s, 'r2').ifaces[1].ospf6Hello = 5;
      s.v6 = true;
      return s;
    },
    objectives: [
      { type: 'ping6', from: 'pc1', to: 'pc3', label: '總部 PC ping 得到分公司 B 的 PC' },
      { type: 'ping6', from: 'pc2', to: 'pc3', label: '分公司 A 的 PC ping 得到分公司 B 的 PC' },
      { type: 'ping6', from: 'pc3', to: 'pc1', label: '分公司 B 的 PC ping 得到總部 PC' },
      {
        type: 'check', label: 'R1 和 R2、R3 都是 OSPFv3 的 FULL 鄰居',
        test(s) {
          const d = dev(s, 'r1'), o = d.rt.ospf6;
          if (!o) return '總部 R1 還沒有在跑 OSPFv3';
          for (const id of ['r2', 'r3']) {
            const x = dev(s, id);
            if (x.rt.ospf6 && x.rt.ospf6.norid) return `${x.name} 的 OSPFv3 起不來：選不出 Router ID（純 IPv6 的路由器要手動設定 router-id）`;
            const n = (d.rt.nbrs6 || []).find((y) => y.dev === id);
            if (!n || n.state !== 'full') {
              const why = Object.values(o.ifs).flatMap((f) => f.why).find((w) => w.startsWith(x.name));
              return `R1 和 ${x.name} 不是 FULL 鄰居${why ? '：' + why.slice(x.name.length + 1) : ''}`;
            }
          }
          return true;
        },
      },
      {
        type: 'check', label: '三個使用者網段的介面是被動介面：網段照樣通告，但不送 OSPF Hello',
        test(s) {
          for (const id of ['r1', 'r2', 'r3']) {
            const d = dev(s, id), f = d.rt.ospf6 && d.rt.ospf6.ifs[d.ifaces[0].id];
            if (!f) return `${d.name} 的使用者網段（Gi0/0/0）沒有加入 OSPFv3，別的據點學不到這個網段`;
            if (f.state !== 'PASSIVE') return `${d.name} 的 Gi0/0/0 還在對使用者送 OSPF Hello：設成 passive-interface`;
          }
          return true;
        },
      },
      { type: 'failover', cut: [['r1', 'Gi0/0/2']], label: '總部到分公司 B 的線斷了，總部 PC 仍然連得到分公司 B（繞經分公司 A）', test: { type: 'ping6', from: 'pc1', to: 'pc3' } },
    ],
    hints: [
      '每台路由器的「介面」分頁：三個介面的 OSPFv3 區域都填 0。「路由」分頁的 OSPFv3 卡片會出現鄰居。',
      '分公司 B 的 R3 選不出 Router ID：在「路由」分頁的 OSPFv3 填 Router ID 3.3.3.3（CLI：ipv6 router ospf 1 → router-id 3.3.3.3）。',
      'R1 和 R2 起不來的話，看 show ipv6 ospf interface 或介面上的 OSPFv3 狀態：R2 的 Gi0/0/1 Hello 是 5 秒（no ipv6 ospf hello-interval）。最後在三台的 OSPFv3 把 Gi0/0/0 設成被動介面（passive-interface GigabitEthernet0/0/0）。',
    ],
    solve(s) {
      for (const id of ['r1', 'r2', 'r3']) {
        const d = dev(s, id);
        d.ospf6 = { passive: [d.ifaces[0].id] };
        for (const i of d.ifaces) i.ospf6Area = 0;
      }
      dev(s, 'r3').ospf6.rid = '3.3.3.3';
      delete dev(s, 'r2').ifaces[1].ospf6Hello;
    },
    recap: ['OSPFv3 和 OSPFv2 是兩個各自獨立的程序：鄰居、資料庫、路由表都分開。', '鄰居與下一站都是 link-local，所以 show ipv6 route 的 via 是 FE80:: 位址；Router ID 仍然是 32 位元，純 IPv6 的路由器一定要手動設。'],
  },

  // ════════════════════════ 9-5 IPv6 ACL ════════════════════════
  {
    id: 'l53', chapter: 9, title: '封了 IPv4，忘了 IPv6', subtitle: 'IPv6 ACL、隱含的 ND 允許規則', tags: ['IPv6 ACL', 'traffic-filter', 'Dual Stack'],
    brief: '訪客網路不應該能管理伺服器，也不應該碰到員工的電腦，只能開伺服器上的網站。IPv4 的 ACL 早就設好了，但這裡是雙協定網路：訪客的筆電改用 IPv6，一樣 SSH 得進伺服器。同事寫好了一份 IPv6 ACL「GUEST6」，還沒有套用到介面上。',
    given: [
      ['訪客（Gi0/0/0）', '10.50.0.0/24 · 2001:db8:50::/64'],
      ['伺服器（Gi0/0/1）', '10.10.0.10 · 2001:db8:10::10（網站 TCP 80、SSH TCP 22）'],
      ['員工（Gi0/0/2）', '10.20.0.0/24 · 2001:db8:20::/64'],
      ['政策', '訪客只能開伺服器的網站（IPv4 與 IPv6 都一樣）；員工可以 SSH 管理伺服器'],
    ],
    learn: [
      { t: '兩套 ACL', d: 'IPv4 的 ACL（ip access-group）完全管不到 IPv6 的流量。雙協定的網路，每一條防護都要用 IPv6 再寫一次：ipv6 access-list，再用 ipv6 traffic-filter <名稱> in|out 套到介面上。' },
      { t: '隱含的三條規則', d: '每一份 IPv6 ACL 結尾都隱含 permit icmp any any nd-na、permit icmp any any nd-ns、deny ipv6 any any。鄰居探索 (NDP) 取代了 ARP，沒有它連隔壁的閘道都找不到。' },
      { t: '自己寫的 deny ipv6 any any', d: '很多人習慣在最後補一條 deny any any（為了加上 log）。這一條會排在隱含的 ND 允許規則前面，結果整個網段的 IPv6 都斷了。要在它前面明確寫 permit icmp any any nd-ns 與 nd-na。' },
    ],
    setup: () => {
      const s = makeState([
        D('isr4331', 'rt', {
          name: 'R1', pos: [0, -4.5],
          init(d) {
            d.v6routing = true;
            rif(d, 0, { ip: '10.50.0.1', mask: '255.255.255.0', ip6: '2001:db8:50::1/64', ra: true,
              aclIn: [{ action: 'deny', proto: 'tcp', src: '10.50.0.0/24', dst: '10.10.0.0/24', port: '22' }, { action: 'deny', proto: 'ip', src: '10.50.0.0/24', dst: '10.20.0.0/24', port: '' }, { action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: '' }],
              aclNames: { in: 'GUEST-IN' } });
            rif(d, 1, { ip: '10.10.0.1', mask: '255.255.255.0', ip6: '2001:db8:10::1/64', ra: true });
            rif(d, 2, { ip: '10.20.0.1', mask: '255.255.255.0', ip6: '2001:db8:20::1/64', ra: true });
            // 同事寫好、還沒套用的 IPv6 ACL：只允許網站，其餘全部擋（習慣在最後補一條 deny）
            d.acl6 = { GUEST6: [
              { seq: 10, action: 'permit', proto: 'tcp', src: 'any', dst: 'host 2001:db8:10::10', port: '80' },
              { seq: 20, action: 'deny', proto: 'ipv6', src: 'any', dst: 'any' },
            ] };
          },
        }),
        D('laptop', 'guest', { name: '訪客筆電', pos: [-8, 2.5], ip: '10.50.0.50', gw: '10.50.0.1' }),
        D('tower', 'srv', {
          name: '伺服器', pos: [0, 4.5], ip: '10.10.0.10', gw: '10.10.0.1', services: [{ proto: 'tcp', port: 80, name: '網站' }, { proto: 'tcp', port: 22, name: 'SSH' }],
          init(d) { Object.assign(d.ifaces[0], { mode6: 'static', ip6: '2001:db8:10::10/64', gw6: '2001:db8:10::1' }); },
        }),
        D('pc', 'staff', { name: '員工電腦', pos: [8, 2.5], ip: '10.20.0.50', gw: '10.20.0.1' }),
      ], [['guest:eth0', 'rt:Gi0/0/0'], ['srv:eth0', 'rt:Gi0/0/1'], ['staff:eth0', 'rt:Gi0/0/2']]);
      s.v6 = true;
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'guest', ip: '10.10.0.10', port: 22, expect: false, label: 'IPv4：訪客 SSH 不到伺服器（原本就擋了）' },
      { type: 'ping6', from: 'guest', ip6: '2001:db8:10::10', proto: 'tcp', port: 22, expect: false, label: 'IPv6：訪客也 SSH 不到伺服器' },
      { type: 'ping6', from: 'guest', ip6: '2001:db8:10::10', proto: 'tcp', port: 80, label: 'IPv6：訪客開得了伺服器的網站' },
      { type: 'ping6', from: 'guest', to: 'staff', expect: false, label: 'IPv6：訪客連不到員工電腦' },
      { type: 'ping6', from: 'staff', ip6: '2001:db8:10::10', proto: 'tcp', port: 22, label: 'IPv6：員工可以 SSH 管理伺服器' },
    ],
    hints: [
      'R1 →「介面」：Gi0/0/0 的 IPv6 區塊，「IPv6 ACL：進入」選 GUEST6（CLI：interface gi0/0/0 → ipv6 traffic-filter GUEST6 in）。',
      '套用之後訪客的 IPv6 全斷了？ACL 最後那條 deny ipv6 any any 排在隱含的 ND 允許規則前面，訪客連 R1 的位址都問不到。',
      '在 GUEST6 最前面加上 permit icmp any any nd-ns 與 permit icmp any any nd-na（「ACL」分頁有「加上 ND 的允許規則」按鈕；CLI：ipv6 access-list GUEST6 → sequence 5 permit icmp any any nd-ns、sequence 6 permit icmp any any nd-na）。',
    ],
    solve(s) {
      const r = dev(s, 'rt');
      r.acl6.GUEST6.push({ seq: 5, action: 'permit', proto: 'icmp', src: 'any', dst: 'any', icmp: 'nd-ns' }, { seq: 6, action: 'permit', proto: 'icmp', src: 'any', dst: 'any', icmp: 'nd-na' });
      r.ifaces[0].acl6In = 'GUEST6';
    },
    recap: ['雙協定的網路，每一條 IPv4 的防護都要問一次：IPv6 呢？', 'IPv6 ACL 的結尾隱含允許 ND；自己寫了 deny ipv6 any any，就要記得在前面放行 nd-ns 與 nd-na。show ipv6 access-list 看得到每一條命中幾次。'],
  },
];
