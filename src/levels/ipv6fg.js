// 第九章補充：FortiGate 的 IPv6（WAN 的前綴委派、LAN 的委派子網路與 RA、政策的 srcaddr6 / dstaddr6）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { inet6, WEB6 } from './ipv6pd.js';
import { dev } from './util.js';

const PD = '2001:db8:61c0:2200::/56';
const one = [{ id: 'line1', label: '線路 1', media: 'rj45' }];
const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });

export const LEVELS39 = [
  // ════════════════════════ 9-10 ════════════════════════
  {
    id: 'l119', chapter: 9, title: '防火牆開了 IPv6，網站卻都打不開', subtitle: 'FortiGate 的 IPv6：前綴委派與 IPv6 政策', tags: ['IPv6', 'FortiGate', 'DHCPv6-PD', '防火牆政策', 'Happy Eyeballs'],
    brief: `同事在 FortiGate 上開了 IPv6：WAN 向 ISP 要前綴委派，辦公室 (internal) 也拿到 IPv6 位址了。但從那之後，有些網站要等好幾秒才開，用 IPv6 根本連不上。請讓辦公室與訪客網路 (dmz) 都能用 IPv6 上網；訪客不能用 IPv6 連進辦公室。`,
    given: [
      ['FortiGate 的 wan1', `IPv4 203.0.113.34/30 · IPv6：DHCPv6，ISP 委派 ${PD}`], ['internal（辦公室）', '192.168.1.1/24 · IPv6 已設定：委派的前綴切子網路 1'],
      ['dmz（訪客）', '192.168.2.1/24 · 還沒有 IPv6'], ['網站', `www.example.com · ${WEB6}`],
    ],
    learn: [
      { t: '政策要分 IPv4 與 IPv6', d: 'FortiOS 的政策用 srcaddr / dstaddr 比對 IPv4、srcaddr6 / dstaddr6 比對 IPv6，兩種可以寫在同一條政策裡。只寫了 IPv4 位址的政策不會放行 IPv6：介面開了 IPv6，政策沒有跟著加，IPv6 的流量就被隱含的拒絕擋掉。' },
      { t: '為什麼「要等好幾秒才開」', d: '電腦有全域 IPv6 位址時，會優先用 IPv6 連有 AAAA 的網站 (RFC 6724)。IPv6 被防火牆擋掉，就要等 Happy Eyeballs 或逾時才改用 IPv4 — 使用者看到的是「網站變慢」，不是「連不上」。' },
      { t: 'FortiGate 的前綴委派', d: 'WAN 的 config ipv6：set ip6-mode dhcp、set dhcp6-prefix-delegation enable 向 ISP 要前綴。LAN 介面 set ip6-mode delegated、set ip6-upstream-interface "wan1"、set ip6-subnet ::1:0:0:0:1/64 從委派的前綴切一個 /64，再 set ip6-send-adv enable 送 RA，電腦用 SLAAC 自己產生位址。' },
      { t: 'IPv6 沒有 NAT 的保護', d: 'IPv6 的位址都是全域可達的，沒有「NAT 順便擋住外面」這回事：網段之間、網際網路進來的流量，都要靠防火牆政策控管。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: one });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34', v6: { link: '2001:db8:ff00:61::/64', pd: PD } });
      inet.ifaces.find((i) => i.id === 'line1').ra = true;
      inet6(inet);
      const s = makeState([
        inet,
        D('fg60f', 'fg', {
          name: 'FortiGate', pos: [0, -3.5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33', mode6: 'auto', v6default: true, pd6: 'wan1' });
            Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0', gp6: { name: 'wan1', suffix: '::1:0:0:0:1/64' }, ra: true });
            Object.assign(g('dmz'), { ip: '192.168.2.1', mask: '255.255.255.0' });
            d.policies.push(allow('辦公室上網', 'internal', 'wan1', { nat: true }), allow('訪客上網', 'dmz', 'wan1', { nat: true }));
          },
        }),
        D('pc', 'pc1', { name: '辦公室 PC', pos: [-5, 3], ip: '192.168.1.21', gw: '192.168.1.1', dns: '8.8.8.8' }),
        D('laptop', 'pc2', { name: '訪客筆電', pos: [5, 3], ip: '192.168.2.31', gw: '192.168.2.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'fg:wan1'], ['pc1:eth0', 'fg:1'], ['pc2:eth0', 'fg:dmz']]);
      s.v6 = true;
      return s;
    },
    objectives: [
      { type: 'ping6', from: 'pc1', ip6: WEB6, label: '辦公室 PC 用 IPv6 ping 得到 www.example.com' },
      { type: 'ping6', from: 'pc1', ip6: WEB6, port: 443, label: '辦公室 PC 用 IPv6 開得了網站（TCP 443）' },
      { type: 'ping6', from: 'pc2', ip6: WEB6, label: '訪客筆電用 IPv6 ping 得到 www.example.com' },
      { type: 'ping6', from: 'pc2', to: 'pc1', expect: false, label: '訪客筆電用 IPv6 連不進辦公室（防火牆擋下）' },
    ],
    hints: [
      '辦公室 PC 的終端機：ping 2606:2800:220:1:248:1893:25c8:1946，封包追蹤會看到 FortiGate 的隱含拒絕：政策「辦公室上網」只寫了 IPv4 的位址。',
      'FortiGate →「政策」分頁：「辦公室上網」的 IPv6 來源位址與目的位址都填 all（CLI：set srcaddr6 "all"、set dstaddr6 "all"）。',
      'FortiGate →「介面」分頁的 dmz · IPv6：取得方式選「委派」，上游介面 wan1、子網路 ::2:0:0:0:1/64，發送 RA。',
      '「訪客上網」也要加上 IPv6 的 all。不要寫 dmz → any 或 dmz → internal 的 IPv6 政策：訪客只能往 wan1。',
    ],
    solve(s) {
      const d = dev(s, 'fg');
      for (const p of d.policies) Object.assign(p, { src6: 'all', dst6: 'all' });
      Object.assign(d.ifaces.find((i) => i.id === 'dmz'), { gp6: { name: 'wan1', suffix: '::2:0:0:0:1/64' }, ra: true });
    },
    recap: ['FortiGate 的政策分開比對 IPv4（srcaddr / dstaddr）與 IPv6（srcaddr6 / dstaddr6）：開了 IPv6 就要替政策加上 IPv6 的位址。', 'IPv6 被擋時，電腦會先試 IPv6 再退回 IPv4，使用者感覺到的是「變慢」；IPv6 沒有 NAT，網段之間要靠政策隔離。'],
  },
];
