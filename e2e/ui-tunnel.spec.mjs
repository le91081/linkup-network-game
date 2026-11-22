// Tunnel 介面：GRE / DMVPN 的設定卡片、VPN 分頁的 IKE 與 IPsec profile、CLI 的 show dmvpn，兩種螢幕大小都跑
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

test('GRE：介面分頁的 Tunnel 卡片、VPN 分頁加上 IPsec profile、套用到 Tunnel 之後加密', async ({ page }) => {
  await boot(page);
  await open(page, 'l89');
  await clickDevice(page, 'hq');
  const tun = page.locator('#panel .card', { hasText: 'Tunnel0' }).first();
  await expect(tun).toContainText('line protocol up');
  await expect(tun).toContainText('GRE 點對點');
  expect(await scan(page, '#panel', '介面分頁（Tunnel）')).toEqual([]);
  // VPN 分頁：IKE 政策、金鑰、IPsec profile
  await page.locator('#panel .tab', { hasText: 'VPN' }).click();
  await page.locator('#panel button', { hasText: '新增 IKE 政策' }).click();
  await page.locator('#panel button', { hasText: '新增金鑰' }).click();
  const ike = page.locator('#panel .card', { hasText: 'IKE 第一階段' });
  const row = ike.locator('.addrow', { has: page.locator('input[placeholder="金鑰"]') }).first();
  await row.locator('input').first().fill('198.51.100.6');
  await row.locator('input').first().press('Enter');
  await ike.locator('input[placeholder="金鑰"]').first().fill('Fac!Gre#2026');
  await ike.locator('input[placeholder="金鑰"]').first().press('Enter');
  await page.locator('#panel button', { hasText: '新增 IPsec profile' }).click();
  await expect(page.locator('#panel .card', { hasText: 'IPsec profile（給 Tunnel' })).toContainText('PROF1');
  expect(await scan(page, '#panel', 'VPN 分頁（IPsec profile）')).toEqual([]);
  const st = await page.evaluate(() => { const d = window.linkup.state.devices.hq; return { keys: d.ikeKeys, pols: d.isakmp, profs: Object.keys(d.ipsecProfiles || {}) }; });
  expect(st.keys['198.51.100.6']).toBe('Fac!Gre#2026');
  expect(st.pols[0]).toMatchObject({ enc: 'aes256', hash: 'sha256', dh: '14' });
  expect(st.profs).toEqual(['PROF1']);
  // 套用到 Tunnel0：對面還沒設定，IPsec 建不起來
  await page.locator('#panel .tab', { hasText: '介面' }).click();
  await tun.locator('select').filter({ has: page.locator('option', { hasText: 'IPsec profile PROF1' }) }).selectOption('PROF1');
  await expect(page.locator('#panel .card', { hasText: 'Tunnel0' }).first()).toContainText(/IPsec 對 198\.51\.100\.6：/);
  // CLI 看得到同一份設定
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'show running-config interface Tunnel0');
  await expect(page.locator('#panel .term-out')).toContainText('tunnel protection ipsec profile PROF1');
});

test('DMVPN：spoke 的 NHRP 設定、show dmvpn、show ip nhrp nhs', async ({ page }) => {
  await boot(page);
  await open(page, 'l91');
  await page.evaluate(() => { const app = window.linkup; app.level.solve(app.state); app.settleNow(); });
  await clickDevice(page, 's1');
  const tun = page.locator('#panel .card', { hasText: 'Tunnel0' }).first();
  await expect(tun).toContainText('mGRE 多點');
  await expect(tun).toContainText('10.0.0.1（NHS）');
  await expect(tun.locator('input[placeholder="hub 的公用 IP (NBMA)"]')).toHaveValue('203.0.113.2');
  expect(await scan(page, '#panel', '介面分頁（DMVPN spoke）')).toEqual([]);
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'show dmvpn');
  await expect(page.locator('#panel .term-out')).toContainText(/Type:Spoke, NHRP Peers:1/);
  await expect(page.locator('#panel .term-out')).toContainText(/203\.0\.113\.2\s+10\.0\.0\.1\s+UP/);
  await typeCmd(page, 'show ip nhrp nhs');
  await expect(page.locator('#panel .term-out')).toContainText(/10\.0\.0\.1\s+RE\s+NBMA Address: 203\.0\.113\.2/);
  expect(await scan(page, '#panel', 'CLI')).toEqual([]);
});
