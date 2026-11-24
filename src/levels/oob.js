// 第十一章補充：帶外管理 — Catalyst 9300 的 Gi0/0 在 Mgmt-vrf 裡，管理流量要指定 VRF 或 source-interface
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { iosSession, runningConfig } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const OOB = '192.168.100.2', USER = 'netadmin', PASS = 'Oob-Admin#26', BK = '192.168.200.20';

export const LEVELS62 = [
  {
    id: 'l142', chapter: 11, title: '核心交換器一出事，網管就連不進去', subtitle: '帶外管理：Gi0/0 與 Mgmt-vrf', tags: ['帶外管理', 'Mgmt-vrf', 'VRF', 'TFTP', 'source-interface'],
    brief: `上個月核心交換器的一條 ACL 打錯，網管中心整整兩個小時連不進去，只能派人到機房。公司已經拉好一套獨立的管理網路：Core-SW 的管理埠 Gi0/0 接到管理交換器，再經過管理路由器到網管中心。請讓網管工作站可以從管理網路 SSH 登入 Core-SW (${OOB})，設定檔每天備份到網管中心的伺服器（${BK}，TFTP），而且一般使用者的網段完全碰不到管理網路。`,
    given: [
      ['Core-SW（Catalyst 9300）', `Gi0/0 → 管理網路 192.168.100.0/24（要設 ${OOB}）· VLAN 10 使用者 10.10.10.1/24 · SSH 帳號 ${USER} / ${PASS}`],
      ['管理路由器', 'Gi0/0/0 192.168.100.1 · Gi0/0/1 網管中心 192.168.200.1'],
      ['網管中心', `網管工作站 192.168.200.10 · 備份伺服器 ${BK}（TFTP）`],
    ],
    learn: [
      { t: '帶外管理 (out-of-band)', d: '正式的網路 (in-band) 出問題時（ACL 打錯、迴圈、上行斷掉），經過它的 SSH 也一起斷。獨立的管理網路接在設備專用的管理埠上，不經過正式的網路，出事時還連得進去。' },
      { t: 'Mgmt-vrf', d: 'Catalyst 9300 的 Gi0/0 出廠就在 Mgmt-vrf 裡：它有自己的路由表，和使用者的網段完全分開（正式網路的路由看不到它，它也不會轉送使用者的流量）。要連到別的網段，路由要寫在那個 VRF：ip route vrf Mgmt-vrf 0.0.0.0 0.0.0.0 <管理網路的閘道>。' },
      { t: '管理流量要指定 VRF', d: '交換器自己送出去的 TFTP、Syslog、NTP 預設照全域的路由表走。伺服器在管理網路時，要用 ip tftp source-interface GigabitEthernet0/0、logging host <IP> vrf Mgmt-vrf、ntp server vrf Mgmt-vrf <IP>，ping 也要 ping vrf Mgmt-vrf <IP>。' },
    ],
    setup() {
      const s = makeState([
        D('c9300', 'core', {
          name: 'Core-SW', pos: [-4, -4],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'USERS' });
            d.sw.ports['Gi1/0/1'].vlan = 10; d.sw.ports['Gi1/0/1'].mode = 'access';
            d.ifaces.push(newIface('vlan10', 'Vlan10', { t: 'svi', vlan: 10 }, { ip: '10.10.10.1', mask: '255.255.255.0' }));
            Object.assign(d.mgmt, { user: USER, pass: PASS, priv: 15, sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local', telnet: false, ssh: true, snmp: 'off' });
            d.sw.stp.portfastDefault = true;
          },
        }),
        D('pc', 'user', { name: '使用者 PC', pos: [-8, 2], ip: '10.10.10.21', gw: '10.10.10.1' }),
        D('sw8', 'osw', { name: '管理交換器', pos: [2, -6] }),
        D('isr4321', 'ort', { name: '管理路由器', host: 'OOB-RT', pos: [6, -3], init(d) { Object.assign(d.ifaces[0], { ip: '192.168.100.1', mask: '255.255.255.0' }); Object.assign(d.ifaces[1], { ip: '192.168.200.1', mask: '255.255.255.0' }); } }),
        D('sw8', 'nsw', { name: '網管中心交換器', pos: [6, 2] }),
        D('pc', 'noc', { name: '網管工作站', pos: [3, 6], ip: '192.168.200.10', gw: '192.168.200.1' }),
        D('tower', 'bk', { name: '備份伺服器', pos: [9, 6], ip: BK, gw: '192.168.200.1', services: [{ proto: 'udp', port: 69, name: 'TFTP' }] }),
      ], [['core:Gi1/0/1', 'user:eth0'], ['core:Gi0/0', 'osw:1'], ['ort:Gi0/0/0', 'osw:2'], ['ort:Gi0/0/1', 'nsw:1'], ['noc:eth0', 'nsw:2'], ['bk:eth0', 'nsw:3']]);
      recompute(s);
      typeIn(s, 'core', ['enable', 'write memory']);
      return s;
    },
    objectives: [
      { type: 'login', from: 'noc', ip: OOB, proto: 'ssh', user: USER, pass: PASS, label: `網管工作站從管理網路 SSH 登入 Core-SW (${OOB})` },
      {
        type: 'check', label: `Core-SW 的設定已經經由管理網路備份到 ${BK}（core-sw-confg）`,
        test(s) {
          const f = (dev(s, 'bk').files || {})['core-sw-confg'];
          if (!f) return `備份伺服器上還沒有 core-sw-confg（Core-SW：copy running-config tftp://${BK}/core-sw-confg）`;
          return f.lines.join('\n') === runningConfig(s, dev(s, 'core')).join('\n') ? true : 'core-sw-confg 和 Core-SW 現在的設定不一樣：備份之後又改過設定，要再備份一次';
        },
      },
      { type: 'ping', from: 'user', ip: '192.168.200.10', expect: false, label: '使用者的網段碰不到網管中心' },
      { type: 'ping', from: 'user', ip: OOB, expect: false, label: '使用者也碰不到 Core-SW 的管理位址' },
    ],
    hints: [
      `Core-SW：interface GigabitEthernet0/0 → ip address ${OOB} 255.255.255.0 → no shutdown（它已經在 Mgmt-vrf 裡，show running-config interface Gi0/0 看得到 vrf forwarding Mgmt-vrf）。`,
      '網管工作站在另一個網段：回應要經過管理路由器，路由寫在 Mgmt-vrf 裡：ip route vrf Mgmt-vrf 0.0.0.0 0.0.0.0 192.168.100.1（不要寫在全域，使用者的網段才不會繞過來）。ping vrf Mgmt-vrf 192.168.200.10 測試。',
      `備份：直接 copy running-config tftp:// 會照全域的路由表送，找不到網管中心。先 ip tftp source-interface GigabitEthernet0/0，再 copy running-config tftp://${BK}/core-sw-confg。`,
    ],
    solve(s) {
      typeIn(s, 'core', ['enable', 'configure terminal', 'interface GigabitEthernet0/0', `ip address ${OOB} 255.255.255.0`, 'no shutdown', 'exit',
        'ip route vrf Mgmt-vrf 0.0.0.0 0.0.0.0 192.168.100.1', 'ip tftp source-interface GigabitEthernet0/0', 'end', 'write memory']);
      recompute(s);
      typeIn(s, 'core', ['enable', `copy running-config tftp://${BK}/core-sw-confg`, '']);
    },
    recap: [
      '帶外管理：設備的管理埠接獨立的管理網路，正式的網路出事時還連得進去。',
      'Mgmt-vrf 有自己的路由表：管理網路的路由寫在 VRF 裡，交換器自己的 TFTP / Syslog / NTP 要指定 source-interface 或 vrf，才會走管理網路。',
    ],
  },
];
