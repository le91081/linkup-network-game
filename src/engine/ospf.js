// OSPFv2 與 OSPFv3：Router ID、鄰居（Hello / Dead、區域、驗證、MTU、被動介面）、DR / BDR 選舉、多區域與 ABR、外部預設路由、等價多路徑
// 兩個版本的計算完全一樣，差別只在「位址家族」：鄰居用什麼位址認識彼此、網段長什麼樣子、路由裝進哪一張表（見下方的 V4 / V6）
//
// 設定（IOS）：
//   d.ospfNets = [{ net, bits, area }]   router ospf 底下的 network 敘述
//   d.ospfRid、d.ospfDefault、d.ospfRefBw（auto-cost reference-bandwidth，Mbps）、d.ospfMaxPaths
//   d.ospfPassive = [介面 id]、d.ospfPassiveDefault（passive-interface default）、d.ospfNoPassive = [介面 id]
//   d.ospfRanges = [{ area, net, bits }]（area x range）、d.ospfAreaAuth = { 區域: 'md5' | 'plain' }
//   d.ospfAreas = { 區域: { stub?, nssa?, noSum?, cost?, nssaDef?, nssaDefMetric?, nssaDefType?, noRedist? } }
//     area x stub [no-summary]、area x nssa [no-summary] [default-information-originate] [no-redistribution]、area x default-cost n
//   介面：i.ospf / i.ospfArea（ip ospf 1 area x）、i.ospfCost、i.ospfPrio、i.ospfHello、i.ospfDead、i.ospfNet（'p2p'）、
//         i.ospfAuth（'md5' | 'plain' | 'null'）、i.ospfKey（{ id, key }）、i.mtu、i.ospfMtuIgnore、i.bandwidth（kbps）
//   VRF 裡的程序（router ospf 2 vrf A）：d.ospfVrf[A] = { pid, ospfNets, ospfRid, ospfDefault, ospfRedist, ospfAreas, … }，欄位名稱和全域的一樣；
//     介面在哪個 VRF，就只會被那個 VRF 的程序涵蓋（全域的 network 敘述不會把 VRF 的介面拉進來）
// 區域的種類：
//   stub：ABR 不把 Type-5（外部路由）送進來，改送一筆預設的 Summary LSA (O*IA)；no-summary（totally stubby）連區域間的路也不送
//   NSSA：區域裡可以有 ASBR，重分配的路以 Type-7 留在區域裡 (O N1 / N2)，由 Router ID 最大的 NSSA ABR 轉成 Type-5 送進骨幹；
//         外面的 Type-5 一樣進不來；預設路由要 default-information-originate（Type-7）或 no-summary（Type-3）
//   區域種類寫在 Hello 的選項 (E / N bit) 裡：同一個區域的路由器設定不一樣，就不會成為鄰居
// 執行期：
//   state.dyn.adj[兩端]  鄰居關係從什麼時候開始、最後一次聽到是什麼時候
//   state.dyn.seg[網段]  這個廣播網段的 DR / BDR（選出來之後不會被搶走）
//   state.dyn.rid[設備]  OSPF 程序啟動時選定的 Router ID（改了 router-id 要 clear ip ospf process 才生效）
//   d.rt.nbrs、d.rt.ospf  給 show 指令與圖形介面看的
//
// OSPFv3（ipv6 router ospf 1）：
//   d.ospf6 = { rid, default, passive: [介面 id], passiveDefault, noPassive: [介面 id], maxPaths, refBw }
//   介面：i.ospf6Area（ipv6 ospf 1 area x）、i.ospf6Cost、i.ospf6Prio、i.ospf6Hello、i.ospf6Dead、i.ospf6Net（'p2p'）
//   執行期：state.dyn.adj6 / seg6 / lsa6 / rid6，d.rt.nbrs6、d.rt.ospf6、state.rt.ospf6
//   和 OSPFv2 不同的地方：鄰居用 link-local 位址建立（兩端的全域前綴不一樣也能成為鄰居），路由的下一站也是 link-local；
//   Router ID 仍然是 32 位元，路由器上完全沒有 IPv4 位址時要手動設定，不然程序起不來
import { netOf, sameNet, fmtIp, parseIp } from './ip.js';
import { net6, fmtIp6 } from './ip6.js';
import { linkInfo } from './model.js';
import { ospfExternals } from './policy.js';
import { l2Explore } from './sim.js';

export const OSPF_WAIT = 40; // 新的廣播網段：先等 Wait timer（= Dead interval）才選 DR / BDR
export const P2P_UP = 4; // 點對點：交換完 Hello 與資料庫就是 FULL，幾秒鐘
const JOIN_UP = 6; // 網段上已經有 DR：新來的路由器聽到 Hello 裡的 DR 就不用等 Wait timer

// ───────────────────────── 程序與區域 ─────────────────────────

const vrfOf = (i) => (i && i.vrf) || '';
/** OSPF 程序的設定：全域的程序直接放在設備上；VRF 裡的程序放在 d.ospfVrf[VRF]（欄位名稱一樣）。沒有這個程序就是 null */
export const ospfProc = (d, vrf = '') => (vrf ? ((d && d.ospfVrf) || {})[vrf] || null : d);
/** 介面所屬的 OSPF 程序 */
export const ospfProcOf = (d, i) => ospfProc(d, vrfOf(i));
/** 某個區域的設定（stub / NSSA、預設路由的 cost） */
export const ospfAreaCfg = (c, area) => (c && area !== 0 && ((c.ospfAreas || {})[area])) || {};
/** 區域的種類：'normal' | 'stub' | 'nssa'（骨幹永遠是 normal） */
export function ospfAreaType(c, area) {
  const a = ospfAreaCfg(c, area);
  return a.nssa ? 'nssa' : a.stub ? 'stub' : 'normal';
}
/** show ip ospf 用的說明文字 */
export function areaKindText(c, area) {
  const a = ospfAreaCfg(c, area), t = ospfAreaType(c, area);
  return t === 'stub' ? (a.noSum ? 'totally stubby' : 'stub') : t === 'nssa' ? (a.noSum ? 'totally NSSA' : 'NSSA') : 'normal';
}
/** 程序的編號（show 指令用）：全域的程序固定是 1 */
export const ospfPid = (d, vrf = '') => (vrf ? +((ospfProc(d, vrf) || {}).pid) || 1 : 1);
/** 這台設備所有的 IPv4 OSPF 程序：[{ vrf, pid, c }]，全域的排第一個 */
export function ospfProcs(d) {
  return [{ vrf: '', pid: 1, c: d }, ...Object.entries(d.ospfVrf || {}).map(([vrf, c]) => ({ vrf, pid: +c.pid || 1, c }))];
}
/** d.rt 底下、state.rt 底下、state.dyn 底下存放這個程序的鍵 */
export const ospfKeys = (vrf = '') => (vrf ? { ns: '@' + vrf, key: 'ospf@' + vrf, nkey: 'nbrs@' + vrf } : { ns: '', key: 'ospf', nkey: 'nbrs' });

// ───────────────────────── 介面上的參數 ─────────────────────────

const ipOf = (i) => (i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || ''));
/** 這個介面屬於哪個區域（沒有跑 OSPF 就是 null）。network 敘述挑最精確的那一條；介面在 VRF 裡，就看那個 VRF 的程序 */
export function ospfArea(d, i) {
  const c = ospfProcOf(d, i);
  if (!c) return null;
  if (i.ospf) return +(i.ospfArea || 0);
  const ip = ipOf(i);
  if (ip == null) return null;
  let best = null;
  for (const n of c.ospfNets || []) if (netOf(ip, n.bits) === n.net && (!best || n.bits > best.bits)) best = n;
  return best ? +(best.area || 0) : null;
}
export const isLoopback = (i) => i.bind.t === 'loop';
export const ospfPassive = (d, i) => {
  const c = ospfProcOf(d, i) || {};
  return (c.ospfPassiveDefault ? !(c.ospfNoPassive || []).includes(i.id) : (c.ospfPassive || []).includes(i.id)) || isLoopback(i);
};
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
  return Math.max(1, Math.floor((+(ospfProcOf(d, i) || {}).ospfRefBw || 100) / bwOf(state, d, i)));
}
/** 驗證：介面的設定優先，不然看區域的設定 */
function authOf(d, i, area) {
  const t = i.ospfAuth === 'null' ? 'none' : i.ospfAuth || (((ospfProcOf(d, i) || {}).ospfAreaAuth || {})[area]) || 'none';
  const k = t === 'none' ? '' : t === 'md5' ? `${(i.ospfKey || {}).id || ''}:${(i.ospfKey || {}).key || ''}` : (i.ospfKey || {}).key || '';
  return { t, k };
}
const mtuOf = (i) => +i.mtu || +i.l2mtu || 1500;

// ───────────────────────── Router ID ─────────────────────────

/** 依規則挑 Router ID：router-id 指令 > 最大的 Loopback 位址 > 最大的實體介面位址（VRF 裡的程序只看那個 VRF 的介面） */
function pickRid(d, vrf = '') {
  const set = parseIp((ospfProc(d, vrf) || {}).ospfRid || '');
  if (set != null) return set;
  const mine = d.ifaces.filter((i) => vrfOf(i) === vrf);
  const loops = mine.filter((i) => isLoopback(i) && i.rt && i.rt.ip != null).map((i) => i.rt.ip);
  if (loops.length) return Math.max(...loops.map((x) => x >>> 0));
  const all = mine.filter((i) => i.rt && i.rt.ip != null && i.rt.link).map((i) => i.rt.ip >>> 0);
  return all.length ? Math.max(...all) : null;
}
/** 程序啟動時選定的 Router ID；之後改了 router-id，要 clear ip ospf process 才會換 */
export function ospfRid(state, d, vrf = '') {
  const tbl = (state.dyn['rid' + ospfKeys(vrf).ns] ||= {});
  const cur = tbl[d.id];
  const want = parseIp((ospfProc(d, vrf) || {}).ospfRid || '');
  if (cur && cur.rid != null) { cur.pending = want != null && want !== cur.rid; return cur.rid; }
  const rid = pickRid(d, vrf);
  if (rid != null) tbl[d.id] = { rid, pending: false };
  return rid;
}
/** clear ip ospf process：IOS 會重新啟動這台所有的 OSPF 程序（全域的與每個 VRF 的） */
export function clearOspfAll(state, d) {
  clearOspfProcess(state, d, '');
  for (const v of Object.keys(d.ospfVrf || {})) clearOspfProcess(state, d, '', v);
}
/** 計算時的節點 id：全域的程序就是設備 id，VRF 的程序是「設備@VRF」 */
export const ospfNodeId = (devId, vrf = '') => (vrf ? `${devId}@${vrf}` : devId);
/** ns：'' 是 OSPFv2、'6' 是 OSPFv3；vrf：哪一個 VRF 的程序 */
export function clearOspfProcess(state, d, ns = '', vrf = '') {
  if (!state.dyn) return;
  const id = ospfNodeId(d.id, vrf);
  delete (state.dyn['rid' + ns + (vrf ? '@' + vrf : '')] || {})[d.id];
  const adjT = state.dyn['adj' + ns] || {};
  for (const k of Object.keys(adjT)) if (k.split('~').some((s) => s.startsWith(id + '/'))) delete adjT[k];
  // 這台當過 DR / BDR 的網段：它重新啟動，別人重新選；它要等完 Wait timer 才能再參加
  for (const seg of Object.values(state.dyn['seg' + ns] || {})) {
    const mine = (k) => k && k.startsWith(id + '/');
    if (mine(seg.dr)) { seg.dr = mine(seg.bdr) ? null : seg.bdr; seg.bdr = null; }
    if (mine(seg.bdr)) seg.bdr = null;
    seg.cleared ||= {};
    for (const i of d.ifaces) if (ns || vrfOf(i) === vrf) seg.cleared[id + '/' + i.id] = state.clock + OSPF_WAIT;
  }
}

// ───────────────────────── OSPFv3 的參數 ─────────────────────────

export const ospf6Area = (d, i) => (d.ospf6 && i.ospf6Area != null && i.ospf6Area !== '' ? +i.ospf6Area : null);
export const ospf6Passive = (d, i) => {
  const c = d.ospf6 || {};
  return (c.passiveDefault ? !(c.noPassive || []).includes(i.id) : (c.passive || []).includes(i.id)) || isLoopback(i);
};
export const ospf6NetType = (i) => (isLoopback(i) ? 'loopback' : i.ospf6Net === 'p2p' ? 'point-to-point' : 'broadcast');
export const ospf6Hello = (i) => +i.ospf6Hello || 10;
export const ospf6Dead = (i) => +i.ospf6Dead || 4 * ospf6Hello(i);
export const ospf6Prio = (i) => (i.ospf6Prio == null || i.ospf6Prio === '' ? 1 : +i.ospf6Prio);
export function ospf6Cost(state, d, i) {
  if (+i.ospf6Cost > 0) return +i.ospf6Cost;
  if (isLoopback(i)) return 1;
  return Math.max(1, Math.floor((+(d.ospf6 || {}).refBw || 100) / bwOf(state, d, i)));
}
/** OSPFv3 的 Router ID 還是 32 位元：router-id 指令 > 最大的 IPv4 Loopback > 最大的 IPv4 介面位址；都沒有就是 null（程序起不來） */
function pickRid6(d) {
  const set = parseIp((d.ospf6 || {}).rid || '');
  if (set != null) return set;
  const loops = d.ifaces.filter((i) => isLoopback(i) && i.rt && i.rt.ip != null).map((i) => i.rt.ip >>> 0);
  if (loops.length) return Math.max(...loops);
  const all = d.ifaces.filter((i) => i.rt && i.rt.ip != null && i.rt.link).map((i) => i.rt.ip >>> 0);
  return all.length ? Math.max(...all) : null;
}
export function ospf6Rid(state, d) {
  const tbl = (state.dyn.rid6 ||= {});
  const cur = tbl[d.id];
  const want = parseIp((d.ospf6 || {}).rid || '');
  if (cur && cur.rid != null) { cur.pending = want != null && want !== cur.rid; return cur.rid; }
  const rid = pickRid6(d);
  if (rid != null) tbl[d.id] = { rid, pending: false };
  return rid;
}
/** 全域位址（OSPFv3 通告的前綴；link-local 不通告） */
const globals6 = (i) => (i.rt && i.rt.v6 ? i.rt.v6.addrs : []);

/**
 * 一個位址家族需要的東西。計算的單位是「程序節點」v = { id, dev, vrf, name, ifaces }：
 * 介面層級的函式拿 (設備, 介面)，程序層級的函式拿節點（VRF 的程序看 d.ospfVrf 裡的設定）
 */
const V4 = (ospfOn) => ({
  ns: '', key: 'ospf', name: 'OSPF', zero: 0, enc: (x) => x, dec: (x) => x,
  vrfsOf: (d) => ['', ...Object.keys(d.ospfVrf || {}).filter((v) => (d.vrfs || {})[v])],
  keyOf: (vrf) => ospfKeys(vrf).key, nkeyOf: (vrf) => ospfKeys(vrf).nkey, ridKey: (vrf) => 'rid' + ospfKeys(vrf).ns,
  on: (d, i) => ospfOn(d, i) && i.rt.ip != null,
  area: ospfArea, cost: ospfCost, passive: ospfPassive, prio: ospfPrio, hello: ospfHello, dead: ospfDead, netType: ospfNetType,
  rid: (state, v) => ospfRid(state, v.dev, v.vrf),
  mismatch: (d, i, x, j, ai, aj) => helloMismatch(d, i, x, j, ai, aj) || stubMismatch(d, i, x, j, ai),
  areaType: (v, area) => ospfAreaType(ospfProc(v.dev, v.vrf), area),
  areaCfg: (v, area) => ospfAreaCfg(ospfProc(v.dev, v.vrf), area),
  // 同一個子網路的才會成為鄰居
  peer: (i, j) => sameNet(j.rt.ip, i.rt.ip, Math.min(i.rt.bits, j.rt.bits)),
  addr: (i) => i.rt.ip,
  // Loopback 一律以 /32 主機路由通告（除非改成 point-to-point）
  stubs: (d, i, cost, area) => [isLoopback(i) ? { net: i.rt.ip, bits: 32, cost: 1, area } : { net: netOf(i.rt.ip, i.rt.bits), bits: i.rt.bits, cost, area }],
  // 網段的代號：區域與子網路。成員裡有 VRF 的程序時再加上它的節點 id：不同客戶的網段可以一模一樣（例如兩個 VRF 都用 10.0.0.0/30）
  segKey: (list, area) => {
    const vr = list.filter((s) => s.d.vrf).map((s) => s.d.id).sort()[0];
    return `${area}|${fmtIp(netOf(list[0].i.rt.ip, list[0].i.rt.bits))}/${list[0].i.rt.bits}${vr ? "|" + vr : ""}`;
  },
  maxPaths: (v) => (ospfProc(v.dev, v.vrf) || {}).ospfMaxPaths,
  ranges: (v, area) => ((ospfProc(v.dev, v.vrf) || {}).ospfRanges || []).filter((r) => +r.area === area),
  netOf,
  routes: (v) => v.dev.rt.routes,
  originates: (v) => !!(ospfProc(v.dev, v.vrf) || {}).ospfDefault,
  externals: (v) => ospfExternals(v.dev, ospfOn, v.vrf),
  // Type-7 的 forwarding address：ASBR 在那個 NSSA 裡的位址（Loopback 優先，再來是最大的介面位址）
  fa: (v, area) => {
    const mine = v.ifaces.filter((i) => i.rt.link && i.rt.ip != null && ospfArea(v.dev, i) === area);
    const pick = (l) => (l.length ? Math.max(...l.map((i) => i.rt.ip >>> 0)) : null);
    return pick(mine.filter(isLoopback)) ?? pick(mine);
  },
});
const V6 = {
  ns: '6', key: 'ospf6', name: 'OSPFv3', zero: 0n,
  vrfsOf: () => [''], keyOf: () => 'ospf6', nkeyOf: () => 'nbrs6', ridKey: () => 'rid6',
  // state.dyn 會被序列化（存檔、試算），BigInt 要存成字串
  enc: (x) => (x == null ? x : x.toString()), dec: (x) => (x == null ? x : BigInt(x)),
  on: (d, i) => !!d.v6routing && !!i.rt.v6 && i.rt.v6.ll != null,
  area: ospf6Area, cost: ospf6Cost, passive: ospf6Passive, prio: ospf6Prio, hello: ospf6Hello, dead: ospf6Dead, netType: ospf6NetType,
  rid: (state, v) => ospf6Rid(state, v.dev),
  // OSPFv3 的 Hello 沒有子網路遮罩，也沒有自己的驗證欄位（靠 IPsec），所以只比區域與計時器
  mismatch: (d, i, x, j, ai, aj) => (ai !== aj ? `區域不一致（這一端 area ${ai}，對面 area ${aj}）`
    : ospf6Hello(i) !== ospf6Hello(j) || ospf6Dead(i) !== ospf6Dead(j) ? `Hello / Dead 計時器不一致（這一端 ${ospf6Hello(i)} / ${ospf6Dead(i)} 秒，對面 ${ospf6Hello(j)} / ${ospf6Dead(j)} 秒）` : ''),
  // 用 link-local 認識彼此：同一條鏈路就行，不看全域前綴
  peer: () => true,
  addr: (i) => i.rt.v6.ll,
  stubs: (d, i, cost, area) => globals6(i).map((a) => (isLoopback(i) ? { net: a.ip, bits: 128, cost: 0, area } : { net: net6(a.ip, a.bits), bits: a.bits, cost, area })),
  // 網段的代號：成員上最小的全域前綴；整條鏈路只有 link-local 時用成員裡最小的介面
  segKey: (list, area) => {
    const pfx = list.flatMap((s) => globals6(s.i).map((a) => `${fmtIp6(net6(a.ip, a.bits))}/${a.bits}`)).sort();
    return `${area}|${pfx[0] || 'll:' + list.map((s) => s.d.id + '/' + s.i.id).sort()[0]}`;
  },
  maxPaths: (v) => (v.dev.ospf6 || {}).maxPaths,
  ranges: () => [],
  netOf: net6,
  routes: (v) => v.dev.rt.routes6,
  originates: (v) => !!(v.dev.ospf6 || {}).default,
  externals: () => [],
  areaType: () => 'normal', areaCfg: () => ({}), fa: () => null,
};

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
/** Hello 的選項：E-bit（可以收 Type-5）與 N-bit（NSSA）。同一個區域裡設定不一樣就不成為鄰居 */
function stubMismatch(d, i, x, j, area) {
  const a = ospfAreaType(ospfProcOf(d, i), area), b = ospfAreaType(ospfProcOf(x, j), area);
  if (a === b) return '';
  const name = { normal: '一般區域', stub: 'stub', nssa: 'NSSA' };
  return `區域種類不一致（area ${area} 在這一端是 ${name[a]}，在對面是 ${name[b]}）：Hello 裡的 stub / NSSA 選項位元不同（mismatched Stub/Transit area option bit），area ${area} 的每一台路由器都要設定一樣的 area ${area} ${a === 'normal' ? b : a}`;
}

export function computeOspf(state, ospfOn) {
  // 全域與每個 VRF 的程序一起算：它們是不同的節點，只會和 L2 上真的接在一起、而且都在跑 OSPF 的程序成為鄰居
  computeOspfAf(state, V4(ospfOn));
  // 已經沒有任何設備在用的 VRF：把它在 state.dyn 的 Router ID 紀錄清掉
  const vrfs = new Set();
  for (const d of Object.values(state.devices)) for (const v of Object.keys(d.ospfVrf || {})) vrfs.add(v);
  for (const k of Object.keys(state.dyn)) {
    const m = k.match(/^(adj|seg|lsa|rid)@(.+)$/);
    if (m && (m[1] !== 'rid' || !vrfs.has(m[2]))) delete state.dyn[k];
  }
}
/** OSPFv3：在 IPv6 的路由表算好直連與靜態路由之後呼叫 */
export function computeOspf6(state) { computeOspfAf(state, V6); }

function computeOspfAf(state, af) {
  const dyn = state.dyn, now = state.clock;
  const adjT = (dyn['adj' + af.ns] ||= {}), segT = (dyn['seg' + af.ns] ||= {}), lsaT = (dyn['lsa' + af.ns] ||= {});
  // 程序節點：每台設備的全域程序，加上每個 VRF 的程序（各自只看自己 VRF 的介面）
  const devs = {}, viewOf = {};
  for (const d of Object.values(state.devices)) {
    for (const vrf of af.vrfsOf(d)) {
      const v = { id: ospfNodeId(d.id, vrf), dev: d, vrf, name: d.name, ifaces: af.ns ? d.ifaces : d.ifaces.filter((i) => vrfOf(i) === vrf) };
      devs[v.id] = v; viewOf[d.id + '|' + vrf] = v;
    }
  }
  /** 某台設備的某個介面屬於哪一個程序節點 */
  const nodeAt = (devId, i) => viewOf[devId + '|' + (af.ns ? '' : vrfOf(i))];
  const running = (d, i) => !!i && i.rt.link && (af.ns || vrfOf(i) === d.vrf) && af.on(d.dev, i) && af.area(d.dev, i) != null;
  const cand = Object.values(devs).filter((d) => d.ifaces.some((i) => running(d, i)));
  const rid = {};
  const O = (d) => d.dev.rt[af.keyOf(d.vrf)], NB = (d) => d.dev.rt[af.nkeyOf(d.vrf)];
  const ridTbl = (d) => dyn[af.ridKey(d.vrf)] || {};
  for (const d of cand) {
    d.dev.rt[af.nkeyOf(d.vrf)] = [];
    d.dev.rt[af.keyOf(d.vrf)] = { ifs: {}, rid: af.rid(state, d), vrf: d.vrf };
    O(d).pending = !!(ridTbl(d)[d.dev.id] || {}).pending;
    rid[d.id] = O(d).rid;
    // OSPFv3 選不出 Router ID（沒有任何 IPv4 位址、也沒有設定 router-id）：程序起不來
    if (rid[d.id] == null) O(d).norid = true;
  }
  const nodes = cand.filter((d) => rid[d.id] != null);
  const isNode = new Set(nodes.map((d) => d.id));
  const key = (d, i) => d.id + '/' + i.id;

  // 1. 找出每個介面聽得到的鄰居（Hello 的參數要一致），廣播網段順便分組
  const pairs = []; // { a: {d,i}, b: {d,i}, area, why, k }
  const seenPair = new Set();
  const stubs = {}; // 設備 → [{ net, bits, cost, area }]
  for (const d of nodes) {
    stubs[d.id] = [];
    for (const i of d.ifaces) {
      if (!running(d, i)) continue;
      const area = af.area(d.dev, i), cost = af.cost(state, d.dev, i);
      O(d).ifs[i.id] = { area, cost, type: af.netType(i), passive: af.passive(d.dev, i), prio: af.prio(i), hello: af.hello(i), dead: af.dead(i), state: 'DOWN', nbrs: 0, full: 0, why: [] };
      stubs[d.id].push(...af.stubs(d.dev, i, cost, area));
      if (af.passive(d.dev, i)) { O(d).ifs[i.id].state = isLoopback(i) ? 'LOOP' : 'PASSIVE'; continue; }
      for (const e of l2Explore(state, d.dev.id, i)) {
        const x = nodeAt(e.dev, e.iface), j = e.iface;
        if (!x || !isNode.has(x.id) || !running(x, j) || !af.peer(i, j)) continue;
        const k = [key(d, i), key(x, j)].sort().join('~');
        if (seenPair.has(k)) continue;
        seenPair.add(k);
        if (af.passive(x.dev, j)) continue; // 對面不送 Hello
        const why = af.mismatch(d.dev, i, x.dev, j, af.area(d.dev, i), af.area(x.dev, j)) || (rid[d.id] === rid[x.id] ? `Router ID 重複（兩台都是 ${fmtIp(rid[d.id])}）` : '');
        pairs.push({ a: { d, i }, b: { d: x, i: j }, area: af.area(d.dev, i), why, k });
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
    if (!running(d, i) || af.passive(d.dev, i) || af.netType(i) !== 'broadcast' || parent[key(d, i)] != null) continue;
    groups[key(d, i)] = new Map([[key(d, i), { d, i }]]);
  }
  const role = {}; // 介面 → 'DR' | 'BDR' | 'DROTHER' | 'P2P'
  const segOf = {}; // 介面 → 網段紀錄
  const seenSeg = new Set();
  for (const members of Object.values(groups)) {
    const list = [...members.values()];
    const p2p = list.every((s) => af.netType(s.i) === 'point-to-point');
    if (p2p) { for (const s of list) role[key(s.d, s.i)] = 'P2P'; continue; }
    const s0 = list[0];
    const sk = af.segKey(list, af.area(s0.d.dev, s0.i));
    seenSeg.add(sk);
    let seg = segT[sk];
    if (!seg) seg = segT[sk] = { since: dyn.boot ? -1e9 : now, dr: null, bdr: null };
    const ids = new Set(list.map((s) => key(s.d, s.i)));
    // 剛 clear ip ospf process 的路由器：重新啟動中，這段時間不參加選舉
    const cleared = seg.cleared || {};
    for (const k of Object.keys(cleared)) if (cleared[k] <= now) delete cleared[k];
    for (const t of new Set(Object.values(cleared))) state.rt.pending.push({ at: t, dev: s0.d.dev.id, kind: 'ospf', text: `${s0.d.name}：${af.name} 程序重新啟動中，等 Wait timer 之後才參加 DR 選舉` });
    const elig = list.filter((s) => af.prio(s.i) > 0 && !cleared[key(s.d, s.i)]);
    const better = (a, b) => af.prio(a.i) - af.prio(b.i) || (rid[a.d.id] >>> 0) - (rid[b.d.id] >>> 0);
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
      state.rt.pending.push({ at: seg.since + OSPF_WAIT, dev: s0.d.dev.id, kind: 'ospf', text: `${s0.d.name}：${af.name} 正在等 Wait timer，之後才選 DR / BDR` });
    }
    for (const s of list) { const k = key(s.d, s.i); role[k] = !seg.dr && !seg.bdr ? 'WAITING' : k === seg.dr ? 'DR' : k === seg.bdr ? 'BDR' : 'DROTHER'; segOf[k] = seg; }
  }
  for (const k of Object.keys(segT)) if (!seenSeg.has(k)) delete segT[k];

  // 3. 每一對鄰居的狀態：計時、FULL / 2WAY / EXSTART
  const adj = {}; // 區域 → 設備 → [{ to, iface, via, cost }]
  const seen = new Set();
  const edge = (area, a, b, stale) => {
    ((adj[area] ||= {})[a.d.id] ||= []).push({ to: b.d.id, iface: a.i, via: af.addr(b.i), cost: af.cost(state, a.d.dev, a.i), stale });
  };
  for (const p of pairs) {
    const { a, b } = p;
    for (const [s, o] of [[a, b], [b, a]]) {
      const inf = O(s.d).ifs[s.i.id];
      inf.nbrs++;
      if (p.why) inf.why.push(`${o.d.name}：${p.why}`);
    }
    if (p.why) continue;
    let rec = adjT[p.k];
    if (!rec) rec = adjT[p.k] = { since: dyn.boot ? -1e9 : now };
    if (rec.gone) { rec.since = now; delete rec.gone; }
    rec.last = now;
    rec[key(a.d, a.i)] = { ip: af.enc(af.addr(a.i)), cost: af.cost(state, a.d.dev, a.i) };
    rec[key(b.d, b.i)] = { ip: af.enc(af.addr(b.i)), cost: af.cost(state, b.d.dev, b.i) };
    seen.add(p.k);
    const ra = role[key(a.d, a.i)], rb = role[key(b.d, b.i)];
    const p2p = ra === 'P2P';
    const seg = segOf[key(a.d, a.i)];
    const up = rec.since + (p2p ? P2P_UP : seg && seg.since + OSPF_WAIT <= rec.since ? JOIN_UP : 0) - now;
    const waitSeg = seg && seg.since + OSPF_WAIT > now;
    const mtuBad = mtuOf(a.i) !== mtuOf(b.i) && !a.i.ospfMtuIgnore && !b.i.ospfMtuIgnore;
    const typeBad = af.netType(a.i) !== af.netType(b.i);
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
      const dead = Math.max(1, af.dead(s.i) - ((now - Math.max(rec.since, 0)) % af.hello(s.i)));
      NB(s.d).push({ dev: o.d.dev.id, iface: s.i.id, ip: af.addr(o.i), rid: rid[o.d.id], prio: af.prio(o.i), cost: af.cost(state, s.d.dev, s.i), state: st === 'FULL' || st === '2WAY' ? st.toLowerCase() : st === 'EXSTART' ? 'exstart' : 'forming', role: ro, left, dead,
        note: st === 'EXSTART' ? `MTU 不一致（這一端 ${mtuOf(s.i)}，對面 ${mtuOf(o.i)}）：資料庫交換卡在 EXSTART` : typeBad ? `網路類型不一致（這一端 ${af.netType(s.i)}，對面 ${af.netType(o.i)}）` : '' });
      if (st === 'FULL') O(s.d).ifs[s.i.id].full++;
    }
    if (left(st)) state.rt.pending.push({ at: now + left(st), dev: a.d.dev.id, kind: 'ospf', text: `${a.d.name} ↔ ${b.d.name}：${af.name} 鄰居關係建立中` });
    // 網路類型不一致：鄰居是 FULL，但兩邊的 LSA 對不起來，SPF 算不出經過這條線的路
    if (st !== 'FULL' && st !== '2WAY') continue;
    if (typeBad) continue;
    if (!p2p && !(segOf[key(a.d, a.i)] || {}).dr) continue;
    edge(p.area, a, b); edge(p.area, b, a);
    function left(x) { return x === 'INIT' ? seg.since + OSPF_WAIT - now : x === 'LOADING' ? up : 0; }
  }
  for (const d of nodes) for (const [id, inf] of Object.entries(O(d).ifs)) {
    if (inf.state === 'PASSIVE' || inf.state === 'LOOP') continue;
    inf.state = role[key(d, { id })] || (inf.nbrs ? 'DOWN' : inf.type === 'point-to-point' ? 'P2P' : 'DR');
    inf.dr = segOf[key(d, { id })] ? segOf[key(d, { id })].dr : null;
    inf.bdr = segOf[key(d, { id })] ? segOf[key(d, { id })].bdr : null;
  }

  // 4. 這一次沒聽到的鄰居：自己的介面還亮著，要等 Dead timer 到期才會把它從資料庫拿掉
  const ghosts = new Set();
  for (const [k, rec] of Object.entries(adjT)) {
    if (seen.has(k)) continue;
    // 節點 id 可能是「設備@VRF」；介面 id 裡也可能有 /（Gi0/0/1），所以從第一個 / 切開
    const sides = k.split('~').map((s) => ({ s, dev: s.slice(0, s.indexOf('/')), iface: s.slice(s.indexOf('/') + 1) }));
    const di = devs[sides[0].dev] && devs[sides[0].dev].ifaces.find((x) => x.id === sides[0].iface);
    const deadT = di ? af.dead(di) : 40;
    if (now - rec.last >= deadT || rec.since + P2P_UP > rec.last) { delete adjT[k]; continue; }
    rec.gone = true;
    for (const [a, b] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
      const d = devs[a.dev], other = devs[b.dev];
      if (!d || !other || !rec[b.s]) continue;
      const i = d.ifaces.find((x) => x.id === a.iface);
      const believes = isNode.has(d.id) && running(d, i);
      if (!believes && isNode.has(d.id)) continue;
      if (!isNode.has(d.id)) ghosts.add(d.id);
      const area = i ? af.area(d.dev, i) ?? 0 : 0;
      ((adj[area] ||= {})[d.id] ||= []).push({ to: b.dev, iface: i, via: af.dec(rec[b.s].ip), cost: rec[a.s] ? rec[a.s].cost : 1, stale: true });
      if (!believes) continue;
      const leftT = rec.last + deadT - now;
      NB(d).push({ dev: other.dev.id, iface: a.iface, ip: af.dec(rec[b.s].ip), rid: rid[b.dev] ?? (ridTbl(other)[other.dev.id] || {}).rid, prio: 1, cost: rec[a.s] ? rec[a.s].cost : 1, state: 'dying', role: 'DROTHER', left: leftT, dead: leftT });
      state.rt.pending.push({ at: rec.last + deadT, dev: d.dev.id, kind: 'ospf', text: `${d.name} 還沒發現 ${other.name} 已經失聯（${af.name} Dead timer）` });
    }
  }
  for (const id of ghosts) stubs[id] = (lsaT[id] || []).map((x) => ({ ...x, net: af.dec(x.net) }));
  for (const d of nodes) lsaT[d.id] = stubs[d.id].map((x) => ({ ...x, net: af.enc(x.net) }));
  for (const id of Object.keys(lsaT)) if (!isNode.has(id) && !ghosts.has(id)) delete lsaT[id];

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
  const maxPaths = (d) => Math.max(1, Math.min(32, +af.maxPaths(d) || 4));
  const ranges = af.ranges;
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
  function ownDev(id) { return devs[id] && isNode.has(id) ? devs[id] : null; }
  for (const b of abrs) {
    const D = ownDev(b);
    const t = intra[b] || {};
    const s0 = (sumInto0[b] = {});
    for (const r of Object.values(t)) {
      if (r.area === 0) continue;
      const rg = D ? ranges(D, r.area).find((x) => af.netOf(r.net, x.bits) === x.net && r.bits >= x.bits) : null;
      const k = rg ? rg.net + '/' + rg.bits : r.net + '/' + r.bits;
      const cur = s0[k];
      if (!cur || r.metric > cur.cost) s0[k] = { net: rg ? rg.net : r.net, bits: rg ? rg.bits : r.bits, cost: r.metric, range: !!rg };
    }
  }
  // 骨幹裡的路由器（包括 ABR）：從其他 ABR 的 summary 算出區域間的路由
  const inter = {}; // 設備 → '網段' → { net, bits, metric, hops }
  const addInter = (id, s, metric, hops, adv) => {
    const t = (inter[id] ||= {}), k = s.net + '/' + s.bits;
    if ((intra[id] || {})[k]) return; // 區域內的路由永遠優先
    const cur = t[k];
    if (!cur || metric < cur.metric) t[k] = { net: s.net, bits: s.bits, metric, hops: hops.slice(), owner: adv };
    else if (metric === cur.metric) for (const h of hops) if (!cur.hops.some((x) => x.via === h.via && x.iface === h.iface)) cur.hops.push(h);
  };
  for (const d of nodes) {
    if (!areasOf(d.id).includes(0)) continue;
    const { dist, first } = spf[d.id][0];
    for (const b of abrs) {
      if (b === d.id || dist[b] == null) continue;
      for (const s of Object.values(sumInto0[b] || {})) addInter(d.id, s, dist[b] + s.cost, first[b] || [], b);
    }
  }
  // ABR 再把骨幹的網段、以及從骨幹學到的其他區域，送進自己連著的非骨幹區域
  //   stub / NSSA 的 no-summary（totally stubby / totally NSSA）：區域間的路一筆都不送，只送一筆預設的 Summary LSA
  //   stub：一定會送預設的 Summary LSA（cost 是 area x default-cost，預設 1），因為 Type-5 進不來，區域裡的路由器需要一條往外的路
  const atype = (id, area) => (ownDev(id) ? af.areaType(ownDev(id), area) : 'normal');
  const acfg = (id, area) => (ownDev(id) ? af.areaCfg(ownDev(id), area) : {});
  for (const b of abrs) {
    for (const area of areasOf(b)) {
      if (area === 0) continue;
      const out = ((sumOut[b] ||= {})[area] = {});
      const t = atype(b, area), c = acfg(b, area);
      if (!(t !== 'normal' && c.noSum)) {
        for (const r of Object.values(intra[b] || {})) if (r.area === 0) out[r.net + '/' + r.bits] = { net: r.net, bits: r.bits, cost: r.metric };
        for (const r of Object.values(inter[b] || {})) out[r.net + '/' + r.bits] = { net: r.net, bits: r.bits, cost: r.metric };
        // 其他非骨幹區域裡、這台 ABR 自己就連著的網段
        for (const r of Object.values(intra[b] || {})) if (r.area !== 0 && r.area !== area) out[r.net + '/' + r.bits] = { net: r.net, bits: r.bits, cost: r.metric };
      }
      if (t === 'stub' || (t === 'nssa' && c.noSum)) out[af.zero + '/0'] = { net: af.zero, bits: 0, cost: +c.cost || 1, def: true };
    }
  }
  for (const d of nodes) {
    if (abrs.has(d.id)) continue;
    for (const area of areasOf(d.id)) {
      if (area === 0) continue;
      const { dist, first } = spf[d.id][area];
      for (const b of abrs) {
        if (dist[b] == null) continue;
        for (const s of Object.values(((sumOut[b] || {})[area]) || {})) addInter(d.id, s, dist[b] + s.cost, first[b] || [], b);
      }
    }
  }

  // 6. 外部路由
  //    Type-5（ASBR 送出、整個 OSPF 網域的一般區域都看得到）：default-information originate 的預設路由（E2、metric 1）與 redistribute 進來的路
  //    Type-7（NSSA 裡的 ASBR 送出、只留在那個 NSSA）：O N1 / N2；Router ID 最大的 NSSA ABR 把它轉成 Type-5 送進骨幹
  //    E2 / N2：metric 固定，不管離 ASBR 多遠；一樣的時候才比往 ASBR（或 forwarding address）的內部 cost (forward metric)
  //    E1 / N1：metric 再加上內部 cost。同一個網段 type 1 永遠比 type 2 優先；區域內、區域間的路又比外部優先
  const ownDefault = (d) => af.routes(d).some((r) => (r.vrf || '') === d.vrf && r.bits === 0 && !r.bad && r.type !== 'O');
  const normalAreas = (id) => areasOf(id).filter((a) => atype(id, a) === 'normal');
  const nssaAreas = (id) => areasOf(id).filter((a) => atype(id, a) === 'nssa');
  const extsOf = (d) => [...(af.originates(d) && ownDefault(d) ? [{ net: af.zero, bits: 0, metric: 1, type: 2, tag: 0, def: true }] : []), ...af.externals(d)];
  const extList = new Map(nodes.map((d) => [d, extsOf(d)]));
  // 送得出 Type-5 的 ASBR：至少要有一個一般區域（骨幹也算）。只在 stub 區域裡的路由器重分配了也送不出去
  const asbr5 = nodes.filter((d) => extList.get(d).length && normalAreas(d.id).length);
  // Type-7：NSSA 裡的 ASBR（包括 NSSA 的 ABR 自己重分配的，除非 no-redistribution）
  const type7 = {}; // 區域 → [{ net, bits, metric, type, tag, asbr, fa, def?, noP? }]
  for (const d of nodes) {
    const ex = af.externals(d);
    for (const a of nssaAreas(d.id)) {
      const c = acfg(d.id, a), fa = af.fa(d, a);
      if (!(c.noRedist && abrs.has(d.id))) for (const e of ex) (type7[a] ||= []).push({ ...e, asbr: d.id, fa });
      // area x nssa default-information-originate：ABR 一定送；區域裡一般的 ASBR 要自己有預設路由才送。P-bit 沒有設，不會被轉成 Type-5
      if (c.nssaDef && (abrs.has(d.id) || ownDefault(d))) (type7[a] ||= []).push({ net: af.zero, bits: 0, metric: c.nssaDefMetric != null ? +c.nssaDefMetric : 1, type: +c.nssaDefType === 1 ? 1 : 2, tag: 0, def: true, asbr: d.id, fa: 0, noP: true });
    }
  }
  // 轉換：每個 NSSA 由 Router ID 最大的 NSSA ABR 負責，轉出來的 Type-5 由它發布，forwarding address 是原本 ASBR 的位址
  const translators = {}; // 區域 → ABR
  const translated = []; // [{ ...e, area, by }]
  for (const [a, list] of Object.entries(type7)) {
    for (const e of list) {
      const tr = [...abrs].filter((b) => isNode.has(b) && atype(b, +a) === 'nssa' && spf[b] && spf[b][+a] && spf[b][+a].dist[e.asbr] != null).sort((x, y) => (rid[y] >>> 0) - (rid[x] >>> 0))[0];
      if (!tr) continue;
      (translators[a] ||= new Set()).add(tr);
      if (!e.noP && e.fa != null) translated.push({ ...e, area: +a, by: tr });
    }
  }
  const merge = (hops, h) => { for (const y of h) if (!hops.some((z) => z.via === y.via && z.iface === y.iface)) hops.push(y); };
  /** 往某台 ASBR 的內部 cost 與第一站：只能走一般區域（Type-5 與 ASBR summary 不會進 stub / NSSA）。同一個區域就看 SPF；在別的區域就經過 ABR */
  const toAsbr = (d, a) => {
    let c = null, hops = [];
    const cand = (x, h) => { if (h && h.length && (c == null || x < c)) { c = x; hops = h.slice(); } else if (h && c === x) merge(hops, h); };
    const aNormal = normalAreas(a.id);
    for (const area of normalAreas(d.id)) {
      const sp = spf[d.id][area];
      if (sp.dist[a.id] != null) { cand(sp.dist[a.id], sp.first[a.id]); continue; }
      for (const b of abrs) {
        if (sp.dist[b] == null || !spf[b]) continue;
        for (const [ar, v] of Object.entries(spf[b])) if (v.dist[a.id] != null && aNormal.includes(+ar) && atype(b, +ar) === 'normal') cand(sp.dist[b] + v.dist[a.id], sp.first[b]);
      }
    }
    return c == null ? null : { c, hops };
  };
  /** 往 forwarding address 的路：查自己的區域內、區域間路由（最長相符） */
  const toFa = (d, fa) => {
    let best = null;
    for (const t of [intra[d.id] || {}, inter[d.id] || {}]) for (const r of Object.values(t)) if (af.netOf(fa, r.bits) === r.net && (!best || r.bits > best.bits)) best = r;
    return best && best.hops.length ? { c: best.metric, hops: best.hops } : null;
  };
  const extCmp = (x, y) => x.type - y.type || x.metric - y.metric || (x.type === 2 ? x.fwd - y.fwd : 0);
  for (const d of nodes) {
    const ext = {};
    const add = (k, cand) => {
      if ((intra[d.id] || {})[k] || (inter[d.id] || {})[k]) return;
      const cur = ext[k], c = cur ? extCmp(cand, cur) : -1;
      if (c < 0) ext[k] = cand;
      else if (c === 0) merge(cur.hops, cand.hops);
    };
    // Type-5：自己至少要在一個一般區域裡才收得到（stub、NSSA 區域裡的路由器完全看不到）
    if (normalAreas(d.id).length) {
      for (const a of asbr5) {
        if (a === d) continue;
        const p = toAsbr(d, a);
        if (!p) continue;
        for (const e of extList.get(a)) {
          if (e.def && ownDefault(d)) continue;
          add(e.net + '/' + e.bits, { net: e.net, bits: e.bits, type: e.type, metric: e.type === 1 ? p.c + e.metric : e.metric, fwd: p.c, hops: p.hops.slice(), asbr: a.id, tag: e.tag });
        }
      }
      for (const e of translated) {
        if (e.by === d.id || areasOf(d.id).includes(e.area)) continue; // 自己就在那個 NSSA 裡：用 Type-7
        const p = toFa(d, e.fa);
        if (!p) continue;
        add(e.net + '/' + e.bits, { net: e.net, bits: e.bits, type: e.type, metric: e.type === 1 ? p.c + e.metric : e.metric, fwd: p.c, hops: p.hops.slice(), asbr: e.by, tag: e.tag, fa: e.fa });
      }
    }
    // Type-7：自己所在的 NSSA 裡的 ASBR 送的
    for (const area of nssaAreas(d.id)) {
      const sp = spf[d.id][area];
      for (const e of type7[area] || []) {
        if (e.asbr === d.id || sp.dist[e.asbr] == null || !(sp.first[e.asbr] || []).length) continue;
        if (e.def && ownDefault(d)) continue;
        const c = sp.dist[e.asbr];
        add(e.net + '/' + e.bits, { net: e.net, bits: e.bits, type: e.type, nssa: true, metric: e.type === 1 ? c + e.metric : e.metric, fwd: c, hops: sp.first[e.asbr].slice(), asbr: e.asbr, tag: e.tag });
      }
    }
    O(d).exts = ext;
  }
  const isTranslator = new Set(Object.values(translators).flatMap((s) => [...s]));
  const asbrs = nodes.filter((d) => extList.get(d).length || isTranslator.has(d.id));

  // 7. 裝進路由表：每個等價的第一站各一筆（最多 maximum-paths 條）
  for (const d of nodes) {
    const put = (r, sub) => {
      if (af.routes(d).some((x) => (x.vrf || '') === d.vrf && x.type === 'C' && x.net === r.net && x.bits === r.bits)) return;
      const hops = r.hops.filter((h) => h.iface).slice(0, maxPaths(d));
      // adv：發布這筆 LSA 的路由器（show ip route <網段> 的 from），E2 / N2 另外記往 ASBR 的內部 cost (forward metric)
      const adv = r.owner != null ? rid[r.owner] : null;
      for (const h of hops) af.routes(d).push({ net: r.net, bits: r.bits, via: h.via, iface: h.iface, type: 'O', sub, ad: 110, metric: r.metric, adv, ...(d.vrf ? { vrf: d.vrf } : {}), ...(r.fwd != null ? { fwd: r.fwd } : {}), ...(r.tag ? { tag: r.tag } : {}) });
    };
    for (const r of Object.values(intra[d.id] || {})) if (r.hops.length) put(r, '');
    for (const r of Object.values(inter[d.id] || {})) put(r, 'IA');
    for (const e of Object.values(O(d).exts || {})) put({ net: e.net, bits: e.bits, metric: e.metric, hops: e.hops, owner: e.asbr, fwd: e.fwd, tag: e.tag }, (e.nssa ? 'N' : 'E') + (e.type === 1 ? 1 : 2));
    O(d).abr = abrs.has(d.id);
    O(d).asbr = asbrs.includes(d);
    O(d).areas = areasOf(d.id);
    O(d).kinds = Object.fromEntries(areasOf(d.id).map((a) => [a, atype(d.id, a)]));
    O(d).translates = Object.entries(translators).filter(([, b]) => b.has(d.id)).map(([a]) => +a);
    // show ip ospf database 只列同一個網域的 LSA：每個區域裡 SPF 走得到的路由器
    O(d).lsdb = Object.fromEntries(areasOf(d.id).map((a) => [a, Object.keys(spf[d.id][a].dist)]));
    O(d).id = d.id;
  }
  // 給 show ip ospf database 用
  state.rt[af.key] = { stubs, abrs: [...abrs], sumInto0, sumOut, rid, asbrs: asbr5.map((d) => d.id), exts: Object.fromEntries(asbr5.map((d) => [d.id, extList.get(d)])), type7, translated, domain: domainOf(nodes, adj) };
}

/** 同一個 OSPF 網域（彼此有鄰居關係連起來的程序）：show ip ospf database 用來只列自己網域的 LSA */
function domainOf(nodes, adj) {
  const p = {};
  const f = (x) => (p[x] == null || p[x] === x ? (p[x] = x) : (p[x] = f(p[x])));
  for (const g of Object.values(adj)) for (const [a, es] of Object.entries(g)) for (const e of es) p[f(a)] = f(e.to);
  return Object.fromEntries(nodes.map((d) => [d.id, f(d.id)]));
}
