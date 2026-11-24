// Nexus 的 vPC (virtual Port Channel)
//
// 兩台 Nexus 各自獨立（兩份設定、兩個控制平面），但對下面的交換器或伺服器來說，是「同一台」LACP 的對端：
// 下面那台的一個 Port-channel，一條接 Nexus-1、一條接 Nexus-2，兩條都在用（沒有 STP 擋掉的線，一台壞了另一條照樣通）。
//
// 設定：d.features.vpc = true（feature vpc）
//   d.vpc = { domain, keepalive: { dst, src, vrf }, prio（role priority，預設 32667，小的當 primary）, peerGw }
//   Port-channel 的成員埠：pc.vpc = 編號（interface port-channel 20 → vpc 20）；兩台之間的 peer-link：pc.peerLink = true
// 運作：
//   peer-link（兩台之間的 Port-channel）要起來，vPC 才會起來；兩台的 vPC 編號要對得上，成員埠的模式、VLAN 要一致（consistency check）
//   peer-keepalive：另一條（通常是管理網路）的心跳，用來分辨「peer-link 斷了」和「對方死了」
//     peer-link 斷了、keepalive 還在：對方還活著，secondary 把自己的 vPC 成員埠全部 suspend，避免兩邊各做各的（split brain）
//     peer-link 和 keepalive 都斷了：當作對方死了，自己繼續轉送（對方其實還活著的話就是 dual-active）
//   從 peer-link 收到的訊框，不會再從「兩邊都有成員」的 vPC 埠送出去（對方已經送過了）：vPC 的防迴圈規則
import { parseIp, sameNet, parseMask } from './ip.js';
import { macOf } from './sim/core.js';

export const VPC_PRIO = 32667;
export const vpcOn = (d) => !!(d && d.features && d.features.vpc && d.vpc && d.vpc.domain != null && d.vpc.domain !== '');
const peerLinkPorts = (d) => Object.entries(d.sw.ports).filter(([, pc]) => pc.peerLink && +pc.lag > 0).map(([pid]) => pid);
const memberPorts = (d, n) => Object.entries(d.sw.ports).filter(([, pc]) => +pc.vpc === +n && +pc.lag > 0).map(([pid]) => pid);
const sysMac = (d) => macOf(d.id, 'br', d.model);

/** 設定裡的位址在哪個介面上（用設定值，因為這一步比算位址還早）；回傳 { iface, up } */
function ownerOf(state, d, ip) {
  const a = parseIp(ip || '');
  if (a == null) return null;
  const i = d.ifaces.find((x) => parseIp(x.ip || '') === a);
  if (!i) return null;
  const port = i.bind.t === 'port' ? i.bind.port : null;
  const up = port ? !!state.rt.links[d.id + ':' + port] : Object.entries(d.sw.ports).some(([pid, pc]) => state.rt.links[d.id + ':' + pid] && (pc.mode === 'trunk' || +pc.vlan === +i.bind.vlan));
  return { iface: i, up };
}

/**
 * 在 Port-channel 協商之前：找出每台 Nexus 的 vPC 對端、peer-link 與 keepalive 的狀態、誰是 primary
 * d.rt.vpc = { peer, domain, role, peerLink, keepalive, why, susp（secondary 把 vPC 暫停了）, bad: { 編號: 不一致的原因 } }
 */
export function prepVpc(state) {
  const devs = Object.values(state.devices).filter((d) => d.sw && vpcOn(d) && !(state.down || {})[d.id]);
  for (const d of devs) d.rt.vpc = { peer: null, domain: +d.vpc.domain, role: 'none', peerLink: false, keepalive: false, why: '', susp: false, bad: {} };
  for (const d of devs) {
    const r = d.rt.vpc;
    // peer-link：自己的 peer-link 成員埠接到另一台 Nexus 的 peer-link 成員埠
    const pl = peerLinkPorts(d);
    if (!pl.length) { r.why = '沒有設定 peer-link（interface port-channel N → vpc peer-link）'; continue; }
    const ends = pl.map((pid) => state.rt.links[d.id + ':' + pid]).filter(Boolean);
    const peerDev = ends.map((e) => state.devices[e.dev]).find((x) => x && x.sw && (x.sw.ports[ends.find((e) => e.dev === x.id).port] || {}).peerLink);
    // keepalive 看設定的位址：目的位址在哪一台上
    const ka = d.vpc.keepalive || {};
    const kaPeer = Object.values(state.devices).find((x) => x !== d && x.ifaces && x.ifaces.some((i) => parseIp(i.ip || '') === parseIp(ka.dst || '') && parseIp(ka.dst || '') != null));
    const peer = peerDev || (kaPeer && vpcOn(kaPeer) ? kaPeer : null);
    if (!peer) { r.why = pl.some((pid) => state.rt.links[d.id + ':' + pid]) ? 'peer-link 對面的埠沒有設成 vpc peer-link' : 'peer-link 沒有連線，keepalive 也找不到對方'; continue; }
    r.peer = peer.id;
    if (!vpcOn(peer)) { r.why = `${peer.name} 沒有啟用 vPC（feature vpc、vpc domain）`; continue; }
    if (+peer.vpc.domain !== +d.vpc.domain) { r.why = `vPC domain 不一樣（${d.vpc.domain} / ${peer.vpc.domain}）`; continue; }
    r.peerLink = !!peerDev && pl.some((pid) => { const e = state.rt.links[d.id + ':' + pid]; return e && e.dev === peer.id; });
    // keepalive：兩端的位址都設定在活著的介面上，而且在同一個網段（通常是一條直接的線或管理網路）
    const pka = peer.vpc.keepalive || {}, me = ownerOf(state, d, ka.src), them = ownerOf(state, peer, ka.dst);
    const mutual = parseIp(pka.dst || '') === parseIp(ka.src || '') && parseIp(pka.src || '') === parseIp(ka.dst || '');
    const sub = me && them && me.iface.mask && sameNet(parseIp(ka.src), parseIp(ka.dst), parseMask(me.iface.mask));
    r.keepalive = !!(me && them && me.up && them.up && mutual && sub && !(state.down || {})[peer.id]);
    r.kaWhy = !ka.dst ? '沒有設定 peer-keepalive' : !them ? `目的位址 ${ka.dst} 不在 ${peer.name} 上` : !me ? `來源位址 ${ka.src || '（沒有指定）'} 不在 ${d.name} 自己的介面上` : !mutual ? `兩端的 peer-keepalive 沒有互相指向對方（${peer.name} 設的是 destination ${pka.dst || '?'} source ${pka.src || '?'}）` : !sub ? '兩端的 keepalive 位址不在同一個網段' : !(me.up && them.up) ? 'keepalive 的介面沒有連線' : '';
    // 角色：role priority 小的當 primary；一樣就看系統 MAC
    const p1 = +d.vpc.prio || VPC_PRIO, p2 = +peer.vpc.prio || VPC_PRIO;
    r.role = p1 < p2 || (p1 === p2 && sysMac(d) < sysMac(peer)) ? 'primary' : 'secondary';
  }
  // peer-link 斷了、keepalive 還在：secondary 暫停自己的 vPC
  for (const d of devs) {
    const r = d.rt.vpc;
    if (!r.peer) continue;
    if (!r.peerLink && r.keepalive && r.role === 'secondary') { r.susp = true; r.why = 'peer-link 斷了，但 keepalive 收得到對方：對方還活著，secondary 暫停自己全部的 vPC 成員埠（避免 split brain）'; }
    else if (!r.peerLink && !r.keepalive) r.why = 'peer-link 和 keepalive 都斷了：當作對方已經離線，自己繼續轉送';
    else if (!r.peerLink) r.why = 'peer-link 斷了（primary 繼續轉送）';
    // consistency check（Type-1）：兩邊同一個 vPC 的成員埠，模式與 VLAN 要一樣
    const peer = state.devices[r.peer];
    if (!r.peerLink || !peer) continue;
    for (const n of new Set(Object.values(d.sw.ports).filter((pc) => +pc.vpc > 0).map((pc) => +pc.vpc))) {
      const a = memberPorts(d, n), b = memberPorts(peer, n);
      if (!b.length) { r.bad[n] = `${peer.name} 沒有 vPC ${n}`; continue; }
      const sig = (D, pid) => { const pc = D.sw.ports[pid]; return `${pc.mode}/${pc.mode === 'trunk' ? pc.native + '/' + (pc.allowed || 'all') : pc.vlan}`; };
      if (sig(d, a[0]) !== sig(peer, b[0])) r.bad[n] = `兩邊的成員埠設定不一致（${d.name}：${sig(d, a[0])}；${peer.name}：${sig(peer, b[0])}）`;
    }
  }
}

/** vPC 現在能不能用：兩台都設了這個編號、peer-link 起來、設定一致；回傳 null 或原因 */
export function vpcDown(state, d, n) {
  const r = d.rt && d.rt.vpc;
  if (!vpcOn(d) || !r) return 'vPC 沒有啟用';
  if (r.susp) return r.why;
  if (!r.peer) return r.why || '找不到 vPC 對端';
  if (r.bad[n]) return r.bad[n];
  return null;
}
/**
 * Port-channel 協商用的「這一端是誰」：vPC 的成員埠，兩台 Nexus 報出同一個身分（vPC 的系統 MAC），下面那台就把兩條綁在一起
 * 不是 vPC（或 vPC 不能用）就用設備自己
 */
export function lagIdentity(state, d, pid) {
  const pc = d.sw.ports[pid], n = +pc.vpc;
  if (!(n > 0) || !vpcOn(d) || !d.rt.vpc || !d.rt.vpc.peer || d.rt.vpc.bad[n]) return `${d.id}#${pc.lag}`;
  if (!d.rt.vpc.peerLink) return `${d.id}#${pc.lag}`; // peer-link 斷了：各自是各自（另一台的 vPC 若被暫停就只剩這邊）
  const pair = [d.id, d.rt.vpc.peer].sort().join('+');
  return `vpc:${pair}:${d.vpc.domain}#${n}`;
}
/** 這個埠是 peer-link 的成員 */
export const isPeerLink = (d, pid) => !!(d.sw && d.sw.ports[pid] && d.sw.ports[pid].peerLink && +d.sw.ports[pid].lag > 0);
/** vPC 的防迴圈規則：從 peer-link 收到的，不從「對方也有成員、而且在用」的 vPC 埠送出去 */
export function vpcBlocks(state, d, inPort, outPort) {
  if (!isPeerLink(d, inPort)) return false;
  const pc = d.sw.ports[outPort], n = pc && +pc.vpc;
  if (!(n > 0) || vpcDown(state, d, n)) return false;
  const peer = state.devices[d.rt.vpc.peer];
  return !!peer && memberPorts(peer, n).some((pid) => peer.rt.lag && peer.rt.lag[pid] && peer.rt.lag[pid].state === 'bundled' && peer.rt.lag[pid].carrier);
}
export { memberPorts as vpcMembers };
