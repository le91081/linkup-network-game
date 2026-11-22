// QSFP 的分歧 (breakout)：一個 100G 的 QSFP28 埠拆成 4 個 25G（或 4 個 10G）的埠，用一條分歧線（QSFP28 → 4 × SFP28）接 4 台設備
//
// NX-OS：interface breakout module 1 port <n> map 25g-4x → Ethernet1/<n> 不見了，變成 Ethernet1/<n>/1 – 4
// 這裡把 4 個子埠當成 4 個 SFP 埠（4 條獨立的線），速率固定是 25G 或 10G
// d.breakout = { 'Eth1/1': { map: '25g-4x', label: 'Eth1/1' } }
import { defaultPortMode } from './model.js';

export const BREAKOUT_MAPS = { '25g-4x': 25000, '10g-4x': 10000 };
/** 支援 breakout 的設備：Nexus 的 QSFP 埠 */
export const canBreakout = (d, p) => /^n9/.test(d.model) && !!p && p.media === 'qsfp' && !p.parent;
const cableOn = (state, devId, pid) => !!state && state.cables.some((c) => (c.a.dev === devId && c.a.port === pid) || (c.b.dev === devId && c.b.port === pid));

/** 拆成 4 個子埠。回傳錯誤訊息或 null */
export function breakoutPort(state, d, pid, map) {
  const p = d.ports.find((x) => x.id === pid);
  if (!p) return `找不到 ${pid}`;
  if (p.parent) return `${p.label} 已經是拆出來的子埠`;
  if (p.media !== 'qsfp' || !/^n9/.test(d.model)) return `${p.label} 不能 breakout：只有 Nexus 的 QSFP 埠可以拆`;
  if (!BREAKOUT_MAPS[map]) return `map 要是 ${Object.keys(BREAKOUT_MAPS).join(' 或 ')}`;
  if (cableOn(state, d.id, pid)) return `${p.label} 還接著 100G 的線：先拔掉，再換成分歧線`;
  const subs = [1, 2, 3, 4].map((n) => ({ id: `${pid}/${n}`, label: `${p.label}/${n}`, media: 'sfp', speed: BREAKOUT_MAPS[map], parent: pid }));
  d.ports.splice(d.ports.indexOf(p), 1, ...subs);
  if (d.sw) { delete d.sw.ports[pid]; for (const s of subs) d.sw.ports[s.id] = { mode: defaultPortMode(d.model), vlan: 1, native: 1, allowed: 'all', shut: false }; }
  d.ifaces = d.ifaces.filter((i) => !(i.bind && i.bind.port === pid)); // routed 的介面跟著消失
  (d.breakout ||= {})[pid] = { map, label: p.label };
  return null;
}

/** 合回原本的 QSFP 埠。回傳錯誤訊息或 null */
export function unbreakoutPort(state, d, pid) {
  const b = (d.breakout || {})[pid];
  if (!b) return `${pid} 沒有 breakout`;
  const subs = d.ports.filter((x) => x.parent === pid);
  const busy = subs.find((s) => cableOn(state, d.id, s.id));
  if (busy) return `${busy.label} 還接著線：先把分歧線拔掉`;
  const idx = d.ports.indexOf(subs[0]);
  d.ports = d.ports.filter((x) => x.parent !== pid);
  d.ports.splice(idx < 0 ? d.ports.length : idx, 0, { id: pid, label: b.label, media: 'qsfp' });
  if (d.sw) { for (const s of subs) delete d.sw.ports[s.id]; d.sw.ports[pid] = { mode: defaultPortMode(d.model), vlan: 1, native: 1, allowed: 'all', shut: false }; }
  d.ifaces = d.ifaces.filter((i) => !(i.bind && subs.some((s) => s.id === i.bind.port)));
  delete d.breakout[pid];
  if (!Object.keys(d.breakout).length) delete d.breakout;
  return null;
}

/** running-config 的 interface breakout（要印在 interface 的設定前面） */
export function breakoutLines(d) {
  return Object.entries(d.breakout || {}).map(([pid, b]) => `interface breakout module 1 port ${pid.split('/').pop()} map ${b.map}`);
}
