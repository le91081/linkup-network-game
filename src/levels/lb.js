// 第四章補充：負載平衡器（F5 BIG-IP）— 一臂式架構要開 SNAT Automap、健康檢查要看應用程式的回應（Receive String）
import { makeDevice as D, makeState } from '../engine/model.js';
import { ltmHealth } from '../engine/ltm.js';
import { dev } from './util.js';

const HTTP = [{ proto: 'tcp', port: 80, name: 'HTTP（ERP 網頁）' }];
const VIP = '10.0.20.100';

export const LEVELS72 = [
  {
    id: 'l152', chapter: 4, title: '三台伺服器，有時候會壞掉', subtitle: '負載平衡器：SNAT Automap 與健康檢查', tags: ['負載平衡', 'BIG-IP', 'SNAT', '健康檢查', '非對稱路由'],
    brief: '公司的 ERP 網站從一台伺服器擴充成三台（web-01 到 web-03），前面加了一台 F5 BIG-IP，使用者改連 http://10.0.20.100。負責的同事把 BIG-IP 接在伺服器網段上（一臂式，one-arm），建好 virtual server 和 pool 就去度假了。結果使用者一個都連不上。另外，應用程式團隊說 web-03 昨天更新失敗，ERP 一直回 500 錯誤，修好之前不要讓使用者連到它，但修好之後要自動回來。',
    given: [
      ['使用者', '10.0.10.0/24 · PC 10.0.10.50'], ['伺服器網段', '10.0.20.0/24 · web-01 .11、web-02 .12、web-03 .13（預設閘道 R1 10.0.20.1）'],
      ['BIG-IP', 'self IP 10.0.20.5（埠 1.1）· 預設閘道 10.0.20.1'], ['Virtual server', `vs_erp_http · ${VIP}:80 → pool_erp`],
      ['套件更新伺服器', 'repo 10.0.30.10（HTTPS）· 伺服器要能直接連'],
    ],
    learn: [
      { t: '負載平衡器在做什麼', d: '使用者連的是 virtual server 的位址 (VIP)。負載平衡器收下連線，從 pool 裡挑一台健康的伺服器（成員），把目的位址換成那台的 IP 再送過去（DNAT）。一台壞了，就不再分給它。' },
      { t: '回應一定要回到負載平衡器', d: '只換了目的位址的話，伺服器看到的來源是使用者自己的 IP，會照路由表把回應直接送回去（經過預設閘道 R1）。使用者收到的回應來自 10.0.20.11，不是剛才連的 10.0.20.100，就把它丟掉：非對稱路由。' },
      { t: 'SNAT Automap 與 routed mode', d: '解法一：SNAT Automap，送給伺服器時來源換成 BIG-IP 自己的 self IP，回應自然回到 BIG-IP（一臂式的架構一定要這樣，缺點是伺服器的紀錄看不到使用者的 IP，要看 X-Forwarded-For）。解法二：把伺服器的預設閘道改成 BIG-IP（BIG-IP 擋在伺服器的路上），但伺服器所有的流量都要經過它。' },
      { t: '健康檢查要檢查到應用程式', d: 'tcp monitor 只看埠開不開：網頁伺服器還活著、應用程式卻回 500，它照樣說「健康」。http monitor 會送出 Send String（例如 GET /health），Receive String 填 200 OK，只有回應裡有這幾個字才算活著。內建的 http monitor Receive String 是空的，有任何回應（連 500）都算。' },
      { t: '成員的狀態', d: 'Available（綠）：健康檢查通過。Offline（紅）：健康檢查失敗，不分新的連線，修好之後自動回來。Disabled：維護前先停用，只處理既有的連線。Forced Offline：馬上拿掉。Unknown（藍）：沒有健康檢查，一律當成可用。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'r1', {
          name: 'R1', pos: [-6, -6],
          init(d) {
            for (const [id, ip] of [['Gi0/0/0', '10.0.10.1'], ['Gi0/0/1', '10.0.20.1'], ['Gi0/0/2', '10.0.30.1']]) Object.assign(d.ifaces.find((i) => i.id === id), { ip, mask: '255.255.255.0' });
          },
        }),
        D('sw8', 'swu', { name: 'SW-Users', pos: [-10, -0.5] }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-11, 4.2], ip: '10.0.10.50', gw: '10.0.10.1' }),
        D('tower', 'repo', { name: 'repo（套件更新）', pos: [-1.5, -9.5], ip: '10.0.30.10', gw: '10.0.30.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS（套件庫）' }] }),
        D('sw8', 'sws', { name: 'SW-Servers', pos: [1.5, -1.5] }),
        D('bigip', 'lb', {
          name: 'BIG-IP', pos: [8, -5.5],
          init(d) {
            Object.assign(d.ifaces.find((i) => i.id === '1.1'), { ip: '10.0.20.5', mask: '255.255.255.0', desc: 'servers' });
            d.routes = [{ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.0.20.1', ad: '' }];
            d.ltm = {
              monitors: [],
              pools: [{ name: 'pool_erp', monitor: 'tcp', lb: 'round-robin', members: [11, 12, 13].map((n) => ({ ip: '10.0.20.' + n, port: 80, state: 'enabled' })) }],
              virtuals: [{ name: 'vs_erp_http', dst: VIP, port: 80, pool: 'pool_erp', snat: 'none', persist: 'none' }],
            };
          },
        }),
        ...[1, 2, 3].map((n) => D('tower', 'web' + n, {
          name: 'web-0' + n, pos: [-2.5 + (n - 1) * 4.5, 4.4 + (n === 2 ? 0.6 : 0)], ip: '10.0.20.1' + n, gw: '10.0.20.1', services: HTTP,
          init(d) { d.web = { title: `ERP（web-0${n}）`, ...(n === 3 ? { status: 500 } : {}) }; },
        })),
      ], [['r1:Gi0/0/0', 'swu:1'], ['pc:eth0', 'swu:2'], ['r1:Gi0/0/2', 'repo:eth0'], ['r1:Gi0/0/1', 'sws:1'], ['lb:1.1', 'sws:8'], ['web1:eth0', 'sws:2'], ['web2:eth0', 'sws:3'], ['web3:eth0', 'sws:4']]);
      return s;
    },
    objectives: [
      { type: 'http', from: 'pc', ip: VIP, port: 80, tries: 6, label: `使用者連 http://${VIP}，重新整理 6 次，每次都拿到正常的網頁（HTTP 200）` },
      {
        type: 'check', label: '健康檢查抓得到應用程式壞掉的 web-03（Offline），web-01、web-02 是 Available；web-03 留在 pool 裡',
        test(s) {
          const d = dev(s, 'lb'), p = d.ltm.pools.find((x) => x.name === 'pool_erp');
          if (!p) return '找不到 pool_erp';
          const m3 = (p.members || []).find((m) => m.ip === '10.0.20.13');
          if (!m3) return 'web-03 被刪掉了：留在 pool 裡交給健康檢查，應用程式修好之後才會自動回來';
          if (m3.state && m3.state !== 'enabled') return 'web-03 被手動停用了：應用程式修好之後還要有人記得打開。讓健康檢查來判斷';
          const h = ltmHealth(s, d).pools.pool_erp || [], st = (ip) => (h.find((x) => x.ip === ip) || {}).st;
          if (st('10.0.20.13') !== 'down') return `web-03 的狀態是 ${st('10.0.20.13') || '?'}：健康檢查還沒抓到它的 ERP 回 500（tcp monitor 只看埠開不開）`;
          const bad = ['10.0.20.11', '10.0.20.12'].filter((ip) => st(ip) !== 'up');
          return !bad.length || `${bad.join('、')} 不是 Available：健康檢查把正常的伺服器也判成壞的（Receive String 對嗎？）`;
        },
      },
      { type: 'tcp', from: 'web1', ip: '10.0.30.10', port: 443, label: 'web-01 照樣連得到套件更新伺服器（伺服器的流量不用全部繞經 BIG-IP）' },
      { type: 'failover', down: ['web1'], label: 'web-01 當機：使用者照樣打得開（BIG-IP 自動不再分給它）', test: { type: 'http', from: 'pc', ip: VIP, port: 80, tries: 4 } },
    ],
    hints: [
      `PC 的終端機：curl http://${VIP} 逾時。看封包的路徑：web-01 的回應經過 R1 直接回給 PC，來源是 10.0.20.11 而不是 ${VIP}，PC 不認得就丟掉了（非對稱路由）。`,
      'BIG-IP →「Virtual Servers」→ vs_erp_http 的「來源位址轉換 (SNAT)」改成 Auto Map：送給伺服器時來源換成 self IP 10.0.20.5，回應就會回到 BIG-IP。（把伺服器的預設閘道改成 BIG-IP 也行得通，但伺服器自己要連外的流量會被 BIG-IP 擋掉）',
      `再 curl 幾次：每三次有一次是 HTTP/1.1 500，那是 web-03。「Pools」裡它還是 Available，因為 pool_erp 用的是 tcp monitor，只看 80 埠開不開。`,
      '「Monitors」→ 建立一個 HTTP 類型的 monitor，Receive String 填 200 OK，再到「Pools」把 pool_erp 的健康檢查換成它。web-03 會變成 Offline；不要把它刪掉，修好之後會自動回來。',
    ],
    solve(s) {
      const d = dev(s, 'lb');
      d.ltm.virtuals[0].snat = 'automap';
      d.ltm.monitors.push({ name: 'http_erp', type: 'http', send: 'GET /health HTTP/1.1\\r\\nHost: erp\\r\\n\\r\\n', recv: '200 OK' });
      d.ltm.pools[0].monitor = 'http_erp';
    },
    recap: ['負載平衡器只換目的位址時，伺服器的回應要回得到它：一臂式的架構開 SNAT Automap，或讓伺服器的閘道指向它。', '健康檢查要檢查到應用程式：http monitor 加上 Receive String（200 OK），壞掉的成員自動拿掉、修好自動回來。'],
  },
];
