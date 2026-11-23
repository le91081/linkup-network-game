// NX-OS 的 vPC：show vpc、show vpc brief、show vpc peer-keepalive
import { vpcOn, vpcDown, vpcMembers, VPC_PRIO } from '../engine/vpc.js';
import { vlanAllowed } from '../engine/sim.js';
import { isNexus } from '../engine/mtu.js';

const pad = (s, n) => String(s).padEnd(n);
const activeVlans = (d, pc) => (pc.mode === 'trunk' ? d.sw.vlans.map((v) => v.id).filter((v) => vlanAllowed(pc, v)) : [+pc.vlan || 1]).join(',') || '-';
const NOT = ['% Invalid command at \'^\' marker.（show vpc 是 Nexus 的指令）'];
const OFF = ['% Feature not enabled（先在設定模式下 feature vpc，再設定 vpc domain）'];

export function showVpc(st, d) {
  if (!isNexus(d)) return NOT;
  if (!(d.features || {}).vpc) return OFF;
  if (!vpcOn(d)) return ['vPC domain id                     : Not configured', '（還沒有 vpc domain：設定模式下 vpc domain <編號>）'];
  const r = d.rt.vpc || {}, peer = r.peer && st.devices[r.peer];
  const lags = new Map();
  for (const [pid, pc] of Object.entries(d.sw.ports)) if (+pc.lag > 0) (lags.get(+pc.lag) || lags.set(+pc.lag, []).get(+pc.lag)).push(pid);
  const pl = [...lags.entries()].find(([, ps]) => ps.some((p) => d.sw.ports[p].peerLink));
  const vpcs = [...new Set(Object.values(d.sw.ports).filter((pc) => +pc.vpc > 0 && +pc.lag > 0).map((pc) => +pc.vpc))].sort((a, b) => a - b);
  const peerSt = !peer ? 'peer link not configured' : r.peerLink ? 'peer adjacency formed ok' : r.keepalive ? 'peer link is down' : 'peer is not reachable';
  const ka = !(d.vpc.keepalive || {}).dst ? 'Disabled' : r.keepalive ? 'peer is alive' : 'peer is not reachable through peer-keepalive';
  const anyBad = vpcs.some((n) => r.bad && r.bad[n]);
  const o = [
    'Legend:', '                (*) - local vPC is down, forwarding via vPC peer-link', '',
    `vPC domain id                     : ${d.vpc.domain}`,
    `Peer status                       : ${peerSt}`,
    `vPC keep-alive status             : ${ka}`,
    `Configuration consistency status  : ${peer && r.peerLink ? 'success' : 'failed'}`,
    `Per-vlan consistency status       : ${anyBad ? 'failed' : 'success'}`,
    `Type-2 consistency status         : ${anyBad ? 'failed' : 'success'}`,
    `vPC role                          : ${r.role && r.role !== 'none' ? (r.peerLink || r.keepalive ? r.role : r.role + ', operational primary') : 'none established'}`,
    `Number of vPCs configured         : ${vpcs.length}`,
    `Peer Gateway                      : ${d.vpc.peerGw ? 'Enabled' : 'Disabled'}`,
    'Dual-active excluded VLANs        : -',
    'Graceful Consistency Check        : Enabled',
    `Auto-recovery status              : ${d.vpc.autoRec ? 'Enabled, timer is off.(timeout = 240s)' : 'Disabled'}`, '',
    'vPC Peer-link status', '---------------------------------------------------------------------',
    'id    Port   Status Active vlans', '--    ----   ------ -------------------------------------------------',
    ...(pl ? [`1     ${pad('Po' + pl[0], 6)} ${pad(r.peerLink ? 'up' : 'down', 6)} ${r.peerLink ? activeVlans(d, d.sw.ports[pl[1][0]]) : '-'}`] : ['（沒有設定 peer-link）']), '',
    'vPC status', '----------------------------------------------------------------------------',
    'Id    Port          Status Consistency Reason                Active vlans', '--    ------------  ------ ----------- ------                ---------------',
  ];
  for (const n of vpcs) {
    const mine = vpcMembers(d, n), lag = +d.sw.ports[mine[0]].lag, why = vpcDown(st, d, n);
    const local = mine.some((p) => d.rt.lag[p] && d.rt.lag[p].state === 'bundled');
    const status = why ? 'down' : local ? 'up' : 'down*';
    const reason = r.bad && r.bad[n] ? 'Consistency Check Not Performed'.slice(0, 21) : why ? (r.susp ? 'vPC peer-link is down' : 'peer not reachable') : 'success';
    o.push(`${pad(n, 5)} ${pad('Po' + lag, 13)} ${pad(status, 6)} ${pad(r.bad && r.bad[n] ? 'failed' : peer && r.peerLink ? 'success' : 'not-applicable', 11)} ${pad(reason, 21)} ${status === 'down' ? '-' : activeVlans(d, d.sw.ports[mine[0]])}`);
  }
  if (!vpcs.length) o.push('（還沒有 vPC：interface port-channel <N> → vpc <N>）');
  const notes = [r.why, ...Object.entries(r.bad || {}).map(([n, w]) => `vPC ${n}：${w}`)].filter(Boolean);
  if (notes.length) o.push('', ...notes.map((x) => '（' + x + '）'));
  return o;
}
/** show vpc consistency-parameters vpc <n>：兩台同一個 vPC 的成員埠設定（Type 1 不一致的話 secondary 會暫停） */
export function showVpcConsistency(st, d, n) {
  if (!isNexus(d)) return NOT;
  if (!vpcOn(d)) return OFF;
  const r = d.rt.vpc || {}, peer = r.peer && st.devices[r.peer];
  const mine = vpcMembers(d, n), theirs = peer ? vpcMembers(peer, n) : [];
  if (!mine.length) return [`% vPC ${n} 不在這台 Nexus 上`];
  const col = (D, ps) => { if (!ps.length) return ['-', '-', '-', '-']; const pc = D.sw.ports[ps[0]]; return [pc.mode === 'trunk' ? 'trunk' : 'access', pc.mode === 'trunk' ? String(pc.native) : '-', pc.mode === 'trunk' ? (pc.allowed || 'all') === 'all' ? '1-4094' : pc.allowed : String(pc.vlan), pc.lagMode || 'active']; };
  const a = col(d, mine), b = col(peer || d, theirs);
  const names = ['Mode', 'Native Vlan', 'Allowed VLANs', 'lag mode'], types = ['1', '1', '-', '1'];
  return [`    Legend:`, `        Type 1 : vPC will be suspended in case of mismatch`, '',
    'Name                        Type  Local Value            Peer Value', '-------------               ----  ---------------------- -----------------------',
    ...names.map((nm, k) => `${pad(nm, 28)}${pad(types[k], 6)}${pad(a[k], 23)}${theirs.length ? b[k] : '（對端沒有這個 vPC）'}`),
    ...(r.bad && r.bad[n] ? ['', `（${r.bad[n]}）`] : [])];
}
export function showVpcKeepalive(st, d) {
  if (!isNexus(d)) return NOT;
  if (!vpcOn(d)) return OFF;
  const ka = d.vpc.keepalive || {}, r = d.rt.vpc || {};
  return [
    `vPC keep-alive status             : ${!ka.dst ? 'Disabled' : r.keepalive ? 'peer is alive' : 'peer is not reachable through peer-keepalive'}`, '',
    '--Peer is alive for             : ' + (r.keepalive ? '(1203) seconds, (412) msec' : '-'),
    '--Send status                   : ' + (ka.dst ? 'Success' : 'Failed'),
    '--Receive status                : ' + (r.keepalive ? 'Success' : 'Failed'), '',
    `--Destination                   : ${ka.dst || '-'}`,
    `--Keepalive source IP           : ${ka.src || '-'}`,
    `--Keepalive vrf                 : ${ka.vrf || 'management'}`,
    '--Keepalive interval            : 1000 msec', '--Keepalive timeout             : 5 seconds', '--Keepalive hold timeout        : 3 seconds',
    ...(r.kaWhy ? ['', `（${r.kaWhy}）`] : []),
    ...(+d.vpc.prio ? [] : ['', `（role priority 沒有設定，預設 ${VPC_PRIO}）`]),
  ];
}
