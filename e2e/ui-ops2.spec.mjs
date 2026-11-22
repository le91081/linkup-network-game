// 第 19 階段的維運補充：PoE 預算（12-3）、NTP 與 service timestamps（11-8），兩種螢幕大小都跑
import { test, expect, boot, scan, waitScene } from './helpers.mjs';

async function open(page, id) {
  await page.evaluate((id) => { const app = window.linkup; app.openLevel(app.levels.find((l) => l.id === id), { fresh: true }); app.settleNow(); }, id);
  await waitScene(page);
}
async function clickDevice(page, id) {
  await waitScene(page);
  const lab = page.locator(`.dev-label[data-dev="${id}"]`);
  await expect(lab).toBeVisible();
  const b = await lab.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator('#panel .p-title h2')).toHaveText(await page.evaluate((i) => window.linkup.state.devices[i].name, id));
}
async function typeCmd(page, ...cmds) {
  const input = page.locator('#panel .term-input');
  for (const cmd of cmds) { await input.click(); await input.fill(cmd); await input.press('Enter'); }
}

test('PoE 預算：no cdp run 讓 AP 依 Class 4 保留 30 W，cdp run 之後新的 AP 分得到電', async ({ page }) => {
  await boot(page);
  await open(page, 'l98');
  await clickDevice(page, 'sw');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'enable', 'show power inline');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('Used:120.0(w)');
  await expect(out).toContainText('PoE 預算 124 W 已經用完');
  await typeCmd(page, 'configure terminal', 'cdp run', 'interface range gi0/6 - 8', 'no cdp enable', 'end');
  await page.evaluate(() => window.linkup.tick(300));
  await typeCmd(page, 'show power inline');
  await expect(out).toContainText('Used:104.5(w)');
  await typeCmd(page, 'show cdp neighbors');
  await expect(out).toContainText('C9120AXI');
  expect(await scan(page, '#panel', 'CLI（PoE）')).toEqual([]);
});

test('NTP 與 service timestamps：Syslog 伺服器分頁看得到設備寫的時間與收到的時間', async ({ page }) => {
  await boot(page);
  await open(page, 'l99');
  await clickDevice(page, 'br');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'enable', 'configure terminal', 'service timestamps log datetime msec localtime show-timezone', 'interface Gi0/0/1', 'shutdown', 'no shutdown', 'end');
  await page.evaluate(() => window.linkup.tick(3));
  await typeCmd(page, 'show running-config | include timestamps');
  await expect(page.locator('#panel .term-out')).toContainText('service timestamps log datetime msec localtime show-timezone');
  await clickDevice(page, 'log');
  await page.locator('#panel .tab', { hasText: 'Syslog' }).click();
  await expect(page.locator('#panel .logbox')).toContainText(/TST: %LINK-3-UPDOWN/);
  expect(await scan(page, '#panel', 'Syslog 分頁')).toEqual([]);
});
