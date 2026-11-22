// 第六章補充：FortiGate 的應用程式控管與 IPS
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { fortiSession } from '../engine/fortios.js';
import { recompute } from '../engine/sim.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const typeFg = (s, id, lines) => { const F = fortiSession(() => s.devices[id], () => s); for (const l of lines) F.exec(l); };
const WAN = '203.0.113.34', PEER = '198.51.100.120', RELAY = '198.51.100.130';

export const LEVELS47 = [
  // ════════════════════════ 6-16 ════════════════════════
  {
    id: 'l127', chapter: 6, title: '防火牆擋得住位址，擋不住應用程式', subtitle: 'FortiGate 的應用程式控管與 IPS', tags: ['NGFW', '應用程式控管', 'IPS', 'Log4j', 'FortiGate'],
    brief: `資安稽核發現兩件事：有員工用 BitTorrent 下載、用 Tor 繞過公司的網頁過濾 — 防火牆的政策只看位址和埠，「全部放行」的上網政策攔不住；DMZ 的訂單系統（Java，用了有漏洞的 Log4j）對外開放 8080，網路上已經有人在掃 Log4Shell。請用應用程式控管封鎖點對點下載與匿名代理，用 IPS 保護訂單系統；一般上網與客戶下單照常。`,
    given: [
      ['FortiGate', 'internal 192.168.1.0/24 · dmz 172.16.1.0/24 · wan1 203.0.113.34'], ['政策 #1「上網」', 'internal → wan1，ALL，NAT'],
      ['政策 #2「訂單系統」', 'wan1 → dmz，虛擬 IP 203.0.113.34:8080 → 172.16.1.10:8080'], ['要封鎖的應用程式', 'P2P（類別 2）、Proxy（類別 6，含 Tor）'],
      ['IPS', '封鎖 high 與 critical 的攻擊（Log4Shell 是 critical，CVE-2021-44228）'],
    ],
    learn: [
      { t: '應用程式控管', d: '傳統的政策只認位址與埠：BitTorrent、Tor 這類程式會換埠、包進 HTTPS，「上網全部放行」的政策擋不住。應用程式控管 (application list) 依流量的特徵辨識是哪個應用程式，可以整個類別封鎖（P2P、Proxy、Game…）。' },
      { t: 'IPS', d: '入侵防禦 (IPS) 比對已知攻擊的特徵（例如 Log4Shell 的 ${jndi:ldap://…} 字串）：感測器 (ips sensor) 決定哪些嚴重程度直接封鎖。修補漏洞要時間，IPS 先擋下已知的攻擊（virtual patching）。' },
      { t: '掛在哪一條政策', d: '安全設定檔要掛在「流量經過的那一條政策」上：員工上網是 #1（internal → wan1），客戶連訂單系統是 #2（wan1 → dmz）。掛錯政策等於沒掛。政策要先 set utm-status enable。' },
    ],
    setup() {
      const inet = setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: WAN });
      inet.inet.hosts.push(
        { ip: PEER, name: 'BitTorrent 節點', services: [{ proto: 'tcp', port: 6881 }] },
        { ip: RELAY, name: 'Tor 中繼站', services: [{ proto: 'tcp', port: 9001 }] },
      );
      return makeState([
        inet,
        D('fg60f', 'fg', {
          name: 'FortiGate', pos: [0, -4],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: WAN, mask: '255.255.255.252', gateway: '203.0.113.33' });
            Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
            Object.assign(g('dmz'), { ip: '172.16.1.1', mask: '255.255.255.0' });
            d.policies.push(allow('上網', 'internal', 'wan1', { nat: true }), allow('訂單系統', 'wan1', 'dmz', { dst: '172.16.1.10' }));
            d.portForwards.push({ proto: 'tcp', port: 8080, toIp: '172.16.1.10', toPort: 8080 });
          },
        }),
        D('tower', 'app', { name: '訂單系統', pos: [6, 0], ip: '172.16.1.10', gw: '172.16.1.1', services: [{ proto: 'tcp', port: 8080, name: '訂單系統 (Java)' }] }),
        D('pc', 'pc1', { name: '業務 PC', pos: [-5, 1], ip: '192.168.1.21', gw: '192.168.1.1', dns: '8.8.8.8' }),
        D('laptop', 'pc2', { name: '工讀生筆電', pos: [-2, 4], ip: '192.168.1.22', gw: '192.168.1.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'fg:wan1'], ['fg:dmz', 'app:eth0'], ['pc1:eth0', 'fg:1'], ['pc2:eth0', 'fg:2']]);
    },
    objectives: [
      { type: 'tcp', from: 'pc1', name: 'www.example.com', port: 443, label: '員工照樣上網（https://www.example.com）' },
      { type: 'tcp', from: 'pc2', ip: PEER, port: 6881, expect: false, label: '工讀生筆電的 BitTorrent 被擋下' },
      { type: 'tcp', from: 'pc2', ip: RELAY, port: 9001, expect: false, label: '連 Tor 中繼站被擋下' },
      { type: 'tcp', from: 'inet', ip: WAN, port: 8080, label: `客戶照樣連得到訂單系統（${WAN}:8080）` },
      { type: 'tcp', from: 'inet', ip: WAN, port: 8080, attack: 'log4j', expect: false, label: 'Log4Shell 攻擊在進到訂單系統之前就被 IPS 擋下' },
    ],
    hints: [
      'FortiGate →「安全設定檔」分頁：新增應用程式控管清單（例如 corp-app），勾選「點對點下載（P2P）」與「代理 / 匿名網路（Proxy）」。',
      '新增 IPS 感測器（例如 protect-web），封鎖「高」與「嚴重」。',
      '「政策」分頁：#1「上網」啟用安全設定檔、選應用程式控管；#2「訂單系統」啟用安全設定檔、選 IPS 感測器。',
      'CLI：config application list → edit "corp-app" → config entries → edit 1 → set category 2 6 → set action block；config ips sensor 類似（set severity high critical）。',
    ],
    solve(s) {
      typeFg(s, 'fg', ['config application list', 'edit "corp-app"', 'config entries', 'edit 1', 'set category 2 6', 'set action block', 'next', 'end', 'next', 'end',
        'config ips sensor', 'edit "protect-web"', 'config entries', 'edit 1', 'set severity high critical', 'set action block', 'next', 'end', 'next', 'end',
        'config firewall policy', 'edit 1', 'set utm-status enable', 'set application-list "corp-app"', 'next', 'edit 2', 'set utm-status enable', 'set ips-sensor "protect-web"', 'next', 'end']);
      recompute(s);
    },
    recap: ['應用程式控管依特徵辨識應用程式、整個類別封鎖，擋得住會換埠的 P2P 與 Tor；IPS 比對攻擊特徵，在修補之前先擋下已知的攻擊。', '安全設定檔要掛在流量經過的那一條政策上，而且政策要 utm-status enable。'],
  },
];
