// 設定頁面（續）：RADIUS / 802.1X、靜態 NAT、IPv6、本機帳號與 SNMP
import { h, button } from './dom.js';
import { sessionLog, clearSessionLog, arpRows, sessionRows, clearSessions, fmtDur } from '../engine/sim.js';
import { syslogRows, clearSyslog, SIM_EPOCH } from '../engine/ops.js';
import { inp, sel, toggle, field, note, kv, del, cardHead, grid2, bind, isIp } from './form.js';
import { fmtIp } from '../engine/ip.js';

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

// 介面、路由、DHCPv6 位址池、IPv6 ACL 的頁面在 panel-v6.js
export { hostV6, routerV6, v6Routes, dhcp6PoolsCard, acl6Cards } from './panel-v6.js';

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
  const ver = m.snmp || 'off';
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

function historyRows(ctx) {
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
    ctx.live(() => historyRows(ctx)));
}

const ST_NAME = { syn: '交握中', est: '已建立', fin: '關閉中' };

/** 目前還留在表裡的連線：每一筆都在倒數，閒置太久就會被移除 */
export function sessionTableCard(ctx, title = '連線表（NAT 轉換）') {
  const { dev, state } = ctx;
  return h('div', { class: 'card' },
    cardHead(title, button('清除', { small: true, onclick: () => { clearSessions(state, dev); ctx.app.refreshLive(); } })),
    ctx.live(() => {
      const rows = sessionRows(state, dev);
      if (!rows.length) return note('muted', '目前沒有任何連線。經過這台設備的連線會記在這裡，閒置太久就會被移除：ICMP 大約一分鐘、UDP 幾分鐘、TCP 關閉之後一兩分鐘。');
      return rows.slice(0, 30).map((e) => {
        const snat = e.nSrc !== e.src, dnat = e.nDst !== e.dst;
        const sub = [e.proto === 'tcp' ? ST_NAME[e.st] || '' : '', snat && `來源換成 ${fmtIp(e.nSrc)}`, dnat && `目的換成 ${fmtIp(e.nDst)}:${e.nDport}`,
          e.rule ? `政策 #${e.rule}` : '', `剩 ${fmtDur(e.left)}`].filter(Boolean).join(' · ');
        return h('div', { class: 'srow nat' }, h('span', { class: 'tag', text: e.proto.toUpperCase() }),
          h('b', { class: 'mono', text: `${fmtIp(e.src)}${e.proto === 'icmp' ? '' : ':' + e.sport} → ${fmtIp(e.dst)}${e.proto === 'icmp' ? '' : ':' + e.dport}` }),
          h('span', { class: 'mono muted', text: sub }));
      });
    }));
}

export function logTab(ctx, body) {
  body.append(
    h('p', { class: 'tip', text: '防火牆會記下每一條經過它的新連線：被哪一條政策放行或拒絕、有沒有做位址轉換。排查問題時先來這裡看：封包有沒有到、是被誰處理的。' }),
    sessionTableCard(ctx, '目前的連線 (session table)'),
    sessionCard(ctx, '流量紀錄（最新的在上面）'));
}

// ───────────────────────── Syslog 伺服器 ─────────────────────────

const SEV_NAME = ['緊急', '警報', '嚴重', '錯誤', '警告', '注意', '資訊', '除錯'];
const two = (n) => String(n).padStart(2, '0');

/** 收集各設備送來的紀錄（UDP 514）。時間是伺服器收到的時間，不是設備自己寫的時間 */
export function syslogTab(ctx, body) {
  const { dev, state } = ctx;
  body.append(h('p', { class: 'tip', text: '各設備把自己的紀錄送到這裡集中保存，設備重開機之後紀錄也還在。左邊的時間是這台伺服器收到的時間；訊息裡的時間是設備自己寫的 — 設備沒有對時的話，兩邊會對不起來。' }));
  body.append(h('div', { class: 'card' },
    cardHead('收到的訊息 · UDP 514', button('清除', { small: true, onclick: () => { clearSyslog(state, dev); ctx.app.refreshLive(); } })),
    ctx.live(() => {
      const rows = syslogRows(state, dev);
      if (!rows.length) return note('muted', '還沒有收到任何訊息。設備要把 Syslog 伺服器指向這台主機的 IP，而且兩邊要連得通；之後介面上線、斷線等事件就會出現在這裡。');
      return h('div', { class: 'logbox tall' }, rows.slice(-80).reverse().map((r) => {
        const x = new Date(SIM_EPOCH + r.t * 1000 + 8 * 3600000);
        const from = state.devices[r.dev];
        return h('div', { class: 'll s' + r.sev },
          h('span', { class: 'lt', text: `${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())}  ${r.ip}${from ? ` (${from.name})` : ''}  ${SEV_NAME[r.sev] || ''}` }),
          h('span', { text: r.line.replace(/^<\d+>(\d+: )?/, '') }));
      }));
    })));
}

export function arpCard(ctx) {
  return h('div', { class: 'card' }, cardHead('ARP 快取'), ctx.live(() => {
    const rows = arpRows(ctx.state, ctx.dev);
    if (!rows.length) return note('muted', 'ARP 快取是空的 — 要送出封包時才會廣播詢問下一站的 MAC 位址。');
    return rows.map((r) => h('div', { class: 'line' }, h('b', { class: 'mono', text: fmtIp(r.ip) }), h('span', { class: 'mono muted', text: `${r.mac} · ${r.age} 秒前` })));
  }));
}
