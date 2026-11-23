// 第七章補充：SSL-VPN 改用 Active Directory 的帳號（LDAP）— 離職的人還連得上、帳號要一處停用全部失效
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { fortiSession } from '../engine/fortios.js';
import { recompute } from '../engine/sim.js';
import { dev, WEB } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const twoLines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
const forti = (s, id, lines) => { const F = fortiSession(() => s.devices[id], () => s); for (const l of lines) F.exec(l); };
const SVC = 'svc-fortigate', SVCPW = 'Ldap#Bind2026';
const vpnOn = (who, user, pass) => (d) => { d.vpnClient = { on: true, server: '203.0.113.18', user, pass }; void who; };

export const LEVELS66 = [
  {
    id: 'l146', chapter: 7, title: '離職的同事還連得上 VPN', subtitle: 'SSL-VPN 改用 Active Directory（LDAP）', tags: ['SSL-VPN', 'LDAP', 'Active Directory', 'FortiGate', '帳號管理'],
    brief: '稽核發現：上個月離職的陳先生還連得上公司的 SSL-VPN — VPN 用的是 FortiGate 上另外建的本機帳號，人資在 AD 停用帳號時沒有人記得改這裡。請把 VPN 改成用 AD 的帳號登入（服務帳號已經建好），只有 AD 裡 VPN-Users 群組的人可以連，FortiGate 上不再留本機的 VPN 帳號。',
    given: [
      ['HQ-FW', 'SSL-VPN 已經開著（203.0.113.18:10443），本機帳號 amy、chen'],
      ['AD 網域控制站', '10.1.0.5 · corp.local（DC=corp,DC=local）· LDAP TCP 389'],
      ['服務帳號', `${SVC} / ${SVCPW}（給 FortiGate 查詢 AD 用）`],
      ['AD 群組', 'CN=VPN-Users,OU=Groups,DC=corp,DC=local（amy 在裡面；bob 是業務，不在裡面；chen 已經停用）'],
      ['在家的筆電', 'Amy、Bob、陳先生都用 AD 的帳號密碼試著連 VPN'],
    ],
    learn: [
      { t: '帳號集中管理', d: '每個系統各自建帳號，離職時一定會漏掉某一處。VPN、Wi-Fi (802.1X)、設備的管理都改用 AD（或 RADIUS / TACACS+ 再接 AD），人資在 AD 停用一次，全部一起失效。' },
      { t: 'LDAP 怎麼驗證', d: 'FortiGate 先用服務帳號登入 AD (bind)，在 dn 底下用 cnid 欄位找到使用者，確認帳號沒有停用，再用使用者輸入的密碼 bind 一次；最後看他在不在指定的群組。AD 的登入名稱欄位是 sAMAccountName（FortiGate 預設的 cnid 是 cn，對的是顯示名稱）。' },
      { t: 'FortiGate 的設定', d: 'config user ldap → edit "AD" → set server、set cnid "sAMAccountName"、set dn "DC=corp,DC=local"、set type regular、set username / password（服務帳號）。config user group → set member "AD"，再用 config match 指定 AD 的群組。' },
      { t: 'LDAP 與 LDAPS', d: 'LDAP (389) 的密碼是明文；正式環境用 LDAPS (636，set secure ldaps)，AD 要有伺服器憑證。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: twoLines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' });
      setLine(inet, 'line2', { type: 'dhcp', gw: '198.51.100.1', assign: '198.51.100.120' });
      const s = makeState([
        inet,
        D('fg60f', 'hq', {
          name: 'HQ-FW', pos: [-6, -4.5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
            Object.assign(g('internal'), { ip: '10.1.0.1', mask: '255.255.255.0' });
            d.policies.push(allow('內網上網', 'internal', 'wan1', { nat: true }), allow('VPN 到 ERP', 'vpn:remote', 'internal', { dst: '10.1.0.10', service: 'HTTPS' }));
            Object.assign(d.vpnServer, { on: true, start: '10.99.0.10', end: '10.99.0.50', subnets: '10.1.0.0/24', users: [{ user: 'amy', pass: 'Vpn#Amy2025' }, { user: 'chen', pass: 'Vpn#Chen2025' }] });
          },
        }),
        D('sw5', 'sw', { name: 'HQ-Switch', pos: [-6, 0.3] }),
        D('tower', 'dc', {
          name: 'AD 網域控制站', pos: [-10, 3], ip: '10.1.0.5', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 389, name: 'LDAP' }, { proto: 'tcp', port: 636, name: 'LDAPS' }, { proto: 'udp', port: 53, name: 'DNS' }],
          init(d) {
            d.ad = { domain: 'corp.local', base: 'DC=corp,DC=local', ldaps: true, users: [
              { user: SVC, name: 'FortiGate LDAP', pass: SVCPW, groups: ['Service Accounts'] },
              { user: 'amy', name: 'Amy Lin', pass: 'Amy#AD2026', groups: ['VPN-Users', 'Accounting'] },
              { user: 'bob', name: 'Bob Wang', pass: 'Bob#AD2026', groups: ['Sales'] },
              { user: 'chen', name: 'Chen Ming', pass: 'Chen#AD2025', groups: ['VPN-Users'], disabled: true },
            ] };
          },
        }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-3, 4.5], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('homerouter', 'home', { name: '家用路由器', pos: [7, -4], init(d) { Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' }); } }),
        D('laptop', 'amy', { name: 'Amy 的筆電', pos: [4, 2], dhcp: true, init: vpnOn('amy', 'amy', 'Amy#AD2026') }),
        D('laptop', 'bob', { name: 'Bob 的筆電', pos: [7.5, 3], dhcp: true, init: vpnOn('bob', 'bob', 'Bob#AD2026') }),
        D('laptop', 'chen', { name: '陳先生的筆電', pos: [10.5, 1.5], dhcp: true, init: vpnOn('chen', 'chen', 'Vpn#Chen2025') }),
      ], [['inet:line1', 'hq:wan1'], ['inet:line2', 'home:wan'], ['hq:1', 'sw:1'], ['dc:eth0', 'sw:2'], ['erp:eth0', 'sw:3'], ['amy:eth0', 'home:lan1'], ['bob:eth0', 'home:lan2'], ['chen:eth0', 'home:lan3']]);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'amy', to: 'erp', port: 443, label: 'Amy 用 AD 的密碼連上 VPN，打得開 ERP' },
      { type: 'tcp', from: 'chen', to: 'erp', port: 443, expect: false, label: '離職的陳先生連不上（AD 帳號已停用，本機帳號也不在了）' },
      { type: 'tcp', from: 'bob', to: 'erp', port: 443, expect: false, label: 'Bob 不在 VPN-Users 群組：連不上' },
      { type: 'check', label: 'FortiGate 上不再留本機的 VPN 帳號', test: (s) => { const u = dev(s, 'hq').vpnServer.users.filter((x) => x.user); return !u.length || `HQ-FW 還有本機帳號：${u.map((x) => x.user).join('、')}（config user local → delete）`; } },
    ],
    hints: [
      '點 Amy 的筆電 →「VPN」分頁看連線失敗的原因：她用的是 AD 的新密碼，FortiGate 只認得本機帳號的舊密碼。',
      `HQ-FW 的 CLI：config user ldap → edit "AD" → set server "10.1.0.5" → set cnid "sAMAccountName" → set dn "DC=corp,DC=local" → set type regular → set username "${SVC}@corp.local" → set password ${SVCPW} → next → end。`,
      'config user group → edit "vpn-users" → set member "AD" → config match → edit 1 → set server-name "AD" → set group-name "CN=VPN-Users,OU=Groups,DC=corp,DC=local" → next → end → next → end。最後 config user local → delete amy → delete chen → end。',
    ],
    solve(s) {
      forti(s, 'hq', ['config user ldap', 'edit "AD"', 'set server "10.1.0.5"', 'set cnid "sAMAccountName"', 'set dn "DC=corp,DC=local"', 'set type regular', `set username "${SVC}@corp.local"`, `set password ${SVCPW}`, 'next', 'end',
        'config user group', 'edit "vpn-users"', 'set member "AD"', 'config match', 'edit 1', 'set server-name "AD"', 'set group-name "CN=VPN-Users,OU=Groups,DC=corp,DC=local"', 'next', 'end', 'next', 'end',
        'config user local', 'delete amy', 'delete chen', 'end']);
    },
    recap: [
      '帳號集中在 AD：停用一次，VPN、Wi-Fi、設備管理全部一起失效；各自建本機帳號一定會漏。',
      'FortiGate 的 LDAP：服務帳號 bind、cnid 用 sAMAccountName、dn 是網域，群組用 config match 對應到 AD 的群組。',
    ],
  },
];
