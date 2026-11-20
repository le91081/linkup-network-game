// 輕量 DOM 小工具
import { cableAt, peerOf, MEDIA } from '../engine/model.js';

/** h('div', { class:'x', onclick(){…} }, child, 'text', [more]) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'data') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

/** 清空再放入子元素：和 h() 一樣略過 null / false、攤平陣列（原生的 replaceChildren 會把 null 變成「null」文字） */
export function fill(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}

const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  check: '<path d="M4.5 12.5l5 5L19.5 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2h5c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z"/>',
  reset: '<path d="M4 5v5h5"/><path d="M4.6 14a8 8 0 1 0 1.2-7.3L4 10"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 4"/><circle cx="12" cy="17.3" r=".6" fill="currentColor"/>',
  unplug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/>',
  up: '<path d="M6 14l6-6 6 6"/>',
  down: '<path d="M6 10l6 6 6-6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z" fill="currentColor"/>',
  fast: '<path d="M4 5.5v13l8-6.5zM12 5.5v13l8-6.5z" fill="currentColor" stroke="none"/>',
  cable: '<path d="M4 8h5v4H4zM15 12h5v4h-5z"/><path d="M9 10h2.5a2.5 2.5 0 0 1 2.5 2.5v0A1.5 1.5 0 0 0 15.5 14"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.1 7.9-7.5 9.5-4.4-1.6-7.5-4.9-7.5-9.5V6z"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/>',
  mouse: '<rect x="7" y="3.5" width="10" height="17" rx="5"/><path d="M12 7.5v3"/>',
  book: '<path d="M5 4.5h9.5A3.5 3.5 0 0 1 18 8v11.5H8.5A3.5 3.5 0 0 1 5 16z"/><path d="M5 16a3.5 3.5 0 0 1 3.5-3.5H18"/>',
  award: '<circle cx="12" cy="9" r="5.5"/><path d="M8.5 13.6L7 21l5-2.8 5 2.8-1.5-7.4"/>',
  undo: '<path d="M8.5 5L4 9.5 8.5 14"/><path d="M4 9.5h9.5a5 5 0 0 1 0 10H11"/>',
  power: '<path d="M12 3.5v8.5"/><path d="M7.2 6.8a7 7 0 1 0 9.6 0"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14" stroke-width="2.6"/>',
  save: '<path d="M5 4.5h11.5L19.5 7.5V19.5H5z"/><path d="M8 4.5v5h7v-5M8 19.5v-6h8.5v6"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14"/>',
  redo: '<path d="M15.5 5L20 9.5 15.5 14"/><path d="M20 9.5h-9.5a5 5 0 0 0 0 10H13"/>',
  bolt: '<path d="M13 3L5.5 13.5h5.5L10 21l8-11h-5.5z"/>',
  shuffle: '<path d="M4 7h3.5c4.5 0 5.5 10 10 10H20"/><path d="M4 17h3.5c1.8 0 3-1.6 4-3.6M13.4 9.6c1-2 2.2-3.6 4.1-3.6H20"/><path d="M17.5 4L20 6.5 17.5 9M17.5 15L20 17.5 17.5 20"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  edit: '<path d="M4.5 19.5l1-4.5L15.8 4.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L9 18.5z"/><path d="M13.5 7l3.5 3.5"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5h11l-2 4 2 4h-11"/>',
};

export function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('class', 'ic');
  s.innerHTML = ICONS[name] || '';
  return s;
}

export function button(label, opts = {}) {
  const { ic, kind = '', onclick, title, small } = opts;
  return h('button', { class: `btn ${kind} ${small ? 'sm' : ''}`, onclick, title, type: 'button' }, ic && icon(ic, small ? 14 : 16), label && h('span', { text: label }));
}

let toastRoot = null;
export function toast(text, kind = 'info', ms = 3200) {
  toastRoot ||= document.getElementById('toasts');
  const el = h('div', { class: 'toast ' + kind, text });
  toastRoot.append(el);
  while (toastRoot.children.length > 3) toastRoot.firstChild.remove(); // 最多同時顯示三則
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

export function portShort(p) {
  const m = p.label.match(/^(?:[A-Za-z]+\d+\/(?:\d+\/)?|eth|LAN |NIC |線路 )(\d+)$/);
  return m ? m[1] : p.label.replace('乙太網路', 'LAN');
}

/**
 * 設備前面板（2D）。opts: { selected, onPick(port), pickable(port) → true | '原因' }
 */
export function faceplate(state, dev, opts = {}) {
  const groups = [];
  for (const p of dev.ports) {
    const g = groups[groups.length - 1];
    if (g && g.media === p.media) g.ports.push(p);
    else groups.push({ media: p.media, ports: [p] });
  }
  const big = Math.max(...groups.map((g) => g.ports.length));
  const rows = big > 24 ? 4 : big > 8 ? 2 : 1;
  const el = h('div', { class: `faceplate rows-${rows} k-${dev.kind}` });
  for (const g of groups) {
    const cols = Math.ceil(g.ports.length / rows);
    const grid = h('div', { class: 'fp-group m-' + g.media, style: { gridTemplateRows: `repeat(${rows}, auto)`, gridTemplateColumns: `repeat(${cols}, auto)` } });
    for (const p of g.ports) {
      const peer = peerOf(state, dev.id, p.id);
      const used = !!cableAt(state, dev.id, p.id);
      let why = '';
      if (opts.pickable) {
        const r = opts.pickable(p);
        if (r !== true) why = r || '不可用';
      }
      const title = `${p.label}（${MEDIA[p.media].name}）` + (peer ? ` → ${state.devices[peer.dev].name}` : '') + (why ? ` — ${why}` : '');
      grid.append(h('button', {
        type: 'button', title,
        class: `fp-port ${used ? 'used' : ''} ${opts.selected === p.id ? 'sel' : ''} ${why ? 'dis' : ''}`,
        disabled: !!why || !opts.onPick,
        onclick: () => opts.onPick && opts.onPick(p),
      }, h('i', { class: 'led' }), h('span', { text: portShort(p) })));
    }
    el.append(grid);
  }
  return el;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
