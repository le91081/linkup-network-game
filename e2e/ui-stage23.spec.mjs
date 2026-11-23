// 第 23 階段：負載平衡器、堆疊、mesh、UPS、vMotion、Junos、nmcli、配線架的操作，兩種螢幕大小都跑
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
const tab = (page, name) => page.locator('#panel .tab', { hasText: name }).first().click();
async function typeCmd(page, ...cmds) {
  const input = page.locator('#panel .term-input');
  for (const cmd of cmds) { await input.click(); await input.fill(cmd); await input.press('Enter'); }
}
// 每個目標現在通過了沒（check 型的直接呼叫 test，其他的用引擎的 runObjective）
const runAll = async (page) => page.evaluate(async () => {
  const sim = await import('/src/engine/sim.js'), app = window.linkup;
  return app.level.objectives.map((o) => (o.type === 'check' ? o.test(app.state) === true : sim.runObjective(app.state, o).pass));
});

test('負載平衡器：建立 http monitor、pool 改用它，web-03 變成 Offline', async ({ page }) => {
  await boot(page);
  await open(page, 'l152');
  await clickDevice(page, 'lb');
  await tab(page, 'Virtual Servers');
  await page.locator('#panel .field', { hasText: '來源位址轉換' }).locator('select').selectOption('automap');
  await tab(page, 'Monitors');
  await page.locator('#panel button', { hasText: '建立 Monitor' }).click();
  await tab(page, 'Pools');
  await page.locator('#panel .field', { hasText: '健康檢查' }).locator('select').selectOption('http_1');
  await expect(page.locator('#panel')).toContainText('10.0.20.13:80 — Offline');
  expect(await scan(page, '#panel', 'BIG-IP・Pools')).toEqual([]);
  expect((await runAll(page)).every(Boolean)).toBe(true);
});

test('堆疊：拔掉 Switch 1 的電源，Switch 2 接手；show switch 看得到', async ({ page }) => {
  await boot(page);
  await open(page, 'l153');
  await clickDevice(page, 'core');
  await tab(page, '堆疊');
  await page.locator('#panel label.switch', { hasText: '拔掉電源' }).first().click();
  await expect(page.locator('#panel')).toContainText('Removed');
  await tab(page, 'CLI');
  await typeCmd(page, 'enable', 'show switch');
  await expect(page.locator('#panel .term-out')).toContainText('Active');
  await expect(page.locator('#panel .term-out')).toContainText('Removed');
});

test('Wi-Fi mesh：改對金鑰、AP-辦公室改成 40 MHz，回程連上', async ({ page }) => {
  await boot(page);
  await open(page, 'l154');
  await clickDevice(page, 'ap2');
  await tab(page, '無線電');
  const key = page.locator('#panel input[placeholder="同一個 mesh 網路要一樣"]');
  await key.fill('Mesh-7Qp2Lx'); await key.press('Enter');
  await expect(page.locator('#panel')).toContainText('-78 dBm');
  await page.evaluate(() => { const app = window.linkup; app.state.devices.ap1.wifi.width5 = 40; app.changed(); app.settleNow(); });
  await clickDevice(page, 'ap2');
  await tab(page, '無線電');
  await expect(page.locator('#panel')).toContainText('上游：AP-辦公室');
  expect((await runAll(page)).every(Boolean)).toBe(true);
});

test('UPS：如果停電的預估顯示過載；模擬市電中斷', async ({ page }) => {
  await boot(page);
  await open(page, 'l157');
  await clickDevice(page, 'ups');
  await tab(page, 'UPS');
  await expect(page.locator('#panel')).toContainText('如果停電：UPS-A 過載');
  await page.locator('#panel label.switch', { hasText: '模擬市電中斷' }).click();
  await expect(page.locator('#panel')).toContainText('停止輸出');
  expect(await scan(page, '#panel', 'UPS')).toEqual([]);
});

test('vMotion：相容性檢查失敗的原因顯示出來；修好 Trunk 之後搬得過去', async ({ page }) => {
  await boot(page);
  await open(page, 'l158');
  await clickDevice(page, 'esx1');
  await tab(page, '虛擬機器');
  await page.locator('#panel button', { hasText: '遷移 (vMotion)' }).first().click();
  await expect(page.locator('#panel')).toContainText('vMotion 網路不通');
  await page.evaluate(() => { const app = window.linkup; app.state.devices.sw.sw.ports['Gi0/12'].allowed = '10,20,40'; app.changed(); app.settleNow(); });
  await clickDevice(page, 'esx1');
  await tab(page, '虛擬機器');
  await page.locator('#panel button', { hasText: '遷移 (vMotion)' }).first().click();
  await expect(page.locator('#toasts')).toContainText('已經遷移到 ESXi-02');
});

test('Junos：show | compare、commit、native-vlan-id', async ({ page }) => {
  await boot(page);
  await open(page, 'l161');
  await clickDevice(page, 'ex');
  await tab(page, 'CLI (Junos)');
  await typeCmd(page, 'configure', 'show | compare');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('+ set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members v20');
  await typeCmd(page, 'set interfaces ge-0/0/0 native-vlan-id 99', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members mgmt', 'commit');
  await expect(out).toContainText('commit complete');
  await expect(page.locator('#panel .prompt')).toHaveText(/root@BR-EX# /);
});

test('nmcli：沒寫 /長度是 /32，modify 之後要 up', async ({ page }) => {
  await boot(page);
  await open(page, 'l162');
  await clickDevice(page, 'web');
  await tab(page, '終端機');
  await typeCmd(page, 'sudo nmcli connection modify eth0 ipv4.method manual ipv4.addresses 10.0.20.15/24 ipv4.gateway 10.0.20.1');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('要 sudo nmcli connection up eth0 才會套用到網卡');
  await typeCmd(page, 'sudo nmcli connection up eth0');
  await expect(out).toContainText('Connection successfully activated');
  expect((await runAll(page)).every(Boolean)).toBe(true);
});

test('配線架：配線分頁看得到哪一孔只接了一面', async ({ page }) => {
  await boot(page);
  await open(page, 'l164');
  await clickDevice(page, 'pp');
  await expect(page.locator('#panel')).toContainText('只接一面');
  expect(await scan(page, '#panel', '配線架')).toEqual([]);
});
