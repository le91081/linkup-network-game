// 自動驗證：每個關卡「初始狀態不會過關」且「套用參考解法後全部目標通過」
import { LEVELS } from '../src/levels/index.js';
import { recompute, evaluate, transact } from '../src/engine/sim.js';
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

// ── 接近現實的行為：ARP、Hub 泛洪、DHCP 四步驟、保留位址、IP 衝突、連線紀錄 ──
console.log('\n真實行為');
{
  const { dhcpTrace, sessionLog, hitsOf, arpRows } = await import('../src/engine/sim.js');
  const { makeState, makeDevice, linkInfo } = await import('../src/engine/model.js');
  const { link, setIp, ifc } = await import('../src/levels/util.js');
  const ok = (cond, title) => (cond ? console.log('  ✔ ' + title) : fail(title));
  {
    const { s } = solved('l01');
    recompute(s); // 清空剛才測試留下的 ARP 快取
    const ip = parseIp('192.168.1.20');
    const a = transact(s, 'pc-a', { proto: 'icmp', dst: ip });
    const b = transact(s, 'pc-a', { proto: 'icmp', dst: ip });
    ok(a.ok && a.hops.some((h) => h.wave) && a.log.some((l) => l.kind === 'arp'), '第一個封包會先送出 ARP 廣播');
    ok(b.ok && !b.hops.some((h) => h.wave) && !b.log.some((l) => l.kind === 'arp'), 'ARP 快取：第二個封包不再廣播');
    ok(arpRows(s, s.devices['pc-a']).some((r) => r.ip === ip) && arpRows(s, s.devices['pc-b']).length === 1, '兩端都記下了對方的 MAC');
    ok(a.log.some((l) => l.frame && l.frame.smac === s.devices['pc-a'].ifaces[0].rt.mac && l.frame.ttl === 64), '追蹤紀錄附上訊框標頭（MAC / IP / TTL）');
    recompute(s);
    ok(arpRows(s, s.devices['pc-a']).length === 0, '設定變更後 ARP 快取清空');
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
  // 不能用指令重現的部分：遮蔽的密碼、註解、自動產生的 description、VPN
  const keep = (l) => !/\*{8}/.test(l) && !/^ ?!/.test(l) && !/^ description /.test(l) && !/^crypto | encryption | hash | group \d| authentication pre-share/.test(l) && l !== '' && !/^Building/.test(l);

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
    ok(r.out.join().includes('Gi0/0/') && s.devices.hq.ifaces.some((i) => i.ospf), 'router ospf 的 network 會在符合的介面上啟用 OSPF');
    sess.exec('end');
    ok(sess.exec('show ip route').pass === true && sess.mode === 'exec', 'show 指令交給顯示層處理');
    s.down = { hq: true };
    recompute(s);
    const res = evaluate(s, LEVELS.find((l) => l.id === 'l10').objectives);
    ok(res.every((x) => !x.pass) && res.some((x) => /關機/.test(x.reason)), '設備關機後連線中斷，錯誤訊息指出是哪一台關機');
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
