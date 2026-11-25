// 知識庫「深入了解」：交換與 VLAN（格式見 deep-routing.js）

export const DEEP_SWITCHING = {
  vlan: [
    {
      h: 'VLAN 的編號與存放的地方',
      table: {
        head: ['範圍', '用途', '備註'],
        rows: [['1', '預設 VLAN，刪不掉', '所有的埠出廠都在這裡；CDP、VTP、DTP 這些控制訊框也走它'], ['2 – 1001', '一般範圍', '存在 vlan.dat（flash 裡），不在 running-config'], ['1002 – 1005', '保留給 FDDI / Token Ring', '刪不掉、也不能用'], ['1006 – 4094', '延伸範圍', 'VTP 要是 transparent 或版本 3 才能建']],
      },
      p: ['「設定都清掉了，VLAN 還在」是因為 VLAN 存在 vlan.dat，不是 startup-config。要完全還原一台交換器，除了 write erase 還要 delete flash:vlan.dat 再重開機。反過來，換一台新交換器只貼 running-config，VLAN 不會跟著過去（VTP transparent 模式例外，它會把 VLAN 寫進 running-config）。'],
    },
    {
      h: '設計上的原則',
      list: [
        '一個 VLAN 對應一個 IP 子網路。同一個 VLAN 裡放兩個子網路、或一個子網路跨兩個 VLAN，排錯會非常痛苦。',
        '廣播網域不要太大：一個 VLAN 幾百台主機是常見的上限，再大就該切開。廣播與未知單點傳送的洪泛會打到每一台。',
        'VLAN 1 不放使用者，也不拿來管理：它是所有新設備的預設值，最容易被誤接。沒在用的埠放進一個沒有路由的「停車場」VLAN 並 shutdown。',
        'VLAN 盡量不要橫跨整棟大樓。每個樓層或每個機櫃自己的 VLAN、在分配層就做第三層路由，生成樹的範圍小、故障的影響範圍也小。',
      ],
    },
    {
      h: '埠的幾種模式',
      table: { head: ['模式', '訊框的標籤', '用在'], rows: [['access', '不帶標籤，屬於一個 VLAN', '接電腦、印表機'], ['access ＋ voice VLAN', '電腦不帶標籤，電話帶語音 VLAN 的標籤', '電話後面再接電腦'], ['trunk', '每個 VLAN 帶自己的 802.1Q 標籤（native VLAN 除外）', '交換器之間、接虛擬化主機、AP'], ['routed (no switchport)', '沒有 VLAN，就是一個第三層介面', 'L3 交換器之間的互連']] },
      note: '排錯時先分清楚「VLAN 存不存在」與「埠在不在那個 VLAN」。把埠指定到一個還沒建立的 VLAN，新的 IOS 會自動建立；但 VLAN 被刪掉之後，原本在裡面的埠會變成 inactive，show vlan brief 裡找不到它們。',
    },
  ],

  trunk: [
    {
      h: '802.1Q 標籤長什麼樣子',
      p: ['Trunk 在來源 MAC 與 EtherType 之間插入 4 個位元組的標籤：TPID（0x8100，表示「這是 802.1Q」）、3 個位元的優先權 (PCP / CoS，第二層的 QoS 就標在這裡)、1 個位元的 DEI、12 個位元的 VLAN ID（所以 VLAN 最多 4094 個）。因為多了 4 個位元組，訊框最大可以到 1522；插入標籤之後 FCS 要重算。'],
    },
    {
      h: 'Native VLAN',
      p: [
        'Trunk 上有一個 VLAN 的訊框不帶標籤，就是 native VLAN（預設 1）。收到不帶標籤的訊框時，交換器把它當成 native VLAN 的。兩端的 native VLAN 要設成一樣。',
        '不一樣的話，A 端 VLAN 10 的訊框不帶標籤送出去，B 端收到後歸到自己的 native VLAN 99：兩個 VLAN 的流量就混在一起了。CDP 會發現並印出 native VLAN mismatch 的訊息，生成樹也可能把埠擋掉 (PVID inconsistent)。',
        'native VLAN 也是 VLAN hopping（雙重標籤攻擊）的入口：把 native VLAN 改成一個沒有人用的 VLAN、不要用 VLAN 1，並且不要把使用者放在和 native VLAN 一樣的 VLAN。',
      ],
    },
    {
      h: 'DTP：會不會自己變成 Trunk',
      table: {
        head: ['', '對面 access', '對面 trunk', '對面 dynamic auto', '對面 dynamic desirable'],
        rows: [['access', 'access', '不一致', 'access', 'access'], ['trunk', '不一致', 'trunk', 'trunk', 'trunk'], ['dynamic auto', 'access', 'trunk', 'access', 'trunk'], ['dynamic desirable', 'access', 'trunk', 'trunk', 'trunk']],
      },
      list: [
        '兩端都是 dynamic auto（很多舊機種的預設值）不會變成 Trunk：兩邊都在等對方先開口。',
        '正式環境不要靠協商：交換器之間寫死 switchport mode trunk 加上 switchport nonegotiate，接使用者的埠寫死 switchport mode access。留著 dynamic 的埠，等於讓任何人接上一台會說 DTP 的設備就拿到所有的 VLAN。',
        'DTP 要兩端的 VTP 網域名稱一樣（或其中一端是空的）才協商得起來。',
      ],
    },
    {
      h: '允許的 VLAN 清單',
      list: [
        'switchport trunk allowed vlan 10,20 會「取代」整份清單。要多加一個 VLAN 一定要寫 add：switchport trunk allowed vlan add 30。少打一個 add，其他 VLAN 全部斷線，是最經典的操作事故。',
        '兩端的清單要一致。只在一端允許的 VLAN 不會通，而且沒有任何錯誤訊息。',
        '把不需要的 VLAN 從 Trunk 上拿掉（手動修剪），可以縮小廣播與生成樹的範圍。',
      ],
      code: { v: 'Cisco IOS', c: ['interface GigabitEthernet1/0/24', ' switchport mode trunk', ' switchport nonegotiate', ' switchport trunk native vlan 999', ' switchport trunk allowed vlan 10,20,30', '!', 'show interfaces trunk', 'show interfaces GigabitEthernet1/0/24 switchport'] },
      note: 'show interfaces trunk 有四段，由上到下越來越嚴格：是不是 Trunk → 允許哪些 VLAN → 其中哪些 VLAN 存在而且是 active → 其中哪些在生成樹是 forwarding 而且沒被修剪。某個 VLAN 不通，就看它在哪一段消失。',
    },
  ],

  stp: [
    {
      h: '三個選舉',
      p: ['生成樹用 BPDU 交換資訊。每台交換器有一個 Bridge ID：優先權（4096 的倍數，預設 32768）加上 VLAN 編號（extended system ID），再加上 MAC 位址。所有的比較都是「小的贏」。'],
      list: [
        '① 選根橋：整個網路 Bridge ID 最小的那一台。沒有人調過優先權的話，就是 MAC 最小的 —— 通常是最舊的那一台。',
        '② 每台非根橋選一個根埠 (root port)：往根橋的路徑成本最小的埠。一樣的話比上游交換器的 Bridge ID，再一樣比上游的埠 ID。',
        '③ 每一段線選一個指定埠 (designated port)：這一段上離根橋最近的那一端。根橋自己的埠全部是指定埠。',
        '既不是根埠、也不是指定埠的埠被擋住 (alternate / blocking)，迴圈就在那裡被切斷。',
      ],
      table: { head: ['速率', '短路徑成本（預設）', '長路徑成本'], rows: [['10 Mbps', '100', '2,000,000'], ['100 Mbps', '19', '200,000'], ['1 Gbps', '4', '20,000'], ['10 Gbps', '2', '2,000'], ['100 Gbps', '1', '200']] },
    },
    {
      h: '802.1D 為什麼慢，RSTP 為什麼快',
      p: [
        '原本的 802.1D 靠計時器：一個埠要從 Blocking 經過 Listening（15 秒）、Learning（15 秒）才到 Forwarding；上游斷掉還要先等 Max Age（20 秒）才承認。一次變動要 30 到 50 秒。',
        'RSTP (802.1w) 不等計時器，改用握手：點對點的線路上，新的指定埠向對面提出 Proposal，對面先把自己其他的埠擋住（確保不會有迴圈）再回 Agreement，這個埠就立刻開始轉送，然後一層一層往下。整個過程在一秒內完成。另外，被擋住的 alternate 埠早就知道「根埠壞了我可以頂上」，根埠一斷馬上接手。',
      ],
      table: { head: ['', '802.1D', 'RSTP'], rows: [['埠的狀態', 'Blocking、Listening、Learning、Forwarding', 'Discarding、Learning、Forwarding'], ['埠的角色', '根埠、指定埠、被擋的', '根埠、指定埠、Alternate、Backup，另外有 Edge'], ['收斂', '30 – 50 秒', '點對點線路上不到一秒'], ['BPDU', '只有根橋產生，其他的轉送', '每一台每 2 秒自己送，3 個沒收到就當鄰居不見了'], ['拓撲變更', '通知根橋，MAC 位址表的老化時間縮短成 15 秒', '直接洪泛，立刻清掉 MAC 位址表']] },
      list: ['RSTP 的快速握手只在點對點（全雙工）的線路上有效。半雙工的埠被當成 shared，退回用計時器。', '接終端設備的埠要設成 Edge（PortFast）：一接上就轉送，而且它上下線不會觸發拓撲變更。沒有設的話，每次有人開關電腦，整個 VLAN 的 MAC 位址表都被清一次。'],
    },
    {
      h: '根橋要放在哪裡',
      list: [
        '根橋是所有流量匯集的方向，應該放在核心或分配層、也就是閘道所在的那一台，不該讓它隨機落在某一台接取層的舊交換器上。',
        'spanning-tree vlan 10 root primary 會把優先權設成 24576（或比現有根橋再低一級），root secondary 是 28672。這是一次性的巨集，不會持續追蹤。也可以直接寫 priority 4096。',
        '每個 VLAN 的根橋要和它的 FHRP Active 在同一台。兩台核心可以一台管奇數 VLAN、一台管偶數 VLAN，互為備援。',
        '接取層的上行埠加 Root Guard 沒有意義（那裡本來就該收到比較好的 BPDU）；Root Guard 該放在核心往下、不該出現根橋的方向。',
      ],
    },
    {
      h: '排錯',
      list: [
        'show spanning-tree vlan 10：Root ID 是誰（是不是你預期的那一台）、自己哪個埠是根埠、哪個埠被擋。',
        'show spanning-tree vlan 10 detail：拓撲變更發生了幾次、上一次是哪個埠觸發的。數字一直跳就去追那個埠。',
        '迴圈的症狀：CPU 滿載、MAC 位址在兩個埠之間一直跳（MACFLAP）、所有埠的燈一起狂閃、廣播計數器暴衝。先拔掉備援的線讓網路活過來，再找原因。',
        '生成樹失效最常見的原因不是設定錯，而是 BPDU 沒有送達：單向的光纖（UDLD）、被 BPDU Filter 濾掉、中間接了一台不跑生成樹的小交換器。',
      ],
      note: '生成樹的規則是「沒收到 BPDU 就當作那邊沒有交換器，可以轉送」。所以它在「聽不到對方」的時候會失敗在危險的那一邊。Loop Guard 與 UDLD 就是為了補這個洞。',
    },
  ],

  mst: [
    {
      h: '為什麼需要 MST',
      p: ['Rapid PVST+ 每個 VLAN 跑一棵獨立的樹、各自送 BPDU。200 個 VLAN 就是 200 棵樹，每台交換器每 2 秒要處理幾百個 BPDU。但實際上樹的形狀只有兩三種（往 Core-1 或往 Core-2）。MST (802.1s) 把 VLAN 對應到少數幾個 instance，每個 instance 只跑一棵樹：一樣可以分擔流量，負擔卻小得多。'],
    },
    {
      h: '區域 (region)',
      p: ['要算在同一個 MST 區域，三樣東西要完全一樣：區域名稱、revision 編號、VLAN 對 instance 的對應表。交換器不會互相比對整張表，而是比一個雜湊值 (digest)。只要有一個 VLAN 對應得不一樣，兩台就在不同的區域。'],
      list: [
        '不同區域之間，整個區域被當成一台大的交換器，區域之間只跑一棵共用的樹 (CST)，分擔流量的設計就失效了。',
        'instance 0 叫 IST，沒有被指定到其他 instance 的 VLAN 都在這裡，它也負責和區域外面溝通。',
        '改對應表會讓那個 instance 重新收斂，而且所有交換器要改成一樣才會回到同一個區域。所以對應表要在一開始就規劃好（例如 1 – 2000 對 instance 1、2001 – 4094 對 instance 2），之後新增 VLAN 不必再動它。',
      ],
      code: { v: 'Cisco IOS', c: ['spanning-tree mode mst', 'spanning-tree mst configuration', ' name CORP', ' revision 1', ' instance 1 vlan 10,30,50', ' instance 2 vlan 20,40,60', '!', 'spanning-tree mst 1 priority 4096', 'spanning-tree mst 2 priority 8192', '!', 'show spanning-tree mst configuration', 'show spanning-tree mst 1'] },
    },
    {
      h: '和 PVST+ 接在一起',
      p: ['MST 區域的邊界接到跑 PVST+ 的交換器時，MST 那一端會把 IST 的資訊複製成每個 VLAN 各一份 BPDU 送過去（PVST simulation）。規則是：根橋要嘛在 MST 區域裡（對所有 VLAN），要嘛在 PVST+ 那一側（對所有 VLAN）。有的 VLAN 在這邊、有的在那邊，邊界埠會被擋掉並報 PVST simulation inconsistent。遷移時通常先讓 MST 區域當所有 VLAN 的根橋。'],
      note: '「MST 設好了卻沒有分擔流量」幾乎都是區域沒對上：show spanning-tree mst configuration digest 兩台比一比，再看邊界埠是不是出現 (Boundary) 的字樣。',
    },
  ],

  portfast: [
    {
      h: 'PortFast 做了什麼、沒做什麼',
      p: ['PortFast 讓埠一 up 就直接進 Forwarding，跳過 Listening 與 Learning 的 30 秒。它不會關掉生成樹：這個埠照樣送 BPDU，收到 BPDU 的話會失去 PortFast 的身分、回到正常的生成樹流程。在 RSTP 裡它就是 Edge 埠，另外的好處是上下線不觸發拓撲變更。'],
      list: [
        '為什麼需要：電腦開機要 DHCP，等 30 秒就逾時了，拿到 169.254 的位址；PXE 開機、802.1X 也一樣會失敗。',
        '只能用在接終端設備的埠。接了交換器的埠開 PortFast，會在生成樹算好之前就開始轉送，短暫形成迴圈。',
        'Trunk 埠預設不吃 PortFast，接虛擬化主機、路由器的 Trunk 要寫 spanning-tree portfast trunk（新版是 portfast edge trunk）。',
        '全域的 spanning-tree portfast default 會套在所有 access 埠上；個別的埠可以用 spanning-tree portfast disable 排除。',
      ],
      note: 'PortFast 一定要配 BPDU Guard：它保證「這個埠一旦收到 BPDU（代表有人接了交換器），馬上關掉」。兩個一起用，接終端的埠才又快又安全。',
    },
  ],

  'stp-guards': [
    {
      h: '每一種保護擋的是什麼',
      table: {
        head: ['功能', '觸發的條件', '結果', '放在哪裡'],
        rows: [
          ['BPDU Guard', '埠收到任何 BPDU', 'err-disabled，要人工或自動復原', '接終端設備的埠（配 PortFast）'],
          ['BPDU Filter（介面）', '—', '這個埠不送也不收 BPDU，等於關掉生成樹', '幾乎不該用；業者邊界的特殊情況'],
          ['BPDU Filter（全域）', 'PortFast 的埠', '不送 BPDU；收到 BPDU 就恢復成一般的埠', '想少送一些 BPDU 時'],
          ['Root Guard', '收到「比目前根橋更好」的 BPDU', 'root-inconsistent（擋住），對方停止送就自動恢復', '核心往下、不該出現根橋的方向'],
          ['Loop Guard', '原本收得到 BPDU 的非指定埠突然收不到', 'loop-inconsistent（擋住），BPDU 回來就自動恢復', '根埠與 alternate 埠（交換器之間的上行）'],
          ['UDLD', '光纖只有一個方向通', 'err-disabled', '光纖的互連'],
        ],
      },
    },
    {
      h: 'BPDU Filter 的兩種寫法差很多',
      p: [
        '全域的 spanning-tree portfast bpdufilter default 只作用在有 PortFast 的埠：不主動送 BPDU，但只要收到一個，就取消 PortFast 與 Filter、回到正常的生成樹。還算安全。',
        '介面上的 spanning-tree bpdufilter enable 是無條件的：不送、收到也當沒看見。這個埠後面如果繞了一圈接回來，生成樹完全不知道，直接形成迴圈。它和 BPDU Guard 同時設的話，Filter 先作用，Guard 永遠不會觸發。',
      ],
    },
    {
      h: 'Loop Guard 與 UDLD：補「聽不到」的洞',
      p: ['生成樹把埠擋住的依據是「持續收到比較好的 BPDU」。如果因為單向故障（光纖斷了一芯、收發器壞了、對方的 CPU 卡住）收不到 BPDU 了，被擋的埠會以為那邊沒有交換器，過了 Max Age 就開始轉送 —— 而對方其實還在送資料過來，迴圈就形成了。'],
      list: [
        'Loop Guard 從生成樹的角度防：非指定埠收不到 BPDU 時不要變成指定埠，而是進入 loop-inconsistent。',
        'UDLD 從實體的角度防：兩端互送探測訊框並要求對方回聲，確認兩個方向都通。aggressive 模式在對方不再回應時直接把埠關掉。',
        '兩個可以一起用。Loop Guard 與 Root Guard 則不能在同一個埠上並存（一個用在上行、一個用在下行）。',
      ],
      code: { v: 'Cisco IOS', c: ['spanning-tree portfast default', 'spanning-tree portfast bpduguard default', 'spanning-tree loopguard default', 'udld aggressive', '!', 'interface GigabitEthernet1/0/1', ' description to access switch', ' spanning-tree guard root', '!', 'errdisable recovery cause bpduguard', 'errdisable recovery interval 300', '!', 'show spanning-tree inconsistentports', 'show interfaces status err-disabled'] },
    },
  ],

  etherchannel: [
    {
      h: '三種組法',
      table: { head: ['協定', '模式', '說明'], rows: [['LACP（802.3ad，標準）', 'active / passive', 'active 主動協商，passive 只回應。至少一端要 active'], ['PAgP（Cisco）', 'desirable / auto', '和 LACP 的對應一樣；不能和 LACP 混用'], ['靜態', 'on', '不協商，直接當成一條。兩端都要是 on']] },
      p: ['建議一律用 LACP：它會確認對面真的是同一台設備、同一個 Port-channel 才把線加進去。靜態 on 不會檢查，線接錯了（兩條線接到兩台不同的交換器）就直接成迴圈，或一端 on、另一端沒設，生成樹看到的拓撲就不一致。LACP 最多可以放 16 條成員，其中 8 條在用、8 條熱備援，依系統優先權與埠優先權決定。'],
    },
    {
      h: '成員的條件',
      list: [
        '所有成員的速率、雙工要一樣。',
        '都是 access 而且同一個 VLAN，或都是 Trunk 而且允許的 VLAN、native VLAN、封裝一樣。',
        '生成樹的設定（cost、PortFast、guard）一樣。',
        '不能是 SPAN 的目的埠。',
        '設定要下在 interface Port-channel 上，它會套用到所有成員。直接改單一成員會讓那一條和其他的不一致而被停用 (suspended)。',
      ],
    },
    {
      h: '流量怎麼分到各條線',
      p: ['EtherChannel 不是把封包輪流丟到每條線（那樣同一條連線的封包會亂序）。它對封包的某些欄位算雜湊，同一條流量永遠走同一條線。所以「四條 1G 綁在一起」的總容量是 4G，但單一條連線最多還是 1G。'],
      list: [
        '雜湊用哪些欄位可以調：port-channel load-balance src-dst-ip（或 src-dst-mac、src-dst-port）。',
        '選錯了會分配不均：往同一台路由器的流量，目的 MAC 都一樣，用 dst-mac 就全部擠在同一條；備份伺服器之間只有一對 IP，用 src-dst-ip 也只會用一條，要加上埠號。',
        '成員的數量是 2、4、8 條時分配得最平均（雜湊的結果是 8 個桶子分給各條線）。',
      ],
    },
    {
      h: '跨兩台設備的 Port-channel',
      p: ['一般的 EtherChannel 兩端都只能是一台設備。要把上行接到兩台核心又不讓生成樹擋掉其中一條，需要讓兩台核心對外看起來像一台：StackWise / VSS（合成一台，一個控制平面）、vPC / MLAG（兩台各自獨立，只在 Port-channel 上合作）。對下游的設備來說，它就是一條普通的 LACP。'],
      code: { v: 'Cisco IOS', c: ['interface range GigabitEthernet1/0/21 - 22', ' channel-group 1 mode active', '!', 'interface Port-channel1', ' switchport mode trunk', ' switchport trunk allowed vlan 10,20', '!', 'port-channel load-balance src-dst-ip', '!', 'show etherchannel summary', 'show lacp neighbor', 'show etherchannel load-balance'] },
      note: 'show etherchannel summary 的旗標：(P) 在 Port-channel 裡、(s) 被停用、(I) 獨立運作（對面沒有 LACP）、(D) down；Port-channel 本身 (SU) 是第二層而且在用、(RU) 是第三層、(SD) 是 down。',
    },
  ],

  svi: [
    {
      h: '三種跨 VLAN 路由的做法',
      table: {
        head: ['做法', '怎麼接', '優缺點'],
        rows: [['每個 VLAN 一條實體線接到路由器', '路由器一個介面一個 VLAN', '最直覺，介面馬上不夠用'], ['Router-on-a-Stick', '一條 Trunk，路由器上每個 VLAN 一個子介面', '省介面；所有跨 VLAN 的流量擠在一條線上、進出各一次'], ['L3 交換器的 SVI', '交換器自己有每個 VLAN 的虛擬介面 (interface Vlan10)', '用硬體轉送、速度和交換一樣；現在的標準做法']],
      },
    },
    {
      h: 'SVI 什麼時候是 up',
      p: ['SVI 是 up/up 要同時符合三件事：這個 VLAN 存在而且是 active、SVI 本身沒有 shutdown、這個 VLAN 至少有一個埠是 up 而且在生成樹裡是 forwarding（Trunk 也算）。最後一個條件叫 autostate：VLAN 裡沒有任何活著的埠，SVI 就是 up/down，上面的直連路由會從路由表消失 —— 這樣才不會把封包吸進一個沒有人的網段。'],
      list: ['「我設了 interface Vlan30 也給了位址，為什麼是 down」：通常是忘了建 vlan 30，或沒有任何埠在 VLAN 30。', '監控用的埠不想影響 SVI 的狀態，可以用 switchport autostate exclude。', 'L3 交換器要先 ip routing 才會在 VLAN 之間轉送；沒有的話它只是一台有管理位址的 L2 交換器。'],
    },
    {
      h: 'SVI 還是 routed port',
      p: ['交換器之間的互連有兩種寫法。SVI 加 Trunk：兩台之間是第二層，生成樹參與其中，VLAN 可以延伸過去。routed port（no switchport 後直接給位址）：兩台之間是純第三層的點對點連線，沒有 VLAN、沒有生成樹，收斂只看路由協定，可以用 ECMP 讓兩條線同時轉送。'],
      note: '現代的園區與資料中心設計盡量把第二層縮在接取層以下，往上全部用 routed port 與路由協定（Routed Access、Spine-Leaf）。生成樹只剩下防呆的作用。',
    },
  ],

  span: [
    {
      h: '三種鏡射',
      table: { head: ['', '來源與目的', '怎麼傳', '限制'], rows: [['SPAN', '同一台交換器', '直接複製到目的埠', '分析儀要接在同一台'], ['RSPAN', '不同的交換器，同一個第二層網路', '複製到一個專用的 RSPAN VLAN，沿著 Trunk 帶過去', '路上每一台都要有那個 VLAN，而且那個 VLAN 不學 MAC'], ['ERSPAN', '任何路由得到的地方', '包進 GRE 送到分析儀的 IP', '多了封裝的負擔，要注意 MTU']] },
    },
    {
      h: '要注意的事',
      list: [
        '來源可以是埠或 VLAN，方向可以是 rx、tx 或 both。同時抓兩個方向的 Trunk，流量可能是目的埠容量的兩倍，超過的部分會被丟掉，抓到的結果就不完整。',
        '目的埠不再正常轉送：接在上面的設備連不到網路（除非加 ingress 的選項）。它也不參加生成樹。',
        '一台交換器能同時開幾個 session 有上限（通常是 2 個）。',
        '鏡射的是別人的流量：帳號密碼、信件內容都在裡面。要有管制、用完就關掉。',
        '只是想抓少量封包確認問題，IOS XE 的內建封包擷取 (monitor capture) 可以直接存成 pcap，不必佔一個實體埠。',
      ],
      code: { v: 'Cisco IOS', c: ['monitor session 1 source interface GigabitEthernet1/0/5 both', 'monitor session 1 destination interface GigabitEthernet1/0/24', '!', '! ERSPAN（來源端）', 'monitor session 2 type erspan-source', ' source vlan 10 rx', ' destination', '  erspan-id 100', '  ip address 10.9.9.50', '  origin ip address 10.0.0.1', '!', 'show monitor session all'] },
    },
  ],

  'private-vlan': [
    {
      h: '解決什麼問題',
      p: ['同一個子網路裡的主機預設可以直接互通，交換器不會過問。飯店的房間、機房裡不同客戶的伺服器、訪客網路這些場合，希望「大家都在同一個網段、都用同一個閘道，但彼此不能直接講話」。每個人一個 VLAN 與一個子網路太浪費位址；Private VLAN 在一個主要 VLAN 底下再切出次要 VLAN，用第二層的規則隔開。'],
      table: { head: ['埠的類型', '可以和誰通'], rows: [['Promiscuous（接閘道、共用的伺服器）', '所有人'], ['Community（同一個群組）', '同一個 community 的成員，以及 promiscuous'], ['Isolated（完全隔離）', '只有 promiscuous，連別的 isolated 埠都不通']] },
    },
    {
      h: '設定與限制',
      list: [
        '一個主要 VLAN 可以有很多個 community VLAN，但只能有一個 isolated VLAN。',
        'VTP 要是 transparent（或版本 3）才能建立 Private VLAN。',
        '跨交換器時，Trunk 上要同時帶主要與次要 VLAN。',
        '閘道那一端如果是路由器的 SVI，要把次要 VLAN 對應到主要 VLAN 的 SVI（private-vlan mapping）。',
        '只需要「同一台交換器上的埠互相不通」的話，switchport protected 是比較輕量的替代方案。',
      ],
      note: '隔離只在第二層。兩台被隔離的主機還是可以把封包交給閘道，請閘道轉送給對方。要完全擋住，閘道上要有 ACL 拒絕同一個子網路內互相轉送的流量。',
    },
  ],
};
