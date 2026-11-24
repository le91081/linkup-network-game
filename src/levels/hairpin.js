// 第三章補充：在公司裡連不到自己的網站（NAT hairpin 與 split DNS）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { dev, WEB } from './util.js';

const SITE = 'www.example.org', PUB = '203.0.113.11', PRIV = '192.168.20.10';
const rec = (s) => (dev(s, 'dns').dnsZone.records || []).find((r) => r.name.toLowerCase() === SITE && r.type === 'A');

export const LEVELS52 = [
  {
    id: 'l132', chapter: 3, title: '在公司裡打不開自己的網站，用手機 4G 卻可以', subtitle: 'NAT hairpin 與 split DNS', tags: ['NAT', 'hairpin', 'split DNS', 'DNS', 'DMZ'],
    brief: `公司的網站 ${SITE} 放在 DMZ，用靜態 NAT 對應到公用位址 ${PUB}。客戶從外面連都正常，可是辦公室裡的同事打開自己公司的網站卻一直轉圈圈，業務只好開手機熱點來展示網站。請讓辦公室的電腦也能用 ${SITE} 開網站，而且外面的人照樣連得到。`,
    given: [
      ['Edge-RT', `Gi0/0/0 203.0.113.10/29（outside，PAT）· Gi0/0/1 辦公室 192.168.10.0/24 · Gi0/0/2 DMZ 192.168.20.0/24`],
      ['靜態 NAT', `${PRIV} ↔ ${PUB}`], ['網站伺服器', `${PRIV}（HTTPS）`],
      ['內部 DNS 伺服器', `192.168.10.5 · 公司內部的名稱，其他的轉送給 8.8.8.8 · ${SITE} A ${PUB}（TTL 300）`],
      ['外部 DNS', `${SITE} A ${PUB}`], ['規定', '辦公室的電腦要繼續用內部的 DNS 伺服器'],
    ],
    learn: [
      { t: 'NAT hairpin', d: `內部的電腦去連「自己公司伺服器的公用位址」：封包從 inside 介面進到路由器，目的地卻是 ${PUB}。傳統的 inside / outside NAT 只轉換「從 outside 介面進來」的封包，這個封包不會被換成內部位址，連線就失敗了。這種情況叫 NAT hairpin（或 NAT loopback）。` },
      { t: 'split DNS', d: '最乾淨的解法：同一個名稱，內部的 DNS 回內部位址、外部的 DNS 回公用位址。內部的人直接連 DMZ，不用繞 NAT；外面的人照舊。很多公司的內部 DNS 本來就要放 AD、內部系統的名稱。' },
      { t: '其他做法', d: 'IOS 可以改用 NAT Virtual Interface（ip nat enable、ip nat source static），讓 hairpin 也能轉換；FortiGate 要讓 VIP 也套用在內部介面、再加一條 internal → internal 的政策。這些做法讓內部流量繞一圈 NAT，也比較難查。' },
      { t: 'DNS 快取', d: '改了 DNS 記錄之後，電腦上已經記住的舊答案要等 TTL 到期才會更新；用 resolvectl flush-caches 立刻清掉。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -8.5] }), 'line1', { type: 'static', gw: '203.0.113.9', mask: '255.255.255.248', assign: '203.0.113.10' }),
        D('isr4331', 'rt', {
          name: 'Edge-RT', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.10', mask: '255.255.255.248', gateway: '203.0.113.9', nat: true });
            Object.assign(d.ifaces[1], { ip: '192.168.10.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces[2], { ip: '192.168.20.1', mask: '255.255.255.0' });
            d.staticNat.push({ pub: PUB, priv: PRIV });
          },
        }),
        D('sw8', 'osw', { name: '辦公室交換器', pos: [-6, 0.5] }),
        D('sw8', 'dsw', { name: 'DMZ 交換器', pos: [6, 0.5] }),
        D('tower', 'dns', {
          name: '內部 DNS 伺服器', pos: [-9.5, 4.5], ip: '192.168.10.5', gw: '192.168.10.1', dns: '8.8.8.8', services: [{ proto: 'udp', port: 53, name: 'DNS' }],
          init(d) { d.dnsZone = { records: [{ name: SITE, type: 'A', value: PUB, ttl: 300 }, { name: 'erp.corp.local', type: 'A', value: '192.168.10.20', ttl: 3600 }] }; d.dnsForward = true; },
        }),
        D('pc', 'pc1', { name: '業務的電腦', pos: [-4.5, 5.5], ip: '192.168.10.51', gw: '192.168.10.1', dns: '192.168.10.5' }),
        D('tower', 'web', { name: '網站伺服器（DMZ）', pos: [7.5, 4.5], ip: PRIV, gw: '192.168.20.1', dns: '8.8.8.8', services: WEB }),
      ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'osw:1'], ['rt:Gi0/0/2', 'dsw:1'], ['dns:eth0', 'osw:2'], ['pc1:eth0', 'osw:3'], ['web:eth0', 'dsw:2']]);
      s.devices.inet.inet.dns[SITE] = PUB;
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc1', name: SITE, port: 443, label: `辦公室的電腦打得開 https://${SITE}` },
      { type: 'tcp', from: 'inet', ip: PUB, port: 443, label: `外面的人照樣打得開（公用位址 ${PUB}）` },
      {
        type: 'check', label: '辦公室的電腦還是用內部的 DNS 伺服器，外部 DNS 的記錄沒有改',
        test(s) {
          if ((dev(s, 'pc1').ifaces[0].dns || '').trim() !== '192.168.10.5') return '業務的電腦的 DNS 被改掉了：規定要用內部的 DNS 伺服器（公司內部的名稱只有它查得到）';
          if (s.devices.inet.inet.dns[SITE] !== PUB) return `外部 DNS 的 ${SITE} 不是 ${PUB}：外面的人會連不到`;
          return !!rec(s) || `內部 DNS 伺服器上沒有 ${SITE} 的 A 記錄`;
        },
      },
    ],
    hints: [
      `業務的電腦：nslookup ${SITE} 得到 ${PUB}（公用位址）。curl https://${SITE} 失敗，封包路徑停在 Edge-RT：從 inside 介面收到要給 ${PUB} 的封包，傳統 NAT 不轉換。`,
      `外面的人要用公用位址，裡面的人應該直接用內部位址 ${PRIV}：同一個名稱，內部 DNS 和外部 DNS 回不同的答案 (split DNS)。`,
      `內部 DNS 伺服器 →「DNS」分頁 → ${SITE} 的 A 記錄改成 ${PRIV}。`,
      '業務的電腦已經把舊的答案記在快取裡（TTL 300 秒）：在它的終端機打 resolvectl flush-caches，或等 5 分鐘。',
    ],
    solve(s) {
      rec(s).value = PRIV;
      if (s.dyn && s.dyn.dnsCache) delete s.dyn.dnsCache.pc1;
    },
    recap: [
      '傳統的 inside / outside NAT 不處理 hairpin：內部的人連公用位址會失敗。',
      '用 split DNS 讓內部的人直接拿到內部位址，是最乾淨的做法；改完記得 DNS 快取要清掉（或等 TTL）。',
    ],
  },
];
