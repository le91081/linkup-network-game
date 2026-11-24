// 位址取得與路由表：DHCP 租約與 Relay、VRRP / HSRP、路由表與最長相符、DHCP 的 DORA 動畫
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { BCAST, onHop } from '../wire.js';
import { HSRP_HOLD, fhrpDecrement, fhrpGroup, fhrpPreempt, fhrpProto, trackUp } from '../track.js';
import { computeBgp } from '../bgp.js';
import { computeOspf, ospfArea } from '../ospf.js';
import { computeEigrp } from '../eigrp.js';
import { computeRip } from '../rip.js';
import { fmtIp, netOf, parseIp, parseMask, sameNet } from '../ip.js';
import { logEvent } from '../ops.js';
import { buildWave } from './forward.js';
import { cmp, dnsList, hash, isVlanSw, vrfOf } from './core.js';
import { hostDomain, l2Explore, learnPath, reversed } from './l2.js';
import { transact } from './transact.js';
import { greLines, greReach, greRecursion, isTun, nhrpRoutes, tunIfaces } from './gre.js';
import { prepTunnels } from './tunnels.js';
import { sdwanOn, sdwanRoutes } from '../sdwan.js';

// ───────────────────────── 位址取得 / 路由表 ─────────────────────────

/**
 * busy：這個網段上已經有人手動在用的位址。伺服器發出「新的」位址之前會先 ping 確認沒有人回應，
 * 有人在用就跳過並記成衝突。已經發出去的租約不會重新檢查 — 所以設備離線期間被發走的位址，回來之後還是會衝突。
 */
// ── DHCP 租約 ──
export const DEFAULT_LEASE = 86400; // 一天
/** 某個位址池的租約長度（秒）。key 是「伺服器 id/介面 id」或「伺服器 id/scope/起始 IP」 */
export function leaseLen(state, key) {
  const cut = key.indexOf('/'), d = state.devices[key.slice(0, cut)], rest = key.slice(cut + 1);
  if (!d) return DEFAULT_LEASE;
  if (rest.startsWith('scope/')) return +((d.dhcpScopes || []).find((x) => x.start === rest.slice(6)) || {}).lease || DEFAULT_LEASE;
  const i = d.ifaces.find((x) => x.id === rest);
  return +(i && i.dhcp && i.dhcp.lease) || DEFAULT_LEASE;
}
/** 伺服器記下（或續約）一筆租約，回傳到期時間。用戶端在租約過了一半時會自動續約 */
function touchLease(state, key, clientKey, ip) {
  const hold = (state.dyn.hold[key] ||= {}), now = state.clock, len = leaseLen(state, key), h = hold[clientKey];
  if (!h || h.ip !== ip) hold[clientKey] = { ip, t0: now, exp: now + len };
  else if (now >= h.t0 + len / 2) { h.t0 = now; h.exp = now + len; }
  return hold[clientKey].exp;
}
/** 用戶端記下自己拿到的租約：之後就算連不到伺服器，到期之前都可以繼續用 */
function rememberLease(state, d, i, key, exp) {
  state.dyn.lease[d.id + '/' + i.id] = { ip: i.rt.ip, bits: i.rt.bits, gw: i.rt.gw, dns: i.rt.dns, tftp: i.rt.tftp || [], wlc: i.rt.wlc || [], server: i.rt.server, relay: i.rt.relay || null, key, exp };
  i.rt.exp = exp;
}
/** ipconfig /release：歸還位址，之後要 /renew 才會再去要 */
export function dhcpRelease(state, devId) {
  const d = state.devices[devId];
  for (const i of d.ifaces) {
    if (i.mode !== 'dhcp') continue;
    const ck = d.id + '/' + i.id, L = state.dyn.lease[ck];
    if (L && L.key) { if (state.leases[L.key]) delete state.leases[L.key][ck]; if (state.dyn.hold[L.key]) delete state.dyn.hold[L.key][ck]; }
    delete state.dyn.lease[ck];
    i.released = true;
  }
}
/** ipconfig /renew：馬上向伺服器續約（或重新要一個位址） */
export function dhcpRenew(state, devId) {
  const d = state.devices[devId];
  for (const i of d.ifaces) {
    if (i.mode !== 'dhcp') continue;
    delete i.released;
    const L = state.dyn.lease[d.id + '/' + i.id], h = L && L.key && (state.dyn.hold[L.key] || {})[d.id + '/' + i.id];
    if (h) h.t0 = -1e9; // 讓伺服器把這次請求當成續約
  }
}

export function leaseFrom(state, old, key, start, end, exclude, clientKey, busy = []) {
  if (start == null || end == null || end < start) return null;
  const tbl = (state.leases[key] ||= {});
  const cnt = useCount(state, key), mine0 = tbl[clientKey];
  const ex = new Set([].concat(exclude ?? []));
  // 別人還沒到期的租約不能動（計數扣掉自己手上的那一個）
  const used = { has: (ip) => ex.has(ip) || (cnt.get(ip) || 0) > (mine0 === ip ? 1 : 0) };
  let ip = old[key] ? old[key][clientKey] : null;
  if (ip != null && (ip < start || ip > end || used.has(ip))) ip = null;
  if (ip == null) {
    const reserved = new Set(Object.entries(old[key] || {}).filter(([k]) => k !== clientKey).map(([, v]) => v));
    const taken = new Set(busy);
    for (let c = start; c <= end && c - start < 4096; c++) if (!used.has(c) && !taken.has(c) && !reserved.has(c)) { ip = c; break; }
    if (ip == null) for (let c = start; c <= end && c - start < 4096; c++) if (!used.has(c) && !taken.has(c)) { ip = c; break; }
    if (busy.length && state.rt) {
      const seen = ((state.rt.dhcpConflict ||= {})[key] ||= []);
      for (const c of busy) if (c >= start && c <= end && !used.has(c) && (ip == null || c < ip) && !seen.includes(c)) seen.push(c);
    }
  }
  if (ip == null) { putLease(state, key, clientKey, undefined); return null; }
  putLease(state, key, clientKey, ip);
  return ip;
}
// 每張租約表裡每個位址被用了幾次（大型拓撲時，每個用戶端都把整張表掃一遍會變成 n²）。
// 記在 state.rt 上：每一輪計算都重建租約表，計數也跟著重來；這一輪裡寫租約一律經過 putLease
function useCount(state, key) {
  const all = state.rt ? (state.rt.leaseUse ||= {}) : null; // VPN 的位址池傳進來的是只有 leases 的物件：不快取
  if (all && all[key]) return all[key];
  const m = new Map();
  for (const v of Object.values(state.leases[key] || {})) m.set(v, (m.get(v) || 0) + 1);
  if (all) all[key] = m;
  return m;
}
/** 寫入（ip 是 undefined 就刪掉）一筆租約，順便更新計數 */
export function putLease(state, key, ck, ip) {
  const tbl = (state.leases[key] ||= {}), old = tbl[ck];
  if (ip === undefined) delete tbl[ck]; else tbl[ck] = ip;
  const m = state.rt && state.rt.leaseUse && state.rt.leaseUse[key];
  if (!m) return;
  if (old !== undefined) m.set(old, m.get(old) - 1);
  if (ip !== undefined) m.set(ip, (m.get(ip) || 0) + 1);
}

/** DHCP 伺服器的回應會從哪些交換器埠進來？若該埠不是 Snooping 信任埠就會被丟掉 */
function snoopBlock(state, path) {
  for (const h of path) {
    if (h.wifi) continue;
    const d = state.devices[h.from];
    if (isVlanSw(d) && d.sw.snoop && d.sw.snoop.on && !d.sw.ports[h.fromPort].trust) return d;
  }
  return null;
}

export function acquire(state, old, d, i) {
  const eps = (i.mode === 'dhcp' && hostDomain(state, d, i)) || l2Explore(state, d.id, i);
  const set = (ip, bits, gw, dns, src, server) => {
    Object.assign(i.rt, { ip, bits, gw, dns, src, server, note: '' });
    return true;
  };
  if (eps.storm) { i.rt.note = `廣播風暴：${state.devices[eps.storm].name} 所在的網段有迴圈，DHCP 完全不通`; return false; }
  if (i.mode === 'pppoe') {
    const e = eps.find((x) => x.iface.line && x.iface.line.type === 'pppoe');
    if (!e) { i.rt.note = 'PPPoE 沒有回應：對面不是 PPPoE 線路，或線還沒接'; return false; }
    const ln = e.iface.line;
    if ((i.user || '').trim() !== ln.user || (i.pass || '') !== ln.pass) { i.rt.note = 'PPPoE 驗證失敗：帳號或密碼錯誤'; return false; }
    return set(parseIp(ln.assign), e.iface.rt.bits, e.iface.rt.ip, dnsList(ln.dns), 'pppoe', e.dev);
  }
  let snooped = null;
  for (const e of eps) {
    const s = e.iface, sd = state.devices[e.dev];
    if (s.rt.ip == null) continue;
    const isServer = s.line ? s.line.type === 'dhcp' : s.dhcp && s.dhcp.on;
    if (!isServer) continue;
    const blk = snoopBlock(state, e.path);
    if (blk) { snooped = { by: blk, server: sd }; continue; }
    if (s.line) {
      // ISP 配發的位址：租約一天，過了一半會自動續約
      const prev = state.dyn.lease[d.id + '/' + i.id], t0 = prev && prev.isp && state.clock < prev.t0 + DEFAULT_LEASE / 2 ? prev.t0 : state.clock;
      set(parseIp(s.line.assign), s.rt.bits, s.rt.ip, dnsList(s.line.dns), 'dhcp', sd.id);
      rememberLease(state, d, i, null, t0 + DEFAULT_LEASE);
      Object.assign(state.dyn.lease[d.id + '/' + i.id], { isp: true, t0 });
      return true;
    }
    const start = parseIp(s.dhcp.start), end = parseIp(s.dhcp.end);
    const inNet = start != null && end != null && sameNet(start, s.rt.ip, s.rt.bits) && sameNet(end, s.rt.ip, s.rt.bits);
    // 保留位址：指定的 MAC 永遠拿到同一個 IP
    const rsv = (s.dhcp.reserved || []).map((r) => ({ mac: String(r.mac || '').trim().toLowerCase(), ip: parseIp(r.ip || '') }))
      .filter((r) => r.mac && r.ip != null && sameNet(r.ip, s.rt.ip, s.rt.bits));
    const mine = rsv.find((r) => r.mac === i.rt.mac);
    let ip;
    if (mine) { ip = mine.ip; putLease(state, sd.id + '/' + s.id, d.id + '/' + i.id, ip); }
    else {
      // 同一個網段上手動設定了 IP 的設備：伺服器 ping 得到它們，不會把這些位址發出去
      const busy = eps.filter((x) => x.iface !== s && x.iface.rt.ip != null && x.iface.rt.src !== 'dhcp' && x.iface.rt.src !== 'apipa').map((x) => x.iface.rt.ip);
      ip = inNet ? leaseFrom(state, old, sd.id + '/' + s.id, start, end, [s.rt.ip, ...rsv.map((r) => r.ip)], d.id + '/' + i.id, busy) : null;
    }
    if (ip == null) { i.rt.note = `${sd.name} 的 DHCP 位址池設定有誤或已用完`; continue; }
    let dns = dnsList(s.dhcp.dns);
    if (!dns.length && sd.dnsProxy) dns = [s.rt.ip];
    set(ip, s.rt.bits, parseIp(s.dhcp.gw) ?? s.rt.ip, dns, 'dhcp', sd.id);
    i.rt.tftp = dnsList(s.dhcp.tftp); // option 150：IP 電話去哪裡下載設定檔
    i.rt.wlc = dnsList(s.dhcp.wlc); // option 43：Cisco 的 AP 去哪裡找無線控制器
    const lk = sd.id + '/' + s.id, ck = d.id + '/' + i.id;
    const h0 = (state.dyn.hold[lk] || {})[ck], renew = !!h0 && h0.ip === ip;
    rememberLease(state, d, i, lk, touchLease(state, lk, ck, ip));
    // 這一刻真的有 DHCP 封包在走（新的租約或續約）：沿路的交換器學到用戶端與伺服器的 MAC
    const hd = state.dyn.hold[lk][ck], sig = state.clock + '|' + e.path.map((x) => x.cable || x.to).join(',') + '#' + eps.length;
    if (hd.t0 === state.clock && !state.dyn.boot) {
      // debug ip dhcp server packet / events 要用（DORA 或續約的 REQUEST / ACK）
      (state.rt.dhcpEv ||= []).push({ srv: sd.id, sif: s.id, cli: d.id, cif: i.id, ip, renew, mac: i.rt.mac });
      if (hd.learned !== sig) {
        const done = new Set();
        for (const x of eps) learnPath(state, x.path, i.rt.mac, done);
        learnPath(state, reversed(e.path), s.rt.mac);
        hd.learned = sig;
      }
    }
    return true;
  }
  if (!i.rt.note) {
    i.rt.note = !i.rt.link ? (i.bind.t === 'wlan' ? i.rt.note || 'Wi-Fi 尚未連線' : '網路線沒有接上，或對端連接埠沒有啟用')
      : eps.dot1x ? `連接埠還沒有通過 802.1X 驗證（${eps.dot1x}）`
      : snooped ? `${snooped.server.name} 的 DHCP 回應被 ${snooped.by.name} 的 DHCP Snooping 擋下（進來的埠不是信任埠）`
        : eps.some((x) => x.iface.line && x.iface.line.type === 'pppoe') ? 'DHCP 沒有回應：這條 ISP 線路要用 PPPoE 撥接'
          : eps.some((x) => x.iface.line && x.iface.line.type === 'static') ? 'DHCP 沒有回應：這條 ISP 線路是固定 IP，需要手動設定'
            : eps.stp ? `DHCP 還沒有回應：${state.devices[eps.stp.dev].name} 的 ${eps.stp.pid} 還在 STP 的 listening / learning 狀態，再 ${Math.ceil(eps.stp.left)} 秒才會開始轉送`
              : eps.span ? `DHCP 沒有回應：${state.devices[eps.span.dev].name} 的 ${eps.span.pid} 是 SPAN（連接埠鏡像）的目的埠，交換器只會從這個埠送出複製的訊框，不轉送一般流量`
              : 'DHCP 沒有回應：這個網段上找不到 DHCP 伺服器';
  }
  return false;
}

/** 透過 DHCP Relay (ip helper-address) 向遠端的 DHCP 伺服器要位址。需要路由表，所以排在後面做 */
export function relayPass(state, old) {
  let changed = false;
  for (const d of Object.values(state.devices)) {
    for (const i of d.ifaces) {
      if (!i.rt.active || i.rt.ip != null || i.mode !== 'dhcp' || !i.rt.link) continue;
      const eps = l2Explore(state, d.id, i);
      if (eps.storm) continue;
      for (const e of eps) {
        const r = e.iface, rd = state.devices[e.dev];
        const helper = parseIp(r.helper || '');
        if (helper == null || r.rt.ip == null) continue;
        const res = transact(state, rd.id, { proto: 'udp', dst: helper, dport: 67, srcIp: r.rt.ip, quiet: true });
        if (!res.ok) { i.rt.note = `DHCP Relay：${rd.name} 連不到 DHCP 伺服器 ${fmtIp(helper)} — ${res.reason}`; continue; }
        const sd = state.devices[res.responder];
        const sc = (sd.dhcpScopes || []).find((s) => {
          const a = parseIp(s.start), b = parseIp(s.end);
          return a != null && b != null && a <= b && sameNet(a, r.rt.ip, r.rt.bits) && sameNet(b, r.rt.ip, r.rt.bits);
        });
        if (!sc) { i.rt.note = `${sd.name} 沒有適用於 ${fmtIp(netOf(r.rt.ip, r.rt.bits))}/${r.rt.bits} 的位址範圍 (Scope)`; continue; }
        const ip = leaseFrom(state, old, sd.id + '/scope/' + sc.start, parseIp(sc.start), parseIp(sc.end), null, d.id + '/' + i.id);
        if (ip == null) { i.rt.note = `${sd.name} 的位址範圍已經用完`; continue; }
        Object.assign(i.rt, { ip, bits: r.rt.bits, gw: parseIp(sc.gw) ?? r.rt.ip, dns: dnsList(sc.dns), tftp: dnsList(sc.tftp), wlc: dnsList(sc.wlc), src: 'dhcp', server: sd.id, relay: rd.id, note: '' });
        rememberLease(state, d, i, sd.id + '/scope/' + sc.start, touchLease(state, sd.id + '/scope/' + sc.start, d.id + '/' + i.id, ip));
        changed = true;
        break;
      }
    }
  }
  return changed;
}

const VRRP_DOWN = 3; // Master_Down_Interval：大約三個通告間隔沒聽到 Master，Backup 才會接手

export function prepVrrp(state) {
  const dyn = state.dyn, now = state.clock;
  const c = [];
  for (const d of Object.values(state.devices)) {
    for (const i of d.ifaces) {
      const v = i.vrrp;
      if (!v || !v.on) continue;
      const vip = parseIp(v.vip || ''), proto = fhrpProto(v), grp = fhrpGroup(v);
      const base = { proto, grp, cfgPrio: +v.prio || 100, pre: fhrpPreempt(v) };
      if (i.rt.ip == null || !i.rt.link) { i.rt.vrrp = { ...base, state: 'init', why: '介面沒有 IP 或沒有連線' }; continue; }
      if (vip == null || !sameNet(vip, i.rt.ip, i.rt.bits)) { i.rt.vrrp = { ...base, state: 'init', why: '虛擬 IP 必須和介面位於同一個子網路' }; continue; }
      // track 的物件 Down：優先權扣掉 decrement（最低到 1）
      const dec = fhrpDecrement(state, d, v), prio = Math.max(1, base.cfgPrio - dec.total);
      c.push({ ...base, d, i, vip, prio, dec, key: d.id + '/' + i.id, k: [prio, i.rt.ip] });
    }
  }
  const prev = Object.fromEntries(c.map((x) => [x.key, dyn.vrrp[x.key] && dyn.vrrp[x.key].state]));
  const live = new Set(c.map((x) => x.key));
  for (const k of Object.keys(dyn.vrrp)) if (!live.has(k)) delete dyn.vrrp[k];
  const better = (a, b) => cmp(a.k, b.k) > 0;
  for (const x of c) {
    // 同一個廣播網域裡、同一個協定與群組號碼的才是同一組（VRRP 和 HSRP 彼此聽不懂，群組號碼不同也各做各的）
    const seen = l2Explore(state, x.d.id, x.i).map((e) => c.find((y) => y.i === e.iface)).filter(Boolean);
    const peers = seen.filter((y) => y.proto === x.proto && y.grp === x.grp && y.vip === x.vip);
    const odd = seen.find((y) => y.vip === x.vip && (y.proto !== x.proto || y.grp !== x.grp));
    const members = [x, ...peers];
    const best = members.reduce((p, q) => (better(q, p) ? q : p));
    let rec = dyn.vrrp[x.key];
    if (!rec) rec = dyn.vrrp[x.key] = dyn.boot ? { state: best === x ? 'master' : 'backup', lost: null } : { state: 'backup', lost: null };
    const master = peers.find((p) => prev[p.key] === 'master'); // 上一刻還在轉送的那一台
    const downIv = x.proto === 'vrrp' ? VRRP_DOWN : HSRP_HOLD;
    let st, wait = 0;
    if (rec.state === 'master') {
      // 我是 Master / Active：比我優先、而且會搶（或本來也是 Master，例如斷掉的線接回來）的那一台出現了才讓出去
      st = peers.some((p) => better(p, x) && (p.pre || prev[p.key] === 'master')) ? 'backup' : 'master';
    } else if (master) {
      // 已經有人在轉送：比它優先、而且有設定 preempt 的才會搶；好幾台都可以搶的話，最優先的那台搶
      const takers = members.filter((p) => p !== master && p.pre && better(p, master));
      const top = takers.reduce((p, q) => (!p || better(q, p) ? q : p), null);
      st = top === x ? 'master' : 'backup';
    } else {
      // 沒有人在轉送：等 Master_Down_Interval（VRRP）/ holdtime（HSRP）之後，優先權最高的接手
      if (rec.lost == null) rec.lost = now;
      wait = best === x ? rec.lost + downIv - now : 0;
      st = best === x && wait <= 0 ? 'master' : 'backup';
      if (best === x && wait > 0) state.rt.pending.push({ at: rec.lost + downIv, dev: x.d.id, kind: 'vrrp', text: `${x.d.name}：聽不到 ${x.proto === 'hsrp' ? 'HSRP Active' : 'VRRP Master'}，等待接手` });
    }
    if (st === 'master' || master) rec.lost = null;
    rec.state = st;
    x.peers = peers;
    x.i.rt.vrrp = { state: st, peers: peers.length, wait: wait > 0 ? wait : 0, proto: x.proto, grp: x.grp, prio: x.prio, cfgPrio: x.cfgPrio, pre: x.pre, dec: x.dec,
      members: peers.map((p) => [p.d.id, p.i.id]), odd: odd ? { dev: odd.d.id, proto: odd.proto, grp: odd.grp } : null };
    if (st === 'master' && x.proto !== 'glbp') x.i.rt.vips.push(x.vip);
  }
  // 這一輪有人接手了：整組的「聽不到 Master」計時歸零（下次 Master 消失才從頭計時）
  for (const x of c) if ([x, ...(x.peers || [])].some((p) => dyn.vrrp[p.key].state === 'master')) dyn.vrrp[x.key].lost = null;
  prepGlbp(state, c);
}

// ── GLBP：AVG（Active）回答虛擬 IP 的 ARP，最多四台 AVF 各負責一個虛擬 MAC 一起轉送 ──
export const GLBP_HOLD = 10;
const glbpMac = (grp, n) => `00:07:b4:00:${(grp & 255).toString(16).padStart(2, '0')}:${n.toString(16).padStart(2, '0')}`;
function prepGlbp(state, c) {
  const now = state.clock, tbl = (state.dyn.glbp ||= {}), out = (state.rt.glbp = {});
  const groups = {};
  for (const x of c) if (x.proto === 'glbp') (groups[fmtIp(x.vip) + '|' + x.grp] ||= []).push(x);
  for (const [k, members] of Object.entries(groups)) {
    const rec = (tbl[k] ||= { fw: {}, lost: {} });
    const alive = new Set(members.map((x) => x.key));
    // 新加入的成員拿最小的空號；回來的成員拿回自己原本的號碼（AVF 的 preempt 預設開啟）
    for (const x of members.slice().sort((a, b) => cmp(b.k, a.k))) { // 優先權高的（通常就是 AVG）先拿到 1 號
      if (rec.fw[x.key] != null) { delete rec.lost[rec.fw[x.key]]; continue; }
      const used = new Set(Object.values(rec.fw));
      let n = 1;
      while (used.has(n) && n < 4) n++;
      if (!used.has(n)) rec.fw[x.key] = n;
    }
    for (const [mk, n] of Object.entries(rec.fw)) {
      if (alive.has(mk)) continue;
      // 這台 AVF 失聯了：它的虛擬 MAC 等 holdtime 之後由其他 AVF 接手
      rec.lost[n] ||= { at: state.dyn.boot ? -1e9 : now, prev: mk };
      delete rec.fw[mk];
    }
    const avg = members.find((x) => state.dyn.vrrp[x.key] && state.dyn.vrrp[x.key].state === 'master');
    const own = Object.entries(rec.fw).map(([mk, n]) => ({ n, mac: glbpMac(members[0].grp, n), owner: mk }));
    const backup = own.slice().sort((a, b) => a.n - b.n)[0];
    for (const [n, L] of Object.entries(rec.lost)) {
      const wait = L.at + GLBP_HOLD - now;
      if (wait > 0) state.rt.pending.push({ at: L.at + GLBP_HOLD, dev: members[0].d.id, kind: 'vrrp', text: `GLBP：其他 AVF 接手 ${glbpMac(members[0].grp, +n)}` });
      own.push({ n: +n, mac: glbpMac(members[0].grp, +n), owner: wait > 0 ? null : backup ? backup.owner : null, wait: wait > 0 ? wait : 0, prev: L.prev });
    }
    own.sort((a, b) => a.n - b.n);
    out[k] = { avg: avg ? avg.key : null, fwds: own };
    for (const x of members) {
      x.i.rt.vrrp.fwd = rec.fw[x.key] ?? null;
      x.i.rt.vrrp.glbp = k;
      if (!x.i.rt.vips.includes(x.vip)) x.i.rt.vips.push(x.vip); // 每一台 AVF 都轉送送到虛擬 IP 的封包
    }
  }
  for (const k of Object.keys(tbl)) if (!groups[k]) delete tbl[k];
}



function buildRoutes(state, d) {
  const r = [];
  const up = (i) => i.rt.ip != null && i.rt.link;
  for (const i of d.ifaces) {
    if (up(i)) r.push({ net: netOf(i.rt.ip, i.rt.bits), bits: i.rt.bits, via: null, iface: i, type: 'C', ad: 0, metric: 0, vrf: vrfOf(i) });
  }
  // SD-WAN 的成員：預設路由改由 SD-WAN 決定（成員的閘道、活著才有）
  const sdw = sdwanOn(d) ? new Set(d.sdwan.members.map((m) => m.iface)) : null;
  if (sdw) r.push(...sdwanRoutes(state, d));
  for (const i of d.ifaces) {
    if (!up(i) || i.rt.gw == null || (sdw && sdw.has(i.id))) continue;
    const ok = sameNet(i.rt.gw, i.rt.ip, i.rt.bits) && i.rt.gw !== i.rt.ip;
    r.push({
      net: 0, bits: 0, via: i.rt.gw, iface: i, type: i.rt.src === 'static' ? 'S' : 'D', ad: 1, metric: 0, vrf: vrfOf(i),
      bad: ok ? null : `預設閘道 ${fmtIp(i.rt.gw)} 和 ${fmtIp(i.rt.ip)}/${i.rt.bits} 不在同一個子網路`,
    });
  }
  for (const s of d.routes || []) {
    const dst = parseIp(s.dst), bits = parseMask(s.mask), via = parseIp(s.via);
    if (dst == null || bits == null) continue;
    if (s.track != null && s.track !== '' && !trackUp(state, d, s.track).up) continue; // 追蹤的物件 Down：這條路由從路由表撤掉
    if (via == null) {
      // ip route <網段> <遮罩> Tunnel0：只寫出口介面（點對點的介面不需要下一站）
      const out = s.outIf ? d.ifaces.find((x) => x.id === s.outIf) : null;
      // ip route 0.0.0.0 0.0.0.0 Dialer1：PPPoE 的點對點連線，下一站就是 ISP 那一端
      if (out && out.bind.t === 'dialer') {
        const ph = d.ifaces.find((x) => x.viaDialer === out.id), ok = ph && up(ph) && ph.rt.gw != null;
        r.push({ net: netOf(dst, bits), bits, via: ok ? ph.rt.gw : null, iface: ok ? ph : null, type: 'S', ad: Math.max(1, +s.ad || 1), metric: 0, vrf: s.vrf || '', exitIf: true, bad: ok ? null : `${out.label} 還沒有撥接成功（PPPoE）` });
        continue;
      }
      if (!out || !isTun(out)) continue;
      r.push({ net: netOf(dst, bits), bits, via: null, iface: up(out) ? out : null, type: 'S', ad: Math.max(1, +s.ad || 1), metric: 0, vrf: s.vrf || '', exitIf: true,
        bad: up(out) ? null : `出口介面 ${out.label} 是 line protocol down（${(out.rt.tun && out.rt.tun.why) || '沒有 IP'}）` });
      continue;
    }
    // ip route vrf X …：下一站要在同一個 VRF 的直連網段上。VRF 之間的路由洩漏有兩種寫法：
    //   ip route vrf X <網段> <遮罩> <下一站> global：下一站在全域的路由表找
    //   ip route [vrf X] <網段> <遮罩> <出口介面> <下一站>：出口介面可以在別的 VRF（或全域）
    const v = s.vrf || '';
    const on = (x) => up(x) && sameNet(via, x.rt.ip, x.rt.bits) && via !== x.rt.ip;
    const out = s.outIf ? d.ifaces.find((x) => x.id === s.outIf) : null;
    const i = s.outIf ? (out && on(out) ? out : null) : d.ifaces.find((x) => on(x) && vrfOf(x) === (s.global ? '' : v));
    r.push({
      net: netOf(dst, bits), bits, via, iface: i || null, type: 'S', ad: Math.max(1, +s.ad || 1), metric: 0, vrf: v,
      ...(i && vrfOf(i) !== v ? { leak: vrfOf(i) || 'global' } : {}), ...(s.outIf ? { exitIf: true } : {}),
      bad: i ? null : s.outIf ? (!out ? `出口介面 ${s.outIf} 不存在` : !up(out) ? `出口介面 ${out.label} 沒有 IP 或沒有連線` : `下一站 ${fmtIp(via)} 不在 ${out.label} 的網段上`)
        : `下一站 ${fmtIp(via)} 不在${s.global ? '全域路由表的' : v ? ` VRF ${v} 的` : '任何已連線的'}直連網段上`,
    });
  }
  r.push(...nhrpRoutes(state, d)); // DMVPN phase 3 的 NHRP 捷徑
  d.rt.routes = r;
}

/**
 * 最長相符，再比管理距離、metric。好幾條一樣好的路（等價多路徑）：依來源與目的位址雜湊挑一條，
 * 同一對位址永遠走同一條（CEF 的 per-destination load sharing），不同的主機會分散到不同的路
 */
export function lookupRoute(d, ip, src, vrf = '') {
  let best = null;
  const ties = [];
  for (const r of d.rt.routes) {
    if (r.bad || (r.vrf || '') !== vrf || netOf(ip, r.bits) !== r.net) continue;
    if (!best || r.bits > best.bits || (r.bits === best.bits && (r.ad < best.ad || (r.ad === best.ad && r.metric < best.metric)))) { best = r; ties.length = 0; ties.push(r); }
    else if (r.bits === best.bits && r.ad === best.ad && r.metric === best.metric && r.via !== best.via) ties.push(r);
  }
  if (ties.length > 1 && src != null) return ties[hash(fmtIp(src) + '>' + fmtIp(ip)) % ties.length];
  return best;
}
/** 某個目的地所有等價的路（給 show ip route 與 traceroute 用） */
export function routesTo(d, ip, vrf = '') {
  const best = lookupRoute(d, ip, undefined, vrf);
  return best ? d.rt.routes.filter((r) => !r.bad && (r.vrf || '') === vrf && r.net === best.net && r.bits === best.bits && r.ad === best.ad && r.metric === best.metric) : [];
}

/**
 * 這個介面有沒有跑 OSPF：在介面上直接啟用，或它的 IP 落在某一條 network 敘述的範圍內。
 * network 敘述是持續生效的 — 之後才設定 IP 的介面，只要位址符合就會自動加入。
 */
export function ospfOn(d, i) {
  // 介面在 VRF 裡：要那個 VRF 有 OSPF 程序（router ospf <pid> vrf <名稱>）才算
  return ospfArea(d, i) != null;
}
/**
 * 圖形介面的開關：關閉時連同涵蓋它的 network 敘述一起移除（其他被同一條敘述涵蓋的介面維持啟用）。
 * 介面在 VRF 裡、那個 VRF 還沒有 OSPF 程序：自動建立一個（router ospf <下一個沒用過的編號> vrf <名稱>）
 */
export function setOspf(d, i, on) {
  const v = vrfOf(i);
  if (on) {
    if (v && !(d.ospfVrf || {})[v]) {
      const used = new Set([1, ...Object.values(d.ospfVrf || {}).map((c) => +c.pid)]);
      let pid = 2;
      while (used.has(pid)) pid++;
      (d.ospfVrf ||= {})[v] = { pid, ospfNets: [] };
    }
    i.ospf = true;
    return;
  }
  const c = v ? (d.ospfVrf || {})[v] : d;
  const ip = i.rt && i.rt.ip != null ? i.rt.ip : parseIp(i.ip || '');
  const hit = (n) => ip != null && netOf(ip, n.bits) === n.net;
  if (c) {
    for (const x of d.ifaces) if (x !== i && vrfOf(x) === v && !x.ospf && ospfOn(d, x) && (c.ospfNets || []).some((n) => hit(n) && netOf(x.rt && x.rt.ip != null ? x.rt.ip : parseIp(x.ip || '') ?? -1, n.bits) === n.net)) x.ospf = true;
    if (c.ospfNets) c.ospfNets = c.ospfNets.filter((n) => !hit(n));
  }
  i.ospf = false;
}

/** 算一次所有設備的路由表：直連 / 靜態 → OSPF → BGP。quiet：試算（不記 BGP 的事件） */
function routesOnce(state, quiet) {
  for (const d of Object.values(state.devices)) {
    for (const k of Object.keys(d.rt)) if (/^(ospf|nbrs)(@.*)?$/.test(k)) delete d.rt[k];
    d.rt.nbrs = [];
    delete d.rt.bgp;
    buildRoutes(state, d);
  }
  computeOspf(state, ospfOn);
  computeEigrp(state, { ospfOn, log: quiet ? () => {} : (d, msg) => logEvent(state, d, 5, 'DUAL-5-NBRCHANGE', msg) });
  computeRip(state, { ospfOn });
  computeBgp(state, { transact, logEvent: quiet ? () => {} : logEvent, ospfOn, lookupRoute });
  // OSPF 先算的時候還沒有 BGP / EIGRP 的路：有設備把它們重分配進 OSPF，就留著那些路、把 OSPF 的路拿掉再算一次
  const devs = Object.values(state.devices);
  if (devs.some((d) => d.rt && (d.ospfRedist || []).some((r) => (r.src === 'bgp' && d.rt.routes.some((x) => x.type === 'B')) || (r.src === 'eigrp' && d.rt.eigrp) || (r.src === 'rip' && d.rt.rip)))) {
    for (const d of devs) if (d.rt && d.rt.routes) d.rt.routes = d.rt.routes.filter((r) => r.type !== 'O');
    computeOspf(state, ospfOn);
  }
}

// OSPF / BGP 跨次計算的狀態：試算之前先存起來，試算完還原（不然鄰居的計時會被試算打斷）
const dynSnap = (state) => Object.fromEntries(Object.keys(state.dyn).filter((k) => /^(adj|seg|lsa|rid|bgp|eigrp|rip)/.test(k)).map((k) => [k, JSON.stringify(state.dyn[k])]));
function dynRestore(state, snap) {
  for (const k of Object.keys(state.dyn)) if (/^(adj|seg|lsa|rid|bgp|eigrp|rip)/.test(k) && !(k in snap)) delete state.dyn[k];
  for (const [k, v] of Object.entries(snap)) state.dyn[k] = JSON.parse(v);
}

/**
 * 有 Tunnel 介面時：Tunnel 的 line protocol 要看「外層」的路由，Tunnel 上跑的 OSPF / BGP 又會改變路由表。
 * 先把 Tunnel 當成 down 算出外層的路由 → 決定每個 Tunnel 的狀態（IPsec、keepalive、NHRP 註冊）→ 還原計時、正式算一次 →
 * 通往 tunnel destination 的路改走 Tunnel 自己（recursive routing）的話，把那個 Tunnel 暫停、再算一次
 */
export function routesAll(state) {
  const tifs = tunIfaces(state);
  if (!tifs.length) routesOnce(state);
  else {
    const snap = dynSnap(state), pend = state.rt.pending.length;
    for (const { i } of tifs) i.rt.link = false;
    routesOnce(state, true);
    state.rt.pending.length = pend; // 試算的收斂計時不算數
    greLines(state, tifs);
    prepTunnels(state);
    greReach(state, tifs);
    dynRestore(state, snap);
    for (const { i } of tifs) i.rt.link = i.rt.tun.up;
    const pend2 = state.rt.pending.length;
    routesOnce(state);
    const pend3 = state.rt.pending.length;
    if (greRecursion(state, tifs)) {
      dynRestore(state, snap);
      state.rt.pending.splice(pend2, pend3 - pend2); // 這一輪 OSPF / BGP 的計時作廢，留下 recursive routing 的暫停計時
      for (const { i } of tifs) i.rt.link = i.rt.tun.up;
      routesOnce(state);
    }
  }
  // show ip route 的「00:03:43」：OSPF / BGP 的路從什麼時候開始在路由表裡
  const since = (state.dyn.rtSince ||= {});
  for (const d of Object.values(state.devices)) {
    const old = since[d.id] || {}, now = {};
    for (const r of d.rt.routes || []) {
      if (r.type !== 'O' && r.type !== 'B' && r.type !== 'E' && r.type !== 'R') continue;
      const k = r.type + '|' + r.net + '/' + r.bits + '|' + r.via;
      r.since = now[k] = old[k] ?? state.clock;
    }
    if (Object.keys(now).length) since[d.id] = now; else delete since[d.id];
  }
}
/** DHCP 的四個步驟 (DORA)：依目前的租約重建過程，給動畫與終端機的 ipconfig /renew 用 */
export function dhcpTrace(state, devId) {
  const d = state.devices[devId];
  const log = [], hops = [];
  const i = d.ifaces.find((x) => x.rt.src === 'dhcp') || d.ifaces.find((x) => x.mode === 'dhcp' && x.rt.active && x.rt.link) || d.ifaces.find((x) => x.mode === 'dhcp');
  if (!i) return { ok: false, reason: `${d.name} 沒有設成「自動取得 IP (DHCP)」`, log, hops };
  const eps = i.rt.link ? l2Explore(state, d.id, i) : [];
  const wave = buildWave(eps);
  log.push({ dev: d.id, kind: 'dhcp', text: 'DHCP Discover（廣播）：我需要一個 IP，有 DHCP 伺服器嗎？' });
  if (wave.length) hops.push({ wave, proto: 'dhcp' });
  // 線路上真正的 DHCP 訊框（計數器、封包擷取）
  const xid = hash(d.id + '/' + i.id + '@' + Math.floor(state.clock)).toString(16).padStart(8, '0');
  const bcast = (type) => ({ proto: 'dhcp', smac: i.rt.mac, dmac: BCAST, src: 0, dst: 0xffffffff, sport: 68, dport: 67, dhcp: { type, xid } });
  for (const lvl of wave) for (const x of lvl) onHop(state, x, bcast('discover'), null);
  if (i.rt.src !== 'dhcp') {
    const reason = i.rt.note || 'DHCP 沒有回應';
    log.push({ dev: d.id, kind: 'drop', text: reason });
    return { ok: false, reason, log, hops, iface: i };
  }
  const sd = state.devices[i.rt.server];
  const via = i.rt.relay ? state.devices[i.rt.relay] : sd;
  const e = eps.find((x) => x.dev === via.id && (i.rt.relay ? x.iface.helper : x.iface.line || (x.iface.dhcp && x.iface.dhcp.on))) || eps.find((x) => x.dev === via.id);
  const back = e ? [...e.path].reverse().map((h) => ({ cable: h.cable, wifi: h.wifi, from: h.to, to: h.from, tag: h.tag, reply: true, proto: 'dhcp' })) : [];
  if (i.rt.relay) log.push({ dev: via.id, kind: 'dhcp', text: `DHCP Relay：${via.name} 把廣播改成單點傳送，轉交給 ${sd.name}` });
  log.push({ dev: sd.id, kind: 'dhcp', text: `DHCP Offer：${sd.name} 提供 ${fmtIp(i.rt.ip)}` });
  hops.push(...back);
  const uni = (type) => ({ proto: 'dhcp', smac: e ? e.iface.rt.mac : '', dmac: i.rt.mac, src: e ? e.iface.rt.ip : 0, dst: i.rt.ip, sport: 67, dport: 68, dhcp: { type, xid, ip: i.rt.ip } });
  if (e) for (const x of reversed(e.path)) onHop(state, x, uni('offer'), null);
  log.push({ dev: d.id, kind: 'dhcp', text: `DHCP Request（廣播）：我要使用 ${fmtIp(i.rt.ip)}` });
  if (wave.length) hops.push({ wave, proto: 'dhcp' });
  for (const lvl of wave) for (const x of lvl) onHop(state, x, bcast('request'), null);
  log.push({ dev: sd.id, kind: 'ok', text: `DHCP Ack：租約成立 — ${fmtIp(i.rt.ip)}/${i.rt.bits}、閘道 ${i.rt.gw != null ? fmtIp(i.rt.gw) : '無'}、DNS ${i.rt.dns.map(fmtIp).join(', ') || '無'}` });
  hops.push(...back);
  if (e) for (const x of reversed(e.path)) onHop(state, x, uni('ack'), null);
  return { ok: true, log, hops, iface: i };
}
/** 給「狀態」分頁用的路由表文字 */
export function routeRows(dev, vrf = '') {
  const name = { C: '直連', S: '靜態', D: '自動', O: 'OSPF', B: 'BGP', H: 'NHRP 捷徑', E: 'EIGRP', R: 'RIP' };
  return dev.rt.routes
    .filter((r) => (r.vrf || '') === vrf)
    .sort((a, b) => a.ad - b.ad || a.net - b.net)
    .map((r) => ({
      type: r.type, typeName: name[r.type], sub: r.sub || '',
      dst: r.bits === 0 ? '0.0.0.0/0（預設）' : `${fmtIp(r.net)}/${r.bits}`,
      via: r.via == null ? '直連' : fmtIp(r.via),
      iface: r.iface ? r.iface.label : '—',
      ad: r.ad, metric: r.real ?? r.metric, bad: r.bad || '',
    }));
}
