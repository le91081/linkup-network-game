// QoS：標記 (marking)、信任邊界 (trust)、分類 (class-map)、佇列 (policy-map 的 priority / bandwidth)、整形 (shape) 與管制 (police)
//
// 設定（IOS 的 MQC）：
//   d.classMaps  = { 名稱: { any: match-any?, rules: [{ t: 'dscp'|'cos'|'acl'|'protocol'|'any', v }] } }
//   d.policyMaps = { 名稱: [{ cls, priority?: {pct|kbps}, bandwidth?: {pct|kbps|rpct}, set?: {dscp}, police?: {bps}, shape?: {bps}, child?, fq?, qlimit? }] }
//   介面：i.qosIn / i.qosOut = 政策名稱
// Catalyst 2960（mls qos）：d.sw.qos = { on, cosDscp: [8 個值] }，埠：pc.qosTrust = 'dscp' | 'cos'，pc.trustDevice = 'cisco-phone'
// 營運商的線路（例如 Metro Ethernet）：cable.cir = 合約頻寬 (Mbps)，超過的流量在營運商那一端被丟掉
//
// 這裡的模型：每一條線路的每個方向是一個出口佇列。持續的 TCP 流量（state.flows）會把瓶頸塞滿，
// 佇列一直排著隊 → 同一個佇列裡的語音封包要跟著排隊（延遲、抖動），佇列滿了就被丟掉（遺失）。
// 把語音放進 priority（LLQ）就不用排隊；線路被營運商管制 (police) 時要先在自己這端 shape，佇列才會在自己手上。
import { fmtIp, parseIp, parseCidr, netOf } from './ip.js';
import { linkInfo, CATALOG } from './model.js';

export const DSCP = { default: 0, cs1: 8, af11: 10, af12: 12, af13: 14, cs2: 16, af21: 18, af22: 20, af23: 22, cs3: 24, af31: 26, af32: 28, af33: 30, cs4: 32, af41: 34, af42: 36, af43: 38, cs5: 40, ef: 46, cs6: 48, cs7: 56 };
const DSCP_NAME = Object.fromEntries(Object.entries(DSCP).map(([k, v]) => [v, k]));
export const dscpName = (v) => DSCP_NAME[v] || String(v);
/** 'ef' / '46' / 'af41' → 數字；不認得就 null */
export function parseDscp(s) {
  const t = String(s || '').toLowerCase();
  if (t in DSCP) return DSCP[t];
  return /^\d+$/.test(t) && +t <= 63 ? +t : null;
}
export const COS_DSCP_DEFAULT = [0, 8, 16, 24, 32, 40, 48, 56]; // 2960 預設的 CoS → DSCP 對應：CoS 5 變成 40 (CS5)，不是 EF
export const QLIMIT = 64; // IOS XE 每個佇列預設 64 個封包
const PKT = 1500 * 8; // 一個大封包的位元數

// ───────────────────────── 設定的小工具 ─────────────────────────

export const policyOf = (d, name) => (d.policyMaps || {})[name] || null;
/** 從某個實體埠送出時用的是哪一個 L3 介面（子介面看 VLAN 標籤） */
export function egressIface(d, pid, tag) {
  return d.ifaces.find((i) => (tag != null ? i.bind.t === 'sub' && i.bind.vlan === tag : i.bind.t === 'port') && i.bind.port === pid)
    || d.ifaces.find((i) => i.bind.t === 'port' && i.bind.port === pid) || null;
}
const ruleHit = (d, r, p) => {
  if (r.t === 'any') return true;
  if (r.t === 'dscp') return r.v.includes(p.dscp);
  if (r.t === 'cos') return r.v.includes(p.cos ?? 0);
  if (r.t === 'protocol') return r.v === 'rtp' ? p.kind === 'rtp' : r.v === 'sip' ? p.kind === 'sip' : false;
  if (r.t === 'acl') {
    const list = (d.aclDefs || {})[r.v] || d.ifaces.flatMap((i) => [i.aclIn, i.aclOut].filter((x, n) => x && x.length && ((i.aclNames || {})[n ? 'out' : 'in'] === r.v)))[0] || [];
    return aclPermit(list, p);
  }
  return false;
};
function addrHit(spec, ip) {
  if (!spec || spec === 'any') return true;
  const c = parseCidr(spec.includes('/') ? spec : spec + '/32');
  return !!c && netOf(ip, c.bits) === c.net;
}
function aclPermit(list, p) {
  for (const r of list) {
    if (r.proto !== 'ip' && r.proto !== p.proto) continue;
    if (!addrHit(r.src, p.src) || !addrHit(r.dst, p.dst)) continue;
    if (r.port) {
      const m = String(r.port).match(/^(\d+)(?:-(\d+))?$/);
      if (m && !(p.dport >= +m[1] && p.dport <= +(m[2] || m[1]))) continue;
    }
    return r.action === 'permit';
  }
  return false;
}
/** 封包落在政策的哪一個 class（照順序比對，最後是 class-default） */
export function classify(d, policy, p) {
  for (const c of policy) {
    if (c.cls === 'class-default') continue;
    const cm = (d.classMaps || {})[c.cls];
    if (!cm || !cm.rules.length) continue;
    const hit = cm.any ? cm.rules.some((r) => ruleHit(d, r, p)) : cm.rules.every((r) => ruleHit(d, r, p));
    if (hit) return c;
  }
  return policy.find((c) => c.cls === 'class-default') || { cls: 'class-default' };
}

// ───────────────────────── 標記與信任 ─────────────────────────

/** 交換器的這個埠信任什麼：'dscp' / 'cos' / 'none'（mls qos 沒開就全部原樣通過：'pass'） */
export function portTrust(state, d, pid) {
  const q = d.sw && d.sw.qos;
  if (!q || !q.on) return 'pass';
  const pc = d.sw.ports[pid] || {};
  if (!pc.qosTrust) return 'none';
  // 條件式信任：CDP 認出對面是 Cisco 的 IP 電話才信任，否則（例如直接接電腦）一律不信任
  if (pc.trustDevice === 'cisco-phone') {
    const l = state.rt.links[d.id + ':' + pid], x = l && state.devices[l.dev];
    const phone = x && CATALOG[x.model].phone && cdpBoth(d, pid, x, l.port);
    if (!phone) return 'none';
  }
  return pc.qosTrust;
}
let cdpBoth = () => true;
export function setCdpCheck(fn) { cdpBoth = fn; }

/**
 * 封包沿著路徑走，每一站進來時可能被改寫標記：交換器開了 mls qos 而且這個埠不信任，DSCP 歸零；
 * 信任 CoS 的埠用 CoS → DSCP 對照表換算；路由器的 input 政策可以 set dscp。
 * 回傳每一段出口看到的 DSCP（第 n 個元素是從 hops[n].from 送出時的值）
 */
export function markAlong(state, hops, start) {
  let dscp = start.dscp || 0, cos = start.cos ?? (start.dscp ? start.dscp >> 3 : 0);
  const out = [], notes = [];
  out.notes = notes;
  for (const h of hops) {
    out.push(dscp);
    const x = state.devices[h.to];
    if (!x) continue;
    const tagged = h.tag != null;
    const frameCos = tagged ? cos : 0; // 沒有 802.1Q 標籤就沒有 CoS
    if (x.sw && x.sw.mode === 'vlan') {
      const tr = portTrust(state, x, h.toPort), before = dscp;
      if (tr === 'none') {
        dscp = 0; cos = 0;
        const pc = x.sw.ports[h.toPort] || {};
        if (before) notes[out.length] = `${x.name} 的 ${h.toPort} 開了 mls qos 卻${pc.trustDevice ? '只信任 Cisco IP 電話，但 CDP 沒有認出對面是電話' : '沒有設定信任 (trust)'}，DSCP 從 ${dscpName(before)} 被改成 0`;
      } else if (tr === 'cos') {
        const map = (x.sw.qos && x.sw.qos.cosDscp) || COS_DSCP_DEFAULT;
        dscp = map[frameCos] || 0; cos = frameCos;
        if (dscp !== before) {
          notes[out.length] = frameCos
            ? `${x.name} 的 ${h.toPort} 信任 CoS：CoS ${frameCos} 依對照表換成 DSCP ${dscpName(dscp)} (${dscp})${frameCos === 5 && dscp !== 46 ? '——預設的對照表把 CoS 5 對應到 40，不是語音用的 EF (46)' : ''}`
            : `${x.name} 的 ${h.toPort} 信任 CoS，但訊框沒有 802.1Q 標籤（沒有 CoS），DSCP 被改成 ${dscp}`;
        }
      }
      else if (tr === 'dscp') cos = dscp >> 3;
      else cos = frameCos; // mls qos 沒開：原樣通過
    } else {
      // 路由器：重新封裝成新的訊框，CoS 依 DSCP；input 政策可以重新標記
      const i = egressIface(x, h.toPort, h.tag);
      const pol = i && i.qosIn && policyOf(x, i.qosIn);
      if (pol) {
        const c = classify(x, pol, { ...start, dscp, cos: frameCos });
        if (c.set && c.set.dscp != null && c.set.dscp !== dscp) { notes[out.length] = `${x.name} 的 input 政策 ${i.qosIn}（class ${c.cls}）把 DSCP 改成 ${dscpName(c.set.dscp)}`; dscp = c.set.dscp; }
      }
      cos = dscp >> 3;
    }
  }
  return out;
}

// ───────────────────────── 出口佇列 ─────────────────────────

/**
 * 從 h.from 經過 h 送出時的出口設定：實體速率、整形 (shape)、營運商的合約頻寬 (CIR)、輸出政策。
 * 回傳 { rate: 可以用的速率 Mbps, phys, shape, cir, policy, child, iface }
 */
export function egressOf(state, h) {
  const d = state.devices[h.from];
  const li = linkInfo(state, h.from, h.fromPort);
  if (!d || !li || li.down) return null;
  const phys = li.mismatch ? Math.min(li.speed * 0.01, 2) : li.half ? li.speed * 0.4 : li.speed;
  const cable = state.cables.find((c) => c.id === h.cable);
  const cir = cable && +cable.cir > 0 ? +cable.cir : null;
  const i = d.sw && d.sw.mode === 'vlan' && !d.ifaces.some((x) => x.bind.t === 'port' && x.bind.port === h.fromPort) ? null : egressIface(d, h.fromPort, h.tag);
  const policy = i && i.qosOut ? policyOf(d, i.qosOut) : null;
  let shape = null, queues = policy;
  if (policy) {
    // 階層式：parent 的 class-default 做 shape，child 政策負責排隊
    const top = policy.find((c) => c.shape);
    if (top) { shape = top.shape.bps / 1e6; queues = top.child ? policyOf(d, top.child) : null; }
  }
  const rate = Math.min(phys, shape ?? Infinity);
  return { rate, phys, shape, cir, policy, queues, iface: i, dev: d };
}

/** 一個封包在某個出口佇列裡的遭遇：排隊延遲、抖動、遺失（毫秒、毫秒、%） */
export function queueFate(eg, load, dscp, pkt, dev) {
  const C = eg.rate * 1e6; // bps
  const ser = (PKT / C) * 1000; // 一個 1500 位元組封包的發送時間（毫秒）
  const res = { delay: (214 * 8 / C) * 1000, jitter: 0, loss: 0, why: '', cls: null };
  const q = eg.queues;
  const cls = q ? classify(dev, q, { ...pkt, dscp }) : null;
  res.cls = cls ? cls.cls : null;
  const fixed = load.fixed / 1e3, elastic = load.elastic; // Mbps；elastic 是持續的 TCP 流量條數
  const congested = elastic.length > 0 && load.offered >= eg.rate * 0.98;
  const small = () => { const rho = Math.min(0.95, load.offered / eg.rate); return (rho / (2 * (1 - rho))) * ser * 0.5; };
  if (!congested) { res.delay += small(); res.jitter = small() * 0.5; return res; }
  if (cls && cls.priority) {
    // LLQ：嚴格優先，不用等其他佇列；超過 priority 頻寬的部分在壅塞時被丟掉
    const pr = cls.priority.kbps ? cls.priority.kbps / 1e3 : (eg.rate * cls.priority.pct) / 100;
    const mine = load.byCls[cls.cls] ? load.byCls[cls.cls].fixed / 1e3 : fixed;
    res.delay += ser; res.jitter = ser * 0.5;
    if (mine > pr) { res.loss = ((mine - pr) / mine) * 100; res.why = `priority 只保留了 ${fmtMbps(pr)}，語音流量有 ${fmtMbps(mine)}，超過的部分被丟掉`; }
    return res;
  }
  // 這個佇列裡有沒有持續的 TCP：有的話會把佇列塞滿
  const myElastic = cls ? (load.byCls[cls.cls] || { n: 0 }).n : elastic.length;
  const qlim = (cls && cls.qlimit) || QLIMIT;
  const share = cls ? classRate(eg, q, cls) : eg.rate;
  if (myElastic > 0) {
    if (cls && cls.fq) { // 公平佇列：每條流量各排各的，低速的語音幾乎不用等
      res.delay += ser * 2; res.jitter = ser; res.loss = 0.2;
      res.why = 'class-default 開了 fair-queue：語音和大量傳輸各排各的佇列';
      return res;
    }
    const full = (qlim * PKT) / (share * 1e6) * 1000;
    res.delay += full * 0.7; res.jitter = full * 0.3;
    res.loss = Math.min(12, 2 + 1.5 * myElastic);
    res.why = `和 ${myElastic} 條大量傳輸排在同一個佇列（${cls ? cls.cls : 'FIFO'}），佇列常常是滿的：平均要等 ${Math.round(full * 0.7)} 毫秒，滿的時候直接丟掉`;
    return res;
  }
  // 自己一個佇列，沒有 TCP 跟著搶：只要等其他佇列輪一輪
  res.delay += ser * Math.max(1, q ? q.length - 1 : 1); res.jitter = ser;
  return res;
}
const fmtMbps = (m) => (m >= 1 ? `${Math.round(m * 10) / 10} Mbps` : `${Math.round(m * 1000)} kbps`);
/** 某個 class 在壅塞時分得到的頻寬 */
function classRate(eg, q, cls) {
  const R = eg.rate;
  const pri = q.filter((c) => c.priority).reduce((a, c) => a + (c.priority.kbps ? c.priority.kbps / 1e3 : (R * c.priority.pct) / 100), 0);
  if (cls.bandwidth) return cls.bandwidth.kbps ? cls.bandwidth.kbps / 1e3 : cls.bandwidth.rpct ? ((R - pri) * cls.bandwidth.rpct) / 100 : (R * cls.bandwidth.pct) / 100;
  const used = q.filter((c) => c.bandwidth && c !== cls).reduce((a, c) => a + (c.bandwidth.kbps ? c.bandwidth.kbps / 1e3 : c.bandwidth.rpct ? ((R - pri) * c.bandwidth.rpct) / 100 : (R * c.bandwidth.pct) / 100), 0);
  return Math.max(R * 0.01, R - pri - used);
}

/**
 * 營運商的管制 (police)：送出去的量超過合約頻寬 (CIR)，多的直接丟掉，不分語音還是資料。
 * 自己這端有 shape 到 CIR 以下，送出去的量就不會超過，也就不會被丟
 */
export function policerFate(eg, load) {
  if (!eg.cir) return null;
  const sent = Math.min(load.offered, eg.rate);
  if (sent <= eg.cir * 1.001 || !load.elastic.length) return null;
  const loss = Math.min(15, 4 + 2 * load.elastic.length);
  return { loss, why: `送出去的量超過營運商的合約頻寬 ${eg.cir} Mbps，超過的封包在營運商那一端被丟掉 (policing)，語音也一起被丟` };
}

void fmtIp; void parseIp;
