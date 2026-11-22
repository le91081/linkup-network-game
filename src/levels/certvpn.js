// 第七章補充：用憑證驗證的 IKEv2 VTI — 分公司路由器換了主機板電池，時鐘回到 2002 年，憑證「還沒生效」，
// 而它的 NTP 伺服器偏偏在 VPN 的另一邊（雞生蛋、蛋生雞）
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { advance, recompute, settle } from '../engine/sim.js';
import { deviceTime, ntpInfo, SIM_EPOCH } from '../engine/ops.js';
import { caCert } from '../engine/pki.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const lines = (n) => Array.from({ length: n }, (_, k) => ({ id: 'line' + (k + 1), label: '線路 ' + (k + 1), media: 'rj45' }));
const CA = { name: 'Corp Root CA' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const two = (n) => String(n).padStart(2, '0');
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
/** 安裝的時候（2025 年 6 月）就向 CA 申請好的憑證 */
const installed = (cn, serial) => ({ cn, issuer: CA.name, serial, from: Date.UTC(2025, 5, 2, 1, 50), to: Date.UTC(2027, 5, 2, 1, 50) });
const ago = (sec) => (sec >= 365 * 86400 ? `${Math.round(sec / (365 * 86400))} 年` : sec >= 86400 ? `${Math.round(sec / 86400)} 天` : `${Math.round(sec / 60)} 分鐘`);
const off = (s, id) => Math.abs(deviceTime(s, dev(s, id)).ms - (SIM_EPOCH + s.clock * 1000)) / 1000;
/** IOS 的 NTP 要好幾次輪詢才採信：在複本上讓時間走六分鐘 */
function later(s, prep) {
  const s2 = cloneState(s);
  if (prep) prep(s2);
  recompute(s2); settle(s2);
  for (let n = 0; n < 6; n++) { advance(s2, 64); settle(s2, 30); }
  return s2;
}

export const LEVELS29 = [
  {
    id: 'l101', chapter: 7, title: '換了主機板電池，VPN 就起不來了', subtitle: '用憑證驗證的 IKEv2：時鐘、CA 與 NTP', tags: ['IKEv2', 'PKI', '憑證', 'rsa-sig', 'VTI', 'NTP', '故障排除'],
    brief: '總公司和分公司之間的 VPN 用 IKEv2，兩端用 CA 簽的憑證互相驗證（不用預先共用金鑰）。上週分公司的 BR-RT 換了主機板電池，開機之後 VPN 就再也起不來，分公司打不開 ERP。兩邊的設定沒有人動過，憑證也還有一年多才到期。請讓 VPN 恢復，而且以後就算 VPN 斷了，BR-RT 的時間也要是對的；VPN 必須繼續用憑證驗證。',
    given: [
      ['HQ-RT', 'WAN 203.0.113.10/30 · 內網 10.10.0.0/24 · Tunnel0 10.255.1.1/30（VTI，IKEv2）'], ['BR-RT', 'WAN 198.51.100.6/30 · 分公司 10.20.0.0/24 · Tunnel0 10.255.1.2/30'],
      ['總公司的伺服器', 'CA（SCEP）10.10.0.7 · NTP 10.10.0.5 · ERP 10.10.0.20（HTTPS）'], ['憑證', 'trustpoint CORP：Corp Root CA 簽發，2025-06-02 起兩年有效'],
      ['網際網路', '公用的 NTP 伺服器 time.google.com（216.239.35.0）'],
    ],
    learn: [
      { t: '憑證驗證 (rsa-sig)', d: 'IKEv2 的 IKE_AUTH 階段，每一端送出自己的憑證並用私鑰簽章；對方用 trustpoint 裡 CA 的根憑證驗證簽章，再檢查有效期間。比起預先共用金鑰，新增據點只要向 CA 申請一張憑證，不用每一端都改金鑰。' },
      { t: '有效期間看的是自己的時鐘', d: '設備判斷「憑證生效了沒、到期了沒」用的是自己的時鐘。時鐘回到 2002 年，對方 2025 年才生效的憑證就變成「還沒生效」(%PKI-3-CERTIFICATE_INVALID_NOT_YET_VALID)，IKE 驗證失敗。' },
      { t: '雞生蛋', d: '分公司的 NTP 伺服器在總公司，要經過 VPN 才到得了；VPN 又要先有正確的時間才建得起來。用憑證的 VPN，時間來源一定要不經過那條 VPN：網際網路上的 NTP，或總公司對外的位址。' },
      { t: 'CA 與 SCEP', d: 'crypto pki trustpoint 指定 CA 的 enrollment url（SCEP）；crypto pki authenticate 取回 CA 的根憑證（要核對指紋）；crypto pki enroll 申請自己的憑證。revocation-check 預設會去 CA 拿撤銷清單 (CRL)：CA 在 VPN 另一邊時要改成 crl none 或 none，不然一樣是雞生蛋。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: lines(2) });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.9', mask: '255.255.255.252', assign: '203.0.113.10' });
      setLine(inet, 'line2', { type: 'static', gw: '198.51.100.5', mask: '255.255.255.252', assign: '198.51.100.6' });
      const s = makeState([
        inet,
        D('isr4331', 'hq', { name: 'HQ-RT', pos: [-7, -4] }), D('isr4331', 'br', { name: 'BR-RT', pos: [7, -4] }),
        D('sw8', 'hsw', { name: 'HQ-SW', pos: [-7, 0.5] }),
        D('tower', 'ca', { name: 'CA 伺服器', pos: [-12, 4.5], ip: '10.10.0.7', gw: '10.10.0.1', services: [{ proto: 'tcp', port: 80, name: 'SCEP（NDES）' }] }),
        D('tower', 'ntp', { name: 'NTP 伺服器', pos: [-7, 5.5], ip: '10.10.0.5', gw: '10.10.0.1', services: [{ proto: 'udp', port: 123, name: 'NTP' }] }),
        D('tower', 'erp', { name: 'ERP', pos: [-2, 4.5], ip: '10.10.0.20', gw: '10.10.0.1', services: [{ proto: 'tcp', port: 443, name: 'ERP（HTTPS）' }] }),
        D('pc', 'bpc', { name: '分公司的同仁', pos: [7, 3], ip: '10.20.0.50', gw: '10.20.0.1' }),
      ], [['inet:line1', 'hq:Gi0/0/0'], ['inet:line2', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'hsw:1'], ['ca:eth0', 'hsw:2'], ['ntp:eth0', 'hsw:3'], ['erp:eth0', 'hsw:4'], ['bpc:eth0', 'br:Gi0/0/1']]);
      s.devices.ca.ca = { ...CA, next: 3 };
      recompute(s);
      const side = (id, host, wan, gw, lan, me, peer, remote) => typeIn(s, id, ['configure terminal',
        'interface Gi0/0/0', `ip address ${wan} 255.255.255.252`, 'no shutdown', 'interface Gi0/0/1', `ip address ${lan} 255.255.255.0`, 'no shutdown', 'exit', `ip route 0.0.0.0 0.0.0.0 ${gw}`,
        'ip domain name corp.local',
        'crypto pki trustpoint CORP', 'enrollment url http://10.10.0.7:80/certsrv/mscep/mscep.dll', `subject-name CN=${host}.corp.local`, 'revocation-check none', 'exit',
        'crypto ikev2 proposal P-AES256', 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'exit', 'crypto ikev2 policy POL', 'proposal P-AES256', 'exit',
        'crypto ikev2 profile PROF', 'match identity remote fqdn domain corp.local', `identity local fqdn ${host}.corp.local`, 'authentication remote rsa-sig', 'authentication local rsa-sig', 'pki trustpoint CORP', 'exit',
        'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit', 'crypto ipsec profile VTI', 'set transform-set TS', 'set ikev2-profile PROF', 'exit',
        'interface Tunnel0', `ip address ${me} 255.255.255.252`, 'tunnel source Gi0/0/0', 'tunnel mode ipsec ipv4', `tunnel destination ${peer}`, 'tunnel protection ipsec profile VTI', 'exit',
        `ip route ${remote} 255.255.255.0 Tunnel0`, 'ntp server 10.10.0.5', 'end', 'write memory']);
      side('hq', 'hq-rt', '203.0.113.10', '203.0.113.9', '10.10.0.1', '10.255.1.1', '198.51.100.6', '10.20.0.0');
      side('br', 'br-rt', '198.51.100.6', '198.51.100.5', '10.20.0.1', '10.255.1.2', '203.0.113.10', '10.10.0.0');
      // 2025 年 6 月安裝的時候就已經 authenticate、enroll 好了
      Object.assign(s.devices.hq.pki.tps.CORP, { key: true, ca: caCert(CA), cert: installed('hq-rt.corp.local', '02') });
      Object.assign(s.devices.br.pki.tps.CORP, { key: true, ca: caCert(CA), cert: installed('br-rt.corp.local', '03') });
      fresh(s);
      // BR-RT 換了主機板電池：硬體時鐘回到 2002 年 1 月 1 日（不可信，前面有 *）
      s.dyn = { boot: true, clk: { br: { set: { at: 0, wall: Date.UTC(2002, 0, 1), rtc: true } } } };
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'bpc', to: 'erp', port: 443, label: '分公司的同仁打得開 ERP（VPN 恢復）' },
      {
        type: 'check', label: 'BR-RT 的時間是對的（和實際差不到一分鐘，不是不可信的 *）',
        test(s) {
          const ok = (st) => deviceTime(st, dev(st, 'br')).auth && off(st, 'br') < 60;
          if (ok(s)) return true;
          const s2 = later(s);
          if (ok(s2)) return true;
          const t = deviceTime(s2, dev(s2, 'br')), y = new Date(t.ms).getUTCFullYear();
          return `BR-RT 的時鐘是 ${y} 年${t.auth ? '' : '（* 不可信）'}，和實際差了 ${ago(off(s2, 'br'))}：${ntpInfo(s2, dev(s2, 'br')).why || 'NTP 還沒有同步'}`;
        },
      },
      {
        type: 'check', label: '就算 VPN 斷了，BR-RT 也對得到時（時間來源不經過這條 VPN）',
        test(s) {
          const s2 = later(s, (x) => { const t = dev(x, 'br').ifaces.find((i) => i.id === 'Tu0'); if (t) t.shut = true; const c = (x.dyn && x.dyn.clk && x.dyn.clk.br) || null; if (c) { delete c.ntp; c.set = { at: x.clock, wall: Date.UTC(2002, 0, 1), rtc: true }; } });
          const n = ntpInfo(s2, dev(s2, 'br'));
          if (!dev(s, 'br').mgmt.ntp) return 'BR-RT 沒有設定 NTP 伺服器';
          return n.synced ? true : `把 BR-RT 的 Tunnel0 關掉、時鐘回到 2002 年再試：BR-RT 對不到時（${n.why || 'NTP 伺服器沒有回應'}）。${dev(s, 'br').mgmt.ntp.startsWith('10.10.') ? 'NTP 伺服器 ' + dev(s, 'br').mgmt.ntp + ' 在總公司，要經過 VPN 才到得了' : ''}`;
        },
      },
      {
        type: 'check', label: 'VPN 仍然用憑證驗證（兩端的 ikev2 profile 都是 rsa-sig）',
        test(s) {
          for (const id of ['hq', 'br']) {
            const p = ((dev(s, id).ikev2 || {}).profs || {}).PROF || {};
            if (p.authL !== 'rsa-sig' || p.authR !== 'rsa-sig') return `${dev(s, id).name} 的 ikev2 profile PROF 不是 authentication local / remote rsa-sig：不能改回預先共用金鑰`;
          }
          return true;
        },
      },
    ],
    hints: [
      'BR-RT：show clock 是 *…2002；show logging 有 %PKI-3-CERTIFICATE_INVALID_NOT_YET_VALID（HQ-RT 的憑證 2025 年才生效）；show crypto pki certificates 的 Status 是 Not yet valid。也可以 debug crypto ikev2 看協商。',
      'BR-RT 的 NTP 伺服器 10.10.0.5 在總公司，要經過 VPN 才到得了，VPN 又因為時鐘不對建不起來。先用 clock set 把時間設對（例如 clock set 01:10:00 5 January 2026，BR-RT 用的是 UTC），VPN 就會起來。',
      '長久之計：BR-RT 的 ntp server 改成不經過 VPN 的伺服器，例如網際網路上的 216.239.35.0（time.google.com）。',
    ],
    solve(s) {
      const x = new Date(SIM_EPOCH + (s.clock || 0) * 1000);
      typeIn(s, 'br', [`clock set ${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`,
        'configure terminal', 'ntp server 216.239.35.0', 'end', 'write memory']);
    },
    recap: ['憑證的有效期間用設備自己的時鐘判斷：時鐘錯了，好好的憑證也會變成「還沒生效」或「已經到期」。', '用憑證的 VPN，時間來源（和 CRL）不能只放在那條 VPN 的另一邊。'],
  },
];
