// HUD：頂端列、任務面板、封包追蹤主控台、各種對話框
import { h, icon, button, toast, faceplate } from './dom.js';
import { LEVELS, CHAPTERS } from '../levels/index.js';
import { CATALOG, CABLES, cableKinds, cableKind, pairDist, cableAt, portOf, removeCable, linkInfo, fiberLink } from '../engine/model.js';
import { OPTICS, FIBER } from '../engine/optics.js';
import { fmtIp } from '../engine/ip.js';
import { pendingOf, fmtDur } from '../engine/sim.js';
import { renderSandbox } from './sandbox.js';
import { LEVEL_CERTS } from '../data/certs.js';
import { openQuiz, openCerts, openLevelQuiz, hasLevelQuiz, updateReviewBadge } from './quiz.js';
import { openRacks } from './rackview.js';
import { openDrillPicker, randomSeed } from './drill.js';
import { openExamPicker } from './exam.js';
import { openCustomLevels } from './editor.js';
import { drillable } from '../engine/faults.js';
import { openSolution } from './solution.js';
import { startTutorial } from './tutorial.js';

const LOGO =
  '<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#111a38"/><path d="M9 21c5 0 4-10 14-10" stroke="#4fd8c4" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="9" cy="21" r="3.5" fill="#6ea8ff"/><circle cx="23" cy="11" r="3.5" fill="#4fd8c4"/></svg>';

export const levelNo = (lv) => (lv.drill ? '演練' : lv.custom ? '自訂' : lv.sandbox ? '∞' : `${lv.chapter}-${LEVELS.filter((l) => l.chapter === lv.chapter).indexOf(lv) + 1}`);

// ───────────── 頂端列 ─────────────
export function renderTopbar(app) {
  const lv = app.level;
  const ch = CHAPTERS.find((c) => c.id === lv.chapter);
  app.el.topbar.replaceChildren(
    h('div', { class: 'brand', html: LOGO + '<span>Link<em>Up</em></span>' }),
    h('div', { class: 'crumb' }, h('span', { text: ch ? `第 ${ch.id} 章 · ${ch.title}${lv.drill ? ' · 故障演練' : ''}` : lv.custom ? '自訂關卡' : '自由模式' }), h('b', { text: ch || lv.custom ? `${levelNo(lv)}　${lv.title}` : lv.subtitle })),
    h('div', { class: 'spacer' }),
    h('div', { class: 'histbtns' },
      h('button', { class: 'btn ghost icon', id: 'btn-undo', type: 'button', title: '復原上一個變更（Ctrl + Z）', disabled: !app.undoStack.length, onclick: () => app.undo() }, icon('undo', 16)),
      h('button', { class: 'btn ghost icon', id: 'btn-redo', type: 'button', title: '重做（Ctrl + Y）', disabled: !app.redoStack.length, onclick: () => app.redo() }, icon('redo', 16)),
      h('button', { class: 'btn ghost icon' + (app.scene && app.scene.survey ? ' on' : ''), id: 'btn-survey', type: 'button', title: '訊號量測：滑鼠移到地板上，看那個位置收到每台基地台的訊號（像現場勘測的 App）', onclick: (e) => { app.scene.survey = !app.scene.survey; e.currentTarget.classList.toggle('on', app.scene.survey); if (!app.scene.survey) app.scene.surveyEl.style.display = 'none'; } }, icon('bolt', 16)),
      h('button', { class: 'btn ghost icon', id: 'btn-rack', type: 'button', title: '實體配置：機櫃立面圖（設備裝在第幾 U）與樓層平面圖（牆、線路、Wi-Fi 訊號熱圖）', onclick: () => openRacks(app) }, icon('rack', 16)),
      h('button', { class: 'btn ghost icon' + (app.view2d ? ' on' : ''), id: 'btn-view', type: 'button', title: app.view2d ? '回到 3D 場景' : '切換成 2D 邏輯拓撲圖（埠、VLAN、IP 一目了然）', onclick: () => app.toggle2d() }, icon(app.view2d ? 'cube' : 'topo', 16))),
    button('測驗', { ic: 'book', kind: 'ghost quiz-btn', onclick: () => openQuiz(app) }),
    button('證照', { ic: 'award', kind: 'ghost', onclick: () => openCerts(app) }),
    button('提示', { ic: 'bulb', kind: 'ghost', onclick: () => openHints(app) }),
    button('重置', { ic: 'reset', kind: 'ghost', onclick: () => confirmReset(app) }),
    button('說明', { ic: 'help', kind: 'ghost', onclick: () => openHelp(app) }),
    button('關卡', { ic: 'grid', onclick: () => openLevels(app) }),
  );
  updateReviewBadge(app);
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
    lv.drill && h('div', { class: 'drill-bar' }, icon('clock', 14), h('span', { id: 'drill-timer', text: '' }), h('button', { class: 'mini', type: 'button', title: '放棄這次演練，看答案', onclick: () => giveUp(app) }, '看答案')),
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
  const skip = h('button', { class: 'btn sm ghost ck-skip', type: 'button', title: '讓時間直接前進 30 秒', onclick: () => app.skip(30) }, '+30 秒');
  const pend = h('button', { class: 'btn sm ck-pend', type: 'button', onclick: () => app.settleNow() });
  const el = h('div', { id: 'clock', class: 'glass', title: '模擬時間：STP、OSPF、VRRP、DHCP 租約、ARP 快取都照這個時鐘走' }, play, time, speeds, skip, pend);
  document.body.append(el);
  app.clockUi = { el, time, play, speeds, pend, avail: 9999, fitKey: '' };
  updateClock(app);
}

/** 場景上方的空間不夠寬時，逐級收起次要的內容，不要蓋到兩側的面板 */
export function fitClock(app) {
  const u = app.clockUi;
  if (!u) return;
  const key = [u.avail, u.time.textContent.length, u.pend.style.display, u.pend.textContent.length].join('|');
  if (key === u.fitKey) return;
  u.fitKey = key;
  u.el.classList.remove('c1', 'c2', 'c3');
  for (const c of ['c1', 'c2', 'c3']) {
    if (u.el.offsetWidth <= u.avail) break;
    u.el.classList.add(c);
  }
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
    u.pend.replaceChildren(icon('fast', 13), h('span', { class: 'ck-long', text: '收斂中，' }), h('span', { text: `還要 ${fmtDur(left)}` }));
    u.pend.title = '網路還在收斂。點一下讓時間快轉到穩定為止\n\n' + [...new Set(p.map((x) => x.text))].slice(0, 8).join('\n');
  }
  u.el.classList.toggle('pending', !!p.length);
  fitClock(app);
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
const PROTO_NO = { icmp: 1, tcp: 6, udp: 17, esp: 50, gre: 47 };

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
      : f.proto === 'esp' || f.natt
      ? layer(3, f.natt ? 'UDP 4500 + ESP（NAT-T）' : 'ESP（IPsec）', '加密的內容', f.natt ? '中間有 NAT：ESP 再包進 UDP 4500，PAT 才有埠號可以轉換。裡面的內容一樣是加密的' : '原本的 IP 標頭、埠號與資料都包在裡面，中途的設備只看得到兩端 VPN 閘道的位址')
      : f.proto === 'gre'
      ? layer(3, 'GRE', `裡面：${fmtIp((f.gre && f.gre.inner && f.gre.inner.src) || 0)}  →  ${fmtIp((f.gre && f.gre.inner && f.gre.inner.dst) || 0)}`, '原本的封包外面再包一層 IP + GRE 標頭（多 24 位元組），沒有加密：中途的設備看得到裡面的位址與內容')
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

/** 光纖的兩端：收發器（可以更換）、量到的光功率、清潔接頭 */
function fiberBox(app, c, A, B, x, y) {
  const st = app.state, f = fiberLink(st, c);
  if (!f) return null;
  const reopen = () => { app.changed(); app.renderPanel(); openCableMenu(app, c.id, x, y); };
  const media = portOf(A, c.a.port).media;
  const end = (k, D) => {
    const o = OPTICS[f.optics[k]] || {};
    const sel = h('select', { class: 'inp sel xcvr-sel', title: '更換這一端的收發器' }, Object.entries(OPTICS).filter(([, x]) => x.form === media).map(([pn, x]) =>
      h('option', { value: pn, selected: pn === f.optics[k], text: `${pn}（${x.type}${x.vendor !== 'Cisco' ? '・第三方' : ''}）` })));
    sel.addEventListener('change', () => { c.optics = { ...(c.optics || {}), ...f.optics, [k]: sel.value }; toast(`${D.name}：換上 ${sel.value}`); reopen(); });
    const rx = !f.link.down && f.link.rx ? f.link.rx[k] : null;
    return h('div', { class: 'xcvr-end' }, h('span', { class: 'mono', text: `${D.name} [${portOf(D, c[k].port).label}]` }), sel,
      h('span', { class: 'muted', style: { fontSize: '12px' }, text: `${o.nm || '?'} nm · ${o.fiber === 'smf' ? '單模' : '多模'} · 最長 ${o.reach >= 1000 ? o.reach / 1000 + ' 公里' : o.reach + ' 公尺'}${rx != null ? ` · 收到 ${rx} dBm（靈敏度 ${o.rx} dBm）` : ''}` }));
  };
  return h('div', { class: 'xcvr-box' },
    end('a', A), end('b', B),
    f.link.marginal && h('span', { class: 'note warn', text: '收到的光太弱：燈有亮，但訊框有 CRC 錯誤、會掉封包。常見的原因是接頭髒了、光纖彎太多或太長。' }),
    button('清潔兩端的光纖接頭', { ic: 'check', small: true, onclick: () => { const was = c.dirty && Object.keys(c.dirty).length; delete c.dirty; toast(was ? '用光纖清潔筆清過兩端的接頭：髒污清掉了' : '用光纖清潔筆清過兩端的接頭（本來就是乾淨的）'); reopen(); } }));
}

export function openCableMenu(app, cableId, x, y) {
  closePopover();
  const st = app.state;
  const c = st.cables.find((k) => k.id === cableId);
  if (!c) return;
  const A = st.devices[c.a.dev], B = st.devices[c.b.dev];
  const li = !st.rt.why[c.id] && st.rt.cable[c.id] !== 'down' && linkInfo(st, c.a.dev, c.a.port);
  const fiber = !!fiberLink(st, c);
  popover = h('div', { class: 'popover', style: { left: Math.min(x + 6, innerWidth - 300) + 'px', top: Math.min(y + 10, innerHeight - 190) + 'px' } },
    h('b', { text: fiber ? FIBER[c.kind] : CABLES[cableKind(c)].name }),
    h('span', { class: 'mono', text: `${A.name} [${portOf(A, c.a.port).label}]  ↔  ${B.name} [${portOf(B, c.b.port).label}]` }),
    h('span', { class: 'muted', style: { fontSize: '12px' }, text: `兩端相距 ${pairDist(st, A.id, B.id)} 公尺 · ${fiber ? '能跑多遠由兩端的收發器決定' : `這種線材最長 ${CABLES[cableKind(c)].max} 公尺`}` }),
    li && h('span', { class: 'muted', style: { fontSize: '12px' }, text: `自動協商：${li.text}` }),
    +c.cir > 0 && h('span', { class: 'note warn', text: `電信業者的線路（例如 Metro Ethernet）：實體連線 ${li ? li.speed + ' Mbps' : ''}，合約頻寬只有 ${c.cir} Mbps。送超過合約的量，多出來的會在業者那端被管制丟掉 (policing)，語音也不例外；要在自己這端整形 (shape) 到合約以內。` }),
    li && li.half && h('span', { class: 'note warn', text: '半雙工：同一時間只能有一端傳送，否則會碰撞 (CSMA/CD)。' }),
    li && li.mismatch && h('span', { class: 'note warn', text: '雙工不一致 (duplex mismatch)：線是通的，但全雙工的那一端不會等對方，會造成大量碰撞與 CRC 錯誤，實際速度極慢。兩端都改成自動協商，或兩端寫死成一樣。' }),
    st.rt.why[c.id] && h('span', { class: 'note warn', text: '沒有燈號：' + st.rt.why[c.id] }),
    st.rt.cable[c.id] === 'blocked' && h('span', { class: 'note muted', text: '這條線被 STP 封鎖當作備援，其他路徑斷掉時會自動啟用。' }),
    fiberBox(app, c, A, B, x, y),
    st.rt.cable[c.id] === 'susp' && h('span', { class: 'note warn', text: 'Port-channel 兩端的設定不相容，成員被暫停。' }),
    button('拔除這條線', { ic: 'unplug', small: true, onclick: () => { removeCable(st, cableId); closePopover(); toast('已拔除網路線'); app.changed(); app.renderPanel(); } }));
  document.body.append(popover);
  // 光纖的選單比較高：超出視窗下緣就往上移
  const r = popover.getBoundingClientRect();
  if (r.bottom > innerHeight - 8) popover.style.top = Math.max(8, innerHeight - r.height - 8) + 'px';
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

/** 演練放棄：揭曉被改壞的地方 */
function giveUp(app) {
  const lv = app.level;
  modal([
    h('h2', { text: '被改壞的地方' }),
    h('div', { class: 'recap' }, lv.faults.map((f) => h('div', null, icon('x', 14), h('span', { text: f.text })))),
    h('div', { class: 'd-actions' }, button('繼續修', { kind: 'ghost', onclick: closeModal }),
      button('換一個網路', { ic: 'shuffle', kind: 'primary', onclick: () => { closeModal(); openDrillPicker(app, { modal, closeModal, levelNo }); } })),
  ]);
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
    h('div', { class: 'mode-cards' },
      h('button', { type: 'button', class: 'lv mode-card', onclick: () => openDrillPicker(app, { modal, closeModal, levelNo }) },
        h('div', { class: 'top' }, h('span', { class: 'no' }, icon('bolt', 13), ' 故障演練')),
        h('b', { text: '隨機改壞一個做好的網路' }), h('p', { text: '閘道打錯、VLAN 放錯、Trunk 少了 VLAN、介面被關、路由被刪…每次都不一樣，可以限時。' })),
      h('button', { type: 'button', class: 'lv mode-card', onclick: () => openExamPicker(app, { modal, closeModal }) },
        h('div', { class: 'top' }, h('span', { class: 'no' }, icon('clock', 13), ' 模擬考')),
        h('b', { text: 'CCNA / Network+ 限時模擬考' }), h('p', { text: '依考試領域的比重抽題、交卷後才看答案，依領域分析強弱。' })),
      (app.store.custom || []).length ? h('button', { type: 'button', class: 'lv mode-card', onclick: () => openCustomLevels(app) },
        h('div', { class: 'top' }, h('span', { class: 'no' }, icon('edit', 13), ' 自訂關卡')),
        h('b', { text: `${app.store.custom.length} 個自己做的關卡` }), h('p', { text: '在自由模式設計、匯入別人分享的關卡。' })) : null),
    CHAPTERS.map((ch) => h('section', { class: 'chapter' },
      h('h2', null, `第 ${ch.id} 章　${ch.title}`, h('small', { text: ch.desc })),
      h('div', { class: 'lv-grid' }, LEVELS.filter((l) => l.chapter === ch.id).map((lv) => {
        const d = done[lv.id];
        return h('button', {
          type: 'button', class: `lv ${d ? 'done' : ''} ${lv === app.level ? 'cur' : ''}`,
          onclick: () => {
            closeModal();
            if (lv.id === 'l01' && app.store.tutorial == null && !app.store.done.l01) return startTutorial(app);
            app.loadLevel(LEVELS.indexOf(lv));
            if (!app.store.seenHelp) openHelp(app);
            return undefined;
          },
        },
        h('div', { class: 'top' }, h('span', { class: 'no', text: levelNo(lv) + (d ? '  ✓' : '') + (d && d.best ? `  ${gradeOf(d.best)}` : '') }),
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
    h('p', { class: 'muted', text: '鍵盤：按 ? 看所有快捷鍵（Ctrl + Enter 執行測試、[ ] 切換設備、T 切換 2D 拓撲圖、M 開關音效）。' }),
    h('div', { class: 'd-actions' }, button('從第 1-1 關跟著做一次（互動導覽）', { ic: 'mouse', kind: 'ghost', onclick: () => { closeModal(); startTutorial(app); } }), button('開始', { kind: 'primary', onclick: closeModal })),
  ]);
}

export function openHints(app) {
  const lv = app.level;
  const draw = () => modal([
    h('h2', { text: '提示' }),
    h('p', { class: 'muted', text: app.hintsShown ? '每看一個提示會少一顆星，最少保留一顆。' : '卡住了嗎？建議先按「執行測試」，看封包追蹤卡在哪一站。每看一個提示會少一顆星，最少保留一顆。' }),
    lv.hints.slice(0, app.hintsShown).map((t, i) => h('div', { class: 'hint-item' }, h('b', { text: i + 1 }), h('span', { text: t }))),
    // 提示都看完了還是卡住：可以看參考解法（演練與自訂關卡沒有參考解法）
    app.hintsShown >= lv.hints.length && typeof lv.solve === 'function' && !lv.drill && !lv.custom
      && h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: '提示都看完了。還是卡住的話，可以看參考解法改了哪些地方，或讓它示範一次（示範不計星）。' }),
    h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: closeModal }),
      app.hintsShown >= lv.hints.length && typeof lv.solve === 'function' && !lv.drill && !lv.custom && button('看參考解法', { ic: 'route', onclick: () => openSolution(app, { modal, closeModal }) }),
      app.hintsShown < lv.hints.length && button(app.hintsShown ? '再給一個提示' : '顯示第一個提示', { ic: 'bulb', kind: 'primary', onclick: () => { app.useHint(); draw(); } })),
  ]);
  draw();
}

/** 示範跑完：不計星，可以重置後自己做一次 */
export function openDemoDone(app) {
  const lv = app.level;
  modal([
    h('div', { class: 'done-top' }, h('div', { class: 'done-ring soft' }, icon('route', 32)),
      h('h2', { text: '示範完成' }), h('p', { class: 'muted', text: `${levelNo(lv)}　${lv.title} · 示範不計星、不計分` })),
    h('div', { class: 'recap' }, lv.recap.map((t) => h('div', null, icon('check', 14), h('span', { text: t })))),
    h('div', { class: 'd-actions' }, button('留在這裡看看', { kind: 'ghost', onclick: closeModal }),
      button('重置，自己做一次', { ic: 'reset', kind: 'primary', onclick: () => { closeModal(); app.openLevel(lv, { fresh: true }); } })),
  ]);
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

const gradeOf = (score) => (score >= 950 ? 'S' : score >= 850 ? 'A' : score >= 700 ? 'B' : 'C');
export function openComplete(app, stars, sc) {
  const lv = app.level;
  const next = lv.custom ? null : LEVELS[app.levelIdx + 1];
  modal([
    h('div', { class: 'done-top' }, h('div', { class: 'done-ring' }, icon('check', 34)),
      h('h2', { text: next || lv.custom ? '任務完成！' : '全部破關！' }),
      h('p', { class: 'muted', text: `${levelNo(lv)}　${lv.title}` }),
      h('div', { class: 'big-stars' }, [1, 2, 3].map((s) => { const i = icon('star', 30); if (stars >= s) i.classList.add('on'); return i; }))),
    sc && h('div', { class: 'score-box' },
      h('div', { class: 'grade g-' + sc.grade }, h('b', { text: sc.grade }), h('span', { class: 'mono', text: `${sc.score} 分` }), sc.prevBest ? h('em', { text: sc.score > sc.prevBest ? `新紀錄（原本 ${sc.prevBest}）` : `最佳 ${sc.prevBest}` }) : null),
      h('div', { class: 'score-rows' }, sc.rows.map(([k, v, p]) => h('div', null, h('span', { text: k }), h('span', { class: 'muted', text: v }), h('b', { class: 'mono', text: p ? String(p) : '—' }))))),
    h('div', { class: 'recap' }, lv.recap.map((t) => h('div', null, icon('check', 14), h('span', { text: t })))),
    h('div', { class: 'd-actions' }, button('留在這一關', { kind: 'ghost', onclick: closeModal }),
      hasLevelQuiz(lv.id) && button('觀念小考 3 題', { ic: 'book', onclick: () => openLevelQuiz(app, lv.id) }),
      !lv.custom && drillable(lv) && button('故障演練', { ic: 'bolt', onclick: () => { closeModal(); app.openDrill({ base: lv.id, count: 2, seed: randomSeed(), timed: 0 }); } }),
      next ? button('下一關：' + next.title, { ic: 'chevron', kind: 'primary', onclick: () => { closeModal(); app.loadLevel(app.levelIdx + 1); } })
        : lv.custom && lv.test ? button('回到自由模式', { ic: 'edit', kind: 'primary', onclick: () => { closeModal(); app.openSandbox(); } })
          : lv.custom ? button('自訂關卡', { ic: 'grid', kind: 'primary', onclick: () => openCustomLevels(app) })
            : button('回到關卡選單', { ic: 'grid', kind: 'primary', onclick: () => openLevels(app) })),
  ]);
}
