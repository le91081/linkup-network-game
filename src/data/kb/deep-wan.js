// 知識庫「深入了解」：VPN 與廣域網路（格式見 deep-routing.js）

export const DEEP_WAN = {
  ipsec: [
    {
      h: '兩個階段在協商什麼',
      p: ['IPsec 的通道分兩層。第一層（IKE SA）是兩台設備之間的一條加密管道，用來互相確認身分、保護後續的協商。第二層（IPsec SA，也叫 Child SA）才是真正加密使用者資料的金鑰，每個方向一把，而且會定期更換。'],
      table: {
        head: ['', 'IKEv1', 'IKEv2'],
        rows: [
          ['第一階段', 'Main Mode 6 個訊息（Aggressive Mode 3 個，比較不安全）', 'IKE_SA_INIT ＋ IKE_AUTH，一共 4 個訊息，順便建立第一組 Child SA'],
          ['第二階段', 'Quick Mode 3 個訊息', 'CREATE_CHILD_SA 2 個訊息'],
          ['協商的內容', '加密、雜湊、DH 群組、驗證方式、存活時間', '同左，但雙方的驗證方式可以不一樣'],
          ['NAT 穿越、DPD', '後來加上的擴充', '內建'],
          ['遠端存取', '要靠 XAUTH、Mode Config', '內建 EAP'],
        ],
      },
      list: ['第一階段兩端要一樣的：加密演算法、雜湊、DH 群組、驗證方式（預先共用金鑰或憑證）。存活時間不一樣會取小的。', '第二階段兩端要一樣的：transform-set（ESP 的加密與驗證）、模式（tunnel / transport）、要保護的流量範圍（兩端要互為鏡像）、PFS 的 DH 群組。'],
    },
    {
      h: 'ESP、AH 與兩種模式',
      list: [
        'ESP（IP 協定 50）：加密加上完整性驗證，實務上幾乎都用它。AH（協定 51）只驗證不加密，而且它連外層的 IP 標頭一起驗證，遇到 NAT 一定壞。',
        'Tunnel 模式：把原本的整個 IP 封包包起來，外面加一個新的 IP 標頭。站對站的 VPN 用它。',
        'Transport 模式：只保護原本封包的內容，沿用原本的 IP 標頭。用在兩端本身就是通道端點的情況，最常見的是 GRE over IPsec（GRE 已經加過一層 IP 標頭，再用 tunnel 模式就白白多 20 個位元組）。',
        '反重播 (anti-replay)：ESP 有序號，接收端用一個滑動視窗丟掉重複或太舊的封包。QoS 把封包重新排序得太厲害時，會被誤判成重播而丟掉。',
      ],
    },
    {
      h: 'crypto map 還是 VTI',
      table: {
        head: ['', '政策型（crypto map）', '路由型（VTI / tunnel protection）'],
        rows: [
          ['哪些流量要加密', '用 ACL 列出來（兩端要互為鏡像）', '路由表說了算：送進 Tunnel 介面的就加密'],
          ['新增網段', '兩端的 ACL 都要改', '加一條路由，或讓路由協定自己學'],
          ['動態路由、群播', '不行（只有單點傳送的 IP）', '可以（GRE over IPsec），純 IPsec 的 VTI 也可以跑單點傳送的協定'],
          ['QoS、ACL、NAT', '套在實體介面上，不好區分', '套在 Tunnel 介面上，和一般介面一樣'],
        ],
      },
      note: '用 crypto map 時最常見的錯誤有兩個：兩端的加密 ACL 不是鏡像（一端寫 /24、另一端寫 /16，第二階段起不來）；NAT 的 ACL 沒有先排除要走 VPN 的流量，結果封包先被 NAT 改掉來源、就不符合加密的 ACL 了。',
    },
    {
      h: '額外的負擔與 MTU',
      p: ['ESP tunnel 模式加上新的 IP 標頭 20、ESP 標頭 8、IV 8 到 16、填充 0 到 15、ESP 尾端 2、完整性檢查 12 到 16：依演算法大約多 50 到 73 個位元組。再加上 GRE 的 24 個位元組、NAT-T 的 UDP 8 個位元組，原本 1500 的封包就塞不進去了。'],
      list: [
        '通道介面上設 ip mtu 1400、ip tcp adjust-mss 1360：TCP 在交握時就協商出小一點的區段，從源頭避免分段。這是最有效的做法。',
        '不這樣做就要靠 PMTUD：路由器回 ICMP「需要分段」請來源改小。但路上只要有人擋掉 ICMP，來源永遠不知道，症狀就是「小檔案可以、大檔案卡住」「ping 通、網頁打不開」。',
      ],
    },
    {
      h: '排錯：由下往上',
      list: [
        '① 底層：兩端的公用位址互相 ping 得到嗎？UDP 500、UDP 4500、ESP 有沒有被擋？',
        '② 第一階段：show crypto isakmp sa（IKEv2 是 show crypto ikev2 sa）。QM_IDLE / READY 是好的；MM_NO_STATE 是提案對不上或根本連不到；MM_KEY_EXCH 是金鑰不一樣。',
        '③ 第二階段：show crypto ipsec sa。看 encaps 與 decaps 的計數器：encaps 在增加、decaps 是 0，代表封包送出去了卻沒有回來（對方的回程路由、對方的 ACL、中間的 NAT）。兩個都是 0，代表流量根本沒有進到通道（路由、加密的 ACL、NAT 排除）。',
        '④ 通道起來了但應用不通：MTU、對方內部的回程路由、防火牆政策。',
      ],
      code: { v: 'Cisco IOS：IKEv2 加 VTI', c: ['crypto ikev2 proposal PROP', ' encryption aes-cbc-256', ' integrity sha256', ' group 14', 'crypto ikev2 policy POL', ' proposal PROP', 'crypto ikev2 keyring KR', ' peer BRANCH', '  address 198.51.100.2', '  pre-shared-key S3cret!', 'crypto ikev2 profile PROF', ' match identity remote address 198.51.100.2 255.255.255.255', ' authentication local pre-share', ' authentication remote pre-share', ' keyring local KR', 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', ' mode tunnel', 'crypto ipsec profile VTI', ' set transform-set TS', ' set ikev2-profile PROF', '!', 'interface Tunnel0', ' ip address 10.255.0.1 255.255.255.252', ' tunnel source GigabitEthernet0/0/0', ' tunnel destination 198.51.100.2', ' tunnel mode ipsec ipv4', ' tunnel protection ipsec profile VTI'] },
    },
  ],

  'nat-t': [
    {
      h: '為什麼 IPsec 過不了 NAT',
      p: ['ESP 是一個獨立的 IP 協定（50），沒有 TCP 或 UDP 的埠號。PAT 要靠埠號區分內部的不同主機，遇到 ESP 就沒有東西可以改。另外，IKE 預設用 UDP 500 對 UDP 500，有些 NAT 設備會改掉來源埠，也可能弄壞。'],
      list: [
        'NAT-T 的做法：IKE 協商時，兩端各自把看到的位址與埠算成雜湊交換（NAT-D），比對之後就知道路上有沒有 NAT、在哪一端。',
        '發現有 NAT，就把後續的 IKE 與 ESP 都包進 UDP 4500 裡。這樣 NAT 設備看到的只是普通的 UDP，可以正常轉換。',
        'NAT 的對應表有逾時，所以在 NAT 後面的那一端會定期送 keepalive 讓對應表不要過期。',
        '防火牆要放行的：UDP 500（IKE）、UDP 4500（NAT-T），以及沒有 NAT 時的 ESP（IP 協定 50）。',
      ],
      note: '兩端都在 NAT 後面的話，至少要有一端在 NAT 設備上做靜態的埠對應（UDP 500 與 4500），不然沒有人能主動連到對方。',
    },
  ],

  gre: [
    {
      h: 'GRE 提供什麼、不提供什麼',
      p: ['GRE（IP 協定 47）把任何第三層的封包包進另一個 IP 封包裡，中間的網路只看得到外層的位址。它本身不加密、不驗證、也不保證送達。它的價值在於「通道是一個真正的介面」：可以給 IP 位址、跑 OSPF 或 EIGRP、傳群播、傳 IPv6，這些都是純 IPsec 做不到或很麻煩的。所以常見的組合是 GRE 負責載運、IPsec 負責加密。'],
      table: { head: ['tunnel mode', '用途'], rows: [['gre ip（預設）', '點對點的 GRE'], ['gre multipoint', '一個介面對很多個對端（DMVPN）'], ['ipip', '只載 IPv4，標頭少 4 個位元組'], ['ipsec ipv4', '純 IPsec 的 VTI，沒有 GRE 標頭'], ['ipv6ip / gre ipv6', 'IPv6 過 IPv4，或 GRE 跑在 IPv6 上']] },
    },
    {
      h: '通道介面什麼時候是 up',
      p: ['GRE 通道沒有「連線」的概念。只要 tunnel source 的介面是 up、路由表裡有往 tunnel destination 的路，通道的線路協定就是 up —— 即使對方根本不存在。所以通道 up 不代表通了。要真的知道對方活著，用 keepalive（點對點 GRE 才有）、路由協定的鄰居關係，或 IP SLA。'],
    },
    {
      h: 'recursive routing：通道把自己吃掉',
      p: ['通道的目的地（對方的公用位址）必須經由「實體的網路」到得了。如果路由協定透過通道學到了一條涵蓋對方公用位址的路（例如 network 0.0.0.0 把所有介面都放進 OSPF、或對方把預設路由送過來），路由器就會嘗試「經過通道去找通道的終點」。IOS 會偵測到並把通道關掉，印出 recursive routing 的訊息；路由一消失通道又起來，然後再來一次，通道就一直上下跳。'],
      list: ['不要把公用位址所在的介面放進通道上的路由協定。', '替對方的公用位址寫一條明確的主機路由，指向實體的下一站。', '用 front-door VRF：把實體的 WAN 介面放進另一個 VRF（tunnel vrf），通道的底層與內層的路由表完全分開，從根本上不可能繞回來。'],
    },
    {
      h: '負擔與 MTU',
      table: { head: ['封裝', '多出來的位元組', '建議的 ip mtu', '建議的 tcp adjust-mss'], rows: [['GRE', '24', '1476', '1436'], ['GRE ＋ IPsec（transport）', '約 60 – 70', '1400', '1360'], ['GRE ＋ IPsec ＋ NAT-T', '約 70 – 80', '1400', '1360'], ['PPPoE', '8', '1492', '1452']] },
      note: '在通道介面上同時設 ip mtu 與 ip tcp adjust-mss 是標準動作。前者讓路由器知道什麼時候要分段或回報「需要分段」，後者讓 TCP 根本不要送出那麼大的區段。',
    },
  ],

  dmvpn: [
    {
      h: '三個元件',
      list: [
        'mGRE：hub 與 spoke 都只有一個多點的 Tunnel 介面，不必替每個對端各建一個。新增分公司時 hub 完全不用改設定。',
        'NHRP：通道位址對公用位址的查號台。spoke 開機時向 hub（NHS）註冊「我的通道位址是 X、公用位址是 Y」；要找別的 spoke 時向 hub 查詢。',
        'IPsec：用 tunnel protection 套在 Tunnel 介面上，誰和誰之間有流量就動態建立加密通道。',
      ],
    },
    {
      h: '三個階段',
      table: {
        head: ['', '第一階段', '第二階段', '第三階段'],
        rows: [
          ['spoke 之間', '一律經過 hub', '可以直接建通道', '可以直接建通道'],
          ['spoke 的 Tunnel', '點對點 GRE（只對 hub）', 'mGRE', 'mGRE'],
          ['路由的要求', 'hub 可以彙總、送預設路由', '下一站必須保持是「原本那台 spoke」，hub 不能彙總', 'hub 可以彙總；靠 NHRP 修正下一站'],
          ['關鍵指令', '—', 'EIGRP：no ip next-hop-self；OSPF：broadcast 類型', 'hub：ip nhrp redirect；spoke：ip nhrp shortcut'],
        ],
      },
      p: ['第三階段的流程：spoke A 往 spoke B 的第一個封包照路由表送給 hub；hub 發現它從 Tunnel 進來、又要從同一個 Tunnel 出去，就一邊轉送、一邊回一個 NHRP redirect 給 A：「你可以直接找 B」。A 於是送 NHRP resolution 問 B 的公用位址，拿到之後在路由表裡裝一條捷徑，之後的封包就直接走 A 到 B 的通道。'],
    },
    {
      h: '路由協定跑在 DMVPN 上要注意的',
      list: [
        'EIGRP：hub 從 Tunnel 收到 spoke 的路，預設不會再從同一個介面送給別的 spoke（split horizon）。hub 要 no ip split-horizon eigrp；第二階段還要 no ip next-hop-self eigrp。spoke 設成 stub。',
        'OSPF：point-to-multipoint 最單純（spoke 之間都經過 hub）；要 spoke 直通的話用 broadcast，hub 當 DR、spoke 的優先權設 0。OSPF 在 DMVPN 上的規模有限，分公司很多時不建議。',
        'BGP：規模最大的選擇。hub 用 bgp listen range 接受動態的鄰居，不用替每家分公司寫設定。',
        'hub 要 ip nhrp map multicast dynamic，路由協定的群播才會被複製給每一台註冊的 spoke。',
      ],
    },
    {
      h: '備援的設計',
      list: [
        '雙 hub、單一雲 (dual hub single cloud)：兩台 hub 在同一個通道網段，spoke 一個 Tunnel 介面、兩個 NHS。設定少，但兩台 hub 不容易區分主備。',
        '雙 hub、雙雲 (dual hub dual cloud)：每台 hub 一個獨立的通道網段，spoke 有兩個 Tunnel 介面，通常各走一條 ISP。用路由協定的 metric 決定主備，最容易控制。',
        '同一個實體介面上有兩個 Tunnel 時，要用 tunnel key 區分，而且 tunnel protection 要加 shared。',
      ],
      code: { v: 'Cisco IOS：第三階段的 spoke', c: ['interface Tunnel0', ' ip address 10.20.0.11 255.255.255.0', ' ip mtu 1400', ' ip tcp adjust-mss 1360', ' ip nhrp authentication DMVPN26', ' ip nhrp network-id 1', ' ip nhrp nhs 10.20.0.1 nbma 203.0.113.2 multicast', ' ip nhrp shortcut', ' tunnel source GigabitEthernet0/0/0', ' tunnel mode gre multipoint', ' tunnel key 100', ' tunnel protection ipsec profile DMVPN', '!', 'show dmvpn', 'show ip nhrp', 'show crypto ikev2 sa'] },
      note: 'show dmvpn 的狀態欄由下往上看：IKE 代表 IPsec 還沒起來、NHRP 代表註冊中、UP 才是好了。排錯的順序也一樣：底層通不通 → IPsec → NHRP → 路由協定。',
    },
  ],

  mpls: [
    {
      h: '標籤與角色',
      p: ['MPLS 在第二層標頭與 IP 標頭之間插入 4 個位元組的標籤：20 個位元的標籤值、3 個位元的 TC（QoS）、1 個位元的 S（是不是最底下那一層）、8 個位元的 TTL。核心的路由器只看標籤、查一張很小的表（LFIB）就決定往哪送，不必看 IP 標頭。'],
      table: { head: ['角色', '做什麼'], rows: [['CE', '客戶的路由器，完全不知道有 MPLS'], ['PE（LER）', '業者的邊界：把 IP 封包貼上標籤 (push)、或把標籤拿掉 (pop) 交給客戶'], ['P（LSR）', '業者的核心：只做標籤交換 (swap)，不需要知道客戶的路由']] },
      list: ['LDP 負責替 IGP 學到的每一個前綴分配標籤並告訴鄰居：用 UDP 646 找鄰居、TCP 646 建立連線。連線建立在 LDP router-id（通常是 Loopback）之間，所以 Loopback 要在 IGP 裡而且互相到得了。', '倒數第二站彈出 (PHP)：最後一台 PE 向鄰居宣告的是「隱含空標籤」(implicit null，標籤值 3)，意思是「送給我之前先把外層標籤拿掉」。這樣 PE 就不必先查一次標籤、再查一次路由表。'],
    },
    {
      h: 'L3VPN：把每個客戶放進自己的路由表',
      list: [
        'VRF：PE 上每個客戶一份路由表，客戶的位址可以互相重疊。',
        'RD (route distinguisher)：加在 IPv4 前綴前面的 8 個位元組，讓重疊的前綴在 BGP 裡變成不同的 VPNv4 前綴。它只負責「不一樣」，不決定誰看得到誰。',
        'RT (route-target)：貼在路由上的 extended community。匯出時貼上、匯入時比對，決定這條路要放進哪些 VRF。完整網狀、hub-and-spoke、共用服務這些拓撲，都只是 RT 的不同組合。',
        'MP-BGP：PE 之間用 iBGP 的 vpnv4 位址家族交換這些路由，順便帶著一個 VPN 標籤。',
      ],
      p: ['封包經過骨幹時貼著兩層標籤：內層是 VPN 標籤（告訴對面的 PE 這是哪個 VRF 的），外層是 LDP 的傳輸標籤（把封包送到對面 PE 的 Loopback）。P 路由器只看外層，所以它完全不需要客戶的路由，也不必跑 BGP。'],
    },
    {
      h: 'PE 與 CE 之間跑什麼',
      table: {
        head: ['協定', '要注意的'],
        rows: [
          ['靜態', '最簡單；PE 上 redistribute static 進 BGP'],
          ['eBGP', '最常用。兩個據點用同一個 AS 編號時，路由回來會被自己的 AS path 檢查擋掉：PE 設 as-override，或 CE 設 allowas-in'],
          ['OSPF', '骨幹被當成一個「超級骨幹」。同一個 domain-id 的據點之間路由是 O IA；down bit 與 domain tag 防止路由從後門繞回來；據點之間有後門線路時要 sham-link'],
          ['EIGRP', '用 SoO (site of origin) 防止路由繞回原本的據點'],
        ],
      },
    },
    {
      h: '排錯：控制平面好了不代表封包過得去',
      list: [
        '① IGP：PE 之間的 Loopback 互相 ping 得到嗎（要指定來源是 Loopback）。',
        '② LDP：show mpls ldp neighbor、show mpls interfaces。骨幹每一段線的兩端都要 mpls ip，少一段標籤路徑就斷了。',
        '③ VPNv4：show bgp vpnv4 unicast all summary，鄰居是 Established 而且有收到前綴。',
        '④ VRF：show ip route vrf <名稱> 有沒有對面的路；沒有的話看 RT 的匯入與匯出（show vrf detail）。',
        '⑤ 標籤：show mpls forwarding-table、show bgp vpnv4 unicast all labels。',
      ],
      note: '最難發現的故障是「BGP 是 Established、VRF 裡也有路由，封包卻不通」：那是骨幹中間某一段沒有 LDP。BGP 的連線走的是 IP，不需要標籤；客戶的封包卻要靠標籤穿過不認識它的 P 路由器。Loopback 用 /32 也是同樣的理由：LDP 替 /32 分配標籤，遮罩不對標籤就接不起來。',
    },
  ],

  sdwan: [
    {
      h: '它和傳統 WAN 差在哪裡',
      p: ['傳統的 WAN 是一台一台設定：每台路由器自己的通道、自己的路由政策、自己的 QoS。SD-WAN 把「決定」集中起來：管理者在控制器上定義意圖（語音走品質最好的線、備份走最便宜的線、這個應用直接從分公司上網），控制器把它變成每一台邊界設備的設定與政策。底下的線路可以是 MPLS、寬頻、4G 的任意組合，上面一律建加密的通道。'],
    },
    {
      h: 'Cisco SD-WAN 的幾個元件',
      table: {
        head: ['元件', '負責的平面', '做什麼'],
        rows: [
          ['SD-WAN Manager（vManage）', '管理', '設定範本、政策、監控、軟體升級的單一介面'],
          ['SD-WAN Controller（vSmart）', '控制', '用 OMP 和每一台邊界設備交換路由、金鑰與政策；不經手使用者的資料'],
          ['SD-WAN Validator（vBond）', '編排', '新設備第一個聯絡的對象：驗證身分、告訴它控制器在哪裡、協助穿越 NAT'],
          ['WAN Edge', '資料', '放在各據點：建 IPsec 通道、轉送流量、量測線路品質'],
        ],
      },
      list: ['OMP 是控制器與邊界設備之間的路由協定，長得像 BGP：交換前綴、TLOC（每一條線路的端點：系統 IP ＋ 線路顏色 ＋ 封裝）與服務。', '每一條通道上都跑 BFD，持續量延遲、抖動與遺失。應用感知路由 (app-aware routing) 就是拿這些數字和政策裡的 SLA 門檻比，不合格就把那類流量換到別條線。'],
    },
    {
      h: '設計上要想的事',
      list: [
        '哪些應用要直接從分公司上網 (DIA)、哪些要回總公司過安全檢查。',
        'SLA 的門檻要照應用訂：語音對抖動與遺失敏感，檔案傳輸只在乎頻寬。',
        '線路品質的判斷要有遲滯，不然品質在門檻邊緣時流量會在兩條線之間來回跳。',
        '控制器不在資料路徑上：控制器斷線時，邊界設備照最後收到的路由與政策繼續轉送（有時間上限）。',
      ],
      note: 'FortiGate 的 SD-WAN 概念相同、名稱不同：把幾個 WAN 介面加進一個 SD-WAN zone，用 performance SLA 量每條線，再用 SD-WAN rule 依目的地或應用決定走哪一條（最低延遲、最佳品質、依頻寬比例…）。',
    },
  ],

  'metro-e': [
    {
      h: '三種服務',
      table: { head: ['服務', '形狀', '像什麼'], rows: [['E-Line（EPL / EVPL）', '點對點', '一條很長的網路線；EVPL 一個實體埠上可以用 VLAN 分出好幾條'], ['E-LAN', '多點對多點', '一台很大的交換器，每個據點是它的一個埠'], ['E-Tree', '一個根、很多葉', '葉子只能和根通，彼此不通（像 Private VLAN）']] },
      p: ['客戶接的那個埠叫 UNI，業者替這條服務建立的虛擬連線叫 EVC。EPL 是「整個埠就是一條」，客戶送什麼標籤都原封不動；EVPL 用客戶的 VLAN 標籤 (CE-VLAN) 決定要進哪一條 EVC，所以兩端的 VLAN 要照業者開通單上寫的設。'],
    },
    {
      h: '第二層協定的處理',
      list: [
        '業者的設備對客戶的第二層控制訊框（STP、CDP、LLDP、LACP、VTP）有三種處理方式：自己處理 (peer)、丟掉 (discard)、原封不動送到對面 (tunnel，L2PT)。',
        '被丟掉的話，客戶兩端的交換器互相看不到對方的 BPDU，各自都以為自己是根橋。只有一條線的時候沒事；一旦多拉一條備援線，就形成生成樹看不見的迴圈。',
        '最穩的做法是不要把生成樹延伸過專線：兩端用路由器或 L3 交換器的 routed port 對接，專線上只跑第三層。',
        '業者通常會限制每個 UNI 能學到的 MAC 位址數量，以及用 CIR / EIR 限速。超過 CIR 的流量可能被丟掉，所以客戶端要自己做整形。',
      ],
    },
  ],
};
