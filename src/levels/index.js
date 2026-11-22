// 關卡定義：四個章節、十二個關卡，由一條網路線到 Spine-Leaf 資料中心
import { makeDevice as D, makeState, setLine, newIface } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';

import { dev, ifc, link, setIp, useDhcp, swp, addVlan, portTo, operTo, WEB, DB, levelDefaults } from './util.js';
import { CHAPTERS2, LEVELS2 } from './advanced.js';
import { CHAPTERS3, LEVELS3 } from './more.js';
import { CHAPTERS4, LEVELS4 } from './trouble.js';
import { CHAPTERS5, LEVELS5 } from './maint.js';
import { CHAPTERS6, LEVELS6 } from './voip.js';
import { CHAPTERS7, LEVELS7 } from './routing.js';
import { LEVELS8 } from './ipv6.js';
import { LEVELS9 } from './vpn2.js';
import { CHAPTERS8, LEVELS10 } from './wireless.js';
import { CHAPTERS9, LEVELS11 } from './auto.js';
import { CHAPTERS10, LEVELS12 } from './cloud.js';
import { LEVELS13 } from './resil.js';
import { LEVELS14 } from './audit.js';
import { LEVELS15 } from './trouble2.js';
import { CHAPTERS11, LEVELS16 } from './virtual.js';
import { LEVELS17 } from './tls.js';
import { LEVELS18 } from './mtu.js';
import { LEVELS19 } from './redist.js';
import { LEVELS20 } from './routing2.js';
import { LEVELS21 } from './l2sec.js';
import { LEVELS22 } from './tunnels.js';
import { LEVELS23 } from './ipv6b.js';
import { LEVELS24 } from './ha.js';
import { LEVELS25 } from './ops2.js';
import { LEVELS26 } from './poe.js';
import { LEVELS27 } from './ntp.js';
import { LEVELS28 } from './qos2.js';
import { LEVELS29 } from './certvpn.js';
import { LEVELS30 } from './eaptls.js';
import { LEVELS31 } from './nolabel.js';
import { LEVELS32 } from './wifi2.js';
import { LEVELS33 } from './wlc2.js';
import { LEVELS34 } from './flex.js';

export const CHAPTERS = [
  { id: 1, title: '家用網路', desc: '從第一條網路線開始，讓家裡的設備互通並連上網際網路。' },
  { id: 2, title: '小型辦公室', desc: '固定 IP、對外服務、VLAN 與跨 VLAN 路由。' },
  { id: 3, title: '企業網路', desc: '防火牆政策、DMZ 與多據點靜態路由。' },
  { id: 4, title: '資料中心', desc: '機櫃 ToR、核心交換器、Spine-Leaf 與 OSPF。' },
];

export const LEVELS = [
  // ════════════════════════ 第一章：家用網路 ════════════════════════
  {
    id: 'l01', chapter: 1, title: '第一條網路線', subtitle: 'Hub 與固定 IP', tags: ['接線', 'IP 位址', '子網路遮罩'],
    brief: '室友想把檔案從 PC-A 傳到 PC-B，桌上只有一台老 Hub 和兩條網路線。把兩台電腦接起來，並設定 IP 讓它們找得到彼此。',
    given: [['網段', '192.168.1.0/24'], ['子網路遮罩', '255.255.255.0'], ['建議 IP', 'PC-A .10　PC-B .20']],
    learn: [
      { t: 'IP 位址', d: '每台設備在網路上的門牌號碼，例如 192.168.1.10。' },
      { t: '子網路遮罩', d: '255.255.255.0 代表「前三段相同就是同一條街」。同一條街上的設備可以直接對話，不需要路由器。' },
      { t: 'Hub（集線器）', d: '最單純的設備：從一個埠進來的訊號，原封不動複製到其他所有埠。在自由模式把三台電腦接到同一台 Hub，就能看到不相干的那台也收到一份。' },
      { t: 'ARP', d: '電腦只知道對方的 IP，要先廣播問「誰是 192.168.1.20？」拿到對方的 MAC 位址，才能真的把資料送出去。橘色的光點就是 ARP。' },
    ],
    setup: () => makeState([
      D('hub4', 'hub', { name: 'Hub', pos: [0, -2] }),
      D('pc', 'pc-a', { name: 'PC-A', pos: [-4.5, 2] }),
      D('pc', 'pc-b', { name: 'PC-B', pos: [4.5, 2] }),
    ]),
    objectives: [
      { type: 'ping', from: 'pc-a', to: 'pc-b', label: 'PC-A 可以 ping 到 PC-B' },
      { type: 'ping', from: 'pc-b', to: 'pc-a', label: 'PC-B 可以 ping 到 PC-A' },
    ],
    hints: [
      '在 PC-A 上按住滑鼠，拖曳到 Hub 再放開，就會接上一條網路線。PC-B 也一樣。',
      '點一下 PC-A 打開設定，選「手動設定」，IP 填 192.168.1.10、子網路遮罩填 255.255.255.0。',
      'PC-B 填 192.168.1.20 / 255.255.255.0。兩台的前三段要一樣、最後一段不能重複。閘道與 DNS 這關用不到，留空即可。',
    ],
    solve(s) {
      link(s, 'pc-a:eth0', 'hub:1'); link(s, 'pc-b:eth0', 'hub:2');
      setIp(s, 'pc-a', '192.168.1.10'); setIp(s, 'pc-b', '192.168.1.20');
    },
    recap: ['網路線接上只是第一步（實體層），還要有 IP 才能溝通。', '同一個子網路內的設備可以直接互通，不需要閘道。'],
  },
  {
    id: 'l02', chapter: 1, title: '換上交換器', subtitle: '找出設錯的那一台', tags: ['Switch', '除錯'],
    brief: '工作室把 Hub 換成了交換器，可是只有 PC-1 印得出東西。請找出 PC-2 和 PC-3 為什麼連不到印表機，並把問題修好。',
    given: [['網段', '192.168.1.0/24'], ['印表機', '192.168.1.200']],
    learn: [
      { t: 'Switch（交換器）', d: '會記住每個埠後面是誰（MAC 位址表），只把資料送到該去的埠，比 Hub 有效率也更安全。只有廣播（例如 ARP）才會送到每一個埠。' },
      { t: '除錯順序', d: '由下往上查：線有沒有接 → IP 與遮罩對不對 → 再看閘道與更上層的設定。' },
    ],
    setup: () => makeState([
      D('sw5', 'sw', { name: 'Switch', pos: [0, -2] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-7, 2], ip: '192.168.1.11' }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [-2.4, 3], ip: '192.168.11.12' }),
      D('pc', 'pc-3', { name: 'PC-3', pos: [2.4, 3], ip: '192.168.1.13' }),
      D('printer', 'prn', { name: '印表機', pos: [7, 2], ip: '192.168.1.200' }),
    ], [['pc-1:eth0', 'sw:1'], ['pc-2:eth0', 'sw:2'], ['prn:eth0', 'sw:5']]),
    objectives: [
      { type: 'ping', from: 'pc-1', to: 'prn', label: 'PC-1 可以 ping 到印表機' },
      { type: 'ping', from: 'pc-2', to: 'prn', label: 'PC-2 可以 ping 到印表機' },
      { type: 'tcp', from: 'pc-3', to: 'prn', port: 9100, label: 'PC-3 可以送出列印工作 (TCP 9100)' },
    ],
    hints: [
      '先按「執行測試」，下方的封包追蹤會告訴你封包卡在哪裡、為什麼。',
      'PC-3 的 IP 沒問題，但它的網路線根本沒接。',
      'PC-2 的 IP 打錯了：192.168.11.12 和印表機不在同一個子網路，改成 192.168.1.12。',
    ],
    solve(s) {
      link(s, 'pc-3:eth0', 'sw:3');
      setIp(s, 'pc-2', '192.168.1.12');
    },
    recap: ['IP 差一個數字就可能落在不同子網路。', '封包追蹤是最好的除錯工具：看它死在哪一站。'],
  },
  {
    id: 'l03', chapter: 1, title: '自動發 IP', subtitle: 'DHCP 伺服器與固定 IP', tags: ['DHCP', '家用路由器'],
    brief: '搬新家了！你買了一台無線路由器。希望電腦和筆電插上線就能自動拿到 IP，而 NAS 要用固定 IP，這樣全家人永遠都找得到它。',
    given: [['路由器 LAN', '192.168.50.1 / 255.255.255.0'], ['DHCP 範圍', '192.168.50.100 – 192.168.50.200'], ['NAS 固定 IP', '192.168.50.10']],
    learn: [
      { t: 'DHCP', d: '設備開機時大喊「誰可以給我一個 IP？」，DHCP 伺服器就會從位址池借一個給它，連遮罩、閘道、DNS 一起附上。整個過程是四步：Discover、Offer、Request、Ack（DORA）。' },
      { t: '固定 IP 要避開位址池', d: '伺服器、NAS、印表機通常用固定 IP。這個 IP 不能落在 DHCP 範圍裡，否則可能被發給別人造成衝突。' },
      { t: 'APIPA', d: '如果電腦拿到 169.254.x.x，代表它找不到 DHCP 伺服器，只好自己編一個。' },
      { t: '租約', d: 'IP 是「借」來的，有期限。電腦過了一半的時間會自動續約；伺服器暫時連不到也沒關係，到期之前都能繼續用。' },
    ],
    setup: () => makeState([
      D('homerouter', 'rt', { name: '路由器', pos: [0, -2.5] }),
      D('pc', 'pc-1', { name: '桌機', pos: [-5.5, 2] }),
      D('laptop', 'nb', { name: '筆電', pos: [0, 3.2] }),
      D('nas', 'nas', { name: 'NAS', pos: [5.5, 2] }),
    ]),
    objectives: [
      { type: 'dhcp', dev: 'pc-1', subnet: '192.168.50.0/24', label: '桌機透過 DHCP 取得 IP' },
      { type: 'dhcp', dev: 'nb', subnet: '192.168.50.0/24', label: '筆電透過 DHCP 取得 IP' },
      {
        type: 'check', label: 'NAS 使用固定 IP 192.168.50.10，且不在 DHCP 範圍內',
        test(s) {
          const ip = parseIp('192.168.50.10');
          if (!dev(s, 'nas').ifaces.some((i) => i.mode === 'static' && i.rt.ip === ip)) return 'NAS 目前不是固定 IP 192.168.50.10';
          const l = ifc(s, 'rt', 'lan');
          const a = parseIp(l.dhcp.start), b = parseIp(l.dhcp.end);
          if (!l.dhcp.on || a == null || b == null) return '路由器的 DHCP 伺服器還沒設定好';
          return ip < a || ip > b || 'DHCP 範圍包含了 192.168.50.10，日後可能把 NAS 的 IP 發給別人';
        },
      },
      { type: 'tcp', from: 'pc-1', to: 'nas', port: 445, label: '桌機可以開啟 NAS 的共用資料夾 (SMB 445)' },
      { type: 'ping', from: 'nb', to: 'nas', label: '筆電可以 ping 到 NAS' },
    ],
    hints: [
      '把三台設備接到路由器的 LAN 埠（不是 WAN）。接線時會讓你選連接埠。',
      '點路由器 →「區域網路」分頁，開啟 DHCP 伺服器，範圍填 192.168.50.100 到 192.168.50.200。',
      '桌機與筆電選「自動取得 (DHCP)」。NAS 選手動：192.168.50.10 / 255.255.255.0。',
    ],
    solve(s) {
      link(s, 'pc-1:eth0', 'rt:lan1'); link(s, 'nb:eth0', 'rt:lan2'); link(s, 'nas:eth0', 'rt:lan3');
      Object.assign(ifc(s, 'rt', 'lan').dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' });
      useDhcp(s, 'pc-1'); useDhcp(s, 'nb');
      setIp(s, 'nas', '192.168.50.10');
    },
    recap: ['DHCP 省去逐台設定的麻煩，也避免手動打錯。', '需要被別人找到的設備用固定 IP，並避開 DHCP 位址池。'],
  },
  {
    id: 'l04', chapter: 1, title: '連上網際網路', subtitle: 'WAN、PPPoE、NAT 與 DNS', tags: ['WAN', 'PPPoE', 'NAT', 'DNS'],
    brief: '電信業者的光纖裝好了，工程師留下一張上網帳密的單子就走了。把路由器的 WAN 接上線路並完成撥接，讓全家都能上網。',
    given: [['連線方式', 'PPPoE 撥接'], ['上網帳號', '74123456@hinet.net'], ['上網密碼', 'k7m2x9pw']],
    learn: [
      { t: 'WAN 與 LAN', d: 'WAN 埠接往電信業者（外面），LAN 埠接家裡的設備（裡面）。路由器站在中間轉送。' },
      { t: 'NAT', d: '192.168.x.x 這類私有 IP 不能直接上網。路由器會把封包的來源換成自己的公用 IP，回來時再換回去。' },
      { t: '預設閘道與 DNS', d: '不認識的目的地一律交給閘道。DNS 則負責把 www.example.com 翻譯成 IP 位址。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -7] }), 'line1', {
        type: 'pppoe', gw: '203.0.113.1', assign: '203.0.113.25', user: '74123456@hinet.net', pass: 'k7m2x9pw',
      }),
      D('homerouter', 'rt', {
        name: '路由器', pos: [0, -2],
        init: (d) => Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' }),
      }),
      D('pc', 'pc-1', { name: '桌機', pos: [-4.5, 2.6], dhcp: true }),
      D('laptop', 'nb', { name: '筆電', pos: [4.5, 2.6], dhcp: true }),
    ], [['pc-1:eth0', 'rt:lan1'], ['nb:eth0', 'rt:lan2']]),
    objectives: [
      { type: 'ping', from: 'pc-1', ip: '8.8.8.8', label: '桌機可以 ping 到 8.8.8.8' },
      { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443, label: '桌機可以開啟 https://www.example.com' },
      { type: 'tcp', from: 'nb', name: 'www.example.com', port: 443, label: '筆電可以開啟 https://www.example.com' },
    ],
    hints: [
      '把路由器的 WAN 埠接到「網際網路」的線路上。',
      '點路由器 →「網際網路 (WAN)」，連線類型改成 PPPoE。',
      '帳號填 74123456@hinet.net、密碼填 k7m2x9pw。撥接成功後 WAN 會拿到 203.0.113.25。',
    ],
    solve(s) {
      link(s, 'rt:wan', 'inet:line1');
      Object.assign(ifc(s, 'rt', 'wan'), { mode: 'pppoe', user: '74123456@hinet.net', pass: 'k7m2x9pw' });
    },
    recap: ['家用路由器同時做了三件事：路由、NAT、DHCP。', '能 ping 到 8.8.8.8 卻開不了網站，通常是 DNS 的問題。'],
  },

  // ════════════════════════ 第二章：小型辦公室 ════════════════════════
  {
    id: 'l05', chapter: 2, title: '辦公室開張', subtitle: '固定 IP 線路與連接埠轉發', tags: ['固定 IP', 'NAT', 'Port Forward'],
    brief: '新創公司租了一條固定 IP 的商用線路。除了讓同事上網，還要讓外面的客戶連得到放在辦公室的網站伺服器。這次用的是企業級路由器，每個埠都要自己設定。',
    given: [
      ['ISP 固定 IP', '203.0.113.10'], ['ISP 遮罩', '255.255.255.248'], ['ISP 閘道', '203.0.113.9'], ['ISP DNS', '168.95.1.1'],
      ['內部網段', '192.168.10.0/24'], ['路由器 LAN', '192.168.10.1'], ['網站伺服器', '192.168.10.5（固定）'], ['PC', 'DHCP .100 – .199'],
    ],
    learn: [
      { t: '固定 IP 線路', d: '商用線路不撥接，而是由 ISP 給你一組 IP、遮罩與閘道，手動填進 WAN 介面。' },
      { t: '連接埠轉發 (DNAT)', d: '外面的人只看得到你的公用 IP。告訴路由器「打到我 443 埠的連線，轉給內部的 192.168.10.5」。' },
      { t: 'DHCP 要發 DNS', d: '企業路由器不會自動代理 DNS，記得在 DHCP 設定裡填上 DNS 伺服器。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -8.5] }), 'line1', {
        type: 'static', gw: '203.0.113.9', mask: '255.255.255.248', assign: '203.0.113.10',
      }),
      D('erx', 'rt', { name: 'Router', pos: [0, -4.2] }),
      D('sw8', 'sw', { name: 'Switch', pos: [0, 0] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-6.5, 4] }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [-2, 4.8] }),
      D('tower', 'web', { name: 'Web 伺服器', pos: [5.5, 4], services: WEB }),
    ]),
    objectives: [
      { type: 'dhcp', dev: 'pc-1', subnet: '192.168.10.0/24', label: 'PC-1 透過 DHCP 取得 192.168.10.x' },
      { type: 'ping', from: 'pc-1', ip: '8.8.8.8', label: 'PC-1 可以 ping 到 8.8.8.8' },
      { type: 'tcp', from: 'pc-2', name: 'www.example.com', port: 443, label: 'PC-2 可以開啟 https://www.example.com' },
      {
        type: 'check', label: 'Web 伺服器使用固定 IP 192.168.10.5',
        test: (s) => dev(s, 'web').ifaces.some((i) => i.mode === 'static' && i.rt.ip === parseIp('192.168.10.5')) || 'Web 伺服器目前不是固定 IP 192.168.10.5',
      },
      { type: 'tcp', from: 'inet', ip: '203.0.113.10', port: 443, label: '外部使用者可以開啟 https://203.0.113.10' },
    ],
    hints: [
      '接線：網際網路 ↔ Router eth0（當 WAN）、Router eth1 ↔ Switch，其餘設備接到 Switch。',
      'Router eth0：固定 IP 203.0.113.10 / 255.255.255.248、閘道 203.0.113.9，並勾選「NAT」。eth1：192.168.10.1 / 255.255.255.0。',
      'eth1 開啟 DHCP（.100 – .199，DNS 168.95.1.1）。伺服器手動 192.168.10.5、閘道 192.168.10.1。最後在「NAT / 轉發」加一條 TCP 443 → 192.168.10.5:443。',
    ],
    solve(s) {
      link(s, 'inet:line1', 'rt:eth0'); link(s, 'rt:eth1', 'sw:1');
      link(s, 'pc-1:eth0', 'sw:2'); link(s, 'pc-2:eth0', 'sw:3'); link(s, 'web:eth0', 'sw:4');
      Object.assign(ifc(s, 'rt', 'eth0'), { ip: '203.0.113.10', mask: '255.255.255.248', gateway: '203.0.113.9', nat: true });
      const lan = ifc(s, 'rt', 'eth1');
      Object.assign(lan, { ip: '192.168.10.1', mask: '255.255.255.0' });
      Object.assign(lan.dhcp, { on: true, start: '192.168.10.100', end: '192.168.10.199', dns: '168.95.1.1' });
      useDhcp(s, 'pc-1'); useDhcp(s, 'pc-2');
      setIp(s, 'web', '192.168.10.5', '255.255.255.0', '192.168.10.1');
      dev(s, 'rt').portForwards.push({ proto: 'tcp', port: 443, toIp: '192.168.10.5', toPort: 443 });
    },
    recap: ['伺服器一定要設閘道，否則回程封包出不去。', 'NAT 解決「出去」，連接埠轉發解決「進來」。'],
  },
  {
    id: 'l06', chapter: 2, title: '部門隔離', subtitle: 'VLAN 與 Access Port', tags: ['VLAN', '網管型交換器'],
    brief: '研發部抱怨：業務部的電腦竟然可以直接連到他們的測試機。公司只有一台交換器，請用 VLAN 把兩個部門切成兩個互不相通的網路。',
    given: [['業務部', 'VLAN 10（PC-S1、PC-S2）'], ['研發部', 'VLAN 20（PC-R1、PC-R2）']],
    learn: [
      { t: 'VLAN', d: '把一台實體交換器切成好幾台「虛擬交換器」。不同 VLAN 的埠就像插在不同的交換器上，彼此完全不通。' },
      { t: 'Access Port', d: '接終端設備的埠。它只屬於一個 VLAN，電腦本身完全不知道 VLAN 的存在。' },
    ],
    setup: () => makeState([
      D('c2960', 'sw', { name: 'Switch', pos: [0, -2] }),
      D('pc', 'pc-s1', { name: 'PC-S1 業務', pos: [-7.5, 2.4], ip: '192.168.1.11' }),
      D('pc', 'pc-s2', { name: 'PC-S2 業務', pos: [-2.6, 3.4], ip: '192.168.1.12' }),
      D('pc', 'pc-r1', { name: 'PC-R1 研發', pos: [2.6, 3.4], ip: '192.168.1.21' }),
      D('pc', 'pc-r2', { name: 'PC-R2 研發', pos: [7.5, 2.4], ip: '192.168.1.22' }),
    ], [['pc-s1:eth0', 'sw:Gi0/1'], ['pc-s2:eth0', 'sw:Gi0/2'], ['pc-r1:eth0', 'sw:Gi0/3'], ['pc-r2:eth0', 'sw:Gi0/4']]),
    objectives: [
      { type: 'ping', from: 'pc-s1', to: 'pc-s2', label: '業務部內部互通（PC-S1 → PC-S2）' },
      { type: 'ping', from: 'pc-r1', to: 'pc-r2', label: '研發部內部互通（PC-R1 → PC-R2）' },
      { type: 'ping', from: 'pc-s1', to: 'pc-r1', expect: false, label: '業務部連不到研發部（PC-S1 ✕ PC-R1）' },
      { type: 'ping', from: 'pc-r2', to: 'pc-s2', expect: false, label: '研發部連不到業務部（PC-R2 ✕ PC-S2）' },
      {
        type: 'check', label: '業務的埠在 VLAN 10、研發的埠在 VLAN 20',
        test(s) {
          for (const [id, v] of [['pc-s1', 10], ['pc-s2', 10], ['pc-r1', 20], ['pc-r2', 20]]) {
            const p = portTo(s, 'sw', id);
            if (!p) return `${dev(s, id).name} 沒有接在交換器上`;
            if (operTo(s, 'sw', id) !== 'access' || p.vlan !== v) return `${dev(s, id).name} 所在的埠還不是 VLAN ${v} 的 Access Port`;
          }
          return true;
        },
      },
    ],
    hints: [
      '點交換器 →「VLAN」分頁，新增 VLAN 10（業務）和 VLAN 20（研發）。',
      '到「連接埠」分頁，把 Gi0/1、Gi0/2 的 VLAN 改成 10，Gi0/3、Gi0/4 改成 20。',
      'Catalyst 的埠出廠是 dynamic auto，接電腦時會以 Access 運作；正式環境習慣明確設成 Access（switchport mode access）。Trunk 是下一關的事。',
    ],
    solve(s) {
      addVlan(s, 'sw', 10, '業務'); addVlan(s, 'sw', 20, '研發');
      swp(s, 'sw', 'Gi0/1').vlan = 10; swp(s, 'sw', 'Gi0/2').vlan = 10;
      swp(s, 'sw', 'Gi0/3').vlan = 20; swp(s, 'sw', 'Gi0/4').vlan = 20;
    },
    recap: ['VLAN 在第二層就把流量隔開，比靠 IP 規劃來隔離可靠得多。', '預設所有埠都在 VLAN 1，所以沒設定前大家都互通。'],
  },
  {
    id: 'l07', chapter: 2, title: '跨樓層', subtitle: 'Trunk 與 802.1Q', tags: ['Trunk', '802.1Q'],
    brief: '公司擴編到二樓，兩層樓各有一台交換器，中間只拉了一條線。業務部和研發部在兩層樓都有人，同部門的人要能互通。一樓已經設定好了，請完成二樓並把兩台交換器接起來。',
    given: [['業務部', 'VLAN 10 · 192.168.10.0/24'], ['研發部', 'VLAN 20 · 192.168.20.0/24'], ['樓層上行埠', '建議使用 Gi0/9']],
    learn: [
      { t: 'Trunk Port', d: '交換器之間的埠。一條線同時載送多個 VLAN，靠在訊框上貼「VLAN 標籤 (802.1Q tag)」來區分。' },
      { t: 'VLAN 要兩邊都有', d: 'VLAN 必須在每一台經過的交換器上都建立，Trunk 兩端也都要設成 Trunk。' },
    ],
    setup: () => makeState([
      D('c2960', 'sw1', {
        name: 'SW-1F', pos: [-5.5, -1.5],
        init(d) {
          d.sw.vlans.push({ id: 10, name: '業務' }, { id: 20, name: '研發' });
          d.sw.ports['Gi0/1'].vlan = 10; d.sw.ports['Gi0/2'].vlan = 20;
        },
      }),
      D('c2960', 'sw2', { name: 'SW-2F', pos: [5.5, -1.5] }),
      D('pc', 'pc-s1', { name: '1F 業務', pos: [-8.5, 3.4], ip: '192.168.10.11' }),
      D('pc', 'pc-r1', { name: '1F 研發', pos: [-3, 3.4], ip: '192.168.20.11' }),
      D('pc', 'pc-s2', { name: '2F 業務', pos: [3, 3.4], ip: '192.168.10.12' }),
      D('pc', 'pc-r2', { name: '2F 研發', pos: [8.5, 3.4], ip: '192.168.20.12' }),
    ], [['pc-s1:eth0', 'sw1:Gi0/1'], ['pc-r1:eth0', 'sw1:Gi0/2'], ['pc-s2:eth0', 'sw2:Gi0/1'], ['pc-r2:eth0', 'sw2:Gi0/2']]),
    objectives: [
      { type: 'ping', from: 'pc-s1', to: 'pc-s2', label: '一樓業務可以 ping 到二樓業務' },
      { type: 'ping', from: 'pc-r2', to: 'pc-r1', label: '二樓研發可以 ping 到一樓研發' },
      {
        type: 'check', label: '兩台交換器之間只用一條線（Trunk）',
        test(s) {
          const n = s.cables.filter((c) => [c.a.dev, c.b.dev].sort().join() === 'sw1,sw2').length;
          return n === 1 || (n === 0 ? '兩台交換器還沒接起來' : '樓層之間只有一條線可用，請用 Trunk 而不是多拉幾條');
        },
      },
    ],
    hints: [
      '先參考 SW-1F 的設定：VLAN 分頁有 10 和 20，Gi0/1、Gi0/2 各屬一個 VLAN。在 SW-2F 照樣做一次。',
      '把 SW-1F 的 Gi0/9 接到 SW-2F 的 Gi0/9。',
      '兩台交換器的 Gi0/9 都把模式改成 Trunk（允許的 VLAN 保持 all 即可）。',
    ],
    solve(s) {
      addVlan(s, 'sw2', 10, '業務'); addVlan(s, 'sw2', 20, '研發');
      swp(s, 'sw2', 'Gi0/1').vlan = 10; swp(s, 'sw2', 'Gi0/2').vlan = 20;
      link(s, 'sw1:Gi0/9', 'sw2:Gi0/9');
      swp(s, 'sw1', 'Gi0/9').mode = 'trunk'; swp(s, 'sw2', 'Gi0/9').mode = 'trunk';
    },
    recap: ['Access 埠接終端、Trunk 埠接交換器或路由器。', 'Trunk 上的訊框帶著 VLAN 標籤，到了對面再依標籤分流。'],
  },
  {
    id: 'l08', chapter: 2, title: '跨 VLAN 路由', subtitle: 'Router-on-a-Stick 與子介面', tags: ['子介面', 'Inter-VLAN', 'DHCP'],
    brief: '部門隔開之後，大家卻連不到檔案伺服器了。VLAN 之間要互通必須經過路由器。路由器只剩一個埠可用，請用子介面讓它同時當三個 VLAN 的閘道，並替兩個部門發 DHCP。',
    given: [
      ['VLAN 10 業務', '192.168.10.0/24 · 閘道 .1'], ['VLAN 20 研發', '192.168.20.0/24 · 閘道 .1'],
      ['VLAN 30 伺服器', '192.168.30.0/24 · 閘道 .1'], ['檔案伺服器', '192.168.30.10（固定）'], ['DHCP 範圍', '各 VLAN 的 .100 – .199'],
    ],
    learn: [
      { t: 'VLAN 之間不通', d: '不同 VLAN 是不同的網段，要互通就得經過第三層設備（路由器或 L3 交換器）。' },
      { t: '子介面 (Sub-interface)', d: '在一個實體埠上建立多個邏輯介面，例如 Gi0/0/1.10 專門收發 VLAN 10 的標籤訊框。交換器那一端要設成 Trunk。' },
    ],
    setup: () => makeState([
      D('isr4321', 'rt', { name: 'Router', pos: [0, -6] }),
      D('c2960', 'sw', {
        name: 'Switch', pos: [0, -1.5],
        init(d) {
          d.sw.vlans.push({ id: 10, name: '業務' }, { id: 20, name: '研發' }, { id: 30, name: '伺服器' });
          d.sw.ports['Gi0/1'].vlan = 10; d.sw.ports['Gi0/2'].vlan = 20; d.sw.ports['Gi0/3'].vlan = 30;
        },
      }),
      D('pc', 'pc-s', { name: '業務 PC', pos: [-6.5, 3], dhcp: true }),
      D('pc', 'pc-r', { name: '研發 PC', pos: [0, 4.2], dhcp: true }),
      D('nas', 'fs', { name: '檔案伺服器', pos: [6.5, 3] }),
    ], [['pc-s:eth0', 'sw:Gi0/1'], ['pc-r:eth0', 'sw:Gi0/2'], ['fs:eth0', 'sw:Gi0/3'], ['rt:Gi0/0/1', 'sw:Gi0/9']]),
    objectives: [
      { type: 'dhcp', dev: 'pc-s', subnet: '192.168.10.0/24', label: '業務 PC 透過 DHCP 取得 192.168.10.x' },
      { type: 'dhcp', dev: 'pc-r', subnet: '192.168.20.0/24', label: '研發 PC 透過 DHCP 取得 192.168.20.x' },
      { type: 'tcp', from: 'pc-s', to: 'fs', port: 445, label: '業務 PC 可以開啟檔案伺服器 (SMB 445)' },
      { type: 'tcp', from: 'pc-r', to: 'fs', port: 445, label: '研發 PC 可以開啟檔案伺服器 (SMB 445)' },
      { type: 'ping', from: 'pc-s', to: 'pc-r', label: '業務 PC 可以 ping 到研發 PC（經由路由器）' },
    ],
    hints: [
      '交換器的 Gi0/9（接路由器那個埠）要改成 Trunk，三個 VLAN 才能都送到路由器。',
      '點路由器 →「介面」，在 Gi0/0/1 底下新增三個子介面：VLAN 10 / 20 / 30，IP 各是 192.168.10.1、192.168.20.1、192.168.30.1，遮罩 255.255.255.0。',
      '在 .10 和 .20 子介面開啟 DHCP（.100 – .199）。檔案伺服器手動設 192.168.30.10，閘道一定要填 192.168.30.1。',
    ],
    solve(s) {
      swp(s, 'sw', 'Gi0/9').mode = 'trunk';
      const r = dev(s, 'rt');
      for (const v of [10, 20, 30]) {
        const i = newIface(`Gi0/0/1.${v}`, `Gi0/0/1.${v}`, { t: 'sub', port: 'Gi0/0/1', vlan: v }, { ip: `192.168.${v}.1`, mask: '255.255.255.0' });
        if (v !== 30) Object.assign(i.dhcp, { on: true, start: `192.168.${v}.100`, end: `192.168.${v}.199` });
        r.ifaces.push(i);
      }
      setIp(s, 'fs', '192.168.30.10', '255.255.255.0', '192.168.30.1');
    },
    recap: ['每個 VLAN 對應一個子網路，也需要一個自己的閘道。', 'DHCP 的廣播出不了 VLAN，所以每個 VLAN 都要有自己的位址池。'],
  },

  // ════════════════════════ 第三章：企業網路 ════════════════════════
  {
    id: 'l09', chapter: 3, title: '守門員', subtitle: '防火牆政策與 DMZ', tags: ['Firewall', 'DMZ', 'VIP'],
    brief: '稽核報告指出：公司防火牆上只有一條「全部放行」的規則，對外網站一旦被入侵，駭客就能長驅直入內部網路。請改成最小權限的政策，並讓外部客戶能連到 DMZ 的網站。',
    given: [
      ['WAN1', '203.0.113.18/29 · 閘道 .17'], ['Internal (LAN)', '192.168.1.0/24'], ['DMZ', '172.16.1.0/24'],
      ['Web 伺服器', '172.16.1.10（DMZ）'], ['對外網址', 'https://203.0.113.18'],
    ],
    learn: [
      { t: '防火牆政策', d: '由上往下逐條比對：來源介面、目的介面、位址、服務。第一條符合的就決定放行或拒絕；都不符合則一律拒絕 (implicit deny)。' },
      { t: 'DMZ', d: '放對外服務的緩衝區。外面可以進 DMZ，內部也可以進 DMZ，但 DMZ 不能主動連回內部。' },
      { t: '狀態檢查', d: '防火牆會記住已放行的連線，回程封包自動通過，所以只需要替「發起方向」寫規則。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', {
        type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18',
      }),
      D('fg60f', 'fw', {
        name: 'Firewall', pos: [0, -4.4],
        init(d) {
          const g = (id) => d.ifaces.find((i) => i.id === id);
          Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
          Object.assign(g('wan2'), { ping: false });
          Object.assign(g('dmz'), { ip: '172.16.1.1', mask: '255.255.255.0' });
          Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
          Object.assign(g('internal').dhcp, { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '8.8.8.8' });
          d.policies.push({ name: 'ALLOW-ALL（前任留下）', srcIf: 'any', dstIf: 'any', src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: true });
        },
      }),
      D('sw8', 'sw', { name: 'LAN Switch', pos: [-5.5, 0] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-8.5, 4.4], dhcp: true }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [-3, 4.8], dhcp: true }),
      D('tower', 'web', { name: 'Web 伺服器', pos: [6, 0.6], ip: '172.16.1.10', gw: '172.16.1.1', dns: '8.8.8.8', services: WEB }),
    ], [['inet:line1', 'fw:wan1'], ['fw:1', 'sw:1'], ['pc-1:eth0', 'sw:2'], ['pc-2:eth0', 'sw:3'], ['fw:dmz', 'web:eth0']]),
    objectives: [
      { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443, label: '內部 PC 可以上網（https://www.example.com）' },
      { type: 'tcp', from: 'pc-2', to: 'web', port: 443, label: '內部 PC 可以連到 DMZ 的網站 (HTTPS)' },
      { type: 'tcp', from: 'inet', ip: '203.0.113.18', port: 443, label: '外部使用者可以開啟 https://203.0.113.18' },
      { type: 'ping', from: 'web', ip: '8.8.8.8', label: 'Web 伺服器可以連外（下載更新）' },
      { type: 'ping', from: 'web', to: 'pc-1', expect: false, label: 'DMZ 不能主動連到內部（Web ✕ PC-1）' },
    ],
    hints: [
      '先把「ALLOW-ALL」那條政策刪掉，再按來源 → 目的一條一條建立：internal → wan1、internal → dmz、dmz → wan1、wan1 → dmz。',
      '往 wan1 的政策要開啟 NAT，否則私有 IP 出不去。wan1 → dmz 的政策：目的位址填 172.16.1.10、服務選 HTTPS。',
      '在「虛擬 IP」分頁加一條：外部 TCP 443 → 172.16.1.10:443。千萬不要建立 dmz → internal 的放行政策。',
    ],
    solve(s) {
      const f = dev(s, 'fw');
      f.policies = [
        { name: 'LAN 上網', srcIf: 'internal', dstIf: 'wan1', src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: true },
        { name: 'LAN 到 DMZ', srcIf: 'internal', dstIf: 'dmz', src: 'any', dst: 'any', service: 'HTTPS', action: 'accept', nat: false },
        { name: 'DMZ 連外', srcIf: 'dmz', dstIf: 'wan1', src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: true },
        { name: '對外網站', srcIf: 'wan1', dstIf: 'dmz', src: 'any', dst: '172.16.1.10', service: 'HTTPS', action: 'accept', nat: false },
      ];
      f.portForwards.push({ proto: 'tcp', port: 443, toIp: '172.16.1.10', toPort: 443 });
    },
    recap: ['「全部放行」等於沒有防火牆。政策要寫得剛剛好。', '對外服務放 DMZ，就算被攻破也碰不到內部網路。'],
  },
  {
    id: 'l10', chapter: 3, title: '總公司與分公司', subtitle: '靜態路由與回程路由', tags: ['靜態路由', '專線', '預設路由'],
    brief: '分公司開幕了，電信業者拉了一條專線連回總公司。分公司的人要能使用總公司的 ERP，上網也要從總公司出去。兩台路由器的專線介面和路由表都還是空的。',
    given: [
      ['專線網段', '172.16.0.0/30'], ['總公司端 Gi0/0/2', '172.16.0.1'], ['分公司端 Gi0/0/0', '172.16.0.2'],
      ['總公司 LAN', '10.1.0.0/24'], ['分公司 LAN', '10.2.0.0/24'], ['ERP 伺服器', '10.1.0.10'],
    ],
    learn: [
      { t: '路由表', d: '路由器只認識自己直接連著的網段。其他網段要靠靜態路由告訴它：「要去 10.2.0.0/24，請交給 172.16.0.2」。' },
      { t: '回程路由', d: '封包去得了不代表回得來。兩邊的路由器都要知道對方的網段，這是最常見的遺漏。' },
      { t: '預設路由', d: '0.0.0.0/0 代表「其他所有地方」。分公司把它指向總公司，上網流量就會從總公司出去。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [-7, -9.5] }), 'line1', {
        type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34',
      }),
      D('isr4331', 'hq', {
        name: 'HQ-Router', pos: [-7, -4.5],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33', nat: true });
          Object.assign(d.ifaces[1], { ip: '10.1.0.1', mask: '255.255.255.0' });
        },
      }),
      D('isr4321', 'br', {
        name: 'Branch-Router', pos: [7, -4.5],
        init(d) { Object.assign(d.ifaces[1], { ip: '10.2.0.1', mask: '255.255.255.0' }); },
      }),
      D('sw5', 'hq-sw', { name: 'HQ-Switch', pos: [-7, 0.3] }),
      D('sw5', 'br-sw', { name: 'BR-Switch', pos: [7, 0.3] }),
      D('tower', 'erp', { name: 'ERP 伺服器', pos: [-10.5, 4.8], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
      D('pc', 'hq-pc', { name: '總公司 PC', pos: [-4, 4.8], ip: '10.1.0.50', gw: '10.1.0.1', dns: '8.8.8.8' }),
      D('pc', 'br-pc', { name: '分公司 PC', pos: [7, 4.8], ip: '10.2.0.50', gw: '10.2.0.1', dns: '8.8.8.8' }),
    ], [
      ['inet:line1', 'hq:Gi0/0/0'], ['hq:Gi0/0/1', 'hq-sw:1'], ['erp:eth0', 'hq-sw:2'], ['hq-pc:eth0', 'hq-sw:3'],
      ['hq:Gi0/0/2', 'br:Gi0/0/0'], ['br:Gi0/0/1', 'br-sw:1'], ['br-pc:eth0', 'br-sw:2'],
    ]),
    objectives: [
      { type: 'tcp', from: 'br-pc', to: 'erp', port: 443, label: '分公司 PC 可以使用總公司的 ERP (HTTPS)' },
      { type: 'ping', from: 'hq-pc', to: 'br-pc', label: '總公司 PC 可以 ping 到分公司 PC' },
      { type: 'tcp', from: 'br-pc', name: 'www.example.com', port: 443, label: '分公司 PC 可以經由總公司上網' },
    ],
    hints: [
      '先設定專線兩端的介面：HQ 的 Gi0/0/2 = 172.16.0.1、Branch 的 Gi0/0/0 = 172.16.0.2，遮罩都是 255.255.255.252。',
      '分公司路由器 →「路由」：新增預設路由 0.0.0.0 / 0.0.0.0，下一站 172.16.0.1。',
      '別忘了回程：總公司路由器要新增 10.2.0.0 / 255.255.255.0，下一站 172.16.0.2。',
    ],
    solve(s) {
      Object.assign(ifc(s, 'hq', 'Gi0/0/2'), { ip: '172.16.0.1', mask: '255.255.255.252' });
      Object.assign(ifc(s, 'br', 'Gi0/0/0'), { ip: '172.16.0.2', mask: '255.255.255.252' });
      dev(s, 'br').routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '172.16.0.1' });
      dev(s, 'hq').routes.push({ dst: '10.2.0.0', mask: '255.255.255.0', via: '172.16.0.2' });
    },
    recap: ['每一台經過的路由器都要知道「去」和「回」的路。', '/30 的網段只有兩個可用 IP，剛好給點對點線路的兩端。'],
  },

  // ════════════════════════ 第四章：資料中心 ════════════════════════
  {
    id: 'l11', chapter: 4, title: '機櫃上線', subtitle: 'ToR、核心交換器與 SVI', tags: ['ToR', 'SVI', 'L3 Switch', '光纖'],
    brief: '歡迎來到資料中心。機櫃 A 已經上架完成，請參考它把機櫃 B 的伺服器接上 ToR 交換器，再到核心交換器建立 VLAN 介面 (SVI) 作為各網段的閘道，讓 Web 層連得到 DB 層。',
    given: [
      ['VLAN 100 Web', '10.10.100.0/24 · 閘道 .1'], ['VLAN 200 DB', '10.10.200.0/24 · 閘道 .1'],
      ['web-2 / db-2', '10.10.100.12 / 10.10.200.12'], ['伺服器接 ToR', 'SFP28 埠（Eth1/1 – 48）'], ['ToR 上行', 'QSFP28 埠（Eth1/49 – 54）'],
    ],
    learn: [
      { t: 'ToR (Top of Rack)', d: '每個機櫃頂端放一台交換器，櫃內伺服器就近接上去，再用高速上行連到核心。' },
      { t: 'SVI (VLAN 介面)', d: 'L3 交換器可以替每個 VLAN 建立一個虛擬的 IP 介面當閘道，直接在交換器內做跨 VLAN 路由，不必外接路由器。' },
      { t: '接頭規格', d: '資料中心常用 SFP28 (25G) 接伺服器、QSFP28 (100G) 做上行。不同規格的埠不能互接。' },
    ],
    setup: () => makeState([
      D('n9332', 'core', { name: 'Core', pos: [0, -5.5] }),
      D('n93180', 'tor-a', {
        name: 'ToR-A', pos: [-6.5, -0.5],
        init(d) {
          d.sw.vlans.push({ id: 100, name: 'Web' }, { id: 200, name: 'DB' });
          d.sw.ports['Eth1/1'].vlan = 100; d.sw.ports['Eth1/2'].vlan = 200;
          d.sw.ports['Eth1/49'].mode = 'trunk';
        },
      }),
      D('n93180', 'tor-b', { name: 'ToR-B', pos: [6.5, -0.5] }),
      D('rack1u', 'web-1', { name: 'web-1', pos: [-9.5, 4.6], ip: '10.10.100.11', gw: '10.10.100.1', services: WEB }),
      D('rack1u', 'db-1', { name: 'db-1', pos: [-4, 4.6], ip: '10.10.200.11', gw: '10.10.200.1', services: DB }),
      D('rack1u', 'web-2', { name: 'web-2', pos: [4, 4.6], services: WEB }),
      D('rack1u', 'db-2', { name: 'db-2', pos: [9.5, 4.6], services: DB }),
    ], [['web-1:eth0', 'tor-a:Eth1/1'], ['db-1:eth0', 'tor-a:Eth1/2'], ['tor-a:Eth1/49', 'core:Eth1/1']]),
    objectives: [
      { type: 'ping', from: 'web-1', to: 'web-2', label: 'web-1 可以 ping 到另一個機櫃的 web-2' },
      { type: 'ping', from: 'db-2', ip: '10.10.200.1', label: 'db-2 可以 ping 到閘道 10.10.200.1' },
      { type: 'tcp', from: 'web-2', to: 'db-1', port: 3306, label: 'web-2 可以連到 db-1 的資料庫 (MySQL 3306)' },
      { type: 'tcp', from: 'web-1', to: 'db-2', port: 3306, label: 'web-1 可以連到 db-2 的資料庫 (MySQL 3306)' },
    ],
    hints: [
      '機櫃 B：web-2、db-2 接到 ToR-B 的 Eth1/1、Eth1/2，ToR-B 的 Eth1/49 接到 Core 的 Eth1/2。照 ToR-A 的做法在 ToR-B 建 VLAN 100 / 200、設定 Access 埠，並把 Eth1/49 設成 Trunk。',
      'Core：建立 VLAN 100 與 200，把 Eth1/1、Eth1/2 設成 Trunk。',
      'Core →「L3 介面」新增 VLAN 100 介面 10.10.100.1/24、VLAN 200 介面 10.10.200.1/24。最後替 web-2、db-2 設定 IP 與閘道。',
    ],
    solve(s) {
      link(s, 'web-2:eth0', 'tor-b:Eth1/1'); link(s, 'db-2:eth0', 'tor-b:Eth1/2'); link(s, 'tor-b:Eth1/49', 'core:Eth1/2');
      for (const id of ['tor-b', 'core']) { addVlan(s, id, 100, 'Web'); addVlan(s, id, 200, 'DB'); }
      swp(s, 'tor-b', 'Eth1/1').vlan = 100; swp(s, 'tor-b', 'Eth1/2').vlan = 200; swp(s, 'tor-b', 'Eth1/49').mode = 'trunk';
      swp(s, 'core', 'Eth1/1').mode = 'trunk'; swp(s, 'core', 'Eth1/2').mode = 'trunk';
      dev(s, 'core').ifaces.push(
        newIface('vlan100', 'Vlan100', { t: 'svi', vlan: 100 }, { ip: '10.10.100.1', mask: '255.255.255.0' }),
        newIface('vlan200', 'Vlan200', { t: 'svi', vlan: 200 }, { ip: '10.10.200.1', mask: '255.255.255.0' }),
      );
      setIp(s, 'web-2', '10.10.100.12', '255.255.255.0', '10.10.100.1');
      setIp(s, 'db-2', '10.10.200.12', '255.255.255.0', '10.10.200.1');
    },
    recap: ['L3 交換器 = 交換器 + 路由器，SVI 讓跨 VLAN 流量不必繞出去。', '這種「核心當閘道、ToR 純二層」的架構稱為 Collapsed Core。'],
  },
  {
    id: 'l12', chapter: 4, title: 'Spine-Leaf', subtitle: 'OSPF、備援與邊界防火牆', tags: ['Spine-Leaf', 'OSPF', '備援', '綜合'],
    brief: '期末考。前任工程師把 Spine-Leaf 架構做到一半就離職了：Spine-1 與 Leaf-1 已經上線，Leaf-2、Spine-2 和邊界防火牆都還沒完成。請把整座資料中心接起來，並確保任何一台 Spine 故障時服務都不中斷。',
    given: [
      ['Spine-1 ↔ Leaf-1', '10.0.1.0/30（已完成）'], ['Spine-1 ↔ Leaf-2', '10.0.1.4/30 · Spine .5 / Leaf .6'],
      ['Spine-2 ↔ Leaf-1', '10.0.2.0/30 · Spine .1 / Leaf .2'], ['Spine-2 ↔ Leaf-2', '10.0.2.4/30 · Spine .5 / Leaf .6'],
      ['上行埠', 'Spine Eth1/1→Leaf-1、Eth1/2→Leaf-2；Leaf Eth1/49→Spine-1、Eth1/50→Spine-2'],
      ['Web VLAN 10（Leaf-1）', '10.1.10.0/24 · 閘道 .1（已完成）'], ['DB VLAN 20（Leaf-2）', '10.1.20.0/24 · 閘道 .1 · db-1 = .11'],
      ['FW ↔ Leaf-1', '10.0.0.0/30 · FW x1 = .1 / Leaf-1 Eth1/48 = .2（介面已完成）'], ['對外網址', 'https://203.0.113.50 → web-1 (10.1.10.11)'],
    ],
    learn: [
      { t: 'Spine-Leaf', d: '每台 Leaf 都連到每台 Spine，全部走第三層。任兩台伺服器之間的距離固定，而且天生就有多條備援路徑。' },
      { t: 'Routed Port', d: '把交換器的埠改成「路由埠」，直接在上面設 IP，像路由器的介面一樣。Leaf 與 Spine 之間用 /30 點對點網段。' },
      { t: 'OSPF', d: '動態路由協定。在介面上啟用後，路由器會自動交換彼此知道的網段並算出最短路徑，線路斷了也會自動改道，不用手寫靜態路由。' },
    ],
    setup: () => {
      const routed = (d, pid, ip, ospf = true) => {
        d.sw.ports[pid].mode = 'routed';
        d.ifaces.push(newIface(pid, pid, { t: 'port', port: pid }, { ip, mask: '255.255.255.252', ospf }));
      };
      return makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [-13, -9.5] }), 'line1', {
          type: 'static', gw: '203.0.113.49', mask: '255.255.255.248', assign: '203.0.113.50',
        }),
        D('fg100f', 'fw', {
          name: 'Edge-FW', pos: [-13, -3.5],
          init(d) {
            const g = (id) => d.ifaces.find((i) => i.id === id);
            Object.assign(g('wan1'), { ip: '203.0.113.50', mask: '255.255.255.248', gateway: '203.0.113.49', ping: false });
            Object.assign(g('wan2'), { ping: false });
            Object.assign(g('x1'), { ip: '10.0.0.1', mask: '255.255.255.252' });
          },
        }),
        D('n9332', 'spine1', {
          name: 'Spine-1', pos: [-3.5, -7.5],
          init(d) { routed(d, 'Eth1/1', '10.0.1.1'); routed(d, 'Eth1/2', '10.0.1.5'); },
        }),
        D('n9332', 'spine2', { name: 'Spine-2', pos: [6, -7.5] }),
        D('n93180', 'leaf1', {
          name: 'Leaf-1', pos: [-4.5, -0.8],
          init(d) {
            routed(d, 'Eth1/49', '10.0.1.2'); routed(d, 'Eth1/48', '10.0.0.2', false);
            d.sw.vlans.push({ id: 10, name: 'Web' });
            d.sw.ports['Eth1/1'].vlan = 10; d.sw.ports['Eth1/2'].vlan = 10;
            d.ifaces.push(newIface('vlan10', 'Vlan10', { t: 'svi', vlan: 10 }, { ip: '10.1.10.1', mask: '255.255.255.0', ospf: true }));
          },
        }),
        D('n93180', 'leaf2', { name: 'Leaf-2', pos: [7, -0.8] }),
        D('rack1u', 'web-1', { name: 'web-1', pos: [-8.5, 4.8], ip: '10.1.10.11', gw: '10.1.10.1', services: WEB }),
        D('rack1u', 'web-2', { name: 'web-2', pos: [-2.5, 4.8], ip: '10.1.10.12', gw: '10.1.10.1', services: WEB }),
        D('rack1u', 'db-1', { name: 'db-1', pos: [7, 4.8], services: DB }),
      ], [
        ['inet:line1', 'fw:wan1'], ['fw:x1', 'leaf1:Eth1/48'],
        ['spine1:Eth1/1', 'leaf1:Eth1/49'], ['spine1:Eth1/2', 'leaf2:Eth1/49'],
        ['web-1:eth0', 'leaf1:Eth1/1'], ['web-2:eth0', 'leaf1:Eth1/2'], ['db-1:eth0', 'leaf2:Eth1/1'],
      ]);
    },
    objectives: [
      { type: 'tcp', from: 'web-1', to: 'db-1', port: 3306, label: 'web-1 可以連到 db-1 的資料庫 (MySQL 3306)' },
      {
        type: 'failover', down: ['spine1'], label: 'Spine-1 故障時，web-2 仍然連得到 db-1',
        test: { type: 'tcp', from: 'web-2', to: 'db-1', port: 3306 },
      },
      { type: 'tcp', from: 'inet', ip: '203.0.113.50', port: 443, label: '外部使用者可以開啟 https://203.0.113.50' },
      { type: 'ping', from: 'web-1', ip: '8.8.8.8', label: 'web-1 可以連外（8.8.8.8）' },
      { type: 'ping', from: 'db-1', ip: '8.8.8.8', expect: false, label: '資料庫不可以直接上網（db-1 ✕ 8.8.8.8）' },
    ],
    hints: [
      'Leaf-2：把 Eth1/49 改成 Routed 並設 10.0.1.6/30、勾 OSPF；建立 VLAN 20、Eth1/1 設為 VLAN 20；新增 Vlan20 介面 10.1.20.1/24 並勾 OSPF。db-1 設 10.1.20.11，閘道 10.1.20.1。',
      'Spine-2：Eth1/1 接 Leaf-1 的 Eth1/50、Eth1/2 接 Leaf-2 的 Eth1/50。四個埠都改成 Routed、填上 /30 的 IP 並勾 OSPF。可以參考 Spine-1 與 Leaf-1 的設定。',
      '對外：Leaf-1 新增預設路由 → 10.0.0.1，並勾選「向 OSPF 發布預設路由」。Edge-FW 新增靜態路由 10.0.0.0/255.0.0.0 → 10.0.0.2；政策 x1→wan1（來源 10.1.10.0/24、NAT）與 wan1→x1（目的 10.1.10.11、HTTPS）；虛擬 IP：TCP 443 → 10.1.10.11:443。',
    ],
    solve(s) {
      const routed = (id, pid, ip) => {
        swp(s, id, pid).mode = 'routed';
        dev(s, id).ifaces.push(newIface(pid, pid, { t: 'port', port: pid }, { ip, mask: '255.255.255.252', ospf: true }));
      };
      // Leaf-2
      routed('leaf2', 'Eth1/49', '10.0.1.6');
      addVlan(s, 'leaf2', 20, 'DB'); swp(s, 'leaf2', 'Eth1/1').vlan = 20;
      dev(s, 'leaf2').ifaces.push(newIface('vlan20', 'Vlan20', { t: 'svi', vlan: 20 }, { ip: '10.1.20.1', mask: '255.255.255.0', ospf: true }));
      setIp(s, 'db-1', '10.1.20.11', '255.255.255.0', '10.1.20.1');
      // Spine-2
      link(s, 'spine2:Eth1/1', 'leaf1:Eth1/50'); link(s, 'spine2:Eth1/2', 'leaf2:Eth1/50');
      routed('spine2', 'Eth1/1', '10.0.2.1'); routed('leaf1', 'Eth1/50', '10.0.2.2');
      routed('spine2', 'Eth1/2', '10.0.2.5'); routed('leaf2', 'Eth1/50', '10.0.2.6');
      // 邊界
      dev(s, 'leaf1').routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.0.0.1' });
      dev(s, 'leaf1').ospfDefault = true;
      const f = dev(s, 'fw');
      f.routes.push({ dst: '10.0.0.0', mask: '255.0.0.0', via: '10.0.0.2' });
      f.policies.push(
        { name: 'Web 連外', srcIf: 'x1', dstIf: 'wan1', src: '10.1.10.0/24', dst: 'any', service: 'ALL', action: 'accept', nat: true },
        { name: '對外網站', srcIf: 'wan1', dstIf: 'x1', src: 'any', dst: '10.1.10.11', service: 'HTTPS', action: 'accept', nat: false },
      );
      f.portForwards.push({ proto: 'tcp', port: 443, toIp: '10.1.10.11', toPort: 443 });
    },
    recap: ['Spine-Leaf 靠第三層與動態路由取得備援，不需要 Spanning Tree。', '你已經從一條網路線，走到一座有備援、有邊界防護的資料中心了。'],
  },
];

CHAPTERS.push(...CHAPTERS2, ...CHAPTERS3, ...CHAPTERS4, ...CHAPTERS5, ...CHAPTERS6, ...CHAPTERS7, ...CHAPTERS8, ...CHAPTERS9, ...CHAPTERS10, ...CHAPTERS11);
LEVELS.push(...LEVELS2, ...LEVELS3, ...LEVELS4, ...LEVELS5, ...LEVELS6, ...LEVELS7, ...LEVELS8, ...LEVELS9, ...LEVELS10, ...LEVELS11, ...LEVELS12, ...LEVELS13, ...LEVELS14, ...LEVELS15, ...LEVELS16, ...LEVELS17, ...LEVELS18, ...LEVELS19, ...LEVELS20, ...LEVELS21, ...LEVELS22, ...LEVELS23, ...LEVELS24, ...LEVELS25, ...LEVELS26, ...LEVELS27, ...LEVELS28, ...LEVELS29, ...LEVELS30, ...LEVELS31, ...LEVELS32, ...LEVELS33, ...LEVELS34);
LEVELS.sort((a, b) => a.chapter - b.chapter); // 穩定排序：補充關卡排到所屬章節的最後

// 關卡裡的設備都由「前任管理員」設好了一些東西（portfast default、SSH、SNMP），見 util.js 的 levelDefaults
for (const lv of LEVELS) {
  const setup = lv.setup;
  lv.setup = () => levelDefaults(setup());
}

export const levelById = (id) => LEVELS.find((l) => l.id === id);
