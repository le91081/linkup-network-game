// OSPFv2：Router ID、鄰居（Hello / Dead、區域、驗證、MTU、被動介面）、DR / BDR 選舉、多區域與 ABR、外部預設路由、等價多路徑
//
// 設定（IOS）：
//   d.ospfNets = [{ net, bits, area }]   router ospf 底下的 network 敘述
//   d.ospfRid、d.ospfDefault、d.ospfRefBw（auto-cost reference-bandwidth，Mbps）、d.ospfMaxPaths
//   d.ospfPassive = [介面 id]、d.ospfPassiveDefault（passive-interface default）、d.ospfNoPassive = [介面 id]
//   d.ospfRanges = [{ area, net, bits }]（area x range）、d.ospfAreaAuth = { 區域: 'md5' | 'plain' }
//   介面：i.ospf / i.ospfArea（ip ospf 1 area x）、i.ospfCost、i.ospfPrio、i.ospfHello、i.ospfDead、i.ospfNet（'p2p'）、
//         i.ospfAuth（'md5' | 'plain' | 'null'）、i.ospfKey（{ id, key }）、i.mtu、i.ospfMtuIgnore、i.bandwidth（kbps）
// 執行期：
//   state.dyn.adj[兩端]  鄰居關係從什麼時候開始、最後一次聽到是什麼時候
//   state.dyn.seg[網段]  這個廣播網段的 DR / BDR（選出來之後不會被搶走）
//   state.dyn.rid[設備]  OSPF 程序啟動時選定的 Router ID（改了 router-id 要 clear ip ospf process 才生效）
//   d.rt.nbrs、d.rt.ospf  給 show 指令與圖形介面看的
import { netOf, sameNet, fmtIp, parseIp } from './ip.js';
import { linkInfo } from './model.js';
import { l2Explore } from './sim.js';

export const OSPF_WAIT = 40; // 新的廣播網段：先等 Wait timer（= Dead interval）才選 DR / BDR
export const P2P_UP = 4; // 點對點：交換完 Hello 與資料庫就是 FULL，幾秒鐘
const JOIN_UP = 6; // 網段上已經有 DR：新來的路由器聽到 Hello 裡的 DR 就不用等 Wait timer

// ───────────────────────── 介面上的參數 ─────────────────────────

const ipOf = (i) => (i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || ''));
/** 這個介面屬於哪個區域（沒有跑 OSPF 就是 null）。network 敘述挑最精確的那一條 */
export function ospfArea(d, i) {
  if (i.ospf) return +(i.ospfArea || 0);
  const ip = ipOf(i);
  if (ip == null) return null;
  let best = null;
  for (const n of d.ospfNets || []) if (netOf(ip, n.bits) === n.net && (!best || n.bits > best.bits)) best = n;
  return best ? +(best.area || 0) : null;
}
export const isLoopback = (i) => i.bind.t === 'loop';
export const ospfPassive = (d, i) => (d.ospfPassiveDefault ? !(d.ospfNoPassive || []).includes(i.id) : (d.ospfPassive || []).includes(i.id)) || isLoopback(i);
export const ospfNetType = (i) => (isLoopback(i) ? 'loopback' : i.ospfNet === 'p2p' ? 'point-to-point' : 'broadcast');
export const ospfHello = (i) => +i.ospfHello || 10;
export const ospfDead = (i) => +i.ospfDead || 4 * ospfHello(i);
export const ospfPrio = (i) => (i.ospfPrio == null || i.ospfPrio === '' ? 1 : +i.ospfPrio);
/** 介面頻寬 (Mbps)：bandwidth 指令優先，不然看實際連線的速率 */
function bwOf(state, d, i) {
  if (+i.bandwidth > 0) return +i.bandwidth / 1000;
  if (isLoopback(i)) return 8000000;
  const li = (i.bind.t === 'port' || i.bind.t === 'sub') && linkInfo(state, d.id, i.bind.port);
  return li && li.speed ? li.speed : 1000;
}
/** cost：手動設定的優先，不然是 reference-bandwidth ÷ 介面頻寬（預設 100 Mbps，所以 1G 和 10G 都是 1） */
export function ospfCost(state, d, i) {
  if (+i.ospfCost > 0) return +i.ospfCost;
  if (isLoopback(i)) return 1;
  return Math.max(1, Math.floor((+d.ospfRefBw || 100) / bwOf(state, d, i)));
}
/** 驗證：介面的設定優先，不然看區域的設定 */
function authOf(d, i, area) {
  const t = i.ospfAuth === 'null' ? 'none' : i.ospfAuth || ((d.ospfAreaAuth || {})[area]) || 'none';
  const k = t === 'none' ? '' : t === 'md5' ? `${(i.ospfKey || {}).id || ''}:${(i.ospfKey || {}).key || ''}` : (i.ospfKey || {}).key || '';
  return { t, k };
}
const mtuOf = (i) => +i.mtu || 1500;

// ───────────────────────── Router ID ─────────────────────────

/** 依規則挑 Router ID：router-id 指令 > 最大的 Loopback 位址 > 最大的實體介面位址 */
function pickRid(d) {
  const set = parseIp(d.ospfRid || '');
  if (set != null) return set;
  const loops = d.ifaces.filter((i) => isLoopback(i) && i.rt && i.rt.ip != null).map((i) => i.rt.ip);
  if (loops.length) return Math.max(...loops.map((x) => x >>> 0));
  const all = d.ifaces.filter((i) => i.rt && i.rt.ip != null && i.rt.link).map((i) => i.rt.ip >>> 0);
  return all.length ? Math.max(...all) : null;
}
/** 程序啟動時選定的 Router ID；之後改了 router-id，要 clear ip ospf process 才會換 */
export function ospfRid(state, d) {
  const tbl = (state.dyn.rid ||= {});
  const cur = tbl[d.id];
  if (cur && cur.rid != null) { cur.pending = (parseIp(d.ospfRid || '') ?? cur.rid) !== cur.rid && parseIp(d.ospfRid || '') != null; return cur.rid; }
  const rid = pickRid(d);
  if (rid != null) tbl[d.id] = { rid, pending: false };
  return rid;
}
export function clearOspfProcess(state, d) {
  if (!state.dyn) return;
  delete (state.dyn.rid || {})[d.id];
  for (const k of Object.keys(state.dyn.adj || {})) if (k.split('~').some((s) => s.startsWith(d.id + '/'))) delete state.dyn.adj[k];
  // 這台當過 DR / BDR 的網段：它重新啟動，別人重新選；它要等完 Wait timer 才能再參加
  for (const seg of Object.values(state.dyn.seg || {})) {
    const mine = (k) => k && k.startsWith(d.id + '/');
    if (mine(seg.dr)) { seg.dr = mine(seg.bdr) ? null : seg.bdr; seg.bdr = null; }
    if (mine(seg.bdr)) seg.bdr = null;
    seg.cleared ||= {};
    for (const i of d.ifaces) seg.cleared[d.id + '/' + i.id] = state.clock + OSPF_WAIT;
  }
}

// ───────────────────────── 主要的計算 ─────────────────────────

/** 介面能不能和對面那個介面成為鄰居；不行的話回傳原因（給 show 指令與紀錄用） */
function helloMismatch(d, i, x, j, ai, aj) {
  if (ai !== aj) return `區域不一致（這一端 area ${ai}，對面 area ${aj}）`;
  if (i.rt.bits !== j.rt.bits) return `子網路遮罩不一致（/${i.rt.bits} 對 /${j.rt.bits}）`;
  if (ospfHello(i) !== ospfHello(j) || ospfDead(i) !== ospfDead(j)) return `Hello / Dead 計時器不一致（這一端 ${ospfHello(i)} / ${ospfDead(i)} 秒，對面 ${ospfHello(j)} / ${ospfDead(j)} 秒）`;
  const a = authOf(d, i, ai), b = authOf(x, j, aj);
  if (a.t !== b.t) return `驗證方式不一致（這一端 ${a.t}，對面 ${b.t}）`;
  if (a.k !== b.k) return '驗證的金鑰不一致';
  return '';
}

export function computeOspf(state, ospfOn) {
  const dyn = state.dyn, now = state.clock, devs = state.devices;
  dyn.adj ||= {}; dyn.seg ||= {}; dyn.lsa ||= {};
  const running = (d, i) => !!i && ospfOn(d, i) && i.rt.ip != null && i.rt.link && ospfArea(d, i) != null;
  const nodes = Object.values(devs).filter((d) => d.ifaces.some((i) => running(d, i)));
  const isNode = new Set(nodes.map((d) => d.id));
  const rid = {};
  for (const d of nodes) { d.rt.nbrs = []; d.rt.ospf = { ifs: {}, rid: ospfRid(state, d), pending: dyn.rid[d.id] && dyn.rid[d.id].pending }; rid[d.id] = d.rt.ospf.rid; }
  const key = (d, i) => d.id + '/' + i.id;

  // 1. 找出每個介面聽得到的鄰居（Hello 的參數要一致），廣播網段順便分組
  const pairs = []; // { a: {d,i}, b: {d,i}, area, why, k }
  const seenPair = new Set();
  const stubs = {}; // 設備 → [{ net, bits, cost, area }]
  for (const d of nodes) {
    stubs[d.id] = [];
    for (const i of d.ifaces) {
      if (!running(d, i)) continue;
      const area = ospfArea(d, i), cost = ospfCost(state, d, i);
      d.rt.ospf.ifs[i.id] = { area, cost, type: ospfNetType(i), passive: ospfPassive(d, i), prio: ospfPrio(i), hello: ospfHello(i), dead: ospfDead(i), state: 'DOWN', nbrs: 0, full: 0, why: [] };
      // Loopback 一律以 /32 主機路由通告（除非改成 point-to-point）
      stubs[d.id].push(isLoopback(i) ? { net: i.rt.ip, bits: 32, cost: 1, area } : { net: netOf(i.rt.ip, i.rt.bits), bits: i.rt.bits, cost, area });
      if (ospfPassive(d, i)) { d.rt.ospf.ifs[i.id].state = isLoopback(i) ? 'LOOP' : 'PASSIVE'; continue; }
      for (const e of l2Explore(state, d.id, i)) {
        const x = devs[e.dev], j = e.iface;
        if (!isNode.has(x.id) || !running(x, j) || !sameNet(j.rt.ip, i.rt.ip, Math.min(i.rt.bits, j.rt.bits))) continue;
        const k = [key(d, i), key(x, j)].sort().join('~');
        if (seenPair.has(k)) continue;
        seenPair.add(k);
        if (ospfPassive(x, j)) continue; // 對面不送 Hello
        const why = helloMismatch(d, i, x, j, ospfArea(d, i), ospfArea(x, j)) || (rid[d.id] === rid[x.id] ? `Router ID 重複（兩台都是 ${fmtIp(rid[d.id])}）` : '');
        pairs.push({ a: { d, i }, b: { d: x, i: j }, area: ospfArea(d, i), why, k });
      }
    }
  }
  // 2. 廣播網段：同一個子網路、互相聽得到的介面是一組，選 DR / BDR
  const parent = {};
  const find = (x) => (parent[x] === x || parent[x] == null ? (parent[x] = x) : (parent[x] = find(parent[x])));
  for (const p of pairs) if (!p.why) parent[find(key(p.a.d, p.a.i))] = find(key(p.b.d, p.b.i));
  const groups = {};
  for (const p of pairs) if (!p.why) for (const s of [p.a, p.b]) { const g = find(key(s.d, s.i)); (groups[g] ||= new Map()).set(key(s.d, s.i), s); }
  // 網段上暫時只有自己：等完 Wait timer 自己當 DR。之後有人加入，聽到 Hello 裡已經有 DR，就不用再等
  for (const d of nodes) for (const i of d.ifaces) {
    if (!running(d, i) || ospfPassive(d, i) || ospfNetType(i) !== 'broadcast' || parent[key(d, i)] != null) continue;
    groups[key(d, i)] = new Map([[key(d, i), { d, i }]]);
  }
  const role = {}; // 介面 → 'DR' | 'BDR' | 'DROTHER' | 'P2P'
  const segOf = {}; // 介面 → 網段紀錄
  const seenSeg = new Set();
  for (const members of Object.values(groups)) {
    const list = [...members.values()];
    const p2p = list.every((s) => ospfNetType(s.i) === 'point-to-point');
    if (p2p) { for (const s of list) role[key(s.d, s.i)] = 'P2P'; continue; }
    const s0 = list[0];
    const sk = `${ospfArea(s0.d, s0.i)}|${fmtIp(netOf(s0.i.rt.ip, s0.i.rt.bits))}/${s0.i.rt.bits}`;
    seenSeg.add(sk);
    let seg = dyn.seg[sk];
    if (!seg) seg = dyn.seg[sk] = { since: dyn.boot ? -1e9 : now, dr: null, bdr: null };
    const ids = new Set(list.map((s) => key(s.d, s.i)));
    // 剛 clear ip ospf process 的路由器：重新啟動中，這段時間不參加選舉
    const cleared = seg.cleared || {};
    for (const k of Object.keys(cleared)) if (cleared[k] <= now) delete cleared[k];
    for (const t of new Set(Object.values(cleared))) state.rt.pending.push({ at: t, dev: s0.d.id, kind: 'ospf', text: `${s0.d.name}：OSPF 程序重新啟動中，等 Wait timer 之後才參加 DR 選舉` });
    const elig = list.filter((s) => ospfPrio(s.i) > 0 && !cleared[key(s.d, s.i)]);
    const better = (a, b) => ospfPrio(a.i) - ospfPrio(b.i) || (rid[a.d.id] >>> 0) - (rid[b.d.id] >>> 0);
    const pick = (cands) => cands.slice().sort((a, b) => better(b, a))[0] || null;
    if (seg.since + OSPF_WAIT <= now) {
      // 選出來的 DR / BDR 不會被後來的路由器搶走；DR 不見了由 BDR 接手，再補選一個 BDR
      if (seg.dr && !ids.has(seg.dr)) { seg.dr = seg.bdr && ids.has(seg.bdr) ? seg.bdr : null; seg.bdr = null; }
      if (seg.bdr && !ids.has(seg.bdr)) seg.bdr = null;
      if (seg.dr && !elig.some((s) => key(s.d, s.i) === seg.dr)) seg.dr = null; // priority 改成 0：立刻放棄
      if (seg.bdr && !elig.some((s) => key(s.d, s.i) === seg.bdr)) seg.bdr = null;
      if (!seg.dr && seg.bdr) { seg.dr = seg.bdr; seg.bdr = null; } // DR 不在了：BDR 升上來
      if (!seg.dr) { const c = pick(elig); seg.dr = c ? key(c.d, c.i) : null; }
      if (!seg.bdr) { const c = pick(elig.filter((s) => key(s.d, s.i) !== seg.dr)); seg.bdr = c ? key(c.d, c.i) : null; }
    } else {
      state.rt.pending.push({ at: seg.since + OSPF_WAIT, dev: s0.d.id, kind: 'ospf', text: `${s0.d.name}：OSPF 正在等 Wait timer，之後才選 DR / BDR` });
    }
    for (const s of list) { const k = key(s.d, s.i); role[k] = !seg.dr && !seg.bdr ? 'WAITING' : k === seg.dr ? 'DR' : k === seg.bdr ? 'BDR' : 'DROTHER'; segOf[k] = seg; }
  }
  for (const k of Object.keys(dyn.seg)) if (!seenSeg.has(k)) delete dyn.seg[k];

  // 3. 每一對鄰居的狀態：計時、FULL / 2WAY / EXSTART
  const adj = {}; // 區域 → 設備 → [{ to, iface, via, cost }]
  const seen = new Set();
  const edge = (area, a, b, stale) => {
    ((adj[area] ||= {})[a.d.id] ||= []).push({ to: b.d.id, iface: a.i, via: b.i.rt.ip, cost: ospfCost(state, a.d, a.i), stale });
  };
  for (const p of pairs) {
    const { a, b } = p;
    for (const [s, o] of [[a, b], [b, a]]) {
      const inf = s.d.rt.ospf.ifs[s.i.id];
      inf.nbrs++;
      if (p.why) inf.why.push(`${o.d.name}：${p.why}`);
    }
    if (p.why) continue;
    let rec = dyn.adj[p.k];
    if (!rec) rec = dyn.adj[p.k] = { since: dyn.boot ? -1e9 : now };
    if (rec.gone) { rec.since = now; delete rec.gone; }
    rec.last = now;
    rec[key(a.d, a.i)] = { ip: a.i.rt.ip, cost: ospfCost(state, a.d, a.i) };
    rec[key(b.d, b.i)] = { ip: b.i.rt.ip, cost: ospfCost(state, b.d, b.i) };
    seen.add(p.k);
    const ra = role[key(a.d, a.i)], rb = role[key(b.d, b.i)];
    const p2p = ra === 'P2P';
    const seg = segOf[key(a.d, a.i)];
    const up = rec.since + (p2p ? P2P_UP : seg && seg.since + OSPF_WAIT <= rec.since ? JOIN_UP : 0) - now;
    const waitSeg = seg && seg.since + OSPF_WAIT > now;
    const mtuBad = mtuOf(a.i) !== mtuOf(b.i) && !a.i.ospfMtuIgnore && !b.i.ospfMtuIgnore;
    const typeBad = ospfNetType(a.i) !== ospfNetType(b.i);
    // 兩台都不是 DR / BDR：只到 2WAY，不交換資料庫（路還是通的，經過 DR 同步）
    const twoWay = !p2p && ra === 'DROTHER' && rb === 'DROTHER';
    let st;
    if (waitSeg) st = 'INIT';
    else if (up > 0) st = 'LOADING';
    else if (mtuBad) st = 'EXSTART';
    else if (twoWay) st = '2WAY';
    else st = 'FULL';
    for (const [s, o, ro] of [[a, b, rb], [b, a, ra]]) {
      const left = st === 'INIT' ? seg.since + OSPF_WAIT - now : st === 'LOADING' ? up : 0;
      const dead = Math.max(1, ospfDead(s.i) - ((now - Math.max(rec.since, 0)) % ospfHello(s.i)));
      s.d.rt.nbrs.push({ dev: o.d.id, iface: s.i.id, ip: o.i.rt.ip, rid: rid[o.d.id], prio: ospfPrio(o.i), cost: ospfCost(state, s.d, s.i), state: st === 'FULL' || st === '2WAY' ? st.toLowerCase() : st === 'EXSTART' ? 'exstart' : 'forming', role: ro, left, dead,
        note: st === 'EXSTART' ? `MTU 不一致（這一端 ${mtuOf(s.i)}，對面 ${mtuOf(o.i)}）：資料庫交換卡在 EXSTART` : typeBad ? `網路類型不一致（這一端 ${ospfNetType(s.i)}，對面 ${ospfNetType(o.i)}）` : '' });
      if (st === 'FULL') s.d.rt.ospf.ifs[s.i.id].full++;
    }
    if (left(st)) state.rt.pending.push({ at: now + left(st), dev: a.d.id, kind: 'ospf', text: `${a.d.name} ↔ ${b.d.name}：OSPF 鄰居關係建立中` });
    // 網路類型不一致：鄰居是 FULL，但兩邊的 LSA 對不起來，SPF 算不出經過這條線的路
    if (st !== 'FULL' && st !== '2WAY') continue;
    if (typeBad) continue;
    if (!p2p && !(segOf[key(a.d, a.i)] || {}).dr) continue;
    edge(p.area, a, b); edge(p.area, b, a);
    function left(x) { return x === 'INIT' ? seg.since + OSPF_WAIT - now : x === 'LOADING' ? up : 0; }
  }
  for (const d of nodes) for (const [id, inf] of Object.entries(d.rt.ospf.ifs)) {
    if (inf.state === 'PASSIVE' || inf.state === 'LOOP') continue;
    inf.state = role[key(d, { id })] || (inf.nbrs ? 'DOWN' : inf.type === 'point-to-point' ? 'P2P' : 'DR');
    inf.dr = segOf[key(d, { id })] ? segOf[key(d, { id })].dr : null;
    inf.bdr = segOf[key(d, { id })] ? segOf[key(d, { id })].bdr : null;
  }

  // 4. 這一次沒聽到的鄰居：自己的介面還亮著，要等 Dead timer 到期才會把它從資料庫拿掉
  const ghosts = new Set();
  for (const [k, rec] of Object.entries(dyn.adj)) {
    if (seen.has(k)) continue;
    const sides = k.split('~').map((s) => ({ s, dev: s.slice(0, s.indexOf('/')), iface: s.slice(s.indexOf('/') + 1) }));
    const di = devs[sides[0].dev] && devs[sides[0].dev].ifaces.find((x) => x.id === sides[0].iface);
    const deadT = di ? ospfDead(di) : 40;
    if (now - rec.last >= deadT || rec.since + P2P_UP > rec.last) { delete dyn.adj[k]; continue; }
    rec.gone = true;
    for (const [a, b] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
      const d = devs[a.dev], other = devs[b.dev];
      if (!d || !other || !rec[b.s]) continue;
      const i = d.ifaces.find((x) => x.id === a.iface);
      const believes = isNode.has(d.id) && running(d, i);
      if (!believes && isNode.has(d.id)) continue;
      if (!isNode.has(d.id)) ghosts.add(d.id);
      const area = i ? ospfArea(d, i) ?? 0 : 0;
      ((adj[area] ||= {})[d.id] ||= []).push({ to: b.dev, iface: i, via: rec[b.s].ip, cost: rec[a.s] ? rec[a.s].cost : 1, stale: true });
      if (!believes) continue;
      const leftT = rec.last + deadT - now;
      d.rt.nbrs.push({ dev: b.dev, iface: a.iface, ip: rec[b.s].ip, rid: rid[b.dev] ?? (dyn.rid[b.dev] || {}).rid, prio: 1, cost: rec[a.s] ? rec[a.s].cost : 1, state: 'dying', role: 'DROTHER', left: leftT, dead: leftT });
      state.rt.pending.push({ at: rec.last + deadT, dev: d.id, kind: 'ospf', text: `${d.name} 還沒發現 ${other.name} 已經失聯（OSPF Dead timer）` });
    }
  }
  for (const id of ghosts) stubs[id] = (dyn.lsa[id] || []).map((x) => ({ ...x }));
  for (const d of nodes) dyn.lsa[d.id] = stubs[d.id];
  for (const id of Object.keys(dyn.lsa)) if (!isNode.has(id) && !ghosts.has(id)) delete dyn.lsa[id];

  // 5. SPF：每個區域各算一次，記下所有等價的第一站
  const everyone = [...nodes.map((d) => d.id), ...ghosts];
  const areasOf = (id) => [...new Set((stubs[id] || []).map((s) => s.area))];
  const spf = {}; // 設備 → 區域 → { dist, first }
  for (const d of nodes) {
    spf[d.id] = {};
    for (const area of areasOf(d.id)) {
      const g = adj[area] || {};
      const dist = { [d.id]: 0 }, first = {}, done = new Set();
      for (;;) {
        let u = null;
        for (const k of Object.keys(dist)) if (!done.has(k) && (u == null || dist[k] < dist[u])) u = k;
        if (u == null) break;
        done.add(u);
        for (const e of g[u] || []) {
          const nd = dist[u] + e.cost;
          const hops = u === d.id ? [{ iface: e.iface, via: e.via }] : first[u];
          if (dist[e.to] == null || nd < dist[e.to]) { dist[e.to] = nd; first[e.to] = hops.slice(); }
          else if (nd === dist[e.to]) for (const h of hops) if (!first[e.to].some((x) => x.via === h.via && x.iface === h.iface)) first[e.to].push(h);
        }
      }
      spf[d.id][area] = { dist, first };
    }
  }
  const maxPaths = (d) => Math.max(1, Math.min(32, +d.ospfMaxPaths || 4));
  const ranges = (d, area) => (d.ospfRanges || []).filter((r) => +r.area === area);
  const abrs = new Set(everyone.filter((id) => { const a = areasOf(id); return a.includes(0) && a.length > 1; }));

  // 區域內的路由：每台設備對每個區域裡每個網段的最佳 cost 與第一站
  const intra = {}; // 設備 → '網段/遮罩' → { net, bits, metric, hops, area }
  for (const d of nodes) {
    const t = (intra[d.id] = {});
    for (const area of areasOf(d.id)) {
      const { dist, first } = spf[d.id][area];
      for (const oid of everyone) {
        if (dist[oid] == null) continue;
        for (const n of stubs[oid] || []) {
          if (n.area !== area) continue;
          const k = n.net + '/' + n.bits, metric = dist[oid] + n.cost;
          const hops = oid === d.id ? [] : first[oid] || [];
          const cur = t[k];
          if (!cur || metric < cur.metric) t[k] = { net: n.net, bits: n.bits, metric, hops: hops.slice(), area, owner: oid };
          else if (metric === cur.metric) for (const h of hops) if (!cur.hops.some((x) => x.via === h.via && x.iface === h.iface)) cur.hops.push(h);
        }
      }
    }
  }
  // ABR 把非骨幹區域的網段整理成 summary 送進骨幹（area range 可以彙總）
  const sumInto0 = {}; // ABR → '網段' → { net, bits, cost }
  const sumOut = {}; // ABR → 區域 → '網段' → { net, bits, cost }
  const ownDev = (id) => devs[id] && isNode.has(id) ? devs[id] : null;
  for (const b of abrs) {
    const D = ownDev(b);
    const t = intra[b] || {};
    const s0 = (sumInto0[b] = {});
    for (const r of Object.values(t)) {
      if (r.area === 0) continue;
      const rg = D ? ranges(D, r.area).find((x) => netOf(r.net, x.bits) === x.net && r.bits >= x.bits) : null;
      const k = rg ? rg.net + '/' + rg.bits : r.net + '/' + r.bits;
      const cur = s0[k];
      if (!cur || r.metric > cur.cost) s0[k] = { net: rg ? rg.net : r.net, bits: rg ? rg.bits : r.bits, cost: r.metric, range: !!rg };
    }
  }
  // 骨幹裡的路由器（包括 ABR）：從其他 ABR 的 summary 算出區域間的路由
  const inter = {}; // 設備 → '網段' → { net, bits, metric, hops }
  const addInter = (id, s, metric, hops) => {
    const t = (inter[id] ||= {}), k = s.net + '/' + s.bits;
    if ((intra[id] || {})[k]) return; // 區域內的路由永遠優先
    const cur = t[k];
    if (!cur || metric < cur.metric) t[k] = { net: s.net, bits: s.bits, metric, hops: hops.slice() };
    else if (metric === cur.metric) for (const h of hops) if (!cur.hops.some((x) => x.via === h.via && x.iface === h.iface)) cur.hops.push(h);
  };
  for (const d of nodes) {
    if (!areasOf(d.id).includes(0)) continue;
    const { dist, first } = spf[d.id][0];
    for (const b of abrs) {
      if (b === d.id || dist[b] == null) continue;
      for (const s of Object.values(sumInto0[b] || {})) addInter(d.id, s, dist[b] + s.cost, first[b] || []);
    }
  }
  // ABR 再把骨幹的網段、以及從骨幹學到的其他區域，送進自己連著的非骨幹區域
  for (const b of abrs) {
    for (const area of areasOf(b)) {
      if (area === 0) continue;
      const out = ((sumOut[b] ||= {})[area] = {});
      for (const r of Object.values(intra[b] || {})) if (r.area === 0) out[r.net + '/' + r.bits] = { net: r.net, bits: r.bits, cost: r.metric };
      for (const r of Object.values(inter[b] || {})) out[r.net + '/' + r.bits] = { net: r.net, bits: r.bits, cost: r.metric };
      // 其他非骨幹區域裡、這台 ABR 自己就連著的網段
      for (const r of Object.values(intra[b] || {})) if (r.area !== 0 && r.area !== area) out[r.net + '/' + r.bits] = { net: r.net, bits: r.bits, cost: r.metric };
    }
  }
  for (const d of nodes) {
    if (abrs.has(d.id)) continue;
    for (const area of areasOf(d.id)) {
      if (area === 0) continue;
      const { dist, first } = spf[d.id][area];
      for (const b of abrs) {
        if (dist[b] == null) continue;
        for (const s of Object.values(((sumOut[b] || {})[area]) || {})) addInter(d.id, s, dist[b] + s.cost, first[b] || []);
      }
    }
  }

  // 6. 外部路由：default-information originate 送出的預設路由是 E2，cost 固定 1，往 ASBR 的內部 cost 只用來挑出口
  const asbrs = nodes.filter((d) => d.ospfDefault && d.rt.routes.some((r) => r.bits === 0 && !r.bad && r.type !== 'O'));
  for (const d of nodes) {
    // 往每一台 ASBR 的內部 cost：它任何一個網段的最佳路由
    let best = null;
    for (const a of asbrs) {
      if (a === d) continue;
      // 往 ASBR 的內部 cost：同一個區域就看 SPF；在別的區域就經過 ABR（ASBR summary）
      let c = null, hops = [];
      const cand = (x, h) => { if (h && h.length && (c == null || x < c)) { c = x; hops = h; } };
      for (const area of areasOf(d.id)) {
        const sp = spf[d.id][area];
        if (sp.dist[a.id] != null) { cand(sp.dist[a.id], sp.first[a.id]); continue; }
        for (const b of abrs) {
          if (sp.dist[b] == null || !spf[b]) continue;
          for (const v of Object.values(spf[b])) if (v.dist[a.id] != null) cand(sp.dist[b] + v.dist[a.id], sp.first[b]);
        }
      }
      if (c == null) continue;
      if (!best || c < best.fwd) best = { fwd: c, hops: hops.slice(), asbr: a.id };
      else if (c === best.fwd) for (const h of hops) if (!best.hops.some((x) => x.via === h.via)) best.hops.push(h);
    }
    if (best && !d.rt.routes.some((r) => r.bits === 0 && !r.bad && r.type !== 'O')) d.rt.ospf.ext = best;
  }

  // 7. 裝進路由表：每個等價的第一站各一筆（最多 maximum-paths 條）
  for (const d of nodes) {
    const put = (r, sub) => {
      if (d.rt.routes.some((x) => x.type === 'C' && x.net === r.net && x.bits === r.bits)) return;
      const hops = r.hops.filter((h) => h.iface).slice(0, maxPaths(d));
      for (const h of hops) d.rt.routes.push({ net: r.net, bits: r.bits, via: h.via, iface: h.iface, type: 'O', sub, ad: 110, metric: r.metric });
    };
    for (const r of Object.values(intra[d.id] || {})) if (r.hops.length) put(r, '');
    for (const r of Object.values(inter[d.id] || {})) put(r, 'IA');
    const ext = d.rt.ospf.ext;
    if (ext) put({ net: 0, bits: 0, metric: 1, hops: ext.hops }, 'E2');
    d.rt.ospf.abr = abrs.has(d.id);
    d.rt.ospf.asbr = asbrs.includes(d);
    d.rt.ospf.areas = areasOf(d.id);
  }
  // 給 show ip ospf database 用
  state.rt.ospf = { stubs, abrs: [...abrs], sumInto0, sumOut, rid, asbrs: asbrs.map((d) => d.id) };
}
