// 無線控制器 (Catalyst 9800) 與輕量型 AP 的設定頁面。CCNA 只要求用圖形介面設定 WLC，這裡也一樣：CLI 只能看
import { h, button } from './dom.js';
import { inp, sel, toggle, field, note, kv, del, cardHead, grid2, bind, badge, isIp, isNum } from './form.js';
import { fmtIp, parseIp } from '../engine/ip.js';
import { ssidsOf, WIFI_SEC, CAPWAP_JOIN } from '../engine/sim.js';
import { radiusClientCard } from './panel-more.js';

const nameOf = (ctx, id) => (ctx.state.devices[id] || {}).name || id;
const lwaps = (state) => Object.values(state.devices).filter((d) => d.lwap);
const capRec = (state, ap) => ((state.dyn && state.dyn.capwap) || {})[ap.id] || {};
/** 這台 WLC 底下的用戶端：Local 模式掛在 WLC 上，FlexConnect 掛在 AP 上 */
function wlcClients(state, wlc) {
  const out = (state.rt.clients[wlc.id] || []).map((c) => ({ ...c, apId: c.ap }));
  for (const ap of lwaps(state)) if (ap.rt.capwap && ap.rt.capwap.wlc === wlc.id) for (const c of state.rt.clients[ap.id] || []) out.push({ ...c, apId: ap.id });
  return out;
}
const MODE = [['local', 'Local（流量經 CAPWAP 回到控制器）'], ['flex', 'FlexConnect（在 AP 就地放進 VLAN）']];

// ───────────────────────── WLC：WLAN ─────────────────────────

export function wlanTab(ctx, body) {
  const { dev, state } = ctx;
  const list = dev.wlc.wlans;
  body.append(h('p', { class: 'tip', text: 'WLAN 設定在控制器上，加入這台 WLC 的輕量型 AP 會自動放送。Local 模式的 AP 把用戶端的流量包在 CAPWAP 裡送回控制器，再從控制器的 Trunk 放進 WLAN 對應的 VLAN — 所以控制器接交換器的 Trunk 要允許這些 VLAN。' }));
  list.forEach((w, n) => {
    const clients = () => wlcClients(state, dev).filter((c) => c.iface.rt.assoc && c.iface.rt.assoc.ssid === w.ssid);
    body.append(h('div', { class: 'card' },
      cardHead(`WLAN ${w.id}`, ctx.live(() => badge(w.on === false ? 'off' : 'on', w.on === false ? '已停用' : `${clients().length} 台已連線`)), del(() => { list.splice(n, 1); ctx.commit(true); })),
      grid2(
        field('SSID', inp(ctx, ...bind(w, 'ssid'), { mono: false, ph: '例如 Corp' })),
        field('加密方式', sel(ctx, () => w.sec || 'wpa2', (v) => { w.sec = v; }, Object.entries(WIFI_SEC), { rerender: true })),
        w.sec !== 'open' && w.sec !== 'wpa2ent' && field('密碼 (PSK)', inp(ctx, ...bind(w, 'pass'), { ph: '至少 8 個字元', check: (v) => v.length >= 8 })),
        field('VLAN', inp(ctx, ...bind(w, 'vlan'), { ph: 'Local 模式：控制器上的 VLAN', check: isNum(1, 4094) }))),
      h('div', { class: 'toggles' },
        toggle(ctx, () => w.on !== false, (v) => { if (v) delete w.on; else w.on = false; }, '啟用這個 WLAN'),
        toggle(ctx, ...bind(w, 'isolate'), '用戶端隔離 (Peer-to-Peer Blocking)'),
        toggle(ctx, ...bind(w, 'kv'), '802.11k/v：提供鄰近 AP 的清單、建議用戶端換到訊號更好的 AP（改善 sticky client）'),
        toggle(ctx, ...bind(w, 'ft'), '802.11r（Fast Transition）：漫遊時沿用金鑰，不用重新做完整的驗證')),
      w.sec === 'wpa2ent' && note('muted', 'WPA2-Enterprise：由控制器去問 RADIUS（「管理介面」分頁設定 RADIUS 伺服器）。'),
      ctx.live(() => {
        const bad = clients().find((c) => c.iface.rt.ip == null);
        return bad ? note('warn', `${nameOf(ctx, bad.dev)} 連上了 WLAN，但沒有拿到 IP：${bad.iface.rt.note || 'DHCP 沒有回應'}。Local 模式的流量從控制器出去，先確認控制器的 Trunk 允許 VLAN ${w.vlan || 1}。`) : null;
      })));
  });
  body.append(h('div', { class: 'addrow' }, button('新增 WLAN', {
    ic: 'plus', kind: 'primary', small: true,
    onclick: () => { list.push({ id: list.reduce((m, x) => Math.max(m, x.id), 0) + 1, ssid: '', sec: 'wpa2', pass: '', vlan: '' }); ctx.commit(true); },
  })));
}

// ───────────────────────── WLC：AP ─────────────────────────

export function apsTab(ctx, body) {
  const { dev, state } = ctx;
  const aps = lwaps(state);
  body.append(h('p', { class: 'tip', text: '輕量型 AP 開機拿到 IP 之後，依序用三種方法找控制器：AP 上手動指定的主要控制器、DHCP 的 option 43、同一個網段的廣播。找到之後用 CAPWAP（UDP 5246）加入，大約半分鐘。' }));
  if (!aps.length) { body.append(note('muted', '網路上沒有輕量型 AP。')); return; }
  body.append(h('div', { class: 'card' }, cardHead('AP'), ctx.live(() => aps.map((ap) => {
    const rec = capRec(state, ap), c = ap.rt.capwap || {}, mine = rec.wlc === dev.id;
    const st = rec.joined && mine ? badge('on', '已加入') : mine ? badge('warn', '加入中') : badge('off', '未加入');
    const n = c.joined && c.wlc === dev.id ? (c.mode === 'local' ? (state.rt.clients[dev.id] || []).filter((x) => x.ap === ap.id).length : (state.rt.clients[ap.id] || []).length) : 0;
    return h('div', { class: 'qos-pm' },
      h('div', { class: 'line' }, h('b', { text: ap.name }), h('span', { class: 'mono muted', text: ap.ifaces[0].rt.ip != null ? fmtIp(ap.ifaces[0].rt.ip) : '沒有 IP' }), h('span', { style: { marginLeft: 'auto' } }, st)),
      rec.joined && mine ? h('div', { class: 'kv ok' }, kv('找到控制器的方式', rec.how || '—'), kv('模式', ap.lwap.mode === 'flex' ? 'FlexConnect' : 'Local'),
        ap.rt.rrm && kv('頻道（RRM 自動指定）', `2.4 GHz：${ap.rt.rrm.ch24}　5 GHz：${ap.rt.rrm.ch5}`), kv('用戶端', `${n} 台`))
        : note(mine ? 'muted' : 'warn', rec.why || c.why || '還沒有加入'));
  }))));
}

// ───────────────────────── WLC：用戶端 ─────────────────────────

export function wlcClientsTab(ctx, body) {
  const { dev, state } = ctx;
  body.append(h('div', { class: 'card' }, cardHead('無線用戶端'), ctx.live(() => {
    const list = wlcClients(state, dev);
    if (!list.length) return note('muted', '目前沒有任何用戶端。');
    return list.map((c) => {
      const a = c.iface.rt.assoc;
      return h('div', { class: 'line' }, h('b', { text: nameOf(ctx, c.dev) }),
        h('span', { class: 'mono muted', text: `${a.ssid} · ${nameOf(ctx, c.apId)} · ${a.band} ${a.rssi} dBm · ${c.iface.rt.ip != null ? fmtIp(c.iface.rt.ip) : '沒有 IP'}` }));
    });
  })));
}

// ───────────────────────── WLC：管理介面 ─────────────────────────

export function wmiTab(ctx, body) {
  const { dev } = ctx;
  const i = dev.ifaces[0];
  body.append(h('div', { class: 'card' }, cardHead('無線管理介面 (WMI)'),
    note('muted', 'AP 用 CAPWAP 連到這個位址，管理者也從這裡登入控制器。它是控制器上的一個 SVI，所在的 VLAN 要在上行的 Trunk 裡。'),
    grid2(
      field('VLAN', inp(ctx, () => String(i.bind.vlan), (v) => { if (+v >= 1 && +v <= 4094) i.bind.vlan = +v; }, { check: isNum(1, 4094) })),
      field('IP 位址', inp(ctx, ...bind(i, 'ip'), { ph: '例如 10.10.10.5', check: isIp })),
      field('子網路遮罩', inp(ctx, ...bind(i, 'mask'), { ph: '255.255.255.0' })),
      field('預設閘道', inp(ctx, ...bind(i, 'gateway'), { ph: '例如 10.10.10.1', check: isIp }))),
    ctx.live(() => (i.rt.ip != null ? h('div', { class: 'kv ok' }, kv('目前的位址', `${fmtIp(i.rt.ip)}/${i.rt.bits}`), kv('VLAN', String(i.bind.vlan))) : note('warn', '還沒有 IP 位址：AP 找不到控制器。')))),
  h('div', { class: 'card' }, cardHead('控制器上的 VLAN'), note('muted', '依無線管理介面與各 WLAN 的 VLAN 自動建立。'),
    ctx.live(() => h('div', { class: 'line' }, h('span', { class: 'mono', text: dev.sw.vlans.map((v) => v.id).sort((a, b) => a - b).join('、') })))));
  if (dev.wlc.wlans.some((w) => w.sec === 'wpa2ent')) body.append(radiusClientCard(ctx));
}

// ───────────────────────── 輕量型 AP ─────────────────────────

export function lwapTab(ctx, body) {
  const { dev, state } = ctx;
  const L = dev.lwap;
  body.append(h('div', { class: 'card' }, cardHead('無線控制器', ctx.live(() => {
    const c = dev.rt.capwap || {};
    return c.joined ? badge('on', '已加入') : c.standalone ? badge('warn', 'Standalone') : badge('off', '未加入');
  })),
  ctx.live(() => {
    const c = dev.rt.capwap || {}, rec = capRec(state, dev);
    if (state.rt.off[dev.id]) return note('warn', '沒有電：輕量型 AP 要接在有 PoE 的連接埠上（9120 需要 802.3at）。');
    if (c.joined) return note('ok', `已加入 ${nameOf(ctx, c.wlc)}（${rec.how || ''}），WLAN 由控制器下發。`);
    if (c.standalone) return note('warn', `和控制器失去聯絡：FlexConnect 的 AP 進入 standalone 模式，本地交換、預先共用金鑰的 WLAN 照樣服務（${c.why}）。`);
    return note('warn', c.why || rec.why || `還沒有加入控制器（找到之後大約 ${CAPWAP_JOIN} 秒）。`);
  }),
  grid2(
    field('模式', sel(ctx, () => L.mode || 'local', (v) => { L.mode = v; }, MODE, { rerender: true })),
    field('主要控制器（選填）', inp(ctx, ...bind(L, 'primary'), { ph: '留空＝用 option 43 或廣播找', check: (v) => parseIp(v) != null }))),
  note('muted', L.mode === 'flex'
    ? 'FlexConnect：用戶端的流量在 AP 的交換器埠就地放進 WLAN 的 VLAN，所以 AP 接的埠要是 Trunk（Native VLAN 是 AP 自己的管理 VLAN）。控制器斷線時，本地交換的 WLAN 照樣服務。'
    : 'Local：所有用戶端的流量都包在 CAPWAP 裡送回控制器，AP 接的埠是一般的 Access 埠。控制器斷線，用戶端也跟著斷線。')),
  h('div', { class: 'card' }, cardHead('無線電'),
    grid2(field('發射功率', sel(ctx, ...bind(dev.wifi, 'power'), [['low', '低'], ['mid', '中'], ['high', '高']]))),
    ctx.live(() => (dev.rt.rrm ? h('div', { class: 'kv ok' }, kv('2.4 GHz 頻道', `${dev.rt.rrm.ch24}（RRM 自動指定）`), kv('5 GHz 頻道', `${dev.rt.rrm.ch5}（RRM 自動指定）`))
      : note('muted', '頻道由控制器的 RRM（Radio Resource Management）自動指定：加入控制器之後才會開始放送。'))),
    ctx.live(() => (dev.rt.interf.length ? dev.rt.interf.map((x) => note('warn', `和 ${nameOf(ctx, x.dev)} 在 ${x.band} 同頻道`)) : null))),
  h('div', { class: 'card' }, cardHead('放送中的 WLAN'), ctx.live(() => {
    const ss = ssidsOf(state, dev);
    if (!ss.length) return note('muted', '沒有：輕量型 AP 自己沒有 SSID 設定，要加入控制器之後才會開始放送。');
    const local = dev.rt.capwap && dev.rt.capwap.joined && dev.rt.capwap.mode === 'local';
    const clients = local ? (state.rt.clients[dev.rt.capwap.wlc] || []).filter((c) => c.ap === dev.id) : state.rt.clients[dev.id] || [];
    return [...ss.map((x) => h('div', { class: 'line' }, h('b', { text: x.name }), h('span', { class: 'mono muted', text: `${WIFI_SEC[x.sec] || x.sec}${x.vlan ? ' · VLAN ' + x.vlan : ''}` }))),
      ...clients.map((c) => h('div', { class: 'line' }, h('span', { text: '　' + nameOf(ctx, c.dev) }), h('span', { class: 'mono muted', text: `${c.iface.rt.assoc.band} ${c.iface.rt.assoc.rssi} dBm` })))];
  })));
}
