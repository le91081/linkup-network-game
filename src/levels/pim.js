// 第十三章補充：PIM — 多點傳送跨網段要每一台路由器都開 multicast-routing、經過的介面都開 PIM、RP 一致
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const G = '239.1.1.1';
const stream = (s) => ((s.rt && s.rt.mstreams) || []).find((m) => m.group === G);

export const LEVELS65 = [
  {
    id: 'l145', chapter: 13, title: '總部的 IPTV，分公司看不到', subtitle: 'PIM、RPF 與 RP', tags: ['Multicast', 'PIM', 'RPF', 'RP', 'IGMP'],
    brief: `總部的 IPTV 伺服器送出公司頻道（${G}，8 Mbps），總部大廳的電視看得到。分公司的會議室也裝了一台電視收看同一個頻道，卻一直是黑畫面。兩邊的單點傳送都通（ping 得到）。請讓分公司也看得到。`,
    given: [
      ['R-HQ', 'Gi0/0/1 總部 10.1.10.1/24 · Gi0/0/0 專線 10.0.12.1/30 · ip multicast-routing、RP 是 10.1.10.1'],
      ['R-BR', 'Gi0/0/0 專線 10.0.12.2/30 · Gi0/0/1 分公司 10.2.20.1/24'],
      ['IPTV', `10.1.10.20 · ${G}`], ['電視', '總部 10.1.10.30、分公司 10.2.20.30（都加入了 ' + G + '）'],
    ],
    learn: [
      { t: 'PIM', d: '多點傳送要跨網段，路由器之間用 PIM：接收端的閘道 (last-hop router) 收到 IGMP Report，就往來源的方向一站一站送 PIM Join，串流沿著這條路送下來。每一台都要 ip multicast-routing，經過的介面都要 ip pim（介面開了 PIM 也就是那個網段的 IGMP querier）。' },
      { t: 'RPF 檢查', d: '路由器只接受從「往來源的單點傳送路由」那個介面進來的串流（Reverse Path Forwarding），避免迴圈。往來源的路由走的介面沒有 PIM，Join 就送不出去。' },
      { t: 'sparse-mode 與 RP', d: 'sparse-mode 只把串流送給有人要的地方，但一開始要先向 RP (Rendezvous Point) 加入；每一台都要設定同一個 RP（ip pim rp-address）。dense-mode 先泛洪再修剪，不需要 RP，但會先把串流灑到每一個網段。' },
      { t: '怎麼查', d: 'show ip pim neighbor（專線兩端有沒有看到對方）、show ip pim interface、show ip mroute（哪個介面進、哪些介面出）、show ip igmp groups（誰加入了）、show ip pim rp mapping。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'hq', { name: 'R-HQ', pos: [-4, -4], init(d) { Object.assign(d.ifaces[0], { ip: '10.0.12.1', mask: '255.255.255.252' }); Object.assign(d.ifaces[1], { ip: '10.1.10.1', mask: '255.255.255.0' }); } }),
        D('isr4321', 'br', { name: 'R-BR', pos: [5, -4], init(d) { Object.assign(d.ifaces[0], { ip: '10.0.12.2', mask: '255.255.255.252' }); Object.assign(d.ifaces[1], { ip: '10.2.20.1', mask: '255.255.255.0' }); } }),
        D('c2960', 'swhq', { name: 'SW-HQ', pos: [-4, 1] }),
        D('sw8', 'swbr', { name: 'SW-BR', pos: [5, 1] }),
        D('tower', 'iptv', { name: 'IPTV 伺服器', pos: [-9, 0], ip: '10.1.10.20', gw: '10.1.10.1', init(d) { d.mcastSrc = [{ group: G, name: '公司頻道', mbps: 8 }]; } }),
        D('pc', 'tvhq', { name: '總部大廳電視', pos: [-6, 5], ip: '10.1.10.30', gw: '10.1.10.1', init(d) { d.igmp = [G]; } }),
        D('pc', 'tvbr', { name: '分公司會議室電視', pos: [6, 5], ip: '10.2.20.30', gw: '10.2.20.1', init(d) { d.igmp = [G]; } }),
      ], [['hq:Gi0/0/0', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'swhq:Gi0/9'], ['iptv:eth0', 'swhq:Gi0/1'], ['tvhq:eth0', 'swhq:Gi0/2'], ['br:Gi0/0/1', 'swbr:1'], ['tvbr:eth0', 'swbr:2']]);
      recompute(s);
      typeIn(s, 'hq', ['enable', 'configure terminal', 'ip route 10.2.20.0 255.255.255.0 10.0.12.2', 'ip multicast-routing distributed', 'ip pim rp-address 10.1.10.1', 'interface Gi0/0/1', 'ip pim sparse-mode', 'end', 'write memory']);
      typeIn(s, 'br', ['enable', 'configure terminal', 'ip route 10.1.10.0 255.255.255.0 10.0.12.1', 'interface Gi0/0/1', 'ip pim sparse-mode', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'check', label: '總部大廳的電視看得到公司頻道', test: (s) => (stream(s) && stream(s).members.includes('tvhq')) || `總部大廳電視收不到：${(stream(s) && stream(s).why.tvhq) || '沒有串流'}` },
      { type: 'check', label: '分公司會議室的電視看得到公司頻道', test: (s) => (stream(s) && stream(s).members.includes('tvbr')) || `分公司的電視收不到：${(stream(s) && stream(s).why.tvbr) || '沒有串流'}` },
      { type: 'ping', from: 'tvbr', ip: '10.1.10.20', label: '分公司照樣 ping 得到總部的 IPTV 伺服器' },
    ],
    hints: [
      'R-BR 的 CLI：show ip mroute 說沒有 ip multicast-routing；R-HQ：show ip pim neighbor 是空的 — 專線兩端的 Gi0/0/0 都沒有開 PIM。',
      'R-BR：ip multicast-routing distributed、ip pim rp-address 10.1.10.1（和總部同一個 RP），interface Gi0/0/0 → ip pim sparse-mode。',
      'R-HQ：interface Gi0/0/0 → ip pim sparse-mode。之後 R-BR 的 show ip mroute 看得到 (10.1.10.20, 239.1.1.1) 從 Gi0/0/0 進、Gi0/0/1 出。',
    ],
    solve(s) {
      typeIn(s, 'br', ['enable', 'configure terminal', 'ip multicast-routing distributed', 'ip pim rp-address 10.1.10.1', 'interface Gi0/0/0', 'ip pim sparse-mode', 'end', 'write memory']);
      typeIn(s, 'hq', ['enable', 'configure terminal', 'interface Gi0/0/0', 'ip pim sparse-mode', 'end', 'write memory']);
    },
    recap: [
      '多點傳送跨網段靠 PIM：每一台 ip multicast-routing、經過的介面 ip pim，接收端的閘道往來源一站一站加入。',
      'RPF：往來源的單點傳送路由走哪個介面，串流就要從那裡進來；sparse-mode 的每一台都要同一個 RP。',
    ],
  },
];
