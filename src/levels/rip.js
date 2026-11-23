// 第十三章補充：RIP（版本不一致、auto-summary 與不連續的網段）
import { makeDevice as D, makeState } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });

export const LEVELS50 = [
  {
    id: 'l130', chapter: 13, title: '舊工廠的 RIP：一半的機台連不到', subtitle: 'RIP 的版本與 auto-summary（不連續的網段）', tags: ['RIP', 'RIPv2', 'auto-summary', 'discontiguous', '有類別'],
    brief: '公司接手了一座舊工廠，兩個廠區各有一台很舊的路由器，彼此之間只會跑 RIP。總公司的 Core-RT 照範本設好了 RIPv2，可是辦公室只連得到 B 廠的 SCADA，A 廠的 MES 完全連不到。請讓辦公室兩個廠區都連得到，而且 Core-RT 要學到兩個廠區各自的網段。',
    given: [
      ['Core-RT', 'Gi0/0/0 10.0.1.1 ↔ FAC-A · Gi0/0/1 10.0.2.1 ↔ FAC-B · 辦公室 10.1.0.0/24'],
      ['A 廠', 'FAC-A · 172.16.1.0/24 · MES 172.16.1.10（HTTPS）'], ['B 廠', 'FAC-B · 172.16.2.0/24 · SCADA 172.16.2.10（HTTPS）'],
      ['RIP', 'Core-RT：version 2、no auto-summary · 兩台工廠的路由器是原本的設定'], ['規定', '不可以用靜態路由；舊路由器不換掉'],
    ],
    learn: [
      { t: 'RIP', d: '最老的距離向量路由協定：metric 只看跳數，最多 15 跳，16 代表到不了。每 30 秒把整張路由表送給鄰居，AD 是 120，路由表裡標 R。現在多半只剩在舊工廠、舊設備上，新的網路用 OSPF。' },
      { t: 'network 只能寫主網段', d: 'RIP 的 network 是有類別的：network 10.1.0.0 會自動變成 network 10.0.0.0，IP 落在 10.x.x.x 的介面全部跑 RIP。想排除某個介面要用 passive-interface（不送更新，但照樣收）。' },
      { t: 'v1 和 v2', d: 'RIPv1 用廣播送、不帶遮罩、不能驗證；RIPv2 用 224.0.0.9 送、帶遮罩、可以驗證。沒有設 version 的 IOS 送 v1、收 v1 和 v2；version 2 只收 v2，所以一邊設了 version 2、一邊沒設，只有一個方向學得到路（debug ip rip 會看到 ignored v1 packet … illegal version）。' },
      { t: 'auto-summary 與不連續的網段', d: '自動彙總開著的時候，子網路送到「別的主網段」的介面上，會合成有類別的網段：172.16.1.0/24 從 10.x 的介面送出去就變成 172.16.0.0/16。兩個廠區都是 172.16 的子網路、中間隔著 10.x（不連續的網段，discontiguous），Core-RT 就從兩邊都學到 172.16.0.0/16，等價分流，一半的封包送錯廠區。RIPv2 與 EIGRP 都要 no auto-summary。' },
      { t: '收斂很慢', d: '介面斷掉會馬上送出 triggered update；可是隔著交換器、對方不見了，要等 invalid timer（180 秒）才標成 possibly down，再等 flush（240 秒）才清掉、改走別條路。這段時間封包都送往不在的路由器。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'core', { name: 'Core-RT', pos: [0, -5], init(d) { ip4(d, 'Gi0/0/0', '10.0.1.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.2.1', '255.255.255.252'); ip4(d, 'Gi0/0/2', '10.1.0.1'); } }),
        D('isr4321', 'fa', { name: 'FAC-A', pos: [-7, -1], init(d) { ip4(d, 'Gi0/0/0', '10.0.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.16.1.1'); } }),
        D('isr4321', 'fb', { name: 'FAC-B', pos: [7, -1], init(d) { ip4(d, 'Gi0/0/0', '10.0.2.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '172.16.2.1'); } }),
        D('sw8', 'osw', { name: 'Office-SW', pos: [0, 0.5] }),
        D('pc', 'pc', { name: '辦公室 PC', pos: [0, 4.5], ip: '10.1.0.50', gw: '10.1.0.1' }),
        D('tower', 'mes', { name: 'MES（A 廠）', pos: [-9, 4], ip: '172.16.1.10', gw: '172.16.1.1', services: WEB }),
        D('tower', 'scada', { name: 'SCADA（B 廠）', pos: [9, 4], ip: '172.16.2.10', gw: '172.16.2.1', services: WEB }),
      ], [['core:Gi0/0/0', 'fa:Gi0/0/0'], ['core:Gi0/0/1', 'fb:Gi0/0/0'], ['core:Gi0/0/2', 'osw:1'], ['pc:eth0', 'osw:2'], ['fa:Gi0/0/1', 'mes:eth0'], ['fb:Gi0/0/1', 'scada:eth0']]);
      recompute(s);
      typeIn(s, 'core', ['configure terminal', 'router rip', 'version 2', 'network 10.0.0.0', 'passive-interface Gi0/0/2', 'no auto-summary', 'end', 'write memory']);
      // A 廠：沒有設 version（送 v1）；B 廠：version 2，auto-summary 還開著
      typeIn(s, 'fa', ['configure terminal', 'router rip', 'network 10.0.0.0', 'network 172.16.0.0', 'passive-interface Gi0/0/1', 'end', 'write memory']);
      typeIn(s, 'fb', ['configure terminal', 'router rip', 'version 2', 'network 10.0.0.0', 'network 172.16.0.0', 'passive-interface Gi0/0/1', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'mes', port: 443, label: '辦公室打得開 A 廠的 MES（https://172.16.1.10）' },
      { type: 'tcp', from: 'pc', to: 'scada', port: 443, label: '辦公室打得開 B 廠的 SCADA（https://172.16.2.10）' },
      {
        type: 'check', label: 'Core-RT 從 RIP 學到兩個廠區各自的網段（不是合成的 172.16.0.0/16）',
        test(s) {
          const c = dev(s, 'core');
          if (['core', 'fa', 'fb'].some((id) => (dev(s, id).routes || []).some((r) => /^172\.16\.|^10\.|^0\.0\.0\.0$/.test(r.dst || '')))) return '有人加了靜態路由：規定是要讓 RIP 自己學到';
          const rt = (ip, bits) => c.rt.routes.filter((r) => r.net === parseIp(ip) && r.bits === bits);
          const sum = rt('172.16.0.0', 16);
          if (sum.length) return `Core-RT 的路由表裡是 172.16.0.0/16（auto-summary 合成的）${sum.length > 1 ? '，而且兩個廠區各報了一筆、等價分流' : ''}`;
          for (const [ip, who, id] of [['172.16.1.0', 'A 廠', 'fa'], ['172.16.2.0', 'B 廠', 'fb']]) {
            const r = rt(ip, 24);
            if (!r.length) return `Core-RT 沒有學到 ${who}的 ${ip}/24`;
            if (r[0].type !== 'R') return `Core-RT 的 ${ip}/24 不是 RIP 學到的`;
            if (r[0].iface.id !== (id === 'fa' ? 'Gi0/0/0' : 'Gi0/0/1')) return `Core-RT 往 ${ip}/24 的路走錯介面`;
          }
          return true;
        },
      },
    ],
    hints: [
      'Core-RT 的 CLI：show ip route rip 只看得到 172.16.0.0/16 via 10.0.2.2（B 廠），A 廠報的路一筆都沒有。debug ip rip 讓時間前進 30 秒：ignored v1 packet from 10.0.1.2 (illegal version)。',
      'FAC-A 的 show ip protocols：Default version control: send version 1, receive any version。FAC-A：router rip → version 2。',
      '改好之後 Core-RT 從兩邊都學到 172.16.0.0/16：兩個廠區的路由器都把 172.16.x 的子網路合成有類別的網段才送出來（show ip rip database 的 auto-summary）。',
      'FAC-A 與 FAC-B：router rip → no auto-summary。Core-RT 就會看到 172.16.1.0/24 via 10.0.1.2、172.16.2.0/24 via 10.0.2.2。',
    ],
    solve(s) {
      typeIn(s, 'fa', ['configure terminal', 'router rip', 'version 2', 'no auto-summary', 'end', 'write memory']);
      typeIn(s, 'fb', ['configure terminal', 'router rip', 'no auto-summary', 'end', 'write memory']);
    },
    recap: [
      'RIP 的版本要對得上：version 2 的路由器會丟掉 v1 的更新；沒有設 version 的 IOS 送 v1。',
      'auto-summary 會在主網段的邊界把子網路合成有類別的網段；網段不連續 (discontiguous) 時一定要 no auto-summary。',
    ],
  },
];
