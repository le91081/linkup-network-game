// 學習輔助：新手導覽、參考解法與示範、錯題本（都用真的點擊與打字操作）
import { test, expect, boot, closeDialog, scan, waitScene } from './helpers.mjs';
import { QUESTIONS } from '../src/data/quiz.js';

const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
async function drag(page, from, to) {
  await waitScene(page);
  const [x0, y0] = await center(page.locator(`.dev-label[data-dev="${from}"]`)), [x1, y1] = await center(page.locator(`.dev-label[data-dev="${to}"]`));
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 8 }); await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up();
}
async function setIp(page, ip) {
  const card = page.locator('#panel .card').first();
  const manual = card.getByRole('button', { name: '手動設定' });
  if (await manual.count()) await manual.click();
  const inputs = card.locator('input');
  await inputs.nth(0).fill(ip); await inputs.nth(0).press('Enter');
  await inputs.nth(1).fill('255.255.255.0'); await inputs.nth(1).press('Enter');
}

test('新手導覽：第一次進 1-1，一步一步跟著做到過關', async ({ page }, info) => {
  await boot(page, { keepDialog: true });
  await page.locator('#modal-root button.lv', { hasText: '第一條網路線' }).click();
  const coach = page.locator('#coach');
  await expect(coach).toContainText('導覽 1 / 6');
  await expect(page.locator('.dev-label[data-dev="pc-a"]')).toHaveClass(/coach-hl/);
  expect(await scan(page, '#coach', '導覽')).toEqual([]);
  await waitScene(page);
  await page.screenshot({ path: info.outputPath('coach.png') });
  await drag(page, 'pc-a', 'hub');
  await expect(coach).toContainText('導覽 2 / 6');
  await drag(page, 'pc-b', 'hub');
  await expect(coach).toContainText('導覽 3 / 6');
  await waitScene(page);
  await page.mouse.click(...(await center(page.locator('.dev-label[data-dev="pc-a"]'))));
  await expect(coach).toContainText('導覽 4 / 6');
  await setIp(page, '192.168.1.10');
  await expect(coach).toContainText('導覽 5 / 6');
  await page.keyboard.press('Escape');
  await page.mouse.click(...(await center(page.locator('.dev-label[data-dev="pc-b"]'))));
  await setIp(page, '192.168.1.20');
  await expect(coach).toContainText('導覽 6 / 6');
  await expect(page.locator('#mission .m-foot .btn')).toHaveClass(/coach-hl/);
  await page.locator('#mission .m-foot .btn').click();
  await page.keyboard.press('Space');
  await expect(coach).toHaveCount(0, { timeout: 30000 });
  await expect(page.locator('#toasts')).toContainText('導覽完成');
  expect(await page.evaluate(() => window.linkup.store.tutorial)).toBe('done');
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 15000 });
});

test('參考解法：提示看完之後可以看改了哪些地方，示範一次不計星', async ({ page }, info) => {
  await boot(page);
  await page.evaluate(() => { const app = window.linkup; app.openLevel(app.levels.find((l) => l.id === 'l06'), { fresh: true }); });
  await page.locator('#topbar button', { hasText: '提示' }).click();
  const dlg = page.locator('#modal-root .dialog');
  for (let k = 0; k < 5 && await dlg.locator('button', { hasText: /提示/ }).count(); k++) await dlg.locator('button', { hasText: /提示/ }).click();
  await dlg.locator('button', { hasText: '看參考解法' }).click();
  await expect(dlg).toContainText('參考解法');
  await expect(dlg.locator('.sol-list .add').first()).toBeVisible();
  await expect(dlg).toContainText('+switchport access vlan 10');
  expect(await scan(page, '#modal-root', '參考解法')).toEqual([]);
  await page.screenshot({ path: info.outputPath('solution.png') });
  await dlg.locator('button', { hasText: '示範一次' }).click();
  // 示範會自己跑一次測試：按空白鍵快轉
  await page.waitForFunction(() => window.linkup.running);
  await page.keyboard.press('Space');
  await expect(page.locator('#modal-root .dialog')).toContainText('示範完成', { timeout: 30000 });
  expect(await page.evaluate(() => window.linkup.store.done.l06 || null)).toBe(null);
  expect(await scan(page, '#modal-root', '示範完成')).toEqual([]);
});

test('錯題本：答錯的題目放進來、頂端列顯示到期題數、複習答對之後排到一天後', async ({ page }) => {
  await boot(page);
  const quiz = page.locator('#topbar .quiz-btn');
  await quiz.click();
  const dlg = page.locator('#modal-root .dialog');
  await expect(dlg.locator('.review-card')).toContainText('還沒有錯題');
  await dlg.locator('button.lv', { hasText: 'IP 與交換基礎' }).click();
  // 找出這一題的正確答案，故意選錯
  const qText = await dlg.locator('.qq').innerText();
  const item = QUESTIONS.basics.find((x) => x.q === qText);
  await dlg.locator('.qopt').nth((item.c + 1) % 4).click();
  await expect(dlg.locator('.qsched')).toContainText('已放進錯題本');
  await closeDialog(page);
  await expect(quiz.locator('.rv-dot')).toHaveText('1');
  // 複習：這次答對
  await quiz.click();
  await expect(dlg.locator('.review-card')).toContainText('1 題到期');
  await dlg.locator('.review-card').click();
  await expect(dlg.locator('.qq')).toHaveText(qText);
  await dlg.locator('.qopt').nth(item.c).click();
  await expect(dlg.locator('.qsched')).toContainText('1 天後再複習');
  expect(await scan(page, '#modal-root', '錯題本')).toEqual([]);
  await closeDialog(page);
  await expect(quiz.locator('.rv-dot')).toHaveCount(0);
});
