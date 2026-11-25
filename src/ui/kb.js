// 知識庫：
// - 閱讀視窗（預設）：寬的視窗，左邊是分類與清單、右邊是文章，字與圖都有足夠的空間
// - 釘在左側：文章放在左側面板的「知識庫」分頁，可以一邊看一邊設定（空間小，適合照著步驟做）
// - 文字裡的名詞連結：滑鼠移上去看摘要、點一下開文章
import { h, icon, button } from './dom.js';
import { CATS, CONCEPTS, CONCEPT, KB_INDEX } from '../data/kb/index.js';
import { splitTerms, levelConcepts, conceptLevels, searchConcepts } from '../data/kb/match.js';
import { LEVELS } from '../levels/index.js';
import { parseIp, fmtIp } from '../engine/ip.js';

let hooks = { renderMission: () => {}, levelNo: (lv) => lv.id, closeModal: () => {}, modal: null };
/** 狀態：tab = 左側面板的分頁 'mission' | 'kb'；id = 正在看的文章；back = 上一頁的文章；open = 展開的分類 */
export const kbState = (app) => (app.kb ||= { tab: 'mission', id: null, q: '', back: [], open: {}, scroll: 0 });
/** 是不是釘在左側面板（記在進度裡） */
export const kbDocked = (app) => !!(app.store && app.store.kbDock);

// ───────────── 名詞連結 ─────────────
/** 把一段文字裡提到的觀念變成連結（每個觀念只連第一次出現的地方）。skip：不要連的觀念（文章自己） */
export function linkText(text, skip) {
  return splitTerms(KB_INDEX, String(text ?? ''), skip).map((s) => (s.id
    ? h('span', { class: 'kterm', 'data-k': s.id, tabindex: '0', role: 'button', text: s.text })
    : s.text));
}

/** 打開某一則文章：釘在左側就顯示在左側面板，否則開閱讀視窗 */
export function openConcept(app, id) {
  const k = kbState(app);
  if (!CONCEPT[id]) return;
  const showing = kbDocked(app) ? k.tab === 'kb' : !!reader;
  if (showing && k.id && k.id !== id) k.back.push(k.id);
  else if (!showing || !k.id) k.back = [];
  k.id = id; k.scroll = 0; k.q = '';
  hideTip();
  if (kbDocked(app)) { k.tab = 'kb'; hooks.renderMission(app); } else openReader(app);
}
/** 左側面板的分頁：沒有釘住的時候，「知識庫」是打開閱讀視窗 */
export function showKbTab(app, tab) {
  const k = kbState(app);
  if (tab === 'kb' && !kbDocked(app)) { openReader(app); return; }
  k.tab = tab;
  hooks.renderMission(app);
}
/** K 鍵：開 / 關知識庫（釘在左側時是切換「任務」與「知識庫」） */
export function toggleKb(app) {
  const k = kbState(app);
  if (kbDocked(app)) { k.tab = k.tab === 'kb' ? 'mission' : 'kb'; hooks.renderMission(app); return; }
  if (reader) hooks.closeModal(); else openReader(app);
}
/** 釘在左側 / 放大閱讀 */
function setDock(app, on) {
  const k = kbState(app);
  app.store.kbDock = on;
  app.saveStore();
  if (on) { if (reader) hooks.closeModal(); k.tab = 'kb'; hooks.renderMission(app); } else { k.tab = 'mission'; hooks.renderMission(app); openReader(app); }
}

let tip = null, tipFor = null;
function hideTip() { if (tip) tip.style.display = 'none'; tipFor = null; }
function showTip(el) {
  const c = CONCEPT[el.dataset.k];
  if (!c) return;
  tip ||= document.body.appendChild(h('div', { class: 'ktip', role: 'tooltip' }));
  tip.replaceChildren(h('div', { class: 'ktip-h' }, h('b', { text: c.t }), c.en && h('span', { text: c.en })), h('p', { text: c.sum }), h('small', { text: '點一下看完整的說明' }));
  tip.style.display = 'block';
  const r = el.getBoundingClientRect(), tw = Math.min(320, window.innerWidth - 24);
  tip.style.maxWidth = tw + 'px';
  const th = tip.offsetHeight;
  const left = Math.max(12, Math.min(r.left, window.innerWidth - tip.offsetWidth - 12));
  const below = r.bottom + 8 + th < window.innerHeight - 8;
  tip.style.left = left + 'px';
  tip.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - th - 8)) + 'px';
  tipFor = el;
}

/** 安裝：名詞連結的滑鼠、鍵盤事件（整頁共用一個），以及重畫左側面板、開視窗的方法 */
export function installKb(app, h2) {
  hooks = { ...hooks, ...h2 };
  const termOf = (e) => e.target && e.target.closest && e.target.closest('.kterm');
  document.addEventListener('mouseover', (e) => { const t = termOf(e); if (t && t !== tipFor) showTip(t); else if (!t && tipFor) hideTip(); });
  document.addEventListener('focusin', (e) => { const t = termOf(e); if (t) showTip(t); });
  document.addEventListener('focusout', (e) => { if (termOf(e)) hideTip(); });
  document.addEventListener('scroll', hideTip, true);
  // 在別的視窗（提示、觀察題…）裡點名詞：先關掉那個視窗；在閱讀視窗裡點就直接換文章
  const go = (t) => { if (t.closest('#modal-root') && !t.closest('.kbr')) hooks.closeModal(); openConcept(app, t.dataset.k); };
  document.addEventListener('click', (e) => { const t = termOf(e); if (t) { e.preventDefault(); go(t); } });
  document.addEventListener('keydown', (e) => { const t = termOf(e); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(t); } });
}

// ───────────── 共用：清單的一列、圖、文章的內容 ─────────────
const catName = (id) => (CATS.find((c) => c.id === id) || {}).name || id;

function row(app, c, current) {
  return h('button', { type: 'button', class: 'kb-row' + (current ? ' cur' : ''), onclick: () => openConcept(app, c.id) },
    h('span', { class: 'kb-row-h' }, h('b', { text: c.t }), c.en && h('small', { text: c.en })),
    h('span', { class: 'kb-row-s', text: c.sum }));
}

/** 這一關會用到的觀念 */
export const levelKb = (lv) => (lv && !lv.sandbox ? levelConcepts(KB_INDEX, CONCEPTS, lv, 10) : []);

function figure(f) {
  if (f.type === 'table') {
    return h('div', { class: 'kb-fig' }, f.title && h('div', { class: 'kb-fig-t', text: f.title }),
      h('div', { class: 'kb-table-w' }, h('table', { class: 'kb-table' },
        h('thead', null, h('tr', null, f.head.map((x) => h('th', { text: x })))),
        h('tbody', null, f.rows.map((r) => h('tr', null, r.map((x) => h('td', { text: x }))))))));
  }
  if (f.type === 'fields') {
    return h('div', { class: 'kb-fig' }, h('div', { class: 'kb-fig-t', text: f.title }),
      h('div', { class: 'kb-fields' }, f.rows.map((x) => h('div', { class: 'kb-field' + (x.hl ? ' hl' : ''), style: { flexGrow: x.w || 1 } },
        h('b', { text: x.l }), h('small', { text: /^[\d–≈ ]+$/.test(x.n) ? x.n + ' 位元組' : x.n })))),
      f.rows.some((x) => x.d) && h('ul', { class: 'kb-fig-notes' }, f.rows.filter((x) => x.d).map((x) => h('li', null, h('b', { text: x.l }), '：' + x.d))));
  }
  if (f.type === 'ladder') {
    return h('div', { class: 'kb-fig' },
      h('div', { class: 'kb-ladder' },
        h('div', { class: 'kb-lad-h' }, h('span', { text: f.a }), h('span', { text: f.b })),
        f.msgs.map((m, n) => h('div', { class: 'kb-msg ' + (m.from === 'a' ? 'ltr' : 'rtl') }, h('span', { class: 'kb-msg-n', text: n + 1 }), h('span', { class: 'kb-msg-t', text: m.t }), h('i')))));
  }
  if (f.type === 'bits') {
    const ip = parseIp(f.ip), bits = f.bits, mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0;
    const net = (ip & mask) >>> 0, bc = (net | (~mask >>> 0)) >>> 0;
    const cells = [];
    for (let o = 0; o < 4; o++) {
      const oct = [];
      for (let b = 0; b < 8; b++) { const i = o * 8 + b; oct.push(h('i', { class: i < bits ? 'n' : 'h', text: (ip >>> (31 - i)) & 1 })); }
      cells.push(h('span', { class: 'kb-oct' }, h('span', { class: 'kb-bits' }, oct), h('small', { text: (ip >>> (24 - o * 8)) & 255 })));
    }
    return h('div', { class: 'kb-fig' }, h('div', { class: 'kb-fig-t', text: `${f.ip}/${bits} 的 32 個位元` }),
      h('div', { class: 'kb-bitrow' }, cells),
      h('div', { class: 'kb-bitkey' }, h('span', null, h('i', { class: 'n' }), `網段 ${bits} 位元`), h('span', null, h('i', { class: 'h' }), `主機 ${32 - bits} 位元`)),
      h('div', { class: 'kb-kv' },
        h('span', { text: '遮罩' }), h('b', { class: 'mono', text: fmtIp(mask) }),
        h('span', { text: '網段位址' }), h('b', { class: 'mono', text: fmtIp(net) }),
        h('span', { text: '廣播位址' }), h('b', { class: 'mono', text: fmtIp(bc) }),
        h('span', { text: '可用主機' }), h('b', { class: 'mono', text: bits >= 31 ? '—' : `${fmtIp(net + 1)} – ${fmtIp(bc - 1)}` })));
  }
  return null;
}

/** 文章的本文：段落、圖、步驟、常見的錯誤、指令（兩種顯示方式共用） */
const textBlocks = (c) => [
  ...(c.body || []).map((p) => h('p', { class: 'kb-p' }, linkText(p, c.id))),
  ...[].concat(c.fig || []).map(figure),
  c.steps && h('div', { class: 'kb-box' }, h('b', { class: 'kb-box-t', text: c.steps.t }),
    h('ol', { class: 'kb-steps' }, c.steps.items.map((x) => h('li', null, linkText(x, c.id))))),
  c.pit && c.pit.length && h('div', { class: 'kb-box warn' }, h('b', { class: 'kb-box-t' }, icon('bulb', 14), '常見的錯誤'),
    h('ul', { class: 'kb-pit' }, c.pit.map((x) => h('li', null, linkText(x, c.id))))),
  c.cmd && c.cmd.length && h('div', { class: 'kb-cmds' }, c.cmd.map((x) => h('div', { class: 'kb-cmd' }, h('span', { class: 'kb-cmd-v', text: x.v }), h('pre', { text: x.c.join('\n') })))),
  deepBlocks(c),
];
const deepId = (c, n) => `kbd-${c.id}-${n}`;
/**
 * 「深入了解」：上面是重點，這裡是完整的說明 —— 一段一個小標題，可以有段落、條列、表格、設定範例與提醒。
 * c.deep = [{ h, p?: [...], list?: [...], table?: { head, rows, title? }, code?: { v, c } | [...], note? }]
 */
function deepBlocks(c) {
  if (!c.deep || !c.deep.length) return null;
  return h('div', { class: 'kb-deep' },
    h('h2', { class: 'kb-deep-h' }, h('span', { text: '深入了解' }), h('small', { text: `${c.deep.length} 個主題` })),
    c.deep.map((s, n) => h('section', { class: 'kb-deep-s', id: deepId(c, n) },
      h('h3', null, h('i', { text: String(n + 1).padStart(2, '0') }), h('span', { text: s.h })),
      (s.p || []).map((x) => h('p', { class: 'kb-p' }, linkText(x, c.id))),
      s.list && h('ul', { class: 'kb-pit kb-deep-l' }, s.list.map((x) => h('li', null, linkText(x, c.id)))),
      s.table && figure({ type: 'table', ...s.table }),
      s.code && h('div', { class: 'kb-cmds' }, [].concat(s.code).map((x) => h('div', { class: 'kb-cmd' }, h('span', { class: 'kb-cmd-v', text: x.v }), h('pre', { text: x.c.join('\n') })))),
      s.note && h('div', { class: 'kb-box kb-deep-n' }, h('b', { class: 'kb-box-t' }, icon('bulb', 14), '實務與考試的重點'), h('p', { class: 'kb-p' }, linkText(s.note, c.id))))));
}
/** 「在這些關卡練習」的關卡按鈕 */
function levelChips(app, c, max) {
  const lvls = conceptLevels(KB_INDEX, c, LEVELS);
  if (!lvls.length) return null;
  return h('div', { class: 'chips' }, lvls.slice(0, max).map((lv) => h('button', {
    type: 'button', class: 'chip lvchip' + (lv === app.level ? ' done' : ''), title: lv === app.level ? `${lv.title}（就是這一關）` : `${lv.title}（點一下前往）`,
    onclick: () => { if (lv === app.level) return; if (reader) hooks.closeModal(); app.loadLevel(LEVELS.indexOf(lv)); },
  }, hooks.levelNo(lv))), lvls.length > max && h('span', { class: 'chip', text: `+${lvls.length - max}` }));
}

// ───────────── 閱讀視窗 ─────────────
let reader = null; // { app, nav, main, q }：開著的時候才有

/** 打開閱讀視窗（已經開著就重畫）。沒有指定文章的話是首頁 */
export function openReader(app) {
  if (!hooks.modal) return;
  const k = kbState(app);
  if (k.id && !CONCEPT[k.id]) k.id = null;
  if (reader) { drawReader(); return; }
  const q = h('input', {
    class: 'inp kb-q', type: 'search', placeholder: '搜尋觀念：VLAN、子介面、OSPF、三向交握…', value: k.q, spellcheck: 'false', 'aria-label': '搜尋知識庫',
    oninput: (e) => { k.q = e.target.value; drawReader(true); },
    onkeydown: (e) => { if (e.key === 'Escape' && k.q) { e.preventDefault(); e.stopPropagation(); k.q = ''; e.target.value = ''; drawReader(true); } else if (e.key !== 'Escape') e.stopPropagation(); },
  });
  const nav = h('aside', { class: 'kbr-nav' }), main = h('div', { class: 'kbr-main' });
  const head = h('div', { class: 'kbr-head' },
    h('button', { type: 'button', class: 'kbr-brand', title: '回到知識庫的首頁', onclick: () => { k.id = null; k.back = []; k.q = ''; q.value = ''; drawReader(); } },
      h('i', { class: 'mode-ic' }, icon('book', 18)), h('span', null, h('b', { text: '知識庫' }), h('small', { text: `${CONCEPTS.length} 則觀念 · ${CATS.length} 類` }))),
    h('label', { class: 'kb-search kbr-search' }, icon('search', 15), q),
    button('釘在左側', { ic: 'topo', kind: 'ghost', small: true, title: '把知識庫放回左側的面板：空間比較小，但可以一邊看一邊設定設備', onclick: () => setDock(app, true) }),
    h('button', { type: 'button', class: 'mini kbr-x', title: '關閉（Esc 或 K）', 'aria-label': '關閉', onclick: () => hooks.closeModal() }, icon('x', 16)));
  const dlg = hooks.modal([head, h('div', { class: 'kbr-body' }, nav, main)], { wide: true, onClose: () => { reader = null; hideTip(); } });
  dlg.classList.add('kbr');
  reader = { app, nav, main, q };
  drawReader();
}

function drawReader(keepNav) {
  if (!reader) return;
  const { app, nav, main } = reader, k = kbState(app);
  const cur = k.id && CONCEPT[k.id];
  if (cur) k.open[cur.cat] = true; // 正在看的文章所在的分類一定是展開的
  if (!keepNav && reader.q.value !== k.q) reader.q.value = k.q; // 不是正在打字：搜尋框跟著狀態（開文章時會清掉）
  if (!keepNav) {
    const item = (c) => h('button', { type: 'button', class: 'kbr-item' + (cur && c.id === cur.id ? ' on' : ''), title: c.sum, onclick: () => openConcept(app, c.id) }, c.t);
    const mine = levelKb(app.level);
    const keep = nav.scrollTop;
    nav.replaceChildren(...[
      mine.length ? h('div', { class: 'kbr-grp' }, h('h3', { class: 'sec', text: '這一關會用到' }), mine.map(item)) : null,
      h('h3', { class: 'sec', text: '全部的觀念' }),
      ...CATS.map((cat) => {
        const items = CONCEPTS.filter((c) => c.cat === cat.id), open = !!k.open[cat.id];
        return h('div', { class: 'kbr-cat' + (open ? ' open' : '') },
          h('button', { type: 'button', class: 'kbr-cat-h', 'aria-expanded': String(open), title: cat.desc, onclick: () => { k.open[cat.id] = !open; drawReader(); } },
            icon('chevron', 13), h('b', { text: cat.name }), h('em', { text: items.length })),
          open && h('div', { class: 'kbr-cat-b' }, items.map(item)));
      }),
    ].filter(Boolean));
    nav.scrollTop = keep;
    const on = nav.querySelector('.kbr-item.on');
    if (on && (on.offsetTop < nav.scrollTop || on.offsetTop > nav.scrollTop + nav.clientHeight - 40)) nav.scrollTop = Math.max(0, on.offsetTop - nav.clientHeight / 3);
  }
  const card = (c) => h('button', { type: 'button', class: 'kbr-card', onclick: () => openConcept(app, c.id) },
    h('span', { class: 'kbr-card-h' }, h('b', null, c.t, c.deep && c.deep.length ? h('em', { class: 'kbr-deep-tag', title: `有「深入了解」：${c.deep.length} 個主題`, text: '深入' }) : null), c.en && h('small', { text: c.en })), h('span', { class: 'kbr-card-s', text: c.sum }));
  let kids;
  if (k.q.trim()) {
    const hits = searchConcepts(CONCEPTS, k.q);
    kids = [h('div', { class: 'kbr-pad' },
      h('h2', { class: 'kbr-h2', text: hits.length ? `找到 ${hits.length} 則和「${k.q.trim()}」有關的觀念` : `找不到「${k.q.trim()}」` }),
      hits.length ? h('div', { class: 'kbr-cards' }, hits.map(card))
        : h('p', { class: 'kb-empty', text: '換個說法試試，例如英文縮寫（VLAN、OSPF）、中文名稱（子介面、三向交握），或指令裡的關鍵字（portfast）。' }))];
  } else if (cur) kids = [article(app, cur, k)];
  else {
    const mine = levelKb(app.level);
    kids = [h('div', { class: 'kbr-pad' },
      h('div', { class: 'kbr-hero' }, h('h1', { text: '知識庫' }),
        h('p', { text: '每一則觀念都有一句話的摘要、說明、流程或演算法的步驟、圖、常見的錯誤與各家設備的指令，並列出可以在哪些關卡練習。關卡說明、學習筆記與提示裡有點狀底線的名詞，點一下就會開到這裡。' })),
      mine.length ? h('section', { class: 'kbr-sec' }, h('h2', { class: 'kbr-h2' }, '這一關會用到', h('small', { text: `${hooks.levelNo(app.level)}　${app.level.title}` })), h('div', { class: 'kbr-cards' }, mine.map(card))) : null,
      CATS.map((cat) => h('section', { class: 'kbr-sec' }, h('h2', { class: 'kbr-h2' }, cat.name, h('small', { text: cat.desc })),
        h('div', { class: 'kbr-cards' }, CONCEPTS.filter((c) => c.cat === cat.id).map(card)))))];
  }
  main.replaceChildren(...kids);
  main.scrollTop = 0;
}

/** 閱讀視窗裡的一篇文章：左邊是本文，右邊（夠寬的時候）是相關的觀念與可以練習的關卡 */
function article(app, c, k) {
  const sib = CONCEPTS.filter((x) => x.cat === c.cat), n = sib.indexOf(c);
  const prev = sib[n - 1], next = sib[n + 1];
  const see = (c.see || []).filter((s) => CONCEPT[s]).map((s) => CONCEPT[s]);
  const lv = levelChips(app, c, 24);
  const back = () => { k.id = k.back.pop() || null; drawReader(); };
  const home = () => { k.id = null; k.back = []; drawReader(); };
  return h('article', { class: 'kbr-art' },
    h('div', { class: 'kbr-crumb' },
      k.back.length ? h('button', { type: 'button', class: 'btn ghost sm kb-back', onclick: back }, icon('undo', 14), h('span', { text: '上一則：' + (CONCEPT[k.back[k.back.length - 1]] || {}).t })) : null,
      h('button', { type: 'button', class: 'kbr-link', onclick: home }, '知識庫'), h('span', { class: 'sep', text: '›' }), h('span', { text: catName(c.cat) })),
    h('header', { class: 'kb-title' }, h('h1', { text: c.t }), c.en && h('p', { class: 'mono', text: c.en })),
    h('p', { class: 'kb-lead', text: c.sum }),
    h('div', { class: 'kbr-cols' },
      h('div', { class: 'kbr-text' }, textBlocks(c)),
      (see.length || lv || c.deep) && h('aside', { class: 'kbr-rail' },
        c.deep && c.deep.length ? h('div', { class: 'kbr-rail-b kbr-toc' }, h('h3', { class: 'sec', text: '這一篇的內容' }),
          h('button', { type: 'button', class: 'kbr-toc-i', onclick: () => { reader.main.scrollTop = 0; } }, '重點整理'),
          c.deep.map((s, n) => h('button', { type: 'button', class: 'kbr-toc-i', title: s.h, onclick: () => { const el = document.getElementById(deepId(c, n)); if (el) el.scrollIntoView({ block: 'start' }); } },
            h('i', { text: String(n + 1).padStart(2, '0') }), h('span', { text: s.h })))) : null,
        see.length ? h('div', { class: 'kbr-rail-b' }, h('h3', { class: 'sec', text: '相關的觀念' }),
          see.map((x) => h('button', { type: 'button', class: 'kbr-rel kb-see', title: x.sum, onclick: () => openConcept(app, x.id) }, h('b', { text: x.t }), h('span', { text: x.sum })))) : null,
        lv ? h('div', { class: 'kbr-rail-b' }, h('h3', { class: 'sec', text: '在這些關卡練習' }), lv) : null)),
    h('div', { class: 'kbr-pn' },
      prev ? h('button', { type: 'button', class: 'kbr-pnb', onclick: () => openConcept(app, prev.id) }, h('small', { text: '← 上一篇' }), h('b', { text: prev.t })) : h('span'),
      next ? h('button', { type: 'button', class: 'kbr-pnb next', onclick: () => openConcept(app, next.id) }, h('small', { text: '下一篇 →' }), h('b', { text: next.t })) : h('span')));
}

// ───────────── 釘在左側面板的知識庫分頁 ─────────────
function listView(app, k) {
  const out = [];
  const input = h('input', {
    class: 'inp kb-q', type: 'search', placeholder: '搜尋：VLAN、子介面、OSPF、NAT…', value: k.q, 'aria-label': '搜尋知識庫',
    oninput: (e) => { k.q = e.target.value; const res = results(); body.replaceChildren(...res); },
    onkeydown: (e) => { if (e.key === 'Escape' && k.q) { e.stopPropagation(); k.q = ''; e.target.value = ''; body.replaceChildren(...results()); } },
  });
  out.push(dockBar(app), h('label', { class: 'kb-search' }, icon('search', 15), input));
  const body = h('div', { class: 'kb-list' });
  const results = () => {
    if (k.q.trim()) {
      const hits = searchConcepts(CONCEPTS, k.q);
      return hits.length ? [h('h3', { class: 'sec', text: `找到 ${hits.length} 則` }), ...hits.map((c) => row(app, c))]
        : [h('p', { class: 'kb-empty', text: `找不到「${k.q.trim()}」。換個說法試試，例如英文縮寫（VLAN）或中文名稱（子介面）。` })];
    }
    const mine = levelKb(app.level);
    const blocks = [];
    if (mine.length) blocks.push(h('h3', { class: 'sec', text: '這一關會用到' }), ...mine.map((c) => row(app, c)));
    blocks.push(h('h3', { class: 'sec', text: `全部的觀念（${CONCEPTS.length}）` }));
    for (const cat of CATS) {
      const items = CONCEPTS.filter((c) => c.cat === cat.id);
      const open = !!k.open[cat.id];
      blocks.push(h('div', { class: 'kb-cat' + (open ? ' open' : '') },
        h('button', { type: 'button', class: 'kb-cat-h', 'aria-expanded': String(open), onclick: () => { k.open[cat.id] = !open; body.replaceChildren(...results()); } },
          h('span', null, h('b', { text: cat.name }), h('small', { text: cat.desc })), h('em', { text: items.length }), icon('chevron', 14)),
        open && h('div', { class: 'kb-cat-b' }, items.map((c) => row(app, c)))));
    }
    return blocks;
  };
  body.replaceChildren(...results());
  out.push(body);
  return out;
}
/** 釘在左側時最上面的一列：說明現在是釘住的，可以放大回閱讀視窗 */
const dockBar = (app) => h('div', { class: 'kb-dock' }, h('span', { text: '釘在左側' }),
  button('放大閱讀', { ic: 'grid', small: true, title: '改回寬的閱讀視窗（字與圖比較大）', onclick: () => setDock(app, false) }));

function articleView(app, k) {
  const c = CONCEPT[k.id];
  const back = () => { k.id = k.back.pop() || null; k.scroll = 0; hooks.renderMission(app); };
  const lv = levelChips(app, c, 12);
  return [
    dockBar(app),
    h('div', { class: 'kb-top' },
      h('button', { type: 'button', class: 'btn ghost sm kb-back', onclick: back }, icon('undo', 14), h('span', { text: k.back.length ? '上一則' : '知識庫' })),
      h('span', { class: 'chip', text: catName(c.cat) })),
    h('div', { class: 'kb-title' }, h('h2', { text: c.t }), c.en && h('p', { class: 'mono', text: c.en })),
    h('p', { class: 'kb-lead', text: c.sum }),
    ...textBlocks(c),
    c.see && c.see.length && h('div', { class: 'kb-sec' }, h('h3', { class: 'sec', text: '相關的觀念' }),
      h('div', { class: 'chips' }, c.see.filter((s) => CONCEPT[s]).map((s) => h('button', { type: 'button', class: 'chip kb-see', title: CONCEPT[s].sum, onclick: () => openConcept(app, s) }, CONCEPT[s].t)))),
    lv && h('div', { class: 'kb-sec' }, h('h3', { class: 'sec', text: '在這些關卡練習' }), lv),
  ];
}

/** 左側面板的分頁列 */
export function missionTabs(app) {
  const k = kbState(app), n = levelKb(app.level).length, dock = kbDocked(app);
  const tab = (id, label, extra, title) => h('button', { type: 'button', class: 'tab' + (k.tab === id && (id !== 'kb' || dock) ? ' on' : ''), 'aria-selected': String(k.tab === id), role: 'tab', title, onclick: () => showKbTab(app, id) }, label, extra);
  return h('div', { class: 'tabs m-tabs', role: 'tablist' }, tab('mission', app.level && app.level.sandbox ? '自由模式' : '任務'),
    tab('kb', '知識庫', [n > 0 && h('em', { class: 'm-tab-n', text: n }), !dock && h('i', { class: 'm-tab-open' }, icon('grid', 11))],
      dock ? '知識庫（釘在左側，K 鍵切換）' : `打開知識庫（K 鍵）${n ? `：這一關會用到 ${n} 則觀念` : ''}`));
}

/** 知識庫分頁的內容（可以捲動的那一塊；只有釘在左側的時候會用到） */
export function kbView(app) {
  const k = kbState(app);
  if (k.id && !CONCEPT[k.id]) k.id = null;
  const focused = document.activeElement && document.activeElement.classList.contains('kb-q');
  const caret = focused ? document.activeElement.selectionStart : null;
  const scroll = h('div', { class: 'm-scroll kb-scroll', onscroll: (e) => { k.scroll = e.target.scrollTop; } }, k.id ? articleView(app, k) : listView(app, k));
  requestAnimationFrame(() => {
    scroll.scrollTop = k.scroll;
    if (focused && !k.id) { const q = scroll.querySelector('.kb-q'); if (q) { q.focus(); if (caret != null) q.setSelectionRange(caret, caret); } }
  });
  return scroll;
}
