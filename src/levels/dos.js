// 第六章補充：SYN flood 與 FortiGate 的 DoS 政策（進來的介面、pass 與 block、門檻）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { anomalyOf } from '../engine/dos.js';
import { dev, WEB } from './util.js';

const PPS = 12000, PEAK = 300;
const synOf = (s) => (dev(s, 'fw').dos || []).map((p) => ({ p, a: anomalyOf(p, 'tcp_syn_flood') }));

export const LEVELS95 = [
  {
    id: 'l179', chapter: 6, title: '網站沒有壞，卻沒有人連得上', subtitle: 'SYN flood 與 FortiGate 的 DoS 政策', tags: ['DoS', 'SYN flood', 'DoS 政策', 'FortiGate', 'DMZ'],
    brief: '週年慶第一天，對外網站突然打不開。伺服器的 CPU 不高、網站程式沒有當掉，可是公司內外都連不上。防火牆上有一條前任留下的 DoS 政策，看起來沒有發揮作用。請讓網站恢復服務，而且不能把正常的客人一起擋掉。',
    given: [
      ['對外網站', 'https://203.0.113.18 → DMZ 的 172.16.1.10'], ['WAN1', '203.0.113.18/29'], ['正常的尖峰', `每秒大約 ${PEAK} 個新連線`],
      ['現有的 DoS 政策', '編號 1（protect-web）'], ['看現況', 'CLI：diagnose ips anomaly list'],
    ],
    learn: [
      { t: 'SYN flood', d: '攻擊者送出大量 SYN 卻不完成三向交握。伺服器替每一個半開的連線保留一格佇列，等一個永遠不會來的 ACK；佇列滿了，正常的 SYN 就排不進去。網站本身沒有壞，只是「敲門的人太多」。' },
      { t: 'DoS 政策看的是進來的介面', d: 'FortiGate 的 DoS 政策在一般的防火牆政策之前檢查，條件是「從哪個介面進來」。要擋網際網路來的洪水，就要掛在 wan1；掛在伺服器所在的 dmz 介面，量到的是伺服器往外送的流量。' },
      { t: 'pass 與 block', d: '每一種異常（tcp_syn_flood、udp_flood、icmp_flood…）各自有開關、門檻與動作。動作的預設值是 pass：超過門檻只記錄、不丟封包，常被誤以為已經在防護。要改成 block 才會丟掉。' },
      { t: '門檻', d: '每秒送往同一個目的位址的封包數。設得比正常的尖峰高、比攻擊的量低：太低會把活動當天的客人擋在外面，太高等於沒設。先用 pass 觀察幾天再改成 block 是常見的做法。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' }),
        D('fg60f', 'fw', {
          name: 'Firewall', pos: [0, -4.4],
          init(d) {
            const g = (id) => d.ifaces.find((i) => i.id === id);
            Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
            Object.assign(g('wan2'), { ping: false });
            Object.assign(g('dmz'), { ip: '172.16.1.1', mask: '255.255.255.0' });
            Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
            Object.assign(g('internal').dhcp, { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '8.8.8.8' });
            d.policies.push(
              { name: 'LAN 上網', srcIf: 'internal', dstIf: 'wan1', src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: true },
              { name: 'LAN 到 DMZ', srcIf: 'internal', dstIf: 'dmz', src: 'any', dst: 'any', service: 'HTTPS', action: 'accept', nat: false },
              { name: '對外網站', srcIf: 'wan1', dstIf: 'dmz', src: 'any', dst: '172.16.1.10', service: 'HTTPS', action: 'accept', nat: false },
            );
            d.portForwards.push({ proto: 'tcp', port: 443, toIp: '172.16.1.10', toPort: 443 });
            // 前任留下的：掛錯介面（dmz），動作也是預設的 pass
            d.dos = [{ id: 1, name: 'protect-web', iface: 'dmz', on: true, anomaly: { tcp_syn_flood: { on: true, action: 'pass', threshold: 2000 } } }];
          },
        }),
        D('sw8', 'sw', { name: 'LAN Switch', pos: [-5.5, 0] }),
        D('pc', 'pc-1', { name: 'PC-1', pos: [-8.5, 4.4], dhcp: true }),
        D('pc', 'pc-2', { name: 'PC-2', pos: [-3, 4.8], dhcp: true }),
        D('tower', 'web', { name: 'Web 伺服器', pos: [6, 0.6], ip: '172.16.1.10', gw: '172.16.1.1', dns: '8.8.8.8', services: WEB }),
      ], [['inet:line1', 'fw:wan1'], ['fw:1', 'sw:1'], ['pc-1:eth0', 'sw:2'], ['pc-2:eth0', 'sw:3'], ['fw:dmz', 'web:eth0']]);
      s.attacks = [{ id: 'botnet', from: 'inet', ip: '203.0.113.18', port: 443, kind: 'syn', pps: PPS, on: true, label: '殭屍網路' }];
      s.notes = [{ at: 'inet', text: `殭屍網路：SYN flood → 203.0.113.18:443，每秒 ${PPS.toLocaleString('en-US')} 個` }];
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'inet', ip: '203.0.113.18', port: 443, label: '外面的客人可以打開 https://203.0.113.18' },
      { type: 'tcp', from: 'pc-1', to: 'web', port: 443, label: '公司裡也連得到網站（PC-1 → Web 伺服器）' },
      {
        type: 'check', label: 'SYN flood 一進 wan1 就被 DoS 政策丟掉',
        test(s) {
          const e = ((s.rt.dos || {}).list || [])[0];
          if (!e) return '攻擊還沒有被偵測到';
          if (e.stop && e.stop.dev === 'fw') return true;
          const at = e.seen.filter((x) => x.dev === 'fw' && x.policy);
          if (!at.length) return '攻擊從 wan1 進來，但是 wan1 上沒有 DoS 政策（DoS 政策看的是進來的介面）';
          const x = at[0];
          if (!x.on) return `DoS 政策 ${x.policy} 的 tcp_syn_flood 沒有啟用（status disable）`;
          if (!x.over) return `DoS 政策 ${x.policy} 的門檻是 ${x.threshold}，比攻擊的量（每秒 ${e.pps}）還高，不會觸發`;
          return `DoS 政策 ${x.policy} 偵測到了 SYN flood，但動作是 pass：只記錄，封包照樣放行`;
        },
      },
      {
        type: 'check', label: `門檻比正常的尖峰（每秒 ${PEAK}）高，不會誤擋客人`,
        test(s) {
          const on = synOf(s).filter((x) => x.p.on !== false && x.p.iface === 'wan1' && x.a.on && x.a.action === 'block');
          const low = on.find((x) => +x.a.threshold <= PEAK);
          return low ? `DoS 政策 ${low.p.id} 的門檻只有 ${low.a.threshold}：比正常的尖峰還低，活動一開始就會把客人擋在外面` : true;
        },
      },
    ],
    hints: [
      '點防火牆 →「CLI」輸入 diagnose ips anomaly list：DoS 政策 1 量到的 pps 是 0。再看「安全設定檔」分頁最下面的 DoS 政策：它掛在 dmz 介面，可是攻擊是從 wan1 進來的。',
      '把 DoS 政策的介面改成 wan1。「紀錄」分頁會出現 anomaly: tcp_syn_flood … detected，但網站還是不通：動作是 pass，只記錄不丟。',
      'tcp_syn_flood 的動作改成 block。門檻維持 2000：比正常的尖峰 300 高、比攻擊的 12000 低。',
    ],
    solve(s) {
      const p = dev(s, 'fw').dos[0];
      p.iface = 'wan1';
      p.anomaly.tcp_syn_flood = { on: true, action: 'block', threshold: 2000 };
    },
    recap: ['DoS 政策掛在攻擊進來的介面，動作要是 block 才會丟封包；門檻設在正常尖峰與攻擊量之間。', '防火牆擋得住耗盡連線的攻擊，擋不住把線路灌滿的流量：那要靠電信業者或清洗服務在上游處理。'],
  },
];
