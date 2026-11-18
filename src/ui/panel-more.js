// 設定頁面（續）：RADIUS / 802.1X、靜態 NAT、IPv6、本機帳號與 SNMP
import { h, button } from './dom.js';
import { sessionLog, clearSessionLog, arpRows } from '../engine/sim.js';
import { inp, sel, toggle, seg, field, note, kv, del, cardHead, grid2, bind, isIp, isIp6, isCidr6 } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { fmtIp6 } from '../engine/ip6.js';
import { route6Rows, mode6 } from '../engine/sim6.js';

// ───────────────────────── RADIUS / 802.1X ─────────────────────────

/** 驗證者（交換器、基地台）這一端：要去問哪一台 RADIUS 伺服器 */
export function radiusClientCard(ctx) {
  const { dev } = ctx;
  const r = (dev.radius ||= { ip: '', secret: '' });
  return h('div', { class: 'card' }, cardHead('RADIUS 伺服器（802.1X 驗證）'),
    grid2(
      field('伺服器 IP', inp(ctx, ...bind(r, 'ip'), { ph: '例如 192.168.10.5', check: isIp })),
      field('共用密鑰', inp(ctx, ...bind(r, 'secret'), { ph: '要和伺服器上的設定一致' }))),
    ctx.live(() => {
      const i = dev.ifaces.find((x) => x.rt && x.rt.ip != null);
      return i ? note('muted', `這台設備會用自己的 IP ${fmtIp(i.rt.ip)} 向 RADIUS 伺服器查詢使用者的帳密。`)
        : note('warn', '這台設備自己還沒有 IP，連不到 RADIUS 伺服器。');
    }));
}

/** RADIUS 伺服器（主機）上的帳號資料庫 */
export function radiusServerTab(ctx, body) {
  const { dev } = ctx;
  const r = dev.radiusServer;
  body.append(h('p', { class: 'tip', text: '交換器與基地台（驗證者）會把使用者輸入的帳密送到這裡查核。兩邊必須設定同一組共用密鑰，RADIUS 才會接受對方的請求。' }));
  const card = h('div', { class: 'card' }, cardHead('RADIUS 服務 · UDP 1812'),
    field('共用密鑰 (shared secret)', inp(ctx, ...bind(r, 'secret'), { ph: '例如 Radius#Key2026' })),
    h('div', { class: 'thead c-user' }, h('span', { text: '帳號' }), h('span', { text: '密碼' }), h('span')));
  r.users.forEach((u, n) => card.append(h('div', { class: 'trow c-user' },
    inp(ctx, ...bind(u, 'user'), { ph: '帳號', mono: false }), inp(ctx, ...bind(u, 'pass'), { ph: '密碼' }),
    del(() => { r.users.splice(n, 1); ctx.commit(true); }))));
  card.append(h('div', { class: 'addrow' }, button('新增帳號', { ic: 'plus', small: true, onclick: () => { r.users.push({ user: '', pass: '' }); ctx.commit(true); } })),
    ctx.live(() => (!r.secret ? note('warn', '還沒有設定共用密鑰。') : !r.users.some((u) => u.user) ? note('muted', '還沒有任何帳號。') : note('ok', `共 ${r.users.filter((u) => u.user).length} 個帳號可以登入。`))));
  body.append(card);
}

/** 終端設備的 802.1X 用戶端 (supplicant) */
export function hostDot1x(ctx) {
  const d = ctx.dev.dot1x;
  return h('div', { class: 'sub' }, h('span', { class: 'f-label', text: '有線網路的 802.1X 登入' }),
    grid2(
      field('帳號', inp(ctx, ...bind(d, 'user'), { ph: '個人帳號', mono: false })),
      field('密碼', inp(ctx, ...bind(d, 'pass'), { ph: '密碼' }))));
}

// ───────────────────────── 靜態 NAT ─────────────────────────

export function staticNatCard(ctx) {
  const { dev } = ctx;
  const list = dev.staticNat;
  const card = h('div', { class: 'card' }, cardHead('靜態 NAT（一對一）'));
  if (!list.length) card.append(note('muted', '沒有任何對應。靜態 NAT 會把一個公用 IP 完整地對應到一台內部主機。'));
  else card.append(h('div', { class: 'thead c-nat' }, h('span', { text: '公用 IP' }), h('span'), h('span', { text: '內部 IP' }), h('span')));
  list.forEach((n, k) => card.append(h('div', { class: 'trow c-nat' },
    inp(ctx, ...bind(n, 'pub'), { ph: '203.0.113.11', check: isIp }), h('span', { class: 'muted', text: '↔' }),
    inp(ctx, ...bind(n, 'priv'), { ph: '192.168.10.11', check: isIp }),
    del(() => { list.splice(k, 1); ctx.commit(true); }))));
  card.append(h('div', { class: 'addrow' }, button('新增對應', { ic: 'plus', small: true, onclick: () => { list.push({ pub: '', priv: '' }); ctx.commit(true); } })),
    ctx.live(() => {
      const bad = list.find((n) => isIp(n.pub || '') && !dev.ifaces.some((i) => i.rt && i.rt.vips.length && i.rt.vips.some((v) => fmtIp(v) === n.pub.trim())));
      return bad ? note('warn', `${bad.pub} 不在任何介面的網段內，ISP 的封包送不到這台路由器。`) : null;
    }));
  return card;
}

// ───────────────────────── IPv6 ─────────────────────────

function v6Status(ctx, i) {
  return ctx.live(() => {
    const v = i.rt.v6;
    if (!v) return null;
    if (v.ll == null) return mode6(ctx.dev, i) === 'off' ? null : note('muted', '介面沒有連線，IPv6 尚未啟用。');
    return h('div', { class: 'kv ' + (v.addrs.length ? 'ok' : '') },
      v.addrs.map((a) => kv(a.src === 'slaac' ? '全域位址 (SLAAC)' : '全域位址', `${fmtIp6(a.ip)}/${a.bits}`)),
      kv('Link-local', fmtIp6(v.ll)),
      v.gw != null && kv('預設閘道', fmtIp6(v.gw)),
      v.note && kv('狀態', v.note));
  });
}

/** 終端設備的 IPv6 設定 */
export function hostV6(ctx, i) {
  if (!ctx.state.v6) return null;
  const m = mode6(ctx.dev, i);
  return h('div', { class: 'sub' }, h('span', { class: 'f-label', text: 'IPv6' }),
    seg(ctx, () => m, (v) => { i.mode6 = v; }, [['auto', '自動 (SLAAC)'], ['static', '手動'], ['off', '關閉']]),
    m === 'static' && grid2(
      field('IPv6 位址 / 前綴', inp(ctx, ...bind(i, 'ip6'), { ph: '2001:db8:a::10/64', check: isCidr6 })),
      field('IPv6 預設閘道', inp(ctx, ...bind(i, 'gw6'), { ph: '2001:db8:a::1', check: isIp6 }))),
    v6Status(ctx, i));
}

/** 路由器介面的 IPv6 設定 */
export function routerV6(ctx, i) {
  return h('div', { class: 'sub' }, h('span', { class: 'f-label', text: 'IPv6' }),
    field('IPv6 位址 / 前綴', inp(ctx, ...bind(i, 'ip6'), { ph: '例如 2001:db8:a::1/64', check: isCidr6 })),
    h('div', { class: 'toggles' }, toggle(ctx, ...bind(i, 'ra'), '發送 Router Advertisement（讓這個網段的設備用 SLAAC 自動取得位址）')),
    v6Status(ctx, i));
}

/** 路由分頁裡的 IPv6 區塊 */
export function v6Routes(ctx, body) {
  const { dev } = ctx;
  const list = (dev.routes6 ||= []);
  const card = h('div', { class: 'card' }, cardHead('IPv6'),
    h('div', { class: 'toggles' }, toggle(ctx, ...bind(dev, 'v6routing'), 'IPv6 路由（ipv6 unicast-routing）')),
    ctx.live(() => (dev.v6routing ? null : note('warn', '尚未啟用：這台路由器不會轉送 IPv6 封包，也不會送出 Router Advertisement。'))));
  if (list.length) card.append(h('div', { class: 'thead c-r6' }, h('span', { text: '目的前綴' }), h('span', { text: '下一站' }), h('span')));
  list.forEach((r, n) => card.append(h('div', { class: 'trow c-r6' },
    inp(ctx, ...bind(r, 'dst'), { ph: '2001:db8:2::/64', check: isCidr6 }),
    inp(ctx, ...bind(r, 'via'), { ph: '2001:db8:12::2', check: isIp6 }),
    del(() => { list.splice(n, 1); ctx.commit(true); }))));
  card.append(h('div', { class: 'addrow' }, button('新增 IPv6 靜態路由', { ic: 'plus', small: true, onclick: () => { list.push({ dst: '', via: '' }); ctx.commit(true); } })),
    ctx.live(() => {
      const rows = route6Rows(dev);
      if (!rows.length) return note('muted', 'IPv6 路由表是空的。');
      return h('div', { class: 'rtable' }, rows.map((r) => h('div', { class: 'rrow t-' + r.type + (r.bad ? ' bad' : '') },
        h('span', { class: 'tag', text: r.typeName }), h('b', { class: 'mono', text: r.dst }), h('span', { class: 'mono', text: '→ ' + r.via }),
        h('span', { class: 'mono muted', text: r.iface }), r.bad && h('em', { text: '無效：' + r.bad }))));
    }));
  body.append(card);
}

// ───────────────────────── 本機帳號與 SNMP ─────────────────────────

export const weakPass = (p) => p === 'admin' || p.length < 12 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p);

export function accountCard(ctx) {
  const m = ctx.dev.mgmt;
  return h('div', { class: 'card' }, cardHead('本機管理帳號'),
    grid2(
      field('帳號', inp(ctx, () => m.user ?? 'admin', (v) => { m.user = v; }, { mono: false })),
      field('密碼', inp(ctx, () => m.pass ?? 'admin', (v) => { m.pass = v; }))),
    ctx.live(() => {
      const p = m.pass ?? 'admin';
      if (p === 'admin') return note('warn', '還在使用出廠預設密碼。預設帳密是公開資訊，攻擊者第一個就會試。');
      if (weakPass(p)) return note('warn', '密碼太弱：至少要 12 個字元，並同時包含大寫、小寫字母與數字。');
      return note('ok', '密碼的長度與複雜度足夠。');
    }));
}

export function snmpFields(ctx) {
  const m = ctx.dev.mgmt;
  const ver = m.snmp || 'v2c';
  return [
    grid2(
      field('SNMP', sel(ctx, () => ver, (v) => { m.snmp = v; }, [['v2c', 'v2c（Community 明文）'], ['v3', 'v3（驗證加上加密）'], ['off', '關閉']], { rerender: true })),
      ver === 'v2c' && field('Community', inp(ctx, () => m.community ?? 'public', (v) => { m.community = v; }))),
    ver === 'v2c' && note('warn', 'SNMP v1 / v2c 的 Community 字串在網路上是明文，而且 public 是人人都知道的預設值。'),
  ];
}

// ───────────────────────── 連線紀錄、NAT 轉換、ARP 快取 ─────────────────────────

const svcOf = (e) => (e.proto === 'icmp' ? 'ICMP' : `${e.proto.toUpperCase()} ${e.dport}`);
const LOG_TAG = { allow: ['ok', '放行'], deny: ['bad', '拒絕'], snat: ['nat', 'NAT'], dnat: ['nat', '轉發'] };

function sessionRows(ctx) {
  const log = sessionLog(ctx.dev);
  if (!log.length) return [note('muted', '還沒有任何紀錄。執行測試或從終端機 ping 之後，經過這台設備的連線會列在這裡。')];
  return log.map((e) => {
    const [cls, tag] = LOG_TAG[e.act];
    const main = e.act === 'snat' ? `${fmtIp(e.src)} ⇒ ${fmtIp(e.nsrc)}`
      : e.act === 'dnat' ? `${fmtIp(e.dst)}:${e.dport} ⇒ ${fmtIp(e.ndst)}:${e.ndport}`
        : `${fmtIp(e.src)} → ${fmtIp(e.dst)}`;
    const sub = e.act === 'snat' ? `來源位址轉換 · 目的 ${fmtIp(e.dst)} · ${svcOf(e)}`
      : e.act === 'dnat' ? `目的位址轉換 · 來自 ${fmtIp(e.src)} · ${e.proto.toUpperCase()}`
        : `${svcOf(e)} · ${e.inIf} → ${e.outIf} · ${e.rule ? '政策 #' + e.rule : e.act === 'deny' ? '沒有符合的政策（隱含拒絕）' : '內建規則'}`;
    return h('div', { class: 'srow ' + cls }, h('span', { class: 'tag', text: tag }), h('b', { class: 'mono', text: main }), h('span', { class: 'mono muted', text: sub }));
  });
}

export function sessionCard(ctx, title = '連線紀錄與 NAT 轉換') {
  return h('div', { class: 'card' },
    cardHead(title, button('清除', { small: true, onclick: () => { clearSessionLog(ctx.dev); ctx.app.refreshLive(); } })),
    ctx.live(() => sessionRows(ctx)));
}

export function logTab(ctx, body) {
  body.append(
    h('p', { class: 'tip', text: '防火牆會記下每一條經過它的新連線：被哪一條政策放行或拒絕、有沒有做位址轉換。排查問題時先來這裡看：封包有沒有到、是被誰處理的。' }),
    sessionCard(ctx, '流量紀錄（最新的在上面）'));
}

export function arpCard(ctx) {
  return h('div', { class: 'card' }, cardHead('ARP 快取'), ctx.live(() => {
    const rows = arpRows(ctx.state, ctx.dev);
    if (!rows.length) return note('muted', 'ARP 快取是空的 — 要送出封包時才會廣播詢問下一站的 MAC 位址。');
    return rows.map((r) => h('div', { class: 'line' }, h('b', { class: 'mono', text: fmtIp(r.ip) }), h('span', { class: 'mono muted', text: r.mac })));
  }));
}
