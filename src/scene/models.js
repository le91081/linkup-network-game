// 低多邊形風格的設備模型。每個模型都是一個 Group，原點在地板中心。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CATALOG } from '../engine/model.js';

export const PALETTE = {
  light: 0xe6eaf2, mid: 0x98a3be, dark: 0x3a4564, darker: 0x2a334d, black: 0x141927,
  screenOff: 0x1a2236, blue: 0x5b9dff, teal: 0x2fd6c0, violet: 0xa58bff, orange: 0xff7d5c,
  amber: 0xf5b547, green: 0x4ade80, red: 0xff5d6c, sky: 0x62c4ff,
};

export const ACCENT = {
  host: PALETTE.blue, hub: PALETTE.mid, switch: PALETTE.teal, mswitch: PALETTE.teal, l3switch: PALETTE.teal,
  router: PALETTE.violet, homerouter: PALETTE.violet, firewall: PALETTE.orange, internet: PALETTE.sky,
};

const matCache = new Map();
function mat(color, o = {}) {
  const key = color + JSON.stringify(o);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.62, metalness: o.metal ?? 0.08, ...o.extra }));
  }
  return matCache.get(key);
}
const glow = (color, intensity = 1.6) =>
  new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });

function box(g, w, h, d, material, x = 0, y = 0, z = 0, r = 0.05) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), material);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

// ── 連接埠在前面板上的排列（單位是貼圖的像素）。貼圖和網路線的插頭共用這一份座標，
//    插頭才會剛好插在畫出來的那個孔上 ──
function portGrid(dev, W, H) {
  const n = dev.ports.length;
  const rows = n > 16 ? 2 : 1;
  const cols = Math.ceil(n / rows);
  const padX = 22, padY = 8;
  const cw = (W - padX * 2) / cols;
  const ch = (H - padY * 2) / rows;
  const size = Math.min(cw * 0.78, ch * 0.74);
  return dev.ports.map((p, i) => {
    const col = Math.floor(i / rows), row = i % rows;
    const pw = p.media === 'qsfp' ? size * 1.15 : size, ph = p.media === 'rj45' ? size : size * 0.62;
    // 孔的中心比格子中心低 2 像素，上方留給燈號
    return { id: p.id, media: p.media, cx: padX + cw * (col + 0.5), cy: padY + ch * (row + 0.5) + 2, pw, ph };
  });
}

const LED = { up: '#5dfc9b', amber: '#ffb53d', '': '#39425a' };

// ── 前面板貼圖：畫出連接埠與燈號。led(埠) 回傳 'up'（綠）、'amber'（STP 封鎖或等待中）或 ''（沒有連線） ──
function paintFace(u, dev, led) {
  const { ctx, canvas, tex } = u.face;
  const sig = dev.ports.map((p) => led(p.id)).join(',');
  if (u.face.sig === sig) return; // 燈號沒有變就不用重畫、重新上傳貼圖
  u.face.sig = sig;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = u.face.bg;
  ctx.fillRect(0, 0, W, H);
  for (const p of portGrid(dev, W, H)) {
    ctx.fillStyle = '#04060a';
    ctx.fillRect(p.cx - p.pw / 2, p.cy - p.ph / 2, p.pw, p.ph);
    ctx.fillStyle = LED[led(p.id)] || LED[''];
    ctx.fillRect(p.cx - p.pw / 2, p.cy - p.ph / 2 - 5, p.pw, 3.5);
  }
  tex.needsUpdate = true;
}

/**
 * 主機上的網路孔：做出一個看得見的插座，並記下它的位置與朝外的方向（設備的本地座標）。
 * (x, y, z) 是孔的中心，(nx, nz) 是朝外的方向，網路線會從這裡插進去。
 */
function jack(g, u, id, x, y, z, nx, nz, o = {}) {
  const w = o.w || 0.2, h = o.h || 0.16, t = o.t || 0.08;
  const dims = (lat, hh, dep) => (nx ? [dep, hh, lat] : [lat, hh, dep]);
  const at = (lat, yy, out) => [x + (nx ? 0 : lat) + nx * out, yy, z + (nx ? lat : 0) + nz * out];
  box(g, ...dims(w + 0.06, h + 0.07, t), mat(PALETTE.mid, { metal: 0.45, rough: 0.4 }), ...at(0, y + 0.005, -t / 2), 0.012);
  box(g, ...dims(w, h, 0.012), mat(0x04060a, { rough: 0.9 }), ...at(0, y, 0.001), 0.003);
  const led = box(g, ...dims(0.06, 0.022, 0.012), glow(PALETTE.screenOff, 0.4), ...at(w / 2 - 0.03, y + h / 2 + 0.02, 0.002), 0.003);
  (u.ports ||= {})[id] = { x, y, z, nx, nz, w, h, media: o.media || 'rj45' };
  (u.jackLed ||= {})[id] = led;
}

/** 一排網路孔：設備有幾個埠就做幾個，從 (x0) 開始每隔 dx 一個 */
function jacks(g, u, dev, x0, dx, y, z, nx, nz, o) {
  dev.ports.forEach((p, i) => jack(g, u, p.id, nx ? x0 : x0 + i * dx, y, nx ? z + i * dx : z, nx, nz, { media: p.media, ...o }));
}

function facePlate(g, u, w, h, z, y, bg = '#161c2b') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.max(40, Math.round((512 * h) / w));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6 }),
  );
  m.position.set(0, y, z + 0.004);
  g.add(m);
  u.face = { canvas, ctx: canvas.getContext('2d'), tex, bg };
}

function netBox(g, dev, u, o) {
  const { w, h, d, color, bg } = o;
  Object.assign(u, { w, h: h + (o.extraH || 0), d });
  box(g, w, h, d, mat(color, { rough: 0.5, metal: 0.25 }), 0, h / 2, 0, 0.06);
  // 發光飾條（依設備類別上色）
  const stripe = box(g, w * 0.86, 0.035, 0.07, glow(ACCENT[dev.kind], 1.3), 0, h + 0.012, d / 2 - 0.16, 0.015);
  u.stripe = stripe;
  const fw = w - 0.16, fh = h - 0.1;
  facePlate(g, u, fw, fh, d / 2, h / 2, bg);
  // 每個連接埠在機身上的位置：從貼圖的像素座標換算回來
  const { width: W, height: H } = u.face.canvas;
  u.ports = {};
  for (const p of portGrid(dev, W, H)) {
    u.ports[p.id] = {
      x: (p.cx / W - 0.5) * fw, y: h / 2 + (0.5 - p.cy / H) * fh, z: d / 2 + 0.004,
      nx: 0, nz: 1, w: (p.pw / W) * fw, h: (p.ph / H) * fh, media: p.media,
    };
  }
  u.rect = [-w / 2, w / 2, -d / 2, d / 2];
}

const BUILDERS = {
  pc(g, dev, u) {
    Object.assign(u, { w: 1.8, h: 1.65, d: 1.7 });
    const tilt = new THREE.Group();
    tilt.position.set(0, 0.48, -0.2);
    tilt.rotation.x = -0.1;
    g.add(tilt);
    box(tilt, 1.75, 1.08, 0.09, mat(PALETTE.dark), 0, 0.6, 0, 0.04);
    u.screen = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.93), glow(PALETTE.screenOff, 0.4));
    u.screen.position.set(0, 0.6, 0.05);
    tilt.add(u.screen);
    box(g, 0.14, 0.5, 0.1, mat(PALETTE.mid), 0, 0.27, -0.26);
    box(g, 0.75, 0.05, 0.46, mat(PALETTE.mid), 0, 0.025, -0.2);
    box(g, 1.2, 0.05, 0.4, mat(PALETTE.light), 0, 0.03, 0.55, 0.02);
    // 網路孔在底座後方（從正面可以從螢幕下緣的空隙看到）
    jacks(g, u, dev, 0.22, 0.3, 0.12, -0.43, 0, -1);
    u.rect = [-0.9, 0.9, -0.45, 0.77];
  },
  laptop(g, dev, u) {
    Object.assign(u, { w: 1.7, h: 1.15, d: 1.6 });
    box(g, 1.6, 0.07, 1.05, mat(PALETTE.mid, { metal: 0.3 }), 0, 0.035, 0.15, 0.03);
    box(g, 1.25, 0.012, 0.45, mat(PALETTE.dark), 0, 0.075, 0.02, 0.005);
    const lid = new THREE.Group();
    lid.position.set(0, 0.07, -0.37);
    lid.rotation.x = -0.32;
    g.add(lid);
    box(lid, 1.6, 1.02, 0.05, mat(PALETTE.dark), 0, 0.51, 0, 0.03);
    u.screen = new THREE.Mesh(new THREE.PlaneGeometry(1.46, 0.88), glow(PALETTE.screenOff, 0.4));
    u.screen.position.set(0, 0.51, 0.03);
    lid.add(u.screen);
    // 筆電的網路孔在機身左側
    jacks(g, u, dev, -0.8, 0.2, 0.065, -0.12, -1, 0, { w: 0.15, h: 0.07, t: 0.06 });
    u.rect = [-0.8, 0.8, -0.72, 0.68];
  },
  printer(g, dev, u) {
    Object.assign(u, { w: 1.7, h: 0.9, d: 1.6 });
    box(g, 1.6, 0.66, 1.2, mat(PALETTE.light), 0, 0.33, -0.1, 0.08);
    box(g, 1.3, 0.06, 0.85, mat(PALETTE.dark), 0, 0.68, -0.15, 0.03);
    box(g, 1.2, 0.2, 0.04, mat(PALETTE.black), 0, 0.3, 0.51, 0.01);
    box(g, 1.0, 0.025, 0.55, mat(0xffffff, { rough: 0.9 }), 0, 0.24, 0.72, 0.01);
    u.led = box(g, 0.12, 0.03, 0.05, glow(PALETTE.screenOff, 0.4), 0.6, 0.67, 0.4, 0.01);
    jacks(g, u, dev, 0.5, 0.3, 0.17, -0.7, 0, -1);
    u.rect = [-0.8, 0.8, -0.7, 1.0];
  },
  nas(g, dev, u) {
    Object.assign(u, { w: 1.2, h: 1.15, d: 1.4 });
    box(g, 0.95, 1.1, 1.2, mat(PALETTE.darker, { rough: 0.45 }), 0, 0.55, 0, 0.07);
    for (const x of [-0.21, 0.21]) box(g, 0.36, 0.82, 0.04, mat(PALETTE.dark), x, 0.5, 0.61, 0.02);
    u.led = box(g, 0.5, 0.035, 0.03, glow(PALETTE.screenOff, 0.4), 0, 1.0, 0.61, 0.012);
    jacks(g, u, dev, -0.16, 0.32, 0.22, -0.6, 0, -1);
    u.rect = [-0.475, 0.475, -0.6, 0.63];
  },
  tower(g, dev, u) {
    Object.assign(u, { w: 1.2, h: 1.55, d: 1.6 });
    box(g, 0.78, 1.5, 1.4, mat(PALETTE.dark, { rough: 0.45, metal: 0.2 }), 0, 0.75, 0, 0.06);
    box(g, 0.62, 1.05, 0.04, mat(PALETTE.black), 0, 0.62, 0.71, 0.02);
    for (let i = 0; i < 4; i++) box(g, 0.5, 0.05, 0.03, mat(PALETTE.mid, { metal: 0.4 }), 0, 0.28 + i * 0.2, 0.73, 0.01);
    u.led = box(g, 0.5, 0.035, 0.03, glow(PALETTE.screenOff, 0.4), 0, 1.32, 0.72, 0.012);
    jacks(g, u, dev, -0.15, 0.3, 0.3, -0.7, 0, -1);
    u.rect = [-0.39, 0.39, -0.7, 0.75];
  },
  rack1u(g, dev, u) {
    Object.assign(u, { w: 2.6, h: 0.62, d: 1.7 });
    box(g, 2.6, 0.07, 1.6, mat(PALETTE.mid, { metal: 0.4 }), 0, 0.035, 0, 0.02);
    box(g, 2.4, 0.2, 1.5, mat(PALETTE.dark, { metal: 0.3, rough: 0.45 }), 0, 0.19, 0, 0.03);
    box(g, 2.4, 0.2, 1.5, mat(PALETTE.darker, { metal: 0.3, rough: 0.45 }), 0, 0.42, 0, 0.03);
    for (let r = 0; r < 2; r++) for (let i = 0; i < 8; i++) {
      box(g, 0.2, 0.12, 0.03, mat(PALETTE.black), -0.98 + i * 0.24, 0.19 + r * 0.23, 0.755, 0.01);
    }
    u.led = box(g, 0.28, 0.035, 0.03, glow(PALETTE.screenOff, 0.4), 1.02, 0.42, 0.757, 0.012);
    // 機架式伺服器的網路卡在背面
    jacks(g, u, dev, 0.5, 0.34, 0.2, -0.75, 0, -1, { w: 0.2, h: 0.1 });
    u.rect = [-1.3, 1.3, -0.8, 0.8];
  },
  phone(g, dev, u) {
    Object.assign(u, { w: 0.95, h: 1.1, d: 0.95 });
    box(g, 0.42, 0.05, 0.36, mat(PALETTE.mid, { metal: 0.3 }), 0, 0.025, -0.08, 0.02);
    const tilt = new THREE.Group();
    tilt.position.set(0, 0.04, -0.1);
    tilt.rotation.x = -0.34;
    g.add(tilt);
    box(tilt, 0.54, 1.02, 0.07, mat(PALETTE.black, { rough: 0.35, metal: 0.3 }), 0, 0.51, 0, 0.05);
    u.screen = new THREE.Mesh(new THREE.PlaneGeometry(0.47, 0.93), glow(PALETTE.screenOff, 0.4));
    u.screen.position.set(0, 0.51, 0.038);
    tilt.add(u.screen);
  },
  ap(g, dev, u) {
    Object.assign(u, { w: 1.5, h: 2.15, d: 1.5 });
    const cyl = (r, hh, m, y) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh, 40), m);
      c.position.y = y;
      g.add(c);
      return c;
    };
    cyl(0.34, 0.06, mat(PALETTE.mid, { metal: 0.4 }), 0.03);
    cyl(0.035, 1.75, mat(PALETTE.mid, { metal: 0.5 }), 0.9);
    cyl(0.66, 0.17, mat(0xf2f5fb, { rough: 0.45 }), 1.86);
    u.led = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.035, 8, 48), glow(PALETTE.screenOff, 0.4));
    u.led.rotation.x = Math.PI / 2;
    u.led.position.y = 1.955;
    g.add(u.led);
    // 基地台的網路孔在底座後方
    jacks(g, u, dev, 0, 0.3, 0.08, -0.34, 0, -1, { w: 0.16, h: 0.09, t: 0.07 });
    u.rect = [-0.36, 0.36, -0.36, 0.36];
  },
  hub: (g, dev, u) => netBox(g, dev, u, { w: 1.6, h: 0.36, d: 1.0, color: 0xcfd5e2, bg: '#2a3144' }),
  'switch-s': (g, dev, u) => netBox(g, dev, u, { w: 1.9, h: 0.36, d: 1.05, color: 0x31507f, bg: '#141b2b' }),
  'switch-r': (g, dev, u) => netBox(g, dev, u, { w: 2.7, h: 0.42, d: 1.45, color: PALETTE.dark, bg: '#10151f' }),
  'switch-dc'(g, dev, u) {
    netBox(g, dev, u, { w: 3.2, h: 0.44, d: 1.8, color: 0x34405f, bg: '#0c1018' });
    for (const x of [-1.66, 1.66]) box(g, 0.1, 0.44, 0.1, mat(PALETTE.mid, { metal: 0.5 }), x, 0.22, 0.86, 0.02);
  },
  'router-home'(g, dev, u) {
    netBox(g, dev, u, { w: 2.0, h: 0.3, d: 1.25, color: 0x2b3350, bg: '#0c1018', extraH: 0.9 });
    for (const [x, rz] of [[-0.85, 0.22], [-0.3, 0.07], [0.3, -0.07], [0.85, -0.22]]) {
      const a = box(g, 0.075, 0.95, 0.075, mat(PALETTE.black, { rough: 0.4 }), x, 0.72, -0.52, 0.03);
      a.rotation.z = rz; a.rotation.x = -0.12;
    }
  },
  'router-s': (g, dev, u) => netBox(g, dev, u, { w: 1.5, h: 0.32, d: 0.95, color: 0xdfe4ee, bg: '#252c3e' }),
  'router-r'(g, dev, u) {
    netBox(g, dev, u, { w: 2.7, h: 0.52, d: 1.6, color: 0x3b4470, bg: '#10151f' });
    for (let i = 0; i < 9; i++) box(g, 0.14, 0.012, 0.9, mat(PALETTE.black), -0.96 + i * 0.24, 0.525, -0.2, 0.004);
  },
  firewall(g, dev, u) {
    netBox(g, dev, u, { w: 2.5, h: 0.42, d: 1.45, color: 0xe9ecf3, bg: '#252c3e' });
    box(g, 2.5, 0.43, 0.2, mat(PALETTE.orange, { rough: 0.5 }), 0, 0.215, -0.5, 0.06);
  },
  globe(g, dev, u) {
    Object.assign(u, { w: 2.4, h: 2.9, d: 2.4 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.14, 40), mat(PALETTE.dark, { metal: 0.4 }));
    base.position.y = 0.07;
    g.add(base);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.03, 8, 48), glow(PALETTE.sky, 1.5));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.16;
    g.add(ring);
    const spin = new THREE.Group();
    spin.position.y = 1.65;
    g.add(spin);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.86, 3), new THREE.MeshStandardMaterial({
      color: 0x16357a, emissive: 0x1f56d6, emissiveIntensity: 0.75, roughness: 0.35, flatShading: true,
    }));
    spin.add(core);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.06, 1)),
      new THREE.LineBasicMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.75 }),
    );
    spin.add(wire);
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.016, 6, 64), glow(PALETTE.sky, 1.2));
    orbit.rotation.set(1.25, 0.3, 0);
    spin.add(orbit);
    u.spin = spin;
    u.noShadowParts = [wire];
    // ISP 線路從底座正面接出來
    jacks(g, u, dev, 0, 0.3, 0.1, 0.9, 0, 1);
    u.rect = [-0.95, 0.95, -0.95, 0.95];
  },
};

export function buildDevice(dev) {
  const m = CATALOG[dev.model];
  const g = new THREE.Group();
  const u = (g.userData = { id: dev.id, kind: dev.kind, w: 2, h: 1, d: 1.2 });
  BUILDERS[m.shape](g, dev, u);
  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  if (u.screen) u.screen.castShadow = false;
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(u.w + 0.5, u.h + 0.3, u.d + 0.5),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.y = (u.h + 0.3) / 2;
  hit.userData.devId = dev.id;
  g.add(hit);
  u.hit = hit;
  g.position.set(dev.pos[0], 0, dev.pos[1]);
  return g;
}

/** 依目前狀態更新燈號 / 螢幕顏色。led(埠) 回傳 'up'、'amber' 或 '' */
export function refreshDevice(g, dev, led, off) {
  const u = g.userData;
  const ledOf = off ? () => '' : led;
  if (u.face) paintFace(u, dev, ledOf);
  if (u.jackLed) {
    for (const [id, m] of Object.entries(u.jackLed)) {
      const s = ledOf(id);
      const c = s === 'up' ? PALETTE.green : s === 'amber' ? PALETTE.amber : PALETTE.screenOff;
      if (m.material.userData.c !== c) { m.material = glow(c, s ? 1.9 : 0.4); m.material.userData.c = c; }
    }
  }
  if (u.stripe) u.stripe.visible = !off;
  const lamp = u.screen || u.led;
  if (lamp) {
    const i = dev.ifaces.find((x) => x.rt && x.rt.ip != null && x.rt.link);
    let c = PALETTE.screenOff, e = 0.35;
    if (dev.kind === 'ap') {
      if (!off) { c = PALETTE.sky; e = 1.9; }
    } else if (i) {
      if (i.rt.src === 'apipa') { c = PALETTE.amber; e = 1.0; }
      else { c = u.screen ? 0x3f7df0 : PALETTE.green; e = u.screen ? 1.1 : 1.8; }
    }
    if (lamp.material.userData.c !== c) {
      lamp.material = glow(c, e);
      lamp.material.userData.c = c;
    }
  }
}

let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
