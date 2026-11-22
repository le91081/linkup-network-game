// 第十四章補充：分公司的 FlexConnect — Local 模式的流量全部繞回總公司，專線一斷 Wi-Fi 就跟著斷
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { dev } from './util.js';

const sub = (d, vlan, ip, dhcp) => {
  const i = newIface(`Gi0/0/1.${vlan}`, `Gi0/0/1.${vlan}`, { t: 'sub', port: 'Gi0/0/1', vlan }, { ip, mask: '255.255.255.0' });
  if (dhcp) Object.assign(i.dhcp, { on: true, pool: dhcp.name, start: dhcp.start, end: dhcp.end, dns: '', gw: '', ...(dhcp.wlc ? { wlc: dhcp.wlc } : {}) });
  d.ifaces.push(i);
};
const wan = (d, ip) => Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ip, mask: '255.255.255.252' });
const CORP = { ssid: 'Corp', pass: 'Corp@2026!' };

export const LEVELS34 = [
  {
    id: 'l107', chapter: 14, title: '分公司的專線一斷，Wi-Fi 也跟著斷', subtitle: 'FlexConnect：在分公司就地交換', tags: ['FlexConnect', 'WLC', 'CAPWAP', 'Trunk', '分公司'],
    brief: '分公司的兩台 AP 由總公司的無線控制器管理（Local 模式）。上週專線斷了半天，分公司明明有自己的路由器、DHCP 和 NAS，Wi-Fi 卻整個不能用；平常開分公司的 NAS 也很慢 — 流量先跑到總公司的控制器、再從專線繞回來。請讓分公司的 Wi-Fi 流量就地進分公司的網路，專線斷掉的時候還能用 NAS；AP 仍然由總公司的控制器管理。',
    given: [
      ['總公司', 'WLC 10.10.10.5 · WLAN Corp → VLAN 30（WPA2）· 伺服器 10.10.40.10 · 員工 VLAN 30 是 10.10.30.0/24'], ['專線', 'HQ-RT 10.255.0.1 ↔ BR-RT 10.255.0.2（20 Mbps）'],
      ['分公司', 'BR-RT：AP 在 VLAN 20（10.20.20.0/24，option 43 指向 WLC）· VLAN 30 是 10.20.30.0/24（有 DHCP）· NAS 10.20.40.10'], ['BR-SW', 'AP 接 Gi0/1、Gi0/2（目前是 VLAN 20 的 Access 埠）'],
    ],
    learn: [
      { t: 'Local 模式的代價', d: 'Local 模式所有用戶端的流量都包在 CAPWAP 裡送回控制器，再從控制器的 VLAN 出去。AP 在分公司、控制器在總公司時，分公司同仁開分公司的 NAS 也要繞專線一圈；專線一斷，AP 找不到控制器就停止放送，整個分公司的 Wi-Fi 跟著斷。' },
      { t: 'FlexConnect', d: 'FlexConnect 的 AP 仍然由總公司的控制器管理（設定、WLAN、RRM），但用戶端的流量在 AP 的交換器埠就地放進 VLAN（local switching）。所以 AP 的埠要改成 Trunk：Native VLAN 是 AP 自己的管理 VLAN，WLAN 的 VLAN 帶標籤。' },
      { t: 'Standalone', d: '和控制器失去聯絡時，FlexConnect 的 AP 進入 standalone 模式：已經下發的、本地交換、預先共用金鑰 (PSK) 的 WLAN 照樣服務。802.1X 的 WLAN 要另外設定本地的 RADIUS 才行。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'hq', { name: 'HQ-RT', pos: [-8, -7], init(d) { wan(d, '10.255.0.1'); sub(d, 10, '10.10.10.1'); sub(d, 30, '10.10.30.1', { name: 'HQ-CORP', start: '10.10.30.100', end: '10.10.30.199' }); sub(d, 40, '10.10.40.1'); d.routes.push({ dst: '10.20.0.0', mask: '255.255.0.0', via: '10.255.0.2' }); } }),
        D('c2960', 'hsw', {
          name: 'HQ-SW', pos: [-8, -2.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'WLC-MGMT' }, { id: 30, name: 'CORP' }, { id: 40, name: 'SERVERS' });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: 'all' });
            Object.assign(d.sw.ports['Gi0/10'], { mode: 'trunk', allowed: '10,30' });
            Object.assign(d.sw.ports['Gi0/8'], { mode: 'access', vlan: 40 });
          },
        }),
        D('c9800', 'wlc', { name: 'WLC（總公司）', pos: [-14, -2.5], init(d) { Object.assign(d.ifaces[0], { ip: '10.10.10.5', mask: '255.255.255.0', gateway: '10.10.10.1' }); d.ifaces[0].bind.vlan = 10; d.wlc.wlans.push({ id: 1, ssid: CORP.ssid, sec: 'wpa2', pass: CORP.pass, vlan: 30 }); } }),
        D('tower', 'srv', { name: '總公司的伺服器', pos: [-13, 2], ip: '10.10.40.10', gw: '10.10.40.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }] }),
        D('isr4331', 'br', {
          name: 'BR-RT', pos: [7, -7],
          init(d) {
            wan(d, '10.255.0.2');
            sub(d, 20, '10.20.20.1', { name: 'AP', start: '10.20.20.100', end: '10.20.20.199', wlc: '10.10.10.5' });
            sub(d, 30, '10.20.30.1', { name: 'BR-CORP', start: '10.20.30.100', end: '10.20.30.199' });
            sub(d, 40, '10.20.40.1');
            d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.255.0.1' });
          },
        }),
        D('c2960p', 'bsw', {
          name: 'BR-SW', pos: [7, -2.5],
          init(d) {
            d.sw.vlans.push({ id: 20, name: 'AP' }, { id: 30, name: 'CORP' }, { id: 40, name: 'NAS' });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: 'all' });
            for (const p of ['Gi0/1', 'Gi0/2']) Object.assign(d.sw.ports[p], { mode: 'access', vlan: 20 });
            Object.assign(d.sw.ports['Gi0/8'], { mode: 'access', vlan: 40 });
          },
        }),
        D('nas', 'nas', { name: '分公司的 NAS', pos: [13, -2], ip: '10.20.40.10', gw: '10.20.40.1', services: [{ proto: 'tcp', port: 445, name: 'SMB' }] }),
        D('c9120', 'ap1', { name: 'BR-AP-1', pos: [3, 2] }),
        D('c9120', 'ap2', { name: 'BR-AP-2', pos: [11, 2.5] }),
        D('laptop', 'nb1', { name: '業務的筆電', pos: [2, 6], wifi: CORP }),
        D('laptop', 'nb2', { name: '會計的筆電', pos: [12, 6], wifi: CORP }),
      ], [['hq:Gi0/0/0', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'hsw:Gi0/9'], ['wlc:Te0/1/0', 'hsw:Gi0/10'], ['srv:eth0', 'hsw:Gi0/8'],
        ['br:Gi0/0/1', 'bsw:Gi0/9'], ['nas:eth0', 'bsw:Gi0/8'], ['ap1:Gi0', 'bsw:Gi0/1'], ['ap2:Gi0', 'bsw:Gi0/2']]);
      s.cables.find((c) => [c.a.dev, c.b.dev].sort().join() === 'br,hq').cir = 20;
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'nb1', ip: '10.20.40.10', port: 445, avoid: 'hq', label: '業務的筆電開分公司的 NAS，不繞到總公司' },
      { type: 'tcp', from: 'nb1', ip: '10.10.40.10', port: 443, label: '業務的筆電照樣連得到總公司的伺服器' },
      { type: 'failover', cut: [['br', 'Gi0/0/0']], label: '專線斷掉時，業務的筆電還開得了分公司的 NAS', test: { type: 'tcp', from: 'nb1', ip: '10.20.40.10', port: 445 } },
      { type: 'failover', cut: [['br', 'Gi0/0/0']], label: '專線斷掉時，會計的筆電也一樣', test: { type: 'tcp', from: 'nb2', ip: '10.20.40.10', port: 445 } },
      {
        type: 'check', label: '兩台 AP 仍然由總公司的控制器管理',
        test(s) {
          for (const id of ['ap1', 'ap2']) { const c = dev(s, id).rt.capwap || {}; if (!c.joined) return `${dev(s, id).name} 沒有加入控制器：${c.why || ''}`; }
          return true;
        },
      },
    ],
    hints: [
      '先看現在的路：業務的筆電開分公司的 NAS，封包從 AP 包進 CAPWAP、走專線到總公司的 WLC，再從專線繞回來。AP 的「AP」分頁：模式是 Local。',
      '兩台 AP 的模式改成 FlexConnect：用戶端的流量會在 AP 的交換器埠就地放進 VLAN 30。',
      '所以 BR-SW 的 Gi0/1、Gi0/2 要改成 Trunk：Native VLAN 20（AP 自己的管理 VLAN，不帶標籤），允許 20、30。分公司的 VLAN 30 已經有 DHCP（BR-RT 的 Gi0/0/1.30）。',
    ],
    solve(s) {
      for (const id of ['ap1', 'ap2']) dev(s, id).lwap.mode = 'flex';
      for (const p of ['Gi0/1', 'Gi0/2']) Object.assign(dev(s, 'bsw').sw.ports[p], { mode: 'trunk', native: 20, allowed: '20,30' });
    },
    recap: ['Local 模式的流量都回到控制器；控制器在遠端時，分公司要用 FlexConnect 在本地交換。', 'FlexConnect 的 AP 接 Trunk：Native VLAN 是 AP 的管理 VLAN，WLAN 的 VLAN 帶標籤；和控制器斷線時，PSK 的 WLAN 照樣服務。'],
  },
];
