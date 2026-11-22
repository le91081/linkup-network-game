// 第十二章補充：雙 WAN 的 QoS — 主線有整形與 LLQ，切到備援線路時卻沒有，電話就斷斷續續
import { makeDevice as D, makeState, newIface, cloneState } from '../engine/model.js';
import { recompute, settle } from '../engine/sim.js';
import { iosSession } from '../engine/ios.js';
import { callQuality } from '../engine/voice.js';
import { egressOf } from '../engine/qos.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
const pool = (d, id, name, start, end, extra = {}) => { Object.assign(d.ifaces.find((i) => i.id === id).dhcp, { on: true, pool: name, start, end, dns: '', gw: '', ...extra }); };
const access = (d, ports, vlan) => { for (const p of ports) Object.assign(d.sw.ports[p], { mode: 'access', vlan }); };
const SERVICES_CUCM = [{ proto: 'udp', port: 69, name: 'TFTP' }, { proto: 'udp', port: 5060, name: 'SIP' }];
// 兩端原本就有的 QoS：只套在主線上
const QOS = ['class-map match-any VOICE', 'match dscp ef', 'exit', 'policy-map VOICE-PRI', 'class VOICE', 'priority percent 30', 'exit', 'class class-default', 'fair-queue', 'exit', 'exit',
  'policy-map WAN-OUT', 'class class-default', 'shape average 50000000', 'service-policy VOICE-PRI', 'exit', 'exit', 'interface Gi0/0/0', 'service-policy output WAN-OUT', 'exit'];

function fresh(s) {
  const keep = { flows: s.flows, calls: s.calls };
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  Object.assign(s, keep);
  return s;
}
/** 在複本上把主線切斷（up 為 true 時反過來：主線正常），等路由收斂 */
function primaryDown(s, up = false) {
  const s2 = cloneState(s), c = s2.cables.find((x) => [x.a, x.b].some((e) => e.dev === 'brt' && e.port === 'Gi0/0/0'));
  s2.cut = { ...(s2.cut || {}) };
  if (up) delete s2.cut[c.id]; else s2.cut[c.id] = true;
  recompute(s2); settle(s2);
  return s2;
}
const hopOut = (s, from, port) => { const l = s.rt.links[`${from}:${port}`]; return l && egressOf(s, { cable: l.cable, from, fromPort: port, to: l.dev, toPort: l.port, tag: null }); };

export const LEVELS28 = [
  {
    id: 'l100', chapter: 12, title: '專線一斷，電話就聽不清楚', subtitle: '雙 WAN 的 QoS：每一條線路要有自己的整形', tags: ['QoS', 'LLQ', 'Shaping', '雙 WAN', 'Floating Static', '備援'],
    brief: '分公司到總公司有兩條線：主線是 50 Mbps 的 Metro Ethernet，備援是 10 Mbps 的線路，主線斷掉時路由器會自動切過去。上週道路施工挖斷了主線，網路沒有斷，可是那一整天跟總公司講電話都斷斷續續；主線修好之後電話又正常了。下次再切到備援線路時，電話要一樣清楚，備份也不能停掉；平常走主線的 QoS 不能變差。',
    given: [
      ['主線', 'BR-RT Gi0/0/0 ↔ HQ-RT Gi0/0/0 · 10.255.0.0/30 · Metro Ethernet 合約 50 Mbps'], ['備援線路', 'BR-RT Gi0/0/2 ↔ HQ-RT Gi0/0/2 · 10.255.1.0/30 · 合約 10 Mbps（浮動靜態路由，管理距離 10）'],
      ['現有的 QoS', '兩台路由器的 Gi0/0/0 都套了 WAN-OUT（shape 50 Mbps + LLQ 的 VOICE-PRI）'], ['劇本', '開始三分鐘後施工會再挖斷一次主線，十分鐘後修好：可以直接看切換的過程'], ['正在跑的', '分公司 PC 往檔案伺服器的三個備份工作，以及一通分公司 ↔ 總公司的電話'],
    ],
    learn: [
      { t: 'QoS 是跟著介面走的', d: 'service-policy output 套在哪個介面，就只管那個介面送出去的流量。主線斷掉、路由切到備援線路之後，流量從另一個介面出去：那裡沒有政策，語音又回到和備份搶同一個佇列。' },
      { t: '每條線路有自己的合約頻寬', d: '備援線路的合約只有 10 Mbps：照搬主線的 shape 50 Mbps，超過的部分一樣在營運商那端被丟掉，語音也被丟。每一條 WAN 線路都要依自己的合約整形（parent shape），再掛上同一個 LLQ 的 child 政策。' },
      { t: 'priority percent', d: 'priority percent 30 是「整形後頻寬的 30%」：主線是 15 Mbps、備援線路是 3 Mbps，一通 G.711 的電話大約 87 kbps，兩條線都夠。用百分比寫，同一個 child 政策就可以給不同速度的線路共用。' },
      { t: '故障演練', d: '備援線路平常沒有流量，設定錯了也沒人發現，要真的斷線才知道。任務的「故障演練」會在複本上把主線切斷、等路由收斂之後再測試，不會影響眼前的網路。' },
    ],
    setup() {
      const s = makeState([
        D('c2960p', 'bsw', {
          name: 'BR-SW', pos: [-11, 1.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'DATA' }, { id: 110, name: 'VOICE' });
            access(d, ['Gi0/1', 'Gi0/2'], 10); d.sw.ports['Gi0/1'].voice = 110;
            d.sw.ports['Gi0/9'].mode = 'trunk';
          },
        }),
        D('isr4331', 'brt', {
          name: 'BR-RT', pos: [-5, -4],
          init(d) {
            sub(d, 'Gi0/0/1', 10, '10.20.10.1'); sub(d, 'Gi0/0/1', 110, '10.20.110.1');
            pool(d, 'Gi0/0/1.10', 'DATA', '10.20.10.100', '10.20.10.199');
            pool(d, 'Gi0/0/1.110', 'VOICE', '10.20.110.100', '10.20.110.199', { tftp: '10.10.100.10' });
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ip: '10.255.0.1', mask: '255.255.255.252' });
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/2'), { ip: '10.255.1.1', mask: '255.255.255.252' });
            d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.255.0.2' }, { dst: '0.0.0.0', mask: '0.0.0.0', via: '10.255.1.2', ad: '10' });
          },
        }),
        D('isr4331', 'hrt', {
          name: 'HQ-RT', pos: [5, -4],
          init(d) {
            sub(d, 'Gi0/0/1', 100, '10.10.100.1'); sub(d, 'Gi0/0/1', 110, '10.10.110.1');
            pool(d, 'Gi0/0/1.110', 'VOICE', '10.10.110.100', '10.10.110.199', { tftp: '10.10.100.10' });
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ip: '10.255.0.2', mask: '255.255.255.252' });
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/2'), { ip: '10.255.1.2', mask: '255.255.255.252' });
            d.routes.push({ dst: '10.20.0.0', mask: '255.255.0.0', via: '10.255.0.1' }, { dst: '10.20.0.0', mask: '255.255.0.0', via: '10.255.1.1', ad: '10' });
          },
        }),
        D('c2960p', 'hsw', {
          name: 'HQ-SW', pos: [11, 1.5],
          init(d) {
            d.sw.vlans.push({ id: 100, name: 'SERVERS' }, { id: 110, name: 'VOICE' });
            access(d, ['Gi0/1', 'Gi0/5', 'Gi0/6'], 100); d.sw.ports['Gi0/1'].voice = 110;
            d.sw.ports['Gi0/9'].mode = 'trunk';
          },
        }),
        D('ipphone', 'ph-br', { name: '分公司電話', pos: [-14, 5.5] }),
        D('pc', 'pc-br', { name: '分公司 PC', pos: [-15.5, 9], dhcp: true }),
        D('ipphone', 'ph-hq', { name: '總公司電話', pos: [9, 6] }),
        D('tower', 'cucm', { name: 'CUCM', pos: [14, 5], ip: '10.10.100.10', gw: '10.10.100.1', services: SERVICES_CUCM }),
        D('tower', 'fs', { name: '檔案伺服器', pos: [15.5, 0.5], ip: '10.10.100.20', gw: '10.10.100.1', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
      ], [['ph-br:sw', 'bsw:Gi0/1'], ['pc-br:eth0', 'ph-br:pc'], ['bsw:Gi0/9', 'brt:Gi0/0/1'], ['brt:Gi0/0/0', 'hrt:Gi0/0/0'], ['brt:Gi0/0/2', 'hrt:Gi0/0/2'], ['hrt:Gi0/0/1', 'hsw:Gi0/9'],
        ['ph-hq:sw', 'hsw:Gi0/1'], ['cucm:eth0', 'hsw:Gi0/5'], ['fs:eth0', 'hsw:Gi0/6']]);
      const cab = (port) => s.cables.find((c) => [c.a, c.b].some((e) => e.dev === 'brt' && e.port === port));
      cab('Gi0/0/0').cir = 50;
      cab('Gi0/0/2').cir = 10;
      s.devices.cucm.cucm = { autoReg: true, first: 2001, phones: [] };
      s.flows = [1, 2, 3].map((n) => ({ id: 'bk' + n, from: 'pc-br', ip: '10.10.100.20', port: 445, mbps: 300, label: `備份工作 ${n}` }));
      s.calls = [{ id: 'call1', a: 'ph-br', b: 'ph-hq', label: '分公司 ↔ 總公司' }];
      recompute(s);
      typeIn(s, 'brt', ['configure terminal', ...QOS, 'end', 'write memory']);
      typeIn(s, 'hrt', ['configure terminal', ...QOS, 'end', 'write memory']);
      // 劇本：三分鐘後施工又挖斷了主線，十分鐘後修好（任務的故障演練不受影響，隨時都可以測）
      s.script = [
        { at: 180, text: '⚠ 道路施工又挖斷了主線（BR-RT Gi0/0/0）：路由切到 10 Mbps 的備援線路', why: '道路施工挖斷了主線的光纖', cut: [['brt', 'Gi0/0/0']] },
        { at: 600, text: '主線修好了：路由切回 Metro Ethernet', uncut: [['brt', 'Gi0/0/0']] },
      ];
      return fresh(s);
    },
    objectives: [
      {
        type: 'check', label: '平常走主線：備份在跑的時候，通話清楚（MOS ≥ 4.0）',
        test(s) {
          const q = callQuality(primaryDown(s, true), 'ph-br', 'ph-hq');
          if (!q.ok) return q.why;
          return q.mos >= 4 ? true : `走主線時通話品質 MOS ${q.mos}，要 4 以上：${q.why}`;
        },
      },
      { type: 'failover', cut: [['brt', 'Gi0/0/0']], label: '故障演練：主線斷掉、切到備援線路時，通話一樣清楚（MOS ≥ 4.0）', test: { type: 'call', from: 'ph-br', to: 'ph-hq', mos: 4.0 } },
      {
        type: 'check', label: '切到備援線路時，BR-RT 依備援的合約整形（不會被營運商丟掉），備份照樣在跑',
        test(s) {
          const s2 = primaryDown(s);
          const eg = hopOut(s2, 'brt', 'Gi0/0/2');
          if (!eg) return '主線斷掉時，BR-RT 的 Gi0/0/2（備援線路）沒有連線';
          if (!eg.shape) return 'BR-RT 的 Gi0/0/2 沒有整形：切過去之後用 1 Gbps 往外送，超過 10 Mbps 的部分在營運商那端被丟掉（語音也是）';
          if (eg.shape > eg.cir) return `BR-RT 的 Gi0/0/2 整形到 ${eg.shape} Mbps，超過備援線路的合約 ${eg.cir} Mbps：不能照搬主線的 WAN-OUT`;
          const q = callQuality(s2, 'ph-br', 'ph-hq');
          if (!q.ok) return q.why;
          const sum = (s2.flows || []).reduce((a, f) => a + (f.on === false ? 0 : (f.rt && f.rt.mbps) || 0), 0);
          return sum >= 5 ? true : `切到備援線路時備份總共只剩 ${Math.round(sum * 10) / 10} Mbps：QoS 是讓語音先走，不是把備份停掉`;
        },
      },
      {
        type: 'check', label: '主線的 QoS 沒有被改壞：BR-RT 的 Gi0/0/0 仍然整形到 50 Mbps 以內',
        test(s) {
          const eg = hopOut(primaryDown(s, true), 'brt', 'Gi0/0/0');
          if (!eg) return 'BR-RT 的主線 Gi0/0/0 沒有連線';
          if (!eg.shape) return 'BR-RT 的 Gi0/0/0 沒有整形了：主線也要保留 WAN-OUT';
          return eg.shape <= eg.cir ? true : `主線整形到 ${eg.shape} Mbps，超過合約的 ${eg.cir} Mbps`;
        },
      },
    ],
    hints: [
      '先演練一次：任務的第二項會在複本上切斷主線。BR-RT 的 show ip route 會變成走 10.255.1.2，show policy-map interface 只列出 Gi0/0/0，備援的 Gi0/0/2 沒有任何政策。',
      'WAN-OUT 是 shape 50 Mbps，不能直接套到 10 Mbps 的備援線路。另外建一個 parent：policy-map WAN-BACKUP → class class-default → shape average 10000000 → service-policy VOICE-PRI。',
      'BR-RT：interface Gi0/0/2 → service-policy output WAN-BACKUP。（HQ-RT 的 Gi0/0/2 也照做，總公司往分公司的方向才有保障）',
    ],
    solve(s) {
      const b = ['configure terminal', 'policy-map WAN-BACKUP', 'class class-default', 'shape average 10000000', 'service-policy VOICE-PRI', 'exit', 'exit', 'interface Gi0/0/2', 'service-policy output WAN-BACKUP', 'end', 'write memory'];
      typeIn(s, 'brt', b);
      typeIn(s, 'hrt', b);
    },
    recap: ['service-policy 只管它所在的介面：備援線路要有自己的政策，切過去之後 QoS 才跟得上。', '每條線路依自己的合約整形；LLQ 的 child 政策用 priority percent，就可以讓不同速度的線路共用。'],
  },
];
void dev;
