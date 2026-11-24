// 知識庫（左側的第二個分頁）、文字裡的名詞連結，以及面板窄的時候表格列的排法；兩種螢幕大小都跑
import { test, expect, boot, scan, waitScene } from './helpers.mjs';

async function open(page, id) {
  await page.evaluate((id) => { const app = window.linkup; app.openLevel(app.levels.find((l) => l.id === id), { fresh: true }); app.settleNow(); }, id);
  await waitScene(page);
}
const kbTab = (page) => page.locator('#mission .m-tabs .tab', { hasText: '知識庫' });

test('知識庫：這一關會用到的觀念、文章、上一頁、搜尋', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  await kbTab(page).click();
  await expect(kbTab(page)).toHaveClass(/on/);
  const m = page.locator('#mission');
  await expect(m.locator('h3.sec').first()).toHaveText('這一關會用到');
  await m.locator('.kb-row', { hasText: '子介面' }).first().click();
  await expect(m.locator('.kb-title h2')).toHaveText('子介面');
  await expect(m.locator('.kb-table')).toBeVisible();
  await expect(m.locator('.kb-cmd pre').first()).toContainText('encapsulation dot1Q 10');
  // 文章裡的名詞也可以連到別的文章，上一頁回到原本那一則
  await m.locator('.kb-see', { hasText: 'Trunk' }).click();
  await expect(m.locator('.kb-title h2')).toHaveText('Trunk');
  await expect(m.locator('.kb-field.hl').first()).toBeVisible();
  await m.locator('.kb-back').click();
  await expect(m.locator('.kb-title h2')).toHaveText('子介面');
  await m.locator('.kb-back').click();
  await m.locator('.kb-q').fill('dijkstra');
  await expect(m.locator('.kb-row').first()).toContainText('OSPF');
  await m.locator('.kb-row').first().click();
  await expect(m.locator('.kb-steps li')).toHaveCount(4);
  expect(await scan(page, '#mission', '知識庫')).toEqual([]);
  // 執行測試的按鈕在知識庫分頁也看得到
  await expect(m.locator('.m-foot .btn.primary')).toBeVisible();
});

test('名詞連結：滑鼠移上去看摘要、點一下打開文章；提示裡的名詞也可以點', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  const term = page.locator('#mission .brief .kterm').first();
  await term.hover();
  await expect(page.locator('.ktip')).toBeVisible();
  await expect(page.locator('.ktip b')).toHaveText(await term.textContent());
  await term.click();
  await expect(kbTab(page)).toHaveClass(/on/);
  await expect(page.locator('#mission .kb-title h2')).toBeVisible();
  // K 鍵切回任務
  await page.locator('#stage').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('k');
  await expect(page.locator('#mission .m-tabs .tab', { hasText: '任務' })).toHaveClass(/on/);
  // 右側學習筆記的「想知道更多」
  await page.locator('#panel .kb-more .kb-see').first().click();
  await expect(kbTab(page)).toHaveClass(/on/);
  // 提示視窗裡的名詞：點了關掉視窗、打開文章
  await page.locator('#mission .m-tabs .tab', { hasText: '任務' }).click();
  await page.locator('#topbar button', { hasText: '提示' }).click();
  const dlg = page.locator('#modal-root .dialog');
  await dlg.getByRole('button', { name: '顯示第一個提示' }).click();
  const ht = dlg.locator('.hint-item .kterm').first();
  if (await ht.count()) {
    await ht.click();
    await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
    await expect(kbTab(page)).toHaveClass(/on/);
  }
});

test('面板窄的時候：DNS 記錄與靜態路由每一格自己帶標籤，位址不會被截斷', async ({ page }) => {
  await boot(page);
  await open(page, 'l132');
  await page.evaluate(() => window.linkup.select('dns'));
  await page.locator('#panel .tab', { hasText: 'DNS' }).click();
  const row = page.locator('#panel .trow.c-dns').first();
  await expect(row.locator('.tcell').first()).toHaveAttribute('data-l', '名稱');
  const narrow = await page.evaluate(() => document.querySelector('#panel .p-body').clientWidth - 28 < 390);
  if (narrow) {
    await expect(page.locator('#panel .thead.c-dns')).toBeHidden();
    const cut = await row.locator('input').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 2).map((e) => e.value));
    expect(cut).toEqual([]);
  }
  expect(await scan(page, '#panel', 'DNS 記錄')).toEqual([]);
});
