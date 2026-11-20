// three.js 場景：等距視角的機房桌面、設備、網路線與封包動畫
import * as THREE from 'three';
import { buildDevice, refreshDevice, glowTexture, PALETTE, ACCENT } from './models.js';
import { CABLES, cableKind, CATALOG, primaryIface } from '../engine/model.js';
import { apRange, rfAt, ssidsOf } from '../engine/sim.js';
import { fmtIp } from '../engine/ip.js';
import { fmtIp6 } from '../engine/ip6.js';

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

// ── 網路線的走線 ──
const FLOOR = 0.075; // 線躺在桌面上的高度
const MARGIN = 0.2; // 繞過機身時和機身保持的距離
const LANE = 0.13; // 同一側有好幾條線要繞時，一條比一條靠外

/** 線段 a→b（只看水平面）有沒有穿過往外放大 m 之後的矩形 */
function crossesRect(a, b, r, m) {
  let t0 = 0, t1 = 1;
  for (const [s, d, lo, hi] of [[a.x, b.x - a.x, r.x0 - m, r.x1 + m], [a.z, b.z - a.z, r.z0 - m, r.z1 + m]]) {
    if (Math.abs(d) < 1e-9) {
      if (s <= lo || s >= hi) return false;
      continue;
    }
    let u0 = (lo - s) / d, u1 = (hi - s) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0);
    t1 = Math.min(t1, u1);
    if (t1 - t0 < 1e-6) return false;
  }
  return true;
}

/**
 * 從連接埠出來之後要怎麼繞過自己的機身。start 是線落到桌面的那一點（已經在機身外面），
 * target 是要去的方向。直接走不會穿過機身就不用繞；會的話從左右兩邊挑比較短的那一邊。
 */
function detour(e, start, target, lanes, commit) {
  const r = e.rect, m = MARGIN - 0.04;
  if (!crossesRect(start, target, r, m)) return [];
  const faceZ = e.n.z !== 0; // 埠在正面或背面：先沿著 x 方向繞到側邊
  const opts = [-1, 1].map((s) => {
    const key = (faceZ ? 'x' : 'z') + s;
    const off = MARGIN + LANE * (lanes[key] || 0);
    const pts = [];
    if (faceZ) {
      const x = s < 0 ? r.x0 - off : r.x1 + off;
      pts.push(new THREE.Vector3(x, FLOOR, start.z));
      if (crossesRect(pts[0], target, r, m)) pts.push(new THREE.Vector3(x, FLOOR, e.n.z > 0 ? r.z0 - off : r.z1 + off));
    } else {
      const z = s < 0 ? r.z0 - off : r.z1 + off;
      pts.push(new THREE.Vector3(start.x, FLOOR, z));
      if (crossesRect(pts[0], target, r, m)) pts.push(new THREE.Vector3(e.n.x > 0 ? r.x0 - off : r.x1 + off, FLOOR, z));
    }
    let len = 0, q = start;
    for (const p of [...pts, target]) { len += q.distanceTo(p); q = p; }
    return { key, pts, len };
  });
  const best = opts[0].len <= opts[1].len ? opts[0] : opts[1];
  if (commit) lanes[best.key] = (lanes[best.key] || 0) + 1;
  return best.pts;
}

/**
 * 網路線的曲線。水平方向平滑地通過每一個折點；高度另外算：整條線躺在桌面上，
 * 只有靠近兩端的連接埠時才抬起來（插在孔裡的那一小段是水平的）。
 * 高度如果也交給樣條去內插，長的線段會被前面的下降帶著往下衝，鑽到桌面底下。
 */
class CableCurve extends THREE.Curve {
  constructor(pts, ends) {
    super();
    this.base = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, FLOOR, p.z)), false, 'centripetal');
    this.ends = ends; // [{ x, z, y, out }]：孔的位置、高度，以及離孔多遠才落到桌面
  }

  getPoint(t, target = new THREE.Vector3()) {
    this.base.getPoint(t, target);
    let y = FLOOR;
    for (const e of this.ends) {
      const d = Math.hypot(target.x - e.x, target.z - e.z);
      const k = clamp((d - 0.24) / Math.max(0.05, e.out - 0.24), 0, 1);
      y = Math.max(y, FLOOR + (e.y - FLOOR) * (1 - k * k * (3 - 2 * k)));
    }
    target.y = y;
    return target;
  }
}

const PKT_COLOR = { req: 0x7df3ff, reply: 0x7dffb0, dns: 0xc9b0ff, esp: 0xffc857, arp: 0xff9f5a, dhcp: 0xff8fd0 };
const PKT_TAG = { arp: 'ARP', dhcp: 'DHCP' };

export class Scene3D {
  constructor(host, handlers) {
    this.host = host;
    this.h = handlers;
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.view = { target: new THREE.Vector3(), az: -0.36, el: 0.92, span: 22 };
    this.devices = new Map(); // id → Group
    this.cables = new Map(); // id → { a, b, curve, mesh, pick }
    this.labels = new Map();
    this.bubbles = [];
    this.anims = [];
    this.pulses = [];
    this.fast = false;
    this.playToken = 0;
    this.state = null;
    this.cableSig = '';

    this.canvas = document.createElement('canvas');
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('class', 'scene-overlay');
    this.linkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.linkPath.setAttribute('class', 'link-line');
    this.overlay.append(this.linkPath);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'scene-labels';
    host.append(this.canvas, this.overlay, this.labelLayer);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.scene.add(new THREE.HemisphereLight(0xd6e4ff, 0x1c2540, 1.25));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.3);
    this.sun.position.set(-9, 20, 11);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 5;
    this.scene.add(this.sun, this.sun.target);
    const fill = new THREE.DirectionalLight(0x7fa5ff, 0.55);
    fill.position.set(12, 7, -9);
    this.scene.add(fill);

    this.world = new THREE.Group();
    this.cableGroup = new THREE.Group();
    this.wifiGroup = new THREE.Group();
    this.wallGroup = new THREE.Group();
    this.wifi = new Map(); // 'client>ap' → 曲線
    this.rings = new Map();
    this.wifiSig = '';
    this.fx = new THREE.Group();
    this.scene.add(this.world, this.cableGroup, this.wifiGroup, this.wallGroup, this.fx);

    const ringGeo = new THREE.RingGeometry(0.93, 1, 64);
    ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
    this.hovRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false }));
    this.selRing.visible = this.hovRing.visible = false;
    this.fx.add(this.selRing, this.hovRing);
    this.ringGeo = ringGeo;

    // 封包（核心 + 光暈 + 兩顆拖尾）
    this.packet = new THREE.Group();
    this.pktMat = new THREE.MeshBasicMaterial({ color: PKT_COLOR.req });
    this.packet.add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), this.pktMat));
    this.pktGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: PKT_COLOR.req, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    this.pktGlow.scale.setScalar(1.25);
    this.packet.add(this.pktGlow);
    this.tail = [0.09, 0.06].map((r) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), this.pktMat);
      this.fx.add(m);
      m.visible = false;
      return m;
    });
    this.packet.visible = false;
    this.fx.add(this.packet);
    // 廣播與 Hub 複製出來的訊框：同時在好幾條線上移動的小光點
    this.ghosts = [];
    this.ghostGeo = new THREE.SphereGeometry(0.1, 12, 8);
    this.tagPos = null;
    this.tagEl = document.createElement('div');
    this.tagEl.className = 'pkt-tag';
    this.labelLayer.append(this.tagEl);

    this.ray = new THREE.Raycaster();
    this.ground = new THREE.Plane(UP, 0);
    this.selected = null;
    this.hovered = null;
    this.down = null;

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', () => this.endDrag());
    c.addEventListener('pointerleave', () => { if (!this.down) this.setHover(null); });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.last = performance.now();
    const loop = (t) => { this.tick(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ───────────── 相機 ─────────────
  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.W = w; this.H = h;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.updateCamera();
  }

  viewDir() {
    const { az, el } = this.view;
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  }

  updateCamera() {
    const v = this.view, cam = this.cam;
    cam.position.copy(v.target).addScaledVector(this.viewDir(), 150);
    cam.up.copy(UP);
    cam.lookAt(v.target);
    const aspect = this.W / this.H;
    cam.top = v.span / 2; cam.bottom = -v.span / 2;
    cam.left = (-v.span * aspect) / 2; cam.right = (v.span * aspect) / 2;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  setInsets(i) {
    Object.assign(this.insets, i);
  }

  /** 把整個關卡放進面板之間的可視區域 */
  fit(animate = false) {
    const token = (this.fitToken = (this.fitToken || 0) + 1); // 新的一次對焦會取消還在播放的舊動畫
    if (!this.devices.size) {
      this.view.span = 22;
      this.view.target.set(0, 0, 0);
      this.updateCamera();
      return;
    }
    const v = this.view;
    const dir = this.viewDir();
    const right = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const p = new THREE.Vector3();
    for (const g of this.devices.values()) {
      const u = g.userData;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, u.h]) {
        p.set(g.position.x + sx * (u.w / 2 + 1.3), y, g.position.z + sz * (u.d / 2 + 1.1)); // 留邊給設備下方的標籤
        const a = p.dot(right), b = p.dot(up);
        x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b);
      }
    }
    const ins = this.insets;
    // 再扣掉一些像素，留給會超出設備外框的名稱標籤
    const availW = Math.max(220, this.W - ins.left - ins.right - 90), availH = Math.max(200, this.H - ins.top - ins.bottom - 40);
    const span = clamp(Math.max(((x1 - x0) * this.H) / availW, ((y1 - y0) * this.H) / availH) * 1.06, 14, 70);
    const upp = span / this.H;
    const t = new THREE.Vector3()
      .addScaledVector(right, (x0 + x1) / 2 - ((ins.left - ins.right) / 2) * upp)
      .addScaledVector(up, (y0 + y1) / 2 + ((ins.top - ins.bottom) / 2) * upp);
    t.addScaledVector(dir, -t.y / dir.y);
    if (!animate) {
      v.span = span; v.target.copy(t);
      this.updateCamera();
      return;
    }
    const s0 = v.span, t0 = v.target.clone();
    this.anim(520, (k) => {
      if (token !== this.fitToken) return;
      v.span = s0 + (span - s0) * k;
      v.target.lerpVectors(t0, t, k);
      this.updateCamera();
    }, true);
  }

  ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  groundAt(e) {
    this.ray.setFromCamera(this.ndc(e), this.cam);
    return this.ray.ray.intersectPlane(this.ground, new THREE.Vector3());
  }

  toScreen(v3) {
    const p = v3.clone().project(this.cam);
    return { x: (p.x * 0.5 + 0.5) * this.W, y: (-p.y * 0.5 + 0.5) * this.H };
  }

  /** 指標下面的設備標籤（標籤畫在設備上面，所以先看標籤：點標籤、從標籤拖曳接線都算那台設備） */
  labelAt(e) {
    let best = null, z = -Infinity;
    for (const [id, l] of this.labels) {
      const r = l.el.getBoundingClientRect();
      if (!r.width || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
      const lz = l.el.classList.contains('hov') || l.el.classList.contains('sel') ? 1e9 : +l.el.style.zIndex || 0;
      if (lz >= z) { best = id; z = lz; }
    }
    return best;
  }

  pick(e) {
    const lab = this.labelAt(e);
    if (lab) return { dev: lab };
    this.ray.setFromCamera(this.ndc(e), this.cam);
    const hits = this.ray.intersectObjects([...this.devices.values()].map((g) => g.userData.hit), false);
    if (hits.length) return { dev: hits[0].object.userData.devId };
    const ch = this.ray.intersectObjects([...this.cables.values()].map((c) => c.pick), false);
    if (ch.length) return { cable: ch[0].object.userData.cableId };
    return {};
  }

  // ───────────── 輸入 ─────────────
  onDown(e) {
    const hit = e.button === 0 ? this.pick(e) : {};
    this.down = {
      x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false,
      mode: e.button === 2 ? 'rotate' : hit.dev ? (e.shiftKey && this.h.canMove && this.h.canMove() ? 'move' : 'dev') : 'pan', dev: hit.dev, cable: hit.cable,
    };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真正的指標，可以忽略 */ }
  }

  onMove(e) {
    const d = this.down;
    if (!d) {
      const hit = this.pick(e);
      this.setHover(hit.dev || null, hit.cable || null);
      return;
    }
    const dx = e.clientX - d.lx, dy = e.clientY - d.ly;
    d.lx = e.clientX; d.ly = e.clientY;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) {
      d.moved = true;
      if (d.mode === 'dev') this.h.onLinkStart?.(d.dev);
    }
    if (!d.moved) return;
    const v = this.view;
    if (d.mode === 'pan' || d.mode === 'rotate') this.fitToken = (this.fitToken || 0) + 1; // 使用者自己移動視角時，停止自動對焦
    if (d.mode === 'pan') {
      const upp = v.span / this.H;
      const r = new THREE.Vector3(Math.cos(v.az), 0, -Math.sin(v.az));
      const f = new THREE.Vector3(-Math.sin(v.az), 0, -Math.cos(v.az));
      v.target.addScaledVector(r, -dx * upp).addScaledVector(f, (dy * upp) / Math.sin(v.el));
      this.updateCamera();
      this.canvas.style.cursor = 'grabbing';
    } else if (d.mode === 'rotate') {
      v.az -= dx * 0.005;
      v.el = clamp(v.el + dy * 0.004, 0.55, 1.35);
      this.updateCamera();
    } else if (d.mode === 'move') {
      // 自由模式：按住 Shift 拖曳可以移動設備（對齊到 0.5 的格線）
      const p = this.groundAt(e);
      if (p) {
        const g = this.devices.get(d.dev);
        const x = Math.round(p.x * 2) / 2, z = Math.round(p.z * 2) / 2;
        this.state.devices[d.dev].pos = [x, z];
        g.position.set(x, 0, z);
        this.cableSig = '';
        this.wifiSig = '';
        this.sync(this.state);
        this.placeRing(this.selRing, this.selected);
      }
      this.canvas.style.cursor = 'move';
    } else if (d.mode === 'dev') {
      const g = this.devices.get(d.dev);
      const s = this.toScreen(new THREE.Vector3(g.position.x, g.userData.h * 0.5, g.position.z));
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const cy = Math.min(s.y, my) - 40;
      this.linkPath.setAttribute('d', `M${s.x},${s.y} Q${(s.x + mx) / 2},${cy} ${mx},${my}`);
      this.linkPath.style.display = 'block';
      const hit = this.pick(e);
      const tgt = hit.dev && hit.dev !== d.dev ? hit.dev : null;
      this.setHover(tgt);
      this.linkPath.classList.toggle('ok', !!tgt);
      this.canvas.style.cursor = 'crosshair';
    }
  }

  onUp(e) {
    const d = this.down;
    if (!d) return;
    this.endDrag();
    if (d.mode === 'dev') {
      if (!d.moved) this.h.onSelect?.(d.dev);
      else {
        const hit = this.pick(e);
        if (hit.dev && hit.dev !== d.dev) this.h.onLink?.(d.dev, hit.dev);
        else this.h.onLinkCancel?.();
      }
    } else if (d.mode === 'move') {
      if (d.moved) this.h.onMoved?.(d.dev);
      else this.h.onSelect?.(d.dev);
    } else if (d.mode === 'pan' && !d.moved) {
      if (d.cable) this.h.onCable?.(d.cable, e.clientX, e.clientY);
      else this.h.onSelect?.(null);
    }
  }

  endDrag() {
    this.down = null;
    this.linkPath.style.display = 'none';
    this.canvas.style.cursor = '';
  }

  onWheel(e) {
    e.preventDefault();
    this.fitToken = (this.fitToken || 0) + 1; // 使用者自己操作視角時，停止自動對焦
    const v = this.view;
    const before = this.groundAt(e);
    v.span = clamp(v.span * Math.exp(e.deltaY * 0.0012), 7, 80);
    this.updateCamera();
    const after = this.groundAt(e);
    if (before && after) { v.target.add(before.sub(after)); this.updateCamera(); }
  }

  setHover(dev, cable = null) {
    if (this.hovered !== dev) {
      const was = this.hovered && this.labels.get(this.hovered);
      if (was) was.el.classList.remove('hov');
      this.hovered = dev;
      this.placeRing(this.hovRing, dev && dev !== this.selected ? dev : null);
      const now = dev && this.labels.get(dev);
      if (now) now.el.classList.add('hov');
    }
    if (this.hovCable !== cable) {
      if (this.hovCable && this.cables.has(this.hovCable)) { const m = this.cables.get(this.hovCable).mesh; m.material.emissiveIntensity = m.userData.emis; }
      this.hovCable = cable;
      if (cable && this.cables.has(cable)) this.cables.get(cable).mesh.material.emissiveIntensity = 1.1;
    }
    if (!this.down) this.canvas.style.cursor = dev || cable ? 'pointer' : '';
  }

  placeRing(ring, id) {
    const g = id && this.devices.get(id);
    ring.visible = !!g;
    if (!g) return;
    const u = g.userData;
    const r = Math.hypot(u.w, u.d) / 2 + 0.35;
    ring.scale.set(r, 1, r);
    ring.position.set(g.position.x, 0.02, g.position.z);
    ring.material.color.setHex(ACCENT[u.kind] || 0xffffff);
  }

  select(id) {
    this.selected = id;
    this.placeRing(this.selRing, id);
    if (this.hovered === id) this.hovRing.visible = false;
    for (const [k, l] of this.labels) l.el.classList.toggle('sel', k === id);
    this.emphasizeRing();
  }

  // ───────────── Wi-Fi 視覺化 ─────────────
  clearWifi() {
    for (const o of [...this.wifiGroup.children]) { this.wifiGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.wifi.clear();
    this.rings.clear();
  }

  emphasizeRing() {
    for (const [id, r] of this.rings) {
      const on = id === this.selected;
      r.ring.material.opacity = on ? 0.75 : 0.2;
      r.disc.material.opacity = on ? 0.1 : 0.03;
    }
  }

  /** 牆：半透明的牆體，顏色代表材質（衰減越大越深） */
  rebuildWalls(state) {
    for (const o of [...this.wallGroup.children]) { this.wallGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }
    const COLOR = { drywall: 0xd9dee8, glass: 0x9fd8ff, wood: 0xc49a6c, brick: 0xb5654a, concrete: 0x8a8f99, metal: 0x5b6472 };
    for (const w of state.walls || []) {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const glass = w.mat === 'glass';
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 1.9, glass ? 0.08 : 0.16),
        new THREE.MeshStandardMaterial({ color: COLOR[w.mat] || COLOR.drywall, roughness: glass ? 0.1 : 0.85, metalness: w.mat === 'metal' ? 0.6 : 0, transparent: true, opacity: glass ? 0.22 : 0.5, depthWrite: false }));
      m.position.set((w.a[0] + w.b[0]) / 2, 0.95, (w.a[1] + w.b[1]) / 2);
      m.rotation.y = -Math.atan2(dz, dx);
      m.userData.wall = w.id;
      this.wallGroup.add(m);
    }
  }

  /** 訊號熱力圖：每一格取最強的基地台，-55 dBm 以上綠色、-67 黃綠、-72 黃、-78 橘，再弱就收不到 */
  heatmap(state, aps) {
    const xs = [], zs = [];
    for (const d of Object.values(state.devices)) { xs.push(d.pos[0]); zs.push(d.pos[1]); }
    for (const w of state.walls || []) { xs.push(w.a[0], w.b[0]); zs.push(w.a[1], w.b[1]); }
    const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3, z0 = Math.min(...zs) - 3, z1 = Math.max(...zs) + 3;
    const step = 0.2, cols = Math.ceil((x1 - x0) / step), rows = Math.ceil((z1 - z0) / step);
    const cv = document.createElement('canvas');
    cv.width = cols; cv.height = rows;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(cols, rows);
    const STOPS = [[-50, [46, 204, 113, 0.42]], [-60, [132, 214, 70, 0.36]], [-67, [190, 226, 60, 0.32]], [-72, [250, 204, 21, 0.28]], [-78, [251, 146, 60, 0.22]]];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pos = [x0 + (c + 0.5) * step, z0 + (r + 0.5) * step];
        let best = -999;
        for (const ap of aps) { const f = rfAt(state, ap, pos); best = Math.max(best, f.band ? f.rssi : f.rssi24); }
        let col = null;
        if (best >= STOPS[0][0]) col = STOPS[0][1];
        else for (let k = 1; k < STOPS.length; k++) {
          if (best < STOPS[k][0]) continue;
          const [hi, ca] = STOPS[k - 1], [lo, cb] = STOPS[k], t = (best - lo) / (hi - lo);
          col = ca.map((v, n) => cb[n] + (v - cb[n]) * t);
          break;
        }
        const o = (r * cols + c) * 4;
        if (col) { img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = Math.round(col[3] * 255); }
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    const geo = new THREE.PlaneGeometry(cols * step, rows * step);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.position.set(x0 + (cols * step) / 2, 0.02, z0 + (rows * step) / 2);
    this.wifiGroup.add(m);
  }

  /** 畫出基地台的涵蓋範圍，以及每個無線用戶端連到基地台的虛線 */
  rebuildWifi(state) {
    this.clearWifi();
    const flat = (geo) => geo.rotateX(-Math.PI / 2);
    // 有牆的地方訊號不是一個圓：改畫熱力圖
    if ((state.walls || []).length) {
      const aps = Object.values(state.devices).filter((d) => d.wifi && !state.rt.off[d.id] && !(state.down || {})[d.id] && ssidsOf(state, d).some((x) => !x.off && x.name));
      if (aps.length) this.heatmap(state, aps);
    }
    for (const d of Object.values(state.devices)) {
      if ((state.walls || []).length) break;
      const g = this.devices.get(d.id);
      if (!g || !d.wifi || state.rt.off[d.id] || !ssidsOf(state, d).some((x) => !x.off && x.name)) continue;
      const r = apRange(d);
      const mk = (geo, opacity, y) => {
        const m = new THREE.Mesh(flat(geo), new THREE.MeshBasicMaterial({ color: 0x62c4ff, transparent: true, opacity, depthWrite: false }));
        m.position.set(g.position.x, y, g.position.z);
        this.wifiGroup.add(m);
        return m;
      };
      this.rings.set(d.id, { disc: mk(new THREE.CircleGeometry(r, 96), 0.03, 0.02), ring: mk(new THREE.RingGeometry(r - 0.07, r, 128), 0.2, 0.025) });
    }
    for (const [owner, list] of Object.entries(state.rt.clients)) {
      for (const c of list) {
        const apId = c.ap || owner, ag = this.devices.get(apId);
        if (!ag || !(state.devices[apId] || {}).wifi) continue;
        const top = new THREE.Vector3(ag.position.x, ag.userData.h - 0.25, ag.position.z);
        const cg = this.devices.get(c.dev);
        const from = new THREE.Vector3(cg.position.x, cg.userData.h * 0.75, cg.position.z);
        const mid = from.clone().lerp(top, 0.5);
        mid.y = Math.max(from.y, top.y) + 1.1;
        const curve = new THREE.QuadraticBezierCurve3(from, mid, top);
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)),
          new THREE.LineDashedMaterial({ color: 0x8fdcff, dashSize: 0.22, gapSize: 0.16, transparent: true, opacity: 0.8 }),
        );
        line.computeLineDistances();
        this.wifiGroup.add(line);
        this.wifi.set(c.dev + '>' + apId, curve);
      }
    }
    this.emphasizeRing();
  }

  // ───────────── 建立 / 同步 ─────────────
  load(state, opts = {}) {
    for (const g of this.devices.values()) this.world.remove(g);
    for (const l of this.labels.values()) l.el.remove();
    for (const b of this.bubbles) b.el.remove();
    this.devices.clear(); this.labels.clear(); this.bubbles = [];
    this.clearCables();
    this.clearWifi();
    this.wifiSig = '';
    if (this.board) { this.world.remove(this.board); this.board.geometry.dispose(); }
    this.select(null);
    this.setHover(null);
    this.packet.visible = false;
    this.tail.forEach((t) => (t.visible = false));
    this.hideGhosts();
    this.tagPos = null;
    this.tagEl.style.display = 'none';
    this.state = state;

    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const d of Object.values(state.devices)) {
      const g = buildDevice(d);
      this.world.add(g);
      this.devices.set(d.id, g);
      const u = g.userData;
      x0 = Math.min(x0, d.pos[0] - u.w / 2); x1 = Math.max(x1, d.pos[0] + u.w / 2);
      z0 = Math.min(z0, d.pos[1] - u.d / 2); z1 = Math.max(z1, d.pos[1] + u.d / 2);
      const el = document.createElement('div');
      el.className = 'dev-label k-' + d.kind;
      el.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="sub"></span>';
      this.labelLayer.append(el);
      this.labels.set(d.id, { el, nm: el.querySelector('.nm'), sub: el.querySelector('.sub') });
    }
    if (!this.devices.size) { x0 = -8; x1 = 8; z0 = -5; z1 = 5; }
    for (const w of state.walls || []) for (const p of [w.a, w.b]) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    this.rebuildWalls(state);
    this.buildBoard(x0 - 2.4, x1 + 2.4, z0 - 2.2, z1 + 2.6);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.max(x1 - x0, z1 - z0) / 2 + 8;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx - 9, 22, cz + 11);
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 70 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.cableSig = '';
    this.sync(state);
    if (!opts.keep || !this.devices.size) this.fit();
  }

  buildBoard(x0, x1, z0, z1) {
    const r = 1.1;
    const s = new THREE.Shape();
    const ax = x0, bx = x1, ay = -z1, by = -z0; // Shape 的 y 對應世界座標的 -z
    s.moveTo(ax + r, ay);
    s.lineTo(bx - r, ay); s.quadraticCurveTo(bx, ay, bx, ay + r);
    s.lineTo(bx, by - r); s.quadraticCurveTo(bx, by, bx - r, by);
    s.lineTo(ax + r, by); s.quadraticCurveTo(ax, by, ax, by - r);
    s.lineTo(ax, ay + r); s.quadraticCurveTo(ax, ay, ax + r, ay);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.36, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 3, curveSegments: 16 });
    geo.rotateX(-Math.PI / 2);
    if (!this.boardMats) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = '#18203a'; x.fillRect(0, 0, 128, 128);
      x.fillStyle = '#2c3861';
      x.beginPath(); x.arc(64, 64, 4.5, 0, Math.PI * 2); x.fill();
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      this.boardMats = [
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }),
        new THREE.MeshStandardMaterial({ color: 0x2a3660, roughness: 0.8 }),
      ];
    }
    this.board = new THREE.Mesh(geo, this.boardMats);
    this.board.position.y = -0.42;
    this.board.receiveShadow = true;
    this.world.add(this.board);
  }

  clearCables() {
    for (const c of this.cables.values()) {
      this.cableGroup.remove(c.mesh, c.pick, ...c.plugs);
      c.mesh.geometry.dispose(); c.pick.geometry.dispose();
    }
    this.cables.clear();
    this.hovCable = null;
  }

  /** 一條線的一端：連接埠在場景裡的位置、朝外的方向、孔的大小，以及這台設備機身佔的範圍 */
  portEnd(devId, portId, otherId) {
    const g = this.devices.get(devId), u = g.userData;
    const r = u.rect || [-u.w / 2, u.w / 2, -u.d / 2, u.d / 2];
    const rect = { x0: g.position.x + r[0], x1: g.position.x + r[1], z0: g.position.z + r[2], z1: g.position.z + r[3] };
    const p = u.ports && u.ports[portId];
    if (p) {
      return {
        dev: devId, rect, w: p.w, h: p.h, media: p.media,
        p: new THREE.Vector3(g.position.x + p.x, p.y, g.position.z + p.z), n: new THREE.Vector3(p.nx, 0, p.nz),
      };
    }
    // 模型上沒有這個埠：接在朝向對方的那一側
    const o = this.devices.get(otherId);
    const dx = o.position.x - g.position.x, dz = o.position.z - g.position.z;
    const n = Math.abs(dz) >= Math.abs(dx) ? new THREE.Vector3(0, 0, dz > 0 ? 1 : -1) : new THREE.Vector3(dx > 0 ? 1 : -1, 0, 0);
    const pos = new THREE.Vector3(n.x > 0 ? rect.x1 : n.x < 0 ? rect.x0 : g.position.x, 0.1, n.z > 0 ? rect.z1 : n.z < 0 ? rect.z0 : g.position.z);
    return { dev: devId, rect, w: 0.16, h: 0.13, media: 'rj45', p: pos, n };
  }

  rebuildCables(state) {
    this.clearCables();
    const lanes = {}; // 設備 → 每一側已經有幾條線繞過去
    const plugMat = {
      rj45: new THREE.MeshStandardMaterial({ color: 0xe8edf6, roughness: 0.35, transparent: true, opacity: 0.92 }),
      sfp: new THREE.MeshStandardMaterial({ color: 0x9aa4b8, roughness: 0.35, metalness: 0.75 }),
    };
    for (const c of state.cables) {
      if (!this.devices.has(c.a.dev) || !this.devices.has(c.b.dev)) continue;
      const ea = this.portEnd(c.a.dev, c.a.port, c.b.dev), eb = this.portEnd(c.b.dev, c.b.port, c.a.dev);
      // 每一端：插在孔裡的一小段是直的，出來之後往下落到桌面
      const lead = (e) => {
        const out = 0.4 + Math.max(0, e.p.y - FLOOR); // 孔越高，落地點離機身越遠，上下兩排的線才不會疊在一起
        return {
          out,
          inside: e.p.clone().addScaledVector(e.n, -0.03),
          plug: e.p.clone().addScaledVector(e.n, 0.26),
          floor: new THREE.Vector3(e.p.x + e.n.x * out, FLOOR, e.p.z + e.n.z * out),
        };
      };
      const la = lead(ea), lb = lead(eb);
      const lanesA = (lanes[ea.dev] ||= {}), lanesB = (lanes[eb.dev] ||= {});
      let wa = detour(ea, la.floor, lb.floor, lanesA, false);
      const wb = detour(eb, lb.floor, wa.length ? wa[wa.length - 1] : la.floor, lanesB, true);
      wa = detour(ea, la.floor, wb.length ? wb[wb.length - 1] : lb.floor, lanesA, true);
      const pts = [];
      for (const p of [la.inside, la.plug, la.floor, ...wa, ...wb.slice().reverse(), lb.floor, lb.plug, lb.inside]) {
        if (!pts.length || pts[pts.length - 1].distanceTo(p) > 0.08) pts.push(p);
      }
      const curve = new CableCurve(pts, [[ea, la], [eb, lb]].map(([e, l]) => ({ x: e.p.x, z: e.p.z, y: e.p.y, out: l.out })));
      const len = curve.getLength();
      // 高密度交換器的孔比較小，線也跟著細一點
      const radius = clamp(0.5 * Math.min(ea.w, eb.w, ea.h * 1.4, eb.h * 1.4), 0.03, 0.05);
      const st = state.rt.cable[c.id];
      let color = CABLES[cableKind(c)].color, emis = 0.25;
      if (st === 'down') { color = 0x4a5470; emis = 0.02; } // 沒有燈號
      else if (st === 'blocked') { color = 0x9a7a2e; emis = 0.08; } // 被 STP 封鎖
      else if (st === 'susp') { color = 0xa04e5c; emis = 0.1; } // Port-channel 暫停
      const waiting = st !== 'down' && state.rt.wait && state.rt.wait[c.id] > 0; // 有燈號，但 STP 還沒讓它轉送資料
      if (waiting) { color = 0xf5a623; emis = 0.3; }
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, clamp(Math.round(len / 0.09), 40, 260), radius, 7, false),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: emis, roughness: 0.55 }),
      );
      mesh.userData.emis = emis;
      mesh.castShadow = true;
      const pick = new THREE.Mesh(new THREE.TubeGeometry(curve, clamp(Math.round(len / 0.4), 16, 80), 0.24, 5, false), new THREE.MeshBasicMaterial({ visible: false }));
      pick.userData.cableId = c.id;
      // 插頭：大小跟著孔走，一小截插在孔裡，其餘露在外面
      const plugs = [ea, eb].map((e) => {
        const fiber = e.media !== 'rj45';
        const w = Math.min(0.16, e.w * 0.86), h = Math.min(fiber ? 0.08 : 0.12, e.h * 0.86), l = 0.24;
        const m = new THREE.Mesh(new THREE.BoxGeometry(e.n.x ? l : w, h, e.n.x ? w : l), fiber ? plugMat.sfp : plugMat.rj45);
        m.position.copy(e.p).addScaledVector(e.n, l / 2 - 0.03);
        m.castShadow = true;
        return m;
      });
      this.cableGroup.add(mesh, pick, ...plugs);
      this.cables.set(c.id, { a: c.a.dev, b: c.b.dev, curve, mesh, pick, plugs, waiting });
    }
  }

  sync(state) {
    this.state = state;
    const sig = state.cables.map((c) => `${c.id}:${c.a.dev}.${c.a.port}-${c.b.dev}.${c.b.port}:${state.rt.cable[c.id]}:${c.kind}:${state.rt.wait && state.rt.wait[c.id] > 0 ? 'w' : ''}`).join('|');
    if (sig !== this.cableSig) { this.cableSig = sig; this.rebuildCables(state); }
    const wsig = JSON.stringify([
      Object.values(state.devices).filter((d) => d.wifi).map((d) => [d.id, apRange(d), !!state.rt.off[d.id] || !!(state.down || {})[d.id] || (state.rt.booting || {})[d.id] > 0, ssidsOf(state, d).filter((x) => !x.off && x.name).length, ...((state.walls || []).length ? d.pos.map((v) => Math.round(v * 4)) : [])]),
      (state.walls || []).map((w) => [w.a, w.b, w.mat]),
      Object.entries(state.rt.clients).map(([ap, l]) => [ap, l.map((c) => c.dev + '@' + (c.ap || ap))]),
    ]);
    if (wsig !== this.wifiSig) { this.wifiSig = wsig; this.rebuildWifi(state); }
    // 每個埠的燈號：有連線是綠色，被 STP 封鎖、Port-channel 暫停或還在等待是琥珀色，沒有連線不亮
    const led = {};
    for (const c of state.cables) {
      const st = state.rt.cable[c.id];
      const v = st === 'down' ? '' : st === 'blocked' || st === 'susp' || (state.rt.wait && state.rt.wait[c.id] > 0) ? 'amber' : 'up';
      (led[c.a.dev] ||= {})[c.a.port] = v;
      (led[c.b.dev] ||= {})[c.b.port] = v;
    }
    for (const d of Object.values(state.devices)) {
      const g = this.devices.get(d.id);
      if (!g) continue;
      const down = !!(state.down || {})[d.id];
      const booting = (state.rt.booting || {})[d.id] > 0 ? Math.ceil(state.rt.booting[d.id]) : 0;
      const off = down || booting > 0 || !!state.rt.off[d.id];
      refreshDevice(g, d, (pid) => (led[d.id] || {})[pid] || '', off);
      const l = this.labels.get(d.id);
      l.nm.textContent = d.name;
      let sub = '', cls = '';
      if (down) { sub = '已關機'; cls = 'warn'; }
      else if (booting && !isFinite(booting)) { sub = 'ROMMON · 沒有開機成功'; cls = 'warn'; }
      else if (booting) { sub = `開機中 · 還要 ${booting} 秒`; cls = 'warn'; }
      else if (off) { sub = '沒有電（需要 PoE）'; cls = 'warn'; }
      else if (d.kind === 'host') {
        const i = primaryIface(d);
        const wl = d.ifaces.find((x) => x.bind.t === 'wlan');
        const g6 = state.v6 && d.ifaces.map((x) => x.rt.v6 && x.rt.v6.addrs[0]).find(Boolean);
        if (!i && g6) {
          const t = fmtIp6(g6.ip); // IPv6 位址很長：中間省略，保留前綴與結尾
          sub = t.length > 22 ? t.slice(0, 12) + '…' + t.slice(-8) : t;
          cls = 'on';
        }
        else if (!i) { sub = wl && wl.wifi.ssid && !wl.rt.assoc ? 'Wi-Fi 未連線' : '未設定 IP'; cls = 'off'; }
        else if (!i.rt.link) { sub = fmtIp(i.rt.ip) + ' · 未連線'; cls = 'off'; }
        else { sub = fmtIp(i.rt.ip) + (d.rt.vpn && d.rt.vpn.up ? ' · VPN' : ''); cls = i.rt.src === 'apipa' ? 'warn' : 'on'; }
      } else {
        sub = CATALOG[d.model].title.replace(/^(Cisco|TP-Link|Ubiquiti|Fortinet|NETGEAR|ASUS) /, '');
        cls = 'net';
      }
      l.sub.textContent = sub;
      l.el.dataset.s = cls;
    }
  }

  // ───────────── 動畫 ─────────────
  anim(dur, step, always = false) {
    // 分頁在背景時瀏覽器不會畫畫面，動畫也就永遠播不完：直接跳到結尾，測試才不會卡住
    if (document.hidden) { step(1); return Promise.resolve(); }
    return new Promise((resolve) => {
      const a = { t0: performance.now(), dur, step, resolve, always };
      this.anims.push(a);
      // 視窗被遮住或面板收起來時，瀏覽器可能不再呼叫繪圖的回呼：用計時器保底
      setTimeout(() => {
        const n = this.anims.indexOf(a);
        if (n >= 0) { this.anims.splice(n, 1); step(1); resolve(); }
      }, dur + 500);
    });
  }

  pulse(devId, color = 0xffffff, big = false) {
    const g = this.devices.get(devId);
    if (!g) return;
    const u = g.userData;
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    m.position.set(g.position.x, 0.03, g.position.z);
    const r0 = Math.hypot(u.w, u.d) / 2 + 0.2;
    this.fx.add(m);
    this.pulses.push({ m, t0: performance.now(), dur: big ? 900 : 520, r0, r1: r0 + (big ? 2.2 : 0.9) });
  }

  bubble(devId, text, kind = 'fail', ms = 5200) {
    const el = document.createElement('div');
    el.className = 'bubble ' + kind;
    el.textContent = text;
    this.labelLayer.append(el);
    this.bubbles = this.bubbles.filter((b) => {
      if (b.dev === devId) { b.el.remove(); return false; }
      return true;
    });
    this.bubbles.push({ el, dev: devId, until: performance.now() + ms });
  }

  clearBubbles() {
    for (const b of this.bubbles) b.el.remove();
    this.bubbles = [];
  }

  /** 一段行程對應的曲線（網路線或無線電波）與方向 */
  seg(h) {
    if (h.wifi) {
      const up = this.wifi.get(h.from + '>' + h.to);
      const curve = up || this.wifi.get(h.to + '>' + h.from);
      return curve ? { curve, fwd: !!up, air: true } : null;
    }
    const c = this.cables.get(h.cable);
    return c ? { curve: c.curve, fwd: c.a === h.from, air: false } : null;
  }

  ghost(i, color, opacity = 0.9) {
    let g = this.ghosts[i];
    if (!g) {
      g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
      const glow = new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
      const sp = new THREE.Sprite(glow);
      sp.scale.setScalar(0.95);
      g.add(new THREE.Mesh(this.ghostGeo, mat), sp);
      g.userData = { mat, glow };
      this.fx.add(g);
      this.ghosts[i] = g;
    }
    g.userData.mat.color.setHex(color);
    g.userData.glow.color.setHex(color);
    g.userData.mat.opacity = opacity;
    g.userData.glow.opacity = opacity * 0.8;
    g.visible = true;
    return g;
  }

  hideGhosts() { for (const g of this.ghosts) g.visible = false; }

  setTag(text, cls) {
    this.tagEl.style.display = text ? 'block' : 'none';
    this.tagEl.textContent = text;
    this.tagEl.className = 'pkt-tag' + (cls ? ' ' + cls : '');
  }

  /** 沿著網路線播放封包的每一段行程 */
  async playHops(hops) {
    const token = ++this.playToken;
    const p = new THREE.Vector3();
    const place = (obj, s, t) => { s.curve.getPointAt(clamp(t, 0, 1), p); obj.position.set(p.x, s.air ? p.y : p.y + 0.22, p.z); };
    this.hideGhosts();
    for (const h of hops) {
      if (token !== this.playToken) return false;
      if (this.fast) continue;
      if (h.wave) {
        // 廣播：同一層的每一條線同時送出一份
        const color = PKT_COLOR[h.proto] || PKT_COLOR.req;
        this.packet.visible = false;
        this.tail.forEach((t) => (t.visible = false));
        for (const level of h.wave) {
          const segs = level.map((x) => ({ to: x.to, s: this.seg(x) })).filter((y) => y.s);
          if (!segs.length) continue;
          const gs = segs.map((_, i) => this.ghost(i, color));
          this.tagPos = gs[0].position;
          this.setTag((PKT_TAG[h.proto] || '') + ' 廣播', h.proto);
          const len = Math.max(...segs.map((y) => y.s.curve.getLength()));
          await this.anim(clamp(len * 46, 220, 560), (k) => {
            if (token !== this.playToken) return;
            segs.forEach((y, i) => place(gs[i], y.s, y.s.fwd ? k : 1 - k));
          });
          if (token !== this.playToken) return false;
          this.hideGhosts();
          for (const y of segs) this.pulse(y.to, color);
        }
        this.tagPos = null;
        this.setTag('');
        continue;
      }
      const c = this.seg(h);
      if (!c) continue;
      const esp = h.proto === 'esp';
      const color = esp ? PKT_COLOR.esp : PKT_TAG[h.proto] ? PKT_COLOR[h.proto] : h.reply ? PKT_COLOR.reply : h.proto === 'udp' ? PKT_COLOR.dns : PKT_COLOR.req;
      this.pktMat.color.setHex(color);
      this.pktGlow.material.color.setHex(color);
      this.packet.visible = true;
      this.tail.forEach((t) => (t.visible = true));
      const kind = PKT_TAG[h.proto];
      this.setTag([esp ? (h.ssl ? 'TLS 加密' : 'ESP 加密') : '', kind ? kind + (h.proto === 'arp' ? ' 回覆' : '') : '', h.tag != null ? 'VLAN ' + h.tag : ''].filter(Boolean).join(' · '), esp ? 'esp' : kind ? h.proto : '');
      // Hub 會把同一份訊框複製到其他每一個埠
      const leaks = (h.leak || []).map((x) => this.seg(x)).filter(Boolean);
      const lg = leaks.map((_, i) => this.ghost(i, color, 0.55));
      const len = c.curve.getLength();
      await this.anim(clamp(len * 46, 190, 560), (k) => {
        if (token !== this.playToken) return;
        const t = c.fwd ? k : 1 - k;
        place(this.packet, c, t);
        this.tail.forEach((m, i) => place(m, c, t + (c.fwd ? -1 : 1) * 0.045 * (i + 1)));
        leaks.forEach((s, i) => place(lg[i], s, s.fwd ? k : 1 - k));
      });
      if (token !== this.playToken) return false;
      this.hideGhosts();
      this.pulse(h.to, color);
    }
    if (token !== this.playToken) return false;
    this.packet.visible = false;
    this.tail.forEach((t) => (t.visible = false));
    this.hideGhosts();
    this.tagPos = null;
    this.setTag('');
    return true;
  }

  tick(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    for (const g of this.devices.values()) if (g.userData.spin) g.userData.spin.rotation.y += dt * 0.35;

    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      const k = this.fast && !a.always ? 1 : clamp((now - a.t0) / a.dur, 0, 1);
      a.step(ease(k));
      if (k >= 1) { this.anims.splice(i, 1); a.resolve(); }
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      const k = clamp((now - p.t0) / p.dur, 0, 1);
      const r = p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - k, 3));
      p.m.scale.set(r, 1, r);
      p.m.material.opacity = 0.9 * (1 - k);
      if (k >= 1) { this.fx.remove(p.m); p.m.material.dispose(); this.pulses.splice(i, 1); }
    }
    if (this.selRing.visible) this.selRing.material.opacity = 0.75 + 0.2 * Math.sin(now / 260);
    // 還在 STP listening / learning 的線：像交換器上的琥珀色燈號一樣閃爍
    for (const c of this.cables.values()) if (c.waiting) c.mesh.material.emissiveIntensity = 0.12 + 0.45 * (0.5 + 0.5 * Math.sin(now / 170));

    this.renderer.render(this.scene, this.cam);

    // HTML 標籤跟著設備走。離鏡頭近的（畫面上比較下面的）疊在上面；畫面縮得很小時只留名稱，避免互相蓋住
    const v = new THREE.Vector3();
    const compact = this.H / this.view.span < 22;
    if (compact !== this.compactLabels) { this.compactLabels = compact; this.labelLayer.classList.toggle('compact', compact); }
    // 標籤不要跑到兩側面板或下方的封包追蹤底下：寬度每隔一段時間量一次（每一格都量會讓瀏覽器一直重新排版）
    this.frameNo = (this.frameNo || 0) + 1;
    if (this.frameNo % 15 === 1 || !this.labelW || this.labelW.size !== this.labels.size) { this.labelW = new Map(); for (const [id, l] of this.labels) this.labelW.set(id, l.el.offsetWidth); }
    const ins = this.insets, xl = ins.left + 6, xr = this.W - ins.right - 6, yb = this.H - ins.bottom - 26;
    for (const [id, l] of this.labels) {
      const g = this.devices.get(id), u = g.userData;
      v.set(g.position.x, 0, g.position.z + u.d / 2 + 0.25);
      const s = this.toScreen(v);
      const hw = (this.labelW.get(id) || 0) / 2;
      // 只推回「被切到一部分」的標籤；設備整個移出畫面（使用者自己平移）的標籤就讓它跟著走
      if (xr - xl > hw * 2 && s.x > xl - hw && s.x < xr + hw) s.x = Math.min(Math.max(s.x, xl + hw), xr - hw);
      if (yb > ins.top && s.y > yb && s.y < yb + 40) s.y = yb;
      l.el.style.transform = `translate(-50%, 0) translate(${s.x.toFixed(1)}px, ${(s.y + (compact ? 3 : 6)).toFixed(1)}px)`;
      const z = String(Math.round(s.y));
      if (l.el.style.zIndex !== z) l.el.style.zIndex = z;
    }
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      if (now > b.until) { b.el.remove(); this.bubbles.splice(i, 1); continue; }
      const g = this.devices.get(b.dev);
      if (!g) continue;
      v.set(g.position.x, g.userData.h + 0.35, g.position.z);
      const s = this.toScreen(v);
      b.el.style.transform = `translate(-50%, -100%) translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
    }
    if ((this.packet.visible || this.tagPos) && this.tagEl.style.display !== 'none') {
      const s = this.toScreen(this.tagPos || this.packet.position);
      this.tagEl.style.transform = `translate(-50%, -100%) translate(${s.x.toFixed(1)}px, ${(s.y - 14).toFixed(1)}px)`;
    }
  }
}

export { PALETTE };
