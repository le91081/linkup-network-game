// 6-21：SYN flood 與 FortiGate 的 DoS 政策。用圖形介面解一次、用 CLI 解一次；場景上看得到攻擊流量
import { test, expect, boot, scan, waitScene } from './helpers.mjs';

const open = async (page, id) => {
  await page.evaluate((x) => { const a = window.linkup; a.toggle2d(false); a.loadLevel(a.levels.findIndex((l) => l.id === x), { fresh: true }); }, id);
  await waitScene(page);
};
async function pick(page, id) {
  const lab = page.locator(`.dev-label[data-dev="${id}"]`);
  await expect(lab).toBeVisible();
  const b = await lab.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator('#panel .p-title h2')).toHaveText(await page.evaluate((i) => window.linkup.state.devices[i].name, id));
}
const tab = (page, name) => page.locator('#panel .tab', { hasText: name }).click();
async function outOf(page, ...cmds) {
  const out = page.locator('#panel .term-out'), input = page.locator('#panel .term-input');
  const before = (await out.innerText()).length;
  for (const c of cmds) { await input.click(); await input.fill(c); await input.press('Enter'); }
  return (await out.innerText()).slice(before);
}
const runAll = async (page) => { await page.locator('#mission .m-foot .btn').click(); };

test('DoS 政策（圖形介面）：掛錯介面量不到、pass 只記錄、block 才擋下來', async ({ page }) => {
  await boot(page);
  await open(page, 'l179');
  // 場景：被打的伺服器在標籤上註明、網際網路旁邊有一張說明攻擊的便利貼
  await expect(page.locator('.dev-label[data-dev="web"] .sub')).toContainText('被 SYN flood 塞滿');
  await expect(page.locator('.note-label')).toContainText('SYN flood');
  expect(await page.evaluate(() => [...window.linkup.scene.cables.values()].filter((c) => c.flood).length)).toBe(2);
  // 先測一次：內外都連不上，原因是 SYN flood
  await runAll(page);
  await expect(page.locator('#mission .obj.fail')).toHaveCount(3, { timeout: 40000 });
  await expect(page.locator('#mission .obj.fail .why').first()).toContainText('SYN flood');
  expect(await scan(page, '#mission', 'DoS 關卡的任務面板')).toEqual([]);

  await pick(page, 'fw');
  await tab(page, '安全設定檔');
  const card = page.locator('#panel .dos-pol');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.note')).toContainText('掛在 dmz，量不到東西');
  await expect(page.locator('#panel .p-body')).toContainText('連線表：約 120,000 筆半開的 TCP 連線');
  expect(await scan(page, '#panel', 'DoS 政策')).toEqual([]);
  // 介面改成 wan1：偵測到了，但只記錄
  await card.locator('select').first().selectOption('wan1');
  await expect(card.locator('.note')).toContainText('動作是 pass，只記錄');
  await expect(card.locator('.note')).toContainText('每秒 12,000 個封包（門檻 2,000）');
  expect(await page.evaluate(() => window.linkup.state.rt.dos.list[0].victim)).toBe('web');
  // 門檻調太高：不會觸發
  const th = card.locator('.dos-row').first().locator('input.inp');
  await th.fill('20000'); await th.press('Enter');
  await expect(card.locator('.note')).toContainText('還沒超過門檻 20,000');
  await th.fill('2000'); await th.press('Enter');
  // 動作改成 block：擋下來了
  await card.locator('.dos-row').first().locator('select').selectOption('block');
  await expect(card.locator('.note.ok')).toContainText('封鎖中');
  await expect(page.locator('#panel .p-body')).not.toContainText('筆半開的 TCP 連線');
  expect(await page.evaluate(() => [...window.linkup.scene.cables.values()].filter((c) => c.flood).length)).toBe(1);
  await expect(page.locator('.dev-label[data-dev="web"] .sub')).not.toContainText('SYN flood');
  expect(await scan(page, '#panel', 'DoS 政策（封鎖中）')).toEqual([]);
  // 紀錄分頁：先 detected，後 clear_session
  await tab(page, '紀錄');
  await expect(page.locator('#panel .p-body')).toContainText('attack="tcp_syn_flood" action="clear_session"');
  // 2D 拓撲圖：只剩 wan1 那一段是攻擊流量
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await expect(page.locator('#topo2d line.t2-link.flood')).toHaveCount(1);
  await expect(page.locator('#topo2d .t2-legend')).toContainText('攻擊流量');
  await page.keyboard.press('t');
  await runAll(page);
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 40000 });
});

test('DoS 政策（CLI）：diagnose ips anomaly list、config firewall DoS-policy，還有新增與刪除', async ({ page }) => {
  await boot(page);
  await open(page, 'l179');
  await pick(page, 'fw');
  await tab(page, 'CLI');
  let o = await outOf(page, 'diagnose ips anomaly list');
  expect(o).toMatch(/id=tcp_syn_flood\s+ip=0\.0\.0\.0 dos_id=1 exp=0 pps=0 freq=0 threshold=2000 action=pass/);
  o = await outOf(page, 'show firewall DoS-policy');
  expect(o).toContain('set interface "dmz"');
  expect(o).toContain('edit "tcp_syn_flood"');
  o = await outOf(page, 'config firewall DoS-policy', 'edit 1', 'set interface "wan1"', 'config anomaly', 'edit "tcp_syn_flood"', 'set action block', 'next', 'end', 'next', 'end', 'diagnose ips anomaly list');
  expect(o).toMatch(/ip=203\.0\.113\.18 dos_id=1 exp=1 pps=12000 freq=12000 threshold=2000 action=block/);
  // 圖形介面看到的是同一份設定；再用按鈕新增一條、刪掉
  await tab(page, '安全設定檔');
  const cards = page.locator('#panel .dos-pol');
  await expect(cards.first().locator('.note.ok')).toContainText('封鎖中');
  await page.locator('#panel .card', { hasText: '新增 DoS 政策' }).locator('select').selectOption('internal');
  await page.locator('#panel .card', { hasText: '新增 DoS 政策' }).locator('button', { hasText: '新增' }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1).locator('.note')).toContainText('沒有量到異常的流量');
  expect(await scan(page, '#panel', '兩條 DoS 政策')).toEqual([]);
  await cards.nth(1).locator('.mini.danger').click();
  await expect(cards).toHaveCount(1);
  await page.keyboard.press('Escape');
  await runAll(page);
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 40000 });
});
