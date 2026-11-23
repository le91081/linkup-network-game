// 第十四章補充：漫遊的時間（WPA2-Enterprise 每換一台都要重做 802.1X；802.11k 縮短掃描、802.11r 沿用金鑰）
import { makeDevice as D, makeState, newSsid } from '../engine/model.js';
import { dev } from './util.js';

const KEY = 'Radius#Key2026';
const APS = ['apa', 'apb'];

export const LEVELS60 = [
  {
    id: 'l140', chapter: 14, title: '一走進會議室，Teams 就斷一下', subtitle: '漫遊時間、802.1X、802.11k/v 與 802.11r', tags: ['漫遊', '802.11r', '802.11k/v', 'WPA2-Enterprise', '語音'],
    brief: '公司的 Wi-Fi「Corp」用 WPA2-Enterprise（每個人用自己的帳號，RADIUS 驗證），兩台基地台都設好了、也在同一個網段。可是大家邊講 Teams 邊從座位走進會議室，聲音都會斷一下、甚至整通掉線。有人建議改回共用密碼「比較快」— 請不要這樣做，讓漫遊快到通話不會斷，帳號驗證也要保留。',
    given: [
      ['RADIUS 伺服器', `192.168.10.5 · 共用密鑰 ${KEY}`], ['Corp', 'WPA2-Enterprise · AP-A（座位區）與 AP-B（會議室）'],
      ['員工筆電', 'bob 的帳號，邊走邊開 Teams'], ['語音', '換基地台的中斷要在 100 ms 以內'],
    ],
    learn: [
      { t: '漫遊花的時間', d: '用戶端換基地台要：找到新的基地台（掃描頻道）、重新關聯、重新建立加密金鑰。WPA2-Personal 只要四向交握（幾十毫秒）；WPA2-Enterprise 每換一台都要重做整個 802.1X（EAP 跟 RADIUS 來回好幾趟），常常要四、五百毫秒，通話一定斷。' },
      { t: '802.11k / v', d: '802.11k：基地台提供鄰近基地台的清單，用戶端只要掃清單上的幾個頻道，不必逐一掃描。802.11v：基地台建議用戶端換到更好的那台，用戶端不會死守著越來越弱的訊號 (sticky client)。' },
      { t: '802.11r (Fast Transition)', d: '第一次登入時建立的金鑰會分給同一個行動網域裡的基地台，漫遊時在重新關聯的封包裡一起帶過去，不必重做 802.1X 與四向交握。兩台基地台都要開。很舊的用戶端不支援，可以用混合模式 (adaptive)。' },
      { t: '建議值', d: '語音通話希望漫遊的中斷在 50 – 150 ms 以內。改回共用密碼雖然快，但離職員工也還連得上，治標不治本。' },
    ],
    setup: () => makeState([
      D('erx', 'rt', {
        name: 'Router', pos: [-8, -6],
        init(d) {
          Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
          Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.10.100', end: '192.168.10.199', dns: '8.8.8.8' });
        },
      }),
      D('c2960p', 'sw', { name: 'Switch', pos: [0, -5], init(d) { Object.assign(d.ifaces[0], { ip: '192.168.10.2', mask: '255.255.255.0' }); } }),
      D('tower', 'aaa', { name: 'RADIUS 伺服器', pos: [8, -6], ip: '192.168.10.5', init(d) { d.radiusServer = { secret: KEY, users: [{ user: 'bob', pass: 'Bob#2026' }, { user: 'alice', pass: 'Alice#2026' }] }; } }),
      ...[['apa', 'AP-A（座位區）', [-7, 1.5], 1, 36], ['apb', 'AP-B（會議室）', [7, 1.5], 11, 149]].map(([id, name, pos, c24, c5]) => D('ap', id, {
        name, pos,
        init(d) { d.wifi.ssids = [newSsid({ name: 'Corp', sec: 'wpa2ent' })]; d.wifi.ch24 = c24; d.wifi.ch5 = c5; d.radius = { ip: '192.168.10.5', secret: KEY }; },
      })),
      D('laptop', 'nb', { name: 'Bob 的筆電', pos: [-6, 5], wifi: { ssid: 'Corp', user: 'bob', pass: 'Bob#2026' } }),
    ], [['rt:eth1', 'sw:Gi0/10'], ['aaa:eth0', 'sw:Gi0/3'], ['apa:eth0', 'sw:Gi0/1'], ['apb:eth0', 'sw:Gi0/2']]),
    objectives: [
      { type: 'ping', from: 'nb', ip: '192.168.10.1', label: '在座位上：筆電用 bob 的帳號連上 Corp' },
      { type: 'roam', dev: 'nb', to: [6, 5], where: '會議室', ap: 'apb', label: '走進會議室：筆電換到 AP-B' },
      { type: 'roam', dev: 'nb', to: [6, 5], where: '會議室', ap: 'apb', maxRoamMs: 100, test: { type: 'ping', from: 'nb', ip: '192.168.10.1' }, label: '換基地台的中斷在 100 ms 以內，通話不斷' },
      {
        type: 'check', label: 'Corp 還是 WPA2-Enterprise（不改回共用密碼）',
        test(s) { const bad = APS.filter((id) => dev(s, id).wifi.ssids.some((x) => x.name === 'Corp' && x.sec !== 'wpa2ent')); return !bad.length || `${bad.map((id) => dev(s, id).name).join('、')} 的 Corp 不是 WPA2-Enterprise 了：每個人用自己的帳號才追得到是誰、停用帳號才有用`; },
      },
    ],
    hints: [
      '先走一趟：任務「換基地台的中斷在 100 ms 以內」會列出每一段花了多久 — 逐一掃描頻道 120 ms、完整的 802.1X 420 ms。筆電的「無線網路」分頁也看得到最近一次漫遊。',
      '兩台基地台的 Corp 都打開 802.11k/v：用戶端只要掃鄰近清單上的頻道（20 ms），也會被建議及時換過去。',
      '兩台都打開 802.11r（Fast Transition）：金鑰在重新關聯時一起帶過去，不用重做 802.1X，合計大約 30 ms。',
    ],
    solve(s) {
      for (const id of APS) Object.assign(dev(s, id).wifi.ssids[0], { kv: true, ft: true });
    },
    recap: [
      'WPA2-Enterprise 每次漫遊都重做 802.1X，動輒數百毫秒；802.11r 讓金鑰在重新關聯時一起帶過去。',
      '802.11k 的鄰近清單縮短掃描、802.11v 讓用戶端及時換過去，三個一起開，語音才走得動。',
    ],
  },
];
