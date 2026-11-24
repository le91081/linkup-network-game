// 第十七章：虛擬化。一台實體伺服器跑好幾台虛擬機器：vSwitch、連接埠群組與 VLAN 標籤、接實體交換器的 Trunk
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { isTrunk } from '../engine/sim.js';
import { pgOf, pgVlan } from '../engine/virt.js';
import { dev, swp, WEB, DB } from './util.js';
import { iosSession } from '../engine/ios.js';
import { addContainer, parsePublish, findCtr } from '../engine/docker.js';

export const CHAPTERS11 = [
  { id: 17, title: '虛擬化', desc: '一台實體伺服器跑很多台虛擬機器：Hypervisor、虛擬交換器 (vSwitch)、連接埠群組與 VLAN 標籤，以及接實體交換器的 Trunk。' },
];

const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, ip ? { ip, mask: '255.255.255.0' } : {}));
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
const typeIn = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); for (const l of lines) sess.exec(l); };
const DAY = 86400;
/** 虛擬機器接在主機的第 n 個虛擬埠上，並放進某個連接埠群組 */
const attach = (s, host, n, vm, pg) => { s.cables.push({ id: 'c' + s.seq++, a: { dev: vm, port: 'eth0' }, b: { dev: host, port: 'vp' + n }, media: 'virt', kind: 'virtual' }); s.devices[host].sw.ports['vp' + n].pg = pg; };

export const LEVELS16 = [
  {
    id: 'l70', chapter: 17, title: '一台主機，三個網段', subtitle: 'vSwitch、連接埠群組與 VLAN 標籤', tags: ['虛擬化', 'Hypervisor', 'vSwitch', '802.1Q'],
    brief: '機房只剩一個機櫃位置，公司買了一台高階伺服器裝 VMware ESXi，把網站、資料庫兩台舊伺服器變成虛擬機器搬進去。虛擬化的同事裝好之後就休假了：網站從使用者那邊打不開，網站連不到資料庫，管理員也連不進 ESXi 的管理介面。請把虛擬交換器和實體交換器之間的設定對好。',
    given: [
      ['VLAN 10 Web', '10.0.10.0/24 · web-vm 10.0.10.10'], ['VLAN 20 DB', '10.0.20.0/24 · db-vm 10.0.20.10'],
      ['VLAN 99 管理', '10.0.99.0/24 · ESXi 的 vmk0 10.0.99.11'], ['VLAN 30 使用者', '10.0.30.0/24'],
      ['ESXi 的上行', 'vmnic0 → SW-Core 的 Gi0/11'], ['閘道', 'R1 的子介面，每個 VLAN 的 .1'],
    ],
    learn: [
      { t: 'Hypervisor', d: 'Type 1（ESXi、Hyper-V Server、KVM）直接裝在伺服器上，Type 2（VirtualBox、VMware Workstation）裝在一般的作業系統上。每台虛擬機器有自己的 CPU、記憶體、磁碟和網卡，彼此隔離，可以在主機之間搬移。' },
      { t: '虛擬交換器 (vSwitch)', d: '主機裡面有一台軟體交換器：虛擬機器的網卡接在它的虛擬埠上，實體網卡 (vmnic) 是它的上行。同一台主機上的兩台虛擬機器如果在同一個 VLAN，封包根本不會離開主機。' },
      { t: '連接埠群組與 VLAN 標籤', d: '連接埠群組 (port group) 決定虛擬機器在哪個 VLAN。VLAN ID 填 10，從 vmnic0 出去的封包就帶著 802.1Q 標籤 10（VST）；填 0 就不加標籤，落在實體交換器那個埠的 native VLAN。' },
      { t: '實體交換器那一端', d: '有好幾個 VLAN 的虛擬機器時，接主機的那個埠一定要是 Trunk，而且允許這些 VLAN。Catalyst 預設是 dynamic auto，ESXi 不送 DTP，所以會一直停在 Access。vSwitch 也不送 BPDU。' },
      { t: '容器與 VRF', d: '容器 (Docker) 共用主機的作業系統核心，比虛擬機器輕，常用橋接網路加上連接埠發佈 (-p 8443:443) 對外。VRF 則是路由器上的「虛擬化」：一台路由器切成好幾份獨立的路由表。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', {
          name: 'R1', pos: [-7, -6],
          init(d) { for (const [v, ip] of [[10, '10.0.10.1'], [20, '10.0.20.1'], [30, '10.0.30.1'], [99, '10.0.99.1']]) sub(d, 'Gi0/0/1', v, ip); },
        }),
        D('c2960', 'sw', {
          name: 'SW-Core', pos: [0, -2],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'Web' }, { id: 20, name: 'DB' }, { id: 30, name: 'Users' }, { id: 99, name: 'Mgmt' });
            d.sw.ports['Gi0/9'].mode = 'trunk';
            d.sw.ports['Gi0/1'].vlan = 30; d.sw.ports['Gi0/2'].vlan = 99;
            d.sw.stp.portfastDefault = true;
          },
        }),
        D('esxi', 'esx', {
          name: 'ESXi-01', pos: [7.5, -3],
          init(d) {
            d.vsw.pgs = [{ name: 'Web', vlan: 10 }, { name: 'DB', vlan: 0 }, { name: 'Management Network', vlan: 0 }];
            d.vsw.vmkPg = 'Management Network';
            Object.assign(d.ifaces[0], { ip: '10.0.99.11', mask: '255.255.255.0', gateway: '10.0.99.1' });
          },
        }),
        D('vm', 'web', { name: 'web-vm', pos: [4.6, 2.8], ip: '10.0.10.10', gw: '10.0.10.1', services: WEB }),
        D('vm', 'db', { name: 'db-vm', pos: [10.4, 2.8], ip: '10.0.20.10', gw: '10.0.20.1', services: DB }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-6, 4], ip: '10.0.30.50', gw: '10.0.30.1' }),
        D('laptop', 'adm', { name: '管理員筆電', pos: [-1.5, 4.6], ip: '10.0.99.50', gw: '10.0.99.1' }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['esx:vmnic0', 'sw:Gi0/11'], ['pc:eth0', 'sw:Gi0/1'], ['adm:eth0', 'sw:Gi0/2']]);
      attach(s, 'esx', 1, 'web', 'Web');
      attach(s, 'esx', 2, 'db', 'DB');
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'web', port: 443, label: '使用者可以開啟網站（web-vm，HTTPS）' },
      { type: 'tcp', from: 'web', to: 'db', port: 3306, label: '網站連得到資料庫（db-vm，MySQL 3306）' },
      { type: 'tcp', from: 'adm', ip: '10.0.99.11', port: 443, label: '管理員可以登入 ESXi 的管理介面 (https://10.0.99.11)' },
      {
        type: 'check', label: 'SW-Core 接 ESXi 的埠是 Trunk，只放行需要的 VLAN（10、20、99）',
        test(s) {
          const sw = dev(s, 'sw'), pc = swp(s, 'sw', 'Gi0/11');
          if (!isTrunk(sw, 'Gi0/11')) return 'SW-Core 的 Gi0/11 還不是 Trunk：帶著 VLAN 標籤的封包到了 Access 埠就被丟掉';
          const allowed = String(pc.allowed || 'all');
          if (allowed === 'all') return 'Gi0/11 的 Trunk 放行了所有 VLAN：最小權限的做法是只放 10、20、99（switchport trunk allowed vlan 10,20,99）';
          const vs = new Set(allowed.split(',').flatMap((x) => { const [a, b] = x.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, k) => a + k) : [a]; }));
          const miss = [10, 20, 99].filter((v) => !vs.has(v)), extra = [...vs].filter((v) => ![10, 20, 99].includes(v));
          if (miss.length) return `Gi0/11 的 Trunk 沒有放行 VLAN ${miss.join('、')}`;
          return !extra.length || `Gi0/11 的 Trunk 多放行了 VLAN ${extra.join('、')}`;
        },
      },
      {
        type: 'check', label: '每個連接埠群組都在正確的 VLAN（DB 20、管理 99）',
        test(s) {
          const d = dev(s, 'esx');
          if (pgVlan(pgOf(d, 'DB')) !== 20) return '連接埠群組「DB」的 VLAN ID 不是 20';
          if (pgVlan(pgOf(d, d.vsw.vmkPg)) !== 99) return `vmk0 所在的連接埠群組「${d.vsw.vmkPg}」的 VLAN ID 不是 99`;
          return true;
        },
      },
    ],
    hints: [
      '先看實體交換器：SW-Core 的 show interfaces trunk 裡沒有 Gi0/11，它還是 Access 埠（dynamic auto，ESXi 不送 DTP）。interface Gi0/11 → switchport mode trunk → switchport trunk allowed vlan 10,20,99。',
      'ESXi-01 →「虛擬交換器」分頁：連接埠群組「DB」的 VLAN ID 還是 0（不加標籤），改成 20。',
      '「Management Network」也是 0，改成 99：vmk0 才會在管理 VLAN 裡，管理員的筆電才連得到 https://10.0.99.11。',
    ],
    solve(s) {
      Object.assign(swp(s, 'sw', 'Gi0/11'), { mode: 'trunk', allowed: '10,20,99' });
      const d = dev(s, 'esx');
      pgOf(d, 'DB').vlan = 20;
      pgOf(d, 'Management Network').vlan = 99;
    },
    recap: ['虛擬機器的 VLAN 由連接埠群組決定，標籤在 vSwitch 加上去。', '接虛擬化主機的實體交換器埠要設成 Trunk，只放行需要的 VLAN。'],
  },

  // ─────────────────────────────────────────────── VRF
  {
    id: 'l72', chapter: 17, title: '兩家公司，同一個網段', subtitle: 'VRF：一台路由器切成兩份路由表', tags: ['VRF', 'VRF-Lite', '多租戶', '路由表'],
    brief: '共享辦公室的機房只有一台路由器 R-Shared，替進駐的兩家公司連到各自放在機房裡的伺服器。兩家公司的電腦都用 192.168.1.0/24（從舊辦公室直接搬過來），伺服器也剛好都是 10.1.0.10。A 公司已經接好了；接 B 公司的時候，路由器說位址重疊，不讓你設定。兩家公司的網路都不能改，請讓兩家都連到自己的伺服器，而且彼此完全看不到。',
    given: [
      ['A 公司', 'LAN 192.168.1.0/24（R-Shared Gi0/0/0）· 伺服器 10.1.0.10（VLAN 10）'],
      ['B 公司', 'LAN 192.168.1.0/24（R-Shared Gi0/0/1）· 伺服器 10.1.0.10（VLAN 20）'],
      ['閘道', '兩家都是 192.168.1.1；伺服器那一側都是 10.1.0.1'],
      ['機房交換器', 'SW-DC 的 Gi0/1 是 Trunk，接 R-Shared 的 Gi0/0/2（子介面 .10、.20）'],
      ['VRF 名稱', 'TENANT-A（RD 65000:1）、TENANT-B（RD 65000:2）'],
    ],
    learn: [
      { t: 'VRF 是什麼', d: 'Virtual Routing and Forwarding：路由器上的每個 VRF 都有自己的路由表和自己的介面。介面放進哪個 VRF，封包就只查那個 VRF 的路由表。不同 VRF 的位址可以重疊，彼此也看不到，就像好幾台獨立的路由器。' },
      { t: 'VRF-Lite 與 MPLS VPN', d: '只在一台（或幾台）路由器上用 VRF、不搭配 MPLS，叫做 VRF-Lite，常見於多租戶的機房，或把訪客、管理和公司網路完全隔開。電信業者的 MPLS VPN 則是 VRF 加上 MP-BGP，把很多客戶的網路帶到各地。' },
      { t: '設定的步驟', d: 'vrf definition TENANT-A → rd 65000:1 → address-family ipv4 → exit-address-family。介面下 vrf forwarding TENANT-A 時，IOS 會把介面原本的 IP 清掉（% Interface … IPv4 disabled and address(es) removed），要重新設定 ip address。' },
      { t: 'RD 與 RT', d: 'Route Distinguisher (RD) 讓重疊的路由在 MP-BGP 裡變成獨一無二的（65000:1:192.168.1.0/24）；Route Target (RT) 決定路由要匯入哪些 VRF。只用 VRF-Lite 時 RD 不是必要的，但習慣上還是會設。' },
      { t: '看 VRF 的指令', d: 'show vrf 列出每個 VRF 和它的介面；show ip route 只顯示全域的路由表，VRF 的要用 show ip route vrf TENANT-A。ping 也一樣：ping vrf TENANT-A 10.1.0.10。' },
    ],
    setup() {
      return makeState([
        D('isr4331', 'rt', {
          name: 'R-Shared', pos: [0, -6],
          init(d) {
            ip4(d, 'Gi0/0/0', '192.168.1.1');
            sub(d, 'Gi0/0/2', 10, '10.1.0.1');
            sub(d, 'Gi0/0/2', 20);
          },
        }),
        D('sw8', 'swa', { name: 'SW-A 公司', pos: [-8.5, -1] }),
        D('sw8', 'swb', { name: 'SW-B 公司', pos: [-2.5, -0.5] }),
        D('c2960', 'swdc', {
          name: 'SW-DC', pos: [7, -1.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'TenantA-Srv' }, { id: 20, name: 'TenantB-Srv' });
            Object.assign(d.sw.ports['Gi0/1'], { mode: 'trunk', allowed: '10' }); // 只接了 A 公司的時候設的
            d.sw.ports['Gi0/2'].vlan = 10; d.sw.ports['Gi0/3'].vlan = 20;
            d.sw.stp.portfastDefault = true;
          },
        }),
        D('pc', 'pca', { name: 'A 公司 PC', pos: [-10, 4], ip: '192.168.1.10', gw: '192.168.1.1' }),
        D('pc', 'pcb', { name: 'B 公司 PC', pos: [-3.5, 4.6], ip: '192.168.1.10', gw: '192.168.1.1' }),
        D('tower', 'srva', { name: 'A-Server', pos: [4.6, 4], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('tower', 'srvb', { name: 'B-Server', pos: [9.6, 4], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
      ], [['rt:Gi0/0/0', 'swa:1'], ['rt:Gi0/0/1', 'swb:1'], ['rt:Gi0/0/2', 'swdc:Gi0/1'], ['pca:eth0', 'swa:2'], ['pcb:eth0', 'swb:2'], ['srva:eth0', 'swdc:Gi0/2'], ['srvb:eth0', 'swdc:Gi0/3']]);
    },
    objectives: [
      { type: 'tcp', from: 'pca', ip: '10.1.0.10', port: 443, via: 'srva', label: 'A 公司的電腦連到自己的伺服器（A-Server）' },
      { type: 'tcp', from: 'pcb', ip: '10.1.0.10', port: 443, via: 'srvb', label: 'B 公司的電腦連到自己的伺服器（B-Server）' },
      {
        type: 'check', label: '兩家公司各在自己的 VRF 裡，不留在全域路由表',
        test(s) {
          const r = dev(s, 'rt'), v = (id) => (r.ifaces.find((i) => i.id === id) || {}).vrf || '';
          const a = [v('Gi0/0/0'), v('Gi0/0/2.10')], b = [v('Gi0/0/1'), v('Gi0/0/2.20')];
          if (a[0] !== a[1]) return `A 公司的兩個介面不在同一個 VRF（Gi0/0/0：${a[0] || '全域'}、Gi0/0/2.10：${a[1] || '全域'}）`;
          if (b[0] !== b[1]) return `B 公司的兩個介面不在同一個 VRF（Gi0/0/1：${b[0] || '全域'}、Gi0/0/2.20：${b[1] || '全域'}）`;
          if (!a[0] || !b[0]) return `${!a[0] ? 'A' : 'B'} 公司還在全域的路由表裡：每個客戶都放進自己的 VRF，全域留給機房自己的管理網路`;
          return a[0] !== b[0] || '兩家公司在同一個 VRF 裡：位址會重疊，也會互相看得到';
        },
      },
      {
        type: 'check', label: '兩家公司的網路都沒有改（電腦、伺服器的位址和閘道照舊）',
        test(s) {
          const want = { pca: ['192.168.1.10', '192.168.1.1'], pcb: ['192.168.1.10', '192.168.1.1'], srva: ['10.1.0.10', '10.1.0.1'], srvb: ['10.1.0.10', '10.1.0.1'] };
          for (const [id, [ip, gw]] of Object.entries(want)) {
            const i = dev(s, id).ifaces[0];
            if (i.mode !== 'static' || i.ip !== ip || i.gateway !== gw) return `${dev(s, id).name} 的位址或閘道被改了：客戶的網路不能動，重疊要在路由器上用 VRF 解決`;
          }
          return true;
        },
      },
    ],
    hints: [
      'R-Shared 的「介面」分頁：Gi0/0/1 填 192.168.1.1 會看到「和 Gi0/0/0 的網段重疊」。同一個路由表裡不能有兩個 192.168.1.0/24，所以要用 VRF 把兩家公司分開。',
      'CLI：vrf definition TENANT-A → rd 65000:1 → address-family ipv4 → exit-address-family；TENANT-B 一樣，RD 用 65000:2。（「路由」分頁的 VRF 卡片也可以新增）',
      '介面放進 VRF：interface gi0/0/0 → vrf forwarding TENANT-A → ip address 192.168.1.1 255.255.255.0（IP 會被清掉，要重打）。Gi0/0/2.10 也放進 TENANT-A；Gi0/0/1 與 Gi0/0/2.20 放進 TENANT-B，位址一樣是 192.168.1.1 和 10.1.0.1。',
      'B 公司還是連不到伺服器？SW-DC 的 Gi0/1 是只接 A 公司時設的 Trunk，只放行 VLAN 10：switchport trunk allowed vlan add 20。驗證：show vrf、show ip route vrf TENANT-B、ping vrf TENANT-B 10.1.0.10。',
    ],
    solve(s) {
      typeIn(s, 'rt', ['configure terminal',
        'vrf definition TENANT-A', 'rd 65000:1', 'address-family ipv4', 'exit-address-family',
        'vrf definition TENANT-B', 'rd 65000:2', 'address-family ipv4', 'exit-address-family',
        'interface gi0/0/0', 'vrf forwarding TENANT-A', 'ip address 192.168.1.1 255.255.255.0',
        'interface gi0/0/2.10', 'vrf forwarding TENANT-A', 'ip address 10.1.0.1 255.255.255.0',
        'interface gi0/0/1', 'vrf forwarding TENANT-B', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown',
        'interface gi0/0/2.20', 'vrf forwarding TENANT-B', 'ip address 10.1.0.1 255.255.255.0',
        'end']);
      swp(s, 'swdc', 'Gi0/1').allowed = '10,20';
    },
    recap: ['VRF 讓一台路由器有好幾份獨立的路由表：不同 VRF 的網段可以重疊，彼此也看不到。', '介面放進 VRF 時 IP 會被清掉；看路由與測試都要指定 VRF（show ip route vrf、ping vrf）。'],
  },

  // ─────────────────────────────────────────────── 容器
  {
    id: 'l73', chapter: 17, title: '容器跑起來了，網頁卻打不開', subtitle: 'Docker 的橋接網路與連接埠發佈', tags: ['容器', 'Docker', '連接埠發佈', '最小權限'],
    brief: '開發團隊在 Ubuntu 主機 docker-01 上用 Docker 跑了三個容器：內部網站 web (nginx)、監控儀表板 grafana、資料庫 db (mysql)。docker ps 看起來三個都是 Up，可是同事從自己的電腦打不開網站，也打不開儀表板。資安部門的弱點掃描還說，資料庫的 3306 從辦公室就連得到。請修好，三個容器都要繼續執行。',
    given: [
      ['docker-01', '10.0.50.20（伺服器網段 10.0.50.0/24）· 登入帳號 admin'],
      ['內部網站', 'http://10.0.50.20:8080（nginx 在容器裡聽 80）'],
      ['Grafana', 'http://10.0.50.20:3000（容器裡聽 3000）'],
      ['資料庫', 'mysql 在容器裡聽 3306，只給這台主機上的程式用'],
      ['同事的電腦', '10.0.10.50（使用者網段）'],
    ],
    learn: [
      { t: '容器和虛擬機器', d: '虛擬機器各有一套完整的作業系統；容器只是主機上被隔離的一群程序，共用主機的核心，所以啟動只要一秒、一台主機可以跑上百個。映像檔 (image) 是唱片，容器 (container) 是正在播放的那一張。' },
      { t: '預設的橋接網路', d: 'Docker 在主機裡建一台虛擬交換器 docker0（172.17.0.1/16），每個容器用一條 veth 接上去，拿到 172.17.0.x。這些位址只存在主機裡面，外面看不到，也路由不到。' },
      { t: '發佈連接埠 (-p)', d: '-p 8080:80 的意思是「主機的 8080 轉給容器的 80」，左邊是主機、右邊是容器。容器裡的程式聽哪個埠是映像檔決定的（nginx 是 80），寫成 8080:8080 就會連上主機之後被重設。-p 127.0.0.1:3000:3000 只綁在 127.0.0.1，只有主機自己連得到。' },
      { t: '連接埠設定改不了，只能重建', d: '容器建立之後就不能改發佈的埠：docker rm -f 舊的，再 docker run 一個新的（資料要放在 volume 裡才不會跟著不見）。實務上會把這些寫在 docker-compose.yml 裡，改完 docker compose up -d 就會自動重建。' },
      { t: 'Docker 會繞過 ufw', d: 'Docker 發佈連接埠是直接寫 iptables 的規則，主機上的 ufw 擋不住。所以資料庫這類只給內部用的服務根本不要發佈；真的要從主機連，就綁 127.0.0.1。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [-1, -6], init(d) { ip4(d, 'Gi0/0/0', '10.0.10.1'); ip4(d, 'Gi0/0/1', '10.0.50.1'); } }),
        D('sw8', 'usw', { name: 'SW-Users', pos: [-7, -0.5] }),
        D('sw8', 'ssw', { name: 'SW-Servers', pos: [5, -0.5] }),
        D('pc', 'pc', { name: '同事的電腦', pos: [-8.5, 4.4], ip: '10.0.10.50', gw: '10.0.10.1' }),
        D('tower', 'dk', { name: 'docker-01', pos: [6.5, 4.6], ip: '10.0.50.20', gw: '10.0.50.1', services: [{ proto: 'tcp', port: 22, name: 'SSH' }] }),
      ], [['rt:Gi0/0/0', 'usw:1'], ['rt:Gi0/0/1', 'ssw:1'], ['pc:eth0', 'usw:2'], ['dk:eth0', 'ssw:2']]);
      const d = s.devices.dk;
      d.docker = { containers: [] };
      for (const [name, image, pub] of [['db', 'mysql', '3306:3306'], ['web', 'nginx', '8080:8080'], ['grafana', 'grafana/grafana', '127.0.0.1:3000:3000']]) {
        const { ctr } = addContainer(s, d, { name, image, publish: [parsePublish(pub)] });
        ctr.created = ctr.started = -3 * DAY + (name === 'db' ? 0 : 600);
      }
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', ip: '10.0.50.20', port: 8080, label: '同事打得開內部網站 http://10.0.50.20:8080' },
      { type: 'tcp', from: 'pc', ip: '10.0.50.20', port: 3000, label: '同事打得開 Grafana http://10.0.50.20:3000' },
      { type: 'tcp', from: 'pc', ip: '10.0.50.20', port: 3306, expect: false, label: '資料庫的 3306 從辦公室連不到' },
      {
        type: 'check', label: '三個容器（web、grafana、db）都在執行，而且用的是原本的映像檔',
        test(s) {
          const d = dev(s, 'dk');
          for (const [n, img] of [['web', 'nginx'], ['grafana', 'grafana/grafana'], ['db', 'mysql']]) {
            const c = findCtr(d, n);
            if (!c) return `找不到容器 ${n}：刪掉之後要用一樣的名稱重建（docker run -d --name ${n} …）`;
            if (c.image.replace(/:.*$/, '') !== img) return `容器 ${n} 的映像檔是 ${c.image}，應該是 ${img}`;
            if (c.state !== 'running') return `容器 ${n} 沒有在執行（docker start ${n}）`;
          }
          return true;
        },
      },
    ],
    hints: [
      'docker-01 的終端機：docker ps 看 PORTS 欄。web 是 0.0.0.0:8080->8080/tcp，可是 nginx 在容器裡聽的是 80（curl http://localhost:8080 會 Connection reset by peer）。',
      '發佈的埠改不了，要重建：docker rm -f web，再 docker run -d --name web -p 8080:80 nginx。',
      'grafana 是 127.0.0.1:3000->3000/tcp：只有主機自己連得到。docker rm -f grafana → docker run -d --name grafana -p 3000:3000 grafana/grafana。',
      'db 不應該發佈到外面：docker rm -f db → docker run -d --name db mysql（不加 -p，或只綁 -p 127.0.0.1:3306:3306）。也可以在「Docker」分頁刪掉再建立。',
    ],
    solve(s) {
      const d = dev(s, 'dk');
      d.docker.containers = d.docker.containers.filter((c) => !['web', 'grafana', 'db'].includes(c.name));
      addContainer(s, d, { name: 'db', image: 'mysql' });
      addContainer(s, d, { name: 'web', image: 'nginx', publish: [parsePublish('8080:80')] });
      addContainer(s, d, { name: 'grafana', image: 'grafana/grafana', publish: [parsePublish('3000:3000')] });
    },
    recap: ['容器在主機裡的橋接網路上，外面要靠發佈連接埠 (-p 主機埠:容器埠) 才連得到；右邊要是容器裡真的在聽的埠。', '只給內部用的服務不要發佈，或只綁 127.0.0.1；Docker 發佈的埠會繞過主機的 ufw。'],
  },
];
