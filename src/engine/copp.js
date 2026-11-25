// CoPP（Control Plane Policing）：送給設備「自己」的封包（管理連線、ping、路由協定）在交給 CPU 之前先分類、限速
//
// 設定（IOS 的 MQC）：
//   d.copp = 政策名稱                         control-plane → service-policy input <名稱>
//   政策的 class：police { bps } | { pps, bps }（police rate <n> pps）、drop
//   class-map 用 ACL 分類（match access-group name <ACL>）；ACL 的協定可以寫 ospf、eigrp
// 攻擊：state.attacks 裡 cp: true 的項目是打設備自己位址的洪水：{ id, from, ip, kind: 'icmp' | 'udp' | 'syn', port, pps, cp: true, label }
// 結果：state.rt.copp[設備 id] = { cpu, hog, passed, rows: [{ cls, offered, passed, rate, drop }], ratio: { class: 通過的比例 }, floods: [{ id, label, pps, cls }] }
//
// 模型：每一筆洪水照 CoPP 的政策分到一個 class，police 只讓 rate 以內的量通過（不分好壞，照比例丟）。
// 通過的量加起來超過 CPU 處理得了的量（CP_CAPACITY）：CPU 忙不過來，管理連線與 ping 都排不到。
// 路由協定的封包在輸入佇列裡有優先權（SPD），CPU 滿載時鄰居還撐得住；但 CoPP 自己把它們 drop 掉的話鄰居就會斷。
import { fmtIp, parseIp } from './ip.js';
import { classify, policyOf } from './qos.js';

/** CPU 每秒處理得了幾個送給它自己的封包 */
export const CP_CAPACITY = 3000;
/** police 用 bps 寫的時候換算成封包數：一個封包當 100 bytes */
const PKT_BITS = 800;
const KIND_PROTO = { icmp: 'icmp', udp: 'udp', syn: 'tcp' };
const fmtN = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const coppPolicy = (d) => (d && d.copp ? policyOf(d, d.copp) : null);
/** class 的限速（每秒封包數）；沒有限速是 Infinity，drop 是 0 */
export const classRate = (c) => (!c ? Infinity : c.drop ? 0 : c.police ? (c.police.pps != null ? +c.police.pps : Math.floor(+c.police.bps / PKT_BITS)) : Infinity);
const classOf = (d, p) => { const pol = coppPolicy(d); return pol ? classify(d, pol, p) : null; };

/**
 * 算出每一台設備的控制平面狀況。probe(from, spec)：一次不留紀錄的 transact。
 * 回傳 { byDev, list }；list 是給攻擊示意用的（和 dos.js 的格式一樣）
 */
export function computeCopp(state, probe) {
  const byDev = {}, list = [];
  for (const a of state.attacks || []) {
    if (!a || !a.cp || a.on === false || !state.devices[a.from]) continue;
    const dst = parseIp(a.ip || ''), proto = KIND_PROTO[a.kind || 'icmp'] || 'icmp';
    if (dst == null) continue;
    const r = probe(a.from, { proto, dst, dport: a.port || 0, quiet: true, flood: true });
    const reqHops = (r.hops || []).filter((h) => h.cable && !h.reply && !h.wave);
    const e = { id: a.id, label: a.label || '', kind: a.kind || 'icmp', anomaly: '', ip: a.ip, port: a.port || 0, pps: +a.pps || 0, reach: !!r.ok, why: r.ok ? '' : r.reason || '', victim: null, cables: [...new Set(reqHops.map((h) => h.cable))], seen: [], stop: null, cp: true };
    if (!r.ok && r.failDev) { const n = reqHops.findIndex((h) => h.to === r.failDev); if (n >= 0) e.cables = [...new Set(reqHops.slice(0, n + 1).map((h) => h.cable))]; }
    list.push(e);
    const tgt = r.ok && r.responder ? state.devices[r.responder] : null;
    if (!tgt || !tgt.routing || tgt.kind === 'firewall' || tgt.kind === 'internet') continue;
    const srcIf = state.devices[a.from].ifaces.find((i) => i.rt && i.rt.ip != null);
    const c = classOf(tgt, { proto, src: srcIf ? srcIf.rt.ip : 0, dst, sport: 40000, dport: a.port || 0, dscp: 0 });
    const cp = (byDev[tgt.id] ||= { offered: {}, floods: [] });
    const cls = c ? c.cls : '';
    cp.offered[cls] = (cp.offered[cls] || 0) + e.pps;
    cp.floods.push({ id: a.id, label: e.label, pps: e.pps, cls, ip: a.ip, kind: e.kind });
    e.victim = tgt.id;
  }
  for (const [id, cp] of Object.entries(byDev)) {
    const d = state.devices[id], pol = coppPolicy(d) || [];
    cp.rows = []; cp.ratio = {}; cp.passed = 0;
    for (const [cls, offered] of Object.entries(cp.offered)) {
      const c = pol.find((x) => x.cls === cls) || null, rate = classRate(c), passed = Math.min(offered, rate);
      cp.rows.push({ cls, offered, passed, rate, drop: !!(c && c.drop) });
      cp.ratio[cls] = offered ? passed / offered : 1;
      cp.passed += passed;
    }
    cp.hog = cp.passed > CP_CAPACITY;
    cp.cpu = Math.min(99, 4 + Math.round((cp.passed / CP_CAPACITY) * 60));
  }
  return { byDev, list };
}

/**
 * 送給這台設備自己的封包（不是回應、不是洪水本身）會不會被控制平面擋下。回傳原因或 null。
 * 設定本身的 drop 隨時生效；洪水造成的（同一個 class 被擠掉、CPU 滿載）要等 state.rt.copp 算好
 */
export function cpWhy(state, dev, pkt) {
  if (!dev || !dev.routing || pkt.reply || pkt.flood || pkt.icmpErr || !['tcp', 'udp', 'icmp'].includes(pkt.proto)) return null;
  const cp = state.rt && state.rt.copp && state.rt.copp[dev.id];
  if (!dev.copp && !cp) return null;
  const c = classOf(dev, pkt), what = `${pkt.proto.toUpperCase()}${pkt.proto === 'icmp' ? '' : ' ' + pkt.dport}`;
  if (c && c.drop) return `${dev.name} 的 CoPP 把這個封包丟掉了：${what}（來源 ${fmtIp(pkt.src)}）被分到 class ${c.cls}，動作是 drop`;
  if (!cp) return null;
  const cls = c ? c.cls : '', row = cp.rows.find((r) => r.cls === cls);
  if (c && row && cp.ratio[cls] < 0.9) {
    return `${dev.name} 的 CoPP：${what}（來源 ${fmtIp(pkt.src)}）和洪水分在同一個 class ${cls}。這個 class 每秒進來 ${fmtN(row.offered)} 個封包、限速只放行 ${fmtN(row.rate)} 個，policer 不分好壞照比例丟（${Math.round((1 - cp.ratio[cls]) * 100)}% 被丟掉），正常的封包也過不去。把要保護的來源另外分一個 class`;
  }
  if (cp.hog) {
    const f = cp.floods.slice().sort((a, b) => b.pps - a.pps)[0];
    return `${dev.name} 的 CPU 忙不過來（${cp.cpu}%）：每秒 ${fmtN(cp.passed)} 個送給它自己的封包（${f.label || f.kind + ' flood'}，目的 ${f.ip}）全部交給 CPU 處理，${what} 排不到。${dev.copp ? `CoPP 的政策 ${dev.copp} 對這些封包的限速太寬（或沒有分到有限速的 class）` : 'control-plane 底下沒有 service-policy：送給設備自己的封包沒有任何限速'}`;
  }
  return null;
}

/** 路由協定的封包（proto：'ospf' / 'eigrp'）會不會被這台的 CoPP 丟掉。回傳原因或 '' */
export function coppRoutingWhy(d, proto, src, dst) {
  const c = classOf(d, { proto, src, dst, sport: 0, dport: 0, dscp: 48 });
  return c && c.drop ? `${d.name} 的 CoPP 把 ${proto.toUpperCase()} 的封包丟掉了（分到 class ${c.cls}，動作是 drop）：路由協定要有自己的 class，放在其他限速的前面` : '';
}

/** show policy-map control-plane */
export function coppLines(state, d) {
  const pol = coppPolicy(d);
  if (!d.copp) return ['（control-plane 底下沒有 service-policy：送給這台設備自己的封包沒有限速。control-plane → service-policy input <政策>）'];
  if (!pol) return [` Control Plane`, '', `  Service-policy input: ${d.copp}`, `（policy-map ${d.copp} 還沒有建立）`];
  const cp = (state.rt.copp || {})[d.id] || { rows: [] }, o = [' Control Plane', '', `  Service-policy input: ${d.copp}`, ''];
  for (const c of [...pol.filter((x) => x.cls !== 'class-default'), pol.find((x) => x.cls === 'class-default') || { cls: 'class-default' }]) {
    const cm = (d.classMaps || {})[c.cls], row = cp.rows.find((r) => r.cls === c.cls) || { offered: 0, passed: 0 };
    o.push(`    Class-map: ${c.cls} (${c.cls === 'class-default' ? 'match-any' : cm && cm.any ? 'match-any' : 'match-all'})`,
      `      ${fmtN(row.offered * 5)} packets, ${fmtN(row.offered * 5 * 100)} bytes`, `      5 minute offered rate ${fmtN(row.offered * PKT_BITS)} bps, drop rate ${fmtN((row.offered - row.passed) * PKT_BITS)} bps`,
      ...(c.cls === 'class-default' ? ['      Match: any '] : ((cm && cm.rules) || []).map((r) => `      Match: ${r.t === 'acl' ? 'access-group name ' + r.v : r.t === 'any' ? 'any' : r.t + ' ' + r.v}`)));
    if (c.drop) o.push('      drop');
    else if (c.police) {
      o.push(c.police.pps != null ? `      police:\n          rate ${c.police.pps} pps` : `      police:\n          cir ${c.police.bps} bps`,
        `        conformed ${fmtN(row.passed * 5)} packets; actions:\n          transmit `, `        exceeded ${fmtN((row.offered - row.passed) * 5)} packets; actions:\n          drop `,
        `        conformed ${fmtN(row.passed)} pps, exceeded ${fmtN(row.offered - row.passed)} pps`);
    }
    o.push('');
  }
  return o.join('\n').split('\n');
}

/** show processes cpu：前幾名的行程 */
export function cpuLines(state, d) {
  const cp = (state.rt.copp || {})[d.id], pct = cp ? cp.cpu : 2 + (d.id.length % 3), intr = cp ? Math.round(pct * 0.35) : 0;
  const top = cp && cp.passed > 200 ? cp.floods.slice().sort((a, b) => b.pps - a.pps)[0] : null;
  const rows = [[top ? Math.max(1, pct - intr - 2) : 0.2, top && top.kind === 'icmp' ? 'IP Input' : top && top.kind === 'syn' ? 'TCP Protocols' : 'IP Input'], [0.3, 'OSPF-1 Hello'], [0.1, 'SSH Process'], [0.1, 'Check heaps'], [0.0, 'ARP Input']];
  const o = [`CPU utilization for five seconds: ${pct}%/${intr}%; one minute: ${Math.max(1, pct - 2)}%; five minutes: ${Math.max(1, pct - 5)}%`,
    ' PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process ',
    ...rows.sort((a, b) => b[0] - a[0]).map(([p, name], k) => `${String(90 + k * 37).padStart(4)}${String(Math.round(p * 91000 + 400)).padStart(12)}${String(Math.round(p * 52000 + 900)).padStart(12)}${String(120 + k * 17).padStart(11)}${(p.toFixed(2) + '%').padStart(7)}${(Math.max(0, p - 0.4).toFixed(2) + '%').padStart(7)}${(Math.max(0, p - 0.9).toFixed(2) + '%').padStart(7)}   0 ${name}`)];
  if (cp && cp.hog) o.push(`（CPU 被送給這台自己的封包佔滿：每秒 ${fmtN(cp.passed)} 個，${top ? top.label || top.kind + ' flood' : ''}。show policy-map control-plane 看有沒有限速）`);
  return o;
}
