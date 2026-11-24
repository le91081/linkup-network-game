// 第七章補充：Metro Ethernet 的 E-LAN — 業者不透通 BPDU，客戶自己的備援線路就成了看不見的迴圈；申請 L2PT
import { makeDevice as D, makeState } from '../engine/model.js';
import { dev, WEB } from './util.js';

export const LEVELS88 = [
  {
    id: 'l168', chapter: 7, title: '多拉一條備援，兩邊一起停擺', subtitle: 'E-LAN 與 L2PT（第二層協定透通）', tags: ['Metro Ethernet', 'E-LAN', 'L2PT', 'STP', '迴圈'],
    brief: '總公司和分公司用電信業者的 E-LAN 連在同一個網段裡，兩邊的交換器直接接專線。上個月為了備援，又在兩棟之間拉了一條自己的光纖。光纖接上去的那一刻，兩邊的網路一起停擺；拔掉又恢復。兩邊的交換器都開著 STP。請讓兩條線都接著（一條當備援），而且不會再停擺。',
    given: [
      ['E-LAN', 'EP-LAN（Port-based）· UNI A → 總公司 SW-HQ Gi0/1、UNI B → 分公司 SW-BR Gi0/1'],
      ['備援光纖', 'SW-HQ Gi0/11 ↔ SW-BR Gi0/11'], ['STP', 'SW-HQ 是 Root（優先權 4096）'],
      ['總公司', '伺服器 10.10.0.10'], ['分公司', 'PC 10.10.0.50（同一個網段）'],
    ],
    learn: [
      { t: 'E-LAN', d: '多點的 Metro Ethernet：好幾個據點接在業者的網路上，對客戶來說就像一台很大的交換器，所有據點在同一個廣播網域。點對點的叫 E-Line。' },
      { t: '業者會丟掉客戶的 BPDU', d: '業者的設備預設不轉送客戶的 STP BPDU（還有 CDP、LLDP）：客戶的交換器看不到專線那一邊也接著自己。只要客戶另外有一條路（備援線、另一條專線），就形成 STP 看不見的迴圈，廣播在兩個據點之間繞個不停。' },
      { t: 'L2PT', d: 'Layer 2 Protocol Tunneling：業者把客戶的 BPDU 包起來穿過自己的網路，送到其他據點。開通之後，客戶的 STP 看得到經過專線的路，會把其中一條擋下來當備援。也可以不要用第二層接，改成兩邊用路由器（第三層）接專線。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'hq', { name: 'SW-HQ', pos: [-6, -3], init(d) { Object.assign(d.sw.stp, { prio: 4096, portfastDefault: true }); } }),
        D('c2960', 'br', { name: 'SW-BR', pos: [6, -3], init(d) { d.sw.stp.portfastDefault = true; } }),
        D('metroelan', 'me', {
          name: 'E-LAN（業者）', pos: [0, -8], locked: true,
          init(d) { d.evc = { type: 'EP-LAN', mtu: 1522, l2pt: false }; d.sw.stp.on = false; },
        }),
        D('tower', 'srv', { name: '總公司的伺服器', pos: [-8, 3], ip: '10.10.0.10', services: WEB }),
        D('pc', 'pc', { name: '分公司 PC', pos: [8, 3], ip: '10.10.0.50' }),
      ], [['hq:Gi0/1', 'me:uni-a'], ['br:Gi0/1', 'me:uni-b'], ['hq:Gi0/11', 'br:Gi0/11'], ['srv:eth0', 'hq:Gi0/5'], ['pc:eth0', 'br:Gi0/5']]);
      s.cables.find((c) => c.a.dev === 'hq' && c.a.port === 'Gi0/11').kind = 'mmf';
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'pc', to: 'srv', port: 443, label: '分公司連得到總公司的伺服器（沒有廣播風暴）' },
      {
        type: 'check', label: '專線和備援光纖都接著，STP 把其中一條擋下來當備援',
        test(s) {
          const up = (a, b) => s.rt.cable[s.cables.find((c) => [c.a.dev, c.b.dev].includes(a) && [c.a.dev, c.b.dev].includes(b)).id];
          if (['down', undefined].includes(up('hq', 'me')) || ['down', undefined].includes(up('br', 'me'))) return '專線（E-LAN）沒有接好';
          if (up('hq', 'br') === 'down') return '備援光纖被拔掉或關掉了：要留著當備援';
          const blocked = Object.values(s.devices).some((d) => d.rt && d.rt.stp && d.rt.stp.blocked.size > 0);
          return blocked || 'STP 沒有擋下任何一條：還是有迴圈';
        },
      },
    ],
    hints: [
      'SW-BR：show spanning-tree，Gi0/1（專線）和 Gi0/11（備援光纖）都在轉送：STP 只看到 Gi0/11 這一條路，因為業者的 E-LAN 把 BPDU 丟掉了。',
      '點業者的 E-LAN →「專線資訊」：L2PT 沒有開通。按「申請開通 L2PT」：客戶的 BPDU 穿過業者的網路，STP 就看得到兩條路，把其中一條擋下來。',
    ],
    solve(s) { dev(s, 'me').evc.l2pt = true; },
    recap: ['業者的 Metro Ethernet 預設不轉送客戶的 BPDU：客戶自己另外的路會變成 STP 看不見的迴圈。', '向業者申請 L2PT，或兩邊改用路由器（第三層）接專線。'],
  },
];
