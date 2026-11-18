// 第十章：故障排除。網路都已經「設定好了」，只是有人改壞了 — 找出問題並修正。
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { parseIp, fmtIp } from '../engine/ip.js';
import { transact, macOf } from '../engine/sim.js';
import { dev, ifc, swp, WEB } from './util.js';

export const CHAPTERS4 = [
  { id: 10, title: '故障排除', desc: '網路原本是好的，直到有人動過它。從症狀找出原因：IP 衝突、VLAN 與 Trunk、路由、NAT、ACL、DNS。' },
];

const NAS_MAC = macOf('nas', 'eth0');

export const LEVELS4 = [
  {
    id: 'l36', chapter: 10, title: '誰搶了我的 IP', subtitle: 'IP 衝突與 DHCP 保留位址', tags: ['IP 衝突', 'DHCP 保留', '位址規劃'],
    brief: '辦公室的同事抱怨連連：印表機時好時壞、NAS 的網路磁碟機三不五時要重新連線，還有一台新同事的筆電完全連不上。網路線都接好了，問題出在 IP 位址的規劃，把它們找出來修好。',
    given: [
      ['辦公室網段', '192.168.1.0/24'], ['路由器 LAN', '192.168.1.1（DHCP 伺服器）'], ['印表機', '固定 192.168.1.10（不要改）'],
      ['NAS', '要永遠是 192.168.1.50'], ['NAS 的 MAC', NAS_MAC],
    ],
    learn: [
      { t: 'IP 位址衝突', d: '同一個網段裡有兩台設備用同一個 IP，別人問「誰是這個 IP」時兩台都會回答，連線就時通時不通。點設備可以看到衝突的警告。' },
      { t: '固定 IP 要避開位址池', d: 'DHCP 伺服器不知道哪些 IP 已經被人手動占用。固定 IP 的設備必須放在位址池的範圍之外。' },
      { t: 'DHCP 保留位址', d: '想讓設備「自動取得」又「每次都一樣」，就在 DHCP 伺服器上把它的 MAC 位址綁定一個 IP。' },
      { t: '先看用戶端拿到什麼', d: '排查的第一步是 ipconfig：IP、遮罩、閘道對不對？是 DHCP 給的，還是有人手動填的？' },
    ],
    setup: () => makeState([
      D('isr4321', 'rt', {
        name: 'Router', pos: [0, -5],
        init(d) {
          Object.assign(d.ifaces[1], { ip: '192.168.1.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.1.10', end: '192.168.1.200', dns: '8.8.8.8' });
        },
      }),
      D('sw8', 'sw', { name: 'Switch', pos: [0, -0.5] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-9, 4], dhcp: true }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [-4.5, 5.2], dhcp: true }),
      D('printer', 'prn', { name: '印表機', pos: [0, 5.6], ip: '192.168.1.10', gw: '192.168.1.1' }),
      D('nas', 'nas', { name: 'NAS', pos: [4.5, 5.2], dhcp: true }),
      D('laptop', 'nb', { name: '新同事的筆電', pos: [9, 4], ip: '192.168.0.23', gw: '192.168.0.1', dns: '8.8.8.8' }),
    ], [['rt:Gi0/0/1', 'sw:1'], ['pc-1:eth0', 'sw:2'], ['pc-2:eth0', 'sw:3'], ['prn:eth0', 'sw:4'], ['nas:eth0', 'sw:5'], ['nb:eth0', 'sw:6']]),
    objectives: [
      {
        type: 'check', label: '網路上沒有任何 IP 位址衝突',
        test(s) {
          for (const d of Object.values(s.devices)) {
            for (const i of d.ifaces) if (i.rt.conflict) return `${d.name} 和 ${s.devices[i.rt.conflict].name} 都在用 ${fmtIp(i.rt.ip)}`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '印表機維持固定 IP 192.168.1.10，而且 PC-1 連得到它',
        test(s) {
          const ip = parseIp('192.168.1.10');
          if (!dev(s, 'prn').ifaces.some((i) => i.mode === 'static' && i.rt.ip === ip)) return '印表機的 IP 被改掉了，它應該固定在 192.168.1.10';
          const r = transact(s, 'pc-1', { proto: 'icmp', dst: ip });
          if (!r.ok) return r.reason;
          return r.responder === 'prn' || `回應 192.168.1.10 的不是印表機，而是 ${s.devices[r.responder].name}`;
        },
      },
      {
        type: 'check', label: 'NAS 用 DHCP 取得位址，而且固定拿到 192.168.1.50',
        test(s) {
          const i = dev(s, 'nas').ifaces[0];
          if (i.mode !== 'dhcp') return 'NAS 應該維持「自動取得」，由 DHCP 伺服器保留位址給它';
          return (i.rt.src === 'dhcp' && i.rt.ip === parseIp('192.168.1.50')) || `NAS 目前拿到的是 ${i.rt.ip != null ? fmtIp(i.rt.ip) : '（沒有 IP）'}，不是 192.168.1.50`;
        },
      },
      { type: 'tcp', from: 'nb', to: 'nas', port: 445, label: '新同事的筆電可以開啟 NAS 的共用資料夾' },
      { type: 'dhcp', dev: 'pc-2', subnet: '192.168.1.0/24', label: 'PC-2 仍然能自動取得 IP' },
    ],
    hints: [
      '點 PC-1 或印表機，設定頁面會出現「IP 位址衝突」的警告。再看 Router →「介面」→ Gi0/0/1 的 DHCP 範圍：它從 192.168.1.10 開始發，剛好撞到印表機。',
      '把 DHCP 的起始 IP 改成 192.168.1.100，前面的位址留給固定 IP 的設備。接著在同一個地方新增「保留位址」：MAC 填 NAS 的 MAC（左邊的已知資訊點一下可以複製），IP 填 192.168.1.50。',
      '新同事的筆電被手動填了 192.168.0.23，那是他家裡的網段。打開筆電的網路設定，把乙太網路改成「自動取得 (DHCP)」。',
    ],
    solve(s) {
      const d = ifc(s, 'rt', 'Gi0/0/1').dhcp;
      d.start = '192.168.1.100';
      d.reserved = [{ mac: NAS_MAC, ip: '192.168.1.50' }];
      dev(s, 'nb').ifaces[0].mode = 'dhcp';
    },
    recap: ['固定 IP 與 DHCP 位址池要分開規劃，常見的做法是把前段留給伺服器與印表機。', '保留位址讓設備維持自動取得，又有固定的 IP；換設備時只要改伺服器上的 MAC。'],
  },
  {
    id: 'l37', chapter: 10, title: '樓層之間又斷了', subtitle: 'Trunk、VLAN 與連接埠的排查', tags: ['Trunk', 'Native VLAN', 'shutdown', 'show 指令'],
    brief: '週末有人「整理」過二樓的交換器，週一早上二樓的業務部和研發部就連不到一樓的同事。線路沒有人動過，問題全在設定裡，而且不只一個。用交換器的設定頁，或 CLI 的 show 指令把它們找出來。',
    given: [
      ['業務部', 'VLAN 10 · 192.168.10.0/24'], ['研發部', 'VLAN 20 · 192.168.20.0/24'], ['樓層上行埠', '兩台都是 Gi0/9（Trunk）'],
      ['Native VLAN', '兩端都應該是 1'], ['排查用的指令', 'show interfaces status'], ['排查用的指令', 'show vlan brief'], ['排查用的指令', 'show interfaces trunk'],
    ],
    learn: [
      { t: '由下往上排查', d: '先看實體層與連接埠：有沒有燈號？埠是不是被停用 (shutdown)？再看 VLAN，最後才看 IP。' },
      { t: 'Trunk 的允許清單', d: 'Trunk 預設放行所有 VLAN。一旦有人下了 allowed vlan 10，其他 VLAN 的訊框到了這條線就被丟掉，而且不會有任何錯誤訊息。' },
      { t: 'Native VLAN 不一致', d: '沒有標籤的訊框，兩端會各自放進自己的 Native VLAN。兩端不同時，流量會悄悄跑到別的 VLAN，是安全與除錯上的大麻煩。' },
      { t: '常用的 show 指令', d: 'CLI 分頁的 show interfaces status、show vlan brief、show interfaces trunk，是排查第二層問題最常用的三個指令。' },
    ],
    setup: () => {
      const vl = (d) => d.sw.vlans.push({ id: 10, name: '業務' }, { id: 20, name: '研發' });
      return makeState([
        D('c2960', 'sw1', {
          name: 'SW-1F', pos: [-5.5, -1.5],
          init(d) { vl(d); d.sw.ports['Gi0/1'].vlan = 10; d.sw.ports['Gi0/2'].vlan = 20; d.sw.ports['Gi0/9'].mode = 'trunk'; },
        }),
        D('c2960', 'sw2', {
          name: 'SW-2F', pos: [5.5, -1.5],
          init(d) {
            vl(d);
            d.sw.vlans.push({ id: 99, name: '舊管理' });
            Object.assign(d.sw.ports['Gi0/1'], { vlan: 10, shut: true }); // 被停用
            d.sw.ports['Gi0/2'].vlan = 10; // 研發的電腦被放進業務的 VLAN
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: '10', native: 99 }); // 允許清單少了 20、Native 不一致
          },
        }),
        D('pc', 'pc-s1', { name: '1F 業務', pos: [-8.5, 3.4], ip: '192.168.10.11' }),
        D('pc', 'pc-r1', { name: '1F 研發', pos: [-3, 3.4], ip: '192.168.20.11' }),
        D('pc', 'pc-s2', { name: '2F 業務', pos: [3, 3.4], ip: '192.168.10.12' }),
        D('pc', 'pc-r2', { name: '2F 研發', pos: [8.5, 3.4], ip: '192.168.20.12' }),
      ], [['pc-s1:eth0', 'sw1:Gi0/1'], ['pc-r1:eth0', 'sw1:Gi0/2'], ['pc-s2:eth0', 'sw2:Gi0/1'], ['pc-r2:eth0', 'sw2:Gi0/2'], ['sw1:Gi0/9', 'sw2:Gi0/9']]);
    },
    objectives: [
      { type: 'ping', from: 'pc-s1', to: 'pc-s2', label: '一樓業務可以 ping 到二樓業務' },
      { type: 'ping', from: 'pc-r1', to: 'pc-r2', label: '一樓研發可以 ping 到二樓研發' },
      {
        type: 'check', label: '上行埠兩端的 Trunk 設定一致（模式與 Native VLAN）',
        test(s) {
          const a = swp(s, 'sw1', 'Gi0/9'), b = swp(s, 'sw2', 'Gi0/9');
          if (a.mode !== 'trunk' || b.mode !== 'trunk') return '上行埠 Gi0/9 兩端都要是 Trunk';
          return a.native === b.native || `Native VLAN 不一致：SW-1F 是 ${a.native}，SW-2F 是 ${b.native}`;
        },
      },
    ],
    hints: [
      'SW-2F →「連接埠」→ Gi0/1：進階設定裡的「停用此連接埠」被打勾了（CLI 的 show interfaces status 會顯示 disabled）。取消勾選，或在 CLI 輸入 conf t → interface gi0/1 → no shutdown。',
      'SW-2F 的 Gi0/2 接的是研發部的電腦，卻被放在 VLAN 10。把它改回 VLAN 20（show vlan brief 可以看到每個埠屬於哪個 VLAN）。',
      'SW-2F 的上行埠 Gi0/9 有兩個問題：「允許的 VLAN」只剩 10，研發的 VLAN 20 過不去，改回 all；Native VLAN 被改成 99，和一樓的 1 不一致，改回 1。兩台都下 show interfaces trunk 比對就看得出來。',
    ],
    solve(s) {
      swp(s, 'sw2', 'Gi0/1').shut = false;
      swp(s, 'sw2', 'Gi0/2').vlan = 20;
      Object.assign(swp(s, 'sw2', 'Gi0/9'), { allowed: 'all', native: 1 });
    },
    recap: ['排查時一次只改一個地方，改完就重新測試，才知道是哪個修正生效。', '同一條 Trunk 兩端的模式、Native VLAN 與允許清單都要對得起來。'],
  },
  {
    id: 'l38', chapter: 10, title: '分公司的求救電話', subtitle: '閘道、路由、NAT、ACL 與 DNS', tags: ['tracert', '回程路由', 'NAT', 'ACL', 'DNS'],
    brief: '分公司打電話來：ERP 打不開、網站也上不去。總公司這邊也有人說上不了網。上週有外包廠商調整過兩地的設備，留下了好幾個錯誤，分散在電腦和路由器上。從用戶端開始，一站一站往外查。',
    given: [
      ['專線', '172.16.0.0/30（總公司 .1、分公司 .2）'], ['總公司 LAN', '10.1.0.0/24，閘道 10.1.0.1'], ['分公司 LAN', '10.2.0.0/24，閘道 10.2.0.1'],
      ['ERP 伺服器', '10.1.0.10'], ['可用的 DNS', '8.8.8.8'], ['排查工具', '終端機的 ping、tracert、nslookup'],
    ],
    learn: [
      { t: '一次排一層', d: '先確認用戶端自己的 IP、遮罩、閘道，再一站一站往外查。tracert 會告訴你封包走到哪一台就停了。' },
      { t: 'ping 通不代表服務通', d: 'ping 只測 ICMP。ACL 或防火牆可能只放行 ICMP，卻擋掉 TCP 443。要用實際的服務（curl）再測一次。' },
      { t: '去得了，回得來嗎', d: '單向的路由錯誤最難發現：封包到了目的地，回應卻被送往錯誤的方向。兩端的路由表都要看。' },
      { t: '名稱解析也是一個環節', d: 'ping 8.8.8.8 會通、開網站卻不行，通常是 DNS 的問題。nslookup 可以單獨測試。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [-7, -9.5] }), 'line1', {
        type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34',
      }),
      D('isr4331', 'hq', {
        name: 'HQ-Router', pos: [-7, -4.5],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33', nat: false }); // 少了 NAT
          Object.assign(d.ifaces[1], { ip: '10.1.0.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[2], { ip: '172.16.0.1', mask: '255.255.255.252' });
          d.ifaces[2].aclIn = [{ action: 'permit', proto: 'icmp', src: 'any', dst: 'any', port: '' }]; // 測試用的 ACL 忘了拿掉
          d.routes.push({ dst: '10.3.0.0', mask: '255.255.255.0', via: '172.16.0.2', ad: '' }); // 回程路由打錯網段
        },
      }),
      D('isr4321', 'br', {
        name: 'Branch-Router', pos: [7, -4.5],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '172.16.0.2', mask: '255.255.255.252' });
          Object.assign(d.ifaces[1], { ip: '10.2.0.1', mask: '255.255.255.0' });
          d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '172.16.0.1', ad: '' });
        },
      }),
      D('sw5', 'hq-sw', { name: 'HQ-Switch', pos: [-7, 0.3] }),
      D('sw5', 'br-sw', { name: 'BR-Switch', pos: [7, 0.3] }),
      D('tower', 'erp', { name: 'ERP 伺服器', pos: [-10.5, 4.8], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
      D('pc', 'hq-pc', { name: '總公司 PC', pos: [-4, 4.8], ip: '10.1.0.50', gw: '10.1.0.1', dns: '10.1.0.1' }), // DNS 指到不提供 DNS 的路由器
      D('pc', 'br-pc', { name: '分公司 PC', pos: [7, 4.8], ip: '10.2.0.50', gw: '10.2.0.254', dns: '8.8.8.8' }), // 閘道打錯
    ], [
      ['inet:line1', 'hq:Gi0/0/0'], ['hq:Gi0/0/1', 'hq-sw:1'], ['erp:eth0', 'hq-sw:2'], ['hq-pc:eth0', 'hq-sw:3'],
      ['hq:Gi0/0/2', 'br:Gi0/0/0'], ['br:Gi0/0/1', 'br-sw:1'], ['br-pc:eth0', 'br-sw:2'],
    ]),
    objectives: [
      { type: 'ping', from: 'br-pc', to: 'erp', label: '分公司 PC 可以 ping 到 ERP 伺服器' },
      { type: 'tcp', from: 'br-pc', to: 'erp', port: 443, label: '分公司 PC 可以使用 ERP (HTTPS)' },
      { type: 'tcp', from: 'hq-pc', name: 'www.example.com', port: 443, label: '總公司 PC 可以上網（https://www.example.com）' },
      { type: 'tcp', from: 'br-pc', name: 'www.example.com', port: 443, label: '分公司 PC 可以經由總公司上網' },
    ],
    hints: [
      '從用戶端開始：分公司 PC 的預設閘道填成了 10.2.0.254，但分公司路由器是 10.2.0.1。在它的終端機 ping 10.2.0.1、tracert 10.1.0.10，可以看出封包卡在哪一站。',
      'HQ-Router →「路由」：回程路由寫成了 10.3.0.0，應該是分公司的 10.2.0.0。另外它對外的 Gi0/0/0 沒有勾 NAT，私有 IP 出不了網際網路。',
      'ping 得到 ERP、HTTPS 卻不通？看 HQ-Router →「ACL」：Gi0/0/2 的進入方向只放行了 icmp，其他全被隱含拒絕，把這條測試用的規則刪掉。最後，總公司 PC 的 DNS 指向 10.1.0.1，但這台路由器不提供 DNS，改成 8.8.8.8。',
    ],
    solve(s) {
      dev(s, 'br-pc').ifaces[0].gateway = '10.2.0.1';
      dev(s, 'hq').routes[0].dst = '10.2.0.0';
      ifc(s, 'hq', 'Gi0/0/0').nat = true;
      ifc(s, 'hq', 'Gi0/0/2').aclIn = [];
      dev(s, 'hq-pc').ifaces[0].dns = '8.8.8.8';
    },
    recap: ['故障排除的方法：確認問題 → 提出假設 → 驗證 → 修正 → 確認整體恢復 → 記錄。', '一個症狀背後可能有好幾個原因。修好一個之後要重新測試，不要假設問題只有一個。'],
  },
];
