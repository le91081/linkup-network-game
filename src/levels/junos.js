// 第十章補充：Cisco 和 Juniper 接在一起 — Junos 不會 DTP、改完要 commit、Junos 的 trunk 預設沒有 native VLAN
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { applyJunos, junosDirty } from '../engine/junos.js';
import { dev, WEB } from './util.js';

const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ACTIVE = ['set system host-name BR-EX', 'set vlans default vlan-id 1', 'set protocols rstp', 'set vlans v10 vlan-id 10', 'set vlans v20 vlan-id 20', 'set vlans mgmt vlan-id 99',
  'set vlans mgmt l3-interface irb.0', 'set interfaces irb unit 0 family inet address 10.0.99.21/24',
  'set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members v10', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members v20',
  'set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members v10'];

export const LEVELS81 = [
  {
    id: 'l161', chapter: 10, title: '換成 Juniper 之後，什麼都不通', subtitle: 'Cisco 與 Juniper 的 Trunk：DTP、commit 與 native VLAN', tags: ['Juniper', 'Junos', 'Trunk', 'DTP', 'Native VLAN', 'commit'],
    brief: '分公司的存取交換器換成了 Juniper EX2300（BR-EX），上游還是原本的 Cisco Catalyst（SW-Core）。廠商的工程師在 BR-EX 上設好 VLAN 和 Trunk 就走了，說「Juniper 和 Cisco 都是標準的 802.1Q，一定會通」。結果 PC-A、PC-B 都連不到伺服器，管理員也連不到 BR-EX 的管理位址。請修好（管理 VLAN 99 要照公司的規定，在 Trunk 上當 native VLAN、不加標籤）。',
    given: [
      ['VLAN', '10 業務（PC-A）、20 研發（PC-B）、30 伺服器、99 管理（native VLAN，不加標籤）'],
      ['SW-Core Gi0/1 ↔ BR-EX ge-0/0/0', 'Trunk · native VLAN 99'], ['BR-EX', 'ge-0/0/1 → PC-A（VLAN 10）、ge-0/0/2 → PC-B（VLAN 20）· 管理位址 irb.0 10.0.99.21'],
      ['伺服器', '10.0.30.10（SW-Core Gi0/2）'], ['管理員筆電', '10.0.99.50（SW-Core Gi0/3）'],
    ],
    learn: [
      { t: 'Junos 不會 DTP', d: 'Catalyst 出廠是 dynamic auto：對面送 DTP 說「我要 Trunk」它才變成 Trunk。Juniper（還有大部分別家的交換器）不送 DTP，Catalyst 那一端就一直停在 Access。和別家設備接 Trunk，Cisco 這邊一定要寫死 switchport mode trunk。' },
      { t: 'commit 才生效', d: 'Junos 的 set / delete 改的是候選設定 (candidate)，commit 之後才生效。show | compare 看還沒 commit 的差異，rollback 回到之前的版本。設完沒 commit 就離開，設定還在候選裡，交換器照舊。' },
      { t: 'native VLAN', d: 'Cisco 的 Trunk 有 native VLAN（預設 1，這裡改成 99），那個 VLAN 的訊框不加標籤。Junos 的 trunk 預設沒有 native VLAN：不帶標籤的訊框直接丟掉。要用 native-vlan-id 99，而且 VLAN 99 也要放進 vlan members。兩邊的 native VLAN 要一樣。' },
      { t: 'Junos 常用指令', d: 'show vlans、show interfaces terse、show ethernet-switching table（MAC 表）、show configuration | display set；設定模式：set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk / vlan members v10、set interfaces ge-0/0/0 native-vlan-id 99、commit。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [-8, -6], init(d) { for (const v of [10, 20, 30, 99]) sub(d, 'Gi0/0/1', v, `10.0.${v}.1`); } }),
        D('c2960', 'core', { name: 'SW-Core', pos: [-2, -2] }),
        D('ex2300', 'ex', { name: 'BR-EX', pos: [5, -2] }),
        D('tower', 'srv', { name: '伺服器', pos: [-4.5, 4], ip: '10.0.30.10', gw: '10.0.30.1', services: WEB }),
        D('laptop', 'adm', { name: '管理員筆電', pos: [-9, 3.5], ip: '10.0.99.50', gw: '10.0.99.1' }),
        D('pc', 'pca', { name: 'PC-A（業務）', pos: [3, 4], ip: '10.0.10.21', gw: '10.0.10.1' }),
        D('pc', 'pcb', { name: 'PC-B（研發）', pos: [8, 4], ip: '10.0.20.22', gw: '10.0.20.1' }),
      ], [['rt:Gi0/0/1', 'core:Gi0/9'], ['core:Gi0/1', 'ex:ge-0/0/0'], ['srv:eth0', 'core:Gi0/2'], ['adm:eth0', 'core:Gi0/3'], ['pca:eth0', 'ex:ge-0/0/1'], ['pcb:eth0', 'ex:ge-0/0/2']]);
      typeIn(s, 'core', ['enable', 'configure terminal', 'vlan 10', 'vlan 20', 'vlan 30', 'vlan 99', 'exit', 'spanning-tree portfast default',
        'interface Gi0/9', 'switchport mode trunk', 'exit', 'interface Gi0/2', 'switchport access vlan 30', 'exit', 'interface Gi0/3', 'switchport access vlan 99', 'exit',
        'interface Gi0/1', 'switchport trunk native vlan 99', 'end']); // 沒有寫死 mode trunk（還是 dynamic auto）
      const ex = s.devices.ex;
      ex.junos.active = [...ACTIVE];
      ex.junos.commits = [{ at: 0, lines: [...ACTIVE] }];
      ex.junos.candidate = [...ACTIVE, 'set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members v20']; // 設了，沒有 commit
      applyJunos(ex);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pca', to: 'srv', port: 443, label: 'PC-A（VLAN 10）連得到伺服器' },
      { type: 'tcp', from: 'pcb', to: 'srv', port: 443, label: 'PC-B（VLAN 20）連得到伺服器' },
      { type: 'ping', from: 'adm', ip: '10.0.99.21', label: '管理員連得到 BR-EX 的管理位址（VLAN 99，Trunk 上不加標籤）' },
      {
        type: 'check', label: 'SW-Core 的 Gi0/1 寫死成 Trunk、native VLAN 99；BR-EX 沒有還沒 commit 的設定',
        test(s) {
          const pc = dev(s, 'core').sw.ports['Gi0/1'];
          if (pc.mode !== 'trunk') return 'SW-Core 的 Gi0/1 不是 switchport mode trunk：Juniper 不送 DTP，dynamic auto 會一直停在 Access';
          if (+pc.native !== 99) return 'SW-Core 的 Gi0/1 的 native VLAN 不是 99';
          return junosDirty(dev(s, 'ex')) ? 'BR-EX 還有沒 commit 的設定（show | compare）' : true;
        },
      },
    ],
    hints: [
      'SW-Core：show interfaces trunk 裡沒有 Gi0/1，show interfaces Gi0/1 switchport 是 Operational Mode: static access。Juniper 不送 DTP：interface Gi0/1 → switchport mode trunk。',
      'BR-EX 的 CLI：configure → show | compare，PC-B 那個埠 (ge-0/0/2) 的 VLAN 設了但沒有 commit。下 commit。',
      '管理員還是連不到 10.0.99.21：Cisco 的 native VLAN 99 不加標籤送過來，Junos 的 trunk 沒有 native VLAN 就丟掉了。set interfaces ge-0/0/0 native-vlan-id 99、set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members mgmt，再 commit。',
    ],
    solve(s) {
      typeIn(s, 'core', ['enable', 'configure terminal', 'interface Gi0/1', 'switchport mode trunk', 'end']);
      const ex = s.devices.ex;
      ex.junos.active = [...ex.junos.candidate, 'set interfaces ge-0/0/0 native-vlan-id 99', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members mgmt'];
      ex.junos.candidate = null;
      applyJunos(ex);
    },
    recap: ['Juniper 不送 DTP：和別家設備接 Trunk，Cisco 這邊要寫死 switchport mode trunk。', 'Junos 改完要 commit；trunk 預設沒有 native VLAN，要 native-vlan-id，而且兩邊要一樣。'],
  },
];
