// 第二層安全的補充關卡：MAC flooding 與 Port Security、雙重標籤與 Native VLAN、廣播風暴與 Storm Control、
// 飯店房間的 Private VLAN、IPv6 的冒牌路由器與 RA Guard
import { makeDevice as D, makeState, newIface, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute, transact, macAgeOf } from '../engine/sim.js';
import { camFull, psMax } from '../engine/l2sec.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const saveAll = (s, ids) => { for (const id of ids) typeIn(s, id, ['write memory']); };
const ip4 = (d, idx, ip, mask = '255.255.255.0') => Object.assign(d.ifaces[idx], { ip, mask });
/** 這一次連線（來回）有沒有被泛洪到某台設備：在它的封包擷取看得到 */
const seenBy = (r, id) => r.hops.some((h) => (h.leak || []).some((x) => x.to === id));
const SMB = [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }];

export const LEVELS21 = [
  // ─────────────────────────────────────────────── MAC flooding
  {
    id: 'l83', chapter: 6, title: '交換器變成了 Hub', subtitle: 'MAC flooding 與 Port Security', tags: ['MAC flooding', 'CAM 表', 'Port Security', '側錄'],
    brief: '資安團隊在會議室的網路孔抓到一台不明筆電，它在跑 macof：每秒送出幾千個來源 MAC 都不一樣的訊框，把 SW-2F 的 MAC 位址表塞滿了。表一滿，交換器就像 Hub 一樣把訊框送到每一個埠，財務同事和檔案伺服器之間的流量全被那台筆電收走。會議室的網路孔之後還要給訪客用，不能直接關掉。請讓接使用者的埠擋得住這種攻擊，並讓交換器恢復正常。',
    given: [
      ['SW-2F', 'Catalyst 2960，MAC 位址表最多 8,192 筆'], ['財務 PC', 'Gi0/1 · 10.20.0.11'], ['人資 PC', 'Gi0/3 · 10.20.0.12'],
      ['檔案伺服器', 'Gi0/2 · 10.20.0.10（SMB 445）'], ['會議室網路孔', 'Gi0/5 · 不明筆電（無法設定它）'],
    ],
    learn: [
      { t: 'MAC 位址表會滿', d: '交換器用 MAC 位址表（CAM 表）決定訊框從哪個埠出去，但表的大小有限（2960 是 8,192 筆）。攻擊工具送出大量來源 MAC 都不一樣的訊框，表很快就滿了，新的 MAC 再也學不進來。' },
      { t: '學不到就泛洪', d: '目的 MAC 不在表裡，交換器只能送往整個 VLAN 的每一個埠 (unknown unicast flooding)。攻擊者的網卡因此收到別人的流量，用 Wireshark 就能側錄。這也是為什麼不能把交換器當成「天生安全」。' },
      { t: 'Port Security', d: '限制一個埠後面最多幾個 MAC (switchport port-security maximum)。超過的就是違規：protect 默默丟掉、restrict 丟掉並記紀錄、計次數、shutdown（預設）把整個埠關成 err-disabled。設定的順序很重要：先設 maximum 與違規動作，最後才打開 switchport port-security。' },
      { t: '已經塞進去的不會馬上消失', d: '用 restrict / protect 擋住之後，表裡那幾千筆亂造的 MAC 還要等老化時間（預設 300 秒）才會清掉，clear mac address-table dynamic 可以立刻清；如果是 shutdown 把埠關掉，從那個埠學到的項目會跟著立刻清掉。show mac address-table count 看得到還剩多少空間。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'sw', { name: 'SW-2F', pos: [0, -3] }),
        D('pc', 'fin', { name: '財務 PC', pos: [-7, 3], ip: '10.20.0.11' }),
        D('tower', 'fs', { name: '檔案伺服器', pos: [-8, -6], ip: '10.20.0.10', services: SMB }),
        D('pc', 'hr', { name: '人資 PC', pos: [-2.5, 5], ip: '10.20.0.12' }),
        D('laptop', 'atk', { name: '不明筆電', pos: [6.5, 3.5], ip: '10.20.0.66', locked: true, init(d) { d.macFlood = true; } }),
      ], [['fin:eth0', 'sw:Gi0/1'], ['fs:eth0', 'sw:Gi0/2'], ['hr:eth0', 'sw:Gi0/3'], ['atk:eth0', 'sw:Gi0/5']]);
      recompute(s);
      saveAll(s, ['sw']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'fin', to: 'fs', port: 445, label: '財務 PC 照樣打得開檔案伺服器' },
      {
        type: 'check', label: '不明筆電收不到財務 PC 和檔案伺服器之間的流量',
        test(s) {
          const r = transact(s, 'fin', { proto: 'tcp', dst: dev(s, 'fs').ifaces[0].rt.ip, dport: 445, quiet: true });
          if (!r.ok) return `財務 PC 連不到檔案伺服器：${r.reason}`;
          const r2 = transact(s, 'fin', { proto: 'tcp', dst: dev(s, 'fs').ifaces[0].rt.ip, dport: 445, quiet: true });
          return !seenBy(r2, 'atk') || 'SW-2F 不知道檔案伺服器（或財務 PC）在哪個埠，只好往每個埠泛洪：不明筆電的封包擷取看得到這些流量';
        },
      },
      {
        type: 'check', label: '接使用者的埠（Gi0/1、Gi0/3、Gi0/5）都開了 Port Security，會議室的埠沒有被手動關掉',
        test(s) {
          const sw = dev(s, 'sw').sw;
          for (const p of ['Gi0/1', 'Gi0/3', 'Gi0/5']) {
            const ps = sw.ports[p].ps;
            if (!ps || !ps.on) return `${p} 還沒有開 Port Security`;
            if (psMax(ps) > 4) return `${p} 的 maximum 設成 ${psMax(ps)}：一般使用者的埠 1 到 2 個就夠了`;
          }
          return sw.ports['Gi0/5'].shut ? 'Gi0/5 被手動 shutdown 了：會議室的網路孔之後還要給訪客用，交給 Port Security 處理' : true;
        },
      },
      {
        type: 'check', label: 'SW-2F 的 MAC 位址表恢復正常（沒有被塞滿）',
        test(s) { const d = dev(s, 'sw'); return !camFull(s, d, macAgeOf(d)) || '表還是滿的：攻擊沒有擋住，或亂造的項目還沒老化（clear mac address-table dynamic）'; },
      },
    ],
    hints: [
      'SW-2F 的 CLI：show mac address-table count，8,192 筆已經全滿；show mac address-table interface gi0/5 看得到幾千筆亂造的 MAC 全學在會議室的埠。',
      'interface range gi0/1 , gi0/3 , gi0/5 → switchport mode access → switchport port-security maximum 2 → switchport port-security violation restrict → 最後才 switchport port-security（先打開的話，預設的 shutdown 會立刻把會議室的埠關成 err-disabled——也擋得住，只是那個埠要手動恢復）。',
      '擋住之後表裡還有 8,000 多筆亂造的 MAC：clear mac address-table dynamic 立刻清掉（或等 300 秒老化）。show port-security interface gi0/5 的違規次數會一直增加。',
      '圖形介面：交換器「連接埠」分頁 → 進階 → Port Security（最多幾個 MAC、違規時的動作）；「安全」分頁的 MAC 位址表卡片有清除按鈕。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['configure terminal', 'interface range gi0/1 , gi0/3 , gi0/5', 'switchport mode access', 'switchport port-security maximum 2', 'switchport port-security violation restrict', 'switchport port-security', 'end', 'write memory']);
    },
    recap: ['MAC 位址表被塞滿，交換器就退化成 Hub：別人的流量會被泛洪到攻擊者那裡。', 'Port Security 限制每個埠的 MAC 數量；先設 maximum 與違規動作，再打開。'],
  },

  // ─────────────────────────────────────────────── 雙重標籤
  {
    id: 'l84', chapter: 6, title: '跳進伺服器 VLAN 的封包', subtitle: '雙重標籤 (double tagging) 與 Native VLAN', tags: ['VLAN hopping', '雙重標籤', 'Native VLAN', 'Trunk'],
    brief: '伺服器 VLAN 的入侵偵測系統收到奇怪的 UDP 封包：來源是使用者 VLAN 的筆電，卻沒有經過 R1 的 ACL，直接出現在伺服器 VLAN 裡。那台筆電接的埠早就設成 access + nonegotiate，DTP 那一招沒用。問題出在 SW-3F 和 SW-DC 之間的 Trunk：前任為了讓舊的基地台不用設 VLAN，把 Native VLAN 設成使用者的 VLAN 10。請讓雙重標籤的封包再也跳不過去，使用者照樣能用資料庫的網頁介面。',
    given: [
      ['VLAN', '10 使用者 10.30.10.0/24 · 20 伺服器 10.30.20.0/24'], ['SW-3F ↔ SW-DC', 'Gi0/9 Trunk · Native VLAN 10'], ['SW-3F ↔ R1', 'Gi0/10 Trunk（R1 子介面 Gi0/0/1.10、.20）'],
      ['資料庫伺服器', 'SW-DC Gi0/2 · 10.30.20.10 · 網頁 443、MySQL 3306'], ['可疑的筆電', 'SW-3F Gi0/5（VLAN 10，無法設定它）'], ['R1 的 ACL', '使用者只能用 443 連伺服器 VLAN'],
    ],
    learn: [
      { t: '雙重標籤', d: '攻擊者在 Native VLAN 的 Access 埠送出帶兩層 802.1Q 標籤的訊框：外層是 Native VLAN、裡面是目標 VLAN。第一台交換器拿掉外層，從 Trunk 送出去時因為是 Native VLAN 不加標籤，對面的交換器看到的就是裡面那層，訊框直接進了目標 VLAN。' },
      { t: '只能單向', d: '回覆的封包回不到攻擊者（它其實在另一個 VLAN），所以只能送出去、收不到回應。但送一個惡意的 UDP（Syslog、SNMP、SIP）就夠了，而且完全繞過了路由器上的 ACL。' },
      { t: '怎麼防', d: '① Trunk 的 Native VLAN 改成一個沒有任何使用者的 VLAN（例如 999），兩端要一樣；② 或是 vlan dot1q tag native，讓 Native VLAN 的訊框也加標籤；③ 使用者的埠一律 access + nonegotiate，也不要放在 VLAN 1。' },
      { t: 'Native VLAN 要兩端一致', d: '只改一端，兩邊對「沒有標籤的訊框屬於哪個 VLAN」的認知不同，CDP 會一直報 Native VLAN mismatch，流量也會跑錯 VLAN。' },
    ],
    setup() {
      const vl = (d) => d.sw.vlans.push({ id: 10, name: 'USERS' }, { id: 20, name: 'SERVERS' });
      const s = makeState([
        D('isr4321', 'r1', {
          name: 'R1', pos: [-7, -7],
          init(d) {
            const sub = (v, ip, extra = {}) => d.ifaces.push(newIface(`Gi0/0/1.${v}`, `Gi0/0/1.${v}`, { t: 'sub', port: 'Gi0/0/1', vlan: v }, { ip, mask: '255.255.255.0', ...extra }));
            sub(10, '10.30.10.1', { aclIn: [{ action: 'permit', proto: 'tcp', src: 'any', dst: '10.30.20.10', port: '443' }, { action: 'deny', proto: 'ip', src: 'any', dst: '10.30.20.0/24', port: '' }, { action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: '' }], aclNames: { in: 'USERS-IN' } });
            sub(20, '10.30.20.1');
          },
        }),
        D('c2960', 'swa', {
          name: 'SW-3F', pos: [-4, -2],
          init(d) {
            vl(d);
            for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/5']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 10, noneg: true });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', native: 10, noneg: true });
            Object.assign(d.sw.ports['Gi0/10'], { mode: 'trunk', noneg: true });
          },
        }),
        D('c2960', 'swb', {
          name: 'SW-DC', pos: [5, -2],
          init(d) { vl(d); Object.assign(d.sw.ports['Gi0/2'], { mode: 'access', vlan: 20, noneg: true }); Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', native: 10, noneg: true }); },
        }),
        D('pc', 'pc1', { name: '同事 A', pos: [-9, 4], ip: '10.30.10.11', gw: '10.30.10.1' }),
        D('pc', 'pc2', { name: '同事 B', pos: [-5, 5.5], ip: '10.30.10.12', gw: '10.30.10.1' }),
        D('laptop', 'atk', {
          name: '可疑的筆電', pos: [0, 5], ip: '10.30.10.66', gw: '10.30.10.1', locked: true,
          // Scapy 做的雙重標籤：外層 VLAN 10（自己的 Access VLAN）、裡面 VLAN 20
          init(d) { d.ifaces.push(newIface('eth0.20', 'eth0.20', { t: 'sub', port: 'eth0', vlan: 20, outer: 10 }, { ip: '10.30.20.66', mask: '255.255.255.0' })); },
        }),
        D('rack1u', 'db', { name: '資料庫伺服器', pos: [8, 4], ip: '10.30.20.10', gw: '10.30.20.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS 網頁介面' }, { proto: 'tcp', port: 3306, name: 'MySQL' }, { proto: 'udp', port: 514, name: 'Syslog' }] }),
      ], [['r1:Gi0/0/1', 'swa:Gi0/10'], ['swa:Gi0/9', 'swb:Gi0/9'], ['pc1:eth0', 'swa:Gi0/1'], ['pc2:eth0', 'swa:Gi0/2'], ['atk:eth0', 'swa:Gi0/5'], ['db:eth0', 'swb:Gi0/11']]);
      // 資料庫伺服器是 SFP 網卡：接在 SW-DC 的 SFP 埠
      Object.assign(s.devices.swb.sw.ports['Gi0/11'], { mode: 'access', vlan: 20, noneg: true });
      recompute(s);
      saveAll(s, ['r1', 'swa', 'swb']);
      return s;
    },
    objectives: [
      {
        type: 'check', label: '可疑的筆電送的雙重標籤封包，進不了伺服器的 VLAN',
        test(s) {
          const r = transact(s, 'atk', { proto: 'udp', dst: dev(s, 'db').ifaces[0].rt.ip, dport: 514, quiet: true });
          return r.phase !== 'reply' && !r.ok ? true : '筆電送出的封包到得了資料庫伺服器（回覆雖然回不去，但惡意的封包已經送到了）：SW-3F 拿掉外層標籤後，從 Native VLAN 10 的 Trunk 不加標籤送出去，裡面那層 VLAN 20 就被當真了';
        },
      },
      { type: 'tcp', from: 'pc1', to: 'db', port: 443, label: '同事照樣能用資料庫的網頁介面 (HTTPS)' },
      { type: 'tcp', from: 'pc2', to: 'db', port: 3306, expect: false, label: '同事連不到 MySQL (3306)：R1 的 ACL 照樣有效' },
      {
        type: 'check', label: 'SW-3F 和 SW-DC 之間 Trunk 的 Native VLAN 兩端一致',
        test(s) {
          const a = dev(s, 'swa').sw.ports['Gi0/9'].native, b = dev(s, 'swb').sw.ports['Gi0/9'].native;
          return a === b || `兩端的 Native VLAN 不一樣（SW-3F ${a}、SW-DC ${b}）：沒有標籤的訊框兩邊認定的 VLAN 不同，CDP 會一直報 Native VLAN mismatch`;
        },
      },
    ],
    hints: [
      'SW-3F：show interfaces trunk，Gi0/9 的 Native vlan 是 10，剛好是使用者的 VLAN。筆電送的訊框外層是 10、裡面是 20：SW-3F 拿掉外層，送上 Trunk 時 VLAN 10 不加標籤，SW-DC 看到的就只剩 VLAN 20。',
      '兩台都要：vlan 999 → name NATIVE-UNUSED → interface gi0/9 → switchport trunk native vlan 999。Native VLAN 不再是任何使用者的 VLAN，外層被拿掉之後送上 Trunk 會加上標籤 10，裡面那層就不會被當真。',
      '另一種做法（也可以一起做）：兩台都下 vlan dot1q tag native，Native VLAN 的訊框一樣加標籤。show interfaces gi0/9 switchport 的 Administrative Native VLAN tagging 會變成 enabled。',
    ],
    solve(s) {
      for (const id of ['swa', 'swb']) typeIn(s, id, ['configure terminal', 'vlan 999', 'name NATIVE-UNUSED', 'exit', 'interface gi0/9', 'switchport trunk native vlan 999', 'end', 'write memory']);
    },
    recap: ['雙重標籤利用「Native VLAN 不加標籤」：攻擊者在 Native VLAN 裡就能把封包送進別的 VLAN，而且繞過路由器的 ACL。', 'Trunk 的 Native VLAN 改成沒人用的 VLAN（兩端一致），或 vlan dot1q tag native。'],
  },

  // ─────────────────────────────────────────────── 廣播風暴與 Storm Control
  {
    id: 'l85', chapter: 10, title: '整層樓都慢了', subtitle: '廣播風暴與 Storm Control', tags: ['廣播風暴', 'Storm Control', '介面計數器', '故障排除'],
    brief: '二樓的同事從中午開始抱怨：ping 都通，但存檔到 NAS 慢到不行，連上網都卡。網路沒有迴圈，STP 也很正常。請找出原因，讓二樓恢復正常的速度，而且以後再有任何一台電腦這樣亂送封包，交換器要能自己擋下來。',
    given: [
      ['SW-2F', 'Catalyst 2960 · Gi0/1 – 0/4 接同事的電腦 · Gi0/7 NAS · Gi0/9 上行到 R1'], ['NAS', '10.40.0.10（SMB 445）'], ['同事的電腦', '10.40.0.21 – 10.40.0.24'],
    ],
    learn: [
      { t: '廣播會送到每一個埠', d: '交換器收到廣播，一定送往同一個 VLAN 的每一個埠。中毒的電腦或壞掉的網卡狂送廣播，整個 VLAN 的每一條線都被這些廣播佔掉，其他流量只拿得到剩下的頻寬：ping 會通，但大量傳輸慢得要命。' },
      { t: '找出是誰', d: '看每個埠的計數器：show interfaces 的「broadcasts」、show interfaces counters。正常的埠一秒幾個廣播，出問題的那個埠會是幾十萬個。' },
      { t: 'Storm Control', d: '在埠上設定廣播的上限（連接埠頻寬的百分比）：storm-control broadcast level 1.00。超過的部分直接丟掉；加上 storm-control action shutdown 會把埠關成 err-disabled，trap 則送 SNMP 通知。' },
      { t: '和迴圈造成的廣播風暴不一樣', d: '交換器之間有迴圈時，廣播會一直繞圈、永遠不停，那要靠 STP。這一關是單一台設備自己狂送，STP 管不到，要靠 Storm Control。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [-9, -9] }), 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' }),
        D('isr4321', 'r1', { name: 'R1', pos: [-4, -7], init(d) { ip4(d, 0, '203.0.113.18', '255.255.255.248'); Object.assign(d.ifaces[0], { gateway: '203.0.113.17', nat: true }); ip4(d, 1, '10.40.0.1'); } }),
        D('c2960', 'sw', { name: 'SW-2F', pos: [0, -2] }),
        D('nas', 'nas', { name: 'NAS', pos: [7, -5], ip: '10.40.0.10', gw: '10.40.0.1', services: SMB }),
        D('pc', 'p1', { name: '小陳', pos: [-8, 4], ip: '10.40.0.21', gw: '10.40.0.1', dns: '8.8.8.8' }),
        D('pc', 'p2', { name: '小林', pos: [-3.5, 5.5], ip: '10.40.0.22', gw: '10.40.0.1', dns: '8.8.8.8' }),
        D('pc', 'p3', { name: '小王', pos: [1.5, 5.5], ip: '10.40.0.23', gw: '10.40.0.1', dns: '8.8.8.8', locked: true, init(d) { d.bcastFlood = 880; } }),
        D('pc', 'p4', { name: '小張', pos: [6.5, 4], ip: '10.40.0.24', gw: '10.40.0.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'r1:Gi0/0/0'], ['r1:Gi0/0/1', 'sw:Gi0/9'], ['nas:eth0', 'sw:Gi0/7'], ['p1:eth0', 'sw:Gi0/1'], ['p2:eth0', 'sw:Gi0/2'], ['p3:eth0', 'sw:Gi0/3'], ['p4:eth0', 'sw:Gi0/4']]);
      recompute(s);
      saveAll(s, ['r1', 'sw']);
      return s;
    },
    objectives: [
      { type: 'speed', from: 'p1', to: 'nas', port: 445, min: 500, label: '小陳存檔到 NAS 跑得到 500 Mbps 以上' },
      { type: 'speed', from: 'p4', to: 'nas', port: 445, min: 500, label: '小張也一樣' },
      {
        type: 'check', label: '接電腦的埠（Gi0/1 – 0/4）都設了廣播的上限（不超過 5%）',
        test(s) {
          const sw = dev(s, 'sw').sw;
          for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4']) {
            const st = sw.ports[p].storm;
            if (!st || st.bcast == null) return `${p} 還沒有設定 storm-control broadcast level`;
            if (+st.bcast > 5) return `${p} 的上限 ${st.bcast}% 太高了：1 Gbps 的 5% 就是 50 Mbps 的廣播，一般電腦用不到 1%`;
          }
          return sw.ports['Gi0/3'].shut ? 'Gi0/3 被手動關掉了：這次是找到了，下次換別台呢？讓 storm-control 自動處理' : true;
        },
      },
    ],
    hints: [
      '先找是哪一台：SW-2F 的 CLI 打 show interfaces | include line protocol|broadcasts，Gi0/3 收到的廣播比其他埠多了好幾個數量級（也可以看「狀態」分頁的介面計數器）。',
      '每個接電腦的埠設定廣播上限：interface range gi0/1 - 4 → storm-control broadcast level 1.00。超過 1%（10 Mbps）的廣播就被丟掉。',
      '想直接把亂送的埠關掉，再加 storm-control action shutdown（Gi0/3 會變成 err-disabled，原因是 storm-control）。show storm-control 看得到每個埠目前的廣播量與狀態（Forwarding / Blocking）。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['configure terminal', 'interface range gi0/1 - 4', 'storm-control broadcast level 1.00', 'storm-control action shutdown', 'end', 'write memory']);
    },
    recap: ['單一台設備狂送廣播，整個 VLAN 的每條線都被佔掉：ping 會通，傳輸卻很慢。從介面的廣播計數器找出是誰。', 'Storm Control 在接電腦的埠設定廣播上限，超過就丟掉或把埠關掉。'],
  },

  // ─────────────────────────────────────────────── Private VLAN
  {
    id: 'l86', chapter: 6, title: '飯店的房間網路', subtitle: 'Private VLAN：isolated、community、promiscuous', tags: ['Private VLAN', 'isolated', 'community', '網段隔離'],
    brief: '飯店的房客反映：在房間裡打開檔案總管，竟然看得到隔壁房客的電腦。所有房間和會議室都在同一個 VLAN、同一個網段，用的是 Catalyst 9300 和同一台閘道 GW（DHCP 與上網）。請讓每個房間彼此完全隔離，但都能上網；兩間會議室要能互通（研討會常常把兩間打通用），會議室也看不到房間。網段和閘道不要改。',
    given: [
      ['網段', '10.50.0.0/24 · 閘道 GW 10.50.0.1（DHCP、NAT）· Gi1/0/24'], ['房間', '1201 號房 Gi1/0/1 · 1202 號房 Gi1/0/2（DHCP）'], ['會議室', 'A 廳 Gi1/0/3 · B 廳 Gi1/0/4（DHCP）'],
      ['目前', '全部在 VLAN 100'],
    ],
    learn: [
      { t: '同一個網段，卻彼此看不到', d: 'Private VLAN 把一個 VLAN（primary）再切成幾個 secondary VLAN，大家用同一個網段與同一個閘道，但第二層彼此隔離。飯店、宿舍、機房的租戶伺服器常用。' },
      { t: '三種埠', d: 'isolated（secondary）：彼此完全不通，只能和 promiscuous 埠通。community（secondary）：同一組互通，和其他組、isolated 都不通。promiscuous：接閘道、共用伺服器，誰都通。' },
      { t: '設定的步驟', d: 'vlan 101 → private-vlan isolated；vlan 102 → private-vlan community；vlan 100 → private-vlan primary → private-vlan association 101,102。房間的埠 switchport mode private-vlan host + switchport private-vlan host-association 100 101；閘道的埠 switchport mode private-vlan promiscuous + switchport private-vlan mapping 100 101,102。' },
      { t: '哪些交換器有', d: 'Catalyst 9300、Nexus 這類有完整的 Private VLAN；2960 只有 switchport protected（同一台的 protected 埠彼此不通）。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -12] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.248', assign: '203.0.113.34' }),
        D('isr4321', 'gw', {
          name: 'GW', pos: [0, -7.5],
          init(d) {
            ip4(d, 0, '203.0.113.34', '255.255.255.248'); Object.assign(d.ifaces[0], { gateway: '203.0.113.33', nat: true });
            ip4(d, 1, '10.50.0.1'); Object.assign(d.ifaces[1].dhcp, { on: true, start: '10.50.0.100', end: '10.50.0.199', dns: '8.8.8.8' });
          },
        }),
        D('c9300', 'sw', {
          name: 'SW-Hotel', pos: [0, -2],
          init(d) {
            d.sw.vlans.push({ id: 100, name: 'GUESTS' });
            for (const p of ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Gi1/0/4', 'Gi1/0/24']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 100 });
          },
        }),
        D('laptop', 'r1201', { name: '1201 號房', pos: [-9, 4], dhcp: true, services: SMB }),
        D('laptop', 'r1202', { name: '1202 號房', pos: [-4, 5.5], dhcp: true, services: SMB }),
        D('pc', 'ca', { name: 'A 廳', pos: [4, 5.5], dhcp: true, services: SMB }),
        D('pc', 'cb', { name: 'B 廳', pos: [9, 4], dhcp: true, services: SMB }),
      ], [['inet:line1', 'gw:Gi0/0/0'], ['gw:Gi0/0/1', 'sw:Gi1/0/24'], ['r1201:eth0', 'sw:Gi1/0/1'], ['r1202:eth0', 'sw:Gi1/0/2'], ['ca:eth0', 'sw:Gi1/0/3'], ['cb:eth0', 'sw:Gi1/0/4']]);
      recompute(s);
      saveAll(s, ['gw', 'sw']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'r1201', name: 'www.example.com', port: 443, label: '1201 號房可以上網' },
      { type: 'tcp', from: 'ca', name: 'www.example.com', port: 443, label: 'A 廳可以上網' },
      { type: 'tcp', from: 'r1201', to: 'r1202', port: 445, expect: false, label: '1201 號房看不到 1202 號房的電腦' },
      { type: 'tcp', from: 'ca', to: 'cb', port: 445, label: 'A 廳和 B 廳互通' },
      { type: 'tcp', from: 'ca', to: 'r1201', port: 445, expect: false, label: '會議室看不到房間的電腦' },
      {
        type: 'check', label: '網段與閘道沒有改（大家還是 10.50.0.0/24、閘道 10.50.0.1，用 DHCP 拿位址）',
        test(s) {
          for (const id of ['r1201', 'r1202', 'ca', 'cb']) {
            const i = dev(s, id).ifaces[0];
            if (i.mode !== 'dhcp') return `${dev(s, id).name} 改成手動設定了：規定是照樣用 DHCP`;
            if (i.rt.src !== 'dhcp') return `${dev(s, id).name} 拿不到 DHCP 的位址：${i.rt.note || '（沒有回應）'}`;
          }
          return true;
        },
      },
    ],
    hints: [
      '先建立 secondary：SW-Hotel → vlan 101 → private-vlan isolated → vlan 102 → private-vlan community → vlan 100 → private-vlan primary → private-vlan association 101,102。',
      '房間：interface range gi1/0/1 - 2 → switchport mode private-vlan host → switchport private-vlan host-association 100 101。會議室：interface range gi1/0/3 - 4 → 同樣的模式，host-association 100 102。',
      '閘道的埠：interface gi1/0/24 → switchport mode private-vlan promiscuous → switchport private-vlan mapping 100 101,102。show vlan private-vlan 看得到每個 secondary 對應到哪些埠（圖形介面：「VLAN」分頁設定種類，「連接埠」的進階設定選 Private VLAN 的模式）。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['configure terminal', 'vlan 101', 'name ROOMS', 'private-vlan isolated', 'vlan 102', 'name MEETING', 'private-vlan community', 'vlan 100', 'private-vlan primary', 'private-vlan association 101,102', 'exit',
        'interface range gi1/0/1 - 2', 'switchport mode private-vlan host', 'switchport private-vlan host-association 100 101', 'exit',
        'interface range gi1/0/3 - 4', 'switchport mode private-vlan host', 'switchport private-vlan host-association 100 102', 'exit',
        'interface gi1/0/24', 'switchport mode private-vlan promiscuous', 'switchport private-vlan mapping 100 101,102', 'end', 'write memory']);
    },
    recap: ['Private VLAN：同一個網段、同一個閘道，第二層卻彼此隔離。isolated 誰都不通、community 同組互通、promiscuous 接閘道。', '2960 沒有 Private VLAN，只有 switchport protected。'],
  },

  // ─────────────────────────────────────────────── RA Guard
  {
    id: 'l87', chapter: 9, title: 'IPv6 的預設閘道被搶走了', subtitle: '冒牌的 Router Advertisement 與 RA Guard', tags: ['IPv6', 'Router Advertisement', 'RA Guard', 'SLAAC'],
    brief: '研發部的 IPv6 突然全斷了，IPv4 卻完全正常。同事的電腦多了一個 2001:db8:bad:: 開頭的位址，預設閘道也變成一個奇怪的 fe80:: 位址。原來有人把一台裝了 radvd 的測試筆電接到辦公室的網路孔，忘了關掉。請讓同事的電腦只聽 R1 的 RA，以後不管誰接上會送 RA 的設備都不會影響大家。',
    given: [
      ['R1', 'Gi0/0/0 2001:db8:10::1/64（送 RA）· Gi0/0/1 2001:db8:99::1/64 伺服器網段'], ['伺服器', '2001:db8:99::10（HTTPS）'],
      ['SW-RD', 'Gi0/1 – Gi0/8 接電腦 · Gi0/9 上行到 R1'], ['測試筆電', 'Gi0/6，送 2001:db8:bad::/64 的 RA、優先權 High（無法設定它）'],
    ],
    learn: [
      { t: 'RA 沒有驗證', d: 'IPv6 的主機靠 Router Advertisement 拿前綴（SLAAC）與預設閘道。任何設備都能送 RA，主機照單全收：每一個 RA 的前綴都會產生一個位址，預設閘道選優先權最高的那一台。冒牌的 RA 常常把優先權設成 High。' },
      { t: '後果', d: '主機的 IPv6 預設閘道變成冒牌的設備：它不轉送就是黑洞（整個網段的 IPv6 斷光），它轉送就是中間人。這和 IPv4 的冒牌 DHCP 是同一類問題。' },
      { t: 'RA Guard', d: '在交換器上把連接埠分成兩種：接電腦的埠 device-role host，從這裡進來的 RA 一律丟掉；接路由器的埠 device-role router。ipv6 nd raguard policy HOSTS → device-role host，再到介面上 ipv6 nd raguard attach-policy HOSTS。' },
      { t: '雙協定的盲點', d: '很多網路只做了 DHCP Snooping，卻忘了 IPv6 也有一模一樣的攻擊面。就算公司沒有規劃 IPv6，Windows 與 macOS 預設都開著，冒牌的 RA 一樣有效。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'r1', {
          name: 'R1', pos: [0, -7],
          init(d) {
            d.v6routing = true;
            Object.assign(d.ifaces[0], { ip: '10.60.0.1', mask: '255.255.255.0', ip6: '2001:db8:10::1/64', ra: true });
            Object.assign(d.ifaces[1], { ip: '10.60.99.1', mask: '255.255.255.0', ip6: '2001:db8:99::1/64' });
          },
        }),
        D('tower', 'srv', { name: '伺服器', pos: [8, -7], ip: '10.60.99.10', gw: '10.60.99.1', services: WEB, init(d) { Object.assign(d.ifaces[0], { mode6: 'static', ip6: '2001:db8:99::10/64', gw6: '2001:db8:99::1' }); } }),
        D('c2960', 'sw', { name: 'SW-RD', pos: [0, -2] }),
        D('pc', 'pc1', { name: '研發 A', pos: [-8, 4], ip: '10.60.0.11', gw: '10.60.0.1' }),
        D('pc', 'pc2', { name: '研發 B', pos: [-3, 5.5], ip: '10.60.0.12', gw: '10.60.0.1' }),
        D('laptop', 'rogue', { name: '測試筆電（radvd）', pos: [5, 5], ip: '10.60.0.66', gw: '10.60.0.1', locked: true, init(d) { d.ifaces[0].rogueRa = { prefix: '2001:db8:bad::/64', prio: 'high' }; } }),
      ], [['r1:Gi0/0/0', 'sw:Gi0/9'], ['r1:Gi0/0/1', 'srv:eth0'], ['pc1:eth0', 'sw:Gi0/1'], ['pc2:eth0', 'sw:Gi0/2'], ['rogue:eth0', 'sw:Gi0/6']]);
      s.v6 = true;
      recompute(s);
      saveAll(s, ['r1', 'sw']);
      return s;
    },
    objectives: [
      { type: 'ping6', from: 'pc1', ip6: '2001:db8:99::10', proto: 'tcp', port: 443, label: '研發 A 用 IPv6 連得到伺服器的網站' },
      { type: 'ping6', from: 'pc2', ip6: '2001:db8:99::10', proto: 'tcp', port: 443, label: '研發 B 也一樣' },
      {
        type: 'check', label: '同事電腦的 IPv6 預設閘道是 R1，也沒有冒牌前綴的位址',
        test(s) {
          for (const id of ['pc1', 'pc2']) {
            const v = dev(s, id).ifaces[0].rt.v6 || {};
            if (v.router !== 'r1') return `${dev(s, id).name} 的 IPv6 預設閘道是 ${(dev(s, v.router) || {}).name || '（沒有）'}`;
            if ((v.addrs || []).some((a) => a.rogue)) return `${dev(s, id).name} 還有 2001:db8:bad:: 的位址`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '接電腦的埠（Gi0/1 – Gi0/8）都掛了 device-role host 的 RA Guard',
        test(s) {
          const sw = dev(s, 'sw').sw;
          for (let n = 1; n <= 8; n++) {
            const p = sw.ports['Gi0/' + n], pol = p.raGuard && (sw.raPolicies || {})[p.raGuard];
            if (!pol) return `Gi0/${n} 沒有掛 RA Guard 的政策：今天是 Gi0/6，明天可能是任何一個網路孔`;
            if ((pol.role || 'host') !== 'host') return `Gi0/${n} 的政策是 device-role ${pol.role}：接電腦的埠要用 host`;
          }
          const up = sw.ports['Gi0/9'].raGuard && (sw.raPolicies || {})[sw.ports['Gi0/9'].raGuard];
          return !up || up.role === 'router' || 'Gi0/9 接的是 R1，掛了 host 的政策會連 R1 的 RA 都擋掉';
        },
      },
    ],
    hints: [
      '研發 A 的終端機：ipconfig，IPv6 位址有兩個，其中一個是 2001:db8:bad:: 開頭，預設閘道是一個 fe80:: 位址。用 R1 的 show ipv6 interface brief 比對：那不是 R1 的 link-local。',
      'SW-RD：ipv6 nd raguard policy HOSTS → device-role host → exit → interface range gi0/1 - 8 → ipv6 nd raguard attach-policy HOSTS。從這些埠進來的 RA 全部丟掉。',
      '上行到 R1 的 Gi0/9 可以另外掛一個 device-role router 的政策（ipv6 nd raguard policy ROUTER → device-role router），或乾脆不掛。show ipv6 nd raguard policy 看得到每個政策套在哪些埠。（圖形介面：交換器「安全」分頁建立政策，有「套用到接電腦的埠」的按鈕）',
    ],
    solve(s) {
      typeIn(s, 'sw', ['configure terminal', 'ipv6 nd raguard policy HOSTS', 'device-role host', 'exit', 'interface range gi0/1 - 8', 'ipv6 nd raguard attach-policy HOSTS', 'end', 'write memory']);
    },
    recap: ['IPv6 的 RA 沒有驗證：誰送都信，冒牌的 RA 能搶走整個網段的預設閘道。', 'RA Guard 把接電腦的埠設成 device-role host，從那裡進來的 RA 一律丟掉。'],
  },
];
