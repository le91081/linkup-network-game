// LinkUp 主程式：把模擬引擎、3D 場景與介面串在一起
import './style.css';
import { Scene3D } from './scene/scene.js';
import { LEVELS } from './levels/index.js';
import { recompute, runObjective } from './engine/sim.js';
import { cloneState, addCable, cableAt, portOf } from './engine/model.js';
import * as hud from './ui/hud.js';
import { renderDevicePanel } from './ui/panel.js';
import { toast, sleep } from './ui/dom.js';
import { SANDBOX, installSandbox, sandboxObjectives } from './ui/sandbox.js';

// 網址加上 ?profile=名稱 就會用另一份獨立的進度（多人共用一台電腦，或測試時不想動到自己的存檔）
const PROFILE = (new URLSearchParams(location.search).get('profile') || '').replace(/[^\w-]/g, '').slice(0, 24);
const STORE_KEY = 'linkup.v1' + (PROFILE ? '.' + PROFILE : '');
const GREEN = 0x4ade80, RED = 0xff5d6c;
const $ = (id) => document.getElementById(id);

function loadStore() {
  const base = { done: {}, saves: {}, hints: {}, quiz: {}, seenHelp: false, last: null };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && typeof s === 'object') return { ...base, ...s };
  } catch { /* 無痕模式等情況：不存檔也能玩 */ }
  return base;
}

const app = {
  el: { stage: $('stage'), topbar: $('topbar'), mission: $('mission'), panel: $('panel'), console: $('console') },
  store: loadStore(),
  level: null, levelIdx: 0, state: null,
  results: [], running: false, hintsShown: 0,
  selected: null, panelTab: {}, pinned: {}, adv: new Set(), termLog: {}, termHist: {}, refreshers: [],

  undoStack: [], redoStack: [], snap: '',

  saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(app.store)); } catch { /* ignore */ }
  },

  loadLevel(idx, opts) { app.openLevel(LEVELS[idx], opts); },
  openSandbox(opts) { app.openLevel(SANDBOX, opts); },

  openLevel(lv, { fresh = false } = {}) {
    const idx = LEVELS.indexOf(lv);
    let st = null;
    const saved = !fresh && app.store.saves[lv.id];
    if (saved) {
      try {
        const base = lv.setup();
        const same = lv.sandbox || Object.keys(base.devices).sort().join() === Object.keys(saved.devices).sort().join();
        if (same) { st = cloneState(saved); recompute(st); }
      } catch { st = null; }
    }
    if (!st) { st = lv.setup(); recompute(st); }
    if (fresh) { delete app.store.saves[lv.id]; delete app.store.hints[lv.id]; }
    Object.assign(app, {
      level: lv, levelIdx: idx, state: st, results: [], running: false, selected: null,
      hintsShown: app.store.hints[lv.id] || 0, panelTab: {}, pinned: {}, adv: new Set(), termLog: {}, termHist: {}, refreshers: [],
      undoStack: [], redoStack: [], snap: JSON.stringify(cloneState(st)), cliSess: {},
    });
    app.store.last = lv.id;
    app.runToken = (app.runToken || 0) + 1;
    app.saveStore();
    hud.closePopover();
    hud.renderTopbar(app);
    hud.renderMission(app);
    app.renderPanel();
    app.con.empty();
    updateInsets();
    app.scene.fast = true; // 中止上一關還在播的動畫
    app.scene.playToken++;
    app.scene.load(st);
    app.scene.fast = false;
  },

  /** 任何設定或接線變動之後呼叫 */
  changed() {
    recompute(app.state);
    app.scene.sync(app.state);
    const now = JSON.stringify(cloneState(app.state));
    if (now !== app.snap) {
      if (!app.restoring) {
        app.undoStack.push(app.snap);
        if (app.undoStack.length > 80) app.undoStack.shift();
        app.redoStack = [];
      }
      app.snap = now;
      hud.updateHistory(app);
    }
    let marked = false;
    for (const r of app.results) if (r && r !== 'running' && !r.stale) { r.stale = true; marked = true; }
    if (marked) hud.renderMission(app);
    for (const f of app.refreshers) f();
    if (app.level.sandbox && document.activeElement?.closest?.('#mission') == null) hud.renderMission(app);
    clearTimeout(app.saveTimer);
    app.saveTimer = setTimeout(() => {
      app.store.saves[app.level.id] = cloneState(app.state);
      app.saveStore();
    }, 400);
  },

  /** 重新整理面板上會即時更新的區塊（命中次數、紀錄、ARP 快取…） */
  refreshLive() { for (const f of app.refreshers) f(); },

  undo() { app.timeTravel(app.undoStack, app.redoStack, '已復原上一個變更'); },
  redo() { app.timeTravel(app.redoStack, app.undoStack, '已重做'); },
  timeTravel(from, to, msg) {
    if (app.running || !from.length) return;
    to.push(app.snap);
    const sel = app.selected;
    app.state = JSON.parse(from.pop());
    app.cliSess = {}; // CLI 的設定模式指向舊的物件，全部回到最外層
    recompute(app.state);
    app.scene.playToken++; // 中止還在播的封包動畫
    app.scene.load(app.state, { keep: true });
    app.selected = app.state.devices[sel] ? sel : null;
    app.scene.select(app.selected);
    app.restoring = true;
    app.changed();
    app.restoring = false;
    hud.closePopover();
    hud.updateHistory(app);
    hud.renderMission(app);
    app.renderPanel();
    toast(msg);
  },

  /** 故障模擬：把設備關機或重新開機 */
  togglePower(id) {
    const st = app.state, d = st.devices[id];
    const down = { ...(st.down || {}) };
    if (down[id]) delete down[id]; else down[id] = true;
    st.down = down;
    app.changed();
    app.renderPanel();
    toast(down[id] ? `${d.name} 已關機 — 可以測試其他路徑有沒有接手` : `${d.name} 已開機`, down[id] ? 'bad' : 'ok');
    app.scene.pulse(id, down[id] ? RED : GREEN, true);
  },

  renderPanel() {
    if (!renderDevicePanel(app, app.el.panel)) hud.renderGuide(app, app.el.panel);
  },

  select(id) {
    if (app.selected === id) return;
    app.selected = id;
    app.scene.select(id);
    app.renderPanel();
  },

  /** 從設備 a 拖曳到設備 b */
  link(a, b) {
    const st = app.state, A = st.devices[a], B = st.devices[b];
    const free = (d) => d.ports.filter((p) => !cableAt(st, d.id, p.id));
    const fa = free(A), fb = free(B);
    const noPort = !A.ports.length ? A : !B.ports.length ? B : null;
    if (noPort) return toast(`${noPort.name} 沒有網路孔，只能用 Wi-Fi 連線（點它 → 網路設定）`, 'bad');
    if (!fa.length) return toast(`${A.name} 已經沒有空的連接埠`, 'bad');
    if (!fb.length) return toast(`${B.name} 已經沒有空的連接埠`, 'bad');
    let pair = null;
    for (const pa of fa) {
      const pb = fb.find((q) => q.media === pa.media);
      if (pb) { pair = [pa, pb]; break; }
    }
    if (!pair) return toast(`${A.name} 與 ${B.name} 的接頭規格不同，無法直接對接`, 'bad');
    const simple = (d) => d.kind === 'hub' || d.kind === 'switch' || ((d.kind === 'host' || d.kind === 'internet') && d.ports.length === 1);
    if (simple(A) && simple(B)) return app.connect(a, pair[0].id, b, pair[1].id);
    hud.openPortPick(app, a, b);
  },

  connect(a, pa, b, pb, kind) {
    const st = app.state;
    const err = addCable(st, a, pa, b, pb, kind);
    if (err) return toast(err, 'bad');
    const A = st.devices[a], B = st.devices[b];
    app.changed();
    app.renderPanel();
    const cable = st.cables[st.cables.length - 1];
    const why = st.rt.why[cable.id];
    if (why) {
      toast(`線接上了，但沒有燈號：${why}`, 'bad', 6000);
      app.scene.pulse(a, RED);
      app.scene.pulse(b, RED);
    } else {
      toast(`已接線：${A.name} [${portOf(A, pa).label}] ↔ ${B.name} [${portOf(B, pb).label}]`, 'ok');
      app.scene.pulse(a, GREEN);
      app.scene.pulse(b, GREEN);
    }
  },

  fastForward() { app.scene.fast = true; },

  /** 這一關的目標；自由模式用的是玩家自己存的目標 */
  objectives() { return app.level.sandbox ? sandboxObjectives(app.state) : app.level.objectives; },

  /** 執行任務目標（不給 indices 就全部執行） */
  async run(indices) {
    const objs = app.objectives();
    if (app.running || !objs.length) return;
    const lv = app.level;
    const token = (app.runToken = (app.runToken || 0) + 1);
    const list = indices || objs.map((_, i) => i);
    app.running = true;
    app.scene.fast = false;
    app.scene.clearBubbles();
    if (!indices) app.results = [];
    app.con.clear();
    $('console').classList.remove('min');
    for (const i of list) {
      if (app.runToken !== token) return;
      const o = objs[i];
      if (!o) continue;
      app.results[i] = 'running';
      hud.renderMission(app);
      const r = runObjective(app.state, o);
      app.con.group(`目標 ${i + 1}　${o.label}`);
      app.con.lines(r.log, app.state);
      app.refreshLive();
      await app.scene.playHops(r.hops);
      if (app.runToken !== token) return;
      feedback(o, r);
      app.results[i] = r;
      app.con.result(r.pass, r.pass ? '✔ 通過' : '✘ 未通過' + (o.expect === false ? '：這條連線應該被擋下來' : r.reason ? '：' + r.reason : ''));
      hud.renderMission(app);
      if (!app.scene.fast) await sleep(r.hops.length ? 480 : 200);
    }
    app.running = false;
    app.scene.fast = false;
    hud.renderMission(app);
    const all = objs.every((_, i) => app.results[i] && app.results[i].pass && !app.results[i].stale);
    if (all && lv.sandbox) toast(`${objs.length} 個目標全部通過 ✔`, 'ok');
    else if (all) app.complete();
  },

  /** 終端機指令觸發的單次追蹤 */
  showTrace(title, log, hops, res) {
    if (app.running) return;
    app.con.clear();
    $('console').classList.remove('min');
    app.con.group(title);
    app.con.lines(log, app.state);
    app.refreshLive();
    app.scene.fast = false;
    app.scene.clearBubbles();
    app.scene.playHops(hops).then((finished) => {
      if (!finished || !res) return;
      if (res.ok) app.con.result(true, '✔ 成功');
      else {
        app.con.result(false, '✘ ' + res.reason);
        if (res.failDev) { app.scene.bubble(res.failDev, res.reason, 'fail'); app.scene.pulse(res.failDev, RED, true); }
      }
    });
  },

  useHint() {
    app.hintsShown = Math.min(app.level.hints.length, app.hintsShown + 1);
    app.store.hints[app.level.id] = app.hintsShown;
    app.saveStore();
  },

  async complete() {
    const lv = app.level;
    const stars = Math.max(1, 3 - app.hintsShown);
    app.store.done[lv.id] = { stars: Math.max(stars, app.store.done[lv.id]?.stars || 0) };
    app.saveStore();
    const ids = Object.keys(app.state.devices);
    ids.forEach((id, n) => setTimeout(() => app.scene.pulse(id, GREEN, true), n * 70));
    await sleep(900);
    if (app.level === lv) hud.openComplete(app, stars);
  },
};

function feedback(o, r) {
  const sc = app.scene;
  const src = o.from || o.dev || (o.test && o.test.from);
  if (r.pass) {
    if (o.expect === false) {
      if (r.failDev) { sc.bubble(r.failDev, '已擋下 ✔', 'ok', 2600); sc.pulse(r.failDev, GREEN, true); }
    } else if (src) sc.pulse(src, GREEN, true);
  } else if (o.expect === false) {
    if (src) { sc.bubble(src, '這條連線不應該通，但現在通了', 'fail'); sc.pulse(src, RED, true); }
  } else {
    const d = r.failDev || src;
    if (d) { sc.bubble(d, r.reason, 'fail'); sc.pulse(d, RED, true); }
  }
}

function updateInsets() {
  const m = app.el.mission.getBoundingClientRect(), p = app.el.panel.getBoundingClientRect(), t = app.el.topbar.getBoundingClientRect();
  app.scene.setInsets({ left: m.right + 4, right: window.innerWidth - p.left + 4, top: t.bottom + 4, bottom: 236 });
}

// ───────────── 啟動 ─────────────
for (const k of ['topbar', 'mission', 'panel', 'console']) app.el[k].classList.add('glass');
app.con = hud.initConsole(app);
app.scene = new Scene3D(app.el.stage, {
  onSelect: (id) => app.select(id),
  onLink: (a, b) => app.link(a, b),
  onCable: (id, x, y) => hud.openCableMenu(app, id, x, y),
  canMove: () => !!app.level.sandbox,
  onMoved: () => app.sandboxMoved(),
});
installSandbox(app, { renderMission: () => hud.renderMission(app) });

window.addEventListener('resize', () => { updateInsets(); app.scene.fit(); });
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (e.key === 'Escape') {
    if (hud.modalOpen()) hud.closeModal();
    else if (typing) document.activeElement.blur();
    else app.select(null);
  } else if (e.code === 'Space' && !typing && app.running) {
    app.fastForward();
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase()) && !hud.modalOpen()) {
    // 正在輸入文字時，讓瀏覽器自己處理輸入框的復原
    const el = document.activeElement;
    const editing = tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type));
    if (editing) return;
    if (e.key.toLowerCase() === 'y' || e.shiftKey) app.redo(); else app.undo();
    e.preventDefault();
  }
});

if (app.store.last === 'sandbox') app.openSandbox();
else app.loadLevel(Math.max(0, LEVELS.findIndex((l) => l.id === app.store.last)));
hud.openLevels(app);
window.linkup = app; // 方便在主控台除錯
