// 關卡編輯器：在自由模式擺好拓撲與目標之後，寫上任務說明與提示、指定哪些設備不能改，就成了一個關卡。
// 可以自己試玩、存成自訂關卡、匯出成檔案分享，也可以匯入別人做的關卡。
import { h, icon, button, toast, ownKeys } from './dom.js';
import { modal, closeModal } from './hud.js';
import { saveJson } from './save.js';
import { cloneState } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { sandboxObjectives, checkImport } from './sandbox.js';
import { SAVE_VER, migrateState } from '../engine/migrate.js';

const metaOf = (st) => (st.meta ||= { title: '', brief: '', hints: [], lock: [] });

/** 自訂關卡的資料 → 和內建關卡一樣的關卡物件 */
export function customLevel(c) {
  const st0 = c.state;
  return {
    id: c.id, custom: true, chapter: 0,
    title: c.title || '未命名的關卡', subtitle: '自訂關卡', tags: ['自訂關卡'],
    brief: c.brief || '（作者沒有寫任務說明）',
    learn: [{ t: '自訂關卡', d: '這一關是在自由模式設計的。灰色、上了鎖的設備不歸你管（就像 ISP 的設備），其他設備都可以設定。' }],
    hints: (c.hints || []).filter(Boolean), recap: [`完成了「${c.title || '未命名的關卡'}」。`],
    objectives: sandboxObjectives(st0),
    setup() {
      const s = cloneState(st0);
      delete s.meta;
      s.leases ||= {}; s.seq ||= 1; s.v6 = true;
      for (const id of c.lock || []) if (s.devices[id]) s.devices[id].locked = true;
      return s;
    },
    solve: null,
  };
}

/** 從自由模式目前的桌面產生自訂關卡的資料 */
function snapshot(app) {
  const st = cloneState(app.state), m = metaOf(app.state);
  delete st.dyn; delete st.clock; delete st.meta;
  return { id: m.id || 'custom-' + Date.now().toString(36), title: m.title.trim(), brief: m.brief.trim(), hints: m.hints.map((x) => x.trim()).filter(Boolean), lock: m.lock.filter((id) => st.devices[id]), state: st };
}
function problems(app) {
  const st = app.state, m = metaOf(st);
  const out = [];
  if (!m.title.trim()) out.push('還沒有關卡名稱');
  if (!sandboxObjectives(st).length) out.push('還沒有任何目標（在上面「自訂目標」存幾個測試）');
  if (Object.keys(st.devices).length < 2) out.push('桌面上至少要有兩台設備');
  return out;
}

/** 自由模式的「關卡設計」區塊 */
export function editorSection(app) {
  const st = app.state, m = metaOf(st);
  const commit = () => app.changed();
  const txt = (get, set, ph, multi) => {
    const el = h(multi ? 'textarea' : 'input', { class: 'inp' + (multi ? ' ed-brief' : ''), value: get(), placeholder: ph, spellcheck: 'false', rows: multi ? 4 : undefined });
    el.addEventListener('change', () => { set(el.value); commit(); });
    el.addEventListener('keydown', ownKeys);
    return el;
  };
  const devs = Object.values(st.devices);
  const bad = problems(app);
  return h('details', { class: 'ed-box', open: !!(m.title || m.brief) },
    h('summary', null, icon('edit', 13), ' 關卡設計：把這個拓撲做成關卡'),
    h('label', { class: 'field' }, h('span', { class: 'f-label', text: '關卡名稱' }), txt(() => m.title, (v) => { m.title = v; }, '例如：分公司連不上總部')),
    h('label', { class: 'field' }, h('span', { class: 'f-label', text: '任務說明（玩家一開始看到的情境）' }), txt(() => m.brief, (v) => { m.brief = v; }, '描述需求與限制，例如：分公司的電腦要能開總部的 ERP，但不能連到研發網段。', true)),
    h('div', { class: 'f-label', text: '提示（玩家卡住時一個一個打開，每看一個少一顆星）' }),
    ...m.hints.map((t, i) => h('div', { class: 'ed-hint' }, h('b', { text: i + 1 }), txt(() => t, (v) => { m.hints[i] = v; }, '提示內容'),
      h('button', { class: 'mini danger', type: 'button', title: '刪除提示', onclick: () => { m.hints.splice(i, 1); commit(); app.renderMissionNow(); } }, icon('x', 13)))),
    h('div', { class: 'sbx-row' }, button('新增提示', { ic: 'plus', small: true, onclick: () => { m.hints.push(''); commit(); app.renderMissionNow(); } })),
    h('div', { class: 'f-label', text: '鎖定的設備（玩家看得到、不能設定，例如 ISP 或別的部門的設備）' }),
    h('div', { class: 'chips' }, devs.map((d) => {
      const on = m.lock.includes(d.id);
      return h('button', { type: 'button', class: 'chip btnchip' + (on ? ' on' : ''), onclick: () => { m.lock = on ? m.lock.filter((x) => x !== d.id) : [...m.lock, d.id]; commit(); app.renderMissionNow(); } }, on ? icon('lock', 11) : null, d.name);
    })),
    bad.length ? h('div', { class: 'note warn', text: '還不能做成關卡：' + bad.join('；') }) : null,
    h('div', { class: 'sbx-row' },
      button('試玩', { ic: 'play', small: true, onclick: () => { if (bad.length) return toast(bad[0], 'bad'); app.openCustom(snapshot(app), { test: true }); } }),
      button('存成自訂關卡', { ic: 'save', small: true, onclick: () => {
        if (bad.length) return toast(bad[0], 'bad');
        const c = snapshot(app);
        m.id = c.id;
        const list = (app.store.custom ||= []);
        const at = list.findIndex((x) => x.id === c.id);
        if (at >= 0) list[at] = c; else list.push(c);
        app.saveStore();
        commit();
        toast(`已存成自訂關卡「${c.title}」：在關卡選單的「自訂關卡」裡`, 'ok', 4500);
      } }),
      button('匯出關卡', { ic: 'download', small: true, onclick: () => { if (bad.length) return toast(bad[0], 'bad'); downloadLevel(snapshot(app)); } })),
    h('p', { class: 'tip', text: '建議做法：先把網路做到「全部目標都通過」，再故意改壞幾個地方，玩家的任務就是把它修好。設定改好之後記得再存一次。' }));
}

function downloadLevel(c) {
  const data = { app: 'LinkUp', kind: 'level', version: 1, title: c.title, brief: c.brief, hints: c.hints, lock: c.lock, state: { ...c.state, ver: SAVE_VER } };
  saveJson(`linkup-level-${(c.title || 'custom').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)}.json`, data, `已匯出關卡「${c.title}」`);
}

/** 匯入別人分享的關卡檔 */
export function importLevel(app, text) {
  let data;
  try { data = JSON.parse(text); } catch { toast('讀不懂這個檔案：它不是 JSON', 'bad'); return null; }
  if (!data || data.app !== 'LinkUp' || data.kind !== 'level') { toast('這不是 LinkUp 的關卡檔（拓撲檔請到自由模式匯入）', 'bad', 5000); return null; }
  if (data.state && migrateState(data.state).newer) { toast('這個關卡檔是比較新的版本做的，這個版本讀不懂：請更新 LinkUp 再匯入', 'bad', 5000); return null; }
  const why = checkImport(data);
  if (why) { toast('無法匯入：' + why, 'bad', 5000); return null; }
  const c = { id: 'custom-' + Date.now().toString(36), title: String(data.title || '匯入的關卡').slice(0, 60), brief: String(data.brief || '').slice(0, 2000), hints: (Array.isArray(data.hints) ? data.hints : []).map((x) => String(x).slice(0, 500)).slice(0, 10), lock: (Array.isArray(data.lock) ? data.lock : []).map(String), state: cloneState(data.state) };
  try { const s = customLevel(c).setup(); recompute(s); } catch { toast('無法匯入：檔案裡的設定資料不完整', 'bad', 5000); return null; }
  (app.store.custom ||= []).push(c);
  app.saveStore();
  toast(`已匯入關卡「${c.title}」`, 'ok');
  return c;
}

/** 關卡選單裡的「自訂關卡」 */
export function openCustomLevels(app) {
  const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { if (importLevel(app, String(rd.result))) openCustomLevels(app); };
    rd.readAsText(f);
    file.value = '';
  });
  const list = app.store.custom || [];
  modal([
    h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('edit', 30)),
      h('div', null, h('h1', { text: '自訂關卡' }), h('p', { text: '在自由模式擺好拓撲、存幾個目標、寫上任務說明與提示，就可以做成關卡。也可以匯入別人分享的關卡檔。' }))),
    list.length ? h('div', { class: 'lv-grid' }, list.map((c) => {
      const d = app.store.done[c.id];
      return h('div', { class: 'lv' + (d ? ' done' : '') },
        h('div', { class: 'top' }, h('span', { class: 'no', text: '自訂' + (d ? '  ✓' : '') }), h('span', { class: 'muted', style: { fontSize: '11px' }, text: `${Object.keys(c.state.devices).length} 台設備 · ${sandboxObjectives(c.state).length} 個目標` })),
        h('b', { text: c.title }), h('p', { text: c.brief.slice(0, 80) + (c.brief.length > 80 ? '…' : '') }),
        h('div', { class: 'sbx-row' },
          button('遊玩', { ic: 'play', kind: 'primary', small: true, onclick: () => { closeModal(); app.openCustom(c); } }),
          button('匯出', { ic: 'download', small: true, onclick: () => downloadLevel(c) }),
          button('刪除', { ic: 'trash', small: true, onclick: () => { app.store.custom = list.filter((x) => x !== c); app.saveStore(); openCustomLevels(app); } })));
    })) : h('p', { class: 'muted', text: '還沒有自訂關卡。到自由模式的「關卡設計」做一個，或匯入關卡檔。' }),
    h('div', { class: 'd-actions' }, file, button('匯入關卡檔', { ic: 'upload', onclick: () => file.click() }), button('關閉', { kind: 'ghost', onclick: closeModal })),
  ], { wide: true });
}
