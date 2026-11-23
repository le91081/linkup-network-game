// 文件產出：2D 拓撲圖匯出成 SVG / PNG、IP 位址規劃表（複製到試算表、下載 CSV）
import { h, button, toast } from './dom.js';
import { modal, closeModal } from './hud.js';
import { saveText, IN_ARTIFACT } from './save.js';
import { fmtIp, netOf } from '../engine/ip.js';
import { CATALOG } from '../engine/model.js';

// 畫面上的樣式來自 CSS：匯出時把算出來的值寫進每個元素，檔案拿到別的地方打開才會一樣
const PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'display'];
const BG = '#0d1428';

/** 2D 拓撲圖 → 獨立的 SVG 文字（裁到內容的範圍、加上背景與標題） */
export function topoSvg(svg, title) {
  const bb = svg.getBBox(), pad = 28, top = title ? 34 : 0;
  const clone = svg.cloneNode(true);
  const src = svg.querySelectorAll('*'), dst = clone.querySelectorAll('*');
  src.forEach((el, k) => { const cs = getComputedStyle(el); dst[k].setAttribute('style', PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';')); dst[k].removeAttribute('class'); });
  const x = bb.x - pad, y = bb.y - pad - top, w = Math.ceil(bb.width + pad * 2), hh = Math.ceil(bb.height + pad * 2 + top);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${hh}`);
  clone.setAttribute('width', w); clone.setAttribute('height', hh);
  clone.removeAttribute('class');
  const ns = 'http://www.w3.org/2000/svg';
  const bg = document.createElementNS(ns, 'rect');
  for (const [k, v] of Object.entries({ x, y, width: w, height: hh, fill: BG })) bg.setAttribute(k, v);
  clone.insertBefore(bg, clone.firstChild);
  if (title) {
    const t = document.createElementNS(ns, 'text');
    for (const [k, v] of Object.entries({ x: x + pad, y: y + pad + 6, fill: '#e8eefc', 'font-size': 16, 'font-weight': 700, 'font-family': 'system-ui, sans-serif' })) t.setAttribute(k, v);
    t.textContent = title;
    clone.append(t);
  }
  return { text: new XMLSerializer().serializeToString(clone), w, h: hh };
}

/** SVG → PNG（兩倍解析度） */
function svgToPng(text, w, hh) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w * 2; c.height = hh * 2;
      const g = c.getContext('2d');
      g.scale(2, 2);
      g.drawImage(img, 0, 0, w, hh);
      c.toBlob((b) => (b ? resolve({ blob: b, url: c.toDataURL('image/png') }) : reject(new Error('png'))), 'image/png');
    };
    img.onerror = () => reject(new Error('svg'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  });
}

const fileBase = (app) => `linkup-${(app.level && app.level.id) || 'topology'}`;

/** 「匯出圖片」：SVG（向量，可以再編輯）或 PNG */
export function exportTopoDialog(app, svg) {
  const title = app.level ? `${app.level.title}` : 'LinkUp';
  const go = async (kind) => {
    const s = topoSvg(svg, title);
    if (kind === 'svg') { saveText(fileBase(app) + '.svg', s.text, 'image/svg+xml', '已匯出 SVG'); closeModal(); return; }
    try {
      const p = await svgToPng(s.text, s.w, s.h);
      if (!IN_ARTIFACT) {
        const url = URL.createObjectURL(p.blob), a = h('a', { href: url, download: fileBase(app) + '.png' });
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('已匯出 PNG', 'ok'); closeModal();
      } else {
        modal([h('h2', { text: '匯出圖片' }), h('p', { class: 'muted', text: '這個頁面不能下載檔案：在圖片上按右鍵「另存圖片」。' }), h('img', { class: 'export-img', src: p.url, alt: title }),
          h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: closeModal }))], { wide: true });
      }
    } catch { toast('轉成 PNG 失敗，改用 SVG', 'bad'); }
  };
  modal([
    h('h2', { text: '匯出拓撲圖' }),
    h('p', { class: 'muted', text: '匯出目前的 2D 拓撲圖（含位址與標註）。SVG 是向量圖，可以用 draw.io、Visio、Inkscape 打開再修改；PNG 方便貼進文件與簡報。' }),
    h('div', { class: 'd-actions' }, button('取消', { kind: 'ghost', onclick: closeModal }), button('PNG', { ic: 'download', onclick: () => go('png') }), button('SVG', { ic: 'download', kind: 'primary', onclick: () => go('svg') })),
  ]);
}

// ── IP 位址規劃表 ──
const SRC = { static: '固定', dhcp: 'DHCP', apipa: 'APIPA', slaac: 'SLAAC' };
/** 所有設備的 L3 位址：[{ dev, model, iface, addr, net, src, gw, vlan, desc }] */
export function ipPlanRows(state) {
  const rows = [];
  const devs = Object.values(state.devices).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  for (const d of devs) {
    for (const i of d.ifaces || []) {
      const r = i.rt || {};
      if (r.ip == null) continue;
      const vlan = i.bind && i.bind.t === 'svi' ? i.bind.vlan : i.bind && i.bind.t === 'sub' ? i.bind.vlan : '';
      rows.push({
        dev: d.name, model: (CATALOG[d.model] || {}).title || d.model, iface: i.label, addr: `${fmtIp(r.ip)}/${r.bits}`, net: `${fmtIp(netOf(r.ip, r.bits))}/${r.bits}`,
        src: SRC[r.src] || '固定', gw: r.gw != null ? fmtIp(r.gw) : '', vlan: vlan === '' || vlan == null ? '' : String(vlan), vrf: i.vrf || '', desc: i.desc || '',
      });
    }
  }
  return rows;
}
const COLS = [['dev', '設備'], ['model', '型號'], ['iface', '介面'], ['addr', 'IP 位址'], ['net', '網段'], ['src', '來源'], ['gw', '預設閘道'], ['vlan', 'VLAN'], ['vrf', 'VRF'], ['desc', '說明']];
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function ipPlanDialog(app) {
  const rows = ipPlanRows(app.state);
  const nets = new Map();
  for (const r of rows) { const n = nets.get(r.net) || { net: r.net, n: 0, gws: new Set(), vlan: r.vlan }; n.n++; if (r.gw) n.gws.add(r.gw); nets.set(r.net, n); }
  const csv = '﻿' + [COLS.map((c) => c[1]).join(','), ...rows.map((r) => COLS.map(([k]) => csvCell(r[k])).join(','))].join('\r\n');
  const tsv = [COLS.map((c) => c[1]).join('\t'), ...rows.map((r) => COLS.map(([k]) => r[k]).join('\t'))].join('\n');
  const copy = async () => { try { await navigator.clipboard.writeText(tsv); toast('已複製：直接貼到 Excel / Google 試算表', 'ok'); } catch { toast('這裡不能直接複製，請改用下載 CSV', 'bad'); } };
  const sortNet = (a, b) => { const p = (x) => x.split(/[./]/).map(Number); const A = p(a.net), B = p(b.net); for (let k = 0; k < 5; k++) if (A[k] !== B[k]) return A[k] - B[k]; return 0; };
  modal([
    h('h2', { text: `IP 位址規劃表（${rows.length} 個位址、${nets.size} 個網段）` }),
    rows.length ? h('div', { class: 'ipplan-wrap scroll-x' }, h('table', { class: 'ipplan' },
      h('thead', {}, h('tr', {}, COLS.map(([, t]) => h('th', { text: t })))),
      h('tbody', {}, rows.map((r) => h('tr', {}, COLS.map(([k]) => h('td', { class: k === 'addr' || k === 'net' || k === 'gw' ? 'mono' : '', text: r[k] }))))))) : h('p', { class: 'muted', text: '目前沒有任何設備有 IP 位址。' }),
    nets.size ? h('h3', { text: '網段摘要' }) : null,
    nets.size ? h('div', { class: 'ipplan-wrap scroll-x' }, h('table', { class: 'ipplan' },
      h('thead', {}, h('tr', {}, ['網段', 'VLAN', '位址數', '用到的預設閘道'].map((t) => h('th', { text: t })))),
      h('tbody', {}, [...nets.values()].sort(sortNet).map((n) => h('tr', {}, h('td', { class: 'mono', text: n.net }), h('td', { text: n.vlan }), h('td', { text: String(n.n) }), h('td', { class: 'mono', text: [...n.gws].join('、') })))))) : null,
    h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: closeModal }), button('複製（貼到試算表）', { ic: 'check', onclick: copy }),
      button('下載 CSV', { ic: 'download', kind: 'primary', onclick: () => saveText(fileBase(app) + '-ip.csv', csv, 'text/csv', '已下載 IP 位址規劃表') })),
  ], { wide: true });
}
