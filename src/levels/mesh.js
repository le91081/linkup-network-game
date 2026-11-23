// 第五章補充：Wi-Fi mesh — 倉庫拉不到線，基地台用 5 GHz 無線回程接回辦公室；mesh 金鑰、回程訊號與頻道寬度、無線橋接
import { makeDevice as D, makeState, newSsid } from '../engine/model.js';
import { dev } from './util.js';

const KEY = 'Mesh-7Qp2Lx', CORP = { ssid: 'Corp', pass: 'Warehouse#2026' };

export const LEVELS74 = [
  {
    id: 'l154', chapter: 5, title: '倉庫拉不到線', subtitle: 'Wi-Fi mesh：無線回程與無線橋接', tags: ['Wi-Fi', 'Mesh', '無線回程', '無線橋接', 'PoE injector'],
    brief: '倉庫在停車場另一頭，挖地拉線要等下個月。同事先買了一台和辦公室一樣的 UniFi 基地台，用 PoE 電源供應器插在倉庫的插座上，設成 mesh，倉庫的網路印表機也直接接在它的 LAN 埠上。結果倉庫的筆電找不到 Corp，辦公室也印不到倉庫的印表機。請讓倉庫透過無線回程接回辦公室的網路（倉庫的基地台不能搬，也不能拉線）。',
    given: [
      ['AP-辦公室', 'Root（有線上行，接 SW 的 Gi0/1）· 5 GHz 頻道 36、80 MHz'], ['AP-倉庫', 'Mesh（沒有線，PoE 電源供應器供電）· 距離 AP-辦公室約 9 公尺，中間沒有牆'],
      ['mesh 金鑰', `${KEY}（AP-辦公室上的設定）`], ['SSID', `Corp（WPA2，${CORP.pass}）`],
      ['網段', '192.168.1.0/24 · NAS 192.168.1.10（DHCP 也由它發）'], ['倉庫的印表機', '192.168.1.30，接在 AP-倉庫的 LAN 埠'],
    ],
    learn: [
      { t: 'Mesh 是什麼', d: '拉不到線的地方，基地台用無線接回有線的基地台（root）：這條無線的上行叫回程 (backhaul)。mesh 基地台還可以再接一台（多跳），但每多一跳，速度大約再少一半。' },
      { t: '回程要兩個方向都好', d: '回程是兩台基地台互相收送：看的是兩邊互相收到的訊號裡比較弱的那一個，所以只把一台的發射功率調高沒有用。一般建議回程至少 -70 到 -75 dBm；太弱就連不上，或者速率很低。' },
      { t: '頻道寬度與訊號', d: '頻道寬度每減半，雜訊少一半，訊噪比大約多 3 dB：80 MHz 改成 40 MHz，回程可以傳得比較遠，代價是最高速率變低。遠距離的 mesh、點對點的無線橋接常用 40 MHz 甚至 20 MHz。' },
      { t: '無線橋接與供電', d: 'mesh 基地台的 LAN 埠可以接有線的設備（印表機、攝影機、小交換器），它們就像接在 root 後面的網路上：這就是無線橋接。沒有 PoE 交換器的地方，用 PoE 電源供應器 (injector) 從插座供電。' },
      { t: 'mesh 金鑰', d: '同一個 mesh 網路的基地台要有一樣的 mesh 金鑰（UniFi 由控制器統一發，獨立的設備要自己設）。不一樣就互相不認得，mesh 基地台沒有回程，也就不廣播用戶端的 SSID。' },
    ],
    setup() {
      return makeState([
        D('c2960p', 'sw', { name: 'SW（辦公室）', pos: [-9, -3.5], init(d) { d.sw.stp.portfastDefault = true; } }),
        D('nas', 'nas', {
          name: 'NAS', pos: [-12, 2], ip: '192.168.1.10', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }, { proto: 'tcp', port: 5001, name: 'DSM (HTTPS)' }],
          init(d) { d.ifaces[0].dhcp = { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '', gw: '' }; },
        }),
        D('pc', 'pc', { name: '辦公室的電腦', pos: [-7, 3.5], ip: '192.168.1.20' }),
        D('ap', 'ap1', { name: 'AP-辦公室', pos: [-3.5, 0], init(d) { d.wifi.ssids = [newSsid({ name: 'Corp', sec: 'wpa2', pass: CORP.pass })]; d.wifi.ch5 = 36; d.wifi.width5 = 80; d.mesh = { role: 'root', key: KEY }; } }),
        D('ap', 'ap2', { name: 'AP-倉庫', pos: [5.5, 0], init(d) { d.wifi.ssids = [newSsid({ name: 'Corp', sec: 'wpa2', pass: CORP.pass })]; d.wifi.ch5 = 36; d.wifi.width5 = 80; d.mesh = { role: 'mesh', key: 'unifi-mesh' }; d.injector = true; } }),
        D('printer', 'prn', { name: '倉庫的印表機', pos: [8, 3.8], ip: '192.168.1.30', services: [{ proto: 'tcp', port: 9100, name: '列印 (RAW 9100)' }] }),
        D('laptop', 'nb', { name: '倉庫的筆電', pos: [10, 1.5], wifi: CORP }),
      ], [['sw:Gi0/1', 'ap1:eth0'], ['sw:Gi0/2', 'nas:eth0'], ['sw:Gi0/3', 'pc:eth0'], ['prn:eth0', 'ap2:eth0']]);
    },
    objectives: [
      { type: 'dhcp', dev: 'nb', subnet: '192.168.1.0/24', label: '倉庫的筆電連上 Corp，從 NAS 拿到 192.168.1.x' },
      { type: 'tcp', from: 'nb', to: 'nas', port: 445, label: '倉庫的筆電打得開 NAS 的檔案分享' },
      { type: 'tcp', from: 'pc', to: 'prn', port: 9100, label: '辦公室的電腦印得到倉庫的印表機（接在 AP-倉庫的 LAN 埠上：無線橋接）' },
      { type: 'speed', from: 'nb', to: 'nas', port: 445, min: 30, bulk: 'up', label: '倉庫的筆電備份到 NAS 至少 30 Mbps' },
      {
        type: 'check', label: 'AP-倉庫還在倉庫、沒有拉線（只靠無線回程）',
        test(s) {
          const d = dev(s, 'ap2');
          if (d.pos[0] < 5) return 'AP-倉庫被搬離倉庫了';
          if (s.cables.some((c) => (c.a.dev === 'ap2' || c.b.dev === 'ap2') && ![c.a.dev, c.b.dev].includes('prn'))) return 'AP-倉庫多接了一條線：倉庫還拉不到線';
          return (s.rt.meshUp || {}).ap2 ? true : `AP-倉庫的無線回程沒有連上：${(s.rt.meshWhy || {}).ap2 || ''}`;
        },
      },
    ],
    hints: [
      'AP-倉庫 →「無線電」分頁的「Wi-Fi mesh」卡片：mesh 的金鑰和 AP-辦公室不一樣（還是出廠的 unifi-mesh），改成和 AP-辦公室一樣的金鑰。',
      `金鑰對了，回程的訊號只有 -78 dBm（至少要 -75）。兩台都是 80 MHz：把 AP-辦公室的 5 GHz 頻道寬度改成 40 MHz（回程用 root 的頻道），訊噪比多 3 dB 就連得上。（或是把兩台的發射功率都調到「高」：只調一台沒有用，回程看兩個方向裡比較弱的那個）`,
      '連上之後，倉庫的筆電會連 AP-倉庫，印表機接在 AP-倉庫的 LAN 埠上，透過回程接回辦公室的交換器。測速看看：回程和用戶端共用同一個 5 GHz 無線電，速度會比在辦公室慢很多。',
    ],
    solve(s) {
      dev(s, 'ap2').mesh.key = KEY;
      dev(s, 'ap1').wifi.width5 = 40;
    },
    recap: ['拉不到線的地方用 mesh：基地台從 5 GHz 接回有線的 root，LAN 埠還能接有線的設備（無線橋接）。', '回程看兩個方向裡比較弱的訊號；頻道寬度改窄（80 → 40 MHz）訊噪比多 3 dB，傳得比較遠。'],
  },
];
