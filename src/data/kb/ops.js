// 知識庫：高可用與維運
export const OPS = [
  {
    id: 'troubleshooting', t: '故障排除的方法', en: 'Troubleshooting methodology', cat: 'ops', keys: ['故障排除', '封包追蹤'], tags: ['故障排除', '除錯', 'show 指令'],
    sum: '先確定症狀與範圍，再一層一層縮小：從實體層往上、或從中間（ping 閘道）切一半，每次只改一個地方並重新測試。',
    body: [
      '問對問題：誰不通（一台、一個網段、全部）？到哪裡不通（同網段、閘道、外面）？什麼時候開始的、最近改了什麼？',
      '在這個遊戲裡，「封包追蹤」會一站一站列出封包走到哪裡、在哪裡被丟掉、原因是什麼；通常從最後一站往回看就找得到問題。',
    ],
    steps: { t: '由下往上的檢查清單', items: ['實體層：線有沒有接、有沒有燈號、速率雙工、錯誤計數器。', '第二層：VLAN 對不對、Trunk 有沒有放行、STP 有沒有擋、MAC / ARP 學不學得到。', '第三層：IP / 遮罩 / 閘道、路由表（去程與回程）、ACL。', '第四層以上：連接埠、防火牆政策、NAT、服務本身有沒有在跑、DNS。'] },
    see: ['osi', 'icmp', 'crc'],
  },
  {
    id: 'oob', t: '帶外管理與 Console', en: 'Out-of-band management / console', cat: 'ops', keys: ['帶外管理', 'Console', 'Console 線', 'mgmt0', 'Mgmt-vrf', 'source-interface'], tags: ['帶外管理', 'Console', 'mgmt0', 'Mgmt-vrf', 'source-interface'],
    sum: '用一條和正式流量分開的路管理設備：專用的管理埠（放在獨立的 VRF）或 Console 線。正式網路壞了、設定改錯了，還是登得進去。',
    body: [
      'Console 是序列埠（預設 9600 8N1），速率設錯就是亂碼。管理埠通常在獨立的 VRF（Catalyst 的 Mgmt-vrf、Nexus 的 vrf management），所以設備自己送 Syslog、NTP、TFTP 時要指定從管理 VRF（或 source-interface）送，不然照全域的路由表走。',
    ],
    cmd: [{ v: 'Cisco IOS', c: ['ip route vrf Mgmt-vrf 0.0.0.0 0.0.0.0 10.0.99.1', 'logging host 10.0.99.5 vrf Mgmt-vrf', 'ip tftp source-interface GigabitEthernet0/0'] }, { v: 'NX-OS', c: ['vrf context management', ' ip route 0.0.0.0/0 10.0.99.1', 'logging server 10.0.99.5 6 use-vrf management'] }],
    see: ['vrf', 'hardening'],
  },
  {
    id: 'config-mgmt', t: '設定的存檔與備份', en: 'running-config / startup-config / backup', cat: 'ops', keys: ['running-config', 'startup-config', 'write memory', 'copy running-config', '設定備份', 'archive', 'configure replace', 'TFTP', 'commit'], tags: ['write memory', '設定備份', 'copy', 'TFTP', 'FTP', 'archive', 'archive log config', 'configure replace', '組態管理', 'Git', '版本控制', 'diff', 'commit'],
    sum: 'IOS 改的設定先在 running-config（記憶體），重開機就消失；write memory 才存進 startup-config。定期把設定備份到伺服器，改壞了可以比對、回復。',
    body: [
      'archive 可以在每次存檔時自動備份、記錄是誰改了什麼（archive log config）；configure replace 用備份整份換回來（只改有差異的部分）。Junos 則是候選設定 + commit / rollback，沒 commit 的不會生效。',
      '把設定放進 Git：每次變更都有紀錄、看得到差異（diff）、可以回到任何一個版本。',
    ],
    pit: ['改完沒存檔，停電或重開機後全部回到舊的設定。'],
    cmd: [{ v: 'Cisco IOS', c: ['copy running-config startup-config', 'copy running-config tftp://10.0.99.5/r1.cfg', 'archive', ' path flash:archive/r1-', ' write-memory', 'configure replace flash:archive/r1-3 list'] }],
    see: ['firmware', 'oob'],
  },
  {
    id: 'firmware', t: '韌體升級與 ROMMON', en: 'Firmware upgrade / ROMMON', cat: 'ops', keys: ['韌體升級', 'ROMMON', 'boot system', 'install 模式', 'packages.conf'], tags: ['韌體升級', 'boot system', 'install 模式', 'packages.conf'],
    sum: '升級前先確認新的映像檔放進 flash、空間夠、MD5 對；boot system 指到新的檔案（或 install 模式的 packages.conf），存檔後再重開機。',
    body: ['開機找不到可以開的映像檔，就會停在 ROMMON（rommon 1 >）：要用 Console 手動指定檔案開機，或用 TFTP 傳一個進來。升級要排在維護時段，先備份設定。'],
    cmd: [{ v: 'Cisco IOS', c: ['copy tftp://10.0.99.5/new.bin flash:', 'verify /md5 flash:new.bin', 'boot system flash:new.bin', 'write memory', 'reload'] }],
    see: ['config-mgmt', 'oob'],
  },
  {
    id: 'ha-fw', t: '防火牆 HA', en: 'Firewall high availability (FGCP)', cat: 'ops', keys: ['HA', 'FGCP', 'session-pickup', '主備'], tags: ['HA', 'FGCP', '高可用', 'session-pickup'],
    sum: '兩台防火牆組成一組：主要機處理流量、次要機同步設定待命；主要機掛了或監控的介面斷了，次要機接手（虛擬 MAC 跟著搬過去，交換器不用重新學）。',
    body: ['兩台之間要有 heartbeat 線；group 名稱、密碼、型號與韌體要一樣。開了 session-pickup，連線表也會同步，切換時既有的連線不會斷。'],
    see: ['fhrp', 'ups'],
  },
];
