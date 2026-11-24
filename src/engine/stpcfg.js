// STP 的優先權：Rapid PVST+ 每個 VLAN 各自設定（spanning-tree vlan <清單> priority），MST 依 instance 設定
//
// d.sw.stp = { on, prio（沒有個別設定的 VLAN 用它）, vprio: { VLAN: 優先權 }, mode: 'mst' | undefined,
//              mst: { name, rev, map: { instance: [VLAN…] }, prio: { instance: 優先權 } } }
// MST 要「同一個區域」才會照 instance 各自選根橋：名稱、revision、VLAN 對應全部一樣。
// 只要有一台不一樣（或還在跑 PVST），這個模擬就讓 MST 的交換器全部改用 instance 0（CIST）的優先權

/** "10,20-22" → [10, 20, 21, 22]；"1-4094" 這種很大的範圍回傳 'all' */
export function vlanNums(list) {
  const out = [];
  for (const part of String(list || '').split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b > 4094 || b < a) return null;
    if (b - a > 512) return 'all';
    for (let v = a; v <= b; v++) out.push(v);
  }
  return out;
}
/** [10, 11, 12, 20] → "10-12,20" */
export function vlanText(list) {
  const v = [...new Set(list)].sort((a, b) => a - b), o = [];
  for (let k = 0; k < v.length; k++) { let j = k; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++; o.push(j > k ? `${v[k]}-${v[j]}` : String(v[k])); k = j; }
  return o.join(',');
}
export const mstOf = (d) => ((d.sw && d.sw.stp) || {}).mst || {};
export const isMst = (d) => ((d.sw && d.sw.stp) || {}).mode === 'mst';
/** 這個 VLAN 對應到哪個 instance（沒有對應的都在 instance 0） */
export function mstInst(d, v) {
  for (const [i, l] of Object.entries(mstOf(d).map || {})) if ((l || []).includes(+v)) return +i;
  return 0;
}
/** MST 區域的設定（拿來比對是不是同一個區域） */
export const mstKey = (d) => { const m = mstOf(d); return JSON.stringify([m.name || '', +m.rev || 0, Object.entries(m.map || {}).filter(([, l]) => l && l.length).map(([i, l]) => [+i, [...l].sort((a, b) => a - b)]).sort((a, b) => a[0] - b[0])]); };
// ── 連接埠的保護功能 ──
// pc.bpdufilter：true（spanning-tree bpdufilter enable）| false（disable）| 沒設定
// pc.bpduguard：true | false | 沒設定；pc.loopguard：true（guard loop）| false（guard none）| 沒設定
// d.sw.stp.bpdufilterDefault / bpduguardDefault（spanning-tree portfast bpdufilter | bpduguard default）、loopguardDefault
const stpOf = (d) => (d.sw && d.sw.stp) || {};
/** 介面上的 spanning-tree bpdufilter enable：這個埠不送也不收 BPDU，等於這個埠沒有 STP（接到交換器就可能形成迴圈） */
export const bpduFilterIf = (d, pid) => !!(d.sw && d.sw.ports[pid] && d.sw.ports[pid].bpdufilter === true);
/** 會不會送 BPDU：介面的 bpdufilter，或全域的 portfast bpdufilter default 套在 PortFast 的埠上（收到 BPDU 就失去 PortFast，所以不影響交換器之間的線） */
export const bpduSilent = (d, pid, edge) => bpduFilterIf(d, pid) || (!!edge && stpOf(d).bpdufilterDefault && (d.sw.ports[pid] || {}).bpdufilter !== false);
/**
 * UDLD：光纖兩端互相送 UDLD 的封包確認「我收得到你、你也收得到我」。單向的連線（一芯光纖斷了、收發器的 TX 壞了，兩端燈號都亮）
 * 兩端都開 UDLD 才偵測得到，偵測到就把埠 err-disable（原因 udld）。
 * d.sw.udld = { on（udld enable：所有光纖埠）, aggressive（udld aggressive）}；埠：pc.udld = 'normal' | 'aggressive' | 'disable'
 */
export function udldOn(d, pid) {
  const pc = d.sw && d.sw.ports[pid];
  if (!pc || pc.udld === 'disable') return false;
  if (pc.udld) return true;
  const g = d.sw.udld || {}, p = d.ports.find((x) => x.id === pid);
  return !!((g.on || g.aggressive) && p && p.media !== 'rj45');
}
export const udldMode = (d, pid) => { const pc = d.sw.ports[pid] || {}; return pc.udld === 'aggressive' || (!pc.udld && (d.sw.udld || {}).aggressive) ? 'aggressive' : 'normal'; };
/** BPDU Guard：介面上設定的，或全域的 portfast bpduguard default 套在 PortFast 的埠上 */
export const bpduGuardOn = (d, pid, edge) => { const pc = (d.sw && d.sw.ports[pid]) || {}; return pc.bpduguard === true || (pc.bpduguard == null && !!edge && !!stpOf(d).bpduguardDefault); };
/** Loop Guard：介面上的 spanning-tree guard loop，或全域的 loopguard default（交換器之間的點對點線） */
export const loopGuardOn = (d, pid) => { const pc = (d.sw && d.sw.ports[pid]) || {}; return pc.loopguard === true || (pc.loopguard == null && !pc.rootguard && !!stpOf(d).loopguardDefault); };

/** 這台在這個 VLAN 的優先權；sameRegion：所有跑 STP 的交換器都是同一個 MST 區域 */
export function stpPrio(d, v, sameRegion) {
  const s = (d.sw && d.sw.stp) || {}, base = s.prio == null || s.prio === '' ? 32768 : +s.prio;
  if (s.mode === 'mst') {
    const m = s.mst || {}, p = m.prio || {};
    const inst = sameRegion ? mstInst(d, v) : 0;
    return p[inst] != null ? +p[inst] : p[0] != null ? +p[0] : base;
  }
  const vp = (s.vprio || {})[v];
  return vp != null ? +vp : base;
}
