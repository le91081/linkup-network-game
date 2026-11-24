// 設定面板裡的「表格列」（.thead + .trow，一列好幾個輸入框）：面板窄的時候改成一格一格、上面帶標籤的排法。
// 標籤直接從表頭複製到每一格（包一層 .tcell[data-l]），寬的時候 .tcell 是 display: contents，排版和原本一模一樣；
// 窄的時候（CSS 的 container query）表頭藏起來，每一格自己顯示標籤。只處理欄位多、窄的時候會被截斷的那幾種表格。
const TABLES = ['c-dns', 'c-route', 'c-lbm', 'c-ad', 'c-patch'];
const cls = (el) => TABLES.find((c) => el.classList.contains(c));

function headOf(row, c) {
  for (let p = row.previousElementSibling, n = 0; p && n < 80; p = p.previousElementSibling, n++) {
    if (p.classList.contains('thead') && p.classList.contains(c)) return p;
  }
  return null;
}

function label(root) {
  for (const row of root.querySelectorAll('.trow:not([data-lab])')) {
    const c = cls(row);
    if (!c) { row.dataset.lab = '-'; continue; }
    const head = headOf(row, c);
    row.dataset.lab = '1';
    if (!head) continue;
    head.classList.add('lab');
    row.classList.add('lab');
    const names = [...head.children].map((x) => x.textContent.trim());
    [...row.children].forEach((cell, i) => {
      const l = names[i];
      if (!l || cell.classList.contains('mini')) return;
      const wrap = document.createElement('span');
      wrap.className = 'tcell';
      wrap.dataset.l = l;
      cell.replaceWith(wrap);
      wrap.append(cell);
    });
  }
}

/** 監看設定面板：有新的表格列出現就替它加上標籤 */
export function installTables(root) {
  if (!root) return;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; label(root); });
  }).observe(root, { childList: true, subtree: true });
  label(root);
}
