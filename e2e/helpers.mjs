// 瀏覽器端測試共用的工具：收集頁面錯誤、檢查畫面上不該出現的字（undefined、NaN、[object Object]…）
import { test as base, expect } from '@playwright/test';

/** 每個測試都會收集頁面上的例外與 console.error；測試結束時必須是空的 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push('頁面例外：' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error：' + m.text()); });
    await page.addInitScript(installScan);
    page.errors = errors;
    await use(page);
    expect(errors, '頁面上出現錯誤').toEqual([]);
  },
});
export { expect };

/** 打開遊戲（獨立的 e2e 存檔），等到第一關載入 */
export async function boot(page, { keepDialog = false } = {}) {
  await page.goto('/?profile=e2e');
  await page.waitForFunction(() => window.linkup && window.linkup.state && document.querySelector('#topbar .crumb'));
  if (!keepDialog) await closeDialog(page);
}

/** 等場景的鏡頭停下來（切關卡時會有一段對焦動畫，標籤位置還在動的時候點下去會點錯設備） */
export async function waitScene(page) {
  await page.evaluate(async () => {
    const pos = () => [...document.querySelectorAll('.dev-label')].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top); }).join('|');
    const frame = () => new Promise((ok) => requestAnimationFrame(() => ok()));
    let last = pos(), same = 0;
    for (let i = 0; i < 900 && same < 12; i++) { await frame(); const p = pos(); same = p === last ? same + 1 : 0; last = p; }
  });
}

export async function closeDialog(page) {
  if (await page.locator('#modal-root .backdrop').count()) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  }
}

/** 在頁面裡檢查一個區塊；回傳問題清單 */
export const scan = (page, sel, where) => page.evaluate(([s, w]) => window.__scan(document.querySelector(s), w), [sel, where]);

// 注入到頁面裡執行：走過所有文字節點、輸入框的值與提示文字
function installScan() {
  const BAD = /\bundefined\b|\bNaN\b|\[object Object\]|\bInfinity\b/;
  window.__scan = (root, where) => {
    const out = [];
    if (!root) return out;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue;
      if (BAD.test(t) || t.trim() === 'null' || t.trim() === 'false' || t.trim() === 'true') out.push(`${where}：文字「${t.trim().slice(0, 140)}」`);
    }
    for (const el of root.querySelectorAll('input, textarea')) {
      if (el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') continue;
      if (BAD.test(el.value) || el.value === 'null') out.push(`${where}：輸入框的值「${el.value.slice(0, 140)}」`);
    }
    for (const el of root.querySelectorAll('[title], [placeholder]')) {
      for (const a of ['title', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v && (BAD.test(v) || v === 'null')) out.push(`${where}：${a}「${v.slice(0, 140)}」`);
      }
    }
    // 面板內容不該出現水平捲軸（太長的文字要換行，表格要能縮）
    for (const el of root.querySelectorAll('.p-body, .m-scroll, .dialog')) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const wide = [...el.querySelectorAll('*')].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1 && getComputedStyle(c).position !== 'fixed')
          .filter((c) => !c.closest('pre, .term-out, .cli-out, textarea, .tbl-wrap, .scroll-x'))
          .slice(0, 2).map((c) => `${c.tagName.toLowerCase()}.${[...c.classList].join('.')}「${(c.textContent || '').trim().slice(0, 40)}」`);
        if (wide.length) out.push(`${where}：${el.className} 出現水平捲軸（${el.scrollWidth} > ${el.clientWidth}）：${wide.join('、')}`);
      }
    }
    return out;
  };
}
