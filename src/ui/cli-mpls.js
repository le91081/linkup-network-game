// IOS 的 MPLS / MPLS L3VPN：show mpls ldp neighbor、show mpls interfaces、show mpls forwarding-table、
// show bgp vpnv4 unicast all [summary]、show vrf detail
import { fmtIp, netOf } from '../engine/ip.js';
import { longIf } from '../engine/ops.js';
import { ldpId, ldpNeighbors, mplsOn, vpnTable, vpnLabel } from '../engine/mplsvpn.js';

const pad = (s, n) => String(s).padEnd(n);
const hms = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s) % 60].map((x) => String(x).padStart(2, '0')).join(':');
const pfx = (net, bits) => `${fmtIp(netOf(net, bits))}/${bits}`;
const NO_MPLS = (d) => (d.kind === 'router' ? null : ['% Invalid input detected at \'^\' marker.（這台設備沒有 MPLS）']);

export function showLdpNeighbor(st, d) {
  const no = NO_MPLS(d); if (no) return no;
  const me = ldpId(d), up = ldpNeighbors(st, d).filter((n) => n.up);
  if (!d.ifaces.some(mplsOn)) return ['（沒有任何介面啟用 mpls ip：LDP 沒有在跑）'];
  if (!up.length) return ['（沒有 LDP 鄰居：直連的線兩端都要 mpls ip）'];
  const o = [];
  for (const n of up) {
    const pid = ldpId(n.dev);
    o.push(`    Peer LDP Ident: ${fmtIp(pid)}:0; Local LDP Ident ${fmtIp(me)}:0`,
      `        TCP connection: ${fmtIp(pid)}.646 - ${fmtIp(me)}.${40000 + (pid % 20000)}`,
      '        State: Oper; Msgs sent/rcvd: 42/41; Downstream',
      `        Up time: ${hms(Math.min(st.clock || 0, 86399) + 600)}`,
      '        LDP discovery sources:',
      `          ${longIf(n.iface.label)}, Src IP addr: ${fmtIp(n.oiface.rt.ip)}`,
      '        Addresses bound to peer LDP Ident:',
      '          ' + n.dev.ifaces.filter((i) => i.rt && i.rt.ip != null && !i.vrf).map((i) => pad(fmtIp(i.rt.ip), 16)).join(''));
  }
  return o;
}

export function showMplsInterfaces(st, d) {
  const no = NO_MPLS(d); if (no) return no;
  const ifs = d.ifaces.filter(mplsOn);
  if (!ifs.length) return ['（沒有任何介面啟用 mpls ip）'];
  return [pad('Interface', 23) + pad('IP', 14) + pad('Tunnel', 9) + pad('BGP', 4) + pad('Static', 7) + 'Operational',
    ...ifs.map((i) => pad(longIf(i.label), 23) + pad('Yes (ldp)', 14) + pad('No', 9) + pad('No', 4) + pad('No', 7) + (i.rt && i.rt.link ? 'Yes' : 'No'))];
}

/** 這台設備替全域路由表裡的每個網段配的本地標籤（16 起跳；直連的 Loopback 也有，給上游 PHP 用） */
function localLabels(d) {
  const nets = [];
  for (const r of d.rt.routes || []) {
    if (r.bad || r.vrf || r.type === 'B' || r.mpls) continue;
    const k = r.net + '/' + r.bits;
    if (!nets.some((x) => x.k === k)) nets.push({ k, net: r.net, bits: r.bits, r });
  }
  nets.sort((a, b) => (a.net >>> 0) - (b.net >>> 0) || a.bits - b.bits);
  const base = 16 + Object.keys(d.vrfs || {}).length * 3 + 1;
  return nets.map((x, n) => ({ ...x, label: base + n }));
}
const ownsNet = (dev, net, bits) => dev.ifaces.some((i) => i.rt && i.rt.ip != null && !i.vrf && netOf(i.rt.ip, bits) === net && (bits === 32 ? i.rt.ip === net : i.rt.bits === bits));

export function showMplsForwarding(st, d) {
  const no = NO_MPLS(d); if (no) return no;
  if (!d.ifaces.some(mplsOn)) return ['（沒有任何介面啟用 mpls ip：沒有標籤轉送表）'];
  const nbrs = ldpNeighbors(st, d).filter((n) => n.up);
  const o = [pad('Local', 11) + pad('Outgoing', 11) + pad('Prefix', 17) + pad('Bytes Label', 14) + pad('Outgoing', 11) + 'Next Hop',
    pad('Label', 11) + pad('Label', 11) + pad('or Tunnel Id', 17) + pad('Switched', 14) + 'interface'];
  for (const x of localLabels(d)) {
    if (x.r.type === 'C') continue; // 直連的網段：自己是終點（對上游宣告 implicit-null）
    const nb = x.r.iface && nbrs.find((n) => n.iface === x.r.iface && (x.r.via == null || n.oiface.rt.ip === x.r.via));
    let out = 'No Label';
    if (nb) {
      if (ownsNet(nb.dev, x.net, x.bits)) out = 'Pop Label';
      else { const t = localLabels(nb.dev).find((y) => y.k === x.k); out = t ? String(t.label) : 'No Label'; }
    }
    o.push(pad(x.label, 11) + pad(out, 11) + pad(pfx(x.net, x.bits), 17) + pad('0', 14) + pad(x.r.iface ? x.r.iface.label : '', 11) + (x.r.via != null ? fmtIp(x.r.via) : ''));
  }
  for (const v of Object.keys(d.vrfs || {})) {
    const sent = ((d.rt.vpn || {}).sent || []).filter((r) => r.vrf === v);
    if (sent.length) o.push(pad(vpnLabel(d, v), 11) + pad('No Label', 11) + pad(`${v}(vrf)`, 17) + pad('0', 14) + `aggregate/${v}`);
  }
  return o;
}

export function showVpnv4(st, d, summary) {
  const no = NO_MPLS(d); if (no) return no;
  const v = d.rt && d.rt.vpn;
  if (!d.bgp || !(d.bgp.neighbors || []).some((n) => n.vpnv4)) return ['（這台沒有 VPNv4 鄰居：router bgp → address-family vpnv4 → neighbor <PE 的 Loopback> activate）'];
  const rid = (d.rt.bgp && d.rt.bgp.rid) != null ? fmtIp(d.rt.bgp.rid) : '0.0.0.0';
  if (summary) {
    const o = [`BGP router identifier ${rid}, local AS number ${d.bgp.asn}`, 'BGP table version is 12, main routing table version 12', '',
      'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd'];
    for (const p of (v && v.peers) || []) {
      const est = p.state === 'Established';
      o.push(pad(p.ip, 16) + '4' + String(d.bgp.asn).padStart(13) + '31'.padStart(8) + '33'.padStart(8) + '12'.padStart(9) + '0'.padStart(5) + '0'.padStart(5) + ' ' + pad(est ? '00:21:14' : 'never', 9) + (est ? String(p.pfx).padStart(8) : p.state));
      if (p.why) o.push(`  （${p.why}）`);
    }
    return o;
  }
  const rows = vpnTable(d) || [];
  const o = [`BGP table version is 12, local router ID is ${rid}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,', '              r RIB-failure, S Stale, m multipath, b backup-path', 'Origin codes: i - IGP, e - EGP, ? - incomplete',
    '     ' + pad('Network', 17) + pad('Next Hop', 20) + pad('Metric', 7) + pad('LocPrf', 7) + pad('Weight', 7) + 'Path'];
  const line = (r) => (r.local ? ' *>  ' : r.nhOk ? ' *>i ' : ' *i  ') + pad(pfx(r.net, r.bits), 17) + pad(r.local ? (r.type === 'S' && r.via ? fmtIp(r.via) : '0.0.0.0') : fmtIp(r.nh), 20) + pad('0', 7) + pad(r.local ? '' : '100', 7) + pad(r.local ? '32768' : '0', 7) + '?';
  for (const [name, cfg] of Object.entries(d.vrfs || {})) {
    if (!cfg.rd) continue;
    const mine = rows.filter((r) => (r.into || []).includes(name));
    if (!mine.length) continue;
    o.push(`Route Distinguisher: ${cfg.rd} (default for vrf ${name})`, ...mine.map(line));
  }
  // 收到的路：原本的 RD 不是這台任何一個 VRF 的，另外列在它自己的 RD 底下（附上它帶的 RT）
  const own = new Set(Object.values(d.vrfs || {}).map((c) => c.rd));
  const others = rows.filter((r) => !r.local && !own.has(r.rd) && (r.into || []).length);
  for (const rd of [...new Set(others.map((r) => r.rd))]) o.push(`Route Distinguisher: ${rd}`, ...others.filter((r) => r.rd === rd).map(line));
  const dropped = rows.filter((r) => !r.local && !(r.into || []).length);
  if (dropped.length) o.push('', `（另外收到 ${dropped.length} 筆，RT 是 ${[...new Set(dropped.flatMap((r) => r.rts))].join('、') || '（沒有 RT：對面沒有送 extended community）'}，這台沒有任何 VRF 匯入它們，直接丟掉）`);
  return o;
}

export function showVrfDetail(st, d, name) {
  const vs = Object.entries(d.vrfs || {}).filter(([n]) => !name || n === name);
  if (!vs.length) return [name ? `% VRF ${name} does not exist` : '（這台沒有設定任何 VRF）'];
  const o = [];
  vs.forEach(([n, v], k) => {
    const ifs = d.ifaces.filter((i) => i.vrf === n).map((i) => i.label);
    o.push(`VRF ${n} (VRF Id = ${k + 1}); default RD ${v.rd || '<not set>'}; default VPNID <not set>`, '  Interfaces:', '    ' + (ifs.join('  ') || '（沒有）'),
      `Address family ipv4 unicast (Table ID = 0x${(k + 1).toString(16)}):`,
      ...(v.rtExp && v.rtExp.length ? ['  Export VPN route-target communities', '    ' + v.rtExp.map((x) => 'RT:' + x).join('  ')] : ['  No Export VPN route-target communities']),
      ...(v.rtImp && v.rtImp.length ? ['  Import VPN route-target communities', '    ' + v.rtImp.map((x) => 'RT:' + x).join('  ')] : ['  No Import VPN route-target communities']),
      '  No import route-map', '  No export route-map', '');
  });
  return o;
}
