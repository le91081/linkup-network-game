// 第十一章補充：AAA 與 TACACS+（集中管理網路設備的管理員：誰能登入、能做什麼、做了什麼）
import { makeDevice as D, makeState, newIface, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { aaaLogin, aaaAuthorize } from '../engine/aaa.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ISE = '10.1.98.20', KEY = 'Tac@csKey2026';
const ADMIN = { user: 'netadmin', pass: 'N3tAdm!n#26' }, VENDOR = { user: 'vendor', pass: 'V3nd0r#Read' }, LOCAL = { user: 'admin', pass: 'Sw1-Br3akGlass' };

/** 登入的結果寫成一句話（給目標的訊息用） */
const tell = (r) => `${r.reason || ''}${r.trail && r.trail.length ? `（${r.trail.join(' → ')}）` : ''}`;

export const LEVELS36 = [
  // ════════════════════════ 11-10 ════════════════════════
  {
    id: 'l116', chapter: 11, title: '外包工程師要能看設定，但不能改', subtitle: 'AAA 與 TACACS+：認證、授權、記錄', tags: ['AAA', 'TACACS+', 'ISE', '權限等級', '方法清單'],
    brief: `資安稽核要求網路設備的管理員帳號一律集中在 Cisco ISE（TACACS+），不要再一台一台建本機帳號：每個人用自己的帳號登入、每一行設定指令都要記錄。外包廠商的 vendor 帳號要能登入 SW-1 看設定（show running-config），但不能進設定模式。萬一 ISE 掛了，還是要能用 SW-1 上的本機帳號 admin 登入救火。請在 ISE 與 SW-1 上完成設定。`,
    given: [
      ['Cisco ISE', `${ISE} ·「TACACS+」分頁 · 共用密鑰 ${KEY}`], ['SW-1', '管理位址 10.1.99.11（VLAN 99）· 本機帳號 admin / Sw1-Br3akGlass（緊急用）'],
      ['ISE 上的帳號', `${ADMIN.user} / ${ADMIN.pass}（網管）· ${VENDOR.user} / ${VENDOR.pass}（外包）`], ['NetOps 工作站', '10.1.98.60 · 終端機 ssh -l <帳號> 10.1.99.11'],
    ],
    learn: [
      { t: 'AAA', d: '認證 (Authentication) 確認你是誰；授權 (Authorization) 決定你能做什麼（權限等級、能用哪些指令）；記錄 (Accounting) 留下你做了什麼。集中在 AAA 伺服器管理：有人離職，只要在伺服器停用一個帳號，所有設備都登不進去。' },
      { t: 'TACACS+ 與 RADIUS', d: 'TACACS+ 走 TCP 49，整個封包都加密，認證、授權、記錄分開進行，可以一行一行指令授權 — 適合管理網路設備。RADIUS 走 UDP 1812 / 1813，只加密密碼，認證和授權合在一起 — 適合使用者上網（802.1X、Wi-Fi、VPN）。' },
      { t: '方法清單與備援', d: 'aaa authentication login default group tacacs+ local：先問 TACACS+，伺服器「連不到或沒回應」(ERROR) 才改用本機帳號；伺服器回答「帳號密碼錯誤」(FAIL) 就直接拒絕，不會再試本機帳號。清單裡少了 local，ISE 一掛所有人都進不去。' },
      { t: '權限等級', d: 'IOS 有 0 – 15 級：1 是使用者模式 (>)，只能看一部分；15 是特權模式 (#)。aaa new-model 之後，登入的權限由 aaa authorization exec 決定（ISE 的 shell profile）；沒設定的話一律是 1 級，要 enable。aaa authorization commands 15 讓每一行 15 級的指令都先問 ISE（command set）。' },
    ],
    setup() {
      const svi = (d, v, ip) => d.ifaces.push(newIface('vlan' + v, 'Vlan' + v, { t: 'svi', vlan: v }, { ip, mask: '255.255.255.0' }));
      return makeState([
        D('c9300', 'core', {
          name: 'Core', pos: [0, -4],
          init(d) {
            d.sw.vlans.push({ id: 98, name: 'DATACENTER' }, { id: 99, name: 'MGMT' });
            Object.assign(d.sw.ports['Gi1/0/1'], { mode: 'trunk', allowed: 'all' });
            for (const p of ['Gi1/0/10', 'Gi1/0/11', 'Gi1/0/12']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 98 });
            svi(d, 98, '10.1.98.1'); svi(d, 99, '10.1.99.1');
          },
        }),
        D('c2960', 'sw1', {
          name: 'SW-1', pos: [8, 1.5],
          init(d) {
            d.sw.vlans.push({ id: 99, name: 'MGMT' });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: 'all' });
            const i = d.ifaces.find((x) => x.id === 'mgmt');
            i.bind.vlan = 99;
            Object.assign(i, { ip: '10.1.99.11', mask: '255.255.255.0', gateway: '10.1.99.1' });
            Object.assign(d.mgmt, { user: LOCAL.user, pass: LOCAL.pass, priv: 15 });
          },
        }),
        D('tower', 'ise', {
          name: 'Cisco ISE', pos: [-8, -9], ip: ISE, gw: '10.1.98.1',
          // 網路設備只登記了 Core；外包的帳號還是 1 級、什麼指令都能用
          init(d) { d.tacacsServer = { key: KEY, clients: ['10.1.99.1'], users: [{ ...ADMIN, priv: 15, cmds: 'all' }, { ...VENDOR, priv: 1, cmds: 'all' }], log: [] }; },
        }),
        D('laptop', 'ops', { name: 'NetOps 工作站', pos: [-9, 2], ip: '10.1.98.60', gw: '10.1.98.1' }),
        D('laptop', 'vend', { name: '外包工程師', pos: [-4, 5.5], ip: '10.1.98.70', gw: '10.1.98.1' }),
      ], [['core:Gi1/0/1', 'sw1:Gi0/9'], ['ise:eth0', 'core:Gi1/0/10'], ['ops:eth0', 'core:Gi1/0/11'], ['vend:eth0', 'core:Gi1/0/12']]);
    },
    objectives: [
      {
        type: 'check', label: `網管 ${ADMIN.user} 用 ISE 的帳號登入 SW-1，直接是 15 級（#）`,
        test(s) {
          const d = dev(s, 'sw1');
          if (!(d.aaa && d.aaa.on)) return 'SW-1 還沒有 aaa new-model';
          const r = aaaLogin(s, d, ADMIN.user, ADMIN.pass);
          if (!r.ok) return `${ADMIN.user} 登不進 SW-1：${tell(r)}`;
          if (r.via !== 'tacacs') return `${ADMIN.user} 是用 ${r.via} 登入的，不是 ISE（TACACS+）`;
          return r.priv === 15 || `${ADMIN.user} 登入之後是 ${r.priv} 級：要用 aaa authorization exec default group tacacs+ local 讓 ISE 決定權限等級`;
        },
      },
      {
        type: 'check', label: `外包 ${VENDOR.user} 可以 show running-config，但不能進設定模式`,
        test(s) {
          const d = dev(s, 'sw1');
          if (!(d.aaa && d.aaa.on)) return 'SW-1 還沒有 aaa new-model';
          const r = aaaLogin(s, d, VENDOR.user, VENDOR.pass);
          if (!r.ok) return `${VENDOR.user} 登不進 SW-1：${tell(r)}`;
          if (r.via !== 'tacacs') return `${VENDOR.user} 不是透過 ISE 登入的`;
          if (r.priv < 15) return `${VENDOR.user} 登入之後是 ${r.priv} 級（使用者模式 >）：看不到 show running-config。ISE 上要給 15 級，再用指令授權限制只能 show`;
          if (aaaAuthorize(s, d, VENDOR.user, 15, 'show running-config')) return `${VENDOR.user} 不能 show running-config`;
          return !!aaaAuthorize(s, d, VENDOR.user, 15, 'configure terminal') || `${VENDOR.user} 還可以 configure terminal：ISE 上要限制只能 show，SW-1 要有 aaa authorization commands 15 default group tacacs+ local`;
        },
      },
      {
        type: 'check', label: 'ISE 掛了的時候，還能用 SW-1 的本機帳號 admin 登入',
        test(s) {
          if (!(dev(s, 'sw1').aaa && dev(s, 'sw1').aaa.on)) return 'SW-1 還沒有 aaa new-model';
          const s2 = cloneState(s);
          (s2.down ||= {}).ise = true;
          recompute(s2);
          const r = aaaLogin(s2, s2.devices.sw1, LOCAL.user, LOCAL.pass);
          if (!r.ok) return `把 ISE 關機之後，admin 登不進 SW-1：${tell(r)}`;
          return r.priv === 15 || `ISE 掛了改用本機帳號登入，但只有 ${r.priv} 級：aaa authorization exec 的清單也要有 local`;
        },
      },
      {
        type: 'check', label: '每一行 15 級的指令都記錄到 ISE（accounting）',
        test(s) {
          const a = dev(s, 'sw1').aaa || {};
          return (a.on && a.acctCmd) ? true : 'SW-1 還沒有 aaa accounting commands 15 default start-stop group tacacs+';
        },
      },
    ],
    hints: [
      `ISE →「TACACS+」分頁：網路設備只登記了 Core 的 10.1.99.1，要加上 SW-1 的 10.1.99.11（沒有登記的設備，ISE 不會回應）。外包的 ${VENDOR.user} 改成權限 15、只能 show。`,
      `SW-1 的 CLI：configure terminal → aaa new-model → tacacs server ISE → address ipv4 ${ISE} → key ${KEY} → exit。`,
      'aaa authentication login default group tacacs+ local（ISE 連不到才改用本機帳號）→ aaa authorization exec default group tacacs+ local（登入之後的權限由 ISE 決定）。',
      'aaa authorization commands 15 default group tacacs+ local → aaa accounting commands 15 default start-stop group tacacs+。先別關掉 console，從 NetOps 工作站 ssh -l netadmin 10.1.99.11 試試看；ISE 的「指令記錄」會出現你打的指令。',
    ],
    solve(s) {
      const t = dev(s, 'ise').tacacsServer;
      t.clients.push('10.1.99.11');
      Object.assign(t.users.find((u) => u.user === VENDOR.user), { priv: 15, cmds: 'show' });
      typeIn(s, 'sw1', ['configure terminal', 'aaa new-model', 'tacacs server ISE', `address ipv4 ${ISE}`, `key ${KEY}`, 'exit',
        'aaa authentication login default group tacacs+ local', 'aaa authorization exec default group tacacs+ local',
        'aaa authorization commands 15 default group tacacs+ local', 'aaa accounting commands 15 default start-stop group tacacs+', 'end']);
      recompute(s);
    },
    recap: ['AAA 把管理員集中在 ISE：TACACS+（TCP 49、整個加密、可以一行一行授權）管設備，RADIUS 管使用者上網。', '方法清單 group tacacs+ local：伺服器連不到才用本機帳號；權限由 aaa authorization exec 決定，指令由 aaa authorization commands 15 把關，accounting 記下每一行。'],
  },
];
