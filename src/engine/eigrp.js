// EIGRP（傳統模式：router eigrp <AS>）
//
// - network <網段> <萬用遮罩>：IP 落在範圍內的介面跑 EIGRP（送 Hello、宣告它的網段）
// - 鄰居：同一個 AS、K 值一樣、在同一個子網路、驗證一致（MD5 + key chain）。Hello / Hold 時間不一樣沒關係（和 OSPF 不同）
// - 鄰居不見了：介面斷線馬上知道；隔著交換器的話要等 Hold time（預設 15 秒）到期，這段時間封包被丟進黑洞
// - metric（K1 = K3 = 1）：256 ×（10⁷ ÷ 路徑上最小的頻寬 kbps ＋ 延遲總和 µs ÷ 10）
// - DUAL：FD 最小的是 successor；報告距離 (RD) 比 FD 小的鄰居是 feasible successor（不會造成迴圈的備援）
// - variance n：FD 不超過最佳 n 倍的 feasible successor 也放進路由表（不等價負載分擔）
// - split horizon：從某個介面學到的路不再從那個介面送回去（DMVPN 的 hub 要 no ip split-horizon eigrp）
// - ip summary-address eigrp：從那個介面送出去時，範圍內的網段合成一筆彙總
// - redistribute static / connected / ospf：外部路由 (D EX，AD 170)；static 與 ospf 要給 metric（或 default-metric）
//
// d.eigrp = { as, nets: [{ net, bits }], passive: [介面], passiveDefault, noPassive: [介面], rid, variance, maxPaths, k: [K1..K5], redist: [{ src, metric }], defMetric }
// 介面：i.eigrpHello、i.eigrpHold、i.eigrpAuth = { md5, chain }、i.eigrpDelay（十微秒）、i.eigrpSum = [{ net, bits }]、i.eigrpNoSplit
// d.keyChains = { 名稱: [{ id, str }] }
// d.rt.eigrp = { as, rid, ifs: { 介面: { peers, passive, hello, hold, why: [] } }, nbrs: [...], topo: { 'net/bits': {...} } }
import { fmtIp, netOf, parseIp } from './ip.js';
import { l2Explore } from './sim/l2.js';
import { vrfOf } from './sim/core.js';
import { linkInfo } from './model.js';

export const EIGRP_AD = 90, EIGRP_EX_AD = 170;
export const K_DEFAULT = [1, 0, 1, 0, 0];
export const eigrpOn = (d) => !!(d && d.eigrp && +d.eigrp.as > 0);
/** network 敘述沒寫萬用遮罩：用有類別的網段（A 類 /8、B 類 /16、C 類 /24） */
export const classBitsOf = (ip) => (ip == null ? null : (ip >>> 24) < 128 ? 8 : (ip >>> 24) < 192 ? 16 : 24);
const isLoop = (i) => i.bind && i.bind.t === 'loop';
const isGre = (i) => i.bind && i.bind.t === 'gre';

/** 這個介面有沒有跑 EIGRP：IP 落在某一條 network 敘述裡（這個模擬的 EIGRP 只在全域的路由表） */
export function eigrpIf(d, i) {
  if (!eigrpOn(d) || vrfOf(i) || !i.rt || i.rt.ip == null) return false;
  return (d.eigrp.nets || []).some((n) => netOf(i.rt.ip, n.bits) === n.net);
}
export const eigrpPassive = (d, i) => (d.eigrp.passiveDefault ? !(d.eigrp.noPassive || []).includes(i.id) : (d.eigrp.passive || []).includes(i.id));
export const eigrpHello = (i) => +i.eigrpHello || 5;
export const eigrpHold = (i) => +i.eigrpHold || 3 * eigrpHello(i);
export const eigrpK = (d) => (Array.isArray(d.eigrp.k) && d.eigrp.k.length === 5 ? d.eigrp.k.map(Number) : K_DEFAULT);

/** 介面的頻寬 (kbps)：bandwidth 指令優先，不然看協商出來的速率 */
export function eigrpBw(state, d, i) {
  if (+i.bandwidth > 0) return +i.bandwidth;
  if (isLoop(i)) return 8000000;
  if (isGre(i)) return 100;
  const li = (i.bind.t === 'port' || i.bind.t === 'sub') && linkInfo(state, d.id, i.bind.port);
  return li && li.speed ? li.speed * 1000 : 1000000;
}
/** 介面的延遲 (µs)：delay 指令（單位是十微秒）優先，不然依介面的種類與速率 */
export function eigrpDly(state, d, i) {
  if (+i.eigrpDelay > 0) return +i.eigrpDelay * 10;
  if (isLoop(i)) return 5000;
  if (isGre(i)) return 50000;
  // 預設的延遲看介面的種類（實際的速率），bandwidth 指令不會改到它
  const li = (i.bind.t === 'port' || i.bind.t === 'sub') && linkInfo(state, d.id, i.bind.port);
  const mbps = li && li.speed ? li.speed : 1000;
  return mbps >= 1000 ? 10 : mbps >= 100 ? 100 : 1000;
}
/** 合成的 metric（負載 1/255、可靠度 255） */
export function eigrpMetric(bw, dly, k = K_DEFAULT) {
  const B = Math.floor(1e7 / Math.max(1, bw)), D = Math.floor(dly / 10);
  let m = k[0] * B + Math.floor((k[1] * B) / (256 - 1)) + k[2] * D;
  if (k[4]) m = Math.floor(m * (k[4] / (255 + k[3])));
  return 256 * m;
}

function ridOf(d) {
  if (d.eigrp.rid) { const r = parseIp(d.eigrp.rid); if (r != null) return r; }
  const ips = (pick) => d.ifaces.filter((i) => pick(i) && i.rt && i.rt.ip != null && !vrfOf(i)).map((i) => i.rt.ip >>> 0);
  const lo = ips((i) => isLoop(i)), all = ips((i) => i.rt.link);
  const best = (a) => (a.length ? a.reduce((x, y) => (y > x ? y : x)) : null);
  return best(lo) ?? best(all);
}
/** 介面上的 MD5 金鑰（key chain 裡第一把有 key-string 的） */
function authKey(d, i) {
  const a = i.eigrpAuth;
  // ip authentication mode eigrp <AS> md5：AS 寫錯（不是這台跑的那一個）等於沒設
  if (!a || !a.md5 || (a.as && +a.as !== +d.eigrp.as)) return null;
  const keys = ((d.keyChains || {})[a.chain] || []).filter((k) => k.str);
  if (!keys.length) return { id: null, str: null, chain: a.chain };
  const k = keys.slice().sort((x, y) => x.id - y.id)[0];
  return { id: k.id, str: k.str, chain: a.chain };
}
function authWhy(d, i, x, j) {
  const a = authKey(d, i), b = authKey(x, j);
  if (!a && !b) return '';
  if (!a || !b) return `只有 ${(a ? d : x).name} 的 ${(a ? i : j).label} 設了 MD5 驗證：另一邊的 Hello 沒有驗證資料，被丟掉 (authentication failure)`;
  if (a.str == null || b.str == null) return `${(a.str == null ? d : x).name} 的 key chain「${(a.str == null ? a : b).chain}」沒有可用的金鑰 (key-string)`;
  if (a.id !== b.id || a.str !== b.str) return `MD5 驗證失敗：兩邊的金鑰不一樣（key ${a.id} 和 key ${b.id}${a.id === b.id ? '，key-string 不同' : ''}）`;
  return '';
}
const pfx = (net, bits) => net + '/' + bits;
const inside = (net, bits, s) => bits >= s.bits && netOf(net, s.bits) === s.net;

/** 算所有設備的 EIGRP：鄰居、拓撲表、放進路由表 (d.rt.routes) 的路。在 OSPF 之後呼叫 */
export function computeEigrp(state, { log = () => {}, ospfOn = () => false } = {}) {
  const now = state.clock, dyn = state.dyn, down = state.down || {};
  const adjT = (dyn.eigrpAdj ||= {});
  for (const d of Object.values(state.devices)) if (d.rt) delete d.rt.eigrp;
  const nodes = Object.values(state.devices).filter((d) => eigrpOn(d) && d.rt && !down[d.id] && !(state.rt.off || {})[d.id]);
  if (!nodes.length) { for (const k of Object.keys(adjT)) delete adjT[k]; return; }
  const isNode = new Set(nodes.map((d) => d.id));
  for (const d of nodes) d.rt.eigrp = { as: +d.eigrp.as, rid: ridOf(d), ifs: {}, nbrs: [], topo: {} };
  const E = (d) => d.rt.eigrp;
  const running = (d, i) => !!i && i.rt.link && eigrpIf(d, i);
  // 1. 鄰居
  const edges = [], seen = new Set();
  for (const d of nodes) {
    for (const i of d.ifaces) {
      if (!running(d, i)) continue;
      const inf = (E(d).ifs[i.id] = { peers: 0, passive: eigrpPassive(d, i), hello: eigrpHello(i), hold: eigrpHold(i), why: [] });
      if (inf.passive || isLoop(i)) continue;
      for (const e of l2Explore(state, d.id, i)) {
        const x = state.devices[e.dev], j = e.iface;
        if (!x || x === d || !isNode.has(x.id) || !running(x, j)) continue;
        if (eigrpPassive(x, j)) { inf.why.push(`${x.name} 的 ${j.label} 是 passive-interface：不送也不收 Hello`); continue; }
        const why = +x.eigrp.as !== +d.eigrp.as ? `${x.name} 跑的是 AS ${x.eigrp.as}、這裡是 AS ${d.eigrp.as}：EIGRP 只和同一個 AS 的路由器建立鄰居`
          : eigrpK(x).join() !== eigrpK(d).join() ? `K 值不同（${eigrpK(d).join(' ')} 和 ${eigrpK(x).join(' ')}）：K-value mismatch`
            : netOf(j.rt.ip, i.rt.bits) !== netOf(i.rt.ip, i.rt.bits) || netOf(i.rt.ip, j.rt.bits) !== netOf(j.rt.ip, j.rt.bits) ? `${x.name} 的 ${fmtIp(j.rt.ip)} 不在 ${i.label} 的子網路上 (not on common subnet)`
              : authWhy(d, i, x, j);
        if (why) { inf.why.push(`${x.name}：${why}`); continue; }
        const k = [d.id + '/' + i.id, x.id + '/' + j.id].sort().join('~');
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ k, a: { d, i }, b: { d: x, i: j } });
      }
    }
  }
  // 2. 計時：新的鄰居馬上建立；不見的鄰居（介面還在）要等 Hold time 到期才拆
  const live = [];
  for (const p of edges) {
    let rec = adjT[p.k];
    if (!rec) {
      rec = adjT[p.k] = { since: dyn.boot ? -1e9 : now, a: [p.a.d.id, p.a.i.id], b: [p.b.d.id, p.b.i.id] };
      for (const [s, o] of [[p.a, p.b], [p.b, p.a]]) log(s.d, `EIGRP-IPv4 ${s.d.eigrp.as}: Neighbor ${fmtIp(o.i.rt.ip)} (${s.i.label}) is up: new adjacency`);
    }
    rec.last = now;
    live.push({ ...p, stale: false, rec });
  }
  for (const [k, rec] of Object.entries(adjT)) {
    if (seen.has(k)) continue;
    const [ad, ai] = rec.a, [bd, bi] = rec.b;
    const A = state.devices[ad], B = state.devices[bd];
    const ia = A && A.ifaces.find((x) => x.id === ai), ib = B && B.ifaces.find((x) => x.id === bi);
    // 兩邊各自的看法：介面還亮著的那一邊要等對方的 Hold time；介面斷了、設備關了的那一邊馬上拆
    const keepA = A && isNode.has(ad) && running(A, ia) && ib && rec.last + eigrpHold(ib) > now;
    const keepB = B && isNode.has(bd) && running(B, ib) && ia && rec.last + eigrpHold(ia) > now;
    if (!keepA && !keepB) {
      delete adjT[k];
      for (const [S, si, , oi] of [[A, ia, B, ib], [B, ib, A, ia]]) if (S && isNode.has(S.id) && si && oi) log(S, `EIGRP-IPv4 ${S.eigrp.as}: Neighbor ${fmtIp(oi.rt && oi.rt.ip != null ? oi.rt.ip : parseIp(oi.ip || '') || 0)} (${si.label}) is down: ${running(S, si) ? 'holding time expired' : 'interface down'}`);
      continue;
    }
    // 還在 Hold time 裡：只有還沒發現的那一邊保留這個鄰居（路還指向它）
    for (const [keep, S, si, O, oi] of [[keepA, A, ia, B, ib], [keepB, B, ib, A, ia]]) {
      if (!keep) continue;
      const at = rec.last + eigrpHold(oi);
      state.rt.pending.push({ at, dev: S.id, kind: 'eigrp', text: `${S.name}：EIGRP 鄰居 ${O.name} 沒有回應，等 Hold time（${eigrpHold(oi)} 秒）到期才會拆掉` });
      live.push({ k, a: { d: S, i: si }, b: { d: O, i: oi }, stale: true, oneSide: true, rec, holdLeft: Math.ceil(at - now) });
    }
  }
  // 鄰居表
  const nbrsOf = new Map(nodes.map((d) => [d.id, []]));
  for (const p of live) {
    for (const [s, o] of p.oneSide ? [[p.a, p.b]] : [[p.a, p.b], [p.b, p.a]]) {
      const n = { dev: o.d.id, iface: s.i.id, ip: o.i.rt.ip ?? parseIp(o.i.ip || ''), hold: p.stale ? p.holdLeft : eigrpHold(o.i), since: p.rec.since, stale: p.stale };
      nbrsOf.get(s.d.id).push({ ...n, peer: o });
      E(s.d).ifs[s.i.id].peers++;
    }
  }
  for (const d of nodes) E(d).nbrs = nbrsOf.get(d.id).map(({ peer, ...n }) => n);

  // 3. 每台自己的網段：跑 EIGRP 的介面（含 passive、Loopback）與重分配進來的外部路由
  const own = new Map();
  for (const d of nodes) {
    const m = new Map();
    for (const i of d.ifaces) {
      if (!running(d, i)) continue;
      const net = netOf(i.rt.ip, i.rt.bits);
      m.set(pfx(net, i.rt.bits), { net, bits: i.rt.bits, bw: eigrpBw(state, d, i), dly: eigrpDly(state, d, i), ex: false, conn: true, iface: i });
    }
    for (const r of d.eigrp.redist || []) {
      const met = r.metric || d.eigrp.defMetric;
      const srcRoutes = (d.rt.routes || []).filter((x) => !x.bad && !(x.vrf || '') && (r.src === 'static' ? x.type === 'S' : r.src === 'connected' ? x.type === 'C' : r.src === 'ospf' ? x.type === 'O' || (x.type === 'C' && !!x.iface && ospfOn(d, x.iface)) : false)); // ospf：連同跑 OSPF 的直連網段
      for (const x of srcRoutes) {
        const key = pfx(x.net, x.bits);
        if (m.has(key)) continue;
        if (r.src === 'connected') { m.set(key, { net: x.net, bits: x.bits, bw: eigrpBw(state, d, x.iface), dly: eigrpDly(state, d, x.iface), ex: true, conn: false, redist: 'connected' }); continue; }
        if (!met) continue; // 沒有種子 metric：static / ospf 不會被宣告出去
        m.set(key, { net: x.net, bits: x.bits, bw: +met[0], dly: +met[1] * 10, ex: true, conn: false, redist: r.src });
      }
    }
    own.set(d.id, m);
  }
  // 4. 距離向量：反覆交換，直到沒有變化（DUAL 的結果和最後收斂的值一樣）
  const adv = new Map(nodes.map((d) => [d.id, new Map([...own.get(d.id)].map(([k, v]) => [k, { ...v, fd: eigrpMetric(v.bw, v.dly, eigrpK(d)), succIfs: new Set() }]))]));
  const outOf = (x, j) => {
    // x 從 j 送出去的更新：split horizon、彙總
    const list = [];
    for (const v of adv.get(x.id).values()) {
      if (v.succIfs.has(j.id) && !j.eigrpNoSplit) continue;
      list.push(v);
    }
    const sums = (j.eigrpSum || []).filter((s) => list.some((v) => !(v.net === s.net && v.bits === s.bits) && inside(v.net, v.bits, s)));
    if (!sums.length) return list;
    const out = list.filter((v) => !sums.some((s) => inside(v.net, v.bits, s)));
    for (const s of sums) {
      const comps = list.filter((v) => inside(v.net, v.bits, s));
      const best = comps.reduce((a, b) => (b.fd < a.fd ? b : a));
      out.push({ net: s.net, bits: s.bits, bw: best.bw, dly: best.dly, fd: best.fd, ex: comps.every((c) => c.ex), summary: true, succIfs: new Set() });
    }
    return out;
  };
  let cand = new Map();
  for (let round = 0; round < 64; round++) {
    cand = new Map();
    for (const d of nodes) {
      const c = new Map();
      for (const p of live) {
        const sides = p.oneSide ? [[p.a, p.b]] : [[p.a, p.b], [p.b, p.a]];
        for (const [s, o] of sides) {
          if (s.d !== d) continue;
          // 還在 Hold time 裡的鄰居：用它最後一次送來的更新（它可能已經關機了）
          const src = p.stale ? ((p.rec.snap || {})[o.d.id + '/' + o.i.id] || []) : outOf(o.d, o.i);
          for (const v of src) {
            const bw = Math.min(v.bw, eigrpBw(state, d, s.i)), dly = v.dly + eigrpDly(state, d, s.i);
            const key = pfx(v.net, v.bits);
            (c.get(key) || c.set(key, []).get(key)).push({ net: v.net, bits: v.bits, bw, dly, fd: eigrpMetric(bw, dly, eigrpK(d)), rd: v.fd, ex: v.ex, via: o.i.rt.ip ?? parseIp(o.i.ip || ''), iface: s.i, from: o.d.id, stale: p.stale, summary: !!v.summary });
          }
        }
      }
      cand.set(d.id, c);
    }
    let changed = false;
    for (const d of nodes) {
      const next = new Map([...own.get(d.id)].map(([k, v]) => [k, { ...v, fd: eigrpMetric(v.bw, v.dly, eigrpK(d)), succIfs: new Set() }]));
      for (const [key, list] of cand.get(d.id)) {
        if (next.has(key)) continue; // 自己就有（直連或重分配）
        const best = list.reduce((a, b) => (b.fd < a.fd ? b : a));
        next.set(key, { net: best.net, bits: best.bits, bw: best.bw, dly: best.dly, fd: best.fd, ex: best.ex, succIfs: new Set(list.filter((x) => x.fd === best.fd).map((x) => x.iface.id)) });
      }
      const old = adv.get(d.id);
      if (old.size !== next.size || [...next].some(([k, v]) => { const o = old.get(k); return !o || o.fd !== v.fd || [...v.succIfs].join() !== [...o.succIfs].join(); })) changed = true;
      adv.set(d.id, next);
    }
    if (!changed) break;
  }
  // 記下每個鄰居最後送來的更新：之後它不見了、還在 Hold time 裡的時候用
  const plain = (v) => ({ net: v.net, bits: v.bits, bw: v.bw, dly: v.dly, fd: v.fd, ex: !!v.ex, ...(v.summary ? { summary: true } : {}) });
  for (const p of live) if (!p.stale) p.rec.snap = { [p.a.d.id + '/' + p.a.i.id]: outOf(p.a.d, p.a.i).map(plain), [p.b.d.id + '/' + p.b.i.id]: outOf(p.b.d, p.b.i).map(plain) };
  // 5. 拓撲表與路由表
  for (const d of nodes) {
    const e = E(d), mine = own.get(d.id), c = cand.get(d.id) || new Map();
    const variance = Math.max(1, +d.eigrp.variance || 1), maxPaths = Math.max(1, +d.eigrp.maxPaths || 4);
    for (const [key, v] of mine) e.topo[key] = { net: v.net, bits: v.bits, fd: eigrpMetric(v.bw, v.dly, eigrpK(d)), conn: v.conn, ex: v.ex, redist: v.redist, iface: v.iface, succ: [], fs: [], all: [] };
    for (const [key, list] of c) {
      if (mine.has(key)) continue;
      const best = Math.min(...list.map((x) => x.fd));
      const succ = list.filter((x) => x.fd === best), fs = list.filter((x) => x.fd !== best && x.rd < best);
      e.topo[key] = { net: list[0].net, bits: list[0].bits, fd: best, ex: succ[0].ex, summary: succ[0].summary, succ, fs, all: list };
      // 路由表：successor（等價的最多 maxPaths 條）；variance > 1 時，FD 不超過最佳 n 倍的 feasible successor 也放進去
      const use = [...succ, ...fs.filter((x) => x.fd <= variance * best).sort((a, b) => a.fd - b.fd)].slice(0, maxPaths);
      const conn = (d.rt.routes || []).some((r) => r.type === 'C' && r.net === list[0].net && r.bits === list[0].bits);
      if (conn) continue;
      for (const x of use) d.rt.routes.push({ net: x.net, bits: x.bits, via: x.via, iface: x.iface, type: 'E', ...(x.ex ? { sub: 'EX' } : {}), ad: x.ex ? EIGRP_EX_AD : EIGRP_AD, metric: best, real: x.fd, ...(x.stale ? { staleNbr: true } : {}) });
    }
  }
}

/** show ip eigrp neighbors */
export function eigrpNeighborLines(state, d, longIf, hms) {
  const e = d.rt && d.rt.eigrp;
  if (!e) return ['% EIGRP 沒有在這台設備上執行（router eigrp <AS>）'];
  const o = [`EIGRP-IPv4 Neighbors for AS(${e.as})`, 'H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq', '                                                   (sec)         (ms)       Cnt Num'];
  e.nbrs.forEach((n, k) => {
    const i = d.ifaces.find((x) => x.id === n.iface);
    // Hold 從上一個 Hello 開始倒數：每 hello 秒收到一個就補滿
    const hel = Math.max(1, Math.round(n.hold / 3)), hold = n.stale ? n.hold : n.hold - (Math.max(0, Math.floor(state.clock - n.since)) % hel);
    o.push(`${String(k).padEnd(4)}${fmtIp(n.ip).padEnd(24)}${(i ? i.label : n.iface).padEnd(23)}${String(hold).padStart(4)} ${hms(Math.max(0, state.clock - n.since)).padEnd(9)}${String(n.stale ? 0 : 1).padStart(4)}  ${n.stale ? 5000 : 100}  0  ${12 + k}`);
  });
  if (!e.nbrs.length) {
    const why = Object.entries(e.ifs).flatMap(([id, f]) => f.why.map((w) => `${(d.ifaces.find((x) => x.id === id) || {}).label || id}：${w}`));
    o.push(why.length ? `（沒有鄰居。${why.join('；')}）` : '（沒有鄰居：跑 EIGRP 的介面上聽不到同一個 AS 的 Hello）');
  }
  return o;
}

/** show ip eigrp topology [all-links] */
export function eigrpTopoLines(state, d, longIf, all = false) {
  const e = d.rt && d.rt.eigrp;
  if (!e) return ['% EIGRP 沒有在這台設備上執行（router eigrp <AS>）'];
  const o = [`EIGRP-IPv4 Topology Table for AS(${e.as})/ID(${e.rid != null ? fmtIp(e.rid) : '0.0.0.0'})`, 'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,', '       r - reply Status, s - sia Status ', ''];
  const rows = Object.values(e.topo).sort((a, b) => (a.net >>> 0) - (b.net >>> 0) || a.bits - b.bits);
  for (const t of rows) {
    o.push(`P ${fmtIp(t.net)}/${t.bits}, ${t.conn || t.redist ? 1 : t.succ.length} successors, FD is ${t.fd}${t.ex ? ', tag is 0' : ''}`);
    if (t.conn) { o.push(`        via Connected, ${longIf(t.iface.label)}`); continue; }
    if (t.redist) { o.push(`        via Redistributed (${t.fd}/0)`); continue; }
    const list = all ? t.all.slice().sort((a, b) => a.fd - b.fd) : [...t.succ, ...t.fs];
    for (const x of list) o.push(`        via ${fmtIp(x.via)} (${x.fd}/${x.rd}), ${longIf(x.iface.label)}`);
  }
  return o;
}

/** show ip eigrp interfaces */
export function eigrpIfLines(state, d, longIf) {
  const e = d.rt && d.rt.eigrp;
  if (!e) return ['% EIGRP 沒有在這台設備上執行（router eigrp <AS>）'];
  const o = [`EIGRP-IPv4 Interfaces for AS(${e.as})`, '                              Xmit Queue   PeerQ        Mean   Pacing Time   Multicast    Pending', 'Interface              Peers  Un/Reliable  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes'];
  for (const [id, f] of Object.entries(e.ifs)) {
    if (f.passive) continue;
    const i = d.ifaces.find((x) => x.id === id);
    o.push(`${(i ? i.label : id).padEnd(23)}${String(f.peers).padStart(5)}        0/0       0/0           1       0/0           50           0`);
  }
  return o;
}

/** show ip protocols 的 EIGRP 段落 */
export function eigrpProtoLines(state, d, longIf, hms) {
  const e = d.rt && d.rt.eigrp, c = d.eigrp;
  if (!e || !c) return [];
  const k = eigrpK(d), red = (c.redist || []).map((r) => r.src + (r.src === 'ospf' ? ' ' + (r.pid || 1) : ''));
  const pas = d.ifaces.filter((i) => e.ifs[i.id] && e.ifs[i.id].passive);
  return [`Routing Protocol is "eigrp ${e.as}"`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set',
    '  Default networks flagged in outgoing updates', '  Default networks accepted from incoming updates', `  Redistributing: ${[`eigrp ${e.as}`, ...red].join(', ')}`,
    `  EIGRP-IPv4 Protocol for AS(${e.as})`, `    Metric weight K1=${k[0]}, K2=${k[1]}, K3=${k[2]}, K4=${k[3]}, K5=${k[4]}`, '    Soft SIA disabled', '    NSF-aware route hold timer is 240',
    `    Router-ID: ${e.rid != null ? fmtIp(e.rid) : '0.0.0.0'}`, '    Topology : 0 (base)', '      Active Timer: 3 min', '      Distance: internal 90 external 170',
    `      Maximum path: ${+c.maxPaths || 4}`, '      Maximum hopcount 100', `      Maximum metric variance ${+c.variance || 1}`, '',
    '  Automatic Summarization: disabled', `  Maximum path: ${+c.maxPaths || 4}`, '  Routing for Networks:',
    ...(c.nets || []).map((n) => `    ${fmtIp(n.net)}${n.bits === classBitsOf(n.net) ? '' : '/' + n.bits}`),
    ...(pas.length ? ['  Passive Interface(s):', ...pas.map((i) => '    ' + longIf(i.label))] : []),
    '  Routing Information Sources:', '    Gateway         Distance      Last Update',
    ...e.nbrs.filter((n) => !n.stale).map((n) => `    ${fmtIp(n.ip).padEnd(16)}${String(EIGRP_AD).padStart(8)}      ${hms(Math.max(0, state.clock - n.since))}`),
    `  Distance: internal ${EIGRP_AD} external ${EIGRP_EX_AD}`];
}
