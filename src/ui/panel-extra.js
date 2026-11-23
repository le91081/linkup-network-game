// 進階功能的設定頁面：Wi-Fi、VPN、ACL、L2 安全、STP / LACP、管理加固、DHCP 範圍
import { ipsecCards } from './panel-tun.js';
import { acl6Cards } from './panel-v6.js';
import { zbfCard } from './panel-zbf.js';
import { ICMP_TYPES } from '../engine/mtu.js';
import { h, icon, button, toast } from './dom.js';
import {
  inp, sel, toggle, field, note, kv, del, cardHead, badge, grid2, bind, linkBadge, ifaceNote,
  isIp, isMask, isIpList, isAddr, isCidrList, isMacList, isPortNo, isNum,
} from './form.js';
import { fmtIp } from '../engine/ip.js';
import { newGuestCode } from '../engine/portal.js';
import { loopGuardOn } from '../engine/stpcfg.js';
import { CATALOG, peerOf, portOf, newSsid, cableAt, linkInfo } from '../engine/model.js';
import { visibleSsids, WIFI_SEC, macsBehind, isBridgePort, hitsOf, P1, accessOf, portfastOn, macRows, clearMac, macAgeOf, saInfo, fmtDur, isTrunk, dtpSpeaker, WALL_MATS, errdisRows, bouncePort, ERR_CAUSES, ERR_RECOVERY_DEFAULT, CH5, DFS, blockOf, CH6, on6, has6, portalPending, portalAccept, transact } from '../engine/sim.js';
import { cdpCfg, lldpCfg, cdpOn, lldpTxOn, lldpRxOn, portNd, setPortNd, neighbors, speaksCdp, speaksLldp } from '../engine/disc.js';
import { ntpInfo, deviceTime, plainStamp, logRows, clearLog, syslogStats, NTP_POLL } from '../engine/ops.js';
import * as M from './panel-more.js';
import * as L2 from './panel-l2sec.js';
import * as OPS from './panel-ops.js';
import * as V from './panel-voice.js';

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
    a.walls && a.walls.length > 0 && note(a.wallDb >= 12 ? 'warn' : 'muted', `和基地台之間隔著 ${Object.entries(a.walls.reduce((m, w) => ((m[w] = (m[w] || 0) + 1), m), {})).map(([w, n]) => `${(WALL_MATS[w] || WALL_MATS.drywall).name}${n > 1 ? ' ×' + n : ''}`).join('、')}，訊號少了 ${a.wallDb} dB${a.band === '2.4GHz' ? '（5 GHz 穿牆更差，所以退回 2.4 GHz）' : ''}。`),
    bars === 1 && note('warn', `訊號很弱：${a.walls && a.walls.length ? '牆擋掉了不少訊號，' : '離基地台太遠，'}速率很低也容易斷線。把基地台移近、在這一側再加一台，或調高它的發射功率。`),
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
  const n = state.hideCables ? null : peerOf(state, dev.id, p.id);
  if (!n) return null;
  const peer = state.devices[n.dev];
  const qc = peer.sw && peer.sw.mode === 'vlan' && peer.sw.ports[n.port];
  const there = `${peer.name} 的 ${portOf(peer, n.port).label}`;
  const cap = (m) => (m === 'trunk' ? 'Trunk' : 'Access');
  const out = [];
  const mine = isTrunk(dev, p.id) ? 'trunk' : 'access';
  if (qc && qc.mode !== 'routed' && state.rt.links[dev.id + ':' + p.id]) {
    const theirs = isTrunk(peer, n.port) ? 'trunk' : 'access';
    if (mine !== theirs) out.push(`兩端模式不一致：這一端是 ${cap(mine)}，${there} 是 ${cap(theirs)}，帶標籤的 VLAN 過不去。${pc.noneg || qc.noneg ? '（設了 nonegotiate 的一端不送 DTP，對面的 dynamic 埠等不到要求，只能維持 Access）' : ''}`);
    else if (mine === 'trunk' && pc.native !== qc.native) out.push(`Native VLAN 不一致：這一端是 ${pc.native}，${there} 是 ${qc.native}。沒有標籤的訊框會被兩端放進不同的 VLAN。`);
    else if (mine === 'access' && pc.vlan !== qc.vlan) out.push(`兩端的 Access VLAN 不同（這一端 ${pc.vlan}，${there} 是 ${qc.vlan}），兩個 VLAN 會被這條線接在一起。`);
  }
  // 對面是路由器的子介面（router-on-a-stick）：路由器不講 DTP，這一端一定要明確設成 Trunk
  if (!qc && mine !== 'trunk' && peer.ifaces.some((i) => i.bind.t === 'sub' && i.bind.port === n.port)) out.push(`${there} 用子介面送帶 VLAN 標籤的訊框，這個埠要設成 Trunk（路由器不會用 DTP 協商）。`);
  out.push(...phyWarnings(state, dev, p.id));
  const left = dev.rt.wait && dev.rt.wait[p.id];
  if (left > 0) {
    out.push(qc ? `STP 正在和 ${peer.name} 協商，再 ${Math.ceil(left)} 秒開始轉送。`
      : `這個埠剛啟用，STP 還在 ${left > 15 ? 'listening' : 'learning'}，再 ${Math.ceil(left)} 秒才會開始轉送資料。接電腦或伺服器的埠可以在進階設定打開 PortFast。`);
  }
  return out.map((t) => note('warn', t));
});

/** dynamic 的埠：現在協商成什麼、為什麼 */
export const dtpLine = (ctx, p, pc) => ctx.live(() => {
  const { dev } = ctx;
  const t = dev.rt.dtp && dev.rt.dtp[p.id];
  if (!t || !/^dynamic/.test(pc.mode)) return null;
  if (t.oper === 'down') return note('muted', '還沒有接線。接上之後會用 DTP 和對面協商要不要變成 Trunk。');
  return note(t.oper === 'trunk' ? 'ok' : 'muted', `運作中：${t.oper === 'trunk' ? 'Trunk' : 'Access'} — ${t.why}`);
});

/** OSPF 鄰居的狀態 */
export function nbrBadge(x) {
  if (x.state === 'forming') return badge('warn', `建立中 · 再 ${Math.ceil(x.left)} 秒`);
  if (x.state === 'dying') return badge('warn', `沒有回應 · ${Math.ceil(x.left)} 秒後移除`);
  if (x.state === 'exstart') return badge('warn', 'EXSTART（卡住了）');
  if (x.state === '2way') return badge('on', '2WAY（兩台都不是 DR / BDR）');
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
  const all = [['ping', 'PING'], ['https', 'HTTPS'], ['ssh', 'SSH'], ['snmp', 'SNMP'], ['http', 'HTTP'], ['telnet', 'TELNET']];
  const flip = (k) => {
    // 畫面上沒列出來的值（fgfm 之類從 CLI 設的）保留下來
    const keep = cur.filter((x) => !all.some((y) => y[0] === x));
    i.access = [...all.map((x) => x[0]).filter((x) => (x === k ? !cur.includes(k) : cur.includes(x))), ...keep];
    i.ping = i.access.includes('ping');
    ctx.commit(true);
  };
  return h('div', { class: 'sub' },
    h('span', { class: 'f-label', text: '管理存取 (allowaccess)：從這個介面可以用哪些方式連到防火牆本身' }),
    h('div', { class: 'chips' }, all.map(([k, t]) => h('button', { type: 'button', class: 'chip btnchip acc' + (cur.includes(k) ? ' on' : ''), text: t, onclick: () => flip(k) }))),
    (cur.includes('http') || cur.includes('telnet')) && note('warn', 'HTTP 與 Telnet 是明文協定，帳號密碼會被看光，不應該開放。'),
    cur.includes('snmp') && !(dev.mgmt && dev.mgmt.snmpAgent) && note('muted', '介面開放了 SNMP，但 SNMP 代理程式還沒啟用（系統 → SNMP）。'),
    /^wan/.test(i.id) && cur.some((k) => k !== 'ping') && note('warn', '對外的介面開放了管理協定，任何人都能從網際網路嘗試登入。'));
}

const ui = {}; // 訪客碼輸入框（還沒送出的內容）
export function wifiPicker(ctx, i) {
  const nets = visibleSsids(ctx.state, ctx.dev);
  const w = i.wifi;
  const opts = [['', '（不連線）'], ...nets.map((n) => [n.name, `${n.name} · ${n.sec === 'open' ? '開放' : WIFI_SEC[n.sec]} · 訊號 ${'●'.repeat(n.bars)}${'○'.repeat(3 - n.bars)}`])];
  if (w.ssid && !nets.some((n) => n.name === w.ssid)) opts.push([w.ssid, `${w.ssid} · 目前收不到訊號`]);
  const ent = (nets.find((n) => n.name === w.ssid) || {}).sec === 'wpa2ent';
  // 訪客入口：連上了但還沒同意，模擬瀏覽器跳出的登入頁面
  const portal = ctx.live(() => {
    const p = portalPending(ctx.state, ctx.dev);
    if (!p) return (i.rt.assoc && i.rt.assoc.portal) ? note('ok', '已經在訪客入口按過同意，可以上網了。') : null;
    return h('div', null, note('warn', `「${p.assoc.ssid}」有訪客入口：要先在入口網頁按下同意才能上網。`),
      p.portal.needCode && field('訪客碼', inp({ commit() {} }, () => ui.guestCode || '', (v) => { ui.guestCode = v; }, { ph: '櫃台給的 6 位數字' })),
      h('div', { class: 'addrow' }, button(p.portal.needCode ? '打開瀏覽器、輸入訪客碼登入' : '打開瀏覽器、在入口網頁按同意', { ic: 'check', small: true, onclick: () => {
        const r = portalAccept(ctx.state, ctx.dev.id, transact, ui.guestCode);
        toast(r.ok ? '已同意使用條款，可以上網了' : r.why, r.ok ? 'ok' : 'bad', r.ok ? 3200 : 7000);
        ctx.commit(true);
      } })));
  });
  return [
    portal,
    !nets.length && note('muted', '附近沒有偵測到任何無線網路。'),
    ent
      ? [field('無線網路 (SSID)', sel(ctx, ...bind(w, 'ssid'), opts, { rerender: true })),
        grid2(field('帳號', inp(ctx, ...bind(w, 'user'), { ph: '個人帳號', mono: false })), field('密碼', inp(ctx, ...bind(w, 'pass'), { ph: '個人密碼' }))),
        note('muted', '這個網路使用 802.1X：每個人用自己的帳號登入，由 RADIUS 伺服器驗證。')]
      : grid2(
        field('無線網路 (SSID)', sel(ctx, ...bind(w, 'ssid'), opts, { rerender: true })),
        field('密碼', inp(ctx, ...bind(w, 'pass'), { ph: '開放網路可留空' }))),
    field('或手動輸入網路名稱（隱藏的 SSID）', inp(ctx, ...bind(w, 'ssid'), { ph: '例如 Office-Hidden', mono: false, rerender: true })),
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
      field('5GHz 頻道', sel(ctx, ...bind(w, 'ch5', Number), CH5.map((c) => [c, `頻道 ${c}${DFS.has(c) ? '（DFS）' : ''}`]))),
      field('5GHz 頻道寬度', sel(ctx, () => (w.width5 ? String(w.width5) : ''), (v) => { if (v) w.width5 = +v; else delete w.width5; }, [['', '自動（附近有人就縮窄）'], ['20', '20 MHz'], ['40', '40 MHz'], ['80', '80 MHz'], ['160', '160 MHz']])),
      has6(ctx.dev) && field('6GHz 頻道（160 MHz）', sel(ctx, ...bind(w, 'ch6', Number), CH6.map((c) => [c, `頻道 ${c}`]))),
      field('發射功率', sel(ctx, ...bind(w, 'power'), [['low', '低（涵蓋範圍小）'], ['mid', '中'], ['high', '高（涵蓋範圍大）']]))),
    has6(ctx.dev) && note('muted', '6 GHz（Wi-Fi 6E）規定要用 WPA3：加密方式是 WPA3 或 WPA2 / WPA3 混合的 SSID 才會在 6 GHz 廣播（混合模式在 6 GHz 那一邊只用 WPA3），只支援 6E 的用戶端才看得到。'),
    ctx.live(() => {
      const rt = ctx.dev.rt || {}, ch = (rt.dfs && rt.dfs.to) || +w.ch5 || 36, wd = rt.width5;
      const out = [];
      if (wd) out.push(note('muted', `5 GHz 實際使用 ${wd} MHz（頻道 ${blockOf(ch, wd).join('、')}）${wd < (+w.width5 || 80) ? '：附近有基地台用到同一塊頻譜，自動縮窄了' : ''}`));
      if (rt.dfs) out.push(note('warn', `偵測到雷達：從 DFS 頻道 ${rt.dfs.from} 換到 ${rt.dfs.to}${rt.dfs.hold ? '（正在換頻道，5 GHz 的用戶端暫時斷線）' : ''}，30 分鐘內不能回到原本的頻道`));
      else if (DFS.has(+w.ch5)) out.push(note('muted', `頻道 ${w.ch5} 是 DFS 頻道：和氣象雷達共用，偵測到雷達就要立刻換頻道（用戶端會斷一下）`));
      return out;
    }),
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
      h('div', { class: 'toggles' }, toggle(ctx, ...bind(s, 'isolate'), '用戶端隔離（連上這個 SSID 的設備彼此不能互連）'),
        toggle(ctx, () => !!s.hidden, (v) => { if (v) s.hidden = true; else delete s.hidden; }, '隱藏 SSID（不廣播名稱：掃描清單看不到，要手動輸入名稱才連得上）', { rerender: true }),
        dev.kind === 'ap' && toggle(ctx, ...bind(s, 'kv'), '802.11k/v：提供鄰近基地台的清單、建議用戶端換到訊號更好的基地台（改善 sticky client）'),
        dev.kind === 'ap' && toggle(ctx, ...bind(s, 'ft'), '802.11r（Fast Transition）：漫遊時沿用金鑰，不用重新做完整的驗證')),
      field('MAC 過濾', sel(ctx, () => (s.macFilter && s.macFilter.mode) || '', (v) => { if (v) s.macFilter = { ...(s.macFilter || {}), mode: v }; else delete s.macFilter; }, [['', '不過濾'], ['allow', '只允許清單裡的 MAC'], ['deny', '封鎖清單裡的 MAC']], { rerender: true })),
      s.macFilter && s.macFilter.mode && field('MAC 清單（逗號或空白分隔）', inp(ctx, () => s.macFilter.list || '', (v) => { s.macFilter.list = v; }, { ph: '例如 02:1c:42:00:00:15' })),
      s.hidden && note('muted', '隱藏 SSID 只是不在 beacon 裡放名稱：用戶端連線時的 probe 照樣會送出名稱，用工具一掃就看得到，不能當成安全機制。'),
      s.macFilter && s.macFilter.mode && note('muted', 'MAC 位址可以偽造（側錄到合法設備的 MAC 就能冒用），MAC 過濾只能擋一般人，不能取代 WPA2 / WPA3 的密碼或 802.1X。'),
      s.sec !== 'wpa2ent' && toggle(ctx, () => !!(s.portal && s.portal.on), (v) => { s.portal = { ...(s.portal || {}), on: v }; }, '訪客入口 (Captive Portal)：連上之後要先在入口網頁按同意才能上網', { rerender: true }),
      s.portal && s.portal.on && grid2(field('入口網頁伺服器', inp(ctx, () => s.portal.ip || '', (v) => { s.portal.ip = v; }, { ph: '例如 192.168.50.5', check: isIp })),
        field('認證前允許的位址（pre-auth ACL）', inp(ctx, () => s.portal.preauth || '', (v) => { s.portal.preauth = v; }, { ph: '例如 DNS 伺服器 8.8.8.8', mono: true }))),
      s.portal && s.portal.on && toggle(ctx, () => !!s.portal.needCode, (v) => { if (v) s.portal.needCode = true; else delete s.portal.needCode; }, '要輸入訪客碼才能上網（櫃台發給訪客，時間到自動失效）', { rerender: true }),
      s.portal && s.portal.on && s.portal.needCode && h('div', { class: 'sub' },
        ...(s.portal.codes || []).filter((c) => c.until > ctx.state.clock).map((c) => h('div', { class: 'line' }, h('b', { class: 'mono', text: c.code }), h('span', { class: 'muted', text: `還有 ${fmtDur(c.until - ctx.state.clock)} 失效` }))),
        h('div', { class: 'addrow' }, button('產生訪客碼（8 小時）', { ic: 'plus', small: true, onclick: () => { const c = newGuestCode(ctx.state, s.portal, 8); toast(`訪客碼 ${c.code}，8 小時內有效`, 'ok'); ctx.commit(true); } }))),
      s.portal && s.portal.on && note('muted', '同意之前只能連入口網頁與認證前允許的位址。手機與電腦要先查 DNS（captive.apple.com）才會跳出登入頁面，所以 DNS 伺服器一定要在允許的清單裡。'),
      (!s.sec || s.sec === 'open') && note('warn', '開放網路沒有任何加密，任何人都能連線，也能側錄別人的流量。'),
      s.sec === 'wep' && note('warn', 'WEP 的加密早已被破解，幾分鐘內就能算出密碼，不應該再使用。'),
      s.sec === 'wpa3' && note('muted', '純 WPA3 最安全，但比較舊的設備可能不支援。'),
      dev.kind === 'ap' && has6(dev) && !on6(s) && note('warn', '這個 SSID 不會在 6 GHz 廣播：6 GHz 規定要 WPA3。要讓支援 Wi-Fi 6E 的設備用 6 GHz，改成 WPA3 或 WPA2 / WPA3 混合。'),
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

/** 連接埠被 err-disabled：為什麼、會不會自己恢復、重新啟用（等於 shutdown → no shutdown） */
function errdisCard(ctx, p) {
  const { dev, state } = ctx;
  const r = errdisRows(state, dev).find((x) => x.pid === p.id);
  if (!r) return null;
  const why = r.cause === 'bpdu' ? 'BPDU Guard 偵測到對面是一台交換器' : r.cause === 'storm' ? 'Storm Control 偵測到廣播超過門檻' : '這個埠後面的 MAC 超過允許的數量（Port Security 違規）';
  const when = r.left != null ? `errdisable recovery 會在 ${fmtDur(r.left)}後試著打開（原因還在的話會再被關掉）。` : '沒有設定 errdisable recovery：原因排除之後也不會自己恢復。';
  return h('div', { class: 'note warn errdis' },
    h('span', { text: `err-disabled：${why}，整個埠被關閉${r.n > 1 ? `（第 ${r.n} 次）` : ''}。${when}` }),
    button('重新啟用（shutdown → no shutdown）', { small: true, onclick: () => { bouncePort(state, dev, p.id); toast(`${dev.name} ${p.label}：已經 shutdown 再 no shutdown`, 'ok'); ctx.commit(true); } }));
}

export function portAdvanced(ctx, p, pc) {
  const { dev, state } = ctx;
  const ps = (pc.ps ||= { on: false, macs: '', mode: 'shutdown' });
  if (pc.lag == null) pc.lag = '';
  if (!pc.lagMode) pc.lagMode = 'active';
  return h('div', { class: 'sub' },
    h('div', { class: 'toggles' },
      toggle(ctx, ...bind(pc, 'shut'), '停用此連接埠 (shutdown)'),
      dtpSpeaker(dev) && !/^dynamic/.test(pc.mode) && toggle(ctx, () => !!pc.noneg, (v) => { if (v) pc.noneg = true; else delete pc.noneg; }, '不送 DTP (switchport nonegotiate)：接使用者的埠建議打開，避免被偽裝成交換器的設備協商成 Trunk'),
      speaksCdp(dev) && toggle(ctx, () => portNd(dev, p.id).cdp !== false, (v) => setPortNd(dev, p.id, 'cdp', v), `CDP${cdpCfg(dev).run ? '' : '（整台的 CDP 已關閉）'}`),
      speaksLldp(dev) && toggle(ctx, () => portNd(dev, p.id).tx !== false, (v) => setPortNd(dev, p.id, 'tx', v), `LLDP 送出${lldpCfg(dev).run ? '' : '（整台的 LLDP 沒有開）'}`),
      speaksLldp(dev) && toggle(ctx, () => portNd(dev, p.id).rx !== false, (v) => setPortNd(dev, p.id, 'rx', v), 'LLDP 接收'),
      toggle(ctx, ...bind(pc, 'trust'), 'DHCP Snooping 信任埠（通往合法 DHCP 伺服器）'),
      toggle(ctx, () => portfastOn(dev, pc, p.id), (v) => { pc.portfast = v; }, 'PortFast（接終端設備的埠：連線後立刻轉送，不等 30 秒）'),
      toggle(ctx, ...bind(pc, 'bpduguard'), 'BPDU Guard（對面是交換器就關閉此埠）'),
      toggle(ctx, ...bind(pc, 'rootguard'), 'Root Guard（不允許這個埠後面的交換器成為根橋）'),
      toggle(ctx, () => loopGuardOn(dev, p.id), (v) => { pc.loopguard = v; if (v) pc.rootguard = false; }, 'Loop Guard（原本的 Root / Alternate 埠收不到 BPDU 時擋下來，不會變成 Designated）'),
      toggle(ctx, () => pc.bpdufilter === true, (v) => { if (v) pc.bpdufilter = true; else delete pc.bpdufilter; }, 'BPDU Filter（不送也不收 BPDU，等於這個埠沒有 STP：接到交換器會形成迴圈）'),
      toggle(ctx, ...bind(pc, 'dot1x'), '802.1X（通過 RADIUS 驗證才放行）'),
      toggle(ctx, ...bind(ps, 'on'), 'Port Security（限制這個埠後面最多幾個 MAC）', { rerender: true })),
    ctx.live(() => [
      errdisCard(ctx, p),
      dev.rt.err[p.id] === 'root' && note('warn', 'root-inconsistent：對面的交換器宣稱自己是更優先的根橋，Root Guard 把這個埠擋下了。對方不再搶根橋之後會自動恢復。'),
      pc.dot1x && (dev.rt.unauth && dev.rt.unauth[p.id] ? note('warn', '802.1X 尚未通過：' + dev.rt.unauth[p.id]) : note('ok', '802.1X 驗證通過，連接埠已放行。')),
    ]),
    L2.psecBlock(ctx, p, pc),
    L2.pvlanPortBlock(ctx, p, pc),
    L2.portGuards(ctx, p, pc),
    p.poe && h('div', { class: 'toggles' }, toggle(ctx, () => pc.poe !== 'never', (v) => { if (v) delete pc.poe; else pc.poe = 'never'; }, 'PoE 供電（power inline auto）')),
    V.portTrustField(ctx, pc),
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
      toggle(ctx, () => !!stp.portfastDefault, (v) => { stp.portfastDefault = v; }, 'PortFast 預設啟用（所有 Access 埠連線後立刻轉送）'),
      toggle(ctx, () => !!stp.bpduguardDefault, (v) => { stp.bpduguardDefault = v; }, 'PortFast 的埠預設開 BPDU Guard（portfast bpduguard default）'),
      toggle(ctx, () => !!stp.bpdufilterDefault, (v) => { stp.bpdufilterDefault = v; }, 'PortFast 的埠不送 BPDU（portfast bpdufilter default：收到 BPDU 就恢復正常）'),
      toggle(ctx, () => !!stp.loopguardDefault, (v) => { stp.loopguardDefault = v; }, 'Loop Guard 預設啟用（交換器之間的線：收不到 BPDU 就擋下，不會形成迴圈）')),
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
  const rec = sw.errRec || { causes: [] };
  const setCause = (c, on) => {
    const r = (sw.errRec ||= { causes: [] });
    r.causes = on ? [...new Set([...(r.causes || []), c])] : (r.causes || []).filter((x) => x !== c);
    if (!r.causes.length && !r.interval) delete sw.errRec;
  };
  body.append(h('div', { class: 'card' }, cardHead('err-disabled 自動恢復'),
    note('muted', 'BPDU Guard、Port Security 或 Storm Control（shutdown 模式）把埠關掉之後，預設會一直維持 err-disabled，要管理員 shutdown 再 no shutdown。打開自動恢復，計時器到了交換器會自己試著打開。'),
    h('div', { class: 'toggles' },
      toggle(ctx, () => (rec.causes || []).includes(ERR_CAUSES.bpdu), (v) => setCause(ERR_CAUSES.bpdu, v), 'BPDU Guard（errdisable recovery cause bpduguard）'),
      toggle(ctx, () => (rec.causes || []).includes(ERR_CAUSES.psec), (v) => setCause(ERR_CAUSES.psec, v), 'Port Security 違規（errdisable recovery cause psecure-violation）'),
      toggle(ctx, () => (rec.causes || []).includes(ERR_CAUSES.storm), (v) => setCause(ERR_CAUSES.storm, v), 'Storm Control（errdisable recovery cause storm-control）')),
    field('計時器（秒）', inp(ctx, () => String((sw.errRec && sw.errRec.interval) || ERR_RECOVERY_DEFAULT), (v) => {
      const n = +v;
      if (!(n >= 30 && n <= 86400)) return;
      const r = (sw.errRec ||= { causes: [] });
      if (n === ERR_RECOVERY_DEFAULT) delete r.interval; else r.interval = n;
      if (!r.causes.length && !r.interval) delete sw.errRec;
    }, { ph: '300', check: isNum(30, 86400) }), '30 – 86400，預設 300'),
    ctx.live(() => {
      const rows = errdisRows(state, dev);
      if (!rows.length) return note('ok', '目前沒有 err-disabled 的埠。');
      return rows.map((x) => h('div', { class: 'line' }, h('b', { class: 'mono', text: x.pid }), h('span', { class: 'muted', text: ERR_CAUSES[x.cause] }),
        badge('warn', x.left != null ? `${fmtDur(x.left)}後恢復` : '要手動恢復')));
    })));
  L2.l2secCards(ctx, body);
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
  if (!speaksCdp(dev) && !speaksLldp(dev)) return null;
  const tidy = () => { for (const k of ['cdp', 'lldp']) if (dev[k] && !Object.keys(dev[k]).some((x) => dev[k][x] !== undefined)) delete dev[k]; };
  return h('div', { class: 'card' }, cardHead('鄰居 (CDP / LLDP)'),
    h('div', { class: 'toggles' },
      speaksCdp(dev) && toggle(ctx, () => cdpCfg(dev).run, (v) => { (dev.cdp ||= {}).run = v ? undefined : false; tidy(); }, `CDP（Cisco 專屬，每 ${cdpCfg(dev).timer} 秒通告一次，holdtime ${cdpCfg(dev).hold} 秒）`),
      toggle(ctx, () => lldpCfg(dev).run, (v) => { (dev.lldp ||= {}).run = v; }, `LLDP（IEEE 802.1AB，每 ${lldpCfg(dev).timer} 秒，holdtime ${lldpCfg(dev).hold} 秒）`)),
    ctx.live(() => {
      const rows = neighbors(state, dev);
      if (!rows.length) return note('muted', cdpCfg(dev).run || lldpCfg(dev).run ? '還沒有收到任何通告。對面不講 CDP / LLDP（電腦、非 Cisco 設備），或對面把它關掉了。' : 'CDP 與 LLDP 都沒有開，看不到任何鄰居。');
      return rows.map((r) => h('div', { class: 'line' }, h('b', { class: 'mono', text: r.label }), h('span', { class: 'chip tiny', text: r.proto.toUpperCase() }),
        h('span', { text: `${r.info.id} · ${r.info.port}` }),
        h('span', { class: 'muted', style: { marginLeft: 'auto' }, text: `${r.info.platform}${r.info.ip ? ' · ' + r.info.ip : ''} · 剩 ${r.left} 秒` })));
    }),
    note('muted', '鄰居是從收到的通告學來的：對面關掉 CDP 之後，要等 holdtime 過了才會從表上消失。接使用者的埠常會關掉 CDP，避免洩漏型號與版本。'));
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
  const zc = zbfCard(ctx);
  if (zc) body.append(zc);
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
            sel(ctx, () => r.proto, (v) => { r.proto = v; if (v !== 'icmp') delete r.icmp; if (v !== 'tcp' && v !== 'udp') r.port = ''; }, [['ip', 'ip（全部）'], ['tcp', 'tcp'], ['udp', 'udp'], ['icmp', 'icmp']], { rerender: true }),
            r.proto === 'icmp' ? sel(ctx, () => r.icmp || '', (v) => { if (v) r.icmp = v; else delete r.icmp; }, [['', '全部類型'], ...ICMP_TYPES.map((t) => [t, t])])
              : inp(ctx, ...bind(r, 'port'), { ph: '埠', check: isPortNo, w: '58px' }),
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
  acl6Cards(ctx, body);
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
        t.ikev2 ? null : field('預先共用金鑰 (PSK)', inp(ctx, ...bind(t, 'psk'), { ph: +t.ike === 2 ? '這一端用來簽的金鑰' : '兩端必須相同' })),
        t.ikev2 ? null : field('IKE 版本', sel(ctx, () => String(+t.ike === 2 ? 2 : 1), (v) => { if (v === '2') t.ike = 2; else { delete t.ike; delete t.pskRemote; } }, [['1', 'IKEv1（Main Mode + Quick Mode）'], ['2', 'IKEv2（IKE_SA_INIT + IKE_AUTH）']], { rerender: true })),
        !t.ikev2 && +t.ike === 2 ? field('對端的金鑰（選填）', inp(ctx, () => t.pskRemote || '', (v) => { if (v) t.pskRemote = v; else delete t.pskRemote; }, { ph: '留空＝和上面同一把；IKEv2 兩個方向可以不同' })) : null,
        field('本地網段', inp(ctx, ...bind(t, 'local'), { ph: '例如 10.2.0.0/24', check: isCidrList })),
        field('遠端網段', inp(ctx, ...bind(t, 'remote'), { ph: '例如 10.1.0.0/24', check: isCidrList })),
        !(dev.isakmp && dev.isakmp.length) && field('第一階段 (IKE) 加密', sel(ctx, () => t.enc || 'aes128', (v) => { t.enc = v; }, [['aes128', 'AES128'], ['aes256', 'AES256']])),
        !(dev.isakmp && dev.isakmp.length) && field('第一階段雜湊', sel(ctx, () => t.hash || 'sha1', (v) => { t.hash = v; }, [['sha1', 'SHA1'], ['sha256', 'SHA256']])),
        !(dev.isakmp && dev.isakmp.length) && field('第一階段 DH 群組', sel(ctx, () => t.dh || '2', (v) => { t.dh = v; }, DH_GROUPS)),
        field('第二階段 (IPsec) 加密', sel(ctx, () => t.enc2 || '', (v) => { t.enc2 = v; }, [['', '和第一階段相同'], ['aes128', 'AES128'], ['aes256', 'AES256']])),
        field('第二階段雜湊', sel(ctx, () => t.hash2 || '', (v) => { t.hash2 = v; }, [['', '和第一階段相同'], ['sha1', 'SHA1'], ['sha256', 'SHA256']])),
        field('PFS（第二階段再做一次 DH）', sel(ctx, () => t.pfs || '', (v) => { t.pfs = v; }, [['', '不使用'], ...DH_GROUPS]))),
      t.ikev2 ? note('muted', `這個通道用 IKEv2：金鑰、提案與對端身分由 CLI 的 crypto ikev2 profile「${t.ikev2}」決定（keyring、policy、proposal）。`)
        : +t.ike !== 2 && dev.isakmp && dev.isakmp.length > 0 && note('muted', `第一階段的提案由 CLI 的 crypto isakmp policy 管理，整台設備共用：${dev.isakmp.map((p) => `#${p.n} ${P1(p)}`).join('；')}`),
      grid2(
        !(dev.isakmp && dev.isakmp.length) && field('第一階段金鑰壽命（秒）', inp(ctx, () => t.life1 || '', (v) => { t.life1 = +v > 0 ? +v : undefined; }, { ph: '預設 86400', check: isNum(120, 172800) })),
        field('第二階段金鑰壽命（秒）', inp(ctx, () => t.life2 || '', (v) => { t.life2 = +v > 0 ? +v : undefined; }, { ph: dev.kind === 'firewall' ? '預設 43200' : '預設 3600', check: isNum(120, 172800) })),
        dev.kind === 'firewall' && field('對端失聯偵測 (DPD)', sel(ctx, () => t.dpd || 'on-demand', (v) => { t.dpd = v === 'on-demand' ? undefined : v; },
          [['on-demand', '開啟：每 20 秒探測，三次沒回應就拆掉通道'], ['disable', '關閉：要等金鑰到期才會發現']]))),
      ctx.live(() => {
        const r = t.rt || {}, sa = saInfo(state, dev.id, t.name || 'VPN');
        if (r.nego) return note('warn', `正在協商 (${r.ver === 2 ? 'IKEv2' : 'IKE'})，大約再 ${Math.ceil(r.nego)} 秒建立。`);
        if (r.up && r.stale) {
          return note('warn', `這一端的通道看起來還是 Up，但對端已經沒有回應（${r.staleWhy}）。再 ${fmtDur(r.stale - state.clock)} 才會判定失聯${dev.kind === 'firewall' || dev.ikeKeepalive ? '' : '：沒有設定 keepalive，只能等金鑰到期'}，這段時間往對端的封包都會被丟掉。`);
        }
        if (!r.up) return note('warn', '通道未建立：' + (r.why || '設定中'));
        return [note('ok', `通道已建立 (Up) · IKEv${r.ver || 1}`), r.pfsBad && note('warn', `${r.pfsBad}。IKEv2 的第一個 CHILD_SA 是在 IKE_AUTH 裡建立的，不做 PFS，所以現在通；${fmtDur(Math.max(0, r.rekeyFail - state.clock))}後第一次重新協商時會失敗，通道就斷了。`), sa && h('div', { class: 'kv ok' },
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
  if (dev.kind === 'router') ipsecCards(ctx, body);
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
        field('發給用戶端的 DNS', inp(ctx, ...bind(s, 'dns'), { ph: '例如 8.8.8.8', check: isIpList })),
        field('TFTP 伺服器（option 150 / 66）', inp(ctx, ...bind(s, 'tftp'), { ph: 'IP 電話下載設定檔用', check: isIpList }))),
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

