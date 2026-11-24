// 第五 ~ 八章：無線網路、網路安全、VPN 與廣域備援、高可用與進階路由
import { makeDevice as D, makeState, setLine, newIface, newSsid } from '../engine/model.js';
import { parseIp, fmtIp, parseCidr, netOf } from '../engine/ip.js';
import { macOf } from '../engine/sim.js';
import { dev, ifc, link, setIp, swp, addVlan, joinWifi, WEB, SSH } from './util.js';

const STRONG = ['wpa2', 'wpa2wpa3', 'wpa3'];
/** 檢查所有啟用中的 SSID 都有夠強的加密 */
const wifiSecure = (s, ids, minLen = 12) => {
  for (const id of ids) {
    const list = dev(s, id).wifi.ssids.filter((x) => !x.off && x.name);
    if (!list.length) return `${dev(s, id).name} 還沒有設定任何無線網路 (SSID)`;
    for (const x of list) {
      if (!STRONG.includes(x.sec)) return `「${x.name}」使用 ${x.sec === 'open' ? '開放網路（沒有加密）' : 'WEP（幾分鐘就能破解）'}，請改用 WPA2 或 WPA3`;
      if ((x.pass || '').length < minLen) return `「${x.name}」的密碼太短，至少要 ${minLen} 個字元`;
    }
  }
  return true;
};
const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const twoLines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];

export const CHAPTERS2 = [
  { id: 5, title: '無線網路', desc: 'SSID、WPA2 / WPA3、PoE、頻道規劃與訪客網路。' },
  { id: 6, title: '網路安全', desc: 'DHCP Snooping、Port Security、ACL 與管理介面加固。' },
  { id: 7, title: 'VPN 與廣域備援', desc: '站對站 IPsec、遠端存取 VPN、雙線路浮動路由。' },
  { id: 8, title: '高可用與進階路由', desc: 'STP、EtherChannel、VRRP、DHCP Relay、OSPF Cost、VLSM。' },
];

export const LEVELS2 = [
  // ════════════════════════ 第五章：無線網路 ════════════════════════
  {
    id: 'l13', chapter: 5, title: '家裡的 Wi-Fi', subtitle: 'SSID、加密方式與密碼', tags: ['Wi-Fi', 'WPA2 / WPA3', 'SSID'],
    brief: '新買的路由器 Wi-Fi 還是出廠預設值：沒有密碼，任何人都連得上，隔壁鄰居已經在蹭你的網路了。請替無線網路設定加密，讓自己的手機、筆電和無線印表機連上，並把鄰居擋在外面。',
    given: [['建議 SSID', 'MyHome（自訂也可以）'], ['密碼', '自訂，至少 12 個字元'], ['無線印表機', '型號較舊，只支援到 WPA2'], ['鄰居的筆電', '不是你的設備，無法設定']],
    learn: [
      { t: 'SSID', d: '無線網路的名稱。用戶端靠它找到基地台，再用密碼證明自己有資格加入。' },
      { t: 'WPA2 與 WPA3', d: 'WPA2 (AES-CCMP) 是目前最普及的加密；WPA3 (SAE) 更安全，能抵抗離線猜密碼。開放網路與 WEP 都不該再使用。' },
      { t: '混合模式', d: '舊設備不支援 WPA3 時，可以用「WPA2 / WPA3 混合」：新設備走 WPA3，舊設備仍然能用 WPA2 連線。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -7.5] }), 'line1', { type: 'dhcp', gw: '203.0.113.1', assign: '203.0.113.80' }),
      D('homerouter', 'rt', {
        name: '路由器', pos: [0, -2.5],
        init(d) {
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' });
          d.wifi.ssids = [newSsid({ name: 'ASUS_58U', sec: 'open' })];
        },
      }),
      D('phone', 'ph', { name: '手機', pos: [-5, 2.5] }),
      D('laptop', 'nb', { name: '筆電', pos: [0.5, 4] }),
      D('wprinter', 'prn', { name: '無線印表機', pos: [5.5, 2] }),
      D('laptop', 'nei', { name: '鄰居的筆電', pos: [8, -4.5], locked: true, wifi: { ssid: 'ASUS_58U', pass: '' } }),
    ], [['inet:line1', 'rt:wan']]),
    objectives: [
      { type: 'tcp', from: 'ph', name: 'www.example.com', port: 443, label: '手機可以透過 Wi-Fi 上網' },
      { type: 'tcp', from: 'nb', name: 'www.example.com', port: 443, label: '筆電可以透過 Wi-Fi 上網' },
      { type: 'tcp', from: 'nb', to: 'prn', port: 9100, label: '筆電可以用無線印表機列印' },
      { type: 'ping', from: 'nei', ip: '8.8.8.8', expect: false, label: '鄰居的筆電不能再蹭網（鄰居 ✕ 8.8.8.8）' },
      { type: 'check', label: '無線網路使用 WPA2 或 WPA3，密碼至少 12 個字元', test: (s) => wifiSecure(s, ['rt']) },
    ],
    hints: [
      '點路由器 →「無線網路」分頁，把加密方式從「開放」改掉，並設定一組至少 12 個字元的密碼。',
      '印表機只支援 WPA2，所以加密方式要選「WPA2 / WPA3 混合」（或 WPA2），選純 WPA3 印表機會連不上。',
      '到手機、筆電、印表機的「網路設定」，在 Wi-Fi 區塊選擇你的 SSID 並輸入同一組密碼。',
    ],
    solve(s) {
      dev(s, 'rt').wifi.ssids[0] = newSsid({ name: 'MyHome', sec: 'wpa2wpa3', pass: 'Taipei-101-Sunset' });
      for (const id of ['ph', 'nb', 'prn']) joinWifi(s, id, 'MyHome', 'Taipei-101-Sunset');
    },
    recap: ['開放的無線網路等於把網路線拉到大馬路上。', 'WPA3 最安全，但要顧及舊設備時就用 WPA2 / WPA3 混合模式。'],
  },
  {
    id: 'l14', chapter: 5, title: '辦公室基地台', subtitle: 'PoE 供電與頻道規劃', tags: ['AP', 'PoE', '頻道'],
    brief: '辦公室要全面無線化，買了兩台吸頂式基地台 (AP)。AP 沒有變壓器，要靠網路線供電 (PoE)。請把兩台 AP 接上交換器並設定無線網路，讓整層樓的同事都連得上，而且兩台 AP 不能互相干擾。',
    given: [['SSID', 'Office'], ['密碼', 'Net#Office2026'], ['同事的設備', '都已經輸入好上面這組設定'], ['PoE 供電埠', '交換器的 Gi0/1 – Gi0/8'], ['2.4GHz 不重疊頻道', '1、6、11']],
    learn: [
      { t: 'PoE (Power over Ethernet)', d: '透過網路線同時傳資料與供電（802.3af / at）。AP、IP 電話、攝影機常用，但要接在交換器的 PoE 埠上才有電。' },
      { t: '頻道重疊', d: '2.4GHz 只有 1、6、11 三個頻道互不重疊。相鄰的 AP 用同一個或太接近的頻道會互相干擾，速度大降。' },
      { t: '漫遊', d: '多台 AP 使用相同的 SSID 與密碼，用戶端移動時就會自動換到訊號比較強的那一台。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [-9.5, -8.5] }), 'line1', { type: 'static', gw: '203.0.113.57', mask: '255.255.255.248', assign: '203.0.113.58' }),
      D('erx', 'rt', {
        name: 'Router', pos: [-9.5, -4],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.58', mask: '255.255.255.248', gateway: '203.0.113.57', nat: true });
          Object.assign(d.ifaces[1], { ip: '192.168.20.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.20.100', end: '192.168.20.199', dns: '8.8.8.8' });
        },
      }),
      D('c2960p', 'sw', { name: 'PoE Switch', pos: [0, -4] }),
      D('ap', 'ap1', { name: 'AP-1', pos: [-5, 1.5] }),
      D('ap', 'ap2', { name: 'AP-2', pos: [5, 1.5] }),
      D('laptop', 'nb1', { name: '筆電 A', pos: [-9, 5.5], wifi: { ssid: 'Office', pass: 'Net#Office2026' } }),
      D('phone', 'ph1', { name: '手機 A', pos: [-2.5, 6.5], wifi: { ssid: 'Office', pass: 'Net#Office2026' } }),
      D('laptop', 'nb2', { name: '筆電 B', pos: [3, 6.5], wifi: { ssid: 'Office', pass: 'Net#Office2026' } }),
      D('phone', 'ph2', { name: '手機 B', pos: [9.5, 5.5], wifi: { ssid: 'Office', pass: 'Net#Office2026' } }),
    ], [['inet:line1', 'rt:eth0'], ['rt:eth1', 'sw:Gi0/9']]),
    objectives: [
      {
        type: 'check', label: '兩台 AP 都有 PoE 供電',
        test: (s) => {
          for (const id of ['ap1', 'ap2']) if (s.rt.off[id]) return `${dev(s, id).name} 沒有電：請接到有 PoE 的連接埠（Gi0/1 – Gi0/8）`;
          return true;
        },
      },
      { type: 'tcp', from: 'ph1', name: 'www.example.com', port: 443, label: '手機 A 可以上網' },
      { type: 'tcp', from: 'nb2', name: 'www.example.com', port: 443, label: '筆電 B 可以上網' },
      { type: 'ping', from: 'ph2', to: 'nb1', label: '手機 B 可以 ping 到筆電 A（跨兩台 AP）' },
      {
        type: 'check', label: '兩台 AP 的頻道互不干擾，並使用 WPA2 / WPA3',
        test: (s) => {
          const sec = wifiSecure(s, ['ap1', 'ap2']);
          if (sec !== true) return sec;
          const i = dev(s, 'ap1').rt.interf[0];
          return !i || `AP-1 與 AP-2 在 ${i.band} 使用了重疊的頻道，會互相干擾`;
        },
      },
    ],
    hints: [
      '把 AP-1、AP-2 拖曳到 PoE Switch，連接埠要選 Gi0/1 – Gi0/8（Gi0/9、Gi0/10 沒有供電）。',
      '兩台 AP 的「無線網路」都新增 SSID：Office、WPA2 / WPA3 混合、密碼 Net#Office2026。',
      '到「無線電」分頁調整頻道：2.4GHz 一台用 1、另一台用 6 或 11；5GHz 也要選不同的頻道（例如 36 與 44）。',
    ],
    solve(s) {
      link(s, 'ap1:eth0', 'sw:Gi0/1'); link(s, 'ap2:eth0', 'sw:Gi0/2');
      for (const id of ['ap1', 'ap2']) dev(s, id).wifi.ssids = [newSsid({ name: 'Office', sec: 'wpa2wpa3', pass: 'Net#Office2026' })];
      Object.assign(dev(s, 'ap2').wifi, { ch24: 6, ch5: 44 });
    },
    recap: ['AP 接錯埠就沒電：PoE 是無線網路最常被忽略的實體層問題。', '同一個 SSID、不同的頻道，是多台 AP 佈建的基本原則。'],
  },
  {
    id: 'l15', chapter: 5, title: '訪客 Wi-Fi', subtitle: 'SSID 對應 VLAN 與用戶端隔離', tags: ['多重 SSID', 'VLAN', '訪客隔離'],
    brief: '客戶來訪時常常要借 Wi-Fi，但公司的無線網路直通內部檔案伺服器。請在同一台 AP 上多開一個訪客用的 SSID，讓訪客只能上網、碰不到內部網路，訪客之間也不能互連。',
    given: [
      ['員工 SSID', 'Corp → VLAN 10（已完成）'], ['訪客 SSID', 'Guest → VLAN 30'], ['訪客密碼', 'Welcome-2026（訪客手機已輸入）'],
      ['訪客網段', '192.168.30.0/24，由防火牆的 guest 介面發 DHCP'], ['交換器 Gi0/10', '接往防火牆的 guest 介面'], ['交換器 Gi0/1', '接 AP'],
    ],
    learn: [
      { t: '多重 SSID', d: '一台 AP 可以同時廣播好幾個 SSID，每個 SSID 對應一個 VLAN。AP 與交換器之間用 Trunk，靠 802.1Q 標籤把流量分開。' },
      { t: '訪客隔離', d: '訪客網路獨立一個網段，防火牆只放行它往網際網路的流量。再開啟「用戶端隔離」，同一個 SSID 上的訪客彼此也看不到。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -10.5] }), 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' }),
      D('fg60f', 'fw', {
        name: 'Firewall', pos: [0, -6],
        init(d) {
          const g = (id) => d.ifaces.find((i) => i.id === id);
          Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
          Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
          Object.assign(g('internal').dhcp, { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '8.8.8.8' });
          Object.assign(g('dmz'), { label: 'guest', ip: '192.168.30.1', mask: '255.255.255.0' });
          Object.assign(g('dmz').dhcp, { on: true, start: '192.168.30.100', end: '192.168.30.199', dns: '8.8.8.8' });
          d.policies.push(allow('員工上網', 'internal', 'wan1', { nat: true }));
        },
      }),
      D('c2960p', 'sw', {
        name: 'PoE Switch', pos: [0, -1.5],
        init(d) {
          d.sw.vlans.push({ id: 10, name: 'Staff' });
          for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/9']) d.sw.ports[p].vlan = 10;
        },
      }),
      D('ap', 'ap', { name: 'AP', pos: [0, 3], init(d) { d.wifi.ssids = [newSsid({ name: 'Corp', sec: 'wpa2wpa3', pass: 'Corp#Secure2026' })]; } }),
      D('nas', 'fs', { name: '檔案伺服器', pos: [7, -1], ip: '192.168.1.10', gw: '192.168.1.1' }),
      D('laptop', 'nb', { name: '員工筆電', pos: [-6, 5.5], wifi: { ssid: 'Corp', pass: 'Corp#Secure2026' } }),
      D('phone', 'g1', { name: '訪客手機 1', pos: [3, 7.5], wifi: { ssid: 'Guest', pass: 'Welcome-2026' } }),
      D('phone', 'g2', { name: '訪客手機 2', pos: [7.5, 5.5], wifi: { ssid: 'Guest', pass: 'Welcome-2026' } }),
    ], [['inet:line1', 'fw:wan1'], ['fw:1', 'sw:Gi0/9'], ['fw:dmz', 'sw:Gi0/10'], ['ap:eth0', 'sw:Gi0/1'], ['fs:eth0', 'sw:Gi0/2']]),
    objectives: [
      { type: 'tcp', from: 'nb', to: 'fs', port: 445, label: '員工筆電可以開啟檔案伺服器 (SMB 445)' },
      { type: 'dhcp', dev: 'g1', subnet: '192.168.30.0/24', label: '訪客手機取得 192.168.30.x' },
      { type: 'tcp', from: 'g1', name: 'www.example.com', port: 443, label: '訪客手機可以上網' },
      { type: 'tcp', from: 'g1', to: 'fs', port: 445, expect: false, label: '訪客連不到檔案伺服器（訪客 ✕ 檔案伺服器）' },
      { type: 'ping', from: 'g1', to: 'g2', expect: false, label: '訪客之間互相隔離（訪客 1 ✕ 訪客 2）' },
    ],
    hints: [
      '交換器：建立 VLAN 30；Gi0/10 設成 Access VLAN 30；Gi0/1（接 AP）改成 Trunk，Native VLAN 選 10，這樣沒有標籤的 Corp 流量仍然進 VLAN 10。',
      'AP →「無線網路」新增 SSID：Guest、WPA2 / WPA3 混合、密碼 Welcome-2026、VLAN 填 30，並開啟「用戶端隔離」。',
      '防火牆 →「政策」新增 guest → wan1、允許、開啟 NAT。不要建立 guest → internal 的政策。',
    ],
    solve(s) {
      addVlan(s, 'sw', 30, 'Guest');
      swp(s, 'sw', 'Gi0/10').vlan = 30;
      Object.assign(swp(s, 'sw', 'Gi0/1'), { mode: 'trunk', native: 10 });
      dev(s, 'ap').wifi.ssids.push(newSsid({ name: 'Guest', sec: 'wpa2wpa3', pass: 'Welcome-2026', vlan: '30', isolate: true }));
      dev(s, 'fw').policies.push(allow('訪客上網', 'dmz', 'wan1', { nat: true }));
    },
    recap: ['SSID ↔ VLAN ↔ 防火牆介面，三層對起來才是真正的隔離。', '訪客網路的原則：只給網際網路，其他一律不放行。'],
  },

  // ════════════════════════ 第六章：網路安全 ════════════════════════
  {
    id: 'l16', chapter: 6, title: '誰在發 IP？', subtitle: '惡意 DHCP 與 DHCP Snooping', tags: ['DHCP Snooping', 'Rogue DHCP', 'L2 安全'],
    brief: '今天早上全辦公室突然都上不了網。原來是同事為了用 Wi-Fi，私自把一台家用分享器接上牆上的網路孔，它搶先回應 DHCP，把錯誤的 IP 和閘道發給了所有電腦。在找到是誰之前，先讓交換器擋掉不合法的 DHCP 伺服器。',
    given: [['合法 DHCP', 'Router（192.168.10.0/24）'], ['Router 接在', '交換器的 Gi0/10'], ['不明分享器', '發的是 192.168.50.x，目前無法設定它']],
    learn: [
      { t: 'Rogue DHCP', d: 'DHCP 沒有驗證機制，誰先回應用戶端就信誰。網路上多出一台 DHCP 伺服器，輕則斷網，重則被人當成中間人攻擊的跳板。' },
      { t: 'DHCP Snooping', d: '交換器把埠分成信任 (trusted) 與不信任。只有信任埠可以送出 DHCP 伺服器的回應，其他埠送進來的 Offer / Ack 一律丟棄。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [-8, -8] }), 'line1', { type: 'static', gw: '203.0.113.9', mask: '255.255.255.248', assign: '203.0.113.10' }),
      D('erx', 'rt', {
        name: 'Router', pos: [-8, -3.5],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.248', gateway: '203.0.113.9', nat: true });
          Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.10.100', end: '192.168.10.199', dns: '168.95.1.1' });
        },
      }),
      D('c2960', 'sw', { name: 'Switch', pos: [0, -3.5] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-5.5, 2.5], dhcp: true }),
      D('homerouter', 'rogue', {
        name: '不明的分享器', pos: [0.5, 3.6], locked: true,
        init(d) { Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' }); },
      }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [6.5, 2.5], dhcp: true }),
    ], [['inet:line1', 'rt:eth0'], ['rt:eth1', 'sw:Gi0/10'], ['pc-1:eth0', 'sw:Gi0/1'], ['rogue:lan1', 'sw:Gi0/2'], ['pc-2:eth0', 'sw:Gi0/3']]),
    objectives: [
      { type: 'dhcp', dev: 'pc-1', subnet: '192.168.10.0/24', label: 'PC-1 從合法的 Router 取得 192.168.10.x' },
      { type: 'dhcp', dev: 'pc-2', subnet: '192.168.10.0/24', label: 'PC-2 從合法的 Router 取得 192.168.10.x' },
      { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443, label: 'PC-1 可以上網' },
      {
        type: 'check', label: '交換器啟用 DHCP Snooping，而且只有上行埠 Gi0/10 是信任埠',
        test(s) {
          const sw = dev(s, 'sw').sw;
          if (!sw.snoop || !sw.snoop.on) return '交換器還沒有啟用 DHCP Snooping（只是把分享器的線拔掉，下次還會再發生）';
          if (!sw.ports['Gi0/10'].trust) return '接往合法 DHCP 伺服器的 Gi0/10 要設成信任埠，否則連合法的回應也會被擋下';
          const extra = Object.entries(sw.ports).find(([p, c]) => c.trust && p !== 'Gi0/10');
          return !extra || `${extra[0]} 不應該是信任埠 — 只有通往合法 DHCP 伺服器的埠才能信任`;
        },
      },
    ],
    hints: [
      '點 PC-1 看它拿到的 IP：192.168.50.x，來源是「不明的分享器」。',
      '點交換器 →「安全」分頁，開啟 DHCP Snooping。開啟後所有埠預設都不信任，連合法的 Router 也會被擋。',
      '在「連接埠」分頁找到 Gi0/10，展開進階設定，勾選「DHCP Snooping 信任埠」。',
    ],
    solve(s) {
      dev(s, 'sw').sw.snoop.on = true;
      swp(s, 'sw', 'Gi0/10').trust = true;
    },
    recap: ['第二層的攻擊（Rogue DHCP、ARP 欺騙）要在交換器上防。', 'DHCP Snooping 的口訣：上行埠信任，面向使用者的埠全部不信任。'],
  },
  {
    id: 'l17', chapter: 6, title: '不速之客', subtitle: 'Port Security 與停用閒置連接埠', tags: ['Port Security', 'MAC 位址', '設備加固'],
    brief: '資安稽核發現兩個問題：會議室牆上閒置的網路孔被人插了一台不明筆電；還有同事自己帶了小 Hub 來，在公司電腦旁邊多接了一台私人筆電。請讓這兩台未經授權的設備都連不到檔案伺服器，但不能影響正常辦公。',
    given: [['檔案伺服器', '192.168.1.10（Gi0/1）'], ['PC-2 與私人筆電', '都接在 Hub 上，Hub 接到 Gi0/3'], ['不明筆電', '接在 Gi0/8（會議室）'], ['不明筆電、私人筆電', '不是公司的設備，無法設定']],
    learn: [
      { t: '停用閒置連接埠', d: '沒在用的連接埠一律 shutdown。這是最簡單也最有效的實體安全措施。' },
      { t: 'Port Security', d: '限制一個埠只接受特定的 MAC 位址。違規時可以只丟棄封包 (restrict)，或直接把整個埠關掉 (shutdown / err-disabled)。' },
      { t: 'MAC 位址表', d: '交換器會記錄每個埠後面看到哪些 MAC。一個接使用者的埠出現兩個以上的 MAC，通常代表有人私接設備。' },
    ],
    setup: () => makeState([
      D('c2960', 'sw', { name: 'Switch', pos: [0, -2.5] }),
      D('nas', 'fs', { name: '檔案伺服器', pos: [-7.5, -1.5], ip: '192.168.1.10' }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-6, 3.2], ip: '192.168.1.21' }),
      D('hub4', 'hub', { name: '私接的 Hub', pos: [0.5, 2.4] }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [-1.8, 6.4], ip: '192.168.1.22' }),
      D('laptop', 'byod', { name: '私人筆電', pos: [3.6, 6.4], ip: '192.168.1.99', locked: true }),
      D('laptop', 'bad', { name: '不明筆電', pos: [8, 1.5], ip: '192.168.1.66', locked: true }),
    ], [['fs:eth0', 'sw:Gi0/1'], ['pc-1:eth0', 'sw:Gi0/2'], ['hub:1', 'sw:Gi0/3'], ['pc-2:eth0', 'hub:2'], ['byod:eth0', 'hub:3'], ['bad:eth0', 'sw:Gi0/8']]),
    objectives: [
      { type: 'tcp', from: 'pc-1', to: 'fs', port: 445, label: 'PC-1 可以開啟檔案伺服器' },
      { type: 'tcp', from: 'pc-2', to: 'fs', port: 445, label: 'PC-2 可以開啟檔案伺服器' },
      { type: 'tcp', from: 'bad', to: 'fs', port: 445, expect: false, label: '不明筆電連不到檔案伺服器' },
      { type: 'tcp', from: 'byod', to: 'fs', port: 445, expect: false, label: '私人筆電連不到檔案伺服器' },
      {
        type: 'check', label: '所有沒接線的連接埠都已停用 (shutdown)',
        test(s) {
          const d = dev(s, 'sw');
          const open = d.ports.filter((p) => !s.cables.some((c) => (c.a.dev === 'sw' && c.a.port === p.id) || (c.b.dev === 'sw' && c.b.port === p.id)) && !d.sw.ports[p.id].shut);
          return !open.length || `還有 ${open.length} 個閒置的連接埠是啟用的（例如 ${open[0].id}）`;
        },
      },
    ],
    hints: [
      '不明筆電：到交換器「連接埠」分頁，展開 Gi0/8 的進階設定，把它停用。再到「安全」分頁按「停用所有未接線的連接埠」。',
      'Gi0/3 後面有兩台設備，不能直接關掉。展開 Gi0/3 的進階設定，開啟 Port Security，違規動作選 Restrict。',
      '「允許的 MAC」只留下 PC-2 的 MAC。PC-2 的 MAC 可以在它的「網路設定」看到，交換器的「狀態」分頁也有 MAC 位址表。',
    ],
    solve(s) {
      const d = dev(s, 'sw');
      d.sw.ports['Gi0/8'].shut = true;
      d.sw.ports['Gi0/3'].ps = { on: true, macs: macOf('pc-2', 'eth0', 'pc'), mode: 'restrict' };
      for (const p of d.ports) if (!s.cables.some((c) => (c.a.dev === 'sw' && c.a.port === p.id) || (c.b.dev === 'sw' && c.b.port === p.id))) d.sw.ports[p.id].shut = true;
    },
    recap: ['閒置的埠要關、使用中的埠要限制 MAC，這是交換器加固的兩個基本動作。', 'Restrict 只丟違規的封包；Shutdown 會把整個埠關掉，連合法設備也斷線。'],
  },
  {
    id: 'l18', chapter: 6, title: '存取控制清單', subtitle: 'ACL 的順序與隱含拒絕', tags: ['ACL', '最小權限', '無狀態過濾'],
    brief: '薪資系統放在獨立的伺服器網段，但現在任何人都連得到它，連訪客也可以。請在路由器上用 ACL 管制誰可以存取薪資伺服器。注意：ACL 是無狀態的，而且最後有一條看不見的「全部拒絕」。',
    given: [
      ['員工網段', '10.0.10.0/24（VLAN 10）'], ['訪客網段', '10.0.20.0/24（VLAN 20）'], ['伺服器網段', '10.0.30.0/24（路由器 Gi0/0/2）'],
      ['薪資伺服器', '10.0.30.10 · HTTPS 443、SSH 22'], ['管理員 PC', '10.0.10.5'], ['規則', '員工只能用 HTTPS；只有管理員能 SSH；訪客完全不能連；伺服器仍要能上網更新'],
    ],
    learn: [
      { t: 'ACL 由上往下比對', d: '第一條符合的規則就決定命運，後面的不再看。所以「例外」要寫在「通則」前面。' },
      { t: '隱含拒絕', d: 'ACL 只要有任何一條規則，最後就自動多一條 deny any。忘了在結尾加 permit ip any any，其他流量會全部被擋。' },
      { t: '無狀態', d: 'ACL 不記得連線，每個封包（包含回程）都要重新比對一次。這和防火牆的狀態檢查不同。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [-9, -9.5] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34' }),
      D('isr4331', 'rt', {
        name: 'Router', pos: [-3, -5],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33', nat: true });
          Object.assign(d.ifaces[2], { ip: '10.0.30.1', mask: '255.255.255.0' });
          for (const v of [10, 20]) d.ifaces.push(newIface(`Gi0/0/1.${v}`, `Gi0/0/1.${v}`, { t: 'sub', port: 'Gi0/0/1', vlan: v }, { ip: `10.0.${v}.1`, mask: '255.255.255.0' }));
        },
      }),
      D('c2960', 'sw', {
        name: 'Switch', pos: [-3, 0],
        init(d) {
          d.sw.vlans.push({ id: 10, name: 'STAFF' }, { id: 20, name: 'GUEST' });
          d.sw.ports['Gi0/1'].vlan = 10; d.sw.ports['Gi0/2'].vlan = 10; d.sw.ports['Gi0/3'].vlan = 20;
          d.sw.ports['Gi0/9'].mode = 'trunk';
        },
      }),
      D('pc', 'emp', { name: '員工 PC', pos: [-9.5, 4.5], ip: '10.0.10.50', gw: '10.0.10.1', dns: '8.8.8.8' }),
      D('pc', 'adm', { name: '管理員 PC', pos: [-4, 5.6], ip: '10.0.10.5', gw: '10.0.10.1', dns: '8.8.8.8' }),
      D('laptop', 'gst', { name: '訪客筆電', pos: [1.5, 4.5], ip: '10.0.20.50', gw: '10.0.20.1', dns: '8.8.8.8' }),
      D('tower', 'srv', { name: '薪資伺服器', pos: [6.5, -1], ip: '10.0.30.10', gw: '10.0.30.1', dns: '8.8.8.8', services: [...WEB, ...SSH] }),
    ], [
      ['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:Gi0/9'], ['rt:Gi0/0/2', 'srv:eth0'],
      ['emp:eth0', 'sw:Gi0/1'], ['adm:eth0', 'sw:Gi0/2'], ['gst:eth0', 'sw:Gi0/3'],
    ]),
    objectives: [
      { type: 'tcp', from: 'emp', to: 'srv', port: 443, label: '員工可以開啟薪資系統 (HTTPS)' },
      { type: 'tcp', from: 'adm', to: 'srv', port: 22, label: '管理員可以 SSH 到薪資伺服器' },
      { type: 'tcp', from: 'emp', to: 'srv', port: 22, expect: false, label: '一般員工不能 SSH（員工 ✕ SSH）' },
      { type: 'tcp', from: 'gst', to: 'srv', port: 443, expect: false, label: '訪客連不到薪資伺服器（訪客 ✕ 伺服器）' },
      { type: 'ping', from: 'gst', ip: '8.8.8.8', label: '訪客仍然可以上網' },
      { type: 'ping', from: 'srv', ip: '8.8.8.8', label: '薪資伺服器仍然可以連外更新' },
    ],
    hints: [
      '把 ACL 掛在最靠近伺服器的地方：路由器 →「ACL」分頁 → Gi0/0/2 的「離開方向」，所有要送給伺服器網段的封包都會經過這裡。',
      '順序：① 拒絕 ip 10.0.20.0/24 → 10.0.30.0/24　② 允許 tcp 10.0.10.5 → 10.0.30.10 埠 22　③ 拒絕 tcp any → 10.0.30.10 埠 22。',
      '最後一定要加 ④ 允許 ip any → any。否則隱含拒絕會把 HTTPS 和伺服器上網的回程封包一起擋掉。',
    ],
    solve(s) {
      ifc(s, 'rt', 'Gi0/0/2').aclOut = [
        { action: 'deny', proto: 'ip', src: '10.0.20.0/24', dst: '10.0.30.0/24', port: '' },
        { action: 'permit', proto: 'tcp', src: '10.0.10.5', dst: '10.0.30.10', port: '22' },
        { action: 'deny', proto: 'tcp', src: 'any', dst: '10.0.30.10', port: '22' },
        { action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: '' },
      ];
    },
    recap: ['ACL 三件事：順序、方向、隱含拒絕。', '明確的例外放前面，通則放後面，最後別忘了 permit any。'],
  },
  {
    id: 'l19', chapter: 6, title: '管理介面加固', subtitle: '管理 VLAN、SSH 與 Syslog', tags: ['設備加固', 'SSH', '管理 VLAN', 'Syslog / NTP'],
    brief: '弱點掃描報告：交換器和路由器都開著 Telnet 與 HTTP，而且任何網段都連得到管理介面。請建立專用的管理網段，只允許管理員用 SSH 連線，並把設備的時間與紀錄集中到監控伺服器。',
    given: [
      ['管理 VLAN', 'VLAN 99 · 10.0.99.0/24 · 閘道 10.0.99.1'], ['交換器管理 IP', '10.0.99.2'], ['管理員 PC', '10.0.99.10'],
      ['監控伺服器', '10.0.99.20（Syslog UDP 514、NTP UDP 123）'], ['要求', '關閉 Telnet 與 HTTP；只允許 10.0.99.0/24 管理；換掉預設密碼；SNMP 改用 v3；Syslog 與 NTP 指向監控伺服器'],
    ],
    learn: [
      { t: 'Telnet 與 SSH', d: 'Telnet 連帳號密碼都是明文傳送，在網路上一抓就看光。管理設備一律用 SSH (TCP 22)。' },
      { t: '管理 VLAN', d: '把設備的管理介面放進獨立的 VLAN，再限制只有該網段能連線，使用者網段就完全碰不到。' },
      { t: 'Syslog 與 NTP', d: '設備把紀錄送到集中的 Syslog 伺服器，並用 NTP 對時。時間一致，事後才能把各設備的紀錄串起來追查。' },
    ],
    setup: () => makeState([
      D('isr4321', 'rt', {
        name: 'Router', pos: [0, -6],
        init(d) {
          for (const v of [10, 99]) d.ifaces.push(newIface(`Gi0/0/1.${v}`, `Gi0/0/1.${v}`, { t: 'sub', port: 'Gi0/0/1', vlan: v }, { ip: `10.0.${v}.1`, mask: '255.255.255.0' }));
        },
      }),
      D('c2960', 'sw', {
        name: 'Switch', pos: [0, -1.5],
        init(d) {
          d.sw.vlans.push({ id: 10, name: 'USERS' }, { id: 99, name: 'MGMT' });
          d.sw.ports['Gi0/1'].vlan = 99; d.sw.ports['Gi0/2'].vlan = 10; d.sw.ports['Gi0/3'].vlan = 99;
          d.sw.ports['Gi0/9'].mode = 'trunk';
        },
      }),
      D('pc', 'adm', { name: '管理員 PC', pos: [-7, 3], ip: '10.0.99.10', gw: '10.0.99.1' }),
      D('pc', 'usr', { name: '使用者 PC', pos: [0, 4.6], ip: '10.0.10.50', gw: '10.0.10.1' }),
      D('tower', 'nms', { name: '監控伺服器', pos: [7, 3], ip: '10.0.99.20', gw: '10.0.99.1', services: [{ proto: 'udp', port: 514, name: 'Syslog' }, { proto: 'udp', port: 123, name: 'NTP' }] }),
    ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['adm:eth0', 'sw:Gi0/1'], ['usr:eth0', 'sw:Gi0/2'], ['nms:eth0', 'sw:Gi0/3']]),
    objectives: [
      { type: 'tcp', from: 'adm', ip: '10.0.99.2', port: 22, label: '管理員可以 SSH 到交換器 (10.0.99.2)' },
      { type: 'tcp', from: 'adm', ip: '10.0.99.1', port: 22, label: '管理員可以 SSH 到路由器 (10.0.99.1)' },
      { type: 'tcp', from: 'usr', ip: '10.0.99.2', port: 22, expect: false, label: '使用者網段連不到交換器的管理介面' },
      { type: 'tcp', from: 'usr', ip: '10.0.10.1', port: 22, expect: false, label: '使用者網段連不到路由器的管理介面' },
      { type: 'tcp', from: 'adm', ip: '10.0.99.1', port: 23, expect: false, label: '路由器的 Telnet 已關閉' },
      {
        type: 'check', label: '關閉 Telnet / HTTP、改掉預設密碼、SNMP 用 v3，Syslog 與 NTP 指向 10.0.99.20',
        test(s) {
          for (const id of ['sw', 'rt']) {
            const d = dev(s, id), m = d.mgmt;
            if (m.telnet) return `${d.name} 的 Telnet 還開著`;
            if (m.http) return `${d.name} 的 HTTP 管理頁面還開著（請只留 HTTPS / SSH）`;
            if (!m.ssh) return `${d.name} 的 SSH 被關掉了，這樣就沒辦法遠端管理`;
            if ((m.syslog || '').trim() !== '10.0.99.20') return `${d.name} 的 Syslog 伺服器還沒指向 10.0.99.20`;
            if ((m.ntp || '').trim() !== '10.0.99.20') return `${d.name} 的 NTP 伺服器還沒指向 10.0.99.20`;
            const p = m.pass || 'admin';
            if (p === 'admin' || p.length < 12 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p)) return `${d.name} 的管理密碼太弱：不能用預設值，至少 12 個字元，並包含大小寫字母與數字`;
            if ((m.snmp || 'v2c') === 'v2c') return `${d.name} 的 SNMP 還在用 v2c（Community 是明文），請改用 v3 或關閉`;
          }
          return true;
        },
      },
      { type: 'udp', from: 'sw', to: 'nms', port: 514, label: '交換器的紀錄送得到監控伺服器 (Syslog UDP 514)' },
    ],
    hints: [
      '交換器 →「管理」分頁：管理介面的 VLAN 選 99，IP 10.0.99.2 / 255.255.255.0，預設閘道 10.0.99.1。',
      '同一頁把 Telnet 與 HTTP 關掉，「允許管理的來源」填 10.0.99.0/24，Syslog 與 NTP 都填 10.0.99.20；管理密碼換成 12 個字元以上、含大小寫與數字，SNMP 改成 v3。',
      '路由器的「管理」分頁做一樣的設定。路由器在每個網段都有 IP，所以「允許管理的來源」特別重要。',
    ],
    solve(s) {
      const m = { ssh: true, telnet: false, http: false, https: true, allow: '10.0.99.0/24', ntp: '10.0.99.20', syslog: '10.0.99.20', snmp: 'v3', pass: 'Net0ps-Admin-2026' };
      Object.assign(dev(s, 'sw').mgmt, m);
      Object.assign(dev(s, 'rt').mgmt, m);
      const i = ifc(s, 'sw', 'mgmt');
      i.bind.vlan = 99;
      Object.assign(i, { ip: '10.0.99.2', mask: '255.255.255.0', gateway: '10.0.99.1' });
    },
    recap: ['管理流量與使用者流量分開，是設備加固的第一步。', '明文協定（Telnet、HTTP、SNMPv1/v2c）在管理介面上都應該關閉。'],
  },

  // ════════════════════════ 第七章：VPN 與廣域備援 ════════════════════════
  {
    id: 'l20', chapter: 7, title: '站對站 VPN', subtitle: 'IPsec 通道與加密提案', tags: ['IPsec', 'Site-to-Site', 'IKE'],
    brief: '專線太貴，公司決定把分公司改用網際網路上的 IPsec VPN 連回總公司。總公司的防火牆已經設定完成，IT 主管寄來一張參數表，請完成分公司這一端，讓兩邊的內部網路互通。',
    given: [
      ['總公司公用 IP', '203.0.113.18'], ['分公司公用 IP', '198.51.100.34'], ['預先共用金鑰', 'Tw!S2S#2026'],
      ['加密提案', 'AES256 / SHA256 / DH 14'], ['總公司內網', '10.1.0.0/24'], ['分公司內網', '10.2.0.0/24'],
    ],
    learn: [
      { t: 'IPsec 通道', d: '兩台防火牆在網際網路上建立加密通道。內部封包整個被包進 ESP，外面的人只看得到兩個公用 IP 在互傳亂碼。' },
      { t: '兩端必須一致', d: '預先共用金鑰 (PSK)、加密 / 雜湊 / DH 群組都要相同，而且兩邊的本地 / 遠端網段要互為鏡像，否則通道建不起來。' },
      { t: '政策仍然要寫', d: '通道建立後，防火牆把它當成一個介面。內網 ↔ VPN 的流量一樣要有政策放行。' },
    ],
    setup: () => {
      const fw = (id, name, pos, wan, mask, gw, lan, init) => D('fg60f', id, {
        name, pos,
        init(d) {
          const g = (x) => d.ifaces.find((i) => i.id === x);
          Object.assign(g('wan1'), { ip: wan, mask, gateway: gw, ping: false });
          Object.assign(g('internal'), { ip: lan, mask: '255.255.255.0' });
          d.policies.push(allow('內網上網', 'internal', 'wan1', { nat: true }));
          if (init) init(d);
        },
      });
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: twoLines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' });
      setLine(inet, 'line2', { type: 'static', gw: '198.51.100.33', mask: '255.255.255.252', assign: '198.51.100.34' });
      return makeState([
        inet,
        fw('hq', 'HQ-FW', [-7, -4.5], '203.0.113.18', '255.255.255.248', '203.0.113.17', '10.1.0.1', (d) => {
          d.vpns.push({ name: 'Branch', peer: '198.51.100.34', psk: 'Tw!S2S#2026', local: '10.1.0.0/24', remote: '10.2.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14' });
          d.policies.push(allow('往分公司', 'internal', 'vpn:Branch'), allow('分公司進來', 'vpn:Branch', 'internal'));
        }),
        fw('br', 'Branch-FW', [7, -4.5], '198.51.100.34', '255.255.255.252', '198.51.100.33', '10.2.0.1'),
        D('sw5', 'hq-sw', { name: 'HQ-Switch', pos: [-7, 0.3] }),
        D('sw5', 'br-sw', { name: 'BR-Switch', pos: [7, 0.3] }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-10.5, 4.8], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('pc', 'hq-pc', { name: '總公司 PC', pos: [-4, 4.8], ip: '10.1.0.50', gw: '10.1.0.1', dns: '8.8.8.8' }),
        D('pc', 'br-pc', { name: '分公司 PC', pos: [7, 4.8], ip: '10.2.0.50', gw: '10.2.0.1', dns: '8.8.8.8' }),
      ], [
        ['inet:line1', 'hq:wan1'], ['inet:line2', 'br:wan1'], ['hq:1', 'hq-sw:1'], ['erp:eth0', 'hq-sw:2'], ['hq-pc:eth0', 'hq-sw:3'],
        ['br:1', 'br-sw:1'], ['br-pc:eth0', 'br-sw:2'],
      ]);
    },
    objectives: [
      { type: 'tcp', from: 'br-pc', to: 'erp', port: 443, label: '分公司 PC 可以經由 VPN 使用 ERP (HTTPS)' },
      { type: 'ping', from: 'hq-pc', to: 'br-pc', label: '總公司 PC 可以 ping 到分公司 PC' },
      { type: 'tcp', from: 'br-pc', name: 'www.example.com', port: 443, label: '分公司 PC 上網不受影響' },
      { type: 'tcp', from: 'inet', ip: '203.0.113.18', port: 443, expect: false, label: 'ERP 沒有直接暴露在網際網路上' },
    ],
    hints: [
      'Branch-FW →「VPN」分頁新增站對站通道：對端 IP 203.0.113.18、PSK Tw!S2S#2026、本地網段 10.2.0.0/24、遠端網段 10.1.0.0/24。',
      '加密提案要改成和總公司一樣：AES256 / SHA256 / DH 14。通道狀態會顯示沒建起來的原因。可以打開 HQ-FW 參考它的設定。',
      '通道建立後還要有政策：internal → VPN（讓分公司連出去）以及 VPN → internal（讓總公司連進來）。',
    ],
    solve(s) {
      const b = dev(s, 'br');
      b.vpns.push({ name: 'HQ', peer: '203.0.113.18', psk: 'Tw!S2S#2026', local: '10.2.0.0/24', remote: '10.1.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14' });
      b.policies.push(allow('往總公司', 'internal', 'vpn:HQ'), allow('總公司進來', 'vpn:HQ', 'internal'));
    },
    recap: ['VPN 讓私有 IP 的封包穿過網際網路，而且全程加密。', '通道建不起來時，先對 PSK、加密提案與兩端的網段。'],
  },
  {
    id: 'l21', chapter: 7, title: '在家上班', subtitle: '遠端存取 VPN 與最小權限', tags: ['Remote Access VPN', '最小權限', 'NAT 穿透'],
    brief: '颱風天全公司居家辦公，會計 Amy 需要從家裡連回公司的 ERP。ERP 不能直接開放到網際網路，請在總公司防火牆上開啟遠端存取 VPN，並且只讓 VPN 用戶連得到 ERP，其他內部設備一概不行。',
    given: [
      ['VPN 伺服器', '203.0.113.18（HQ-FW 的 WAN1）'], ['VPN 帳號 / 密碼', 'amy / Vpn#Amy2026'], ['VPN 位址池', '10.99.0.10 – 10.99.0.50'],
      ['可存取的內部網段', '10.1.0.0/24'], ['ERP 伺服器', '10.1.0.10 · HTTPS'], ['原則', 'VPN 用戶只能用 HTTPS 連 ERP'],
    ],
    learn: [
      { t: '遠端存取 VPN', d: '使用者的電腦裝 VPN 用戶端，撥入後會拿到一個公司內部的虛擬 IP，就像人坐在辦公室一樣。' },
      { t: '分割通道', d: '只有要去公司內網的流量走 VPN，其他上網流量仍然從家裡直接出去，不佔用公司頻寬。' },
      { t: '最小權限', d: '連上 VPN 不代表什麼都能碰。防火牆政策應該只放行使用者工作真正需要的服務。' },
    ],
    setup: () => {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: twoLines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' });
      setLine(inet, 'line2', { type: 'dhcp', gw: '198.51.100.1', assign: '198.51.100.120' });
      return makeState([
        inet,
        D('fg60f', 'hq', {
          name: 'HQ-FW', pos: [-6, -4.5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
            Object.assign(g('internal'), { ip: '10.1.0.1', mask: '255.255.255.0' });
            d.policies.push(allow('內網上網', 'internal', 'wan1', { nat: true }));
          },
        }),
        D('sw5', 'hq-sw', { name: 'HQ-Switch', pos: [-6, 0.3] }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-9.5, 4.8], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('pc', 'hq-pc', { name: '總公司 PC', pos: [-3, 4.8], ip: '10.1.0.50', gw: '10.1.0.1', dns: '8.8.8.8' }),
        D('homerouter', 'home', { name: '家用路由器', pos: [7, -4], init(d) { Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' }); } }),
        D('laptop', 'nb', { name: 'Amy 的筆電', pos: [7, 1.5], dhcp: true, init(d) { d.vpnClient = { on: false, server: '', user: '', pass: '' }; } }),
      ], [['inet:line1', 'hq:wan1'], ['inet:line2', 'home:wan'], ['hq:1', 'hq-sw:1'], ['erp:eth0', 'hq-sw:2'], ['hq-pc:eth0', 'hq-sw:3'], ['nb:eth0', 'home:lan1']]);
    },
    objectives: [
      { type: 'tcp', from: 'nb', to: 'erp', port: 443, label: 'Amy 在家可以經由 VPN 使用 ERP (HTTPS)' },
      { type: 'ping', from: 'nb', to: 'hq-pc', expect: false, label: 'VPN 用戶碰不到其他內部電腦（筆電 ✕ 總公司 PC）' },
      { type: 'ping', from: 'nb', ip: '8.8.8.8', label: 'Amy 平常上網不受影響（分割通道）' },
    ],
    hints: [
      'HQ-FW →「VPN」分頁下方的「遠端存取 VPN」：開啟，位址池 10.99.0.10 – 10.99.0.50，可存取網段 10.1.0.0/24，新增使用者 amy / Vpn#Amy2026。',
      'HQ-FW →「政策」新增一條：來源介面「遠端使用者 VPN」→ 目的介面 internal，目的位址 10.1.0.10，服務 HTTPS，允許。',
      '點 Amy 的筆電 →「VPN」分頁：伺服器 203.0.113.18、帳號 amy、密碼 Vpn#Amy2026，然後開啟連線。',
    ],
    solve(s) {
      const f = dev(s, 'hq');
      Object.assign(f.vpnServer, { on: true, start: '10.99.0.10', end: '10.99.0.50', subnets: '10.1.0.0/24', users: [{ user: 'amy', pass: 'Vpn#Amy2026' }] });
      f.policies.push(allow('VPN 用戶到 ERP', 'vpn:remote', 'internal', { dst: '10.1.0.10', service: 'HTTPS' }));
      dev(s, 'nb').vpnClient = { on: true, server: '203.0.113.18', user: 'amy', pass: 'Vpn#Amy2026' };
    },
    recap: ['遠端存取 VPN 讓內部服務不必暴露在網際網路上。', '給 VPN 用戶的權限越小，帳號被盜時的損害就越小。'],
  },
  {
    id: 'l22', chapter: 7, title: '雙線路備援', subtitle: '浮動靜態路由', tags: ['雙 WAN', 'Floating Static', '管理距離'],
    brief: '上個月光纖被挖斷，公司整整斷網半天。老闆多申請了一條不同業者的線路當備援。請讓路由器平常走 ISP-A，ISP-A 的線路斷掉時自動改走 ISP-B。',
    given: [
      ['ISP-A（主要）', '203.0.113.2/30 · 閘道 203.0.113.1（已完成）'], ['ISP-B（備援）', '198.51.100.2/30 · 閘道 198.51.100.1'],
      ['備援線路接在', 'Router 的 Gi0/0/1'], ['要求', '平常走 ISP-A；ISP-A 斷線時自動改走 ISP-B'],
    ],
    learn: [
      { t: '管理距離 (AD)', d: '同一個目的地有多條路由時，路由器選管理距離最小的。直連 0、靜態 1、OSPF 110。' },
      { t: '浮動靜態路由', d: '替備援路由設一個比較大的管理距離（例如 10）。平常它被主要路由蓋過，主要線路的介面斷線時才「浮」上來接手。' },
      { t: '兩條線都要 NAT', d: '備援線路的 IP 不一樣，所以那個介面也要開 NAT，否則改道後封包出得去卻回不來。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'isp-a', { name: 'ISP-A 光纖', pos: [-6, -9.5] }), 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' }),
      setLine(D('internet', 'isp-b', { name: 'ISP-B 備援', pos: [6, -9.5] }), 'line1', { type: 'static', gw: '198.51.100.1', mask: '255.255.255.252', assign: '198.51.100.2' }),
      D('isr4331', 'rt', {
        name: 'Router', pos: [0, -4.5],
        init(d) {
          Object.assign(d.ifaces[0], { ip: '203.0.113.2', mask: '255.255.255.252', gateway: '203.0.113.1', nat: true });
          Object.assign(d.ifaces[2], { ip: '192.168.1.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[2].dhcp, { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '8.8.8.8' });
        },
      }),
      D('sw5', 'sw', { name: 'Switch', pos: [0, 0] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-4.5, 4.5], dhcp: true }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [4.5, 4.5], dhcp: true }),
    ], [['isp-a:line1', 'rt:Gi0/0/0'], ['isp-b:line1', 'rt:Gi0/0/1'], ['rt:Gi0/0/2', 'sw:1'], ['pc-1:eth0', 'sw:2'], ['pc-2:eth0', 'sw:3']]),
    objectives: [
      { type: 'ping', from: 'pc-1', ip: '8.8.8.8', via: 'isp-a', label: '平常 PC-1 經由 ISP-A 上網' },
      {
        type: 'check', label: '備援的預設路由是浮動靜態路由（管理距離大於 1）',
        test(s) {
          const r = dev(s, 'rt').rt.routes.find((x) => x.bits === 0 && x.via === parseIp('198.51.100.1'));
          if (!r) return '還沒有經由 ISP-B (198.51.100.1) 的預設路由';
          if (r.bad) return '經由 ISP-B 的預設路由目前無效：' + r.bad;
          return r.ad > 1 || '兩條預設路由的管理距離相同，路由器會把流量分散到兩條線上，搭配 NAT 會讓連線錯亂。請把備援路由的距離調大。';
        },
      },
      { type: 'failover', cut: [['rt', 'Gi0/0/0']], label: 'ISP-A 斷線時，PC-2 仍然可以上網', test: { type: 'tcp', from: 'pc-2', name: 'www.example.com', port: 443 } },
    ],
    hints: [
      'Router →「介面」：Gi0/0/1 設 198.51.100.2 / 255.255.255.252，並勾選 NAT。這裡的「預設閘道」欄位先留空。',
      'Router →「路由」新增靜態路由：目的 0.0.0.0、遮罩 0.0.0.0、下一站 198.51.100.1。',
      '把這條路由的「距離」改成 10。主要路由的距離是 1，所以平常會走 ISP-A。',
    ],
    solve(s) {
      Object.assign(ifc(s, 'rt', 'Gi0/0/1'), { ip: '198.51.100.2', mask: '255.255.255.252', nat: true });
      dev(s, 'rt').routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '198.51.100.1', ad: '10' });
    },
    recap: ['備援不是多拉一條線就好，路由和 NAT 都要一起準備。', '這個做法只偵測得到介面斷線；ISP 內部故障要搭配 IP SLA 之類的追蹤機制。'],
  },

  // ════════════════════════ 第八章：高可用與進階路由 ════════════════════════
  {
    id: 'l23', chapter: 8, title: '迴圈與生成樹', subtitle: 'STP 與根橋', tags: ['STP', 'Root Bridge', '廣播風暴'],
    brief: '為了備援，三台交換器接成了三角形。但有人嫌開機太慢，把生成樹協定 (STP) 關掉了 — 結果廣播封包在三角形裡無限繞圈，整個網路癱瘓。請重新啟用 STP，並指定核心交換器當根橋。',
    given: [['三角形連線', 'Core–A、Core–B、A–B，都是 Trunk'], ['要求', 'SW-Core 是根橋；任何一條線斷掉都不影響連線'], ['建議優先權', 'SW-Core 設為 4096（數字越小越優先）']],
    learn: [
      { t: '廣播風暴', d: '交換器會把廣播送往所有埠。只要有迴圈，廣播就會永遠繞下去而且越繞越多，幾秒內塞爆整個網路。' },
      { t: 'STP', d: '交換器互相交換 BPDU，選出一台根橋，然後把多餘的路徑暫時封鎖 (Blocking)。線路斷掉時，被封鎖的埠會自動開啟。' },
      { t: '根橋選舉', d: '優先權最小的當根橋；一樣就比 MAC 位址。不手動指定的話，可能是最舊、最慢的那台交換器當選。' },
    ],
    setup: () => {
      const sw = (id, name, pos) => D('c2960', id, {
        name, pos,
        init(d) { d.sw.stp.on = false; d.sw.ports['Gi0/9'].mode = 'trunk'; d.sw.ports['Gi0/10'].mode = 'trunk'; },
      });
      return makeState([
        sw('sw-c', 'SW-Core', [0, -4.5]), sw('sw-a', 'SW-A', [-6.5, 0.5]), sw('sw-b', 'SW-B', [6.5, 0.5]),
        D('nas', 'srv', { name: '檔案伺服器', pos: [6, -7.5], ip: '192.168.1.10' }),
        D('pc', 'pc-a', { name: 'PC-A', pos: [-8.5, 5], ip: '192.168.1.21' }),
        D('pc', 'pc-b', { name: 'PC-B', pos: [8.5, 5], ip: '192.168.1.22' }),
      ], [
        ['sw-c:Gi0/9', 'sw-a:Gi0/9'], ['sw-c:Gi0/10', 'sw-b:Gi0/9'], ['sw-a:Gi0/10', 'sw-b:Gi0/10'],
        ['srv:eth0', 'sw-c:Gi0/1'], ['pc-a:eth0', 'sw-a:Gi0/1'], ['pc-b:eth0', 'sw-b:Gi0/1'],
      ]);
    },
    objectives: [
      { type: 'ping', from: 'pc-a', to: 'srv', label: 'PC-A 可以 ping 到檔案伺服器' },
      { type: 'ping', from: 'pc-b', to: 'srv', label: 'PC-B 可以 ping 到檔案伺服器' },
      {
        type: 'check', label: '三台交換器都啟用 STP，且 SW-Core 是根橋',
        test(s) {
          for (const id of ['sw-c', 'sw-a', 'sw-b']) if (dev(s, id).sw.stp.on === false) return `${dev(s, id).name} 的 STP 還是關閉的`;
          const root = dev(s, 'sw-c').rt.stp.root[1];
          if (!root) return '三台交換器之間的連線不完整，無法選出根橋';
          return root === 'sw-c' || `目前的根橋是 ${dev(s, root).name}，請把 SW-Core 的優先權調小`;
        },
      },
      { type: 'failover', cut: [['sw-a', 'Gi0/9']], label: 'SW-A 到 Core 的線斷掉時，PC-A 仍然連得到伺服器', test: { type: 'ping', from: 'pc-a', to: 'srv' } },
    ],
    hints: [
      '點任一台交換器 →「安全」分頁，開啟「生成樹協定 (STP)」。三台都要開。',
      '把 SW-Core 的 STP 優先權改成 4096。「狀態」分頁會顯示誰是根橋、哪個埠被封鎖。',
      '不要把 A–B 那條線拔掉：它平常被 STP 封鎖，但其他線斷掉時要靠它接手。',
    ],
    solve(s) {
      for (const id of ['sw-c', 'sw-a', 'sw-b']) dev(s, id).sw.stp.on = true;
      dev(s, 'sw-c').sw.stp.prio = 4096;
    },
    recap: ['第二層沒有 TTL，迴圈只能靠 STP 這類機制打斷。', '根橋要手動指定給位在網路中心、效能最好的交換器。'],
  },
  {
    id: 'l24', chapter: 8, title: 'EtherChannel', subtitle: 'LACP 鏈路聚合', tags: ['LACP', 'Port-channel', '鏈路聚合'],
    brief: '核心與接取交換器之間拉了兩條線，想要兩條一起用、頻寬加倍，而且斷一條也沒事。核心那一端已經設成 Port-channel，但接取這一端還沒設定，所以現在兩條線都被暫停。請完成 LACP 設定。',
    given: [['上行連線', 'Gi0/9 ↔ Gi0/9、Gi0/10 ↔ Gi0/10'], ['核心端', 'Port-channel 1 · LACP passive（已完成）'], ['提醒', 'LACP 至少要有一端是 active']],
    learn: [
      { t: 'EtherChannel', d: '把多條實體線綁成一條邏輯線 (Port-channel)。STP 把它當成一條線看待，所以不會封鎖任何一條，頻寬可以全部用上。' },
      { t: 'LACP 模式', d: 'active 會主動協商，passive 只會回應。active–active 與 active–passive 可以成功，passive–passive 誰也不開口，就建不起來。' },
      { t: '成員設定要一致', d: '同一個 Port-channel 的成員，模式、VLAN、Trunk 設定都必須相同，否則會被暫停 (suspended)。' },
    ],
    setup: () => {
      const sw = (id, name, pos, init) => D('c2960', id, {
        name, pos,
        init(d) {
          d.sw.vlans.push({ id: 10, name: 'OFFICE' });
          d.sw.ports['Gi0/9'].mode = 'trunk'; d.sw.ports['Gi0/10'].mode = 'trunk';
          init(d);
        },
      });
      return makeState([
        sw('sw-c', 'SW-Core', [0, -4], (d) => {
          d.sw.ports['Gi0/1'].vlan = 10;
          for (const p of ['Gi0/9', 'Gi0/10']) Object.assign(d.sw.ports[p], { lag: 1, lagMode: 'passive' });
        }),
        sw('sw-a', 'SW-Access', [0, 1], (d) => { d.sw.ports['Gi0/1'].vlan = 10; d.sw.ports['Gi0/2'].vlan = 10; }),
        D('nas', 'srv', { name: '檔案伺服器', pos: [6.5, -6], ip: '192.168.10.10' }),
        D('pc', 'pc-1', { name: 'PC-1', pos: [-5, 5.6], ip: '192.168.10.21' }),
        D('pc', 'pc-2', { name: 'PC-2', pos: [5, 5.6], ip: '192.168.10.22' }),
      ], [
        ['sw-c:Gi0/9', 'sw-a:Gi0/9'], ['sw-c:Gi0/10', 'sw-a:Gi0/10'],
        ['srv:eth0', 'sw-c:Gi0/1'], ['pc-1:eth0', 'sw-a:Gi0/1'], ['pc-2:eth0', 'sw-a:Gi0/2'],
      ]);
    },
    objectives: [
      { type: 'ping', from: 'pc-1', to: 'srv', label: 'PC-1 可以 ping 到檔案伺服器' },
      {
        type: 'check', label: '兩台交換器的 Port-channel 都有 2 條成員線路',
        test(s) {
          for (const id of ['sw-c', 'sw-a']) {
            const lag = Object.values(dev(s, id).rt.lag);
            const bad = lag.find((l) => l.state === 'suspended');
            if (bad) return `${dev(s, id).name} 的成員被暫停：${bad.why}`;
            if (lag.filter((l) => l.state === 'bundled').length !== 2) return `${dev(s, id).name} 的 Port-channel 還沒有 2 條成員`;
          }
          return true;
        },
      },
      { type: 'failover', cut: [['sw-a', 'Gi0/9']], label: '其中一條線斷掉時，PC-2 仍然連得到伺服器', test: { type: 'ping', from: 'pc-2', to: 'srv' } },
    ],
    hints: [
      '點 SW-Access →「連接埠」，展開 Gi0/9 的進階設定，Port-channel 編號填 1。',
      'LACP 模式選 active（核心端是 passive，兩邊都 passive 不會成功）。',
      'Gi0/10 做一樣的設定。兩個成員的模式與 VLAN 設定必須完全相同。',
    ],
    solve(s) {
      for (const p of ['Gi0/9', 'Gi0/10']) Object.assign(swp(s, 'sw-a', p), { lag: 1, lagMode: 'active' });
    },
    recap: ['EtherChannel 同時解決頻寬與備援，而且不會被 STP 封鎖。', '建不起來時先看兩端的模式：至少一邊要 active。'],
  },
  {
    id: 'l25', chapter: 8, title: '閘道備援', subtitle: 'VRRP / HSRP 虛擬閘道', tags: ['VRRP', 'HSRP', 'FHRP'],
    brief: '公司有兩台閘道路由器，但所有電腦的預設閘道都寫死指向 GW-A。上週 GW-A 韌體更新重開機，全公司就斷網了。請讓兩台路由器共用一個虛擬閘道 IP，其中一台掛掉時另一台自動接手。',
    given: [
      ['辦公網段', '10.0.10.0/24'], ['GW-A / GW-B 的實體 IP', '10.0.10.2 / 10.0.10.3'], ['虛擬閘道 IP', '10.0.10.1'],
      ['優先權', 'GW-A 110（主要）、GW-B 100（備援）'], ['上游路由', 'Edge 與兩台 GW 之間的 OSPF 已經設定好'],
    ],
    learn: [
      { t: 'FHRP', d: '第一跳備援協定（Cisco 的 HSRP、公開標準的 VRRP）。多台路由器共同回應一個虛擬 IP，用戶端的閘道指向它。' },
      { t: 'Master / Backup', d: '優先權最高的當 Master 負責轉送。Backup 持續監聽，一旦收不到 Master 的訊息就立刻接手虛擬 IP。' },
      { t: '用戶端不用改', d: '切換時虛擬 IP 不變（連 MAC 都是同一個虛擬 MAC），電腦完全不知道後面換了一台路由器。' },
      { t: '切換要幾秒', d: 'Backup 大約 3 秒沒聽到 Master 的通告才會接手，這幾秒內沒有人回應虛擬 IP。可以把 Master 關機（設備面板右上角的電源鈕）親眼看一次。' },
    ],
    setup: () => {
      const gw = (id, name, pos, up, lan) => D('isr4331', id, {
        name, pos,
        init(d) {
          Object.assign(d.ifaces[0], { ip: up, mask: '255.255.255.252', ospf: true });
          Object.assign(d.ifaces[1], { ip: lan, mask: '255.255.255.0', ospf: true });
        },
      });
      return makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -12] }), 'line1', { type: 'static', gw: '203.0.113.65', mask: '255.255.255.252', assign: '203.0.113.66' }),
        D('isr4331', 'edge', {
          name: 'Edge', pos: [0, -7.5],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.66', mask: '255.255.255.252', gateway: '203.0.113.65', nat: true });
            Object.assign(d.ifaces[1], { ip: '10.0.1.1', mask: '255.255.255.252', ospf: true });
            Object.assign(d.ifaces[2], { ip: '10.0.2.1', mask: '255.255.255.252', ospf: true });
            d.ospfDefault = true;
          },
        }),
        gw('gw-a', 'GW-A', [-5.5, -3], '10.0.1.2', '10.0.10.2'),
        gw('gw-b', 'GW-B', [5.5, -3], '10.0.2.2', '10.0.10.3'),
        D('sw8', 'sw', { name: 'Switch', pos: [0, 1.5] }),
        D('pc', 'pc-1', { name: 'PC-1', pos: [-4.5, 6], ip: '10.0.10.21', gw: '10.0.10.2', dns: '8.8.8.8' }),
        D('pc', 'pc-2', { name: 'PC-2', pos: [4.5, 6], ip: '10.0.10.22', gw: '10.0.10.2', dns: '8.8.8.8' }),
      ], [
        ['inet:line1', 'edge:Gi0/0/0'], ['edge:Gi0/0/1', 'gw-a:Gi0/0/0'], ['edge:Gi0/0/2', 'gw-b:Gi0/0/0'],
        ['gw-a:Gi0/0/1', 'sw:1'], ['gw-b:Gi0/0/1', 'sw:2'], ['pc-1:eth0', 'sw:3'], ['pc-2:eth0', 'sw:4'],
      ]);
    },
    objectives: [
      { type: 'ping', from: 'pc-1', ip: '8.8.8.8', via: 'gw-a', label: '平常由 GW-A 擔任主要閘道' },
      { type: 'failover', down: ['gw-a'], label: 'GW-A 故障時，PC-1 仍然可以上網', test: { type: 'ping', from: 'pc-1', ip: '8.8.8.8' } },
      { type: 'failover', down: ['gw-a'], label: 'GW-A 故障時，PC-2 仍然可以開啟網站', test: { type: 'tcp', from: 'pc-2', name: 'www.example.com', port: 443 } },
      { type: 'failover', down: ['gw-b'], label: 'GW-B 故障時，PC-2 也不受影響', test: { type: 'ping', from: 'pc-2', ip: '8.8.8.8' } },
    ],
    hints: [
      'GW-A →「介面」→ Gi0/0/1：開啟 VRRP，虛擬 IP 填 10.0.10.1，優先權 110。',
      'GW-B 的 Gi0/0/1 也開啟 VRRP，虛擬 IP 一樣是 10.0.10.1，優先權 100。',
      '最後把 PC-1、PC-2 的預設閘道從 10.0.10.2 改成虛擬 IP 10.0.10.1。',
    ],
    solve(s) {
      ifc(s, 'gw-a', 'Gi0/0/1').vrrp = { on: true, vip: '10.0.10.1', prio: '110' };
      ifc(s, 'gw-b', 'Gi0/0/1').vrrp = { on: true, vip: '10.0.10.1', prio: '100' };
      for (const id of ['pc-1', 'pc-2']) dev(s, id).ifaces[0].gateway = '10.0.10.1';
    },
    recap: ['預設閘道是單點故障：一台電腦只能填一個閘道。', 'FHRP 用虛擬 IP 把「閘道」和「某一台實體路由器」脫鉤。'],
  },
  {
    id: 'l26', chapter: 8, title: '集中式 DHCP', subtitle: 'DHCP Relay 與位址範圍', tags: ['DHCP Relay', 'ip helper-address', 'Scope'],
    brief: '公司想把散落在各處的 DHCP 設定集中到一台伺服器上管理。問題是 DHCP 請求是廣播，過不了 VLAN。請在伺服器上建立各網段的位址範圍，並讓核心交換器把各 VLAN 的 DHCP 請求轉送給它。',
    given: [
      ['VLAN 10 業務', '10.0.10.0/24 · 閘道 10.0.10.1'], ['VLAN 20 研發', '10.0.20.0/24 · 閘道 10.0.20.1'], ['VLAN 99 伺服器', '10.0.99.0/24 · 閘道 10.0.99.1'],
      ['DHCP 伺服器', '10.0.99.10（固定 IP）'], ['發放範圍', '各網段的 .100 – .199'],
    ],
    learn: [
      { t: 'DHCP Relay', d: '在各 VLAN 的閘道介面上設定 helper-address。閘道收到 DHCP 廣播後，改用單點傳送轉交給遠端的 DHCP 伺服器。' },
      { t: 'Scope（位址範圍）', d: '伺服器替每個網段準備一個範圍。它根據是哪個閘道介面轉送來的，決定要從哪個範圍發 IP。' },
    ],
    setup: () => makeState([
      D('c9300', 'core', {
        name: 'Core', pos: [0, -3.5],
        init(d) {
          d.sw.vlans.push({ id: 10, name: 'SALES' }, { id: 20, name: 'RD' }, { id: 99, name: 'SERVERS' });
          d.sw.ports['Gi1/0/1'].vlan = 10; d.sw.ports['Gi1/0/2'].vlan = 20; d.sw.ports['Gi1/0/24'].vlan = 99;
          for (const v of [10, 20, 99]) d.ifaces.push(newIface('vlan' + v, 'Vlan' + v, { t: 'svi', vlan: v }, { ip: `10.0.${v}.1`, mask: '255.255.255.0' }));
        },
      }),
      D('pc', 'pc-a', { name: '業務 PC', pos: [-6.5, 2.5], dhcp: true }),
      D('pc', 'pc-b', { name: '研發 PC', pos: [0, 4.2], dhcp: true }),
      D('tower', 'dhcp', { name: 'DHCP 伺服器', pos: [6.5, 2.5], init(d) { d.dhcpScopes = []; } }),
    ], [['pc-a:eth0', 'core:Gi1/0/1'], ['pc-b:eth0', 'core:Gi1/0/2'], ['dhcp:eth0', 'core:Gi1/0/24']]),
    objectives: [
      { type: 'dhcp', dev: 'pc-a', subnet: '10.0.10.0/24', label: '業務 PC 取得 10.0.10.x' },
      { type: 'dhcp', dev: 'pc-b', subnet: '10.0.20.0/24', label: '研發 PC 取得 10.0.20.x' },
      { type: 'ping', from: 'pc-a', to: 'pc-b', label: '業務 PC 可以 ping 到研發 PC' },
    ],
    hints: [
      'DHCP 伺服器 →「網路設定」：固定 IP 10.0.99.10 / 255.255.255.0，閘道 10.0.99.1（沒有閘道它就回不了其他網段）。',
      'DHCP 伺服器 →「DHCP 服務」新增兩個範圍：10.0.10.100 – 10.0.10.199 與 10.0.20.100 – 10.0.20.199。',
      'Core →「L3 介面」：在 Vlan10 與 Vlan20 的「DHCP Relay」欄位填 10.0.99.10。',
    ],
    solve(s) {
      setIp(s, 'dhcp', '10.0.99.10', '255.255.255.0', '10.0.99.1');
      dev(s, 'dhcp').dhcpScopes.push(
        { start: '10.0.10.100', end: '10.0.10.199', gw: '', dns: '8.8.8.8' },
        { start: '10.0.20.100', end: '10.0.20.199', gw: '', dns: '8.8.8.8' },
      );
      ifc(s, 'core', 'vlan10').helper = '10.0.99.10';
      ifc(s, 'core', 'vlan20').helper = '10.0.99.10';
    },
    recap: ['廣播出不了 VLAN，所以需要 Relay 把它「翻譯」成單點傳送。', '集中管理 DHCP 之後，新增網段只要多一個 Scope 和一行 helper-address。'],
  },
  {
    id: 'l27', chapter: 8, title: 'OSPF 路徑選擇', subtitle: '動態路由與 Cost', tags: ['OSPF', 'Cost', '路徑選擇'],
    brief: '台北、台中、高雄三個據點用光纖串成一線，台北與高雄之間另外還有一條速度很慢的備援微波。請用 OSPF 取代手寫的靜態路由，並調整 Cost，讓台北 ↔ 高雄的流量平常走台中的光纖，光纖斷了才走微波。',
    given: [
      ['台北 ↔ 台中', '10.0.12.0/30 · 光纖 1G'], ['台中 ↔ 高雄', '10.0.23.0/30 · 光纖 1G'], ['台北 ↔ 高雄', '10.0.13.0/30 · 微波 10M（Gi0/0/1）'],
      ['各據點 LAN', '10.1.0.0/24、10.2.0.0/24、10.3.0.0/24'], ['現況', '介面 IP 都設好了；台中已經啟用 OSPF'],
    ],
    learn: [
      { t: 'OSPF', d: '鏈路狀態路由協定。每台路由器都知道整張網路的地圖，各自算出到每個網段的最短路徑。' },
      { t: 'Cost', d: 'OSPF 的「距離」是沿途出口介面 Cost 的總和，數字越小越好。Cost 通常依頻寬決定，也可以手動調整來影響選路。' },
      { t: '自動收斂', d: '線路斷掉時，鄰居關係消失，路由器會重新計算並改走其他路徑，不需要人工介入。' },
      { t: '收斂需要時間', d: '在乙太網路上，新的 OSPF 鄰居要先等 40 秒（選出 DR）才會交換路由；鄰居隔著交換器失聯時，也要 40 秒 (Dead timer) 才會發現。場景上方的時鐘旁會出現「收斂中」，可以等它，也可以點一下快轉。' },
    ],
    setup: () => {
      const r = (id, name, pos, ips, ospf) => D('isr4331', id, {
        name, host: id.toUpperCase(), pos, // 命令列上是 R-TPE、R-TXG、R-KHH
        init(d) { ips.forEach(([ip, mask], n) => Object.assign(d.ifaces[n], { ip, mask, ospf })); },
      });
      const P = '255.255.255.252', L = '255.255.255.0';
      return makeState([
        r('r-tpe', '台北', [-8, -3], [['10.0.12.1', P], ['10.0.13.1', P], ['10.1.0.1', L]], false),
        r('r-txg', '台中', [0, -7.5], [['10.0.12.2', P], ['10.0.23.1', P], ['10.2.0.1', L]], true),
        r('r-khh', '高雄', [8, -3], [['10.0.23.2', P], ['10.0.13.2', P], ['10.3.0.1', L]], false),
        D('pc', 'pc', { name: '台北 PC', pos: [-8, 2.8], ip: '10.1.0.50', gw: '10.1.0.1' }),
        D('tower', 'srv', { name: '高雄伺服器', pos: [8, 2.8], ip: '10.3.0.10', gw: '10.3.0.1', services: WEB }),
      ], [
        ['r-tpe:Gi0/0/0', 'r-txg:Gi0/0/0'], ['r-txg:Gi0/0/1', 'r-khh:Gi0/0/0'], ['r-tpe:Gi0/0/1', 'r-khh:Gi0/0/1'],
        ['pc:eth0', 'r-tpe:Gi0/0/2'], ['srv:eth0', 'r-khh:Gi0/0/2'],
      ]);
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'srv', port: 443, via: 'r-txg', label: '台北 PC 經由台中的光纖連到高雄伺服器' },
      { type: 'ping', from: 'srv', to: 'pc', via: 'r-txg', label: '高雄往台北的回程也走台中的光纖' },
      { type: 'failover', cut: [['r-tpe', 'Gi0/0/0']], label: '台北–台中光纖斷線時，自動改走微波', test: { type: 'tcp', from: 'pc', to: 'srv', port: 443 } },
    ],
    hints: [
      '台北與高雄的路由器 →「介面」：三個介面都勾選 OSPF（可以參考台中的設定）。',
      '全部啟用後已經會通，但走的是微波，因為直連只有一跳、Cost 最小。',
      '把台北與高雄兩端 Gi0/0/1（微波）的 OSPF Cost 調成 100。來回兩個方向都要調，各自由出口那一端的 Cost 決定。',
    ],
    solve(s) {
      for (const id of ['r-tpe', 'r-khh']) {
        for (const i of dev(s, id).ifaces) i.ospf = true;
        ifc(s, id, 'Gi0/0/1').ospfCost = '100';
      }
    },
    recap: ['動態路由自己找路、自己繞路，網路越大越離不開它。', '最少跳數不等於最快。用 Cost 告訴 OSPF 哪條路才是你想要的。'],
  },
  {
    id: 'l28', chapter: 8, title: '切蛋糕', subtitle: 'VLSM 子網路切割', tags: ['Subnetting', 'VLSM', 'CIDR'],
    brief: '總部只分給這間辦公室一段 172.20.8.0/24。三個部門的人數差很多，如果平均切會不夠用。請依照各部門需要的主機數，用剛好夠用的遮罩把這一段切給三個網段，並讓大家都拿得到 IP。',
    given: [
      ['可用區塊', '172.20.8.0/24'], ['研發部（Gi0/0/0）', '需要 100 台'], ['業務部（Gi0/0/1）', '需要 50 台'], ['訪客（Gi0/0/2）', '需要 20 台'],
      ['規則', '每個網段用「剛好夠用」的最小遮罩，彼此不能重疊'],
    ],
    learn: [
      { t: '主機數怎麼算', d: '遮罩剩下 n 個主機位元，就有 2ⁿ − 2 個可用位址（扣掉網路位址與廣播位址）。/25 有 126 個、/26 有 62 個、/27 有 30 個。' },
      { t: 'VLSM', d: '可變長度子網路遮罩：同一段位址可以切成大小不同的子網路。訣竅是從最大的需求開始切，一塊接著一塊往後排。' },
      { t: '區塊邊界', d: '/25 以 128 為單位、/26 以 64、/27 以 32。子網路的起點一定落在自己區塊大小的倍數上。' },
    ],
    setup: () => makeState([
      D('isr4331', 'rt', { name: 'Router', pos: [0, -3] }),
      D('pc', 'rd', { name: '研發 PC', pos: [-7, 3], dhcp: true }),
      D('pc', 'sales', { name: '業務 PC', pos: [0, 4.6], dhcp: true }),
      D('laptop', 'guest', { name: '訪客筆電', pos: [7, 3], dhcp: true }),
    ], [['rd:eth0', 'rt:Gi0/0/0'], ['sales:eth0', 'rt:Gi0/0/1'], ['guest:eth0', 'rt:Gi0/0/2']]),
    objectives: [
      {
        type: 'check', label: '三個網段都在 172.20.8.0/24 之內、大小剛好、互不重疊',
        test(s) {
          const block = parseCidr('172.20.8.0/24');
          const need = [['Gi0/0/0', 100, '研發部'], ['Gi0/0/1', 50, '業務部'], ['Gi0/0/2', 20, '訪客']];
          const nets = [];
          for (const [id, n, name] of need) {
            const r = ifc(s, 'rt', id).rt;
            if (r.ip == null) return `${name}的介面 ${id} 還沒有設定 IP 與遮罩`;
            if (netOf(r.ip, 24) !== block.net || r.bits < 24) return `${name}的網段 ${fmtIp(netOf(r.ip, r.bits))}/${r.bits} 超出了 172.20.8.0/24`;
            const usable = 2 ** (32 - r.bits) - 2;
            if (usable < n) return `${name}需要 ${n} 台，但 /${r.bits} 只有 ${usable} 個可用位址`;
            if (2 ** (32 - r.bits - 1) - 2 >= n) return `${name}只需要 ${n} 台，/${r.bits}（${usable} 個位址）太浪費了，用更小的遮罩就夠`;
            nets.push({ name, a: netOf(r.ip, r.bits), b: netOf(r.ip, r.bits) + 2 ** (32 - r.bits) - 1 });
          }
          for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) {
            if (nets[i].a <= nets[j].b && nets[j].a <= nets[i].b) return `${nets[i].name}和${nets[j].name}的網段重疊了`;
          }
          return true;
        },
      },
      { type: 'dhcp', dev: 'rd', label: '研發 PC 透過 DHCP 取得 IP' },
      { type: 'dhcp', dev: 'sales', label: '業務 PC 透過 DHCP 取得 IP' },
      { type: 'dhcp', dev: 'guest', label: '訪客筆電透過 DHCP 取得 IP' },
      { type: 'ping', from: 'rd', to: 'guest', label: '研發 PC 可以 ping 到訪客筆電' },
    ],
    hints: [
      '先算遮罩：100 台要 /25（255.255.255.128，126 個位址）；50 台要 /26（255.255.255.192，62 個）；20 台要 /27（255.255.255.224，30 個）。',
      '從大的開始排：研發 172.20.8.0/25 → 業務 172.20.8.128/26 → 訪客 172.20.8.192/27。',
      'Router 三個介面各用該網段的第一個可用 IP（.1、.129、.193），並開啟 DHCP，例如 .10 – .126、.130 – .190、.194 – .222。',
    ],
    solve(s) {
      const cfg = [['Gi0/0/0', '172.20.8.1', '255.255.255.128', '172.20.8.10', '172.20.8.126'], ['Gi0/0/1', '172.20.8.129', '255.255.255.192', '172.20.8.130', '172.20.8.190'], ['Gi0/0/2', '172.20.8.193', '255.255.255.224', '172.20.8.194', '172.20.8.222']];
      for (const [id, ip, mask, a, b] of cfg) {
        const i = ifc(s, 'rt', id);
        Object.assign(i, { ip, mask });
        Object.assign(i.dhcp, { on: true, start: a, end: b });
      }
    },
    recap: ['子網路切割是所有網路證照的必考題，多練幾次就會變成反射動作。', '想再練習，可以到「測驗」裡的子網路速算。'],
  },
];
