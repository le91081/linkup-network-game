# LinkUp 功能規劃

最後更新：2026-11-22

README 說明「現在有什麼、怎麼玩」，這份文件說明「整體應該做到什麼、目前做到哪裡、還差多少」。
每完成或新增一項功能，請同時更新這裡的狀態。

## 目標與原則

讓玩家用和真實設備相同的操作（接線、圖形介面、命令列）把網路架起來、把壞掉的網路修好，學到的東西可以直接用在工作和證照考試上。

1. **貼近真實**：行為、預設值、計時器、錯誤訊息與指令語法都以真實設備為準。不得不簡化的地方要寫進 README 的「模擬的範圍與簡化」，不能默默省略。
2. **一份設定、多種操作方式**：圖形介面、CLI、關卡的參考解法改的都是同一份設定，結果必須一致。
3. **失敗要說得出原因**：測試沒過時，要指出卡在哪一台設備、哪一層、為什麼。
4. **引擎不依賴瀏覽器**：`src/engine/` 的每一項行為都要能用 Node 測試，新功能要附測試。
5. **對照證照大綱**：關卡與題庫對應到 CCNA、Network+、Security+ 的條目，缺口要看得見。

## 狀態圖例

| 標記 | 意思 |
| --- | --- |
| ✅ | 已完成，有測試涵蓋 |
| 🟡 | 部分完成，說明欄寫出還缺什麼 |
| ⬜ | 尚未開始 |

## 總覽

數字是下面各節表格的列數，只代表項目的多寡，不代表工作量（「BGP」和「音效」都算一列）。

| 領域 | ✅ 已完成 | 🟡 部分完成 | ⬜ 尚未開始 |
| --- | --- | --- | --- |
| 1. 實體層與接線 | 9 | 1 | 4 |
| 2. 第二層：交換 | 15 | 0 | 2 |
| 3. 第三層：路由 | 14 | 1 | 2 |
| 4. IP 服務 | 11 | 3 | 0 |
| 5. 網路安全 | 12 | 2 | 3 |
| 6. VPN 與廣域網路 | 10 | 1 | 2 |
| 7. 無線網路 | 6 | 3 | 1 |
| 8. IPv6 | 5 | 3 | 0 |
| 9. 高可用 | 8 | 0 | 3 |
| 10. 時間、效能與流量 | 9 | 2 | 0 |
| 11. 設備管理與維運 | 14 | 2 | 2 |
| 12. 自動化、雲端與虛擬化 | 5 | 1 | 0 |
| 13. 設備型錄 | 10 | 2 | 1 |
| 14. 遊戲系統 | 16 | 1 | 5 |
| 15. 介面與體驗 | 6 | 1 | 7 |
| 16. 工程品質 | 5 | 1 | 4 |
| **合計** | **155** | **24** | **36** |

另外：關卡 109 關（第 17 節）、證照條目涵蓋情形（第 18 節）、建議的實作順序（第 19 節）。

---

## 1. 實體層與接線

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 線材種類與距離上限 | ✅ | Cat6 銅纜、DAC、多模光纖 (OM4 + SR)、單模光纖 (OS2 + LR)；超過距離就沒有燈號 |
| 連接埠型式 | ✅ | RJ45、SFP+ / SFP28、QSFP28，線材要和連接埠相符 |
| 速率與雙工協商 | ✅ | 自動協商、寫死 `speed` / `duplex`、duplex mismatch、兩端速率寫死成不同值時連線建立不起來 |
| PoE 供電 | ✅ | 只有 PoE 埠能供電；依等級保留瓦數、Cisco 的電話與 AP 用 CDP（AP 也可以用 LLDP）協商實際用量、`%ILPOWER` 的供電與拒絕紀錄（→ 12-3）、交換器的總預算、`power inline never`、`show power inline`；受電設備插電後才開機，交換器重開它們也跟著重開。沒有 802.3bt / UPOE |
| 設備電源、介面 shutdown | ✅ | 任何設備可以關機，介面可以停用，錯誤訊息會指出是哪一台 |
| 連線狀態與原因 | ✅ | 點網路線可以看線材、距離、協商結果與斷線原因 |
| 線路故障 | 🟡 | 故障演練會切斷指定的線路；線對斷掉的網路線會自動降到 100 Mbps（寫死 1000 時連不起來）；沒有接觸不良、光衰過大這類造成 CRC 錯誤與間歇掉包的故障 |
| 介面計數器 | ✅ | 由真正跑過的訊框累積：封包數、位元組、廣播 / 多點傳送、CRC、runt、碰撞、late collision；背景有 BPDU、CDP、OSPF Hello、VRRP；`show interfaces`、`clear counters`、`netstat -e`、FortiGate 的 `diagnose hardware deviceinfo nic` |
| 收發器不相容 | ⬜ | 目前線材與收發器是成套的，沒辦法接出 SR 對 LR、速率不符的情況 |
| 分歧線 (breakout) | ⬜ | 40G / 100G 拆成 4 條 10G / 25G |
| Console 線與帶外管理 | ⬜ | Console 埠、管理埠 (mgmt)、帶外管理網路 |
| MTU 與 Jumbo Frame | ✅ | 主機網卡的 MTU（Windows 的 `netsh … set subinterface … mtu=`、Linux 的 `ip link set … mtu`、網路設定分頁）、路由器的 `mtu` / `ip mtu`、Catalyst 2960 的 `system mtu jumbo`（存檔、重新開機才生效）、Catalyst 9300 的 `system mtu`、Nexus 每個埠的 `mtu`、ESXi 的 vSwitch 與 vmk MTU；交換器收到太大的訊框當成 giant 丟掉（計數器、不回 ICMP）；`show system mtu`、`show interfaces` 的 MTU 與 giants；Jumbo Frame 讓傳輸速率從 94% 提高到 98% |
| err-disabled 自動復原 | ✅ | `errdisable recovery cause` / `interval`，見第 5 節 |
| 機櫃與配線架視圖 | ⬜ | 機櫃、配線架、樓層平面圖上的實體位置 |

## 2. 第二層：交換

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| Hub 與非網管交換器 | ✅ | Hub 泛洪到每一個埠、半雙工；非網管交換器形成迴圈會判定為廣播風暴 |
| VLAN、Access / Trunk | ✅ | Native VLAN、Allowed VLAN、`interface range` |
| VLAN 設定錯誤偵測 | ✅ | Trunk 對 Access、Native VLAN 不一致、兩端 Access VLAN 不同 |
| STP | ✅ | 每個 VLAN 一棵樹（近似 Rapid PVST+）、根橋優先權、阻擋埠 |
| STP 計時 | ✅ | 邊緣埠 listening + learning 共 30 秒、PortFast、交換器之間 2 秒 |
| BPDU Guard、Root Guard | ✅ | 違規的埠會被擋下並說明原因 |
| EtherChannel | ✅ | LACP active / passive、on；兩端模式不相容、成員接到不同對端都會偵測 |
| ARP | ✅ | 廣播詢問、快取、逐筆逾時、介面斷線時清除、`clear arp` |
| MAC 位址表 | ✅ | 從實際的流量學習、300 秒過期（可調整）、斷線與生成樹拓撲改變時清除、不認得的目的 MAC 會泛洪；`show mac address-table`、`clear mac address-table dynamic` |
| 靜態 MAC 項目 | ✅ | `mac address-table static <MAC> vlan <V> interface <埠> \| drop`：不會老化、不會被動態學習蓋掉（MAC 偽造搬不走它），drop 丟掉那個 MAC 的訊框；MAC 位址表有容量（2960 8,192 筆、9300 32K、Nexus 92K），`show mac address-table count \| static \| interface` |
| CDP 與 LLDP | ✅ | 依計時器通告、鄰居表與 holdtime、LLDP 的 shutdown 通告、經過 Hub / 非網管交換器的行為、全域與每個埠的開關、`show cdp / lldp neighbors [detail]`、traffic、`clear`；Native VLAN 與雙工不一致的訊息靠 CDP；LLDP-MED 給電話語音 VLAN |
| DTP | ✅ | Catalyst 出廠 `dynamic auto`、`dynamic desirable`、`nonegotiate`、運作中的模式與原因、`show interfaces switchport`、`show dtp`；攻擊工具偽裝成交換器 (VLAN hopping)；Nexus 沒有 DTP |
| VTP | ⬜ | VLAN 資料庫同步 |
| Voice VLAN | ✅ | `switchport voice vlan`：資料不帶標籤、語音帶標籤；電話從 CDP 或 LLDP-MED 學到，也可以手動設定 |
| Private VLAN、Storm Control | ✅ | Private VLAN（Catalyst 9300、Nexus）：primary / isolated / community、host 與 promiscuous 埠、SVI 的 `private-vlan mapping`、DHCP 照樣通、`show vlan private-vlan`；2960 只有 `switchport protected`。Storm Control：`storm-control broadcast level`（頻寬的百分比）與 `action shutdown \| trap`，狂送的廣播佔掉整個 VLAN 每一段線路的頻寬並算進 broadcasts 計數器，`show storm-control`、`%STORM_CONTROL-3-FILTERED / SHUTDOWN`、err-disabled 原因 storm-control |
| STP 進階 | ⬜ | MST、Loop Guard、UDLD、拓撲變更通知、交換器不是直接相連的拓撲 |
| SPAN（連接埠鏡像） | ✅ | `monitor session` 與圖形介面；目的埠不轉送一般流量；搭配主機的封包擷取 |

## 3. 第三層：路由

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 直連、靜態、預設路由 | ✅ | 最長遮罩比對；下一站不在直連網段時會標示無效；`show ip route` 和真的 IOS 一樣依主網段分組、列出 L 路由、Gateway of last resort 與動態路由的存在時間，可以篩選協定或查單一網段 |
| 管理距離與浮動靜態路由 | ✅ | |
| 回程路由檢查 | ✅ | 去程通、回程不通時會分開說明 |
| 跨 VLAN 路由 | ✅ | 子介面 (router-on-a-stick)、SVI、routed port (`no switchport`) |
| OSPF 單一區域 | ✅ | `network` 敘述或介面上的 `ip ospf … area`、cost、`default-information originate`；鄰居建立（乙太網路要等 40 秒的 Wait timer、點對點約 4 秒）、Dead timer 40 秒 |
| TTL 與路徑追蹤 | ✅ | TTL 逐站遞減；主機有 `tracert` |
| OSPF 進階 | ✅ | DR / BDR 選舉（priority、Router ID、不搶位、BDR 升上來、`clear ip ospf process`）、Router ID 在程序啟動時決定（Loopback）、Router ID 重複、`passive-interface [default]`、Hello / Dead 可調、network type、明文與 MD5 驗證、MTU 不一致卡在 EXSTART、參考頻寬、多區域與 ABR、`area range` 彙總、O IA 與 O*E2；stub / totally stubby / NSSA / totally NSSA（Hello 的選項位元要一致、ABR 送預設的 Summary LSA、`default-cost`、Type-7 的 O N1 / N2、Router ID 最大的 NSSA ABR 轉成 Type-5 並帶 forwarding address、`default-information-originate`、`no-redistribution`）；`show ip ospf` / `neighbor` / `interface` / `database` |
| ECMP（等價多路徑） | ✅ | cost 一樣的路最多 `maximum-paths` 條（預設 4）一起放進路由表；依來源與目的位址雜湊（CEF 的 per-destination），同一對位址永遠走同一條 |
| ICMP 細節 | 🟡 | 分段與 DF、ICMP「需要分段」與 PMTUD（被 ACL 擋掉就是黑洞）、IPsec 的額外負擔（通道裡 1427）、PPPoE 1492、TCP 的 MSS 與 `ip tcp adjust-mss`、家用路由器自動調整 MSS、ACL 的 ICMP 類型（`packet-too-big`、`unreachable`、`echo`…）、`ping … size … df-bit source …`、`ping -f -l`、`ping -M do -s` 已完成；還沒有 Redirect、其他 Unreachable 類型的細節 |
| IOS 的 `traceroute` | ✅ | 逐站顯示，每一站三個探測封包；ECMP 時跟著雜湊走 |
| BGP（eBGP） | ✅ | TCP 179 的鄰居狀態（Idle / Active / OpenSent / Established）、remote-as 寫錯 (Bad Peer AS)、hold time 180 秒、路徑向量與迴圈偵測、最佳路徑（weight、local-preference、AS path、origin、MED）、route-map / prefix-list / as-path ACL、`default-originate`；雙 ISP 的轉運站問題 |
| iBGP 與 BGP 進階 | ✅ | iBGP（AD 200、可以隔多台路由器、Loopback 與 `update-source`，一個方向對得上就能建立）、下一站不變與 `next-hop-self`、inaccessible 的路不能當最佳路徑、遞迴查下一站、iBGP split horizon 與 BGP 黑洞、route reflector（Originator、Cluster list）、最佳路徑補上 eBGP 優先與 IGP metric、MED 只比同一個鄰居 AS、`network` 的 MED 是 IGP metric、RIB-failure、`ebgp-multihop`（真的看 TTL）與 `disable-connected-check`、community（`set community … additive`、`ip community-list standard`、`match community`、`send-community`、no-export / no-advertise、`ip bgp-community new-format`）、`redistribute bgp` 不含 iBGP 的路（`bgp redistribute-internal`）、`show ip bgp <網段>`；BGP 還不分 VRF |
| EIGRP、RIP | ⬜ | 優先度低：CCNA v1.1 只要求看得懂 |
| VRF（VRF-Lite） | ✅ | `vrf definition`（`rd`、`address-family ipv4`）與舊式的 `ip vrf`；介面的 `vrf forwarding` 會清掉原本的 IP；同一個路由表裡網段重疊會被拒絕（`% … overlaps with …`），不同 VRF 可以重疊；`ip route vrf`、`show vrf`、`show ip route vrf`、`ping vrf`；圖形介面的 VRF 卡片與介面的 VRF 選單；每個 VRF 自己的 OSPF 程序（`router ospf <pid> vrf <名稱>`，每個（路由器, VRF）是各自的節點，和 CE 的全域程序成為鄰居）；用靜態路由洩漏（`ip route vrf X … global`、出口介面在另一個 VRF）。BGP 還不分 VRF，沒有 MP-BGP 的 route-target 匯入匯出 |
| 路由重分配、PBR | ✅ | `redistribute static \| connected \| bgp <AS>` 進 OSPF（ASBR、Type-5 LSA、O E2 固定 metric 與 O E1 加上內部 cost、種子 metric 20 / 1、預設路由不會跟著出去、IOS XE 自動補 subnets、`metric` / `metric-type` / `tag` / `route-map`）；`redistribute static \| connected \| ospf` 進 BGP（origin ?、MED 是原本的 cost、跑 OSPF 的直連網段也算）；route-map 的 `match ip address prefix-list \| <ACL>`、`match tag`、`set metric \| metric-type \| tag`；政策路由 `ip policy route-map`、`ip local policy route-map`、`set ip next-hop`（不通就照路由表）、`set ip default next-hop`；`show route-map`（Policy routing matches）、`show ip policy`、`show ip ospf database` 的 Type-5；路由分頁的重分配卡片與政策路由卡片。還沒有 EIGRP / RIP 之間的重分配與迴圈 |
| IP SLA 與物件追蹤 | ✅ | 見第 9 節 |
| 多播 | ⬜ | IGMP、PIM |

## 4. IP 服務

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| DHCP 伺服器 | ✅ | 位址池、排除位址、閘道、DNS、保留位址（依 MAC） |
| DHCP 四步驟與 Relay | ✅ | Discover → Offer → Request → Ack 的動畫，經由 Relay 會顯示轉送 |
| DHCP 租約 | ✅ | 租約長度、過半續約、`ipconfig /release` / `/renew`、到期、伺服器失聯時沿用舊租約 |
| 衝突偵測 | ✅ | 伺服器發放前先 ping；IP 位址衝突會標示出來 |
| APIPA | ✅ | 拿不到租約時退回 169.254.x.x |
| DNS 查詢 | ✅ | 自己架的 DNS 伺服器（A / CNAME / MX / PTR、每筆的 TTL）、用戶端依 TTL 快取（`ipconfig /displaydns` / `/flushdns`）、`nslookup` 直接問伺服器不看快取、`-type=mx` 與反查、家用路由器的 DNS 代理；還沒有 AAAA、轉送器與遞迴伺服器的快取、區域轉送 |
| NAT | ✅ | PAT、一對一靜態 NAT、連接埠轉發、用 ACL 指定範圍、NAT 例外；可以查看轉換表 |
| NAT 進階 | 🟡 | 轉換表的閒置逾時已完成（依協定不同，可以用 `ip nat translation` 調整）；還沒有位址池 (pool)、Hairpin NAT |
| PPPoE | 🟡 | 帳號密碼驗證與撥接；IOS 沒有 Dialer 介面，只能在圖形介面設定 |
| NTP | ✅ | 每台設備有自己的時鐘；每 64 秒輪詢，IOS 約四分鐘後才採信；`ntp master`、`clock set`、`clock timezone`；伺服器失聯八次輪詢後失去同步；`service timestamps log | debug`（datetime / msec / localtime / show-timezone / year、uptime，預設和 IOS 15 一樣用 UTC → 11-8） |
| Syslog | ✅ | 設備記下介面、OSPF、VRRP、VPN、err-disabled 等事件，用 UDP 514 送到伺服器；`logging trap` 設定門檻；伺服器有收件畫面 |
| SNMP | ✅ | v2c community（RO / RW、綁標準 ACL）、v3 的 group / user（SHA + AES）、Trap（linkUp / linkDown / coldStart / authenticationFailure）；網管伺服器每 60 秒輪詢、依計數器差值算使用率；FortiGate 的 sysinfo / community / hosts / user 與 allowaccess snmp；沒有 MIB 瀏覽器與 SET |
| TFTP / FTP / SCP | 🟡 | TFTP（UDP 69，512 位元組區塊，速度看來回時間）與 FTP（帳號密碼、明文）：設定備份與還原、映像檔下載、伺服器的檔案分頁；沒有 SCP / SFTP |
| HTTP(S) 服務內容與憑證 | ✅ | 網站伺服器的「網站」分頁（標題、HTTP 301 轉到 HTTPS、目前的憑證、產生 CSR 交給 CA 簽發）；`curl` 會驗證憑證並給出和真的 curl 一樣的錯誤（`(60)` 過期 / 尚未生效 / 名稱不符 / 自簽 / 不信任的簽發者、`(35)` 沒有憑證），`-k`、`-v`、`-I`、`-L`；任務目標 `https`。網路設備的管理網頁出廠是自簽憑證 |

## 5. 網路安全

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| ACL | ✅ | 標準、延伸、具名與編號；套用在介面的進 / 出方向；顯示命中次數 |
| 防火牆政策 | ✅ | 介面、位址物件與群組、服務、動作、NAT、順序調整、命中次數、隱含拒絕 |
| 狀態檢查 | ✅ | TCP 三向交握、連線紀錄，後續封包不重新比對政策 |
| DMZ 與 VIP | ✅ | |
| 防火牆紀錄 | ✅ | 每條新連線被哪一條政策放行或拒絕 |
| 管理介面加固 | 🟡 | 多個本機帳號（一人一個，`username` / `no username`）、SSH 取代 Telnet（要先有主機名稱、網域名稱、RSA 金鑰與 `login local`）、vty `access-class`、`exec-timeout`、`login block-for`、`banner motd`、FortiGate 各介面的 allowaccess 與 `admintimeout`、密碼以雜湊顯示；`enable secret` 會接受但沒有作用（模擬裡沒有 enable 模式） |
| DHCP Snooping、DAI | ✅ | |
| Port Security | ✅ | maximum、靜態 / sticky / 動態的安全位址（照 IOS 的順序學，打開 sticky 會把已經學到的轉成 sticky）、protect / restrict / shutdown（預設）、違規次數與 `%PORT_SECURITY-2-PSECURE_VIOLATION`、斷線時動態的安全位址清掉；`show port-security [interface \| address]` |
| err-disabled | ✅ | BPDU Guard 與 Port Security 關掉的埠會一直維持，原因排除也不會自己恢復：`shutdown` → `no shutdown`、重新開機，或 `errdisable recovery cause` / `interval`（原因還在就馬上再被關）；`show interfaces status err-disabled`、`show errdisable recovery` |
| 802.1X / RADIUS | ✅ | 有線埠與 WPA2-Enterprise 的帳號密碼驗證 (PEAP)；EAP-TLS：用戶端檢查 RADIUS 伺服器的憑證、伺服器檢查電腦憑證（信任的 CA、用各自的時鐘看有效期間），NPS 的伺服器憑證可以重新申請（→ 6-13） |
| Wi-Fi 加密 | ✅ | 開放、WEP、WPA2、WPA2 / WPA3 混合、WPA3 |
| 攻擊情境 | ✅ | 冒牌 DHCP、ARP 欺騙、搶根橋、未授權設備、密碼暴力嘗試（`login block-for`）、側錄 Telnet 明文密碼、DTP 偽裝成交換器的 VLAN hopping；MAC flooding（macof 把每一台走得到的交換器的表塞滿，unknown unicast 泛洪給攻擊者，擋住之後要等老化或 clear）；雙重標籤（Access 埠收自己 VLAN 的標籤、Native VLAN 的 Trunk 不加標籤，封包單向跳進別的 VLAN、繞過 ACL；`vlan dot1q tag native` 或改 Native VLAN）；冒牌的 IPv6 RA；狂送廣播的設備。還沒有 SYN flood |
| TACACS+ 與 AAA | ⬜ | 授權、稽核、權限等級 |
| IOS 進階過濾 | ⬜ | Zone-Based Firewall、時間型 ACL、Reflexive ACL |
| NGFW / UTM | ⬜ | IPS、防毒、網頁過濾、應用程式控管、SSL 檢查 |
| IPv6 安全 | ✅ | IPv6 ACL（見第 8 節）；冒牌的 Router Advertisement（主機用每一個 RA 的前綴各產生一個位址、預設閘道選 Router Preference 最高的）與 RA Guard（`ipv6 nd raguard policy` / `device-role host \| router` / `attach-policy`、`show ipv6 nd raguard policy`） |
| 憑證與 PKI | 🟡 | 公開 CA 與公司內部的 CA（公開 CA 不簽 .local、效期上限）、用戶端的信任清單（加入網域的電腦自動有公司的根憑證，`certutil -addstore root` 匯入）、有效期間用用戶端自己的時鐘判斷（`w32tm`、`timedatectl`、自動設定時間）、SAN 與萬用字元；沒有中繼憑證鏈、CRL / OCSP、ACME 自動續約，用在 802.1X 的 EAP-TLS（→ 6-13）與 IOS 的 IKEv2 rsa-sig（trustpoint、SCEP、revocation-check → 7-12） |

## 6. VPN 與廣域網路

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 站對站 IPsec | ✅ | IKEv1 與 IKEv2、預先共用金鑰；第一、第二階段分開協商，哪個階段不一致會分別指出；PFS |
| 跨廠牌 | ✅ | FortiGate 對 FortiGate、Cisco IOS (crypto map) 對 FortiGate |
| 先 NAT 再加密 | ✅ | 沒有設 NAT 例外時通道是 Up 的但流量進不去 |
| 遠端存取 SSL-VPN | 🟡 | 使用者、群組、入口、連接埠；加密流量在引擎內仍當成一層封裝處理 |
| ISP 線路型態 | ✅ | DHCP、固定 IP、PPPoE |
| 雙線路備援 | ✅ | 浮動靜態路由 |
| IKEv2 與憑證驗證 | ✅ | IKEv2：版本不一致、非對稱的預先共用金鑰、PFS 不一致要到第一次重新協商才失敗、IOS 的 proposal / policy / keyring / profile、FortiOS 的 `ike-version` 與 `psksecret-remote`、`show crypto ikev2 sa`。PKI：trustpoint、SCEP 的 `crypto pki authenticate` / `enroll`、`rsa-sig`、用自己的時鐘判斷有效期間、`revocation-check crl` 要拿得到 CRL、`identity local fqdn` 與 `match identity remote fqdn domain`、`%PKI-3-…` 紀錄、running-config 的 certificate chain（→ 7-12）。沒有 EAP 與 FortiGate 的憑證 |
| SA 的時間面 | ✅ | 協商 2 秒、兩個階段的金鑰壽命（兩端取較短的）與自動重新協商、DPD；IOS 沒設 keepalive 時要等金鑰到期才發現對端失聯 |
| NAT-T | ✅ | NAT-D 從 IKE 的來源位址偵測 NAT，兩端都開著時 IKE 與 ESP 改走 UDP 4500（NAT 設備保留轉換，總公司主動連過去也通）；關掉 NAT-T 時 ESP 被 PAT 丟掉；對端要指向 NAT 之後的位址；ACL 要放 UDP 4500（→ 7-11）。NAT keepalive 與轉換逾時沒有模擬 |
| GRE、IOS VTI、DMVPN | ✅ | Tunnel 介面（`tunnel source / destination / mode / key`、keepalive）、line protocol 看外層的路由、recursive routing 的暫停與 flapping、OSPF 的 cost 1000 與 point-to-point；`tunnel protection ipsec profile`（GRE over IPsec、VTI 的 line protocol 跟著 SA）；DMVPN 的 NHRP 註冊、multicast 複製、phase 2 的解析與 spoke 之間的動態 IPsec、phase 3 的 redirect / shortcut（H 路由）（→ 7-7 到 7-10）。沒有 OSPF point-to-multipoint、FortiGate 的 IPsec 介面模式、DMVPN 在 NAT 後面 |
| 多站台 | ✅ | Hub-and-Spoke（7-4：分公司之間在總公司解密再加密、VPN → VPN 政策、加密範圍與 NAT 例外）；DMVPN 的 spoke 之間動態建立通道（7-10） |
| SD-WAN | ⬜ | 健康檢查、依線路品質選路 |
| 專線、MPLS、Metro Ethernet | ⬜ | 至少要有觀念關卡 |

## 7. 無線網路

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| SSID 與多 SSID | ✅ | 每個 SSID 可以對應到不同的 VLAN |
| 頻段與頻道 | ✅ | 2.4 GHz / 5 GHz、頻道規劃、頻道重疊時速率減半 |
| 訊號模型 | ✅ | 依距離、發射功率與沿路穿過的牆估算 RSSI（材質不同、5 GHz 穿牆更差），決定頻段與速率；基地台之間的干擾也考慮牆 |
| 涵蓋範圍顯示 | ✅ | |
| 多台 AP | 🟡 | 漫遊已完成：sticky client（-75 dBm 以上不換）、802.11k/v 的 BSS Transition、換 VLAN 會換 IP、「走過去」的任務測試；802.11r 只有設定，還沒有模擬漫遊時間 |
| 無線控制器 | ✅ | Catalyst 9800 + 9120：CAPWAP 加入（手動指定的主要 / 次要控制器、option 43、同網段廣播）、N+1（heartbeat 逾時約 30 秒才加入下一台、主要的回來自動切回）、Local 與 FlexConnect（standalone）、RRM 自動分頻道、WLAN 的 VLAN / 用戶端隔離 / 802.11k/v/r、`show ap summary` 等；只能用圖形介面設定 |
| 頻道寬度與新標準 | ✅ | 5 GHz 的 20 / 40 / 80 / 160 MHz（綁在一起的整塊頻譜重疊就干擾，自動模式像 DBS 一樣縮窄，速率跟著寬度）、DFS 頻道（關卡劇本的雷達：換頻道、用戶端斷 15 秒、30 分鐘不能回來）→ 5-4；6 GHz（三頻 AP 與 6E 用戶端、160 MHz、只廣播 WPA3 / 混合模式的 SSID → 5-5）；還沒有 Wi-Fi 7 的 320 MHz 與 MLO |
| 訪客功能 | 🟡 | 用戶端隔離、Captive Portal（入口網頁、pre-auth ACL、DNS 偵測、8 小時 session → 5-6）；還沒有 MAC 過濾、隱藏 SSID、訪客碼 |
| Mesh 與無線橋接 | ⬜ | |
| 現場勘測 | 🟡 | 有牆的關卡顯示訊號熱力圖；還沒有現場量測、預測工具與自由模式畫牆 |

## 8. IPv6

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 位址與鄰居探索 | ✅ | Link-local、SLAAC、NDP |
| 靜態路由與雙協定 | ✅ | `ping` 支援 IPv6；`show ipv6 route`、`show ipv6 interface brief` |
| DHCPv6 | 🟡 | RA 的 M / O / A 旗標、Stateless 與 Stateful、Relay、binding、DUID / IAID；Windows 收不到 RA 時自己試 DHCPv6。還沒有 Prefix Delegation |
| OSPFv3 | ✅ | 和 OSPFv2 共用同一套計算（DR / BDR、計時、多區域、ECMP、E2 預設路由）；link-local 鄰居與下一站、Router ID 仍是 32 位元（NORTRID）、被動介面、`show ipv6 ospf …`。沒有 IPsec 驗證與 area range |
| IPv6 的 ACL 與防火牆政策 | 🟡 | IOS 的 IPv6 ACL（`ipv6 traffic-filter`、序號、隱含的 ND 允許規則、命中次數）已完成；FortiGate 的 IPv6 政策還沒有 |
| DNS 的 AAAA 記錄 | ✅ | AAAA（CNAME 一樣追下去）、快取、`nslookup -type=aaaa`；有全域 IPv6 的電腦優先用 AAAA（RFC 6724），`ping -4 / -6`，瀏覽器與 curl 的 Happy Eyeballs（→ 9-7）。DNS 查詢走 IPv4 |
| 過渡機制 | 🟡 | IPv6 經過 IPv4 的 Tunnel 已完成（GRE、`tunnel mode ipv6ip`，OSPFv3 在 Tunnel 上）；NAT64 / DNS64 還沒有 |
| IPv6 over VPN | ✅ | GRE over IPsec 載 IPv6；`tunnel mode ipsec ipv4` 的 VTI 只載 IPv4，OSPFv3 的 Hello 過不去（→ 9-8） |

## 9. 高可用

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 故障演練 | ✅ | 任務目標可以指定讓某台設備或某條線路故障，再驗證連線 |
| STP 備援路徑 | ✅ | |
| EtherChannel 成員故障 | ✅ | |
| VRRP / HSRP | ✅ | 兩種協定分開：群組號碼、preempt 的預設值（VRRP 會搶、HSRP 不會）、接手時間（VRRP 約 3 秒、HSRP holdtime 10 秒）；協定或群組不一致時兩台都當 Active；`show standby [brief]`、`show vrrp brief` |
| 雙 WAN、Spine-Leaf | ✅ | |
| 物件追蹤與 IP SLA | ✅ | `track` 物件（介面的線路協定、IP SLA 的可達性）；`standby` / `vrrp … track … decrement`；靜態路由的 `track`；IP SLA icmp-echo（source-interface、frequency，依探測的節拍才發現變化，沒有 `start-time now` 會停在 pending）；`show track`、`show ip sla statistics`；網際網路設備可以模擬「業者骨幹故障」 |
| BFD | ✅ | `bfd interval … min_rx … multiplier …`、OSPF 的 `bfd all-interfaces` / `ip ospf bfd`、BGP 的 `fall-over bfd`；兩端都要設；中間隔著交換器時一秒內發現鄰居失聯（→ 8-8）；`show bfd neighbors`。另有 OSPF fast hello（`dead-interval minimal hello-multiplier`） |
| 堆疊、MLAG / vPC | ⬜ | |
| 防火牆 HA | ⬜ | Active-Passive、連線同步 |
| GLBP | ✅ | AVG 選舉（同 HSRP，preempt 預設關）、最多四台 AVF 各一個虛擬 MAC（0007.b400.XXYY）、round-robin / host-dependent、AVF 失聯 10 秒後由其他 AVF 接手（→ 8-9）；`show glbp brief`。weighted 還沒有依權重分配 |
| 電力備援 | ⬜ | 雙電源、UPS |

## 10. 時間、效能與流量

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 模擬時鐘 | ✅ | 暫停、1× / 10× / 60×、前進 30 秒、快轉到收斂 |
| 協定計時器 | ✅ | STP、OSPF、VRRP、DHCP 租約、ARP 快取 |
| 頻寬模型 | ✅ | 找出路徑上最慢的一段；全雙工、半雙工、duplex mismatch、Wi-Fi、IPsec 各有折扣 |
| `iperf3` 與速率目標 | ✅ | |
| 延遲 | 🟡 | 通話依每個出口佇列算出延遲、抖動與遺失（再換算成 MOS）；`ping` 的時間仍然依站數估算，沒有距離與線路種類 |
| 其他逾時 | ✅ | MAC 位址表、NAT 轉換表、防火牆連線、IPsec SA 都會過期；SSH / Telnet 是長時間保持的連線，閒置太久會被設備登出、或被路上的防火牆忘掉 |
| 開機時間 | ✅ | 依機型 2 秒到 4 分鐘；按下電源或 `reload` / `execute reboot` 之後，這段時間和關機一樣 |
| 流量互相擠壓 | ✅ | 背景流量依路徑上剩下的頻寬分配（小的先滿足、其餘平分，近似 TCP 公平分享）；`iperf3` 與檔案傳輸會和它們搶頻寬 |
| QoS | ✅ | MQC：class-map、policy-map（priority / LLQ、bandwidth、fair-queue、queue-limit、set dscp、police、shape 加子政策）、service-policy；Catalyst 2960 的 `mls qos`、trust 與 CoS→DSCP 對照表、AutoQoS；營運商的 CIR 管制；`show policy-map interface`。沒有 WRED、交換器的出口佇列、FortiGate 的流量整形 |
| 排程事件 | ✅ | 關卡劇本 `s.script`：時間到了切斷 / 修好線路、開關背景流量，跳出通知，線路的說明寫出原因；快轉到收斂不會特地跳過去（→ 12-4） |
| 流量產生器與流量圖 | 🟡 | 主機可以新增持續傳輸；網管畫面有每條線路的使用率與趨勢；沒有整張拓撲的流量熱圖 |

## 11. 設備管理與維運

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 圖形介面 | ✅ | 每一種設備都有對應的設定頁面與即時狀態 |
| IOS CLI | ✅ | 模式切換（巢狀的子模式 `exit` 一次回一層，不認得的指令先往上一層找）、縮寫、`no`、Tab 補齊、`?` 說明、`do show`、管線過濾（include / exclude / begin / section / count）、一次貼上多行 |
| IOS 的查看指令 | ✅ | 四十多個 `show` 指令，包含 MAC 位址表、NAT 轉換表、IPsec SA、時鐘、NTP、紀錄、介面計數器、SPAN、登入的使用者、flash、開機設定、SSH、SNMP |
| 設定可以整份貼回 | ✅ | 測試對 216 台 Cisco 設備、10 台 FortiGate 逐一驗證 |
| running / startup-config | ✅ | `write memory`、`reload`、未存檔的提示、斷電後回到上一次存檔 |
| FortiOS CLI | ✅ | `config` / `edit` / `set` / `next` / `end`、`show`、`get`、`diagnose`、`execute ping` |
| 主機終端機 | ✅ | `ping`、`ipconfig`、`arp`、`tracert`、`nslookup`、`curl`、`iperf3` |
| 封包追蹤 | ✅ | 每一段的 MAC、IP、TTL、埠號、TCP 旗標都可以打開看 |
| 封包擷取 | 🟡 | 主機上的 Wireshark：顯示篩選、逐層標頭；FortiGate 的 `diagnose sniffer packet`；還不能匯出 pcap，沒有 IOS 的 `monitor capture` |
| FortiGate 的 debug flow | ✅ | `diagnose debug flow`：收到封包、找路由、符合哪一條政策、SNAT / DNAT、進 VPN、沒有符合的連線 |
| 遠端登入 | ✅ | 主機 `ssh` / `telnet` 進 IOS 與 FortiGate 的命令列；金鑰指紋、密碼錯誤次數、閒置登出、`terminal monitor`；RSA 金鑰的產生與重建、vty 的 `login` / `login local` / 線路密碼 |
| IOS 的診斷指令 | ✅ | `traceroute`、`show interfaces`、`show ip protocols`、`show ip ospf interface brief`；`debug ip packet` / `icmp`、`debug ip ospf adj` / `hello`（區域、計時器、遮罩、驗證、MTU 的 IOS 15 訊息）、`debug ip dhcp server packet` / `events`（DORA、續約）、`debug crypto isakmp` / `ikev2` / `ipsec`（重送、金鑰、提案、proxy ID）；Router ID 重複記 `%OSPF-4-DUP_RTRID_NBR` |
| 設定備份與還原 | ✅ | `copy running-config tftp:` / `ftp:`、`copy tftp: running-config`（合併）與 `startup-config`（取代）；FortiGate 的 `execute backup` / `restore config` |
| 韌體與開機 | ✅ | flash / bootflash 的檔案與空間、`verify /md5`、`boot system`、開機時跳過不存在 / 損毀 / 平台不符的映像檔、ROMMON；FortiGate 的 `execute restore image` 與升級路徑 |
| 設定管理進階 | 🟡 | `archive`（path、maximum、write-memory 自動封存）、`show archive`、`show archive config differences`（Contextual Config Diffs）、`configure replace`（list、force）、`archive log config`（誰、從哪條線、打了什麼；notify syslog、hidekeys）；還沒有 `time-period` 的定時封存與 IOS XE install 模式 |
| 監控 | ✅ | Syslog 伺服器、SNMP 網管（輪詢、使用率、Trap）；NetFlow（傳統與 Flexible NetFlow、快取、匯出到收集器、Top Talkers → 11-7） |
| 其他廠牌的 CLI | ⬜ | Junos、Aruba、MikroTik、Linux (`ip` / `nmcli`) |
| 文件產出 | ⬜ | 拓撲圖匯出成圖片、IP 規劃表 |

## 12. 自動化、雲端與虛擬化

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| REST API / RESTCONF | ✅ | IOS XE 的 RESTCONF（介面、主機名稱、VLAN、靜態路由）、Basic 驗證、JSON / XML、狀態碼、自簽憑證；主機的 API 分頁與 curl |
| 設定檔與批次部署 | ✅ | Ansible：inventory、YAML、network_cli、cisco.ios 資源模組、ios_config / ios_command、--check、冪等；沒有 roles、Vault、Terraform |
| 控制器式網路 | ✅ | Catalyst Center：Token 驗證的北向 API、SNMP / SSH 輪詢的設備清單、AI 驅動的問題清單；只有讀取，沒有用 API 下發設定 |
| 雲端 | ✅ | AWS 的 VPC：子網路與路由表、IGW 與彈性 IP、NAT 閘道、安全群組、網路 ACL、VGW 與站對站 VPN（路由傳播、下載設定檔）、應用程式負載平衡器（接聽器、目標群組、健康檢查要過目標的安全群組與網路 ACL、沒有健康的目標回 503 → 16-3）；只有一個 VPC |
| 虛擬化 | 🟡 | VMware ESXi 主機：虛擬交換器、連接埠群組與 VLAN 標籤 (VST)、vmk0 管理介面、虛擬機器（虛擬網卡只能接主機的虛擬埠）、不送 DTP / BPDU；路由器的 VRF 見第 3 節；還沒有多個上行的 NIC teaming、vMotion |
| 容器 (Docker) | ✅ | Linux 主機上的 Docker：預設的 bridge 網路（docker0、veth、172.17.0.0/16）、`-p [位址:]主機埠:容器埠` 發佈（埠對錯會被重設、只綁 127.0.0.1 別台連不到、同一個埠不能發佈兩次）、改連接埠要重建容器；`docker ps / run / stop / start / rm / port / logs / inspect / images / network ls`、`ip addr` 看得到 docker0 與 veth；主機的「Docker」分頁。沒有自訂網路、Compose、volume |

## 13. 設備型錄

| 類別 | 狀態 | 機型 |
| --- | --- | --- |
| 用戶端 | ✅ | Dell OptiPlex 7010、Lenovo ThinkPad T14、Apple iPhone 15、HP LaserJet Pro M404dn / M404dw |
| 伺服器與儲存 | ✅ | Dell PowerEdge T150、PowerEdge R650、Synology DS224+ |
| Hub 與非網管交換器 | ✅ | NETGEAR EN104TP、TP-Link TL-SG105 / TL-SG108 |
| 家用路由器與 AP | ✅ | ASUS RT-AX58U、Ubiquiti UniFi U6 Lite |
| 路由器 | ✅ | Ubiquiti EdgeRouter X、Cisco ISR 4321 / 4331 |
| 網管交換器 | ✅ | Cisco Catalyst 2960-CX-8TC-L、2960-CX-8PC-L (PoE) |
| 第三層交換器 | ✅ | Cisco Catalyst 9300-24T、Nexus 93180YC-FX、Nexus 9332C |
| 防火牆 | ✅ | Fortinet FortiGate 60F、100F |
| 網際網路 | ✅ | ISP、公用 DNS、外部網站與外部使用者 |
| 語音與監控 | 🟡 | Cisco IP Phone 8841、Yealink SIP-T54W（只有 LLDP-MED）；還沒有 PoE 攝影機 |
| 無線控制器 | ✅ | Cisco Catalyst 9800-L（WLC）、Catalyst 9120AXI（輕量型 AP，802.3at PoE） |
| 伺服器角色 | 🟡 | 已有 RADIUS、DHCP、DNS、Syslog、NTP、TFTP、FTP、SNMP 網管、CUCM、網站（HTTPS 憑證）、Docker 主機；TFTP / FTP / 網管 / CUCM 可以自己啟用；還沒有 AD / LDAP、郵件 |
| 其他 | ⬜ | 數據機 / ONT、負載平衡器、UPS、其他廠牌（Juniper、Aruba、MikroTik） |

## 14. 遊戲系統

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 關卡 | ✅ | 17 章 109 關（清單見第 17 節） |
| 任務目標 | ✅ | ping、TCP、UDP、DHCP、設定檢查、故障演練、IPv6 ping、傳輸速率、遠端登入（SSH / Telnet 帳號密碼）、IP 電話註冊、通話品質 (MOS)、HTTPS（連得上之後還要通過憑證驗證）、路徑（一定要經過 / 不能經過某台設備）；TCP 的目標交握完還會送一個裝滿的資料區段（設了 DF），MTU 的問題才看得出來 |
| 提示與星等 | ✅ | 每關 3 個提示，看一個少一顆星 |
| 學習卡 | ✅ | 每關 2 到 4 張觀念說明 |
| 題庫 | ✅ | 184 題觀念題、隨機產生的子網路計算題、過關後的小考 |
| 證照地圖 | ✅ | 三種考試的條目與關卡對照、完成進度 |
| 故障排除章 | ✅ | 網路已經設定好但被改壞，要自己找出原因 |
| 自由模式 | ✅ | 自己擺設備、接線、設定；可以存目標、匯出與匯入 |
| 復原與重做 | ✅ | |
| 進度保存 | ✅ | 自動存檔、`?profile=` 多份進度 |
| 操作說明 | ✅ | 說明與圖例；第一次進第 1-1 關有互動導覽（六個步驟，依遊戲真正的狀態自動前進，可以跳過，說明裡可以重看） |
| 參考解法 | ✅ | 提示看完之後可以看參考解法改了哪些地方（Cisco 設備是 running-config 的差異，其他設備列出改了哪些欄位、接了哪些線），也可以讓它示範一次（重置、套用、自動跑測試，不計星） |
| 關卡編輯 | 🟡 | 自由模式的「關卡設計」：名稱、任務說明、提示、鎖定設備，試玩、存成自訂關卡、匯出與匯入關卡檔；還不能寫學習卡、已知資訊與「設定檢查」類的目標 |
| 評分 | ✅ | 實際作答時間（對照依目標數估計的標準時間）、提示、完整測試次數 → S / A / B / C；設定變更次數只供參考 |
| 成就 | ⬜ | |
| 隨機故障 | ✅ | 故障演練：從做好的網路隨機改壞 1 – 3 個地方（20 種故障，在副本上驗證會讓目標失敗）、可以限時、揭曉答案 |
| 模擬考模式 | ✅ | CCNA / Network+，限時、依領域比重抽題、交卷後依領域計分與逐題解說；實作題用限時的故障演練練習 |
| 題庫進階 | ✅ | 錯題本：測驗、小考、模擬考答錯的題目照間隔重複排程（1 → 3 → 7 → 14 → 30 天，答錯回到第一盒），頂端列顯示到期題數 |
| 預算與採購 | ⬜ | 依需求挑設備，有成本限制 |
| 名詞表 | ⬜ | |
| 帳號與雲端存檔 | ⬜ | |
| 多人 | ⬜ | 協作，或紅隊藍隊對抗 |

## 15. 介面與體驗

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 3D 場景 | ✅ | 設備模型、網路線、封包動畫、ARP 與 DHCP 的廣播擴散、無線涵蓋範圍 |
| 視角操作 | ✅ | 平移、縮放、旋轉 |
| 狀態顯示 | ✅ | 每個連接埠的燈號跟著實際的連線狀態（綠色、琥珀色、不亮）；被 STP 封鎖的線、還在等待的線（閃橘色） |
| 網路線接在連接埠上 | ✅ | 每條線從它接的那個孔出發，插頭大小跟著孔走，對方在機身後面時會從側邊繞過去；主機上有看得見的網路孔 |
| 桌面版面 | ✅ | 視窗寬度 1024 以上 |
| 鍵盤操作 | 🟡 | Esc、空白鍵、Ctrl + Z / Y；接線與選設備還是要用滑鼠 |
| 手機與平板 | ⬜ | 沒有針對觸控與小螢幕設計 |
| 多語系 | ⬜ | 目前只有繁體中文 |
| 無障礙 | ⬜ | 色盲友善配色、螢幕閱讀器 |
| 邏輯拓撲圖 | ✅ | 2D 檢視：每台設備的位址、線上兩端的埠與 VLAN（Access / Trunk）、線路狀態（通、斷、STP 封鎖）、無線與虛擬連線、建立好的 VPN 通道、最近一次測試走過的路徑；滾輪縮放、拖曳平移，空間小的時候自動改成精簡的方塊 |
| 標註 | ⬜ | 設備標籤、註解、群組框 |
| 主題 | ⬜ | 目前只有深色 |
| 音效 | ⬜ | |
| 離線使用 | ⬜ | PWA |

## 16. 工程品質

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 引擎測試 | ✅ | 關卡重播、負面案例、故障情境、CLI 來回驗證、時鐘、頻寬、資料檢查 |
| 建置 | ✅ | `vite build` |
| 瀏覽器端測試 | ✅ | Playwright（用電腦上已裝的 Chrome，不下載瀏覽器）：每一關每台設備的每個分頁、解完到過關視窗、真的點擊與打字、各種模式，1440×900 與 1024×768 |
| CI | ⬜ | 還沒有遠端儲存庫，也沒有自動跑測試與建置 |
| 靜態檢查 | ⬜ | ESLint、型別檢查 |
| 模組拆分 | ✅ | `sim.js` 原本 3200 行，依層級拆成 `engine/sim/` 底下 12 個模組（core、phys、l2、wifi、l3、tunnels、auth、forward、transact、resolve、objectives、bandwidth），各 60 – 660 行；`sim.js` 只留重新計算與模擬時鐘（約 270 行），並匯出和拆開之前一模一樣的 71 個公開名稱，其他程式不用改 |
| 打包體積 | ✅ | 分成 three.js、引擎、關卡與題庫、介面四個檔案（各 220 – 520 KB），改關卡時不用重新下載 three.js 與引擎；還沒有依章節延遲載入 |
| 大型拓撲效能 | ⬜ | 每次變更都全部重算，還沒有量過上百台設備的表現 |
| 存檔格式遷移 | ⬜ | 設定結構改版時，舊存檔沒有遷移機制 |
| 部署 | 🟡 | `npm run build:artifact` 產生可以發佈成 Claude Artifact 的頁面（three.js 從 jsDelivr 載入、匯出改成複製、窄螢幕提示）；還沒有 GitHub Pages 之類的靜態網站 |

---

## 17. 關卡規劃

### 現有的 109 關

| 章 | 關卡 |
| --- | --- |
| 1 家用網路 | 第一條網路線、換上交換器、自動發 IP、連上網際網路 |
| 2 小型辦公室 | 辦公室開張、部門隔離、跨樓層、跨 VLAN 路由 |
| 3 企業網路 | 守門員、總公司與分公司、對外伺服器群 |
| 4 資料中心 | 機櫃上線、Spine-Leaf、跨棟連線、一開 Jumbo Frame，備份就卡住 |
| 5 無線網路 | 家裡的 Wi-Fi、辦公室基地台、訪客 Wi-Fi、下午的視訊會議一直斷（頻道寬度與 DFS）、新筆電明明支援 Wi-Fi 6E（6 GHz 與 WPA3）、訪客連上 Wi-Fi，卻沒有跳出登入頁面（Captive Portal） |
| 6 網路安全 | 只開了 TCP、誰在發 IP？、不速之客、存取控制清單、管理介面加固、冒牌閘道、搶走根橋、你是誰？、偽裝成交換器、交換器變成了 Hub（MAC flooding）、跳進伺服器 VLAN 的封包（雙重標籤）、飯店的房間網路（Private VLAN）、星期一早上，有線網路全部登不進去（EAP-TLS） |
| 7 VPN 與廣域備援 | 站對站 VPN、在家上班、雙線路備援、三個據點，一個中心、線路燈還亮著（IP SLA）、小檔案可以，大檔案卡住（PMTUD 黑洞）、兩個分公司的連線一下通一下斷（GRE 與 recursive routing）、稽核報告（GRE over IPsec）、每加一個網段就要改兩邊的 ACL（VTI）、門市之間的監視器畫面（DMVPN）、新分公司在共享辦公室裡（NAT-T）、換了主機板電池，VPN 就起不來了（IKEv2 的憑證驗證） |
| 8 高可用與進階路由 | 迴圈與生成樹、EtherChannel、閘道備援、集中式 DHCP、OSPF 路徑選擇、切蛋糕、閘道還活著，但出不去（HSRP 追蹤）、主線斷了，電話斷了四十秒（BFD）、兩台閘道，只有一台在做事（GLBP） |
| 9 IPv6 | IPv6 初體驗、雙協定、位址從哪裡來？、IPv6 也要動態路由、封了 IPv4，忘了 IPv6、IPv6 的預設閘道被搶走了（RA Guard）、內部網站加了 IPv6 之後（AAAA 與 Happy Eyeballs）、IPv6 過不了 VPN（VTI 只載 IPv4） |
| 10 故障排除 | 誰搶了我的 IP、樓層之間又斷了、分公司的求救電話、明明連得上，為什麼這麼慢、分公司的 OSPF 鄰居起不來、流量為什麼繞去實驗室、VPN 通了，資料卻過不去、DNS 改了，為什麼還連到舊的、整層樓都慢了（廣播風暴與 Storm Control） |
| 11 維運與管理 | 還好有備份、韌體升級、讓 SSH 能用、網路怎麼變慢了、是誰動了設定？、你的連線不是私人連線、專線被塞滿了，是誰？（NetFlow）、事件的先後兜不起來（NTP 與 service timestamps）、機櫃裡的線全部沒有標籤（看不到接線，用 CDP / LLDP 找） |
| 12 語音與 QoS | 電話接上了，然後呢？、語音斷斷續續、新的 AP 怎麼插都不亮（PoE 預算與 CDP 的電力協商）、專線一斷，電話就聽不清楚（雙 WAN 的 QoS） |
| 13 進階路由 | 誰當 DR？、10G 和 1G 一樣快？、分公司自成一區、兩家 ISP 都要用、併購的工廠只會靜態路由（重分配）、備份走另一條線（PBR）、分公司的路由表太大了（stub）、工廠接了一條供應商專線（NSSA）、兩個出口，同一個 AS（iBGP）、共用服務放在全域的路由表（VRF 的 OSPF 與路由洩漏） |
| 14 無線控制器與無線環境 | AP 找不到控制器、牆後面收不到、走到另一頭就斷線、控制器重開機，整棟的 Wi-Fi 斷了六分鐘（N+1）、分公司的專線一斷，Wi-Fi 也跟著斷（FlexConnect） |
| 15 網路自動化 | 用 API 管理路由器、一次設定四台交換器、控制器說哪裡有問題 |
| 16 雲端網路 | 把網站搬上雲端、私有子網路與混合雲、加了負載平衡器，網站反而打不開（ALB） |
| 17 虛擬化 | 一台主機，三個網段、兩家公司，同一個網段（VRF）、容器跑起來了，網頁卻打不開 |

### 規劃中的關卡

每一章都要先有對應的引擎功能（括號內是第幾節）。

| 章 | 規劃的關卡 | 需要的功能 |
| --- | --- | --- |
| 補進第 15 章 | 用 Catalyst Center 的範本下發設定、NETCONF、用 Git 管理設定 | 第 12 節 |
| 補進第 16 章 | 多個 VPC 的 peering 與 Transit Gateway、Terraform（負載平衡器已補上 16-3） | 第 12 節 |
| 補進第 6 章 | NGFW 設定檔、SYN flood | 第 5 節 |
| 補進第 7 章 | （GRE over IPsec、VTI、DMVPN、NAT-T、憑證驗證已補上 7-7 到 7-12） | 第 6 節 |
| 補進第 9 章 | Prefix Delegation、FortiGate 的 IPv6 政策、NAT64 / DNS64 | 第 8 節 |
| 補進第 10 章 | Wi-Fi 很慢（隨機故障已經由故障演練提供） | 第 7、14 節 |

## 18. 證照涵蓋

| 考試 | 已有關卡的條目 | 還沒有關卡的條目 |
| --- | --- | --- |
| Cisco CCNA 200-301 v1.1 | 53 條中的 52 條 | 見下表 |
| CompTIA Network+ N10-009 | 25 條全部有對應 | — |
| CompTIA Security+ SY0-701 | 網路相關的 12 條（加上 1.4 密碼學與 PKI），全部有對應 | — |

CCNA 還沒有關卡的 1 條，以及補上的方式：

| 條目 | 內容 | 規劃 |
| --- | --- | --- |
| 5.2 | 安全計畫的要素 | 觀念題即可 |

CCNA v2.0 預計在 2027 年 2 月取代 v1.1，改版後整張對照表要重新檢查。

## 19. 建議的實作順序

依「對真實度的幫助」與「相依關係」排列，前面的做完後面才做得起來。

| 階段 | 內容 | 理由 |
| --- | --- | --- |
| 1（已完成） | MAC 位址表的學習與逾時、NAT 與連線紀錄逾時、IPsec 協商時間與 SA 生命週期、NTP 對時、Syslog 伺服器 | 時鐘已經有了，這些原本都假裝「瞬間完成、永不過期」 |
| 2（已完成） | 從主機 SSH 進設備（長時間保持的連線，連線逾時才有作用）、開機時間、IOS 的 `traceroute` / `debug` / `show interfaces`、介面計數器、封包擷取與 SPAN、FortiGate 的 sniffer 與 debug flow | 排除故障的工具補齊，故障排除章才能做得更深 |
| 3（已完成） | TFTP / FTP 備份與還原、韌體升級與 ROMMON、SSH 的前置條件、SNMP 監控與 Trap、背景流量 → 第 11 章 | 補上 CCNA 4.9、Network+ 3.1 |
| 4（已完成） | CDP / LLDP 的計時與鄰居表、DTP、IP 電話（PoE、語音 VLAN、option 150、CUCM）、QoS（信任邊界、LLQ、整形、營運商管制、通話品質）→ 第 12 章與 6-8 | 補上 CCNA 2.3、4.7 |
| 5（已完成） | OSPF 進階（DR / BDR、Router ID、passive、驗證、MTU、多區域與彙總）、ECMP、eBGP 與路由政策、真實格式的 `show ip route` → 第 13 章 | 補強 CCNA 3.1、3.2、3.4，Network+ 2.1 |
| 6（已完成） | IPv6 補齊（DHCPv6、OSPFv3、ACL → 9-3 到 9-5）、IKEv2 與 Hub-and-Spoke（→ 7-4） | 補強 CCNA 1.8、1.9、4.3、5.5、5.6 |
| 7（已完成） | 無線控制器、牆面衰減與熱力圖、漫遊 → 第 14 章 | 補上 CCNA 2.6 |
| 8（已完成） | RESTCONF、Ansible、Catalyst Center → 第 15 章、AWS 的 VPC → 第 16 章 | 補上 CCNA 第 6 領域、Network+ 1.3 |
| 9（已完成） | 故障演練、模擬考、評分、關卡編輯器 | 引擎功能齊全之後，重玩價值才撐得起來 |
| 10（已完成） | Playwright 瀏覽器端測試；err-disabled 維持與 errdisable recovery、HSRP / VRRP 分開與物件追蹤、IP SLA、設定封存與變更紀錄、多個本機帳號；MTU、Jumbo Frame 與 PMTUD（→ 4-4、7-6）；第 7、8、10、11 章的補充關卡 | 讓「故障排除」與「維運」更接近真實工作 |
| 11（已完成） | 虛擬化章節：vSwitch、連接埠群組、VM → 17-1；VRF-Lite → 17-2；Docker 的橋接網路與連接埠發佈 → 17-3。DNS 伺服器角色（A / CNAME / MX / PTR、TTL 與用戶端快取 → 10-8）。HTTP(S) 內容與憑證：信任、有效期間（用戶端的時鐘）、SAN、內部 CA → 11-6 | 補上 CCNA 1.12（伺服器虛擬化、容器、VRF 都有關卡）、Security+ 1.4 |
| 12（已完成） | 第一次遊玩的導覽、參考解法示範、錯題本、2D 邏輯拓撲圖 | 新手體驗 |
| 13（已完成） | 拆開 `sim.js`；路由重分配（靜態、直連、BGP ↔ OSPF）與政策路由 → 13-5、13-6 | 第 3 節最後幾個常見的企業路由功能 |
| 14（已完成） | OSPF 的 stub / totally stubby / NSSA；iBGP（`update-source`、`next-hop-self`、route reflector、多跳 eBGP、community）；VRF 裡跑 OSPF 與 VRF 之間的路由洩漏 → 13-7 到 13-10 | 接著第 13 階段與 VRF-Lite，補完企業與 ISP 邊界最常見的路由設計 |
| 15（已完成） | 第二層安全：靜態 MAC、MAC flooding（CAM 表滿了變成泛洪）、雙重標籤、Storm Control、Private VLAN、RA Guard → 6-10 到 6-12、9-6、10-9 | 引擎已經有 MAC 表與 Native VLAN，攻擊情境可以真的跑出來；補 Security+ |
| 16（已完成） | GRE 與 recursive routing、GRE over IPsec、IOS VTI、DMVPN（phase 2 / 3）、NAT-T → 7-7 到 7-11；命名 ACL 的序號照 IOS 保留、ACL 可以寫 esp / gre。IKEv2 的憑證驗證移到第 19 階段 | 第 6 節最大的缺口，也是 CCNA 5.5 / Network+ 的常考題 |
| 17（已完成） | AAAA 與雙協定（RFC 6724、Happy Eyeballs）、IPv6 經過 IPv4 的 Tunnel（GRE、6in4）與 IPv6 over VPN → 9-7、9-8。DHCPv6 Prefix Delegation、FortiGate 的 IPv6 政策、NAT64 / DNS64 要先有 IPv6 的網際網路與防火牆，移到第 22 階段 | 第 8 節剩下的項目 |
| 18（已完成） | BFD（OSPF、BGP）與 OSPF fast hello → 8-8；GLBP → 8-9；HSRP / VRRP 改用各自正確的虛擬 MAC。FortiGate HA、堆疊 / vPC、電力備援要先有兩台設備合成一台的模型，移到第 22 階段 | 第 9 節剩下的項目 |
| 19（已完成） | 維運與語音補充：NetFlow 與 QoS 的 police（已完成 → 11-7）、OSPF / DHCP / crypto 的 `debug`（已完成）、NTP + Syslog 對時與 `service timestamps`（已完成 → 11-8）、PoE 預算與 Cisco AP 的 CDP / LLDP 電力協商（已完成 → 12-3）、IKEv2 的憑證驗證（PKI、時鐘不對讓憑證「尚未生效」→ 7-12）、802.1X 的 EAP-TLS（伺服器憑證、電腦憑證、用戶端的時鐘 → 6-13）、看不到接線的關卡模式與用 CDP / LLDP 畫拓撲（→ 11-9）、雙 WAN 的 QoS 與排程事件（已完成 → 12-4） → 第 11、12 章補充關卡 | 讓故障排除的工具與劇本更完整 |
| 20（已完成） | 無線補充：頻道寬度與 DFS（已完成 → 5-4）、6 GHz（已完成 → 5-5）、控制器 N+1（已完成 → 14-4）、FlexConnect 分公司（已完成 → 14-5）、訪客入口 (Captive Portal → 5-6) | 第 7 節剩下的項目 |
| 21（進行中） | 自動化與雲端補充：負載平衡器（已完成 → 16-3）；NETCONF、Catalyst Center 範本、用 Git 管理設定、VPC peering 與 Transit Gateway、Terraform → 第 15、16 章補充關卡 | 第 12 節的延伸 |
| 22 | FortiGate HA（Active-Passive、連線同步）、堆疊 / vPC、電力備援；IPv6 的網際網路與 FortiGate 的 IPv6（DHCPv6-PD、IPv6 政策、NAT64 / DNS64）；實體層與其他：收發器不相容、breakout、Console 與帶外管理、STP 進階、VTP、EIGRP / RIP、多播、TACACS+、ZBF、NGFW、SD-WAN、其他設備與廠牌 | 剩下的引擎項目 |
| 23 | 介面與體驗（第 15 節）、工程品質（第 16 節：CI、靜態檢查、存檔格式遷移、大型拓撲效能、部署） | 引擎穩定之後再整理介面與工程 |
| 最後 | 遊戲系統（第 14 節）：成就、預算與採購、名詞表、帳號與雲端存檔、多人、關卡編輯器補齊（學習卡、已知資訊、設定檢查目標） | 依使用者的決定排在最後，等關卡與引擎都齊了再做 |
| 隨時 | CI、存檔格式遷移（`sim.js` 的拆分與分塊載入已完成） | CI 要遠端儲存庫，要另外決定 |
