// 交換器堆疊（Catalyst 9300 的 StackWise-480）
//
// 好幾台實體交換器用背後的堆疊線接成一個環，對外就是「一台」交換器：一份設定、一個管理位址、一個 STP 的 bridge、一張 MAC 位址表。
// 埠的名稱第一個數字是成員的編號：Gi1/0/1 在 Switch 1、Gi2/0/1 在 Switch 2。
// 其中一台是 Active（控制平面：跑 STP、OSPF、存設定），一台是 Standby（隨時接手，SSO），其他是 Member。
//
// d.stack = { members: [{ num, prio（1–15，預設 1）, fail（模擬故障）}], active: 目前的 Active 編號, cables: [true, true]（兩條堆疊線） }
// 選 Active：整個堆疊一起開機時，優先權高的當 Active，一樣就看 MAC 位址小的；之後不會搶回（不像 HSRP 的 preempt）。
// 成員故障：它的埠全部斷線；故障的是 Active 的話，Standby 接手成為新的 Active（SSO：第二層的轉送不中斷）。
import { macOf } from './sim/core.js';

export const isStack = (d) => !!(d && d.stack && d.stack.members && d.stack.members.length > 1);
/** 埠屬於哪一台成員：Gi2/0/1 → 2；不是堆疊格式的名稱（例如管理埠 Gi0/0）→ 0 */
export const memberOfPort = (pid) => { const m = String(pid).match(/^[A-Za-z]+(\d+)\/\d+\/\d+$/); return m ? +m[1] : 0; };
/** 每台成員自己的基底 MAC。Switch 1 的就是整個堆疊對外用的那一個（STP 的 bridge ID、SVI 都是它） */
export const memberMac = (d, n) => (n === 1 ? macOf(d.id, 'br', d.model) : macOf(d.id + '#sw' + n, 'br', d.model));

/** 成員是不是故障了：設備上的設定 (fail)，或故障演練 (state.stackDown['設備:編號']) */
export function memberDown(state, d, n) {
  if (!isStack(d)) return false;
  const m = d.stack.members.find((x) => x.num === n);
  return !!(m && (m.fail || ((state && state.stackDown) || {})[d.id + ':' + n]));
}
/** 這個埠所在的成員故障了：回傳原因（給線路的燈號說明），沒有就是 null */
export function stackPortDown(state, d, pid) {
  if (!isStack(d)) return null;
  const n = memberOfPort(pid);
  return n && memberDown(state, d, n) ? `${d.name} 的 Switch ${n} 故障（堆疊成員離線，它的埠全部斷線）` : null;
}

/** 依優先權（大的優先）、MAC 位址（小的優先）排好的成員 */
function ranked(d) {
  return [...d.stack.members].sort((a, b) => (+b.prio || 1) - (+a.prio || 1) || (memberMac(d, a.num) < memberMac(d, b.num) ? -1 : 1));
}
/** 整個堆疊一起開機時會選誰當 Active（優先權 → MAC） */
export const electActive = (d) => ranked(d)[0].num;

/**
 * 每台成員現在的角色：[{ num, role: 'Active' | 'Standby' | 'Member' | 'Removed', prio, mac, state: 'Ready' | 'Removed' }]
 * Active 不會被搶回：設定的 active 還活著就是它；它故障了，就換 Standby（剩下的成員裡排第一的）
 */
export function stackRoles(state, d) {
  if (!isStack(d)) return [];
  const alive = ranked(d).filter((m) => !memberDown(state, d, m.num));
  const want = d.stack.active || electActive(d);
  const act = alive.find((m) => m.num === want) || alive[0];
  const stby = act ? alive.find((m) => m !== act) : null;
  return d.stack.members.map((m) => {
    const down = memberDown(state, d, m.num);
    return { num: m.num, prio: +m.prio || 1, mac: memberMac(d, m.num), role: down ? 'Removed' : m === act ? 'Active' : m === stby ? 'Standby' : 'Member', state: down ? 'Removed' : 'Ready' };
  });
}
/** 堆疊線：兩條都好是完整的環；斷一條還通（頻寬少一半）；兩條都斷就分裂成兩個堆疊（dual-active） */
export function ringState(state, d) {
  const c = (d.stack.cables || [true, true]).map((x) => x !== false);
  const anyDown = d.stack.members.some((m) => memberDown(state, d, m.num));
  if (anyDown) return { ok: true, full: false, text: '有成員離線：環斷開了' };
  const up = c.filter(Boolean).length;
  return up === c.length ? { ok: true, full: true, text: '完整的環（Full ring）' } : up ? { ok: true, full: false, text: '只剩一條堆疊線：還通，但頻寬少一半（Half ring）' } : { ok: false, full: false, text: '堆疊線都斷了：堆疊分裂成兩半（dual-active）' };
}
