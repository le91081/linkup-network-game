// IPv6 模擬：link-local、手動位址、SLAAC 與 DHCPv6（依 Router Advertisement 的 M / O / A 旗標）、
// 靜態路由與 OSPFv3、等價多路徑、鄰居探索 (NDP)、IPv6 ACL（ipv6 traffic-filter，含隱含的 ND 允許規則）、ICMPv6 / TCP / UDP。
// 只在關卡開啟 state.v6 時才會執行。
//
// 設定：
//   路由器介面：i.ip6、i.ll6（手動指定的 link-local）、i.ra（送 RA）、i.raM / i.raO（RA 的 M / O 旗標）、
//     i.raNoAuto（前綴的 A 旗標關掉：ipv6 nd prefix default no-autoconfig）、i.dhcp6（ipv6 dhcp server <位址池>）、
//     i.relay6（ipv6 dhcp relay destination <位址>）、i.acl6In / i.acl6Out（ipv6 traffic-filter <名稱> in | out）
//   設備：d.routes6 = [{ dst, via, ad }]、d.dhcp6Pools = { 名稱: { prefix, dns: [位址], domain } }、
//     d.acl6 = { 名稱: [{ seq, action, proto, src, dst, sport, port, icmp }] }（src / dst：'any'、'host <位址>'、'<前綴>/<長度>'）
// 執行期：i.rt.v6 = { ll, addrs: [{ ip, bits, src: 'static' | 'slaac' | 'dhcp6' }], gw, note, router, dns, domain, ra, dhcp }
//   d.rt.routes6、state.dyn.lease6（DHCPv6 的 binding）、state.dyn.rtSince6（OSPFv3 路由的存在時間）
import { parseIp6, fmtIp6, parseCidr6, net6, linkLocal, eui64, isLinkLocal } from './ip6.js';
import { l2Explore } from './sim.js';
import { computeOspf6 } from './ospf.js';
import { raBlocked } from './l2sec.js';
import { forward, isTun, tunMode, GRE_OVERHEAD, svcMatch } from './sim.js';
import { fmtIp } from './ip.js';
import { zoneHas } from './sdwan.js';

export const mode6 = (dev, i) => i.mode6 || (dev.kind === 'host' ? 'auto' : 'static');
const owns6 = (i, ip) => !!i.rt.v6 && (i.rt.v6.ll === ip || i.rt.v6.addrs.some((a) => a.ip === ip));
/** 網際網路上的主機（inet.hosts 的 ip6） */
const inetHost6 = (dev, ip) => (dev.kind === 'internet' ? (dev.inet.hosts || []).find((h) => h.ip6 && parseIp6(h.ip6) === ip) : null);
const isLocal6 = (dev, ip) => dev.ifaces.some((i) => owns6(i, ip)) || !!inetHost6(dev, ip);

/** DHCPv6 address prefix 的預設壽命：preferred 1 天、valid 2 天（IOS 的預設值） */
export const DHCP6_PREF = 86400, DHCP6_VALID = 172800;
const ALL_DHCP = parseIp6('ff02::1:2'); // All_DHCP_Relay_Agents_and_Servers

// ───────────────────────── 小工具 ─────────────────────────

/** 字串雜湊（FNV-1a），用來產生 DUID、DHCPv6 位址、等價多路徑的選擇 */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let n = 0; n < s.length; n++) { h ^= s.charCodeAt(n); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
/** Windows 的 DUID-LLT：類型 1、硬體類型 1（乙太網路）、建立的時間、MAC */
export function duidOf(i) {
  const mac = (i.rt && i.rt.mac) || '00:00:00:00:00:00';
  const t = (0x2a000000 + (fnv(mac) % 0x01000000)) >>> 0;
  return ['00', '01', '00', '01', hex2(t >>> 24), hex2((t >>> 16) & 255), hex2((t >>> 8) & 255), hex2(t & 255), ...mac.split(':').map((x) => x.toUpperCase())].join('-');
}
/** Windows 的 IAID（每張網路卡一個 32 位元的識別碼） */
export const iaidOf = (i) => 100000000 + (fnv('iaid:' + ((i.rt && i.rt.mac) || '')) % 900000000);
/** 被請求節點的多點傳送位址 ff02::1:ffXX:XXXX（Neighbor Solicitation 的目的位址） */
const solicited = (ip) => parseIp6('ff02::1:ff00:0') | (ip & 0xffffffn);

// ───────────────────────── IPv6 ACL ─────────────────────────

const HITS6 = new WeakMap();
/** 某條 IPv6 ACL 規則被命中的次數 */
export const hits6Of = (rule) => HITS6.get(rule) || 0;
/** IOS 的 IPv6 ACL 結尾有三條看不見的規則：允許鄰居探索，然後全部拒絕 */
export const ACL6_IMPLICIT = [
  { action: 'permit', proto: 'icmp', src: 'any', dst: 'any', icmp: 'nd-na', implicit: true },
  { action: 'permit', proto: 'icmp', src: 'any', dst: 'any', icmp: 'nd-ns', implicit: true },
  { action: 'deny', proto: 'ipv6', src: 'any', dst: 'any', implicit: true },
];
export const ICMP6_TYPES = ['echo-request', 'echo-reply', 'nd-ns', 'nd-na', 'router-solicitation', 'router-advertisement', 'packet-too-big', 'unreachable'];
function addr6Match(spec, ip) {
  const s = String(spec || 'any').trim().toLowerCase();
  if (s === 'any') return true;
  if (s.startsWith('host ')) return parseIp6(s.slice(5)) === ip;
  const c = parseCidr6(s);
  return !!c && net6(ip, c.bits) === net6(c.ip, c.bits);
}
function acl6Match(r, pkt) {
  if (r.proto && r.proto !== 'ipv6' && r.proto !== pkt.proto) return false;
  if (!addr6Match(r.src, pkt.src) || !addr6Match(r.dst, pkt.dst)) return false;
  const l4 = pkt.proto === 'tcp' || pkt.proto === 'udp';
  if (r.port && (!l4 || +r.port !== pkt.dport)) return false;
  if (r.sport && (!l4 || +r.sport !== pkt.sport)) return false;
  if (r.icmp && (pkt.proto !== 'icmp' || pkt.icmp !== r.icmp)) return false;
  return true;
}
export const acl6Line = (r) => `${r.action} ${r.proto || 'ipv6'} ${r.src}${r.sport ? ' eq ' + r.sport : ''} ${r.dst}${r.port ? ' eq ' + r.port : ''}${r.icmp ? ' ' + r.icmp : ''}`;
/** 依序比對；回傳 null 代表放行，不然是 { rule, text }。套用了不存在的 ACL：IOS 當作全部放行 */
export function acl6Check(d, name, pkt, quiet) {
  const list = (d.acl6 || {})[name];
  if (!list) return null;
  for (const r of [...list.slice().sort((a, b) => a.seq - b.seq), ...ACL6_IMPLICIT]) {
    if (!acl6Match(r, pkt)) continue;
    if (!quiet && !r.implicit) HITS6.set(r, (HITS6.get(r) || 0) + 1);
    if (r.action === 'permit') return null;
    return { rule: r, text: r.implicit ? '沒有任何規則符合，最後隱含的 deny ipv6 any any' : `sequence ${r.seq}「${acl6Line(r)}」` };
  }
  return null;
}

// ───────────────────────── 位址與路由表 ─────────────────────────

/**
 * RA 沿著 path 反方向走回來（從送 RA 的那一台到收的人）：路上有交換器在 RA 進來的那個埠掛了 RA Guard 的 host 政策，就被丟掉
 */
function raGuarded(state, path) {
  for (const h of path) {
    const sw = state.devices[h.from];
    if (sw && sw.sw && h.fromPort && raBlocked(sw, h.fromPort)) return sw.name + ' 的 ' + h.fromPort;
  }
  return null;
}
/**
 * 這個介面收到的 RA：合法的路由器送的，加上冒牌的（主機上的 i.rogueRa，例如私接的家用路由器、攻擊工具）。
 * 主機會用每一個 RA 的前綴各產生一個 SLAAC 位址，預設閘道選 Router Preference 最高的（冒牌的通常設成 high）
 */
function raOf(state, d, i) {
  const cands = [];
  for (const e of l2Explore(state, d.id, i)) {
    const r = e.iface, rd = state.devices[e.dev];
    const guard = raGuarded(state, e.path);
    if (rd.routing && (rd.v6routing || rd.kind === 'internet' || rd.kind === 'firewall') && r.ra && r.rt.v6 && r.rt.v6.addrs.length) {
      const pfx = r.rt.v6.addrs.find((a) => a.bits === 64) || r.rt.v6.addrs[0];
      cands.push({ dev: rd.id, iface: r, M: !!r.raM, O: !!r.raO, A: !r.raNoAuto, prefix: net6(pfx.ip, pfx.bits), bits: pfx.bits, ll: r.rt.v6.ll, prio: 'medium', guard });
    } else if (r.rogueRa && r.rt.v6 && r.rt.v6.ll != null) {
      const c = parseCidr6(r.rogueRa.prefix || '');
      if (c) cands.push({ dev: rd.id, iface: r, M: false, O: false, A: true, prefix: net6(c.ip, c.bits), bits: c.bits, ll: r.rt.v6.ll, prio: r.rogueRa.prio || 'high', rogue: true, guard });
    }
  }
  const ok = cands.filter((c) => !c.guard);
  if (!ok.length) return null;
  const rank = { high: 0, medium: 1, low: 2 };
  const best = ok.slice().sort((a, b) => rank[a.prio] - rank[b.prio])[0];
  return { ...best, all: ok, blocked: cands.filter((c) => c.guard) };
}

export function recompute6(state) {
  const devs = Object.values(state.devices);
  // 1. 介面：link-local、手動位址
  for (const d of devs) {
    d.rt.routes6 = [];
    d.rt.gp = {}; // DHCPv6 PD 拿到的一般前綴 (general prefix)
    for (const i of d.ifaces) {
      const v = (i.rt.v6 = { ll: null, addrs: [], gw: null, note: '', router: null, dns: [], domain: '', ra: null, dhcp: null });
      if (d.kind === 'internet') {
        const c = i.line && i.line.v6 && parseCidr6(i.line.v6.link || '');
        if (c && i.rt.link) { v.ll = linkLocal(i.rt.mac); v.addrs.push({ ip: net6(c.ip, c.bits) | 1n, bits: c.bits, src: 'static' }); }
        continue;
      }
      const m = mode6(d, i);
      if (!i.rt.active || !i.rt.link || m === 'off') continue;
      const ll = parseIp6(i.ll6 || '');
      v.ll = ll != null && isLinkLocal(ll) ? ll : linkLocal(i.rt.mac);
      if (m !== 'static') continue;
      const c = parseCidr6(i.ip6 || '');
      if (c && isLinkLocal(c.ip)) v.note = 'fe80:: 開頭的是 link-local 位址，不能當成全域位址；要手動指定 link-local 請用 ipv6 address fe80::1 link-local';
      else if (c && c.bits < 128) v.addrs.push({ ip: c.ip, bits: c.bits, src: 'static' });
      else if (c && c.bits === 128 && i.bind.t === 'loop') v.addrs.push({ ip: c.ip, bits: 128, src: 'static' });
      else if ((i.ip6 || '').trim()) v.note = 'IPv6 位址要寫成「位址/前綴長度」，例如 2001:db8:a::1/64';
      v.gw = parseIp6(i.gw6 || '');
    }
  }
  // 2. 自動取得：RA 的 A 旗標 → SLAAC；預設閘道永遠來自 RA（DHCPv6 不提供閘道）
  //    路由器的 WAN（ipv6 address autoconfig）先做；接著 DHCPv6 PD 與一般前綴的位址；主機最後做
  const autoconf = (hosts) => {
  for (const d of devs) {
    if ((d.kind === 'host') !== hosts) continue;
    for (const i of d.ifaces) {
      const v = i.rt.v6;
      if (mode6(d, i) !== 'auto' || v.ll == null) continue;
      const ra = raOf(state, d, i);
      if (!ra) { v.note = '沒有收到 Router Advertisement — 路由器要啟用 IPv6 路由，並在這個網段的介面上開啟 RA'; continue; }
      v.ra = { dev: ra.dev, M: ra.M, O: ra.O, A: ra.A, prefix: ra.prefix, bits: ra.bits, rogue: !!ra.rogue, prio: ra.prio };
      // 每一個收到的 RA 都產生一個 SLAAC 位址（同一張網卡同時有合法與冒牌的前綴）
      for (const x of ra.all) if (x.A && x.bits === 64 && !v.addrs.some((a) => net6(a.ip, 64) === x.prefix)) v.addrs.push({ ip: eui64(x.prefix, i.rt.mac), bits: 64, src: 'slaac', ...(x.rogue ? { rogue: true } : {}) });
      // 路由器要寫 ipv6 address autoconfig default 才會把 RA 的路由器當成預設路由
      v.gw = hosts || i.v6default ? ra.ll : null;
      v.router = ra.dev;
      v.routers = ra.all.map((x) => ({ dev: x.dev, ll: fmtIp6(x.ll), prio: x.prio, rogue: !!x.rogue }));
      if (ra.blocked.length) v.raBlocked = ra.blocked.map((x) => ({ dev: x.dev, where: x.guard }));
    }
  }
  };
  autoconf(false);
  // DHCPv6 Prefix Delegation：WAN 介面向 ISP 要一整段前綴（例如 /56），存成一般前綴；LAN 介面再從裡面切出 /64
  const pdRoutes = [];
  for (const d of devs) {
    if (d.kind === 'host' || d.kind === 'internet') continue;
    for (const i of d.ifaces) {
      if (!i.pd6 || !i.rt.v6 || i.rt.v6.ll == null) continue;
      const isp = l2Explore(state, d.id, i).find((e) => state.devices[e.dev].kind === 'internet' && e.iface.line && e.iface.line.v6 && e.iface.line.v6.pd);
      if (!isp) { d.rt.gp[i.pd6] = { why: `${i.label} 送出 DHCPv6 Solicit（要求前綴委派），但這條鏈路上沒有提供 PD 的 ISP` }; continue; }
      const c = parseCidr6(isp.iface.line.v6.pd);
      d.rt.gp[i.pd6] = { prefix: net6(c.ip, c.bits), bits: c.bits, iface: i.id, isp: isp.dev, dns: isp.iface.line.v6.dns || [] };
      pdRoutes.push({ inet: state.devices[isp.dev], iface: isp.iface, net: net6(c.ip, c.bits), bits: c.bits, via: i.rt.v6.ll });
    }
  }
  // 用一般前綴寫的位址：ipv6 address HOME ::1:0:0:0:1/64 → 前綴 + 後面這一段
  for (const d of devs) {
    for (const i of d.ifaces) {
      const g = i.gp6, v = i.rt.v6;
      if (!g || !v || v.ll == null) continue;
      const p = d.rt.gp[g.name], sfx = parseCidr6(g.suffix || '');
      if (!sfx) { v.note = `ipv6 address ${g.name} 後面的位址寫錯了（例如 ::1:0:0:0:1/64）`; continue; }
      if (!p || p.prefix == null) { v.note = `一般前綴 ${g.name} 還沒有拿到${p && p.why ? '：' + p.why : '（WAN 介面要有 ipv6 dhcp client pd ' + g.name + '）'}`; continue; }
      v.addrs.push({ ip: p.prefix | (sfx.ip & ((1n << BigInt(128 - p.bits)) - 1n)), bits: sfx.bits, src: 'static', gp: g.name });
    }
  }
  autoconf(true);
  // 3. 直連與靜態路由（DHCPv6 的轉送要用到路由表，所以先算）
  const build = () => {
    for (const d of devs) {
      const r = (d.rt.routes6 = []);
      for (const i of d.ifaces) {
        const v = i.rt.v6;
        for (const a of v.addrs) if (a.src !== 'dhcp6') r.push({ net: net6(a.ip, a.bits), bits: a.bits, via: null, iface: i, type: 'C', ad: 0, metric: 0 });
        // RA 公告的前綴是「在這條鏈路上」(on-link)：A 旗標關掉、只有 DHCPv6 的 /128 位址時，同網段照樣直接送
        if (v.ra && !r.some((x) => x.type === 'C' && x.iface === i && x.net === v.ra.prefix && x.bits === v.ra.bits)) r.push({ net: v.ra.prefix, bits: v.ra.bits, via: null, iface: i, type: 'C', ad: 0, metric: 0, onlink: true });
        if (v.gw != null && v.ll != null) r.push({ net: 0n, bits: 0, via: v.gw, iface: i, type: 'S', ad: 1, metric: 0, nd: v.ra != null });
      }
      for (const s of d.routes6 || []) {
        const c = parseCidr6(s.dst || ''), via = parseIp6(s.via || '');
        if (!c || via == null) continue;
        // 下一站可以是同網段的全域位址，也可以是 link-local（要指定出口介面，這裡用「哪個介面的鏈路上有它」來判斷）
        const i = d.ifaces.find((x) => x.rt.v6 && (isLinkLocal(via) ? l2Explore(state, d.id, x).some((e) => e.iface.rt.v6 && e.iface.rt.v6.ll === via)
          : x.rt.v6.addrs.some((a) => net6(via, a.bits) === net6(a.ip, a.bits) && via !== a.ip)));
        r.push({ net: net6(c.ip, c.bits), bits: c.bits, via, iface: i || null, type: 'S', ad: Math.max(1, +s.ad || 1), metric: 0, bad: i ? null : `下一站 ${fmtIp6(via)} 不在任何直連的 IPv6 網段上` });
      }
    }
  };
  build();
  for (const x of pdRoutes) x.inet.rt.routes6.push({ net: x.net, bits: x.bits, via: x.via, iface: x.iface, type: 'S', ad: 1, metric: 0, pd: true });
  // 4. OSPFv3
  computeOspf6(state);
  // 5. DHCPv6：M 旗標 → 向 DHCPv6 要位址 (stateful)；只有 O 旗標 → 只要 DNS 這些「其他設定」(stateless)
  const leases = (state.dyn.lease6 ||= {});
  for (const d of devs) {
    for (const i of d.ifaces) {
      const v = i.rt.v6;
      // Windows 收不到任何 RA 時，還是會自己試 stateful DHCPv6：可能拿到位址，但不會有預設閘道
      const noRa = !v.ra && mode6(d, i) === 'auto' && v.ll != null && d.kind === 'host';
      if (!noRa && (!v.ra || !(v.ra.M || v.ra.O))) continue;
      const f = dhcp6Find(state, d, i);
      if (noRa && (!f || f.why)) continue;
      const stateful = noRa || v.ra.M;
      if (!f || f.why) {
        v.dhcp = { stateful, ok: false, why: f ? f.why : `RA 的 ${stateful ? 'M' : 'O'} 旗標要求使用 DHCPv6，但這個網段上沒有 DHCPv6 伺服器，也沒有設定轉送 (ipv6 dhcp relay)` };
        if (stateful && !v.addrs.length) v.note = '沒有全域位址：' + v.dhcp.why;
        continue;
      }
      const pool = f.pool;
      v.dns = (pool.dns || []).map(parseIp6).filter((x) => x != null);
      v.domain = pool.domain || '';
      v.dhcp = { stateful, ok: true, server: f.server.id, pool: f.name, relay: f.relay ? f.relay.id : null };
      if (!stateful) continue;
      const pc = parseCidr6(pool.prefix || '');
      const link = f.link.rt.v6.addrs.find((a) => pc && net6(a.ip, pc.bits) === net6(pc.ip, pc.bits));
      if (!pc) { v.dhcp.ok = false; v.dhcp.why = `位址池「${f.name}」沒有 address prefix，只能提供 DNS 這類資訊 (stateless)，發不出位址`; continue; }
      if (!link) { v.dhcp.ok = false; v.dhcp.why = `位址池「${f.name}」的前綴 ${fmtIp6(net6(pc.ip, pc.bits))}/${pc.bits} 和這個網段（${f.link.rt.v6.addrs.map((a) => fmtIp6(net6(a.ip, a.bits)) + '/' + a.bits).join('、') || '沒有全域位址'}）不符`; continue; }
      const duid = duidOf(i);
      const host = BigInt(fnv(duid + '|' + f.name)) << 32n | BigInt(fnv(f.name + '|' + duid));
      const ip = net6(pc.ip, pc.bits) | (host & ((1n << BigInt(128 - pc.bits)) - 1n));
      v.addrs.push({ ip, bits: 128, src: 'dhcp6' });
      if (noRa) v.note = '沒有收到 Router Advertisement：位址是 DHCPv6 給的，但 DHCPv6 不提供預設閘道（閘道只能從 RA 學到），所以出不了這個網段';
      const tbl = (leases[f.server.id] ||= {});
      const old = tbl[duid];
      tbl[duid] = { addr: fmtIp6(ip), pool: f.name, iaid: iaidOf(i), client: fmtIp6(v.ll), iface: f.relay ? null : f.siface.label, since: old && old.addr === fmtIp6(ip) ? old.since : state.clock };
    }
  }
  // 6. OSPFv3 路由的存在時間
  const since = (state.dyn.rtSince6 ||= {});
  for (const d of devs) {
    const old = since[d.id] || {}, now = {};
    for (const r of d.rt.routes6) {
      if (r.type !== 'O') continue;
      const k = r.net + '/' + r.bits + '|' + r.via;
      r.since = now[k] = old[k] ?? state.clock;
    }
    if (Object.keys(now).length) since[d.id] = now; else delete since[d.id];
  }
}

/** 用戶端的鏈路上誰會回應 DHCPv6（送到 ff02::1:2）：自己當伺服器的路由器介面，或轉送 (relay) 給別台 */
function dhcp6Find(state, client, ci) {
  for (const e of l2Explore(state, client.id, ci)) {
    const rd = state.devices[e.dev], ri = e.iface;
    if (!rd.routing || !rd.v6routing || !ri.rt.v6 || ri.rt.v6.ll == null || !(ri.dhcp6 || ri.relay6)) continue;
    // 進方向的 IPv6 ACL 也會看到 DHCPv6（UDP 546 → 547）
    if (ri.acl6In) {
      const x = acl6Check(rd, ri.acl6In, { proto: 'udp', src: ci.rt.v6.ll, dst: ALL_DHCP, sport: 546, dport: 547 }, true);
      if (x) return { why: `${rd.name} 的 ${ri.label} 進方向的 IPv6 ACL「${ri.acl6In}」擋掉了 DHCPv6（UDP 547）：${x.text}` };
    }
    if (ri.dhcp6) {
      const pool = (rd.dhcp6Pools || {})[ri.dhcp6];
      if (!pool) return { why: `${rd.name} 的 ${ri.label} 指定的 DHCPv6 位址池「${ri.dhcp6}」不存在` };
      return { server: rd, siface: ri, pool, name: ri.dhcp6, link: ri, relay: null };
    }
    const dst = parseIp6(ri.relay6);
    if (dst == null) return { why: `${rd.name} 的 ${ri.label}：DHCPv6 轉送的目的位址「${ri.relay6}」格式不正確` };
    // Relay-Forward 是一般的 UDP 547 單播，要真的走得到伺服器
    const r = transact6(state, rd.id, dst, { proto: 'udp', dport: 547, sport: 547, quiet: true });
    if (!r.ok) return { why: `${rd.name} 把 DHCPv6 轉送到 ${fmtIp6(dst)}，但送不到：${r.reason}` };
    const sd = state.devices[r.responder], si = r.rxIf;
    if (!si || !si.dhcp6) return { why: `${sd.name} 收到轉送過來的 DHCPv6，但收到的介面${si ? ' ' + si.label : ''}沒有設定 ipv6 dhcp server` };
    const pool = (sd.dhcp6Pools || {})[si.dhcp6];
    if (!pool) return { why: `${sd.name} 的 ${si.label} 指定的 DHCPv6 位址池「${si.dhcp6}」不存在` };
    return { server: sd, siface: si, pool, name: si.dhcp6, link: ri, relay: rd };
  }
  return null;
}

/** DHCPv6 的四個訊息（stateful）或兩個訊息（stateless），給 ipconfig /renew6 與任務測試的紀錄用 */
export function dhcp6Trace(state, devId) {
  const d = state.devices[devId], log = [];
  const i = d.ifaces.find((x) => x.rt.v6 && x.rt.v6.ra && (x.rt.v6.ra.M || x.rt.v6.ra.O));
  if (!i) {
    const ra = d.ifaces.find((x) => x.rt.v6 && x.rt.v6.ra);
    const why = ra ? 'RA 的 M、O 旗標都沒有設：這個網段只用 SLAAC，不使用 DHCPv6' : '沒有收到 Router Advertisement，不知道要不要用 DHCPv6';
    log.push({ dev: d.id, kind: 'drop', text: why });
    return { ok: false, reason: why, log, hops: [] };
  }
  const v = i.rt.v6, sv = v.dhcp && v.dhcp.server ? state.devices[v.dhcp.server] : null;
  const relay = v.dhcp && v.dhcp.relay ? state.devices[v.dhcp.relay] : null;
  const via = relay ? `（經由 ${relay.name} 轉送）` : '';
  if (v.ra.M) {
    log.push({ dev: d.id, kind: 'tx', text: `Solicit：${fmtIp6(v.ll)} → ff02::1:2（找 DHCPv6 伺服器，DUID ${duidOf(i)}）` });
    if (!v.dhcp || !sv) { log.push({ dev: d.id, kind: 'drop', text: v.dhcp ? v.dhcp.why : '沒有回應' }); return { ok: false, reason: v.dhcp ? v.dhcp.why : '沒有回應', log, hops: [] }; }
    log.push({ dev: sv.id, kind: 'rx', text: `Advertise${via}：${sv.name} 的位址池「${v.dhcp.pool}」` });
    if (!v.dhcp.ok) { log.push({ dev: sv.id, kind: 'drop', text: v.dhcp.why }); return { ok: false, reason: v.dhcp.why, log, hops: [] }; }
    const a = v.addrs.find((x) => x.src === 'dhcp6');
    log.push({ dev: d.id, kind: 'tx', text: `Request：要 ${fmtIp6(a.ip)}` });
    log.push({ dev: sv.id, kind: 'ok', text: `Reply${via}：${fmtIp6(a.ip)}/128，DNS ${v.dns.map(fmtIp6).join('、') || '（沒有）'}。預設閘道不是 DHCPv6 給的，來自 RA：${fmtIp6(v.gw)}` });
  } else {
    log.push({ dev: d.id, kind: 'tx', text: `Information-Request：${fmtIp6(v.ll)} → ff02::1:2（位址用 SLAAC，只要 DNS 這些設定）` });
    if (!v.dhcp || !v.dhcp.ok || !sv) { const why = v.dhcp ? v.dhcp.why : '沒有回應'; log.push({ dev: d.id, kind: 'drop', text: why }); return { ok: false, reason: why, log, hops: [] }; }
    log.push({ dev: sv.id, kind: 'ok', text: `Reply${via}：DNS ${v.dns.map(fmtIp6).join('、') || '（位址池沒有設定 dns-server）'}${v.domain ? '，網域 ' + v.domain : ''}` });
  }
  return { ok: true, reason: '', log, hops: [] };
}

/** DHCPv6 伺服器的 binding（show ipv6 dhcp binding） */
export const dhcp6Bindings = (state, devId) => Object.entries((state.dyn.lease6 || {})[devId] || {}).map(([duid, b]) => ({ duid, ...b }));

// ───────────────────────── 轉送 ─────────────────────────

/** 最長相符，再比管理距離與 metric；等價的路依來源與目的位址雜湊（和 IPv4 的 CEF 一樣） */
export function lookup6(d, ip, src) {
  let best = null;
  const ties = [];
  for (const r of d.rt.routes6 || []) {
    if (r.bad || net6(ip, r.bits) !== r.net) continue;
    if (!best || r.bits > best.bits || (r.bits === best.bits && (r.ad < best.ad || (r.ad === best.ad && r.metric < best.metric)))) { best = r; ties.length = 0; ties.push(r); }
    else if (r.bits === best.bits && r.ad === best.ad && r.metric === best.metric && r.via !== best.via) ties.push(r);
  }
  if (ties.length > 1 && src != null) return ties[fnv(src.toString(16) + '>' + ip.toString(16)) % ties.length];
  return best;
}

/** 鄰居探索本身也要通過 ACL：對方進方向的 ACL 要讓 NS 進來，自己進方向的 ACL 要讓 NA 回來 */
function ndBlocked(state, dev, ifc, tgt) {
  const td = state.devices[tgt.dev];
  const myAddr = ifc.rt.v6.ll, nh = tgt.iface.rt.v6.ll;
  const tell = (d, i, name, what, x) => `鄰居探索 (NDP) 失敗：${d.name} 的 ${i.label} 進方向的 IPv6 ACL「${name}」擋掉了 ${what}（${x.text}）。`
    + 'IPv6 ACL 結尾隱含的 permit icmp any any nd-ns / nd-na 排在隱含的 deny 之前；自己在最後寫了 deny ipv6 any any，就要在它前面明確允許 nd-ns 與 nd-na';
  if (td.routing && tgt.iface.acl6In) {
    const x = acl6Check(td, tgt.iface.acl6In, { proto: 'icmp', icmp: 'nd-ns', src: myAddr, dst: solicited(nh) }, true);
    if (x) return tell(td, tgt.iface, tgt.iface.acl6In, 'Neighbor Solicitation', x);
  }
  if (dev.routing && ifc.acl6In) {
    const x = acl6Check(dev, ifc.acl6In, { proto: 'icmp', icmp: 'nd-na', src: nh, dst: myAddr }, true);
    if (x) return tell(dev, ifc, ifc.acl6In, 'Neighbor Advertisement', x);
  }
  return '';
}

/** 封包到了目的地：有沒有服務在聽 */
function deliver6(dev, pkt) {
  if (pkt.reply || pkt.proto === 'icmp') return '';
  const h = inetHost6(dev, pkt.dst);
  if (h) return (h.services || []).some((s) => s.proto === pkt.proto && s.port === pkt.dport) ? '' : `${h.name} 沒有在 ${pkt.proto.toUpperCase()}/${pkt.dport} 提供服務（連線被拒絕）`;
  if (pkt.proto === 'udp' && pkt.dport === 547 && dev.ifaces.some((i) => i.dhcp6)) return '';
  if (pkt.proto === 'tcp' && pkt.dport === 5201 && dev.kind === 'host') return '';
  if ((dev.services || []).some((s) => s.proto === pkt.proto && s.port === pkt.dport)) return '';
  if (pkt.proto === 'tcp' && dev.mgmt && ((pkt.dport === 22 && dev.mgmt.ssh) || (pkt.dport === 23 && dev.mgmt.telnet))) return '';
  return `${dev.name} 沒有在 ${pkt.proto.toUpperCase()}/${pkt.dport} 提供服務（連線被拒絕）`;
}

const desc6 = (p) => (p.proto === 'icmp' ? `ICMPv6 ${p.reply ? 'Echo Reply' : 'Echo Request'}` : p.proto === 'tcp' ? (p.reply ? `TCP SYN-ACK（來自埠 ${p.sport}）` : `TCP SYN → 埠 ${p.dport}`) : p.reply ? `UDP 回應（來自埠 ${p.sport}）` : `UDP → 埠 ${p.dport}`)
  + `　${fmtIp6(p.src)} → ${fmtIp6(p.dst)}`;

function forward6(state, ctx, startId, pkt) {
  let dev = state.devices[startId], inIf = null;
  const drop = (reason) => {
    ctx.log.push({ dev: dev.id, kind: 'drop', text: reason });
    return { ok: false, dev: dev.id, reason };
  };
  if ((state.down || {})[dev.id]) return drop(`${dev.name} 已經關機`);
  for (let n = 0; n < 32; n++) {
    // 進方向的 ACL：給路由器自己的封包也會被檢查
    if (inIf && inIf.acl6In && dev.routing) {
      const x = acl6Check(dev, inIf.acl6In, pkt, ctx.quiet);
      if (x) return drop(`${dev.name} 的 ${inIf.label} 進方向的 IPv6 ACL「${inIf.acl6In}」拒絕了這個封包：${x.text}`);
    }
    if (isLocal6(dev, pkt.dst)) return { ok: true, dev: dev.id, rxIf: inIf };
    if (inIf) {
      if (!dev.routing) return drop(`${dev.name} 收到不是給自己的 IPv6 封包，它不是路由器所以直接丟棄`);
      if (!dev.v6routing && dev.kind !== 'internet' && dev.kind !== 'firewall') return drop(`${dev.name} 沒有啟用 IPv6 路由 (ipv6 unicast-routing)，不會轉送 IPv6 封包`);
      if (--pkt.hl <= 0) return drop('Hop Limit 歸零，封包被丟棄（可能有路由迴圈）');
      if (!pkt.reply) ctx.l3.push({ dev: dev.id, ip6: inIf.rt.v6.addrs[0] ? inIf.rt.v6.addrs[0].ip : inIf.rt.v6.ll });
    }
    const r = lookup6(dev, pkt.dst, pkt.src);
    if (!r) {
      const any = dev.ifaces.some((i) => i.rt.v6 && i.rt.v6.addrs.length);
      const note = dev.ifaces.map((i) => i.rt.v6 && i.rt.v6.note).find(Boolean);
      if (dev.kind === 'host') return drop(any ? `${fmtIp6(pkt.dst)} 不在 ${dev.name} 的網段內，而且沒有 IPv6 預設閘道${note ? '（' + note + '）' : ''}` : `${dev.name} 沒有可用的 IPv6 位址${note ? '（' + note + '）' : ''}`);
      if (dev.kind === 'internet') return drop(`${fmtIp6(pkt.dst)} 不是 ISP 配給任何客戶的前綴：網際網路上沒有往它的路由（是不是用了以前的 ISP 或自己編的前綴？）`);
      const bad = (dev.rt.routes6 || []).find((x) => x.bad);
      return drop(`${dev.name} 的 IPv6 路由表裡沒有通往 ${fmtIp6(pkt.dst)} 的路由${bad ? '（' + bad.bad + '）' : ''}`);
    }
    // 防火牆的政策：IPv6 要比對政策的 srcaddr6 / dstaddr6（回程封包由連線紀錄放行）
    if (inIf && dev.kind === 'firewall' && !pkt.reply) {
      const v = fw6Filter(dev, inIf, r.iface, pkt);
      if (!v.ok) return drop(v.reason);
      ctx.log.push({ dev: dev.id, kind: 'info', text: `${dev.name} 的政策 #${v.rule} 允許這個 IPv6 連線` });
    }
    // 出方向的 ACL 只檢查轉送的封包（路由器自己送出的不檢查，和 IOS 一樣）
    if (inIf && r.iface.acl6Out && dev.routing) {
      const x = acl6Check(dev, r.iface.acl6Out, pkt, ctx.quiet);
      if (x) return drop(`${dev.name} 的 ${r.iface.label} 出方向的 IPv6 ACL「${r.iface.acl6Out}」拒絕了這個封包：${x.text}`);
    }
    const nh = r.via ?? pkt.dst;
    // IPv6 從 Tunnel 出去：外面包一層 IPv4（GRE 是協定 47、6in4 是協定 41），經過只有 IPv4 的網路送到對面
    if (isTun(r.iface)) {
      const t = r.iface, rt = t.rt.tun, mode = tunMode(t);
      if (!t.rt.link || !rt || !rt.up) return drop(`${dev.name} 的 ${t.label} 是 line protocol down：${(rt && rt.why) || '沒有啟用'}`);
      if (mode === 'ipsec') return drop(`${dev.name} 的 ${t.label} 是 tunnel mode ipsec ipv4：這種 VTI 只載送 IPv4，IPv6 要用 GRE（tunnel mode gre ip）或 tunnel mode ipv6ip`);
      if (mode === 'mgre') return drop(`${dev.name} 的 ${t.label} 是 multipoint GRE：IPv6 要另外設定 ipv6 nhrp，這個模擬沒有`);
      const v6in4 = mode === 'ipv6ip', key = t.tun.key != null && t.tun.key !== '' ? +t.tun.key : null;
      ctx.log.push({ dev: dev.id, kind: 'vpn', text: `${v6in4 ? '6in4' : 'GRE'} 封裝：IPv6 封包從 ${t.label} 送出，外面包一層 IPv4 ${fmtIp(rt.src)} → ${fmtIp(rt.dst)}（IP 協定 ${v6in4 ? 41 : 47}）` });
      const ctx4 = { ct: {}, log: ctx.log, hops: ctx.hops, l3: [] };
      const o = forward(state, ctx4, dev.id, { proto: v6in4 ? 'ipv6ip' : 'gre', src: rt.src, dst: rt.dst, sport: 0, dport: 0, ttl: 255, reply: pkt.reply, outer: true, greKey: v6in4 ? null : key, len: 80 + (v6in4 ? 20 : GRE_OVERHEAD), gre: { key, v6: true, inner: { proto: pkt.proto, src6: pkt.src.toString(16), dst6: pkt.dst.toString(16), reply: !!pkt.reply } } });
      if (!o.ok) return { ok: false, dev: o.dev, reason: o.reason };
      if (!o.gre) return drop(`${state.devices[o.dev].name} 收到封裝的 IPv6，但沒有交給任何 Tunnel 介面`);
      dev = state.devices[o.dev];
      inIf = o.gre;
      if (!inIf.rt.v6 || inIf.rt.v6.ll == null) return drop(`${dev.name} 的 ${inIf.label} 沒有啟用 IPv6（沒有 ipv6 address），解封裝出來的 IPv6 封包被丟掉`);
      ctx.log.push({ dev: dev.id, kind: 'vpn', text: `解封裝：還原出 IPv6 封包（從 ${inIf.label} 進來）` });
      continue;
    }
    const eps = l2Explore(state, dev.id, r.iface);
    if (eps.storm) return drop(`廣播風暴！${state.devices[eps.storm].name} 所在的網段形成了迴圈`);
    const tgt = eps.find((e) => owns6(e.iface, nh));
    if (!tgt) return drop(`鄰居探索 (NDP) 沒有回應：這個網段上找不到 ${fmtIp6(nh)}`);
    const nd = ndBlocked(state, dev, r.iface, tgt);
    if (nd) return drop(nd);
    ctx.log.push({ dev: dev.id, kind: 'l2', text: (r.via != null ? `查路由 → 下一站 ${fmtIp6(nh)}${r.type === 'O' ? '（OSPFv3）' : ''}：` : '') + [dev.name, ...tgt.path.map((h) => state.devices[h.to].name)].join(' → ') });
    for (const h of tgt.path) ctx.hops.push({ ...h, reply: pkt.reply, proto: 'icmp6' });
    dev = state.devices[tgt.dev];
    inIf = tgt.iface;
  }
  return drop('封包繞了太多站仍未抵達（路由迴圈）');
}

/** 防火牆的 IPv6 政策：srcaddr6 / dstaddr6 是 all 或 IPv6 的網段；沒有寫的政策不比對 IPv6 */
function fw6Filter(dev, inIf, outIf, pkt) {
  const m6 = (spec, ip) => {
    const s = String(spec || '').trim().toLowerCase();
    if (!s) return false;
    if (s === 'all' || s === 'any') return true;
    return s.split(/[,\s]+/).some((x) => { const c = parseCidr6(x.includes('/') ? x : x + '/128'); return c && net6(ip, c.bits) === net6(c.ip, c.bits); });
  };
  const ifOk = (p) => (p.srcIf === 'any' || p.srcIf === inIf.id || zoneHas(dev, p.srcIf, inIf)) && (p.dstIf === 'any' || p.dstIf === outIf.id || zoneHas(dev, p.dstIf, outIf));
  const list = dev.policies || [];
  for (let n = 0; n < list.length; n++) {
    const p = list[n];
    if (p.off || !ifOk(p)) continue;
    if (!m6(p.src6, pkt.src) || !m6(p.dst6, pkt.dst)) continue;
    if (!svcMatch(p.service, pkt)) continue;
    if (p.action === 'accept') return { ok: true, rule: n + 1 };
    return { ok: false, rule: n + 1, reason: `${dev.name} 的政策 #${n + 1}「${p.name || '未命名'}」拒絕了這個 IPv6 連線` };
  }
  const v4only = list.find((p) => !p.off && ifOk(p) && !String(p.src6 || '').trim());
  return { ok: false, reason: `${dev.name} 沒有符合的 IPv6 政策（${inIf.label} → ${outIf.label}），預設全部拒絕 (implicit deny)${v4only ? `：政策 #${list.indexOf(v4only) + 1}「${v4only.name || '未命名'}」只寫了 IPv4 的位址（srcaddr / dstaddr），IPv6 要另外設定 srcaddr6 / dstaddr6` : ''}` };
}

/** 這台設備往 dst 送封包時用哪個來源位址：出口介面上同網段的優先，其次是第一個全域位址 */
function srcFor(dev, dst) {
  const r = lookup6(dev, dst);
  if (r && r.iface) {
    const v = r.iface.rt.v6;
    const same = v.addrs.find((a) => net6(dst, a.bits) === net6(a.ip, a.bits));
    return (same || v.addrs[0] || { ip: v.ll }).ip;
  }
  const any = dev.ifaces.find((i) => i.rt.v6 && i.rt.v6.addrs.length);
  return any ? any.rt.v6.addrs[0].ip : 0n;
}

/**
 * IPv6 的一次往返：dst 是 BigInt。spec.proto 預設 ICMPv6 Echo；'tcp' / 'udp' 要給 dport。
 * 回傳 { ok, reason, failDev, log, hops, l3, responder, rxIf, phase }
 */
export function transact6(state, fromId, dst, spec = {}) {
  const ctx = { log: [], hops: [], l3: [], quiet: !!spec.quiet };
  const src = state.devices[fromId];
  const proto = spec.proto || 'icmp';
  const done = (r) => ({ ...r, log: ctx.log, hops: ctx.hops, l3: ctx.l3 });
  if (isLocal6(src, dst)) {
    ctx.log.push({ dev: fromId, kind: 'ok', text: `${fmtIp6(dst)} 就是自己，本機迴路成功` });
    return done({ ok: true, responder: fromId });
  }
  const from = srcFor(src, dst);
  const sport = spec.sport || (proto === 'icmp' ? 0 : 49152 + (fnv(String(fromId) + dst.toString(16)) % 16000));
  const req = { src: from, dst, hl: 64, reply: false, proto, sport, dport: spec.dport || 0, icmp: proto === 'icmp' ? 'echo-request' : undefined };
  ctx.log.push({ dev: fromId, kind: 'tx', text: '送出 ' + desc6(req) });
  const a = forward6(state, ctx, fromId, req);
  if (!a.ok) return done({ ok: false, reason: a.reason, failDev: a.dev, phase: 'request' });
  const target = state.devices[a.dev];
  const refuse = deliver6(target, req);
  if (refuse) { ctx.log.push({ dev: a.dev, kind: 'drop', text: refuse }); return done({ ok: false, reason: refuse, failDev: a.dev, phase: 'request', responder: a.dev, rxIf: a.rxIf }); }
  const rep = { src: dst, dst: from, hl: 64, reply: true, proto, sport: req.dport, dport: sport, icmp: proto === 'icmp' ? 'echo-reply' : undefined };
  ctx.log.push({ dev: a.dev, kind: 'rx', text: '收到，回覆 ' + desc6(rep) });
  const b = forward6(state, ctx, a.dev, rep);
  if (!b.ok) return done({ ok: false, reason: '回程失敗：' + b.reason, failDev: b.dev, phase: 'reply', responder: a.dev, rxIf: a.rxIf });
  ctx.log.push({ dev: fromId, kind: 'ok', text: proto === 'tcp' ? 'TCP 連線建立完成' : '收到回應，連線成功' });
  return done({ ok: true, responder: a.dev, rxIf: a.rxIf });
}

/** 設備第一個全域 IPv6 位址（沒有就回傳 null）。DHCPv6 拿到的優先於 SLAAC（Windows 也會優先用它） */
export function globalIp6(dev) {
  for (const src of ['static', 'dhcp6', 'slaac']) for (const i of dev.ifaces) {
    const a = i.rt.v6 && i.rt.v6.addrs.find((x) => x.src === src);
    if (a) return a.ip;
  }
  return null;
}

export function route6Rows(dev) {
  const name = { C: '直連', S: '靜態', O: 'OSPFv3' };
  return (dev.rt.routes6 || []).map((r) => ({
    type: r.type, typeName: name[r.type] || r.type, sub: r.sub || '',
    dst: r.bits === 0 ? '::/0（預設）' : `${fmtIp6(r.net)}/${r.bits}`,
    via: r.via == null ? '直連' : fmtIp6(r.via), iface: r.iface ? r.iface.label : '—', bad: r.bad || '', ad: r.ad, metric: r.metric,
  }));
}
