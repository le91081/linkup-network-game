// 第六章補充：FortiGate 的 DNS 過濾與防毒
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { fortiSession } from '../engine/fortios.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const typeFg = (s, id, lines) => { const F = fortiSession(() => s.devices[id], () => s); for (const l of lines) F.exec(l); };
const PHISH = 'login.micr0soft-verify.example', FILES = 'files.share-now.example', NEWS = 'news.example';
const web = [{ proto: 'tcp', port: 80 }, { proto: 'tcp', port: 443 }];

export const LEVELS53 = [
  {
    id: 'l133', chapter: 6, title: '同事點了釣魚信的連結，還下載了「發票」', subtitle: 'FortiGate 的 DNS 過濾與防毒', tags: ['NGFW', 'DNS 過濾', '防毒', '釣魚', 'FortiGate'],
    brief: `一封假冒微軟的信寄到全公司：連結是 https://${PHISH}（假的登入頁），附的「發票」要到 http://${FILES} 下載，裡面是病毒。公司很多人用自己的筆電 (BYOD)，老闆不准對 HTTPS 解密，FortiGate 的 SSL 檢查要維持 no-inspection。請讓釣魚網站與惡意網站在 DNS 這一關就被擋下，下載的檔案要經過防毒掃描，一般的網站照常。`,
    given: [
      ['FortiGate', 'internal 192.168.1.1/24 → wan1（政策 #1「上網」，NAT，還沒有任何安全設定檔）'],
      ['電腦的 DNS', '8.8.8.8（查詢會經過 FortiGate）'], ['要擋的類別', 'Phishing（61）、Malicious Websites（26）'],
      ['規定', 'SSL 檢查維持 no-inspection（不解密 HTTPS）'],
    ],
    learn: [
      { t: 'DNS 過濾', d: '電腦查網址的時候，DNS 查詢經過 FortiGate。DNS 過濾依 FortiGuard 的類別判斷這個名稱：要擋的就不回真正的位址，改回封鎖頁面的位址（208.91.112.55）。不用解密 HTTPS 就擋得住，因為根本拿不到網站的位址。' },
      { t: 'DNS 過濾擋不住的', d: '電腦改用 DoH（DNS over HTTPS，瀏覽器內建）、自己的 VPN，或直接打 IP，DNS 查詢就不經過 FortiGate 或看不到。實務上會再用應用程式控管擋 DoH、搭配網頁過濾。' },
      { t: '防毒', d: '防毒設定檔掃描下載的檔案（config http → set av-scan block），比對到病毒碼就擋下、回一頁替換訊息。HTTPS 的下載是加密的，沒有 deep-inspection 就看不到檔案內容：這是「不解密」要付出的代價。' },
      { t: '測試用的病毒', d: 'EICAR 測試檔是業界共用的「假病毒」：一段無害的文字，每家防毒都會把它當成病毒，用來確認防毒有沒有在運作。' },
    ],
    setup() {
      const inet = setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34' });
      inet.inet.hosts.push(
        { ip: '198.51.100.61', name: PHISH, cat: 61, services: web },
        { ip: '198.51.100.24', name: FILES, cat: 24, virus: 'EICAR_TEST_FILE', services: web },
        { ip: '198.51.100.90', name: NEWS, cat: 36, services: web },
      );
      Object.assign(inet.inet.dns, { [PHISH]: '198.51.100.61', [FILES]: '198.51.100.24', [NEWS]: '198.51.100.90' });
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
        D('pc', 'pc1', { name: '會計 PC', pos: [-4, 2], ip: '192.168.1.21', gw: '192.168.1.1', dns: '8.8.8.8' }),
        D('laptop', 'pc2', { name: '業務的筆電（BYOD）', pos: [4, 2], ip: '192.168.1.22', gw: '192.168.1.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'fg:wan1'], ['pc1:eth0', 'fg:1'], ['pc2:eth0', 'fg:2']]);
    },
    objectives: [
      { type: 'https', from: 'pc1', name: PHISH, expect: false, label: `釣魚網站 https://${PHISH} 打不開（DNS 這一關就擋下）` },
      { type: 'tcp', from: 'pc2', name: FILES, port: 80, expect: false, label: `從 http://${FILES} 下載「發票」被防毒擋下` },
      { type: 'https', from: 'pc2', name: NEWS, label: `一般的網站照常：https://${NEWS}` },
      { type: 'https', from: 'pc1', name: 'www.example.com', label: 'https://www.example.com 照常，沒有憑證錯誤' },
      {
        type: 'check', label: '政策 #1 的 SSL 檢查維持 no-inspection（不解密）',
        test(s) {
          const p = dev(s, 'fg').policies[0];
          return !p || !p.utm || (p.ssl || 'no-inspection') === 'no-inspection' || `政策 #1 的 SSL 檢查是 ${p.ssl}：老闆規定不解密 HTTPS（BYOD 的筆電沒有安裝 FortiGate 的 CA）`;
        },
      },
    ],
    hints: [
      'FortiGate →「安全設定檔」分頁：新增 DNS 過濾設定檔（例如 corp-dns），勾選「網路釣魚（61）」與「惡意網站（26）」。',
      '再新增防毒設定檔（例如 corp-av），預設就會掃描 HTTP 下載。',
      '「政策」分頁的政策 #1：啟用安全設定檔，DNS 過濾選 corp-dns、防毒選 corp-av，SSL 檢查維持 no-inspection。',
      `CLI：config dnsfilter profile → edit "corp-dns" → config ftgd-dns → config filters → edit 1 → set category 61 → set action block …；config antivirus profile → edit "corp-av" → config http → set av-scan block；config firewall policy → edit 1 → set utm-status enable → set dnsfilter-profile "corp-dns" → set av-profile "corp-av"。電腦上 nslookup ${PHISH} 會看到 208.91.112.55。`,
      '設好了釣魚網站卻還打得開：電腦已經把它真正的位址記在 DNS 快取裡。在電腦的終端機 resolvectl flush-caches，或等 5 分鐘。',
    ],
    solve(s) {
      typeFg(s, 'fg', ['config dnsfilter profile', 'edit "corp-dns"', 'config ftgd-dns', 'config filters', 'edit 1', 'set category 61', 'set action block', 'next', 'edit 2', 'set category 26', 'set action block', 'next', 'end', 'end', 'next', 'end',
        'config antivirus profile', 'edit "corp-av"', 'config http', 'set av-scan block', 'end', 'next', 'end',
        'config firewall policy', 'edit 1', 'set utm-status enable', 'set ssl-ssh-profile "no-inspection"', 'set dnsfilter-profile "corp-dns"', 'set av-profile "corp-av"', 'next', 'end']);
      if (s.dyn && s.dyn.dnsCache) { delete s.dyn.dnsCache.pc1; delete s.dyn.dnsCache.pc2; } // resolvectl flush-caches
      recompute(s);
    },
    recap: [
      'DNS 過濾在查名稱時就擋：不用解密 HTTPS，但 DoH 或直接打 IP 就繞過了。',
      '防毒只掃得到看得到的內容：HTTP、FTP 可以，HTTPS 要 deep-inspection。安全是一層一層疊起來的。',
    ],
  },
];
