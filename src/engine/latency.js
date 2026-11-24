// 封包的往返時間 (RTT)：ping、traceroute 顯示的毫秒數
//
// 一段一段加起來（單程，再乘以 2）：
//  - 每台設備轉送的時間：交換器幾微秒、路由器數十微秒、防火牆約 0.1 ms；ISP 的網際網路（骨幹到遠方的伺服器）約 4.5 ms
//  - 線路：傳送時間（封包大小 ÷ 速率）＋ 傳遞時間（距離，光在線裡每公尺約 5 奈秒）
//  - 雙工不一致：碰撞與重送，又慢又不穩
//  - Wi-Fi：搶通道與重送，訊號差、干擾多的時候更慢
//  - 排隊：線路越滿，排在前面的封包越多（最多一個 40 封包的佇列）
// 回應 ping 或送出 TTL exceeded 的是設備的 CPU（不是轉送晶片），所以 ping 路由器、交換器本身會多一點時間
import { CATALOG, cableDist, linkInfo } from './model.js';

const PROC = { host: 0.05, hub: 0.002, switch: 0.006, mswitch: 0.006, l3switch: 0.02, router: 0.04, homerouter: 0.25, firewall: 0.09, lb: 0.06, patch: 0, ap: 0.3, wlc: 0.05, hypervisor: 0.01, internet: 4.5, cloud: 0.8 };
/** 由 CPU 回應 ICMP 的時間（主機的作業系統很快；交換器的 CPU 最慢） */
const CPU = { host: 0.02, router: 0.6, l3switch: 1.1, mswitch: 1.4, firewall: 0.4, lb: 0.3, homerouter: 1.2, ap: 1.5, wlc: 0.6, hypervisor: 0.1, internet: 0.3, cloud: 0.3 };

/** Wi-Fi 的這一段：用戶端那一端的連線狀態 */
function assocOf(state, h) {
  for (const id of [h.from, h.to]) {
    const d = state.devices[id];
    for (const i of (d && d.ifaces) || []) if (i.rt && i.rt.assoc && (i.rt.assoc.ap === h.from || i.rt.assoc.ap === h.to)) return i.rt.assoc;
  }
  return null;
}

/** 這一段單程要多久（毫秒）與抖動的程度 */
function hopMs(state, h, bytes) {
  const to = state.devices[h.to];
  let ms = to ? PROC[to.kind] ?? 0.05 : 0.05;
  if (to && to.kind === 'host' && CATALOG[to.model] && CATALOG[to.model].vm) ms = 0.08; // 虛擬機：多經過一層 vSwitch
  if (h.wifi) {
    const a = assocOf(state, h);
    return { ms: ms + 1.6 + (a && a.rssi < -70 ? 4 : 0) + (a && a.noisy ? 3 : 0), jit: a && (a.rssi < -70 || a.noisy) ? 0.6 : 0.35 };
  }
  if (!h.cable) return { ms, jit: h.cloud ? 0.05 : 0 };
  const li = linkInfo(state, h.from, h.fromPort), ok = li && !li.down, speed = ok ? li.speed : 1000;
  const ser = (bytes * 8) / (speed * 1000); // 毫秒
  const c = state.cables.find((x) => x.id === h.cable);
  const prop = c ? (cableDist(state, c) * 5e-6) : 0; // 公尺 × 5 奈秒
  // 排隊：這個方向的線路使用率
  const load = ((state.rt && state.rt.load) || {})[h.cable + '>' + h.to] || 0, u = Math.min(0.99, load / Math.max(1, speed));
  const queue = u > 0.3 ? Math.min(u / (1 - u), 40) * ((1500 * 8) / (speed * 1000)) : 0;
  const dup = ok && li.mismatch ? 3 : ok && li.half ? 0.2 : 0;
  return { ms: ms + ser + prop + queue + dup, jit: dup >= 3 ? 0.8 : u > 0.7 ? 0.4 : 0.05 };
}

/** 去程的每一段（不含 ARP、廣播與回程），累計到每一台設備的單程時間：[{ dev, ms, jit }] */
export function pathTimes(state, res, bytes = 74) {
  const out = [];
  let acc = 0, jit = 0.05;
  for (const h of res.hops || []) {
    if (h.wave || h.reply || h.proto === 'arp' || (!h.cable && !h.wifi && !h.cloud)) continue;
    const x = hopMs(state, h, bytes);
    acc += x.ms; jit = Math.max(jit, x.jit);
    out.push({ dev: h.to, ms: acc, jit });
  }
  return out;
}

const cpuOf = (state, id) => { const d = state.devices[id]; return d ? CPU[d.kind] ?? 0.3 : 0; };
// 固定的抖動序列：同一個拓撲每次 ping 的結果一樣，但幾個封包之間有一點差異
const WOB = [0.06, -0.08, 0.11, -0.03, 0.02, -0.05, 0.09, -0.1];

/** 往返時間的 n 個樣本（毫秒）：給 ping 一行一行印 */
export function rttSamples(state, res, n = 4, bytes = 74, devId = null) {
  const p = pathTimes(state, res, bytes);
  const hit = devId != null ? p.find((x) => x.dev === devId) : null;
  const last = hit || p[p.length - 1] || { dev: devId, ms: 0.02, jit: 0.05 };
  const base = last.ms * 2 + cpuOf(state, last.dev);
  return Array.from({ length: n }, (_, k) => Math.max(0.01, base * (1 + WOB[k % WOB.length] * last.jit * 3)));
}
/** ping 的統計：{ min, avg, max, mdev, list } */
export function pingStats(state, res, n = 4, bytes = 74) {
  const list = rttSamples(state, res, n, bytes);
  const avg = list.reduce((a, b) => a + b, 0) / list.length;
  return { list, min: Math.min(...list), max: Math.max(...list), avg, mdev: Math.sqrt(list.reduce((a, b) => a + (b - avg) ** 2, 0) / list.length) };
}
/**
 * traceroute 在網際網路裡的那幾站（res.isp，見 sim/transact.js）：業者的閘道，加上骨幹裡的路由器。
 * 回傳 [{ ip（null：那一站不回應）, ms: n 個樣本 }]，時間從「業者的閘道」到「目的地」依序增加
 */
export function ispRows(state, res, n = 3, bytes = 74) {
  const isp = res && res.isp;
  if (!isp) return [];
  const end = rttSamples(state, res, n, bytes), list = [isp.edge, ...isp.hops].filter((x, k) => k > 0 || x != null), cnt = list.length;
  const span = Math.min(end[0] * 0.9, 9); // 骨幹來回大約 9 ms，攤在這幾站上
  return list.map((ip, k) => ({ ip, ms: end.map((v, j) => Math.max(0.4, v - span * (1 - (k + 1) / (cnt + 1)) + WOB[(k + j) % WOB.length] * 0.8)) }));
}
/** Linux（iputils）的寫法：100 ms 以上整數、10 ms 以上一位小數、1 ms 以上兩位、不到 1 ms 三位 */
export const linuxMs = (ms) => ms.toFixed(ms >= 100 ? 0 : ms >= 10 ? 1 : ms >= 1 ? 2 : 3);
/** IOS 的寫法：整數毫秒，最少 1 */
export const iosMs = (ms) => Math.max(1, Math.round(ms));
