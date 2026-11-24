// 第十一章（維運）：HTTPS 憑證。過期、名稱不在 SAN 裡、用戶端不信任公司的 CA、用戶端的時鐘錯了
import { makeDevice as D, makeState } from '../engine/model.js';
import { SIM_EPOCH } from '../engine/ops.js';
import { CORP_CA, certSelf, certDaysLeft, issueCert } from '../engine/web.js';
import { dev, WEB } from './util.js';

const DAY = 86400000;
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });

export const LEVELS17 = [
  {
    id: 'l74', chapter: 11, title: '你的連線不是私人連線', subtitle: 'HTTPS 憑證：信任、有效期間與名稱', tags: ['HTTPS', 'TLS', '憑證', 'PKI', 'SAN'], noDrill: true,
    brief: '今天一早，大家打開公司的入口網站 https://intranet.corp.local 都跳出「你的連線不是私人連線」，有人已經習慣直接按「繼續前往」了。行銷部又剛好把新網址 portal.corp.local 印在海報上；新來的同事用自己的筆電、會議室那台剛換過主機板電池的電腦，看到的錯誤還都不一樣。請讓每一台都能用兩個網址正常開啟網站，不能叫大家略過警告。',
    given: [
      ['入口網站', 'Web-Portal 10.0.2.80 · https://intranet.corp.local'], ['新網址', 'portal.corp.local（DNS 已經加好 CNAME）'],
      ['公司的 CA', 'Corp Root CA（AD 憑證服務，加入網域的電腦都信任）'], ['DNS 伺服器', '10.0.2.53'],
      ['PC-1', '加入網域的電腦'], ['新同事的筆電', '自己帶的，沒有加入網域'], ['會議室電腦', '上週換過主機板電池'],
    ],
    learn: [
      { t: '憑證是什麼', d: '伺服器的公開金鑰，加上它的名稱和有效期間，由憑證授權單位 (CA) 用自己的私密金鑰簽名。瀏覽器用「信任的根憑證」驗證這個簽名，確定對面真的是這個網站，不是有人在中間冒充。' },
      { t: '瀏覽器檢查的三件事', d: '① 是不是信任的 CA 簽的（不是就 unable to get local issuer certificate、self-signed）② 現在是不是在有效期間內（certificate has expired / is not yet valid）③ 網址的名稱有沒有列在主體別名 (SAN) 裡（no alternative certificate subject name matches）。Chrome 58 之後只看 SAN，不看 CN。' },
      { t: '內部 CA 與公開 CA', d: '公開 CA（DigiCert、Let\'s Encrypt）每台電腦都內建信任，但不會簽 .local 這種內部名稱。公司自己的 CA（例如 AD CS）可以簽，但根憑證要先裝到每台電腦：加入網域的由群組原則自動派送，自己帶的設備要手動匯入或用 MDM。' },
      { t: '時間也是驗證的一部分', d: '有效期間是用「用戶端自己的時鐘」判斷的。主機板電池沒電、自動校時被關掉的電腦，時間跑回好幾年前，所有網站都會變成「憑證尚未生效」(NET::ERR_CERT_DATE_INVALID)。' },
      { t: '憑證到期是最常見的事故', d: '要監控到期日（例如 30 天前告警），最好用 ACME（certbot、Let\'s Encrypt）自動續約。公開憑證的效期一直在縮短：最長 398 天，2026 年 3 月起 200 天，2029 年會降到 47 天，不自動化就一定會忘。' },
    ],
    setup() {
      const corp = (d) => { d.trust = [CORP_CA]; };
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [0, -5.5], init(d) { ip4(d, 'Gi0/0/1', '10.0.1.1'); ip4(d, 'Gi0/0/2', '10.0.2.1'); } }),
        D('sw8', 'usw', { name: 'SW-Users', pos: [-6, -0.5] }),
        D('sw8', 'ssw', { name: 'SW-Servers', pos: [6, -0.5] }),
        D('pc', 'pc1', { name: 'PC-1', pos: [-11, 3.4], ip: '10.0.1.21', gw: '10.0.1.1', dns: '10.0.2.53', init: corp }),
        D('laptop', 'byod', { name: '新同事的筆電', pos: [-6.8, 5.8], ip: '10.0.1.35', gw: '10.0.1.1', dns: '10.0.2.53', init(d) { d.trust = []; } }),
        D('pc', 'meet', {
          name: '會議室電腦', pos: [-2, 3.4], ip: '10.0.1.40', gw: '10.0.1.1', dns: '10.0.2.53',
          // 換了主機板電池，BIOS 的時間回到 2024 年；這台是共用電腦，自動校時被關掉了
          init(d) { corp(d); d.clock = { sync: false, skew: -400 * 86400 }; },
        }),
        D('tower', 'dns', {
          name: 'DNS 伺服器', pos: [3, 4.6], ip: '10.0.2.53', gw: '10.0.2.1', services: [{ proto: 'udp', port: 53, name: 'DNS' }, { proto: 'tcp', port: 53, name: 'DNS（區域轉送）' }],
          init(d) {
            d.dnsZone = { records: [
              { name: 'intranet.corp.local', type: 'A', value: '10.0.2.80', ttl: 3600 },
              { name: 'portal.corp.local', type: 'CNAME', value: 'intranet.corp.local', ttl: 3600 },
              { name: 'ca.corp.local', type: 'A', value: '10.0.2.60', ttl: 3600 },
            ] };
          },
        }),
        D('tower', 'web', {
          name: 'Web-Portal', pos: [9.5, 4], ip: '10.0.2.80', gw: '10.0.2.1', services: WEB,
          init(d) {
            // 去年申請的憑證，昨天到期；當時只寫了 intranet 一個名稱
            d.web = { title: '員工入口網站', redirect: true, cert: { cn: 'intranet.corp.local', san: ['intranet.corp.local'], issuer: CORP_CA, from: SIM_EPOCH - 366 * DAY, to: SIM_EPOCH - DAY } };
          },
        }),
      ], [['rt:Gi0/0/1', 'usw:1'], ['rt:Gi0/0/2', 'ssw:1'], ['pc1:eth0', 'usw:2'], ['byod:eth0', 'usw:3'], ['meet:eth0', 'usw:4'], ['dns:eth0', 'ssw:2'], ['web:eth0', 'ssw:3']]);
      return s;
    },
    objectives: [
      { type: 'https', from: 'pc1', name: 'intranet.corp.local', label: 'PC-1 開 https://intranet.corp.local 沒有憑證警告' },
      { type: 'https', from: 'pc1', name: 'portal.corp.local', label: '新網址 https://portal.corp.local 也沒有警告' },
      { type: 'https', from: 'byod', name: 'intranet.corp.local', label: '新同事的筆電（沒有加入網域）也沒有警告' },
      { type: 'https', from: 'meet', name: 'portal.corp.local', label: '會議室電腦也沒有警告' },
      {
        type: 'check', label: '網站的新憑證由 Corp Root CA 簽發，還有 300 天以上才到期',
        test(s) {
          const c = (dev(s, 'web').web || {}).cert;
          if (!c) return 'Web-Portal 沒有安裝憑證';
          if (certSelf(c)) return '自簽憑證沒有人信任：要交給 Corp Root CA 簽發';
          if (c.issuer !== CORP_CA) return `憑證是「${c.issuer}」簽的：內部網站要用公司的 Corp Root CA`;
          const left = certDaysLeft(s, c);
          return left >= 300 || (left < 0 ? `憑證已經過期 ${-left} 天` : `憑證只剩 ${left} 天就到期`);
        },
      },
    ],
    hints: [
      'PC-1 的終端機：curl -v https://intranet.corp.local，看 expire date 是昨天（certificate has expired）。Web-Portal →「網站」分頁 → 申請新的憑證，交給 Corp Root CA 簽發。',
      'curl https://portal.corp.local 的錯誤是 no alternative certificate subject name matches：舊憑證的 SAN 只有 intranet.corp.local。申請時主體別名要同時列 intranet.corp.local, portal.corp.local（或用萬用字元 *.corp.local）。',
      '新同事的筆電：unable to get local issuer certificate，它沒有加入網域，不信任 Corp Root CA。筆電 →「網路設定」分頁 → 安裝公司的根憑證；或在終端機 sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates。',
      '會議室電腦：先打 date，時間是 2024 年（換電池之後 BIOS 時間重設，自動校時又被關掉），所以新憑證是「not yet valid」。「網路設定」分頁打開自動設定時間，或在終端機 sudo timedatectl set-ntp true。',
    ],
    solve(s) {
      dev(s, 'web').web.cert = issueCert(s, { cn: 'intranet.corp.local', san: ['intranet.corp.local', 'portal.corp.local'], issuer: CORP_CA, days: 365 });
      dev(s, 'byod').trust = [CORP_CA];
      dev(s, 'meet').clock.sync = true;
    },
    recap: ['HTTPS 要過三關：信任的 CA 簽的、在有效期間內（用用戶端的時鐘）、網址在 SAN 裡。', '內部 CA 的根憑證要裝到每台電腦；憑證要監控到期日，最好自動續約。'],
  },
];
