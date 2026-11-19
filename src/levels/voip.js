// 第十二章：語音與 QoS。IP 電話的 PoE、語音 VLAN、CDP / LLDP-MED、DHCP option 150、CUCM 註冊；
// 線路塞車時用 QoS 保住通話品質（信任邊界、LLQ、配合營運商合約頻寬的整形）。
// 另外補一關到第六章：用 DTP 偽裝成交換器的 VLAN hopping，以及邊緣埠的加固
import { makeDevice as D, makeState, newIface, removeCable } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { iosSession } from '../engine/ios.js';
import { phoneState, callQuality } from '../engine/voice.js';
import { egressOf, dscpName } from '../engine/qos.js';
import { cdpOn } from '../engine/disc.js';
import { parseIp, netOf } from '../engine/ip.js';
import { dev, link } from './util.js';

export const CHAPTERS6 = [
  { id: 12, title: '語音與 QoS', desc: 'IP 電話的供電、語音 VLAN 與註冊；線路塞車的時候，用 QoS 讓通話保持清楚。' },
];

const sub = (d, port, vlan, ip, extra = {}) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0', ...extra }));
/** 子介面上的 DHCP 位址池 */
const pool = (d, id, name, start, end, extra = {}) => { Object.assign(d.ifaces.find((i) => i.id === id).dhcp, { on: true, pool: name, start, end, dns: '', gw: '', ...extra }); };
const typeIn = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); for (const l of lines) sess.exec(l); };
const SERVICES_CUCM = [{ proto: 'udp', port: 69, name: 'TFTP' }, { proto: 'udp', port: 5060, name: 'SIP' }];
const access = (d, ports, vlan) => { for (const p of ports) Object.assign(d.sw.ports[p], { mode: 'access', vlan }); };
const inNet = (ip, cidr) => { const [n, b] = cidr.split('/'); return ip != null && netOf(ip, +b) === parseIp(n); };

export const LEVELS6 = [
  // ─────────────────────────────────────────────── 12-1
  {
    id: 'l44', chapter: 12, title: '電話接上了，然後呢？', subtitle: 'PoE、語音 VLAN、CDP / LLDP-MED、option 150', tags: ['IP 電話', 'Voice VLAN', 'PoE', 'LLDP-MED', 'DHCP option 150'],
    brief: '二樓換了新的 IP 電話：業務那支是 Cisco 8841，會議室那支是 Yealink T54W。裝好之後一支完全沒反應，另一支停在「正在下載設定」。電話要在語音 VLAN 110，接在電話後面的電腦要留在資料 VLAN 10。請讓兩支電話都註冊上 CUCM，而且互相打得通。',
    given: [
      ['資料 VLAN', '10 · 10.10.10.0/24'], ['語音 VLAN', '110 · 10.10.110.0/24'], ['伺服器 VLAN', '100 · CUCM 10.10.100.10'],
      ['SW-2F', 'Catalyst 2960-CX-8PC-L：只有 Gi0/1 – Gi0/8 有 PoE'], ['會議室電話', 'Yealink，不支援 CDP，只認 LLDP-MED'],
    ],
    learn: [
      { t: 'PoE', d: 'IP 電話靠網路線供電 (802.3af / at)。交換器只有部分的埠有 PoE，而且有總預算：Cisco 先依等級保留上限（Class 2 是 7 W、Class 3 是 15.4 W），和 Cisco 電話用 CDP 協商之後才改成實際用量。' },
      { t: '語音 VLAN', d: '電話裡面有一台小交換器：電腦的流量不帶標籤，留在 Access VLAN；電話自己的語音帶著語音 VLAN 的標籤。交換器的埠設 switchport voice vlan 110，兩種流量就分開了。' },
      { t: '電話怎麼知道語音 VLAN 是幾號', d: 'Cisco 電話從交換器的 CDP 學到（Appliance VLAN）；其他廠牌的電話只認 LLDP-MED 的 Network Policy，交換器要 lldp run 才會送。兩種都沒有，電話就和電腦一樣待在資料 VLAN。' },
      { t: 'option 150', d: '電話拿到位址之後，要去 TFTP 伺服器下載自己的設定檔，才知道要向哪一台 CUCM 註冊。TFTP 伺服器的位址就是 DHCP 的 option 150（Cisco）或 option 66。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -7.5],
          init(d) {
            sub(d, 'Gi0/0/1', 10, '10.10.10.1'); sub(d, 'Gi0/0/1', 100, '10.10.100.1'); sub(d, 'Gi0/0/1', 110, '10.10.110.1');
            pool(d, 'Gi0/0/1.10', 'DATA', '10.10.10.100', '10.10.10.199');
            pool(d, 'Gi0/0/1.110', 'VOICE', '10.10.110.100', '10.10.110.199'); // 少了 option 150
          },
        }),
        D('c2960p', 'sw', {
          name: 'SW-2F', pos: [0, -2.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'DATA' }, { id: 100, name: 'SERVERS' }, { id: 110, name: 'VOICE' });
            access(d, ['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4', 'Gi0/10'], 10);
            access(d, ['Gi0/7'], 100);
            d.sw.ports['Gi0/9'].mode = 'trunk';
          },
        }),
        D('tower', 'cucm', { name: 'CUCM', pos: [8.5, -2], ip: '10.10.100.10', gw: '10.10.100.1', services: SERVICES_CUCM }),
        D('ipphone', 'ph-a', { name: '業務電話', pos: [-6.5, 2.8] }),
        D('pc', 'pc-a', { name: '業務 PC', pos: [-8.5, 6.5], dhcp: true }),
        D('t54w', 'ph-b', { name: '會議室電話', pos: [3.5, 4] }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['cucm:eth0', 'sw:Gi0/7'], ['ph-a:sw', 'sw:Gi0/10'], ['pc-a:eth0', 'ph-a:pc'], ['ph-b:sw', 'sw:Gi0/2']]);
      s.devices.cucm.cucm = { autoReg: true, first: 2001, phones: [] };
      return s;
    },
    objectives: [
      { type: 'phone', dev: 'ph-a', label: '業務電話已經向 CUCM 註冊' },
      { type: 'phone', dev: 'ph-b', label: '會議室電話已經向 CUCM 註冊' },
      {
        type: 'check', label: '兩支電話在語音 VLAN 110，業務 PC 留在資料 VLAN 10',
        test(s) {
          for (const id of ['ph-a', 'ph-b']) {
            const d = dev(s, id), v = d.rt && d.rt.voice;
            if (!v || v.vlan !== 110) return `${d.name} 不在語音 VLAN：${v ? `它在 VLAN ${v.vlan}` : '它沒有學到語音 VLAN（交換器的埠沒有 voice vlan，或電話和交換器之間沒有 CDP / LLDP-MED）'}`;
            if (!inNet(d.ifaces[0].rt.ip, '10.10.110.0/24')) return `${d.name} 的位址不是語音網段 10.10.110.0/24 的`;
          }
          const ip = dev(s, 'pc-a').ifaces[0].rt.ip;
          return inNet(ip, '10.10.10.0/24') ? true : '業務 PC 沒有拿到資料 VLAN 10 的位址';
        },
      },
      { type: 'ping', from: 'pc-a', ip: '10.10.100.10', label: '接在電話後面的業務 PC 照樣連得到伺服器網段' },
      { type: 'call', from: 'ph-a', to: 'ph-b', mos: 4.0, label: '業務電話打到會議室，通話品質良好（MOS ≥ 4.0）' },
    ],
    hints: [
      '業務電話接在 Gi0/10，可是 SW-2F 只有 Gi0/1 – Gi0/8 有 PoE：把電話那條線改插到 Gi0/1（接在電話後面的電腦也會跟著恢復）。',
      'SW-2F 上 interface range gi0/1 - 2 → switchport voice vlan 110。Cisco 電話從 CDP 學到語音 VLAN；Yealink 只認 LLDP-MED，要再下 lldp run。',
      '電話拿到語音網段的位址後，還要知道 TFTP 伺服器：R1 → ip dhcp pool VOICE → option 150 ip 10.10.100.10。',
    ],
    solve(s) {
      const c = s.cables.find((x) => (x.a.dev === 'ph-a' && x.a.port === 'sw') || (x.b.dev === 'ph-a' && x.b.port === 'sw'));
      removeCable(s, c.id);
      link(s, 'ph-a:sw', 'sw:Gi0/1');
      recompute(s);
      typeIn(s, 'sw', ['configure terminal', 'lldp run', 'interface range gi0/1 - 2', 'switchport voice vlan 110', 'end', 'write memory']);
      typeIn(s, 'rt', ['configure terminal', 'ip dhcp pool VOICE', 'option 150 ip 10.10.100.10', 'end', 'write memory']);
    },
    recap: ['IP 電話要有 PoE、要知道語音 VLAN（CDP 或 LLDP-MED）、要從 option 150 找到 TFTP 伺服器，才註冊得了。', '語音 VLAN 讓電話和後面的電腦共用一條線，卻待在不同的網段。'],
  },

  // ─────────────────────────────────────────────── 12-2
  {
    id: 'l45', chapter: 12, title: '語音斷斷續續', subtitle: '信任邊界、LLQ 與配合合約頻寬的整形', tags: ['QoS', 'LLQ', 'Shaping', 'DSCP', 'mls qos'],
    brief: '每天下午分公司開始備份，跟總公司講電話就斷斷續續。分公司和總公司之間是電信業者的 Metro Ethernet：實體是 1 Gbps，合約只有 20 Mbps。請在不停掉備份的前提下，讓電話恢復清楚。',
    given: [
      ['WAN', 'BR-RT Gi0/0/0 ↔ HQ-RT Gi0/0/0 · Metro Ethernet 合約 20 Mbps'], ['分公司', '資料 10.20.10.0/24 · 語音 10.20.110.0/24'],
      ['總公司', '伺服器 10.10.100.0/24（CUCM .10、檔案伺服器 .20）· 語音 10.10.110.0/24'], ['正在跑的', '分公司 PC 往檔案伺服器的三個備份工作，以及一通分公司 ↔ 總公司的電話'],
    ],
    learn: [
      { t: '壅塞只發生在出口', d: '流量從快的地方進到慢的地方時，送不完的封包在出口排隊。TCP 會把佇列塞滿：同一個佇列裡的語音得跟著排隊（延遲、抖動），佇列滿了就被丟（斷斷續續）。' },
      { t: 'LLQ', d: '把語音分出來 (class-map match dscp ef)，在 policy-map 裡給它 priority：語音永遠先送，不用排在大量傳輸後面。其他流量用 fair-queue 或 bandwidth 分剩下的頻寬。' },
      { t: '合約頻寬與整形', d: '實體 1 Gbps 的線，自己的出口永遠不會塞車；超過合約的部分是在營運商那端被丟掉 (policing)，語音也一起被丟。要在自己這端 shape average 到合約頻寬，佇列才會在自己手上，LLQ 才有作用（parent 做 shape、child 做 LLQ）。' },
      { t: '信任邊界', d: '電話把語音標成 DSCP EF、CoS 5。交換器開了 mls qos，沒有設定 trust 的埠會把標記全部歸零；只信任 CoS 的話，預設的對照表會把 CoS 5 變成 40 而不是 EF。auto qos voip cisco-phone 會一次設好。' },
    ],
    setup() {
      const s = makeState([
        D('c2960p', 'bsw', {
          name: 'BR-SW', pos: [-11, 1.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'DATA' }, { id: 110, name: 'VOICE' });
            access(d, ['Gi0/1', 'Gi0/2'], 10); d.sw.ports['Gi0/1'].voice = 110;
            d.sw.ports['Gi0/9'].mode = 'trunk';
            d.sw.qos = { on: true }; // 前任管理員開了 mls qos，卻沒有設定信任
          },
        }),
        D('isr4321', 'brt', {
          name: 'BR-RT', pos: [-5, -4],
          init(d) {
            sub(d, 'Gi0/0/1', 10, '10.20.10.1'); sub(d, 'Gi0/0/1', 110, '10.20.110.1');
            pool(d, 'Gi0/0/1.10', 'DATA', '10.20.10.100', '10.20.10.199');
            pool(d, 'Gi0/0/1.110', 'VOICE', '10.20.110.100', '10.20.110.199', { tftp: '10.10.100.10' });
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ip: '10.255.0.1', mask: '255.255.255.252' });
            d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.255.0.2' });
          },
        }),
        D('isr4321', 'hrt', {
          name: 'HQ-RT', pos: [5, -4],
          init(d) {
            sub(d, 'Gi0/0/1', 100, '10.10.100.1'); sub(d, 'Gi0/0/1', 110, '10.10.110.1');
            pool(d, 'Gi0/0/1.110', 'VOICE', '10.10.110.100', '10.10.110.199', { tftp: '10.10.100.10' });
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ip: '10.255.0.2', mask: '255.255.255.252' });
            d.routes.push({ dst: '10.20.0.0', mask: '255.255.0.0', via: '10.255.0.1' });
          },
        }),
        D('c2960p', 'hsw', {
          name: 'HQ-SW', pos: [11, 1.5],
          init(d) {
            d.sw.vlans.push({ id: 100, name: 'SERVERS' }, { id: 110, name: 'VOICE' });
            access(d, ['Gi0/5', 'Gi0/6'], 100);
            access(d, ['Gi0/1'], 100); d.sw.ports['Gi0/1'].voice = 110;
            d.sw.ports['Gi0/9'].mode = 'trunk';
          },
        }),
        D('ipphone', 'ph-br', { name: '分公司電話', pos: [-14, 5.5] }),
        D('pc', 'pc-br', { name: '分公司 PC', pos: [-15.5, 9], dhcp: true }),
        D('ipphone', 'ph-hq', { name: '總公司電話', pos: [9, 6] }),
        D('tower', 'cucm', { name: 'CUCM', pos: [14, 5], ip: '10.10.100.10', gw: '10.10.100.1', services: SERVICES_CUCM }),
        D('tower', 'fs', { name: '檔案伺服器', pos: [15.5, 0.5], ip: '10.10.100.20', gw: '10.10.100.1', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
      ], [['ph-br:sw', 'bsw:Gi0/1'], ['pc-br:eth0', 'ph-br:pc'], ['bsw:Gi0/9', 'brt:Gi0/0/1'], ['brt:Gi0/0/0', 'hrt:Gi0/0/0'], ['hrt:Gi0/0/1', 'hsw:Gi0/9'],
        ['ph-hq:sw', 'hsw:Gi0/1'], ['cucm:eth0', 'hsw:Gi0/5'], ['fs:eth0', 'hsw:Gi0/6']]);
      s.cables.find((c) => [c.a.dev, c.b.dev].sort().join() === 'brt,hrt').cir = 20;
      s.devices.cucm.cucm = { autoReg: true, first: 2001, phones: [] };
      s.flows = [1, 2, 3].map((n) => ({ id: 'bk' + n, from: 'pc-br', ip: '10.10.100.20', port: 445, mbps: 300, label: `備份工作 ${n}` }));
      s.calls = [{ id: 'call1', a: 'ph-br', b: 'ph-hq', label: '分公司 ↔ 總公司' }];
      return s;
    },
    objectives: [
      { type: 'call', from: 'ph-br', to: 'ph-hq', mos: 4.0, label: '備份在跑的時候，分公司和總公司的通話清楚（MOS ≥ 4.0）' },
      {
        type: 'check', label: '分公司送往總公司的量不超過合約頻寬（不會被營運商丟掉）',
        test(s) {
          const l = s.rt.links['brt:Gi0/0/0'];
          if (!l) return 'BR-RT 的 Gi0/0/0 沒有連線';
          const eg = egressOf(s, { cable: l.cable, from: 'brt', fromPort: 'Gi0/0/0', to: l.dev, toPort: l.port, tag: null });
          if (!eg.shape) return 'BR-RT 的 Gi0/0/0 用 1 Gbps 的速度往外送，超過 20 Mbps 的部分在營運商那端被管制丟掉：要在 Gi0/0/0 的輸出政策裡 shape average 20000000';
          return eg.shape <= eg.cir ? true : `整形到 ${eg.shape} Mbps，還是超過合約的 ${eg.cir} Mbps`;
        },
      },
      {
        type: 'check', label: '語音封包到 BR-RT 時還是 EF（信任邊界設對了）',
        test(s) {
          const q = callQuality(s, 'ph-br', 'ph-hq');
          if (!q.ok) return q.why;
          const h = q.ab.hops.find((x) => x.from === 'brt');
          if (!h) return '語音沒有經過 BR-RT';
          if (h.dscp === 46) return true;
          return `語音到 BR-RT 時的 DSCP 是 ${dscpName(h.dscp)} (${h.dscp})，路由器的 class-map 認不出它是語音：${q.ab.why.find((w) => w.includes('BR-SW')) || 'BR-SW 改掉了電話的標記'}`;
        },
      },
      {
        type: 'check', label: '備份照樣在跑（總共至少 12 Mbps）',
        test(s) {
          const sum = (s.flows || []).reduce((a, f) => a + (f.on === false ? 0 : (f.rt && f.rt.mbps) || 0), 0);
          return sum >= 12 ? true : `備份總共只剩 ${Math.round(sum * 10) / 10} Mbps：QoS 是讓語音先走，不是把備份停掉`;
        },
      },
    ],
    hints: [
      '先找出塞車的地方：BR-RT 的 Gi0/0/0 實體是 1 Gbps，可是營運商只收 20 Mbps。超過的在對方那端被丟，語音也一起被丟。',
      'BR-RT：class-map match-any VOICE / match dscp ef；policy-map VOICE-PRI → class VOICE → priority percent 30，class class-default → fair-queue；policy-map WAN-OUT → class class-default → shape average 20000000 → service-policy VOICE-PRI；interface gi0/0/0 → service-policy output WAN-OUT。（QoS 分頁的「快速建立」做的是同一件事）',
      'BR-SW 開了 mls qos 卻沒有 trust，電話的 EF 在進交換器時就被改成 0：interface gi0/1 → auto qos voip cisco-phone。只下 mls qos trust cos 不夠：預設 CoS 5 會變成 DSCP 40。',
    ],
    solve(s) {
      typeIn(s, 'bsw', ['configure terminal', 'interface gi0/1', 'auto qos voip cisco-phone', 'end', 'write memory']);
      typeIn(s, 'brt', ['configure terminal', 'class-map match-any VOICE', 'match dscp ef', 'policy-map VOICE-PRI', 'class VOICE', 'priority percent 30', 'class class-default', 'fair-queue',
        'policy-map WAN-OUT', 'class class-default', 'shape average 20000000', 'service-policy VOICE-PRI', 'interface gi0/0/0', 'service-policy output WAN-OUT', 'end', 'write memory']);
    },
    recap: ['塞車只發生在出口：語音要分出來放進 priority 佇列 (LLQ)。', '合約頻寬比實體線路小時，要在自己這端 shape，佇列才在自己手上。', '信任邊界要設在電話：交換器開了 mls qos 卻不信任，標記就沒了。'],
  },

  // ─────────────────────────────────────────────── 6-8（補進第六章）
  {
    id: 'l46', chapter: 6, title: '偽裝成交換器', subtitle: 'DTP 與 VLAN hopping、邊緣埠加固', tags: ['DTP', 'VLAN hopping', 'CDP', '加固'],
    brief: '稽核發現三樓的訪客座位上有一台來路不明的筆電，它居然直接連到了伺服器 VLAN 的資料庫，完全繞過 R1 上的 ACL。查出它是怎麼做到的，把三樓交換器接電腦的埠加固好；同事用網頁存取資料庫的功能不能受影響。',
    given: [
      ['使用者', 'VLAN 10 · 10.30.10.0/24'], ['伺服器', 'VLAN 20 · 資料庫 10.30.20.10（HTTPS 443、MySQL 3306）'],
      ['R1 的 ACL', '使用者只能用 HTTPS 連資料庫，MySQL 3306 一律擋掉'], ['可疑的筆電', 'SW-3F Gi0/5'],
    ],
    learn: [
      { t: 'DTP', d: 'Catalyst 的埠出廠是 dynamic auto：只要對面送 DTP 要求 (desirable)，就會自動變成 Trunk。Yersinia 這類工具可以讓一台筆電假裝成交換器。' },
      { t: 'VLAN hopping', d: '變成 Trunk 之後，攻擊者只要送帶著 VLAN 20 標籤的訊框，就直接進了伺服器 VLAN，路由器上的 ACL 根本管不到（流量沒有經過路由器）。另一種手法是雙重標籤 (double tagging)，利用的是 Native VLAN。' },
      { t: '邊緣埠加固', d: '接電腦的埠：switchport mode access（不會被協商成 Trunk），再加 switchport nonegotiate（連 DTP 都不送）。沒用的埠 shutdown，Native VLAN 改成沒人用的 VLAN。' },
      { t: 'CDP 也會洩漏資訊', d: 'CDP 每分鐘把交換器的名稱、型號、IOS 版本、管理 IP 送到每個埠，攻擊者用 Wireshark 就看得到。接使用者的埠要 no cdp enable；交換器、路由器之間的上行埠可以保留，方便維運。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -7],
          init(d) {
            sub(d, 'Gi0/0/1', 10, '10.30.10.1', { aclIn: [
              { action: 'permit', proto: 'tcp', src: 'any', dst: '10.30.20.10', port: '443' },
              { action: 'deny', proto: 'ip', src: 'any', dst: '10.30.20.0/24', port: '' },
              { action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: '' },
            ], aclNames: { in: 'USERS-IN' } });
            sub(d, 'Gi0/0/1', 20, '10.30.20.1');
          },
        }),
        D('c2960', 'sw', {
          name: 'SW-3F', pos: [0, -2],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'USERS' }, { id: 20, name: 'SERVERS' });
            // 前任管理員只改了 VLAN，模式維持出廠的 dynamic auto
            for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/5']) d.sw.ports[p].vlan = 10;
            d.sw.ports['Gi0/11'].vlan = 20; // 資料庫伺服器的網卡是 SFP，接在交換器的 SFP 埠
            d.sw.ports['Gi0/9'].mode = 'trunk';
          },
        }),
        D('pc', 'pc1', { name: '同事 A', pos: [-8, 3], ip: '10.30.10.11', gw: '10.30.10.1' }),
        D('pc', 'pc2', { name: '同事 B', pos: [-4, 5], ip: '10.30.10.12', gw: '10.30.10.1' }),
        D('laptop', 'atk', {
          name: '來路不明的筆電', pos: [3, 5.5], ip: '10.30.10.66', gw: '10.30.10.1',
          init(d) {
            d.dtp = 'desirable'; // Yersinia：送 DTP desirable，假裝成交換器
            d.ifaces.push(newIface('eth0.20', 'eth0.20', { t: 'sub', port: 'eth0', vlan: 20 }, { ip: '10.30.20.66', mask: '255.255.255.0' }));
          },
        }),
        D('rack1u', 'db', { name: '資料庫伺服器', pos: [9, 2], ip: '10.30.20.10', gw: '10.30.20.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS 網頁介面' }, { proto: 'tcp', port: 3306, name: 'MySQL' }] }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['pc1:eth0', 'sw:Gi0/1'], ['pc2:eth0', 'sw:Gi0/2'], ['atk:eth0', 'sw:Gi0/5'], ['db:eth0', 'sw:Gi0/11']]);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'atk', to: 'db', port: 3306, expect: false, label: '可疑的筆電連不到資料庫的 MySQL (3306)' },
      { type: 'tcp', from: 'pc1', to: 'db', port: 443, label: '同事照樣能用資料庫的網頁介面 (HTTPS)' },
      {
        type: 'check', label: '接電腦的埠都明確設成 Access，而且不送 DTP',
        test(s) {
          const sw = dev(s, 'sw');
          for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/5']) {
            const pc = sw.sw.ports[p];
            if (pc.mode !== 'access') return `${p} 還是 ${pc.mode === 'trunk' ? 'trunk' : pc.mode.replace('-', ' ')}：接電腦的埠要 switchport mode access`;
            if (!pc.noneg) return `${p} 還會送 DTP：加上 switchport nonegotiate`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '接電腦的埠不送 CDP，上行到 R1 的 Gi0/9 保留 CDP',
        test(s) {
          const sw = dev(s, 'sw');
          for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/5', 'Gi0/11']) if (cdpOn(sw, p)) return `${p} 還在送 CDP：交換器的型號、IOS 版本、管理 IP 對面都看得到（no cdp enable）`;
          return cdpOn(sw, 'Gi0/9') ? true : '連 Gi0/9（往 R1 的上行）的 CDP 也關掉了：上行埠保留 CDP，維運時才看得到鄰居';
        },
      },
    ],
    hints: [
      '看 SW-3F 的 Gi0/5：show interfaces gi0/5 switchport，Operational Mode 是 trunk —— 筆電用 DTP 把它協商成了 Trunk，再送帶著 VLAN 20 標籤的訊框。',
      'interface range gi0/1 - 2 , gi0/5 , gi0/11 → switchport mode access → switchport nonegotiate。',
      '同一個範圍再下 no cdp enable；Gi0/9 不要動。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['configure terminal', 'interface range gi0/1 - 2 , gi0/5 , gi0/11', 'switchport mode access', 'switchport nonegotiate', 'no cdp enable', 'end', 'write memory']);
    },
    recap: ['接電腦的埠一律 switchport mode access + nonegotiate，不讓任何設備協商出 Trunk。', 'ACL 只管得到經過路由器的流量；第二層被突破，ACL 就形同虛設。', '使用者的埠不送 CDP，避免把設備資訊送給任何人。'],
  },
];
void phoneState;
