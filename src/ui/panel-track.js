// 閘道備援 (VRRP / HSRP)、物件追蹤 (track) 與 IP SLA 的設定頁面
import { h, button } from './dom.js';
import { inp, sel, toggle, field, note, cardHead, badge, grid2, bind, del, isIp, isNum } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { trackUp, trackText, trackUsers, slaKey, SLA_FREQ, fhrpProto, fhrpGroup, fhrpPreempt, FHRP_DEC, HSRP_HOLD } from '../engine/track.js';

const l3Ifs = (dev) => dev.ifaces.filter((i) => i.bind.t !== 'wlan');
const ifName = (dev, id) => (dev.ifaces.find((i) => i.id === id) || { label: id }).label;
const nextNo = (obj) => Math.max(0, ...Object.keys(obj || {}).map(Number)) + 1;

/** 介面上的 VRRP / HSRP */
export function fhrpBlock(ctx, i) {
  const { dev, state } = ctx;
  const v = (i.vrrp ||= { on: false, vip: '', prio: '100' });
  const proto = fhrpProto(v), objs = Object.keys(dev.track || {});
  return h('div', { class: 'sub' },
    toggle(ctx, ...bind(v, 'on'), 'VRRP / HSRP / GLBP 虛擬閘道', { rerender: true }),
    v.on && grid2(
      field('協定', sel(ctx, () => proto, (x) => { if (x === 'hsrp' || x === 'glbp') v.proto = x; else delete v.proto; delete v.preempt; delete v.lb; }, [['vrrp', 'VRRP（公開標準）'], ['hsrp', 'HSRP（Cisco）'], ['glbp', 'GLBP（Cisco，好幾台一起轉送）']], { rerender: true })),
      field('群組', inp(ctx, () => String(fhrpGroup(v)), (x) => { if (+x === 1) delete v.group; else v.group = +x; }, { ph: '1', check: isNum(proto === 'vrrp' ? 1 : 0, proto === 'glbp' ? 1023 : 255) }), '兩台要一樣'),
      proto === 'glbp' && field('負載分配', sel(ctx, () => v.lb || 'round-robin', (x) => { if (x === 'round-robin') delete v.lb; else v.lb = x; }, [['round-robin', 'round-robin：依序輪流（預設）'], ['host-dependent', 'host-dependent：同一台主機固定同一台'], ['weighted', 'weighted：依權重']])),
      field('虛擬 IP', inp(ctx, ...bind(v, 'vip'), { ph: '例如 10.0.10.1', check: isIp })),
      field('優先權', inp(ctx, ...bind(v, 'prio'), { ph: '預設 100，越大越優先', check: isNum(1, proto === 'hsrp' ? 255 : 254) }))),
    v.on && h('div', { class: 'toggles' },
      toggle(ctx, () => fhrpPreempt(v), (on) => { if (proto === 'vrrp') { if (on) delete v.preempt; else v.preempt = false; } else if (on) v.preempt = true; else delete v.preempt; },
        `優先權比較高時搶回${proto === 'glbp' ? ' AVG' : '轉送權'} (preempt)${proto === 'vrrp' ? '：VRRP 預設會搶' : `：${proto.toUpperCase()} 預設不搶`}`)),
    v.on && h('div', { class: 'acl-h' }, h('span', { text: '追蹤 (track)' }), h('em', { text: '追蹤的物件 Down 時扣掉優先權，讓別台接手' })),
    v.on && (v.track || []).map((t, n) => h('div', { class: 'trow c-trk' },
      sel(ctx, () => String(t.obj), (x) => { t.obj = +x; }, objs.map((o) => [o, `track ${o}：${trackText(dev, dev.track[o])}`]).concat(objs.includes(String(t.obj)) ? [] : [[String(t.obj), `track ${t.obj}（不存在）`]])),
      inp(ctx, () => (t.dec != null ? String(t.dec) : ''), (x) => { if (x === '' || +x === FHRP_DEC) delete t.dec; else t.dec = +x; }, { ph: '扣 10', check: isNum(1, 255) }),
      del(() => { v.track.splice(n, 1); if (!v.track.length) delete v.track; ctx.commit(true); }))),
    v.on && h('div', { class: 'addrow' }, objs.length
      ? button('加入追蹤', { ic: 'plus', small: true, onclick: () => { (v.track ||= []).push({ obj: +objs[0] }); ctx.commit(true); } })
      : h('span', { class: 'muted', text: '要追蹤上游線路，先到「路由」分頁建立追蹤物件。' })),
    v.on && ctx.live(() => {
      const s = i.rt.vrrp;
      if (!s) return null;
      const who = proto === 'hsrp' ? ['Active', 'Standby'] : proto === 'glbp' ? ['AVG', 'Standby AVG'] : ['Master', 'Backup'];
      const pri = s.dec && s.dec.total ? `優先權 ${s.prio}（設定 ${s.cfgPrio}，追蹤的物件 Down 扣了 ${s.dec.total}）` : '';
      const out = [];
      if (s.state === 'master') out.push(note('ok', `${who[0]}：目前由這台回應虛擬 IP${s.peers ? '' : '（沒有看到同一組的其他成員）'}${pri ? '。' + pri : ''}`));
      else if (s.state === 'backup' && s.wait > 0) out.push(note('warn', `${who[1]}：聽不到 ${who[0]}，再 ${Math.ceil(s.wait)} 秒接手。這段時間沒有人回應虛擬 IP。`));
      else if (s.state === 'backup') out.push(note('muted', `${who[1]}：待命中，${who[0]} 故障約 ${proto === 'vrrp' ? 3 : HSRP_HOLD} 秒後接手${pri ? '。' + pri : ''}`));
      else out.push(note('warn', s.why));
      if (proto === 'glbp' && s.glbp) {
        const G = (state.rt.glbp || {})[s.glbp] || { fwds: [] }, me = dev.id + '/' + i.id;
        const mine = G.fwds.filter((f) => f.owner === me);
        out.push(note(mine.length ? 'ok' : 'muted', mine.length ? `AVF：負責轉送 ${mine.map((f) => `${f.mac}（第 ${f.n} 號）`).join('、')}；AVG 會把這些虛擬 MAC 輪流交給來問 ARP 的主機` : '這台現在沒有負責任何虛擬 MAC'));
        for (const f of G.fwds.filter((x) => !x.owner)) out.push(note('warn', `${f.mac} 的 AVF 失聯，${Math.ceil(f.wait)} 秒後由其他 AVF 接手`));
      }
      if (s.state === 'master' && s.dec && s.dec.total && s.peers) {
        const peers = (s.members || []).map(([d, id]) => { const x = state.devices[d], j = x && x.ifaces.find((y) => y.id === id); return j && j.rt && j.rt.vrrp ? { x, r: j.rt.vrrp } : null; }).filter(Boolean);
        const higher = peers.filter((p) => p.r.prio > s.prio);
        if (higher.length && higher.every((p) => !p.r.pre)) out.push(note('warn', `優先權已經降到 ${s.prio}，比 ${higher.map((p) => p.x.name).join('、')} 低，但對方沒有設定 preempt，不會把轉送權搶過去。`));
      }
      if (s.odd) out.push(note('warn', `同一個網段上的 ${state.devices[s.odd.dev] ? state.devices[s.odd.dev].name : s.odd.dev} 用的是 ${s.odd.proto.toUpperCase()} 群組 ${s.odd.grp}：協定或群組號碼不同，兩台不會協調，會同時回應虛擬 IP。`));
      return out;
    }));
}

/** 路由分頁：追蹤物件與 IP SLA */
export function trackCard(ctx) {
  const { dev, state } = ctx;
  const ifs = l3Ifs(dev);
  const slas = Object.entries(dev.sla || {}), objs = Object.entries(dev.track || {});
  return h('div', { class: 'card' }, cardHead('物件追蹤與 IP SLA'),
    note('muted', 'IP SLA 定期從路由器送 ping 到某個目標（例如 ISP 那一端或 8.8.8.8）。追蹤物件把介面或 IP SLA 的結果變成 Up / Down，給靜態路由（Down 就撤掉）和 VRRP / HSRP（Down 就扣優先權）使用。'),
    h('div', { class: 'acl-h' }, h('span', { text: 'IP SLA 探測（icmp-echo）' }), h('em', { text: '網路變了要等下一次探測才知道' })),
    slas.map(([n, op]) => h('div', { class: 'sub sla' },
      h('div', { class: 'card-h' }, h('b', { class: 'mono', text: `ip sla ${n}` }), ctx.live(() => slaBadge(state, dev, n, op)), del(() => { delete dev.sla[n]; if (!Object.keys(dev.sla).length) delete dev.sla; ctx.commit(true); })),
      grid2(
        field('目標 IP', inp(ctx, ...bind(op, 'dst'), { ph: '例如 203.0.113.1', check: isIp })),
        field('來源介面', sel(ctx, () => op.src || '', (x) => { op.src = x; }, [['', '依路由表'], ...ifs.map((i) => [i.id, i.label])])),
        field('頻率（秒）', inp(ctx, () => String(+op.freq || SLA_FREQ), (x) => { op.freq = +x || SLA_FREQ; }, { ph: '60', check: isNum(1, 604800) }))),
      h('div', { class: 'toggles' }, toggle(ctx, () => !!op.sched, (on) => { op.sched = on; if (on) op.life = 'forever'; }, '開始探測（ip sla schedule … life forever start-time now）')))),
    h('div', { class: 'addrow' }, button('新增 IP SLA', { ic: 'plus', small: true, onclick: () => { (dev.sla ||= {})[nextNo(dev.sla)] = { dst: '', src: '', freq: SLA_FREQ, sched: false }; ctx.commit(true); } })),
    h('div', { class: 'acl-h' }, h('span', { text: '追蹤物件 (track)' }), h('em', { text: '靜態路由與 VRRP / HSRP 用編號參考' })),
    objs.map(([n, t]) => h('div', { class: 'trow c-trkobj' },
      h('b', { class: 'mono', text: `track ${n}` }),
      sel(ctx, () => t.type, (x) => { if (x === 'sla') { delete t.iface; t.type = 'sla'; t.sla = +(Object.keys(dev.sla || {})[0] || 1); } else { delete t.sla; t.type = 'iface'; t.iface = (ifs[0] || {}).id; } }, [['iface', '介面線路'], ['sla', 'IP SLA']], { rerender: true }),
      t.type === 'sla'
        ? sel(ctx, () => String(t.sla), (x) => { t.sla = +x; }, Object.keys(dev.sla || {}).map((k) => [k, `ip sla ${k}`]).concat((dev.sla || {})[t.sla] ? [] : [[String(t.sla), `ip sla ${t.sla}（不存在）`]]))
        : sel(ctx, () => t.iface, (x) => { t.iface = x; }, ifs.map((i) => [i.id, i.label])),
      ctx.live(() => { const u = trackUp(state, dev, n); return h('span', { title: u.why || '' }, badge(u.up ? 'on' : 'warn', u.up ? 'Up' : 'Down')); }),
      del(() => { delete dev.track[n]; if (!Object.keys(dev.track).length) delete dev.track; ctx.commit(true); }))),
    objs.length ? ctx.live(() => {
      const used = objs.map(([n]) => [n, trackUsers(dev, n)]).filter(([, u]) => u.length);
      return used.length ? note('muted', used.map(([n, u]) => `track ${n} 給 ${u.join('、')} 使用`).join('；')) : note('warn', '追蹤物件還沒有被使用：在靜態路由的「追蹤」欄填物件編號，或在介面的 VRRP / HSRP 加入追蹤。');
    }) : null,
    h('div', { class: 'addrow' }, button('新增追蹤物件', { ic: 'plus', small: true, onclick: () => {
      const n = nextNo(dev.track), sl = Object.keys(dev.sla || {});
      (dev.track ||= {})[n] = sl.length ? { type: 'sla', sla: +sl[0] } : { type: 'iface', iface: (ifs[0] || {}).id };
      ctx.commit(true);
    } })));
}

function slaBadge(state, dev, n, op) {
  if (!op.sched) return badge('', '尚未開始');
  const r = ((state.dyn && state.dyn.sla) || {})[slaKey(dev, n)];
  if (!r) return badge('', '等待探測');
  const nextIn = Math.max(0, Math.ceil(r.last + (+op.freq || SLA_FREQ) - state.clock));
  return h('span', { title: `成功 ${r.okN} 次、失敗 ${r.failN} 次；${nextIn} 秒後下一次探測` }, badge(r.ok ? 'on' : 'warn', r.ok ? `OK ${r.rtt} ms` : r.code));
}

/** 靜態路由的「追蹤」欄 */
export function routeTrackInput(ctx, r) {
  return inp(ctx, () => (r.track != null ? String(r.track) : ''), (x) => { if (x === '') delete r.track; else r.track = +x; }, { ph: '—', check: isNum(1, 1000) });
}
export const fmt = fmtIp;
