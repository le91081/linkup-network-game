// 第六章補充：FortiGate 的網頁過濾與 SSL 檢查（NGFW 的安全設定檔）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { fortiSession } from '../engine/fortios.js';
import { recompute } from '../engine/sim.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const typeFg = (s, id, lines) => { const F = fortiSession(() => s.devices[id], () => s); for (const l of lines) F.exec(l); };
const CASINO = 'www.lucky-casino.example', BAD = 'cdn.free-codecs.example', NEWS = 'news.example';
const web = [{ proto: 'tcp', port: 80 }, { proto: 'tcp', port: 443 }];

export const LEVELS44 = [
  // ════════════════════════ 6-15 ════════════════════════
  {
    id: 'l124', chapter: 6, title: '上班時間有人在玩線上博弈', subtitle: 'FortiGate 的網頁過濾與 SSL 檢查', tags: ['NGFW', '網頁過濾', 'FortiGuard', 'SSL 檢查', 'FortiGate'],
    brief: `主管發現上班時間有人在玩線上博弈（${CASINO}），還有人從來路不明的網站（${BAD}）下載「影音解碼器」。請在 FortiGate 上用網頁過濾封鎖「線上博弈」與「惡意網站」這兩類網站 — HTTP 與 HTTPS 都要擋；一般的網站照常開得了，而且不能讓同事的瀏覽器跳出憑證錯誤（公司還沒有發 FortiGate 的 CA 憑證給電腦）。`,
    given: [
      ['FortiGate', 'internal 192.168.1.1/24 → wan1（政策 #1「上網」，NAT）'], ['要封鎖的類別', 'Gambling（11）、Malicious Websites（26）'],
      ['線上博弈', `${CASINO}（HTTP 與 HTTPS）`], ['惡意網站', `${BAD}`], ['一般網站', `www.example.com、${NEWS}`],
      ['電腦', '沒有安裝 FortiGate 的 CA（Fortinet_CA_SSL）'],
    ],
    learn: [
      { t: 'NGFW 與安全設定檔', d: '傳統防火牆只看位址和埠；次世代防火牆 (NGFW) 在政策上再套「安全設定檔」：網頁過濾、應用程式控管、IPS、防毒。FortiGate 要先 set utm-status enable，再指定 webfilter-profile 與 ssl-ssh-profile。' },
      { t: 'FortiGuard 網頁過濾', d: 'FortiGuard 替每個網站分類（Gambling = 11、Malicious Websites = 26、Phishing = 61…）。設定檔裡把要擋的類別設成 block；HTTP 的網站會收到一頁封鎖頁面。' },
      { t: 'HTTPS 與 SSL 檢查', d: 'HTTPS 是加密的：no-inspection 什麼都看不到，網頁過濾對 HTTPS 沒作用。certificate-inspection 看 TLS 交握裡的 SNI 和憑證上的名稱，不用解密就能依類別封鎖。deep-inspection 把連線解開（看得到完整網址、能掃毒），但要用 FortiGate 的 CA 重新簽憑證 — 電腦沒有信任 Fortinet_CA_SSL 就會跳憑證錯誤。' },
    ],
    setup() {
      const inet = setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34' });
      inet.inet.hosts.push(
        { ip: '198.51.100.80', name: CASINO, cat: 11, services: web },
        { ip: '198.51.100.66', name: BAD, cat: 26, services: web },
        { ip: '198.51.100.90', name: NEWS, cat: 36, services: web },
      );
      Object.assign(inet.inet.dns, { [CASINO]: '198.51.100.80', [BAD]: '198.51.100.66', [NEWS]: '198.51.100.90' });
      return makeState([
        inet,
        D('fg60f', 'fg', {
          name: 'FortiGate', pos: [0, -4],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33' });
            Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
            d.policies.push(allow('上網', 'internal', 'wan1', { nat: true }));
          },
        }),
        D('pc', 'pc1', { name: '業務 PC', pos: [-4, 2], ip: '192.168.1.21', gw: '192.168.1.1', dns: '8.8.8.8' }),
        D('laptop', 'pc2', { name: '行政筆電', pos: [4, 2], ip: '192.168.1.22', gw: '192.168.1.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'fg:wan1'], ['pc1:eth0', 'fg:1'], ['pc2:eth0', 'fg:2']]);
    },
    objectives: [
      { type: 'https', from: 'pc1', name: 'www.example.com', label: '業務 PC 開 https://www.example.com，沒有憑證錯誤' },
      { type: 'https', from: 'pc2', name: NEWS, label: `行政筆電開 https://${NEWS}（新聞網站照常）` },
      { type: 'tcp', from: 'pc1', name: CASINO, port: 80, expect: false, label: `http://${CASINO} 被擋下（HTTP）` },
      { type: 'https', from: 'pc2', name: CASINO, expect: false, label: `https://${CASINO} 被擋下（HTTPS 也要擋）` },
      { type: 'https', from: 'pc1', name: BAD, expect: false, label: `惡意網站 https://${BAD} 被擋下` },
    ],
    hints: [
      'FortiGate →「安全設定檔」分頁：新增網頁過濾設定檔（例如 corp-wf），勾選「線上博弈（11）」與「惡意網站（26）」。',
      '「政策」分頁的政策 #1：啟用安全設定檔，網頁過濾選 corp-wf。',
      'HTTPS 的博弈網站還是開得了：SSL 檢查是 no-inspection，FortiGate 看不到網址。改成 certificate-inspection。',
      '改成 deep-inspection 的話，所有 HTTPS 網站都會跳憑證錯誤：電腦沒有信任 Fortinet_CA_SSL。這一關用 certificate-inspection 就夠了。',
    ],
    solve(s) {
      typeFg(s, 'fg', ['config webfilter profile', 'edit "corp-wf"', 'config ftgd-wf', 'config filters', 'edit 1', 'set category 11', 'set action block', 'next', 'edit 2', 'set category 26', 'set action block', 'next', 'end', 'end', 'next', 'end',
        'config firewall policy', 'edit 1', 'set utm-status enable', 'set ssl-ssh-profile "certificate-inspection"', 'set webfilter-profile "corp-wf"', 'next', 'end']);
      recompute(s);
    },
    recap: ['網頁過濾依 FortiGuard 的類別封鎖：設定檔決定擋哪些類別，政策上要 utm-status enable 並指定設定檔。', 'HTTPS 要搭配 SSL 檢查：certificate-inspection 看 SNI 就能依類別封鎖；deep-inspection 解密看得更多，但每台電腦都要信任 FortiGate 的 CA。'],
  },
];
