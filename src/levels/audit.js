// 第 11 章補充：是誰動了設定？（設定封存、設定變更紀錄、精準還原）
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { iosSession, iosDirty } from '../engine/ios.js';
import { localUsers } from '../engine/ops.js';
import { dev } from './util.js';

const ERP = '10.0.99.20', SYSLOG = '10.0.99.30';
const ADMINS = { netadmin: 'N3t@dmin!26', alice: 'Al1ce#Ops', bob: 'B0b#Ops26', carol: 'Car0l#Ops' };
const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
/** 用某個人的身分在 R1 上打指令（who 是 null 就是 console） */
const typeAs = (s, who, lines) => { const S = iosSession(() => s.devices.rt, () => s, who); for (const l of lines) S.exec(l); recompute(s); };

export const LEVELS14 = [
  {
    id: 'l65', chapter: 11, title: '是誰動了設定？', subtitle: '設定封存、變更紀錄與精準還原', tags: ['archive', 'archive log config', 'Syslog', 'configure replace'], noDrill: true,
    brief: '今天一早，業務部全部連不上 ERP。昨天有三位同事（alice、bob、carol）用自己的帳號登入過 R1 做維護，可是沒有人承認改過什麼。R1 早就開了設定封存與變更紀錄：請查出是誰、改了哪一行，只把那一個變更拿掉，其他人做的正常維護要保留；照公司規定停用那個人在 R1 上的帳號，最後存檔。',
    given: [
      ['R1 的帳號', 'netadmin（你）、alice、bob、carol'], ['ERP', `${ERP} · HTTPS`], ['Syslog 伺服器', `${SYSLOG}（R1 的變更紀錄也會送到這裡）`],
      ['會議室', 'VLAN 30 · 10.0.30.0/24（昨天新增的）'], ['封存', 'flash:archive-1、-2、-3（每次 write memory 自動封存）'],
    ],
    learn: [
      { t: '設定封存 (archive)', d: 'archive → path flash:archive → write-memory：每次 write memory 自動在 flash 留一份完整的設定，最多留 maximum 份。show archive 看有哪些。' },
      { t: '比對差異', d: 'show archive config differences flash:archive-2 flash:archive-3：+ 是只在後面那份的、- 是只在前面那份的，兩份都有的區塊（例如同一個介面）只列出不一樣的行。不加參數就是 startup-config 對 running-config。' },
      { t: '設定變更紀錄', d: 'archive → log config → logging enable：每一行設定指令都會記下「哪一個工作階段、誰、從哪一條線（console / vty）、打了什麼」，show archive log config all 查看。notify syslog 會同時送到 Syslog 伺服器，設備被重灌也查得到；hidekeys 讓密碼不會以明文留在紀錄裡。' },
      { t: '還原要精準', d: 'configure replace flash:archive-2 會把整份設定換回那個時間點，連之後別人做的正常變更也一起不見。先看差異，只拿掉有問題的那幾行。' },
      { t: '一人一個帳號', d: '大家共用一個 admin，紀錄上就只會看到 admin。每個人用自己的帳號登入，出事的時候才查得出是誰。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -6.5],
          init(d) {
            sub(d, 'Gi0/0/1', 10, '10.0.10.1'); sub(d, 'Gi0/0/1', 20, '10.0.20.1'); sub(d, 'Gi0/0/1', 99, '10.0.99.1');
            // 和其他關卡一樣「前任已經設好」的遠端管理；要在產生歷史紀錄之前就設好，封存檔裡才會有
            Object.assign(d.mgmt, { syslog: SYSLOG, sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local', snmp: 'v2c', community: 'public' });
          },
        }),
        D('c2960', 'sw', {
          name: 'SW-Core', pos: [0, -1.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'RD' }, { id: 20, name: 'Sales' }, { id: 30, name: 'Meeting' }, { id: 99, name: 'Servers' });
            Object.assign(d.sw.ports, {});
            for (const [p, v] of [['Gi0/1', 10], ['Gi0/2', 20], ['Gi0/3', 30], ['Gi0/4', 99], ['Gi0/5', 99]]) d.sw.ports[p].vlan = v;
            d.sw.ports['Gi0/9'].mode = 'trunk';
            d.sw.stp.portfastDefault = true;
            Object.assign(d.mgmt, { sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local', snmp: 'v2c', community: 'public' });
          },
        }),
        D('pc', 'pc-r', { name: '研發 PC', pos: [-10, 4], ip: '10.0.10.10', gw: '10.0.10.1' }),
        D('pc', 'pc-s', { name: '業務 PC', pos: [-5, 5], ip: '10.0.20.10', gw: '10.0.20.1' }),
        D('laptop', 'pc-m', { name: '會議室筆電', pos: [0, 5.6], ip: '10.0.30.10', gw: '10.0.30.1' }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [5.5, 4.6], ip: ERP, gw: '10.0.99.1', services: [{ proto: 'tcp', port: 443, name: 'ERP (HTTPS)' }] }),
        D('tower', 'log', { name: 'Syslog 伺服器', pos: [10, 3.4], ip: SYSLOG, gw: '10.0.99.1', services: [{ proto: 'udp', port: 514, name: 'Syslog' }] }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['pc-r:eth0', 'sw:Gi0/1'], ['pc-s:eth0', 'sw:Gi0/2'], ['pc-m:eth0', 'sw:Gi0/3'], ['erp:eth0', 'sw:Gi0/4'], ['log:eth0', 'sw:Gi0/5']]);
      // ── 事情的經過（真的在 CLI 上打過一遍，封存檔、變更紀錄與 Syslog 都是這樣產生的） ──
      s.clock = -2 * 86400;
      recompute(s);
      typeAs(s, null, ['configure terminal', 'archive', 'path flash:archive', 'write-memory', 'log config', 'logging enable', 'notify syslog contenttype plaintext', 'hidekeys', 'exit', 'exit',
        ...Object.entries(ADMINS).map(([u, p]) => `username ${u} privilege 15 secret ${p}`), 'end', 'write memory']);
      // 昨天下午：alice 替新的會議室開了 VLAN 30 的閘道（正常的維護）
      s.clock = -86400 + 14 * 3600;
      typeAs(s, { user: 'alice', line: 'vty 0', ip: '10.0.10.51' }, ['configure terminal', 'interface Gi0/0/1.30', 'encapsulation dot1Q 30', 'ip address 10.0.30.1 255.255.255.0', 'end', 'write memory']);
      // 昨天傍晚：carol 補上 SNMP 的位置資訊（正常的維護，沒有存檔）
      s.clock = -86400 + 17 * 3600;
      typeAs(s, { user: 'carol', line: 'vty 1', ip: '10.0.10.52' }, ['configure terminal', 'snmp-server location 3F-IDF-Rack2', 'end']);
      // 昨天深夜：bob 在業務部的子介面上套了一條 ACL，擋掉了 ERP，還存了檔
      s.clock = -86400 + 23 * 3600 + 12 * 60;
      typeAs(s, { user: 'bob', line: 'vty 0', ip: '10.0.20.66' }, ['configure terminal', 'ip access-list extended SALES-IN', `deny tcp any host ${ERP} eq 443`, 'permit ip any any', 'exit',
        'interface Gi0/0/1.20', 'ip access-group SALES-IN in', 'end', 'write memory']);
      // 關卡從「今天早上」開始：留下紀錄與封存檔，其他執行期的狀態重新開始
      const keep = {};
      for (const k of ['cfglog', 'cfglogN', 'cfgSess', 'log', 'logSeq', 'syslog']) if (s.dyn[k] != null) keep[k] = s.dyn[k];
      s.dyn = { boot: true, ...keep };
      delete s.rt; s.clock = 0;
      for (const d of Object.values(s.devices)) delete d.rt;
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc-s', to: 'erp', port: 443, label: '業務部可以使用 ERP (HTTPS)' },
      { type: 'tcp', from: 'pc-m', to: 'erp', port: 443, label: '會議室（昨天新增的 VLAN 30）也連得到 ERP' },
      { type: 'tcp', from: 'pc-r', to: 'erp', port: 443, label: '研發部可以使用 ERP' },
      {
        type: 'check', label: '停用改壞設定的那個帳號，其他人的帳號保留',
        test(s) {
          const names = localUsers(dev(s, 'rt').mgmt).map((u) => u.user);
          for (const u of ['netadmin', 'alice', 'carol']) if (!names.includes(u)) return `${u} 的帳號被刪掉了：${u === 'netadmin' ? '那是你自己的帳號' : `${u} 昨天做的是正常的維護`}`;
          return !names.includes('bob') || 'R1 上還留著改壞設定的那個人的帳號（show archive log config all 查得到是誰）';
        },
      },
      { type: 'check', label: 'R1 已經存檔（也會自動封存一份）', test: (s) => (iosDirty(s, dev(s, 'rt')) ? 'R1 還有沒存檔的變更：write memory' : true) },
      // carol 昨天的變更沒有存檔就下線了：存檔之後也一起存進去，這是對的（她的變更是正常的）
      { type: 'check', label: 'carol 的 SNMP 位置資訊還在', test: (s) => (dev(s, 'rt').mgmt.location === '3F-IDF-Rack2' ? true : 'carol 加的 snmp-server location 不見了：她做的是正常的維護（是不是整份 configure replace 了？）') },
    ],
    hints: [
      'R1 的 CLI：show archive 看有哪些封存檔，再 show archive config differences flash:archive-2 flash:archive-3 比較最後兩次存檔之間改了什麼。',
      'show archive log config all 看每一行是誰打的：SALES-IN 那幾行和 ip access-group 是 bob@vty0。alice 的 Gi0/0/1.30 和 carol 的 snmp-server location 都是正常的維護，不要動。',
      'configure terminal → interface Gi0/0/1.20 → no ip access-group SALES-IN in（ACL 本身也可以 no ip access-list extended SALES-IN）→ exit → no username bob → end → write memory。用 configure replace flash:archive-2 會連 carol 的變更一起還原掉；archive-1 連會議室都會斷。',
    ],
    solve(s) {
      recompute(s);
      typeAs(s, null, ['configure terminal', 'interface Gi0/0/1.20', 'no ip access-group SALES-IN in', 'exit', 'no ip access-list extended SALES-IN', 'no username bob', 'end', 'write memory']);
    },
    recap: ['封存讓你知道「改了什麼」，變更紀錄讓你知道「是誰、什麼時候」。', '還原只拿掉有問題的那一行；configure replace 是整份換掉，別人的正常變更也會一起消失。'],
  },
];
