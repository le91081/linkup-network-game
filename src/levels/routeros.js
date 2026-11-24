// 第二章補充：MikroTik 清掉預設設定之後自己設 — 路由器自己上得了網，後面的電腦卻不行（沒有 masquerade）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { dev } from './util.js';

export const LEVELS89 = [
  {
    id: 'l169', chapter: 2, title: '路由器上得了網，電腦卻不行', subtitle: 'MikroTik RouterOS：位址、DHCP client 與 masquerade', tags: ['MikroTik', 'RouterOS', 'NAT', 'masquerade', 'DHCP'],
    brief: '店裡的 MikroTik hEX 被前一位工程師用 /system reset-configuration no-defaults=yes 清成空白的設定（連預設的位址、NAT 都沒有）。電信業者的光纖數據機是橋接模式，WAN（ether1）要用 DHCP 拿位址；店裡的電腦接在 ether2 後面的交換器，用 192.168.88.0/24、閘道 192.168.88.1、DNS 8.8.8.8。請用 RouterOS 的指令讓店裡的電腦上得了網。',
    given: [['hEX', 'ether1 → 業者（DHCP）· ether2 → 店裡的交換器'], ['店裡的網段', '192.168.88.0/24 · 閘道 192.168.88.1 · 收銀機 192.168.88.10'], ['DNS', '8.8.8.8（電腦直接問）']],
    learn: [
      { t: 'RouterOS 的指令', d: '選單式的路徑：/ip address、/ip route、/ip firewall nat，後面接 print / add / remove / set，參數寫成 名稱=值。改了立刻生效，沒有 commit，也沒有 running / startup 之分。/export 看整份設定。' },
      { t: 'WAN 用 DHCP', d: '/ip dhcp-client add interface=ether1：拿到位址、預設路由（add-default-route=yes）和 DNS。/ip dhcp-client print 看狀態，bound 才算拿到。' },
      { t: 'masquerade', d: '/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade：從 ether1 出去的封包，來源換成 ether1 的位址（就是 PAT）。少了這一條，路由器自己 /ping 8.8.8.8 通，後面的電腦用私有位址出去，ISP 直接丟掉。' },
      { t: 'Safe Mode', d: '遠端改防火牆、位址的時候，按 Ctrl+X 進 Safe Mode：連線斷掉的話，RouterOS 會自動復原 Safe Mode 之後改的東西，不會把自己鎖在外面。' },
    ],
    setup() {
      return makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -8] }), 'line1', { type: 'dhcp', gw: '203.0.113.1', assign: '203.0.113.77', dns: '8.8.8.8' }),
        D('hex', 'mt', { name: 'hEX', pos: [0, -3.5] }),
        D('sw5', 'sw', { name: '店裡的交換器', pos: [0, 0.5] }),
        D('pc', 'pos', { name: '收銀機', pos: [-4, 4], ip: '192.168.88.10', gw: '192.168.88.1', dns: '8.8.8.8' }),
      ], [['inet:line1', 'mt:ether1'], ['mt:ether2', 'sw:1'], ['pos:eth0', 'sw:2']]);
    },
    objectives: [
      { type: 'ping', from: 'pos', ip: '192.168.88.1', label: '收銀機 ping 得到閘道 192.168.88.1' },
      { type: 'tcp', from: 'pos', name: 'www.example.com', port: 443, label: '收銀機打得開 https://www.example.com' },
      {
        type: 'check', label: 'hEX 的 ether1 用 DHCP 拿到公用位址，有 srcnat masquerade',
        test(s) {
          const d = dev(s, 'mt'), w = d.ifaces.find((i) => i.id === 'ether1');
          if (w.mode !== 'dhcp' || w.rt.ip == null) return 'ether1 還沒有用 DHCP 拿到位址（/ip dhcp-client add interface=ether1）';
          return (d.ros.nat || []).some((x) => x.out === 'ether1') || '沒有 masquerade（/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade）';
        },
      },
    ],
    hints: [
      'hEX 的 Terminal：/ip address add address=192.168.88.1/24 interface=ether2（店裡的閘道）。',
      '/ip dhcp-client add interface=ether1，/ip dhcp-client print 看到 bound 就拿到位址和預設路由了。/ping 8.8.8.8 路由器自己通了。',
      '收銀機還是上不了網：/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade。',
    ],
    solve(s) {
      const d = dev(s, 'mt');
      Object.assign(d.ifaces.find((i) => i.id === 'ether2'), { mode: 'static', ip: '192.168.88.1', mask: '255.255.255.0' });
      Object.assign(d.ifaces.find((i) => i.id === 'ether1'), { mode: 'dhcp' });
      d.ros.nat.push({ chain: 'srcnat', action: 'masquerade', out: 'ether1' });
      d.ifaces.find((i) => i.id === 'ether1').nat = true;
    },
    recap: ['RouterOS 用選單路徑加 print / add / remove / set，改了立刻生效。', '後面的電腦要上網，一定要有 srcnat 的 masquerade；路由器自己通不代表後面的電腦通。'],
  },
];
