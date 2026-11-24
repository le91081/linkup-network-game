// 第二十章：專家情境（CCIE 等級）。一張比較大的拓撲、好幾張互相獨立的工單，橫跨好幾種技術，
// 另外有全域的限制（不准加靜態路由、不能動業者的設備…）。和實作考試一樣：先把整張圖讀懂，再一張一張處理，
// 修好一個地方之後要回頭確認沒有弄壞別的。
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { parseIp, fmtIp } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute, settle, transact } from '../engine/sim.js';
import { dev, WEB } from './util.js';

export const CHAPTERS14 = [
  { id: 20, title: '專家情境', desc: 'CCIE 等級：一張大拓撲、好幾張工單，OSPF 多區域、DMVPN、IPsec、NAT、ACL、MPLS 混在一起，還有不能違反的設計限制。' },
];

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const cfg = (s, id, lines) => typeIn(s, id, ['enable', 'configure terminal', ...lines, 'end', 'write memory']);
const ifIp = (name, ip, mask = '255.255.255.252', more = []) => [`interface ${name}`, `ip address ${ip} ${mask}`, ...more, 'exit'];
const routed = (name, ip, mask = '255.255.255.252', more = []) => [`interface ${name}`, 'no switchport', `ip address ${ip} ${mask}`, ...more, 'exit'];
const lines = (n) => Array.from({ length: n }, (_, k) => ({ id: 'line' + (k + 1), label: '線路 ' + (k + 1), media: 'rj45' }));
/** 網際網路：每一條線路是一個固定 IP 的客戶（[ISP 閘道, 客戶的位址]） */
const inetOf = (pos, defs, hosts = []) => {
  const inet = D('internet', 'inet', { name: '網際網路', pos, ports: lines(defs.length) });
  defs.forEach(([gw, ip], k) => setLine(inet, 'line' + (k + 1), { type: 'static', gw, mask: '255.255.255.252', assign: ip }));
  inet.inet.hosts.push(...hosts);
  return inet;
};
const SSH = { proto: 'tcp', port: 22, name: 'SSH' };
const IKE = ['crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit'];
const ipsec = (key) => [...IKE, `crypto isakmp key ${key} address 0.0.0.0`, 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode transport', 'exit', 'crypto ipsec profile DMVPN', 'set transform-set TS', 'exit'];
const tunnel = (ip, extra) => ['interface Tunnel0', `ip address ${ip} 255.255.255.0`, 'ip nhrp authentication FL2026', 'ip nhrp network-id 1', ...extra, 'ip ospf network broadcast',
  'tunnel source Gi0/0/0', 'tunnel mode gre multipoint', 'tunnel key 100', 'tunnel protection ipsec profile DMVPN', 'exit'];
const NAT = ['access-list 1 permit 10.0.0.0 0.255.255.255', 'ip nat inside source list 1 interface Gi0/0/0 overload'];
/** 這台設備的靜態路由有幾條（設計上只有邊界與分公司各一條往 ISP 的預設路由） */
const statics = (s, id) => (dev(s, id).routes || []).length;

export const LEVELS97 = [
  {
    id: 'l184', chapter: 20, title: '接手的第一天：六張工單', subtitle: '企業骨幹總驗收：OSPF 多區域、預設路由的主備、NAT、DMVPN + IPsec、ACL', tags: ['OSPF', 'stub', 'DMVPN', 'IPsec', 'NAT', 'ACL', '預設路由', '故障排除'],
    noDrill: true,
    brief: '你接手一家物流公司的網路。總公司有兩條網際網路（Edge-1 主線、Edge-2 備援）、核心交換器與機房；兩家分公司用 DMVPN 連回 Edge-1。前任留下六張沒結案的工單：機房連不到、上網走的是備援線、備援線從來沒通過、高雄分公司的通道起不來、台中分公司連不到 ERP、資安要求分公司只能用 HTTPS 連 ERP。請全部處理完，而且不能用靜態路由繞過問題。',
    given: [
      ['OSPF', 'area 0：Edge-1、Edge-2、Core · area 10（機房，totally stubby）：Core ↔ DC-RT 10.50.0.0/22 · area 20（DMVPN）：通道 10.20.0.0/24、台中 10.21.0.0/24、高雄 10.22.0.0/24'],
      ['網際網路', 'Edge-1 203.0.113.2（主線）· Edge-2 198.51.100.2（備援）· 兩台都做 NAT overload，把預設路由送進 OSPF'],
      ['DMVPN', 'hub：Edge-1 Tunnel0 10.20.0.1 · 台中 BR-TXG 10.20.0.11 · 高雄 BR-KHH 10.20.0.12 · IPsec 預先共用金鑰 Dmvpn!2026'],
      ['主機', '總公司 PC 10.10.10.50 · ERP 10.50.1.10（HTTPS 443、SSH 22）· 台中 POS 10.21.0.50 · 高雄 PC 10.22.0.50、NVR 10.22.0.30（RTSP 554）'],
      ['限制', '不新增靜態路由（邊界與分公司原本各有一條往 ISP 的預設路由）· 機房的路由表只能有預設路由與自己的網段'],
    ],
    learn: [
      { t: '先讀圖，再動手', d: '大型的題目不要從第一張工單開始悶著頭修。先在每一台看 show ip ospf neighbor、show ip route、show ip interface brief、show dmvpn，把「哪些鄰居該有卻沒有」列出來。很多工單其實是同一個原因，也有的工單要等前一張修好才看得到症狀。' },
      { t: 'stub 區域兩端要一致', d: 'OSPF Hello 裡有區域類型的旗標（E-bit、N-bit），兩端不一樣就不會成為鄰居。stub、totally stubby（ABR 加 no-summary）、NSSA 是三種不同的類型：區域裡每一台都要設成同一種，no-summary 只需要設在 ABR。' },
      { t: '兩個出口的預設路由', d: 'default-information originate 送出來的是 Type-5 的 E2 路由：E2 的 metric 不會沿路累加，所以全網只看「誰送出來的 metric 比較小」，和距離遠近無關。主線設小的、備援設大的。沒有加 always 的話，自己的預設路由不見了就會停止送出，流量自動換到另一台。' },
      { t: '備援要真的測過', d: '主線正常的時候，備援線上的錯誤不會有任何症狀：NAT 少一行、ACL 少一條，都要等主線斷了才發現。每次變更之後把主線拔掉測一次，是唯一可靠的方法。' },
      { t: 'DMVPN 的三層', d: '由下往上查：① 底層到得了 hub 的公用位址嗎（ping）；② IPsec 的第一階段起得來嗎（show crypto isakmp sa：金鑰、提案）；③ NHRP 註冊了嗎（show dmvpn）；④ 路由協定的鄰居起來了嗎（show ip ospf neighbor）。下面一層沒好，上面的都不用看。' },
      { t: 'ACL 的順序', d: 'ACL 由上往下比對，第一條符合的就決定了。「先拒絕整個網段、再允許其中一種流量」永遠不會允許到：範圍小的例外要寫在前面。用序號插入（ip access-list extended 名稱 → 5 permit …）或 no 10 刪掉重排。' },
    ],
    setup() {
      const s = makeState([
        inetOf([0, -17], [['203.0.113.1', '203.0.113.2'], ['198.51.100.1', '198.51.100.2'], ['192.0.2.1', '192.0.2.2'], ['192.0.2.5', '192.0.2.6']],
          [{ ip: '93.184.216.34', name: '公開網站', services: WEB }]),
        D('isr4331', 'e1', { name: 'Edge-1（主線）', host: 'Edge-1', pos: [-5, -11] }),
        D('isr4331', 'e2', { name: 'Edge-2（備援）', host: 'Edge-2', pos: [5, -11] }),
        D('c9300', 'core', { name: 'Core', pos: [0, -6] }),
        D('isr4331', 'dc', { name: 'DC-RT', pos: [0, -1] }),
        D('tower', 'erp', { name: 'ERP', pos: [0, 4], ip: '10.50.1.10', gw: '10.50.1.1', services: [...WEB, SSH] }),
        D('pc', 'hqpc', { name: '總公司 PC', pos: [5.5, -4], ip: '10.10.10.50', gw: '10.10.10.1', dns: '8.8.8.8' }),
        D('isr4331', 'br1', { name: 'BR-TXG（台中）', host: 'BR-TXG', pos: [-13, -9] }),
        D('pc', 'pos1', { name: '台中的 POS', pos: [-13, -3.5], ip: '10.21.0.50', gw: '10.21.0.1' }),
        D('isr4331', 'br2', { name: 'BR-KHH（高雄）', host: 'BR-KHH', pos: [13, -9] }),
        D('pc', 'pc2', { name: '高雄的 PC', pos: [11, -3.5], ip: '10.22.0.50', gw: '10.22.0.1' }),
        D('nas', 'nvr2', { name: '高雄的 NVR', pos: [15, -3.5], ip: '10.22.0.30', gw: '10.22.0.1', services: [{ proto: 'tcp', port: 554, name: 'RTSP 監視器串流' }] }),
        D('sw5', 'sw2', { name: '高雄的小交換器', pos: [13, -6] }),
      ], [
        ['inet:line1', 'e1:Gi0/0/0'], ['inet:line2', 'e2:Gi0/0/0'], ['inet:line3', 'br1:Gi0/0/0'], ['inet:line4', 'br2:Gi0/0/0'],
        ['e1:Gi0/0/2', 'e2:Gi0/0/2'], ['e1:Gi0/0/1', 'core:Gi1/0/1'], ['e2:Gi0/0/1', 'core:Gi1/0/2'], ['core:Gi1/0/23', 'dc:Gi0/0/0'], ['dc:Gi0/0/1', 'erp:eth0'], ['core:Gi1/0/10', 'hqpc:eth0'],
        ['br1:Gi0/0/1', 'pos1:eth0'], ['br2:Gi0/0/1', 'sw2:1'], ['sw2:2', 'pc2:eth0'], ['sw2:3', 'nvr2:eth0'],
      ]);
      recompute(s);
      const inside = ['ip nat inside'];
      // Edge-1：主線、DMVPN 的 hub（area 0 / 20 的 ABR）。預設路由 metric 10
      cfg(s, 'e1', [...ifIp('Gi0/0/0', '203.0.113.2', '255.255.255.252', ['ip nat outside']), ...ifIp('Gi0/0/1', '10.0.1.1', '255.255.255.252', inside), ...ifIp('Gi0/0/2', '10.0.0.1', '255.255.255.252', inside),
        'ip route 0.0.0.0 0.0.0.0 203.0.113.1', ...NAT, ...ipsec('Dmvpn!2026'), ...tunnel('10.20.0.1', ['ip nhrp map multicast dynamic', 'ip nat inside']),
        'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.255.255 area 0', 'network 10.20.0.0 0.0.0.255 area 20', 'default-information originate metric 10', 'exit']);
      // Edge-2：備援。工單二：預設路由的 metric 5 比主線還小；工單三：WAN 介面忘了 ip nat outside（從來沒測過）
      cfg(s, 'e2', [...ifIp('Gi0/0/0', '198.51.100.2'), ...ifIp('Gi0/0/1', '10.0.2.1', '255.255.255.252', inside), ...ifIp('Gi0/0/2', '10.0.0.2', '255.255.255.252', inside),
        'ip route 0.0.0.0 0.0.0.0 198.51.100.1', ...NAT,
        'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.0.0 0.0.255.255 area 0', 'default-information originate metric 5', 'exit']);
      // Core：area 0 / 10 的 ABR。工單一：機房那一區被設成 nssa（DC-RT 是 stub）
      cfg(s, 'core', ['ip routing', ...routed('Gi1/0/1', '10.0.1.2'), ...routed('Gi1/0/2', '10.0.2.2'), ...routed('Gi1/0/23', '10.50.0.1'), ...routed('Gi1/0/10', '10.10.10.1', '255.255.255.0'),
        'router ospf 1', 'router-id 3.3.3.3', 'network 10.0.0.0 0.0.255.255 area 0', 'network 10.10.10.0 0.0.0.255 area 0', 'network 10.50.0.0 0.0.3.255 area 10',
        'passive-interface Gi1/0/10', 'area 10 nssa', 'exit']);
      // DC-RT：工單五、六：保護 ERP 的 ACL 順序寫反了（先擋掉整個分公司，後面的 permit 永遠比不到）
      cfg(s, 'dc', ['ip access-list extended DC-IN', '10 deny ip 10.20.0.0 0.3.255.255 any', '20 permit tcp 10.20.0.0 0.3.255.255 host 10.50.1.10 eq 443', '30 permit ip any any', 'exit',
        ...ifIp('Gi0/0/0', '10.50.0.2', '255.255.255.252', ['ip access-group DC-IN in']), ...ifIp('Gi0/0/1', '10.50.1.1', '255.255.255.0'),
        'router ospf 1', 'router-id 4.4.4.4', 'network 10.50.0.0 0.0.3.255 area 10', 'passive-interface Gi0/0/1', 'area 10 stub', 'exit']);
      const spoke = (id, wan, gw, tip, lan, rid, key) => cfg(s, id, [...ifIp('Gi0/0/0', wan), ...ifIp('Gi0/0/1', lan + '.1', '255.255.255.0'), `ip route 0.0.0.0 0.0.0.0 ${gw}`, ...ipsec(key),
        ...tunnel(tip, ['ip nhrp nhs 10.20.0.1 nbma 203.0.113.2 multicast', 'ip ospf priority 0']),
        'router ospf 1', `router-id ${rid}`, 'network 10.20.0.0 0.0.0.255 area 20', `network ${lan}.0 0.0.0.255 area 20`, 'passive-interface Gi0/0/1', 'exit']);
      spoke('br1', '192.0.2.2', '192.0.2.1', '10.20.0.11', '10.21.0', '11.11.11.11', 'Dmvpn!2026');
      // 工單四：高雄的金鑰是去年的
      spoke('br2', '192.0.2.6', '192.0.2.5', '10.20.0.12', '10.22.0', '12.12.12.12', 'Dmvpn!2025');
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'hqpc', to: 'erp', port: 443, label: '工單一：總公司的 PC 打得開機房的 ERP' },
      {
        type: 'check', label: '機房是 totally stubby：DC-RT 的路由表只有預設路由與自己的網段',
        test(s) {
          const d = dev(s, 'dc');
          if (!(d.rt.nbrs || []).some((n) => n.dev === 'core' && n.state === 'full')) return 'DC-RT 和 Core 不是 FULL 的 OSPF 鄰居（show ip ospf neighbor）：兩端的區域類型要一樣';
          const o = d.rt.routes.filter((r) => r.type === 'O');
          const extra = o.find((r) => r.bits > 0);
          if (extra) return `DC-RT 的路由表裡還有 ${fmtIp(extra.net)}/${extra.bits}（O ${extra.sub || ''}）：ABR 要 area 10 stub no-summary，區域裡才只剩一條預設路由`;
          return o.some((r) => r.bits === 0) || 'DC-RT 沒有收到預設路由';
        },
      },
      { type: 'tcp', from: 'hqpc', ip: '93.184.216.34', port: 443, avoid: 'e2', label: '工單二：總公司上網走主線（Edge-1），不走備援' },
      { type: 'failover', label: '工單三：主線斷了，總公司照樣上得了網（改走 Edge-2）', cut: [['e1', 'Gi0/0/0']], test: { type: 'tcp', from: 'hqpc', ip: '93.184.216.34', port: 443 } },
      { type: 'tcp', from: 'pc2', to: 'erp', port: 443, label: '工單四：高雄分公司連得到 ERP（通道起來了）' },
      { type: 'tcp', from: 'pos1', to: 'erp', port: 443, label: '工單五：台中的 POS 連得到 ERP（HTTPS）' },
      {
        type: 'check', label: '工單六：分公司只能用 HTTPS 連 ERP（SSH 不行），總公司的管理者照樣 SSH 得進去',
        test(s) {
          const c = cloneState(s); recompute(c);
          const ssh = (from) => transact(c, from, { proto: 'tcp', dst: parseIp('10.50.1.10'), dport: 22 });
          for (const id of ['pos1', 'pc2']) if (ssh(id).ok) return `${c.devices[id].name} 可以 SSH 到 ERP：分公司只允許 HTTPS（443）`;
          const a = ssh('hqpc');
          return a.ok || `總公司的 PC SSH 不到 ERP 了：${a.reason}`;
        },
      },
      {
        type: 'check', label: '分公司之間直接互通：台中看高雄的 NVR，第一個封包之後不再繞經總公司',
        test(s) {
          const t = cloneState(s); settle(t);
          const go = () => transact(t, 'pos1', { proto: 'tcp', dst: parseIp('10.22.0.30'), dport: 554 });
          const a = go();
          if (!a.ok) return '台中連不到高雄的 NVR：' + a.reason;
          settle(t, 30);
          const b = go();
          if (!b.ok) return '第二次連線失敗：' + b.reason;
          return b.l3.some((h) => h.dev === 'e1') ? `NHRP 解析之後還是經過 Edge-1（${b.l3.map((h) => fmtIp(h.ip)).join(' → ')}）` : true;
        },
      },
      {
        type: 'check', label: '限制：沒有新增任何靜態路由',
        test(s) {
          for (const [id, n] of [['e1', 1], ['e2', 1], ['br1', 1], ['br2', 1], ['core', 0], ['dc', 0]]) {
            if (statics(s, id) > n) return `${dev(s, id).name} 多了靜態路由（show running-config | include ip route）：這一題要把動態路由修好，不能用靜態路由繞過`;
            if (statics(s, id) < n) return `${dev(s, id).name} 往 ISP 的預設路由被刪掉了`;
          }
          return true;
        },
      },
    ],
    hints: [
      '工單一。DC-RT：show ip ospf neighbor 是空的；show ip ospf 寫 area 10 是 stub。Core：show running-config | section ospf 寫的是 area 10 nssa — 兩端的區域類型不一樣，Hello 互相不認。Core：router ospf 1 → no area 10 nssa → area 10 stub no-summary（no-summary 讓機房只收到一條預設路由）。',
      '工單二。Core：show ip route 0.0.0.0，O*E2 的 metric 是 5、下一站是 Edge-2。E2 路由只比送出來的 metric：Edge-2 的 default-information originate metric 5 比 Edge-1 的 10 小。Edge-2：router ospf 1 → default-information originate metric 100。',
      '工單三。把主線拔掉測（或看這個目標的說明）：封包到了 ISP 被丟掉，因為來源還是私有位址。Edge-2：show ip nat statistics 沒有 outside 介面 — interface Gi0/0/0 → ip nat outside。',
      '工單四。BR-KHH：show dmvpn 是空的，show crypto isakmp sa 停在 MM_KEY_EXCH / 沒有 SA。兩邊的 show running-config | include isakmp key 比一比：高雄是 Dmvpn!2025。no crypto isakmp key Dmvpn!2025 address 0.0.0.0，再設成 Dmvpn!2026。',
      '工單五、六。DC-RT：show access-lists DC-IN，第 10 條 deny 整個分公司的網段（10.20.0.0 – 10.23.255.255）有命中次數，第 20 條 permit tcp … eq 443 永遠是 0。把例外放前面：ip access-list extended DC-IN → no 10 → 25 deny ip 10.20.0.0 0.3.255.255 any。',
      '最後整張再看一次：Core 的 show ip route 應該有 O IA 10.21.0.0/24、10.22.0.0/24（經過 Edge-1），DC-RT 只有 O*IA 0.0.0.0/0；兩家分公司 show dmvpn 都看得到 hub。',
    ],
    solve(s) {
      cfg(s, 'core', ['router ospf 1', 'no area 10 nssa', 'area 10 stub no-summary']);
      cfg(s, 'e2', ['router ospf 1', 'default-information originate metric 100', 'exit', 'interface Gi0/0/0', 'ip nat outside']);
      cfg(s, 'br2', ['no crypto isakmp key Dmvpn!2025 address 0.0.0.0', 'crypto isakmp key Dmvpn!2026 address 0.0.0.0']);
      cfg(s, 'dc', ['ip access-list extended DC-IN', 'no 10', '25 deny ip 10.20.0.0 0.3.255.255 any']);
    },
    recap: ['大題目先讀圖：把每一台「該有卻沒有」的鄰居與路由列出來，再一張一張處理，修完回頭確認沒有弄壞別的。', '區域類型兩端要一致、E2 的預設路由只比 metric、備援一定要實際拔線測、DMVPN 由下往上查、ACL 的例外寫在前面。'],
  },
];
