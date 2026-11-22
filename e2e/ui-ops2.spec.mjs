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

test('雙 WAN 的 QoS：劇本三分鐘後挖斷主線，跳出通知、路由切到備援線路', async ({ page }) => {
  await boot(page);
  await open(page, 'l100');
  await page.evaluate(() => window.linkup.tick(200));
  await expect(page.locator('#toasts .toast.bad')).toContainText('道路施工又挖斷了主線');
  await clickDevice(page, 'brt');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'enable', 'show ip route static');
  await expect(page.locator('#panel .term-out')).toContainText('[10/0] via 10.255.1.2');
  expect(await scan(page, '#panel', 'CLI（雙 WAN）')).toEqual([]);
});

test('憑證驗證的 IKEv2：show crypto pki certificates 是 Not yet valid，clock set 之後 VPN 恢復', async ({ page }) => {
  await boot(page);
  await open(page, 'l101');
  await clickDevice(page, 'br');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'enable', 'show clock', 'show crypto pki certificates');
  const out = page.locator('#panel .term-out');
  await expect(out).toContainText('2002');
  await expect(out).toContainText('Status: Not yet valid');
  await typeCmd(page, 'clock set 01:02:00 5 January 2026');
  await expect(out).toContainText(/System clock has been updated from 00:00:\d\d UTC Tue Jan 1 2002 to 01:02:00 UTC Mon Jan 5 2026/);
  await page.evaluate(() => window.linkup.tick(5));
  await typeCmd(page, 'show crypto ikev2 sa');
  await expect(out).toContainText('READY');
  expect(await scan(page, '#panel', 'CLI（PKI）')).toEqual([]);
});

test('EAP-TLS：NPS 分頁重新申請伺服器憑證、筆電打開自動校時，兩台都通過 802.1X', async ({ page }) => {
  await boot(page);
  await open(page, 'l102');
  await clickDevice(page, 'nps');
  await page.locator('#panel .tab', { hasText: 'RADIUS' }).click();
  const card = page.locator('#panel .card', { hasText: '伺服器憑證與 EAP-TLS' });
  await expect(card).toContainText('已經過期');
  await card.locator('button', { hasText: '向公司的 CA 重新申請伺服器憑證' }).click();
  await expect(card).toContainText('還有');
  expect(await scan(page, '#panel', 'RADIUS 分頁（憑證）')).toEqual([]);
  await clickDevice(page, 'nb');
  await expect(page.locator('#panel')).toContainText('EAP-TLS（電腦憑證）');
  await page.locator('#panel label.switch', { hasText: '自動設定時間' }).click();
  await page.evaluate(() => window.linkup.settleNow());
  expect(await page.evaluate(() => ['sw:Gi0/1', 'sw:Gi0/2', 'sw:Gi0/3'].map((k) => window.linkup.state.rt.auth.dot1x[k].ok))).toEqual([true, true, false]);
  expect(await scan(page, '#panel', '筆電的網路設定（802.1X）')).toEqual([]);
});

test('看不到接線的關卡：場景沒有線、連接埠只說有插線，show cdp neighbors 找得到對面', async ({ page }) => {
  await boot(page);
  await open(page, 'l103');
  expect(await page.evaluate(() => window.linkup.scene.cables.size)).toBe(0);
  await clickDevice(page, 'sw');
  await expect(page.locator('#panel')).toContainText('有插線（看不到另一端）');
  await expect(page.locator('#panel')).not.toContainText('AP-2F-01 · Gi0');
  await page.locator('#panel .tab', { hasText: 'CLI' }).click();
  await typeCmd(page, 'enable', 'show cdp neighbors');
  await expect(page.locator('#panel .term-out')).toContainText('AP-2F-01');
  expect(await scan(page, '#panel', '看不到接線的連接埠')).toEqual([]);
});

test('頻道寬度與 DFS：無線電卡片列出 DFS 頻道、實際寬度，改成 40 MHz 之後不再干擾', async ({ page }) => {
  await boot(page);
  await open(page, 'l104');
  await clickDevice(page, 'apA');
  await page.locator('#panel .tab', { hasText: '無線電' }).click();
  const card = page.locator('#panel .card', { hasText: '5GHz 頻道寬度' });
  await expect(card).toContainText('實際使用 80 MHz');
  await expect(card).toContainText('AP-業務區');
  await expect(card.locator('option', { hasText: '頻道 100（DFS）' })).toHaveCount(1);
  await card.locator('select').nth(2).selectOption('40');
  await expect(card).toContainText('實際使用 40 MHz（頻道 36、40）');
  expect(await scan(page, '#panel', '無線電卡片')).toEqual([]);
});

test('Wi-Fi 6E：WPA2 的 SSID 不在 6 GHz 廣播，改成混合模式後新筆電連上 6 GHz、印表機照樣連', async ({ page }) => {
  await boot(page);
  await open(page, 'l105');
  await clickDevice(page, 'ap');
  const card = page.locator('#panel .card', { hasText: 'SSID 1' });
  await expect(card).toContainText('這個 SSID 不會在 6 GHz 廣播');
  await card.locator('select').first().selectOption('wpa2wpa3');
  await expect(page.locator('#panel .card', { hasText: 'SSID 1' })).not.toContainText('不會在 6 GHz 廣播');
  await page.evaluate(() => window.linkup.settleNow());
  expect(await page.evaluate(() => ['nbNew', 'prn'].map((id) => (window.linkup.state.devices[id].ifaces.map((i) => i.rt.assoc).find(Boolean) || {}).band))).toEqual(['6GHz', '5GHz']);
  expect(await scan(page, '#panel', 'SSID 卡片（6 GHz）')).toEqual([]);
});

test('控制器 N+1：AP 分頁可以填次要控制器，平常仍在 WLC-1', async ({ page }) => {
  await boot(page);
  await open(page, 'l106');
  await clickDevice(page, 'ap1');
  const card = page.locator('#panel .card', { hasText: '次要控制器' });
  await expect(card).toContainText('已加入 WLC-1');
  await card.locator('label', { hasText: '主要控制器' }).locator('input').fill('10.10.10.5');
  await card.locator('label', { hasText: '主要控制器' }).locator('input').press('Enter');
  await card.locator('label', { hasText: '次要控制器' }).locator('input').fill('10.10.10.6');
  await card.locator('label', { hasText: '次要控制器' }).locator('input').press('Enter');
  await page.evaluate(() => window.linkup.settleNow());
  expect(await page.evaluate(() => ({ ...window.linkup.state.devices.ap1.lwap }))).toMatchObject({ primary: '10.10.10.5', secondary: '10.10.10.6' });
  expect(await page.evaluate(() => window.linkup.state.devices.ap1.rt.capwap.wlc)).toBe('wlc1');
  expect(await scan(page, '#panel', 'AP 分頁（N+1）')).toEqual([]);
});

test('FlexConnect：AP 分頁切換模式，說明改成本地交換與 Trunk', async ({ page }) => {
  await boot(page);
  await open(page, 'l107');
  await clickDevice(page, 'ap1');
  const card = page.locator('#panel .card', { hasText: '次要控制器' });
  await expect(card).toContainText('Local：所有用戶端的流量都包在 CAPWAP 裡送回控制器');
  await card.locator('select').first().selectOption('flex');
  await expect(page.locator('#panel .card', { hasText: '次要控制器' })).toContainText('AP 接的埠要是 Trunk');
  expect(await page.evaluate(() => window.linkup.state.devices.ap1.lwap.mode)).toBe('flex');
  expect(await scan(page, '#panel', 'AP 分頁（FlexConnect）')).toEqual([]);
});

test('訪客入口：沒有 DNS 就不跳登入頁面，加進認證前允許的位址之後按同意就能上網', async ({ page }) => {
  await boot(page);
  await open(page, 'l108');
  await clickDevice(page, 'g1');
  const btn = page.locator('#panel button', { hasText: '打開瀏覽器、在入口網頁按同意' });
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.locator('#toasts .toast.bad', { hasText: '沒有跳出登入頁面' })).toBeVisible();
  await page.evaluate(() => { const s = window.linkup.state; s.devices.ap.wifi.ssids[0].portal.preauth = '8.8.8.8'; window.linkup.settleNow(); });
  await clickDevice(page, 'g1');
  await page.locator('#panel button', { hasText: '打開瀏覽器、在入口網頁按同意' }).click();
  await expect(page.locator('#toasts .toast.ok', { hasText: '可以上網了' })).toBeVisible();
  await expect(page.locator('#panel')).toContainText('已經在訪客入口按過同意');
  expect(await scan(page, '#panel', '訪客入口（手機）')).toEqual([]);
});

test('負載平衡器：EC2 主控台的分頁顯示目標不健康的原因，安全群組允許 ALB 之後兩台都健康', async ({ page }) => {
  await boot(page);
  await open(page, 'l109');
  await clickDevice(page, 'aws');
  await page.locator('#panel .tab', { hasText: '負載平衡器' }).click();
  const card = page.locator('#panel .card', { hasText: 'web-alb' });
  await expect(card).toContainText('健康的目標 0 / 2');
  await expect(card).toContainText('沒有允許 ALB 的健康檢查');
  await page.evaluate(() => { window.linkup.state.devices.aws.vpc.sgs.find((g) => g.id === 'sg-0web').in.push({ proto: 'tcp', port: '443', src: 'sg-0alb' }); window.linkup.settleNow(); });
  await clickDevice(page, 'aws');
  await page.locator('#panel .tab', { hasText: '負載平衡器' }).click();
  await expect(page.locator('#panel .card', { hasText: 'web-alb' })).toContainText('健康的目標 2 / 2');
  expect(await scan(page, '#panel', '負載平衡器分頁')).toEqual([]);
});

test('Transit Gateway：peering 分頁列出 active 的連線，TGW 主控台 attach 三個 VPC 之後路由表學到三個網段', async ({ page }) => {
  await boot(page);
  await open(page, 'l110');
  await clickDevice(page, 'shared');
  await page.locator('#panel .tab', { hasText: 'Peering' }).click();
  await expect(page.locator('#panel .card', { hasText: 'pcx-0a7e3c19d2b84f560' })).toContainText('active');
  expect(await scan(page, '#panel', 'Peering 分頁')).toEqual([]);
  await clickDevice(page, 'tgw');
  const att = page.locator('#panel .card', { hasText: 'VPC attachment' });
  for (const name of ['prod', 'shared', 'dev']) await att.locator('label.switch', { hasText: `AWS · ${name}` }).click();
  await expect(page.locator('#panel .card', { hasText: '路由表' })).toContainText('10.30.0.0/16');
  expect(await page.evaluate(() => window.linkup.state.devices.tgw.tgw.attach.length)).toBe(3);
  expect(await scan(page, '#panel', 'Transit Gateway 主控台')).toEqual([]);
});

test('NETCONF：API 分頁切到 NETCONF，沒有 netconf-yang 時連線被拒絕，開啟之後 <hello> 列出 capabilities', async ({ page }) => {
  await boot(page);
  await open(page, 'l111');
  await clickDevice(page, 'auto');
  await page.locator('#panel .tab', { hasText: 'API' }).click();
  await page.locator('#panel .seg button', { hasText: 'NETCONF' }).click();
  const req = page.locator('#panel .card', { hasText: 'NETCONF 請求' });
  await req.locator('label', { hasText: '帳號' }).locator('input').fill('netauto');
  await req.locator('label', { hasText: '密碼' }).locator('input').fill('Aut0mate!26');
  await req.locator('button', { hasText: '送出' }).click();
  await expect(page.locator('#panel .card', { hasText: '回應' })).toContainText('Connection refused');
  await page.evaluate(() => { const m = window.linkup.state.devices.rt.mgmt; m.netconf = true; m.sshKey = { bits: 2048, gen: 1 }; window.linkup.settleNow(); });
  await clickDevice(page, 'auto');
  await page.locator('#panel .card', { hasText: 'NETCONF 請求' }).locator('button', { hasText: '送出' }).click();
  await expect(page.locator('#panel .card', { hasText: '回應' })).toContainText('urn:ietf:params:netconf:base:1.1');
  expect(await scan(page, '#panel', 'API 分頁（NETCONF）')).toEqual([]);
});

test('Terraform：init、plan 列出主控台改過的地方 (drift)，main.tf 補上 8443 之後 apply 回答 yes，plan 變成 No changes', async ({ page }) => {
  await boot(page);
  await open(page, 'l112');
  await clickDevice(page, 'tf');
  await page.locator('#panel .tab', { hasText: 'Terraform' }).click();
  const out = page.locator('#panel .ans-out');
  await page.locator('#panel .tf-bar button', { hasText: 'init' }).click();
  await expect(out).toContainText('Terraform has been successfully initialized!');
  await page.locator('#panel .tf-bar button', { hasText: 'plan' }).click();
  await expect(out).toContainText('Objects have changed outside of Terraform');
  await expect(out).toContainText('Plan: 0 to add, 1 to change, 0 to destroy.');
  const ta = page.locator('#panel textarea.ans-edit');
  const v = await ta.inputValue();
  await ta.fill(v.replace('  egress {', '  ingress {\n    from_port   = 8443\n    to_port     = 8443\n    protocol    = "tcp"\n    cidr_blocks = ["198.51.100.25/32"]\n  }\n\n  egress {'));
  await expect(page.locator('#panel .api-lint')).toContainText('HCL 語法正確');
  await page.locator('#panel .tf-bar button', { hasText: 'apply' }).click();
  await expect(page.locator('#panel .tf-ask')).toBeVisible();
  expect(await scan(page, '#panel', 'Terraform 分頁')).toEqual([]);
  await page.locator('#panel .tf-ask button', { hasText: 'yes' }).click();
  await expect(out).toContainText('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.');
  await page.locator('#panel .tf-bar button', { hasText: 'plan' }).click();
  await expect(out).toContainText('No changes. Your infrastructure matches the configuration.');
  await page.locator('#panel .seg button', { hasText: 'terraform.tfstate' }).click();
  await expect(page.locator('#panel textarea.ans-edit')).toHaveValue(/"from_port": 8443/);
});

test('Catalyst Center 的範本：填變數、提交草稿、部署，結果一台一台列出 SUCCESS / FAILURE', async ({ page }) => {
  await boot(page);
  await open(page, 'l113');
  await clickDevice(page, 'dnac');
  await page.locator('#panel .tab', { hasText: 'Catalyst Center' }).click();
  await expect(page.locator('#panel .card', { hasText: '設備清單' })).toContainText('2 / 3 Reachable');
  const V = [['TPE-AS01', 'TPE-3F-A'], ['TPE-AS02', 'TPE-3F-B'], ['TPE-AS03', 'TPE-5F-C']];
  const rows = page.locator('#panel .dn-target');
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { const x = rows.nth(i).locator('input.inp').nth(j); await x.fill(V[i][j]); await x.press('Enter'); }
  await page.locator('#panel .ans-bar input.inp').fill('Add logging host');
  await page.locator('#panel .btn', { hasText: '提交' }).click();
  await expect(page.locator('#panel .note.ok', { hasText: '已提交 v2' })).toBeVisible();
  await page.locator('#panel .btn', { hasText: '部署到選取的設備' }).click();
  const res = page.locator('#panel .card', { hasText: '部署結果' });
  await expect(res).toContainText('0 / 3 SUCCESS');
  await expect(res).toContainText('第 4 行「ntp sever 10.1.98.10」');
  await expect(res).toContainText('不在 SW-C 允許管理的位址範圍內');
  expect(await scan(page, '#panel', 'Catalyst Center 分頁')).toEqual([]);
});
