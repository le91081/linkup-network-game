// 第十章補充：多點傳送泛洪 — IGMP snooping 要有 querier 才會修剪
import { makeDevice as D, makeState } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const CH = [['239.1.1.1', '新聞台'], ['239.1.1.2', '財經台'], ['239.1.1.3', '公司宣傳']];
const mgmt = (d, ip) => Object.assign(d.ifaces.find((x) => x.id === 'mgmt'), { ip, mask: '255.255.255.0' });

export const LEVELS64 = [
  {
    id: 'l144', chapter: 10, title: '大廳的電視一開，倉庫就傳不動檔案', subtitle: '多點傳送、IGMP snooping 與 querier', tags: ['Multicast', 'IGMP', 'IGMP snooping', 'querier', 'IPTV'],
    brief: '總務在大廳裝了 IPTV：一台串流伺服器送出三個頻道（多點傳送，每台 30 Mbps），大廳的電視只收看其中一台。從那天起，倉庫的電腦傳檔案到檔案伺服器就慢得要命 — 倉庫和大廳之間只有一條 100 Mbps 的舊線路。交換器的 IGMP snooping 明明是開著的。請找出原因：電視照樣能看，倉庫的傳檔要回到 80 Mbps 以上。',
    given: [
      ['SW-Lobby', 'Catalyst 2960 · 管理位址 10.0.0.2 · Gi0/1 串流伺服器、Gi0/2 大廳電視、Gi0/3 檔案伺服器、Gi0/10 → 倉庫（100 Mbps）'],
      ['SW-WH', 'Catalyst 2960 · 管理位址 10.0.0.3 · 倉庫的電腦'],
      ['IPTV', '239.1.1.1 新聞台、239.1.1.2 財經台、239.1.1.3 公司宣傳，各 30 Mbps'], ['網段', '10.0.0.0/24，沒有路由器'],
    ],
    learn: [
      { t: '多點傳送 (multicast)', d: '一份資料同時送給很多台：目的位址是 224.0.0.0/4 的群組，想收的電腦用 IGMP 加入（Membership Report）。交換器預設把多點傳送當成廣播，送往整個 VLAN 的每一個埠；它又是固定速率的 UDP，不會因為塞車而讓路。' },
      { t: 'IGMP snooping', d: '交換器偷聽 IGMP 的 Report，記下哪個埠有人加入哪個群組，之後只送往那些埠。Catalyst 出廠就開著。' },
      { t: 'IGMP querier', d: '電腦只在剛加入時送 Report，之後要有人定期問（IGMP Query）才會再回報。網段上通常是路由器（跑 PIM）在問；沒有路由器的網段，snooping 學到的表項大約 260 秒後過期，多點傳送又變成泛洪。讓一台交換器擔任 querier：ip igmp snooping querier（它在那個 VLAN 要有 IP）。' },
      { t: '怎麼查', d: '流量熱圖看得到哪幾段被串流佔掉；show ip igmp snooping 看 Querier 是不是 none、show ip igmp snooping groups 看表是不是空的；電視的「多點傳送」分頁看收不收得到。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'lobby', { name: 'SW-Lobby', pos: [-3, -3], init(d) { mgmt(d, '10.0.0.2'); Object.assign(d.sw.ports['Gi0/10'], { speed: '100', duplex: 'full' }); } }),
        D('c2960', 'wh', { name: 'SW-WH', pos: [6, -3], init(d) { mgmt(d, '10.0.0.3'); Object.assign(d.sw.ports['Gi0/10'], { speed: '100', duplex: 'full' }); } }),
        D('tower', 'iptv', { name: 'IPTV 串流伺服器', pos: [-8, -6], ip: '10.0.0.20', init(d) { d.mcastSrc = CH.map(([group, name]) => ({ group, name, mbps: 30 })); } }),
        D('pc', 'tv', { name: '大廳電視（機上盒）', pos: [-8, 1.5], ip: '10.0.0.30', init(d) { d.igmp = ['239.1.1.1']; } }),
        D('tower', 'fs', { name: '檔案伺服器', pos: [-3, 2.5], ip: '10.0.0.10', services: [{ proto: 'tcp', port: 445, name: 'SMB' }, { proto: 'tcp', port: 5201, name: 'iperf3' }] }),
        D('pc', 'wpc', { name: '倉庫的電腦', pos: [8, 1.5], ip: '10.0.0.51' }),
      ], [['iptv:eth0', 'lobby:Gi0/1'], ['tv:eth0', 'lobby:Gi0/2'], ['fs:eth0', 'lobby:Gi0/3'], ['lobby:Gi0/10', 'wh:Gi0/10'], ['wpc:eth0', 'wh:Gi0/1']]);
      recompute(s);
      return s;
    },
    objectives: [
      {
        type: 'check', label: '大廳電視收得到新聞台 (239.1.1.1)',
        test(s) { const x = ((s.rt && s.rt.mstreams) || []).find((m) => m.group === '239.1.1.1'); return (x && x.members.includes('tv')) || '大廳電視收不到 239.1.1.1 的串流'; },
      },
      { type: 'speed', from: 'wpc', to: 'fs', port: 5201, bulk: 'down', min: 80, label: '倉庫的電腦從檔案伺服器下載有 80 Mbps 以上' },
      {
        type: 'check', label: '沒有人收看的頻道不再送到倉庫',
        test(s) {
          const w = ((s.rt && s.rt.mstreams) || []).filter((m) => m.extra.includes('wpc'));
          return !w.length || `倉庫的電腦還在收 ${w.map((m) => `${m.name} (${m.group})`).join('、')}：它沒有加入，但串流照樣被送過 100 Mbps 的線路`;
        },
      },
    ],
    hints: [
      '打開 2D 拓撲圖的「流量熱圖」：SW-Lobby → SW-WH 那一段被塞滿了。倉庫的電腦沒有看電視，為什麼會收到 IPTV 的串流？',
      'SW-Lobby 的 CLI：show ip igmp snooping，IGMP snooping 是 Enabled，但 Querier 是 none；show ip igmp snooping groups 是空的 — 沒有人定期問，表項過期了，串流又變成泛洪。',
      'SW-Lobby：configure terminal → ip igmp snooping querier（它在 VLAN 1 有管理位址 10.0.0.2）。之後只有大廳電視的埠收得到新聞台，另外兩台沒人看的頻道也不再往外送。',
    ],
    solve(s) {
      ((dev(s, 'lobby').sw.igmp ||= {})).querier = true;
    },
    recap: [
      '多點傳送沒有 IGMP snooping 修剪，就像固定速率的廣播：整個 VLAN 的每一段線路都被它佔掉。',
      'snooping 要有 querier 定期詢問才會一直有效：沒有路由器的網段，讓交換器擔任 querier。',
    ],
  },
];
