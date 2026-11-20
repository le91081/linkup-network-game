// 各種模式從頭到尾用滑鼠操作一輪：故障演練、模擬考、自由模式（放設備、拖曳接線、設定 IP、存目標）→ 做成自訂關卡 → 試玩
import { test, expect, boot, closeDialog, scan, waitScene } from './helpers.mjs';

const openMenu = async (page) => {
  await page.locator('#topbar button', { hasText: '關卡' }).click();
  await expect(page.locator('#modal-root .dialog')).toBeVisible();
};
const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const label = (page, id) => page.locator(`.dev-label[data-dev="${id}"]`);

test('故障演練：選網路、限時、計時器在跑，重新整理後接著做，看答案', async ({ page }) => {
  await boot(page);
  await openMenu(page);
  await page.locator('#modal-root .mode-card', { hasText: '故障演練' }).click();
  const dlg = page.locator('#modal-root .dialog');
  await expect(dlg).toContainText('壞幾個地方');
  expect(await scan(page, '#modal-root', '演練選單')).toEqual([]);
  await dlg.locator('.seg button', { hasText: '1 個' }).click();
  await dlg.locator('.seg button', { hasText: '10 分鐘' }).click();
  await expect(dlg.locator('.seg button.on', { hasText: '10 分鐘' })).toHaveCount(1);
  await dlg.locator('.lvchip', { hasText: '跨 VLAN 路由' }).click();
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  await expect(page.locator('#topbar .crumb')).toContainText('故障演練');
  await expect(page.locator('#drill-timer')).toHaveText(/剩下 \d+:\d\d/);
  expect(await scan(page, '#mission', '演練的任務面板')).toEqual([]);
  // 改壞了：至少一個目標不會過
  await page.locator('#mission .m-foot button', { hasText: '執行' }).click();
  await expect(page.locator('#mission .obj.fail').first()).toBeVisible({ timeout: 30000 });

  // 重新整理：同一次演練（同樣的故障）還在
  const faultsBefore = await page.evaluate(() => window.linkup.level.faults.map((f) => f.text).join('|'));
  await page.reload();
  await page.waitForFunction(() => window.linkup && window.linkup.state);
  await closeDialog(page);
  await expect(page.locator('#topbar .crumb')).toContainText('故障演練');
  expect(await page.evaluate(() => window.linkup.level.faults.map((f) => f.text).join('|'))).toBe(faultsBefore);

  // 提示會指出故障在哪台設備
  await page.locator('#topbar button', { hasText: '提示' }).click();
  expect(await scan(page, '#modal-root', '演練的提示')).toEqual([]);
  await closeDialog(page);
  await page.locator('#mission button', { hasText: '看答案' }).click();
  await expect(page.locator('#modal-root .dialog')).toContainText('被改壞的地方');
  expect(await scan(page, '#modal-root', '演練的答案')).toEqual([]);
});

test('模擬考：作答每一題、交卷、看成績與各領域分析', async ({ page }) => {
  await boot(page);
  await openMenu(page);
  await page.locator('#modal-root .mode-card', { hasText: '模擬考' }).click();
  const dlg = page.locator('#modal-root .dialog');
  expect(await scan(page, '#modal-root', '模擬考選單')).toEqual([]);
  await dlg.locator('button', { hasText: '開始作答' }).click();
  await expect(dlg.locator('.exam-clock')).toHaveText(/\d+:\d\d/);
  for (let k = 0; k < 200; k++) {
    await dlg.locator('.qopt').nth(k % 4 === 3 ? 1 : 0).click();
    await expect(dlg.locator('.qopt.picked')).toHaveCount(1);
    expect(await scan(page, '#modal-root', `第 ${k + 1} 題`)).toEqual([]);
    const next = dlg.locator('.d-actions button', { hasText: '下一題' });
    if (await next.count()) { await next.click(); continue; }
    await dlg.locator('.d-actions button', { hasText: '交卷' }).click();
    break;
  }
  await expect(dlg.locator('.done-top h2')).toHaveText(/\d+ 分/);
  await expect(dlg).toContainText('答對');
  await dlg.locator('details.exam-review summary').click();
  expect(await scan(page, '#modal-root', '模擬考成績')).toEqual([]);
  // 成績留在選單的「最近的成績」
  await dlg.locator('button', { hasText: '再考一次' }).click();
  await expect(dlg).toContainText('最近的成績');
});

test('自由模式：放設備、拖曳接線、設定 IP、存目標並通過，做成自訂關卡再試玩', async ({ page }) => {
  await boot(page);
  await openMenu(page);
  await page.locator('#modal-root .sbx-card').click();
  await expect(page.locator('#topbar .crumb')).toContainText('自由模式');
  const pal = page.locator('#mission .palette');
  await pal.locator('.k-host').first().click();
  await pal.locator('.k-host').first().click();
  await pal.locator('.k-switch').first().click();
  await waitScene(page);
  const ids = await page.evaluate(() => Object.values(window.linkup.state.devices).map((d) => [d.id, d.kind]));
  expect(ids.length).toBe(3);
  const hosts = ids.filter(([, k]) => k === 'host').map(([id]) => id), sw = ids.find(([, k]) => k === 'switch')[0];

  // 從電腦拖到交換器：接上線
  for (const [n, pc] of hosts.entries()) {
    await waitScene(page);
    const [x0, y0] = await center(label(page, pc)), [x1, y1] = await center(label(page, sw));
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 8 });
    await page.mouse.move(x1, y1, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.linkup.state.cables.length)).toBe(n + 1);
  }

  // 兩台電腦設定同網段的 IP（用面板的輸入框）
  for (const [n, pc] of hosts.entries()) {
    await waitScene(page);
    const [x, y] = await center(label(page, pc));
    await page.mouse.click(x, y);
    await expect(page.locator('#panel .tab.on')).toHaveText('網路設定');
    const card = page.locator('#panel .card').first();
    const manual = card.getByRole('button', { name: '手動設定' });
    if (await manual.count()) await manual.click();
    const inputs = card.locator('input');
    await inputs.nth(0).fill(`192.168.77.${n + 10}`);
    await inputs.nth(0).press('Enter');
    await inputs.nth(1).fill('255.255.255.0');
    await inputs.nth(1).press('Enter');
    await expect.poll(() => page.evaluate((id) => window.linkup.state.devices[id].ifaces[0].rt.ip != null, pc)).toBe(true);
  }
  expect(await scan(page, '#panel', '自由模式的設備面板')).toEqual([]);

  // 存成「應該要通」的目標，再一鍵執行
  await page.locator('#mission button', { hasText: '應該要通' }).click();
  await expect(page.locator('#mission .goal')).toHaveCount(1);
  await page.locator('#mission .m-foot button', { hasText: '執行全部目標' }).click();
  await expect(page.locator('#mission .goal .obj.pass')).toHaveCount(1, { timeout: 30000 });

  // 關卡設計：取名字、存成自訂關卡
  const box = page.locator('#mission details.ed-box');
  if (!(await box.getAttribute('open'))) await box.locator('summary').click();
  const title = box.locator('input').first();
  await title.fill('E2E 小辦公室');
  await title.press('Tab');
  await expect(page.locator('#mission details.ed-box .note.warn')).toHaveCount(0);
  await page.locator('#mission details.ed-box button', { hasText: '存成自訂關卡' }).click();
  await expect(page.locator('#toasts')).toContainText('已存成自訂關卡');
  expect(await scan(page, '#mission', '自由模式的任務面板')).toEqual([]);

  // 試玩：變成關卡，目標通過就過關
  await page.locator('#mission details.ed-box button', { hasText: '試玩' }).click();
  await expect(page.locator('#topbar .crumb')).toContainText('自訂關卡');
  await expect(page.locator('#mission h1')).toHaveText('E2E 小辦公室');
  await page.locator('#mission .m-foot button', { hasText: '執行' }).click();
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 30000 });
  expect(await scan(page, '#modal-root', '自訂關卡過關')).toEqual([]);
  await page.locator('#modal-root button', { hasText: '回到自由模式' }).click();
  await expect(page.locator('#topbar .crumb')).toContainText('自由模式');

  // 關卡選單出現「自訂關卡」
  await openMenu(page);
  await page.locator('#modal-root .mode-card', { hasText: '自訂關卡' }).click();
  await expect(page.locator('#modal-root .dialog')).toContainText('E2E 小辦公室');
  expect(await scan(page, '#modal-root', '自訂關卡清單')).toEqual([]);
});
