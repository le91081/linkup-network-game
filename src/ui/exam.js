// 模擬考：限時、依考試領域的比重抽題，交卷後依領域計分（題目是自行編寫的練習題，不是實際試題）
import { h, icon, button } from './dom.js';
import { QUESTIONS } from '../data/quiz.js';
import { subnetQuestion } from './quiz.js';

/** 兩種考試：領域、比重、計分方式（換算後的分數只是參考） */
export const EXAMS = {
  ccna: {
    name: 'Cisco CCNA 200-301', short: 'CCNA', min: 300, max: 1000, pass: 825,
    domains: [['1', '網路基礎', 20], ['2', '網路存取', 20], ['3', 'IP 連線', 25], ['4', 'IP 服務', 10], ['5', '安全基礎', 15], ['6', '自動化與可程式化', 10]],
    note: '實際的考試約 100 題、120 分鐘，有單選、複選、拖拉與模擬器題型；Cisco 沒有公布及格分數，一般認為約在 825 / 1000。',
  },
  netplus: {
    name: 'CompTIA Network+ N10-009', short: 'Network+', min: 100, max: 900, pass: 720,
    domains: [['1', '網路概念', 23], ['2', '網路實作', 20], ['3', '網路維運', 19], ['4', '網路安全', 14], ['5', '網路故障排除', 24]],
    note: '實際的考試最多 90 題、90 分鐘，含實作題 (PBQ)；及格分數 720（100 – 900 分）。',
  },
};
export const LENGTHS = [[20, 25], [40, 50]];

/** 題目屬於考試的哪個領域。Network+ 沒有直接標註的題目，用 CCNA 的領域對照（題目與 CCNA 共用） */
function domainOf(exam, q) {
  const parts = String(q.r || '').split('·').map((x) => x.trim());
  for (const p of parts) { const m = p.match(/^(CCNA|Network\+|Security\+) (\d)\./); if (m && m[1] === EXAMS[exam].short) return m[2]; }
  if (exam === 'netplus') {
    const c = parts.map((p) => p.match(/^CCNA (\d)\./)).find(Boolean);
    if (!c) return null;
    if (/最可能的原因|為什麼|怎麼辦|會怎樣|會發生什麼|少了什麼|找不到|連不到|不通/.test(q.q)) return '5';
    return { 1: '1', 2: '2', 3: '2', 4: '3', 5: '4', 6: '1' }[c[1]];
  }
  return null;
}

const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
/** 依比重分配題數（最大餘數法），再從各領域抽題；某個領域題目不夠就由其他領域補 */
export function buildExam(exam, n) {
  const E = EXAMS[exam];
  const all = Object.values(QUESTIONS).flat();
  const pools = Object.fromEntries(E.domains.map(([d]) => [d, shuffle(all.filter((q) => domainOf(exam, q) === d))]));
  const raw = E.domains.map(([d, , w]) => [d, (n * w) / 100]);
  const cnt = Object.fromEntries(raw.map(([d, x]) => [d, Math.floor(x)]));
  let left = n - Object.values(cnt).reduce((a, b) => a + b, 0);
  for (const [d] of raw.slice().sort((a, b) => (b[1] % 1) - (a[1] % 1))) { if (left <= 0) break; cnt[d]++; left--; }
  const out = [];
  for (const [d] of E.domains) {
    for (let k = 0; k < cnt[d]; k++) {
      // 網路基礎 / 網路概念：一部分是隨機產生的子網路計算題
      if (d === '1' && k % 3 === 2) { out.push({ ...subnetQuestion(), dom: d }); continue; }
      const q = pools[d].shift();
      if (q) out.push({ ...q, dom: d });
    }
  }
  const rest = shuffle(Object.values(pools).flat());
  while (out.length < n && rest.length) { const q = rest.shift(); out.push({ ...q, dom: domainOf(exam, q) }); }
  while (out.length < n) out.push({ ...subnetQuestion(), dom: '1' });
  // 選項也打亂（記住正確答案換到哪裡）
  return shuffle(out).map((q) => { const order = shuffle(q.a.map((_, i) => i)); return { ...q, a: order.map((i) => q.a[i]), c: order.indexOf(q.c) }; });
}

export function openExamPicker(app, { modal, closeModal }) {
  let exam = 'ccna', len = 0;
  const dlg = modal([], { wide: true });
  const draw = () => {
    const E = EXAMS[exam], [n, mins] = LENGTHS[len];
    const hist = (app.store.exams || []).filter((x) => x.exam === exam).slice(-5).reverse();
    dlg.replaceChildren(
      h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('clock', 30)),
        h('div', null, h('h1', { text: '模擬考' }), h('p', { text: '限時作答、依考試領域的比重抽題，交卷後才看答案，並依領域分析強弱。題目是為了練習自行編寫的，不是實際試題；換算的分數只是參考。' }))),
      h('div', { class: 'seg' }, Object.entries(EXAMS).map(([k, x]) => h('button', { type: 'button', class: k === exam ? 'on' : '', onclick: () => { exam = k; draw(); } }, x.name))),
      h('div', { class: 'drill-opts' },
        h('div', null, h('div', { class: 'f-label', text: '題數與時間' }), h('div', { class: 'seg' }, LENGTHS.map(([q, m], i) => h('button', { type: 'button', class: i === len ? 'on' : '', onclick: () => { len = i; draw(); } }, `${q} 題 · ${m} 分鐘`)))),
        h('div', null, h('div', { class: 'f-label', text: '領域比重' }), h('div', { class: 'exam-w' }, E.domains.map(([d, t, w]) => h('span', { class: 'chip', text: `${d}. ${t} ${w}%` }))))),
      h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: E.note }),
      hist.length ? h('section', { class: 'chapter' }, h('h2', { text: '最近的成績' }), h('div', { class: 'crows' }, hist.map((x) => h('div', { class: 'crow' + (x.pass ? ' all' : '') },
        h('span', { class: 'ccode mono', text: String(x.scaled) }), h('span', { class: 'ctitle', text: `${x.correct} / ${x.n} 題 · 用了 ${Math.ceil(x.secs / 60)} 分鐘 · ${new Date(x.at).toLocaleDateString('zh-TW')}` }),
        h('span', { class: 'clv', text: x.pass ? '及格' : '未及格' }))))) : null,
      h('div', { class: 'd-actions' }, button('取消', { kind: 'ghost', onclick: closeModal }),
        button(`開始作答（${n} 題 · ${mins} 分鐘）`, { ic: 'play', kind: 'primary', onclick: () => runExam(app, { modal, closeModal }, exam, n, mins) })));
  };
  draw();
}

function runExam(app, ui, exam, n, mins) {
  const E = EXAMS[exam];
  const qs = buildExam(exam, n);
  const ans = new Array(qs.length).fill(null), flag = new Set();
  const t0 = Date.now(), limit = mins * 60;
  let cur = 0, timer = null, over = false;
  const dlg = ui.modal([], { wide: true, onClose: () => clearInterval(timer) });
  const left = () => Math.max(0, limit - Math.floor((Date.now() - t0) / 1000));
  const clock = h('b', { class: 'exam-clock mono' });
  const tick = () => {
    const s = left();
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    clock.classList.toggle('low', s <= 60);
    if (!s && !over) { over = true; submit(true); }
  };
  timer = setInterval(tick, 500);
  const draw = () => {
    const q = qs[cur];
    dlg.replaceChildren(
      h('div', { class: 'qhead' }, h('b', { text: `${E.short} 模擬考` }), h('span', { class: 'muted', text: `第 ${cur + 1} / ${qs.length} 題 · 已作答 ${ans.filter((x) => x != null).length}` }), clock),
      h('div', { class: 'exam-grid' }, qs.map((_, i) => h('button', { type: 'button', class: `eg ${i === cur ? 'cur' : ''} ${ans[i] != null ? 'ans' : ''} ${flag.has(i) ? 'flag' : ''}`, onclick: () => { cur = i; draw(); } }, String(i + 1)))),
      h('h2', { class: 'qq', text: q.q }),
      h('div', { class: 'qopts' }, q.a.map((t, i) => h('button', { type: 'button', class: 'qopt' + (ans[cur] === i ? ' picked' : ''), onclick: () => { ans[cur] = i; draw(); } }, h('span', { class: 'ql', text: 'ABCD'[i] }), h('span', { text: t })))),
      h('div', { class: 'd-actions' },
        button(flag.has(cur) ? '取消標記' : '標記稍後檢查', { ic: 'flag', kind: 'ghost', onclick: () => { if (flag.has(cur)) flag.delete(cur); else flag.add(cur); draw(); } }),
        button('上一題', { kind: 'ghost', onclick: () => { if (cur > 0) { cur--; draw(); } } }),
        cur < qs.length - 1 ? button('下一題', { ic: 'chevron', kind: 'primary', onclick: () => { cur++; draw(); } }) : button('交卷', { ic: 'check', kind: 'primary', onclick: () => confirmSubmit() })));
    tick();
  };
  const confirmSubmit = () => {
    const blank = ans.filter((x) => x == null).length;
    if (!blank && !flag.size) return submit(false);
    dlg.replaceChildren(h('h2', { text: '確定要交卷嗎？' }),
      h('p', { class: 'muted', text: `${blank ? `還有 ${blank} 題沒有作答（算錯）。` : ''}${flag.size ? `有 ${flag.size} 題標記了稍後檢查。` : ''}` }),
      h('div', { class: 'd-actions' }, button('回去檢查', { kind: 'ghost', onclick: draw }), button('交卷', { ic: 'check', kind: 'primary', onclick: () => submit(false) })));
  };
  const submit = (timeout) => {
    clearInterval(timer);
    const secs = Math.min(limit, Math.round((Date.now() - t0) / 1000));
    const ok = qs.map((q, i) => ans[i] === q.c);
    const correct = ok.filter(Boolean).length;
    const pct = correct / qs.length;
    const scaled = Math.round(E.min + (E.max - E.min) * pct);
    const doms = E.domains.map(([d, t]) => { const idx = qs.map((q, i) => (q.dom === d ? i : -1)).filter((i) => i >= 0); return { d, t, n: idx.length, ok: idx.filter((i) => ok[i]).length }; });
    const rec = { exam, n: qs.length, correct, scaled, pass: scaled >= E.pass, secs, at: Date.now(), domains: Object.fromEntries(doms.map((x) => [x.d, [x.ok, x.n]])) };
    (app.store.exams ||= []).push(rec);
    if (app.store.exams.length > 40) app.store.exams.shift();
    app.saveStore();
    const weak = doms.filter((x) => x.n && x.ok / x.n < 0.7).map((x) => `${x.d}. ${x.t}`);
    dlg.replaceChildren(
      h('div', { class: 'done-top' }, h('div', { class: 'done-ring' + (rec.pass ? '' : ' soft') }, icon(rec.pass ? 'award' : 'book', 32)),
        h('h2', { text: `${scaled} 分　${rec.pass ? '及格' : '未及格'}` }),
        h('p', { class: 'muted', text: `${timeout ? '時間到，自動交卷。' : ''}答對 ${correct} / ${qs.length} 題（${Math.round(pct * 100)}%）· 用了 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒 · 及格標準 ${E.pass}` })),
      h('div', { class: 'exam-doms' }, doms.map((x) => h('div', { class: 'ed' },
        h('span', { text: `${x.d}. ${x.t}` }), h('div', { class: 'cbar' }, h('i', { style: { width: (x.n ? (x.ok / x.n) * 100 : 0) + '%' } })), h('b', { class: 'mono', text: x.n ? `${x.ok}/${x.n}` : '—' })))),
      weak.length ? h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: `比較弱的領域：${weak.join('、')}。可以回到對應的關卡，或在「測驗」裡針對主題練習。` }) : null,
      h('details', { class: 'exam-review' }, h('summary', { text: `看答案與解說（答錯 ${qs.length - correct} 題）` }),
        ...qs.map((q, i) => h('div', { class: 'qexp ' + (ok[i] ? 'ok' : 'bad') },
          h('b', { text: `${i + 1}. ${q.q}` }),
          h('p', { text: `你的答案：${ans[i] == null ? '（沒有作答）' : 'ABCD'[ans[i]] + '. ' + q.a[ans[i]]}${ok[i] ? '' : `　正確答案：${'ABCD'[q.c]}. ${q.a[q.c]}`}` }),
          h('p', { text: q.e }), q.r && h('span', { class: 'chip cert', text: q.r })))),
      h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: ui.closeModal }), button('再考一次', { ic: 'reset', kind: 'primary', onclick: () => openExamPicker(app, ui) })));
  };
  draw();
}
