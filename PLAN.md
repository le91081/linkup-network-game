# LinkUp 功能規劃

最後更新：2026-11-19

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
| 1. 實體層與接線 | 7 | 1 | 6 |
| 2. 第二層：交換 | 13 | 0 | 4 |
| 3. 第三層：路由 | 10 | 0 | 6 |
| 4. IP 服務 | 9 | 4 | 1 |
| 5. 網路安全 | 8 | 3 | 5 |
| 6. VPN 與廣域網路 | 6 | 3 | 4 |
| 7. 無線網路 | 3 | 2 | 5 |
| 8. IPv6 | 3 | 2 | 3 |
| 9. 高可用 | 5 | 0 | 6 |
| 10. 時間、效能與流量 | 8 | 2 | 1 |
| 11. 設備管理與維運 | 12 | 3 | 3 |
| 12. 自動化、雲端與虛擬化 | 0 | 0 | 5 |
| 13. 設備型錄 | 9 | 2 | 2 |
| 14. 遊戲系統 | 10 | 3 | 9 |
| 15. 介面與體驗 | 5 | 1 | 8 |
| 16. 工程品質 | 2 | 0 | 8 |
| **合計** | **110** | **26** | **76** |

另外：關卡 54 關（第 17 節）、證照條目涵蓋情形（第 18 節）、建議的實作順序（第 19 節）。

---

## 1. 實體層與接線

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 線材種類與距離上限 | ✅ | Cat6 銅纜、DAC、多模光纖 (OM4 + SR)、單模光纖 (OS2 + LR)；超過距離就沒有燈號 |
| 連接埠型式 | ✅ | RJ45、SFP+ / SFP28、QSFP28，線材要和連接埠相符 |
| 速率與雙工協商 | ✅ | 自動協商、寫死 `speed` / `duplex`、duplex mismatch、兩端速率寫死成不同值時連線建立不起來 |
| PoE 供電 | ✅ | 只有 PoE 埠能供電；依等級保留瓦數、Cisco 設備用 CDP 協商實際用量、交換器的總預算、`power inline never`、`show power inline`；受電設備插電後才開機，交換器重開它們也跟著重開。沒有 802.3bt / UPOE |
| 設備電源、介面 shutdown | ✅ | 任何設備可以關機，介面可以停用，錯誤訊息會指出是哪一台 |
| 連線狀態與原因 | ✅ | 點網路線可以看線材、距離、協商結果與斷線原因 |
| 線路故障 | 🟡 | 故障演練會切斷指定的線路；線對斷掉的網路線會自動降到 100 Mbps（寫死 1000 時連不起來）；沒有接觸不良、光衰過大這類造成 CRC 錯誤與間歇掉包的故障 |
| 介面計數器 | ✅ | 由真正跑過的訊框累積：封包數、位元組、廣播 / 多點傳送、CRC、runt、碰撞、late collision；背景有 BPDU、CDP、OSPF Hello、VRRP；`show interfaces`、`clear counters`、`netstat -e`、FortiGate 的 `diagnose hardware deviceinfo nic` |
| 收發器不相容 | ⬜ | 目前線材與收發器是成套的，沒辦法接出 SR 對 LR、速率不符的情況 |
| 分歧線 (breakout) | ⬜ | 40G / 100G 拆成 4 條 10G / 25G |
| Console 線與帶外管理 | ⬜ | Console 埠、管理埠 (mgmt)、帶外管理網路 |
| MTU 與 Jumbo Frame | ⬜ | MTU 不一致造成的大封包不通、分片 |
| err-disabled 自動復原 | ⬜ | 目前被關閉的埠要手動 `shutdown` / `no shutdown` |
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
| 靜態 MAC 項目 | ⬜ | `mac address-table static`；目前只有 Port Security 指定的位址會顯示成 STATIC |
| CDP 與 LLDP | ✅ | 依計時器通告、鄰居表與 holdtime、LLDP 的 shutdown 通告、經過 Hub / 非網管交換器的行為、全域與每個埠的開關、`show cdp / lldp neighbors [detail]`、traffic、`clear`；Native VLAN 與雙工不一致的訊息靠 CDP；LLDP-MED 給電話語音 VLAN |
| DTP | ✅ | Catalyst 出廠 `dynamic auto`、`dynamic desirable`、`nonegotiate`、運作中的模式與原因、`show interfaces switchport`、`show dtp`；攻擊工具偽裝成交換器 (VLAN hopping)；Nexus 沒有 DTP |
| VTP | ⬜ | VLAN 資料庫同步 |
| Voice VLAN | ✅ | `switchport voice vlan`：資料不帶標籤、語音帶標籤；電話從 CDP 或 LLDP-MED 學到，也可以手動設定 |
| Private VLAN、Storm Control | ⬜ | |
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
| OSPF 進階 | ✅ | DR / BDR 選舉（priority、Router ID、不搶位、BDR 升上來、`clear ip ospf process`）、Router ID 在程序啟動時決定（Loopback）、Router ID 重複、`passive-interface [default]`、Hello / Dead 可調、network type、明文與 MD5 驗證、MTU 不一致卡在 EXSTART、參考頻寬、多區域與 ABR、`area range` 彙總、O IA 與 O*E2；`show ip ospf` / `neighbor` / `interface` / `database` |
| ECMP（等價多路徑） | ✅ | cost 一樣的路最多 `maximum-paths` 條（預設 4）一起放進路由表；依來源與目的位址雜湊（CEF 的 per-destination），同一對位址永遠走同一條 |
| ICMP 細節 | ⬜ | Unreachable 的各種類型、Redirect、分片與 PMTUD |
| IOS 的 `traceroute` | ✅ | 逐站顯示，每一站三個探測封包；ECMP 時跟著雜湊走 |
| BGP（eBGP） | ✅ | TCP 179 的鄰居狀態（Idle / Active / OpenSent / Established）、remote-as 寫錯 (Bad Peer AS)、hold time 180 秒、路徑向量與迴圈偵測、最佳路徑（weight、local-preference、AS path、origin、MED）、route-map / prefix-list / as-path ACL、`default-originate`；雙 ISP 的轉運站問題 |
| iBGP 與 BGP 進階 | ⬜ | iBGP 與 next-hop-self、route reflector、community、多跳 eBGP (`ebgp-multihop`) |
| EIGRP、RIP | ⬜ | 優先度低：CCNA v1.1 只要求看得懂 |
| 路由重分配、PBR、VRF | ⬜ | |
| IP SLA 與物件追蹤 | ⬜ | 上游故障但介面沒斷的時候切換路由 |
| 多播 | ⬜ | IGMP、PIM |

## 4. IP 服務

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| DHCP 伺服器 | ✅ | 位址池、排除位址、閘道、DNS、保留位址（依 MAC） |
| DHCP 四步驟與 Relay | ✅ | Discover → Offer → Request → Ack 的動畫，經由 Relay 會顯示轉送 |
| DHCP 租約 | ✅ | 租約長度、過半續約、`ipconfig /release` / `/renew`、到期、伺服器失聯時沿用舊租約 |
| 衝突偵測 | ✅ | 伺服器發放前先 ping；IP 位址衝突會標示出來 |
| APIPA | ✅ | 拿不到租約時退回 169.254.x.x |
| DNS 查詢 | 🟡 | `nslookup`、用網域名稱連線、家用路由器的 DNS 代理；記錄固定在網際網路上，不能自己架 DNS 伺服器，也沒有 CNAME / MX / PTR、快取與 TTL |
| NAT | ✅ | PAT、一對一靜態 NAT、連接埠轉發、用 ACL 指定範圍、NAT 例外；可以查看轉換表 |
| NAT 進階 | 🟡 | 轉換表的閒置逾時已完成（依協定不同，可以用 `ip nat translation` 調整）；還沒有位址池 (pool)、Hairpin NAT |
| PPPoE | 🟡 | 帳號密碼驗證與撥接；IOS 沒有 Dialer 介面，只能在圖形介面設定 |
| NTP | ✅ | 每台設備有自己的時鐘；每 64 秒輪詢，IOS 約四分鐘後才採信；`ntp master`、`clock set`、`clock timezone`；伺服器失聯八次輪詢後失去同步 |
| Syslog | ✅ | 設備記下介面、OSPF、VRRP、VPN、err-disabled 等事件，用 UDP 514 送到伺服器；`logging trap` 設定門檻；伺服器有收件畫面 |
| SNMP | ✅ | v2c community（RO / RW、綁標準 ACL）、v3 的 group / user（SHA + AES）、Trap（linkUp / linkDown / coldStart / authenticationFailure）；網管伺服器每 60 秒輪詢、依計數器差值算使用率；FortiGate 的 sysinfo / community / hosts / user 與 allowaccess snmp；沒有 MIB 瀏覽器與 SET |
| TFTP / FTP / SCP | 🟡 | TFTP（UDP 69，512 位元組區塊，速度看來回時間）與 FTP（帳號密碼、明文）：設定備份與還原、映像檔下載、伺服器的檔案分頁；沒有 SCP / SFTP |
| HTTP(S) 服務內容與憑證 | ⬜ | `curl` 目前只測 TCP 連線有沒有通 |

## 5. 網路安全

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| ACL | ✅ | 標準、延伸、具名與編號；套用在介面的進 / 出方向；顯示命中次數 |
| 防火牆政策 | ✅ | 介面、位址物件與群組、服務、動作、NAT、順序調整、命中次數、隱含拒絕 |
| 狀態檢查 | ✅ | TCP 三向交握、連線紀錄，後續封包不重新比對政策 |
| DMZ 與 VIP | ✅ | |
| 防火牆紀錄 | ✅ | 每條新連線被哪一條政策放行或拒絕 |
| 管理介面加固 | 🟡 | SSH 取代 Telnet（要先有主機名稱、網域名稱、RSA 金鑰與 `login local`）、vty `access-class`、`exec-timeout`、`login block-for`、`banner motd`、FortiGate 各介面的 allowaccess 與 `admintimeout`、密碼以雜湊顯示；`enable secret` 會接受但沒有作用（模擬裡沒有 enable 模式） |
| DHCP Snooping、DAI | ✅ | |
| Port Security | ✅ | 靜態與 sticky MAC、違規時 err-disabled |
| 802.1X / RADIUS | 🟡 | 有線埠與 WPA2-Enterprise 的帳號密碼驗證；沒有憑證 (EAP-TLS) |
| Wi-Fi 加密 | ✅ | 開放、WEP、WPA2、WPA2 / WPA3 混合、WPA3 |
| 攻擊情境 | 🟡 | 已有冒牌 DHCP、ARP 欺騙、搶根橋、未授權設備、密碼暴力嘗試（`login block-for`）、側錄 Telnet 明文密碼；用 DTP 偽裝成交換器的 VLAN hopping；還沒有 MAC flooding、雙重標籤、SYN flood |
| TACACS+ 與 AAA | ⬜ | 授權、稽核、權限等級 |
| IOS 進階過濾 | ⬜ | Zone-Based Firewall、時間型 ACL、Reflexive ACL |
| NGFW / UTM | ⬜ | IPS、防毒、網頁過濾、應用程式控管、SSL 檢查 |
| IPv6 安全 | ⬜ | IPv6 ACL、RA Guard |
| 憑證與 PKI | ⬜ | |

## 6. VPN 與廣域網路

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 站對站 IPsec | ✅ | IKEv1 與 IKEv2、預先共用金鑰；第一、第二階段分開協商，哪個階段不一致會分別指出；PFS |
| 跨廠牌 | ✅ | FortiGate 對 FortiGate、Cisco IOS (crypto map) 對 FortiGate |
| 先 NAT 再加密 | ✅ | 沒有設 NAT 例外時通道是 Up 的但流量進不去 |
| 遠端存取 SSL-VPN | 🟡 | 使用者、群組、入口、連接埠；加密流量在引擎內仍當成一層封裝處理 |
| ISP 線路型態 | ✅ | DHCP、固定 IP、PPPoE |
| 雙線路備援 | ✅ | 浮動靜態路由 |
| IKEv2 與憑證驗證 | 🟡 | IKEv2 已完成：版本不一致、非對稱的預先共用金鑰、PFS 不一致要到第一次重新協商才失敗、IOS 的 proposal / policy / keyring / profile、FortiOS 的 `ike-version` 與 `psksecret-remote`、`show crypto ikev2 sa`。還沒有憑證與 EAP |
| SA 的時間面 | ✅ | 協商 2 秒、兩個階段的金鑰壽命（兩端取較短的）與自動重新協商、DPD；IOS 沒設 keepalive 時要等金鑰到期才發現對端失聯 |
| NAT-T | ⬜ | |
| GRE、IOS VTI、DMVPN | ⬜ | |
| 多站台 | 🟡 | Hub-and-Spoke 已完成（7-4：分公司之間在總公司解密再加密、VPN → VPN 政策、加密範圍與 NAT 例外）；全網狀與 DMVPN 的動態通道還沒有 |
| SD-WAN | ⬜ | 健康檢查、依線路品質選路 |
| 專線、MPLS、Metro Ethernet | ⬜ | 至少要有觀念關卡 |

## 7. 無線網路

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| SSID 與多 SSID | ✅ | 每個 SSID 可以對應到不同的 VLAN |
| 頻段與頻道 | ✅ | 2.4 GHz / 5 GHz、頻道規劃、頻道重疊時速率減半 |
| 訊號模型 | 🟡 | 依距離與發射功率估算 RSSI、頻段與速率；沒有牆面與障礙物衰減 |
| 涵蓋範圍顯示 | ✅ | |
| 多台 AP | 🟡 | 用戶端會連到訊號最強的那一台；沒有移動中的漫遊 (802.11r / k / v) |
| 無線控制器 | ⬜ | WLC、Lightweight AP、CAPWAP（CCNA 2.6 的缺口） |
| 頻道寬度與新標準 | ⬜ | 20 / 40 / 80 MHz、6 GHz (Wi-Fi 6E / 7)、DFS |
| 訪客功能 | ⬜ | 用戶端隔離、Captive Portal、MAC 過濾、隱藏 SSID |
| Mesh 與無線橋接 | ⬜ | |
| 現場勘測 | ⬜ | 熱力圖 |

## 8. IPv6

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 位址與鄰居探索 | ✅ | Link-local、SLAAC、NDP |
| 靜態路由與雙協定 | ✅ | `ping` 支援 IPv6；`show ipv6 route`、`show ipv6 interface brief` |
| DHCPv6 | 🟡 | RA 的 M / O / A 旗標、Stateless 與 Stateful、Relay、binding、DUID / IAID；Windows 收不到 RA 時自己試 DHCPv6。還沒有 Prefix Delegation |
| OSPFv3 | ✅ | 和 OSPFv2 共用同一套計算（DR / BDR、計時、多區域、ECMP、E2 預設路由）；link-local 鄰居與下一站、Router ID 仍是 32 位元（NORTRID）、被動介面、`show ipv6 ospf …`。沒有 IPsec 驗證與 area range |
| IPv6 的 ACL 與防火牆政策 | 🟡 | IOS 的 IPv6 ACL（`ipv6 traffic-filter`、序號、隱含的 ND 允許規則、命中次數）已完成；FortiGate 的 IPv6 政策還沒有 |
| DNS 的 AAAA 記錄 | ⬜ | |
| 過渡機制 | ⬜ | NAT64 / DNS64、通道 |
| IPv6 over VPN | ⬜ | |

## 9. 高可用

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 故障演練 | ✅ | 任務目標可以指定讓某台設備或某條線路故障，再驗證連線 |
| STP 備援路徑 | ✅ | |
| EtherChannel 成員故障 | ✅ | |
| VRRP / HSRP | ✅ | 優先權、搶佔、3 秒接手、虛擬 MAC |
| 雙 WAN、Spine-Leaf | ✅ | |
| 介面追蹤 | ⬜ | VRRP 依上行介面降低優先權 |
| BFD | ⬜ | |
| 堆疊、MLAG / vPC | ⬜ | |
| 防火牆 HA | ⬜ | Active-Passive、連線同步 |
| GLBP | ⬜ | |
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
| 排程事件 | ⬜ | 關卡劇本：「60 秒後主線斷線」 |
| 流量產生器與流量圖 | 🟡 | 主機可以新增持續傳輸；網管畫面有每條線路的使用率與趨勢；沒有整張拓撲的流量熱圖 |

## 11. 設備管理與維運

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 圖形介面 | ✅ | 每一種設備都有對應的設定頁面與即時狀態 |
| IOS CLI | ✅ | 模式切換、縮寫、`no`、Tab 補齊、`?` 說明、`do show` |
| IOS 的查看指令 | ✅ | 四十多個 `show` 指令，包含 MAC 位址表、NAT 轉換表、IPsec SA、時鐘、NTP、紀錄、介面計數器、SPAN、登入的使用者、flash、開機設定、SSH、SNMP |
| 設定可以整份貼回 | ✅ | 測試對 70 台 Cisco 設備、6 台 FortiGate 逐一驗證 |
| running / startup-config | ✅ | `write memory`、`reload`、未存檔的提示、斷電後回到上一次存檔 |
| FortiOS CLI | ✅ | `config` / `edit` / `set` / `next` / `end`、`show`、`get`、`diagnose`、`execute ping` |
| 主機終端機 | ✅ | `ping`、`ipconfig`、`arp`、`tracert`、`nslookup`、`curl`、`iperf3` |
| 封包追蹤 | ✅ | 每一段的 MAC、IP、TTL、埠號、TCP 旗標都可以打開看 |
| 封包擷取 | 🟡 | 主機上的 Wireshark：顯示篩選、逐層標頭；FortiGate 的 `diagnose sniffer packet`；還不能匯出 pcap，沒有 IOS 的 `monitor capture` |
| FortiGate 的 debug flow | ✅ | `diagnose debug flow`：收到封包、找路由、符合哪一條政策、SNAT / DNAT、進 VPN、沒有符合的連線 |
| 遠端登入 | ✅ | 主機 `ssh` / `telnet` 進 IOS 與 FortiGate 的命令列；金鑰指紋、密碼錯誤次數、閒置登出、`terminal monitor`；RSA 金鑰的產生與重建、vty 的 `login` / `login local` / 線路密碼 |
| IOS 的診斷指令 | 🟡 | 已有 `traceroute`、`debug ip packet` / `debug ip icmp`、`show interfaces`、`show ip protocols`、`show ip ospf interface brief`；其他 `debug`（OSPF、DHCP、crypto）還沒有 |
| 設定備份與還原 | ✅ | `copy running-config tftp:` / `ftp:`、`copy tftp: running-config`（合併）與 `startup-config`（取代）；FortiGate 的 `execute backup` / `restore config` |
| 韌體與開機 | ✅ | flash / bootflash 的檔案與空間、`verify /md5`、`boot system`、開機時跳過不存在 / 損毀 / 平台不符的映像檔、ROMMON；FortiGate 的 `execute restore image` 與升級路徑 |
| 設定管理進階 | ⬜ | 差異比對 (`show archive config differences`)、`configure replace`、`archive` 自動備份、IOS XE install 模式 |
| 監控 | 🟡 | Syslog 伺服器、SNMP 網管（輪詢、使用率、Trap）；還沒有 NetFlow |
| 其他廠牌的 CLI | ⬜ | Junos、Aruba、MikroTik、Linux (`ip` / `nmcli`) |
| 文件產出 | ⬜ | 拓撲圖匯出成圖片、IP 規劃表 |

## 12. 自動化、雲端與虛擬化

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| REST API / RESTCONF | ⬜ | 對設備讀寫設定；目前只有觀念題 |
| 設定檔與批次部署 | ⬜ | JSON / YAML、Ansible 風格的 playbook |
| 控制器式網路 | ⬜ | SDN 控制器的視圖與意圖式設定 |
| 雲端 | ⬜ | VPC、子網路、安全群組、NAT Gateway、站到雲 VPN（Network+ 1.3 的缺口） |
| 虛擬化 | ⬜ | vSwitch、VM、容器網路（CCNA 1.12 的缺口） |

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
| 無線控制器 | ⬜ | WLC 與 Lightweight AP |
| 伺服器角色 | 🟡 | 已有 RADIUS、DHCP、Syslog、NTP、TFTP、FTP、SNMP 網管、CUCM；TFTP / FTP / 網管 / CUCM 可以自己啟用；還沒有 DNS |
| 其他 | ⬜ | 數據機 / ONT、負載平衡器、UPS、其他廠牌（Juniper、Aruba、MikroTik） |

## 14. 遊戲系統

| 功能 | 狀態 | 說明 |
| --- | --- | --- |
| 關卡 | ✅ | 12 章 46 關（清單見第 17 節） |
| 任務目標 | ✅ | ping、TCP、UDP、DHCP、設定檢查、故障演練、IPv6 ping、傳輸速率、遠端登入（SSH / Telnet 帳號密碼）、IP 電話註冊、通話品質 (MOS) |
| 提示與星等 | ✅ | 每關 3 個提示，看一個少一顆星 |
| 學習卡 | ✅ | 每關 2 到 4 張觀念說明 |
| 題庫 | ✅ | 93 題觀念題、隨機產生的子網路計算題、過關後的小考 |
| 證照地圖 | ✅ | 三種考試的條目與關卡對照、完成進度 |
| 故障排除章 | ✅ | 網路已經設定好但被改壞，要自己找出原因 |
| 自由模式 | ✅ | 自己擺設備、接線、設定；可以存目標、匯出與匯入 |
| 復原與重做 | ✅ | |
| 進度保存 | ✅ | 自動存檔、`?profile=` 多份進度 |
| 操作說明 | 🟡 | 有說明與圖例；沒有第一次遊玩時逐步帶著做的引導 |
| 參考解法 | 🟡 | 每關都有，但只給測試用；玩家卡關時看不到示範 |
| 關卡編輯 | 🟡 | 自由模式可以匯出拓撲與目標；不能寫敘述、提示，也不能鎖定設備 |
| 評分 | ⬜ | 用時、變更次數、設定是否精簡 |
| 成就 | ⬜ | |
| 隨機故障 | ⬜ | 每次進關卡壞的地方都不一樣 |
| 模擬考模式 | ⬜ | 計時的實作題加選擇題，依考試領域配分 |
| 題庫進階 | ⬜ | 錯題本、間隔重複 |
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
| 邏輯拓撲圖 | ⬜ | 2D 檢視、依 VLAN 或子網路上色 |
| 標註 | ⬜ | 設備標籤、註解、群組框 |
| 主題 | ⬜ | 目前只有深色 |
| 音效 | ⬜ | |
| 離線使用 | ⬜ | PWA |

## 16. 工程品質

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 引擎測試 | ✅ | 關卡重播、負面案例、故障情境、CLI 來回驗證、時鐘、頻寬、資料檢查 |
| 建置 | ✅ | `vite build` |
| 瀏覽器端測試 | ⬜ | 目前靠手動在頁面裡把每一關掃過一遍；應該改成 Playwright |
| CI | ⬜ | 還沒有遠端儲存庫，也沒有自動跑測試與建置 |
| 靜態檢查 | ⬜ | ESLint、型別檢查 |
| 模組拆分 | ⬜ | `sim.js` 接近 2000 行，應該依層級拆開 |
| 打包體積 | ⬜ | 目前是單一個 1.1 MB 的檔案，應該分塊載入 |
| 大型拓撲效能 | ⬜ | 每次變更都全部重算，還沒有量過上百台設備的表現 |
| 存檔格式遷移 | ⬜ | 設定結構改版時，舊存檔沒有遷移機制 |
| 部署 | ⬜ | GitHub Pages 之類的靜態網站 |

---

## 17. 關卡規劃

### 現有的 54 關

| 章 | 關卡 |
| --- | --- |
| 1 家用網路 | 第一條網路線、換上交換器、自動發 IP、連上網際網路 |
| 2 小型辦公室 | 辦公室開張、部門隔離、跨樓層、跨 VLAN 路由 |
| 3 企業網路 | 守門員、總公司與分公司、對外伺服器群 |
| 4 資料中心 | 機櫃上線、Spine-Leaf、跨棟連線 |
| 5 無線網路 | 家裡的 Wi-Fi、辦公室基地台、訪客 Wi-Fi |
| 6 網路安全 | 誰在發 IP？、不速之客、存取控制清單、管理介面加固、冒牌閘道、搶走根橋、你是誰？、偽裝成交換器 |
| 7 VPN 與廣域備援 | 站對站 VPN、在家上班、雙線路備援、三個據點，一個中心 |
| 8 高可用與進階路由 | 迴圈與生成樹、EtherChannel、閘道備援、集中式 DHCP、OSPF 路徑選擇、切蛋糕 |
| 9 IPv6 | IPv6 初體驗、雙協定、位址從哪裡來？、IPv6 也要動態路由、封了 IPv4，忘了 IPv6 |
| 10 故障排除 | 誰搶了我的 IP、樓層之間又斷了、分公司的求救電話、明明連得上，為什麼這麼慢 |
| 11 維運與管理 | 還好有備份、韌體升級、讓 SSH 能用、網路怎麼變慢了 |
| 12 語音與 QoS | 電話接上了，然後呢？、語音斷斷續續 |
| 13 進階路由 | 誰當 DR？、10G 和 1G 一樣快？、分公司自成一區、兩家 ISP 都要用 |

### 規劃中的關卡

每一章都要先有對應的引擎功能（括號內是第幾節）。

| 章 | 規劃的關卡 | 需要的功能 |
| --- | --- | --- |
| 補進第 11 章 | 對時與紀錄（用 NTP 與 Syslog 把事件順序對起來）、設定被誰改了（差異比對） | 第 4、11 節 |
| 補進第 13 章 | 路由重分配、iBGP、OSPF 的 stub 區域、IP SLA 追蹤上游 | 第 3、9 節 |
| 補進第 12 章 | 不看圖用 CDP / LLDP 把拓撲畫出來、PoE 預算不夠、雙 WAN 的 QoS | 第 1、2、10 節 |
| 14 無線控制器 | 用 WLC 集中管理 AP、漫遊、訪客入口 | 第 7、13 節 |
| 15 自動化 | 用 REST API 讀設定、用 JSON 批次改 VLAN、用 playbook 部署多台設備 | 第 12 節 |
| 16 雲端 | VPC 與安全群組、站到雲 VPN | 第 12 節 |
| 補進第 6 章 | MAC flooding、雙重標籤、NGFW 設定檔 | 第 2、5 節 |
| 補進第 7 章 | GRE over IPsec 與 VTI、DMVPN、憑證驗證 | 第 6 節 |
| 補進第 9 章 | Prefix Delegation、FortiGate 的 IPv6 政策、NAT64 / DNS64 | 第 8 節 |
| 補進第 10 章 | OSPF 鄰居起不來、VPN 通了但流量不走、Wi-Fi 很慢、STP 選錯根橋、隨機故障 | 第 14 節 |

## 18. 證照涵蓋

| 考試 | 已有關卡的條目 | 還沒有關卡的條目 |
| --- | --- | --- |
| Cisco CCNA 200-301 v1.1 | 53 條中的 42 條 | 見下表 |
| CompTIA Network+ N10-009 | 25 條中的 24 條 | 1.3 雲端概念與連線選項 |
| CompTIA Security+ SY0-701 | 網路相關的 11 條，全部有對應 | — |

CCNA 還沒有關卡的 11 條，以及補上的方式：

| 條目 | 內容 | 規劃 |
| --- | --- | --- |
| 1.5 | TCP 與 UDP 的比較 | 用封包擷取比較兩種連線（第 11 節） |
| 1.12 | 虛擬化基礎 | 虛擬化關卡（第 12 節） |
| 2.6 | 無線架構與 AP 模式 | 第 14 章 |
| 5.2 | 安全計畫的要素 | 觀念題即可 |
| 6.1 – 6.7 | 自動化、控制器式網路、AI、REST API、Ansible / Terraform、JSON | 第 15 章；6.1、6.4 維持觀念題 |

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
| 7 | 無線控制器、牆面衰減、漫遊 → 第 14 章 | 補上 CCNA 2.6 |
| 8 | 自動化與雲端 → 第 15、16 章 | 補上 CCNA 第 6 領域、Network+ 1.3 |
| 9 | 隨機故障、模擬考模式、評分、關卡編輯器 | 引擎功能齊全之後，重玩價值才撐得起來 |
| 隨時 | Playwright 測試、CI、拆分 `sim.js`、分塊載入 | 功能越多越需要，建議在階段 2 之前先做測試與拆檔 |
