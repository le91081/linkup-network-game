// 「電源」分頁：兩個電源供應器 (PSU) 裝了沒、各接哪一路電
import { h } from './dom.js';
import { toggle, field, note, cardHead, badge, seg } from './form.js';
import { PSU_MODEL, PSU_WATTS, newPsu, psuState, dualFed, FEEDS, upsWh, outageProjection } from '../engine/power.js';
import { CATALOG } from '../engine/model.js';
import { inp, isNum, kv } from './form.js';

export function powerTab(ctx, body) {
  const { dev, state } = ctx;
  body.append(h('p', { class: 'tip', text: '機房的電通常分成 A、B 兩路（不同的 PDU、UPS、電箱）。有兩個電源供應器的設備，兩個要分別接在不同的路：任何一路斷電（跳電、維修）都還有另一路撐著。兩個都插在同一路，看起來有備援，那一路一跳照樣全黑。' }));
  const psu = dev.psu || newPsu();
  const edit = () => (dev.psu ||= newPsu());
  const st = psuState(state, { ...dev, psu });
  const okN = st.filter((x) => x.ok).length;
  body.append(h('div', { class: 'card power' }, cardHead('電源供應器', badge(okN >= 2 && dualFed({ psu }) ? 'on' : okN ? 'warn' : 'off', okN >= 2 && dualFed({ psu }) ? 'A / B 兩路備援' : okN ? '沒有備援' : '沒有電')),
    note('muted', `型號 ${PSU_MODEL[dev.model]}（每個 ${PSU_WATTS[dev.model]} W，一個就夠整台用）`),
    ...psu.map((p, n) => h('div', { class: 'psu-row' },
      h('b', { class: 'mono', text: `PSU ${n + 1}` }),
      toggle(ctx, () => p.on, (v) => { const x = edit()[n]; x.on = v; if (!v) x.feed = ''; }, '已安裝', { rerender: true }),
      p.on && field('電源線接到', seg(ctx, () => p.feed || '', (v) => { edit()[n].feed = v; }, [['A', 'A 路'], ['B', 'B 路'], ['', '沒接']])),
      h('span', { class: 'psu-st ' + (st[n].ok ? 'ok' : 'bad'), text: st[n].ok ? `● ${st[n].why}` : `○ ${st[n].why}` }))),
    okN >= 2 && !dualFed({ psu }) ? note('warn', '兩個電源供應器都接在同一路：那一路斷電，整台還是會關機。') : null,
    okN === 1 ? note('warn', '只有一個電源供應器在供電：這一路斷電（或這個 PSU 壞掉），整台就會關機。') : null),
  feedsCard(ctx));
}

/** A、B 兩路電現在的狀態（市電、UPS 的電池、負載） */
function feedsCard(ctx) {
  const { state } = ctx;
  return h('div', { class: 'card' }, cardHead('A / B 兩路電'), ctx.live(() => FEEDS.map((f) => {
    const x = (state.rt.feeds || {})[f] || { up: true, src: 'utility', load: 0 };
    const u = x.ups && state.devices[x.ups];
    const src = x.src === 'battery' ? `UPS 電池供電，還剩約 ${x.left} 分鐘` : x.up ? (u ? `市電，經過 ${u.name}` : '市電（沒有 UPS）') : x.why;
    const p = state.utility === false ? null : outageProjection(state, CATALOG)[f];
    const proj = !p ? '' : !p.up ? `；如果停電：${p.why}` : p.runtime != null && isFinite(p.runtime) ? `；如果停電：負載 ${p.load} W，約撐 ${p.runtime} 分鐘` : '';
    return note(x.up && (!p || p.up) ? (x.src === 'battery' ? 'warn' : 'ok') : 'warn', `${f} 路：${src} · 負載 ${x.load} W${proj}`);
  })));
}

/** UPS：供應哪一路、外接電池組、負載與可以撐多久；可以模擬市電中斷 */
export function upsTab(ctx, body) {
  const { dev, state } = ctx, spec = CATALOG[dev.model].ups, u = dev.ups;
  body.append(h('p', { class: 'tip', text: 'UPS 平常把市電整理乾淨送給設備，停電時改用電池供電，撐到發電機啟動或設備安全關機。能撐多久看電池的能量和負載：負載越重撐越短；超過額定瓦數就過載，直接停止輸出。' }));
  body.append(h('div', { class: 'card' }, cardHead('輸出', ctx.live(() => { const x = (state.rt.feeds || {})[u.feed]; return !u.feed ? badge('off', '沒有接') : x && !x.up ? badge('off', '停止輸出') : x && x.src === 'battery' ? badge('warn', 'On Battery') : badge('on', 'On Line'); })),
    field('供應哪一路電', seg(ctx, () => u.feed || '', (v) => { u.feed = v; }, [['A', 'A 路'], ['B', 'B 路'], ['', '沒接']])),
    field('外接電池組 (SMX48RMBP2U)', inp(ctx, () => String(u.ext || 0), (v) => { u.ext = +v || 0; }, { ph: '0', check: isNum(0, 10) })),
    h('div', { class: 'kv' }, kv('額定', `${spec.va} VA / ${spec.watts} W`), kv('電池能量', `${upsWh(spec, u)} Wh${+u.ext ? `（內建 ${spec.wh} Wh + ${+u.ext} 組外接）` : ''}`)),
    ctx.live(() => {
      const x = u.feed && (state.rt.feeds || {})[u.feed];
      if (!x) return note('muted', '還沒有接到任何一路：在這裡選 A 或 B，接在那一路的電源供應器就由這台 UPS 供電。');
      const pct = Math.round((x.load / spec.watts) * 100);
      if (!x.up) return note('warn', x.why);
      if (x.src === 'battery') return note('warn', `用電池供電中：負載 ${x.load} W（${pct}%），還剩約 ${x.left} 分鐘`);
      // 平常的負載會低估：另一路沒有 UPS 的話，停電時雙電源設備的負載會全部壓過來
      const p = outageProjection(state, CATALOG)[u.feed];
      return note(p.up && pct <= 80 ? 'ok' : 'warn', `平常負載 ${x.load} W（${pct}%）· 如果停電：${p.up ? `負載 ${p.load} W，約撐 ${isFinite(p.runtime) ? p.runtime : '∞'} 分鐘` : p.why}`);
    })));
  body.append(h('div', { class: 'card' }, cardHead('停電演練', state.utility === false ? badge('warn', '市電中斷中') : badge('on', '市電正常')),
    toggle(ctx, () => state.utility === false, (v) => { if (v) { state.utility = false; state.utilityAt = state.clock; } else { delete state.utility; delete state.utilityAt; } }, '模擬市電中斷（整棟大樓停電）', { rerender: true }),
    note('muted', '市電中斷時，有 UPS 的那一路靠電池撐，沒有 UPS 的那一路馬上斷電。讓時間往前走，看看哪些設備撐到最後。')));
}
