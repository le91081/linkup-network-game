// 第十二章補充：PoE 預算 — 為了「不洩漏設備資訊」關掉 CDP，交換器只好依等級替每台 AP 保留 30 W，新的 AP 就分不到電
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { cdpOn, lldpTxOn } from '../engine/disc.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
const sub = (d, vlan, ip, dhcp) => {
  const i = newIface(`Gi0/0/1.${vlan}`, `Gi0/0/1.${vlan}`, { t: 'sub', port: 'Gi0/0/1', vlan }, { ip, mask: '255.255.255.0' });
  if (dhcp) Object.assign(i.dhcp, { on: true, pool: dhcp.name, start: dhcp.start, end: dhcp.end, dns: '', gw: '', ...(dhcp.wlc ? { wlc: dhcp.wlc } : {}) });
  d.ifaces.push(i);
};
const APS = ['ap1', 'ap2', 'ap3', 'ap4', 'ap5'];
const DESK = ['Gi0/6', 'Gi0/7', 'Gi0/8'];

export const LEVELS26 = [
  {
    id: 'l98', chapter: 12, title: '新的 AP 怎麼插都不亮', subtitle: 'PoE 預算、IEEE 等級與 CDP 的電力協商', tags: ['PoE', 'PoE 預算', 'CDP', 'LLDP', '稽核'],
    brief: '三樓的交換器上已經有四台 Cisco 的 AP，今天在會議室加裝第五台，接上 Gi0/5 之後完全沒反應：換過網路線、換過一台全新的 AP 都一樣。上個月資安稽核說 CDP 會把設備的型號、版本、IP 告訴任何接上來的人，所以三樓交換器下了 no cdp run，之後也沒人發現什麼問題。請讓五台 AP 都加入無線控制器；稽核的要求仍然要遵守：使用者座位的埠不能送出 CDP 或 LLDP。',
    given: [
      ['SW-3F', 'Catalyst 2960-CX-8PC-L · Gi0/1 – Gi0/8 有 PoE+，總預算 124 W'], ['AP', 'Catalyst 9120AXI × 5（802.3at，Class 4）· Gi0/1 – Gi0/5 · VLAN 20'],
      ['使用者座位', 'Gi0/6 – Gi0/8（VLAN 30），Gi0/8 是大廳的公用電腦'], ['WLC', '10.10.10.5（VLAN 10，Gi0/10）· option 43 已經設好'],
    ],
    learn: [
      { t: 'PoE 的總預算', d: '交換器的電源供應器有上限：2960-CX-8PC-L 每個埠最多 30 W，但八個埠加起來只有 124 W。預算用完之後，新插上的受電設備 (PD) 會被拒絕供電，log 裡有 %ILPOWER-5-ILPOWER_POWER_DENY，show power inline 的 Oper 是 faulty。' },
      { t: 'IEEE 等級：先依最大值保留', d: 'PD 插上時用電阻告訴交換器自己是哪一級：Class 1 是 4 W、Class 2 是 7 W、Class 0 與 3 是 15.4 W、Class 4 (802.3at) 是 30 W。交換器不知道它實際用多少，只能先依等級的上限保留。' },
      { t: 'CDP / LLDP 的電力協商', d: 'Cisco 的 AP 與電話開機之後，會用 CDP（或 LLDP 的 Power via MDI）告訴交換器實際需要的瓦數，交換器就把保留量從 30 W 降到實際的 20.9 W。CDP 與 LLDP 都關掉的話，每台 AP 一直佔著 30 W：四台就是 120 W，第五台分不到。' },
      { t: '只在使用者的埠關掉', d: '稽核的擔心是對的：CDP / LLDP 會把設備資訊送給接上來的任何人。正確的做法是保留基礎設施的埠（AP、電話、上行），只在使用者可以接觸的埠上 no cdp enable（LLDP 是 no lldp transmit），而不是整台關掉。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -9],
          init(d) {
            sub(d, 10, '10.10.10.1');
            sub(d, 20, '10.10.20.1', { name: 'AP', start: '10.10.20.100', end: '10.10.20.199', wlc: '10.10.10.5' });
            sub(d, 30, '10.10.30.1', { name: 'DESK', start: '10.10.30.100', end: '10.10.30.199' });
          },
        }),
        D('c2960p', 'sw', {
          name: 'SW-3F', pos: [0, -4.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'WLC-MGMT' }, { id: 20, name: 'AP' }, { id: 30, name: 'DESK' });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: 'all' });
            Object.assign(d.sw.ports['Gi0/10'], { mode: 'trunk', allowed: '10,30' });
            for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4', 'Gi0/5']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 20 });
            for (const p of DESK) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 30 });
          },
        }),
        D('c9800', 'wlc', {
          name: 'WLC', pos: [8.5, -5],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '10.10.10.5', mask: '255.255.255.0', gateway: '10.10.10.1' });
            d.ifaces[0].bind.vlan = 10;
            d.wlc.wlans.push({ id: 1, ssid: 'Corp', sec: 'wpa2', pass: 'Corp@2026!', vlan: 30 });
          },
        }),
        D('c9120', 'ap1', { name: 'AP-3F-1', pos: [-11, 0] }),
        D('c9120', 'ap2', { name: 'AP-3F-2', pos: [-7, 0] }),
        D('c9120', 'ap3', { name: 'AP-3F-3', pos: [-3, 0] }),
        D('c9120', 'ap4', { name: 'AP-3F-4', pos: [1, 0] }),
        D('c9120', 'ap5', { name: 'AP-會議室（新）', pos: [9, 2.5] }),
        D('pc', 'pc1', { name: '座位 PC-1', pos: [-8, 6], dhcp: true }),
        D('pc', 'pc2', { name: '座位 PC-2', pos: [-3, 6.5], dhcp: true }),
        D('pc', 'kiosk', { name: '大廳的公用電腦', pos: [3, 7], dhcp: true }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['wlc:Te0/1/0', 'sw:Gi0/10'], ...APS.map((a, n) => [`${a}:Gi0`, `sw:Gi0/${n + 1}`]),
        ['pc1:eth0', 'sw:Gi0/6'], ['pc2:eth0', 'sw:Gi0/7'], ['kiosk:eth0', 'sw:Gi0/8']]);
      recompute(s);
      // 上個月的稽核：整台關掉 CDP（LLDP 在 IOS 本來就沒開）
      typeIn(s, 'sw', ['configure terminal', 'no cdp run', 'end', 'write memory']);
      return fresh(s);
    },
    objectives: [
      {
        type: 'check', label: '會議室的新 AP 分得到 PoE',
        test(s) {
          const e = (s.rt.poe || {})['sw:Gi0/5'];
          if (!e) return 'AP-會議室（新）要接在 SW-3F 有 PoE 的埠上（Gi0/5）';
          if (e.state === 'denied') return 'SW-3F 拒絕供電給 Gi0/5：PoE 預算不夠（show power inline 看每個埠保留了多少瓦）';
          return e.state === 'on' || `Gi0/5 沒有供電（${e.state}）`;
        },
      },
      {
        type: 'check', label: '五台 AP 都加入了無線控制器',
        test(s) {
          for (const id of APS) {
            const d = dev(s, id), c = (d.rt && d.rt.capwap) || {};
            if (s.rt.off[id]) return `${d.name} 沒有電`;
            if (!c.joined) return `${d.name} 還沒有加入控制器：${c.why || '還在開機或還沒有找到控制器'}`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '稽核：使用者座位的埠（Gi0/6 – Gi0/8）不送 CDP 也不送 LLDP',
        test(s) {
          const sw = dev(s, 'sw');
          for (const p of DESK) {
            if (cdpOn(sw, p)) return `${p} 會送出 CDP：使用者的埠要 no cdp enable（稽核擔心的就是這些埠）`;
            if (lldpTxOn(sw, p)) return `${p} 會送出 LLDP：使用者的埠要 no lldp transmit`;
          }
          return true;
        },
      },
    ],
    hints: [
      'SW-3F 的 CLI：show power inline。Available 124 W、Used 120 W：四台 AP 都是 Class 4、各保留 30 W，Gi0/5 是 faulty；show logging 裡有 %ILPOWER-5-ILPOWER_POWER_DENY。',
      'AP 實際只用 20.9 W，但交換器要靠 CDP（或 LLDP）才知道。關掉 CDP 之後只能依等級保留 30 W。SW-3F：cdp run，過一下 AP 送來 CDP，保留量就降下來，Gi0/5 也分得到電。',
      '稽核的要求改成只在使用者的埠關：interface range gi0/6 - 8 → no cdp enable（如果你用的是 lldp run，再加上 no lldp transmit）。',
    ],
    solve(s) {
      typeIn(s, 'sw', ['configure terminal', 'cdp run', 'interface range gi0/6 - 8', 'no cdp enable', 'end', 'write memory']);
    },
    recap: ['PoE 預算是依「保留量」算的：交換器先依 IEEE 等級保留上限，Cisco 的設備再用 CDP / LLDP 協商出實際用量。', '為了安全關掉 CDP / LLDP，要關在使用者的埠，不要整台關：AP 與電話的電力協商、語音 VLAN 都靠它們。'],
  },
];
