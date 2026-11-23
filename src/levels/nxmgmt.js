// 第十一章補充：Nexus 的 mgmt0 — vrf context management 要有自己的預設路由；Syslog / NTP 要 use-vrf management
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { parseIp } from '../engine/ip.js';
import { transact } from '../engine/sim.js';
import { mgmtSpec } from '../engine/mgmtsrc.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const MG = '10.99.0.21', LOG = '10.99.1.20';

export const LEVELS79 = [
  {
    id: 'l159', chapter: 11, title: 'Leaf 的管理介面，只有隔壁連得到', subtitle: 'Nexus 的 mgmt0 與 vrf context management', tags: ['NX-OS', 'mgmt0', 'VRF', '帶外管理', 'Syslog'],
    brief: `新上架的 Leaf-1（Nexus 93180）只接了帶外管理埠 mgmt0（${MG}），還沒有接正式的網路。安裝的工程師說「管理介面設好了，我在機櫃旁邊用筆電 ping 得到」。可是網管中心（另一個網段）SSH 連不上，Syslog 伺服器也沒有收到 Leaf-1 的任何紀錄。請讓網管中心連得到 Leaf-1 的 mgmt0，並且讓 Leaf-1 的紀錄送到 Syslog 伺服器 ${LOG}。`,
    given: [
      ['Leaf-1 mgmt0', `${MG}/24（vrf management）`], ['管理網路', '10.99.0.0/24 · 閘道 10.99.0.1（R-MGMT）'],
      ['網管中心', '10.99.1.0/24 · 網管工作站 10.99.1.10 · Syslog 伺服器 10.99.1.20'],
    ],
    learn: [
      { t: 'mgmt0 在自己的 VRF', d: 'Nexus 的帶外管理埠 mgmt0 一律在 vrf management 裡，和正式網路的路由表 (default) 完全分開。所以全域的 ip route 對它沒有用：管理網路的預設路由要寫在 vrf context management 底下。' },
      { t: 'NX-OS 的寫法', d: 'vrf context management → ip route 0.0.0.0/0 10.99.0.1；interface mgmt0 → vrf member management → ip address 10.99.0.21/24（NX-OS 可以用 /長度）。show ip route vrf management、ping 10.99.1.10 vrf management。' },
      { t: '管理流量也要指定 VRF', d: 'Nexus 自己送出去的 Syslog、NTP、TACACS+ 預設查 default 這個路由表，管理伺服器只在管理網路的話就送不到：logging server 10.99.1.20 6 use-vrf management、ntp server <IP> use-vrf management。' },
      { t: '和 Catalyst 的差別', d: 'Catalyst 9300 的帶外管理埠是 Gi0/0，在 Mgmt-vrf 裡，寫法是 vrf forwarding Mgmt-vrf、ip route vrf Mgmt-vrf …、logging host <IP> vrf Mgmt-vrf。觀念一樣，指令不一樣。' },
    ],
    setup() {
      const s = makeState([
        D('n93180', 'leaf', { name: 'Leaf-1', pos: [-6, -4] }),
        D('sw8', 'osw', { name: 'SW-OOB', pos: [-1, -0.5] }),
        D('isr4321', 'ort', { name: 'R-MGMT', pos: [4, -4], init(d) { for (const [id, ip] of [['Gi0/0/0', '10.99.0.1'], ['Gi0/0/1', '10.99.1.1']]) Object.assign(d.ifaces.find((i) => i.id === id), { ip, mask: '255.255.255.0' }); } }),
        D('sw8', 'nsw', { name: 'SW-NOC', pos: [6, 1] }),
        D('pc', 'noc', { name: '網管工作站', pos: [4, 5], ip: '10.99.1.10', gw: '10.99.1.1' }),
        D('tower', 'log', { name: 'Syslog 伺服器', pos: [9, 5], ip: LOG, gw: '10.99.1.1', services: [{ proto: 'udp', port: 514, name: 'Syslog' }] }),
        D('laptop', 'nb', { name: '工程師的筆電', pos: [-4, 4], ip: '10.99.0.50', gw: '10.99.0.1' }),
      ], [['leaf:mgmt0', 'osw:1'], ['ort:Gi0/0/0', 'osw:2'], ['nb:eth0', 'osw:3'], ['ort:Gi0/0/1', 'nsw:1'], ['noc:eth0', 'nsw:2'], ['log:eth0', 'nsw:3']]);
      typeIn(s, 'leaf', ['enable', 'configure terminal', 'interface mgmt0', 'vrf member management', `ip address ${MG}/24`, 'exit', `logging server ${LOG} 6`, 'end']);
      s.devices.leaf.mgmt.sshKey = { bits: 2048 }; // NX-OS 開機就產生 SSH 的金鑰
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'nb', ip: MG, port: 22, label: '工程師的筆電（同一個網段）連得到 mgmt0' },
      { type: 'tcp', from: 'noc', ip: MG, port: 22, label: `網管工作站（另一個網段）SSH 連得到 Leaf-1 的 mgmt0（${MG}）` },
      {
        type: 'check', label: `Leaf-1 的 Syslog 經由管理網路送得到 ${LOG}`,
        test(s) {
          const d = dev(s, 'leaf');
          if (d.mgmt.syslog !== LOG) return `Leaf-1 的 Syslog 伺服器不是 ${LOG}`;
          const r = transact(s, 'leaf', { proto: 'udp', dst: parseIp(LOG), dport: 514, quiet: true, ...mgmtSpec(d, 'syslog') });
          return r.ok && r.responder === 'log' ? true : `Leaf-1 送不到 Syslog 伺服器：${r.reason}${d.mgmt.syslogVrf ? '' : '（logging server 沒有指定 use-vrf management：查的是 default 的路由表）'}`;
        },
      },
      {
        type: 'check', label: '預設路由寫在 vrf context management 底下（不是全域）',
        test(s) {
          const rs = dev(s, 'leaf').routes || [];
          if (!rs.some((r) => r.vrf === 'management' && r.dst === '0.0.0.0' && r.via === '10.99.0.1')) return 'vrf context management 底下還沒有 ip route 0.0.0.0/0 10.99.0.1';
          return true;
        },
      },
    ],
    hints: [
      'Leaf-1 的 CLI：show ip route vrf management 只有 10.99.0.0/24 直連。回到 10.99.1.0/24 的封包沒有路可以走：同網段的筆電通，網管中心不通。',
      'configure terminal → vrf context management → ip route 0.0.0.0/0 10.99.0.1（全域的 ip route 進的是 default 的路由表，mgmt0 用不到）。',
      `Syslog：logging server ${LOG} 6 use-vrf management。show logging server 看設定，Syslog 伺服器的「Syslog」分頁看收到的紀錄。`,
    ],
    solve(s) {
      typeIn(s, 'leaf', ['enable', 'configure terminal', 'vrf context management', 'ip route 0.0.0.0/0 10.99.0.1', 'exit', `logging server ${LOG} 6 use-vrf management`, 'end']);
    },
    recap: ['Nexus 的 mgmt0 在 vrf management：預設路由要寫在 vrf context management 底下。', '設備自己送出的 Syslog、NTP 也要 use-vrf management，不然查的是正式網路的路由表。'],
  },
];
