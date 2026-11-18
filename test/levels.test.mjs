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
