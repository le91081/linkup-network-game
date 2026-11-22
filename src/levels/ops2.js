// 第十一章補充：NetFlow 找出是誰塞滿了專線、再用 QoS 的 police 限速
import { makeDevice as D, makeState, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { advance, recompute, settle } from '../engine/sim.js';
import { nfTop } from '../engine/netflow.js';
import { fmtIp } from '../engine/ip.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
function fresh(s) {
  const keep = s.flows;
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  s.flows = keep;
  return s;
}

export const LEVELS25 = [
  {
    id: 'l97', chapter: 11, title: '專線被塞滿了，是誰？', subtitle: 'NetFlow 找出流量大戶，police 替它限速', tags: ['NetFlow', 'SNMP', 'QoS', 'police', '頻寬'],
    brief: '分公司到總公司是一條 50 Mbps 的專線。這週分公司的人一直抱怨 ERP 慢到不能用，網管伺服器（SNMP）也顯示專線整天都是滿的，但 SNMP 只看得到「這條線很滿」，看不到是誰在用。請找出是哪一台電腦在佔用頻寬；那台電腦的同步不能直接擋掉（老闆說資料還是要傳），但最多只能用 10 Mbps，讓 ERP 恢復正常。',
    given: [
      ['BR-RT', '分公司 10.20.0.0/24（Gi0/0/1）· 專線 Gi0/0/0 10.0.0.2/30（合約 50 Mbps）'], ['HQ-RT', '專線 10.0.0.1 · 總公司 10.10.0.0/24'],
      ['網管伺服器', '10.10.0.50 · SNMP 已經在監控專線；也可以當 NetFlow 收集器（UDP 2055）'], ['ERP', '10.10.0.20（HTTPS）'], ['分公司的電腦', '10.20.0.31 ～ 10.20.0.34'],
    ],
    learn: [
      { t: 'SNMP 與 NetFlow', d: 'SNMP 告訴你「每個介面收送了多少位元組」：看得出哪條線滿了，看不出是誰。NetFlow 讓路由器記下每一條流量（來源、目的、協定、埠、從哪個介面進來、多少位元組），定期匯出給收集器，就能排出流量大戶 (Top Talkers)。' },
      { t: '傳統 NetFlow', d: '在流量進來的介面上 ip flow ingress，再 ip flow-export destination <收集器> <UDP 埠> 與 ip flow-export version 9。路由器自己可以 show ip cache flow 看快取。' },
      { t: 'Flexible NetFlow', d: '新的 IOS 用三個物件：flow record（要記哪些欄位，也可以直接用內建的 netflow ipv4 original-input）、flow exporter（送去哪裡）、flow monitor（把兩者綁在一起），再在介面上 ip flow monitor <名稱> input。show flow monitor <名稱> cache 看快取。' },
      { t: '限速：police', d: 'class-map 用 ACL 挑出那台電腦的流量，policy-map 在那個 class 底下 police cir 10000000（每秒 10 Mbps，超過的直接丟掉），在進來的介面上 service-policy input。TCP 被丟封包就會自己慢下來，資料照樣傳、只是不會再搶光整條線。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'br', { name: 'BR-RT', pos: [5, -4] }), D('isr4331', 'hq', { name: 'HQ-RT', pos: [-5, -4] }),
        D('sw8', 'bsw', { name: 'BR-SW', pos: [5, 0.5] }), D('sw8', 'hsw', { name: 'HQ-SW', pos: [-5, 0.5] }),
        D('tower', 'erp', { name: 'ERP', pos: [-9, 5], ip: '10.10.0.20', gw: '10.10.0.1', services: [{ proto: 'tcp', port: 443, name: 'ERP（HTTPS）' }] }),
        D('nas', 'bk', { name: '雲端同步伺服器', pos: [-5, 5.5], ip: '10.10.0.30', gw: '10.10.0.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS 同步' }] }),
        D('tower', 'nms', { name: '網管伺服器', pos: [-1, 5], ip: '10.10.0.50', gw: '10.10.0.1', services: [{ proto: 'udp', port: 162, name: 'SNMP Trap' }, { proto: 'udp', port: 2055, name: 'NetFlow 收集器' }], init(d) { d.nms = { targets: [{ ip: '10.0.0.2', ver: 'v2c', community: 'public' }] }; } }),
        ...[1, 2, 3, 4].map((n) => D('pc', 'pc' + n, { name: `分公司 PC-${n}`, pos: [1.5 + (n - 1) * 2.5, 5.5], ip: '10.20.0.3' + n, gw: '10.20.0.1' })),
      ], [['br:Gi0/0/0', 'hq:Gi0/0/0'], ['br:Gi0/0/1', 'bsw:1'], ['hq:Gi0/0/1', 'hsw:1'], ['erp:eth0', 'hsw:2'], ['bk:eth0', 'hsw:3'], ['nms:eth0', 'hsw:4'],
        ...[1, 2, 3, 4].map((n) => ['pc' + n + ':eth0', 'bsw:' + (n + 1)])]);
      s.cables.find((c) => [c.a.dev, c.b.dev].sort().join() === 'br,hq').cir = 50; // 營運商的合約頻寬 50 Mbps
      recompute(s);
      typeIn(s, 'br', ['configure terminal', 'interface Gi0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.20.0.1 255.255.255.0', 'no shutdown', 'exit',
        'ip route 0.0.0.0 0.0.0.0 10.0.0.1', 'snmp-server community public RO', 'end', 'write memory']);
      typeIn(s, 'hq', ['configure terminal', 'interface Gi0/0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.10.0.1 255.255.255.0', 'no shutdown', 'exit',
        'ip route 10.20.0.0 255.255.255.0 10.0.0.2', 'end', 'write memory']);
      // PC-3 的雲端同步軟體：一直在上傳
      s.flows = [
        { id: 'sync', from: 'pc3', ip: '10.10.0.30', port: 443, mbps: 200, label: '雲端同步', on: true },
        { id: 'mail', from: 'pc1', ip: '10.10.0.20', port: 443, mbps: 3, label: '一般使用', on: true },
      ];
      return fresh(s);
    },
    objectives: [
      {
        type: 'check', label: '網管伺服器收得到 BR-RT 的 NetFlow，排得出流量大戶',
        test(s) {
          // NetFlow 是隨著時間累積、定期匯出的：在複本上讓時間走 10 秒再看收集器
          const s2 = cloneState(s);
          settle(s2);
          advance(s2, 10);
          const top = nfTop(s2, dev(s2, 'nms'));
          if (!top.length) return '網管伺服器還沒有收到任何 NetFlow：BR-RT 要在流量進來的介面收集（ip flow ingress 或 ip flow monitor），再匯出到 10.10.0.50 的 UDP 2055';
          return true;
        },
      },
      { type: 'speed', from: 'pc2', to: 'erp', port: 443, min: 25, label: 'ERP 恢復正常：分公司到 ERP 至少 25 Mbps' },
      {
        type: 'check', label: 'PC-3 的同步沒有被擋掉，但最多只用 10 Mbps',
        test(s) {
          const f = (s.flows || []).find((x) => x.id === 'sync');
          const m = f && f.rt ? f.rt.mbps : 0;
          if (!(m > 0.5)) return `PC-3 的同步被擋掉了（${(f && f.rt && f.rt.why) || '速率 0'}）：老闆說資料還是要傳`;
          if (m > 10.5) return `PC-3 的同步還在用 ${m} Mbps：要限制在 10 Mbps 以內`;
          return true;
        },
      },
    ],
    hints: [
      '網管伺服器的「網管」分頁：BR-RT 的 Gi0/0/0 一直接近 50 Mbps，但看不出是哪一台。BR-RT 的 CLI：interface Gi0/0/1 → ip flow ingress；ip flow-export version 9；ip flow-export destination 10.10.0.50 2055。（或用 Flexible NetFlow：flow exporter / flow monitor，再 ip flow monitor … input）',
      'BR-RT 上 show ip cache flow，或網管伺服器的 NetFlow 列表：10.20.0.33（PC-3）往 10.10.0.30:443 的流量遠遠多於其他人。',
      'BR-RT：ip access-list extended SYNC → permit ip host 10.20.0.33 any；class-map match-all SYNC → match access-group name SYNC；policy-map LIMIT-SYNC → class SYNC → police cir 10000000；interface Gi0/0/1 → service-policy input LIMIT-SYNC。',
    ],
    solve(s) {
      typeIn(s, 'br', ['configure terminal', 'interface Gi0/0/1', 'ip flow ingress', 'exit', 'ip flow-export version 9', 'ip flow-export destination 10.10.0.50 2055',
        'ip access-list extended SYNC', 'permit ip host 10.20.0.33 any', 'exit', 'class-map match-all SYNC', 'match access-group name SYNC', 'exit',
        'policy-map LIMIT-SYNC', 'class SYNC', 'police cir 10000000', 'exit', 'exit', 'interface Gi0/0/1', 'service-policy input LIMIT-SYNC', 'end', 'write memory']);
    },
    recap: ['SNMP 看得出哪條線滿了；NetFlow 看得出是誰、往哪裡、用什麼協定。', 'police 在進來的介面上替某一類流量限速：超過的丟掉，TCP 自己慢下來；shape 則是把多的排隊延後送。'],
  },
];
void fmtIp;
