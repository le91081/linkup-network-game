// 第二十一章：大型資料中心；第二十二章：AI 資料中心（GPU 叢集）。設計見 PLAN.md 第 20 節。
// 交換器是 Nexus（NX-OS 的語法），設定全部用 CLI 打進去，和玩家在 CLI 分頁看到的 running-config 一致。
import { makeDevice as D, makeState } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev, WEB } from './util.js';

export const CHAPTERS15 = [
  { id: 21, title: '大型資料中心', desc: '幾百台交換器的 Clos 架構：用 eBGP 當 underlay、每一條上行都要用到、超額訂閱、不中斷的維護。' },
  { id: 22, title: 'AI 資料中心', desc: 'GPU 叢集的網路：前端、後端、儲存、管理四張網路，rail 的接法，RDMA 需要的無損乙太網路（PFC 與 ECN）。' },
];

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const cfg = (s, id, lines) => typeIn(s, id, ['enable', 'configure terminal', ...lines, 'end', 'copy running-config startup-config']);
/** Nexus 的第三層埠 */
const l3 = (port, ip) => [`interface ${port}`, 'no switchport', `ip address ${ip}`, 'no shutdown', 'exit'];
/** NX-OS 的 BGP 鄰居（巢狀的寫法） */
const nbr = (ip, as) => [`neighbor ${ip}`, `remote-as ${as}`, 'address-family ipv4 unicast', 'exit', 'exit'];
/** 這台設備往某個 /24 的 BGP 路由（放進路由表的那幾筆） */
const bgpTo = (s, id, net) => ((dev(s, id).rt || {}).routes || []).filter((r) => !r.bad && r.type === 'B' && r.net === parseIp(net) && r.bits === 24);

export const LEVELS98 = [
  {
    id: 'l191', chapter: 21, title: '只用到一台 Spine', subtitle: '資料中心的 eBGP underlay：AS 怎麼編、maximum-paths、兩台 Leaf 用了同一個 AS',
    tags: ['BGP', 'eBGP', 'Spine-Leaf', 'Clos', 'maximum-paths', 'ECMP', 'Nexus', 'RFC 7938'],
    brief: '新機房的 underlay 用 eBGP：兩台 Spine 共用 AS 65000，每台 Leaf 各自一個 AS。上線之後監控顯示 Spine-2 的埠幾乎沒有流量，所有機櫃之間的流量都擠在 Spine-1；另外，應用程式伺服器（Leaf-2）連不到資料庫（Leaf-3）。Leaf-3 是上週才上架的，設定是從 Leaf-2 複製過去再改位址。請把架構修到符合設計：每台 Leaf 往其他機櫃都同時用兩台 Spine，任何一台 Spine 故障都不會中斷。',
    given: [
      ['Spine（AS 65000）', 'Spine-1 router-id 10.255.0.1 · Spine-2 router-id 10.255.0.2 · Eth1/1 – 1/3 接 Leaf-1 – 3'],
      ['Leaf 的 AS', 'Leaf-1 65101 · Leaf-2 65102 · Leaf-3 65103（設計上每台都不一樣）'],
      ['上行的位址', 'Leaf-n ↔ Spine-1：10.0.1.(2n−2)/31（Spine 是偶數）· Leaf-n ↔ Spine-2：10.0.2.(2n−2)/31'],
      ['伺服器的網段', 'Leaf-n 的 VLAN 10：10.1.n.0/24（閘道 .1，伺服器 .10）'],
      ['設計規範', '每台 Leaf 的 AS 不重複，不用 allowas-in 當補丁；每台 Leaf 的 maximum-paths 是 4'],
    ],
    learn: [
      { t: '為什麼大型機房用 eBGP', d: '幾百台交換器的 Clos 架構裡，OSPF 的一條線上下會讓整個區域重算；BGP 只把受影響的網段告訴鄰居，每一跳還能套政策。做法（RFC 7938）：每一段都是直連的 eBGP，同一層的 Spine 共用一個 AS，每台 Leaf 自己一個 AS。' },
      { t: 'BGP 預設只用一條路', d: 'Leaf 往另一個機櫃有兩條一樣好的路（經過 Spine-1 或 Spine-2），但 BGP 的最佳路徑選擇最後一定分得出高下（比到 Router ID），預設只把贏的那一條放進路由表。maximum-paths 4 讓「前面的比較都平手」的路一起放進去，才有 ECMP。' },
      { t: 'AS path 就是迴圈偵測', d: 'eBGP 收到的路由，AS path 裡如果已經有自己的 AS 就丟掉。兩台 Leaf 用了同一個 AS，彼此的網段經過 Spine 傳過來時帶著「自己的」AS，被當成迴圈 —— 兩個機櫃互相看不到，但各自到其他機櫃都正常。show ip bgp summary 的 PfxRcd 會比預期少。' },
      { t: 'Spine 為什麼共用一個 AS', d: 'Leaf-1 從 Spine-1 學到的路如果再送給 Spine-2，Spine-2 會因為 AS path 裡有 65000 而丟掉。這正是我們要的：流量永遠是 Leaf → Spine → Leaf，不會出現 Leaf → Spine → Leaf → Spine 這種繞路。Spine 各用不同的 AS 時就要 bestpath as-path multipath-relax 才能多路徑，而且故障時會出現繞路。' },
      { t: '怎麼驗證', d: 'show ip bgp summary：每個鄰居都要是 Established（最後一欄是數字，不是 Idle / Active）；show ip bgp：同一個網段有兩筆，一筆 *>、一筆 *m（multipath）；show ip route bgp：同一個網段兩個下一站。' },
    ],
    setup() {
      const s = makeState([
        D('n9332', 's1', { name: 'Spine-1', pos: [-5, -9] }),
        D('n9332', 's2', { name: 'Spine-2', pos: [5, -9] }),
        D('n93180', 'l1', { name: 'Leaf-1', pos: [-10, -3] }),
        D('n93180', 'l2', { name: 'Leaf-2', pos: [0, -3] }),
        D('n93180', 'l3', { name: 'Leaf-3', pos: [10, -3] }),
        D('rack1u', 'web', { name: 'Web 伺服器', pos: [-10, 3], ip: '10.1.1.10', gw: '10.1.1.1', services: WEB }),
        D('rack1u', 'app', { name: '應用程式伺服器', pos: [0, 3], ip: '10.1.2.10', gw: '10.1.2.1', services: WEB }),
        D('rack1u', 'db', { name: '資料庫', pos: [10, 3], ip: '10.1.3.10', gw: '10.1.3.1', services: WEB }),
      ], [
        ['s1:Eth1/1', 'l1:Eth1/49'], ['s1:Eth1/2', 'l2:Eth1/49'], ['s1:Eth1/3', 'l3:Eth1/49'],
        ['s2:Eth1/1', 'l1:Eth1/50'], ['s2:Eth1/2', 'l2:Eth1/50'], ['s2:Eth1/3', 'l3:Eth1/50'],
        ['l1:Eth1/1', 'web:eth0'], ['l2:Eth1/1', 'app:eth0'], ['l3:Eth1/1', 'db:eth0'],
      ]);
      recompute(s);
      // as：這台 Leaf 的 AS；s2as：它以為 Spine-2 是哪個 AS；mp：有沒有 maximum-paths
      const leaf = (id, n, as, s2as, mp) => cfg(s, id, ['feature bgp', 'feature interface-vlan', 'vlan 10', 'name SERVERS', 'exit',
        'interface Ethernet1/1', 'switchport access vlan 10', 'exit', 'interface Vlan10', `ip address 10.1.${n}.1/24`, 'no shutdown', 'exit',
        ...l3('Ethernet1/49', `10.0.1.${n * 2 - 1}/31`), ...l3('Ethernet1/50', `10.0.2.${n * 2 - 1}/31`),
        `router bgp ${as}`, `router-id 10.255.1.${n}`, 'address-family ipv4 unicast', `network 10.1.${n}.0/24`, ...(mp ? ['maximum-paths 4'] : []), 'exit',
        ...nbr(`10.0.1.${n * 2 - 2}`, 65000), ...nbr(`10.0.2.${n * 2 - 2}`, s2as)]);
      const spine = (id, k) => cfg(s, id, ['feature bgp', ...[1, 2, 3].flatMap((n) => l3(`Ethernet1/${n}`, `10.0.${k}.${n * 2 - 2}/31`)),
        'router bgp 65000', `router-id 10.255.0.${k}`, 'address-family ipv4 unicast', 'exit', ...[1, 2].flatMap((n) => nbr(`10.0.${k}.${n * 2 - 1}`, 65100 + n)), ...nbr(`10.0.${k}.5`, 65102)]);
      leaf('l1', 1, 65101, 65001, false); // 往 Spine-2 的鄰居 remote-as 打成 65001：一直建不起來
      leaf('l2', 2, 65102, 65000, false); // 沒有 maximum-paths
      leaf('l3', 3, 65102, 65000, false); // 從 Leaf-2 複製過來，AS 沒有改
      spine('s1', 1); spine('s2', 2);     // Spine 上 Leaf-3 的 remote-as 也照著寫成 65102
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'app', to: 'db', port: 443, label: '應用程式伺服器（Leaf-2）連得到資料庫（Leaf-3）' },
      {
        type: 'check', label: '每台 Leaf 往其他兩個機櫃都有兩個下一站：兩台 Spine 都在分擔流量',
        test(s) {
          for (const [id, n] of [['l1', 1], ['l2', 2], ['l3', 3]]) {
            const d = dev(s, id);
            for (const m of [1, 2, 3]) {
              if (m === n) continue;
              const r = bgpTo(s, id, `10.1.${m}.0`);
              if (!r.length) return `${d.name} 的路由表裡沒有 10.1.${m}.0/24（Leaf-${m} 的網段）`;
              if (r.length < 2) {
                const idle = (((d.rt || {}).bgp || {}).peers || []).find((p) => p.state !== 'Established');
                return idle ? `${d.name} 往 10.1.${m}.0/24 只有一個下一站：鄰居 ${idle.ip} 沒有建立起來（${idle.why || idle.state}）`
                  : `${d.name} 往 10.1.${m}.0/24 只走 ${r[0].iface.label}：BGP 預設只把最佳的那一條放進路由表，要 maximum-paths`;
              }
            }
          }
          return true;
        },
      },
      {
        type: 'check', label: '符合設計規範：每台 Leaf 的 AS 都不一樣，沒有用 allowas-in',
        test(s) {
          const as = ['l1', 'l2', 'l3'].map((id) => +((dev(s, id).bgp || {}).asn || 0));
          if (new Set(as).size < 3) return `Leaf 的 AS 有重複（${as.join('、')}）：同一個 AS 的兩台 Leaf 會把對方的路由當成迴圈丟掉`;
          for (const id of ['l1', 'l2', 'l3', 's1', 's2']) if (((dev(s, id).bgp || {}).neighbors || []).some((n) => n.allowAs)) return `${dev(s, id).name} 用了 allowas-in：這是關掉迴圈偵測的補丁，規範要求把 AS 改對`;
          return true;
        },
      },
      { type: 'tcp', from: 'web', to: 'app', port: 443, label: 'Web 伺服器照常連得到應用程式伺服器' },
      { type: 'failover', label: 'Spine-1 整台故障：Web 伺服器照樣連得到資料庫', down: ['s1'], test: { type: 'tcp', from: 'web', to: 'db', port: 443 } },
    ],
    hints: [
      'Leaf-2：show ip bgp summary。兩個鄰居都是 Established，但各只收到 1 筆（Leaf-1 的），Leaf-3 的 10.1.3.0/24 不見了；Spine-1 的 show ip bgp 卻有 10.1.3.0/24，AS path 是 65102 —— 和 Leaf-2 自己一樣，被迴圈偵測丟掉。Leaf-3：no router bgp 65102，改用 65103 重建（router-id、address-family ipv4 unicast → network 10.1.3.0/24、maximum-paths 4、兩個 neighbor）；兩台 Spine 上 neighbor 10.0.x.5 的 remote-as 也要改成 65103。',
      'Leaf-1：show ip bgp summary，10.0.2.0 停在 Idle —— remote-as 寫成 65001，Spine-2 是 65000。router bgp 65101 → neighbor 10.0.2.0 → remote-as 65000。',
      '三台 Leaf 都要：router bgp <AS> → address-family ipv4 unicast → maximum-paths 4。show ip bgp 會出現 *m 的那一筆，show ip route bgp 同一個網段有兩個下一站。',
    ],
    solve(s) {
      cfg(s, 'l1', ['router bgp 65101', 'neighbor 10.0.2.0', 'remote-as 65000', 'exit', 'address-family ipv4 unicast', 'maximum-paths 4']);
      cfg(s, 'l2', ['router bgp 65102', 'address-family ipv4 unicast', 'maximum-paths 4']);
      cfg(s, 'l3', ['no router bgp 65102', 'router bgp 65103', 'router-id 10.255.1.3', 'address-family ipv4 unicast', 'network 10.1.3.0/24', 'maximum-paths 4', 'exit', ...nbr('10.0.1.4', 65000), ...nbr('10.0.2.4', 65000)]);
      for (const [id, k] of [['s1', 1], ['s2', 2]]) cfg(s, id, ['router bgp 65000', `neighbor 10.0.${k}.5`, 'remote-as 65103']);
    },
    recap: ['資料中心的 eBGP：Spine 共用一個 AS、每台 Leaf 自己一個；AS 重複會被迴圈偵測丟掉。', 'BGP 預設只用一條最佳路徑：要 maximum-paths 才會同時用所有的 Spine。'],
  },
  {
    id: 'l192', chapter: 22, title: 'Rail 接錯了', subtitle: 'GPU 叢集的後端網路：每張 GPU 一條 rail、用 LLDP 對線、整條路的 MTU',
    tags: ['GPU', 'AI', 'rail', '後端網路', 'LLDP', 'MTU', 'Jumbo Frame', 'Nexus'],
    brief: '新的 GPU 叢集昨天上架：三台訓練節點，每台四張 GPU，每張 GPU 有一個後端的 100G 埠（rdma1 – rdma4）。後端網路照 rail 的方式接：所有節點的 rdma1 都接到 Leaf-R1、rdma2 都接到 Leaf-R2…。今天第一個訓練工作一啟動就失敗：GPU-3 的第 2、3 張 GPU 連不到其他節點；另外，rail 4 上的大封包傳不過去，小封包卻沒事。機房的人說線「都有插、燈都有亮」。請找出接錯的線與設定，讓四條 rail 全部可以用。',
    given: [
      ['Rail 的設計', 'rail k：所有節點的 rdmak → Leaf-Rk · 網段 10.20.k.0/24 · Leaf-Rk 的 Eth1/n 接 GPU-n'],
      ['節點的位址', 'GPU-n 的 rdmak：10.20.k.(10+n)，例如 GPU-3 的 rdma2 是 10.20.2.13'],
      ['MTU', '後端網路全程 Jumbo Frame：節點的埠 9000、交換器的埠 9216'],
      ['Leaf 與 Spine', 'Leaf-R1 – R4 的 Eth1/31、1/32 上行到 Spine-1、Spine-2（eBGP，已經正常）'],
      ['這一關沒有', '前端（eth0 / eth1）與 BMC 的網路不在這張圖上：它們接在另外的交換器'],
    ],
    learn: [
      { t: '後端網路是 GPU 專用的', d: '一台訓練節點同時接四張網路：前端（使用者與排程）、後端（GPU 之間交換資料）、儲存、帶外管理。後端只跑 GPU 對 GPU 的 RDMA 流量，要求不掉封包、延遲穩定、超額訂閱比 1:1，所以獨立一組交換器，每張 GPU 配一個專用的埠。' },
      { t: '什麼是 rail', d: '把每台節點的「第 k 個後端埠」都接到同一台 Leaf，這一組就是 rail k。訓練時通常是各節點同編號的 GPU 互相交換資料，照 rail 接線之後這些流量在 Leaf 上一跳就到，不經過 Spine：延遲最短，也避開 ECMP 把大流量雜湊到同一條線的問題。' },
      { t: '燈亮不代表接對', d: '兩條線插反，兩端的燈一樣會亮、位址一樣設得上去。但 rdma2 被接到 rail 3 的 Leaf 之後，它和其他節點的 rdma2 不在同一個第二層網段，ARP 永遠沒有回應。上架之後一定要用 LLDP 逐埠核對：show lldp neighbors 列出每個埠對面是哪一台、哪一個埠。' },
      { t: 'MTU 要整條路一致', d: 'RDMA 用大封包（MTU 9000）。路上只要有一個埠還是 1500，小封包（ping、建立連線）都會通，資料一開始傳就卡住。Nexus 的 MTU 設在每個介面上（mtu 9216），用 ping -M do -s 8972 從主機測最準。' },
      { t: '怎麼驗證', d: '交換器：show lldp neighbors（對面是誰）、show interface status、show interface ethernet 1/2（看 MTU）。節點的終端機：ip -br addr、ip neigh、ping -M do -s 8972 <同一條 rail 上的另一台>。' },
    ],
    setup() {
      const gpu = (n, pos) => D('gpusrv', 'gpu' + n, {
        name: 'GPU-' + n, host: 'gpu-' + n, pos,
        init(d) { for (const k of [1, 2, 3, 4]) Object.assign(d.ifaces.find((i) => i.id === 'rdma' + k), { mode: 'static', ip: `10.20.${k}.${10 + n}`, mask: '255.255.255.0', mtu: 9000 }); },
      });
      const cables = [];
      for (const k of [1, 2, 3, 4]) {
        cables.push([`r${k}:Eth1/31`, `s1:Eth1/${k}`], [`r${k}:Eth1/32`, `s2:Eth1/${k}`]);
        for (const n of [1, 2, 3]) {
          // GPU-3 的 rdma2 與 rdma3 插反了
          const leaf = n === 3 && k === 2 ? 3 : n === 3 && k === 3 ? 2 : k;
          cables.push([`gpu${n}:rdma${k}`, `r${leaf}:Eth1/${n}`]);
        }
      }
      const s = makeState([
        D('n9332', 's1', { name: 'Spine-1', pos: [-5, -11] }), D('n9332', 's2', { name: 'Spine-2', pos: [5, -11] }),
        ...[1, 2, 3, 4].map((k) => D('n9332', 'r' + k, { name: 'Leaf-R' + k, pos: [-13.5 + k * 5.4, -5] })),
        gpu(1, [-9, 3]), gpu(2, [0, 3]), gpu(3, [9, 3]),
      ], cables);
      recompute(s);
      for (const k of [1, 2, 3, 4]) {
        cfg(s, 'r' + k, ['feature bgp', 'feature interface-vlan', 'vlan 10', `name RAIL-${k}`, 'exit',
          // rail 4 的 Eth1/2（GPU-2）沒有開 Jumbo：還是預設的 1500
          ...[1, 2, 3].flatMap((n) => [`interface Ethernet1/${n}`, 'switchport access vlan 10', ...(k === 4 && n === 2 ? [] : ['mtu 9216']), 'exit']),
          'interface Vlan10', `ip address 10.20.${k}.1/24`, 'no shutdown', 'exit',
          ...l3('Ethernet1/31', `10.0.1.${k * 2 - 1}/31`), ...l3('Ethernet1/32', `10.0.2.${k * 2 - 1}/31`),
          `router bgp ${65200 + k}`, `router-id 10.255.2.${k}`, 'address-family ipv4 unicast', `network 10.20.${k}.0/24`, 'maximum-paths 2', 'exit',
          ...nbr(`10.0.1.${k * 2 - 2}`, 65200), ...nbr(`10.0.2.${k * 2 - 2}`, 65200)]);
      }
      for (const j of [1, 2]) {
        cfg(s, 's' + j, ['feature bgp', ...[1, 2, 3, 4].flatMap((k) => l3(`Ethernet1/${k}`, `10.0.${j}.${k * 2 - 2}/31`)),
          'router bgp 65200', `router-id 10.255.0.${j}`, 'address-family ipv4 unicast', 'exit', ...[1, 2, 3, 4].flatMap((k) => nbr(`10.0.${j}.${k * 2 - 1}`, 65200 + k))]);
      }
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'ping', from: 'gpu1', ip: '10.20.2.13', label: 'rail 2：GPU-1 的第 2 張 GPU 碰得到 GPU-3 的（10.20.2.13）' },
      { type: 'ping', from: 'gpu2', ip: '10.20.3.13', label: 'rail 3：GPU-2 的第 3 張 GPU 碰得到 GPU-3 的（10.20.3.13）' },
      {
        type: 'check', label: '接線符合設計：每台節點的 rdmak 都接在 Leaf-Rk 的 Eth1/n（n 是節點的編號）',
        test(s) {
          for (const n of [1, 2, 3]) {
            for (const k of [1, 2, 3, 4]) {
              const c = s.cables.find((x) => (x.a.dev === 'gpu' + n && x.a.port === 'rdma' + k) || (x.b.dev === 'gpu' + n && x.b.port === 'rdma' + k));
              if (!c) return `GPU-${n} 的 rdma${k} 沒有接線`;
              const o = c.a.dev === 'gpu' + n ? c.b : c.a;
              if (o.dev !== 'r' + k || o.port !== 'Eth1/' + n) return `GPU-${n} 的 rdma${k} 接在 ${dev(s, o.dev) ? dev(s, o.dev).name : o.dev} 的 ${o.port}，應該接在 Leaf-R${k} 的 Eth1/${n}（在 Leaf 上 show lldp neighbors 可以看到每個埠對面是哪一個埠）`;
            }
          }
          return true;
        },
      },
      { type: 'ping', from: 'gpu2', ip: '10.20.4.11', size: 8972, df: true, label: 'rail 4：GPU-2 送得出 Jumbo Frame（ping -M do -s 8972 10.20.4.11）' },
      { type: 'ping', from: 'gpu1', ip: '10.20.1.12', size: 8972, df: true, label: 'rail 1 照常：GPU-1 與 GPU-2 之間的大封包傳得過去' },
    ],
    hints: [
      'Leaf-R2：show lldp neighbors。Eth1/3 對面應該是 gpu-3 的 rdma2，卻顯示 rdma3；Leaf-R3 的 Eth1/3 顯示 rdma2 —— GPU-3 的這兩條線插反了。把 GPU-3 的 rdma2 改接到 Leaf-R2 的 Eth1/3、rdma3 改接到 Leaf-R3 的 Eth1/3（先點線把它拔掉，再重新接）。',
      'rail 4：GPU-2 的終端機 ping 10.20.4.11 會通，ping -M do -s 8972 10.20.4.11 不通。Leaf-R4：show interface ethernet 1/2 的 MTU 是 1500，其他埠是 9216。',
      'Leaf-R4：configure terminal → interface ethernet 1/2 → mtu 9216。Nexus 的 MTU 是每個介面各自設定，新增的埠最容易漏掉。',
    ],
    solve(s) {
      const end = (n, k) => { const c = s.cables.find((x) => (x.a.dev === 'gpu' + n && x.a.port === 'rdma' + k) || (x.b.dev === 'gpu' + n && x.b.port === 'rdma' + k)); return c.a.dev === 'gpu' + n ? c.b : c.a; };
      Object.assign(end(3, 2), { dev: 'r2', port: 'Eth1/3' });
      Object.assign(end(3, 3), { dev: 'r3', port: 'Eth1/3' });
      cfg(s, 'r4', ['interface Ethernet1/2', 'mtu 9216']);
    },
    recap: ['rail：每台節點的第 k 個後端埠接同一台 Leaf，同編號的 GPU 一跳就到。上架後用 LLDP 逐埠核對，燈亮不代表接對。', 'RDMA 的網路全程 Jumbo Frame：Nexus 的 MTU 是每個介面各自設定。'],
  },
];
