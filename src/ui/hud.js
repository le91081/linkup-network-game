// HUD：頂端列、任務面板、封包追蹤主控台、各種對話框
import { h, icon, button, toast, faceplate } from './dom.js';
import { LEVELS, CHAPTERS } from '../levels/index.js';
import { CATALOG, CABLES, cableKinds, cableKind, pairDist, cableAt, portOf, removeCable } from '../engine/model.js';
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
    button('測驗', { ic: 'book', kind: 'ghost', onclick: () => openQuiz(app) }),
    button('證照', { ic: 'award', kind: 'ghost', onclick: () => openCerts(app) }),
    button('提示', { ic: 'bulb', kind: 'ghost', onclick: () => openHints(app) }),
    button('重置', { ic: 'reset', kind: 'ghost', onclick: () => confirmReset(app) }),
    button('說明', { ic: 'help', kind: 'ghost', onclick: () => openHelp(app) }),
    button('關卡', { ic: 'grid', onclick: () => openLevels(app) }),
  );
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
          h('div', null, h('kbd', { text: '點網路線' }), '拔除'),
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
          h('span', null, h('i', { style: { background: '#9a7a2e' } }), '被 STP 封鎖')))),
  );
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
        body.append(h('div', { class: 'cl k-' + l.kind, onclick: () => app.scene.pulse(l.dev, 0xffffff) },
          h('span', { class: 'who', text: state.devices[l.dev]?.name || '' }), h('span', { class: 'msg', text: l.text })));
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

export function openCableMenu(app, cableId, x, y) {
  closePopover();
  const st = app.state;
  const c = st.cables.find((k) => k.id === cableId);
  if (!c) return;
  const A = st.devices[c.a.dev], B = st.devices[c.b.dev];
  popover = h('div', { class: 'popover', style: { left: Math.min(x + 6, innerWidth - 300) + 'px', top: Math.min(y + 10, innerHeight - 130) + 'px' } },
    h('b', { text: CABLES[cableKind(c)].name }),
    h('span', { class: 'mono', text: `${A.name} [${portOf(A, c.a.port).label}]  ↔  ${B.name} [${portOf(B, c.b.port).label}]` }),
    h('span', { class: 'muted', style: { fontSize: '12px' }, text: `兩端相距 ${pairDist(st, A.id, B.id)} 公尺 · 這種線材最長 ${CABLES[cableKind(c)].max} 公尺` }),
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
