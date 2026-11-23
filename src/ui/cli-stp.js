// show spanning-tree detail / show spanning-tree vlan <n> [detail]：每個 VLAN 的計時器、拓撲變更、每個埠的 BPDU
import { portfastOn } from '../engine/sim.js';
import { portVlans } from '../engine/sim/phys.js';
import { linkInfo } from '../engine/model.js';
import { longIf, uptimeOf } from '../engine/ops.js';
import { bpduFilterIf, loopGuardOn, isMst } from '../engine/stpcfg.js';

const hms = (s) => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
const dot = (m) => m.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');
/** 802.1D 的短路徑成本：10 Gbps 2、1 Gbps 4、100 Mbps 19、10 Mbps 100 */
export const stpCost = (speed) => (speed >= 10000 ? 2 : speed >= 1000 ? 4 : speed >= 100 ? 19 : 100);
const TC_WHILE = 35; // topology change 計時器（max age + forward delay）

/** 沿著每一台的 Root Port 走到根橋，加總路徑成本 */
function rootPath(st, d, v) {
  let x = d, cost = 0;
  for (let k = 0; k < 64; k++) {
    const s = x.rt.stp;
    if (!s || s.root[v] === x.id || s.root[v] == null) return cost;
    const rp = Object.keys(s.roles).find((p) => s.roles[p][v] === 'root');
    const l = rp && st.rt.links[x.id + ':' + rp];
    if (!l) return cost;
    cost += stpCost((linkInfo(st, x.id, rp) || {}).speed || 1000);
    x = st.devices[l.dev];
  }
  return cost;
}

export function stpDetailLines(st, d, only) {
  const s = d.rt.stp, o = [];
  const vl = (Object.keys(s.root).length ? Object.keys(s.root).map(Number) : [1]).filter((v) => only == null || v === only);
  if (!vl.length) return [`Spanning tree instance(s) for vlan ${only} does not exist.`];
  const tcs = (st.dyn.tc || {})[d.id] || {}, now = st.clock;
  const lab = (pid) => longIf((d.ports.find((p) => p.id === pid) || {}).label || pid);
  const num = (pid) => d.ports.findIndex((p) => p.id === pid) + 1;
  for (const v of vl) {
    const root = st.devices[s.root[v] || d.id], rs = root.rt.stp, me = (s.vp || {})[v] ?? s.prio, rp = (rs.vp || {})[v] ?? rs.prio, ext = s.region ? 0 : v;
    const rootPort = Object.keys(s.roles).find((p) => s.roles[p][v] === 'root');
    const tc = tcs[v], recent = tc && now - tc.at < TC_WHILE;
    o.push(` VLAN${String(v).padStart(4, '0')} is executing the ${isMst(d) ? 'mstp' : 'rstp'} compatible Spanning Tree protocol`,
      `  Bridge Identifier has priority ${me}, sysid ${ext}, address ${dot(s.mac)}`, '  Configured hello time 2, max age 20, forward delay 15, transmit hold-count 6',
      ...(root === d ? ['  We are the root of the spanning tree'] : [`  Current root has priority ${rp + ext}, address ${dot(rs.mac)}`, `  Root port is ${num(rootPort)} (${lab(rootPort)}), cost of root path is ${rootPath(st, d, v)}`]),
      `  Topology change flag ${recent ? 'set' : 'not set'}, detected flag ${recent ? 'set' : 'not set'}`,
      tc ? `  Number of topology changes ${tc.n} last change occurred ${hms(now - tc.at)} ago` : '  Number of topology changes 0 last change occurred 00:00:00 ago',
      ...(tc ? [`          from ${lab(tc.from)}`] : []),
      '  Times:  hold 1, topology change 35, notification 2', '          hello 2, max age 20, forward delay 15',
      `  Timers: hello 0, topology change ${recent ? Math.ceil(TC_WHILE - (now - tc.at)) : 0}, notification 0, aging 300`);
    for (const p of d.ports) {
      const pc = d.sw.ports[p.id], l = st.rt.links[d.id + ':' + p.id], rootInc = d.rt.err[p.id] === 'root';
      if ((!l && !rootInc) || pc.mode === 'routed' || !portVlans(d, p.id).includes(v)) continue;
      const r = (s.roles[p.id] || {})[v], w = d.rt.wait && d.rt.wait[p.id];
      const state = r === 'altn' ? 'blocking' : w > 15 ? 'listening' : w > 0 ? 'learning' : 'forwarding';
      const what = rootInc ? 'broken  (Root Inconsistent)' : r === 'loopinc' ? 'broken  (Loop Inconsistent)' : `${{ root: 'root', altn: 'alternate' }[r] || 'designated'} ${state}`;
      const cost = stpCost((linkInfo(st, d.id, p.id) || {}).speed || 1000), id = num(p.id);
      const rec = st.dyn.port[d.id + ':' + p.id], age = rec && rec.since > -1e8 ? now - rec.since : uptimeOf(st, d);
      const edge = !r && portfastOn(d, pc, p.id), silent = bpduFilterIf(d, p.id);
      // 指定埠每 2 秒送一個 BPDU；Root / Alternate 只收不送
      const sent = silent || r === 'root' || r === 'altn' || r === 'loopinc' ? (r && !silent ? 1 : 0) : Math.floor(age / 2);
      const recv = r === 'root' || r === 'altn' ? Math.floor(age / 2) : r === 'desg' ? 1 : 0;
      o.push('', ` Port ${id} (${lab(p.id)}) of VLAN${String(v).padStart(4, '0')} is ${what}`, `   Port path cost ${cost}, Port priority 128, Port Identifier 128.${id}.`,
        `   Designated root has priority ${rp + ext}, address ${dot(rs.mac)}`, `   Number of transitions to forwarding state: ${rec && rec.fwd ? 1 : 0}`,
        `   Link type is point-to-point by default${edge ? ', Edge' : ''}`,
        ...(edge ? ['   The port is in the portfast edge mode'] : []),
        ...(silent ? ['   Bpdu filter is enabled'] : []), ...(pc.bpduguard ? ['   Bpdu guard is enabled'] : []),
        ...(pc.rootguard ? ['   Root guard is enabled on the port'] : loopGuardOn(d, p.id) && !edge ? ['   Loop guard is enabled on the port'] : []),
        `   BPDU: sent ${sent}, received ${recv}`);
    }
    o.push('');
  }
  return o;
}
