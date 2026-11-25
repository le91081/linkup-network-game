// 設備的圖示：網路圖上慣用的符號（路由器是圓形加四個箭頭、交換器是方塊加左右箭頭、防火牆是磚牆…）
// 2D 拓撲圖的方塊、3D 場景的名稱標籤與圖例共用同一份。24 × 24 的座標，只有線條（顏色由外面決定）。
import { CATALOG } from '../engine/model.js';

export const DEV_ICON = {
  pc: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.8"/><path d="M9 20h6M12 16v4"/>',
  laptop: '<path d="M5.5 6h13a1 1 0 0 1 1 1v8.5h-15V7a1 1 0 0 1 1-1z"/><path d="M2.5 18.5h19"/>',
  phone: '<rect x="7.5" y="3" width="9" height="18" rx="2.2"/><path d="M11 18h2"/>',
  ipphone: '<path d="M4 10.4V9.2C4 7.4 7.5 6 12 6s8 1.4 8 3.2v1.2h-4V9c-1-.4-2.4-.6-4-.6s-3 .2-4 .6v1.4z"/><rect x="6.5" y="12.5" width="11" height="7.5" rx="1.5"/><path d="M10 15.4h.01M12 15.4h.01M14 15.4h.01M10 17.6h.01M12 17.6h.01M14 17.6h.01"/>',
  printer: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7.5" rx="1.8"/><path d="M7 14h10v6H7z"/>',
  camera: '<rect x="3" y="6" width="13" height="7" rx="1.5"/><path d="M16 8l4.5-1.5v6L16 11"/><path d="M8 13v4H5M5 15v4"/>',
  nas: '<rect x="6" y="3.5" width="12" height="17" rx="2"/><path d="M6 9.2h12M6 14.8h12M9 6.4h.01M9 12h.01M9 17.6h.01"/>',
  server: '<rect x="4" y="4" width="16" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5"/><path d="M7.5 7.2h.01M7.5 16.8h.01M11 7.2h5.5M11 16.8h5.5"/>',
  ups: '<rect x="3.5" y="7.5" width="15" height="9" rx="1.8"/><path d="M20.5 10.5v3M11.8 9.3l-2.3 3h3l-2.3 3"/>',
  vm: '<path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7z" stroke-dasharray="2.6 2"/><path d="M4.5 7.7l7.5 4.2 7.5-4.2M12 11.9v8.6" stroke-dasharray="2.6 2"/>',
  hypervisor: '<path d="M12 3.5l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 16.5l8 4 8-4"/>',
  hub: '<rect x="3.5" y="8" width="17" height="8" rx="2"/><path d="M7.5 12h9M14 9.8l2.5 2.2-2.5 2.2"/>',
  switch: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M7 10h8.5M13.5 8l2.2 2-2.2 2M17 14H8.5M10.5 12l-2.2 2 2.2 2"/>',
  l3switch: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="12" cy="12" r="2.2"/><path d="M12 7v2.8M12 14.2V17M6.5 12h3.3M14.2 12h3.3"/>',
  router: '<circle cx="12" cy="12" r="8.5"/><path d="M12 6.2v4M12 13.8v4M6.2 12h4M13.8 12h4M10.5 7.7L12 6.2l1.5 1.5M10.5 16.3l1.5 1.5 1.5-1.5M8.7 10.5l1.5 1.5-1.5 1.5M15.3 10.5L13.8 12l1.5 1.5"/>',
  homerouter: '<rect x="3.5" y="12.5" width="17" height="7" rx="2"/><path d="M7 16h.01M10 16h.01M16 12.5V8M13.4 6.4a3.7 3.7 0 0 1 5.2 0M11.6 4.3a6.3 6.3 0 0 1 8.8 0"/>',
  firewall: '<rect x="3.5" y="5" width="17" height="14" rx="1.8"/><path d="M3.5 9.7h17M3.5 14.3h17M12 5v4.7M8 9.7v4.6M16 9.7v4.6M12 14.3V19"/>',
  ap: '<circle cx="12" cy="13.5" r="1.6"/><path d="M8.6 10.2a4.8 4.8 0 0 1 6.8 0M6 7.6a8.5 8.5 0 0 1 12 0M12 15.1V20M8.5 20h7"/>',
  wlc: '<rect x="3.5" y="12" width="17" height="7.5" rx="2"/><path d="M7 15.8h4M16.5 15.8h.01M9.4 8.6a3.7 3.7 0 0 1 5.2 0M7.3 6.2a6.7 6.7 0 0 1 9.4 0"/>',
  internet: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.4 5.9 12 3.5z"/>',
  cloud: '<path d="M7 18.5h10.2a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  lb: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="5.5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="19" cy="18.5" r="2"/><path d="M7 12h10M6.8 11.1l10.4-4.7M6.8 12.9l10.4 4.7"/>',
  patch: '<rect x="3" y="7.5" width="18" height="9" rx="1.5"/><path d="M6.5 10.5h.01M9.5 10.5h.01M12.5 10.5h.01M15.5 10.5h.01M18 10.5h.01M6.5 13.5h.01M9.5 13.5h.01M12.5 13.5h.01M15.5 13.5h.01M18 13.5h.01"/>',
};

const HOST = { pc: 'pc', laptop: 'laptop', phone: 'phone', ipphone: 'ipphone', printer: 'printer', camera: 'camera', nas: 'nas', tower: 'server', rack1u: 'server', gpusrv: 'server', ups: 'ups', vm: 'vm' };
const KIND = { hub: 'hub', switch: 'switch', mswitch: 'switch', l3switch: 'l3switch', router: 'router', homerouter: 'homerouter', firewall: 'firewall', ap: 'ap', wlc: 'wlc', internet: 'internet', cloud: 'cloud', hypervisor: 'hypervisor', lb: 'lb', patch: 'patch' };

/** 這台設備該用哪一個圖示 */
export function devIconKey(dev) {
  if (dev.kind === 'host') return HOST[(CATALOG[dev.model] || {}).shape] || 'pc';
  return KIND[dev.kind] || 'switch';
}

/** 設備種類的代表色（2D 拓撲圖的方塊、3D 標籤的圖示） */
export const DEV_COLOR = {
  host: '#6ea8ff', hub: '#8892b0', switch: '#4fd8c4', mswitch: '#4fd8c4', l3switch: '#4fd8c4', router: '#a58bff', homerouter: '#a58bff',
  firewall: '#ff8a65', ap: '#7dd3fc', wlc: '#7dd3fc', internet: '#7dd3fc', cloud: '#f5b547', hypervisor: '#b48cff', lb: '#ff6b6b', patch: '#9aa4b8',
};

/** 一個 <svg> 圖示元素（給 HTML 用） */
export function devIcon(dev, size = 14) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('class', 'ic dev-ic');
  s.innerHTML = DEV_ICON[devIconKey(dev)];
  return s;
}
