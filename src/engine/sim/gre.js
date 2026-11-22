// Tunnel 介面：點對點 GRE、mGRE（DMVPN）、IPsec VTI，以及 DMVPN 用的 NHRP
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
//
// 設定（IOS 路由器的 Tunnel 介面，bind = { t: 'gre', n }）：
//   i.tun  = { src: 介面 id 或 IP, dst: 'x.x.x.x', mode: 'gre' | 'mgre' | 'ipsec', key, ka: { sec, retry }, prot: IPsec profile 名稱 }
//   i.nhrp = { id: network-id, auth, hold, nhs: [{ ip, nbma, mcast }], maps: [{ ip, nbma }], mcast: ['dynamic' | NBMA], redirect, shortcut }
// 執行期：i.rt.tun = { up, why, src, dst, mtu, peers: [...], nhs: [...] }
//   peers：這個介面知道的對端（Tunnel 位址 → NBMA 位址），轉送與 OSPF 都看這張表
// 跨次計算保留的狀態：state.dyn.nhrpReg（hub 收到的註冊）、state.dyn.nhrpRes（spoke 解析到的對端與捷徑）、
//   state.dyn.greKa（keepalive 沒有回應的起點）、state.dyn.greRecur（recursive routing 被暫停到什麼時候）
import { fmtIp, netOf, parseIp, sameNet } from '../ip.js';
import { IPSEC_OVERHEAD, ipMtu } from '../mtu.js';
import { QUIET, setQuiet } from './core.js';
import { forward } from './forward.js';
import { lookupRoute } from './l3.js';

export const GRE_OVERHEAD = 24; // 外層 IP 20 + GRE 4
export const NHRP_HOLD = 7200; // ip nhrp holdtime 的預設值
export const RECUR_HOLD = 30; // 偵測到 recursive routing 之後，Tunnel 暫停多久才再試一次
export const isTun = (i) => !!i && !!i.bind && i.bind.t === 'gre';
export const tunMode = (i) => (i.tun && i.tun.mode) || 'gre';
export const MODE_TEXT = { gre: 'GRE/IP', mgre: 'multi-GRE/IP', ipsec: 'IPSEC/IP' };
const keyOf = (i) => (i.tun && i.tun.key != null && i.tun.key !== '' ? +i.tun.key : null);
const holdOf = (i) => +(i.nhrp && i.nhrp.hold) || NHRP_HOLD;
const nhrpOn = (i) => !!(i.nhrp && i.nhrp.id != null && i.nhrp.id !== '');
const kOf = (d, i) => d.id + '/' + i.id;

/** 所有路由器上的 Tunnel 介面 */
export function tunIfaces(state) {
  const out = [];
  for (const d of Object.values(state.devices)) for (const i of d.ifaces) if (isTun(i)) out.push({ d, i });
  return out;
}

/** tunnel source：寫介面就用那個介面的位址，寫 IP 就要是自己某個介面上的位址 */
export function tunSource(d, i) {
  const s = (i.tun && i.tun.src) || '';
  if (!s) return { why: '還沒有設定 tunnel source' };
  let x = d.ifaces.find((y) => y.id === s);
  const ip = x ? null : parseIp(s);
  if (!x && ip != null) x = d.ifaces.find((y) => y.rt && y.rt.ip === ip);
  if (!x) return { why: ip != null ? `這台沒有 ${s} 這個位址（tunnel source 要是自己介面上的位址）` : `tunnel source ${s} 不存在` };
  if (isTun(x)) return { why: 'tunnel source 不能是另一個 Tunnel 介面', iface: x };
  if (x.rt.ip == null) return { why: `tunnel source ${x.label} 沒有 IP 位址`, iface: x };
  if (!x.rt.link) return { why: `tunnel source ${x.label} 沒有連線`, iface: x };
  return { ip: ip != null ? ip : x.rt.ip, iface: x };
}

/** Tunnel 的 IP MTU：外層介面的 MTU 扣掉 GRE（24）或 ESP（約 73）的標頭；GRE 再加上 tunnel protection 兩個都要扣 */
export function tunOverhead(i) {
  const m = tunMode(i);
  return m === 'ipsec' ? IPSEC_OVERHEAD : GRE_OVERHEAD + (i.tun && i.tun.prot ? IPSEC_OVERHEAD : 0);
}

// ───────────────────────── 第一步：只看設定與外層的路由 ─────────────────────────

/** 外層（underlay）的路由算好之後：Tunnel 的 line protocol 先看設定和「有沒有路到 destination」 */
export function greLines(state, list) {
  const down = state.down || {}, now = state.clock, recur = (state.dyn.greRecur ||= {});
  for (const { d, i } of list) {
    const rt = (i.rt.tun = { up: false, ok1: false, why: '', mode: tunMode(i), src: null, dst: null, srcIf: '', out: '', mtu: 0, peers: [], nhs: [] });
    if (down[d.id] || state.rt.off[d.id]) { rt.why = '設備沒有開機'; continue; }
    if (i.shut) { rt.why = 'administratively down（介面被 shutdown）'; rt.admin = true; continue; }
    const s = tunSource(d, i);
    rt.srcIf = s.iface ? s.iface.label : '';
    rt.mtu = ipMtu(state, d, s.iface || null) - tunOverhead(i);
    if (s.why) { rt.why = s.why; continue; }
    rt.src = s.ip;
    if (rt.mode === 'ipsec' && !i.tun.prot) { rt.why = 'tunnel mode ipsec ipv4 一定要有 tunnel protection ipsec profile <名稱>'; continue; }
    if (i.tun.prot && !(d.ipsecProfiles || {})[i.tun.prot]) { rt.why = `IPsec profile ${i.tun.prot} 不存在（crypto ipsec profile ${i.tun.prot}）`; continue; }
    if (rt.mode !== 'mgre') {
      const dst = parseIp((i.tun && i.tun.dst) || '');
      if (dst == null) { rt.why = '還沒有設定 tunnel destination'; continue; }
      rt.dst = dst;
      const r = lookupRoute(d, dst);
      if (!r) { rt.why = `沒有通往 tunnel destination ${fmtIp(dst)} 的路由`; continue; }
      rt.out = r.iface.label;
    }
    // 剛剛因為 recursive routing 被暫停：時間到了才再試
    const rc = recur[kOf(d, i)];
    if (rc && rc.until > now) {
      rt.why = `temporarily disabled due to recursive routing：往 tunnel destination 的最佳路由（${rc.type} ${rc.net}）走的是 ${rc.via} 自己（第 ${rc.n} 次），${Math.ceil(rc.until - now)} 秒後再試。Tunnel 的 destination 一定要從外層（實體線路）學到，不能從 Tunnel 裡面學到`;
      rt.recur = true;
      state.rt.pending.push({ at: rc.until, dev: d.id, kind: 'tun', text: `${d.name}：${i.label} 因為 recursive routing 暫停中` });
      continue;
    }
    rt.ok1 = rt.base = true; // base：設定與外層的路由都沒問題（IPsec 要不要建 SA 看這個，不看 VTI 自己的 line protocol）
  }
}

// ───────────────────────── 第二步：GRE 封包真的送得到對面嗎 ─────────────────────────

/** 從 src 送一個 GRE 封包到 dst（不記入紀錄），看對面哪一個 Tunnel 介面收下 */
function probe(state, d, src, dst, key) {
  const prev = setQuiet(true);
  try {
    const ctx = { ct: {}, log: [], hops: [], l3: [] };
    const r = forward(state, ctx, d.id, { proto: 'gre', src, dst, sport: 0, dport: 0, ttl: 255, greKey: key, outer: true, probe: true });
    if (r.ok && r.gre) return { ok: true, dev: r.dev, iface: r.gre };
    return { ok: false, why: r.reason || `${fmtIp(dst)} 沒有對應的 Tunnel 介面` };
  } finally { setQuiet(prev); }
}

/** 收到 GRE 封包：找出 tunnel source 是這個位址、而且（點對點的話）destination 是送來的那一端的 Tunnel 介面 */
export function greRx(state, dev, pkt) {
  const mine = dev.ifaces.filter((j) => isTun(j) && tunMode(j) !== 'ipsec' && j.rt && j.rt.tun && j.rt.tun.src === pkt.dst);
  const m = mine.filter((j) => tunMode(j) === 'mgre' || j.rt.tun.dst === pkt.src);
  if (!m.length) {
    return { why: `${dev.name} 收到 ${fmtIp(pkt.src)} 送來的 GRE 封包，但沒有 tunnel source ${fmtIp(pkt.dst)}、tunnel destination ${fmtIp(pkt.src)} 的 Tunnel 介面${mine.length ? `（${mine.map((j) => j.label).join('、')} 的 destination 是 ${mine.map((j) => (j.rt.tun.dst != null ? fmtIp(j.rt.tun.dst) : '未設定')).join('、')}）` : ''}：回 ICMP protocol unreachable` };
  }
  const k = m.find((j) => keyOf(j) === (pkt.greKey ?? null));
  if (!k) return { why: `tunnel key 不一致：封包帶的 key 是 ${pkt.greKey ?? '（沒有）'}，${dev.name} 的 ${m[0].label} 設定的是 ${keyOf(m[0]) ?? '（沒有）'}。key 對不上的 GRE 封包直接丟棄` };
  if (pkt.probe ? !k.rt.tun.ok1 : !k.rt.tun.up) return { why: `${dev.name} 的 ${k.label} 是 line protocol down（${k.rt.tun.why || '沒有啟用'}），收到的 GRE 封包被丟掉` };
  return { iface: k };
}

/** keepalive：對面沒有回應超過 period × retries 秒，line protocol 才會 down */
function kaCheck(state, d, i, ok, why) {
  const ka = i.tun && i.tun.ka;
  if (!ka || !(+ka.sec > 0)) return true;
  const tbl = (state.dyn.greKa ||= {}), k = kOf(d, i), now = state.clock;
  if (ok) { delete tbl[k]; return true; }
  const rec = (tbl[k] ||= { lost: state.dyn.boot ? -1e9 : now });
  const until = rec.lost + (+ka.sec) * (+ka.retry || 3);
  if (now < until) {
    state.rt.pending.push({ at: until, dev: d.id, kind: 'tun', text: `${d.name}：${i.label} 的 GRE keepalive 沒有回應` });
    i.rt.tun.kaLeft = Math.ceil(until - now);
    return true;
  }
  i.rt.tun.why = `GRE keepalive 連續 ${+ka.retry || 3} 次沒有回應：${why}`;
  return false;
}

/** 一個介面可以送 multicast（OSPF Hello）給哪些對端：鍵是對面的設備/介面 */
function mcastEdge(state, a, b, why) {
  const E = (state.rt.greEdges ||= {});
  const ka = kOf(a.d, a.i), kb = kOf(b.d, b.i);
  const ab = ((E[ka] ||= {})[kb] ||= { dev: b.d.id, iface: b.i.id, fwd: false, back: false, why: '' });
  const ba = ((E[kb] ||= {})[ka] ||= { dev: a.d.id, iface: a.i.id, fwd: false, back: false, why: '' });
  if (why) { ab.whyF = why; ba.whyB = why; return; }
  ab.fwd = true; ba.back = true;
}

/** IPsec profile 套在 mGRE 上：這個介面要和哪些對端建立 IPsec SA（hub 那一端由 spoke 主動來建，見 tunnels.js） */
export function protPeers(state, d, i) {
  const rt = i.rt.tun;
  if (!rt || !rt.base || !i.tun.prot) return [];
  if (rt.mode !== 'mgre') return rt.dst != null ? [rt.dst] : [];
  const out = new Set();
  for (const n of (i.nhrp && i.nhrp.nhs) || []) { const x = nhsNbma(i, n); if (x != null) out.add(x); }
  for (const m of (i.nhrp && i.nhrp.maps) || []) { const x = parseIp(m.nbma || ''); if (x != null) out.add(x); }
  for (const e of Object.values(resOf(state, d, i))) out.add(e.nbma);
  return [...out];
}
const nhsNbma = (i, n) => parseIp(n.nbma || '') ?? parseIp((((i.nhrp && i.nhrp.maps) || []).find((m) => m.ip === n.ip) || {}).nbma || '');
/** 這個 spoke 解析到的對端（還沒過期的） */
function resOf(state, d, i) {
  const t = ((state.dyn.nhrpRes || {})[kOf(d, i)]) || {};
  const out = {};
  for (const [ip, e] of Object.entries(t)) if (e.exp > state.clock) out[ip] = e;
  return out;
}

/** IPsec 建好之後：VTI 的 line protocol、keepalive、NHRP 的註冊、每個 Tunnel 的對端清單 */
export function greReach(state, list) {
  const now = state.clock;
  state.rt.greEdges = {};
  const regs = (state.dyn.nhrpReg ||= {}), seenReg = {};
  // VTI：line protocol 跟著 IPsec SA
  for (const { d, i } of list) {
    const rt = i.rt.tun;
    if (!rt.ok1 || rt.mode !== 'ipsec') continue;
    const T = d.rt.tunnels.find((t) => t.tif === i.id);
    if (!T || !T.up) { rt.ok1 = false; rt.why = `IPsec SA 還沒有建立：${T ? T.why : '找不到對應的 IPsec 設定'}（VTI 的 line protocol 跟著 IPsec SA，SA 起不來 Tunnel 就是 down）`; rt.vtiDown = true; }
  }
  for (const { d, i } of list) {
    const rt = i.rt.tun;
    if (!rt.ok1) continue;
    const add = (p) => { rt.peers.push(p); return p; };
    if (rt.mode === 'ipsec') {
      const T = d.rt.tunnels.find((t) => t.tif === i.id);
      // SA 還沒過期、但對端已經失聯（stale）：line protocol 還是 up，只是 Hello 送不過去
      if (!T.peer) { rt.note = T.stale ? `對端已經沒有回應：${T.stale.why}` : ''; continue; }
      const pd = state.devices[T.peer.dev], pi = pd.ifaces.find((x) => x.id === T.peer.tif);
      if (pi) {
        add({ ip: pi.rt.ip, nbma: T.peerIp, dev: pd.id, iface: pi.id, mcast: true, ok: true, kind: 'p2p' });
        mcastEdge(state, { d, i }, { d: pd, i: pi });
      }
      continue;
    }
    if (rt.mode === 'gre') {
      const key = keyOf(i);
      const p = probe(state, d, rt.src, rt.dst, key);
      let ok = p.ok, why = p.why, back = null;
      if (p.ok) {
        const pd = state.devices[p.dev];
        back = tunMode(p.iface) === 'mgre' ? null : probe(state, pd, p.iface.rt.tun.src, rt.src, keyOf(p.iface));
        if (back && !back.ok) { ok = false; why = `回程：${back.why}`; }
        const peer = add({ ip: p.iface.rt.ip, nbma: rt.dst, dev: p.dev, iface: p.iface.id, mcast: true, ok, kind: 'p2p' });
        if (tunMode(p.iface) !== 'mgre') { mcastEdge(state, { d, i }, { d: pd, i: p.iface }); if (back && back.ok) mcastEdge(state, { d: pd, i: p.iface }, { d, i }); else mcastEdge(state, { d: pd, i: p.iface }, { d, i }, why); }
        else peer.hub = true;
      }
      if (!kaCheck(state, d, i, ok, why || '')) { rt.ok1 = false; continue; }
      if (!p.ok) rt.note = `GRE 封包送不到對面：${p.why}`;
    }
    // NHRP：spoke 向 NHS 註冊（mGRE 的 spoke，或 DMVPN phase 1 的點對點 spoke）
    if (nhrpOn(i)) {
      for (const n of (i.nhrp && i.nhrp.nhs) || []) {
        const nbma = nhsNbma(i, n);
        const st = { ip: n.ip, nbma, ok: false, why: '' };
        rt.nhs.push(st);
        if (nbma == null) { st.why = `不知道 NHS ${n.ip} 的 NBMA 位址（ip nhrp nhs ${n.ip} nbma <hub 的公用 IP>）`; continue; }
        if (rt.mode === 'gre' && rt.dst !== nbma) { st.why = `點對點 Tunnel 的 destination 不是 NHS 的 NBMA 位址 ${fmtIp(nbma)}`; continue; }
        const p = probe(state, d, rt.src, nbma, keyOf(i));
        if (!p.ok) { st.why = `Registration Request 送不到 NHS：${p.why}`; continue; }
        const hd = state.devices[p.dev], hub = p.iface;
        if (!nhrpOn(hub)) st.why = `${hd.name} 的 ${hub.label} 沒有啟用 NHRP（ip nhrp network-id）`;
        else if (((hub.nhrp.auth || '') !== ((i.nhrp && i.nhrp.auth) || ''))) st.why = `NHRP 的驗證字串不一致（ip nhrp authentication）：${hd.name} 丟掉了這個 Registration Request`;
        else if (hub.rt.ip == null || fmtIp(hub.rt.ip) !== n.ip) st.why = `NHS 的位址寫的是 ${n.ip}，但 ${hd.name} 的 ${hub.label} 是 ${hub.rt.ip != null ? fmtIp(hub.rt.ip) : '沒有位址'}`;
        else if (i.rt.ip == null || !sameNet(i.rt.ip, hub.rt.ip, hub.rt.bits)) st.why = `這一端的 Tunnel 位址和 hub 的 ${fmtIp(netOf(hub.rt.ip, hub.rt.bits))}/${hub.rt.bits} 不在同一個網段`;
        else {
          const back = probe(state, hd, hub.rt.tun.src, rt.src, keyOf(hub));
          if (!back.ok) st.why = `Registration Reply 回不來：${back.why}`;
          else {
            st.ok = true;
            const hk = kOf(hd, hub), t = (regs[hk] ||= {}), sip = fmtIp(i.rt.ip);
            const old = t[sip] && t[sip].nbma === rt.src ? t[sip] : null;
            t[sip] = { nbma: rt.src, dev: d.id, iface: i.id, since: old ? old.since : state.dyn.boot ? now - 600 : now, hold: holdOf(i) };
            (seenReg[hk] ||= new Set()).add(sip);
          }
        }
        if (rt.mode === 'mgre') {
          const reg = st.ok ? ((regs[kOf(hd, hub)] || {})[fmtIp(i.rt.ip)] || {}) : {};
          const peer = add({ ip: parseIp(n.ip), nbma, dev: p.dev, iface: hub.id, mcast: !!n.mcast || ((i.nhrp && i.nhrp.mcast) || []).includes(fmtIp(nbma)), ok: st.ok, kind: 'nhs', why: st.why, ...(reg.since != null ? { since: reg.since } : {}) });
          if (peer.mcast) mcastEdge(state, { d, i }, { d: hd, i: hub });
        }
      }
    }
  }
  // 沒有再註冊的 spoke 從 hub 的表裡拿掉
  for (const [hk, t] of Object.entries(regs)) for (const sip of Object.keys(t)) if (!(seenReg[hk] && seenReg[hk].has(sip))) delete t[sip];
  // hub：註冊上來的 spoke；加上 ip nhrp map multicast dynamic 才會把 multicast 複製給它們
  for (const { d, i } of list) {
    const rt = i.rt.tun;
    if (!rt.ok1 || rt.mode !== 'mgre') continue;
    const t = regs[kOf(d, i)] || {};
    const dyn = ((i.nhrp && i.nhrp.mcast) || []).includes('dynamic');
    for (const [sip, e] of Object.entries(t)) {
      const sd = state.devices[e.dev], si = sd && sd.ifaces.find((x) => x.id === e.iface);
      if (!si) continue;
      rt.peers.push({ ip: parseIp(sip), nbma: e.nbma, dev: e.dev, iface: e.iface, mcast: dyn, ok: true, kind: 'dyn', since: e.since, exp: e.since + e.hold });
      if (dyn) mcastEdge(state, { d, i }, { d: sd, i: si });
      else mcastEdge(state, { d, i }, { d: sd, i: si }, `${d.name} 的 ${i.label} 沒有 ip nhrp map multicast dynamic：OSPF 的 Hello 不會複製給註冊上來的 spoke`);
    }
  }
  // 靜態的對應（ip nhrp map）與解析到的 spoke：要真的雙向都送得到
  for (const { d, i } of list) {
    const rt = i.rt.tun;
    if (!rt.ok1 || rt.mode !== 'mgre') continue;
    const known = new Set(rt.peers.map((p) => p.ip));
    const extra = [
      ...((i.nhrp && i.nhrp.maps) || []).map((m) => ({ ip: parseIp(m.ip), nbma: parseIp(m.nbma || ''), kind: 'static' })),
      ...Object.entries(resOf(state, d, i)).map(([ip, e]) => ({ ip: parseIp(ip), nbma: e.nbma, kind: 'res', e })),
    ];
    for (const x of extra) {
      if (x.ip == null || x.nbma == null || known.has(x.ip)) continue;
      known.add(x.ip);
      const p = probe(state, d, rt.src, x.nbma, keyOf(i));
      const back = p.ok ? probe(state, state.devices[p.dev], p.iface.rt.tun.src, rt.src, keyOf(p.iface)) : null;
      const ok = p.ok && back.ok;
      const peer = { ip: x.ip, nbma: x.nbma, dev: p.ok ? p.dev : null, iface: p.ok ? p.iface.id : null, mcast: x.kind === 'static' && ((i.nhrp && i.nhrp.mcast) || []).includes(fmtIp(x.nbma)), ok, kind: x.kind, why: ok ? '' : p.ok ? `回程：${back.why}` : p.why };
      if (x.e) Object.assign(peer, { since: x.e.since, exp: x.e.exp });
      rt.peers.push(peer);
      if (ok && peer.mcast) mcastEdge(state, { d, i }, { d: state.devices[p.dev], i: p.iface });
    }
  }
  for (const { i } of list) i.rt.tun.up = i.rt.tun.ok1;
}

/** l2Explore 用：OSPF 的 Hello 從這個 Tunnel 介面送得到哪些路由器（只送得到單向的，附上原因） */
export function greExplore(state, devId, iface) {
  const E = ((state.rt.greEdges || {})[devId + '/' + iface.id]) || {};
  const out = [];
  for (const e of Object.values(E)) {
    if (!e.fwd && !e.back) continue;
    const d = state.devices[e.dev], j = d && d.ifaces.find((x) => x.id === e.iface);
    if (!j || !j.rt || !j.rt.tun || !j.rt.tun.up) continue;
    const oneWay = e.fwd && e.back ? '' : !e.fwd ? `只收得到對方的 Hello，這一端的 Hello 送不過去${e.whyF ? `（${e.whyF}）` : ''}` : `對方的 Hello 送不過來${e.whyB ? `（${e.whyB}）` : ''}`;
    out.push({ dev: d.id, iface: j, path: [], ...(oneWay ? { oneWay } : {}) });
  }
  return out;
}

/** 剛算好的路由：通往 tunnel destination（或 NHS）的最佳路由走的是 Tunnel 自己 → recursive routing，暫停這個 Tunnel */
export function greRecursion(state, list) {
  const recur = (state.dyn.greRecur ||= {}), now = state.clock;
  let hit = false;
  for (const { d, i } of list) {
    const rt = i.rt.tun;
    if (!rt.up) continue;
    const dsts = rt.mode === 'mgre' ? rt.nhs.map((n) => n.nbma).filter((x) => x != null) : [rt.dst];
    for (const dst of dsts) {
      const r = lookupRoute(d, dst);
      if (!r || !isTun(r.iface)) continue;
      const k = kOf(d, i), old = recur[k];
      recur[k] = { at: now, until: now + RECUR_HOLD, n: (old ? old.n : 0) + 1, via: r.iface.label, net: `${fmtIp(r.net)}/${r.bits}`, type: r.type };
      Object.assign(rt, { up: false, ok1: false, base: false, recur: true, why: `temporarily disabled due to recursive routing：往 ${fmtIp(dst)} 的最佳路由（${r.type} ${fmtIp(r.net)}/${r.bits}）走的是 ${r.iface.label}` });
      state.rt.pending.push({ at: now + RECUR_HOLD, dev: d.id, kind: 'tun', text: `${d.name}：${i.label} 因為 recursive routing 暫停中` });
      hit = true;
      break;
    }
  }
  return hit;
}

// ───────────────────────── 轉送 ─────────────────────────

/**
 * 封包要從 Tunnel 介面送出去：決定外層的目的位址（NBMA）。
 * mGRE 要靠 NHRP：不知道下一站的 NBMA 位址就先送給 NHS（hub 轉送），同時發出 Resolution Request（DMVPN phase 2）
 * 回傳 { nbma } 或 { drop }
 */
export function greTarget(state, ctx, dev, outIf, nh, pkt) {
  const rt = outIf.rt.tun;
  if (!rt || !rt.up) return { drop: `${dev.name} 的 ${outIf.label} 是 line protocol down：${(rt && rt.why) || '沒有啟用'}` };
  if (rt.mode === 'gre') return { nbma: rt.dst, peer: rt.peers[0] };
  const peer = rt.peers.find((p) => p.ip === nh);
  const hub = rt.peers.find((p) => p.kind === 'nhs' && p.ok);
  const T = peer && outIf.tun.prot ? dev.rt.tunnels.find((t) => t.tif === outIf.id && t.peerIp === peer.nbma) : null;
  if (peer && peer.ok && (!outIf.tun.prot || (T && T.up))) return { nbma: peer.nbma, peer };
  // 已經解析到的 spoke，但兩個 spoke 之間的通道還沒通（IPsec 協商中、建不起來、GRE 被擋）：這段時間先繼續經過 hub
  if (peer && peer.kind === 'res' && hub) {
    const why = outIf.tun.prot && !(T && T.up) ? `兩個 spoke 之間的 IPsec ${T && T.nego ? '還在協商' : `建不起來（${T ? T.why : '沒有 IPsec 設定'}）`}` : `spoke 之間的 GRE 不通（${peer.why}）`;
    if (!QUIET) ctx.log.push({ dev: dev.id, kind: 'info', text: `NHRP 已經知道 ${fmtIp(nh)} 在 ${fmtIp(peer.nbma)}，但${why}：這個封包繼續經過 hub` });
    return { nbma: hub.nbma, peer: hub, viaHub: true };
  }
  if (peer && peer.ok) return { nbma: peer.nbma, peer };
  if (hub && nh !== hub.ip && outIf.rt.ip != null && sameNet(nh, outIf.rt.ip, outIf.rt.bits)) {
    // 對面剛剛才來解析過（它的 Resolution Request 也讓這一端記下了它）：通道正在建立，這個封包先經過 hub
    const fresh = ((state.dyn.nhrpRes || {})[kOf(dev, outIf)] || {})[fmtIp(nh)];
    if (fresh && fresh.exp > state.clock) {
      if (!QUIET) ctx.log.push({ dev: dev.id, kind: 'info', text: `NHRP 剛剛記下 ${fmtIp(nh)} 在 ${fmtIp(fresh.nbma)}，spoke 之間的通道正在建立：這個封包先經過 hub` });
      return { nbma: hub.nbma, peer: hub, viaHub: true };
    }
    if (!QUIET) {
      const r = nhrpResolve(state, dev, outIf, nh, hub);
      ctx.log.push({ dev: dev.id, kind: 'info', text: `NHRP：還不知道 ${fmtIp(nh)} 的 NBMA 位址，送出 Resolution Request 給 NHS ${fmtIp(hub.ip)}${r.ok ? `，問到 ${fmtIp(nh)} 在 ${fmtIp(r.nbma)}（下一個封包就直接送過去）` : `（${r.why}）`}。這個封包先經過 hub 轉送` });
    }
    return { nbma: hub.nbma, peer: hub, viaHub: true };
  }
  if (peer) return { drop: `${dev.name} 的 ${outIf.label}：${fmtIp(nh)} 的 NHRP 對應是 ${fmtIp(peer.nbma)}，但 GRE 封包送不過去（${peer.why}）` };
  return { drop: `${dev.name} 的 ${outIf.label} 是 multipoint GRE：不知道下一站 ${fmtIp(nh)} 的 NBMA 位址（NHRP 裡沒有它${rt.nhs.length ? `，向 NHS 註冊也${rt.nhs.some((n) => n.ok) ? '問不到' : `失敗了：${rt.nhs.map((n) => n.why).filter(Boolean).join('；')}`}` : '，也沒有設定 NHS'}）` };
}

/** NHRP Resolution：經由 hub 問到另一個 spoke 的 NBMA 位址，兩邊都記下對方（holdtime 內有效） */
function nhrpResolve(state, dev, outIf, nh, hub, prefix) {
  const hd = state.devices[hub.dev], hi = hd && hd.ifaces.find((x) => x.id === hub.iface);
  const reg = hi && ((state.dyn.nhrpReg || {})[kOf(hd, hi)] || {})[fmtIp(nh)];
  if (!reg) return { why: `${hd ? hd.name : 'hub'} 那裡沒有 ${fmtIp(nh)} 的註冊` };
  const td = state.devices[reg.dev], ti = td && td.ifaces.find((x) => x.id === reg.iface);
  if (!ti || !nhrpOn(ti)) return { why: `${td ? td.name : fmtIp(nh)} 沒有啟用 NHRP` };
  if ((ti.nhrp.auth || '') !== ((outIf.nhrp && outIf.nhrp.auth) || '')) return { why: `${td.name} 的 NHRP 驗證字串不同，不回覆` };
  if (tunMode(ti) !== 'mgre') return { why: `${td.name} 的 ${ti.label} 是點對點 GRE（DMVPN phase 1），沒辦法建 spoke 之間的通道` };
  const now = state.clock, T = (state.dyn.nhrpRes ||= {});
  const put = (d, i, ip, nbma, hold, pfx) => {
    const t = (T[kOf(d, i)] ||= {}), k = fmtIp(ip), old = t[k] && t[k].exp > now && t[k].nbma === nbma ? t[k] : null;
    const prefixes = [...((old && old.prefixes) || [])];
    if (pfx && !prefixes.some((x) => x.net === pfx.net && x.bits === pfx.bits)) prefixes.push(pfx);
    t[k] = { nbma, since: old ? old.since : now, exp: now + hold, prefixes };
  };
  put(dev, outIf, nh, reg.nbma, holdOf(ti), prefix);
  put(td, ti, outIf.rt.ip, outIf.rt.tun.src, holdOf(outIf), null);
  return { ok: true, nbma: reg.nbma, dev: td };
}

/**
 * DMVPN phase 3：hub 發現封包從 Tunnel 進來又要從同一個 Tunnel 出去（ip nhrp redirect）→ 通知送來的那個 spoke。
 * spoke 有 ip nhrp shortcut 就去解析目的地，回覆的 spoke 告訴它整個網段：之後走直接的通道（路由表裡的 H）
 */
export function nhrpRedirect(state, ctx, hub, hubIf, pkt, from, nh) {
  if (QUIET || !from || !hubIf.nhrp || !hubIf.nhrp.redirect) return;
  const sd = state.devices[from.dev], si = sd && sd.ifaces.find((x) => x.id === from.iface);
  if (!si) return;
  ctx.log.push({ dev: hub.id, kind: 'info', text: `NHRP Redirect：封包從 ${hubIf.label} 進來又要從 ${hubIf.label} 出去，${hub.name} 通知 ${sd.name}「${fmtIp(pkt.dst)} 可以直接找另一個 spoke」` });
  if (!(si.nhrp && si.nhrp.shortcut)) { ctx.log.push({ dev: sd.id, kind: 'info', text: `${sd.name} 的 ${si.label} 沒有 ip nhrp shortcut：收到 Redirect 也不會去建捷徑，流量繼續經過 hub` }); return; }
  const peer = (hubIf.rt.tun.peers || []).find((p) => p.ip === nh);
  const td = peer && state.devices[peer.dev];
  if (!td) return;
  const r0 = lookupRoute(td, pkt.dst);
  const pfx = r0 ? { net: r0.net, bits: r0.bits } : { net: pkt.dst, bits: 32 };
  const hubPeer = (si.rt.tun.peers || []).find((p) => p.kind === 'nhs' && p.ok && p.dev === hub.id);
  if (!hubPeer) return;
  const r = nhrpResolve(state, sd, si, nh, hubPeer, pfx);
  ctx.log.push({ dev: sd.id, kind: 'info', text: r.ok ? `NHRP Resolution：${sd.name} 問到 ${fmtIp(pfx.net)}/${pfx.bits} 在 ${td.name}（NBMA ${fmtIp(r.nbma)}），路由表多了一筆 H（NHRP）的捷徑，下一個封包直接送過去` : `NHRP Resolution 失敗：${r.why}` });
}

/** 路由表裡 NHRP 的捷徑（DMVPN phase 3，show ip route 的 H） */
export function nhrpRoutes(state, d) {
  const out = [], T = (state.dyn && state.dyn.nhrpRes) || {};
  for (const i of d.ifaces) {
    if (!isTun(i) || !i.rt.link || !i.rt.tun || !i.rt.tun.up || !(i.nhrp && i.nhrp.shortcut)) continue;
    for (const [ip, e] of Object.entries(T[kOf(d, i)] || {})) {
      if (e.exp <= state.clock) continue;
      for (const p of e.prefixes || []) out.push({ net: p.net, bits: p.bits, via: parseIp(ip), iface: i, type: 'H', ad: 250, metric: 1, vrf: i.vrf || '', since: e.since });
    }
  }
  return out;
}

/** show ip nhrp：這個介面的 NHRP 快取 */
export function nhrpCache(state, d, i) {
  const rt = i.rt && i.rt.tun;
  if (!rt) return [];
  const now = state.clock;
  return rt.peers.filter((p) => p.ip != null).map((p) => ({
    ip: p.ip, nbma: p.nbma, kind: p.kind, ok: p.ok,
    type: p.kind === 'dyn' || p.kind === 'res' ? 'dynamic' : 'static',
    created: p.since != null ? Math.max(0, now - p.since) : null, expire: p.exp != null ? Math.max(0, p.exp - now) : null,
    flags: p.kind === 'dyn' ? 'registered nhop' : p.kind === 'res' ? 'router nhop rib' : p.kind === 'nhs' ? 'used' : '',
  }));
}
