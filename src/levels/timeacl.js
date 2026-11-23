// 第六章補充：時間型 ACL（time-range）與設備的時區
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { parseIp } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute, advance, transact } from '../engine/sim.js';
import { INET_NTP } from '../engine/ops.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const VIDEO = 'tube.video.example', VIP = '198.51.100.50';
const web = [{ proto: 'tcp', port: 80 }, { proto: 'tcp', port: 443 }];

/** 複製一份狀態，讓時間走到台北時間星期一到五的 hh:mm（關卡從星期一 09:00 開始），再看業務 PC 連不連得到影音網站 */
function videoAt(s, hh, mm) {
  const t = cloneState(s);
  recompute(t);
  const off = (hh * 60 + mm - 9 * 60) * 60;
  let at = null;
  for (let day = 0; day < 14 && at == null; day++) if (day % 7 < 5 && day * 86400 + off >= t.clock) at = day * 86400 + off;
  advance(t, at - t.clock);
  recompute(t);
  return transact(t, 'pc', { proto: 'tcp', dst: parseIp(VIP), dport: 443, host: VIDEO, quiet: true });
}

export const LEVELS56 = [
  {
    id: 'l136', chapter: 6, title: '午休才開放的影音網站，晚上八點才打得開', subtitle: '時間型 ACL（time-range）與設備的時區', tags: ['ACL', 'time-range', 'clock timezone', 'NTP', '時間'],
    brief: `公司規定上班時間不能看影音網站 ${VIDEO}，只有平日中午 12:00 – 13:00 午休時開放。網管在 Edge-RT 上寫了時間型 ACL，也設了 NTP 對時。結果同事抱怨午休怎麼還是打不開，值夜班的同事卻說晚上八點可以看。請讓規則照台北時間運作。`,
    given: [
      ['Edge-RT', 'Gi0/0/1 是辦公室 192.168.10.0/24（ACL LAN-IN in）· Gi0/0/0 往 ISP（NAT）'],
      ['time-range LUNCH', 'periodic weekdays 12:00 to 13:00'],
      ['ACL LAN-IN', `permit tcp any host ${VIP} eq 443 time-range LUNCH → deny tcp any host ${VIP} eq 443 → permit ip any any`],
      ['NTP', `ntp server ${INET_NTP}（time.google.com）· 公司在台北（UTC+8）`], ['規定', '其他網站任何時間都要正常'],
    ],
    learn: [
      { t: '時間型 ACL', d: '先用 time-range 定義時段（periodic weekdays 12:00 to 13:00），再在 ACL 規則後面加上 time-range <名稱>：在時段內這條規則生效，時段外就當作不存在、往下一條比對。show time-range 看現在是 active 還是 inactive，show access-lists 的規則後面也會標出來。' },
      { t: '用的是「設備自己的時間」', d: '時段是照路由器的時鐘判斷的。時鐘錯了，規則就在錯的時間生效。所以時間型 ACL 一定要搭配 NTP（時鐘準）和正確的時區。' },
      { t: 'NTP 只對時，不管時區', d: 'NTP 傳的是 UTC。網路設備出廠的時區是 UTC，沒有設定 clock timezone 的話，台北中午 12 點在路由器上是凌晨 4 點；periodic 12:00 to 13:00 會變成台北的晚上 8 點到 9 點。show clock 一看就知道：時間後面寫的是 UTC。' },
      { t: '設定時區', d: 'clock timezone CST 8 0（名稱、和 UTC 差幾小時、幾分鐘）。台灣沒有夏令時間，不用 clock summer-time。' },
    ],
    setup() {
      const inet = setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -8.5] }), 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' });
      inet.inet.hosts.push({ ip: VIP, name: VIDEO, services: web });
      inet.inet.dns[VIDEO] = VIP;
      const s = makeState([
        inet,
        D('isr4331', 'rt', {
          name: 'Edge-RT', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.2', mask: '255.255.255.252', gateway: '203.0.113.1', nat: true });
            Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
          },
        }),
        D('sw8', 'sw', { name: 'Office-SW', pos: [0, 0.5] }),
        D('pc', 'pc', { name: '業務 PC', pos: [-4, 4.5], ip: '192.168.10.21', gw: '192.168.10.1', dns: '8.8.8.8' }),
        D('pc', 'pc2', { name: '值夜班的 PC', pos: [4, 4.5], ip: '192.168.10.22', gw: '192.168.10.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ['pc:eth0', 'sw:2'], ['pc2:eth0', 'sw:3']]);
      recompute(s);
      typeIn(s, 'rt', ['configure terminal', `ntp server ${INET_NTP}`, 'time-range LUNCH', 'periodic weekdays 12:00 to 13:00', 'exit',
        'ip access-list extended LAN-IN', `permit tcp any host ${VIP} eq 443 time-range LUNCH`, `deny tcp any host ${VIP} eq 443`, 'permit ip any any', 'exit',
        'interface Gi0/0/1', 'ip access-group LAN-IN in', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'check', label: '上班時間（台北 10:00）看不了影音網站', test(s) { const r = videoAt(s, 10, 0); return !r.ok || `台北 10:00 還打得開 ${VIDEO}：規定上班時間不能看`; } },
      { type: 'check', label: '午休（台北 12:30）可以看', test(s) { const r = videoAt(s, 12, 30); return r.ok || `台北 12:30 打不開 ${VIDEO}：${r.reason}`; } },
      { type: 'check', label: '晚上（台北 20:30）不能看：只有午休開放', test(s) { const r = videoAt(s, 20, 30); return !r.ok || `台北 20:30 打得開 ${VIDEO}：規則在錯的時間生效了`; } },
      { type: 'tcp', from: 'pc', name: 'www.example.com', port: 443, label: '其他網站照常（https://www.example.com）' },
    ],
    hints: [
      'Edge-RT 的 CLI：show time-range 看 LUNCH 現在是 active 還是 inactive；show access-lists 的第一條後面也有標。',
      'show clock：時間後面寫的是 UTC，比台北慢 8 小時。NTP 是對的（show ntp status 是 synchronized），只是時區沒設。',
      'periodic 12:00 to 13:00 是照路由器的時間：UTC 的 12:00 是台北的 20:00。',
      'Edge-RT：configure terminal → clock timezone CST 8 0。不用改 time-range。',
    ],
    solve(s) { typeIn(s, 'rt', ['configure terminal', 'clock timezone CST 8 0', 'end', 'write memory']); },
    recap: [
      '時間型 ACL 照設備自己的時鐘判斷：一定要有 NTP，而且時區要設對（網路設備出廠是 UTC）。',
      'show clock、show time-range、show access-lists 的 (active) / (inactive) 是排查的第一步。',
    ],
  },
];
