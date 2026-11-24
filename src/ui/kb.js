// 知識庫：左側面板的「知識庫」分頁（清單、搜尋、文章），以及文字裡的名詞連結（滑鼠移上去看摘要、點一下開文章）
import { h, icon } from './dom.js';
import { CATS, CONCEPTS, CONCEPT, KB_INDEX } from '../data/kb/index.js';
import { splitTerms, levelConcepts, conceptLevels, searchConcepts } from '../data/kb/match.js';
import { LEVELS } from '../levels/index.js';
import { parseIp, fmtIp } from '../engine/ip.js';

let hooks = { renderMission: () => {}, levelNo: (lv) => lv.id, closeModal: () => {} };
/** 左側面板的狀態：tab = 'mission' | 'kb'；id = 正在看的文章；back = 上一頁的文章；open = 展開的分類 */
export const kbState = (app) => (app.kb ||= { tab: 'mission', id: null, q: '', back: [], open: {}, scroll: 0 });

// ───────────── 名詞連結 ─────────────
/** 把一段文字裡提到的觀念變成連結（每個觀念只連第一次出現的地方）。skip：不要連的觀念（文章自己） */
export function linkText(text, skip) {
  return splitTerms(KB_INDEX, String(text ?? ''), skip).map((s) => (s.id
    ? h('span', { class: 'kterm', 'data-k': s.id, tabindex: '0', role: 'button', text: s.text })
    : s.text));
}

/** 打開某一則文章（切到知識庫分頁） */
export function openConcept(app, id) {
  const k = kbState(app);
  if (!CONCEPT[id]) return;
  if (k.tab === 'kb' && k.id && k.id !== id) k.back.push(k.id);
  else if (k.tab !== 'kb' || !k.id) k.back = [];
  k.tab = 'kb'; k.id = id; k.scroll = 0;
  hideTip();
  hooks.renderMission(app);
}
export function showKbTab(app, tab) {
  const k = kbState(app);
  k.tab = tab;
  hooks.renderMission(app);
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

/** 安裝：名詞連結的滑鼠、鍵盤事件（整頁共用一個），以及左側面板重畫的方法 */
export function installKb(app, h2) {
  hooks = { ...hooks, ...h2 };
  const termOf = (e) => e.target && e.target.closest && e.target.closest('.kterm');
  document.addEventListener('mouseover', (e) => { const t = termOf(e); if (t && t !== tipFor) showTip(t); else if (!t && tipFor) hideTip(); });
  document.addEventListener('focusin', (e) => { const t = termOf(e); if (t) showTip(t); });
  document.addEventListener('focusout', (e) => { if (termOf(e)) hideTip(); });
  document.addEventListener('scroll', hideTip, true);
  const go = (t) => { if (t.closest('#modal-root')) hooks.closeModal(); openConcept(app, t.dataset.k); };
  document.addEventListener('click', (e) => { const t = termOf(e); if (t) { e.preventDefault(); go(t); } });
  document.addEventListener('keydown', (e) => { const t = termOf(e); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(t); } });
}

// ───────────── 左側面板的知識庫分頁 ─────────────
const catName = (id) => (CATS.find((c) => c.id === id) || {}).name || id;

function row(app, c, current) {
  return h('button', { type: 'button', class: 'kb-row' + (current ? ' cur' : ''), onclick: () => openConcept(app, c.id) },
    h('span', { class: 'kb-row-h' }, h('b', { text: c.t }), c.en && h('small', { text: c.en })),
    h('span', { class: 'kb-row-s', text: c.sum }));
}

/** 這一關會用到的觀念 */
export const levelKb = (lv) => (lv && !lv.sandbox ? levelConcepts(KB_INDEX, CONCEPTS, lv, 10) : []);

function listView(app, k) {
  const out = [];
  const input = h('input', {
    class: 'inp kb-q', type: 'search', placeholder: '搜尋：VLAN、子介面、OSPF、NAT…', value: k.q, 'aria-label': '搜尋知識庫',
    oninput: (e) => { k.q = e.target.value; const res = results(); body.replaceChildren(...res); },
    onkeydown: (e) => { if (e.key === 'Escape' && k.q) { e.stopPropagation(); k.q = ''; e.target.value = ''; body.replaceChildren(...results()); } },
  });
  out.push(h('label', { class: 'kb-search' }, icon('search', 15), input));
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

function articleView(app, k) {
  const c = CONCEPT[k.id];
  const lvls = conceptLevels(KB_INDEX, c, LEVELS);
  const back = () => { k.id = k.back.pop() || null; k.scroll = 0; hooks.renderMission(app); };
  const figs = [].concat(c.fig || []);
  return [
    h('div', { class: 'kb-top' },
      h('button', { type: 'button', class: 'btn ghost sm kb-back', onclick: back }, icon('undo', 14), h('span', { text: k.back.length ? '上一則' : '知識庫' })),
      h('span', { class: 'chip', text: catName(c.cat) })),
    h('div', { class: 'kb-title' }, h('h2', { text: c.t }), c.en && h('p', { class: 'mono', text: c.en })),
    h('p', { class: 'kb-lead', text: c.sum }),
    ...(c.body || []).map((p) => h('p', { class: 'kb-p' }, linkText(p, c.id))),
    ...figs.map(figure),
    c.steps && h('div', { class: 'kb-box' }, h('b', { class: 'kb-box-t', text: c.steps.t }),
      h('ol', { class: 'kb-steps' }, c.steps.items.map((x) => h('li', null, linkText(x, c.id))))),
    c.pit && c.pit.length && h('div', { class: 'kb-box warn' }, h('b', { class: 'kb-box-t' }, icon('bulb', 14), '常見的錯誤'),
      h('ul', { class: 'kb-pit' }, c.pit.map((x) => h('li', null, linkText(x, c.id))))),
    c.cmd && c.cmd.length && h('div', { class: 'kb-cmds' }, c.cmd.map((x) => h('div', { class: 'kb-cmd' }, h('span', { class: 'kb-cmd-v', text: x.v }), h('pre', { text: x.c.join('\n') })))),
    c.see && c.see.length && h('div', { class: 'kb-sec' }, h('h3', { class: 'sec', text: '相關的觀念' }),
      h('div', { class: 'chips' }, c.see.filter((s) => CONCEPT[s]).map((s) => h('button', { type: 'button', class: 'chip kb-see', title: CONCEPT[s].sum, onclick: () => openConcept(app, s) }, CONCEPT[s].t)))),
    lvls.length > 0 && h('div', { class: 'kb-sec' }, h('h3', { class: 'sec', text: '在這些關卡練習' }),
      h('div', { class: 'chips' }, lvls.slice(0, 12).map((lv) => h('button', {
        type: 'button', class: 'chip lvchip' + (lv === app.level ? ' done' : ''), title: lv === app.level ? `${lv.title}（就是這一關）` : `${lv.title}（點一下前往）`,
        onclick: () => { if (lv !== app.level) app.loadLevel(LEVELS.indexOf(lv)); },
      }, hooks.levelNo(lv))), lvls.length > 12 && h('span', { class: 'chip', text: `+${lvls.length - 12}` }))),
  ];
}

/** 左側面板的分頁列 */
export function missionTabs(app) {
  const k = kbState(app), n = levelKb(app.level).length;
  const tab = (id, label, extra) => h('button', { type: 'button', class: 'tab' + (k.tab === id ? ' on' : ''), 'aria-selected': String(k.tab === id), role: 'tab', onclick: () => showKbTab(app, id) }, label, extra);
  return h('div', { class: 'tabs m-tabs', role: 'tablist' }, tab('mission', app.level && app.level.sandbox ? '自由模式' : '任務'), tab('kb', '知識庫', n > 0 && h('em', { class: 'm-tab-n', text: n })));
}

/** 知識庫分頁的內容（可以捲動的那一塊） */
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
