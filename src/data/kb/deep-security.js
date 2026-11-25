// 知識庫「深入了解」：網路安全（格式見 deep-routing.js）

export const DEEP_SECURITY = {
  acl: [
    {
      h: 'ACL 的種類',
      table: {
        head: ['種類', '比對什麼', '編號'],
        rows: [['標準', '只有來源位址', '1 – 99、1300 – 1999'], ['延伸', '來源、目的、協定、埠號、TCP 旗標…', '100 – 199、2000 – 2699'], ['具名', '標準或延伸都可以，用名字', 'ip access-list extended 名稱']],
      },
      p: ['具名 ACL 是現在的標準寫法：每一條有序號，可以插入、刪除單獨一條（編號 ACL 在舊版 IOS 只能整個刪掉重寫）。ip access-list resequence 名稱 10 10 可以重新編號，騰出插入的空間。'],
    },
    {
      h: '比對的規則',
      list: [
        '由上往下，第一條符合的就決定結果，後面的不再看。所以範圍小的例外要放在範圍大的規則前面。',
        '最後有一條看不見的 deny any。只寫了幾條 deny 卻沒有 permit 的 ACL 等於全部擋掉。',
        '萬用遮罩 (wildcard) 是子網路遮罩的反面：0 的位元要比對、1 的位元不管。0.0.0.255 是 /24，0.0.0.0 是單一主機（可以寫 host），255.255.255.255 是全部（可以寫 any）。',
        '空的 ACL（名字存在、裡面沒有條目）套在介面上等於沒有 ACL，全部放行；等你加進第一條，隱含的 deny 就突然生效了。',
        '路由器「自己產生」的封包不受 outbound ACL 過濾。',
      ],
    },
    {
      h: '放在哪裡、哪個方向',
      list: [
        '延伸 ACL 盡量靠近來源：不該通過的流量越早丟掉越好，不要讓它穿過整個網路才被擋。',
        '標準 ACL 只看來源，放太靠近來源會把它往所有目的地的流量都擋掉，所以只能放在靠近目的地的地方。',
        'in：封包進介面時、查路由表之前比對。out：路由決定之後、送出去之前比對。同一個介面每個方向、每種協定只能套一個 ACL。',
        '回程的流量常常被忘記。用 established（只允許已經建立的 TCP 連線的回應）或 reflexive ACL；真的需要追蹤連線狀態就該用防火牆。',
      ],
    },
    {
      h: '交換器上的三種 ACL',
      table: { head: ['類型', '套在哪', '管什麼'], rows: [['RACL', '第三層介面（SVI、routed port）', '被路由的流量'], ['PACL', '第二層的埠', '進這個埠的流量，同一個 VLAN 內的也管得到'], ['VACL', '整個 VLAN（vlan access-map）', '這個 VLAN 裡所有的流量，不管是橋接還是路由']] },
      p: ['硬體交換器把 ACL 寫進 TCAM 比對，速度不受條目多寡影響，但容量有限。加了 log 的條目要送到 CPU 產生紀錄，流量大時會把 CPU 拖垮。'],
    },
    {
      h: '驗證',
      list: ['show access-lists：每一條後面的 (n matches) 是命中次數。該命中的沒命中，就是前面有別的條目先吃掉了，或流量根本沒走到這個介面。', 'show ip interface <介面>：這個介面的 in 與 out 各套了哪個 ACL。', 'clear access-list counters 把計數器歸零再測一次，比較看得出來。'],
      code: { v: 'Cisco IOS', c: ['ip access-list extended DC-IN', ' 10 permit tcp 10.20.0.0 0.3.255.255 host 10.50.1.10 eq 443', ' 20 deny   ip  10.20.0.0 0.3.255.255 any log', ' 30 permit ip  any any', '!', 'interface GigabitEthernet0/0/0', ' ip access-group DC-IN in', '!', 'ip access-list extended DC-IN', ' 15 permit icmp 10.20.0.0 0.3.255.255 host 10.50.1.10 echo', ' no 20'] },
    },
  ],

  zbf: [
    {
      h: '用區域思考，不是用介面',
      p: ['傳統的做法是在每個介面上套 ACL，介面一多規則就互相糾纏。Zone-Based Firewall 先把介面分進區域（inside、dmz、outside），再針對「從哪個區域到哪個區域」這個方向寫政策。它是有狀態的：放行了去的方向，回應會自動被允許，不必替回程寫規則。'],
      list: [
        '同一個區域的介面之間：預設全部放行。',
        '兩個不同的區域之間：沒有寫政策 (zone-pair) 就全部丟掉。',
        '有分進區域的介面，和沒有分區域的介面之間：全部丟掉。這是導入時最容易出事的地方 —— 只把一半的介面放進區域，另一半就不通了。',
        '路由器自己是一個特殊的區域叫 self。往路由器本身的流量（SSH、路由協定、IPsec）預設是放行的，除非替 self 寫了 zone-pair。',
      ],
    },
    {
      h: '三層的設定結構',
      list: [
        'class-map type inspect：定義「哪些流量」（比對協定或 ACL）。',
        'policy-map type inspect：對每一類流量做什麼 —— inspect（放行並追蹤狀態）、pass（放行但不追蹤，回程要另外寫）、drop（丟掉，可以加 log）。',
        'zone-pair security：把 policy-map 套在某個來源區域到目的區域的方向上。',
      ],
      code: { v: 'Cisco IOS', c: ['zone security INSIDE', 'zone security OUTSIDE', '!', 'class-map type inspect match-any WEB', ' match protocol http', ' match protocol https', ' match protocol dns', 'policy-map type inspect IN-TO-OUT', ' class type inspect WEB', '  inspect', ' class class-default', '  drop log', '!', 'zone-pair security IN-OUT source INSIDE destination OUTSIDE', ' service-policy type inspect IN-TO-OUT', '!', 'interface GigabitEthernet0/0/1', ' zone-member security INSIDE', 'interface GigabitEthernet0/0/0', ' zone-member security OUTSIDE'] },
      note: 'pass 與 inspect 的差別是考試常客：pass 只管單一方向、不建立連線狀態，所以回程的 zone-pair 也要寫 pass。IPsec 的 ESP 這類沒有狀態可以追蹤的協定才會用 pass。',
    },
  ],

  'dhcp-snooping': [
    {
      h: '它建立了一張表',
      p: ['DHCP snooping 把交換器的埠分成信任與不信任。伺服器才會送的訊息（OFFER、ACK）只准從信任的埠進來，從不信任的埠進來就丟掉 —— 冒牌的 DHCP 伺服器因此發不出位址。同時，交換器在旁邊看著每一次成功的租約，把「這個 MAC、拿到這個 IP、在這個 VLAN、接在這個埠、租約多久」記進繫結表 (binding table)。這張表才是它真正的價值：DAI 與 IP Source Guard 都靠它判斷真假。'],
      list: [
        '信任的埠：往真正的 DHCP 伺服器的方向（上行、接伺服器的埠）。其他全部是不信任的（預設）。',
        '要先全域開啟 ip dhcp snooping，再指定要保護的 VLAN（ip dhcp snooping vlan 10,20）。只做前一步什麼都不會發生。',
        '不信任的埠可以限制每秒的 DHCP 封包數（ip dhcp snooping limit rate），超過就 err-disabled，防止有人把位址池要光。',
        '繫結表存在記憶體裡，交換器重開機就沒了，已經拿到位址的主機會被 DAI 擋住，直到它們重新要一次位址。用 ip dhcp snooping database 把它存到 flash 或 TFTP。',
      ],
    },
    {
      h: 'option 82 的坑',
      p: ['開了 snooping 的交換器預設會在 DHCP 請求裡插入 option 82（這個請求是從哪台交換器的哪個埠來的）。但這時封包裡的 giaddr 還是 0.0.0.0。Cisco IOS 的 DHCP 伺服器看到「有 option 82 卻沒有 giaddr」會認為不合理而丟掉，上一層的交換器如果也開了 snooping，同樣會在不信任的埠丟掉它。症狀是「一開 snooping 大家都要不到位址」。'],
      list: ['接取層交換器不插入：no ip dhcp snooping information option（最常見的做法）。', '或讓上游接受：DHCP 伺服器 / Relay 的介面上 ip dhcp relay information trusted，上一層交換器的下行埠 ip dhcp snooping information option allow-untrusted。'],
      code: { v: 'Cisco IOS', c: ['ip dhcp snooping', 'ip dhcp snooping vlan 10,20', 'no ip dhcp snooping information option', '!', 'interface GigabitEthernet0/10', ' description uplink', ' ip dhcp snooping trust', 'interface range GigabitEthernet0/1 - 8', ' ip dhcp snooping limit rate 15', '!', 'show ip dhcp snooping', 'show ip dhcp snooping binding'] },
    },
  ],

  dai: [
    {
      h: 'ARP 為什麼好騙',
      p: ['ARP 沒有任何驗證：任何人都可以主動送一個 ARP 回覆說「閘道的 IP 在我這個 MAC」，同網段的主機就會乖乖更新快取，把流量送給他。攻擊者再把流量轉給真正的閘道，就成了中間人。Dynamic ARP Inspection 在交換器上攔下每一個 ARP 封包，拿裡面的「IP 與 MAC」去對 DHCP snooping 的繫結表，對不上的就丟掉。'],
      list: [
        '信任的埠不檢查（交換器之間的上行、接路由器的埠）。其他的埠都要檢查。',
        '固定 IP 的設備（伺服器、印表機、閘道本身接在不信任的埠時）不在繫結表裡：替它們寫 ARP ACL（arp access-list），或用 ip source binding 加一筆靜態繫結。',
        '額外的檢查 ip arp inspection validate src-mac dst-mac ip：乙太網路標頭的 MAC 要和 ARP 內容裡的一致、IP 不能是 0.0.0.0 或群播位址。',
        '不信任的埠預設限制每秒 15 個 ARP，超過就 err-disabled。接了很多主機的埠（下面還有交換器或 AP）要調高。',
      ],
      note: 'DAI 的前提是 DHCP snooping 先運作一陣子、繫結表已經有內容。在既有的網路上直接打開 DAI，所有還沒重新要過位址的主機會立刻斷線。上線的順序：先開 snooping → 等一個租約週期（或讓主機重新取得位址）→ 確認繫結表完整 → 才開 DAI。',
    },
  ],

  dot1x: [
    {
      h: '三個角色與兩段協定',
      table: { head: ['角色', '是誰', '說什麼協定'], rows: [['Supplicant', '要連上網路的設備（電腦、電話）', 'EAPOL（EAP over LAN）到交換器'], ['Authenticator', '交換器或無線控制器', '把 EAP 包進 RADIUS 轉給伺服器'], ['Authentication Server', 'RADIUS 伺服器（ISE、NPS、FreeRADIUS）', '回答 Access-Accept / Reject，可以附帶 VLAN、ACL']] },
      p: ['驗證通過之前，埠只允許 EAPOL（以及 CDP、STP 這些）通過，其他一律丟掉。交換器本身不判斷帳號密碼對不對，它只是傳話的；真正決定的是 RADIUS 伺服器。'],
    },
    {
      h: '常見的 EAP 方法',
      table: {
        head: ['方法', '用戶端怎麼證明自己', '伺服器憑證', '特色'],
        rows: [['PEAP-MSCHAPv2', '帳號密碼（在 TLS 通道裡）', '需要', '最容易導入；密碼被釣走就破了'], ['EAP-TLS', '用戶端憑證', '需要', '最安全，不用密碼；要有 PKI 發憑證給每台設備'], ['EAP-FAST', 'PAC 檔', '不一定', 'Cisco 的方法，不需要憑證基礎建設'], ['MAB', '只看 MAC 位址', '—', '不是 EAP：給印表機、攝影機這些不會 802.1X 的設備']],
      },
    },
    {
      h: '一個埠上不只一台設備',
      table: { head: ['host mode', '允許'], rows: [['single-host', '只有一個 MAC；出現第二個就違規'], ['multi-host', '第一台驗證過，後面的都搭便車（不安全）'], ['multi-domain', '語音網域一台（電話）＋資料網域一台（電腦）'], ['multi-auth', '每個 MAC 各自驗證']] },
      list: ['驗證失敗或沒有回應時可以放進受限的 VLAN：guest VLAN（設備不會 802.1X）、auth-fail VLAN（驗證失敗）、critical VLAN（RADIUS 伺服器連不到）。', '伺服器可以在 Access-Accept 裡回傳 VLAN（Tunnel-Private-Group-ID）或可下載的 ACL，同一個埠依登入的人給不同的權限。', 'CoA (Change of Authorization)：伺服器之後可以主動要求交換器重新驗證或踢掉某個連線，例如電腦通過健康檢查之後換到正式的 VLAN。'],
    },
    {
      h: '導入的三個階段',
      list: [
        '監看模式 (open mode)：照樣驗證，但不管成功失敗都放行。目的是從 RADIUS 的紀錄找出哪些設備會失敗，不影響使用者。',
        '低影響模式：驗證之前只放行基本的流量（DHCP、DNS），通過之後才套用完整的權限。',
        '封閉模式：沒通過就什麼都不通。',
        '一開始就用封閉模式，隔天早上所有印表機、電話、會議室設備都斷線，是最常見的導入災難。',
      ],
      code: { v: 'Cisco IOS', c: ['aaa new-model', 'radius server ISE', ' address ipv4 10.0.99.10 auth-port 1812 acct-port 1813', ' key S3cret!', 'aaa authentication dot1x default group radius', 'aaa authorization network default group radius', 'dot1x system-auth-control', '!', 'interface GigabitEthernet0/1', ' switchport mode access', ' authentication port-control auto', ' authentication host-mode multi-domain', ' authentication order dot1x mab', ' mab', ' dot1x pae authenticator', '!', 'show authentication sessions interface GigabitEthernet0/1 details'] },
    },
  ],

  aaa: [
    {
      h: '三件事分開看',
      list: ['Authentication（認證）：你是誰。', 'Authorization（授權）：你可以做什麼（權限等級、可以下哪些指令、拿到哪個 VLAN）。', 'Accounting（記錄）：你做了什麼、什麼時候做的。'],
      table: { head: ['', 'TACACS+', 'RADIUS'], rows: [['傳輸', 'TCP 49', 'UDP 1812 / 1813（舊的是 1645 / 1646）'], ['加密', '整個封包的內容', '只有密碼欄位'], ['三個 A', '分開，可以各自指定伺服器', '認證與授權合在同一個回應裡'], ['逐條指令授權', '可以', '不行'], ['主要用途', '管理網路設備（誰可以下什麼指令）', '使用者連上網路（802.1X、VPN、Wi-Fi）']] },
    },
    {
      h: '方法清單：後面的方法什麼時候才會用到',
      p: ['aaa authentication login default group tacacs+ local 的意思是「先問 TACACS+，再用本機帳號」。但第二個方法只有在第一個「沒有回應」（伺服器連不到、逾時）的時候才會用。伺服器明確回答「密碼錯誤」的話，驗證就到此為止，不會再試本機帳號。'],
      list: [
        '所以一定要留一個本機帳號當後備，而且密碼要另外保管：TACACS+ 伺服器連不到的時候（往往就是網路出事的時候），那是唯一進得去的方法。',
        'default 清單會套用到所有的線路（console、vty）。想讓 console 永遠用本機驗證，另外建一個具名清單套在 line con 0。',
        'aaa new-model 一打下去，所有線路馬上改用 AAA。還沒建好本機帳號就打這一行，會把自己鎖在外面。順序：先建帳號 → aaa new-model → 設定方法清單 → 開另一個視窗測試 → 才存檔。',
        '授權也要有後備：aaa authorization exec default group tacacs+ local，不然伺服器連不到時登得進去卻沒有權限。',
      ],
      code: { v: 'Cisco IOS', c: ['username admin privilege 15 secret Backup-0nly!', 'aaa new-model', 'tacacs server TAC1', ' address ipv4 10.0.99.20', ' key S3cret!', 'aaa group server tacacs+ TAC', ' server name TAC1', '!', 'aaa authentication login default group TAC local', 'aaa authentication login CONSOLE local', 'aaa authorization exec default group TAC local', 'aaa authorization commands 15 default group TAC local', 'aaa accounting commands 15 default start-stop group TAC', '!', 'line con 0', ' login authentication CONSOLE'] },
    },
  ],

  pki: [
    {
      h: '憑證裡面有什麼',
      list: [
        '主體 (Subject) 與主體別名 (SAN)：這張憑證是發給誰的。現在的瀏覽器只看 SAN，CN 已經不算數。',
        '公開金鑰：對方用它來驗證你的簽章、或加密只有你能解開的東西。對應的私密金鑰永遠不離開持有者。',
        '簽發者 (Issuer) 與簽章：哪一個 CA 用自己的私密金鑰簽了這張憑證。',
        '有效期間：開始與結束的時間。用戶端用「自己的時鐘」判斷，所以時間不對的設備會覺得憑證還沒生效或已經過期。',
        '用途 (Key Usage / Extended Key Usage)：伺服器驗證、用戶端驗證、簽發其他憑證…',
        '撤銷資訊的位置：CRL 的網址、OCSP 的網址；AIA 則寫著「簽發我的那張 CA 憑證可以到哪裡下載」。',
      ],
    },
    {
      h: '信任鏈',
      p: ['用戶端手上只有少數幾張它信任的根憑證。根 CA 的私密金鑰太重要，平常離線保管，實際簽發憑證的是根 CA 簽出來的中繼 CA。所以驗證的時候要接出一條鏈：網站的憑證 → 中繼 CA 的憑證 → 根憑證，每一張都由上一張簽發，最上面那張在信任清單裡。'],
      list: [
        '伺服器要把自己的憑證和中繼憑證一起送出來（fullchain）。只送自己那一張，用戶端就接不上。',
        '瀏覽器會照 AIA 自己去抓缺少的中繼憑證，所以看起來沒事；curl、程式語言的 HTTP 函式庫、手機 App 大多不會，就失敗了。',
        '不要用瀏覽器判斷憑證裝對了沒有：用 openssl s_client -connect 主機:443 -showcerts 看伺服器實際送出幾張。',
      ],
    },
    {
      h: '用戶端的檢查清單',
      table: {
        head: ['檢查', '失敗時的訊息'],
        rows: [['鏈接得到信任的根', 'unable to get local issuer certificate / 不受信任的簽發者'], ['不是自己簽給自己', 'self-signed certificate'], ['現在的時間在有效期間內', 'certificate has expired / not yet valid'], ['網址的名稱在 SAN 裡', 'hostname mismatch / subject name does not match'], ['沒有被撤銷', 'certificate revoked'], ['用途相符', 'unsupported certificate purpose']],
      },
    },
    {
      h: '申請與更新',
      list: [
        '在設備上產生金鑰對與 CSR（憑證簽署要求：主體、SAN、公開金鑰，用私密金鑰簽名）。私密金鑰留在設備上。',
        'CA 驗證申請者的身分之後簽發。公開 CA 驗證你擁有那個網域（放一個檔案、加一筆 DNS 記錄）；公開 CA 不會簽 .local 這種內部名稱，那要用公司自己的 CA。',
        '自動化：ACME（Let\'s Encrypt 用的協定）、SCEP 與 EST（網路設備向公司的 CA 自動申請）。',
        '憑證到期是最常見的重大事故之一，而且完全可以預防：監控到期日、自動續約，並且真的測過續約流程。',
      ],
      note: '網路設備的 IPsec、802.1X、HTTPS 管理介面都會用到憑證，而它們都依賴正確的時間。沒有 NTP 的設備重開機後時鐘回到出廠日期，憑證「還沒生效」，VPN 就起不來。憑證之前先把 NTP 設好。',
    },
  ],

  hardening: [
    {
      h: '三個平面',
      table: { head: ['平面', '是什麼', '怎麼保護'], rows: [['管理平面', '人與工具進設備的路：SSH、SNMP、Syslog、NTP、API', '只開加密的協定、限制來源位址、AAA、帶外管理'], ['控制平面', '設備之間交換的協定：OSPF、BGP、STP、ARP', '協定驗證、CoPP、生成樹與第二層的保護'], ['資料平面', '使用者的流量', 'ACL、uRPF、Port Security、DHCP snooping、DAI']] },
    },
    {
      h: '管理平面的清單',
      list: [
        '關掉 Telnet 與 HTTP，只留 SSH 版本 2 與 HTTPS：transport input ssh、ip ssh version 2、no ip http server。',
        'vty 套 access-class，只允許管理網段連進來；設 exec-timeout 讓閒置的連線自動登出。',
        '密碼用 secret（雜湊）不要用 password；enable secret、username … secret，演算法選 scrypt（type 9）。service password-encryption 的 type 7 只是混淆，幾秒就能還原。',
        '登入失敗的防護：login block-for 60 attempts 5 within 30。',
        'SNMP 用 v3 的 authPriv，沒有在用的 v2c community（尤其是 public / private）刪掉。',
        'NTP 與 Syslog：所有設備對時、紀錄送到集中的伺服器，service timestamps log datetime msec。出事之後才有辦法還原時間順序。',
        '登入前的警語 (banner)：不要寫「歡迎」，要寫未經授權不得使用。',
      ],
    },
    {
      h: '關掉用不到的東西',
      list: [
        '沒在用的埠 shutdown 並放進沒有路由的 VLAN。',
        '對外的介面：no cdp enable、no ip proxy-arp、no ip redirects、no ip unreachables、no ip directed-broadcast。',
        '全域：no ip source-route、no service pad、no ip bootp server、no ip finger。',
        'IOS XE 的 auto secure 可以一次處理大部分，但每一項都要知道它關掉了什麼。',
      ],
      note: '加固不是一次性的工作。把這份清單寫成範本或合規檢查（Ansible、設定稽核工具），每次變更之後自動比對，才不會過半年又漂移回去。',
    },
  ],

  'port-security': [
    {
      h: '三種違規動作',
      table: { head: ['模式', '違規的訊框', '計數器 / 紀錄', '埠的狀態'], rows: [['protect', '丟掉', '不記錄', '照常'], ['restrict', '丟掉', '計數器加一、送 syslog 與 SNMP trap', '照常'], ['shutdown（預設）', '丟掉', '有', 'err-disabled，整個埠關掉']] },
      p: ['shutdown 最安全也最吵：一台不該出現的設備會讓整個埠斷線，包括上面合法的設備（例如電話後面的電腦）。restrict 只丟違規的訊框、合法的照常通，同時留下紀錄，是比較實用的折衷。'],
    },
    {
      h: 'MAC 位址怎麼來',
      list: [
        '靜態：手動寫 switchport port-security mac-address <MAC>。',
        '動態：學到就算，重開機或埠 down 就忘記。',
        'sticky：動態學到之後自動寫進 running-config。存檔之後就等於靜態的，不用一個一個手打。',
        'maximum：這個埠最多幾個 MAC（預設 1）。接電話加電腦的埠至少要 2 到 3 個（電話在語音 VLAN 與資料 VLAN 可能各算一次）。',
        '老化：switchport port-security aging time 設定動態位址多久之後釋放，適合共用的座位。',
      ],
      code: { v: 'Cisco IOS', c: ['interface GigabitEthernet0/3', ' switchport mode access', ' switchport port-security', ' switchport port-security maximum 2', ' switchport port-security mac-address sticky', ' switchport port-security violation restrict', '!', 'errdisable recovery cause psecure-violation', 'errdisable recovery interval 300', '!', 'show port-security interface GigabitEthernet0/3', 'show port-security address'] },
      note: 'Port Security 只能用在 access 或寫死的 trunk 埠，dynamic 的埠不行。它擋得住 MAC flooding 與隨手接上的設備，但 MAC 位址可以偽造；要真正確認「是誰」，得用 802.1X。',
    },
  ],
};
