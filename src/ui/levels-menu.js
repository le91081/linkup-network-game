// 關卡選單：左邊是章節（或學習路線）的導覽與進度，右邊是關卡卡片；上方可以搜尋、只看還沒完成的
import { h, icon, button, fill } from './dom.js';
import { LEVELS, CHAPTERS } from '../levels/index.js';
import { PATHS, pathIds } from '../data/paths.js';
import { parOf } from './score.js';
import { openDrillPicker } from './drill.js';
import { openExamPicker } from './exam.js';
import { openCustomLevels } from './editor.js';
import { startTutorial } from './tutorial.js';

const gradeOf = (score) => (score >= 950 ? 'S' : score >= 850 ? 'A' : score >= 700 ? 'B' : 'C');
const byId = (id) => LEVELS.find((l) => l.id === id);
/** 路線裡真的存在的關卡（依順序、不重複） */
const pathLevels = (p) => pathIds(p).map(byId).filter(Boolean);

/**
 * 接下來該玩哪一關：現在這一關還沒過就是它；不然從現在這一關往後找第一個還沒過的，再不然從頭找。
 * 全部都過了就回傳 null。
 */
export function nextLevel(app) {
  const done = app.store.done, cur = app.level && LEVELS.includes(app.level) ? app.level : null;
  if (cur && !done[cur.id]) return cur;
  const from = cur ? LEVELS.indexOf(cur) + 1 : 0;
  return LEVELS.slice(from).find((l) => !done[l.id]) || LEVELS.find((l) => !done[l.id]) || null;
}

/** ctx：{ modal, closeModal, levelNo, openHelp, logo }（由 hud.js 提供，避免互相引入） */
export function openLevelMenu(app, ctx) {
  const { modal, closeModal, levelNo, openHelp, logo } = ctx;
  const done = app.store.done;
  // 上一次看的是章節還是路線、有沒有只看未完成：下次打開時照舊
  const ui = (app.menuUi ||= { view: 'chapters', path: null, filter: 'all' });
  let query = '';

  const enter = (lv) => {
    closeModal();
    if (lv.id === 'l01' && app.store.tutorial == null && !done.l01) return startTutorial(app);
    if (lv !== app.level) app.loadLevel(LEVELS.indexOf(lv));
    if (!app.store.seenHelp) openHelp(app);
    return undefined;
  };

  const card = (lv, ord, words) => {
    const d = done[lv.id];
    // 搜尋時把符合關鍵字的標籤排到前面（卡片只放得下三個）
    const hit = (t) => words && words.some((w) => t.toLowerCase().includes(w));
    const tags = words ? [...lv.tags.filter(hit), ...lv.tags.filter((t) => !hit(t))] : lv.tags;
    return h('button', { type: 'button', class: `lv ${d ? 'done' : ''} ${lv === app.level ? 'cur' : ''}`, data: { lv: lv.id }, onclick: () => enter(lv) },
      h('div', { class: 'top' },
        h('span', { class: 'no' }, ord, levelNo(lv) + (d ? '  ✓' : '') + (d && d.best ? `  ${gradeOf(d.best)}` : '')),
        h('span', { class: 'stars' }, [1, 2, 3].map((s) => { const i = icon('star', 13); if (d && d.stars >= s) i.classList.add('on'); return i; }))),
      h('b', { text: lv.title }), h('p', { text: lv.subtitle }),
      h('div', { class: 'chips' }, h('span', { class: 'lv-tags' }, tags.slice(0, 3).map((t) => h('span', { class: 'chip' + (hit(t) ? ' hit' : ''), text: t }))),
        h('span', { class: 'lv-min', title: '依任務目標的數量估計的標準時間', text: `約 ${Math.round(parOf(lv) / 60)} 分` })));
  };
  const keep = (lv) => ui.filter === 'all' || (ui.filter === 'done') === !!done[lv.id];
  const bar = (n, total) => h('i', { class: 'lvp-bar' }, h('i', { style: { width: (total ? (n / total) * 100 : 0) + '%' } }));
  const count = (list) => list.filter((l) => done[l.id]).length;

  // ── 頂端：標題、進度、其他模式 ──
  const total = count(LEVELS), stars = LEVELS.reduce((a, l) => a + ((done[l.id] || {}).stars || 0), 0);
  const mode = (cls, ic, title, desc, onclick) => h('button', { type: 'button', class: `lv ${cls}`, title: desc, onclick },
    h('i', { class: 'mode-ic' }, icon(ic, 17)), h('div', null, h('b', { text: title }), h('p', { text: desc })));
  const head = h('div', { class: 'lvp-head' },
    h('div', { class: 'hero' }, h('div', { html: logo }),
      h('div', null, h('h1', { html: 'Link<em>Up</em>' }), h('p', { text: '親手接線、親手設定，讓封包抵達目的地。' })),
      h('div', { class: 'prog' }, h('b', { text: `${total} / ${LEVELS.length}` }), h('span', null, '已完成關卡 · ', icon('star', 11), ` ${stars}`))),
    h('div', { class: 'mode-cards' },
      mode('sbx-card' + (app.level && app.level.sandbox ? ' cur' : ''), 'edit', '自由模式', '自己擺設備、自由接線的沙盒', () => { closeModal(); app.openSandbox(); }),
      mode('mode-card', 'bolt', '故障演練', '隨機改壞一個做好的網路，可以限時', () => openDrillPicker(app, { modal, closeModal, levelNo })),
      mode('mode-card', 'clock', '模擬考', 'CCNA / Network+ 限時模擬考', () => openExamPicker(app, { modal, closeModal })),
      (app.store.custom || []).length ? mode('mode-card', 'grid', '自訂關卡', `${app.store.custom.length} 個自己做的關卡`, () => openCustomLevels(app)) : null));

  // ── 左邊：章節 / 學習路線 ──
  const side = h('aside', { class: 'lvp-side' });
  const main = h('div', { class: 'lvp-main' });
  const search = h('input', {
    class: 'inp lvp-q', type: 'search', placeholder: '搜尋關卡：VLAN、OSPF、VPN…', spellcheck: 'false', 'aria-label': '搜尋關卡',
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); drawMain(); },
    onkeydown: (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; query = ''; drawMain(); e.preventDefault(); e.stopPropagation(); } else if (e.key !== 'Escape') e.stopPropagation(); },
  });
  const filterSeg = h('div', { class: 'seg lvp-filter' });
  const tools = h('div', { class: 'lvp-tools' }, h('label', { class: 'lvp-search' }, icon('search', 15), search), filterSeg);

  function drawFilter() {
    fill(filterSeg, [['all', '全部'], ['todo', '未完成'], ['done', '已完成']].map(([k, t]) => h('button', {
      type: 'button', class: ui.filter === k ? 'on' : '', text: t, onclick: () => { ui.filter = k; drawFilter(); drawMain(); },
    })));
  }

  function drawSide() {
    const nx = nextLevel(app);
    fill(side,
      h('div', { class: 'seg lvp-view' }, [['chapters', '章節'], ['paths', '學習路線']].map(([k, t]) => h('button', {
        type: 'button', class: ui.view === k ? 'on' : '', text: t,
        onclick: () => { ui.view = k; if (k === 'chapters') ui.path = null; drawSide(); drawMain(); if (k === 'chapters') toCurrent(); },
      }))),
      nx && h('button', { type: 'button', class: 'lvp-next', title: nx === app.level ? '回到正在做的這一關' : '開始下一個還沒完成的關卡', onclick: () => enter(nx) },
        h('span', { class: 'k', text: nx === app.level ? '繼續這一關' : total ? '下一關' : '從這裡開始' }),
        h('b', null, h('span', { class: 'mono', text: levelNo(nx) }), ' ', nx.title), icon('chevron', 16)),
      ui.view === 'chapters'
        ? h('nav', { class: 'lvp-list' }, CHAPTERS.map((ch) => {
          const list = LEVELS.filter((l) => l.chapter === ch.id), n = count(list);
          return h('button', { type: 'button', class: 'lvp-row' + (n === list.length ? ' full' : ''), data: { ch: ch.id }, title: ch.desc, onclick: () => { if (query) { search.value = ''; query = ''; drawMain(); } jump(ch.id); } },
            h('span', { class: 'n', text: ch.id }), h('span', { class: 't', text: ch.title }), h('span', { class: 'c', text: `${n}/${list.length}` }), bar(n, list.length));
        }))
        : h('nav', { class: 'lvp-list' }, PATHS.map((p) => {
          const list = pathLevels(p), n = count(list);
          return h('button', { type: 'button', class: 'lvp-row path' + (ui.path === p.id ? ' on' : '') + (n === list.length ? ' full' : ''), title: p.who, onclick: () => { ui.path = p.id; if (query) { search.value = ''; query = ''; } drawSide(); drawMain(); } },
            h('span', { class: 'n' }, icon(p.ic, 13)), h('span', { class: 't', text: p.t }), h('span', { class: 'c', text: `${n}/${list.length}` }), bar(n, list.length));
        })));
  }

  // 剛從左邊點的那一章：只要它還在畫面上就標它（最後幾章很短，捲到底也到不了最上面）
  let picked = null;
  const jump = (chId) => {
    const el = main.querySelector(`.chapter[data-ch="${chId}"]`);
    if (!el) return;
    picked = String(chId);
    main.scrollTop = el.offsetTop - 2;
    spy();
  };
  /** 捲動時，左邊標出現在看到的是哪一章 */
  function spy() {
    if (ui.view !== 'chapters') return;
    // 搜尋的時候右邊不分章節，左邊就不標
    if (query) { for (const r of side.querySelectorAll('.lvp-row.on')) r.classList.remove('on'); return; }
    const secs = [...main.querySelectorAll('.chapter')], top = main.scrollTop, bottom = top + main.clientHeight;
    let cur = null;
    if (picked) {
      const el = secs.find((x) => x.dataset.ch === picked);
      if (el && el.offsetTop >= top - 8 && el.offsetTop < bottom - 40) cur = picked; else picked = null;
    }
    if (!cur) {
      for (const el of secs) { if (el.offsetTop <= top + 48) cur = el.dataset.ch; else break; }
      if (secs.length && bottom >= main.scrollHeight - 4) cur = secs[secs.length - 1].dataset.ch; // 捲到底：最後一章
      if (!cur && secs.length) cur = secs[0].dataset.ch;
    }
    for (const r of side.querySelectorAll('.lvp-row[data-ch]')) r.classList.toggle('on', r.dataset.ch === cur);
  }
  main.addEventListener('scroll', spy, { passive: true });

  function drawMain() {
    main.scrollTop = 0;
    filterSeg.style.visibility = ui.view === 'paths' && !query ? 'hidden' : '';
    // 搜尋：不分章節，直接列出符合的關卡
    if (query) {
      const words = query.split(/\s+/);
      const hit = LEVELS.filter((lv) => { const t = `${levelNo(lv)} ${lv.title} ${lv.subtitle} ${lv.tags.join(' ')}`.toLowerCase(); return words.every((w) => t.includes(w)); }).filter(keep);
      fill(main, h('div', { class: 'lvp-note', text: hit.length ? `找到 ${hit.length} 關` : '沒有符合的關卡。試試別的關鍵字（例如 VLAN、NAT、OSPF、Wi-Fi、憑證），或把「未完成 / 已完成」改回「全部」。' }),
        h('div', { class: 'lv-grid' }, hit.map((lv) => card(lv, null, words))));
      spy();
      return;
    }
    if (ui.view === 'paths') { drawPaths(); return; }
    const secs = CHAPTERS.map((ch) => {
      const list = LEVELS.filter((l) => l.chapter === ch.id), shown = list.filter(keep);
      if (!shown.length) return null;
      return h('section', { class: 'chapter', data: { ch: ch.id } },
        h('h2', null, `第 ${ch.id} 章　${ch.title}`, h('small', { text: ch.desc })),
        h('div', { class: 'lv-grid' }, shown.map((lv) => card(lv))));
    }).filter(Boolean);
    fill(main, secs.length ? secs : h('div', { class: 'lvp-note', text: ui.filter === 'done' ? '還沒有完成的關卡。從左邊的「從這裡開始」進第一關吧。' : '全部的關卡都完成了！可以試試故障演練或模擬考。' }));
    spy();
  }

  function drawPaths() {
    const p = PATHS.find((x) => x.id === ui.path);
    if (!p) {
      fill(main, h('div', { class: 'lvp-note', text: '不知道從哪裡開始？選一條路線，照順序一關一關做。同一關可以出現在好幾條路線裡，進度是共用的。' }),
        h('div', { class: 'path-grid' }, PATHS.map((x) => {
          const list = pathLevels(x), n = count(list);
          return h('button', { type: 'button', class: 'pathc', onclick: () => { ui.path = x.id; drawSide(); drawMain(); } },
            h('div', { class: 'top' }, h('i', { class: 'mode-ic' }, icon(x.ic, 18)), h('b', { text: x.t }), h('span', { class: 'c mono', text: `${n} / ${list.length}` })),
            h('p', { class: 'who', text: x.who }), h('p', { text: x.d }), bar(n, list.length));
        })));
      return;
    }
    const list = pathLevels(p), n = count(list), nx = list.find((l) => !done[l.id]);
    let k = 0;
    fill(main,
      h('div', { class: 'path-head' },
        h('i', { class: 'mode-ic big' }, icon(p.ic, 22)),
        h('div', null, h('h2', { text: p.t }), h('p', { class: 'who', text: p.who }), h('p', { text: p.d })),
        h('div', { class: 'path-prog' }, h('b', { class: 'mono', text: `${n} / ${list.length}` }), bar(n, list.length),
          nx ? button(n ? '接著做：' + levelNo(nx) : '開始這條路線', { ic: 'play', kind: 'primary', small: true, onclick: () => enter(nx) }) : h('span', { class: 'ok', text: '這條路線完成了 ✓' }))),
      p.steps.map((s, i) => {
        const lvs = s.ids.map(byId).filter(Boolean);
        if (!lvs.length) return null;
        return h('section', { class: 'chapter pstep' },
          h('h2', null, `${i + 1}　${s.t}`, h('small', { text: s.d })),
          h('div', { class: 'lv-grid' }, lvs.map((lv) => { k++; return card(lv, h('span', { class: 'lv-ord' + (lv === nx ? ' next' : ''), text: lv === nx ? '接著做' : String(k) })); })));
      }));
  }

  const dlg = modal([head, h('div', { class: 'lvp-body' }, side, h('div', { class: 'lvp-right' }, tools, main))], { wide: true });
  dlg.classList.add('lvp');
  drawFilter();
  drawSide();
  drawMain();
  // 打開時（或從路線切回章節時）直接捲到現在這一關所在的章節
  function toCurrent() { if (app.level && LEVELS.includes(app.level) && app.level.chapter > 1) jump(app.level.chapter); }
  if (ui.view === 'chapters') toCurrent();
}
