// 第二層的安全：Port Security（最多幾個 MAC、動態 / sticky / 靜態位址、protect / restrict / shutdown）、
// MAC 位址表的容量與 MAC flooding、靜態 MAC、Storm Control、RA Guard 的設定與判斷
//
// 設定：
//   pc.ps = { on, macs（靜態的安全位址）, max（預設 1）, mode: 'shutdown' | 'restrict' | 'protect', sticky, stickyMacs（sticky 學到的，會寫進 running-config） }
//   d.sw.staticMacs = [{ mac, vlan, port? , drop? }]（mac address-table static … interface … | drop）
//   pc.storm = { bcast（百分比）, action: 'shutdown' | 'trap' | undefined }
//   pc.protected（switchport protected）
//   d.sw.raPolicies = { 名稱: { role: 'host' | 'router' } }、pc.raGuard = 名稱
// 攻擊工具（主機上，玩家不能改）：d.macFlood（macof：每秒送出幾千個來源 MAC 都不一樣的訊框）、d.bcastFlood（Mbps：狂送廣播）、
//   介面上的 i.rogueRa = { prefix: '2001:db8:bad::/64', prio: 'high' }（冒牌路由器送 RA）
//
// 執行期：state.dyn.psec['設備:埠'] = { dyn: [動態學到的安全位址], viol, last, t }、state.dyn.cam[交換器] = { t, by, port, key }（表被塞滿）
import { macList } from './sim/core.js';

/** MAC 位址表的容量（整台交換器共用一張表，不分 VLAN） */
export const CAM_SIZE = { sw5: 2048, sw8: 4096, homerouter: 1024, c2960: 8192, c2960p: 8192, c9300: 32768, n93180: 92160, n9332: 92160 };
export const camSize = (d) => CAM_SIZE[d.model] || 8192;
/** macof 大約的速率：每秒送出這麼多個不同的來源 MAC */
export const MACOF_PPS = 3000;

// ───────────────────────── Port Security ─────────────────────────

export const psMax = (ps) => (ps && +ps.max > 0 ? +ps.max : 1);
/** 違規時的動作：IOS 的預設是 shutdown */
export const psMode = (ps) => (ps && (ps.mode === 'restrict' || ps.mode === 'protect') ? ps.mode : 'shutdown');
/** 設定裡的安全位址：靜態的加上 sticky 學到的 */
export const psConfigured = (ps) => [...new Set([...macList(ps.macs), ...macList(ps.stickyMacs)])];

/**
 * 某個埠的 Port Security：哪些 MAC 是安全位址、哪些是違規的。
 * seen：這個埠後面看得到的 MAC（[{ mac, dev }]，依出現的順序）；flood：後面有人在跑 macof
 * 規則和 IOS 一樣：先放設定裡的（靜態、sticky），還有名額就把看到的 MAC 依序學成安全位址（打開 sticky 的話寫進設定），
 * 超過 maximum 的就是違規
 */
export function psecEval(state, d, pid, seen, flood, now) {
  const pc = d.sw.ports[pid], ps = pc.ps;
  const key = d.id + ':' + pid, max = psMax(ps);
  const rec = ((state.dyn.psec ||= {})[key] ||= { dyn: [], viol: 0, last: null, t: now });
  // 打開 sticky 的那一刻，已經動態學到的安全位址全部轉成 sticky（寫進 running-config）
  if (ps.sticky && rec.dyn.length) { ps.stickyMacs = [...new Set([...macList(ps.stickyMacs), ...rec.dyn])].join(', '); rec.dyn = []; }
  const allowed = new Set(psConfigured(ps));
  // 動態學到的安全位址：連線沒斷就一直保留（設備拔走了也還佔著名額，和真的一樣），超過名額的丟掉
  rec.dyn = rec.dyn.filter((m) => !allowed.has(m));
  for (const m of rec.dyn.slice()) { if (allowed.size < max) allowed.add(m); else rec.dyn.splice(rec.dyn.indexOf(m), 1); }
  const bad = [];
  for (const x of seen) {
    if (allowed.has(x.mac)) continue;
    if (allowed.size < max) {
      allowed.add(x.mac);
      if (ps.sticky) ps.stickyMacs = [...macList(ps.stickyMacs), x.mac].join(', ');
      else rec.dyn.push(x.mac);
    } else bad.push(x);
  }
  // macof 亂造的來源 MAC 一定超過名額（設 maximum 也不會大到裝得下）
  if (flood) bad.push({ mac: flood.mac, dev: flood.dev, flood: true });
  // 違規次數：restrict 每丟一個違規的訊框加一（macof 是每秒幾千個），protect 不計
  const dt = Math.max(0, now - (rec.t ?? now));
  if (bad.length && psMode(ps) === 'restrict') rec.viol += flood ? Math.round(MACOF_PPS * dt) || 1 : (rec.lastSet !== bad.map((b) => b.mac).join() ? bad.length : 0);
  if (bad.length) { rec.last = bad[bad.length - 1].mac; rec.lastSet = bad.map((b) => b.mac).join(); }
  rec.t = now;
  return { allowed, bad, max, mode: psMode(ps), rec };
}
/** 連線斷了：動態學到的安全位址清掉（sticky 與靜態的會留著） */
export function psecForget(state, d, pid) {
  const r = (state.dyn.psec || {})[d.id + ':' + pid];
  if (r) { r.dyn = []; r.lastSet = null; }
}

// ───────────────────────── 靜態 MAC ─────────────────────────

/** mac address-table static：同一個 VLAN 裡的這個 MAC */
export function staticMac(d, vlan, mac) {
  return ((d.sw && d.sw.staticMacs) || []).find((e) => e.mac === mac && +e.vlan === +vlan) || null;
}

// ───────────────────────── MAC 位址表被塞滿（MAC flooding） ─────────────────────────

/** 這台交換器的表是不是被塞滿了（攻擊停了之後，亂造的項目還要等老化時間才會清掉） */
export function camFull(state, d, age) {
  const c = (state.dyn.cam || {})[d.id];
  return c && state.clock - c.t < age ? c : null;
}
/** 顯示用：攻擊工具亂造的 MAC（固定的種子，每次看到的一樣） */
export function bogusMacs(seed, n) {
  const out = [];
  let x = 2166136261;
  for (const ch of String(seed)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  for (let k = 0; k < n; k++) {
    x = Math.imul(x ^ (k + 1), 16777619) >>> 0;
    const y = Math.imul(x ^ 0x9e3779b9, 2654435761) >>> 0;
    const b = [(x >>> 24) & 0xfe, (x >>> 16) & 255, (x >>> 8) & 255, x & 255, (y >>> 8) & 255, y & 255]; // 第一個位元組清掉 multicast 位元
    out.push(b.map((v) => v.toString(16).padStart(2, '0')).join(':'));
  }
  return out;
}

// ───────────────────────── Storm Control ─────────────────────────

/** 這個埠的廣播門檻（Mbps）：storm-control broadcast level 是連接埠速率的百分比 */
export const stormLimit = (pc, speed) => (pc.storm && +pc.storm.bcast >= 0 && pc.storm.bcast !== '' && pc.storm.bcast != null ? (speed * +pc.storm.bcast) / 100 : null);

// ───────────────────────── RA Guard ─────────────────────────

/** 這個埠有沒有 RA Guard 的 host 政策（從這個埠進來的 RA 一律丟掉） */
export function raBlocked(d, pid) {
  const pc = d.sw && d.sw.ports[pid];
  if (!pc || !pc.raGuard) return false;
  const pol = ((d.sw.raPolicies || {})[pc.raGuard]) || (pc.raGuard === true ? { role: 'host' } : null);
  return !!pol && (pol.role || 'host') === 'host';
}
