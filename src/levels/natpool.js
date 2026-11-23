// 第三章補充：NAT 位址池（沒有 overload，早到的人把公用位址借光了）
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute, transact } from '../engine/sim.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const PCS = ['pc1', 'pc2', 'pc3', 'pc4', 'pc5', 'pc6'];

export const LEVELS51 = [
  {
    id: 'l131', chapter: 3, title: '十點以後進公司的人都上不了網', subtitle: 'NAT 位址池與 overload', tags: ['NAT', 'NAT pool', 'PAT', 'overload', '公用 IP'],
    brief: '公司向 ISP 租了 203.0.113.8/29 這一段公用 IP。前任網管把 .11 – .14 四個位址設成 NAT 位址池，說這樣「每個人都有自己的公用 IP，出事比較好查」。結果每天早上最先到的四個人上網都正常，之後進公司的人怎麼樣都打不開網頁，要等到隔天才會好。請讓全部的同事都能同時上網，對外的網段不要動。',
    given: [
      ['ISP 配發區段', '203.0.113.8/29 · 閘道 .9 · Edge-RT 的 WAN .10'], ['NAT 位址池 PUB', '203.0.113.11 – 203.0.113.14（4 個位址）'],
      ['內部', '10.10.0.0/24 · 6 台電腦（DHCP）'], ['ACL 10', 'permit 10.10.0.0 0.0.0.255'], ['現在', '早上 10 點：PC-1 – PC-4 已經上過網'],
    ],
    learn: [
      { t: '動態 NAT（位址池）', d: 'ip nat pool 定義一段公用位址，ip nat inside source list <ACL> pool <名稱>：符合 ACL 的內部位址從位址池裡借一個公用位址來用。沒有 overload 是一對一：一台主機佔一個公用位址，借到的位址要閒置 24 小時（ip nat translation timeout）才還回去。' },
      { t: '位址池用完', d: '位址都借光以後，下一台主機轉換不了，封包直接被丟掉。show ip nat statistics 看得到 allocated 100% 與 misses（轉換失敗的次數）；show ip nat translations 列出每一個借出去的位址。clear ip nat translation * 只能暫時清出空位，很快又會被佔光。' },
      { t: 'overload（PAT）', d: '後面加上 overload 就變成多對一：大家共用位址池的位址，用來源埠號區分連線，一個公用位址可以同時撐幾萬條連線。只有一個公用 IP 時，直接 ip nat inside source list 10 interface <對外介面> overload。' },
      { t: '改規則之前要先清', d: '位址池還有轉換在用的時候，IOS 不讓你改或刪那條規則（%Dynamic mapping in use），要先 clear ip nat translation *。' },
      { t: '誰回應 ARP', d: '位址池的位址和 WAN 在同一個網段，ISP 會用 ARP 找它們，路由器要替它們回應（IOS 自動做）。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -8.5] }), 'line1', { type: 'static', gw: '203.0.113.9', mask: '255.255.255.248', assign: '203.0.113.10' }),
        D('isr4331', 'rt', {
          name: 'Edge-RT', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.248', gateway: '203.0.113.9' });
            Object.assign(d.ifaces[1], { ip: '10.10.0.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces[1].dhcp, { on: true, start: '10.10.0.101', end: '10.10.0.150', dns: '8.8.8.8' });
          },
        }),
        D('sw8', 'sw', { name: 'Office-SW', pos: [0, 0.5] }),
        ...PCS.map((id, k) => D('pc', id, { name: `PC-${k + 1}`, pos: [-8.75 + k * 3.5, 5 + (k % 2) * 1.2], dhcp: true })),
      ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ...PCS.map((id, k) => [`${id}:eth0`, `sw:${k + 2}`])]);
      recompute(s);
      typeIn(s, 'rt', ['configure terminal', 'access-list 10 permit 10.10.0.0 0.0.0.255', 'ip nat pool PUB 203.0.113.11 203.0.113.14 netmask 255.255.255.248',
        'ip nat inside source list 10 pool PUB', 'interface Gi0/0/0', 'ip nat outside', 'interface Gi0/0/1', 'ip nat inside', 'end', 'write memory']);
      recompute(s);
      // 早上：先到的四個人上過網，位址池的四個位址都借出去了
      for (const id of PCS.slice(0, 4)) transact(s, id, { proto: 'icmp', dst: parseIp('8.8.8.8') });
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc5', name: 'www.example.com', port: 443, label: '十點才進公司的 PC-5 打得開網站' },
      { type: 'tcp', from: 'pc6', name: 'www.example.com', port: 443, label: 'PC-6 也打得開網站' },
      {
        type: 'check', label: '明天早上六個人陸續上網，每個人都轉換得了（不是靠清掉轉換表撐過今天）',
        test(s) {
          const rt = dev(s, 'rt'), wan = rt.ifaces.find((i) => i.id === 'Gi0/0/0');
          if (wan.ip !== '203.0.113.10' || wan.mask !== '255.255.255.248') return 'Edge-RT 的 WAN 被改掉了：對外的網段要維持 203.0.113.10/29';
          const t = cloneState(s);
          if (t.dyn && t.dyn.natPool) delete t.dyn.natPool.rt; // 隔天早上：前一天借出去的位址都還回來了
          recompute(t);
          for (const id of PCS) {
            const r = transact(t, id, { proto: 'icmp', dst: parseIp('8.8.8.8') });
            if (!r.ok) return `${dev(s, id).name} 上不了網：${r.reason}`;
          }
          return true;
        },
      },
    ],
    hints: [
      'Edge-RT 的 CLI：show ip nat statistics 最後幾行，pool PUB 的 total addresses 4、allocated 4 (100%)，misses 一直在增加。',
      'show ip nat translations：四筆「--- 203.0.113.11 10.10.0.10x --- ---」，每台電腦各佔一個公用位址。位址池的規則沒有 overload，是一對一的動態 NAT。',
      '要改規則先清掉轉換：clear ip nat translation *（在特權模式）。不然 IOS 會說 %Dynamic mapping in use。',
      'configure terminal → ip nat inside source list 10 pool PUB overload（或 no 掉舊的，改成 ip nat inside source list 10 interface Gi0/0/0 overload）。',
    ],
    solve(s) {
      if (s.dyn.natPool) delete s.dyn.natPool.rt; // clear ip nat translation *
      typeIn(s, 'rt', ['configure terminal', 'ip nat inside source list 10 pool PUB overload', 'end', 'write memory']);
    },
    recap: [
      '沒有 overload 的位址池是一對一：公用位址比內部主機少，晚到的人就借不到位址。',
      '一般上網用 PAT（overload）；需要固定對外位址的伺服器才用靜態 NAT。',
    ],
  },
];
