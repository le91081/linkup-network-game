// 配線架 (patch panel)：被動的元件，前面的第 n 孔和後面的第 n 孔直接相通（後面打線到牆上的網路孔，前面用跳線接交換器）
//
// 對網路來說它是「透明」的：交換器的埠直接連到配線架另一面的那台設備（燈號、速率、CDP / LLDP 的鄰居都是那台）。
// 只接了一面：交換器那一端沒有燈號（另一面沒有設備）。整條通道（跳線 + 水平佈線）的長度加起來，銅纜一樣不能超過 100 公尺。
// d.patch = { labels: { 編號: '3F-12' } } 每一孔貼的標籤（牆上網路孔的編號）
import { CABLES, cableKind, cableDist } from './model.js';

export const isPatch = (d) => !!(d && d.kind === 'patch');
export const pairPort = (pid) => (pid[0] === 'f' ? 'r' : 'f') + pid.slice(1);
export const jackNo = (pid) => +String(pid).slice(1);
const cableAt = (state, dev, pid) => state.cables.find((c) => (c.a.dev === dev && c.a.port === pid) || (c.b.dev === dev && c.b.port === pid));
const farEnd = (c, dev, pid) => (c.a.dev === dev && c.a.port === pid ? c.b : c.a);

/** 在實體層算完每條線之後呼叫：把經過配線架的兩段線接成一條端對端的連線 */
export function patchThrough(state) {
  const rt = state.rt;
  for (const d of Object.values(state.devices)) {
    if (!isPatch(d)) continue;
    for (const p of d.ports.filter((x) => x.id[0] === 'r')) {
      const n = jackNo(p.id), cr = cableAt(state, d.id, p.id), cf = cableAt(state, d.id, 'f' + n);
      const label = (d.patch && d.patch.labels && d.patch.labels[n]) || `第 ${n} 孔`;
      for (const [c, pid] of [[cr, p.id], [cf, 'f' + n]]) if (c) delete rt.links[d.id + ':' + pid];
      const upR = cr && rt.cable[cr.id] === 'up', upF = cf && rt.cable[cf.id] === 'up';
      if (upR && upF) {
        const A = farEnd(cr, d.id, p.id), B = farEnd(cf, d.id, 'f' + n);
        const len = cableDist(state, cr) + cableDist(state, cf), max = Math.min(CABLES[cableKind(cr)].max, CABLES[cableKind(cf)].max);
        if (len > max) {
          for (const c of [cr, cf]) { rt.cable[c.id] = 'down'; rt.why[c.id] = `經過配線架 ${d.name}（${label}）的整條通道是 ${len} 公尺，超過 ${CABLES[cableKind(cr)].name} 的 ${max} 公尺`; }
          delete rt.links[A.dev + ':' + A.port]; delete rt.links[B.dev + ':' + B.port];
          continue;
        }
        rt.links[A.dev + ':' + A.port] = { dev: B.dev, port: B.port, cable: cr.id };
        rt.links[B.dev + ':' + B.port] = { dev: A.dev, port: A.port, cable: cf.id };
        continue;
      }
      // 只接了一面：那一面的設備沒有燈號
      for (const [c, pid, other] of [[cr, p.id, '前面'], [cf, 'f' + n, '後面']]) {
        if (!c || rt.cable[c.id] !== 'up') continue;
        const E = farEnd(c, d.id, pid);
        delete rt.links[E.dev + ':' + E.port];
        rt.cable[c.id] = 'down';
        rt.why[c.id] = `配線架 ${d.name} 的 ${label}：${other}沒有接線，這條線的另一頭沒有設備（沒有燈號）`;
      }
    }
  }
}
/** 配線架某一孔現在接到哪裡：{ back: 後面接的設備:埠, front: 前面接的設備:埠 } */
export function jackInfo(state, d, n) {
  const cr = cableAt(state, d.id, 'r' + n), cf = cableAt(state, d.id, 'f' + n);
  return { back: cr ? farEnd(cr, d.id, 'r' + n) : null, front: cf ? farEnd(cf, d.id, 'f' + n) : null, up: !!(cr && cf && state.rt.cable[cr.id] === 'up' && state.rt.cable[cf.id] === 'up'), why: (cr && state.rt.why[cr.id]) || (cf && state.rt.why[cf.id]) || '' };
}
