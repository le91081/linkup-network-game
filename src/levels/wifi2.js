// 第五章補充：頻道寬度與 DFS — 三台 AP 都開 80 MHz 互相干擾，會議室那台用 DFS 頻道，雷達一來就斷線
import { makeDevice as D, makeState, newSsid } from '../engine/model.js';
import { DFS } from '../engine/sim.js';
import { dev } from './util.js';

const SSID = () => [newSsid({ name: 'Office', sec: 'wpa2wpa3', pass: 'Office#Wifi2026' })];
const WIFI = { ssid: 'Office', pass: 'Office#Wifi2026' };
const APS = ['apA', 'apB', 'apC'];

export const LEVELS32 = [
  {
    id: 'l104', chapter: 5, title: '下午的視訊會議一直斷', subtitle: '5 GHz 的頻道寬度、重疊與 DFS', tags: ['Wi-Fi', '頻道寬度', '80 MHz', 'DFS', '干擾'],
    brief: '辦公室三台 AP 是廠商「調到最快」交機的：5 GHz 全部開 80 MHz。大家都說 Wi-Fi 很慢，會議室的視訊會議下午還會斷線好幾次（附近機場的氣象雷達）。請讓三個區域的筆電在 5 GHz 都至少有 250 Mbps 的連線速率、互不干擾，而且不要再被雷達打斷。',
    given: [
      ['AP-辦公區', '5 GHz 頻道 36 · 80 MHz'], ['AP-業務區', '5 GHz 頻道 44 · 80 MHz'], ['AP-會議室', '5 GHz 頻道 100（DFS）· 80 MHz'],
      ['2.4 GHz', '已經分別用 1、6、11'], ['視訊需求', '5 GHz 連線速率 250 Mbps 以上'],
    ],
    learn: [
      { t: '頻道寬度', d: '5 GHz 的頻道每個 20 MHz，可以兩個、四個、八個綁在一起變成 40 / 80 / 160 MHz，速度大約跟著加倍。代價是佔掉的頻譜也加倍：頻道 36 開 80 MHz 會用掉 36、40、44、48 整塊，旁邊的 AP 用 44 就和它撞在一起。' },
      { t: '可以用的頻譜有限', d: '不是 DFS 的 5 GHz 只有 36 – 48 和 149 – 161，各 80 MHz。AP 一多，80 MHz 根本排不開，企業網路通常用 20 或 40 MHz，讓每台都有自己的頻道。自動模式會在附近有人用到同一塊時縮窄。' },
      { t: 'DFS', d: '52 – 144 是 DFS 頻道，和氣象、航空雷達共用：基地台偵測到雷達就必須立刻換頻道，30 分鐘內不能回來。換頻道的那幾秒用戶端會斷線，視訊、語音最容易受影響。機場、港口附近要避開 DFS。' },
    ],
    setup() {
      const ap = (id, name, pos, ch24, ch5) => D('ap', id, { name, pos, init(d) { d.wifi.ssids = SSID(); Object.assign(d.wifi, { ch24, ch5, width5: 80 }); } });
      const s = makeState([
        D('erx', 'rt', {
          name: 'Router', pos: [-9, -6],
          init(d) {
            Object.assign(d.ifaces[1], { ip: '192.168.20.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.20.100', end: '192.168.20.199', dns: '192.168.20.1' });
          },
        }),
        D('c2960p', 'sw', { name: 'PoE Switch', pos: [0, -5] }),
        D('nas', 'fs', { name: '檔案伺服器', pos: [9, -6], ip: '192.168.20.10', gw: '192.168.20.1', services: [{ proto: 'tcp', port: 445, name: 'SMB' }] }),
        ap('apA', 'AP-辦公區', [-7, 1], 1, 36), ap('apB', 'AP-業務區', [0, 2], 6, 44), ap('apC', 'AP-會議室', [7, 1], 11, 100),
        D('laptop', 'nbA', { name: '辦公區的筆電', pos: [-8, 5], wifi: WIFI }),
        D('laptop', 'nbB', { name: '業務區的筆電', pos: [0, 6], wifi: WIFI }),
        D('laptop', 'nbC', { name: '會議室的筆電', pos: [8, 5], wifi: WIFI }),
      ], [['rt:eth1', 'sw:Gi0/9'], ['fs:eth0', 'sw:Gi0/10'], ['apA:eth0', 'sw:Gi0/1'], ['apB:eth0', 'sw:Gi0/2'], ['apC:eth0', 'sw:Gi0/3']]);
      // 劇本：下午附近機場的氣象雷達掃過來好幾次
      s.script = [150, 450, 750, 1050].map((at) => ({ at, text: '📡 附近機場的氣象雷達掃過來了：用 DFS 頻道（52 – 144）的基地台要立刻換頻道', radar: ['apC'] }));
      return s;
    },
    objectives: [
      {
        type: 'check', label: '5 GHz 沒有任何兩台 AP 互相干擾',
        test(s) {
          for (const id of APS) {
            const x = (dev(s, id).rt.interf || []).find((i) => i.band === '5GHz');
            if (x) return `${dev(s, id).name} 和 ${dev(s, x.dev).name} 在 5 GHz 用到同一塊頻譜（實際寬度 ${dev(s, id).rt.width5} MHz）`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '三台 AP 都不用 DFS 頻道（不會被雷達打斷）',
        test(s) {
          for (const id of APS) { const d = dev(s, id); if (DFS.has(+d.wifi.ch5)) return `${d.name} 用的是 DFS 頻道 ${d.wifi.ch5}：雷達一來就要換頻道，用戶端會斷線`; }
          return true;
        },
      },
      ...[['nbA', '辦公區'], ['nbB', '業務區'], ['nbC', '會議室']].map(([id, where]) => ({
        type: 'check', label: `${where}的筆電在 5 GHz 至少有 250 Mbps，頻道沒有干擾`,
        test(s) {
          const a = dev(s, id).ifaces.map((i) => i.rt.assoc).find(Boolean);
          if (!a) return `${dev(s, id).name} 沒有連上 Wi-Fi`;
          if (a.band !== '5GHz') return `${dev(s, id).name} 連在 2.4 GHz`;
          if (a.noisy) return `${dev(s, id).name} 的頻道和別的 AP 重疊（${a.width} MHz），一起分時間用，連線速率只剩 ${a.rate} Mbps`;
          return a.rate >= 250 ? true : `${dev(s, id).name} 的連線速率只有 ${a.rate} Mbps（${a.width} MHz）`;
        },
      })),
    ],
    hints: [
      '三台 AP 的「無線電」：都開 80 MHz。頻道 36 的 80 MHz 是 36 – 48 整塊，業務區用 44 就撞在一起；會議室的 100 是 DFS 頻道，雷達一來換到別的頻道，又撞上另外兩台。',
      '不是 DFS 的 5 GHz 只有 36 – 48、149 – 161 兩塊 80 MHz，三台擠不下。改成 40 MHz：36、44、149；或者一台用 80 MHz 的 149，另外兩台用 40 MHz 的 36 與 44。',
      '20 MHz 雖然不會撞，但連線速率只剩一百多 Mbps，不夠視訊會議用。',
    ],
    solve(s) {
      Object.assign(dev(s, 'apA').wifi, { ch5: 36, width5: 40 });
      Object.assign(dev(s, 'apB').wifi, { ch5: 44, width5: 40 });
      Object.assign(dev(s, 'apC').wifi, { ch5: 149, width5: 80 });
    },
    recap: ['頻道越寬越快，但也越容易和別人重疊；AP 多的地方用 20 / 40 MHz，讓每台都有自己的一塊。', 'DFS 頻道遇到雷達就得換，機場、港口附近或要求穩定的會議室，選非 DFS 的頻道。'],
  },
  {
    id: 'l105', chapter: 5, title: '新筆電明明支援 Wi-Fi 6E', subtitle: '6 GHz 一定要 WPA3：混合模式讓舊設備也連得上', tags: ['Wi-Fi 6E', '6 GHz', 'WPA3', 'WPA2', '相容性'],
    brief: '設計部換了支援 6 GHz 的三頻 AP，也買了支援 Wi-Fi 6E 的新筆電，要直接從 NAS 開大型的設計檔。可是新筆電一直連在 5 GHz，速度和舊筆電差不多。Studio 這個 SSID 用的是 WPA2，因為角落那台無線印表機只支援 WPA2。請讓新筆電用上 6 GHz，舊筆電和印表機也都要連得上。',
    given: [
      ['AP-設計部', 'Ubiquiti U6 Enterprise（2.4 / 5 / 6 GHz 三頻）· SSID Studio（WPA2-Personal）'], ['新筆電', 'Wi-Fi 6E（支援 6 GHz 與 WPA3）'],
      ['舊筆電', 'Wi-Fi 6（支援 WPA3）'], ['無線印表機', '只支援 WPA2'],
    ],
    learn: [
      { t: '6 GHz (Wi-Fi 6E)', d: '6 GHz 是新開放的頻段，頻寬多、沒有舊設備干擾，可以放心開 160 MHz。代價是傳得比 5 GHz 更近，而且只有支援 6E 的 AP 與用戶端用得到。' },
      { t: '6 GHz 規定要 WPA3', d: 'Wi-Fi 聯盟規定 6 GHz 不能用 WPA2 或開放網路：一定要 WPA3（開放網路要用 OWE）。WPA2 的 SSID 在三頻 AP 上只會出現在 2.4 / 5 GHz，6E 的筆電當然只能連 5 GHz。' },
      { t: 'WPA2 / WPA3 混合模式', d: '混合模式 (transition mode) 在 2.4 / 5 GHz 同時接受 WPA2 與 WPA3，舊設備照樣用 WPA2 連；在 6 GHz 那一邊只用 WPA3。這是設備還沒全部換新之前的折衷做法。' },
    ],
    setup() {
      const s = makeState([
        D('erx', 'rt', {
          name: 'Router', pos: [-9, -6],
          init(d) {
            Object.assign(d.ifaces[1], { ip: '192.168.30.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.30.100', end: '192.168.30.199', dns: '192.168.30.1' });
          },
        }),
        D('c2960p', 'sw', { name: 'PoE Switch', pos: [0, -5] }),
        D('nas', 'nas', { name: '設計檔 NAS', pos: [9, -6], ip: '192.168.30.10', gw: '192.168.30.1', services: [{ proto: 'tcp', port: 445, name: 'SMB' }] }),
        D('ap6e', 'ap', { name: 'AP-設計部', pos: [0, 1], init(d) { d.wifi.ssids = [newSsid({ name: 'Studio', sec: 'wpa2', pass: 'Studio#2026' })]; } }),
        D('laptop6e', 'nbNew', { name: '新筆電（6E）', pos: [-2.5, 3.5], wifi: { ssid: 'Studio', pass: 'Studio#2026' } }),
        D('laptop', 'nbOld', { name: '舊筆電', pos: [3, 4], wifi: { ssid: 'Studio', pass: 'Studio#2026' } }),
        D('wprinter', 'prn', { name: '無線印表機', pos: [6, 0.5], wifi: { ssid: 'Studio', pass: 'Studio#2026' } }),
      ], [['rt:eth1', 'sw:Gi0/9'], ['nas:eth0', 'sw:Gi0/10'], ['ap:eth0', 'sw:Gi0/1']]);
      return s;
    },
    objectives: [
      {
        type: 'check', label: '新筆電連在 6 GHz，連線速率至少 1000 Mbps',
        test(s) {
          const a = dev(s, 'nbNew').ifaces.map((i) => i.rt.assoc).find(Boolean);
          if (!a) return '新筆電沒有連上 Wi-Fi';
          if (a.band !== '6GHz') return `新筆電連在 ${a.band}：Studio 用 ${a.sec === 'wpa2' ? 'WPA2，6 GHz 不會廣播它' : a.sec}`;
          return a.rate >= 1000 ? true : `新筆電在 6 GHz 只有 ${a.rate} Mbps`;
        },
      },
      ...[['nbOld', '舊筆電'], ['prn', '無線印表機（只支援 WPA2）']].map(([id, who]) => ({
        type: 'check', label: `${who}也連得上`,
        test(s) {
          const i = dev(s, id).ifaces.find((x) => x.bind.t === 'wlan');
          return (i && i.rt.assoc) ? true : `${dev(s, id).name} 連不上：${(i && i.rt.note) || '沒有無線網路卡'}`;
        },
      })),
      { type: 'tcp', from: 'nbNew', to: 'nas', port: 445, label: '新筆電打得開 NAS 上的設計檔' },
      {
        type: 'check', label: 'Studio 仍然有加密（不能改成開放網路）',
        test: (s) => { const x = dev(s, 'ap').wifi.ssids.find((y) => y.name === 'Studio'); return !x ? '找不到 Studio 這個 SSID' : x.sec && x.sec !== 'open' ? true : 'Studio 變成開放網路了'; },
      },
    ],
    hints: [
      'AP-設計部的「無線網路」：Studio 用 WPA2，卡片上寫著它不會在 6 GHz 廣播。6 GHz 規定一定要 WPA3。',
      '改成純 WPA3 的話，新筆電會上 6 GHz，可是只支援 WPA2 的印表機就連不上了。',
      '加密方式選「WPA2 / WPA3 混合」：2.4 / 5 GHz 同時接受 WPA2 與 WPA3（印表機照樣連），6 GHz 那一邊用 WPA3。',
    ],
    solve(s) { dev(s, 'ap').wifi.ssids[0].sec = 'wpa2wpa3'; },
    recap: ['6 GHz 只接受 WPA3；WPA2 的 SSID 不會出現在 6 GHz。', '設備還沒全部支援 WPA3 之前，用 WPA2 / WPA3 混合模式：舊設備走 WPA2，6E 的設備在 6 GHz 走 WPA3。'],
  },
];
