// 第十八章：封包實驗室。網路已經是通的，任務不是「把它弄通」，而是「看懂它正在做什麼」：
// 用封包追蹤、ARP 快取、MAC 位址表與封包擷取觀察之後回答觀察題（type: 'ask'，見 engine/ask.js）。
// 答案盡量從目前的網路算出來（MAC、連接埠、廣播到得了誰），不寫死。
import { makeDevice as D, makeState, setLine, peerOf, primaryIface, cloneState } from '../engine/model.js';
import { ifaceMac, l2Explore, recompute, transact } from '../engine/sim.js';
import { iosSession } from '../engine/ios.js';
import { fmtIp, parseIp } from '../engine/ip.js';
import { dev, ifc, addVlan, swp, WEB } from './util.js';

export const CHAPTERS12 = [
  { id: 18, title: '封包實驗室', desc: '網路已經是通的。用封包追蹤、ARP 快取、MAC 位址表觀察，回答它正在做什麼：封裝、交換、廣播、TCP、NAT。' },
];

const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const macOfIf = (s, id, iid) => ifaceMac(dev(s, id), ifc(s, id, iid));
/** 交換器上接著某台設備的那個埠的名稱（接線改了答案也跟著變） */
const swPortLabel = (s, swId, devId) => {
  for (const p of dev(s, swId).ports) { const peer = peerOf(s, swId, p.id); if (peer && peer.dev === devId) return p.label; }
  return '';
};
/** 在副本上送一個封包，回傳請求方向最後一段的訊框（到達目的地時的 MAC 與 TTL） */
function lastFrame(state, from, dst) {
  const c = cloneState(state);
  recompute(c);
  const r = transact(c, from, { proto: 'icmp', dst: parseIp(dst) });
  const fr = r.log.filter((l) => l.frame && !l.frame.reply);
  return r.ok && fr.length ? fr[fr.length - 1].frame : null;
}
const TRACE_TIP = '按「執行測試」讓封包走一次。下方封包追蹤裡，後面標著「封包」的那幾行可以點開，看那一段線路上的 MAC、IP 與 TTL。';

export const LEVELS93 = [
  // ════════════════════════ 18-1 封裝 ════════════════════════
  {
    id: 'l173', chapter: 18, title: '信封換了幾次？', subtitle: '封裝：MAC 位址只管一段路，IP 位址管全程', tags: ['封裝', 'MAC 位址', 'ARP', 'TTL', '預設閘道'], noDrill: true,
    brief: '新人問你：「我 ping 伺服器的時候，封包上寫的到底是誰的位址？」與其解釋半天，不如送一個封包，一站一站打開來看。這個網路已經是通的，請觀察 PC-A 到伺服器的封包，回答下面的問題。',
    given: [
      ['PC-A', '192.168.1.10/24 · 閘道 192.168.1.1'], ['R1', 'Gi0/0/0 192.168.1.1 · Gi0/0/1 10.0.0.1/30'],
      ['R2', 'Gi0/0/0 10.0.0.2/30 · Gi0/0/1 172.16.5.1'], ['伺服器', '172.16.5.80/24 · 閘道 172.16.5.1'],
    ],
    learn: [
      { t: '兩層位址，兩種用途', d: 'IP 位址寫的是「最終要給誰」，從頭到尾不變（沒有 NAT 的話）。MAC 位址寫的是「這一段線路要交給誰」，只在同一個網段裡有意義。' },
      { t: '為什麼目的 MAC 不是伺服器', d: 'PC-A 用自己的遮罩一算，伺服器不在同一個網段：ARP 是廣播，過不了路由器，問不到伺服器的 MAC。所以它改問預設閘道的 MAC，把訊框交給閘道，請它代為轉送。' },
      { t: '路由器：拆開、查表、重新包裝', d: '路由器收到訊框，拆掉乙太網路標頭，看 IP 的目的位址查路由表，決定從哪個介面送出去，再包上新的乙太網路標頭：來源 MAC 是自己送出去的那個介面，目的 MAC 是下一站。' },
      { t: 'TTL', d: 'IP 標頭裡的存活時間，每經過一台路由器減 1，減到 0 就丟掉並回報（tracert 就是靠這個找出路徑）。交換器是第二層設備，不會動 TTL。' },
    ],
    setup: () => makeState([
      D('pc', 'pc-a', { name: 'PC-A', pos: [-11, 3.5], ip: '192.168.1.10', gw: '192.168.1.1' }),
      D('sw8', 'sw1', { name: 'SW-1', pos: [-7, 0] }),
      D('isr4331', 'r1', { name: 'R1', pos: [-2.6, -3.6], init(d) { ip4(d, 'Gi0/0/0', '192.168.1.1'); ip4(d, 'Gi0/0/1', '10.0.0.1', '255.255.255.252'); d.routes.push({ dst: '172.16.5.0', mask: '255.255.255.0', via: '10.0.0.2' }); } }),
      D('isr4331', 'r2', { name: 'R2', pos: [2.6, -3.6], init(d) { ip4(d, 'Gi0/0/0', '10.0.0.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.16.5.1'); d.routes.push({ dst: '192.168.1.0', mask: '255.255.255.0', via: '10.0.0.1' }); } }),
      D('sw8', 'sw2', { name: 'SW-2', pos: [7, 0] }),
      D('tower', 'srv', { name: '伺服器', pos: [11, 3.5], ip: '172.16.5.80', gw: '172.16.5.1', services: WEB }),
    ], [['pc-a:eth0', 'sw1:1'], ['sw1:8', 'r1:Gi0/0/0'], ['r1:Gi0/0/1', 'r2:Gi0/0/0'], ['r2:Gi0/0/1', 'sw2:8'], ['srv:eth0', 'sw2:1']]),
    objectives: [
      { type: 'ping', from: 'pc-a', to: 'srv', label: 'PC-A ping 伺服器（送一個封包來觀察）' },
      {
        type: 'ask', id: 'dmac', label: 'PC-A 送出的訊框，目的 MAC 是誰的？', tip: TRACE_TIP + '也可以在 PC-A 的終端機輸入 arp -a，看它記住了誰的 MAC。',
        q: 'PC-A ping 伺服器（172.16.5.80）。從 PC-A 的網路卡送出去的那個訊框，目的 MAC 位址是哪一台設備的？',
        options: [
          { v: 'srv', t: '伺服器的網路卡', why: '伺服器在另一個網段。ARP 是廣播，過不了路由器，PC-A 問不到伺服器的 MAC，只能把訊框交給預設閘道。' },
          { v: 'r1', t: 'R1 的 Gi0/0/0（PC-A 的預設閘道）' },
          { v: 'sw1', t: 'SW-1 交換器', why: '交換器只是照著 MAC 位址表把訊框轉送出去，訊框不是寫給它的（非網管型交換器連 IP 位址都沒有）。' },
          { v: 'r2', t: 'R2 的 Gi0/0/0', why: 'R2 不在 PC-A 的網段裡，PC-A 連它的存在都不知道。把封包交給 R2 是 R1 的工作。' },
        ],
        answer: 'r1', explain: '目的 IP 是伺服器，目的 MAC 卻是預設閘道：不在同一個網段的對象，一律把訊框交給閘道。',
      },
      {
        type: 'ask', id: 'smac', input: 'mac', label: '封包到達伺服器時，來源 MAC 是什麼？', tip: TRACE_TIP + '到達伺服器的是「R2 → SW-2 → 伺服器」那一段。也可以在伺服器的終端機輸入 arp -a。',
        q: '同一個封包到達伺服器的時候，訊框的來源 MAC 位址是什麼？（填 MAC 位址）',
        answer: (s) => macOfIf(s, 'r2', 'Gi0/0/1'),
        miss: (s, got) => {
          const g = String(got).toLowerCase().replace(/[^0-9a-f]/g, ''), same = (m) => m.replace(/:/g, '') === g;
          if (same(macOfIf(s, 'pc-a', 'eth0'))) return '這是 PC-A 的 MAC，它只出現在第一段（PC-A → R1）。每經過一台路由器，來源 MAC 就換成那台路由器送出去的介面。';
          if (same(macOfIf(s, 'srv', 'eth0'))) return '這是伺服器自己的 MAC，在這個訊框裡它是「目的」。來源是把訊框交給它的那一台。';
          if (same(macOfIf(s, 'r1', 'Gi0/0/0')) || same(macOfIf(s, 'r1', 'Gi0/0/1'))) return '這是 R1 的介面。R1 的 MAC 只出現在它自己接的那兩段線路上，到不了伺服器的網段。';
          if (same(macOfIf(s, 'r2', 'Gi0/0/0'))) return '這是 R2 朝向 R1 的介面 (Gi0/0/0)。送進伺服器網段的是 R2 的另一個介面。';
          return '這不是最後一段的來源 MAC。看封包追蹤裡「R2 → SW-2 → 伺服器」那一行的封包。';
        },
        explain: '到了最後一段，來源 MAC 是 R2 的 Gi0/0/1：伺服器只看得到「把訊框交給我的那台路由器」，看不到 PC-A 的 MAC。',
      },
      {
        type: 'ask', id: 'ipsame', label: '一路上 IP 標頭的位址有沒有變？', tip: TRACE_TIP + '比較每一段的 IPv4 那一列。',
        q: '從 PC-A 到伺服器，經過兩台路由器。IP 標頭裡的來源位址與目的位址有沒有改變？',
        options: [
          { v: 'same', t: '都沒有變：一直是 192.168.1.10 → 172.16.5.80' },
          { v: 'hop', t: '每一站都換成下一站的 IP 位址', why: '每一站都換的是 MAC 位址。IP 位址如果也換掉，伺服器就不知道是誰送的、回應也不知道要回給誰。' },
          { v: 'src', t: '只有來源位址會換成路由器的位址', why: '那是 NAT 做的事（18-5 會看到）。這個網路沒有 NAT，路由器只轉送，不改 IP 位址。' },
          { v: 'dst', t: '只有目的位址會換成閘道的位址', why: '閘道的位址只用來查 ARP、決定「目的 MAC」，從來不會寫進 IP 標頭。' },
        ],
        answer: 'same', explain: 'IP 位址是端到端的：路由器只看它來查路由表，不會改它（NAT 是例外）。會變的只有 MAC 與 TTL。',
      },
      {
        type: 'ask', id: 'ttl', input: 'number', label: '伺服器收到封包時，TTL 是多少？', tip: TRACE_TIP + 'PC-A 的終端機 ping 172.16.5.80 的輸出也有 TTL。',
        q: 'PC-A 送出的封包 TTL 是 64。伺服器收到的時候，TTL 是多少？',
        answer: (s) => { const f = lastFrame(s, 'pc-a', '172.16.5.80'); return f ? f.ttl : 62; },
        miss: '每經過一台「路由器」減 1（交換器不算）。數一數 PC-A 到伺服器中間有幾台路由器。',
        explain: '64 − 2 = 62：路上有 R1、R2 兩台路由器，交換器不會動 TTL。',
      },
    ],
    hints: [
      '按「執行測試」讓 PC-A ping 一次。下方封包追蹤裡，「PC-A → SW-1 → R1」這一行後面有「封包」兩個字，點它可以看到這一段的 MAC、IP 與 TTL；每一段都點開來比一比。',
      '目的 IP 是伺服器，但目的 MAC 是 R1（預設閘道）：不同網段的 MAC 用 ARP 問不到，只能交給閘道。之後每經過一台路由器，來源與目的 MAC 都換成那一段線路兩端的位址，IP 位址不變。',
      '到達伺服器的那一段是「R2 → SW-2 → 伺服器」，來源 MAC 是 R2 的 Gi0/0/1（點開那一行的「封包」照著填）。TTL 從 64 開始，經過 R1、R2 各減 1，到伺服器是 62。',
    ],
    solve(s) { s.answers = { dmac: 'r1', smac: macOfIf(s, 'r2', 'Gi0/0/1'), ipsame: 'same', ttl: '62' }; },
    recap: ['MAC 位址每一段都換：來源是送出去的介面，目的是下一站。IP 位址從頭到尾不變。', '不在同一個網段的目的地，訊框一律先交給預設閘道；TTL 每過一台路由器減 1。'],
  },

  // ════════════════════════ 18-2 交換 ════════════════════════
  {
    id: 'l174', chapter: 18, title: '交換器怎麼知道往哪送？', subtitle: 'MAC 位址表：學習、泛洪，以及找出設備接在哪個埠', tags: ['MAC 位址表', '泛洪', 'Switch', 'ARP', '除錯'], noDrill: true,
    brief: '辦公室重新裝潢之後，線全部收進線槽，沒有人記得哪台設備接在交換器的哪個埠。主管要你找出印表機接在哪一個埠，順便弄清楚交換器到底是怎麼決定把訊框往哪裡送的。',
    given: [['網段', '192.168.10.0/24'], ['PC-A · PC-B', '192.168.10.11 · 192.168.10.12'], ['NAS', '192.168.10.20'], ['印表機', '192.168.10.50'], ['SW-Office', 'Catalyst 2960（接線看不到）']],
    learn: [
      { t: '學習：看來源 MAC', d: '交換器每收到一個訊框，就把「來源 MAC 是從哪個埠進來的」記進 MAC 位址表。沒有送過訊框的設備，交換器不知道它在哪裡。' },
      { t: '轉送：查目的 MAC', d: '表裡查得到目的 MAC，就只從那一個埠送出去。查不到（unknown unicast）或目的是廣播，就送往同一個 VLAN 的其他所有埠，這叫泛洪 (flooding)。' },
      { t: '過期 (aging)', d: '一筆位址 300 秒沒有再看到就會被刪掉，設備搬到別的埠才不會一直送錯地方。show mac address-table 看得到每一筆學到的位址。' },
      { t: '用 MAC 找埠', d: '現場最常用的一招：先用 arp -a 查到設備的 MAC，再到交換器的 MAC 位址表找這個 MAC 在哪個埠。設備要先送過訊框（讓它被 ping 一下）才查得到。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'sw', { name: 'SW-Office', pos: [0, -3.5] }),
        D('pc', 'pc-a', { name: 'PC-A', pos: [-9, 2.5], ip: '192.168.10.11' }),
        D('pc', 'pc-b', { name: 'PC-B', pos: [-3.2, 4.2], ip: '192.168.10.12' }),
        D('nas', 'nas', { name: 'NAS', pos: [3.2, 4.2], ip: '192.168.10.20', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
        D('printer', 'prn', { name: '印表機', pos: [9, 2.5], ip: '192.168.10.50' }),
      ], [['pc-a:eth0', 'sw:Gi0/2'], ['pc-b:eth0', 'sw:Gi0/5'], ['nas:eth0', 'sw:Gi0/8'], ['prn:eth0', 'sw:Gi0/6']]);
      s.hideCables = true;
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc-a', to: 'prn', label: 'PC-A ping 印表機（讓交換器看到它們的訊框）' },
      {
        type: 'ask', id: 'learn', label: '交換器看哪個欄位來「學習」？', tip: '點 SW-Office →「狀態」分頁的 MAC 位址表（或 CLI 的 show mac address-table）。ping 之前和之後各看一次，多了哪些位址？',
        q: '交換器是看訊框的哪一個欄位，把位址記進 MAC 位址表的？',
        options: [
          { v: 'smac', t: '來源 MAC 位址' },
          { v: 'dmac', t: '目的 MAC 位址', why: '目的 MAC 是拿來「查表」決定往哪個埠送的。記進表裡的是來源：訊框從哪個埠進來，這個來源就在那個埠後面。' },
          { v: 'sip', t: '來源 IP 位址', why: '第二層交換器不看 IP 標頭，只看乙太網路標頭裡的 MAC 位址。' },
          { v: 'dip', t: '目的 IP 位址', why: '第二層交換器不看 IP 標頭。看目的 IP 來決定路徑是路由器（第三層）做的事。' },
        ],
        answer: 'smac', explain: '交換器靠來源 MAC 學習、靠目的 MAC 轉送。所以沒有送過訊框的設備，表裡找不到。',
      },
      {
        type: 'ask', id: 'flood', label: '查不到目的 MAC 的訊框會怎麼處理？', tip: '先在 SW-Office 的「狀態」分頁按「清除」把 MAC 位址表清空，再讓 PC-A ping 印表機，看封包追蹤的說明。',
        q: '交換器收到一個單點傳送的訊框，但是 MAC 位址表裡查不到它的目的 MAC（unknown unicast）。交換器會怎麼做？',
        options: [
          { v: 'flood', t: '送往同一個 VLAN 的其他所有埠（泛洪）' },
          { v: 'drop', t: '丟掉，等學到位址再說', why: '如果丟掉，第一個訊框永遠到不了，對方也就沒有機會回覆、讓交換器學到它在哪裡。' },
          { v: 'back', t: '從進來的那個埠送回去', why: '交換器不會把訊框從收到的那個埠再送回去。' },
          { v: 'arp', t: '自己送 ARP 去問那個 MAC 在哪裡', why: 'ARP 是主機用 IP 問 MAC 用的。交換器不發問，查不到就直接泛洪。' },
        ],
        answer: 'flood', explain: '查不到就泛洪：同一個 VLAN 的每一台都會收到一份，不是給自己的就丟掉。對方一回覆，交換器就學到它在哪個埠。',
      },
      {
        type: 'ask', id: 'port', input: 'port', label: '印表機接在 SW-Office 的哪一個埠？', tip: '線看不到，但 MAC 位址表看得到。先從 PC-A ping 192.168.10.50，用 arp -a 查出印表機的 MAC，再到 SW-Office 的 MAC 位址表找這個 MAC 在哪個埠。',
        q: '印表機（192.168.10.50）接在 SW-Office 的哪一個連接埠？（填埠名，例如 Gi0/3）',
        answer: (s) => swPortLabel(s, 'sw', 'prn'),
        miss: (s, got) => {
          const g = String(got).toLowerCase().replace(/\s+/g, ''), hit = ['pc-a', 'pc-b', 'nas'].find((id) => swPortLabel(s, 'sw', id).toLowerCase() === g || swPortLabel(s, 'sw', id).toLowerCase().replace(/^gi/, 'g') === g);
          return hit ? `那個埠後面是 ${dev(s, hit).name}。先用 arp -a 查出 192.168.10.50 的 MAC，再對照 MAC 位址表。` : '在 PC-A 的終端機 ping 192.168.10.50 之後輸入 arp -a，記下印表機的 MAC；再到 SW-Office 的 MAC 位址表找同一個 MAC。';
        },
        explain: '用 IP 查 MAC（arp -a），再用 MAC 查埠（show mac address-table）：沒有標籤的線也找得到。',
      },
      {
        type: 'ask', id: 'aging', label: '設備五分鐘沒有送訊框，MAC 位址表會？', tip: 'MAC 位址表每一筆後面都有「剩幾秒」。用場景上方的時鐘加速，看它倒數到 0。',
        q: '一台設備超過 5 分鐘（300 秒）沒有送出任何訊框。交換器的 MAC 位址表會怎麼樣？',
        options: [
          { v: 'age', t: '把它的那一筆刪掉；下次有訊框要給它，又要泛洪一次' },
          { v: 'keep', t: '一直留著，直到交換器重新開機', why: '那樣的話，設備搬到別的埠之後，訊框會一直被送到舊的埠。動態學到的位址都有期限（預設 300 秒）。' },
          { v: 'shut', t: '把那個埠關掉 (err-disabled)', why: '沒有流量不會讓埠被關掉。err-disabled 是 Port Security、BPDU Guard 這類保護機制觸發時才會發生。' },
          { v: 'move', t: '把它改記到流量最多的埠', why: '交換器不會猜。沒看到就刪掉，下次看到它從哪個埠送訊框再重新學。' },
        ],
        answer: 'age', explain: '動態學到的位址 300 秒沒有更新就過期（aging）。過期之後第一個訊框會泛洪，對方一回覆又學回來。',
      },
    ],
    hints: [
      '點 SW-Office →「狀態」分頁，最上面就是 MAC 位址表。一開始是空的；按「執行測試」讓 PC-A ping 印表機之後再看一次，會多出兩筆（PC-A 與印表機），其他沒送過訊框的設備不在表裡。',
      '在 PC-A 的終端機輸入 arp -a，192.168.10.50 那一行的「實體位址」就是印表機的 MAC。回到 SW-Office 的 MAC 位址表，找同一個 MAC 前面寫的埠名。',
      '印表機在 Gi0/6。交換器靠「來源 MAC」學習；查不到目的 MAC 就泛洪到同一個 VLAN 的其他埠；300 秒沒看到的位址會被刪掉。',
    ],
    solve(s) { s.answers = { learn: 'smac', flood: 'flood', port: swPortLabel(s, 'sw', 'prn'), aging: 'age' }; },
    recap: ['交換器靠來源 MAC 學習、靠目的 MAC 轉送；查不到或是廣播就泛洪。', '找設備接在哪個埠：arp -a 用 IP 查 MAC，MAC 位址表用 MAC 查埠。'],
  },

  // ════════════════════════ 18-3 廣播網域 ════════════════════════
  {
    id: 'l175', chapter: 18, title: '廣播會傳到哪裡？', subtitle: '廣播網域與碰撞網域：Hub、交換器、VLAN、路由器', tags: ['廣播網域', '碰撞網域', 'Hub', 'VLAN', 'ARP'], noDrill: true,
    brief: '同事說「同一台交換器上的設備都收得到廣播」，另一個說「路由器會把廣播轉到另一邊」。兩個都不完全對。這個網路有一台 Hub、一台切了兩個 VLAN 的交換器和一台路由器，請讓 PC-1 送出廣播，看看到底誰收得到。',
    given: [
      ['VLAN 10 辦公室', '192.168.10.0/24 · 閘道 192.168.10.1（R1 Gi0/0/0）'], ['VLAN 20 會計', '192.168.20.0/24 · 閘道 192.168.20.1（R1 Gi0/0/1）'],
      ['Hub', 'PC-1（.10.11）、PC-2（.10.12），上行接 SW 的 Gi0/1'], ['SW', 'Gi0/2 PC-3（.10.13）· Gi0/3 PC-4（.20.14）'],
    ],
    learn: [
      { t: '廣播網域', d: '一個廣播訊框（目的 MAC 是 ff:ff:ff:ff:ff:ff，例如 ARP 請求、DHCP Discover）到得了的範圍。Hub 和交換器都會把廣播送到其他每個埠，所以它們不會把廣播網域切開。' },
      { t: 'VLAN 與路由器才切得開', d: '交換器只把廣播送到同一個 VLAN 的埠；路由器不轉送廣播。所以每一個 VLAN、路由器的每一個介面，各自是一個廣播網域（通常也就是一個 IP 網段）。' },
      { t: '碰撞網域', d: 'Hub 把訊號原封不動複製到所有埠，同一時間只能有一台送（半雙工、CSMA/CD），兩台同時送就碰撞。交換器的每個埠各自是一個碰撞網域，全雙工之下根本不會碰撞。' },
      { t: '為什麼要在意', d: '廣播網域太大，每台設備都要處理別人的 ARP、DHCP 廣播，出了廣播風暴整個網域一起倒。切 VLAN 就是把它切小。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'r1', { name: 'R1', pos: [7, -6.5], init(d) { ip4(d, 'Gi0/0/0', '192.168.10.1'); ip4(d, 'Gi0/0/1', '192.168.20.1'); } }),
        D('c2960', 'sw', { name: 'SW', pos: [1.5, -1.5] }),
        D('hub4', 'hub', { name: 'Hub', pos: [-6.5, 0] }),
        D('pc', 'pc1', { name: 'PC-1', pos: [-11, 4], ip: '192.168.10.11', gw: '192.168.10.1' }),
        D('pc', 'pc2', { name: 'PC-2', pos: [-5.5, 5], ip: '192.168.10.12', gw: '192.168.10.1' }),
        D('pc', 'pc3', { name: 'PC-3', pos: [1.5, 5], ip: '192.168.10.13', gw: '192.168.10.1' }),
        D('pc', 'pc4', { name: 'PC-4', pos: [8.5, 4], ip: '192.168.20.14', gw: '192.168.20.1' }),
      ], [['pc1:eth0', 'hub:1'], ['pc2:eth0', 'hub:2'], ['hub:4', 'sw:Gi0/1'], ['pc3:eth0', 'sw:Gi0/2'], ['pc4:eth0', 'sw:Gi0/3'], ['sw:Gi0/9', 'r1:Gi0/0/0'], ['sw:Gi0/10', 'r1:Gi0/0/1']]);
      addVlan(s, 'sw', 10, '辦公室'); addVlan(s, 'sw', 20, '會計');
      for (const [p, v] of [['Gi0/1', 10], ['Gi0/2', 10], ['Gi0/9', 10], ['Gi0/3', 20], ['Gi0/10', 20]]) Object.assign(swp(s, 'sw', p), { mode: 'access', vlan: v });
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc1', to: 'pc4', label: 'PC-1 ping PC-4（先看一次 ARP 廣播怎麼擴散）' },
      {
        type: 'ask', id: 'bcast', multi: true, label: 'PC-1 的 ARP 廣播，誰會收到？（複選）',
        tip: '在 PC-1 的終端機先輸入 arp -d 清掉快取，再 ping 192.168.20.14：橘色的光點就是 ARP 廣播，看它跑到哪些設備。切到 2D 拓撲圖（T 鍵）看得更清楚，線的顏色就是 VLAN。',
        q: 'PC-1 要 ping PC-4，先送出一個 ARP 廣播問「誰是 192.168.10.1？」。下面哪些會收到這個廣播訊框？（複選）',
        options: [
          { v: 'pc2', t: 'PC-2（和 PC-1 接在同一台 Hub）' },
          { v: 'pc3', t: 'PC-3（接在交換器，VLAN 10）' },
          { v: 'pc4', t: 'PC-4（接在同一台交換器，VLAN 20）', why: 'VLAN 20 是另一個廣播網域：交換器只把 VLAN 10 的廣播送到 VLAN 10 的埠，就算在同一台交換器上也一樣。' },
          { v: 'r1a', t: 'R1 的 Gi0/0/0（VLAN 10 的閘道）' },
          { v: 'r1b', t: 'R1 的 Gi0/0/1（VLAN 20 的閘道）', why: '路由器不轉送廣播：Gi0/0/0 收到之後自己處理（回覆 ARP），不會從 Gi0/0/1 再送出去。' },
        ],
        answer(s) {
          const i = primaryIface(dev(s, 'pc1'));
          const dom = i ? l2Explore(s, 'pc1', i) : [];
          const got = (id, iid) => dom.some((x) => x.dev === id && (!iid || x.iface.id === iid));
          return [['pc2', 'pc2'], ['pc3', 'pc3'], ['pc4', 'pc4'], ['r1a', 'r1', 'Gi0/0/0'], ['r1b', 'r1', 'Gi0/0/1']].filter(([, id, iid]) => got(id, iid)).map(([v]) => v);
        },
        explain: '廣播到得了同一個廣播網域的每一台：Hub 和交換器（同一個 VLAN）都照送，VLAN 的邊界與路由器把它擋下來。',
      },
      {
        type: 'ask', id: 'hub', label: 'PC-1 ping PC-3 時，PC-2 收得到嗎？', tip: '執行「PC-1 ping PC-3」這類測試時，看封包追蹤裡 Hub 那一行的說明，以及 Hub 上多出來的那顆淡淡的光點。',
        q: 'PC-1 ping PC-3，這是單點傳送（目的 MAC 是 PC-3）。接在同一台 Hub 上的 PC-2 會不會也收到這個訊框？',
        options: [
          { v: 'yes', t: '會：Hub 不看位址，把訊號複製到每一個埠；PC-2 的網路卡發現不是給自己的才丟掉' },
          { v: 'no-mac', t: '不會：Hub 會看目的 MAC，只送給 PC-3 那個方向', why: '看 MAC 位址表轉送是交換器的功能。Hub 是第一層設備，只會把電氣訊號複製到其他所有埠。' },
          { v: 'no-arp', t: '不會：PC-2 沒有被 ARP 問到', why: 'ARP 和這件事無關。只要訊號經過 Hub，接在上面的每一台都收得到。' },
          { v: 'vlan', t: '會：因為它們在同一個 VLAN', why: '同一個 VLAN 不代表收得到單點傳送：交換器只把它送到目的 MAC 所在的那個埠。PC-2 收得到，是因為它接的是 Hub。' },
        ],
        answer: 'yes', explain: '接在 Hub 上的設備看得到彼此所有的流量，這也是 Hub 被交換器淘汰的原因之一（另一個是碰撞）。',
      },
      {
        type: 'ask', id: 'domains', input: 'number', label: '這個網路有幾個廣播網域？',
        tip: '切到 2D 拓撲圖（T 鍵）：同一個顏色的線是同一個 VLAN。路由器的每一個介面各接一個網段。',
        q: '這個網路（一台 Hub、一台切了 VLAN 10 與 VLAN 20 的交換器、一台路由器）總共有幾個廣播網域？',
        answer: '2', miss: 'Hub 和交換器不會把廣播網域切開，只有 VLAN 與路由器會。數一數有幾個 VLAN（也就是 R1 接了幾個網段）。',
        explain: '兩個：VLAN 10（Hub 上的兩台、PC-3、R1 的 Gi0/0/0）與 VLAN 20（PC-4、R1 的 Gi0/0/1）。',
      },
      {
        type: 'ask', id: 'collision', label: '哪些設備可能互相碰撞？', tip: '點一下 PC-1 到 Hub 的那條線，看它協商出來的速率與雙工；再點 PC-3 到交換器的線比較。',
        q: '哪些設備會在同一個碰撞網域裡（同時送訊框會撞在一起）？',
        options: [
          { v: 'hub', t: 'PC-1 與 PC-2：接在同一台 Hub 上，只能半雙工' },
          { v: 'sw', t: '接在交換器上的每一台設備', why: '交換器的每個埠各自是一個碰撞網域，而且是全雙工：送和收走不同的線對，根本不會碰撞。' },
          { v: 'vlan', t: '同一個 VLAN 的每一台設備', why: 'VLAN 劃分的是廣播網域，不是碰撞網域。' },
          { v: 'none', t: '現代的乙太網路都不會碰撞', why: '只要還有 Hub（或雙工協商成半雙工），就還是會碰撞。點 PC-1 到 Hub 的線看看它的雙工。' },
        ],
        answer: 'hub', explain: 'Hub 的所有埠是同一個碰撞網域（半雙工、CSMA/CD）；交換器把每個埠隔成各自的碰撞網域。',
      },
    ],
    hints: [
      '在 PC-1 的終端機輸入 arp -d 再 ping 192.168.20.14，橘色的光點（ARP 廣播）會擴散到同一個廣播網域的每一台。按 T 切到 2D 拓撲圖：綠色的線是 VLAN 10，另一個顏色是 VLAN 20。',
      '廣播會經過 Hub、也會經過交換器，但交換器只送到同一個 VLAN 的埠；到了路由器就停下來，不會從另一個介面出去。所以 PC-4 與 R1 的 Gi0/0/1 收不到。',
      '答案：PC-2、PC-3、R1 的 Gi0/0/0 會收到；PC-2 也收得到給 PC-3 的單點傳送（Hub 照抄到每個埠）；廣播網域有 2 個；會碰撞的是接在 Hub 上的 PC-1 與 PC-2。',
    ],
    solve(s) { s.answers = { bcast: ['pc2', 'pc3', 'r1a'], hub: 'yes', domains: '2', collision: 'hub' }; },
    recap: ['Hub 與交換器不切廣播網域；VLAN 與路由器才會。一個廣播網域通常就是一個 IP 網段。', 'Hub 的所有埠是同一個碰撞網域；交換器的每個埠各自一個，全雙工不碰撞。'],
  },

  // ════════════════════════ 18-4 TCP ════════════════════════
  {
    id: 'l176', chapter: 18, title: '敲門的三個步驟', subtitle: 'TCP 三向交握、埠號，以及「被拒絕」和「沒有回應」的差別', tags: ['TCP', '三向交握', '埠號', 'UDP', 'ACL'], noDrill: true,
    brief: '「連不上」有兩種：一種是馬上跳出連線被拒絕，一種是轉圈圈轉很久才逾時。兩種的原因完全不同，分得出來，除錯就快一半。這台伺服器的 443 開著、22 沒有開、3389 在半路被 ACL 擋掉，請用 PC 一個一個連連看。',
    given: [['PC', '10.1.1.10 · DNS 10.2.2.80'], ['伺服器', '10.2.2.80 · www.lab.local'], ['開著的服務', 'HTTPS 443、HTTP 80、DNS 53 (UDP)、遠端桌面 3389'], ['R1 的 ACL', 'NO-RDP：擋掉到 3389 的連線（套在 Gi0/0/0 進方向）']],
    learn: [
      { t: '三向交握', d: 'TCP 傳資料之前要先建立連線：用戶端送 SYN，伺服器回 SYN-ACK，用戶端再回 ACK。三個封包走完，兩邊才開始傳資料。' },
      { t: '埠號：送給哪一個程式', d: 'IP 位址找到主機，埠號找到主機上的程式。伺服器在固定的埠「聽」（HTTPS 443、SSH 22）；用戶端每條連線隨機挑一個來源埠（暫時埠），回應就送回那個埠。' },
      { t: '被拒絕 (refused)', d: 'SYN 到了主機，但那個埠沒有程式在聽：主機馬上回一個 RST。用戶端立刻知道連不上。代表「路是通的，只是服務沒開」。' },
      { t: '沒有回應 (timed out)', d: 'SYN 在半路被防火牆或 ACL 丟掉，或根本沒有路：沒有任何人回應，用戶端重送幾次之後才放棄。代表要去查路徑上的過濾與路由。' },
    ],
    setup() {
      const s = makeState([
        D('pc', 'pc', { name: 'PC', pos: [-10, 3.5], ip: '10.1.1.10', gw: '10.1.1.1', dns: '10.2.2.80' }),
        D('sw8', 'sw1', { name: 'SW-1', pos: [-5.5, 0] }),
        D('isr4331', 'r1', { name: 'R1', pos: [0, -3.6], init(d) { ip4(d, 'Gi0/0/0', '10.1.1.1'); ip4(d, 'Gi0/0/1', '10.2.2.1'); } }),
        D('sw8', 'sw2', { name: 'SW-2', pos: [5.5, 0] }),
        D('tower', 'srv', {
          name: '伺服器', pos: [10, 3.5], ip: '10.2.2.80', gw: '10.2.2.1',
          services: [...WEB, { proto: 'udp', port: 53, name: 'DNS' }, { proto: 'tcp', port: 3389, name: '遠端桌面 (RDP)' }],
          init(d) { d.dnsRecords = { 'www.lab.local': '10.2.2.80' }; },
        }),
      ], [['pc:eth0', 'sw1:1'], ['sw1:8', 'r1:Gi0/0/0'], ['r1:Gi0/0/1', 'sw2:8'], ['srv:eth0', 'sw2:1']]);
      recompute(s);
      typeIn(s, 'r1', ['configure terminal', 'ip access-list extended NO-RDP', 'deny tcp any any eq 3389', 'permit ip any any', 'exit', 'interface Gi0/0/0', 'ip access-group NO-RDP in', 'end', 'write memory']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', name: 'www.lab.local', port: 443, label: 'PC 開啟 https://www.lab.local（看一次完整的連線過程）' },
      {
        type: 'ask', id: 'order', label: '三向交握的三個封包依序是？', tip: TRACE_TIP + '每一段的 L4 那一列寫著旗標。也可以在 PC 的「封包擷取」分頁開始擷取，再到終端機輸入 curl https://www.lab.local。',
        q: 'TCP 建立連線的三向交握，三個封包的旗標依序是什麼？',
        options: [
          { v: 'ok', t: 'SYN → SYN-ACK → ACK' },
          { v: 'a', t: 'SYN → ACK → SYN-ACK', why: '第二個封包是伺服器回的，它要同時「確認收到你的 SYN」和「送出自己的 SYN」，所以是 SYN-ACK。' },
          { v: 'b', t: 'ACK → SYN → SYN-ACK', why: '還沒有任何東西可以確認，第一個封包不會是 ACK。一開始一定是用戶端的 SYN。' },
          { v: 'c', t: 'SYN → SYN → ACK', why: '伺服器回的那一個要帶 ACK，確認它收到了用戶端的 SYN。' },
        ],
        answer: 'ok', explain: '用戶端 SYN、伺服器 SYN-ACK、用戶端 ACK。防火牆的「有狀態」檢查，看的就是這個順序。',
      },
      {
        type: 'ask', id: 'sport', input: 'number', label: '伺服器回的 SYN-ACK，來源埠是多少？', tip: TRACE_TIP + '找「伺服器 → SW-2 → R1」那一段，L4 那一列是「埠 來源 → 埠 目的」。',
        q: 'PC 連到 https://www.lab.local。伺服器回給 PC 的 SYN-ACK，來源埠號是多少？',
        answer: '443',
        miss: (s, got) => (+got >= 1024 ? '那是 PC 這一端隨機挑的來源埠（暫時埠）。SYN-ACK 是伺服器送的，它的來源埠是伺服器在聽的那個埠。' : '伺服器是從它「在聽」的那個埠回覆的。HTTPS 用的是哪一個埠？'),
        explain: '回程的來源埠就是去程的目的埠 443，目的埠則是 PC 當初隨機挑的那個暫時埠：兩邊靠這一組埠號認出同一條連線。',
      },
      {
        type: 'ask', id: 'refused', label: '連 22 埠馬上失敗，伺服器回了什麼？', tip: '在 PC 的終端機輸入 telnet 10.2.2.80 22，看它多快失敗、下面那一行寫了什麼原因。',
        q: '在 PC 上 telnet 10.2.2.80 22，馬上就顯示連線失敗。伺服器對這個 SYN 做了什麼？',
        options: [
          { v: 'rst', t: '回了一個 RST：22 埠沒有程式在聽，直接拒絕' },
          { v: 'none', t: '什麼都沒有回', why: '沒有回應的話，用戶端要重送好幾次、等到逾時才會放棄，不會「馬上」失敗。' },
          { v: 'synack', t: '回了 SYN-ACK，但 PC 不接受', why: '回 SYN-ACK 代表那個埠有程式在聽，連線就會建立起來。' },
          { v: 'acl', t: 'R1 的 ACL 把它擋掉了', why: 'R1 的 ACL 只擋 3389。22 的 SYN 有送到伺服器，是伺服器自己拒絕的。' },
        ],
        answer: 'rst', explain: '「連線被拒絕」反而是好消息：代表封包到得了那台主機，只是那個服務沒有開。',
      },
      {
        type: 'ask', id: 'filtered', label: '連 3389 等很久才逾時，原因是？', tip: '在 PC 的終端機輸入 telnet 10.2.2.80 3389，再看 R1 →「ACL」分頁每一條規則的命中次數（或 CLI 的 show access-lists）。',
        q: '伺服器的 3389 明明開著，但 PC 上 telnet 10.2.2.80 3389 等了很久才逾時。為什麼和 22 埠的反應不一樣？',
        options: [
          { v: 'drop', t: 'SYN 在 R1 就被 ACL 丟掉，沒有任何人回應，PC 只能等到逾時' },
          { v: 'closed', t: '伺服器沒有開 3389', why: '沒有開的話會像 22 埠一樣，伺服器馬上回 RST 拒絕。這裡是完全沒有回應。' },
          { v: 'busy', t: '伺服器太忙，來不及回', why: '443 馬上就連得上，伺服器並不忙。看 R1 的 ACL 命中次數。' },
          { v: 'dns', t: 'DNS 查不到名稱', why: '這裡直接用 IP 位址連，和 DNS 無關。' },
        ],
        answer: 'drop', explain: '逾時代表「沒有人回」：通常是路徑上有設備把它丟掉（ACL、防火牆），或是根本沒有路由。要查的是中間，不是伺服器。',
      },
      {
        type: 'ask', id: 'udp', label: 'DNS 查詢（UDP 53）有三向交握嗎？', tip: '在 PC 的終端機輸入 nslookup www.lab.local，看封包追蹤：紫色的光點是 DNS 查詢與回應。',
        q: 'PC 用 nslookup 向伺服器查 www.lab.local（UDP 53）。這次查詢有沒有先做三向交握？',
        options: [
          { v: 'no', t: '沒有：UDP 直接送出查詢，伺服器直接回答，一來一回兩個封包' },
          { v: 'yes', t: '有：任何連線都要先交握', why: '三向交握是 TCP 的機制。UDP 沒有「連線」，送出去就算了，也不保證送到。' },
          { v: 'half', t: '只有 SYN，沒有 ACK', why: 'UDP 的標頭裡根本沒有 SYN、ACK 這些旗標，只有埠號、長度與檢查碼。' },
          { v: 'tcp', t: 'DNS 一律用 TCP', why: 'DNS 平常用 UDP 53；回應太大或做區域轉送的時候才改用 TCP 53。' },
        ],
        answer: 'no', explain: 'UDP 沒有交握、沒有確認、沒有重送，適合一問一答（DNS、DHCP、NTP）或寧可丟掉也不要等的流量（語音、視訊）。',
      },
    ],
    hints: [
      '按「執行測試」，在封包追蹤裡把每一段的「封包」點開：前三個 TCP 封包的旗標分別是 SYN、SYN-ACK、ACK。伺服器回的那一個，來源埠是 443。',
      '到 PC 的終端機分別輸入 telnet 10.2.2.80 22 與 telnet 10.2.2.80 3389。前者馬上失敗（伺服器回 RST：沒有程式在聽）；後者要等到逾時（SYN 被 R1 的 ACL 丟掉，沒有人回）。',
      '答案：SYN → SYN-ACK → ACK；來源埠 443；22 埠是伺服器回 RST；3389 是 SYN 被 R1 的 ACL 丟掉；DNS 查詢用 UDP，沒有三向交握。',
    ],
    solve(s) { s.answers = { order: 'ok', sport: '443', refused: 'rst', filtered: 'drop', udp: 'no' }; },
    recap: ['TCP 先三向交握（SYN、SYN-ACK、ACK）才傳資料；埠號決定資料交給主機上的哪個程式。', '馬上被拒絕 = 到得了主機、服務沒開（RST）；等到逾時 = 半路被丟掉或沒有路。'],
  },

  // ════════════════════════ 18-5 NAT ════════════════════════
  {
    id: 'l177', chapter: 18, title: '外面看到的你是誰？', subtitle: 'NAT：私有位址、轉換表，以及為什麼外面連不進來', tags: ['NAT', 'PAT', '私有位址', '轉換表', '家用路由器'], noDrill: true,
    brief: '家裡兩台電腦都用 192.168.50.x 上網，可是網際網路上根本沒有 192.168.50.x 這個網段。那對方的回應是怎麼找到路回來的？這個網路已經可以上網，請觀察封包經過路由器前後的變化。',
    given: [['桌機', '192.168.50.100'], ['筆電', '192.168.50.101'], ['路由器', 'LAN 192.168.50.1 · WAN 203.0.113.25（電信業者配發）'], ['外面的主機', '8.8.8.8、www.example.com']],
    learn: [
      { t: '私有位址', d: '10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 保留給內部使用，每個家庭和公司都可以重複用。網際網路上的路由器沒有這些網段的路由，回應送不回來。' },
      { t: 'NAT：出門換名字', d: '封包從 LAN 走到 WAN 的時候，路由器把來源位址換成自己的公用 IP，並且在轉換表記下一筆。外面的主機只看得到路由器的位址。' },
      { t: 'PAT：靠埠號分辨是誰', d: '好幾台電腦共用一個公用 IP，路由器用「來源埠」分辨：每條連線記著「內部位址:埠 ↔ 對外的埠」。回應回來時查表，換回原本的內部位址再送進去。' },
      { t: '為什麼外面連不進來', d: '轉換表的項目是「裡面先連出去」才建立的。外面主動連進來的封包查不到對應的項目，路由器不知道要交給誰，只好丟掉。要讓外面連進來，得另外設定連接埠轉發。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -7] }), 'line1', { type: 'pppoe', gw: '203.0.113.1', assign: '203.0.113.25', user: '74123456@hinet.net', pass: 'k7m2x9pw' }),
      D('homerouter', 'rt', {
        name: '路由器', pos: [0, -2],
        init(d) {
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' });
          Object.assign(d.ifaces.find((i) => i.id === 'wan'), { mode: 'pppoe', user: '74123456@hinet.net', pass: 'k7m2x9pw' });
        },
      }),
      D('pc', 'pc-1', { name: '桌機', pos: [-4.5, 2.6], ip: '192.168.50.100', gw: '192.168.50.1', dns: '8.8.8.8' }),
      D('laptop', 'nb', { name: '筆電', pos: [4.5, 2.6], ip: '192.168.50.101', gw: '192.168.50.1', dns: '8.8.8.8' }),
    ], [['pc-1:eth0', 'rt:lan1'], ['nb:eth0', 'rt:lan2'], ['rt:wan', 'inet:line1']]),
    objectives: [
      { type: 'ping', from: 'pc-1', ip: '8.8.8.8', label: '桌機 ping 8.8.8.8（看封包經過路由器前後的變化）' },
      {
        type: 'ask', id: 'seen', input: 'ip', label: '8.8.8.8 看到的來源 IP 是什麼？', tip: TRACE_TIP + '比較「桌機 → 路由器」和「路由器 → 網際網路」這兩段的 IPv4 那一列。',
        q: '桌機（192.168.50.100）ping 8.8.8.8。8.8.8.8 收到這個封包的時候，看到的來源 IP 位址是什麼？',
        answer: (s) => { const w = ifc(s, 'rt', 'wan'); return w && w.rt && w.rt.ip != null ? fmtIp(w.rt.ip) : '203.0.113.25'; },
        miss: (s, got) => (/^192\.168\./.test(String(got).trim()) ? '那是桌機的私有位址，出了路由器之後就被換掉了。看「路由器 → 網際網路」那一段的來源位址。' : '看封包追蹤裡路由器把封包送往網際網路的那一段：來源位址已經換成路由器 WAN 介面的公用 IP。'),
        explain: '出門的時候，來源位址被換成路由器 WAN 的公用 IP：外面的主機從頭到尾不知道 192.168.50.100 的存在。',
      },
      {
        type: 'ask', id: 'private', label: '192.168.50.100 為什麼不能直接出現在網際網路上？',
        q: '如果路由器不做 NAT，直接把來源是 192.168.50.100 的封包送出去，會發生什麼事？',
        options: [
          { v: 'noroute', t: '封包也許送得到，但回應回不來：網際網路上沒有通往私有位址的路由' },
          { v: 'dhcp', t: '不行，因為這個位址是 DHCP 發的', why: '位址是怎麼拿到的（DHCP 或手動）和能不能上網無關。重點是它屬於私有位址的範圍。' },
          { v: 'mask', t: '不行，因為遮罩是 /24', why: '遮罩只決定「哪些位址算同一個網段」，和位址是公用還是私有無關。' },
          { v: 'ok', t: '沒有差別，一樣可以上網', why: '全世界有無數個 192.168.50.100。回應要送給哪一個？電信業者的路由器會直接丟掉目的是私有位址的封包。' },
        ],
        answer: 'noroute', explain: '私有位址（RFC 1918）在每個內部網路都重複使用，網際網路上不會有它的路由，所以一定要換成公用位址才收得到回應。',
      },
      {
        type: 'ask', id: 'pat', label: '兩台電腦共用一個公用 IP，回應怎麼知道給誰？', tip: '讓桌機和筆電都連一次外面（執行全部測試、或各自在終端機 curl https://www.example.com），再點路由器 →「狀態」分頁看「連線表（NAT 轉換）」。',
        q: '桌機和筆電同時連到同一個網站，對方看到的來源 IP 都是 203.0.113.25。回應回來的時候，路由器怎麼知道要交給哪一台？',
        options: [
          { v: 'port', t: '查 NAT 轉換表：每條連線記著「內部位址:埠 ↔ 對外的埠」，用埠號分辨' },
          { v: 'mac', t: '看回應的目的 MAC 位址', why: '從外面回來的訊框，目的 MAC 是路由器的 WAN 介面。內部電腦的 MAC 出不了自己的網段。' },
          { v: 'rr', t: '輪流交給每一台', why: '那樣的話每一台都會收到別人的資料。路由器是照轉換表一筆一筆對回去的。' },
          { v: 'bc', t: '廣播給內部所有的電腦，是誰的誰收下', why: '路由器不會這樣做：查不到對應項目的封包會直接丟掉。' },
        ],
        answer: 'port', explain: '這就是 PAT（NAT overload）：一個公用 IP 加上不同的埠號，可以同時服務幾萬條連線。',
      },
      {
        type: 'ask', id: 'inbound', label: '外面主動連進來會怎麼樣？',
        q: '網際網路上的某台電腦主動連到 203.0.113.25 的 TCP 3389，想連家裡的桌機。路由器沒有設定連接埠轉發，結果是？',
        options: [
          { v: 'drop', t: '被路由器丟掉：轉換表裡沒有對應的項目，它不知道要交給內部哪一台' },
          { v: 'pc', t: '交給最近一次上網的那台電腦', why: '轉換表的每一筆只對應「那一條」連出去的連線（位址與埠號都要對得上），不會拿來接別的連線。' },
          { v: 'all', t: '轉給內部所有的電腦', why: '路由器不會把查不到項目的封包轉給任何人。' },
          { v: 'gw', t: '交給 192.168.50.1', why: '192.168.50.1 是路由器自己的 LAN 位址，而且私有位址不會出現在外面來的封包裡。' },
        ],
        answer: 'drop', explain: '這也是 NAT 順便帶來的保護：外面沒辦法主動連進來。要對外提供服務，得設定連接埠轉發（1-5、2-1 做過）。',
      },
    ],
    hints: [
      '按「執行測試」，在封包追蹤裡點開「桌機 → 路由器」和「路由器 → 網際網路」這兩段的「封包」：IPv4 那一列的來源位址，前一段是 192.168.50.100，後一段變成 203.0.113.25。',
      '外面只看得到路由器的公用 IP。兩台電腦共用同一個 IP，靠的是埠號：路由器 →「狀態」分頁的「連線表（NAT 轉換）」，每條連線一筆。',
      '答案：203.0.113.25；私有位址在網際網路上沒有路由，回應回不來；用 NAT 轉換表裡的埠號分辨；外面主動連進來的封包查不到項目，被丟掉。',
    ],
    solve(s) { s.answers = { seen: '203.0.113.25', private: 'noroute', pat: 'port', inbound: 'drop' }; },
    recap: ['NAT 在出門時把私有位址換成公用位址，並在轉換表記下一筆；回應靠這一筆換回來。', '轉換表要「裡面先連出去」才有項目，所以外面主動連不進來，除非設定連接埠轉發。'],
  },
];
