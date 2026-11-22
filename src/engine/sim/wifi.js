// Wi-Fi：加密、涵蓋範圍與牆面衰減、無線控制器與輕量型 AP (CAPWAP)、用戶端連線
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { CATALOG } from '../model.js';
import { fmtIp, netOf, parseIp } from '../ip.js';
import { logEvent } from '../ops.js';
import { l2Explore, wifiHop } from './l2.js';
import { transact } from './transact.js';

export const WIFI_SEC = { open: '開放（無加密）', wep: 'WEP', wpa2: 'WPA2-Personal', wpa2wpa3: 'WPA2 / WPA3 混合', wpa3: 'WPA3-Personal', wpa2ent: 'WPA2-Enterprise (802.1X)' };
const SEC_MODES = { open: ['open'], wep: ['wep'], wpa2: ['wpa2'], wpa2wpa3: ['wpa3', 'wpa2'], wpa3: ['wpa3'], wpa2ent: ['wpa2'] };
export const apRange = (d) => ({ low: 6, mid: 9, high: 12 })[(d.wifi && d.wifi.power) || 'mid'];
const distOf = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);

// ── 5 GHz 的頻道寬度與 DFS ──
// 頻道綁在一起變寬（40 / 80 / 160 MHz）速度跟著加倍，但佔掉的頻譜也變多：兩台基地台的「整塊」有重疊就會互相干擾。
// width5 沒設定是「自動」：和 Cisco 的 DBS 一樣，附近有基地台用到同一塊頻譜就自動縮窄（80 → 40 → 20）。
// 52 – 144 是 DFS 頻道：和氣象雷達共用，偵測到雷達就要立刻換頻道（用戶端會斷一下），30 分鐘內不能回來。
export const CH5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
export const DFS = new Set([52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144]);
const BONDS = {
  40: [[36, 40], [44, 48], [52, 56], [60, 64], [100, 104], [108, 112], [116, 120], [124, 128], [132, 136], [140, 144], [149, 153], [157, 161]],
  80: [[36, 40, 44, 48], [52, 56, 60, 64], [100, 104, 108, 112], [116, 120, 124, 128], [132, 136, 140, 144], [149, 153, 157, 161]],
  160: [[36, 40, 44, 48, 52, 56, 60, 64], [100, 104, 108, 112, 116, 120, 124, 128]],
};
/** 某個主頻道在某個寬度下佔用的 20 MHz 頻道（綁不起來就退回較窄的） */
export function blockOf(ch, w) {
  if (!(w > 20)) return [ch];
  const b = (BONDS[w] || []).find((x) => x.includes(ch));
  return b || blockOf(ch, w === 160 ? 80 : w === 80 ? 40 : 20);
}
/** 實際用得到的寬度（例如 165 只能 20 MHz、149 沒有 160 MHz） */
const fitWidth = (ch, w) => (blockOf(ch, w).length * 20);
/** 5 GHz 的速率（2x2，依訊號分三級），單位 Mbps */
const RATE5 = { 20: [173, 117, 58], 40: [400, 270, 135], 80: [866, 585, 292], 160: [1733, 1170, 585] };
// ── 6 GHz (Wi-Fi 6E) ──
// 只有三頻的基地台與支援 6E 的用戶端才用得到；傳得比 5 GHz 更近；規定一定要 WPA3（或 OWE），WPA2 的 SSID 不會在 6 GHz 廣播。
// 頻道用 PSC（每 80 MHz 一個主頻道），這裡固定 160 MHz 寬
export const CH6 = [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229];
const RATE6 = [2402, 1441, 720];
const block6 = (ch) => Math.floor((ch - 1) / 32);
/** 這個 SSID 會不會在 6 GHz 廣播：WPA3 或混合模式（6 GHz 那一邊只用 WPA3） */
export const on6 = (s) => s.sec === 'wpa3' || s.sec === 'wpa2wpa3';
export const has6 = (ap) => !!(CATALOG[ap.model] || {}).band6;

// ── 牆面衰減 ──
// state.walls = [{ id, a: [x, y], b: [x, y], mat }]。每穿過一道牆就少掉一些訊號，5 GHz 穿牆比 2.4 GHz 差
export const WALL_MATS = {
  drywall: { name: '石膏板隔間', db24: 3, db5: 4 },
  glass: { name: '玻璃隔間', db24: 2, db5: 3 },
  wood: { name: '木門', db24: 3, db5: 4 },
  brick: { name: '磚牆', db24: 8, db5: 10 },
  concrete: { name: '混凝土牆', db24: 12, db5: 15 },
  metal: { name: '金屬（電梯、機櫃）', db24: 25, db5: 30 },
};
/** 兩條線段有沒有相交（端點剛好碰到不算） */
function cross(p1, p2, q1, q2) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(q1, q2, p1), d2 = d(q1, q2, p2), d3 = d(p1, p2, q1), d4 = d(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
/** 從 a 到 b 的直線穿過哪些牆、總共衰減多少 dB */
export function wallsBetween(state, a, b) {
  const hit = (state.walls || []).filter((w) => cross(a, b, w.a, w.b));
  const m = (w) => WALL_MATS[w.mat] || WALL_MATS.drywall;
  return { walls: hit, db24: hit.reduce((x, w) => x + m(w).db24, 0), db5: hit.reduce((x, w) => x + m(w).db5, 0) };
}
/**
 * 基地台在某個位置的訊號。距離的部分沿用原本的估算（涵蓋範圍的邊緣大約 -78 dBm），再扣掉牆的衰減。
 * 5 GHz 傳得比較近：-68 dBm 以上才用 5 GHz，不然退回 2.4 GHz；2.4 GHz 也低於 -78 就收不到
 */
export function rfAt(state, ap, pos) {
  const rng = apRange(ap), dist = Math.hypot(ap.pos[0] - pos[0], ap.pos[1] - pos[1]);
  const base = -38 - 40 * (dist / rng);
  const w = wallsBetween(state, ap.pos, pos);
  const r24 = Math.round(base - w.db24), r5 = Math.round(base - w.db5);
  const band = r5 >= -68 ? '5GHz' : r24 >= -78 ? '2.4GHz' : null;
  const r6 = Math.round(base - 4 - w.db5 * 1.2);
  return { dist, rssi24: r24, rssi5: r5, rssi6: r6, band, rssi: band === '5GHz' ? r5 : r24, walls: w.walls, db: band === '5GHz' ? w.db5 : w.db24 };
}
// ── 無線控制器 (WLC) 與輕量型 AP ──
// 輕量型 AP (d.lwap = { mode: 'local' | 'flex', primary, secondary }) 自己沒有 SSID：拿到 IP 之後找 WLC（手動指定、DHCP option 43、
// 同一個網段的廣播），CAPWAP (UDP 5246) 通了之後約 25 秒加入，WLC 才把 WLAN 推給它。
// Local 模式：用戶端的流量包在 CAPWAP 裡回到 WLC，從 WLC 的 Trunk 放進 WLAN 對應的 VLAN；
// FlexConnect：在 AP 自己的交換器埠就地放進 VLAN（AP 的埠要是 Trunk），WLC 斷線時本地交換的 WLAN 照樣服務。
// WLC：d.wlc = { wlans: [{ id, ssid, sec, pass, vlan, on, isolate, kv, ft }] }；無線管理介面是 SVI
export const CAPWAP_JOIN = 25;
/** WLC 上啟用中的 WLAN，換成基地台的 SSID 格式 */
export const wlansOf = (w) => ((w.wlc && w.wlc.wlans) || []).filter((x) => x.on !== false && x.ssid)
  .map((x) => ({ name: x.ssid, sec: x.sec || 'wpa2', pass: x.pass || '', vlan: x.vlan || '', isolate: !!x.isolate, kv: !!x.kv, ft: !!x.ft, wlan: x.id }));
/** 基地台現在放送的 SSID：一般的基地台是自己的設定；輕量型 AP 要加入 WLC 之後才有（FlexConnect 斷線時沿用最後一份） */
export const ssidsOf = (state, ap) => (ap.lwap ? ((ap.rt && ap.rt.capwap && ap.rt.capwap.wlans) || []) : ap.wifi.ssids);
/** 頻道：輕量型 AP 由 WLC 的 RRM 自動指定 */
const chOf = (ap, band) => (band === '2.4GHz' ? +(ap.rt.rrm ? ap.rt.rrm.ch24 : ap.wifi.ch24) || 1 : (ap.rt.dfs && ap.rt.dfs.to) || +(ap.rt.rrm ? ap.rt.rrm.ch5 : ap.wifi.ch5) || 36);
export const apChannel = chOf;
export const apsOf = (state) =>
  Object.values(state.devices).filter((d) => d.wifi && !state.rt.off[d.id] && !(state.down || {})[d.id] && ssidsOf(state, d).some((s) => !s.off && s.name));
/** 反向的路徑（給 WLC 送回 AP 的 CAPWAP 隧道動畫用） */
const backHops = (hops) => hops.slice().reverse().map((h) => ({ ...h, from: h.to, to: h.from, fromPort: h.toPort, toPort: h.fromPort }));
/** 每一輪計算開始時：把上一輪 CAPWAP 的狀態掛到 AP 上，加入同一台 WLC 的 AP 由 RRM 分頻道 */
/** 控制器上的 VLAN：無線管理介面與各 WLAN 用到的 VLAN 自動建立（在每次計算一開始，管理介面才會在第一輪就啟用） */
export function wlcVlans(state) {
  for (const w of Object.values(state.devices)) {
    if (w.kind !== 'wlc') continue;
    for (const v of [w.ifaces[0].bind.vlan, ...w.wlc.wlans.map((x) => +x.vlan).filter((x) => x > 0)]) if (!w.sw.vlans.some((x) => x.id === v)) w.sw.vlans.push({ id: v, name: 'VLAN' + String(v).padStart(4, '0') });
  }
}
function prepCapwap(state, isOn) {
  const dyn = (state.dyn.capwap ||= {});
  const byWlc = {};
  for (const ap of Object.values(state.devices)) {
    if (!ap.lwap) continue;
    const rec = dyn[ap.id] || {}, w = rec.wlc && state.devices[rec.wlc];
    if (rec.joined && w && isOn(w)) {
      ap.rt.capwap = { joined: true, wlc: w.id, mode: ap.lwap.mode || 'local', wlans: wlansOf(w), path: rec.path || [], how: rec.how };
      (byWlc[w.id] ||= []).push(ap);
    } else if ((ap.lwap.mode === 'flex') && rec.cache && rec.cache.length) {
      // FlexConnect 的 standalone 模式：WLC 不在了，本地交換、預先共用金鑰的 WLAN 照樣服務
      ap.rt.capwap = { joined: false, standalone: true, mode: 'flex', wlans: rec.cache.filter((x) => x.sec !== 'wpa2ent'), why: rec.why || '和無線控制器失去聯絡' };
    } else ap.rt.capwap = { joined: false, mode: ap.lwap.mode || 'local', wlans: [], why: rec.why || '還沒有加入無線控制器' };
  }
  // RRM 的動態頻道分配 (DCA)：依序替每台 AP 挑鄰居用得最少的頻道（2.4 GHz 只有 1 / 6 / 11 不重疊）
  for (const list of Object.values(byWlc)) {
    const done = [];
    for (const ap of list.sort((a, b) => a.id.localeCompare(b.id))) {
      const near = done.filter((b) => distOf(ap, b) + wallsBetween(state, ap.pos, b.pos).db24 * (apRange(ap) + apRange(b)) / 80 < apRange(ap) + apRange(b));
      const pick = (chs, k) => chs.map((c) => [c, near.filter((b) => b.rt.rrm[k] === c).length]).sort((a, b) => a[1] - b[1])[0][0];
      ap.rt.rrm = { ch24: pick([1, 6, 11], 'ch24'), ch5: pick([36, 40, 44, 48, 149, 153, 157, 161], 'ch5') };
      done.push(ap);
    }
  }
}

export function prepWifi(state) {
  prepCapwap(state, (d) => !state.rt.off[d.id] && !(state.down || {})[d.id]);
  const rt = state.rt, aps = apsOf(state);
  const assocMem = (state.dyn.assoc ||= {});
  // DFS：偵測到雷達的基地台換到不是 DFS 的頻道，30 分鐘內不回來；剛換的 15 秒內 5 GHz 的用戶端斷線
  const radar = (state.dyn.radar ||= {});
  for (const ap of aps) {
    const r = radar[ap.id];
    if (!r) continue;
    if (r.pending) {
      // 雷達只影響正在用 DFS 頻道的基地台：換到附近沒人用的非 DFS 頻道
      const cur = +(ap.rt.rrm ? ap.rt.rrm.ch5 : ap.wifi.ch5) || 36;
      if (!DFS.has(cur)) { delete radar[ap.id]; continue; }
      const used = new Set(aps.filter((o) => o !== ap).map((o) => +(o.rt.rrm ? o.rt.rrm.ch5 : o.wifi.ch5) || 36));
      r.from = cur; r.to = CH5.find((c) => !DFS.has(c) && c !== 165 && !used.has(c)) || 36;
      delete r.pending;
    }
    // 管理員自己改了頻道：不再沿用雷達之後換過去的頻道
    if (r.from !== (+(ap.rt.rrm ? ap.rt.rrm.ch5 : ap.wifi.ch5) || 36)) { delete radar[ap.id]; continue; }
    if (state.clock >= r.at + 1800) { delete radar[ap.id]; continue; }
    ap.rt.dfs = { from: r.from, to: r.to, at: r.at, hold: state.clock < r.at + 15 };
  }
  // 附近（會互相干擾的距離內）的基地台
  const near = new Map(aps.map((a) => [a.id, []]));
  for (let i = 0; i < aps.length; i++) {
    for (let j = i + 1; j < aps.length; j++) {
      const a = aps[i], b = aps[j];
      const wl = wallsBetween(state, a.pos, b.pos).db24;
      if (distOf(a, b) + wl * (apRange(a) + apRange(b)) / 80 >= apRange(a) + apRange(b)) continue;
      near.get(a.id).push(b); near.get(b.id).push(a);
    }
  }
  // 5 GHz 的實際寬度：固定的照設定（綁不起來就縮窄）；自動的看附近有沒有人用到同一塊
  for (const ap of aps) {
    const ch = chOf(ap, '5GHz'), pref = +ap.wifi.width5 || 0;
    // 自動：避開鄰居佔用的頻譜（固定寬度的鄰居看整塊，自動的鄰居看主頻道）
    const taken = near.get(ap.id).flatMap((o) => { const c = chOf(o, '5GHz'); return +o.wifi.width5 ? blockOf(c, fitWidth(c, +o.wifi.width5)) : [c]; });
    ap.rt.width5 = pref ? fitWidth(ch, pref) : [80, 40, 20].find((w) => !blockOf(ch, fitWidth(ch, w)).some((c) => taken.includes(c))) || 20;
    ap.rt.width5 = fitWidth(ch, ap.rt.width5);
  }
  for (let i = 0; i < aps.length; i++) {
    for (const b of near.get(aps[i].id)) {
      const a = aps[i];
      if (aps.indexOf(b) < i) continue;
      const bands = [];
      if (Math.abs(chOf(a, '2.4GHz') - chOf(b, '2.4GHz')) < 5) bands.push('2.4GHz');
      const A5 = blockOf(chOf(a, '5GHz'), a.rt.width5), B5 = blockOf(chOf(b, '5GHz'), b.rt.width5);
      if (A5.some((c) => B5.includes(c))) bands.push('5GHz');
      if (has6(a) && has6(b) && block6(+a.wifi.ch6 || 37) === block6(+b.wifi.ch6 || 37)) bands.push('6GHz');
      for (const band of bands) { a.rt.interf.push({ dev: b.id, band }); b.rt.interf.push({ dev: a.id, band }); }
    }
  }
  for (const d of Object.values(state.devices)) {
    for (const i of d.ifaces) {
      if (i.bind.t !== 'wlan') continue;
      const w = i.wifi || {};
      if (!w.ssid) { i.rt.note = '尚未選擇無線網路'; continue; }
      const caps = CATALOG[d.model].wifiCaps || ['open', 'wep', 'wpa2', 'wpa3'];
      let best = null, why = `找不到無線網路「${w.ssid}」— 不在任何基地台的訊號範圍內`;
      const cands = [];
      for (const ap of aps) {
        const rf = rfAt(state, ap, d.pos), dist = rf.dist;
        // 剛偵測到雷達、正在換頻道：5 GHz 暫時沒有訊號，訊號夠的用戶端退回 2.4 GHz
        if (rf.band === '5GHz' && ap.rt.dfs && ap.rt.dfs.hold) { rf.band = rf.rssi24 >= -78 ? '2.4GHz' : null; rf.rssi = rf.rssi24; }
        if (!rf.band) continue;
        ssidsOf(state, ap).forEach((s, idx) => {
          if (s.off || s.name !== w.ssid) return;
          if (!SEC_MODES[s.sec || 'open'].some((m) => caps.includes(m))) { why = `${d.name} 不支援 ${WIFI_SEC[s.sec]}，連不上「${s.name}」`; return; }
          if (s.sec === 'wpa2ent') {
            const a = rt.auth.ent[d.id + '/' + i.id];
            if (!a || !a.ok) { why = `「${s.name}」的 802.1X 驗證沒有通過：${(a && a.why) || '等待驗證'}`; return; }
          } else if (s.sec && s.sec !== 'open') {
            if ((s.pass || '').length < 8) { why = `「${s.name}」的密碼少於 8 個字元，基地台無法啟用加密`; return; }
            if ((w.pass || '') !== s.pass) { why = `無線網路「${s.name}」的密碼錯誤`; return; }
          }
          // 6 GHz：基地台與用戶端都支援、SSID 用 WPA3（用戶端也要會 WPA3）、訊號 -65 dBm 以上就優先用
          const six = has6(ap) && (CATALOG[d.model] || {}).band6 && on6(s) && caps.includes('wpa3') && rf.rssi6 >= -65;
          const band = six ? '6GHz' : rf.band, rssi = six ? rf.rssi6 : rf.rssi;
          const cw = ap.rt.capwap, central = !!(cw && cw.joined && cw.mode === 'local');
          const c = { ap: ap.id, idx, dist, key: +s.vlan > 0 ? +s.vlan : central ? 1 : 'u', isolate: !!s.isolate, sec: s.sec || 'open', rssi, band, walls: rf.walls.map((x) => x.mat), wallDb: rf.db, kv: !!s.kv, ft: !!s.ft, ssid: s.name };
          if (central) Object.assign(c, { via: cw.wlc, capwap: cw.path });
          cands.push(c);
          if (!best || rssi > best.rssi) best = c;
        });
      }
      if (!best) { i.rt.note = why; delete assocMem[d.id + '/' + i.id]; continue; }
      // 漫遊：用戶端不會一看到更好的基地台就換（sticky client）— 目前的訊號還有 -75 dBm 以上就繼續用。
      // WLAN 開了 802.11k/v，基地台會提供鄰近基地台的清單、建議用戶端換過去 (BSS Transition)：好 8 dB 以上就換
      const memKey = d.id + '/' + i.id, prev = assocMem[memKey];
      const stay = prev && cands.find((c) => c.ap === prev.ap && c.ssid === best.ssid);
      if (stay && stay !== best && stay.rssi >= -75) {
        if (stay.kv && best.rssi >= stay.rssi + 8) best.roamed = { from: prev.ap, rssi: stay.rssi, why: '802.11v BSS Transition' };
        else { stay.sticky = { ap: best.ap, rssi: best.rssi }; best = stay; }
      } else if (prev && prev.ap !== best.ap) best.roamed = { from: prev.ap, rssi: stay ? stay.rssi : null, why: stay ? '原本的訊號低於 -75 dBm' : '原本的基地台收不到了' };
      assocMem[memKey] = { ap: best.ap };
      // 訊號強度、頻段與速率（依距離與牆的衰減估算）：5GHz 比較快但傳不遠、穿牆也比較差，訊號弱時退回 2.4GHz
      const apd = state.devices[best.ap];

      const noisy = apd.rt.interf.some((x) => x.band === best.band);
      const R5 = RATE5[apd.rt.width5 || 80] || RATE5[80];
      const tier = (R) => (best.rssi > -52 ? R[0] : best.rssi > -62 ? R[1] : R[2]);
      best.rate = Math.round((best.band === '6GHz' ? tier(RATE6) : best.band === '5GHz' ? tier(R5) : best.rssi > -72 ? 144 : 72) * (noisy ? 0.5 : 1));
      best.noisy = noisy;
      best.ch = chOf(apd, best.band);
      if (best.band === '5GHz') best.width = apd.rt.width5 || 80;
      if (best.band === '6GHz') { best.width = 160; best.ch = +apd.wifi.ch6 || 37; }
      i.rt.assoc = best;
      if (best.via) {
        // Local 模式：用戶端掛在 WLC 上（流量經 CAPWAP 回到 WLC 才放進 VLAN）。動畫照實際的隧道路徑走
        best.path = [wifiHop(d.id, best.ap), ...(best.capwap || [])];
        (rt.clients[best.via] ||= []).push({ dev: d.id, iface: i, key: best.key, isolate: best.isolate, ap: best.ap, back: [...backHops(best.capwap || []), wifiHop(best.ap, d.id)] });
      } else (rt.clients[best.ap] ||= []).push({ dev: d.id, iface: i, key: best.key, isolate: best.isolate });
    }
  }
}

/**
 * 輕量型 AP 找 WLC、加入 WLC（在每一輪計算之後跑，因為要用到 IP 與路由）。回傳加入狀態有沒有改變
 */
export function capwapTick(state) {
  const dyn = (state.dyn.capwap ||= {}), now = state.clock, live = new Set();
  let changed = false;
  for (const ap of Object.values(state.devices)) {
    if (!ap.lwap) continue;
    live.add(ap.id);
    const rec = (dyn[ap.id] ||= {});
    const was = !!rec.joined;
    const fail = (why) => {
      if (rec.joined && rec.wlc && state.devices[rec.wlc]) logEvent(state, state.devices[rec.wlc], 5, 'CAPWAPAC_SMGR_TRACE_MESSAGE-5-AP_JOIN_DISJOIN', `AP Name: ${ap.name} Mac: ${ap.ifaces[0].rt.mac || ''} Disjoined`);
      rec.joined = false; rec.wlc = null; rec.since = null; rec.why = why;
    };
    const mi = ap.ifaces[0];
    if (state.rt.off[ap.id] || (state.down || {})[ap.id]) fail(state.rt.off[ap.id] ? 'AP 沒有電（需要 PoE 供電）' : 'AP 關機或開機中');
    else if (mi.rt.ip == null) fail('AP 還沒有拿到 IP 位址' + (mi.rt.note ? '：' + mi.rt.note : '（DHCP）'));
    else {
      // 找 WLC：手動指定的主要控制器 > DHCP option 43 > 同一個網段的廣播 (CAPWAP Discovery)
      const cands = [];
      if (parseIp(ap.lwap.primary || '') != null) cands.push({ ip: parseIp(ap.lwap.primary), how: '手動指定的主要控制器' });
      // N+1：主要控制器不在了，就加入次要控制器；主要的回來之後 AP 會自己切回去 (AP fallback)
      if (parseIp(ap.lwap.secondary || '') != null) cands.push({ ip: parseIp(ap.lwap.secondary), how: '手動指定的次要控制器' });
      for (const ip of mi.rt.wlc || []) cands.push({ ip, how: 'DHCP option 43' });
      for (const e of l2Explore(state, ap.id, mi)) {
        const x = state.devices[e.dev];
        if (x.kind === 'wlc' && e.iface.rt.ip != null && !cands.some((c) => c.ip === e.iface.rt.ip)) cands.push({ ip: e.iface.rt.ip, how: '同一個網段的廣播' });
      }
      let got = null, why = '';
      for (const c of cands) {
        const r = transact(state, ap.id, { proto: 'udp', dst: c.ip, dport: 5246, quiet: true });
        const w = r.ok && state.devices[r.responder];
        if (w && w.kind === 'wlc') { got = { w, how: c.how, hops: r.hops.filter((h) => !h.reply && !h.wave && h.proto !== 'arp') }; break; }
        why = r.ok ? `${fmtIp(c.ip)}（${c.how}）不是無線控制器` : `CAPWAP 封包到不了 ${fmtIp(c.ip)}（${c.how}）：${r.reason}`;
      }
      if (!cands.length) fail(`找不到無線控制器：AP 在 ${fmtIp(netOf(mi.rt.ip, mi.rt.bits))}/${mi.rt.bits}，這個網段上沒有 WLC，DHCP 也沒有提供 option 43`);
      else if (!got) fail(why);
      else {
        if (rec.wlc !== got.w.id) {
          // 原本的控制器突然不在了：AP 要等 heartbeat 逾時（約 30 秒）才發現，再去加入下一台
          const prev = rec.wlc && state.devices[rec.wlc], gone = rec.joined && prev && ((state.down || {})[prev.id] || state.rt.off[prev.id]);
          if (rec.joined) fail(gone ? `${prev.name} 沒有回應（heartbeat 逾時）` : '換到另一台控制器');
          rec.wlc = got.w.id; rec.since = state.dyn.boot ? -1e9 : now + (gone ? 30 : 0);
        }
        rec.how = got.how;
        rec.path = got.hops.map((h) => ({ cable: h.cable, from: h.from, to: h.to, fromPort: h.fromPort, toPort: h.toPort, tag: h.tag ?? null, wifi: !!h.wifi }));
        const ready = rec.since + CAPWAP_JOIN;
        if (!rec.joined && now >= ready) {
          rec.joined = true;
          logEvent(state, got.w, 5, 'CAPWAPAC_SMGR_TRACE_MESSAGE-5-AP_JOIN_DISJOIN', `AP Name: ${ap.name} Mac: ${mi.rt.mac || ''} Session-IP: ${fmtIp(mi.rt.ip)}[5246] ${fmtIp(state.devices[got.w.id].ifaces.find((x) => x.rt.ip != null).rt.ip)}[5246] Joined`);
        }
        if (rec.joined) { rec.why = ''; rec.cache = wlansOf(got.w); }
        else {
          rec.why = `正在加入 ${got.w.name}（${got.how}；CAPWAP Discovery → Join → 下載設定），再 ${Math.ceil(ready - now)} 秒`;
          state.rt.pending.push({ at: ready, dev: ap.id, kind: 'wifi', text: `${ap.name}：正在加入無線控制器 (CAPWAP)` });
        }
      }
    }
    if (was !== !!rec.joined) changed = true;
  }
  for (const k of Object.keys(dyn)) if (!live.has(k)) delete dyn[k];
  return changed;
}

/** 某台設備掃描得到的無線網路清單 */
export function visibleSsids(state, dev) {
  const out = new Map();
  for (const ap of apsOf(state)) {
    const rf = rfAt(state, ap, dev.pos);
    if (!rf.band) continue;
    for (const s of ssidsOf(state, ap)) {
      if (s.off || !s.name) continue;
      const cur = out.get(s.name);
      if (!cur || rf.rssi > cur.rssi) out.set(s.name, { name: s.name, sec: s.sec || 'open', ap: ap.name, dist: rf.dist, rssi: rf.rssi, bars: rf.rssi >= -54 ? 3 : rf.rssi >= -68 ? 2 : 1 });
    }
  }
  return [...out.values()].sort((a, b) => b.rssi - a.rssi);
}
