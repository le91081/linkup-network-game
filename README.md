# LinkUp — 從一條網路線到資料中心

親手接線、親手設定，讓封包抵達目的地的網路工程解謎遊戲。
three.js 負責 3D 場景，設定頁面是 HTML，底層是一套自己寫的網路模擬引擎。

## 執行

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 驗證所有關卡、負面案例與題庫資料
npm run lint     # ESLint：未定義的變數、沒用到的 import、到不了的程式
npm run test:e2e # 在真的瀏覽器裡操作一輪（見下方）
npm run build    # 輸出到 dist/
```

### 發佈成 Claude 的 Artifact

`npm run build:artifact` 輸出到 `dist-artifact/`：`page.html` 是要發佈的頁面（沒有 `<html>`、`<head>`、`<body>`，Artifact 發佈時會自己包上），`assets/` 底下的 JS 與 CSS 是附帶的檔案。和一般的打包有三個不同：

- three.js 不打包進來，改用 import map 從 jsDelivr 載入（Artifact 只允許幾個 CDN 的外部程式），版本和 `node_modules` 裡的一樣。
- 「匯出」不能下載檔案，改成把 JSON 顯示出來讓人複製（`src/ui/save.js`）；「匯入」照常用檔案。
- 進度存在瀏覽者自己的瀏覽器裡，和本機 `localhost:5173` 的進度分開；網址的 `?profile=` 在 Artifact 裡沒有作用。

`npm run preview:artifact` 可以先在本機（4520 埠）看打包出來的樣子。視窗寬度不到 900 像素時，畫面會換成一張提示卡：顯示目前的寬度與需要的 900 像素（拉寬視窗時跟著變），並依裝置給建議（電腦拉寬視窗、直放的平板轉成橫向、手機改用大一點的螢幕）。這張提示卡與載入畫面的樣式直接寫在 `index.html` 裡，程式還沒載入之前就排好了，不會在載入時先閃出還沒排版的文字；程式沒有載入成功時，載入畫面會換成說明。

### 瀏覽器端測試（Playwright）

`npm run test:e2e` 用電腦上已經安裝的 Google Chrome（`channel: 'chrome'`）跑，不另外下載瀏覽器；
安裝套件時可以設 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`。測試會先建置一份（`vite build --mode e2e` → `dist-e2e/`，附 source map、不註冊 service worker），再開一個 4519 埠的伺服器提供它（`PW_DEV=1` 改用開發伺服器直接測原始碼；`PW_WORKERS=4` 指定平行數，預設是邏輯核心數的一半、最多 8 個；失敗的測試會自動重跑一次並錄下 trace，重跑才過的一樣算失敗），
和平常玩的 5173 是不同的來源，所以不會動到你的遊戲進度。

- `e2e/levels.spec.mjs`：每一關都打開、每台設備的每個分頁都畫一次，執行目標、套用參考解法、再執行到跳出過關視窗；
  畫面上不能出現 `undefined`、`NaN`、`[object Object]`，面板不能擠出水平捲軸，頁面不能有例外。1024×768 再檢查一次版面。
- `e2e/ui.spec.mjs`：用滑鼠點場景上的設備、切分頁、在 Cisco CLI 和主機終端機打指令、上方的每個按鈕、復原與重做。
- `e2e/modes.spec.mjs`：故障演練（含重新整理後接著做）、模擬考從作答到成績、自由模式拖曳接線並做成自訂關卡試玩。
- `e2e/ui-learn.spec.mjs`：新手導覽、參考解法與示範、錯題本。
- `e2e/ui-policy.spec.mjs`：在路由分頁設定路由重分配（搭配 CLI 寫的 prefix-list 與 route-map）、新增政策路由，並用 show 指令與 traceroute 確認。
- `e2e/ui-mtu.spec.mjs`：`ping -M do -s` 找出 MTU、交換器的 giants 與 2960 的 Jumbo MTU（存檔、重新開機）、PMTUD 黑洞與 TCP MSS 調整。
- `e2e/ui-stage11.spec.mjs`：VRF 的 CLI 與路由分頁、Docker 主機的終端機與分頁、HTTPS 憑證錯誤的排除（curl、換憑證、匯入根憑證、打開自動校時）。
- `e2e/ui-boot.spec.mjs`：載入畫面（程式載入之前不會露出「視窗太窄」的提示、載入失敗的說明）與視窗太窄的提示卡（寬度跟著視窗變、900 像素的門檻、依裝置的建議）。

失敗時的截圖與操作紀錄在 `e2e/.results/`，可以用 `npx playwright show-trace <trace.zip>` 一步一步回放。

### 持續整合與 GitHub Pages

推上 GitHub 之後：

- `.github/workflows/ci.yml`：每次 push 與 pull request 先跑引擎測試與兩種建置，再跑 Playwright（GitHub 的 ubuntu-latest 已經裝好 Google Chrome，設定不用改）；失敗時把 `e2e/.results/` 上傳成附件。
- `.github/workflows/pages.yml`：main 分支用相對路徑建置（`vite build --base=./`）並發佈到 GitHub Pages，放在 `https://<帳號>.github.io/<儲存庫>/` 底下也找得到檔案。第一次使用要在儲存庫的 Settings → Pages 把 Source 設成「GitHub Actions」。

### 存檔格式

進度存在瀏覽器的 localStorage（`linkup.v1`，加上 `?profile=` 就是另一份），每一份存檔、匯出的拓撲檔與關卡檔都記著格式的版本（`ver`）。
設定的資料結構改版時，在 `src/engine/migrate.js` 加一個遷移步驟：舊的存檔載入時一步一步升級；比較新的版本存的檔案不會被改動（那一關當作沒有存檔，匯入時提示要更新）。

### 離線使用

正式建置（`npm run build`、GitHub Pages）會註冊 service worker（`public/sw.js`）與 manifest：開過一次之後，沒有網路也能玩，也可以用瀏覽器的「安裝」放到桌面。頁面本身先問網路、連不上才用快取，所以有新版本時重新整理就會拿到；打包的 JS / CSS 檔名帶著雜湊值，快取裡有就直接用。開發伺服器與 Claude Artifact 不會註冊。

### 效能

`npm run bench` 量大型拓撲每次重新計算的時間（Nexus 核心 + 最多 47 台 Catalyst 2960、每台 7 台 PC，最多 377 台設備）；`npm run bench -- dhcp` 改成 PC 用 DHCP。

## 玩法

| 操作 | 效果 |
| --- | --- |
| 在設備上按住拖曳到另一台設備 | 接上網路線（需要時會讓你選連接埠與線材） |
| 點設備 | 開啟它的管理頁面 |
| 點網路線 | 查看線材、距離與協商出來的速率，或拔除 |
| 點追蹤紀錄裡標著「封包」的那一行 | 檢視那一段訊框的 MAC、IP、TTL 與埠號 |
| 點設備（或滑鼠移到設備、網路線上） | 它的每一條線中間標出兩端的埠名（自己這一端在前面），不用一條一條點開 |
| 任務清單裡標著「觀察題」的目標 | 點一下作答（選擇、複選或填空）。答案存在關卡的狀態裡，可以復原；選錯會說明為什麼不是這一個 |
| 學習筆記右上角的箭頭 | 把右邊的學習筆記收成一條窄邊，場景多出一大塊空間；點設備時設定頁面照樣展開 |
| Ctrl + Z / Ctrl + Y | 復原 / 重做上一個設定或接線變更 |
| 設備面板右上角的電源鈕 | 把設備關機或開機，模擬故障來驗證備援 |
| 設備面板右上角的鉛筆 | 標註：寫一段註解（顯示在場景裡設備的旁邊）、把設備加進群組（同一群組用虛線框起來）；可以復原，跟著存檔與匯出 |
| Cisco 設備面板右上角的磁片 | 有尚未儲存的設定時會亮起，點一下等於 `write memory` |
| 拖曳空白處 / 滾輪 / 右鍵拖曳 | 平移 / 縮放 / 旋轉 |
| 執行測試 | 播放封包動畫並檢查任務目標，空白鍵快轉 |
| 場景上方的時鐘 | 暫停 / 繼續模擬時間、切換 1× / 10× / 60×、直接前進 30 秒；出現「收斂中」時點一下會快轉到網路穩定為止 |
| Shift + 拖曳設備（自由模式） | 移動設備 |
| ? | 鍵盤快捷鍵清單：Ctrl + Enter 執行測試、[ ] 切換設備、1 – 9 切換分頁、/ 跳到終端機的輸入列、T 切換 2D 拓撲圖、H 提示、L 關卡清單、M 開關音效 |

- 電腦與伺服器有「終端機」分頁，都是 Linux 的 bash（提示字元 `user@pc-1:~$`）：`ip addr`（`-br` 簡短、`-6` 只看 IPv6）、`ip route`、`ip route get <位址>`、`ip neigh`（ARP 快取；`sudo ip neigh flush all` 清掉）、`ip -s link`（收送與錯誤的計數器）、`sudo ip link set eth0 mtu 9000`、`ip maddr`、`ethtool eth0`（速率、雙工；`-S` 看計數器）、`nmcli device show`（位址、閘道、DNS、DHCP 的選項一次看完）、`sudo dhclient -v eth0`（印出 DISCOVER / OFFER / REQUEST / ACK；`-r` 歸還、`-6` 是 DHCPv6）、`ping`（iputils 的格式，支援 IPv6、`-c`、`-M do -s <大小>` 設 DF 找出路徑上的 MTU）、`traceroute`、`nslookup` / `dig` / `host`、`resolvectl status | query | show-cache | flush-caches`、`curl`（HTTPS 會驗證憑證，錯誤訊息和真的 curl 一樣；`-k` 略過、`-v` 看憑證、`-I` 只看標頭、`-L` 跟著轉址）、`nc -zv <IP> <埠>`、`date`、`timedatectl`（`sudo timedatectl set-ntp true`）、`sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`（安裝根憑證）、`iperf3 -c <IP>`（量實際傳輸速率，會讓時間前進 10 秒），以及 `ssh 帳號@IP`、`telnet IP` 登入網路設備的命令列（見下方「遠端登入」）。指令可以用 `&&` 串起來。打 Windows 的指令（`ipconfig`、`tracert`、`netsh`…）會得到 `command not found` 與 Linux 上對應的指令；`ifconfig`、`arp`、`netstat`、`route` 這些舊的 net-tools 和新的 Ubuntu 一樣預設沒有裝，會提示改用 `ip`。Docker 主機還有 `docker`。
- 電腦與伺服器還有「封包擷取」分頁：像 Wireshark 一樣記下網路卡收送的訊框，可以用 `ip.addr == …`、`tcp.port == …`、`arp`、`telnet` 之類的條件篩選，點一下看每一層的標頭。
- 擷取到的訊框可以「匯出 .pcap」，用真的 Wireshark 打開：每個訊框都組成真正的位元組（Ethernet / 802.1Q、ARP、IPv4、ICMP、TCP、UDP、DNS 的查詢名稱、DHCP、STP、CDP、LLDP），檢查碼都算好；Telnet、FTP、HTTP 放的是明文（Follow TCP Stream 看得到帳號密碼），SSH、TLS、ESP 是亂數。
- **路由器與交換器上的封包擷取 (EPC)**：特權模式的 `monitor capture CAP interface Gi0/0/0 both`、`monitor capture CAP match ipv4 protocol icmp any host 10.1.0.10`（也可以 `match any`）、`monitor capture CAP start` / `stop`（印出擷取的統計）、`show monitor capture CAP buffer brief | detailed`、`show monitor capture CAP`、`monitor capture CAP export flash:cap.pcap`，再 `copy flash:cap.pcap tftp://<伺服器>/cap.pcap` 傳到 TFTP 伺服器，伺服器的「檔案」分頁可以下載成 .pcap；`no monitor capture CAP` 刪掉。
- **ICMP 無法到達**：中途的路由器丟掉封包時會回 ICMP Destination Unreachable：被 ACL 擋掉是 administratively prohibited、沒有路由是 network unreachable、目的網段找不到主機是 host unreachable。IOS 的 ping 顯示 `U.U.U`（中間的 `.` 是 ICMP 錯誤訊息的速率限制）、traceroute 顯示 `!A` / `!N` / `!H`，Linux 的 ping 顯示 `From <路由器> … Destination Net Unreachable`（或 `Destination Host Unreachable`、`Packet filtered`）、traceroute 顯示 `!N` / `!H` / `!X`；被交換器默默丟掉、FortiGate 擋掉、回程斷掉的只會逾時（`.....`、100% packet loss）。
- **SCP**：`copy running-config scp://backup@10.1.0.10/r1.cfg`（或 `copy scp://… flash:`）走 SSH（TCP 22）：帳號寫在網址裡、密碼另外問，不會出現在設定與紀錄裡，擷取到的也只是加密的內容。伺服器要開「SCP / SFTP 伺服器」的角色，帳號和 FTP 共用；帳號密碼錯是 Permission denied。
- **隱藏 SSID 與 MAC 過濾**：基地台的 SSID 可以不廣播名稱（掃描清單看不到，電腦的無線網路設定可以手動輸入名稱連線），也可以只允許或封鎖清單裡的 MAC 位址（不在清單裡的關聯不上，原因寫在網卡的狀態）。兩者都不是安全機制：名稱在 probe 裡照樣看得到、MAC 可以偽造。
- **訪客碼**：訪客入口可以要求輸入訪客碼：在基地台的 SSID 設定按「產生訪客碼」（6 位數字，8 小時有效），訪客在電腦的無線網路設定輸入它才能上網；碼過期之後連線會被導回入口網頁。
- **網路攝影機與 NVR**：攝影機（PoE Class 3）的「攝影機」分頁設定 NVR 的位址與畫質（1080p / 4MP / 4K，H.264 / H.265 的位元率），影像是固定位元率的背景流量，會和其他流量搶頻寬；NVR 的「錄影」分頁列出每一支攝影機實際收到多少、順不順（最多 8 路）。自由模式的設備清單多了「監控」。
- **STP 的優先權與 MST**：`spanning-tree vlan <清單> priority <n>` 與 `root primary | secondary` 是每個 VLAN 各自設定（root primary 會設成比現在的根橋再小 4096）；`show spanning-tree` 的優先權加上 sys-id-ext。`spanning-tree mode mst`、`spanning-tree mst configuration`（`name`、`revision`、`instance <id> vlan <清單>`）、`spanning-tree mst <id> priority | root`、`show spanning-tree mst [configuration]`；所有交換器的區域設定完全一樣，各 instance 才照自己的優先權選根橋。
- **BPDU Filter、Loop Guard 與 BPDU Guard 的預設**：介面上的 `spanning-tree bpdufilter enable | disable`（不送也不收 BPDU，等於那個埠沒有 STP）、全域的 `spanning-tree portfast bpdufilter default` 與 `portfast bpduguard default`（只套在 PortFast 的埠上）、`spanning-tree guard root | loop | none` 與全域的 `spanning-tree loopguard default`（原本是 Root / Alternate 的埠收不到 BPDU 時進入 loop-inconsistent、BPDU 回來自動解除，`%SPANTREE-2-LOOPGUARD_BLOCK / UNBLOCK`）；`show spanning-tree` 標出 `BKN*` 與 `*LOOP_Inc` / `*ROOT_Inc`，另有 `show spanning-tree inconsistentports` 與 `show spanning-tree summary`。連接埠的進階設定與交換器的「安全 / STP」分頁也有這幾個開關。
- **拓撲變更 (Topology Change)**：交換器之間的線或沒有 PortFast 的埠開始轉送、或某個埠被擋下 / 解除時，發現的交換器把 TC 傳遍那個 VLAN，每一台都把那個 VLAN 學到的 MAC 清掉重學（接下來會短暫地泛洪）；PortFast 的埠不發 TC，這也是接電腦的埠要開 PortFast 的原因之一。`show spanning-tree detail` 與 `show spanning-tree vlan <n> [detail]` 看得到拓撲變更的次數、多久以前、從哪個埠收到，以及每個埠的角色、路徑成本、Edge / Loop Guard / BPDU Filter 與 BPDU 的收送數。
- **ICMP Redirect**：路由器收到的封包又要從同一個介面送出去、下一站和來源在同一個網段（例如電腦的預設閘道是 R1，但往研發網段要經過同一個 LAN 上的 R2）：照樣轉送，同時送 ICMP Redirect 告訴電腦以後直接送給 R2。電腦的目的地快取記 10 分鐘（`ip route get <位址>` 標 `<redirected>`、`sudo ip route flush cache`），之後的封包不再經過 R1。介面上 `no ip redirects` 就不送；`debug ip icmp` 印出 `ICMP: redirect sent to …`。
- **漫遊的時間**：用戶端換基地台要掃描（有 802.11k 的鄰近清單 20 ms、沒有就逐一掃描 120 ms）、重新關聯、再建立金鑰（WPA2-Personal 的四向交握 25 ms、WPA3 的 SAE 60 ms、WPA2-Enterprise 重做整個 802.1X 420 ms；開了 802.11r 只要 5 ms）。筆電的「無線網路」分頁顯示最近一次漫遊花了多久、每一段是什麼，超過 150 ms 會提醒通話會斷音；任務可以要求漫遊的中斷在多少毫秒以內。
- **時間型 ACL**：`time-range <名稱>` → `periodic daily | weekdays | weekend | <星期幾…> <hh:mm> to <hh:mm>`，ACL 規則後面加 `time-range <名稱>`；時段外的規則當作不存在（`show access-lists` 標 (inactive)），`show time-range` 看現在是否生效。時間照設備自己的時鐘與時區（`clock timezone`），時段一到自動重算。只有 periodic，沒有 absolute。
- **established 與 Reflexive ACL**：`permit tcp any any established` 只比對有 ACK / RST 的 TCP（連線的回應，不含主動連線的 SYN）。具名的延伸 ACL 可以寫 `permit <協定> … reflect <名稱> [timeout <秒>]`：封包離開時記下一筆位址與連接埠反過來的暫時規則；另一個方向的 ACL 寫 `evaluate <名稱>` 比對，只有自己先送出去的連線（TCP、UDP、ICMP）的回應進得來。暫時規則閒置 300 秒消失（`ip reflexive-list timeout <秒>` 改預設值），`show access-lists` 的 `Reflexive IP access list` 列出每一筆與剩下的秒數。圖形介面的 ACL 編輯器會列出這些規則，但要從 CLI 設定。
- **NAT Virtual Interface (NVI)**：介面上 `ip nat enable`（取代 inside / outside），規則寫成 `ip nat source static <內部> <公用>` 與 `ip nat source list <ACL> interface <介面> overload`。進出兩個 NVI 介面的封包都照規則轉換，所以內部的人連公用位址（NAT hairpin）也通：目的換成內部位址、來源換成路由器的公用位址，伺服器的回應才會回到路由器。兩邊都要 `ip nat enable` 才會轉換；`show ip nat nvi translations` 看轉換表。
- **FortiGate 的 VIP 與 hairpin**：`config firewall vip` 的 `set extintf <介面> | any`：指定介面時只轉換從那個介面進來的封包，內部的人連公用位址不會轉換；any 才會（還要一條 internal → dmz 的政策放行）。伺服器和用戶端在同一個介面時，internal → internal 的政策要開 NAT，來源換成防火牆的位址，伺服器的回應才會回到防火牆。用戶端收到的回應如果不是來自剛才連的位址（伺服器直接回給用戶端），會被當成不認得的封包丟掉。
- **帶外管理埠與 Mgmt-vrf**：Catalyst 9300 多了管理埠 Gi0/0，出廠就在 Mgmt-vrf 裡（不是交換埠、不能換到別的 VRF）。它有自己的路由表：`ip route vrf Mgmt-vrf 0.0.0.0 0.0.0.0 <閘道>`、`ping vrf Mgmt-vrf <IP>`；交換器送出的回應照來源位址所在介面的 VRF 查路由。交換器自己的管理流量預設照全域的路由表走，伺服器在管理網路時要指定 `ip tftp source-interface GigabitEthernet0/0`（`ip ftp source-interface` 同理）、`logging host <IP> vrf Mgmt-vrf`、`ntp server vrf Mgmt-vrf <IP>`。
- **IOS XE 的 install 模式**：Catalyst 9300 出廠就是 INSTALL 模式，從 `bootflash:packages.conf` 開機（`dir bootflash:` 看得到一個個 .pkg）。`install add file bootflash:<bin>` 把映像檔解開成套件（狀態 I）、`install activate` 改寫 packages.conf 並重新開機（U：還沒確認、auto abort 計時器在跑）、`install commit` 確認（C），也可以一行 `install add file … activate commit`。解開的套件和 .bin 差不多大，空間不夠會失敗；`install remove inactive` 刪掉沒在用的套件、.bin 與舊的 packages.conf。`show install summary`、`show version` 最後的 INSTALL / BUNDLE。
- **多點傳送與 IGMP snooping**：主機可以送出多點傳送的串流（IPTV、數位看板：固定速率的 UDP，不會因為塞車而讓路），電腦在「多點傳送」分頁加入群組（IGMP Report，`ip maddr` 看得到）。非網管型的交換器、或關掉 snooping 的交換器把它當廣播送往整個 VLAN；Catalyst 的 IGMP snooping 出廠就開著，但 VLAN 裡要有 querier 定期詢問（`ip igmp snooping querier`，交換器在那個 VLAN 要有 IP），表項才不會過期。`show ip igmp snooping`、`show ip igmp snooping groups`、`show ip igmp snooping querier`；被串流佔掉的頻寬算進每一段線路，iperf 與背景流量只拿得到剩下的，流量熱圖也看得到。
- **多點傳送與 Wi-Fi**：串流送到基地台時，無線上要用最低的基本速率送給每一台（5 GHz 6 Mbps、2.4 GHz 1 Mbps），一道 8 Mbps 的串流就能佔掉整台基地台的空中時間，所有用戶端都變得很慢（iperf 的說明會寫出來，基地台的「無線電」分頁也有提醒）。上游用 IGMP snooping 擋掉沒人看的串流，或在基地台打開「多點傳送轉單點傳送」：只送給有加入的用戶端、用它們各自的速率。
- **PIM（跨網段的多點傳送）**：`ip multicast-routing [distributed]`、介面上的 `ip pim sparse-mode | dense-mode | sparse-dense-mode`、`ip pim rp-address <IP>`。接收端在別的網段時，它的閘道照「往來源的單點傳送路由」一站一站往回加入 (RPF)：每一台都要開 multicast-routing、經過的介面都要有 PIM（兩端才是 PIM 鄰居），sparse-mode 的每一台要設定同一個 RP；任何一站不對，接收端的「多點傳送」分頁會寫出卡在哪裡。開了 PIM 的介面也是那個網段的 IGMP querier（交換器的 snooping 因此有效）。`show ip mroute`、`show ip pim neighbor`、`show ip pim interface`、`show ip pim rp mapping`、`show ip igmp groups`。
- **Active Directory 與 LDAP**：伺服器可以當網域控制站（「Active Directory」分頁：使用者、群組、停用、LDAPS 憑證）。FortiGate 的 `config user ldap`（server、port、cnid、dn、type、username / password 是 bind 用的服務帳號、secure ldaps）與 `config user group` 的 `set member "<LDAP 伺服器>"` + `config match`（server-name、group-name 對應 AD 的群組）。SSL-VPN 登入時：連得到 389 / 636 → 服務帳號 bind → 在 dn 底下用 cnid 找使用者 → 沒有停用 → 密碼 → 群組，任何一步失敗，用戶端的 VPN 分頁會寫出原因。FortiGate 本機的帳號優先，不在群組成員裡的本機帳號不能登入。
- **郵件 (SMTP)**：伺服器可以當郵件伺服器（「郵件伺服器」分頁：網域、信箱、寄不出去的佇列與原因），員工的電腦有「郵件」分頁設定寄件伺服器、寄測試信。信的路徑：員工用 TCP 587 交給公司的伺服器 → 收件人在自己的網域就放進信箱，否則查收件人網域的 MX、用 TCP 25 交給對方；外面寄進來的信從網際網路上別家公司的郵件伺服器連到我們 MX 的公用位址。退信的原因照 SMTP 寫：550 User unknown、Relaying denied。任務可以檢查「這封信寄不寄得到」。
- **中繼 CA 與憑證鏈**：網站的憑證可以由中繼 CA 簽發（公司的 Corp Issuing CA，根是 Corp Root CA；公開 CA 的 DigiCert 中繼）。網站的「網站」分頁有「一起送出中繼憑證（完整的憑證鏈 fullchain）」：沒有送的話，瀏覽器會照 AIA 自己去下載中繼憑證所以正常，OpenSSL（終端機的 curl、伺服器上的程式）會失敗；任務可以要求用戶端不自己下載 (strict)。
- **設定檔裡的密碼**：`enable password` 與 `enable secret`（兩個都有時 secret 優先）、`username … password` 與 `username … secret`、line con 0 / vty 的 `password`。可逆的密碼在沒有 `service password-encryption` 時以明文出現在 running-config，有的話是 type 7（只是遮住）；關掉 service password-encryption 之後，已經是 type 7 的不會變回明文。`security passwords min-length <n>`：之後設定的明文密碼太短就拒絕（% Password too short）。
- **IOS 的 PPPoE（Dialer）**：實體介面 `pppoe enable group global`、`pppoe-client dial-pool-number <n>`；`interface Dialer<n>` 底下 `ip address negotiated`、`encapsulation ppp`、`dialer pool <n>`、`ppp chap hostname` / `ppp chap password`（或 `ppp pap sent-username … password …`）、`mtu 1492`、`ip nat outside`、`ip tcp adjust-mss 1452`；`ip nat inside source list … interface Dialer1 overload`、`ip route 0.0.0.0 0.0.0.0 Dialer1`（點對點，不用下一站）。`show ip interface brief` 的位址顯示在 Dialer（IPCP），實體介面是 unassigned。圖形介面設定的 PPPoE，running-config 也會寫成 Dialer1。
- **ESXi 的 NIC teaming**：vSwitch 有 vmnic0、vmnic1 兩張上行，預設依虛擬埠輪流分配（Route based on originating virtual port），每台 VM 與 vmk0 固定走一張；那張斷線就改走另一張，也可以把一張設成備用 (standby)。vSwitch 不在上行之間轉送（不用 STP、不用 LACP），從上行收到的廣播只交給固定走那張的 VM。「虛擬交換器」分頁的「上行」卡片看得到每張上行的連線與哪些 VM 走它；負載平衡也可以改成 IP hash：兩張上行綁成一條靜態的 EtherChannel，交換器那一端要 channel-group … mode on（標準 vSwitch 不會 LACP）。
- **負載平衡器（F5 BIG-IP）**：每個埠一個 self IP，預設閘道在「路由」分頁。Virtual Servers（VIP:埠 → pool、SNAT None / Auto Map、source_addr persistence）、Pools（Round Robin、Least Connections，成員 Enabled / Disabled / Forced Offline，每個成員的狀態與原因）、Monitors（內建 tcp、http、https、gateway_icmp，自訂 http monitor 的 Send / Receive String）。BIG-IP 替 VIP 回應 ARP，不屬於任何 virtual server 的流量預設拒絕；沒有可用的成員就重設連線。網站伺服器可以設定 HTTP 狀態碼（壞掉的應用程式回 500），curl 看得到；任務目標 `http` / `https` 會檢查狀態碼，`tries` 可以連續測好幾次（每次可能分到不同的伺服器）。 「tmsh」分頁：`show ltm virtual | pool [members]`、`list ltm virtual | pool | monitor`、`modify ltm virtual … source-address-translation { type automap }`、`modify ltm pool … monitor …`、`create ltm monitor http … recv "200 OK"`。
- **交換器堆疊（Catalyst 9300 StackWise）**：兩台成員是一台交換器（Gi1/0/x、Gi2/0/x，一份設定、一個 STP bridge）。Active / Standby 的角色、優先權（`switch N priority`）、成員故障時它的埠全部斷線、Standby 接手；跨成員的 EtherChannel。`show switch [detail | stack-ports]`、`show redundancy`；「堆疊」分頁可以模擬拔掉某台成員的電源、堆疊線鬆脫。
- **Wi-Fi mesh 與無線橋接**：基地台可以設成 Root（有線上行）或 Mesh（從 5 GHz 接到 root 或另一台 mesh 基地台，多跳），同一個 mesh 網路的金鑰要一樣。回程看兩個方向裡比較弱的訊號，頻道寬度改窄訊噪比比較好；回程沒連上的 mesh 基地台不廣播 SSID。mesh 基地台的 LAN 埠可以接有線設備（無線橋接）。可以用 PoE 電源供應器供電。場景裡的紫色虛線是回程，測速會顯示回程的瓶頸。
- **Nexus 的 vPC**：`feature vpc`、`vpc domain`（peer-keepalive、role priority）、`interface port-channel N` → `vpc N` / `vpc peer-link`。兩台 Nexus 對下面報出同一個 LACP 身分，跨兩台的 Port-channel 兩條都在用；vPC 編號、成員埠設定要一致；peer-link 斷線時 keepalive 通的話 secondary 暫停 vPC（避免 split brain）。`show vpc`、`show vpc peer-keepalive`、`show port-channel summary`。
- **光纖數據機 (ONT)**：出廠是路由模式（自己撥 PPPoE、做 NAT、LAN 發 192.168.1.x），後面再接路由器就是兩層 NAT；「運作模式」改成橋接，數據機沒有自己的 IP，後面的路由器穿過它撥 PPPoE。從外面連進來、沒有連接埠轉發的連線，會說明是在哪一層 NAT 被擋下。
- **UPS**：APC Smart-UPS 1500 供應 A 或 B 路（可以加外接電池組）。「UPS」分頁看負載、停電時撐多久，也可以模擬市電中斷：有 UPS 的那一路靠電池撐，沒有的那一路馬上斷電；負載超過額定就過載停止輸出，電池用完設備就關機。設備的「電源」分頁看得到兩路電的狀態。
- **vMotion**：虛擬化主機可以新增 VMkernel 介面卡（vmk1…）並啟用 vMotion。「虛擬機器」分頁選目的主機、按「遷移 (vMotion)」：先做相容性檢查（兩台的 vMotion 介面卡真的連一次 TCP 8000、目的主機要有同名的連接埠群組與空的虛擬埠），通過就把虛擬機器搬過去。和 vCenter 一樣只比對群組的名稱，不比對 VLAN。
- **Nexus 的 mgmt0**：Nexus 有帶外管理埠 mgmt0，在 vrf management 裡。NX-OS 的寫法：`vrf context management` → `ip route 0.0.0.0/0 <閘道>`、`interface mgmt0` → `vrf member management` → `ip address <IP>/<長度>`、`logging server <IP> 6 use-vrf management`、`ntp server <IP> use-vrf management`；running-config 也照 NX-OS 的格式。
- **Juniper EX2300（Junos）**：設定都在「CLI (Junos)」分頁。`configure` 進入設定模式，`set` / `delete` 改的是候選設定，`commit` 才生效（`commit check`、`show | compare`、`rollback`、沒 commit 就離開會先問）；`show vlans`、`show interfaces terse`、`show ethernet-switching table`、`show configuration`。Junos 不送 DTP，trunk 預設沒有 native VLAN（`native-vlan-id`，那個 VLAN 也要在 `vlan members` 裡）。
- **nmcli**：Linux 主機的終端機有 NetworkManager 的 `nmcli device status`、`nmcli connection show [eth0]`、`sudo nmcli connection modify eth0 ipv4.method manual ipv4.addresses <IP/長度> ipv4.gateway <閘道> ipv4.dns <DNS>`（只改設定檔；沒寫 /長度是 /32）、`sudo nmcli connection up eth0`（套用到網卡）。
- **MikroTik RouterOS**：hEX 的「Terminal (RouterOS)」分頁：/ip address、/ip dhcp-client、/ip route、/ip firewall nat、/ip dns、/interface、/system identity 加上 print / add / remove / set（名稱=值），可以先切換到選單再下指令；改了立刻生效，/export 看整份設定，/ping 從路由器自己 ping。
- **業者的 MPLS 骨幹**：PE 的 `vrf definition` → `rd`、`address-family ipv4` → `route-target import | export | both`；骨幹介面 `mpls ip`（LDP，兩端都要）；`router bgp` → `address-family vpnv4` → `neighbor <PE 的 Loopback> activate`（自動 send-community extended）、`address-family ipv4 vrf <名稱>` → `redistribute connected | static`。VPN 的封包在骨幹貼兩層標籤，少一段 LDP 就在那一站被丟掉；RT 決定路進哪個 VRF。`show mpls ldp neighbor`、`show mpls interfaces`、`show mpls forwarding-table`、`show bgp vpnv4 unicast all [summary]`、`show vrf detail`、`show ip route vrf`、`ping vrf`。
- **Aruba AOS-CX**：CX 6100 的「CLI (AOS-CX)」分頁：介面是 1/1/1 的寫法（可以用 1/1/1-1/1/4 一次設好幾個埠），`vlan access`、`vlan trunk native`、`vlan trunk allowed`；VLAN 不會自動建（沒建就是 VLAN N does not exist）；`show vlan`、`show interface brief`、`show running-config`、`show lldp neighbor-info`、`show mac-address-table`、`write memory`。Aruba 與 Juniper 只講 LLDP。
- **Metro Ethernet 專線**：電信業者的設備只能看「專線資訊」（EPL / EVPL、對應的 CE-VLAN、MTU、兩端 UNI 的燈號）。EVPL 依 802.1Q 標籤決定送到哪一條 EVC，不帶標籤的訊框丟掉。E-LAN（多點）預設丟掉客戶的 BPDU，可以在「專線資訊」向業者申請 L2PT。
- **配線架**：24 埠 Cat6 配線架是被動元件，前面第 n 孔和後面第 n 孔直接相通：交換器經過它直接連到另一面的設備（燈號、鄰居都是那台）；只接一面就沒有燈號；整條通道超過 100 公尺不通。「配線」分頁替每一孔貼標籤（牆上網路孔的編號）。
- **訊號量測**：上方的閃電按鈕打開量測模式，滑鼠移到地板上就顯示那個位置收到每台基地台的 5 GHz / 2.4 GHz 訊號強度（含牆的衰減），像現場勘測的 App。
- **實體配置**：上方的機櫃按鈕。「機櫃立面圖」是每個 42U 機櫃的前視圖（U1 在最下面）：點還沒上架的設備、再點空的那一格裝上去，點已經裝好的設備可以搬動或下架；「自動上架」把配線架與交換器放上面、伺服器在中間、UPS 放最下面。檢查重的 UPS 有沒有放在下方、每個機櫃的用電佔 16 A PDU 的幾 %、哪些線跨機櫃。桌上型的設備（hEX、FortiGate 60F、NAS）放在層板上。「樓層平面圖」從正上方看整層樓：牆依材質上色、設備、線路（依線材上色）、機櫃的位置，以及 5 GHz / 2.4 GHz 的訊號熱圖（穿牆的衰減照牆的材質算），滑鼠移上去看那一點收到每台基地台的訊號。
- **自由模式畫牆**：左側的「牆與訊號」選一種材質（石膏板、玻璃、磚牆、混凝土、金屬…），在地板上拖曳就畫出一道牆；有牆的時候基地台的訊號畫成熱力圖。
- **Let's Encrypt 與憑證撤銷**：Linux 伺服器的終端機有 `sudo certbot certificates`、`sudo certbot renew [--dry-run]`：HTTP-01 驗證真的從網際網路連到這台的 TCP 80，失敗時顯示 certbot 的錯誤訊息。被撤銷的憑證：瀏覽器查 CRL / OCSP 會擋下，curl 預設不查。
- **UDLD**：`udld enable` / `udld aggressive`（所有光纖埠）、介面 `udld port [aggressive | disable]`；單向的連線（一芯斷了）兩端都開 UDLD 才偵測得到，偵測到就 err-disable（原因 udld），`udld reset`、`show udld [neighbors]`。沒開 UDLD 的話，收不到 BPDU 的那一端會打開轉送造成迴圈（Loop Guard 擋得住）。
- **經過不跑 STP 的交換器**：小交換器、Hub 照樣轉送 BPDU，所以隔著它們的 STP 埠彼此是鄰居：同一台交換器的兩個埠接到同一台小交換器，會收到自己的 BPDU 而擋下一個（Backup）；BPDU Guard 經過小交換器也會觸發；介面上的 `spanning-tree bpdufilter enable` 會讓這種迴圈變成廣播風暴。
- **定時封存**：`archive` 底下的 `time-period <分鐘>` 每隔一段時間自動封存一份 running-config 到 path。
- Cisco 的路由器與交換器有「CLI」分頁：IOS 風格的命令列。`show running-config`、`show startup-config`、`show ip route`、`show vlan brief`、`show interfaces trunk`、`show arp` 等四十多個 `show` 指令用來查看狀態；輸入 `configure terminal` 之後可以直接用指令設定（見下方「CLI 設定指令」），改的和圖形介面是同一份設定。
- FortiGate 防火牆也有「CLI」分頁，用的是 FortiOS 的階層式語法（`config firewall policy` → `edit 1` → `set …` → `next` → `end`）。
- 伺服器的「網路設定」分頁可以開啟伺服器角色：TFTP、FTP、SNMP 網管 (NMS)。有 TFTP / FTP 的伺服器多一個「檔案」分頁（備份上來的設定、放在上面的韌體），網管伺服器多一個「網管」分頁（輪詢結果、每條線路的使用率、收到的 Trap）。
- 網站伺服器有「網站」分頁：目前的憑證（CN、SAN、簽發者、有效期間、還有幾天到期），以及產生 CSR 交給 CA 簽發；有內部網站的關卡，電腦的「網路設定」分頁多一張「憑證與時間」（信任的根憑證、自動設定時間）。Docker 主機有「Docker」分頁：容器清單、啟動 / 停止 / 刪除、建立新的容器（映像檔、綁定位址、發佈的連接埠）。路由器的「路由」分頁有 VRF 卡片，介面上可以選 VRF。
- 「路由」分頁的 OSPF 卡片可以切換程序（全域的 `router ospf 1` 與每個 VRF 的程序）、在 VRF 裡建立 OSPF 程序、設定每個區域的種類（一般、stub、totally stubby、NSSA、totally NSSA，以及 default-cost、NSSA 的預設路由與 no-redistribution）；VRF 的介面勾選 OSPF 時，沒有程序會自動建立一個。有 VRF 的路由器，每條靜態路由上面多一列：放進哪個路由表、從哪裡出去（自動、下一站在全域的路由表、或另一個 VRF 的介面：路由洩漏）。BGP 卡片可以加 iBGP 鄰居（同一個 AS），每個鄰居有來源介面 (update-source)、eBGP 的 ebgp-multihop、iBGP 的 next-hop-self 與 route-reflector-client、send-community；下一站查不到的路會列出來提醒。
- 「路由」分頁的 EIGRP 卡片：輸入 AS 啟用、每個介面一個「跑 EIGRP」開關（加一條只涵蓋它的 `network … 0.0.0.0`）與 passive、variance、Router ID，列出鄰居（失聯、還在 Hold time 裡的會標出來）與每個介面建不起鄰居的原因（AS、K 值、子網路、驗證）。重分配卡片多了「重分配進 EIGRP」（static / OSPF 自動帶上種子 metric）與 OSPF 收進 EIGRP 的路。
- 「路由」分頁的 RIP 卡片：一鍵啟用 RIPv2、版本（沒有設定 / 1 / 2）、auto-summary、每個主網段一個「跑 RIP」開關（RIP 的 network 只能寫主網段）、passive、送出預設路由，列出學到的路（幾跳、經過誰、還在等 invalid 的）、possibly down 的網段，以及收不到更新的原因（版本、驗證、子網路）。
- IP 電話有「電話」分頁：螢幕上看得到它卡在哪一步（沒電、開機、拿位址、下載設定、註冊），可以撥分機試打、或保持通話，看到 MOS、延遲、抖動、遺失，以及語音沿路經過的每一個佇列。伺服器開啟 CUCM 角色之後多一個「CUCM」分頁（自動註冊、分機）。
- 路由器與 L3 交換器有「QoS」分頁：class-map、policy-map（priority、bandwidth、fair-queue、set dscp、shape 加子政策）、套用在介面，以及一鍵建立「語音優先 + 整形」。
- 電腦與伺服器可以「新增持續傳輸」：一條一直在跑的背景流量（例如每天下午的大量存檔），會和其他連線搶同一條線路的頻寬。
- 網址加上 `?profile=名稱` 會使用另一份獨立的進度，適合多人共用一台電腦。
- 防火牆有「紀錄」分頁，家用路由器與路由器的「狀態」分頁有連線紀錄與 NAT 轉換表；政策與 ACL 規則會顯示命中次數。
- 頂端列的「測驗」是觀念題與子網路速算，「證照」是考試大綱與關卡的對照表。
- 關卡選單最上方的「自由模式」是沙盒：自己擺設備、接線、設定。可以把測試存成「應該要通 / 應該不通」的目標一鍵重跑，也可以把整個拓撲匯出成 JSON 檔再匯入。
- **故障演練**：挑一個關卡（或隨機），從「已經做好」的網路開始，系統隨機改壞 1 – 3 個地方——閘道或遮罩打錯、埠被放錯 VLAN 或被 shutdown、Trunk 少了 VLAN 或變成 access、VLAN 被刪、介面被關或 IP 打錯、靜態路由被刪或下一站打錯、NAT 被關、多了一條只放 ICMP 的 ACL、DHCP / Relay / OSPF 被停用、防火牆政策被停用、Wi-Fi 密碼被改、雲端的路由 / 安全群組 / 彈性 IP 被拿掉。每個故障都先在副本上試過「真的會讓目標失敗」才算數，一台設備最多壞一個地方。可以限時 10 或 20 分鐘，修好之後揭曉被改壞的地方；提示會依序指出是哪台設備。
- **模擬考**：CCNA 或 Network+，20 題 25 分鐘或 40 題 50 分鐘，依考試領域的比重抽題（Network+ 沒有直接標註的題目用 CCNA 的領域對照），部分是隨機產生的子網路計算題。可以標記稍後檢查、跳題；交卷後換算成 1000 / 900 分制，依領域顯示答對率與比較弱的領域，再逐題看解說。
- **評分**：過關時依實際作答時間（畫面在前景、沒有開對話框才算；標準時間是 3 分鐘加上每個目標 1.5 分鐘）、看了幾個提示、跑了幾次完整測試給 S / A / B / C 與分數，關卡選單上顯示最佳等級。設定變更的次數只列出來參考。
- **關卡編輯器**：自由模式的「關卡設計」可以寫關卡名稱、任務說明、提示，指定哪些設備鎖定（玩家看得到、不能設定），然後試玩、存成自訂關卡、或匯出成關卡檔分享；關卡選單的「自訂關卡」可以遊玩、匯出、刪除與匯入。

## 關卡（20 章 187 關）

| 章節 | 關卡數 | 主題 |
| --- | --- | --- |
| 1 家用網路 | 5 | Hub、Switch、固定 IP、DHCP、PPPoE、NAT、DNS；光纖數據機是路由模式、後面再接自己的路由器：兩層 NAT，連接埠轉發收不到外面的連線，數據機改成橋接、路由器自己撥 PPPoE |
| 2 小型辦公室 | 6 | 固定 IP 線路、連接埠轉發、VLAN、Trunk、子介面；固定 IP 專線換成光世代：R1 改用 PPPoE 撥接，實體介面 `pppoe-client dial-pool-number 1`、Dialer1 的 `ip address negotiated` 與 `ppp chap`，NAT 與預設路由改到 Dialer1，`mtu 1492` 與 `ip tcp adjust-mss 1452`；MikroTik 清成空白設定：RouterOS 的 /ip address、/ip dhcp-client、少了 masquerade 後面的電腦上不了網 |
| 3 企業網路 | 7 | 防火牆政策與 DMZ、靜態路由與回程路由、一對一靜態 NAT；NAT 位址池沒有 overload：早到的四個人把公用位址借光，晚到的人上不了網（`show ip nat statistics` 的 allocated 100% 與 misses，規則還有轉換在用時要先 `clear ip nat translation *` 才能改）；公司網站用靜態 NAT，外面連得到、辦公室卻連不上：傳統的 inside / outside NAT 不處理 hairpin，改用 split DNS（內部 DNS 回內部位址，改完要 `resolvectl flush-caches` 或等 TTL）；郵件伺服器搬回公司的 DMZ：寄給客戶的信卡在佇列（DMZ → wan1 沒有放行 SMTP），客戶寄來的信進不來（MX 的公用位址沒有 VIP 轉 TCP 25、也沒有政策），而且只對外開 25；公司自己架了 DNS 伺服器之後外面的網站全部打不開：伺服器沒有開轉送 (forwarder)、它自己的 DNS 設定是空的、防火牆只放行了 HTTP / HTTPS。三個環節一個一個修，而且對外的 DNS 只能放行那台伺服器（使用者不能自己問外面的 DNS） |
| 4 資料中心 | 10 | ToR 與 SVI、Spine-Leaf 與 OSPF、銅纜 / 多模 / 單模光纖與距離；Jumbo Frame 要整條路一致（交換器默默丟掉 giant、`ping -M do -s 8972`、2960 的 `system mtu jumbo` 要存檔重新開機）；光纖接好了燈還是不亮：第三方的收發器被關成 err-disabled (gbic-invalid)、兩端一端 10G 一端 1G、接頭髒了收到的光太弱（`show interfaces transceiver`、CRC）；A 路的電一跳機房就全黑：每台設備的兩個電源供應器要都裝上、都接電，而且分別接 A、B 兩路（`show environment power`、故障演練一路一路斷電）；新的 25G GPU 伺服器接不上只有 QSFP28 的 Nexus：`interface breakout module 1 port 1 map 25g-4x` 拆成 4 個 25G 的子埠，用分歧線接（10g-4x 只有 10G）；負載平衡器（F5 BIG-IP）：一臂式架構沒開 SNAT，伺服器的回應直接回給使用者（非對稱路由），SNAT Automap；tcp monitor 看不出應用程式回 500，自訂 http monitor 的 Receive String `200 OK`；Nexus 的 vPC：兩台 Leaf 上的 vPC 編號不一樣（一條 suspended）、peer-keepalive 打錯（peer-link 斷線時 dual-active），`show vpc`；UPS：停電時 B 路沒有 UPS，雙電源設備的負載全壓到 A 路的 UPS 而過載，不重要的設備改接 B 路，電池撐到發電機 |
| 5 無線網路 | 7 | SSID、WPA2 / WPA3、PoE、頻道規劃、訪客 SSID 對應 VLAN；三台 AP 都開 80 MHz 互相重疊、會議室用 DFS 頻道被雷達打斷（改用 40 MHz 與非 DFS 頻道）；Wi-Fi 6E 的新筆電一直連在 5 GHz：6 GHz 規定要 WPA3，只支援 WPA2 的印表機讓 SSID 停在 WPA2（改成 WPA2 / WPA3 混合）；訪客入口 (Captive Portal) 設好了，登入頁面卻從來不跳出：認證前允許的位址沒有 DNS，手機查不到 captive.apple.com；Wi-Fi mesh：倉庫的基地台從 5 GHz 接回辦公室（mesh 金鑰、回程 -78 dBm 連不上，頻道寬度改成 40 MHz 多 3 dB），LAN 埠接印表機（無線橋接），測速看到回程是瓶頸 |
| 6 網路安全 | 21 | TCP 與 UDP（只放行 TCP 53 的 ACL 擋掉了 DNS、TFTP、Syslog）、DHCP Snooping、Port Security、ACL、管理加固、DAI、BPDU Guard、802.1X / RADIUS、用 DTP 偽裝成交換器的 VLAN hopping 與邊緣埠加固；MAC flooding 把交換器的表塞滿、變成 Hub（Port Security 的 maximum 與違規動作要先設好再打開、亂造的項目要等老化或 clear）；雙重標籤從 Native VLAN 跳進伺服器 VLAN、繞過 ACL（Native VLAN 改成沒人用的、或 vlan dot1q tag native）；飯店的房間用 Private VLAN 隔離（isolated、community、promiscuous）；EAP-TLS：NPS 的伺服器憑證週末過期，星期一所有電腦同時登不進去（重新申請），時鐘差了兩年的筆電連新的憑證都「還沒生效」，沒有公司憑證的廠商筆電仍然擋在外面；分公司只有一台路由器也要當防火牆：IOS 的 Zone-Based Firewall（zone、class-map / policy-map type inspect、zone-pair，inspect 有狀態、pass 單向，DMZ 只對外開 https、不能主動連進辦公室）；上班時間有人在玩線上博弈：FortiGate 的 FortiGuard 網頁過濾封鎖類別，HTTPS 要搭配 certificate-inspection（no-inspection 看不到網址，deep-inspection 沒裝 Fortinet_CA_SSL 每個網站都跳憑證錯誤）；政策只看位址和埠，擋不住 BitTorrent、Tor 和 Log4Shell：應用程式控管封鎖 P2P / Proxy 類別、IPS 感測器保護對外的訂單系統，掛在流量經過的那一條政策上；釣魚信與「發票」：FortiGate 的 DNS 過濾在查名稱時就把釣魚網站換成封鎖頁面的位址（不用解密 HTTPS，但 DoH 或直接打 IP 就繞過），防毒只掃得到 HTTP 下載（HTTPS 要 deep-inspection）；午休才開放影音網站的時間型 ACL 晚了 8 小時：time-range 照路由器的時鐘判斷，NTP 對了，但沒有 clock timezone（網路設備出廠是 UTC）；分公司的 WAN 進來方向只有 `permit tcp any any established`：用 IP 開網頁正常，DNS 與 ping 的回應卻被擋（established 只認得 TCP 的 ACK），改用 Reflexive ACL：出去的方向 `permit … reflect MIRROR`、進來的方向 `evaluate MIRROR`，外面主動連進來的照樣擋掉；稽核拿到的設定檔備份裡 enable、帳號、vty 的密碼都是明文：改用 `enable secret`、`username … secret`，`service password-encryption` 遮住剩下的、`security passwords min-length 10`；對外網站被 SYN flood 塞滿：伺服器沒有壞，新的連線卻排不進去。前任留下的 DoS 政策掛在 dmz（要掛在攻擊進來的 wan1）、動作是預設的 pass（只記錄），改成 block，門檻設在正常的尖峰與攻擊的量之間（`diagnose ips anomaly list` 看現在每秒幾個封包） |
| 7 VPN 與廣域備援 | 19 | 站對站 IPsec、遠端存取 VPN、雙線路浮動靜態路由；業者骨幹故障時介面還是 up，用 IP SLA 與追蹤的靜態路由切換（探測目標要綁在主線、不要用使用者的 DNS）；三個據點的 Hub-and-Spoke 與 IKEv2（版本要一致、PFS 不一致要到重新協商才斷、加密範圍與 NAT 例外要包含另一個分公司）；IPsec 讓封包變大，ICMP「需要分段」被伺服器網段的 ACL 擋掉造成 PMTUD 黑洞（上傳正常、下載卡住），放行 `packet-too-big` 並在介面上 `ip tcp adjust-mss 1360`；GRE 通道上的 OSPF 學到 tunnel destination 的網段，造成 recursive routing、Tunnel 一直 flapping（`%TUN-5-RECURDOWN`，network 敘述不要包含 WAN）；GRE 不加密，用 `tunnel protection ipsec profile` 改成 GRE over IPsec，外部 ACL 改放 UDP 500 與 ESP、不再放行明文 GRE；crypto map 換成 VTI（`tunnel mode ipsec ipv4`），transform-set 不一致時 VTI 是 up/down，再讓 OSPF 在 VTI 上學到新網段；DMVPN（mGRE + NHRP + IPsec）：hub 少了 `ip nhrp map multicast dynamic` 讓 OSPF 只有單向的 Hello，spoke 搶到 DR，門市之間的流量在 NHRP 解析之後直接走；分公司在大樓的 PAT 後面：總公司的對端要寫 NAT 之後的位址，NAT-T 改走 UDP 4500，ACL 要放行；用憑證驗證的 IKEv2：分公司換了主機板電池、時鐘回到 2002 年，總公司的憑證「還沒生效」，偏偏 NTP 伺服器在 VPN 的另一邊（先 `clock set`，再改用不經過 VPN 的 NTP）；下午一塞車電話就斷斷續續：FortiGate 的 SD-WAN（效能 SLA 量每條線路的延遲、抖動、遺失，SLA 模式的規則讓語音走合格的線路，政策的目的介面改成 virtual-wan-link）；專線換成業者的 MPLS L3VPN：CE 與 PE 跑 eBGP、每個據點都是 AS 65010，對方的網段被當成 AS_PATH 迴圈丟掉（`show ip bgp summary` 寫出丟掉的筆數），CE 上 `neighbor <PE> allowas-in`，或業者在 PE 上 `as-override`；離職的同事還連得上 SSL-VPN（FortiGate 上另外建的本機帳號）：改用 AD 驗證，`config user ldap`（服務帳號 bind、cnid 要用 sAMAccountName、dn）與使用者群組的 `config match` 對應 AD 的 VPN-Users 群組，刪掉本機帳號；AD 停用一次就全部失效；Metro Ethernet 的 EVPL：業者只對應 CE-VLAN 100，路由器要用 dot1Q 100 的子介面；E-LAN：業者丟掉 BPDU，自己的備援光纖造成看不見的迴圈，申請 L2PT；站在業者那一端：兩家客戶用同一組位址，新換的 P 路由器少了 `mpls ip`（BGP 好好的、封包卻在骨幹被丟掉），PE2 的 VRF 匯入了別家客戶的 route-target；SSL-VPN 改成全通道之後連著 VPN 就不能上網：上網流量進了通道，HQ-FW 少了「遠端使用者 VPN → wan1」的政策，而且要 NAT（自己的區域網路還是直接走） |
| 8 高可用與進階路由 | 15 | STP、EtherChannel、VRRP / HSRP、DHCP Relay、OSPF Cost、VLSM；HSRP 追蹤上行介面（preempt 預設是關的，兩台都要開）；主線在業者那一端斷掉、介面燈號還亮著，OSPF 要等 40 秒的 Dead timer，用 BFD（或 fast hello）兩秒內切到備援；兩台閘道只有 HSRP 的 Active 在做事，改成 GLBP 讓兩台一起轉送（AVG 輪流發虛擬 MAC、AVF 壞掉時其他台接手）；唯一的防火牆壞掉全公司斷網：第二台 FortiGate 組成 HA（Active-Passive，heartbeat 線、群組與密碼一致；現役那台 priority 要高，不然新機器的空白設定會蓋過來；`monitor` 決定 wan1 斷線會不會換手、`session-pickup` 讓進行中的連線不斷；`get system ha status`）；兩台核心用 MST 分擔 VLAN 10 / 20，結果全擠在 Core-1：一台的 revision 打錯、一台少對應一個 instance，區域不一致；新拉的備援線一插上整棟樓斷網：前一任網管的「接電腦的埠」範本在每個埠都開了 `spanning-tree bpdufilter enable`，接到 SW-3F 的 Gi0/10 也是，那一端不送 BPDU，對面以為自己是 Designated、兩端都轉送，形成迴圈；拿掉 bpdufilter（接電腦的埠改用 PortFast 加 `portfast bpduguard default`），再用 `spanning-tree loopguard default` 讓收不到 BPDU 的 Alternate 埠繼續擋著 (loop-inconsistent)；交換器堆疊：線都接在 Switch 1，它一壞全部斷線，跨成員的 EtherChannel（LACP）、`switch 1 priority 15`、`show switch`；UDLD：光纖的一芯斷了，收不到 BPDU 的一端打開轉送造成風暴，兩端開 `udld aggressive`；會議室的小交換器接了兩個網路孔，介面的 BPDU Filter 讓 STP 看不到迴圈，改用 BPDU Guard |
| 9 IPv6 | 11 | Link-local、SLAAC、IPv6 靜態路由、雙協定；RA 的 M / O / A 旗標與 DHCPv6（stateless / stateful，DHCPv6 不給閘道）、OSPFv3（link-local 鄰居、純 IPv6 路由器的 Router ID）、IPv6 ACL 與隱含的 ND 允許規則；冒牌的 Router Advertisement 搶走預設閘道（主機多一個位址、IPv6 變黑洞），RA Guard 的 device-role host；內部網站加了 AAAA 之後雙協定的電腦 ping 名稱逾時、瀏覽器靠 Happy Eyeballs 改用 IPv4 才打得開（AAAA 寫錯、伺服器少了 IPv6 閘道，`nslookup -type=aaaa`、`ping -4 / -6`）；IPv6 過不了 VPN：`tunnel mode ipsec ipv4` 的 VTI 只載 IPv4，改成 GRE over IPsec，OSPFv3 在 Tunnel 上建鄰居；換了 ISP 之後 IPv6 上不了網：舊業者的前綴沒有回程路由，WAN 用 `ipv6 address autoconfig default` 與 `ipv6 dhcp client pd`，LAN 用一般前綴切出各自的 /64（業者換前綴時自動跟著換）；防火牆開了 IPv6，網站卻都打不開：FortiGate 的政策只寫了 IPv4 位址，IPv6 要加 srcaddr6 / dstaddr6，訪客網段用委派的前綴切子網路；新大樓只有 IPv6，只有 IPv4 的網站打不開：DNS 伺服器開 DNS64 合成 AAAA（64:ff9b::/96 + IPv4 位址），R1 用 `nat64 prefix stateful` 與 `nat64 v6v4 list … overload` 換成 IPv4 送出去，有真的 AAAA 的內部網站照樣直接連 |
| 10 故障排除 | 15 | 網路已經設定好但被改壞了：IP 衝突與 DHCP 保留、Trunk / VLAN / shutdown、閘道 / 回程路由 / NAT / ACL / DNS、ping 會通但傳檔很慢（速率寫死、duplex mismatch、舊 Hub）；OSPF 鄰居起不來（MD5 金鑰、被動介面、network 敘述）；流量繞經實驗室的交換器（根橋位置與 Root Guard）；VPN 通了資料卻過不去（NAT 例外、加密的 ACL 要涵蓋新網段）；DNS 改了卻還連到舊的（TTL 與用戶端快取、nslookup 不看快取、`resolvectl flush-caches`）；整層樓都慢了：一台電腦狂送廣播（從介面的 broadcasts 計數器找出是誰），用 Storm Control 擋下；實驗室拿回來的交換器一插上去，整棟樓的 VLAN 都不見了：VTP 的 revision 比較大就整份取代（埠變成 inactive），把它切成 transparent、在 server 上補回 VLAN、整個網域設 `vtp password`；會議室的電腦每分鐘斷一次：網路線接觸不良，`show logging` 一直是 %LINK-3-UPDOWN、`show interfaces` 的 CRC 一直增加，換線之後再替存取埠開 PortFast（不然每次接上都要等 STP 的 30 秒）；大廳的 IPTV 一開，倉庫的下載就只剩幾 Mbps：三個頻道的多點傳送泛洪過 100 Mbps 的舊線路，IGMP snooping 開著卻沒有 querier（沒有路由器的網段，表項過期），讓 SW-Lobby 擔任 `ip igmp snooping querier`；Cisco 與 Juniper：DTP 不通、Junos 改完沒 commit、Junos 的 trunk 沒有 native VLAN；配線架：跳線插錯孔，牆上的網路孔沒有燈號；存取交換器換成 Aruba CX：AOS-CX 的 `vlan access`、`vlan trunk native` / `allowed`，VLAN 要先建，Catalyst 要 `lldp run` 才看得到別家的設備 |
| 11 維運與管理 | 17 | 是誰動了設定（設定封存、差異比對、變更紀錄、只拿掉有問題的那一行、停用帳號）；從 TFTP 還原設定（合併與整份取代的差別）、韌體升級（flash 空間、MD5、`boot system`、TFTP 與 FTP 的速度）、讓原廠交換器能用 SSH（主機名稱、網域、RSA 金鑰、`login local`）、用 SNMPv3 找出滿載的線路（線對斷掉自動降到 100 Mbps）；HTTPS 憑證錯誤（過期、新網址不在 SAN 裡、沒有加入網域的筆電不信任公司的 CA、時鐘回到兩年前變成「尚未生效」）；專線被塞滿：SNMP 只看得出哪條線滿了，用 NetFlow（`ip flow ingress` 或 Flexible NetFlow）找出流量大戶，再用 QoS 的 `police` 替它限速；事件的先後兜不起來：沒對時的時間前面有 *、2960 重開機回到 1993 年、`clock timezone` 只改 `show clock`，紀錄要 `service timestamps log datetime msec localtime`；機櫃裡的線全部沒有標籤（這一關看不到接線）：用 `show cdp neighbors`、`lldp run` 之後的 `show lldp neighbors`、電腦的 MAC 加上 `show mac address-table` 找出每個埠接什麼，補上 description；外包工程師要能看設定但不能改：AAA 與 TACACS+（ISE 沒有登記設備就不回應、方法清單 `group tacacs+ local` 只在 ISE 連不到時改用本機帳號、`aaa authorization exec` 決定權限等級、指令授權與記錄）；SSH 被自己鎖在門外：vty 的 access-class 打錯，機房的交換器只能帶筆電去接 Console 線（9600 bps）修 ACL、存檔；ACL 打錯時網管中心連不進核心交換器：改用獨立的管理網路，Catalyst 9300 的 Gi0/0 在 Mgmt-vrf 裡，路由要寫成 `ip route vrf Mgmt-vrf`，設定備份要 `ip tftp source-interface GigabitEthernet0/0` 才會走管理網路，使用者的網段完全碰不到；Catalyst 9300 用 INSTALL 模式升級到 17.12.4：flash 被上次升級留下來的套件和 .bin 塞滿，先 `install remove inactive`、再下載新的 .bin，`install add file … activate commit`；activate 會重新開機，昨天新增還沒存檔的 VLAN 30 要先 write memory；訂單 API 換了中繼 CA 簽的憑證：瀏覽器正常，伺服器上的出貨程式一直 `unable to get local issuer certificate` — 網站沒有送出中繼憑證，要安裝完整的憑證鏈，不能用 curl -k 略過；Nexus 的 mgmt0：預設路由要寫在 `vrf context management` 底下、`logging server … use-vrf management`；Linux 伺服器用 nmcli 改固定 IP：modify 之後要 up、位址要寫 /24；Let's Encrypt：HTTP-01 驗證要 TCP 80，路由器只轉 443 所以自動續約一直失敗，`certbot renew --dry-run` |
| 12 語音與 QoS | 5 | IP 電話：PoE、語音 VLAN、CDP 與 LLDP-MED、DHCP option 150、CUCM 註冊；線路塞車時用 QoS 保住通話：信任邊界、LLQ、配合營運商合約頻寬的整形；新的 AP 插上去不亮：為了稽核整台 `no cdp run`，交換器只能依 Class 4 替每台 AP 保留 30 W，預算用完（改成只在使用者的埠 `no cdp enable`）；專線一斷電話就聽不清楚：QoS 只套在主線，切到 10 Mbps 的備援線路後沒有整形，每條線路要依自己的合約 shape、共用同一個 LLQ；倉庫 8 支 4K 攝影機錄影一卡一卡：影像是固定位元率，加起來 128 Mbps，上行卻被寫死成 100 Mbps（兩端改回自動協商，或改用 H.265） |
| 13 進階路由 | 13 | OSPF 的 DR / BDR 選舉（不搶位、`clear ip ospf process`）、Router ID 與 Loopback、passive-interface；參考頻寬與 cost、等價多路徑 (ECMP)；多區域 OSPF、ABR 與 `area range` 彙總；用 eBGP 同時接兩家 ISP：local-preference 決定出去走哪家、AS-path prepend 影響進來走哪家、prefix-list 避免變成轉運站；把靜態路由重分配進 OSPF（ASBR、O E2、用 prefix-list + route-map 只送工廠的網段）；政策路由讓 NAS 的備份改走寬頻（ACL + route-map set ip next-hop，套在進來的介面上）；分公司的路由表太大：stub 與 totally stubby（新路由器照範本設了 `area 10 stub`、ABR 沒設，Hello 的選項位元不同，鄰居起不來）；工廠在 stub 區域裡重分配供應商的網段白做：改成 NSSA（O N2、ABR 轉成 Type-5、`no-summary` 補回預設路由）；兩台邊界路由器的 iBGP（`update-source`、`next-hop-self`、中間的 Core 沒有 BGP 是黑洞，要全網狀或 route reflector，ISP 的線斷了繞網際網路回來）；機房的 VRF 各跑自己的 OSPF 程序，共用服務靠兩個方向的靜態路由洩漏（`… global`、出口介面在另一個 VRF），只洩漏需要的網段；分公司剛拉好光纖，EIGRP 的訊務卻還擠在 4G：光纖那一條 `network` 打錯、也少了總公司規定的 MD5 驗證（key chain），metric 看路徑上最慢的頻寬與延遲總和，4G 那條的 RD 比光纖的 FD 大、不是 feasible successor；舊工廠的 RIP：A 廠的路由器沒有設 version（送 v1），被 Core-RT 的 version 2 丟掉（`debug ip rip` 的 illegal version），改好之後兩個廠區都把 172.16 的子網路 auto-summary 成 172.16.0.0/16（不連續的網段、等價分流送錯廠區），要 `no auto-summary`；總部的 IPTV 送到分公司：分公司的路由器沒有 `ip multicast-routing`、專線兩端沒有 `ip pim`、RP 沒有設成同一台，`show ip pim neighbor` 是空的、`show ip mroute` 看不到 (S,G) |
| 14 無線控制器與無線環境 | 6 | 輕量型 AP 與無線控制器（CAPWAP、DHCP option 43、Local 模式的流量經控制器放進 VLAN、RRM 自動分頻道）、牆面衰減與訊號熱力圖、漫遊（同一個 VLAN、sticky client 與 802.11k/v/r）；控制器 N+1：AP 要填主要與次要控制器、備援控制器要有一樣的 WLAN、它的 Trunk 要允許員工的 VLAN（heartbeat 逾時約 30 秒才切換，主要的回來會自己切回去）；分公司的 AP 用 Local 模式，開分公司的 NAS 也繞回總公司、專線一斷 Wi-Fi 就停：改成 FlexConnect，AP 的埠改成 Trunk（Native VLAN 是 AP 的管理 VLAN）；Corp 用 WPA2-Enterprise，每次換基地台都要重做 802.1X（大約 445 ms），邊走邊講 Teams 就斷：兩台都開 802.11k/v（只掃鄰近清單）與 802.11r（金鑰直接帶過去），漫遊降到 30 ms 左右，而且不改回共用密碼 |
| 15 網路自動化 | 6 | RESTCONF：只走 HTTPS、HTTP Basic 驗證、YANG 路徑（`ietf-interfaces`、`Cisco-IOS-XE-native`）、JSON 與 XML、狀態碼、名稱裡的 `/` 要寫成 `%2F`、自簽憑證；Ansible：INI 格式的 inventory、YAML、`network_cli`、資源模組、`--check`、PLAY RECAP 與冪等；Catalyst Center：Token 驗證的北向 API、用 SNMP / SSH 輪詢的設備清單、AI 驅動的問題清單（DHCP 失敗率偏離基準、雙工不一致、設備連不到）；HTTPS 管理要關掉、改用 NETCONF：`netconf-yang`、SSH 要先有 RSA 金鑰，用 <edit-config> 建立 Loopback；三台新交換器用 Catalyst Center 的範本一次設好：變數、草稿要提交成新版本才會部署、部署結果一台一台看（錯字那一行失敗、控制器被 access-class 擋住）；昨晚有人改了 Core、今天倉儲全斷：備份伺服器上用 git log / git show 找出少打 add 的 trunk，修好之後 ./backup.sh、git add、git commit |
| 16 雲端網路 | 5 | AWS 的 VPC：公有 / 私有子網路與路由表、網際網路閘道與彈性 IP（一對一 NAT）、安全群組（有狀態）、NAT 閘道、網路 ACL（無狀態、臨時連接埠）、站對站 VPN 與路由傳播（混合雲），「下載設定檔」貼到公司的路由器；應用程式負載平衡器 (ALB) 回 503：目標的安全群組沒有允許 ALB 的健康檢查（來源用 ALB 的安全群組）；兩條 VPC peering 接好了，開發環境還是到不了正式環境（peering 不能轉送）：改用 Transit Gateway，兩邊的路由表都指向它、安全群組允許新的網段；有人在主控台手動改了安全群組 (drift)：Terraform 的 plan 列出差異，要留的規則補進 main.tf 再 apply，別讓 apply 把合作夥伴的規則一起拿掉 |
| 17 虛擬化 | 6 | VMware ESXi：虛擬交換器、連接埠群組決定 VLAN（VLAN ID 0 不加標籤）、接主機的實體交換器埠要設成 Trunk 並只放行需要的 VLAN、vmk0 管理介面；VRF-Lite：兩家公司用同一個網段（`vrf definition`、`vrf forwarding` 會清掉 IP、`show ip route vrf`、`ping vrf`）；Docker：橋接網路與 veth、`-p 主機埠:容器埠`、只綁 127.0.0.1、資料庫不要發佈（Docker 會繞過 ufw）、改連接埠要重建容器；NIC teaming：ESXi 的第二張上行接到另一台交換器，那台少了一個 VLAN，同一個 VLAN 的 VM 一台通一台不通（依虛擬埠分配上行），兩邊接 ESXi 的埠要一模一樣，斷線演練時管理介面也要連得到；vMotion：主機要維護，把虛擬機器搬走，vMotion 的 VLAN 沒有放行到新主機的 Trunk，搬過去之後新主機同名群組的 VLAN 又打錯；IP hash：vSwitch 改成 IP hash、交換器卻用 LACP，兩個埠都 suspended，改成靜態的 mode on |
| 18 封包實驗室 | 5 | 網路已經是通的，任務是「看懂它」：用封包追蹤、ARP 快取、MAC 位址表觀察之後回答觀察題。封裝（目的 MAC 是閘道不是伺服器、每過一台路由器 MAC 換一次、IP 不變、TTL 減 1）；交換器的 MAC 學習、泛洪與過期，線看不到時用 `ip neigh` 加 MAC 位址表找出設備接在哪個埠；廣播網域與碰撞網域（Hub、VLAN、路由器各自把什麼切開，複選題的答案是引擎算出來的）；TCP 三向交握與埠號，「馬上被拒絕」(RST) 和「等到逾時」(半路被丟掉) 的差別，UDP 沒有交握；NAT 的轉換表、外面看到的位址、為什麼外面連不進來 |
| 19 進階實作 | 6 | CCNP 等級，除了會通還要符合設計上的要求（用 check 目標驗證）。iBGP 的 route reflector（六台路由器不做全網狀、client 與非 client、next-hop-self）；BGP 的流量工程（local-preference、MED、community 與 no-export，業者的路由器不能動）；MPLS L3VPN 的共用服務（extranet 的 route-target 設計、同一台 PE 上的 VRF 互相匯入）；園區核心的對齊（STP 根橋、HSRP Active、EtherChannel 與 track 要在同一台）；EIGRP 的彙總只設在一條線上（最長前綴把流量全拉到慢的那條、彙總的 Null0、variance 的不等價負載分擔、重分配的種子 metric）；OSPF 與 EIGRP 在兩個交界做雙向重分配（EIGRP 外部的 170 輸給倒回來的 OSPF E2：封包繞圈；`distance ospf external` 或路由標籤加 `distribute-list … in`；用種子 metric 決定主線與備援） |
| 20 專家情境 | 2 | CCIE 風格的多張工單：一張大拓撲、好幾個互相獨立（有的還互相遮住）的故障，加上不能違反的設計限制。企業骨幹（OSPF 多區域與 totally stubby、預設路由的主備、NAT、DMVPN + IPsec、ACL 的順序，不准加靜態路由）；業者骨幹（核心少了一段 LDP：路由都在封包卻不通、VPNv4 的 route reflector 只有一台是 client、PE-CE 的靜態路由沒有重分配、route-target 打錯，PE 之間不准直接建鄰居、兩家客戶位址重疊又要互相看不到） |

## 學習輔助

- **知識庫**：按 K（或任務面板上的「知識庫」）打開寬的閱讀視窗：左邊是這一關會用到的觀念與 11 個分類的文章清單，右邊是內文，旁邊列出相關的觀念與「在這幾關會用到」，有搜尋、上一則與同分類的上下篇。想邊看邊做可以按「釘在左側」變回側邊欄（「放大閱讀」再回到視窗），釘不釘會記住。154 則觀念、技術與演算法的說明，分成 11 類（網路基礎、IP 服務、交換與 VLAN、路由、網路安全、VPN 與廣域網路、無線、IPv6、實體層與機房、高可用與維運、自動化雲端與虛擬化）。每一則有一句話的摘要、說明、運作流程或演算法的步驟（STP 選根橋、OSPF 的 SPF、EIGRP 的 DUAL、BGP 挑路、traceroute、最長前綴比對…）、圖（封包欄位、訊息往來、對照表、子網路的 32 個位元）、常見的錯誤、各家設備的指令、相關的觀念與「在這些關卡練習」。最上面是這一關會用到的觀念，也可以搜尋（中文、英文縮寫、關鍵字都可以）。其中 66 則另外有「深入了解」：原理的細節、設計上的取捨、設定範例、驗證用的 show 指令與常見的考點（標題旁有「深入」的標記），閱讀視窗左邊列出這一篇的小節目錄，點一下跳過去；CCNP / CCIE 的主題（BGP community、彙總、CEF、CoPP、uRPF、IPv6 First Hop Security、MACsec、SD-Access、EEM、資料格式、Python、實作考試的策略）各有一篇。
- **名詞連結**：關卡說明、學習筆記與提示裡提到的觀念有點狀底線，滑鼠移上去看一句話的摘要，點一下在知識庫打開完整的說明（提示視窗會自動關掉）。右側的學習筆記下面另外列出這一關用到的觀念。
- **新手導覽**：第一次進第 1-1 關會一步一步帶著做（接線 → 點設備 → 設定 IP → 執行測試），每一步看遊戲真正的狀態自動前進；「說明」裡可以重看。
- **關卡選單**：左邊是 20 章的導覽與每一章的進度（點一下跳到那一章，捲動時標出目前的位置），上面可以搜尋（關卡名稱、主題、標籤，符合的標籤排到卡片最前面）、只看未完成或已完成；左上角的「接著做」直接進下一個還沒完成的關卡。每張卡片標出依目標數估計的時間。
- **學習路線**：關卡選單左邊切到「學習路線」。九條依目的排好順序的路：新手入門、CCNA 重點（照考試大綱的六個領域）、故障排除實戰、網路安全、廣域網路與 VPN、資料中心與雲端、無線網路、維運與自動化、CCNP / CCIE 進階（OSPF 多區域 → EIGRP 與重分配 → BGP → 通道與 DMVPN → MPLS L3VPN → 園區高可用 → 多張工單的總驗收）。每條分成幾個階段，標出進度與「接著做」的那一關；同一關可以出現在好幾條路線裡，進度共用。
- **觀察題**：任務目標除了「連得通」，還可以是「看懂了沒」。點目標作答：單選、複選，或填 MAC 位址、IP、埠名、數字（MAC 不管分隔符號與大小寫，`GigabitEthernet0/6`、`gi 0/6` 都算同一個埠）。正確答案是從目前的網路算出來的；每個錯的選項有自己的說明，填空題會認出常見的錯誤答案（例如填了第一段的 MAC）。第 18 章「封包實驗室」整章都是這種關卡。
- **2D 邏輯拓撲圖**：頂端列的按鈕切換（T 鍵）。每台設備用網路圖慣用的符號（路由器、交換器、L3 交換器、防火牆、基地台、伺服器…）加上位址；線上兩端的埠與 VLAN；Access 埠的線照 VLAN 上色（左下角的圖例列出每個 VLAN 的顏色與名稱，可以關掉）、Trunk 畫粗；同一對設備之間的好幾條線會錯開。線路狀態、無線與虛擬連線、VPN 通道，以及最近一次測試走過的路徑。執行測試時封包也在 2D 圖上跑，旁邊標著協定（ARP 廣播、ICMP 請求、TCP 443 · SYN…），到站的設備閃一下。滾輪縮放、拖曳平移、雙擊回到全圖，點設備開啟設定。
- **3D 場景的標示**：設備的名稱標籤前面是設備種類的圖示（顏色代表狀態）；封包動畫的每一段都標出協定、埠號與三向交握的步驟；失敗原因的說明泡泡不會跑到兩側面板底下。
- **文件產出**：2D 拓撲圖上方的「匯出圖片」把目前的拓撲圖（含位址、標註與關卡名稱）存成 SVG（向量，可以用 draw.io、Visio、Inkscape 再修改）或兩倍解析度的 PNG；「IP 位址表」列出每台設備每個介面的位址、網段、來源（固定 / DHCP）、預設閘道、VLAN、VRF 與說明，另有網段摘要，可以複製後直接貼到試算表或下載 CSV（Excel 打得開的 UTF-8）。
- **流量熱圖**：2D 拓撲圖上方的「流量熱圖」把每條線照目前的使用率上色（綠 < 40%、黃 < 70%、橘 < 90%、紅），越忙畫得越粗，線的中間標出 Mbps 與百分比；背景流量、攝影機的影像、iperf 都算在內，一眼就看得到瓶頸在哪一段。
- **參考解法**：提示都看完之後可以看參考解法改了哪些地方（Cisco 設備是 running-config 的差異），或讓它示範一次：重置、套用、自動跑一次測試，示範不計星。
- **錯題本**：測驗、過關小考、模擬考答錯的題目照間隔重複排程（1 → 3 → 7 → 14 → 30 天），頂端列的「測驗」會顯示到期的題數。

## 證照對照

`src/data/certs.js` 把每一關對應到考試大綱的條目，遊戲內的「證照地圖」會顯示涵蓋與完成的進度。

| 考試 | 有對應關卡的條目 | 還沒有關卡的條目 |
| --- | --- | --- |
| Cisco CCNA 200-301 v1.1 | 53 條中的 52 條 | 5.2（安全計畫的要素：題庫與知識庫有，沒有關卡） |
| CompTIA Network+ N10-009 | 25 條全部有對應 | — |
| CompTIA Security+ SY0-701 | 只列出與網路相關的 12 條，全部有對應 | — |
| Cisco CCNP ENCOR 350-401 v1.2 | 42 條中的 35 條 | 1.3 SD-Access、2.3 LISP 與 VXLAN、4.3 SPAN、5.2.b CoPP、5.4.d TrustSec 與 MACsec、6.1 Python、6.6 EEM（知識庫有文章，沒有關卡） |
| Cisco CCNP ENARSI 300-410 v1.1 | 25 條中的 24 條 | 3.3 CoPP |
| Cisco CCIE Enterprise Infrastructure v1.1（實作） | 整理到第二層的 23 條中的 20 條 | 2.1 SD-Access、2.2 SD-WAN、5.2 EEM 與 Python |

沒有關卡的條目（安全計畫）是觀念題，題庫裡有對應的題目。
條目編號依公開的考試大綱，標題是中文摘要。CCNA v2.0 預計在 2027 年 2 月取代 v1.1，改版後需要重新對照。
CCNP 的兩張依 Cisco 公布的考試大綱（ENCOR v1.2、ENARSI v1.1）；CCIE 是八小時的實作考試，條目只整理到第二層，各單元的比重與細項以 Cisco 公布的文件為準。第 19、20 章的關卡只對應到這三張。關卡練得到觀念與設定，實作考試的規模、時間壓力與設計題要另外準備。
題庫（291 題觀念題加上隨機產生的子網路計算題）是自行編寫的練習題，不是實際試題。

## CLI 設定指令

支援的範圍是 `show running-config` 會印出來的那些指令，都可以縮寫（`conf t`、`int gi0/1`、`sw mo tr`），前面加 `no` 是取消。
把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定（測試會對 114 台設備逐一驗證）。

| 模式 | 指令 |
| --- | --- |
| 全域 | `hostname`、`archive`（`path`、`maximum`、`write-memory`、`log config` → `logging enable` / `notify syslog` / `hidekeys`）、`track`、`ip sla` → `icmp-echo` → `frequency`、`ip sla schedule`、`errdisable recovery cause / interval`、`interface` / `interface range` / `interface vlan` / `interface loopback`、`vlan`、`ip route`、`ipv6 route`、`router ospf`、`router bgp`、`route-map`、`ip prefix-list`、`ip as-path access-list`、`ipv6 router ospf`、`ipv6 dhcp pool`、`ipv6 access-list`、`ip dhcp pool`、`ip dhcp excluded-address`、`ip nat inside source …`、`ip access-list extended`、`spanning-tree vlan … priority`、`ip dhcp snooping`、`ip arp inspection vlan`、`line vty`、`ntp server`、`logging host`、`snmp-server …`、`username`、`ip domain name`、`ip ssh version`、`boot system`、`ip ftp username / password` |
| 介面 | `ip address`、`shutdown`、`switchport mode / access vlan / trunk native vlan / trunk allowed vlan`、`no switchport`、`encapsulation dot1q`、`ip nat inside / outside`、`ip helper-address`、`ip ospf cost / priority / network / hello-interval / dead-interval [minimal hello-multiplier] / authentication / message-digest-key / mtu-ignore / bfd`、`bfd interval … min_rx … multiplier …`、`ip ospf <pid> area <區域>`、`ip mtu`、`ip access-group`、`ipv6 address … [link-local]`、`ipv6 nd managed-config-flag / other-config-flag / prefix default no-autoconfig / ra suppress`、`ipv6 dhcp server / relay destination`、`ipv6 ospf 1 area / cost / priority / network / hello-interval / dead-interval`、`ipv6 traffic-filter`、`vrrp <群組> ip / priority / preempt / track`、`standby <群組> ip / priority / preempt / track`、`glbp <群組> ip / priority / preempt / load-balancing`、`channel-group`、`switchport port-security`、`spanning-tree bpduguard`、`ip dhcp snooping trust`、`ipv6 address` |
| 其他 | VLAN 的 `name`、OSPF 的 `network … area`、`router-id`、`passive-interface [default]`、`auto-cost reference-bandwidth`、`maximum-paths`、`area … range`、`area … authentication [message-digest]`、`area … stub [no-summary]`、`area … nssa [no-summary] [default-information-originate] [no-redistribution]`、`area … default-cost` 與 `default-information originate`、`router ospf <pid> vrf <名稱>`、BGP 的 `bgp router-id`、`network … mask`、`neighbor … remote-as / description / update-source / next-hop-self / route-reflector-client / ebgp-multihop / disable-connected-check / send-community / route-map / prefix-list / filter-list / weight / default-originate / shutdown`、`bgp redistribute-internal`、route-map 的 `match ip address prefix-list`、`match as-path`、`match community`、`set local-preference / as-path prepend / metric / weight / community … [additive]`、`ip community-list`、`ip bgp-community new-format`、`mac address-table static`、`vlan dot1q tag native`、`ipv6 nd raguard policy`（`device-role`）、VLAN 的 `private-vlan primary | isolated | community` 與 `association`、介面的 `switchport port-security maximum / violation protect | restrict | shutdown / mac-address [sticky]`、`storm-control broadcast level / action`、`switchport protected`、`switchport mode private-vlan host | promiscuous`、`switchport private-vlan host-association / mapping`、`ipv6 nd raguard attach-policy`、SVI 的 `private-vlan mapping`、`ip route [vrf <名稱>] <網段> <遮罩> [出口介面] <下一站> [global]`、DHCP 位址池的 `network` / `default-router` / `dns-server`、ACL 的 `permit` / `deny`、`line vty` 的 `transport input` / `access-class`；EIGRP 的 `router eigrp <AS>` → `network <網段> [萬用遮罩]`、`passive-interface [default]`、`eigrp router-id`、`variance`、`maximum-paths`、`metric weights`、`no auto-summary`、`default-metric`、`redistribute static | connected | ospf <程序> [metric …]`，`key chain` → `key` → `key-string`，介面的 `bandwidth`、`delay`、`ip hello-interval eigrp`、`ip hold-time eigrp`、`ip authentication mode eigrp <AS> md5`、`ip authentication key-chain eigrp`、`ip summary-address eigrp`、`no ip split-horizon eigrp`；RIP 的 `router rip` → `version 1 | 2`、`network <主網段>`、`passive-interface [default]`、`no auto-summary`、`default-information originate`、`redistribute static | connected | ospf <程序> | eigrp <AS> [metric <跳數>]`、`default-metric`、`maximum-paths`、`timers basic`，介面的 `ip rip send version` / `receive version`、`ip rip authentication mode md5`、`ip rip authentication key-chain`、`ip summary-address rip`、`no ip split-horizon` |

在設定模式下要看狀態請用 `do show …`。按 Tab 可以補齊指令，指令打到一半加上 `?` 會列出接下來可以輸入的字。
`show` 的輸出可以用 `| include`、`| exclude`、`| begin`、`| section`、`| count` 加正規表示式篩選（例如 `show run | i http|restconf`、`sh run | sec interface`）。
一次貼上好幾行（整份設定檔、VPN 的「下載設定檔」）會和真的 console 一樣一行一行執行，SSH 登入設備之後的終端機也一樣。
`show running-config` 與 `show ip interface brief` 的介面名稱和真的 IOS 一樣是完整名稱（`GigabitEthernet0/0/0`）。

另外還支援：

- **VPN**：`crypto isakmp policy`（encryption / hash / group）、`crypto isakmp key … address …`、`crypto ipsec transform-set`、`crypto map … ipsec-isakmp`（`set peer`、`set transform-set`、`set pfs`、`set ikev2-profile`、`match address`），以及介面上的 `crypto map`。IKEv2：`crypto ikev2 proposal`（encryption aes-cbc-128 / aes-cbc-256、integrity、group）、`crypto ikev2 policy`、`crypto ikev2 keyring` → `peer` →（`address`、`pre-shared-key [local | remote]`）、`crypto ikev2 profile`（`match identity remote address | fqdn domain | any`、`identity local fqdn`、`authentication local / remote pre-share | rsa-sig`、`keyring local`、`pki trustpoint`）；`show crypto ikev2 sa`、`show crypto ikev2 profile`。
- **PKI**：`crypto pki trustpoint`（`enrollment url`（SCEP）、`subject-name`、`revocation-check none | crl | crl none`、`rsakeypair`、`fqdn`、`serial-number none`、`ip-address none`）、`crypto pki authenticate`（核對指紋後接受 CA 的根憑證）、`crypto pki enroll`、`crypto pki certificate chain`（running-config 裡的憑證可以整份貼回）；`show crypto pki certificates`、`show crypto pki trustpoints [status]`。CA 伺服器用 SCEP（TCP 80）自動核發，憑證往前推 10 分鐘生效。
- **NAT 的範圍**：`ip nat inside source list <ACL>` 可以指定編號或具名的 ACL，`access-list <編號>` 也能用。
- **NAT 位址池**：`ip nat pool <名稱> <起始> <結束> netmask <遮罩> | prefix-length <長度>`、`ip nat inside source list <ACL> pool <名稱> [overload]`。沒有 overload 是一對一的動態 NAT：一台內部主機佔一個公用位址，閒置到 `ip nat translation timeout`（預設 24 小時）才還回去，借光了就丟封包；overload 是共用第一個位址的 PAT。位址池落在 `ip nat outside` 介面的網段裡時，路由器替它們回應 ARP。位址池在 CLI 設定，「NAT / 轉發」分頁的位址池卡片看得到借出幾個、可以切換 overload。
- **NAT hairpin**：傳統的 inside / outside NAT 只在封包從 outside 介面進來時，才把靜態 NAT 的公用位址換回內部位址。內部的人連自己公司伺服器的公用位址（hairpin），封包從 inside 進來、不會被轉換，連線失敗；要讓內部 DNS 對同一個名稱回內部位址 (split DNS)。沒有任何介面設成 outside 時，靜態 NAT 也不會生效（NAT 分頁會提醒）。
- **DHCP 保留位址**：只有一台主機的位址池（`host` 加上 `hardware-address`）。
- **實體層**：`speed`、`duplex`。
- **MTU**：路由器介面的 `mtu`（1500 – 9216）與 `ip mtu`（不能比介面的 MTU 大）、`ip tcp adjust-mss <500-1460>`、Catalyst 2960 的 `system mtu jumbo <1500-9000>`（存檔、重新開機才生效）、Catalyst 9300 的 `system mtu <1500-9198>`、Nexus 介面的 `mtu <576-9216>`；`show system mtu`、`show ip interface <介面>`（MTU、套用的 ACL、TCP Adjust MSS）、`show interfaces` 的 MTU 與 giants；`ping <IP> [size <36-18024>] [df-bit] [source <介面>]`（M 代表 could not fragment）。ACL 的 ICMP 可以指定類型（`permit icmp any any packet-too-big`），具名 ACL 的序號（`25 permit …`）會插在對的位置。
- **STP 的邊緣埠**：`spanning-tree portfast`（介面，`disable` / `trunk`）、`spanning-tree portfast default`（全域）、`spanning-tree guard root`。
- **DHCP 租約長度**：位址池裡的 `lease <天> [小時] [分鐘]` 或 `lease infinite`。
- **跟時間有關的查看指令**：`show clock`、`show spanning-tree`（LSN / LRN / FWD）、`show ip ospf neighbor`（Dead Time）、`show ip dhcp binding`（到期時間）、`show arp`（Age）、`clear arp`。
- **存檔**：`write memory` / `copy running-config startup-config`、`show startup-config`、`reload`。
- **MAC 位址表**：`show mac address-table`、`show mac address-table aging-time`、`mac address-table aging-time <秒>`、`clear mac address-table dynamic`。
- **NAT 轉換表**：`show ip nat translations [verbose]`、`show ip nat statistics`（位址池的 total / allocated / misses）、`ip nat translation icmp-timeout | udp-timeout | tcp-timeout | … <秒>`、`clear ip nat translation *`。
- **Tunnel 介面**：`interface Tunnel<n>`（路由器）→ `tunnel source <介面 | IP>`、`tunnel destination <IP>`、`tunnel mode gre ip | gre multipoint | ipsec ipv4 | ipv6ip`、`tunnel key`、`keepalive [秒] [次數]`、`tunnel protection ipsec profile <名稱>`、`ip mtu`、`ip tcp adjust-mss`、`ip ospf network broadcast`、`shutdown`；`crypto ipsec profile <名稱>` →（`set transform-set`、`set pfs`、`set ikev2-profile`、`set security-association lifetime seconds`）；transform-set 裡的 `mode transport | tunnel`；`crypto isakmp key … address 0.0.0.0`（萬用金鑰）；`[no] crypto ipsec nat-transparency udp-encapsulation`、`crypto isakmp nat keepalive`；`ip route <網段> <遮罩> Tunnel0`（點對點的 Tunnel 只寫出口介面）；ACL 可以寫 `esp`、`gre`、`ahp`，命名 ACL 的序號和 IOS 一樣保留（`no 10` 不會讓後面的重新編號）。
- **DMVPN（NHRP）**：`ip nhrp network-id`、`ip nhrp authentication`、`ip nhrp holdtime`、`ip nhrp nhs <IP> [nbma <IP>] [multicast]`、`ip nhrp map <IP> <NBMA>`、`ip nhrp map multicast dynamic | <NBMA>`、`ip nhrp redirect`、`ip nhrp shortcut`；`show dmvpn`、`show ip nhrp [brief]`、`show ip nhrp nhs`、`show interfaces tunnel <n>`、`show crypto session`、`show crypto ipsec profile`、`show crypto ipsec transform-set`、`show running-config interface <名稱>`。
- **VPN 的時間面**：`show crypto isakmp sa`、`show crypto ipsec sa`、isakmp policy 裡的 `lifetime`、`crypto ipsec security-association lifetime seconds`、crypto map 裡的 `set security-association lifetime seconds`、`crypto isakmp keepalive <秒> [重試間隔]`。
- **時鐘與 NTP**：`show clock [detail]`、`clock set`、`clock timezone`、`ntp server`、`ntp master [stratum]`、`show ntp status`、`show ntp associations`；`service timestamps log | debug datetime [msec] [localtime] [show-timezone] [year]`、`service timestamps log uptime`、`no service timestamps`（預設和 IOS 15 一樣是 datetime msec、用 UTC）。
- **紀錄**：`show logging`、`logging host`、`logging trap <等級>`、`clear logging`。
- **OSPF**：`show ip ospf`（每個程序一段：stub / NSSA、是不是負責 Type-7 的轉換、VRF 的程序）、`show ip ospf neighbor`（Pri、FULL/DR、2WAY/DROTHER、EXSTART；所有程序的鄰居在同一張表）、`show ip ospf interface [brief | <介面>]`、`show ip ospf database`（Summary 的 0.0.0.0、Type-7、轉換出來的 Type-5，只列自己網域的 LSA）、`show ip protocols [vrf <名稱>]`、`show ip route vrf <名稱> [ospf | static | <位址>]`、`clear ip ospf process`（Router ID 改了要清除程序才會生效；全域與 VRF 的程序一起重來）。
- **EIGRP**：`show ip eigrp neighbors`（Hold 倒數、Uptime）、`show ip eigrp topology [all-links]`（FD / RD、successor 與 feasible successor，all-links 連不合格的路也列出來）、`show ip eigrp interfaces`、`show ip route eigrp`（D 與 D EX，variance 分擔的路顯示各自的 metric）、`show ip protocols`（K 值、Router-ID、network、passive、路由來源）、`show interfaces` 的 BW 與 DLY。
- **RIP**：`show ip route rip`（時間是距離上次收到更新幾秒）、`show ip rip database`（auto-summary、possibly down）、`show ip protocols`（更新與 invalid / holddown / flush 計時、每個介面送收的版本與 key chain、路由來源）。
- **路由表**：`show ip route` 和真的 IOS 一樣依主網段分組（`is subnetted` / `is variably subnetted`）、列出介面自己的位址 (L)、動態路由的存在時間與 Gateway of last resort；可以篩選 `show ip route ospf | bgp | static | connected`，也可以查單一網段 `show ip route <位址> [遮罩]`（Known via、distance、metric、from、等價的每一條路）。沒放進路由表的路（下一站不通的靜態路由、管理距離比較大的備援路由）會在最後用提示說明原因。
- **路由重分配與政策路由**：`router ospf 1` 底下的 `redistribute static | connected | bgp <AS> [subnets] [metric <n>] [metric-type 1|2] [tag <n>] [route-map <名稱>]`、`router bgp` 底下的 `redistribute static | connected | ospf <程序> [metric <n>] [route-map <名稱>]`；route-map 的 `match ip address prefix-list <名稱>` / `match ip address <ACL>`、`match tag`、`set metric`、`set metric-type type-1`、`set tag`、`set ip next-hop`、`set ip default next-hop`；介面的 `ip policy route-map`、全域的 `ip local policy route-map`；`show route-map`（政策路由比對到幾個封包）、`show ip policy`、`show ip ospf`（ASBR 與重分配的來源）、`show ip ospf database`（每一筆 Type-5）、`show ip route <網段>`（type extern 1 / 2、Tag）；`router ospf` 底下的 `redistribute eigrp <AS>` 與 `redistribute rip`（連同跑 EIGRP / RIP 的直連網段，種子 metric 20），`router eigrp` 底下的 `redistribute ospf <程序> metric <頻寬> <延遲> <可靠度> <負載> <MTU>`（沒有 metric 也沒有 `default-metric` 就不會送出去）。
- **第二層安全**：`show port-security [interface <埠> | address]`、`show mac address-table [count | static | interface <埠>]`（表被 MAC flooding 塞滿時看得到幾千筆亂造的項目）、`show storm-control [<埠>]`、`show vlan private-vlan`、`show ipv6 nd raguard policy`、`show interfaces <埠> switchport`（Protected、Private VLAN、Native VLAN tagging）。
- **BGP**：`show ip bgp`（`*>i`、`r` RIB-failure、下一站查不到的沒有 `*`）、`show ip bgp <網段>`（inaccessible、metric、internal / external、Community、Originator 與 Cluster list、沒被選上的原因）、`show ip bgp summary`、`show ip bgp neighbors [<IP> [advertised-routes | received-routes | routes]]`（internal / external link、Route-Reflector Client、update-source）、`show ip prefix-list`、`show ip community-list`、`show route-map`、`show ip as-path-access-list`、`clear ip bgp *`。
- **管理距離、路由過濾與標籤**：`router ospf` 底下的 `distance ospf [external <n>] [inter-area <n>] [intra-area <n>]`、`distance <n>`、`distribute-list route-map | prefix <名稱> in`（LSA 照收、SPF 照算，只是不放進這台的路由表）；`router eigrp` 底下的 `distance eigrp <內部> <外部>`、`redistribute … route-map <名稱>`（`match tag`、`set tag`）。來源那筆路的標籤會跟著重分配帶過去。`show ip ospf database external` 列出每一筆 Type-5 是哪一台送的、metric 的種類與標籤；`show ip eigrp topology <網段>` 列出每一條路的合成 metric、最小頻寬、延遲、跳數、來源的 Router ID 與標籤；`show ip route <網段>` 的 EIGRP 路由有 traffic share count。
- **Null0**：`ip route <網段> <遮罩> Null0 [管理距離]`；`ip summary-address eigrp` 與 OSPF 的 `area range` 會在做彙總的那一台自動產生指向 Null0 的丟棄路由（`D 10.2.0.0/22 is a summary, …, Null0`，EIGRP 的管理距離是 5）。`show ip route <網段> <遮罩> longer-prefixes` 看彙總底下還有哪些明細。
- **MPLS VPN 的 BGP**：`address-family vpnv4` 底下的 `neighbor <ip> route-reflector-client`（和 IPv4 的分開設）、`neighbor <ip> allowas-in [次數]`（AS_PATH 裡可以出現自己的 AS，預設 3 次）、`neighbor <ip> as-override`（送給客戶之前把客戶的 AS 換成自己的）；`show ip bgp summary` 會寫出有幾筆因為 AS_PATH loop 被丟掉。業者的骨幹（VRF、MPLS 標籤、VPNv4）不模擬，用一台 PE 代表。
- **IPv6**：`show ipv6 route [ospf | static | connected | local | <位址或前綴>]`（IOS 原樣的格式，含 L 與 FF00::/8）、`show ipv6 interface [brief | <介面>]`（加入的多點傳送群組、RA 的設定、主機要用 SLAAC 還是 DHCPv6）、`show ipv6 ospf [neighbor | interface brief]`、`show ipv6 dhcp pool | binding | interface`、`show ipv6 access-list`（命中次數與序號）、`clear ipv6 ospf process`、`clear ipv6 dhcp binding *`；`ipv6 route` 可以寫「出口介面 + link-local 下一站」與管理距離。主機上有 `sudo dhclient -6 eth0`，`traceroute`、`curl`、`telnet` 都可以用 IPv6 位址（網址寫成 `http://[2001:db8::10]/`）；用名稱 `ping` 時有 AAAA、電腦也有全域 IPv6 就用 IPv6（`ping -4` / `ping -6` 指定），`curl` 用 Happy Eyeballs。Tunnel 上也能設 IPv6 位址、跑 OSPFv3。
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
- **HSRP / VRRP / GLBP 與追蹤**：`standby` 是 HSRP、`vrrp` 是 VRRP、`glbp` 是 GLBP，群組號碼與 preempt 的預設值和真的設備一樣（VRRP 會搶、HSRP 與 GLBP 不會）；虛擬 MAC 各自不同（HSRP 0000.0c07.acXX、VRRP 0000.5e00.01XX、GLBP 每台 AVF 一個 0007.b400.XXYY）；`show glbp [brief]`；`track <n> interface <介面> line-protocol`、`track <n> ip sla <操作> reachability`、`ip route … track <n>`；`show standby [brief]`、`show vrrp brief`、`show track`、`show ip sla statistics | configuration`。
- **NetFlow**：傳統的 `ip flow ingress | egress`、`ip flow-export destination <IP> <埠>`、`ip flow-export version 9`、`ip flow-export source`；Flexible NetFlow 的 `flow record`（match / collect）、`flow exporter`（destination、transport udp、source）、`flow monitor`（record，可以用內建的 `netflow ipv4 original-input`；exporter；cache timeout）與介面的 `ip flow monitor <名稱> input | output`；`show ip cache flow`、`show flow monitor <名稱> cache`、`show flow exporter`、`show ip flow export`。網管伺服器的「網管」分頁可以當 NetFlow 收集器，列出流量大戶。
- **BFD**：介面上 `bfd interval <毫秒> min_rx <毫秒> multiplier <n>`，`router ospf` 底下 `bfd all-interfaces`（或介面上 `ip ospf bfd`）、BGP 的 `neighbor … fall-over bfd`；`show bfd neighbors [details]`。
- **設定封存與變更紀錄**：`archive config`、`show archive`、`show archive config differences [檔案 [檔案]]`（不加參數是 startup 對 running）、`show archive log config all | user <帳號>`、`configure replace flash:<檔案> [list] [force]`。
- **err-disabled**：BPDU Guard 與 Port Security 關掉的埠會一直維持到 `shutdown` → `no shutdown` 或 `errdisable recovery`；`show interfaces status err-disabled`、`show errdisable recovery`。
- **主機的 DNS**：`nslookup <名稱>`、`dig <名稱>`（看得到 TTL 與 aa 旗標；`+short` 只印答案）、`host <名稱>` 直接問 `/etc/resolv.conf` 裡的伺服器，不經過本機的快取；`nslookup -type=aaaa <名稱>`、`nslookup -type=mx <網域>`、`nslookup <IP>` / `dig -x <IP>`（PTR 反查）。ping、瀏覽器、curl 用的是本機 systemd-resolved 的快取（依 TTL 到期）：`resolvectl show-cache` 看、`resolvectl flush-caches` 清、`resolvectl query <名稱>` 經過快取查詢、`resolvectl status` 看用哪幾台伺服器。DNS 伺服器的「DNS」分頁可以編輯 A / AAAA / CNAME / MX / PTR 記錄與 TTL。
- **帳號**：可以有多個本機帳號（`username` / `no username`），SSH、RESTCONF 都可以用；變更紀錄記的是登入的那個帳號。
- **排除故障**：`traceroute`、`show interfaces [介面]`、`show interfaces counters errors`、`clear counters`、`debug ip packet`、`debug ip icmp`、`debug ip ospf adj | hello`、`debug ip dhcp server packet | events`、`debug crypto isakmp | ikev2 | ipsec`、`undebug all`、`show debugging`、`show ip protocols`、`show ip ospf interface brief`。

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

- **DoS 政策**：`config firewall DoS-policy` → `edit <編號>` → `set interface "<流量進來的介面>"`，裡面的 `config anomaly` → `edit "tcp_syn_flood"`（也認得 `udp_flood`、`icmp_flood`）→ `set status enable`、`set action pass | block`（預設 pass：只記錄）、`set threshold <每秒封包數>`（tcp_syn_flood 預設 2000）。`show firewall DoS-policy`、`diagnose ips anomaly list`（每一條政策量到的 pps、門檻與動作）。圖形介面在「安全設定檔」分頁最下面，會直接說明現在是「掛錯介面量不到」「偵測到但只記錄」還是「封鎖中」；超過門檻時「紀錄」多一筆 `subtype="anomaly"`（`action="detected"` 或 `clear_session"`）。攻擊流量走過的線在 3D 場景與 2D 拓撲圖上閃紅色，被塞滿的伺服器在標籤上註明。

## 模擬時間

所有設備共用一個時鐘（場景上方的 `T+00:00:00`），以下這些事情都要「等」，等待期間測試會失敗並說明還在等什麼：

| 項目 | 時間 | 說明 |
| --- | --- | --- |
| STP 邊緣埠 | 30 秒 | 連線後先 listening 15 秒、learning 15 秒才轉送；開了 PortFast 的埠立刻轉送。等待中的網路線會閃橘色 |
| 交換器之間的連線 | 2 秒 | 兩端都跑 Rapid STP，用提議 / 同意快速收斂 |
| OSPF 鄰居建立 | 點對點約 4 秒；乙太網路 40 秒 | 乙太網路上第一次要等 DR 選舉 (Wait timer) 才會交換路由；網段上已經有 DR 時，新加入的路由器約 6 秒就 FULL。MTU 不一致會卡在 EXSTART |
| OSPF 鄰居失聯 | 40 秒 | 隔著交換器、自己的介面沒有斷的時候，要等 Dead timer 才發現；這段時間封包照舊送往已經不在的鄰居 |
| EIGRP 鄰居建立 | 立刻 | 收到對方的 Hello 就建立，馬上交換路由 |
| EIGRP 鄰居失聯 | Hold time 15 秒 | 介面斷線立刻知道；隔著交換器時要等 Hold time（Hello 5 秒的 3 倍）到期才拆掉，這段時間封包照舊送往已經不在的鄰居 |
| RIP 學到新的路 | 立刻 | 設定改了就送 triggered update（真的設備上，沒有變化時每 30 秒才送一次） |
| RIP 鄰居失聯 | invalid 180 秒、flush 240 秒 | 介面斷線立刻知道；隔著交換器時路還指向對方，180 秒後標成 possibly down（holddown，不接受同樣或更差的路），240 秒才清掉、改走別條路 |
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

有些關卡看不到接線（11-9：線藏在天花板裡，場景與 2D 拓撲圖都不畫線，連接埠只說有插線），要用 CDP / LLDP 與 MAC 位址表自己找出來。

有些關卡有劇本：時間走到某一刻會真的發生事情（例如 12-4「三分鐘後施工挖斷主線、十分鐘後修好」），畫面會跳出通知，網路線的說明也會寫出原因。劇本只跟著時間走，「快轉到收斂」不會為了它特地往前跳；任務裡的故障演練則是在複本上測，隨時都可以按。

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

## 自動化與雲端

- **RESTCONF**：IOS XE 的設備（ISR 4321 / 4331、Catalyst 9300、9800）用 `ip http secure-server`、`ip http authentication local`、`restconf` 啟用；Catalyst 2960 是 IOS 15、Nexus 是 NX-API，沒有 RESTCONF。主機的「API」分頁像 Postman：方法、網址、Basic 驗證、Accept / Content-Type、JSON 內容（有語法檢查），回應顯示狀態碼與內容，旁邊列出等效的 curl 指令。終端機也可以直接打 `curl -k -u 帳號:密碼 -H "Accept: application/yang-data+json" https://…/restconf/data/…`（`-X`、`-d`、`-i`、`-v`）。請求真的走一趟 TCP 443，路上的 ACL、防火牆都會檢查；改設定時設備的紀錄寫下 `%DMI-5-CONFIG_I`。
- **Ansible**：控制主機（Linux 的提示字元）有「Ansible」分頁：編輯 `inventory.ini` 與 playbook，`--check`、`-v`、`--limit`，也可以在終端機打 `ansible-playbook -i inventory.ini site.yml`。模組有 `cisco.ios.ios_vlans`、`ios_l2_interfaces`、`ios_interfaces`、`ios_l3_interfaces`、`ios_config`、`ios_command`、`ios_facts`、`debug`、`assert`；task 可以用 `register`、`loop`、`when`、`ignore_errors`。每台設備真的用 SSH 登入（帳號密碼、line vty、路由都要對），YAML 的錯誤訊息和真的一樣指出第幾行。
- **Catalyst Center**：控制器的北向 API 用 Token 驗證（先 `POST /dna/system/api/v1/auth/token`，之後每個請求帶 `X-Auth-Token`，一小時過期）；`/dna/intent/api/v1/network-device` 的設備清單是控制器真的用 SNMP 與 SSH 輪詢的結果，`/dna/intent/api/v1/issues` 依網路的實際狀態列出問題（設備連不到、某個 VLAN 的 DHCP 失敗率偏離基準、雙工不一致、速率降級）。API 分頁有對應的範本，拿到的 Token 會自動帶到後面的請求。
- **雲端**：AWS 的 VPC 用主控台設定（VPC、子網路、路由表、EC2、安全群組、網路 ACL、NAT 閘道、VPN）。EC2 分頁的 Instance Connect 可以從執行個體 ping / curl 測試；VPN 的「下載設定檔」產生 Cisco ISR 或 FortiGate 的設定，可以直接貼進公司的設備。

## 鄰居探索與 DTP

- **CDP 與 LLDP**：鄰居表是從真的收到的通告學來的，每一筆都有剩下的 holdtime。Catalyst 與 ISR 出廠時 CDP 開、LLDP 關；Nexus 兩個都開；IP 電話兩個都講（Yealink 只講 LLDP-MED）；UniFi 基地台只講 LLDP。中間隔著 Hub 或非網管交換器時，CDP 會被泛洪過去（一個埠上看到好幾個鄰居），LLDP 的目的位址是 802.1D 保留給「最近的橋接器」的，交換器不會轉送。
- **靠 CDP 才知道的事**：雙工不一致 (`%CDP-4-DUPLEX_MISMATCH`)、Native VLAN 不一致 (`%CDP-4-NATIVE_VLAN_MISMATCH`) 都要收到對方的 CDP 才會出現，每分鐘抱怨一次。電話的語音 VLAN 與 PoE 協商也是：Cisco 的電話與 AP 用 CDP（AP 也可以用 LLDP）告訴交換器實際要多少瓦，沒有的話交換器依 IEEE 等級保留上限（AP 是 Class 4 的 30 W）。供電、拒絕、拔掉會記 `%ILPOWER-5-POWER_GRANTED`、`%ILPOWER-5-ILPOWER_POWER_DENY`、`%ILPOWER-5-IEEE_DISCONNECT`。
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
| `ping` / `traceroute` 的時間 | 往返時間是一段一段算出來的：交換器轉送幾微秒、路由器數十微秒、防火牆約 0.1 ms，加上封包大小 ÷ 線路速率、線的長度、Wi-Fi（訊號弱、干擾多會更慢更不穩）、雙工不一致的重送，線路忙的時候再加上排隊；回應 ping 與 TTL exceeded 的是設備的 CPU，所以 ping 交換器本身比 ping 它後面的電腦還慢。Linux 的 ping 最後有 `rtt min/avg/max/mdev`；經過 ISP 到網際網路約 9 ms |
| `debug ip packet` / `debug ip icmp` | 只看得到給路由器自己、它自己送出的、以及它丟掉的封包；經過它轉送的封包由 CEF 處理，不會出現（真的路由器也是這樣） |
| `debug ip ospf adj` / `hello` | 鄰居建不起來時，每個 Hello 間隔印一次原因，格式和 IOS 15 一樣：`Mismatched hello parameters`（Dead / Hello / Mask 的 R 收到的、C 自己設定的）、`mismatched area … in the header`、`Mismatched Authentication type` / `Key`、Stub 選項位元、MTU 不一致時 `Nbr … has larger interface MTU` 與 DBD 重送。Router ID 重複不用開 debug，本來就會記 `%OSPF-4-DUP_RTRID_NBR` |
| `debug ip dhcp server packet` / `events` | 路由器發出租約時的 DISCOVER、OFFER、REQUEST、ACK（用戶端識別碼是 01 加上 MAC），續約只有 REQUEST / ACK 而且是 unicast |
| `debug ip rip` | 每個更新週期（30 秒）印一次：`received v2 update from … on …` 與每一筆路的跳數、`sending v2 update to 224.0.0.9 via …`（v1 送到 255.255.255.255，寫成 network / subnet），被丟掉的更新寫出原因：`illegal version`、`invalid authentication`、`bad source` |
| `debug crypto isakmp` / `ikev2` / `ipsec` | 通道建不起來的原因：對端沒回應時的 `retransmitting phase 1 MM_NO_STATE`、`No pre-shared key with …!`、金鑰不一致的 `IKMP_BAD_MESSAGE`、`phase 1 SA policy not acceptable!`、IKEv2 的 `NOTIFY(AUTHENTICATION_FAILED)` / `NO_PROPOSAL_CHOSEN` / `TS_UNACCEPTABLE`、第二階段的 `IPSec policy invalidated proposal with error 256`（加密提案）與 `32`（proxy ID）。IKEv1 看 isakmp、IKEv2 看 ikev2 |
| FortiGate 的 sniffer 與 debug flow | 封包從哪個介面進來、從哪個介面出去；在防火牆裡被哪一條政策放行或拒絕、有沒有 NAT |

## 頻寬與傳輸速率

`iperf3 -c <IP>` 或「傳輸速率」目標會沿著實際路徑找出最慢的一段：

- 全雙工連線約為標稱速率的 94%（扣掉訊框與 TCP 標頭）。
- 半雙工（接到 Hub）約 40%。
- Duplex mismatch 只剩標稱速率的 1%（上限 2 Mbps），並出現大量重送：ping 會通，傳檔卻慢得不能用。
- Wi-Fi 約為連線速率的一半；IPsec 通道再扣 10%。
- 有背景流量在跑的線路，只分得到剩下的頻寬（至少和其他連線平分），結果會註明是和背景流量共用。
- 網路線有線對斷掉時，兩端的 Gigabit 埠會自動降到 100 Mbps (speed downshift)，燈號照樣是亮的；寫死 `speed 1000` 的話則連不起來。
- 網路線接觸不良（水晶頭鬆了）：每分鐘斷幾秒（介面 flapping，`show logging` 一直出現 %LINK-3-UPDOWN），連著的時候也有 CRC 錯誤；沒有 PortFast 的存取埠每斷一次就多等 30 秒。換一條新的線才會好。背景流量經過有 CRC 錯誤的線路（接觸不良、光纖的光太弱）時，計數器也會跟著增加。

## 貼近真實網路的行為

- **網路線插在真正的連接埠上**：每條線都從它接的那個孔出發；連接埠的燈號跟著實際的連線狀態（綠色是連上，琥珀色是被 STP 封鎖或還在等待）。
- **ARP**：第一次要送封包給某個 IP 之前，會先廣播詢問它的 MAC（橘色光點擴散到整個廣播網域），問到之後記在 ARP 快取裡，下一個封包就不再詢問。
- **Hub 泛洪**：經過 Hub 的訊框會被複製到其他每一個埠；接到 Hub 的連線是 10 Mbps 半雙工。
- **DHCP 四步驟**：Discover（廣播）→ Offer → Request（廣播）→ Ack，經由 Relay 時會顯示轉送；DHCP 伺服器可以設定保留位址（依 MAC 固定發同一個 IP）。
- **封包標頭**：追蹤紀錄的每一段都可以打開，看到來源 / 目的 MAC 每過一台路由器就換一次，IP 只有經過 NAT 才會變，TTL 逐站遞減。
- **MAC 位址的廠商碼**：每台設備的 MAC 前三個位元組是那家廠商真的登記的 OUI（Cisco、Fortinet、Juniper、MikroTik、Dell、Synology、Hikvision…，筆電的無線網卡是 Intel），同一台設備的各個埠是連號的（基底位址 + 第幾個埠）；手機用的是隨機的私人位址，雲端的虛擬網卡是本機管理位址。舊存檔裡輸入過的 MAC（Port Security、DHCP 保留、MAC 過濾）會自動換成新的。
- **TTL 與來源埠**：Linux 主機送出的封包 TTL 是 64，Cisco、FortiGate、BIG-IP 是 255；`ping` 顯示的是回應到達時真正剩下的值，所以看得出對方是什麼系統、中間隔了幾台路由器。用戶端的來源埠落在 Linux 的暫時埠範圍（32768–60999）。
- **網際網路不是一站就到**：`traceroute 8.8.8.8` 在業者的閘道之後還有幾站骨幹的路由器（100.64.0.0/10 的位址，有的不回應、顯示 `* * *`），最後一站才是目的地；ping 回來的 TTL 也照樣少了這幾站。
- **主機名稱與 VLAN 名稱**：畫面上的名稱可以是中文，命令列上的 hostname 是另外的英數名稱（`hostname` 指令照 IOS 的規則檢查）；VLAN 名稱只收 1 – 32 個 ASCII 字元、不能有空白，沒填的話是 `VLAN0010`。
- **連線紀錄**：防火牆記錄每一條新連線是被哪一條政策放行或拒絕，以及來源 / 目的位址的轉換。
- **偵測常見的設定錯誤**：IP 位址衝突、Trunk 與 Access 對接、Native VLAN 不一致、兩端 Access VLAN 不同。
- **無線訊號**：依距離與發射功率估算 RSSI，近的用 5GHz、遠的退回 2.4GHz，頻道重疊時速率減半。
- **Root Guard**：啟用的埠如果收到更優先的根橋 BPDU 就進入 root-inconsistent 而被擋下；開在朝向根橋的埠上（錯誤設定）一樣會被擋。
- **TCP 三向交握**：TCP 連線會走完 SYN → SYN-ACK → ACK；防火牆與 NAT 設備用連線紀錄比對後續的封包，不會重新比對政策。
- **DHCP 發放前先確認**：伺服器發出新位址前會先 ping，已經有人在用就跳過並記成衝突；但設備離線期間發出去的租約不會重新檢查，回來之後照樣衝突。
- **5 GHz 的頻道寬度與 DFS**：基地台的「無線電」可以選 20 / 40 / 80 / 160 MHz（或自動）。綁在一起的整塊頻譜（例如 80 MHz 的 36 – 48）和別台重疊就互相干擾、速率減半；自動模式像 Cisco 的 DBS，附近有人用到同一塊就縮窄。52 – 144 是 DFS 頻道：關卡劇本的雷達一來就換到非 DFS 頻道，5 GHz 的用戶端斷 15 秒、30 分鐘內不能回去。
- **6 GHz (Wi-Fi 6E)**：三頻基地台（UniFi U6 Enterprise）與支援 6E 的筆電之間可以用 6 GHz（160 MHz，傳得比 5 GHz 近）。6 GHz 只廣播 WPA3 或 WPA2 / WPA3 混合的 SSID（混合模式在 6 GHz 那一邊只用 WPA3），WPA2 的 SSID 只出現在 2.4 / 5 GHz。
- **訪客入口 (Captive Portal)**：基地台的 SSID 與 WLC 的 WLAN 可以開訪客入口，設定入口網頁伺服器與認證前允許的位址 (pre-auth ACL)。同意之前只連得到這些位址，網頁被導向入口 (302)；電腦與手機的「網路設定」有「打開瀏覽器、在入口網頁按同意」：要先查得到 DNS 才會跳出登入頁面，同意之後 8 小時內可以上網。
- **802.1X 的 EAP-TLS**：主機的 802.1X 可以選 PEAP（帳號密碼）或 EAP-TLS（電腦憑證，加入網域的電腦自動申請）。用戶端先檢查 RADIUS 伺服器的憑證（PEAP 也是），EAP-TLS 再由伺服器檢查用戶端的憑證；兩邊各用自己的時鐘判斷有效期間。RADIUS 伺服器的分頁可以看伺服器憑證的到期日、向公司的 CA 重新申請、開關 EAP-TLS。
- **憑證驗證**：IKEv2 的 `rsa-sig` 由驗證的那一端用 trustpoint 裡 CA 的根憑證檢查對方的憑證，有效期間看的是「自己的時鐘」：時鐘錯了就是 `%PKI-3-CERTIFICATE_INVALID_NOT_YET_VALID` 或 `EXPIRED`。trustpoint 預設 `revocation-check crl`，要連得到 CA 拿 CRL（CA 在 VPN 另一邊時改成 `crl none`）；對方的 profile 要找得到符合的身分（`identity local fqdn` 對上 `match identity remote fqdn domain`）。換過主機板電池的路由器，時鐘回到 2002 年、而且重開機也一樣。
- **IKEv2**：IKE_SA_INIT 與 IKE_AUTH 四個訊息就建好 IKE SA 和第一個 CHILD_SA（IKEv1 要 Main Mode 加 Quick Mode）。兩端版本不一致時協商失敗；預先共用金鑰可以兩個方向不同（A 用來簽的要等於 B 用來驗證的）。第一個 CHILD_SA 不做 PFS 的 DH，所以 PFS 不一致時一開始照樣通，到第一次重新協商才斷 — 任務裡有「一小時後再測一次」。
- **Hub-and-Spoke**：分公司只和總公司建通道，分公司之間的流量在總公司解密、比對政策（VPN → VPN）、再加密送出去；兩條通道的加密範圍、總公司的政策、Cisco 分公司的 NAT 例外都要包含另一個分公司。
- **IPsec 兩階段**：第一階段 (IKE) 與第二階段 (IPsec SA、PFS) 分開協商，哪一個階段不一致會分別指出。IOS 的 ISAKMP 政策整台共用。
- **GRE 與 Tunnel 介面**：GRE 在外面再包一層 IP + GRE 標頭（多 24 位元組，Tunnel 的 MTU 是 1476），traceroute 只看到 Tunnel 對面一站，封包擷取看得到 GRE 裡面的明文。Tunnel 的 line protocol 看外層的路由：tunnel source 是 up、有路到 destination 就是 up/up，對面有沒有設定都不管，要偵測對面就加 keepalive（period × retries 秒沒回應才 down）。Tunnel 預設頻寬 100 Kbit/sec（OSPF cost 1000）、OSPF 網路類型 point-to-point。通往 destination 的最佳路由變成走 Tunnel 自己（Tunnel 上的 OSPF 學到了 WAN 的網段）時，Tunnel 被暫停 30 秒（`%TUN-5-RECURDOWN`），之後再起來、又被關掉，一直 flapping。tunnel key 不一致的 GRE 封包被默默丟掉。
- **GRE over IPsec 與 VTI**：`tunnel protection` 讓 GRE 封包再包進 ESP（proxy ID 是 gre host 本端 host 對端，Tunnel 的 MTU 扣掉兩層剩 1403）；VTI 不包 GRE、直接 ESP（1427），line protocol 跟著 IPsec SA，transform-set 或金鑰不一致時是 up/down，不能設 keepalive。一端 VTI、一端 GRE 時 proxy ID 對不起來。
- **DMVPN**：spoke 向 NHS 註冊（network-id、驗證字串、tunnel key、同一個網段都要對），hub 記下 Tunnel 位址 ↔ NBMA 位址；multicast 只送給 `map multicast` 的對象，hub 少了 `map multicast dynamic` 時 OSPF 只有單向的 Hello。OSPF broadcast 的 DMVPN 上，spoke 往另一個 spoke 內網的下一站是對方的 Tunnel 位址（phase 2）：第一個封包先經過 hub、同時送出 NHRP Resolution，spoke 之間的 IPsec 建好之後就直接走；spoke 搶到 DR 時其他 spoke 聽不到 DR；Tunnel 預設的 point-to-point 在 hub 上一個介面聽到好幾個鄰居，會一直被重設。Phase 3：hub 的 `ip nhrp redirect` 在流量繞回同一個 Tunnel 時通知 spoke，spoke 有 `ip nhrp shortcut` 才會解析整個網段、在路由表裝一筆 H（NHRP）的捷徑。spoke 之間的 IPsec 要靠萬用金鑰（`address 0.0.0.0`）。
- **NAT-T**：IKE 的來源位址在對端看來不一樣（NAT-D）就知道中間有 NAT，兩端都開著 NAT-T 時 IKE 與 ESP 改走 UDP 4500，NAT 設備替這個轉換保留對應，總公司主動連過去也通；關掉 NAT-T 的話 IKE 照樣建得起來，ESP 卻被 PAT 丟掉（沒有連接埠號碼），家用路由器有 IPsec passthrough。對端的設定要指向 NAT 之後的位址，ACL 要放行 UDP 4500。
- **先 NAT 再加密**：路由器會先做 NAT 才比對 crypto map，站對站 VPN 沒有設 NAT 例外的話，通道是 Up 的但流量進不去。
- **running-config 與 startup-config**：IOS 設備改的是 running-config，沒有 `write memory` 就 `reload` 或斷電，設定會回到上一次存檔的樣子。
- **速率與雙工**：一端寫死、另一端自動協商時，自動的那一端會退回半雙工，形成 duplex mismatch；兩端速率寫死成不同的值則連線建立不起來。
- **OSPF 的 network 敘述**：持續生效，之後才設定 IP 的介面只要位址符合就自動加入。
- **DR / BDR**：priority 最高的當 DR（一樣就比 Router ID），priority 0 永遠不參加。DR 選出來之後不會被搶走：後來加入、條件更好的路由器只能當 DROTHER，要等 DR 不在了（BDR 先升上來）或 `clear ip ospf process` 才會重選。DROTHER 之間停在 2WAY 是正常的。
- **Router ID**：OSPF 程序啟動時決定（`router-id` > 最大的 Loopback > 最大的實體介面），之後改了位址或 router-id 都不會變，IOS 會提示要 `clear ip ospf process`。兩台 Router ID 一樣時鄰居建立不起來。
- **cost 與等價多路徑**：cost = 參考頻寬 ÷ 介面頻寬（預設參考頻寬 100 Mbps，所以 1G 和 10G 都是 1）；cost 一樣的路最多 4 條一起放進路由表，依來源與目的位址雜湊分散，同一條連線永遠走同一條路。
- **多區域**：ABR 把一個區域的網段用 Summary LSA 送進骨幹（`area range` 可以彙總成一筆），所有非骨幹區域都要接到 area 0；區域之間的路由是 O IA。`default-information originate` 送出的預設路由是 O*E2。
- **stub 與 NSSA**：stub 區域收不到 Type-5，ABR 改送一筆 O*IA 預設路由（cost 是 `area … default-cost`，預設 1）；ABR 加 `no-summary` 連區域間的路也不送。stub 區域裡重分配了也送不出去，要改成 NSSA：區域裡的 ASBR 送 Type-7（O N1 / N2），同一個網域裡 Router ID 最大的 NSSA ABR 轉成 Type-5，其他路由器往 forwarding address（原本的 ASBR）走。NSSA 不會自動送預設路由（`no-summary` 或 `default-information-originate`）。區域的種類寫在 Hello 裡，同一個區域每一台都要一樣，不然不會成為鄰居；骨幹不能是 stub / NSSA。
- **VRF 裡的 OSPF**：每個 VRF 要自己的程序（`router ospf 2 vrf A`），全域的 `router ospf 1` 不會涵蓋 VRF 的介面；VRF 的名稱只在那台路由器上有意義，PE 的 VRF 程序照樣和 CE 的全域程序成為鄰居，兩個 VRF 用一模一樣的網段也互不干擾。VRF 之間預設完全隔離，要洩漏就兩個方向各補一條靜態路由（`ip route vrf A … <下一站> global`、`ip route … <另一個 VRF 的介面> <下一站>`），再重分配給客戶。
- **EIGRP**：同一個 AS、K 值一樣、在同一個子網路、驗證一致才會成為鄰居（Hello / Hold time 不用一樣）。metric = 256 ×（10⁷ ÷ 路徑上最小的頻寬 kbps ＋ 延遲總和 ÷ 10 µs），`bandwidth` 與 `delay` 只影響計算、不會真的限速；延遲依介面的實體速率（GE 10 µs、FE 100 µs、Loopback 5000 µs）。FD 最小的是 successor，RD 比 FD 小的是 feasible successor；`variance` 讓 feasible successor 一起分擔。split horizon 預設開著，`ip summary-address eigrp` 在那個介面改送一筆彙總。內部路由 AD 90、重分配進來的 D EX 是 170。
- **RIP**：metric 是跳數（直連的網段送出去是 1，最多 15，16 是到不了），AD 120。`network` 只能寫有類別的主網段；沒有設 version 的 IOS 送 v1、收 v1 和 v2，`version 2` 只收 v2（介面上的 `ip rip send / receive version` 可以個別改）。RIPv1 不帶遮罩：同一個主網段只送和出去介面一樣遮罩的子網路，到別的主網段一律是有類別的網段；RIPv2 的 auto-summary 預設也開著，網段不連續時兩邊都會送同一筆有類別的網段。split horizon 不會把從某個介面學到的路（以及那個介面自己的網段）送回去。驗證只有 v2（text 或 MD5，用 key chain）。
- **無線控制器**：輕量型 AP 自己沒有設定，拿到 IP 之後依序用手動指定、DHCP option 43、同一個網段的廣播找控制器，CAPWAP（UDP 5246）通了約 25 秒後加入，SSID 由控制器下發。Local 模式的用戶端流量包在 CAPWAP 裡回到控制器才放進 VLAN（交換器在接控制器的埠學到用戶端的 MAC），所以員工 VLAN 要在控制器的 Trunk 上；FlexConnect 在 AP 的埠就地放進 VLAN，控制器斷線時本地交換的 WLAN 照樣服務 (standalone)。加入同一台控制器的 AP 由 RRM 自動錯開頻道。
- **牆面衰減**：每穿過一道牆就扣掉固定的 dB（石膏板 3 / 4、玻璃 2 / 3、磚 8 / 10、混凝土 12 / 15、金屬 25 / 30，前面是 2.4 GHz、後面是 5 GHz），5 GHz 穿牆更差。有牆的關卡把涵蓋圓圈換成訊號熱力圖；用戶端的面板會說明隔著哪些牆、少了幾 dB。
- **漫遊**：用戶端在目前的訊號還有 -75 dBm 以上時不會自己換基地台 (sticky client)；SSID 開了 802.11k/v，基地台會在別台好 8 dB 以上時建議它換過去。兩台基地台把同一個 SSID 放進不同的 VLAN，換基地台就換網段、IP 跟著變。任務裡有「拿著筆電走過去」的測試。
- **RA 的旗標與 DHCPv6**：前綴的 A 旗標允許 SLAAC、M 旗標要主機向 DHCPv6 要位址、O 旗標只要 DNS；M 與 A 同時開著，電腦會兩種位址各拿一個。DHCPv6 從來不給預設閘道，閘道一定來自 RA；主機收不到任何 RA 時還是會試 stateful DHCPv6（這是 Windows 的行為；一般的 Linux 要手動跑 `dhclient -6`），結果有位址卻出不了網段。路由器上 `show ipv6 dhcp binding` 查得到每台電腦的 DUID 與位址，電腦上 `nmcli device show eth0` 看得到 DUID 與 IAID。
- **OSPFv3**：直接在介面上啟用；鄰居用 link-local 位址認識彼此（兩端的全域前綴不一樣也能 FULL），路由的下一站也是 FE80:: 位址。Router ID 仍然是 32 位元：路由器上沒有任何 IPv4 位址時程序起不來（`%OSPFv3-4-NORTRID`），要手動設定。
- **NetFlow 與 police**：有開 NetFlow 的路由器把經過的背景流量（來源、目的、埠、進出介面、位元組）記進快取，15 秒沒有新封包就拿掉；匯出要真的送得到收集器的 UDP 埠。policy-map 的 `police cir <bps>` 會真的限制那一類流量（進來的 `service-policy input` 或出去的 `output`）：超過的丟掉，TCP 自己慢下來，背景流量的速率與瓶頸說明都看得到。
- **BFD 與 fast hello**：兩台路由器中間隔著交換器時，對面斷掉這一端的介面還是 up，OSPF 要等 Dead timer（40 秒）、BGP 要等 hold time（180 秒）。兩端都開 BFD、路由協定也指定用它，一秒內就把鄰居拿掉（偵測時間 = interval × multiplier，引擎的時鐘以秒為單位，最快算 1 秒）；只有一端開 BFD 時 session 起不來。`ip ospf dead-interval minimal hello-multiplier <n>` 讓 Dead timer 變成 1 秒。
- **GLBP**：AVG（優先權最高、和 HSRP 一樣選）回答虛擬 IP 的 ARP，依 round-robin 把不同 AVF 的虛擬 MAC 交給來問的主機（host-dependent 固定同一個）；每台 AVF 轉送送到自己虛擬 MAC 的封包。AVF 失聯時，它的虛擬 MAC 在 holdtime（10 秒）內沒有人轉送，之後由其他 AVF 接手，主機的 ARP 快取不用改。
- **AAAA 與雙協定**：有全域 IPv6 位址的電腦依 RFC 6724 優先用 AAAA；`ping` 不會改用 IPv4（AAAA 寫錯或 IPv6 不通就逾時），瀏覽器與 `curl` 用 Happy Eyeballs，IPv6 沒有回應就改用 IPv4（會通，但慢一點）。只有 IPv4 的電腦根本不問 AAAA。AAAA 也會進 DNS 快取（`resolvectl show-cache` 的 `IN AAAA`）。
- **IPv6 經過只有 IPv4 的網路**：GRE（協定 47）可以同時載 IPv4 與 IPv6；`tunnel mode ipv6ip`（6in4，協定 41，MTU 1480）只載 IPv6；`tunnel mode ipsec ipv4` 的 VTI 只載 IPv4（OSPFv3 的 Hello 也過不去）。OSPFv3 在 Tunnel 上用 link-local 建鄰居，預設 point-to-point、cost 1000。
- **IPv6 ACL**：和 IPv4 的 ACL 是兩套，IPv4 的 ACL 管不到 IPv6。結尾隱含 `permit icmp any any nd-na`、`nd-ns` 再 `deny ipv6 any any`；自己在最後寫了 `deny ipv6 any any`，鄰居探索就被擋掉，整個網段的 IPv6 都會斷。
- **BGP 的最佳路徑**：weight → local-preference → 自己發出的 → AS path 長短 → origin → MED（同一個鄰居 AS 才比）→ eBGP 比 iBGP 好 → 往下一站的 IGP metric → Router ID。下一站查不到 (inaccessible) 的路不能當最佳路徑。
- **iBGP**：可以隔好幾台路由器，通常用 Loopback 建立：沒有 `update-source` 時 TCP 179 從出口介面的位址送出，對方設定的鄰居對不上就停在 Active（只要一個方向對得上就起得來）。送給 iBGP 鄰居時 AS path 與下一站都不變，邊界路由器要 `next-hop-self`；從 iBGP 學到的路不轉送給其他 iBGP 鄰居，中間沒有 BGP 的路由器會變成黑洞，要全網狀或 route reflector（反射的路帶 Originator 與 Cluster list）。iBGP 的管理距離 200，比 OSPF 大；`redistribute bgp` 預設不包含 iBGP 的路。eBGP 的 TTL 是 1，用 Loopback 建立要 `ebgp-multihop`。community 要 `send-community` 才會送出去，`no-export` 不出 AS、`no-advertise` 不送任何人；沒有 `ip bgp-community new-format` 時 IOS 印成十進位。同時接兩家 ISP 時，從 ISP-A 學到的路如果沒有過濾就送給 ISP-B，ISP-B 會把往 ISP-A 的流量丟給你（ISP 偏好客戶給的路），公司就成了兩家 ISP 之間的轉運站。
- **Port Security**：maximum 預設 1，安全位址依序是設定的（靜態、sticky）、再來是先看到的 MAC；超過就是違規：protect 默默丟掉、restrict 丟掉並記紀錄與計次數、shutdown（預設）把埠關成 err-disabled。先打開 switchport port-security 再設 maximum，預設的 shutdown 可能已經把埠關掉了。
- **MAC 位址表的容量**：表滿了新的 MAC 學不進來，目的地不在表裡的訊框泛洪到整個 VLAN；MAC flooding 的攻擊工具送得到的每一台交換器都會被塞滿。擋住之後亂造的項目要等老化（300 秒）或 clear；學到它們的埠斷線時會立刻清掉。靜態的 MAC 不受影響。
- **雙重標籤**：Access 埠照收標籤剛好是自己 VLAN 的訊框；Trunk 送出 Native VLAN 時不加標籤，所以外層被拿掉後，裡面那層就被對面當真。只能單向（回覆回不去）。
- **管理存取**：FortiGate 每個介面各自決定開放 ping / HTTPS / SSH / SNMP / HTTP / Telnet。
- **故障模擬**：任何設備都可以關機，路由器的介面與交換器的連接埠可以 `shutdown`；錯誤訊息會指出是哪一台關機或哪個介面被停用。

## 模擬的範圍與簡化

- MAC 位址表會學習、過期與泛洪，但實際的轉送路徑仍然由拓撲算出，所以不會出現「表裡的項目指到錯的埠」這種狀況。
- 電腦與伺服器一律是 Linux（Ubuntu 風格的 bash、iproute2、NetworkManager、systemd-resolved），沒有 Windows 與 macOS 的主機。DHCP 要不到位址時主機會自己編一個 169.254.x.x（IPv4 link-local，Windows 叫 APIPA；一般的 Linux 要開 `ipv4.link-local` 才會這樣做）。`ping` 預設送 4 個就停（真的要按 Ctrl-C）。`nslookup`、`dig` 直接問伺服器（相當於 `/etc/resolv.conf` 指向真正的伺服器，而不是 127.0.0.53 的 stub）。
- 網際網路裡的那幾站（traceroute 的 100.64.x.x 與 `* * *`）是依目的位址固定算出來的，只是讓「不是一站就到」看得出來，不是真的路由；網際網路上的主機一律當成 TTL 從 64 開始。
- 只有 SSH / Telnet 是長時間保持的連線；ping、curl、iperf3 建立之後就結束了。
- 封包擷取記錄的是模擬裡真的跑過的訊框（測試、終端機指令、檔案傳輸、SNMP、背景的 BPDU、CDP、LLDP 與 DTP）；持續傳輸的背景流量、OSPF Hello、VRRP 通告只算進計數器，不會出現在擷取畫面上。檔案傳輸只記下開頭幾個封包，不會把 70 萬個 TFTP 區塊一個一個列出來。
- FortiGate 的 sniffer 與 debug flow 是在背景執行，輸入任何指令就會停止（相當於 Ctrl-C）。IOS 的 `debug` 做了 `ip packet`、`ip icmp`、`ip ospf adj / hello`、`ip dhcp server packet / events`、`crypto isakmp / ikev2 / ipsec`；OSPF 與 crypto 的 debug 只印「卡住的原因」與協商的關鍵步驟，不會把正常運作時的每一個 Hello、每一個 IKE 封包都列出來。
- 全域的 OSPF 程序固定是 `ospf 1`，每個 VRF 再各有一個程序；沒有虛擬連結 (virtual link)、Type-4 ASBR summary 的顯示與 NSSA 的 P-bit 選項；OSPFv3 沒有 stub / NSSA；`show ip ospf database` 是依計算結果整理的摘要，不是逐筆 LSA 的洪泛。
- BGP 只跑在全域的路由表（沒有 `address-family ipv4 vrf`、MP-BGP 與 route-target），community 只有 standard（沒有 expanded 與 extended），沒有 confederation、cluster-id、peer-group、BGP 的 `network` 對 IGP 路由沿用原本的下一站；網際網路的核心簡化成一個 AS 64999，ISP 對客戶路由的偏好簡化成 local-preference 200。
- NTP 只有一台伺服器、沒有驗證；設備的時鐘不會慢慢漂移（沒對時的誤差是固定的）。
- 背景流量之間用 max-min 公平分配近似 TCP 的行為，沒有模擬壅塞控制本身。佇列的延遲與遺失用「TCP 會把佇列塞滿」的穩態估計（平均約七成滿、遺失率隨流量條數增加），不是逐封包的模擬；營運商的管制 (policing) 也是用估計的遺失率。Hub 的碰撞只反映在速率打折上。
- QoS 只模擬路由器的 MQC 與 Catalyst 2960 的 `mls qos` 信任邊界；交換器自己的出口佇列（`srr-queue`）、WRED、NBAR 的完整協定庫、FortiGate 的流量整形都沒有做。Wi-Fi 的 WMM 也沒有。
- FortiGate 的安全設定檔只有網頁過濾（FortiGuard 類別，網站的類別是關卡設定的；沒有 URL 清單、評等覆寫、警告 / 驗證動作）與三種內建的 SSL 檢查（no-inspection、certificate-inspection、deep-inspection；沒有豁免清單與自訂設定檔）；應用程式控管依埠號或網址的主機名稱辨識少數幾個應用程式（BitTorrent、Tor、Facebook、YouTube、Steam），IPS 只有幾個代表性的攻擊特徵（Log4Shell、SQL injection、Shellshock）與依嚴重程度封鎖；DNS 過濾依 FortiGuard 類別把名稱換成 208.91.112.55（沒有 DoH 的偵測、安全搜尋與自訂網域清單），防毒只比對關卡放在網站上的病毒（EICAR 測試檔），沒有沙箱、郵件與檔案類型過濾。
- IOS 的 Zone-Based Firewall 只在路由器上（match protocol 認得常用的協定，用埠號判斷、沒有深層檢查）；沒有 parameter-map（逾時、半開連線上限）、沒有 L7 的 inspect 政策、沒有 zone 內的政策；GUI 只編輯「一個協定清單 + inspect / pass」的簡化政策。時間型 ACL、Reflexive ACL 還沒有。
- Console 線不畫在 3D 場景上，接上之後就是那台設備的命令列（沒有 line con 0 的密碼與 exec-timeout、沒有斷線的 BREAK 與密碼復原）；只有標成「在機房裡」的設備不能從面板直接設定，其他設備的 CLI 分頁也當成 Console。
- breakout 只有 Nexus 的 QSFP 埠（25g-4x、10g-4x）：分歧線在場景裡畫成四條獨立的線；沒有 40G 的 QSFP+ 與 Catalyst 的 breakout。
- 電源只有「每個 PSU 接哪一路」：沒有 PDU 的插座數與電流上限、UPS 的電池時間、功率預算以外的耗電計算；只有防火牆 FG-100F、Catalyst 9300、Nexus、9800 與機架伺服器有兩個電源槽。
- VTP 只有版本 1 / 2（沒有版本 3 的 primary server、沒有 VTP pruning）；同步是立即的；VTP 的設定和 server 的 VLAN 為了方便貼回而印在 running-config（真的 IOS 存在 vlan.dat，server / client 模式的 VLAN 不會出現在 running-config）。
- FortiGate 的 HA 只有兩台一組的 Active-Passive：heartbeat 要兩台直接對接（不能經過交換器）、換手是立即的（沒有 hello 計時與 GARP 的時間差）、沒有 Active-Active、虛擬叢集、管理介面 (ha-mgmt-interface) 與 `execute ha manage`；HA uptime 簡化成「本來就是主要機的那台」。
- SD-WAN 只有 FortiGate、一組效能 SLA（用 ping 量測）：線路品質是 ISP 線路的固定設定（不會隨時段變化），只影響效能 SLA 與語音的 MOS，不影響傳輸速率；規則只比對目的位址、協定與埠（沒有應用程式辨識與 Internet Service Database），也沒有依頻寬比例分配與 ADVPN。
- IP 電話只有 G.711；CUCM 只做註冊與分機（沒有撥號規則、語音信箱、會議）。通話的訊令（SIP）只用來判斷註冊，媒體 (RTP) 才走實際的路徑算品質。
- DTP 不模擬 VTP 網域不同造成的協商失敗，也不模擬經過非網管交換器的 DTP。雙重標籤 (double tagging) 的 VLAN hopping 只在觀念題出現。
- 遠端存取的 SSL-VPN 沒有連線建立的時間。
- STP 以每個 VLAN 各算一棵樹的方式近似 Rapid PVST+，只處理交換器直接相連的情況；非網管交換器形成迴圈會被判定為廣播風暴。Loop Guard 用「BPDU 正常的話這個埠應該是什麼角色」判斷，沒有模擬 BPDU 逐漸消失的過程（max age）。邊緣埠用的是傳統的 30 秒計時（和 Cisco 預設的 PVST+ 一樣）。
- DNS 查詢優先經由 IPv4 送到 DNS 伺服器（只有 IPv6 的主機改用 DHCPv6 告知的 IPv6 DNS 伺服器）；網際網路（ISP）的 IPv6 只在關卡設定的線路上有（鏈路的 RA 與 DHCPv6 Prefix Delegation，沒有 IA_NA 與 DHCPv6 的 DNS 選項）；IOS 的 PD 立刻拿到前綴（沒有 Solicit / Advertise 的計時與續約）；NAT64 只有 IOS XE 的 stateful 加 overload（沒有 stateless、靜態對應、v4v6 方向、FortiGate 的 NAT64 / NAT46、主機上的 464XLAT），DNS64 在 DNS 伺服器的分頁開（沒有 exclude 清單與 RA 的 PREF64 選項）。IPsec 有 IKEv1 與 IKEv2；IKEv1 只用預先共用金鑰，IKEv2 可以用預先共用金鑰或 IOS 之間的憑證 (rsa-sig)，沒有 EAP、ECDSA、FortiGate 的憑證與 `match certificate`；CA 自動核發（沒有人工核准、撤銷與 OCSP）；IOS 的 IKEv2 smart defaults 簡化成 AES-CBC-128/256、SHA-1/256、DH 2/5/14/19 的組合。Tunnel 介面只有 IOS 路由器有（沒有 FortiGate 的 IPsec 介面模式、L3 交換器的 Tunnel、GRE over IPv6、tunnel vrf）；OSPF 沒有 point-to-multipoint；NHRP 的註冊與解析是即時的（沒有計時重送），NHRP 項目到 holdtime 才過期；DMVPN 不能放在 NAT 後面、沒有 IPv6 的 NHRP；NAT-T 的 NAT 對應一直保留（不模擬 NAT keepalive 與轉換逾時）。圖形介面建立的 FortiGate 通道會自動帶出通往對端的路由（相當於用精靈建立）。SSL-VPN 的加密流量在引擎內部仍然當成一層封裝來處理。
- Wi-Fi 的訊號依距離估算再扣掉沿路穿過的牆，沒有反射、多路徑與樓層；牆只能由關卡預先放好，自由模式還不能畫牆。漫遊中斷的時間是估計值（有沒有開 802.11r 差很多），不是逐封包量出來的。無線控制器沒有 DNS 探索、DTLS、映像檔下載、AP group / tag 與跨控制器漫遊 (Mobility Group)，只能用圖形介面設定。
- 802.1X 有帳號密碼與電腦憑證（EAP-TLS）兩種；憑證只檢查由誰簽發與有效期間。
- 路由重分配有 OSPF、EIGRP、BGP 之間，以及靜態與直連；重分配進 EIGRP 不能套 route-map 與 tag，兩個地方雙向重分配造成的路由迴圈沒有模擬（每次重算都會收斂成同一個結果）；EIGRP 還不能重分配 RIP 的路。
- RIP 沒有 RIPng (IPv6)、`offset-list`、`distribute-list`、`neighbor`（單點傳送更新）與 `validate-update-source` 的開關；設定改了路馬上學到（沒有 30 秒週期造成的等待），只有失聯要等 invalid / flush。
- 傳統的 inside / outside NAT 不處理 hairpin（內部連靜態 NAT 的公用位址不通），要改用 NVI（`ip nat enable`）或 split DNS；FortiGate 的 VIP 也還不能套用在內部介面上做 hairpin。
- EIGRP 只有傳統模式（`router eigrp <AS>`）：一台只跑一個程序、只在全域的路由表，沒有 named mode、stub、`distribute-list`、`offset-list` 與 EIGRP for IPv6；DUAL 的 Query / Reply 沒有時間（沒有 feasible successor 的路一樣立刻換過去，不會 Stuck-in-Active），可靠度與負載固定是 255 與 1；彙總不會在本機加一條往 Null0 的路。政策路由只有 `set ip next-hop` 與 `set ip default next-hop`（沒有 `set interface`、`verify-availability` 搭配 track），FortiGate 的政策路由還沒有做。
- MTU：TCP 用一個裝滿的資料區段代表一次大量傳輸，PMTUD 的結果不會被記住（每次連線都重新發現）；IPsec 的額外負擔固定算 73 位元組（實際依加密演算法與填充大約 50 – 73），SSL-VPN 與雲端的 VPN 沒有算；FortiGate 的介面 MTU 與 `tcp-mss` 還不能改。
- HTTPS 只模擬憑證驗證的結果（信任的 CA、中繼憑證鏈、有效期間、SAN、撤銷）與 Let's Encrypt 的續約：沒有 TLS 版本與加密套件的協商；「瀏覽器」只存在於任務的目標裡（它會自己補中繼憑證、查撤銷），終端機只有 curl。網頁內容只有標題。
- VRF 只有 VRF-Lite：介面、直連與靜態路由、每個 VRF 自己的 OSPF 程序、用靜態路由的路由洩漏、`show`、`ping vrf`；BGP 還不分 VRF，沒有 route-target 的匯入匯出、`route-replicate` 與 MPLS VPN。
- Docker 只有預設的 bridge 網路與 `-p` 發佈：沒有自訂網路與容器之間用名稱互連、host / macvlan 網路、Compose、volume；映像檔只有幾個常見的（nginx、httpd、grafana、mysql、postgres、redis、portainer），`docker run` 的 `-e`、`-v`、`--restart` 會接受但沒有作用。
- IPv6 有 SLAAC、DHCPv6（stateless / stateful、relay、Prefix Delegation 的用戶端）、靜態路由、OSPFv3（沒有 IPsec 驗證與 area range）、IOS 的 IPv6 ACL、FortiGate 的 IPv6 政策與前綴委派（介面只有 static、dhcp、delegated 三種模式；沒有 IPv6 的位址物件，政策直接寫 all 或網段；IPv6 不做 NAT）、IOS XE 的 stateful NAT64 與 DNS64。主機的 SLAAC 位址用 EUI-64（現在的 Linux 與 Windows 預設其實是穩定的隨機介面識別碼，再加上暫時位址）。
- 兩種 CLI 都只涵蓋這個遊戲有模擬的功能。
- Nexus 也用 IOS 風格的 CLI 操作。FortiOS 的升級路徑簡化成「同一個主版本、次版本一次最多跳兩版」。
- 檔案傳輸有 TFTP、FTP 與 SCP，沒有 SFTP。
- RESTCONF 只有介面、主機名稱、VLAN 與靜態路由幾個 YANG 路徑，內容只接受 JSON；NETCONF 只有 running 資料庫，沒有 gNMI；Catalyst Center 的 API 只能讀取（設備清單、問題清單），範本只能在圖形介面部署（Velocity 只有變數，沒有 #if / #foreach），沒有 SD-Access。Ansible 沒有 roles、handlers、host_vars 檔案與 Vault，Jinja 只有變數與幾個常用的 filter。雲端沒有 Direct Connect，VPN 只有一條通道（AWS 實際上給兩條），EC2 由關卡建立；Terraform 只支援 aws_security_group（inline 規則），沒有變數、模組、遠端 backend 與 state lock。
- 故障演練的故障只從固定的種類裡挑（沒有 IPv6、無線控制器與 BGP 的故障），只有 IPv6 的關卡挑不到故障。模擬考的題目來自題庫，題型只有單選；Network+ 的領域是依 CCNA 條目對照的近似。評分的標準時間是依目標數估計的，不是每一關各自訂的。
- SNMP 只回答系統資訊與介面表（名稱、速率、狀態、位元組與錯誤計數器），沒有 MIB 瀏覽器、`snmpwalk` 與 SET；Trap 只有 linkUp、linkDown、coldStart、authenticationFailure。

- **DoS**：只有 SYN flood 有效果（目的主機那個埠的新連線全部排不進去；真實的情況是大部分逾時、偶爾連得上）。DoS 政策超過門檻、動作是 block 時，攻擊流量整個被丟掉、正常的連線不受影響（真實的 FortiGate 丟的是超過門檻的那一部分，也可能丟到正常的 SYN，所以另外有 proxy 的動作；這裡把 proxy 當成 block）。防火牆的連線表只顯示被佔了幾筆，滿了也不會影響其他流量。伺服器的 SYN cookie、把線路頻寬灌滿的流量型攻擊都沒有模擬。

## 還可以做的

完整的功能規劃（每個領域已完成、部分完成、尚未開始的項目，以及建議的實作順序）在 [PLAN.md](PLAN.md)。以下是最接近的幾項：

1. VXLAN / EVPN 的實作關卡（現在只有知識庫的文章與題目；引擎還沒有 VTEP 的封裝）。
2. DoS 的其他型態：把線路灌滿的流量型攻擊（UDP / ICMP flood 現在只能設定、沒有效果）、伺服器自己的 SYN cookie、連線表滿了之後對其他流量的影響。
3. Wi-Fi 的空中時間：遠處的低速用戶端拖慢整台基地台、最低資料速率（同頻干擾與頻道寬度已經在 5-4）。
4. FortiGate HA 的 Active-Active、OSPF point-to-multipoint、OCSP。

遊戲系統（成就、預算與採購、名詞表、帳號與雲端存檔、多人）暫時不做；手機與平板、多語系、無障礙、淺色主題不在規劃內。

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
  ospf.js         OSPF：Router ID、Hello / Dead、DR / BDR 選舉、驗證與 MTU、SPF、多區域與 ABR、stub / NSSA 與 Type-7 的轉換、外部路由、等價多路徑；VRF 的程序是各自的節點
  bgp.js          BGP：TCP 179 的鄰居狀態、hold time、eBGP 與 iBGP（update-source、next-hop-self、split horizon、route reflector、ebgp-multihop）、路徑向量與迴圈偵測、最佳路徑、遞迴查下一站、route-map / prefix-list / as-path ACL / community
  qos.js          QoS：標記與信任邊界、class-map / policy-map 的分類、出口佇列、整形與營運商的管制
  voice.js        IP 電話的開機與註冊、CUCM、通話品質（E-model / MOS）
  wire.js         線路上的訊框：介面計數器、封包擷取、SPAN、IOS debug、FortiGate sniffer 與 debug flow
  debug.js        IOS 的 debug ip ospf、debug ip dhcp server、debug crypto isakmp / ikev2 / ipsec 的輸出
  pki.js          IOS 的 PKI：trustpoint、CA 的根憑證與核發、用設備自己的時鐘驗證憑證
  sim.js          對外的入口：重新計算 (recompute)、模擬時鐘（advance / settle / pendingOf），並匯出 sim/ 底下各模組公開的函式。
  script.js       關卡劇本的排程事件（幾秒後線路斷掉、修好、背景流量開始或停止）
                  其他程式一律 import sim.js，不直接 import sim/ 裡面的檔案
  sim/core.js       共用的小工具：VRF、MAC、雜湊、時間格式、連線紀錄與命中次數
  sim/phys.js       供電與連線、err-disabled、DTP、語音 VLAN、LACP、STP 與連接埠的 STP 計時
  sim/l2.js         VLAN 與 Trunk 的標籤、廣播網域的探索、MAC 位址表、ARP 快取
  sim/wifi.js       Wi-Fi：加密、涵蓋範圍與牆面衰減、無線控制器與輕量型 AP
  sim/l3.js         DHCP 租約與 Relay、VRRP / HSRP、路由表與最長相符、DHCP 的 DORA 動畫
  sim/tunnels.js    VPN：IKE 的兩個階段、提案與金鑰、SA 的壽命與 DPD、NAT-T、tunnel protection 的 SA、封包走哪一條通道
  sim/gre.js        Tunnel 介面：GRE / mGRE / VTI 的 line protocol、keepalive、recursive routing、NHRP 的註冊、解析與 phase 3 捷徑
  sim/auth.js       802.1X / RADIUS、Dynamic ARP Inspection
  sim/forward.js    逐站轉送：服務、ACL、NAT、防火牆政策、交給本機的服務、MTU、連線表
  sim/transact.js   一次請求 + 回應：TCP 交握、資料區段與 PMTUD、長時間保持的連線
  sim/resolve.js    名稱解析（DNS 查詢、用戶端快取、CNAME）
  sim/objectives.js 任務目標的檢查
  sim/bandwidth.js  每段線路的速率、背景流量的分配、傳輸速率 (throughput)
  dnac.js         Catalyst Center：Token、設備清單（SNMP / SSH 輪詢）、Assurance 的問題清單
  restconf.js     RESTCONF：YANG 路徑、HTTP 方法與狀態碼、JSON / XML
  yaml.js         YAML 解析（PyYAML 風格的錯誤訊息）
  automation.js   Ansible：inventory、Jinja 變數、network_cli 與 cisco.ios 模組、PLAY RECAP
  cloud.js        公有雲的 VPC：子網路與路由表、IGW 與彈性 IP、NAT 閘道、安全群組、網路 ACL、VPN 設定檔
  faults.js       故障演練：可能的故障清單、在副本上驗證、依種子重現
  dos.js          DoS：SYN flood（state.attacks）打不打得到、FortiGate 的 DoS 政策（進來的介面、pass / block、門檻）、異常紀錄、config firewall DoS-policy
  ask.js          觀察題（type: 'ask' 的任務目標）：答案的比對（MAC、IP、埠名、數字的正規化）、選錯時的說明、複選
  l2sec.js        第二層安全：Port Security 的安全位址與違規、MAC 位址表的容量與 MAC flooding、靜態 MAC、Storm Control 的門檻、RA Guard
  policy.js       路由政策：prefix-list、route-map 套在路由上（重分配進 OSPF / BGP 時的比對與 set）
  mtu.js          MTU：每個介面的 IP MTU、交換器能收的訊框、IPsec 的額外負擔、TCP MSS 的調整
  virt.js         虛擬化主機：vSwitch、連接埠群組與 VLAN 標籤、NIC teaming
  ltm.js          負載平衡器：virtual server、pool、健康檢查、SNAT Automap
  stack.js        交換器堆疊：成員、Active / Standby、成員故障
  mesh.js         Wi-Fi mesh：Root / Mesh 基地台、無線回程、無線橋接
  vpc.js          Nexus 的 vPC：peer-link、peer-keepalive、角色、一致性檢查
  junos.js        Juniper 的 Junos：候選設定、commit、套用到交換器
  mplsvpn.js      業者的 MPLS L3VPN：VPNv4 路由、route reflector 的反射、route-target 匯入（含同一台 PE 上的 VRF 之間）、LDP 鄰居
  patch.js        配線架：前後同一孔相通、端對端的連線
  rack.js         機櫃：設備裝在第幾 U、放不放得下、UPS 放下面、PDU 的負載
  (ui/roscli.js)  MikroTik RouterOS 的終端機
  (ui/cxcli.js)   Aruba AOS-CX 的 CLI
  docker.js       容器：映像檔、bridge 網路、連接埠發佈（只綁 127.0.0.1、埠對錯會被重設）
  web.js          網站與 HTTPS 憑證：信任的 CA、有效期間（用戶端的時鐘）、SAN 與萬用字元
  dns.js          DNS 伺服器的記錄、TTL 與用戶端快取
  sim6.js         IPv6：SLAAC 與 DHCPv6（RA 的 M / O / A 旗標、relay、binding）、鄰居探索、靜態路由與 OSPFv3、IPv6 ACL、ICMPv6 / TCP / UDP
src/levels/   關卡定義：設備、初始設定、任務目標、提示、參考解法（trouble.js 是故障排除章，maint.js 是維運章，voip.js 是語音與 QoS 章，routing.js 是進階路由章，ipv6.js 是 IPv6 章的補充，vpn2.js 是多站台 VPN，wireless.js 是無線控制器章，auto.js 是自動化章，cloud.js 是雲端章，virtual.js 是虛擬化章（vSwitch、VRF、容器），team.js 是 ESXi 的 NIC teaming，lb.js 是負載平衡器，stack.js 是交換器堆疊，mesh.js 是 Wi-Fi mesh，vpc.js 是 Nexus 的 vPC，tls.js 是 HTTPS 憑證，mtu.js 是 Jumbo Frame 與 PMTUD，redist.js 是路由重分配與政策路由，routing2.js 是 OSPF 的 stub / NSSA、iBGP、VRF 裡的 OSPF 與路由洩漏，tunnels.js 是 GRE、GRE over IPsec、VTI、DMVPN 與 NAT-T，ipv6b.js 是 AAAA 與雙協定、IPv6 經過 VPN，ha.js 是 BFD 與 GLBP，ops2.js 是 NetFlow 與 police，l2sec.js 是第二層的攻擊與防護（MAC flooding、雙重標籤、Storm Control、Private VLAN、RA Guard），resil.js / audit.js / trouble2.js 是各章的補充關卡，labs.js 是第 18 章封包實驗室（觀察題），dnsfwd.js 是 DNS 轉送器，expert.js 是第 19 章進階實作，expert2.js 是第 20 章的多工單情境）
src/data/     題庫、證照對照表、學習路線 (paths.js) 與知識庫（data/kb：每一類一個檔案，more.js 是跨分類的補充，match.js 是名詞連結與搜尋）
src/scene/    three.js 場景、設備模型、網路線、無線涵蓋範圍與封包動畫
src/ui/       設定面板、終端機、CLI、任務面板、測驗、模擬考、故障演練、評分、自由模式與關卡編輯器、對話框；levels-menu.js 是關卡選單（章節導覽、搜尋、學習路線），devicons.js 是 2D 拓撲圖與 3D 標籤共用的設備圖示，topo2d.js 是 2D 拓撲圖
test/         對每個關卡套用參考解法，並用負面案例確認引擎真的會擋
e2e/          Playwright 瀏覽器端測試（用已安裝的 Chrome）
```

新增關卡：在 `src/levels/` 的 `LEVELS` 加一筆，寫好 `setup()`、`objectives` 與 `solve()`（觀察題的 `solve()` 要把答案填進 `s.answers`），
在 `src/data/certs.js` 補上對應的考試條目，再跑 `npm test`。
