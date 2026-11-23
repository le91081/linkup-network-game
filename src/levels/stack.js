// 第八章補充：交換器堆疊（Catalyst 9300 StackWise）— 上行分散到兩台成員、跨成員的 EtherChannel、堆疊的優先權
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { memberOfPort } from '../engine/stack.js';
import { dev, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
/** 這台交換器往核心的上行：Port-channel 的成員都 bundled、跨兩台堆疊成員、LACP */
function crossStack(s, core, swId, corePorts, swPorts, name) {
  const c = dev(s, core), sw = dev(s, swId);
  const lags = new Set(corePorts.map((p) => +c.sw.ports[p].lag || 0));
  if (lags.has(0)) return `Core 接 ${name} 的 ${corePorts.filter((p) => !(+c.sw.ports[p].lag > 0)).join('、')} 還沒有加入 Port-channel`;
  if (lags.size > 1) return `Core 接 ${name} 的兩個埠在不同的 Port-channel`;
  if (new Set(corePorts.map(memberOfPort)).size < 2) return `Core 接 ${name} 的 Port-channel 成員都在同一台堆疊成員上`;
  if (swPorts.some((p) => !(+sw.sw.ports[p].lag > 0))) return `${name} 的上行 ${swPorts.filter((p) => !(+sw.sw.ports[p].lag > 0)).join('、')} 還沒有加入 Port-channel`;
  const modes = [...corePorts.map((p) => c.sw.ports[p].lagMode || 'active'), ...swPorts.map((p) => sw.sw.ports[p].lagMode || 'active')];
  if (modes.includes('on')) return `${name} 的 EtherChannel 用了靜態的 mode on：兩邊都用 LACP（mode active）才偵測得到接錯線、對端沒設好`;
  const bad = [...corePorts.map((p) => [c, p]), ...swPorts.map((p) => [sw, p])].find(([d, p]) => !d.rt.lag[p] || d.rt.lag[p].state !== 'bundled');
  if (bad) return `${bad[0].name} 的 ${bad[1]} 沒有綁進 Port-channel（${(bad[0].rt.lag[bad[1]] || {}).why || '沒有連線'}）`;
  return true;
}

export const LEVELS73 = [
  {
    id: 'l153', chapter: 8, title: '兩台疊成一台，壞一台全公司斷線', subtitle: '交換器堆疊：跨成員的 EtherChannel 與堆疊的優先權', tags: ['堆疊', 'StackWise', 'EtherChannel', 'LACP', '備援'],
    brief: '核心交換器從一台 Catalyst 9300 換成兩台堆疊 (StackWise)，主管說這樣「壞一台也不怕」。上週 Switch 1 的電源壞了，結果全公司的人都連不到伺服器，Switch 2 明明好好的。前任管理員把往下接的線都接在 Switch 1 上，接到 Switch 2 的線怕形成迴圈就 shutdown 了。請讓任何一台堆疊成員故障時，大家都照樣連得到伺服器；兩條上行都要在用，不要讓 STP 擋掉一條。另外，Switch 1 要固定是 Active。',
    given: [
      ['Core（堆疊）', 'Switch 1、Switch 2 · Vlan10 10.0.10.1、Vlan20 10.0.20.1'],
      ['SW-Users 的上行', 'Gi0/7 → Core Gi1/0/1、Gi0/8 → Core Gi2/0/1'],
      ['SW-Servers 的上行', 'Gi0/7 → Core Gi1/0/2、Gi0/8 → Core Gi2/0/2'],
      ['使用者 PC', '10.0.10.50（VLAN 10）'], ['伺服器', '10.0.20.10（VLAN 20，HTTPS）'],
    ],
    learn: [
      { t: '堆疊是什麼', d: '好幾台交換器用背後的堆疊線 (StackWise-480) 接成一個環，對外就是一台：一份設定、一個管理位址、STP 只有一個 bridge。埠名稱的第一個數字是成員編號：Gi1/0/1 在 Switch 1、Gi2/0/1 在 Switch 2。' },
      { t: '線要分散到不同的成員', d: '堆疊只保護「接在活著的那台上」的線。所有的線都接在 Switch 1，它一壞，Switch 2 再好也沒有用。往下接的交換器、伺服器、往上的防火牆，都要各接一條到不同的成員。' },
      { t: '跨成員的 EtherChannel', d: '因為堆疊是同一台交換器，Gi1/0/1 和 Gi2/0/1 可以綁成同一個 Port-channel (cross-stack EtherChannel)：兩條都在傳資料，一台成員壞了只是少一條，不用等 STP 重新收斂。只是兩條各自接 Trunk 的話，STP 會把其中一條擋掉。用 LACP (mode active)，接錯線時不會綁起來。' },
      { t: 'Active、Standby 與優先權', d: 'Active 跑控制平面，Standby 隨時接手（SSO）。選 Active 時優先權（1–15，預設 1）大的優先，一樣就看 MAC。Active 恢復之後不會搶回；改了優先權也要整個堆疊重新開機才重選。指令：switch 1 priority 15（特權模式），show switch 看角色。' },
      { t: '常用的指令', d: 'show switch（成員、角色、優先權）、show switch stack-ports（堆疊線）、show redundancy（SSO）、show etherchannel summary（Po 的成員要是 P）、show interfaces status。' },
    ],
    setup() {
      return makeState([
        D('c9300', 'core', {
          name: 'Core', pos: [0, -5.5], stack: 2,
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'Users' }, { id: 20, name: 'Servers' });
            for (const v of [10, 20]) d.ifaces.push(newIface('vlan' + v, 'Vlan' + v, { t: 'svi', vlan: v }, { ip: `10.0.${v}.1`, mask: '255.255.255.0' }));
            for (const p of ['Gi1/0/1', 'Gi1/0/2', 'Gi2/0/1', 'Gi2/0/2']) Object.assign(d.sw.ports[p], { mode: 'trunk' });
            for (const p of ['Gi2/0/1', 'Gi2/0/2']) d.sw.ports[p].shut = true; // 怕迴圈，先關掉
            d.sw.stp.prio = 4096;
            d.sw.stp.portfastDefault = true;
          },
        }),
        ...[['swu', 'SW-Users', [-6, 0], 10], ['sws', 'SW-Servers', [6, 0], 20]].map(([id, name, pos, v]) => D('c2960', id, {
          name, pos,
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'Users' }, { id: 20, name: 'Servers' });
            for (const p of ['Gi0/7', 'Gi0/8']) d.sw.ports[p].mode = 'trunk';
            d.sw.ports['Gi0/1'].vlan = v;
            d.sw.stp.portfastDefault = true;
          },
        })),
        D('pc', 'pc', { name: '使用者 PC', pos: [-7.5, 5], ip: '10.0.10.50', gw: '10.0.10.1' }),
        D('tower', 'srv', { name: '伺服器', pos: [7.5, 5], ip: '10.0.20.10', gw: '10.0.20.1', services: WEB }),
      ], [['swu:Gi0/7', 'core:Gi1/0/1'], ['swu:Gi0/8', 'core:Gi2/0/1'], ['sws:Gi0/7', 'core:Gi1/0/2'], ['sws:Gi0/8', 'core:Gi2/0/2'], ['pc:eth0', 'swu:Gi0/1'], ['srv:eth0', 'sws:Gi0/1']]);
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'srv', port: 443, label: '使用者 PC 連得到伺服器（HTTPS）' },
      { type: 'failover', member: [['core', 1]], label: 'Switch 1 故障：使用者照樣連得到伺服器', test: { type: 'tcp', from: 'pc', to: 'srv', port: 443 } },
      { type: 'failover', member: [['core', 2]], label: 'Switch 2 故障：使用者照樣連得到伺服器', test: { type: 'tcp', from: 'pc', to: 'srv', port: 443 } },
      {
        type: 'check', label: 'SW-Users、SW-Servers 的上行都是跨兩台成員的 EtherChannel（LACP），兩條都在用',
        test(s) {
          const a = crossStack(s, 'core', 'swu', ['Gi1/0/1', 'Gi2/0/1'], ['Gi0/7', 'Gi0/8'], 'SW-Users');
          return a !== true ? a : crossStack(s, 'core', 'sws', ['Gi1/0/2', 'Gi2/0/2'], ['Gi0/7', 'Gi0/8'], 'SW-Servers');
        },
      },
      {
        type: 'check', label: 'Switch 1 的優先權比 Switch 2 高（整個堆疊重新開機時，Switch 1 一定是 Active）',
        test(s) {
          const [m1, m2] = dev(s, 'core').stack.members;
          if (!((+m1.prio || 1) > (+m2.prio || 1))) return `Switch 1 的優先權是 ${+m1.prio || 1}、Switch 2 是 ${+m2.prio || 1}：一樣的話看 MAC 位址，誰當 Active 不一定。switch 1 priority 15、switch 2 priority 14`;
          return true;
        },
      },
    ],
    hints: [
      'Core 的「堆疊」分頁可以把 Switch 1「拔掉電源」試試：SW-Users、SW-Servers 接 Switch 2 的 Gi2/0/1、Gi2/0/2 被 shutdown 了，所有的流量都靠 Switch 1。',
      '只把 Gi2/0/1、Gi2/0/2 打開的話會通，但 STP 會把每台交換器的其中一條上行擋掉（show spanning-tree）。兩條要綁成同一個 Port-channel：Core 上 interface range Gi1/0/1, Gi2/0/1 → channel-group 1 mode active → no shutdown；Gi1/0/2, Gi2/0/2 → channel-group 2 mode active → no shutdown。',
      'SW-Users、SW-Servers：interface range Gi0/7 - 8 → channel-group 1 mode active。show etherchannel summary 兩個成員都是 (P)。',
      '堆疊的優先權在特權模式下設：switch 1 priority 15、switch 2 priority 14（不在 running-config 裡），show switch 看得到。',
    ],
    solve(s) {
      typeIn(s, 'core', ['enable', 'switch 1 priority 15', 'y', 'switch 2 priority 14', 'y', 'configure terminal',
        'interface range Gi1/0/1, Gi2/0/1', 'channel-group 1 mode active', 'no shutdown',
        'interface range Gi1/0/2, Gi2/0/2', 'channel-group 2 mode active', 'no shutdown', 'end']);
      for (const id of ['swu', 'sws']) typeIn(s, id, ['enable', 'configure terminal', 'interface range Gi0/7 - 8', 'channel-group 1 mode active', 'end']);
    },
    recap: ['堆疊只保護接在活著的成員上的線：往下、往上的線都要分散到不同的成員。', '跨成員的 EtherChannel (LACP) 讓兩條都在用，一台成員壞了不用等 STP；用優先權固定誰是 Active。'],
  },
];
