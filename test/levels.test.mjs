// 自動驗證：每個關卡「初始狀態不會過關」且「套用參考解法後全部目標通過」
import { LEVELS } from '../src/levels/index.js';
import { recompute as recomputeNow, settle, advance, pendingOf, evaluate, transact } from '../src/engine/sim.js';

// 引擎有模擬時鐘：改完設定之後，STP、OSPF、VRRP 都需要時間收斂。
// 測試裡的 recompute 一律「等到網路穩定」再往下；要測計時本身的地方才用 recomputeNow / advance。
const recompute = (s) => settle(s);
const fmtIpT = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
import { cloneState } from '../src/engine/model.js';
import { parseIp } from '../src/engine/ip.js';

let failed = 0;
const fail = (msg) => { failed++; console.log('  ✘ ' + msg); };

for (const lv of LEVELS) {
  console.log(`\n${lv.id}  ${lv.title} — ${lv.subtitle}`);
  const s = lv.setup();
  recompute(s);
  const before = evaluate(s, lv.objectives);
  const passBefore = before.filter((r) => r.pass).length;
  if (passBefore === before.length) fail('初始狀態就已經全部通過');
  console.log(`  初始：${passBefore}/${before.length} 通過`);

  lv.solve(s);
  recompute(s);
  const after = evaluate(s, lv.objectives);
  after.forEach((r, i) => {
    if (!r.pass) {
      fail(`解法後仍未通過：${lv.objectives[i].label} — ${r.reason || '(預期失敗但成功了)'}`);
      for (const l of r.log) console.log(`      [${l.dev}] ${l.text}`);
    }
  });
  console.log(`  解法：${after.filter((r) => r.pass).length}/${after.length} 通過`);

  // 序列化後再讀回，結果必須一致（存檔 / 讀檔）
  const s2 = cloneState(s);
  recompute(s2);
  const again = evaluate(s2, lv.objectives);
  if (again.some((r) => !r.pass)) fail('存檔後重新載入，結果不一致');
}

// ── 幾個負面案例：確定引擎真的會擋 ──
console.log('\n負面案例');
{
  const lv = LEVELS.find((l) => l.id === 'l05');
  const s = lv.setup(); lv.solve(s);
  s.devices.rt.ifaces[0].nat = false;
  recompute(s);
  const r = transact(s, 'pc-1', { proto: 'icmp', dst: parseIp('8.8.8.8') });
  if (r.ok) fail('關閉 NAT 後私有 IP 仍可上網'); else console.log('  ✔ 沒有 NAT → ' + r.reason);
}
{
  const lv = LEVELS.find((l) => l.id === 'l10');
  const s = lv.setup(); lv.solve(s);
  s.devices.hq.routes = [];
  recompute(s);
  const r = transact(s, 'br-pc', { proto: 'icmp', dst: parseIp('10.1.0.10') });
  if (r.ok || r.phase !== 'reply') fail('缺少回程路由卻沒有在回程失敗'); else console.log('  ✔ 缺回程路由 → ' + r.reason);
}
{
  const lv = LEVELS.find((l) => l.id === 'l07');
  const s = lv.setup(); lv.solve(s);
  s.devices.sw2.sw.ports['Gi0/9'].allowed = '10';
  recompute(s);
  const a = transact(s, 'pc-s1', { proto: 'icmp', dst: parseIp('192.168.10.12') });
  const b = transact(s, 'pc-r1', { proto: 'icmp', dst: parseIp('192.168.20.12') });
  if (!a.ok || b.ok) fail('Trunk allowed VLAN 過濾不正確'); else console.log('  ✔ Trunk 只允許 VLAN 10 → VLAN 20 不通：' + b.reason);
}
{
  const lv = LEVELS.find((l) => l.id === 'l04');
  const s = lv.setup(); lv.solve(s);
  s.devices.rt.ifaces[0].pass = 'wrong';
  recompute(s);
  const r = transact(s, 'pc-1', { proto: 'icmp', dst: parseIp('8.8.8.8') });
  if (r.ok) fail('PPPoE 密碼錯誤仍可上網'); else console.log('  ✔ PPPoE 密碼錯 → ' + r.reason);
}
{
  const lv = LEVELS.find((l) => l.id === 'l12');
  const s = lv.setup(); lv.solve(s);
  s.down = { spine1: true, spine2: true };
  recompute(s);
  const r = transact(s, 'web-1', { proto: 'tcp', dst: parseIp('10.1.20.11'), dport: 3306 });
  if (r.ok) fail('兩台 Spine 都斷線仍可連通'); else console.log('  ✔ 兩台 Spine 都故障 → ' + r.reason);
}

// ── 新機制的負面案例 ──
const solved = (id, tweak) => {
  const lv = LEVELS.find((l) => l.id === id);
  const s = lv.setup(); lv.solve(s);
  if (tweak) tweak(s);
  recompute(s);
  return { s, res: evaluate(s, lv.objectives), lv };
};
const expectFail = (title, r, idx, must = '') => {
  const x = r.res[idx];
  if (x.pass || (must && !String(x.reason).includes(must))) fail(`${title}：應該失敗${must ? `且原因包含「${must}」` : ''}，實際 pass=${x.pass} reason=${x.reason}`);
  else console.log(`  ✔ ${title} → ${x.reason}`);
};
expectFail('純 WPA3 時舊印表機連不上', solved('l13', (s) => { s.devices.rt.wifi.ssids[0].sec = 'wpa3'; }), 2, '不支援');
expectFail('Wi-Fi 密碼錯誤', solved('l13', (s) => { s.devices.ph.ifaces[0].wifi.pass = 'wrong-password'; }), 0, '密碼錯誤');
expectFail('AP 接在沒有 PoE 的埠', solved('l14', (s) => { s.cables.find((c) => c.a.dev === 'ap1').b.port = 'Gi0/10'; }), 0, '沒有電');
expectFail('兩台 AP 同頻道', solved('l14', (s) => { s.devices.ap2.wifi.ch24 = 3; }), 4, '重疊');
expectFail('AP 上行不是 Trunk 時訪客拿不到 IP', solved('l15', (s) => { s.devices.sw.sw.ports['Gi0/1'].mode = 'access'; }), 1);
expectFail('沒開用戶端隔離', solved('l15', (s) => { s.devices.ap.wifi.ssids[1].isolate = false; }), 4);
expectFail('Snooping 沒有信任埠', solved('l16', (s) => { s.devices.sw.sw.ports['Gi0/10'].trust = false; }), 0, 'Snooping');
expectFail('Port Security 用 shutdown 會連 PC-2 一起斷線', solved('l17', (s) => { s.devices.sw.sw.ports['Gi0/3'].ps.mode = 'shutdown'; }), 1);
expectFail('ACL 少了最後的 permit any', solved('l18', (s) => { s.devices.rt.ifaces[2].aclOut.pop(); }), 0, '隱含拒絕');
expectFail('ACL 順序錯誤（permit any 放最前面）', solved('l18', (s) => { const a = s.devices.rt.ifaces[2].aclOut; a.unshift(a.pop()); }), 3);
expectFail('管理來源沒有限制', solved('l19', (s) => { s.devices.rt.mgmt.allow = ''; }), 3);
expectFail('VPN 的 PSK 不一致', solved('l20', (s) => { s.devices.br.vpns[0].psk = 'oops'; }), 0, 'PSK');
expectFail('VPN 加密提案不一致', solved('l20', (s) => { s.devices.br.vpns[0].dh = '2'; }), 0, '提案');
expectFail('VPN 少了 VPN → internal 的政策', solved('l20', (s) => { s.devices.br.policies.pop(); }), 1, '政策');
expectFail('遠端 VPN 密碼錯誤', solved('l21', (s) => { s.devices.nb.vpnClient.pass = 'nope'; }), 0);
expectFail('遠端 VPN 政策太寬（放行全部）', solved('l21', (s) => { Object.assign(s.devices.hq.policies[1], { dst: 'any', service: 'ALL' }); }), 1);
expectFail('備援線路沒開 NAT', solved('l22', (s) => { s.devices.rt.ifaces[1].nat = false; }), 2, 'NAT');
expectFail('STP 關閉造成廣播風暴', solved('l23', (s) => { s.devices['sw-a'].sw.stp.on = false; }), 0, '廣播風暴');
expectFail('沒有指定根橋優先權', solved('l23', (s) => { s.devices['sw-c'].sw.stp.prio = 32768; s.devices['sw-b'].sw.stp.prio = 4096; }), 2, '根橋');
expectFail('LACP 兩端都 passive', solved('l24', (s) => { for (const p of ['Gi0/9', 'Gi0/10']) s.devices['sw-a'].sw.ports[p].lagMode = 'passive'; }), 0);
expectFail('PC 的閘道仍指向實體 IP', solved('l25', (s) => { s.devices['pc-1'].ifaces[0].gateway = '10.0.10.2'; }), 1);
expectFail('DHCP 伺服器沒有設閘道', solved('l26', (s) => { s.devices.dhcp.ifaces[0].gateway = ''; }), 0, 'Relay');
expectFail('OSPF 沒調 Cost 會走微波', solved('l27', (s) => { for (const id of ['r-tpe', 'r-khh']) s.devices[id].ifaces[1].ospfCost = ''; }), 0, '沒有經過');
expectFail('VLSM 遮罩太大', solved('l28', (s) => { Object.assign(s.devices.rt.ifaces[2], { mask: '255.255.255.192' }); }), 0);
expectFail('沒有靜態 NAT 時外部連不進來', solved('l29', (s) => { s.devices.rt.staticNat = []; }), 0);
expectFail('800 公尺用多模光纖', solved('l30', (s) => { s.cables.find((c) => c.kind === 'smf').kind = 'mmf'; }), 0, '公尺');
expectFail('倉庫用單模光纖（太貴）', solved('l30', (s) => { s.cables.find((c) => c.kind === 'mmf').kind = 'smf'; }), 2, '多模');
expectFail('DAI 啟用但上行埠不是信任埠', solved('l31', (s) => { s.devices.sw.sw.ports['Gi0/10'].trust = false; }), 1);
expectFail('沒有 DAI 時封包被送到冒牌閘道', solved('l31', (s) => { s.devices.sw.sw.dai.on = false; }), 1, '不是路由器');
expectFail('沒有 BPDU Guard 時根橋被搶走', solved('l32', (s) => { s.devices['sw-a'].sw.ports['Gi0/5'].bpduguard = false; }), 1, '搶走');
expectFail('RADIUS 共用密鑰不一致', solved('l33', (s) => { s.devices.sw.radius.secret = 'wrong'; }), 0, '802.1X');
expectFail('802.1X 帳號密碼錯誤', solved('l33', (s) => { s.devices.nb.ifaces.find((i) => i.bind.t === 'wlan').wifi.pass = 'nope'; }), 2);
expectFail('RADIUS 伺服器的埠也開了 802.1X', solved('l33', (s) => { s.devices.sw.sw.ports['Gi0/3'].dot1x = true; }), 0);
expectFail('沒有啟用 ipv6 unicast-routing', solved('l34', (s) => { s.devices.rt.v6routing = false; }), 2);
expectFail('IPv6 缺少回程路由', solved('l35', (s) => { s.devices.r2.routes6 = []; }), 1, '回程');
expectFail('管理密碼仍是預設值', solved('l19', (s) => { s.devices.rt.mgmt.pass = 'admin'; }), 5, '密碼');
{
  // STP：三角形中應該剛好有一個埠被封鎖，而且不在根橋上
  const { s } = solved('l23');
  const blocked = ['sw-c', 'sw-a', 'sw-b'].map((id) => [id, s.devices[id].rt.stp.blocked.size]);
  if (blocked.reduce((n, x) => n + x[1], 0) !== 1 || blocked[0][1] !== 0) fail('STP 封鎖的埠不正確：' + JSON.stringify(blocked));
  else console.log('  ✔ STP 剛好封鎖一個非根橋的埠：' + JSON.stringify(blocked));
}

// ── 故障排除關卡：每一個故障都必須修好 ──
console.log('\n故障排除關卡');
expectFail('10-1 位址池仍然從 .10 開始', solved('l36', (s) => { s.devices.rt.ifaces[1].dhcp.start = '192.168.1.10'; }), 0, '都在用');
expectFail('10-1 沒有保留位址', solved('l36', (s) => { s.devices.rt.ifaces[1].dhcp.reserved = []; }), 2, '不是 192.168.1.50');
expectFail('10-1 筆電還是家裡的固定 IP', solved('l36', (s) => { s.devices.nb.ifaces[0].mode = 'static'; }), 3);
expectFail('10-2 連接埠還是 shutdown', solved('l37', (s) => { s.devices.sw2.sw.ports['Gi0/1'].shut = true; }), 0, 'shutdown');
expectFail('10-2 Trunk 允許清單少了 VLAN 20', solved('l37', (s) => { s.devices.sw2.sw.ports['Gi0/9'].allowed = '10'; }), 1);
expectFail('10-2 研發的埠還在 VLAN 10', solved('l37', (s) => { s.devices.sw2.sw.ports['Gi0/2'].vlan = 10; }), 1);
expectFail('10-2 Native VLAN 不一致', solved('l37', (s) => { s.devices.sw2.sw.ports['Gi0/9'].native = 99; }), 2, 'Native VLAN');
expectFail('10-3 分公司 PC 的閘道錯誤', solved('l38', (s) => { s.devices['br-pc'].ifaces[0].gateway = '10.2.0.254'; }), 0);
expectFail('10-3 回程路由打錯網段', solved('l38', (s) => { s.devices.hq.routes[0].dst = '10.3.0.0'; }), 0, '回程');
expectFail('10-3 對外介面沒有 NAT', solved('l38', (s) => { s.devices.hq.ifaces[0].nat = false; }), 2, '私有 IP');
expectFail('10-3 總公司 PC 的 DNS 指向路由器', solved('l38', (s) => { s.devices['hq-pc'].ifaces[0].dns = '10.1.0.1'; }), 2, 'DNS');
{
  const r = solved('l38', (s) => { s.devices.hq.ifaces[2].aclIn = [{ action: 'permit', proto: 'icmp', src: 'any', dst: 'any', port: '' }]; });
  if (!r.res[0].pass || r.res[1].pass || !/ACL/.test(r.res[1].reason)) fail('10-3 只放行 ICMP 的 ACL：應該 ping 得到但 HTTPS 被擋');
  else console.log('  ✔ 10-3 只放行 ICMP 的 ACL → ping 通、HTTPS 被擋：' + r.res[1].reason);
}

expectFail('10-4 上行埠仍然寫死成 100 / full', solved('l39', (s) => { Object.assign(s.devices.core.sw.ports['Gi0/9'], { speed: '100', duplex: 'full' }); }), 1, '雙工不一致');
expectFail('10-4 剪輯 PC 的埠仍然寫死', solved('l39', (s) => { Object.assign(s.devices.acc.sw.ports['Gi0/3'], { speed: '100', duplex: 'full' }); }), 2, '雙工不一致');
{
  const lv = LEVELS.find((l) => l.id === 'l39');
  const s = lv.setup();
  Object.assign(s.devices.core.sw.ports['Gi0/9'], { speed: '', duplex: '' });
  Object.assign(s.devices.acc.sw.ports['Gi0/3'], { speed: '', duplex: '' });
  recompute(s);
  const res = evaluate(s, lv.objectives);
  if (res[3].pass || !/半雙工/.test(res[3].reason) || !res[1].pass || !res[2].pass) fail('10-4 Hub 還在：設計 PC 應該只有幾 Mbps');
  else console.log('  ✔ 10-4 Hub 還在 → ' + res[3].reason);
  const fresh = lv.setup();
  recompute(fresh);
  const before = evaluate(fresh, lv.objectives);
  if (!before[0].pass || before.slice(1).some((r) => r.pass)) fail('10-4 一開始應該 ping 得到、但三台電腦都很慢');
  else console.log(`  ✔ 10-4 一開始 ping 是通的，但只有 ${before[1].speed.mbps} / ${before[2].speed.mbps} / ${before[3].speed.mbps} Mbps`);
}

// ── 接近現實的行為：ARP、Hub 泛洪、DHCP 四步驟、保留位址、IP 衝突、連線紀錄 ──
console.log('\n真實行為');
{
  const { dhcpTrace, sessionLog, hitsOf, arpRows } = await import('../src/engine/sim.js');
  const { makeState, makeDevice, linkInfo } = await import('../src/engine/model.js');
  const { link, setIp, ifc } = await import('../src/levels/util.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  {
    const { s } = solved('l01');
    s.dyn.arp = {}; // 清空剛才測試留下的 ARP 快取
    const ip = parseIp('192.168.1.20');
    const a = transact(s, 'pc-a', { proto: 'icmp', dst: ip });
    const b = transact(s, 'pc-a', { proto: 'icmp', dst: ip });
    ok(a.ok && a.hops.some((h) => h.wave) && a.log.some((l) => l.kind === 'arp'), '第一個封包會先送出 ARP 廣播');
    ok(b.ok && !b.hops.some((h) => h.wave) && !b.log.some((l) => l.kind === 'arp'), 'ARP 快取：第二個封包不再廣播');
    ok(arpRows(s, s.devices['pc-a']).some((r) => r.ip === ip) && arpRows(s, s.devices['pc-b']).length === 1, '兩端都記下了對方的 MAC');
    ok(a.log.some((l) => l.frame && l.frame.smac === s.devices['pc-a'].ifaces[0].rt.mac && l.frame.ttl === 64), '追蹤紀錄附上訊框標頭（MAC / IP / TTL）');
    advance(s, 100);
    ok(arpRows(s, s.devices['pc-a']).length === 1 && arpRows(s, s.devices['pc-a'])[0].age === 100, 'ARP 項目會保留下來，而且記得自己多久沒被用到');
    advance(s, 30);
    const c = transact(s, 'pc-a', { proto: 'icmp', dst: ip });
    ok(c.ok && c.hops.some((h) => h.wave), '個人電腦的 ARP 項目超過兩分鐘沒用到就過期，下一個封包要重新廣播');
  }
  {
    const s = makeState([makeDevice('hub4', 'hub', { name: 'Hub', pos: [0, 0] }),
      ...['a', 'b', 'c'].map((x, n) => makeDevice('pc', 'pc-' + x, { name: 'PC-' + x.toUpperCase(), pos: [n * 4 - 4, 3] }))]);
    link(s, 'pc-a:eth0', 'hub:1'); link(s, 'pc-b:eth0', 'hub:2'); link(s, 'pc-c:eth0', 'hub:3');
    setIp(s, 'pc-a', '192.168.1.10'); setIp(s, 'pc-b', '192.168.1.20'); setIp(s, 'pc-c', '192.168.1.30');
    recompute(s);
    const r = transact(s, 'pc-a', { proto: 'icmp', dst: parseIp('192.168.1.20') });
    const leak = r.hops.flatMap((h) => h.leak || []);
    ok(r.ok && leak.some((x) => x.to === 'pc-c') && !leak.some((x) => x.to === 'pc-b'), 'Hub 把訊框複製給不相干的 PC-C');
    const li = linkInfo(s, 'pc-a', 'eth0');
    ok(li.half && li.speed === 10, '接到 Hub 的連線降為 10 Mbps 半雙工');
    ok(!s.devices['pc-b'].ifaces[0].rt.conflict, '沒有重複的 IP 時不會誤報衝突');
    setIp(s, 'pc-c', '192.168.1.20');
    recompute(s);
    ok(s.devices['pc-b'].ifaces[0].rt.conflict === 'pc-c' && s.devices['pc-c'].ifaces[0].rt.conflict === 'pc-b', '偵測到 IP 位址衝突');
  }
  {
    const { s } = solved('l03');
    const t = dhcpTrace(s, 'pc-1');
    const steps = t.log.map((l) => l.text.match(/^DHCP (\w+)/)?.[1]).filter(Boolean);
    ok(t.ok && steps.join() === 'Discover,Offer,Request,Ack' && t.hops.filter((h) => h.wave).length === 2, 'DHCP 依序走完 Discover → Offer → Request → Ack');
    const mac = s.devices['pc-1'].ifaces[0].rt.mac;
    ifc(s, 'rt', 'lan').dhcp.reserved = [{ mac: mac.toUpperCase(), ip: '192.168.50.150' }];
    recompute(s);
    const got = (id) => s.devices[id].ifaces.find((i) => i.rt.src === 'dhcp')?.rt.ip;
    ok(got('pc-1') === parseIp('192.168.50.150') && got('nb') != null && got('nb') !== got('pc-1'), 'DHCP 保留位址：指定的 MAC 拿到固定的 IP');
    recompute(s);
    ok(got('pc-1') === parseIp('192.168.50.150'), '保留位址在重新計算後維持不變');
    s.devices['pc-1'].ifaces[0].mode = 'static';
    recompute(s);
    ok(!dhcpTrace(s, 'pc-1').ok, '沒有使用 DHCP 的設備無法 renew');
  }
  {
    const { s } = solved('l09');
    const fw = s.devices.fw, log = sessionLog(fw);
    ok(log.some((e) => e.act === 'allow' && e.rule > 0) && log.some((e) => e.act === 'deny') && log.some((e) => e.act === 'snat') && log.some((e) => e.act === 'dnat'),
      '防火牆記下放行、拒絕與 NAT 轉換');
    ok(fw.policies.some((p) => hitsOf(p) > 0), '政策有命中次數');
  }
  {
    const { s } = solved('l20');
    const all = Object.values(s.devices).flatMap((d) => sessionLog(d));
    ok(all.length > 0 && !all.some((e) => e.dport === 500 || e.dport === 4500), '引擎內部的 IKE 協商不會混進連線紀錄');
  }
}

// ── CLI：設定指令 ──
console.log('\nCLI 設定指令');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { CATALOG, makeDevice } = await import('../src/engine/model.js');
  const { link, setIp } = await import('../src/levels/util.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const hasCli = (d) => !d.locked && CATALOG[d.model].vendor === 'Cisco' && ['router', 'mswitch', 'l3switch'].includes(d.kind);
  /** 在某台設備上依序輸入指令，回傳所有 % 開頭的錯誤訊息 */
  const type = (s, id, lines) => {
    const sess = iosSession(() => s.devices[id], () => s);
    const errs = [];
    for (const l of lines) for (const o of sess.exec(l).out) if (o.startsWith('%') && !o.includes('Creating vlan')) errs.push(`${l} → ${o}`);
    return errs;
  };
  // 比對時略過註解與分隔線
  const keep = (l) => !/^ ?!/.test(l) && l !== '' && !/^Building/.test(l);

  // 1. 把每一關解答的 running-config 整份貼到一台全新的同型號設備上，應該得到一模一樣的設定
  let n = 0, bad = 0;
  for (const lv of LEVELS) {
    const { s } = solved(lv.id);
    for (const d of Object.values(s.devices).filter(hasCli)) {
      const want = runningConfig(s, d);
      const s2 = cloneState(s);
      s2.devices[d.id] = makeDevice(d.model, d.id, { name: d.name, pos: d.pos });
      recompute(s2);
      const errs = type(s2, d.id, ['configure terminal', ...want, 'end']);
      recompute(s2);
      const got = runningConfig(s2, s2.devices[d.id]);
      const a = want.filter(keep), b = got.filter(keep);
      n++;
      // 貼回去之後不只文字要一樣，網路也要照常運作（密碼、金鑰都要還原得回來）
      const broken = evaluate(s2, lv.objectives).filter((r) => !r.pass);
      if (broken.length) { bad++; fail(`${lv.id} ${d.name}：貼回 running-config 之後關卡不再通過 — ${broken[0].reason}`); }
      if (errs.length || a.join('\n') !== b.join('\n')) {
        bad++;
        fail(`${lv.id} ${d.name}：貼回 running-config 之後設定不一致`);
        for (const e of errs.slice(0, 4)) console.log('      錯誤 ' + e);
        const miss = a.filter((x) => !b.includes(x)).slice(0, 4), extra = b.filter((x) => !a.includes(x)).slice(0, 4);
        for (const x of miss) console.log('      少了 ' + x);
        for (const x of extra) console.log('      多了 ' + x);
      }
    }
  }
  if (!bad) console.log(`  ✔ ${n} 台 Cisco 設備的 running-config 貼回空白設備後完全一致`);

  // 2. 只用指令通關（含縮寫）
  const cliSolve = (id, title, fn) => {
    const lv = LEVELS.find((l) => l.id === id);
    const s = lv.setup();
    recompute(s);
    const errs = fn(s);
    recompute(s);
    const res = evaluate(s, lv.objectives);
    if (errs.length || res.some((r) => !r.pass)) {
      fail(`${title}：${errs[0] || res.find((r) => !r.pass).reason}`);
    } else console.log('  ✔ ' + title);
  };
  cliSolve('l07', '只用指令完成 2-3（VLAN 與 Trunk）', (s) => {
    link(s, 'sw1:Gi0/9', 'sw2:Gi0/9');
    return [
      ...type(s, 'sw2', ['conf t', 'vlan 10', 'name Sales', 'vlan 20', 'name RnD', 'int gi0/1', 'sw mo acc', 'sw acc vl 10', 'int gi0/2', 'switchport access vlan 20',
        'interface GigabitEthernet0/9', 'switchport mode trunk', 'end', 'wr']),
      ...type(s, 'sw1', ['configure terminal', 'interface g0/9', 'switchport mode trunk', 'end']),
    ];
  });
  cliSolve('l08', '只用指令完成 2-4（子介面與 DHCP 位址池）', (s) => {
    setIp(s, 'fs', '192.168.30.10', '255.255.255.0', '192.168.30.1');
    return [
      ...type(s, 'sw', ['conf t', 'int gi0/9', 'switchport mode trunk']),
      ...type(s, 'rt', ['conf t',
        'ip dhcp excluded-address 192.168.10.1 192.168.10.99', 'ip dhcp excluded-address 192.168.20.1 192.168.20.99',
        'ip dhcp pool SALES', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1',
        'ip dhcp pool RND', 'network 192.168.20.0 255.255.255.0', 'default-router 192.168.20.1',
        'int gi0/0/1.10', 'encapsulation dot1q 10', 'ip address 192.168.10.1 255.255.255.0',
        'int gi0/0/1.20', 'encap dot 20', 'ip add 192.168.20.1 255.255.255.0',
        'int gi0/0/1.30', 'encap dot 30', 'ip add 192.168.30.1 255.255.255.0', 'end']),
    ];
  });
  cliSolve('l10', '只用指令完成 3-2（靜態路由）', (s) => [
    ...type(s, 'hq', ['conf t', 'int gi0/0/2', 'ip address 172.16.0.1 255.255.255.252', 'no shut', 'exit', 'ip route 10.2.0.0 255.255.255.0 172.16.0.2']),
    ...type(s, 'br', ['conf t', 'int g0/0/0', 'ip add 172.16.0.2 255.255.255.252', 'ip route 0.0.0.0 0.0.0.0 172.16.0.1']),
  ]);
  cliSolve('l18', '只用指令完成 ACL 關卡（具名 ACL 與 access-group）', (s) => type(s, 'rt', ['conf t',
    'ip access-list extended SERVERS', 'deny ip 10.0.20.0 0.0.0.255 10.0.30.0 0.0.0.255', 'permit tcp host 10.0.10.5 host 10.0.30.10 eq 22',
    'deny tcp any host 10.0.30.10 eq ssh', 'permit ip any any', 'int gi0/0/2', 'ip access-group SERVERS out', 'end']));

  cliSolve('l37', '只用指令完成 10-2（no shutdown、VLAN、Trunk 允許清單與 Native VLAN）', (s) => type(s, 'sw2', ['conf t',
    'int gi0/1', 'no shut', 'int gi0/2', 'sw acc vlan 20', 'int gi0/9', 'switchport trunk allowed vlan 10,20', 'switchport trunk native vlan 1', 'end']));
  cliSolve('l38', '用指令修好 10-3 的路由器（路由、NAT、ACL）', (s) => {
    s.devices['br-pc'].ifaces[0].gateway = '10.2.0.1';
    s.devices['hq-pc'].ifaces[0].dns = '8.8.8.8';
    return type(s, 'hq', ['conf t', 'no ip route 10.3.0.0 255.255.255.0 172.16.0.2', 'ip route 10.2.0.0 255.255.255.0 172.16.0.2',
      'int gi0/0/0', 'ip nat outside', 'exit', 'ip nat inside source list 1 interface Gi0/0/0 overload',
      'int gi0/0/2', 'no ip access-group GI0_0_2_IN in', 'end']);
  });

  // Root Guard：私接的交換器想搶根橋時，埠被擋下、根橋不變
  {
    const withGuard = solved('l32', (s) => { Object.assign(s.devices['sw-a'].sw.ports['Gi0/5'], { bpduguard: false, rootguard: true }); });
    const g = withGuard.s.devices['sw-a'];
    ok(g.rt.err['Gi0/5'] === 'root' && withGuard.res[0].pass && withGuard.res[1].pass && withGuard.res[2].pass, 'Root Guard 擋下想搶根橋的交換器（根橋不變、不明筆電連不進來）');
    const viaCli = solved('l32', (s) => { s.devices['sw-a'].sw.ports['Gi0/5'].bpduguard = false; type(s, 'sw-a', ['conf t', 'int gi0/5', 'spanning-tree guard root']); });
    ok(viaCli.res[1].pass && runningConfig(viaCli.s, viaCli.s.devices['sw-a']).includes(' spanning-tree guard root'), '用指令啟用 Root Guard，running-config 看得到');
    const onRoot = solved('l23', (s) => { for (const pc of Object.values(s.devices['sw-c'].sw.ports)) pc.rootguard = true; });
    ok(onRoot.res.every((r) => r.pass) && !Object.keys(onRoot.s.devices['sw-c'].rt.err).length, '根橋自己的下行埠啟用 Root Guard 不影響正常運作（含斷線演練）');
    const wrong = solved('l23', (s) => { for (const pc of Object.values(s.devices['sw-a'].sw.ports)) pc.rootguard = true; });
    ok(Object.values(wrong.s.devices['sw-a'].rt.err).includes('root'), '把 Root Guard 開在朝向根橋的埠是錯誤設定：埠會被擋下');
  }
  // Tab 補齊
  {
    const { s } = solved('l10');
    const sess = iosSession(() => s.devices.hq, () => s);
    const shows = ['show ip route', 'show ip interface brief', 'show running-config'];
    ok(sess.complete('conf', shows).line === 'configure ' && sess.complete('sh ip ro', shows).line === 'sh ip route ', '補齊：只有一個候選時直接補完');
    const many = sess.complete('show ip ', shows);
    ok(many.line === null && many.options.join() === 'interface,route', '補齊：有多個候選時列出來');
    sess.exec('conf t'); sess.exec('int gi0/0/1');
    ok(sess.complete('ip na').line === 'ip nat ' && sess.complete('ip nat ').options.join() === 'inside,outside,translation' && sess.complete('do sh', shows).line === 'do show ', '補齊：介面模式與 do show');
  }

  // 站對站 VPN：分公司換成 Cisco 路由器，整台用指令設定，和總公司的 FortiGate 互通
  {
    const { removeCable } = await import('../src/engine/model.js');
    const lv = LEVELS.find((l) => l.id === 'l20');
    const build = (natExempt) => {
      const s = lv.setup();
      for (const c of s.cables.filter((x) => x.a.dev === 'br' || x.b.dev === 'br')) removeCable(s, c.id);
      s.devices.br = makeDevice('isr4321', 'br', { name: 'Branch-RT', pos: [7, -4.5] });
      link(s, 'inet:line2', 'br:Gi0/0/0'); link(s, 'br:Gi0/0/1', 'br-sw:1');
      recompute(s);
      const errs = type(s, 'br', ['conf t',
        'int gi0/0/0', 'ip address 198.51.100.34 255.255.255.252', 'ip nat outside', 'no shut',
        'int gi0/0/1', 'ip address 10.2.0.1 255.255.255.0', 'ip nat inside',
        'ip route 0.0.0.0 0.0.0.0 198.51.100.33',
        ...(natExempt
          ? ['ip access-list extended NAT', 'deny ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.0.255', 'permit ip 10.2.0.0 0.0.0.255 any', 'ip nat inside source list NAT interface Gi0/0/0 overload']
          : ['access-list 1 permit any', 'ip nat inside source list 1 interface Gi0/0/0 overload']),
        'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14',
        'crypto isakmp key Tw!S2S#2026 address 203.0.113.18',
        'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode tunnel',
        'ip access-list extended VPN-HQ', 'permit ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.0.255',
        'crypto map CMAP 10 ipsec-isakmp', 'set peer 203.0.113.18', 'set transform-set TS', 'match address VPN-HQ',
        'int gi0/0/0', 'crypto map CMAP', 'end']);
      recompute(s);
      return { s, errs, res: evaluate(s, lv.objectives) };
    };
    const good = build(true);
    ok(!good.errs.length && good.s.devices.br.vpns[0].rt.up && good.res.every((r) => r.pass), 'Cisco 路由器用 crypto map 和 FortiGate 建立站對站 VPN，四個目標全部通過');
    ok(good.res[0].log.some((l) => l.kind === 'vpn'), '往總公司的流量確實走加密通道');
    const noExempt = build(false);
    ok(noExempt.s.devices.br.vpns[0].rt.up && !noExempt.res[0].pass && noExempt.res[0].log.some((l) => /先做 NAT/.test(l.text)) && noExempt.res[2].pass,
      '沒有設 NAT 例外：通道是 Up，但流量先被 NAT 而沒有進通道（上網不受影響）');
    const s3 = build(true).s;
    type(s3, 'br', ['conf t', 'int gi0/0/0', 'no crypto map']);
    recompute(s3);
    ok(!s3.devices.br.vpns[0].rt.up && /crypto map/.test(s3.devices.br.vpns[0].rt.why), 'crypto map 沒有套用到對外介面時通道不會建立');
    const s4 = build(true).s;
    type(s4, 'br', ['conf t', 'crypto ipsec transform-set TS esp-aes esp-sha-hmac']);
    recompute(s4);
    ok(!s4.devices.br.vpns[0].rt.up && /第二階段/.test(s4.devices.br.vpns[0].rt.why), '第二階段的 transform-set 和對端不一致時，錯誤訊息指出是第二階段');
    // 整份設定貼到另一台空白路由器，VPN 要照樣建立
    const want = runningConfig(good.s, good.s.devices.br);
    const s5 = cloneState(good.s);
    s5.devices.br = makeDevice('isr4321', 'br', { name: 'Branch-RT', pos: [7, -4.5] });
    recompute(s5);
    const e5 = type(s5, 'br', ['conf t', ...want, 'end']);
    recompute(s5);
    ok(!e5.length && runningConfig(s5, s5.devices.br).filter(keep).join('\n') === want.filter(keep).join('\n') && evaluate(s5, lv.objectives).every((r) => r.pass),
      '含 VPN 與 NAT 例外的 running-config 貼到空白路由器後，通道照樣建立');
  }

  // running-config 與 startup-config
  {
    const { saveStartup, restoreStartup, iosDirty, startupConfig } = await import('../src/engine/ios.js');
    const lv = LEVELS.find((l) => l.id === 'l10');
    const s = lv.setup();
    for (const d of Object.values(s.devices)) if (hasCli(d)) saveStartup(d);
    recompute(s);
    ok(!iosDirty(s, s.devices.hq), '剛開機時 running-config 和 startup-config 相同');
    const sess = iosSession(() => s.devices.hq, () => s);
    for (const l of ['conf t', 'int gi0/0/2', 'ip address 172.16.0.1 255.255.255.252', 'exit', 'ip route 10.2.0.0 255.255.255.0 172.16.0.2', 'end']) sess.exec(l);
    type(s, 'br', ['conf t', 'int g0/0/0', 'ip add 172.16.0.2 255.255.255.252', 'ip route 0.0.0.0 0.0.0.0 172.16.0.1', 'end', 'write memory']);
    recompute(s);
    ok(iosDirty(s, s.devices.hq) && !iosDirty(s, s.devices.br) && evaluate(s, lv.objectives).every((r) => r.pass), '改了設定但沒存檔：網路是通的，但 running-config 和 startup-config 不同');
    ok(!startupConfig(s, s.devices.hq).some((l) => l.includes('172.16.0.1')) && startupConfig(s, s.devices.br).some((l) => l.includes('172.16.0.2')), 'show startup-config 顯示的是上一次存檔的內容');
    const r1 = sess.exec('reload'), r2 = sess.exec('no'), r3 = sess.exec('');
    recompute(s);
    ok(/Save\?/.test(r1.out.join()) && /confirm/.test(r2.out.join()) && r3.reloaded && !s.devices.hq.routes.length && evaluate(s, lv.objectives).some((r) => !r.pass),
      'reload 時不存檔：HQ 的設定回到開機時的樣子，分公司連不回來');
    for (const l of ['conf t', 'int gi0/0/2', 'ip address 172.16.0.1 255.255.255.252', 'exit', 'ip route 10.2.0.0 255.255.255.0 172.16.0.2', 'end', 'copy running-config startup-config']) sess.exec(l);
    sess.exec('reload'); sess.exec('');
    recompute(s);
    ok(!iosDirty(s, s.devices.hq) && evaluate(s, lv.objectives).every((r) => r.pass), '存檔之後再 reload，設定還在');
    restoreStartup(s.devices.br);
    recompute(s);
    ok(evaluate(s, lv.objectives).every((r) => r.pass), '已經存檔的設備斷電再開機，設定不會消失');
  }

  // OSPF 的 network 敘述是持續生效的：先下 network，之後才設定 IP 的介面也會自動加入
  {
    const lv = LEVELS.find((l) => l.id === 'l10');
    const s = lv.setup();
    recompute(s);
    const errs = [
      ...type(s, 'hq', ['conf t', 'router ospf 1', 'network 172.16.0.0 0.0.0.3 area 0', 'network 10.1.0.0 0.0.0.255 area 0', 'default-information originate', 'exit',
        'int gi0/0/2', 'ip address 172.16.0.1 255.255.255.252', 'end']),
      ...type(s, 'br', ['conf t', 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'exit', 'int gi0/0/0', 'ip address 172.16.0.2 255.255.255.252', 'end']),
    ];
    recompute(s);
    const res = evaluate(s, lv.objectives);
    ok(!errs.length && res.every((r) => r.pass) && s.devices.br.rt.routes.some((r) => r.type === 'O' && r.bits === 0), `先下 network、後設 IP：OSPF 自動在新介面上啟用，分公司學到預設路由${res.find((r) => !r.pass) ? '：' + res.find((r) => !r.pass).reason : ''}`);
    const cfg = runningConfig(s, s.devices.br);
    ok(cfg.includes(' network 0.0.0.0 255.255.255.255 area 0') && cfg.filter((l) => l.startsWith(' network')).length === 1, 'running-config 照原樣保留 network 敘述');
    type(s, 'br', ['conf t', 'router ospf 1', 'no network 0.0.0.0 255.255.255.255 area 0', 'end']);
    recompute(s);
    ok(evaluate(s, lv.objectives).some((r) => !r.pass), '移除 network 敘述後 OSPF 停止，路由消失');
  }

  // 3. 錯誤處理與模式切換
  {
    const { s } = solved('l10');
    const sess = iosSession(() => s.devices.hq, () => s);
    const before = JSON.stringify(cloneState(s));
    const r1 = sess.exec('conf t'), r2 = sess.exec('ip route 10.9.0.0 255.255.0 1.2.3.4'), r3 = sess.exec('banana');
    ok(!r1.changed && r2.out[0].startsWith('%') && r3.out[0].startsWith('%') && JSON.stringify(cloneState(s)) === before, '打錯的指令會回報錯誤，而且不會改到設定');
    sess.exec('int gi0/0/2');
    ok(sess.prompt() === 'HQ-Router(config-if)#', '提示字元跟著模式改變');
    sess.exec('sh');
    recompute(s);
    ok(s.devices.hq.ifaces.find((i) => i.id === 'Gi0/0/2').shut === true && evaluate(s, LEVELS.find((l) => l.id === 'l10').objectives).some((r) => !r.pass && /shutdown|停用/.test(r.reason)),
      '介面模式的 sh 是 shutdown：專線斷掉，而且錯誤訊息指出介面被停用');
    sess.exec('no shutdown');
    sess.exec('router ospf 1');
    ok(sess.prompt() === 'HQ-Router(config-router)#', '在介面模式直接輸入全域指令會切換模式');
    const r = sess.exec('network 10.1.0.0 0.0.0.255 area 0');
    ok(r.out.join().includes('Gi0/0/') && s.devices.hq.ospfNets.length === 1 && runningConfig(s, s.devices.hq).includes(' network 10.1.0.0 0.0.0.255 area 0'), 'router ospf 的 network 會在符合的介面上啟用 OSPF');
    sess.exec('end');
    ok(sess.exec('show ip route').pass === true && sess.mode === 'exec', 'show 指令交給顯示層處理');
    s.down = { hq: true };
    recompute(s);
    const res = evaluate(s, LEVELS.find((l) => l.id === 'l10').objectives);
    ok(res.every((x) => !x.pass) && res.some((x) => /關機/.test(x.reason)), '設備關機後連線中斷，錯誤訊息指出是哪一台關機');
  }
}

// ── 模擬時鐘：STP 的連接埠狀態與 PortFast ──
{
  const { makeState, makeDevice } = await import('../src/engine/model.js');
  const { link, setIp } = await import('../src/levels/util.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const say = (cond, title) => { if (cond) console.log('  ✔ ' + title); else fail(title); };
  console.log('\n模擬時鐘');
  const s = makeState([makeDevice('c2960', 'sw', { name: 'SW' }), makeDevice('pc', 'a', { name: 'PC-A', pos: [-4, 3] }), makeDevice('pc', 'b', { name: 'PC-B', pos: [4, 3] })]);
  link(s, 'a:eth0', 'sw:Gi0/1'); link(s, 'b:eth0', 'sw:Gi0/2');
  setIp(s, 'a', '192.168.1.10'); setIp(s, 'b', '192.168.1.20');
  recomputeNow(s);
  const ping = (from, ip) => transact(s, from, { proto: 'icmp', dst: parseIp(ip) });
  say(ping('a', '192.168.1.20').ok && !pendingOf(s).length, '一開始就接好的線當作已經運作很久，不需要等待');
  // 之後才接上去的電腦：交換器的埠要先經過 listening 與 learning
  s.devices.c = makeDevice('pc', 'c', { name: 'PC-C', pos: [0, 5] });
  link(s, 'c:eth0', 'sw:Gi0/3'); setIp(s, 'c', '192.168.1.30');
  recomputeNow(s);
  const r0 = ping('c', '192.168.1.10');
  say(!r0.ok && /listening/.test(r0.reason) && /PortFast/.test(r0.reason) && pendingOf(s)[0].at === 30, `新接上的埠前 30 秒不轉送資料：${r0.reason}`);
  advance(s, 20);
  const r1 = ping('c', '192.168.1.10');
  say(!r1.ok && /learning/.test(r1.reason) && /再 10 秒/.test(r1.reason), '20 秒後進入 learning，還要 10 秒');
  advance(s, 10);
  say(ping('c', '192.168.1.10').ok && !pendingOf(s).length, '30 秒後開始轉送');
  // 換 VLAN 會讓 STP 重新走一次；開了 PortFast 就不用等
  s.devices.sw.sw.vlans.push({ id: 10, name: 'x' });
  const sess = iosSession(() => s.devices.sw, () => s);
  for (const l of ['conf t', 'int range gi0/1 - 3', 'switchport access vlan 10', 'end']) sess.exec(l);
  recomputeNow(s);
  say(!ping('c', '192.168.1.10').ok && pendingOf(s).length === 3, '把埠換到另一個 VLAN，STP 重新計時');
  for (const l of ['conf t', 'int range gi0/1 - 3', 'spanning-tree portfast', 'end']) sess.exec(l);
  recomputeNow(s);
  say(ping('c', '192.168.1.10').ok && runningConfig(s, s.devices.sw).includes(' spanning-tree portfast'), '啟用 PortFast 之後立刻開始轉送');
  // 交換器之間用 RSTP 快速協商
  s.devices.sw2 = makeDevice('c2960', 'sw2', { name: 'SW2', pos: [8, 0] });
  s.devices.sw2.sw.vlans.push({ id: 10, name: 'x' });
  s.devices.d = makeDevice('pc', 'd', { name: 'PC-D', pos: [10, 3] });
  for (const id of ['sw', 'sw2']) Object.assign(s.devices[id].sw.ports['Gi0/9'], { mode: 'trunk' });
  Object.assign(s.devices.sw2.sw.ports['Gi0/1'], { vlan: 10, portfast: true });
  link(s, 'sw:Gi0/9', 'sw2:Gi0/9'); link(s, 'd:eth0', 'sw2:Gi0/1'); setIp(s, 'd', '192.168.1.40');
  recomputeNow(s);
  const r2 = ping('d', '192.168.1.10');
  say(!r2.ok && /協商/.test(r2.reason) && pendingOf(s)[0].at - s.clock === 2, '交換器之間的新連線用 RSTP 協商，2 秒後開始轉送');
  settle(s);
  say(ping('d', '192.168.1.10').ok, 'settle 會讓時間前進到網路穩定為止');
}

// ── 模擬時鐘：DHCP 租約 ──
{
  const { dhcpRelease, dhcpRenew } = await import('../src/engine/sim.js');
  const say = (cond, title) => { if (cond) console.log('  ✔ ' + title); else fail(title); };
  const { s } = solved('l36');
  const lan = s.devices.rt.ifaces.find((i) => i.id === 'Gi0/0/1');
  lan.dhcp.lease = 3600; // 一小時
  s.leases = {}; s.dyn.hold = {}; s.dyn.lease = {};
  recomputeNow(s);
  const pc = s.devices['pc-1'].ifaces[0], pc2 = s.devices['pc-2'].ifaces[0];
  const ip0 = pc.rt.ip;
  say(pc.rt.src === 'dhcp' && pc.rt.exp === s.clock + 3600, '用戶端拿到位址時記下租約的到期時間');
  // 伺服器關機：電腦不會馬上斷線
  s.down = { rt: true };
  advance(s, 600);
  say(pc.rt.ip === ip0 && !!pc.rt.held && transact(s, 'pc-1', { proto: 'icmp', dst: parseIp('192.168.1.10') }).ok, 'DHCP 伺服器關機後，電腦沿用還沒到期的租約，區域網路內照樣能通');
  advance(s, 3001);
  say(pc.rt.src === 'apipa', '租約到期還是續不到約：電腦失去位址，退回 APIPA');
  s.down = {};
  recomputeNow(s);
  say(pc.rt.src === 'dhcp' && pc.rt.ip === ip0, '伺服器回來之後重新要到位址');
  // 過了一半的時間會自動續約
  const exp0 = pc.rt.exp;
  advance(s, 1700);
  say(pc.rt.exp === exp0, '租約還沒過一半：到期時間不變');
  advance(s, 200);
  say(pc.rt.exp === s.clock + 3600, '過了一半 (T1) 自動續約，到期時間往後延');
  // 伺服器手上還沒到期的租約不會發給別人
  pc.mode = 'static';
  Object.assign(lan.dhcp, { start: fmtIpT(ip0), end: fmtIpT(ip0) });
  recomputeNow(s);
  say(pc2.rt.ip !== ip0 && (pc2.rt.src !== 'dhcp' || !!pc2.rt.held), '位址池只剩一個位址，而它還被 PC-1 的租約占著：PC-2 要不到新的位址');
  advance(s, 3700);
  say(pc2.rt.src === 'dhcp' && pc2.rt.ip === ip0 && !pc2.rt.held, 'PC-1 的租約到期後，位址才釋出給 PC-2');
  lan.dhcp.end = fmtIpT(ip0 + 20);
  dhcpRelease(s, 'pc-2');
  recomputeNow(s);
  say(pc2.rt.ip == null && !Object.keys(s.leases['rt/Gi0/0/1'] || {}).includes('pc-2/eth0'), 'ipconfig /release 歸還位址，之後不會自動再去要');
  dhcpRenew(s, 'pc-2');
  recomputeNow(s);
  say(pc2.rt.src === 'dhcp' && pc2.rt.exp === s.clock + 3600, 'ipconfig /renew 重新取得位址');

}

// ── 模擬時鐘：VRRP 換手與 OSPF 的計時 ──
{
  const say = (cond, title) => { if (cond) console.log('  ✔ ' + title); else fail(title); };
  const { s } = solved('l25');
  const net = () => transact(s, 'pc-1', { proto: 'icmp', dst: parseIp('8.8.8.8') });
  const vr = (id) => s.devices[id].ifaces[1].rt.vrrp;
  const nb = (id, to) => s.devices[id].rt.nbrs.find((n) => n.dev === to);
  say(net().ok && vr('gw-a').state === 'master' && vr('gw-b').state === 'backup', '平常由 GW-A 當 VRRP Master');
  s.down = { 'gw-a': true };
  recomputeNow(s);
  const r0 = net();
  say(!r0.ok && vr('gw-b').state === 'backup' && vr('gw-b').wait === 3, `Master 剛斷電的前 3 秒沒有人回應虛擬 IP：${r0.reason}`);
  say(nb('gw-b', 'gw-a') && nb('gw-b', 'gw-a').state === 'dying' && !nb('edge', 'gw-a'), '直接相連的 Edge 立刻知道 GW-A 不見了；隔著交換器的 GW-B 要等 Dead timer');
  advance(s, 3);
  say(net().ok && vr('gw-b').state === 'master', '3 秒後 GW-B 接手成為 Master');
  say(pendingOf(s).some((p) => p.kind === 'ospf' && p.at - s.clock === 37), 'GW-B 的 OSPF Dead timer 還剩 37 秒');
  advance(s, 37);
  say(!nb('gw-b', 'gw-a') && !pendingOf(s).length, '40 秒後 GW-B 才把 GW-A 從鄰居清單拿掉');
  s.down = {};
  recomputeNow(s);
  say(vr('gw-a').state === 'master' && nb('gw-a', 'edge').state === 'forming' && Math.round(nb('gw-a', 'edge').left) === 40, 'GW-A 開機：VRRP 立刻搶回 Master，但 OSPF 鄰居關係要重新建立');
  const r1 = net();
  say(!r1.ok, `GW-A 搶回 Master 時還沒有學到路由，這段時間封包被丟掉（開機後立刻 preempt 的經典問題）：${r1.reason}`);
  advance(s, 40);
  say(net().ok && nb('gw-a', 'edge').state === 'full', '40 秒後鄰居進到 FULL，連線恢復');
}

// ── 速率與雙工的協商 ──
{
  const { linkInfo } = await import('../src/engine/model.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const lv = LEVELS.find((l) => l.id === 'l07');
  const mk = (a, b) => {
    const s = lv.setup(); lv.solve(s); recompute(s);
    const run = (id, lines) => { const sess = iosSession(() => s.devices[id], () => s); for (const l of ['conf t', 'int gi0/9', ...lines, 'end']) sess.exec(l); };
    run('sw1', a); run('sw2', b);
    recompute(s);
    return { s, li: linkInfo(s, 'sw1', 'Gi0/9'), res: evaluate(s, lv.objectives) };
  };
  const auto = mk([], []);
  const fixed = mk(['speed 100', 'duplex full'], []);
  const both = mk(['speed 100', 'duplex full'], ['speed 100', 'duplex full']);
  const diff = mk(['speed 100', 'duplex full'], ['speed 1000', 'duplex full']);
  const checks = [
    [auto.li.speed === 1000 && auto.li.duplex === 'full' && !auto.li.mismatch, '兩端都自動協商：1 Gbps 全雙工'],
    [fixed.li.speed === 100 && fixed.li.mismatch && fixed.li.duplex === 'full' && fixed.li.peerDuplex === 'half' && fixed.res.every((r) => r.pass), '一端寫死 100 / full、另一端自動：對端退回半雙工，形成雙工不一致（線仍然是通的）'],
    [both.li.speed === 100 && !both.li.mismatch, '兩端都寫死成一樣：100 Mbps 全雙工'],
    [!!diff.li.down && diff.res.some((r) => !r.pass && /速率設定不同/.test(r.reason)), '兩端速率寫死成不同的值：連線建立不起來，錯誤訊息指出原因'],
    [runningConfig(fixed.s, fixed.s.devices.sw1).includes(' speed 100') && runningConfig(fixed.s, fixed.s.devices.sw1).includes(' duplex full'), 'running-config 顯示手動設定的 speed 與 duplex'],
  ];
  console.log('');
  for (const [cond, title] of checks) { if (cond) console.log('  ✔ ' + title); else fail(title); }
}

// ── DHCP 發放前的衝突偵測 ──
{
  const lv = LEVELS.find((l) => l.id === 'l36');
  const s = lv.setup();
  s.leases = {}; // 沒有舊租約：印表機一直都在線上
  recompute(s);
  const ip = (id) => s.devices[id].ifaces[0].rt.ip;
  const seen = (s.rt.dhcpConflict || {})['rt/Gi0/0/1'] || [];
  if (ip('pc-1') === parseIp('192.168.1.10') || s.devices['pc-1'].ifaces[0].rt.conflict || !seen.includes(parseIp('192.168.1.10'))) fail('DHCP 伺服器應該跳過已經有人在用的 192.168.1.10');
  else console.log('\n  ✔ DHCP 發放前先確認位址沒人在用：跳過印表機的 192.168.1.10，並記錄成衝突');
  const s2 = lv.setup();
  recompute(s2);
  if (s2.devices['pc-1'].ifaces[0].rt.ip !== parseIp('192.168.1.10') || !s2.devices['pc-1'].ifaces[0].rt.conflict) fail('設備離線期間發出去的租約應該保留，回來之後才會衝突');
  else console.log('  ✔ 設備離線期間已經發出去的租約不會重新檢查：印表機回來之後就和 PC-1 衝突');
}

// ── TCP 三向交握 ──
{
  const { sessionLog } = await import('../src/engine/sim.js');
  const { s } = solved('l09');
  recompute(s);
  const before = sessionLog(s.devices.fw).length;
  const r = transact(s, 'pc-1', { proto: 'tcp', dst: parseIp('93.184.216.34'), dport: 443 });
  const flags = r.log.filter((l) => l.frame && l.frame.proto === 'tcp').map((l) => (l.frame.ack ? 'ACK' : l.frame.reply ? 'SYN-ACK' : 'SYN'));
  const seq = flags.filter((f, n) => f !== flags[n - 1]).join(' → ');
  const added = sessionLog(s.devices.fw).length - before;
  if (!r.ok || seq !== 'SYN → SYN-ACK → ACK' || added !== 2 || r.l3.length !== 1) fail(`TCP 三向交握：ok=${r.ok} 順序=${seq} 新增紀錄=${added} l3=${r.l3.length}`);
  else console.log('\n  ✔ TCP 連線走完 SYN → SYN-ACK → ACK；防火牆對同一條連線只記一筆放行與一筆 NAT');
}

// ── 模擬時鐘（二）：MAC 位址表、連線表、IPsec、設備時鐘與 NTP、紀錄與 Syslog ──
console.log('\n需要時間的狀態：MAC 位址表、連線表、IPsec、NTP、Syslog');
{
  const sim = await import('../src/engine/sim.js');
  const ops = await import('../src/engine/ops.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { fortiSession, fortiConfig } = await import('../src/engine/fortios.js');
  const { removeCable } = await import('../src/engine/model.js');
  const { macRows, sessionRows, saInfo } = sim;
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const ipOf = (s, id) => s.devices[id].ifaces.find((x) => x.rt && x.rt.ip != null).rt.ip;
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const forti = (s, id, lines) => { const sess = fortiSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const ping = (s, from, to) => transact(s, from, { proto: 'icmp', dst: typeof to === 'number' ? to : ipOf(s, to) });
  const flooded = (r) => r.log.some((l) => /unknown unicast/.test(l.text));
  // 乾淨的起點：套用解法並等網路穩定，但還沒有任何測試流量經過
  const fresh = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); lv.solve(s); recompute(s); return { s, lv }; };
  const unplug = (s, dev) => { for (const c of s.cables.filter((x) => x.a.dev === dev || x.b.dev === dev)) removeCable(s, c.id); recomputeNow(s); };

  // ── MAC 位址表 ──
  {
    const { s } = fresh('l06');
    const sw = s.devices.sw;
    const empty = macRows(s, sw).length === 0;
    ping(s, 'pc-s1', 'pc-s2');
    const rows = macRows(s, sw);
    ok(empty && rows.length === 2 && rows.every((r) => r.type === 'DYNAMIC' && r.vlan === 10 && r.age === 0 && r.left === 300),
      'MAC 位址表一開始是空的，有流量經過才學到來源 MAC（VLAN、連接埠都正確）');
    advance(s, 299);
    const still = macRows(s, sw).length;
    advance(s, 2);
    ok(still === 2 && macRows(s, sw).length === 0, 'MAC 項目 300 秒沒有再看到就過期');
    ping(s, 'pc-s1', 'pc-s2');
    ios(s, 'sw', ['conf t', 'mac address-table aging-time 60', 'end']);
    advance(s, 61);
    ok(macRows(s, sw).length === 0 && runningConfig(s, sw).includes('mac address-table aging-time 60'), 'mac address-table aging-time 可以調整過期時間，並出現在 running-config');
    ios(s, 'sw', ['conf t', 'no mac address-table aging-time', 'end']);
    ping(s, 'pc-s1', 'pc-s2');
    const before = macRows(s, sw).length;
    unplug(s, 'pc-s2');
    ok(before === 2 && macRows(s, sw).length === 1, '連接埠斷線時，從那個埠學到的 MAC 馬上清掉');
  }
  {
    // 路由器的 ARP 快取可以留四小時，交換器的 MAC 表只有五分鐘：交換器忘了之後，路由器送來的封包只能泛洪
    const { s } = solved('l08');
    const first = ping(s, 'rt', 'pc-s');
    advance(s, 400);
    const second = ping(s, 'rt', 'pc-s'), third = ping(s, 'rt', 'pc-s');
    ok(first.ok && !flooded(first) && second.ok && flooded(second) && !flooded(third),
      '交換器忘了目的 MAC（路由器的 ARP 還記得）：訊框被泛洪到整個 VLAN，對方一回覆又學回來');
  }
  {
    const { s } = solved('l23');
    ping(s, 'pc-a', 'pc-b');
    const learned = ['sw-a', 'sw-b', 'sw-c'].map((id) => macRows(s, s.devices[id]).length);
    const c = s.cables.find((x) => [x.a.dev, x.b.dev].sort().join() === 'sw-a,sw-c');
    s.cut = { [c.id]: true };
    recomputeNow(s);
    ok(learned.every((n) => n > 0) && ['sw-a', 'sw-b', 'sw-c'].every((id) => macRows(s, s.devices[id]).length === 0),
      '生成樹的拓撲改變 (Topology Change)：所有交換器把學到的 MAC 清掉重學');
  }

  // ── 連線表與 NAT 轉換的逾時 ──
  {
    const { s } = fresh('l05');
    const rt = s.devices.rt;
    ping(s, 'pc-1', parseIp('8.8.8.8'));
    const icmp = sessionRows(s, rt);
    transact(s, 'pc-1', { proto: 'tcp', dst: parseIp('93.184.216.34'), dport: 443 });
    const tcp = sessionRows(s, rt).find((e) => e.proto === 'tcp');
    ok(icmp.length === 1 && icmp[0].left === 60 && icmp[0].nSrc !== icmp[0].src && tcp && tcp.st === 'fin' && tcp.left === 60,
      '經過 NAT 的連線記在轉換表裡：ICMP 閒置 60 秒；TCP 連線關閉後也只留 60 秒');
    advance(s, 59);
    const kept = sessionRows(s, rt).length;
    advance(s, 2);
    ok(kept === 2 && sessionRows(s, rt).length === 0, '閒置時間一到，轉換表的項目就被移除');
  }
  {
    const { s } = fresh('l10');
    ios(s, 'hq', ['conf t', 'ip nat translation icmp-timeout 10', 'end']);
    ping(s, 'hq-pc', parseIp('8.8.8.8'));
    const n0 = sessionRows(s, s.devices.hq).length;
    advance(s, 11);
    ok(n0 === 1 && sessionRows(s, s.devices.hq).length === 0 && runningConfig(s, s.devices.hq).includes('ip nat translation icmp-timeout 10'),
      'ip nat translation icmp-timeout 可以調整逾時，並出現在 running-config');
  }
  {
    const { s } = fresh('l09');
    const fw = s.devices.fw;
    transact(s, 'pc-1', { proto: 'udp', dst: parseIp('8.8.8.8'), dport: 53 });
    const udp = sessionRows(s, fw)[0];
    const list = forti(s, 'fw', ['diagnose sys session list']);
    ok(udp && udp.proto === 'udp' && udp.ttl === 180 && list.some((l) => /expire=180 timeout=180/.test(l)) && list.some((l) => /^total session 1/.test(l)),
      'FortiGate 的連線表：UDP 閒置 180 秒，diagnose sys session list 會顯示倒數');
    forti(s, 'fw', ['config system session-ttl', 'set default 600', 'end']);
    ok(fw.natTimeout.tcp === 600 && fortiConfig(s, fw).join('\n').includes('set default 600') && sim.sessionTtl(fw, { proto: 'tcp', st: 'est' }) === 600,
      'config system session-ttl 可以調整 TCP 連線的閒置時間');
    forti(s, 'fw', ['diagnose sys session clear']);
    ok(sessionRows(s, fw).length === 0, 'diagnose sys session clear 清空連線表');
  }

  // ── IPsec：協商時間、金鑰壽命、對端失聯 ──
  {
    const lv = LEVELS.find((l) => l.id === 'l20');
    const s = lv.setup();
    recompute(s); lv.solve(s); recomputeNow(s);
    const t = s.devices.hq.vpns[0];
    const nego = !t.rt.up && t.rt.nego > 0 && pendingOf(s).some((p) => p.kind === 'vpn');
    advance(s, 2);
    ok(nego && t.rt.up && s.devices.br.vpns[0].rt.up, 'VPN 通道設定好之後要先協商 (IKE)，兩秒後才 Up');
    const res = evaluate(s, lv.objectives);
    const sa0 = saInfo(s, 'hq', t.name);
    ok(res.every((r) => r.pass) && sa0.tx > 0 && sa0.rx > 0 && sa0.life1 === 86400 && sa0.life2 === 43200, 'SA 記錄了加密 / 解密的封包數；FortiGate 的金鑰壽命預設是一天與十二小時');
    advance(s, 43210);
    const sa1 = saInfo(s, 'hq', t.name);
    ok(t.rt.up && sa1.rekey2 === 1 && sa1.left2 === 43190 && sa1.rekey1 === 0, '第二階段的金鑰到期會自動重新協商，通道不會中斷');
    forti(s, 'hq', ['config vpn ipsec phase2-interface', `edit "${t.name}"`, 'set keylifeseconds 7200', 'next', 'end']);
    advance(s, 3);
    ok(saInfo(s, 'hq', t.name).life2 === 7200 && saInfo(s, 'br', s.devices.br.vpns[0].name).life2 === 7200 && fortiConfig(s, s.devices.hq).join('\n').includes('set keylifeseconds 7200'),
      '兩端的金鑰壽命不同時用比較短的那一個（改設定會重新協商）');
    // 對端突然關機：這一端的 SA 還在，要等 DPD 才會發現
    s.down = { br: true };
    recomputeNow(s);
    const stale = t.rt.up && t.rt.stale - s.clock === 60;
    const r = transact(s, 'hq-pc', { proto: 'icmp', dst: ipOf(s, 'br-pc') });
    advance(s, 61);
    ok(stale && !r.ok && /SA 還沒過期/.test(r.reason) && !t.rt.up, '對端關機：通道還顯示 Up、封包照樣加密送出（被丟掉），60 秒後 DPD 才判定失聯');
    delete s.down;
    recomputeNow(s);
    const renego = !t.rt.up && t.rt.nego > 0;
    recompute(s);
    ok(renego && t.rt.up && evaluate(s, lv.objectives).every((x) => x.pass), '對端回來之後重新協商，通道恢復');
    const log = ops.logRows(s, s.devices.hq).map((x) => x.line);
    ok(log.some((l) => /action="tunnel-down"/.test(l)) && log.some((l) => /action="tunnel-up"/.test(l)) && /^date=2026-01-0\d time=\d\d:\d\d:\d\d devname="HQ-FW"/.test(log[0]),
      'FortiGate 的事件紀錄記下通道中斷與恢復');
    // 關掉 DPD：只能等金鑰到期
    forti(s, 'hq', ['config vpn ipsec phase1-interface', `edit "${t.name}"`, 'set dpd disable', 'next', 'end']);
    recompute(s);
    s.down = { br: true };
    recompute(s); // settle 最多只等 300 秒
    ok(t.rt.up && t.rt.stale - s.clock > 300 && fortiConfig(s, s.devices.hq).join('\n').includes('set dpd disable'), '關掉 DPD 之後，對端失聯要等到金鑰到期才會發現');
  }
  {
    // IOS 預設沒有 keepalive
    const { makeDevice, addCable } = await import('../src/engine/model.js');
    const link = (st, x, y) => { const [ad, ap] = x.split(':'), [bd, bp] = y.split(':'); const e = addCable(st, ad, ap, bd, bp); if (e) throw new Error(e); };
    const lv = LEVELS.find((l) => l.id === 'l20');
    const s = lv.setup();
    for (const c of s.cables.filter((x) => x.a.dev === 'br' || x.b.dev === 'br')) removeCable(s, c.id);
    s.devices.br = makeDevice('isr4321', 'br', { name: 'Branch-RT', pos: [7, -4.5] });
    link(s, 'inet:line2', 'br:Gi0/0/0'); link(s, 'br:Gi0/0/1', 'br-sw:1');
    recompute(s);
    ios(s, 'br', ['conf t', 'int gi0/0/0', 'ip address 198.51.100.34 255.255.255.252', 'ip nat outside', 'no shut', 'int gi0/0/1', 'ip address 10.2.0.1 255.255.255.0', 'ip nat inside',
      'ip route 0.0.0.0 0.0.0.0 198.51.100.33', 'ip access-list extended NAT', 'deny ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.0.255', 'permit ip 10.2.0.0 0.0.0.255 any',
      'ip nat inside source list NAT interface Gi0/0/0 overload', 'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'lifetime 3600',
      'crypto isakmp key Tw!S2S#2026 address 203.0.113.18', 'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode tunnel',
      'ip access-list extended VPN-HQ', 'permit ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.0.255',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 203.0.113.18', 'set transform-set TS', 'match address VPN-HQ', 'int gi0/0/0', 'crypto map CMAP', 'end']);
    recompute(s);
    const t = s.devices.br.vpns[0], sa = saInfo(s, 'br', t.name);
    const cfg = runningConfig(s, s.devices.br).join('\n');
    ok(t.rt.up && sa.life1 === 3600 && sa.life2 === 3600 && cfg.includes(' lifetime 3600'), 'IOS：isakmp policy 的 lifetime 生效（兩端取較短的），IPsec SA 預設一小時');
    s.down = { hq: true };
    recompute(s);
    ok(t.rt.up && t.rt.stale - s.clock > 300, 'IOS 預設沒有 keepalive：對端失聯之後通道還是 Up，要等 SA 到期');
    delete s.down;
    recompute(s);
    ios(s, 'br', ['conf t', 'crypto isakmp keepalive 10 3', 'end']);
    recompute(s);
    s.down = { hq: true };
    recomputeNow(s);
    const wait = t.rt.stale - s.clock;
    advance(s, 26);
    ok(wait === 25 && !t.rt.up && runningConfig(s, s.devices.br).includes('crypto isakmp keepalive 10 3'), 'crypto isakmp keepalive 10 3：25 秒內就發現對端失聯');
    const log = ops.logRows(s, s.devices.br).map((x) => x.line);
    ok(log.some((l) => /%CRYPTO-5-SESSION_STATUS: Crypto tunnel is DOWN/.test(l)) && log.some((l) => /%SYS-5-CONFIG_I/.test(l)), 'IOS 的紀錄：通道中斷 (%CRYPTO-5-SESSION_STATUS)、有人改過設定 (%SYS-5-CONFIG_I)');
  }

  // ── 設備自己的時鐘與 NTP ──
  {
    const lv = LEVELS.find((l) => l.id === 'l19');
    const s = lv.setup();
    recompute(s);
    const sw = s.devices.sw, rt = s.devices.rt, nms = s.devices.nms;
    ok(/^\*\d\d:\d\d:\d\d\.\d{3} UTC \w{3} Mar \d+ 1993$/.test(ops.iosClock(s, sw)) && /^\*.* 2026$/.test(ops.iosClock(s, rt)),
      '沒有對時：2960 沒有硬體時鐘，時間從 1993 年算起；ISR 用硬體時鐘，年份是對的但不可信（都有 *）');
    lv.solve(s);
    recompute(s);
    const n0 = ops.ntpInfo(s, sw);
    advance(s, 255);
    const before = ops.ntpInfo(s, sw).synced;
    advance(s, 2);
    const n1 = ops.ntpInfo(s, sw);
    ok(n0.reachable && !n0.synced && n0.wait === 256 && !before && n1.synced && n1.stratum === 3 && /^\d\d:\d\d:\d\d\.\d{3} UTC Mon Jan 5 2026$/.test(ops.iosClock(s, sw)),
      'NTP：連得到伺服器之後還要輪詢幾次（256 秒）才採信；同步之後時間正確、前面沒有 *');
    ok(evaluate(s, lv.objectives).every((r) => r.pass), '6-4 的目標在新的時鐘模型下照樣通過');
    // 紀錄與 Syslog
    unplug(s, 'usr');
    const log = ops.logRows(s, sw).map((x) => x.line), got = ops.syslogRows(s, nms);
    ok(log.some((l) => /^Jan  5 \d\d:\d\d:\d\d\.\d{3}: %LINK-3-UPDOWN: Interface GigabitEthernet0\/2, changed state to down$/.test(l))
      && log.some((l) => /%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0\/2, changed state to down/.test(l)),
    '介面斷線：設備記下 %LINK-3-UPDOWN 與 %LINEPROTO-5-UPDOWN，時間戳記是對時後的時間');
    ok(got.some((m) => m.ip === '10.0.99.2' && /^<187>\d+: Jan  5 .*%LINK-3-UPDOWN/.test(m.line)) && got.some((m) => /^<189>/.test(m.line) && /LINEPROTO/.test(m.line)),
      'Syslog 伺服器收到訊息：來源 IP 正確，優先值 = 設施 local7 × 8 + 嚴重程度');
    ios(s, 'sw', ['conf t', 'logging trap warnings', 'end']);
    const n = ops.syslogRows(s, nms).length;
    ios(s, 'sw', ['conf t', 'interface gi0/1', 'shutdown', 'end']);
    const after = ops.syslogRows(s, nms).slice(n).map((m) => m.line);
    ok(runningConfig(s, sw).includes('logging trap warnings') && !after.some((l) => /CONFIG_I|LINEPROTO|LINK-5/.test(l)) && ops.logRows(s, sw).some((x) => /%LINK-5-CHANGED: Interface GigabitEthernet0\/1, changed state to administratively down/.test(x.line)),
      'logging trap warnings：比 warnings 輕微的訊息只留在設備上，不會送到伺服器');
    ios(s, 'sw', ['conf t', 'no logging trap', 'interface gi0/1', 'no shutdown', 'end']);
    // 伺服器連不到：UDP 不會重送
    const lost0 = ops.syslogStats(s, rt).lost, had = ops.syslogRows(s, nms).length;
    s.down = { nms: true };
    recomputeNow(s);
    ios(s, 'rt', ['conf t', 'interface gi0/0/0', 'shutdown', 'end']);
    ok(ops.syslogStats(s, rt).lost > lost0 && ops.syslogRows(s, nms).length === had && ops.logRows(s, rt).some((x) => /LINK-5-CHANGED/.test(x.line)), 'Syslog 伺服器連不到：訊息直接掉了（UDP 不重送），設備自己的緩衝區還留著');
    // NTP 伺服器失聯八次輪詢之後失去同步，時鐘照原本的速度繼續走
    advance(s, 64 * 9);
    const lostInfo = ops.ntpInfo(s, sw);
    ok(!lostInfo.synced && /^\.\d\d:\d\d:\d\d\.\d{3} UTC Mon Jan 5 2026$/.test(ops.iosClock(s, sw)), 'NTP 伺服器失聯：連續八次輪詢沒有回應就失去同步，時間前面變成 .（不會跳回 1993 年）');
    delete s.down;
    // reload：記憶體裡的紀錄消失，時鐘從頭開始
    ios(s, 'sw', ['write memory', 'reload', '']);
    const buf = ops.logRows(s, sw).map((x) => x.line);
    ok(/1993$/.test(ops.iosClock(s, sw)) && /^\*Mar  1 00:00:00\.000: %SYS-5-RESTART: System restarted --$/.test(buf[0]) && buf.some((l) => /%LINK-3-UPDOWN: Interface GigabitEthernet0\/9, changed state to up/.test(l))
      && macRows(s, sw).length <= 1 && ops.uptimeOf(s, sw) === 0, // 重開機後自己馬上去問 NTP 伺服器，所以會學到伺服器那一筆
    'reload 之後：紀錄緩衝區清空、時鐘回到 1993 年、介面重新上線，MAC 位址表也重新學');
  }
  {
    // ntp master：上游自己的時間是錯的，下游就跟著錯
    const { s } = solved('l19');
    ios(s, 'rt', ['conf t', 'clock timezone TST 8', 'ntp master 5', 'no ntp server', 'end', 'clock set 08:00:00 1 January 2030']);
    ios(s, 'sw', ['conf t', 'ntp server 10.0.99.1', 'end']);
    advance(s, 64 * 5);
    const n = ops.ntpInfo(s, s.devices.sw);
    ok(n.synced && n.stratum === 6 && /^08:0\d:\d\d\.\d{3} TST \w{3} Jan 1 2030$/.test(ops.iosClock(s, s.devices.rt)) && /^00:0\d:\d\d\.\d{3} UTC \w{3} Jan 1 2030$/.test(ops.iosClock(s, s.devices.sw))
      && ['clock timezone TST 8', 'ntp master 5'].every((l) => runningConfig(s, s.devices.rt).includes(l)),
    'ntp master + clock set：交換器向路由器對時（stratum 6），連路由器設錯的年份也一起學過去；clock timezone 只影響顯示');
  }
  {
    // FortiGate 第一次收到回應就校時；公用的 NTP 伺服器在網際網路上
    const { s } = solved('l09');
    forti(s, 'fw', ['config system ntp', 'set ntpsync enable', 'set type custom', 'config ntpserver', 'edit 1', `set server "${ops.INET_NTP}"`, 'next', 'end', 'end']);
    const n = ops.ntpInfo(s, s.devices.fw);
    const out = forti(s, 'fw', ['diagnose sys ntp status']);
    ok(n.synced && n.stratum === 2 && out.some((l) => /^synchronized: yes/.test(l)), 'FortiGate 向網際網路上的 NTP 伺服器對時：第一次收到回應就同步 (stratum 2)');
  }
  // ── 其他事件的紀錄 ──
  {
    const { s } = solved('l25');
    const routers = Object.values(s.devices).filter((d) => d.ifaces.some((i) => i.vrrp && i.vrrp.on));
    const master = routers.find((d) => d.ifaces.some((i) => i.rt.vrrp && i.rt.vrrp.state === 'master')), backup = routers.find((d) => d !== master);
    s.down = { [master.id]: true };
    recompute(s);
    ok(ops.logRows(s, backup).some((x) => /%VRRP-6-STATECHANGE: .* Grp 1 state Backup -> Master/.test(x.line)), 'VRRP 換手會留下 %VRRP-6-STATECHANGE');
  }
  {
    const { s } = solved('l27');
    const r = Object.values(s.devices).find((d) => (d.rt.nbrs || []).length);
    const nb = r.rt.nbrs[0];
    s.down = { [nb.dev]: true };
    recompute(s);
    const down = ops.logRows(s, r).some((x) => /%OSPF-5-ADJCHG: Process 1, Nbr \d+\.\d+\.\d+\.\d+ on \S+ from FULL to DOWN, Neighbor Down: (Dead timer expired|Interface down or detached)/.test(x.line));
    delete s.down;
    recompute(s);
    ok(down && ops.logRows(s, r).some((x) => /from LOADING to FULL, Loading Done/.test(x.line)), 'OSPF 鄰居中斷與重新建立會留下 %OSPF-5-ADJCHG');
  }
  {
    const { s } = solved('l17');
    const sw = Object.values(s.devices).find((d) => d.kind === 'mswitch');
    const pid = Object.keys(sw.sw.ports).find((p) => sw.sw.ports[p].ps && sw.sw.ports[p].ps.on && s.rt.links[sw.id + ':' + p]);
    sw.sw.ports[pid].ps.mode = 'shutdown';
    sw.sw.ports[pid].ps.macs = '02:00:00:00:00:01';
    recompute(s);
    const lines = ops.logRows(s, sw).map((x) => x.line);
    ok(sw.rt.err[pid] && lines.some((l) => /%PM-4-ERR_DISABLE: psecure-violation error detected on/.test(l)) && lines.some((l) => /%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address [0-9a-f.]{14} on port GigabitEthernet/.test(l)),
      'Port Security 違規：%PM-4-ERR_DISABLE 與 %PORT_SECURITY-2-PSECURE_VIOLATION（附上違規的 MAC）');
  }
}

// ── FortiGate 的 CLI ──
console.log('\nFortiGate CLI');
{
  const { fortiSession, fortiConfig } = await import('../src/engine/fortios.js');
  const { makeDevice } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const typeF = (s, id, lines) => {
    const sess = fortiSession(() => s.devices[id], () => s);
    const errs = [];
    for (const l of lines) { const r = sess.exec(l); if (r.out.some((o) => /parse error|Command fail|not found in datasource|operator error|incomplete|Unknown action/.test(o))) errs.push(`${l.trim()} → ${r.out.join(' / ')}`); }
    if (sess.depth) errs.push('設定沒有用 end 結束');
    return errs;
  };
  // 1. 每一關解答裡的 FortiGate：show 出來的整份設定貼到一台空白的 FortiGate，要得到同樣的設定，關卡也要照樣通過
  let n = 0, bad = 0;
  for (const lv of LEVELS) {
    const { s } = solved(lv.id);
    for (const d of Object.values(s.devices).filter((x) => x.kind === 'firewall' && !x.locked)) {
      const want = fortiConfig(s, d);
      const s2 = cloneState(s);
      s2.devices[d.id] = makeDevice(d.model, d.id, { name: d.name, pos: d.pos });
      recompute(s2);
      // 原廠預設的介面已經開放了一些管理存取；先清掉，才算一台「空白」的設備
      const clear = ['config system interface', ...s2.devices[d.id].ifaces.flatMap((i) => [`edit "${i.id}"`, 'unset allowaccess', 'next']), 'end'];
      const errs = typeF(s2, d.id, [...clear, ...want]);
      recompute(s2);
      const got = fortiConfig(s2, s2.devices[d.id]);
      const broken = evaluate(s2, lv.objectives).filter((r) => !r.pass);
      n++;
      if (errs.length || want.join('\n') !== got.join('\n') || broken.length) {
        bad++;
        fail(`${lv.id} ${d.name}：貼回設定之後${broken.length ? '關卡不再通過 — ' + broken[0].reason : '內容不一致'}`);
        for (const e of errs.slice(0, 4)) console.log('      錯誤 ' + e);
        for (const x of want.filter((l) => !got.includes(l)).slice(0, 5)) console.log('      少了 ' + x);
        for (const x of got.filter((l) => !want.includes(l)).slice(0, 5)) console.log('      多了 ' + x);
      }
    }
  }
  if (!bad) console.log(`  ✔ ${n} 台 FortiGate 的設定貼回空白設備後完全一致，關卡照樣通過`);

  // 2. 只用指令完成防火牆關卡
  {
    const lv = LEVELS.find((l) => l.id === 'l09');
    const s = lv.setup();
    recompute(s);
    const errs = typeF(s, 'fw', [
      'config firewall vip', 'edit "web-https"', 'set extintf "wan1"', 'set portforward enable', 'set mappedip "172.16.1.10"', 'set extport 443', 'set mappedport 443', 'next', 'end',
      'config firewall policy', 'delete 1',
      'edit 1', 'set name "LAN 上網"', 'set srcintf "internal"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set schedule "always"', 'set service "ALL"', 'set nat enable', 'next',
      'edit 2', 'set name "LAN 到 DMZ"', 'set srcintf "internal"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set schedule "always"', 'set service "HTTPS"', 'next',
      'edit 3', 'set name "DMZ 連外"', 'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set schedule "always"', 'set service "ALL"', 'set nat enable', 'next',
      'edit 4', 'set name "對外網站"', 'set srcintf "wan1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "web-https"', 'set action accept', 'set schedule "always"', 'set service "HTTPS"', 'next',
      'end']);
    recompute(s);
    const res = evaluate(s, lv.objectives);
    ok(!errs.length && res.every((r) => r.pass), `只用 FortiOS 指令完成 3-1（VIP 與四條政策）${errs[0] ? '：' + errs[0] : res.find((r) => !r.pass) ? '：' + res.find((r) => !r.pass).reason : ''}`);
    const sess = fortiSession(() => s.devices.fw, () => s);
    for (const l of ['config firewall policy', 'move 4 before 1', 'end']) sess.exec(l);
    ok(s.devices.fw.policies[0].name === '對外網站', 'move 可以調整政策的比對順序');
    const r1 = sess.exec('config firewall policy'), r2 = sess.exec('edit 9'), r3 = sess.exec('set srcintf "nope"'), r4 = sess.exec('next');
    ok(!r1.changed && r2.out[0].includes('new entry') && !r3.out.length && /必填|缺少/.test(r4.out.join()) && s.devices.fw.policies.length === 4, '缺少必填欄位的政策在 next 時被拒絕，不會寫入');
    sess.exec('abort');
  }
  // 3. 站對站 VPN：分公司的 FortiGate 整台用指令設定
  {
    const lv = LEVELS.find((l) => l.id === 'l20');
    const build = ({ route = true, pfs = false } = {}) => {
      const s = lv.setup();
      recompute(s);
      const errs = typeF(s, 'br', [
        'config vpn ipsec phase1-interface', 'edit "HQ"', 'set interface "wan1"', 'set proposal aes256-sha256', 'set dhgrp 14', 'set remote-gw 203.0.113.18', 'set psksecret Tw!S2S#2026', 'next', 'end',
        'config vpn ipsec phase2-interface', 'edit "HQ"', 'set phase1name "HQ"', 'set proposal aes256-sha256', ...(pfs ? [] : ['set pfs disable']), 'set src-subnet 10.2.0.0 255.255.255.0', 'set dst-subnet 10.1.0.0 255.255.255.0', 'next', 'end',
        ...(route ? ['config router static', 'edit 0', 'set dst 10.1.0.0 255.255.255.0', 'set device "HQ"', 'next', 'end'] : []),
        'config firewall policy',
        'edit 0', 'set name "to-hq"', 'set srcintf "internal"', 'set dstintf "HQ"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set schedule "always"', 'set service "ALL"', 'next',
        'edit 0', 'set name "from-hq"', 'set srcintf "HQ"', 'set dstintf "internal"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set schedule "always"', 'set service "ALL"', 'next',
        'end']);
      recompute(s);
      return { s, errs, res: evaluate(s, lv.objectives) };
    };
    const good = build();
    ok(!good.errs.length && good.res.every((r) => r.pass), `只用 FortiOS 指令完成 7-1 站對站 VPN${good.errs[0] ? '：' + good.errs[0] : good.res.find((r) => !r.pass) ? '：' + good.res.find((r) => !r.pass).reason : ''}`);
    const noRoute = build({ route: false });
    ok(noRoute.s.devices.br.vpns[0].rt.up && !noRoute.res[0].pass && noRoute.res[2].pass, '用指令建立的通道沒有加靜態路由：通道是 Up，但流量不會走進通道');
    const pfs = build({ pfs: true });
    ok(!pfs.s.devices.br.vpns[0].rt.up && /第二階段/.test(pfs.s.devices.br.vpns[0].rt.why), '第二階段預設開啟 PFS，對端沒開就談不成');
    const sess = fortiSession(() => good.s.devices.br, () => good.s);
    ok(sess.exec('diagnose vpn tunnel list').out.join('\n').includes('status=up') && sess.exec('get router info routing-table all').out.length > 2, 'diagnose 與 get 可以查看通道與路由表');
  }
  // 4. 介面各自的管理存取
  {
    const { s } = solved('l09');
    const sess = fortiSession(() => s.devices.fw, () => s);
    const ip = s.devices.fw.ifaces.find((i) => i.id === 'internal').rt.ip;
    for (const l of ['config system interface', 'edit "internal"', 'set allowaccess ping https', 'next', 'end']) sess.exec(l);
    recompute(s);
    const ssh = transact(s, 'pc-1', { proto: 'tcp', dst: ip, dport: 22 }), web = transact(s, 'pc-1', { proto: 'tcp', dst: ip, dport: 443 });
    ok(!ssh.ok && /allowaccess/.test(ssh.reason) && web.ok, 'allowaccess 只開 ping 與 https：SSH 連不上、HTTPS 可以');
  }
}

// ── 題庫與證照對照表的資料檢查 ──
{
  const { QUESTIONS, TOPICS, LEVEL_TOPIC } = await import('../src/data/quiz.js');
  const { CERTS } = await import('../src/data/certs.js');
  const ids = new Set(LEVELS.map((l) => l.id));
  let nq = 0;
  for (const t of TOPICS) {
    for (const q of QUESTIONS[t.id] || []) {
      nq++;
      if (q.a.length !== 4 || new Set(q.a).size !== 4) fail(`題目選項必須是 4 個不重複的答案：${q.q}`);
      if (!(q.c >= 0 && q.c < 4)) fail(`題目的正確答案索引不合法：${q.q}`);
      if (!q.e || !q.r) fail(`題目缺少解說或考試條目：${q.q}`);
    }
  }
  for (const [lv, t] of Object.entries(LEVEL_TOPIC)) if (!ids.has(lv) || !QUESTIONS[t]) fail(`LEVEL_TOPIC 對應錯誤：${lv} → ${t}`);
  let items = 0;
  for (const c of CERTS) for (const d of c.domains) for (const [code, , levels] of d.items) {
    items++;
    for (const l of levels) if (!ids.has(l)) fail(`證照對照表引用了不存在的關卡：${c.short} ${code} → ${l}`);
  }
  const mapped = new Set(CERTS.flatMap((c) => c.domains.flatMap((d) => d.items.flatMap((i) => i[2]))));
  for (const id of ids) if (!mapped.has(id)) fail(`關卡 ${id} 沒有對應任何證照條目`);
  console.log(`\n資料檢查：${nq} 題觀念題、${items} 個證照條目、${ids.size} 個關卡`);
}

console.log(failed ? `\n${failed} 個問題` : '\n全部通過 ✔');
process.exit(failed ? 1 : 0);
