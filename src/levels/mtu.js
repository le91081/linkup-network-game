// MTU：資料中心的 Jumbo Frame（第 4 章）、IPsec 的 PMTUD 黑洞（第 7 章）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const twoLines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
const PSK = 'Mtu!S2S#2026';

export const LEVELS18 = [
  // ─────────────────────────────────────────────── Jumbo Frame
  {
    id: 'l75', chapter: 4, title: '一開 Jumbo Frame，備份就卡住', subtitle: 'MTU 要整條路一致', tags: ['MTU', 'Jumbo Frame', 'giants', 'system mtu'],
    pasteReload: ['sw'], // 測試用：把設定貼回全新的 2960 之後，要存檔、重新開機 Jumbo MTU 才會生效
    brief: '機房的備份伺服器 BK-01 每天晚上把資料備份到 NAS。昨天有人說「開 Jumbo Frame 會快很多」，就把 BK-01 和 NAS 的網卡都改成 MTU 9000。結果備份整晚卡在 0%：互相 ping 得到，管理員也打得開 NAS 的管理頁面。請讓備份恢復，而且要真的跑出 Jumbo Frame 的速度。',
    given: [
      ['儲存網段', '10.0.50.0/24 · SW-Storage（Catalyst 2960-CX）'], ['BK-01', '10.0.50.10 · 網卡 MTU 9000'], ['NAS', '10.0.50.20 · Synology · 網卡 MTU 9000'],
      ['管理員的電腦', '10.0.10.50（辦公室網段，經過 R1）'], ['線路', '全部是 1 Gbps 的銅纜'], ['目標', '備份跑到 975 Mbps 以上'],
    ],
    learn: [
      { t: 'MTU 與 Jumbo Frame', d: 'MTU 是一個訊框能裝的最大 IP 封包，乙太網路預設 1500。Jumbo Frame 加大到 9000：同樣的資料封包數少六倍，CPU 與中斷少很多，標頭佔的比例也從 5% 降到 1%。常用在儲存網路（iSCSI、NFS、備份）與 vMotion。' },
      { t: '整條路都要一樣大', d: '交換器收到比自己的 MTU 大的訊框，直接當成 giant 丟掉，不會通知任何人（第二層沒有 ICMP）。兩端開了、中間的交換器沒開：交握的小封包會通、ping 也通，資料一大就消失。' },
      { t: 'TCP 的 MSS', d: '建立連線時兩端各自告訴對方「我收得下多大」（MSS = MTU − 40），取小的那一個。所以 MTU 9000 的 NAS 和 1500 的管理電腦經過路由器講話沒有問題；同一個網段裡大家都說 9000、中間卻有設備只收 1500，才會出事。' },
      { t: '怎麼測', d: 'ping -f -l 8972（Windows）或 ping -M do -s 8972（Linux）：8972 + 28 = 9000，設了 DF 不能分段。1472 會通、8972 逾時，就是中間有設備沒開。交換器 show interfaces 的 giants 計數器也會一直加。' },
      { t: '各家交換器的設定', d: 'Catalyst 2960：system mtu jumbo 9000，要 write memory 再 reload 才生效（show system mtu 會寫「On next reload」）。Catalyst 9300：system mtu 9198 馬上生效。Nexus：在每個介面上 mtu 9216。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [-1, -6], init(d) { ip4(d, 'Gi0/0/0', '10.0.10.1'); ip4(d, 'Gi0/0/1', '10.0.50.1'); } }),
        D('sw8', 'usw', { name: 'SW-Office', pos: [-7.5, -1] }),
        D('c2960', 'sw', { name: 'SW-Storage', pos: [5, -1.2], init(d) { d.sw.stp.portfastDefault = true; } }),
        D('pc', 'pc', { name: '管理員的電腦', pos: [-8.5, 4.4], ip: '10.0.10.50', gw: '10.0.10.1' }),
        D('tower', 'bk', { name: 'BK-01', pos: [2, 4.6], ip: '10.0.50.10', gw: '10.0.50.1', init(d) { d.ifaces[0].mtu = 9000; } }),
        D('nas', 'nas', { name: 'NAS', pos: [8.5, 4.2], ip: '10.0.50.20', gw: '10.0.50.1', init(d) { d.ifaces[0].mtu = 9000; } }),
      ], [['rt:Gi0/0/0', 'usw:1'], ['rt:Gi0/0/1', 'sw:Gi0/1'], ['pc:eth0', 'usw:2'], ['bk:eth0', 'sw:Gi0/2'], ['nas:eth0', 'sw:Gi0/3']]);
      recompute(s);
      typeIn(s, 'sw', ['write memory']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'bk', to: 'nas', port: 445, bulk: 'up', label: 'BK-01 可以把備份寫進 NAS（SMB）' },
      { type: 'speed', from: 'bk', to: 'nas', min: 975, label: '備份跑得到 975 Mbps 以上（整條路都是 Jumbo Frame）' },
      { type: 'tcp', from: 'pc', to: 'nas', port: 5001, label: '管理員的電腦打得開 NAS 的管理頁面（DSM）' },
      {
        type: 'check', label: 'SW-Storage 的 Jumbo MTU 有存進 startup-config（重新開機之後還在）',
        test(s) {
          const d = dev(s, 'sw');
          let saved = 1500;
          try { saved = +JSON.parse(d.startup || '{}').sw.jumbo || 1500; } catch { /* 沒有存過 */ }
          return saved >= 9000 || `startup-config 裡的 system mtu jumbo 是 ${saved}：改完要 write memory，不然下次開機又回到 1500`;
        },
      },
    ],
    hints: [
      'BK-01 的終端機：ping -f -l 1472 10.0.50.20 會通，ping -f -l 8972 10.0.50.20 卻逾時，也沒有任何錯誤訊息。中間只有 SW-Storage：它的 show interfaces gi0/2 有一堆 giants。',
      'SW-Storage 的 CLI：show system mtu，Jumbo MTU 還是 1500。configure terminal → system mtu jumbo 9000。',
      'Catalyst 2960 改 Jumbo MTU 要重新開機才生效：end → write memory → reload（或在「連接埠」分頁最下面的 MTU 卡片設定，按磁片存檔、再按電源鈕重新開機）。開機要兩分鐘，可以用上方的時鐘快轉。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['configure terminal', 'system mtu jumbo 9000', 'end', 'write memory', 'reload', '']);
    },
    recap: ['Jumbo Frame 要整條路上每一台都開；交換器收不下的訊框會被默默丟掉。', 'ping 加上 DF 和大小（-f -l 8972）才測得出 MTU 的問題。'],
  },

  // ─────────────────────────────────────────────── IPsec 與 PMTUD 黑洞
  {
    id: 'l76', chapter: 7, title: '小檔案可以，大檔案卡住', subtitle: 'IPsec 的 MTU 與 PMTUD 黑洞', tags: ['MTU', 'PMTUD', 'IPsec', 'adjust-mss', 'ICMP'],
    brief: '分公司經由站對站 VPN 使用總公司的檔案伺服器。上傳都很正常，網頁的小東西也打得開，可是從伺服器下載大一點的檔案就卡住、最後逾時；總公司的同事下載同一個檔案卻沒有問題。上個月資安稽核之後，總公司核心交換器上伺服器網段的 ACL 被「收緊」過。請讓分公司的下載恢復正常，伺服器網段還是要擋 ping。',
    given: [
      ['總公司 HQ-FW', '203.0.113.18 · 往內接 HQ-Core（10.1.0.0/30）'], ['HQ-Core', 'Catalyst 9300 · 伺服器網段 VLAN 20（10.1.20.0/24），套用 ACL SERVERS'],
      ['檔案伺服器', '10.1.20.10（SMB 445、內部網站 443）'], ['總公司的同事', '10.1.10.50（VLAN 10）'],
      ['分公司 Branch-RT', '198.51.100.34 · 內網 10.2.0.0/24'], ['VPN', '總公司 10.1.0.0/16 ↔ 分公司 10.2.0.0/24'],
    ],
    learn: [
      { t: 'DF 與 Path MTU Discovery', d: 'TCP 送資料時會設 DF（不可分段）。路由器遇到比下一段 MTU 大的封包就丟掉，回一個 ICMP「需要分段」（type 3 code 4，ACL 裡叫 packet-too-big），裡面寫著下一段的 MTU；送的人收到之後改送小一點的封包。' },
      { t: 'IPsec 會讓封包變大', d: 'ESP 通道模式要再包一層 IP、ESP 標頭、IV、填充與驗證碼，大約多 73 位元組：1500 的封包加密之後放不進 1500 的線路，通道裡實際只放得下 1427。GRE 多 24、PPPoE 多 8。' },
      { t: 'PMTUD 黑洞', d: '「需要分段」的 ICMP 被 ACL 或防火牆擋掉，送的人永遠不知道要改小，一直重送一樣大的封包。症狀很典型：ping 通、TCP 連得上、小東西正常，大的傳輸卡住；而且常常只有一個方向壞（只有大封包那一端收不到 ICMP）。' },
      { t: '解法', d: '不要把 ICMP 全部擋掉，至少放行 packet-too-big（或 unreachable）。另外在 VPN 路由器的介面上加 ip tcp adjust-mss 1360，把經過的 SYN 裡的 MSS 改小，兩端一開始就送不超過 1400 的封包（只對 TCP 有用）。' },
      { t: '怎麼找', d: '從分公司 ping -f -l 1472 <伺服器>：分公司的路由器會回「封包需要分段」，代表通道裡放不下 1500。再看大封包那一端（伺服器）回程的路上有沒有 ACL 擋 ICMP：show ip interface vlan 20、show access-lists。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: twoLines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' });
      setLine(inet, 'line2', { type: 'static', gw: '198.51.100.33', mask: '255.255.255.252', assign: '198.51.100.34' });
      const s = makeState([
        inet,
        D('fg60f', 'hq', {
          name: 'HQ-FW', pos: [-7, -5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
            Object.assign(g('internal'), { ip: '10.1.0.1', mask: '255.255.255.252' });
            d.routes.push({ dst: '10.1.0.0', mask: '255.255.0.0', via: '10.1.0.2' });
            d.vpns.push({ name: 'Branch', peer: '198.51.100.34', psk: PSK, local: '10.1.0.0/16', remote: '10.2.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14' });
            d.policies.push(allow('內網上網', 'internal', 'wan1', { nat: true }), allow('往分公司', 'internal', 'vpn:Branch'), allow('分公司進來', 'vpn:Branch', 'internal'));
          },
        }),
        D('c9300', 'core', { name: 'HQ-Core', pos: [-7, 0.2] }),
        D('tower', 'fs', { name: '檔案伺服器', pos: [-11, 5], ip: '10.1.20.10', gw: '10.1.20.1', services: [...WEB, { proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
        D('pc', 'hq-pc', { name: '總公司的同事', pos: [-3.5, 5.2], ip: '10.1.10.50', gw: '10.1.10.1' }),
        D('isr4331', 'br', { name: 'Branch-RT', pos: [7, -5] }),
        D('sw5', 'br-sw', { name: 'BR-Switch', pos: [7, 0.2] }),
        D('pc', 'pc', { name: '分公司 PC', pos: [7, 5], ip: '10.2.0.50', gw: '10.2.0.1', dns: '8.8.8.8' }),
      ], [
        ['inet:line1', 'hq:wan1'], ['inet:line2', 'br:Gi0/0/0'], ['hq:1', 'core:Gi1/0/1'], ['fs:eth0', 'core:Gi1/0/2'], ['hq-pc:eth0', 'core:Gi1/0/3'],
        ['br:Gi0/0/1', 'br-sw:1'], ['pc:eth0', 'br-sw:2'],
      ]);
      recompute(s);
      // 總公司的核心：伺服器網段只放行需要的服務，ICMP 全部擋掉（稽核之後「收緊」的）
      typeIn(s, 'core', ['configure terminal',
        'vlan 10', 'name Users', 'vlan 20', 'name Servers', 'exit',
        'interface Gi1/0/1', 'no switchport', 'ip address 10.1.0.2 255.255.255.252',
        'interface Gi1/0/2', 'switchport access vlan 20',
        'interface Gi1/0/3', 'switchport access vlan 10',
        'interface vlan 10', 'ip address 10.1.10.1 255.255.255.0',
        'interface vlan 20', 'ip address 10.1.20.1 255.255.255.0', 'ip access-group SERVERS out', 'exit',
        'ip access-list extended SERVERS', 'permit tcp 10.0.0.0 0.255.255.255 host 10.1.20.10 eq 445', 'permit tcp 10.0.0.0 0.255.255.255 host 10.1.20.10 eq 443', 'deny icmp any any', 'exit',
        'ip route 0.0.0.0 0.0.0.0 10.1.0.1', 'end', 'write memory']);
      // 分公司的路由器：VPN、NAT 例外都設定好了
      typeIn(s, 'br', ['configure terminal',
        'interface Gi0/0/0', 'ip address 198.51.100.34 255.255.255.252', 'ip nat outside', 'no shutdown',
        'interface Gi0/0/1', 'ip address 10.2.0.1 255.255.255.0', 'ip nat inside', 'exit',
        'ip route 0.0.0.0 0.0.0.0 198.51.100.33',
        'ip access-list extended NAT', 'deny ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.255.255', 'permit ip 10.2.0.0 0.0.0.255 any', 'exit',
        'ip nat inside source list NAT interface Gi0/0/0 overload',
        'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
        `crypto isakmp key ${PSK} address 203.0.113.18`,
        'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
        'ip access-list extended VPN-HQ', 'permit ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.255.255', 'exit',
        'crypto map CMAP 10 ipsec-isakmp', 'set peer 203.0.113.18', 'set transform-set TS', 'match address VPN-HQ', 'exit',
        'interface Gi0/0/0', 'crypto map CMAP', 'end', 'write memory']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'fs', port: 445, bulk: 'up', label: '分公司上傳檔案到總公司的檔案伺服器' },
      { type: 'tcp', from: 'pc', to: 'fs', port: 445, label: '分公司從檔案伺服器下載大檔案' },
      { type: 'tcp', from: 'pc', to: 'fs', port: 443, label: '分公司打得開總公司的內部網站' },
      { type: 'tcp', from: 'hq-pc', to: 'fs', port: 445, label: '總公司的同事下載正常（不經過 VPN）' },
      { type: 'ping', from: 'pc', to: 'fs', expect: false, label: '伺服器網段還是擋 ping（ACL 不能整個拿掉）' },
    ],
    hints: [
      '分公司 PC 的終端機：ping -f -l 1472 10.1.20.10 → Branch-RT 回「封包需要分段，但設定了 DF」：加密之後多 73 位元組，通道裡只放得下 1427。上傳的時候分公司 PC 收得到這個訊息，所以上傳正常。',
      '下載是檔案伺服器在送大封包：HQ-FW 回報的「需要分段」經過 HQ-Core 往 VLAN 20 送時，被 ACL SERVERS 的 deny icmp any any 擋掉（HQ-Core：show ip interface vlan 20、show access-lists）。伺服器不知道要改小，一直重送 → PMTUD 黑洞。',
      'HQ-Core：ip access-list extended SERVERS → 25 permit icmp any any packet-too-big（序號 25 會插在 deny 的前面；echo 還是擋著）。',
      '保險起見，Branch-RT 的 Gi0/0/1 再加 ip tcp adjust-mss 1360：分公司送出去的 SYN 裡的 MSS 被改成 1360，伺服器一開始就只送 1400 以下的封包，不用靠 ICMP。',
    ],
    solve(s) {
      typeIn(s, 'core', ['configure terminal', 'ip access-list extended SERVERS', '25 permit icmp any any packet-too-big', 'end', 'write memory']);
      typeIn(s, 'br', ['configure terminal', 'interface Gi0/0/1', 'ip tcp adjust-mss 1360', 'end', 'write memory']);
    },
    recap: ['加密、PPPoE、GRE 都會讓封包變大；路徑上的 MTU 靠 ICMP「需要分段」告訴送的人。', '不要把 ICMP 全擋：至少放行 packet-too-big；VPN 路由器上再加 ip tcp adjust-mss。'],
  },
];
