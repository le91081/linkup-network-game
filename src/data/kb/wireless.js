// 知識庫：無線網路
export const WIRELESS = [
  {
    id: 'wifi-basics', t: 'SSID、頻段與頻道', en: 'SSID / band / channel', cat: 'wireless', keys: ['SSID', '2.4 GHz', '5 GHz', '同頻干擾', '多重 SSID', 'Wi-Fi 頻道'], tags: ['Wi-Fi', 'SSID', 'AP', '頻道', '多重 SSID', '干擾'],
    sum: 'SSID 是無線網路的名稱；AP 在某個頻段的某個頻道上廣播。附近的 AP 用同一個頻道會互相干擾，要錯開。',
    body: [
      '2.4 GHz 傳得遠、穿牆好，但只有 3 個互不重疊的頻道（1、6、11），干擾多；5 GHz 頻道多、速度快，但穿牆差；6 GHz（Wi-Fi 6E / 7）頻道最多、只支援 WPA3。',
      '同一台 AP 可以同時廣播好幾個 SSID，每個對應一個 VLAN（員工、訪客、IoT），AP 接交換器的埠要是 Trunk。SSID 太多會浪費空中時間（每個都要定期送 beacon）。',
    ],
    fig: { type: 'table', head: ['頻段', '互不重疊的頻道', '特性'], rows: [['2.4 GHz', '1、6、11', '遠、穿牆好、干擾多、慢'], ['5 GHz', '20 幾個（含 DFS）', '快、頻道多、穿牆差'], ['6 GHz', '59 個（20 MHz）', '最乾淨，只能 WPA3']] },
    pit: ['相鄰的 AP 都用 2.4 GHz 的頻道 1：互相干擾，訊號滿格卻很慢。', '訪客 SSID 對應到員工的 VLAN。'],
    see: ['channel-width', 'rssi', 'wifi-security', 'wlc'],
  },
  {
    id: 'wifi-security', t: 'WPA2 與 WPA3', en: 'WPA2 / WPA3', cat: 'wireless', keys: ['WPA2', 'WPA3', 'WPA2-Personal', 'WPA3-Personal', 'SAE', 'PSK 密碼', '訪客隔離', 'WPA2 / WPA3'], tags: ['WPA2 / WPA3', 'WPA3', 'WPA2', '相容性', '訪客隔離'],
    sum: 'Personal 是大家共用一組密碼（WPA2 的 PSK、WPA3 的 SAE）；Enterprise 每個人用自己的帳號或憑證經過 802.1X 驗證。WPA3 擋得住離線猜密碼。',
    body: [
      'WPA2-Personal 的密碼被錄下交握封包後可以離線暴力破解；WPA3 的 SAE 不行，還有 PMF（保護管理訊框）。舊設備不支援 WPA3 時用 WPA2 / WPA3 混合模式過渡。',
      '訪客網路要開「用戶端隔離」，訪客彼此看不到；並用 VLAN 與防火牆政策隔開公司內網。',
    ],
    see: ['dot1x', 'wifi-basics', 'captive-portal'],
  },
  {
    id: 'channel-width', t: '頻道寬度與 DFS', en: 'Channel width / DFS', cat: 'wireless', keys: ['頻道寬度', 'DFS', '80 MHz', '40 MHz', '雷達'], tags: ['頻道寬度', '80 MHz', 'DFS', 'Wi-Fi 6E', '6 GHz'],
    sum: '把好幾個 20 MHz 頻道合起來用，速度加倍，但能錯開的頻道變少；DFS 頻道和氣象雷達共用，偵測到雷達時 AP 必須換頻道、暫停服務。',
    body: ['AP 很密的辦公室用 20 / 40 MHz 比較好錯開，用 80 MHz 會互相干擾。DFS 頻道（5 GHz 的 52–144）切換前要先監聽一段時間（CAC），用戶會斷線一陣子；不想被打斷就避開 DFS 頻道。'],
    see: ['wifi-basics', 'rssi'],
  },
  {
    id: 'rssi', t: '訊號強度與牆面衰減', en: 'RSSI / SNR / attenuation', cat: 'wireless', keys: ['RSSI', 'SNR', 'dBm', '訊號強度', '牆面衰減', '訊號量測', '熱圖'], tags: ['RSSI', 'RF', '牆面衰減', 'RRM'],
    sum: '收到的訊號強度用 dBm 表示（負數，越接近 0 越強）：-67 dBm 以上可以順利講電話、看視訊，-80 以下就很難連上。每穿過一道牆都會掉幾 dB。',
    body: [
      'dBm 是對數：每少 3 dB 功率就剩一半、少 10 dB 剩十分之一。石膏板隔間掉 3–4 dB、磚牆約 10、混凝土 12–15、金屬（電梯、機櫃）更多，而且 5 GHz 掉得比 2.4 GHz 多。',
      'SNR 是訊號比雜訊高多少（越大越好，25 dB 以上比較理想）。規劃時用現場量測（site survey）或熱圖找出死角，AP 的位置比功率開多大更重要。',
    ],
    fig: { type: 'table', head: ['RSSI', '品質', '適合'], rows: [['≥ −60 dBm', '很好', '所有應用'], ['≥ −67 dBm', '好', '語音、視訊'], ['≥ −75 dBm', '普通', '一般上網'], ['≥ −80 dBm', '很弱', '時連時斷'], ['< −80 dBm', '收不到', '—']] },
    see: ['wifi-basics', 'roaming', 'channel-width'],
  },
  {
    id: 'roaming', t: '漫遊', en: 'Roaming (802.11k/v/r)', cat: 'wireless', keys: ['漫遊', '802.11r', '802.11k', '802.11v', '802.11k/v', 'Fast Transition', 'Sticky Client'], tags: ['漫遊', '802.11k/v', '802.11r', 'Sticky Client'],
    sum: '走動時從一台 AP 換到另一台：決定什麼時候換的是用戶端。802.11k 提供鄰近 AP 清單、802.11v 建議它換，802.11r 讓換的時候金鑰交換更快（語音不中斷）。',
    body: ['Sticky Client：用戶端死守著訊號越來越弱的舊 AP，不肯換到旁邊比較好的那台。AP 功率開太大會讓這個問題更嚴重（離很遠都還「收得到」）。'],
    see: ['rssi', 'wlc'],
  },
  {
    id: 'wlc', t: '無線控制器與 CAPWAP', en: 'WLC / CAPWAP / lightweight AP', cat: 'wireless', keys: ['WLC', '無線控制器', 'CAPWAP', 'FlexConnect', '輕量型 AP', 'Lightweight AP', 'option 43', 'N+1'], tags: ['WLC', 'CAPWAP', 'Lightweight AP', 'option 43', 'FlexConnect', 'N+1', '控制器式網路'],
    sum: '輕量型 AP 自己沒有設定：開機拿到 IP 後找到無線控制器，用 CAPWAP 隧道加入，控制器把 SSID、頻道、功率推給它，所有 AP 集中管理。',
    body: [
      'AP 找控制器的方法：手動指定、DHCP option 43、DNS（CISCO-CAPWAP-CONTROLLER）、同一個網段的廣播。CAPWAP 走 UDP 5246 / 5247。',
      'Local 模式：用戶的流量包在 CAPWAP 裡回到控制器，再放進 VLAN；FlexConnect：流量在 AP 那裡就地放進 VLAN（分公司不用繞回總部），控制器斷線時本地的 SSID 照樣服務。N+1 是多一台備援控制器。',
    ],
    see: ['wifi-basics', 'dhcp', 'roaming'],
  },
  {
    id: 'captive-portal', t: '訪客入口網頁', en: 'Captive portal / Web Auth', cat: 'wireless', keys: ['Captive Portal', '入口網頁', 'Web Auth', 'pre-auth ACL'], tags: ['Captive Portal', 'Web Auth', '訪客 Wi-Fi', 'pre-auth ACL'],
    sum: '訪客連上 Wi-Fi 後，打開任何網頁都先被導到登入或同意條款的頁面，通過之後才能上網。',
    body: ['登入之前只開放必要的流量（pre-auth ACL）：DHCP、DNS 與入口網頁本身。DNS 沒放行的話，瀏覽器連網址都查不到，也就不會被導到入口網頁。'],
    see: ['wifi-security', 'acl'],
  },
  {
    id: 'mesh', t: 'Wi-Fi Mesh', en: 'Wireless mesh / backhaul', cat: 'wireless', keys: ['Mesh', 'mesh', '無線回程', '無線橋接'], tags: ['Mesh', '無線回程', '無線橋接'],
    sum: '拉不到網路線的地方，用 AP 之間的無線連線（回程）把網路延伸過去：Root AP 接有線網路，Mesh AP 透過無線接回 Root。',
    body: ['回程也佔用空中時間：每多一跳速度大約減半。回程最好用 5 GHz 的乾淨頻道、兩台之間訊號要夠強；兩台 AP 的 mesh 金鑰（bridge group）要一樣才會連上。'],
    see: ['rssi', 'channel-width'],
  },
];
