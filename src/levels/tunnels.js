// 第七章補充：GRE 與 recursive routing、GRE over IPsec、從 crypto map 換成 VTI、DMVPN phase 2、IPsec 穿過 NAT（NAT-T）
import { makeDevice as D, makeState, setLine, cloneState } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { advance, recompute, settle, transact } from '../engine/sim.js';
import { fmtIp, parseIp } from '../engine/ip.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const lines = (n) => Array.from({ length: n }, (_, k) => ({ id: 'line' + (k + 1), label: '線路 ' + (k + 1), media: 'rj45' }));
const inetOf = (defs) => {
  const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: lines(defs.length) });
  defs.forEach(([gw, ip, mask], k) => setLine(inet, 'line' + (k + 1), { type: 'static', gw, mask: mask || '255.255.255.252', assign: ip }));
  return inet;
};
const rt = (id, name, pos) => D('isr4331', id, { name, pos });
const tun = (s, id, n = 0) => dev(s, id).ifaces.find((i) => i.id === 'Tu' + n);
const ipOf = (s, id) => dev(s, id).ifaces[0].rt.ip;
/** 兩台路由器在 Tunnel 上的 OSPF 鄰居是不是 FULL */
const fullOn = (s, a, b, ifId = 'Tu0') => (dev(s, a).rt.nbrs || []).some((n) => n.dev === b && n.iface === ifId && n.state === 'full');
const ospfVia = (s, id, net, bits, ifId = 'Tu0') => (dev(s, id).rt.routes || []).find((r) => r.net === parseIp(net) && r.bits === bits && r.type === 'O' && r.iface && r.iface.id === ifId);
/** 關卡一開始當作已經運作很久：拿掉設定過程中算出來的執行期狀態（IPsec、OSPF 都視為早就建好） */
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
const IKE = ['crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit'];

export const LEVELS22 = [
  // ─────────────────────────────────────────────── GRE 與 recursive routing
  {
    id: 'l88', chapter: 7, title: '兩個分公司的連線一下通一下斷', subtitle: 'GRE 通道與 recursive routing', tags: ['GRE', 'Tunnel', 'OSPF', 'recursive routing', '故障排除'],
    brief: '台北 TPE-RT 和台中 TXG-RT 各自接一條網際網路，之前用 GRE 通道把兩邊的內網接起來，再在通道上跑 OSPF。上週接手的工程師覺得 network 敘述一條一條寫太麻煩，在兩台路由器上都改成 network 0.0.0.0 255.255.255.255 area 0。從那之後，台北存取台中檔案伺服器的連線一下通一下斷，路由器的 log 也一直跳出奇怪的訊息。請讓通道穩定下來；兩邊的內網路由還是要靠 OSPF 交換。',
    given: [
      ['TPE-RT', 'WAN 203.0.113.2/30（ISP 閘道 .1）· 內網 10.1.0.0/24'], ['TXG-RT', 'WAN 198.51.100.2/30（ISP 閘道 .1）· 內網 10.2.0.0/24'],
      ['GRE Tunnel0', 'TPE 10.255.0.1/30 ↔ TXG 10.255.0.2/30'], ['檔案伺服器', 'TXG-FS 10.2.0.20（SMB 445）'], ['OSPF', 'process 1、area 0'],
    ],
    learn: [
      { t: 'GRE 通道', d: '在原本的封包外面再包一層 IP 標頭（外層位址是兩台路由器的公用 IP）加上 4 位元組的 GRE 標頭，總共多 24 位元組。兩邊的私有網段就像接了一條專線，OSPF 的 multicast 也能過去 — crypto map 的站對站 VPN 做不到。GRE 本身完全不加密。' },
      { t: 'Tunnel 的 line protocol', d: 'tunnel source 的介面是 up、而且路由表裡有路到 tunnel destination，Tunnel 就是 up/up — 對面有沒有設定、收不收得到都不管。要偵測對面，得加上 keepalive。' },
      { t: 'Recursive routing', d: '通道上的 OSPF 學到了「tunnel destination 所在的網段」，這條路比原本的預設路由更精確，於是往 destination 的封包要先進 Tunnel 才能到 destination。IOS 偵測到就把 Tunnel 暫停（%TUN-5-RECURDOWN），路由跟著消失、Tunnel 又起來、OSPF 又學到…一直 flapping。' },
      { t: '解法', d: '外層的網段（WAN）不要放進 Tunnel 上跑的路由協定：network 敘述寫精確，只包含 Tunnel 與內網。另一種作法是替 tunnel destination 加一條 /32 的靜態路由指向 ISP（最長相符會贏過 OSPF 學到的 /30）。' },
      { t: 'Tunnel 的 OSPF cost', d: 'Tunnel 介面預設頻寬只有 100 Kbit/sec，OSPF cost 是 1000。同時有實體線路可以走的時候，OSPF 不會挑 Tunnel。網路類型預設是 point-to-point，不選 DR。' },
    ],
    setup() {
      const s = makeState([
        inetOf([['203.0.113.1', '203.0.113.2'], ['198.51.100.1', '198.51.100.2']]),
        rt('tpe', 'TPE-RT', [-7, -4]), rt('txg', 'TXG-RT', [7, -4]),
        D('pc', 'tpc', { name: '台北的同事', pos: [-7, 3], ip: '10.1.0.50', gw: '10.1.0.1' }),
        D('tower', 'fs', { name: 'TXG-FS', pos: [7, 3], ip: '10.2.0.20', gw: '10.2.0.1', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
      ], [['inet:line1', 'tpe:Gi0/0/0'], ['inet:line2', 'txg:Gi0/0/0'], ['tpc:eth0', 'tpe:Gi0/0/1'], ['fs:eth0', 'txg:Gi0/0/1']]);
      recompute(s);
      const side = (id, wan, gw, lan, me, peer, rid) => typeIn(s, id, ['configure terminal',
        'interface Gi0/0/0', `ip address ${wan} 255.255.255.252`, 'no shutdown', 'interface Gi0/0/1', `ip address ${lan} 255.255.255.0`, 'exit',
        `ip route 0.0.0.0 0.0.0.0 ${gw}`,
        'interface Tunnel0', `ip address ${me} 255.255.255.252`, 'tunnel source Gi0/0/0', `tunnel destination ${peer}`, 'exit',
        'router ospf 1', `router-id ${rid}`, 'network 0.0.0.0 255.255.255.255 area 0', 'end', 'write memory']);
      side('tpe', '203.0.113.2', '203.0.113.1', '10.1.0.1', '10.255.0.1', '198.51.100.2', '1.1.1.1');
      side('txg', '198.51.100.2', '198.51.100.1', '10.2.0.1', '10.255.0.2', '203.0.113.2', '2.2.2.2');
      return fresh(s);
    },
    objectives: [
      {
        type: 'check', label: '通道穩定：接下來兩分鐘，兩邊的 Tunnel0 一直是 up，不再出現 recursive routing',
        test(s) {
          const t = cloneState(s);
          settle(t);
          for (let k = 1; k <= 12; k++) {
            advance(t, 10);
            for (const id of ['tpe', 'txg']) {
              const i = tun(t, id);
              if (!i) return `${dev(t, id).name} 沒有 Tunnel0`;
              if (!i.rt.link) return `${k * 10} 秒後 ${dev(t, id).name} 的 Tunnel0 變成 down：${(i.rt.tun && i.rt.tun.why) || ''}`;
            }
          }
          return true;
        },
      },
      { type: 'tcp', from: 'tpc', to: 'fs', port: 445, label: '台北的同事存取得到台中的檔案伺服器' },
      {
        type: 'check', label: '兩邊的內網路由是 OSPF 經過 Tunnel0 學到的',
        test(s) {
          if (!fullOn(s, 'tpe', 'txg')) return 'TPE-RT 和 TXG-RT 在 Tunnel0 上不是 OSPF 的 FULL 鄰居';
          if (!ospfVia(s, 'tpe', '10.2.0.0', 24)) return 'TPE-RT 沒有從 Tunnel0 用 OSPF 學到 10.2.0.0/24';
          if (!ospfVia(s, 'txg', '10.1.0.0', 24)) return 'TXG-RT 沒有從 Tunnel0 用 OSPF 學到 10.1.0.0/24';
          return true;
        },
      },
    ],
    hints: [
      'TPE-RT 的 CLI：show logging 一直出現 %TUN-5-RECURDOWN: Tunnel0 temporarily disabled due to recursive routing；show interfaces tunnel 0 也寫著原因。',
      'show ip route 198.51.100.2：往 Tunnel0 的 destination 竟然是 OSPF 從 Tunnel0 學到的 198.51.100.0/30 — 要先進 Tunnel 才能到 Tunnel 的另一端，這就是 recursive routing。network 0.0.0.0 255.255.255.255 把 WAN 介面也放進了 OSPF。',
      '兩台都改：router ospf 1 → no network 0.0.0.0 255.255.255.255 area 0 → network 10.255.0.0 0.0.0.3 area 0 → network 10.1.0.0 0.0.0.255 area 0（台中是 10.2.0.0）。（另一種作法：ip route 198.51.100.2 255.255.255.255 203.0.113.1，讓 destination 永遠走 ISP。）',
    ],
    solve(s) {
      for (const [id, lan] of [['tpe', '10.1.0.0'], ['txg', '10.2.0.0']]) {
        typeIn(s, id, ['configure terminal', 'router ospf 1', 'no network 0.0.0.0 255.255.255.255 area 0', 'network 10.255.0.0 0.0.0.3 area 0', `network ${lan} 0.0.0.255 area 0`, 'end', 'write memory']);
      }
    },
    recap: ['Tunnel 的 destination 一定要從外層（實體線路）學到；外層的網段放進 Tunnel 上的路由協定，就會 recursive routing、一直 flapping。', 'GRE 沒有 keepalive 時，只要有路到 destination 就是 up/up，不代表對面真的收得到。'],
  },

  // ─────────────────────────────────────────────── GRE over IPsec
  {
    id: 'l89', chapter: 7, title: '稽核報告：ERP 的內容在網路上看得到', subtitle: 'GRE over IPsec：tunnel protection', tags: ['GRE', 'IPsec', 'tunnel protection', 'ACL', 'OSPF'],
    brief: '總公司 HQ-RT 和工廠 FAC-RT 之間用 GRE 通道跑 OSPF，工廠的同仁經過通道使用總公司的 ERP。資安顧問在 ISP 機房側錄了一段流量，報告附上的截圖裡，工廠同仁打開 ERP 的封包內容一覽無遺。改善要求：通道一定要用 IPsec 加密（AES-256、SHA-256、DH 群組 14，預先共用金鑰 Fac!Gre#2026），OSPF 照常運作；總公司外部介面的 ACL 不能再放行沒有加密的 GRE。',
    given: [
      ['HQ-RT', 'WAN 203.0.113.10/30 · 內網 10.10.0.0/24（ERP 10.10.0.20，HTTPS）· 外部 ACL EDGE'], ['FAC-RT', 'WAN 198.51.100.6/30 · 內網 10.20.0.0/24'],
      ['GRE Tunnel0', 'HQ 10.255.1.1/30 ↔ FAC 10.255.1.2/30，OSPF area 0'], ['加密規定', 'IKE：AES-256 / SHA-256 / DH 14 · IPsec：esp-aes 256 esp-sha256-hmac · PSK Fac!Gre#2026'],
    ],
    learn: [
      { t: 'GRE 不加密', d: 'GRE 只是在外面多包一層 IP + GRE 標頭，裡面原本的位址、埠號、內容在線路上全部看得到。GRE 的好處是能跑 OSPF、能帶 multicast；要保密就要再加上 IPsec。' },
      { t: 'tunnel protection', d: 'IOS 在 Tunnel 介面上 tunnel protection ipsec profile <名稱>：從 Tunnel 送出去的 GRE 封包，整個再用 ESP 加密。IPsec profile 裡只要指定 transform-set（加密與雜湊）；要保護哪些流量由 Tunnel 自己決定（proxy ID 是「gre host 本端 host 對端」），不用寫 crypto ACL。' },
      { t: 'IKE 與金鑰', d: '第一階段 crypto isakmp policy（加密、雜湊、DH 群組、pre-share），金鑰 crypto isakmp key <金鑰> address <對端>；第二階段 crypto ipsec transform-set。兩端都要有一組相同的提案。GRE over IPsec 常用 mode transport：外面已經有 GRE 的 IP 標頭，不用再包一層，省 20 位元組。' },
      { t: '外部 ACL 要放什麼', d: '加密之後，網際網路上只剩 IKE（UDP 500）和 ESP（IP 協定 50）。GRE 包在 ESP 裡面，外部 ACL 不用、也不應該再放行 GRE（協定 47）— 不然攻擊者可以直接送明文的 GRE 進來。' },
      { t: 'MTU', d: 'GRE 多 24 位元組、ESP 再多約 73：Tunnel 裡實際只放得下大約 1400。實務上會在 Tunnel 上 ip mtu 1400、ip tcp adjust-mss 1360，避免加密後的封包被切片。' },
    ],
    setup() {
      const s = makeState([
        inetOf([['203.0.113.9', '203.0.113.10'], ['198.51.100.5', '198.51.100.6']]),
        rt('hq', 'HQ-RT', [-7, -4]), rt('fac', 'FAC-RT', [7, -4]),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-7, 3], ip: '10.10.0.20', gw: '10.10.0.1', services: [{ proto: 'tcp', port: 443, name: 'ERP（HTTPS）' }] }),
        D('pc', 'fpc', { name: '工廠的同仁', pos: [7, 3], ip: '10.20.0.50', gw: '10.20.0.1' }),
      ], [['inet:line1', 'hq:Gi0/0/0'], ['inet:line2', 'fac:Gi0/0/0'], ['erp:eth0', 'hq:Gi0/0/1'], ['fpc:eth0', 'fac:Gi0/0/1']]);
      recompute(s);
      const side = (id, wan, gw, lan, me, peer, net) => typeIn(s, id, ['configure terminal',
        'interface Gi0/0/0', `ip address ${wan} 255.255.255.252`, 'no shutdown', 'interface Gi0/0/1', `ip address ${lan} 255.255.255.0`, 'exit', `ip route 0.0.0.0 0.0.0.0 ${gw}`,
        'interface Tunnel0', `ip address ${me} 255.255.255.252`, 'tunnel source Gi0/0/0', `tunnel destination ${peer}`, 'exit',
        'router ospf 1', 'network 10.255.1.0 0.0.0.3 area 0', `network ${net} 0.0.0.255 area 0`, 'end']);
      side('hq', '203.0.113.10', '203.0.113.9', '10.10.0.1', '10.255.1.1', '198.51.100.6', '10.10.0.0');
      side('fac', '198.51.100.6', '198.51.100.5', '10.20.0.1', '10.255.1.2', '203.0.113.10', '10.20.0.0');
      // 總公司的外部 ACL：只放行從工廠來的 GRE 與 ping
      typeIn(s, 'hq', ['configure terminal', 'ip access-list extended EDGE', '10 permit gre host 198.51.100.6 host 203.0.113.10', '20 permit icmp any host 203.0.113.10', 'exit',
        'interface Gi0/0/0', 'ip access-group EDGE in', 'end', 'write memory']);
      typeIn(s, 'fac', ['write memory']);
      return fresh(s);
    },
    objectives: [
      { type: 'tcp', from: 'fpc', to: 'erp', port: 443, label: '工廠的同仁打得開 ERP' },
      {
        type: 'check', label: '網際網路上只看得到加密的 ESP，看不到 GRE 裡面的內容',
        test(s) {
          const r = transact(s, 'fpc', { proto: 'tcp', dst: ipOf(s, 'erp'), dport: 443, quiet: true });
          if (!r.ok) return 'ERP 還連不上：' + r.reason;
          if (r.hops.some((h) => h.proto === 'gre')) return '線路上還有明文的 GRE：裡面的 ERP 封包誰都看得到（Tunnel0 還沒有 tunnel protection）';
          if (!r.hops.some((h) => h.proto === 'esp')) return '工廠到 ERP 的流量沒有經過 IPsec';
          return true;
        },
      },
      { type: 'check', label: 'OSPF 在 Tunnel0 上照常運作（FULL）', test: (s) => fullOn(s, 'hq', 'fac') || 'HQ-RT 和 FAC-RT 在 Tunnel0 上不是 OSPF 的 FULL 鄰居' },
      {
        type: 'check', label: '加密符合規定：IKE 用 AES-256 / SHA-256 / DH 14，IPsec 用 AES-256 / SHA-256',
        test(s) {
          for (const id of ['hq', 'fac']) {
            const d = dev(s, id), T = d.rt.tunnels.find((t) => t.prot && t.up);
            if (!T) return `${d.name} 沒有建立 tunnel protection 的 IPsec SA`;
            if (!(d.isakmp || []).length || !d.isakmp.every((p) => p.enc === 'aes256' && p.hash === 'sha256' && String(p.dh) === '14')) return `${d.name} 的 crypto isakmp policy 不符合規定（要 encryption aes 256、hash sha256、group 14）`;
            if (T.cfg.enc2 !== 'aes256' || T.cfg.hash2 !== 'sha256') return `${d.name} 的 transform-set 不是 esp-aes 256 esp-sha256-hmac`;
          }
          return true;
        },
      },
      {
        type: 'check', label: 'HQ-RT 外部的 ACL 還在，但不再放行沒有加密的 GRE',
        test(s) {
          const i = dev(s, 'hq').ifaces.find((x) => x.id === 'Gi0/0/0');
          if (!(i.aclIn || []).length) return 'Gi0/0/0 進入方向的 ACL 被拿掉了：外部介面一定要有 ACL';
          if (i.aclIn.some((r) => r.action === 'permit' && (r.proto === 'gre' || r.proto === 'ip'))) return 'EDGE 還放行 GRE（或整個 ip）：攻擊者可以送明文的 GRE 進來';
          return true;
        },
      },
    ],
    hints: [
      '工廠同仁的電腦開啟「封包擷取」，再連一次 ERP：經過 ISP 的封包是 GRE，展開來裡面的位址與 TCP 443 都看得到。',
      '兩端都要：crypto isakmp policy 10 → encryption aes 256 → hash sha256 → authentication pre-share → group 14；crypto isakmp key Fac!Gre#2026 address <對端 WAN>；crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac → mode transport；crypto ipsec profile GRE-PROT → set transform-set TS；interface Tunnel0 → tunnel protection ipsec profile GRE-PROT。（或在「VPN」分頁建立 IKE 政策、金鑰與 IPsec profile，再到「介面」分頁的 Tunnel0 選擇加密）',
      'HQ-RT 的 IKE 一直建不起來：外部 ACL EDGE 只放行 GRE 和 ping，IKE 的 UDP 500 和 ESP 都被擋掉了。ip access-list extended EDGE → no 10 → 10 permit udp host 198.51.100.6 host 203.0.113.10 eq isakmp → 15 permit esp host 198.51.100.6 host 203.0.113.10。',
    ],
    solve(s) {
      for (const [id, peer] of [['hq', '198.51.100.6'], ['fac', '203.0.113.10']]) {
        typeIn(s, id, ['configure terminal', ...IKE, `crypto isakmp key Fac!Gre#2026 address ${peer}`, 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode transport', 'exit',
          'crypto ipsec profile GRE-PROT', 'set transform-set TS', 'exit', 'interface Tunnel0', 'tunnel protection ipsec profile GRE-PROT', 'ip mtu 1400', 'ip tcp adjust-mss 1360', 'end', 'write memory']);
      }
      typeIn(s, 'hq', ['configure terminal', 'ip access-list extended EDGE', 'no 10', '10 permit udp host 198.51.100.6 host 203.0.113.10 eq isakmp', '15 permit esp host 198.51.100.6 host 203.0.113.10', 'end', 'write memory']);
    },
    recap: ['GRE 讓兩邊像接了專線、能跑 OSPF，但不加密；tunnel protection ipsec profile 把整個 GRE 封包再包進 ESP。', '加密之後網際網路上只有 UDP 500 和 ESP：外部 ACL 放行這兩個就好，不要再放行明文的 GRE。'],
  },

  // ─────────────────────────────────────────────── crypto map → VTI
  {
    id: 'l90', chapter: 7, title: '每加一個網段就要改兩邊的 ACL', subtitle: '從 crypto map 換成 VTI，在上面跑 OSPF', tags: ['VTI', 'IPsec', 'route-based VPN', 'OSPF', 'transform-set'],
    brief: '總公司 HQ-RT 和門市 BR-RT 之間原本是 crypto map 的站對站 VPN：門市每多一個網段，兩邊的 crypto ACL 都要改。這次門市加了收銀機的網段（10.2.50.0/24，POS 主機在總公司），同事決定順便改成 route-based 的 VTI，用 OSPF 交換路由。他已經把舊的 crypto map 拆掉、兩邊的 Tunnel0 也建好了，可是通道一直起不來，門市現在完全連不到總公司。請修好它：兩邊的網段都要透過 OSPF 學到，不要再寫往對方內網的靜態路由。',
    given: [
      ['HQ-RT', 'WAN 203.0.113.18/30 · 內網 10.1.0.0/24（檔案伺服器 10.1.0.10、POS 主機 10.1.0.30）'], ['BR-RT', 'WAN 198.51.100.34/30 · 辦公網段 10.2.0.0/24 · 收銀機 10.2.50.0/24'],
      ['VTI Tunnel0', 'HQ 10.255.2.1/30 ↔ BR 10.255.2.2/30 · tunnel mode ipsec ipv4'], ['加密', 'IKE AES-256 / SHA-256 / DH 14 · IPsec esp-aes 256 esp-sha256-hmac · PSK Vti!Store#2026'],
    ],
    learn: [
      { t: 'Policy-based 與 Route-based', d: 'crypto map 是 policy-based：crypto ACL 列出哪些流量要加密，網段一變兩邊都要改，也跑不了 OSPF。VTI（Virtual Tunnel Interface）是 route-based：路由指到 Tunnel 介面的封包就加密，要加網段只要讓路由協定學到。' },
      { t: 'tunnel mode ipsec ipv4', d: 'VTI 不包 GRE，直接把封包放進 ESP（比 GRE over IPsec 少 24 位元組），proxy ID 是 0.0.0.0/0 ↔ 0.0.0.0/0。設定和 GRE over IPsec 一樣：IKE 政策、金鑰、transform-set、IPsec profile，再在 Tunnel 上 tunnel protection ipsec profile。' },
      { t: 'VTI 的 line protocol 跟著 IPsec', d: 'GRE 只要有路到 destination 就是 up；VTI 要 IPsec SA 真的建起來才是 up。所以 transform-set 或金鑰不一致時，show ip interface brief 直接看到 Tunnel0 up/down — 比 crypto map 好查很多。' },
      { t: '查 IPsec 的問題', d: 'show interfaces tunnel 0 看 line protocol；show crypto isakmp sa 看第一階段（QM_IDLE 代表 IKE 好了）；show crypto ipsec sa 看第二階段有沒有 SA、加解密的封包數；show crypto ipsec transform-set 比對兩端的提案。' },
    ],
    setup() {
      const s = makeState([
        inetOf([['203.0.113.17', '203.0.113.18'], ['198.51.100.33', '198.51.100.34']]),
        rt('hq', 'HQ-RT', [-7, -4]), rt('br', 'BR-RT', [7, -4]),
        D('sw5', 'hqsw', { name: 'HQ-SW', pos: [-7, 0.5] }),
        D('tower', 'fs', { name: '檔案伺服器', pos: [-10, 4.5], ip: '10.1.0.10', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
        D('tower', 'pos', { name: 'POS 主機', pos: [-4, 4.5], ip: '10.1.0.30', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 443, name: 'POS 後台（HTTPS）' }] }),
        D('pc', 'bpc', { name: '門市辦公室的電腦', pos: [4, 4], ip: '10.2.0.50', gw: '10.2.0.1' }),
        D('pc', 'till', { name: '收銀機 POS-01', pos: [10, 4], ip: '10.2.50.11', gw: '10.2.50.1' }),
      ], [['inet:line1', 'hq:Gi0/0/0'], ['inet:line2', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'hqsw:1'], ['fs:eth0', 'hqsw:2'], ['pos:eth0', 'hqsw:3'], ['bpc:eth0', 'br:Gi0/0/1'], ['till:eth0', 'br:Gi0/0/2']]);
      recompute(s);
      typeIn(s, 'hq', ['configure terminal', 'interface Gi0/0/0', 'ip address 203.0.113.18 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.1.0.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 203.0.113.17',
        ...IKE, 'crypto isakmp key Vti!Store#2026 address 198.51.100.34', 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'exit', 'crypto ipsec profile VTI', 'set transform-set TS', 'exit',
        'interface Tunnel0', 'ip address 10.255.2.1 255.255.255.252', 'tunnel source Gi0/0/0', 'tunnel destination 198.51.100.34', 'tunnel mode ipsec ipv4', 'tunnel protection ipsec profile VTI', 'exit',
        'router ospf 1', 'router-id 1.1.1.1', 'network 10.1.0.0 0.0.0.255 area 0', 'end', 'write memory']);
      // 門市：transform-set 還是舊範本的 AES-128 / SHA-1
      typeIn(s, 'br', ['configure terminal', 'interface Gi0/0/0', 'ip address 198.51.100.34 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.2.0.1 255.255.255.0', 'interface Gi0/0/2', 'ip address 10.2.50.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 198.51.100.33',
        ...IKE, 'crypto isakmp key Vti!Store#2026 address 203.0.113.18', 'crypto ipsec transform-set TS esp-aes esp-sha-hmac', 'exit', 'crypto ipsec profile VTI', 'set transform-set TS', 'exit',
        'interface Tunnel0', 'ip address 10.255.2.2 255.255.255.252', 'tunnel source Gi0/0/0', 'tunnel destination 203.0.113.18', 'tunnel mode ipsec ipv4', 'tunnel protection ipsec profile VTI', 'exit',
        'router ospf 1', 'router-id 2.2.2.2', 'network 10.255.2.0 0.0.0.3 area 0', 'network 10.2.0.0 0.0.0.255 area 0', 'network 10.2.50.0 0.0.0.255 area 0', 'end', 'write memory']);
      return fresh(s);
    },
    objectives: [
      { type: 'tcp', from: 'bpc', to: 'fs', port: 445, label: '門市辦公室存取得到總公司的檔案伺服器' },
      { type: 'tcp', from: 'till', to: 'pos', port: 443, label: '收銀機連得到總公司的 POS 主機' },
      {
        type: 'check', label: '兩邊的網段都是 OSPF 經過 VTI 學到的（沒有往對方內網的靜態路由）',
        test(s) {
          if (!tun(s, 'hq').rt.link) return `HQ-RT 的 Tunnel0 是 line protocol down：${tun(s, 'hq').rt.tun.why}`;
          for (const id of ['hq', 'br']) if ((dev(s, id).routes || []).some((r) => r.dst && r.dst.startsWith('10.'))) return `${dev(s, id).name} 有往 10.x 的靜態路由：規定是用 OSPF 學`;
          if (!ospfVia(s, 'hq', '10.2.50.0', 24)) return 'HQ-RT 沒有從 Tunnel0 用 OSPF 學到 10.2.50.0/24';
          if (!ospfVia(s, 'br', '10.1.0.0', 24)) return 'BR-RT 沒有從 Tunnel0 用 OSPF 學到 10.1.0.0/24';
          return true;
        },
      },
    ],
    hints: [
      'show ip interface brief：Tunnel0 是 up / down。VTI 的 line protocol 跟著 IPsec SA — show interfaces tunnel 0 最下面寫著 SA 為什麼建不起來。',
      '第二階段的提案不一致：BR-RT 的 transform-set TS 還是 esp-aes esp-sha-hmac（AES-128 / SHA-1）。在 BR-RT 重新定義 crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac。',
      'Tunnel 起來之後，OSPF 還是沒有鄰居：HQ-RT 的 router ospf 1 只有內網，沒有 network 10.255.2.0 0.0.0.3 area 0。',
    ],
    solve(s) {
      typeIn(s, 'br', ['configure terminal', 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'end', 'write memory']);
      typeIn(s, 'hq', ['configure terminal', 'router ospf 1', 'network 10.255.2.0 0.0.0.3 area 0', 'end', 'write memory']);
    },
    recap: ['VTI 是 route-based VPN：路由指到 Tunnel 的封包就加密，加網段只要路由協定學到，不用改 ACL。', 'VTI 的 line protocol 跟著 IPsec SA：提案或金鑰不一致時 Tunnel 是 up/down。'],
  },

  // ─────────────────────────────────────────────── DMVPN phase 2
  {
    id: 'l91', chapter: 7, title: '門市之間的監視器畫面', subtitle: 'DMVPN：mGRE、NHRP 與 spoke 之間的直接通道', tags: ['DMVPN', 'mGRE', 'NHRP', 'OSPF', 'DR'],
    brief: '公司用 DMVPN 串起總公司（HUB-RT）和兩家門市（STORE1、STORE2）：總公司只要一個 Tunnel 介面，門市越開越多也不用再改總公司的設定，門市之間還能直接建立通道。廠商設定完就走了，結果 OSPF 一直起不來，門市連不到總公司的 POS 主機。另外，一號店的店長要看二號店的監視器（NVR），老闆規定這種大流量不准繞回總公司（總公司的線路很貴），要直接走門市之間的通道。',
    given: [
      ['HUB-RT', 'WAN 203.0.113.2/30 · 內網 10.0.1.0/24（POS 主機 10.0.1.10）· Tunnel0 10.0.0.1/24（NHS）'],
      ['STORE1', 'WAN 198.51.100.2/30 · 內網 10.1.1.0/24（店長的電腦 10.1.1.10）· Tunnel0 10.0.0.11'],
      ['STORE2', 'WAN 192.0.2.2/30 · 內網 10.2.1.0/24（NVR 10.2.1.30，RTSP 554）· Tunnel0 10.0.0.12'],
      ['DMVPN', 'mGRE、tunnel key 100、NHRP network-id 1、驗證字串 DMVPN26 · IPsec 用萬用金鑰（address 0.0.0.0）'],
    ],
    learn: [
      { t: 'DMVPN 的三個零件', d: 'mGRE：一個 Tunnel 介面可以送給很多個對端（tunnel mode gre multipoint，沒有 destination）。NHRP：每個 spoke 開機就向 hub（NHS）註冊「我的 Tunnel 位址是 10.0.0.11、公用位址是 198.51.100.2」，要送給誰時再來問。IPsec：tunnel protection 讓每一段 GRE 都加密。' },
      { t: 'Multicast 要靠 hub 複製', d: '網際網路不會轉送 multicast。OSPF 的 Hello 是 multicast：spoke 用 ip nhrp nhs … multicast 把 Hello 送給 hub；hub 要 ip nhrp map multicast dynamic，才會把 Hello 複製給每個註冊上來的 spoke。少了它，hub 聽得到 spoke、spoke 聽不到 hub，鄰居卡在 INIT。' },
      { t: 'Phase 2：spoke 之間直接走', d: 'OSPF 在 Tunnel 上用 broadcast，SPOKE1 學到 STORE2 內網的下一站是 STORE2 的 Tunnel 位址 10.0.0.12（不是 hub）。SPOKE1 不知道 10.0.0.12 的公用位址，先送給 hub 轉送、同時用 NHRP 問 hub；問到之後兩個 spoke 直接建 IPsec，之後的封包就不經過 hub。' },
      { t: 'DR 一定要是 hub', d: 'spoke 之間收不到彼此的 Hello。broadcast 網段要選 DR：如果某個 spoke 搶到 DR，其他 spoke 跟它建不起鄰居、算不出路。在每個 spoke 的 Tunnel 上 ip ospf priority 0（永遠不當 DR），讓 hub 當 DR。Tunnel 介面預設的 point-to-point 也不行：hub 一個介面只能有一個鄰居。' },
    ],
    setup() {
      const s = makeState([
        inetOf([['203.0.113.1', '203.0.113.2'], ['198.51.100.1', '198.51.100.2'], ['192.0.2.1', '192.0.2.2']]),
        rt('hub', 'HUB-RT', [0, -4.5]), rt('s1', 'STORE1', [-8, -1.5]), rt('s2', 'STORE2', [8, -1.5]),
        D('tower', 'pos', { name: 'POS 主機', pos: [0, 2], ip: '10.0.1.10', gw: '10.0.1.1', services: [{ proto: 'tcp', port: 443, name: 'POS 後台（HTTPS）' }] }),
        D('pc', 'mgr', { name: '一號店店長的電腦', pos: [-8, 5], ip: '10.1.1.10', gw: '10.1.1.1' }),
        D('nas', 'nvr', { name: '二號店的 NVR', pos: [8, 5], ip: '10.2.1.30', gw: '10.2.1.1', services: [{ proto: 'tcp', port: 554, name: 'RTSP 監視器串流' }] }),
      ], [['inet:line1', 'hub:Gi0/0/0'], ['inet:line2', 's1:Gi0/0/0'], ['inet:line3', 's2:Gi0/0/0'], ['pos:eth0', 'hub:Gi0/0/1'], ['mgr:eth0', 's1:Gi0/0/1'], ['nvr:eth0', 's2:Gi0/0/1']]);
      recompute(s);
      const crypto = [...IKE, 'crypto isakmp key Dmvpn!2026 address 0.0.0.0', 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode transport', 'exit', 'crypto ipsec profile DMVPN', 'set transform-set TS', 'exit'];
      const base = (wan, gw, lan) => ['interface Gi0/0/0', `ip address ${wan} 255.255.255.252`, 'no shutdown', 'interface Gi0/0/1', `ip address ${lan} 255.255.255.0`, 'exit', `ip route 0.0.0.0 0.0.0.0 ${gw}`, ...crypto];
      const tunnel = (ip, extra) => ['interface Tunnel0', `ip address ${ip} 255.255.255.0`, 'ip nhrp authentication DMVPN26', 'ip nhrp network-id 1', ...extra, 'ip ospf network broadcast',
        'tunnel source Gi0/0/0', 'tunnel mode gre multipoint', 'tunnel key 100', 'tunnel protection ipsec profile DMVPN', 'exit'];
      // hub：少了 ip nhrp map multicast dynamic
      typeIn(s, 'hub', ['configure terminal', ...base('203.0.113.2', '203.0.113.1', '10.0.1.1'), ...tunnel('10.0.0.1', []),
        'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.255 area 0', 'network 10.0.1.0 0.0.0.255 area 0', 'end', 'write memory']);
      // STORE1 照範本設了 priority 0；STORE2 漏掉了，而且它的 Router ID 最大
      typeIn(s, 's1', ['configure terminal', ...base('198.51.100.2', '198.51.100.1', '10.1.1.1'), ...tunnel('10.0.0.11', ['ip nhrp nhs 10.0.0.1 nbma 203.0.113.2 multicast', 'ip ospf priority 0']),
        'router ospf 1', 'router-id 11.11.11.11', 'network 10.0.0.0 0.0.0.255 area 0', 'network 10.1.1.0 0.0.0.255 area 0', 'end', 'write memory']);
      typeIn(s, 's2', ['configure terminal', ...base('192.0.2.2', '192.0.2.1', '10.2.1.1'), ...tunnel('10.0.0.12', ['ip nhrp nhs 10.0.0.1 nbma 203.0.113.2 multicast']),
        'router ospf 1', 'router-id 12.12.12.12', 'network 10.0.0.0 0.0.0.255 area 0', 'network 10.2.1.0 0.0.0.255 area 0', 'end', 'write memory']);
      return fresh(s);
    },
    objectives: [
      { type: 'tcp', from: 'mgr', to: 'pos', port: 443, label: '一號店連得到總公司的 POS 主機' },
      { type: 'tcp', from: 'mgr', to: 'nvr', port: 554, label: '一號店的店長看得到二號店的監視器' },
      {
        type: 'check', label: 'HUB-RT 和兩家門市都是 OSPF 的 FULL 鄰居，hub 是 DR',
        test(s) {
          for (const id of ['s1', 's2']) if (!fullOn(s, 'hub', id)) return `HUB-RT 和 ${dev(s, id).name} 在 Tunnel0 上不是 FULL 鄰居${((dev(s, 'hub').rt.ospf || { ifs: {} }).ifs.Tu0 || { why: [] }).why.length ? '：' + dev(s, 'hub').rt.ospf.ifs.Tu0.why[0] : ''}`;
          const inf = (dev(s, 'hub').rt.ospf.ifs || {}).Tu0;
          if (!inf || inf.dr !== 'hub/Tu0') return `Tunnel0 這個網段的 DR 不是 HUB-RT（是 ${inf && inf.dr ? dev(s, inf.dr.split('/')[0]).name : '還沒選出來'}）`;
          return true;
        },
      },
      {
        type: 'check', label: '門市之間的監視器流量直接走：第一個封包之後，不再經過 HUB-RT',
        test(s) {
          const t = cloneState(s);
          settle(t);
          const go = () => transact(t, 'mgr', { proto: 'tcp', dst: ipOf(t, 'nvr'), dport: 554 });
          const a = go();
          if (!a.ok) return '一號店連不到二號店的 NVR：' + a.reason;
          settle(t, 30);
          const b = go();
          if (!b.ok) return '第二次連線失敗：' + b.reason;
          if (b.l3.some((h) => h.dev === 'hub')) return `NHRP 解析之後還是經過 HUB-RT（${b.l3.map((h) => fmtIp(h.ip)).join(' → ')}）：一號店往二號店內網的下一站要是 STORE2 的 Tunnel 位址`;
          return true;
        },
      },
    ],
    hints: [
      'STORE1：show dmvpn 看得到 hub 是 UP，代表 NHRP 註冊與 IPsec 都沒問題；可是 show ip ospf neighbor 是空的。HUB-RT：show ip ospf interface tunnel 0 或「狀態」分頁的 OSPF，寫著只收得到 spoke 的 Hello。',
      'hub 要把 multicast 複製給註冊上來的 spoke：HUB-RT → interface Tunnel0 → ip nhrp map multicast dynamic。',
      '鄰居起來之後，一號店還是到不了：DR 被 Router ID 最大的 STORE2 搶走了，STORE1 聽不到 STORE2 的 Hello。STORE2 → interface Tunnel0 → ip ospf priority 0。',
    ],
    solve(s) {
      typeIn(s, 'hub', ['configure terminal', 'interface Tunnel0', 'ip nhrp map multicast dynamic', 'end', 'write memory']);
      typeIn(s, 's2', ['configure terminal', 'interface Tunnel0', 'ip ospf priority 0', 'end', 'write memory']);
    },
    recap: ['DMVPN = mGRE + NHRP + IPsec：spoke 向 hub 註冊，要送給別的 spoke 時用 NHRP 問出它的公用位址，再直接建通道。', 'OSPF 在 DMVPN 上：hub 要 ip nhrp map multicast dynamic，網路類型用 broadcast，spoke 設 priority 0 讓 hub 當 DR。'],
  },

  // ─────────────────────────────────────────────── NAT-T
  {
    id: 'l92', chapter: 7, title: '新分公司在共享辦公室裡', subtitle: 'IPsec 穿過 NAT：NAT-T 與 UDP 4500', tags: ['IPsec', 'NAT-T', 'NAT', 'PAT', 'ACL'],
    brief: '新分公司租在共享辦公室：大樓的網路只給分公司一個私有位址 192.168.50.20，大樓的路由器再用 PAT 把大家換成同一個公用 IP 198.51.100.66 出去（那台由大樓管理處管理，你沒有權限）。分公司的 BR-RT 照公司範本設好了站對站 IPsec，總公司 HQ-RT 那一端也由同事加好了，可是通道一直建不起來。請讓分公司存取得到總公司的檔案伺服器；總公司的 IT 也要能主動連到分公司的印表機管理頁。總公司外部介面的 ACL 不能拿掉。',
    given: [
      ['HQ-RT', 'WAN 203.0.113.2/30 · 內網 10.1.0.0/24（檔案伺服器 10.1.0.10、IT 的電腦 10.1.0.50）· 外部 ACL EDGE'],
      ['BR-RT', 'WAN 192.168.50.20/24（大樓的網路，閘道 192.168.50.1）· 內網 10.2.0.0/24（印表機 10.2.0.30）'],
      ['BLDG-GW', '大樓的路由器：192.168.50.0/24 → PAT → 198.51.100.66（你沒有權限）'], ['VPN', 'crypto map · IKE AES-256 / SHA-256 / DH 14 · PSK Bldg!NatT#2026'],
    ],
    learn: [
      { t: 'ESP 過不了 PAT', d: 'PAT 靠「連接埠號碼」分辨內部是哪一台；ESP（IP 協定 50）根本沒有連接埠，大部分的 PAT 沒辦法替它轉換。所以中間有 NAT 時，IKE（UDP 500）談得起來，加密的資料卻過不去。' },
      { t: 'NAT-T（NAT Traversal）', d: 'IKE 協商時兩端互相比對位址的雜湊（NAT-D）：對方看到的位址和自己的不一樣，就知道中間有 NAT。接著 IKE 改用 UDP 4500，ESP 也包進 UDP 4500 裡（多 8 位元組），PAT 就有埠號可以轉換。IOS 預設開啟（crypto ipsec nat-transparency udp-encapsulation）。' },
      { t: '對端要寫 NAT 之後的位址', d: '總公司看到的分公司是大樓的公用 IP 198.51.100.66，不是 192.168.50.20。總公司的 set peer 與 crypto isakmp key 都要寫 198.51.100.66；分公司自己的設定照舊指向總公司。' },
      { t: '防火牆 / ACL 要放 UDP 4500', d: '有 NAT-T 時，網際網路上的 IPsec 是 UDP 500 和 UDP 4500（ACL 裡寫 eq non500-isakmp）。只放 UDP 500 和 ESP 的 ACL，在中間有 NAT 時會讓 IKE 一換到 4500 就斷掉。' },
    ],
    setup() {
      const s = makeState([
        inetOf([['203.0.113.1', '203.0.113.2'], ['198.51.100.65', '198.51.100.66']]),
        rt('hq', 'HQ-RT', [-7, -4]),
        D('isr4321', 'bldg', { name: 'BLDG-GW', pos: [7, -5.5], locked: true }),
        rt('br', 'BR-RT', [7, -1.5]),
        D('sw5', 'hqsw', { name: 'HQ-SW', pos: [-7, 0.5] }),
        D('tower', 'fs', { name: '檔案伺服器', pos: [-10, 4.5], ip: '10.1.0.10', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
        D('pc', 'it', { name: '總公司 IT 的電腦', pos: [-4, 4.5], ip: '10.1.0.50', gw: '10.1.0.1' }),
        D('pc', 'bpc', { name: '分公司的電腦', pos: [4.5, 4.5], ip: '10.2.0.50', gw: '10.2.0.1' }),
        D('printer', 'prn', { name: '分公司的印表機', pos: [10, 4.5], ip: '10.2.0.30', gw: '10.2.0.1', services: [{ proto: 'tcp', port: 443, name: '印表機管理頁（HTTPS）' }] }),
        D('sw5', 'brsw', { name: 'BR-SW', pos: [7, 1.5] }),
      ], [['inet:line1', 'hq:Gi0/0/0'], ['inet:line2', 'bldg:Gi0/0/0'], ['bldg:Gi0/0/1', 'br:Gi0/0/0'], ['hq:Gi0/0/1', 'hqsw:1'], ['fs:eth0', 'hqsw:2'], ['it:eth0', 'hqsw:3'],
        ['br:Gi0/0/1', 'brsw:1'], ['bpc:eth0', 'brsw:2'], ['prn:eth0', 'brsw:3']]);
      recompute(s);
      typeIn(s, 'bldg', ['configure terminal', 'interface Gi0/0/0', 'ip address 198.51.100.66 255.255.255.252', 'ip nat outside', 'no shutdown', 'interface Gi0/0/1', 'ip address 192.168.50.1 255.255.255.0', 'ip nat inside', 'exit',
        'ip route 0.0.0.0 0.0.0.0 198.51.100.65', 'access-list 1 permit 192.168.50.0 0.0.0.255', 'ip nat inside source list 1 interface Gi0/0/0 overload', 'end', 'write memory']);
      const vpn = (lan, peerLan, peer) => [...IKE, `crypto isakmp key Bldg!NatT#2026 address ${peer}`, 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'exit',
        'ip access-list extended VPN', `permit ip ${lan} 0.0.0.255 ${peerLan} 0.0.0.255`, 'exit', 'crypto map CMAP 10 ipsec-isakmp', `set peer ${peer}`, 'set transform-set TS', 'match address VPN', 'exit', 'interface Gi0/0/0', 'crypto map CMAP', 'exit'];
      // 總公司：同事照分公司報給他的位址設了對端（192.168.50.20 是私有位址）；外部 ACL 只放 IKE 和 ESP
      typeIn(s, 'hq', ['configure terminal', 'interface Gi0/0/0', 'ip address 203.0.113.2 255.255.255.252', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.1.0.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
        ...vpn('10.1.0.0', '10.2.0.0', '192.168.50.20'),
        'ip access-list extended EDGE', '10 permit udp any host 203.0.113.2 eq isakmp', '20 permit esp any host 203.0.113.2', '30 permit icmp any host 203.0.113.2', 'exit', 'interface Gi0/0/0', 'ip access-group EDGE in', 'end', 'write memory']);
      typeIn(s, 'br', ['configure terminal', 'interface Gi0/0/0', 'ip address 192.168.50.20 255.255.255.0', 'no shutdown', 'interface Gi0/0/1', 'ip address 10.2.0.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 192.168.50.1',
        ...vpn('10.2.0.0', '10.1.0.0', '203.0.113.2'), 'end', 'write memory']);
      return fresh(s);
    },
    objectives: [
      { type: 'tcp', from: 'bpc', to: 'fs', port: 445, label: '分公司存取得到總公司的檔案伺服器' },
      { type: 'tcp', from: 'it', to: 'prn', port: 443, label: '總公司的 IT 主動連得到分公司的印表機管理頁' },
      {
        type: 'check', label: '通道用 NAT-T（ESP 包在 UDP 4500 裡），總公司外部的 ACL 還在',
        test(s) {
          const T = dev(s, 'hq').rt.tunnels.find((t) => t.cfg && t.up);
          if (!T) return 'HQ-RT 沒有建立任何 IPsec 通道';
          if (!T.natT) return 'HQ-RT 的通道沒有用 NAT-T';
          const i = dev(s, 'hq').ifaces.find((x) => x.id === 'Gi0/0/0');
          if (!(i.aclIn || []).length) return 'Gi0/0/0 進入方向的 ACL 被拿掉了：外部介面一定要有 ACL';
          if (i.aclIn.some((r) => r.action === 'permit' && r.proto === 'ip' && r.src === 'any')) return 'EDGE 放行了所有的 ip：只要放 IPsec 需要的就好';
          return true;
        },
      },
    ],
    hints: [
      'BR-RT：show crypto session 寫著通道為什麼沒有建立 — 總公司看到的來源位址是 198.51.100.66（大樓 PAT 之後的位址），不是 192.168.50.20。',
      'HQ-RT：crypto isakmp key Bldg!NatT#2026 address 198.51.100.66；crypto map CMAP 10 → set peer 198.51.100.66（舊的 192.168.50.20 可以 no crypto isakmp key … address 192.168.50.20 拿掉）。',
      '通道偵測到 NAT，IKE 與 ESP 改走 UDP 4500，卻被 EDGE 擋掉：ip access-list extended EDGE → 25 permit udp any host 203.0.113.2 eq non500-isakmp。',
    ],
    solve(s) {
      typeIn(s, 'hq', ['configure terminal', 'no crypto isakmp key Bldg!NatT#2026 address 192.168.50.20', 'crypto isakmp key Bldg!NatT#2026 address 198.51.100.66', 'crypto map CMAP 10 ipsec-isakmp', 'set peer 198.51.100.66', 'exit',
        'ip access-list extended EDGE', '25 permit udp any host 203.0.113.2 eq non500-isakmp', 'end', 'write memory']);
    },
    recap: ['中間有 PAT：ESP 沒有連接埠過不去，IKE 偵測到 NAT 之後改用 UDP 4500（NAT-T），ESP 也包進 UDP 裡。', '對端看到的是 NAT 之後的位址：設定要指向它；外部 ACL 要放 UDP 500 與 UDP 4500。'],
  },
];
