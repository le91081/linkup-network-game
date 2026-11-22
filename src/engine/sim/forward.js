// 封包轉送：服務、ACL、NAT、防火牆政策、交給本機的服務、逐站轉送、連線表、廣播的波形
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { BCAST, countGiant, debugOf, flowTraceStart, onHop } from '../wire.js';
import { CATALOG } from '../model.js';
import { IPSEC_OVERHEAD, MTU_DEF, WIFI_MTU, icmpTypeMatch, ipMtu, isNexus, l2Mtu, mssClampOf, rxMtu } from '../mtu.js';
import { agentOn } from '../snmp.js';
import { bgpAccepts } from '../bgp.js';
import { cloudOwns, cloudStep } from '../cloud.js';
import { debugLog, longIf } from '../ops.js';
import { dockerDeliver } from '../docker.js';
import { fmtIp, isPrivate, parseIp, sameNet } from '../ip.js';
import { aclRules } from '../policy.js';
import { PBR_HITS, PROTO_NUM, QUIET, cidrList, denyLog, fmtDur, hash, hit, ipLen, selMatch, sess, sessId, vrfOf } from './core.js';
import { VRRP_MAC, answerMac, arpTtl, floodPorts, l2Explore, learnPath, learns, macAgeOf, macKnown, reversed } from './l2.js';
import { daiBlock } from './auth.js';
import { findTunnel } from './tunnels.js';
import { lookupRoute } from './l3.js';
import { GRE_OVERHEAD, greRx, greTarget, isTun, nhrpRedirect, tunMode } from './gre.js';

// ───────────────────────────── 封包轉送 ─────────────────────────────

const SERVICES = {
  ALL: () => true,
  PING: (p) => p.proto === 'icmp',
  HTTP: (p) => p.proto === 'tcp' && p.dport === 80,
  HTTPS: (p) => p.proto === 'tcp' && p.dport === 443,
  DNS: (p) => p.dport === 53 && (p.proto === 'udp' || p.proto === 'tcp'),
  SSH: (p) => p.proto === 'tcp' && p.dport === 22,
  MYSQL: (p) => p.proto === 'tcp' && p.dport === 3306,
  RDP: (p) => p.proto === 'tcp' && p.dport === 3389,
  SMB: (p) => p.proto === 'tcp' && p.dport === 445,
};
export const SERVICE_NAMES = Object.keys(SERVICES);
const MGMT = { 22: ['ssh', 'SSH'], 23: ['telnet', 'Telnet'], 80: ['http', 'HTTP'], 443: ['https', 'HTTPS'] };

/** 政策的服務欄位可以列出好幾個服務 */
const svcMatch = (spec, pkt) => {
  const list = String(spec || 'ALL').split(/[,\s]+/).filter((s) => SERVICES[s.toUpperCase()]);
  return !list.length || list.some((s) => SERVICES[s.toUpperCase()](pkt));
};

/**
 * 防火牆每個介面各自決定開放哪些管理協定（FortiGate 的 allowaccess）。
 * 還沒有個別設定過的介面沿用舊的規則：WAN 只看 ping 的開關，其他介面依管理頁的全域開關。
 */
export function accessOf(dev, i) {
  if (Array.isArray(i.access)) return i.access;
  const mgmt = /^wan/.test(i.id) ? [] : ['https', 'ssh', 'http', 'telnet'].filter((k) => dev.mgmt && dev.mgmt[k]);
  return [...(i.ping !== false ? ['ping'] : []), ...mgmt];
}

function addrMatch(spec, ip) {
  const s = String(spec || '').trim().toLowerCase();
  if (s === '' || s === 'any' || s === 'all') return true;
  return selMatch(cidrList(s), ip);
}

/** 無狀態 ACL：回傳 null 代表放行，否則回傳被拒絕的原因 */
function aclCheck(list, pkt) {
  if (!list || !list.length) return null;
  for (let n = 0; n < list.length; n++) {
    const r = list[n];
    if (r.proto && r.proto !== 'ip' && r.proto !== pkt.proto) continue;
    if (r.icmp && !icmpTypeMatch(r.icmp, pkt)) continue; // permit icmp any any packet-too-big
    if (!addrMatch(r.src, pkt.src) || !addrMatch(r.dst, pkt.dst)) continue;
    if (r.port && (pkt.proto === 'tcp' || pkt.proto === 'udp') && +r.port !== pkt.dport) continue;
    if (r.sport && (pkt.proto === 'tcp' || pkt.proto === 'udp') && +r.sport !== pkt.sport) continue;
    hit(r);
    return r.action === 'permit' ? null : `ACL 第 ${n + 1} 條規則拒絕了這個封包`;
  }
  return 'ACL 沒有任何規則符合，隱含拒絕 (implicit deny any)';
}

export function pktDesc(p) {
  const what =
    p.icmpErr ? `ICMP 需要分段 (type 3 code 4，MTU ${p.mtu})`
    : p.proto === 'icmp' ? (p.reply ? 'ICMP Echo Reply' : 'ICMP Echo Request')
      : p.proto === 'tcp' ? (p.bulk ? `TCP 資料 ${p.len} 位元組${p.df ? '（DF）' : ''}` : p.ack ? `TCP ACK → 埠 ${p.dport}` : p.reply ? `TCP SYN-ACK（來自埠 ${p.sport}）` : `TCP SYN → 埠 ${p.dport}`)
        : p.proto === 'esp' ? 'ESP 加密封包' : p.proto === 'gre' ? 'GRE 封包' : p.natt ? 'NAT-T（UDP 4500 裡的 ESP）'
          : (p.reply ? `UDP 回應（來自埠 ${p.sport}）` : `UDP → 埠 ${p.dport}`);
  return `${what}　${fmtIp(p.src)} → ${fmtIp(p.dst)}`;
}

export function isLocal(dev, ip, vrf) {
  if (dev.ifaces.some((i) => (vrf == null || vrfOf(i) === vrf) && (i.rt.ip === ip || i.rt.vips.includes(ip)))) return true;
  if (dev.rt.tunnels.some((t) => t.vip === ip)) return true;
  if (dev.kind === 'cloud') return cloudOwns(dev, ip);
  return dev.kind === 'internet' && dev.inet.hosts.some((h) => parseIp(h.ip) === ip);
}

export function findOwner(state, ip) {
  for (const d of Object.values(state.devices)) if (isLocal(d, ip)) return d;
  return null;
}

/** 這台設備身上如果有一條「有原因的」斷線（被 shutdown、對面關機、線太長），附在錯誤訊息後面 */
function deadLink(state, dev) {
  const c = state.cables.find((x) => (x.a.dev === dev.id || x.b.dev === dev.id) && state.rt.why[x.id]);
  return c ? `（${state.rt.why[c.id]}）` : '';
}

export function noRouteReason(state, dev, dst) {
  const bad = dev.rt.routes.find((r) => r.bad && r.bits === 0);
  if (dev.kind === 'host') {
    const i = dev.ifaces.find((x) => x.rt.ip != null && x.rt.link);
    if (!i) {
      const cfg = dev.ifaces.find((x) => x.rt.ip != null);
      if (cfg && cfg.bind.t === 'wlan') return `${dev.name} 的 Wi-Fi 沒有連線：${cfg.rt.note || '尚未連上基地台'}`;
      if (cfg) {
        const cb = state.cables.find((c) => (c.a.dev === dev.id && c.a.port === cfg.bind.port) || (c.b.dev === dev.id && c.b.port === cfg.bind.port));
        return cb ? `${dev.name} 的網路孔沒有燈號：${state.rt.why[cb.id] || '對端的連接埠被停用，或對端設備沒有電'}` : `${dev.name} 的網路線沒有接上`;
      }
      const n = dev.ifaces.map((x) => x.rt.note).find(Boolean);
      return `${dev.name} 還沒有 IP 位址${n ? '（' + n + '）' : ''}`;
    }
    if (i.rt.src === 'apipa') return `${dev.name} 只拿到 APIPA 位址 ${fmtIp(i.rt.ip)}，代表 DHCP 沒有成功${i.rt.note ? '（' + i.rt.note + '）' : ''}`;
    if (bad) return `${dev.name} 的${bad.bad}`;
    return `${fmtIp(dst)} 不在 ${dev.name} 自己的子網路內，而且沒有設定預設閘道`;
  }
  if (bad) return `${dev.name} 的${bad.bad}${deadLink(state, dev)}`;
  const forming = (dev.rt.nbrs || []).filter((n) => n.state === 'forming');
  if (forming.length) return `${dev.name} 的路由表裡還沒有通往 ${fmtIp(dst)} 的路由：OSPF 鄰居關係還在建立，再 ${Math.ceil(Math.max(...forming.map((n) => n.left)))} 秒才會交換路由`;
  const wan = dev.ifaces.find((x) => x.rt.ip == null && x.rt.note && (x.mode === 'dhcp' || x.mode === 'pppoe'));
  return `${dev.name} 的路由表裡沒有通往 ${fmtIp(dst)} 的路由${wan ? `（${wan.label}：${wan.rt.note}）` : deadLink(state, dev)}`;
}

function arpFail(state, dev, outIf, nh, viaGw, eps) {
  const b = outIf.bind;
  if ((b.t === 'port' || b.t === 'sub') && !state.rt.links[dev.id + ':' + b.port]) return `${dev.name} 的 ${outIf.label} 沒有連線`;
  const owner = findOwner(state, nh);
  const who = viaGw ? `下一站（閘道）${fmtIp(nh)}` : fmtIp(nh);
  if (eps.dot1x) return `ARP 沒有回應：連接埠還沒有通過 802.1X 驗證（${eps.dot1x}）`;
  if (eps.ps) return `ARP 沒有回應：${dev.name} 的訊框被 ${eps.ps} 的 Port Security 擋下（不是允許的 MAC 位址）`;
  if (!owner) {
    // 雲端業者配置給你的彈性 IP：還沒有關聯到執行個體，或 VPC 沒有連接網際網路閘道，業者就不會替它回應
    const cl = Object.values(state.devices).find((d) => d.kind === 'cloud' && d.vpc && d.vpc.eips.includes(fmtIp(nh)));
    if (cl) return `${fmtIp(nh)} 是 ${cl.name} 的彈性 IP，但${cl.vpc.igw ? '還沒有關聯到任何執行個體或 NAT 閘道' : ' VPC 沒有連接網際網路閘道 (IGW)'}，雲端業者不會替它收封包`;
    return `ARP 沒有回應：找不到 ${who}，沒有任何設備使用這個 IP`;
  }
  if (eps.span) return `ARP 沒有回應：${state.devices[eps.span.dev].name} 的 ${eps.span.pid} 是 SPAN（連接埠鏡像）的目的埠。交換器只會從這個埠送出複製的訊框，接在上面的設備送進來的封包一律不轉送`;
  if (eps.stp) {
    const s = eps.stp;
    return `${state.devices[s.dev].name} 的 ${s.pid} 剛連上，還在 STP 的${s.left > 15 ? ' listening ' : s.left > 2 ? ' learning ' : '協商'}狀態，再 ${Math.ceil(s.left)} 秒才會開始轉送資料${s.left > 2 ? '（接電腦或伺服器的埠可以啟用 PortFast，跳過這段等待）' : ''}`;
  }
  // 路徑上如果有沒燈號的線，把原因一起說出來
  const dead = state.cables.find((c) => state.rt.why[c.id]);
  const extra = dead ? `。另外，${state.devices[dead.a.dev].name} ↔ ${state.devices[dead.b.dev].name} 的連線沒有燈號：${state.rt.why[dead.id]}` : '';
  return `ARP 沒有回應：${owner.name} 是 ${fmtIp(nh)}，但從 ${dev.name} 的第二層（接線 / VLAN / 無線）到不了它${extra}`;
}

/**
 * 從 outIf 出去時要不要做 NAT。路由器可以用 ACL 指定哪些流量才轉換（ip nat inside source list），
 * 或在圖形介面填「NAT 例外」的目的網段；兩者都沒有就是全部轉換。
 */
/**
 * 政策路由 (PBR)：依 route-map 的順序比對 match ip address <ACL>。
 * 符合 permit 的那一條：set ip next-hop 是直連而且介面亮著就直接交給它（不查路由表）；
 * set ip default next-hop 只有在路由表裡沒有更明確的路（只有預設路由）時才用。
 * 符合 deny、下一站不通、一條都沒有符合：照一般的路由表
 */
function pbrRoute(dev, name, pkt, vrf, log) {
  const rm = (dev.routeMaps || {})[name];
  if (!rm) return null;
  const say = (text) => log.push({ dev: dev.id, kind: 'info', text });
  const conn = (ip) => dev.ifaces.find((i) => i.rt && i.rt.ip != null && i.rt.link && !i.shut && vrfOf(i) === vrf && sameNet(ip, i.rt.ip, i.rt.bits) && ip !== i.rt.ip);
  const to = (x) => { const ip = parseIp(x), i = ip != null && conn(ip); return i ? { iface: i, via: ip, type: 'P', ad: 0, metric: 0, pbr: name } : null; };
  for (const e of rm.slice().sort((a, b) => a.seq - b.seq)) {
    const m = e.match || {};
    if (m.pl || m.fl) continue; // 封包沒有 prefix-list、AS path 可以比
    if (m.acl) {
      const rules = aclRules(dev, m.acl);
      if (rules && rules.length && aclCheck(rules, pkt) !== null) continue; // ACL 沒有放行：這一條不符合
    }
    if (!QUIET) { const c = PBR_HITS.get(e) || { pk: 0, by: 0 }; c.pk++; c.by += ipLen(pkt) + 14; PBR_HITS.set(e, c); }
    if (e.action === 'deny') { say(`政策路由：符合 route-map ${name} 的 deny ${e.seq}，照一般的路由表轉送`); return null; }
    const s = e.set || {};
    for (const x of s.nh || []) {
      const r = to(x);
      if (r) { say(`政策路由 (PBR)：符合 route-map ${name} 第 ${e.seq} 條${m.acl ? `（ACL ${m.acl}）` : ''}，不查路由表，直接交給 ${x}`); return r; }
    }
    if ((s.defNh || []).length) {
      const r0 = lookupRoute(dev, pkt.dst, pkt.src, vrf);
      if (r0 && r0.bits > 0) { say(`政策路由：路由表裡有往 ${fmtIp(pkt.dst)} 的明確路由，set ip default next-hop 不起作用`); return null; }
      for (const x of s.defNh) { const r = to(x); if (r) { say(`政策路由：路由表裡沒有更明確的路，照 set ip default next-hop 交給 ${x}`); return r; } }
    }
    if ((s.nh || []).length || (s.defNh || []).length) say(`政策路由：route-map ${name} 第 ${e.seq} 條指定的下一站 ${[...(s.nh || []), ...(s.defNh || [])].join('、')} 不是直連網段、或那個介面沒有啟用，改照路由表轉送`);
    return null;
  }
  return null;
}

function natPermits(dev, outIf, pkt) {
  if (selMatch(cidrList(outIf.natSkip), pkt.dst)) return false;
  const rules = outIf.natAcl && (dev.aclDefs || {})[outIf.natAcl];
  return !rules || !rules.length || aclCheck(rules, pkt) === null;
}

function matchPortForward(dev, inIf, pkt) {
  for (const f of dev.portForwards || []) {
    if (f.off || (f.proto || 'tcp') !== pkt.proto || +f.port !== pkt.dport) continue;
    const ext = parseIp(f.extIp || '');
    if (ext != null ? ext !== pkt.dst : pkt.dst !== inIf.rt.ip) continue;
    const ip = parseIp(f.toIp);
    if (ip == null) continue;
    return { ip, port: +(f.toPort || f.port) };
  }
  return null;
}

function filter(dev, inIf, outIf, pkt, dnat) {
  if (dev.kind === 'homerouter') {
    if (inIf.id === 'wan' && !dnat) return { ok: false, reason: `${dev.name} 的防火牆擋下來自 WAN 的主動連線（沒有對應的連接埠轉發）` };
    return { ok: true, nat: outIf.nat };
  }
  if (dev.kind === 'firewall') {
    const list = dev.policies || [];
    for (let n = 0; n < list.length; n++) {
      const p = list[n];
      if (p.off) continue;
      if (p.srcIf !== 'any' && p.srcIf !== inIf.id) continue;
      if (p.dstIf !== 'any' && p.dstIf !== outIf.id) continue;
      if (!addrMatch(p.src, pkt.src) || !addrMatch(p.dst, pkt.dst)) continue;
      if (!svcMatch(p.service, pkt)) continue;
      hit(p);
      if (p.action === 'accept') return { ok: true, nat: !!p.nat, rule: n + 1 };
      return { ok: false, rule: n + 1, reason: `${dev.name} 的政策 #${n + 1}「${p.name || '未命名'}」拒絕了這個連線` };
    }
    return { ok: false, reason: `${dev.name} 沒有符合的政策（${inIf.label} → ${outIf.label}），預設全部拒絕 (implicit deny)` };
  }
  return { ok: true, nat: outIf.nat };
}

/** NAT 設備替後面的 NAT-T 對端留著的轉換：外面送進來的 UDP 4500 轉給 NAT 後面那台路由器 */
function nattMap(state, dev, pkt) {
  if (!pkt.natt) return null;
  const m = (state.rt.natt || []).find((x) => x.by === dev.id && x.peer === pkt.src);
  return m ? { ip: m.local, port: 4500, natt: true } : null;
}

function deliver(dev, inIf, pkt) {
  const ok = { ok: true, dev: dev.id };
  const no = (reason) => ({ ok: false, dev: dev.id, reason });
  if (pkt.proto === 'esp' || (pkt.proto === 'udp' && pkt.natt)) {
    // 同一個對端可能有好幾個 SA（crypto map、VTI、DMVPN）：用 SPI 找出是哪一個
    const cand = dev.rt.tunnels.filter((x) => x.up && x.peerIp === pkt.src);
    const t = cand.find((x) => x.peer && hash(x.peer.dev + '/' + x.peer.name) === pkt.spi) || cand[0];
    return t ? { ok: true, dev: dev.id, tun: t } : no(`${dev.name} 收到來源不明的加密封包，直接丟棄`);
  }
  if (pkt.proto === 'gre') {
    const g = greRx(null, dev, pkt);
    return g.iface ? { ok: true, dev: dev.id, gre: g.iface } : no(g.why);
  }
  if (pkt.reply || pkt.icmpErr) return ok;
  const PROTO = pkt.proto.toUpperCase();
  // BGP：只接受設定成鄰居的那個位址連進來的 TCP 179
  if (pkt.proto === 'tcp' && pkt.dport === 179) return bgpAccepts(dev, pkt.src) ? ok : no(`${dev.name} 沒有把 ${fmtIp(pkt.src)} 設成 BGP 鄰居，拒絕了 TCP 179 的連線`);
  if (dev.kind === 'internet') {
    const h = dev.inet.hosts.find((x) => parseIp(x.ip) === pkt.dst);
    if (pkt.proto === 'icmp') return ok;
    if (h && h.services.some((s) => s.proto === pkt.proto && s.port === pkt.dport)) return ok;
    return no(`${h ? h.name : fmtIp(pkt.dst)} 沒有在 ${PROTO}/${pkt.dport} 提供服務`);
  }
  const owner = dev.ifaces.find((i) => i.rt.ip === pkt.dst);
  const fromWan = inIf && /^wan/.test(inIf.id) && (dev.kind === 'firewall' || dev.kind === 'homerouter');
  if (pkt.proto === 'icmp') {
    if (dev.kind === 'firewall' && owner && inIf === owner && !accessOf(dev, owner).includes('ping')) return no(`${dev.name} 的 ${owner.label} 介面沒有開放 ping（allowaccess 裡沒有 ping）`);
    if (dev.kind !== 'firewall' && owner && owner.ping === false && inIf === owner) return no(`${dev.name} 的 ${owner.label} 介面不回應來自外部的 ping（安全性預設值）`);
    return ok;
  }
  if (pkt.proto === 'udp') {
    if (pkt.dport === 53 && dev.dnsProxy && !fromWan) return ok;
    if (pkt.dport === 67 && dev.dhcpScopes) return ok;
    if ((pkt.dport === 1812 || pkt.dport === 1813) && dev.radiusServer) return ok;
    if ((pkt.dport === 500 || pkt.dport === 4500) && dev.vpns && (dev.vpns.length || dev.ifaces.some((x) => isTun(x) && x.tun && x.tun.prot))) return ok;
    if (pkt.dport === 123 && dev.rt.ntpServe) return ok; // 設成 ntp master，或自己已經對好時的設備可以替別人報時
    if ((pkt.dport === 5246 || pkt.dport === 5247) && dev.kind === 'wlc') return ok; // CAPWAP 控制 / 資料
    if (pkt.dport === 161 && dev.mgmt && agentOn(dev)) {
      // FortiGate 每個介面要在 allowaccess 開放 snmp，代理才會回答
      if (dev.kind === 'firewall' && inIf && !accessOf(dev, inIf).includes('snmp')) return no(`${dev.name} 的 ${inIf.label} 介面沒有開放 SNMP（allowaccess 裡沒有 snmp）`);
      return ok;
    }
  }
  if (pkt.proto === 'tcp' && dev.vpnServer && dev.vpnServer.on && pkt.dport === (+dev.vpnServer.port || 10443)) return ok; // SSL-VPN
  if (pkt.proto === 'tcp' && dev.mgmt && MGMT[pkt.dport]) {
    const [k, name] = MGMT[pkt.dport];
    if (dev.kind === 'firewall' && inIf) {
      if (!accessOf(dev, inIf).includes(k)) return no(`${dev.name} 的 ${inIf.label} 介面沒有開放 ${name} 管理（allowaccess 裡沒有 ${k}）`);
    } else {
      if (!dev.mgmt[k]) return no(`${dev.name} 沒有開啟 ${name} 管理服務（連線被拒絕）`);
      if (fromWan) return no(`${dev.name} 的管理介面不對 WAN 開放`);
      // IOS 沒有 RSA 金鑰就沒有 SSH 伺服器在聽
      const cisco = !dev.locked && CATALOG[dev.model].vendor === 'Cisco' && ['router', 'mswitch', 'l3switch'].includes(dev.kind);
      if (k === 'ssh' && cisco && !(dev.mgmt.sshKey && dev.mgmt.sshKey.bits >= 768)) {
        return no(`${dev.name} 的 SSH 沒有啟用（連線被拒絕）：${dev.mgmt.sshKey ? 'RSA 金鑰只有 ' + dev.mgmt.sshKey.bits + ' 位元，SSH 2 至少要 768' : '還沒有 RSA 金鑰。先設定 ip domain name，再 crypto key generate rsa modulus 2048'}`);
      }
    }
    if (!addrMatch(String(dev.mgmt.allow || '').replace(/[,\s]+/g, ','), pkt.src)) return no(`來源 ${fmtIp(pkt.src)} 不在 ${dev.name} 允許管理的位址範圍內`);
    return ok;
  }
  if (dev.docker) { const dk = dockerDeliver(dev, pkt); if (dk) return dk.ok ? ok : no(dk.reason); }
  if (pkt.proto === 'tcp' && pkt.dport === 5201 && dev.kind === 'host') return ok; // 每台主機都當作有跑 iperf3 -s，可以拿來測速
  if ((dev.services || []).some((s) => s.proto === pkt.proto && s.port === pkt.dport)) return ok;
  return no(`${dev.name} 沒有在 ${PROTO}/${pkt.dport} 提供服務（連線被拒絕）`);
}

export function forward(state, ctx, startId, pkt) {
  const { log, hops } = ctx;
  let dev = state.devices[startId];
  let inIf = null;
  const drop = (reason) => {
    log.push({ dev: dev.id, kind: 'drop', text: reason });
    return { ok: false, dev: dev.id, reason };
  };
  if ((state.down || {})[dev.id]) return drop(`${dev.name} 已經關機`);
  if (state.rt.rommon && state.rt.rommon[dev.id]) return drop(`${dev.name} 停在 ROMMON，沒有開機成功：${state.rt.rommon[dev.id]}`);
  if (state.rt.booting && state.rt.booting[dev.id] > 0) return drop(`${dev.name} 還在開機中（還要 ${Math.ceil(state.rt.booting[dev.id])} 秒）`);
  if (state.rt.off[dev.id]) return drop(`${dev.name} 沒有電 — 它需要接在有 PoE 供電的連接埠上`);
  for (let n = 0; n < 48; n++) {
    let established = false, dnat = null;
    const o = { src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport };
    const stateful = dev.kind === 'firewall' || dev.kind === 'homerouter';
    // FortiGate 的 diagnose debug flow：記下這個封包在防火牆裡的每一步
    const tr = !QUIET && inIf ? flowTraceStart(state, dev, pkt) : null;
    const T = (fn, msg) => { if (tr) tr(fn, msg); };
    // IOS 的 debug ip packet / debug ip icmp
    const dbg = !QUIET ? debugOf(state, dev.id) : null;
    const D = (what, text) => { if (dbg && dbg[what]) debugLog(state, dev, text); };
    // 雲端的 VPC：子網路的路由表、網際網路閘道 / NAT 閘道、安全群組與網路 ACL 由 cloud.js 處理
    let cloud = null;
    if (dev.kind === 'cloud') {
      const c = cloudStep(state, ctx, dev, inIf, pkt, { findTunnel, track });
      if (c.drop) return drop(c.drop);
      if (c.done) return { ok: true, dev: dev.id };
      if (!c.pass) cloud = c;
    }
    if (inIf && !cloud) {
      if (tr) {
        const n = PROTO_NUM[pkt.proto] || 0, dp = pkt.proto === 'icmp' ? (pkt.reply ? 0 : 2048) : pkt.dport;
        const extra = pkt.proto === 'icmp' ? ` type=${pkt.reply ? 0 : 8}, code=0, id=${pkt.reply ? pkt.dport : pkt.sport}, seq=1.`
          : pkt.proto === 'tcp' ? ` flag [${pkt.data ? 'P.' : pkt.ack ? '.' : pkt.reply ? 'S.' : 'S'}], seq 1, ack ${pkt.ack || pkt.reply ? 1 : 0}, win 64240` : '';
        T('print_pkt_detail', `vd-root:0 received a packet(proto=${n}, ${fmtIp(pkt.src)}:${pkt.sport}->${fmtIp(pkt.dst)}:${dp}) tun_id=0.0.0.0 from ${inIf.id.replace(/^vpn:/, '')}.${extra}`);
      }
      const deny = aclCheck(inIf.aclIn, pkt);
      if (deny) {
        D('packet', `IP: s=${fmtIp(pkt.src)} (${longIf(inIf.label)}), d=${fmtIp(pkt.dst)}, len ${ipLen(pkt)}, access denied`);
        return drop(`${dev.name} 的 ${inIf.label}（進入方向）：${deny}`);
      }
      const ct = ctx.ct[dev.id];
      const e = ct && ct.find((x) => x.proto === pkt.proto && x.nDst === pkt.src && x.nSrc === pkt.dst && x.nDport === pkt.sport && x.nSport === pkt.dport);
      // 同一條連線後續的封包（三向交握的 ACK）：有連線紀錄的設備直接比對紀錄，套用同樣的位址轉換，不再重新比對政策
      const flow = !pkt.reply && pkt.ack && ct && ct.find((x) => x.proto === pkt.proto && x.src === pkt.src && x.sport === pkt.sport && x.dst === pkt.dst && x.dport === pkt.dport);
      if (flow) {
        established = true;
        T('resolve_ip_tuple_fast', `Find an existing session, id-${sessId(flow)}, original direction`);
        flow.t = state.clock; flow.st = 'est';
        pkt.src = flow.nSrc; pkt.sport = flow.nSport; pkt.dst = flow.nDst; pkt.dport = flow.nDport;
      } else if (pkt.icmpErr && ct && pkt.inner) {
        const q = pkt.inner;
        const rel = ct.find((x) => x.proto === q.proto && x.nSrc === q.src && x.nSport === q.sport && x.nDst === q.dst && x.nDport === q.dport)
          || ct.find((x) => x.proto === q.proto && ((x.src === q.dst && x.dst === q.src) || (x.nSrc === q.dst && x.nDst === q.src)));
        if (rel) {
          established = true; // 和既有連線有關的 ICMP 錯誤：有狀態的設備直接放行
          if (rel.nSrc === q.src && rel.nSport === q.sport && rel.src !== rel.nSrc) {
            log.push({ dev: dev.id, kind: 'nat', text: `NAT 還原：ICMP 錯誤訊息裡夾帶的原始封包是 ${fmtIp(q.src)}，送回內部的 ${fmtIp(rel.src)}` });
            pkt.dst = rel.src; pkt.inner = { ...q, src: rel.src, sport: rel.sport };
          }
        }
      } else if (e && pkt.reply) {
        established = true;
        T('resolve_ip_tuple_fast', `Find an existing session, id-${sessId(e)}, reply direction`);
        if (e.nSrc !== e.src) T('__ip_session_run_tuple', `DNAT ${fmtIp(pkt.dst)}:${pkt.dport}->${fmtIp(e.src)}:${e.sport}`);
        e.t = state.clock; // 有封包經過，閒置的計時重新開始
        if (e.src !== pkt.dst || e.dst !== pkt.src) {
          log.push({ dev: dev.id, kind: 'nat', text: `NAT 還原：${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}　改回　${fmtIp(e.dst)} → ${fmtIp(e.src)}` });
        }
        pkt.src = e.dst; pkt.sport = e.dport; pkt.dst = e.src; pkt.dport = e.sport;
      } else if (!pkt.reply) {
        const sn = (dev.staticNat || []).find((x) => parseIp(x.pub || '') === pkt.dst && parseIp(x.priv || '') != null);
        dnat = sn ? { ip: parseIp(sn.priv), port: pkt.dport, stat: true } : matchPortForward(dev, inIf, pkt) || nattMap(state, dev, pkt);
        if (dnat) {
          sess(dev, { act: 'dnat', proto: pkt.proto, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport, ndst: dnat.ip, ndport: dnat.port });
          log.push({ dev: dev.id, kind: 'nat', text: dnat.stat ? `靜態 NAT：目的位址 ${fmtIp(pkt.dst)} 換成 ${fmtIp(dnat.ip)}` : dnat.natt ? `NAT 還原（NAT-T）：UDP 4500 的轉換一直有 IPsec 的封包在用，${fmtIp(pkt.dst)}:4500 轉回裡面的 ${fmtIp(dnat.ip)}:4500` : `連接埠轉發：${fmtIp(pkt.dst)}:${pkt.dport} → ${fmtIp(dnat.ip)}:${dnat.port}` });
          pkt.dst = dnat.ip; pkt.dport = dnat.port;
        }
      }
      if (dev.kind === 'internet' && !pkt.reply && isPrivate(pkt.src)) {
        return drop(`來源 ${fmtIp(pkt.src)} 是私有 IP，ISP 直接丟棄 — 出口路由器沒有做 NAT`);
      }
      // 業者內部故障：線路的燈號正常、ISP 那一端的閘道也回應，但封包再也出不去（只看介面狀態的備援偵測不到）
      if (dev.kind === 'internet' && dev.inet.fault && !dev.ifaces.some((i) => i.rt.ip === pkt.dst)) {
        return drop(`${dev.name} 的骨幹故障：封包到了業者那一端就出不去（線路燈號正常，介面沒有 down）`);
      }
      if (isLocal(dev, pkt.dst, vrfOf(inIf))) {
        T('vf_ip_route_input_common', `find a route: flag=84000000 gw-${fmtIp(pkt.dst)} via root`);
        const r = deliver(dev, inIf, pkt);
        if (!r.ok) { log.push({ dev: dev.id, kind: 'drop', text: r.reason }); T('fw_local_in_handler', 'iprope_in_check() check failed on policy 0, drop'); }
        else if (pkt.proto !== 'esp') {
          D('packet', `IP: s=${fmtIp(pkt.src)} (${longIf(inIf.label)}), d=${fmtIp(pkt.dst)} (${longIf(inIf.label)}), len ${ipLen(pkt)}, rcvd 3`);
          if (pkt.proto === 'icmp') D('icmp', pkt.reply ? `ICMP: echo reply rcvd, src ${fmtIp(pkt.src)}, dst ${fmtIp(pkt.dst)}, topology BASE, dscp 0 topoid 0` : `ICMP: echo reply sent, src ${fmtIp(pkt.dst)}, dst ${fmtIp(pkt.src)}, topology BASE, dscp 0 topoid 0`);
        }
        return r;
      }
      if (!dev.routing) return drop(`${dev.name} 收到不是給自己的封包（目的 ${fmtIp(pkt.dst)}），它不是路由器所以直接丟棄`);
      if (--pkt.ttl <= 0) return drop('TTL 歸零，封包被丟棄（可能有路由迴圈）');
      if (!pkt.reply && !pkt.ack && pkt.proto !== 'esp' && !pkt.natt && !pkt.outer) ctx.l3.push({ dev: dev.id, ip: inIf.rt.ip });
    } else if (!cloud && isLocal(dev, pkt.dst, dev.id === ctx.vrfDev ? ctx.vrf : '')) {
      return { ok: true, dev: dev.id };
    }

    // VPN：符合通道的本地 / 遠端網段就加密後送給對端
    let tun = cloud ? cloud.tunnel || null : pkt.proto !== 'esp' && !pkt.natt && findTunnel(dev, pkt);
    if (tun && dev.kind === 'router' && inIf && !pkt.reply && tun.up) {
      // 路由器的處理順序是「先 NAT，再比對要不要加密」。來源位址一旦被換掉，就不再符合 VPN 的加密範圍
      const wan = lookupRoute(dev, tun.peerIp);
      if (wan && wan.iface !== inIf && wan.iface.nat && natPermits(dev, wan.iface, pkt)) {
        log.push({ dev: dev.id, kind: 'info', text: `注意：${dev.name} 會先做 NAT 再檢查 VPN。這個封包的來源會被換成 ${wan.iface.label} 的位址，就不符合通道「${tun.name}」的加密範圍了 — 往對端內網的流量要設成 NAT 例外` });
        tun = null;
      }
    }
    // 已經建立的連線，半路上的封包來到防火牆時連線表裡卻沒有它（閒置太久被移除了）：FortiGate 不會把它當成新連線
    if (tr && !established && !pkt.reply && !ctx.mid) T('init_ip_session_common', `allocate a new session-${sessId({ proto: pkt.proto, ...o })}, tun_id=0.0.0.0`);
    const lostSession = () => (T('ip_session_handler', 'no session matched'), drop(`${dev.name} 的連線表裡已經沒有這條連線：閒置超過 ${sessionTtl(dev, { proto: 'tcp', st: 'est' })} 秒就會被移除。防火牆不會讓半路出現、不是 SYN 的 TCP 封包通過，直接丟棄 (no session matched)`));
    if (tun) {
      if (!tun.up) return drop(`VPN 通道「${tun.name}」沒有建立：${tun.why}`);
      if (inIf && !established && ctx.mid && dev.kind === 'firewall') return lostSession();
      T('vf_ip_route_input_common', `find a route: flag=04000000 gw-${fmtIp(tun.peerIp)} via ${tun.name}`);
      if (inIf && !established) {
        const v = filter(dev, inIf, tun.iface, pkt, dnat);
        T('fw_forward_handler', v.ok ? `Allowed by Policy-${v.rule || 0}:` : `Denied by forward policy check (policy ${v.rule || 0})`);
        if (stateful) sess(dev, { act: v.ok ? 'allow' : 'deny', proto: pkt.proto, ...o, rule: v.rule || 0, inIf: inIf.label, outIf: tun.iface.label });
        if (!v.ok) { denyLog(state, dev, pkt, o, inIf, tun.iface, v.rule); return drop(v.reason); }
        if (v.rule) log.push({ dev: dev.id, kind: 'fwd', text: `符合政策 #${v.rule}，放行（${inIf.label} → ${tun.iface.label}）` });
        if (!pkt.reply && stateful) track(state, ctx, dev, { proto: pkt.proto, ...o, nSrc: pkt.src, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport, inIf: inIf.label, outIf: tun.iface.label, rule: v.rule || 0 });
      }
      const ssl = !tun.cfg; // 遠端存取是 SSL-VPN（包在 TLS 裡），站對站是 IPsec（包在 ESP 裡）
      let espLen;
      if (!ssl && !cloud && (dev.kind === 'router' || dev.kind === 'firewall')) {
        const wan = lookupRoute(dev, tun.peerIp);
        const wm = wan ? ipMtu(state, dev, wan.iface) : MTU_DEF, tm = wm - IPSEC_OVERHEAD;
        // 加密前的 SYN 也會被 WAN 介面上的 ip tcp adjust-mss 改小
        if (pkt.proto === 'tcp' && !pkt.ack && !pkt.bulk) ctx.mssClamp = Math.min(ctx.mssClamp ?? Infinity, mssClampOf(state, dev, inIf, wan && wan.iface));
        if (ipLen(pkt) > tm) {
          if (pkt.df) {
            const reason = `${dev.name} 要把 ${ipLen(pkt)} 位元組的封包送進 VPN 通道「${tun.name}」：加密後多了 ${IPSEC_OVERHEAD} 位元組的標頭，會超過 ${wan ? wan.iface.label : 'WAN'} 的 MTU ${wm}（通道裡最多只能放 ${tm}）。封包設了 DF 不能分段，只好丟掉`;
            log.push({ dev: dev.id, kind: 'drop', text: reason });
            if (!inIf) return { ok: false, dev: dev.id, local: true, mtu: tm, reason };
            return { ok: false, dev: dev.id, reason, ptb: { at: dev.id, mtu: tm, vrf: vrfOf(inIf), pkt: { ...pkt } } };
          }
          const n = Math.ceil((ipLen(pkt) - 20) / (tm - 20));
          log.push({ dev: dev.id, kind: 'info', text: `加密前先分段：${ipLen(pkt)} 位元組加上 IPsec 的標頭會超過 MTU ${wm}，先切成 ${n} 片（每片最多 ${tm}）再分別加密` });
          pkt.len = tm;
        }
        espLen = ipLen(pkt) + IPSEC_OVERHEAD;
      }
      T('ipsecdev_hard_start_xmit', `enter IPsec interface-${tun.name}`);
      T('esp_output4', `IPsec encrypt/auth`);
      T('ipsec_output_finish', `send to ${fmtIp(tun.peerIp)} via intf-${tun.cfg && tun.cfg.wan ? tun.cfg.wan : 'wan1'}`);
      log.push({ dev: dev.id, kind: 'vpn', text: `加密：整個封包包進 ${ssl ? 'TLS（SSL-VPN 的 TCP 連線）' : 'ESP'}，外層位址 ${fmtIp(tun.localIp)} → ${fmtIp(tun.peerIp)}` });
      if (tun.natT) log.push({ dev: dev.id, kind: 'vpn', text: `NAT-T：中間有 NAT，ESP 再包進 UDP 4500（${fmtIp(tun.localIp)}:4500 → ${fmtIp(tun.peerIp)}:4500）才穿得過 PAT` });
      const r = forward(state, ctx, dev.id, { ...(tun.natT ? { proto: 'udp', sport: 4500, dport: 4500, natt: true } : { proto: 'esp', sport: 0, dport: 0 }), src: tun.localIp, dst: tun.peerIp, ttl: 64, reply: pkt.reply, ssl, spi: hash(dev.id + '/' + tun.name), ...(espLen ? { len: espLen + (tun.natT ? 8 : 0) } : {}) });
      if (!r.ok) {
        if (!tun.stale) return r;
        return drop(`VPN 通道「${tun.name}」在 ${dev.name} 上看起來還是 Up（SA 還沒過期），封包照樣加密送了出去，但對端已經失聯：${tun.stale.why}。${dev.name} 還要 ${fmtDur(tun.stale.until - state.clock)} 才會發現${tun.stale.dpd ? '（DPD 探測中）' : '（沒有設定 keepalive，只能等 SA 到期）'}`);
      }
      if (!QUIET && tun.cfg) {
        // 加密、解密的封包數（show crypto ipsec sa 的 #pkts encaps / decaps）
        const sa1 = state.dyn.sa[dev.id + '/' + tun.name], sa2 = r.tun && state.dyn.sa[r.dev + '/' + r.tun.name];
        if (sa1) sa1.tx++;
        if (sa2) sa2.rx++;
      }
      dev = state.devices[r.dev];
      inIf = r.tun.iface;
      log.push({ dev: dev.id, kind: 'vpn', text: `解密：還原出內層封包 ${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}（從 ${inIf.label} 進來）` });
      continue;
    }

    if (dev.kind === 'internet' && isPrivate(pkt.dst)) {
      return drop(`${fmtIp(pkt.dst)} 是私有 IP，在網際網路上無法路由（上一台路由器把它交給了預設路由 — 是不是少了通往這個網段的路由或 VPN？）`);
    }

    // 自己送出的封包：ping vrf X 指定的 VRF 只套用在發出 ping 的那一台（回應的那一台用它自己的全域路由表）
    const vrfNow = inIf ? vrfOf(inIf) : dev.id === ctx.vrfDev ? ctx.vrf : '';
    // 政策路由：介面上的 ip policy route-map（路由器自己送出的封包看 ip local policy route-map）先決定下一站，沒有符合才查路由表
    const pbrName = cloud ? null : inIf ? inIf.policyRm : dev.localPolicy;
    const route = (pbrName && pbrRoute(dev, pbrName, pkt, vrfNow, log)) || (cloud ? cloud.out : lookupRoute(dev, pkt.dst, pkt.src, vrfNow));
    if (!route) {
      D('packet', `IP: s=${fmtIp(pkt.src)} (${inIf ? longIf(inIf.label) : 'local'}), d=${fmtIp(pkt.dst)}, len ${ipLen(pkt)}, unroutable`);
      return drop(noRouteReason(state, dev, pkt.dst));
    }
    const outIf = route.iface;
    const nh = route.via ?? pkt.dst;
    // 路由器自己送出的封包才會出現在 debug ip packet；經過它轉送的封包由 CEF 處理，不會出現
    if (!inIf) D('packet', `IP: s=${fmtIp(pkt.src)} (local), d=${fmtIp(pkt.dst)} (${longIf(outIf.label)}), len ${ipLen(pkt)}, sending`);


    if (inIf && !established && ctx.mid && dev.kind === 'firewall') return lostSession();
    T('vf_ip_route_input_common', `find a route: flag=04000000 gw-${fmtIp(nh)} via ${outIf.id}`);
    if (inIf && !established) {
      const v = filter(dev, inIf, outIf, pkt, dnat);
      T('fw_forward_handler', v.ok ? `Allowed by Policy-${v.rule || 0}:${v.nat ? ' SNAT' : ''}` : `Denied by forward policy check (policy ${v.rule || 0})`);
      if (stateful && !ctx.mid) sess(dev, { act: v.ok ? 'allow' : 'deny', proto: pkt.proto, ...o, rule: v.rule || 0, inIf: inIf.label, outIf: outIf.label });
      if (!v.ok) { denyLog(state, dev, pkt, o, inIf, outIf, v.rule); return drop(v.reason); }
      if (v.rule) log.push({ dev: dev.id, kind: 'fwd', text: `符合政策 #${v.rule}，放行（${inIf.label} → ${outIf.label}）` });
      if (!pkt.reply) {
        let nSrc = pkt.src;
        const st = (dev.staticNat || []).find((x) => parseIp(x.priv || '') === pkt.src && outIf.rt.vips.includes(parseIp(x.pub || '')));
        if (st) nSrc = parseIp(st.pub); // 靜態 NAT 的主機固定用自己的公用 IP 出去
        else if (v.nat && outIf !== inIf && outIf.rt.ip != null && natPermits(dev, outIf, pkt)) {
          // ESP（IP 協定 50）沒有連接埠號碼：PAT（多對一）沒辦法替它轉換。家用路由器多半有「IPsec passthrough」可以讓一條通過
          if (pkt.proto === 'esp' && !pkt.ssl && dev.kind !== 'homerouter') return drop(`${dev.name} 做的是 PAT（多個位址共用 ${outIf.label} 的位址）：ESP 封包沒有連接埠號碼，PAT 沒辦法替它轉換，只好丟掉。中間有 NAT 時兩端都要用 NAT-T（ESP 包在 UDP 4500 裡）`);
          nSrc = outIf.rt.ip;
        }
        if (nSrc !== pkt.src || dnat || stateful) {
          track(state, ctx, dev, { proto: pkt.proto, ...o, nSrc, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport, inIf: inIf.label, outIf: outIf.label, rule: v.rule || 0 });
        }
        if (nSrc !== pkt.src) {
          T('__ip_session_run_tuple', `SNAT ${fmtIp(pkt.src)}->${fmtIp(nSrc)}:${pkt.sport}`);
          sess(dev, { act: 'snat', proto: pkt.proto, src: pkt.src, sport: pkt.sport, nsrc: nSrc, dst: pkt.dst, dport: pkt.dport });
          log.push({ dev: dev.id, kind: 'nat', text: `NAT：來源位址 ${fmtIp(pkt.src)} 換成 ${fmtIp(nSrc)}（${outIf.label}）` });
          pkt.src = nSrc;
        }
      }
    }
    if (inIf) {
      const deny = aclCheck(outIf.aclOut, pkt);
      if (deny) return drop(`${dev.name} 的 ${outIf.label}（離開方向）：${deny}`);
    }
    // TCP 的 SYN / SYN-ACK 經過時記下 MSS 的上限（ip tcp adjust-mss、家用路由器自動調整）
    if (pkt.proto === 'tcp' && !pkt.ack && !pkt.bulk) ctx.mssClamp = Math.min(ctx.mssClamp ?? Infinity, mssClampOf(state, dev, inIf, outIf));
    {
      const m = ipMtu(state, dev, outIf), len = ipLen(pkt);
      if (len > m) {
        if (pkt.df && !inIf && pkt.bulk) {
          pkt.len = m; // 自己送的 TCP 資料：作業系統知道自己的介面 MTU，一開始就送小一點
        } else if (pkt.df) {
          const reason = !inIf ? `封包 ${len} 位元組比 ${dev.name} 自己的 ${outIf.label} 的 MTU（${m}）還大，又設了 DF（不可分段）：在本機就送不出去`
            : `${dev.name} 要從 ${outIf.label}（MTU ${m}）送出 ${len} 位元組的封包，但封包設了 DF（不可分段）：丟掉，並回報 ICMP「需要分段」`;
          log.push({ dev: dev.id, kind: 'drop', text: reason });
          if (!inIf) return { ok: false, dev: dev.id, local: true, mtu: m, reason };
          return { ok: false, dev: dev.id, reason, ptb: { at: dev.id, mtu: m, vrf: vrfOf(inIf), pkt: { ...pkt } } };
        } else {
          const n = Math.ceil((len - 20) / (m - 20));
          log.push({ dev: dev.id, kind: 'info', text: `分段：${len} 位元組的封包超過 ${outIf.label} 的 MTU ${m}，切成 ${n} 片送出（到了目的地再組回來）` });
          pkt.len = m;
        }
      }
    }

    // Tunnel 介面：GRE 再包一層 IP 標頭送給對面（mGRE 靠 NHRP 找出對面的 NBMA 位址）；VTI 直接用 IPsec 加密
    if (isTun(outIf)) {
      const mode = tunMode(outIf);
      if (mode === 'mgre' && inIf && inIf === outIf) nhrpRedirect(state, ctx, dev, outIf, pkt, ctx.greFrom, nh);
      if (mode === 'ipsec') {
        const T = dev.rt.tunnels.find((t) => t.tif === outIf.id);
        if (!T || !T.up) return drop(`${dev.name} 的 ${outIf.label} 沒有 IPsec SA：${T ? T.why : '找不到 tunnel protection 的設定'}`);
        log.push({ dev: dev.id, kind: 'vpn', text: `加密（VTI）：路由指向 ${outIf.label}，整個封包包進 ESP，外層位址 ${fmtIp(T.localIp)} → ${fmtIp(T.peerIp)}` });
        const r = forward(state, ctx, dev.id, { ...(T.natT ? { proto: 'udp', sport: 4500, dport: 4500, natt: true } : { proto: 'esp', sport: 0, dport: 0 }), src: T.localIp, dst: T.peerIp, ttl: 64, reply: pkt.reply, outer: true, spi: hash(dev.id + '/' + T.name), len: ipLen(pkt) + IPSEC_OVERHEAD + (T.natT ? 8 : 0) });
        if (!r.ok) return r;
        if (!r.tun) return drop(`${state.devices[r.dev].name} 收到了 ESP 封包，但沒有對應的 IPsec SA`);
        if (!QUIET) { const a = state.dyn.sa[dev.id + '/' + T.name], b = state.dyn.sa[r.dev + '/' + r.tun.name]; if (a) a.tx++; if (b) b.rx++; }
        dev = state.devices[r.dev];
        inIf = r.tun.iface;
        log.push({ dev: dev.id, kind: 'vpn', text: `解密：還原出內層封包 ${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}（從 ${inIf.label} 進來）` });
        continue;
      }
      const g = greTarget(state, ctx, dev, outIf, nh, pkt);
      if (g.drop) return drop(g.drop);
      const src = outIf.rt.tun.src, key = outIf.tun.key != null && outIf.tun.key !== '' ? +outIf.tun.key : null;
      log.push({ dev: dev.id, kind: 'vpn', text: `GRE 封裝：從 ${outIf.label} 送出，外面再包一層 ${fmtIp(src)} → ${fmtIp(g.nbma)}（IP 協定 47${key != null ? `，key ${key}` : ''}）${g.viaHub ? '，先送給 hub' : ''}。GRE 本身不加密，裡面的封包沿路都看得到` });
      const r = forward(state, ctx, dev.id, {
        proto: 'gre', src, dst: g.nbma, sport: 0, dport: 0, ttl: 255, reply: pkt.reply, outer: true, greKey: key, len: ipLen(pkt) + GRE_OVERHEAD,
        gre: { key, inner: { proto: pkt.proto, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport, reply: !!pkt.reply, ttl: pkt.ttl } },
      });
      if (!r.ok) return r;
      if (!r.gre) return drop(`${state.devices[r.dev].name} 收到 GRE 封包，但沒有交給任何 Tunnel 介面`);
      ctx.greFrom = { dev: dev.id, iface: outIf.id };
      dev = state.devices[r.dev];
      inIf = r.gre;
      log.push({ dev: dev.id, kind: 'vpn', text: `GRE 解封裝：拿掉外層標頭，還原出 ${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}（從 ${inIf.label} 進來）` });
      continue;
    }

    const eps = l2Explore(state, dev.id, outIf);
    if (eps.storm) return drop(`廣播風暴！${state.devices[eps.storm].name} 所在的網段形成了迴圈，訊框不斷繞圈把網路塞爆`);
    const cands = eps.filter((e) => e.iface.rt.ip === nh || e.iface.rt.vips.includes(nh));
    let tgt = null, dai = null;
    for (const e of cands) {
      const blk = daiBlock(state, e.path, outIf, e.iface);
      if (!blk) { tgt = e; break; }
      dai ||= blk;
    }
    // 真實網路裡，第一次要和某個 IP 通訊前得先用 ARP 廣播問出它的 MAC；問到之後會記在 ARP 快取裡
    const cache = (state.dyn.arp[dev.id] ||= {});
    const known = cache[nh];
    // 快取裡有、還沒過期、而且那個 MAC 現在仍然是這個 IP 的主人，才不用重新詢問
    const needArp = !(known && state.clock - known.t < arpTtl(dev) && cands.some((e) => answerMac(e, nh) === known.mac));
    if (needArp) {
      log.push({ dev: dev.id, kind: 'arp', text: `ARP 廣播：誰是 ${fmtIp(nh)}？同一個廣播網域的每台設備都會收到` });
      const wave = buildWave(eps);
      if (wave.length) hops.push({ wave, proto: 'arp' });
      for (const e of eps) learnPath(state, e.path, outIf.rt.mac); // 廣播經過的每一台交換器都學到發問者的 MAC
      if (!QUIET) {
        const req = { proto: 'arp', smac: outIf.rt.mac, dmac: BCAST, arp: { op: 1, sip: outIf.rt.ip, tip: nh, sha: outIf.rt.mac } };
        for (const lvl of wave) for (const x of lvl) onHop(state, x, req, null);
      }
    }
    if (!tgt) return drop(dai || arpFail(state, dev, outIf, nh, route.via != null, eps));
    const tmac = answerMac(tgt, nh);
    if (!needArp) known.t = state.clock; // 有流量在走，項目就會一直被確認、不會過期
    if (needArp) {
      cache[nh] = { mac: tmac, t: state.clock, i: outIf.id };
      if (outIf.rt.ip != null) (state.dyn.arp[tgt.dev] ||= {})[outIf.rt.ip] = { mac: outIf.rt.mac, t: state.clock, i: tgt.iface.id }; // 被問的那一方也順便記下發問者
      log.push({ dev: tgt.dev, kind: 'arp', text: `ARP 回覆：${fmtIp(nh)} 的 MAC 位址是 ${tmac}${tmac === VRRP_MAC ? '（VRRP 的虛擬 MAC）' : ''}（${dev.name} 記入 ARP 快取）` });
      for (const h of [...tgt.path].reverse()) hops.push({ cable: h.cable, wifi: h.wifi, from: h.to, to: h.from, tag: h.tag, reply: true, proto: 'arp' });
      learnPath(state, reversed(tgt.path), tmac); // ARP 回覆是單點傳送：沿路的交換器學到回覆者的 MAC
      if (!QUIET) {
        const rep = { proto: 'arp', smac: tmac, dmac: outIf.rt.mac, arp: { op: 2, sip: nh, tip: outIf.rt.ip, sha: tmac } };
        for (const x of reversed(tgt.path)) onHop(state, x, rep, null);
      }
    }
    if (cands.length > 1 && !dai) {
      log.push({ dev: dev.id, kind: 'info', text: `注意：這個網段上有 ${cands.length} 台設備都聲稱自己是 ${fmtIp(nh)}（IP 衝突或 ARP 欺騙），封包被送往最先回應的 ${state.devices[tgt.dev].name}` });
    }
    let giant = null;
    {
      const len = ipLen(pkt);
      for (let k = 0; k < tgt.path.length && len > 1500; k++) {
        const h = tgt.path[k], to = state.devices[h.to], last = k === tgt.path.length - 1;
        let lim = h.wifi ? WIFI_MTU : Infinity;
        if (!last) {
          lim = Math.min(lim, l2Mtu(state, to, h.toPort));
          if (isNexus(to)) lim = Math.min(lim, l2Mtu(state, to, tgt.path[k + 1].fromPort)); // Nexus 每個埠各自的 MTU：出去的埠也要夠大
        } else lim = Math.min(lim, rxMtu(state, to, tgt.iface));
        if (len > lim) { giant = { k, lim, to, port: h.toPort }; break; }
      }
    }
    const path = giant ? tgt.path.slice(0, giant.k + 1) : tgt.path;
    const names = [dev.name, ...path.map((h) => state.devices[h.to].name)];
    const tags = [...new Set(path.map((h) => h.tag).filter((t) => t != null))];
    log.push({
      dev: dev.id, kind: 'l2',
      text: (route.via != null ? `查路由 → 下一站 ${fmtIp(nh)}：` : '') + names.join(' → ') + (tags.length ? `　[802.1Q VLAN ${tags.join(',')}]` : '')
        + (tgt.path.some((h) => h.wifi) ? '　[Wi-Fi]' : ''),
      // 這一段第二層旅程上的訊框內容，給「封包檢視」用
      frame: { smac: outIf.rt.mac, dmac: tmac, tags, src: pkt.src, dst: pkt.dst, ttl: pkt.ttl, proto: pkt.proto, sport: pkt.sport, dport: pkt.dport, reply: pkt.reply, ack: !!pkt.ack, ssl: !!pkt.ssl, wifi: tgt.path.some((h) => h.wifi), ...(pkt.gre ? { gre: pkt.gre } : {}), ...(pkt.natt ? { natt: true } : {}) },
    });
    // 沿路的交換器從進來的埠學到來源 MAC。目的 MAC 不在表裡（太久沒看到而過期）的話，只能往整個 VLAN 泛洪
    const keys = learnPath(state, path, outIf.rt.mac);
    let leaked = false, flooded = false;
    path.forEach((h, n) => {
      const hub = hubLeak(state, tgt.path, n);
      let leak = hub;
      const sw = state.devices[h.from];
      if (n > 0 && !h.wifi && learns(sw) && keys[n - 1] != null && !macKnown(state, sw, keys[n - 1], tmac)) {
        const extra = floodPorts(state, sw, keys[n - 1], tgt.path[n - 1].toPort, h.fromPort);
        if (extra.length) leak = [...(leak || []), ...extra];
        if (!flooded) {
          flooded = true;
          log.push({ dev: sw.id, kind: 'info', text: `${sw.name} 的 MAC 位址表裡沒有 ${tmac}（超過 ${macAgeOf(sw)} 秒沒看到它送出的訊框，項目已經過期）：不知道它在哪個埠，只好送往這個 VLAN 的每一個埠 (unknown unicast flooding)。對方一回覆，交換器就會重新學起來` });
        }
      }
      if (hub && !leaked) {
        leaked = true;
        log.push({ dev: h.from, kind: 'info', text: `${state.devices[h.from].name} 是 Hub：訊框被複製到其他所有連接埠，${leak.map((x) => state.devices[x.to].name).join('、')} 也收到了，發現不是給自己的就丟棄` });
      }
      hops.push({ ...h, reply: pkt.reply, proto: pkt.proto, ssl: !!pkt.ssl, leak, ...(pkt.natt ? { natt: true } : {}) });
      if (!QUIET) {
        onHop(state, h, {
          proto: pkt.proto, smac: outIf.rt.mac, dmac: tmac, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport, ttl: pkt.ttl,
          reply: !!pkt.reply, ack: !!pkt.ack, ssl: !!pkt.ssl, data: pkt.data || null, spi: pkt.spi, ...(pkt.gre ? { gre: pkt.gre } : {}), ...(pkt.natt ? { natt: true } : {}),
          ...(pkt.len ? { len: pkt.len } : {}), ...(pkt.df ? { df: true } : {}), ...(pkt.bulk ? { bulk: true } : {}), ...(pkt.icmpErr ? { icmpErr: pkt.icmpErr, mtu: pkt.mtu } : {}),
        }, leak);
      }
    });
    if (giant) {
      // 第二層的設備不會回 ICMP：送的人只會一直等到逾時
      if (!QUIET) countGiant(state, giant.to.id, giant.port);
      const pl = (giant.to.ports.find((p) => p.id === giant.port) || {}).label || giant.port || '';
      const who = giant.to.kind === 'host' || giant.k === tgt.path.length - 1 ? `${giant.to.name} 的網卡` : giant.to.name;
      const reason = `${who}（${pl}）收到 ${ipLen(pkt) + 14} 位元組的訊框，超過它能收的 MTU ${giant.lim}：當成 giant 直接丟掉。第二層的設備不會回報 ICMP，送的人完全不知道，只能等到逾時`;
      log.push({ dev: giant.to.id, kind: 'drop', text: reason });
      return { ok: false, dev: giant.to.id, reason, l2: true, mtu: giant.lim };
    }
    dev = state.devices[tgt.dev];
    inIf = tgt.iface;
  }
  return drop('封包繞了太多站仍未抵達（路由迴圈）');
}

// ───────────────────── 連線紀錄、命中次數、廣播 ─────────────────────

// ── 連線表：防火牆的 session、路由器的 NAT 轉換 ──
// 每一筆都有閒置逾時：沒有新的封包經過，時間到就從表裡移除。
const SESSION_TTL = {
  // 路由器 (IOS)：ip nat translation 的預設值
  router: { tcp: 86400, syn: 60, fin: 60, udp: 300, dns: 60, icmp: 60 },
  // FortiGate：session-ttl 預設 3600 秒、UDP 180 秒、半開的連線 10 秒
  firewall: { tcp: 3600, syn: 10, fin: 120, udp: 180, dns: 180, icmp: 60 },
  // 家用路由器
  homerouter: { tcp: 1800, syn: 120, fin: 120, udp: 180, dns: 180, icmp: 30 },
};
/** 這一筆連線可以閒置多久（秒）。可以用 ip nat translation … 或 config system session-ttl 調整 */
export function sessionTtl(dev, e) {
  const base = SESSION_TTL[dev.kind] || SESSION_TTL.router, o = dev.natTimeout || {};
  const k = e.proto === 'tcp' ? (e.st === 'est' ? 'tcp' : e.st === 'fin' ? 'fin' : 'syn') : e.proto === 'udp' ? (e.dport === 53 ? 'dns' : 'udp') : 'icmp';
  return +o[k] > 0 ? +o[k] : base[k];
}
function track(state, ctx, dev, e) {
  (ctx.ct[dev.id] ||= []).push(e);
  if (QUIET) return;
  e.t0 = e.t = state.clock;
  e.st = e.proto === 'tcp' ? (ctx.mid ? 'est' : 'syn') : 'new';
  if (ctx.cid) e.cid = ctx.cid; // 屬於哪一條長時間保持的連線（SSH / Telnet）
  const tbl = (state.dyn.ct[dev.id] ||= []);
  tbl.push(e);
  if (tbl.length > 200) tbl.shift();
}
/** 連線表目前的內容（過期的不算），最新的在前面。left 是還能閒置幾秒 */
export function sessionRows(state, dev) {
  const now = state.clock;
  return ((state.dyn && state.dyn.ct && state.dyn.ct[dev.id]) || [])
    .map((e) => { const ttl = sessionTtl(dev, e); return { ...e, ttl, left: Math.ceil(ttl - (now - e.t)), age: Math.floor(now - e.t0) }; })
    .filter((e) => e.left > 0).reverse();
}
/** clear ip nat translation * / diagnose sys session clear */
export function clearSessions(state, dev) { if (state.dyn && state.dyn.ct) delete state.dyn.ct[dev.id]; }


/** 把廣播會走到的每一段線，依距離分層（給動畫一波一波播放） */
export function buildWave(eps) {
  const levels = [], seen = new Set();
  for (const e of eps) {
    e.path.forEach((h, n) => {
      const k = (h.cable || 'air:' + h.from + ':' + h.to) + '>' + h.to;
      if (seen.has(k)) return;
      seen.add(k);
      (levels[n] ||= []).push({ cable: h.cable, wifi: h.wifi, from: h.from, fromPort: h.fromPort, to: h.to, toPort: h.toPort, tag: h.tag });
    });
  }
  return levels.filter(Boolean);
}

/** Hub 不看位址：訊框從它送出時，其他有接線的埠也會收到一份 */
function hubLeak(state, path, n) {
  const h = path[n], hub = state.devices[h.from];
  if (!hub || hub.kind !== 'hub') return undefined;
  const inPort = n > 0 ? path[n - 1].toPort : null;
  const out = [];
  for (const p of hub.ports) {
    if (p.id === h.fromPort || p.id === inPort) continue;
    const l = state.rt.links[hub.id + ':' + p.id];
    if (l) out.push({ cable: l.cable, from: hub.id, to: l.dev });
  }
  return out.length ? out : undefined;
}
