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
      // 有些設定要存檔、重新開機才生效（Catalyst 2960 的 system mtu jumbo）：工程師貼完也會這樣做
      if ((lv.pasteReload || []).includes(d.id)) { type(s2, d.id, ['write memory', 'reload', '']); recompute(s2); }
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
  const { makeState, makeDevice } = await import('../src/engine/model.js');
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

console.log('\nerr-disabled：會一直維持、errdisable recovery、shutdown → no shutdown');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { removeCable, addCable } = await import('../src/engine/model.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const lv = LEVELS.find((l) => l.id === 'l32');
  const fresh = () => { const s = lv.setup(); settle(s); lv.solve(s); settle(s); return s; };
  const logs = (s, id) => ((s.dyn.log || {})[id] || []).map((x) => x.line).join('\n');
  const rogueCable = (s) => s.cables.find((c) => [c.a, c.b].some((e) => e.dev === 'sw-a' && e.port === 'Gi0/5'));
  {
    const s = fresh(), sa = s.devices['sw-a'];
    ok(sa.rt.err['Gi0/5'] === 'bpdu' && s.dyn.errdis['sw-a:Gi0/5'].cause === 'bpdu' && /BPDU Guard/.test(s.rt.why[rogueCable(s).id]), 'BPDU Guard 把 Gi0/5 關成 err-disabled，並記下來');
    removeCable(s, rogueCable(s).id); settle(s);
    ok(sa.rt.err['Gi0/5'] === 'bpdu' && !sim.pendingOf(s).some((p) => p.kind === 'errdis'), '拔掉私接的交換器之後埠不會自己恢復（沒有設定 recovery，也不會出現在收斂中）');
    ios(s, 'sw-a', ['conf t', 'interface gi0/5', 'shutdown', 'end']);
    ok(!s.dyn.errdis['sw-a:Gi0/5'] && !sa.rt.err['Gi0/5'], 'shutdown 之後 err-disabled 解除（變成 administratively down）');
    ios(s, 'sw-a', ['conf t', 'interface gi0/5', 'no shutdown', 'end']);
    ok(!sa.rt.err['Gi0/5'] && !s.dyn.errdis['sw-a:Gi0/5'], 'no shutdown：原因已經排除，埠正常啟用');
  }
  {
    const s = fresh(), sa = s.devices['sw-a'];
    const out = ios(s, 'sw-a', ['conf t', 'errdisable recovery cause bpdu', 'errdisable recovery interval 60', 'end']);
    const rc = runningConfig(s, sa).join('\n');
    ok(!out.some((l) => /^%/.test(l)) && /errdisable recovery cause bpduguard\nerrdisable recovery interval 60\n!\nspanning-tree mode/.test(rc), 'errdisable recovery cause / interval（縮寫 bpdu 也認得），running-config 印在 spanning-tree 前面');
    ok(/% Invalid input/.test(ios(s, 'sw-a', ['conf t', 'errdisable recovery cause nope', 'end']).join('\n')) && /<30-86400>/.test(ios(s, 'sw-a', ['conf t', 'errdisable recovery interval 5', 'end']).join('\n')), '不認得的原因、太短的計時器會被拒絕');
    const n0 = s.dyn.errdis['sw-a:Gi0/5'].n;
    sim.advance(s, 61);
    ok(sa.rt.err['Gi0/5'] === 'bpdu' && s.dyn.errdis['sw-a:Gi0/5'].n === n0 + 1 && /PM-4-ERR_RECOVER: Attempting to recover from bpduguard err-disable state on Gi0\/5[\s\S]*ERR_DISABLE: bpduguard error detected on Gi0\/5/.test(logs(s, 'sw-a')),
      '計時器到了試著打開，對面還是交換器就馬上再被關掉（紀錄裡有 ERR_RECOVER 與再一次 ERR_DISABLE）');
    removeCable(s, rogueCable(s).id); recomputeNow(s);
    const p = sim.pendingOf(s).find((x) => x.kind === 'errdis');
    ok(p && p.at > s.clock && p.at <= s.clock + 60, '原因排除之後，recovery 的計時器出現在「收斂中」');
    settle(s);
    ok(!sa.rt.err['Gi0/5'] && !s.dyn.errdis['sw-a:Gi0/5'], '計時器到了，埠自己恢復');
  }
  {
    // Port Security（shutdown 模式）也一樣：違規的設備拔掉之後還是 err-disabled
    const l17 = LEVELS.find((l) => l.id === 'l17');
    const s = l17.setup(); settle(s); l17.solve(s); settle(s);
    s.devices.sw.sw.ports['Gi0/3'].ps.mode = 'shutdown'; settle(s);
    const was = s.devices.sw.rt.err['Gi0/3'] === true;
    const c = s.cables.find((x) => [x.a, x.b].some((e) => e.dev === 'sw' && e.port === 'Gi0/3'));
    removeCable(s, c.id); settle(s);
    ok(was && s.devices.sw.rt.err['Gi0/3'] === true && s.dyn.errdis['sw:Gi0/3'].cause === 'psec', 'Port Security 違規關掉的埠，拔掉線之後還是 err-disabled');
    sim.bouncePort(s, s.devices.sw, 'Gi0/3'); settle(s);
    ok(!s.devices.sw.rt.err['Gi0/3'], '圖形介面的「重新啟用」（shutdown → no shutdown）');
  }
  {
    // 存檔再讀回：err-disabled 的狀態還在
    const s = fresh();
    const s2 = cloneState(s); recomputeNow(s2);
    ok(s2.devices['sw-a'].rt.err['Gi0/5'] === 'bpdu', '存檔再讀回，err-disabled 的狀態還在');
    // 重新開機會清掉（BPDU Guard 要先存進 startup-config，不然開機之後就沒了）
    const at0 = s2.dyn.errdis['sw-a:Gi0/5'].at;
    ios(s2, 'sw-a', ['write memory', 'reload', '']);
    sim.advance(s2, 5);
    const during = !s2.dyn.errdis['sw-a:Gi0/5'];
    sim.advance(s2, 300); settle(s2);
    ok(during && s2.dyn.errdis['sw-a:Gi0/5'] && s2.dyn.errdis['sw-a:Gi0/5'].at > at0 && s2.devices['sw-a'].rt.err['Gi0/5'] === 'bpdu', '重新開機時清掉；開機後對面還是交換器，重新偵測成新的一筆');
  }
}

console.log('\nHSRP / VRRP、物件追蹤與 IP SLA');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const ios = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); const out = []; for (const l of lines) out.push(...sess.exec(l).out); recomputeNow(s); return out; };
  const st = (s, id) => s.devices[id].ifaces.find((i) => i.label === 'Gi0/0/1').rt.vrrp;
  const logs = (s, id) => ((s.dyn.log || {})[id] || []).map((x) => x.line).join('\n');
  const l25 = LEVELS.find((l) => l.id === 'l25');
  const hsrp = (preB) => {
    const s = l25.setup(); settle(s);
    for (const id of ['pc-1', 'pc-2']) s.devices[id].ifaces[0].gateway = '10.0.10.1';
    ios(s, 'gw-a', ['conf t', 'interface gi0/0/1', 'standby 1 ip 10.0.10.1', 'standby 1 priority 110', 'standby 1 preempt', 'end']);
    ios(s, 'gw-b', ['conf t', 'interface gi0/0/1', 'standby 1 ip 10.0.10.1', ...(preB ? ['standby 1 preempt'] : []), 'end']);
    settle(s);
    return s;
  };
  {
    const s = hsrp(false);
    const rc = runningConfig(s, s.devices['gw-a']).join('\n');
    ok(st(s, 'gw-a').state === 'master' && st(s, 'gw-b').state === 'backup' && / standby 1 ip 10\.0\.10\.1\n standby 1 priority 110\n standby 1 preempt/.test(rc) && !/ vrrp /.test(rc),
      'HSRP：standby 1 ip / priority / preempt，GW-A 是 Active，running-config 印 standby 而不是 vrrp');
    ok(evaluate(s, l25.objectives).every((r) => r.pass), 'HSRP 也能完成「閘道備援」的全部目標');
    // 介面追蹤：上行斷了扣 20，優先權 90 < 100，但 GW-B 沒有 preempt，不會搶
    ios(s, 'gw-a', ['conf t', 'track 1 interface Gi0/0/0 line-protocol', 'exit', 'interface gi0/0/1', 'standby 1 track 1 decrement 20', 'end']);
    ios(s, 'gw-a', ['conf t', 'interface gi0/0/0', 'shutdown', 'end']); settle(s);
    ok(st(s, 'gw-a').state === 'master' && st(s, 'gw-a').prio === 90 && /TRACK-6-STATE: 1 interface Gi0\/0\/0 line-protocol Up -> Down/.test(logs(s, 'gw-a')),
      'track 1 的上行 down：GW-A 的優先權降到 90，但 GW-B 沒有 preempt，GW-A 還是 Active（真實世界常見的陷阱）');
    ios(s, 'gw-b', ['conf t', 'interface gi0/0/1', 'standby 1 preempt', 'end']); settle(s);
    ok(st(s, 'gw-b').state === 'master' && st(s, 'gw-a').state === 'backup' && /HSRP-5-STATECHANGE: GigabitEthernet0\/0\/1 Grp 1 state Standby -> Active/.test(logs(s, 'gw-b')),
      'GW-B 加上 standby 1 preempt：馬上搶成 Active，紀錄裡有 %HSRP-5-STATECHANGE');
    ios(s, 'gw-a', ['conf t', 'interface gi0/0/0', 'no shutdown', 'end']); settle(s);
    ok(st(s, 'gw-a').state === 'master' && st(s, 'gw-a').prio === 110, '上行恢復：GW-A 回到 110，靠自己的 preempt 搶回 Active');
  }
  {
    // HSRP 預設不搶：GW-A 重開機回來之後還是 Standby
    const s = l25.setup(); settle(s);
    ios(s, 'gw-a', ['conf t', 'interface gi0/0/1', 'standby 1 ip 10.0.10.1', 'standby 1 priority 110', 'end']);
    ios(s, 'gw-b', ['conf t', 'interface gi0/0/1', 'standby 1 ip 10.0.10.1', 'end']);
    settle(s);
    s.down = { 'gw-a': true }; recomputeNow(s);
    const pend = sim.pendingOf(s).find((p) => p.kind === 'vrrp');
    ok(pend && Math.round(pend.at - s.clock) === 10, 'HSRP 的 holdtime 是 10 秒：GW-A 斷電後 GW-B 要等 10 秒才接手');
    settle(s);
    delete s.down; settle(s); sim.advance(s, 200); settle(s);
    ok(st(s, 'gw-b').state === 'master' && st(s, 'gw-a').state === 'backup', 'HSRP 預設沒有 preempt：優先權比較高的 GW-A 開機回來，還是 Standby');
  }
  {
    // 群組號碼不同：兩台各做各的，同時當 Active
    const s = l25.setup(); settle(s);
    ios(s, 'gw-a', ['conf t', 'interface gi0/0/1', 'standby 1 ip 10.0.10.1', 'end']);
    ios(s, 'gw-b', ['conf t', 'interface gi0/0/1', 'standby 2 ip 10.0.10.1', 'end']);
    settle(s);
    ok(st(s, 'gw-a').state === 'master' && st(s, 'gw-b').state === 'master' && st(s, 'gw-a').odd && st(s, 'gw-a').odd.grp === 2, '群組號碼不一致：兩台都是 Active，並指出對方用的群組');
    const bad = ios(s, 'gw-a', ['conf t', 'interface gi0/0/1', 'vrrp 0 ip 10.0.10.1', 'standby 1 priority 300', 'end']).join('\n');
    ok(/1 – 255/.test(bad) && /1 – 255/.test(bad), 'VRRP 群組從 1 開始、HSRP 的 priority 最大 255');
  }
  {
    // IP SLA + 靜態路由的 track：業者內部故障也能切換
    const l22 = LEVELS.find((l) => l.id === 'l22');
    const s = l22.setup(); l22.solve(s); settle(s);
    // 探測目標用一條主機路由綁在 ISP-A 上（Cisco 文件的建議做法）：預設路由撤掉之後，探測也不會改走 ISP-B
    const out = ios(s, 'rt', ['conf t', 'ip route 1.1.1.1 255.255.255.255 203.0.113.1', 'ip sla 1', 'icmp-echo 1.1.1.1 source-interface Gi0/0/0', 'frequency 10', 'exit', 'ip sla schedule 1 life forever start-time now',
      'track 1 ip sla 1 reachability', 'exit', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1 track 1', 'end']);
    settle(s);
    const rc = runningConfig(s, s.devices.rt).join('\n');
    const dflt = () => s.devices.rt.rt.routes.filter((r) => r.bits === 0 && !r.bad).sort((a, b) => a.ad - b.ad)[0];
    ok(!out.some((l) => /^%|Invalid/.test(l)) && /track 1 ip sla 1 reachability/.test(rc) && /ip route 0\.0\.0\.0 0\.0\.0\.0 203\.0\.113\.1 track 1/.test(rc)
      && /ip sla 1\n icmp-echo 1\.1\.1\.1 source-interface GigabitEthernet0\/0\/0\n frequency 10\nip sla schedule 1 life forever start-time now/.test(rc), 'ip sla、track、ip route … track 都出現在 running-config');
    ok(dflt().via === parseIp('203.0.113.1') && s.dyn.sla['rt/1'].ok, 'IP SLA 探測成功：預設路由走 ISP-A');
    s.devices['isp-a'].inet.fault = true; recomputeNow(s);
    const p = sim.pendingOf(s).find((x) => x.kind === 'sla');
    ok(dflt().via === parseIp('203.0.113.1') && p && p.at - s.clock <= 10, '業者內部故障：介面還是 up，要等下一次探測（10 秒內）才會發現');
    settle(s);
    ok(dflt().via === parseIp('198.51.100.1') && !s.dyn.sla['rt/1'].ok && /TRACK-6-STATE: 1 ip sla 1 reachability Up -> Down/.test(logs(s, 'rt')), '探測失敗 → track 1 Down → 追蹤的路由撤掉，改走 ISP-B（浮動靜態路由）');
    sim.advance(s, 60); settle(s);
    ok(dflt().via === parseIp('198.51.100.1'), '探測目標綁在 ISP-A：改走 ISP-B 之後探測還是失敗，不會來回跳');
    ok(sim.runObjective(s, { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443 }).pass, 'ISP-A 骨幹故障時 PC-1 還是能開網站（探測目標 1.1.1.1 不是使用者的 DNS，綁在 ISP-A 也不影響上網）');
    delete s.devices['isp-a'].inet.fault; settle(s); sim.advance(s, 11); settle(s);
    ok(dflt().via === parseIp('203.0.113.1'), '業者修好之後，下一次探測成功就切回 ISP-A');
    // 沒有 start-time now：排程是 pending，track 一直是 Down
    const s2 = l22.setup(); l22.solve(s2); settle(s2);
    const o2 = ios(s2, 'rt', ['conf t', 'ip sla 2', 'icmp-echo 8.8.8.8', 'exit', 'ip sla schedule 2 life forever', 'track 2 ip sla 2 reachability', 'end']);
    settle(s2);
    ok(o2.some((l) => /pending/.test(l)) && !s2.dyn.sla['rt/2'], 'ip sla schedule 沒寫 start-time now：操作是 pending，不會開始探測');
  }
}

console.log('\n設定封存與變更紀錄：archive、show archive config differences、archive log config、configure replace');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { cfgDiff, archiveFiles } = await import('../src/engine/archive.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const sess = (s, id, who) => iosSession(() => s.devices[id], () => s, who);
  const run = (S, s, lines) => { const out = []; for (const l of lines) out.push(...S.exec(l).out); recomputeNow(s); return out; };
  const lv = LEVELS.find((l) => l.id === 'l18');
  const s = lv.setup(); settle(s);
  const rt = s.devices.rt, con = sess(s, 'rt');
  const o1 = run(con, s, ['conf t', 'archive', 'path flash:archive', 'maximum 3', 'write-memory', 'log config', 'logging enable', 'notify syslog contenttype plaintext', 'hidekeys', 'end', 'write memory']);
  const rc = runningConfig(s, rt).join('\n');
  ok(!o1.some((l) => /^%|Invalid/.test(l)) && /archive\n log config\n  logging enable\n  notify syslog contenttype plaintext\n  hidekeys\n path flash:archive\n maximum 3\n write-memory/.test(rc), 'archive 與 log config 的設定出現在 running-config（和真的 IOS 一樣的順序）');
  ok(rt.flash.files['archive-1'] && rt.flash.files['archive-1'].lines.join('\n') === runningConfig(s, rt).join('\n'), 'write memory 時自動封存成 flash:archive-1');
  const vty = sess(s, 'rt', { user: 'bob', line: 'vty 0', ip: '10.0.0.66' });
  run(vty, s, ['conf t', 'ip route 10.9.9.0 255.255.255.0 192.0.2.1', 'interface Gi0/0/1', 'description changed-by-bob', 'exit', 'username bob secret Pass#123', 'end']);
  const diff = cfgDiff(rt.flash.files['archive-1'].lines, runningConfig(s, rt));
  ok(diff.includes('+ip route 10.9.9.0 255.255.255.0 192.0.2.1') && diff.includes('interface GigabitEthernet0/0/1') && diff.includes(' +description changed-by-bob'),
    'show archive config differences：+ip route、interface 底下的 +description（Contextual Config Diffs）');
  const log = s.dyn.cfglog.rt;
  ok(log.some((e) => e.user === 'bob' && e.line === 'vty0' && e.cmd === ' description changed-by-bob') && log.some((e) => e.cmd === 'username bob secret *****') && log[0].cmd === 'logging enable',
    'archive log config：記下 bob@vty0 打的每一行（子模式前面空一格），hidekeys 把密碼換成 *****');
  ok(((s.dyn.log || {}).rt || []).some((x) => /%PARSER-5-CFGLOG_LOGGEDCMD: User:bob  logged command:ip route 10\.9\.9\.0/.test(x.line)), 'notify syslog：每一行設定同時送出 %PARSER-5-CFGLOG_LOGGEDCMD');
  const o2 = run(con, s, ['configure replace flash:archive-1', 'y']);
  const rc2 = runningConfig(s, rt).join('\n');
  ok(o2.some((l) => l === 'Rollback Done') && !/10\.9\.9\.0/.test(rc2) && !/changed-by-bob/.test(rc2), 'configure replace flash:archive-1：整份換回封存的內容（多出來的路由、description 都不見了）');
  for (let k = 0; k < 4; k++) run(con, s, ['write memory']);
  ok(archiveFiles(rt).length === 3 && !rt.flash.files['archive-1'] && rt.flash.files['archive-5'], 'maximum 3：只留最近的三份，最舊的自動刪掉');
  const o3 = run(con, s, ['configure replace flash:nope force']);
  ok(o3.some((l) => /No such file/.test(l)), 'configure replace 不存在的檔案：%Error opening');
}

console.log('\nDNS：記錄類型、TTL 與用戶端快取');
{
  const sim = await import('../src/engine/sim.js');
  const { cacheRows } = await import('../src/engine/dns.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((l) => l.id === 'l71');
  const s = lv.setup(); settle(s);
  const a = sim.resolveName(s, 'pc-a', 'www.corp.local');
  ok(a.ok && a.cached && fmtIpT(a.ip) === '10.0.2.10', 'PC-A 的快取還沒到期：拿到舊的位址，沒有問伺服器');
  const n = sim.resolveName(s, 'pc-a', 'www.corp.local', 0, { nocache: true });
  ok(n.ok && !n.cached && fmtIpT(n.ip) === '10.0.2.20' && n.canonical === 'web.corp.local' && n.alias === 'www.corp.local' && n.auth, 'nslookup 不看快取：問伺服器拿到新的位址，CNAME 追到 web.corp.local');
  const c = sim.resolveName(s, 'pc-c', 'www.corp.local');
  ok(c.ok && fmtIpT(c.ip) === '10.0.2.20' && cacheRows(s, s.devices['pc-c']).some((r) => r.name === 'www.corp.local' && r.left === 86400), 'PC-C 查到新的位址，記進快取（TTL 86400 秒）');
  sim.advance(s, 13 * 3600 + 1); recomputeNow(s);
  ok(fmtIpT(sim.resolveName(s, 'pc-b', 'www.corp.local').ip) === '10.0.2.20' && fmtIpT(sim.resolveName(s, 'pc-a', 'www.corp.local').ip) === '10.0.2.10', 'TTL 到期之後才重新查詢：PC-B 先到期拿到新的，PC-A 還沒');
  const mx = sim.dnsQuery(s, 'pc-c', 'corp.local', 'MX'), ptr = sim.dnsQuery(s, 'pc-c', '20.2.0.10.in-addr.arpa', 'PTR');
  ok(mx.ok && mx.records[0].value === 'mail.corp.local' && ptr.ok && ptr.records[0].value === 'web.corp.local', 'MX 與 PTR（反查）');
  ok(!sim.resolveName(s, 'pc-c', 'nope.corp.local').ok, '沒有這筆記錄：NXDOMAIN（失敗的結果不會被快取）');
}

console.log('\nVRF：重疊的網段、vrf forwarding、show vrf、ping vrf');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((l) => l.id === 'l72');
  const s = lv.setup(); settle(s);
  const sess = iosSession(() => s.devices.rt, () => s);
  const app = { state: s, showTrace() {} };
  const run = (...lines) => { const out = []; for (const line of lines) { const r = iosRun(app, 'rt', sess, line, (l) => out.push(l)); if (r.changed) settle(s); } return out; };
  const rt = s.devices.rt, ifc = (id) => rt.ifaces.find((i) => i.id === id);
  const o1 = run('configure terminal', 'interface gi0/0/1', 'ip address 192.168.1.1 255.255.255.0', 'end');
  ok(o1.some((l) => /192\.168\.1\.0 overlaps with GigabitEthernet0\/0\/0/.test(l)) && !ifc('Gi0/0/1').ip, '全域路由表裡設定重疊的網段：% 192.168.1.0 overlaps with GigabitEthernet0/0/0，位址沒有存進去');
  // GUI 直接填重疊的位址：介面上看得到原因，位址不生效
  ifc('Gi0/0/1').ip = '192.168.1.1'; ifc('Gi0/0/1').mask = '255.255.255.0'; settle(s);
  ok(ifc('Gi0/0/1').rt.ip == null && /重疊/.test(ifc('Gi0/0/1').rt.note), '從介面分頁填重疊的位址：沒有生效，介面上寫著和哪個介面重疊');
  delete ifc('Gi0/0/1').ip; settle(s);
  const o2 = run('configure terminal', 'interface gi0/0/1', 'vrf forwarding TENANT-B');
  ok(o2.some((l) => /% VRF TENANT-B not configured/.test(l)) && !ifc('Gi0/0/1').vrf, '介面放進還沒有建立的 VRF：% VRF TENANT-B not configured.');
  const o2b = run('exit', 'vrf definition TENANT-B', 'rd 65000:2', 'interface gi0/0/1', 'vrf forwarding TENANT-B', 'ip address 192.168.1.1 255.255.255.0');
  ok(o2b.some((l) => /還沒有啟用 IPv4/.test(l)) && !ifc('Gi0/0/1').ip, 'vrf definition 沒有 address-family ipv4：介面的 IPv4 位址設不上去');
  const o3 = run('exit', 'vrf definition TENANT-B', 'address-family ipv4', 'exit-address-family', 'interface gi0/0/1', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'end');
  ok(!o3.some((l) => /overlaps/.test(l)) && ifc('Gi0/0/1').rt.ip != null, '放進 TENANT-B 之後，一樣的 192.168.1.1/24 就設得上去（不同的路由表可以重疊）');
  const o4 = run('configure terminal', 'vrf definition TENANT-A', 'rd 65000:1', 'address-family ipv4', 'exit-address-family', 'interface gi0/0/0', 'vrf forwarding TENANT-A', 'end');
  ok(o4.some((l) => /IPv4 disabled and address\(es\) removed due to enabling VRF TENANT-A/.test(l)) && !ifc('Gi0/0/0').ip, 'vrf forwarding 會把介面原本的 IP 清掉（和真的 IOS 一樣的訊息）');
  run('configure terminal', 'interface gi0/0/0', 'ip address 192.168.1.1 255.255.255.0', 'interface gi0/0/2.10', 'vrf forwarding TENANT-A', 'ip address 10.1.0.1 255.255.255.0', 'interface gi0/0/2.20', 'vrf forwarding TENANT-B', 'ip address 10.1.0.1 255.255.255.0', 'end');
  const sv = run('show vrf').join('\n');
  ok(/TENANT-A\s+65000:1\s+ipv4\s+Gi0\/0\/0/.test(sv) && /TENANT-B\s+65000:2/.test(sv), 'show vrf：名稱、RD、Protocols 與介面');
  const glob = run('show ip route').join('\n'), rta = run('show ip route vrf TENANT-A').join('\n');
  ok(!/192\.168\.1\.0/.test(glob) && /Routing Table: TENANT-A/.test(rta) && /C\s+10\.1\.0\.0\/24 is directly connected/.test(rta) && /L\s+192\.168\.1\.1\/32/.test(rta), 'show ip route 只有全域的路由；show ip route vrf TENANT-A 才看得到客戶的網段（含 L 路由）');
  ok(/% IP routing table NOPE does not exist/.test(run('show ip route vrf NOPE').join('\n')), 'show ip route vrf 不存在的 VRF：% IP routing table NOPE does not exist');
  s.devices.swdc.sw.ports['Gi0/1'].allowed = '10,20'; settle(s);
  const pa = sim.transact(s, 'pca', { proto: 'tcp', dst: parseIp('10.1.0.10'), dport: 443 }), pb = sim.transact(s, 'pcb', { proto: 'tcp', dst: parseIp('10.1.0.10'), dport: 443 });
  ok(pa.ok && pa.responder === 'srva' && pb.ok && pb.responder === 'srvb', '兩家公司連同一個 10.1.0.10，各自到自己的伺服器');
  const pg = run('ping 10.1.0.10').join('\n'), pv = run('ping vrf TENANT-B 10.1.0.10').join('\n');
  ok(!/!!!!!/.test(pg) && /!!!!!|Success rate is 100/.test(pv), '路由器上 ping 10.1.0.10 走全域（不通）；ping vrf TENANT-B 才通');
  run('configure terminal', 'ip route vrf TENANT-B 172.16.0.0 255.255.0.0 10.1.0.254', 'end');
  const rc = runningConfig(s, rt).join('\n');
  ok(/vrf definition TENANT-A\n rd 65000:1\n !\n address-family ipv4\n exit-address-family\n!/.test(rc) && /interface GigabitEthernet0\/0\/0\n( description [^\n]*\n)? vrf forwarding TENANT-A\n ip address 192\.168\.1\.1/.test(rc) && /ip route vrf TENANT-B 172\.16\.0\.0 255\.255\.0\.0 10\.1\.0\.254/.test(rc),
    'running-config：vrf definition 區塊、介面第一行是 vrf forwarding、ip route vrf');
  ok(sim.routeRows(rt, 'TENANT-B').some((r) => r.dst === '172.16.0.0/16') && !sim.routeRows(rt).some((r) => r.dst === '172.16.0.0/16'), 'VRF 的靜態路由只出現在那個 VRF 的路由表裡');
  run('configure terminal', 'no vrf definition TENANT-B', 'end');
  ok(!ifc('Gi0/0/1').vrf && !ifc('Gi0/0/1').ip && !rt.routes.some((r) => r.vrf === 'TENANT-B'), 'no vrf definition：成員介面的位址清掉、VRF 的路由一起刪掉');
}

console.log('\n容器：連接埠發佈、只綁 127.0.0.1、埠對錯、停止的容器');
{
  const sim = await import('../src/engine/sim.js');
  const dk = await import('../src/engine/docker.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((l) => l.id === 'l73');
  const s = lv.setup(); settle(s);
  const d = s.devices.dk, tcp = (port) => sim.transact(s, 'pc', { proto: 'tcp', dst: parseIp('10.0.50.20'), dport: port });
  const w = tcp(8080), g = tcp(3000), m = tcp(3306), x = tcp(9000);
  ok(!w.ok && /連線被重設/.test(w.reason) && /聽的是 80/.test(w.reason), '-p 8080:8080 但 nginx 聽 80：連得上主機，馬上被重設');
  ok(!g.ok && /127\.0\.0\.1/.test(g.reason), '-p 127.0.0.1:3000:3000：別台連不進來');
  ok(m.ok, '資料庫發佈在 0.0.0.0:3306：從辦公室就連得到（弱點）');
  ok(!x.ok && /沒有在/.test(x.reason), '沒有發佈的埠：主機沒有在聽');
  ok(dk.dockerDeliver(d, { proto: 'tcp', dport: 3000, src: 0x7f000001 }, true).ok, '主機自己 curl localhost:3000：連得到');
  ok(/Bind for 0\.0\.0\.0:8080 failed: port is already allocated/.test(dk.addContainer(s, d, { name: 'web2', image: 'nginx', publish: [dk.parsePublish('8080:80')] }).err || ''), '同一個主機埠發佈兩次：port is already allocated');
  ok(/Conflict\. The container name "\/web" is already in use/.test(dk.addContainer(s, d, { name: 'web', image: 'nginx' }).err || ''), '名稱重複：Conflict');
  ok(/pull access denied for nginxx/.test(dk.addContainer(s, d, { name: 'n', image: 'nginxx' }).err || ''), '映像檔名稱打錯：pull access denied');
  ok(dk.parsePublish('127.0.0.1:3000:3000').hostIp === '127.0.0.1' && dk.parsePublish('5353:53/udp').proto === 'udp' && !dk.parsePublish('80'), '-p 的寫法：位址:主機埠:容器埠、/udp');
  dk.findCtr(d, 'db').state = 'exited'; settle(s);
  ok(!tcp(3306).ok && /沒有在執行/.test(tcp(3306).reason), '容器停止之後，發佈的埠也就連不到了');
  ok(dk.portsText(dk.findCtr(d, 'web')) === '0.0.0.0:8080->8080/tcp, 80/tcp', 'docker ps 的 PORTS 欄：發佈的埠，加上映像檔聽、但沒有發佈的埠');
  const c2 = cloneState(s);
  ok(c2.devices.dk.docker.containers.length === 3 && c2.devices.dk.docker.containers.find((c) => c.name === 'grafana').publish[0].hostIp === '127.0.0.1', '容器的設定可以存檔、讀檔');
}

console.log('\nHTTPS 憑證：信任、有效期間（用戶端的時鐘）、SAN、自簽');
{
  const web = await import('../src/engine/web.js');
  const { SIM_EPOCH, deviceTime } = await import('../src/engine/ops.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((l) => l.id === 'l74');
  const s = lv.setup(); settle(s);
  const D = s.devices, srv = D.web, DAY = 86400000;
  const t1 = web.tlsCheck(s, D.pc1, srv, 'intranet.corp.local');
  ok(!t1.ok && t1.code === 60 && /has expired/.test(t1.msg), '昨天到期的憑證：certificate has expired');
  srv.web.cert = web.issueCert(s, { cn: 'intranet.corp.local', san: ['intranet.corp.local'], issuer: web.CORP_CA });
  ok(web.tlsCheck(s, D.pc1, srv, 'intranet.corp.local').ok, '換了新憑證：加入網域的 PC-1 通過');
  const t2 = web.tlsCheck(s, D.pc1, srv, 'portal.corp.local');
  ok(!t2.ok && /no alternative certificate subject name matches target host name 'portal\.corp\.local'/.test(t2.msg), 'CNAME 來的名稱不在 SAN 裡：瀏覽器比對的是網址上的名稱');
  const t3 = web.tlsCheck(s, D.byod, srv, 'intranet.corp.local');
  ok(!t3.ok && /unable to get local issuer certificate/.test(t3.msg), '沒有加入網域的筆電不信任 Corp Root CA：unable to get local issuer certificate');
  const t4 = web.tlsCheck(s, D.meet, srv, 'intranet.corp.local');
  ok(!t4.ok && /not yet valid/.test(t4.msg) && deviceTime(s, D.meet).ms < SIM_EPOCH - 300 * DAY, '時鐘回到 2024 年的電腦：certificate is not yet valid');
  ok(web.nameMatch('*.corp.local', 'portal.corp.local') && !web.nameMatch('*.corp.local', 'a.b.corp.local') && !web.nameMatch('*.corp.local', 'corp.local'), '萬用字元只比對一層：*.corp.local 不含 a.b.corp.local 和 corp.local 本身');
  srv.web.cert = web.issueCert(s, { cn: 'intranet.corp.local', issuer: 'intranet.corp.local' });
  ok(/self-signed certificate/.test(web.tlsCheck(s, D.pc1, srv, 'intranet.corp.local').msg), '自簽憑證：self-signed certificate');
  delete srv.web.cert;
  ok(web.tlsCheck(s, D.pc1, srv, 'intranet.corp.local').code === 35, '網站有在聽 443 但沒有憑證：TLS 交握失敗（curl 35）');
  ok(/self-signed/.test(web.tlsCheck(s, D.pc1, D.rt, '10.0.2.1').msg), '路由器的 HTTPS 管理網頁出廠就是自簽憑證');
  ok(web.tlsCheck(s, D.byod, { kind: 'internet', name: 'ISP' }, 'www.example.com').ok, '網際網路上的網站：公開 CA，每台都信任');
  lv.solve(s); settle(s);
  const r = evaluate(s, lv.objectives);
  ok(r.every((x) => x.pass) && r[0].log.some((l) => /TLS 交握成功/.test(l.text)), '解法之後每台都通過 TLS 交握（https 目標會記下是誰簽的）');
  D.byod.trust = []; settle(s);
  const r2 = evaluate(s, lv.objectives);
  ok(!r2[2].pass && /憑證錯誤/.test(r2[2].reason), 'https 目標：TCP 連得上但憑證不被信任，一樣算失敗');
}

console.log('\nMTU：分段、DF、PMTUD 黑洞、Jumbo Frame、ip tcp adjust-mss');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { counters } = await import('../src/engine/wire.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const IP = (x) => parseIp(x);
  // ── Jumbo Frame：兩端 9000、中間的 2960 還是 1500
  const l75 = LEVELS.find((l) => l.id === 'l75');
  let s = l75.setup(); settle(s);
  const t1 = sim.transact(s, 'bk', { proto: 'tcp', dst: IP('10.0.50.20'), dport: 445, bulk: 'up' });
  ok(!t1.ok && t1.phase === 'data' && /giant/.test(t1.reason) && t1.mss === 8960, '兩端 MTU 9000、交換器 1500：TCP 交握成功（MSS 8960），資料區段在交換器被當成 giant 丟掉');
  ok(counters(s, 'sw', 'Gi0/2').giants > 0, '交換器那個埠的 giants 計數器增加');
  const p1 = sim.transact(s, 'bk', { proto: 'icmp', dst: IP('10.0.50.20'), size: 9000, df: true }), p2 = sim.transact(s, 'bk', { proto: 'icmp', dst: IP('10.0.50.20'), size: 1500, df: true });
  ok(!p1.ok && p1.silent && !p1.ptb && p2.ok, 'ping 9000 位元組（DF）逾時、沒有任何 ICMP；1500 會通');
  const p3 = sim.transact(s, 'bk', { proto: 'icmp', dst: IP('10.0.50.20'), size: 9100, df: true });
  ok(!p3.ok && p3.dfLocal === 9000, '比自己網卡的 MTU 還大又設了 DF：在本機就送不出去（封包需要分段）');
  const p4 = sim.transact(s, 'pc', { proto: 'icmp', dst: IP('10.0.50.1'), size: 4000 });
  ok(p4.ok && p4.log.some((l) => /分段：4000 位元組/.test(l.text)), '沒有 DF 的大封包：送的人自己切成好幾片，照樣送得到');
  const sw = cli(s, 'sw');
  const o1 = sw('configure terminal', 'system mtu jumbo 9000', 'end');
  ok(/will not take effect until the next reload/.test(o1) && /On next reload, System Jumbo MTU size will be 9000 bytes/.test(sw('show system mtu')), 'system mtu jumbo：要重新開機才生效（show system mtu 寫著 On next reload）');
  ok(!sim.transact(s, 'bk', { proto: 'tcp', dst: IP('10.0.50.20'), dport: 445, bulk: 'up' }).ok, '還沒重新開機：備份照樣卡住');
  ok(/% Catalyst 2960 不能各別設定連接埠的 MTU/.test(sw('configure terminal', 'interface gi0/2', 'mtu 9000', 'end')), '2960 不能在介面上設 mtu');
  sw('write memory', 'reload', ''); settle(s);
  const sp = sim.runObjective(s, l75.objectives[1]);
  ok(sp.pass && sp.speed.mbps >= 975 && sim.evaluate(s, l75.objectives).every((r) => r.pass), `存檔、重新開機之後 Jumbo 生效：備份跑到 ${sp.speed.mbps} Mbps（1500 的時候只有 940）`);
  ok(/system mtu jumbo 9000/.test(runningConfig(s, s.devices.sw).join('\n')), 'running-config 有 system mtu jumbo 9000');
  // ── 9300 與 Nexus、路由器的 mtu / ip mtu
  const l76 = LEVELS.find((l) => l.id === 'l76');
  s = l76.setup(); settle(s);
  const core = cli(s, 'core'), br = cli(s, 'br');
  ok(/Global Ethernet MTU is 9198 bytes/.test(core('configure terminal', 'system mtu 9198', 'end') + core('show system mtu')), 'Catalyst 9300 的 system mtu 馬上生效');
  core('configure terminal', 'no system mtu', 'end');
  ok(/不能比介面本身的 MTU（1500）大/.test(br('configure terminal', 'interface gi0/0/1', 'ip mtu 9000', 'end')), '路由器的 ip mtu 不能比介面的 mtu 大');
  br('configure terminal', 'interface gi0/0/1', 'mtu 9000', 'ip mtu 9000', 'no mtu', 'end');
  ok(!s.devices.br.ifaces.find((i) => i.id === 'Gi0/0/1').mtu, 'no mtu 之後，比 1500 大的 ip mtu 一起清掉');
  // ── IPsec 與 PMTUD 黑洞
  const up = sim.transact(s, 'pc', { proto: 'tcp', dst: IP('10.1.20.10'), dport: 445, bulk: 'up' });
  ok(up.ok && up.mss === 1387 && up.log.some((l) => /Path MTU Discovery：改送 1427/.test(l.text)), '上傳：Branch-RT 回報「需要分段」(MTU 1427)，分公司 PC 改送小一點的區段');
  const dn = sim.transact(s, 'pc', { proto: 'tcp', dst: IP('10.1.20.10'), dport: 445 });
  ok(!dn.ok && dn.phase === 'data' && /PMTUD 黑洞/.test(dn.reason) && /HQ-Core 的 Vlan20/.test(dn.reason), '下載：HQ-FW 的「需要分段」被 HQ-Core 的 ACL 擋掉 → PMTUD 黑洞');
  const pg = sim.transact(s, 'pc', { proto: 'icmp', dst: IP('10.1.20.10'), size: 1500, df: true });
  ok(!pg.ok && pg.ptb && pg.ptb.mtu === 1427 && pg.ptb.dev === 'br', 'ping -f -l 1472：Branch-RT 回報通道裡只放得下 1427');
  ok(/MMMMM/.test(br('ping 10.1.20.10 source gi0/0/1 size 1500 df-bit')), '路由器的 ping … source gi0/0/1 size 1500 df-bit：MMMMM（could not fragment）');
  const s2 = cloneState(s); settle(s2);
  cli(s2, 'br')('configure terminal', 'interface gi0/0/1', 'ip tcp adjust-mss 1360', 'end');
  const dn2 = sim.transact(s2, 'pc', { proto: 'tcp', dst: IP('10.1.20.10'), dport: 445 });
  ok(dn2.ok && dn2.mss === 1360, '只加 ip tcp adjust-mss 1360：SYN 裡的 MSS 被改小，伺服器一開始就送 1400，不用靠 ICMP');
  core('configure terminal', 'ip access-list extended SERVERS', '25 permit icmp any any packet-too-big', 'end');
  const acl = core('show access-lists');
  ok(/25 permit icmp any any packet-too-big[^\n]*\n\s+30 deny icmp any any/.test(acl), '序號 25 插在 30 的 deny 前面（和 IOS 一樣保留序號），ACL 可以只放行 packet-too-big');
  const dn3 = sim.transact(s, 'pc', { proto: 'tcp', dst: IP('10.1.20.10'), dport: 445 });
  ok(dn3.ok && dn3.mss === 1387 && !sim.transact(s, 'pc', { proto: 'icmp', dst: IP('10.1.20.10') }).ok, '放行 packet-too-big 之後 PMTUD 正常、下載恢復；一般的 ping 還是被擋');
  ok(/permit icmp any any packet-too-big/.test(runningConfig(s, s.devices.core).join('\n')) && /ip tcp adjust-mss 1360/.test(runningConfig(s2, s2.devices.br).join('\n')), 'running-config：ICMP 類型與 ip tcp adjust-mss');
  // ── 家用路由器的 PPPoE：自動把 MSS 改成 1452
  const l04 = LEVELS.find((l) => l.id === 'l04');
  const h = l04.setup(); l04.solve(h); settle(h);
  const r04 = sim.runObjective(h, l04.objectives.find((o) => o.type === 'tcp'));
  ok(r04.pass && r04.log.some((l) => /1492 位元組（MSS 1452/.test(l.text)), '家用路由器的 PPPoE（MTU 1492）：自動把 MSS 改成 1452');
}

console.log('\n路由重分配與政策路由：redistribute、O E1 / E2、route-map、ip policy route-map');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { makeDevice: MD, makeState: MS } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const IP = (x) => parseIp(x);
  const rt = (s, id, net, bits) => s.devices[id].rt.routes.find((r) => r.net === IP(net) && r.bits === bits);
  // ── 靜態路由進 OSPF（l77）
  const l77 = LEVELS.find((l) => l.id === 'l77');
  let s = l77.setup(); settle(s);
  const edge = cli(s, 'edge'), core = cli(s, 'core');
  edge('configure terminal', 'ip route 0.0.0.0 0.0.0.0 172.31.0.2', 'router ospf 1', 'redistribute static', 'end');
  const f = rt(s, 'core', '10.50.0.0', 16), lab = rt(s, 'core', '192.168.99.0', 24);
  ok(f && f.type === 'O' && f.sub === 'E2' && f.metric === 20 && lab && !rt(s, 'core', '0.0.0.0', 0), 'redistribute static：其他路由器學到 O E2 [110/20]；所有靜態路由都出去了，只有預設路由不會（要 default-information originate）');
  ok(/redistribute static subnets/.test(runningConfig(s, s.devices.edge).join('\n')) && /It is an autonomous system boundary router/.test(edge('show ip ospf')), 'IOS XE 自動補上 subnets；R-Edge 成為 ASBR');
  edge('configure terminal', 'router ospf 1', 'redistribute static metric 50 metric-type 1', 'end');
  const e1 = rt(s, 'core', '10.50.0.0', 16);
  ok(e1 && e1.sub === 'E1' && e1.metric === 51, 'metric-type 1：O E1，metric 是 50 加上往 ASBR 的內部 cost（1）');
  edge('configure terminal', 'route-map NONE deny 10', 'exit', 'router ospf 1', 'redistribute static subnets route-map NONE', 'end');
  ok(!rt(s, 'core', '10.50.0.0', 16) && !rt(s, 'core', '192.168.99.0', 24), 'route-map 只有 deny：什麼都不送');
  edge('configure terminal', 'router ospf 1', 'redistribute static subnets route-map NOPE', 'end');
  ok(!rt(s, 'core', '10.50.0.0', 16), '參照不存在的 route-map：什麼都不送');
  edge('configure terminal', 'access-list 10 permit 10.50.0.0 0.0.255.255', 'route-map STD permit 10', 'match ip address 10', 'set tag 77', 'exit', 'router ospf 1', 'redistribute static subnets route-map STD', 'end');
  const tg = rt(s, 'core', '10.50.0.0', 16);
  ok(tg && tg.tag === 77 && !rt(s, 'core', '192.168.99.0', 24) && /Tag 77, type extern 2/.test(core('show ip route 10.50.0.0')), 'route-map 用標準 ACL 挑網段、set tag：show ip route 看得到 Tag 77');
  edge('configure terminal', 'router ospf 1', 'no redistribute static', 'redistribute connected', 'end');
  ok(rt(s, 'core', '172.31.0.0', 30) && rt(s, 'core', '172.31.0.0', 30).sub === 'E2' && rt(s, 'core', '10.0.0.0', 30).type === 'C', 'redistribute connected：沒有跑 OSPF 的直連網段變成外部路由，跑 OSPF 的照樣是區域內的');
  // ── BGP 與 OSPF 互相重分配
  const t = MS([MD('isr4331', 'a', { name: 'A', pos: [0, 0] }), MD('isr4331', 'b', { name: 'B', pos: [6, 0] }), MD('isr4331', 'c', { name: 'C', pos: [-6, 0] })], [['a:Gi0/0/0', 'b:Gi0/0/0'], ['a:Gi0/0/1', 'c:Gi0/0/0']]);
  settle(t);
  const A = cli(t, 'a'), B = cli(t, 'b'), C = cli(t, 'c');
  A('configure terminal', 'interface gi0/0/0', 'ip address 192.0.2.1 255.255.255.252', 'interface gi0/0/1', 'ip address 10.0.0.1 255.255.255.252', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.3 area 0', 'exit', 'router bgp 65001', 'neighbor 192.0.2.2 remote-as 65002', 'end');
  B('configure terminal', 'interface gi0/0/0', 'ip address 192.0.2.2 255.255.255.252', 'interface loopback0', 'ip address 203.0.113.1 255.255.255.0', 'exit', 'router bgp 65002', 'neighbor 192.0.2.1 remote-as 65001', 'network 203.0.113.0 mask 255.255.255.0', 'end');
  C('configure terminal', 'interface gi0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'interface loopback1', 'ip address 10.9.9.1 255.255.255.255', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.3 area 0', 'network 10.9.9.1 0.0.0.0 area 0', 'end');
  ok(rt(t, 'a', '203.0.113.0', 24) && rt(t, 'a', '203.0.113.0', 24).type === 'B' && !rt(t, 'c', '203.0.113.0', 24), 'A 從 BGP 學到 203.0.113.0/24，C 還不知道');
  ok(/% BGP process 65009 not running/.test(A('configure terminal', 'router ospf 1', 'redistribute bgp 65009 subnets', 'end')), 'redistribute bgp 的 AS 號碼要是自己的 BGP 程序');
  A('configure terminal', 'router ospf 1', 'redistribute bgp 65001 subnets', 'end');
  const cb = rt(t, 'c', '203.0.113.0', 24);
  ok(cb && cb.type === 'O' && cb.sub === 'E2' && cb.metric === 1, 'redistribute bgp 進 OSPF：C 學到 O E2 203.0.113.0/24 [110/1]（從 BGP 來的種子 metric 是 1）');
  ok(sim.transact(t, 'c', { proto: 'icmp', dst: IP('203.0.113.1') }).ok === false, '可是 B 還不知道怎麼回到 C 的位址：ping 不通（回程）');
  A('configure terminal', 'router bgp 65001', 'redistribute ospf 1', 'end');
  const bb = t.devices.b.rt.routes.find((r) => r.type === 'B' && r.net === IP('10.0.0.0'));
  ok(bb && t.devices.b.rt.routes.some((r) => r.type === 'B' && r.net === IP('10.9.9.1') && r.bits === 32) && sim.transact(t, 'c', { proto: 'icmp', dst: IP('203.0.113.1') }).ok, 'redistribute ospf 進 BGP：B 學到 C 的網段，雙向都通了');
  const orig = (t.devices.a.rt.bgp.table.find((r) => r.net === IP('10.9.9.1')) || {}).origin;
  ok(orig === '?' && /redistribute ospf 1/.test(runningConfig(t, t.devices.a).join('\n')) && /redistribute bgp 65001 subnets/.test(runningConfig(t, t.devices.a).join('\n')), '重分配進 BGP 的路 origin 是 ?（incomplete）；兩條 redistribute 都在 running-config');
  // ── 政策路由（l78）
  const l78 = LEVELS.find((l) => l.id === 'l78');
  const port = (st, from, ip, p) => { const r = sim.transact(st, from, { proto: 'tcp', dst: IP(ip), dport: p }); const h = r.hops.find((x) => x.from === 'br' && !x.reply && !x.wave); return h && h.fromPort; };
  s = l78.setup(); settle(s);
  const br = cli(s, 'br');
  br('configure terminal', 'ip access-list extended BACKUP', 'permit ip host 10.2.0.20 host 10.1.0.20', 'exit', 'route-map PBR permit 10', 'match ip address BACKUP', 'set ip next-hop 10.255.9.9', 'exit', 'interface gi0/0/2', 'ip policy route-map PBR', 'end');
  const r1 = sim.transact(s, 'nas', { proto: 'tcp', dst: IP('10.1.0.20'), dport: 445 });
  ok(port(s, 'nas', '10.1.0.20', 445) === 'Gi0/0/0' && r1.log.some((l) => /不是直連網段.*改照路由表/.test(l.text)), 'set ip next-hop 指定的位址不是直連：照一般的路由表（專線）');
  br('configure terminal', 'route-map PBR permit 10', 'no set ip next-hop', 'set ip default next-hop 10.255.2.1', 'end');
  ok(port(s, 'nas', '10.1.0.20', 445) === 'Gi0/0/0', 'set ip default next-hop：路由表裡有往總公司的明確路由，所以不起作用');
  br('configure terminal', 'route-map PBR permit 10', 'no set ip default next-hop', 'set ip next-hop 10.255.2.1', 'end');
  ok(port(s, 'nas', '10.1.0.20', 445) === 'Gi0/0/1' && port(s, 'pc', '10.1.0.20', 445) === 'Gi0/0/0', 'set ip next-hop 10.255.2.1：只有 NAS 到備份伺服器的流量改走寬頻，其他電腦照樣走專線');
  br('configure terminal', 'route-map PBR deny 5', 'match ip address BACKUP', 'end');
  ok(port(s, 'nas', '10.1.0.20', 445) === 'Gi0/0/0', '前面有一條符合的 deny：照一般的路由表');
  ok(/Policy routing matches: [1-9]\d* packets/.test(br('show route-map')) && /Gi0\/0\/2\s+PBR/.test(br('show ip policy')), 'show route-map 的 Policy routing matches、show ip policy');
  br('configure terminal', 'no route-map PBR', 'route-map LOCAL permit 10', 'match ip address BACKUP2', 'set ip next-hop 10.255.2.1', 'exit', 'ip access-list extended BACKUP2', 'permit ip any host 10.1.0.20', 'exit', 'ip local policy route-map LOCAL', 'end');
  const lp = sim.transact(s, 'br', { proto: 'icmp', dst: IP('10.1.0.20') });
  ok(lp.ok && lp.hops.some((h) => h.from === 'br' && h.fromPort === 'Gi0/0/1' && !h.reply) && /ip local policy route-map LOCAL/.test(runningConfig(s, s.devices.br).join('\n')), 'ip local policy route-map：路由器自己送出的封包也照政策走');
  ok(/interface GigabitEthernet0\/0\/2[^!]*ip policy route-map PBR/.test(runningConfig(s, s.devices.br).join('\n')), 'running-config：介面下的 ip policy route-map 還在（route-map 刪掉了，封包照一般的路由表）');
}

console.log('\n參考解法與錯題本');
{
  const { solutionChanges } = await import('../src/ui/solution.js');
  const { noteAnswer, dueItems, reviewStats, qKey } = await import('../src/ui/review.js');
  const { QUESTIONS } = await import('../src/data/quiz.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const bad = [];
  for (const lv of LEVELS) {
    try { const c = solutionChanges(lv); if (!c.cables.length && !c.devs.length) bad.push(lv.id + '（沒有任何變更）'); } catch (e) { bad.push(`${lv.id}：${e.message.split('\n')[0]}`); }
  }
  ok(!bad.length, `每一關的參考解法都整理得出「改了哪些地方」${bad.length ? '：' + bad.join('、') : ''}`);
  const l06 = solutionChanges(LEVELS.find((l) => l.id === 'l06'));
  ok(l06.devs[0].ios && l06.devs[0].lines.includes('interface GigabitEthernet0/1') && l06.devs[0].lines.includes(' +switchport access vlan 10'), 'Cisco 設備用 running-config 的差異呈現（介面底下 +switchport access vlan 10）');
  const l01 = solutionChanges(LEVELS.find((l) => l.id === 'l01'));
  ok(l01.cables.length === 2 && l01.devs.some((d) => d.lines.includes('介面 › eth0 › IP 位址：（無） → 192.168.1.10')), '其他設備列出改了哪些欄位；接線另外列出');
  // 錯題本的排程
  const app = { store: {}, saveStore() {} };
  const q = QUESTIONS.basics[0], DAY = 86400000, t0 = Date.UTC(2026, 10, 20);
  noteAnswer(app, q, false, t0);
  ok(app.store.review[qKey(q)].box === 1 && dueItems(app, t0).length === 1 && !app.store.review[qKey(q)].item, '答錯：放進第 1 盒，馬上可以複習（題庫的題目只記代碼）');
  noteAnswer(app, q, true, t0);
  ok(app.store.review[qKey(q)].box === 2 && !dueItems(app, t0).length && dueItems(app, t0 + DAY).length === 1, '答對：第 2 盒，一天後才到期');
  for (const [d, box] of [[1, 3], [4, 4], [11, 5]]) noteAnswer(app, q, true, t0 + d * DAY);
  ok(app.store.review[qKey(q)].box === 5 && reviewStats(app, t0 + 11 * DAY).next === 14 * DAY, '間隔越拉越長：1 → 3 → 7 → 14 天');
  noteAnswer(app, q, false, t0 + 30 * DAY);
  ok(app.store.review[qKey(q)].box === 1 && app.store.review[qKey(q)].wrong === 2, '又答錯：回到第 1 盒，記下答錯兩次');
  for (let k = 0; k < 5; k++) noteAnswer(app, q, true, t0 + 100 * DAY);
  ok(!app.store.review[qKey(q)], '一路答對到第 5 盒之後再答對：畢業，從錯題本拿掉');
  const gen = { q: '10.1.1.1/30 的廣播位址？（隨機題）', a: ['1', '2', '3', '4'], c: 2, e: 'x', r: 'CCNA 1.6' };
  noteAnswer(app, gen, false, t0);
  ok(app.store.review[qKey(gen)].item && dueItems(app, t0)[0].item.q === gen.q, '隨機產生的子網路題：整題存下來，之後也考得到');
}

console.log('\nCatalyst Center：Token、設備清單、AI 問題');
{
  const { restconf } = await import('../src/engine/restconf.js');
  const { issues } = await import('../src/engine/dnac.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((l) => l.id === 'l62');
  const s = lv.setup(); settle(s);
  const B = 'https://10.1.98.50';
  const rq = (o) => restconf(s, 'ops', { method: 'GET', ...o, url: B + o.url });
  ok(rq({ url: '/dna/intent/api/v1/network-device' }).status === 401 && rq({ method: 'POST', url: '/dna/system/api/v1/auth/token', user: 'netops', pass: 'x' }).status === 401, '沒有 Token、密碼錯：401');
  const tok = rq({ method: 'POST', url: '/dna/system/api/v1/auth/token', user: 'netops', pass: 'C@talyst-2026' }).body.Token;
  const H = { headers: { 'x-auth-token': tok } };
  const inv = rq({ url: '/dna/intent/api/v1/network-device', ...H });
  const sw3 = inv.body.response.find((x) => x.hostname === 'SW-3');
  ok(inv.status === 200 && inv.body.response.length === 4 && sw3.reachabilityStatus === 'Unreachable' && sw3.reachabilityFailureReason === 'SNMP Timeouts' && inv.ctype === 'application/json', '設備清單：控制器真的用 SNMP 輪詢，沒有預設閘道的 SW-3 是 Unreachable');
  ok(rq({ url: '/dna/intent/api/v1/network-device?hostname=SW-1', ...H }).body.response.length === 1, '查詢字串可以篩選 (?hostname=)');
  const iss = rq({ url: '/dna/intent/api/v1/issues', ...H }).body.response;
  ok(iss.length === 3 && iss.some((x) => x.aiDriven === 'Yes' && /VLAN 30/.test(x.name)) && iss.some((x) => /Duplex Mismatch/.test(x.name)) && iss.some((x) => x.priority === 'P1'), '問題清單：設備連不到 (P1)、VLAN 30 的 DHCP 失敗（AI 偵測）、雙工不一致');
  advance(s, 3700);
  ok(rq({ url: '/dna/intent/api/v1/issues', ...H }).status === 401, 'Token 一小時後過期');
  lv.solve(s); settle(s);
  ok(!issues(s, s.devices.dnac).length, '修好之後問題清單是空的');
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

console.log('\nOSPF 的 stub / NSSA、VRF 裡的 OSPF、路由洩漏、iBGP 與 community');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { makeDevice: MD, makeState: MS } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const IP = (x) => parseIp(x);
  const rt = (s, id, net, bits, vrf = '') => s.devices[id].rt.routes.find((r) => (r.vrf || '') === vrf && r.net === IP(net) && r.bits === bits && !r.bad);
  const ospfRts = (s, id) => s.devices[id].rt.routes.filter((r) => r.type === 'O');
  const solved = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); settle(s); lv.solve(s); settle(s); return { lv, s }; };
  const fresh = (id) => { const lv = LEVELS.find((l) => l.id === id); const s = lv.setup(); settle(s); return { lv, s }; };

  // ── stub / totally stubby（l79）
  {
    const { s } = fresh('l79');
    const dist = cli(s, 'dist'), br1 = cli(s, 'br1'), br2 = cli(s, 'br2');
    ok(/Backbone can not be configured as stub area/.test(dist('configure terminal', 'router ospf 1', 'area 0 stub', 'end')) && !/% %/.test(dist('configure terminal', 'router ospf 1', 'area 0 stub', 'end')), 'area 0 stub：IOS 拒絕（骨幹不能是 stub），錯誤訊息前面只有一個 %');
    ok(!(s.devices.br2.rt.nbrs || []).length && /區域種類不一致/.test(br2('show ip ospf interface gi0/0/0')), 'BR-2 設了 area 10 stub、Dist-RT 沒有：不是鄰居，show ip ospf interface 說出原因');
    const e2 = ospfRts(s, 'br1').filter((r) => r.sub === 'E2').length;
    dist('configure terminal', 'router ospf 1', 'area 10 stub', 'end');
    ok(e2 === 4 && !(s.devices.br1.rt.nbrs || []).some((n) => n.state === 'full'), 'Dist-RT 先改成 stub：換 BR-1 不一樣，BR-1 的鄰居跟著斷（原本有 4 筆 O E2）');
    br1('configure terminal', 'router ospf 1', 'area 10 stub', 'end');
    const def = rt(s, 'br1', '0.0.0.0', 0);
    ok(def && def.sub === 'IA' && !ospfRts(s, 'br1').some((r) => r.sub === 'E2') && ospfRts(s, 'br1').some((r) => r.sub === 'IA' && r.bits > 0) && (s.devices.br2.rt.nbrs || []).some((n) => n.state === 'full'),
      'area 10 都是 stub：BR-1 的 O E2 換成一筆 O*IA 預設路由（cost 1 + 往 ABR 的 cost），區域間的路還在；BR-2 也成為鄰居');
    ok(/^O\*IA/m.test(br1('show ip route').split('\n').map((l) => l.trim()).join('\n')) && /It is a stub area/.test(br1('show ip ospf')) && /1 normal 1 stub 0 nssa/.test(dist('show ip ospf')), 'show ip route 是 O*IA；show ip ospf 寫 stub area、區域統計 1 normal 1 stub');
    dist('configure terminal', 'router ospf 1', 'area 10 stub no-summary', 'area 10 default-cost 25', 'end');
    const only = ospfRts(s, 'br1').filter((r) => r.sub === 'IA');
    ok(only.length === 1 && only[0].bits === 0 && only[0].metric === 25 + 1, 'ABR 加 no-summary（totally stubby）：BR-1 只剩一筆 O*IA 0.0.0.0/0；default-cost 25 讓它的 metric 變成 26');
    const db = br1('show ip ospf database');
    ok(/Summary Net Link States \(Area 10\)/.test(db) && db.split('Summary Net Link States (Area 10)')[1].trim().split('\n').filter((l) => /^\d/.test(l)).length === 1 && !/Type-5/.test(db), 'BR-1 的資料庫：Area 10 的 Summary LSA 只剩 0.0.0.0，完全沒有 Type-5');
    ok(/area 10 default-cost 25\n area 10 stub no-summary/.test(runningConfig(s, s.devices.dist).join('\n')), 'running-config：area 10 default-cost 25、area 10 stub no-summary');
    dist('configure terminal', 'router ospf 1', 'no area 10 stub no-summary', 'end');
    ok(ospfRts(s, 'br1').filter((r) => r.sub === 'IA').length > 1 && /area 10 stub$/m.test(runningConfig(s, s.devices.dist).join('\n')), 'no area 10 stub no-summary：只拿掉 no-summary，還是 stub');
    ok(/NSSA already|stub area already/.test(dist('configure terminal', 'router ospf 1', 'area 10 nssa', 'end')), '已經是 stub 的區域不能直接改 NSSA：要先 no area 10 stub');
  }

  // ── NSSA（l80）
  {
    const { s } = fresh('l80');
    const fedge = cli(s, 'fedge'), dist = cli(s, 'dist'), core = cli(s, 'core');
    ok(s.devices.fedge.rt.ospf.asbr && !rt(s, 'dist', '172.20.0.0', 16) && !/172\.20\.0\.0/.test(dist('show ip ospf database')), 'stub 區域裡的 ASBR：FAC-Edge 是 ASBR，但 Type-5 送不出去（Dist-RT 的資料庫沒有 172.20.0.0）');
    for (const id of ['dist', 'fcore', 'fedge']) cli(s, id)('configure terminal', 'router ospf 1', 'no area 20 stub', 'area 20 nssa', 'end');
    const n2 = rt(s, 'fcore', '172.20.0.0', 16), e2 = rt(s, 'core', '172.20.0.0', 16);
    ok(n2 && n2.sub === 'N2' && n2.metric === 20 && e2 && e2.sub === 'E2' && e2.metric === 20, 'NSSA：FAC-Core 學到 O N2 172.20.0.0/16，Core 學到轉換過的 O E2（metric 都是 20）');
    ok(!rt(s, 'fcore', '0.0.0.0', 0) && !ospfRts(s, 'fcore').some((r) => r.sub === 'E2') && ospfRts(s, 'fcore').some((r) => r.sub === 'IA'), 'NSSA 不會自動送預設路由，外面的 Type-5（合作廠商的 O E2）也進不來，區域間的路還在');
    ok(/Perform type-7\/type-5 LSA translation/.test(dist('show ip ospf')) && /area border and autonomous system boundary router/.test(dist('show ip ospf')), 'Dist-RT 負責 Type-7 → Type-5 的轉換：show ip ospf 寫 Perform type-7/type-5 LSA translation，也成了 ASBR');
    const t5 = core('show ip ospf database').split('Type-5 AS External Link States')[1] || '';
    ok(/172\.20\.0\.0\s+10\.255\.0\.3/.test(t5) && /Type-7 AS External Link States \(Area 20\)/.test(dist('show ip ospf database')), 'Core 的 Type-5：172.20.0.0 的 ADV Router 是 Dist-RT；Dist-RT 的資料庫有 Type-7 (Area 20)');
    ok(/type NSSA extern 2, forward metric/.test(cli(s, 'fcore')('show ip route 172.20.0.0')), 'show ip route 172.20.0.0（FAC-Core）：type NSSA extern 2');
    dist('configure terminal', 'router ospf 1', 'area 20 nssa default-information-originate', 'end');
    const d7 = rt(s, 'fcore', '0.0.0.0', 0);
    ok(d7 && d7.sub === 'N2' && d7.metric === 1, 'area 20 nssa default-information-originate：FAC-Core 收到 O*N2 預設路由（metric 1，Type-7 不會被轉換）');
    dist('configure terminal', 'router ospf 1', 'area 20 nssa no-summary', 'end');
    const ia = ospfRts(s, 'fcore').filter((r) => r.sub === 'IA');
    ok(ia.length === 1 && ia[0].bits === 0 && rt(s, 'fcore', '172.20.0.0', 16).sub === 'N2', 'area 20 nssa no-summary（totally NSSA）：區域間的路換成一筆 O*IA 預設路由，區域裡的 O N2 還在');
    ok(/area 20 nssa default-information-originate no-summary/.test(runningConfig(s, s.devices.dist).join('\n')), 'running-config：area 20 nssa default-information-originate no-summary');
    fedge('configure terminal', 'router ospf 1', 'no area 20 nssa', 'end');
    ok(!(s.devices.fedge.rt.nbrs || []).some((n) => n.state === 'full'), 'FAC-Edge 改回一般區域：和 FAC-Core 的 NSSA 不一樣，鄰居斷掉');
  }

  // ── VRF 裡的 OSPF（l82）與路由洩漏
  {
    const { s } = fresh('l82');
    const pe = cli(s, 'pe');
    ok(!/Gi0\/0\/0|Gi0\/0\/1/.test(pe('show ip ospf interface brief')) && /Gi0\/0\/2/.test(pe('show ip ospf interface brief')), 'router ospf 1 的 network 10.0.0.0 0.255.255.255 不會涵蓋 VRF 裡的介面（只有全域的 Gi0/0/2）');
    ok(/程序 1 是全域路由表的 OSPF 程序/.test(pe('configure terminal', 'router ospf 1 vrf TENANT-A', 'end')) && /% VRF NOPE not configured/.test(pe('configure terminal', 'router ospf 5 vrf NOPE', 'end')), 'router ospf 1 vrf …：1 已經是全域的程序；不存在的 VRF 被拒絕');
    pe('configure terminal', 'router ospf 2 vrf TENANT-A', 'network 10.0.1.0 0.0.0.3 area 0', 'end');
    ok(/already in use by VRF TENANT-A/.test(pe('configure terminal', 'router ospf 2 vrf TENANT-B', 'end')), '同一個程序編號不能給兩個 VRF');
    ok(/VRF TENANT-B 的 OSPF 程序|VRF TENANT-B 裡/.test(pe('configure terminal', 'interface gi0/0/1', 'ip ospf 2 area 0', 'end')), 'VRF TENANT-B 的介面不能用 TENANT-A 的程序（ip ospf 2 area 0）');
    pe('configure terminal', 'router ospf 3 vrf TENANT-B', 'network 10.0.2.0 0.0.0.3 area 0', 'end');
    const a = rt(s, 'pe', '10.1.0.0', 16, 'TENANT-A'), b = rt(s, 'pe', '10.2.0.0', 16, 'TENANT-B');
    ok(a && a.type === 'O' && b && b.type === 'O' && !rt(s, 'pe', '10.1.0.0', 16) && !rt(s, 'pe', '10.2.0.0', 16, 'TENANT-A'), 'VRF 的程序：O 10.1.0.0/16 只進 TENANT-A 的路由表，O 10.2.0.0/16 只進 TENANT-B，全域的路由表都沒有');
    const nb = pe('show ip ospf neighbor');
    ok((nb.match(/FULL/g) || []).length === 3 && /Routing Process "ospf 2"[\s\S]*Connected to MPLS VPN Superbackbone, VRF TENANT-A/.test(pe('show ip ospf')), 'show ip ospf neighbor 列出三個程序的鄰居；show ip ospf 有 ospf 2 / VRF TENANT-A');
    ok(/Process 2, Nbr .* from LOADING to FULL/.test(pe('show logging')), '紀錄：OSPF-5-ADJCHG 寫的是 Process 2');
    ok(/router ospf 2 vrf TENANT-A\n network 10\.0\.1\.0 0\.0\.0\.3 area 0/.test(runningConfig(s, s.devices.pe).join('\n')), 'running-config：router ospf 2 vrf TENANT-A');
    // 兩個 VRF 用一模一樣的網段：DR 選舉、資料庫各自獨立
    const t = MS([MD('isr4331', 'p', { name: 'P', pos: [0, 0] }), MD('isr4321', 'x', { name: 'X', pos: [6, 0] }), MD('isr4321', 'y', { name: 'Y', pos: [-6, 0] })], [['p:Gi0/0/1', 'x:Gi0/0/0'], ['p:Gi0/0/2', 'y:Gi0/0/0']]);
    settle(t);
    const P = cli(t, 'p');
    P('configure terminal', 'vrf definition A', 'address-family ipv4', 'exit', 'exit', 'vrf definition B', 'address-family ipv4', 'exit', 'exit', 'interface gi0/0/1', 'vrf forwarding A', 'ip address 10.0.0.1 255.255.255.252', 'interface gi0/0/2', 'vrf forwarding B', 'ip address 10.0.0.1 255.255.255.252', 'exit', 'router ospf 2 vrf A', 'network 10.0.0.0 0.0.0.3 area 0', 'exit', 'router ospf 3 vrf B', 'network 10.0.0.0 0.0.0.3 area 0', 'end');
    for (const [id, lo] of [['x', '192.168.1.1'], ['y', '192.168.2.1']]) cli(t, id)('configure terminal', 'interface gi0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'interface loopback1', `ip address ${lo} 255.255.255.255`, 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.3 area 0', `network ${lo} 0.0.0.0 area 0`, 'end');
    ok(rt(t, 'p', '192.168.1.1', 32, 'A') && rt(t, 'p', '192.168.2.1', 32, 'B') && !rt(t, 'p', '192.168.2.1', 32, 'A') && rt(t, 'x', '192.168.2.1', 32) == null,
      '兩個 VRF 都用 10.0.0.0/30：各自和 CE 成為鄰居（CE 用的是全域的程序），彼此的路不會混在一起');
    const dbA = P('show ip ospf database').split('OSPF Router with ID');
    ok(dbA.length === 3 && !/192\.168\.2\.1/.test(dbA[1]) && /192\.168\.2\.1/.test(dbA[2]), 'show ip ospf database：每個程序只列自己網域的 LSA');
    // 路由洩漏
    ok(/global 只能用在 ip route vrf/.test(pe('configure terminal', 'ip route 10.5.0.0 255.255.0.0 10.0.99.2 global', 'end')), 'ip route … global 只能用在 VRF 的靜態路由');
    pe('configure terminal', 'ip route vrf TENANT-A 10.99.0.0 255.255.255.0 10.0.99.2 global', 'end');
    const lk = rt(s, 'pe', '10.99.0.0', 24, 'TENANT-A');
    ok(lk && lk.type === 'S' && lk.iface.id === 'Gi0/0/2' && lk.leak === 'global', 'ip route vrf TENANT-A … global：下一站在全域的路由表找，出口是全域的 Gi0/0/2');
    let r = sim.transact(s, 'apc', { proto: 'tcp', dst: IP('10.99.0.10'), dport: 443 });
    ok(!r.ok, 'CE-A 還不知道 10.99.0.0/24（沒有重分配給它）：A 公司還連不到');
    pe('configure terminal', 'router ospf 2 vrf TENANT-A', 'redistribute static subnets', 'end');
    r = sim.transact(s, 'apc', { proto: 'tcp', dst: IP('10.99.0.10'), dport: 443 });
    ok(rt(s, 'cea', '10.99.0.0', 24).sub === 'E2' && !r.ok && r.phase === 'reply', '重分配進 VRF 的 OSPF：CE-A 學到 O E2 10.99.0.0/24；但回程失敗（全域的路由表不知道 10.1.0.0/16）');
    pe('configure terminal', 'ip route 10.1.0.0 255.255.0.0 GigabitEthernet0/0/0 10.0.1.2', 'end');
    r = sim.transact(s, 'apc', { proto: 'tcp', dst: IP('10.99.0.10'), dport: 443 });
    ok(r.ok && /S\s+10\.1\.0\.0 \[1\/0\] via 10\.0\.1\.2, GigabitEthernet0\/0\/0/.test(pe('show ip route static')), '回程：全域的靜態路由出口介面在 VRF TENANT-A（show ip route 印出出口介面），A 公司連到更新伺服器');
    ok(/ip route vrf TENANT-A 10\.99\.0\.0 255\.255\.255\.0 10\.0\.99\.2 global/.test(runningConfig(s, s.devices.pe).join('\n')) && /ip route 10\.1\.0\.0 255\.255\.0\.0 GigabitEthernet0\/0\/0 10\.0\.1\.2/.test(runningConfig(s, s.devices.pe).join('\n')), 'running-config：… global 與 … GigabitEthernet0/0/0 10.0.1.2');
    pe('configure terminal', 'no ip route 10.1.0.0 255.255.0.0 GigabitEthernet0/0/0 10.0.1.2', 'end');
    ok(!(s.devices.pe.routes || []).some((x) => x.outIf), 'no ip route … <出口介面> <下一站>：刪得掉');
    // 洩漏預設路由會破壞隔離
    const { s: s2 } = solved('l82');
    const pe2 = cli(s2, 'pe');
    pe2('configure terminal', 'ip route vrf TENANT-A 0.0.0.0 0.0.0.0 10.0.99.2 global', 'ip route vrf TENANT-B 0.0.0.0 0.0.0.0 10.0.99.2 global', 'end');
    ok(!sim.transact(s2, 'apc', { proto: 'icmp', dst: IP('10.2.0.50') }).ok, '洩漏了預設路由，但 redistribute static 不會帶出預設路由：CE 還不知道，A、B 暫時還是不通');
    pe2('configure terminal', 'router ospf 2 vrf TENANT-A', 'default-information originate', 'exit', 'router ospf 3 vrf TENANT-B', 'default-information originate', 'end');
    ok(sim.transact(s2, 'apc', { proto: 'icmp', dst: IP('10.2.0.50') }).ok, '反例：再加上 default-information originate，A 公司就能經過全域的路由表連到 B 公司（隔離被破壞）');
  }

  // ── iBGP（l81）
  {
    const { s } = fresh('l81');
    const ra = cli(s, 'ra'), rb = cli(s, 'rb'), core = cli(s, 'core');
    ok(/來源位址對不上/.test(ra('show ip bgp summary')), '兩端都用 Loopback 當鄰居、都沒有 update-source：停在 Active，說明來源位址對不上');
    ra('configure terminal', 'router bgp 65010', 'neighbor 10.255.0.2 update-source loopback0', 'end');
    const peer = s.devices.ra.rt.bgp.peers.find((p) => p.ip === '10.255.0.2');
    ok(peer.state === 'Established', '只有一端設 update-source 也起得來：R-A 從 Loopback 連過去，R-B 認得這個位址（另一個方向雖然不行，但一個方向就夠）');
    rb('configure terminal', 'router bgp 65010', 'neighbor 10.255.0.1 update-source loopback0', 'end');
    const ib = s.devices.ra.rt.bgp.table.find((r) => r.net === IP('198.51.100.0') && r.ibgp);
    ok(ib && ib.valid === false && /inaccessible/.test(ra('show ip bgp 198.51.100.0')) && /^ {2}i 198\.51\.100\.0/m.test(ra('show ip bgp').replace(/^ {3}/gm, '  ')) === false || (ib && ib.valid === false), 'R-B 沒有 next-hop-self：R-A 從 iBGP 學到的 198.51.100.0/24 下一站是 198.51.100.1，inaccessible，不能當最佳路徑');
    rb('configure terminal', 'router bgp 65010', 'neighbor 10.255.0.1 next-hop-self', 'end');
    const best = s.devices.ra.rt.bgp.table.find((r) => r.net === IP('198.51.100.0') && r.best);
    const inst = rt(s, 'ra', '198.51.100.0', 24);
    ok(best && best.ibgp && best.nh === IP('10.255.0.2') && inst.ad === 200 && inst.bnh === IP('10.255.0.2') && inst.via === IP('10.0.1.2'), 'next-hop-self：下一站變成 R-B 的 Loopback；iBGP 的路比 eBGP 繞網際網路那條短（AS path 1 對 3），裝進路由表 AD 200，遞迴到 Core');
    ok(/\*>i 198\.51\.100\.0\s+10\.255\.0\.2\s+0\s+100\s+0 64510 i/.test(ra('show ip bgp')), 'show ip bgp：*>i、LocPrf 100、AS path 64510');
    ok(/B\s+198\.51\.100\.0\/24 \[200\/0\] via 10\.255\.0\.2/.test(ra('show ip route bgp')) && /type internal/.test(ra('show ip route 198.51.100.0')), 'show ip route：B … [200/0] via 10.255.0.2（BGP 的下一站）；type internal');
    let r = sim.transact(s, 'pc', { proto: 'tcp', dst: IP('198.51.100.80'), dport: 443 });
    ok(!r.ok && /Core/.test(r.reason), '邊界路由器都對了，員工還是連不到：Core 沒有跑 BGP（BGP 黑洞）');
    // route reflector：Core 只和 R-A、R-B 建 iBGP，R-A ↔ R-B 拿掉
    for (const [x, o, lo] of [[ra, '10.255.0.2', '10.255.0.1'], [rb, '10.255.0.1', '10.255.0.2']]) x('configure terminal', 'router bgp 65010', `no neighbor ${o}`, 'neighbor 10.255.0.3 remote-as 65010', 'neighbor 10.255.0.3 update-source loopback0', 'neighbor 10.255.0.3 next-hop-self', 'end');
    core('configure terminal', 'router bgp 65010', 'neighbor 10.255.0.1 remote-as 65010', 'neighbor 10.255.0.1 update-source loopback0', 'neighbor 10.255.0.2 remote-as 65010', 'neighbor 10.255.0.2 update-source loopback0', 'end');
    ok(!rt(s, 'ra', '198.51.100.0', 24) || rt(s, 'ra', '198.51.100.0', 24).ad === 20, 'Core 不是 route reflector：從 R-B 學到的路不會轉送給 R-A（iBGP split horizon），R-A 只剩繞網際網路的 eBGP 路');
    core('configure terminal', 'router bgp 65010', 'neighbor 10.255.0.1 route-reflector-client', 'neighbor 10.255.0.2 route-reflector-client', 'end');
    const refl = s.devices.ra.rt.bgp.table.find((x) => x.net === IP('198.51.100.0') && x.best);
    ok(refl && refl.ibgp && refl.originator === IP('10.255.0.2') && refl.cluster[0] === IP('10.255.0.3') && /Originator: 10\.255\.0\.2, Cluster list: 10\.255\.0\.3/.test(ra('show ip bgp 198.51.100.0')), 'Core 當 route reflector：R-A 收到反射的路，帶著 Originator 10.255.0.2、Cluster list 10.255.0.3');
    r = sim.transact(s, 'pc', { proto: 'tcp', dst: IP('198.51.100.80'), dport: 443 });
    ok(r.ok && /Route-Reflector Client/.test(core('show ip bgp neighbors 10.255.0.1')), '員工連得到 ISP-B 的服務；show ip bgp neighbors 寫 Route-Reflector Client');
    ok(/% Invalid command for an EBGP peer/.test(ra('configure terminal', 'router bgp 65010', 'neighbor 203.0.113.1 route-reflector-client', 'end')), 'eBGP 鄰居不能是 route-reflector-client');
    // RIB-failure：同一個網段 OSPF 也有（110 比 200 小）
    core('configure terminal', 'ip route 198.51.100.0 255.255.255.0 10.0.2.1', 'end');
    ok(/^ r>i 198\.51\.100\.0/m.test(core('show ip bgp')) && rt(s, 'core', '198.51.100.0', 24).type === 'S', 'Core 上同一個網段有靜態路由：BGP 那條標成 r（RIB-failure），路由表裡用靜態的');
    core('configure terminal', 'no ip route 198.51.100.0 255.255.255.0 10.0.2.1', 'end');
    // redistribute bgp 進 OSPF：預設不包含 iBGP 學到的路
    core('configure terminal', 'router ospf 1', 'redistribute bgp 65010 subnets', 'end');
    ok(!rt(s, 'ra', '198.51.100.0', 24) || rt(s, 'ra', '198.51.100.0', 24).type !== 'O', 'redistribute bgp：Core 的 BGP 路都是 iBGP 學到的，預設不會被重分配進 OSPF（要 bgp redistribute-internal）');
    core('configure terminal', 'router ospf 1', 'no redistribute bgp', 'end');
  }

  // ── ebgp-multihop 與 community
  {
    const { s } = solved('l81');
    const ra = cli(s, 'ra');
    ok(/neighbor 10\.255\.0\.3 update-source Loopback0/.test(runningConfig(s, s.devices.ra).join('\n')) && /neighbor 10\.255\.0\.3 next-hop-self/.test(runningConfig(s, s.devices.ra).join('\n')), 'running-config：update-source Loopback0、next-hop-self');
    // ISP-B 的服務標上 no-export：R-B 送給 R-A 時要 send-community，R-A 就不會再送給 ISP-A
    const rb = cli(s, 'rb');
    rb('configure terminal', 'route-map ISPB-IN permit 10', 'set community 65010:200 no-export', 'exit', 'router bgp 65010', 'neighbor 198.51.100.1 route-map ISPB-IN in', 'end');
    const noSend = s.devices.ra.rt.bgp.table.find((x) => x.net === IP('198.51.100.0') && x.ibgp);
    ok(noSend && !(noSend.comm || []).length, '沒有 send-community：community 不會送給 iBGP 鄰居');
    rb('configure terminal', 'router bgp 65010', 'neighbor 10.255.0.1 send-community', 'neighbor 10.255.0.3 send-community', 'end');
    const got = s.devices.ra.rt.bgp.table.find((x) => x.net === IP('198.51.100.0') && x.ibgp);
    ok(got && got.comm.length === 2 && /Community: 4260495560 no-export/.test(ra('show ip bgp 198.51.100.0')), 'send-community 之後 R-A 收到 community；沒有 ip bgp-community new-format 時 IOS 印成十進位');
    ra('configure terminal', 'ip bgp-community new-format', 'end');
    ok(/Community: 65010:200 no-export/.test(ra('show ip bgp 198.51.100.0')), 'ip bgp-community new-format：印成 65010:200');
    const ispaGot = s.devices.ispa.rt.bgp.table.filter((x) => x.net === IP('198.51.100.0') && x.from === 'ra');
    ok(!ispaGot.length, 'no-export：R-A 不會把它送給 ISP-A（eBGP）');
    ra('configure terminal', 'ip community-list standard NOEXP permit no-export', 'route-map DROP-NOEXP deny 10', 'match community NOEXP', 'route-map DROP-NOEXP permit 20', 'end');
    ok(/ip community-list standard NOEXP permit no-export/.test(runningConfig(s, s.devices.ra).join('\n')) && /match community NOEXP/.test(runningConfig(s, s.devices.ra).join('\n')) && /set community 65010:200 no-export/.test(runningConfig(s, s.devices.rb).join('\n')), 'running-config：ip community-list、match community、set community');
    // ebgp-multihop：用 Loopback 建立 eBGP
    const t = MS([MD('isr4331', 'a', { name: 'A', pos: [0, 0] }), MD('isr4331', 'b', { name: 'B', pos: [6, 0] }), MD('isr4331', 'm', { name: 'M', pos: [3, 4] })], [['a:Gi0/0/0', 'm:Gi0/0/0'], ['m:Gi0/0/1', 'b:Gi0/0/0']]);
    settle(t);
    const A = cli(t, 'a'), B = cli(t, 'b'), M = cli(t, 'm');
    A('configure terminal', 'interface gi0/0/0', 'ip address 10.1.0.1 255.255.255.252', 'interface lo0', 'ip address 1.1.1.1 255.255.255.255', 'exit', 'ip route 2.2.2.2 255.255.255.255 10.1.0.2', 'router bgp 65001', 'neighbor 2.2.2.2 remote-as 65002', 'neighbor 2.2.2.2 update-source loopback0', 'end');
    B('configure terminal', 'interface gi0/0/0', 'ip address 10.2.0.1 255.255.255.252', 'interface lo0', 'ip address 2.2.2.2 255.255.255.255', 'exit', 'ip route 1.1.1.1 255.255.255.255 10.2.0.2', 'router bgp 65002', 'neighbor 1.1.1.1 remote-as 65001', 'neighbor 1.1.1.1 update-source loopback0', 'end');
    M('configure terminal', 'interface gi0/0/0', 'ip address 10.1.0.2 255.255.255.252', 'interface gi0/0/1', 'ip address 10.2.0.2 255.255.255.252', 'exit', 'ip route 1.1.1.1 255.255.255.255 10.1.0.1', 'ip route 2.2.2.2 255.255.255.255 10.2.0.1', 'end');
    const st = () => t.devices.a.rt.bgp.peers[0];
    ok(st().state === 'Idle' && /ebgp-multihop/.test(st().why), 'eBGP 的鄰居是 Loopback（不是直連）：Idle，提示要 ebgp-multihop');
    A('configure terminal', 'router bgp 65001', 'neighbor 2.2.2.2 disable-connected-check', 'end');
    B('configure terminal', 'router bgp 65002', 'neighbor 1.1.1.1 disable-connected-check', 'end');
    ok(st().state === 'Active' && /TTL/.test(st().why), 'disable-connected-check 只跳過直連檢查，TTL 還是 1：中間隔了 M，到不了');
    A('configure terminal', 'router bgp 65001', 'no neighbor 2.2.2.2 disable-connected-check', 'neighbor 2.2.2.2 ebgp-multihop 2', 'end');
    B('configure terminal', 'router bgp 65002', 'no neighbor 1.1.1.1 disable-connected-check', 'neighbor 1.1.1.1 ebgp-multihop 2', 'end');
    ok(st().state === 'Established' && /may be up to 2 hops away/.test(A('show ip bgp neighbors 2.2.2.2')), 'ebgp-multihop 2：Established；show ip bgp neighbors 寫 may be up to 2 hops away');
  }
}

console.log('\n第二層安全：Port Security、MAC flooding、靜態 MAC、Storm Control、Protected / Private VLAN、雙重標籤、RA Guard');
{
  const sim = await import('../src/engine/sim.js');
  const s6 = await import('../src/engine/sim6.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { makeDevice: MD, makeState: MS, newIface: NI } = await import('../src/engine/model.js');
  const { parseIp6 } = await import('../src/engine/ip6.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const IP = (x) => parseIp(x);
  const leak = (r, id) => r.hops.some((h) => (h.leak || []).some((x) => x.to === id));
  // 不快轉的版本：每一行只重新計算一次（看得到計時器還在跑的中間狀態）
  const cliNow = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, () => {}); if (r.changed) sim.recompute(s); } }; };
  // ── MAC flooding 與 Port Security
  const t = MS([MD('c2960', 'sw', { name: 'SW', pos: [0, 0] }), MD('pc', 'pc1', { name: 'PC1', pos: [-4, 4], ip: '10.0.0.11' }), MD('tower', 'srv', { name: 'SRV', pos: [4, 4], ip: '10.0.0.10', services: [{ proto: 'tcp', port: 445, name: 'SMB' }] }),
    MD('laptop', 'atk', { name: 'ATK', pos: [0, 5], ip: '10.0.0.66', init(d) { d.macFlood = true; } })], [['pc1:eth0', 'sw:Gi0/1'], ['srv:eth0', 'sw:Gi0/2'], ['atk:eth0', 'sw:Gi0/5']]);
  settle(t);
  const SW = cli(t, 'sw');
  let r = sim.transact(t, 'pc1', { proto: 'tcp', dst: IP('10.0.0.10'), dport: 445 });
  ok(r.ok && leak(r, 'atk') && /Total Mac Address Space Available: 0/.test(SW('show mac address-table count')), 'macof 把 8,192 筆的表塞滿：新的 MAC 學不進來，PC 和伺服器之間的流量被泛洪到攻擊者');
  ok(/另外還有 8,1\d\d 筆，全部學在 Gi0\/5/.test(SW('show mac address-table')), 'show mac address-table：幾千筆亂造的 MAC 都學在 Gi0/5');
  {
    // 另一條路：直接打開（預設 maximum 1、violation shutdown）
    const a = cloneState(t); sim.recompute(a);
    cliNow(a, 'sw')('configure terminal', 'interface gi0/5', 'switchport mode access', 'switchport port-security', 'end');
    ok(a.devices.sw.rt.err['Gi0/5'] === true && /psecure-violation/.test(cli(a, 'sw')('show interfaces status err-disabled')) && !(a.dyn.cam || {}).sw, '先打開 switchport port-security（預設 maximum 1、violation shutdown）：攻擊的埠馬上 err-disabled，從那個埠學到的亂造項目跟著清掉');
  }
  // 先設好 maximum 與違規動作，最後才打開
  cliNow(t, 'sw')('configure terminal', 'interface gi0/5', 'spanning-tree portfast', 'switchport mode access', 'switchport port-security maximum 2', 'switchport port-security violation restrict', 'switchport port-security', 'end');
  const ps = SW('show port-security interface gi0/5');
  ok(!t.devices.sw.rt.err['Gi0/5'] && /Violation Mode\s+: Restrict/.test(ps) && /Maximum MAC Addresses\s+: 2/.test(ps) && /Port Status\s+: Secure-up/.test(ps), 'maximum 2、violation restrict：埠維持 up，違規的訊框被丟掉');
  r = sim.transact(t, 'pc1', { proto: 'tcp', dst: IP('10.0.0.10'), dport: 445 });
  ok(t.dyn.cam.sw && leak(r, 'atk'), '擋住了，但表裡已經塞進去的還要等老化：這段時間照樣泛洪');
  ok(sim.pendingOf(t).some((p) => p.kind === 'mac'), '亂造的項目老化的時間排進了計時器（收斂中）');
  settle(t);
  sim.transact(t, 'pc1', { proto: 'tcp', dst: IP('10.0.0.10'), dport: 445 });
  r = sim.transact(t, 'pc1', { proto: 'tcp', dst: IP('10.0.0.10'), dport: 445 });
  ok(!t.dyn.cam.sw && !leak(r, 'atk') && r.ok, '300 秒後亂造的項目老化：表恢復正常，攻擊者收不到別人的流量');
  ok(/PORT_SECURITY-2-PSECURE_VIOLATION/.test(SW('show logging')), 'restrict 模式記一筆 %PORT_SECURITY-2-PSECURE_VIOLATION');
  ok(/ switchport port-security\n switchport port-security maximum 2\n switchport port-security violation restrict/.test(runningConfig(t, t.devices.sw).join('\n')), 'running-config：maximum 2、violation restrict（預設的 maximum 1 與 shutdown 不印）');
  SW('configure terminal', 'interface gi0/1', 'switchport mode access', 'switchport port-security', 'switchport port-security mac-address sticky', 'end');
  const mac1 = t.devices.pc1.ifaces[0].rt.mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');
  ok(new RegExp(`switchport port-security mac-address sticky ${mac1}`).test(runningConfig(t, t.devices.sw).join('\n')), 'mac-address sticky：已經動態學到的安全位址轉成 sticky，寫進 running-config');
  SW('configure terminal', 'interface gi0/3', 'switchport port-security maximum 1', 'end');
  ok(/maximum 不能比它小/.test(SW('configure terminal', 'interface gi0/1', 'switchport port-security mac-address 0011.2233.4455', 'switchport port-security maximum 1', 'end')), 'maximum 不能比已經設定的安全位址還少');
  // 靜態 MAC
  const srvMac = t.devices.srv.ifaces[0].rt.mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');
  SW('configure terminal', `mac address-table static ${srvMac} vlan 1 interface gi0/2`, 'end');
  ok(new RegExp(`${srvMac}\\s+STATIC\\s+Gi0/2`).test(SW('show mac address-table static')) && new RegExp(`mac address-table static ${srvMac} vlan 1 interface GigabitEthernet0/2`).test(runningConfig(t, t.devices.sw).join('\n')), 'mac address-table static：表裡是 STATIC，running-config 也有');
  SW('configure terminal', `mac address-table static ${t.devices.pc1.ifaces[0].rt.mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.')} vlan 1 drop`, 'end');
  ok(!sim.transact(t, 'pc1', { proto: 'icmp', dst: IP('10.0.0.10') }).ok, 'mac address-table static … drop：這個 MAC 送的訊框一律丟掉');

  // ── Storm Control
  const u = MS([MD('c2960', 'sw', { name: 'SW', pos: [0, 0] }), MD('pc', 'pc1', { name: 'PC1', pos: [-4, 4], ip: '10.0.0.11' }), MD('tower', 'srv', { name: 'SRV', pos: [4, 4], ip: '10.0.0.10', services: [{ proto: 'tcp', port: 445, name: 'SMB' }] }),
    MD('pc', 'bad', { name: 'BAD', pos: [0, 5], ip: '10.0.0.77', init(d) { d.bcastFlood = 900; } })], [['pc1:eth0', 'sw:Gi0/1'], ['srv:eth0', 'sw:Gi0/2'], ['bad:eth0', 'sw:Gi0/5']]);
  settle(u);
  const U = cli(u, 'sw');
  const sp = () => sim.throughput(u, sim.transact(u, 'pc1', { proto: 'tcp', dst: IP('10.0.0.10'), dport: 445 }).hops).mbps;
  ok(sp() < 100, `有人狂送 900 Mbps 的廣播：PC 到伺服器只剩 ${sp()} Mbps`);
  U('configure terminal', 'interface gi0/5', 'storm-control broadcast level 1.00', 'end');
  ok(sp() > 800 && /Gi0\/5\s+Blocking\s+1\.00%\s+1\.00%\s+90\.00%/.test(U('show storm-control')), 'storm-control broadcast level 1.00：超過 10 Mbps 的廣播被丟掉，速度恢復；show storm-control 是 Blocking、目前 90%');
  ok(/STORM_CONTROL-3-FILTERED/.test(U('show logging')), '過濾時記一筆 %STORM_CONTROL-3-FILTERED');
  U('configure terminal', 'interface gi0/5', 'storm-control action shutdown', 'end');
  ok(u.devices.sw.rt.err['Gi0/5'] === 'storm' && /storm-control/.test(U('show interfaces status err-disabled')) && /STORM_CONTROL-3-SHUTDOWN/.test(U('show logging')), 'action shutdown：埠 err-disabled，原因 storm-control');
  ok(/ storm-control broadcast level 1\.00\n storm-control action shutdown/.test(runningConfig(u, u.devices.sw).join('\n')), 'running-config：storm-control broadcast level 1.00、action shutdown');
  U('configure terminal', 'interface range gi0/1 , gi0/2', 'switchport protected', 'end');
  ok(!sim.transact(u, 'pc1', { proto: 'icmp', dst: IP('10.0.0.10') }).ok && /Protected: true/.test(U('show interfaces gi0/1 switchport')), 'switchport protected：同一台的兩個 protected 埠彼此不通');

  // ── Private VLAN
  const { s: pv } = (() => { const lv = LEVELS.find((l) => l.id === 'l86'); const s = lv.setup(); settle(s); lv.solve(s); settle(s); return { s }; })();
  const P = cli(pv, 'sw');
  const okp = (a, b) => sim.transact(pv, a, { proto: 'tcp', dst: pv.devices[b].ifaces[0].rt.ip, dport: 445 }).ok;
  ok(!okp('r1201', 'r1202') && okp('ca', 'cb') && !okp('ca', 'r1201') && pv.devices.r1201.ifaces[0].rt.src === 'dhcp', 'Private VLAN：isolated 彼此不通、community 同組互通、DHCP 照樣從 promiscuous 埠拿到位址');
  ok(/100\s+101\s+isolated\s+Gi1\/0\/1, Gi1\/0\/2, Gi1\/0\/24/.test(P('show vlan private-vlan')), 'show vlan private-vlan 列出每個 secondary 對應的埠');
  const c2960 = MS([MD('c2960', 'x', { name: 'X', pos: [0, 0] })], []); settle(c2960);
  ok(/not supported on this platform/.test(cli(c2960, 'x')('configure terminal', 'vlan 100', 'private-vlan primary', 'end')), 'Catalyst 2960 沒有 Private VLAN（只有 switchport protected）');

  // ── 雙重標籤
  const { s: dt, lv: l84 } = (() => { const lv = LEVELS.find((l) => l.id === 'l84'); const s = lv.setup(); settle(s); return { s, lv }; })();
  const atk = () => sim.transact(dt, 'atk', { proto: 'udp', dst: IP('10.30.20.10'), dport: 514, quiet: true });
  ok(atk().phase === 'reply', '雙重標籤：外層 VLAN 10 被 SW-3F 拿掉，從 Native VLAN 10 的 Trunk 不加標籤送出，封包到得了 VLAN 20 的伺服器（回覆回不去）');
  cli(dt, 'swa')('configure terminal', 'vlan dot1q tag native', 'end');
  ok(atk().phase === 'request' && /Administrative Native VLAN tagging: enabled/.test(cli(dt, 'swa')('show interfaces gi0/9 switchport')), 'vlan dot1q tag native：Native VLAN 的訊框也加標籤，裡面那層不會被當真');
  cli(dt, 'swa')('configure terminal', 'no vlan dot1q tag native', 'end');
  ok(atk().phase === 'reply', '拿掉 tag native：攻擊又成立');
  l84.solve(dt); settle(dt);
  ok(atk().phase === 'request', 'Trunk 的 Native VLAN 改成沒人用的 999（兩端）：攻擊失效');

  // ── RA Guard
  const { s: ra } = (() => { const lv = LEVELS.find((l) => l.id === 'l87'); const s = lv.setup(); settle(s); return { s }; })();
  const v = ra.devices.pc1.ifaces[0].rt.v6;
  ok(v.router === 'rogue' && v.addrs.some((a) => a.rogue) && v.addrs.length === 2, '冒牌的 RA（優先權 High）：PC 多一個 2001:db8:bad:: 的位址，預設閘道是那台筆電');
  ok(!s6.transact6(ra, 'pc1', parseIp6('2001:db8:99::10'), { proto: 'tcp', port: 443 }).ok, '筆電不轉送：IPv6 全斷（黑洞）');
  cli(ra, 'sw')('configure terminal', 'ipv6 nd raguard policy HOSTS', 'device-role host', 'exit', 'interface range gi0/1 - 8', 'ipv6 nd raguard attach-policy HOSTS', 'end');
  const v2 = ra.devices.pc1.ifaces[0].rt.v6;
  ok(v2.router === 'r1' && !v2.addrs.some((a) => a.rogue) && (v2.raBlocked || [])[0].where === 'SW-RD 的 Gi0/6', 'RA Guard（device-role host）：從 Gi0/6 進來的 RA 被丟掉，預設閘道回到 R1');
  ok(/ipv6 nd raguard policy HOSTS\n device-role host/.test(runningConfig(ra, ra.devices.sw).join('\n')) && /Gi0\/6\s+PORT\s+HOSTS\s+RA guard/.test(cli(ra, 'sw')('show ipv6 nd raguard policy')), 'running-config 與 show ipv6 nd raguard policy');
  void NI;
}

console.log('\nTunnel 介面：GRE、keepalive、recursive routing、GRE over IPsec、VTI、DMVPN（NHRP）、NAT-T');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { makeDevice: MD, makeState: MS, setLine: SL, cloneState: CS } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const IP = (x) => parseIp(x);
  const ping = (s, from, to) => sim.transact(s, from, { proto: 'icmp', dst: IP(to) });
  const hops = (r) => r.l3.map((h) => fmtIpT(h.ip)).join(' → ');
  const tun = (s, id, n = 0) => s.devices[id].ifaces.find((i) => i.id === 'Tu' + n);
  const ip4 = (d, port, ip, mask = '255.255.255.0') => Object.assign(d.ifaces.find((i) => i.id === port), { ip, mask });

  // ── 兩個據點經過 ISP 的路由器：GRE + OSPF
  const two = () => {
    const s = MS([
      MD('isr4331', 'r1', { name: 'R1', pos: [-6, 0], init(d) { ip4(d, 'Gi0/0/0', '203.0.113.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.1.0.1'); d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '203.0.113.2' }); } }),
      MD('isr4331', 'isp', { name: 'ISP', pos: [0, -4], init(d) { ip4(d, 'Gi0/0/0', '203.0.113.2', '255.255.255.252'); ip4(d, 'Gi0/0/1', '198.51.100.2', '255.255.255.252'); } }),
      MD('isr4331', 'r2', { name: 'R2', pos: [6, 0], init(d) { ip4(d, 'Gi0/0/0', '198.51.100.1', '255.255.255.252'); ip4(d, 'Gi0/0/1', '10.2.0.1'); d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: '198.51.100.2' }); } }),
      MD('pc', 'pc1', { name: 'PC1', pos: [-8, 5], ip: '10.1.0.10', gw: '10.1.0.1' }), MD('pc', 'pc2', { name: 'PC2', pos: [8, 5], ip: '10.2.0.10', gw: '10.2.0.1' }),
    ], [['r1:Gi0/0/0', 'isp:Gi0/0/0'], ['r2:Gi0/0/0', 'isp:Gi0/0/1'], ['pc1:eth0', 'r1:Gi0/0/1'], ['pc2:eth0', 'r2:Gi0/0/1']]);
    settle(s);
    cli(s, 'r1')('configure terminal', 'interface Tunnel0', 'ip address 10.0.0.1 255.255.255.252', 'tunnel source Gi0/0/0', 'tunnel destination 198.51.100.1', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.3 area 0', 'network 10.1.0.0 0.0.0.255 area 0', 'end');
    cli(s, 'r2')('configure terminal', 'interface Tunnel0', 'ip address 10.0.0.2 255.255.255.252', 'tunnel source Gi0/0/0', 'tunnel destination 203.0.113.1', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.3 area 0', 'network 10.2.0.0 0.0.0.255 area 0', 'end');
    return s;
  };
  const g = two();
  const R1 = cli(g, 'r1');
  ok(tun(g, 'r1').rt.link && tun(g, 'r1').rt.tun.mtu === 1476 && /Tunnel0\s+10\.0\.0\.1\s+YES manual up\s+up/.test(R1('show ip interface brief')), 'GRE：Tunnel0 up/up，Tunnel 的 MTU 是 1500 − 24 = 1476');
  const r = ping(g, 'pc1', '10.2.0.10');
  ok(r.ok && hops(r) === '10.1.0.1 → 10.0.0.2' && r.log.some((l) => /GRE 封裝/.test(l.text)), `PC1 → PC2 走 GRE：traceroute 只看到兩站（${hops(r)}），ISP 那一段在外層`);
  ok(g.devices.r1.rt.nbrs.some((n) => n.iface === 'Tu0' && n.state === 'full') && /O\s+10\.2\.0\.0\/24 \[110\/1001\] via 10\.0\.0\.2, \S+, Tunnel0/.test(R1('show ip route')), 'OSPF 在 Tunnel0 上 FULL（預設 point-to-point），學到 10.2.0.0/24，cost 1000 + 1');
  ok(/Tunnel0 is up, line protocol is up/.test(R1('show interfaces tunnel 0')) && /Tunnel source 203\.0\.113\.1 \(GigabitEthernet0\/0\/0\), destination 198\.51\.100\.1/.test(R1('show interfaces tu0')) && /Tunnel protocol\/transport GRE\/IP/.test(R1('show interfaces tu0')), 'show interfaces Tunnel0：source、destination、GRE/IP');
  // 沒有 keepalive：對面關掉了，這一端照樣 up/up
  const g2 = CS(g); settle(g2);
  cli(g2, 'r2')('configure terminal', 'interface Tunnel0', 'shutdown', 'end');
  ok(tun(g2, 'r1').rt.link && /GRE 封包送不到對面/.test(cli(g2, 'r1')('show interfaces tunnel0')), '沒有 keepalive：R2 的 Tunnel0 shutdown，R1 的 Tunnel0 還是 up/up（只要有路到 destination）');
  cli(g2, 'r1')('configure terminal', 'interface Tunnel0', 'keepalive 5 3', 'end');
  ok(!tun(g2, 'r1').rt.link && /keepalive/.test(tun(g2, 'r1').rt.tun.why) && /LINEPROTO-5-UPDOWN: Line protocol on Interface Tunnel0, changed state to down/.test(cli(g2, 'r1')('show logging')), 'keepalive 5 3：15 秒沒有回應，line protocol down');
  cli(g2, 'r2')('configure terminal', 'interface Tunnel0', 'no shutdown', 'end');
  ok(tun(g2, 'r1').rt.link, '對面恢復：keepalive 有回應，馬上 up');
  // tunnel key
  const g3 = CS(g); settle(g3);
  cli(g3, 'r1')('configure terminal', 'interface Tunnel0', 'tunnel key 100', 'end');
  const rk = ping(g3, 'r1', '10.0.0.2');
  ok(!rk.ok && /tunnel key 不一致/.test(rk.reason), 'tunnel key 只設一端：GRE 封包被對面丟掉');
  // recursive routing
  const g4 = CS(g); settle(g4);
  cli(g4, 'r2')('configure terminal', 'router ospf 1', 'network 198.51.100.0 0.0.0.3 area 0', 'end');
  sim.advance(g4, 10);
  const rc = tun(g4, 'r1').rt.tun;
  ok(rc.recur && !tun(g4, 'r1').rt.link && /O 198\.51\.100\.0\/30/.test(rc.why) && /TUN-5-RECURDOWN: Tunnel0 temporarily disabled due to recursive routing/.test(cli(g4, 'r1')('show logging')), 'R2 把 WAN 也放進 OSPF：R1 從 Tunnel 學到 tunnel destination 的網段 → recursive routing，Tunnel0 被暫停');
  sim.advance(g4, 31);
  const up = tun(g4, 'r1').rt.link;
  sim.advance(g4, 10);
  ok(up && !tun(g4, 'r1').rt.link && g4.dyn.greRecur['r1/Tu0'].n >= 2, '暫停時間到了又起來、OSPF 學到路之後又被關掉：一直 flapping');
  cli(g4, 'r2')('configure terminal', 'router ospf 1', 'no network 198.51.100.0 0.0.0.3 area 0', 'end');
  sim.advance(g4, 60); settle(g4);
  ok(tun(g4, 'r1').rt.link && ping(g4, 'pc1', '10.2.0.10').ok, '拿掉 WAN 的 network 敘述：Tunnel 穩定、恢復通訊');
  // ip route … Tunnel0（只寫出口介面）
  const g5 = two();
  for (const id of ['r1', 'r2']) cli(g5, id)('configure terminal', 'no router ospf 1', 'end');
  cli(g5, 'r1')('configure terminal', 'ip route 10.2.0.0 255.255.255.0 Tunnel0', 'end');
  cli(g5, 'r2')('configure terminal', 'ip route 10.1.0.0 255.255.255.0 Tunnel0', 'end');
  ok(ping(g5, 'pc1', '10.2.0.10').ok && /S\s+10\.2\.0\.0\/24 is directly connected, Tunnel0/.test(cli(g5, 'r1')('show ip route')) && runningConfig(g5, g5.devices.r1).includes('ip route 10.2.0.0 255.255.255.0 Tunnel0'), 'ip route 10.2.0.0 255.255.255.0 Tunnel0：點對點的 Tunnel 可以只寫出口介面');

  // ── hub 與兩個 spoke 接在網際網路上
  const three = () => {
    const lines3 = [1, 2, 3].map((n) => ({ id: 'line' + n, label: '線路 ' + n, media: 'rj45' }));
    const inet = MD('internet', 'inet', { name: '網際網路', pos: [0, -9], ports: lines3 });
    SL(inet, 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' });
    SL(inet, 'line2', { type: 'static', gw: '198.51.100.1', mask: '255.255.255.252', assign: '198.51.100.2' });
    SL(inet, 'line3', { type: 'static', gw: '192.0.2.1', mask: '255.255.255.252', assign: '192.0.2.2' });
    const rt = (id, name, wan, gw, lan) => MD('isr4331', id, { name, pos: [0, 0], init(d) { ip4(d, 'Gi0/0/0', wan, '255.255.255.252'); ip4(d, 'Gi0/0/1', lan); d.routes.push({ dst: '0.0.0.0', mask: '0.0.0.0', via: gw }); } });
    const s = MS([inet, rt('hub', 'HUB', '203.0.113.2', '203.0.113.1', '10.0.1.1'), rt('s1', 'SPOKE1', '198.51.100.2', '198.51.100.1', '10.1.1.1'), rt('s2', 'SPOKE2', '192.0.2.2', '192.0.2.1', '10.2.1.1'),
      MD('pc', 'pch', { name: 'PC-H', pos: [0, 4], ip: '10.0.1.10', gw: '10.0.1.1' }), MD('pc', 'pc1', { name: 'PC1', pos: [-8, 5], ip: '10.1.1.10', gw: '10.1.1.1' }), MD('pc', 'pc2', { name: 'PC2', pos: [8, 5], ip: '10.2.1.10', gw: '10.2.1.1' })],
    [['inet:line1', 'hub:Gi0/0/0'], ['inet:line2', 's1:Gi0/0/0'], ['inet:line3', 's2:Gi0/0/0'], ['pch:eth0', 'hub:Gi0/0/1'], ['pc1:eth0', 's1:Gi0/0/1'], ['pc2:eth0', 's2:Gi0/0/1']]);
    settle(s);
    return s;
  };
  const CRYPTO = ['crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit', 'crypto isakmp key Dmvpn!26 address 0.0.0.0',
    'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode transport', 'exit', 'crypto ipsec profile PROT', 'set transform-set TS', 'exit'];
  // GRE over IPsec
  const gi = three();
  cli(gi, 'hub')('configure terminal', ...CRYPTO, 'interface Tunnel1', 'ip address 10.255.1.1 255.255.255.252', 'tunnel source Gi0/0/0', 'tunnel destination 198.51.100.2', 'tunnel protection ipsec profile PROT', 'exit', 'ip route 10.1.1.0 255.255.255.0 Tunnel1', 'end');
  cli(gi, 's1')('configure terminal', ...CRYPTO, 'interface Tunnel1', 'ip address 10.255.1.2 255.255.255.252', 'tunnel source Gi0/0/0', 'tunnel destination 203.0.113.2', 'tunnel protection ipsec profile PROT', 'exit', 'ip route 10.0.1.0 255.255.255.0 Tunnel1', 'end');
  const ri = ping(gi, 'pc1', '10.0.1.10');
  ok(ri.ok && ri.log.some((l) => /GRE 封裝/.test(l.text)) && ri.log.some((l) => /^加密：/.test(l.text)) && tun(gi, 'hub', 1).rt.tun.mtu === 1403, 'GRE over IPsec：先包 GRE、再整個加密成 ESP；Tunnel 的 MTU 扣掉兩層標頭剩 1403');
  const HI = cli(gi, 'hub');
  ok(/Session status: UP-ACTIVE/.test(HI('show crypto session')) && /permit 47 host 203\.0\.113\.2 host 198\.51\.100\.2/.test(HI('show crypto session')) && /in use settings =\{Transport, \}/.test(HI('show crypto ipsec sa')) && /\(203\.0\.113\.2\/255\.255\.255\.255\/47\/0\)/.test(HI('show crypto ipsec sa')), 'show crypto session / ipsec sa：proxy ID 是 GRE（協定 47）、transport mode');
  HI('configure terminal', 'ip access-list extended EDGE', 'permit udp any host 203.0.113.2 eq isakmp', 'permit esp any host 203.0.113.2', 'exit', 'interface Gi0/0/0', 'ip access-group EDGE in', 'end');
  ok(ping(gi, 'pc1', '10.0.1.10').ok, '外部 ACL 只放 UDP 500 和 ESP（不用放 GRE：GRE 包在 ESP 裡面）');
  // VTI
  const gv = three();
  const vti = (id, me, peer, lanNet) => cli(gv, id)('configure terminal', ...CRYPTO, 'interface Tunnel2', `ip address ${me} 255.255.255.252`, 'tunnel source Gi0/0/0', `tunnel destination ${peer}`, 'tunnel mode ipsec ipv4', 'tunnel protection ipsec profile PROT', 'exit', 'router ospf 1', 'network 10.255.2.0 0.0.0.3 area 0', `network ${lanNet} 0.0.0.255 area 0`, 'end');
  vti('hub', '10.255.2.1', '192.0.2.2', '10.0.1.0'); vti('s2', '10.255.2.2', '203.0.113.2', '10.2.1.0');
  const rv = ping(gv, 'pc2', '10.0.1.10');
  ok(rv.ok && rv.log.some((l) => /加密（VTI）/.test(l.text)) && !rv.log.some((l) => /GRE 封裝/.test(l.text)) && tun(gv, 's2', 2).rt.tun.mtu === 1427 && gv.devices.s2.rt.nbrs.some((n) => n.iface === 'Tu2' && n.state === 'full'), 'VTI（tunnel mode ipsec ipv4）：沒有 GRE，直接 ESP；OSPF 在 VTI 上 FULL');
  cli(gv, 's2')('configure terminal', 'crypto ipsec transform-set TS esp-aes esp-sha-hmac', 'end');
  ok(!tun(gv, 's2', 2).rt.link && /第二階段 \(IPsec\) 的加密提案不一致/.test(cli(gv, 's2')('show interfaces tunnel2')), 'transform-set 不一致：IPsec SA 建不起來，VTI 就是 line protocol down（show interfaces 寫出原因）');
  ok(/Keepalive is not supported on IPsec tunnel/.test(cli(gv, 's2')('configure terminal', 'interface Tunnel2', 'keepalive', 'end')), 'VTI 不能設 keepalive');

  // ── DMVPN phase 2
  const dm = (opts = {}) => {
    const s = three();
    cli(s, 'hub')('configure terminal', ...CRYPTO, 'interface Tunnel0', 'ip address 10.0.0.1 255.255.255.0', 'ip nhrp network-id 1', 'ip nhrp authentication NHRP26', ...(opts.noMcast ? [] : ['ip nhrp map multicast dynamic']), ...(opts.p2p ? [] : ['ip ospf network broadcast', 'ip ospf priority 255']),
      'tunnel source Gi0/0/0', 'tunnel mode gre multipoint', 'tunnel key 100', 'tunnel protection ipsec profile PROT', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'network 10.0.1.0 0.0.0.255 area 0', 'end');
    for (const [id, ip, lan] of [['s1', '10.0.0.11', '10.1.1.0'], ['s2', '10.0.0.12', '10.2.1.0']]) {
      cli(s, id)('configure terminal', ...CRYPTO, 'interface Tunnel0', `ip address ${ip} 255.255.255.0`, 'ip nhrp network-id 1', 'ip nhrp authentication NHRP26', 'ip nhrp nhs 10.0.0.1 nbma 203.0.113.2 multicast', ...(opts.p2p ? [] : ['ip ospf network broadcast', 'ip ospf priority 0']),
        'tunnel source Gi0/0/0', 'tunnel mode gre multipoint', 'tunnel key 100', 'tunnel protection ipsec profile PROT', 'exit', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', `network ${lan} 0.0.0.255 area 0`, 'end');
    }
    return s;
  };
  const d2 = dm();
  const S1 = cli(d2, 's1');
  ok(/1 198\.51\.100\.2\s+10\.0\.0\.11\s+UP \S+\s+D/.test(cli(d2, 'hub')('show dmvpn')) && /Type:Hub, NHRP Peers:2/.test(cli(d2, 'hub')('show dmvpn')) && /10\.0\.0\.1\s+RE\s+NBMA Address: 203\.0\.113\.2/.test(S1('show ip nhrp nhs')), 'DMVPN：兩個 spoke 向 hub 註冊（show dmvpn 是 D、show ip nhrp nhs 是 RE）');
  ok(/O\s+10\.2\.1\.0\/24 \[110\/1001\] via 10\.0\.0\.12/.test(S1('show ip route')), 'OSPF broadcast + spoke priority 0（hub 是 DR）：SPOKE1 往 SPOKE2 內網的下一站是 SPOKE2 的 Tunnel 位址（phase 2）');
  const p1 = ping(d2, 'pc1', '10.2.1.10');
  ok(p1.ok && hops(p1) === '10.1.1.1 → 10.0.0.1 → 10.0.0.12' && p1.log.some((l) => /Resolution Request/.test(l.text)), '第一個封包：NHRP 還不知道 SPOKE2 的 NBMA 位址，先經過 hub，同時發出 Resolution Request');
  sim.advance(d2, 1);
  const p2 = ping(d2, 'pc1', '10.2.1.10');
  ok(p2.ok && hops(p2) === '10.1.1.1 → 10.0.0.1 → 10.0.0.12' && p2.log.some((l) => /IPsec 還在協商/.test(l.text)), '一秒後：知道 NBMA 位址了，但 spoke 之間的 IPsec 還在協商，繼續經過 hub');
  settle(d2);
  const p3 = ping(d2, 'pc1', '10.2.1.10');
  ok(p3.ok && hops(p3) === '10.1.1.1 → 10.0.0.12' && /1 192\.0\.2\.2\s+10\.0\.0\.12\s+UP \S+\s+D/.test(S1('show dmvpn')), 'IPsec 建好之後：SPOKE1 直接送到 SPOKE2（spoke 之間的動態通道）');
  ok(/Tunnel0-192\.0\.2\.2/.test(JSON.stringify(d2.devices.s1.rt.tunnels.map((t) => t.name))) && d2.devices.s1.rt.tunnels.every((t) => t.up), 'SPOKE1 有兩組 IPsec SA：往 hub、往 SPOKE2');
  const d3 = dm({ noMcast: true });
  ok(!d3.devices.s1.rt.nbrs.length && /沒有 ip nhrp map multicast dynamic/.test(JSON.stringify(d3.devices.hub.rt.ospf.ifs.Tu0.why)), 'hub 少了 ip nhrp map multicast dynamic：OSPF 的 Hello 只有單向，鄰居建不起來');
  const d4 = dm({ p2p: true });
  ok(/Adjacency forced to reset/.test(JSON.stringify(d4.devices.hub.rt.ospf.ifs.Tu0.why)), 'mGRE 沿用 Tunnel 預設的 point-to-point：hub 一個介面聽到兩個鄰居，鄰居一直被重設');
  const d5 = dm();
  cli(d5, 'hub')('configure terminal', 'interface Tunnel0', 'ip ospf priority 1', 'end');
  cli(d5, 's2')('configure terminal', 'interface Tunnel0', 'ip ospf priority 50', 'end');
  cli(d5, 'hub')('clear ip ospf process', 'yes');
  sim.advance(d5, 60); settle(d5);
  ok(/聽不到 DR（SPOKE2）/.test(JSON.stringify(d5.devices.s1.rt.ospf.ifs.Tu0.why)) || /聽不到 DR（SPOKE2）/.test(JSON.stringify(d5.devices.hub.rt.ospf.ifs.Tu0.why)), 'spoke 搶到 DR：其他 spoke 聽不到 DR，路算不出來');
  // phase 3
  const d6 = three();
  const base = (ip) => ['interface Tunnel0', `ip address ${ip} 255.255.255.0`, 'ip nhrp network-id 1', 'tunnel source Gi0/0/0', 'tunnel mode gre multipoint'];
  cli(d6, 'hub')('configure terminal', ...base('10.0.0.1'), 'ip nhrp map multicast dynamic', 'ip nhrp redirect', 'exit', 'ip route 10.1.1.0 255.255.255.0 10.0.0.11', 'ip route 10.2.1.0 255.255.255.0 10.0.0.12', 'end');
  for (const [id, ip] of [['s1', '10.0.0.11'], ['s2', '10.0.0.12']]) cli(d6, id)('configure terminal', ...base(ip), 'ip nhrp nhs 10.0.0.1 nbma 203.0.113.2 multicast', 'exit', 'ip route 10.0.0.0 255.0.0.0 10.0.0.1', 'end');
  ping(d6, 'pc1', '10.2.1.10'); settle(d6);
  ok(hops(ping(d6, 'pc1', '10.2.1.10')) === '10.1.1.1 → 10.0.0.1 → 10.0.0.12', 'phase 3 少了 spoke 的 ip nhrp shortcut：收到 Redirect 也不建捷徑，一直經過 hub');
  for (const id of ['s1', 's2']) cli(d6, id)('configure terminal', 'interface Tunnel0', 'ip nhrp shortcut', 'end');
  const q1 = ping(d6, 'pc1', '10.2.1.10');
  settle(d6);
  const q2 = ping(d6, 'pc1', '10.2.1.10');
  ok(q1.log.some((l) => /NHRP Redirect/.test(l.text)) && hops(q2) === '10.1.1.1 → 10.0.0.12' && /H\s+10\.2\.1\.0\/24 \[250\/1\] via 10\.0\.0\.12, \S+, Tunnel0/.test(cli(d6, 's1')('show ip route')), 'phase 3：hub 送 Redirect、spoke 解析整個網段，路由表多一筆 H（NHRP），之後直接走');
  // running-config 貼回全新的路由器
  for (const [st, id] of [[d2, 's1'], [d2, 'hub'], [gv, 's2'], [g5, 'r1']]) {
    const txt = runningConfig(st, st.devices[id]);
    const fresh = MS([MD('isr4331', 'x', { name: 'X', pos: [0, 0] })], []); settle(fresh);
    const X = cli(fresh, 'x');
    X('configure terminal', ...txt.filter((l) => l !== '!' && !/^(end|version|Building|Current configuration)/.test(l)), 'end');
    const again = runningConfig(fresh, fresh.devices.x).filter((l) => !/^hostname/.test(l));
    const want = txt.filter((l) => !/^hostname/.test(l));
    const tunnelPart = (ls) => ls.filter((l) => /^(interface Tunnel|crypto|ip route)/.test(l) || /^ (ip nhrp|tunnel|ip ospf|set |mode |keepalive)/.test(l)).join('\n');
    ok(tunnelPart(again) === tunnelPart(want), `${st.devices[id].name} 的 Tunnel / crypto / NHRP 設定貼回全新的路由器，running-config 一模一樣`);
  }

  // ── NAT-T：分公司在大樓的 PAT 後面
  const nt = (opts = {}) => {
    const lines2 = [1, 2].map((n) => ({ id: 'line' + n, label: '線路 ' + n, media: 'rj45' }));
    const inet = MD('internet', 'inet', { name: '網際網路', pos: [0, -9], ports: lines2 });
    SL(inet, 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' });
    SL(inet, 'line2', { type: 'static', gw: '198.51.100.1', mask: '255.255.255.252', assign: '198.51.100.2' });
    const s = MS([inet, MD('isr4331', 'hq', { name: 'HQ', pos: [-6, -4] }), MD('isr4331', 'cpe', { name: 'BLDG', pos: [6, -4] }), MD('isr4331', 'br', { name: 'BR', pos: [6, 0] }),
      MD('pc', 'pch', { name: 'PC-H', pos: [-6, 4], ip: '10.1.0.10', gw: '10.1.0.1' }), MD('pc', 'pcb', { name: 'PC-B', pos: [6, 5], ip: '10.2.0.10', gw: '10.2.0.1' })],
    [['inet:line1', 'hq:Gi0/0/0'], ['inet:line2', 'cpe:Gi0/0/0'], ['cpe:Gi0/0/1', 'br:Gi0/0/0'], ['pch:eth0', 'hq:Gi0/0/1'], ['pcb:eth0', 'br:Gi0/0/1']]);
    const vpn = (lan, peerLan, peer) => ['crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit', `crypto isakmp key NatT!2026 address ${peer}`,
      'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'exit', 'ip access-list extended VPN', `permit ip ${lan} 0.0.0.255 ${peerLan} 0.0.0.255`, 'exit', 'crypto map CM 10 ipsec-isakmp', `set peer ${peer}`, 'set transform-set TS', 'match address VPN', 'exit', 'interface Gi0/0/0', 'crypto map CM', 'exit'];
    const S = (id, lines) => { const x = iosSession(() => s.devices[id], () => s); for (const l of lines) x.exec(l); };
    S('hq', ['configure terminal', 'interface Gi0/0/0', 'ip address 203.0.113.2 255.255.255.252', 'interface Gi0/0/1', 'ip address 10.1.0.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', ...vpn('10.1.0.0', '10.2.0.0', '198.51.100.2'),
      ...(opts.acl ? ['ip access-list extended EDGE', 'permit udp any host 203.0.113.2 eq isakmp', 'permit esp any host 203.0.113.2', 'exit', 'interface Gi0/0/0', 'ip access-group EDGE in', 'exit'] : []), 'end']);
    S('cpe', ['configure terminal', 'interface Gi0/0/0', 'ip address 198.51.100.2 255.255.255.252', 'ip nat outside', 'interface Gi0/0/1', 'ip address 192.168.10.1 255.255.255.0', 'ip nat inside', 'exit', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1', 'access-list 1 permit 192.168.10.0 0.0.0.255', 'ip nat inside source list 1 interface Gi0/0/0 overload', 'end']);
    S('br', ['configure terminal', 'interface Gi0/0/0', 'ip address 192.168.10.2 255.255.255.0', 'interface Gi0/0/1', 'ip address 10.2.0.1 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 192.168.10.1', ...vpn('10.2.0.0', '10.1.0.0', '203.0.113.2'), ...(opts.noNatT ? ['no crypto ipsec nat-transparency udp-encapsulation'] : []), 'end']);
    settle(s);
    return s;
  };
  const n1 = nt();
  const nb = ping(n1, 'pcb', '10.1.0.10'), nh = ping(n1, 'pch', '10.2.0.10');
  ok(nb.ok && nh.ok && n1.devices.br.rt.tunnels[0].natT && nb.log.some((l) => /NAT-T/.test(l.text)) && nh.log.some((l) => /NAT 還原（NAT-T）/.test(l.text)), 'NAT-T：BR 在 PAT 後面，ESP 包進 UDP 4500；分公司、總公司兩邊主動連線都通');
  ok(/Peer: 198\.51\.100\.2 port 4500/.test(cli(n1, 'hq')('show crypto session')) && /in use settings =\{Tunnel UDP-Encaps, \}/.test(cli(n1, 'br')('show crypto ipsec sa')), 'show crypto session 的 port 4500、show crypto ipsec sa 的 Tunnel UDP-Encaps');
  const n2 = nt({ noNatT: true });
  const nx = ping(n2, 'pcb', '10.1.0.10');
  ok(n2.devices.br.rt.tunnels[0].up && !nx.ok && /PAT 沒辦法替它轉換/.test(nx.reason), '關掉 NAT-T：IKE 還是建得起來，ESP 卻被 PAT 丟掉（沒有連接埠號碼）');
  const n3 = nt({ acl: true });
  ok(!n3.devices.br.rt.tunnels[0].up && /UDP 4500 過不去/.test(n3.devices.br.rt.tunnels[0].why), '總公司的 ACL 只放 UDP 500 與 ESP：偵測到 NAT 改用 UDP 4500 之後就被擋掉');
  ok(/permit esp any host 203\.0\.113\.2/.test(runningConfig(n3, n3.devices.hq).join('\n')), 'ACL 可以寫 esp（IP 協定 50）、gre（47）');
}

console.log('\nIPv6 補齊：AAAA 與雙協定、IPv6 經過 IPv4 的 Tunnel（GRE、6in4）');
{
  const sim = await import('../src/engine/sim.js');
  const s6 = await import('../src/engine/sim6.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { parseIp6, fmtIp6 } = await import('../src/engine/ip6.js');
  const { cacheRows } = await import('../src/engine/dns.js');
  const { makeDevice: MD, makeState: MS } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const lv = (id) => { const l = LEVELS.find((x) => x.id === id); const s = l.setup(); settle(s); return { s, l }; };

  // ── AAAA 與雙協定（9-7）
  const { s: a, l: l93 } = lv('l93');
  const q6 = sim.resolveName(a, 'pca', 'www.corp.local', 0, { type: 'AAAA', nocache: true });
  ok(q6.ok && fmtIp6(q6.ip6) === '2001:db8:20::100', `AAAA 查得到：${q6.ok ? fmtIp6(q6.ip6) : q6.reason}`);
  const p1 = sim.dualStack(a, 'pca', 'www.corp.local', { proto: 'icmp' });
  ok(!p1.ok && p1.family === 6 && /NDP/.test(p1.reason), '有全域 IPv6 的電腦用名稱 ping：優先用 AAAA，位址寫錯就逾時（不會改用 IPv4）');
  const p4 = sim.dualStack(a, 'pca', 'www.corp.local', { proto: 'icmp', family: 4 });
  ok(p4.ok && p4.family === 4, 'ping -4：用 A 記錄，會通');
  const h = sim.dualStack(a, 'pca', 'www.corp.local', { proto: 'tcp', dport: 443, happy: true });
  ok(h.ok && h.family === 4 && h.fallback && h.log.some((x) => /Happy Eyeballs/.test(x.text)), '瀏覽器 (Happy Eyeballs)：IPv6 沒有回應，改用 IPv4 連上（會通，但慢一點）');
  const o = sim.dualStack(a, 'old', 'www.corp.local', { proto: 'tcp', dport: 443, happy: true });
  ok(o.ok && o.family === 4 && !o.fallback && /沒有全域的 IPv6/.test(o.why), '只有 IPv4 的電腦根本不問 AAAA：直接用 IPv4');
  sim.resolveName(a, 'pca', 'www.corp.local', 0, { type: 'AAAA' });
  ok(cacheRows(a, a.devices.pca).some((r) => r.ip6 != null && fmtIp6(r.ip6) === '2001:db8:20::100'), 'AAAA 也會記進 DNS 快取（ipconfig /displaydns 的記錄類型 28）');
  const nodata = sim.resolveName(a, 'pca', 'ns.corp.local', 0, { type: 'AAAA', nocache: true });
  ok(!nodata.ok, '沒有 AAAA 的名稱：查不到 IPv6 位址');
  l93.solve(a); settle(a);
  const p6 = sim.dualStack(a, 'pca', 'www.corp.local', { proto: 'icmp' });
  ok(p6.ok && p6.family === 6, '修好 AAAA、伺服器補上 IPv6 閘道：ping www.corp.local 走 IPv6');

  // ── IPv6 經過 VTI 過不去、改成 GRE 就通（9-8）
  const { s: b, l: l94 } = lv('l94');
  ok(!(b.devices.hq.rt.nbrs6 || []).length && b.devices.hq.rt.nbrs.some((n) => n.iface === 'Tu0' && n.state === 'full'), 'tunnel mode ipsec ipv4：OSPFv2 在 Tunnel 上 FULL，OSPFv3 沒有鄰居（VTI 只載 IPv4）');
  const v6fail = s6.transact6(b, 'br', parseIp6('2001:db8:1::10'));
  ok(!v6fail.ok, `IPv6 過不了 VTI：${v6fail.reason}`);
  l94.solve(b); settle(b);
  const r6 = s6.transact6(b, 'bpc', parseIp6('2001:db8:1::10'), { proto: 'tcp', dport: 443 });
  ok(r6.ok && r6.log.some((x) => /GRE 封裝：IPv6/.test(x.text)) && r6.hops.some((x) => x.proto === 'esp'), 'tunnel mode gre ip + tunnel protection：IPv6 包進 GRE、再加密成 ESP，分公司連得到總公司');
  ok((b.devices.hq.rt.nbrs6 || []).some((n) => n.state === 'full') && b.devices.br.rt.routes6.some((x) => x.type === 'O' && x.iface && x.iface.id === 'Tu0'), 'OSPFv3 在 GRE 上 FULL，分公司從 Tunnel0 學到總公司的 IPv6 前綴');

  // ── 6in4（tunnel mode ipv6ip）
  const c = MS([
    MD('isr4331', 'r1', { name: 'R1', pos: [-6, 0] }), MD('isr4331', 'isp', { name: 'ISP', pos: [0, -4] }), MD('isr4331', 'r2', { name: 'R2', pos: [6, 0] }),
  ], [['r1:Gi0/0/0', 'isp:Gi0/0/0'], ['r2:Gi0/0/0', 'isp:Gi0/0/1']]);
  c.v6 = true;
  settle(c);
  cli(c, 'isp')('configure terminal', 'interface Gi0/0/0', 'ip address 203.0.113.2 255.255.255.252', 'interface Gi0/0/1', 'ip address 198.51.100.2 255.255.255.252', 'end');
  const side = (id, wan, gw, lo, tun, dst) => cli(c, id)('configure terminal', 'ipv6 unicast-routing', 'interface Gi0/0/0', `ip address ${wan} 255.255.255.252`, 'exit', `ip route 0.0.0.0 0.0.0.0 ${gw}`,
    'interface Loopback0', `ipv6 address ${lo}`, 'ipv6 ospf 1 area 0', 'interface Tunnel0', `ipv6 address ${tun}`, 'ipv6 ospf 1 area 0', 'tunnel source Gi0/0/0', `tunnel destination ${dst}`, 'tunnel mode ipv6ip', 'end');
  side('r1', '203.0.113.1', '203.0.113.2', '2001:db8:a::1/128', '2001:db8:ff::1/64', '198.51.100.1');
  side('r2', '198.51.100.1', '198.51.100.2', '2001:db8:b::1/128', '2001:db8:ff::2/64', '203.0.113.1');
  sim.advance(c, 60); settle(c);
  const t6 = s6.transact6(c, 'r1', parseIp6('2001:db8:b::1'));
  ok(t6.ok && t6.log.some((x) => /6in4 封裝/.test(x.text) && /協定 41/.test(x.text)), '6in4（tunnel mode ipv6ip）：IPv6 包進 IPv4（協定 41），經過只有 IPv4 的 ISP；OSPFv3 學到對面的 Loopback');
  ok(c.devices.r1.ifaces.find((i) => i.id === 'Tu0').rt.tun.mtu === 1480 && /Tunnel protocol\/transport IPv6\/IP/.test(cli(c, 'r1')('show interfaces tunnel 0')), '6in4 的外層只多 20 位元組：Tunnel 的 MTU 1480；show interfaces 是 IPv6/IP');
  ok(/ tunnel mode ipv6ip/.test(runningConfig(c, c.devices.r1).join('\n')), 'running-config：tunnel mode ipv6ip');
}

console.log('\n高可用：BFD、GLBP');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { cloneState: CS } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const lv = (id) => { const l = LEVELS.find((x) => x.id === id); const s = l.setup(); settle(s); return { s, l }; };
  const ipOf = (s, id) => s.devices[id].ifaces[0].rt.ip;

  // ── BFD（8-8）
  const { s: b, l: l95 } = lv('l95');
  const cutAt = (s0, secs) => {
    const t = CS(s0); settle(t);
    const c = t.cables.find((x) => (x.a.dev === 'carrier' && x.b.dev === 'br') || (x.b.dev === 'carrier' && x.a.dev === 'br'));
    t.cut = { [c.id]: true }; sim.recompute(t); sim.advance(t, secs);
    return { t, r: sim.transact(t, 'bpc', { proto: 'udp', dst: ipOf(t, 'pbx'), dport: 5060, quiet: true }) };
  };
  ok(!cutAt(b, 2).r.ok && cutAt(b, 41).r.ok, '沒有 BFD：業者那一端斷掉，HQ-RT 的介面還是 up，要等 Dead timer（40 秒）才切到備援');
  l95.solve(b); settle(b);
  const x = cutAt(b, 2);
  ok(x.r.ok && x.r.hops.some((h) => h.proto === 'gre'), 'bfd interval 300 min_rx 300 multiplier 3 + bfd all-interfaces：兩秒內改走 GRE 備援');
  const H = cli(b, 'hq');
  ok(/10\.255\.9\.2\s+1\/1\s+Up\s+Up\s+GigabitEthernet0\/0\/2/.test(H('show bfd neighbors')) && /Registered protocols: OSPF/.test(H('show bfd neighbors details')), 'show bfd neighbors：Up，客戶是 OSPF');
  ok(/ bfd interval 300 min_rx 300 multiplier 3/.test(runningConfig(b, b.devices.hq).join('\n')) && /router ospf 1[\s\S]* bfd all-interfaces/.test(runningConfig(b, b.devices.hq).join('\n')), 'running-config：介面的 bfd interval、router ospf 的 bfd all-interfaces');
  const b2 = lv('l95').s;
  cli(b2, 'hq')('configure terminal', 'interface Gi0/0/2', 'bfd interval 300 min_rx 300 multiplier 3', 'exit', 'router ospf 1', 'bfd all-interfaces', 'end');
  ok(!cutAt(b2, 2).r.ok && /Down/.test(cli(b2, 'hq')('show bfd neighbors')), '只有一端設 BFD：session 起不來，照樣等 Dead timer');
  const b3 = lv('l95').s;
  for (const id of ['hq', 'br']) cli(b3, id)('configure terminal', 'interface Gi0/0/2', 'ip ospf dead-interval minimal hello-multiplier 4', 'end');
  ok(cutAt(b3, 2).r.ok, 'OSPF fast hello（dead-interval minimal hello-multiplier 4）：Dead timer 1 秒，一樣兩秒內切換');
}

console.log('\nGLBP：AVG、AVF、虛擬 MAC 與接手');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { cloneState: CS } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const l96 = LEVELS.find((x) => x.id === 'l96');
  const s = l96.setup(); settle(s);
  const srv = s.devices.srv.ifaces[0].rt.ip;
  const go = (st, pc, quiet = true) => sim.transact(st, pc, { proto: 'tcp', dst: srv, dport: 443, quiet });
  const via = (r) => (r.l3.find((h) => h.dev === 'r1' || h.dev === 'r2') || {}).dev;
  go(s, 'pc1', false);
  ok(s.dyn.arp.pc1[parseIp('10.10.0.1')].mac === '00:00:0c:07:ac:01' && /Active\s+local\s+10\.10\.0\.3\s+10\.10\.0\.1/.test(cli(s, 'r1')('show standby brief')), 'HSRP：閘道的 MAC 是 HSRP 的虛擬 MAC 0000.0c07.ac01，只有 Active（R1）在轉送');
  l96.solve(s); settle(s);
  const v = ['pc1', 'pc2', 'pc3', 'pc4'].map((pc) => via(go(s, pc, false)));
  ok(v.includes('r1') && v.includes('r2'), `GLBP round-robin：四台電腦分到兩台 AVF（${v.join('、')}）`);
  const macs = ['pc1', 'pc2'].map((pc) => s.dyn.arp[pc][parseIp('10.10.0.1')].mac);
  ok(macs[0] !== macs[1] && macs.every((m) => /^00:07:b4:00:01:0[12]$/.test(m)), `每台電腦的閘道 MAC 是不同 AVF 的虛擬 MAC（${macs.join('、')}）`);
  const G = cli(s, 'r1')('show glbp brief');
  ok(/Gi0\/0\/1\s+1\s+-\s+110\s+Active\s+10\.10\.0\.1/.test(G) && /1\s+1\s+-\s+Active\s+0007\.b400\.0101/.test(G) && /1\s+2\s+-\s+Listen\s+0007\.b400\.0102\s+10\.10\.0\.3/.test(G), 'show glbp brief：R1 是 AVG，Fwd 1 是自己、Fwd 2 是 R2');
  // R2 斷電：它負責的虛擬 MAC 等 holdtime（10 秒）之後由 R1 接手
  const pcOnR2 = ['pc1', 'pc2', 'pc3', 'pc4'].find((pc, k) => v[k] === 'r2');
  const t = CS(s); settle(t);
  t.down = { r2: true }; sim.recompute(t);
  const r0 = go(t, pcOnR2);
  sim.advance(t, 11);
  const r1 = go(t, pcOnR2);
  ok(!r0.ok && /其他 AVF 還要/.test(r0.reason) && r1.ok && via(r1) === 'r1', 'AVF（R2）斷電：它的虛擬 MAC 在 holdtime 內沒人轉送，10 秒後 R1 接手，電腦的 ARP 不用改');
  ok(/ glbp 1 ip 10\.10\.0\.1\n glbp 1 priority 110\n glbp 1 preempt/.test(runningConfig(s, s.devices.r1).join('\n')), 'running-config：glbp 1 ip、priority、preempt');
  const lb = cli(s, 'r1')('configure terminal', 'interface Gi0/0/1', 'glbp 1 load-balancing host-dependent', 'end');
  ok(!/%/.test(lb) && / glbp 1 load-balancing host-dependent/.test(runningConfig(s, s.devices.r1).join('\n')), 'glbp 1 load-balancing host-dependent');
}

console.log('\ndebug ip ospf 與 debug crypto');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { logRows } = await import('../src/engine/ops.js');
  const { makeState, makeDevice } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const logs = (s, id, from = 0) => logRows(s, s.devices[id]).filter((r) => r.n > from).map((r) => r.line).join('\n');
  const last = (s, id) => { const r = logRows(s, s.devices[id]); return r.length ? r[r.length - 1].n : 0; };
  const two = () => {
    const s = makeState([makeDevice('isr4331', 'r1', { name: 'R1' }), makeDevice('isr4331', 'r2', { name: 'R2' })], [['r1:Gi0/0/0', 'r2:Gi0/0/0']]);
    settle(s);
    for (const n of [1, 2]) cli(s, 'r' + n)('configure terminal', 'interface lo0', `ip address ${n}.${n}.${n}.${n} 255.255.255.255`, 'interface gi0/0/0', `ip address 10.0.0.${n} 255.255.255.0`, 'no shutdown',
      'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end');
    settle(s);
    return s;
  };
  const s = two(), R1 = cli(s, 'r1'), R2 = cli(s, 'r2');
  ok(/OSPF hello debugging is on/.test(R1('debug ip ospf hello')) && /OSPF adjacency debugging is on/.test(R1('debug ip ospf adj')) && /OSPF:\n  OSPF adjacency debugging is on\n  OSPF hello debugging is on/.test(R1('show debugging')),
    'debug ip ospf hello / adj：show debugging 列在 OSPF 底下');
  sim.advance(s, 20);
  ok(!/OSPF-1/.test(logs(s, 'r1')), '鄰居是 FULL：debug 不會一直印');
  let n0 = last(s, 'r1');
  R2('configure terminal', 'interface gi0/0/0', 'ip ospf hello-interval 5', 'end');
  sim.advance(s, 10);
  ok(/OSPF-1 HELLO Gi0\/0\/0: Rcv hello from 2\.2\.2\.2 area 0 10\.0\.0\.2/.test(logs(s, 'r1', n0)) && /Mismatched hello parameters from 10\.0\.0\.2/.test(logs(s, 'r1', n0)) && /Dead R 20 C 40, Hello R 5 C 10 Mask R 255\.255\.255\.0 C 255\.255\.255\.0/.test(logs(s, 'r1', n0)),
    'Hello 計時器不一致：Mismatched hello parameters，Dead R 20 C 40, Hello R 5 C 10');
  R2('configure terminal', 'interface gi0/0/0', 'no ip ospf hello-interval', 'router ospf 1', 'no network 10.0.0.0 0.0.0.255 area 0', 'network 10.0.0.0 0.0.0.255 area 1', 'end');
  n0 = last(s, 'r1'); sim.advance(s, 10);
  ok(/OSPF-1 ADJ   Gi0\/0\/0: Rcv pkt from 10\.0\.0\.2, area 0\.0\.0\.0, mismatched area 0\.0\.0\.1 in the header/.test(logs(s, 'r1', n0)), '區域不一致：mismatched area 0.0.0.1 in the header');
  R2('configure terminal', 'router ospf 1', 'no network 10.0.0.0 0.0.0.255 area 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit', 'interface gi0/0/0', 'ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 K3y!', 'end');
  n0 = last(s, 'r1'); sim.advance(s, 10);
  ok(/Rcv pkt from 10\.0\.0\.2 : Mismatched Authentication type\. Input packet specified type 2, we use type 0/.test(logs(s, 'r1', n0)), '驗證方式不一致：Input packet specified type 2, we use type 0');
  R1('configure terminal', 'interface gi0/0/0', 'ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 Other', 'end');
  n0 = last(s, 'r1'); sim.advance(s, 10);
  ok(/Mismatched Authentication Key - Message Digest Key 1/.test(logs(s, 'r1', n0)), '金鑰不一致：Mismatched Authentication Key - Message Digest Key 1');
  R1('configure terminal', 'interface gi0/0/0', 'no ip ospf authentication', 'no ip ospf message-digest-key 1', 'end');
  R2('configure terminal', 'interface gi0/0/0', 'no ip ospf authentication', 'no ip ospf message-digest-key 1', 'ip mtu 1400', 'end');
  settle(s);
  R2('debug ip ospf adj');
  const n2 = last(s, 'r2'); n0 = last(s, 'r1'); sim.advance(s, 6); sim.advance(s, 6);
  ok(/Rcv DBD from 1\.1\.1\.1 seq 0x[0-9A-F]+ opt 0x52 flag 0x7 len 32  mtu 1500 state EXSTART/.test(logs(s, 'r2', n2)) && /Nbr 1\.1\.1\.1 has larger interface MTU/.test(logs(s, 'r2', n2)) && /Retransmitting DBD to 1\.1\.1\.1 \[2\]/.test(logs(s, 'r2', n2)) && !/larger interface MTU/.test(logs(s, 'r1', n0)),
    'MTU 不一致：MTU 小的一端說 Nbr has larger interface MTU，DBD 一直重送');
  ok(/All possible debugging has been turned off/.test(R1('undebug all')) && /沒有開啟任何 debug/.test(R1('show debugging')), 'undebug all：全部關掉');
  n0 = last(s, 'r1'); sim.advance(s, 20);
  ok(!/OSPF-1/.test(logs(s, 'r1', n0)), '關掉之後就不再印了');
  // Router ID 重複：不用 debug 也會記一筆
  R2('configure terminal', 'interface gi0/0/0', 'no ip mtu', 'router ospf 1', 'router-id 1.1.1.1', 'end', 'clear ip ospf process', 'yes');
  sim.advance(s, 5);
  ok(/%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id 1\.1\.1\.1 from 10\.0\.0\.2 on interface GigabitEthernet0\/0\/0/.test(logs(s, 'r1')), 'Router ID 重複：%OSPF-4-DUP_RTRID_NBR（不用開 debug）');

  // IKE：GRE over IPsec，兩端的金鑰不同
  const g = makeState([makeDevice('isr4331', 'r1', { name: 'R1' }), makeDevice('isr4331', 'r2', { name: 'R2' })], [['r1:Gi0/0/0', 'r2:Gi0/0/0']]);
  settle(g);
  const crypto = (key) => ['crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit', `crypto isakmp key ${key} address 0.0.0.0`,
    'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac', 'mode transport', 'exit', 'crypto ipsec profile PROT', 'set transform-set TS', 'exit'];
  for (const n of [1, 2]) cli(g, 'r' + n)('configure terminal', ...crypto(n === 1 ? 'Same!26' : 'Diff!26'), 'interface gi0/0/0', `ip address 10.0.0.${n} 255.255.255.252`, 'no shutdown', 'exit',
    'interface Tunnel0', `ip address 10.255.0.${n} 255.255.255.252`, 'tunnel source Gi0/0/0', `tunnel destination 10.0.0.${3 - n}`, 'tunnel protection ipsec profile PROT', 'end');
  settle(g);
  const G1 = cli(g, 'r1');
  ok(/Crypto ISAKMP debugging is on/.test(G1('debug crypto isakmp')) && /Crypto IPSEC debugging is on/.test(G1('debug crypto ipsec')) && /Cryptographic Subsystem:\n  Crypto ISAKMP debugging is on\n  Crypto IPSEC debugging is on/.test(G1('show debugging')), 'debug crypto isakmp / ipsec');
  n0 = last(g, 'r1'); sim.advance(g, 10);
  ok(/%CRYPTO-4-IKMP_BAD_MESSAGE: IKE message from 10\.0\.0\.2 failed its sanity check or is malformed/.test(logs(g, 'r1', n0)) && /retransmitting phase 1 MM_KEY_EXCH/.test(logs(g, 'r1', n0)), 'PSK 不一致：IKMP_BAD_MESSAGE、MM_KEY_EXCH 一直重送');
  cli(g, 'r2')('configure terminal', 'no crypto isakmp key Diff!26 address 0.0.0.0', 'end');
  n0 = last(g, 'r1'); sim.advance(g, 10);
  const lr2 = cli(g, 'r2'); lr2('debug crypto isakmp'); sim.advance(g, 10);
  ok(/ISAKMP:\(0\):No pre-shared key with 10\.0\.0\.1!/.test(logs(g, 'r2')), '對端沒有金鑰：No pre-shared key with 10.0.0.1!');
  cli(g, 'r2')('configure terminal', 'crypto isakmp key Same!26 address 0.0.0.0', 'crypto ipsec transform-set TS esp-aes esp-sha-hmac', 'mode transport', 'end');
  n0 = last(g, 'r1'); sim.advance(g, 10);
  ok(/IPSec policy invalidated proposal with error 256/.test(logs(g, 'r1', n0)) && /IPSEC\(ipsec_process_proposal\): transform proposal not supported/.test(logs(g, 'r1', n0)), '第二階段提案不一致：IPSec policy invalidated proposal with error 256');

  // DHCP 伺服器
  const h = makeState([makeDevice('isr4331', 'r1', { name: 'R1' }), makeDevice('pc', 'pc1', { name: 'PC1' })], [['r1:Gi0/0/1', 'pc1:eth0']]);
  h.devices.pc1.ifaces[0].mode = 'dhcp';
  settle(h);
  const H = cli(h, 'r1');
  ok(/DHCP server:\n  DHCP server packet debugging is on\n  DHCP server event debugging is on/.test(H('debug ip dhcp server packet', 'debug ip dhcp server events', 'show debugging')), 'debug ip dhcp server packet / events');
  H('configure terminal', 'interface Gi0/0/1', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'end');
  sim.advance(h, 5);
  const dl = logs(h, 'r1');
  ok(/DHCPD: DHCPDISCOVER received from client 01[0-9a-f]{2}\.[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{2} on interface GigabitEthernet0\/0\/1\./.test(dl) && /DHCPD: assigned IP address 192\.168\.1\.2 to client/.test(dl) && /Sending DHCPOFFER[\s\S]*DHCPREQUEST received[\s\S]*Sending DHCPACK to client \S+ \(192\.168\.1\.2\)/.test(dl),
    'PC 要到位址：DISCOVER、assigned、OFFER、REQUEST、ACK');
  n0 = last(h, 'r1'); sim.advance(h, 43300);
  ok(/DHCPREQUEST received/.test(logs(h, 'r1', n0)) && /unicasting BOOTREPLY/.test(logs(h, 'r1', n0)) && !/DHCPDISCOVER/.test(logs(h, 'r1', n0)), '租約過了一半：只有 REQUEST / ACK（unicast），沒有 DISCOVER');
}

console.log('\nPoE 預算與 CDP / LLDP 的電力協商');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { logRows } = await import('../src/engine/ops.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const lv = LEVELS.find((x) => x.id === 'l98');
  const s = lv.setup(); settle(s); sim.advance(s, 60); settle(s);
  const P = (p) => s.rt.poe['sw:' + p];
  const SW = cli(s, 'sw');
  ok(P('Gi0/1').alloc === 30 && P('Gi0/5').state === 'denied' && s.rt.off.ap5 && /Available:124\.0\(w\)  Used:120\.0\(w\)  Remaining:4\.0\(w\)/.test(SW('show power inline')) && /Gi0\/5\s+auto\s+faulty/.test(SW('show power inline')),
    'no cdp run：四台 AP 依 Class 4 各保留 30 W，用掉 120 W，第五台被拒絕供電 (faulty)');
  ok(lv.objectives[0].test(s) !== true && lv.objectives[2].test(s) === true, '一開始：新的 AP 沒電；使用者的埠沒有 CDP（整台都關了）');
  SW('configure terminal', 'cdp run', 'end');
  sim.advance(s, 60); settle(s);
  ok(P('Gi0/1').alloc === 20.9 && P('Gi0/1').cdp && P('Gi0/5').state === 'on' && /Used:104\.5\(w\)/.test(SW('show power inline')), `cdp run：AP 用 CDP 協商出實際的 20.9 W，五台一共 104.5 W，新的 AP 分得到電（${P('Gi0/5').state}）`);
  ok(/%ILPOWER-5-POWER_GRANTED: Interface Gi0\/5: Power granted/.test(logRows(s, s.devices.sw).map((r) => r.line).join('\n')), 'log：ILPOWER-7-DETECT、POWER_GRANTED');
  ok(/AP-3F-1\s+Gig 0\/1\s+\d+\s+T B I\s+C9120AXI/.test(SW('show cdp neighbors')), 'show cdp neighbors 看得到 Cisco 的 AP（Trans-Bridge、C9120AXI-B）');
  ok(lv.objectives[2].test(s) !== true && /Gi0\/6 會送出 CDP/.test(lv.objectives[2].test(s)), '稽核：使用者的埠又送出 CDP 了');
  SW('configure terminal', 'interface range gi0/6 - 8', 'no cdp enable', 'end');
  sim.advance(s, 60); settle(s);
  ok(lv.objectives.every((o) => o.test(s) === true), '使用者的埠 no cdp enable：三個目標都通過');
  // 改用 LLDP 也可以：AP 用 LLDP 的 Power via MDI 協商
  const s2 = lv.setup(); settle(s2);
  const L = cli(s2, 'sw');
  L('configure terminal', 'lldp run', 'interface range gi0/6 - 8', 'no lldp transmit', 'end');
  sim.advance(s2, 60); settle(s2);
  const e = s2.rt.poe['sw:Gi0/5'];
  ok(e.state === 'on' && e.lldp && s2.rt.poe['sw:Gi0/2'].alloc === 20.9 && lv.objectives.every((o) => o.test(s2) === true), '改用 lldp run（使用者的埠 no lldp transmit）：AP 用 LLDP 協商，一樣分得到電');
  ok(runningConfig(s2, s2.devices.sw).join('\n').includes('no cdp run') && / no lldp transmit/.test(runningConfig(s2, s2.devices.sw).join('\n')), 'running-config：no cdp run、lldp run、no lldp transmit');
}

console.log('\nNTP、時區與 service timestamps');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const ops0 = await import('../src/engine/ops.js');
  const { iosStamp, syslogRows, uptimeStamp } = ops0;
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const lv = LEVELS.find((x) => x.id === 'l99');
  const s = lv.setup(); settle(s);
  const row = (id) => syslogRows(s, s.devices.log).filter((r) => r.dev === id).pop();
  ok(/^\*/.test(iosStamp(s, s.devices.hq)) && /^\*Mar  \d /.test(iosStamp(s, s.devices.sw)) && /1993$/.test(ops0.iosClock(s, s.devices.sw)) && /^Jan  5 01:/.test(iosStamp(s, s.devices.br)),
    `一開始：HQ-RT 不可信 (*)、HQ-SW 停在 3 月 1 日、BR-RT 有對時但紀錄用 UTC（${iosStamp(s, s.devices.br)}）`);
  ok(lv.objectives.map((o) => o.test(s) === true).join() === 'false,false,false', '三個目標一開始都沒過');
  const B = cli(s, 'br');
  B('configure terminal', 'service timestamps log datetime msec localtime show-timezone', 'end');
  ok(/^Jan  5 09:\d\d:\d\d\.\d{3} TST$/.test(iosStamp(s, s.devices.br)) && /service timestamps log datetime msec localtime show-timezone/.test(runningConfig(s, s.devices.br).join('\n')), `localtime show-timezone：${iosStamp(s, s.devices.br)}`);
  B('configure terminal', 'service timestamps log datetime year', 'end');
  ok(/^Jan  5 2026 01:\d\d:\d\d$/.test(iosStamp(s, s.devices.br)), `datetime year（沒有 msec、沒有 localtime）：${iosStamp(s, s.devices.br)}`);
  B('configure terminal', 'service timestamps log uptime', 'end');
  ok(/^\d\dw\d+d$|^\d+w\d+d$|^\d+d\d\dh$|^\d\d:\d\d:\d\d$/.test(iosStamp(s, s.devices.br)) && uptimeStamp(45296) === '12:34:56' && uptimeStamp(93600) === '1d02h' && uptimeStamp(9 * 86400) === '1w2d', `uptime：${iosStamp(s, s.devices.br)}`);
  B('configure terminal', 'no service timestamps log', 'end');
  ok(iosStamp(s, s.devices.br) === '' && /no service timestamps log/.test(runningConfig(s, s.devices.br).join('\n')), 'no service timestamps log：紀錄沒有時間');
  ok(/% Invalid input/.test(B('configure terminal', 'service timestamps log datetime msc2', 'end')), '不認識的選項：IOS 拒絕');
  lv.solve(s); settle(s);
  ok(lv.objectives.every((o) => o.test(s) === true), '解法：三個目標都通過（NTP 要幾分鐘才同步，目標在複本上讓時間往前走）');
  for (let n = 0; n < 6; n++) { sim.advance(s, 64); settle(s, 30); }
  cli(s, 'sw')('configure terminal', 'interface Gi0/5', 'shutdown', 'end');
  sim.advance(s, 2);
  const r = row('sw');
  ok(r && /^<\d+>\d+: Jan  5 09:\d\d:\d\d\.\d{3} TST: %/.test(r.line), `HQ-SW 的紀錄送到 Syslog 伺服器，是台灣時間、記到毫秒：${r && r.line.slice(0, 60)}`);
  ok(/Clock is synchronized, stratum 3, reference is 10\.10\.0\.5/.test(cli(s, 'sw')('show ntp status')), 'show ntp status：synchronized，stratum 3');
}

console.log('\n雙 WAN 的 QoS');
{
  const { iosSession } = await import('../src/engine/ios.js');
  const { runObjective } = await import('../src/engine/sim/objectives.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l100');
  const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); settle(s); };
  const res = (s) => lv.objectives.map((o) => { const r = o.type === 'check' ? o.test(s) : runObjective(s, o); return r === true || r.pass ? true : (r.reason || r); });
  const s = lv.setup(); settle(s);
  let r = res(s);
  ok(r[0] === true && /營運商的合約頻寬 10 Mbps/.test(r[1]) && /沒有整形/.test(r[2]) && r[3] === true, '平常走主線沒問題；故障演練切到備援線路，超過 10 Mbps 的語音被營運商丟掉');
  typeIn(s, 'brt', ['configure terminal', 'interface Gi0/0/2', 'service-policy output WAN-OUT', 'end']);
  r = res(s);
  ok(r[1] !== true && /超過備援線路的合約 10 Mbps/.test(r[2]), '照搬主線的 WAN-OUT（shape 50 Mbps）到備援線路：還是超過合約');
  typeIn(s, 'brt', ['configure terminal', 'policy-map WAN-BACKUP', 'class class-default', 'shape average 10000000', 'service-policy VOICE-PRI', 'exit', 'exit', 'interface Gi0/0/2', 'service-policy output WAN-BACKUP', 'end']);
  r = res(s);
  ok(r.every((x) => x === true), '備援線路依自己的合約 shape 10 Mbps、共用 VOICE-PRI：切過去之後通話一樣清楚，備份照樣在跑');
  // 關卡劇本：三分鐘後主線被挖斷，十分鐘後修好
  const { takeScriptNews, nextScript } = await import('../src/engine/script.js');
  const sim = await import('../src/engine/sim.js');
  const g = lv.setup(); lv.solve(g); settle(g);
  const pc = () => g.cables.find((c) => [c.a, c.b].some((e) => e.dev === 'brt' && e.port === 'Gi0/0/0'));
  ok(nextScript(g).at === 180 && g.rt.cable[pc().id] === 'up' && !takeScriptNews(g).length, '一開始主線正常，下一個劇本事件在 180 秒');
  sim.advance(g, 200); settle(g);
  const news = takeScriptNews(g);
  const dft = g.devices.brt.rt.routes.find((x) => x.net === 0 && x.bits === 0 && !x.bad);
  ok(g.rt.cable[pc().id] === 'down' && /道路施工/.test(g.rt.why[pc().id]) && news.length === 1 && /挖斷了主線/.test(news[0].text) && news[0].tone === 'bad' && dft && dft.via === parseIp('10.255.1.2'),
    '180 秒：主線被挖斷（線路的原因寫著道路施工），通知跳出來，預設路由切到備援線路');
  ok(lv.objectives.every((o) => (o.type === 'check' ? o.test(g) : runObjective(g, o).pass) === true), '主線斷掉的這段時間，任務照樣算得出來（平常走主線的項目在複本上把線接回去再測）');
  sim.advance(g, 420); settle(g);
  const n2 = takeScriptNews(g);
  ok(g.rt.cable[pc().id] === 'up' && n2.length === 1 && n2[0].tone === 'ok' && !nextScript(g), '600 秒：主線修好了，劇本結束');
}

console.log('\nPKI 與 IKEv2 的憑證驗證');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { logRows, iosClock } = await import('../src/engine/ops.js');
  const { makeState, makeDevice } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  // trustpoint、authenticate、enroll
  const p = makeState([makeDevice('isr4331', 'r1', { name: 'BR-RT' }), makeDevice('tower', 'ca', { name: 'CA', ip: '10.0.0.7', gw: '10.0.0.1', services: [{ proto: 'tcp', port: 80, name: 'SCEP' }] })], [['r1:Gi0/0/1', 'ca:eth0']]);
  p.devices.ca.ca = { name: 'Corp Root CA' };
  settle(p);
  const R = cli(p, 'r1');
  R('configure terminal', 'interface Gi0/0/1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'crypto pki trustpoint CORP', 'enrollment url http://10.0.0.7:80/certsrv/mscep/mscep.dll', 'subject-name CN=br-rt.corp.local', 'revocation-check none', 'exit');
  ok(/You must authenticate the Certificate Authority/.test(R('crypto pki enroll CORP')), '還沒 authenticate 就 enroll：IOS 要求先取得 CA 的根憑證');
  const a = R('crypto pki authenticate CORP');
  ok(/Fingerprint MD5: [0-9A-F]{8} /.test(a) && /Do you accept this certificate\? \[yes\/no\]/.test(a) && /Trustpoint CA certificate accepted/.test(R('yes')), 'crypto pki authenticate：顯示指紋、確認之後接受 CA 的根憑證');
  const e = R('crypto pki enroll CORP');
  ok(/Request certificate from CA\? \[yes\/no\]/.test(e) && /Certificate request sent to Certificate Authority/.test(R('yes')) && p.devices.r1.pki.tps.CORP.cert && p.devices.r1.pki.tps.CORP.cert.cn === 'br-rt.corp.local', 'crypto pki enroll：CA 核發憑證（CN=br-rt.corp.local）');
  R('end');
  ok(/%PKI-6-CERTRET: Certificate received from Certificate Authority/.test(logRows(p, p.devices.r1).map((x) => x.line).join('\n')), 'log：%PKI-6-CERTRET');
  const sc = R('show crypto pki certificates');
  ok(/Certificate\n  Status: Available\n  Certificate Serial Number \(hex\): 02/.test(sc) && /CA Certificate\n  Status: Available/.test(sc) && /cn=Corp Root CA/.test(sc) && /Issuing CA authenticated \.+ Yes/.test(R('show crypto pki trustpoints status')), 'show crypto pki certificates / trustpoints status');
  const rc = runningConfig(p, p.devices.r1).join('\n');
  ok(/crypto pki trustpoint CORP\n enrollment url http:\/\/10\.0\.0\.7:80\/certsrv\/mscep\/mscep\.dll\n subject-name CN=br-rt\.corp\.local\n revocation-check none/.test(rc) && /crypto pki certificate chain CORP\n certificate 02\n  3082[0-9A-F]{4} [0-9A-F]{8}/.test(rc) && / certificate ca 01\n/.test(rc) && /\tquit/.test(rc), 'running-config：trustpoint 與 certificate chain（貼回去可以還原）');
  ok(/% Trustpoint NOPE does not exist/.test(R('configure terminal', 'crypto ikev2 profile X', 'pki trustpoint NOPE', 'end')), 'ikev2 profile 指定不存在的 trustpoint：IOS 拒絕');

  // 關卡：換了主機板電池的 BR-RT
  const lv = LEVELS.find((x) => x.id === 'l101');
  const s = lv.setup(); settle(s); sim.advance(s, 70); settle(s);
  const B = cli(s, 'br'), T = () => s.devices.br.rt.tunnels.find((t) => t.name === 'Tunnel0');
  ok(/^\*\d\d:\d\d:\d\d\.\d{3} UTC Tue Jan 1 2002$/.test(iosClock(s, s.devices.br)) && !T().up && /還沒生效/.test(T().why), 'BR-RT 的時鐘回到 2002 年（*），HQ-RT 的憑證「還沒生效」，VPN 建不起來');
  ok(/%PKI-3-CERTIFICATE_INVALID_NOT_YET_VALID: Certificate chain validation has failed\.  The certificate \(SN: 02\) is not yet valid   Validity period starts on 01:50:00 UTC Jun 2 2025/.test(B('show logging')) && /Status: Not yet valid/.test(B('show crypto pki certificates')),
    'show logging：%PKI-3-CERTIFICATE_INVALID_NOT_YET_VALID；show crypto pki certificates：Not yet valid');
  B('debug crypto ikev2'); sim.advance(s, 12);
  ok(/IKEv2:\(SESSION ID = 1,SA ID = 1\):Verify cert failed/.test(B('show logging')), 'debug crypto ikev2：Verify cert failed');
  B('undebug all', 'clock set 01:02:00 5 January 2026');
  ok(T().up && sim.runObjective(s, lv.objectives[0]).pass, 'clock set 把時間設對：VPN 起來，分公司打得開 ERP');
  // revocation-check 的預設是 crl：CA 在 VPN 另一邊就拿不到 CRL
  B('configure terminal', 'crypto pki trustpoint CORP', 'no revocation-check', 'end');
  ok(!T().up && /拿不到 CRL/.test(T().why), 'revocation-check crl（預設）：CA 要經過 VPN 才到得了，拿不到 CRL，驗證失敗');
  B('configure terminal', 'crypto pki trustpoint CORP', 'revocation-check crl none', 'end');
  ok(T().up, 'revocation-check crl none：拿不到 CRL 就算了，VPN 恢復');
  // 身分與驗證方式
  B('configure terminal', 'crypto ikev2 profile PROF', 'no identity local', 'end');
  ok(!T().up && /找不到符合的 ikev2 profile.*match identity remote fqdn domain corp\.local/.test(T().why), '拿掉 identity local fqdn：身分變成位址，HQ-RT 的 match identity remote fqdn domain 對不上');
  B('configure terminal', 'crypto ikev2 profile PROF', 'identity local fqdn br-rt.corp.local', 'authentication local pre-share', 'end');
  ok(!T().up && /沒有指定 keyring/.test(T().why), 'authentication local pre-share 卻沒有 keyring：IKEv2 拿不到預先共用金鑰');
  B('configure terminal', 'crypto ikev2 keyring KR', 'peer HQ', 'address 203.0.113.10', 'pre-shared-key Br!2026', 'exit', 'exit', 'crypto ikev2 profile PROF', 'keyring local KR', 'end');
  ok(!T().up && /用 pre-share 證明自己.*卻要用 rsa-sig 驗證它/.test(T().why), '有了 keyring，但 HQ-RT 要用 rsa-sig 驗證：驗證方式不一致');
  B('configure terminal', 'crypto ikev2 profile PROF', 'no keyring', 'end');
  B('configure terminal', 'crypto ikev2 profile PROF', 'authentication local rsa-sig', 'end');
  ok(T().up && / authentication local rsa-sig\n pki trustpoint CORP/.test(runningConfig(s, s.devices.br).join('\n')), '改回 rsa-sig：VPN 恢復；running-config 有 authentication rsa-sig 與 pki trustpoint');
  const s2 = lv.setup(); settle(s2); lv.solve(s2); settle(s2);
  ok(lv.objectives.every((o) => (o.type === 'check' ? o.test(s2) : sim.runObjective(s2, o).pass) === true), '解法：clock set 加上 ntp server 216.239.35.0（不經過 VPN），四個目標都通過');
}

console.log('\n802.1X 的 EAP-TLS');
{
  const { issueCert, CORP_CA } = await import('../src/engine/web.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l102');
  const s = lv.setup(); settle(s);
  const note = (id) => s.devices[id].ifaces[0].rt.note || '';
  const auth = (p) => s.rt.auth.dot1x['sw:' + p];
  ok(!auth('Gi0/1').ok && /不接受 RADIUS 伺服器（NPS）的憑證 nps\.corp\.local：憑證 2026-01-04 就到期了/.test(note('pc1')), 'NPS 的伺服器憑證過期：用戶端拒絕它，財務 PC 登不進去');
  ok(/還沒生效/.test(note('nb')) && /不信任簽發它的「Corp Root CA」/.test(note('vend')), '時鐘差兩年的筆電：伺服器憑證「還沒生效」；沒有加入網域的廠商筆電不信任公司的 CA');
  s.devices.nps.radiusServer.cert = issueCert(s, { cn: 'nps.corp.local', issuer: CORP_CA, days: 730 }); settle(s);
  ok(auth('Gi0/1').ok && !auth('Gi0/2').ok && /2026-01-05 才生效/.test(note('nb')), '重新申請伺服器憑證：財務 PC 通過；筆電的時鐘還是 2023 年，新的憑證在它眼裡還沒生效');
  s.devices.nb.clock = { sync: true }; settle(s);
  ok(auth('Gi0/2').ok && !auth('Gi0/3').ok, '筆電打開自動校時：通過；廠商筆電仍然被擋');
  s.devices.vend.trust = [CORP_CA]; settle(s);
  ok(/沒有用戶端憑證/.test(note('vend')), '廠商筆電就算信任公司的 CA，也沒有電腦憑證：EAP-TLS 登入不了');
  s.devices.nps.radiusServer.trust = ['Other CA']; settle(s);
  ok(!auth('Gi0/1').ok && /RADIUS 拒絕了 財務 PC 的憑證 fin-pc01\.corp\.local：NPS 不信任簽發它的「Corp Root CA」/.test(note('pc1')), 'NPS 不信任簽發電腦憑證的 CA：拒絕用戶端');
  s.devices.nps.radiusServer.trust = [CORP_CA]; s.devices.nps.radiusServer.tls = false; settle(s);
  ok(/沒有開啟 EAP-TLS/.test(note('pc1')), 'NPS 關掉 EAP-TLS：只接受帳號密碼');
  delete s.devices.nps.radiusServer.tls; s.devices.pc1.dot1x.cert.to = Date.UTC(2025, 11, 1); settle(s);
  ok(/RADIUS 拒絕了 財務 PC 的憑證.*2025-12-01 就到期了/.test(note('pc1')), '電腦憑證過期：RADIUS 拒絕（用 NPS 自己的時鐘判斷）');
}

console.log('\n5 GHz 的頻道寬度與 DFS');
{
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  ok(sim.blockOf(44, 80).join() === '36,40,44,48' && sim.blockOf(149, 160).join() === '149,153,157,161' && sim.blockOf(165, 80).join() === '165' && sim.blockOf(100, 40).join() === '100,104', 'blockOf：80 MHz 的 44 佔 36 – 48；149 沒有 160 MHz（退回 80）；165 只能 20 MHz');
  const lv = LEVELS.find((x) => x.id === 'l104');
  const s = lv.setup(); settle(s);
  const A = s.devices.apA, B = s.devices.apB, C = s.devices.apC, assoc = (id) => s.devices[id].ifaces.map((i) => i.rt.assoc).find(Boolean);
  ok(A.rt.interf.some((x) => x.dev === 'apB' && x.band === '5GHz') && assoc('nbA').noisy && assoc('nbA').rate === 293 && assoc('nbC').rate === 585, '36 和 44 都開 80 MHz：同一塊頻譜互相干擾，速率減半；會議室獨佔 80 MHz（585 Mbps）');
  sim.advance(s, 152); settle(s);
  ok(C.rt.dfs && C.rt.dfs.from === 100 && C.rt.dfs.to === 40 && C.rt.dfs.hold && assoc('nbC').band === '2.4GHz', '雷達：會議室從 DFS 頻道 100 換到 40，換頻道的 15 秒內筆電退回 2.4 GHz');
  sim.advance(s, 20); settle(s);
  ok(!C.rt.dfs.hold && assoc('nbC').band === '5GHz' && assoc('nbC').noisy && C.rt.interf.length >= 2, '15 秒後回到 5 GHz，可是新的頻道 40 撞上另外兩台');
  delete A.wifi.width5; delete B.wifi.width5; settle(s);
  ok(A.rt.width5 === 20 && B.rt.width5 === 20, '寬度改成自動：附近有人用到同一塊，自動縮窄到 20 MHz');
  Object.assign(A.wifi, { ch5: 36, width5: 40 }); Object.assign(B.wifi, { ch5: 44, width5: 40 }); Object.assign(C.wifi, { ch5: 149, width5: 80 }); settle(s);
  ok(!C.rt.dfs && lv.objectives.every((o) => o.test(s) === true) && assoc('nbA').rate === 270 && assoc('nbC').rate === 585, '40 MHz 的 36、44，80 MHz 的 149：互不干擾、不用 DFS，五個目標都通過');
  sim.advance(s, 300); settle(s);
  ok(!C.rt.dfs && lv.objectives.every((o) => o.test(s) === true), '之後雷達再掃過來也沒影響（不在 DFS 頻道上）');
}

console.log('\n6 GHz (Wi-Fi 6E)');
{
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l105');
  const s = lv.setup(); settle(s);
  const a = (id) => s.devices[id].ifaces.map((i) => i.rt.assoc).find(Boolean);
  ok(a('nbNew').band === '5GHz' && a('prn') && a('nbOld').band === '5GHz', 'WPA2 的 SSID：6E 的新筆電也只能連 5 GHz');
  s.devices.ap.wifi.ssids[0].sec = 'wpa3'; settle(s);
  ok(a('nbNew').band === '6GHz' && a('nbNew').rate === 1441 && a('nbNew').width === 160 && !a('prn') && /不支援 WPA3/.test(s.devices.prn.ifaces.find((i) => i.bind.t === 'wlan').rt.note), '純 WPA3：新筆電上 6 GHz（160 MHz、1441 Mbps），只支援 WPA2 的印表機連不上');
  s.devices.ap.wifi.ssids[0].sec = 'wpa2wpa3'; settle(s);
  ok(a('nbNew').band === '6GHz' && a('prn').band === '5GHz' && a('nbOld').band === '5GHz' && lv.objectives.filter((o) => o.type === 'check').every((o) => o.test(s) === true), 'WPA2 / WPA3 混合：6E 的筆電走 6 GHz，舊筆電與印表機留在 5 GHz');
  s.devices.nbNew.pos = [-6, 1]; settle(s);
  ok(a('nbNew') && a('nbNew').band === '5GHz', '6 GHz 傳得比較近：離 AP 6 公尺，5 GHz 還收得到、6 GHz 就退回 5 GHz');
}

console.log('\n無線控制器 N+1');
{
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l106');
  const s = lv.setup(); settle(s);
  const cw = (id) => s.devices[id].rt.capwap || {};
  s.devices.ap1.lwap.secondary = '10.10.10.6'; settle(s);
  ok(cw('ap1').wlc === 'wlc2' && cw('ap2').wlc === 'wlc1', '只填次要控制器：AP 先試手動指定的，平常就跑到 WLC-2');
  lv.solve(s); settle(s);
  ok(cw('ap1').wlc === 'wlc1' && cw('ap2').wlc === 'wlc1', '主要 10.10.10.5、次要 10.10.10.6：平常在 WLC-1');
  s.down = { wlc1: true }; sim.recompute(s);
  ok(!cw('ap1').joined && /heartbeat 逾時/.test(s.dyn.capwap.ap1.why || '') || /正在加入 WLC-2/.test(cw('ap1').why || ''), 'WLC-1 關機：AP 要等 heartbeat 逾時才去加入 WLC-2');
  sim.advance(s, 40);
  ok(!cw('ap1').joined, '40 秒後還在切換（heartbeat 30 秒 + 加入 25 秒）');
  sim.advance(s, 20);
  ok(cw('ap1').joined && cw('ap1').wlc === 'wlc2' && sim.runObjective(s, { type: 'tcp', from: 'nb1', ip: '10.10.40.10', port: 443 }).pass, '大約一分鐘後加入 WLC-2，筆電照樣開得了檔案伺服器');
  delete s.down; settle(s, 900);
  ok(cw('ap1').wlc === 'wlc1', 'WLC-1 開機回來（9800 要六分鐘）：AP 自己切回主要控制器 (AP fallback)');
}

console.log('\n訪客入口 (Captive Portal)');
{
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l108');
  const s = lv.setup(); settle(s);
  const web = () => sim.transact(s, 'g1', { proto: 'tcp', dst: parseIp('93.184.216.34'), dport: 443, quiet: true });
  ok(!web().ok && web().portal === parseIp('192.168.50.5') && /HTTP 302/.test(web().reason), '還沒同意：HTTPS 被導向入口網頁 192.168.50.5 (302)');
  ok(sim.transact(s, 'g1', { proto: 'tcp', dst: parseIp('192.168.50.5'), dport: 80, quiet: true }).ok, '入口網頁本身連得到');
  const r = sim.portalAccept(s, 'g1', sim.transact);
  ok(!r.ok && /DNS 伺服器 8\.8\.8\.8 連不到/.test(r.why), '按同意：DNS 不在認證前允許的位址，手機偵測不到入口');
  s.devices.ap.wifi.ssids[0].portal.preauth = '8.8.8.8'; settle(s);
  ok(sim.portalAccept(s, 'g1', sim.transact).ok && web().ok, '允許 DNS 8.8.8.8：跳出入口網頁，同意之後可以上網');
  ok(!sim.transact(s, 'g2', { proto: 'tcp', dst: parseIp('93.184.216.34'), dport: 443, quiet: true }).ok, '另一台沒按同意的筆電還是上不了網');
  sim.advance(s, 8 * 3600 + 10); settle(s);
  ok(!web().ok && web().portal, '8 小時後 session 逾時：要重新同意');
}

console.log('\nVPC peering 與 Transit Gateway');
{
  const sim = await import('../src/engine/sim.js');
  const { peerState, tgwRoutes } = await import('../src/engine/cloud.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l110');
  const s = lv.setup(); settle(s);
  const tcp = (from, src, dst, port) => sim.transact(s, from, { proto: 'tcp', srcIp: parseIp(src), dst: parseIp(dst), dport: port, quiet: true });
  ok(tcp('shared', '10.20.1.10', '10.10.1.20', 3306).ok && tcp('shared', '10.20.1.10', '10.30.1.10', 443).ok, 'shared 經過兩條 peering 連得到 prod 與 dev');
  const r = tcp('dev', '10.30.1.10', '10.10.1.20', 3306);
  ok(!r.ok && /non-transitive/.test(r.reason), `dev → prod：peering 不能轉送（${r.reason.slice(0, 40)}…）`);
  const pv = s.devices.prod.vpc, PS = pv.peers[0];
  s.devices.shared.vpc.peers.find((x) => x.id === PS.id).status = 'pending'; settle(s);
  ok(!peerState(s, s.devices.prod, PS).ok && /pending-acceptance/.test(peerState(s, s.devices.prod, PS).why) && !tcp('shared', '10.20.1.10', '10.10.1.20', 3306).ok, '對方還沒接受 (pending-acceptance)：peering 不通');
  s.devices.shared.vpc.peers.find((x) => x.id === PS.id).status = 'active'; settle(s);
  const T = 'tgw-0f3a8c27d1e94b605';
  s.devices.tgw.tgw.attach = ['prod', 'shared', 'dev'];
  ok(tgwRoutes(s, s.devices.tgw).filter((x) => x.prop).map((x) => x.dst).join() === '10.10.0.0/16,10.20.0.0/16,10.30.0.0/16', 'Transit Gateway 的路由表：三個 VPC 的網段都傳播進來');
  s.devices.dev.vpc.rts[0].routes.find((x) => x.dst === '10.10.0.0/16').target = T;
  s.devices.prod.vpc.sgs.find((g) => g.id === 'sg-0db').in.push({ proto: 'tcp', port: '3306', src: '10.30.0.0/16' }); settle(s);
  const r2 = tcp('dev', '10.30.1.10', '10.10.1.20', 3306);
  ok(!r2.ok && r2.phase === 'reply', `去程經過 Transit Gateway 到得了，但 prod 沒有往 dev 的回程路由：${r2.reason.slice(0, 50)}`);
  s.devices.prod.vpc.rts[0].routes.push({ dst: '10.30.0.0/16', target: T }); settle(s);
  const r3 = tcp('dev', '10.30.1.10', '10.10.1.20', 3306);
  ok(r3.ok && r3.hops.some((h) => h.to === 'tgw') && r3.log.some((l) => /Transit Gateway 的路由表：10\.10\.0\.0\/16 → AWS · prod/.test(l.text) || /路由表：10\.10\.0\.0\/16/.test(l.text)), 'prod 加上回程路由：dev → Transit Gateway → prod 的 db 通了');
  s.devices.tgw.tgw.noProp = ['prod']; settle(s);
  ok(!tcp('dev', '10.30.1.10', '10.10.1.20', 3306).ok, '關掉 prod 的路由傳播：Transit Gateway 不知道 10.10.0.0/16 在哪裡');
}

console.log('\nNETCONF');
{
  const { netconf } = await import('../src/engine/restconf.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l111');
  const s = lv.setup(); settle(s);
  const nc = (o) => netconf(s, 'auto', { host: '10.20.0.1', user: 'netauto', pass: 'Aut0mate!26', quiet: true, ...o });
  ok(/Connection refused/.test(nc({ op: 'hello' }).error) && /netconf-yang/.test(nc({ op: 'hello' }).why), '沒有 netconf-yang：830 埠連線被拒絕');
  const S = iosSession(() => s.devices.rt, () => s);
  for (const l of ['configure terminal', 'netconf-yang', 'end']) S.exec(l);
  settle(s);
  ok(/RSA 金鑰/.test(nc({ op: 'hello' }).why), '有 netconf-yang 但沒有 RSA 金鑰：SSH 沒有在聽');
  for (const l of ['configure terminal', 'ip domain name corp.local', 'crypto key generate rsa modulus 2048', 'end']) S.exec(l);
  settle(s);
  const h = nc({ op: 'hello' });
  ok(h.ok && /<capability>urn:ietf:params:netconf:base:1\.1<\/capability>/.test(h.xml) && /ietf-interfaces\?module=ietf-interfaces/.test(h.xml), '<hello>：列出 base 1.0 / 1.1 與 YANG 模組');
  ok(/AuthenticationError/.test(nc({ op: 'hello', pass: 'wrong' }).error), '密碼錯誤：AuthenticationError');
  ok(/<interface>\s*<name>GigabitEthernet0\/0\/1<\/name>/.test(nc({ op: 'get-config' }).xml), '<get-config>：running 裡的介面 (ietf-interfaces)');
  ok(/operation-not-supported/.test(nc({ op: 'get-config', source: 'candidate' }).xml), 'candidate：IOS XE 預設沒有，回 <rpc-error> operation-not-supported');
  ok(/data-missing/.test(nc({ op: 'edit-config', config: '<config><interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"><interface><name>GigabitEthernet9/9/9</name></interface></interfaces></config>' }).xml), '<edit-config> 不存在的實體介面：data-missing');
  const e = nc({ op: 'edit-config', config: '<config><interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"><interface><name>Loopback100</name><description>MGMT</description><ipv4 xmlns="urn:ietf:params:xml:ns:yang:ietf-ip"><address><ip>10.255.255.1</ip><netmask>255.255.255.255</netmask></address></ipv4></interface></interfaces></config>' });
  const rc = runningConfig(s, s.devices.rt).join('\n');
  ok(e.ok && /<ok\/>/.test(e.xml) && /interface Loopback100\n description MGMT\n ip address 10\.255\.255\.1 255\.255\.255\.255/.test(rc) && /\nnetconf-yang/.test(rc), '<edit-config>：建立 Loopback100，回 <ok/>；running-config 有 netconf-yang');
}

console.log('\nTerraform');
{
  const sim = await import('../src/engine/sim.js');
  const { terraform, tfPlan, parseHcl } = await import('../src/engine/terraform.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l112');
  const fresh = () => { const s = lv.setup(); settle(s); return s; };
  const txt = (r) => r.lines.map((l) => l.t).join('\n');
  const partner = (s) => sim.transact(s, 'inet', { proto: 'tcp', srcIp: parseIp('198.51.100.25'), dst: parseIp('54.199.20.10'), dport: 8443, quiet: true });
  const s = fresh();
  const tf = (...a) => terraform(s, 'tf', a);
  ok(tf('plan').rc === 1 && /terraform init/.test(txt(tf('plan'))), '還沒 init：plan 提示先 terraform init');
  ok(/successfully initialized/.test(txt(tf('init'))) && s.devices.tf.tf.inited, 'terraform init：經過 R1 的 NAT 連到 registry.terraform.io 下載 provider');
  const p = txt(tf('plan'));
  ok(/Objects have changed outside of Terraform/.test(p) && /\+ ingress \{ protocol = "tcp", from_port = 8443, to_port = 8443, cidr_blocks = \["198\.51\.100\.25\/32"\] \}/.test(p), 'plan：列出主控台手動加的規則 (drift)');
  ok(/Plan: 0 to add, 1 to change, 0 to destroy\./.test(p) && /- ingress \{ protocol = "tcp", from_port = 22, to_port = 22, cidr_blocks = \["0\.0\.0\.0\/0"\] \}/.test(p), 'plan：要把兩條手動規則拿掉（1 to change）');
  const a = tf('apply');
  ok(a.ask && /Only 'yes' will be accepted/.test(txt(a)) && s.devices.aws.vpc.sgs.find((g) => g.id === 'sg-0web').in.length === 4, 'apply 沒有 -auto-approve：先問 yes，雲端還沒動');
  // 直接 apply：合作夥伴的 8443 也被拿掉
  const s2 = fresh();
  terraform(s2, 'tf', ['init']);
  const a2 = terraform(s2, 'tf', ['apply', '-auto-approve']); settle(s2);
  ok(/Apply complete! Resources: 0 added, 1 changed, 0 destroyed\./.test(txt(a2)) && !partner(s2).ok && /No changes/.test(txt(terraform(s2, 'tf', ['plan']))), '沒看清楚就 apply：合作夥伴的 8443 也被拿掉了（plan 變成 No changes）');
  // 語法錯誤、不支援的資源
  s.devices.tf.tf.main = s.devices.tf.tf.main.replace('protocol    = "-1"', 'protocol    = "-1');
  ok(/Invalid configuration syntax/.test(txt(tf('validate'))) && /on main\.tf line \d+/.test(txt(tf('plan'))), 'main.tf 少了引號：validate / plan 指出第幾行');
  s.devices.tf.tf.main = 'provider "aws" {\n  region = "ap-northeast-1"\n}\nresource "aws_instance" "x" {\n}\n';
  ok(/只支援 aws_security_group/.test(txt(tf('validate'))), '不支援的資源類型：明確的錯誤');
  // import：state 裡沒有，雲端已經有同名的
  const s3 = fresh();
  s3.devices.tf.tf.state = {};
  terraform(s3, 'tf', ['init']);
  const a3 = terraform(s3, 'tf', ['apply', '-auto-approve']);
  ok(a3.rc === 1 && /InvalidGroup\.Duplicate/.test(txt(a3)) && /terraform import/.test(txt(a3)), 'state 裡沒有的安全群組：apply 要建立，撞到 InvalidGroup.Duplicate，提示 terraform import');
  ok(/Import successful/.test(txt(terraform(s3, 'tf', ['import', 'aws_security_group.web', 'sg-0web']))) && /1 to change/.test(txt(terraform(s3, 'tf', ['plan']))), 'terraform import 之後：plan 變成就地修改');
  // 控制主機連不上網際網路
  const s4 = fresh();
  s4.devices.tf.ifaces[0].gateway = ''; settle(s4);
  const i4 = terraform(s4, 'tf', ['init']);
  ok(i4.rc === 1 && /could not connect to registry\.terraform\.io/.test(txt(i4)), '控制主機沒有預設閘道：init 連不到 registry.terraform.io');
  // 解法：補上 8443 再 apply
  const s5 = fresh();
  lv.solve(s5); settle(s5);
  ok(partner(s5).ok && /No changes/.test(txt(terraform(s5, 'tf', ['plan']))) && !tfPlan(s5, s5.devices.tf).drift.length, '補上 8443 再 apply：合作夥伴連得上、plan 是 No changes、state 和雲端一致');
  ok(parseHcl('terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}').length === 1, 'HCL：物件值（required_providers）');
}

console.log('\nCatalyst Center 的範本');
{
  const { tplVars, tplRender, tplCommit, tplDeploy, inventory } = await import('../src/engine/dnac.js');
  const { iosSession, runningConfig, hostName } = await import('../src/engine/ios.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l113');
  const s = lv.setup(); settle(s);
  const c = s.devices.dnac, C = c.dnac, t = C.templates[0];
  const P = { swa: { hostname: 'TPE-AS01', location: 'TPE-3F-A' }, swb: { hostname: 'TPE-AS02', location: 'TPE-3F-B' }, swc: { hostname: 'TPE-AS03', location: 'TPE-5F-C' } };
  const all = () => ['swa', 'swb', 'swc'].map((id) => ({ dev: id, params: P[id] }));
  ok(tplVars(t.draft).join() === 'hostname,location' && tplRender('hostname ${hostname}-x\n## 註解\n', { hostname: 'A' }).lines.join() === 'hostname A-x', '變數：$name 與 ${name}；## 是範本的註解，不會送出');
  const inv = inventory(s, c);
  ok(inv.filter((x) => x.json.reachabilityStatus === 'Reachable').length === 2 && inv[2].json.reachabilityFailureReason === 'SSH Connection Failed', '設備清單：SW-C 是 Unreachable (SSH Connection Failed)，SNMP 通、SSH 被 access-class 擋');
  ok(/變數沒有填：location/.test(tplDeploy(s, c, t.id, [{ dev: 'swa', params: { hostname: 'X' } }]).error), '有變數沒填：整批都不部署');
  // 用已提交的 v1 部署：成功，但沒有 logging host
  const d1 = tplDeploy(s, c, t.id, all()); settle(s);
  const rcA = runningConfig(s, s.devices.swa).join('\n');
  ok(d1.ver === 1 && d1.results[0].status === 'SUCCESS' && hostName(s.devices.swa) === 'TPE-AS01' && /snmp-server location TPE-3F-A/.test(rcA) && /ntp server 10\.1\.98\.10/.test(rcA) && !/logging host/.test(rcA), '部署用的是已提交的 v1（草稿的 logging host 沒有送出）');
  ok(d1.results[2].status === 'FAILURE' && /允許管理的位址範圍/.test(d1.results[2].detail), `SW-C：控制器用 SSH 連不到（${d1.results[2].detail.slice(0, 40)}…）`);
  ok(((s.dyn.log || {}).swa || []).some((x) => /%SYS-5-CONFIG_I: Configured from console by netops on vty0 \(10\.1\.98\.20\)/.test(x.line)), '設備的紀錄：%SYS-5-CONFIG_I Configured from console by netops on vty0 (10.1.98.20)');
  // 提交草稿 (v2)：錯字 ntp sever
  const cm = tplCommit(s, c, t.id, 'Add logging host');
  ok(cm.ok && cm.ver.v === 2 && /和最新的版本一樣/.test(tplCommit(s, c, t.id, 'again').error), '提交草稿成 v2；沒有修改就不能再提交');
  const d2 = tplDeploy(s, c, t.id, all().slice(0, 2)); settle(s);
  ok(d2.results.every((x) => x.status === 'FAILURE' && /第 4 行「ntp sever 10\.1\.98\.10」/.test(x.detail)) && !/logging host/.test(runningConfig(s, s.devices.swb).join('\n')), 'v2 在「ntp sever」那一行失敗（前面的行已經套用，後面的沒有）');
  t.draft = t.draft.replace('ntp sever', 'ntp server');
  tplCommit(s, c, t.id, 'Fix typo');
  const SC = iosSession(() => s.devices.swc, () => s);
  for (const l of ['configure terminal', 'ip access-list standard MGMT', 'permit 10.1.98.0 0.0.0.255', 'end']) SC.exec(l);
  settle(s);
  ok(s.devices.swc.mgmt.allow.includes('10.1.98.0/24') && inventory(s, c).every((x) => x.json.reachabilityStatus === 'Reachable'), 'SW-C 的 MGMT 加上控制器的網段：三台都 Reachable');
  const d3 = tplDeploy(s, c, t.id, all()); settle(s);
  ok(d3.ver === 3 && d3.results.every((x) => x.status === 'SUCCESS') && /logging host 10\.1\.98\.10/.test(runningConfig(s, s.devices.swc).join('\n')) && s.devices.swc.sw.vlans.some((v) => v.id === 40 && v.name === 'VOICE'), 'v3 部署到三台：都 SUCCESS');
}

console.log('\n用 Git 管理設定');
{
  const sim = await import('../src/engine/sim.js');
  const { git, runBackup, repoInSync, cfgText, lineDiff } = await import('../src/engine/git.js');
  const { iosSession } = await import('../src/engine/ios.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l114');
  const s = lv.setup(); settle(s);
  const G = (...a) => git(s, 'bk', a).map((l) => l.t).join('\n');
  const log = G('log', '--oneline');
  ok(log.split('\n').length === 3 && /\(HEAD -> main\) Automatic backup 2026-01-04 23:45/.test(log), 'git log --oneline：三筆提交，最新的是昨晚的自動備份');
  ok(/Author: bob <bob@corp\.local>\nDate:   Sun Jan 4 23:45:12 2026 \+0800/.test(G('log', '-n', '1')) && /sw2: FAILED/.test(G('log', '-n', '1')), 'git log -n 1：作者、日期（台灣時間）與完整的說明');
  const show = G('show', 'HEAD');
  ok(/\n@@ -\d+,\d+ \+\d+,\d+ @@ \S/.test(show) && /\n- switchport trunk allowed vlan 30,99\n\+ switchport trunk allowed vlan 40\n/.test(show) && /\+interface Vlan40/.test(show), 'git show HEAD：Core 的 trunk 從 30,99 變成 40（少打 add），也看得到新增的 Vlan40');
  ok(!/sw2\.cfg/.test(show) && /sw1\.cfg/.test(G('show', 'HEAD~1', '--stat')), '昨晚 SW-2 備份失敗：那一筆沒有 sw2.cfg；前一筆是 Alice 改 sw1.cfg');
  ok(/^nothing to commit, working tree clean$/m.test(G('status')), '一開始工作目錄是乾淨的');
  const b0 = runBackup(s, 'bk');
  ok(!b0.res.sw2 && b0.res.core && /sw2[^\n]*FAILED/.test(b0.lines.map((l) => l.t).join('\n')) && /^nothing to commit/m.test(G('status')), '還沒修：./backup.sh 連不到 SW-2，其他兩台沒有變更');
  const S = iosSession(() => s.devices.core, () => s);
  for (const l of ['configure terminal', 'interface gi1/0/2', 'switchport trunk allowed vlan 30,40,99', 'end']) S.exec(l);
  settle(s);
  const b1 = runBackup(s, 'bk');
  ok(Object.values(b1.res).every(Boolean), '修好之後 ./backup.sh：三台都成功');
  const st = G('status');
  ok(/modified:   core\.cfg/.test(st) && /modified:   sw2\.cfg/.test(st) && !/sw1\.cfg/.test(st) && /no changes added to commit/.test(st), 'git status：core.cfg 與 sw2.cfg 有變更（SW-2 終於備份到 Bob 昨晚的修改）');
  ok(/\n- switchport trunk allowed vlan 40\n\+ switchport trunk allowed vlan 30,40,99\n/.test(G('diff', '--', 'core.cfg')), 'git diff -- core.cfg：只看 Core 的差異');
  ok(/no changes added to commit/.test(G('commit', '-m', 'x')), '沒有 git add 就 commit：沒有東西可以提交');
  G('add', 'core.cfg');
  ok(/Aborting commit due to empty commit message/.test(G('commit')) && /Aborting commit/.test(G('commit', '-m', '  ')), 'git commit 沒有 -m（或說明是空的）：中止');
  ok(/Changes to be committed:[^]*modified:   core\.cfg[^]*Changes not staged for commit:[^]*modified:   sw2\.cfg/.test(G('status')), 'git add core.cfg：core 在暫存區，sw2 還沒有');
  ok(repoInSync(s, s.devices.bk) !== true, '還沒提交：repoInSync 指出 Git 不是最新的');
  G('add', '-A');
  const cm = G('commit', '-m', 'Core Gi1/0/2: restore VLAN 30 and 99');
  ok(/^\[main [0-9a-f]{7}\] Core Gi1\/0\/2: restore VLAN 30 and 99\n 2 files changed, \d+ insertions?\(\+\), \d+ deletions?\(-\)$/.test(cm), `git commit：${cm.split('\n')[1].trim()}`);
  ok(repoInSync(s, s.devices.bk) === true && /working tree clean/.test(G('status')), '提交之後：Git 的最新版本就是三台現在的設定');
  const bl = G('blame', 'core.cfg').split('\n').find((l) => /switchport trunk allowed vlan 30,40,99/.test(l));
  ok(/^[0-9a-f]{8} \(netops +2026-01-05 /.test(bl || ''), 'git blame：修好的那一行算在剛剛的提交');
  ok(/unknown revision/.test(G('show', 'deadbeef')) && /pathspec 'x\.cfg' did not match/.test(G('add', 'x.cfg')), '錯誤的版本與檔名：和 git 一樣的錯誤訊息');
  ok(lineDiff(['a', 'b', 'c'], ['a', 'c', 'd']).map((x) => x.op + x.text).join() === ' a,-b, c,+d', '逐行比對（最長共同子序列）');
  ok(cfgText(s, s.devices.sw1).startsWith('!\nhostname SW-1'), '備份檔拿掉 Building configuration... 這種每次都不一樣的開頭');
  void sim;
}

console.log('\n光纖收發器');
{
  const { fiberLink, linkInfo, makeDevice: MD, makeState: MS } = await import('../src/engine/model.js');
  const { opticLink, defaultOptic } = await import('../src/engine/optics.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { counters } = await import('../src/engine/wire.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l115');
  const s = lv.setup(); settle(s);
  const cab = (b) => s.cables.find((c) => [c.a.dev, c.b.dev].includes('core') && [c.a.dev, c.b.dev].includes(b));
  ok(defaultOptic('mmf', 'sfp', 1000) === 'GLC-SX-MMD' && defaultOptic('mmf', 'sfp', 10000) === 'SFP-10G-SR' && defaultOptic('smf', 'qsfp', 100000) === 'QSFP-100G-LR4-S', '預設的收發器：依線材與兩端都支援的速率');
  // l30：10G 的埠接 1G 的 SFP 埠，自動插 1G 的收發器
  const l30 = LEVELS.find((x) => x.id === 'l30'), s30 = l30.setup(); l30.solve(s30); settle(s30);
  const w30 = s30.cables.find((c) => c.kind === 'mmf');
  ok(fiberLink(s30, w30).optics.a === 'GLC-SX-MMD' && s30.rt.cable[w30.id] === 'up' && linkInfo(s30, w30.a.dev, w30.a.port).speed === 1000, '10G 的 SFP+ 埠接 1G 的 SFP 埠：兩端都是 GLC-SX-MMD，跑 1G');
  const cb = cab('sw-b');
  ok(s.rt.cable[cb.id] === 'down' && s.devices['sw-b'].rt.err['Te1/1/1'] === 'gbic' && /gbic-invalid/.test(s.rt.why[cb.id]), '第三方的收發器：B 棟的 Te1/1/1 被關成 err-disabled (gbic-invalid)');
  const log = ((s.dyn.log || {})['sw-b'] || []).map((x) => x.line).join('\n');
  ok(/%PHY-4-UNSUPPORTED_TRANSCEIVER: Unsupported transceiver found in Te1\/1\/1/.test(log) && /%PM-4-ERR_DISABLE: gbic-invalid error detected on Te1\/1\/1/.test(log), '紀錄：%PHY-4-UNSUPPORTED_TRANSCEIVER 與 %PM-4-ERR_DISABLE gbic-invalid');
  ok(/速率不同（SFP-10G-SR 是 10G、GLC-SX-MMD 是 1G）/.test(s.rt.why[cab('sw-w').id]), '一端 10G、一端 1G 的收發器：連不起來');
  const fr = fiberLink(s, cab('sw-r'));
  ok(s.rt.cable[cab('sw-r').id] === 'up' && fr.link.marginal && fr.link.rx[fr.link.marginal] < -11.1, `接頭髒了：燈有亮，但研發那端收到 ${fr.link.rx[fr.link.marginal]} dBm（低於靈敏度 -11.1）`);
  const crcOf = (id, p) => (counters(s, id, p) || {}).crc || 0;
  const before = crcOf('sw-r', 'Te1/1/1'), coreBefore = crcOf('core', 'Te1/1/3');
  for (let k = 0; k < 20; k++) sim.transact(s, 'pc-r', { proto: 'icmp', dst: parseIp('192.168.1.10') });
  ok(crcOf('sw-r', 'Te1/1/1') > before && crcOf('core', 'Te1/1/3') === coreBefore, `光功率不夠的那一端（研發 Te1/1/1）有 CRC 錯誤：${crcOf('sw-r', 'Te1/1/1')} 個；A 棟那端沒有`);
  // 第三方：service unsupported-transceiver + shutdown / no shutdown
  const s2 = lv.setup(); settle(s2);
  const B = iosSession(() => s2.devices['sw-b'], () => s2);
  for (const l of ['configure terminal', 'service unsupported-transceiver', 'end']) B.exec(l);
  settle(s2);
  ok(s2.rt.cable[s2.cables.find((c) => c.kind === 'smf').id] === 'down' && /原因已經排除/.test(s2.rt.why[s2.cables.find((c) => c.kind === 'smf').id]), 'service unsupported-transceiver：原因排除了，但 err-disabled 不會自己恢復');
  for (const l of ['configure terminal', 'interface te1/1/1', 'shutdown', 'no shutdown', 'end']) B.exec(l);
  settle(s2);
  ok(s2.rt.cable[s2.cables.find((c) => c.kind === 'smf').id] === 'up' && /\nservice unsupported-transceiver/.test(runningConfig(s2, s2.devices['sw-b']).join('\n')), 'shutdown → no shutdown：上線了；running-config 有 service unsupported-transceiver');
  // 規格
  const ends = (o, m = 'sfp', sp = 10000) => ({ optics: o, portA: sp, portB: sp, media: m, nameA: 'A', nameB: 'B' });
  ok(/要接多模光纖/.test(opticLink({ kind: 'smf' }, ends({ a: 'SFP-10G-SR', b: 'SFP-10G-SR' }), 100).down), 'SR（多模）的收發器接單模光纖：沒有燈號');
  ok(/波長不同/.test(opticLink({ kind: 'mmf' }, ends({ a: 'SFP-10G-SR', b: 'SFP-10G-LR' }), 100).down || opticLink({ kind: 'smf' }, ends({ a: 'SFP-10G-SR', b: 'SFP-10G-LR' }), 100).down), 'SR 對 LR：波長不同');
  ok(/最長 300 公尺/.test(opticLink({ kind: 'mmf' }, ends({ a: 'SFP-10G-SR', b: 'SFP-10G-SR' }), 400).down) && !opticLink({ kind: 'mmf' }, ends({ a: 'GLC-SX-MMD', b: 'GLC-SX-MMD' }, 'sfp', 1000), 400).down, '10G SR 最長 300 公尺；1G SX 可以到 550 公尺');
  ok(/最高只支援 1G/.test(opticLink({ kind: 'mmf' }, { ...ends({ a: 'SFP-10G-SR', b: 'SFP-10G-SR' }), portA: 1000 }, 100).down), '1G 的 SFP 埠插 10G 的收發器：不支援');
  const both = opticLink({ kind: 'mmf', dirty: { a: true, b: true } }, ends({ a: 'SFP-10G-SR', b: 'SFP-10G-SR' }), 290);
  ok(!both.down && both.marginal && both.margin.a < 0 && both.margin.b < 0, `兩端的接頭都髒、距離又長：兩端都收到 ${both.rx.a} dBm，有 CRC 錯誤但還沒斷`);
  ok(/Loss of Signal/.test(opticLink({ kind: 'mmf', dirty: { a: true } }, ends({ a: 'GLC-SX-MMD', b: 'SFP-10G-SR' }, 'sfp', 10000), 100).down || '') || /速率不同/.test(opticLink({ kind: 'mmf' }, ends({ a: 'GLC-SX-MMD', b: 'SFP-10G-SR' }), 100).down), '1G SX 對 10G SR：同樣 850 nm，但速率不同');
  lv.solve(s); settle(s);
  ok(['sw-b', 'sw-w', 'sw-r'].every((b) => s.rt.cable[cab(b).id] === 'up') && !fiberLink(s, cab('sw-r')).link.marginal, '參考解法：三條光纖都正常');
}

console.log('\n權限等級與 AAA（TACACS+）');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const rem = await import('../src/engine/remote.js');
  const { aaaLogin, aaaAuthorize, aaaAccount } = await import('../src/engine/aaa.js');
  const { cloneState } = await import('../src/engine/model.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l116');
  const s = lv.setup(); settle(s);
  const sw = s.devices.sw1, con = iosSession(() => s.devices.sw1, () => s);
  const run = (S, lines) => { const out = []; for (const l of lines) out.push(...S.exec(l).out); settle(s); return out; };
  // ── 權限等級 ──
  run(con, ['configure terminal', 'username helpdesk secret Help#Desk1', 'end']);
  ok(/\nusername helpdesk secret 9 /.test(runningConfig(s, sw).join('\n')) && /\nusername admin privilege 15 secret 9 /.test(runningConfig(s, sw).join('\n')), 'username 沒寫 privilege 就是 1 級（running-config 不印 privilege）；admin 是 15 級');
  const vty = iosSession(() => s.devices.sw1, () => s, { user: 'helpdesk', line: 'vty0', ip: '10.1.98.60', priv: 1 });
  ok(vty.prompt() === 'SW-1>' && /使用者模式/.test(run(vty, ['configure terminal']).join('\n')) && vty.exec('show ip interface brief').pass && !vty.exec('show running-config').pass, '1 級（使用者模式 >）：show 可以，但 configure terminal、show running-config 都不行');
  ok(/% No password set/.test(run(vty, ['enable']).join('\n')), '遠端登入、沒有 enable secret：enable 回 % No password set');
  run(con, ['configure terminal', 'enable secret En@ble2026', 'end']);
  run(vty, ['enable']);
  ok(vty.pending && vty.pending.secret && /% Access denied/.test(run(vty, ['wrong']).join('\n')), 'enable 問密碼；打錯是 % Access denied');
  run(vty, ['En@ble2026']);
  ok(vty.prompt() === 'SW-1#' && /\nenable secret 9 /.test(runningConfig(s, sw).join('\n')), 'enable secret 對了：進入特權模式 (#)；running-config 有 enable secret 9');
  run(vty, ['disable']);
  ok(vty.prompt() === 'SW-1>', 'disable：回到使用者模式');
  // 遠端登入：本機帳號的權限
  const open = (user) => rem.remoteOpen(s, 'ops', 'ssh', parseIp('10.1.99.11'), user);
  const o1 = open('helpdesk'), l1 = rem.remoteLogin(s, o1.conn, 'Help#Desk1');
  const o2 = open('admin'), l2 = rem.remoteLogin(s, o2.conn, 'Sw1-Br3akGlass');
  ok(l1.ok && l1.priv === 1 && l2.ok && l2.priv === 15, 'SSH 登入：helpdesk 是 1 級、admin 是 15 級（看帳號的 privilege）');
  // ── AAA ──
  const s2 = lv.setup(); settle(s2);
  const C = iosSession(() => s2.devices.sw1, () => s2);
  const r2 = (lines) => { const out = []; for (const l of lines) out.push(...C.exec(l).out); settle(s2); return out; };
  ok(/requires "aaa new-model"/.test(r2(['configure terminal', 'aaa authentication login default group tacacs+ local', 'end']).join('\n')), '還沒有 aaa new-model：aaa authentication 不能設定');
  r2(['configure terminal', 'aaa new-model', 'tacacs server ISE', 'address ipv4 10.1.98.20', 'key Tac@csKey2026', 'exit', 'aaa authentication login default group tacacs+ local', 'end']);
  const sw2 = s2.devices.sw1;
  const a1 = aaaLogin(s2, sw2, 'netadmin', 'N3tAdm!n#26');
  ok(!a1.ok && /沒有登記 10\.1\.99\.11/.test(a1.trail.join()) && /本機帳號：FAIL/.test(a1.trail.join()), 'ISE 沒有登記 SW-1：TACACS+ 逾時 (ERROR) → 改試本機帳號 → netadmin 不是本機帳號');
  s2.devices.ise.tacacsServer.clients.push('10.1.99.11');
  const a2 = aaaLogin(s2, sw2, 'netadmin', 'N3tAdm!n#26'), a3 = aaaLogin(s2, sw2, 'netadmin', 'wrong'), a4 = aaaLogin(s2, sw2, 'admin', 'Sw1-Br3akGlass');
  ok(a2.ok && a2.via === 'tacacs' && a2.priv === 1, 'netadmin 透過 TACACS+ 登入；沒有 aaa authorization exec，一律是 1 級');
  ok(!a3.ok && /FAIL/.test(a3.trail.join()) && !a4.ok, 'ISE 回答 FAIL（密碼錯誤、或不是 ISE 的帳號）：直接拒絕，不會再試本機帳號');
  r2(['configure terminal', 'aaa authorization exec default group tacacs+ local', 'end']);
  ok(aaaLogin(s2, sw2, 'netadmin', 'N3tAdm!n#26').priv === 15 && aaaLogin(s2, sw2, 'vendor', 'V3nd0r#Read').priv === 1, 'aaa authorization exec：權限由 ISE 決定（netadmin 15、vendor 1）');
  s2.devices.ise.tacacsServer.key = 'other';
  const a5 = aaaLogin(s2, sw2, 'admin', 'Sw1-Br3akGlass');
  ok(a5.ok && a5.via === 'local' && /共用密鑰不一致/.test(a5.trail.join()), '共用密鑰不一致：當成 ERROR，改用本機帳號 admin');
  s2.devices.ise.tacacsServer.key = 'Tac@csKey2026';
  const ven = s2.devices.ise.tacacsServer.users.find((u) => u.user === 'vendor');
  Object.assign(ven, { priv: 15, cmds: 'show' });
  r2(['configure terminal', 'aaa authorization commands 15 default group tacacs+ local', 'aaa accounting commands 15 default start-stop group tacacs+', 'end']);
  ok(aaaAuthorize(s2, sw2, 'vendor', 15, 'configure terminal') === 'Command authorization failed.' && aaaAuthorize(s2, sw2, 'vendor', 15, 'show running-config') === null && aaaAuthorize(s2, sw2, 'netadmin', 15, 'configure terminal') === null, '指令授權：vendor 只能 show（configure terminal 被拒），netadmin 都可以');
  const VS = iosSession(() => s2.devices.sw1, () => s2, { user: 'vendor', line: 'vty0', ip: '10.1.98.70', priv: 15 });
  const vo = []; for (const l of ['configure terminal', 'show running-config']) vo.push(...VS.exec(l).out);
  ok(vo.includes('Command authorization failed.') && VS.mode === 'exec', 'vendor 的連線：configure terminal → Command authorization failed.');
  const NS = iosSession(() => s2.devices.sw1, () => s2, { user: 'netadmin', line: 'vty1', ip: '10.1.98.60', priv: 15 });
  for (const l of ['configure terminal', 'interface vlan 99', 'description MGMT', 'end']) NS.exec(l);
  const log = s2.devices.ise.tacacsServer.log;
  ok(log.some((e) => e.user === 'netadmin' && e.cmd === 'description MGMT' && e.dev === 'SW-1') && !log.some((e) => e.cmd === 'end'), 'accounting：netadmin 打的 15 級指令都記到 ISE（end 這種 1 級的不記）');
  const rc = runningConfig(s2, sw2).join('\n');
  ok(/\naaa new-model\n!\naaa authentication login default group tacacs\+ local\naaa authorization exec default group tacacs\+ local\naaa authorization commands 15 default group tacacs\+ local\naaa accounting commands 15 default start-stop group tacacs\+\n/.test(rc) && /\ntacacs server ISE\n address ipv4 10\.1\.98\.20\n key 7 /.test(rc), 'running-config：aaa 的區塊與 tacacs server');
  // 伺服器掛了：只剩本機帳號
  const s3 = cloneState(s2); (s3.down ||= {}).ise = true; settle(s3);
  const a6 = aaaLogin(s3, s3.devices.sw1, 'admin', 'Sw1-Br3akGlass');
  ok(a6.ok && a6.via === 'local' && a6.priv === 15, 'ISE 關機：TACACS+ 逾時，改用本機帳號 admin（15 級）');
  r2(['configure terminal', 'aaa authentication login default group tacacs+', 'end']);
  const s4 = cloneState(s2); (s4.down ||= {}).ise = true; settle(s4);
  ok(!aaaLogin(s4, s4.devices.sw1, 'admin', 'Sw1-Br3akGlass').ok, '方法清單少了 local：ISE 一掛，誰都登不進去');
  void aaaAccount;
}

console.log('\nSD-WAN（FortiGate）');
{
  const { memberHealth, sdwanPick, newSdwan } = await import('../src/engine/sdwan.js');
  const { sipQuality } = await import('../src/engine/voice.js');
  const { fortiSession, fortiConfig } = await import('../src/engine/fortios.js');
  const sim = await import('../src/engine/sim.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l117');
  const s = lv.setup(); settle(s);
  const fg = s.devices.fg, SIP = parseIp('198.51.100.60'), WEB = parseIp('93.184.216.34');
  const q0 = sipQuality(s, 'pc-v', SIP);
  ok(q0.ok && q0.mos < 4 && q0.loss === 4 && /線路本身延遲 35 ms/.test(q0.why.join()), `沒有 SD-WAN：電話走塞車的光世代，MOS ${q0.mos}（ISP 線路的延遲、抖動、遺失算進去）`);
  const egress = (st, from, dst, proto = 'tcp', port = 443) => { const r = sim.transact(st, from, { proto, dst, dport: port, quiet: true }); const h = r.hops.find((x) => x.from === 'fg' && !x.reply && /^wan/.test(x.fromPort || '')); return { ok: r.ok, port: h && h.fromPort, r }; };
  // 啟用 SD-WAN、加成員，但政策還寫 wan1
  const F = fortiSession(() => s.devices.fg, () => s);
  const cli = (lines) => { const o = []; for (const l of lines) o.push(...F.exec(l).out); settle(s); return o.join('\n'); };
  ok(/interface is in use/.test(cli(['config system sdwan', 'set status enable', 'config members', 'edit 1', 'set interface "wan1"', 'set gateway 203.0.113.33', 'next', 'end', 'end'])), 'wan1 還被政策使用：不能加進 SD-WAN（interface is in use）');
  fg.policies[0].dstIf = 'virtual-wan-link';
  ok(!/Command fail/.test(cli(['config system sdwan', 'set status enable', 'config members', 'edit 1', 'set interface "wan1"', 'set gateway 203.0.113.33', 'next', 'edit 2', 'set interface "wan2"', 'set gateway 192.0.2.1', 'next', 'end',
    'config health-check', 'edit "Default_DNS"', 'set server "8.8.8.8"', 'set members 1 2', 'config sla', 'edit 1', 'set latency-threshold 150', 'set jitter-threshold 30', 'set packetloss-threshold 1', 'next', 'end', 'next', 'end', 'end'])) && fg.sdwan.on && fg.sdwan.members.length === 2, 'config system sdwan：成員與效能 SLA（巢狀的 config sla）');
  const H = memberHealth(s, fg);
  ok(H[0].alive && !H[0].sla && /抖動 45 ms > 30/.test(H[0].slaWhy) && /遺失 4% > 1%/.test(H[0].slaWhy) && H[1].alive && H[1].sla && H[1].latency === 20, `效能 SLA：wan1 不符合（${H[0].slaWhy}），wan2 符合（${H[1].latency} ms）`);
  ok(/Seq\(1 wan1\): state\(alive\), packet-loss\(4\.000%\) latency\(72\.000\), jitter\(45\.000\), sla_map=0x0/.test(cli(['diagnose sys sdwan health-check'])), 'diagnose sys sdwan health-check：和 FortiOS 一樣的格式');
  const rt = (fg.rt.routes || []).filter((r) => r.bits === 0);
  ok(rt.length === 2 && rt.every((r) => r.sdwan != null), '路由表：兩個成員各一條預設路由（等價）');
  // 規則：VoIP 用 SLA，其他走 wan1
  cli(['config system sdwan', 'config service', 'edit 1', 'set name "VoIP"', 'set mode sla', 'set protocol 17', 'set dst "198.51.100.60"', 'config sla', 'edit "Default_DNS"', 'set id 1', 'next', 'end', 'set priority-members 1 2', 'next',
    'edit 2', 'set name "其他上網"', 'set mode manual', 'set dst "all"', 'set priority-members 1 2', 'next', 'end', 'end']);
  const pk = sdwanPick(s, fg, { proto: 'udp', src: parseIp('192.168.10.21'), dst: SIP, dport: 16384 });
  ok(pk.route.iface.id === 'wan2' && /wan1 不符合 SLA/.test(pk.why), `VoIP 規則（SLA）：${pk.why}`);
  const q1 = sipQuality(s, 'pc-v', SIP);
  ok(q1.mos >= 4.3 && egress(s, 'pc-w', WEB).port === 'wan1', `電話改走 wan2（MOS ${q1.mos}），一般上網照樣走 wan1`);
  ok(/Seq_num\(2 wan2\), alive, sla\(0x1\), cfg_order\(1\), selected/.test(cli(['diagnose sys sdwan service'])), 'diagnose sys sdwan service：wan2 是 selected');
  // 線路斷了：dead、改走另一條
  const c2 = s.cables.find((c) => [c.a.port, c.b.port].includes('wan2'));
  (s.cut ||= {})[c2.id] = true; settle(s);
  const H2 = memberHealth(s, fg);
  ok(!H2[1].alive && egress(s, 'pc-v', SIP, 'udp', 16384).port === 'wan1' && sipQuality(s, 'pc-v', SIP).ok, 'wan2 斷線：成員 dead、從路由表移除；電話改走 wan1（SLA 全部不符合時用第一條活著的）');
  delete s.cut[c2.id]; settle(s);
  // 政策要寫 virtual-wan-link
  fg.policies[0].dstIf = 'wan1'; settle(s);
  const r3 = egress(s, 'pc-v', SIP, 'udp', 16384);
  ok(!r3.ok && /SD-WAN 的成員：政策的目的介面要用 virtual-wan-link/.test(r3.r.reason), '政策還寫 wan1：走 wan2 的流量被 implicit deny（提示改用 virtual-wan-link）');
  fg.policies[0].dstIf = 'virtual-wan-link'; settle(s);
  // show 的輸出貼回新的設備
  const txt = fortiConfig(s, fg).join('\n');
  ok(txt.indexOf('config system sdwan') < txt.indexOf('config firewall policy') && /set priority-members 1 2/.test(txt) && /set packetloss-threshold 1/.test(txt), 'show：SD-WAN 在防火牆政策前面，包含巢狀的 sla 與 priority-members');
  const g2 = { ...fg, sdwan: newSdwan() };
  ok(g2.sdwan.on && g2.sdwan.hc.server === '8.8.8.8' && !g2.sdwan.members.length, '圖形介面「啟用 SD-WAN」：預設的效能 SLA 偵測 8.8.8.8，還沒有成員');
}

console.log('\n網際網路的 IPv6 與 DHCPv6 Prefix Delegation');
{
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { transact6, globalIp6 } = await import('../src/engine/sim6.js');
  const { parseIp6, fmtIp6 } = await import('../src/engine/ip6.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const lv = LEVELS.find((x) => x.id === 'l118');
  const s = lv.setup(); settle(s);
  const R = iosSession(() => s.devices.r1, () => s);
  const run = (lines) => { const o = []; for (const l of lines) o.push(...R.exec(l).out); settle(s); return o; };
  const WEB = parseIp6('2606:2800:220:1:248:1893:25c8:1946');
  const inet = s.devices.inet;
  ok(inet.ifaces[0].rt.v6.addrs.some((a) => fmtIp6(a.ip) === '2001:db8:ff00:12::1'), 'ISP 那一端的線路：IPv6 位址 2001:db8:ff00:12::1/64、送 RA');
  run(['configure terminal', 'interface gi0/0/0', 'ipv6 address autoconfig', 'end']);
  const wan = s.devices.r1.ifaces[0].rt.v6;
  ok(wan.addrs.some((a) => a.src === 'slaac' && fmtIp6(a.ip).startsWith('2001:db8:ff00:12:')) && !(s.devices.r1.rt.routes6 || []).some((r) => r.bits === 0), 'ipv6 address autoconfig：WAN 用 SLAAC 拿到位址，但沒有 default 就沒有預設路由');
  run(['configure terminal', 'interface gi0/0/0', 'ipv6 address autoconfig default', 'end']);
  ok((s.devices.r1.rt.routes6 || []).some((r) => r.bits === 0), 'ipv6 address autoconfig default：ISP 的路由器變成 IPv6 預設路由');
  const r0 = transact6(s, 'pc1', WEB, { quiet: true });
  ok(!r0.ok && r0.phase === 'reply' && /不是 ISP 配給任何客戶的前綴/.test(r0.reason), `舊業者的前綴：封包出得去，回程沒有路（${r0.reason.slice(0, 40)}…）`);
  run(['configure terminal', 'interface gi0/0/0', 'ipv6 dhcp client pd ISP-PD', 'end']);
  const gp = s.devices.r1.rt.gp['ISP-PD'];
  ok(gp && fmtIp6(gp.prefix) === '2001:db8:4f20:7a00::' && gp.bits === 56, 'ipv6 dhcp client pd ISP-PD：拿到 2001:db8:4f20:7a00::/56（一般前綴）');
  ok((inet.rt.routes6 || []).some((r) => r.pd && fmtIp6(r.net) === '2001:db8:4f20:7a00::' && r.bits === 56), 'ISP 的路由表：委派出去的 /56 指回 R1 的 WAN');
  run(['configure terminal', 'interface gi0/0/1', 'no ipv6 address 2001:db8:1111:1::1/64', 'ipv6 address ISP-PD ::1:0:0:0:1/64', 'exit', 'interface gi0/0/2', 'ipv6 address ISP-PD ::2:0:0:0:1/64', 'end']);
  const a1 = globalIp6(s.devices.pc1), a2 = globalIp6(s.devices.pc2);
  ok(fmtIp6(a1).startsWith('2001:db8:4f20:7a01:') && fmtIp6(a2).startsWith('2001:db8:4f20:7a02:'), `一般前綴 + 子網路編號：辦公室 ${fmtIp6(a1)}、訪客 ${fmtIp6(a2)}`);
  ok(transact6(s, 'pc1', WEB, { quiet: true }).ok && transact6(s, 'pc2', WEB, { quiet: true }).ok, '兩個網段都用 IPv6 連到網際網路上的網站');
  const rc = runningConfig(s, s.devices.r1).join('\n');
  ok(/interface GigabitEthernet0\/0\/0\n[^]*? ipv6 address autoconfig default\n ipv6 dhcp client pd ISP-PD/.test(rc) && / ipv6 address ISP-PD ::1:0:0:0:1\/64/.test(rc), 'running-config：autoconfig default、dhcp client pd 與一般前綴的位址');
  const { iosRun } = await import('../src/ui/cli.js');
  const show = (line) => { const o = []; iosRun({ state: s }, 'r1', iosSession(() => s.devices.r1, () => s), line, (l) => o.push(l)); return o.join('\n'); };
  const gpTxt = show('show ipv6 general-prefix'), dhTxt = show('show ipv6 dhcp interface');
  ok(/IPv6 Prefix ISP-PD, acquired via DHCP PD\n  2001:DB8:4F20:7A00::\/56 Valid lifetime/.test(gpTxt) && /GigabitEthernet0\/0\/2 \(Address command\)/.test(gpTxt), 'show ipv6 general-prefix：前綴與使用它的介面');
  ok(/GigabitEthernet0\/0\/0 is in client mode\n  Prefix State is OPEN/.test(dhTxt) && /Prefix name: ISP-PD/.test(dhTxt), 'show ipv6 dhcp interface：PD 的用戶端（Prefix State is OPEN）');
  // ISP 換了委派的前綴
  s.devices.inet.ifaces[0].line.v6.pd = '2001:db8:9c31:b500::/56'; settle(s);
  ok(fmtIp6(globalIp6(s.devices.pc1)).startsWith('2001:db8:9c31:b501:') && transact6(s, 'pc1', WEB, { quiet: true }).ok, 'ISP 換了前綴：LAN 的位址跟著換，照樣連得到');
}

console.log('\nNetFlow 與 QoS 的 police');
{
  const sim = await import('../src/engine/sim.js');
  const { iosSession, runningConfig } = await import('../src/engine/ios.js');
  const { iosRun } = await import('../src/ui/cli.js');
  const { nfTop, nfRows } = await import('../src/engine/netflow.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  const cli = (s, id) => { const S = iosSession(() => s.devices[id], () => s); return (...lines) => { const out = []; for (const l of lines) { const r = iosRun({ state: s, showTrace() {}, refreshLive() {} }, id, S, l, (x) => out.push(x)); if (r.changed) settle(s); } return out.join('\n'); }; };
  const lv = LEVELS.find((x) => x.id === 'l97');
  const s = lv.setup(); settle(s); sim.advance(s, 30);
  const sync = () => s.flows.find((f) => f.id === 'sync').rt.mbps;
  ok(sync() > 30 && !nfTop(s, s.devices.nms).length, `PC-3 的同步吃掉了大部分的專線（${sync()} Mbps），網管伺服器還沒有 NetFlow`);
  const B = cli(s, 'br');
  B('configure terminal', 'interface Gi0/0/1', 'ip flow ingress', 'exit', 'ip flow-export version 9', 'ip flow-export destination 10.10.0.50 2055', 'end');
  sim.advance(s, 30);
  const rows = nfRows(s, s.devices.br);
  ok(rows.length >= 2 && rows[0].src === parseIp('10.20.0.33') && /Gi0\/0\/1\s+10\.20\.0\.33\s+Gi0\/0\/0\s+10\.10\.0\.30\s+06 [0-9A-F]{4} 01BB/.test(B('show ip cache flow')), 'ip flow ingress：show ip cache flow 最大的一筆是 10.20.0.33 → 10.10.0.30:443（01BB）');
  const top = nfTop(s, s.devices.nms);
  ok(top.length && top[0].src === parseIp('10.20.0.33'), '匯出到網管伺服器（UDP 2055）：Top Talkers 第一名是 PC-3');
  B('configure terminal', 'ip access-list extended SYNC', 'permit ip host 10.20.0.33 any', 'exit', 'class-map match-all SYNC', 'match access-group name SYNC', 'exit',
    'policy-map LIMIT-SYNC', 'class SYNC', 'police cir 10000000', 'exit', 'exit', 'interface Gi0/0/1', 'service-policy input LIMIT-SYNC', 'end');
  sim.advance(s, 10);
  const f = s.flows.find((x) => x.id === 'sync');
  ok(f.rt.mbps > 9 && f.rt.mbps <= 10.01 && f.rt.policed && /police/.test(f.rt.where), `service-policy input 的 police cir 10000000：同步被限在 ${f.rt.mbps} Mbps`);
  // Flexible NetFlow
  const s2 = lv.setup(); settle(s2);
  const C = cli(s2, 'br');
  const out = C('configure terminal', 'flow exporter NMS', 'destination 10.10.0.50', 'transport udp 2055', 'exit', 'flow monitor WAN', 'record netflow ipv4 original-input', 'exporter NMS', 'exit', 'interface Gi0/0/1', 'ip flow monitor WAN input', 'end');
  sim.advance(s2, 30);
  ok(!/%/.test(out) && /10\.20\.0\.33\s+10\.10\.0\.30\s+\d+\s+443\s+Gi0\/0\/1/.test(C('show flow monitor WAN cache')) && nfTop(s2, s2.devices.nms).length, 'Flexible NetFlow：flow exporter + flow monitor + ip flow monitor WAN input，show flow monitor WAN cache、收集器都收得到');
  const rc = runningConfig(s2, s2.devices.br).join('\n');
  ok(/flow exporter NMS\n destination 10\.10\.0\.50\n transport udp 2055/.test(rc) && /flow monitor WAN\n exporter NMS\n record netflow ipv4 original-input/.test(rc) && / ip flow monitor WAN input/.test(rc), 'running-config：flow exporter、flow monitor、ip flow monitor … input');
  ok(/% Flow Monitor: NOPE does not exist/.test(C('configure terminal', 'interface Gi0/0/1', 'ip flow monitor NOPE input', 'end')), '介面上套用不存在的 flow monitor：IOS 拒絕');
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
