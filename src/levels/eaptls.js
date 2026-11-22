// 第六章補充：802.1X 的 EAP-TLS — RADIUS 伺服器的憑證週末過期，星期一早上有線網路全部登不進去
import { makeDevice as D, makeState } from '../engine/model.js';
import { CORP_CA, issueCert, certDaysLeft } from '../engine/web.js';
import { SIM_EPOCH } from '../engine/ops.js';
import { dev } from './util.js';

const DAY = 86400000;
/** 加入網域的電腦自動向公司的 CA 申請的電腦憑證（2025 年 3 月起一年半） */
const machine = (cn) => ({ cn, issuer: CORP_CA, from: Date.UTC(2025, 2, 3), to: Date.UTC(2026, 8, 3) });
const domainPc = (d, cn) => { d.trust = [CORP_CA]; d.dot1x = { method: 'tls', cert: machine(cn) }; };

export const LEVELS30 = [
  {
    id: 'l102', chapter: 6, title: '星期一早上，有線網路全部登不進去', subtitle: '802.1X 的 EAP-TLS：伺服器憑證、用戶端憑證與時鐘', tags: ['802.1X', 'EAP-TLS', 'RADIUS', '憑證', 'PKI'],
    brief: '二樓的有線網路用 802.1X，加入網域的電腦用電腦憑證自動登入（EAP-TLS），NPS 是 RADIUS 伺服器。上週五下班前一切正常，星期一早上全部的電腦都拿不到 IP；交換器和 NPS 的設定週末都沒有人動過。請讓員工的電腦恢復上網，而且仍然用 EAP-TLS；今天來維修的廠商筆電沒有公司的憑證，不能讓它連上。',
    given: [
      ['SW-2F', 'Gi0/1 – Gi0/3 開了 802.1X · RADIUS 伺服器 192.168.10.5'], ['NPS', '192.168.10.5 · EAP-TLS · 伺服器憑證 nps.corp.local（Corp Root CA 簽發）'],
      ['員工的電腦', '加入網域：自動裝好 Corp Root CA 的根憑證與自己的電腦憑證'], ['廠商的筆電', '沒有加入網域'],
    ],
    learn: [
      { t: 'EAP-TLS', d: '802.1X 最安全的方式：用戶端不輸入密碼，而是出示自己的憑證；RADIUS 伺服器檢查它是不是公司的 CA 簽的、還在不在有效期間。加入網域的電腦會自動向 CA 申請電腦憑證 (auto-enrollment)，沒有加入的就沒有。' },
      { t: '雙向驗證', d: '用戶端也會檢查 RADIUS 伺服器的憑證（簽發者要在信任清單裡、而且還沒過期），確認自己不是在對冒牌的伺服器交出身分。PEAP 也一樣。所以伺服器的憑證一過期，所有的用戶端同時登不進去。' },
      { t: '時鐘', d: '憑證的有效期間是用「檢查的那一端自己的時鐘」判斷的：電腦的時鐘差了兩年，剛換好的伺服器憑證在它眼裡就是「還沒生效」。' },
      { t: '預防', d: '伺服器憑證要在到期前更新（CA 的範本可以自動續約），監控系統也要追蹤憑證的到期日。' },
    ],
    setup() {
      const s = makeState([
        D('erx', 'rt', {
          name: 'Router', pos: [-8, -5],
          init(d) {
            Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.10.100', end: '192.168.10.199', dns: '192.168.10.1' });
          },
        }),
        D('c2960p', 'sw', {
          name: 'SW-2F', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '192.168.10.2', mask: '255.255.255.0' });
            d.radius = { ip: '192.168.10.5', secret: 'Nps#Key2026' };
            for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/3']) d.sw.ports[p].dot1x = true;
          },
        }),
        D('tower', 'nps', {
          name: 'NPS', pos: [8, -4.6], ip: '192.168.10.5', gw: '192.168.10.1',
          init(d) {
            d.radiusServer = { secret: 'Nps#Key2026', users: [], trust: [CORP_CA], cert: { cn: 'nps.corp.local', issuer: CORP_CA, from: Date.UTC(2024, 0, 4, 1), to: Date.UTC(2026, 0, 4, 1) } };
          },
        }),
        D('pc', 'pc1', { name: '財務 PC', pos: [-7, 2], dhcp: true, init(d) { domainPc(d, 'fin-pc01.corp.local'); } }),
        // 主機板電池沒電、又被關掉自動校時：時鐘停在兩年多前
        D('laptop', 'nb', { name: '業務的筆電', pos: [-1.5, 4.5], dhcp: true, init(d) { domainPc(d, 'sales-nb07.corp.local'); d.clock = { sync: false, skew: -820 * 86400 }; } }),
        D('laptop', 'vend', { name: '廠商的筆電', pos: [5, 4.5], dhcp: true, init(d) { d.dot1x = { method: 'tls' }; } }),
      ], [['rt:eth1', 'sw:Gi0/10'], ['nps:eth0', 'sw:Gi0/9'], ['pc1:eth0', 'sw:Gi0/1'], ['nb:eth0', 'sw:Gi0/2'], ['vend:eth0', 'sw:Gi0/3']]);
      return s;
    },
    objectives: [
      { type: 'ping', from: 'pc1', ip: '192.168.10.1', label: '財務 PC 用 EAP-TLS 通過驗證，可以上網' },
      { type: 'ping', from: 'nb', ip: '192.168.10.1', label: '業務的筆電也登得進去' },
      { type: 'ping', from: 'vend', ip: '192.168.10.1', expect: false, label: '沒有公司憑證的廠商筆電仍然被擋在外面' },
      {
        type: 'check', label: 'NPS 的伺服器憑證是公司的 CA 簽的，還有 30 天以上才到期',
        test(s) {
          const c = dev(s, 'nps').radiusServer.cert;
          if (!c) return 'NPS 沒有伺服器憑證';
          if (c.issuer !== CORP_CA) return `NPS 的憑證是「${c.issuer}」簽的，員工的電腦只信任 ${CORP_CA}`;
          const left = certDaysLeft(s, c);
          return left >= 30 ? true : left < 0 ? `NPS 的伺服器憑證已經過期 ${Math.max(1, Math.floor((SIM_EPOCH + s.clock * 1000 - c.to) / DAY))} 天` : `NPS 的伺服器憑證只剩 ${left} 天`;
        },
      },
      {
        type: 'check', label: '仍然用 EAP-TLS（沒有改成帳號密碼、沒有關掉 802.1X）',
        test(s) {
          for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/3']) if (!dev(s, 'sw').sw.ports[p].dot1x) return `SW-2F 的 ${p} 關掉了 802.1X`;
          if (dev(s, 'nps').radiusServer.tls === false) return 'NPS 關掉了 EAP-TLS';
          for (const id of ['pc1', 'nb']) if ((dev(s, id).dot1x || {}).method !== 'tls') return `${dev(s, id).name} 改用帳號密碼登入：要繼續用電腦憑證 (EAP-TLS)`;
          return true;
        },
      },
    ],
    hints: [
      '財務 PC 的「網路設定」：連接埠還沒有通過 802.1X 驗證，原因寫著它不接受 NPS 的憑證 — 2026-01-04 就到期了，正好是星期天。',
      'NPS 的「RADIUS」分頁 → 伺服器憑證 → 向公司的 CA 重新申請伺服器憑證。',
      '業務的筆電還是不行？它的時鐘差了兩年多（自動校時被關掉了），新的伺服器憑證在它眼裡「還沒生效」：在它的「網路設定」打開自動校時。',
    ],
    solve(s) {
      dev(s, 'nps').radiusServer.cert = issueCert(s, { cn: 'nps.corp.local', issuer: CORP_CA, days: 730 });
      dev(s, 'nb').clock = { sync: true };
    },
    recap: ['EAP-TLS 是雙向的：用戶端檢查 RADIUS 伺服器的憑證，伺服器檢查用戶端的電腦憑證；任何一邊過期或不被信任就登不進去。', '憑證的有效期間用檢查那一端自己的時鐘判斷；伺服器憑證要在到期前更新。'],
  },
];
