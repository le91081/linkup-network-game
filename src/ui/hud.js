// HUD：頂端列、任務面板、封包追蹤主控台、各種對話框
import { h, icon, button, toast, faceplate } from './dom.js';
import { LEVELS, CHAPTERS } from '../levels/index.js';
import { CATALOG, CABLES, cableKinds, cableKind, pairDist, cableAt, portOf, removeCable, linkInfo } from '../engine/model.js';
import { fmtIp } from '../engine/ip.js';
import { pendingOf, fmtDur } from '../engine/sim.js';
import { renderSandbox } from './sandbox.js';
import { LEVEL_CERTS } from '../data/certs.js';
import { openQuiz, openCerts, openLevelQuiz, hasLevelQuiz } from './quiz.js';

const LOGO =
  '<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#111a38"/><path d="M9 21c5 0 4-10 14-10" stroke="#4fd8c4" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="9" cy="21" r="3.5" fill="#6ea8ff"/><circle cx="23" cy="11" r="3.5" fill="#4fd8c4"/></svg>';

export const levelNo = (lv) => (lv.sandbox ? '∞' : `${lv.chapter}-${LEVELS.filter((l) => l.chapter === lv.chapter).indexOf(lv) + 1}`);

// ───────────── 頂端列 ─────────────
export function renderTopbar(app) {
  const lv = app.level;
  const ch = CHAPTERS.find((c) => c.id === lv.chapter);
  app.el.topbar.replaceChildren(
    h('div', { class: 'brand', html: LOGO + '<span>Link<em>Up</em></span>' }),
    h('div', { class: 'crumb' }, h('span', { text: ch ? `第 ${ch.id} 章 · ${ch.title}` : '自由模式' }), h('b', { text: ch ? `${levelNo(lv)}　${lv.title}` : lv.subtitle })),
    h('div', { class: 'spacer' }),
    h('div', { class: 'histbtns' },
      h('button', { class: 'btn ghost icon', id: 'btn-undo', type: 'button', title: '復原上一個變更（Ctrl + Z）', disabled: !app.undoStack.length, onclick: () => app.undo() }, icon('undo', 16)),
      h('button', { class: 'btn ghost icon', id: 'btn-redo', type: 'button', title: '重做（Ctrl + Y）', disabled: !app.redoStack.length, onclick: () => app.redo() }, icon('redo', 16))),
    button('測驗', { ic: 'book', kind: 'ghost', onclick: () => openQuiz(app) }),
    button('證照', { ic: 'award', kind: 'ghost', onclick: () => openCerts(app) }),
    button('提示', { ic: 'bulb', kind: 'ghost', onclick: () => openHints(app) }),
    button('重置', { ic: 'reset', kind: 'ghost', onclick: () => confirmReset(app) }),
    button('說明', { ic: 'help', kind: 'ghost', onclick: () => openHelp(app) }),
    button('關卡', { ic: 'grid', onclick: () => openLevels(app) }),
  );
}

/** 復原 / 重做按鈕能不能按 */
export function updateHistory(app) {
  for (const [id, stack] of [['btn-undo', app.undoStack], ['btn-redo', app.redoStack]]) {
    const b = document.getElementById(id);
    if (b) b.disabled = !stack.length;
  }
}

// ───────────── 任務面板 ─────────────
export function renderMission(app) {
  const lv = app.level;
  if (lv.sandbox) return renderSandbox(app);
  const root = app.el.mission;
  const keep = root.querySelector('.m-scroll')?.scrollTop || 0;
  let anyStale = false;
  const objs = lv.objectives.map((o, i) => {
    const r = app.results[i];
    const st = r === 'running' ? 'running' : !r ? '' : r.pass ? 'pass' : 'fail';
    if (r && r.stale) anyStale = true;
    const why = st !== 'fail' ? '' : o.expect === false ? '這條連線應該被擋下來，但現在是通的。' : r.reason;
    return h('button', { type: 'button', class: `obj ${st} ${r && r.stale ? 'old' : ''}`, title: '點一下只測試這一項', onclick: () => app.run([i]) },
      h('span', { class: 'st' }, st === 'pass' ? icon('check', 13) : st === 'fail' ? icon('x', 13) : null),
      h('span', { class: 'lb', text: o.label }),
      why && h('span', { class: 'why', text: why }));
  });
  const copy = (v) => () => navigator.clipboard?.writeText(v).then(() => toast('已複製：' + v), () => {});
  const scroll = h('div', { class: 'm-scroll' },
    h('div', { class: 'm-head' }, h('span', { class: 'm-no', text: levelNo(lv) }), h('div', null, h('h1', { text: lv.title }), h('p', { text: lv.subtitle }))),
    h('div', { class: 'chips' }, lv.tags.map((t) => h('span', { class: 'chip', text: t }))),
    LEVEL_CERTS[lv.id] && h('div', { class: 'chips', title: '這一關對應的證照考試條目（點一下開啟證照地圖）', onclick: () => openCerts(app) },
      LEVEL_CERTS[lv.id].slice(0, 4).map((t) => h('span', { class: 'chip cert', text: t })),
      LEVEL_CERTS[lv.id].length > 4 && h('span', { class: 'chip cert', text: `+${LEVEL_CERTS[lv.id].length - 4}` })),
    h('p', { class: 'brief', text: lv.brief }),
    lv.given && h('h3', { class: 'sec', text: '已知資訊' }),
    lv.given && h('div', { class: 'given' }, lv.given.map(([k, v]) => h('div', { class: 'g-row' }, h('span', { text: k }), h('b', { class: 'mono', text: v, title: '點一下複製', onclick: copy(v) })))),
    h('h3', { class: 'sec', text: '任務目標' }),
    h('div', { class: 'objs' }, objs),
    anyStale && h('div', { class: 'stale-note', text: '設定已經變更，變淡的結果需要重新測試。' }),
  );
  root.replaceChildren(scroll,
    h('div', { class: 'm-foot' },
      button(app.running ? '測試中… 按空白鍵快轉' : '執行測試', { ic: app.running ? 'fast' : 'play', kind: 'primary big', onclick: () => (app.running ? app.fastForward() : app.run()) }),
      h('small', { text: '點單一目標可以只測試那一項' })));
  scroll.scrollTop = keep;
}

// ───────────── 右側：沒有選取設備時顯示學習筆記 ─────────────
export function renderGuide(app, root) {
  const lv = app.level;
  root.dataset.view = '';
  root.replaceChildren(
    h('div', { class: 'p-head' }, h('div', { class: 'p-badge', text: '學習筆記' }),
      h('div', { class: 'p-title' }, h('h2', { text: '這一關的新觀念' }), h('p', { class: 'muted', text: '點場景中的設備，這裡會變成它的設定頁面' }))),
    h('div', { class: 'p-body' },
      lv.learn.map((c) => h('div', { class: 'card learn' }, h('b', { text: c.t }), h('p', { text: c.d }))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('b', { text: '操作方式' })),
        h('div', { class: 'keys' },
          h('div', null, h('kbd', { text: '拖曳設備' }), '拉到另一台設備上放開 → 接上網路線'),
          h('div', null, h('kbd', { text: '點設備' }), '開啟設定頁面'),
          h('div', null, h('kbd', { text: '點網路線' }), '查看速率與距離、拔除'),
          h('div', null, h('kbd', { text: '點追蹤紀錄' }), '標著「封包」的那幾行可以打開，看 MAC / IP / 埠號'),
          h('div', null, h('kbd', { text: 'Ctrl + Z' }), '復原上一個變更，Ctrl + Y 重做'),
          h('div', null, h('kbd', { text: '時鐘' }), '場景上方的時鐘可以暫停、加速，或快轉到網路穩定'),
          h('div', null, h('kbd', { text: '拖曳空白處' }), '平移畫面，滾輪縮放，右鍵拖曳旋轉'),
          h('div', null, h('kbd', { text: '空白鍵' }), '快轉封包動畫'))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('b', { text: '圖例' })),
        h('div', { class: 'legend' },
          h('span', null, h('i', { style: { background: '#4f9cf9' } }), 'Cat6 銅纜'),
          h('span', null, h('i', { class: 'dotp', style: { background: '#7df3ff' } }), '請求封包'),
          h('span', null, h('i', { style: { background: '#f5b547' } }), 'DAC 直連銅纜'),
          h('span', null, h('i', { class: 'dotp', style: { background: '#7dffb0' } }), '回應封包'),
          h('span', null, h('i', { style: { background: '#35d6c1' } }), '多模光纖'),
          h('span', null, h('i', { class: 'dotp', style: { background: '#c9b0ff' } }), 'DNS 查詢'),
          h('span', null, h('i', { style: { background: '#f7e04a' } }), '單模光纖'),
          h('span', null, h('i', { class: 'dotp', style: { background: '#ffc857' } }), 'VPN 加密封包'),
          h('span', null, h('i', { style: { background: '#4a5470' } }), '沒有燈號的線'),
          h('span', null, h('i', { style: { background: '#9a7a2e' } }), '被 STP 封鎖'),
          h('span', null, h('i', { class: 'dotp', style: { background: '#ff9f5a' } }), 'ARP（詢問 MAC）'),
          h('span', null, h('i', { class: 'dotp', style: { background: '#ff8fd0' } }), 'DHCP 交握'),
          h('span', null, h('i', { style: { background: '#f5a623' } }), 'STP 還在等待（閃爍）')))),
  );
}

// ───────────── 模擬時鐘 ─────────────
export const fmtClock = (t) => {
  const s = Math.floor(t), d = Math.floor(s / 86400);
  const two = (n) => String(n).padStart(2, '0');
  return (d ? `${d} 天 ` : '') + `${two(Math.floor((s % 86400) / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
};

export function initClock(app) {
  const time = h('b', { class: 'mono ck-time' });
  const play = h('button', { class: 'mini', type: 'button', onclick: () => { app.paused = !app.paused; updateClock(app); } });
  const speeds = h('div', { class: 'ck-speeds' }, [1, 10, 60].map((v) => h('button', {
    type: 'button', class: 'ck-sp', data: { v }, text: v + '×', title: `時間以 ${v} 倍速前進`,
    onclick: () => { app.speed = v; app.paused = false; updateClock(app); },
  })));
  const skip = h('button', { class: 'btn sm ghost', type: 'button', title: '讓時間直接前進 30 秒', onclick: () => app.skip(30) }, '+30 秒');
  const pend = h('button', { class: 'btn sm ck-pend', type: 'button', onclick: () => app.settleNow() });
  const el = h('div', { id: 'clock', class: 'glass', title: '模擬時間：STP、OSPF、VRRP、DHCP 租約、ARP 快取都照這個時鐘走' }, play, time, speeds, skip, pend);
  document.body.append(el);
  app.clockUi = { el, time, play, speeds, pend };
  updateClock(app);
}

export function updateClock(app) {
  const u = app.clockUi;
  if (!u || !app.state) return;
  u.time.textContent = 'T+' + fmtClock(app.state.clock || 0);
  u.play.replaceChildren(icon(app.paused ? 'play' : 'pause', 13));
  u.play.title = app.paused ? '時間暫停中，點一下繼續' : '暫停時間';
  for (const b of u.speeds.children) b.classList.toggle('on', !app.paused && +b.dataset.v === app.speed);
  u.el.classList.toggle('paused', !!app.paused);
  const p = pendingOf(app.state);
  u.pend.style.display = p.length ? '' : 'none';
  if (p.length) {
    const left = p[p.length - 1].at - app.state.clock;
    u.pend.replaceChildren(icon('fast', 13), h('span', { text: `收斂中，還要 ${fmtDur(left)}` }));
    u.pend.title = '點一下讓時間快轉到網路穩定為止\n\n' + [...new Set(p.map((x) => x.text))].slice(0, 8).join('\n');
  }
}

// ───────────── 封包追蹤主控台 ─────────────
export function initConsole(app) {
  const root = app.el.console;
  const body = h('div', { class: 'c-body' });
  const sub = h('span', { class: 'c-sub' });
  root.replaceChildren(
    h('div', { class: 'c-head', title: '收合 / 展開', onclick: () => root.classList.toggle('min') }, icon('terminal', 15), h('b', { text: '封包追蹤' }), sub, h('span', { class: 'mini' }, icon('down', 14))),
    body,
  );
  const end = () => { body.scrollTop = body.scrollHeight; };
  return {
    clear() { body.replaceChildren(); sub.textContent = ''; },
    empty() {
      body.replaceChildren(h('div', { class: 'c-empty', text: '按「執行測試」，或在電腦的終端機輸入 ping，這裡會列出封包一站一站怎麼走、在哪裡被丟掉。' }));
      sub.textContent = '';
    },
    group(title) { body.append(h('div', { class: 'cg', text: title })); sub.textContent = title; end(); },
    lines(log, state) {
      for (const l of log) {
        body.append(h('div', {
          class: 'cl k-' + l.kind + (l.frame ? ' has-frame' : ''), title: l.frame ? '點一下檢視這個封包的標頭' : null,
          onclick: (e) => { app.scene.pulse(l.dev, 0xffffff); if (l.frame) openFrame(l, state, e.clientX, e.clientY); },
        },
          h('span', { class: 'who', text: state.devices[l.dev]?.name || '' }),
          h('span', { class: 'msg' }, l.text, l.frame && h('i', { class: 'fr-chip', text: '封包' }))));
      }
      end();
    },
    result(ok, text) { body.append(h('div', { class: 'cr ' + (ok ? 'pass' : 'fail'), text })); end(); },
  };
}

// ───────────── 對話框 ─────────────
let modalClose = null;
export function modal(content, { wide, onClose } = {}) {
  closeModal();
  const dlg = h('div', { class: 'dialog' + (wide ? ' wide' : '') }, content);
  const bd = h('div', { class: 'backdrop', onpointerdown: (e) => { if (e.target === bd) closeModal(); } }, dlg);
  document.getElementById('modal-root').append(bd);
  modalClose = () => { bd.remove(); modalClose = null; onClose?.(); };
  return dlg;
}
export function closeModal() { if (modalClose) modalClose(); }
export const modalOpen = () => !!modalClose;

let popover = null;
function onDocDown(e) { if (popover && !popover.contains(e.target)) closePopover(); }
export function closePopover() {
  if (!popover) return;
  popover.remove(); popover = null;
  document.removeEventListener('pointerdown', onDocDown, true);
}

const PORT_NAMES = { 22: 'SSH', 23: 'Telnet', 53: 'DNS', 67: 'DHCP', 80: 'HTTP', 123: 'NTP', 161: 'SNMP', 443: 'HTTPS', 500: 'IKE', 514: 'Syslog', 1812: 'RADIUS', 3306: 'MySQL', 3389: 'RDP', 4500: 'IPsec NAT-T' };
const PROTO_NO = { icmp: 1, tcp: 6, udp: 17, esp: 50 };

/** 封包檢視：追蹤紀錄裡某一段訊框的第二、三、四層標頭 */
function openFrame(l, state, x, y) {
  closePopover();
  const f = l.frame;
  const port = (p) => (PORT_NAMES[p] ? `${p}（${PORT_NAMES[p]}）` : String(p));
  const layer = (no, name, text, extra) => h('div', { class: 'fr-layer l' + no },
    h('span', { class: 'fr-no', text: 'L' + no }),
    h('div', null, h('b', { text: name }), h('span', { class: 'mono', text }), extra && h('em', { text: extra })));
  const upper = f.proto === 'icmp'
    ? layer(3, 'ICMP', f.reply ? 'Echo Reply（type 0）' : 'Echo Request（type 8）', `識別碼 ${f.reply ? f.dport : f.sport} · ICMP 沒有埠號，靠識別碼配對請求與回應`)
    : f.proto === 'esp' && f.ssl
      ? layer(4, 'TCP + TLS（SSL-VPN）', '加密的內容', '原本的封包包在用戶端與 VPN 伺服器之間的 TLS 連線裡。對中途的設備來說，這只是一條普通的 TCP 連線，所以可以穿過 NAT')
      : f.proto === 'esp'
      ? layer(3, 'ESP（IPsec）', '加密的內容', '原本的 IP 標頭、埠號與資料都包在裡面，中途的設備只看得到兩端 VPN 閘道的位址')
      : layer(4, f.proto.toUpperCase(), `埠 ${port(f.sport)}  →  埠 ${port(f.dport)}`,
        f.proto === 'tcp' ? (f.ack ? '旗標 ACK：三向交握的第三步，連線建立完成' : f.reply ? '旗標 SYN + ACK：三向交握的第二步' : '旗標 SYN：三向交握的第一步，請求建立連線') : 'UDP 不建立連線，直接送出');
  popover = h('div', { class: 'popover frame', style: { left: Math.max(12, Math.min(x - 60, innerWidth - 404)) + 'px' } },
    h('div', { class: 'fr-head' }, h('b', { text: '封包檢視' }), h('span', { text: `${state.devices[l.dev]?.name || ''} 送出的這一段` })),
    layer(2, f.wifi ? '乙太網路 / 802.11 無線' : '乙太網路', `${f.smac}  →  ${f.dmac}`,
      f.tags.length ? `經過 Trunk 時帶著 802.1Q 標籤：VLAN ${f.tags.join('、')}` : '來源 MAC → 目的 MAC，只在這一段線路上有效'),
    layer(3, 'IPv4', `${fmtIp(f.src)}  →  ${fmtIp(f.dst)}`, `TTL ${f.ttl} · 協定號 ${f.ssl ? '6（TCP）' : `${PROTO_NO[f.proto]}（${f.proto.toUpperCase()}）`}`),
    upper,
    h('p', { class: 'fr-note', text: '每經過一台路由器，MAC 位址就換成下一段的；IP 位址從頭到尾不變（經過 NAT 除外），TTL 每一站減 1。' }));
  document.body.append(popover);
  // 盡量放在點擊位置的上方，但不能超出視窗
  const ph = popover.offsetHeight;
  popover.style.top = Math.max(8, Math.min(y - ph - 14, innerHeight - ph - 8)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
}

export function openCableMenu(app, cableId, x, y) {
  closePopover();
  const st = app.state;
  const c = st.cables.find((k) => k.id === cableId);
  if (!c) return;
  const A = st.devices[c.a.dev], B = st.devices[c.b.dev];
  const li = !st.rt.why[c.id] && st.rt.cable[c.id] !== 'down' && linkInfo(st, c.a.dev, c.a.port);
  popover = h('div', { class: 'popover', style: { left: Math.min(x + 6, innerWidth - 300) + 'px', top: Math.min(y + 10, innerHeight - 190) + 'px' } },
    h('b', { text: CABLES[cableKind(c)].name }),
    h('span', { class: 'mono', text: `${A.name} [${portOf(A, c.a.port).label}]  ↔  ${B.name} [${portOf(B, c.b.port).label}]` }),
    h('span', { class: 'muted', style: { fontSize: '12px' }, text: `兩端相距 ${pairDist(st, A.id, B.id)} 公尺 · 這種線材最長 ${CABLES[cableKind(c)].max} 公尺` }),
    li && h('span', { class: 'muted', style: { fontSize: '12px' }, text: `自動協商：${li.text}` }),
    li && li.half && h('span', { class: 'note warn', text: '半雙工：同一時間只能有一端傳送，否則會碰撞 (CSMA/CD)。' }),
    li && li.mismatch && h('span', { class: 'note warn', text: '雙工不一致 (duplex mismatch)：線是通的，但全雙工的那一端不會等對方，會造成大量碰撞與 CRC 錯誤，實際速度極慢。兩端都改成自動協商，或兩端寫死成一樣。' }),
    st.rt.why[c.id] && h('span', { class: 'note warn', text: '沒有燈號：' + st.rt.why[c.id] }),
    st.rt.cable[c.id] === 'blocked' && h('span', { class: 'note muted', text: '這條線被 STP 封鎖當作備援，其他路徑斷掉時會自動啟用。' }),
    st.rt.cable[c.id] === 'susp' && h('span', { class: 'note warn', text: 'Port-channel 兩端的設定不相容，成員被暫停。' }),
    button('拔除這條線', { ic: 'unplug', small: true, onclick: () => { removeCable(st, cableId); closePopover(); toast('已拔除網路線'); app.changed(); app.renderPanel(); } }));
  document.body.append(popover);
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
}

export function openPortPick(app, aId, bId) {
  const st = app.state;
  const A = st.devices[aId], B = st.devices[bId];
  const free = (d) => d.ports.filter((p) => !cableAt(st, d.id, p.id));
  const first = (d, media) => free(d).find((p) => p.media === media);
  const pick = { a: null, b: null };
  let kind = null;
  for (const pa of free(A)) {
    const pb = first(B, pa.media);
    if (pb) { pick.a = pa.id; pick.b = pb.id; break; }
  }
  const dlg = modal([]);
  const draw = () => {
    const side = (d, key, od, okey) => h('div', { class: 'pp-dev' },
      h('div', { class: 'ttl' }, h('b', { text: d.name }), h('span', { text: CATALOG[d.model].title }), h('em', { text: pick[key] ? portOf(d, pick[key]).label : '請選擇連接埠' })),
      faceplate(st, d, {
        selected: pick[key],
        pickable: (p) => (cableAt(st, d.id, p.id) ? '已經插了線' : free(od).some((q) => q.media === p.media) ? true : '對方沒有相同規格的空埠'),
        onPick: (p) => {
          pick[key] = p.id;
          const o = pick[okey] && portOf(od, pick[okey]);
          if (!o || o.media !== p.media) pick[okey] = first(od, p.media)?.id || null;
          draw();
        },
      }));
    const ok = pick.a && pick.b;
    const kinds = ok ? cableKinds(portOf(A, pick.a).media) : [];
    if (!kinds.includes(kind)) kind = kinds[0];
    const dist = pairDist(st, aId, bId);
    const kindSel = kinds.length > 1 && h('select', { class: 'inp sel', onchange: (e) => { kind = e.target.value; draw(); } },
      kinds.map((k) => h('option', { value: k, selected: k === kind, text: `${CABLES[k].name}（最長 ${CABLES[k].max >= 1000 ? CABLES[k].max / 1000 + ' 公里' : CABLES[k].max + ' 公尺'}）` })));
    const tooFar = ok && dist > CABLES[kind].max;
    const go = button('接上網路線', { ic: 'cable', kind: 'primary', onclick: () => { closeModal(); app.connect(aId, pick.a, bId, pick.b, kind); } });
    go.disabled = !ok;
    dlg.replaceChildren(...[
      h('h2', { text: '選擇連接埠' }),
      h('p', { class: 'muted', text: '亮綠燈的埠已經插了線。不同規格的接頭（RJ45 / SFP / QSFP）不能互接。' }),
      side(A, 'a', B, 'b'), side(B, 'b', A, 'a'),
      ok && h('div', { class: 'pp-cable' },
        h('label', { class: 'field' }, h('span', { class: 'f-label', text: `線材 · 這兩台設備相距 ${dist} 公尺` }),
          kindSel || h('div', { class: 'inp', style: { display: 'flex', alignItems: 'center' }, text: `${CABLES[kind].name}（最長 ${CABLES[kind].max} 公尺）` })),
        tooFar && h('div', { class: 'note warn', text: `${CABLES[kind].name}最長只能拉 ${CABLES[kind].max} 公尺，接上去也不會有燈號。${kinds.length > 1 ? '請換一種線材。' : '這個距離需要改用光纖（SFP 埠）。'}` })),
      h('div', { class: 'd-actions' }, button('取消', { kind: 'ghost', onclick: closeModal }), go)].filter(Boolean));
  };
  draw();
}

export function openLevels(app) {
  const done = app.store.done;
  const n = LEVELS.filter((l) => done[l.id]).length;
  modal([
    h('div', { class: 'hero' }, h('div', { html: LOGO }),
      h('div', null, h('h1', { html: 'Link<em>Up</em>' }), h('p', { text: '從一條網路線到一座資料中心 — 親手接線、親手設定，讓封包抵達目的地。' })),
      h('div', { class: 'prog' }, h('b', { text: `${n} / ${LEVELS.length}` }), h('span', { text: '已完成關卡' }))),
    h('button', { type: 'button', class: 'lv sbx-card' + (app.level && app.level.sandbox ? ' cur' : ''), onclick: () => { closeModal(); app.openSandbox(); } },
      h('div', { class: 'top' }, h('span', { class: 'no', text: '∞  自由模式' })),
      h('b', { text: '自己擺設備、自由接線' }), h('p', { text: '沒有任務目標的沙盒。所有設備與功能都可以用，適合自己練習拓撲或重現工作上遇到的情境。' })),
    CHAPTERS.map((ch) => h('section', { class: 'chapter' },
      h('h2', null, `第 ${ch.id} 章　${ch.title}`, h('small', { text: ch.desc })),
      h('div', { class: 'lv-grid' }, LEVELS.filter((l) => l.chapter === ch.id).map((lv) => {
        const d = done[lv.id];
        return h('button', {
          type: 'button', class: `lv ${d ? 'done' : ''} ${lv === app.level ? 'cur' : ''}`,
          onclick: () => { closeModal(); app.loadLevel(LEVELS.indexOf(lv)); if (!app.store.seenHelp) openHelp(app); },
        },
        h('div', { class: 'top' }, h('span', { class: 'no', text: levelNo(lv) + (d ? '  ✓' : '') }),
          h('span', { class: 'stars' }, [1, 2, 3].map((s) => { const i = icon('star', 13); if (d && d.stars >= s) i.classList.add('on'); return i; }))),
        h('b', { text: lv.title }), h('p', { text: lv.subtitle }),
        h('div', { class: 'chips' }, lv.tags.slice(0, 3).map((t) => h('span', { class: 'chip', text: t }))));
      })))),
  ], { wide: true });
}

export function openHelp(app) {
  app.store.seenHelp = true;
  app.saveStore();
  const step = (ic, t, d) => h('div', { class: 'step' }, h('i', null, icon(ic, 18)), h('div', null, h('b', { text: t }), h('p', { text: d })));
  modal([
    h('h2', { text: '怎麼玩' }),
    h('p', { class: 'muted', text: '你是網路工程師。每一關都有客戶的需求，想辦法讓封包抵達目的地。' }),
    h('div', { class: 'steps' },
      step('cable', '1. 接線', '在一台設備上按住滑鼠，拖曳到另一台設備再放開。需要選擇連接埠時會跳出設備的面板圖。'),
      step('mouse', '2. 設定', '點一下設備，右側會出現它的管理頁面：IP、DHCP、VLAN、路由、NAT、防火牆政策…'),
      step('play', '3. 測試', '按「執行測試」，看封包沿著網路線一站一站前進。卡住的地方會直接告訴你原因。'),
      step('terminal', '4. 除錯', '打開電腦的「終端機」分頁，用 ping、tracert、ipconfig、nslookup 自己找問題。')),
    h('div', { class: 'd-actions' }, button('開始', { kind: 'primary', onclick: closeModal })),
  ]);
}

export function openHints(app) {
  const lv = app.level;
  const draw = () => modal([
    h('h2', { text: '提示' }),
    h('p', { class: 'muted', text: app.hintsShown ? '每看一個提示會少一顆星，最少保留一顆。' : '卡住了嗎？建議先按「執行測試」，看封包追蹤卡在哪一站。每看一個提示會少一顆星，最少保留一顆。' }),
    lv.hints.slice(0, app.hintsShown).map((t, i) => h('div', { class: 'hint-item' }, h('b', { text: i + 1 }), h('span', { text: t }))),
    h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: closeModal }),
      app.hintsShown < lv.hints.length && button(app.hintsShown ? '再給一個提示' : '顯示第一個提示', { ic: 'bulb', kind: 'primary', onclick: () => { app.useHint(); draw(); } })),
  ]);
  draw();
}

export function confirmReset(app) {
  modal([
    h('h2', { text: '重置這一關？' }),
    h('p', { class: 'muted', text: '所有接線與設定都會回到關卡一開始的狀態。' }),
    h('div', { class: 'd-actions' }, button('取消', { kind: 'ghost', onclick: closeModal }),
      button('重置', { ic: 'reset', kind: 'primary', onclick: () => { closeModal(); app.openLevel(app.level, { fresh: true }); toast(app.level.sandbox ? '已清空桌面' : '已重置關卡'); } })),
  ]);
}

/** IOS 設備有尚未存檔的設定時，關機前先問清楚 */
export function confirmPowerOff(name, onSave, onDiscard) {
  modal([
    h('h2', { text: `${name} 有尚未儲存的設定` }),
    h('p', { class: 'muted', text: '這台設備的 running-config 和 startup-config 不一樣。真實的設備斷電後，只有存進 startup-config 的設定會留下來 — 沒有下過 write memory 的變更會全部消失。' }),
    h('div', { class: 'd-actions' },
      button('取消', { kind: 'ghost', onclick: closeModal }),
      button('直接關機（放棄變更）', { onclick: () => { closeModal(); onDiscard(); } }),
      button('先存檔再關機', { ic: 'save', kind: 'primary', onclick: () => { closeModal(); onSave(); } })),
  ]);
}

export function openComplete(app, stars) {
  const lv = app.level;
  const next = LEVELS[app.levelIdx + 1];
  modal([
    h('div', { class: 'done-top' }, h('div', { class: 'done-ring' }, icon('check', 34)),
      h('h2', { text: next ? '任務完成！' : '全部破關！' }),
      h('p', { class: 'muted', text: `${levelNo(lv)}　${lv.title}` }),
      h('div', { class: 'big-stars' }, [1, 2, 3].map((s) => { const i = icon('star', 30); if (stars >= s) i.classList.add('on'); return i; }))),
    h('div', { class: 'recap' }, lv.recap.map((t) => h('div', null, icon('check', 14), h('span', { text: t })))),
    h('div', { class: 'd-actions' }, button('留在這一關', { kind: 'ghost', onclick: closeModal }),
      hasLevelQuiz(lv.id) && button('觀念小考 3 題', { ic: 'book', onclick: () => openLevelQuiz(app, lv.id) }),
      next ? button('下一關：' + next.title, { ic: 'chevron', kind: 'primary', onclick: () => { closeModal(); app.loadLevel(app.levelIdx + 1); } })
        : button('回到關卡選單', { ic: 'grid', kind: 'primary', onclick: () => openLevels(app) })),
  ]);
}
