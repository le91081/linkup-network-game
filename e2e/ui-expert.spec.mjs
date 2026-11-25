// 進階內容：知識庫的「深入了解」與小節目錄、證照地圖的 CCNP / CCIE、第 19 與 20 章的關卡與學習路線
import { test, expect, boot, scan, waitScene } from './helpers.mjs';

async function open(page, id) {
  await page.evaluate((id) => { const app = window.linkup; app.openLevel(app.levels.find((l) => l.id === id), { fresh: true }); app.settleNow(); }, id);
  await waitScene(page);
}

test('知識庫的深入內容：小節、目錄、跳到小節、搜尋找得到深入的文字', async ({ page }) => {
  await boot(page);
  await open(page, 'l186');
  await page.locator('#mission .m-tabs .tab', { hasText: '知識庫' }).click();
  const dlg = page.locator('#modal-root .dialog.kbr');
  await expect(dlg).toBeVisible();
  // 這一關會用到的觀念裡有「路由重分配」，卡片上有「深入」的標記
  const card = dlg.locator('.kbr-sec').first().locator('.kbr-card', { hasText: '路由重分配' }).first();
  await expect(card.locator('.kbr-deep-tag')).toHaveText('深入');
  await card.click();
  await expect(dlg.locator('.kbr-art .kb-title h1')).toHaveText('路由重分配');
  await expect(dlg.locator('.kb-deep .kb-deep-h')).toContainText('深入了解');
  await expect(dlg.locator('.kb-deep .kb-deep-s')).toHaveCount(4);
  // 旁邊的目錄：「重點整理」加上每一個小節
  const toc = dlg.locator('.kbr-toc .kbr-toc-i');
  await expect(toc).toHaveCount(5);
  await expect(toc.nth(3)).toContainText('兩個點互相重分配');
  // 點目錄：那一個小節捲到閱讀區的上緣附近；點「重點整理」回到最上面
  await toc.nth(3).click();
  const gap = await dlg.evaluate((el) => {
    const s = el.querySelectorAll('.kb-deep-s')[2], sc = s.closest('.kbr-main') || el;
    return { top: Math.round(s.getBoundingClientRect().top - sc.getBoundingClientRect().top), scrolled: sc.scrollTop };
  });
  expect(gap.scrolled).toBeGreaterThan(100);
  expect(Math.abs(gap.top)).toBeLessThan(80);
  await toc.first().click();
  expect(await dlg.evaluate((el) => (el.querySelector('.kb-deep-s').closest('.kbr-main') || el).scrollTop)).toBe(0);
  expect(await scan(page, '#modal-root', '知識庫：深入了解')).toEqual([]);
  // 表格、指令範例都在閱讀區裡，沒有超出去
  const over = await dlg.evaluate((el) => {
    const m = el.querySelector('.kbr-text').getBoundingClientRect();
    return [...el.querySelectorAll('.kb-deep table, .kb-deep pre, .kb-deep .kb-code')].filter((x) => x.getBoundingClientRect().right > m.right + 1).length;
  });
  expect(over).toBe(0);
});

test('證照地圖：六張證照排成兩列，CCNP / CCIE 的條目對應到進階關卡', async ({ page }) => {
  await boot(page);
  await open(page, 'l187');
  // 進階關卡的標籤是 CCNP / CCIE 的條目，不是 CCNA
  const chips = page.locator('#mission .chip.cert');
  await expect(chips.first()).toContainText(/ENCOR|ENARSI|CCIE/);
  expect((await chips.allTextContents()).some((t) => /^CCNA|^Network\+/.test(t))).toBe(false);
  await chips.first().click();
  const dlg = page.locator('#modal-root .dialog');
  const tabs = dlg.locator('.seg.certs button');
  await expect(tabs).toHaveCount(6);
  expect(await tabs.evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size)).toBe(2);
  expect(await tabs.evaluateAll((bs) => bs.filter((b) => b.scrollWidth > b.clientWidth + 1).length)).toBe(0);
  await tabs.filter({ hasText: 'ENARSI' }).click();
  await expect(dlg.locator('.crow')).toHaveCount(25);
  await expect(dlg.locator('.crow.none')).toHaveCount(1);
  await expect(dlg.locator('.crow', { hasText: 'MPLS L3VPN' }).locator('.lvchip', { hasText: '20-2' })).toHaveCount(1);
  await tabs.filter({ hasText: 'ENCOR' }).click();
  await expect(dlg.locator('.crow')).toHaveCount(42);
  await tabs.filter({ hasText: 'CCIE' }).click();
  await expect(dlg.locator('.chapter')).toHaveCount(5);
  expect(await scan(page, '#modal-root', '證照地圖')).toEqual([]);
  // 點條目上的關卡：直接進那一關
  await dlg.locator('.crow', { hasText: 'DMVPN' }).locator('.lvchip', { hasText: '20-1' }).click();
  await waitScene(page);
  expect(await page.evaluate(() => window.linkup.level.id)).toBe('l184');
});

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

test('進階關卡的 CLI：管理距離造成的迴圈、distance、EIGRP 與 OSPF 外部路由的細節', async ({ page }) => {
  await boot(page);
  await open(page, 'l186');
  await clickDevice(page, 'r1');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  const out = page.locator('#panel .term-out');
  // 開場：ASBR-1 相信的是另一台倒進 OSPF 的那一份（110），EIGRP 外部（170）輸了
  await typeCmd(page, 'enable', 'show ip route 192.168.50.0');
  await expect(out).toContainText('Known via "ospf 1", distance 110');
  await typeCmd(page, 'show ip eigrp topology 192.168.50.0/24');
  await expect(out).toContainText('EIGRP-IPv4 Topology Entry for AS(100)/ID(1.1.1.1) for 192.168.50.0/24');
  await expect(out).toContainText('External protocol is Static');
  // 調整 OSPF 外部路由的管理距離：這一台回到 EIGRP
  await typeCmd(page, 'configure terminal', 'router ospf 1', 'distance ospf external 171', 'end', 'show ip route 192.168.50.0');
  await expect(out).toContainText('Known via "eigrp 100", distance 170');
  await typeCmd(page, 'show ip protocols');
  await expect(out).toContainText('Distance: intra-area 110 inter-area 110 external 171');
  await typeCmd(page, 'show running-config | section ospf');
  await expect(out).toContainText('distance ospf external 171');
  expect(await scan(page, '#panel', 'CLI（重分配）')).toEqual([]);
  // DC-Core：每一筆外部路由是哪一台送的
  await clickDevice(page, 'r4');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'enable', 'show ip ospf database external');
  await expect(page.locator('#panel .term-out')).toContainText('Advertising Router: 2.2.2.2');
  await expect(page.locator('#panel .term-out')).toContainText('Metric Type: 2 (Larger than any link state path)');
  expect(await scan(page, '#panel', 'CLI（OSPF 外部路由）')).toEqual([]);
});
