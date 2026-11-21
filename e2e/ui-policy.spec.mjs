// 路由重分配與政策路由：CLI 的 show 指令、路由分頁的重分配卡片與 PBR 卡片，兩種螢幕大小都跑
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
async function outOf(page, ...cmds) {
  const out = page.locator('#panel .term-out'), input = page.locator('#panel .term-input');
  const before = (await out.innerText()).length;
  for (const c of cmds) { await input.click(); await input.fill(c); await input.press('Enter'); }
  return (await out.innerText()).slice(before);
}
const tab = (page, name) => page.locator('#panel .tab', { hasText: name }).click();
async function runAll(page) {
  await page.locator('#mission .m-foot .btn').click();
  await page.waitForFunction(() => window.linkup.running);
  await page.keyboard.press('Space');
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 30000 });
}

test('路由重分配：CLI 寫 prefix-list 與 route-map，在路由分頁打開「靜態路由」並選 route-map', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l77');
  await clickDevice(page, 'edge');
  await tab(page, 'CLI');
  await outOf(page, 'enable', 'configure terminal', 'ip prefix-list FACTORY seq 5 permit 10.50.0.0/16', 'route-map STATIC-TO-OSPF permit 10', 'match ip address prefix-list FACTORY', 'end');
  await tab(page, '路由');
  const card = page.locator('#panel .card', { hasText: '路由重分配' });
  await card.scrollIntoViewIfNeeded();
  await card.locator('label.switch', { hasText: '靜態路由' }).first().click();
  const row = page.locator('#panel .card', { hasText: '路由重分配' }).locator('.redist-row').first();
  await row.locator('select').nth(1).selectOption('STATIC-TO-OSPF');
  expect(await scan(page, '#panel', 'R-Edge・路由重分配')).toEqual([]);
  await page.locator('#panel .card', { hasText: '路由重分配' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('redist-card.png') });
  await tab(page, 'CLI');
  let o = await outOf(page, 'show running-config | include redistribute');
  expect(o).toContain('redistribute static subnets route-map STATIC-TO-OSPF');
  o = await outOf(page, 'show ip ospf');
  expect(o).toContain('It is an autonomous system boundary router');
  await clickDevice(page, 'core');
  await tab(page, 'CLI');
  o = await outOf(page, 'show ip route ospf');
  expect(o).toMatch(/O E2\s+10\.50\.0\.0 \[110\/20\]/);
  expect(o).not.toContain('192.168.99.0');
  expect(await scan(page, '#panel', 'Core・CLI')).toEqual([]);
  await runAll(page);
});

test('政策路由：在路由分頁新增一條政策，NAS 的備份改走寬頻；show route-map 看得到比對次數', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l78');
  await clickDevice(page, 'br');
  await tab(page, '路由');
  const card = page.locator('#panel .card', { hasText: '政策路由 (PBR)' });
  await card.scrollIntoViewIfNeeded();
  await card.locator('.field', { hasText: '流量從哪個介面進來' }).locator('select').selectOption('Gi0/0/2');
  const fill = async (label, v) => { const x = page.locator('#panel .card', { hasText: '政策路由 (PBR)' }).locator('.field').filter({ has: page.locator('.f-label', { hasText: new RegExp('^' + label) }) }).first().locator('input'); await x.fill(v); await x.press('Enter'); };
  await fill('來源', '10.2.0.20');
  await fill('目的$', '10.1.0.20');
  await fill('交給下一站', '10.255.2.1');
  await page.locator('#panel button', { hasText: '新增政策' }).click();
  await expect(page.locator('#panel .sub.pbr')).toContainText('ip policy route-map PBR-Gi002');
  await expect(page.locator('#panel .sub.pbr .pbr-rule')).toContainText('10.2.0.20 → 10.1.0.20 → 交給 10.255.2.1');
  expect(await scan(page, '#panel', 'Branch-RT・政策路由')).toEqual([]);
  await page.locator('#panel .card', { hasText: '政策路由 (PBR)' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('pbr-card.png') });
  // NAS 的 tracert 改走寬頻
  await clickDevice(page, 'nas');
  await tab(page, '終端機');
  let o = await outOf(page, 'tracert 10.1.0.20');
  expect(o).toContain('10.255.2.1');
  await clickDevice(page, 'br');
  await tab(page, 'CLI');
  o = await outOf(page, 'show route-map');
  expect(o).toMatch(/Policy routing matches: [1-9]\d* packets/);
  o = await outOf(page, 'show ip policy');
  expect(o).toMatch(/Gi0\/0\/2\s+PBR-Gi002/);
  await runAll(page);
});
