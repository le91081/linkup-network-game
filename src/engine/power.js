// 電力備援：機房的設備有兩個電源供應器 (PSU)，分別接 A、B 兩路電（不同的 PDU / UPS / 電箱）
//
// d.psu = [{ on: 有沒有裝, feed: 'A' | 'B' | '' }]（沒有 d.psu 的設備當作一直有電，和以前一樣）
// state.feeds = { A: false } 代表 A 路斷電（故障演練或關卡劇本）
// 任何一個「有裝、有接、那一路有電」的 PSU 就夠整台運作；全部沒電 → 設備關機（state.rt.off）
// 兩個 PSU 都接在同一路，看起來有備援，那一路一跳照樣全黑
//
// UPS：d.ups = { feed: 'A', ext: 外接電池組的數量 } 這台 UPS 供應 A 路（沒有 UPS 的那一路就是直接接市電）
// state.utility === false 代表市電中斷（state.utilityAt 是開始的時間）：有 UPS 的那一路靠電池撐，沒有 UPS 的那一路馬上斷電
// 電池撐多久：電池的能量 (Wh) × 0.9（換流器的效率）÷ 這一路的負載 (W)。負載是接在這一路的每個電源供應器分到的耗電：
// 兩個 PSU 都有電時各分一半，另一路斷了就全部壓在這一路。負載超過 UPS 的額定瓦數就過載，直接停止輸出

/** 有兩個電源槽的型號與 PSU 的料號 */
export const PSU_MODEL = {
  c9300: 'PWR-C1-715WAC', n93180: 'NXA-PAC-650W-PE', n9332: 'NXA-PAC-1100W-PE', c9800: 'C9800-AC-750W',
  fg100f: 'SP-FG100F-PS', rack1u: 'PSU 800W', esxi: 'PSU 800W',
};
export const PSU_WATTS = { c9300: 715, n93180: 650, n9332: 1100, c9800: 750, fg100f: 150, rack1u: 800, esxi: 800 };
export const hasPsuSlots = (d) => !!PSU_MODEL[d.model];
export const newPsu = () => [{ on: true, feed: 'A' }, { on: false, feed: '' }];
export const FEEDS = ['A', 'B'];
/** 平常的耗電（瓦）：一台設備實際用的電，遠低於電源供應器的額定 */
export const DRAW = { c9300: 150, n93180: 220, n9332: 320, c9800: 120, fg100f: 60, rack1u: 300, esxi: 380 };
const ups = (state, feed) => Object.values(state.devices).find((d) => d.ups && d.ups.feed === feed && !(state.down || {})[d.id]);
/** UPS 的電池能量 (Wh)：型號的內建電池，加上外接的電池組 */
export const upsWh = (spec, u) => spec.wh * (1 + (+u.ext || 0));

/**
 * 每一路電現在的狀態：{ A: { up, src: 'utility' | 'battery' | 'none', ups, load, runtime（分鐘）, left（分鐘）, why } }
 * 先假設每一路都有電算負載，再把電池耗盡、過載的那一路拿掉重算（兩路互相影響：一路沒電，負載都壓到另一路）
 */
export function feedStatus(state, CATALOG) {
  const feeds = state.feeds || {}, out = {};
  const util = state.utility !== false, el = util ? 0 : Math.max(0, (state.clock || 0) - (state.utilityAt ?? state.clock ?? 0));
  // 斷掉的那一路就一直是斷的（記下斷掉的原因與當時的負載）；活著的那幾路再重算負載，直到不再有新的一路斷掉
  const dead = {};
  for (const f of FEEDS) if (feeds[f] === false) dead[f] = { up: false, src: 'none', ups: null, load: 0, runtime: null, left: null, why: `${f} 路斷電（PDU 或電箱跳脫）` };
  if (!util) for (const f of FEEDS) if (!dead[f] && !ups(state, f)) dead[f] = { up: false, src: 'none', ups: null, load: 0, runtime: null, left: null, why: `市電中斷，${f} 路沒有 UPS` };
  for (let k = 0; k < 4; k++) {
    // 每一路的負載：每台設備的耗電平均分給它「還有電的那幾路」
    const load = Object.fromEntries(FEEDS.map((f) => [f, 0]));
    for (const d of Object.values(state.devices)) {
      if (!d.psu || (state.down || {})[d.id]) continue;
      const live = d.psu.filter((p) => p.on && p.feed && !dead[p.feed]);
      for (const p of live) load[p.feed] += (DRAW[d.model] || 100) / live.length;
    }
    let changed = false;
    for (const f of FEEDS) {
      if (dead[f]) { out[f] = dead[f]; continue; }
      const u = ups(state, f), spec = u && CATALOG[u.model].ups;
      const o = (out[f] = { up: true, src: util ? 'utility' : 'battery', ups: u ? u.id : null, load: Math.round(load[f]), runtime: null, left: null, why: '' });
      if (u) o.runtime = load[f] > 0 ? Math.round((upsWh(spec, u.ups) * 0.9 * 60) / load[f] * 10) / 10 : Infinity;
      // 過載：市電正常時由市電供應（UPS 會叫，但不會斷電）；停電切到電池時撐不住，直接停止輸出
      if (u && load[f] > spec.watts && !util) { dead[f] = { ...o, up: false, src: 'none', why: `${u.name} 過載：停電時負載 ${Math.round(load[f])} W，超過額定的 ${spec.watts} W，切到電池就停止輸出` }; changed = true; continue; }
      if (u && load[f] > spec.watts) o.why = `${u.name} 過載（${Math.round(load[f])} W，額定 ${spec.watts} W）：市電一斷就撐不住`;
      if (util) continue;
      o.left = Math.round((o.runtime - el / 60) * 10) / 10;
      if (o.left <= 0) { dead[f] = { ...o, up: false, src: 'none', why: `${u.name} 的電池用完了：負載 ${Math.round(load[f])} W 只撐 ${o.runtime} 分鐘` }; changed = true; }
    }
    if (!changed) break;
  }
  for (const f of FEEDS) if (dead[f]) out[f] = dead[f];
  return out;
}

/** 如果現在停電：每一路會怎樣（給圖形介面預估：平常的負載會低估，因為另一路斷了負載會全部壓過來） */
export const outageProjection = (state, CATALOG) => feedStatus({ ...state, utility: false, utilityAt: state.clock }, CATALOG);

/** 每個 PSU 的狀態：{ ok, why } */
export function psuState(state, d) {
  const feeds = state.feeds || {};
  return (d.psu || []).map((p) => {
    if (!p.on) return { ok: false, present: false, why: '沒有安裝 (Not Present)' };
    if (!p.feed) return { ok: false, present: true, why: '有裝，但電源線沒有接' };
    const fs = (state.rt && state.rt.feeds) || null;
    if (fs && fs[p.feed] && !fs[p.feed].up) return { ok: false, present: true, why: fs[p.feed].why || `${p.feed} 路斷電` };
    if (feeds[p.feed] === false) return { ok: false, present: true, why: `${p.feed} 路斷電` };
    if (fs && fs[p.feed] && fs[p.feed].src === 'battery') return { ok: true, present: true, why: `接在 ${p.feed} 路（UPS 電池供電，還剩約 ${fs[p.feed].left} 分鐘）` };
    return { ok: true, present: true, why: `接在 ${p.feed} 路` };
  });
}

/** 在實體層之前呼叫：PSU 全部沒電的設備當作關機 */
export function prepPower(state, CATALOG) {
  state.rt.feeds = feedStatus(state, CATALOG);
  // 市電中斷：UPS 的電池用完的時間點（讓時間往前走時會重新計算）
  for (const [f, x] of Object.entries(state.rt.feeds)) if (x.src === 'battery' && x.left > 0) state.rt.pending.push({ at: (state.clock || 0) + x.left * 60, dev: x.ups, kind: 'power', text: `${f} 路的 UPS 電池即將耗盡` });
  for (const d of Object.values(state.devices)) {
    if (!d.psu || !d.psu.length) continue;
    const st = psuState(state, d);
    d.rt.psu = st;
    if (st.some((x) => x.ok)) continue;
    state.rt.off[d.id] = true;
    const on = (d.psu || []).filter((p) => p.on && p.feed).map((p) => p.feed);
    const fw = [...new Set(on)].map((f) => (state.rt.feeds[f] && state.rt.feeds[f].why) || `${f} 路斷電`);
    (state.rt.offWhy ||= {})[d.id] = `${d.name} 沒有電：${on.length ? `它的電源供應器都接在 ${[...new Set(on)].join('、')} 路，${fw.length > 1 ? '兩路都' : '這一路'}斷電了（${fw.join('；')}）` : '沒有任何接上電的電源供應器'}`;
  }
}

/** 只剩一個 PSU 在供電（沒有備援）：給圖形介面與 show 指令提醒用 */
export const singlePower = (state, d) => !!d.psu && psuState(state, d).filter((x) => x.ok).length === 1;
/** 兩個 PSU 是不是接在不同的兩路 */
export const dualFed = (d) => !!d.psu && new Set(d.psu.filter((p) => p.on && p.feed).map((p) => p.feed)).size >= 2;

/** show environment power（Catalyst 9300 與 Nexus 的格式不同） */
export function envPowerLines(state, d) {
  if (!d.psu) return ['（這台沒有可以更換的電源供應器資訊）'];
  const st = psuState(state, d), pid = PSU_MODEL[d.model], w = PSU_WATTS[d.model];
  if (/^n9/.test(d.model)) {
    return ['Power Supply:', 'Voltage: 12 Volts', 'Power                              Actual        Actual        Total',
      'Supply    Model                    Output     Input    Capacity    Status', '                                   (Watts )     (Watts )     (Watts )',
      '-------  -------------------  -----------  -----------  -----------  --------------',
      ...st.map((x, n) => `${String(n + 1).padEnd(9)}${(x.present ? pid : '------------').padEnd(21)}${(x.ok ? '154 W' : '0 W').padStart(11)}  ${(x.ok ? '167 W' : '0 W').padStart(11)}  ${(x.present ? `${w} W` : '0 W').padStart(11)}     ${x.ok ? 'Ok' : x.present ? 'Shutdown' : 'Absent'}`),
      '', `Power Supply redundancy mode (configured)                PS-Redundant`, `Power Supply redundancy mode (operational)               ${st.filter((x) => x.ok).length >= 2 ? 'PS-Redundant' : 'Non-Redundant'}`];
  }
  return ['SW  PID                 Serial#     Status           Sys Pwr  PoE Pwr  Watts', '--  ------------------  ----------  ---------------  -------  -------  -----',
    ...st.map((x, n) => (x.present ? `1${'AB'[n]}  ${pid.padEnd(18)}  DCB2140G1L${n}  ${(x.ok ? 'OK' : 'No Input Power').padEnd(15)}  ${(x.ok ? 'Good' : 'Bad').padEnd(7)}  ${(x.ok ? 'Good' : 'Bad').padEnd(7)}  ${w}` : `1${'AB'[n]}  Not Present`)),
    '', `（${st.filter((x) => x.ok).length >= 2 ? '兩個電源都正常：任何一路斷電都撐得住' : '只剩一個電源供應器在供電：沒有備援'}）`];
}
