// 測驗模式（觀念題、子網路速算）與證照地圖
import { h, icon, button } from './dom.js';
import { modal, closeModal, levelNo } from './hud.js';
import { TOPICS, QUESTIONS, LEVEL_TOPIC } from '../data/quiz.js';
import { CERTS } from '../data/certs.js';
import { LEVELS } from '../levels/index.js';
import { fmtIp, fmtMask, netOf, bcastOf } from '../engine/ip.js';

const rnd = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** 隨機產生一題子網路計算題 */
export function subnetQuestion() {
  const bits = 17 + rnd(14); // /17 ~ /30
  const o = [[10, rnd(256), rnd(256)], [172, 16 + rnd(16), rnd(256)], [192, 168, rnd(256)]][rnd(3)];
  let ip = (o[0] * 2 ** 24 + o[1] * 2 ** 16 + o[2] * 256 + rnd(256)) >>> 0;
  const size = 2 ** (32 - bits);
  const net = netOf(ip, bits), bc = bcastOf(ip, bits);
  if (ip === net) ip += 1;
  if (ip === bc) ip -= 1;
  const S = `${fmtIp(ip)}/${bits}`;
  const range = (n) => `${fmtIp(n + 1)} – ${fmtIp(n + size - 2)}`;
  let q, correct, cand;
  switch (rnd(5)) {
    case 0:
      q = `${S} 位於哪一個子網路（網路位址）？`;
      correct = fmtIp(net);
      cand = [fmtIp(net + size), fmtIp(net - size), fmtIp(netOf(ip, bits - 1)), fmtIp(netOf(ip, Math.min(30, bits + 1))), fmtIp(net + size * 2)];
      break;
    case 1:
      q = `${S} 所在子網路的廣播位址是？`;
      correct = fmtIp(bc);
      cand = [fmtIp(bc + size), fmtIp(bc - size), fmtIp(bcastOf(ip, bits - 1)), fmtIp(bc - 1), fmtIp(net)];
      break;
    case 2:
      q = `一個 /${bits} 的子網路有幾個可用的主機位址？`;
      correct = String(size - 2);
      cand = [String(size), String(size * 2 - 2), String(Math.max(0, size / 2 - 2)), String(size - 1), String(size * 2)];
      break;
    case 3:
      q = `前綴長度 /${bits} 對應的子網路遮罩是？`;
      correct = fmtMask(bits);
      cand = [fmtMask(bits - 1), fmtMask(bits + 1), fmtMask(bits - 2), fmtMask(Math.min(32, bits + 2))];
      break;
    default:
      q = `${S} 所在子網路的可用主機位址範圍是？`;
      correct = range(net);
      cand = [`${fmtIp(net)} – ${fmtIp(bc)}`, `${fmtIp(net + 1)} – ${fmtIp(bc)}`, range(net + size), range(net - size)];
  }
  const opts = [correct];
  for (const c of cand) if (opts.length < 4 && !opts.includes(c)) opts.push(c);
  const a = shuffle(opts);
  return {
    q, a, c: a.indexOf(correct), r: 'CCNA 1.6 · Network+ 1.7',
    e: `/${bits} 的遮罩是 ${fmtMask(bits)}，每 ${size} 個位址一塊。這一塊的網路位址是 ${fmtIp(net)}、廣播位址是 ${fmtIp(bc)}，可用位址 ${range(net)}，共 ${size - 2} 個。`,
  };
}

/** 執行一輪測驗。next() 每次回傳一題；total 為 0 代表無限題 */
function runQuiz(app, { title, key, total, next }) {
  let n = 0, score = 0;
  const dlg = modal([]);
  const finish = () => {
    const best = Math.max(app.store.quiz[key] || 0, Math.round((score / Math.max(1, n)) * 100));
    if (total) { app.store.quiz[key] = best; app.saveStore(); }
    const pct = Math.round((score / Math.max(1, n)) * 100);
    dlg.replaceChildren(
      h('div', { class: 'done-top' }, h('div', { class: 'done-ring' + (pct >= 80 ? '' : ' soft') }, icon(pct >= 80 ? 'check' : 'book', 32)),
        h('h2', { text: `${score} / ${n} 題答對` }),
        h('p', { class: 'muted', text: pct >= 80 ? '觀念很穩，可以挑戰下一個主題。' : pct >= 50 ? '還不錯，再看一次解說會更扎實。' : '別灰心，回去玩對應的關卡再來一次。' })),
      h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: closeModal }), button('回到測驗選單', { ic: 'book', kind: 'primary', onclick: () => openQuiz(app) })));
  };
  const ask = () => {
    const item = next(n);
    if (!item) return finish();
    n++;
    const opts = item.a.map((t, i) => h('button', { type: 'button', class: 'qopt', onclick: () => pick(i) }, h('span', { class: 'ql', text: 'ABCD'[i] }), h('span', { text: t })));
    const after = h('div', { class: 'qafter' });
    function pick(i) {
      if (after.childNodes.length) return;
      const ok = i === item.c;
      if (ok) score++;
      opts.forEach((b, k) => { b.disabled = true; if (k === item.c) b.classList.add('right'); else if (k === i) b.classList.add('wrong'); });
      after.append(
        h('div', { class: 'qexp ' + (ok ? 'ok' : 'bad') }, h('b', { text: ok ? '答對了！' : '答錯了' }), h('p', { text: item.e }), item.r && h('span', { class: 'chip cert', text: item.r })),
        h('div', { class: 'd-actions' },
          !total && button('結束練習', { kind: 'ghost', onclick: finish }),
          button(total && n >= total ? '看結果' : '下一題', { ic: 'chevron', kind: 'primary', onclick: () => (total && n >= total ? finish() : ask()) })));
    }
    dlg.replaceChildren(
      h('div', { class: 'qhead' }, h('b', { text: title }), h('span', { class: 'muted', text: total ? `第 ${n} / ${total} 題` : `第 ${n} 題 · 答對 ${score}` })),
      h('h2', { class: 'qq', text: item.q }), h('div', { class: 'qopts' }, opts), after);
  };
  ask();
}

const fromPool = (pool, count) => {
  const list = shuffle(pool).slice(0, count);
  return (n) => list[n];
};

export function openQuiz(app) {
  const card = (name, desc, meta, onclick, best) => h('button', { type: 'button', class: 'lv', onclick },
    h('div', { class: 'top' }, h('span', { class: 'no', text: meta }), best != null && h('span', { class: 'no', style: { color: best >= 80 ? 'var(--ok)' : 'var(--muted)' }, text: `最佳 ${best}%` })),
    h('b', { text: name }), h('p', { text: desc }));
  const all = Object.values(QUESTIONS).flat();
  modal([
    h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('book', 30)),
      h('div', null, h('h1', { text: '觀念測驗' }), h('p', { text: '依照 CCNA、Network+、Security+ 的考試範圍編寫的練習題，每一題都有解說與對應的考試條目。' }))),
    h('div', { class: 'lv-grid' },
      card('子網路速算', '隨機出題、無限練習：網路位址、廣播位址、主機數、遮罩。', '無限題', () => runQuiz(app, { title: '子網路速算', key: 'subnet', total: 0, next: () => subnetQuestion() })),
      card('綜合測驗', '從所有主題隨機抽 10 題。', '10 題', () => runQuiz(app, { title: '綜合測驗', key: 'mixed', total: 10, next: fromPool(all, 10) }), app.store.quiz.mixed),
      TOPICS.map((t) => card(t.name, t.desc, `${QUESTIONS[t.id].length} 題`,
        () => runQuiz(app, { title: t.name, key: t.id, total: QUESTIONS[t.id].length, next: fromPool(QUESTIONS[t.id], QUESTIONS[t.id].length) }), app.store.quiz[t.id]))),
    h('p', { class: 'muted', style: { fontSize: '12px' }, text: '這些是為了練習而自行編寫的題目，不是任何認證考試的實際試題。' }),
  ], { wide: true });
}

/** 過關之後的三題小考 */
export function openLevelQuiz(app, levelId) {
  const t = TOPICS.find((x) => x.id === LEVEL_TOPIC[levelId]);
  if (!t) return openQuiz(app);
  runQuiz(app, { title: `小考：${t.name}`, key: 'lv-' + levelId, total: 3, next: fromPool(QUESTIONS[t.id], 3) });
}
export const hasLevelQuiz = (levelId) => !!LEVEL_TOPIC[levelId];

export function openCerts(app, which = 'ccna') {
  const done = app.store.done;
  const dlg = modal([], { wide: true });
  const draw = (id) => {
    const cert = CERTS.find((c) => c.id === id);
    const items = cert.domains.flatMap((d) => d.items);
    const covered = items.filter((i) => i[2].length).length;
    const cleared = items.filter((i) => i[2].length && i[2].every((l) => done[l])).length;
    dlg.replaceChildren(
      h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('award', 30)),
        h('div', null, h('h1', { text: '證照地圖' }), h('p', { text: '每一關對應到哪些考試條目，以及哪些範圍目前還沒有關卡。' })),
        h('div', { class: 'prog' }, h('b', { text: `${covered} / ${items.length}` }), h('span', { text: `條目有對應關卡 · 你已完成 ${cleared} 條` }))),
      h('div', { class: 'seg' }, CERTS.map((c) => h('button', { type: 'button', class: c.id === id ? 'on' : '', onclick: () => draw(c.id) }, `${c.name} ${c.code}`))),
      h('div', { class: 'cbar' }, h('i', { style: { width: (cleared / items.length) * 100 + '%' } }), h('em', { style: { width: (covered / items.length) * 100 + '%' } })),
      h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: cert.note + ' 條目標題為中文摘要，實際範圍請以官方公布的考試大綱為準。' }),
      ...cert.domains.map((d) => h('section', { class: 'chapter' }, h('h2', { text: d.name }),
        h('div', { class: 'crows' }, d.items.map(([code, title, levels]) => {
          const all = levels.length && levels.every((l) => done[l]);
          return h('div', { class: 'crow' + (levels.length ? '' : ' none') + (all ? ' all' : '') },
            h('span', { class: 'ccode mono', text: code }), h('span', { class: 'ctitle', text: title }),
            h('span', { class: 'clv' }, levels.length ? levels.map((l) => {
              const lv = LEVELS.find((x) => x.id === l);
              return h('button', {
                type: 'button', class: 'chip lvchip' + (done[l] ? ' done' : ''), title: lv.title,
                onclick: () => { closeModal(); app.loadLevel(LEVELS.indexOf(lv)); },
              }, levelNo(lv));
            }) : h('span', { class: 'muted', text: '尚未涵蓋' })));
        })))),
    );
  };
  draw(which);
}
