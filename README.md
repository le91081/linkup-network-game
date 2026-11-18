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
| 拖曳空白處 / 滾輪 / 右鍵拖曳 | 平移 / 縮放 / 旋轉 |
| 執行測試 | 播放封包動畫並檢查任務目標，空白鍵快轉 |
| Shift + 拖曳設備（自由模式） | 移動設備 |

- 電腦與伺服器有「終端機」分頁：`ping`（支援 IPv6）、`ipconfig`、`ipconfig /renew`、`arp -a`、`tracert`、`nslookup`、`curl`。
- Cisco 的路由器與交換器有「CLI」分頁：IOS 風格的命令列。`show running-config`、`show ip route`、`show vlan brief`、`show interfaces trunk`、`show arp` 等近二十個 `show` 指令用來查看狀態；輸入 `configure terminal` 之後可以直接用指令設定（見下方「CLI 設定指令」），改的和圖形介面是同一份設定。
- 防火牆有「紀錄」分頁，家用路由器與路由器的「狀態」分頁有連線紀錄與 NAT 轉換表；政策與 ACL 規則會顯示命中次數。
- 頂端列的「測驗」是觀念題與子網路速算，「證照」是考試大綱與關卡的對照表。
- 關卡選單最上方的「自由模式」是沙盒：自己擺設備、接線、設定。可以把測試存成「應該要通 / 應該不通」的目標一鍵重跑，也可以把整個拓撲匯出成 JSON 檔再匯入。

## 關卡（10 章 38 關）

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
| 10 故障排除 | 3 | 網路已經設定好但被改壞了：IP 衝突與 DHCP 保留、Trunk / VLAN / shutdown、閘道 / 回程路由 / NAT / ACL / DNS |

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
把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定（測試會對 52 台設備逐一驗證）。

| 模式 | 指令 |
| --- | --- |
| 全域 | `hostname`、`interface` / `interface range` / `interface vlan`、`vlan`、`ip route`、`ipv6 route`、`router ospf`、`ip dhcp pool`、`ip dhcp excluded-address`、`ip nat inside source …`、`ip access-list extended`、`spanning-tree vlan … priority`、`ip dhcp snooping`、`ip arp inspection vlan`、`line vty`、`ntp server`、`logging host`、`snmp-server community`、`username` |
| 介面 | `ip address`、`shutdown`、`switchport mode / access vlan / trunk native vlan / trunk allowed vlan`、`no switchport`、`encapsulation dot1q`、`ip nat inside / outside`、`ip helper-address`、`ip ospf cost`、`ip access-group`、`vrrp`、`channel-group`、`switchport port-security`、`spanning-tree bpduguard`、`ip dhcp snooping trust`、`ipv6 address` |
| 其他 | VLAN 的 `name`、OSPF 的 `network` 與 `default-information originate`、DHCP 位址池的 `network` / `default-router` / `dns-server`、ACL 的 `permit` / `deny`、`line vty` 的 `transport input` / `access-class` |

在設定模式下要看狀態請用 `do show …`。

## 貼近真實網路的行為

- **ARP**：第一次要送封包給某個 IP 之前，會先廣播詢問它的 MAC（橘色光點擴散到整個廣播網域），問到之後記在 ARP 快取裡，下一個封包就不再詢問。
- **Hub 泛洪**：經過 Hub 的訊框會被複製到其他每一個埠；接到 Hub 的連線是 10 Mbps 半雙工。
- **DHCP 四步驟**：Discover（廣播）→ Offer → Request（廣播）→ Ack，經由 Relay 時會顯示轉送；DHCP 伺服器可以設定保留位址（依 MAC 固定發同一個 IP）。
- **封包標頭**：追蹤紀錄的每一段都可以打開，看到來源 / 目的 MAC 每過一台路由器就換一次，IP 只有經過 NAT 才會變，TTL 逐站遞減。
- **連線紀錄**：防火牆記錄每一條新連線是被哪一條政策放行或拒絕，以及來源 / 目的位址的轉換。
- **偵測常見的設定錯誤**：IP 位址衝突、Trunk 與 Access 對接、Native VLAN 不一致、兩端 Access VLAN 不同。
- **無線訊號**：依距離與發射功率估算 RSSI，近的用 5GHz、遠的退回 2.4GHz，頻道重疊時速率減半。
- **故障模擬**：任何設備都可以關機，路由器的介面與交換器的連接埠可以 `shutdown`；錯誤訊息會指出是哪一台關機或哪個介面被停用。

## 模擬的範圍與簡化

- 只要設定或接線有變動，所有設備的 ARP 快取就會清空（真實設備是逐筆逾時）。
- Hub 只表現出泛洪與半雙工，不模擬碰撞造成的重送。
- 連線速率只取兩端連接埠較慢的那一邊，不模擬線材等級或手動設定速率造成的雙工不一致。

- STP 以每個 VLAN 各算一棵樹的方式近似 Rapid PVST+，只處理交換器直接相連的情況；非網管交換器形成迴圈會被判定為廣播風暴。
- VPN 是 policy-based 的 IPsec；遠端存取 VPN 不區分 SSL 與 IPsec。
- Wi-Fi 的訊號只看距離與發射功率，沒有牆面衰減。
- 802.1X 只驗證帳號密碼（沒有憑證）。
- IPv6 目前只有位址、SLAAC、靜態路由與 ping；ACL、防火牆、NAT、OSPF 仍然只作用在 IPv4。
- CLI 沒有 startup-config，`write memory` 只會回應 OK；VPN、PPPoE 帳號密碼與防火牆政策仍然要用圖形介面設定，也沒有 Tab 補齊。
- OSPF 的 `network` 只會套用到當下已經有 IP 的介面。

## 還可以做的

1. IPv6 的 ACL、防火牆政策與 OSPFv3。
2. Voice VLAN、Root Guard、TACACS+。
3. QoS、SNMP Trap、設定備份等維運情境的關卡（目前的模擬沒有頻寬與時間的概念）。
4. CLI 的 Tab 補齊，以及用指令設定 VPN。

## 程式結構

```
src/engine/   模擬引擎（不依賴瀏覽器，可直接用 Node 測試）
  ip.js、ip6.js   IPv4 / IPv6 位址工具
  model.js        設備型錄（真實機型）、線材與狀態物件
  ios.js          IOS 風格的設定指令解譯器，以及 show running-config
  sim.js          供電與連線狀態、L2（VLAN / STP / LACP / Port Security / DHCP Snooping / DAI / 802.1X / Wi-Fi）、
                  L3（路由 / OSPF / VRRP）、DHCP 與 Relay、PPPoE、NAT、ACL、防火牆政策、VPN、DNS
  sim6.js         IPv6：SLAAC、鄰居探索、靜態路由
src/levels/   關卡定義：設備、初始設定、任務目標、提示、參考解法（trouble.js 是故障排除章）
src/data/     題庫與證照對照表
src/scene/    three.js 場景、設備模型、網路線、無線涵蓋範圍與封包動畫
src/ui/       設定面板、終端機、CLI、任務面板、測驗、自由模式與對話框
test/         對每個關卡套用參考解法，並用負面案例確認引擎真的會擋
```

新增關卡：在 `src/levels/` 的 `LEVELS` 加一筆，寫好 `setup()`、`objectives` 與 `solve()`，
在 `src/data/certs.js` 補上對應的考試條目，再跑 `npm test`。
