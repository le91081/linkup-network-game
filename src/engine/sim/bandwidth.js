// 頻寬：每段線路跑得到多快、背景流量的分配、傳輸速率
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { callsTick } from '../voice.js';
import { classify, egressOf, markAlong } from '../qos.js';
import { countBytes } from '../wire.js';
import { linkInfo } from '../model.js';
import { parseIp } from '../ip.js';
import { transact } from './transact.js';

// ───────────────────────── 頻寬 ─────────────────────────

/**
 * 沿著一條已經走通的路徑，估算 TCP 實際跑得到多快。瓶頸是路徑上最慢的那一段：
 * - 全雙工的線大約跑得到標稱速率的九成多（扣掉標頭）。
 * - 半雙工（Hub）同一時間只能有一端在送，還會碰撞，實際只有四成左右。
 * - 雙工不一致：全雙工的那端不會等對方，半雙工的那端不斷碰撞、重傳，幾乎不能用。
 * - Wi-Fi 的實際吞吐量大約是連線速率的一半。
 */
/** 一段線路單方向實際跑得到的速率（Mbps）與說明 */
export function linkCap(state, h, eff = 0.94) {
  const li = linkInfo(state, h.from, h.fromPort);
  if (!li || li.down) return null;
  let c;
  if (li.mismatch) c = { mbps: Math.min(li.speed * 0.01, 2), note: `${li.speed} Mbps，但兩端的雙工不一致 (duplex mismatch)`, loss: 35, retr: 1800 };
  else if (li.half) c = { mbps: li.speed * 0.4, note: `${li.speed} Mbps 半雙工，會發生碰撞`, loss: 3, retr: 60 };
  else c = { mbps: li.speed * eff, note: `${li.speed >= 1000 ? li.speed / 1000 + ' Gbps' : li.speed + ' Mbps'} 全雙工`, loss: 0, retr: 0 };
  // 整形 (shape)：自己把送出去的速率壓在設定值以下
  const eg = egressOf(state, h);
  if (eg && eg.shape != null && eg.shape * 0.95 < c.mbps) c = { ...c, mbps: eg.shape * 0.95, note: `${c.note}，整形 (shape) 到 ${eg.shape} Mbps` };
  // 營運商的合約頻寬：超過的被管制 (police) 丟掉，TCP 一直被丟封包、一直重送，用不滿合約的頻寬
  if (eg && eg.cir) {
    const shaped = eg.shape != null && eg.shape <= eg.cir;
    if (!shaped && eg.cir * 0.85 < c.mbps) c = { ...c, mbps: eg.cir * 0.85, note: `實體 ${c.note}，但營運商的合約頻寬只有 ${eg.cir} Mbps，超過的被管制丟掉`, loss: Math.max(c.loss, 3), retr: Math.max(c.retr, 120) };
  }
  return c;
}
const dirKey = (h) => h.cable + '>' + h.to;

/**
 * 背景流量（例如夜間備份）：每一條持續地從一台主機送資料到另一個位址。
 * state.flows = [{ id, from, ip, port, mbps（想要的速率）, label, on }]
 * 依路徑上每一段剩下的頻寬分配（小的先滿足，近似 TCP 的公平分享），算進介面計數器，
 * 也記在 state.rt.load：之後的 iperf3、檔案傳輸會和它們搶同一條線
 */
export function flowsTick(state) {
  const dyn = state.dyn, now = state.clock;
  const dt = dyn.flowT == null ? 0 : Math.max(0, now - dyn.flowT);
  dyn.flowT = now;
  const load = {}, count = {}, qload = {};
  state.rt.load = load; state.rt.loadN = count; state.rt.qload = qload;
  const Q = (dk, h) => { const q = (qload[dk] ||= { offered: 0, fixed: 0, rate: 0, elastic: [], byCls: {} }); if (h && !q.h) q.h = h; return q; };
  const flows = (state.flows || []).filter((f) => f.on !== false && state.devices[f.from]);
  // 1. 每條流量走哪一條路
  const items = [];
  for (const f of flows) {
    const ip = typeof f.ip === 'number' ? f.ip : parseIp(f.ip || '');
    const res = ip == null ? null : transact(state, f.from, { proto: 'tcp', dst: ip, dport: +f.port || 5201, quiet: true });
    if (!res || !res.ok) { f.rt = { mbps: 0, why: res ? res.reason : '目的位址不正確' }; continue; }
    // TCP 的 SYN 與 ACK 走同一條路：每一段只算一次
    const once = new Set();
    const hops = res.hops.filter((h) => !h.wave && !h.reply && h.proto !== 'arp' && h.cable && !h.wifi && !once.has(dirKey(h)) && once.add(dirKey(h)));
    const caps = hops.map((h) => linkCap(state, h));
    items.push({ f, hops: hops.filter((h, n) => caps[n]), caps: caps.filter(Boolean), want: Math.max(0, +f.mbps || 0), rate: 0, ip, res });
  }
  // 2. max-min 公平分配（近似 TCP）：所有流量一起慢慢加速，某一段線路滿了，經過它的流量就停在那裡；
  //    想要的量比較少的，拿到想要的就停。剩下的頻寬繼續分給其他還能加速的流量
  const cap = {}, used = {};
  for (const x of items) x.hops.forEach((h, n) => { cap[dirKey(h)] = x.caps[n].mbps; });
  let active = items.filter((x) => x.want > 0 && x.hops.length);
  for (let round = 0; active.length && round < 64; round++) {
    const cnt = {};
    for (const x of active) for (const h of x.hops) cnt[dirKey(h)] = (cnt[dirKey(h)] || 0) + 1;
    let inc = Infinity;
    for (const [k, n] of Object.entries(cnt)) inc = Math.min(inc, (cap[k] - (used[k] || 0)) / n);
    for (const x of active) inc = Math.min(inc, x.want - x.rate);
    inc = Math.max(0, inc);
    for (const x of active) { x.rate += inc; for (const h of x.hops) used[dirKey(h)] = (used[dirKey(h)] || 0) + inc; }
    active = active.filter((x) => x.rate < x.want - 1e-6 && x.hops.every((h) => cap[dirKey(h)] - used[dirKey(h)] > 1e-6));
  }
  // 3. 記下每一段的負載、每個出口佇列看到的量（給 QoS 與通話品質用）
  for (const x of items) {
    const { f, hops, res, ip } = x;
    const pkt = { proto: 'tcp', kind: 'tcp', src: res.seenSrc ?? res.srcIp, dst: ip, dport: +f.port || 5201 };
    const marks = markAlong(state, hops, { ...pkt, dscp: +f.dscp || 0 });
    let upto = x.want, where = '', worst = Infinity;
    hops.forEach((h, n) => {
      const c = x.caps[n], k = dirKey(h);
      // 這個出口看到的量：上游最窄的地方已經把它限制住了
      const q = Q(k, h), eg = egressOf(state, h);
      q.offered += upto; q.elastic.push(f.id); q.rate += x.rate;
      const cls = eg && eg.queues ? classify(eg.dev, eg.queues, { ...pkt, dscp: marks[n] }).cls : null;
      if (cls) { const b = (q.byCls[cls] ||= { n: 0, fixed: 0, rate: 0 }); b.n++; b.rate += x.rate; }
      upto = Math.min(upto, c.mbps);
      load[k] = (load[k] || 0) + x.rate; count[k] = (count[k] || 0) + 1;
      // 瓶頸：這條流量經過、已經被塞滿的那一段（有好幾段就挑最窄的）
      if (cap[k] - (used[k] || 0) <= 1e-6 && c.mbps < worst) { worst = c.mbps; where = `${state.devices[h.from].name} ↔ ${state.devices[h.to].name}（${c.note}${(count[k] || 0) > 1 || items.filter((y) => y.hops.some((g) => dirKey(g) === k)).length > 1 ? `，和其他 ${items.filter((y) => y !== x && y.hops.some((g) => dirKey(g) === k)).length} 條流量平分` : ''}）`; }
    });
    f.rt = { mbps: Math.round(x.rate * 10) / 10, where, full: x.rate < x.want - 0.5 };
    if (dt > 0) for (const h of hops) countBytes(state, h, (x.rate * 1e6 * dt) / 8);
  }
  // 進行中的通話：每個方向一條固定速率的語音流量，品質看沿路每個出口佇列的狀況
  callsTick(state, Q, dt);
  // 壅塞的佇列一直在丟封包：累計起來給 show policy-map interface 的 total drops
  if (dt > 0) {
    const drops = (dyn.qdrop ||= {});
    for (const [k, q] of Object.entries(qload)) {
      if (!q.elastic.length || !q.h) continue;
      const eg = egressOf(state, q.h);
      if (!eg || q.offered < eg.rate * 0.98) continue;
      const list = eg.queues ? Object.entries(q.byCls) : [['fifo', { n: q.elastic.length, rate: q.rate }]];
      for (const [cls, b] of list) {
        if (!b.n) continue;
        const c = eg.queues && eg.queues.find((x) => x.cls === cls);
        if (c && c.priority) continue;
        const p = c && c.fq ? 0.002 : Math.min(0.12, 0.02 + 0.015 * b.n);
        drops[k + '|' + cls] = (drops[k + '|' + cls] || 0) + Math.round((b.rate * 1e6 * p * dt) / 12000);
      }
    }
  }
}
export const dirKeyOf = (h) => dirKey(h);

/** 某條線路目前的使用率（兩個方向取比較高的那一個），給關卡檢查用 */
export function linkUtil(state, devId, pid) {
  const l = state.rt.links[devId + ':' + pid];
  if (!l) return null;
  const a = { cable: l.cable, from: devId, fromPort: pid, to: l.dev, toPort: l.port }, b = { cable: l.cable, from: l.dev, fromPort: l.port, to: devId, toPort: pid };
  const ca = linkCap(state, a);
  if (!ca) return null;
  const load = Math.max((state.rt.load || {})[dirKey(a)] || 0, (state.rt.load || {})[dirKey(b)] || 0);
  return { mbps: load, cap: ca.mbps, util: Math.min(100, (load / ca.mbps) * 100), note: ca.note };
}

/** TCP 的有效載荷佔線路上位元的比例：每個區段還有 40 位元組的 IP + TCP 標頭、38 位元組的乙太網路標頭、前導碼與訊框間隔 */
const payloadRatio = (mss) => mss / (mss + 40 + 38);
export function throughput(state, hops, mss = 1460) {
  let best = Infinity, where = '', dev = null, loss = 0, retr = 0;
  const eff = 0.94 * (payloadRatio(mss) / payloadRatio(1460)); // MSS 1460（MTU 1500）跑得到 94%，Jumbo Frame 大約 98%
  const seen = new Set();
  for (const h of hops) {
    if (h.wave || h.reply || h.proto === 'arp' || h.proto === 'dhcp') continue;
    let mbps, note;
    if (h.wifi) {
      const a = [state.devices[h.from], state.devices[h.to]].flatMap((d) => d.ifaces).map((i) => i.rt.assoc).find((x) => x && (x.ap === h.from || x.ap === h.to));
      const rate = a ? a.rate : 54;
      mbps = rate * 0.5;
      note = `Wi-Fi 連線速率 ${rate} Mbps${a && a.noisy ? '（頻道互相干擾）' : ''}`;
    } else {
      if (!h.cable || seen.has(h.cable)) continue;
      seen.add(h.cable);
      const c = linkCap(state, h, eff);
      if (!c) continue;
      ({ mbps, note } = c);
      loss = Math.max(loss, c.loss); retr = Math.max(retr, c.retr);
      // 這條線上已經有背景流量：TCP 大致上平分，但別人用不完的也拿得到
      const L = (state.rt.load || {})[dirKey(h)] || 0, n = (state.rt.loadN || {})[dirKey(h)] || 0;
      if (L > 0.5) {
        const share = Math.max(mbps - L, mbps / (n + 1));
        if (share < mbps) { mbps = share; note += `，和 ${n} 條背景流量共用（已經用掉 ${Math.round(L)} Mbps）`; }
      }
    }
    if (mbps < best) { best = mbps; dev = h.from; where = `${state.devices[h.from].name} ↔ ${state.devices[h.to].name}（${note}）`; }
  }
  if (best === Infinity) return { mbps: 0, where: '', dev: null, loss: 0, retr: 0 };
  if (hops.some((h) => h.proto === 'esp')) best *= 0.9; // 加密與多一層標頭的負擔
  return { mbps: best >= 10 ? Math.round(best) : Math.round(best * 10) / 10, where, dev, loss, retr };
}
