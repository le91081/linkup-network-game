// 知識庫「深入了解」：網路基礎與 IP 服務（格式見 deep-routing.js）

export const DEEP_SERVICES = {
  subnet: [
    {
      h: '切子網路的固定步驟',
      list: [
        '① 需要幾個位址：主機數加 2（網段位址與廣播位址），再往上找最接近的 2 的次方。50 台主機要 64 個位址，也就是 6 個主機位元，遮罩是 /26。',
        '② 區塊大小 = 2 的「主機位元數」次方。/26 的區塊是 64，所以網段的起點是 0、64、128、192。',
        '③ 每個網段：第一個位址是網段位址、最後一個是廣播位址，中間的是可以用的主機位址。192.168.1.64/26 的範圍是 .64 到 .127，可用的是 .65 到 .126。',
        '④ 判斷一個位址屬於哪個網段：把有變化的那一段除以區塊大小取整數，再乘回去。192.168.1.100 在 /26 底下：100 ÷ 64 = 1，網段是 .64。',
      ],
      table: { head: ['遮罩', '最後一段', '區塊', '可用主機'], rows: [['/24', '255.255.255.0', '256', '254'], ['/25', '.128', '128', '126'], ['/26', '.192', '64', '62'], ['/27', '.224', '32', '30'], ['/28', '.240', '16', '14'], ['/29', '.248', '8', '6'], ['/30', '.252', '4', '2'], ['/31', '.254', '2', '2（只用在點對點）'], ['/32', '.255', '1', '單一主機（Loopback、主機路由）']] },
    },
    {
      h: 'VLSM：從最大的開始切',
      p: ['每個網段需要的大小不一樣時，統一用同一個遮罩會很浪費。VLSM 的做法是把需求由大排到小，依序從位址空間切下對齊邊界的區塊。先切大的，剩下的空間才不會被切得零零碎碎。'],
      list: ['例：192.168.10.0/24 要分給 100 台、50 台、20 台、兩條點對點。', '100 台 → /25：192.168.10.0/25（.0 – .127）', '50 台 → /26：192.168.10.128/26（.128 – .191）', '20 台 → /27：192.168.10.192/27（.192 – .223）', '點對點 → /30：192.168.10.224/30 與 192.168.10.228/30；剩下 .232 – .255 留著以後用。'],
    },
    {
      h: '彙總：反過來把小網段合起來',
      p: ['把連續的網段用一個比較短的遮罩表示，路由表就少很多筆，而且小網段的上下線不會傳出去。做法是把每個網段寫成二進位，找出從左邊數起共同的位元有幾個。10.1.0.0/24 到 10.1.3.0/24 四個網段，第三段是 00000000 到 00000011，前 22 個位元相同，彙總成 10.1.0.0/22。'],
      list: ['要能彙總，網段數量要是 2 的次方、起點要對齊邊界。10.1.1.0/24 到 10.1.4.0/24 就沒辦法用一條剛好涵蓋。', '彙總涵蓋的範圍比實際存在的大時，沒有人用的那部分位址會被吸到做彙總的那一台。所以彙總路由要配一條指向 Null0 的丟棄路由。', '位址規劃要在網路蓋之前就照階層分配（每個據點一塊、每棟樓一塊），之後才彙總得起來。'],
      note: '點對點的線路用 /31（RFC 3021）可以省一半的位址：兩個位址都能用，沒有網段位址與廣播位址。Loopback 一律用 /32。',
    },
  ],

  'tcp-udp': [
    {
      h: 'TCP 標頭裡重要的欄位',
      list: [
        '來源埠與目的埠：伺服器用固定的埠（公認埠 0 – 1023），用戶端每條連線用一個暫時埠。「來源 IP、來源埠、目的 IP、目的埠、協定」這五個值合起來才唯一決定一條連線。',
        '序號與確認號：每個位元組都有編號。確認號的意思是「這個號碼之前的我都收到了，下一個請給我這個」。',
        '旗標：SYN（開始）、ACK（確認）、FIN（正常結束）、RST（立刻中斷）、PSH、URG。',
        '視窗大小：接收端告訴對方「我現在還收得下多少」，這是流量控制。',
        '選項：MSS（一個區段最多裝多少資料，只在 SYN 裡宣告）、視窗縮放、SACK、時間戳記。',
      ],
    },
    {
      h: '連線的一生',
      list: [
        '建立（三向交握）：SYN → SYN-ACK → ACK。雙方各自選一個起始序號並確認對方的。',
        '傳輸：送出的資料要在逾時之前被確認，沒有就重送。連續收到三個重複的確認代表中間掉了一個區段，不等逾時就重送（fast retransmit）。',
        '結束（四次揮手）：一方送 FIN、對方 ACK；另一方送完自己的資料再 FIN、再 ACK。主動關閉的那一方會在 TIME_WAIT 停一下。',
        'RST：對方沒有在聽這個埠（Connection refused）、防火牆主動拒絕、或一方覺得這條連線不該存在。',
      ],
      p: ['「連線被拒絕」與「逾時」是兩種完全不同的訊號。被拒絕代表封包到了對方、對方（或中間的設備）明確回了 RST：路是通的，是那個埠沒開。逾時代表完全沒有回應：路不通，或被防火牆默默丟掉。排錯時光看這一點就能少走一半的路。'],
    },
    {
      h: '壅塞控制：為什麼掉一點封包速度就掉很多',
      p: ['TCP 不知道網路能承受多少，所以從小的壅塞視窗開始，每收到確認就加倍（慢啟動），到了門檻之後改成每一輪加一（壅塞避免）。一旦偵測到遺失，就把視窗砍半或從頭來過。所以 TCP 的傳輸速率長得像鋸齒，而且遺失率只要到 1%，長距離連線的吞吐量就會大幅下降。'],
      list: ['線路的延遲越大，視窗長得越慢，同樣的遺失率影響越大。', '路由器的佇列滿了一次丟掉一大批封包，會讓很多條連線同時砍半、同時再長回來（全域同步）。WRED 在佇列快滿之前先隨機丟一些，就是為了打散它。', '用 UDP 的應用（語音、視訊、QUIC）自己決定要不要讓路，所以 QoS 要把它們和 TCP 分開處理。'],
    },
    {
      h: 'MSS 與 MTU',
      p: ['MTU 是一個介面能送的最大 IP 封包（乙太網路 1500）。MSS 是 TCP 一個區段裡資料的最大長度，等於 MTU 減掉 IP 標頭 20 與 TCP 標頭 20，所以通常是 1460。雙方在 SYN 裡各自宣告自己的 MSS，取小的用。路上有通道（少了幾十個位元組）的時候，兩端的主機並不知道，路由器可以用 ip tcp adjust-mss 把經過的 SYN 裡的 MSS 改小，讓雙方一開始就送小一點的區段。'],
      note: 'UDP 沒有連線、沒有重送、沒有順序，標頭只有 8 個位元組。適合即時（晚到不如不到）、一問一答（DNS、DHCP、SNMP）與自己處理可靠性的協定（QUIC、TFTP）。',
    },
  ],

  arp: [
    {
      h: '幾種特別的 ARP',
      table: {
        head: ['名稱', '是什麼', '用途或風險'],
        rows: [
          ['Gratuitous ARP', '主動宣告「這個 IP 在我這個 MAC」，沒有人問', '偵測位址衝突；HSRP 換手、搬移虛擬機時讓大家更新快取與 MAC 位址表。也是 ARP 欺騙的手段'],
          ['Proxy ARP', '路由器替「不在這個網段」的位址回答 ARP', '主機的遮罩設錯或沒有閘道時還能通，但把問題藏起來；對外的介面應該關掉'],
          ['ARP Probe', '來源 IP 是 0.0.0.0 的詢問', '主機拿到位址之後先確認沒有人在用'],
          ['Reverse / Inverse ARP', '用 MAC 或電路編號反查 IP', '舊技術（RARP 被 DHCP 取代）'],
        ],
      },
    },
    {
      h: '快取與常見的症狀',
      list: [
        'ARP 快取有時效：主機大約幾十秒到幾分鐘，Cisco 路由器預設 4 小時。換了設備（同一個 IP、不同的 MAC）之後，別人的快取還記著舊的，要等過期、清掉，或由新設備送 gratuitous ARP。',
        'ARP 的時效比交換器 MAC 位址表的時效（5 分鐘）長很多。路由器還記得 MAC，交換器卻已經忘了它在哪個埠，往那台主機的訊框就被洪泛到整個 VLAN（unknown unicast flooding）。非對稱路由的網路特別容易遇到。',
        'incomplete：送了 ARP 請求卻沒有人回。目的主機不存在、不在同一個 VLAN、或被第二層的東西擋住。這時 ping 的錯誤是「目的地主機無法連線」，而且來源是自己。',
        'ARP 只在同一個廣播網域裡有效。目的地在別的網段時，主機 ARP 的對象是預設閘道。',
      ],
      note: '看到同一個 IP 的 MAC 一直在兩個值之間換，不是位址衝突就是有人在做 ARP 欺騙。交換器上用 show mac address-table address 找出那兩個 MAC 各自接在哪個埠。',
    },
  ],

  mtu: [
    {
      h: '幾個容易混淆的數字',
      table: { head: ['名稱', '量的是什麼', '標準乙太網路'], rows: [['MTU（IP MTU）', '第三層封包的最大長度（IP 標頭＋內容）', '1500'], ['乙太網路訊框', 'MTU ＋ 乙太網路標頭 14 ＋ FCS 4', '1518（加 802.1Q 是 1522）'], ['TCP MSS', 'TCP 區段裡資料的最大長度', '1460'], ['ping 的資料大小', 'ICMP 的資料，還要加 ICMP 標頭 8 與 IP 標頭 20', '最大 1472'], ['Jumbo Frame', '比 1500 大的 MTU，常見 9000', '整條路每一台都要支援']] },
    },
    {
      h: '封包太大的時候',
      list: [
        '沒有設 DF：路由器把它分段，接收端重組。分段很耗資源、有的防火牆會丟掉分段的封包，而且任何一段掉了整個封包都要重送。',
        '設了 DF（現在的 TCP 幾乎都會設）：路由器丟掉封包，回一個 ICMP「需要分段但設定了 DF」(type 3 code 4)，裡面寫著下一段的 MTU。來源收到之後把封包改小，這就是 PMTUD。',
        'PMTUD 黑洞：中間有防火牆把 ICMP 全擋了，來源永遠收不到通知，一直重送同樣大小的封包。症狀是三向交握成功（封包很小）、開始傳資料就卡住。',
        '第二層的設備不會分段、也不會回 ICMP：交換器的 MTU 比較小時，太大的訊框直接被當成 giant 丟掉，沒有任何通知。',
      ],
    },
    {
      h: '怎麼量、怎麼修',
      list: [
        '量：設 DF 的 ping，從大往小試。Linux：ping -M do -s 1472 <目的地>；Cisco：ping <目的地> size 1500 df-bit。1472 會通、1473 不通，路徑 MTU 就是 1500。',
        '通道：在 Tunnel 介面設 ip mtu 與 ip tcp adjust-mss（比 ip mtu 小 40），從源頭避免。',
        'Jumbo：伺服器網卡、每一台交換器、每一個路由介面都要一致。只改一半，會通的只有小封包。',
        '不要擋掉所有的 ICMP：至少放行 type 3 code 4（以及 IPv6 的 Packet Too Big，IPv6 的路由器根本不分段，完全依賴它）。',
      ],
    },
  ],

  dhcp: [
    {
      h: '四個訊息與幾個選項',
      p: ['DISCOVER（用戶端廣播找伺服器）→ OFFER（伺服器提議一個位址）→ REQUEST（用戶端廣播「我要這一個」，讓其他提議的伺服器知道自己沒被選上）→ ACK（伺服器確認，租約開始）。用戶端 UDP 68、伺服器 UDP 67。'],
      table: { head: ['選項', '內容'], rows: [['1', '子網路遮罩'], ['3', '預設閘道'], ['6', 'DNS 伺服器'], ['15', '網域名稱'], ['43', '廠商專屬資訊（輕量型 AP 找控制器）'], ['51 / 58 / 59', '租約時間、T1（續約）、T2（重新綁定）'], ['66 / 150', 'TFTP 伺服器（IP 電話）'], ['82', 'Relay 資訊（從哪台交換器的哪個埠來的）']] },
    },
    {
      h: '租約的時間軸',
      list: [
        '租約過了一半（T1）：用戶端直接向原本的伺服器單點傳送 REQUEST 要求續約。',
        '過了 87.5%（T2）還沒續成：改用廣播，任何一台伺服器都可以回應。',
        '到期還是沒有：放掉位址，從 DISCOVER 重來。',
        '所以伺服器壞掉的時候，已經拿到位址的電腦還能撐到租約到期，新開機的電腦則馬上要不到。租約設得太長，改了設定很久才會生效；太短則廣播變多。一般辦公室一天、訪客網路幾小時。',
      ],
    },
    {
      h: 'Relay 與伺服器怎麼知道要發哪個網段',
      p: ['DHCP 的廣播過不了路由器。在用戶端那個網段的閘道介面設 ip helper-address <伺服器>，路由器收到廣播就改成單點傳送轉給伺服器，並在 giaddr 欄位填上自己那個介面的位址。伺服器就是看 giaddr 屬於哪個網段，決定從哪個位址池發位址；回應也是送回 giaddr。'],
      list: ['伺服器要有回到 giaddr 的路由，不然 OFFER 回不來。', 'helper-address 除了 DHCP 還會轉送 TFTP、DNS、NetBIOS 等幾種 UDP 廣播；不想要的可以用 no ip forward-protocol udp 關掉。', '有兩台伺服器時位址池不能重疊：各發一半，或用支援容錯的 DHCP 伺服器。'],
    },
    {
      h: '排錯',
      list: [
        '用戶端拿到 169.254.x.x（或完全沒有位址）：DISCOVER 沒有得到任何 OFFER。',
        '依序檢查：埠在不在對的 VLAN → 閘道介面有沒有 helper-address → 伺服器有沒有那個網段的位址池、池子滿了沒 → 伺服器回得來嗎 → 中間有沒有 DHCP snooping 把它丟掉。',
        '拿到的位址不是預期的網段：VLAN 接錯了，或網段裡有另一台 DHCP 伺服器（有人接了家用路由器）。',
        'show ip dhcp binding、show ip dhcp pool、show ip dhcp conflict、debug ip dhcp server packet。',
      ],
      code: { v: 'Cisco IOS', c: ['ip dhcp excluded-address 192.168.10.1 192.168.10.20', 'ip dhcp pool OFFICE', ' network 192.168.10.0 255.255.255.0', ' default-router 192.168.10.1', ' dns-server 8.8.8.8 1.1.1.1', ' lease 1', '!', 'interface Vlan20', ' ip helper-address 10.0.99.10'] },
    },
  ],

  dns: [
    {
      h: '一次查詢是怎麼接力的',
      p: ['電腦只會問自己設定的那台 DNS 伺服器，而且要求它「把最後的答案給我」（遞迴查詢）。那台伺服器（解析器）如果快取裡沒有，就替你一層一層去問（反覆查詢）：先問根伺服器「.com 找誰」、再問 .com 的伺服器「example.com 找誰」、最後問 example.com 的權威伺服器「www 的位址是什麼」。每一層的回答都會照 TTL 被快取起來，所以大部分的查詢不必從根開始。'],
    },
    {
      h: '常見的記錄類型',
      table: { head: ['類型', '內容', '備註'], rows: [['A / AAAA', '名稱 → IPv4 / IPv6 位址', ''], ['CNAME', '這個名稱是另一個名稱的別名', '有 CNAME 的名稱不能再有其他記錄；網域的頂端不能用'], ['MX', '這個網域的信要送到哪台郵件伺服器', '數字小的優先'], ['NS', '這個網域由哪些伺服器負責', ''], ['PTR', 'IP → 名稱（反查）', '在 in-addr.arpa 底下，由擁有那段 IP 的人管理'], ['TXT', '任意文字', 'SPF、DKIM、網域擁有權的驗證'], ['SRV', '某個服務在哪台主機的哪個埠', 'Active Directory、SIP'], ['SOA', '這個區域的基本資料', '序號、更新間隔、負面快取的 TTL']] },
    },
    {
      h: 'TTL 與快取',
      list: [
        '快取有好幾層：應用程式、作業系統、公司的解析器、ISP 的解析器。改了記錄之後，每一層都要等自己手上那一份到期。',
        '要搬移服務之前，先把 TTL 調低（例如 300 秒），等舊的 TTL 過了再改位址，切換就只影響幾分鐘。',
        '「找不到」也會被快取（負面快取），時間由 SOA 決定。記錄還沒建好就有人查過，建好之後他還是會查不到一陣子。',
        'nslookup 與 dig 是直接問伺服器的工具，不經過本機的快取。所以「dig 是新的、瀏覽器還是舊的」幾乎都是快取還沒到期。',
      ],
    },
    {
      h: '公司內部的幾種設計',
      list: [
        '轉送器 (forwarder)：內部的 DNS 伺服器只負責自己的網域，其他的名稱轉給上游的解析器。',
        'Split DNS：同一個名稱，內部的 DNS 回內部位址、外部的 DNS 回公用位址。解決「在公司裡連自己的公用位址不通」（NAT hairpin）的問題。',
        '條件式轉送：某個網域的查詢轉給特定的伺服器，常用在併購或和合作夥伴互連。',
        'DNS 用 UDP 53；回應超過 512 個位元組（沒有 EDNS 時）或做區域傳送時用 TCP 53。防火牆只開 UDP，會讓某些查詢莫名其妙失敗。',
      ],
      note: '很多「網路斷了」其實是 DNS 壞了：用 IP 位址 ping 得通、用名稱不行。排錯的第一步永遠是把這兩件事分開。',
    },
  ],

  nat: [
    {
      h: '四個位址的名稱',
      table: { head: ['名稱', '意思', '例子'], rows: [['Inside local', '內部主機「真正的」位址', '192.168.1.10'], ['Inside global', '內部主機在外面看起來的位址', '203.0.113.5'], ['Outside global', '外部主機真正的位址', '8.8.8.8'], ['Outside local', '外部主機在內部看起來的位址（通常一樣）', '8.8.8.8']] },
      p: ['local 與 global 講的是「從哪一邊看」，inside 與 outside 講的是「這台主機在哪一邊」。show ip nat translations 的四欄就是這四個。'],
    },
    {
      h: '三種做法',
      list: [
        '靜態 NAT：一個內部位址固定對應一個公用位址，兩個方向都可以發起連線。給對外的伺服器用。',
        '動態 NAT：從一個公用位址池裡借一個，用完還回去。池子裡的位址被借光，後面的人就出不去。',
        'PAT（overload）：很多內部主機共用一個公用位址，靠來源埠區分。一個位址理論上有六萬多個埠可以用。家用路由器與大多數公司的上網都是這個。',
        '連接埠轉發其實是「只對某個埠做的靜態 NAT」：ip nat inside source static tcp 192.168.1.10 443 interface Gi0/0/0 443。',
      ],
    },
    {
      h: '處理的順序',
      p: ['從 inside 到 outside：先查路由表決定出口，再做轉換。從 outside 到 inside：先把目的位址轉回來，再查路由表。所以路由器要有「往公用位址池」的路讓回應進得來（池子不在介面的網段上時，上游要有路由指過來），而 inside 介面上的 ACL 看到的是轉換前的位址、outside 介面的 inbound ACL 看到的是轉換前（公用）的目的位址。'],
      list: ['和 IPsec 一起用：要走 VPN 的流量要先從 NAT 排除（NAT 的 ACL 裡 deny），不然來源被改掉就不符合加密的範圍了。', '同一台路由器上，內部主機連自己的公用位址（hairpin）：傳統的 inside / outside 做不到，要用 NVI（ip nat enable）或 split DNS。', '有些協定把位址寫在內容裡（FTP 主動模式、SIP），NAT 要有對應的 ALG 去改內容，否則控制連線通、資料連線不通。'],
    },
    {
      h: '排錯',
      list: [
        'show ip nat translations：有沒有產生對應。沒有 → 介面的 inside / outside 標錯、流量不符合 ACL、流量沒有經過這台。',
        'show ip nat statistics：哪些介面是 inside / outside、命中次數、位址池用了多少、有沒有 misses。',
        '對應有了但回不來：上游沒有往公用位址的路、回程走了另一台沒有這筆對應的路由器（非對稱）。',
        'debug ip nat 可以逐筆看，流量大的時候要搭配 ACL 只看特定主機。',
      ],
      code: { v: 'Cisco IOS', c: ['access-list 1 permit 192.168.0.0 0.0.255.255', 'ip nat inside source list 1 interface GigabitEthernet0/0/0 overload', 'ip nat inside source static tcp 192.168.1.10 443 203.0.113.5 443', '!', 'interface GigabitEthernet0/0/0', ' ip nat outside', 'interface GigabitEthernet0/0/1', ' ip nat inside'] },
    },
  ],

  ntp: [
    {
      h: '階層與角色',
      p: ['NTP 用 stratum 表示離標準時間有多遠：原子鐘、GPS 是 stratum 0，直接接著它們的伺服器是 1，向 stratum 1 對時的是 2，依此類推，16 代表沒有同步。設備會挑 stratum 低、延遲與抖動小的來源。'],
      table: { head: ['模式', '關係'], rows: [['client / server', '我向你對時，你不理會我的時間（ntp server）'], ['symmetric (peer)', '互相對時，其中一台失去上游時另一台可以頂上（ntp peer）'], ['broadcast / multicast', '伺服器定期廣播，用戶端被動地聽'], ['ntp master', '沒有外部來源時把自己的時鐘當成來源（只該用在隔離的實驗環境）']] },
    },
    {
      h: '設定時要注意的',
      list: [
        '設備的時鐘一律用 UTC，或至少全公司一致；顯示的時區另外設（clock timezone）。紀錄要能跨設備比對，靠的就是這個。',
        '至少設兩到三個來源：只有一個的話無從判斷它對不對；兩個不一樣時不知道該信誰；三個以上才能用多數決剔除壞掉的那個。',
        '指定來源介面（ntp source Loopback0）：伺服器端的 ACL 才有固定的位址可以放行。',
        '驗證（ntp authenticate、ntp authentication-key、ntp trusted-key）：防止有人假冒時間伺服器把你的時鐘調走，讓憑證失效或紀錄對不起來。',
        '時間差太多（預設超過約 1000 秒）NTP 會拒絕同步，要先手動 clock set 到接近的時間。',
        '同步需要時間：剛設好幾分鐘內 show ntp status 還是 unsynchronized 是正常的。',
      ],
      code: { v: 'Cisco IOS', c: ['clock timezone CST 8', 'ntp authentication-key 1 md5 S3cret!', 'ntp trusted-key 1', 'ntp authenticate', 'ntp server 10.0.99.5 key 1 prefer', 'ntp server 10.0.99.6 key 1', 'ntp source Loopback0', 'service timestamps log datetime msec localtime show-timezone', '!', 'show ntp status', 'show ntp associations'] },
      note: '時間不對會壞的東西比想像中多：憑證驗證（VPN、HTTPS、802.1X）、Kerberos 登入（差 5 分鐘就失敗）、時間型 ACL、紀錄的先後順序、路由協定金鑰的輪替。',
    },
  ],

  syslog: [
    {
      h: '嚴重等級',
      table: { head: ['等級', '名稱', '例子'], rows: [['0', 'Emergencies', '系統無法使用'], ['1', 'Alerts', '要立刻處理'], ['2', 'Critical', '硬體故障'], ['3', 'Errors', '介面錯誤、err-disabled'], ['4', 'Warnings', '設定有問題的警告'], ['5', 'Notifications', '介面 up / down、鄰居上下線'], ['6', 'Informational', 'ACL 命中的紀錄'], ['7', 'Debugging', 'debug 的輸出']] },
      p: ['設定「logging trap 4」的意思是「等級 4 以及比它更嚴重的（0 – 4）都送出去」。數字越小越嚴重。訊息的格式是 %設施-等級-代號: 內容，例如 %LINK-3-UPDOWN。'],
    },
    {
      h: '紀錄可以送到哪裡',
      list: [
        'console：預設全部印在 console 上。流量大或開了 debug 的時候，console 的輸出會拖慢甚至卡死設備，正式環境通常調成只印嚴重的（logging console critical）。',
        'monitor：SSH / Telnet 的畫面，要自己打 terminal monitor 才看得到。',
        'buffer：存在設備的記憶體裡（logging buffered 64000），重開機就沒了，但 show logging 隨時可以看。',
        'trap：送到遠端的 syslog 伺服器（UDP 514，或用 TCP / TLS）。這才是出事之後還找得到紀錄的地方。',
      ],
      code: { v: 'Cisco IOS', c: ['service timestamps log datetime msec localtime show-timezone', 'service sequence-numbers', 'logging buffered 64000 informational', 'logging console critical', 'logging host 10.0.99.30', 'logging trap warnings', 'logging source-interface Loopback0', '!', 'show logging'] },
      note: '沒有時間戳記、或每台設備時間不一樣的紀錄，在事故調查時幾乎沒有用。Syslog 要和 NTP 一起設。',
    },
  ],

  snmp: [
    {
      h: '三個版本',
      table: { head: ['版本', '驗證', '加密', '評語'], rows: [['v1', 'community 字串（明文）', '沒有', '不要再用'], ['v2c', 'community 字串（明文）', '沒有', '多了 GetBulk 與 64 位元計數器；仍然很普遍，但等於沒有安全性'], ['v3 noAuthNoPriv', '只有使用者名稱', '沒有', ''], ['v3 authNoPriv', 'SHA / MD5', '沒有', ''], ['v3 authPriv', 'SHA', 'AES', '正式環境該用的']] },
    },
    {
      h: '運作的方式',
      list: [
        '管理站用 UDP 161 向設備查詢：Get（讀一個）、GetNext / GetBulk（讀一串）、Set（寫入）。',
        '設備主動通知用 UDP 162：Trap（送出去就不管了）、Inform（要對方確認，沒收到會重送）。',
        '每一項資料有一個 OID，像一棵樹上的路徑；MIB 是說明每個 OID 代表什麼的字典。介面的流量在 ifTable / ifXTable，高速介面要讀 64 位元的 ifHCInOctets，32 位元的計數器在 10G 的線路上幾分鐘就繞一圈。',
        '輪詢是定期去問，間隔內發生的事看不到；Trap 是事件發生時馬上通知，但可能掉。兩個要一起用。',
      ],
      code: { v: 'Cisco IOS：SNMPv3', c: ['ip access-list standard NMS', ' permit 10.0.99.0 0.0.0.255', 'snmp-server view RO-VIEW iso included', 'snmp-server group MON v3 priv read RO-VIEW access NMS', 'snmp-server user monitor MON v3 auth sha Auth-Pass! priv aes 128 Priv-Pass!', 'snmp-server host 10.0.99.40 version 3 priv monitor', 'snmp-server enable traps', '!', 'show snmp user', 'show snmp group'] },
      note: 'community 是 public / private 的 v2c 是最常見的稽核缺失。有寫入權限 (RW) 的 community 等於把設備的設定權交給任何知道那個字串的人。',
    },
  ],

  netflow: [
    {
      h: '什麼是一筆 flow',
      p: ['傳統的定義是七個欄位都一樣的封包算同一筆：來源 IP、目的 IP、來源埠、目的埠、第三層協定、ToS、進入的介面。路由器在記憶體裡替每一筆 flow 累計封包數與位元組數，flow 結束或逾時之後把這筆紀錄匯出給收集器。它回答的是 SNMP 回答不了的問題：這條線路滿了，「是誰、在連哪裡、用什麼應用」。'],
    },
    {
      h: '版本與 Flexible NetFlow',
      list: [
        'v5：欄位固定，只支援 IPv4。',
        'v9：用範本描述欄位，可以擴充（IPv6、MPLS、BGP 下一站）。IPFIX 是它的標準化版本。',
        'Flexible NetFlow 把設定拆成三塊：record（要拿哪些欄位當 key、收集哪些數值）、exporter（送到哪個收集器、用哪個埠）、monitor（把前兩者組起來，套到介面的 input 或 output）。',
        '快取的兩個計時器：inactive timeout（多久沒有新的封包就當作結束，預設 15 秒）與 active timeout（還在持續的 flow 也每隔這麼久匯出一次，預設 30 分鐘；想要圖表即時一點要調成 60 秒）。',
        '高速介面可以取樣（每 n 個封包看一個）以降低負擔，統計值由收集器乘回來。',
      ],
      code: { v: 'Cisco IOS XE：Flexible NetFlow', c: ['flow record REC', ' match ipv4 source address', ' match ipv4 destination address', ' match transport source-port', ' match transport destination-port', ' match ipv4 protocol', ' collect counter bytes long', ' collect counter packets long', 'flow exporter EXP', ' destination 10.0.99.50', ' transport udp 2055', ' source Loopback0', 'flow monitor MON', ' record REC', ' exporter EXP', ' cache timeout active 60', '!', 'interface GigabitEthernet0/0/0', ' ip flow monitor MON input', '!', 'show flow monitor MON cache'] },
    },
  ],

  qos: [
    {
      h: 'QoS 在解決什麼',
      p: ['線路沒有塞車的時候，QoS 什麼都不做。它處理的是「出口的佇列滿了，誰先走、誰被丟」。一般的資料可以等、可以重送；語音與視訊不行：延遲超過 150 毫秒、抖動超過 30 毫秒、遺失超過 1%，通話品質就明顯變差。QoS 沒辦法變出頻寬，只能決定不夠的時候怎麼分。'],
      list: ['三種模型：Best Effort（不做）、IntServ（每條流量用 RSVP 預約，規模有限）、DiffServ（在封包上做記號，每一台設備照記號處理 —— 現在的主流）。'],
    },
    {
      h: '分類與標記',
      table: { head: ['標記', '在哪裡', '常見的值'], rows: [['CoS', '802.1Q 標籤的 3 個位元（只存在於 Trunk 上）', '語音 5'], ['DSCP', 'IP 標頭的 6 個位元', 'EF (46)：語音；AF41 (34)：視訊；CS3 (24)：訊令；AF21 (18)：重要資料；0：其他'], ['MPLS TC', 'MPLS 標籤的 3 個位元', '']] },
      list: ['在越靠近來源的地方分類與標記越好，後面的設備只要看記號。', '信任邊界：使用者的電腦可以把自己的封包全部標成 EF，所以接取層交換器預設不信任電腦送來的記號，只信任 IP 電話（或在這裡重新標記）。', 'AF 類別的名字有兩個數字：AF41 的 4 是類別、1 是丟棄的優先程度（1 最不容易被丟）。'],
    },
    {
      h: '佇列與丟棄',
      list: [
        'CBWFQ：替每一類流量保證一個最低頻寬（bandwidth），線路忙的時候至少拿得到這麼多，沒人用的時候可以借給別人。',
        'LLQ：在 CBWFQ 之上多一個嚴格優先的佇列（priority），裡面的封包永遠先送，給語音用。它同時是上限：超過設定值的部分在塞車時會被丟掉，免得把其他人餓死。',
        'WRED：佇列快滿之前就開始隨機丟封包，而且先丟記號比較不重要的，讓 TCP 提早減速、避免所有連線一起撞牆。不要用在語音上。',
        '尾端丟棄 (tail drop)：佇列滿了，後來的全部丟掉。這是沒有設定時的行為。',
      ],
    },
    {
      h: '管制與整形',
      table: { head: ['', 'Policing（管制）', 'Shaping（整形）'], rows: [['超過的流量', '直接丟掉或改標記', '先放在佇列裡，晚一點再送'], ['結果', '流量有尖峰就被削掉，TCP 會一直重送', '流量變平滑，多了一點延遲'], ['方向', '進與出都可以', '只能在出的方向'], ['常見的位置', '業者那一端（合約頻寬）、限制某類流量', '客戶這一端：實體介面是 1G，合約只有 100M']] },
      p: ['實體介面比合約頻寬快的時候，路由器以為線路還沒滿、不會啟動佇列，封包以 1G 的速度送出去，再被業者以 100M 管制丟掉 —— 而且是不分語音、資料亂丟。解法是階層式的政策：外層先整形到合約頻寬，內層再用 LLQ 分配這 100M。'],
      code: { v: 'Cisco IOS：整形 ＋ LLQ', c: ['class-map match-any VOICE', ' match dscp ef', 'class-map match-any SIGNAL', ' match dscp cs3', 'policy-map WAN-QUEUE', ' class VOICE', '  priority percent 20', ' class SIGNAL', '  bandwidth percent 5', ' class class-default', '  fair-queue', '  random-detect dscp-based', 'policy-map WAN-SHAPE', ' class class-default', '  shape average 100000000', '  service-policy WAN-QUEUE', '!', 'interface GigabitEthernet0/0/0', ' service-policy output WAN-SHAPE', '!', 'show policy-map interface GigabitEthernet0/0/0'] },
      note: 'QoS 是端到端的事：路上只要有一台沒有照記號處理，品質就由那一台決定。排錯時一站一站看 show policy-map interface 的 drops 與每個類別的命中數，找出記號在哪裡不見、封包在哪裡被丟。',
    },
  ],
};
