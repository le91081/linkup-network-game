// 設定面板共用的表單元件與驗證
import { h, icon, toast } from './dom.js';
import { peerOf, portOf, removeCable, linkInfo } from '../engine/model.js';
import { parseIp, parseMask, parseCidr, fmtIp, fmtMask } from '../engine/ip.js';
import { parseIp6, parseCidr6 } from '../engine/ip6.js';

export const isIp6 = (v) => parseIp6(v) != null;
export const isCidr6 = (v) => v.includes('/') && parseCidr6(v) != null;

export const isIp = (v) => parseIp(v) != null;
export const isMask = (v) => parseMask(v) != null;
export const isIpList = (v) => v.split(/[,\s]+/).filter(Boolean).every(isIp);
export const isVlanSpec = (v) => v.toLowerCase() === 'all' || /^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/.test(v);
export const isPortNo = (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 65535;
export const isAddr = (v) => v.toLowerCase() === 'any' || parseCidr(v) != null;
export const isCidrList = (v) => v.split(/[,\s]+/).filter(Boolean).every((x) => parseCidr(x) != null);
export const isMacList = (v) => v.split(/[,\s]+/).filter(Boolean).every((x) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(x));
/** 防火牆政策的位址：any，或一個以上的位址 / 網段（用逗號分隔） */
export const isAddrList = (v) => v.trim().toLowerCase() === 'any' || (v.trim() !== '' && v.split(/[,\s]+/).filter(Boolean).every((x) => parseCidr(x) != null));
export const isNum = (lo, hi) => (v) => /^\d+$/.test(v) && +v >= lo && +v <= hi;

export const bind = (obj, key, parse) => [() => obj[key], (v) => { obj[key] = parse ? parse(v) : v; }];

export function inp(ctx, get, set, o = {}) {
  const el = h('input', {
    class: 'inp' + (o.mono === false ? '' : ' mono'), value: get() ?? '', placeholder: o.ph || '',
    spellcheck: 'false', autocomplete: 'off', type: 'text', style: o.w ? { width: o.w } : null,
  });
  const check = () => {
    const v = el.value.trim();
    el.classList.toggle('bad', v !== '' && !!o.check && !o.check(v));
  };
  el.addEventListener('input', check);
  el.addEventListener('change', () => { set(el.value.trim()); check(); ctx.commit(o.rerender); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  check();
  return el;
}

export function sel(ctx, get, set, options, o = {}) {
  const cur = String(get() ?? '');
  const el = h('select', { class: 'inp sel' }, options.map(([v, t]) => h('option', { value: String(v), selected: String(v) === cur, text: t })));
  el.addEventListener('change', () => { set(el.value); ctx.commit(o.rerender); });
  return el;
}

export function toggle(ctx, get, set, label, o = {}) {
  const c = h('input', { type: 'checkbox', checked: !!get() });
  c.addEventListener('change', () => { set(c.checked); ctx.commit(o.rerender); });
  return h('label', { class: 'switch', title: o.title }, c, h('i'), h('span', { text: label }));
}

export function seg(ctx, get, set, options) {
  return h('div', { class: 'seg' }, options.map(([v, t]) =>
    h('button', { type: 'button', class: get() === v ? 'on' : '', onclick: () => { if (get() !== v) { set(v); ctx.commit(true); } } }, t)));
}

export const field = (label, control, hint) =>
  h('label', { class: 'field' }, h('span', { class: 'f-label', text: label }), control, hint && h('span', { class: 'f-hint', text: hint }));
export const note = (kind, text) => h('div', { class: 'note ' + kind }, kind === 'ok' ? icon('check', 13) : null, text);
export const kv = (k, v) => h('div', { class: 'kv-row' }, h('span', { text: k }), h('b', { class: 'mono', text: v }));
export const del = (onclick, title = '刪除') => h('button', { class: 'mini danger', type: 'button', title, onclick }, icon('trash', 14));
export const cardHead = (title, ...rest) => h('div', { class: 'card-h' }, h('b', { class: 'mono', text: title }), ...rest);
export const badge = (kind, text) => h('span', { class: 'link ' + kind }, h('i'), text);
export const grid2 = (...kids) => h('div', { class: 'grid2' }, kids);

const conflictNote = (ctx, rt) => note('warn',
  `IP 位址衝突：${ctx.state.devices[rt.conflict]?.name || '另一台設備'} 也在用 ${fmtIp(rt.ip)}。兩台設備搶同一個 IP，連線會時通時不通。`);

/** 介面目前的實際狀態（會隨設定即時更新） */
export function ifaceNote(ctx, i) {
  return ctx.live(() => {
    const rt = i.rt || {};
    if (rt.active === false) return note('warn', '此介面目前沒有作用（連接埠不是 Routed 模式，或對應的 VLAN 不存在）');
    if (i.shut) return note('warn', '這個介面已被停用 (administratively down)，取消勾選「停用此介面」才會恢復連線。');
    if (i.mode === 'static') {
      if (rt.ip == null) {
        if (!i.ip && !i.mask) return i.bind.t === 'wlan' && rt.note ? note('warn', rt.note) : null;
        return note('warn', rt.note || 'IP 位址或子網路遮罩還沒填完整');
      }
      const bad = ctx.dev.rt.routes.find((r) => r.bad && r.iface === i && r.bits === 0);
      if (bad) return note('warn', bad.bad);
      if (!rt.link) return note('warn', i.bind.t === 'wlan' ? rt.note || 'Wi-Fi 尚未連線' : `已設定 ${fmtIp(rt.ip)}/${rt.bits}，但這個介面沒有連線`);
      if (rt.conflict) return conflictNote(ctx, rt);
      return note('ok', `已套用 ${fmtIp(rt.ip)}/${rt.bits}`);
    }
    if (rt.ip == null) return note('warn', rt.note || '尚未取得 IP 位址');
    const src = { dhcp: 'DHCP', pppoe: 'PPPoE', apipa: 'APIPA（找不到 DHCP 伺服器）' }[rt.src];
    return [h('div', { class: 'kv ' + (rt.src === 'apipa' ? 'warn' : 'ok') },
      kv('IP 位址', `${fmtIp(rt.ip)} / ${rt.bits}`), kv('子網路遮罩', fmtMask(rt.bits)),
      kv('預設閘道', rt.gw != null ? fmtIp(rt.gw) : '—'), kv('DNS', rt.dns.length ? rt.dns.map(fmtIp).join(', ') : '—'),
      kv('來源', src + (rt.server ? `（${ctx.state.devices[rt.server].name}${rt.relay ? '，經由 ' + ctx.state.devices[rt.relay].name + ' 轉送' : ''}）` : '')),
      rt.src === 'apipa' && rt.note && kv('原因', rt.note)),
    rt.conflict && conflictNote(ctx, rt)];
  });
}

export function linkBadge(ctx, pid) {
  const p = peerOf(ctx.state, ctx.dev.id, pid);
  if (!p) return badge('off', '未接線');
  const d = ctx.state.devices[p.dev];
  const up = ctx.state.rt.cable[p.cable] !== 'down';
  const why = ctx.state.rt.why[p.cable];
  const li = up && linkInfo(ctx.state, ctx.dev.id, pid);
  return h('span', { class: 'link ' + (up ? 'on' : 'warn'), title: why || (li && '連線速率：' + li.text) || null }, h('i'), `${d.name} · ${portOf(d, p.port).label}${up ? '' : '（無燈號）'}`,
    h('button', {
      class: 'mini', type: 'button', title: '拔除這條網路線',
      onclick: () => { removeCable(ctx.state, p.cable); toast('已拔除網路線'); ctx.commit(true); },
    }, icon('unplug', 13)));
}
