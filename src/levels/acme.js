// 第十一章補充：Let's Encrypt 的憑證自動續約失敗 — HTTP-01 驗證要從網際網路連到 TCP 80，防火牆只開了 443
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { SIM_EPOCH } from '../engine/ops.js';
import { acmeRenew } from '../engine/web.js';
import { transact, settle } from '../engine/sim.js';
import { dev } from './util.js';

const PUB = '203.0.113.45', SITE = 'shop.example.com', DAY = 86400000;

export const LEVELS85 = [
  {
    id: 'l165', chapter: 11, title: '網站的憑證過期了，自動續約明明有開', subtitle: "Let's Encrypt 的 HTTP-01 驗證", tags: ['憑證', "Let's Encrypt", 'ACME', 'certbot', '連接埠轉發'],
    brief: `網路商店 https://${SITE} 今天早上開始，客人的瀏覽器都說「憑證已過期」。這張是 Let's Encrypt 的免費憑證，90 天就到期，伺服器上的 certbot 每天會自動續約兩次。上個月才把路由器換新，連接埠轉發照著舊的設定只開了 443。請讓網站恢復正常，而且以後也能自動續約。`,
    given: [
      ['網站', `${SITE} → ${PUB}（公用 IP，ASUS 路由器的 WAN）`], ['web-01', '192.168.50.10 · Ubuntu · nginx 聽 80 與 443 · certbot'],
      ['連接埠轉發', 'TCP 443 → 192.168.50.10:443'], ['憑證', "Let's Encrypt R11 簽發，90 天"],
    ],
    learn: [
      { t: "Let's Encrypt 與 ACME", d: '免費的公開憑證，效期只有 90 天，所以一定要自動續約：certbot（ACME 用戶端）每天檢查兩次，剩 30 天以內就續約。續約失敗不會有人通知你，要等到憑證真的過期才發現。' },
      { t: 'HTTP-01 驗證', d: 'CA 要確認這個網域真的是你的：它從網際網路連 http://<網域>/.well-known/acme-challenge/<token>，取回 certbot 放好的檔案。一定是 TCP 80：防火牆或路由器只轉 443 的話，CA 會回報 Timeout during connect (likely firewall problem)。' },
      { t: 'DNS-01 驗證', d: '不想開 80，或要申請萬用字元憑證 (*.example.com)，就用 DNS-01：在 DNS 加一筆 _acme-challenge 的 TXT 記錄。需要 DNS 業者提供 API 讓 certbot 自動改。' },
      { t: '怎麼檢查', d: 'sudo certbot certificates 看到期日；sudo certbot renew --dry-run 模擬續約（不會真的換憑證，可以一直試）；確定通了再 sudo certbot renew。' },
    ],
    setup() {
      return makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -8] }), 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.0', assign: PUB }),
        D('homerouter', 'rt', {
          name: 'ASUS 路由器', pos: [0, -3.5],
          init(d) {
            Object.assign(d.ifaces.find((i) => i.id === 'wan'), { mode: 'static', ip: PUB, mask: '255.255.255.0', gateway: '203.0.113.1', dns: '8.8.8.8' });
            d.portForwards.push({ proto: 'tcp', port: 443, toIp: '192.168.50.10', toPort: 443 });
          },
        }),
        D('tower', 'web', {
          name: 'web-01', pos: [3.5, 2], ip: '192.168.50.10', gw: '192.168.50.1', dns: '8.8.8.8',
          services: [{ proto: 'tcp', port: 80, name: 'HTTP（nginx、ACME 驗證）' }, { proto: 'tcp', port: 443, name: 'HTTPS（網路商店）' }],
          init(d) {
            d.os = 'linux';
            d.web = { title: '網路商店', chain: true, acme: { domain: SITE, publicIp: PUB }, cert: { cn: SITE, san: [SITE], issuer: "Let's Encrypt R11", from: SIM_EPOCH - 92 * DAY, to: SIM_EPOCH - 2 * DAY } };
          },
        }),
      ], [['inet:line1', 'rt:wan'], ['rt:lan1', 'web:eth0']]);
    },
    objectives: [
      { type: 'https', from: 'inet', ip: PUB, host: SITE, port: 443, label: `外面的客人打得開 https://${SITE}（憑證有效）` },
      {
        type: 'check', label: '以後也能自動續約（certbot renew --dry-run 成功）',
        test(s) { const r = acmeRenew(s, dev(s, 'web'), transact, { dry: true }); return r.ok || `模擬續約失敗：${r.why}`; },
      },
    ],
    hints: [
      'web-01 的終端機：sudo certbot certificates，憑證已經過期（INVALID: EXPIRED）。sudo certbot renew --dry-run 看看為什麼續約失敗：Timeout during connect (likely firewall problem)。',
      'Let\'s Encrypt 的 HTTP-01 驗證要從網際網路連到 TCP 80。ASUS 路由器 →「連接埠轉發」新增 TCP 80 → 192.168.50.10:80。',
      '再 sudo certbot renew --dry-run，成功了就 sudo certbot renew 真的換一張新的憑證。',
    ],
    solve(s) {
      dev(s, 'rt').portForwards.push({ proto: 'tcp', port: 80, toIp: '192.168.50.10', toPort: 80 });
      settle(s); // 先算好路由與連接埠轉發，CA 才連得進來
      acmeRenew(s, dev(s, 'web'), transact);
    },
    recap: ["Let's Encrypt 的憑證 90 天到期，自動續約失敗不會有人通知：sudo certbot renew --dry-run 定期檢查。", 'HTTP-01 驗證一定要從網際網路連得到 TCP 80；不想開 80 就改用 DNS-01。'],
  },
];
