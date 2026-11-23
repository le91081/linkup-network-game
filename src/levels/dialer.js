// 第二章補充：公司的 Cisco 路由器自己撥 PPPoE — Dialer 介面、NAT 掛在 Dialer、預設路由指向 Dialer、MSS 1452
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const USER = '81234567@hinet.net', PASS = 'q8w3e7r2';
const dialer = (s) => dev(s, 'rt').ifaces.find((i) => i.bind.t === 'dialer' && i.dialer && i.dialer.negotiated);

export const LEVELS70 = [
  {
    id: 'l150', chapter: 2, title: '換成光世代，路由器要自己撥接', subtitle: 'IOS 的 PPPoE：Dialer 介面', tags: ['PPPoE', 'Dialer', 'NAT', 'MSS', 'Cisco IOS'],
    brief: `公司原本的固定 IP 專線換成了光世代，電信業者說「要用 PPPoE 撥接，帳號 ${USER}、密碼 ${PASS}」，光纖數據機已經接在 R1 的 Gi0/0/0。R1 還是舊專線的設定，現在整間辦公室都上不了網。請用 IOS 的 Dialer 介面完成撥接，讓大家照常上網、開大一點的網頁也不會卡住。`,
    given: [
      ['R1', 'ISR 4321 · Gi0/0/0 → 光纖數據機（目前還是舊專線的固定 IP 203.0.113.10/30）· Gi0/0/1 辦公室 192.168.10.1/24（NAT inside）'],
      ['PPPoE 帳號', `${USER} / ${PASS}（CHAP）`], ['MTU', 'PPPoE 多了 8 個位元組的標頭：Dialer 的 mtu 1492，TCP 的 MSS 調成 1452'],
    ],
    learn: [
      { t: 'IOS 的 PPPoE', d: '實體介面只負責 PPPoE 的 discovery：pppoe enable group global、pppoe-client dial-pool-number 1，本身沒有 IP。IP、NAT、MTU 都設定在 Dialer 介面：ip address negotiated（位址由 ISP 用 IPCP 給）、encapsulation ppp、dialer pool 1（和實體介面的 dial-pool-number 對上）、ppp chap hostname / password。' },
      { t: 'NAT 與路由', d: 'ip nat outside 要改到 Dialer1（實體介面上的要拿掉），ip nat inside source list 1 interface Dialer1 overload；預設路由寫 ip route 0.0.0.0 0.0.0.0 Dialer1（點對點的連線不需要下一站）。' },
      { t: 'MTU 與 MSS', d: 'PPPoE 的標頭佔掉 8 個位元組，Dialer 的 mtu 是 1492。電腦送出 1500 的封包到這裡要分段；很多網站擋掉 ICMP，PMTUD 失效，大一點的網頁就卡住。ip tcp adjust-mss 1452 讓 TCP 一開始就用小一點的區段。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路（光世代）', pos: [0, -8] }), 'line1', { type: 'pppoe', gw: '203.0.113.1', assign: '203.0.113.88', user: USER, pass: PASS }),
        D('isr4321', 'rt', { name: 'R1', pos: [0, -3.5] }),
        D('sw8', 'sw', { name: 'Switch', pos: [0, 0.5] }),
        D('pc', 'pc1', { name: '會計的電腦', pos: [-5, 4], ip: '192.168.10.21', gw: '192.168.10.1', dns: '8.8.8.8' }),
        D('laptop', 'nb', { name: '業務的筆電', pos: [5, 4], ip: '192.168.10.22', gw: '192.168.10.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ['pc1:eth0', 'sw:2'], ['nb:eth0', 'sw:3']]);
      recompute(s);
      // 舊專線的設定：固定 IP、NAT outside 在實體介面、預設路由指向舊的下一站
      typeIn(s, 'rt', ['enable', 'configure terminal', 'interface Gi0/0/0', 'ip address 203.0.113.10 255.255.255.252', 'ip nat outside', 'no shutdown', 'exit',
        'interface Gi0/0/1', 'ip address 192.168.10.1 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
        'access-list 1 permit 192.168.10.0 0.0.0.255', 'ip nat inside source list 1 interface Gi0/0/0 overload', 'ip route 0.0.0.0 0.0.0.0 203.0.113.9', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc1', ip: '8.8.8.8', label: '會計的電腦 ping 得到 8.8.8.8' },
      { type: 'tcp', from: 'nb', name: 'www.example.com', port: 443, label: '業務的筆電打得開 https://www.example.com（大一點的網頁也不卡）' },
      { type: 'check', label: 'R1 用 Dialer 介面撥 PPPoE（ip address negotiated）', test: (s) => !!dialer(s) || 'R1 還沒有 Dialer 介面撥接：interface Dialer1 → ip address negotiated、encapsulation ppp、dialer pool 1、ppp chap …' },
      { type: 'check', label: 'Dialer 的 TCP MSS 調成 1452', test: (s) => { const d = dialer(s); return (d && +d.adjMss && +d.adjMss <= 1452) || 'Dialer1 還沒有 ip tcp adjust-mss 1452'; } },
    ],
    hints: [
      'R1：show ip interface brief，Gi0/0/0 還是舊專線的 203.0.113.10。先 interface Gi0/0/0 → no ip address → no ip nat outside → pppoe enable group global → pppoe-client dial-pool-number 1。',
      `interface Dialer1 → mtu 1492 → ip address negotiated → ip nat outside → encapsulation ppp → dialer pool 1 → ppp chap hostname ${USER} → ppp chap password ${PASS} → ip tcp adjust-mss 1452。`,
      '全域：no ip nat inside source list 1 interface Gi0/0/0 overload → ip nat inside source list 1 interface Dialer1 overload → no ip route 0.0.0.0 0.0.0.0 203.0.113.9 → ip route 0.0.0.0 0.0.0.0 Dialer1。show ip interface brief 看 Dialer1 拿到的位址。',
    ],
    solve(s) {
      typeIn(s, 'rt', ['enable', 'configure terminal', 'interface Gi0/0/0', 'no ip address', 'no ip nat outside', 'pppoe enable group global', 'pppoe-client dial-pool-number 1', 'exit',
        'interface Dialer1', 'mtu 1492', 'ip address negotiated', 'ip nat outside', 'encapsulation ppp', 'dialer pool 1', `ppp chap hostname ${USER}`, `ppp chap password ${PASS}`, 'ip tcp adjust-mss 1452', 'exit',
        'no ip nat inside source list 1 interface Gi0/0/0 overload', 'ip nat inside source list 1 interface Dialer1 overload', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.9', 'ip route 0.0.0.0 0.0.0.0 Dialer1', 'end', 'write memory']);
    },
    recap: [
      'IOS 的 PPPoE：實體介面 pppoe-client dial-pool-number，IP / NAT / MTU 都在 Dialer（ip address negotiated、dialer pool、ppp chap）。',
      'PPPoE 的 MTU 是 1492：Dialer 上 ip tcp adjust-mss 1452，網頁才不會因為 PMTUD 失效而卡住。',
    ],
  },
];
