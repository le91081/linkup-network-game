// 第 24 階段：RouterOS、AOS-CX、機櫃立面圖與樓層平面圖、業者的 MPLS 骨幹、SSL-VPN 全通道、Linux 的 sudo ip link，兩種螢幕大小都跑
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
  const app = window.linkup, sim = app.engine;
  sim.settle(app.state);
  return app.level.objectives.map((o) => (o.type === 'check' ? o.test(app.state) === true : sim.runObjective(app.state, o).pass));
});

test('RouterOS：位址、DHCP client、masquerade 之後收銀機上得了網', async ({ page }) => {
  await boot(page);
  await open(page, 'l169');
  await clickDevice(page, 'mt');
  await tab(page, 'Terminal (RouterOS)');
  await typeCmd(page, '/ip address add address=192.168.88.1/24 interface=ether2', '/ip dhcp-client add interface=ether1', '/ip dhcp-client print');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('bound');
  await typeCmd(page, '/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade', '/export');
  await expect(out).toContainText('add action=masquerade chain=srcnat out-interface=ether1');
  expect((await runAll(page)).every(Boolean)).toBe(true);
  expect(await scan(page, '#panel', 'RouterOS')).toEqual([]);
});

test('AOS-CX：VLAN 要先建；Trunk、Access 設好，Catalyst 開 LLDP', async ({ page }) => {
  await boot(page);
  await open(page, 'l170');
  await clickDevice(page, 'cx');
  await tab(page, 'CLI (AOS-CX)');
  await typeCmd(page, 'configure terminal', 'interface 1/1/24', 'vlan trunk native 1', 'vlan trunk allowed 10,20');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('VLAN 20 does not exist');
  await typeCmd(page, 'exit', 'vlan 20', 'name RD', 'exit', 'interface 1/1/24', 'vlan trunk allowed 10,20', 'exit', 'interface 1/1/2', 'vlan access 20', 'end', 'show vlan');
  await expect(out).toContainText('RD');
  await clickDevice(page, 'core');
  await tab(page, 'CLI');
  await typeCmd(page, 'configure terminal', 'lldp run', 'end');
  expect((await runAll(page)).every(Boolean)).toBe(true);
});

test('機櫃立面圖：自動上架，UPS 在最下面；搬上去會提醒', async ({ page }) => {
  await boot(page);
  await open(page, 'l157');
  await page.locator('#btn-rack').click();
  const dlg = page.locator('#modal-root .dialog');
  await expect(dlg).toContainText('機櫃立面圖');
  await dlg.getByRole('button', { name: '自動上架' }).click();
  await expect(dlg.locator('.r-unit')).toHaveCount(await page.evaluate(() => window.linkup.engine.rackSlots(window.linkup.state, 'A').length));
  expect(await page.evaluate(() => Object.values(window.linkup.state.devices).find((d) => d.model === 'ups').u)).toBe(1);
  await expect(dlg).toContainText('沒有問題');
  await dlg.locator('.r-unit', { hasText: 'UPS' }).click();
  await dlg.locator('.r-u').nth(29).click();
  await expect(dlg).toContainText('UPS 的電池很重');
  expect(await scan(page, '#modal-root', '機櫃立面圖')).toEqual([]);
});

test('樓層平面圖：牆、線路與訊號熱圖，滑鼠移上去量訊號', async ({ page }) => {
  await boot(page);
  await open(page, 'l56');
  await page.locator('#btn-rack').click();
  const dlg = page.locator('#modal-root .dialog');
  await dlg.locator('.r-seg button', { hasText: '樓層平面圖' }).click();
  await expect(dlg.locator('.fp-wall').first()).toBeAttached();
  await expect(dlg.locator('image.fp-heat')).toBeAttached();
  const svg = dlg.locator('.fp-svg');
  const b = await svg.boundingBox();
  await svg.hover({ position: { x: b.width * 0.5, y: b.height * 0.55 } });
  await expect(dlg.locator('.fp-read')).toContainText('dBm');
  await dlg.locator('.seg.prog button', { hasText: '2.4 GHz' }).click();
  await expect(dlg.locator('image.fp-heat')).toBeAttached();
  expect(await scan(page, '#modal-root', '樓層平面圖')).toEqual([]);
});

test('業者的 MPLS：P1 少了 mpls ip、PE2 的 RT 匯入錯了', async ({ page }) => {
  await boot(page);
  await open(page, 'l171');
  await clickDevice(page, 'p1');
  await tab(page, 'CLI');
  await typeCmd(page, 'show mpls ldp neighbor');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('Peer LDP Ident: 10.255.0.1:0');
  await typeCmd(page, 'configure terminal', 'interface Gi0/0/1', 'mpls ip', 'end');
  await clickDevice(page, 'pe2');
  await tab(page, 'CLI');
  await typeCmd(page, 'show vrf detail CUST-A');
  await expect(page.locator('#panel .term-out')).toContainText('RT:64500:2');
  await typeCmd(page, 'configure terminal', 'router bgp 64500', 'address-family vpnv4');
  await expect(page.locator('#panel .prompt')).toHaveText(/\(config-router-af\)#/);
  await typeCmd(page, 'end', 'configure terminal', 'vrf definition CUST-A', 'address-family ipv4', 'no route-target import 64500:2', 'route-target import 64500:1', 'end', 'show bgp vpnv4 unicast all');
  await expect(page.locator('#panel .term-out')).toContainText('Route Distinguisher: 64500:1 (default for vrf CUST-A)');
  expect((await runAll(page)).every(Boolean)).toBe(true);
});

test('SSL-VPN 全通道：面板顯示全通道，加上 VPN → wan1 的政策就上得了網', async ({ page }) => {
  await boot(page);
  await open(page, 'l172');
  await clickDevice(page, 'nb');
  await tab(page, 'VPN');
  await expect(page.locator('#panel')).toContainText('全通道');
  expect((await runAll(page))[1]).toBe(false);
  await page.evaluate(() => { const app = window.linkup; app.state.devices.hq.policies.push({ name: 'VPN 上網', srcIf: 'vpn:remote', dstIf: 'wan1', src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: true }); app.changed(); });
  expect((await runAll(page)).every(Boolean)).toBe(true);
  expect(await scan(page, '#panel', 'VPN 用戶端')).toEqual([]);
});

test('Linux：sudo ip link set eth0 mtu 9000 不再出錯', async ({ page }) => {
  await boot(page);
  await open(page, 'l162');
  await clickDevice(page, 'web');
  await tab(page, '終端機');
  await typeCmd(page, 'ip link set eth0 mtu 9000');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('Operation not permitted');
  await typeCmd(page, 'sudo ip link set eth0 mtu 9000', 'sudo ip route flush cache');
  await expect.poll(() => page.evaluate(() => window.linkup.state.devices.web.ifaces[0].mtu)).toBe(9000);
});
