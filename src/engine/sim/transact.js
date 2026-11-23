// 一次請求 + 回應（ping、TCP、UDP）：TCP 交握、資料區段與 PMTUD、長時間保持的連線
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { fmtIp, isPrivate } from '../ip.js';
import { ipMtu } from '../mtu.js';
import { QUIET, selMatch, setQuiet } from './core.js';
import { forward, isLocal, noRouteReason, pktDesc, sessionTtl } from './forward.js';
import { lookupRoute } from './l3.js';

let pktSeq = 0;

/**
 * 模擬一次「請求 + 回應」。spec: { proto:'icmp'|'tcp'|'udp', dst:number, dport?, srcIp? }
 * 回傳 { ok, reason, failDev, phase, responder, srcIp, seenSrc, log, hops, l3 }
 */
export function transact(state, fromId, spec) {
  const prev = setQuiet(QUIET || !!spec.quiet);
  try { return transactInner(state, fromId, spec); } finally { setQuiet(prev); }
}

/** 還沒過期的連線（每台設備一份），給「在既有的連線上繼續送資料」用 */
function liveSessions(state) {
  const out = {};
  for (const [id, list] of Object.entries(state.dyn.ct || {})) {
    const d = state.devices[id];
    if (d) out[id] = list.filter((e) => state.clock - e.t < sessionTtl(d, e));
  }
  return out;
}

/**
 * 在一條已經建立的 TCP 連線上再送一次資料並等對方回應（例如在 SSH 裡打了一行指令）。
 * flow: { cid, to, src, sport, dst, dport }。路上有狀態的設備如果已經把這條連線忘了，封包會被丟掉。
 */
export function flowSend(state, fromId, flow) {
  const ctx = { ct: liveSessions(state), log: [], hops: [], l3: [], mid: true, cid: flow.cid };
  const done = (r) => ({ ...r, log: ctx.log, hops: ctx.hops, l3: ctx.l3 });
  const pkt = { proto: 'tcp', src: flow.src, dst: flow.dst, sport: flow.sport, dport: flow.dport, ttl: 64, reply: false, ack: true, data: flow.data || null };
  const a = forward(state, ctx, fromId, pkt);
  if (!a.ok) return done({ ok: false, reason: a.reason, failDev: a.dev, phase: 'request' });
  if (a.dev !== flow.to) return done({ ok: false, reason: `封包被送到 ${state.devices[a.dev].name}，不是原本連線的那一台`, failDev: a.dev, phase: 'request' });
  const rp = { proto: 'tcp', src: pkt.dst, dst: pkt.src, sport: pkt.dport, dport: pkt.sport, ttl: 64, reply: true, ack: true, data: flow.echo || null };
  const b = forward(state, ctx, a.dev, rp);
  if (!b.ok) return done({ ok: false, reason: '回程失敗：' + b.reason, failDev: b.dev, phase: 'reply' });
  if (b.dev !== fromId) return done({ ok: false, reason: `回應被送到 ${state.devices[b.dev].name}`, failDev: b.dev, phase: 'reply' });
  return done({ ok: true });
}

/** 連線結束 (FIN)：連線表裡的項目進入關閉中的狀態，很快就會被清掉 */
export function closeFlow(state, cid) {
  for (const list of Object.values((state.dyn && state.dyn.ct) || {})) for (const e of list) if (e.cid === cid) { e.st = 'fin'; e.t = state.clock; }
}

/**
 * 路由器回報 ICMP「需要分段」給原本送封包的那一台：回傳 { ok, srcIp } 或 { ok:false, reason, failDev }
 * 中途的 ACL 擋掉 ICMP 就會送不到（PMTUD 黑洞）
 */
function icmpBack(state, ctx, ptb, senderId) {
  const r = state.devices[ptb.at], p = ptb.pkt;
  const route = lookupRoute(r, p.src, undefined, ptb.vrf || '');
  if (!route || route.iface.rt.ip == null) return { ok: false, reason: `${r.name} 沒有回到 ${fmtIp(p.src)} 的路由`, failDev: r.id };
  const srcIp = route.iface.rt.ip;
  ctx.log.push({ dev: r.id, kind: 'tx', text: `回報 ICMP「需要分段」(type 3 code 4，下一段的 MTU 是 ${ptb.mtu}) 給 ${fmtIp(p.src)}` });
  const ic = { proto: 'icmp', icmpErr: 'frag', mtu: ptb.mtu, src: srcIp, dst: p.src, sport: 0, dport: 0, ttl: 64, reply: false, len: 56, inner: { proto: p.proto, src: p.src, sport: p.sport, dst: p.dst, dport: p.dport } };
  const f = forward(state, ctx, r.id, ic);
  if (f.ok && f.dev === senderId) {
    ctx.log.push({ dev: senderId, kind: 'rx', text: `收到 ${r.name} 的 ICMP「需要分段」：通往 ${fmtIp(p.dst)} 的路徑 MTU 是 ${ptb.mtu}` });
    return { ok: true, srcIp };
  }
  return { ok: false, reason: f.ok ? `送到了 ${state.devices[f.dev].name}，不是原本送封包的那一台` : f.reason, failDev: f.dev };
}

/**
 * TCP 的資料區段：照 MSS 裝滿、設了 DF。路由器回報「需要分段」就照它說的 MTU 改小再送（PMTUD），最多重試幾次。
 * o = { from: 送資料的設備, seg: 位址與埠 }；回傳 { ok, mss } 或 { ok:false, reason, dev }
 */
function bulkSend(state, ctx, o, mss) {
  let len = mss + 40;
  for (let k = 0; k < 4; k++) {
    const seg = { proto: 'tcp', ...o.seg, ttl: 64, ack: true, bulk: true, df: true, len };
    ctx.log.push({ dev: o.from, kind: 'tx', text: `送出資料：TCP 區段 ${len} 位元組（MSS ${len - 40}，設了 DF 不可分段）` });
    const f = forward(state, ctx, o.from, seg);
    if (f.ok) return { ok: true, mss: len - 40 };
    if (f.ptb) {
      const back = icmpBack(state, ctx, f.ptb, o.from);
      if (back.ok && f.ptb.mtu < len) { len = f.ptb.mtu; ctx.log.push({ dev: o.from, kind: 'info', text: `Path MTU Discovery：改送 ${len} 位元組的區段再試一次` }); continue; }
      const who = state.devices[f.ptb.at].name, me = state.devices[o.from].name;
      return { ok: false, dev: back.failDev || f.dev, reason: `PMTUD 黑洞：TCP 連線建立得起來，但 ${len} 位元組的資料區段到了 ${who} 就過不去（下一段的 MTU 只有 ${f.ptb.mtu}，封包又設了 DF）。${who} 回報的 ICMP「需要分段」送不回 ${me}：${back.reason}。${me} 不知道要改小，一直重送一樣大的封包` };
    }
    if (f.l2) return { ok: false, dev: f.dev, reason: `TCP 連線建立了（交握的封包都很小），但 ${len} 位元組的資料區段被丟掉：${f.reason}。兩端協商出來的 MSS 是 ${len - 40}，中間卻有設備收不下這麼大的訊框——同一個網段裡每一台的 MTU 要一致` };
    return { ok: false, dev: f.dev, reason: '資料送不過去：' + f.reason };
  }
  return { ok: false, dev: o.from, reason: '資料一直送不過去（路徑上的 MTU 一再變小）' };
}

/** 訪客入口：還沒同意的 Wi-Fi 用戶端只能連入口網頁與認證前允許的位址 */
import { portalGate } from '../portal.js';
function transactInner(state, fromId, spec) {
  const ctx = { ct: {}, log: [], hops: [], l3: [], cid: spec.keep || null, vrf: spec.vrf || '', vrfDev: fromId };
  const src = state.devices[fromId];
  const done = (r) => ({ ...r, log: ctx.log, hops: ctx.hops, l3: ctx.l3, ...(ctx.deep ? { deep: ctx.deep } : {}), ...(ctx.wfBlock ? { wfBlock: ctx.wfBlock } : {}), ...(ctx.dnsf ? { dnsf: ctx.dnsf } : {}) });
  let srcIp = spec.srcIp;
  if (srcIp == null) {
    if (isLocal(src, spec.dst, spec.vrf || '')) {
      ctx.log.push({ dev: fromId, kind: 'ok', text: `${fmtIp(spec.dst)} 就是自己，本機迴路成功` });
      return done({ ok: true, responder: fromId });
    }
    const t = src.rt.tunnels.find((x) => x.up && x.vip != null && selMatch(x.remote, spec.dst));
    const r = t ? null : lookupRoute(src, spec.dst, undefined, spec.vrf || '');
    if (!t && !r) {
      const reason = state.rt.off[fromId] ? `${src.name} 沒有電` : noRouteReason(state, src, spec.dst);
      ctx.log.push({ dev: fromId, kind: 'drop', text: reason });
      return done({ ok: false, reason, failDev: fromId, phase: 'request' });
    }
    srcIp = t ? t.vip : r.iface.rt.ip;
  }
  const gate = portalGate(state, src, spec);
  if (gate) {
    ctx.log.push({ dev: fromId, kind: 'drop', text: gate.reason });
    return done({ ok: false, reason: gate.reason, failDev: fromId, phase: 'request', portal: gate.redirect ?? true });
  }
  const id = 1000 + (pktSeq++ % 20000);
  const icmp = spec.proto === 'icmp';
  const pkt = { proto: spec.proto, src: srcIp, dst: spec.dst, sport: icmp ? id : spec.sport ?? 30000 + id, dport: icmp ? 0 : spec.dport, ttl: spec.ttl || 64, reply: false, data: spec.data || null, ...(spec.size ? { len: +spec.size } : {}), ...(spec.df ? { df: true } : {}), ...(spec.host ? { host: spec.host } : {}), ...(spec.qname ? { qname: spec.qname } : {}), ...(spec.attack ? { attack: spec.attack } : {}) };
  ctx.log.push({ dev: fromId, kind: 'tx', text: `送出 ${pktDesc(pkt)}` });
  const a = forward(state, ctx, fromId, pkt);
  if (!a.ok && a.local) return done({ ok: false, reason: a.reason, failDev: fromId, phase: 'request', dfLocal: a.mtu });
  if (!a.ok && a.ptb) {
    // 路由器回報「需要分段」：ping -f 會直接顯示這個訊息
    const back = icmpBack(state, ctx, a.ptb, fromId);
    const who = state.devices[a.ptb.at].name;
    if (back.ok) return done({ ok: false, reason: `${who} 回報 ICMP「需要分段，但設定了 DF」：往下一段的 MTU 只有 ${a.ptb.mtu}`, failDev: a.dev, phase: 'request', ptb: { mtu: a.ptb.mtu, from: back.srcIp, dev: a.ptb.at } });
    return done({ ok: false, reason: `${a.reason}；它回報的 ICMP「需要分段」也送不回來（${back.reason}）`, failDev: back.failDev || a.dev, phase: 'request' });
  }
  if (!a.ok) {
    let reason = a.reason;
    const v = src.rt.vpn;
    if (v && !v.up && v.why && isPrivate(spec.dst) && src.vpnClient && a.dev !== fromId) {
      reason = `${src.name} 的 VPN 沒有連上（${v.why}），所以封包沒有走加密通道`;
      ctx.log.push({ dev: fromId, kind: 'drop', text: reason });
    }
    return done({ ok: false, reason, failDev: a.dev, phase: 'request', ...(a.l2 ? { silent: true } : {}) }); // silent：被第二層的設備默默丟掉，沒有任何回應
  }

  const rv = { src: pkt.dst, dst: pkt.src, sport: pkt.dport, dport: pkt.sport }; // 回應方看到的這條連線（rp 送出去之後會被 NAT 改掉）
  const rp = { proto: pkt.proto, ...rv, ttl: 64, reply: true, ...(icmp && spec.size ? { len: +spec.size } : {}) };
  ctx.log.push({ dev: a.dev, kind: 'rx', text: `收到請求，回覆 ${pktDesc(rp)}` });
  const b = forward(state, ctx, a.dev, rp);
  if (!b.ok) return done({ ok: false, reason: '回程失敗：' + b.reason, failDev: b.dev, phase: 'reply', responder: a.dev });
  if (b.dev !== fromId) {
    const reason = `回應被送到 ${state.devices[b.dev].name}，而不是 ${src.name}（IP 位址衝突？）`;
    ctx.log.push({ dev: b.dev, kind: 'drop', text: reason });
    return done({ ok: false, reason, failDev: b.dev, phase: 'reply', responder: a.dev });
  }
  // 回應的來源要是剛才連的那個位址：NAT 只轉了一個方向（例如同一個網段的 hairpin 沒有換來源），用戶端收到不認得的回應就丟掉（TCP 回 RST）
  if (rp.src !== spec.dst) {
    const reason = `${src.name} 連的是 ${fmtIp(spec.dst)}，回應卻來自 ${fmtIp(rp.src)}：回程沒有經過做 NAT 的那台設備（伺服器直接回給用戶端），用戶端不認得這個回應，丟掉${spec.proto === 'tcp' ? '（回一個 RST）' : ''}`;
    ctx.log.push({ dev: fromId, kind: 'drop', text: reason });
    return done({ ok: false, reason, failDev: fromId, phase: 'reply', responder: a.dev });
  }
  const seenSrc = pkt.src;
  if (spec.proto === 'tcp') {
    // TCP 要三個封包才算建立連線：SYN → SYN-ACK → ACK
    const ack = { proto: 'tcp', src: srcIp, dst: spec.dst, sport: 30000 + id, dport: spec.dport, ttl: 64, reply: false, ack: true };
    ctx.log.push({ dev: fromId, kind: 'tx', text: `收到 SYN-ACK，送出 ${pktDesc(ack)}（三向交握的第三步）` });
    const c = forward(state, ctx, fromId, ack);
    if (!c.ok) return done({ ok: false, reason: '三向交握的最後一步 (ACK) 沒有送達：' + c.reason, failDev: c.dev, phase: 'ack', responder: a.dev });
    ctx.log.push({ dev: c.dev, kind: 'ok', text: 'TCP 連線建立完成（SYN → SYN-ACK → ACK），可以開始傳送資料' });
    // 測試用的連線建立之後就由用戶端關閉 (FIN)：連線表裡的項目進入關閉中的狀態，很快就會被清掉
    // 要保持的連線（SSH / Telnet）不關閉，之後每送一次資料，閒置的計時就重新開始
    // 交握完成之後送一個裝滿的資料區段（設了 DF）：MTU 的問題要到這一步才會出現
    let mss;
    if (spec.bulk !== false && !spec.keep) {
      const resp = state.devices[a.dev];
      const myIf = src.ifaces.find((i) => i.rt && i.rt.ip === srcIp), peerIf = resp.ifaces.find((i) => i.rt && i.rt.ip === rv.src);
      mss = Math.min(ipMtu(state, src, myIf) - 40, ipMtu(state, resp, peerIf) - 40, ctx.mssClamp ?? Infinity);
      const d = bulkSend(state, ctx, spec.bulk === 'up' ? { from: fromId, seg: { src: srcIp, dst: spec.dst, sport: 30000 + id, dport: spec.dport, reply: false } } : { from: a.dev, seg: { ...rv, reply: true } }, mss);
      if (!d.ok) return done({ ok: false, reason: d.reason, failDev: d.dev, phase: 'data', responder: a.dev, mss });
      mss = d.mss;
    }
    if (!spec.keep) for (const l of Object.values(ctx.ct)) for (const e of l) if (e.st === 'est') e.st = 'fin';
    return done({ ok: true, responder: a.dev, srcIp, seenSrc, sport: 30000 + id, ...(mss ? { mss } : {}) });
  }
  ctx.log.push({ dev: fromId, kind: 'ok', text: '收到回應，連線成功' });
  return done({ ok: true, responder: a.dev, srcIp, seenSrc });
}
