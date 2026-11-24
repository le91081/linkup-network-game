// 載入畫面與「視窗太窄」的提示：樣式寫在 index.html 裡，程式還沒載入之前就要排好，不能先閃出還沒排版的文字
import { test, expect } from './helpers.mjs';

// 程式的進入點：開發伺服器是 /src/main.js，打包之後是 assets/index-*.js
const ENTRY = /\/src\/main\.js|\/assets\/index-[^/]+\.js/;
const ready = (page) => page.waitForFunction(() => window.linkup && window.linkup.state && document.querySelector('#topbar .crumb'));
const shown = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; }, sel);

test('載入時不會先閃出「視窗太窄」的提示：程式載入之前是載入畫面，啟動完成就拿掉', async ({ page }) => {
  // 把進入點拖慢，才看得到它載入之前的畫面
  await page.route(ENTRY, async (r) => { await new Promise((ok) => setTimeout(ok, 1200)); await r.continue(); });
  await page.goto('/?profile=e2e', { waitUntil: 'commit' });
  await page.waitForSelector('#boot', { state: 'attached' });
  // 程式還沒執行：看到的是載入畫面，背景已經是深色，「視窗太窄」的提示沒有露出來
  expect(await page.evaluate(() => !!window.linkup)).toBe(false);
  expect(await shown(page, '#narrow')).toBe(false);
  expect(await shown(page, '#boot')).toBe(true);
  await expect(page.locator('#boot .bt-name')).toHaveText('LinkUp');
  await expect(page.locator('#boot-msg')).toHaveText('載入中…');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(9, 13, 26)');
  // 載入畫面不擋滑鼠，也蓋在提示視窗的下面
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('boot')).pointerEvents)).toBe('none');
  await ready(page);
  await expect(page.locator('#boot')).toHaveCount(0);
  expect(await shown(page, '#narrow')).toBe(false);
  await expect(page.locator('#topbar .brand')).toBeVisible();
});

test('程式沒有載入成功：載入畫面換成說明，不會一直停在「載入中」', async ({ page }) => {
  await page.route(ENTRY, (r) => r.abort());
  await page.goto('/?profile=e2e', { waitUntil: 'commit' });
  await expect(page.locator('#boot')).toHaveClass('fail');
  await expect(page.locator('#boot-msg')).toContainText('程式沒有載入成功');
  await expect(page.locator('#boot .bt-bar')).toBeHidden();
  // 這個測試是故意讓進入點載入失敗的：主控台只會有那一筆「資源載入失敗」，不算頁面上的錯誤
  expect(page.errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e))).toEqual([]);
  page.errors.length = 0;
});

test('視窗太窄的提示：目前的寬度跟著視窗變、拉到 900 像素就進得去，內容不會超出畫面', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/?profile=e2e');
  await ready(page);
  const n = page.locator('#narrow');
  await expect(n).toBeVisible();
  await expect(n.locator('h1')).toHaveText('畫面再寬一點，就可以開始了');
  await expect(n.locator('#narrow-now')).toHaveText('760');
  await expect(n.locator('.nw-art')).toBeVisible();
  // 用滑鼠的電腦：建議拉寬視窗
  await expect(n.locator('.nw-tips li:visible')).toHaveText(['把瀏覽器的視窗拉寬，或直接放到最大']);
  const fits = () => page.evaluate(() => {
    const el = document.getElementById('narrow'), c = el.querySelector('.nw').getBoundingClientRect();
    const clipped = [...el.querySelectorAll('h1, p, li span, .nw-nums span')].filter((x) => x.offsetParent && x.scrollWidth > x.clientWidth + 1).length;
    return el.scrollWidth <= el.clientWidth && c.left >= 0 && c.right <= innerWidth && clipped === 0;
  });
  expect(await fits()).toBe(true);
  // 進度條：目前的寬度 ÷ 900
  expect(await page.evaluate(() => parseFloat(document.getElementById('narrow-bar').style.width))).toBeCloseTo((760 / 900) * 100, 0);
  // 小的視窗、矮的視窗也排得下（矮的時候拿掉插圖，還是可以捲）
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(n.locator('#narrow-now')).toHaveText('320');
  expect(await fits()).toBe(true);
  await page.setViewportSize({ width: 780, height: 390 });
  await expect(n.locator('.nw-art')).toBeHidden();
  expect(await fits()).toBe(true);
  // 899 還是太窄，900 就進得去
  await page.setViewportSize({ width: 899, height: 800 });
  await expect(n).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(n).toBeHidden();
  await expect(page.locator('#topbar .brand')).toBeVisible();
});

test('視窗太窄的提示依裝置給建議：直放的平板轉成橫向，手機改用大一點的螢幕', async ({ browser, baseURL }) => {
  const tip = async (viewport) => {
    const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, baseURL });
    const page = await ctx.newPage();
    await page.goto('/?profile=e2e');
    await ready(page);
    const t = await page.locator('#narrow .nw-tips li:visible').allInnerTexts();
    await ctx.close();
    return t.map((x) => x.trim());
  };
  expect(await tip({ width: 820, height: 1180 })).toEqual(['把平板轉成橫向，寬度就夠了']);
  expect(await tip({ width: 390, height: 780 })).toEqual(['這個螢幕不夠寬，請改用電腦，或橫放的平板']);
});
