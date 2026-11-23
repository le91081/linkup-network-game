// Wi-Fi mesh：拉不到網路線的地方，基地台用 5 GHz 的無線回程 (backhaul) 接到有線的基地台
//
// d.mesh = { role: 'root' | 'mesh', key }
//   root：有線上行的基地台 (RAP)；mesh：沒有線、從空中接到 root 或另一台已經連上的 mesh 基地台 (MAP)，可以一台接一台（多跳）
//   key：mesh 的金鑰（同一個網路裡要一樣，不然互相不認得）
// mesh 基地台的 LAN 埠可以接有線的設備：無線橋接 (wireless bridge)，那台設備就像接在 root 後面的交換器上
// d.injector = true：用 PoE 電源供應器 (injector) 供電，不用接 PoE 交換器
//
// 回程要兩個方向都收得到：取兩端互相收到的 5 GHz 訊號比較弱的那一個；頻道寬度越窄，訊噪比越好（每減半大約多 3 dB），傳得比較遠但速率比較低
// 訊號低於 -75 dBm 連不上；mesh 基地台沒有回程時不廣播用戶端的 SSID（連上也出不去）
// 速率：回程和用戶端共用同一個 5 GHz 無線電，每多一跳，可用的空中時間就再少一半
import { rfAt } from './sim/wifi.js';

export const MESH_MIN = -75;
export const meshRole = (d) => (d && d.mesh && d.mesh.role) || null;
const WGAIN = { 20: 6, 40: 3, 80: 0, 160: -3 };
const RATE = { 20: [173, 117, 58], 40: [400, 270, 135], 80: [866, 585, 292], 160: [1733, 1170, 585] };
const tier = (R, rssi) => (rssi > -52 ? R[0] : rssi > -62 ? R[1] : R[2]);

/** 兩台基地台之間的回程：用上游 (parent) 的 5 GHz 頻道寬度。回傳 { rssi（含頻寬的增益）, raw, width, rate } */
export function backhaul(state, parent, child) {
  const raw = Math.min(rfAt(state, parent, child.pos).rssi5, rfAt(state, child, parent.pos).rssi5);
  const width = (parent.rt && parent.rt.width5) || +parent.wifi.width5 || 80, rssi = raw + (WGAIN[width] ?? 0);
  return { rssi, raw, width, rate: tier(RATE[width] || RATE[80], rssi) };
}

/**
 * 算出 mesh 的拓撲：state.rt.meshUp = { 基地台: { parent, hops, rssi, rate, width } }（root 的 parent 是 null）
 * state.rt.meshWhy = { mesh 基地台: 連不上的原因 }；state.rt.meshNb = { 基地台: [相鄰的基地台] }（給第二層的轉送用）
 */
export function prepMesh(state, aps) {
  const rt = state.rt, up = (rt.meshUp = {}), why = (rt.meshWhy = {}), nb = (rt.meshNb = {});
  const alive = (d) => !rt.off[d.id] && !(state.down || {})[d.id];
  for (const d of aps) if (meshRole(d) === 'root' && alive(d) && d.ports.some((p) => rt.links[d.id + ':' + p.id])) up[d.id] = { parent: null, hops: 0 };
  for (const d of aps) if (meshRole(d) === 'root' && !up[d.id]) why[d.id] = '有線上行沒有連線：root 基地台要接著網路線';
  const maps = aps.filter((d) => meshRole(d) === 'mesh' && alive(d));
  // 一輪一輪往外長：每一輪只接到「已經連上」的基地台（多跳）
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const m of maps) {
      if (up[m.id]) continue;
      let best = null, weak = null, keyBad = null;
      for (const [pid, info] of Object.entries(up)) {
        const p = state.devices[pid];
        if (p === m) continue;
        if ((p.mesh.key || '') !== (m.mesh.key || '')) { keyBad = p; continue; }
        const b = backhaul(state, p, m);
        if (b.rssi < MESH_MIN) { if (!weak || b.rssi > weak.rssi) weak = { ...b, p }; continue; }
        if (!best || b.rssi > best.rssi || (b.rssi === best.rssi && info.hops < up[best.p.id].hops)) best = { ...b, p };
      }
      if (best) {
        up[m.id] = { parent: best.p.id, hops: up[best.p.id].hops + 1, rssi: best.rssi, raw: best.raw, rate: best.rate, width: best.width };
        (nb[m.id] ||= []).push(best.p.id); (nb[best.p.id] ||= []).push(m.id);
        delete why[m.id];
        grew = true;
      } else {
        why[m.id] = weak ? `無線回程的訊號太弱：和 ${weak.p.name} 之間只有 ${weak.rssi} dBm（${weak.width} MHz${weak.width < 80 ? `，已經算進窄頻道多出來的 ${weak.rssi - weak.raw} dB` : ''}），至少要 ${MESH_MIN} dBm`
          : keyBad ? `mesh 的金鑰和 ${keyBad.name} 不一樣，互相不認得` : Object.keys(up).length ? '附近沒有可以連的 root 或 mesh 基地台' : '網路裡沒有任何有線上行的 root 基地台';
      }
    }
    if (!grew) break;
  }
}
/** mesh 基地台現在能不能服務用戶端（回程連上了） */
export const meshServes = (state, d) => meshRole(d) !== 'mesh' || !!(state.rt.meshUp || {})[d.id];
/** 回程這一跳的可用頻寬（Mbps）：速率的一半（Wi-Fi 的負擔），同一個無線電要收也要轉送，再打對折 */
export const meshHopMbps = (info) => Math.round(info.rate * 0.5 * 0.5);
