// MTU：Jumbo Frame 與 PMTUD 黑洞（終端機的 ping -f -l、CLI、MTU 的設定卡片），兩種螢幕大小都跑
import { test, expect, boot, scan, waitScene } from './helpers.mjs';

async function open(page, id) {
  // 開好之後等網路收斂（VPN 協商、STP）再開始操作
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
async function outOf(page, ...cmds) {
  const out = page.locator('#panel .term-out');
  const before = (await out.innerText()).length;
  await typeCmd(page, ...cmds);
  return (await out.innerText()).slice(before);
}
const tab = (page, name) => page.locator('#panel .tab', { hasText: name }).click();
async function runAll(page) {
  await page.locator('#mission .m-foot .btn').click();
  await page.waitForFunction(() => window.linkup.running);
  await page.keyboard.press('Space');
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 30000 });
}

test('Jumbo Frame：ping -M do -s 找出 MTU、giants、2960 要存檔重新開機才生效', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l75');
  await clickDevice(page, 'bk');
  // BK-01 有兩張網卡：接線的是第一張
  await expect(page.locator('#panel .field').filter({ has: page.locator('.f-label', { hasText: /^MTU$/ }) }).first().locator('select')).toHaveValue('9000');
  await tab(page, '終端機');
  let o = await outOf(page, 'ping -M do -s 1472 10.0.50.20');
  expect(o).toContain('1480 bytes from 10.0.50.20: icmp_seq=1 ttl=64');
  o = await outOf(page, 'ping -M do -s 8972 10.0.50.20');
  expect(o).toContain('4 packets transmitted, 0 received, 100% packet loss');
  expect(o).toContain('giant');
  o = await outOf(page, 'ping -M do -s 9000 10.0.50.20');
  expect(o).toContain('ping: local error: message too long, mtu=9000');
  o = await outOf(page, 'ip link');
  expect(o).toMatch(/eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 /);
  // Windows 的指令：照 bash 的說法找不到，並提示 Linux 上對應的指令
  o = await outOf(page, 'netsh interface ipv4 show subinterfaces');
  expect(o).toContain('netsh: command not found');
  expect(o).toContain('ip link');
  expect(await scan(page, '#panel', 'BK-01・終端機')).toEqual([]);
  // 交換器：giants、show system mtu，在 MTU 卡片改成 9000
  await clickDevice(page, 'sw');
  await tab(page, 'CLI');
  o = await outOf(page, 'show interfaces gi0/2');
  expect(o).toMatch(/[1-9]\d* giants/);
  await tab(page, '連接埠');
  const card = page.locator('#panel .card', { hasText: 'MTU（Jumbo Frame）' });
  await card.scrollIntoViewIfNeeded();
  await card.locator('select').selectOption('9000');
  await expect(page.locator('#panel .card', { hasText: 'MTU（Jumbo Frame）' })).toContainText('下次開機才會變成 9000');
  expect(await scan(page, '#panel', 'SW-Storage・連接埠')).toEqual([]);
  await page.locator('#panel .card', { hasText: 'MTU（Jumbo Frame）' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('switch-mtu.png') });
  await tab(page, 'CLI');
  o = await outOf(page, 'show system mtu');
  expect(o).toContain('On next reload, System Jumbo MTU size will be 9000 bytes');
  o = await outOf(page, 'write memory', 'reload', '');
  expect(o).toContain('設備重新開機中');
  await page.evaluate(() => window.linkup.settleNow());
  await runAll(page);
});

test('PMTUD 黑洞：ping 回「需要分段」、ACL 擋掉 ICMP、在介面上加 TCP MSS 調整', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l76');
  await clickDevice(page, 'pc');
  await tab(page, '終端機');
  let o = await outOf(page, 'ping -M do -s 1472 10.1.20.10');
  expect(o).toMatch(/From 10\.2\.0\.1 icmp_seq=1 Frag needed and DF set \(mtu = \d+\)/);
  expect(o).toContain('4 packets transmitted, 0 received, +4 errors, 100% packet loss');
  o = await outOf(page, 'curl -k https://10.1.20.10');
  expect(o).toContain('PMTUD 黑洞');
  // 總公司的核心：伺服器網段的 ACL 擋掉了所有 ICMP
  await clickDevice(page, 'core');
  await tab(page, 'CLI');
  o = await outOf(page, 'show ip interface vlan 20');
  expect(o).toContain('Outgoing access list is SERVERS');
  expect(o).toContain('MTU is 1500 bytes');
  o = await outOf(page, 'show access-lists');
  expect(o).toMatch(/30 deny icmp any any \(\d+ matches\)/);
  // 分公司的路由器：在 Gi0/0/1 的卡片打開「MTU 與 TCP MSS」，填 1360
  await clickDevice(page, 'br');
  await tab(page, '介面');
  const gi1 = page.locator('#panel .card', { hasText: 'Gi0/0/1' }).first();
  await gi1.locator('button.advbtn', { hasText: 'MTU 與 TCP MSS' }).click();
  const mss = page.locator('#panel .card', { hasText: 'Gi0/0/1' }).first().locator('.field', { hasText: 'TCP MSS 調整' }).locator('input');
  await mss.fill('1360');
  await mss.press('Enter');
  await expect(page.locator('#panel .card', { hasText: 'Gi0/0/1' }).first().locator('button.advbtn')).toContainText('MSS 1360');
  expect(await scan(page, '#panel', 'Branch-RT・介面')).toEqual([]);
  await page.locator('#panel .card', { hasText: 'Gi0/0/1' }).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('router-mss.png') });
  await tab(page, 'CLI');
  o = await outOf(page, 'show running-config | include adjust-mss');
  expect(o).toContain('ip tcp adjust-mss 1360');
  await runAll(page);
});
