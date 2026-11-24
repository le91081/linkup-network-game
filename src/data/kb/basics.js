// 知識庫：網路基礎
export const BASICS = [
  {
    id: 'osi', t: 'OSI 模型', en: 'OSI / TCP/IP model', cat: 'basics', keys: ['OSI', 'TCP/IP 模型'],
    sum: '把網路通訊分成幾層，每一層只管自己的事：線路、同一個網段裡的傳送、跨網段的路由、應用程式之間的連線。',
    body: [
      '排除故障時，從下往上一層一層確認最有效率：線有沒有燈號（第一層）→ 同一個網段裡找不找得到對方（第二層）→ 有沒有路可以走（第三層）→ 連接埠有沒有開、有沒有被擋（第四層）→ 應用程式本身。',
      '交換器主要工作在第二層（看 MAC 位址），路由器在第三層（看 IP 位址），防火牆通常看到第四層（連接埠）甚至第七層（網址、應用程式）。',
    ],
    fig: {
      type: 'table', head: ['層', '名稱', '看什麼', '設備 / 例子'],
      rows: [['7', '應用層', '網址、指令', 'HTTP、DNS、SSH'], ['4', '傳輸層', '連接埠', 'TCP、UDP'], ['3', '網路層', 'IP 位址', '路由器、L3 交換器'], ['2', '資料鏈結層', 'MAC 位址、VLAN', '交換器、AP'], ['1', '實體層', '電訊號、光', '網路線、光纖、Hub']],
    },
    pit: ['「ping 得到」只證明第三層通了，不代表 TCP 443 通（第四層可能被防火牆擋）。', '燈號有亮不代表第二層通：VLAN 不對、STP 擋住都會讓線亮著卻送不過去。'],
    see: ['mac', 'ip-address', 'tcp-udp'],
  },
  {
    id: 'ip-address', t: 'IP 位址', en: 'IPv4 address', cat: 'basics', keys: ['IPv4 位址', 'IP 位址', 'IPv4'], tags: ['IP 位址', '固定 IP'],
    sum: '設備在網路上的地址：32 位元，寫成四段 0–255 的數字，前面一部分是網段、後面是主機。',
    body: [
      'IP 位址要搭配子網路遮罩才有意義：遮罩決定前面幾個位元是「網段」（像街道名稱），剩下的是「主機」（門牌號碼）。同一個網段的設備可以直接用 ARP 找到對方；不同網段就要交給預設閘道（路由器）。',
      '每個網段有兩個位址不能給設備用：主機位元全是 0 的「網段位址」與全是 1 的「廣播位址」。例如 192.168.1.0/24 能用的是 .1 到 .254。',
      '位址可以手動設定（固定 IP，伺服器、印表機、網路設備）或由 DHCP 自動發放（一般的電腦、手機）。',
    ],
    pit: ['同一個網段裡兩台設備用了同一個 IP（IP 衝突）：通訊會時好時壞，因為 ARP 一下指向這台、一下指向那台。', '把網段位址或廣播位址設給設備：作業系統會拒絕或不正常運作。'],
    cmd: [{ v: 'Windows', c: ['ipconfig /all'] }, { v: 'Linux', c: ['ip addr'] }, { v: 'Cisco IOS', c: ['interface Gi0/0/1', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'] }],
    see: ['subnet', 'gateway', 'dhcp', 'private-ip'],
  },
  {
    id: 'subnet', t: '子網路遮罩', en: 'Subnet mask / CIDR', cat: 'basics', keys: ['子網路遮罩', 'CIDR', 'VLSM', '子網路切割', 'Subnetting'], tags: ['子網路遮罩', 'Subnetting', 'VLSM', 'CIDR'],
    sum: '標出 IP 位址裡哪幾個位元是網段：255.255.255.0 等於 /24，前 24 個位元是網段、後 8 個位元是主機。',
    body: [
      'CIDR 寫法（/24）直接寫出網段的位元數。主機位元有 n 個，網段就有 2ⁿ 個位址，扣掉網段位址與廣播位址，能用的是 2ⁿ − 2 個。',
      '切子網路（Subnetting）就是把網段位元往後借：一個 /24 借 2 個位元，變成 4 個 /26，每個 64 個位址（62 個能用）。VLSM 是同一個大網段裡切出不同大小的子網路：辦公室用 /24、路由器之間的線路用 /30。',
      '判斷兩個位址是不是在同一個網段：把位址和遮罩做 AND，結果（網段位址）一樣就是同一個網段。',
    ],
    fig: [{ type: 'bits', ip: '192.168.10.77', bits: 26 }, {
      type: 'table', head: ['CIDR', '遮罩', '位址數', '可用主機'],
      rows: [['/24', '255.255.255.0', '256', '254'], ['/25', '255.255.255.128', '128', '126'], ['/26', '255.255.255.192', '64', '62'], ['/27', '255.255.255.224', '32', '30'], ['/28', '255.255.255.240', '16', '14'], ['/30', '255.255.255.252', '4', '2'], ['/32', '255.255.255.255', '1', '（單一主機，例如 Loopback）']],
    }],
    steps: { t: '算出網段與可用範圍（以 192.168.10.77/26 為例）', items: ['/26：前 26 位元是網段，主機位元 6 個 → 每段 64 個位址。', '最後一段 77 落在 64–127 這一格。', '網段位址 192.168.10.64，廣播位址 192.168.10.127。', '可以用的主機：192.168.10.65 – 192.168.10.126（62 個）。'] },
    pit: ['兩端的遮罩寫得不一樣：一邊覺得對方在同一個網段、另一邊覺得要送給閘道，結果只有一個方向通。', '把 /32 寫在要接其他設備的介面上：這個網段只有自己，閘道永遠「不在網段內」。'],
    see: ['ip-address', 'gateway', 'routing-table'],
  },
  {
    id: 'gateway', t: '預設閘道', en: 'Default gateway', cat: 'basics', keys: ['預設閘道', '閘道', 'default gateway', 'ip default-gateway'], tags: ['預設路由'],
    sum: '目的地不在自己網段時，封包要先交給誰：通常是這個網段上的路由器介面。',
    body: [
      '電腦送封包之前先比對：目的 IP 和自己在同一個網段 → 直接用 ARP 問對方的 MAC；不在同一個網段 → 用 ARP 問「閘道」的 MAC，把封包交給閘道，由它去找路。',
      '閘道一定要在自己的網段內。L2 交換器自己的管理位址也需要閘道（ip default-gateway），不然只有同一個網段的人連得到它。',
    ],
    pit: ['閘道打錯（指到不存在的位址）：同網段通、其他網段全部不通，追蹤會停在「ARP 沒有回應」。', '閘道設成另一個網段的位址：作業系統用不了它。', '伺服器忘了設閘道：從別的網段連進來的請求它收得到，回應卻送不回去（回程失敗）。'],
    see: ['arp', 'routing-table', 'fhrp'],
  },
  {
    id: 'private-ip', t: '私有位址', en: 'Private address (RFC 1918)', cat: 'basics', keys: ['私有位址', '私有 IP', '公用位址', '公用 IP', 'RFC 1918'], tags: ['公用 IP', '公用 IP 區段'],
    sum: '10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 只能在內部使用，網際網路上不會轉送，出去之前要 NAT 成公用位址。',
    body: [
      '公用位址全世界唯一，由 ISP 分配；私有位址每間公司、每個家庭都可以重複使用。內部的設備上網時，出口的路由器或防火牆用 NAT 把來源換成公用位址。',
      '另外幾個特別的範圍：127.0.0.0/8 是本機迴路、169.254.0.0/16 是 DHCP 失敗時的自動位址（APIPA）、100.64.0.0/10 是電信業者的 CGNAT。',
    ],
    pit: ['少了 NAT：私有位址的封包送到 ISP 就被丟掉，追蹤會寫「私有 IP，ISP 直接丟棄」。'],
    see: ['nat', 'apipa', 'ip-address'],
  },
  {
    id: 'apipa', t: 'APIPA', en: 'Automatic Private IP Addressing', cat: 'basics', keys: ['APIPA', '169.254'],
    sum: '電腦用 DHCP 要不到位址時，自己挑一個 169.254.x.x：只能和同一條線上同樣失敗的設備溝通，代表 DHCP 出了問題。',
    body: ['看到 169.254 開頭的位址，就往回查 DHCP：伺服器有沒有開、位址池是不是用完了、中間的 VLAN 或 Trunk 對不對、跨網段有沒有 DHCP Relay。'],
    see: ['dhcp', 'dhcp-relay'],
  },
  {
    id: 'mac', t: 'MAC 位址', en: 'MAC address', cat: 'basics', keys: ['MAC 位址', 'MAC'], tags: ['MAC 位址'],
    sum: '網卡的硬體位址：48 位元，寫成 6 組十六進位（00:1a:2b:3c:4d:5e），在同一個網段裡（第二層）用來送訊框。',
    body: [
      '前 24 位元是廠商代碼（OUI），後 24 位元由廠商編號。交換器靠 MAC 位址表決定訊框要從哪個埠送出去。',
      'IP 位址決定「最後要到哪裡」，MAC 位址決定「這一段要交給誰」：封包每經過一台路由器，IP 不變，MAC 就換成下一段的兩端。',
      'FFFF.FFFF.FFFF 是廣播位址，同一個 VLAN 裡的每一台都會收到。',
    ],
    fig: { type: 'fields', title: '乙太網路訊框（Ethernet II）', rows: [{ l: '目的 MAC', n: '6' }, { l: '來源 MAC', n: '6' }, { l: '類型', n: '2', d: '0x0800 = IPv4' }, { l: '資料（IP 封包）', n: '46–1500', w: 3 }, { l: 'FCS', n: '4', d: '檢查碼（CRC）' }] },
    see: ['arp', 'mac-table', 'ip-address'],
  },
  {
    id: 'arp', t: 'ARP', en: 'Address Resolution Protocol', cat: 'basics', keys: ['ARP', 'ARP 快取', 'ARP 表'], tags: ['ARP'],
    sum: '知道對方的 IP、不知道它的 MAC 時，用廣播問「誰是 192.168.1.1？」，對方單點回覆自己的 MAC，結果記在 ARP 快取裡。',
    body: [
      '要送給同網段的主機就問主機本身；要送到其他網段就問閘道。問到之後記在 ARP 快取（Windows 預設幾分鐘、Cisco 預設 4 小時），之後不用再問。',
      '「ARP 沒有回應」是第二層不通最常見的症狀：線沒接好、VLAN 不同、Trunk 沒有放行那個 VLAN、對方根本沒有這個 IP。',
    ],
    fig: { type: 'ladder', a: 'PC-A 192.168.1.10', b: '閘道 192.168.1.1', msgs: [{ from: 'a', t: 'ARP 請求（廣播）：誰是 192.168.1.1？請告訴 192.168.1.10' }, { from: 'b', t: 'ARP 回覆（單點）：192.168.1.1 在 00:1a:2b:3c:4d:5e' }, { from: 'a', t: '記進 ARP 快取，開始送真正的封包' }] },
    pit: ['ARP 沒有驗證機制：任何人都可以送假的回覆，把別人的流量騙到自己這裡（ARP 欺騙，用 DAI 防）。', 'IP 換了設備之後還連到舊的那台：對方的 ARP 快取還沒過期（可以 clear arp-cache）。'],
    cmd: [{ v: 'Windows', c: ['arp -a'] }, { v: 'Cisco IOS', c: ['show ip arp', 'clear arp-cache'] }],
    see: ['mac', 'gateway', 'dai'],
  },
  {
    id: 'broadcast-domain', t: '廣播網域', en: 'Broadcast domain', cat: 'basics', keys: ['廣播網域', '碰撞網域'],
    sum: '一個廣播封包（ARP、DHCP）會送到的範圍：同一個 VLAN 就是同一個廣播網域，路由器會把廣播擋下來。',
    body: [
      '交換器的每個埠是一個獨立的碰撞網域（全雙工就沒有碰撞），但同一個 VLAN 的所有埠是同一個廣播網域。Hub 則是整台一個碰撞網域。',
      '廣播網域太大，每台設備都要處理大量不相干的廣播；有迴圈時廣播會無止境地繞（廣播風暴）。用 VLAN 與路由切成比較小的網段。',
    ],
    see: ['vlan', 'hub-switch', 'storm-control'],
  },
  {
    id: 'hub-switch', t: 'Hub、交換器與路由器', en: 'Hub / switch / router', cat: 'basics', keys: ['Hub', '非網管交換器', '網管型交換器'], tags: ['Switch', '網管型交換器'],
    sum: 'Hub 把收到的訊號送到每一個埠；交換器學 MAC 位址，只送往目的地那個埠；路由器看 IP 位址，在不同網段之間轉送。',
    body: [
      'Hub 是第一層設備，半雙工、所有埠共用頻寬，大家都看得到彼此的流量。交換器是第二層，每個埠獨立、全雙工。路由器是第三層，連接不同網段、隔開廣播。',
      '非網管交換器沒有設定介面：不能切 VLAN、通常不跑 STP。網管型交換器可以設 VLAN、Trunk、STP、Port Security。L3 交換器另外還能在 VLAN 之間路由（SVI）。',
    ],
    fig: { type: 'table', head: ['設備', '層', '依據', '隔開'], rows: [['Hub', '1', '不看位址', '什麼都不隔開'], ['交換器', '2', 'MAC 位址', '碰撞網域'], ['路由器', '3', 'IP 位址', '廣播網域']] },
    see: ['mac-table', 'vlan', 'svi'],
  },
  {
    id: 'tcp-udp', t: 'TCP 與 UDP', en: 'TCP / UDP', cat: 'basics', keys: ['TCP', 'UDP', '三向交握', 'SYN', 'three-way handshake'], tags: ['TCP', 'UDP'],
    sum: 'TCP 先建立連線、確認收到、遺失會重送（網頁、SSH、郵件）；UDP 直接送、不確認（DNS、DHCP、語音、串流）。',
    body: [
      'TCP 用三向交握建立連線，之後每一段資料都要對方確認（ACK），弄丟了就重送，所以可靠但比較慢。UDP 沒有連線，掉了就掉了，適合查詢一次就好或即時的資料。',
      '防火牆、ACL 放行的時候要注意協定：DNS 平常走 UDP 53，回應太大時改走 TCP 53；只放行其中一種就會有些情況失敗。',
    ],
    fig: { type: 'ladder', a: '用戶端', b: '伺服器 :443', msgs: [{ from: 'a', t: 'SYN（我要連線）' }, { from: 'b', t: 'SYN-ACK（好，我也要）' }, { from: 'a', t: 'ACK（連線建立）' }, { from: 'a', t: '資料…（每一段都要 ACK）' }] },
    pit: ['連接埠沒開（服務沒跑）：TCP 會收到 RST「連線被拒絕」；被防火牆丟掉：什麼都收不到，等到逾時。'],
    see: ['ports', 'icmp', 'stateful-fw'],
  },
  {
    id: 'ports', t: '連接埠號碼', en: 'TCP / UDP port', cat: 'basics', keys: ['連接埠號碼', '埠號', '知名連接埠'],
    sum: '同一台主機上用來分辨是哪一個服務：網頁 443、SSH 22、DNS 53；用戶端自己隨機挑一個大的號碼當來源埠。',
    body: ['一條連線由五個欄位決定：來源 IP、來源埠、目的 IP、目的埠、協定。NAT（PAT）就是靠改來源埠，讓很多台電腦共用一個公用位址。'],
    fig: { type: 'table', head: ['服務', '協定', '埠'], rows: [['HTTP / HTTPS', 'TCP', '80 / 443'], ['SSH / Telnet', 'TCP', '22 / 23'], ['DNS', 'UDP（大的回應用 TCP）', '53'], ['DHCP', 'UDP', '67（伺服器）/ 68（用戶端）'], ['NTP', 'UDP', '123'], ['SNMP / Trap', 'UDP', '161 / 162'], ['Syslog', 'UDP', '514'], ['SMTP', 'TCP', '25'], ['RDP', 'TCP', '3389'], ['IKE / NAT-T', 'UDP', '500 / 4500'], ['BGP', 'TCP', '179']] },
    see: ['tcp-udp', 'nat', 'acl'],
  },
  {
    id: 'icmp', t: 'ICMP、ping 與 traceroute', en: 'ICMP', cat: 'basics', keys: ['ICMP', 'ping', 'traceroute', 'tracert'], tags: ['ICMP', 'tracert'],
    sum: 'ICMP 是網路層的「回報」訊息：ping 用 echo 測試通不通，traceroute 利用 TTL 一站一站找出路徑。',
    body: [
      '每個 IP 封包都有 TTL，每經過一台路由器減 1，減到 0 就丟掉並回報「TTL 逾時」。traceroute 先送 TTL 1、再送 TTL 2…，每一站回報的位址就是路徑。',
      'ICMP 也負責回報「目的地無法到達」「需要分段」（PMTUD 靠它）與 Redirect。把 ICMP 全擋掉會讓 PMTUD 失效，大封包莫名其妙送不過去。',
    ],
    steps: { t: 'traceroute 怎麼找出路徑', items: ['送出 TTL = 1 的封包：第一台路由器把 TTL 減成 0，丟掉並回報 ICMP Time Exceeded → 知道第一站。', '再送 TTL = 2：第二台回報 → 知道第二站。', '一直加，直到目的地回應（echo reply 或連接埠無法到達）。', '某一站顯示 * 表示那一站沒有回報（可能擋了 ICMP），不一定代表不通。'] },
    pit: ['ping 不通不一定是斷線：主機的防火牆常常擋 ping（Windows 預設不回 ping）。', '有些設備（FortiGate 的 wan、雲端的安全群組）預設不回 ping，要測試連線用 TCP 比較準。'],
    cmd: [{ v: 'Windows', c: ['ping 8.8.8.8', 'tracert 8.8.8.8'] }, { v: 'Cisco IOS', c: ['ping 10.1.0.10 source Gi0/0/1', 'traceroute 10.1.0.10'] }],
    see: ['mtu', 'tcp-udp', 'routing-table'],
  },
  {
    id: 'mtu', t: 'MTU 與 MSS', en: 'MTU / MSS / PMTUD', cat: 'basics', keys: ['MTU', 'MSS', 'PMTUD', 'Jumbo Frame', '分段', 'adjust-mss'], tags: ['MTU', 'MSS', 'PMTUD', 'adjust-mss', 'Jumbo Frame', 'giants', 'system mtu'],
    sum: '一個介面一次能送的最大封包（乙太網路 1500 位元組）；路上任何一段比較小，大封包就要分段，或靠 PMTUD 讓來源送小一點。',
    body: [
      'MSS 是 TCP 每一段資料的大小，通常是 MTU − 40（IP 與 TCP 標頭）。PPPoE 多了 8 位元組（MTU 1492）、IPsec 多了五六十位元組，經過這些地方大封包會超過 MTU。',
      '封包設了 DF（不可分段）又太大：路由器丟掉並回報 ICMP「需要分段」，來源收到後改用小一點的大小（PMTUD）。這個 ICMP 被擋掉，就會出現「網頁開到一半卡住、ping 小封包卻正常」的黑洞。路由器上的 ip tcp adjust-mss 直接把 TCP 的 MSS 改小，最省事。',
      'Jumbo Frame（9000）讓儲存、備份這類大流量更有效率，但整條路上每一台都要開，不然大的訊框會被當成 giant 丟掉（第二層不會回報 ICMP）。',
    ],
    pit: ['只開一端的 Jumbo Frame：小封包都正常，大的傳檔、vMotion 失敗。', '擋掉所有 ICMP：PMTUD 失效。'],
    cmd: [{ v: 'Cisco IOS', c: ['interface Dialer1', ' mtu 1492', ' ip tcp adjust-mss 1452'] }, { v: 'Windows', c: ['ping 10.1.0.10 -f -l 1472'] }],
    see: ['icmp', 'pppoe', 'ipsec'],
  },
];
