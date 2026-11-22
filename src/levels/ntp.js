// 第十一章補充：事件的先後兜不起來 — 用 NTP 對時、統一時區與時間戳記，Syslog 上的紀錄才排得出順序
import { makeDevice as D, makeState, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { advance, recompute, settle } from '../engine/sim.js';
import { ntpInfo, stampCfg, logEvent, syslogRows, SIM_EPOCH } from '../engine/ops.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
const NET = ['hq', 'br', 'sw'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
const synced = (s) => NET.every((id) => ntpInfo(s, dev(s, id)).synced);
/** IOS 的 NTP 要好幾次輪詢才採信：還沒同步的話，在複本上讓時間走六分鐘 */
function later(s) {
  const s2 = cloneState(s);
  settle(s2);
  if (synced(s2)) return s2;
  for (let n = 0; n < 6 && !synced(s2); n++) { advance(s2, 64); settle(s2, 30); }
  return s2;
}

export const LEVELS27 = [
  {
    id: 'l99', chapter: 11, title: '事件的先後兜不起來', subtitle: 'NTP 對時、時區與 service timestamps', tags: ['NTP', 'Syslog', '時區', 'service timestamps', '故障排除'],
    brief: '昨晚分公司的專線斷了幾分鐘，主管要一份「幾點幾分、哪台設備先出事」的時間軸。可是 Syslog 伺服器上的紀錄完全兜不起來：HQ-RT 的時間前面都有一個星號、而且差了幾分鐘；BR-RT 明明有對時，紀錄卻早了 8 小時；HQ-SW 根本沒有紀錄送過來（它上次重開機之後，時鐘停在 1993 年）。請讓三台設備都向內部的 NTP 伺服器對時，紀錄一律用台灣時間（UTC+8）、記到毫秒，而且都送到 Syslog 伺服器，下次出事才排得出先後。',
    given: [
      ['NTP 伺服器', '10.10.0.5（stratum 2，UDP 123）'], ['Syslog 伺服器', '10.10.0.6（UDP 514）'],
      ['HQ-RT', 'Gi0/0/1 10.10.0.1 · 專線 Gi0/0/0 10.0.0.1'], ['BR-RT', '專線 10.0.0.2 · 分公司 10.20.0.0/24'], ['HQ-SW', '管理位址 VLAN 1 10.10.0.2（Catalyst 2960，沒有電池供電的時鐘）'],
    ],
    learn: [
      { t: '為什麼要對時', d: '排除故障時要把好幾台設備的紀錄排在一起看：每台的時鐘差幾分鐘，就分不出「介面先斷、還是 OSPF 先斷」。憑證的有效期限、Kerberos、紀錄的保存與稽核也都依賴正確的時間。' },
      { t: 'IOS 的時鐘', d: '沒有對時的 IOS 設備，時間前面有一個 *，表示「不可信」；對過時但失去同步是一個點。Catalyst 2960 沒有電池供電的時鐘，重開機之後從 1993 年 3 月 1 日開始算。' },
      { t: 'NTP', d: 'ntp server <IP> 每 64 秒輪詢一次，IOS 要連續收到幾次回應、確定時間穩定才採信，大約四、五分鐘；show ntp status 會從 unsynchronized 變成 synchronized，show ntp associations 的位址前面出現 *。' },
      { t: '時區與 service timestamps', d: 'clock timezone TST 8 只改 show clock 的顯示；IOS 15 預設的 service timestamps log datetime msec 仍然用 UTC 記錄。要加上 localtime 才用當地時間，show-timezone 會把時區名稱也印出來，避免誤會。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'hq', { name: 'HQ-RT', pos: [-5, -5] }),
        D('isr4331', 'br', { name: 'BR-RT', pos: [6, -5] }),
        D('c2960', 'sw', { name: 'HQ-SW', pos: [-5, 0] }),
        D('tower', 'ntp', { name: 'NTP 伺服器', pos: [-10, 4], ip: '10.10.0.5', gw: '10.10.0.1', services: [{ proto: 'udp', port: 123, name: 'NTP' }] }),
        D('tower', 'log', { name: 'Syslog 伺服器', pos: [-5, 5], ip: '10.10.0.6', gw: '10.10.0.1', services: [{ proto: 'udp', port: 514, name: 'Syslog' }] }),
        D('pc', 'it', { name: 'IT 的電腦', pos: [0, 5], ip: '10.10.0.50', gw: '10.10.0.1' }),
        D('pc', 'bpc', { name: '分公司 PC', pos: [6, 1], ip: '10.20.0.31', gw: '10.20.0.1' }),
      ], [['hq:Gi0/0/0', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'sw:Gi0/1'], ['ntp:eth0', 'sw:Gi0/2'], ['log:eth0', 'sw:Gi0/3'], ['it:eth0', 'sw:Gi0/4'], ['br:Gi0/0/1', 'bpc:eth0']]);
      recompute(s);
      typeIn(s, 'hq', ['configure terminal', 'interface Gi0/0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.10.0.1 255.255.255.0', 'no shutdown', 'exit',
        'ip route 10.20.0.0 255.255.255.0 10.0.0.2', 'logging host 10.10.0.6', 'end', 'write memory']);
      typeIn(s, 'br', ['configure terminal', 'interface Gi0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.20.0.1 255.255.255.0', 'no shutdown', 'exit',
        'ip route 0.0.0.0 0.0.0.0 10.0.0.1', 'clock timezone TST 8', 'ntp server 10.10.0.5', 'logging host 10.10.0.6', 'end', 'write memory']);
      typeIn(s, 'sw', ['configure terminal', 'interface vlan 1', 'ip address 10.10.0.2 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 10.10.0.1', 'end', 'write memory']);
      return fresh(s);
    },
    objectives: [
      {
        type: 'check', label: '三台設備都向 10.10.0.5 對時（NTP 同步之後）',
        test(s) {
          for (const id of NET) { const m = dev(s, id).mgmt || {}; if ((m.ntp || '').trim() !== '10.10.0.5') return `${dev(s, id).name} 還沒有設定 NTP 伺服器 10.10.0.5（ntp server 10.10.0.5）`; }
          const s2 = later(s);
          for (const id of NET) { const n = ntpInfo(s2, dev(s2, id)); if (!n.synced) return `${dev(s, id).name} 和 NTP 伺服器對不上時：${n.why || '收不到 NTP 的回應'}`; }
          return true;
        },
      },
      {
        type: 'check', label: '三台設備的紀錄都用台灣時間（UTC+8），記到毫秒',
        test(s) {
          for (const id of NET) {
            const d = dev(s, id), m = d.mgmt || {}, c = stampCfg(d, 'log');
            if (!m.tz || +m.tz.off !== 8) return `${d.name} 的時區不是 UTC+8（clock timezone TST 8）`;
            if (c.off || !c.dt) return `${d.name} 的紀錄沒有日期時間（service timestamps log datetime …）`;
            if (!c.local) return `${d.name} 的紀錄還是用 UTC：clock timezone 只影響 show clock，紀錄要 service timestamps log datetime msec localtime`;
            if (!c.msec) return `${d.name} 的紀錄沒有記到毫秒（service timestamps log datetime msec localtime）`;
          }
          return true;
        },
      },
      {
        type: 'check', label: 'Syslog 伺服器收得到三台的紀錄，時間和實際的台灣時間一致',
        test(s) {
          const s2 = later(s);
          for (const id of NET) logEvent(s2, dev(s2, id), 5, 'SYS-5-CONFIG_I', 'Configured from console by vty0 (10.10.0.50)');
          recompute(s2);
          const rows = syslogRows(s2, dev(s2, 'log'));
          const x = new Date(SIM_EPOCH + s2.clock * 1000 + 8 * 3600000), want = `${MON[x.getUTCMonth()]} ${String(x.getUTCDate()).padStart(2)} ${two(x.getUTCHours())}:${two(x.getUTCMinutes())}`;
          for (const id of NET) {
            const r = rows.filter((y) => y.dev === id).pop();
            if (!r) return `Syslog 伺服器收不到 ${dev(s, id).name} 的紀錄（logging host 10.10.0.6）`;
            if (/\*/.test(r.line.split('%')[0])) return `${dev(s, id).name} 的紀錄時間前面有 *：時鐘還不可信`;
            if (!r.line.includes(want)) return `${dev(s, id).name} 的紀錄時間和實際的台灣時間 (${want}) 對不上：${r.line.split('%')[0].replace(/^<\d+>\d+: /, '').trim()}`;
          }
          return true;
        },
      },
    ],
    hints: [
      'Syslog 伺服器的紀錄：HQ-RT 的時間前面有 *（沒有對時）；BR-RT 早了 8 小時（它有對時，但紀錄用 UTC）；HQ-SW 一筆都沒有。各台 show clock、show ntp status 看看。',
      'HQ-RT 與 HQ-SW：ntp server 10.10.0.5、clock timezone TST 8；HQ-SW 還要 logging host 10.10.0.6。對時要等四、五分鐘（show ntp status 變成 synchronized）。',
      '三台都加上 service timestamps log datetime msec localtime show-timezone：IOS 預設用 UTC 記錄，設了 clock timezone 也一樣。',
    ],
    solve(s) {
      const st = ['service timestamps log datetime msec localtime show-timezone', 'service timestamps debug datetime msec localtime show-timezone'];
      typeIn(s, 'hq', ['configure terminal', 'ntp server 10.10.0.5', 'clock timezone TST 8', ...st, 'end', 'write memory']);
      typeIn(s, 'br', ['configure terminal', ...st, 'end', 'write memory']);
      typeIn(s, 'sw', ['configure terminal', 'ntp server 10.10.0.5', 'clock timezone TST 8', 'logging host 10.10.0.6', ...st, 'end', 'write memory']);
    },
    recap: ['所有設備向同一台 NTP 伺服器對時，紀錄的先後才有意義；沒對時的 IOS 時間前面有 *。', 'clock timezone 只改顯示；紀錄的時間戳記要 service timestamps log datetime msec localtime 才是當地時間，再加 show-timezone 避免誤會。'],
  },
];
