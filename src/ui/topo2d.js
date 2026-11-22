// 2D 邏輯拓撲圖：用平面的「網路圖」看同一個網路
// 每台設備是一個方塊（名稱、型號、各介面的 IP），線上標出兩端的連接埠與 VLAN；
// 線路的狀態（通、斷、被 STP 封鎖）、無線連線、虛擬連線、建立好的 VPN 通道，以及最近一次測試走過的路徑。
import { CATALOG, MEDIA } from '../engine/model.js';
import { fmtIp } from '../engine/ip.js';
import { isTrunk } from '../engine/sim.js';

const NS = 'http://www.w3.org/2000/svg';
const KIND = {
  host: '終端', hub: 'Hub', switch: '交換器', mswitch: 'L2 交換器', l3switch: 'L3 交換器', router: '路由器', homerouter: '家用路由器',
  firewall: '防火牆', ap: '基地台', wlc: '無線控制器', internet: 'ISP', cloud: '公有雲', hypervisor: '虛擬化主機',
};
const COLOR = {
  host: '#6ea8ff', hub: '#8892b0', switch: '#4fd8c4', mswitch: '#4fd8c4', l3switch: '#4fd8c4', router: '#a58bff', homerouter: '#a58bff',
  firewall: '#ff8a65', ap: '#7dd3fc', wlc: '#7dd3fc', internet: '#7dd3fc', cloud: '#f5b547', hypervisor: '#b48cff',
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** 粗估文字寬度：中文約 12.5px、英數 6.8px（12px 字） */
const tw = (s, cjk = 12.5, asc = 6.8) => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? cjk : asc), 0);

/** 設備方塊上要顯示的位址（最多三行） */
function addrLines(state, d) {
  const out = [];
  for (const i of d.ifaces) {
    if (!i.rt || i.rt.ip == null) continue;
    const label = d.kind === 'host' ? '' : (i.bind.t === 'svi' ? 'Vlan' + i.bind.vlan : i.label) + ' ';
    out.push(`${label}${fmtIp(i.rt.ip)}/${i.rt.bits}`);
  }
  if (d.kind === 'cloud' && d.vpc) out.push(d.vpc.cidr || '');
  if (out.length > 3) return [...out.slice(0, 2), `…還有 ${out.length - 2} 個介面`];
  return out.filter(Boolean);
}
/** 連接埠旁邊的小標籤：埠名，交換器的埠加上 VLAN（Access 的 VLAN 或 Trunk） */
function portTag(state, d, pid) {
  const p = d.ports.find((x) => x.id === pid);
  const lab = p ? p.label : pid;
  if (d.kind === 'host' && d.ports.length === 1 && p && p.media !== 'virt') return '';
  const pc = d.sw && d.sw.ports && d.sw.ports[pid];
  if (pc && d.sw.mode === 'vlan' && pc.mode !== 'routed') {
    if (isTrunk(d, pid)) return `${lab} · Trunk`;
    return `${lab} · V${pc.vlan}`;
  }
  return lab;
}

/** 畫出整張圖。rect：可以用的區域 { x, y, w, h } */
export function renderTopo(app, svg, rect) {
  const st = app.state, devs = Object.values(st.devices);
  svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  if (!devs.length) { svg.innerHTML = `<text x="${rect.x + rect.w / 2}" y="${rect.y + rect.h / 2}" class="t2-empty">桌面上還沒有設備</text>`; return; }
  // 版面：照 3D 場景的平面座標，每單位固定的間距排好，再整張縮放到可視區域（滾輪可以再放大、拖曳可以平移）。
  // 可視區域太小時改用精簡的方塊（名稱加一個位址），間距也縮小，字才不會小到看不見
  const xs = devs.map((d) => d.pos[0]), zs = devs.map((d) => d.pos[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const layout = (compact) => {
    const boxes = new Map();
    for (const d of devs) {
      const all = addrLines(st, d), lines = compact ? all.slice(0, 1) : all;
      const sub = d.kind === 'host' && CATALOG[d.model].vm ? '虛擬機器' : KIND[d.kind] || d.kind;
      const w = Math.min(compact ? 150 : 230, Math.max(compact ? 76 : 96, tw(d.name, 13.5, 7.6) + 30, compact ? 0 : tw(sub, 11, 6) + 30, ...lines.map((l) => tw(l, 11, 6.6) + 24)));
      boxes.set(d.id, { w, h: (compact ? 24 : 38) + lines.length * 15, lines, sub, compact });
    }
    // 間距：大的區域用固定的 66 px；小的區域先把間距縮到放得下，再把重疊的方塊推開
    const K = compact ? Math.max(16, Math.min((rect.w - 120) / Math.max(1, x1 - x0), (rect.h - 60) / Math.max(1, z1 - z0))) : 66;
    const P = new Map(devs.map((d) => [d.id, { x: (d.pos[0] - (x0 + x1) / 2) * K, y: (d.pos[1] - (z0 + z1) / 2) * K }]));
    if (compact) {
      const ids = devs.map((d) => d.id);
      for (let it = 0; it < 80; it++) {
        let moved = false;
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = P.get(ids[i]), b = P.get(ids[j]), A = boxes.get(ids[i]), B = boxes.get(ids[j]);
            const ox = (A.w + B.w) / 2 + 14 - Math.abs(a.x - b.x), oy = (A.h + B.h) / 2 + 22 - Math.abs(a.y - b.y);
            if (ox <= 0 || oy <= 0) continue;
            moved = true;
            // 往重疊比較少的方向推開，各推一半
            if (ox < oy) { const d = (ox / 2 + 0.5) * (a.x <= b.x ? -1 : 1); a.x += d; b.x -= d; } else { const d = (oy / 2 + 0.5) * (a.y <= b.y ? -1 : 1); a.y += d; b.y -= d; }
          }
        }
        if (!moved) break;
      }
    }
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const [id, p] of P) { const b = boxes.get(id); bx0 = Math.min(bx0, p.x - b.w / 2); bx1 = Math.max(bx1, p.x + b.w / 2); by0 = Math.min(by0, p.y - b.h / 2); by1 = Math.max(by1, p.y + b.h / 2); }
    const fit = Math.min(1.15, (rect.w - 40) / (bx1 - bx0 + 60), (rect.h - 30) / (by1 - by0 + 50));
    return { P, boxes, fit, mid: { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 } };
  };
  let L = layout(false);
  if (L.fit < 0.72) L = layout(true);
  const { P, boxes } = L;
  const view = (app.t2 ||= { z: 1, px: 0, py: 0 });
  const s = Math.max(0.6, L.fit) * view.z;
  const tx = rect.x + rect.w / 2 + view.px - L.mid.x * s, ty = rect.y + rect.h / 2 + view.py - L.mid.y * s;
  svg.__view = { tx, ty, s, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, mid: L.mid, base: Math.max(0.6, L.fit) };
  // 最近一次測試走過的線
  const hot = new Set(), hotWifi = new Set();
  for (const hp of app.lastHops || []) {
    if (hp.wave) continue;
    if (hp.cable) hot.add(hp.cable);
    if (hp.wifi) hotWifi.add([hp.from, hp.to].sort().join('|'));
  }
  const edge = (a, b) => {
    const pa = P.get(a), pb = P.get(b), ba = boxes.get(a), bb = boxes.get(b);
    const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1;
    const out = (bx) => Math.min(Math.abs(dx) > 0.01 ? bx.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0.01 ? bx.h / 2 / Math.abs(dy) : Infinity);
    return { pa, pb, dx, dy, len, ta: out(ba), tb: 1 - out(bb) };
  };
  const parts = [];
  // 線路（「看不到接線」的關卡不畫）
  for (const c of st.hideCables ? [] : st.cables) {
    if (!P.has(c.a.dev) || !P.has(c.b.dev)) continue;
    const cs = st.rt.cable[c.id] || 'down', e = edge(c.a.dev, c.b.dev);
    const virt = c.media === 'virt';
    const cls = `t2-link ${virt ? 'virt' : cs}${hot.has(c.id) ? ' hot' : ''}`;
    const A = st.devices[c.a.dev], B = st.devices[c.b.dev];
    const why = (st.rt.why || {})[c.id];
    const tip = `${A.name} ${portTag(st, A, c.a.port) || c.a.port} ↔ ${B.name} ${portTag(st, B, c.b.port) || c.b.port} · ${MEDIA[c.media || 'rj45'].cable}${cs === 'blocked' ? ' · 被 STP 封鎖' : cs === 'down' ? ' · 沒有燈號' : ''}${why ? '\n' + why : ''}`;
    parts.push(`<line class="${cls}" x1="${e.pa.x}" y1="${e.pa.y}" x2="${e.pb.x}" y2="${e.pb.y}"><title>${esc(tip)}</title></line>`);
    // 兩端的埠名
    for (const [end, t, dev] of [[c.a, e.ta, A], [c.b, e.tb, B]]) {
      const tag = portTag(st, dev, end.port);
      if (!tag) continue;
      // 標籤整個放在方塊外面：沿著線的方向，標籤本身的半寬也要算進去
      const w = tw(tag, 10.5, 5.9) + 10, ux = Math.abs(e.dx) / e.len, uy = Math.abs(e.dy) / e.len;
      const off = (6 + ux * (w / 2) + uy * 8) / e.len;
      const tt = end === c.a ? Math.min(0.5, t + off) : Math.max(0.5, t - off);
      const x = e.pa.x + e.dx * tt, y = e.pa.y + e.dy * tt;
      parts.push(`<g class="t2-port ${cs}"><rect x="${x - w / 2}" y="${y - 8}" width="${w}" height="16" rx="5"/><text x="${x}" y="${y + 3.6}">${esc(tag)}</text></g>`);
    }
  }
  // 無線：基地台到用戶端的虛線
  for (const [apId, list] of Object.entries(st.rt.clients || {})) {
    for (const cl of list || []) {
      if (!P.has(apId) || !P.has(cl.dev)) continue;
      const e = edge(apId, cl.dev);
      parts.push(`<line class="t2-link wifi${hotWifi.has([apId, cl.dev].sort().join('|')) ? ' hot' : ''}" x1="${e.pa.x}" y1="${e.pa.y}" x2="${e.pb.x}" y2="${e.pb.y}"><title>${esc(`${st.devices[cl.dev].name} 透過 Wi-Fi 連到 ${st.devices[apId].name}`)}</title></line>`);
    }
  }
  // 建立好的 VPN 通道：兩端之間的弧線
  const owner = (ip) => devs.find((d) => d.ifaces.some((i) => i.rt && i.rt.ip === ip));
  const seen = new Set();
  for (const d of devs) {
    for (const t of (d.rt && d.rt.tunnels) || []) {
      if (!t.up || t.peerIp == null) continue;
      const o = owner(t.peerIp);
      if (!o || !P.has(o.id)) continue;
      const key = [d.id, o.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = P.get(d.id), b = P.get(o.id), mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 70;
      parts.push(`<path class="t2-vpn" d="M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}"><title>${esc(`IPsec 通道：${d.name} ↔ ${o.name}`)}</title></path>`);
      parts.push(`<g class="t2-vpntag"><rect x="${mx - 24}" y="${(a.y + b.y) / 4 + my / 2 - 9}" width="48" height="18" rx="9"/><text x="${mx}" y="${(a.y + b.y) / 4 + my / 2 + 4}">IPsec</text></g>`);
    }
  }
  // 設備
  for (const d of devs) {
    const p = P.get(d.id), b = boxes.get(d.id);
    const off = !!(st.down || {})[d.id] || !!(st.rt.off || {})[d.id];
    const col = COLOR[d.kind] || '#8892b0';
    const sel = app.selected === d.id;
    const x = p.x - b.w / 2, y = p.y - b.h / 2;
    parts.push(`<g class="t2-dev${off ? ' off' : ''}${sel ? ' sel' : ''}" data-dev="${esc(d.id)}" transform="translate(${x} ${y})">`
      + `<rect class="t2-box" width="${b.w}" height="${b.h}" rx="10"/>`
      + `<rect class="t2-bar" width="4" height="${b.h - 16}" x="7" y="8" rx="2" style="fill:${col}"/>`
      + `<text class="t2-name" x="18" y="18">${esc(d.name)}</text>`
      + (b.compact ? '' : `<text class="t2-sub" x="18" y="32">${esc(off ? '關機中' : b.sub)}</text>`)
      + b.lines.map((l, n) => `<text class="t2-ip" x="18" y="${(b.compact ? 33 : 48) + n * 15}">${esc(l)}</text>`).join('')
      + `<title>${esc(`${d.name} — ${CATALOG[d.model].title}\n點一下開啟設定`)}</title></g>`);
  }
  svg.innerHTML = `<g class="t2-world" transform="translate(${tx} ${ty}) scale(${s})">${parts.join('')}</g>`
    + `<text class="t2-hint" x="${rect.x + 12}" y="${rect.y + rect.h - 10}">滾輪縮放 · 拖曳平移 · 雙擊回到全圖 · 點設備開啟設定</text>`;
}

/** 滾輪縮放（以游標為中心）、拖曳平移、雙擊重設。redraw 由呼叫的人提供 */
export function bindTopoView(app, svg, redraw) {
  const v = () => (app.t2 ||= { z: 1, px: 0, py: 0 });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = svg.__view; if (!cur) return;
    const t = v(), f = e.deltaY < 0 ? 1.15 : 1 / 1.15, z2 = Math.min(4, Math.max(0.4, t.z * f));
    // 游標底下的那一點縮放前後不動
    const wx = (e.clientX - cur.tx) / cur.s, wy = (e.clientY - cur.ty) / cur.s, s2 = cur.base * z2;
    t.px = e.clientX - cur.cx + cur.mid.x * s2 - wx * s2;
    t.py = e.clientY - cur.cy + cur.mid.y * s2 - wy * s2;
    t.z = z2;
    redraw();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('[data-dev]'))) return;
    drag = { x: e.clientX, y: e.clientY, px: v().px, py: v().py, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    v().px = drag.px + dx; v().py = drag.py + dy;
    svg.classList.add('panning');
    redraw();
  });
  window.addEventListener('pointerup', () => { if (drag && drag.moved) svg.__dragged = true; drag = null; svg.classList.remove('panning'); });
  svg.addEventListener('dblclick', (e) => { if (e.target.closest && e.target.closest('[data-dev]')) return; app.t2 = { z: 1, px: 0, py: 0 }; redraw(); });
}
