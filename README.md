# LinkUp — 從一條網路線到資料中心

親手接線、親手設定，讓封包抵達目的地的網路工程解謎遊戲。
three.js 負責 3D 場景，設定頁面是 HTML，底層是一套自己寫的網路模擬引擎。

## 執行

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 驗證所有關卡、負面案例與題庫資料
npm run build    # 輸出到 dist/
```

## 玩法

| 操作 | 效果 |
| --- | --- |
| 在設備上按住拖曳到另一台設備 | 接上網路線（需要時會讓你選連接埠與線材） |
| 點設備 | 開啟它的管理頁面 |
| 點網路線 | 查看線材、距離與協商出來的速率，或拔除 |
| 點追蹤紀錄裡標著「封包」的那一行 | 檢視那一段訊框的 MAC、IP、TTL 與埠號 |
| Ctrl + Z / Ctrl + Y | 復原 / 重做上一個設定或接線變更 |
| 設備面板右上角的電源鈕 | 把設備關機或開機，模擬故障來驗證備援 |
| Cisco 設備面板右上角的磁片 | 有尚未儲存的設定時會亮起，點一下等於 `write memory` |
| 拖曳空白處 / 滾輪 / 右鍵拖曳 | 平移 / 縮放 / 旋轉 |
| 執行測試 | 播放封包動畫並檢查任務目標，空白鍵快轉 |
| 場景上方的時鐘 | 暫停 / 繼續模擬時間、切換 1× / 10× / 60×、直接前進 30 秒；出現「收斂中」時點一下會快轉到網路穩定為止 |
| Shift + 拖曳設備（自由模式） | 移動設備 |

- 電腦與伺服器有「終端機」分頁：`ping`（支援 IPv6）、`ipconfig`、`ipconfig /renew`、`ipconfig /release`、`arp -a`、`arp -d`、`tracert`、`nslookup`、`curl`、`date`、`iperf3 -c <IP>`（量實際傳輸速率，會讓時間前進 10 秒）。
- Cisco 的路由器與交換器有「CLI」分頁：IOS 風格的命令列。`show running-config`、`show startup-config`、`show ip route`、`show vlan brief`、`show interfaces trunk`、`show arp` 等三十多個 `show` 指令用來查看狀態；輸入 `configure terminal` 之後可以直接用指令設定（見下方「CLI 設定指令」），改的和圖形介面是同一份設定。
- FortiGate 防火牆也有「CLI」分頁，用的是 FortiOS 的階層式語法（`config firewall policy` → `edit 1` → `set …` → `next` → `end`）。
- 網址加上 `?profile=名稱` 會使用另一份獨立的進度，適合多人共用一台電腦。
- 防火牆有「紀錄」分頁，家用路由器與路由器的「狀態」分頁有連線紀錄與 NAT 轉換表；政策與 ACL 規則會顯示命中次數。
- 頂端列的「測驗」是觀念題與子網路速算，「證照」是考試大綱與關卡的對照表。
- 關卡選單最上方的「自由模式」是沙盒：自己擺設備、接線、設定。可以把測試存成「應該要通 / 應該不通」的目標一鍵重跑，也可以把整個拓撲匯出成 JSON 檔再匯入。

## 關卡（10 章 39 關）

| 章節 | 關卡數 | 主題 |
| --- | --- | --- |
| 1 家用網路 | 4 | Hub、Switch、固定 IP、DHCP、PPPoE、NAT、DNS |
| 2 小型辦公室 | 4 | 固定 IP 線路、連接埠轉發、VLAN、Trunk、子介面 |
| 3 企業網路 | 3 | 防火牆政策與 DMZ、靜態路由與回程路由、一對一靜態 NAT |
| 4 資料中心 | 3 | ToR 與 SVI、Spine-Leaf 與 OSPF、銅纜 / 多模 / 單模光纖與距離 |
| 5 無線網路 | 3 | SSID、WPA2 / WPA3、PoE、頻道規劃、訪客 SSID 對應 VLAN |
| 6 網路安全 | 7 | DHCP Snooping、Port Security、ACL、管理加固、DAI、BPDU Guard、802.1X / RADIUS |
| 7 VPN 與廣域備援 | 3 | 站對站 IPsec、遠端存取 VPN、雙線路浮動靜態路由 |
| 8 高可用與進階路由 | 6 | STP、EtherChannel、VRRP / HSRP、DHCP Relay、OSPF Cost、VLSM |
| 9 IPv6 | 2 | Link-local、SLAAC、IPv6 靜態路由、雙協定 |
| 10 故障排除 | 4 | 網路已經設定好但被改壞了：IP 衝突與 DHCP 保留、Trunk / VLAN / shutdown、閘道 / 回程路由 / NAT / ACL / DNS、ping 會通但傳檔很慢（速率寫死、duplex mismatch、舊 Hub） |

## 證照對照

`src/data/certs.js` 把每一關對應到考試大綱的條目，遊戲內的「證照地圖」會顯示涵蓋與完成的進度。

| 考試 | 有對應關卡的條目 | 還沒有關卡的條目 |
| --- | --- | --- |
| Cisco CCNA 200-301 v1.1 | 53 條中的 39 條 | 1.5、1.12、2.3、2.6、4.7、4.9、5.2 與第 6 領域（自動化） |
| CompTIA Network+ N10-009 | 25 條中的 23 條 | 1.3（雲端）、3.1（組織流程） |
| CompTIA Security+ SY0-701 | 只列出與網路相關的 11 條，全部有對應 | — |

沒有關卡的條目大多是觀念題，題庫裡有對應的題目（TCP / UDP、CDP / LLDP、QoS、TFTP、AAA、REST API、JSON、Ansible 等）。
條目編號依公開的考試大綱，標題是中文摘要。CCNA v2.0 預計在 2027 年 2 月取代 v1.1，改版後需要重新對照。
題庫（76 題觀念題加上隨機產生的子網路計算題）是自行編寫的練習題，不是實際試題。

## CLI 設定指令

支援的範圍是 `show running-config` 會印出來的那些指令，都可以縮寫（`conf t`、`int gi0/1`、`sw mo tr`），前面加 `no` 是取消。
把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定（測試會對 54 台設備逐一驗證）。

| 模式 | 指令 |
| --- | --- |
| 全域 | `hostname`、`interface` / `interface range` / `interface vlan`、`vlan`、`ip route`、`ipv6 route`、`router ospf`、`ip dhcp pool`、`ip dhcp excluded-address`、`ip nat inside source …`、`ip access-list extended`、`spanning-tree vlan … priority`、`ip dhcp snooping`、`ip arp inspection vlan`、`line vty`、`ntp server`、`logging host`、`snmp-server community`、`username` |
| 介面 | `ip address`、`shutdown`、`switchport mode / access vlan / trunk native vlan / trunk allowed vlan`、`no switchport`、`encapsulation dot1q`、`ip nat inside / outside`、`ip helper-address`、`ip ospf cost`、`ip access-group`、`vrrp`、`channel-group`、`switchport port-security`、`spanning-tree bpduguard`、`ip dhcp snooping trust`、`ipv6 address` |
| 其他 | VLAN 的 `name`、OSPF 的 `network` 與 `default-information originate`、DHCP 位址池的 `network` / `default-router` / `dns-server`、ACL 的 `permit` / `deny`、`line vty` 的 `transport input` / `access-class` |

在設定模式下要看狀態請用 `do show …`。按 Tab 可以補齊指令，指令打到一半加上 `?` 會列出接下來可以輸入的字。

另外還支援：

- **VPN**：`crypto isakmp policy`（encryption / hash / group）、`crypto isakmp key … address …`、`crypto ipsec transform-set`、`crypto map … ipsec-isakmp`（`set peer`、`set transform-set`、`set pfs`、`match address`），以及介面上的 `crypto map`。
- **NAT 的範圍**：`ip nat inside source list <ACL>` 可以指定編號或具名的 ACL，`access-list <編號>` 也能用。
- **DHCP 保留位址**：只有一台主機的位址池（`host` 加上 `hardware-address`）。
- **實體層**：`speed`、`duplex`。
- **STP 的邊緣埠**：`spanning-tree portfast`（介面，`disable` / `trunk`）、`spanning-tree portfast default`（全域）、`spanning-tree guard root`。
- **DHCP 租約長度**：位址池裡的 `lease <天> [小時] [分鐘]` 或 `lease infinite`。
- **跟時間有關的查看指令**：`show clock`、`show spanning-tree`（LSN / LRN / FWD）、`show ip ospf neighbor`（Dead Time）、`show ip dhcp binding`（到期時間）、`show arp`（Age）、`clear arp`。
- **存檔**：`write memory` / `copy running-config startup-config`、`show startup-config`、`reload`。
- **MAC 位址表**：`show mac address-table`、`show mac address-table aging-time`、`mac address-table aging-time <秒>`、`clear mac address-table dynamic`。
- **NAT 轉換表**：`show ip nat translations [verbose]`、`show ip nat statistics`、`ip nat translation icmp-timeout | udp-timeout | tcp-timeout | … <秒>`、`clear ip nat translation *`。
- **VPN 的時間面**：`show crypto isakmp sa`、`show crypto ipsec sa`、isakmp policy 裡的 `lifetime`、`crypto ipsec security-association lifetime seconds`、crypto map 裡的 `set security-association lifetime seconds`、`crypto isakmp keepalive <秒> [重試間隔]`。
- **時鐘與 NTP**：`show clock [detail]`、`clock set`、`clock timezone`、`ntp server`、`ntp master [stratum]`、`show ntp status`、`show ntp associations`。
- **紀錄**：`show logging`、`logging host`、`logging trap <等級>`、`clear logging`。
- **OSPF**：`router-id`。

### FortiGate（FortiOS）

`show` 印出來的整份設定可以貼到另一台 FortiGate。支援的區段：

| 區段 | 內容 |
| --- | --- |
| `system interface` | 介面的 mode、ip、allowaccess（每個介面各自開放的管理協定） |
| `system dhcp server` | 位址範圍（`config ip-range`）、閘道、DNS、保留位址 |
| `firewall address` / `addrgrp` | 位址物件與群組；政策裡用名稱引用 |
| `firewall vip` | 連接埠轉發，或一對一的靜態 NAT |
| `firewall policy` | 介面、位址、服務、動作、NAT；`move` 調整順序、`delete` 刪除 |
| `vpn ipsec phase1-interface` / `phase2-interface` | 站對站 IPsec：提案可以列好幾組，第二階段預設開啟 PFS；`keylife` / `keylifeseconds`（金鑰壽命）、`dpd`（對端失聯偵測） |
| `system session-ttl` | TCP 連線可以閒置多久 |
| `vpn ssl settings` / `vpn ssl web portal`、`user local` / `user group` | 遠端存取的 SSL-VPN |
| `router static` | 靜態路由；用指令建立的通道要有一筆 `set device "<通道>"` 的路由才會導流量 |
| `system global`、`system admin`、`system ntp`、`log syslogd setting`、`system snmp community` | 主機名稱與管理設定 |

查看狀態：`get system status`、`get system interface`、`get router info routing-table all`、`get vpn ipsec tunnel summary`、`diagnose vpn tunnel list`、`diagnose vpn ike gateway list`、`diagnose sys session list`、`diagnose sys session clear`、`diagnose sys ntp status`、`execute log display`、`execute date`、`execute time`、`execute ping`。

## 模擬時間

所有設備共用一個時鐘（場景上方的 `T+00:00:00`），以下這些事情都要「等」，等待期間測試會失敗並說明還在等什麼：

| 項目 | 時間 | 說明 |
| --- | --- | --- |
| STP 邊緣埠 | 30 秒 | 連線後先 listening 15 秒、learning 15 秒才轉送；開了 PortFast 的埠立刻轉送。等待中的網路線會閃橘色 |
| 交換器之間的連線 | 2 秒 | 兩端都跑 Rapid STP，用提議 / 同意快速收斂 |
| OSPF 鄰居建立 | 40 秒 | 乙太網路上要先等 DR 選舉 (Wait timer) 才會交換路由 |
| OSPF 鄰居失聯 | 40 秒 | 隔著交換器、自己的介面沒有斷的時候，要等 Dead timer 才發現；這段時間封包照舊送往已經不在的鄰居 |
| VRRP 接手 | 3 秒 | Backup 連續沒聽到通告才成為 Master；原本的 Master 回來時立刻搶回 |
| DHCP 租約 | 預設 1 天 | 過一半時間自動續約；伺服器連不到時，到期前繼續使用，到期後退回 169.254.x.x |
| ARP 快取 | 主機 2 分鐘、防火牆與家用路由器 5 分鐘、Cisco 4 小時 | 逐筆計時，用到就更新；介面斷線時清掉 |
| MAC 位址表 | 300 秒 | 交換器收到訊框才學到來源 MAC，太久沒看到就忘記；斷線或生成樹拓撲改變時清掉。不認得目的 MAC 時會把訊框送往整個 VLAN |
| NAT 轉換與連線表 | ICMP 60 秒、UDP 3 – 5 分鐘、TCP 關閉後 1 – 2 分鐘 | 依設備種類不同（IOS、FortiGate、家用路由器），可以調整 |
| IPsec 協商 | 2 秒 | 兩端設定好之後要先完成 IKE 才會 Up |
| IPsec 金鑰壽命 | 第一階段 1 天；第二階段 IOS 1 小時、FortiGate 12 小時 | 兩端不同時取較短的，到期自動重新協商，流量不中斷 |
| VPN 對端失聯 | FortiGate 60 秒；IOS 要等金鑰到期 | 這段時間通道還顯示 Up，封包照樣加密送出去然後被丟掉。IOS 設了 `crypto isakmp keepalive` 才會主動探測 |
| NTP 對時 | IOS 約 4 分鐘、FortiGate 立刻 | 每 64 秒輪詢一次；IOS 要連續幾次都正常才採信。伺服器失聯八次輪詢之後失去同步 |

關卡裡的交換器已經預先開好 `spanning-tree portfast default`，不用每接一條線就等 30 秒；自由模式的設備是原廠預設值，要自己開。
時間只在遊戲分頁開著、沒有對話框的時候前進。復原 / 重做不會把時鐘倒轉。

## 設備的時鐘與紀錄

- 每台設備有自己的時鐘。Catalyst 2960 沒有硬體時鐘，沒對時的話時間從 1993 年 3 月 1 日算起；路由器與防火牆有硬體時鐘，但會快或慢幾分鐘。`show clock` 前面的 `*` 代表這個時間不可信。
- 對時對的是上游那一台的時間：把一台時間設錯的路由器當成 `ntp master`，下游全部跟著錯。
- 設備會記下發生的事：介面上線與斷線、err-disabled、OSPF 鄰居、VRRP 換手、VPN 通道、IP 衝突、duplex mismatch、有人改過設定、重新開機。紀錄放在記憶體裡（`show logging`），重開機就沒了。
- 設定了 Syslog 伺服器，訊息會用 UDP 514 送過去；伺服器連不到，那一筆就掉了。伺服器（有 Syslog 服務的主機）有一個「Syslog」分頁可以看收到的訊息。
- 紀錄上的時間是設備自己的時間，所以沒對時的設備，紀錄會和別人對不起來。

## 頻寬與傳輸速率

`iperf3 -c <IP>` 或「傳輸速率」目標會沿著實際路徑找出最慢的一段：

- 全雙工連線約為標稱速率的 94%（扣掉訊框與 TCP 標頭）。
- 半雙工（接到 Hub）約 40%。
- Duplex mismatch 只剩標稱速率的 1%（上限 2 Mbps），並出現大量重送：ping 會通，傳檔卻慢得不能用。
- Wi-Fi 約為連線速率的一半；IPsec 通道再扣 10%。

## 貼近真實網路的行為

- **網路線插在真正的連接埠上**：每條線都從它接的那個孔出發；連接埠的燈號跟著實際的連線狀態（綠色是連上，琥珀色是被 STP 封鎖或還在等待）。
- **ARP**：第一次要送封包給某個 IP 之前，會先廣播詢問它的 MAC（橘色光點擴散到整個廣播網域），問到之後記在 ARP 快取裡，下一個封包就不再詢問。
- **Hub 泛洪**：經過 Hub 的訊框會被複製到其他每一個埠；接到 Hub 的連線是 10 Mbps 半雙工。
- **DHCP 四步驟**：Discover（廣播）→ Offer → Request（廣播）→ Ack，經由 Relay 時會顯示轉送；DHCP 伺服器可以設定保留位址（依 MAC 固定發同一個 IP）。
- **封包標頭**：追蹤紀錄的每一段都可以打開，看到來源 / 目的 MAC 每過一台路由器就換一次，IP 只有經過 NAT 才會變，TTL 逐站遞減。
- **連線紀錄**：防火牆記錄每一條新連線是被哪一條政策放行或拒絕，以及來源 / 目的位址的轉換。
- **偵測常見的設定錯誤**：IP 位址衝突、Trunk 與 Access 對接、Native VLAN 不一致、兩端 Access VLAN 不同。
- **無線訊號**：依距離與發射功率估算 RSSI，近的用 5GHz、遠的退回 2.4GHz，頻道重疊時速率減半。
- **Root Guard**：啟用的埠如果收到更優先的根橋 BPDU 就進入 root-inconsistent 而被擋下；開在朝向根橋的埠上（錯誤設定）一樣會被擋。
- **TCP 三向交握**：TCP 連線會走完 SYN → SYN-ACK → ACK；防火牆與 NAT 設備用連線紀錄比對後續的封包，不會重新比對政策。
- **DHCP 發放前先確認**：伺服器發出新位址前會先 ping，已經有人在用就跳過並記成衝突；但設備離線期間發出去的租約不會重新檢查，回來之後照樣衝突。
- **IPsec 兩階段**：第一階段 (IKE) 與第二階段 (IPsec SA、PFS) 分開協商，哪一個階段不一致會分別指出。IOS 的 ISAKMP 政策整台共用。
- **先 NAT 再加密**：路由器會先做 NAT 才比對 crypto map，站對站 VPN 沒有設 NAT 例外的話，通道是 Up 的但流量進不去。
- **running-config 與 startup-config**：IOS 設備改的是 running-config，沒有 `write memory` 就 `reload` 或斷電，設定會回到上一次存檔的樣子。
- **速率與雙工**：一端寫死、另一端自動協商時，自動的那一端會退回半雙工，形成 duplex mismatch；兩端速率寫死成不同的值則連線建立不起來。
- **OSPF 的 network 敘述**：持續生效，之後才設定 IP 的介面只要位址符合就自動加入。
- **管理存取**：FortiGate 每個介面各自決定開放 ping / HTTPS / SSH / HTTP / Telnet。
- **故障模擬**：任何設備都可以關機，路由器的介面與交換器的連接埠可以 `shutdown`；錯誤訊息會指出是哪一台關機或哪個介面被停用。

## 模擬的範圍與簡化

- MAC 位址表會學習、過期與泛洪，但實際的轉送路徑仍然由拓撲算出，所以不會出現「表裡的項目指到錯的埠」這種狀況。
- 測試用的連線（ping、curl、iperf3）建立之後就結束了，沒有長時間保持的連線。所以連線逾時目前只會讓表裡的項目消失，還不會造成「閒置太久被防火牆切斷」。
- `reload` 與開機是瞬間完成的（真實設備要一到數分鐘）。
- NTP 只有一台伺服器、沒有驗證；設備的時鐘不會慢慢漂移（沒對時的誤差是固定的）。
- 頻寬是每條路徑各自計算，多條連線同時搶同一條線路時不會互相擠壓；沒有 QoS。Hub 的碰撞只反映在速率打折上。
- 遠端存取的 SSL-VPN 沒有連線建立的時間。
- STP 以每個 VLAN 各算一棵樹的方式近似 Rapid PVST+，只處理交換器直接相連的情況；非網管交換器形成迴圈會被判定為廣播風暴。邊緣埠用的是傳統的 30 秒計時（和 Cisco 預設的 PVST+ 一樣）。
- IPsec 只有 IKEv1 與預先共用金鑰。圖形介面建立的 FortiGate 通道會自動帶出通往對端的路由（相當於用精靈建立）。SSL-VPN 的加密流量在引擎內部仍然當成一層封裝來處理。
- Wi-Fi 的訊號只看距離與發射功率，沒有牆面衰減。
- 802.1X 只驗證帳號密碼（沒有憑證）。
- IPv6 目前只有位址、SLAAC、靜態路由與 ping；ACL、防火牆、NAT、OSPF 仍然只作用在 IPv4。
- PPPoE 的帳號密碼要在圖形介面設定（IOS 沒有做 Dialer 介面）。兩種 CLI 都只涵蓋這個遊戲有模擬的功能。

## 還可以做的

完整的功能規劃（每個領域已完成、部分完成、尚未開始的項目，以及建議的實作順序）在 [PLAN.md](PLAN.md)。以下是最接近的幾項：

1. IPv6 的 ACL、防火牆政策與 OSPFv3。
2. Voice VLAN（需要新的 IP 電話設備）、TACACS+、IKEv2、IOS 的 Dialer 介面。
3. QoS 與多條連線互相搶頻寬、SNMP Trap、設定備份等維運情境的關卡。
4. Wi-Fi 的牆面衰減、802.1X 的憑證驗證。
5. 從電腦 SSH 進設備（長時間保持的連線、閒置逾時）、開機需要時間、SNMP 監控。

## 程式結構

```
src/engine/   模擬引擎（不依賴瀏覽器，可直接用 Node 測試）
  ip.js、ip6.js   IPv4 / IPv6 位址工具
  model.js        設備型錄（真實機型）、線材與狀態物件
  ios.js          IOS 風格的設定指令解譯器、show running-config、startup-config
  fortios.js      FortiOS 風格的設定樹（config / edit / set / next / end）
  ops.js          每台設備的時鐘、NTP、事件紀錄與 Syslog
  sim.js          供電與連線狀態、L2（VLAN / STP / LACP / Port Security / DHCP Snooping / DAI / 802.1X / Wi-Fi）、
                  L3（路由 / OSPF / VRRP）、DHCP 與 Relay、PPPoE、NAT、ACL、防火牆政策、VPN、DNS、
                  模擬時鐘（advance / settle / pendingOf）與傳輸速率（throughput）
  sim6.js         IPv6：SLAAC、鄰居探索、靜態路由
src/levels/   關卡定義：設備、初始設定、任務目標、提示、參考解法（trouble.js 是故障排除章）
src/data/     題庫與證照對照表
src/scene/    three.js 場景、設備模型、網路線、無線涵蓋範圍與封包動畫
src/ui/       設定面板、終端機、CLI、任務面板、測驗、自由模式與對話框
test/         對每個關卡套用參考解法，並用負面案例確認引擎真的會擋
```

新增關卡：在 `src/levels/` 的 `LEVELS` 加一筆，寫好 `setup()`、`objectives` 與 `solve()`，
在 `src/data/certs.js` 補上對應的考試條目，再跑 `npm test`。
