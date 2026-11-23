// 第三章補充：郵件伺服器放在 DMZ — 寄出去要放行 SMTP、寄進來要有 VIP 與政策（MX 指向的公用位址）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const PUB = '203.0.113.20', MX = '172.16.1.25';

export const LEVELS67 = [
  {
    id: 'l147', chapter: 3, title: '公司自己架了郵件伺服器，信卻寄不出也收不到', subtitle: 'SMTP、MX 與 DMZ 的 VIP', tags: ['郵件', 'SMTP', 'MX', 'DMZ', 'VIP', 'FortiGate'],
    brief: `公司把郵件搬回自己的伺服器 (${MX}，放在 DMZ)，網域 corp.com.tw 的 MX 已經改成 mail.corp.com.tw（${PUB}）。結果同事之間寄信正常，寄給客戶的信全部卡住，客戶寄來的信也收不到。請讓信寄得出去、也收得進來，但郵件伺服器在網際網路上只開放收信需要的連接埠。`,
    given: [
      ['HQ-FW', 'wan1 203.0.113.18/29（公司的公用位址 203.0.113.17 – 22）· internal 192.168.1.0/24 · dmz 172.16.1.0/24'],
      ['郵件伺服器', `${MX} · corp.com.tw · TCP 25（收信）、587（員工寄信）`], ['MX', `corp.com.tw → mail.corp.com.tw → ${PUB}`],
      ['客戶', 'bob@partner.com（partner.com 的 MX 在網際網路上）'], ['員工', 'Amy 的電腦：寄件伺服器 172.16.1.25:587'],
    ],
    learn: [
      { t: '信怎麼送', d: '員工的電腦用 TCP 587 把信交給公司的郵件伺服器 (submission)；伺服器看收件人的網域，查那個網域的 MX 記錄，再用 TCP 25 交給對方的郵件伺服器。對方寄來的信也一樣：查 corp.com.tw 的 MX，連到它的 TCP 25。' },
      { t: 'DMZ 的郵件伺服器', d: '寄出去：DMZ → 網際網路的政策要放行 SMTP (25)，伺服器查 MX 也需要 DNS。收進來：MX 指向的公用位址要用 VIP 轉到郵件伺服器的 TCP 25，再加一條網際網路 → DMZ 的政策。' },
      { t: '只開需要的', d: '從網際網路來的只需要 TCP 25；587 是給員工寄信用的（在外面的員工用 VPN 或 SMTPS 465 加帳號驗證），不要整台一對一 NAT 出去。' },
      { t: '怎麼查', d: '郵件伺服器的「郵件伺服器」分頁列出卡在佇列裡的信與原因；Amy 的電腦「郵件」分頁可以寄測試信，封包的路徑會畫出來。' },
    ],
    setup() {
      const inet = setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9.5] }), 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' });
      inet.inet.hosts.push({ ip: '198.51.100.25', name: 'mx.partner.com', services: [{ proto: 'tcp', port: 25 }], mail: { domain: 'partner.com', users: ['bob'] } });
      Object.assign(inet.inet.dns, { 'mx.partner.com': '198.51.100.25', 'mail.corp.com.tw': PUB });
      inet.inet.mx = { 'partner.com': 'mx.partner.com', 'corp.com.tw': 'mail.corp.com.tw' };
      const s = makeState([
        inet,
        D('fg60f', 'fw', {
          name: 'HQ-FW', pos: [0, -4],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
            Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
            Object.assign(g('dmz'), { ip: '172.16.1.1', mask: '255.255.255.0' });
            d.policies.push(allow('員工上網', 'internal', 'wan1', { nat: true }), allow('員工寄信', 'internal', 'dmz', { dst: MX }),
              allow('DMZ 更新與查 DNS', 'dmz', 'wan1', { nat: true, service: 'HTTPS,DNS' }));
          },
        }),
        D('tower', 'mx', { name: '郵件伺服器', pos: [6, -1], ip: MX, gw: '172.16.1.1', dns: '8.8.8.8', services: [{ proto: 'tcp', port: 25, name: 'SMTP' }, { proto: 'tcp', port: 587, name: 'SMTP submission' }], init(d) { d.mail = { domain: 'corp.com.tw', users: ['amy', 'ken'], boxes: {}, queue: [] }; } }),
        D('pc', 'amy', { name: 'Amy 的電腦', pos: [-5, 2], ip: '192.168.1.21', gw: '192.168.1.1', dns: '8.8.8.8', init(d) { d.mailClient = { addr: 'amy@corp.com.tw', server: MX, port: 587 }; } }),
      ], [['inet:line1', 'fw:wan1'], ['fw:dmz', 'mx:eth0'], ['amy:eth0', 'fw:1']]);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'mail', from: 'amy', to: 'ken@corp.com.tw', label: '同事之間寄信（amy → ken）' },
      { type: 'mail', from: 'amy', to: 'bob@partner.com', label: '寄給客戶（amy → bob@partner.com）' },
      { type: 'mail', from: 'inet', to: 'amy@corp.com.tw', via: 'partner.com', label: '客戶寄來的信收得到（partner.com → amy）' },
      { type: 'tcp', from: 'inet', ip: PUB, port: 587, expect: false, label: '網際網路上連不到郵件伺服器的 587（只開放收信的 25）' },
    ],
    hints: [
      '郵件伺服器的「郵件伺服器」分頁：寄給 bob 的信卡在佇列，連不到 mx.partner.com 的 TCP 25 — 被 HQ-FW 的政策擋下（DMZ → wan1 只放行 HTTPS、DNS）。',
      'HQ-FW →「政策」：DMZ → wan1 那條的服務加上 SMTP（或另外新增一條 dmz → wan1、服務 SMTP、NAT）。',
      `收信：HQ-FW →「虛擬 IP」新增 TCP 25，對外 ${PUB}、轉到 ${MX}:25（CLI：config firewall vip → set extip ${PUB} → set mappedip ${MX} → set portforward enable → set extport 25）；再加一條 wan1 → dmz、目的 ${MX}、服務 SMTP 的政策。`,
    ],
    solve(s) {
      const fw = dev(s, 'fw');
      fw.policies.find((p) => p.srcIf === 'dmz').service = 'HTTPS,DNS,SMTP';
      fw.portForwards.push({ name: 'MAIL-25', proto: 'tcp', port: '25', toIp: MX, toPort: '', extIp: PUB });
      fw.policies.push(allow('收信', 'wan1', 'dmz', { dst: MX, service: 'SMTP' }));
    },
    recap: [
      '寄出去：員工 →(587) 公司的郵件伺服器 → 查 MX →(25) 對方；DMZ 的政策要放行 SMTP。',
      '收進來：MX 指向的公用位址要有 VIP 轉到 TCP 25 與一條政策；只開 25，不要整台對外。',
    ],
  },
];
