// 學習路線：從 180 多關裡依目的挑出一條有先後順序的路（關卡選單的「學習路線」）
//
// 每一條：
//   id      識別名稱
//   t       名稱
//   who     適合誰（一句話）
//   d       學完之後會什麼
//   ic      圖示（ui/dom.js 的 ICONS）
//   steps   依序要做的階段：{ t: 階段名稱, d: 這一段在學什麼, ids: [關卡 id…] }
//
// 同一關可以出現在好幾條路線裡。關卡的 id 一定要存在（test/levels.test.mjs 會檢查）。

export const PATHS = [
  {
    id: 'start', t: '新手入門', ic: 'flag',
    who: '第一次接觸網路，或想把基礎重新走一遍',
    d: '從一條網路線開始：位址、交換、路由、DHCP、NAT、DNS、VLAN、Wi-Fi、防火牆，再學會自己找問題。',
    steps: [
      { t: '兩台電腦怎麼對話', d: 'IP 位址、子網路遮罩、ARP、Hub 與交換器的差別', ids: ['l01', 'l02', 'l174', 'l175'] },
      { t: '連上網際網路', d: 'DHCP、預設閘道、NAT、DNS；封包經過路由器時發生了什麼事', ids: ['l03', 'l04', 'l173', 'l177'] },
      { t: '資料怎麼送到對的程式', d: 'TCP 的三向交握、埠號、TCP 與 UDP', ids: ['l176', 'l05', 'l69'] },
      { t: '辦公室的網路', d: 'VLAN、Trunk、跨 VLAN 路由、子網路切割', ids: ['l06', 'l07', 'l08', 'l28'] },
      { t: '無線與安全的第一步', d: 'Wi-Fi 的加密、防火牆政策與 DMZ、靜態路由', ids: ['l13', 'l09', 'l10'] },
      { t: '自己找問題', d: '從症狀一路查到原因：位址、VLAN、路由、NAT、ACL、DNS', ids: ['l36', 'l37', 'l38'] },
    ],
  },
  {
    id: 'ccna', t: 'CCNA 重點', ic: 'award',
    who: '準備 Cisco CCNA 200-301，或想要有系統地學企業網路',
    d: '照考試大綱的六個領域挑出最有代表性的關卡：網路基礎、網路存取、IP 連線、IP 服務、安全基礎、自動化。',
    steps: [
      { t: '1.0 網路基礎', d: '元件、拓撲、線材、TCP / UDP、IPv4 / IPv6 位址、交換的運作', ids: ['l01', 'l02', 'l174', 'l173', 'l176', 'l28', 'l30', 'l39', 'l34', 'l70'] },
      { t: '2.0 網路存取', d: 'VLAN、Trunk、CDP / LLDP、EtherChannel、生成樹、無線架構', ids: ['l06', 'l07', 'l08', 'l46', 'l24', 'l23', 'l32', 'l14', 'l15', 'l55'] },
      { t: '3.0 IP 連線', d: '路由表、靜態路由、OSPF、第一跳備援', ids: ['l10', 'l22', 'l27', 'l47', 'l48', 'l25', 'l35'] },
      { t: '4.0 IP 服務', d: 'NAT、NTP、DHCP、DNS、SNMP、Syslog、QoS、SSH、TFTP', ids: ['l29', 'l131', 'l177', 'l26', 'l71', 'l178', 'l99', 'l43', 'l45', 'l42', 'l40'] },
      { t: '5.0 安全基礎', d: '設備加固、ACL、第二層安全、AAA、VPN、無線安全', ids: ['l149', 'l19', 'l18', 'l17', 'l16', 'l31', 'l33', 'l116', 'l20', 'l21', 'l13'] },
      { t: '6.0 自動化與可程式化', d: 'REST API 與 JSON、Ansible、控制器式網路', ids: ['l58', 'l59', 'l62'] },
    ],
  },
  {
    id: 'trouble', t: '故障排除實戰', ic: 'search',
    who: '已經會設定，想練「網路壞了怎麼查」',
    d: '每一關都是一個已經在運作、卻出了問題的網路。由下而上：實體層、交換、路由、服務，再到 VPN 與效能。',
    steps: [
      { t: '實體層與位址', d: '線、燈號、雙工、IP 衝突', ids: ['l02', 'l36', 'l39', 'l135', 'l164', 'l115'] },
      { t: '交換', d: 'VLAN、Trunk、生成樹、廣播風暴', ids: ['l37', 'l67', 'l85', 'l122', 'l139', 'l166'] },
      { t: '路由', d: '回程路由、OSPF 鄰居、recursive routing、重分配', ids: ['l38', 'l66', 'l88', 'l129', 'l130'] },
      { t: '服務與應用', d: 'DNS、NAT、DHCP、憑證、多點傳送', ids: ['l71', 'l178', 'l132', 'l156', 'l74', 'l148', 'l144'] },
      { t: 'VPN 與效能', d: 'NAT 例外、MTU、時鐘、頻寬被誰吃掉', ids: ['l68', 'l76', 'l101', 'l97', 'l75'] },
      { t: '找出是誰動的', d: '紀錄、對時、設定封存、版本控制', ids: ['l99', 'l65', 'l114'] },
    ],
  },
  {
    id: 'security', t: '網路安全', ic: 'shield',
    who: '準備 Security+，或負責公司的防火牆與交換器安全',
    d: '從邊界到存取層：防火牆與 ACL、第二層攻擊與防護、身分驗證、次世代防火牆、VPN 與憑證。',
    steps: [
      { t: '邊界', d: '防火牆政策、DMZ、ACL、有狀態與無狀態', ids: ['l09', 'l178', 'l18', 'l69', 'l141', 'l123'] },
      { t: '第二層的攻擊與防護', d: 'DHCP、ARP、MAC flooding、VLAN hopping、生成樹', ids: ['l16', 'l31', 'l17', 'l83', 'l46', 'l84', 'l32', 'l86'] },
      { t: '你是誰：身分與存取', d: '802.1X、RADIUS、EAP-TLS、TACACS+、AD', ids: ['l33', 'l102', 'l116', 'l146'] },
      { t: '設備加固', d: '管理介面、密碼、帶外管理', ids: ['l19', 'l149', 'l126'] },
      { t: '次世代防火牆', d: '網頁過濾、SSL 檢查、應用程式控管、IPS、防毒、DoS 政策', ids: ['l124', 'l127', 'l133', 'l179'] },
      { t: 'VPN 與憑證', d: 'IPsec、SSL-VPN、PKI、HTTPS', ids: ['l20', 'l21', 'l89', 'l101', 'l74', 'l165'] },
    ],
  },
  {
    id: 'wan', t: '廣域網路與 VPN', ic: 'route',
    who: '要把好幾個據點接起來的人',
    d: '專線、撥接、雙線路備援，各種通道（IPsec、GRE、VTI、DMVPN），到 SD-WAN 與業者的 MPLS。',
    steps: [
      { t: '線路與備援', d: 'PPPoE、靜態路由、浮動靜態路由、IP SLA', ids: ['l10', 'l150', 'l22', 'l63'] },
      { t: '站對站 VPN', d: 'IPsec、Hub-and-Spoke、NAT 例外、MTU、NAT-T', ids: ['l20', 'l54', 'l68', 'l76', 'l92'] },
      { t: '通道上面跑路由', d: 'GRE、GRE over IPsec、VTI、DMVPN', ids: ['l88', 'l89', 'l90', 'l91'] },
      { t: '遠端存取', d: 'SSL-VPN：分割通道、全通道、AD 帳號', ids: ['l21', 'l146', 'l172'] },
      { t: '業者的服務', d: 'SD-WAN、Metro Ethernet、MPLS L3VPN、BGP', ids: ['l117', 'l163', 'l168', 'l134', 'l171', 'l50'] },
    ],
  },
  {
    id: 'dc', t: '資料中心與雲端', ic: 'rack',
    who: '機房、虛擬化平台或雲端網路的管理者',
    d: '機櫃裡的線與電、Spine-Leaf、負載平衡、虛擬交換器與容器，再到公有雲的 VPC 與基礎架構即程式碼。',
    steps: [
      { t: '機房的實體', d: '光纖、收發器、breakout、雙電源、UPS', ids: ['l11', 'l30', 'l115', 'l128', 'l125', 'l157'] },
      { t: '架構與備援', d: 'Spine-Leaf、vPC、堆疊、Jumbo Frame、負載平衡', ids: ['l12', 'l155', 'l153', 'l75', 'l152'] },
      { t: '大型機房與 GPU 叢集', d: '用 eBGP 當 underlay 的 Clos 架構、每一條上行都要用到；GPU 叢集的後端網路與 rail 的接法', ids: ['l191', 'l192'] },
      { t: '虛擬化', d: 'vSwitch、NIC teaming、vMotion、VRF、容器', ids: ['l70', 'l151', 'l160', 'l158', 'l72', 'l73'] },
      { t: '公有雲', d: 'VPC、子網路、安全群組、負載平衡、Transit Gateway、Terraform', ids: ['l60', 'l61', 'l109', 'l110', 'l112'] },
    ],
  },
  {
    id: 'wifi', t: '無線網路', ic: 'bolt',
    who: '要規劃、架設或排除 Wi-Fi 問題的人',
    d: '從家裡的一台路由器，到整棟樓用控制器管理的基地台：頻道、加密、訪客、漫遊與訊號。',
    steps: [
      { t: '基礎', d: 'SSID、加密、PoE、頻道、訪客隔離', ids: ['l13', 'l14', 'l15'] },
      { t: '無線環境', d: '頻道寬度與 DFS、6 GHz、牆面衰減、mesh', ids: ['l104', 'l105', 'l56', 'l154'] },
      { t: '無線控制器', d: 'CAPWAP、option 43、N+1、FlexConnect', ids: ['l55', 'l106', 'l107'] },
      { t: '漫遊與驗證', d: 'sticky client、802.11k/v/r、802.1X、訪客入口', ids: ['l57', 'l140', 'l33', 'l108'] },
    ],
  },
  {
    id: 'ops', t: '維運與自動化', ic: 'terminal',
    who: '網路已經在跑，要把它管好、管得更省力',
    d: '備份、升級、監控、對時、權限，再用 API、Ansible、範本與 Git 把重複的事交給程式。',
    steps: [
      { t: '日常維運', d: '備份與還原、韌體升級、SSH、Console', ids: ['l40', 'l41', 'l42', 'l126', 'l143'] },
      { t: '看得見才管得了', d: 'SNMP、NetFlow、NTP 與 Syslog、CDP / LLDP 畫拓撲', ids: ['l43', 'l97', 'l99', 'l103'] },
      { t: '權限與稽核', d: 'AAA、設定封存、帶外管理', ids: ['l116', 'l65', 'l142'] },
      { t: '自動化', d: 'RESTCONF、NETCONF、Ansible、控制器範本、Git', ids: ['l58', 'l111', 'l59', 'l62', 'l113', 'l114'] },
    ],
  },
  {
    id: 'expert', t: 'CCNP / CCIE 進階', ic: 'star',
    who: '已經有 CCNA 的程度，準備 CCNP Enterprise（ENCOR、ENARSI），或想挑戰 CCIE 風格的實作題',
    d: '進階路由的每一塊先各自練熟：OSPF 的區域類型、EIGRP、重分配、BGP、通道與 DMVPN、MPLS L3VPN，再做有設計限制的實作題，最後是好幾張工單疊在一起的大拓撲。',
    steps: [
      { t: 'OSPF 做到多區域', d: 'DR / BDR、cost 與等價多路徑、ABR 與彙總、stub / NSSA、BFD', ids: ['l47', 'l48', 'l49', 'l79', 'l80', 'l95'] },
      { t: 'EIGRP 與路由重分配', d: 'DUAL 與 feasible successor、彙總、variance、種子 metric、管理距離與路由標籤、政策路由', ids: ['l129', 'l77', 'l78', 'l185', 'l186'] },
      { t: 'BGP', d: 'eBGP 的路徑選擇、iBGP 與 next-hop、route reflector、community 與流量工程', ids: ['l50', 'l81', 'l180', 'l181'] },
      { t: '通道與 DMVPN', d: 'GRE、GRE over IPsec、VTI、mGRE 與 NHRP、用憑證驗證的 IKEv2', ids: ['l88', 'l89', 'l90', 'l91', 'l101'] },
      { t: 'VRF 與 MPLS L3VPN', d: 'VRF-Lite、路由洩漏、LDP、VPNv4、route-target、PE-CE、共用服務', ids: ['l72', 'l82', 'l171', 'l134', 'l182'] },
      { t: '園區的高可用', d: 'MST、STP 的防護、FHRP 與追蹤、EtherChannel、多播', ids: ['l138', 'l139', 'l64', 'l96', 'l183', 'l145'] },
      { t: '看得見、守得住、自己會處理', d: 'SPAN 與 RSPAN 的側錄、CoPP 保護設備自己的 CPU、EEM 在事件發生時自動下指令', ids: ['l188', 'l189', 'l190'] },
      { t: '多張工單的總驗收', d: '先讀圖、由下往上查，修好一個地方再回頭確認沒有弄壞別的', ids: ['l184', 'l187'] },
    ],
  },
];

export const PATH = Object.fromEntries(PATHS.map((p) => [p.id, p]));
/** 一條路線裡所有的關卡 id（依順序，不重複） */
export const pathIds = (p) => [...new Set(p.steps.flatMap((s) => s.ids))];
