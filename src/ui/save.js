// 把資料存成 JSON 檔。一般的瀏覽器直接下載；
// 發佈成 Claude 的 Artifact 時，頁面不能下載檔案，改成把內容顯示出來，讓人複製之後自己存檔（之後一樣可以用「匯入」載回來）
import { h, button, toast } from './dom.js';
import { modal, closeModal } from './hud.js';

/** 這一份是不是打包給 Artifact 的（vite build --mode artifact） */
export const IN_ARTIFACT = import.meta.env?.MODE === 'artifact';

export function saveJson(name, data, okText) {
  const text = JSON.stringify(data, null, 1);
  if (!IN_ARTIFACT) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(okText, 'ok');
    return;
  }
  const ta = h('textarea', { id: 'save-text', class: 'inp mono save-text', readOnly: true, spellcheck: 'false' });
  ta.value = text;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('已複製：貼到記事本，存成 ' + name, 'ok', 5000); } catch { ta.focus(); ta.select(); toast('這裡不能直接複製：內容已經全選，按 Ctrl + C', 'info', 5000); }
  };
  modal([
    h('h2', { text: '匯出' }),
    h('p', { class: 'muted', text: `這個頁面不能下載檔案。把下面的內容複製起來，存成 ${name}；之後在「匯入」選這個檔案就能載回來。` }),
    ta,
    h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: closeModal }), button('複製全部', { ic: 'check', kind: 'primary', onclick: copy })),
  ], { wide: true });
}
