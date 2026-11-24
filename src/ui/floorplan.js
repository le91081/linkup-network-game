// 樓層平面圖：從正上方看整層樓 — 牆（依材質）、設備、線路、機櫃的位置，以及基地台的訊號熱圖（像現場勘測軟體的 heatmap）
import { h } from './dom.js';
import { CABLES, cableKind } from '../engine/model.js';
import { apsOf, rfAt, WALL_MATS } from '../engine/sim/wifi.js';
import { meshServes } from '../engine/mesh.js';
import { rackList, rackSlots } from '../engine/rack.js';

const NS = 'http://www.w3.org/2000/svg';
const S = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) { if (tag === 'text') e.textContent = text; else { const t = document.createElementNS(NS, 'title'); t.textContent = text; e.append(t); } }
  return e;
};
const WALL_COLOR = { drywall: '#b8c0d0', glass: '#7fd6ff', wood: '#c79a5b', brick: '#d0705a', concrete: '#9aa0a8', metal: '#e8e8f0' };
const KIND_COLOR = { pc: '#7aa7ff', host: '#9cc0ff', ap: '#4fd8c4', router: '#b48cff', homerouter: '#b48cff', firewall: '#ff9f43', mswitch: '#5fb3ff', l3switch: '#5fb3ff', switch: '#8fb8e8', hub: '#8fb8e8', internet: '#7fd6ff', cloud: '#f5c147', phone: '#c8d0e0', patch: '#9aa4b8', lb: '#ff5d6c', hypervisor: '#b48cff', wlc: '#4fd8c4' };
/** RSSI 的分級：與「訊號量測」用一樣的門檻 */
export const RSSI_STEPS = [[-60, '#2ecc71', '很好（≥ −60）'], [-67, '#9be15d', '好（≥ −67，語音、視訊）'], [-75, '#f5d547', '普通（≥ −75）'], [-80, '#ff9f43', '很弱（≥ −80）']];
const rssiColor = (v) => (RSSI_STEPS.find(([t]) => v >= t) || [])[1] || null;

/** 一個格子在某個頻段收到最強的訊號（只算正在發射的基地台） */
export function bestRssi(state, aps, pos, band) {
  let best = -Infinity;
  for (const ap of aps) {
    const rf = rfAt(state, ap, pos);
    const v = band === '2.4' ? rf.rssi24 : rf.rssi5;
    if (v > best) best = v;
  }
  return best;
}

/** opts: { band: '5' | '2.4' | 'off', onPick(id) }；回傳 { el, readout } */
export function floorPlan(app, opts = {}) {
  const st = app.state, devs = Object.values(st.devices).filter((d) => d.pos && !(d.kind === 'host' && d.vmOf));
  const walls = st.walls || [];
  const xs = [...devs.map((d) => d.pos[0]), ...walls.flatMap((w) => [w.a[0], w.b[0]])];
  const zs = [...devs.map((d) => d.pos[1]), ...walls.flatMap((w) => [w.a[1], w.b[1]])];
  const pad = 2.5;
  const x0 = Math.floor(Math.min(...xs, 0) - pad), x1 = Math.ceil(Math.max(...xs, 0) + pad);
  const z0 = Math.floor(Math.min(...zs, 0) - pad), z1 = Math.ceil(Math.max(...zs, 0) + pad);
  const K = Math.max(14, Math.min(40, 820 / (x1 - x0), 560 / (z1 - z0))); // 每單位幾 px
  const W = (x1 - x0) * K, H = (z1 - z0) * K;
  const X = (x) => (x - x0) * K, Y = (z) => (z - z0) * K;
  const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'fp-svg' });
  // 格線
  const grid = S('g', { class: 'fp-grid' });
  for (let x = x0; x <= x1; x++) grid.append(S('line', { x1: X(x), y1: 0, x2: X(x), y2: H }));
  for (let z = z0; z <= z1; z++) grid.append(S('line', { x1: 0, y1: Y(z), x2: W, y2: Y(z) }));
  svg.append(grid);
  // 訊號熱圖：每 0.25 單位取樣一點，畫在小畫布上再放大（瀏覽器內插之後就是平滑的熱圖）
  const aps = apsOf(st).filter((ap) => meshServes(st, ap));
  if (opts.band !== 'off' && aps.length) {
    const step = 0.25, cw = Math.round((x1 - x0) / step), ch = Math.round((z1 - z0) / step);
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    if (g) {
      const img = g.createImageData(cw, ch);
      for (let j = 0; j < ch; j++) {
        for (let i = 0; i < cw; i++) {
          const c = rssiColor(bestRssi(st, aps, [x0 + (i + 0.5) * step, z0 + (j + 0.5) * step], opts.band));
          if (!c) continue;
          const o = (j * cw + i) * 4, n = parseInt(c.slice(1), 16);
          img.data[o] = n >> 16; img.data[o + 1] = (n >> 8) & 255; img.data[o + 2] = n & 255; img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      svg.append(S('image', { href: cv.toDataURL(), x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', class: 'fp-heat' }));
    }
  }
  // 牆
  for (const w of walls) {
    svg.append(S('line', { x1: X(w.a[0]), y1: Y(w.a[1]), x2: X(w.b[0]), y2: Y(w.b[1]), class: 'fp-wall', stroke: WALL_COLOR[w.mat] || '#ccc', 'stroke-width': w.mat === 'concrete' || w.mat === 'brick' ? 6 : w.mat === 'metal' ? 5 : 3 }, null));
  }
  // 機櫃：裝在同一個機櫃的設備，畫在它們的中心（約 60 × 100 公分的佔地）
  for (const r of rackList(st)) {
    const ds = rackSlots(st, r.id).map((x) => x.d).filter((d) => d.pos);
    if (!ds.length) continue;
    const cx = ds.reduce((t, d) => t + d.pos[0], 0) / ds.length, cz = ds.reduce((t, d) => t + d.pos[1], 0) / ds.length;
    svg.append(S('rect', { x: X(cx) - 0.6 * K, y: Y(cz) - 0.9 * K, width: 1.2 * K, height: 1.8 * K, class: 'fp-rack', rx: 2 }),
      S('text', { x: X(cx), y: Y(cz) - 0.9 * K - 4, class: 'fp-rack-t', 'text-anchor': 'middle' }, `${r.name}（${ds.length} 台）`));
  }
  // 線路
  if (!st.hideCables) {
    for (const c of st.cables) {
      const A = st.devices[c.a.dev], B = st.devices[c.b.dev];
      if (!A || !B || !A.pos || !B.pos || c.media === 'virt') continue;
      const k = cableKind(c), col = '#' + CABLES[k].color.toString(16).padStart(6, '0');
      const up = st.rt && st.rt.cable[c.id] && st.rt.cable[c.id] !== 'down';
      svg.append(S('line', { x1: X(A.pos[0]), y1: Y(A.pos[1]), x2: X(B.pos[0]), y2: Y(B.pos[1]), stroke: col, class: `fp-cable${up ? '' : ' down'}` }, `${A.name} ↔ ${B.name} · ${CABLES[k].name}`));
    }
  }
  // 設備
  for (const d of devs) {
    const g = S('g', { class: 'fp-dev' + (app.selected === d.id ? ' sel' : ''), 'data-dev': d.id, transform: `translate(${X(d.pos[0])},${Y(d.pos[1])})` });
    const col = KIND_COLOR[d.kind] || '#c8d0e0';
    if (d.wifi) g.append(S('circle', { r: 9, class: 'fp-ap-ring', stroke: col }));
    g.append(S('circle', { r: d.wifi ? 5 : 4.5, fill: col, class: 'fp-dot' }), S('text', { y: -8, 'text-anchor': 'middle', class: 'fp-label' }, d.name));
    g.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: d.name }));
    if (opts.onPick) g.addEventListener('click', () => opts.onPick(d.id));
    svg.append(g);
  }
  // 滑鼠移到哪裡，就量那一點的訊號
  const readout = h('div', { class: 'fp-read muted', text: aps.length ? '把滑鼠移到平面圖上，看那一點收到每台基地台的訊號。' : '場景裡沒有正在發射的基地台。' });
  if (aps.length) {
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect(), x = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0), z = z0 + ((e.clientY - r.top) / r.height) * (z1 - z0);
      const rows = aps.map((ap) => ({ ap, rf: rfAt(st, ap, [x, z]) })).sort((a, b) => b.rf.rssi5 - a.rf.rssi5).slice(0, 3);
      readout.replaceChildren(h('b', { text: `(${x.toFixed(1)}, ${z.toFixed(1)})` }),
        ...rows.map(({ ap, rf }) => h('div', { text: `${ap.name}：5 GHz ${rf.rssi5} dBm · 2.4 GHz ${rf.rssi24} dBm${rf.walls.length ? ` · 穿過 ${rf.walls.length} 道牆` : ''}` })));
    });
  }
  const legend = h('div', { class: 'fp-legend' },
    opts.band !== 'off' && aps.length ? RSSI_STEPS.map(([, c, t]) => h('span', null, h('i', { style: { background: c } }), t)) : null,
    [...new Set(walls.map((w) => w.mat))].map((m) => h('span', null, h('i', { class: 'wall', style: { background: WALL_COLOR[m] || '#ccc' } }), (WALL_MATS[m] || { name: m }).name)),
    [...new Set(st.hideCables ? [] : st.cables.map(cableKind))].filter((k) => k !== 'virtual').map((k) => h('span', null, h('i', { class: 'wall', style: { background: '#' + CABLES[k].color.toString(16).padStart(6, '0') } }), CABLES[k].name)));
  return { el: h('div', { class: 'fp-wrap' }, svg), readout, legend, aps: aps.length };
}
