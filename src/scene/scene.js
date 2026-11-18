// three.js 場景：等距視角的機房桌面、設備、網路線與封包動畫
import * as THREE from 'three';
import { buildDevice, refreshDevice, glowTexture, PALETTE, ACCENT } from './models.js';
import { CABLES, cableKind, CATALOG, primaryIface } from '../engine/model.js';
import { apRange } from '../engine/sim.js';
import { fmtIp } from '../engine/ip.js';
import { fmtIp6 } from '../engine/ip6.js';

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

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
    this.wifi = new Map(); // 'client>ap' → 曲線
    this.rings = new Map();
    this.wifiSig = '';
    this.fx = new THREE.Group();
    this.scene.add(this.world, this.cableGroup, this.wifiGroup, this.fx);

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

  pick(e) {
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
      this.hovered = dev;
      this.placeRing(this.hovRing, dev && dev !== this.selected ? dev : null);
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

  /** 畫出基地台的涵蓋範圍，以及每個無線用戶端連到基地台的虛線 */
  rebuildWifi(state) {
    this.clearWifi();
    const flat = (geo) => geo.rotateX(-Math.PI / 2);
    for (const d of Object.values(state.devices)) {
      const g = this.devices.get(d.id);
      if (!g || !d.wifi || state.rt.off[d.id] || !d.wifi.ssids.some((x) => !x.off && x.name)) continue;
      const r = apRange(d);
      const mk = (geo, opacity, y) => {
        const m = new THREE.Mesh(flat(geo), new THREE.MeshBasicMaterial({ color: 0x62c4ff, transparent: true, opacity, depthWrite: false }));
        m.position.set(g.position.x, y, g.position.z);
        this.wifiGroup.add(m);
        return m;
      };
      this.rings.set(d.id, { disc: mk(new THREE.CircleGeometry(r, 96), 0.03, 0.02), ring: mk(new THREE.RingGeometry(r - 0.07, r, 128), 0.2, 0.025) });
    }
    for (const [apId, list] of Object.entries(state.rt.clients)) {
      const ag = this.devices.get(apId);
      if (!ag) continue;
      const top = new THREE.Vector3(ag.position.x, ag.userData.h - 0.25, ag.position.z);
      for (const c of list) {
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

  rebuildCables(state) {
    this.clearCables();
    const ends = {};
    const sideOf = (A, B) => {
      const dx = B.pos[0] - A.pos[0], dz = B.pos[1] - A.pos[1];
      if (Math.abs(dz) >= 1.6) return dz > 0 ? 'front' : 'back';
      return dx > 0 ? 'right' : 'left';
    };
    const list = state.cables.map((c) => {
      const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
      const ea = { other: B, side: sideOf(A, B) }, eb = { other: A, side: sideOf(B, A) };
      ((ends[A.id] ||= {})[ea.side] ||= []).push(ea);
      ((ends[B.id] ||= {})[eb.side] ||= []).push(eb);
      return { c, ea, eb };
    });
    const NORMAL = { front: [0, 1], back: [0, -1], right: [1, 0], left: [-1, 0] };
    for (const [id, sides] of Object.entries(ends)) {
      const g = this.devices.get(id), u = g.userData;
      for (const [side, arr] of Object.entries(sides)) {
        const fb = side === 'front' || side === 'back';
        arr.sort((p, q) => (fb ? p.other.pos[0] - q.other.pos[0] : p.other.pos[1] - q.other.pos[1]));
        arr.forEach((e, k) => {
          const t = (k + 1) / (arr.length + 1) - 0.5;
          const [nx, nz] = NORMAL[side];
          e.n = new THREE.Vector3(nx, 0, nz);
          e.p = new THREE.Vector3(
            g.position.x + (fb ? t * u.w * 0.92 : (nx * u.w) / 2),
            0.07,
            g.position.z + (fb ? (nz * u.d) / 2 : t * u.d * 0.8),
          );
        });
      }
    }
    const plugMat = new THREE.MeshStandardMaterial({ color: 0xdfe5f0, roughness: 0.5 });
    for (const { c, ea, eb } of list) {
      const k = clamp(ea.p.distanceTo(eb.p) * 0.42, 0.7, 3.6);
      const curve = new THREE.CubicBezierCurve3(
        ea.p, ea.p.clone().addScaledVector(ea.n, k), eb.p.clone().addScaledVector(eb.n, k), eb.p,
      );
      const st = state.rt.cable[c.id];
      let color = CABLES[cableKind(c)].color, emis = 0.25;
      if (st === 'down') { color = 0x4a5470; emis = 0.02; } // 沒有燈號
      else if (st === 'blocked') { color = 0x9a7a2e; emis = 0.08; } // 被 STP 封鎖
      else if (st === 'susp') { color = 0xa04e5c; emis = 0.1; } // Port-channel 暫停
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 56, 0.055, 8, false),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: emis, roughness: 0.55 }),
      );
      mesh.userData.emis = emis;
      mesh.castShadow = true;
      const pick = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.24, 5, false), new THREE.MeshBasicMaterial({ visible: false }));
      pick.userData.cableId = c.id;
      const plugs = [ea, eb].map((e) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(e.n.x ? 0.26 : 0.17, 0.13, e.n.x ? 0.17 : 0.26), plugMat);
        m.position.copy(e.p).addScaledVector(e.n, 0.08);
        return m;
      });
      this.cableGroup.add(mesh, pick, ...plugs);
      this.cables.set(c.id, { a: c.a.dev, b: c.b.dev, curve, mesh, pick, plugs });
    }
  }

  sync(state) {
    this.state = state;
    const sig = state.cables.map((c) => `${c.id}:${c.a.dev}.${c.a.port}-${c.b.dev}.${c.b.port}:${state.rt.cable[c.id]}:${c.kind}`).join('|');
    if (sig !== this.cableSig) { this.cableSig = sig; this.rebuildCables(state); }
    const wsig = JSON.stringify([
      Object.values(state.devices).filter((d) => d.wifi).map((d) => [d.id, apRange(d), !!state.rt.off[d.id], d.wifi.ssids.filter((x) => !x.off && x.name).length]),
      Object.entries(state.rt.clients).map(([ap, l]) => [ap, l.map((c) => c.dev)]),
    ]);
    if (wsig !== this.wifiSig) { this.wifiSig = wsig; this.rebuildWifi(state); }
    const linked = {};
    for (const c of state.cables) {
      (linked[c.a.dev] ||= new Set()).add(c.a.port);
      (linked[c.b.dev] ||= new Set()).add(c.b.port);
    }
    for (const d of Object.values(state.devices)) {
      const g = this.devices.get(d.id);
      if (!g) continue;
      const off = !!state.rt.off[d.id];
      refreshDevice(g, d, linked[d.id] || new Set(), off);
      const l = this.labels.get(d.id);
      l.nm.textContent = d.name;
      let sub = '', cls = '';
      if (off) { sub = '沒有電（需要 PoE）'; cls = 'warn'; }
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
    return new Promise((resolve) => {
      this.anims.push({ t0: performance.now(), dur, step, resolve, always });
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
    const place = (obj, s, t) => { s.curve.getPointAt(clamp(t, 0, 1), p); obj.position.set(p.x, s.air ? p.y : 0.3, p.z); };
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
      this.setTag([esp ? 'ESP 加密' : '', kind ? kind + (h.proto === 'arp' ? ' 回覆' : '') : '', h.tag != null ? 'VLAN ' + h.tag : ''].filter(Boolean).join(' · '), esp ? 'esp' : kind ? h.proto : '');
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

    this.renderer.render(this.scene, this.cam);

    // HTML 標籤跟著設備走
    const v = new THREE.Vector3();
    for (const [id, l] of this.labels) {
      const g = this.devices.get(id), u = g.userData;
      v.set(g.position.x, 0, g.position.z + u.d / 2 + 0.25);
      const s = this.toScreen(v);
      l.el.style.transform = `translate(-50%, 0) translate(${s.x.toFixed(1)}px, ${(s.y + 6).toFixed(1)}px)`;
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
