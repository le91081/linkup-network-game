// 知識庫（寬的閱讀視窗、釘在左側）、文字裡的名詞連結，以及面板窄的時候表格列的排法；兩種螢幕大小都跑
import { test, expect, boot, scan, waitScene } from './helpers.mjs';

async function open(page, id) {
  await page.evaluate((id) => { const app = window.linkup; app.openLevel(app.levels.find((l) => l.id === id), { fresh: true }); app.settleNow(); }, id);
  await waitScene(page);
}
const kbTab = (page) => page.locator('#mission .m-tabs .tab', { hasText: '知識庫' });

test('知識庫的閱讀視窗：首頁、文章、相關的觀念與上一則、上下篇、搜尋、K 鍵', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  await kbTab(page).click();
  const dlg = page.locator('#modal-root .dialog.kbr');
  await expect(dlg).toBeVisible();
  // 沒有釘住：左側面板還是「任務」，知識庫是另外開的視窗
  await expect(kbTab(page)).not.toHaveClass(/\bon\b/);
  await expect(page.locator('#mission .obj').first()).toBeVisible();
  // 首頁：這一關會用到的觀念排最前面，下面是 12 個分類；左邊的清單也有
  await expect(dlg.locator('.kbr-sec').first().locator('.kbr-h2')).toContainText('這一關會用到');
  await expect(dlg.locator('.kbr-sec')).toHaveCount(13);
  await expect(dlg.locator('.kbr-nav .kbr-grp .kbr-item')).toHaveCount(await dlg.locator('.kbr-sec').first().locator('.kbr-card').count());
  await expect(dlg.locator('.kbr-nav .kbr-cat')).toHaveCount(12);
  expect(await scan(page, '#modal-root', '知識庫首頁')).toEqual([]);
  // 整個視窗不捲動：左邊的清單與右邊的內容各自捲
  expect(await dlg.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  // 文章：標題、表格、指令；本文的欄寬夠看（原本擠在不到 300 像素的側邊欄）
  await dlg.locator('.kbr-card', { hasText: '子介面' }).first().click();
  await expect(dlg.locator('.kbr-art .kb-title h1')).toHaveText('子介面');
  await expect(dlg.locator('.kb-table')).toBeVisible();
  await expect(dlg.locator('.kb-cmd pre').first()).toContainText('encapsulation dot1Q 10');
  expect(await dlg.locator('.kbr-text').evaluate((el) => el.clientWidth)).toBeGreaterThan(560);
  expect(await dlg.locator('.kbr-text .kb-p').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
  // 左邊：所在的分類自動展開、標出目前這一則；這一關的關卡按鈕標成「就是這一關」
  await expect(dlg.locator('.kbr-cat.open .kbr-item.on')).toHaveText('子介面');
  await expect(dlg.locator('.kbr-rail .lvchip.done')).toHaveText('2-4');
  expect(await scan(page, '#modal-root', '知識庫文章')).toEqual([]);
  // 相關的觀念 → 另一則；「上一則」回來
  await dlg.locator('.kbr-rel', { hasText: 'Trunk' }).click();
  await expect(dlg.locator('.kbr-art .kb-title h1')).toHaveText('Trunk');
  await expect(dlg.locator('.kb-field.hl').first()).toBeVisible();
  await expect(dlg.locator('.kbr-crumb .kb-back')).toContainText('上一則：子介面');
  await dlg.locator('.kbr-crumb .kb-back').click();
  await expect(dlg.locator('.kbr-art .kb-title h1')).toHaveText('子介面');
  // 文章裡有點狀底線的名詞：直接換文章，視窗不會關掉重開
  await dlg.locator('.kbr-text .kterm').first().click();
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.kbr-art .kb-title h1')).not.toHaveText('子介面');
  // 同一個分類的上一篇 / 下一篇
  const before = await dlg.locator('.kbr-art .kb-title h1').innerText();
  const nextName = await dlg.locator('.kbr-pnb.next b').innerText();
  await dlg.locator('.kbr-pnb.next').click();
  await expect(dlg.locator('.kbr-art .kb-title h1')).toHaveText(nextName);
  expect(nextName).not.toBe(before);
  // 搜尋：英文的說法也找得到；Esc 先清掉搜尋字，不會把視窗關掉
  await dlg.locator('.kb-q').fill('dijkstra');
  await expect(dlg.locator('.kbr-card').first()).toContainText('OSPF');
  await dlg.locator('.kb-q').press('Escape');
  await expect(dlg.locator('.kb-q')).toHaveValue('');
  await expect(dlg).toBeVisible();
  await dlg.locator('.kb-q').fill('dijkstra');
  await dlg.locator('.kbr-card').first().click();
  await expect(dlg.locator('.kb-steps li')).toHaveCount(4);
  await expect(dlg.locator('.kb-q')).toHaveValue('');
  // 左上角回首頁；K 關掉、再按一次打開（還在剛才那一頁）
  await dlg.locator('.kbr-brand').click();
  await expect(dlg.locator('.kbr-hero')).toBeVisible();
  await dlg.locator('.kbr-nav .kbr-item').first().click();
  const last = await dlg.locator('.kbr-art .kb-title h1').innerText();
  await dlg.locator('.kbr-art').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('k');
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  await page.keyboard.press('k');
  await expect(page.locator('#modal-root .dialog.kbr .kbr-art .kb-title h1')).toHaveText(last);
  // 從文章前往別的關卡：視窗關掉、換到那一關
  await page.locator('#modal-root .kbr-nav .kbr-item', { hasText: 'DHCP' }).first().click();
  const chip = page.locator('#modal-root .kbr-rail .lvchip:not(.done)').first();
  const no = await chip.innerText();
  await chip.click();
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  await expect(page.locator('#topbar .crumb b')).toContainText(no);
});

test('名詞連結：滑鼠移上去看摘要、點一下在閱讀視窗打開文章；提示裡的名詞也可以點', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  const term = page.locator('#mission .brief .kterm').first();
  await term.hover();
  await expect(page.locator('.ktip')).toBeVisible();
  const name = await term.textContent();
  await expect(page.locator('.ktip b')).toHaveText(name);
  await term.click();
  const dlg = page.locator('#modal-root .dialog.kbr');
  await expect(dlg.locator('.kbr-art .kb-title h1')).toBeVisible();
  await expect(page.locator('.ktip')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  await expect(page.locator('#mission .m-tabs .tab', { hasText: '任務' })).toHaveClass(/\bon\b/);
  // 右側學習筆記的「想知道更多」
  await page.locator('#panel .kb-more .kb-see').first().click();
  await expect(dlg.locator('.kbr-art')).toBeVisible();
  await page.keyboard.press('Escape');
  // 提示視窗裡的名詞：提示視窗關掉，換成知識庫的視窗（只有一個視窗）
  await page.locator('#topbar button', { hasText: '提示' }).click();
  const hint = page.locator('#modal-root .dialog');
  await hint.getByRole('button', { name: '顯示第一個提示' }).click();
  const ht = hint.locator('.hint-item .kterm').first();
  if (await ht.count()) {
    await ht.click();
    await expect(page.locator('#modal-root .backdrop')).toHaveCount(1);
    await expect(dlg.locator('.kbr-art')).toBeVisible();
  }
});

test('知識庫釘在左側：邊看邊做，名詞連結也開在左側；可以再放大回閱讀視窗', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  await page.keyboard.press('k');
  const dlg = page.locator('#modal-root .dialog.kbr');
  await dlg.locator('.kbr-card', { hasText: '子介面' }).first().click();
  await dlg.locator('.kbr-head .btn', { hasText: '釘在左側' }).click();
  // 視窗關掉，文章出現在左側面板；場景與設定面板都還能用，執行測試的按鈕也在
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  const m = page.locator('#mission');
  await expect(kbTab(page)).toHaveClass(/\bon\b/);
  await expect(m.locator('.kb-dock')).toContainText('釘在左側');
  await expect(m.locator('.kb-title h2')).toHaveText('子介面');
  await expect(m.locator('.m-foot .btn.primary')).toBeVisible();
  expect(await scan(page, '#mission', '釘在左側的知識庫')).toEqual([]);
  // 相關的觀念、上一則都在左側面板裡換，不會跳出視窗
  await m.locator('.kb-see', { hasText: 'Trunk' }).click();
  await expect(m.locator('.kb-title h2')).toHaveText('Trunk');
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  await m.locator('.kb-back').click();
  await expect(m.locator('.kb-title h2')).toHaveText('子介面');
  await m.locator('.kb-back').click();
  await expect(m.locator('h3.sec').first()).toHaveText('這一關會用到');
  await m.locator('.kb-q').fill('dijkstra');
  await expect(m.locator('.kb-row').first()).toContainText('OSPF');
  // K 切回任務；任務說明裡的名詞一樣開在左側
  await page.locator('#stage').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('k');
  await expect(page.locator('#mission .m-tabs .tab', { hasText: '任務' })).toHaveClass(/\bon\b/);
  await page.locator('#mission .brief .kterm').first().click();
  await expect(kbTab(page)).toHaveClass(/\bon\b/);
  await expect(m.locator('.kb-title h2')).toBeVisible();
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  // 重新整理之後還是釘著的
  await page.reload();
  await page.waitForFunction(() => window.linkup && window.linkup.state);
  if (await page.locator('#modal-root .backdrop').count()) await page.keyboard.press('Escape');
  await kbTab(page).click();
  await expect(page.locator('#mission .kb-dock')).toBeVisible();
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  // 放大閱讀：回到寬的視窗，左側回到任務
  await page.locator('#mission .kb-dock .btn', { hasText: '放大閱讀' }).click();
  await expect(page.locator('#modal-root .dialog.kbr')).toBeVisible();
  await expect(page.locator('#mission .m-tabs .tab', { hasText: '任務' })).toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => window.linkup.store.kbDock)).toBe(false);
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
