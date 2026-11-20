// 第十一階段：VRF、容器、HTTPS 憑證（真的在 CLI、終端機與面板上操作）。兩種螢幕大小都跑。
import { test, expect, boot, scan, waitScene } from './helpers.mjs';

async function open(page, id) {
  await page.evaluate((id) => { const app = window.linkup; app.openLevel(app.levels.find((l) => l.id === id), { fresh: true }); }, id);
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
/** 下一個指令的輸出（從現在的位置開始算） */
async function outOf(page, ...cmds) {
  const out = page.locator('#panel .term-out');
  const before = (await out.innerText()).length;
  await typeCmd(page, ...cmds);
  return (await out.innerText()).slice(before);
}
const tab = (page, name) => page.locator('#panel .tab', { hasText: name }).click();

test('VRF：重疊的網段被拒絕，建立 VRF 之後同一個位址設得上去，show vrf 與路由分頁的 VRF 卡片', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l72');
  await clickDevice(page, 'rt');
  await tab(page, 'CLI');
  let o = await outOf(page, 'enable', 'configure terminal', 'interface gi0/0/1', 'ip address 192.168.1.1 255.255.255.0');
  expect(o).toContain('192.168.1.0 overlaps with GigabitEthernet0/0/0');
  await typeCmd(page, 'exit', 'vrf definition TENANT-A', 'rd 65000:1', 'address-family ipv4', 'exit-address-family',
    'vrf definition TENANT-B', 'rd 65000:2', 'address-family ipv4', 'exit-address-family');
  o = await outOf(page, 'interface gi0/0/0', 'vrf forwarding TENANT-A');
  expect(o).toContain('IPv4 disabled and address(es) removed due to enabling VRF TENANT-A');
  await typeCmd(page, 'ip address 192.168.1.1 255.255.255.0', 'interface gi0/0/1', 'vrf forwarding TENANT-B');
  o = await outOf(page, 'ip address 192.168.1.1 255.255.255.0');
  expect(o).not.toContain('overlaps');
  await typeCmd(page, 'interface gi0/0/2.10', 'vrf forwarding TENANT-A', 'ip address 10.1.0.1 255.255.255.0', 'interface gi0/0/2.20', 'vrf forwarding TENANT-B', 'ip address 10.1.0.1 255.255.255.0', 'end');
  o = await outOf(page, 'show vrf');
  expect(o).toMatch(/TENANT-A\s+65000:1\s+ipv4\s+Gi0\/0\/0/);
  o = await outOf(page, 'show ip route vrf TENANT-B');
  expect(o).toContain('Routing Table: TENANT-B');
  expect(o).toMatch(/C\s+10\.1\.0\.0\/24 is directly connected, GigabitEthernet0\/0\/2\.20/);
  expect(await scan(page, '#panel', 'VRF・CLI')).toEqual([]);
  // 路由分頁：兩個 VRF、各自的介面與路由
  await tab(page, '路由');
  const card = page.locator('#panel .card', { hasText: 'VRF（2）' });
  await expect(card).toBeVisible();
  await expect(card.locator('.sub.vrf').nth(1)).toContainText('介面：Gi0/0/1、Gi0/0/2.20');
  await card.scrollIntoViewIfNeeded();
  expect(await scan(page, '#panel', 'VRF・路由')).toEqual([]);
  await page.screenshot({ path: info.outputPath('vrf-routes.png') });
  // 介面分頁：路由器有 VRF 時，介面上多一個 VRF 選單
  await tab(page, '介面');
  await expect(page.locator('#panel .field', { hasText: 'VRF' }).first()).toBeVisible();
  expect(await scan(page, '#panel', 'VRF・介面')).toEqual([]);
});

test('容器：docker ps、連接埠對錯、只綁 127.0.0.1、重建之後連得到；Docker 分頁', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l73');
  await clickDevice(page, 'dk');
  await tab(page, '終端機');
  await expect(page.locator('#panel .term-line')).toContainText('admin@docker-01:~$');
  let o = await outOf(page, 'docker ps');
  expect(o).toMatch(/CONTAINER ID\s+IMAGE\s+COMMAND\s+CREATED\s+STATUS\s+PORTS\s+NAMES/);
  expect(o).toContain('127.0.0.1:3000->3000/tcp');
  expect(o).toContain('0.0.0.0:8080->8080/tcp, 80/tcp');
  o = await outOf(page, 'curl http://localhost:8080');
  expect(o).toContain('curl: (56) Recv failure: Connection reset by peer');
  o = await outOf(page, 'curl http://localhost:3000');
  expect(o).toContain('HTTP/1.1 200 OK');
  o = await outOf(page, 'docker rm web');
  expect(o).toContain('You cannot remove a running container');
  o = await outOf(page, 'docker rm -f web', 'docker run -d --name web -p 8080:80 nginx');
  expect(o).toMatch(/^web$/m);
  o = await outOf(page, 'curl http://localhost:8080');
  expect(o).toContain('HTTP/1.1 200 OK');
  o = await outOf(page, 'docker port web');
  expect(o).toContain('80/tcp -> 0.0.0.0:8080');
  o = await outOf(page, 'ip addr');
  expect(o).toContain('inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0');
  expect(o).toMatch(/veth\w+@if\d+: .*master docker0/);
  o = await outOf(page, "docker inspect -f '{{.NetworkSettings.IPAddress}}' grafana");
  expect(o).toMatch(/^172\.17\.0\.\d+$/m);
  o = await outOf(page, 'docker rm -f nope');
  expect(o).toContain('No such container: nope');
  o = await outOf(page, 'help');
  expect(o).toContain('docker run -d --name');
  expect(o).not.toContain('ipconfig');
  o = await outOf(page, 'ipconfig');
  expect(o).toContain('ipconfig: command not found');
  expect(await scan(page, '#panel', '容器・終端機')).toEqual([]);
  // 同事的電腦：8080 通了，3000 還是只綁在 127.0.0.1
  await clickDevice(page, 'pc');
  await tab(page, '終端機');
  o = await outOf(page, 'curl http://10.0.50.20:8080');
  expect(o).toContain('HTTP/1.1 200 OK');
  o = await outOf(page, 'curl http://10.0.50.20:3000');
  expect(o).toMatch(/Connection refused/);
  expect(o).toContain('127.0.0.1');
  // Docker 分頁：刪掉 db，重建一個沒有發佈連接埠的
  await clickDevice(page, 'dk');
  await tab(page, 'Docker');
  const list = page.locator('#panel .card', { hasText: '容器（3）' });
  await expect(list).toBeVisible();
  await list.locator('.ctr-row', { hasText: 'mysql' }).locator('button.danger').click();
  await expect(page.locator('#panel .card', { hasText: '容器（2）' })).toBeVisible();
  const form = page.locator('#panel .ctr-new');
  await form.locator('.field', { hasText: '名稱' }).locator('input').fill('db');
  await form.locator('.field', { hasText: '名稱' }).locator('input').press('Enter');
  await form.locator('.field', { hasText: '映像檔' }).locator('select').selectOption('mysql');
  await page.locator('#panel button', { hasText: '建立並啟動' }).click();
  await expect(page.locator('#toasts')).toContainText('已建立容器 db');
  await expect(page.locator('#panel .ctr-row', { hasText: 'mysql' })).toContainText('沒有發佈連接埠');
  expect(await scan(page, '#panel', '容器・Docker 分頁')).toEqual([]);
  await page.screenshot({ path: info.outputPath('docker-tab.png') });
  const db = await page.evaluate(() => window.linkup.state.devices.dk.docker.containers.find((c) => c.name === 'db'));
  expect(db.state).toBe('running');
  expect(db.publish).toEqual([]);
});

test('HTTPS：curl 的憑證錯誤、-k 與 -v、換憑證、匯入根憑證、打開自動校時', async ({ page }, info) => {
  await boot(page);
  await open(page, 'l74');
  await clickDevice(page, 'pc1');
  await tab(page, '終端機');
  let o = await outOf(page, 'curl https://intranet.corp.local');
  expect(o).toContain('curl: (60) SSL certificate problem: certificate has expired');
  o = await outOf(page, 'curl -v https://portal.corp.local');
  expect(o).toContain('*  subjectAltName: DNS:intranet.corp.local');
  expect(o).toContain('*  issuer: CN=Corp Root CA');
  o = await outOf(page, 'curl -k https://intranet.corp.local');
  expect(o).toContain('HTTP/1.1 200 OK');
  expect(o).toContain('-k：略過憑證檢查');
  o = await outOf(page, 'curl http://intranet.corp.local');
  expect(o).toContain('HTTP/1.1 301 Moved Permanently');
  o = await outOf(page, 'curl intranet.corp.local:443');
  expect(o).toContain('The plain HTTP request was sent to HTTPS port');
  expect(await scan(page, '#panel', 'HTTPS・PC-1 終端機')).toEqual([]);
  // Web-Portal：申請新的憑證，SAN 列兩個名稱
  await clickDevice(page, 'web');
  await tab(page, '網站');
  await expect(page.locator('#panel .card', { hasText: '目前的憑證' })).toContainText('已過期');
  const san = page.locator('#panel .field', { hasText: '主體別名 (SAN)' }).locator('input');
  await san.fill('intranet.corp.local, portal.corp.local');
  await san.press('Enter');
  await page.locator('#panel button', { hasText: '產生 CSR、簽發並安裝' }).click();
  await expect(page.locator('#toasts')).toContainText('Corp Root CA 已簽發並安裝');
  await expect(page.locator('#panel .card', { hasText: '目前的憑證' })).toContainText(/還有 36\d 天/);
  expect(await scan(page, '#panel', 'HTTPS・網站分頁')).toEqual([]);
  await page.screenshot({ path: info.outputPath('web-tab.png') });
  // 公開 CA 不簽內部名稱
  await page.locator('#panel .field', { hasText: '交給哪個 CA 簽發' }).locator('select').selectOption({ index: 1 });
  await page.locator('#panel button', { hasText: '產生 CSR、簽發並安裝' }).click();
  await expect(page.locator('#toasts')).toContainText('公開 CA 不會簽發內部網域');
  // PC-1 兩個網址都好了
  await clickDevice(page, 'pc1');
  await tab(page, '終端機');
  o = await outOf(page, 'curl https://portal.corp.local');
  expect(o).toContain('HTTP/1.1 200 OK');
  expect(o).toContain('<title>員工入口網站</title>');
  // 新同事的筆電：不信任 Corp Root CA，用 certutil 匯入
  await clickDevice(page, 'byod');
  await tab(page, '終端機');
  o = await outOf(page, 'curl https://intranet.corp.local');
  expect(o).toContain('unable to get local issuer certificate');
  o = await outOf(page, 'certutil -addstore root corp-root-ca.cer');
  expect(o).toContain('CertUtil: -addstore 命令已順利完成。');
  o = await outOf(page, 'curl https://intranet.corp.local');
  expect(o).toContain('HTTP/1.1 200 OK');
  // 會議室電腦：時間在 2024 年；在網路設定分頁打開自動校時
  await clickDevice(page, 'meet');
  await tab(page, '終端機');
  o = await outOf(page, 'date');
  expect(o).toMatch(/^2024-/m);
  o = await outOf(page, 'curl https://portal.corp.local');
  expect(o).toContain('certificate is not yet valid');
  o = await outOf(page, 'w32tm /resync');
  expect(o).toContain('0x80070426');
  await tab(page, '網路設定');
  const tls = page.locator('#panel .card', { hasText: '憑證與時間' });
  await tls.scrollIntoViewIfNeeded();
  await expect(tls).toContainText('自動校時關著');
  expect(await scan(page, '#panel', 'HTTPS・會議室電腦的網路設定')).toEqual([]);
  await page.screenshot({ path: info.outputPath('client-tls.png') });
  await tls.locator('label.switch', { hasText: '自動設定時間' }).click();
  await expect(page.locator('#panel .card', { hasText: '憑證與時間' })).not.toContainText('自動校時關著');
  await tab(page, '終端機');
  o = await outOf(page, 'curl https://portal.corp.local');
  expect(o).toContain('HTTP/1.1 200 OK');
  // 按「測試」：五個目標全部通過（空白鍵快轉）
  await page.locator('#mission .m-foot .btn').click();
  await page.waitForFunction(() => window.linkup.running);
  await page.keyboard.press('Space');
  await expect(page.locator('#modal-root .dialog')).toContainText('任務完成', { timeout: 30000 });
});
