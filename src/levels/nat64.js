// 第九章補充：IPv6-only 的網段連到只有 IPv4 的網站（NAT64 與 DNS64）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute, resolveName } from '../engine/sim.js';
import { transact6, globalIp6 } from '../engine/sim6.js';
import { parseCidr6, net6, fmtIp6 } from '../engine/ip6.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const DNS6 = '2001:db8:a00:2::53', N64 = '64:ff9b::/96', SYN = '64:ff9b::5db8:d822';
const one = [{ id: 'line1', label: '線路 1', media: 'rj45' }];
const inN64 = (ip) => { const c = parseCidr6(N64); return ip != null && net6(ip, 96) === net6(c.ip, 96); };

export const LEVELS40 = [
  // ════════════════════════ 9-11 ════════════════════════
  {
    id: 'l120', chapter: 9, title: '新大樓只有 IPv6，網站卻大多只有 IPv4', subtitle: 'NAT64 與 DNS64', tags: ['IPv6', 'NAT64', 'DNS64', 'IPv6-only', '過渡機制'],
    brief: `新大樓的網段決定只用 IPv6（IPv6-only），不再配 IPv4。電腦都拿到 IPv6 位址了，連得到公司的伺服器，但 www.example.com 這類只有 IPv4 的網站全部打不開。請用 NAT64 與 DNS64 讓新大樓的電腦連得到只有 IPv4 的網站；新大樓的電腦維持只有 IPv6。`,
    given: [
      ['新大樓 (R1 Gi0/0/1)', '2001:db8:a00:1::/64 · 只有 IPv6 · RA 的 O 旗標：DNS 伺服器由 DHCPv6 告知'], ['伺服器網段 (Gi0/0/2)', '10.1.0.0/24 與 2001:db8:a00:2::/64'],
      ['公司的 DNS 伺服器', `10.1.0.53 · ${DNS6} · 查不到的名稱轉送給 8.8.8.8`], ['R1 的 WAN (Gi0/0/0)', '203.0.113.34/30（只有 IPv4）'],
      ['NAT64 的前綴', `${N64}（Well-Known Prefix）`], ['網站', 'www.example.com · 93.184.216.34（只有 IPv4）'],
    ],
    learn: [
      { t: 'IPv6-only 與過渡', d: '雙協定 (dual stack) 要同時管理 IPv4 與 IPv6 兩套位址。IPv6-only 的網段只配 IPv6，省掉 IPv4 位址，但還是得連到只有 IPv4 的網站 — 這就要靠 NAT64 / DNS64 這類過渡機制。' },
      { t: 'DNS64', d: 'IPv6-only 的電腦查 AAAA。名稱只有 A 記錄的話，支援 DNS64 的 DNS 伺服器會「合成」一個 AAAA：NAT64 的前綴 + IPv4 位址，例如 93.184.216.34 → 64:ff9b::5db8:d822（5db8:d822 就是 93.184.216.34 的十六進位）。' },
      { t: 'NAT64', d: '路由器收到目的地在 64:ff9b::/96 的 IPv6 封包，把後面 32 位元還原成 IPv4 位址，來源換成自己外面介面的 IPv4（和 PAT 一樣多對一），用 IPv4 送出去；回應再換回 IPv6。IOS XE：nat64 prefix stateful、nat64 v6v4 list … overload，兩側的介面都要 nat64 enable。' },
      { t: '限制', d: 'NAT64 只處理 IPv6 → IPv4 的連線（從 IPv6-only 這一側發起）。程式裡寫死 IPv4 位址的軟體（不經過 DNS）用不到 DNS64，要靠電腦上的 464XLAT (CLAT) 之類的機制。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: one });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34' });
      const s = makeState([
        inet,
        D('isr4331', 'r1', {
          name: 'R1', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33', nat: true });
            Object.assign(d.ifaces[1], { ip6: '2001:db8:a00:1::1/64', ra: true, raO: true, dhcp6: 'NEWBLDG' });
            Object.assign(d.ifaces[2], { ip: '10.1.0.1', mask: '255.255.255.0', ip6: '2001:db8:a00:2::1/64', ra: true });
            d.dhcp6Pools = { NEWBLDG: { prefix: '', dns: [DNS6], domain: 'corp.example' } };
            d.v6routing = true;
          },
        }),
        D('sw8', 'sw1', { name: '新大樓交換器', pos: [-6, 0.5] }),
        D('sw8', 'sw2', { name: '機房交換器', pos: [6, -1] }),
        D('tower', 'dns', {
          name: 'DNS 伺服器', pos: [4, 3], ip: '10.1.0.53', gw: '10.1.0.1', dns: '8.8.8.8', services: [{ proto: 'udp', port: 53, name: 'DNS' }],
          init(d) {
            Object.assign(d.ifaces[0], { mode6: 'static', ip6: `${DNS6}/64`, gw6: '2001:db8:a00:2::1' });
            d.dnsZone = { records: [{ name: 'intranet.corp.example', type: 'A', value: '10.1.0.80', ttl: 300 }, { name: 'intranet.corp.example', type: 'AAAA', value: '2001:db8:a00:2::80', ttl: 300 }] };
            d.dnsForward = true;
          },
        }),
        D('tower', 'web', {
          name: '內部網站', pos: [10, 3], ip: '10.1.0.80', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }],
          init(d) { Object.assign(d.ifaces[0], { mode6: 'static', ip6: '2001:db8:a00:2::80/64', gw6: '2001:db8:a00:2::1' }); },
        }),
        D('laptop', 'pc1', { name: '新大樓筆電', pos: [-9, 5], init(d) { Object.assign(d.ifaces[0], { mode: 'static', ip: '', mask: '', gateway: '', dns: '' }); } }),
        D('pc', 'pc2', { name: '新大樓 PC', pos: [-3, 5], init(d) { Object.assign(d.ifaces[0], { mode: 'static', ip: '', mask: '', gateway: '', dns: '' }); } }),
      ], [['inet:line1', 'r1:Gi0/0/0'], ['r1:Gi0/0/1', 'sw1:1'], ['r1:Gi0/0/2', 'sw2:1'], ['dns:eth0', 'sw2:2'], ['web:eth0', 'sw2:3'], ['pc1:eth0', 'sw1:2'], ['pc2:eth0', 'sw1:3']]);
      s.v6 = true;
      return s;
    },
    objectives: [
      {
        type: 'check', label: `新大樓筆電查 www.example.com 的 AAAA，拿到 DNS64 合成的位址（${N64} 裡）`,
        test(s) {
          const r = resolveName(s, 'pc1', 'www.example.com', 0, { type: 'AAAA', nocache: true });
          if (!r.ok) return `新大樓筆電查不到 www.example.com 的 IPv6 位址：${r.reason}`;
          return inN64(r.ip6) || `查到 ${fmtIp6(r.ip6)}，不在 NAT64 的前綴 ${N64} 裡`;
        },
      },
      {
        type: 'check', label: '新大樓筆電開得了 https://www.example.com（經過 NAT64）',
        test(s) {
          const r = resolveName(s, 'pc1', 'www.example.com', 0, { type: 'AAAA', nocache: true });
          if (!r.ok) return `查不到 www.example.com 的 IPv6 位址：${r.reason}`;
          const t = transact6(s, 'pc1', r.ip6, { proto: 'tcp', dport: 443, quiet: true });
          return t.ok || `連不上 ${fmtIp6(r.ip6)}:443：${t.reason}`;
        },
      },
      { type: 'ping6', from: 'pc2', ip6: SYN, label: `新大樓 PC ping 得到 ${SYN}（93.184.216.34 經過 NAT64）` },
      {
        type: 'check', label: '新大樓筆電開得了內部網站 https://intranet.corp.example（有 IPv6，直接連，不經過 NAT64）',
        test(s) {
          const r = resolveName(s, 'pc1', 'intranet.corp.example', 0, { type: 'AAAA', nocache: true });
          if (!r.ok) return `查不到 intranet.corp.example 的 IPv6 位址：${r.reason}`;
          if (inN64(r.ip6)) return `intranet.corp.example 拿到合成的 ${fmtIp6(r.ip6)}：名稱有真的 AAAA 記錄時，DNS64 不該合成`;
          const t = transact6(s, 'pc1', r.ip6, { proto: 'tcp', dport: 443, quiet: true });
          return t.ok || `連不上 ${fmtIp6(r.ip6)}:443：${t.reason}`;
        },
      },
      {
        type: 'check', label: '新大樓維持只有 IPv6（電腦沒有 IPv4 位址）',
        test(s) {
          for (const id of ['pc1', 'pc2']) {
            const d = dev(s, id);
            if (d.ifaces[0].rt.ip != null) return `${d.name} 有 IPv4 位址：新大樓要維持 IPv6-only`;
            if (globalIp6(d) == null) return `${d.name} 沒有 IPv6 位址`;
          }
          return true;
        },
      },
    ],
    hints: [
      '新大樓筆電的終端機：nslookup www.example.com — 只有 A 記錄 (IPv4)，IPv6-only 的電腦用不到。',
      `DNS 伺服器 →「DNS」分頁：開啟 DNS64，前綴 ${N64}（只有 A 記錄的名稱會合成 AAAA）。`,
      'R1：ipv6 access-list NAT64-SRC → permit ipv6 2001:db8:a00:1::/64 any → exit；nat64 prefix stateful 64:ff9b::/96；nat64 v6v4 list NAT64-SRC interface gi0/0/0 overload。',
      'R1 的 interface gi0/0/1（IPv6 這一側）與 interface gi0/0/0（IPv4 這一側）都要 nat64 enable。',
    ],
    solve(s) {
      dev(s, 'dns').dns64 = N64;
      typeIn(s, 'r1', ['configure terminal', 'ipv6 access-list NAT64-SRC', 'permit ipv6 2001:db8:a00:1::/64 any', 'exit', 'nat64 prefix stateful 64:ff9b::/96',
        'nat64 v6v4 list NAT64-SRC interface gi0/0/0 overload', 'interface gi0/0/1', 'nat64 enable', 'exit', 'interface gi0/0/0', 'nat64 enable', 'end']);
      recompute(s);
    },
    recap: ['DNS64 替只有 A 記錄的名稱合成 AAAA（NAT64 的前綴 + IPv4 位址）；NAT64 把這種目的地的 IPv6 封包換成 IPv4 送出去，回應再換回來。', 'IPv6-only 的網段省掉 IPv4 位址，但要 DNS64 + NAT64 才連得到只有 IPv4 的世界；從 IPv6 這一側發起的連線才行得通。'],
  },
];
