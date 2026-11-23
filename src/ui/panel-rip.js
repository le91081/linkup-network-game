// 路由分頁的 RIP 卡片：版本、auto-summary、跑 RIP 的主網段、passive、學到的路與收不到更新的原因
import { h, button } from './dom.js';
import { toggle, sel, field, note, cardHead, badge, grid2 } from './form.js';
import { fmtIp, netOf, parseIp } from '../engine/ip.js';
import { ripOn, ripPassive, ripAuto } from '../engine/rip.js';
import { classBitsOf } from '../engine/eigrp.js';

const ipOfIf = (i) => (i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || ''));
const majorOf = (ip) => netOf(ip, classBitsOf(ip));

export function ripCard(ctx) {
  const { dev, state } = ctx;
  if (!('ospfDefault' in dev)) return null;
  if (!ripOn(dev)) {
    return h('div', { class: 'card rip' }, cardHead('RIP', badge('off', '沒有執行')),
      note('muted', '最老的距離向量路由協定：metric 只看跳數（最多 15 跳），每 30 秒把整張路由表送給鄰居。現在多半只剩在舊工廠、舊設備上，要和 OSPF / EIGRP 互相重分配。'),
      h('div', { class: 'addrow' }, button('啟用 RIPv2', { ic: 'plus', kind: 'primary', small: true, onclick: () => { dev.rip = { ver: 2, auto: false, nets: [] }; ctx.commit(true); } })));
  }
  const r = dev.rip, rt = dev.rt && dev.rt.rip;
  const l3 = dev.ifaces.filter((i) => !i.vrf && i.bind.t !== 'wlan' && ipOfIf(i) != null);
  const learned = rt ? Object.values(rt.db).filter((v) => v.use && v.use.length) : [];
  const c = h('div', { class: 'card rip' }, cardHead(`RIP${r.ver ? ' · v' + r.ver : ''}`, badge(learned.length ? 'on' : 'warn', rt ? `學到 ${learned.length} 筆` : '沒有介面'),
    button('停用', { small: true, onclick: () => { delete dev.rip; ctx.commit(true); } })));
  c.append(grid2(
    field('版本', sel(ctx, () => String(r.ver || ''), (v) => { if (v) r.ver = +v; else delete r.ver; }, [['', '沒有設定（送 v1、收 v1 / v2）'], ['2', 'version 2'], ['1', 'version 1']], { rerender: true }), 'RIPv1 不帶遮罩、不能驗證；兩邊的版本要對得上'),
    field('自動彙總', toggle(ctx, () => ripAuto(dev), (v) => { if (v) delete r.auto; else r.auto = false; }, 'auto-summary', { rerender: true }), '開著的話，子網路送到別的主網段時會合成有類別的網段（不連續的網段會出問題）')));
  // 每個主網段一個開關（RIP 的 network 只能寫主網段）
  const majors = [...new Set(l3.map((i) => majorOf(ipOfIf(i))))];
  for (const m of majors) {
    const on = (r.nets || []).includes(m);
    const ifs = l3.filter((i) => majorOf(ipOfIf(i)) === m);
    c.append(h('div', { class: 'rip-net' }, h('b', { class: 'mono', text: `network ${fmtIp(m)}` }), h('span', { class: 'muted', text: ifs.map((i) => i.label).join('、') }),
      toggle(ctx, () => on, (v) => { r.nets = v ? [...new Set([...(r.nets || []), m])] : (r.nets || []).filter((x) => x !== m); }, '跑 RIP', { rerender: true })));
    if (!on) continue;
    for (const i of ifs) {
      const inf = rt && rt.ifs[i.id];
      c.append(h('div', { class: 'rip-if' }, h('span', { class: 'mono', text: i.label }),
        toggle(ctx, () => ripPassive(dev, i), (v) => {
          if (r.passiveDefault) r.noPassive = v ? (r.noPassive || []).filter((x) => x !== i.id) : [...new Set([...(r.noPassive || []), i.id])];
          else r.passive = v ? [...new Set([...(r.passive || []), i.id])] : (r.passive || []).filter((x) => x !== i.id);
        }, 'passive（不送更新、照樣收）', { rerender: true })));
      if (inf && inf.why.length) c.append(note('warn', `${i.label}：${inf.why.join('；')}`));
    }
  }
  c.append(toggle(ctx, () => !!r.defOrig, (v) => { if (v) r.defOrig = true; else delete r.defOrig; }, '把預設路由送給鄰居 (default-information originate)', { rerender: true }));
  if (rt && learned.length) {
    c.append(h('div', { class: 'acl-h' }, h('span', { text: '學到的路' }), h('em', { text: 'show ip rip database' })));
    for (const v of learned.sort((a, b) => (a.net >>> 0) - (b.net >>> 0) || a.bits - b.bits)) {
      c.append(h('div', { class: 'rip-rt' }, h('b', { class: 'mono', text: `${fmtIp(v.net)}/${v.bits}` }), h('span', { class: 'muted', text: `${v.metric} 跳` }),
        h('span', { class: 'mono', text: v.use.map((x) => `via ${fmtIp(x.via)}${x.stale ? '（沒有更新了）' : ''}`).join('、') })));
    }
  }
  if (rt && rt.down.length) c.append(note('warn', `possibly down（holddown 中）：${rt.down.map((x) => `${fmtIp(x.net)}/${x.bits}（${x.left} 秒後清掉）`).join('、')}`));
  if (rt && !learned.length && !Object.values(rt.ifs).some((f) => f.why.length)) c.append(note('muted', '還沒有學到路：鄰居也要跑 RIP、版本對得上，介面不能是 passive。'));
  void state;
  c.append(note('muted', '重分配、驗證（ip rip authentication key-chain）、ip rip send / receive version、計時器 (timers basic) 在 CLI 設定。'));
  return c;
}
