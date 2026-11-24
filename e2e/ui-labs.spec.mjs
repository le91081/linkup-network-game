// 關卡選單（章節導覽、搜尋、學習路線）、觀察題（封包實驗室）、2D 拓撲圖的圖示與封包動畫、3D 的埠名標籤、收合學習筆記
import { test, expect, boot, closeDialog, scan, waitScene } from './helpers.mjs';

const open = async (page, id) => {
  await page.evaluate((x) => { const a = window.linkup; a.toggle2d(false); a.loadLevel(a.levels.findIndex((l) => l.id === x), { fresh: true }); }, id);
  await waitScene(page);
};
const inside = async (page, outer, inner) => page.evaluate(([o, i]) => {
  const a = document.querySelector(o).getBoundingClientRect();
  return [...document.querySelectorAll(i)].every((el) => { const b = el.getBoundingClientRect(); return b.left >= a.left - 0.5 && b.right <= a.right + 0.5 && b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5; });
}, [outer, inner]);

test('關卡選單：章節導覽與進度、搜尋、只看未完成、學習路線、接著做', async ({ page }) => {
  await boot(page, { keepDialog: true });
  const dlg = page.locator('#modal-root .dialog.lvp');
  await expect(dlg).toBeVisible();
  expect(await scan(page, '#modal-root', '關卡選單')).toEqual([]);
  // 左邊 18 章，每一章有「完成數 / 總數」；右邊的章節標題一樣多
  await expect(dlg.locator('.lvp-row[data-ch]')).toHaveCount(18);
  await expect(dlg.locator('.lvp-row[data-ch="18"]')).toContainText('封包實驗室');
  await expect(dlg.locator('.lvp-row[data-ch="18"] .c')).toHaveText('0/5');
  await expect(dlg.locator('.lvp-main .chapter')).toHaveCount(18);
  // 整個視窗不捲動，只有右邊的清單會捲；其他模式的卡片一直看得到
  expect(await dlg.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await expect(dlg.locator('.mode-card', { hasText: '故障演練' })).toBeVisible();
  // 點左邊的章節：右邊捲到那一章，左邊標出目前的位置
  await dlg.locator('.lvp-row[data-ch="9"]').click();
  await expect(dlg.locator('.lvp-row[data-ch="9"]')).toHaveClass(/on/);
  await expect(dlg.locator('.chapter[data-ch="9"] h2')).toBeInViewport();
  // 搜尋：不分章節列出符合的；Esc 先清掉搜尋字，不會把視窗關掉
  const q = dlg.locator('.lvp-q');
  await q.fill('ospf');
  await expect(dlg.locator('.lvp-note')).toHaveText(/找到 \d+ 關/);
  const hits = await dlg.locator('.lv-grid .lv').count();
  expect(hits).toBeGreaterThan(5);
  // 每一張卡片上都看得到為什麼符合（標題、副標題，或排到前面的標籤）
  expect(await dlg.locator('.lv-grid .lv').evaluateAll((els) => els.every((e) => /ospf/i.test(e.textContent)))).toBe(true);
  await expect(dlg.locator('.lv-grid .lv .chip.hit').first()).toBeVisible();
  await q.fill('這個字不會出現在任何關卡');
  await expect(dlg.locator('.lvp-note')).toContainText('沒有符合的關卡');
  await q.press('Escape');
  await expect(q).toHaveValue('');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.lvp-main .chapter')).toHaveCount(18);
  // 只看已完成：還沒有任何一關
  await dlg.locator('.lvp-filter button', { hasText: '已完成' }).click();
  await expect(dlg.locator('.lvp-note')).toContainText('還沒有完成的關卡');
  await dlg.locator('.lvp-filter button', { hasText: '全部' }).click();
  // 學習路線：八條；進「新手入門」看到階段與順序，第一關標著「接著做」
  await dlg.locator('.lvp-view button', { hasText: '學習路線' }).click();
  await expect(dlg.locator('.pathc')).toHaveCount(8);
  expect(await scan(page, '#modal-root', '學習路線總覽')).toEqual([]);
  await dlg.locator('.pathc', { hasText: '新手入門' }).click();
  await expect(dlg.locator('.path-head h2')).toHaveText('新手入門');
  await expect(dlg.locator('.chapter.pstep')).toHaveCount(6);
  await expect(dlg.locator('.lv-ord.next')).toHaveCount(1);
  await expect(dlg.locator('.lv', { has: page.locator('.lv-ord.next') })).toContainText('第一條網路線');
  await expect(dlg.locator('.lv', { hasText: '信封換了幾次' })).toHaveCount(1);
  expect(await scan(page, '#modal-root', '學習路線')).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // 從路線進一關
  await dlg.locator('.lv', { hasText: '信封換了幾次' }).click();
  await closeDialog(page);
  await expect(page.locator('#topbar .crumb b')).toContainText('信封換了幾次');
  // 再打開：記得上次看的是路線；左上的捷徑是「繼續這一關」
  await page.locator('#topbar button', { hasText: '關卡' }).click();
  await expect(page.locator('#modal-root .path-head h2')).toHaveText('新手入門');
  await expect(page.locator('#modal-root .lvp-next')).toContainText('繼續這一關');
  await page.locator('#modal-root .lvp-view button', { hasText: '章節' }).click();
  await expect(page.locator('#modal-root .lvp-row[data-ch="18"]')).toHaveClass(/on/);
});

test('觀察題：選錯有說明、填空不管格式、可以復原，全部答對就過關', async ({ page }) => {
  await boot(page);
  await open(page, 'l173');
  const asks = page.locator('#mission .obj.ask');
  await expect(asks).toHaveCount(4);
  await expect(asks.first().locator('.ans')).toHaveText('觀察題 · 點一下作答');
  expect(await scan(page, '#mission', '封包實驗室的任務面板')).toEqual([]);
  // 先跑一次：ping 會過，觀察題還沒答
  await page.locator('#mission .m-foot button', { hasText: '執行' }).click();
  await expect(page.locator('#mission .obj.pass')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('#mission .obj.ask.fail')).toHaveCount(4);
  // 第一題選錯：說明為什麼不是伺服器
  await asks.nth(0).click();
  const dlg = page.locator('#modal-root .dialog');
  await expect(dlg.locator('.qq')).toContainText('目的 MAC 位址是哪一台設備的');
  await expect(dlg.locator('.ask-tip')).toContainText('ip neigh');
  expect(await scan(page, '#modal-root', '觀察題視窗')).toEqual([]);
  const send = dlg.locator('.d-actions .btn.primary');
  await expect(send).toBeDisabled();
  await dlg.locator('.qopt', { hasText: '伺服器的網路卡' }).click();
  await expect(dlg.locator('.qopt.on')).toHaveCount(1);
  await send.click();
  await expect(asks.nth(0)).toHaveClass(/fail/);
  await expect(asks.nth(0).locator('.why')).toContainText('ARP 是廣播');
  await expect(asks.nth(0).locator('.ans')).toContainText('伺服器的網路卡');
  // 改選對的：其他目標的結果不用重測（ping 那一項還是通過的）
  await asks.nth(0).click();
  await dlg.locator('.qopt', { hasText: 'PC-A 的預設閘道' }).click();
  await send.click();
  await expect(asks.nth(0)).toHaveClass(/pass/);
  await expect(asks.nth(0).locator('.why.ok')).toContainText('一律把訊框交給閘道');
  await expect(page.locator('#mission .obj:not(.ask)')).toHaveClass(/pass/);
  await expect(page.locator('#mission .obj.old')).toHaveCount(0);
  // 第二題填空：從設備上查到的 MAC，換一種寫法照樣算對
  const mac = await page.evaluate(() => window.linkup.state.devices.r2.ifaces.find((i) => i.id === 'Gi0/0/1').rt.mac);
  await asks.nth(1).click();
  await dlg.locator('.ask-inp').fill('00:11:22:33:44:55');
  await dlg.locator('.ask-inp').press('Enter');
  await expect(asks.nth(1).locator('.why')).toContainText('這不是最後一段的來源 MAC');
  await asks.nth(1).click();
  await expect(dlg.locator('.ask-inp')).toHaveValue('00:11:22:33:44:55');
  await dlg.locator('.ask-inp').fill(mac.toUpperCase().replace(/:/g, '-'));
  await dlg.locator('.ask-inp').press('Enter');
  await expect(asks.nth(1)).toHaveClass(/pass/);
  // 復原：答案回到上一個
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.linkup.state.answers.smac)).toBe('00:11:22:33:44:55');
  await page.keyboard.press('Control+y');
  expect(await page.evaluate(() => window.linkup.state.answers.smac)).toBe(mac.toUpperCase().replace(/:/g, '-'));
  // 剩下兩題
  await asks.nth(2).click();
  await dlg.locator('.qopt', { hasText: '都沒有變' }).click();
  await send.click();
  await expect(asks.nth(2)).toHaveClass(/pass/);
  await asks.nth(3).click();
  await dlg.locator('.ask-inp').fill('62');
  await dlg.locator('.ask-inp').press('Enter');
  // 復原 / 重做之後結果變舊了：整個重測一次就過關
  await page.locator('#mission .m-foot button', { hasText: '執行' }).click();
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 30000 });
  expect(await scan(page, '#modal-root', '過關視窗')).toEqual([]);
  // 過關視窗的按鈕都在視窗裡面（放不下會換行，不會跑出去）
  expect(await inside(page, '#modal-root .dialog', '#modal-root .d-actions .btn')).toBe(true);
});

test('觀察題：複選、看不到接線的關卡用埠名作答、提示看完有參考答案', async ({ page }) => {
  await boot(page);
  await open(page, 'l175');
  const asks = page.locator('#mission .obj.ask');
  const dlg = page.locator('#modal-root .dialog');
  await asks.nth(0).click();
  await expect(dlg.locator('.ask-top')).toContainText('複選');
  for (const t of ['PC-2', 'PC-3（', 'PC-4']) await dlg.locator('.qopt', { hasText: t }).click();
  await expect(dlg.locator('.qopt.on')).toHaveCount(3);
  await dlg.locator('.d-actions .btn.primary').click();
  await expect(asks.nth(0).locator('.why')).toContainText('VLAN 20 是另一個廣播網域');
  await asks.nth(0).click();
  await dlg.locator('.qopt', { hasText: 'PC-4' }).click(); // 取消
  await dlg.locator('.qopt', { hasText: 'R1 的 Gi0/0/0' }).click();
  await dlg.locator('.d-actions .btn.primary').click();
  await expect(asks.nth(0)).toHaveClass(/pass/);
  await expect(asks.nth(0).locator('.ans')).toContainText('PC-2');

  // 18-2：線看不到，埠名的寫法不拘
  await open(page, 'l174');
  expect(await page.evaluate(() => window.linkup.state.hideCables)).toBe(true);
  await asks.nth(2).click();
  await expect(dlg.locator('.ask-inp')).toHaveAttribute('placeholder', /Gi0\/3/);
  await dlg.locator('.ask-inp').fill('gigabitethernet 0/6');
  await dlg.locator('.ask-inp').press('Enter');
  await expect(asks.nth(2)).toHaveClass(/pass/);
  // 參考解法：列出每一題的答案
  await page.evaluate(() => { const a = window.linkup; a.hintsShown = a.level.hints.length; });
  await page.locator('#topbar button', { hasText: '提示' }).click();
  await page.locator('#modal-root button', { hasText: '看參考解法' }).click();
  await expect(page.locator('#modal-root .sol-ans > div')).toHaveCount(4);
  await expect(page.locator('#modal-root .sol-ans')).toContainText('Gi0/6');
  expect(await scan(page, '#modal-root', '參考解法（觀察題）')).toEqual([]);
});

test('2D 拓撲圖：設備圖示、VLAN 配色與圖例、平行的線錯開、封包動畫', async ({ page }) => {
  await boot(page);
  await open(page, 'l175');
  await page.keyboard.press('t');
  const svg = page.locator('#topo2d svg.t2');
  await expect(svg.locator('.t2-dev')).toHaveCount(7);
  await expect(svg.locator('.t2-dev .t2-ico')).toHaveCount(7);
  // Access 埠的線照 VLAN 上色（兩個 VLAN 兩種顏色），圖例列出 VLAN 的編號與名稱
  const colours = await svg.locator('line.t2-link.up[style*="stroke"]').evaluateAll((els) => [...new Set(els.map((e) => e.style.stroke))]);
  expect(colours.length).toBe(2);
  const legend = page.locator('#topo2d .t2-legend');
  await expect(legend).toContainText('VLAN 10 OFFICE');
  await expect(legend).toContainText('VLAN 20 ACCT');
  // 圖例不會蓋到兩側的面板
  expect(await page.evaluate(() => {
    const l = document.querySelector('.t2-legend').getBoundingClientRect(), m = document.querySelector('#mission').getBoundingClientRect(), p = document.querySelector('#panel').getBoundingClientRect();
    return l.left >= m.right && l.right <= p.left;
  })).toBe(true);
  // SW 與 R1 之間有兩條線：畫成兩條分開的線
  const par = await svg.locator('line.t2-link').evaluateAll((els) => els.map((e) => ['x1', 'y1', 'x2', 'y2'].map((k) => Math.round(+e.getAttribute(k))).join(',')));
  expect(new Set(par).size).toBe(par.length);
  // 關掉 VLAN 配色
  await page.locator('#topo2d .t2-tools button', { hasText: 'VLAN 配色' }).click();
  await expect(svg.locator('line.t2-link.up[style*="stroke"]')).toHaveCount(0);
  await page.locator('#topo2d .t2-tools button', { hasText: 'VLAN 配色' }).click();
  // 執行測試：2D 圖上有一顆跟著跑的封包，旁邊標著協定
  await page.evaluate(() => { window.__pk = []; const o = new MutationObserver(() => { const t = document.querySelector('#topo2d .t2-pkt-tag text'); if (t && !window.__pk.includes(t.textContent)) window.__pk.push(t.textContent); }); o.observe(document.querySelector('#topo2d svg'), { childList: true, subtree: true }); });
  await page.locator('#mission .obj').first().click();
  await expect(page.locator('#mission .obj').first()).toHaveClass(/pass/, { timeout: 30000 });
  const seen = await page.evaluate(() => window.__pk);
  expect(seen.some((t) => /ARP/.test(t))).toBe(true);
  expect(seen.some((t) => /ICMP 請求/.test(t))).toBe(true);
  expect(seen.some((t) => /ICMP 回應/.test(t))).toBe(true);
  await expect(svg.locator('.t2-pkt')).toHaveCount(0); // 播完就收起來
  await page.keyboard.press('t');
});

test('3D 場景：標籤上的設備圖示、選取設備時線上的埠名、封包的協定標籤', async ({ page }) => {
  await boot(page);
  await open(page, 'l176');
  await expect(page.locator('.dev-label .dot svg')).toHaveCount(5);
  await expect(page.locator('.port-tag')).toHaveCount(0);
  // 選 R1：它的兩條線各有一個標籤，自己的埠寫在前面
  await page.evaluate(() => window.linkup.select('r1'));
  await expect(page.locator('.port-tag')).toHaveCount(2);
  const tags = await page.locator('.port-tag').allTextContents();
  expect(tags.every((t) => /^Gi0\/0\/[01]↔8$/.test(t))).toBe(true);
  await page.evaluate(() => window.linkup.select(null));
  await expect(page.locator('.port-tag')).toHaveCount(0);
  // 封包動畫的標籤：TCP 的三個步驟都看得到
  await page.evaluate(() => { window.__tg = new Set(); const el = document.querySelector('.pkt-tag'); new MutationObserver(() => { if (el.textContent) window.__tg.add(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true }); });
  await page.locator('#mission .obj').first().click();
  await expect(page.locator('#mission .obj').first()).toHaveClass(/pass/, { timeout: 40000 });
  const seen = await page.evaluate(() => [...window.__tg]);
  for (const t of ['DNS 查詢', 'DNS 回應', 'TCP 443 · SYN', 'TCP 443 · SYN-ACK', 'TCP 443 · ACK']) expect(seen, '封包標籤').toContain(t);
});

test('學習筆記可以收起來：場景變寬、點設備照樣出現設定頁面、重新整理後還記得', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  const w = () => page.evaluate(() => Math.round(document.querySelector('#panel').getBoundingClientRect().width));
  const cons = () => page.evaluate(() => Math.round(document.querySelector('#console').getBoundingClientRect().width));
  const w0 = await w(), c0 = await cons();
  await page.locator('#panel .p-fold').click();
  await expect(page.locator('body')).toHaveClass(/guide-fold/);
  expect(await w()).toBeLessThan(60);
  expect(await cons()).toBeGreaterThan(c0 + 250);
  await expect(page.locator('#panel .p-unfold')).toContainText('學習筆記');
  // 設備的標籤還是都在可視範圍裡（鏡頭跟著重新對焦）
  await waitScene(page);
  expect(await page.evaluate(() => {
    const m = document.querySelector('#mission').getBoundingClientRect(), p = document.querySelector('#panel').getBoundingClientRect();
    return [...document.querySelectorAll('.dev-label')].every((e) => { const r = e.getBoundingClientRect(); return r.left >= m.right - 1 && r.right <= p.left + 1; });
  })).toBe(true);
  // 點設備：設定頁面照樣展開；取消選取又收回去
  await page.evaluate(() => window.linkup.select('rt'));
  await expect(page.locator('body')).not.toHaveClass(/guide-fold/);
  expect(await w()).toBe(w0);
  await expect(page.locator('#panel .tab').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveClass(/guide-fold/);
  // 重新整理：還是收著的；再展開
  await page.reload();
  await page.waitForFunction(() => window.linkup && window.linkup.state);
  await closeDialog(page);
  await expect(page.locator('body')).toHaveClass(/guide-fold/);
  await page.locator('#panel .p-unfold').click();
  await expect(page.locator('body')).not.toHaveClass(/guide-fold/);
  await expect(page.locator('#panel .p-head h2')).toHaveText('這一關的新觀念');
  expect(await scan(page, '#panel', '學習筆記')).toEqual([]);
});
