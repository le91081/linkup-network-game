// 「電源」分頁：兩個電源供應器 (PSU) 裝了沒、各接哪一路電
import { h } from './dom.js';
import { toggle, field, note, cardHead, badge, seg } from './form.js';
import { PSU_MODEL, PSU_WATTS, newPsu, psuState, dualFed } from '../engine/power.js';

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
    okN === 1 ? note('warn', '只有一個電源供應器在供電：這一路斷電（或這個 PSU 壞掉），整台就會關機。') : null));
}
