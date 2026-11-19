// 進階功能的設定頁面：Wi-Fi、VPN、ACL、L2 安全、STP / LACP、管理加固、DHCP 範圍
import { h, icon, button, toast } from './dom.js';
import {
  inp, sel, toggle, field, note, kv, del, cardHead, badge, grid2, bind, linkBadge, ifaceNote,
  isIp, isMask, isIpList, isAddr, isCidrList, isMacList, isPortNo, isNum,
} from './form.js';
import { fmtIp } from '../engine/ip.js';
import { CATALOG, peerOf, portOf, newSsid, cableAt, linkInfo } from '../engine/model.js';
import { visibleSsids, WIFI_SEC, macsBehind, isBridgePort, hitsOf, P1, accessOf, portfastOn, macRows, clearMac, macAgeOf, saInfo, fmtDur } from '../engine/sim.js';
import { ntpInfo, deviceTime, plainStamp, logRows, clearLog, syslogStats, NTP_POLL } from '../engine/ops.js';
import * as M from './panel-more.js';
import * as OPS from './panel-ops.js';

const nameOf = (ctx, id) => ctx.state.devices[id]?.name || id;
const DH_GROUPS = [['2', 'DH 2（1024-bit）'], ['5', 'DH 5（1536-bit）'], ['14', 'DH 14（2048-bit）'], ['19', 'DH 19（ECP-256）']];

// ───────────────────────── Wi-Fi 用戶端 ─────────────────────────

export const assocBadge = (ctx, i) => ctx.live(() => {
  const a = i.rt.assoc;
  return a ? badge('on', `已連線 · ${nameOf(ctx, a.ap)}`) : badge('off', '未連線');
});

/** 訊號強度、頻段與連線速率 */
export const wifiSignal = (ctx, i) => ctx.live(() => {
  const a = i.rt.assoc;
  if (!a) return null;
  const bars = a.rssi >= -52 ? 4 : a.rssi >= -62 ? 3 : a.rssi >= -72 ? 2 : 1;
  return [
    h('div', { class: 'sigline', title: '訊號強度依距離與基地台的發射功率估算' },
      h('span', { class: 'sigbars' }, [1, 2, 3, 4].map((n) => h('i', { class: n <= bars ? 'on' : '', style: { height: 2 + n * 2.75 + 'px' } }))),
      h('span', { class: 'mono', text: `${a.band} · 頻道 ${a.ch} · ${a.rssi} dBm · ${a.rate} Mbps` })),
    bars === 1 && note('warn', '訊號很弱：離基地台太遠，速率很低也容易斷線。把基地台移近，或調高它的發射功率。'),
    a.noisy && note('warn', `基地台在 ${a.band} 與鄰近基地台的頻道重疊，速率只剩一半。`),
  ];
});

/** 政策或 ACL 規則被命中的次數 */
export const hitBadge = (ctx, rule) => ctx.live(() => {
  const n = hitsOf(rule);
  return h('span', { class: 'hits' + (n ? ' hot' : ''), title: '這條規則被比對命中的次數（執行測試或 ping 之後會增加）', text: `命中 ${n}` });
});

/** 兩端設定不一致時的提醒（真實設備上會看到 CDP 的 native VLAN mismatch 之類的訊息） */
export const portWarn = (ctx, p, pc) => ctx.live(() => {
  const { state, dev } = ctx;
  const n = peerOf(state, dev.id, p.id);
  if (!n) return null;
  const peer = state.devices[n.dev];
  const qc = peer.sw && peer.sw.mode === 'vlan' && peer.sw.ports[n.port];
  const there = `${peer.name} 的 ${portOf(peer, n.port).label}`;
  const cap = (m) => (m === 'trunk' ? 'Trunk' : 'Access');
  const out = [];
  if (qc && qc.mode !== 'routed') {
    if (pc.mode !== qc.mode) out.push(`兩端模式不一致：這一端是 ${cap(pc.mode)}，${there} 是 ${cap(qc.mode)}，帶標籤的 VLAN 過不去。`);
    else if (pc.mode === 'trunk' && pc.native !== qc.native) out.push(`Native VLAN 不一致：這一端是 ${pc.native}，${there} 是 ${qc.native}。沒有標籤的訊框會被兩端放進不同的 VLAN。`);
    else if (pc.mode === 'access' && pc.vlan !== qc.vlan) out.push(`兩端的 Access VLAN 不同（這一端 ${pc.vlan}，${there} 是 ${qc.vlan}），兩個 VLAN 會被這條線接在一起。`);
  }
  out.push(...phyWarnings(state, dev, p.id));
  const left = dev.rt.wait && dev.rt.wait[p.id];
  if (left > 0) {
    out.push(qc ? `STP 正在和 ${peer.name} 協商，再 ${Math.ceil(left)} 秒開始轉送。`
      : `這個埠剛啟用，STP 還在 ${left > 15 ? 'listening' : 'learning'}，再 ${Math.ceil(left)} 秒才會開始轉送資料。接電腦或伺服器的埠可以在進階設定打開 PortFast。`);
  }
  return out.map((t) => note('warn', t));
});

/** OSPF 鄰居的狀態 */
export function nbrBadge(x) {
  if (x.state === 'forming') return badge('warn', `建立中 · 再 ${Math.ceil(x.left)} 秒`);
  if (x.state === 'dying') return badge('warn', `沒有回應 · ${Math.ceil(x.left)} 秒後移除`);
  return badge('on', 'FULL');
}

/** 實體層協商的問題：速率不合、雙工不一致、半雙工 */
function phyWarnings(state, dev, pid) {
  const li = linkInfo(state, dev.id, pid);
  if (!li) return [];
  if (li.down) return [li.down + '。'];
  if (li.mismatch) return [`雙工不一致 (duplex mismatch)：這一端是${li.duplex === 'full' ? '全' : '半'}雙工、對端是${li.peerDuplex === 'full' ? '全' : '半'}雙工。線是通的，但會有大量碰撞與 CRC 錯誤，實際速度極慢 — 一端寫死、另一端自動協商時最常發生。`];
  if (li.half) return [`這條線是 ${li.speed} Mbps 半雙工：同一時間只能有一端傳送，多台設備同時傳送會發生碰撞。`];
  return [];
}
export const phyNote = (ctx, pid) => ctx.live(() => phyWarnings(ctx.state, ctx.dev, pid).map((t) => note('warn', t)));

const SPEEDS = [['', '自動協商'], ['10', '10 Mbps'], ['100', '100 Mbps'], ['1000', '1 Gbps']];
const DUPLEX = [['', '自動協商'], ['full', '全雙工'], ['half', '半雙工']];
/** 速率與雙工的設定（只有銅纜的埠可以手動指定） */
export const phyFields = (ctx, c) => grid2(
  field('速率', sel(ctx, () => (c.speed && c.speed !== 'auto' ? String(c.speed) : ''), (v) => { c.speed = v; }, SPEEDS)),
  field('雙工', sel(ctx, () => (c.duplex && c.duplex !== 'auto' ? c.duplex : ''), (v) => { c.duplex = v; }, DUPLEX)));

/** FortiGate 每個介面各自決定開放哪些管理協定 (allowaccess) */
export function accessRow(ctx, i) {
  const { dev } = ctx;
  const cur = accessOf(dev, i);
  const all = [['ping', 'PING'], ['https', 'HTTPS'], ['ssh', 'SSH'], ['http', 'HTTP'], ['telnet', 'TELNET']];
  const flip = (k) => {
    i.access = all.map((x) => x[0]).filter((x) => (x === k ? !cur.includes(k) : cur.includes(x)));
    i.ping = i.access.includes('ping');
    ctx.commit(true);
  };
  return h('div', { class: 'sub' },
    h('span', { class: 'f-label', text: '管理存取 (allowaccess)：從這個介面可以用哪些方式連到防火牆本身' }),
    h('div', { class: 'chips' }, all.map(([k, t]) => h('button', { type: 'button', class: 'chip btnchip acc' + (cur.includes(k) ? ' on' : ''), text: t, onclick: () => flip(k) }))),
    (cur.includes('http') || cur.includes('telnet')) && note('warn', 'HTTP 與 Telnet 是明文協定，帳號密碼會被看光，不應該開放。'),
    /^wan/.test(i.id) && cur.some((k) => k !== 'ping') && note('warn', '對外的介面開放了管理協定，任何人都能從網際網路嘗試登入。'));
}

export function wifiPicker(ctx, i) {
  const nets = visibleSsids(ctx.state, ctx.dev);
  const w = i.wifi;
  const opts = [['', '（不連線）'], ...nets.map((n) => [n.name, `${n.name} · ${n.sec === 'open' ? '開放' : WIFI_SEC[n.sec]} · 訊號 ${'●'.repeat(n.bars)}${'○'.repeat(3 - n.bars)}`])];
  if (w.ssid && !nets.some((n) => n.name === w.ssid)) opts.push([w.ssid, `${w.ssid} · 目前收不到訊號`]);
  const ent = (nets.find((n) => n.name === w.ssid) || {}).sec === 'wpa2ent';
  return [
    !nets.length && note('muted', '附近沒有偵測到任何無線網路。'),
    ent
      ? [field('無線網路 (SSID)', sel(ctx, ...bind(w, 'ssid'), opts, { rerender: true })),
        grid2(field('帳號', inp(ctx, ...bind(w, 'user'), { ph: '個人帳號', mono: false })), field('密碼', inp(ctx, ...bind(w, 'pass'), { ph: '個人密碼' }))),
        note('muted', '這個網路使用 802.1X：每個人用自己的帳號登入，由 RADIUS 伺服器驗證。')]
      : grid2(
        field('無線網路 (SSID)', sel(ctx, ...bind(w, 'ssid'), opts, { rerender: true })),
        field('密碼', inp(ctx, ...bind(w, 'pass'), { ph: '開放網路可留空' }))),
  ];
}

/** 不屬於玩家的設備：只能看，不能改 */
export function lockedInfo(ctx, body) {
  const { dev, state } = ctx;
  body.append(note('warn', '這不是你管理的設備，無法變更它的設定。你能做的是在自己的設備上防堵它。'));
  for (const i of dev.ifaces) {
    const wl = i.bind.t === 'wlan';
    if (!wl && i.bind.t !== 'port' && i.bind.t !== 'bridge') continue;
    body.append(h('div', { class: 'card' },
      cardHead(i.label, wl ? assocBadge(ctx, i) : i.bind.t === 'port' ? linkBadge(ctx, i.bind.port) : null),
      ctx.live(() => h('div', { class: 'kv' },
        kv('IP 位址', i.rt.ip != null ? `${fmtIp(i.rt.ip)} / ${i.rt.bits}` : '—'),
        kv('MAC 位址', i.rt.mac),
        wl && kv('無線網路', i.wifi.ssid || '—'),
        i.dhcp && i.dhcp.on && kv('DHCP 伺服器', `${i.dhcp.start} – ${i.dhcp.end}`),
        i.rt.note && kv('狀態', i.rt.note)))));
  }
  if (dev.wifi && dev.wifi.ssids.length) {
    body.append(h('div', { class: 'card' }, cardHead('廣播中的無線網路'),
      dev.wifi.ssids.map((s) => h('div', { class: 'line' }, h('b', { text: s.name }), h('span', { class: 'mono muted', text: WIFI_SEC[s.sec || 'open'] })))));
  }
  void state;
}

// ───────────────────────── 基地台 / 家用路由器的無線設定 ─────────────────────────

function clientsCard(ctx) {
  const { dev, state } = ctx;
  return h('div', { class: 'card' }, cardHead('已連線的無線設備'), ctx.live(() => {
    const list = state.rt.clients[dev.id] || [];
    if (!list.length) return note('muted', '目前沒有任何設備連上來。');
    return list.map((c) => h('div', { class: 'line' }, h('b', { text: nameOf(ctx, c.dev) }),
      h('span', { class: 'mono muted', text: `${dev.wifi.ssids[c.iface.rt.assoc.idx]?.name || ''}${c.iface.rt.ip != null ? ' · ' + fmtIp(c.iface.rt.ip) : ''} · ${c.iface.rt.assoc.band} ${c.iface.rt.assoc.rssi} dBm` })));
  }));
}

export function radioCard(ctx) {
  const w = ctx.dev.wifi;
  return h('div', { class: 'card' }, cardHead('無線電'),
    grid2(
      field('2.4GHz 頻道', sel(ctx, ...bind(w, 'ch24', Number), Array.from({ length: 11 }, (_, n) => [n + 1, `頻道 ${n + 1}${[1, 6, 11].includes(n + 1) ? '（不重疊）' : ''}`]))),
      field('5GHz 頻道', sel(ctx, ...bind(w, 'ch5', Number), [36, 40, 44, 48, 149, 153, 157, 161].map((c) => [c, `頻道 ${c}`]))),
      field('發射功率', sel(ctx, ...bind(w, 'power'), [['low', '低（涵蓋範圍小）'], ['mid', '中'], ['high', '高（涵蓋範圍大）']]))),
    ctx.live(() => {
      const list = ctx.dev.rt.interf;
      if (!list.length) return note('ok', '沒有偵測到與其他基地台的頻道干擾');
      return list.map((x) => note('warn', `與 ${nameOf(ctx, x.dev)} 在 ${x.band} 的頻道重疊，會互相干擾`));
    }));
}

export function ssidTab(ctx, body) {
  const { dev, state } = ctx;
  const w = dev.wifi;
  if (state.rt.off[dev.id]) body.append(note('warn', '這台基地台沒有電。它沒有變壓器，必須接在交換器有 PoE 供電的連接埠上。'));
  if (!w.ssids.length) body.append(note('muted', '還沒有任何無線網路。新增一個 SSID，用戶端才看得到這台基地台。'));
  w.ssids.forEach((s, n) => {
    body.append(h('div', { class: 'card' },
      cardHead(`SSID ${n + 1}`,
        ctx.live(() => {
          const c = (state.rt.clients[dev.id] || []).filter((x) => x.iface.rt.assoc.idx === n).length;
          return badge(c ? 'on' : 'off', `${c} 台已連線`);
        }),
        del(() => { w.ssids.splice(n, 1); ctx.commit(true); })),
      grid2(
        field('名稱 (SSID)', inp(ctx, ...bind(s, 'name'), { mono: false, ph: '例如 Office' })),
        field('加密方式', sel(ctx, () => s.sec || 'open', (v) => { s.sec = v; }, Object.entries(WIFI_SEC), { rerender: true })),
        s.sec && s.sec !== 'open' && s.sec !== 'wpa2ent' && field('密碼', inp(ctx, ...bind(s, 'pass'), { ph: '至少 8 個字元', check: (v) => v.length >= 8 })),
        dev.kind === 'ap' && field('對應的 VLAN', inp(ctx, ...bind(s, 'vlan'), { ph: '留空＝不貼標籤', check: isNum(1, 4094) }))),
      h('div', { class: 'toggles' }, toggle(ctx, ...bind(s, 'isolate'), '用戶端隔離（連上這個 SSID 的設備彼此不能互連）')),
      (!s.sec || s.sec === 'open') && note('warn', '開放網路沒有任何加密，任何人都能連線，也能側錄別人的流量。'),
      s.sec === 'wep' && note('warn', 'WEP 的加密早已被破解，幾分鐘內就能算出密碼，不應該再使用。'),
      s.sec === 'wpa3' && note('muted', '純 WPA3 最安全，但比較舊的設備可能不支援。'),
      s.sec === 'wpa2ent' && note('muted', 'WPA2-Enterprise 沒有共用密碼，每個人用自己的帳號登入。請在下方設定 RADIUS 伺服器。'),
      +s.vlan > 0 && note('muted', `這個 SSID 的流量會貼上 VLAN ${s.vlan} 的標籤，交換器接 AP 的埠必須是 Trunk。`)));
  });
  if (w.ssids.length < 4) {
    body.append(h('div', { class: 'addrow' }, button('新增 SSID', {
      ic: 'plus', kind: 'primary', small: true, onclick: () => { w.ssids.push(newSsid({ sec: 'wpa2wpa3' })); ctx.commit(true); },
    })));
  }
  if (w.ssids.some((s) => s.sec === 'wpa2ent')) body.append(M.radiusClientCard(ctx));
  if (dev.kind === 'homerouter') body.append(radioCard(ctx));
  body.append(clientsCard(ctx));
}

export function radioTab(ctx, body) {
  const { dev, state } = ctx;
  body.append(h('div', { class: 'card' }, cardHead('供電與上行', linkBadge(ctx, dev.ports[0].id)), ctx.live(() =>
    state.rt.off[dev.id]
      ? note('warn', cableAt(state, dev.id, dev.ports[0].id) ? '沒有電：對面的連接埠不提供 PoE，或已被停用。' : '沒有電：還沒有接上網路線。')
      : note('ok', 'PoE 供電正常 (802.3af)'))),
  radioCard(ctx), clientsCard(ctx),
  h('p', { class: 'tip', text: '選取基地台時，場景中的圓圈就是它的訊號涵蓋範圍。兩台基地台的範圍有重疊，頻道就必須錯開。' }));
}

// ───────────────────────── 交換器：連接埠進階設定 ─────────────────────────

const STP_ROLE = { root: 'Root Port', desg: 'Designated', altn: 'Blocking（備援，已封鎖）' };

export function portAdvanced(ctx, p, pc) {
  const { dev, state } = ctx;
  const ps = (pc.ps ||= { on: false, macs: '', mode: 'restrict' });
  if (pc.lag == null) pc.lag = '';
  if (!pc.lagMode) pc.lagMode = 'active';
  const macInp = inp(ctx, ...bind(ps, 'macs'), { ph: '例如 02:1a:2b:3c:4d:5e', check: isMacList });
  return h('div', { class: 'sub' },
    h('div', { class: 'toggles' },
      toggle(ctx, ...bind(pc, 'shut'), '停用此連接埠 (shutdown)'),
      toggle(ctx, ...bind(pc, 'trust'), 'DHCP Snooping 信任埠（通往合法 DHCP 伺服器）'),
      toggle(ctx, () => portfastOn(dev, pc), (v) => { pc.portfast = v; }, 'PortFast（接終端設備的埠：連線後立刻轉送，不等 30 秒）'),
      toggle(ctx, ...bind(pc, 'bpduguard'), 'BPDU Guard（對面是交換器就關閉此埠）'),
      toggle(ctx, ...bind(pc, 'rootguard'), 'Root Guard（不允許這個埠後面的交換器成為根橋）'),
      toggle(ctx, ...bind(pc, 'dot1x'), '802.1X（通過 RADIUS 驗證才放行）'),
      toggle(ctx, ...bind(ps, 'on'), 'Port Security（只接受指定的 MAC 位址）', { rerender: true })),
    ctx.live(() => [
      dev.rt.err[p.id] === 'bpdu' && note('warn', 'err-disabled：BPDU Guard 偵測到對面是一台交換器，這個埠已經被關閉。'),
      dev.rt.err[p.id] === 'root' && note('warn', 'root-inconsistent：對面的交換器宣稱自己是更優先的根橋，Root Guard 把這個埠擋下了。對方不再搶根橋之後會自動恢復。'),
      pc.dot1x && (dev.rt.unauth && dev.rt.unauth[p.id] ? note('warn', '802.1X 尚未通過：' + dev.rt.unauth[p.id]) : note('ok', '802.1X 驗證通過，連接埠已放行。')),
    ]),
    ps.on && field('允許的 MAC 位址', h('div', { class: 'addrow' }, macInp, button('帶入目前看到的', {
      small: true,
      onclick: () => { ps.macs = macsBehind(state, dev, p.id).map((m) => m.mac).join(', '); ctx.commit(true); },
    })), '多個 MAC 用逗號分隔'),
    ps.on && field('違規時的動作', sel(ctx, ...bind(ps, 'mode'), [['restrict', 'Restrict — 只丟棄違規的封包'], ['shutdown', 'Shutdown — 整個連接埠停用 (err-disabled)']])),
    ps.on && ctx.live(() => {
      if (dev.rt.err[p.id] === true) return note('warn', '這個埠已進入 err-disabled：偵測到不在允許清單裡的 MAC，整個埠被關閉。');
      const seen = macsBehind(state, dev, p.id);
      const okList = String(ps.macs || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
      if (!seen.length) return note('muted', '這個埠後面目前沒有看到任何設備。');
      return seen.map((m) => h('div', { class: 'line' }, h('b', { text: nameOf(ctx, m.dev) }), h('span', { class: 'mono muted', text: m.mac }),
        badge(okList.includes(m.mac) ? 'on' : 'warn', okList.includes(m.mac) ? '允許' : '擋下')));
    }),
    p.media === 'rj45' && phyFields(ctx, pc),
    grid2(
      field('Port-channel 編號', inp(ctx, ...bind(pc, 'lag'), { ph: '不使用請留空', check: isNum(1, 48) })),
      field('LACP 模式', sel(ctx, ...bind(pc, 'lagMode'), [['active', 'active（主動協商）'], ['passive', 'passive（只回應）'], ['on', 'on（靜態，不協商）']]))),
    ctx.live(() => {
      const l = dev.rt.lag[p.id];
      if (!l) return null;
      if (l.state === 'bundled') return note('ok', `已加入 Port-channel ${l.id}（目前 ${l.size} 條成員線路）`);
      return note('warn', `Port-channel ${l.id}：${l.state === 'suspended' ? '成員被暫停 — ' : ''}${l.why}`);
    }),
    ctx.live(() => {
      const r = dev.rt.stp && dev.rt.stp.roles[p.id];
      if (!r) return null;
      const by = {};
      for (const [v, role] of Object.entries(r)) (by[role] ||= []).push(v);
      const txt = Object.entries(by).map(([role, vs]) => `${STP_ROLE[role]}（VLAN ${vs.join(', ')}）`).join('、');
      return note(by.altn ? 'warn' : 'muted', 'STP：' + txt);
    }));
}

// ───────────────────────── 交換器：安全 / STP ─────────────────────────

export function secTab(ctx, body) {
  const { dev, state } = ctx;
  const sw = dev.sw;
  const stp = (sw.stp ||= { on: true, prio: 32768 });
  const snoop = (sw.snoop ||= { on: false });
  body.append(h('div', { class: 'card' }, cardHead('生成樹協定 (STP)'),
    h('div', { class: 'toggles' },
      toggle(ctx, ...bind(stp, 'on'), '啟用 STP（偵測並封鎖第二層的迴圈）'),
      toggle(ctx, () => !!stp.portfastDefault, (v) => { stp.portfastDefault = v; }, 'PortFast 預設啟用（所有 Access 埠連線後立刻轉送）')),
    note('muted', '沒有 PortFast 的埠，連線後要先經過 listening 與 learning 各 15 秒才會轉送資料。交換器之間的連線用 RSTP 協商，大約 2 秒。'),
    field('橋接器優先權', sel(ctx, ...bind(stp, 'prio', Number), Array.from({ length: 16 }, (_, n) => [n * 4096, `${n * 4096}${n === 8 ? '（預設）' : ''}`])), '數字越小越優先，最小的那一台會成為根橋 (Root Bridge)'),
    ctx.live(() => {
      const s = dev.rt.stp;
      if (!s.on) return note('warn', 'STP 已關閉。只要交換器之間有多餘的連線，就會立刻發生廣播風暴。');
      const roots = [...new Set(Object.values(s.root))];
      if (!roots.length) return note('muted', '目前沒有連到其他啟用 STP 的交換器。');
      const blk = [...new Set([...s.blocked].map((x) => x.split('|')[0]))];
      return [
        note(roots[0] === dev.id ? 'ok' : 'muted', `根橋：${roots.map((r) => nameOf(ctx, r)).join('、')}${roots[0] === dev.id ? '（就是這一台）' : ''}`),
        note('muted', blk.length ? `被封鎖的連接埠：${blk.join('、')}（備援用，其他線路斷掉時會自動開啟）` : '這台沒有被封鎖的連接埠。'),
      ];
    })));
  const dai = (sw.dai ||= { on: false });
  body.append(h('div', { class: 'card' }, cardHead('DHCP Snooping 與 ARP 檢查'),
    h('div', { class: 'toggles' },
      toggle(ctx, ...bind(snoop, 'on'), '啟用 DHCP Snooping（擋掉不合法的 DHCP 伺服器）'),
      toggle(ctx, ...bind(dai, 'on'), 'Dynamic ARP Inspection（用綁定表驗證 ARP，防止 ARP 欺騙）')),
    ctx.live(() => (dai.on && !snoop.on ? note('warn', 'DAI 要靠 DHCP Snooping 記錄的綁定表才能判斷，請一併啟用 DHCP Snooping。')
      : dai.on ? note('muted', 'DAI 已啟用：不信任的埠送來的 ARP，如果和 DHCP 綁定紀錄對不上就會被丟棄。固定 IP 的設備要接在信任埠。') : null)),
    ctx.live(() => {
      if (!snoop.on) return note('muted', '未啟用：任何一個埠接上 DHCP 伺服器，都可以發 IP 給同網段的電腦。');
      const t = Object.entries(sw.ports).filter(([, c]) => c.trust).map(([p]) => p);
      return t.length ? note('ok', `信任埠：${t.join('、')}。其他埠送進來的 DHCP 伺服器回應都會被丟棄。`)
        : note('warn', '目前沒有任何信任埠，連合法 DHCP 伺服器的回應也會被擋下。請到「連接埠」把上行埠設為信任埠。');
    })));
  body.append(h('div', { class: 'card' }, cardHead('閒置的連接埠'),
    ctx.live(() => {
      const idle = dev.ports.filter((p) => isBridgePort(dev, p.id) && !peerOf(state, dev.id, p.id) && !sw.ports[p.id].shut);
      return idle.length ? note('warn', `有 ${idle.length} 個沒接線的連接埠仍然是啟用的，任何人插上線就能進入網路。`) : note('ok', '所有沒接線的連接埠都已停用。');
    }),
    h('div', { class: 'addrow' }, button('停用所有未接線的連接埠', {
      ic: 'lock', small: true,
      onclick: () => {
        let n = 0;
        for (const p of dev.ports) if (sw.ports[p.id] && !peerOf(state, dev.id, p.id) && !sw.ports[p.id].shut) { sw.ports[p.id].shut = true; n++; }
        toast(n ? `已停用 ${n} 個閒置的連接埠` : '沒有需要停用的連接埠', 'ok');
        ctx.commit(true);
      },
    }))));
}

export function switchStatus(ctx, body) {
  const { dev, state } = ctx;
  body.append(h('div', { class: 'card' }, cardHead('MAC 位址表', button('清除', { small: true, onclick: () => { clearMac(state, dev); ctx.app.refreshLive(); } })), ctx.live(() => {
    const rows = macRows(state, dev);
    if (!rows.length) return note('muted', `還沒有學到任何 MAC 位址。交換器要收到訊框才會記下來源的 MAC（讓電腦 ping 一下就會出現），${macAgeOf(dev)} 秒沒有再看到就會忘記。`);
    return rows.map((r) => h('div', { class: 'line' }, h('b', { class: 'mono', text: r.label }), h('span', { class: 'mono', text: r.mac }),
      h('span', { class: 'muted', style: { marginLeft: 'auto' }, text: r.type === 'STATIC' ? `VLAN ${r.vlan} · 靜態` : `VLAN ${r.vlan} · ${r.age} 秒前 · 剩 ${r.left} 秒` })));
  })));
  body.append(h('div', { class: 'card' }, cardHead('Port-channel'), ctx.live(() => {
    const e = Object.entries(dev.rt.lag);
    if (!e.length) return note('muted', '沒有設定任何 Port-channel。');
    return e.map(([pid, l]) => h('div', { class: 'line' }, h('b', { class: 'mono', text: pid }), h('span', { class: 'muted', text: 'Po' + l.id }),
      badge(l.state === 'bundled' ? 'on' : 'warn', l.state === 'bundled' ? '已綁定' : l.state === 'suspended' ? '暫停' : '未連線')));
  })));
}

export function neighborsCard(ctx) {
  const { dev, state } = ctx;
  return h('div', { class: 'card' }, cardHead('鄰居 (LLDP / CDP)'), ctx.live(() => {
    const rows = dev.ports.map((p) => {
      const n = peerOf(state, dev.id, p.id);
      if (!n) return null;
      const d = state.devices[n.dev];
      return h('div', { class: 'line' }, h('b', { class: 'mono', text: p.label }), h('span', { text: `${d.name} · ${portOf(d, n.port).label}` }),
        h('span', { class: 'muted', style: { marginLeft: 'auto' }, text: CATALOG[d.model].title.replace(/^(Cisco|TP-Link|Ubiquiti|Fortinet|NETGEAR|ASUS|Dell|Lenovo|Apple|HP|Synology) /, '') }));
    }).filter(Boolean);
    return rows.length ? rows : note('muted', '沒有任何鄰居。');
  }));
}

// ───────────────────────── 管理介面 ─────────────────────────

export function mgmtTab(ctx, body) {
  const { dev } = ctx;
  const m = dev.mgmt;
  if (dev.kind === 'mswitch') {
    const i = dev.ifaces.find((x) => x.id === 'mgmt');
    const vl = dev.sw.vlans.slice().sort((a, b) => a.id - b.id).map((v) => [v.id, `${v.id} · ${v.name}`]);
    body.append(h('div', { class: 'card' }, cardHead('管理介面 (SVI)'),
      grid2(
        field('管理 VLAN', sel(ctx, () => i.bind.vlan, (v) => { i.bind.vlan = +v; }, vl)),
        field('IP 位址', inp(ctx, ...bind(i, 'ip'), { ph: '例如 10.0.99.2', check: isIp })),
        field('子網路遮罩', inp(ctx, ...bind(i, 'mask'), { ph: '255.255.255.0', check: isMask })),
        field('預設閘道', inp(ctx, ...bind(i, 'gateway'), { ph: '要跨網段管理才需要', check: isIp }))),
      ifaceNote(ctx, i)),
    h('p', { class: 'tip', text: 'L2 交換器本身不做路由，這個 IP 只是讓你能遠端登入它、讓它能送出 Syslog。' }));
  }
  const fw = dev.kind === 'firewall';
  body.append(h('div', { class: 'card' }, cardHead('管理存取'),
    fw
      ? note('muted', '防火牆的管理協定是在「介面」分頁的每個介面上個別開放的 (allowaccess)。這裡設定的是允許登入的來源位址 (trusted hosts)。')
      : h('div', { class: 'toggles' },
        toggle(ctx, ...bind(m, 'ssh'), 'SSH（TCP 22，全程加密）'),
        toggle(ctx, ...bind(m, 'https'), 'HTTPS 管理頁面（TCP 443）'),
        toggle(ctx, ...bind(m, 'telnet'), 'Telnet（TCP 23，帳號密碼明文傳送）'),
        toggle(ctx, ...bind(m, 'http'), 'HTTP 管理頁面（TCP 80，明文傳送）')),
    field('允許管理的來源', inp(ctx, ...bind(m, 'allow'), { ph: '留空＝任何位址都能連，例如 10.0.99.0/24', check: isCidrList })),
    ctx.live(() => {
      const w = [];
      if (!fw && m.telnet) w.push('Telnet 是明文協定，應該關閉。');
      if (!fw && m.http) w.push('HTTP 管理頁面是明文傳送，應該關閉，只留 HTTPS。');
      if (!String(m.allow || '').trim()) w.push('沒有限制來源，任何網段都能嘗試登入。');
      return w.length ? w.map((x) => note('warn', x)) : note('ok', '管理介面已加固：只開放加密協定，並限制了來源網段。');
    })));
  body.append(M.accountCard(ctx));
  const ssh = OPS.sshCard(ctx);
  if (ssh) body.append(ssh);
  if (dev.radius && dev.sw) body.append(M.radiusClientCard(ctx));
  body.append(h('div', { class: 'card' }, cardHead('監控、時間與紀錄'),
    M.snmpFields(ctx),
    OPS.snmpExtra(ctx),
    grid2(
      field('NTP 伺服器', inp(ctx, ...bind(m, 'ntp'), { ph: '例如 10.0.99.20', check: isIp })),
      field('Syslog 伺服器', inp(ctx, ...bind(m, 'syslog'), { ph: '例如 10.0.99.20', check: isIp }))),
    h('p', { class: 'tip', text: '設備用 NTP 對時、把事件紀錄送到 Syslog 伺服器集中保存。時間一致，事後才能把各設備的紀錄串起來追查。' }),
    ctx.live(() => {
      const st = ctx.state, n = ntpInfo(st, dev), t = deviceTime(st, dev), s = plainStamp(st, dev), ip = n.server != null ? fmtIp(n.server) : '';
      const ntp = n.server == null
        ? note('muted', t.src === 'boot' ? '沒有設定 NTP。這台設備沒有硬體時鐘，時間是從開機時的出廠預設值（1993 年）算起的，紀錄上的時間會和其他設備對不起來。'
          : t.src === 'manual' ? '沒有設定 NTP，時間是手動設定的。' : '沒有設定 NTP。時間來自設備自己的硬體時鐘，會有幾分鐘的誤差。')
        : n.synced && !n.lost ? note('ok', `已經和 ${ip} 對時（stratum ${n.stratum}）。`)
          : n.lost ? note('warn', `已經 ${fmtDur(n.when)}沒有收到 ${ip} 的回應：${n.why}`)
            : n.wait > 0 ? note('warn', `已經收到 ${ip} 的回應，但要連續好幾次輪詢都正常才會採信，大約再 ${fmtDur(n.wait)}。`)
              : note('warn', `連不到 NTP 伺服器 ${ip}：${n.why || '還沒有收到回應'}（每 ${NTP_POLL} 秒重試一次）`);
      const sy = syslogStats(st, dev);
      return [h('div', { class: 'kv ' + (t.auth ? 'ok' : '') }, kv('設備自己的時間', `${s.date} ${s.time}${t.auth ? '' : '（不可信）'}`),
        m.syslog && kv('送到 Syslog 伺服器', `${sy.sent} 筆${sy.lost ? `，${sy.lost} 筆沒有送達` : ''}`)), ntp,
      m.syslog && sy.lost > 0 && note('warn', `Syslog 用的是 UDP，送不到就直接掉了、不會重送。最近一次失敗的原因：${sy.why}`)];
    })));
  body.append(h('div', { class: 'card' },
    cardHead('事件紀錄', button('清除', { small: true, onclick: () => { clearLog(ctx.state, dev); ctx.app.refreshLive(); } })),
    ctx.live(() => {
      const rows = logRows(ctx.state, dev);
      if (!rows.length) return note('muted', '還沒有任何紀錄。介面上線或斷線、鄰居關係改變、VPN 通道狀態改變時，設備會在這裡留下一筆。紀錄放在記憶體裡，重新開機就沒了，所以才需要送到 Syslog 伺服器。');
      return h('div', { class: 'logbox' }, rows.slice(-25).map((r) => h('div', { class: 'll s' + r.sev, text: r.line })));
    })));
}

// ───────────────────────── 路由器：ACL ─────────────────────────

export function aclTab(ctx, body) {
  const { dev } = ctx;
  body.append(h('p', { class: 'tip', text: 'ACL 由上往下比對，第一條符合的規則決定放行或拒絕。只要清單裡有規則，最後就隱含一條「全部拒絕」。ACL 不記錄連線狀態，回程封包也會被檢查。' }));
  for (const i of dev.ifaces) {
    const card = h('div', { class: 'card' }, cardHead(i.label, ctx.live(() => h('span', { class: 'mono muted', text: i.rt.ip != null ? `${fmtIp(i.rt.ip)}/${i.rt.bits}` : '未設定 IP' }))));
    for (const [key, title] of [['aclIn', '進入方向 (in)'], ['aclOut', '離開方向 (out)']]) {
      const list = (i[key] ||= []);
      card.append(h('div', { class: 'acl-h' }, h('span', { text: title }), h('em', { text: key === 'aclIn' ? '從這個介面進來的封包' : '準備從這個介面出去的封包' }),
        button('新增', { ic: 'plus', small: true, onclick: () => { list.push({ action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: '' }); ctx.commit(true); } })));
      list.forEach((r, n) => {
        card.append(h('div', { class: 'acl-row ' + r.action },
          h('div', { class: 'acl-l1' }, h('span', { class: 'pno', text: n + 1 }),
            sel(ctx, ...bind(r, 'action'), [['permit', '允許 permit'], ['deny', '拒絕 deny']], { rerender: true }),
            sel(ctx, ...bind(r, 'proto'), [['ip', 'ip（全部）'], ['tcp', 'tcp'], ['udp', 'udp'], ['icmp', 'icmp']]),
            inp(ctx, ...bind(r, 'port'), { ph: '埠', check: isPortNo, w: '58px' }),
            h('button', { class: 'mini', type: 'button', title: '上移', disabled: n === 0, onclick: () => { list.splice(n - 1, 0, list.splice(n, 1)[0]); ctx.commit(true); } }, icon('up', 14)),
            del(() => { list.splice(n, 1); ctx.commit(true); })),
          h('div', { class: 'acl-l2' },
            inp(ctx, ...bind(r, 'src'), { ph: '來源：any 或 10.0.20.0/24', check: isAddr }), h('span', { text: '→' }),
            inp(ctx, ...bind(r, 'dst'), { ph: '目的：any 或 10.0.30.10', check: isAddr }), hitBadge(ctx, r))));
      });
      if (list.length) card.append(h('div', { class: 'acl-deny', text: '（隱含）拒絕 ip any → any' }));
    }
    body.append(card);
  }
}

// ───────────────────────── VPN ─────────────────────────

export function vpnTab(ctx, body) {
  const { dev, state } = ctx;
  body.append(h('p', { class: 'tip', text: '站對站 VPN：兩端的對端 IP、預先共用金鑰要對得上，本地 / 遠端網段要互為鏡像。協商分兩個階段，兩個階段的加密提案都要一致。' }));
  dev.vpns.forEach((t, n) => {
    const rename = (v) => {
      const from = 'vpn:' + (t.name || 'VPN');
      t.name = v || 'VPN';
      for (const p of dev.policies || []) {
        if (p.srcIf === from) p.srcIf = 'vpn:' + t.name;
        if (p.dstIf === from) p.dstIf = 'vpn:' + t.name;
      }
    };
    body.append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('span', { class: 'pno', text: '通道' }), inp(ctx, () => t.name, rename, { mono: false, ph: '通道名稱', rerender: true }),
        del(() => { dev.vpns.splice(n, 1); ctx.commit(true); })),
      grid2(
        field('對端公用 IP', inp(ctx, ...bind(t, 'peer'), { ph: '例如 203.0.113.18', check: isIp })),
        field('預先共用金鑰 (PSK)', inp(ctx, ...bind(t, 'psk'), { ph: '兩端必須相同' })),
        field('本地網段', inp(ctx, ...bind(t, 'local'), { ph: '例如 10.2.0.0/24', check: isCidrList })),
        field('遠端網段', inp(ctx, ...bind(t, 'remote'), { ph: '例如 10.1.0.0/24', check: isCidrList })),
        !(dev.isakmp && dev.isakmp.length) && field('第一階段 (IKE) 加密', sel(ctx, () => t.enc || 'aes128', (v) => { t.enc = v; }, [['aes128', 'AES128'], ['aes256', 'AES256']])),
        !(dev.isakmp && dev.isakmp.length) && field('第一階段雜湊', sel(ctx, () => t.hash || 'sha1', (v) => { t.hash = v; }, [['sha1', 'SHA1'], ['sha256', 'SHA256']])),
        !(dev.isakmp && dev.isakmp.length) && field('第一階段 DH 群組', sel(ctx, () => t.dh || '2', (v) => { t.dh = v; }, DH_GROUPS)),
        field('第二階段 (IPsec) 加密', sel(ctx, () => t.enc2 || '', (v) => { t.enc2 = v; }, [['', '和第一階段相同'], ['aes128', 'AES128'], ['aes256', 'AES256']])),
        field('第二階段雜湊', sel(ctx, () => t.hash2 || '', (v) => { t.hash2 = v; }, [['', '和第一階段相同'], ['sha1', 'SHA1'], ['sha256', 'SHA256']])),
        field('PFS（第二階段再做一次 DH）', sel(ctx, () => t.pfs || '', (v) => { t.pfs = v; }, [['', '不使用'], ...DH_GROUPS]))),
      dev.isakmp && dev.isakmp.length > 0 && note('muted', `第一階段的提案由 CLI 的 crypto isakmp policy 管理，整台設備共用：${dev.isakmp.map((p) => `#${p.n} ${P1(p)}`).join('；')}`),
      grid2(
        !(dev.isakmp && dev.isakmp.length) && field('第一階段金鑰壽命（秒）', inp(ctx, () => t.life1 || '', (v) => { t.life1 = +v > 0 ? +v : undefined; }, { ph: '預設 86400', check: isNum(120, 172800) })),
        field('第二階段金鑰壽命（秒）', inp(ctx, () => t.life2 || '', (v) => { t.life2 = +v > 0 ? +v : undefined; }, { ph: dev.kind === 'firewall' ? '預設 43200' : '預設 3600', check: isNum(120, 172800) })),
        dev.kind === 'firewall' && field('對端失聯偵測 (DPD)', sel(ctx, () => t.dpd || 'on-demand', (v) => { t.dpd = v === 'on-demand' ? undefined : v; },
          [['on-demand', '開啟：每 20 秒探測，三次沒回應就拆掉通道'], ['disable', '關閉：要等金鑰到期才會發現']]))),
      ctx.live(() => {
        const r = t.rt || {}, sa = saInfo(state, dev.id, t.name || 'VPN');
        if (r.nego) return note('warn', `正在協商 (IKE)，大約再 ${Math.ceil(r.nego)} 秒建立。`);
        if (r.up && r.stale) {
          return note('warn', `這一端的通道看起來還是 Up，但對端已經沒有回應（${r.staleWhy}）。再 ${fmtDur(r.stale - state.clock)} 才會判定失聯${dev.kind === 'firewall' || dev.ikeKeepalive ? '' : '：沒有設定 keepalive，只能等金鑰到期'}，這段時間往對端的封包都會被丟掉。`);
        }
        if (!r.up) return note('warn', '通道未建立：' + (r.why || '設定中'));
        return [note('ok', '通道已建立 (Up)'), sa && h('div', { class: 'kv ok' },
          kv('第一階段金鑰', `剩 ${fmtDur(sa.left1)}`), kv('第二階段金鑰', `剩 ${fmtDur(sa.left2)}${sa.rekey2 ? `（已更新 ${sa.rekey2} 次）` : ''}`),
          kv('加密 / 解密的封包', `${sa.tx} / ${sa.rx}`))];
      }),
      dev.kind === 'firewall' && note('muted', `政策的介面請選「VPN ${t.name || 'VPN'}」，內網 ↔ VPN 兩個方向都要放行。`)));
  });
  body.append(h('div', { class: 'addrow' }, button('新增站對站通道', {
    ic: 'plus', kind: 'primary', small: true,
    onclick: () => {
      let n = dev.vpns.length + 1;
      while (dev.vpns.some((x) => x.name === 'VPN' + n)) n++;
      dev.vpns.push({ name: 'VPN' + n, peer: '', psk: '', local: '', remote: '', enc: 'aes128', hash: 'sha1', dh: '2' });
      ctx.commit(true);
    },
  })));
  if (dev.kind === 'router' && dev.vpns.length) {
    body.append(h('div', { class: 'card' }, cardHead('對端失聯偵測 (IKE keepalive)'),
      field('多久沒有流量就探測一次（秒）', inp(ctx, () => (dev.ikeKeepalive ? dev.ikeKeepalive.sec : ''), (v) => {
        if (+v >= 10) dev.ikeKeepalive = { sec: +v, retry: (dev.ikeKeepalive || {}).retry || 2 }; else delete dev.ikeKeepalive;
      }, { ph: '留空 = 不偵測', check: isNum(10, 3600) }), 'IOS 預設不會主動探測對端。沒有設定的話，對端斷線之後這一端的通道還會維持 Up，直到金鑰到期（最久一小時）才發現。')));
  }
  const vs = dev.vpnServer;
  if (!vs) return;
  const card = h('div', { class: 'card' }, cardHead('遠端存取 VPN（SSL-VPN）'),
    h('div', { class: 'toggles' }, toggle(ctx, ...bind(vs, 'on'), '允許使用者從外部撥入', { rerender: true })));
  if (vs.on) {
    card.append(grid2(
      field('位址池起始', inp(ctx, ...bind(vs, 'start'), { ph: '例如 10.99.0.10', check: isIp })),
      field('位址池結束', inp(ctx, ...bind(vs, 'end'), { ph: '例如 10.99.0.50', check: isIp }))),
    grid2(
      field('VPN 用戶可以存取的內部網段', inp(ctx, ...bind(vs, 'subnets'), { ph: '例如 10.1.0.0/24', check: isCidrList })),
      field('連接埠', inp(ctx, ...bind(vs, 'port'), { ph: '10443', check: isPortNo }))),
    h('div', { class: 'thead c-user' }, h('span', { text: '帳號' }), h('span', { text: '密碼' }), h('span')));
    vs.users.forEach((u, n) => card.append(h('div', { class: 'trow c-user' },
      inp(ctx, ...bind(u, 'user'), { ph: '帳號', mono: false }), inp(ctx, ...bind(u, 'pass'), { ph: '密碼' }),
      del(() => { vs.users.splice(n, 1); ctx.commit(true); }))));
    card.append(h('div', { class: 'addrow' }, button('新增使用者', { ic: 'plus', small: true, onclick: () => { vs.users.push({ user: '', pass: '' }); ctx.commit(true); } })),
      ctx.live(() => {
        const e = Object.entries((state.vpnLeases || {})[dev.id] || {});
        return e.length ? note('ok', '已連線：' + e.map(([id, ip]) => `${nameOf(ctx, id)} ${fmtIp(ip)}`).join('、')) : note('muted', '目前沒有使用者連線。');
      }),
      note('muted', '還要有一條政策：來源介面選「遠端使用者 VPN」，只放行使用者真正需要的服務。'));
  }
  body.append(card);
}

export function vpnClientTab(ctx, body) {
  const { dev } = ctx;
  const c = dev.vpnClient;
  body.append(h('div', { class: 'card' },
    cardHead('VPN 用戶端', ctx.live(() => badge(dev.rt.vpn && dev.rt.vpn.up ? 'on' : 'off', dev.rt.vpn && dev.rt.vpn.up ? '已連線' : '未連線'))),
    grid2(
      field('VPN 伺服器位址', inp(ctx, ...bind(c, 'server'), { ph: '公司防火牆的公用 IP', check: isIp })),
      field('連接埠', inp(ctx, ...bind(c, 'port'), { ph: '10443', check: isPortNo }))),
    grid2(
      field('帳號', inp(ctx, ...bind(c, 'user'), { ph: '帳號', mono: false })),
      field('密碼', inp(ctx, ...bind(c, 'pass'), { ph: '密碼' }))),
    h('div', { class: 'toggles' }, toggle(ctx, ...bind(c, 'on'), '連線')),
    ctx.live(() => {
      const v = dev.rt.vpn;
      if (!v) return null;
      if (v.up) return h('div', { class: 'kv ok' }, kv('虛擬 IP', fmtIp(v.vip)), kv('VPN 伺服器', nameOf(ctx, v.server)), kv('通道', 'SSL-VPN (TLS 加密)'));
      return note(c.on ? 'warn' : 'muted', v.why);
    })),
  h('p', { class: 'tip', text: '連上之後，往公司內部網段的流量會走加密通道，其他上網流量仍然直接從這裡出去（分割通道）。' }));
}

// ───────────────────────── DHCP 伺服器的位址範圍 ─────────────────────────

export function dhcpScopesTab(ctx, body) {
  const { dev, state } = ctx;
  const list = dev.dhcpScopes;
  body.append(h('p', { class: 'tip', text: '每個網段建立一個範圍 (Scope)。其他網段的請求要靠該網段閘道上的 DHCP Relay (helper-address) 轉送過來。' }));
  list.forEach((s, n) => {
    body.append(h('div', { class: 'card' }, cardHead(`範圍 ${n + 1}`, del(() => { list.splice(n, 1); ctx.commit(true); })),
      grid2(
        field('起始 IP', inp(ctx, ...bind(s, 'start'), { ph: '例如 10.0.10.100', check: isIp })),
        field('結束 IP', inp(ctx, ...bind(s, 'end'), { ph: '例如 10.0.10.199', check: isIp })),
        field('發給用戶端的閘道', inp(ctx, ...bind(s, 'gw'), { ph: '留空＝轉送來的那個閘道', check: isIp })),
        field('發給用戶端的 DNS', inp(ctx, ...bind(s, 'dns'), { ph: '例如 8.8.8.8', check: isIpList }))),
      ctx.live(() => {
        const e = Object.entries(state.leases[`${dev.id}/scope/${s.start}`] || {});
        return e.length ? note('ok', '已發出：' + e.map(([k, ip]) => `${nameOf(ctx, k.split('/')[0])} ${fmtIp(ip)}`).join('、')) : note('muted', '這個範圍還沒有發出任何位址。');
      })));
  });
  body.append(h('div', { class: 'addrow' }, button('新增範圍', {
    ic: 'plus', kind: 'primary', small: true, onclick: () => { list.push({ start: '', end: '', gw: '', dns: '' }); ctx.commit(true); },
  })));
  if (!dev.ifaces.some((i) => i.rt.ip != null)) body.append(note('warn', '這台伺服器自己還沒有 IP。請先到「網路設定」給它一個固定 IP 與閘道。'));
}

// ───────────────────────── L3 介面的附加區塊 ─────────────────────────

export function vrrpBlock(ctx, i) {
  const v = (i.vrrp ||= { on: false, vip: '', prio: '100' });
  return h('div', { class: 'sub' },
    toggle(ctx, ...bind(v, 'on'), 'VRRP / HSRP 虛擬閘道', { rerender: true }),
    v.on && grid2(
      field('虛擬 IP', inp(ctx, ...bind(v, 'vip'), { ph: '例如 10.0.10.1', check: isIp })),
      field('優先權', inp(ctx, ...bind(v, 'prio'), { ph: '預設 100，越大越優先', check: isNum(1, 254) }))),
    v.on && ctx.live(() => {
      const s = i.rt.vrrp;
      if (!s) return null;
      if (s.state === 'master') return note('ok', `Master：目前由這台回應虛擬 IP${s.peers ? '' : '（沒有看到其他成員）'}`);
      if (s.state === 'backup' && s.wait > 0) return note('warn', `Backup：聽不到 Master 的通告，再 ${Math.ceil(s.wait)} 秒接手。這段時間沒有人回應虛擬 IP。`);
      if (s.state === 'backup') return note('muted', 'Backup：待命中，Master 故障約 3 秒後接手');
      return note('warn', s.why);
    }));
}
