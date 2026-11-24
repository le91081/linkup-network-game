// 業者骨幹的 MPLS L3VPN：PE 上的 VRF（RD、route-target）、PE 之間的 MP-BGP（VPNv4）、核心的 LDP 標籤
//
// 設定（IOS）：
//   d.vrfs[名稱] = { rd, rtImp: ['64500:1'], rtExp: ['64500:1'] }        vrf definition / route-target import|export|both
//   介面 i.mpls = true                                                    mpls ip（LDP）
//   d.bgp.neighbors[n].vpnv4 = true                                       address-family vpnv4 → neighbor <ip> activate
//   d.bgp.neighbors[n].vpnNoExt = true                                    no neighbor <ip> send-community extended（RT 跟著不見）
//   d.bgp.vrfAf[名稱] = { conn, static }                                  address-family ipv4 vrf <名稱> → redistribute connected / static
//
// 計算（routesOnce 的最後，BGP 鄰居算好之後）：
//   每台 PE 把 VRF 裡的直連 / 靜態路由（有 redistribute 的）帶上 RD 與匯出的 RT，變成 VPNv4 路由；
//   兩台 PE 之間的 BGP 是 Established、兩端都在 vpnv4 啟用了對方：對面就收到這些路由，
//   RT 和自己某個 VRF 的匯入 RT 對得上才放進那個 VRF 的路由表（type 'B'，下一站是對面 PE 的 Loopback）。
//   同一台 PE 上的兩個 VRF 之間也一樣照 RT 匯入（route.leakVrf：來源的 VRF；直接從那個 VRF 的介面送出去，不貼標籤）。
// 轉送（sim/forward.js）：VRF 的路由帶著 mpls 的話，封包貼上 VPN 標籤、在全域的路由表走到對面的 PE；
//   路上每一段兩端都要有 mpls ip（LDP 才有標籤），不然在那一站被丟掉。
import { parseIp, fmtIp, netOf } from './ip.js';

const RT_RE = /^(\d+|\d+\.\d+\.\d+\.\d+):\d+$/;
export const validRt = (s) => RT_RE.test(String(s || ''));
export const mplsOn = (i) => !!(i && i.mpls);
/** VPN 標籤：每個 VRF 一個（per-VRF label），從 16 開始 */
export const vpnLabel = (d, vrf) => 16 + Object.keys(d.vrfs || {}).sort().indexOf(vrf) * 3 + 1;
/** LDP 的 router ID：最大的 Loopback 位址，沒有就是最大的實體介面位址 */
export function ldpId(d) {
  const lo = d.ifaces.filter((i) => i.bind.t === 'loop' && i.rt && i.rt.ip != null && !i.vrf).map((i) => i.rt.ip);
  const any = d.ifaces.filter((i) => i.rt && i.rt.ip != null && !i.vrf).map((i) => i.rt.ip);
  const pool = lo.length ? lo : any;
  return pool.length ? Math.max(...pool.map((x) => x >>> 0)) >>> 0 : null;
}

/** LDP 鄰居：直連的線兩端都 mpls ip、在全域的路由表裡、線是通的 */
export function ldpNeighbors(state, d) {
  const out = [];
  for (const i of d.ifaces) {
    if (!mplsOn(i) || i.vrf || !i.rt || i.rt.ip == null || !i.rt.link) continue;
    const b = i.bind;
    if (b.t !== 'port' && b.t !== 'sub') continue;
    const l = state.rt.links[d.id + ':' + b.port];
    if (!l) continue;
    const o = state.devices[l.dev];
    const oi = o && o.ifaces.find((x) => (x.bind.t === 'port' || x.bind.t === 'sub') && x.bind.port === l.port && (b.t !== 'sub' || x.bind.vlan === b.vlan));
    if (!oi || !oi.rt || oi.rt.ip == null) continue;
    out.push({ iface: i, dev: o, oiface: oi, up: mplsOn(oi) && !oi.vrf });
  }
  return out;
}

/** 這台 PE 送給 VPNv4 鄰居的路由（還沒套 RT 的篩選） */
function exportsOf(d) {
  const out = [];
  for (const [v, cfg] of Object.entries(d.vrfs || {})) {
    const af = ((d.bgp && d.bgp.vrfAf) || {})[v];
    if (!af || !cfg.rd) continue;
    for (const r of d.rt.routes || []) {
      if (r.bad || (r.vrf || '') !== v || r.mpls) continue;
      if (!((r.type === 'C' && af.conn) || (r.type === 'S' && af.static))) continue;
      if (out.some((x) => x.vrf === v && x.net === r.net && x.bits === r.bits)) continue;
      out.push({ vrf: v, rd: cfg.rd, net: r.net, bits: r.bits, rts: [...(cfg.rtExp || [])], label: vpnLabel(d, v), type: r.type, via: r.via ?? null });
    }
  }
  return out;
}

/**
 * 算 VPNv4：每台 PE 的 d.rt.vpn = { sent: [...], rcvd: [...], table: [...] }，並把匯入的路放進 VRF 的路由表。
 * lookupRoute：查全域路由表（下一站要查得到）
 */
export function computeVpn(state, { lookupRoute }) {
  const pes = Object.values(state.devices).filter((d) => d.rt && d.rt.bgp && d.bgp && (d.bgp.neighbors || []).some((n) => n.vpnv4));
  for (const d of Object.values(state.devices)) if (d.rt) delete d.rt.vpn;
  if (!pes.length) return;
  const byIp = new Map();
  for (const d of pes) for (const i of d.ifaces) if (i.rt && i.rt.ip != null && !i.vrf) byIp.set(i.rt.ip, d);
  for (const d of pes) d.rt.vpn = { sent: exportsOf(d), rcvd: [], peers: [] };
  for (const d of pes) {
    for (const n of d.bgp.neighbors) {
      if (!n.vpnv4) continue;
      const peer = (d.rt.bgp.peers || []).find((p) => p.ip === n.ip);
      const o = byIp.get(parseIp(n.ip));
      const back = o && (o.bgp.neighbors || []).find((x) => byIp.get(parseIp(x.ip)) === d);
      const rec = { ip: n.ip, dev: o ? o.id : null, state: peer ? peer.state : 'Idle', pfx: 0, why: '' };
      d.rt.vpn.peers.push(rec);
      if (!peer || peer.state !== 'Established') { rec.why = peer && peer.why ? peer.why : 'BGP 鄰居還沒有建立'; continue; }
      if (!back || !back.vpnv4) { rec.why = `${o ? o.name : n.ip} 沒有在 address-family vpnv4 底下 activate 這個鄰居：兩端都要啟用，才會交換 VPNv4 路由`; continue; }
      // 對面送過來的：下一站是對面送 BGP 用的位址（鄰居關係建立在它上面，通常是 update-source 的 Loopback）
      const nh = parseIp(n.ip);
      for (const r of o.rt.vpn.sent) {
        d.rt.vpn.rcvd.push({ ...r, rts: back.vpnNoExt ? [] : r.rts, from: o.id, nh, peerIp: n.ip });
        rec.pfx++;
      }
    }
  }
  // 匯入：RT 對得上的才放進 VRF；下一站在全域的路由表要查得到
  for (const d of pes) {
    const vpn = d.rt.vpn;
    vpn.table = [];
    for (const r of vpn.rcvd) {
      const into = Object.entries(d.vrfs || {}).filter(([, cfg]) => (cfg.rtImp || []).some((x) => r.rts.includes(x))).map(([v]) => v);
      const nhRoute = lookupRoute(d, r.nh, undefined, '');
      const row = { ...r, into, nhOk: !!(nhRoute && nhRoute.iface) };
      vpn.table.push(row);
      if (!row.nhOk) continue;
      for (const v of into) {
        // 同一個 VRF 裡自己就有的直連 / 靜態路由優先（AD 比較小），這裡照樣放進去，由路由表挑
        d.rt.routes.push({
          net: r.net, bits: r.bits, via: r.nh, iface: nhRoute.iface, type: 'B', ad: 200, metric: 0, vrf: v,
          mpls: { pe: r.from, vrf: r.vrf, label: r.label, nh: r.nh, rd: r.rd }, ibgp: true,
        });
      }
    }
  }
  // 同一台 PE 上的 VRF 之間：一個 VRF 匯出的路，RT 和「同一台」另一個 VRF 的匯入清單對得上，一樣會被匯進去
  // （在 BGP 裡完成，封包不出這台設備、也不貼標籤）。共用服務的 VRF 和客戶接在同一台 PE 時就是靠這個
  for (const d of pes) {
    for (const r of d.rt.vpn.sent) {
      const src = (d.rt.routes || []).find((x) => !x.bad && !x.mpls && !x.leakVrf && (x.vrf || '') === r.vrf && x.net === r.net && x.bits === r.bits && (x.type === 'C' || x.type === 'S'));
      if (!src) continue;
      for (const [v, cfg] of Object.entries(d.vrfs || {})) {
        if (v === r.vrf || !(cfg.rtImp || []).some((x) => r.rts.includes(x))) continue;
        d.rt.routes.push({ net: r.net, bits: r.bits, via: src.via ?? null, iface: src.iface, type: 'B', ad: 20, metric: 0, vrf: v, leakVrf: r.vrf });
        (r.localInto ||= []).push(v);
      }
    }
  }
}

/** show bgp vpnv4 unicast all 的資料：自己送出的（下一站 0.0.0.0）加上收到的 */
export function vpnTable(d) {
  const v = d.rt && d.rt.vpn;
  if (!v) return null;
  return [...v.sent.map((r) => ({ ...r, nh: 0, local: true, into: [r.vrf, ...(r.localInto || [])] })), ...v.table];
}
export const fmtPfx = (r) => `${fmtIp(netOf(r.net, r.bits))}/${r.bits}`;
