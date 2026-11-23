// 堆疊的 show 指令：show switch、show switch detail、show switch stack-ports、show redundancy
import { isStack, stackRoles, ringState, memberMac, memberDown } from '../engine/stack.js';
import { uptimeOf } from '../engine/ops.js';

const dot = (m) => m.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');
const pad = (s, n) => String(s).padEnd(n);
const upText = (s) => { const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60); return [dd && `${dd} day${dd > 1 ? 's' : ''}`, (dd || hh) && `${hh} hour${hh === 1 ? '' : 's'}`, `${mm} minute${mm === 1 ? '' : 's'}`].filter(Boolean).join(', '); };
const NOT_STACK = ['% Invalid input detected at \'^\' marker.（這台不是可以堆疊的交換器：show switch 是 Catalyst 9300 這類堆疊交換器的指令）'];
const stackable = (d) => d.model === 'c9300';
/** 單一台（沒有堆疊）的 9300 也有 Switch 1 */
const rolesOf = (st, d) => (isStack(d) ? stackRoles(st, d) : [{ num: 1, prio: 1, mac: memberMac(d, 1), role: 'Active', state: 'Ready' }]);

export function showSwitch(st, d) {
  if (!stackable(d)) return NOT_STACK;
  const roles = rolesOf(st, d), act = roles.find((r) => r.role === 'Active') || roles[0];
  return [
    `Switch/Stack Mac Address : ${dot(memberMac(d, isStack(d) ? d.stack.active || 1 : 1))} - Local Mac Address`,
    'Mac persistency wait time: Indefinite',
    '                                             H/W   Current',
    'Switch#   Role    Mac Address     Priority Version  State',
    '-------------------------------------------------------------',
    ...roles.map((r) => `${r.num === act.num ? '*' : ' '}${pad(r.num, 8)} ${pad(r.role, 8)} ${pad(r.role === 'Removed' ? '0000.0000.0000' : dot(r.mac), 18)} ${pad(r.prio, 6)} ${pad(r.role === 'Removed' ? '0' : 'V02', 8)} ${r.state}`),
    ...(isStack(d) ? [] : ['', '（只有一台：沒有堆疊。* 是你目前連線的那一台，也就是 Active）']),
  ];
}

/** 兩條堆疊線接成環：Switch 1 的 Port 2 接 Switch 2 的 Port 1，Switch 2 的 Port 2 接回 Switch 1 的 Port 1 */
function portRows(st, d) {
  const roles = rolesOf(st, d), n = roles.length, cab = isStack(d) ? (d.stack.cables || [true, true]).map((x) => x !== false) : [];
  return roles.map((r, k) => {
    if (r.role === 'Removed') return { num: r.num, p: ['DOWN', 'DOWN'], nb: ['None', 'None'] };
    if (n < 2) return { num: r.num, p: ['DOWN', 'DOWN'], nb: ['None', 'None'] };
    const prev = roles[(k - 1 + n) % n], next = roles[(k + 1) % n];
    // 第 k 條堆疊線接 k 和 k+1：Port 2 往下一台、Port 1 往上一台
    const up2 = cab[k % cab.length] !== false && next.role !== 'Removed', up1 = cab[(k - 1 + n) % n % cab.length] !== false && prev.role !== 'Removed';
    return { num: r.num, p: [up1 ? 'OK' : 'DOWN', up2 ? 'OK' : 'DOWN'], nb: [up1 ? String(prev.num) : 'None', up2 ? String(next.num) : 'None'] };
  });
}
export function showStackPorts(st, d) {
  if (!stackable(d)) return NOT_STACK;
  const rows = portRows(st, d);
  return ['  Switch#    Port1       Port2', '  --------    ------      ------', ...rows.map((r) => `    ${pad(r.num, 10)} ${pad(r.p[0], 11)} ${r.p[1]}`),
    ...(isStack(d) ? ['', `（${ringState(st, d).text}）`] : ['', '（只有一台：堆疊埠沒有接線）'])];
}
export function showSwitchDetail(st, d) {
  if (!stackable(d)) return NOT_STACK;
  const rows = portRows(st, d);
  return [...showSwitch(st, d).filter((l) => !l.startsWith('（')), '',
    '         Stack Port Status             Neighbors',
    'Switch#  Port 1     Port 2           Port 1   Port 2',
    '--------------------------------------------------------',
    ...rows.map((r) => `  ${pad(r.num, 7)} ${pad(r.p[0], 10)} ${pad(r.p[1], 16)} ${pad(r.nb[0], 8)} ${r.nb[1]}`)];
}
export function showRedundancy(st, d) {
  if (!stackable(d)) return ['% Invalid input detected at \'^\' marker.'];
  const roles = rolesOf(st, d), act = roles.find((r) => r.role === 'Active') || roles[0], sb = roles.find((r) => r.role === 'Standby');
  const so = isStack(d) && act.num !== (d.stack.active || 1) ? 1 : 0;
  return [
    'Redundant System Information :', '------------------------------',
    `       Available system uptime = ${upText(uptimeOf(st, d))}`,
    `Switchovers system experienced = ${so}`,
    '              Standby failures = 0',
    `        Last switchover reason = ${so ? 'active unit removed' : 'none'}`, '',
    `                 Hardware Mode = ${sb ? 'Duplex' : 'Simplex'}`,
    '    Configured Redundancy Mode = sso',
    `     Operating Redundancy Mode = ${sb ? 'sso' : 'Non-redundant'}`,
    '              Maintenance Mode = Disabled',
    `                Communications = ${sb ? 'Up' : 'Down      Reason: Failure'}`, '',
    'Current Processor Information :', '-------------------------------',
    `               Active Location = slot ${act.num}`,
    '        Current Software state = ACTIVE', '',
    'Peer Processor Information :', '----------------------------',
    ...(sb ? [`              Standby Location = slot ${sb.num}`, '        Current Software state = STANDBY HOT'] : ['              Standby Location = slot Unknown', '        Current Software state = DISABLED']),
  ];
}
/** show inventory：堆疊的每一台成員都是一個機箱 */
export const stackChassis = (st, d) => (isStack(d) ? d.stack.members.filter((m) => !memberDown(st, d, m.num)).map((m) => m.num) : null);
