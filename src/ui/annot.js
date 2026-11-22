// 標註：設備的註解（顯示在設備旁邊的便利貼）與群組框（同一個群組的設備用虛線框起來，左上角寫名稱）
// 存在狀態裡：state.notes = [{ at: 設備, text }]、state.groups = [{ name, devs: [設備], color }]，可以復原、跟著存檔與匯出
import { h, button } from './dom.js';
import { field } from './form.js';
import { modal, closeModal } from './hud.js';

const COLORS = [0x6ea8ff, 0x4fd8c4, 0xf5b547, 0xb48cff, 0xff8fab];

export function openAnnot(app, devId) {
  const st = app.state, d = st.devices[devId];
  if (!d) return;
  const note = (st.notes || []).find((n) => n.at === devId);
  const grp = (st.groups || []).find((g) => (g.devs || []).includes(devId));
  const ta = h('textarea', { class: 'inp annot-text', rows: 3, maxLength: 160, placeholder: '例如：機房 A 櫃 U12、下週要換掉', spellcheck: 'false' });
  ta.value = note ? note.text : '';
  const gi = h('input', { class: 'inp annot-group', maxLength: 30, placeholder: '群組名稱，例如 機房 A（空白＝不加入群組）', spellcheck: 'false', list: 'annot-groups' });
  gi.value = grp ? grp.name : '';
  const save = () => {
    const text = ta.value.trim().slice(0, 160);
    const notes = (st.notes || []).filter((n) => n.at !== devId);
    if (text) notes.push({ at: devId, text });
    if (notes.length) st.notes = notes; else delete st.notes;
    const name = gi.value.trim().slice(0, 30);
    let groups = (st.groups || []).map((g) => ({ ...g, devs: (g.devs || []).filter((x) => x !== devId) }));
    if (name) {
      let g = groups.find((x) => x.name === name);
      if (!g) { g = { name, devs: [], color: COLORS[groups.length % COLORS.length] }; groups.push(g); }
      g.devs.push(devId);
    }
    groups = groups.filter((g) => g.devs.length);
    if (groups.length) st.groups = groups; else delete st.groups;
    closeModal();
    app.changed();
    app.renderPanel();
  };
  for (const el of [gi]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  modal([
    h('h2', { text: `標註 · ${d.name}` }),
    h('p', { class: 'muted', text: '註解會顯示在場景裡這台設備的旁邊；同一個群組的設備會被虛線框起來。標註不影響網路，可以復原，也會跟著存檔與匯出。' }),
    field('註解', ta),
    field('群組框', gi),
    h('datalist', { id: 'annot-groups' }, (st.groups || []).map((g) => h('option', { value: g.name }))),
    h('div', { class: 'd-actions' }, button('取消', { kind: 'ghost', onclick: closeModal }), button('儲存', { ic: 'check', kind: 'primary', onclick: save })),
  ]);
  // 視窗出現之後游標放在註解欄（使用者已經點了別的欄位就不搶）
  setTimeout(() => { const a = document.activeElement; if (!a || a === document.body || !document.getElementById('modal-root').contains(a)) ta.focus(); }, 30);
}
