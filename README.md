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
- IP 電話有「電話」分頁：螢幕上看得到它卡在哪一步（沒電、開機、拿位址、下載設定、註冊），可以撥分機試打、或保持通話，看到 MOS、延遲、抖動、遺失，以及語音沿路經過的每一個佇列。伺服器開啟 CUCM 角色之後多一個「CUCM」分頁（自動註冊、分機）。
- 路由器與 L3 交換器有「QoS」分頁：class-map、policy-map（priority、bandwidth、fair-queue、set dscp、shape 加子政策）、套用在介面，以及一鍵建立「語音優先 + 整形」。
- 電腦與伺服器可以「新增持續傳輸」：一條一直在跑的背景流量（例如每天下午的大量存檔），會和其他連線搶同一條線路的頻寬。
- 網址加上 `?profile=名稱` 會使用另一份獨立的進度，適合多人共用一台電腦。
- 防火牆有「紀錄」分頁，家用路由器與路由器的「狀態」分頁有連線紀錄與 NAT 轉換表；政策與 ACL 規則會顯示命中次數。
- 頂端列的「測驗」是觀念題與子網路速算，「證照」是考試大綱與關卡的對照表。
- 關卡選單最上方的「自由模式」是沙盒：自己擺設備、接線、設定。可以把測試存成「應該要通 / 應該不通」的目標一鍵重跑，也可以把整個拓撲匯出成 JSON 檔再匯入。

## 關卡（14 章 57 關）

| 章節 | 關卡數 | 主題 |
| --- | --- | --- |
| 1 家用網路 | 4 | Hub、Switch、固定 IP、DHCP、PPPoE、NAT、DNS |
| 2 小型辦公室 | 4 | 固定 IP 線路、連接埠轉發、VLAN、Trunk、子介面 |
| 3 企業網路 | 3 | 防火牆政策與 DMZ、靜態路由與回程路由、一對一靜態 NAT |
| 4 資料中心 | 3 | ToR 與 SVI、Spine-Leaf 與 OSPF、銅纜 / 多模 / 單模光纖與距離 |
| 5 無線網路 | 3 | SSID、WPA2 / WPA3、PoE、頻道規劃、訪客 SSID 對應 VLAN |
| 6 網路安全 | 8 | DHCP Snooping、Port Security、ACL、管理加固、DAI、BPDU Guard、802.1X / RADIUS、用 DTP 偽裝成交換器的 VLAN hopping 與邊緣埠加固 |
| 7 VPN 與廣域備援 | 4 | 站對站 IPsec、遠端存取 VPN、雙線路浮動靜態路由；三個據點的 Hub-and-Spoke 與 IKEv2（版本要一致、PFS 不一致要到重新協商才斷、加密範圍與 NAT 例外要包含另一個分公司） |
| 8 高可用與進階路由 | 6 | STP、EtherChannel、VRRP / HSRP、DHCP Relay、OSPF Cost、VLSM |
| 9 IPv6 | 5 | Link-local、SLAAC、IPv6 靜態路由、雙協定；RA 的 M / O / A 旗標與 DHCPv6（stateless / stateful，DHCPv6 不給閘道）、OSPFv3（link-local 鄰居、純 IPv6 路由器的 Router ID）、IPv6 ACL 與隱含的 ND 允許規則 |
| 10 故障排除 | 4 | 網路已經設定好但被改壞了：IP 衝突與 DHCP 保留、Trunk / VLAN / shutdown、閘道 / 回程路由 / NAT / ACL / DNS、ping 會通但傳檔很慢（速率寫死、duplex mismatch、舊 Hub） |
| 11 維運與管理 | 4 | 從 TFTP 還原設定（合併與整份取代的差別）、韌體升級（flash 空間、MD5、`boot system`、TFTP 與 FTP 的速度）、讓原廠交換器能用 SSH（主機名稱、網域、RSA 金鑰、`login local`）、用 SNMPv3 找出滿載的線路（線對斷掉自動降到 100 Mbps） |
| 12 語音與 QoS | 2 | IP 電話：PoE、語音 VLAN、CDP 與 LLDP-MED、DHCP option 150、CUCM 註冊；線路塞車時用 QoS 保住通話：信任邊界、LLQ、配合營運商合約頻寬的整形 |
| 13 進階路由 | 4 | OSPF 的 DR / BDR 選舉（不搶位、`clear ip ospf process`）、Router ID 與 Loopback、passive-interface；參考頻寬與 cost、等價多路徑 (ECMP)；多區域 OSPF、ABR 與 `area range` 彙總；用 eBGP 同時接兩家 ISP：local-preference 決定出去走哪家、AS-path prepend 影響進來走哪家、prefix-list 避免變成轉運站 |
| 14 無線控制器與無線環境 | 3 | 輕量型 AP 與無線控制器（CAPWAP、DHCP option 43、Local 模式的流量經控制器放進 VLAN、RRM 自動分頻道）、牆面衰減與訊號熱力圖、漫遊（同一個 VLAN、sticky client 與 802.11k/v/r） |

## 證照對照

`src/data/certs.js` 把每一關對應到考試大綱的條目，遊戲內的「證照地圖」會顯示涵蓋與完成的進度。

| 考試 | 有對應關卡的條目 | 還沒有關卡的條目 |
| --- | --- | --- |
| Cisco CCNA 200-301 v1.1 | 53 條中的 43 條 | 1.5、1.12、5.2 與第 6 領域（自動化） |
| CompTIA Network+ N10-009 | 25 條中的 24 條 | 1.3（雲端） |
| CompTIA Security+ SY0-701 | 只列出與網路相關的 11 條，全部有對應 | — |

沒有關卡的條目大多是觀念題，題庫裡有對應的題目（TCP / UDP、AAA、REST API、JSON、Ansible 等）。
條目編號依公開的考試大綱，標題是中文摘要。CCNA v2.0 預計在 2027 年 2 月取代 v1.1，改版後需要重新對照。
題庫（119 題觀念題加上隨機產生的子網路計算題）是自行編寫的練習題，不是實際試題。

## CLI 設定指令

支援的範圍是 `show running-config` 會印出來的那些指令，都可以縮寫（`conf t`、`int gi0/1`、`sw mo tr`），前面加 `no` 是取消。
把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定（測試會對 96 台設備逐一驗證）。

| 模式 | 指令 |
| --- | --- |
| 全域 | `hostname`、`interface` / `interface range` / `interface vlan` / `interface loopback`、`vlan`、`ip route`、`ipv6 route`、`router ospf`、`router bgp`、`route-map`、`ip prefix-list`、`ip as-path access-list`、`ipv6 router ospf`、`ipv6 dhcp pool`、`ipv6 access-list`、`ip dhcp pool`、`ip dhcp excluded-address`、`ip nat inside source …`、`ip access-list extended`、`spanning-tree vlan … priority`、`ip dhcp snooping`、`ip arp inspection vlan`、`line vty`、`ntp server`、`logging host`、`snmp-server …`、`username`、`ip domain name`、`ip ssh version`、`boot system`、`ip ftp username / password` |
| 介面 | `ip address`、`shutdown`、`switchport mode / access vlan / trunk native vlan / trunk allowed vlan`、`no switchport`、`encapsulation dot1q`、`ip nat inside / outside`、`ip helper-address`、`ip ospf cost / priority / network / hello-interval / dead-interval / authentication / message-digest-key / mtu-ignore`、`ip ospf <pid> area <區域>`、`ip mtu`、`ip access-group`、`ipv6 address … [link-local]`、`ipv6 nd managed-config-flag / other-config-flag / prefix default no-autoconfig / ra suppress`、`ipv6 dhcp server / relay destination`、`ipv6 ospf 1 area / cost / priority / network / hello-interval / dead-interval`、`ipv6 traffic-filter`、`vrrp`、`channel-group`、`switchport port-security`、`spanning-tree bpduguard`、`ip dhcp snooping trust`、`ipv6 address` |
| 其他 | VLAN 的 `name`、OSPF 的 `network … area`、`router-id`、`passive-interface [default]`、`auto-cost reference-bandwidth`、`maximum-paths`、`area … range`、`area … authentication [message-digest]` 與 `default-information originate`、BGP 的 `bgp router-id`、`network … mask`、`neighbor … remote-as / description / route-map / prefix-list / filter-list / weight / default-originate / shutdown`、route-map 的 `match ip address prefix-list`、`match as-path`、`set local-preference / as-path prepend / metric / weight`、DHCP 位址池的 `network` / `default-router` / `dns-server`、ACL 的 `permit` / `deny`、`line vty` 的 `transport input` / `access-class` |

在設定模式下要看狀態請用 `do show …`。按 Tab 可以補齊指令，指令打到一半加上 `?` 會列出接下來可以輸入的字。

另外還支援：

- **VPN**：`crypto isakmp policy`（encryption / hash / group）、`crypto isakmp key … address …`、`crypto ipsec transform-set`、`crypto map … ipsec-isakmp`（`set peer`、`set transform-set`、`set pfs`、`set ikev2-profile`、`match address`），以及介面上的 `crypto map`。IKEv2：`crypto ikev2 proposal`（encryption aes-cbc-128 / aes-cbc-256、integrity、group）、`crypto ikev2 policy`、`crypto ikev2 keyring` → `peer` →（`address`、`pre-shared-key [local | remote]`）、`crypto ikev2 profile`（`match identity remote address`、`authentication local / remote pre-share`、`keyring local`）；`show crypto ikev2 sa`、`show crypto ikev2 profile`。
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
- **OSPF**：`show ip ospf`、`show ip ospf neighbor`（Pri、FULL/DR、2WAY/DROTHER、EXSTART）、`show ip ospf interface [brief | <介面>]`、`show ip ospf database`、`clear ip ospf process`（Router ID 改了要清除程序才會生效）。
- **路由表**：`show ip route` 和真的 IOS 一樣依主網段分組（`is subnetted` / `is variably subnetted`）、列出介面自己的位址 (L)、動態路由的存在時間與 Gateway of last resort；可以篩選 `show ip route ospf | bgp | static | connected`，也可以查單一網段 `show ip route <位址> [遮罩]`（Known via、distance、metric、from、等價的每一條路）。沒放進路由表的路（下一站不通的靜態路由、管理距離比較大的備援路由）會在最後用提示說明原因。
- **BGP**：`show ip bgp`、`show ip bgp summary`、`show ip bgp neighbors [<IP> [advertised-routes | received-routes | routes]]`、`show ip prefix-list`、`show route-map`、`show ip as-path-access-list`、`clear ip bgp *`。
- **IPv6**：`show ipv6 route [ospf | static | connected | local | <位址或前綴>]`（IOS 原樣的格式，含 L 與 FF00::/8）、`show ipv6 interface [brief | <介面>]`（加入的多點傳送群組、RA 的設定、主機要用 SLAAC 還是 DHCPv6）、`show ipv6 ospf [neighbor | interface brief]`、`show ipv6 dhcp pool | binding | interface`、`show ipv6 access-list`（命中次數與序號）、`clear ipv6 ospf process`、`clear ipv6 dhcp binding *`；`ipv6 route` 可以寫「出口介面 + link-local 下一站」與管理距離。主機上有 `ipconfig /renew6`，`tracert`、`curl`、`telnet` 都可以用 IPv6 位址（網址寫成 `http://[2001:db8::10]/`）。
- **ACL 的來源埠**：`permit tcp any eq 179 any`（回應的封包、或對方主動連過來時的來源埠）。
- **遠端登入**：`line vty 0 4` 裡的 `exec-timeout`、`login block-for … attempts … within …`、`login on-failure log` / `login on-success log`、`banner motd`；`show users`、`show login`。
- **連接埠鏡像**：`monitor session <n> source interface <介面> [rx|tx|both]`、`monitor session <n> destination interface <介面>`、`show monitor`。
- **檔案與韌體**：`dir [flash: | bootflash:]`、`show flash:`、`show boot`、`show version`、`delete`、`verify /md5 <檔案> [MD5]`、`copy <來源> <目的>`（`running-config`、`startup-config`、`flash:`、`tftp://伺服器/檔名`、`ftp://帳號:密碼@伺服器/檔名`，沒寫完整會一行一行問）、`boot system flash:<檔名>`、`ip tftp blocksize`、`ip ftp username` / `password`。ROMMON 下可以用 `dir`、`boot <檔案>` 與 `reset`。
- **SSH**：`ip domain name`、`crypto key generate rsa [modulus <位元>]`、`crypto key zeroize rsa`、`ip ssh version 2`、`ip ssh time-out`、`ip ssh authentication-retries`、`line vty` 裡的 `login` / `login local` / `password`；`show ip ssh`、`show crypto key mypubkey rsa`。
- **SNMP**：`snmp-server community <字串> [RO|RW] [ACL]`、`snmp-server group <群組> v3 priv`、`snmp-server user <帳號> <群組> v3 auth sha <密碼> priv aes 128 <密碼>`、`snmp-server host <IP> [version 2c|3 priv] <community|帳號>`、`snmp-server enable traps`、`snmp-server location` / `contact`；`show snmp`、`show snmp user`、`show snmp host`。和真的 IOS 一樣，v3 的使用者不會出現在 running-config 裡。
- **鄰居探索**：`cdp run` / `no cdp run`、`cdp timer`、`cdp holdtime`、`lldp run`、`lldp timer`、`lldp holdtime`；介面上的 `no cdp enable`、`no lldp transmit`、`no lldp receive`；`show cdp`、`show cdp neighbors [detail]`、`show cdp entry *`、`show cdp interface`、`show cdp traffic`、`show lldp`、`show lldp neighbors [detail]`、`show lldp interface`、`show lldp traffic`、`clear cdp table`、`clear lldp table`。
- **DTP**：`switchport mode dynamic auto | desirable`、`switchport nonegotiate`；`show interfaces [埠] switchport`、`show dtp`、`show interfaces trunk`（Mode 欄位是 on / auto / desirable）。
- **無線控制器**：Catalyst 9800 用圖形介面設定（WLAN、AP 模式、管理介面），CLI 可以用 `show ap summary`、`show wlan summary`、`show wireless client summary`、`show ap dot11 24ghz | 5ghz summary`；DHCP 位址池裡的 `option 43 hex f104.<控制器 IP>` 讓 AP 找到控制器。
- **IP 電話**：`switchport voice vlan <ID>`、`power inline auto | never`、`show power inline`；DHCP 位址池裡的 `option 150 ip <TFTP 伺服器>`。
- **QoS**：`class-map [match-any | match-all]`（`match dscp`、`match access-group name`、`match protocol rtp | sip`、`match cos`、`match any`）、`policy-map` → `class` →（`priority percent | <kbps>`、`bandwidth percent | remaining percent | <kbps>`、`fair-queue`、`queue-limit`、`set dscp`、`police cir`、`shape average`、`service-policy <子政策>`）、介面上的 `service-policy input | output`；Catalyst 2960 的 `mls qos`、`mls qos trust dscp | cos | device cisco-phone`、`mls qos map cos-dscp`、`auto qos voip cisco-phone | trust`；`show policy-map [interface <介面>]`、`show class-map`、`show mls qos [interface <埠> | maps cos-dscp]`。
- **排除故障**：`traceroute`、`show interfaces [介面]`、`show interfaces counters errors`、`clear counters`、`debug ip packet`、`debug ip icmp`、`undebug all`、`show debugging`、`show ip protocols`、`show ip ospf interface brief`。

### FortiGate（FortiOS）

`show` 印出來的整份設定可以貼到另一台 FortiGate。可以放好幾個值的欄位（`allowaccess`、`member`、`srcaddr`…）支援 `append` 與 `unselect`。支援的區段：

| 區段 | 內容 |
| --- | --- |
| `system interface` | 介面的 mode、ip、allowaccess（每個介面各自開放的管理協定） |
| `system dhcp server` | 位址範圍（`config ip-range`）、閘道、DNS、保留位址、`tftp-server`（給 IP 電話） |
| `firewall address` / `addrgrp` | 位址物件與群組；政策裡用名稱引用 |
| `firewall vip` | 連接埠轉發，或一對一的靜態 NAT |
| `firewall policy` | 介面、位址、服務、動作、NAT；`move` 調整順序、`delete` 刪除 |
| `vpn ipsec phase1-interface` / `phase2-interface` | 站對站 IPsec：`ike-version 1 | 2`、提案可以列好幾組，第二階段預設開啟 PFS；`keylife` / `keylifeseconds`（金鑰壽命）、`dpd`（對端失聯偵測）；IKEv2 可以用 `psksecret-remote` 讓兩個方向用不同的金鑰 |
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
| OSPF 鄰居建立 | 點對點約 4 秒；乙太網路 40 秒 | 乙太網路上第一次要等 DR 選舉 (Wait timer) 才會交換路由；網段上已經有 DR 時，新加入的路由器約 6 秒就 FULL。MTU 不一致會卡在 EXSTART |
| OSPF 鄰居失聯 | 40 秒 | 隔著交換器、自己的介面沒有斷的時候，要等 Dead timer 才發現；這段時間封包照舊送往已經不在的鄰居 |
| BGP 鄰居建立 | 約 10 秒 | TCP 179 連上之後交換 OPEN 與 KEEPALIVE（Active → OpenSent → Established）；remote-as 寫錯停在 Idle |
| BGP 鄰居失聯 | hold time 180 秒 | 介面斷線立刻知道；線路沒斷、只是 TCP 179 被 ACL 擋住時，要等 hold time 過了才斷，這段時間還顯示 Established |
| VRRP 接手 | 3 秒 | Backup 連續沒聽到通告才成為 Master；原本的 Master 回來時立刻搶回 |
| DHCP 租約 | 預設 1 天 | 過一半時間自動續約；伺服器連不到時，到期前繼續使用，到期後退回 169.254.x.x |
| ARP 快取 | 主機 2 分鐘、防火牆與家用路由器 5 分鐘、Cisco 4 小時 | 逐筆計時，用到就更新；介面斷線時清掉 |
| MAC 位址表 | 300 秒 | 交換器收到訊框才學到來源 MAC，太久沒看到就忘記；斷線或生成樹拓撲改變時清掉。不認得目的 MAC 時會把訊框送往整個 VLAN |
| NAT 轉換與連線表 | ICMP 60 秒、UDP 3 – 5 分鐘、TCP 關閉後 1 – 2 分鐘 | 依設備種類不同（IOS、FortiGate、家用路由器），可以調整 |
| IPsec 協商 | 2 秒 | 兩端設定好之後要先完成 IKE 才會 Up |
| IPsec 金鑰壽命 | 第一階段 1 天；第二階段 IOS 1 小時、FortiGate 12 小時 | 兩端不同時取較短的，到期自動重新協商，流量不中斷 |
| VPN 對端失聯 | FortiGate 60 秒；IOS 要等金鑰到期 | 這段時間通道還顯示 Up，封包照樣加密送出去然後被丟掉。IOS 設了 `crypto isakmp keepalive` 才會主動探測 |
| NTP 對時 | IOS 約 4 分鐘、FortiGate 立刻 | 每 64 秒輪詢一次；IOS 要連續幾次都正常才採信。伺服器失聯八次輪詢之後失去同步 |
| AP 加入無線控制器 | 約 25 秒 | 輕量型 AP 拿到 IP、找到控制器之後走 CAPWAP Discovery → Join → 下載設定，這段時間不放送 SSID |
| 開機 | Hub 2 秒、家用路由器與 AP 1 分鐘、Cisco 9120 AP 2.5 分鐘、FortiGate 70 – 90 秒、Catalyst 2960 2 分鐘、ISR 3 分鐘、Catalyst 9300 / Nexus 4 分鐘、9800 無線控制器 6 分鐘 | 按下電源或 `reload` 之後，這段時間和關機沒有兩樣 |
| 遠端登入閒置 | IOS 10 分鐘、FortiGate 5 分鐘 | `exec-timeout`、`admintimeout` 可以調整 |
| 檔案傳輸 | 依檔案大小與線路 | TFTP 每送一個 512 位元組的區塊就要等一次確認，速度取決於來回時間，700 MB 的映像檔要二、三十分鐘；FTP 走 TCP，同一條線只要幾十秒。傳輸期間時鐘跟著前進 |
| CDP 與 LLDP | CDP 每 60 秒、holdtime 180 秒；LLDP 每 30 秒、holdtime 120 秒 | 接線的那一刻兩端會立刻通告一次。對面把 CDP 關掉，這一端要等 holdtime 過了才忘記它；LLDP 關掉時會先送一個 TTL = 0 的通告，對方立刻刪除 |
| IP 電話 | 開機約 90 秒，註冊約 8 秒 | 交換器開始供電 (PoE) 才開機；交換器重新開機，電話也跟著斷電重開。已經註冊的電話每 120 秒確認一次 CUCM，連不到才顯示未註冊 |
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

## 鄰居探索與 DTP

- **CDP 與 LLDP**：鄰居表是從真的收到的通告學來的，每一筆都有剩下的 holdtime。Catalyst 與 ISR 出廠時 CDP 開、LLDP 關；Nexus 兩個都開；IP 電話兩個都講（Yealink 只講 LLDP-MED）；UniFi 基地台只講 LLDP。中間隔著 Hub 或非網管交換器時，CDP 會被泛洪過去（一個埠上看到好幾個鄰居），LLDP 的目的位址是 802.1D 保留給「最近的橋接器」的，交換器不會轉送。
- **靠 CDP 才知道的事**：雙工不一致 (`%CDP-4-DUPLEX_MISMATCH`)、Native VLAN 不一致 (`%CDP-4-NATIVE_VLAN_MISMATCH`) 都要收到對方的 CDP 才會出現，每分鐘抱怨一次。電話的語音 VLAN 與 PoE 協商也是。
- **DTP**：Catalyst 的埠出廠是 `dynamic auto`。對面是 `trunk` 或 `desirable` 就協商成 Trunk；兩端都是 auto 維持 Access；設了 `nonegotiate` 的一端不送 DTP，對面的 dynamic 埠永遠等不到要求。電腦、路由器、Nexus 都不講 DTP；攻擊工具（例如 Yersinia）可以假裝成交換器，把使用者的埠協商成 Trunk（VLAN hopping）。

## IP 電話與 QoS

- **電話的開機流程**：PoE 供電 → 開機 → 從交換器的 CDP（Cisco）或 LLDP-MED（其他廠牌）學到語音 VLAN → 在語音 VLAN 用 DHCP 拿位址（option 150 / 66 告訴它 TFTP 伺服器）→ 下載設定檔（Cisco 是 SEP + MAC.cnf.xml）→ 向 CUCM 註冊。哪一步卡住，電話的螢幕上就停在那裡。也可以在電話上手動設定語音 VLAN 與備用 TFTP 伺服器。
- **語音 VLAN**：電話裡有一台小交換器。電腦的流量不帶標籤，屬於交換器埠的 Access VLAN；電話的語音帶著語音 VLAN 的標籤 (CoS 5、DSCP EF)。電話沒電時，接在它後面的電腦也一起斷線。
- **PoE**：只有標示 PoE 的埠能供電，交換器有總預算（2960-CX-8PC-L 是 124 W）。依 PoE 等級先保留上限（Class 2 是 7 W、Class 0 / 3 是 15.4 W），Cisco 電話開機後用 CDP 協商出實際用量 (6.3 W)。
- **通話品質**：每一通電話依沿路每一個出口佇列算出延遲、抖動與遺失，再用 ITU-T G.107 的 E-model 換算成 MOS（G.711，含抖動緩衝與封包遺失補償）。4.0 以上是「好」，3.6 以下就聽得到斷斷續續。
- **壅塞與佇列**：持續的 TCP 流量會把瓶頸的佇列塞滿（預設 64 個封包），同一個佇列裡的語音要排隊，佇列滿了就被丟。`priority`（LLQ）讓語音不用排隊；`fair-queue` 讓每條流量各排各的；`bandwidth` 保證某一類的頻寬。佇列只在出口、而且只有真的塞車時才有作用。
- **營運商的合約頻寬**：網路線上可以標示營運商的 CIR（例如 Metro Ethernet 實體 1 Gbps、合約 20 Mbps）。超過的量在營運商那端被管制丟掉，不分語音還是資料，TCP 也只跑得到合約的八成多；在自己這端 `shape average` 到合約以內，佇列才會在自己手上，子政策的 LLQ 才有作用。
- **信任邊界**：交換器沒開 `mls qos` 時標記原樣通過；開了之後，沒設 `trust` 的埠會把 DSCP 與 CoS 歸零。`trust cos` 會依 CoS→DSCP 對照表換算，預設把 CoS 5 變成 40 而不是 EF；`trust device cisco-phone` 只有在 CDP 認出對面是 Cisco 電話時才信任。`auto qos voip cisco-phone` 會一次設好。

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
- **IKEv2**：IKE_SA_INIT 與 IKE_AUTH 四個訊息就建好 IKE SA 和第一個 CHILD_SA（IKEv1 要 Main Mode 加 Quick Mode）。兩端版本不一致時協商失敗；預先共用金鑰可以兩個方向不同（A 用來簽的要等於 B 用來驗證的）。第一個 CHILD_SA 不做 PFS 的 DH，所以 PFS 不一致時一開始照樣通，到第一次重新協商才斷 — 任務裡有「一小時後再測一次」。
- **Hub-and-Spoke**：分公司只和總公司建通道，分公司之間的流量在總公司解密、比對政策（VPN → VPN）、再加密送出去；兩條通道的加密範圍、總公司的政策、Cisco 分公司的 NAT 例外都要包含另一個分公司。
- **IPsec 兩階段**：第一階段 (IKE) 與第二階段 (IPsec SA、PFS) 分開協商，哪一個階段不一致會分別指出。IOS 的 ISAKMP 政策整台共用。
- **先 NAT 再加密**：路由器會先做 NAT 才比對 crypto map，站對站 VPN 沒有設 NAT 例外的話，通道是 Up 的但流量進不去。
- **running-config 與 startup-config**：IOS 設備改的是 running-config，沒有 `write memory` 就 `reload` 或斷電，設定會回到上一次存檔的樣子。
- **速率與雙工**：一端寫死、另一端自動協商時，自動的那一端會退回半雙工，形成 duplex mismatch；兩端速率寫死成不同的值則連線建立不起來。
- **OSPF 的 network 敘述**：持續生效，之後才設定 IP 的介面只要位址符合就自動加入。
- **DR / BDR**：priority 最高的當 DR（一樣就比 Router ID），priority 0 永遠不參加。DR 選出來之後不會被搶走：後來加入、條件更好的路由器只能當 DROTHER，要等 DR 不在了（BDR 先升上來）或 `clear ip ospf process` 才會重選。DROTHER 之間停在 2WAY 是正常的。
- **Router ID**：OSPF 程序啟動時決定（`router-id` > 最大的 Loopback > 最大的實體介面），之後改了位址或 router-id 都不會變，IOS 會提示要 `clear ip ospf process`。兩台 Router ID 一樣時鄰居建立不起來。
- **cost 與等價多路徑**：cost = 參考頻寬 ÷ 介面頻寬（預設參考頻寬 100 Mbps，所以 1G 和 10G 都是 1）；cost 一樣的路最多 4 條一起放進路由表，依來源與目的位址雜湊分散，同一條連線永遠走同一條路。
- **多區域**：ABR 把一個區域的網段用 Summary LSA 送進骨幹（`area range` 可以彙總成一筆），所有非骨幹區域都要接到 area 0；區域之間的路由是 O IA。`default-information originate` 送出的預設路由是 O*E2。
- **無線控制器**：輕量型 AP 自己沒有設定，拿到 IP 之後依序用手動指定、DHCP option 43、同一個網段的廣播找控制器，CAPWAP（UDP 5246）通了約 25 秒後加入，SSID 由控制器下發。Local 模式的用戶端流量包在 CAPWAP 裡回到控制器才放進 VLAN（交換器在接控制器的埠學到用戶端的 MAC），所以員工 VLAN 要在控制器的 Trunk 上；FlexConnect 在 AP 的埠就地放進 VLAN，控制器斷線時本地交換的 WLAN 照樣服務 (standalone)。加入同一台控制器的 AP 由 RRM 自動錯開頻道。
- **牆面衰減**：每穿過一道牆就扣掉固定的 dB（石膏板 3 / 4、玻璃 2 / 3、磚 8 / 10、混凝土 12 / 15、金屬 25 / 30，前面是 2.4 GHz、後面是 5 GHz），5 GHz 穿牆更差。有牆的關卡把涵蓋圓圈換成訊號熱力圖；用戶端的面板會說明隔著哪些牆、少了幾 dB。
- **漫遊**：用戶端在目前的訊號還有 -75 dBm 以上時不會自己換基地台 (sticky client)；SSID 開了 802.11k/v，基地台會在別台好 8 dB 以上時建議它換過去。兩台基地台把同一個 SSID 放進不同的 VLAN，換基地台就換網段、IP 跟著變。任務裡有「拿著筆電走過去」的測試。
- **RA 的旗標與 DHCPv6**：前綴的 A 旗標允許 SLAAC、M 旗標要主機向 DHCPv6 要位址、O 旗標只要 DNS；M 與 A 同時開著，Windows 會兩種位址各拿一個。DHCPv6 從來不給預設閘道，閘道一定來自 RA；Windows 收不到任何 RA 時還是會試 stateful DHCPv6，結果有位址卻出不了網段。路由器上 `show ipv6 dhcp binding` 查得到每台電腦的 DUID 與位址，電腦上 `ipconfig` 看得到 DUID 與 IAID。
- **OSPFv3**：直接在介面上啟用；鄰居用 link-local 位址認識彼此（兩端的全域前綴不一樣也能 FULL），路由的下一站也是 FE80:: 位址。Router ID 仍然是 32 位元：路由器上沒有任何 IPv4 位址時程序起不來（`%OSPFv3-4-NORTRID`），要手動設定。
- **IPv6 ACL**：和 IPv4 的 ACL 是兩套，IPv4 的 ACL 管不到 IPv6。結尾隱含 `permit icmp any any nd-na`、`nd-ns` 再 `deny ipv6 any any`；自己在最後寫了 `deny ipv6 any any`，鄰居探索就被擋掉，整個網段的 IPv6 都會斷。
- **BGP 的最佳路徑**：weight → local-preference → 自己發出的 → AS path 長短 → origin → MED → Router ID。同時接兩家 ISP 時，從 ISP-A 學到的路如果沒有過濾就送給 ISP-B，ISP-B 會把往 ISP-A 的流量丟給你（ISP 偏好客戶給的路），公司就成了兩家 ISP 之間的轉運站。
- **管理存取**：FortiGate 每個介面各自決定開放 ping / HTTPS / SSH / SNMP / HTTP / Telnet。
- **故障模擬**：任何設備都可以關機，路由器的介面與交換器的連接埠可以 `shutdown`；錯誤訊息會指出是哪一台關機或哪個介面被停用。

## 模擬的範圍與簡化

- MAC 位址表會學習、過期與泛洪，但實際的轉送路徑仍然由拓撲算出，所以不會出現「表裡的項目指到錯的埠」這種狀況。
- 只有 SSH / Telnet 是長時間保持的連線；ping、curl、iperf3 建立之後就結束了。
- 封包擷取記錄的是模擬裡真的跑過的訊框（測試、終端機指令、檔案傳輸、SNMP、背景的 BPDU、CDP、LLDP 與 DTP）；持續傳輸的背景流量、OSPF Hello、VRRP 通告只算進計數器，不會出現在擷取畫面上。檔案傳輸只記下開頭幾個封包，不會把 70 萬個 TFTP 區塊一個一個列出來。
- FortiGate 的 sniffer 與 debug flow 是在背景執行，輸入任何指令就會停止（相當於 Ctrl-C）。IOS 的 `debug` 只做了 `ip packet` 與 `ip icmp`。
- OSPF 只有一個程序 (`ospf 1`)；沒有 stub / NSSA 區域、虛擬連結 (virtual link)，外部路由只有 `default-information originate` 的 E2 預設路由；`show ip ospf database` 是依計算結果整理的摘要，不是逐筆 LSA 的洪泛。
- BGP 只有 eBGP（沒有 iBGP、route reflector、community），鄰居要直接相連；網際網路的核心簡化成一個 AS 64999，ISP 對客戶路由的偏好簡化成 local-preference 200。
- NTP 只有一台伺服器、沒有驗證；設備的時鐘不會慢慢漂移（沒對時的誤差是固定的）。
- 背景流量之間用 max-min 公平分配近似 TCP 的行為，沒有模擬壅塞控制本身。佇列的延遲與遺失用「TCP 會把佇列塞滿」的穩態估計（平均約七成滿、遺失率隨流量條數增加），不是逐封包的模擬；營運商的管制 (policing) 也是用估計的遺失率。Hub 的碰撞只反映在速率打折上。
- QoS 只模擬路由器的 MQC 與 Catalyst 2960 的 `mls qos` 信任邊界；交換器自己的出口佇列（`srr-queue`）、WRED、NBAR 的完整協定庫、FortiGate 的流量整形都沒有做。Wi-Fi 的 WMM 也沒有。
- IP 電話只有 G.711；CUCM 只做註冊與分機（沒有撥號規則、語音信箱、會議）。通話的訊令（SIP）只用來判斷註冊，媒體 (RTP) 才走實際的路徑算品質。
- DTP 不模擬 VTP 網域不同造成的協商失敗，也不模擬經過非網管交換器的 DTP。雙重標籤 (double tagging) 的 VLAN hopping 只在觀念題出現。
- 遠端存取的 SSL-VPN 沒有連線建立的時間。
- STP 以每個 VLAN 各算一棵樹的方式近似 Rapid PVST+，只處理交換器直接相連的情況；非網管交換器形成迴圈會被判定為廣播風暴。邊緣埠用的是傳統的 30 秒計時（和 Cisco 預設的 PVST+ 一樣）。
- IPsec 有 IKEv1 與 IKEv2，只用預先共用金鑰（沒有憑證、EAP、NAT-T）；IOS 的 IKEv2 smart defaults 簡化成 AES-CBC-128/256、SHA-1/256、DH 2/5/14/19 的組合；沒有 GRE、VTI、DMVPN。圖形介面建立的 FortiGate 通道會自動帶出通往對端的路由（相當於用精靈建立）。SSL-VPN 的加密流量在引擎內部仍然當成一層封裝來處理。
- Wi-Fi 的訊號依距離估算再扣掉沿路穿過的牆，沒有反射、多路徑與樓層；牆只能由關卡預先放好，自由模式還不能畫牆。802.11r 只是設定，沒有模擬漫遊所花的時間。無線控制器沒有 DNS 探索、DTLS、映像檔下載、AP group / tag 與跨控制器漫遊 (Mobility Group)，只能用圖形介面設定。
- 802.1X 只驗證帳號密碼（沒有憑證）。
- IPv6 有 SLAAC、DHCPv6（stateless / stateful 與 relay，沒有 Prefix Delegation）、靜態路由、OSPFv3（沒有 IPsec 驗證與 area range）、IOS 的 IPv6 ACL；FortiGate 的 IPv6 政策、NAT64、DNS 的 AAAA 記錄、經過 VPN 的 IPv6 還沒有。主機的 SLAAC 位址用 EUI-64（Windows 預設其實是隨機的介面識別碼加上暫時位址）。
- PPPoE 的帳號密碼要在圖形介面設定（IOS 沒有做 Dialer 介面）。兩種 CLI 都只涵蓋這個遊戲有模擬的功能。
- IOS XE 只模擬 bundle 模式（直接用 `.bin` 開機），沒有 install 模式與 `packages.conf` 的展開；Nexus 也用 IOS 風格的 CLI 操作。FortiOS 的升級路徑簡化成「同一個主版本、次版本一次最多跳兩版」。
- 檔案傳輸只有 TFTP 與 FTP，沒有 SCP / SFTP、`archive` 自動備份與 `configure replace`。
- SNMP 只回答系統資訊與介面表（名稱、速率、狀態、位元組與錯誤計數器），沒有 MIB 瀏覽器、`snmpwalk` 與 SET；Trap 只有 linkUp、linkDown、coldStart、authenticationFailure。

## 還可以做的

完整的功能規劃（每個領域已完成、部分完成、尚未開始的項目，以及建議的實作順序）在 [PLAN.md](PLAN.md)。以下是最接近的幾項：

1. 自動化與雲端（規劃中的階段 8）：REST API、JSON、Ansible / Terraform、VPC。
2. FortiGate 的 IPv6 政策、DHCPv6 Prefix Delegation、GRE / VTI / DMVPN、TACACS+、IOS 的 Dialer 介面。
3. iBGP、OSPF 的 stub / NSSA 區域、自由模式畫牆、訪客入口 (Captive Portal)。
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
  disc.js         CDP 與 LLDP 的通告、鄰居表與 holdtime
  ospf.js         OSPF：Router ID、Hello / Dead、DR / BDR 選舉、驗證與 MTU、SPF、多區域與 ABR、E2 預設路由、等價多路徑
  bgp.js          BGP：TCP 179 的鄰居狀態、hold time、路徑向量與迴圈偵測、最佳路徑、route-map / prefix-list / as-path ACL
  qos.js          QoS：標記與信任邊界、class-map / policy-map 的分類、出口佇列、整形與營運商的管制
  voice.js        IP 電話的開機與註冊、CUCM、通話品質（E-model / MOS）
  wire.js         線路上的訊框：介面計數器、封包擷取、SPAN、IOS debug、FortiGate sniffer 與 debug flow
  sim.js          供電與連線狀態、L2（VLAN / STP / LACP / Port Security / DHCP Snooping / DAI / 802.1X / Wi-Fi）、
                  L3（路由表、最長相符與 ECMP、VRRP）、DHCP 與 Relay、PPPoE、NAT、ACL、防火牆政策、VPN、DNS、
                  模擬時鐘（advance / settle / pendingOf）與傳輸速率（throughput）
  sim6.js         IPv6：SLAAC 與 DHCPv6（RA 的 M / O / A 旗標、relay、binding）、鄰居探索、靜態路由與 OSPFv3、IPv6 ACL、ICMPv6 / TCP / UDP
src/levels/   關卡定義：設備、初始設定、任務目標、提示、參考解法（trouble.js 是故障排除章，maint.js 是維運章，voip.js 是語音與 QoS 章，routing.js 是進階路由章，ipv6.js 是 IPv6 章的補充，vpn2.js 是多站台 VPN，wireless.js 是無線控制器章）
src/data/     題庫與證照對照表
src/scene/    three.js 場景、設備模型、網路線、無線涵蓋範圍與封包動畫
src/ui/       設定面板、終端機、CLI、任務面板、測驗、自由模式與對話框
test/         對每個關卡套用參考解法，並用負面案例確認引擎真的會擋
```

新增關卡：在 `src/levels/` 的 `LEVELS` 加一筆，寫好 `setup()`、`objectives` 與 `solve()`，
在 `src/data/certs.js` 補上對應的考試條目，再跑 `npm test`。
