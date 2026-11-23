// 時間型 ACL：time-range（periodic）與 ACL 規則後面的 time-range <名稱>
//
// d.timeRanges = { 名稱: [{ days: [0..6]（0 = 星期日）, from: 分鐘, to: 分鐘, text }] }
// 時間看的是「這台設備以為的時間」：網路設備出廠是 UTC，沒有 clock timezone 的話，台北的中午 12 點在設備上是 04:00
// 每次重算時決定哪些規則「現在不生效」（TR_OFF），並在下一個時間點排一次重算
import { deviceTime } from './ops.js';
import { TR_OFF } from './sim/core.js';
export { parsePeriodic, fmtHm } from './timespec.js';

/** 設備現在的星期與分鐘（依它自己的時鐘與時區） */
function localNow(state, d) {
  const t = deviceTime(state, d), x = new Date(t.ms + t.tz.off * 3600000);
  return { day: x.getUTCDay(), min: x.getUTCHours() * 60 + x.getUTCMinutes(), sec: x.getUTCSeconds() };
}
/** 這個 time-range 現在是不是生效中（不存在的 time-range 一律不生效） */
export function rangeActive(state, d, name) {
  const list = (d.timeRanges || {})[name];
  if (!list || !list.length) return false;
  const n = localNow(state, d);
  return list.some((p) => p.days.includes(n.day) && n.min >= p.from && n.min < p.to);
}
/** 下一次有 time-range 開始或結束，還有幾秒 */
function secsToNext(state, d) {
  const n = localNow(state, d);
  let best = Infinity;
  for (const list of Object.values(d.timeRanges || {})) {
    for (const p of list) {
      for (let k = 0; k < 8; k++) {
        const day = (n.day + k) % 7;
        if (!p.days.includes(day)) continue;
        for (const m of [p.from, p.to]) {
          const s = (k * 1440 + m - n.min) * 60 - n.sec;
          if (s > 0 && s < best) best = s;
        }
      }
    }
  }
  return best;
}

/** 每次重算：哪些 ACL 規則因為 time-range 而暫時不生效；在下一個時間點排一次重算 */
export function prepTimeRanges(state) {
  for (const d of Object.values(state.devices)) {
    const lists = [...(d.ifaces || []).flatMap((i) => [i.aclIn, i.aclOut, i.acl6In, i.acl6Out]), ...Object.values(d.aclDefs || {}), ...(d.vty ? [d.vty.acl] : [])].filter(Array.isArray);
    let any = false;
    for (const l of lists) for (const r of l) if (r && r.tr) { any = true; if (rangeActive(state, d, r.tr)) TR_OFF.delete(r); else TR_OFF.add(r); }
    if (!any && !d.timeRanges) continue;
    const s = secsToNext(state, d);
    if (isFinite(s)) state.rt.pending.push({ at: state.clock + s, dev: d.id, kind: 'time-range', text: `${d.name}：time-range 的時間到了，ACL 的規則跟著生效或失效` });
  }
}

/** show time-range */
export function timeRangeLines(state, d) {
  const all = Object.entries(d.timeRanges || {});
  if (!all.length) return ['（沒有任何 time-range）'];
  const used = new Set(Object.values(d.aclDefs || {}).flat().concat((d.ifaces || []).flatMap((i) => [...(i.aclIn || []), ...(i.aclOut || [])])).filter((r) => r && r.tr).map((r) => r.tr));
  return all.flatMap(([n, l]) => [`time-range entry: ${n} (${rangeActive(state, d, n) ? 'active' : 'inactive'})`, ...l.map((p) => `   periodic ${p.text}`), ...(used.has(n) ? ['   used in: IP ACL entry'] : [])]);
}
