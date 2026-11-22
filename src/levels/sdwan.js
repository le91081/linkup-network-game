// 第七章補充：FortiGate 的 SD-WAN（兩條線路依流量的種類挑路：效能 SLA、SD-WAN 規則、virtual-wan-link）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { transact } from '../engine/sim.js';
import { newSdwan } from '../engine/sdwan.js';
import { parseIp } from '../engine/ip.js';
import { dev } from './util.js';

const SIP = '198.51.100.60', WEB = '93.184.216.34';
const W1 = { ip: '203.0.113.34', gw: '203.0.113.33' }, W2 = { ip: '192.0.2.2', gw: '192.0.2.1' };
const two = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });

/** 一般上網的流量從防火牆的哪個介面出去 */
const egressOf = (s, from, ip, port) => {
  const r = transact(s, from, { proto: 'tcp', dst: parseIp(ip), dport: port, quiet: true });
  if (!r.ok) return { why: r.reason };
  const h = r.hops.find((x) => x.from === 'fg' && !x.reply && /^wan/.test(x.fromPort || ''));
  return { port: h ? h.fromPort : null };
};

export const LEVELS37 = [
  // ════════════════════════ 7-13 ════════════════════════
  {
    id: 'l117', chapter: 7, title: '下午一塞車，電話就斷斷續續', subtitle: 'SD-WAN：效能 SLA 與依流量挑線路', tags: ['SD-WAN', 'FortiGate', 'SLA', 'VoIP', '雙 WAN'],
    brief: `分公司用雲端總機（SIP 業者 ${SIP}），業務用電腦上的軟體電話打電話。每天下午光世代 (wan1) 一塞車，電話就斷斷續續。公司加申請了一條品質好但比較貴的企業專線 (wan2)，已經接在 FortiGate 上了。請用 SD-WAN 讓電話自動走品質符合要求的線路；一般上網照樣走便宜的光世代，任何一條線路斷了，電話和上網都要能改走另一條。`,
    given: [
      ['光世代 (wan1)', `${W1.ip}/30 · 閘道 ${W1.gw} · 頻寬大、便宜，下午會塞車`], ['企業專線 (wan2)', `${W2.ip}/30 · 閘道 ${W2.gw} · 品質好、比較貴`],
      ['SIP 業者', `${SIP}（UDP 5060、語音 RTP 16384）`], ['語音的品質要求', '延遲 ≤ 150 ms、抖動 ≤ 30 ms、遺失 ≤ 1%（偵測目標 8.8.8.8）'],
      ['業務 PC（軟體電話）', '192.168.10.21'], ['一般 PC', '192.168.10.22'],
    ],
    learn: [
      { t: 'SD-WAN', d: '把好幾條 WAN 線路（光世代、專線、4G）合成一個區域 (FortiGate 叫 virtual-wan-link)，再依流量的種類挑線路：電話、視訊走品質好的，備份、更新走便宜的；一條斷了自動改走別條。傳統的做法是兩條預設路由等價分散，或一主一備，不管線路品質。' },
      { t: '效能 SLA', d: 'SD-WAN 持續對偵測目標（例如 8.8.8.8）送探測，量每條線路的延遲、抖動 (jitter)、遺失，和門檻比較：全部在門檻以內才算「符合 SLA」。線路沒有回應就判定為 dead，從 SD-WAN 移除。diagnose sys sdwan health-check 看得到量測結果。' },
      { t: 'SD-WAN 規則', d: '由上往下比對目的位址、協定、埠。手動：照順序用第一條活著的；SLA：照順序用第一條符合 SLA 的，全部不符合就用第一條活著的；最佳品質：用延遲最低的。沒有符合規則的流量依來源位址分散到所有活著的線路。' },
      { t: 'virtual-wan-link', d: '介面加進 SD-WAN 之後，防火牆政策的目的介面要寫 virtual-wan-link（區域），不能再寫 wan1；還被政策使用中的介面也不能加進 SD-WAN，要先改掉政策。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: two });
      // 光世代下午塞車：延遲、抖動都變大，還會掉包；企業專線很穩
      setLine(inet, 'line1', { type: 'static', gw: W1.gw, mask: '255.255.255.252', assign: W1.ip, q: { delay: 35, jitter: 45, loss: 4 } });
      setLine(inet, 'line2', { type: 'static', gw: W2.gw, mask: '255.255.255.252', assign: W2.ip, q: { delay: 9, jitter: 2, loss: 0 } });
      inet.inet.hosts.push({ ip: SIP, name: 'SIP 業者（雲端總機）', services: [{ proto: 'udp', port: 5060, name: 'SIP' }, { proto: 'udp', port: 16384, name: 'RTP' }] });
      return makeState([
        inet,
        D('fg60f', 'fg', {
          name: 'FortiGate', pos: [0, -3.5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: W1.ip, mask: '255.255.255.252', gateway: W1.gw });
            Object.assign(g('wan2'), { ip: W2.ip, mask: '255.255.255.252' }); // 剛接好：還沒有閘道，什麼都沒走它
            Object.assign(g('internal'), { ip: '192.168.10.1', mask: '255.255.255.0' });
            d.policies.push(allow('上網', 'internal', 'wan1', { nat: true }));
          },
        }),
        D('pc', 'pc-v', { name: '業務 PC（軟體電話）', pos: [-4, 3], ip: '192.168.10.21', gw: '192.168.10.1', dns: '8.8.8.8' }),
        D('pc', 'pc-w', { name: '一般 PC', pos: [4, 3], ip: '192.168.10.22', gw: '192.168.10.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'fg:wan1'], ['inet:line2', 'fg:wan2'], ['pc-v:eth0', 'fg:1'], ['pc-w:eth0', 'fg:2']]);
    },
    objectives: [
      { type: 'voip', from: 'pc-v', ip: SIP, mos: 4.0, label: `業務 PC 打給 SIP 業者，通話品質 MOS 4.0 以上` },
      {
        type: 'check', label: '一般上網（https://www.example.com）照樣走光世代 (wan1)',
        test(s) {
          const e = egressOf(s, 'pc-w', WEB, 443);
          if (e.why) return `一般 PC 連不上網站：${e.why}`;
          return e.port === 'wan1' || `一般上網走了 ${e.port}：企業專線比較貴，只讓電話（和備援）使用`;
        },
      },
      { type: 'failover', cut: [['fg', 'wan2']], test: { type: 'voip', from: 'pc-v', ip: SIP, mos: 2.5 }, label: '企業專線斷線時，電話改走光世代，還打得通' },
      { type: 'failover', cut: [['fg', 'wan1']], test: { type: 'tcp', from: 'pc-w', ip: WEB, port: 443 }, label: '光世代斷線時，一般上網改走企業專線' },
    ],
    hints: [
      'FortiGate →「SD-WAN」分頁：啟用 SD-WAN。wan1 還被政策「上網」使用，要先到「政策」分頁把它的目的介面改成 virtual-wan-link，才能把 wan1 加進 SD-WAN。',
      `SD-WAN 成員：wan1（閘道 ${W1.gw}）與 wan2（閘道 ${W2.gw}）。效能 SLA：偵測 8.8.8.8，門檻延遲 150 ms、抖動 30 ms、遺失 1%。看看量測結果：wan1 的遺失是多少？`,
      `SD-WAN 規則 1「VoIP」：目的 ${SIP}、UDP，方式選 SLA，順序 wan1 → wan2（光世代符合 SLA 時也可以用；不符合就自動改走 wan2）。`,
      'SD-WAN 規則 2「其他上網」：目的 any，方式手動，順序 wan1 → wan2。沒有這條的話，一般上網會依來源位址分散到兩條線路。',
    ],
    solve(s) {
      const d = dev(s, 'fg');
      d.policies[0].dstIf = 'virtual-wan-link';
      d.sdwan = newSdwan();
      d.sdwan.members.push({ seq: 1, iface: 'wan1', gw: W1.gw }, { seq: 2, iface: 'wan2', gw: W2.gw });
      d.sdwan.rules.push({ name: 'VoIP', dst: SIP, proto: 'udp', port: '', mode: 'sla', prio: [1, 2] }, { name: '其他上網', dst: 'any', proto: 'any', port: '', mode: 'manual', prio: [1, 2] });
    },
    recap: ['SD-WAN 把好幾條線路合成一個區域，持續量每條線路的延遲、抖動、遺失（效能 SLA），再依 SD-WAN 規則替不同的流量挑線路。', '電話用 SLA 模式：線路品質不合格就自動改走另一條；政策的目的介面要寫 virtual-wan-link。'],
  },
];
