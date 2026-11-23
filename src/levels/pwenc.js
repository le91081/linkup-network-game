// 第六章補充：設定檔裡的密碼 — enable secret 與 enable password、username secret、service password-encryption、min-length
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession, runningConfig, saveStartup } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { localUsers } from '../engine/ops.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const RT = '10.0.99.1';
const cfg = (s) => runningConfig(s, dev(s, 'rt')).join('\n');

export const LEVELS69 = [
  {
    id: 'l149', chapter: 6, title: '稽核報告：設定檔裡的密碼看得一清二楚', subtitle: 'enable secret、username secret 與 service password-encryption', tags: ['設備加固', '密碼', 'enable secret', 'type 7', 'service password-encryption'],
    brief: '外部稽核拿到分公司路由器 R1 的設定檔備份，裡面的 enable 密碼、管理帳號和 vty 密碼全部是明文，稽核要求改善：enable 改用 secret、本機帳號用不可逆的雜湊、設定檔裡不能再出現任何明文密碼，密碼至少 10 個字元。管理員的帳號密碼不要改（netadmin / NetAdmin#2026），改完之後還要能 SSH 登入。',
    given: [
      ['R1', `${RT} · SSH 已經可以用`], ['目前的設定', 'enable password cisco123、username netadmin password 0 NetAdmin#2026、line vty 的 password Vty#2026'],
      ['新的 enable 密碼', 'Enable#Secret2026'], ['管理員的電腦', '10.0.99.10'],
    ],
    learn: [
      { t: 'password 與 secret', d: 'enable password、username … password 是可逆的：沒有 service password-encryption 是明文；有的話也只是 type 7，網路上隨便一個解碼器就能還原。enable secret、username … secret 存的是雜湊（type 9 scrypt），還原不回來。兩個都有時，enable secret 優先。' },
      { t: 'service password-encryption', d: '把設定檔裡剩下的可逆密碼（line 的 password、enable password、username … password）改用 type 7 顯示，避免被旁邊的人看到。只是遮住，不是加密；關掉之後已經變成 type 7 的不會變回明文。' },
      { t: 'security passwords min-length', d: '之後設定的密碼少於這個長度就會被拒絕（% Password too short）。已經設好的不受影響。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -3],
          init(d) {
            Object.assign(d.ifaces[1], { ip: RT, mask: '255.255.255.0' });
            Object.assign(d.mgmt, { sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local', telnet: false, ssh: true });
          },
        }),
        D('sw8', 'sw', { name: 'Switch', pos: [0, 1] }),
        D('pc', 'adm', { name: '管理員的電腦', pos: [-5, 4], ip: '10.0.99.10', gw: RT }),
      ], [['rt:Gi0/0/1', 'sw:1'], ['adm:eth0', 'sw:2']]);
      recompute(s);
      typeIn(s, 'rt', ['enable', 'configure terminal', 'no service password-encryption', 'enable password cisco123', 'username netadmin privilege 15 password NetAdmin#2026', 'line vty 0 4', 'password Vty#2026', 'login local', 'exit', 'end']);
      saveStartup(s.devices.rt);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'login', from: 'adm', ip: RT, proto: 'ssh', user: 'netadmin', pass: 'NetAdmin#2026', label: '管理員照樣可以 SSH 登入（netadmin）' },
      {
        type: 'check', label: 'enable 用 secret，沒有 enable password',
        test(s) { const m = dev(s, 'rt').mgmt; if (m.enablePass) return '還有 enable password（可逆）：no enable password'; return m.enableSecret === 'Enable#Secret2026' || 'enable secret 要設成 Enable#Secret2026'; },
      },
      {
        type: 'check', label: '本機帳號用 secret（雜湊）',
        test(s) { const bad = localUsers(dev(s, 'rt').mgmt).filter((u) => u.kind === 'password'); return !bad.length || `${bad.map((u) => u.user).join('、')} 還是 password（可逆）：username … secret`; },
      },
      {
        type: 'check', label: '設定檔裡沒有明文密碼',
        test(s) { const l = cfg(s).split('\n').find((x) => /\bpassword (?!7 )/.test(x) && !/^ip ftp password|^no /.test(x.trim())); return !l || `running-config 裡還有明文的密碼：${l.trim()}（service password-encryption）`; },
      },
      { type: 'check', label: '密碼至少 10 個字元（security passwords min-length 10）', test: (s) => +(dev(s, 'rt').mgmt.minLen || 0) >= 10 || '還沒有 security passwords min-length 10' },
    ],
    hints: [
      'R1：show running-config | include password|secret，看看哪幾行是明文。',
      'configure terminal → enable secret Enable#Secret2026 → no enable password → username netadmin privilege 15 secret NetAdmin#2026（同一個帳號改成 secret）。',
      'service password-encryption（vty 的 password 變成 type 7）→ security passwords min-length 10 → end → write memory。',
    ],
    solve(s) {
      typeIn(s, 'rt', ['enable', 'configure terminal', 'enable secret Enable#Secret2026', 'no enable password', 'username netadmin privilege 15 secret NetAdmin#2026', 'service password-encryption', 'security passwords min-length 10', 'end', 'write memory']);
    },
    recap: [
      'enable secret、username … secret 存雜湊；password 是可逆的，service password-encryption 也只是 type 7 的遮蔽。',
      '用 security passwords min-length 強制密碼長度；設定檔備份也要當成機密資料保管。',
    ],
  },
];
