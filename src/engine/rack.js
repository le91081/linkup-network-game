// 機櫃立面圖：每台機架式設備裝在哪一個機櫃的第幾 U（U1 在最下面）。
// 這只是實體的位置，不影響封包；檢查的是放不放得下、重的有沒有放下面、一個機櫃的電力夠不夠。
// state.racks = [{ id: 'A', name: '機櫃 A', u: 42 }]；設備上 d.rack = 'A'、d.u = 最下面那一 U
import { CATALOG } from './model.js';
import { DRAW } from './power.js';

export const RACK_U = 42;
export const PDU_W = 3680; // 一條 16 A / 230 V 的 PDU
/** 機架式設備佔幾 U */
const RU = {
  rack1u: 1, gpusrv: 4, esxi: 1, bigip: 1, ups: 2, isr4321: 1, isr4331: 1, c2960: 1, c2960p: 1, patch24: 1, metroe: 1, metroelan: 1,
  cx6100: 1, ex2300: 1, c9300: 1, fg100f: 1, n93180: 1, n9332: 1, c9800: 1, nvr: 1,
};
/** 桌上型：放在層板上（層板 1U 加上設備本身的高度） */
const SHELF = { fg60f: 2, hex: 2, erx: 2, ont: 2, sw5: 2, sw8: 2, hub4: 2, homerouter: 4, nas: 4 };
/** 沒有電源模組資料的設備，大約的耗電（W） */
const WATTS = {
  isr4321: 40, isr4331: 55, c2960: 20, c2960p: 25, cx6100: 35, ex2300: 40, bigip: 250, metroe: 15, metroelan: 15, patch24: 0,
  nvr: 20, nas: 35, fg60f: 18, hex: 8, erx: 6, ont: 8, sw5: 3, sw8: 5, hub4: 3, homerouter: 15, ups: 0,
};

/** { ru, shelf } 或 null（不能上架：電腦、AP、雲端…） */
export function mountOf(d) {
  if (RU[d.model]) return { ru: RU[d.model], shelf: false };
  if (SHELF[d.model]) return { ru: SHELF[d.model], shelf: true };
  return null;
}
export const rackable = (d) => !!mountOf(d);
export const wattsOf = (d) => DRAW[d.model] ?? WATTS[d.model] ?? 0;
export const rackList = (state) => state.racks || [];
export const rackOf = (state, d) => (d.rack ? rackList(state).find((r) => r.id === d.rack) || null : null);

/** 一個機櫃裡的設備：[{ d, u, ru, top, shelf }]，由上往下 */
export function rackSlots(state, rackId) {
  const out = [];
  for (const d of Object.values(state.devices)) {
    if (d.rack !== rackId) continue;
    const m = mountOf(d);
    if (!m) continue;
    out.push({ d, u: d.u, ru: m.ru, top: d.u + m.ru - 1, shelf: m.shelf });
  }
  return out.sort((a, b) => b.u - a.u);
}
export const unracked = (state) => Object.values(state.devices).filter((d) => rackable(d) && !rackOf(state, d));

/** 能不能把 d 裝在 rackId 的第 u 個 U（最下面那一 U）：可以回傳 ''，不行回傳原因 */
export function canMount(state, d, rackId, u) {
  const m = mountOf(d);
  if (!m) return `${d.name} 不是機架式的設備（放在桌上、牆上或天花板）`;
  const r = rackList(state).find((x) => x.id === rackId);
  if (!r) return '找不到這個機櫃';
  u = +u;
  if (!Number.isInteger(u) || u < 1) return 'U 要從 1 開始（最下面）';
  if (u + m.ru - 1 > r.u) return `${r.name} 只有 ${r.u}U：${d.name} 佔 ${m.ru}U，最高只能從 U${r.u - m.ru + 1} 開始裝`;
  for (const s of rackSlots(state, rackId)) {
    if (s.d.id === d.id) continue;
    if (u <= s.top && u + m.ru - 1 >= s.u) return `U${s.u}${s.ru > 1 ? '–U' + s.top : ''} 已經裝了 ${s.d.name}`;
  }
  return '';
}
export function mount(state, d, rackId, u) {
  const why = canMount(state, d, rackId, u);
  if (why) return why;
  d.rack = rackId; d.u = +u;
  return '';
}
export function unmount(d) { delete d.rack; delete d.u; }

export function addRack(state) {
  const racks = (state.racks ||= []);
  let i = 0;
  while (racks.some((r) => r.id === String.fromCharCode(65 + i))) i++;
  const id = String.fromCharCode(65 + i);
  const r = { id, name: '機櫃 ' + id, u: RACK_U };
  racks.push(r);
  return r;
}
/** 拆掉機櫃：裡面的設備一起下架 */
export function removeRack(state, id) {
  for (const d of Object.values(state.devices)) if (d.rack === id) unmount(d);
  state.racks = rackList(state).filter((r) => r.id !== id);
}

// 自動上架：配線架在最上面、接著交換器、路由器與防火牆、伺服器；UPS 從最下面往上放
const ORDER = (d) => {
  const k = d.kind;
  if (k === 'patch') return 0;
  if (CATALOG[d.model]?.evc) return 1; // 業者的設備（專線的終端）
  if (k === 'mswitch' || k === 'l3switch' || k === 'switch' || k === 'hub') return 2;
  if (k === 'router' || k === 'firewall' || k === 'homerouter' || k === 'lb' || k === 'wlc') return 3;
  if (d.model === 'ups') return 9;
  return 5;
};
function freeFrom(state, d, rackId, fromTop) {
  const r = rackList(state).find((x) => x.id === rackId), m = mountOf(d);
  if (fromTop) { for (let u = r.u - m.ru + 1; u >= 1; u--) if (!canMount(state, d, rackId, u)) return u; }
  else { for (let u = 1; u + m.ru - 1 <= r.u; u++) if (!canMount(state, d, rackId, u)) return u; }
  return 0;
}
/** 把還沒上架的設備都裝進去（放不下就再開一個機櫃）；回傳裝了幾台 */
export function autoRack(state) {
  const todo = unracked(state).sort((a, b) => ORDER(a) - ORDER(b) || a.name.localeCompare(b.name, 'zh-Hant'));
  if (!todo.length) return 0;
  if (!rackList(state).length) addRack(state);
  let n = 0;
  for (const d of todo) {
    const bottom = d.model === 'ups';
    let placed = false;
    for (const r of rackList(state)) {
      const u = freeFrom(state, d, r.id, !bottom);
      if (u) { mount(state, d, r.id, u); placed = true; break; }
    }
    if (!placed) { const r = addRack(state); mount(state, d, r.id, freeFrom(state, d, r.id, !bottom)); }
    n++;
  }
  return n;
}

/** 一個機櫃的耗電（W）與 PDU 的負載 */
export function rackPower(state, rackId) {
  const w = rackSlots(state, rackId).filter((s) => !(state.down || {})[s.d.id]).reduce((t, s) => t + wattsOf(s.d), 0);
  return { w, pct: Math.round((w / PDU_W) * 100) };
}
/** 兩端在不同機櫃的線（要走機櫃上方的線槽） */
export function crossRackCables(state) {
  const at = (id) => state.devices[id] && state.devices[id].rack;
  return state.cables.filter((c) => at(c.a.dev) && at(c.b.dev) && at(c.a.dev) !== at(c.b.dev));
}

/** 檢查：[{ rack, kind: 'bad' | 'warn', text }] */
export function rackIssues(state) {
  const out = [];
  for (const r of rackList(state)) {
    const slots = rackSlots(state, r.id);
    for (const s of slots) {
      if (s.u < 1 || s.top > r.u) out.push({ rack: r.id, kind: 'bad', text: `${s.d.name} 超出了 ${r.name}（U${s.u}–U${s.top}）` });
      const hit = slots.find((x) => x !== s && x.u <= s.top && x.top >= s.u && x.d.id < s.d.id);
      if (hit) out.push({ rack: r.id, kind: 'bad', text: `${s.d.name} 和 ${hit.d.name} 疊在同一個位置` });
      if (s.d.model === 'ups' && s.u > Math.ceil(r.u / 3)) out.push({ rack: r.id, kind: 'warn', text: `${s.d.name} 裝在 U${s.u}：UPS 的電池很重（約 30 公斤），要放在機櫃最下面，不然重心太高，上下架也危險` });
    }
    const p = rackPower(state, r.id);
    if (p.pct >= 80) out.push({ rack: r.id, kind: p.pct >= 100 ? 'bad' : 'warn', text: `${r.name} 用電 ${p.w} W，是 PDU（16 A）的 ${p.pct}%：持續負載不要超過 80%，要再拉一條 PDU 或分到別的機櫃` });
  }
  return out;
}
