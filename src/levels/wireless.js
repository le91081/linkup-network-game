// 第十四章：無線控制器與無線環境 — WLC 與輕量型 AP、牆面衰減、漫遊
import { makeDevice as D, makeState, newIface, newWifi, newSsid, addCable } from '../engine/model.js';
import { dev } from './util.js';

export const CHAPTERS8 = [
  { id: 14, title: '無線控制器與無線環境', desc: '輕量型 AP 與無線控制器（CAPWAP、option 43、Local 模式、RRM），牆面衰減與訊號熱力圖，漫遊與 sticky client。' },
];

const sub = (d, vlan, ip, dhcp) => {
  const i = newIface(`Gi0/0/1.${vlan}`, `Gi0/0/1.${vlan}`, { t: 'sub', port: 'Gi0/0/1', vlan }, { ip, mask: '255.255.255.0' });
  if (dhcp) Object.assign(i.dhcp, { on: true, pool: dhcp.name, start: dhcp.start, end: dhcp.end, dns: '', gw: '', ...(dhcp.wlc ? { wlc: dhcp.wlc } : {}) });
  d.ifaces.push(i);
};
const CORP = { ssid: 'Corp', pass: 'Corp@2026!' };
const SRV = '10.10.40.10';
const HTTPS = [{ proto: 'tcp', port: 443, name: 'HTTPS' }];
const rrmOk = (s) => {
  const aps = Object.values(s.devices).filter((d) => d.lwap && d.rt.capwap && d.rt.capwap.joined);
  const bad = aps.find((d) => d.rt.interf.length);
  return bad ? `${bad.name} 和 ${s.devices[bad.rt.interf[0].dev].name} 在 ${bad.rt.interf[0].band} 同頻道` : true;
};
const joined = (s, ids) => {
  for (const id of ids) {
    const d = dev(s, id), c = d.rt.capwap || {};
    if (!c.joined) return `${d.name} 沒有加入控制器：${c.why || '還沒有找到控制器'}`;
  }
  return true;
};

/** 第十四章共用的網路：R1（子介面當閘道與 DHCP）、PoE 交換器、WLC、伺服器 */
function campus(o = {}) {
  return [
    D('isr4321', 'rt', {
      name: 'R1', pos: [0, -9],
      init(d) {
        sub(d, 10, '10.10.10.1');
        sub(d, 20, '10.10.20.1', { name: 'AP', start: '10.10.20.100', end: '10.10.20.199', wlc: o.opt43 });
        sub(d, 30, '10.10.30.1', { name: 'CORP', start: '10.10.30.100', end: '10.10.30.199' });
        sub(d, 40, '10.10.40.1');
      },
    }),
    D('c2960p', 'sw', {
      name: 'SW-1F', pos: [0, -4.5],
      init(d) {
        d.sw.vlans.push({ id: 10, name: 'WLC-MGMT' }, { id: 20, name: 'AP' }, { id: 30, name: 'CORP' }, { id: 40, name: 'SERVERS' });
        Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: 'all' });
        Object.assign(d.sw.ports['Gi0/10'], { mode: 'trunk', allowed: o.wlcAllowed || '10,30' });
        for (const p of ['Gi0/1', 'Gi0/2']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 20 });
        Object.assign(d.sw.ports['Gi0/8'], { mode: 'access', vlan: 40 });
      },
    }),
    D('c9800', 'wlc', {
      name: 'WLC', pos: [8, -5],
      init(d) {
        Object.assign(d.ifaces[0], { ip: '10.10.10.5', mask: '255.255.255.0', gateway: '10.10.10.1' });
        d.ifaces[0].bind.vlan = 10;
        d.wlc.wlans.push({ id: 1, ssid: CORP.ssid, sec: 'wpa2', pass: CORP.pass, vlan: 30 });
      },
    }),
    D('tower', 'srv', { name: '檔案伺服器', pos: [-8, -5], ip: SRV, gw: '10.10.40.1', services: HTTPS }),
  ];
}
const campusCables = [['rt:Gi0/0/1', 'sw:Gi0/9'], ['wlc:Te0/1/0', 'sw:Gi0/10'], ['srv:eth0', 'sw:Gi0/8']];

export const LEVELS10 = [
  // ════════════════════════ 14-1 ════════════════════════
  {
    id: 'l55', chapter: 14, title: 'AP 找不到控制器', subtitle: '輕量型 AP、CAPWAP、DHCP option 43、Local 模式', tags: ['WLC', 'CAPWAP', 'option 43', 'Lightweight AP'],
    brief: '一樓換成 Cisco 的無線控制器加輕量型 AP。AP 已經上牆、也亮了燈，但完全沒有放送 SSID；控制器上的 WLAN「Corp」早就設好了。AP 在 VLAN 20，控制器的管理介面在 VLAN 10。請讓兩台 AP 加入控制器，員工的筆電連上 Corp 之後要能開檔案伺服器。',
    given: [
      ['WLC', '10.10.10.5（VLAN 10）· WLAN Corp → VLAN 30'], ['AP', 'VLAN 20 · DHCP 位址池 AP（R1 的 Gi0/0/1.20）'],
      ['員工 (Corp)', 'VLAN 30 · 10.10.30.0/24'], ['檔案伺服器', `${SRV}（VLAN 40）`],
    ],
    learn: [
      { t: '輕量型 AP 與控制器', d: '輕量型 AP (Lightweight AP) 自己沒有設定：開機拿到 IP 之後要先找到無線控制器 (WLC)，用 CAPWAP 加入，SSID、加密、頻道全部由控制器下發。這種分工叫 Split-MAC：即時的無線電工作在 AP，管理與政策在控制器。' },
      { t: 'AP 怎麼找到控制器', d: '依序試：AP 上手動指定的控制器、DHCP 的 option 43、DNS 的 CISCO-CAPWAP-CONTROLLER、同一個網段的廣播。AP 和控制器不在同一個網段時，廣播到不了，最常用的方法就是在 AP 的 DHCP 位址池加上 option 43。' },
      { t: 'option 43 的格式', d: 'Cisco AP 用 TLV：類型 f1、長度（每台控制器 4 個位元組）、控制器的 IP。控制器是 10.10.10.5 → option 43 hex f104.0a0a.0a05。' },
      { t: 'Local 模式', d: 'AP 預設是 Local 模式：用戶端的流量全部包在 CAPWAP（UDP 5247）裡送回控制器，由控制器放進 WLAN 對應的 VLAN。所以員工 VLAN 不必拉到 AP 的埠，但一定要在控制器接交換器的 Trunk 裡。' },
    ],
    setup: () => {
      const s = makeState([
        ...campus({ wlcAllowed: '10' }),
        D('c9120', 'ap1', { name: 'AP-1F-West', pos: [-6, 1.5] }),
        D('c9120', 'ap2', { name: 'AP-1F-East', pos: [6, 1.5] }),
        D('laptop', 'nb1', { name: '業務的筆電', pos: [-7.5, 5], wifi: CORP }),
        D('laptop', 'nb2', { name: '工程師的筆電', pos: [6.5, 5.5], wifi: CORP }),
      ], [...campusCables, ['ap1:Gi0', 'sw:Gi0/1'], ['ap2:Gi0', 'sw:Gi0/2']]);
      return s;
    },
    objectives: [
      { type: 'check', label: '兩台 AP 都加入了無線控制器', test: (s) => joined(s, ['ap1', 'ap2']) },
      {
        type: 'check', label: 'AP 用 DHCP option 43 找到控制器（控制器仍然在管理 VLAN 10）',
        test(s) {
          const w = dev(s, 'wlc').ifaces[0];
          if (w.bind.vlan !== 10 || w.ip !== '10.10.10.5') return '控制器的管理介面要留在 VLAN 10（10.10.10.5）：把控制器搬到 AP 的網段不是辦法，AP 一多就不可能都在同一個網段';
          const rec = ((s.dyn || {}).capwap || {}).ap1 || {};
          return !rec.joined || ['DHCP option 43', '手動指定的主要控制器'].includes(rec.how) || 'AP 應該用 option 43（或手動指定）找到控制器';
        },
      },
      { type: 'tcp', from: 'nb1', ip: SRV, port: 443, label: '業務的筆電連上 Corp，開得了檔案伺服器' },
      { type: 'tcp', from: 'nb2', ip: SRV, port: 443, label: '工程師的筆電連上 Corp，開得了檔案伺服器' },
      { type: 'check', label: 'RRM 自動把兩台 AP 分在不重疊的頻道', test: (s) => { const j = joined(s, ['ap1', 'ap2']); return j === true ? rrmOk(s) : 'AP 加入控制器之後，RRM 才會開始分配頻道'; } },
    ],
    hints: [
      'AP 在 VLAN 20、控制器在 VLAN 10：AP 的廣播找不到控制器。R1 →「介面」→ Gi0/0/1.20 的 DHCP 位址池，在「WLC 位址 (option 43)」填 10.10.10.5（CLI：ip dhcp pool AP → option 43 hex f104.0a0a.0a05）。AP 拿到新的租約、大約半分鐘後加入。',
      'AP 加入了，筆電也連上 Corp，卻拿不到 IP？Local 模式的流量從控制器出去，控制器接 SW-1F 的 Gi0/10 只允許 VLAN 10，要加上 VLAN 30。',
      '選取控制器可以看「AP」與「用戶端」分頁；CLI 可以用 show ap summary、show wireless client summary。',
    ],
    solve(s) {
      dev(s, 'rt').ifaces.find((i) => i.id === 'Gi0/0/1.20').dhcp.wlc = '10.10.10.5';
      dev(s, 'sw').sw.ports['Gi0/10'].allowed = '10,30';
    },
    recap: ['輕量型 AP 要先找到控制器才會開始服務；不同網段時用 DHCP option 43 告訴它控制器在哪裡。', 'Local 模式的用戶端流量回到控制器才放進 VLAN：員工 VLAN 要在控制器的 Trunk 上，不在 AP 的埠上。'],
  },

  // ════════════════════════ 14-2 ════════════════════════
  {
    id: 'l56', chapter: 14, title: '牆後面收不到', subtitle: '牆面衰減、訊號熱力圖、加一台 AP', tags: ['RF', '牆面衰減', 'RSSI', 'RRM'],
    brief: '會議室在混凝土牆的另一邊，裡面的筆電完全找不到 Corp。總務說「把 AP 的功率開到最大就好」。會議室的天花板上其實已經裝了一台新的 AP，只是還沒接線。視訊會議需要 -67 dBm 以上的訊號，辦公區也不能因此變差。',
    given: [
      ['WLC', '10.10.10.5 · WLAN Corp → VLAN 30（option 43 已經設好）'], ['AP 的 VLAN', '20'],
      ['SW-1F', 'Catalyst 2960-CX-8PC-L：Gi0/1 – Gi0/8 有 PoE；Gi0/9、Gi0/10 沒有'],
      ['訊號需求', '-67 dBm 以上（視訊、語音）'],
    ],
    learn: [
      { t: '牆面衰減', d: '訊號每穿過一道牆就少掉一些：石膏板 3 – 4 dB、玻璃 2 – 3 dB、磚牆 8 – 10 dB、混凝土 12 – 15 dB、電梯與金屬機櫃 25 dB 以上。5 GHz 穿牆比 2.4 GHz 差，所以牆後面常常只剩 2.4 GHz。場景上的顏色就是訊號熱力圖。' },
      { t: '-67 dBm', d: '一般上網 -70 dBm 就夠，但語音與視訊需要 -67 dBm 以上，才有足夠的餘裕應付走動與干擾。這也是企業做無線現場勘測 (site survey) 的常用標準。' },
      { t: '開大功率不是解法', d: '功率開大，牆後面也許勉強收得到，但用戶端回傳的功率沒有變大（上傳一樣到不了），也會干擾更多鄰居。正確的做法是在牆的另一邊再放一台 AP，讓控制器的 RRM 自動錯開頻道。' },
    ],
    setup: () => {
      const s = makeState([
        ...campus({ opt43: '10.10.10.5' }),
        D('c9120', 'ap1', { name: 'AP-Office-1', pos: [-7, 3] }),
        D('c9120', 'ap2', { name: 'AP-Office-2', pos: [-1, 3] }),
        D('c9120', 'ap3', { name: 'AP-會議室', pos: [6, 4] }),
        D('laptop', 'nb1', { name: '辦公區的筆電', pos: [-4, 6], wifi: CORP }),
        D('laptop', 'nb2', { name: '會議室的筆電', pos: [6.5, 6.5], wifi: CORP }),
      ], [...campusCables, ['ap1:Gi0', 'sw:Gi0/1'], ['ap2:Gi0', 'sw:Gi0/2']]);
      s.walls = [
        { id: 'w1', a: [2, 0], b: [2, 9], mat: 'concrete' },
        { id: 'w2', a: [2, 0], b: [10, 0], mat: 'glass' },
        { id: 'w3', a: [10, 0], b: [10, 9], mat: 'brick' },
        { id: 'w4', a: [-10, 0], b: [-5.5, 0], mat: 'drywall' },
      ];
      return s;
    },
    objectives: [
      {
        type: 'check', label: '會議室的筆電連上 Corp，訊號 -67 dBm 以上',
        test(s) {
          const a = dev(s, 'nb2').ifaces.find((i) => i.bind.t === 'wlan').rt.assoc;
          if (!a) return '會議室的筆電找不到 Corp：' + (dev(s, 'nb2').ifaces.find((i) => i.bind.t === 'wlan').rt.note || '收不到訊號');
          return a.rssi >= -67 || `會議室的筆電連在 ${dev(s, a.ap).name}，訊號只有 ${a.rssi} dBm（隔著 ${a.walls.length} 道牆，少了 ${a.wallDb} dB）`;
        },
      },
      {
        type: 'check', label: '辦公區的筆電訊號仍然在 -67 dBm 以上',
        test(s) { const a = dev(s, 'nb1').ifaces.find((i) => i.bind.t === 'wlan').rt.assoc; return (a && a.rssi >= -67) || `辦公區的筆電訊號 ${a ? a.rssi + ' dBm' : '收不到'}`; },
      },
      { type: 'tcp', from: 'nb2', ip: SRV, port: 443, label: '會議室的筆電開得了檔案伺服器' },
      { type: 'check', label: '三台 AP 都加入控制器，頻道由 RRM 錯開', test: (s) => { const j = joined(s, ['ap1', 'ap2', 'ap3']); return j === true ? rrmOk(s) : j; } },
    ],
    hints: [
      '把功率開到最大試試看：會議室勉強收得到 2.4 GHz，但只有 -77 dBm 左右。混凝土牆吃掉十幾 dB，要在會議室這一側放一台 AP。',
      '把「AP-會議室」拉到 SW-1F 有 PoE 的空埠（Gi0/3 – Gi0/7），9120 需要 PoE 才會開機。',
      '接上之後 AP 拿不到 IP？新接的埠預設在 VLAN 1，要改成 Access VLAN 20（AP 的 VLAN，DHCP 位址池帶著 option 43）。加入控制器之後，RRM 會自動錯開頻道。',
    ],
    solve(s) {
      addCable(s, 'ap3', 'Gi0', 'sw', 'Gi0/3');
      Object.assign(dev(s, 'sw').sw.ports['Gi0/3'], { mode: 'access', vlan: 20 });
    },
    recap: ['牆會吃掉訊號，而且 5 GHz 吃得更多；牆後面需要的是另一台 AP，不是更大的功率。', '加入同一台控制器的 AP 由 RRM 自動分頻道與功率；語音、視訊以 -67 dBm 為規劃標準。'],
  },

  // ════════════════════════ 14-3 ════════════════════════
  {
    id: 'l57', chapter: 14, title: '走到另一頭就斷線', subtitle: '漫遊、同一個 VLAN、sticky client 與 802.11k/v', tags: ['漫遊', 'Sticky Client', '802.11k/v', '802.11r'],
    brief: '研發部的兩台基地台是不同時期裝的，SSID 都叫 Corp。工程師拿著筆電從座位走到另一頭的會議室，結果遠端桌面斷線、重連之後 IP 也變了；有時候人都走到會議室了，筆電還死命連著另一頭那台、慢得要命。請讓走過去的筆電換到附近的基地台，而且 IP 不變。',
    given: [
      ['AP-A（座位區）', 'UniFi · SSID Corp → VLAN 31'], ['AP-B（會議室旁）', 'UniFi · SSID Corp → VLAN 32'],
      ['VLAN 31 / 32', '10.31.0.0/24、10.32.0.0/24（R1 各有 DHCP）'], ['伺服器', `${SRV}`],
    ],
    learn: [
      { t: '漫遊 (Roaming)', d: '是用戶端自己決定什麼時候換基地台，不是基地台。換過去之後如果還在同一個 VLAN（同一個網段），IP 不變，進行中的連線不會斷；兩台基地台把 SSID 放進不同的 VLAN，就等於換了網路。' },
      { t: 'Sticky client', d: '很多用戶端在目前的訊號還過得去（大約 -75 dBm）之前，不會主動去找更好的基地台，結果人都走到另一台旁邊了還連著遠的那台。' },
      { t: '802.11k / v / r', d: '802.11k 讓基地台提供鄰近基地台的清單（不用掃描所有頻道）；802.11v 的 BSS Transition 讓基地台建議用戶端換過去；802.11r（Fast Transition）讓用戶端換過去時沿用金鑰，不必重新做完整的驗證，語音不會斷。' },
    ],
    setup: () => {
      const ap = (id, name, pos, vlan, ch24, ch5) => D('ap', id, {
        name, pos,
        init(d) { d.wifi = newWifi([newSsid({ name: 'Corp', sec: 'wpa2', pass: CORP.pass, vlan: String(vlan) })]); d.wifi.ch24 = ch24; d.wifi.ch5 = ch5; },
      });
      const s = makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -8],
          init(d) {
            sub(d, 31, '10.31.0.1', { name: 'WING-A', start: '10.31.0.100', end: '10.31.0.199' });
            sub(d, 32, '10.32.0.1', { name: 'WING-B', start: '10.32.0.100', end: '10.32.0.199' });
            sub(d, 40, '10.10.40.1');
          },
        }),
        D('c2960p', 'sw', {
          name: 'SW-RD', pos: [0, -3.5],
          init(d) {
            d.sw.vlans.push({ id: 31, name: 'WING-A' }, { id: 32, name: 'WING-B' }, { id: 40, name: 'SERVERS' });
            for (const p of ['Gi0/9', 'Gi0/1', 'Gi0/2']) Object.assign(d.sw.ports[p], { mode: 'trunk', allowed: 'all' });
            Object.assign(d.sw.ports['Gi0/8'], { mode: 'access', vlan: 40 });
          },
        }),
        ap('apa', 'AP-A', [-7, 3], 31, 1, 36),
        ap('apb', 'AP-B', [7, 3], 32, 6, 44),
        D('tower', 'srv', { name: '伺服器', pos: [-8, -3.5], ip: SRV, gw: '10.10.40.1', services: [{ proto: 'tcp', port: 3389, name: '遠端桌面' }] }),
        D('laptop', 'nb', { name: '工程師的筆電', pos: [-6, 5.5], wifi: CORP }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['apa:eth0', 'sw:Gi0/1'], ['apb:eth0', 'sw:Gi0/2'], ['srv:eth0', 'sw:Gi0/8']]);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'nb', ip: SRV, port: 3389, label: '在座位上：筆電連得到伺服器的遠端桌面' },
      { type: 'roam', dev: 'nb', to: [1, 4.5], where: '會議室那一側', ap: 'apb', minRssi: -67, label: '走到會議室那一側：筆電改連 AP-B，訊號 -67 dBm 以上' },
      { type: 'roam', dev: 'nb', to: [1, 4.5], where: '會議室那一側', ap: 'apb', keepIp: true, test: { type: 'tcp', from: 'nb', ip: SRV, port: 3389 }, label: '漫遊之後 IP 不變，遠端桌面不斷線' },
      { type: 'check', label: '兩台基地台的頻道錯開', test: (s) => (dev(s, 'apa').rt.interf.length ? `AP-A 和 AP-B 在 ${dev(s, 'apa').rt.interf[0].band} 同頻道` : true) },
    ],
    hints: [
      '先走一趟看看：任務「走到會議室那一側」會說明筆電還連在 AP-A，因為訊號還沒低於 -75 dBm (sticky client)。在兩台基地台的 SSID 打開 802.11k/v。',
      '換到 AP-B 之後 IP 變了：AP-A 把 Corp 放進 VLAN 31、AP-B 放進 VLAN 32。漫遊要在同一個 VLAN 裡才不會斷 — 把 AP-B 的 Corp 也改成 VLAN 31。',
      '也可以順便打開 802.11r，讓換基地台時不用重新做完整的驗證。',
    ],
    solve(s) {
      for (const id of ['apa', 'apb']) Object.assign(dev(s, id).wifi.ssids[0], { kv: true, ft: true, vlan: '31' });
    },
    recap: ['漫遊是用戶端決定的：802.11k/v 讓基地台幫忙「建議」，802.11r 讓換過去的速度夠快。', '同一個 SSID 一定要在同一個 VLAN（或交給控制器集中處理），換基地台才不會換網段。'],
  },
];
