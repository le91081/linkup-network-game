// 第一章補充：光纖數據機的路由模式造成兩層 NAT — 連接埠轉發收不到外面的連線；數據機改成橋接模式，路由器自己撥 PPPoE
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { dev } from './util.js';

const USER = '87654321@hinet.net', PASS = 'k3m9x2p7', PUB = '203.0.113.45';

export const LEVELS76 = [
  {
    id: 'l156', chapter: 1, title: '連接埠轉發設好了，外面還是連不進來', subtitle: '光纖數據機的路由模式與兩層 NAT', tags: ['NAT', 'Double NAT', '橋接模式', 'PPPoE', '連接埠轉發'],
    brief: `家裡剛換成光世代，電信業者的技術人員裝好光纖數據機，說「接上去就能上網了」。你把自己的 ASUS 路由器接在數據機後面，家裡的電腦都能上網。你在 ASUS 上設好連接埠轉發，想在外面用手機連 NAS（埠 5001），可是怎麼連都連不上。電信業者給的資料：PPPoE 帳號 ${USER}、密碼 ${PASS}，固定的公用 IP ${PUB}。`,
    given: [
      ['光纖數據機', 'ZTE F670L · 出廠是路由模式（自己撥 PPPoE、LAN 發 192.168.1.x）'], ['ASUS 路由器', 'WAN 接數據機的 LAN 1 · 家裡的網段 192.168.50.0/24'],
      ['NAS', '192.168.50.20 · DSM 的 HTTPS 是 5001'], ['連接埠轉發', 'ASUS 上已經設好：TCP 5001 → 192.168.50.20:5001'],
      ['PPPoE', `${USER} / ${PASS} · 公用 IP ${PUB}`],
    ],
    learn: [
      { t: '兩層 NAT (Double NAT)', d: '電信業者的數據機如果是路由模式，它自己撥接、拿公用 IP、做 NAT，後面的 ASUS 拿到的是 192.168.1.x 這種私有位址，再做一次 NAT。上網沒問題，但外面連進來的連線先到數據機：數據機沒有連接埠轉發，直接擋掉，根本到不了 ASUS。' },
      { t: '怎麼看出來', d: '看路由器的 WAN IP：如果是 192.168.x.x、10.x.x.x 或 172.16–31.x.x 這種私有位址，前面一定還有一台做 NAT 的設備。traceroute 8.8.8.8 的前兩站都是私有位址也是一樣的意思。' },
      { t: '解法', d: '最好的做法：數據機改成橋接模式 (Bridge)，只把光纖轉成乙太網路；ASUS 的 WAN 改用 PPPoE 自己撥接，直接拿到公用 IP，只剩一層 NAT。不能改橋接的話，退而求其次：在數據機上把連接埠轉發（或 DMZ）指到 ASUS 的 WAN IP，兩層都要設。' },
      { t: 'CGNAT', d: '有些業者給的根本不是公用 IP（100.64.0.0/10，電信級 NAT），那就怎麼設都連不進來，要跟業者申請公用 IP，或改用 VPN / 反向通道之類的方法。' },
    ],
    setup() {
      return makeState([
        setLine(D('internet', 'inet', { name: '網際網路（光世代）', pos: [0, -8.5] }), 'line1', { type: 'pppoe', gw: '203.0.113.1', assign: PUB, user: USER, pass: PASS }),
        D('ont', 'ont', {
          name: '光纖數據機', pos: [0, -4.5],
          init(d) { Object.assign(d.ifaces.find((i) => i.id === 'wan'), { mode: 'pppoe', user: USER, pass: PASS }); },
        }),
        D('homerouter', 'rt', {
          name: 'ASUS 路由器', pos: [0, -0.5],
          init(d) {
            d.ifaces.find((i) => i.id === 'lan').dhcp = { on: true, start: '192.168.50.100', end: '192.168.50.199', dns: '', gw: '' };
            d.portForwards.push({ proto: 'tcp', port: 5001, toIp: '192.168.50.20', toPort: 5001 });
          },
        }),
        D('nas', 'nas', { name: 'NAS', pos: [4.5, 3.5], ip: '192.168.50.20', gw: '192.168.50.1', dns: '192.168.50.1', services: [{ proto: 'tcp', port: 5001, name: 'DSM (HTTPS)' }, { proto: 'tcp', port: 445, name: 'SMB' }] }),
        D('pc', 'pc', { name: '家裡的電腦', pos: [-4.5, 3.5], dhcp: true }),
      ], [['inet:line1', 'ont:wan'], ['ont:lan1', 'rt:wan'], ['rt:lan1', 'nas:eth0'], ['rt:lan2', 'pc:eth0']]);
    },
    objectives: [
      { type: 'ping', from: 'pc', ip: '8.8.8.8', label: '家裡的電腦照樣上得了網' },
      { type: 'tcp', from: 'inet', ip: PUB, port: 5001, label: `在外面連得到 NAS（${PUB}:5001）` },
      {
        type: 'check', label: '只有一層 NAT：ASUS 的 WAN 直接拿到公用 IP',
        test(s) {
          const w = dev(s, 'rt').ifaces.find((i) => i.id === 'wan');
          if (w.rt.ip == null) return `ASUS 的 WAN 沒有 IP：${w.rt.note || '還沒有連上'}`;
          if (w.rt.ip !== parseIp(PUB)) return `ASUS 的 WAN 是 ${[w.rt.ip >>> 24, (w.rt.ip >>> 16) & 255, (w.rt.ip >>> 8) & 255, w.rt.ip & 255].join('.')}（私有位址）：前面的數據機還在做 NAT`;
          return true;
        },
      },
    ],
    hints: [
      'ASUS →「網際網路 (WAN)」：WAN 的 IP 是 192.168.1.x，是私有位址。前面的光纖數據機也在做 NAT：外面連進來的封包到了數據機就被擋下了，到不了 ASUS 的連接埠轉發。',
      '光纖數據機 →「網際網路 (WAN)」的「運作模式」：打開橋接模式。數據機就不撥接、不做 NAT 了（這時候家裡會暫時上不了網）。',
      `ASUS →「網際網路 (WAN)」：位址取得方式改成 PPPoE 撥接，帳號 ${USER}、密碼 ${PASS}。WAN 會拿到 ${PUB}，連接埠轉發就收得到外面的連線。`,
    ],
    solve(s) {
      dev(s, 'ont').ont.bridge = true;
      Object.assign(dev(s, 'rt').ifaces.find((i) => i.id === 'wan'), { mode: 'pppoe', user: USER, pass: PASS });
    },
    recap: ['光纖數據機是路由模式時，後面的路由器是第二層 NAT：外面連進來會先被數據機擋下。', '數據機改成橋接模式、路由器自己撥 PPPoE 拿公用 IP，只剩一層 NAT，連接埠轉發才有用。'],
  },
];
