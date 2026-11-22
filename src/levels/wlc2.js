// 第十四章補充：控制器 N+1 — WLC 重開機要六分鐘，整棟的 Wi-Fi 跟著斷；備援控制器裝好了卻沒設定完
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { dev } from './util.js';

const sub = (d, vlan, ip, dhcp) => {
  const i = newIface(`Gi0/0/1.${vlan}`, `Gi0/0/1.${vlan}`, { t: 'sub', port: 'Gi0/0/1', vlan }, { ip, mask: '255.255.255.0' });
  if (dhcp) Object.assign(i.dhcp, { on: true, pool: dhcp.name, start: dhcp.start, end: dhcp.end, dns: '', gw: '', ...(dhcp.wlc ? { wlc: dhcp.wlc } : {}) });
  d.ifaces.push(i);
};
const CORP = { ssid: 'Corp', pass: 'Corp@2026!' };
const SRV = '10.10.40.10';
const wlc = (id, name, pos, ip, wlans) => D('c9800', id, {
  name, pos,
  init(d) {
    Object.assign(d.ifaces[0], { ip, mask: '255.255.255.0', gateway: '10.10.10.1' });
    d.ifaces[0].bind.vlan = 10;
    d.wlc.wlans.push(...wlans);
  },
});

export const LEVELS33 = [
  {
    id: 'l106', chapter: 14, title: '控制器重開機，整棟的 Wi-Fi 斷了六分鐘', subtitle: '無線控制器 N+1：次要控制器、一樣的 WLAN 與 VLAN', tags: ['WLC', 'N+1', '備援', 'CAPWAP', 'Trunk'],
    brief: '上週 WLC-1 升級韌體重開機，整棟的 Wi-Fi 斷了六分鐘，正好在開董事會。廠商之前已經裝好第二台控制器 WLC-2 當備援 (N+1)，可是那次一台 AP 都沒有跑過去。請讓 WLC-1 不在的時候，AP 自動加入 WLC-2、員工照樣連得上 Corp；平常還是由 WLC-1 管理。',
    given: [
      ['WLC-1', '10.10.10.5（主要）· WLAN Corp → VLAN 30 · 接 SW-1F 的 Gi0/10'], ['WLC-2', '10.10.10.6（N+1 備援）· 接 SW-1F 的 Gi0/7'],
      ['AP', 'VLAN 20 · DHCP option 43 只給了 WLC-1'], ['Corp', 'WPA2-Personal · 密碼 Corp@2026! · VLAN 30'], ['檔案伺服器', `${SRV}（VLAN 40）`],
    ],
    learn: [
      { t: 'N+1', d: '多放一台控制器當備援：平常 AP 都在主要控制器上，主要的不在了才加入備援的那台。AP 會照順序找：手動指定的主要控制器 → 次要控制器 → option 43 / DNS / 廣播找到的。所以兩個都要填，只填次要的，AP 平常就會跑到備援那台。' },
      { t: '切換要多久', d: 'AP 每 30 秒和控制器交換一次 heartbeat，連續沒有回應才判定控制器不在，再花大約 25 秒加入下一台，所以會斷一分鐘左右 — 比等控制器重開機（9800 要六分鐘）好很多。主要控制器回來之後，AP 會自己切回去 (AP fallback)。' },
      { t: '備援控制器要設定一樣', d: 'AP 加入 WLC-2 之後，SSID 是 WLC-2 推給它的：WLC-2 上要有一樣的 WLAN（名稱、加密、密碼、VLAN）。Local 模式的用戶端流量從 WLC-2 出去，接 WLC-2 的 Trunk 也要允許員工的 VLAN。' },
    ],
    setup() {
      return makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -9],
          init(d) {
            sub(d, 10, '10.10.10.1');
            sub(d, 20, '10.10.20.1', { name: 'AP', start: '10.10.20.100', end: '10.10.20.199', wlc: '10.10.10.5' });
            sub(d, 30, '10.10.30.1', { name: 'CORP', start: '10.10.30.100', end: '10.10.30.199' });
            sub(d, 40, '10.10.40.1');
          },
        }),
        D('c2960p', 'sw', {
          name: 'SW-1F', pos: [0, -4.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'WLC-MGMT' }, { id: 20, name: 'AP' }, { id: 30, name: 'CORP' }, { id: 40, name: 'SERVERS' });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: 'all' });
            Object.assign(d.sw.ports['Gi0/10'], { mode: 'trunk', allowed: '10,30' });
            Object.assign(d.sw.ports['Gi0/7'], { mode: 'trunk', allowed: '10' });
            for (const p of ['Gi0/1', 'Gi0/2']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 20 });
            Object.assign(d.sw.ports['Gi0/8'], { mode: 'access', vlan: 40 });
          },
        }),
        wlc('wlc1', 'WLC-1', [8, -6], '10.10.10.5', [{ id: 1, ssid: CORP.ssid, sec: 'wpa2', pass: CORP.pass, vlan: 30 }]),
        wlc('wlc2', 'WLC-2（備援）', [8, -2], '10.10.10.6', []),
        D('tower', 'srv', { name: '檔案伺服器', pos: [-8, -5], ip: SRV, gw: '10.10.40.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }] }),
        D('c9120', 'ap1', { name: 'AP-1F-West', pos: [-6, 1.5] }),
        D('c9120', 'ap2', { name: 'AP-1F-East', pos: [6, 1.5] }),
        D('laptop', 'nb1', { name: '董事長的筆電', pos: [-7.5, 5], wifi: CORP }),
        D('laptop', 'nb2', { name: '秘書的筆電', pos: [6.5, 5.5], wifi: CORP }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['wlc1:Te0/1/0', 'sw:Gi0/10'], ['wlc2:Te0/1/0', 'sw:Gi0/7'], ['srv:eth0', 'sw:Gi0/8'], ['ap1:Gi0', 'sw:Gi0/1'], ['ap2:Gi0', 'sw:Gi0/2']]);
    },
    objectives: [
      {
        type: 'check', label: '平常兩台 AP 都由 WLC-1 管理',
        test(s) {
          for (const id of ['ap1', 'ap2']) {
            const c = dev(s, id).rt.capwap || {};
            if (!c.joined) return `${dev(s, id).name} 沒有加入控制器：${c.why || '還沒有找到控制器'}`;
            if (c.wlc !== 'wlc1') return `${dev(s, id).name} 加入的是 ${dev(s, c.wlc).name}：平常要由 WLC-1 管理（AP 會先試手動指定的主要、次要控制器，再用 option 43 找到的）`;
          }
          return true;
        },
      },
      { type: 'tcp', from: 'nb1', ip: SRV, port: 443, label: '平常董事長的筆電開得了檔案伺服器' },
      { type: 'failover', down: ['wlc1'], label: 'WLC-1 重開機的時候，董事長的筆電照樣開得了檔案伺服器', test: { type: 'tcp', from: 'nb1', ip: SRV, port: 443 } },
      { type: 'failover', down: ['wlc1'], label: 'WLC-1 重開機的時候，秘書的筆電也一樣', test: { type: 'tcp', from: 'nb2', ip: SRV, port: 443 } },
    ],
    hints: [
      '先演練：任務的第三項會在複本上把 WLC-1 關機。AP 只知道 option 43 給的 10.10.10.5，找不到別的控制器。每台 AP 的「AP」分頁填上主要控制器 10.10.10.5、次要控制器 10.10.10.6。只填次要的不行：AP 會先試手動指定的控制器，再用 option 43 找到的，結果平常就跑到 WLC-2 去了。',
      'AP 加入 WLC-2 之後還是沒有 Corp？WLAN 是控制器推給 AP 的：WLC-2 也要建立一樣的 Corp（WPA2、密碼 Corp@2026!、VLAN 30）。',
      '筆電連上了卻拿不到 IP？Local 模式的流量從 WLC-2 出去，SW-1F 的 Gi0/7 只允許 VLAN 10，要加上 30。',
    ],
    solve(s) {
      for (const id of ['ap1', 'ap2']) Object.assign(dev(s, id).lwap, { primary: '10.10.10.5', secondary: '10.10.10.6' });
      dev(s, 'wlc2').wlc.wlans.push({ id: 1, ssid: CORP.ssid, sec: 'wpa2', pass: CORP.pass, vlan: 30 });
      dev(s, 'sw').sw.ports['Gi0/7'].allowed = '10,30';
    },
    recap: ['N+1 要三件事都到位：AP 知道備援控制器在哪裡、備援控制器有一樣的 WLAN、它的 Trunk 允許員工的 VLAN。', '控制器的切換要等 heartbeat 逾時再重新加入，大約一分鐘；主要控制器回來之後 AP 會自己切回去。'],
  },
];
