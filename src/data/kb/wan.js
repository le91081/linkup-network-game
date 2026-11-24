// 知識庫：VPN 與廣域網路
export const WAN = [
  {
    id: 'ipsec', t: 'IPsec', en: 'IPsec site-to-site VPN', cat: 'wan', keys: ['IPsec', 'IKE', 'IKEv2', 'ESP', 'PSK', '預先共用金鑰', '第一階段', '第二階段', 'crypto map', 'transform-set', 'proxy ID', 'crypto ACL', '站對站'], tags: ['IPsec', 'IKE', 'IKEv2', 'Site-to-Site', '站對站 VPN', 'crypto ACL', 'transform-set', 'show crypto', 'NAT 例外', 'rsa-sig'],
    sum: '兩個據點的路由器或防火牆在網際網路上建立加密通道：先用 IKE 互相驗證、談好加密方式，之後符合範圍的封包包進 ESP 加密送給對方。',
    body: [
      '第一階段（IKE SA）：雙方驗證身分（預先共用金鑰或憑證）、協商加密 / 雜湊 / DH 群組，兩端的提案要有一組完全一樣。第二階段（IPsec SA）：談好用什麼保護資料，以及哪些流量要加密（本地與遠端網段，兩端要互為鏡像）。',
      'SA 有生命週期，到期前會重新協商（rekey）；設了 DPD / keepalive 才會主動發現對方失聯，不然要等到 SA 到期。',
      '路由器先 NAT 再看要不要加密：往對方內網的流量要排除在 NAT 之外，不然來源被換掉就不符合加密範圍了。',
    ],
    steps: { t: '建立通道', items: ['有流量符合加密範圍（或通道設成一直開著）→ 觸發 IKE。', '第一階段：交換提案（加密、雜湊、DH、生命週期），找到兩端都有的一組；DH 算出共同的金鑰；用 PSK 或憑證驗證對方。', '第二階段：在第一階段的保護下，談好 ESP 的加密方式與要保護的網段（proxy ID）。', '開始加密：每個封包包進 ESP（加上新的外層 IP 標頭）送到對端，對端解密後照內層的目的地轉送。'] },
    fig: { type: 'fields', title: 'ESP 通道模式的封包', rows: [{ l: '新的 IP 標頭', n: '20', d: '兩端的公用位址' }, { l: 'ESP 標頭', n: '8', hl: true, d: 'SPI、序號' }, { l: '原本的 IP 封包（加密）', n: '…', w: 3, hl: true }, { l: 'ESP 尾端 + 驗證', n: '≈ 14–30', hl: true }] },
    pit: ['兩端的 PSK 或提案不一樣：第一階段就失敗。', '兩端的加密範圍不是鏡像（一邊寫 /24、另一邊寫 /16）：第二階段失敗。', '新增了網段卻只改了一端的 crypto ACL。', 'IPsec 多了幾十位元組：大封包要調 MSS。'],
    cmd: [{ v: 'Cisco IOS', c: ['crypto isakmp policy 10', ' encryption aes 256', ' hash sha256', ' authentication pre-share', ' group 14', 'crypto isakmp key **** address 198.51.100.2', 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'access-list 110 permit ip 10.1.0.0 0.0.0.255 10.2.0.0 0.0.0.255', 'crypto map VPN 10 ipsec-isakmp', ' set peer 198.51.100.2', ' set transform-set TS', ' match address 110', 'interface Gi0/0/0', ' crypto map VPN', 'show crypto isakmp sa', 'show crypto ipsec sa'] }],
    see: ['nat-t', 'gre', 'dmvpn', 'nat'],
  },
  {
    id: 'nat-t', t: 'NAT-T', en: 'NAT traversal', cat: 'wan', keys: ['NAT-T', 'NAT 穿透', 'UDP 4500'], tags: ['NAT-T', 'NAT 穿透'],
    sum: 'IPsec 的一端在 NAT 後面時，把 ESP 再包進 UDP 4500：ESP 沒有連接埠號碼，PAT 沒辦法轉換它，包進 UDP 才穿得過。',
    body: ['IKE 協商時兩端會偵測中間有沒有 NAT（比對位址的雜湊），有的話自動改用 UDP 4500，並定時送 keepalive 讓 NAT 的轉換不會過期。'],
    see: ['ipsec', 'nat'],
  },
  {
    id: 'gre', t: 'GRE 與 Tunnel 介面', en: 'GRE tunnel', cat: 'wan', keys: ['GRE', 'Tunnel 介面', 'interface Tunnel', 'tunnel source', 'tunnel destination', 'recursive routing', 'VTI', 'tunnel protection'], tags: ['GRE', 'Tunnel', 'recursive routing', 'VTI', 'tunnel protection', 'route-based VPN'],
    sum: 'GRE 把封包包進另一個 IP 標頭送到對面：兩端各有一個 Tunnel 介面，看起來像一條直連的線，可以跑 OSPF、多點傳送；但 GRE 本身不加密。',
    body: [
      'GRE over IPsec（或 VTI：tunnel mode ipsec ipv4）讓通道加密，而且是「路由式」的 VPN：路由指到 Tunnel 介面的流量就會加密，不用寫 crypto ACL。',
      'recursive routing：往 tunnel destination 的路如果改走 Tunnel 自己（例如從 Tunnel 裡的 OSPF 學到一條更好的路），通道就會一直上上下下。往對端公用位址的路要固定走實體的 WAN。',
    ],
    fig: { type: 'fields', title: 'GRE 封裝', rows: [{ l: '外層 IP', n: '20', hl: true, d: 'tunnel source → destination' }, { l: 'GRE', n: '4', hl: true }, { l: '原本的 IP 封包', n: '…', w: 3 }] },
    cmd: [{ v: 'Cisco IOS', c: ['interface Tunnel0', ' ip address 172.16.0.1 255.255.255.252', ' tunnel source Gi0/0/0', ' tunnel destination 198.51.100.2', ' tunnel protection ipsec profile PROF'] }],
    see: ['ipsec', 'dmvpn', 'mtu'],
  },
  {
    id: 'dmvpn', t: 'DMVPN', en: 'Dynamic Multipoint VPN', cat: 'wan', keys: ['DMVPN', 'mGRE', 'NHRP', 'Hub-and-Spoke', 'spoke'], tags: ['DMVPN', 'mGRE', 'NHRP', 'Hub-and-Spoke'],
    sum: '一個 hub 加上很多分公司（spoke）：每個 spoke 只要設定 hub 的位址，用 NHRP 向 hub 註冊；spoke 之間需要時再直接建立通道（phase 2 / 3）。',
    body: ['hub 的 Tunnel 是 mGRE（多點），NHRP 像是 Tunnel 位址與公用位址的對照表。phase 3 由 hub 送 NHRP redirect，讓 spoke 之間改走直接的捷徑。'],
    see: ['gre', 'ipsec'],
  },
  {
    id: 'ssl-vpn', t: 'SSL-VPN 與遠端存取', en: 'Remote-access VPN', cat: 'wan', keys: ['SSL-VPN', '遠端存取 VPN', 'Remote Access VPN', '分割通道', '全通道', 'Split Tunnel', 'split-tunneling', 'ssl.root', 'FortiClient'], tags: ['SSL-VPN', 'Remote Access VPN', 'Split Tunnel', '全通道'],
    sum: '在家工作的人用 VPN 用戶端連回公司：防火牆驗證帳號後發一個 VPN 位址，往公司的流量加密送進來。分割通道只有公司的網段走 VPN，全通道連上網都經過公司。',
    body: [
      'SSL-VPN 走 TLS（FortiGate 預設 TCP 10443），比 IPsec 容易穿過飯店、咖啡廳的防火牆。帳號可以是防火牆本機的，或對應到 AD（LDAP）的群組。',
      'VPN 用戶進來的介面是 ssl.root（遠端使用者 VPN）：要有它到 internal 的政策（只放行需要的服務）；全通道時還要有它到 wan1 的政策並開 NAT，使用者連著 VPN 才上得了網。',
    ],
    pit: ['VPN 位址池和公司內部的網段重疊：路由會亂掉。', '全通道少了往 wan1 的政策或 NAT：連上 VPN 就不能上網。'],
    see: ['ipsec', 'stateful-fw', 'nat'],
  },
  {
    id: 'sdwan', t: 'SD-WAN', en: 'Software-defined WAN', cat: 'wan', keys: ['SD-WAN', 'Performance SLA'], tags: ['SD-WAN', 'SLA'],
    sum: '把好幾條 WAN 線路（光纖、4G、另一家 ISP）當成一個整體：持續量測每條線的延遲、遺失與抖動，依應用程式的需求自動挑最適合的那一條。',
    body: ['規則例如「語音走延遲 < 150 ms、遺失 < 1% 的線，都不符合就走品質最好的」；一般上網依來源位址分散到所有成員。和只看介面上下的備援不同，線路變差（但沒斷）也會切換。'],
    see: ['ip-sla', 'pbr', 'qos'],
  },
  {
    id: 'mpls', t: 'MPLS L3VPN', en: 'MPLS Layer 3 VPN', cat: 'wan', keys: ['MPLS', 'L3VPN', 'MPLS VPN', 'LDP', 'mpls ip', 'route-target', 'VPNv4', 'RD', 'PE', 'CE', 'P 路由器'], tags: ['MPLS', 'L3VPN', 'route-target', 'VPNv4', 'LDP', 'allowas-in', 'as-override'],
    sum: '電信業者的骨幹替每個客戶開一個 VRF：客戶的路在 PE 之間用 MP-BGP（VPNv4）交換，封包貼著標籤穿過骨幹，不同客戶的位址可以重疊。',
    body: [
      'CE 是客戶的路由器、PE 是業者接客戶的路由器、P 是骨幹中間的路由器。RD 讓重疊的位址在 BGP 裡分得開；route-target 決定路要匯入哪個 VRF（import 打錯就會收到別家客戶的路）。',
      '封包在骨幹貼兩層標籤：外層是 LDP 發的、往對面 PE 的標籤（每一站換一次，倒數第二站拿掉），內層是 VPN 標籤（告訴對面 PE 是哪個 VRF）。骨幹的每一段線兩端都要 mpls ip；少一段，BGP 照樣 Established、路由表也有路，封包卻在那一站被丟掉。',
    ],
    fig: { type: 'fields', title: '在骨幹裡的封包', rows: [{ l: '乙太網路標頭', n: '14' }, { l: 'LDP 標籤（往對面 PE）', n: '4', hl: true, d: '每一站交換' }, { l: 'VPN 標籤（哪個 VRF）', n: '4', hl: true, d: '對面 PE 才看' }, { l: '客戶原本的 IP 封包', n: '…', w: 3 }] },
    cmd: [{ v: 'Cisco IOS（PE）', c: ['vrf definition CUST-A', ' rd 64500:1', ' address-family ipv4', '  route-target both 64500:1', 'interface Gi0/0/0', ' mpls ip', 'router bgp 64500', ' neighbor 10.255.0.3 remote-as 64500', ' neighbor 10.255.0.3 update-source Loopback0', ' address-family vpnv4', '  neighbor 10.255.0.3 activate', ' address-family ipv4 vrf CUST-A', '  redistribute connected', '  redistribute static', 'show mpls ldp neighbor', 'show bgp vpnv4 unicast all'] }],
    see: ['vrf', 'bgp', 'metro-e'],
  },
  {
    id: 'metro-e', t: 'Metro Ethernet', en: 'Carrier Ethernet (E-Line / E-LAN)', cat: 'wan', keys: ['Metro Ethernet', 'E-Line', 'E-LAN', 'EPL', 'EVPL', 'EVC', 'L2PT', 'CE-VLAN'], tags: ['Metro Ethernet', 'E-Line', 'EVPL', 'E-LAN', 'L2PT', '專線'],
    sum: '業者提供第二層的專線：E-Line 是點對點、E-LAN 是多點（像一台很大的交換器）。EPL 整個埠透通；EVPL 依 VLAN 標籤（CE-VLAN）區分服務。',
    body: [
      'EVPL 只收指定 CE-VLAN 的訊框：路由器要用 dot1Q 子介面送出帶標籤的訊框，不帶標籤的會被業者丟掉。業者的 MTU 通常有 1522（多了標籤的空間）。',
      '業者預設不轉送客戶的 BPDU、CDP、LLDP：客戶自己另外有一條備援線時，STP 看不到專線那一邊，形成看不見的迴圈。申請 L2PT（第二層協定透通），或改用路由器在第三層接專線。',
    ],
    see: ['mpls', 'subif', 'stp'],
  },
];
