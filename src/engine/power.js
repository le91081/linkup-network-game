// 電力備援：機房的設備有兩個電源供應器 (PSU)，分別接 A、B 兩路電（不同的 PDU / UPS / 電箱）
//
// d.psu = [{ on: 有沒有裝, feed: 'A' | 'B' | '' }]（沒有 d.psu 的設備當作一直有電，和以前一樣）
// state.feeds = { A: false } 代表 A 路斷電（故障演練或關卡劇本）
// 任何一個「有裝、有接、那一路有電」的 PSU 就夠整台運作；全部沒電 → 設備關機（state.rt.off）
// 兩個 PSU 都接在同一路，看起來有備援，那一路一跳照樣全黑

/** 有兩個電源槽的型號與 PSU 的料號 */
export const PSU_MODEL = {
  c9300: 'PWR-C1-715WAC', n93180: 'NXA-PAC-650W-PE', n9332: 'NXA-PAC-1100W-PE', c9800: 'C9800-AC-750W',
  fg100f: 'SP-FG100F-PS', rack1u: 'PSU 800W', esxi: 'PSU 800W',
};
export const PSU_WATTS = { c9300: 715, n93180: 650, n9332: 1100, c9800: 750, fg100f: 150, rack1u: 800, esxi: 800 };
export const hasPsuSlots = (d) => !!PSU_MODEL[d.model];
export const newPsu = () => [{ on: true, feed: 'A' }, { on: false, feed: '' }];
export const FEEDS = ['A', 'B'];

/** 每個 PSU 的狀態：{ ok, why } */
export function psuState(state, d) {
  const feeds = state.feeds || {};
  return (d.psu || []).map((p) => {
    if (!p.on) return { ok: false, present: false, why: '沒有安裝 (Not Present)' };
    if (!p.feed) return { ok: false, present: true, why: '有裝，但電源線沒有接' };
    if (feeds[p.feed] === false) return { ok: false, present: true, why: `${p.feed} 路斷電` };
    return { ok: true, present: true, why: `接在 ${p.feed} 路` };
  });
}

/** 在實體層之前呼叫：PSU 全部沒電的設備當作關機 */
export function prepPower(state) {
  for (const d of Object.values(state.devices)) {
    if (!d.psu || !d.psu.length) continue;
    const st = psuState(state, d);
    d.rt.psu = st;
    if (st.some((x) => x.ok)) continue;
    state.rt.off[d.id] = true;
    const on = (d.psu || []).filter((p) => p.on && p.feed).map((p) => p.feed);
    (state.rt.offWhy ||= {})[d.id] = `${d.name} 沒有電：${on.length ? `它的電源供應器都接在 ${[...new Set(on)].join('、')} 路，這一路斷電了` : '沒有任何接上電的電源供應器'}`;
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
