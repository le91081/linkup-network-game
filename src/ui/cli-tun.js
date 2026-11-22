// IOS 的 show 指令：Tunnel 介面、DMVPN（NHRP）、IPsec profile 與 crypto session
import { fmtIp, fmtMask, parseIp, sameNet } from '../engine/ip.js';
import { bfdCfg, ospfBfd } from '../engine/ospf.js';
import { MODE_TEXT, isTun, nhrpCache, saInfo, tunMode, tunOverhead, ikeVer } from '../engine/sim.js';
import { longIf } from '../engine/ops.js';
import { validityError, pkiDate } from '../engine/pki.js';

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const hms = (s) => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
const ENC = { aes128: 'esp-aes', aes256: 'esp-256-aes' }, HASH = { sha1: 'esp-sha-hmac', sha256: 'esp-sha256-hmac' };

/** 名稱是 Tunnel 介面（tu0、Tunnel 0、tunnel0）：回傳介面 */
export function tunByName(d, text) {
  const m = String(text || '').toLowerCase().replace(/\s+/g, '').match(/^tu[a-z]*(\d+)$/);
  return m ? d.ifaces.find((i) => isTun(i) && i.bind.n === +m[1]) || null : undefined;
}

/** show interfaces Tunnel0 */
export function tunnelDetail(st, d, i) {
  const rt = i.rt.tun || {}, t = i.tun || {}, mode = tunMode(i);
  const srcIf = t.src && d.ifaces.find((x) => x.id === t.src);
  const head = i.shut ? `${i.label} is administratively down, line protocol is down` : `${i.label} is up, line protocol is ${i.rt.link ? 'up' : 'down'}`;
  const o = [head, '  Hardware is Tunnel'];
  if (i.desc) o.push(`  Description: ${i.desc}`);
  if (i.rt.ip != null) o.push(`  Internet address is ${fmtIp(i.rt.ip)}/${i.rt.bits}`);
  o.push(`  MTU ${(rt.mtu || 1476) + tunOverhead(i) + 16416} bytes, BW 100 Kbit/sec, DLY 50000 usec,`, '     reliability 255/255, txload 1/255, rxload 1/255', '  Encapsulation TUNNEL, loopback not set',
    t.ka ? `  Keepalive set (${t.ka.sec} sec), retries ${t.ka.retry}` : '  Keepalive not set',
    `  Tunnel linestate evaluation ${i.rt.link ? 'up' : 'down'}`);
  const srcTxt = rt.src != null ? `${fmtIp(rt.src)}${srcIf ? ` (${longIf(srcIf.label)})` : ''}` : t.src ? `UNKNOWN (${srcIf ? longIf(srcIf.label) : t.src})` : 'UNKNOWN';
  o.push(`  Tunnel source ${srcTxt}${mode === 'mgre' ? '' : `, destination ${t.dst || 'UNKNOWN'}`}`);
  o.push(`  Tunnel protocol/transport ${MODE_TEXT[mode]}`);
  if (mode !== 'ipsec' && mode !== 'ipv6ip') o.push(`    Key ${t.key != null ? `0x${(+t.key).toString(16).toUpperCase()}` : 'disabled'}, sequencing disabled`, '    Checksumming of packets disabled');
  o.push('  Tunnel TTL 255, Fast tunneling enabled', `  Tunnel transport MTU ${rt.mtu || 1476} bytes`, '  Tunnel transmit bandwidth 8000 (kbps)', '  Tunnel receive bandwidth 8000 (kbps)');
  if (t.prot) o.push(`  Tunnel protection via IPSec (profile "${t.prot}")`);
  if (+i.mtu > 0) o.push(`（ip mtu ${i.mtu}：Tunnel 送出的封包最大 ${i.mtu} 位元組）`);
  if (+i.adjMss > 0) o.push(`（ip tcp adjust-mss ${i.adjMss}：經過的 TCP SYN 的 MSS 改成不超過 ${i.adjMss}）`);
  if (!i.rt.link && !i.shut) o.push(`（line protocol down：${rt.why || '還沒有設定好'}）`);
  else if (rt.kaLeft) o.push(`（對面沒有回應 keepalive，再 ${rt.kaLeft} 秒 line protocol 就會 down）`);
  else if (i.rt.link && mode === 'gre' && !t.ka && rt.note) o.push(`（line protocol 是 up，但${rt.note}。沒有設定 keepalive 的 GRE 只要有路到 destination 就是 up，不管對面在不在）`);
  return o;
}

/** show dmvpn [detail] */
export function dmvpnLines(st, d) {
  const tuns = d.ifaces.filter((i) => isTun(i) && i.nhrp);
  if (!tuns.length) return ['（這台沒有啟用 NHRP 的 Tunnel 介面：ip nhrp network-id <n>）'];
  const o = ['Legend: Attrb --> S - Static, D - Dynamic, I - Incomplete', '        N - NATed, L - Local, X - No Socket', '        T1 - Route Installed, T2 - Nexthop-override',
    '        C - CTS Capable, I2 - Temporary', '        # Ent --> Number of NHRP entries with same NBMA peer', '        NHS Status: E --> Expecting Replies, R --> Responding, W --> Waiting',
    '        UpDn Time --> Up or Down Time for a Tunnel', '=========================================================================='];
  for (const i of tuns) {
    const rt = i.rt.tun || { peers: [], nhs: [] };
    const peers = rt.peers.filter((p) => p.ip != null);
    const hub = !(i.nhrp.nhs || []).length;
    o.push('', `Interface: ${i.label}, IPv4 NHRP Details `, `Type:${hub ? 'Hub' : 'Spoke'}, NHRP Peers:${peers.length},`, '', ' # Ent  Peer NBMA Addr Peer Tunnel Add State  UpDn Tm Attrb', ' ----- --------------- --------------- ----- -------- -----');
    for (const p of peers) {
      const T = i.tun.prot ? d.rt.tunnels.find((x) => x.tif === i.id && x.peerIp === p.nbma) : null;
      const state = !p.ok ? 'NHRP' : i.tun.prot && !(T && T.up) ? 'IKE' : 'UP';
      const res = p.kind === 'res' ? ((st.dyn.nhrpRes || {})[d.id + '/' + i.id] || {})[fmtIp(p.ip)] : null;
      const attr = p.kind === 'dyn' ? 'D' : p.kind === 'res' ? (res && (res.prefixes || []).length ? 'DT1' : 'D') : 'S';
      const up = p.since != null ? hms(st.clock - p.since) : '00:00:00';
      o.push(`${lpad(1, 6)} ${pad(fmtIp(p.nbma), 15)} ${lpad(fmtIp(p.ip), 15)} ${lpad(state, 5)} ${pad(up, 8)} ${lpad(attr, 5)}`);
    }
    for (const n of rt.nhs.filter((x) => !x.ok)) o.push(`（NHS ${n.ip} 沒有回應：${n.why}）`);
    if (!peers.length && hub) o.push('（還沒有任何 spoke 註冊上來）');
  }
  return o;
}

/** show ip nhrp [brief] */
export function nhrpLines(st, d, brief) {
  const tuns = d.ifaces.filter((i) => isTun(i) && i.nhrp);
  if (!tuns.length) return ['（這台沒有啟用 NHRP 的 Tunnel 介面）'];
  const o = [];
  if (brief) o.push('****************************************************************************', '    NOTE: Link-Local, No-socket and Incomplete entries are not displayed', '****************************************************************************', 'Legend: Type --> S - Static, D - Dynamic', '        Flags --> u - unique, r - registered, e - temporary, c - claimed', '        a - authoritative, t - route', '============================================================================', '', 'Intf     NextHop Address                                    NBMA Address', '         Target Network                              T/Flag', '-------- ------------------------------------------- ------ ----------------');
  for (const i of tuns) {
    for (const e of nhrpCache(st, d, i)) {
      const exp = e.expire != null ? hms(e.expire) : 'never expire';
      if (brief) { o.push(`${pad(i.label.replace('Tunnel', 'Tu'), 8)} ${pad(fmtIp(e.ip), 43)}${pad(fmtIp(e.nbma), 16)}`, `         ${pad(fmtIp(e.ip) + '/32', 43)} ${pad((e.type === 'dynamic' ? 'D' : 'S') + '/' + (e.kind === 'dyn' ? 'r' : ''), 6)}`); continue; }
      o.push(`${fmtIp(e.ip)}/32 via ${fmtIp(e.ip)}`, `   ${i.label} created ${e.created != null ? hms(e.created) : '00:00:00'}, ${e.expire != null ? `expire ${exp}` : 'never expire'} `, `   Type: ${e.type}, Flags: ${e.flags} `, `   NBMA address: ${fmtIp(e.nbma)} `);
      if (!e.ok) o.push('（這一筆對應存在，但 GRE 封包送不過去）');
    }
    // DMVPN phase 3 的捷徑：解析到的整個網段
    for (const [ip, r] of Object.entries((st.dyn.nhrpRes || {})[d.id + '/' + i.id] || {})) {
      if (r.exp <= st.clock) continue;
      for (const p of r.prefixes || []) {
        if (brief) { o.push(`${pad(i.label.replace('Tunnel', 'Tu'), 8)} ${pad(ip, 43)}${pad(fmtIp(r.nbma), 16)}`, `         ${pad(`${fmtIp(p.net)}/${p.bits}`, 43)} ${pad('D/r', 6)}`); continue; }
        o.push(`${fmtIp(p.net)}/${p.bits} via ${ip}`, `   ${i.label} created ${hms(st.clock - r.since)}, expire ${hms(r.exp - st.clock)}`, '   Type: dynamic, Flags: router rib nho ', `   NBMA address: ${fmtIp(r.nbma)} `);
      }
    }
  }
  return o.length ? o : ['（NHRP 快取是空的）'];
}

/** show ip nhrp nhs [detail] */
export function nhsLines(st, d) {
  const tuns = d.ifaces.filter((i) => isTun(i) && i.nhrp && (i.nhrp.nhs || []).length);
  if (!tuns.length) return ['（這台沒有設定 NHS：它是 hub，或還沒有 ip nhrp nhs）'];
  const o = ['Legend: E=Expecting replies, R=Responding, W=Waiting, D=Dynamic, x=unknown', '        O=Probe Ongoing, P=Primary, S=Secondary', ''];
  for (const i of tuns) {
    o.push(`${i.label}:`);
    for (const n of (i.rt.tun && i.rt.tun.nhs) || i.nhrp.nhs.map((x) => ({ ip: x.ip, nbma: null, ok: false, why: i.rt.tun ? i.rt.tun.why : '' }))) {
      o.push(`${pad(n.ip, 16)}${pad(n.ok ? 'RE' : 'E', 4)}NBMA Address: ${n.nbma != null ? fmtIp(n.nbma) : 'unknown'} priority = 0 cluster = 0`);
      if (!n.ok) o.push(`（沒有回應：${n.why || (i.rt.tun && i.rt.tun.why) || '還沒有註冊'}）`);
    }
  }
  return o;
}

/** show crypto ipsec profile */
export function ipsecProfileLines(st, d) {
  const ps = Object.entries(d.ipsecProfiles || {});
  if (!ps.length) return ['（沒有任何 IPsec profile：crypto ipsec profile <名稱>）'];
  const o = [];
  for (const [n, p] of ps) {
    const ts = (d.tsets || {})[p.tset];
    o.push(`IPSEC profile ${n}`, ...(p.ikev2 ? [`        IKEv2 Profile: ${p.ikev2}`] : []), `        Security association lifetime: 4608000 kilobytes/${+p.life2 || +d.ipsecLife || 3600} seconds`, '        Responder-Only (Y/N): N', `        PFS (Y/N): ${p.pfs ? 'Y' : 'N'}`, ...(p.pfs ? [`        DH group:  group${p.pfs}`] : []), '        Mixed-mode : Disabled', '        Transform sets={ ',
      ts ? `                ${p.tset}:  { ${ENC[ts.enc2]} ${HASH[ts.hash2]}  } , ` : '                default:  { esp-aes esp-sha-hmac  } , ', '        }', '');
    const users = d.ifaces.filter((i) => isTun(i) && i.tun && i.tun.prot === n).map((i) => i.label);
    if (users.length) o.push(`（使用中：${users.join('、')}）`, '');
  }
  return o;
}

/** show crypto ipsec transform-set */
export function transformSetLines(st, d) {
  const sets = Object.entries(d.tsets || {});
  if (!sets.length) return ['（沒有自己定義的 transform-set：crypto ipsec transform-set <名稱> esp-aes 256 esp-sha256-hmac）', '', 'Transform set #$!default_transform_set_1: { esp-aes esp-sha-hmac  }', '   will negotiate = { Transport,  },'];
  return sets.flatMap(([n, x]) => [`Transform set ${n}: { ${ENC[x.enc2]} ${HASH[x.hash2]}  }`, `   will negotiate = { ${x.mode === 'transport' ? 'Transport' : 'Tunnel'},  },`, '']);
}

/** show crypto session [detail] */
export function cryptoSessionLines(st, d) {
  const list = (d.rt.tunnels || []).filter((t) => t.cfg);
  if (!list.length) return ['Crypto session current status', '', '（沒有任何 IPsec 的設定）'];
  const o = ['Crypto session current status', ''];
  for (const t of list) {
    const sa = saInfo(st, d.id, t.name);
    const iface = t.tif ? d.ifaces.find((i) => i.id === t.tif) : d.ifaces.find((i) => i.rt && i.rt.ip === t.localIp);
    const status = sa ? 'UP-ACTIVE' : t.nego ? 'UP-NO-IKE' : 'DOWN';
    const v = ikeVer(d, t.cfg) === 2 ? 'IKEv2' : 'IKEv1';
    const port = t.natT ? 4500 : 500;
    const flow = t.vti ? 'permit ip 0.0.0.0/0.0.0.0 0.0.0.0/0.0.0.0' : t.proto === 'gre' || t.proto === 'ipv6ip' ? `permit ${t.proto === 'gre' ? 47 : 41} host ${fmtIp(t.localIp)} host ${fmtIp(t.peerIp)}` : t.local.map((l, k) => { const r = t.remote[k] || t.remote[0]; return `permit ip ${fmtIp(l.net)}/${fmtMask(l.bits)} ${r ? `${fmtIp(r.net)}/${fmtMask(r.bits)}` : '0.0.0.0/0.0.0.0'}`; }).join(' ');
    o.push(`Interface: ${iface ? longIf(iface.label) : '(none)'}`, `Session status: ${status}`, `Peer: ${t.peerIp != null ? fmtIp(t.peerIp) : '0.0.0.0'} port ${port} `);
    if (sa || t.nego) o.push(`  ${v} SA: local ${fmtIp(t.localIp)}/${port} remote ${fmtIp(t.peerIp)}/${port} ${sa ? 'Active' : 'Inactive'}`);
    o.push(`  IPSEC FLOW: ${flow} `, `        Active SAs: ${sa ? 2 : 0}, origin: ${t.prot ? 'crypto map' : 'crypto map'}`);
    if (!sa) o.push(`（${t.why || '還沒有建立'}）`);
    if (t.natInfo) o.push(`（中間有 NAT：對端看到的位址是 ${fmtIp(t.natInfo.seen)}${t.natT ? '，ESP 包在 UDP 4500 裡 (NAT-T)' : '，但沒有用 NAT-T'}）`);
    o.push('');
  }
  return o;
}

/** show bfd neighbors [details]：兩端都設了 bfd interval、又有 OSPF / BGP 用它的介面 */
export function bfdLines(st, d, detail) {
  const rows = [];
  for (const i of d.ifaces) {
    const me = bfdCfg(i);
    if (!me || !i.rt || i.rt.ip == null) continue;
    const clients = [];
    for (const n of d.rt.nbrs || []) if (n.iface === i.id && ospfBfd(d, i)) clients.push({ ip: n.ip, dev: n.dev, who: 'OSPF', up: n.state === 'full' });
    for (const p of ((d.rt.bgp || {}).peers || [])) {
      const nb = ((d.bgp || {}).neighbors || []).find((x) => x.ip === p.ip);
      if (nb && nb.bfd && p.state === 'Established' && sameNet(parseIp(p.ip), i.rt.ip, i.rt.bits)) clients.push({ ip: parseIp(p.ip), who: 'BGP', up: true });
    }
    for (const c of clients) {
      const od = c.dev && st.devices[c.dev], oi = od && od.ifaces.find((x) => x.rt && x.rt.ip === c.ip);
      const peerOk = c.who === 'BGP' || (oi && bfdCfg(oi) && ospfBfd(od, oi));
      rows.push({ i, c, ok: peerOk && c.up, peer: oi });
    }
  }
  if (!rows.length) return ['（沒有任何 BFD session：介面上要有 bfd interval，OSPF 用 ip ospf bfd 或 bfd all-interfaces、BGP 用 neighbor … fall-over bfd，兩端都要設）'];
  const o = ['', 'IPv4 Sessions', 'NeighAddr                              LD/RD         RH/RS     State     Int'];
  rows.forEach((r, k) => {
    o.push(`${fmtIp(r.c.ip).padEnd(39)}${String(`${k + 1}/${r.ok ? k + 1 : 0}`).padEnd(14)}${(r.ok ? 'Up' : 'Down').padEnd(10)}${(r.ok ? 'Up' : 'Down').padEnd(10)}${longIf(r.i.label)}`);
    if (detail) {
      const me = bfdCfg(r.i), them = r.peer && bfdCfg(r.peer);
      o.push(`Session state is ${r.ok ? 'UP' : 'DOWN'} and not using echo function.`, `OurAddr: ${fmtIp(r.i.rt.ip)}`, `Local Diag: 0, Demand mode: 0, Poll bit: 0`,
        `MinTxInt: ${me.tx * 1000}, MinRxInt: ${me.rx * 1000}, Multiplier: ${me.mult}`, ...(them ? [`Received MinRxInt: ${them.rx * 1000}, Received Multiplier: ${them.mult}`, `Holddown (hits): 0(0), Hello (hits): ${Math.max(me.tx, them.rx)}(0)`] : []),
        `Registered protocols: ${r.c.who}`, '');
    }
    if (!r.ok) o.push(`（${r.peer && !bfdCfg(r.peer) ? `對面的 ${r.peer.label} 沒有 bfd interval` : r.c.who === 'OSPF' && r.peer && !ospfBfd(st.devices[r.c.dev], r.peer) ? '對面的 OSPF 沒有用 BFD' : '鄰居還沒建立'}）`);
  });
  return o;
}

// ── PKI ──
const certState = (st, d, c) => { const v = validityError(st, d, c); return v ? (v.code === 'NOT_YET_VALID' ? 'Not yet valid' : 'Expired') : 'Available'; };
function certBlock(st, d, name, c, ca) {
  return [ca ? 'CA Certificate' : 'Certificate', `  Status: ${certState(st, d, c)}`, `  Certificate Serial Number (hex): ${c.serial}`, `  Certificate Usage: ${ca ? 'Signature' : 'General Purpose'}`,
    '  Issuer:', `    cn=${c.issuer}`, '  Subject:', ...(ca ? [`    cn=${c.cn}`] : [`    Name: ${c.cn}`, `    cn=${c.cn}`]), '  Validity Date:', `    start date: ${pkiDate(c.from)}`, `    end   date: ${pkiDate(c.to)}`, `  Associated Trustpoints: ${name}`, ''];
}
/** show crypto pki certificates [trustpoint]：自己的憑證與 CA 的根憑證，狀態用這台設備自己的時鐘判斷 */
export function pkiCertLines(st, d, only) {
  const o = [];
  for (const [n, tp] of Object.entries((d.pki && d.pki.tps) || {})) {
    if (only && n.toLowerCase() !== only.toLowerCase()) continue;
    if (tp.cert) o.push(...certBlock(st, d, n, tp.cert, false));
    if (tp.ca) o.push(...certBlock(st, d, n, tp.ca, true));
  }
  if (!o.length) o.push('（沒有任何憑證：先 crypto pki authenticate <trustpoint> 取得 CA 的根憑證，再 crypto pki enroll <trustpoint> 申請自己的憑證）');
  return o;
}
/** show crypto pki trustpoints [status] */
export function pkiTrustpointLines(st, d, status) {
  const tps = Object.entries((d.pki && d.pki.tps) || {});
  if (!tps.length) return ['（沒有設定任何 trustpoint：crypto pki trustpoint <名稱>）'];
  const o = [];
  for (const [n, tp] of tps) {
    if (!status) { o.push(`Trustpoint ${n}:`, ...(tp.ca ? ['    Subject Name: ', `    cn=${tp.ca.cn}`, `          Serial Number (hex): ${tp.ca.serial}`, '    Certificate configured.'] : ['    Not authenticated.']), ...(tp.url ? [`    SCEP URL: ${tp.url}`] : []), ''); continue; }
    o.push(`Trustpoint ${n}:`, '  Issuing CA certificate configured:', ...(tp.ca ? [`    Subject Name:`, `     cn=${tp.ca.cn}`, `    Fingerprint MD5: (略)`] : ['    (none)']),
      '  Router General Purpose certificate configured:', ...(tp.cert ? [`    Subject Name:`, `     cn=${tp.cert.cn}`] : ['    (none)']), '  State:', `    Keys generated ............. ${tp.key || tp.cert ? 'Yes (General Purpose, non-exportable)' : 'No'}`,
      `    Issuing CA authenticated ....... ${tp.ca ? 'Yes' : 'No'}`, `    Certificate request(s) ..... ${tp.cert ? 'None' : 'Pending'}`, ...(tp.ca ? [`    Revocation check ........... ${tp.revoke || 'crl'}`] : []), '');
  }
  return o;
}
