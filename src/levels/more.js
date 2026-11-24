// 補充關卡：一對一 NAT、光纖與距離、ARP 欺騙、BPDU Guard、802.1X、IPv6
import { makeDevice as D, makeState, setLine, newSsid, removeCable } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { parseCidr6, net6 } from '../engine/ip6.js';
import { transact } from '../engine/sim.js';
import { dev, ifc, link, swp, WEB } from './util.js';

export const CHAPTERS3 = [
  { id: 9, title: 'IPv6', desc: '位址類型、SLAAC 與 DHCPv6、IPv6 路由與 OSPFv3、雙協定與 IPv6 ACL。' },
];

export const LEVELS3 = [
  // ════════════════════════ 第三章補充 ════════════════════════
  {
    id: 'l29', chapter: 3, title: '對外伺服器群', subtitle: '一對一靜態 NAT', tags: ['Static NAT', '公用 IP 區段'],
    brief: '公司向 ISP 多租了一段公用 IP，要讓網站與郵件伺服器各自擁有一個固定的對外位址。連接埠轉發只能共用路由器自己的 IP，這次要用一對一的靜態 NAT：整個公用 IP 對應到一台內部伺服器。',
    given: [
      ['ISP 配發區段', '203.0.113.8/29（.10 – .14 可用）'], ['路由器 WAN', '203.0.113.10（已完成）'],
      ['網站伺服器', '192.168.10.11 ↔ 203.0.113.11'], ['郵件伺服器', '192.168.10.12 ↔ 203.0.113.12'],
    ],
    learn: [
      { t: '靜態 NAT', d: '一個內部位址固定對應一個公用位址，進出都換成同一個 IP。外面看起來，這台伺服器就像直接擁有那個公用 IP。' },
      { t: '和 PAT 的差別', d: 'PAT 是很多台共用一個 IP、靠連接埠區分，只能由內部發起；靜態 NAT 是一對一，外面可以主動連進來。' },
      { t: '誰回應 ARP', d: '這些公用 IP 和路由器的 WAN 在同一個網段。ISP 會用 ARP 找它們，所以路由器必須替這些位址回應。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -8.5] }), 'line1', { type: 'static', gw: '203.0.113.9', mask: '255.255.255.248', assign: '203.0.113.10' }),
      D('isr4331', 'rt', {
        name: 'Router', pos: [0, -4],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.248', gateway: '203.0.113.9', nat: true });
          Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.10.100', end: '192.168.10.199', dns: '8.8.8.8' });
        },
      }),
      D('sw8', 'sw', { name: 'Switch', pos: [0, 0.5] }),
      D('tower', 'web', { name: '網站伺服器', pos: [-7, 4.5], ip: '192.168.10.11', gw: '192.168.10.1', dns: '8.8.8.8', services: WEB }),
      D('tower', 'mail', { name: '郵件伺服器', pos: [-1.5, 5.6], ip: '192.168.10.12', gw: '192.168.10.1', dns: '8.8.8.8', services: [{ proto: 'tcp', port: 25, name: 'SMTP 郵件' }] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [5.5, 4.5], dhcp: true }),
    ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ['web:eth0', 'sw:2'], ['mail:eth0', 'sw:3'], ['pc-1:eth0', 'sw:4']]),
    objectives: [
      { type: 'tcp', from: 'inet', ip: '203.0.113.11', port: 443, label: '外部使用者可以開啟 https://203.0.113.11（網站）' },
      { type: 'tcp', from: 'inet', ip: '203.0.113.12', port: 25, label: '外部郵件伺服器可以寄信到 203.0.113.12（SMTP 25）' },
      {
        type: 'check', label: '網站伺服器對外連線時，來源也是 203.0.113.11',
        test(s) {
          const r = transact(s, 'web', { proto: 'icmp', dst: parseIp('8.8.8.8') });
          if (!r.ok) return '網站伺服器目前連不到網際網路：' + r.reason;
          return r.seenSrc === parseIp('203.0.113.11') || '網站伺服器出去時用的是路由器的 IP，而不是它自己的 203.0.113.11';
        },
      },
      { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443, label: '一般電腦仍然用 PAT 共用路由器的 IP 上網' },
    ],
    hints: [
      'Router →「NAT / 轉發」分頁，找到「靜態 NAT（一對一）」。',
      '新增一筆：公用 IP 203.0.113.11 ↔ 內部 IP 192.168.10.11。',
      '再新增一筆：203.0.113.12 ↔ 192.168.10.12。不需要設定連接埠，整個 IP 的流量都會轉過去。',
    ],
    solve(s) {
      dev(s, 'rt').staticNat.push({ pub: '203.0.113.11', priv: '192.168.10.11' }, { pub: '203.0.113.12', priv: '192.168.10.12' });
    },
    recap: ['靜態 NAT 一對一、雙向都生效；PAT 多對一、只能由內部發起。', '一對一 NAT 會把伺服器所有的埠都暴露出去，實務上要搭配 ACL 或防火牆。'],
  },

  // ════════════════════════ 第四章補充 ════════════════════════
  {
    id: 'l30', chapter: 4, title: '跨棟連線', subtitle: '銅纜、多模與單模光纖', tags: ['光纖', '傳輸距離', '收發器'],
    brief: '公司擴建，B 棟和倉庫都要連回 A 棟的機房。前任拉了一條 Cat6 到 B 棟，兩端的燈卻始終不亮。請依照距離選對線材，把三個地點接起來。預算有限，能用便宜的多模光纖就不要用單模。',
    given: [
      ['A 棟 ↔ B 棟', '800 公尺'], ['A 棟 ↔ 倉庫', '250 公尺'], ['Cat6 銅纜', '最長 100 公尺'],
      ['多模光纖 + SR', '最長 300 公尺（便宜）'], ['單模光纖 + LR', '最長 10 公里（貴）'], ['光纖要接在', 'SFP 埠（A / B 棟的 Te1/1/x、倉庫的 Gi0/11 – 12）'],
    ],
    learn: [
      { t: '銅纜的 100 公尺限制', d: '雙絞線超過 100 公尺，訊號衰減就大到無法辨識，連燈號都不會亮。這是實體層最常見的規劃錯誤。' },
      { t: '多模與單模', d: '多模光纖 (MMF) 的纖芯較粗，搭配便宜的 SR 收發器，適合幾百公尺內；單模 (SMF) 纖芯極細，搭配 LR 收發器可以傳數公里以上。' },
      { t: '兩端要成對', d: '光纖的種類和兩端的收發器必須一致。實務上外皮顏色就能分辨：多模是水藍色，單模是黃色。' },
    ],
    setup: () => {
      const s = makeState([
        D('c9300', 'core-a', { name: 'A 棟核心', host: 'CORE-A', pos: [-7, -3] }),
        D('tower', 'srv', { name: '伺服器', pos: [-10.5, 2.5], ip: '192.168.1.10' }),
        D('c9300', 'sw-b', { name: 'B 棟交換器', host: 'SW-B', pos: [7.5, -3] }),
        D('pc', 'pc-b', { name: 'B 棟 PC', pos: [7.5, 2.5], ip: '192.168.1.21' }),
        D('c2960', 'sw-w', { name: '倉庫交換器', host: 'SW-WH', pos: [0, 4] }),
        D('pc', 'pc-w', { name: '倉庫 PC', pos: [0, 8.8], ip: '192.168.1.31' }),
      ], [['srv:eth0', 'core-a:Gi1/0/1'], ['pc-b:eth0', 'sw-b:Gi1/0/1'], ['pc-w:eth0', 'sw-w:Gi0/1'], ['core-a:Gi1/0/24', 'sw-b:Gi1/0/24']]);
      s.dist = { 'core-a|sw-b': 800, 'core-a|sw-w': 250, 'sw-b|sw-w': 700 };
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc-b', to: 'srv', label: 'B 棟 PC 可以 ping 到 A 棟的伺服器' },
      { type: 'ping', from: 'pc-w', to: 'srv', label: '倉庫 PC 可以 ping 到 A 棟的伺服器' },
      {
        type: 'check', label: '倉庫那一段使用多模光纖（250 公尺用不到單模）',
        test(s) {
          const c = s.cables.find((x) => [x.a.dev, x.b.dev].sort().join('|') === 'core-a|sw-w' && s.rt.cable[x.id] !== 'down');
          if (!c) return 'A 棟和倉庫之間還沒有可用的連線';
          return c.kind === 'mmf' || '這一段只有 250 公尺，多模光纖就夠了，單模的收發器貴很多';
        },
      },
    ],
    hints: [
      '點一下 A 棟到 B 棟那條灰色的線：Cat6 最長只能拉 100 公尺。把它拔掉。',
      '從 A 棟核心拖曳到 B 棟交換器，兩邊都選 SFP 埠（Te1/1/1），線材選「單模光纖」。',
      '從 A 棟核心拖曳到倉庫交換器，A 棟選 Te1/1/2、倉庫選 Gi0/11，線材選「多模光纖」。',
    ],
    solve(s) {
      removeCable(s, s.cables.find((c) => c.a.port === 'Gi1/0/24').id);
      link(s, 'core-a:Te1/1/1', 'sw-b:Te1/1/1', 'smf');
      link(s, 'core-a:Te1/1/2', 'sw-w:Gi0/11', 'mmf');
    },
    recap: ['線沒選對，上面所有的設定都是白費工。先確認距離與介面規格。', '銅纜 100 公尺、多模幾百公尺、單模以公里計。'],
  },

  // ════════════════════════ 第六章補充 ════════════════════════
  {
    id: 'l31', chapter: 6, title: '冒牌閘道', subtitle: 'ARP 欺騙與 Dynamic ARP Inspection', tags: ['ARP Spoofing', 'DAI', '中間人攻擊'],
    brief: '使用者抱怨網路時好時壞。你抓了封包發現：有一台不明筆電把自己的 IP 設成閘道的位址，搶著回應 ARP，於是大家要上網的封包都送到它那裡去了。這就是 ARP 欺騙。請讓交換器只接受合法的 ARP。',
    given: [['合法閘道', 'Router 192.168.10.1（交換器的 Gi0/10）'], ['不明筆電', '自稱 192.168.10.1，接在 Gi0/2，無法設定它'], ['電腦', '都是 DHCP 用戶端']],
    learn: [
      { t: 'ARP 欺騙', d: 'ARP 沒有任何驗證，誰回答就信誰。攻擊者只要搶先回應「我是閘道」，就能攔截整個網段的流量，進行竊聽或竄改（中間人攻擊）。' },
      { t: 'Dynamic ARP Inspection', d: '交換器拿 DHCP Snooping 記下的「IP ↔ MAC ↔ 埠」綁定表來核對 ARP。不信任的埠送來的 ARP 如果對不上紀錄，就直接丟掉。' },
      { t: '固定 IP 的設備', d: '路由器、伺服器這類不是用 DHCP 的設備沒有綁定紀錄，所以它們所在的埠要設成信任埠。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [-8, -8] }), 'line1', { type: 'static', gw: '203.0.113.9', mask: '255.255.255.248', assign: '203.0.113.10' }),
      D('erx', 'rt', {
        name: 'Router', pos: [-8, -3.5],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.248', gateway: '203.0.113.9', nat: true });
          Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.10.100', end: '192.168.10.199', dns: '8.8.8.8' });
        },
      }),
      D('c2960', 'sw', { name: 'Switch', pos: [0, -3.5] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-5.5, 2.5], dhcp: true }),
      D('laptop', 'bad', { name: '不明筆電', pos: [0.5, 3.8], ip: '192.168.10.1', locked: true }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [6.5, 2.5], dhcp: true }),
    ], [['inet:line1', 'rt:eth0'], ['rt:eth1', 'sw:Gi0/10'], ['pc-1:eth0', 'sw:Gi0/1'], ['bad:eth0', 'sw:Gi0/2'], ['pc-2:eth0', 'sw:Gi0/3']]),
    objectives: [
      { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443, label: 'PC-1 可以正常上網' },
      { type: 'ping', from: 'pc-2', ip: '8.8.8.8', label: 'PC-2 可以 ping 到 8.8.8.8' },
      {
        type: 'check', label: '交換器啟用 DHCP Snooping 與 DAI，只有上行埠 Gi0/10 是信任埠',
        test(s) {
          const sw = dev(s, 'sw').sw;
          if (!sw.snoop.on) return 'DAI 要靠 DHCP Snooping 的綁定表才能運作，請先啟用 DHCP Snooping';
          if (!sw.dai || !sw.dai.on) return '還沒有啟用 Dynamic ARP Inspection';
          if (!sw.ports['Gi0/10'].trust) return '路由器是固定 IP，沒有 DHCP 綁定紀錄，Gi0/10 必須是信任埠';
          const extra = Object.entries(sw.ports).find(([p, c]) => c.trust && p !== 'Gi0/10');
          return !extra || `${extra[0]} 不應該是信任埠`;
        },
      },
    ],
    hints: [
      '先按「執行測試」看封包追蹤：ARP 找到兩台都自稱 192.168.10.1 的設備，封包被送到不明筆電。',
      '交換器 →「安全」分頁：開啟 DHCP Snooping，再開啟 Dynamic ARP Inspection。',
      '到「連接埠」分頁展開 Gi0/10 的進階設定，勾選信任埠。否則連合法路由器的 ARP 也會被丟掉。',
    ],
    solve(s) {
      const sw = dev(s, 'sw').sw;
      sw.snoop.on = true; sw.dai.on = true;
      sw.ports['Gi0/10'].trust = true;
    },
    recap: ['DHCP Snooping 建立綁定表，DAI 用它來驗證 ARP，兩者是一組的。', '信任埠只給上行連線與固定 IP 的基礎設備。'],
  },
  {
    id: 'l32', chapter: 6, title: '搶走根橋', subtitle: 'BPDU Guard', tags: ['BPDU Guard', 'STP 防護'],
    brief: '有人在會議室的網路孔接了一台自己帶來的交換器，它的 STP 優先權被設成 0，結果當選了根橋，整個網路的流量都改道繞經會議室，後面還掛著一台不明筆電。請讓接使用者的連接埠一發現對面是交換器就自動關閉。',
    given: [['會議室網路孔', 'SW-A 的 Gi0/5'], ['要求', '這個埠之後還要給同事的筆電使用，不能直接停用'], ['不明的交換器', '優先權 0，無法設定它']],
    learn: [
      { t: '根橋被搶走', d: 'STP 只比優先權和 MAC，誰的數字小誰就當根橋。任何人接上一台優先權更低的交換器，都能改變整個網路的流量路徑。' },
      { t: 'BPDU Guard', d: '接使用者的埠不應該收到 BPDU（只有交換器才會發）。啟用 BPDU Guard 後，一收到 BPDU 就把埠關掉 (err-disabled)。通常和 PortFast 一起用在所有 Access 埠上。' },
    ],
    setup: () => {
      const tr = (d) => { d.sw.ports['Gi0/9'].mode = 'trunk'; };
      return makeState([
        D('c2960', 'sw-c', { name: 'SW-Core', pos: [0, -5], init(d) { tr(d); d.sw.stp.prio = 4096; } }),
        D('nas', 'srv', { name: '檔案伺服器', pos: [6.5, -7.5], ip: '192.168.1.10' }),
        D('c2960', 'sw-a', { name: 'SW-A', pos: [0, -0.5], init: tr }),
        D('pc', 'pc-a', { name: 'PC-A', pos: [-6.5, 4], ip: '192.168.1.21' }),
        D('c2960', 'rogue', { name: '不明的交換器', host: 'Switch', pos: [4.5, 3.6], locked: true, init(d) { d.sw.stp.prio = 0; } }),
        D('laptop', 'bad', { name: '不明筆電', pos: [8.6, 7], ip: '192.168.1.66', locked: true }),
      ], [['sw-c:Gi0/9', 'sw-a:Gi0/9'], ['srv:eth0', 'sw-c:Gi0/1'], ['pc-a:eth0', 'sw-a:Gi0/1'], ['rogue:Gi0/1', 'sw-a:Gi0/5'], ['bad:eth0', 'rogue:Gi0/2']]);
    },
    objectives: [
      { type: 'ping', from: 'pc-a', to: 'srv', label: 'PC-A 可以 ping 到檔案伺服器' },
      {
        type: 'check', label: 'SW-Core 仍然是根橋',
        test(s) {
          const root = dev(s, 'sw-c').rt.stp.root[1];
          return !root || root === 'sw-c' || `根橋被 ${dev(s, root).name} 搶走了`;
        },
      },
      { type: 'tcp', from: 'bad', to: 'srv', port: 445, expect: false, label: '不明筆電連不到檔案伺服器' },
      {
        type: 'check', label: '會議室的 Gi0/5 啟用 BPDU Guard，而且沒有被手動停用',
        test(s) {
          const p = swp(s, 'sw-a', 'Gi0/5');
          if (p.shut) return 'Gi0/5 被手動停用了，但這個網路孔之後還要給同事使用';
          return !!p.bpduguard || 'Gi0/5 還沒有啟用 BPDU Guard';
        },
      },
    ],
    hints: [
      '點 SW-Core →「安全」分頁，可以看到目前的根橋是那台不明的交換器。',
      '點 SW-A →「連接埠」，展開 Gi0/5 的進階設定。',
      '勾選「BPDU Guard」。交換器一收到對面送來的 BPDU，就會把這個埠關掉。',
    ],
    solve(s) { swp(s, 'sw-a', 'Gi0/5').bpduguard = true; },
    recap: ['BPDU Guard 保護的是 STP 的拓撲，也順便擋掉私接的交換器。', '對面換回一般電腦之後，把埠重新啟用就能恢復。'],
  },
  {
    id: 'l33', chapter: 6, title: '你是誰？', subtitle: '802.1X 與 RADIUS', tags: ['802.1X', 'RADIUS', 'AAA', 'WPA2-Enterprise'],
    brief: '公司的 Wi-Fi 多年來都用同一組共用密碼，離職員工也還連得上；有線網路更是插了就能用。請導入 802.1X：每個人用自己的帳號登入，由 RADIUS 伺服器統一驗證，有線和無線都一樣。',
    given: [
      ['RADIUS 伺服器', '192.168.10.5'], ['共用密鑰', 'Radius#Key2026'], ['帳號', 'alice / Alice#2026、bob / Bob#2026'],
      ['員工 PC', '已輸入 alice 的帳密（Gi0/1）'], ['員工筆電', '已輸入 bob 的帳密，連 SSID「Corp」'], ['要驗證的埠', 'Gi0/1、Gi0/2（接使用者）'],
    ],
    learn: [
      { t: 'AAA', d: 'Authentication（你是誰）、Authorization（你能做什麼）、Accounting（你做了什麼）。集中在一台伺服器上管理，帳號停用就全面失效。' },
      { t: '802.1X 的三個角色', d: 'Supplicant（用戶端）、Authenticator（交換器或基地台）、Authentication Server（RADIUS）。驗證通過之前，連接埠只放行驗證用的封包。' },
      { t: 'WPA2-Enterprise', d: '無線版的 802.1X。每個人用自己的帳號登入，不再有一組大家都知道的密碼。' },
    ],
    setup: () => makeState([
      D('erx', 'rt', {
        name: 'Router', pos: [-7.5, -5],
        init(d) {
          Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.10.100', end: '192.168.10.199', dns: '8.8.8.8' });
        },
      }),
      D('c2960p', 'sw', { name: 'Switch', pos: [0, -4], init(d) { Object.assign(d.ifaces[0], { ip: '192.168.10.2', mask: '255.255.255.0' }); } }),
      D('tower', 'aaa', { name: 'RADIUS 伺服器', pos: [7.5, -4.6], ip: '192.168.10.5', init(d) { d.radiusServer = { secret: '', users: [] }; } }),
      D('pc', 'pc-1', { name: '員工 PC', pos: [-7, 1.6], dhcp: true, init(d) { d.dot1x = { user: 'alice', pass: 'Alice#2026' }; } }),
      D('laptop', 'bad', { name: '訪客筆電', pos: [-2.6, 4.4], ip: '192.168.10.66', locked: true }),
      D('ap', 'ap', { name: 'AP', pos: [3.6, 1.4], init(d) { d.wifi.ssids = [newSsid({ name: 'Corp', sec: 'wpa2', pass: 'OldSharedKey2020' })]; } }),
      D('laptop', 'nb', { name: '員工筆電', pos: [6.8, 6], wifi: { ssid: 'Corp', user: 'bob', pass: 'Bob#2026' } }),
    ], [['rt:eth1', 'sw:Gi0/10'], ['pc-1:eth0', 'sw:Gi0/1'], ['bad:eth0', 'sw:Gi0/2'], ['aaa:eth0', 'sw:Gi0/3'], ['ap:eth0', 'sw:Gi0/4']]),
    objectives: [
      { type: 'ping', from: 'pc-1', ip: '192.168.10.1', label: '員工 PC 通過驗證後可以上線' },
      { type: 'ping', from: 'bad', ip: '192.168.10.1', expect: false, label: '沒有帳號的訪客筆電被擋在外面' },
      { type: 'ping', from: 'nb', ip: '192.168.10.1', label: '員工筆電用自己的帳號連上 Corp 無線網路' },
      {
        type: 'check', label: 'Gi0/1、Gi0/2 啟用 802.1X，Corp 改用 WPA2-Enterprise',
        test(s) {
          for (const p of ['Gi0/1', 'Gi0/2']) if (!swp(s, 'sw', p).dot1x) return `${p} 還沒有啟用 802.1X`;
          const x = dev(s, 'ap').wifi.ssids.find((y) => y.name === 'Corp');
          return (x && x.sec === 'wpa2ent') || 'Corp 仍然使用共用密碼，請改成 WPA2-Enterprise';
        },
      },
    ],
    hints: [
      'RADIUS 伺服器 →「RADIUS」分頁：共用密鑰填 Radius#Key2026，新增 alice 與 bob 兩個帳號。',
      'Switch →「管理」分頁填 RADIUS 伺服器 192.168.10.5 與同一組密鑰；再到「連接埠」展開 Gi0/1、Gi0/2，勾選 802.1X。',
      'AP →「無線網路」：Corp 的加密方式改成 WPA2-Enterprise，下方填入 RADIUS 伺服器 192.168.10.5 與密鑰。',
    ],
    solve(s) {
      const key = 'Radius#Key2026';
      dev(s, 'aaa').radiusServer = { secret: key, users: [{ user: 'alice', pass: 'Alice#2026' }, { user: 'bob', pass: 'Bob#2026' }] };
      dev(s, 'sw').radius = { ip: '192.168.10.5', secret: key };
      swp(s, 'sw', 'Gi0/1').dot1x = true; swp(s, 'sw', 'Gi0/2').dot1x = true;
      dev(s, 'ap').radius = { ip: '192.168.10.5', secret: key };
      dev(s, 'ap').wifi.ssids[0].sec = 'wpa2ent';
    },
    recap: ['共用密碼無法追究是誰，也無法只撤銷一個人。802.1X 讓每個連線都對應到一個帳號。', 'RADIUS 伺服器所在的埠不能開 802.1X，否則它自己就上不了線。'],
  },

  // ════════════════════════ 第九章：IPv6 ════════════════════════
  {
    id: 'l34', chapter: 9, title: 'IPv6 初體驗', subtitle: 'Link-local、全域位址與 SLAAC', tags: ['IPv6', 'SLAAC', 'Router Advertisement'],
    brief: '公司開始導入 IPv6。這個網路還沒有任何 IPv6 設定。請在路由器上設定兩個網段的位址並啟用 IPv6 路由，讓電腦自動產生位址，再替伺服器手動設定一個固定的位址。',
    given: [
      ['A 網段（Gi0/0/0）', '2001:db8:a::/64 · 路由器用 ::1'], ['B 網段（Gi0/0/1）', '2001:db8:b::/64 · 路由器用 ::1'],
      ['伺服器', '2001:db8:a::10/64（手動）'], ['電腦', '自動取得 (SLAAC)，已經設定好'],
    ],
    learn: [
      { t: 'IPv6 位址', d: '128 位元，寫成 8 組十六進位。開頭的 0 可以省略，一長串連續的 0 可以用 :: 代替一次。2001:db8::/32 是文件範例專用的區段。' },
      { t: 'Link-local', d: '每個啟用 IPv6 的介面都會自動有一個 fe80:: 開頭的位址，只在同一條鏈路上有效，路由器不會轉送它。' },
      { t: 'SLAAC', d: '路由器定期送出 Router Advertisement (RA) 公告網段前綴，電腦用前綴加上自己的介面識別碼組出位址，並把路由器當成預設閘道，不需要 DHCP。' },
    ],
    setup: () => {
      const s = makeState([
        D('isr4321', 'rt', { name: 'Router', pos: [0, -4] }),
        D('sw5', 'sw', { name: 'Switch', pos: [-5, 0] }),
        D('pc', 'pc-a', { name: 'PC-A', pos: [-8.5, 4.6] }),
        D('tower', 'srv', { name: '伺服器', pos: [-2.5, 5], init(d) { d.ifaces[0].mode6 = 'static'; } }),
        D('pc', 'pc-b', { name: 'PC-B', pos: [6.5, 1.5] }),
      ], [['rt:Gi0/0/0', 'sw:1'], ['pc-a:eth0', 'sw:2'], ['srv:eth0', 'sw:3'], ['pc-b:eth0', 'rt:Gi0/0/1']]);
      s.v6 = true;
      return s;
    },
    objectives: [
      {
        type: 'check', label: 'PC-A 透過 SLAAC 自動取得 2001:db8:a::/64 的位址',
        test(s) {
          const v = dev(s, 'pc-a').ifaces[0].rt.v6;
          const a = v.addrs.find((x) => x.src === 'slaac');
          if (!a) return 'PC-A 還沒有自動產生位址：' + (v.note || '沒有收到 RA');
          return net6(a.ip, 64) === parseCidr6('2001:db8:a::/64').ip || 'PC-A 拿到的前綴不是 2001:db8:a::/64';
        },
      },
      { type: 'ping6', from: 'pc-a', ip6: '2001:db8:a::10', label: 'PC-A 可以 ping 到伺服器 2001:db8:a::10' },
      { type: 'ping6', from: 'pc-b', ip6: '2001:db8:a::10', label: 'PC-B 可以跨網段 ping 到伺服器' },
      { type: 'ping6', from: 'srv', to: 'pc-b', label: '伺服器可以 ping 到 PC-B' },
    ],
    hints: [
      'Router →「介面」：Gi0/0/0 的 IPv6 位址填 2001:db8:a::1/64，Gi0/0/1 填 2001:db8:b::1/64，兩個介面都開啟「發送 RA」。',
      'Router →「路由」：開啟「IPv6 路由 (ipv6 unicast-routing)」。沒開的話路由器不轉送 IPv6，也不會發送 RA。',
      '伺服器 →「網路設定」的 IPv6：手動，位址 2001:db8:a::10/64，閘道 2001:db8:a::1。',
    ],
    solve(s) {
      const r = dev(s, 'rt');
      r.v6routing = true;
      Object.assign(r.ifaces[0], { ip6: '2001:db8:a::1/64', ra: true });
      Object.assign(r.ifaces[1], { ip6: '2001:db8:b::1/64', ra: true });
      Object.assign(dev(s, 'srv').ifaces[0], { mode6: 'static', ip6: '2001:db8:a::10/64', gw6: '2001:db8:a::1' });
    },
    recap: ['IPv6 沒有廣播也沒有 ARP，改用 ICMPv6 的鄰居探索 (NDP)。', '用戶端靠 RA 就能上線；伺服器則用固定位址，方便別人找到它。'],
  },
  {
    id: 'l35', chapter: 9, title: '雙協定', subtitle: 'IPv6 靜態路由', tags: ['Dual Stack', 'IPv6 靜態路由'],
    brief: '兩個據點的 IPv4 一切正常，IPv6 的位址也都規劃好了，但兩邊的 IPv6 就是不通。IPv4 和 IPv6 是兩套各自獨立的路由表：IPv4 通，不代表 IPv6 也通。請把 IPv6 的路由補齊。',
    given: [
      ['據點 1 LAN', '2001:db8:1::/64（R1）'], ['據點 2 LAN', '2001:db8:2::/64（R2）'],
      ['R1 ↔ R2', '2001:db8:12::/64 · R1 = ::1、R2 = ::2'], ['現況', '介面的 IPv6 位址都已設定；R2 還沒有啟用 IPv6 路由'],
    ],
    learn: [
      { t: '雙協定 (Dual Stack)', d: '同一個介面同時跑 IPv4 與 IPv6。兩者互不相干，各有自己的位址、路由表與鄰居表。' },
      { t: 'IPv6 靜態路由', d: '寫法和 IPv4 一樣：目的前綴加上下一站。在 Cisco 上是 ipv6 route 2001:db8:2::/64 2001:db8:12::2。' },
      { t: 'ipv6 unicast-routing', d: 'Cisco 路由器預設不轉送 IPv6 封包，必須先下這個指令。這是最常被遺漏的一步。' },
    ],
    setup: () => {
      const r = (id, name, pos, lan4, wan4, lan6, wan6, on) => D('isr4321', id, {
        name, pos,
        init(d) {
          Object.assign(d.ifaces[0], { ip: lan4, mask: '255.255.255.0', ip6: lan6, ra: true });
          Object.assign(d.ifaces[1], { ip: wan4, mask: '255.255.255.252', ip6: wan6 });
          d.v6routing = on;
        },
      });
      const s = makeState([
        r('r1', 'R1', [-5.5, -3.5], '10.1.0.1', '10.0.12.1', '2001:db8:1::1/64', '2001:db8:12::1/64', true),
        r('r2', 'R2', [5.5, -3.5], '10.2.0.1', '10.0.12.2', '2001:db8:2::1/64', '2001:db8:12::2/64', false),
        D('pc', 'pc1', { name: 'PC-1', pos: [-5.5, 2.5], ip: '10.1.0.50', gw: '10.1.0.1' }),
        D('pc', 'pc2', { name: 'PC-2', pos: [5.5, 2.5], ip: '10.2.0.50', gw: '10.2.0.1' }),
      ], [['r1:Gi0/0/1', 'r2:Gi0/0/1'], ['pc1:eth0', 'r1:Gi0/0/0'], ['pc2:eth0', 'r2:Gi0/0/0']]);
      dev(s, 'r1').routes.push({ dst: '10.2.0.0', mask: '255.255.255.0', via: '10.0.12.2' });
      dev(s, 'r2').routes.push({ dst: '10.1.0.0', mask: '255.255.255.0', via: '10.0.12.1' });
      s.v6 = true;
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc1', to: 'pc2', label: 'IPv4：PC-1 可以 ping 到 PC-2（已經是通的）' },
      { type: 'ping6', from: 'pc1', to: 'pc2', label: 'IPv6：PC-1 可以 ping 到 PC-2' },
      { type: 'ping6', from: 'pc2', to: 'pc1', label: 'IPv6：PC-2 可以 ping 到 PC-1' },
    ],
    hints: [
      'R2 →「路由」：開啟「IPv6 路由」。開啟後 PC-2 才會收到 RA、自動產生位址。',
      'R1 →「路由」的 IPv6 靜態路由：目的 2001:db8:2::/64，下一站 2001:db8:12::2。',
      'R2 也要有回程：目的 2001:db8:1::/64，下一站 2001:db8:12::1。',
    ],
    solve(s) {
      dev(s, 'r2').v6routing = true;
      dev(s, 'r1').routes6.push({ dst: '2001:db8:2::/64', via: '2001:db8:12::2' });
      dev(s, 'r2').routes6.push({ dst: '2001:db8:1::/64', via: '2001:db8:12::1' });
    },
    recap: ['導入 IPv6 時，所有 IPv4 做過的事（位址、路由、防護）都要再做一次。', '回程路由的道理在 IPv6 一樣適用。'],
  },
];

void ifc;
