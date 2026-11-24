// 2D 邏輯拓撲圖：用平面的「網路圖」看同一個網路
// 每台設備是一個方塊（名稱、型號、各介面的 IP），線上標出兩端的連接埠與 VLAN；
// 線路的狀態（通、斷、被 STP 封鎖）、無線連線、虛擬連線、建立好的 VPN 通道，以及最近一次測試走過的路徑。
import { CATALOG, MEDIA } from '../engine/model.js';
import { fmtIp } from '../engine/ip.js';
import { isTrunk } from '../engine/sim.js';
import { linkInfo } from '../engine/model.js';
import { DEV_ICON, DEV_COLOR, devIconKey } from './devicons.js';

/** 流量熱圖：這條線兩個方向裡比較忙的那一邊（Mbps、使用率 %） */
export function cableLoad(st, c) {
  const load = (st.rt && st.rt.load) || {};
  const mbps = Math.max(load[c.id + '>' + c.b.dev] || 0, load[c.id + '>' + c.a.dev] || 0);
  const li = linkInfo(st, c.a.dev, c.a.port), speed = li && !li.down ? li.speed : 0;
  return { mbps, speed, pct: speed ? Math.min(100, (mbps / speed) * 100) : 0 };
}
const heatColor = (p) => (p >= 90 ? '#ff5d6c' : p >= 70 ? '#ff9f43' : p >= 40 ? '#f5d547' : p >= 5 ? '#4ade80' : '#3d7a5a');
const fmtMbps = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' Gbps' : m >= 10 ? Math.round(m) + ' Mbps' : m.toFixed(1) + ' Mbps');

const KIND = {
  host: '終端', hub: 'Hub', switch: '交換器', mswitch: 'L2 交換器', l3switch: 'L3 交換器', router: '路由器', homerouter: '家用路由器',
  firewall: '防火牆', ap: '基地台', wlc: '無線控制器', internet: 'ISP', cloud: '公有雲', hypervisor: '虛擬化主機', lb: '負載平衡器', patch: '配線架',
};
const COLOR = DEV_COLOR;
// VLAN 的顏色：照編號由小到大依序取用（VLAN 1 是預設值，不上色），同一張圖裡同一個 VLAN 永遠是同一個顏色
const VLAN_PAL = ['#4ade80', '#f472b6', '#fbbf24', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171', '#bef264', '#e879f9', '#93c5fd'];

/** 這個埠是哪一個 Access VLAN（Trunk 回傳 'trunk'；路由埠、不分 VLAN 的設備回傳 null） */
function portVlan(d, pid) {
  const pc = d.sw && d.sw.ports && d.sw.ports[pid];
  if (!pc || d.sw.mode !== 'vlan' || pc.mode === 'routed') return null;
  return isTrunk(d, pid) ? 'trunk' : pc.vlan;
}
/** 這張圖用到的 Access VLAN → { 顏色, 名稱 }（VLAN 1 不算） */
function vlanMap(st) {
  const ids = new Set(), names = {};
  for (const d of Object.values(st.devices)) {
    if (!d.sw || d.sw.mode !== 'vlan') continue;
    for (const v of d.sw.vlans || []) if (v.name && !names[v.id]) names[v.id] = v.name;
    for (const c of st.cables) for (const e of [c.a, c.b]) if (e.dev === d.id) { const v = portVlan(d, e.port); if (typeof v === 'number' && v !== 1) ids.add(v); }
  }
  const out = new Map();
  [...ids].sort((a, b) => a - b).forEach((id, n) => out.set(id, { color: VLAN_PAL[n % VLAN_PAL.length], name: names[id] || '' }));
  return out;
}
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
      const w = Math.min(compact ? 160 : 240, Math.max(compact ? 84 : 104, tw(d.name, 13.5, 7.6) + (compact ? 38 : 54), compact ? 0 : tw(sub, 11, 6) + 54, ...lines.map((l) => tw(l, 11, 6.6) + 24)));
      boxes.set(d.id, { w, h: (compact ? 25 : 40) + lines.length * 15, lines, sub, compact });
    }
    // 間距：大的區域用固定的 66 px；小的區域先把間距縮到放得下，再把重疊的方塊推開
    const K = compact ? Math.max(16, Math.min((rect.w - 120) / Math.max(1, x1 - x0), (rect.h - 60) / Math.max(1, z1 - z0))) : 66;
    const P = new Map(devs.map((d) => [d.id, { x: (d.pos[0] - (x0 + x1) / 2) * K, y: (d.pos[1] - (z0 + z1) / 2) * K }]));
    if (compact) {
      const ids = devs.map((d) => d.id);
      // 設備很多時，每一輪先把方塊放進格子裡，只比較附近格子裡的（不然每輪都是 n² 對，幾百台要好幾百毫秒）
      const big = ids.length > 60;
      const cw = Math.max(...ids.map((id) => boxes.get(id).w)) + 14, ch = Math.max(...ids.map((id) => boxes.get(id).h)) + 22;
      for (let it = 0; it < 80; it++) {
        let moved = false;
        let near = null;
        if (big) {
          const cell = new Map(), at = (x, y) => Math.floor(x / cw) + ',' + Math.floor(y / ch);
          ids.forEach((id, n) => { const p = P.get(id), k = at(p.x, p.y); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(n); });
          near = (i) => {
            const p = P.get(ids[i]), cx = Math.floor(p.x / cw), cy = Math.floor(p.y / ch), out = [];
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const n of cell.get(cx + dx + ',' + (cy + dy)) || []) if (n > i) out.push(n);
            return out.sort((x, y) => x - y);
          };
        }
        for (let i = 0; i < ids.length; i++) {
          const js = near ? near(i) : null;
          for (let jj = 0, jn = js ? js.length : ids.length - i - 1; jj < jn; jj++) {
            const j = js ? js[jj] : i + 1 + jj;
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
  const placed = []; // 已經放好的埠名標籤（避免疊在一起）
  const vlans = app.t2vlan === false ? new Map() : vlanMap(st);
  // 線路（「看不到接線」的關卡不畫）
  for (const c of st.hideCables ? [] : st.cables) {
    if (!P.has(c.a.dev) || !P.has(c.b.dev)) continue;
    const cs = st.rt.cable[c.id] || 'down', e = edge(c.a.dev, c.b.dev);
    const virt = c.media === 'virt';
    const A = st.devices[c.a.dev], B = st.devices[c.b.dev];
    // Access 埠的線照 VLAN 上色、Trunk 畫粗一點：一眼看出哪些設備在同一個廣播網域
    const va = portVlan(A, c.a.port), vb = portVlan(B, c.b.port), acc = typeof va === 'number' ? va : typeof vb === 'number' ? vb : null;
    const trunk = va === 'trunk' || vb === 'trunk', vc = cs === 'up' && !virt && acc != null && vlans.get(acc);
    const cls = `t2-link ${virt ? 'virt' : cs}${trunk && !virt ? ' trunk' : ''}${hot.has(c.id) ? ' hot' : ''}`;
    const why = (st.rt.why || {})[c.id];
    const tip = `${A.name} ${portTag(st, A, c.a.port) || c.a.port} ↔ ${B.name} ${portTag(st, B, c.b.port) || c.b.port} · ${MEDIA[c.media || 'rj45'].cable}${cs === 'blocked' ? ' · 被 STP 封鎖' : cs === 'down' ? ' · 沒有燈號' : ''}${why ? '\n' + why : ''}`;
    if (app.heat && !virt && cs === 'up') {
      // 流量熱圖：線的顏色與粗細照使用率，中間標出目前的流量
      const L = cableLoad(st, c), col = heatColor(L.pct);
      parts.push(`<line class="t2-link heat" style="stroke:${col};stroke-width:${2.5 + (L.pct / 100) * 5}" x1="${e.pa.x}" y1="${e.pa.y}" x2="${e.pb.x}" y2="${e.pb.y}"><title>${esc(`${tip}\n目前 ${fmtMbps(L.mbps)}（${Math.round(L.pct)}%，${L.speed >= 1000 ? L.speed / 1000 + ' Gbps' : L.speed + ' Mbps'} 線路）`)}</title></line>`);
      if (L.mbps >= 0.5) parts.push(`<text class="t2-heat" x="${(e.pa.x + e.pb.x) / 2}" y="${(e.pa.y + e.pb.y) / 2 - 6}" fill="${col}">${esc(`${fmtMbps(L.mbps)} · ${Math.round(L.pct)}%`)}</text>`);
    } else parts.push(`<line class="${cls}"${vc && !hot.has(c.id) ? ` style="stroke:${vc.color}"` : ''} x1="${e.pa.x}" y1="${e.pa.y}" x2="${e.pb.x}" y2="${e.pb.y}"><title>${esc(tip + (vc ? `\nVLAN ${acc}${vc.name ? '（' + vc.name + '）' : ''}` : trunk ? '\nTrunk：同時載好幾個 VLAN' : ''))}</title></line>`);
    // 兩端的埠名
    for (const [end, t, dev] of [[c.a, e.ta, A], [c.b, e.tb, B]]) {
      const tag = portTag(st, dev, end.port);
      if (!tag) continue;
      // 標籤整個放在方塊外面：沿著線的方向，標籤本身的半寬也要算進去
      const w = tw(tag, 10.5, 5.9) + 10, ux = Math.abs(e.dx) / e.len, uy = Math.abs(e.dy) / e.len;
      const off = (6 + ux * (w / 2) + uy * 8) / e.len;
      let tt = end === c.a ? Math.min(0.5, t + off) : Math.max(0.5, t - off);
      let x = e.pa.x + e.dx * tt, y = e.pa.y + e.dy * tt;
      // 同一台設備有好幾條線往同一個方向時標籤會疊在一起：沿著線再往外推，最多推到線的中間
      const hit = () => placed.some((q) => Math.abs(q.x - x) < (q.w + w) / 2 + 2 && Math.abs(q.y - y) < 17);
      for (let k = 0; k < 12 && hit(); k++) {
        const nt = end === c.a ? Math.min(0.5, tt + 14 / e.len) : Math.max(0.5, tt - 14 / e.len);
        if (nt === tt) break;
        tt = nt; x = e.pa.x + e.dx * tt; y = e.pa.y + e.dy * tt;
      }
      placed.push({ x, y, w });
      const pv = portVlan(dev, end.port), pcol = typeof pv === 'number' && vlans.get(pv);
      parts.push(`<g class="t2-port ${cs}${pv === 'trunk' ? ' trunk' : ''}${pcol ? ' vl' : ''}"${pcol ? ` style="--vc:${pcol.color}"` : ''}><rect x="${x - w / 2}" y="${y - 8}" width="${w}" height="16" rx="5"/><text x="${x}" y="${y + 3.6}">${esc(tag)}</text></g>`);
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
  // 雲端的邏輯連線：VPC peering、Transit Gateway 的 attachment（沒有實體的線）
  for (const d of devs) {
    for (const p of (d.vpc && d.vpc.peers) || []) {
      if (!(d.id < p.peer) || !P.has(p.peer)) continue;
      const e = edge(d.id, p.peer);
      parts.push(`<line class="t2-link virt" x1="${e.pa.x}" y1="${e.pa.y}" x2="${e.pb.x}" y2="${e.pb.y}"><title>${esc(`VPC peering ${p.id}：${d.name} ↔ ${st.devices[p.peer].name}`)}</title></line>`);
    }
    for (const id of (d.tgw && d.tgw.attach) || []) {
      if (!P.has(id)) continue;
      const e = edge(d.id, id);
      parts.push(`<line class="t2-link virt" x1="${e.pa.x}" y1="${e.pa.y}" x2="${e.pb.x}" y2="${e.pb.y}"><title>${esc(`${st.devices[id].name} 的 Transit Gateway attachment`)}</title></line>`);
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
  // 標註的群組框：同一群組的設備外面畫一個虛線框，左上角寫名稱
  for (const gr of st.groups || []) {
    const ms = (gr.devs || []).filter((id) => P.has(id));
    if (!ms.length) continue;
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
    for (const id of ms) { const q = P.get(id), bb = boxes.get(id); gx0 = Math.min(gx0, q.x - bb.w / 2); gx1 = Math.max(gx1, q.x + bb.w / 2); gy0 = Math.min(gy0, q.y - bb.h / 2); gy1 = Math.max(gy1, q.y + bb.h / 2); }
    const gc = '#' + (gr.color || 0x6ea8ff).toString(16).padStart(6, '0');
    parts.push(`<g class="t2-group"><rect x="${gx0 - 14}" y="${gy0 - 24}" width="${gx1 - gx0 + 28}" height="${gy1 - gy0 + 38}" rx="12" style="stroke:${gc}"/><text x="${gx0 - 8}" y="${gy0 - 30}" style="fill:${gc}">${esc(gr.name)}</text></g>`);
  }
  // 設備
  for (const d of devs) {
    const p = P.get(d.id), b = boxes.get(d.id);
    const off = !!(st.down || {})[d.id] || !!(st.rt.off || {})[d.id];
    const col = COLOR[d.kind] || '#8892b0';
    const sel = app.selected === d.id;
    const x = p.x - b.w / 2, y = p.y - b.h / 2;
    const ico = DEV_ICON[devIconKey(d)];
    parts.push(`<g class="t2-dev${off ? ' off' : ''}${sel ? ' sel' : ''}" data-dev="${esc(d.id)}" transform="translate(${x} ${y})" style="--kc:${col}">`
      + `<rect class="t2-box" width="${b.w}" height="${b.h}" rx="10"/>`
      + (b.compact
        ? `<g class="t2-ico" transform="translate(7 5) scale(0.667)">${ico}</g><text class="t2-name" x="28" y="17">${esc(d.name)}</text>`
        : `<rect class="t2-ico-bg" x="7" y="7" width="28" height="28" rx="8"/><g class="t2-ico" transform="translate(11 11) scale(0.833)">${ico}</g>`
          + `<text class="t2-name" x="42" y="19">${esc(d.name)}</text><text class="t2-sub" x="42" y="33">${esc(off ? '關機中' : b.sub)}</text>`)
      + b.lines.map((l, n) => `<text class="t2-ip" x="11" y="${(b.compact ? 34 : 51) + n * 15}">${esc(l)}</text>`).join('')
      + `<title>${esc(`${d.name} — ${CATALOG[d.model].title}\n點一下開啟設定`)}</title></g>`);
  }
  // 標註的註解：貼在設備方塊的右上角（太長的截短，完整的內容放在提示裡）
  for (const n of st.notes || []) {
    const q = P.get(n.at), bb = boxes.get(n.at);
    if (!q || !n.text) continue;
    const t = n.text.length > 24 ? n.text.slice(0, 23) + '…' : n.text;
    const w = tw(t, 11, 6.6) + 14;
    parts.push(`<g class="t2-note" transform="translate(${q.x + bb.w / 2 - 12} ${q.y - bb.h / 2 - 20})"><rect width="${w}" height="18" rx="5"/><text x="7" y="12.5">${esc(t)}</text><title>${esc(n.text)}</title></g>`);
  }
  svg.innerHTML = `<g class="t2-world" transform="translate(${tx} ${ty}) scale(${s})">${parts.join('')}</g>`
    + `<g class="t2-fx" transform="translate(${tx} ${ty}) scale(${s})"></g>`
    + `<text class="t2-hint" x="${rect.x + 12}" y="${rect.y + rect.h - 10}">滾輪縮放 · 拖曳平移 · 雙擊回到全圖 · 點設備開啟設定</text>`;
  // 封包動畫要用的座標：每台設備的中心與方塊大小
  svg.__geo = { P, boxes };
  drawPacket(svg);
  drawLegend(svg, st, vlans, rect);
}

/** 圖例：線的樣式代表什麼、每個 VLAN 是什麼顏色（放在圖的左下角） */
function drawLegend(svg, st, vlans, rect) {
  const root = svg.parentNode;
  if (!root) return;
  let el = root.querySelector('.t2-legend');
  if (!el) { el = document.createElement('div'); el.className = 't2-legend'; root.append(el); }
  const has = (fn) => st.cables.some(fn);
  const rows = [['up', '連線中']];
  if (has((c) => (st.rt.cable[c.id] || 'down') === 'down')) rows.push(['down', '沒有燈號']);
  if (has((c) => st.rt.cable[c.id] === 'blocked')) rows.push(['blocked', 'STP 封鎖']);
  if (has((c) => c.media !== 'virt' && (portVlan(st.devices[c.a.dev], c.a.port) === 'trunk' || portVlan(st.devices[c.b.dev], c.b.port) === 'trunk'))) rows.push(['up trunk', 'Trunk']);
  if (Object.values(st.rt.clients || {}).some((l) => l && l.length)) rows.push(['wifi', 'Wi-Fi']);
  if (has((c) => c.media === 'virt')) rows.push(['virt', '虛擬連線']);
  const sig = JSON.stringify([rows, [...vlans], Math.round(rect.x), Math.round(rect.y + rect.h)]);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.style.left = rect.x + 12 + 'px';
  el.style.bottom = window.innerHeight - (rect.y + rect.h) + 28 + 'px';
  el.innerHTML = rows.map(([c, t]) => `<span><svg width="26" height="8"><line class="t2-link ${c}" x1="1" y1="4" x2="25" y2="4"/></svg>${t}</span>`).join('')
    + [...vlans].map(([id, v]) => `<span><i style="background:${v.color}"></i>VLAN ${id}${v.name ? ' ' + esc(v.name) : ''}</span>`).join('');
}

/**
 * 封包動畫：3D 場景播放封包時每一格都會通知（main.js 接到這裡），2D 圖上畫出同一顆封包。
 * p = { items: [{ a, b, t }]（從設備 a 往 b，t 是 0 到 1）, color, tag }；p 是 null 就收起來。
 * 重畫整張圖的時候（時間在走、狀態改變）會照最後一次的位置再畫一次。
 */
export function topoPacket(svg, p) {
  svg.__pkt = p;
  drawPacket(svg);
}
function drawPacket(svg) {
  const fx = svg.querySelector('.t2-fx'), geo = svg.__geo, p = svg.__pkt;
  if (!fx || !geo) return;
  if (!p || !p.items || !p.items.length) { if (fx.firstChild) fx.replaceChildren(); return; }
  const col = '#' + (p.color >>> 0).toString(16).padStart(6, '0');
  let out = '';
  p.items.forEach((it, n) => {
    const a = geo.P.get(it.a), b = geo.P.get(it.b), ba = geo.boxes.get(it.a), bb = geo.boxes.get(it.b);
    if (!a || !b) return;
    // 從方塊的邊緣走到另一個方塊的邊緣（不是從中心），封包才不會被方塊蓋住
    const dx = b.x - a.x, dy = b.y - a.y;
    const cut = (bx) => Math.min(0.45, Math.abs(dx) > 0.01 ? bx.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0.01 ? bx.h / 2 / Math.abs(dy) : Infinity);
    const t0 = cut(ba), t1 = 1 - cut(bb), t = t0 + (t1 - t0) * Math.max(0, Math.min(1, it.t));
    const x = a.x + dx * t, y = a.y + dy * t;
    out += `<circle class="t2-pkt-glow" cx="${x}" cy="${y}" r="13" fill="${col}"/><circle class="t2-pkt" cx="${x}" cy="${y}" r="5.5" fill="${col}"/>`;
    if (n === 0 && p.tag) {
      const w = tw(p.tag, 10.5, 6) + 12;
      out += `<g class="t2-pkt-tag"><rect x="${x - w / 2}" y="${y - 27}" width="${w}" height="16" rx="5" fill="${col}"/><text x="${x}" y="${y - 15.5}">${esc(p.tag)}</text></g>`;
    }
  });
  fx.innerHTML = out;
}
/** 封包到了一台設備：方塊外面閃一圈 */
export function topoPulse(svg, id, color) {
  const world = svg.querySelector('.t2-world'), geo = svg.__geo;
  const q = world && geo && geo.P.get(id), b = q && geo.boxes.get(id);
  if (!b) return;
  const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  r.setAttribute('class', 't2-pulse');
  r.setAttribute('x', q.x - b.w / 2 - 3); r.setAttribute('y', q.y - b.h / 2 - 3);
  r.setAttribute('width', b.w + 6); r.setAttribute('height', b.h + 6); r.setAttribute('rx', 12);
  r.style.stroke = '#' + (color >>> 0).toString(16).padStart(6, '0');
  world.append(r);
  setTimeout(() => r.remove(), 620);
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
