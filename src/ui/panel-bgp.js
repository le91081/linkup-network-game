// BGP 的設定頁面：本地 AS、要通告的網段、鄰居與簡單的政策（產生真正的 route-map / prefix-list，和 CLI 是同一份設定）
import { h, button, toast } from './dom.js';
import { inp, field, note, del, cardHead, grid2, bind, badge, isIp, isNum, toggle } from './form.js';
import { fmtIp, parseIp, netOf, parseCidr } from '../engine/ip.js';

const fmtNet = (n) => `${fmtIp(n.net)}/${n.bits}`;
const OWN = 'OWN-PREFIXES';

/** 這個鄰居目前的 local-preference / prepend（從它用的 route-map 讀回來） */
const rmIn = (d, n) => (n.rmIn && (d.routeMaps || {})[n.rmIn]) || null;
const rmOut = (d, n) => (n.rmOut && (d.routeMaps || {})[n.rmOut]) || null;
const lpOf = (d, n) => { const m = rmIn(d, n); const e = m && m.find((x) => x.action === 'permit'); return e && e.set.lp != null ? e.set.lp : ''; };
const prependOf = (d, n) => { const m = rmOut(d, n); const e = m && m.find((x) => x.action === 'permit'); return e && e.set.prepend ? e.set.prepend.length : 0; };
const tag = (n) => (n.desc || n.ip).replace(/[^\w-]+/g, '-').toUpperCase();

/** 讓 OWN-PREFIXES 永遠等於要通告的網段 */
function syncOwn(d) {
  if (!Object.values(d.bgp.neighbors).some((n) => n.plOut === OWN)) return;
  (d.prefixLists ||= {})[OWN] = d.bgp.networks.map((x, k) => ({ seq: (k + 1) * 5, action: 'permit', net: x.net, bits: x.bits }));
}
function setLp(d, n, v) {
  const name = n.rmIn || `${tag(n)}-IN`;
  if (v === '' || v == null) { if (n.rmIn && d.routeMaps) delete d.routeMaps[n.rmIn]; delete n.rmIn; return; }
  (d.routeMaps ||= {})[name] = [{ seq: 10, action: 'permit', match: {}, set: { lp: +v } }];
  n.rmIn = name;
}
function setPrepend(d, n, times) {
  const name = n.rmOut || `${tag(n)}-OUT`;
  const keepPl = n.plOut;
  if (!(+times > 0)) { if (n.rmOut && d.routeMaps) delete d.routeMaps[n.rmOut]; delete n.rmOut; return; }
  (d.routeMaps ||= {})[name] = [{ seq: 10, action: 'permit', match: keepPl ? { pl: keepPl } : {}, set: { prepend: Array(+times).fill(+d.bgp.asn) } }];
  n.rmOut = name;
}

export function bgpCard(ctx) {
  const { dev, state } = ctx;
  if (dev.kind !== 'router') return null;
  const draft = (ctx.app.bgpDraft ||= {});
  if (!dev.bgp) {
    return h('div', { class: 'card' }, cardHead('BGP'),
      note('muted', '和 ISP 交換路由（eBGP）。要先向 ISP 申請 AS 號碼與網段，ISP 那邊也要把你設成鄰居。'),
      h('div', { class: 'addrow' }, inp({ commit() {} }, ...bind(draft, 'asn'), { ph: '本地 AS，例如 65010', check: isNum(1, 4294967295) }),
        button('啟用 BGP', { small: true, onclick: () => { if (!(+draft.asn > 0)) return toast('請填 AS 號碼', 'bad'); dev.bgp = { asn: +draft.asn, neighbors: [], networks: [] }; ctx.commit(true); } })));
  }
  const b = dev.bgp;
  return h('div', { class: 'card' }, cardHead(`BGP · AS ${b.asn}`, button('停用', { small: true, onclick: () => { delete dev.bgp; ctx.commit(true); } })),
    grid2(field('BGP Router ID', inp(ctx, ...bind(b, 'rid'), { ph: '留空＝Loopback 或最大的介面 IP', check: isIp }))),
    h('div', { class: 'acl-h' }, h('span', { text: '要通告的網段 (network)' }), h('em', { text: '路由表裡要有一模一樣的網段才會送出去' })),
    b.networks.map((x, k) => h('div', { class: 'line' }, h('b', { class: 'mono', text: fmtNet(x) }), del(() => { b.networks.splice(k, 1); syncOwn(dev); ctx.commit(true); }))),
    h('div', { class: 'addrow' }, inp({ commit() {} }, ...bind(draft, 'net'), { ph: '例如 192.0.2.0/24', check: (v) => parseCidr(v) != null }),
      button('新增', { small: true, onclick: () => {
        const c = parseCidr(String(draft.net || ''));
        if (!c) return toast('網段寫成 192.0.2.0/24', 'bad');
        if (!b.networks.some((x) => x.net === c.net && x.bits === c.bits)) b.networks.push({ net: c.net, bits: c.bits });
        draft.net = ''; syncOwn(dev); ctx.commit(true);
      } })),
    h('div', { class: 'acl-h' }, h('span', { text: '鄰居' }), h('em', { text: 'eBGP 只和直連的鄰居建立關係（TCP 179）' })),
    b.neighbors.map((n, k) => h('div', { class: 'qos-pm' },
      h('div', { class: 'line' }, h('b', { class: 'mono', text: n.ip }), h('span', { class: 'mono', text: `AS ${n.remoteAs}` }),
        inp(ctx, ...bind(n, 'desc'), { ph: '說明，例如 ISP-A', mono: false }),
        ctx.live(() => { const p = ((dev.rt.bgp || {}).peers || []).find((x) => x.ip === n.ip); return p ? badge(p.state === 'Established' ? 'on' : 'warn', p.state === 'Established' ? `Established · 收到 ${p.pfx} 筆` : p.state) : null; }),
        del(() => { b.neighbors.splice(k, 1); ctx.commit(true); })),
      ctx.live(() => { const p = ((dev.rt.bgp || {}).peers || []).find((x) => x.ip === n.ip); return p && p.state !== 'Established' && p.why ? note('warn', p.why) : null; }),
      grid2(
        field('收到的路由：local-preference', inp(ctx, () => String(lpOf(dev, n)), (v) => setLp(dev, n, v), { ph: '預設 100，越高越優先（決定往外走哪一家）', check: isNum(0, 4294967295) })),
        field('送出去時 AS path 多加幾次自己', inp(ctx, () => (prependOf(dev, n) ? String(prependOf(dev, n)) : ''), (v) => setPrepend(dev, n, v), { ph: '0（AS path 越長，別人越不會從這裡進來）', check: isNum(0, 10) }))),
      h('div', { class: 'toggles' },
        toggle(ctx, () => n.plOut === OWN, (on) => {
          if (on) { n.plOut = OWN; syncOwn(dev); } else { delete n.plOut; }
          if (n.rmOut) setPrepend(dev, n, prependOf(dev, n));
        }, '只送出自己的網段（prefix-list）：避免把一家 ISP 的路由轉送給另一家，變成它們之間的轉運站')))),
    h('div', { class: 'addrow' },
      inp({ commit() {} }, ...bind(draft, 'nip'), { ph: '鄰居 IP', check: isIp }),
      inp({ commit() {} }, ...bind(draft, 'nas'), { ph: '對方的 AS', check: isNum(1, 4294967295) }),
      button('新增鄰居', { small: true, onclick: () => {
        if (parseIp(draft.nip || '') == null || !(+draft.nas > 0)) return toast('請填鄰居的 IP 與 AS', 'bad');
        if (+draft.nas === +b.asn) return toast('這個模擬只做 eBGP：鄰居的 AS 要和自己不一樣', 'bad');
        if (!b.neighbors.some((n) => n.ip === draft.nip)) b.neighbors.push({ ip: draft.nip, remoteAs: +draft.nas });
        draft.nip = ''; draft.nas = '';
        ctx.commit(true);
      } })),
    ctx.live(() => {
      const t = ((dev.rt.bgp || {}).table || []).filter((r) => r.best);
      if (!t.length) return null;
      return [h('div', { class: 'acl-h' }, h('span', { text: '最佳路徑' }), h('em', { text: 'weight → local-preference → AS path 長短 → …' })),
        ...t.map((r) => h('div', { class: 'line' }, h('b', { class: 'mono', text: r.bits === 0 ? '0.0.0.0/0' : fmtNet(r) }),
          h('span', { class: 'mono muted', style: { marginLeft: 'auto' }, text: r.local ? '自己發出的' : `經由 ${fmtIp(r.nh)} · AS path ${r.aspath.join(' ')}${r.lp != null && r.lp !== 100 ? ' · LP ' + r.lp : ''}` })))];
    }));
  void netOf; void state;
}
