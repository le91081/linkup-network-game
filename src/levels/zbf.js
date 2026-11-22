// 第六章補充：IOS 的 Zone-Based Firewall
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const WEBPUB = '203.0.113.35';

export const LEVELS43 = [
  // ════════════════════════ 6-14 ════════════════════════
  {
    id: 'l123', chapter: 6, title: '分公司只有一台路由器，也要當防火牆', subtitle: 'IOS 的 Zone-Based Firewall', tags: ['ZBF', 'zone', 'inspect', '有狀態防火牆', 'DMZ'],
    brief: `分公司沒有防火牆的預算，只有一台 ISR 路由器：辦公室 (Gi0/0/1)、DMZ 的網站伺服器 (Gi0/0/2，靜態 NAT 成 ${WEBPUB})、網際網路 (Gi0/0/0)。現在什麼都通：網際網路上的人連得到 DMZ 伺服器的 SSH，DMZ 的伺服器也連得進辦公室。請用 Zone-Based Firewall 把路由器變成有狀態的防火牆：辦公室可以上網、可以管理 DMZ；外面只能開 DMZ 的網站；DMZ 不能主動連進辦公室。`,
    given: [
      ['辦公室 (Gi0/0/1)', '192.168.10.0/24'], ['DMZ (Gi0/0/2)', `192.168.20.0/24 · 網站伺服器 192.168.20.10（HTTPS、SSH）· 靜態 NAT ${WEBPUB}`],
      ['網際網路 (Gi0/0/0)', '203.0.113.34/29 · PAT'], ['建議的 zone', 'INSIDE、DMZ、OUTSIDE'],
      ['辦公室要能用', '網頁 (http / https)、DNS、ping；DMZ 的 https 與 ssh'], ['外面只能用', `DMZ 網站的 https（${WEBPUB}:443）`],
    ],
    learn: [
      { t: 'Zone-Based Firewall', d: '把介面分進 zone（zone-member security）：同一個 zone 互通；不同 zone 之間預設全部拒絕，要有 zone-pair（來源 zone → 目的 zone）套用 policy-map type inspect 才放行。有 zone 的介面和沒有 zone 的介面之間一律不通。' },
      { t: 'class-map 與 policy-map type inspect', d: 'class-map type inspect match-any 用 match protocol（http、https、dns、icmp、ssh…）或 match access-group 分類；policy-map type inspect 替每個 class 決定 inspect、pass 或 drop，沒有符合的落到 class-default（預設 drop）。' },
      { t: 'inspect 和 pass', d: 'inspect 是有狀態的：記下連線，回程自動放行，所以 OUTSIDE → INSIDE 不必開任何東西。pass 是無狀態的、只放一個方向，回程要另一條 zone-pair 也 pass — 通常只用在 ESP 這類 inspect 不了的流量。' },
      { t: 'self zone', d: '路由器自己是 self zone。沒有指向 self 的 zone-pair 時，進出路由器本身的流量（ping 路由器、SSH 管理、路由協定）都放行；建了 OUTSIDE → self 之後就要明確放行需要的東西。' },
    ],
    setup() {
      const inet = setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.248', assign: '203.0.113.34' });
      return makeState([
        inet,
        D('isr4331', 'r1', {
          name: 'R1', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.34', mask: '255.255.255.248', gateway: '203.0.113.33', nat: true });
            Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces[2], { ip: '192.168.20.1', mask: '255.255.255.0' });
            d.staticNat.push({ pub: WEBPUB, priv: '192.168.20.10' });
          },
        }),
        D('sw8', 'sw1', { name: '辦公室交換器', pos: [-6, 0.5] }),
        D('tower', 'web', { name: 'DMZ 網站伺服器', pos: [7, 1], ip: '192.168.20.10', gw: '192.168.20.1', dns: '8.8.8.8', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }, { proto: 'tcp', port: 22, name: 'SSH' }] }),
        D('pc', 'pc1', { name: 'PC-1', pos: [-9, 5], ip: '192.168.10.21', gw: '192.168.10.1', dns: '8.8.8.8', services: [{ proto: 'tcp', port: 445, name: '檔案分享' }] }),
        D('laptop', 'pc2', { name: '網管筆電', pos: [-3, 5], ip: '192.168.10.22', gw: '192.168.10.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'r1:Gi0/0/0'], ['r1:Gi0/0/1', 'sw1:1'], ['r1:Gi0/0/2', 'web:eth0'], ['pc1:eth0', 'sw1:2'], ['pc2:eth0', 'sw1:3']]);
    },
    objectives: [
      { type: 'tcp', from: 'pc1', name: 'www.example.com', port: 443, label: '辦公室照樣上網（https://www.example.com，DNS 也要通）' },
      { type: 'ping', from: 'pc1', ip: '8.8.8.8', label: '辦公室 ping 得到 8.8.8.8' },
      { type: 'tcp', from: 'pc2', ip: '192.168.20.10', port: 22, label: '網管筆電可以 SSH 到 DMZ 的網站伺服器' },
      { type: 'tcp', from: 'inet', ip: WEBPUB, port: 443, label: `外面的人開得了 https://${WEBPUB}` },
      { type: 'tcp', from: 'inet', ip: WEBPUB, port: 22, expect: false, label: '外面的人 SSH 不到 DMZ 的伺服器' },
      { type: 'tcp', from: 'web', ip: '192.168.10.21', port: 445, expect: false, label: 'DMZ 的伺服器連不進辦公室（被入侵了也一樣）' },
      {
        type: 'check', label: '三個介面都在 zone 裡（INSIDE、DMZ、OUTSIDE），不同 zone 之間只靠 zone-pair 放行',
        test(s) {
          const d = dev(s, 'r1');
          const miss = d.ifaces.slice(0, 3).find((i) => !i.zone);
          if (miss) return `${miss.label} 還沒有加進任何 zone`;
          const zs = new Set(d.ifaces.slice(0, 3).map((i) => i.zone));
          return zs.size === 3 || '辦公室、DMZ、網際網路要在三個不同的 zone';
        },
      },
    ],
    hints: [
      'R1：zone security INSIDE、zone security DMZ、zone security OUTSIDE；介面上 zone-member security <zone>（或在 ACL 分頁的 Zone-Based Firewall 卡片）。',
      'class-map type inspect match-any IN-OUT-CM → match protocol http / https / dns / icmp；policy-map type inspect IN-OUT-PM → class type inspect IN-OUT-CM → inspect。',
      'zone-pair security IN-OUT source INSIDE destination OUTSIDE → service-policy type inspect IN-OUT-PM。INSIDE → DMZ 放 https、ssh；OUTSIDE → DMZ 只放 https。',
      'DMZ → INSIDE 不要建 zone-pair：沒有 zone-pair 就全部拒絕。inspect 會自動放行回程，所以 OUTSIDE → INSIDE 也不用開。',
    ],
    solve(s) {
      typeIn(s, 'r1', ['configure terminal', 'zone security INSIDE', 'exit', 'zone security DMZ', 'exit', 'zone security OUTSIDE', 'exit',
        'class-map type inspect match-any IN-OUT-CM', 'match protocol http', 'match protocol https', 'match protocol dns', 'match protocol icmp', 'exit',
        'class-map type inspect match-any IN-DMZ-CM', 'match protocol https', 'match protocol ssh', 'match protocol icmp', 'exit',
        'class-map type inspect match-any OUT-DMZ-CM', 'match protocol https', 'exit',
        'policy-map type inspect IN-OUT-PM', 'class type inspect IN-OUT-CM', 'inspect', 'exit', 'exit',
        'policy-map type inspect IN-DMZ-PM', 'class type inspect IN-DMZ-CM', 'inspect', 'exit', 'exit',
        'policy-map type inspect OUT-DMZ-PM', 'class type inspect OUT-DMZ-CM', 'inspect', 'exit', 'exit',
        'zone-pair security IN-OUT source INSIDE destination OUTSIDE', 'service-policy type inspect IN-OUT-PM', 'exit',
        'zone-pair security IN-DMZ source INSIDE destination DMZ', 'service-policy type inspect IN-DMZ-PM', 'exit',
        'zone-pair security OUT-DMZ source OUTSIDE destination DMZ', 'service-policy type inspect OUT-DMZ-PM', 'exit',
        'interface gi0/0/1', 'zone-member security INSIDE', 'exit', 'interface gi0/0/2', 'zone-member security DMZ', 'exit', 'interface gi0/0/0', 'zone-member security OUTSIDE', 'end']);
      recompute(s);
    },
    recap: ['ZBF 以 zone 為單位：同一個 zone 互通、不同 zone 預設拒絕、zone-pair 加上 policy-map type inspect 才放行；有 zone 和沒 zone 的介面之間不通。', 'inspect 是有狀態的（回程自動放行），pass 是單向的；沒有指向 self 的 zone-pair 時，路由器本身的流量不受影響。'],
  },
];
