// 第 10 章補充：故障排除（OSPF 鄰居、STP 根橋、VPN 通了卻不通）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { parseIp, netOf } from '../engine/ip.js';
import { iosSession } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { ospfPassive } from '../engine/ospf.js';
import { dev, ifc, swp, WEB } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });
const ospfNet = (cidr, area) => { const [a, b] = cidr.split('/'); return { net: netOf(parseIp(a), +b), bits: +b, area }; };
const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const twoLines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
const PSK = 'Tw!S2S#2026';

export const LEVELS15 = [
  // ─────────────────────────────────────────────── OSPF 鄰居
  {
    id: 'l66', chapter: 10, title: '分公司的 OSPF 鄰居起不來', subtitle: '驗證金鑰、被動介面與 network 敘述', tags: ['OSPF', '鄰居', 'MD5 驗證', 'passive-interface'],
    brief: '週末換了兩家分公司的路由器，週一早上兩邊都連不到總公司的 ERP。三台路由器都「有設 OSPF」，可是總公司的路由表裡一筆分公司的路由也沒有。請從鄰居關係開始查，讓兩家分公司都回到線上；公司規定 WAN 上的 OSPF 一定要驗證。',
    given: [
      ['HQ ↔ BR-1', '10.255.1.0/30（MD5 驗證，key 1）'], ['HQ ↔ BR-2', '10.255.2.0/30'], ['ERP', '10.0.0.10（總公司）'],
      ['BR-1 / BR-2 的網段', '10.1.0.0/24 / 10.2.0.0/24'], ['OSPF 金鑰', 'key 1：Br@nch#1'],
    ],
    learn: [
      { t: '鄰居起不來的常見原因', d: 'Hello / Dead 計時器不一致、區域不一致、驗證不一致（類型或金鑰）、子網路遮罩不一致、介面被設成被動、根本沒有在那個介面啟用 OSPF。卡在 EXSTART 通常是 MTU。' },
      { t: '查的順序', d: 'show ip ospf neighbor（有沒有鄰居、卡在哪個狀態）→ show ip ospf interface（介面有沒有在 OSPF 裡、計時器、驗證、是不是被動）→ show ip protocols / show running-config | section router ospf（network 敘述）→ show ip route ospf。' },
      { t: '驗證金鑰', d: 'MD5 驗證兩端的 key 編號和內容都要一樣，大小寫也算。金鑰在 running-config 裡是加密過的，看不出打錯，只能重新設定一次。' },
      { t: '被動介面', d: 'passive-interface default 會讓所有介面都不送 Hello；要建立鄰居的 WAN 介面要用 no passive-interface 個別打開。接使用者的 LAN 應該保持被動。' },
    ],
    setup() {
      const rtr = (model, id, name, pos, init) => D(model, id, { name, pos, init });
      return makeState([
        rtr('isr4331', 'hq', 'HQ-RT', [0, -5], (d) => {
          ip4(d, 'Gi0/0/0', '10.255.1.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.0.0.1'); ip4(d, 'Gi0/0/2', '10.255.2.1', '255.255.255.252');
          d.ospfNets = [ospfNet('10.0.0.0/8', 0)]; d.ospfPassive = ['Gi0/0/1'];
          Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ospfAuth: 'md5', ospfKey: { id: 1, key: 'Br@nch#1' } });
        }),
        rtr('isr4321', 'br1', 'BR-1', [-8, 1], (d) => {
          ip4(d, 'Gi0/0/0', '10.255.1.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.1.0.1');
          d.ospfNets = [ospfNet('10.0.0.0/8', 0)]; d.ospfPassive = ['Gi0/0/1'];
          // 小寫的 l 和數字 1 看起來很像
          Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ospfAuth: 'md5', ospfKey: { id: 1, key: 'Br@nch#l' } });
        }),
        rtr('isr4321', 'br2', 'BR-2', [8, 1], (d) => {
          ip4(d, 'Gi0/0/0', '10.255.2.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.2.0.1');
          // 新的範本：所有介面預設被動，但忘了打開 WAN；LAN 的 network 敘述也漏了
          d.ospfNets = [ospfNet('10.255.2.0/30', 0)]; d.ospfPassiveDefault = true; d.ospfNoPassive = [];
        }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [0, 1.5], ip: '10.0.0.10', gw: '10.0.0.1', services: WEB }),
        D('pc', 'pc1', { name: 'BR-1 的 PC', pos: [-8, 6], ip: '10.1.0.10', gw: '10.1.0.1' }),
        D('pc', 'pc2', { name: 'BR-2 的 PC', pos: [8, 6], ip: '10.2.0.10', gw: '10.2.0.1' }),
      ], [['hq:Gi0/0/0', 'br1:Gi0/0/0'], ['hq:Gi0/0/2', 'br2:Gi0/0/0'], ['erp:eth0', 'hq:Gi0/0/1'], ['pc1:eth0', 'br1:Gi0/0/1'], ['pc2:eth0', 'br2:Gi0/0/1']]);
    },
    objectives: [
      { type: 'ping', from: 'pc1', to: 'erp', label: 'BR-1 的 PC 連得到 ERP' },
      { type: 'tcp', from: 'pc2', to: 'erp', port: 443, label: 'BR-2 的 PC 可以使用 ERP (HTTPS)' },
      {
        type: 'check', label: 'HQ-RT 和兩台分公司路由器都是 FULL 鄰居',
        test(s) {
          const full = (dev(s, 'hq').rt.nbrs || []).filter((n) => n.state === 'full').map((n) => n.dev);
          const miss = ['br1', 'br2'].filter((id) => !full.includes(id)).map((id) => dev(s, id).name);
          return !miss.length || `HQ-RT 和 ${miss.join('、')} 還不是 FULL 鄰居（show ip ospf neighbor）`;
        },
      },
      {
        type: 'check', label: 'HQ ↔ BR-1 的 OSPF 仍然有 MD5 驗證',
        test: (s) => (['hq', 'br1'].every((id) => ifc(s, id, 'Gi0/0/0').ospfAuth === 'md5') ? true : 'WAN 上的 OSPF 驗證被拿掉了：公司規定要驗證，請把金鑰改成一樣，而不是關掉驗證'),
      },
      { type: 'check', label: 'BR-2 接使用者的 LAN 仍然是被動介面', test: (s) => (ospfPassive(dev(s, 'br2'), ifc(s, 'br2', 'Gi0/0/1')) ? true : 'BR-2 的 Gi0/0/1 接的是使用者，應該保持被動（不送 Hello）') },
    ],
    hints: [
      'HQ-RT 的 CLI：show ip ospf neighbor 只看得到… 一台都沒有。到 BR-1 用 show ip ospf interface Gi0/0/0 看驗證；金鑰在設定裡是加密的，直接重設一次：interface Gi0/0/0 → ip ospf message-digest-key 1 md5 Br@nch#1。',
      'BR-2：show ip ospf interface 會看到 Gi0/0/0 是被動介面（passive-interface default）。router ospf 1 → no passive-interface Gi0/0/0。',
      '鄰居起來之後，HQ-RT 的 show ip route ospf 還是沒有 10.2.0.0/24：BR-2 的 network 敘述漏了 LAN。router ospf 1 → network 10.2.0.0 0.0.0.255 area 0。',
    ],
    solve(s) {
      recompute(s);
      typeIn(s, 'br1', ['configure terminal', 'interface Gi0/0/0', 'ip ospf message-digest-key 1 md5 Br@nch#1', 'end']);
      typeIn(s, 'br2', ['configure terminal', 'router ospf 1', 'no passive-interface Gi0/0/0', 'network 10.2.0.0 0.0.0.255 area 0', 'end']);
    },
    recap: ['鄰居起不來：Hello 參數、區域、驗證、被動介面、有沒有啟用，一項一項對。', '鄰居起來了還沒有路由，就去看 network 敘述有沒有包含那個網段。'],
  },

  // ─────────────────────────────────────────────── STP 根橋
  {
    id: 'l67', chapter: 10, title: '流量為什麼繞去實驗室', subtitle: 'STP 根橋位置與 Root Guard', tags: ['STP', '根橋', 'Root Guard', '橋接器優先權'],
    brief: '這週大家都說 2 樓連伺服器特別慢。追蹤之後發現 2 樓到機房的流量竟然繞經實驗室那台測試用的交換器——它前幾天被人接上了 1 樓和 2 樓的交換器。實驗室的交換器同事還要用，不能拔掉；請讓根橋回到核心交換器，並確保以後實驗室再怎麼設定，也搶不走根橋。',
    given: [
      ['SW-Core', '核心交換器（機房），應該是根橋'], ['Lab 測試交換器', '接在 SW-1F 與 SW-2F 的 Gi0/10，設定可以改，但不能拔'],
      ['伺服器', '192.168.1.10（接在 SW-Core）'], ['網段', '192.168.1.0/24'],
    ],
    learn: [
      { t: '根橋決定了路徑', d: 'STP 從根橋往外長出一棵樹，每台交換器只保留一條往根橋最近的路，其他的備援線路都被封鎖。根橋放錯地方，流量就會繞遠路，甚至穿過不該經過的設備。' },
      { t: '誰當根橋', d: '橋接器 ID 最小的那一台：先比優先權（預設 32768，以 4096 為單位），一樣的話比 MAC。從別的地方帶來的交換器可能還留著很小的優先權。' },
      { t: '把根橋固定下來', d: '核心交換器設 spanning-tree vlan 1-4094 priority 4096（或 root primary），備援的核心設 8192（root secondary）。' },
      { t: 'Root Guard', d: '開在「根橋不應該出現在這個方向」的埠上（例如接實驗室、接客戶的埠）。對面一送來更好的 BPDU，這個埠就進入 root-inconsistent 被擋下，根橋不會被搶走；對方恢復正常後自動解除。' },
    ],
    setup() {
      const sw = (id, name, pos, init) => D('c2960', id, { name, pos, init(d) { d.sw.stp.portfastDefault = true; if (init) init(d); } });
      return makeState([
        sw('core', 'SW-Core', [0, -6]),
        sw('f1', 'SW-1F', [-7, -1]),
        sw('f2', 'SW-2F', [7, -1]),
        sw('lab', 'Lab 測試交換器', [0, 3.5], (d) => { d.sw.stp.prio = 4096; }),
        D('tower', 'srv', { name: '伺服器', pos: [7, -7.5], ip: '192.168.1.10', services: WEB }),
        D('pc', 'pc1', { name: '1F PC', pos: [-11, 3], ip: '192.168.1.21' }),
        D('pc', 'pc2', { name: '2F PC', pos: [11, 3], ip: '192.168.1.22' }),
        D('laptop', 'labpc', { name: '實驗室筆電', pos: [0, 8], ip: '192.168.1.99' }),
      ], [
        ['core:Gi0/1', 'f1:Gi0/9'], ['core:Gi0/2', 'f2:Gi0/9'], ['lab:Gi0/1', 'f1:Gi0/10'], ['lab:Gi0/2', 'f2:Gi0/10'],
        ['srv:eth0', 'core:Gi0/5'], ['pc1:eth0', 'f1:Gi0/1'], ['pc2:eth0', 'f2:Gi0/1'], ['labpc:eth0', 'lab:Gi0/3'],
      ]);
    },
    objectives: [
      { type: 'check', label: 'SW-Core 是根橋', test: (s) => { const r = (dev(s, 'core').rt.stp || { root: {} }).root[1]; return r === 'core' || `目前的根橋是 ${r ? dev(s, r).name : '（沒有）'}`; } },
      { type: 'tcp', from: 'pc2', to: 'srv', port: 443, avoid: 'lab', label: '2F PC 到伺服器不再繞經實驗室' },
      { type: 'tcp', from: 'pc1', to: 'srv', port: 443, avoid: 'lab', label: '1F PC 到伺服器不經過實驗室' },
      { type: 'tcp', from: 'labpc', to: 'srv', port: 443, label: '實驗室的筆電還是連得到伺服器' },
      {
        type: 'check', label: 'SW-1F、SW-2F 接實驗室的埠都開了 Root Guard',
        test(s) {
          const miss = [['f1', 'SW-1F'], ['f2', 'SW-2F']].filter(([id]) => !swp(s, id, 'Gi0/10').rootguard).map(([, n]) => n);
          return !miss.length || `${miss.join('、')} 的 Gi0/10 還沒有開 Root Guard`;
        },
      },
    ],
    hints: [
      '任何一台交換器的「安全」分頁（或 CLI 的 show spanning-tree）都看得到：根橋是 Lab 測試交換器，它的優先權被設成 4096。',
      'SW-Core 的優先權改成 4096（CLI：spanning-tree vlan 1-4094 priority 4096）；Lab 測試交換器改回預設的 32768。',
      'SW-1F 和 SW-2F 的 Gi0/10 開 Root Guard（連接埠 → 進階設定，或 spanning-tree guard root）。注意：實驗室的優先權如果沒有改回來，Root Guard 會把它整台擋在外面，實驗室的筆電就連不到伺服器了。',
    ],
    solve(s) {
      dev(s, 'core').sw.stp.prio = 4096;
      dev(s, 'lab').sw.stp.prio = 32768;
      swp(s, 'f1', 'Gi0/10').rootguard = true;
      swp(s, 'f2', 'Gi0/10').rootguard = true;
    },
    recap: ['根橋要指定，不要讓 MAC 或別人帶來的設定決定。', 'Root Guard 擋的是「搶根橋」，不是擋設備：對方規矩了，埠就自動恢復。'],
  },

  // ─────────────────────────────────────────────── VPN 通了卻不通
  {
    id: 'l68', chapter: 10, title: 'VPN 通了，資料卻過不去', subtitle: 'NAT 例外與加密的 ACL', tags: ['IPsec', 'NAT 例外', 'crypto ACL', 'show crypto'],
    brief: '分公司把防火牆換成了 Cisco 路由器。設定的同事說「VPN 已經通了」，show crypto isakmp sa 也確實是 QM_IDLE，可是辦公室連不到總公司的 ERP，倉庫新開的網段更是完全沒反應；上網倒是一切正常。請找出原因。',
    given: [
      ['總公司 HQ-FW', '203.0.113.18 · 內網 10.1.0.0/24 · ERP 10.1.0.10'], ['分公司 Branch-RT', '198.51.100.34'],
      ['辦公室', '10.2.0.0/24（Gi0/0/1）'], ['倉庫（新）', '10.2.1.0/24（Gi0/0/2）'], ['預先共用金鑰', PSK],
    ],
    learn: [
      { t: '通道 Up 不代表流量會進去', d: 'IOS 的 crypto map 只加密「符合加密 ACL」的封包。封包在出口介面上先做 NAT、再比對加密的 ACL：來源被換成公用 IP 之後，就不符合了，於是被當成一般的上網流量送出去。' },
      { t: 'NAT 例外', d: 'NAT 的 ACL 先 deny 往對方內網的流量，再 permit 其他上網的流量：ip access-list extended NAT → deny ip 10.2.0.0 0.0.255.255 10.1.0.0 0.0.0.255 → permit ip 10.2.0.0 0.0.255.255 any。' },
      { t: '加密的 ACL 要涵蓋所有網段，而且兩端互為鏡像', d: '新開的網段要加進加密的 ACL；對面那一端的「遠端網段」也要跟著加，兩邊保護的範圍不一樣，第二階段就建不起來。' },
      { t: '查的指令', d: 'show crypto isakmp sa（第一階段）、show crypto ipsec sa（第二階段，以及 encaps / decaps 計數器有沒有在增加）、show ip nat translations（往總公司的流量是不是被 NAT 了）。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: twoLines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' });
      setLine(inet, 'line2', { type: 'static', gw: '198.51.100.33', mask: '255.255.255.252', assign: '198.51.100.34' });
      const s = makeState([
        inet,
        D('fg60f', 'hq', {
          name: 'HQ-FW', pos: [-7, -4.5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
            Object.assign(g('internal'), { ip: '10.1.0.1', mask: '255.255.255.0' });
            d.vpns.push({ name: 'Branch', peer: '198.51.100.34', psk: PSK, local: '10.1.0.0/24', remote: '10.2.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14' });
            d.policies.push(allow('內網上網', 'internal', 'wan1', { nat: true }), allow('往分公司', 'internal', 'vpn:Branch'), allow('分公司進來', 'vpn:Branch', 'internal'));
          },
        }),
        D('isr4331', 'br', { name: 'Branch-RT', pos: [7, -4.5] }),
        D('sw5', 'hq-sw', { name: 'HQ-Switch', pos: [-7, 0.3] }),
        D('sw5', 'br-sw', { name: 'BR-Switch', pos: [4.5, 0.3] }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-10.5, 4.8], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('pc', 'hq-pc', { name: '總公司 PC', pos: [-4, 4.8], ip: '10.1.0.50', gw: '10.1.0.1', dns: '8.8.8.8' }),
        D('pc', 'br-pc', { name: '辦公室 PC', pos: [4.5, 4.8], ip: '10.2.0.50', gw: '10.2.0.1', dns: '8.8.8.8' }),
        D('pc', 'pos', { name: '倉庫 POS', pos: [11, 1.5], ip: '10.2.1.50', gw: '10.2.1.1', dns: '8.8.8.8' }),
      ], [
        ['inet:line1', 'hq:wan1'], ['inet:line2', 'br:Gi0/0/0'], ['hq:1', 'hq-sw:1'], ['erp:eth0', 'hq-sw:2'], ['hq-pc:eth0', 'hq-sw:3'],
        ['br:Gi0/0/1', 'br-sw:1'], ['br-pc:eth0', 'br-sw:2'], ['pos:eth0', 'br:Gi0/0/2'],
      ]);
      recompute(s);
      // 同事用 CLI 設定的分公司路由器：VPN 的參數都對，但 NAT 沒有排除往總公司的流量，倉庫的網段也沒有加進加密的 ACL
      typeIn(s, 'br', ['configure terminal',
        'interface Gi0/0/0', 'ip address 198.51.100.34 255.255.255.252', 'ip nat outside', 'no shutdown',
        'interface Gi0/0/1', 'ip address 10.2.0.1 255.255.255.0', 'ip nat inside',
        'interface Gi0/0/2', 'ip address 10.2.1.1 255.255.255.0', 'ip nat inside', 'exit',
        'ip route 0.0.0.0 0.0.0.0 198.51.100.33',
        'access-list 1 permit any', 'ip nat inside source list 1 interface Gi0/0/0 overload',
        'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
        `crypto isakmp key ${PSK} address 203.0.113.18`,
        'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
        'ip access-list extended VPN-HQ', 'permit ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.0.255', 'exit',
        'crypto map CMAP 10 ipsec-isakmp', 'set peer 203.0.113.18', 'set transform-set TS', 'match address VPN-HQ', 'exit',
        'interface Gi0/0/0', 'crypto map CMAP', 'end', 'write memory']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'br-pc', to: 'erp', port: 443, label: '辦公室 PC 可以經由 VPN 使用 ERP' },
      { type: 'tcp', from: 'pos', to: 'erp', port: 443, label: '倉庫 POS 也可以經由 VPN 使用 ERP' },
      { type: 'ping', from: 'hq-pc', to: 'br-pc', label: '總公司 PC 可以 ping 到辦公室 PC' },
      { type: 'tcp', from: 'br-pc', name: 'www.example.com', port: 443, label: '分公司上網不受影響' },
      { type: 'tcp', from: 'inet', ip: '203.0.113.18', port: 443, expect: false, label: 'ERP 沒有直接暴露在網際網路上' },
    ],
    hints: [
      'Branch-RT 的 CLI：show crypto isakmp sa 是 QM_IDLE（第一階段好的）。從辦公室 PC 連 ERP，封包追蹤會看到它在 Gi0/0/0「先做了 NAT」，來源變成 198.51.100.34 之後就不符合加密的 ACL 了。',
      'NAT 要排除往總公司的流量：ip access-list extended NAT → deny ip 10.2.0.0 0.0.255.255 10.1.0.0 0.0.0.255 → permit ip 10.2.0.0 0.0.255.255 any；再 no ip nat inside source list 1 interface Gi0/0/0 overload、ip nat inside source list NAT interface Gi0/0/0 overload。',
      '倉庫的 10.2.1.0/24 不在 VPN-HQ 裡：ip access-list extended VPN-HQ → permit ip 10.2.1.0 0.0.0.255 10.1.0.0 0.0.0.255。HQ-FW 的通道（VPN 分頁）遠端網段也要加上 10.2.1.0/24，兩端要互為鏡像。',
    ],
    solve(s) {
      recompute(s);
      typeIn(s, 'br', ['configure terminal',
        'ip access-list extended NAT', 'deny ip 10.2.0.0 0.0.255.255 10.1.0.0 0.0.0.255', 'permit ip 10.2.0.0 0.0.255.255 any', 'exit',
        'no ip nat inside source list 1 interface Gi0/0/0 overload', 'ip nat inside source list NAT interface Gi0/0/0 overload',
        'ip access-list extended VPN-HQ', 'permit ip 10.2.1.0 0.0.0.255 10.1.0.0 0.0.0.255', 'end', 'write memory']);
      dev(s, 'hq').vpns[0].remote = '10.2.0.0/24, 10.2.1.0/24';
    },
    recap: ['通道 Up 只代表兩台路由器談好了；流量有沒有進通道，要看 NAT 例外與加密的 ACL。', '新增網段時，兩端的加密範圍要一起改。'],
  },

  // ─────────────────────────────────────────────── TCP 與 UDP
  {
    id: 'l69', chapter: 6, title: '只開了 TCP', subtitle: 'TCP 與 UDP 的差別', tags: ['TCP', 'UDP', 'ACL', '封包擷取'],
    brief: '新來的同事替伺服器區寫了一份 ACL，「只放行需要的服務」：DNS 53、TFTP 69、Syslog 514、內部網站 443。上線之後，打網址開不了內部網站（直接打 IP 卻可以），交換器的紀錄和設定備份也送不出去。他很確定埠號都沒寫錯。請找出問題，ACL 還是要維持最小權限。',
    given: [
      ['使用者', '10.10.10.0/24（SW-Floor 的管理位址 10.10.10.2）'], ['DNS 伺服器', '10.10.20.53'], ['內部網站', 'intranet.corp.local = 10.10.20.80（HTTPS）'],
      ['Syslog 伺服器', '10.10.20.14（只收 SW-Floor 的紀錄）'], ['TFTP 伺服器', '10.10.20.69（只給 SW-Floor 備份設定）'], ['ACL', 'R1 的 TO-SERVERS，套在 Gi0/0/2 的出方向'],
    ],
    learn: [
      { t: 'TCP：先建立連線', d: '傳資料之前先三向交握（SYN → SYN-ACK → ACK），每一段資料都要對方確認 (ACK)，掉了就重送，還會依對方的處理速度調整（流量控制）。適合不能出錯的傳輸：網頁、檔案、SSH、資料庫。' },
      { t: 'UDP：送出去就算了', d: '沒有交握、沒有確認、沒有重送，標頭只有 8 個位元組。適合一問一答、或寧可丟掉也不要等的東西：DNS 查詢、DHCP、TFTP、Syslog、SNMP、NTP、語音與視訊 (RTP)。' },
      { t: '埠號是分開的', d: 'TCP 53 和 UDP 53 是兩個不同的埠。ACL 寫 permit tcp … eq 53，UDP 53 的 DNS 查詢一樣會被最後那條隱含的 deny 擋下。DNS 平常用 UDP，回應太大或區域轉送時才改用 TCP。' },
      { t: '用封包擷取看差別', d: '在 PC 的「封包擷取」分頁開始擷取，再分別 nslookup 和開網頁：TCP 會先看到 SYN、SYN-ACK、ACK，UDP 只有一個查詢和一個回應。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', {
          name: 'R1', pos: [0, -5],
          init(d) { ip4(d, 'Gi0/0/1', '10.10.10.1'); ip4(d, 'Gi0/0/2', '10.10.20.1'); },
        }),
        D('c2960', 'sw', {
          name: 'SW-Floor', pos: [-6, -0.5],
          init(d) { d.sw.stp.portfastDefault = true; Object.assign(d.ifaces.find((i) => i.id === 'mgmt'), { ip: '10.10.10.2', mask: '255.255.255.0', gateway: '10.10.10.1' }); },
        }),
        D('sw8', 'srvsw', { name: 'SW-Server', pos: [6, -0.5] }),
        D('pc', 'pc1', { name: 'PC-1', pos: [-9.5, 4], ip: '10.10.10.21', gw: '10.10.10.1', dns: '10.10.20.53' }),
        D('pc', 'pc2', { name: 'PC-2', pos: [-4.5, 4.8], ip: '10.10.10.22', gw: '10.10.10.1', dns: '10.10.20.53' }),
        D('tower', 'dns', { name: 'DNS 伺服器', pos: [2, 4.8], ip: '10.10.20.53', gw: '10.10.20.1', services: [{ proto: 'udp', port: 53, name: 'DNS' }, { proto: 'tcp', port: 53, name: 'DNS（區域轉送）' }, { proto: 'tcp', port: 22, name: 'SSH' }],
          init(d) { d.dnsRecords = { 'intranet.corp.local': '10.10.20.80' }; } }),
        D('tower', 'web', { name: '內部網站', pos: [6, 5.6], ip: '10.10.20.80', gw: '10.10.20.1', services: WEB }),
        D('tower', 'log', { name: 'Syslog 伺服器', pos: [10, 4.8], ip: '10.10.20.14', gw: '10.10.20.1', services: [{ proto: 'udp', port: 514, name: 'Syslog' }] }),
        D('tower', 'tftp', { name: 'TFTP 伺服器', pos: [12.5, 1.5], ip: '10.10.20.69', gw: '10.10.20.1', services: [{ proto: 'udp', port: 69, name: 'TFTP' }] }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['rt:Gi0/0/2', 'srvsw:1'], ['pc1:eth0', 'sw:Gi0/1'], ['pc2:eth0', 'sw:Gi0/2'],
        ['dns:eth0', 'srvsw:2'], ['web:eth0', 'srvsw:3'], ['log:eth0', 'srvsw:4'], ['tftp:eth0', 'srvsw:5']]);
      recompute(s);
      typeIn(s, 'rt', ['configure terminal', 'ip access-list extended TO-SERVERS',
        'permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.80 eq 443', 'permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.53 eq 53',
        'permit tcp host 10.10.10.2 host 10.10.20.69 eq 69', 'permit tcp host 10.10.10.2 host 10.10.20.14 eq 514', 'exit',
        'interface Gi0/0/2', 'ip access-group TO-SERVERS out', 'end', 'write memory']);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc1', name: 'intranet.corp.local', port: 443, label: 'PC-1 用網址打開內部網站（https://intranet.corp.local）' },
      { type: 'tcp', from: 'pc2', name: 'intranet.corp.local', port: 443, label: 'PC-2 也可以' },
      { type: 'udp', from: 'sw', to: 'log', port: 514, label: 'SW-Floor 的紀錄送得到 Syslog 伺服器 (UDP 514)' },
      { type: 'udp', from: 'sw', to: 'tftp', port: 69, label: 'SW-Floor 可以把設定備份到 TFTP 伺服器 (UDP 69)' },
      { type: 'tcp', from: 'pc1', to: 'dns', port: 22, expect: false, label: '使用者不能 SSH 到 DNS 伺服器（ACL 仍然是最小權限）' },
      { type: 'udp', from: 'pc1', to: 'tftp', port: 69, expect: false, label: '使用者不能用 TFTP 碰備份伺服器' },
    ],
    hints: [
      'PC-1 的「封包擷取」開始擷取，再到終端機 nslookup intranet.corp.local：送出去的是 UDP 53，沒有 SYN / SYN-ACK / ACK。R1 的 show access-lists TO-SERVERS：放行的是 TCP 53。',
      'DNS 查詢、TFTP、Syslog 都是 UDP。TCP 53 和 UDP 53 是兩個不同的埠；這些 UDP 的封包被 ACL 最後那條隱含的 deny 擋掉了。',
      'R1：ip access-list extended TO-SERVERS → permit udp 10.10.10.0 0.0.0.255 host 10.10.20.53 eq domain、permit udp host 10.10.10.2 host 10.10.20.69 eq tftp、permit udp host 10.10.10.2 host 10.10.20.14 eq syslog。TCP 53 可以留著（區域轉送、大的回應）。',
    ],
    solve(s) {
      recompute(s);
      typeIn(s, 'rt', ['configure terminal', 'ip access-list extended TO-SERVERS',
        'permit udp 10.10.10.0 0.0.0.255 host 10.10.20.53 eq domain', 'permit udp host 10.10.10.2 host 10.10.20.69 eq tftp', 'permit udp host 10.10.10.2 host 10.10.20.14 eq syslog', 'end', 'write memory']);
    },
    recap: ['TCP 先交握、會確認與重送；UDP 不建立連線，送出去就算了。', '寫 ACL 時，每個服務要先查清楚是 TCP、UDP 還是兩個都用。'],
  },

  // ─────────────────────────────────────────────── DNS 的 TTL 與快取
  {
    id: 'l71', chapter: 10, title: 'DNS 改了，為什麼還連到舊的', subtitle: 'DNS 記錄、TTL 與用戶端快取', tags: ['DNS', 'TTL', 'CNAME', 'ipconfig /flushdns'], noDrill: true,
    brief: '昨晚把公司網站從舊主機 (10.0.2.10) 搬到新主機 (10.0.2.20)，DNS 也在 23:00 改好了，舊主機已經關機。今天早上 PC-C 打得開網站，PC-A 和 PC-B 卻打不開；IT 用 nslookup 查，明明回答的就是新的位址。請讓大家都連得上，並把 DNS 調整好，下次搬家不要再發生。',
    given: [
      ['DNS 伺服器', '10.0.2.53'], ['www.corp.local', 'CNAME → web.corp.local'], ['web.corp.local', '舊 10.0.2.10（已關機）→ 新 10.0.2.20'],
      ['PC-A / PC-B', '昨天下午開過公司網站'], ['公司規定', '網站相關記錄的 TTL 不超過 300 秒'],
    ],
    learn: [
      { t: '常見的 DNS 記錄', d: 'A：名稱 → IPv4 位址；AAAA：→ IPv6；CNAME：別名，指向另一個名稱；MX：這個網域的郵件伺服器；PTR：反查，IP → 名稱。' },
      { t: 'TTL 與快取', d: '每一筆回答都帶著 TTL（秒）。用戶端（和中間的 DNS 伺服器）會把答案記在快取裡，TTL 到之前都直接用快取，不會再問。TTL 是一天，改了記錄之後最久要一天大家才會看到。' },
      { t: 'nslookup 不看快取', d: 'nslookup 自己就是一個 DNS 用戶端，直接問伺服器；ping、瀏覽器用的是作業系統的快取。所以「nslookup 是新的、瀏覽器還是舊的」幾乎都是快取還沒到期。ipconfig /displaydns 看快取、ipconfig /flushdns 清掉。' },
      { t: '搬家之前先調 TTL', d: '預計要換位址的記錄，前一天先把 TTL 調短（例如 300 秒）。等舊的長 TTL 都過期了再切換，大家幾分鐘內就會看到新的位址；穩定之後再調回來。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [0, -5], init(d) { ip4(d, 'Gi0/0/1', '10.0.1.1'); ip4(d, 'Gi0/0/2', '10.0.2.1'); } }),
        D('sw8', 'usw', { name: 'SW-Users', pos: [-6, -0.5] }),
        D('sw8', 'ssw', { name: 'SW-Servers', pos: [6, -0.5] }),
        ...[['pc-a', 'PC-A', -10, 4, 21], ['pc-b', 'PC-B', -6, 4.8, 22], ['pc-c', 'PC-C', -2, 4, 23]].map(([id, name, x, z, n]) => D('pc', id, { name, pos: [x, z], ip: `10.0.1.${n}`, gw: '10.0.1.1', dns: '10.0.2.53' })),
        D('tower', 'dns', {
          name: 'DNS 伺服器', pos: [3, 4.6], ip: '10.0.2.53', gw: '10.0.2.1', services: [{ proto: 'udp', port: 53, name: 'DNS' }, { proto: 'tcp', port: 53, name: 'DNS（區域轉送）' }],
          init(d) {
            d.dnsZone = { records: [
              { name: 'www.corp.local', type: 'CNAME', value: 'web.corp.local', ttl: 86400 },
              { name: 'web.corp.local', type: 'A', value: '10.0.2.20', ttl: 86400 },
              { name: 'mail.corp.local', type: 'A', value: '10.0.2.25', ttl: 3600 },
              { name: 'corp.local', type: 'MX', value: 'mail.corp.local', pref: 10, ttl: 3600 },
              { name: '20.2.0.10.in-addr.arpa', type: 'PTR', value: 'web.corp.local', ttl: 3600 },
            ] };
          },
        }),
        D('tower', 'old', { name: '舊網站主機', pos: [7.5, 5.4], ip: '10.0.2.10', gw: '10.0.2.1', services: WEB }),
        D('tower', 'new', { name: '新網站主機', pos: [11, 3.4], ip: '10.0.2.20', gw: '10.0.2.1', services: WEB }),
      ], [['rt:Gi0/0/1', 'usw:1'], ['rt:Gi0/0/2', 'ssw:1'], ['pc-a:eth0', 'usw:2'], ['pc-b:eth0', 'usw:3'], ['pc-c:eth0', 'usw:4'],
        ['dns:eth0', 'ssw:2'], ['old:eth0', 'ssw:3'], ['new:eth0', 'ssw:4']]);
      s.down = { old: true }; // 舊主機已經關機
      // PC-A、PC-B 昨天下午開過網站：快取裡還是舊的位址，TTL 是一天，還有十幾個小時才到期
      const cached = { 'www.corp.local': { ip: parseIp('10.0.2.10'), exp: 15 * 3600 + 1200, alias: 'www.corp.local', srv: 'dns' } };
      s.dyn = { boot: true, dnsCache: { 'pc-a': { ...cached }, 'pc-b': { 'www.corp.local': { ...cached['www.corp.local'], exp: 13 * 3600 } } } };
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc-a', name: 'www.corp.local', port: 443, label: 'PC-A 打得開 https://www.corp.local' },
      { type: 'tcp', from: 'pc-b', name: 'www.corp.local', port: 443, label: 'PC-B 打得開 https://www.corp.local' },
      { type: 'tcp', from: 'pc-c', name: 'www.corp.local', port: 443, label: 'PC-C 打得開 https://www.corp.local' },
      {
        type: 'check', label: 'www 與 web 的 TTL 都不超過 300 秒',
        test(s) {
          const rs = ((dev(s, 'dns').dnsZone || {}).records || []).filter((r) => ['www.corp.local', 'web.corp.local'].includes(r.name));
          const bad = rs.filter((r) => !(+r.ttl <= 300));
          return !bad.length || `${bad.map((r) => `${r.name} (${r.type}) 的 TTL 是 ${r.ttl} 秒`).join('、')}：超過 300 秒`;
        },
      },
      { type: 'tcp', from: 'pc-c', name: 'www.corp.local', port: 443, via: 'new', label: '大家連到的是新主機' },
    ],
    hints: [
      'PC-A 的終端機：nslookup www.corp.local 回答的是 10.0.2.20（新的），可是 ping www.corp.local 卻是 10.0.2.10。nslookup 直接問伺服器；ping 和瀏覽器用的是本機的 DNS 快取。',
      'ipconfig /displaydns：www.corp.local → 10.0.2.10，存留時間還有十幾個小時（TTL 86400 秒 = 一天）。在 PC-A、PC-B 上 ipconfig /flushdns。',
      'DNS 伺服器 →「DNS」分頁：www（CNAME）和 web（A）的 TTL 都改成 300。下次要搬家，前一天先把 TTL 調短。',
    ],
    solve(s) {
      for (const id of ['pc-a', 'pc-b']) delete s.dyn.dnsCache[id];
      for (const r of dev(s, 'dns').dnsZone.records) if (['www.corp.local', 'web.corp.local'].includes(r.name)) r.ttl = 300;
    },
    recap: ['DNS 的答案會被快取到 TTL 結束；nslookup 不看快取，ping 和瀏覽器會。', '要換位址之前先把 TTL 調短，切換之後幾分鐘就生效。'],
  },
];
