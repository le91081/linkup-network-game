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
    // % OSPF: … 是 IOS 的提醒（設定已經套用），不是錯誤
    for (const l of lines) for (const o of sess.exec(l).out) if (o.startsWith('%') && !o.includes('Creating vlan') && !o.startsWith('% OSPF:')) errs.push(`${l} → ${o}`);
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
      // RSA 金鑰、韌體與 flash 不在設定檔裡：當作同一台設備換回原本的設定
      // SNMPv3 的使用者也一樣：IOS 不會把它寫進 running-config
      if (d.mgmt && s2.devices[d.id].mgmt) { s2.devices[d.id].mgmt.sshKey = d.mgmt.sshKey; if (d.mgmt.snmpUser) s2.devices[d.id].mgmt.snmpUser = { ...d.mgmt.snmpUser }; }
      for (const k of ['fw', 'flash']) if (d[k]) s2.devices[d.id][k] = JSON.parse(JSON.stringify(d[k]));
      recompute(s2);
      const errs = type(s2, d.id, ['configure terminal', ...want, 'end']);
      recompute(s2);
      // DR 是有狀態的：設備重灌之後不會自己搶回 DR，要像工程師那樣讓大家重新選
      if (lv.reelect) { for (const x of Object.values(s2.devices).filter((y) => y.rt && y.rt.ospf)) type(s2, x.id, ['clear ip ospf process', 'yes']); recompute(s2); }
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
  say(s.rt.booting.rt === 180 && pc.rt.src === 'apipa' && pendingOf(s).some((p) => p.kind === 'boot'), '路由器按下電源後要 180 秒才開完機，這段時間還是要不到位址');
  advance(s, 180);
  say(pc.rt.src === 'dhcp' && pc.rt.ip === ip0, '伺服器開完機之後重新要到位址');
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
  say(s.rt.booting['gw-a'] === 180 && vr('gw-b').state === 'master' && net().ok, 'GW-A 按下電源後要 180 秒才開完機，這段時間繼續由 GW-B 當 Master');
  advance(s, 180);
  say(vr('gw-a').state === 'master' && nb('gw-a', 'edge').state === 'forming' && Math.round(nb('gw-a', 'edge').left) === 40, 'GW-A 開完機：VRRP 立刻搶回 Master，但 OSPF 鄰居關係要重新建立');
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
    const booting = s.rt.booting.br === 70 && !t.rt.up;
    advance(s, 70);
    const renego = !t.rt.up && t.rt.nego > 0;
    recompute(s);
    ok(booting && renego && t.rt.up && evaluate(s, lv.objectives).every((x) => x.pass), '對端開完機（70 秒）之後重新協商，通道恢復');
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
    const rebooting = s.rt.booting.sw === 120 && !s.rt.links['sw:Gi0/9'] && ops.logRows(s, sw).length === 0;
    advance(s, 120);
    const buf = ops.logRows(s, sw).map((x) => x.line);
    ok(rebooting && /1993$/.test(ops.iosClock(s, sw)) && /^\*Mar  1 00:00:00\.000: %SYS-5-RESTART: System restarted --$/.test(buf[0]) && buf.some((l) => /%LINK-3-UPDOWN: Interface GigabitEthernet0\/9, changed state to up/.test(l))
      && macRows(s, sw).length <= 1 && ops.uptimeOf(s, sw) === 0, // 重開機後自己馬上去問 NTP 伺服器，所以會學到伺服器那一筆
    'reload：開機的 120 秒內所有埠都沒有燈號；開完機之後紀錄緩衝區是空的、時鐘回到 1993 年、MAC 位址表重新學');
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

// ── 階段 2：遠端登入、介面計數器、封包擷取與 SPAN、debug ──
console.log('\n排除故障的工具：遠端登入、計數器、擷取、SPAN、debug');
{
  const ops = await import('../src/engine/ops.js');
  const rem = await import('../src/engine/remote.js');
  const wire = await import('../src/engine/wire.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { fortiSession, fortiConfig } = await import('../src/engine/fortios.js');
  const { makeState, makeDevice, addCable, removeCable } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const fresh = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); lv.solve(s); recompute(s); return { s, lv }; };
  const ipOf = (s, id) => s.devices[id].ifaces.find((x) => x.rt && x.rt.ip != null).rt.ip;
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const forti = (s, id, lines) => { const sess = fortiSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const ping = (s, from, to) => transact(s, from, { proto: 'icmp', dst: typeof to === 'number' ? to : ipOf(s, to) });
  const frames = (s, id) => (wire.captureOf(s, id) || { frames: [] }).frames;

  // ── 遠端登入 ──
  {
    const { s } = fresh('l19');
    const sw = parseIp('10.0.99.2');
    const no = rem.remoteOpen(s, 'usr', 'ssh', sw, 'admin');
    const o = rem.remoteOpen(s, 'adm', 'ssh', sw, 'admin');
    ok(!no.ok && /不在 Switch 允許管理的位址範圍內/.test(no.reason) && o.ok && o.kind === 'ios' && /^SHA256:/.test(o.key), 'SSH：使用者網段被 access-class 擋下，管理員可以連上交換器');
    const bad = rem.remoteLogin(s, o.conn, 'admin'), good = rem.remoteLogin(s, o.conn, 'Net0ps-Admin-2026');
    recomputeNow(s);
    ok(!bad.ok && !bad.closed && good.ok && ops.vtyRows(s, s.devices.sw).length === 1, '密碼錯了可以再試；登入成功後 show users 看得到這條連線');
    advance(s, 599);
    const alive = rem.remoteSend(s, o.conn, 'show clock').ok;
    advance(s, 601);
    const gone = rem.remoteSend(s, o.conn, 'show clock');
    ok(alive && !gone.ok && gone.by === 'device' && ops.vtyRows(s, s.devices.sw).length === 0, '閒置超過 10 分鐘 (exec-timeout 預設值) 設備自動登出；有在打字就不會');
    ios(s, 'sw', ['conf t', 'login block-for 120 attempts 2 within 60', 'login on-failure log', 'banner motd #Authorized access only#', 'line vty 0 4', 'exec-timeout 1 30', 'end']);
    const cfg = runningConfig(s, s.devices.sw);
    ok(['login block-for 120 attempts 2 within 60', 'login on-failure log', 'banner motd #Authorized access only#', ' exec-timeout 1 30'].every((l) => cfg.includes(l)) && ops.idleLimit(s.devices.sw) === 90,
      'login block-for、login on-failure log、banner motd、exec-timeout 都會出現在 running-config');
    const c = rem.remoteOpen(s, 'adm', 'ssh', sw, 'admin').conn;
    rem.remoteLogin(s, c, 'x');
    const locked = rem.remoteLogin(s, c, 'y');
    recomputeNow(s);
    const during = rem.remoteOpen(s, 'adm', 'ssh', sw, 'admin');
    advance(s, 121);
    const after = rem.remoteOpen(s, 'adm', 'ssh', sw, 'admin');
    const log = ops.logRows(s, s.devices.sw).map((x) => x.line);
    ok(locked.closed && locked.locked === 120 && !during.ok && after.ok && log.some((l) => /%SEC_LOGIN-4-LOGIN_FAILED: Login failed \[user: admin\] \[Source: 10\.0\.99\.10\]/.test(l))
      && log.some((l) => /%SEC_LOGIN-1-QUIET_MODE_ON/.test(l)) && log.some((l) => /%SEC_LOGIN-5-QUIET_MODE_OFF/.test(l)),
    'login block-for：60 秒內失敗 2 次就拒絕所有登入 120 秒，並留下紀錄');
  }
  {
    // 經過防火牆的 SSH：防火牆的連線表先把閒置的連線忘了
    const { s } = fresh('l20');
    const o = rem.remoteOpen(s, 'hq-pc', 'ssh', parseIp('10.2.0.1'), 'admin');
    const login = o.ok && rem.remoteLogin(s, o.conn, 'admin');
    forti(s, 'br', ['config system global', 'set admintimeout 480', 'end']);
    forti(s, 'hq', ['config system session-ttl', 'set default 300', 'end']);
    advance(s, 200);
    const still = rem.remoteSend(s, o.conn, 'get system status').ok;
    advance(s, 301);
    const r = rem.remoteSend(s, o.conn, 'get system status');
    ok(login && login.ok && still && !r.ok && r.by === 'net' && /HQ-FW 的連線表裡已經沒有這條連線/.test(r.reason) && fortiConfig(s, s.devices.br).join('\n').includes('set admintimeout 480'),
      'SSH 穿過防火牆：閒置超過防火牆的 session-ttl，連線被防火牆丟掉 (no session matched)，設備那端其實還在等');
  }

  // ── 開機時間 ──
  {
    const { s } = fresh('l09');
    const out = forti(s, 'fw', ['execute reboot']);
    const booting = s.rt.booting.fw === 70 && !ping(s, 'pc-1', parseIp('8.8.8.8')).ok;
    advance(s, 70);
    ok(out.some((l) => /rebooting/.test(l)) && booting && ping(s, 'pc-1', parseIp('8.8.8.8')).ok && ops.logRows(s, s.devices.fw).some((x) => /Fortigate started/.test(x.line)),
      'FortiGate execute reboot：70 秒內不通，開完機之後恢復，並記下 System restarted');
  }

  // ── 介面計數器 ──
  {
    const { s } = fresh('l06');
    const c0 = wire.counters(s, 'sw', 'Gi0/1');
    ok(c0.op > 100000 && c0.omc === c0.op && c0.ip === 0, '設備已經開機三天：計數器裡累積了大量 STP BPDU（每 2 秒一個，多點傳送）');
    wire.clearCounters(s, 'sw');
    ping(s, 'pc-s1', 'pc-s2');
    const c1 = wire.counters(s, 'sw', 'Gi0/1');
    advance(s, 10);
    const c2 = wire.counters(s, 'sw', 'Gi0/1');
    ok(c1.ip === 2 && c1.op === 2 && c1.ibc === 1 && c2.op === c1.op + 5 && wire.clearedAt(s, 'sw', 'Gi0/1') != null,
      'clear counters 歸零之後：一次 ping 收 2 個（ARP 廣播 + ICMP）、送 2 個；10 秒後多了 5 個 BPDU');
  }
  {
    const lv = LEVELS.find((l) => l.id === 'l39');
    const s = lv.setup(); recompute(s);
    wire.clearCounters(s, 'core'); wire.clearCounters(s, 'acc');
    for (let k = 0; k < 9; k++) ping(s, 'pc-1', parseIp('192.168.1.10'));
    const full = wire.counters(s, 'core', 'Gi0/9'), half = wire.counters(s, 'acc', 'Gi0/9');
    ok(full.crc > 0 && full.runts > 0 && half.late > 0 && half.coll > 0 && !half.crc && !full.late,
      'duplex mismatch：全雙工那一端收到 CRC 錯誤與 runt，半雙工那一端出現 late collision');
    lv.solve(s); recompute(s);
    wire.clearCounters(s, 'core'); wire.clearCounters(s, 'acc');
    for (let k = 0; k < 9; k++) ping(s, 'pc-1', parseIp('192.168.1.10'));
    const ok2 = wire.counters(s, 'core', 'Gi0/9');
    ok(ok2.ip > 0 && !ok2.crc && !wire.counters(s, 'acc', 'Gi0/9').late, '雙工修好之後，錯誤就不再增加');
  }

  // ── 封包擷取：交換器、Hub、SPAN ──
  {
    const { s } = fresh('l02');
    wire.setCapture(s, 'pc-3', true);
    ping(s, 'pc-1', 'pc-2');
    const f = frames(s, 'pc-3');
    ok(f.length === 1 && f[0].proto === 'arp' && f[0].dmac === wire.BCAST, '接在交換器上：別人的 ping 只看得到 ARP 廣播，看不到 ICMP');
  }
  {
    const link = (st, a, b) => { const [ad, ap] = a.split(':'), [bd, bp] = b.split(':'); const e = addCable(st, ad, ap, bd, bp); if (e) throw new Error(e); };
    const s = makeState([makeDevice('hub4', 'hub', { name: 'Hub', pos: [0, 0] }), ...['a', 'b', 'c'].map((x, n) => makeDevice('pc', 'pc-' + x, { name: 'PC-' + x.toUpperCase(), pos: [n * 4 - 4, 3], ip: `192.168.1.${10 * (n + 1)}` }))]);
    link(s, 'pc-a:eth0', 'hub:1'); link(s, 'pc-b:eth0', 'hub:2'); link(s, 'pc-c:eth0', 'hub:3');
    recompute(s);
    wire.setCapture(s, 'pc-c', true);
    ping(s, 'pc-a', 'pc-b');
    const f = frames(s, 'pc-c');
    ok(f.filter((x) => x.proto === 'icmp' && x.how === 'promisc').length === 2, '接在 Hub 上：別人之間的 ICMP 請求與回應全部看得到');
  }
  {
    const { s } = fresh('l06');
    const out = ios(s, 'sw', ['conf t', 'monitor session 1 source interface gi0/1', 'monitor session 1 destination interface gi0/4', 'end']);
    wire.setCapture(s, 'pc-r2', true);
    ping(s, 'pc-s1', 'pc-s2');
    const f = frames(s, 'pc-r2');
    const cut = ping(s, 'pc-r2', 'pc-r1');
    const cfg = runningConfig(s, s.devices.sw);
    ok(out.some((l) => /目的埠/.test(l)) && f.some((x) => x.proto === 'icmp' && !x.reply && x.how === 'span') && f.some((x) => x.proto === 'icmp' && x.reply)
      && cfg.includes('monitor session 1 source interface Gi0/1') && cfg.includes('monitor session 1 destination interface Gi0/4'),
    'SPAN：把 Gi0/1 鏡像到 Gi0/4，接在 Gi0/4 的電腦看得到另一個 VLAN 的 ping');
    ios(s, 'sw', ['conf t', 'no monitor session 1', 'end']);
    ok(!cut.ok && /SPAN（連接埠鏡像）的目的埠/.test(cut.reason) && ping(s, 'pc-r2', 'pc-r1').ok, 'SPAN 的目的埠不轉送一般流量，拿掉之後恢復');
  }
  {
    // Telnet 的帳號密碼在線路上是明文；SSH 看不到
    const { s } = fresh('l19');
    ios(s, 'sw', ['conf t', 'line vty 0 4', 'transport input ssh telnet', 'monitor session 1 source interface gi0/1', 'monitor session 1 destination interface gi0/3', 'end']);
    wire.setCapture(s, 'nms', true);
    const pass = 'Net0ps-Admin-2026';
    const t = rem.remoteOpen(s, 'adm', 'telnet', parseIp('10.0.99.2'), 'admin');
    rem.remoteLogin(s, t.conn, pass);
    const tel = frames(s, 'nms').filter((x) => wire.protoName(x) === 'TELNET');
    wire.setCapture(s, 'nms', true);
    const h = rem.remoteOpen(s, 'adm', 'ssh', parseIp('10.0.99.2'), 'admin');
    rem.remoteLogin(s, h.conn, pass);
    const ssh = frames(s, 'nms');
    ok(t.ok && tel.some((x) => x.data && x.data.pass === pass && wire.infoOf(x).includes(pass)) && ssh.some((x) => wire.protoName(x) === 'SSHv2') && !JSON.stringify(ssh).includes(pass),
      '用 SPAN 側錄：Telnet 的帳號密碼直接看得到，SSH 只看得到加密的封包');
  }
  {
    // Wireshark 的顯示篩選
    const f = { proto: 'icmp', src: parseIp('10.0.0.1'), dst: parseIp('10.0.0.2'), sport: 1, dport: 0, smac: 'a', dmac: 'b' };
    const m = (x) => wire.displayFilter(x).fn;
    ok(m('ip.addr == 10.0.0.2 && icmp')(f) && !m('tcp.port == 22')(f) && m('!arp')(f) && m('ip.src == 10.0.0.0/24')(f) && !!wire.displayFilter('ip.addr = 1').error,
      '顯示篩選：ip.addr、ip.src（可以是網段）、tcp.port、協定名稱、&& 與 !，寫錯會提示');
  }

  // ── IOS debug ──
  {
    const { s } = fresh('l08');
    wire.setDebug(s, 'rt', 'packet', true); wire.setDebug(s, 'rt', 'icmp', true);
    ping(s, 'pc-s', 'rt');
    ping(s, 'pc-s', 'pc-r');
    ping(s, 'pc-s', parseIp('172.31.0.9'));
    const log = ops.logRows(s, s.devices.rt).filter((x) => x.sev === 7).map((x) => x.line);
    ok(log.some((l) => /IP: s=192\.168\.10\.100 \(GigabitEthernet0\/0\/1\.10\), d=192\.168\.10\.1 \(GigabitEthernet0\/0\/1\.10\), len 60, rcvd 3$/.test(l))
      && log.some((l) => /ICMP: echo reply sent, src 192\.168\.10\.1, dst 192\.168\.10\.100/.test(l)) && log.some((l) => /d=172\.31\.0\.9, len 60, unroutable$/.test(l))
      && !log.some((l) => /d=192\.168\.20\./.test(l)),
    'debug ip packet / icmp：看得到給路由器自己的封包與丟掉的封包；跨 VLAN 轉送的封包由 CEF 處理，不會出現');
    wire.setDebug(s, 'rt', 'all', false);
    const n = ops.logRows(s, s.devices.rt).length;
    ping(s, 'pc-s', 'rt');
    ok(ops.logRows(s, s.devices.rt).length === n, 'undebug all 之後就不再產生 debug 訊息');
  }

  // ── FortiGate：debug flow 與 sniffer ──
  {
    const { s } = fresh('l09');
    forti(s, 'fw', ['diagnose debug flow filter addr 8.8.8.8', 'diagnose debug flow show function-name enable', 'diagnose debug flow trace start 4', 'diagnose debug enable']);
    ping(s, 'pc-1', parseIp('8.8.8.8'));
    const allow = wire.consoleRows(s, 'fw').map((x) => x.line);
    ok(allow.some((l) => /received a packet\(proto=1, 192\.168\.1\.100:\d+->8\.8\.8\.8:2048\) tun_id=0\.0\.0\.0 from internal/.test(l)) && allow.some((l) => /find a route: flag=04000000 gw-203\.0\.113\.17 via wan1/.test(l))
      && allow.some((l) => /msg="Allowed by Policy-1: SNAT"/.test(l)) && allow.some((l) => /SNAT 192\.168\.1\.100->203\.0\.113\.18/.test(l)) && allow.some((l) => /Find an existing session, id-[0-9a-f]{8}, reply direction/.test(l)),
    'debug flow：收到封包 → 找路由 → 符合政策 1 並做 SNAT → 回程比對到既有的連線');
    s.devices.fw.policies = [];
    recompute(s);
    forti(s, 'fw', ['diagnose debug flow trace start 1']);
    ping(s, 'pc-1', parseIp('8.8.8.8'));
    ok(wire.consoleRows(s, 'fw').some((x) => /msg="Denied by forward policy check \(policy 0\)"/.test(x.line)), '沒有政策時：Denied by forward policy check (policy 0)');
  }
  {
    const { s } = fresh('l09');
    const start = forti(s, 'fw', ["diagnose sniffer packet any 'icmp' 4 3"]);
    ping(s, 'pc-1', parseIp('8.8.8.8'));
    const lines = wire.consoleRows(s, 'fw').map((x) => x.line);
    const nic = forti(s, 'fw', ['diagnose hardware deviceinfo nic wan1']);
    ok(start.includes('filters=[icmp]') && lines.some((l) => /^\d+\.\d{6} internal in 192\.168\.1\.100 -> 8\.8\.8\.8: icmp: echo request$/.test(l)) && lines.some((l) => /wan1 out 203\.0\.113\.18 -> 8\.8\.8\.8: icmp: echo request/.test(l))
      && lines.includes('3 packets received by filter') && !wire.sniffing(s, 'fw') && nic.some((l) => /^Rx_Packets:\s+[1-9]/.test(l)),
    'sniffer：看得到封包從 internal 進來、NAT 之後從 wan1 出去；抓滿 3 個自動停止；hardware deviceinfo nic 看得到計數器');
    const tr = fortiSession(() => s.devices.fw, () => s).exec('execute traceroute 8.8.8.8');
    ok(tr.trace === '8.8.8.8', 'execute traceroute 交給畫面去追蹤路徑');
  }
}

// ── 階段 3：檔案傳輸、韌體、SSH 金鑰、SNMP、背景流量 ──
console.log('\n維運：TFTP / FTP、韌體、SSH 金鑰、SNMP、背景流量');
{
  const files = await import('../src/engine/files.js');
  const snmp = await import('../src/engine/snmp.js');
  const rem = await import('../src/engine/remote.js');
  const ops = await import('../src/engine/ops.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { fortiSession, fortiConfig } = await import('../src/engine/fortios.js');
  const { removeCable, addCable, makeState, makeDevice, linkInfo } = await import('../src/engine/model.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const start = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); recompute(s); return { s, lv }; };
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const res = []; for (const l of lines) res.push(sess.exec(l)); recomputeNow(s); return { out: res.flatMap((r) => r.out), wait: res.reduce((a, r) => a + (r.wait || 0), 0), res }; };
  const forti = (s, id, lines) => { const sess = fortiSession(() => s.devices[id], () => s); const res = []; for (const l of lines) res.push(sess.exec(l)); recomputeNow(s); return { out: res.flatMap((r) => r.out), wait: res.reduce((a, r) => a + (r.wait || 0), 0) }; };

  // ── 設定備份與還原 ──
  {
    const { s, lv } = start('l40');
    const merged = ios(s, 'sw', ['copy tftp: running-config', '10.0.99.30', 'sw-core-confg', '']);
    const pass1 = evaluate(s, lv.objectives);
    ok(merged.out.some((l) => /^\[OK - \d+ bytes\]$/.test(l)) && merged.out.some((l) => /bytes copied in/.test(l)) && pass1[0].pass && !pass1[1].pass && s.devices.sw.sw.ports['Gi0/4'].shut,
      'copy tftp: running-config 是合併：VLAN 20 回來了，但檔案裡沒寫到的 shutdown 還在（印表機還是不通）');
    const { s: s2 } = start('l40');
    ios(s2, 'sw', ['copy tftp://10.0.99.30/sw-core-confg startup-config', '']);
    const before = s2.devices.sw.sw.ports['Gi0/4'].shut;
    ios(s2, 'sw', ['reload', 'no', '']); // 「System configuration has been modified. Save?」要回答 no，不然剛還原的 startup 會被蓋掉
    advance(s2, 121); recompute(s2);
    ok(before && !s2.devices.sw.sw.ports['Gi0/4'].shut && s2.devices.sw.sw.vlans.some((v) => v.id === 20) && evaluate(s2, lv.objectives).slice(0, 3).every((r) => r.pass),
      'copy tftp: startup-config 再 reload 是整份取代：Gi0/4 的 shutdown 也不見了');
    const up = ios(s2, 'rt', ['copy running-config tftp:', '10.0.99.30', '']);
    ok(s2.devices.bak.files['r1-confg'] && s2.devices.bak.files['r1-confg'].lines.join('\n') === runningConfig(s2, s2.devices.rt).join('\n') && up.out.some((l) => /^!+$/.test(l)),
      'copy running-config tftp: 照預設的檔名 (r1-confg) 上傳到伺服器');
    const miss = ios(s2, 'sw', ['copy tftp://10.0.99.30/nope running-config', '']);
    ok(miss.out.some((l) => l === '%Error opening tftp://10.0.99.30/nope (No such file or directory)'), '伺服器上沒有這個檔案：%Error opening … (No such file or directory)');
  }
  // ── 韌體升級 ──
  {
    const { s, lv } = start('l41');
    const NEW = 'isr4300-universalk9.17.09.05a.SPA.bin';
    const full = ios(s, 'rt', [`copy tftp://10.0.99.30/${NEW} bootflash:`, '']);
    ok(full.out.some((l) => /Not enough space on device/.test(l)), 'bootflash 空間不夠：Not enough space on device');
    ios(s, 'rt', ['delete bootflash:isr4300-universalk9.17.03.04a.SPA.bin', '', '']);
    const t0 = s.clock;
    const tftp = ios(s, 'rt', [`copy tftp://10.0.99.30/${NEW} bootflash:`, '']);
    s.devices.rt.flash.files = Object.fromEntries(Object.entries(s.devices.rt.flash.files).filter(([n]) => n !== NEW));
    const ftp = ios(s, 'rt', [`copy ftp://netadmin:Fw#Upgrade2026@10.0.99.30/${NEW} bootflash:`, '']);
    ok(tftp.wait > 1200 && ftp.wait < 60 && s.devices.rt.flash.files[NEW] && s.clock === t0,
      `TFTP 一次只送 512 位元組，722 MB 要 ${Math.round(tftp.wait / 60)} 分鐘；FTP 只要 ${Math.round(ftp.wait)} 秒`);
    const v = ios(s, 'rt', [`verify /md5 bootflash:${NEW} ${files.IMAGES[NEW].md5}`]);
    ok(v.out.some((l) => l.startsWith('Verified (bootflash:')), 'verify /md5 和原廠公布的值一樣：Verified');
    // 拿錯平台的映像檔：開機會跳過它，改用下一個
    const WRONG = 'isr4400-universalk9.17.09.05a.SPA.bin';
    ios(s, 'rt', ['delete bootflash:isr4300-universalk9.16.12.04.SPA.bin', '', '', 'delete bootflash:core/isr4300_RP_0_iosd_10251_20251022-081132-UTC.core.gz', '', '']);
    ios(s, 'rt', [`copy ftp://netadmin:Fw#Upgrade2026@10.0.99.30/${WRONG} bootflash:`, '', 'configure terminal', 'no boot system', `boot system bootflash:${WRONG}`, 'end', 'write memory', 'reload', '']);
    advance(s, 181); recompute(s);
    const log = ops.logRows(s, s.devices.rt).map((x) => x.line);
    ok(s.devices.rt.fw.ver !== '17.9.5a' && log.some((l) => /Boot of bootflash:isr4400.* failed: .*ISR 4400/.test(l)), 'boot system 指向 ISR 4400 的映像檔：開機時跳過它，改用 flash 裡第一個能開機的映像檔');
    ios(s, 'rt', ['configure terminal', 'no boot system', `boot system bootflash:${NEW}`, 'end', 'write memory', 'reload', '']);
    advance(s, 181); recompute(s);
    ok(s.devices.rt.fw.ver === '17.9.5a' && evaluate(s, lv.objectives).every((r) => r.pass), 'boot system 指向新的映像檔、存檔、reload：show version 是 17.9.5a，三個目標都通過');
    // 所有能開機的映像檔都刪掉 → ROMMON，再手動開機
    for (const n of Object.keys(s.devices.rt.flash.files)) if (/^isr4300/.test(n) && n !== NEW) delete s.devices.rt.flash.files[n];
    s.devices.rt.flash.files[NEW].md5 = 'deadbeef';
    ios(s, 'rt', ['reload', '']);
    const rom = s.rt.rommon && s.rt.rommon.rt;
    const blocked = !sim.transact(s, 'usr', { proto: 'icmp', dst: parseIp('8.8.8.8') }).ok;
    s.devices.rt.flash.files[NEW].md5 = files.IMAGES[NEW].md5;
    const r = ios(s, 'rt', [`boot bootflash:${NEW}`]);
    advance(s, 181); recompute(s);
    ok(rom && blocked && r.out.some((l) => /開機中/.test(l)) && !s.rt.rommon.rt && s.devices.rt.fw.ver === '17.9.5a', '沒有能開機的映像檔就停在 ROMMON；在 ROMMON 用 boot 指定檔案就能開機');
  }
  // ── FortiGate：備份、還原、升級路徑 ──
  {
    const { s } = start('l09');
    const fw = s.devices.fw;
    fw.fw = { image: 'FGT_60F-v7.0.15.M-build0632-FORTINET.out', ver: '7.0.15' };
    const srv = s.devices.web;
    srv.services.push({ proto: 'udp', port: 69, name: 'TFTP' });
    srv.files = { 'FGT_60F-v7.4.7.F-build2731-FORTINET.out': files.imageFile('FGT_60F-v7.4.7.F-build2731-FORTINET.out', 0), 'FGT_60F-v7.2.10.M-build1706-FORTINET.out': files.imageFile('FGT_60F-v7.2.10.M-build1706-FORTINET.out', 0) };
    const ip = sim.primaryIpOf ? null : srv.ifaces[0].ip;
    // 防火牆到 DMZ 的伺服器：本機送出的流量不需要政策
    const bk = forti(s, 'fw', [`execute backup config tftp fw.conf ${ip}`]);
    const saved = srv.files['fw.conf'];
    ok(bk.out.includes('Send config file to tftp server OK.') && saved && saved.lines.join('\n') === fortiConfig(s, fw).join('\n'), 'FortiGate execute backup config tftp：整份設定存到伺服器');
    const jump = forti(s, 'fw', [`execute restore image tftp FGT_60F-v7.4.7.F-build2731-FORTINET.out ${ip}`, 'y']);
    ok(jump.out.some((l) => /Upgrade path check failed: 7\.0\.15 → 7\.4\.7/.test(l)) && fw.fw.ver === '7.0.15', 'FortiGate 不能從 7.0 直接跳到 7.4：要照升級路徑先到 7.2');
    forti(s, 'fw', [`execute restore image tftp FGT_60F-v7.2.10.M-build1706-FORTINET.out ${ip}`, 'y']);
    advance(s, 71); recompute(s);
    ok(fw.fw.ver === '7.2.10', '先升到 7.2.10，重新開機之後生效');
    fw.policies[0].name = '被改壞了';
    forti(s, 'fw', [`execute restore config tftp fw.conf ${ip}`, 'y']);
    advance(s, 71); recompute(s);
    ok(fw.policies[0].name !== '被改壞了' && fortiConfig(s, fw).join('\n') === saved.lines.join('\n'), 'execute restore config：整份設定換回備份的內容，然後重新開機');
  }
  // ── SSH 的前置條件 ──
  {
    const { s, lv } = start('l42');
    const no = rem.remoteOpen(s, 'adm', 'ssh', parseIp('10.0.98.2'), 'admin');
    const e1 = ios(s, 'sw', ['configure terminal', 'crypto key generate rsa modulus 2048']).out;
    const e2 = ios(s, 'sw', ['configure terminal', 'hostname SW-Floor3', 'crypto key generate rsa modulus 2048']).out;
    ok(!no.ok && e1.includes('% Please define a hostname other than Switch.') && e2.includes('% Please define a domain-name first.'),
      '原廠交換器沒有 RSA 金鑰，SSH 連不進去；產生金鑰之前要先改主機名稱、設定網域名稱');
    const { s: s3 } = start('l42');
    ios(s3, 'sw', ['configure terminal', 'ip default-gateway 10.0.98.1', 'end']);
    const tel = rem.remoteOpen(s3, 'adm', 'telnet', parseIp('10.0.98.2'), '');
    ok(!tel.ok && tel.noPass, 'line vty 只有 login 又沒有密碼：Telnet 連上之後立刻被關掉 (Password required, but none set)');
    ios(s, 'sw', ['configure terminal', 'ip domain name corp.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'username netadmin privilege 15 secret Sw!tch-Admin-2026', 'line vty 0 4', 'transport input ssh', 'end']);
    const noGw = evaluate(s, lv.objectives)[0];
    ios(s, 'sw', ['configure terminal', 'ip default-gateway 10.0.98.1', 'end']);
    const lineOnly = evaluate(s, lv.objectives)[0];
    ios(s, 'sw', ['configure terminal', 'line vty 0 4', 'login local', 'end']);
    ok(!noGw.pass && !lineOnly.pass && /login local/.test(lineOnly.reason) && evaluate(s, lv.objectives).every((r) => r.pass),
      '少了 ip default-gateway 回應回不去；只有 login 的話 SSH 登入不了；改成 login local 之後三個目標都通過');
    const k1 = rem.hostKey(s.devices.sw);
    ios(s, 'sw', ['configure terminal', 'crypto key generate rsa modulus 2048', 'yes', 'end']);
    ok(rem.hostKey(s.devices.sw) !== k1, '重新產生 RSA 金鑰之後，SSH 的指紋就不一樣了（用戶端會警告主機金鑰變了）');
  }
  // ── SNMP ──
  {
    const { s, lv } = start('l43');
    const nms = s.devices.nms;
    nms.nms.targets = [{ ip: '10.0.50.2', ver: 'v2c', community: 'public' }];
    const off = snmp.pollOne(s, nms, nms.nms.targets[0]);
    ios(s, 'core', ['configure terminal', 'snmp-server community Watch!2026 RO 10', 'access-list 10 permit 10.0.50.30', 'end']);
    const wrong = snmp.pollOne(s, nms, nms.nms.targets[0]);
    nms.nms.targets[0].community = 'Watch!2026';
    const good = snmp.pollOne(s, nms, nms.nms.targets[0]);
    ios(s, 'core', ['configure terminal', 'no access-list 10', 'access-list 10 permit 10.0.50.99', 'end']);
    const acl = snmp.pollOne(s, nms, nms.nms.targets[0]);
    ok(!off.ok && /UDP\/161|沒有在|服務/.test(off.why) && !wrong.ok && /community/.test(wrong.why) && good.ok && good.sys.name === 'SW-Core' && !acl.ok && /ACL/.test(acl.why),
      'SNMP：沒開就沒有回應；community 錯了或來源不在 ACL 裡，設備什麼都不回；對了就查得到');
    ios(s, 'dsg', ['configure terminal', 'snmp-server group NMS v3 priv', 'snmp-server user nms NMS v3 auth sha Mon!tor-Auth26 priv aes 128 Mon!tor-Priv26', 'end']);
    const t = { ip: '10.0.50.3', ver: 'v3', user: 'nms', auth: 'Mon!tor-Auth26', priv: 'wrong-priv' };
    const badPriv = snmp.pollOne(s, nms, t);
    t.priv = 'Mon!tor-Priv26';
    nms.nms.targets.push(t);
    snmp.pollOne(s, nms, t);
    advance(s, 60);
    const r = snmp.nmsOf(s, 'nms').targets['10.0.50.3'];
    const up = r && r.ifs['Gi0/9'];
    ok(!badPriv.ok && r && r.ok && up && up.speed === 100 && up.util && up.util.out > 90,
      `SNMPv3：加密密碼不對就解不開；對了之後網管看得到 SW-Design 的上行線只跑 100 Mbps、使用率 ${up && up.util ? Math.round(up.util.out) : '?'}%`);
    // Trap
    ios(s, 'dsg', ['configure terminal', 'snmp-server host 10.0.50.30 version 3 priv nms', 'snmp-server enable traps', 'interface gi0/1', 'shutdown', 'end']);
    const traps = snmp.nmsOf(s, 'nms').traps;
    ok(traps.some((x) => x.kind === 'linkDown' && x.info.ifName === 'GigabitEthernet0/1' && x.from === '10.0.50.3'), '介面被關掉：交換器送出 linkDown Trap，網管伺服器收到了');
    ios(s, 'dsg', ['configure terminal', 'interface gi0/1', 'no shutdown', 'end']);
    // 線材降速與背景流量
    const c = s.cables.find((x) => x.damaged);
    const li = linkInfo(s, 'dsg', 'Gi0/9');
    const slow = evaluate(s, lv.objectives)[2];
    removeCable(s, c.id);
    addCable(s, 'core', 'Gi0/9', 'dsg', 'Gi0/9');
    recompute(s);
    const fast = evaluate(s, lv.objectives)[2];
    ok(li.speed === 100 && li.downshift && /只協商到/.test(li.text) && !slow.pass && fast.pass && fast.speed.mbps > 250,
      `網路線有線對斷了：兩端都是 Gigabit 卻只協商到 100 Mbps；換一條線之後設計部跑到 ${fast.speed ? fast.speed.mbps : '?'} Mbps`);
    ok(s.flows.every((f) => f.rt && f.rt.mbps > 0) && /背景流量共用/.test(fast.speed.where + JSON.stringify(sim.throughput(s, sim.transact(s, 'dpc', { proto: 'tcp', dst: parseIp('10.0.50.20'), dport: 5201, quiet: true }).hops))),
      '背景流量會和其他連線平分頻寬：iperf3 的結果會說明是和背景流量共用');
  }
  // ── FortiGate 的 SNMP ──
  {
    const { s } = start('l09');
    const fw = s.devices.fw;
    const inner = fw.ifaces.find((i) => i.id === 'internal');
    forti(s, 'fw', ['config system snmp sysinfo', 'set status enable', 'end', 'config system snmp community', 'edit 1', 'set name "Watch!2026"', 'config hosts', 'edit 1', 'set ip 192.168.1.100 255.255.255.255', 'next', 'end', 'next', 'end']);
    const pc = s.devices['pc-1'];
    pc.nms = { targets: [{ ip: inner.ip, ver: 'v2c', community: 'Watch!2026' }] };
    const noAccess = snmp.pollOne(s, pc, pc.nms.targets[0]);
    forti(s, 'fw', ['config system interface', 'edit "internal"', 'append allowaccess snmp', 'next', 'end']);
    const yes = snmp.pollOne(s, pc, pc.nms.targets[0]);
    ok(!noAccess.ok && /allowaccess/.test(noAccess.why) && yes.ok && fortiConfig(s, fw).join('\n').includes('set ip 192.168.1.100 255.255.255.255'),
      'FortiGate：要開 sysinfo、建 community 與允許的 hosts，介面的 allowaccess 也要有 snmp 才查得到');
    void makeState; void makeDevice;
  }
}

console.log('\n第二層探索：CDP、LLDP 與 DTP');
{
  const disc = await import('../src/engine/disc.js');
  const ops = await import('../src/engine/ops.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { makeState, makeDevice } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const start = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); recompute(s); return { s, lv }; };
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const nb = (s, id, proto) => disc.neighbors(s, s.devices[id], proto);
  {
    const { s } = start('l43');
    const c = nb(s, 'core', 'cdp').find((r) => r.dev === 'dsg');
    ok(c && c.label === 'Gi0/9' && c.info.port === 'GigabitEthernet0/9' && c.info.id === 'SW-Design.corp.local' && c.left > 120 && c.left <= 180 && !nb(s, 'core', 'lldp').length,
      `CDP：一開始就看得到鄰居（Device ID 是 FQDN，剩 ${c && c.left} 秒）；Catalyst 出廠沒有開 LLDP`);
    ios(s, 'core', ['configure terminal', 'lldp run', 'end']);
    const half = nb(s, 'core', 'lldp').length;
    ios(s, 'dsg', ['configure terminal', 'lldp run', 'end']);
    const l = nb(s, 'core', 'lldp').find((r) => r.dev === 'dsg');
    ok(!half && l && l.info.port === 'Gi0/9' && l.left === 120, 'LLDP 要兩端都 lldp run；開了之後馬上送出第一個通告');
    ios(s, 'dsg', ['configure terminal', 'no cdp run', 'end']);
    advance(s, 100);
    const still = nb(s, 'core', 'cdp').some((r) => r.dev === 'dsg');
    advance(s, 85);
    ok(still && !nb(s, 'core', 'cdp').some((r) => r.dev === 'dsg'), '對面關掉 CDP：這一端要等 holdtime (180 秒) 過了才忘記它');
    ios(s, 'dsg', ['configure terminal', 'interface gi0/9', 'no lldp transmit', 'end']);
    ok(!nb(s, 'core', 'lldp').some((r) => r.dev === 'dsg'), 'LLDP 關掉送出時會先送一個 TTL = 0 的通告，對方立刻刪掉這一筆');
    ok(runningConfig(s, s.devices.dsg).includes('no cdp run') && runningConfig(s, s.devices.dsg).includes(' no lldp transmit') && runningConfig(s, s.devices.core).includes('lldp run'),
      'no cdp run、lldp run、no lldp transmit 會出現在 running-config');
  }
  {
    // 兩台 Cisco 中間隔著一台非網管交換器：CDP 會被泛洪過去，LLDP 不會（802.1D 保留位址）
    const s = makeState([makeDevice('c2960', 'a', { name: 'SW-A' }), makeDevice('isr4321', 'r', { name: 'R1' }), makeDevice('isr4321', 'r2', { name: 'R2' }), makeDevice('sw8', 'u', { name: '小交換器' })],
      [['a:Gi0/1', 'u:1'], ['r:Gi0/0/1', 'u:2'], ['r2:Gi0/0/1', 'u:3']]);
    recompute(s);
    for (const id of ['a', 'r', 'r2']) ios(s, id, ['configure terminal', 'lldp run', 'end']);
    const cdp = nb(s, 'a', 'cdp').map((r) => r.dev).sort().join(), lldp = nb(s, 'a', 'lldp').length;
    ok(cdp === 'r,r2' && lldp === 0, 'CDP 經過非網管交換器：一個埠上看到兩個鄰居；LLDP 不會被交換器轉送');
  }
  {
    const { s } = start('l43');
    const op = (id) => s.devices[id].rt.dtp['Gi0/9'].oper;
    const aa = op('core') + '/' + op('dsg');
    ios(s, 'core', ['configure terminal', 'interface gi0/9', 'switchport mode trunk', 'end']);
    const ta = op('core') + '/' + op('dsg');
    ios(s, 'core', ['configure terminal', 'interface gi0/9', 'switchport nonegotiate', 'switchport trunk native vlan 99', 'end']);
    const nn = op('core') + '/' + op('dsg');
    advance(s, 61);
    const log = ops.logRows(s, s.devices.core).map((x) => x.line);
    ok(aa === 'access/access' && ta === 'trunk/trunk' && nn === 'trunk/access',
      `DTP：兩端 dynamic auto 維持 Access；一端 trunk 就協商成 Trunk；加上 nonegotiate 對面就收不到要求（${aa} → ${ta} → ${nn}）`);
    ok(log.some((l) => /CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on GigabitEthernet0\/9 \(99\), with SW-Design GigabitEthernet0\/9 \(1\)/.test(l)),
      'CDP 發現兩端的 Native VLAN 不同：%CDP-4-NATIVE_VLAN_MISMATCH');
    const err = ios(s, 'dsg', ['configure terminal', 'interface gi0/9', 'switchport nonegotiate', 'end']);
    ios(s, 'dsg', ['configure terminal', 'interface gi0/9', 'switchport mode dynamic desirable', 'end']);
    ios(s, 'core', ['configure terminal', 'interface gi0/9', 'no switchport nonegotiate', 'switchport mode dynamic auto', 'end']);
    ok(err.some((l) => /Conflict between 'nonegotiate' and 'dynamic'/.test(l)) && op('core') === 'trunk' && op('dsg') === 'trunk',
      'dynamic 的埠不能 nonegotiate；desirable 對 auto 協商成 Trunk');
    const rc = runningConfig(s, s.devices.dsg);
    ok(rc.includes(' switchport mode dynamic desirable') && !runningConfig(s, s.devices.core).some((l) => /switchport mode dynamic auto/.test(l)),
      'running-config：出廠預設的 dynamic auto 不會印出來，其他模式會');
    const pcPort = s.devices.dsg.rt.dtp['Gi0/1'];
    ok(pcPort.oper === 'access' && /不送 DTP/.test(pcPort.why), '接電腦的 dynamic auto 埠：電腦不講 DTP，維持 Access');
  }
  {
    const { s } = start('l11');
    const nx = Object.values(s.devices).find((d) => d.model === 'n93180');
    const pid = nx.ports[0].id;
    const out = ios(s, nx.id, ['configure terminal', `interface ${nx.ports[0].label}`, 'switchport mode dynamic auto', 'end']);
    ok(nx.sw.ports[pid].mode !== 'dynamic-auto' && out.some((l) => /不支援 DTP/.test(l)), 'Nexus 沒有 DTP：出廠是 access，也不能設成 dynamic');
  }
  void makeState;
}

console.log('\n語音與 QoS：PoE、語音 VLAN、註冊、LLQ、整形、信任邊界');
{
  const voice = await import('../src/engine/voice.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { removeCable, addCable } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const start = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); recompute(s); return { s, lv }; };
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const st = (s, id) => voice.phoneState(s, s.devices[id]);
  {
    const { s } = start('l44');
    const a0 = st(s, 'ph-a'), b0 = st(s, 'ph-b');
    ok(a0.st === 'off' && /PoE/.test(a0.why) && s.devices['pc-a'].ifaces[0].rt.ip == null && b0.st === 'tftp' && /option 150/.test(b0.why) && !s.devices['ph-b'].rt.voice,
      `接在沒有 PoE 的埠：電話沒電，後面的電腦也斷線；會議室電話沒學到語音 VLAN，停在下載設定（${b0.why.slice(0, 30)}…）`);
    const c = s.cables.find((x) => (x.a.dev === 'ph-a' && x.a.port === 'sw') || (x.b.dev === 'ph-a' && x.b.port === 'sw'));
    removeCable(s, c.id); addCable(s, 'ph-a', 'sw', 'sw', 'Gi0/1');
    recomputeNow(s);
    const booting = st(s, 'ph-a').st;
    advance(s, 91); recomputeNow(s);
    const a1 = st(s, 'ph-a');
    ok(booting === 'boot' && a1.st !== 'off' && a1.st !== 'boot' && !s.devices['ph-a'].rt.voice,
      `改插 PoE 埠：電話先開機 90 秒（${booting}）；交換器的埠沒有 voice vlan，CDP 也不會告訴它語音 VLAN（${a1.st}）`);
    ios(s, 'sw', ['configure terminal', 'interface range gi0/1 - 2', 'switchport voice vlan 110', 'end']);
    const va = s.devices['ph-a'].rt.voice, vb = s.devices['ph-b'].rt.voice;
    ios(s, 'sw', ['configure terminal', 'lldp run', 'end']);
    const vb2 = s.devices['ph-b'].rt.voice;
    ok(va && va.via === 'cdp' && va.vlan === 110 && !vb && vb2 && vb2.via === 'lldp', 'Cisco 電話從 CDP 學到語音 VLAN；Yealink 不懂 CDP，要交換器 lldp run 才從 LLDP-MED 學到');
    const pw = (s.rt.poe || {})['sw:Gi0/1'], pwb = (s.rt.poe || {})['sw:Gi0/2'];
    ok(pw && pw.state === 'on' && pw.alloc === 6.3 && pwb.alloc === 15.4, 'PoE：Cisco 電話用 CDP 協商只保留 6.3 W；Yealink（Class 3、沒有 CDP）依等級保留 15.4 W');
    advance(s, 20); recomputeNow(s);
    const a2 = st(s, 'ph-a');
    ios(s, 'rt', ['configure terminal', 'ip dhcp pool VOICE', 'option 150 ip 10.10.100.10', 'end']);
    const a3 = st(s, 'ph-a');
    advance(s, 10); recomputeNow(s);
    const a4 = st(s, 'ph-a'), b4 = st(s, 'ph-b');
    ok(a2.st === 'tftp' && a3.st === 'regging' && a4.st === 'reg' && a4.ext === '2001' && b4.st === 'reg',
      `語音網段的位址池少了 option 150 → 停在下載設定；補上之後註冊要幾秒，自動註冊配到分機 ${a4.ext} / ${b4.ext}`);
    const q = voice.callQuality(s, 'ph-a', 'ph-b');
    ok(q.ok && q.mos >= 4.3, `同一台交換器上的兩支電話：MOS ${q.mos}`);
    ios(s, 'sw', ['configure terminal', 'interface gi0/1', 'power inline never', 'end']);
    const off = st(s, 'ph-a').st;
    ios(s, 'sw', ['configure terminal', 'interface gi0/1', 'power inline auto', 'end']);
    ok(off === 'off' && runningConfig(s, s.devices.sw).every((l) => l !== ' power inline never'), 'power inline never：那個埠不供電，電話馬上斷電');
  }
  {
    // CUCM 沒開自動註冊、資料庫裡沒有這支電話 → 註冊被拒；手動設定語音 VLAN 與備用 TFTP 也能註冊
    const { s } = start('l44');
    s.devices.cucm.cucm.autoReg = false;
    // 手動指定的語音 VLAN 要交換器那個埠真的帶著它（voice vlan），電話送的帶標籤訊框才進得去
    ios(s, 'sw', ['configure terminal', 'interface gi0/2', 'switchport voice vlan 110', 'end']);
    s.devices['ph-b'].phone.vlan = '110';
    s.devices['ph-b'].phone.tftp = '10.10.100.10';
    recomputeNow(s);
    const r = st(s, 'ph-b');
    s.devices.cucm.cucm.phones.push({ mac: s.devices['ph-b'].ifaces[0].rt.mac, ext: '3001', name: '會議室' });
    recompute(s); // 被拒絕的電話會再試，這次查得到，註冊要幾秒
    const r2 = st(s, 'ph-b');
    ok(s.devices['ph-b'].rt.voice.via === 'manual' && r.st === 'reject' && r2.st === 'reg' && r2.ext === '3001',
      '電話上手動設定語音 VLAN 與備用 TFTP；CUCM 沒開自動註冊時，資料庫裡沒有的電話會被拒絕，加進資料庫就配到指定的分機');
  }
  {
    // 單向通話：路由器只擋了一個方向的 RTP
    const { s } = start('l45');
    const sess = iosSession(() => s.devices.hrt, () => s);
    for (const l of ['configure terminal', 'ip access-list extended NO-RTP-IN', 'deny udp 10.20.110.0 0.0.0.255 10.10.110.0 0.0.0.255 eq 16384', 'permit ip any any', 'interface gi0/0/0', 'ip access-group NO-RTP-IN in', 'end']) sess.exec(l);
    recompute(s);
    const one = voice.callQuality(s, 'ph-br', 'ph-hq');
    ok(!one.ok && one.oneWay && /總公司電話 聽不到 分公司電話/.test(one.why), `ACL 只擋了一個方向的 RTP：單向通話（${one.why.slice(0, 40)}…）`);
  }
  {
    const { s, lv } = start('l45');
    const q0 = voice.callQuality(s, 'ph-br', 'ph-hq');
    ok(q0.ok && q0.mos < 3.6 && q0.ab.why.some((w) => /合約頻寬 20 Mbps/.test(w)) && s.flows.every((f) => f.rt.mbps > 4 && f.rt.mbps < 7),
      `沒有 QoS：備份把營運商的 20 Mbps 塞滿，超過的被管制丟掉，語音也一起被丟（MOS ${q0.mos}，三個備份各 ${s.flows[0].rt.mbps} Mbps）`);
    ios(s, 'brt', ['configure terminal', 'policy-map SHAPE', 'class class-default', 'shape average 20000000', 'interface gi0/0/0', 'service-policy output SHAPE', 'end']);
    const q1 = voice.callQuality(s, 'ph-br', 'ph-hq');
    ok(q1.mos < 4.0 && q1.ab.loss > 3 && q1.ab.jitter > 5 && q1.ab.why.some((w) => /同一個佇列/.test(w)), `只有整形、沒有 LLQ：語音和備份排在同一個佇列（MOS ${q1.mos}，遺失 ${q1.ab.loss}%，抖動 ${q1.ab.jitter} ms）`);
    const e1 = ios(s, 'brt', ['configure terminal', 'class-map match-any VOICE', 'match dscp ef', 'policy-map VOICE-PRI', 'class VOICE', 'priority percent 30', 'bandwidth percent 10', 'end']);
    const e2 = ios(s, 'brt', ['configure terminal', 'interface gi0/0/1.10', 'service-policy input VOICE-PRI', 'end']);
    ok(e1.some((l) => /Only one of bandwidth or priority/.test(l)) && e2.some((l) => /not supported in the input direction/.test(l)), 'priority 和 bandwidth 不能放在同一個 class；佇列只能用在 output');
    ios(s, 'brt', ['configure terminal', 'policy-map VOICE-PRI', 'class class-default', 'fair-queue', 'policy-map SHAPE', 'class class-default', 'service-policy VOICE-PRI', 'end']);
    const q2 = voice.callQuality(s, 'ph-br', 'ph-hq');
    const res2 = evaluate(s, lv.objectives);
    ok(q2.mos >= 4.0 && !res2[2].pass && /BR-SW/.test(res2[2].reason), `加上 LLQ 之後通話清楚了（MOS ${q2.mos}，靠的是 class-default 的 fair-queue），但語音在 BR-SW 就被改成 0，路由器認不出它`);
    ios(s, 'bsw', ['configure terminal', 'interface gi0/1', 'mls qos trust cos', 'end']);
    const res3 = evaluate(s, lv.objectives);
    ok(!res3[2].pass && /cs5 \(40\)/.test(res3[2].reason) && /CoS 5 對應到 40/.test(res3[2].reason), '只信任 CoS：預設的對照表把 CoS 5 換成 DSCP 40 (CS5)，不是 EF');
    ios(s, 'bsw', ['configure terminal', 'interface gi0/1', 'auto qos voip cisco-phone', 'end']);
    const res4 = evaluate(s, lv.objectives);
    const q4 = voice.callQuality(s, 'ph-br', 'ph-hq');
    ok(res4.every((r) => r.pass) && q4.mos >= 4.3, `auto qos voip cisco-phone：語音一路都是 EF，四個目標都通過（MOS ${q4.mos}）`);
    const rc = runningConfig(s, s.devices.brt);
    ok(rc.indexOf('policy-map VOICE-PRI') < rc.indexOf('policy-map SHAPE') && rc.includes('  service-policy VOICE-PRI') && rc.includes(' service-policy output SHAPE'),
      'running-config 先印子政策再印 parent，貼回去才不會找不到');
    // trust device cisco-phone：對面是電腦就不信任
    ios(s, 'bsw', ['configure terminal', 'interface gi0/2', 'mls qos trust device cisco-phone', 'mls qos trust dscp', 'end']);
    const { portTrust } = await import('../src/engine/qos.js');
    ok(portTrust(s, s.devices.bsw, 'Gi0/2') === 'none' && portTrust(s, s.devices.bsw, 'Gi0/1') === 'cos', 'trust device cisco-phone：CDP 認出對面是 Cisco 電話才信任，接的是電腦就不信任');
  }
  {
    const { s, lv } = start('l46');
    const r0 = evaluate(s, lv.objectives);
    const sw = s.devices.sw;
    ok(!r0[0].pass && sw.rt.dtp['Gi0/5'].oper === 'trunk' && /desirable/.test(sw.rt.dtp['Gi0/5'].why) && r0[1].pass,
      'VLAN hopping：筆電用 DTP 把 dynamic auto 的埠協商成 Trunk，帶著 VLAN 20 的標籤直接連到資料庫，繞過 R1 的 ACL');
    ios(s, 'sw', ['configure terminal', 'interface range gi0/1 - 2 , gi0/5', 'switchport mode access', 'end']);
    const r1 = evaluate(s, lv.objectives);
    ok(r1[0].pass && sw.rt.dtp['Gi0/5'].oper === 'access' && !r1[2].pass && /nonegotiate/.test(r1[2].reason), '設成 Access 之後筆電只能走 R1，ACL 擋下了 3306；但還要 nonegotiate 才算加固完成');
  }
}

console.log('\nOSPF 進階：DR / BDR、計時器、MTU、被動介面、多區域、等價多路徑');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { makeState, makeDevice } = await import('../src/engine/model.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); return out; };
  const nb = (s, a, b) => (s.devices[a].rt.nbrs || []).find((n) => n.dev === b);
  // 四台路由器接在同一台交換器上（廣播網段 10.0.0.0/24），R1 另外用點對點的線接 R5（area 1）
  const mk = () => {
    const s = makeState([makeDevice('c2960', 'sw', { name: 'SW' }), ...[1, 2, 3, 4, 5].map((n) => makeDevice('isr4331', 'r' + n, { name: 'R' + n }))],
      [['r1:Gi0/0/0', 'sw:Gi0/1'], ['r2:Gi0/0/0', 'sw:Gi0/2'], ['r3:Gi0/0/0', 'sw:Gi0/3'], ['r4:Gi0/0/0', 'sw:Gi0/4'], ['r1:Gi0/0/1', 'r5:Gi0/0/1']]);
    s.devices.sw.sw.stp.portfastDefault = true;
    for (const n of [1, 2, 3, 4]) ios(s, 'r' + n, ['configure terminal', 'interface lo0', `ip address ${n}.${n}.${n}.${n} 255.255.255.255`, 'interface gi0/0/0', `ip address 10.0.0.${n} 255.255.255.0`, 'no shutdown', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', `network ${n}.${n}.${n}.${n} 0.0.0.0 area 0`, 'end']);
    ios(s, 'r1', ['configure terminal', 'interface gi0/0/1', 'ip address 10.1.15.1 255.255.255.252', 'ip ospf network point-to-point', 'no shutdown', 'router ospf 1', 'network 10.1.15.0 0.0.0.3 area 1', 'end']);
    ios(s, 'r5', ['configure terminal', 'interface lo0', 'ip address 10.1.5.5 255.255.255.0', 'interface lo1', 'ip address 10.1.6.5 255.255.255.0', 'interface gi0/0/1', 'ip address 10.1.15.2 255.255.255.252', 'ip ospf network point-to-point', 'no shutdown',
      'router ospf 1', 'network 10.1.0.0 0.0.255.255 area 1', 'end']);
    settle(s);
    return s;
  };
  {
    const s = mk();
    const roles = [1, 2, 3, 4].map((n) => s.devices['r' + n].rt.ospf.ifs['Gi0/0/0'].state).join(',');
    ok(roles === 'DROTHER,DROTHER,BDR,DR' && nb(s, 'r1', 'r2').state === '2way' && nb(s, 'r1', 'r4').state === 'full' && nb(s, 'r1', 'r4').role === 'DR',
      `DR 選舉：priority 一樣時 Router ID 最大的 R4 當 DR、R3 當 BDR；兩台 DROTHER 之間只到 2WAY（${roles}）`);
    ok(s.devices.r1.rt.ospf.rid === 0x01010101 && s.devices.r2.rt.routes.some((r) => r.net === 0x0a010505 && r.bits === 32) && s.devices.r2.rt.routes.some((r) => r.net === 0x04040404 && r.bits === 32 && r.type === 'O'),
      'Router ID 用 Loopback；Loopback 不管遮罩，一律以 /32 通告');
    const r5 = s.devices.r2.rt.routes.filter((r) => r.type === 'O' && r.sub === 'IA').map((r) => `${r.net >>> 0}/${r.bits}`);
    ok(r5.length >= 3 && s.devices.r1.rt.ospf.abr && s.devices.r5.rt.routes.some((r) => r.sub === 'IA' && r.net === 0x04040404),
      `多區域：R1 是 ABR，R2 從 area 1 學到 O IA 路由（${r5.length} 筆），R5 也學到骨幹的網段`);
    ios(s, 'r1', ['configure terminal', 'router ospf 1', 'area 1 range 10.1.0.0 255.255.0.0', 'end']); settle(s);
    const ia = s.devices.r2.rt.routes.filter((r) => r.sub === 'IA');
    ok(ia.length === 1 && ia[0].bits === 16, 'area 1 range：ABR 把 area 1 的網段彙總成一筆 10.1.0.0/16 送進骨幹');
    // 後來加入、priority 最高的路由器不會搶走 DR
    const late = makeState([]); void late;
    ios(s, 'r2', ['configure terminal', 'interface gi0/0/0', 'ip ospf priority 255', 'end']); settle(s);
    ok(s.devices.r4.rt.ospf.ifs['Gi0/0/0'].state === 'DR' && s.devices.r2.rt.ospf.ifs['Gi0/0/0'].state === 'DROTHER', 'DR 選出來之後不會被搶走：R2 把 priority 改成 255 也不會馬上變成 DR');
    s.down = { r4: true }; recomputeNow(s); advance(s, 41); settle(s);
    ok(s.devices.r3.rt.ospf.ifs['Gi0/0/0'].state === 'DR' && s.devices.r2.rt.ospf.ifs['Gi0/0/0'].state === 'BDR', 'DR 斷電：BDR (R3) 接手當 DR，再補選 BDR（priority 255 的 R2）');
    delete s.down;
    ios(s, 'r1', ['configure terminal', 'interface gi0/0/0', 'ip ospf priority 0', 'end']); settle(s);
    ok(s.devices.r1.rt.ospf.ifs['Gi0/0/0'].state === 'DROTHER' && runningConfig(s, s.devices.r1).includes(' ip ospf priority 0'), 'priority 0：永遠不當 DR / BDR');
  }
  {
    const s = mk();
    ios(s, 'r2', ['configure terminal', 'interface gi0/0/0', 'ip ospf hello-interval 5', 'end']); settle(s);
    const why = s.devices.r2.rt.ospf.ifs['Gi0/0/0'].why.join(' ');
    ok(!nb(s, 'r2', 'r1') && /Hello \/ Dead 計時器不一致/.test(why), 'Hello 計時器不一致：成為不了鄰居，show ip ospf interface 會說原因');
    ios(s, 'r2', ['configure terminal', 'interface gi0/0/0', 'no ip ospf hello-interval', 'ip mtu 1400', 'end']); settle(s);
    ok(nb(s, 'r2', 'r4') && nb(s, 'r2', 'r4').state === 'exstart' && /MTU/.test(nb(s, 'r2', 'r4').note), 'MTU 不一致：鄰居卡在 EXSTART');
    ios(s, 'r2', ['configure terminal', 'interface gi0/0/0', 'ip ospf mtu-ignore', 'end']); settle(s);
    ok(nb(s, 'r2', 'r4').state === 'full', 'ip ospf mtu-ignore：不檢查 MTU，鄰居進到 FULL');
    ios(s, 'r3', ['configure terminal', 'router ospf 1', 'passive-interface gi0/0/0', 'end']); settle(s);
    ok(!nb(s, 'r3', 'r4') && s.devices.r4.rt.routes.some((r) => r.net === 0x03030303) === false && s.devices.r3.rt.ospf.ifs['Gi0/0/0'].state === 'PASSIVE',
      '被動介面：不送 Hello，R3 和大家都不是鄰居了（它的 Loopback 也就傳不出去）');
    ios(s, 'r1', ['configure terminal', 'interface gi0/0/0', 'ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 S3cret', 'end']); settle(s);
    ok(!nb(s, 'r1', 'r4') && /驗證方式不一致/.test(s.devices.r1.rt.ospf.ifs['Gi0/0/0'].why.join()), '驗證：一端開了 MD5、另一端沒開，鄰居就斷了');
    ios(s, 'r1', ['configure terminal', 'router ospf 1', 'router-id 9.9.9.9', 'end']);
    const before = s.devices.r1.rt.ospf.rid;
    const msg = ios(s, 'r1', ['configure terminal', 'router ospf 1', 'router-id 9.9.9.9', 'end']);
    recomputeNow(s);
    ios(s, 'r1', ['clear ip ospf process', 'yes']); recomputeNow(s);
    ok(before === 0x01010101 && msg.some((l) => /clear ip ospf process/.test(l)) && s.devices.r1.rt.ospf.rid === 0x09090909, '改了 router-id：要 clear ip ospf process 才會換成新的 Router ID');
  }
  {
    // 等價多路徑：R1 到 R4 的 Loopback 有兩條 cost 一樣的路
    const s = makeState(['a', 'b', 'c', 'd'].map((x) => makeDevice('isr4331', x, { name: x.toUpperCase() })).concat([makeDevice('pc', 'h1', { ip: '10.9.1.11', gw: '10.9.1.1' }), makeDevice('pc', 'h2', { ip: '10.9.1.12', gw: '10.9.1.1' }), makeDevice('sw8', 'u')]),
      [['a:Gi0/0/0', 'b:Gi0/0/0'], ['a:Gi0/0/1', 'c:Gi0/0/0'], ['b:Gi0/0/1', 'd:Gi0/0/0'], ['c:Gi0/0/1', 'd:Gi0/0/1'], ['a:Gi0/0/2', 'u:1'], ['h1:eth0', 'u:2'], ['h2:eth0', 'u:3']]);
    const p2p = (id, port, ip) => ['interface ' + port, `ip address ${ip} 255.255.255.252`, 'ip ospf network point-to-point', 'no shutdown'];
    ios(s, 'a', ['configure terminal', ...p2p('a', 'gi0/0/0', '10.0.1.1'), ...p2p('a', 'gi0/0/1', '10.0.2.1'), 'interface gi0/0/2', 'ip address 10.9.1.1 255.255.255.0', 'no shutdown', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'passive-interface gi0/0/2', 'end']);
    ios(s, 'b', ['configure terminal', ...p2p('b', 'gi0/0/0', '10.0.1.2'), ...p2p('b', 'gi0/0/1', '10.0.3.1'), 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end']);
    ios(s, 'c', ['configure terminal', ...p2p('c', 'gi0/0/0', '10.0.2.2'), ...p2p('c', 'gi0/0/1', '10.0.4.1'), 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end']);
    ios(s, 'd', ['configure terminal', ...p2p('d', 'gi0/0/0', '10.0.3.2'), ...p2p('d', 'gi0/0/1', '10.0.4.2'), 'interface lo0', 'ip address 10.255.0.4 255.255.255.255', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end']);
    settle(s);
    const rs = s.devices.a.rt.routes.filter((r) => r.net === 0x0aff0004);
    const via = (h) => { const r = transact(s, h, { proto: 'icmp', dst: parseIp('10.255.0.4') }); return r.ok && r.hops.find((x) => x.from === 'a' && !x.reply && x.to !== 'u'); };
    const v1 = via('h1'), v2 = via('h2');
    ok(rs.length === 2 && rs[0].metric === rs[1].metric && v1 && v2 && v1.to !== v2.to, `等價多路徑：A 到 D 的 Loopback 有兩條 cost ${rs[0] && rs[0].metric} 的路，兩台主機被雜湊到不同的路（${v1 && v1.to} / ${v2 && v2.to}）`);
    ios(s, 'a', ['configure terminal', 'router ospf 1', 'maximum-paths 1', 'end']); settle(s);
    ok(s.devices.a.rt.routes.filter((r) => r.net === 0x0aff0004).length === 1, 'maximum-paths 1：只放一條');
    // E2 預設路由
    s.devices.d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '10.0.3.1', ad: '254' }); // 隨便一條預設路由，只是讓 D 有東西可以發布
    ios(s, 'd', ['configure terminal', 'router ospf 1', 'default-information originate', 'end']); settle(s);
    const def = s.devices.a.rt.routes.find((r) => r.bits === 0);
    ok(def && def.type === 'O' && def.sub === 'E2' && def.metric === 1, 'default-information originate：其他路由器學到 O*E2 0.0.0.0/0，metric 固定是 1');
  }
}

console.log('\nBGP：鄰居、最佳路徑、local-preference、AS-path prepend、轉運站、hold time');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); return out; };
  const lv = LEVELS.find((l) => l.id === 'l50');
  const s = lv.setup(); recompute(s);
  const peer = (ip) => s.devices.r1.rt.bgp.peers.find((x) => x.ip === ip);
  const via = (id, ip) => { const r = sim.lookupRoute(s.devices[id], parseIp(ip)); return r ? fmtIpT(r.via) : null; };
  function fmtIpT(n) { return n == null ? null : [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
  ok(peer('203.0.113.1').state === 'Established' && peer('198.51.100.1').state === 'Idle' && /64510/.test(peer('198.51.100.1').why), 'remote-as 寫錯（64501）：ISP-B 停在 Idle，原因是對方的 AS 是 64510');
  ios(s, 'r1', ['configure terminal', 'router bgp 65010', 'neighbor 198.51.100.1 remote-as 64510', 'end']);
  recomputeNow(s);
  const opening = peer('198.51.100.1').state;
  recompute(s);
  ok(opening === 'OpenSent' && peer('198.51.100.1').state === 'Established' && peer('198.51.100.1').pfx > 0, 'AS 改對之後先 OpenSent，大約十秒進到 Established，開始收到路由');
  ok(via('ispb', '203.0.113.5') === '198.51.100.2' && via('net', '192.0.2.10') === '198.51.100.9', '沒有任何過濾：R1 把 ISP-A 的路由送給了 ISP-B，ISP-B 往 ISP-A 的流量改走公司（轉運站）；進來的流量也剛好選了 ISP-B');
  lv.solve(s); recompute(s);
  const r = evaluate(s, lv.objectives);
  ok(r.every((x) => x.pass) && via('r1', '8.8.8.8') === '203.0.113.1' && via('net', '192.0.2.10') === '203.0.113.9' && via('ispb', '203.0.113.5') === '198.51.100.10',
    'local-preference 200 讓出去走 ISP-A；送給 ISP-B 的 prepend 三次讓進來也走 ISP-A；prefix-list 只送自己的網段，不再是轉運站');
  const best = s.devices.net.rt.bgp.table.filter((x) => x.net === parseIp('192.0.2.0'));
  ok(best.length === 2 && best.find((x) => x.best).aspath.join(' ') === '64500 65010' && best.find((x) => !x.best).aspath.join(' ') === '64510 65010 65010 65010 65010', '網際網路的 BGP 表：經過 ISP-B 的那條 AS path 多了三次 65010，所以選 ISP-A');
  const rc = runningConfig(s, s.devices.r1);
  ok(rc.includes('router bgp 65010') && rc.includes(' neighbor 198.51.100.1 route-map TO-B out') && rc.includes('ip prefix-list OWN seq 5 permit 192.0.2.0/24') && rc.includes(' set as-path prepend 65010 65010 65010'), 'BGP、prefix-list、route-map 都會出現在 running-config');
  // TCP 179 被 ACL 擋掉：已經建立的鄰居要等 hold time (180 秒) 才會斷
  ios(s, 'r1', ['configure terminal', 'ip access-list extended NO-BGP', 'deny tcp any any eq 179', 'deny tcp any eq 179 any', 'permit ip any any', 'interface gi0/0/1', 'ip access-group NO-BGP out', 'ip access-group NO-BGP in', 'end']);
  recomputeNow(s);
  const still = peer('198.51.100.1').state;
  advance(s, 181); recomputeNow(s);
  ok(still === 'Established' && peer('198.51.100.1').state === 'Active', 'BGP 的封包被擋住：線路沒斷，鄰居還是 Established，要等 hold time 180 秒過了才斷');
}

console.log('\nshow ip route：主網段分組、L 路由、等價多路徑、單筆查詢、沒放進路由表的路');
{
  const { iosSession } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const sessions = new WeakMap();
  const sessOf = (s, id) => { const m = sessions.get(s) || new Map(); sessions.set(s, m); if (!m.has(id)) m.set(id, iosSession(() => s.devices[id], () => s)); return m.get(id); };
  const run = (s, id, line) => { const out = []; const sess = sessOf(s, id); const r = iosRun({ state: s }, id, sess, line, (l, cls) => out.push(cls === 'hint' ? '[hint]' + l : l)); if (r.changed) recompute(s); return out; };
  const solvedState = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); recompute(s); lv.solve(s); recompute(s); advance(s, 60); recomputeNow(s); return s; };
  const s = solvedState('l50');
  const rt = run(s, 'r1', 'show ip route');
  ok(rt.includes('Gateway of last resort is 203.0.113.1 to network 0.0.0.0') && rt.some((l) => /^B\*    0\.0\.0\.0\/0 \[20\/0\] via 203\.0\.113\.1, \d\d:\d\d:\d\d$/.test(l)),
    '預設路由：Gateway of last resort，B* 0.0.0.0/0 後面是存在時間，BGP 的路不寫出介面');
  ok(rt.includes('      192.0.2.0/24 is variably subnetted, 2 subnets, 2 masks') && rt.includes('L        192.0.2.1/32 is directly connected, GigabitEthernet0/0/2')
    && rt.includes('      8.0.0.0/24 is subnetted, 1 subnets') && rt.some((l) => l.startsWith('B        8.8.8.0 [20/0]')), '依主網段分組、介面自己的位址是 L、遮罩都一樣時不印遮罩');
  const one = run(s, 'r1', 'sh ip ro 8.8.8.8');
  ok(one[0] === 'Routing entry for 8.8.8.0/24' && one.includes('  Known via "bgp 65010", distance 20, metric 0') && one.includes('      AS Hops 2'), 'show ip route <位址>：最長相符的那一筆，連同 AS path 長度');
  ok(run(s, 'r1', 'show ip route 9.9.9.9')[0] === '% Network not in table' && run(s, 'r1', 'show ip route 0.0.0.0')[0] === 'Routing entry for 0.0.0.0/0, supernet', '只有預設路由符合的位址：Network not in table（要查預設路由就打 0.0.0.0）');
  run(s, 'r1', 'configure terminal'); run(s, 'r1', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1 250'); run(s, 'r1', 'end');
  const st = run(s, 'r1', 'show ip route static');
  ok(st.some((l) => l.startsWith('[hint]（沒有放進路由表：S* 0.0.0.0/0 [250/0]')), '管理距離 250 的備援預設路由不在路由表裡，畫面上說明原因');
  const dc = solvedState('l48');
  const ecmp = run(dc, 'dc1', 'show ip route ospf');
  const at = ecmp.findIndex((l) => l.startsWith('O        10.10.2.0/24 [110/'));
  ok(at > 0 && /^ {22}\[110\/\d+\] via /.test(ecmp[at + 1]), '等價多路徑：第二條路縮排對齊在第一條的 [ 底下');
  const ia = run(solvedState('l49'), 'br1', 'show ip route');
  ok(ia.some((l) => /^O IA     10\.0\.0\.0\/24 \[110\/\d+\] via /.test(l)), '區域之間的路由是 O IA');
}

console.log('\nIPv6：DHCPv6 的旗標、OSPFv3、IPv6 ACL 與鄰居探索');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { parseIp6 } = await import('../src/engine/ip6.js');
  const { transact6 } = await import('../src/engine/sim6.js');
  const { logRows } = await import('../src/engine/ops.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const sessions = new WeakMap();
  const sessOf = (s, id) => { const m = sessions.get(s) || new Map(); sessions.set(s, m); if (!m.has(id)) m.set(id, iosSession(() => s.devices[id], () => s)); return m.get(id); };
  const run = (s, id, ...lines) => { const out = []; for (const line of lines) { const r = iosRun({ state: s }, id, sessOf(s, id), line, (l) => out.push(l)); if (r.changed) recompute(s); } return out; };
  const fresh = (id) => { const s = LEVELS.find((l) => l.id === id).setup(); recompute(s); return s; };
  const rcOf = (s, id) => [].concat(runningConfig(s, s.devices[id])).join('\n');

  // ── DHCPv6 ──
  {
    const s = fresh('l51');
    const lab = () => s.devices.lab.ifaces[0].rt.v6, pc1 = () => s.devices.pc1.ifaces[0].rt.v6;
    const has = (v, src) => v.addrs.some((a) => a.src === src);
    ok(has(lab(), 'dhcp6') && lab().gw == null && /DHCPv6 不提供預設閘道/.test(lab().note), '收不到 RA 的 Windows 還是會試 stateful DHCPv6：拿到位址，但沒有預設閘道');
    run(s, 'rt', 'configure terminal', 'interface gi0/0/1', 'no ipv6 nd ra suppress', 'ipv6 nd managed-config-flag', 'end');
    ok(has(lab(), 'slaac') && has(lab(), 'dhcp6') && lab().gw != null, 'RA 打開、M 旗標打開，但 A 旗標還開著：SLAAC 與 DHCPv6 各產生一個位址');
    run(s, 'rt', 'configure terminal', 'interface gi0/0/1', 'ipv6 nd prefix default no-autoconfig', 'end');
    ok(!has(lab(), 'slaac') && has(lab(), 'dhcp6') && lab().gw != null, '關掉 A 旗標：位址只剩 DHCPv6 發的，閘道仍然來自 RA');
    run(s, 'rt', 'configure terminal', 'ipv6 dhcp pool OFFICE', 'dns-server 2001:db8:f::53', 'interface gi0/0/0', 'ipv6 nd other-config-flag', 'end');
    ok(pc1().dhcp && !pc1().dhcp.ok && /沒有 DHCPv6 伺服器/.test(pc1().dhcp.why), 'O 旗標打開，但介面沒有 ipv6 dhcp server：主機問不到 DNS');
    run(s, 'rt', 'configure terminal', 'interface gi0/0/0', 'ipv6 dhcp server OFFICE', 'end');
    ok(pc1().dns.includes(parseIp6('2001:db8:f::53')) && has(pc1(), 'slaac') && !has(pc1(), 'dhcp6'), 'stateless DHCPv6：DNS 從位址池拿到，位址仍然是 SLAAC');
    const bind = run(s, 'rt', 'show ipv6 dhcp binding');
    ok(bind.some((l) => /^Client: FE80::/.test(l)) && bind.some((l) => /Address: 2001:DB8:20:/.test(l)), 'show ipv6 dhcp binding 列出實驗室電腦與它的位址（IOS 印大寫）');
    ok(run(s, 'rt', 'show ipv6 interface gi0/0/1').includes('  Hosts use DHCP to obtain routable addresses.'), 'show ipv6 interface 看得到 M 旗標的效果');
    const rc = rcOf(s, 'rt');
    ok(rc.includes('ipv6 dhcp pool OFFICE') && rc.includes(' dns-server 2001:DB8:F::53') && rc.includes(' ipv6 nd prefix default no-autoconfig') && rc.includes(' ipv6 dhcp server LAB'), 'DHCPv6 位址池與介面的旗標都會出現在 running-config');
  }
  // ── OSPFv3 ──
  {
    const s = fresh('l52');
    for (const id of ['r1', 'r2', 'r3']) run(s, id, 'configure terminal', 'interface gi0/0/0', 'ipv6 ospf 1 area 0', 'interface gi0/0/1', 'ipv6 ospf 1 area 0', 'interface gi0/0/2', 'ipv6 ospf 1 area 0', 'end');
    advance(s, 45); recomputeNow(s);
    ok(s.devices.r3.rt.ospf6.norid && run(s, 'r3', 'show ipv6 ospf')[0].startsWith('%OSPFv3-4-NORTRID') && logRows(s, s.devices.r3).some((r) => /OSPFv3-4-NORTRID/.test(r.line)), '純 IPv6 的 R3 選不出 Router ID：OSPFv3 起不來，紀錄裡有 NORTRID');
    ok(s.devices.r2.rt.ospf6.rid === parseIp('10.2.0.1'), 'R2 沒有設定 router-id：自動用最大的 IPv4 位址');
    const f = s.devices.r1.rt.ospf6.ifs['Gi0/0/1'];
    ok(!(s.devices.r1.rt.nbrs6 || []).some((n) => n.dev === 'r2') && f.why.some((w) => /Hello \/ Dead/.test(w)), 'R2 那條線的 Hello 是 5 秒：OSPFv3 鄰居建立不起來，原因寫得出來');
    run(s, 'r3', 'configure terminal', 'ipv6 router ospf 1', 'router-id 3.3.3.3', 'end');
    run(s, 'r2', 'configure terminal', 'interface gi0/0/1', 'no ipv6 ospf hello-interval', 'end');
    advance(s, 45); recomputeNow(s);
    const rt = run(s, 'r1', 'show ipv6 route ospf');
    const k = rt.findIndex((l) => l.startsWith('O   2001:DB8:3::/64 [110/'));
    ok(k > 0 && /^ {5}via FE80::[0-9A-F:]+, GigabitEthernet0\/0\/2$/.test(rt[k + 1]), 'show ipv6 route：OSPFv3 路由的下一站是對方的 link-local');
    ok(run(s, 'r1', 'show ipv6 ospf neighbor').some((l) => /^3\.3\.3\.3 +1 +FULL\//.test(l)) && logRows(s, s.devices.r1).some((r) => /OSPFv3-5-ADJCHG: Process 1, Nbr 3\.3\.3\.3 .* to FULL/.test(r.line)), 'R3 設了 router-id 之後成為 FULL 鄰居，紀錄裡有 OSPFv3-5-ADJCHG');
    // OSPFv3 用 link-local 認識鄰居：R1–R2 兩端的全域前綴不一樣也沒關係
    run(s, 'r2', 'configure terminal', 'interface gi0/0/1', 'ipv6 address 2001:db8:99::2/64', 'end');
    advance(s, 10); recomputeNow(s);
    ok((s.devices.r1.rt.nbrs6 || []).some((n) => n.dev === 'r2' && n.state === 'full'), 'R2 那端的前綴改成 2001:db8:99::/64，OSPFv3 鄰居照樣 FULL（靠 link-local）');
    const rc = rcOf(s, 'r3');
    ok(rc.includes('ipv6 router ospf 1') && rc.includes(' router-id 3.3.3.3') && rc.includes(' ipv6 ospf 1 area 0'), 'OSPFv3 出現在 running-config');
  }
  // ── IPv6 ACL ──
  {
    const s = fresh('l53');
    run(s, 'rt', 'configure terminal', 'interface gi0/0/0', 'ipv6 traffic-filter GUEST6 in', 'end');
    const web = () => transact6(s, 'guest', parseIp6('2001:db8:10::10'), { proto: 'tcp', dport: 80 });
    const r1 = web();
    ok(!r1.ok && /鄰居探索 \(NDP\) 失敗/.test(r1.reason) && /deny ipv6 any any/.test(r1.reason), '套用了以 deny ipv6 any any 結尾的 ACL：鄰居探索被擋，訪客連網站都開不了');
    run(s, 'rt', 'configure terminal', 'ipv6 access-list GUEST6', 'sequence 5 permit icmp any any nd-ns', 'sequence 6 permit icmp any any nd-na', 'end');
    const ssh = transact6(s, 'guest', parseIp6('2001:db8:10::10'), { proto: 'tcp', dport: 22 });
    ok(web().ok && !ssh.ok && /IPv6 ACL「GUEST6」/.test(ssh.reason), '在前面放行 nd-ns / nd-na 之後：網站可以開，SSH 被 GUEST6 擋下');
    ok(run(s, 'rt', 'show ipv6 access-list').some((l) => /permit tcp any host 2001:DB8:10::10 eq 80 \(\d+ match(es)?\) sequence 10/.test(l)), 'show ipv6 access-list 顯示每一條的命中次數與序號');
    const S = sessOf(s, 'rt');
    S.exec('configure terminal'); S.exec('ip dhcp pool TEST');
    ok(S.mode === 'dhcp', 'ip dhcp pool 不會被當成 ipv6 dhcp pool 的縮寫（完整的關鍵字優先）');
    S.exec('end');
    run(s, 'rt', 'configure terminal', 'ipv6 route ::/0 gi0/0/1 fe80::1 200', 'end');
    ok(rcOf(s, 'rt').includes('ipv6 route ::/0 Gi0/0/1 FE80::1 200') && rcOf(s, 'rt').includes(' sequence 5 permit icmp any any nd-ns'), 'ipv6 route 可以寫「出口介面 + link-local 下一站 + 管理距離」，插在中間的 ACL 序號也會寫出來');
  }
}

console.log('\nIKEv2 與 Hub-and-Spoke：版本、IOS 的 ikev2 profile、PFS 要到重新協商才失敗、非對稱金鑰、分公司之間經過總公司');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { fortiSession } = await import('../src/engine/fortios.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const sessions = new WeakMap();
  const sessOf = (s, id) => { const m = sessions.get(s) || new Map(); sessions.set(s, m); if (!m.has(id)) m.set(id, iosSession(() => s.devices[id], () => s)); return m.get(id); };
  const run = (s, id, ...lines) => { const out = []; for (const line of lines) { const r = iosRun({ state: s }, id, sessOf(s, id), line, (l) => out.push(l)); if (r.changed) recompute(s); } return out; };
  const forti = (s, id, ...lines) => { const sess = fortiSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recompute(s); return out; };
  const s = LEVELS.find((l) => l.id === 'l54').setup(); recompute(s);
  const tun = (id, name) => s.devices[id].vpns.find((x) => x.name === name);
  const erp = () => sim.transact(s, 'kh-pc', { proto: 'tcp', dst: parseIp('10.1.0.10'), dport: 443 });
  ok(/IKE 版本不一致/.test(tun('kh', 'HQ').rt.why) && tun('tc', 'HQ').rt.up && tun('tc', 'HQ').rt.ver === 1, '總公司往高雄是 IKEv2、高雄還是 IKEv1：IKE 版本不一致；台中的舊通道 (IKEv1) 照常運作');
  run(s, 'kh', 'configure terminal', 'crypto ikev2 proposal P-AES256', 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'crypto ikev2 policy POL', 'proposal P-AES256',
    'crypto ikev2 keyring KR', 'peer HQ', 'address 203.0.113.18', 'pre-shared-key Hub&Spoke#2026', 'exit', 'exit',
    'crypto ikev2 profile PROF-HQ', 'match identity remote address 203.0.113.18 255.255.255.255', 'authentication remote pre-share', 'authentication local pre-share', 'keyring local KR',
    'crypto map VPN 10', 'set ikev2-profile PROF-HQ', 'end');
  const t = () => tun('kh', 'HQ').rt;
  ok(t().up && t().ver === 2 && /PFS/.test(t().pfsBad) && erp().ok, 'IOS 用 crypto ikev2 profile 建好 IKEv2：總公司開了 PFS、高雄沒有，第一個 CHILD_SA 不做 DH，照樣建得起來（但有警告）');
  ok(run(s, 'kh', 'show crypto ikev2 sa').some((l) => /^1 +192\.0\.2\.66\/500 +203\.0\.113\.18\/500 .*READY$/.test(l)) && run(s, 'kh', 'show crypto isakmp sa').some((l) => /show crypto ikev2 sa/.test(l)), 'show crypto ikev2 sa 是 READY；show crypto isakmp sa 只列 IKEv1 的 SA');
  const rc = [].concat(runningConfig(s, s.devices.kh)).join('\n');
  ok(rc.includes('crypto ikev2 keyring KR\n peer HQ\n  address 203.0.113.18\n  pre-shared-key Hub&Spoke#2026') && rc.includes(' set ikev2-profile PROF-HQ') && !rc.includes('crypto isakmp key'), 'IKEv2 的 keyring、profile 出現在 running-config，不再有 crypto isakmp key');
  advance(s, 3601); recomputeNow(s);
  ok(!t().up && /CHILD_SA 重新協商失敗/.test(t().why) && !erp().ok, '一小時後第一次重新協商 CHILD_SA（要交換 DH）：PFS 不一致，通道斷了');
  run(s, 'kh', 'configure terminal', 'crypto map VPN 10', 'set pfs group14', 'end');
  ok(t().up && !t().pfsBad, '高雄補上 set pfs group14 之後重新協商成功，通道恢復');
  run(s, 'kh', 'configure terminal', 'crypto ikev2 keyring KR', 'peer HQ', 'pre-shared-key local KH-to-HQ!', 'pre-shared-key remote HQ-to-KH!', 'end');
  ok(/AUTHENTICATION_FAILED/.test(t().why), '高雄改成兩把不同的金鑰，總公司還是同一把：IKEv2 驗證失敗 (AUTHENTICATION_FAILED)');
  forti(s, 'hq', 'config vpn ipsec phase1-interface', 'edit "Kaohsiung"', 'set psksecret HQ-to-KH!', 'set psksecret-remote KH-to-HQ!', 'next', 'end');
  ok(t().up, 'FortiGate 用 psksecret / psksecret-remote 對上：IKEv2 兩個方向各用一把金鑰，驗證通過');
  ok(forti(s, 'hq', 'config vpn ipsec phase1-interface', 'edit "Taichung"', 'set psksecret-remote X', 'next', 'end').some((l) => /psksecret-remote 只有 IKEv2/.test(l)), 'IKEv1 的通道不能設 psksecret-remote');
  // Hub-and-Spoke：分公司之間要經過總公司
  const lv = LEVELS.find((l) => l.id === 'l54');
  const s2 = lv.setup(); recompute(s2); lv.solve(s2); recompute(s2);
  const ping = (x) => sim.transact(x, 'tc-pc', { proto: 'icmp', dst: parseIp('10.3.0.50') });
  const r1 = ping(s2);
  const dec = new Set(r1.log.filter((l) => l.kind === 'vpn' && /^解密/.test(l.text)).map((l) => l.dev));
  ok(r1.ok && dec.has('hq') && dec.has('kh') && dec.has('tc'), '台中 → 高雄：在總公司解密、比對政策、再加密送往高雄（回程也一樣經過總公司）');
  const hq = s2.devices.hq;
  hq.policies = hq.policies.filter((x) => !(x.srcIf === 'vpn:Taichung' && x.dstIf === 'vpn:Kaohsiung'));
  recompute(s2);
  ok(!ping(s2).ok && /沒有符合的政策（VPN Taichung → VPN Kaohsiung）/.test(ping(s2).reason), '總公司少了 VPN → VPN 的政策：台中到高雄被擋，原因指出是哪兩個介面');
  const s3 = lv.setup(); recompute(s3); lv.solve(s3); s3.devices.kh.ifaces[0].natSkip = '10.1.0.0/24'; recompute(s3);
  const back = sim.transact(s3, 'kh-pc', { proto: 'icmp', dst: parseIp('10.2.0.50') });
  ok(!back.ok && back.log.some((l) => /先做 NAT 再檢查 VPN/.test(l.text)), '高雄的 NAT 例外沒有加上台中：路由器先 NAT 再加密，往台中的流量沒有進通道');
}

console.log('\n無線控制器與無線環境：CAPWAP、option 43、Local / FlexConnect、RRM、牆面衰減、漫遊');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const sessions = new WeakMap();
  const sessOf = (s, id) => { const m = sessions.get(s) || new Map(); sessions.set(s, m); if (!m.has(id)) m.set(id, iosSession(() => s.devices[id], () => s)); return m.get(id); };
  const run = (s, id, ...lines) => { const out = []; for (const line of lines) { const r = iosRun({ state: s }, id, sessOf(s, id), line, (l) => out.push(l)); if (r.changed) recomputeNow(s); } return out; };
  const fresh = (id) => { const x = LEVELS.find((l) => l.id === id).setup(); recompute(x); return x; };
  // option 43：IOS 的 TLV 寫法
  const s = fresh('l55');
  ok(run(s, 'rt', 'configure terminal', 'ip dhcp pool AP', 'option 43 ip 10.10.10.5').some((l) => /option 43 hex f104\.0a0a\.0a05/.test(l)), 'option 43 寫成 ip 會被拒絕，提示要用 hex（f104.0a0a.0a05）');
  run(s, 'rt', 'option 43 hex f104.0a0a.0a05', 'end');
  ok([].concat(runningConfig(s, s.devices.rt)).includes(' option 43 hex f104.0a0a.0a05'), 'option 43 hex 出現在 DHCP 位址池的 running-config');
  const rec = () => s.dyn.capwap.ap1;
  ok(!rec().joined && /正在加入 WLC（DHCP option 43/.test(rec().why), '拿到 option 43 之後開始加入：CAPWAP Discovery → Join，還沒好');
  advance(s, 26); recomputeNow(s);
  ok(rec().joined && rec().how === 'DHCP option 43' && s.devices.ap1.rt.rrm && s.devices.ap1.rt.rrm.ch24 !== s.devices.ap2.rt.rrm.ch24, '大約 25 秒後加入控制器；RRM 把兩台 AP 分在不同的 2.4 GHz 頻道');
  const nb = () => s.devices.nb1.ifaces.find((i) => i.bind.t === 'wlan').rt;
  ok(nb().assoc && nb().assoc.via === 'wlc' && nb().src === 'apipa' && /DHCP 沒有回應/.test(nb().note), 'Local 模式：筆電連上了（掛在 WLC 上），但控制器的 Trunk 不允許 VLAN 30，DHCP 沒有回應、退回 169.254 的 APIPA');
  run(s, 'sw', 'configure terminal', 'interface gi0/10', 'switchport trunk allowed vlan 10,30', 'end');
  recompute(s);
  const mac = nb().mac.replace(/:/g, '');
  ok(nb().ip != null && run(s, 'sw', 'show mac address-table').some((l) => l.replace(/\./g, '').includes(mac) && /Gi0\/10/.test(l)), 'Trunk 加上 VLAN 30 之後拿到 IP；交換器在接控制器的 Gi0/10 學到筆電的 MAC（流量經 CAPWAP 回到控制器才放出來）');
  ok(run(s, 'wlc', 'show ap summary').some((l) => /^AP-1F-West .*Registered$/.test(l)) && run(s, 'wlc', 'show wireless client summary').some((l) => /Local$/.test(l)), 'show ap summary / show wireless client summary');
  ok(run(s, 'wlc', 'configure terminal').some((l) => /圖形介面/.test(l)), '9800 的 CLI 只能 show：設定請用圖形介面');
  // 同一個網段的廣播：AP 和控制器在同一個 VLAN 就不需要 option 43
  const s2 = fresh('l55');
  for (const p2 of ['Gi0/1', 'Gi0/2']) s2.devices.sw.sw.ports[p2].vlan = 10;
  s2.devices.rt.ifaces.find((i) => i.id === 'Gi0/0/1.10').dhcp = { on: true, pool: 'MGMT', start: '10.10.10.100', end: '10.10.10.199', dns: '', gw: '' };
  recompute(s2);
  ok(s2.dyn.capwap.ap1.joined && s2.dyn.capwap.ap1.how === '同一個網段的廣播', 'AP 和控制器在同一個網段：靠廣播就找得到控制器');
  // FlexConnect：控制器斷線時本地交換的 WLAN 照樣服務；Local 模式的用戶端跟著斷
  const s3 = fresh('l55');
  LEVELS.find((l) => l.id === 'l55').solve(s3); recompute(s3);
  s3.devices.ap2.lwap.mode = 'flex';
  for (const p3 of ['Gi0/2']) Object.assign(s3.devices.sw.sw.ports[p3], { mode: 'trunk', native: 20, allowed: '20,30' });
  recompute(s3);
  const has = (id) => !!s3.devices[id].ifaces.find((i) => i.bind.t === 'wlan').rt.assoc;
  ok(has('nb1') && has('nb2') && s3.devices.nb2.ifaces.find((i) => i.bind.t === 'wlan').rt.ip != null, 'FlexConnect：AP 的埠改成 Trunk（Native VLAN 20），用戶端在 AP 就地放進 VLAN 30，照樣拿到 IP');
  s3.down = { wlc: true }; recompute(s3);
  ok(!has('nb1') && has('nb2') && s3.devices.ap2.rt.capwap.standalone, '控制器斷線：Local 模式的 AP 停止放送，FlexConnect 的 AP 進入 standalone，筆電照樣連著');
  // 牆面衰減
  const s4 = fresh('l56');
  const w = sim.wallsBetween(s4, [0, 3], [6, 3]);
  ok(w.db24 === 12 && w.db5 === 15 && sim.rfAt(s4, s4.devices.ap2, [6.5, 6.5]).band === null, '混凝土牆：2.4 GHz 少 12 dB、5 GHz 少 15 dB；會議室的筆電收不到辦公區的 AP');
  s4.devices.ap2.wifi.power = 'high'; recompute(s4);
  const a4 = s4.devices.nb2.ifaces.find((i) => i.bind.t === 'wlan').rt.assoc;
  ok(a4 && a4.band === '2.4GHz' && a4.rssi < -67 && a4.walls.includes('concrete'), '把功率開到最大：牆後面勉強收得到 2.4 GHz，但訊號不到 -67 dBm');
  // 漫遊
  const lv57 = LEVELS.find((l) => l.id === 'l57');
  const s5 = fresh('l57');
  for (const id of ['apa', 'apb']) s5.devices[id].wifi.ssids[0].kv = true;
  recompute(s5);
  const r5 = sim.runObjective(s5, lv57.objectives[2]);
  ok(!r5.pass && /IP 從 10\.31\.0\.\d+ 變成 10\.32\.0\.\d+/.test(r5.reason), '開了 802.11k/v 會換到 AP-B，但兩台 AP 的 VLAN 不同：IP 從 10.31 變成 10.32，連線會斷');
  ok(sim.runObjective(s5, lv57.objectives[1]).pass, '802.11k/v：基地台建議之後，筆電換到訊號好 8 dB 以上的 AP-B');
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

console.log('\n自動化：YAML、RESTCONF、Ansible');
{
  const { parseYaml, YamlError } = await import('../src/engine/yaml.js');
  const { restconf } = await import('../src/engine/restconf.js');
  const { runPlaybook, parseInventory, template } = await import('../src/engine/automation.js');
  const { runningConfig } = await import('../src/engine/ios.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const yErr = (t) => { try { parseYaml(t); return null; } catch (e) { return e instanceof YamlError ? e : null; } };

  // YAML
  const y = parseYaml('---\n- name: a  # 註解\n  hosts: "sw:core"\n  vars:\n    vl: [10, 20]\n    on: yes\n  tasks:\n    - debug:\n        msg: "x: {{ vl }}"\n    - name: b\n      ios_vlans:\n        config:\n        - vlan_id: 50\n          name: IOT\n');
  ok(y[0].hosts === 'sw:core' && y[0].vars.vl.join() === '10,20' && y[0].vars.on === true && y[0].tasks[0].debug.msg === 'x: {{ vl }}' && y[0].tasks[1].ios_vlans.config[0].vlan_id === 50,
    'YAML：清單裡的 mapping、flow 清單、yes 是 true、引號裡的冒號、清單可以和鍵對齊');
  const tab = yErr('- name: a\n\thosts: all\n'), colon = yErr('- name: a\n  msg: VLAN: 50\n'), quote = yErr('- debug:\n    msg: {{ x }}\n');
  ok(tab && tab.line === 2 && /Tab/.test(tab.message) && colon && /mapping values/.test(colon.message) && colon.line === 2 && quote && quote.quoteHint, 'YAML 的錯誤：Tab 縮排、值裡沒加引號的「: 」、{{ 開頭沒加引號，都指出第幾行');
  const inv = parseInventory('[access]\nsw-a ansible_host=10.0.0.11\n[core]\nsw-core ansible_host=10.0.0.2\n[campus:children]\naccess\ncore\n[campus:vars]\nansible_user=u\n');
  ok(inv.groups.campus.children.length === 2 && inv.hosts['sw-a'].ansible_host === '10.0.0.11' && template('{{ item.name | upper }}-{{ n | default(3) }}', { item: { name: 'iot' } }) === 'IOT-3', 'inventory 的群組 / 子群組 / 變數、Jinja 的變數與 filter');

  // RESTCONF（15-1 解完之後）
  const lv58 = LEVELS.find((l) => l.id === 'l58');
  const s = lv58.setup(); recompute(s); lv58.solve(s); recompute(s);
  const U = { user: 'netauto', pass: 'Aut0mate!26' }, B = 'https://10.20.0.1/restconf/data';
  const rq = (o) => restconf(s, 'auto', { ...U, accept: 'application/yang-data+json', contentType: 'application/yang-data+json', ...o });
  const list = rq({ method: 'GET', url: `${B}/ietf-interfaces:interfaces` });
  const names = list.body['ietf-interfaces:interfaces'].interface.map((x) => x.name);
  ok(list.status === 200 && names.includes('GigabitEthernet0/0/0') && names.includes('Loopback100') && JSON.parse(list.text)['ietf-interfaces:interfaces'], 'GET 介面清單：200、JSON、名稱用完整的 GigabitEthernet0/0/0');
  const xml = restconf(s, 'auto', { ...U, method: 'GET', url: `${B}/Cisco-IOS-XE-native:native/hostname` });
  ok(xml.ctype === 'application/yang-data+xml' && xml.text.startsWith('<hostname xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-native">R1</hostname>'), '沒有 Accept 標頭：IOS XE 回 XML');
  const codes = [
    rq({ method: 'GET', url: `${B}/ietf-interfaces:interfaces`, pass: 'wrong' }).status,
    rq({ method: 'GET', url: `${B}/ietf-interfaces:interfaces/interface=GigabitEthernet0/0/9` }).status,
    rq({ method: 'POST', url: `${B}/ietf-interfaces:interfaces`, contentType: 'application/json', body: '{}' }).status,
    rq({ method: 'POST', url: `${B}/ietf-interfaces:interfaces`, body: '{"ietf-interfaces:interface": {"name": "Loopback100",}}' }).status,
    rq({ method: 'POST', url: `${B}/ietf-interfaces:interfaces`, body: '{"ietf-interfaces:interface": {"name": "Loopback100"}}' }).status,
    rq({ method: 'DELETE', url: `${B}/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0%2F1` }).status,
    rq({ method: 'DELETE', url: `${B}/Cisco-IOS-XE-native:native/hostname` }).status,
  ];
  ok(codes.join() === '401,404,415,400,409,400,405', `錯誤碼：401 密碼錯、404 路徑不存在、415 Content-Type、400 JSON 格式、409 已存在、400 刪實體介面、405 方法不支援（${codes.join()}）`);
  const put = rq({ method: 'PUT', url: `${B}/ietf-interfaces:interfaces/interface=Loopback100`, body: '{"ietf-interfaces:interface": {"name": "Loopback100", "description": "only-desc"}}' });
  const lo = s.devices.rt.ifaces.find((i) => i.bind.t === 'loop');
  ok(put.status === 204 && lo.desc === 'only-desc' && !lo.ip, 'PUT 是整個取代：只寫 description，原本的 IP 被拿掉了（PATCH 才是部分修改）');
  ok(runningConfig(s, s.devices.rt).includes(' description WAN-to-ISP') && runningConfig(s, s.devices.rt).includes('restconf'), '用 API 改的設定出現在 running-config（description、restconf）');
  ok(rq({ method: 'DELETE', url: `${B}/ietf-interfaces:interfaces/interface=Loopback100` }).status === 204 && !s.devices.rt.ifaces.some((i) => i.bind.t === 'loop'), 'DELETE 刪除 Loopback');
  const t5 = (await import('../src/engine/ops.js')).logRows(s, s.devices.rt);
  ok(t5.some((r) => /DMI-5-CONFIG_I/.test(r.tag || r.text || JSON.stringify(r))), '設備的紀錄寫下 %DMI-5-CONFIG_I（Configured from NETCONF/RESTCONF）');
  s.devices.rt.mgmt.restconf = false;
  ok(rq({ method: 'GET', url: `${B}/ietf-interfaces:interfaces` }).status === 404, '沒有啟用 restconf：404');

  // Ansible（15-2）
  const lv59 = LEVELS.find((l) => l.id === 'l59');
  const a = lv59.setup(); recompute(a);
  const ctl = a.devices.ctl.ansible;
  const run = (o = {}) => runPlaybook(a, 'ctl', { inventory: ctl.inventory, playbook: ctl.playbook, file: 'vlan50.yml', ...o });
  const r0 = run();
  ok(r0.rc === 4 && /conflicting action statements: cisco\.ios\.ios_l2_interfaces, config/.test(r0.lines[0].t) && r0.lines.some((l) => /line 15, column 7/.test(l.t)), '同事的 playbook：模組參數沒縮排 → conflicting action statements，指出第 15 行');
  ctl.playbook = ctl.playbook.replace(/\n {6}config:\n {8}- name: GigabitEthernet0\/5\n {10}mode: access\n {10}access:\n {12}vlan: 50\n {6}state: merged/, '\n        config:\n          - name: GigabitEthernet0/5\n            mode: access\n            access:\n              vlan: 50\n        state: merged');
  const r1 = run();
  ok(Object.values(r1.recap).every((x) => x.failed === 1) && r1.lines.some((l) => /Connection type ssh is not valid/.test(l.t)), '沒有 ansible_connection=network_cli：每台都 FAILED');
  ctl.inventory += 'ansible_connection=ansible.netcommon.network_cli\n';
  const chk = run({ check: true });
  ok(a.devices.swa.sw.vlans.every((v) => v.id !== 50) && chk.recap['sw-a'].changed === 2, '--check：回報會改 (changed)，但設備沒有真的被改');
  const r2 = run();
  ok(r2.recap['sw-c'].unreachable === 1 && r2.recap['sw-a'].changed === 2 && a.devices.swa.sw.vlans.some((v) => v.id === 50 && v.name === 'IOT') && a.devices.swa.sw.ports['Gi0/5'].vlan === 50,
    'SW-C 沒有 netadmin 帳號 → UNREACHABLE；其他三台建立 VLAN 50、Gi0/5 放進 VLAN 50');
  ok(runningConfig(a, a.devices.swa).includes('vlan 50') && (await import('../src/engine/ops.js')).logRows(a, a.devices.swa).some((r) => /Configured from console by netadmin on vty/.test(JSON.stringify(r))), 'Ansible 是用 SSH 登入下指令：紀錄寫著 Configured from console by netadmin on vty');
  const r3 = run();
  ok(r3.recap['sw-a'].changed === 0 && r3.recap['sw-a'].ok === 2, '再跑一次：已經設定好的交換器是 ok、changed=0（冪等）');
  ctl.playbook += '\n- name: trunk\n  hosts: access\n  gather_facts: no\n  tasks:\n    - name: add\n      cisco.ios.ios_config:\n        parents: interface GigabitEthernet0/9\n        lines:\n          - switchport trunk allowed vlan add 50\n';
  run(); const r4 = run();
  ok(r4.recap['sw-a'].changed === 1 && a.devices.swa.sw.ports['Gi0/9'].allowed.split(',').includes('50'), 'ios_config 送 allowed vlan add：每次都 changed（不冪等），和真的 Ansible 一樣');
  const fx = runPlaybook(a, 'ctl', { inventory: ctl.inventory, file: 'f.yml', playbook: '- hosts: sw-a\n  gather_facts: yes\n  vars:\n    vl: [{id: 61, n: CAM}, {id: 62, n: BMS}]\n  tasks:\n    - cisco.ios.ios_vlans:\n        config:\n          - vlan_id: "{{ item.id }}"\n            name: "{{ item.n }}"\n      loop: "{{ vl }}"\n    - debug:\n        var: ansible_net_iostype\n    - cisco.ios.ios_command:\n        commands: [show vlan brief]\n      register: out\n      when: ansible_net_iostype == \'IOS\'\n    - assert:\n        that: [out.stdout | length > 0]\n' });
  ok(fx.rc === 0 && a.devices.swa.sw.vlans.some((v) => v.id === 62 && v.name === 'BMS') && fx.lines.some((l) => l.t.includes("(item={'id': 61, 'n': 'CAM'})")) && fx.lines.some((l) => l.t.includes('"ansible_net_iostype": "IOS"')),
    'Gathering Facts、loop 的 item、debug var、when、register 與 assert');
}

console.log('\n雲端：VPC、IGW 與 EIP、NAT 閘道、安全群組、網路 ACL、站對站 VPN');
{
  const { naclCheck, vpnConfig, reservedWhy } = await import('../src/engine/cloud.js');
  const { runningConfig } = await import('../src/engine/ios.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const solvedCloud = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); recompute(s); lv.solve(s); recompute(s); return s; };
  const ip = parseIp;
  const s = solvedCloud('l60'), v = s.devices.aws.vpc;
  const tcp = (from, dst, port, srcIp) => transact(s, from, { proto: 'tcp', dst: ip(dst), dport: port, ...(srcIp ? { srcIp: ip(srcIp) } : {}) });
  const web = tcp('inet', '54.199.20.10', 443);
  ok(web.ok && web.log.some((l) => /一對一 NAT/.test(l.text)) && web.log.some((l) => /來源 10\.50\.1\.10 換成 EIP 54\.199\.20\.10/.test(l.text)), 'IGW 的一對一 NAT：進來 EIP → 私有 IP，回應的來源換回 EIP');
  const ping = transact(s, 'inet', { proto: 'icmp', dst: ip('54.199.20.10') });
  ok(!ping.ok && /ICMP/.test(ping.reason) && /安全群組/.test(ping.reason), 'ping 不通：安全群組沒有允許 ICMP（HTTPS 卻可以）');
  v.instances[0].eip = '';
  recompute(s);
  const noEip = tcp('aws', '93.184.216.34', 443, '10.50.1.10');
  ok(!noEip.ok && /沒有公用 IP/.test(noEip.reason), '沒有彈性 IP 的執行個體從 IGW 出不去');
  v.instances[0].eip = '54.199.20.10';
  v.rts[0].routes = [];
  recompute(s);
  const asym = tcp('inet', '54.199.20.10', 443);
  ok(!asym.ok && asym.phase === 'reply' && /路由表/.test(asym.reason), '路由表沒有 0.0.0.0/0 → igw：封包進得來，回應卻出不去（回程失敗）');
  ok(reservedWhy(ip('10.50.1.1'), v.subnets[0]).includes('VPC 路由器') && reservedWhy(ip('10.50.1.255'), v.subnets[0]) && !reservedWhy(ip('10.50.1.4'), v.subnets[0]), 'AWS 保留每個子網路的前四個與最後一個位址');
  const acl = { in: [{ n: 200, act: 'allow', proto: 'tcp', port: '443', cidr: '0.0.0.0/0' }, { n: 100, act: 'deny', proto: 'tcp', port: '443', cidr: '198.51.100.0/24' }] };
  ok(naclCheck(acl, 'in', { proto: 'tcp' }, ip('198.51.100.77'), 443) === '規則 #100 拒絕' && naclCheck(acl, 'in', { proto: 'tcp' }, ip('8.8.8.8'), 443) === null && /\*/.test(naclCheck(acl, 'in', { proto: 'udp' }, ip('8.8.8.8'), 53)), '網路 ACL 依規則編號比對（不是依清單順序），最後是 * 拒絕');

  const p = solvedCloud('l61'), pv = p.devices.aws.vpc;
  const pt = (from, dst, port, srcIp) => transact(p, from, { proto: 'tcp', dst: ip(dst), dport: port, ...(srcIp ? { srcIp: ip(srcIp) } : {}) });
  const upd = pt('aws', '93.184.216.34', 443, '10.50.2.20');
  ok(upd.ok && upd.log.some((l) => /NAT 閘道 .*來源 10\.50\.2\.20 換成 54\.199\.20\.11/.test(l.text)), 'db-1 經由 NAT 閘道連外：來源換成 NAT 閘道的 EIP');
  ok(!transact(p, 'inet', { proto: 'tcp', dst: ip('54.199.20.11'), dport: 3306 }).ok, '外面主動連 NAT 閘道的 EIP：一律丟棄');
  const vpn = pt('pc', '10.50.2.20', 3306);
  ok(vpn.ok && vpn.log.some((l) => /加密/.test(l.text)) && vpn.log.some((l) => /VPN：送達 db-1/.test(l.text)), '公司 PC 經由 IKEv2 通道連到私有子網路的 db-1');
  ok(runningConfig(p, p.devices.rt).includes('crypto map AWS-MAP 10 ipsec-isakmp') && /crypto ikev2 keyring AWS-KR/.test(runningConfig(p, p.devices.rt).join('\n')), '「下載設定檔」的 IOS 設定可以直接貼到 ISR（通道建立）');
  const saved = JSON.stringify(pv.nacls);
  pv.nacls.find((a) => a.name === 'acl-private').out = [{ n: 100, act: 'allow', proto: 'tcp', port: '3306', cidr: '10.50.0.0/16' }];
  recompute(p);
  const back = pt('aws', '10.50.2.20', 3306, '10.50.1.10');
  ok(!back.ok && back.phase === 'reply' && /無狀態/.test(back.reason), '網路 ACL 的輸出只允許 3306：web-1 的請求到了，db-1 的回應（臨時連接埠）被擋');
  pv.nacls = JSON.parse(saved);
  pv.rts.find((r) => r.name === 'rtb-private').prop = false;
  recompute(p);
  const noProp = pt('pc', '10.50.2.20', 3306);
  ok(!noProp.ok && noProp.phase === 'reply', '關掉路由傳播：VPN 的請求進得來，db-1 的回應找不到往 10.20.0.0/24 的路');
  pv.rts.find((r) => r.name === 'rtb-private').prop = true;
  pv.natgws[0].subnet = 'subnet-0prv1a';
  recompute(p);
  const badNat = pt('aws', '93.184.216.34', 443, '10.50.2.20');
  ok(!badNat.ok && /公有/.test(badNat.reason), 'NAT 閘道放在私有子網路：自己也出不去');
  const fg = vpnConfig(p.devices.aws, p.devices.aws.vpns[0], 'forti');
  ok(fg.includes('set remote-gw 54.199.20.2') && fg.includes('set ike-version 2'), 'FortiGate 版本的設定檔');
}

console.log('\n故障演練與模擬考');
{
  const { injectFaults, drillable, faultCandidates } = await import('../src/engine/faults.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const solvedOf = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); recompute(s); lv.solve(s); settle(s); return { lv, s }; };
  let all = true, kinds = new Set(), n = 0;
  for (const id of ['l07', 'l10', 'l12', 'l18', 'l24', 'l25', 'l47', 'l55', 'l60']) {
    const a = solvedOf(id), b = solvedOf(id);
    const fa = injectFaults(a.s, a.lv.objectives, { count: 2, seed: 42 }).faults, fb = injectFaults(b.s, b.lv.objectives, { count: 2, seed: 42 }).faults;
    settle(a.s);
    const broken = evaluate(a.s, a.lv.objectives).filter((r) => !r.pass).length;
    if (!fa.length || !broken || fa.map((f) => f.text).join() !== fb.map((f) => f.text).join() || new Set(fa.map((f) => f.dev)).size !== fa.length) { all = false; console.log('      ' + id, fa.map((f) => f.text)); }
    for (const f of fa) kinds.add(f.kind);
    n += fa.length;
  }
  ok(all, '隨機故障：每個網路都挑到會讓目標失敗的故障、同一個種子結果一樣、一台設備最多壞一個地方');
  ok(kinds.size >= 6, `故障的種類夠多樣（${n} 個故障裡有 ${kinds.size} 種）`);
  const { s: s7, lv: l7 } = solvedOf('l07');
  const one = injectFaults(s7, l7.objectives, { count: 1, seed: 3 }).faults[0];
  const fixed = solvedOf('l07').s;
  ok(one && faultCandidates(fixed).some((f) => f.text === one.text), '故障的說明可以對回原本的設定（揭曉答案時用）');
  ok(!drillable(LEVELS.find((l) => l.id === 'l57')) && drillable(LEVELS.find((l) => l.id === 'l07')), '依賴移動或等待的關卡不拿來做演練');

  const { buildExam, EXAMS } = await import('../src/ui/exam.js');
  const ex = buildExam('ccna', 20);
  const per = {};
  for (const q of ex) per[q.dom] = (per[q.dom] || 0) + 1;
  ok(ex.length === 20 && JSON.stringify(per) === JSON.stringify({ 1: 4, 2: 4, 3: 5, 4: 2, 5: 3, 6: 2 }) && ex.every((q) => q.a.length >= 2 && q.c >= 0 && q.c < q.a.length), 'CCNA 模擬考依領域比重配題（20 題：4/4/5/2/3/2），選項打亂之後正確答案仍然對得上');
  const np = buildExam('netplus', 40);
  ok(np.length === 40 && EXAMS.netplus.domains.every(([d]) => np.some((q) => q.dom === d)) && new Set(np.map((q) => q.q)).size >= 36, 'Network+ 模擬考：40 題、五個領域都有、題目幾乎不重複');
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
