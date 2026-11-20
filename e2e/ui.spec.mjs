// 真的用滑鼠點、用鍵盤打字：關卡選單、選設備、切分頁、CLI、主機終端機、上方按鈕、復原。兩種螢幕大小都跑。
import { test, expect, boot, closeDialog, scan, waitScene } from './helpers.mjs';

async function open(page, id, solve = false) {
  await page.evaluate(([id, solve]) => {
    const app = window.linkup, lv = app.levels.find((l) => l.id === id);
    app.openLevel(lv, { fresh: true });
    if (solve) { lv.solve(app.state); app.changed(); app.settleNow(); }
  }, [id, solve]);
  await waitScene(page);
}

/** 點場景上的設備名稱標籤（標籤本身不吃滑鼠事件，點下去的是畫布，場景用位置判斷點到哪台） */
async function clickDevice(page, id) {
  const lab = page.locator(`.dev-label[data-dev="${id}"]`);
  await expect(lab).toBeVisible();
  const b = await lab.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

async function typeCmd(page, cmd) {
  const input = page.locator('#panel .term-input');
  await input.click();
  await input.fill(cmd);
  await input.press('Enter');
}
const termText = (page) => page.locator('#panel .term-out').innerText();

test('檢查工具本身：真的抓得到 undefined 與水平捲軸', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = '<div class="m-scroll" style="width:100px;overflow:auto"><span>IP：undefined</span><div style="width:400px;white-space:nowrap">很長很長</div></div><b>null</b>';
    document.body.append(box);
    const out = window.__scan(box, '自我測試');
    box.remove();
    return out;
  });
  expect(r.some((x) => x.includes('undefined'))).toBe(true);
  expect(r.some((x) => x.includes('null'))).toBe(true);
  expect(r.some((x) => x.includes('水平捲軸'))).toBe(true);
});

test('關卡選單：章節標題一行、沒有水平捲軸、點關卡卡片會進入關卡', async ({ page }) => {
  await boot(page, { keepDialog: true });
  const dlg = page.locator('#modal-root .dialog');
  await expect(dlg).toBeVisible();
  expect(await scan(page, '#modal-root', '關卡選單')).toEqual([]);
  // 每個章節標題（不含下面的說明）都只佔一行
  const wrapped = await page.evaluate(() => [...document.querySelectorAll('.chapter h2')].filter((h2) => {
    const r = document.createRange(); r.selectNodeContents(h2.firstChild);
    return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1;
  }).map((h2) => h2.firstChild.textContent));
  expect(wrapped, '換行的章節標題').toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // 對話框不能超出視窗
  const box = await dlg.boundingBox(), vp = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  await dlg.locator('button.lv', { hasText: '跨 VLAN 路由' }).click();
  // 第一次進關卡會跳出「怎麼玩」
  await expect(page.locator('#modal-root .dialog')).toContainText('怎麼玩');
  expect(await scan(page, '#modal-root', '怎麼玩')).toEqual([]);
  await page.locator('#modal-root button', { hasText: '開始' }).click();
  await expect(page.locator('#modal-root .backdrop')).toHaveCount(0);
  await expect(page.locator('#topbar .crumb b')).toContainText('跨 VLAN 路由');
  await expect(page.locator('#mission h1')).toHaveText('跨 VLAN 路由');
});

test('版面：任務面板、場景、設定面板與主控台互不重疊，都在視窗內', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  await clickDevice(page, 'rt');
  const r = await page.evaluate(() => {
    const b = (id) => document.getElementById(id).getBoundingClientRect();
    const m = b('mission'), p = b('panel'), c = b('console'), t = b('topbar');
    return { m: [m.left, m.right, m.top, m.bottom], p: [p.left, p.right, p.top, p.bottom], c: [c.left, c.right, c.top, c.bottom], t: t.bottom, W: innerWidth, H: innerHeight, sx: document.documentElement.scrollWidth, sy: document.documentElement.scrollHeight };
  });
  expect(r.m[1], '任務面板的右邊要在設定面板左邊之前').toBeLessThan(r.p[0]);
  expect(r.m[2]).toBeGreaterThanOrEqual(r.t);
  expect(r.p[1]).toBeLessThanOrEqual(r.W);
  expect(r.p[3]).toBeLessThanOrEqual(r.H);
  expect(r.c[3]).toBeLessThanOrEqual(r.H);
  expect(r.sx, '頁面不能有水平捲軸').toBeLessThanOrEqual(r.W);
  expect(r.sy, '頁面不能有垂直捲軸').toBeLessThanOrEqual(r.H);
  // 每台設備的名稱標籤都在場景可見範圍內（不會被兩側面板蓋住）
  const hidden = await page.evaluate(() => {
    const m = document.getElementById('mission').getBoundingClientRect(), p = document.getElementById('panel').getBoundingClientRect();
    return [...document.querySelectorAll('.dev-label')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width && (r.left < m.right - 2 || r.right > p.left + 2);
    }).map((el) => el.dataset.dev);
  });
  expect(hidden, '被面板蓋住的設備標籤').toEqual([]);
});

test('點設備、切分頁：面板跟著換，分頁內容沒有怪字', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  await clickDevice(page, 'sw');
  await expect(page.locator('#panel .p-title h2')).toHaveText(await page.evaluate(() => window.linkup.state.devices.sw.name));
  const tabs = page.locator('#panel .tab');
  const n = await tabs.count();
  expect(n).toBeGreaterThan(2);
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    await expect(tabs.nth(i)).toHaveClass(/\bon\b/);
    expect(await scan(page, '#panel', `交換器・${await tabs.nth(i).innerText()}`)).toEqual([]);
  }
  // Esc 取消選取，面板回到關卡說明（最後一個分頁是 CLI，游標在輸入框裡：第一次 Esc 先離開輸入框）
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#panel .tabs')).toHaveCount(0);
  await expect(page.locator('#panel .p-title h2')).toHaveText('這一關的新觀念');
});

test('Cisco CLI：打指令、管線過濾、設定模式與 running-config', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  await clickDevice(page, 'rt');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'enable');
  await typeCmd(page, 'show ip interface brief');
  let out = await termText(page);
  expect(out).toMatch(/Interface\s+IP-Address\s+OK\? Method\s+Status\s+Protocol/);
  expect(out).toContain('GigabitEthernet0/0/0');
  // 管線：只留 hostname 那一行
  const before = (await termText(page)).length;
  await typeCmd(page, 'show running-config | include ^hostname');
  out = (await termText(page)).slice(before);
  expect(out).toMatch(/hostname \S+/);
  expect(out).not.toContain('interface GigabitEthernet');
  // 設定模式：改主機名稱，提示字元跟著變，running-config 也看得到
  await typeCmd(page, 'configure terminal');
  await typeCmd(page, 'hostname E2E-RT');
  await typeCmd(page, 'end');
  await expect(page.locator('#panel .term-line')).toContainText('E2E-RT#');
  await typeCmd(page, 'show running-config | include hostname');
  expect(await termText(page)).toContain('hostname E2E-RT');
  // ? 說明
  await typeCmd(page, 'show ip ?');
  expect(await termText(page)).toMatch(/route|interface/);
  expect(await scan(page, '#panel', 'CLI')).toEqual([]);
  // Esc：有打字先清掉這一行，空的再按就離開輸入框
  const input = page.locator('#panel .term-input');
  await input.fill('show vers');
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(input).not.toBeFocused();
  // 復原：按鈕可以按，Ctrl+Z 之後名稱回來
  await expect(page.locator('#btn-undo')).toBeEnabled();
  await page.locator('#btn-undo').click();
  await expect(page.locator('#toasts')).toContainText('已復原');
  expect(await page.evaluate(() => window.linkup.state.devices.rt.name)).not.toBe('E2E-RT');
});

test('err-disabled：show 指令、安全分頁的自動恢復設定、連接埠的重新啟用', async ({ page }) => {
  await boot(page);
  await open(page, 'l32', true);
  await clickDevice(page, 'sw-a');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'show interfaces status err-disabled');
  await expect(page.locator('#panel .term-out')).toContainText(/Gi0\/5\s+err-disabled bpduguard/);
  await typeCmd(page, 'enable');
  await typeCmd(page, 'configure terminal');
  await typeCmd(page, 'errdisable recovery cause bpduguard');
  await typeCmd(page, 'errdisable recovery interval 45');
  await typeCmd(page, 'end');
  await typeCmd(page, 'show errdisable recovery');
  await expect(page.locator('#panel .term-out')).toContainText(/bpduguard\s+Enabled/);
  await expect(page.locator('#panel .term-out')).toContainText('Timer interval: 45 seconds');
  expect(await scan(page, '#panel', 'CLI')).toEqual([]);
  // 安全分頁：設定同步過來，列出 err-disabled 的埠
  await page.locator('#panel .tab', { hasText: '安全' }).click();
  const card = page.locator('#panel .card', { hasText: 'err-disabled 自動恢復' });
  await expect(card).toContainText('Gi0/5');
  await expect(card.locator('input:not([type=checkbox])').first()).toHaveValue('45');
  await expect(card.locator('input[type=checkbox]').first()).toBeChecked();
  expect(await scan(page, '#panel', '安全分頁')).toEqual([]);
});

test('HSRP 與追蹤：面板的追蹤設定、show standby brief、show track', async ({ page }) => {
  await boot(page);
  await open(page, 'l64');
  await clickDevice(page, 'gw-a');
  // 路由分頁：新增追蹤物件（預設是第一個介面 Gi0/0/0）
  await page.locator('#panel .tab', { hasText: '路由' }).click();
  const card = page.locator('#panel .card', { hasText: '物件追蹤與 IP SLA' });
  await card.getByRole('button', { name: '新增追蹤物件' }).click();
  await expect(card).toContainText('track 1');
  await expect(card.locator('.link')).toContainText('Up');
  expect(await scan(page, '#panel', '路由分頁')).toEqual([]);
  // 介面分頁：HSRP 加入追蹤
  await page.locator('#panel .tab', { hasText: '介面' }).click();
  await page.locator('#panel button', { hasText: '加入追蹤' }).first().click();
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.linkup.state.devices['gw-a'].ifaces.find((i) => i.id === 'Gi0/0/1').vrrp.track))).toBe('[{"obj":1}]');
  expect(await scan(page, '#panel', '介面分頁')).toEqual([]);
  // CLI
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'show standby brief');
  await expect(page.locator('#panel .term-out')).toContainText(/Gi0\/0\/1\s+1\s+110 P Active\s+local\s+10\.0\.10\.3\s+10\.0\.10\.1/);
  await typeCmd(page, 'show track');
  await expect(page.locator('#panel .term-out')).toContainText('Interface GigabitEthernet0/0/0 line-protocol');
  await expect(page.locator('#panel .term-out')).toContainText('HSRP GigabitEthernet0/0/1 1');
  await typeCmd(page, 'show running-config | include track|standby');
  await expect(page.locator('#panel .term-out')).toContainText('track 1 interface GigabitEthernet0/0/0 line-protocol');
  await expect(page.locator('#panel .term-out')).toContainText('standby 1 track 1');
  expect(await scan(page, '#panel', 'CLI')).toEqual([]);
});

test('設定封存：show archive、差異比對、變更紀錄，Syslog 伺服器收到紀錄', async ({ page }) => {
  await boot(page);
  await open(page, 'l65');
  await clickDevice(page, 'rt');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'show archive');
  await expect(page.locator('#panel .term-out')).toContainText('flash:archive-3 <- Most Recent');
  await typeCmd(page, 'show archive config differences flash:archive-2 flash:archive-3');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('+ip access-list extended SALES-IN');
  await expect(out).toContainText('interface GigabitEthernet0/0/1.20');
  await expect(out).toContainText('+ip access-group SALES-IN in');
  await expect(out).toContainText('+snmp-server location 3F-IDF-Rack2');
  await typeCmd(page, 'show archive log config all');
  await expect(out).toContainText(/bob@vty0\s+\| ip access-group SALES-IN in/);
  await expect(out).toContainText('username alice privilege 15 secret *****');
  expect(await scan(page, '#panel', 'CLI')).toEqual([]);
  // Syslog 伺服器也收到了（設備被重灌也查得到）
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await clickDevice(page, 'log');
  await page.locator('#panel .tab', { hasText: 'Syslog' }).click();
  await expect(page.locator('#panel')).toContainText('CFGLOG_LOGGEDCMD');
  await expect(page.locator('#panel')).toContainText('User:bob');
  expect(await scan(page, '#panel', 'Syslog 伺服器')).toEqual([]);
});

test('虛擬化：在 vSwitch 分頁改連接埠群組的 VLAN、虛擬機器清單、拖曳 VM 接上主機', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l70');
  await clickDevice(page, 'esx');
  await expect(page.locator('#panel .tab.on')).toHaveText('虛擬交換器');
  // DB 群組的 VLAN ID 0 → 20
  const row = page.locator('#panel .trow.c-pg').nth(1);
  await expect(row.locator('input').first()).toHaveValue('DB');
  const vlan = row.locator('input').nth(1);
  await vlan.fill('20');
  await vlan.press('Enter');
  await expect.poll(() => page.evaluate(() => window.linkup.state.devices.esx.vsw.pgs.find((p) => p.name === 'DB').vlan)).toBe(20);
  expect(await scan(page, '#panel', '虛擬交換器')).toEqual([]);
  await page.locator('#panel .tab', { hasText: '虛擬機器' }).click();
  await expect(page.locator('#panel')).toContainText('web-vm');
  await expect(page.locator('#panel')).toContainText('db-vm');
  expect(await scan(page, '#panel', '虛擬機器')).toEqual([]);
  if (info.project.name === '1440x900') await page.screenshot({ path: info.outputPath('l70.png') });
  // 新的 VM 拖到主機上：自動接到下一個空的虛擬埠
  await page.evaluate(() => {
    const app = window.linkup;
    app.state.devices.vm3 = JSON.parse(JSON.stringify(app.state.devices.web));
    Object.assign(app.state.devices.vm3, { id: 'vm3', name: 'vm-3', pos: [11, 4] });
    app.state.devices.vm3.ifaces[0].ip = '10.0.10.11';
    app.changed();
    app.scene.load(app.state, { keep: true });
  });
  await waitScene(page);
  const c = async (id) => { const b = await page.locator(`.dev-label[data-dev="${id}"]`).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const [x0, y0] = await c('vm3'), [x1, y1] = await c('esx');
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 }); await page.mouse.move(x1, y1, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.linkup.state.cables.some((x) => x.a.dev === 'vm3' && x.b.dev === 'esx' && x.b.port === 'vp3'))).toBe(true);
});

test('DNS：nslookup 不看快取、ping 用快取、ipconfig /displaydns 與 /flushdns', async ({ page }) => {
  await boot(page);
  await open(page, 'l71');
  await clickDevice(page, 'pc-a');
  await page.locator('#panel .tab', { hasText: '終端機' }).click();
  const out = page.locator('#panel .term-out');
  await typeCmd(page, 'nslookup www.corp.local');
  await expect(out).toContainText(/名稱:\s+web\.corp\.local/);
  await expect(out).toContainText(/Address:\s+10\.0\.2\.20/);
  await expect(out).toContainText(/Aliases:\s+www\.corp\.local/);
  await typeCmd(page, 'ipconfig /displaydns');
  await expect(out).toContainText(/A \(主機\) 記錄\s+\. \. \. : 10\.0\.2\.10/);
  await typeCmd(page, 'ipconfig /flushdns');
  await expect(out).toContainText('已成功清除 DNS 解析程式快取。');
  await typeCmd(page, 'nslookup -type=mx corp.local');
  await expect(out).toContainText('mail exchanger = mail.corp.local');
  expect(await scan(page, '#panel', '終端機')).toEqual([]);
  // DNS 伺服器的記錄分頁
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await clickDevice(page, 'dns');
  await page.locator('#panel .tab', { hasText: 'DNS' }).click();
  await expect(page.locator('#panel .trow.c-dns')).toHaveCount(5);
  expect(await scan(page, '#panel', 'DNS 記錄')).toEqual([]);
});

test('2D 邏輯拓撲圖：切換、點設備開設定、測試路徑亮起來、重新整理後記得', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l12', true);
  await page.locator('#btn-view').click();
  await expect(page.locator('#topo2d')).toBeVisible();
  await expect(page.locator('#topo2d .t2-dev')).toHaveCount(await page.evaluate(() => Object.keys(window.linkup.state.devices).length));
  await expect(page.locator('#topo2d .t2-port', { hasText: 'Eth1/49' }).first()).toBeVisible();
  // 點 2D 圖上的設備：右側面板換成它的設定
  await page.locator('#topo2d .t2-dev[data-dev="leaf2"]').click();
  await expect(page.locator('#panel .p-title h2')).toHaveText('Leaf-2');
  await expect(page.locator('#topo2d .t2-dev.sel')).toHaveCount(1);
  // 執行一項目標：走過的線亮起來
  await page.locator('#mission .obj').first().click();
  await expect(page.locator('#topo2d .t2-link.hot').first()).toBeVisible({ timeout: 20000 });
  // 2D 圖不能被兩側面板蓋住
  const hidden = await page.evaluate(() => {
    const m = document.getElementById('mission').getBoundingClientRect(), p = document.getElementById('panel').getBoundingClientRect();
    return [...document.querySelectorAll('#topo2d .t2-dev')].filter((g) => { const r = g.getBoundingClientRect(); return r.left < m.right - 2 || r.right > p.left + 2; }).map((g) => g.getAttribute('data-dev'));
  });
  expect(hidden, '被面板蓋住的設備方塊').toEqual([]);
  expect(await scan(page, '#topo2d', '2D 拓撲')).toEqual([]);
  await page.screenshot({ path: info.outputPath('topo2d.png') });
  // 記得上次的選擇
  await page.reload();
  await page.waitForFunction(() => window.linkup && window.linkup.state);
  await closeDialog(page);
  await expect(page.locator('#topo2d')).toBeVisible();
  await page.locator('#btn-view').click();
  await expect(page.locator('#topo2d')).toBeHidden();
});

test('主機終端機：ipconfig、ping 會在主控台播封包', async ({ page }) => {
  await boot(page);
  await open(page, 'l04', true);
  await clickDevice(page, 'pc-1');
  await page.locator('#panel .tab', { hasText: '終端機' }).click();
  await typeCmd(page, 'ipconfig');
  expect(await termText(page)).toContain('IPv4 位址');
  await typeCmd(page, 'ping 8.8.8.8');
  await expect(page.locator('#panel .term-out')).toContainText(/回覆自 8\.8\.8\.8|Reply from 8\.8\.8\.8/, { timeout: 15000 });
  await expect(page.locator('#console')).toContainText('ping 8.8.8.8');
  expect(await scan(page, '#panel', '終端機')).toEqual([]);
  expect(await scan(page, '#console', '主控台')).toEqual([]);
});

test('上方按鈕：測驗、證照、提示、說明、關卡都打得開，內容在視窗內', async ({ page }) => {
  await boot(page);
  await open(page, 'l18');
  const vp = page.viewportSize();
  for (const name of ['測驗', '證照', '提示', '說明', '關卡']) {
    await page.locator('#topbar button', { hasText: name }).click();
    const dlg = page.locator('#modal-root .dialog');
    await expect(dlg).toBeVisible();
    const b = await dlg.boundingBox();
    expect(b.y, `${name}：對話框上緣`).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height, `${name}：對話框下緣`).toBeLessThanOrEqual(vp.height + 1);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
    expect(await scan(page, '#modal-root', name)).toEqual([]);
    await closeDialog(page);
  }
});

test('任務面板：點單一目標只測那一項，結果和原因顯示出來', async ({ page }) => {
  await boot(page);
  await open(page, 'l08');
  await page.locator('#mission .obj').first().click();
  await expect(page.locator('#mission .obj').first()).toHaveClass(/\b(pass|fail)\b/, { timeout: 20000 });
  await expect(page.locator('#mission .obj.fail .why').first()).not.toBeEmpty();
  expect(await scan(page, '#mission', '任務面板')).toEqual([]);
  expect(await scan(page, '#console', '主控台')).toEqual([]);
});

test('主機的網路設定：手動輸入 IP，按 Enter 生效，Ctrl+Z 復原', async ({ page }) => {
  await boot(page);
  await open(page, 'l01');
  await clickDevice(page, 'pc-a');
  const card = page.locator('#panel .card').first();
  const manual = card.getByRole('button', { name: '手動設定' });
  if (await manual.count()) await manual.click();
  const ip = card.locator('input').first();
  await ip.fill('10.9.8.7');
  await ip.press('Enter');
  await expect.poll(() => page.evaluate(() => window.linkup.state.devices['pc-a'].ifaces[0].ip)).toBe('10.9.8.7');
  await page.keyboard.press('Escape'); // 離開輸入框（在輸入框裡 Ctrl+Z 是輸入框自己的復原）
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.linkup.state.devices['pc-a'].ifaces[0].ip)).not.toBe('10.9.8.7');
});
