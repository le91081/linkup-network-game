// 第十章補充：VTP 的 revision 把整棟樓的 VLAN 蓋掉
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute, transact } from '../engine/sim.js';
import { cloneState } from '../engine/model.js';
import { vtpOf, vtpSig } from '../engine/vtp.js';
import { parseIp } from '../engine/ip.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const BLDG = [[10, 'SALES'], [20, 'RD'], [30, 'GUEST'], [100, 'SERVERS']];
const PASS = 'Bldg-VTP-7';
const vl = (pairs) => pairs.map(([id, name]) => ({ id, name }));

export const LEVELS42 = [
  // ════════════════════════ 10-10 ════════════════════════
  {
    id: 'l122', chapter: 10, title: '新交換器一插上去，整棟樓的 VLAN 都不見了', subtitle: 'VTP 的 revision、transparent 與密碼', tags: ['VTP', 'VLAN', 'Trunk', 'revision', '故障排除'],
    brief: `早上有人把實驗室拿回來的交換器 SW-LAB 接到 ACC2 上，沒幾秒整棟樓都斷線：所有交換器的 VLAN 10、20、30、100 都不見了，倒是多出一個實驗室的 VLAN 99。請把整棟樓的 VLAN 救回來（10 SALES、20 RD、30 GUEST、100 SERVERS），實驗室的 VLAN 99 只留在 SW-LAB 上、實驗室照常運作，並且讓以後再有這種交換器接上來，也改寫不了整棟樓的 VLAN。`,
    given: [
      ['VTP 網域', 'CORP · Core 是 server，ACC1、ACC2 是 client'], ['SW-LAB', '實驗室用過的交換器：VTP 網域也叫 CORP、模式 server、revision 比較大'],
      ['大樓的 VLAN', '10 SALES · 20 RD · 30 GUEST · 100 SERVERS（Core 上有 SVI 路由）'], ['伺服器', '10.10.100.10（VLAN 100）'],
      ['實驗室', 'VLAN 99 · 192.168.99.0/24 · 只在 SW-LAB 上'], ['VTP 密碼', `${PASS}（大樓的交換器都要設）`],
    ],
    learn: [
      { t: 'VTP', d: 'VLAN Trunking Protocol：同一個網域的 Catalyst 交換器經由 Trunk 同步 VLAN 資料庫。server 新增 / 刪除 VLAN，client 只接收；每改一次 configuration revision 加一。' },
      { t: 'revision 比較大就整份取代', d: '交換器收到同網域、revision 比自己大的通告，就把自己的 VLAN 資料庫整份換掉 — 不管對方是 server 還是 client。實驗室回來、revision 比較大的交換器一接上 Trunk，整棟樓的 VLAN 都被它蓋掉；VLAN 不見了，埠就停在不存在的 VLAN 裡 (inactive)。' },
      { t: 'transparent 與歸零', d: 'transparent 不採用別人的通告、自己的 VLAN 自己管（照樣轉送通告），revision 永遠是 0。接上舊交換器之前先切到 transparent，或改一次網域名稱，revision 就歸零。' },
      { t: 'VTP 密碼', d: 'vtp password：通告帶著用密碼算出來的 MD5 摘要，密碼不同就不同步。整個網域都設了密碼，不知道密碼的交換器 revision 再大也改寫不了。（VTP 版本 3 還有 primary server，只有它能改 VLAN）' },
    ],
    setup() {
      const svi = (d, v, ip) => d.ifaces.push(newIface('vlan' + v, 'Vlan' + v, { t: 'svi', vlan: v }, { ip, mask: '255.255.255.0' }));
      const vtp = (d, mode, rev) => { d.sw.vtp = { mode, domain: 'CORP', pass: '', ver: 1, rev }; };
      return makeState([
        D('c9300', 'core', {
          name: 'Core', pos: [0, -5],
          init(d) {
            d.sw.vlans.push(...vl(BLDG));
            vtp(d, 'server', 12);
            for (const p of ['Gi1/0/1', 'Gi1/0/2']) Object.assign(d.sw.ports[p], { mode: 'trunk', allowed: 'all' });
            Object.assign(d.sw.ports['Gi1/0/10'], { mode: 'access', vlan: 100 });
            svi(d, 10, '10.10.10.1'); svi(d, 20, '10.10.20.1'); svi(d, 100, '10.10.100.1');
          },
        }),
        D('c2960', 'acc1', {
          name: 'ACC1', pos: [-6, 0],
          init(d) {
            d.sw.vlans.push(...vl(BLDG)); vtp(d, 'client', 12);
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: 'all' });
            Object.assign(d.sw.ports['Gi0/1'], { mode: 'access', vlan: 10 });
          },
        }),
        D('c2960', 'acc2', {
          name: 'ACC2', pos: [6, 0],
          init(d) {
            d.sw.vlans.push(...vl(BLDG)); vtp(d, 'client', 12);
            for (const p of ['Gi0/9', 'Gi0/10']) Object.assign(d.sw.ports[p], { mode: 'trunk', allowed: 'all' });
            Object.assign(d.sw.ports['Gi0/1'], { mode: 'access', vlan: 20 });
          },
        }),
        D('c2960', 'lab', {
          name: 'SW-LAB', pos: [11, 3.5],
          init(d) {
            d.sw.vlans.push({ id: 99, name: 'LAB' }); vtp(d, 'server', 42);
            Object.assign(d.sw.ports['Gi0/10'], { mode: 'trunk', allowed: 'all' });
            for (const p of ['Gi0/1', 'Gi0/2']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 99 });
          },
        }),
        D('tower', 'srv', { name: '檔案伺服器', pos: [-4, -9], ip: '10.10.100.10', gw: '10.10.100.1' }),
        D('pc', 'pcs', { name: '業務 PC', pos: [-8, 5], ip: '10.10.10.21', gw: '10.10.10.1' }),
        D('pc', 'pcr', { name: '研發 PC', pos: [1.5, 6], ip: '10.10.20.21', gw: '10.10.20.1' }),
        D('laptop', 'labpc', { name: '實驗室筆電', pos: [8.5, 9.5], ip: '192.168.99.10' }),
        D('nas', 'labnas', { name: '實驗室 NAS', pos: [15, 7.5], ip: '192.168.99.20' }),
      ], [['core:Gi1/0/1', 'acc1:Gi0/9'], ['core:Gi1/0/2', 'acc2:Gi0/9'], ['acc2:Gi0/10', 'lab:Gi0/10'], ['srv:eth0', 'core:Gi1/0/10'],
        ['pcs:eth0', 'acc1:Gi0/1'], ['pcr:eth0', 'acc2:Gi0/1'], ['labpc:eth0', 'lab:Gi0/1'], ['labnas:eth0', 'lab:Gi0/2']]);
    },
    objectives: [
      { type: 'ping', from: 'pcs', to: 'srv', label: '業務 PC（VLAN 10）連得到檔案伺服器' },
      { type: 'ping', from: 'pcr', to: 'srv', label: '研發 PC（VLAN 20）連得到檔案伺服器' },
      {
        type: 'check', label: 'Core、ACC1、ACC2 都有 10 SALES、20 RD、30 GUEST、100 SERVERS，沒有實驗室的 VLAN 99',
        test(s) {
          for (const id of ['core', 'acc1', 'acc2']) {
            const d = dev(s, id);
            for (const [v, name] of BLDG) {
              const x = d.sw.vlans.find((y) => y.id === v);
              if (!x) return `${d.name} 沒有 VLAN ${v}`;
              if (x.name !== name) return `${d.name} 的 VLAN ${v} 名稱是 ${x.name}，應該是 ${name}`;
            }
            if (d.sw.vlans.some((y) => y.id === 99)) return `${d.name} 還有實驗室的 VLAN 99`;
          }
          return true;
        },
      },
      { type: 'ping', from: 'labpc', to: 'labnas', label: '實驗室照常運作：筆電連得到實驗室 NAS（VLAN 99 留在 SW-LAB）' },
      {
        type: 'check', label: '再接上一台網域也叫 CORP、revision 999 的交換器，大樓的 VLAN 也不會被蓋掉',
        test(s) {
          const s2 = cloneState(s);
          recompute(s2);
          const x = s2.devices.lab;
          x.sw.vlans = [{ id: 1, name: 'default' }, { id: 99, name: 'LAB' }];
          x.sw.vtp = { mode: 'server', domain: 'CORP', pass: '', ver: 1, rev: 999 };
          x.sw.vtp.sig = vtpSig(x);
          recompute(s2);
          const c = s2.devices.core;
          if (!c.sw.vlans.some((v) => v.id === 10)) return `Core 的 VLAN 被 revision 999 的通告整份取代了（Core 現在的 revision ${vtpOf(c).rev}）：網域要設 VTP 密碼，不知道密碼的交換器才改寫不了`;
          const t = transact(s2, 'pcs', { proto: 'icmp', dst: parseIp('10.10.100.10'), quiet: true });
          return t.ok || `業務 PC 連不到伺服器：${t.reason}`;
        },
      },
    ],
    hints: [
      'Core 的 CLI：show vtp status — revision 變成 42、最後修改的是 SW-LAB。show vlan brief 看得到 VLAN 只剩 1 和 99。',
      'SW-LAB：configure terminal → vtp mode transparent（revision 歸零，VLAN 99 留在自己身上，以後也不採用別人的通告）。',
      'Core 是 server：vlan 10 → name SALES → exit，20 RD、30 GUEST、100 SERVERS 也一樣，再 no vlan 99；revision 比 42 大，ACC1、ACC2 就會跟著更新。',
      `Core、ACC1、ACC2 都設 vtp password ${PASS}：不知道密碼的交換器 revision 再大也改寫不了。`,
    ],
    solve(s) {
      typeIn(s, 'lab', ['configure terminal', 'vtp mode transparent', 'end']);
      recompute(s);
      typeIn(s, 'core', ['configure terminal', ...BLDG.flatMap(([v, n]) => [`vlan ${v}`, `name ${n}`, 'exit']), 'no vlan 99', `vtp password ${PASS}`, 'end']);
      for (const id of ['acc1', 'acc2']) typeIn(s, id, ['configure terminal', `vtp password ${PASS}`, 'end']);
      recompute(s);
    },
    recap: ['VTP 同步的是「整份」VLAN 資料庫：revision 比較大的通告一來，不管內容是什麼都照單全收 — 少了的 VLAN 直接消失，埠變成 inactive。', '接上來路不明的交換器之前：先切 transparent（或改網域名稱）讓 revision 歸零；整個網域設 VTP 密碼。很多公司乾脆全部用 transparent，或升級到 VTP 版本 3（只有 primary server 能改）。'],
  },
];
