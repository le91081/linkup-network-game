// 鍵盤快捷鍵（正在打字、或有視窗開著的時候不作用；Esc、空白鍵、Ctrl + Z / Y 在 main.js）
import { h, button, toast } from './dom.js';
import { modal, closeModal } from './hud.js';
import { toggleSound } from './sound.js';

export const SHORTCUTS = [
  ['?', '顯示這份快捷鍵清單'],
  ['Ctrl + Enter', '執行測試'],
  ['[ / ]', '選上一台 / 下一台設備'],
  ['1 – 9', '切換設定面板的第 N 個分頁'],
  ['/', '游標移到終端機或 CLI 的輸入列'],
  ['T', '切換 3D 場景與 2D 邏輯拓撲圖'],
  ['H', '提示'],
  ['K', '左側切換「任務」與「知識庫」'],
  ['L', '關卡清單'],
  ['M', '音效開 / 關'],
  ['空白鍵', '測試進行中：快轉封包動畫'],
  ['Esc', '關閉視窗、離開輸入框、取消選取'],
  ['Ctrl + Z / Ctrl + Y', '復原 / 重做'],
];

export function openShortcuts() {
  modal([
    h('h2', { text: '鍵盤快捷鍵' }),
    h('div', { class: 'keys' }, SHORTCUTS.map(([k, d]) => h('div', { class: 'key-row' }, h('kbd', { text: k }), h('span', { text: d })))),
    h('div', { class: 'd-actions' }, button('關閉', { kind: 'primary', onclick: closeModal })),
  ]);
}

/** 安裝全域快捷鍵。hud：openLevels、openHints、modalOpen */
export function installShortcuts(app, hud) {
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || hud.modalOpen()) return;
    if (e.altKey) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); app.run(); return; }
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === '?') { e.preventDefault(); openShortcuts(); return; }
    if (k === '[' || k === ']') {
      const ids = Object.keys(app.state.devices);
      if (!ids.length) return;
      const cur = ids.indexOf(app.selected);
      const n = cur < 0 ? (k === ']' ? 0 : ids.length - 1) : (cur + (k === ']' ? 1 : -1) + ids.length) % ids.length;
      app.select(ids[n]);
      e.preventDefault();
      return;
    }
    if (/^[1-9]$/.test(k) && app.selected) {
      const tab = document.querySelectorAll('#panel .tab')[+k - 1];
      if (tab) { tab.click(); e.preventDefault(); }
      return;
    }
    if (k === '/') {
      const inp = document.querySelector('#panel .term-input');
      if (inp) { inp.focus(); e.preventDefault(); }
      return;
    }
    const low = k.toLowerCase();
    if (low === 't') { app.toggle2d(); e.preventDefault(); }
    else if (low === 'h' && app.level && (app.level.hints || []).length) { hud.openHints(app); e.preventDefault(); }
    else if (low === 'l') { hud.openLevels(app); e.preventDefault(); }
    else if (low === 'k') { hud.toggleKb(app); e.preventDefault(); }
    else if (low === 'm') { toast(toggleSound(app) ? '音效：開' : '音效：關'); e.preventDefault(); }
  });
}
