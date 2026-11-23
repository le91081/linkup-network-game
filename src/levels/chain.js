// 第十一章補充：中繼憑證 — 瀏覽器打得開，Linux 上的程式卻說 unable to get local issuer certificate
import { makeDevice as D, makeState } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { CORP_CA, issueCert } from '../engine/web.js';
import { dev, WEB } from './util.js';

const API = 'api.corp.local';

export const LEVELS68 = [
  {
    id: 'l148', chapter: 11, title: '瀏覽器打得開，程式卻說憑證有問題', subtitle: '中繼 CA 與完整的憑證鏈', tags: ['TLS', '憑證', '中繼 CA', 'fullchain', 'curl'],
    brief: `資訊組上週替訂單 API (${API}) 換了公司 CA 簽的新憑證。用 Windows 的瀏覽器打開完全正常，可是 Linux 上的出貨程式從那天起每次呼叫 API 都失敗：curl: (60) SSL certificate problem: unable to get local issuer certificate。出貨程式那台早就裝了公司的根憑證。請找出原因並修好，不要用 curl -k 之類略過檢查的方式。`,
    given: [
      ['訂單 API', `${API}（10.0.20.10）· 憑證由 Corp Issuing CA 簽發`], ['公司的 CA', `根 CA：${CORP_CA}（離線保管）→ 中繼 CA：Corp Issuing CA（實際簽發憑證）`],
      ['業務的電腦', 'Windows，加入網域（信任 Corp Root CA）'], ['出貨伺服器', 'Linux，已經安裝 Corp Root CA（update-ca-certificates）'],
    ],
    learn: [
      { t: '中繼 CA', d: '根 CA 的私密金鑰最重要，平常離線保管；日常簽發憑證的是根 CA 簽出來的中繼 CA。用戶端只安裝根憑證，所以驗證時要把「網站憑證 → 中繼憑證 → 根憑證」整條鏈接起來。' },
      { t: '完整的憑證鏈 (fullchain)', d: '網站在 TLS 交握時要把自己的憑證和中繼憑證一起送出去。只裝了網站自己的憑證，用戶端就接不到根憑證。' },
      { t: '為什麼瀏覽器沒事', d: 'Windows（瀏覽器、Schannel）會照憑證裡的 AIA 網址自己去下載缺少的中繼憑證，所以看起來正常；Linux 的 OpenSSL（curl、Python、Java、手機 App）不會，就失敗了。不能用「瀏覽器打得開」判斷憑證裝對了：openssl s_client -connect 看伺服器送出幾張。' },
    ],
    setup() {
      const s = makeState([
        D('sw8', 'sw', { name: 'Switch', pos: [0, -2] }),
        D('tower', 'dns', { name: 'DNS 伺服器', pos: [-6, -5], ip: '10.0.20.53', services: [{ proto: 'udp', port: 53, name: 'DNS' }], init(d) { d.dnsZone = { records: [{ name: API, type: 'A', value: '10.0.20.10', ttl: 3600 }] }; } }),
        D('tower', 'api', { name: '訂單 API', pos: [6, -5], ip: '10.0.20.10', dns: '10.0.20.53', services: WEB }),
        D('pc', 'pc', { name: '業務的電腦 (Windows)', pos: [-6, 3], ip: '10.0.20.21', dns: '10.0.20.53', init(d) { d.trust = [CORP_CA]; } }),
        D('tower', 'ship', { name: '出貨伺服器 (Linux)', pos: [6, 3], ip: '10.0.20.30', dns: '10.0.20.53', init(d) { d.os = 'linux'; d.trust = [CORP_CA]; } }),
      ], [['dns:eth0', 'sw:1'], ['api:eth0', 'sw:2'], ['pc:eth0', 'sw:3'], ['ship:eth0', 'sw:4']]);
      recompute(s);
      s.devices.api.web = { title: '訂單 API', cert: issueCert(s, { cn: API, san: [API], issuer: 'Corp Issuing CA', days: 365 }) };
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'https', from: 'pc', name: API, label: `業務的電腦（Windows）打得開 https://${API}` },
      { type: 'https', from: 'ship', name: API, strict: true, label: `出貨伺服器（Linux）呼叫 https://${API} 不再出現憑證錯誤` },
      {
        type: 'check', label: '網站憑證仍由中繼 CA 簽發（根 CA 不直接簽網站憑證）',
        test(s) { const c = (dev(s, 'api').web || {}).cert; return (c && c.issuer === 'Corp Issuing CA') || `訂單 API 的憑證改成由「${c ? c.issuer : '？'}」簽發了：根 CA 要離線保管，網站憑證由中繼 CA 簽，再把中繼憑證一起送出去`; },
      },
    ],
    hints: [
      `出貨伺服器的終端機：curl -v https://${API} — 憑證的簽發者是 Corp Issuing CA，但它信任的只有 Corp Root CA，中間少了一張。`,
      '訂單 API →「網站」分頁：簽發者是中繼 CA，下面有「一起送出中繼憑證（安裝完整的憑證鏈 fullchain）」— 現在沒打開。',
      '打開它（等於把 cert.pem 換成 fullchain.pem、重新載入網站），出貨伺服器就能把鏈接到 Corp Root CA。',
    ],
    solve(s) { dev(s, 'api').web.chain = true; },
    recap: [
      '網站要送出完整的憑證鏈（自己的憑證＋中繼憑證）；用戶端只需要信任根憑證。',
      '瀏覽器會自己補中繼憑證，程式不會：測試憑證要用 curl / openssl，不要只看瀏覽器。',
    ],
  },
];
