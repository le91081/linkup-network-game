// 知識庫「深入了解」：路由（CCNP / CCIE 會考到的細節、設計與排錯）
// 格式：{ 文章 id: [{ h: 小標題, p?: [段落], list?: [條列], table?: { head, rows }, code?: { v, c } | [...], note?: 重點 }] }
// 由 index.js 併進對應的文章（c.deep）。

export const DEEP_ROUTING = {
  'routing-table': [
    {
      h: '路由表 (RIB) 和實際轉送用的表 (FIB) 是兩回事',
      p: [
        '各個來源（直連、靜態、OSPF、BGP…）先把自己最好的路交給路由表管理員，同一個網段只留管理距離最小的那一條，這張表叫 RIB（show ip route）。但路由器不是拿 RIB 一筆一筆查來轉送封包的。',
        'CEF（Cisco Express Forwarding）會把 RIB 預先整理成 FIB：每個前綴直接對應到出口介面與下一站，遞迴查詢（BGP 的下一站還要再查一次 IGP）在這一步就先解開。另外有一張 adjacency table 存著每個下一站的第二層標頭（目的 MAC、來源 MAC）。封包進來時只要查 FIB、貼上 adjacency 的標頭就送出去。',
        '硬體交換器把 FIB 寫進 TCAM（可以一次比對「前綴＋遮罩」的記憶體），MAC 位址表則放在 CAM。TCAM 的容量有限，路由太多或 ACL 太長塞不進去時，那部分流量會掉回 CPU 處理，設備就突然變慢。',
      ],
      table: { head: ['表', '內容', '指令'], rows: [['RIB', '每個網段最好的路（控制平面）', 'show ip route'], ['FIB', '解完遞迴之後的轉送表（資料平面）', 'show ip cef'], ['Adjacency', '下一站的第二層標頭', 'show adjacency detail'], ['ARP', 'IP 對 MAC', 'show ip arp']] },
    },
    {
      h: '選路的三個步驟，順序不能顛倒',
      list: [
        '① 最長前綴比對：先看哪一筆的遮罩最長。10.1.1.0/24 永遠贏 10.1.0.0/16，不管它們是誰學來的、metric 多少。',
        '② 管理距離 (AD)：「同一個前綴、同樣的遮罩長度」有好幾個來源時，AD 小的才進路由表。AD 只在這一台有意義，不會傳給別人。',
        '③ metric：同一個協定對同一個前綴有好幾條路時比 metric，一樣的話就都裝進去（ECMP）。',
      ],
      p: ['所以「我設了 AD 比較小的靜態路由，封包卻不走它」通常是因為另一條路的遮罩比較長。反過來，想讓某個小網段走不同的路，寫一條更長的前綴就好。'],
    },
    {
      h: '遞迴查詢與 Null0',
      p: [
        '下一站不是直連的位址時（BGP 最常見），路由器要再查一次路由表找出「往下一站怎麼走」。查不到，那條路就不能用；查到的結果剛好是預設路由，在某些情況下也不算數（BGP 預設不接受用預設路由解析下一站的 iBGP 路徑）。',
        'Null0 是一個永遠 up、把封包直接丟掉的介面。彙總路由常常會自動帶一條「彙總 → Null0」的路：彙總範圍裡真的存在的小網段有更長的前綴會贏；不存在的小網段落到 Null0 被丟掉，而不是順著預設路由送出去再被送回來，形成迴圈。',
      ],
      note: '看到 traceroute 在兩台路由器之間來回跳，先想兩件事：有沒有彙總卻少了 Null0 的丟棄路由、兩台的預設路由是不是互相指著對方。',
    },
  ],

  ad: [
    {
      h: '常見來源的管理距離',
      table: {
        head: ['來源', 'AD', '備註'],
        rows: [['直連', '0', '介面 up 就有'], ['靜態路由', '1', '可以自己指定（浮動靜態路由）'], ['EIGRP 彙總', '5', '彙總路由指向 Null0 的那一條'], ['eBGP', '20', '外面學來的'], ['EIGRP 內部', '90', ''], ['OSPF', '110', '區域內、區域間、外部都是 110'], ['IS-IS', '115', ''], ['RIP', '120', ''], ['EIGRP 外部', '170', '重分配進 EIGRP 的'], ['iBGP', '200', '比所有 IGP 都大'], ['不可用', '255', '永遠不會進路由表']],
      },
      p: ['iBGP 是 200、eBGP 是 20，這個安排是故意的：內部網段應該以 IGP 為準（iBGP 學到的同一個網段會顯示 RIB-failure），而外面學來的路要比自己的 IGP 優先，才不會被內部某條不小心洩漏的路蓋過。'],
    },
    {
      h: '什麼時候要動它',
      list: [
        '浮動靜態路由：ip route 0.0.0.0 0.0.0.0 <備援閘道> 250。平常被動態路由（或 AD 1 的主線靜態路由）蓋住，主線的路消失才浮上來。',
        '兩個地方互相重分配：OSPF 外部路由的 AD（110）比 EIGRP 外部（170）小，第二台邊界路由器會寧可相信「繞了一圈回來」的 OSPF 版本。用 distance ospf external 171，或只針對特定來源調整 distance。',
        '遷移路由協定：新舊協定同時跑，把新協定的 AD 調得比舊的大，確認路都學到了再反過來，就可以不中斷地切換。',
      ],
      note: 'AD 不會跟著路由傳出去，每一台各自判斷。所以「只改一台」常常不夠，路徑上每一台有兩個來源的路由器都要想清楚。',
    },
  ],

  ospf: [
    {
      h: '五種封包與鄰居的狀態機',
      p: ['OSPF 直接跑在 IP 上（協定號 89），用群播 224.0.0.5（所有 OSPF 路由器）與 224.0.0.6（DR / BDR）。它有五種封包，鄰居關係就是照順序交換它們：'],
      table: {
        head: ['狀態', '發生什麼事', '卡在這裡的常見原因'],
        rows: [
          ['Down / Init', '送出 Hello；Init 是「我看到你了，但你的 Hello 裡還沒有我」', '單向不通、ACL 擋掉 224.0.0.5、對面是 passive'],
          ['2-Way', '雙方都在對方的 Hello 裡。多存取網段在這一步選 DR / BDR', 'DROTHER 之間停在這裡是正常的'],
          ['ExStart', '決定誰是主（Router ID 大的），開始交換 DBD', 'MTU 不一樣；Router ID 重複'],
          ['Exchange', '用 DBD 互相告知「我有哪些 LSA」的摘要', 'MTU 不一樣'],
          ['Loading', '用 LSR 向對方要自己沒有或比較舊的 LSA，對方回 LSU', 'LSA 損壞、封包遺失'],
          ['Full', '兩邊的 LSDB 一模一樣', '—'],
        ],
      },
      list: ['Hello 裡要一致的欄位：區域編號、子網路遮罩（點對點除外）、Hello / Dead 時間、驗證、區域類型旗標（stub、NSSA）。任何一項不同，連 2-Way 都到不了。', 'MTU 寫在 DBD 裡，所以 MTU 不一致的症狀是「看得到鄰居，卡在 ExStart / Exchange」。ip ospf mtu-ignore 可以略過檢查，但真正該修的是 MTU。'],
    },
    {
      h: 'LSA 的類型：誰產生、傳到哪裡',
      table: {
        head: ['類型', '名稱', '誰產生', '傳播範圍', '路由表'],
        rows: [
          ['1', 'Router LSA', '每一台路由器', '自己的區域', 'O'],
          ['2', 'Network LSA', '多存取網段的 DR', '自己的區域', 'O'],
          ['3', 'Summary LSA', 'ABR', '送進別的區域', 'O IA'],
          ['4', 'ASBR Summary', 'ABR', '告訴別的區域「ASBR 在哪裡」', '—'],
          ['5', 'AS External', 'ASBR', '整個 OSPF 網域（stub 類的區域除外）', 'O E1 / E2'],
          ['7', 'NSSA External', 'NSSA 裡的 ASBR', '只在那個 NSSA；ABR 轉成 Type 5', 'O N1 / N2'],
        ],
      },
      p: ['Type 1 與 2 描述的是「拓撲」：誰和誰相連、cost 多少，區域裡每一台靠它們跑 SPF。Type 3 之後描述的只是「某個前綴、cost 多少」，接收的路由器不再知道別的區域長什麼樣子 —— 這就是為什麼區域之間的行為像距離向量，也是為什麼所有區域都必須接到骨幹（area 0）：防止區域間的路由繞圈。'],
    },
    {
      h: '路徑選擇：類型比 cost 優先',
      p: ['同一個前綴有好幾種 OSPF 路徑時，先比類型，類型一樣才比 cost：'],
      list: [
        '區域內 (O) ＞ 區域間 (O IA) ＞ 外部 type 1 (E1 / N1) ＞ 外部 type 2 (E2 / N2)。就算區域內那條的 cost 是 1000、區域間那條是 10，照樣選區域內。',
        'E1 的 cost = 外部 metric ＋ 到 ASBR 的內部 cost，離 ASBR 越遠越大。E2 的 cost 固定是外部 metric，不管多遠；兩條 E2 的 metric 一樣時才比到 ASBR 的內部 cost（forward metric）。',
        '有兩個出口（兩台 ASBR）而且希望每台路由器走離自己近的那個，要用 E1；希望全網都走同一個主要出口，用 E2 並給主備不同的 metric。',
      ],
      note: '考試很愛問「為什麼流量走比較慢的那條」：答案常常是那一條是區域內的路，或是 E2 的 metric 不看距離。',
    },
    {
      h: '計時器與收斂',
      table: { head: ['網路類型', 'Hello / Dead', '選 DR', '常見的地方'], rows: [['broadcast', '10 / 40 秒', '會', '乙太網路（預設）'], ['point-to-point', '10 / 40 秒', '不會', '序列線路、GRE；兩台路由器對接的乙太網路也建議改成這個'], ['non-broadcast (NBMA)', '30 / 120 秒', '會，鄰居要手動指定', 'Frame Relay、DMVPN 的舊做法'], ['point-to-multipoint', '30 / 120 秒', '不會', 'hub-and-spoke，每個鄰居一條 /32']] },
      list: [
        '線路斷掉（介面 down）會立刻收斂；怕的是「線還亮著但對方沒回應」，要等 Dead 時間 40 秒。用 BFD（ip ospf bfd）可以壓到一秒內，比把 Hello 調到很小更省 CPU。',
        '兩端的網路類型不一樣（一邊 broadcast、一邊 point-to-point）時，鄰居可以 Full，但雙方對這段線路的描述對不起來，SPF 算不出路：「鄰居是好的、路由卻沒有」。',
        'LSA 每 30 分鐘重送一次（refresh），60 分鐘沒更新就過期 (MaxAge)。SPF 有節流機制，網路不穩時計算的間隔會逐漸拉長。',
      ],
    },
    {
      h: '排錯的順序',
      list: [
        'show ip ospf interface brief：介面有沒有在 OSPF 裡、在哪個區域、是不是 passive、cost 多少。',
        'show ip ospf neighbor：有沒有鄰居、停在哪個狀態。沒有鄰居 → 查 Hello 的條件；停在 ExStart → 查 MTU 與 Router ID。',
        'show ip ospf database：LSDB 裡有沒有那個前綴的 LSA。有 LSA 卻沒有路由 → 網路類型不一致、區域沒有接到骨幹、或被 distribute-list 擋掉。',
        'show ip route ospf、show ip route <前綴>：實際裝進去的是哪一種路徑、下一站是誰。',
        'debug ip ospf adj、debug ip ospf hello：直接看 Hello 哪個欄位不一致。',
      ],
      code: { v: 'Cisco IOS：多區域的基本設定', c: ['router ospf 1', ' router-id 10.255.0.1', ' auto-cost reference-bandwidth 100000', ' passive-interface default', ' no passive-interface GigabitEthernet0/0/0', ' network 10.0.0.0 0.0.0.255 area 0', ' network 10.10.0.0 0.0.255.255 area 10', ' area 10 range 10.10.0.0 255.255.0.0', '!', 'interface GigabitEthernet0/0/0', ' ip ospf network point-to-point', ' ip ospf authentication message-digest', ' ip ospf message-digest-key 1 md5 S3cret!'] },
    },
  ],

  'ospf-area': [
    {
      h: '為什麼要分區域',
      p: [
        '同一個區域裡每一台都有完整的拓撲（Type 1、2 LSA）。任何一條線上下，區域裡每一台都要重跑 SPF。區域越大，LSDB 越大、SPF 越久、一條不穩的線影響的範圍越廣。',
        '分區域之後，區域的邊界（ABR）只把「前綴與 cost」摘要成 Type 3 送出去。別的區域裡線路上下，只會讓 ABR 更新那幾筆摘要，不會讓其他區域重跑完整的 SPF。如果再加上彙總（area range），連摘要都不必更新：小網段的震盪被擋在區域裡面。',
      ],
    },
    {
      h: '四種「不收外部路由」的區域',
      table: {
        head: ['類型', '區域裡看得到的 LSA', 'ABR 送進來的預設路由', '可以有 ASBR 嗎', '設定'],
        rows: [
          ['一般區域', '1、2、3、4、5', '沒有', '可以', '—'],
          ['Stub', '1、2、3', '有（Type 3）', '不行', '每一台：area X stub'],
          ['Totally stubby', '1、2，加一條預設', '有（Type 3）', '不行', 'ABR：area X stub no-summary；其他台：area X stub'],
          ['NSSA', '1、2、3、7', '預設沒有（要 default-information-originate）', '可以（產生 Type 7）', '每一台：area X nssa'],
          ['Totally NSSA', '1、2、7，加一條預設', '有', '可以', 'ABR：area X nssa no-summary'],
        ],
      },
      list: [
        '區域類型寫在 Hello 的旗標裡：同一個區域每一台都要設成同一種，不然不會成為鄰居。no-summary 只有 ABR 需要。',
        'stub 類的區域不能有虛擬連結 (virtual link) 穿過，骨幹 (area 0) 不能是 stub。',
        'NSSA 的 ABR 會把 Type 7 轉成 Type 5 送進骨幹（Router ID 最大的那台 ABR 負責轉）。Type 7 裡的 P-bit 決定要不要轉。',
      ],
    },
    {
      h: '彙總：在哪裡做、會多出什麼',
      list: [
        '區域之間的彙總只能在 ABR 做：area 10 range 10.10.0.0 255.255.0.0。彙總路由的 cost 預設取範圍內最大（或最小，看版本）的那一個。',
        '外部路由的彙總只能在 ASBR 做：summary-address 172.16.0.0 255.255.0.0。',
        '兩種彙總都會在做彙總的那一台裝一條指向 Null0 的丟棄路由，避免範圍內不存在的網段順著預設路由繞回來形成迴圈。',
        '彙總要配合位址規劃：每個區域拿一塊連續、對齊位元邊界的位址，才彙總得起來。這是在網路還沒蓋之前就要決定的事。',
      ],
    },
    {
      h: '區域沒有接到骨幹怎麼辦',
      p: [
        'OSPF 規定所有區域都要實體接到 area 0，而且 area 0 本身要連續。違反的話，ABR 不會把非骨幹區域學到的區域間路由再轉送出去，遠端的區域就學不到路。',
        '臨時的補救是虛擬連結：在兩台 ABR 之間、穿過一個一般區域（transit area），用 area <transit> virtual-link <對方的 Router ID> 建一條邏輯上的骨幹連線。它只該用在併購、搬遷這種過渡期；長期的網路應該重新規劃位址與區域。GRE 通道放進 area 0 是另一種做法。',
      ],
      note: '設計題常見的陷阱：一台路由器同時接了 area 1 和 area 2 卻沒有接 area 0，它不是 ABR，兩個區域不會互通。',
    },
    {
      h: '過濾：OSPF 不能隨便擋路由',
      p: ['連結狀態協定要求同一個區域裡每一台的 LSDB 一樣，所以不能像距離向量協定那樣在任意一台過濾。能過濾的地方只有幾個：'],
      list: [
        'ABR 上的 area X filter-list prefix <名稱> in | out：過濾 Type 3，決定哪些前綴可以進出這個區域。',
        'area X range … not-advertise：把這個範圍整個藏起來。',
        'ASBR 上重分配時的 route-map：決定哪些外部路由進 OSPF。',
        'distribute-list in：只是不把路裝進「這一台」的路由表，LSA 照樣往下傳。下游的路由器還是會算出這條路並把封包送過來，結果被這一台丟掉 —— 很容易做出黑洞，要小心。',
      ],
    },
  ],

  'ospf-dr': [
    {
      h: '為什麼需要 DR',
      p: [
        '同一個乙太網段上有 n 台路由器時，如果兩兩都要同步 LSDB，就有 n(n−1)/2 組鄰接關係，每一次變動的 LSA 也會被重複洪泛很多次。OSPF 的做法是選一台 DR（Designated Router）當「這個網段的代表」：其他路由器（DROTHER）只和 DR、BDR 建立完整的鄰接 (Full)，彼此之間停在 2-Way。',
        'DR 另外負責產生 Type 2 LSA，描述「這個網段上接了哪些路由器」。DROTHER 有更新時送到 224.0.0.6（只有 DR / BDR 在聽），DR 再用 224.0.0.5 轉給大家。',
      ],
    },
    {
      h: '選舉的規則',
      list: [
        '先比介面的優先權（ip ospf priority，0 – 255，預設 1），大的贏。優先權 0 代表永遠不參選。',
        '優先權一樣比 Router ID，大的贏。',
        '不會搶：已經有 DR 的網段，後來加入的路由器就算優先權再高也只能等。DR 掛了 BDR 升上來，再選一台新的 BDR。',
        '剛開機的介面會等一個 Wait 時間（等於 Dead 時間）聽聽看有沒有既有的 DR，所以「誰先開機」常常比優先權更有決定性。要讓指定的那一台當 DR：設好優先權之後 clear ip ospf process，或把其他台設成 0。',
      ],
      note: 'Router ID 的決定順序：手動 router-id ＞ 最大的 Loopback 位址 ＞ 最大的實體介面位址。Router ID 在程序啟動時決定，之後改 Loopback 不會變，要重啟程序。',
    },
    {
      h: '不想要 DR 的時候',
      p: ['只有兩台路由器對接的乙太網路線根本不需要 DR，卻還是會選、還多一個 Type 2 LSA 與 Wait 的延遲。把兩端都設成 ip ospf network point-to-point：不選 DR、鄰居起來得比較快、LSDB 也比較乾淨。Spine-Leaf 與核心之間的互連通常都這樣做。'],
    },
    {
      h: 'hub-and-spoke 上的 DR',
      p: [
        '在 DMVPN、Frame Relay 這種「分公司彼此聽不到對方的 Hello」的網路上，如果用 broadcast 類型，DR 一定要是 hub：只有 hub 和每一台都通。spoke 當上 DR 的話，別的 spoke 根本和它建立不了鄰接，路由就殘缺不全。做法是 hub 設高優先權、所有 spoke 設 ip ospf priority 0。',
        '另一個選擇是 point-to-multipoint：不選 DR，每個鄰居各自成為一條 /32 的路。設定簡單、不會選錯，代價是路由表多了很多主機路由，而且 spoke 之間的流量一定經過 hub。',
      ],
    },
  ],

  eigrp: [
    {
      h: 'DUAL 的幾個名詞',
      table: {
        head: ['名詞', '意思'],
        rows: [
          ['Feasible Distance (FD)', '從我這裡到目的地最好的 metric'],
          ['Reported Distance (RD，也叫 AD)', '鄰居告訴我「它到目的地」的 metric'],
          ['Successor', 'metric 最好的那個鄰居，它的路裝進路由表'],
          ['Feasible Successor (FS)', '備援：它的 RD 小於我目前的 FD'],
          ['Feasibility Condition', 'RD ＜ FD：保證那個鄰居的路不會繞回我這裡'],
        ],
      },
      p: [
        '可行條件是 EIGRP 不會迴圈的關鍵：如果鄰居回報的距離比我自己的最佳距離還小，它一定比我更靠近目的地，它的路不可能經過我。符合條件的鄰居就可以當備援，successor 斷掉時立刻換過去，不用問任何人。',
        '沒有 FS 的時候，這條路進入 Active 狀態：向所有鄰居送 Query 問「你有沒有到那裡的路」，鄰居沒有的話再往下問。要等所有的 Reply 都回來才能決定。',
      ],
    },
    {
      h: 'metric 怎麼算',
      p: [
        '預設只用頻寬與延遲（K1 = K3 = 1，其餘是 0）：metric = 256 ×（10⁷ ÷ 路徑上最小的頻寬 kbps ＋ 沿路延遲的總和 ÷ 10）。頻寬取整條路徑上「最窄」的那一段，延遲則是每一段加起來。',
        '想影響選路時改延遲（delay）比改頻寬（bandwidth）安全：bandwidth 還會被 QoS、OSPF cost 拿去用。K 值兩端要一樣才會成為鄰居。',
        '具名模式 (named mode) 用 64 位元的 wide metric，10G 以上的介面才分得出快慢；傳統模式裡 1G 和 10G 的頻寬項幾乎一樣。',
      ],
    },
    {
      h: 'Stuck in Active 與怎麼縮小查詢範圍',
      p: ['Query 會一路往外擴散，只要有一台沒回，發問的那台就卡在 Active。超過 3 分鐘（預設）它會把沒回應的鄰居重置，這就是 SIA：一條遠端的線不穩，卻讓不相干的鄰居關係斷掉。兩個工具可以把查詢擋在近處：'],
      list: [
        '彙總：收到 Query 的路由器如果只有彙總路由、沒有那筆明細，會直接回「沒有」，不再往下問。',
        'stub：分公司的路由器宣告自己是 stub（eigrp stub connected summary），hub 就不會向它送 Query。hub-and-spoke 的 spoke 都應該是 stub。',
      ],
    },
    {
      h: '不等價負載平衡',
      p: ['EIGRP 是少數可以把流量分到「metric 不一樣」的路徑上的協定。variance 2 代表 metric 在最佳路徑兩倍以內的路都可以用，但前提是那條路符合可行條件（是 FS）。流量會依 metric 的反比分配：比較快的線多扛一些。'],
      list: ['variance 只是倍數，不保證一定會多一條路：不是 FS 的路再近也不會被採用。', 'maximum-paths 限制最多裝幾條（預設 4）。', 'show ip eigrp topology 看得到每條路的 FD / RD，判斷它是不是 FS。'],
    },
    {
      h: '鄰居與彙總',
      list: [
        '成為鄰居的條件：同一個 AS 編號、同一個網段、K 值一樣、驗證一樣。Hello 與 Hold 時間不需要一樣（和 OSPF 不同）。',
        '手動彙總寫在介面上：ip summary-address eigrp 100 10.1.0.0 255.255.0.0。做彙總的那一台會多一條指向 Null0、AD 是 5 的路。',
        'auto-summary 會在主類別網路的邊界自動彙總，不連續的子網路會出問題；新的 IOS 預設已經是 no auto-summary。',
        '管理距離：內部 90、外部（重分配進來的）170、彙總 5。',
      ],
      code: { v: 'Cisco IOS：具名模式', c: ['router eigrp CORP', ' address-family ipv4 unicast autonomous-system 100', '  network 10.0.0.0', '  af-interface GigabitEthernet0/0/1', '   summary-address 10.1.0.0 255.255.0.0', '  exit-af-interface', '  topology base', '   variance 2', '  exit-af-topology', '  eigrp stub connected summary'] },
    },
  ],

  bgp: [
    {
      h: '鄰居的狀態',
      table: {
        head: ['狀態', '在做什麼', '停在這裡通常是'],
        rows: [
          ['Idle', '還沒開始，或被拒絕後在等', '沒有往鄰居位址的路、鄰居被 shutdown'],
          ['Connect', '正在建立 TCP 179', '—'],
          ['Active', 'TCP 連不上，一直重試', '對方沒有設我當鄰居、來源位址不對（少了 update-source）、ACL 擋 179、eBGP 不是直連卻沒有 ebgp-multihop'],
          ['OpenSent / OpenConfirm', '交換 OPEN、等 KEEPALIVE', 'AS 編號設錯、驗證不符、Router ID 重複'],
          ['Established', '開始交換 UPDATE', '—'],
        ],
      },
      p: ['「Active」聽起來像是好事，其實是壞消息：它代表主動去連卻連不上。Keepalive 預設 60 秒、Hold time 180 秒，所以「線還亮著但對方不見了」要三分鐘才發現；直連的 eBGP 介面一 down 就立刻斷（fast external fallover），其他情況要靠 BFD。'],
    },
    {
      h: '屬性的四種分類',
      table: {
        head: ['分類', '意思', '例子'],
        rows: [
          ['公認必要', '每一筆 UPDATE 都要有', 'AS_PATH、NEXT_HOP、ORIGIN'],
          ['公認自由', '大家都認得，不一定帶', 'LOCAL_PREF（只在 AS 內）、ATOMIC_AGGREGATE'],
          ['選擇性可轉送', '不認得也要原封不動往下傳', 'COMMUNITY、AGGREGATOR'],
          ['選擇性不可轉送', '不認得就丟掉；只傳給相鄰的 AS', 'MED、ORIGINATOR_ID、CLUSTER_LIST'],
        ],
      },
    },
    {
      h: '最佳路徑的完整順序',
      p: ['同一個前綴收到好幾條路時，Cisco 路由器由上往下比，分出勝負就停。前提是下一站要查得到。'],
      table: {
        head: ['順序', '比什麼', '哪個好', '影響的範圍'],
        rows: [
          ['1', 'Weight（Cisco 專屬）', '大', '只有這一台'],
          ['2', 'Local Preference', '大', '整個 AS（出去走哪裡）'],
          ['3', '自己產生的（network、redistribute、aggregate）', '優先', ''],
          ['4', 'AS_PATH 長度', '短', ''],
          ['5', 'Origin', 'i ＜ e ＜ ?', ''],
          ['6', 'MED', '小', '只比同一個鄰居 AS 來的（進來走哪裡）'],
          ['7', 'eBGP 優於 iBGP', '', ''],
          ['8', '到下一站的 IGP metric', '小', '熱馬鈴薯路由'],
          ['9', '比較早學到的（eBGP）', '舊', '減少震盪'],
          ['10', '鄰居的 Router ID', '小', ''],
          ['11', 'CLUSTER_LIST 長度', '短', '經過比較少的反射器'],
          ['12', '鄰居的位址', '小', ''],
        ],
      },
      note: '記憶的方向：前面幾項是「管理者的意願」（weight、local-pref），中間是「路徑本身」（AS path、origin、MED），最後才是打破平手用的。想控制出去的流量用 local-pref，想影響進來的流量用 AS-path prepend、MED 或 community。',
    },
    {
      h: '路由怎麼進到 BGP',
      list: [
        'network 10.1.0.0 mask 255.255.0.0：路由表裡要有「一模一樣」的前綴與遮罩才會送出去。沒有的話，常見的做法是寫一條 ip route 10.1.0.0 255.255.0.0 Null0。',
        'redistribute：把 IGP 或靜態的路倒進來，Origin 是 ?（incomplete）。一定要搭配 route-map，不然內部所有的小網段都會被送給 ISP。',
        'aggregate-address 10.0.0.0 255.0.0.0 summary-only：範圍內有任何一筆明細在 BGP 表裡才會產生彙總；summary-only 把明細藏起來；as-set 保留原本的 AS 資訊以防迴圈。',
      ],
    },
    {
      h: '過濾的工具與順序',
      table: {
        head: ['工具', '比對什麼', '例子'],
        rows: [
          ['prefix-list', '前綴與遮罩長度', 'ip prefix-list OUT permit 192.0.2.0/24'],
          ['as-path access-list', 'AS_PATH 的正規表示式', '^$：自己 AS 產生的；_65001$：源頭是 65001；^65001_：直接從 65001 來'],
          ['community-list', '路由上的標籤', 'ip community-list standard CUST permit 65000:100'],
          ['route-map', '以上都可以比，還能改屬性', 'set local-preference / as-path prepend / metric / community'],
        ],
      },
      list: [
        '多線路的公司最重要的一條：送給 ISP 的路由只放自己的前綴（或 filter-list 只允許 ^$）。不然你會把 ISP-A 學到的路由送給 ISP-B，變成兩家 ISP 之間的轉運站。',
        'route-map 最後有隱含的 deny：只寫了一條改屬性的 permit，其他路由就全部被擋掉了。記得最後加一條空的 permit。',
        '改了政策之後要重新套用：clear ip bgp * soft（靠 route refresh，不會中斷連線）。不加 soft 會把鄰居整個重置。',
      ],
    },
    {
      h: '排錯的順序',
      list: [
        'show ip bgp summary：鄰居的狀態，最後一欄是數字代表收到幾筆前綴，是文字代表還沒建立。',
        'show ip bgp neighbors <IP> advertised-routes / routes：我送了什麼、收到了什麼。',
        'show ip bgp <前綴>：每一條路的屬性，以及為什麼沒被選中（not best、inaccessible）。',
        'show ip route <下一站>：下一站查不查得到。iBGP 最常見的問題就是下一站不通。',
        '第一欄的記號：* 可用、> 最佳、i 從 iBGP 學到、r RIB-failure（路由表裡有 AD 更小的同一個前綴）。',
      ],
    },
  ],

  ibgp: [
    {
      h: '為什麼 iBGP 需要全網狀',
      p: [
        'eBGP 靠 AS_PATH 防迴圈：看到路徑裡有自己的 AS 編號就丟掉。但同一個 AS 裡面，路由從一台傳到另一台 AS_PATH 不會變，這個方法就沒用了。所以 iBGP 改用一條簡單的規則：從 iBGP 學到的路，不再送給其他 iBGP 鄰居。',
        '這條規則的代價是每一台都要直接和其他每一台建立鄰居，才收得到所有的路：n 台要 n(n−1)/2 條。10 台 45 條、50 台 1225 條，設定與記憶體都撐不住。兩個解法：路由反射器，或把 AS 切成幾個子 AS 的 confederation。',
      ],
    },
    {
      h: '路由反射器的規則',
      table: { head: ['路由從哪裡學到', '反射器會送給誰'], rows: [['eBGP 鄰居', '所有人（client、non-client、其他 eBGP）'], ['client', '所有 client 與 non-client（還有 eBGP）'], ['non-client', '只給 client（還有 eBGP）']] },
      list: [
        '反射時不會改任何屬性：下一站、local-pref、MED 都原樣。所以邊界路由器自己要 next-hop-self。',
        '防迴圈靠兩個新屬性。ORIGINATOR_ID：這條路最早是 AS 裡哪一台送出來的，自己收到自己的就丟掉。CLUSTER_LIST：經過了哪些反射器（cluster-id，預設是 Router ID），反射器看到自己的 cluster-id 就丟掉。',
        '反射器只會把「它自己選出的最佳路徑」反射出去。client 因此看不到其他的路徑，換手會比較慢，也可能選到對 client 來說不是最近的出口。',
      ],
    },
    {
      h: '反射器的設計',
      list: [
        '至少兩台，每個 client 同時接兩台；兩台反射器之間互相建立一般的 iBGP。',
        '兩台備援的反射器用不用同一個 cluster-id 各有取捨：用同一個比較省記憶體，但某個 client 只和其中一台通的時候，另一台會把那些路當成迴圈丟掉。多數設計讓每一台用自己的 cluster-id。',
        '反射器不一定要在封包經過的路上。大型網路常用專門的路由器（甚至虛擬機）只跑控制平面。',
        '大型網路可以分層：上層的反射器把下層的反射器當成 client。',
      ],
    },
    {
      h: '下一站與 BGP 黑洞',
      p: [
        'iBGP 送路由時下一站不變。邊界路由器從 ISP 學到的路，下一站是 ISP 那一端的位址；AS 裡的其他路由器如果查不到這個位址，那條路就是 inaccessible。兩種解法：邊界路由器對 iBGP 鄰居設 next-hop-self，或把和 ISP 相連的那個網段放進 IGP（passive）。',
        '另一個經典問題：兩台邊界路由器之間隔著一台沒有跑 BGP 的核心。邊界路由器之間的 iBGP 是好的，路由表也有路，但封包交給核心之後，核心不認得外面的目的地就丟掉了。這叫 BGP 黑洞。解法是核心也跑 BGP（全網狀或反射器），或用 MPLS 讓核心只看標籤（BGP-free core）。',
      ],
      note: 'iBGP 一律用 Loopback 建立鄰居（update-source Loopback0）：任何一條實體線斷了，只要 IGP 還繞得到，鄰居關係就不會斷。eBGP 通常用直連的位址；要用 Loopback 的話需要 ebgp-multihop 或 disable-connected-check。',
    },
  ],

  redistribution: [
    {
      h: '種子 metric：倒進去的路要有起始值',
      table: {
        head: ['倒進', '預設的 metric', '沒有指定會怎樣'],
        rows: [
          ['OSPF', '20（從 BGP 來的是 1），type E2', '照樣會進去'],
          ['EIGRP', '無限大', '不會出現：要 metric <頻寬> <延遲> <可靠度> <負載> <MTU>，或 default-metric'],
          ['RIP', '無限大（16）', '不會出現：要 metric <跳數>'],
          ['BGP', '把原本 IGP 的 metric 當成 MED', '照樣會進去'],
        ],
      },
      p: ['「重分配設了，對面卻沒有收到」第一個要查的就是種子 metric。靜態與直連的路倒進 EIGRP 是例外：直連介面本身有頻寬與延遲，可以自己算出來。'],
    },
    {
      h: '到底哪些路會被倒進去',
      list: [
        'redistribute ospf 1 倒的是「這一台的路由表裡，由 OSPF 1 裝進去的路」，加上「有跑 OSPF 1 的直連介面」。OSPF 學到但輸給別的來源、沒進路由表的路不會被倒。',
        '老版本的 IOS 重分配進 OSPF 要加 subnets，不然只收主類別的網段；新版本預設就有。',
        '用 route-map 控制：match ip address prefix-list 選路、set metric / metric-type / tag 改屬性。route-map 最後有隱含的 deny。',
        '重分配不是互相的。OSPF → EIGRP 與 EIGRP → OSPF 是兩條獨立的設定，各自要有 metric 與過濾。',
      ],
    },
    {
      h: '兩個點互相重分配：最容易出事的設計',
      p: [
        '兩台邊界路由器（R1、R2）都在 EIGRP 與 OSPF 之間雙向重分配。一條原本屬於 EIGRP 那一側的外部路由，被 R1 倒進 OSPF 之後，會經過 OSPF 傳到 R2。R2 這時有兩個版本：EIGRP 外部的（AD 170）與 OSPF 外部的（AD 110）。它選了 AD 比較小的 OSPF 版本 —— 也就是相信「繞了一圈回來」的那條路，然後再把它倒回 EIGRP。',
        '輕則流量繞遠路（次佳路徑），重則兩邊互相餵對方錯誤的路由，形成迴圈或路由不停震盪。',
      ],
      list: [
        '路由標籤 (tag)：倒進去的時候 set tag 100，從另一邊倒回來的 route-map 先 deny match tag 100。兩台邊界路由器用同一套標籤，路由就不會被倒回它的出生地。這是最通用、最容易維護的做法。',
        '調整 AD：讓「從別的協定來的」那一版 AD 比較大，例如 distance ospf external 171。',
        '只倒進去彙總或預設路由，不要雙向倒明細。能只在一個點重分配就不要兩個點。',
      ],
      code: { v: 'Cisco IOS：用 tag 防止倒回去', c: ['route-map OSPF-TO-EIGRP deny 10', ' match tag 90', 'route-map OSPF-TO-EIGRP permit 20', ' set tag 110', '!', 'route-map EIGRP-TO-OSPF deny 10', ' match tag 110', 'route-map EIGRP-TO-OSPF permit 20', ' set tag 90', '!', 'router eigrp 100', ' redistribute ospf 1 metric 100000 10 255 1 1500 route-map OSPF-TO-EIGRP', 'router ospf 1', ' redistribute eigrp 100 subnets route-map EIGRP-TO-OSPF'] },
    },
    {
      h: 'E1 還是 E2',
      p: ['倒進 OSPF 的路預設是 E2：metric 固定，全網只看誰倒進來的 metric 小。只有一個出口，或希望大家都走主要出口時用它。有兩個出口而且希望每台路由器走離自己近的那個，用 metric-type 1（E1）：cost 會加上到 ASBR 的內部距離。同一個前綴 E1 永遠優先於 E2。'],
      note: '排錯時在邊界路由器上依序看：來源協定的路有沒有在路由表裡 → redistribute 有沒有 metric → route-map 有沒有擋掉 → 目的協定的資料庫裡有沒有（show ip ospf database external、show ip eigrp topology）→ 下游有沒有裝進路由表。',
    },
  ],

  pbr: [
    {
      h: '它在轉送流程的哪裡',
      p: ['一般的路由只看目的位址。政策路由套在「封包進來的介面」上（ip policy route-map），在查路由表之前先比對 route-map：符合 permit 的條目就照 set 的指示送，不符合任何條目（或符合 deny）就回到一般的路由表。所以 PBR 沒寫到的流量不會被丟掉，只是照原本的方式走。'],
    },
    {
      h: '幾種 set 的差別',
      table: {
        head: ['指令', '什麼時候生效'],
        rows: [
          ['set ip next-hop <位址>', '直接用它，不管路由表怎麼說。下一站要是直連的'],
          ['set ip default next-hop <位址>', '路由表裡「沒有明確的路」（只有預設路由）時才用'],
          ['set interface <介面>', '直接從這個介面送出去，適合點對點的介面'],
          ['set ip next-hop verify-availability <位址> <序號> track <n>', '搭配 IP SLA：下一站活著才用，死了就換下一個或回到路由表'],
        ],
      },
    },
    {
      h: '常見的坑',
      list: [
        'PBR 只管進來的方向。回程的封包是另一個方向、從另一個介面進來，要另外處理，不然去回走不同的路，遇到有狀態的防火牆就不通。',
        '路由器自己產生的封包（ping、SSH、路由協定）不會經過介面上的 PBR，要用 ip local policy route-map。',
        '下一站掛了，PBR 不會自己知道，封包照樣被送去那裡丟掉。一定要搭配 track。',
        '比對用的 ACL 寫 permit 代表「符合」，不是「允許」。route-map 的條目是 deny 則代表「這些流量不要做 PBR」。',
        'PBR 比對是逐封包做的，流量大時要確認平台能用硬體處理。',
      ],
      code: { v: 'Cisco IOS：備份流量走第二條線，線斷了就回到路由表', c: ['ip sla 1', ' icmp-echo 10.255.2.1 source-interface GigabitEthernet0/0/2', ' frequency 5', 'ip sla schedule 1 life forever start-time now', 'track 1 ip sla 1 reachability', '!', 'ip access-list extended BACKUP', ' permit tcp 10.2.0.0 0.0.0.255 host 10.1.0.20 eq 445', 'route-map PBR permit 10', ' match ip address BACKUP', ' set ip next-hop verify-availability 10.255.2.1 1 track 1', '!', 'interface GigabitEthernet0/0/1', ' ip policy route-map PBR'] },
    },
  ],

  vrf: [
    {
      h: 'VRF 切開了什麼',
      p: ['一個 VRF 就是一份獨立的路由表、轉送表與 ARP 表。同一台路由器上的兩個 VRF 可以有一模一樣的位址而互不相干。介面只能屬於一個 VRF；把介面放進 VRF 的時候，上面原本的 IP 位址會被清掉（要重設）。路由協定、靜態路由、ping、SSH 都要指定是在哪個 VRF 裡。'],
      table: { head: ['做法', '怎麼跨設備', '適合'], rows: [['VRF-Lite', '每個 VRF 在每一段線上用一個子介面（或一條實體線）一路接下去', '園區、少量的 VRF'], ['MPLS L3VPN', 'PE 之間用 MP-BGP 交換 VPNv4 路由，封包貼兩層標籤', '電信業者、大量的客戶']] },
    },
    {
      h: 'VRF-Lite 怎麼延伸',
      p: ['VRF-Lite 沒有任何「把 VRF 資訊帶到下一台」的機制。要讓 A 部門的路由表從大樓一延伸到大樓二，中間每一台路由器都要有同名的 VRF，每一段互連都要替每個 VRF 準備一個子介面（802.1Q 的 VLAN）與一段位址，上面各自跑一個路由協定的程序。VRF 一多，設定量就成倍增加 —— 這正是 MPLS VPN、VXLAN 要解決的問題。'],
      code: { v: 'Cisco IOS', c: ['vrf definition TENANT-A', ' address-family ipv4', '!', 'interface GigabitEthernet0/0/1.10', ' encapsulation dot1Q 10', ' vrf forwarding TENANT-A', ' ip address 10.0.10.1 255.255.255.252', '!', 'router ospf 10 vrf TENANT-A', ' network 10.0.10.0 0.0.0.3 area 0', '!', 'ping vrf TENANT-A 10.0.10.2', 'show ip route vrf TENANT-A'] },
    },
    {
      h: '路由洩漏：讓兩個 VRF 選擇性互通',
      list: [
        '靜態路由：ip route vrf A 10.9.0.0 255.255.255.0 10.0.0.1 global，下一站到全域的路由表去查；回程在全域寫一條指向 VRF 介面的路。簡單，但每個網段都要手寫。',
        'MP-BGP 的 route-target：同一台設備上也可以用。VRF A 匯出 RT 1、VRF B 匯入 RT 1，B 就看得到 A 的路。共用服務（DNS、更新伺服器）的標準做法。',
        '接一台防火牆：兩個 VRF 各接防火牆的一個介面，由防火牆決定誰可以過。需要檢查流量時用這個。',
        '洩漏是有方向的：A 看得到 B 不代表 B 看得到 A，兩邊都要有路連線才會通。',
      ],
      note: '管理介面通常放在自己的 VRF（Mgmt-vrf）：帶外管理的流量不會和生產流量混在一起，也不會因為生產的路由出問題而連不進設備。記得 SSH、SNMP、NTP、Syslog 都要指定來源 VRF。',
    },
  ],

  fhrp: [
    {
      h: '三種協定的比較',
      table: {
        head: ['', 'HSRP', 'VRRP', 'GLBP'],
        rows: [
          ['標準', 'Cisco', 'IETF（RFC 5798）', 'Cisco'],
          ['角色', 'Active / Standby', 'Master / Backup', 'AVG ＋ 最多 4 台 AVF'],
          ['虛擬 MAC', 'v1：0000.0c07.acXX；v2：0000.0c9f.fXXX', '0000.5e00.01XX', '0007.b400.XXYY（每台 AVF 一個）'],
          ['通告的位址', 'v1：224.0.0.2；v2：224.0.0.102（UDP 1985）', '224.0.0.18（IP 協定 112）', '224.0.0.102（UDP 3222）'],
          ['預設計時', 'Hello 3 秒、Hold 10 秒', '通告 1 秒、約 3 秒判定', 'Hello 3 秒、Hold 10 秒'],
          ['預設優先權', '100', '100（擁有 VIP 的是 255）', '100'],
          ['preempt', '預設關', '預設開', '預設關（AVG）'],
          ['負載分擔', '要靠不同 VLAN 交錯', '同左', '同一個 VLAN 內就能分擔'],
        ],
      },
    },
    {
      h: '運作的細節',
      list: [
        '主機的閘道填虛擬 IP，ARP 得到的是虛擬 MAC。換手的時候 IP 與 MAC 都不變，主機什麼都不用做；新的 Active 會送一個 gratuitous ARP 讓交換器更新 MAC 位址表。',
        'HSRP 的狀態：Initial → Learn → Listen → Speak → Standby → Active。兩台都是 Active 代表彼此聽不到 Hello（VLAN 沒通、ACL 擋掉、驗證不符）。',
        'HSRP v1 的群組編號只到 255、不支援 IPv6；v2 到 4095，而且兩個版本不互通。',
        'VRRP 可以直接拿某一台的真實介面位址當虛擬 IP，那一台的優先權自動變成 255。',
        'GLBP 的 AVG 負責回答 ARP，輪流把不同 AVF 的虛擬 MAC 發給主機，所以同一個網段的主機會分散到好幾台閘道上。',
      ],
    },
    {
      h: '追蹤與對齊',
      p: [
        '閘道那一台「自己活著、但上行斷了」的時候，它照樣當 Active，封包送到它那裡卻出不去。用物件追蹤讓它自己降低優先權：track 1 interface Gi0/0/0 line-protocol，再 standby 1 track 1 decrement 20。降下來之後要比另一台低，而且另一台要有 preempt 才會接手。追蹤的也可以是 IP SLA（上行的遠端通不通），比只看介面可靠。',
        '第二層要跟著對齊：某個 VLAN 的 STP 根橋要和它的 HSRP Active 是同一台。不然主機的訊框會先被生成樹帶到根橋，再穿過兩台核心之間的線回到真正的閘道。',
      ],
      code: { v: 'Cisco IOS', c: ['track 1 interface GigabitEthernet1/0/24 line-protocol', '!', 'interface Vlan10', ' ip address 10.10.10.2 255.255.255.0', ' standby version 2', ' standby 10 ip 10.10.10.1', ' standby 10 priority 110', ' standby 10 preempt delay minimum 60', ' standby 10 track 1 decrement 20', ' standby 10 authentication md5 key-string S3cret!', '!', 'show standby brief'] },
      note: 'preempt delay 很實用：剛開機的路由器介面先 up，路由協定卻還沒收斂，這時候就搶回 Active 會把流量吸進一個還沒準備好的黑洞。延遲一分鐘再搶。',
    },
  ],

  bfd: [
    {
      h: '它解決什麼問題',
      p: [
        '線路直接斷掉（介面 down）時，路由協定馬上就知道。麻煩的是中間隔著交換器、電信的傳輸設備或光電轉換器：對方已經不見了，自己這一端的燈卻還亮著，只能等協定自己的計時器（OSPF 40 秒、BGP 180 秒、HSRP 10 秒）。',
        '把每個協定的 Hello 都調到毫秒等級很耗 CPU，而且每個協定都要調一次。BFD 是一個獨立、非常輕量的偵測協定：兩端互送小小的控制封包（UDP 3784），連續幾個沒收到就通知所有註冊的協定「這個鄰居不見了」。偵測只做一次，OSPF、EIGRP、BGP、HSRP、靜態路由都可以共用。',
      ],
    },
    {
      h: '參數與模式',
      list: [
        'bfd interval 50 min_rx 50 multiplier 3：每 50 毫秒送一個、連續 3 個沒收到就判定失聯，偵測時間約 150 毫秒。',
        '兩端的間隔不必一樣，會協商成比較慢的那個值。',
        'echo 模式：把封包送給對方、讓對方的轉送平面直接彈回來，不經過對方的 CPU，可以用更短的間隔。',
        '單跳 (single-hop) 用在直連的鄰居；多跳 (multi-hop) 用在隔著幾台路由器的 BGP 鄰居。',
      ],
      code: { v: 'Cisco IOS', c: ['interface GigabitEthernet0/0/0', ' bfd interval 50 min_rx 50 multiplier 3', '!', 'router ospf 1', ' bfd all-interfaces', 'router bgp 65010', ' neighbor 203.0.113.1 fall-over bfd', '!', 'show bfd neighbors details'] },
      note: 'BFD 兩端都要設，而且要在介面上開、也要讓協定註冊。常見的錯誤是只設了一端，或介面上有 bfd interval、協定裡卻沒有 bfd。間隔設得太激進，CPU 忙的時候會誤判，反而讓鄰居一直上下。',
    },
  ],

  pim: [
    {
      h: '群播的位址',
      table: {
        head: ['範圍', '用途'],
        rows: [['224.0.0.0/24', '只在同一個網段、不會被轉送（OSPF 224.0.0.5、HSRP 224.0.0.2、PIM 224.0.0.13）'], ['224.0.1.0 – 238.255.255.255', '全域的群播'], ['232.0.0.0/8', 'SSM：指定來源的群播'], ['239.0.0.0/8', '組織內部自己用（像私有位址）']],
      },
      p: ['群播的 MAC 位址是 01:00:5e 加上 IP 位址的後 23 個位元。IP 群播位址有 28 個位元可以變化，所以每 32 個群播 IP 會對應到同一個 MAC。規劃群組位址時要避開會撞在一起的組合，尤其是後三段和 224.0.0.x 一樣的位址（例如 239.0.0.5）。'],
    },
    {
      h: '主機到路由器：IGMP',
      list: [
        '主機想收某個群組，就送 IGMP Membership Report（加入）。離開時 v2 送 Leave；v1 不送，只能等逾時。',
        '路由器每隔一段時間送 Query 問「還有人要嗎」。同一個網段有好幾台路由器時，位址最小的當 querier。',
        'IGMPv3 可以指定來源（只要某個來源送的），是 SSM 的基礎。',
        '交換器用 IGMP snooping 偷聽 Report，只把群播送到有人加入的埠；沒有 snooping 或網段裡沒有 querier，群播就被當成廣播洪泛到整個 VLAN。',
      ],
    },
    {
      h: 'PIM Sparse Mode 與 RP',
      p: [
        'PIM 不自己算路由，它借用單點傳送的路由表做 RPF（Reverse Path Forwarding）檢查：群播封包必須從「往來源的那個方向」的介面進來才收，不然就丟掉。這是群播防迴圈的唯一機制，也是最常見的故障原因 —— 單點傳送的路由走 A 介面，群播卻從 B 介面進來。',
        'Sparse Mode 假設大部分的地方沒有人要收，所以要有人明確地加入才送。接收端的路由器不知道來源在哪裡，於是大家約定一個會合點 RP：接收端往 RP 的方向一路送 PIM Join，建出共享樹 (*,G)；來源端的路由器把資料包在 Register 裡送給 RP。兩邊在 RP 接上之後，接收端知道了來源的位址，可以直接往來源的方向再建一棵最短路徑樹 (S,G)，之後就不必繞經 RP。',
      ],
      list: [
        'RP 的位址每一台路由器都要知道，而且要一致：手動（ip pim rp-address）、Auto-RP（Cisco）、BSR（標準）。',
        '同一個網段有好幾台 PIM 路由器時會選一台 DR（優先權、再比位址大的），由它負責替主機送 Join 或替來源送 Register。',
        'SSM（232.0.0.0/8）：主機用 IGMPv3 直接說「我要 S 送的 G」，路由器直接往來源建 (S,G)，完全不需要 RP。',
      ],
    },
    {
      h: '排錯',
      list: [
        'show ip pim neighbor：每一段線的兩端是不是都開了 PIM。少一段，樹就斷在那裡。',
        'show ip pim rp mapping：這個群組的 RP 是誰，每一台看到的要一樣。',
        'show ip mroute：有沒有 (*,G) 與 (S,G) 的條目，Incoming interface 與 Outgoing interface list 對不對。OIL 是空的 (Null) 代表下游沒有人要。',
        'show ip rpf <來源位址>：RPF 介面是哪一個。和群播實際進來的介面不一樣就是 RPF failure；用 ip mroute 靜態指定，或調整單點傳送的路由。',
      ],
      note: '群播故障十之八九是這三件事之一：某一段沒開 PIM、RP 不一致或到不了、RPF 檢查沒過。',
    },
  ],

  'ip-sla': [
    {
      h: '探測的種類',
      table: {
        head: ['類型', '量什麼', '常見用途'],
        rows: [['icmp-echo', '通不通、來回時間', '追蹤上行、浮動靜態路由'], ['udp-jitter', '延遲、抖動、遺失（要對端開 responder）', '語音與視訊的品質'], ['tcp-connect', '某個 TCP 埠連不連得上', '確認服務活著，不只是主機活著'], ['http / dns', '網頁回應時間、名稱解析', '從使用者的角度量服務'], ['path-echo', '沿路每一站的來回時間', '找出哪一站變慢']],
      },
    },
    {
      h: '和追蹤物件搭配',
      p: ['IP SLA 只負責量，結果要透過 track 物件才能影響別的功能：靜態路由（ip route … track 1）、政策路由（verify-availability）、HSRP（standby … track）。track 可以加延遲（delay down 10 up 30），避免探測偶爾掉一個封包就讓路由跟著上下跳。'],
      list: [
        '探測的目標要選「能代表那條線真的可用」的位址：ISP 的閘道通，不代表 ISP 後面通。常見的做法是探測網際網路上穩定的位址，並指定來源介面與一條只給探測用的主機路由，確保探測一定走被測的那條線。',
        'timeout 是多久沒回應算失敗；threshold 是回應太慢的門檻；frequency 是多久測一次。timeout 不能比 frequency 長。',
        '多個 track 可以用 track list 做 and / or：兩個目標都不通才算線路掛了，比較不會誤判。',
      ],
      code: { v: 'Cisco IOS', c: ['ip sla 1', ' icmp-echo 8.8.8.8 source-interface GigabitEthernet0/0/0', ' threshold 500', ' timeout 1000', ' frequency 5', 'ip sla schedule 1 life forever start-time now', '!', 'track 1 ip sla 1 reachability', ' delay down 10 up 30', '!', 'ip route 8.8.8.8 255.255.255.255 203.0.113.1', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1 track 1', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1 250', '!', 'show ip sla statistics', 'show track'] },
    },
  ],
};
