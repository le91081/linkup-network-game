// 知識庫：自動化、雲端與虛擬化
export const CLOUD = [
  {
    id: 'restconf', t: 'REST API 與 RESTCONF', en: 'REST API / RESTCONF / YANG', cat: 'cloud', keys: ['RESTCONF', 'REST API', 'YANG', 'JSON'], tags: ['RESTCONF', 'YANG', 'REST API', 'JSON', 'curl', 'Token'],
    sum: '用 HTTPS 的 GET / PUT / PATCH / DELETE 讀寫設備的設定；資料的結構由 YANG 模型定義，內容用 JSON（或 XML）表示。',
    body: [
      'GET 讀取、POST 新增、PUT 整個取代、PATCH 只改指定的欄位、DELETE 刪除。回應碼：200 / 201 / 204 成功，401 沒有驗證，404 路徑錯了，409 已經存在，400 格式錯了。',
      'RESTCONF 的網址就是 YANG 模型的路徑（/restconf/data/ietf-interfaces:interfaces/interface=Gi1）。只能走 HTTPS，通常用 HTTP Basic 或 token 驗證。',
    ],
    fig: { type: 'table', head: ['動作', '意思', '成功時'], rows: [['GET', '讀取', '200'], ['POST', '新增（已經有了就 409）', '201'], ['PUT', '整個取代', '200 / 204'], ['PATCH', '合併修改', '204'], ['DELETE', '刪除', '204']] },
    see: ['netconf', 'ansible', 'sdn'],
  },
  {
    id: 'netconf', t: 'NETCONF', en: 'NETCONF', cat: 'cloud', keys: ['NETCONF'], tags: ['NETCONF', 'XML'],
    sum: '走 SSH（TCP 830）、用 XML 的網路設定協定：和 RESTCONF 一樣用 YANG 模型，但多了候選設定、鎖定與一次性的交易（全部成功或全部不改）。',
    body: ['edit-config 改候選設定、commit 一次生效；lock 防止別人同時改。適合需要「一批設定要嘛全部套用、要嘛全部不套用」的自動化。'],
    see: ['restconf', 'config-mgmt'],
  },
  {
    id: 'ansible', t: 'Ansible', en: 'Ansible', cat: 'cloud', keys: ['Ansible', 'playbook', '冪等'], tags: ['Ansible', 'YAML', 'playbook', '冪等', 'network_cli'],
    sum: '用 YAML 寫的 playbook 描述「設備應該是什麼樣子」，Ansible 透過 SSH 連上去，只改不一樣的地方：同一個 playbook 跑幾次結果都一樣（冪等）。',
    body: ['不用在設備上裝代理程式（agentless）。網路設備用 network_cli 連線，例如 ios_config 模組；執行結果 changed 表示這次真的改了東西，ok 表示本來就對了。YAML 的縮排很重要。'],
    see: ['restconf', 'terraform', 'config-mgmt'],
  },
  {
    id: 'terraform', t: 'Terraform 與 IaC', en: 'Terraform / Infrastructure as Code', cat: 'cloud', keys: ['Terraform', 'IaC', '基礎架構即程式碼', 'drift', 'terraform plan'], tags: ['Terraform', 'IaC', 'drift'],
    sum: '用程式碼描述雲端的資源（VPC、子網路、安全群組），terraform plan 比對現況列出要改什麼，apply 才真的建立；設定檔就是文件，也能放進 Git 審核。',
    body: ['有人直接在主控台手動改了資源，和程式碼不一樣了，叫做 drift：下次 plan 會發現並想把它改回程式碼描述的樣子。'],
    see: ['ansible', 'aws-vpc'],
  },
  {
    id: 'sdn', t: '控制器式網路', en: 'Controller-based networking / SDN', cat: 'cloud', keys: ['SDN', '控制器式網路', 'Catalyst Center', '控制平面', '資料平面', 'northbound', 'southbound'], tags: ['SDN', '控制器式網路', 'Catalyst Center', '範本', 'Velocity', 'AI'],
    sum: '把設定與決策集中到控制器：管理者透過控制器的介面或 API（northbound）下指令，控制器再用 southbound 協定（NETCONF、SSH）推到每台設備。',
    body: ['控制平面決定「要怎麼走」（路由協定、STP），資料平面真正轉送封包。Catalyst Center 這類控制器提供範本（Velocity）、一次推到很多台、網路健康度分析。'],
    see: ['restconf', 'netconf'],
  },
  {
    id: 'aws-vpc', t: '雲端 VPC', en: 'Cloud VPC, IGW, NAT gateway', cat: 'cloud', keys: ['VPC', 'IGW', '網際網路閘道', 'NAT 閘道', 'Elastic IP', '彈性 IP', '公有子網路', '私有子網路'], tags: ['VPC', 'IGW', 'Elastic IP', 'NAT 閘道', '雲端', '混合雲'],
    sum: '在雲端上的私人網路：切成好幾個子網路，每個子網路的路由表決定它是「公有」（預設路由指向網際網路閘道）還是「私有」（指向 NAT 閘道或沒有對外的路）。',
    body: ['公有子網路的主機還要有公用位址（彈性 IP）才能被外面連到。私有子網路的主機透過放在公有子網路的 NAT 閘道上網，外面連不進來。和公司內部連線用站對站 VPN（虛擬私人閘道）或專線。'],
    see: ['sg-nacl', 'vpc-peering', 'nat'],
  },
  {
    id: 'sg-nacl', t: '安全群組與網路 ACL', en: 'Security group / network ACL', cat: 'cloud', keys: ['安全群組', '網路 ACL', 'Security Group', 'NACL'], tags: ['安全群組', '網路 ACL', '無狀態'],
    sum: '安全群組套在每台主機的網卡上，有狀態、只能寫允許；網路 ACL 套在子網路的邊界，無狀態、有順序、可以寫拒絕，回程也要另外放行。',
    body: ['網路 ACL 無狀態：放行了進來的 443，回應用的是用戶端的高埠號（1024–65535），出去的方向也要放行，不然連線建立不起來。'],
    see: ['aws-vpc', 'acl', 'stateful-fw'],
  },
  {
    id: 'vpc-peering', t: 'VPC peering 與 Transit Gateway', en: 'VPC peering / Transit Gateway', cat: 'cloud', keys: ['VPC peering', 'Transit Gateway', 'non-transitive'], tags: ['VPC peering', 'Transit Gateway', 'non-transitive'],
    sum: 'peering 把兩個 VPC 直接接起來（兩邊的路由表都要加路），但不能「借道」：A 接 B、B 接 C，A 還是到不了 C。很多 VPC 互通改用 Transit Gateway 當中心。',
    body: ['peering 的兩個 VPC 網段不能重疊；建立連線之後兩邊的路由表都要有往對方網段指向 peering 的路，安全群組也要放行。'],
    see: ['aws-vpc'],
  },
  {
    id: 'lb', t: '負載平衡器', en: 'Load balancer (ADC)', cat: 'cloud', keys: ['負載平衡', '負載平衡器', 'BIG-IP', 'virtual server', '健康檢查', 'SNAT Automap', 'ALB'], tags: ['負載平衡', 'BIG-IP', 'SNAT', '健康檢查', '非對稱路由', 'ALB'],
    sum: '用戶連到一個虛擬位址（virtual server），負載平衡器依演算法挑一台後端伺服器轉送過去；定期做健康檢查，壞掉的伺服器自動移出。',
    body: [
      '健康檢查要檢查到應用程式本身（HTTP 回 200），只 ping 或只看 TCP 埠，網站壞了（回 500）還是會被當成正常。',
      '伺服器的閘道不是負載平衡器時，回應會直接繞過它回去（非對稱路由），連線就斷了：用 SNAT（Automap）把來源換成負載平衡器自己的位址，回應一定會回來。',
    ],
    see: ['nat', 'stateful-fw'],
  },
  {
    id: 'vswitch', t: '虛擬交換器與連接埠群組', en: 'vSwitch / port group', cat: 'cloud', keys: ['虛擬交換器', 'vSwitch', '連接埠群組', 'port group', 'VMkernel', 'vmk'], tags: ['vSwitch', '連接埠群組', 'Hypervisor', '虛擬化', 'VMkernel'],
    sum: '虛擬化主機裡的軟體交換器：虛擬機器的網卡接在連接埠群組上，群組決定 VLAN；實體網卡（uplink）接到外面的交換器，那個埠要是 Trunk。',
    body: ['VMkernel 介面（vmk）是主機自己用的介面：管理、vMotion、儲存各用一個。兩台主機的 vMotion 要在同一個網段、同一個 VLAN（MTU 也要一致）才搬得過去。'],
    see: ['nic-teaming', 'trunk', 'vmotion'],
  },
  {
    id: 'nic-teaming', t: 'NIC teaming', en: 'NIC teaming', cat: 'cloud', keys: ['NIC teaming', 'IP hash'], tags: ['NIC teaming', 'IP hash'],
    sum: '虛擬化主機用好幾張實體網卡當 uplink：預設依虛擬埠固定走某一張（交換器那端是兩個獨立的埠）；IP hash 依位址分散，交換器那端必須綁成 EtherChannel。',
    body: ['兩張 uplink 接的交換器埠，VLAN 設定要一樣：不然同一個 VLAN 的虛擬機器，固定走 A 卡的通、走 B 卡的不通。IP hash 卻沒有在交換器上綁 EtherChannel：MAC 在兩個埠之間跳來跳去，整台斷線。'],
    see: ['vswitch', 'etherchannel'],
  },
  {
    id: 'vmotion', t: 'vMotion', en: 'Live migration', cat: 'cloud', keys: ['vMotion', '維護模式'], tags: ['vMotion', '維護模式'],
    sum: '虛擬機器在不停機的情況下，從一台主機搬到另一台：記憶體透過 vMotion 網路複製過去，最後一瞬間切換，網路連線不中斷。',
    body: ['條件：兩台主機都有啟用 vMotion 的 VMkernel 介面而且互通、目的主機有同名的連接埠群組（同一個 VLAN）、共用儲存或一起搬儲存。主機要維護時進入維護模式，上面的虛擬機器自動搬走。'],
    see: ['vswitch'],
  },
  {
    id: 'docker', t: '容器網路', en: 'Docker networking', cat: 'cloud', keys: ['Docker', '容器', '連接埠發佈', 'docker run -p'], tags: ['Docker', '容器', '連接埠發佈'],
    sum: '容器預設接在主機裡的 bridge 網路（172.17.0.0/16），外面要連進來要發佈連接埠（-p 8080:80，主機的 8080 轉到容器的 80）。',
    body: ['-p 127.0.0.1:8080:80 只綁在主機自己，外面連不到；容器裡的服務只聽 127.0.0.1 也一樣。發佈的埠寫反了（容器裡沒有那個埠）連線會被重設。'],
    see: ['port-forward', 'nat'],
  },
  {
    id: 'linux-net', t: 'Linux 的網路設定', en: 'Linux networking (ip, nmcli)', cat: 'cloud', keys: ['nmcli', 'NetworkManager', 'ip addr', 'ip link'], tags: ['Linux', 'nmcli', 'NetworkManager'],
    sum: 'ip addr / ip route 查看位址與路由（暫時的，重開就沒了）；用 NetworkManager 的 nmcli 改設定檔才會永久保存，改完要 connection up 才套用。',
    body: ['ipv4.addresses 要寫成 10.0.20.15/24：少了長度會被當成 /32，閘道就不在網段裡。改網路設定要 sudo。'],
    cmd: [{ v: 'Linux', c: ['ip addr', 'ip route', 'sudo nmcli connection modify eth0 ipv4.method manual ipv4.addresses 10.0.20.15/24 ipv4.gateway 10.0.20.1 ipv4.dns 10.0.20.5', 'sudo nmcli connection up eth0'] }],
    see: ['ip-address', 'subnet'],
  },
];
