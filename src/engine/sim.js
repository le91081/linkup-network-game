// 網路模擬引擎
// L1 供電 / 連線狀態、L2 橋接 / VLAN / STP / LACP / Port Security / DHCP Snooping / Wi-Fi、
// L3 路由 / OSPF / VRRP、DHCP（含 Relay）、PPPoE、NAT、ACL、防火牆政策、IPsec 與遠端存取 VPN、DNS
// 依層級拆在 engine/sim/ 底下：core（共用）、phys（供電、連線、STP）、l2（VLAN、MAC、ARP）、wifi、l3（DHCP、VRRP、路由表）、
// tunnels（VPN）、auth（802.1X、DAI）、forward（逐站轉送）、transact（一次請求 + 回應）、resolve（DNS）、objectives（任務目標）、bandwidth（頻寬）。
// 這個檔案留下「重新計算」與模擬時鐘，並匯出各模組對外公開的函式：其他程式一律 import 這裡。
import { CATALOG } from './model.js';
import { UPTIME0, logEvent, opsAfter, opsBefore } from './ops.js';
import { background } from './wire.js';
import { cdpOn } from './disc.js';
import { fmtIp, hostAddrProblem, netOf, parseIp, parseMask, sameNet } from './ip.js';
import { phoneTick } from './voice.js';
import { prepTimeRanges } from './timerange.js';
import { prepCloud } from './cloud.js';
import { recompute6 } from './sim6.js';
import { setCdpCheck } from './qos.js';
import { slaTick, trackTick } from './track.js';
import { syncVsw } from './virt.js';
import { acquire, leaseLen, ospfOn, prepVrrp, relayPass, routesAll } from './sim/l3.js';
import { capwapTick, prepWifi, wlcVlans } from './sim/wifi.js';
import { computeAuth } from './sim/auth.js';
import { dnsList, hash, ifaceMac, isVlanSw, vrfOf } from './sim/core.js';
import { flowsTick } from './sim/bandwidth.js';
import { ifaceActive, isBridgePort, l2Explore, macAgeOf, prepL2Attacks } from './sim/l2.js';
import { prepMcast } from './sim/mcast.js';
export { isMcast, snoopOn, querierOf } from './sim/mcast.js';
import { prepDtp, prepLag, prepPhysical, prepStp, prepStpTimers, prepVoice, stpTopologyChange } from './sim/phys.js';
import { prepTunnels } from './sim/tunnels.js';
import { sessionTtl } from './sim/forward.js';
import { scriptTick } from './script.js';
import { prepHa, haIdle, haMacs } from './ha.js';
import { prepVtp } from './vtp.js';
import { prepPower } from './power.js';
export { portalPending, portalAccept } from './portal.js';
import { transact } from './sim/transact.js';
setCdpCheck((d, pid, x, xp) => cdpOn(d, pid) && cdpOn(x, xp));

export { clearSessionLog, fmtDur, hitsOf, ifaceMac, isTrunk, macOf, pbrHits, sessionLog, vrfOf } from './sim/core.js';
export { MAC_AGE, VRRP_MAC, arpRows, clearArp, clearMac, ifaceActive, isBridgePort, l2Explore, macAgeOf, macRows, macsBehind, vlanAllowed } from './sim/l2.js';
export { ERR_CAUSES, ERR_RECOVERY_DEFAULT, bouncePort, dtpSpeaker, errRecoverSecs, errdisRows, poeTable, portfastOn } from './sim/phys.js';
export { CAPWAP_JOIN, WALL_MATS, WIFI_SEC, apRange, rfAt, ssidsOf, visibleSsids, wallsBetween, wlansOf, CH5, DFS, blockOf, apChannel, CH6, on6, has6 } from './sim/wifi.js';
export { DEFAULT_LEASE, dhcpRelease, dhcpRenew, dhcpTrace, lookupRoute, ospfOn, routeRows, routesTo, setOspf } from './sim/l3.js';
export { IKE_TIME, P1, P2, ikeVer, pskOf, saInfo } from './sim/tunnels.js';
export { GRE_OVERHEAD, MODE_TEXT, NHRP_HOLD, isTun, nhrpCache, tunMode, tunOverhead } from './sim/gre.js';
export { SERVICE_NAMES, accessOf, clearSessions, forward, sessionRows, sessionTtl, svcMatch, unreachOf } from './sim/forward.js';
export { closeFlow, flowSend, transact } from './sim/transact.js';
export { dnsQuery, dualStack, resolveName } from './sim/resolve.js';
export { evaluate, runObjective } from './sim/objectives.js';
export { dirKeyOf, linkCap, linkUtil, throughput } from './sim/bandwidth.js';

// ───────────────────────── 模擬時鐘 ─────────────────────────
// state.clock 是從關卡開始算起的秒數。state.dyn 是「需要時間才會改變」的狀態，跨次計算保留下來：
// 連接埠什麼時候啟用、OSPF 鄰居什麼時候建立、DHCP 租約什麼時候到期、ARP 快取什麼時候學到。
// 關卡一開始的狀態當作已經運作很久（全部收斂完成），之後的變動才需要等待。

/** 讓模擬時間前進 secs 秒，再重新計算網路的狀態 */
export function advance(state, secs) {
  state.clock = (state.clock || 0) + Math.max(0, secs);
  return recompute(state);
}
/** 還沒走完的收斂計時（STP、OSPF、VRRP），最快完成的排在前面 */
export const pendingOf = (state) => ((state.rt && state.rt.pending) || []).slice().sort((a, b) => a.at - b.at);
/** 重新計算，並讓時間前進到網路穩定為止（最多前進 max 秒） */
export function settle(state, max = 300) {
  recompute(state);
  const end = state.clock + max;
  for (let n = 0; n < 400; n++) {
    const p = pendingOf(state)[0];
    if (!p || p.at > end) break;
    state.clock = Math.max(state.clock, p.at);
    recompute(state);
  }
  return state;
}
// ───────────────────────────── 重新計算 ─────────────────────────────


/** 設定或接線變動後呼叫：重新計算所有執行期狀態 */
/** IP SLA 的 icmp-echo：從 source-interface 的位址送一次 ping（不記入封包紀錄） */
function slaProbe(state, d, op) {
  const dst = parseIp(op.dst || '');
  if (dst == null) return { ok: false, rtt: 0, code: 'Format error' };
  let srcIp;
  if (op.src) {
    const i = d.ifaces.find((x) => x.id === op.src);
    if (!i || i.rt.ip == null || !i.rt.link) return { ok: false, rtt: 0, code: 'No connection' };
    srcIp = i.rt.ip;
  }
  const r = transact(state, d.id, { proto: 'icmp', dst, srcIp, quiet: true });
  return r.ok ? { ok: true, rtt: Math.max(1, Math.round((r.hops || []).length * 2.5)), code: 'OK' } : { ok: false, rtt: 0, code: 'Timeout' };
}

export function recompute(state) {
  if (typeof state.clock !== 'number') state.clock = 0;
  if (!state.dyn) state.dyn = { boot: true }; // 第一次計算：目前的狀態當作已經運作很久
  for (const k of ['port', 'adj', 'lsa', 'vrrp', 'lease', 'hold', 'arp', 'mac', 'ct', 'sa', 'clk', 'log', 'syslog', 'ev', 'vty', 'login']) state.dyn[k] ||= {};
  // 擷取到的封包、命令列上的輸出可能很多，而且和這次計算無關：先拿出來，算完再放回去
  const side = {};
  for (const k of ['cap', 'con']) if (state.dyn[k]) { side[k] = state.dyn[k]; delete state.dyn[k]; }
  // 關卡劇本：時間到了的事件（線路被挖斷、修好）先套用到網路上
  if (!state.dyn.boot) scriptTick(state);
  // 還在開機的設備：這一次計算把它當成關機（沒有燈號、不轉送、不回應），算完再把 state.down 還原
  wlcVlans(state);
  for (const d of Object.values(state.devices)) if (d.kind === 'hypervisor') syncVsw(d); // 連接埠群組 → vSwitch 的 VLAN
  // 光纖數據機的橋接模式：PON 埠併進 LAN 的橋接，自己的介面都停用（撥接、NAT、DHCP 交給後面的路由器）
  for (const d of Object.values(state.devices)) if (d.ont && d.sw) { if (d.ont.bridge) d.sw.ports.wan ||= {}; else delete d.sw.ports.wan; }
  const booting = opsBefore(state), realDown = state.down, ids = Object.keys(booting);
  if (ids.length) state.down = { ...(realDown || {}), ...Object.fromEntries(ids.map((id) => [id, true])) };
  try {
    let auth = { dot1x: {}, ent: {} };
    const passes = () => {
      // 802.1X 可能要算好幾輪。前幾輪只是試算，計時的狀態以最後一輪為準，所以每一輪都從同一份起點開始
      const dyn0 = JSON.stringify(state.dyn);
      for (let round = 0; round < 3; round++) {
        if (round) state.dyn = JSON.parse(dyn0);
        computePass(state, auth);
        const next = computeAuth(state);
        if (JSON.stringify(next) === JSON.stringify(auth)) break;
        auth = next; // 802.1X 的結果改變了連接埠的狀態，要重算一次
      }
    };
    passes();
    // 輕量型 AP 加入或離開 WLC 之後，它放送的 SSID 跟著改變：用新的狀態再算一輪，用戶端才會連上 / 斷線
    if (capwapTick(state)) { passes(); capwapTick(state); }
    // IP SLA：用剛算好的路由真的探測一次。結果改變了（追蹤它的靜態路由、HSRP 優先權跟著變），再算一輪
    for (let k = 0; k < 3 && slaTick(state, (d, op) => slaProbe(state, d, op)); k++) passes();
    trackTick(state, logEvent);
    if (state.v6) recompute6(state);
    state.rt.booting = booting;
    for (const id of ids) if (isFinite(booting[id])) state.rt.pending.push({ at: state.clock + booting[id], dev: id, kind: 'boot', text: `${state.devices[id].name}：開機中` });
    state.rt.rommon = Object.fromEntries(ids.filter((id) => !isFinite(booting[id])).map((id) => [id, state.dyn.clk[id].rommon.why]));
    Object.assign(state.dyn, side);
    phoneTick(state); // IP 電話的註冊（通話要用到）
    // 背景流量先算進計數器，網管伺服器這一輪的輪詢才看得到
    // 多點傳送：要等路由算好（PIM 的 RPF 檢查看單點傳送的路由表）
    prepMcast(state);
    state.rt.ltmOk = true; // 路由算好了：負載平衡器的健康檢查從這裡開始算一次就留著用
    background(state, { isBridge: isBridgePort, ospfOn, uptime0: UPTIME0 });
    flowsTick(state);
    opsAfter(state);
  } finally {
    if (realDown === undefined) delete state.down; else state.down = realDown;
  }
  delete state.dyn.boot;
  return state;
}

function computePass(state, auth) {
  const devs = Object.values(state.devices);
  const down = state.down || {};
  state.rt = { links: {}, off: {}, clients: {}, cable: {}, why: {}, auth, wait: {}, pending: [] };
  for (const d of devs) {
    d.rt = { routes: [], nbrs: [], tunnels: [], lag: {}, err: {}, stp: null, interf: [], vpn: null, unauth: null, wait: {}, dtp: null, voice: null };
    if (isVlanSw(d)) {
      for (const [pid, pc] of Object.entries(d.sw.ports)) {
        const a = auth.dot1x[d.id + ':' + pid];
        if (pc.dot1x && !(a && a.ok)) (d.rt.unauth ||= {})[pid] = (a && a.why) || '等待 802.1X 驗證';
      }
    }
    for (const i of d.ifaces) {
      i.rt = { ip: null, bits: 0, gw: null, dns: [], src: null, note: '', active: ifaceActive(d, i), link: true, mac: ifaceMac(d, i), vips: [], assoc: null };
    }
  }
  prepTimeRanges(state); // time-range：哪些 ACL 規則現在不在時間內
  prepPower(state); // 電源供應器全部沒電的設備：當作關機
  prepPhysical(state);
  prepDtp(state);
  prepVtp(state); // VTP：Trunk 協商好之後，同一個網域的交換器同步 VLAN 資料庫
  prepVoice(state);
  prepLag(state);
  prepStp(state);
  prepStpTimers(state);
  prepWifi(state);
  // FortiGate 的 HA：選出主要機、把設定同步給次要機（要先知道每個埠的燈號）
  prepHa(state, (d, i) => ({ ip: null, bits: 0, gw: null, dns: [], src: null, note: '', active: ifaceActive(d, i), link: true, mac: ifaceMac(d, i), vips: [], assoc: null }));
  for (const d of devs) {
    const dead = down[d.id] || state.rt.off[d.id];
    for (const i of d.ifaces) {
      const b = i.bind;
      if (dead) i.rt.link = false;
      else if (b.t === 'port' || b.t === 'sub') i.rt.link = !!state.rt.links[d.id + ':' + b.port];
      else if (b.t === 'wlan') i.rt.link = !!i.rt.assoc;
      else if (b.t === 'loop') i.rt.link = !i.shut;
      else if (b.t === 'gre') i.rt.link = false; // Tunnel 的 line protocol 等外層的路由算好才知道（sim/l3.js 的 routesAll）
      if (haIdle(d, i)) { i.rt.active = false; i.rt.note = 'HA 的次要機：這個介面由主要機運作，次要機不回應、不轉送'; continue; }
      if (!i.rt.active || i.mode !== 'static') continue;
      const ip = parseIp(i.ip), bits = parseMask(i.mask);
      if (ip == null || bits == null) continue;
      const prob = hostAddrProblem(ip, bits);
      if (prob) { i.rt.note = prob; continue; }
      // 路由器、L3 交換器、防火牆：同一個路由表 (VRF) 裡不能有重疊的網段，IOS 會直接拒絕這個位址
      if (d.kind === 'router' || d.kind === 'l3switch' || d.kind === 'firewall') {
        const clash = d.ifaces.find((x) => x !== i && x.rt.ip != null && vrfOf(x) === vrfOf(i) && sameNet(ip, x.rt.ip, Math.min(bits, x.rt.bits)));
        if (clash) {
          i.rt.note = `${fmtIp(netOf(ip, bits))}/${bits} 和 ${clash.label} 的網段重疊，這個位址沒有生效（IOS：% ${fmtIp(netOf(ip, bits))} overlaps with ${clash.label}）。同一個路由表裡網段不能重疊；真的要重疊，就把它們放進不同的 VRF`;
          continue;
        }
      }
      Object.assign(i.rt, { ip, bits, src: 'static', gw: parseIp(i.gateway), dns: dnsList(i.dns) });
    }
  }
  for (const d of devs) {
    for (const n of d.staticNat || []) {
      const pub = parseIp(n.pub || '');
      const i = pub != null && d.ifaces.find((x) => x.rt.ip != null && x.rt.ip !== pub && sameNet(pub, x.rt.ip, x.rt.bits));
      if (i) i.rt.vips.push(pub); // 讓這個介面替靜態 NAT 的公用 IP 回應 ARP
    }
    // 連接埠轉發 (VIP) 指定了對外的位址：FortiGate 預設也替它回應 ARP (arp-reply enable)
    for (const f of d.portForwards || []) {
      const pub = parseIp(f.extIp || '');
      const i = pub != null && d.ifaces.find((x) => x.rt.ip != null && x.rt.ip !== pub && sameNet(pub, x.rt.ip, x.rt.bits));
      if (i && !i.rt.vips.includes(pub)) i.rt.vips.push(pub);
    }
    // 負載平衡器的 virtual address：BIG-IP 預設替它回應 ARP
    for (const v of (d.ltm && d.ltm.virtuals) || []) {
      const pub = parseIp(v.dst || '');
      const i = pub != null && d.ifaces.find((x) => x.rt.ip != null && x.rt.ip !== pub && sameNet(pub, x.rt.ip, x.rt.bits));
      if (i && !i.rt.vips.includes(pub)) i.rt.vips.push(pub);
    }
    // NAT 位址池：落在 ip nat outside 介面網段裡的位址，也由那個介面回應 ARP
    for (const p of Object.values(d.natPools || {})) {
      const a = parseIp(p.start), b = parseIp(p.end);
      if (a == null || b == null || (b >>> 0) - (a >>> 0) > 4096) continue;
      for (let x = a >>> 0; x <= b >>> 0; x++) {
        const i = d.ifaces.find((y) => y.natOut && y.rt.ip != null && y.rt.ip !== x && sameNet(x, y.rt.ip, y.rt.bits));
        if (i && !i.rt.vips.includes(x)) i.rt.vips.push(x);
      }
    }
  }
  haMacs(state); // HA 的主要機：介面用叢集的虛擬 MAC
  prepL2Attacks(state); // macof 把 MAC 位址表塞滿、狂送廣播佔掉整個 VLAN 的線路
  prepCloud(state); // 雲端：彈性 IP 掛到網際網路閘道上
  const old = state.leases || {};
  state.leases = {};
  // 伺服器手上還沒到期的租約：就算用戶端現在不在線上，那個位址也不會發給別人
  const now = state.clock;
  for (const [key, tbl] of Object.entries(old)) {
    const hold = (state.dyn.hold[key] ||= {});
    for (const [ck, ip] of Object.entries(tbl)) {
      if (!state.devices[ck.slice(0, ck.indexOf('/'))]) { delete hold[ck]; continue; } // 設備已經不存在
      if (!hold[ck] || hold[ck].ip !== ip) hold[ck] = { ip, t0: now, exp: now + leaseLen(state, key) }; // 舊存檔，或關卡預先放進去的租約
      if (hold[ck].exp > now) (state.leases[key] ||= {})[ck] = ip; else delete hold[ck];
    }
    for (const ck of Object.keys(hold)) if (!(ck in tbl)) delete hold[ck];
  }
  const dyn = (i) => i.rt.active && i.rt.ip == null && !i.released && (i.mode === 'dhcp' || i.mode === 'pppoe');
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const d of devs) for (const i of d.ifaces) if (dyn(i) && acquire(state, old, d, i)) changed = true;
    if (!changed) break;
  }
  prepVrrp(state);
  routesAll(state);
  let again = relayPass(state, old);
  for (const d of devs) {
    for (const i of d.ifaces) {
      if (!dyn(i) || i.mode !== 'dhcp' || !i.rt.link) continue;
      // 這一次沒有要到位址。手上的租約還沒到期的話繼續用（伺服器暫時連不到並不會讓電腦馬上斷線）
      const ck = d.id + '/' + i.id, L = state.dyn.lease[ck];
      if (L && L.exp > now && state.devices[L.server]) {
        Object.assign(i.rt, { ip: L.ip, bits: L.bits, gw: L.gw, dns: L.dns, tftp: L.tftp || [], wlc: L.wlc || [], src: 'dhcp', server: L.server, relay: L.relay, exp: L.exp, held: i.rt.note || 'DHCP 伺服器沒有回應' });
        if (L.key) (state.leases[L.key] ||= {})[ck] = L.ip;
        again = true;
        continue;
      }
      delete state.dyn.lease[ck];
      if (d.kind !== 'host' || CATALOG[d.model].phone) continue;
      const h = hash(d.id + i.id);
      Object.assign(i.rt, { ip: parseIp(`169.254.${(h % 254) + 1}.${((h >>> 8) % 254) + 1}`), bits: 16, src: 'apipa' });
      again = true;
    }
  }
  if (again) routesAll(state);
  // IP 位址衝突：同一個廣播網域裡有另一個介面用了一樣的 IP。
  // 先數每個 IP 出現幾次：只有出現兩次以上的才需要走一遍第二層（大型拓撲時，每個介面都走一遍會變成 n²）
  const ipUse = new Map();
  for (const d of devs) for (const i of d.ifaces) if (i.rt.ip != null) ipUse.set(i.rt.ip, (ipUse.get(i.rt.ip) || 0) + 1);
  for (const d of devs) {
    for (const i of d.ifaces) {
      if (i.rt.ip == null || !i.rt.link || i.rt.src === 'apipa' || ipUse.get(i.rt.ip) < 2) continue;
      const dup = l2Explore(state, d.id, i).find((e) => e.iface.rt.ip === i.rt.ip);
      if (dup) i.rt.conflict = dup.dev;
    }
  }
  prepTunnels(state);
  // 介面斷線時，從那個介面學到的 ARP 項目會被清掉
  for (const d of devs) {
    const cache = state.dyn.arp[d.id];
    if (!cache) continue;
    for (const [ip, e] of Object.entries(cache)) {
      const i = d.ifaces.find((x) => x.id === e.i);
      if (!i || !i.rt.link || down[d.id]) delete cache[ip];
    }
  }
  // MAC 位址表：連接埠斷線時，從那個埠學到的位址馬上清掉；設備關機整張表就沒了。
  // 生成樹的拓撲一變 (Topology Change)，那個 VLAN 的交換器都會把學到的位址清掉重學
  const flush = stpTopologyChange(state);
  for (const d of devs) {
    const tbl = state.dyn.mac[d.id];
    if (tbl) {
      if (down[d.id] || state.rt.off[d.id]) delete state.dyn.mac[d.id];
      else for (const [k, e] of Object.entries(tbl)) if (now - e.t >= macAgeOf(d) || (e.port !== 'wlan' && !state.rt.links[d.id + ':' + e.port]) || flush.has(k.slice(0, k.lastIndexOf('|')))) delete tbl[k];
    }
    // 連線表：閒置太久的項目移除
    const ct = state.dyn.ct[d.id];
    if (ct) {
      if (down[d.id] || state.rt.off[d.id]) delete state.dyn.ct[d.id];
      else state.dyn.ct[d.id] = ct.filter((e) => now - e.t < sessionTtl(d, e));
    }
  }
  return state;
}
