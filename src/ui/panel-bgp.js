// BGP 的設定頁面：本地 AS、要通告的網段、鄰居與簡單的政策（產生真正的 route-map / prefix-list，和 CLI 是同一份設定）
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, del, cardHead, grid2, bind, badge, isIp, isNum, toggle } from './form.js';
import { fmtIp, parseIp, parseCidr } from '../engine/ip.js';

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
  const { dev } = ctx;
  if (dev.kind !== 'router') return null;
  const draft = (ctx.app.bgpDraft ||= {});
  if (!dev.bgp) {
    return h('div', { class: 'card' }, cardHead('BGP'),
      note('muted', '和 ISP 交換路由（eBGP，對方是別的 AS），或在自己的 AS 裡的邊界路由器之間互相告知（iBGP，同一個 AS）。要先向 ISP 申請 AS 號碼與網段，ISP 那邊也要把你設成鄰居。'),
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
    h('div', { class: 'acl-h' }, h('span', { text: '鄰居' }), h('em', { text: 'eBGP 只和直連的鄰居建立關係；iBGP（同一個 AS）通常用 Loopback 建立' })),
    b.neighbors.map((n, k) => h('div', { class: 'qos-pm' },
      h('div', { class: 'line' }, h('b', { class: 'mono', text: n.ip }), h('span', { class: 'chip tiny', text: +n.remoteAs === +b.asn ? 'iBGP' : 'eBGP' }),
        h('span', { style: { marginLeft: 'auto' } }, ctx.live(() => { const p = ((dev.rt.bgp || {}).peers || []).find((x) => x.ip === n.ip); return p ? badge(p.state === 'Established' ? 'on' : 'warn', p.state === 'Established' ? `Established · 收到 ${p.pfx} 筆` : p.state) : null; })),
        del(() => { b.neighbors.splice(k, 1); ctx.commit(true); })),
      ctx.live(() => { const p = ((dev.rt.bgp || {}).peers || []).find((x) => x.ip === n.ip); return p && p.state !== 'Established' && p.why ? note('warn', p.why) : null; }),
      grid2(
        // 改 remote-as 就像在 CLI 重打一次 neighbor … remote-as：鄰居關係會重新建立
        field('對方的 AS (remote-as)', inp(ctx, () => String(n.remoteAs), (v) => {
          if (!/^\d+$/.test(v) || !(+v > 0) || +v > 4294967295) return toast('AS 號碼是 1 到 4294967295 的整數', 'bad');
          if ((+n.remoteAs === +b.asn) !== (+v === +b.asn)) delete n.rrClient; // iBGP ↔ eBGP：只有 iBGP 能用的設定跟著拿掉
          n.remoteAs = +v;
          return undefined;
        }, { check: isNum(1, 4294967295), rerender: true }), +n.remoteAs === +b.asn ? '和自己一樣：iBGP' : '和自己不一樣：eBGP'),
        field('說明 (description)', inp(ctx, ...bind(n, 'desc'), { ph: '例如 ISP-A', mono: false }))),
      grid2(
        field('來源介面 (update-source)', sel(ctx, () => n.updSrc || '', (v) => { if (v) n.updSrc = v; else delete n.updSrc; },
          [['', '自動（往鄰居的出口介面）'], ...dev.ifaces.filter((i) => !i.vrf && i.bind.t !== 'wlan').map((i) => [i.id, i.label])]), 'TCP 179 從哪個位址送出。對方設定的鄰居位址是你的 Loopback，這裡就要選那個 Loopback'),
        +n.remoteAs !== +b.asn && field('eBGP 最多隔幾台 (ebgp-multihop)', inp(ctx, () => (n.multihop ? String(n.multihop) : ''), (v) => { if (+v > 0) n.multihop = Math.min(255, +v); else delete n.multihop; }, { ph: '留空＝1（只和直連的鄰居）', check: isNum(1, 255) }), '用 Loopback 建立 eBGP 時填 2')),
      // 下面這些是對 ISP 的政策（決定往外、往內走哪一家），iBGP 鄰居用不到
      +n.remoteAs !== +b.asn && grid2(
        field('收到的路由：local-preference', inp(ctx, () => String(lpOf(dev, n)), (v) => setLp(dev, n, v), { ph: '預設 100，越高越優先（決定往外走哪一家）', check: isNum(0, 4294967295) })),
        field('送出去時 AS path 多加幾次自己', inp(ctx, () => (prependOf(dev, n) ? String(prependOf(dev, n)) : ''), (v) => setPrepend(dev, n, v), { ph: '0（AS path 越長，別人越不會從這裡進來）', check: isNum(0, 10) }))),
      h('div', { class: 'toggles' },
        +n.remoteAs === +b.asn && toggle(ctx, () => !!n.nhSelf, (v) => { if (v) n.nhSelf = true; else delete n.nhSelf; }, '送給這個 iBGP 鄰居時，下一站改成自己 (next-hop-self)：不然下一站是 ISP 的位址，對方的路由表裡查不到'),
        +n.remoteAs === +b.asn && toggle(ctx, () => !!n.rrClient, (v) => { if (v) n.rrClient = true; else delete n.rrClient; }, '把它當成 route reflector 的 client (route-reflector-client)：從 iBGP 學到的路也轉送給它'),
        toggle(ctx, () => !!n.sendComm, (v) => { if (v) n.sendComm = 'standard'; else delete n.sendComm; }, '送出 community 屬性 (send-community)：沒有打開的話，路由上的 community 不會送給這個鄰居'),
        +n.remoteAs !== +b.asn && toggle(ctx, () => !!n.allowAs, (v) => { if (v) n.allowAs = 3; else delete n.allowAs; }, '收到的路 AS_PATH 裡有自己的 AS 也接受 (allowas-in)：MPLS VPN 的每個據點用同一個 AS 時要打開'),
        +n.remoteAs !== +b.asn && toggle(ctx, () => !!n.asOverride, (v) => { if (v) n.asOverride = true; else delete n.asOverride; }, '送給這個鄰居之前，把它的 AS 換成自己的 (as-override)：業者的 PE 對客戶的 CE 用'),
        +n.remoteAs !== +b.asn && toggle(ctx, () => n.plOut === OWN, (on) => {
          if (on) { n.plOut = OWN; syncOwn(dev); } else { delete n.plOut; }
          if (n.rmOut) setPrepend(dev, n, prependOf(dev, n));
        }, '只送出自己的網段（prefix-list）：避免把一家 ISP 的路由轉送給另一家，變成它們之間的轉運站')))),
    h('div', { class: 'addrow' },
      inp({ commit() {} }, ...bind(draft, 'nip'), { ph: '鄰居 IP', check: isIp }),
      inp({ commit() {} }, ...bind(draft, 'nas'), { ph: '對方的 AS', check: isNum(1, 4294967295) }),
      button('新增鄰居', { small: true, onclick: () => {
        if (parseIp(draft.nip || '') == null || !(+draft.nas > 0)) return toast('請填鄰居的 IP 與 AS', 'bad');
        if (dev.ifaces.some((i) => i.ip === draft.nip)) return toast('這是這台自己的位址', 'bad');
        if (!b.neighbors.some((n) => n.ip === draft.nip)) b.neighbors.push({ ip: draft.nip, remoteAs: +draft.nas });
        draft.nip = ''; draft.nas = '';
        ctx.commit(true);
      } })),
    ctx.live(() => {
      const all = (dev.rt.bgp || {}).table || [];
      const t = all.filter((r) => r.best), dead = all.filter((r) => r.valid === false);
      const deadNote = dead.length ? note('warn', `下一站查不到 (inaccessible)，不能用：${[...new Set(dead.map((r) => `${fmtNet(r)}（下一站 ${fmtIp(r.nh)}）`))].join('、')}。從 iBGP 學到的路下一站不會變：在送出它的邊界路由器上打開 next-hop-self`) : null;
      if (!t.length) return deadNote;
      return [h('div', { class: 'acl-h' }, h('span', { text: '最佳路徑' }), h('em', { text: 'weight → local-preference → AS path 長短 → …' })),
        ...t.map((r) => h('div', { class: 'bgp-best' },
          h('div', { class: 'top' }, h('b', { class: 'mono', text: r.bits === 0 ? '0.0.0.0/0' : fmtNet(r) }),
            r.local ? h('span', { class: 'muted', text: '自己發出的' }) : h('span', { class: 'mono muted', text: `${r.ibgp ? 'iBGP · ' : ''}經由 ${fmtIp(r.nh)}${r.ribFail ? ' · 路由表裡有更好的路（RIB-failure）' : ''}` })),
          r.local ? null : h('span', { class: 'mono path', text: `AS path ${r.aspath.join(' ') || '(空)'}${r.lp != null && r.lp !== 100 ? ' · local-pref ' + r.lp : ''}${r.originator != null ? ' · 由 route reflector 轉送' : ''}` }))), deadNote];
    }));
}
