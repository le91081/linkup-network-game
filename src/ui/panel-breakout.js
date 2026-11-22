// Nexus 的 QSFP 埠拆成 4 個 25G / 10G（breakout）
import { h, toast } from './dom.js';
import { sel, field, note, cardHead, badge } from './form.js';
import { breakoutPort, unbreakoutPort, BREAKOUT_MAPS } from '../engine/breakout.js';

export function breakoutCard(ctx) {
  const { dev, state } = ctx;
  if (!/^n9/.test(dev.model)) return null;
  const qsfp = dev.ports.filter((p) => p.media === 'qsfp' || p.parent);
  const parents = [...new Set(qsfp.map((p) => p.parent || p.id))];
  if (!parents.length) return null;
  const used = parents.filter((pid) => (dev.breakout || {})[pid]);
  const label = (pid) => ((dev.breakout || {})[pid] || {}).label || (dev.ports.find((p) => p.id === pid) || {}).label || pid;
  const opts = [['', '不拆（100G）'], ...Object.keys(BREAKOUT_MAPS).map((m) => [m, `拆成 4 × ${BREAKOUT_MAPS[m] / 1000}G（${m}）`])];
  return h('div', { class: 'card breakout' }, cardHead('QSFP 分歧 (breakout)', badge(used.length ? 'on' : 'off', used.length ? `${used.length} 個埠已拆開` : '沒有拆')),
    note('muted', '一個 100G 的 QSFP28 埠可以拆成 4 個 25G（或 10G）的埠，用一條分歧線（一端 QSFP28、另一端 4 個 SFP28）接 4 台伺服器。拆開之後原本的埠消失，變成 /1 – /4 四個子埠；拆之前要先拔掉原本的線。'),
    h('div', { class: 'bo-list' }, parents.map((pid) => field(label(pid), sel(ctx, () => ((dev.breakout || {})[pid] || {}).map || '', (v) => {
      const cur = ((dev.breakout || {})[pid] || {}).map || '';
      if (v === cur) return;
      let e = cur ? unbreakoutPort(state, dev, pid) : null;
      if (!e && v) e = breakoutPort(state, dev, pid, v);
      if (e) toast(e, 'bad');
    }, opts, { rerender: true })))));
}
