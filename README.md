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

- 電腦與伺服器有「終端機」分頁：`ping`（支援 IPv6）、`ipconfig`、`ipconfig /renew`、`ipconfig /release`、`arp -a`、`arp -d`、`tracert`、`nslookup`、`curl`、`date`、`netstat -e`、`iperf3 -c <IP>`（量實際傳輸速率，會讓時間前進 10 秒），以及 `ssh 帳號@IP`、`telnet IP` 登入網路設備的命令列（見下方「遠端登入」）。
- 電腦與伺服器還有「封包擷取」分頁：像 Wireshark 一樣記下網路卡收送的訊框，可以用 `ip.addr == …`、`tcp.port == …`、`arp`、`telnet` 之類的條件篩選，點一下看每一層的標頭。
- Cisco 的路由器與交換器有「CLI」分頁：IOS 風格的命令列。`show running-config`、`show startup-config`、`show ip route`、`show vlan brief`、`show interfaces trunk`、`show arp` 等四十多個 `show` 指令用來查看狀態；輸入 `configure terminal` 之後可以直接用指令設定（見下方「CLI 設定指令」），改的和圖形介面是同一份設定。
- FortiGate 防火牆也有「CLI」分頁，用的是 FortiOS 的階層式語法（`config firewall policy` → `edit 1` → `set …` → `next` → `end`）。
- 伺服器的「網路設定」分頁可以開啟伺服器角色：TFTP、FTP、SNMP 網管 (NMS)。有 TFTP / FTP 的伺服器多一個「檔案」分頁（備份上來的設定、放在上面的韌體），網管伺服器多一個「網管」分頁（輪詢結果、每條線路的使用率、收到的 Trap）。
- 電腦與伺服器可以「新增持續傳輸」：一條一直在跑的背景流量（例如每天下午的大量存檔），會和其他連線搶同一條線路的頻寬。
- 網址加上 `?profile=名稱` 會使用另一份獨立的進度，適合多人共用一台電腦。
- 防火牆有「紀錄」分頁，家用路由器與路由器的「狀態」分頁有連線紀錄與 NAT 轉換表；政策與 ACL 規則會顯示命中次數。
- 頂端列的「測驗」是觀念題與子網路速算，「證照」是考試大綱與關卡的對照表。
- 關卡選單最上方的「自由模式」是沙盒：自己擺設備、接線、設定。可以把測試存成「應該要通 / 應該不通」的目標一鍵重跑，也可以把整個拓撲匯出成 JSON 檔再匯入。

## 關卡（11 章 43 關）

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
| 11 維運與管理 | 4 | 從 TFTP 還原設定（合併與整份取代的差別）、韌體升級（flash 空間、MD5、`boot system`、TFTP 與 FTP 的速度）、讓原廠交換器能用 SSH（主機名稱、網域、RSA 金鑰、`login local`）、用 SNMPv3 找出滿載的線路（線對斷掉自動降到 100 Mbps） |

## 證照對照

`src/data/certs.js` 把每一關對應到考試大綱的條目，遊戲內的「證照地圖」會顯示涵蓋與完成的進度。

| 考試 | 有對應關卡的條目 | 還沒有關卡的條目 |
| --- | --- | --- |
| Cisco CCNA 200-301 v1.1 | 53 條中的 40 條 | 1.5、1.12、2.3、2.6、4.7、5.2 與第 6 領域（自動化） |
| CompTIA Network+ N10-009 | 25 條中的 24 條 | 1.3（雲端） |
| CompTIA Security+ SY0-701 | 只列出與網路相關的 11 條，全部有對應 | — |

沒有關卡的條目大多是觀念題，題庫裡有對應的題目（TCP / UDP、CDP / LLDP、QoS、AAA、REST API、JSON、Ansible 等）。
條目編號依公開的考試大綱，標題是中文摘要。CCNA v2.0 預計在 2027 年 2 月取代 v1.1，改版後需要重新對照。
題庫（84 題觀念題加上隨機產生的子網路計算題）是自行編寫的練習題，不是實際試題。

## CLI 設定指令

支援的範圍是 `show running-config` 會印出來的那些指令，都可以縮寫（`conf t`、`int gi0/1`、`sw mo tr`），前面加 `no` 是取消。
把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定（測試會對 62 台設備逐一驗證）。

| 模式 | 指令 |
| --- | --- |
| 全域 | `hostname`、`interface` / `interface range` / `interface vlan`、`vlan`、`ip route`、`ipv6 route`、`router ospf`、`ip dhcp pool`、`ip dhcp excluded-address`、`ip nat inside source …`、`ip access-list extended`、`spanning-tree vlan … priority`、`ip dhcp snooping`、`ip arp inspection vlan`、`line vty`、`ntp server`、`logging host`、`snmp-server …`、`username`、`ip domain name`、`ip ssh version`、`boot system`、`ip ftp username / password` |
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
- **遠端登入**：`line vty 0 4` 裡的 `exec-timeout`、`login block-for … attempts … within …`、`login on-failure log` / `login on-success log`、`banner motd`；`show users`、`show login`。
- **連接埠鏡像**：`monitor session <n> source interface <介面> [rx|tx|both]`、`monitor session <n> destination interface <介面>`、`show monitor`。
- **檔案與韌體**：`dir [flash: | bootflash:]`、`show flash:`、`show boot`、`show version`、`delete`、`verify /md5 <檔案> [MD5]`、`copy <來源> <目的>`（`running-config`、`startup-config`、`flash:`、`tftp://伺服器/檔名`、`ftp://帳號:密碼@伺服器/檔名`，沒寫完整會一行一行問）、`boot system flash:<檔名>`、`ip tftp blocksize`、`ip ftp username` / `password`。ROMMON 下可以用 `dir`、`boot <檔案>` 與 `reset`。
- **SSH**：`ip domain name`、`crypto key generate rsa [modulus <位元>]`、`crypto key zeroize rsa`、`ip ssh version 2`、`ip ssh time-out`、`ip ssh authentication-retries`、`line vty` 裡的 `login` / `login local` / `password`；`show ip ssh`、`show crypto key mypubkey rsa`。
- **SNMP**：`snmp-server community <字串> [RO|RW] [ACL]`、`snmp-server group <群組> v3 priv`、`snmp-server user <帳號> <群組> v3 auth sha <密碼> priv aes 128 <密碼>`、`snmp-server host <IP> [version 2c|3 priv] <community|帳號>`、`snmp-server enable traps`、`snmp-server location` / `contact`；`show snmp`、`show snmp user`、`show snmp host`。和真的 IOS 一樣，v3 的使用者不會出現在 running-config 裡。
- **排除故障**：`traceroute`、`show interfaces [介面]`、`show interfaces counters errors`、`clear counters`、`debug ip packet`、`debug ip icmp`、`undebug all`、`show debugging`、`show ip protocols`、`show ip ospf interface brief`。

### FortiGate（FortiOS）

`show` 印出來的整份設定可以貼到另一台 FortiGate。可以放好幾個值的欄位（`allowaccess`、`member`、`srcaddr`…）支援 `append` 與 `unselect`。支援的區段：

| 區段 | 內容 |
| --- | --- |
| `system interface` | 介面的 mode、ip、allowaccess（每個介面各自開放的管理協定） |
| `system dhcp server` | 位址範圍（`config ip-range`）、閘道、DNS、保留位址 |
| `firewall address` / `addrgrp` | 位址物件與群組；政策裡用名稱引用 |
| `firewall vip` | 連接埠轉發，或一對一的靜態 NAT |
| `firewall policy` | 介面、位址、服務、動作、NAT；`move` 調整順序、`delete` 刪除 |
| `vpn ipsec phase1-interface` / `phase2-interface` | 站對站 IPsec：提案可以列好幾組，第二階段預設開啟 PFS；`keylife` / `keylifeseconds`（金鑰壽命）、`dpd`（對端失聯偵測） |
| `system session-ttl` | TCP 連線可以閒置多久 |
| `system global` 的 `admintimeout` | 管理者登入之後閒置幾分鐘自動登出 |
| `vpn ssl settings` / `vpn ssl web portal`、`user local` / `user group` | 遠端存取的 SSL-VPN |
| `router static` | 靜態路由；用指令建立的通道要有一筆 `set device "<通道>"` 的路由才會導流量 |
| `system global`、`system admin`、`system ntp`、`log syslogd setting` | 主機名稱與管理設定 |
| `system snmp sysinfo` / `community`（含 `config hosts`）/ `user` | SNMP 代理程式、v2c 的 community 與允許查詢的來源、v3 使用者與 Trap 接收端；介面的 `allowaccess` 也要有 `snmp` |

查看狀態：`get system status`、`get system interface`、`get router info routing-table all`、`get vpn ipsec tunnel summary`、`diagnose vpn tunnel list`、`diagnose vpn ike gateway list`、`diagnose sys session list`、`diagnose sys session clear`、`diagnose sys ntp status`、`execute log display`、`execute date`、`execute time`、`execute ping`、`execute traceroute`、`execute reboot`、`get system info admin status`、`diagnose hardware deviceinfo nic <埠>`。

備份與升級：`execute backup config tftp <檔名> <伺服器>`、`execute backup config ftp <檔名> <伺服器> <帳號> <密碼>`、`execute restore config tftp …`（整份換掉，然後重新開機）、`execute restore image tftp <檔名> <伺服器>`（會檢查機型、MD5 與升級路徑）。

排除故障：`diagnose sniffer packet <介面|any> '<篩選條件>' [詳細程度] [數量]`（篩選條件用 tcpdump 的寫法：`host`、`net`、`port`、`icmp`、`tcp`、`arp`，用 `and` / `or` / `not` 組合）；`diagnose debug flow filter addr <IP>`、`diagnose debug flow trace start <數量>`、`diagnose debug enable` 會逐步印出封包在防火牆裡經過的每一關（收到封包、找路由、符合哪一條政策、NAT、進 VPN）。

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
| 開機 | Hub 2 秒、家用路由器與 AP 1 分鐘、FortiGate 70 – 90 秒、Catalyst 2960 2 分鐘、ISR 3 分鐘、Catalyst 9300 / Nexus 4 分鐘 | 按下電源或 `reload` 之後，這段時間和關機沒有兩樣 |
| 遠端登入閒置 | IOS 10 分鐘、FortiGate 5 分鐘 | `exec-timeout`、`admintimeout` 可以調整 |
| 檔案傳輸 | 依檔案大小與線路 | TFTP 每送一個 512 位元組的區塊就要等一次確認，速度取決於來回時間，700 MB 的映像檔要二、三十分鐘；FTP 走 TCP，同一條線只要幾十秒。傳輸期間時鐘跟著前進 |
| SNMP 輪詢 | 60 秒 | 網管伺服器每 60 秒問一次每台設備；使用率是兩次輪詢之間計數器的差值，所以至少要兩次輪詢才看得到 |

關卡裡的交換器已經預先開好 `spanning-tree portfast default`，不用每接一條線就等 30 秒；自由模式的設備是原廠預設值，要自己開。
時間只在遊戲分頁開著、沒有對話框的時候前進。復原 / 重做不會把時鐘倒轉。

## 設備的時鐘與紀錄

- 每台設備有自己的時鐘。Catalyst 2960 沒有硬體時鐘，沒對時的話時間從 1993 年 3 月 1 日算起；路由器與防火牆有硬體時鐘，但會快或慢幾分鐘。`show clock` 前面的 `*` 代表這個時間不可信。
- 對時對的是上游那一台的時間：把一台時間設錯的路由器當成 `ntp master`，下游全部跟著錯。
- 設備會記下發生的事：介面上線與斷線、err-disabled、OSPF 鄰居、VRRP 換手、VPN 通道、IP 衝突、duplex mismatch、有人改過設定、重新開機。紀錄放在記憶體裡（`show logging`），重開機就沒了。
- 設定了 Syslog 伺服器，訊息會用 UDP 514 送過去；伺服器連不到，那一筆就掉了。伺服器（有 Syslog 服務的主機）有一個「Syslog」分頁可以看收到的訊息。
- 紀錄上的時間是設備自己的時間，所以沒對時的設備，紀錄會和別人對不起來。

## 遠端登入

- 從電腦輸入 `ssh admin@10.0.99.2` 或 `telnet 10.0.99.2`，就會登入那台設備的命令列；之後打的每一行都送到對方，`exit` 登出。第一次 SSH 到一台設備要確認它的金鑰指紋，同一個 IP 換了一台設備，用戶端會拒絕連線。
- 這是一條一直開著的 TCP 連線：每打一行指令，封包都要真的走一趟。登入之後閒置太久，設備會自動登出（IOS 預設 10 分鐘、FortiGate 5 分鐘）；如果路上有防火牆，它的連線表可能更早就把這條連線忘了，下一行指令就送不過去。
- 密碼錯三次連線就斷了。設了 `login block-for`（FortiGate 預設就有），短時間內失敗太多次，設備會暫時拒絕所有登入。
- 用 SSH 登入時，紀錄與 debug 的訊息預設不會出現在畫面上，要先輸入 `terminal monitor`。CLI 分頁則相當於接著 console 線，訊息會直接跳出來。

## 維運：備份、韌體與監控

- **設定備份**：`copy running-config tftp:` 把設定存到 TFTP 伺服器（預設檔名是「主機名稱-confg」）。`copy tftp: running-config` 是把檔案的每一行貼進設定模式，等於**合併**：檔案裡沒寫到的設定（例如後來才加的 `shutdown`）不會被拿掉。要整份取代，複製到 `startup-config` 再 `reload`。
- **韌體**：每台 Cisco 設備有 flash（ISR 4000、Catalyst 9300、Nexus 叫 bootflash），裡面放著映像檔、設定與 core dump，空間不夠就複製不進去。下載完用 `verify /md5` 對照原廠公布的值；`boot system` 指定開機的映像檔，存檔再 `reload` 才會換版本。開機時會依序試 `boot system` 列出的檔案：檔案不存在、MD5 不對、平台不符（例如 ISR 4400 的映像檔放在 ISR 4300 上）就跳過，改用 flash 裡第一個能開機的映像檔；一個都沒有就停在 ROMMON，網路完全不通，要在 console 用 `boot` 手動指定。
- **FortiGate 升級**：`execute restore image` 會檢查機型與 MD5，並且要照升級路徑走（例如 7.0 不能直接跳到 7.4）；成功之後自動重新開機。
- **SSH 的前置條件**：要先有不是原廠預設的主機名稱、`ip domain name`，才能產生 RSA 金鑰（至少 768 位元才支援 SSH v2）；SSH 需要帳號，所以 `line vty` 要用 `login local`。原廠的交換器 vty 只有 `login` 而沒有密碼，Telnet 連上之後會立刻被關掉（Password required, but none set）。重新產生金鑰之後，用戶端會發現主機金鑰變了。
- **SNMP**：v2c 用 community 字串（明文），可以綁一個標準 ACL 限制誰能查；v3 有帳號、SHA 認證與 AES 加密，密碼不對就解不開回應。網管伺服器顯示每台設備的名稱、開機時間、版本，以及每個介面的速率、收送使用率與錯誤數的變化。設定了 `snmp-server host` 與 `enable traps` 的設備，在介面斷線 / 上線、重新開機、有人用錯 community 查詢時會主動送 Trap（UDP 162，沒有確認，送不到就掉了）。
- **背景流量**：關卡或玩家可以設定一直在跑的傳輸，它們依路徑上剩下的頻寬分配（小的先滿足，其餘平分，近似 TCP 的公平分享），算進介面計數器；`iperf3`、檔案傳輸會和它們搶同一條線。

## 排除故障的工具

| 工具 | 看得到什麼 |
| --- | --- |
| 介面計數器 | 每個埠收送了多少封包與位元組、廣播與多點傳送、CRC 錯誤、runt、碰撞、late collision。交換器每 2 秒送一個 STP BPDU、Cisco 設備每 60 秒送一次 CDP，所以沒人在用計數器也會增加。雙工不一致時，全雙工那端的 CRC 與半雙工那端的 late collision 會一直長 |
| 封包擷取 | 電腦的網路卡收送的訊框。接在交換器上只看得到廣播與給自己的；接在 Hub 上，或交換器用 SPAN 把別的埠鏡像過來，才看得到別人的流量。Telnet 的帳號密碼在這裡是明文，SSH 只看得到加密的封包 |
| SPAN | 把來源埠進出的訊框複製到目的埠。目的埠只送出複製的訊框，接在上面的設備不能再用它上網（和真的交換器一樣） |
| `debug ip packet` / `debug ip icmp` | 只看得到給路由器自己、它自己送出的、以及它丟掉的封包；經過它轉送的封包由 CEF 處理，不會出現（真的路由器也是這樣） |
| FortiGate 的 sniffer 與 debug flow | 封包從哪個介面進來、從哪個介面出去；在防火牆裡被哪一條政策放行或拒絕、有沒有 NAT |

## 頻寬與傳輸速率

`iperf3 -c <IP>` 或「傳輸速率」目標會沿著實際路徑找出最慢的一段：

- 全雙工連線約為標稱速率的 94%（扣掉訊框與 TCP 標頭）。
- 半雙工（接到 Hub）約 40%。
- Duplex mismatch 只剩標稱速率的 1%（上限 2 Mbps），並出現大量重送：ping 會通，傳檔卻慢得不能用。
- Wi-Fi 約為連線速率的一半；IPsec 通道再扣 10%。
- 有背景流量在跑的線路，只分得到剩下的頻寬（至少和其他連線平分），結果會註明是和背景流量共用。
- 網路線有線對斷掉時，兩端的 Gigabit 埠會自動降到 100 Mbps (speed downshift)，燈號照樣是亮的；寫死 `speed 1000` 的話則連不起來。

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
- **管理存取**：FortiGate 每個介面各自決定開放 ping / HTTPS / SSH / SNMP / HTTP / Telnet。
- **故障模擬**：任何設備都可以關機，路由器的介面與交換器的連接埠可以 `shutdown`；錯誤訊息會指出是哪一台關機或哪個介面被停用。

## 模擬的範圍與簡化

- MAC 位址表會學習、過期與泛洪，但實際的轉送路徑仍然由拓撲算出，所以不會出現「表裡的項目指到錯的埠」這種狀況。
- 只有 SSH / Telnet 是長時間保持的連線；ping、curl、iperf3 建立之後就結束了。
- 封包擷取記錄的是模擬裡真的跑過的訊框（測試、終端機指令、檔案傳輸、SNMP、背景的 BPDU 與 CDP）；持續傳輸的背景流量、OSPF Hello、VRRP 通告只算進計數器，不會出現在擷取畫面上。檔案傳輸只記下開頭幾個封包，不會把 70 萬個 TFTP 區塊一個一個列出來。
- FortiGate 的 sniffer 與 debug flow 是在背景執行，輸入任何指令就會停止（相當於 Ctrl-C）。IOS 的 `debug` 只做了 `ip packet` 與 `ip icmp`。
- DR / BDR 只依 Router ID 決定，不模擬「先上線的不讓位」。
- NTP 只有一台伺服器、沒有驗證；設備的時鐘不會慢慢漂移（沒對時的誤差是固定的）。
- 頻寬分配只發生在背景流量與一次性的量測（`iperf3`、檔案傳輸）之間，以每段線路剩下的頻寬近似 TCP 的公平分享，沒有模擬壅塞控制本身；沒有 QoS。Hub 的碰撞只反映在速率打折上。
- 遠端存取的 SSL-VPN 沒有連線建立的時間。
- STP 以每個 VLAN 各算一棵樹的方式近似 Rapid PVST+，只處理交換器直接相連的情況；非網管交換器形成迴圈會被判定為廣播風暴。邊緣埠用的是傳統的 30 秒計時（和 Cisco 預設的 PVST+ 一樣）。
- IPsec 只有 IKEv1 與預先共用金鑰。圖形介面建立的 FortiGate 通道會自動帶出通往對端的路由（相當於用精靈建立）。SSL-VPN 的加密流量在引擎內部仍然當成一層封裝來處理。
- Wi-Fi 的訊號只看距離與發射功率，沒有牆面衰減。
- 802.1X 只驗證帳號密碼（沒有憑證）。
- IPv6 目前只有位址、SLAAC、靜態路由與 ping；ACL、防火牆、NAT、OSPF 仍然只作用在 IPv4。
- PPPoE 的帳號密碼要在圖形介面設定（IOS 沒有做 Dialer 介面）。兩種 CLI 都只涵蓋這個遊戲有模擬的功能。
- IOS XE 只模擬 bundle 模式（直接用 `.bin` 開機），沒有 install 模式與 `packages.conf` 的展開；Nexus 也用 IOS 風格的 CLI 操作。FortiOS 的升級路徑簡化成「同一個主版本、次版本一次最多跳兩版」。
- 檔案傳輸只有 TFTP 與 FTP，沒有 SCP / SFTP、`archive` 自動備份與 `configure replace`。
- SNMP 只回答系統資訊與介面表（名稱、速率、狀態、位元組與錯誤計數器），沒有 MIB 瀏覽器、`snmpwalk` 與 SET；Trap 只有 linkUp、linkDown、coldStart、authenticationFailure。

## 還可以做的

完整的功能規劃（每個領域已完成、部分完成、尚未開始的項目，以及建議的實作順序）在 [PLAN.md](PLAN.md)。以下是最接近的幾項：

1. LLDP、DTP、Voice VLAN（需要新的 IP 電話設備）、QoS（規劃中的階段 4）。
2. IPv6 的 ACL、防火牆政策與 OSPFv3。
3. TACACS+、IKEv2、IOS 的 Dialer 介面。
4. Wi-Fi 的牆面衰減、802.1X 的憑證驗證。
5. NTP 與 Syslog 的維運關卡（引擎已經有了，還沒有獨立的關卡）。

## 程式結構

```
src/engine/   模擬引擎（不依賴瀏覽器，可直接用 Node 測試）
  ip.js、ip6.js   IPv4 / IPv6 位址工具
  model.js        設備型錄（真實機型）、線材與狀態物件
  ios.js          IOS 風格的設定指令解譯器、show running-config、startup-config
  fortios.js      FortiOS 風格的設定樹（config / edit / set / next / end）
  ops.js          每台設備的時鐘、NTP、事件紀錄與 Syslog、開機時間
  remote.js       SSH / Telnet 登入（長時間保持的連線、RSA 金鑰、驗證、閒置逾時、登入封鎖）
  files.js        flash 與檔案、映像檔清單與 MD5、開機時挑選映像檔、TFTP / FTP 傳輸
  snmp.js         SNMP 代理程式的驗證（community、ACL、v3）、網管伺服器的輪詢與使用率、Trap
  wire.js         線路上的訊框：介面計數器、封包擷取、SPAN、IOS debug、FortiGate sniffer 與 debug flow
  sim.js          供電與連線狀態、L2（VLAN / STP / LACP / Port Security / DHCP Snooping / DAI / 802.1X / Wi-Fi）、
                  L3（路由 / OSPF / VRRP）、DHCP 與 Relay、PPPoE、NAT、ACL、防火牆政策、VPN、DNS、
                  模擬時鐘（advance / settle / pendingOf）與傳輸速率（throughput）
  sim6.js         IPv6：SLAAC、鄰居探索、靜態路由
src/levels/   關卡定義：設備、初始設定、任務目標、提示、參考解法（trouble.js 是故障排除章，maint.js 是維運章）
src/data/     題庫與證照對照表
src/scene/    three.js 場景、設備模型、網路線、無線涵蓋範圍與封包動畫
src/ui/       設定面板、終端機、CLI、任務面板、測驗、自由模式與對話框
test/         對每個關卡套用參考解法，並用負面案例確認引擎真的會擋
```

新增關卡：在 `src/levels/` 的 `LEVELS` 加一筆，寫好 `setup()`、`objectives` 與 `solve()`，
在 `src/data/certs.js` 補上對應的考試條目，再跑 `npm test`。
