// 物件追蹤 (track) 與 IP SLA
//
// track 物件把「某件事是不是正常」變成 Up / Down，給別的功能參考：
//   track 1 interface GigabitEthernet0/0/0 line-protocol    介面的線路協定
//   track 2 ip sla 1 reachability                             IP SLA 探測的結果
// 用的地方：HSRP / VRRP 的 track（Down 就把優先權扣掉一些，讓別台接手）、靜態路由的 track（Down 就把那條路由撤掉）。
// IP SLA 每隔 frequency 秒（預設 60）送一次 ICMP Echo。網路變了，要等到下一次探測才知道，所以切換不是即時的。
//
// 設定：d.track = { [n]: { type: 'iface', iface: 介面 id } | { type: 'sla', sla: n } }
//       d.sla   = { [n]: { dst: 'A.B.C.D', src: 介面 id 或 '', freq: 秒, sched: 有沒有 ip sla schedule } }
// 狀態：state.dyn.sla['設備/n']   = { ok, t0（排程開始）, last（上一次探測）, rtt, okN, failN, code }
//       state.dyn.track['設備/n'] = { up, n（變過幾次）, at（上次改變） }
import { longIf } from './ops.js';

export const SLA_FREQ = 60;
export const HSRP_HOLD = 10; // HSRP 的 holdtime：10 秒沒聽到 Active 的 Hello，Standby 才接手
export const FHRP_DEC = 10; // track 沒寫 decrement 時預設扣 10
export const slaKey = (d, n) => d.id + '/' + n;

/** FHRP 的協定、群組、preempt（VRRP 預設會搶回來，HSRP 預設不會） */
export const fhrpProto = (v) => (v && v.proto === 'hsrp' ? 'hsrp' : 'vrrp');
export const fhrpGroup = (v) => (v && +v.group >= 0 && v.group !== '' && v.group != null ? +v.group : 1);
export const fhrpPreempt = (v) => (v && v.preempt != null ? !!v.preempt : fhrpProto(v) === 'vrrp');

const ifLabelOf = (d, id) => { const i = d.ifaces.find((x) => x.id === id); return i ? longIf(i.label) : id; };

/** track 物件的說明文字（show track 的第二行、running-config 的寫法） */
export function trackText(d, t) {
  if (!t) return '';
  return t.type === 'sla' ? `IP SLA ${t.sla} reachability` : `Interface ${ifLabelOf(d, t.iface)} line-protocol`;
}

/** track n 現在是 Up 還是 Down：{ up, why } */
export function trackUp(state, d, n) {
  const t = (d.track || {})[n];
  if (!t) return { up: false, why: `track ${n} 沒有定義`, missing: true };
  if (t.type === 'iface') {
    const i = d.ifaces.find((x) => x.id === t.iface);
    const up = !!(i && i.rt && i.rt.link && i.rt.active !== false && !i.shut);
    return { up, why: up ? '' : `${i ? longIf(i.label) : t.iface} 的線路協定 down` };
  }
  const op = (d.sla || {})[t.sla];
  if (!op) return { up: false, why: `IP SLA ${t.sla} 沒有定義` };
  if (!op.sched) return { up: false, why: `IP SLA ${t.sla} 還沒有排程（ip sla schedule ${t.sla} life forever start-time now）` };
  const r = ((state.dyn && state.dyn.sla) || {})[slaKey(d, t.sla)];
  return { up: !!(r && r.ok), why: r && !r.ok ? `IP SLA ${t.sla} 探測 ${op.dst} 失敗（${r.code}）` : '' };
}

/** HSRP / VRRP 的 track：Down 的物件扣掉的優先權 */
export function fhrpDecrement(state, d, v) {
  let total = 0;
  const down = [];
  for (const t of (v && v.track) || []) {
    if (trackUp(state, d, t.obj).up) continue;
    const dec = t.dec != null && t.dec !== '' ? +t.dec : FHRP_DEC;
    total += dec;
    down.push({ obj: t.obj, dec });
  }
  return { total, down };
}

/**
 * 依 frequency 的節拍執行 IP SLA。probe(d, op) 用目前的路由表真的送一次 ICMP Echo，回傳 { ok, rtt, code }。
 * 結果和上一次探測不同、而且這一刻已經過了下一個節拍：更新結果並回傳 true（呼叫的人要用新的結果重算路由）。
 * 還沒到下一個節拍：把那個時間點放進「收斂中」，時間到了才切換。
 */
export function slaTick(state, probe) {
  const dyn = state.dyn, now = state.clock, S = (dyn.sla ||= {}), down = state.down || {};
  const live = new Set();
  let flipped = false;
  for (const d of Object.values(state.devices)) {
    if (!d.sla || down[d.id]) continue; // 關機、重新開機：探測停止，開機後重新開始
    for (const [n, op] of Object.entries(d.sla)) {
      if (!op.sched || !op.dst) continue;
      const k = slaKey(d, n), freq = +op.freq > 0 ? +op.freq : SLA_FREQ;
      live.add(k);
      const r = probe(d, op);
      let s = S[k];
      if (!s || dyn.boot) {
        S[k] = { ok: r.ok, t0: now, last: now, rtt: r.rtt, okN: r.ok ? 1 : 0, failN: r.ok ? 0 : 1, code: r.code };
        continue;
      }
      const due = s.t0 + Math.floor((now - s.t0) / freq + 1e-9) * freq; // 現在之前最近的一次探測
      if (due > s.last + 1e-9) {
        const runs = Math.max(1, Math.round((due - s.last) / freq));
        if (r.ok) s.okN += runs; else s.failN += runs;
        if (r.ok !== s.ok) flipped = true;
        Object.assign(s, { ok: r.ok, last: due, rtt: r.rtt, code: r.code });
      } else if (r.ok !== s.ok) {
        state.rt.pending.push({ at: s.last + freq, dev: d.id, kind: 'sla', text: `${d.name}：IP SLA ${n} 下一次探測 ${op.dst}` });
      }
    }
  }
  for (const k of Object.keys(S)) if (!live.has(k)) delete S[k];
  return flipped;
}

/** 記下 track 物件的改變（show track 的 changes 與 last change），並寫進設備的紀錄 */
export function trackTick(state, logEvent) {
  const T = (state.dyn.track ||= {}), live = new Set();
  for (const d of Object.values(state.devices)) {
    if ((state.down || {})[d.id]) continue;
    for (const [n, t] of Object.entries(d.track || {})) {
      const k = slaKey(d, n), up = trackUp(state, d, n).up;
      live.add(k);
      const rec = T[k];
      if (!rec) { T[k] = { up, n: 0, at: state.clock }; continue; }
      if (rec.up === up) continue;
      if (!state.dyn.boot) {
        const what = t.type === 'sla' ? `ip sla ${t.sla} reachability` : `interface ${(d.ifaces.find((x) => x.id === t.iface) || { label: t.iface }).label} line-protocol`;
        logEvent(state, d, 6, 'TRACK-6-STATE', `${n} ${what} ${rec.up ? 'Up' : 'Down'} -> ${up ? 'Up' : 'Down'}`);
      }
      Object.assign(rec, { up, n: rec.n + 1, at: state.clock });
    }
  }
  for (const k of Object.keys(T)) if (!live.has(k)) delete T[k];
}

/** 誰在用這個 track 物件（show track 的 Tracked by） */
export function trackUsers(d, n) {
  const out = [];
  for (const r of d.routes || []) if (+r.track === +n) out.push('Static IP Routing 0');
  for (const i of d.ifaces) {
    const v = i.vrrp;
    if (v && v.on && (v.track || []).some((t) => +t.obj === +n)) out.push(`${fhrpProto(v) === 'hsrp' ? 'HSRP' : 'VRRP'} ${longIf(i.label)} ${fhrpGroup(v)}`);
  }
  return [...new Set(out)];
}
