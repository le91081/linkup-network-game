// RIP（router rip，RIPv1 / RIPv2）
//
// - network <網段>：一律是有類別的主網段（network 10.1.0.0 會變成 10.0.0.0），IP 落在裡面的介面都跑 RIP
// - 版本：沒有設 version 時送 v1、收 v1 和 v2；version 2 只送也只收 v2（version 1 同理）。介面上的 ip rip send / receive version 可以個別改
//   → 一邊 version 2、一邊沒設：沒設的那台收得到 v2，version 2 的那台把 v1 的更新丟掉（單向）
// - metric 是跳數：直連的網段送出去是 1，每經過一台加 1，16 代表到不了（最多 15 跳）
// - auto-summary（預設開著）：送到不同主網段的介面時，子網路合成有類別的網段 → 不連續的網段 (discontiguous) 會被合成同一筆、從兩個方向學到
// - RIPv1 不帶遮罩：同一個主網段只送和出去介面一樣遮罩的子網路，其他主網段一律送有類別的網段
// - split horizon：從某個介面學到的路不再從那個介面送回去（no ip split-horizon 關掉）
// - 驗證（只有 v2）：ip rip authentication key-chain <名稱> [mode md5]，兩邊的模式與金鑰要一樣
// - 計時：每 30 秒送一次更新；介面斷線馬上知道（triggered update）；隔著交換器、對方不見了要等 invalid（180 秒），
//   之後進入 holddown（possibly down，不接受同樣或更差的路），到 flush（240 秒）才清掉、改用別條路
// - 重分配：static / connected 預設 metric 1；ospf / eigrp 要給 metric（或 default-metric），不然是 16 送不出去
//
// d.rip = { ver, nets: [主網段], passive, passiveDefault, noPassive, auto (false = no auto-summary), defOrig, redist: [{ src, as, metric }], defMetric, maxPaths, timers: [更新, invalid, holddown, flush] }
// 介面：i.ripSend = [1, 2]、i.ripRecv = [1, 2]、i.ripAuth = { chain, md5 }、i.ripSum = [{ net, bits }]、i.ripNoSplit
// d.rt.rip = { ifs: { 介面: { send, recv, passive, why } }, srcs: [{ dev, iface, ip, ver, since, last, stale, hold }], db: { 'net/bits': {...} }, down: [...] }
import { fmtIp, netOf, parseIp } from './ip.js';
import { l2Explore } from './sim/l2.js';
import { vrfOf } from './sim/core.js';
import { classBitsOf } from './eigrp.js';

export const RIP_AD = 120, RIP_INF = 16;
export const ripOn = (d) => !!(d && d.rip);
export const ripTimers = (d) => { const t = (d.rip && d.rip.timers) || []; return { update: +t[0] || 30, invalid: +t[1] || 180, holddown: +t[2] || 180, flush: +t[3] || 240 }; };
const ipOf = (i) => (i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || ''));
/** 這個介面有沒有跑 RIP：IP 落在某一條 network（主網段）裡，只看全域的路由表 */
export function ripIf(d, i) {
  if (!ripOn(d) || vrfOf(i)) return false;
  const ip = ipOf(i);
  return ip != null && (d.rip.nets || []).some((n) => netOf(ip, classBitsOf(n)) === n);
}
export const ripPassive = (d, i) => (d.rip.passiveDefault ? !(d.rip.noPassive || []).includes(i.id) : (d.rip.passive || []).includes(i.id));
export const ripSendVers = (d, i) => (i.ripSend && i.ripSend.length ? i.ripSend : [+d.rip.ver || 1]);
export const ripRecvVers = (d, i) => (i.ripRecv && i.ripRecv.length ? i.ripRecv : d.rip.ver ? [+d.rip.ver] : [1, 2]);
export const ripAuto = (d) => d.rip.auto !== false;
const isLoop = (i) => i.bind && i.bind.t === 'loop';
const pfx = (net, bits) => net + '/' + bits;
const inside = (net, bits, s) => bits >= s.bits && netOf(net, s.bits) === s.net;
const major = (ip) => netOf(ip, classBitsOf(ip));

function authOf(d, i) {
  const a = i.ripAuth;
  if (!a || !a.chain) return null;
  const keys = ((d.keyChains || {})[a.chain] || []).filter((k) => k.str);
  const k = keys.slice().sort((x, y) => x.id - y.id)[0];
  return { md5: !!a.md5, chain: a.chain, id: k ? k.id : null, str: k ? k.str : null };
}
/** x 從 j 送到 d 的 i：收不收得到、用哪一版 */
function hear(d, i, x, j) {
  const send = ripSendVers(x, j), recv = ripRecvVers(d, i);
  const vs = send.filter((v) => recv.includes(v));
  if (!vs.length) return { why: `${x.name} 送的是 RIPv${send.join(' / v')}，${i.label} 只收 v${recv.join(' / v')}：更新被丟掉 (illegal version)`, ver: send[0], code: 'ver' };
  const ver = Math.max(...vs);
  if (netOf(ipOf(j), i.rt.bits) !== netOf(i.rt.ip, i.rt.bits)) return { why: `${x.name} 的 ${fmtIp(ipOf(j))} 不在 ${i.label} 的子網路上：更新被丟掉 (not from a valid subnet)`, ver, code: 'subnet' };
  const a = authOf(d, i), b = authOf(x, j);
  if (a || b) {
    if (ver === 1) return { why: `${a ? i.label : `${x.name} 的 ${j.label}`} 設了驗證，RIPv1 沒辦法帶驗證資料：更新被丟掉`, ver, code: 'auth' };
    if (!a || !b) return { why: `只有${a ? `這裡的 ${i.label}` : ` ${x.name} 的 ${j.label}`} 設了驗證：更新被丟掉 (invalid authentication)`, ver, code: 'auth' };
    if (a.md5 !== b.md5) return { why: `驗證模式不同（${a.md5 ? 'md5' : 'text'} 和 ${b.md5 ? 'md5' : 'text'}）：更新被丟掉 (invalid authentication)`, ver, code: 'auth' };
    if (a.str == null || b.str == null) return { why: `key chain「${(a.str == null ? a : b).chain}」沒有可用的金鑰 (key-string)`, ver, code: 'auth' };
    if (a.str !== b.str || (a.md5 && a.id !== b.id)) return { why: `驗證失敗：兩邊的金鑰不一樣${a.md5 && a.id !== b.id ? `（key ${a.id} 和 key ${b.id}）` : ''} (invalid authentication)`, ver, code: 'auth' };
  }
  return { ver };
}

/** 算所有設備的 RIP，放進路由表。在 OSPF、EIGRP 之後呼叫 */
export function computeRip(state, { ospfOn = () => false } = {}) {
  const now = state.clock, dyn = state.dyn, down = state.down || {};
  const srcT = (dyn.ripSrc ||= {});
  for (const d of Object.values(state.devices)) if (d.rt) delete d.rt.rip;
  const nodes = Object.values(state.devices).filter((d) => ripOn(d) && d.rt && !down[d.id] && !(state.rt.off || {})[d.id]);
  if (!nodes.length) { for (const k of Object.keys(srcT)) delete srcT[k]; return; }
  const isNode = new Set(nodes.map((d) => d.id));
  for (const d of nodes) d.rt.rip = { ifs: {}, srcs: [], db: {}, down: [] };
  const R = (d) => d.rt.rip;
  const running = (d, i) => !!i && !!i.rt && i.rt.link && i.rt.ip != null && ripIf(d, i);
  // 1. 誰聽得到誰（方向性的：x 從 j 送、d 在 i 收）
  const links = [], seen = new Set();
  for (const d of nodes) {
    for (const i of d.ifaces) {
      if (!running(d, i)) continue;
      R(d).ifs[i.id] = { send: ripSendVers(d, i), recv: ripRecvVers(d, i), passive: ripPassive(d, i), why: [], bad: [] };
    }
  }
  for (const d of nodes) {
    for (const i of d.ifaces) {
      const inf = R(d).ifs[i.id];
      if (!inf || isLoop(i)) continue;
      for (const e of l2Explore(state, d.id, i)) {
        const x = state.devices[e.dev], j = e.iface;
        if (!x || x === d || !isNode.has(x.id) || !running(x, j)) continue;
        if (ripPassive(x, j)) continue; // passive：不送更新（照樣收）
        const h = hear(d, i, x, j);
        if (h.why) { inf.why.push(`${x.name}：${h.why}`); inf.bad.push({ ip: ipOf(j), ver: h.ver, code: h.code }); continue; }
        const k = `${x.id}/${j.id}>${d.id}/${i.id}`;
        seen.add(k);
        links.push({ k, d, i, x, j, ver: h.ver });
      }
    }
  }
  // 2. 計時：聽得到的馬上更新；聽不到了（自己的介面還在）要等 invalid → holddown → flush
  const T = new Map(nodes.map((d) => [d.id, ripTimers(d)]));
  const live = [];
  for (const p of links) {
    const rec = (srcT[p.k] ||= { since: dyn.boot ? -1e9 : now });
    rec.last = now; rec.ver = p.ver;
    live.push({ ...p, rec, stale: false });
  }
  const held = new Map(nodes.map((d) => [d.id, new Map()])); // holddown 中的網段 → { metric: 原本的 metric, via, iface, left }
  for (const [k, rec] of Object.entries(srcT)) {
    if (seen.has(k)) continue;
    const cut = (s) => [s.slice(0, s.indexOf('/')), s.slice(s.indexOf('/') + 1)]; // 設備/介面（介面名稱裡也有 /）
    const [from, to] = k.split('>'), [xd, xj] = cut(from), [dd, di] = cut(to);
    const d = state.devices[dd], x = state.devices[xd];
    const i = d && d.ifaces.find((y) => y.id === di), j = x && x.ifaces.find((y) => y.id === xj);
    const t = T.get(dd);
    if (!d || !x || !j || !isNode.has(dd) || !running(d, i) || !t || now >= rec.last + t.flush) { delete srcT[k]; continue; }
    if (now < rec.last + t.invalid) {
      state.rt.pending.push({ at: rec.last + t.invalid, dev: d.id, kind: 'rip', text: `${d.name}：${x ? x.name : xd} 的 RIP 更新沒有再來，等 invalid timer（${t.invalid} 秒）到期才會標成 possibly down` });
      live.push({ k, d, i, x, j, ver: rec.ver, rec, stale: true, age: Math.floor(now - rec.last) });
      continue;
    }
    // holddown：這個來源報過的路先標 possibly down，到 flush 才清掉
    state.rt.pending.push({ at: rec.last + t.flush, dev: d.id, kind: 'rip', text: `${d.name}：RIP 的 holddown，等 flush timer（${t.flush} 秒）到期才會改走別條路` });
    for (const v of rec.snap || []) {
      const key = pfx(v.net, v.bits), m = held.get(d.id), o = m.get(key);
      if (!o || v.metric < o.metric) m.set(key, { net: v.net, bits: v.bits, metric: v.metric, via: ipOf(j), iface: i, left: Math.ceil(rec.last + t.flush - now) });
    }
  }
  // 3. 自己的網段：跑 RIP 的介面、重分配、預設路由
  const own = new Map();
  for (const d of nodes) {
    const m = new Map();
    for (const i of d.ifaces) {
      if (!running(d, i)) continue;
      const net = netOf(i.rt.ip, i.rt.bits);
      m.set(pfx(net, i.rt.bits), { net, bits: i.rt.bits, metric: 0, conn: true, iface: i });
    }
    for (const r of d.rip.redist || []) {
      const seed = r.metric != null ? +r.metric : r.src === 'static' || r.src === 'connected' ? 1 : d.rip.defMetric != null ? +d.rip.defMetric : RIP_INF;
      for (const x of d.rt.routes || []) {
        if (x.bad || (x.vrf || '') || x.bits === 0) continue;
        const ok = r.src === 'static' ? x.type === 'S' : r.src === 'connected' ? x.type === 'C' : r.src === 'ospf' ? x.type === 'O' || (x.type === 'C' && !!x.iface && ospfOn(d, x.iface)) : r.src === 'eigrp' ? x.type === 'E' : false;
        const key = pfx(x.net, x.bits);
        if (!ok || m.has(key)) continue;
        if (seed >= RIP_INF) continue; // 種子 metric 是 16：送不出去
        m.set(key, { net: x.net, bits: x.bits, metric: seed - 1, redist: r.src });
      }
    }
    if (d.rip.defOrig) m.set(pfx(0, 0), { net: 0, bits: 0, metric: 0, redist: 'default' });
    own.set(d.id, m);
  }
  // 4. 距離向量
  const table = new Map(nodes.map((d) => [d.id, new Map([...own.get(d.id)].map(([k, v]) => [k, { ...v, ifs: new Set() }]))]));
  const outOf = (x, j, ver) => {
    const jip = ipOf(j), jmaj = major(jip), auto = ver === 1 || ripAuto(x);
    const list = [];
    for (const v of table.get(x.id).values()) {
      if ((v.ifs.has(j.id) || (v.conn && v.iface === j)) && !j.ripNoSplit) continue; // split horizon（連同出去介面自己的網段）
      const m = v.metric + 1;
      if (m >= RIP_INF) continue;
      if (v.bits === 0) { list.push({ net: 0, bits: 0, metric: m }); continue; }
      if (auto && major(v.net) !== jmaj) {
        // 送到別的主網段：合成有類別的網段
        const cb = classBitsOf(v.net), net = netOf(v.net, cb);
        const o = list.find((y) => y.net === net && y.bits === cb);
        if (o) { o.metric = Math.min(o.metric, m); o.auto = true; } else list.push({ net, bits: cb, metric: m, auto: true });
        continue;
      }
      if (ver === 1 && v.bits !== j.rt.bits) continue; // v1 不帶遮罩：同一個主網段只送和這個介面一樣遮罩的子網路
      list.push({ net: v.net, bits: v.bits, metric: m });
    }
    const sums = ver === 2 ? (j.ripSum || []).filter((s) => list.some((v) => !(v.net === s.net && v.bits === s.bits) && inside(v.net, v.bits, s))) : [];
    if (!sums.length) return list;
    const out = list.filter((v) => !sums.some((s) => inside(v.net, v.bits, s)));
    for (const s of sums) out.push({ net: s.net, bits: s.bits, metric: Math.min(...list.filter((v) => inside(v.net, v.bits, s)).map((v) => v.metric)) });
    return out;
  };
  let cand = new Map();
  for (let round = 0; round < 40; round++) {
    cand = new Map(nodes.map((d) => [d.id, new Map()]));
    for (const p of live) {
      const src = p.stale ? p.rec.snap || [] : outOf(p.x, p.j, p.ver);
      const c = cand.get(p.d.id);
      for (const v of src) {
        const key = pfx(v.net, v.bits);
        (c.get(key) || c.set(key, []).get(key)).push({ net: v.net, bits: v.bits, metric: v.metric, via: ipOf(p.j), iface: p.i, from: p.x.id, stale: p.stale, age: p.stale ? p.age : Math.floor(now - p.rec.since) % T.get(p.d.id).update, auto: !!v.auto });
      }
    }
    let changed = false;
    for (const d of nodes) {
      const mine = own.get(d.id), max = Math.max(1, +d.rip.maxPaths || 4), hd = held.get(d.id);
      const next = new Map([...mine].map(([k, v]) => [k, { ...v, ifs: new Set() }]));
      for (const [key, list0] of cand.get(d.id)) {
        if (next.has(key)) continue;
        // holddown：不接受比原本更差的路（一樣好的本來就在路由表裡，照用）
        const list = hd.has(key) ? list0.filter((x) => x.metric <= hd.get(key).metric) : list0;
        if (!list.length) continue;
        const best = Math.min(...list.map((x) => x.metric));
        const use = list.filter((x) => x.metric === best).slice(0, max);
        next.set(key, { net: use[0].net, bits: use[0].bits, metric: best, ifs: new Set(use.map((x) => x.iface.id)), use });
      }
      const old = table.get(d.id);
      if (old.size !== next.size || [...next].some(([k, v]) => { const o = old.get(k); return !o || o.metric !== v.metric || [...v.ifs].join() !== [...o.ifs].join(); })) changed = true;
      table.set(d.id, next);
    }
    if (!changed) break;
  }
  // debug ip rip：每個介面送出去的更新
  for (const d of nodes) for (const i of d.ifaces) { const f = R(d).ifs[i.id]; if (f && !f.passive && !isLoop(i)) f.sent = f.send.map((v) => ({ ver: v, list: outOf(d, i, v) })); }
  // 記下每個來源最後送來的更新：之後聽不到了、還沒過 invalid 的時候用
  for (const p of live) if (!p.stale) p.rec.snap = outOf(p.x, p.j, p.ver).map((v) => ({ net: v.net, bits: v.bits, metric: v.metric }));
  // 5. 資料庫、來源與路由表
  for (const d of nodes) {
    const r = R(d);
    for (const [key, h] of held.get(d.id)) if (!table.get(d.id).has(key)) r.down.push(h); // possibly down：holddown 中、沒有別條路
    for (const p of live) if (p.d === d) r.srcs.push({ dev: p.x.id, iface: p.i.id, ip: ipOf(p.j), ver: p.ver, since: p.rec.since, last: p.rec.last, stale: p.stale, age: p.stale ? p.age : Math.floor(now - p.rec.since) % T.get(d.id).update });
    for (const [key, v] of table.get(d.id)) {
      r.db[key] = { net: v.net, bits: v.bits, metric: v.metric, conn: !!v.conn, redist: v.redist, iface: v.iface, use: v.use || [] };
      if (!v.use) continue;
      if ((d.rt.routes || []).some((x) => x.type === 'C' && x.net === v.net && x.bits === v.bits)) continue;
      for (const x of v.use) d.rt.routes.push({ net: x.net, bits: x.bits, via: x.via, iface: x.iface, type: 'R', ad: RIP_AD, metric: v.metric, ripAge: x.age, ...(x.stale ? { staleNbr: true } : {}) });
    }
    // auto-summary：自己送出去的有類別網段也列在資料庫裡
    if (ripAuto(d)) {
      for (const i of d.ifaces) {
        if (!running(d, i)) continue;
        for (const v of table.get(d.id).values()) {
          if (!v.bits || major(v.net) === major(i.rt.ip)) continue;
          const cb = classBitsOf(v.net), key = pfx(netOf(v.net, cb), cb);
          if (!r.db[key]) r.db[key] = { net: netOf(v.net, cb), bits: cb, metric: 0, summary: true, use: [] };
        }
      }
    }
  }
}

/** show ip rip database */
export function ripDbLines(state, d, longIf, hms) {
  const r = d.rt && d.rt.rip;
  if (!r) return ['% RIP 沒有在這台設備上執行（router rip）'];
  const o = [];
  const rows = Object.values(r.db).sort((a, b) => (a.net >>> 0) - (b.net >>> 0) || a.bits - b.bits);
  for (const v of rows) {
    const head = `${fmtIp(v.net)}/${v.bits}`;
    if (v.summary) { o.push(`${head}    auto-summary`); continue; }
    if (v.conn) { o.push(`${head}    directly connected, ${longIf(v.iface.label)}`); continue; }
    if (v.redist) { o.push(`${head}    redistributed`, `    [${v.metric + 1}] via 0.0.0.0,`); continue; }
    o.push(head);
    for (const x of v.use) o.push(`    [${v.metric}] via ${fmtIp(x.via)}, ${hms(x.age)}, ${longIf(x.iface.label)}`);
  }
  for (const x of r.down) o.push(`${fmtIp(x.net)}/${x.bits}    is possibly down`);
  return o.length ? o : ['（資料庫是空的）'];
}

/** show ip protocols 的 RIP 段落 */
export function ripProtoLines(state, d, longIf, hms) {
  const r = d.rt && d.rt.rip, c = d.rip;
  if (!r || !c) return [];
  const t = ripTimers(d);
  const due = t.update - (Math.floor(state.clock) % t.update);
  const red = (c.redist || []).map((x) => x.src + (x.as != null ? ' ' + x.as : ''));
  const verTxt = c.ver ? `send version ${c.ver}, receive version ${c.ver}` : 'send version 1, receive any version';
  const ifs = d.ifaces.filter((i) => r.ifs[i.id] && !r.ifs[i.id].passive);
  const pas = d.ifaces.filter((i) => r.ifs[i.id] && r.ifs[i.id].passive);
  return ['Routing Protocol is "rip"', '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set',
    `  Sending updates every ${t.update} seconds, next due in ${due} seconds`, `  Invalid after ${t.invalid} seconds, hold down ${t.holddown}, flushed after ${t.flush}`,
    `  Redistributing: ${['rip', ...red].join(', ')}`, `  Default version control: ${verTxt}`,
    '    Interface             Send  Recv  Triggered RIP  Key-chain',
    ...ifs.map((i) => { const f = r.ifs[i.id]; return `    ${longIf(i.label).padEnd(22)}${f.send.join(' ').padEnd(6)}${f.recv.join(' ').padEnd(6)}      No        ${(i.ripAuth && i.ripAuth.chain) || ''}`; }),
    `  Automatic network summarization is ${ripAuto(d) ? '' : 'not '}in effect`, `  Maximum path: ${+c.maxPaths || 4}`, '  Routing for Networks:',
    ...(c.nets || []).slice().sort((a, b) => (a >>> 0) - (b >>> 0)).map((n) => `    ${fmtIp(n)}`),
    ...(pas.length ? ['  Passive Interface(s):', ...pas.map((i) => '    ' + longIf(i.label))] : []),
    '  Routing Information Sources:', '    Gateway         Distance      Last Update',
    ...r.srcs.map((s) => `    ${fmtIp(s.ip).padEnd(16)}${String(RIP_AD).padStart(8)}      ${hms(s.age)}`),
    `  Distance: (default is ${RIP_AD})`];
}
