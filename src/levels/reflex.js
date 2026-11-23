// 第六章補充：只放行「回應」的 ACL — established 只認得 TCP；Reflexive ACL（reflect / evaluate）連 UDP 與 ICMP 都能記
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { ifc } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const WAN = '203.0.113.34';

export const LEVELS61 = [
  {
    id: 'l141', chapter: 6, title: '網頁打得開，名稱卻查不到', subtitle: 'established 與 Reflexive ACL', tags: ['ACL', 'established', 'Reflexive ACL', 'reflect / evaluate', 'DNS'],
    brief: '分公司的路由器直接接網際網路。前一任網管在 WAN 進來的方向設了 ACL：「只放行連線的回應，其他全部擋掉」。結果用 IP 開網頁沒問題，但打網址就查不到、ping 8.8.8.8 也不通。請讓分公司正常上網，但網際網路上的人主動連進來（連 ping 路由器）仍然全部擋掉。',
    given: [
      ['Router', `Gi0/0/0 → ISP（${WAN}/30，NAT overload）· Gi0/0/1 → 分公司 10.0.10.0/24`],
      ['FROM-ISP（Gi0/0/0 in）', '10 permit tcp any any established · 20 deny ip any any'],
      ['DNS', '8.8.8.8（UDP 53）'],
    ],
    learn: [
      { t: 'established', d: 'permit tcp any any established 只比對有 ACK 或 RST 旗標的 TCP 封包，也就是「已經建立的連線」的封包；外面主動送來的 SYN 沒有 ACK，就被後面的 deny 擋掉。但它只認得 TCP：DNS 的 UDP 回應、ping 的 Echo Reply 都沒有旗標可看，一律被擋。' },
      { t: 'Reflexive ACL', d: '在出去的方向寫 permit … reflect <名稱>：封包離開時，路由器記下一筆「位址與連接埠反過來」的暫時規則。進來的方向寫 evaluate <名稱>：只有符合暫時規則的封包（也就是自己先送出去的連線的回應）才放行。TCP、UDP、ICMP 都適用；暫時規則閒置 300 秒就消失（timeout 可以調）。' },
      { t: '和防火牆的差別', d: 'Reflexive ACL 是陽春版的狀態檢查：只看位址與連接埠，不看 TCP 的序號，也不處理會另外開連線的協定（例如主動模式的 FTP）。要更完整的狀態檢查用 Zone-Based Firewall 或防火牆。' },
      { t: '怎麼查', d: 'show access-lists：Reflexive IP access list MIRROR 底下列出現在的暫時規則與剩下的秒數，evaluate 那一行有比對到的次數。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: WAN }),
        D('isr4321', 'rt', {
          name: 'Router', pos: [0, -4],
          init(d) {
            Object.assign(d.ifaces[0], { ip: WAN, mask: '255.255.255.252', gateway: '203.0.113.33', nat: true });
            Object.assign(d.ifaces[1], { ip: '10.0.10.1', mask: '255.255.255.0' });
          },
        }),
        D('sw8', 'sw', { name: 'Switch', pos: [0, 0.5] }),
        D('pc', 'pc', { name: '分公司 PC', pos: [-4, 4.5], ip: '10.0.10.50', gw: '10.0.10.1', dns: '8.8.8.8' }),
        D('laptop', 'nb', { name: '店長的筆電', pos: [4, 4.5], ip: '10.0.10.51', gw: '10.0.10.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ['pc:eth0', 'sw:2'], ['nb:eth0', 'sw:3']]);
      recompute(s);
      typeIn(s, 'rt', ['enable', 'configure terminal', 'ip access-list extended FROM-ISP', 'permit tcp any any established', 'deny ip any any', 'exit',
        'interface Gi0/0/0', 'ip access-group FROM-ISP in', 'end', 'write memory']);
      recompute(s);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', name: 'www.example.com', port: 443, label: '分公司 PC 開得了 https://www.example.com（要先查得到名稱）' },
      { type: 'ping', from: 'nb', ip: '8.8.8.8', label: '筆電 ping 得到 8.8.8.8' },
      { type: 'ping', from: 'inet', ip: WAN, expect: false, label: '網際網路上的人 ping 不到路由器' },
      { type: 'tcp', from: 'inet', ip: WAN, port: 22, expect: false, label: '網際網路上的人連不上路由器的 SSH' },
      {
        type: 'check', label: '用 Reflexive ACL：出去的方向 reflect、進來的方向 evaluate',
        test(s) {
          const w = ifc(s, 'rt', 'Gi0/0/0'), out = w.aclOut || [], inn = w.aclIn || [];
          const names = new Set(out.filter((r) => r.reflect).map((r) => r.reflect));
          if (!names.size) return 'Gi0/0/0 出去的方向沒有 permit … reflect <名稱> 的 ACL（ip access-group <名稱> out）';
          if (!inn.some((r) => r.evaluate && names.has(r.evaluate))) return `Gi0/0/0 進來的 ACL 沒有 evaluate ${[...names][0]}`;
          if (inn.some((r) => r.action === 'permit' && !r.established && r.src === 'any' && r.dst === 'any' && (r.proto === 'ip' || r.proto === 'udp' || r.proto === 'icmp') && !r.port && !r.icmp)) return '進來的 ACL 有一條整個放行的 permit：外面主動送進來的封包也會通過';
          return true;
        },
      },
    ],
    hints: [
      'PC 的終端機：nslookup www.example.com 逾時，ping 8.8.8.8 也逾時；Router 的 show access-lists 看 FROM-ISP：第 20 條 deny 的次數一直增加，第 10 條只放行 TCP。',
      'Router：ip access-list extended TO-ISP → permit tcp any any reflect MIRROR、permit udp any any reflect MIRROR、permit icmp any any reflect MIRROR；interface Gi0/0/0 → ip access-group TO-ISP out。',
      'ip access-list extended FROM-ISP → 15 evaluate MIRROR，再 no 10（established 用不到了）。show access-lists 可以看到 MIRROR 底下的暫時規則。',
    ],
    solve(s) {
      typeIn(s, 'rt', ['enable', 'configure terminal', 'ip access-list extended TO-ISP', 'permit tcp any any reflect MIRROR', 'permit udp any any reflect MIRROR', 'permit icmp any any reflect MIRROR', 'exit',
        'ip access-list extended FROM-ISP', '15 evaluate MIRROR', 'no 10', 'exit', 'interface Gi0/0/0', 'ip access-group TO-ISP out', 'end', 'write memory']);
    },
    recap: [
      'established 只看 TCP 的 ACK 旗標：DNS（UDP）與 ping 的回應都會被擋。',
      'Reflexive ACL：出去時 reflect 記下反過來的暫時規則，進來時 evaluate 比對，只有自己先送出去的連線的回應進得來。',
    ],
  },
];
