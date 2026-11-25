// 知識庫：進階主題（CCNP / CCIE 的範圍）。格式和其他分類的檔案一樣，每一則都帶「深入了解」(deep)。

export const ADVANCED = [
  {
    id: 'bgp-community', t: 'BGP community 與流量工程', en: 'BGP Communities & Traffic Engineering', cat: 'routing',
    keys: ['BGP community', 'community', 'no-export', 'send-community', 'MED', 'AS-path prepend', '流量工程'], tags: ['community', 'MED', 'no-export', 'send-community', 'local-preference', 'AS-path prepend'],
    sum: 'community 是貼在 BGP 路由上的標籤，本身沒有作用，收到的人照約定處理。配合 local-preference、MED、AS-path prepend，決定流量從哪裡出去、從哪裡進來。',
    body: [
      '出去的方向自己說了算：從鄰居收進來的路由設 local-preference（越大越優先，會傳遍整個 AS）。進來的方向只能影響對方：兩條線接同一個 AS 用 MED（越小越好），接不同的 AS 用 AS-path prepend 把備援那一條的路徑加長。',
      'community 的格式是「AS 編號:數字」（例如 64500:80）。業者會公布一份清單：帶 64500:80 的路由 local-preference 設成 80、帶 64500:666 的路由直接丟掉（黑洞）…，客戶只要貼對標籤就能請業者替自己調整。',
    ],
    fig: { type: 'table', head: ['公認的 community', '收到的路由器怎麼做'], rows: [['no-export', '不送給 eBGP 鄰居：這條路只留在這個 AS'], ['no-advertise', '不送給任何鄰居'], ['local-AS', '不送出這個子 AS（confederation）'], ['internet', '沒有限制（預設）']] },
    pit: ['route-map 裡 set community 之後，鄰居還要 neighbor … send-community，標籤才會真的送出去。這是最常見的遺漏。', 'set community 會「取代」原本所有的 community；要保留原本的再加一個，寫 set community 64500:80 additive。', 'MED 只在「同一個鄰居 AS 來的幾條路」之間比較。接兩家不同的 ISP 時設 MED 沒有用。'],
    cmd: [{ v: 'Cisco IOS', c: ['ip bgp-community new-format', 'ip community-list standard BACKUP permit 64500:80', 'route-map TO-ISP permit 10', ' set community 64500:80 additive', ' set metric 100', 'router bgp 65020', ' neighbor 203.0.113.5 route-map TO-ISP out', ' neighbor 203.0.113.5 send-community', 'show ip bgp community 64500:80', 'show ip bgp 192.0.2.0'] }],
    see: ['bgp', 'ibgp', 'redistribution'],
    deep: [
      {
        h: '四種流量工程的工具各管什麼',
        table: { head: ['工具', '管哪個方向', '作用的範圍', '怎麼設'], rows: [['weight', '出去', '只有這一台路由器', 'neighbor … weight，或 route-map in 裡 set weight'], ['local-preference', '出去', '整個 AS（跟著 iBGP 傳）', 'route-map in：set local-preference 200'], ['AS-path prepend', '進來', '所有看到這條路的 AS', 'route-map out：set as-path prepend 65020 65020'], ['MED', '進來', '只有直接相連的那個鄰居 AS', 'route-map out：set metric 50'], ['community', '看約定', '收到的人怎麼處理就怎麼處理', 'route-map out：set community …']] },
        p: ['順序很重要：對方比較路徑時 local-preference 排在 AS-path 長度之前。如果 ISP 對「客戶的路由」一律給比較高的 local-preference，你 prepend 再多次也改變不了它的選擇，這時只能用它提供的 community。'],
      },
      {
        h: '用 community 做自己的政策',
        p: ['community 不只是給 ISP 看的。大型網路常在路由進入 AS 的地方依來源貼上標籤（從客戶學到的、從對等互連學到的、從上游學到的、自己的），之後所有的政策都只比對標籤、不必維護一長串的 prefix-list。'],
        list: ['進來的地方貼標籤：route-map FROM-CUSTOMER 裡 set community 65000:100。', '出去的地方看標籤：只把帶 65000:100（客戶的）與自己的路由送給上游，絕不把上游的路由送給另一個上游。', '標籤要跟著路由走：對所有 iBGP 鄰居（包括路由反射器）都要 send-community。', 'extended community 是另一種格式，MPLS VPN 的 route-target 就是它；large community（RFC 8092）解決了 4 位元組 AS 編號放不進去的問題。'],
      },
      {
        h: '驗證',
        list: ['show ip bgp <前綴>：這條路帶著哪些 community、local-preference 與 MED 各是多少、為什麼被選中。', 'show ip bgp neighbors <IP> advertised-routes：我實際送出去的是哪些路。', '看不到 community：對方（或自己）少了 send-community。', '改了 route-map 之後 clear ip bgp <鄰居> soft out / soft in 重新套用，不會中斷連線。'],
        note: '設計題的標準答法：出去用 local-preference、進來用 prepend 或 MED；兩個方向都要考慮主線斷掉之後備援是不是真的會接手，以及回程會不會走另一條線（非對稱）。',
      },
    ],
  },
  {
    id: 'summarization', t: '路由彙總', en: 'Route Summarization', cat: 'routing',
    keys: ['路由彙總', 'summary-address', 'Null0', '丟棄路由'], tags: ['彙總', 'summary-address', 'area range', 'Null0'],
    sum: '把好幾個連續的小網段用一條比較短的前綴表示：路由表變小、更新變少、小網段的震盪不會傳出去。代價是失去細節，可能選到比較差的路。',
    body: [
      '彙總的地方就是「隱藏細節」的邊界：邊界以外的路由器只知道「10.1.0.0/16 往這裡」，裡面哪一條線上下、哪個 /24 新增或消失，它都不會知道，也不需要重新計算。網路越大，這個邊界越重要。',
      '做彙總的那一台會自動多一條指向 Null0 的丟棄路由。彙總範圍裡真的存在的網段有更長的前綴所以照常轉送；不存在的網段落到 Null0 被丟掉，不會順著預設路由送出去又被送回來。',
    ],
    fig: { type: 'table', head: ['協定', '在哪裡彙總', '指令'], rows: [['OSPF（區域間）', '只有 ABR', 'area 10 range 10.10.0.0 255.255.0.0'], ['OSPF（外部）', '只有 ASBR', 'summary-address 172.16.0.0 255.255.0.0'], ['EIGRP', '任何一台、任何介面', 'ip summary-address eigrp 100 10.1.0.0 255.255.0.0'], ['BGP', '任何一台', 'aggregate-address 10.0.0.0 255.0.0.0 summary-only'], ['RIP', '介面上', 'ip summary-address rip 10.1.0.0 255.255.0.0']] },
    pit: ['彙總的範圍比實際存在的網段大時，沒有人用的位址也會被吸過來。一定要有 Null0 的丟棄路由，不然配上預設路由就是迴圈。', '兩台都彙總同一個範圍，但其中一台後面少了某個網段：流量有一半機率被送到那台再被丟掉（黑洞）。', '彙總之後 metric 是整個範圍取一個值，遠端可能選到實際上比較遠的那個出口。'],
    cmd: [{ v: 'Cisco IOS', c: ['router ospf 1', ' area 10 range 10.10.0.0 255.255.0.0', '!', 'show ip route 10.10.0.0 255.255.0.0', 'show ip route | include Null0'] }],
    see: ['subnet', 'ospf-area', 'eigrp', 'bgp', 'routing-table'],
    deep: [
      {
        h: '怎麼算出彙總的前綴',
        list: ['把每個網段有變化的那一段寫成二進位。', '從左邊數，所有網段都相同的位元有幾個，就是彙總的遮罩長度。', '例：172.16.8.0/24 到 172.16.15.0/24。第三段 8 = 00001000、15 = 00001111，前 5 個位元相同，加上前兩段的 16 個位元，彙總是 172.16.8.0/21。', '快速判斷：網段的數量要是 2 的次方，而且起點要能被數量整除（8 個網段，起點 8 可以被 8 整除）。'],
      },
      {
        h: '最長前綴比對讓彙總與明細可以並存',
        p: ['彙總不會蓋掉更明確的路。同時送出彙總與其中一條明細（例如某個 /24 希望走另一條線），路由器會替那個 /24 選明細、其他的走彙總。BGP 做流量工程時常用這招：主線送彙總、備援線只送彙總；或把要特別處理的那一小塊另外送一條比較長的前綴。'],
        note: '位址規劃決定了能不能彙總。每個據點、每個區域拿一塊連續而且對齊邊界的位址，是在網路蓋之前就要決定的；事後才想彙總，通常只能重新編址。',
      },
    ],
  },
  {
    id: 'cef', t: 'CEF 與交換機制', en: 'Cisco Express Forwarding', cat: 'routing',
    keys: ['CEF', 'FIB', 'TCAM', 'adjacency', '程序交換'], tags: ['CEF', 'FIB', 'TCAM'],
    sum: '路由器不是每個封包都去查路由表。CEF 把路由表預先整理成 FIB 與 adjacency table，轉送時只要查表、改標頭；硬體交換器再把它們寫進 TCAM。',
    body: [
      '最早的做法是程序交換：每個封包都中斷 CPU，查完整的路由表、再查 ARP、重寫標頭。之後有快速交換：第一個封包照舊，結果存進快取，後面同一個目的地的封包直接用。CEF 則是在封包還沒來之前，就把整張路由表（包括遞迴查詢的結果）建成 FIB，下一站的第二層標頭建成 adjacency table。',
      '控制平面（路由協定、路由表）與資料平面（FIB、實際轉送）因此分開：路由協定慢慢算，轉送永遠只查已經準備好的表。這也是為什麼「show ip route 有路」不一定代表封包過得去，要再看 show ip cef。',
    ],
    fig: { type: 'table', head: ['表', '內容', '在硬體上'], rows: [['MAC 位址表', 'MAC ＋ VLAN → 埠', 'CAM（完全比對）'], ['FIB', '前綴 → 下一站', 'TCAM（可以比對「前綴＋遮罩」）'], ['ACL、QoS 分類', '多個欄位的條件', 'TCAM'], ['Adjacency', '下一站 → 重寫用的第二層標頭', '一般的記憶體']] },
    pit: ['TCAM 的容量是固定的。路由或 ACL 條目超過容量，多出來的部分會改由 CPU 處理，設備突然變得很慢，或新的條目根本裝不進去。', 'adjacency 是 incomplete 或 glean：路由器還不知道下一站的 MAC，封包要先交給 CPU 去送 ARP。', '有些功能會讓封包被「送上去」(punt) 給 CPU：帶 IP 選項的封包、TTL 到期、要回 ICMP 的、ACL 加了 log。這些流量一大，CPU 就滿載。'],
    cmd: [{ v: 'Cisco IOS', c: ['show ip cef 10.1.2.0 255.255.255.0 detail', 'show ip cef exact-route 10.0.0.5 10.1.2.9', 'show adjacency GigabitEthernet0/0/1 detail', 'show platform hardware fed switch active fwd-asic resource tcam utilization'] }],
    see: ['routing-table', 'ecmp', 'acl', 'mac-table'],
    deep: [
      {
        h: '負載分擔是怎麼決定的',
        p: ['路由表裡同一個目的地有好幾條等價的路時，CEF 預設用「每個目的地」(per-destination) 分擔：對來源與目的位址算雜湊，同一對位址永遠走同一條。這樣同一條連線的封包不會亂序，但流量不一定平均（一對大流量的主機會一直壓在同一條線上）。'],
        list: ['show ip cef exact-route <來源> <目的> 可以直接問「這一對位址會走哪一條」，排錯時比猜的準。', '路徑上連續好幾台路由器用同一種雜湊，會讓流量在每一層都往同一邊偏（CEF polarization）。解法是讓每一層用不同的雜湊演算法或種子。', '每個封包輪流（per-packet）分擔最平均，但會亂序，TCP 的效能反而變差，一般不用。'],
      },
      {
        h: 'SDM 範本：TCAM 怎麼分',
        p: ['Catalyst 交換器的 TCAM 要在路由、MAC、ACL、QoS 之間分配，由 SDM（Switch Database Management）範本決定。預設的範本比較平均；當核心用的交換器可能需要偏向路由的範本，接取層則偏向 MAC。換範本要重新開機才生效。看到 %…TCAM… 的紀錄或路由裝不進去，就該檢查使用率與範本。'],
      },
    ],
  },
  {
    id: 'copp', t: 'CoPP：保護控制平面', en: 'Control Plane Policing', cat: 'security',
    keys: ['CoPP', 'control-plane', 'Control Plane Policing'], tags: ['CoPP', 'control-plane'],
    sum: '送給路由器「自己」的封包（路由協定、SSH、SNMP、ping）都要 CPU 處理。CoPP 用 QoS 的語法替這些流量分類並限速，CPU 才不會被灌爆。',
    body: [
      '經過路由器的封包由轉送平面（硬體、CEF）處理，速度很快。但目的地是路由器本身的封包、以及需要特別處理的封包（TTL 到期、要回 ICMP、ARP）都要交給 CPU。CPU 的處理能力比轉送平面小好幾個數量級：有人對著路由器的位址灌封包，路由協定的 Hello 處理不到，鄰居就斷了，整個網路跟著震盪。',
      'CoPP 把往 CPU 的流量當成一個介面（control-plane），在上面套 service-policy：路由協定給足夠的額度、管理流量限制來源與速率、其他的大幅限速或丟棄。',
    ],
    pit: ['分類寫錯或額度太小，會把自己的路由協定也限掉。上線前先用只計數不丟棄的政策（conform 與 exceed 都是 transmit）觀察一陣子，再收緊。', '忘了放行 ARP、BFD、HSRP、DHCP 這些也要 CPU 處理的協定。', 'CoPP 管的是速率，不能取代 vty 的 access-class 或 SNMP 的 ACL：來源限制還是要做。'],
    cmd: [{ v: 'Cisco IOS', c: ['ip access-list extended COPP-ROUTING', ' permit ospf any any', ' permit tcp any any eq bgp', ' permit tcp any eq bgp any', 'ip access-list extended COPP-MGMT', ' permit tcp 10.0.99.0 0.0.0.255 any eq 22', ' permit udp 10.0.99.0 0.0.0.255 any eq snmp', 'class-map match-all COPP-ROUTING', ' match access-group name COPP-ROUTING', 'class-map match-all COPP-MGMT', ' match access-group name COPP-MGMT', 'policy-map COPP', ' class COPP-ROUTING', '  police 1000000 conform-action transmit exceed-action transmit', ' class COPP-MGMT', '  police 256000 conform-action transmit exceed-action drop', ' class class-default', '  police 64000 conform-action transmit exceed-action drop', 'control-plane', ' service-policy input COPP', 'show policy-map control-plane'] }],
    see: ['hardening', 'qos', 'acl', 'dos'],
    deep: [
      {
        h: '常見的分類方式',
        table: { head: ['類別', '內容', '處理'], rows: [['路由協定', 'OSPF、EIGRP、BGP、PIM、BFD', '不限速或給很高的額度'], ['管理', 'SSH、SNMP、NTP、TACACS+、RADIUS（限定來源）', '中等的額度'], ['一般回應', 'ICMP echo、traceroute', '限速（讓 ping 還能用，但灌不爆）'], ['不想要的', '分段的封包、不該出現的協定', '丟棄'], ['其他', '沒被分類到的', '很低的額度']] },
        p: ['CoPP 的 ACL 裡 permit 代表「屬於這一類」，不是「允許」。真正的動作在 police 的 conform-action 與 exceed-action。'],
      },
      {
        h: 'CoPP 與 CPPr',
        p: ['Control Plane Protection (CPPr) 把控制平面再細分成三個子介面：host（目的地是路由器自己的）、transit（要 CPU 幫忙轉送的）、cef-exception（ARP、非 IP 的封包），可以各自套政策，還可以直接丟掉往沒開的埠的封包。考試裡看到 control-plane host 就是它。'],
        note: '排錯的時候記得有 CoPP：ping 路由器會掉封包、SNMP 偶爾逾時，不一定是線路有問題，可能只是被限速了。show policy-map control-plane 的 exceeded 計數器會告訴你。',
      },
    ],
  },
  {
    id: 'urpf', t: 'uRPF：來源位址檢查', en: 'Unicast Reverse Path Forwarding', cat: 'security',
    keys: ['uRPF', 'ip verify unicast', '來源位址偽造'], tags: ['uRPF', '偽造'],
    sum: '路由器平常只看目的位址。uRPF 多做一件事：這個來源位址，照我的路由表應該從這個介面進來嗎？不是的話就丟掉，用來擋偽造來源的封包。',
    body: [
      '很多攻擊（反射放大、SYN flood）靠偽造來源位址，讓回應打到受害者，或讓人追查不到。在網路的邊緣確認「從這個介面進來的封包，來源位址真的屬於這個方向」，就能在源頭擋掉大部分偽造的流量（BCP 38）。',
    ],
    fig: { type: 'table', head: ['模式', '檢查的內容', '用在'], rows: [['嚴格 (strict)：rx', '往來源位址的最佳路徑，要從「封包進來的這個介面」出去', '接使用者、單一出口的客戶：路徑是對稱的地方'], ['寬鬆 (loose)：any', '路由表裡只要有往來源位址的路就好（不能只是預設路由）', '多線路、非對稱路由的地方；也用來配合黑洞路由'], ['加上 allow-default', '預設路由也算數', '只有預設路由的邊界']] },
    pit: ['嚴格模式遇到非對稱路由（去走 A 線、回走 B 線）會把正常的流量丟掉。多出口的邊界只能用寬鬆模式。', '只有一條預設路由的設備用寬鬆模式等於沒檢查（除非沒加 allow-default，那就全部丟掉）。', 'DHCP 的 DISCOVER（來源 0.0.0.0）會被嚴格模式擋掉，要用 ACL 例外。'],
    cmd: [{ v: 'Cisco IOS', c: ['interface GigabitEthernet0/0/1', ' ip verify unicast source reachable-via rx', '!', 'interface GigabitEthernet0/0/0', ' ip verify unicast source reachable-via any', '!', 'show ip interface GigabitEthernet0/0/1 | include verif', 'show ip traffic | include RPF'] }],
    see: ['acl', 'hardening', 'dos', 'cef', 'pim'],
    deep: [
      {
        h: '它和群播的 RPF 是同一個想法',
        p: ['PIM 的 RPF 檢查是「群播封包要從往來源的方向進來」，用來防迴圈。uRPF 把同樣的檢查用在單點傳送上，目的是防偽造。兩者都依賴 CEF 的 FIB：uRPF 要先開 ip cef。'],
      },
      {
        h: '遠端觸發的黑洞 (RTBH)',
        p: ['寬鬆模式的 uRPF 有一個聰明的用法。受到攻擊時，在一台觸發用的路由器上把攻擊「來源」的位址用 BGP 宣告出去，下一站設成一個指向 Null0 的位址。每一台邊界路由器學到之後，路由表裡往那個來源的路變成 Null0；寬鬆模式的 uRPF 一查，發現往來源的路是 Null0，就把它送來的封包丟掉。只要在一個地方下指令，全網的邊界同時生效。'],
        note: '考試常問「哪個模式適合多線路的邊界」：寬鬆。以及「uRPF 需要什麼」：CEF。',
      },
    ],
  },
  {
    id: 'ip-source-guard', t: 'IP Source Guard', en: 'IP Source Guard', cat: 'security',
    keys: ['IP Source Guard', 'source guard', 'ip verify source'], tags: ['IP Source Guard', 'DHCP Snooping'],
    sum: '在接取層的埠上，只放行「來源 IP（可以加上 MAC）和 DHCP snooping 繫結表一致」的封包。擋住自己亂設 IP、冒用別人位址的主機。',
    body: [
      'DHCP snooping 擋冒牌的伺服器，DAI 擋偽造的 ARP，IP Source Guard 補上最後一塊：主機用一個不是分配給它的來源 IP 送封包。它在每個不信任的埠上自動產生一條看不見的 ACL，只允許繫結表裡那個埠對應的 IP；主機還沒拿到位址之前，只放行 DHCP。',
    ],
    pit: ['固定 IP 的設備不在繫結表裡，會被全部擋掉：要用 ip source binding 手動加一筆。', '繫結表在交換器重開機後是空的，沒有把它存起來的話，所有主機都要重新取得位址才通。', '下面還接著交換器或 AP 的埠（一個埠很多台主機）要小心：每一台都要有繫結。'],
    cmd: [{ v: 'Cisco IOS', c: ['ip dhcp snooping', 'ip dhcp snooping vlan 10', 'interface GigabitEthernet0/3', ' ip verify source port-security', '!', 'ip source binding 0011.2233.4455 vlan 10 192.168.10.50 interface GigabitEthernet0/5', '!', 'show ip verify source', 'show ip source binding'] }],
    see: ['dhcp-snooping', 'dai', 'port-security', 'l2-attacks', 'urpf'],
    deep: [
      {
        h: '第二層的三道防線',
        table: { head: ['功能', '擋什麼', '依據'], rows: [['DHCP snooping', '冒牌的 DHCP 伺服器、把位址池要光', '信任 / 不信任的埠'], ['Dynamic ARP Inspection', '偽造的 ARP（中間人）', 'snooping 的繫結表'], ['IP Source Guard', '冒用來源 IP 的資料封包', 'snooping 的繫結表'], ['Port Security', '太多或不認識的 MAC', '每個埠允許的 MAC']] },
        p: ['三個功能環環相扣：先有 DHCP snooping 的繫結表，後面兩個才有東西可以比對。上線的順序也照這個來，而且每一步都要先確認固定 IP 的設備有手動的繫結。'],
      },
    ],
  },
  {
    id: 'ipv6-fhs', t: 'IPv6 第一跳安全', en: 'IPv6 First Hop Security', cat: 'ipv6',
    keys: ['first hop security', 'ND inspection', 'DHCPv6 Guard', 'IPv6 Source Guard', 'IPv6 snooping'], tags: ['RA Guard', 'DHCPv6', 'ND'],
    sum: 'IPv6 把 ARP、路由器探索、位址設定都交給 ICMPv6 的鄰居探索，而它預設完全沒有驗證。第一跳安全是交換器上一組對應 IPv4 那些保護的功能。',
    body: [
      'IPv4 的 DHCP snooping、DAI、IP Source Guard 在 IPv6 都有對應的版本。差別是 IPv6 多了一個攻擊面：任何主機送出 Router Advertisement，同網段的主機就會把它當成預設閘道、照它的前綴產生位址。就算公司沒有規劃 IPv6，主機的 IPv6 預設是開的，冒牌的 RA 一樣有效。',
    ],
    fig: { type: 'table', head: ['功能', '擋什麼', 'IPv4 對應的'], rows: [['RA Guard', '不該出現的 Router Advertisement', '（沒有：IPv4 的閘道是手動或 DHCP 給的）'], ['DHCPv6 Guard', '冒牌的 DHCPv6 伺服器', 'DHCP snooping'], ['IPv6 snooping / binding table', '學習「位址、MAC、埠」的對應', 'snooping 的繫結表'], ['ND inspection', '偽造的鄰居通告（NA）', 'Dynamic ARP Inspection'], ['IPv6 Source Guard', '冒用來源位址', 'IP Source Guard']] },
    pit: ['只做了 IPv4 的保護就以為安全。雙協定的網路兩邊都要做。', 'RA Guard 的政策要分清楚哪些埠是「接路由器的」（device-role router），其他一律當主機。', '把 RA 藏在延伸標頭或分段裡可以繞過舊版的 RA Guard，交換器要能丟掉這種封包。'],
    cmd: [{ v: 'Cisco IOS', c: ['ipv6 nd raguard policy HOSTS', ' device-role host', 'ipv6 dhcp guard policy CLIENTS', ' device-role client', 'ipv6 snooping policy SNOOP', '!', 'interface range GigabitEthernet0/1 - 8', ' ipv6 nd raguard attach-policy HOSTS', ' ipv6 dhcp guard attach-policy CLIENTS', ' ipv6 snooping attach-policy SNOOP', '!', 'show ipv6 neighbors binding'] }],
    see: ['ra-guard', 'ndp', 'slaac', 'dhcpv6', 'dhcp-snooping', 'dai'],
    deep: [
      {
        h: '鄰居探索的五種訊息',
        table: { head: ['訊息', 'ICMPv6 類型', '作用'], rows: [['Router Solicitation (RS)', '133', '主機問「有路由器嗎」'], ['Router Advertisement (RA)', '134', '路由器宣告前綴、旗標、自己是閘道'], ['Neighbor Solicitation (NS)', '135', '問「這個位址的 MAC 是誰」；也用來偵測位址重複 (DAD)'], ['Neighbor Advertisement (NA)', '136', '回答 NS'], ['Redirect', '137', '告訴主機有更好的下一站']] },
        p: ['這些訊息都用群播、都沒有驗證。偽造 RA 可以把自己變成閘道；偽造 NA 可以冒充任何位址（等同 ARP 欺騙）；對每一個 DAD 都回答「這個位址有人用了」，可以讓新的主機永遠拿不到位址。'],
        note: 'IPv6 的 ACL 最後有兩條看不見的 permit（放行 NS 與 NA），再來才是隱含的 deny。自己手動加一條 deny ipv6 any any 的話，要記得先把鄰居探索放行，不然連 ping 同網段都不通。',
      },
    ],
  },
  {
    id: 'macsec', t: 'MACsec 與 TrustSec', en: 'IEEE 802.1AE / Cisco TrustSec', cat: 'security',
    keys: ['MACsec', '802.1AE', 'TrustSec', 'SGT'], tags: ['MACsec', 'TrustSec', 'SGT'],
    sum: 'MACsec 在第二層逐段加密乙太網路訊框；TrustSec 用安全群組標籤 (SGT) 代表「這是誰的流量」，政策只寫群組對群組，不再寫 IP 位址。',
    body: [
      'MACsec（802.1AE）在兩個直接相連的設備之間加密並驗證每一個訊框：主機到交換器、交換器到交換器。它是逐段的：每一台交換器收到之後解密、處理、再加密送往下一段。金鑰由 MKA 協定協商，通常接在 802.1X 驗證之後。它保護的是「線路被搭線監聽」，和 IPsec 的端到端加密互補。',
      'TrustSec 解決的是另一個問題：ACL 用 IP 位址寫，使用者換個位置、換個 VLAN 規則就要改。TrustSec 在使用者通過驗證時由伺服器指派一個群組標籤（例如「財務」= 10），標籤跟著訊框走（或用 SXP 另外傳），出口的設備只看「來源群組對目的群組」的矩陣 (SGACL) 決定放不放行。',
    ],
    pit: ['MACsec 兩端的硬體都要支援，而且會增加 32 個位元組的負擔，要注意 MTU。', '中間隔著不支援 SGT 的設備時標籤會掉：要用 SXP 把「IP 對群組」的對應另外送過去。'],
    cmd: [{ v: 'Cisco IOS XE', c: ['interface GigabitEthernet1/0/24', ' macsec network-link', ' mka policy MKA-POL', ' mka pre-shared-key key-chain MKA-KEYS', '!', 'cts role-based enforcement', 'show macsec summary', 'show cts role-based permissions'] }],
    see: ['dot1x', 'ipsec', 'sd-access', 'zero-trust'],
    deep: [
      {
        h: '三個階段：分類、傳遞、執行',
        list: ['分類：流量進入網路的地方決定它的 SGT —— 802.1X / MAB 驗證後由 RADIUS 動態指派，或依 VLAN、埠、IP 子網路靜態對應。', '傳遞：行內標記（在訊框裡多一個 CMD 欄位，逐段帶著走）或 SXP（用 TCP 把「IP → SGT」的表送給不支援行內標記的設備）。', '執行：在靠近目的地的設備上，用 SGACL 或防火牆的規則比對來源 SGT 與目的 SGT。'],
        note: '這是 SD-Access 做微分段的基礎：fabric 裡的 VXLAN 標頭直接帶著 SGT。',
      },
    ],
  },
  {
    id: 'sd-access', t: 'SD-Access 與 LISP', en: 'Software-Defined Access', cat: 'cloud',
    keys: ['SD-Access', 'LISP', 'fabric'], tags: ['SD-Access', 'LISP', 'VXLAN', 'Catalyst Center'],
    sum: '把園區網路做成一張 fabric：底層只負責 IP 可達，上層用 LISP 找「主機在哪台交換器」、用 VXLAN 載流量、用 SGT 做分段，全部由控制器 (Catalyst Center) 自動設定。',
    body: [
      '傳統的園區靠 VLAN 與生成樹延伸第二層，使用者移動、分段、跨樓層都很麻煩。SD-Access 把它拆成兩層：underlay 是單純的路由網路（每條線都是第三層，不需要生成樹）；overlay 才是使用者看到的網路，用通道疊在上面。主機接在哪裡、屬於哪個虛擬網路，都由控制平面記錄與查詢。',
    ],
    fig: { type: 'table', head: ['平面', '用什麼', '做什麼'], rows: [['控制平面', 'LISP', '記錄每個端點（EID）目前在哪台邊緣交換器（RLOC）後面'], ['資料平面', 'VXLAN', '把原本的訊框包起來，標頭帶著虛擬網路 (VNI) 與群組 (SGT)'], ['政策平面', 'TrustSec (SGT)', '群組對群組的存取矩陣'], ['管理平面', 'Catalyst Center', '設計、佈建、政策、Assurance']] },
    pit: ['underlay 的 MTU 要調大（VXLAN 多 50 個位元組），而且每一段都要一致。', 'fabric 之外的網路要經過 border node 才進得來；border 與外面交換路由通常用 BGP。', 'SD-Access 不是把設備買來就會動：位址規劃、身分來源（ISE）、底層的路由設計都要先做好。'],
    see: ['vxlan', 'macsec', 'dot1x', 'sdn', 'sdwan'],
    deep: [
      {
        h: 'fabric 裡的角色',
        table: { head: ['角色', '做什麼'], rows: [['Control plane node', 'LISP 的 Map Server / Map Resolver：端點位置的資料庫'], ['Edge node', '使用者接的交換器：驗證、指派 VN 與 SGT、向控制平面註冊端點、封裝與解封裝 VXLAN'], ['Border node', 'fabric 與外部網路（資料中心、網際網路、其他據點）的出入口'], ['Intermediate node', '只在 underlay 裡轉送 IP，完全不知道 overlay'], ['Fabric WLC / AP', '無線的控制平面整合進 fabric：AP 直接把流量封裝成 VXLAN 交給 edge']] },
      },
      {
        h: 'LISP：把「是誰」和「在哪裡」分開',
        p: ['傳統的 IP 位址同時代表身分與位置，主機一移動位址就要換。LISP 把它們拆開：EID 是端點的位址（不變），RLOC 是它目前所在的那台設備的位址。封包要送給某個 EID 時，入口的設備向 Map Resolver 查詢對應的 RLOC，再把封包封裝之後送過去，查到的結果會快取起來。主機移動時，新的邊緣交換器向 Map Server 重新註冊，其他人的快取隨之更新。'],
        list: ['好處：每台交換器不需要知道所有主機的路由，只在有流量時查詢，表可以很小。', '虛擬網路 (VN) 對應到 VRF：不同 VN 之間預設不通，要經過 border 或防火牆。', '同一個 VN 裡的微分段靠 SGT，不需要再切更多的 VLAN 與子網路。'],
        note: 'ENCOR 對 SD-Access 與 SD-WAN 的要求是「說明運作原理」：分得清楚四個平面各用什麼協定、每個角色做什麼、underlay 與 overlay 的差別，就掌握了八成。',
      },
    ],
  },
  {
    id: 'eem', t: 'EEM：設備上的自動化', en: 'Embedded Event Manager', cat: 'ops',
    keys: ['EEM', 'event manager', 'applet'], tags: ['EEM', '自動化'],
    sum: '在路由器或交換器上寫「發生某件事 → 自動執行幾個指令」的小程式。不需要外部的伺服器，適合蒐集故障當下的資料、或做簡單的自動修復。',
    body: [
      '一個 applet 有兩部分：事件 (event) 定義什麼時候觸發，動作 (action) 定義要做什麼。事件可以是一行 syslog 訊息、某個指令被執行、計時器、追蹤物件的狀態改變、介面計數器超過門檻、SNMP 的值。動作可以是執行 CLI 指令、寫一筆 syslog、寄信、重新載入。',
      '最實用的場景是「偶發的問題」：鄰居半夜斷了五秒，等人上線時什麼都看不到。用 EEM 在那一行 syslog 出現時自動把 show 指令的輸出存到 flash，隔天就有現場的資料。',
    ],
    pit: ['動作裡要執行 CLI，第一步要先 action … cli command "enable"；applet 是以沒有特權的身分開始的。', '有 AAA 指令授權的設備，要替 applet 指定一個使用者（event manager session cli username），不然指令會被拒絕。', '事件與動作形成迴圈：applet 改了設定又觸發自己。用 maxrun、ratelimit 限制。', '自動「修復」要保守：把問題蓋掉之前，先確定有留下紀錄。'],
    cmd: [{ v: 'Cisco IOS', c: ['event manager applet OSPF-DOWN', ' event syslog pattern "OSPF-5-ADJCHG.*FULL to DOWN"', ' action 1.0 cli command "enable"', ' action 2.0 cli command "show ip ospf neighbor | append flash:ospf-down.txt"', ' action 3.0 cli command "show interfaces | append flash:ospf-down.txt"', ' action 4.0 syslog msg "EEM: OSPF neighbor down, data saved to flash"', '!', 'event manager applet NO-SHUT-UPLINK', ' event cli pattern "shutdown" sync no skip yes', ' action 1.0 syslog msg "shutdown is blocked by policy"', '!', 'show event manager policy registered', 'show event manager history events'] }],
    see: ['ansible', 'config-mgmt', 'syslog', 'ip-sla', 'troubleshooting'],
    deep: [
      {
        h: '常用的事件偵測器',
        table: { head: ['事件', '觸發的條件', '例子'], rows: [['syslog', '出現符合樣式的紀錄', '介面 down、鄰居斷線'], ['cli', '有人輸入符合樣式的指令', '記錄或擋下危險的指令'], ['timer', '定時（cron、每隔幾秒、倒數）', '每天半夜備份設定'], ['track', '追蹤物件 up / down', 'IP SLA 失敗時切換設定'], ['interface', '介面計數器超過門檻', 'CRC 錯誤暴增時通知'], ['none', '手動執行（event manager run）', '把一串指令包成一個動作']] },
      },
      {
        h: 'EEM 與外部自動化的分工',
        p: ['EEM 跑在設備上，設備和管理系統斷線時還能動，反應也最快，但每台設備各自為政，邏輯一複雜就難維護。Ansible、Python 腳本、控制器從外面管理一整批設備，適合有流程、要版本控制的變更。兩者是互補的：EEM 負責「當下、在地」的反應與蒐證，外部工具負責「整批、可重複」的佈建。'],
        note: 'ENCOR 要求會寫出一個 EEM applet：記住 event → action 的結構、action 的編號是照字串排序的（1.0、2.0…）、執行 CLI 之前要先 enable。',
      },
    ],
  },
  {
    id: 'data-formats', t: 'JSON、XML、YAML 與 REST', en: 'Data Encoding & REST APIs', cat: 'cloud',
    keys: ['YAML', 'XML', 'HTTP 狀態碼', '資料格式'], tags: ['JSON', 'YAML', 'XML', 'REST'],
    sum: '機器之間交換設定與狀態用的三種文字格式，以及 REST API 的動詞與狀態碼。看得懂格式、看得懂回應碼，是自動化的第一步。',
    body: [
      'CLI 的輸出是給人看的，程式要靠切字串去猜，版本一換就壞。API 回傳結構化的資料：每個值有名字、有型別、有層次，程式直接拿來用。三種格式表達的是同樣的東西（物件、清單、字串、數字），只是寫法不同。',
    ],
    fig: { type: 'table', head: ['', 'JSON', 'XML', 'YAML'], rows: [['長相', '{ "name": "Gi0/1", "enabled": true }', '<name>Gi0/1</name><enabled>true</enabled>', 'name: Gi0/1（下一行）enabled: true'], ['清單', '[ 1, 2, 3 ]', '重複的標籤', '每行一個「- 」'], ['註解', '沒有', '<!-- -->', '#'], ['常見的用途', 'REST API、RESTCONF', 'NETCONF', 'Ansible、設定檔'], ['要注意', '鍵要用雙引號、最後一項後面不能有逗號', '標籤要成對、有命名空間', '縮排就是結構，只能用空白不能用 Tab']] },
    pit: ['JSON 裡 true / false / null 是小寫而且不加引號；加了引號就是字串。', 'YAML 的縮排錯一格，結構就完全不同，而且不一定會報錯。', '把 401 與 403 搞混：401 是「你是誰我不知道」（沒有或錯的憑證），403 是「我知道你是誰，但你不准」。'],
    cmd: [{ v: 'curl', c: ['curl -k -u admin:Passw0rd -H "Accept: application/yang-data+json" \\', '  https://10.0.99.1/restconf/data/ietf-interfaces:interfaces', '', 'curl -k -u admin:Passw0rd -X PATCH -H "Content-Type: application/yang-data+json" \\', '  -d \'{"ietf-interfaces:interface":{"name":"Loopback10","description":"via API"}}\' \\', '  https://10.0.99.1/restconf/data/ietf-interfaces:interfaces/interface=Loopback10'] }],
    see: ['restconf', 'netconf', 'ansible', 'python-net', 'sdn'],
    deep: [
      {
        h: 'REST 的動詞',
        table: { head: ['動詞', '意思', '重複執行會怎樣'], rows: [['GET', '讀取', '結果一樣（安全）'], ['POST', '建立一個新的資源', '可能建立好幾個'], ['PUT', '整個取代（沒有就建立）', '結果一樣（冪等）'], ['PATCH', '只改指定的欄位', '通常一樣'], ['DELETE', '刪除', '結果一樣']] },
      },
      {
        h: '狀態碼',
        table: { head: ['範圍', '意思', '常見的'], rows: [['2xx', '成功', '200 OK、201 Created（建立了）、204 No Content（成功，沒有內容要回）'], ['3xx', '轉址', '301、302、304'], ['4xx', '用戶端的問題', '400 格式錯誤、401 未驗證、403 禁止、404 找不到、405 不支援這個動詞、409 衝突、429 太頻繁'], ['5xx', '伺服器的問題', '500 內部錯誤、503 暫時無法服務']] },
        list: ['4xx 要修的是自己送出去的東西（網址、內容、憑證）；5xx 是對方的問題，重試可能有用。', 'API 的安全：一律用 HTTPS；驗證用權杖 (token) 而不是每次都送帳號密碼；權杖要有期限與最小的權限；速率限制防止被濫用。'],
      },
      {
        h: 'YANG：資料長什麼樣子的規格',
        p: ['JSON 與 XML 只是寫法。「介面底下有哪些欄位、哪個是必填、型別是什麼」由 YANG 模型定義。RESTCONF 的網址路徑與 NETCONF 的 XML 結構，都是照著 YANG 模型長出來的。模型有標準的（IETF、OpenConfig：跨廠牌）與廠商自己的（Cisco-IOS-XE-native：功能最完整）。'],
        note: '考試會給一段 JSON 或 Python 的字典，問某個值要怎麼取出來。把它想成路徑：外層是物件就用鍵、是清單就用索引，一層一層走。',
      },
    ],
  },
  {
    id: 'python-net', t: 'Python 與網路自動化', en: 'Python for Network Automation', cat: 'cloud',
    keys: ['Python', 'Netmiko', 'NAPALM', 'requests'], tags: ['Python', '自動化'],
    sum: '網路自動化最常用的語言。會讀懂一段腳本在做什麼（迴圈、字典、呼叫 API、處理回應），就能應付考試，也能開始把重複的工作交給程式。',
    body: [
      '不需要成為軟體工程師。網路工程師用到的 Python 很集中：資料結構（清單、字典）、迴圈與條件、讀寫檔案、呼叫函式庫。真正做事的是函式庫：Netmiko（用 SSH 對設備下指令）、NAPALM（跨廠牌的統一介面）、requests（呼叫 REST API）、ncclient（NETCONF）、Jinja2（用範本產生設定）。',
    ],
    fig: { type: 'table', head: ['資料型別', '寫法', '怎麼取值'], rows: [['清單 list', "['Gi0/1', 'Gi0/2']", "ports[0] → 'Gi0/1'"], ['字典 dict', "{'name': 'R1', 'asn': 65010}", "dev['asn'] → 65010"], ['巢狀', "{'ifs': [{'name': 'Gi0/1', 'up': True}]}", "data['ifs'][0]['name']"], ['字串', "'10.0.0.1'", "ip.split('.') → ['10', '0', '0', '1']"]] },
    pit: ['縮排就是語法：同一個區塊要用一樣的縮排。', 'API 回來的 JSON 經過 response.json() 才變成字典；直接當字串處理就錯了。', '把密碼寫死在腳本裡。用環境變數、金鑰管理工具，或執行時輸入。', '沒有錯誤處理：一百台設備裡有一台連不上，整個腳本就停了。'],
    cmd: [{ v: 'Python', c: ['import requests', '', 'url = "https://10.0.99.1/restconf/data/ietf-interfaces:interfaces"', 'headers = {"Accept": "application/yang-data+json"}', 'resp = requests.get(url, auth=("admin", "Passw0rd"), headers=headers, verify=False)', '', 'if resp.status_code == 200:', '    for intf in resp.json()["ietf-interfaces:interfaces"]["interface"]:', '        print(intf["name"], intf.get("enabled"))', 'else:', '    print("failed:", resp.status_code)'] }],
    see: ['data-formats', 'restconf', 'netconf', 'ansible', 'eem'],
    deep: [
      {
        h: '三種連到設備的方式',
        table: { head: ['方式', '函式庫', '拿到的是', '適合'], rows: [['SSH ＋ CLI', 'Netmiko、Paramiko', '文字（要自己解析，或用 TextFSM / Genie）', '什麼設備都能用；舊設備'], ['NETCONF', 'ncclient', 'XML，照 YANG 模型', '有交易、可以先驗證再提交'], ['RESTCONF / REST', 'requests', 'JSON', '簡單、好除錯；控制器的 API']] },
      },
      {
        h: '工具怎麼選',
        table: { head: ['工具', '需要在設備上裝代理程式嗎', '語言 / 寫法', '模式'], rows: [['Ansible', '不用（SSH / API）', 'YAML 的 playbook', '推送'], ['Terraform', '不用（API）', 'HCL，宣告想要的狀態', '推送，會記住狀態'], ['Puppet', '要', '自己的宣告式語言', '代理程式定期來拉'], ['Chef', '要', 'Ruby', '代理程式定期來拉'], ['SaltStack', '兩種都可以', 'YAML', '推送，事件驅動']] },
        p: ['網路設備大多不能裝代理程式，所以 Ansible 這種無代理的工具最普遍。重點不在工具，而在觀念：設定放進版本控制、變更先在測試環境驗證、同一份 playbook 重複執行結果要一樣（冪等）、執行前先看差異（check mode）。'],
        note: '考試不會要你從零寫程式，而是給一段腳本問輸出是什麼、或哪一行有錯。平常多讀幾段、自己改一兩個地方跑跑看，比背語法有用。',
      },
    ],
  },
  {
    id: 'lab-strategy', t: '實作考試的作戰方式', en: 'Hands-on Lab Strategy', cat: 'ops',
    keys: ['實作考試', 'CCIE', '工單', '總驗收'], tags: ['故障排除', '工單', 'CCIE'],
    sum: '大型的實作題（CCIE、公司的驗收、真實的事故）考的不只是技術，還有方法：先讀完、分清楚相依關係、每一步都驗證、不要弄壞已經好的東西。',
    body: [
      '實作考試與真實事故有一個共同點：問題不只一個，而且會互相遮蔽。底層沒通的時候，上層所有的症狀都長得一樣。從第一題開始悶著頭做，常常修了半天才發現真正的原因在另一題。',
      '先花時間讀完所有的題目與限制，把拓撲在腦中（或紙上）走一遍；再用幾個指令掃過每一台設備，把「應該有卻沒有」的鄰居與路由列出來。之後才決定先做哪一題。',
    ],
    steps: { t: '每一張工單的固定流程', items: ['讀題：要達成什麼、不能動什麼（限制往往比要求更重要）。', '確認現況：症狀是什麼、哪一層開始不對。由下往上：實體 → 第二層 → 位址 → 路由 → 政策 → 應用。', '提出一個假設，用一個指令驗證它，而不是一次改三個地方。', '修改之前記下原本的設定；改完立刻驗證這一題。', '回頭確認前面做完的題目沒有被這次的修改弄壞。', '把做了什麼、為什麼記下來。'] },
    pit: ['沒看限制就動手：用靜態路由把問題繞過去、動了題目說不能動的設備，整題零分。', '一次改很多地方：通了也不知道是哪一個生效，壞了也不知道是哪一個造成的。', '修好一題就往下走，沒有回頭驗證。大型拓撲裡改一個 route-map 影響的可能是三個地方。', '卡在一題太久。先跳過、把會的拿到，最後再回來。', '忘了存檔。'],
    cmd: [{ v: '開場先掃一遍', c: ['show ip interface brief', 'show cdp neighbors', 'show ip ospf neighbor', 'show ip eigrp neighbors', 'show ip bgp summary', 'show ip route summary', 'show dmvpn', 'show standby brief', 'show spanning-tree summary', 'show interfaces trunk', 'show etherchannel summary'] }],
    see: ['troubleshooting', 'net-design', 'config-mgmt', 'redistribution', 'bgp'],
    deep: [
      {
        h: '相依關係：先修哪一個',
        list: ['底層先於上層：IGP 沒好，iBGP、LDP、通道都不會好。不要在 BGP 的題目上浪費時間，如果 Loopback 根本互相 ping 不到。', '控制平面先於資料平面：鄰居沒起來、路由沒學到，就先不要看 ACL 與 NAT。', '去與回是兩條路：去的方向通了，回程還要再查一次。', '有些工單要等前一張修好才看得到真正的症狀。修完一張之後，重新看一次其他工單的現況。'],
      },
      {
        h: '用差異找問題',
        p: ['大型拓撲裡，設備通常是成對或成組的（兩台核心、好幾家分公司）。正常的那一台就是最好的參考答案：把同一個指令在好的與壞的設備上各跑一次，比較輸出。設定也一樣：show running-config | section ospf 兩台對照，不一樣的那一行往往就是答案。'],
        list: ['比鄰居：一台有三個 OSPF 鄰居、另一台只有兩個。', '比路由：同一個前綴，一台是 O、另一台是 O E2。', '比計數器：ACL 的命中數、介面的錯誤、NAT 的對應數。', '比時間：show logging 裡問題開始的時間點前後發生了什麼。'],
      },
      {
        h: '時間的分配',
        list: ['開頭 10% 的時間讀題、看拓撲、掃現況。這段時間不打任何設定。', '先做獨立而且確定會的題目，建立進度。', '每一題設一個上限，超過就記下目前的發現、先換下一題。', '最後留 10% 的時間整份重新驗證一次，並存檔。'],
        note: '這個遊戲第 20 章的題目就是照這個方式設計的：好幾張工單、有的互相遮蔽、有全域的限制。卡住的時候回來看這一篇，比多背幾個指令有用。',
      },
    ],
  },
];
