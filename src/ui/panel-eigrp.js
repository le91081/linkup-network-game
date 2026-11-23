// 路由分頁的 EIGRP 卡片：AS、每個介面要不要跑（與 passive）、variance、鄰居與原因
import { h, button, toast } from './dom.js';
import { inp, toggle, field, note, cardHead, badge, grid2, isNum, isIp } from './form.js';
import { fmtIp, netOf, parseIp } from '../engine/ip.js';
import { eigrpOn, eigrpPassive } from '../engine/eigrp.js';
import { fmtDur } from '../engine/sim.js';

const ipOfIf = (i) => (i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || ''));

/** 開關某個介面：開＝加一條只涵蓋它的 network（萬用遮罩 0.0.0.0）；關＝拿掉涵蓋它的敘述，同一條涵蓋的其他介面改成各自的敘述 */
function setIf(d, i, on) {
  const e = d.eigrp, ip = ipOfIf(i);
  if (ip == null) return;
  if (on) { e.nets = [...(e.nets || []).filter((n) => !(n.net === ip && n.bits === 32)), { net: ip, bits: 32 }]; return; }
  const hit = (n, a) => a != null && netOf(a, n.bits) === n.net;
  const drop = (e.nets || []).filter((n) => hit(n, ip));
  const keep = d.ifaces.filter((x) => x !== i && !x.vrf && drop.some((n) => hit(n, ipOfIf(x)))).map((x) => ({ net: ipOfIf(x), bits: 32 }));
  e.nets = [...(e.nets || []).filter((n) => !hit(n, ip)), ...keep];
}

export function eigrpCard(ctx) {
  const { dev, state } = ctx;
  if (!('ospfDefault' in dev)) return null;
  if (!eigrpOn(dev)) {
    const draft = { as: '100' };
    return h('div', { class: 'card eigrp' }, cardHead('EIGRP', badge('off', '沒有執行')),
      note('muted', 'Cisco 的距離向量路由協定：metric 看路徑上最慢的頻寬與延遲總和，DUAL 事先算好不會造成迴圈的備援路徑 (feasible successor)。同一個 AS 的路由器才會成為鄰居。'),
      h('div', { class: 'addrow' }, inp({ commit() {} }, () => draft.as, (v) => { draft.as = v; }, { ph: 'AS 號碼', w: '8em', check: isNum(1, 65535) }),
        button('啟用 EIGRP', { ic: 'plus', kind: 'primary', small: true, onclick: () => {
          if (!(+draft.as >= 1 && +draft.as <= 65535)) return toast('AS 號碼是 1 – 65535', 'bad');
          dev.eigrp = { as: +draft.as, nets: [] };
          ctx.commit(true);
          return undefined;
        } })));
  }
  const e = dev.eigrp, rt = dev.rt && dev.rt.eigrp;
  const l3 = dev.ifaces.filter((i) => !i.vrf && i.bind.t !== 'wlan' && ipOfIf(i) != null);
  const c = h('div', { class: 'card eigrp' }, cardHead(`EIGRP · AS ${e.as}`, badge(rt && rt.nbrs.length ? 'on' : 'warn', rt ? `${rt.nbrs.length} 個鄰居` : '沒有介面'),
    button('停用', { small: true, onclick: () => { delete dev.eigrp; ctx.commit(true); } })));
  c.append(grid2(
    field('variance', inp(ctx, () => String(e.variance || 1), (v) => { if (+v > 1) e.variance = +v; else delete e.variance; }, { ph: '1', check: isNum(1, 128) }), '大於 1：FD 不超過最佳 n 倍的 feasible successor 也一起分擔流量'),
    field('Router ID', inp(ctx, () => e.rid || '', (v) => { if (v) e.rid = v; else delete e.rid; }, { ph: rt && rt.rid != null ? `自動：${fmtIp(rt.rid)}` : '自動', check: isIp }))));
  for (const i of l3) {
    const on = (e.nets || []).some((n) => netOf(ipOfIf(i), n.bits) === n.net);
    const inf = rt && rt.ifs[i.id];
    const row = h('div', { class: 'eigrp-if' }, h('b', { class: 'mono', text: i.label }), h('span', { class: 'muted mono', text: fmtIp(ipOfIf(i)) }),
      toggle(ctx, () => on, (v) => setIf(dev, i, v), '跑 EIGRP', { rerender: true }),
      on && toggle(ctx, () => eigrpPassive(dev, i), (v) => {
        if (e.passiveDefault) e.noPassive = v ? (e.noPassive || []).filter((x) => x !== i.id) : [...new Set([...(e.noPassive || []), i.id])];
        else e.passive = v ? [...new Set([...(e.passive || []), i.id])] : (e.passive || []).filter((x) => x !== i.id);
      }, 'passive（不送 Hello、照樣宣告網段）', { rerender: true }));
    c.append(row);
    if (on && inf && inf.why.length) c.append(note('warn', `${i.label}：${inf.why.join('；')}`));
  }
  if (rt && rt.nbrs.length) {
    c.append(h('div', { class: 'acl-h' }, h('span', { text: '鄰居' }), h('em', { text: 'show ip eigrp neighbors' })));
    for (const n of rt.nbrs) {
      const i = dev.ifaces.find((x) => x.id === n.iface), o = state.devices[n.dev];
      c.append(h('div', { class: 'eigrp-nb' + (n.stale ? ' stale' : '') }, h('b', { class: 'mono', text: fmtIp(n.ip) }), h('span', { text: `${o ? o.name : n.dev} · ${i ? i.label : n.iface}` }),
        h('span', { class: 'muted', text: n.stale ? `沒有回應，${n.hold} 秒後拆掉` : `建立 ${fmtDur(Math.max(0, state.clock - n.since))}` })));
    }
  } else if (rt) c.append(note('muted', '還沒有鄰居：對面的路由器也要在同一個 AS 跑 EIGRP，介面在同一個子網路、K 值與驗證一致。'));
  c.append(note('muted', '驗證（key chain + ip authentication mode eigrp md5）、delay、彙總 (ip summary-address eigrp)、重分配在 CLI 設定。'));
  return c;
}
