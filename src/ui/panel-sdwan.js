// FortiGate 的 SD-WAN 分頁：成員、效能 SLA（即時的量測結果）、SD-WAN 規則
import { h, button, icon } from './dom.js';
import { inp, sel, toggle, field, note, cardHead, badge, del, grid2, bind } from './form.js';
import { ZONE, newSdwan, memberHealth } from '../engine/sdwan.js';
import { parseIp } from '../engine/ip.js';

const isNum = (lo, hi) => (v) => /^\d+(\.\d+)?$/.test(v) && +v >= lo && +v <= hi;

export function sdwanTab(ctx, body) {
  const { app, dev, state } = ctx;
  const ui = ((app.sdwUi ||= {})[dev.id] ||= { err: '' });
  body.append(h('p', { class: 'tip', text: `SD-WAN 把好幾條 WAN 線路合成一個區域（${ZONE}）：效能 SLA 持續量每條線路的延遲、抖動與遺失，SD-WAN 規則依流量的種類挑線路，一條斷了自動改走別條。` }));
  if (!dev.sdwan) {
    body.append(h('div', { class: 'card' }, cardHead('SD-WAN', badge('off', '停用')),
      note('muted', '目前每條 WAN 各自有預設路由（閘道）：兩條都有閘道時會依來源與目的位址分散，不管線路品質。'),
      h('div', { class: 'addrow' }, button('啟用 SD-WAN', { ic: 'plus', kind: 'primary', small: true, onclick: () => { dev.sdwan = newSdwan(); ctx.commit(true); } }))));
    return;
  }
  const s = dev.sdwan;
  const H = memberHealth(state, dev);
  const wans = dev.ifaces.filter((i) => i.bind.t === 'port');
  const usedBy = (id) => (dev.policies || []).map((p, n) => [p, n]).filter(([p]) => p.srcIf === id || p.dstIf === id).map(([p, n]) => `#${n + 1}「${p.name || '未命名'}」`);
  const label = (seq) => { const m = s.members.find((x) => x.seq === seq); const i = m && dev.ifaces.find((x) => x.id === m.iface); return i ? i.label : `成員 ${seq}`; };
  // 區域
  body.append(h('div', { class: 'card' }, cardHead(`SD-WAN 區域 · ${ZONE}`, badge(s.on ? 'on' : 'off', s.on ? '啟用' : '停用')),
    toggle(ctx, ...bind(s, 'on'), '啟用 SD-WAN', { rerender: true }),
    note('muted', `成員的介面加進 SD-WAN 之後，防火牆政策的目的介面要寫 ${ZONE}；還被政策使用中的介面不能加進 SD-WAN。`)));
  // 成員
  const mc = h('div', { class: 'card' }, cardHead('成員'));
  s.members.forEach((m, n) => {
    const hh = H.find((x) => x.m === m) || {};
    mc.append(h('div', { class: 'sdw-member' },
      h('b', { class: 'mono', text: `#${m.seq}` }),
      sel(ctx, () => m.iface, (v) => {
        const u = usedBy(v);
        if (u.length) { ui.err = `${v} 正被政策 ${u.join('、')} 使用：先把那條政策的介面改成 ${ZONE}（或刪掉），才能加進 SD-WAN`; return; }
        ui.err = ''; m.iface = v;
      }, wans.map((i) => [i.id, i.label]), { rerender: true }),
      inp(ctx, ...bind(m, 'gw'), { ph: '閘道，例如 203.0.113.33', check: (v) => parseIp(v) != null }),
      del(() => { s.members.splice(n, 1); for (const r of s.rules) r.prio = (r.prio || []).filter((x) => x !== m.seq); ctx.commit(true); }),
      h('span', { class: 'sdw-state ' + (hh.alive ? 'ok' : 'bad'), text: hh.alive ? `alive · ${hh.latency} ms / ${hh.jitter} ms / ${hh.loss}%` : `dead${hh.why ? '：' + hh.why : ''}` })));
  });
  mc.append(h('div', { class: 'addrow' }, button('新增成員', {
    ic: 'plus', small: true,
    onclick: () => {
      const free = wans.find((i) => /^wan/i.test(i.id) && !s.members.some((m) => m.iface === i.id)) || wans.find((i) => !s.members.some((m) => m.iface === i.id));
      if (!free) { ui.err = '沒有可以再加進來的介面'; ctx.commit(true); return; }
      const u = usedBy(free.id);
      if (u.length) { ui.err = `${free.label} 正被政策 ${u.join('、')} 使用：先把那條政策的介面改成 ${ZONE}（或刪掉），才能加進 SD-WAN`; ctx.commit(true); return; }
      ui.err = '';
      s.members.push({ seq: Math.max(0, ...s.members.map((m) => m.seq)) + 1, iface: free.id, gw: free.gateway || '' });
      ctx.commit(true);
    },
  })), ui.err && note('warn', ui.err));
  body.append(mc);
  // 效能 SLA
  const hc = s.hc;
  const hcCard = h('div', { class: 'card' }, cardHead('效能 SLA (Performance SLA)'),
    grid2(field('名稱', inp(ctx, ...bind(hc, 'name'), { mono: false })), field('偵測目標 (ping)', inp(ctx, ...bind(hc, 'server'), { check: (v) => parseIp(v) != null }))),
    h('div', { class: 'grid3' },
      field('延遲門檻 (ms)', inp(ctx, () => String(hc.latency), (v) => { hc.latency = +v; }, { check: isNum(1, 5000), rerender: true })),
      field('抖動門檻 (ms)', inp(ctx, () => String(hc.jitter), (v) => { hc.jitter = +v; }, { check: isNum(0, 5000), rerender: true })),
      field('遺失門檻 (%)', inp(ctx, () => String(hc.loss), (v) => { hc.loss = +v; }, { check: isNum(0, 100), rerender: true }))));
  hcCard.append(ctx.live(() => {
    const rows = memberHealth(ctx.state, dev);
    if (!rows.length) return note('muted', '還沒有成員。');
    return h('div', { class: 'sdw-sla' }, h('div', { class: 'sdw-row head' }, ...['成員', '延遲', '抖動', '遺失', 'SLA'].map((t) => h('span', { text: t }))),
      rows.map((r) => h('div', { class: 'sdw-row' }, h('b', { text: r.iface ? r.iface.label : r.m.iface }),
        ...(r.alive ? [h('span', { text: `${r.latency} ms` }), h('span', { text: `${r.jitter} ms` }), h('span', { text: `${r.loss}%` }), h('span', { class: r.sla ? 'ok' : 'bad', text: r.sla ? '✓ 符合' : `✗ ${r.slaWhy}` })]
          : [h('span', { class: 'bad', text: 'dead' }), h('span'), h('span'), h('span', { class: 'bad', text: '✗' })]))));
  }));
  body.append(hcCard);
  // 規則
  const seqOpts = s.members.map((m) => [String(m.seq), label(m.seq)]);
  body.append(h('p', { class: 'tip', text: 'SD-WAN 規則：由上往下比對，第一條符合的決定走哪一條。沒有符合任何規則的流量，依來源位址分散到所有活著的成員。' }));
  s.rules.forEach((r, n) => {
    const move = (d) => { const [x] = s.rules.splice(n, 1); s.rules.splice(n + d, 0, x); ctx.commit(true); };
    const prio = (k) => sel(ctx, () => String((r.prio || [])[k] ?? ''), (v) => { const p = [...(r.prio || [])]; p[k] = +v; r.prio = [...new Set(p.filter((x) => x))]; }, [['', k ? '（沒有）' : '（選擇）'], ...seqOpts], { rerender: true });
    body.append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('span', { class: 'pno', text: '#' + (n + 1) }), inp(ctx, ...bind(r, 'name'), { mono: false, ph: '規則名稱' }),
        h('button', { class: 'mini', type: 'button', title: '上移', disabled: n === 0, onclick: () => move(-1) }, icon('up', 14)),
        h('button', { class: 'mini', type: 'button', title: '下移', disabled: n === s.rules.length - 1, onclick: () => move(1) }, icon('down', 14)),
        del(() => { s.rules.splice(n, 1); ctx.commit(true); })),
      grid2(
        field('目的位址', inp(ctx, ...bind(r, 'dst'), { ph: 'any 或 198.51.100.60' })),
        field('協定', sel(ctx, ...bind(r, 'proto'), [['any', '全部'], ['udp', 'UDP'], ['tcp', 'TCP']])),
        field('埠（空白表示全部）', inp(ctx, ...bind(r, 'port'), { ph: '例如 5060 或 16384-32767' })),
        field('挑線路的方式', sel(ctx, ...bind(r, 'mode'), [['manual', '手動（照順序，第一條活著的）'], ['sla', 'SLA（照順序，第一條符合 SLA 的）'], ['latency', '最佳品質（延遲最低）']], { rerender: true })),
        field('第一順位', prio(0)), field('第二順位', prio(1)))));
  });
  body.append(h('div', { class: 'addrow' }, button('新增 SD-WAN 規則', { ic: 'plus', kind: 'primary', small: true, onclick: () => { s.rules.push({ name: '', dst: 'any', proto: 'any', port: '', mode: 'manual', prio: s.members.map((m) => m.seq) }); ctx.commit(true); } })));
}
