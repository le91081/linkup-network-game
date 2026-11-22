// 第八章補充：FortiGate 的 HA（Active-Passive 叢集）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { fortiSession } from '../engine/fortios.js';
import { recompute } from '../engine/sim.js';
import { serialOf } from '../engine/ha.js';
import { dev } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const WEB = '93.184.216.34', RDP = '198.51.100.20';
const typeFg = (s, id, lines) => { const F = fortiSession(() => s.devices[id], () => s); for (const l of lines) F.exec(l); };
const haCli = (prio) => ['config system ha', 'set group-name "FGT-HA"', 'set mode a-p', 'set password "Ha-Secret-42"', 'set hbdev "dmz" 50', 'set session-pickup enable', `set priority ${prio}`, 'set monitor "wan1" "internal"', 'end'];

export const LEVELS41 = [
  // ════════════════════════ 8-10 ════════════════════════
  {
    id: 'l121', chapter: 8, title: '防火牆一壞，全公司就斷網', subtitle: 'FortiGate HA：Active-Passive 叢集', tags: ['HA', 'FGCP', 'FortiGate', '高可用', 'session-pickup'],
    brief: `上個月唯一的那台 FortiGate 電源壞掉，全公司斷網半天。公司買了第二台同型號的 FortiGate (FG-B)，已經上架、接好 WAN 與 LAN，兩台的 DMZ 也用一條線對接了。請把兩台組成 HA（Active-Passive）：原本那台 FG-A 當主要機、設定不能被新機器蓋掉；FG-A 的 wan1 斷線或整台故障時，FG-B 要自動接手，進行中的遠端桌面連線也不能斷。`,
    given: [
      ['FG-A（現役）', 'wan1 203.0.113.34/30 · 閘道 203.0.113.33 · internal 192.168.1.1/24 · 政策「上網」'], ['FG-B（新機器）', '原廠設定（internal 192.168.1.99/24），同型號、同版本'],
      ['Heartbeat 線', '兩台的 DMZ 對接'], ['HA 群組', '名稱 FGT-HA · 密碼 Ha-Secret-42 · 模式 Active-Passive'],
      ['遠端桌面', `雲端主機 ${RDP}（TCP 3389）`], ['電腦', '192.168.1.21、192.168.1.22 · 閘道 192.168.1.1'],
    ],
    learn: [
      { t: 'FGCP 與 Active-Passive', d: '兩台同型號、同版本的 FortiGate 用 heartbeat 線交換狀態，群組名稱、群組 ID、密碼都一樣就組成叢集。Active-Passive：只有主要機 (primary) 處理流量，次要機 (secondary) 待命；兩台共用同一組 IP，主要機的介面用虛擬 MAC，換手之後電腦不必重新 ARP。' },
      { t: '誰當主要機', d: 'override disable（預設）時依序比：監控的介面 (monitor) 正常的數量 → HA uptime → priority → 序號。uptime 排在 priority 前面，所以主要機恢復之後「不會」把角色搶回去；要搶回去就 set override enable。' },
      { t: '設定同步', d: '叢集組成之後，主要機把整份設定同步給次要機（priority、override、主機名稱除外）。新機器如果先當上主要機，它的空白設定會把現役那台蓋掉 — 加入新機器之前先讓現役那台的 priority 比較高。' },
      { t: '監控介面與 session-pickup', d: 'set monitor "wan1" "internal"：主要機監控的介面斷線時改由另一台當主要機；沒有監控的話，主要機只要還活著就不會換手（wan1 斷了也一樣）。set session-pickup enable 把連線表同步給次要機，換手之後進行中的連線照常；沒開的話 TCP 連線都要重連。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -10], ports: [{ id: 'line1', label: '線路 1', media: 'rj45' }] });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34' });
      inet.inet.hosts.push({ ip: RDP, name: '雲端主機（遠端桌面）', services: [{ proto: 'tcp', port: 3389 }] });
      return makeState([
        inet,
        D('sw8', 'swwan', { name: 'WAN 交換器', pos: [0, -6] }),
        D('fg60f', 'fga', {
          name: 'FG-A', pos: [-4, -2],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33' });
            Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
            d.policies.push(allow('上網', 'internal', 'wan1', { nat: true }));
          },
        }),
        D('fg60f', 'fgb', {
          name: 'FG-B', pos: [4, -2],
          init(d) { Object.assign(d.ifaces.find((i) => i.id === 'internal'), { ip: '192.168.1.99', mask: '255.255.255.0' }); },
        }),
        D('sw8', 'swlan', { name: 'LAN 交換器', pos: [0, 2] }),
        D('pc', 'pc1', { name: 'PC-1', pos: [-3, 6], ip: '192.168.1.21', gw: '192.168.1.1', dns: '8.8.8.8' }),
        D('laptop', 'pc2', { name: '筆電', pos: [3, 6], ip: '192.168.1.22', gw: '192.168.1.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'swwan:1'], ['fga:wan1', 'swwan:2'], ['fgb:wan1', 'swwan:3'], ['fga:dmz', 'fgb:dmz'],
        ['fga:1', 'swlan:1'], ['fgb:1', 'swlan:2'], ['pc1:eth0', 'swlan:3'], ['pc2:eth0', 'swlan:4']]);
    },
    objectives: [
      {
        type: 'check', label: 'FG-A 與 FG-B 組成 HA 叢集，FG-A 是主要機',
        test(s) {
          const a = dev(s, 'fga'), b = dev(s, 'fgb'), ra = a.rt.ha, rb = b.rt.ha;
          if (!ra && !rb) return 'FG-A 和 FG-B 都還沒有啟用 HA（config system ha → set mode a-p）';
          if (!ra) return 'FG-A 還沒有啟用 HA';
          if (!rb) return 'FG-B 還沒有啟用 HA';
          if (ra.role === 'standalone' || rb.role === 'standalone') return `還沒有組成叢集：${ra.why || rb.why}`;
          if (ra.role !== 'primary') return `FG-B 當上了主要機，它的設定會同步給 FG-A（原本的政策會被蓋掉）。FG-A 的 priority 要比較高；已經被蓋掉的話按 Ctrl+Z 復原`;
          return (a.policies || []).some((p) => p.name === '上網') || 'FG-A 原本的政策「上網」不見了：設定被新機器蓋掉了，按 Ctrl+Z 復原';
        },
      },
      { type: 'tcp', from: 'pc1', ip: WEB, port: 443, label: '平常照樣上網（https://www.example.com）' },
      { type: 'failover', cut: [['fga', 'wan1']], test: { type: 'tcp', from: 'pc2', ip: WEB, port: 443 }, label: 'FG-A 的 wan1 斷線：FG-B 接手，照樣上得了網' },
      { type: 'failover', down: ['fga'], test: { type: 'tcp', from: 'pc1', ip: WEB, port: 443 }, label: 'FG-A 整台故障：FG-B 接手' },
      { type: 'failover', cut: [['fga', 'wan1']], keep: { from: 'pc1', ip: RDP, port: 3389 }, label: '換手的時候，PC-1 進行中的遠端桌面連線不會斷' },
    ],
    hints: [
      'FG-A 的 CLI：config system ha → set group-name "FGT-HA" → set mode a-p → set password "Ha-Secret-42" → set hbdev "dmz" 50 → set priority 200 → end（或在「HA」分頁設定）。',
      'FG-B 一樣的群組名稱、密碼、模式與 hbdev，priority 用預設的 128（比 FG-A 低）：FG-A 才會當主要機，設定由 FG-A 同步給 FG-B。',
      '只設了群組，wan1 斷線時 FG-A 仍然是主要機：set monitor "wan1" "internal"，主要機監控的介面斷線才會換手。',
      '遠端桌面在換手之後斷掉：set session-pickup enable 把連線表同步給次要機。get system ha status 看得到誰是主要機、為什麼。',
    ],
    solve(s) {
      typeFg(s, 'fga', haCli(200));
      typeFg(s, 'fgb', haCli(128).filter((l) => !l.startsWith('set priority')));
      recompute(s);
    },
    recap: [`FGCP 的 Active-Passive：heartbeat 線對接、群組名稱 / ID / 密碼一致才組成叢集；主要機處理流量並同步設定，次要機待命（序號 ${'FGT60F…'} 用 get system ha status 看）。`, '選主要機：監控的介面 → HA uptime → priority → 序號（override enable 時 priority 在 uptime 前面）。monitor 決定 wan1 斷線會不會換手，session-pickup 決定進行中的連線會不會斷。'],
  },
];
export { serialOf };
