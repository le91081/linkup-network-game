// LinkUp 主程式：把模擬引擎、3D 場景與介面串在一起
import { apsOf, rfAt } from './engine/sim/wifi.js';
import { meshServes } from './engine/mesh.js';
import './style.css';
import { Scene3D } from './scene/scene.js';
import { LEVELS } from './levels/index.js';
import { recompute, runObjective, advance, settle, pendingOf, fmtDur } from './engine/sim.js';
import { takeScriptNews } from './engine/script.js';
import { cloneState, addCable, cableAt, portOf } from './engine/model.js';
import { SAVE_VER, migrateState, migrateStore } from './engine/migrate.js';
import { installShortcuts } from './ui/keys.js';
import { sfx } from './ui/sound.js';
import * as hud from './ui/hud.js';
import { renderDevicePanel } from './ui/panel.js';
import { toast, sleep, h, button } from './ui/dom.js';
import { SANDBOX, installSandbox, sandboxObjectives } from './ui/sandbox.js';
import { installKb } from './ui/kb.js';
import { installTables } from './ui/tables.js';
import { isIos, iosDirty, saveStartup, restoreStartup } from './engine/ios.js';
import { makeDrill, openDrillComplete, fmtSecs } from './ui/drill.js';
import { scoreOf } from './ui/score.js';
import { customLevel } from './ui/editor.js';
import { renderTopo, bindTopoView, topoPacket, topoPulse } from './ui/topo2d.js';
import { exportTopoDialog, ipPlanDialog } from './ui/docexport.js';
import { tutorialTick } from './ui/tutorial.js';

// 網址加上 ?profile=名稱 就會用另一份獨立的進度（多人共用一台電腦，或測試時不想動到自己的存檔）
const PROFILE = (new URLSearchParams(location.search).get('profile') || '').replace(/[^\w-]/g, '').slice(0, 24);
const STORE_KEY = 'linkup.v1' + (PROFILE ? '.' + PROFILE : '');
const GREEN = 0x4ade80, RED = 0xff5d6c;
/** 復原 / 重做比對的是「設定」：時間與隨時間變化的狀態不算在內，復原也不會讓時間倒流 */
const snapOf = (st) => { const c = cloneState(st); delete c.clock; delete c.dyn; return JSON.stringify(c); };
const $ = (id) => document.getElementById(id);

function loadStore() {
  const base = { done: {}, saves: {}, hints: {}, quiz: {}, seenHelp: false, last: null };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && typeof s === 'object') return migrateStore({ ...base, ...s }); // 舊版本的存檔：升級成目前的格式
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
  speed: 1, paused: false,

  saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(app.store)); } catch { /* ignore */ }
  },

  loadLevel(idx, opts) { app.openLevel(LEVELS[idx], opts); },
  /** 故障演練：meta = { base, count, seed, timed }。resume 是重新整理頁面後接著做 */
  openDrill(meta, { resume = false } = {}) {
    const base = LEVELS.find((l) => l.id === meta.base);
    if (!base) return;
    let m = { ...meta }, lv = makeDrill(base, m);
    // 有的網路找不到適合的故障（例如只有 IPv6 的關卡）：換一個種子再試，還是不行就換關卡
    if (!resume) {
      for (let k = 0; k < 4; k++) { lv.setup(); if (lv.faults.length) break; m = { ...m, seed: m.seed + 7919 }; lv = makeDrill(base, m); }
      if (!lv.faults.length) { toast(`「${base.title}」找不到適合的故障，換一個網路試試`, 'bad'); return; }
    }
    app.store.drill = m;
    app.openLevel(lv, { fresh: !resume });
  },
  openSandbox(opts) { app.openLevel(SANDBOX, opts); },
  /** 自訂關卡（自由模式做的、或匯入的）。test 是從自由模式按「試玩」 */
  openCustom(c, { test = false } = {}) {
    const lv = customLevel(c);
    lv.test = test;
    if (test) app.store.customTest = c; // 還沒存成自訂關卡也能在重新整理後接著玩
    app.openLevel(lv, { fresh: true });
  },
  renderMissionNow() { hud.renderMission(app); },

  openLevel(lv, { fresh = false } = {}) {
    const idx = LEVELS.indexOf(lv);
    let st = null;
    let saved = !fresh && app.store.saves[lv.id];
    if (saved && migrateState(saved).newer) saved = null; // 比較新的版本存的：這個版本讀不懂，當作沒有存檔（存檔本身留著）
    if (saved) {
      try {
        const base = lv.setup();
        const same = lv.sandbox || Object.keys(base.devices).sort().join() === Object.keys(saved.devices).sort().join();
        if (same) { st = cloneState(saved); recompute(st); }
      } catch { st = null; }
    }
    if (!st) { st = lv.setup(); recompute(st); }
    // 關卡一開始的設定就是 IOS 設備已經存檔的 startup-config
    for (const d of Object.values(st.devices)) if (isIos(d) && d.startup == null) saveStartup(d);
    if (fresh) { delete app.store.saves[lv.id]; delete app.store.hints[lv.id]; }
    Object.assign(app, {
      level: lv, levelIdx: idx, state: st, results: [], running: false, selected: null,
      hintsShown: app.store.hints[lv.id] || 0, panelTab: {}, pinned: {}, adv: new Set(), termLog: {}, termHist: {}, refreshers: [],
      undoStack: [], redoStack: [], snap: snapOf(st), cliSess: {}, remote: {}, knownHosts: {}, conSeen: {}, capUi: {}, lastHops: [], t2: { z: 1, px: 0, py: 0 },
    });
    app.store.last = lv.id;
    // 這一關的作答紀錄：實際花的時間、完整測試的次數、設定變更的次數（重置就重新開始）
    const att = (app.store.att ||= {});
    if (fresh || !att[lv.id] || lv.drill) att[lv.id] = { ms: 0, runs: 0, changes: 0 };
    app.attempt = att[lv.id];
    app.timeUp = false;
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
    hud.updateClock(app);
    app.render2d();
    tutorialTick(app);
  },

  /** 模擬時間前進 n 秒 */
  tick(n) {
    const before = pendingOf(app.state).map((p) => p.text + p.at).join('|');
    advance(app.state, n);
    // 關卡劇本的事件（線路被挖斷、修好）：跳出通知
    for (const t of takeScriptNews(app.state)) toast(t.text, t.tone, 6000);
    app.scene.sync(app.state);
    app.refreshLive();
    hud.updateClock(app);
    app.render2d();
    // 有東西收斂完成了：之前的測試結果不再準確
    if (pendingOf(app.state).map((p) => p.text + p.at).join('|') !== before) {
      let marked = false;
      for (const r of app.results) if (r && r !== 'running' && !r.stale) { r.stale = true; marked = true; }
      if (marked) hud.renderMission(app);
    }
    if (!app.tickSave) {
      app.tickSave = setTimeout(() => { app.tickSave = null; app.store.saves[app.level.id] = saveOf(app.state); app.saveStore(); }, 5000);
    }
  },
  skip(n) { app.tick(n); toast(`時間前進了 ${fmtDur(n)}`); },
  /** 快轉到網路穩定為止 */
  settleNow() {
    const t0 = app.state.clock;
    settle(app.state);
    const dt = Math.round(app.state.clock - t0);
    app.tick(0);
    if (dt) {
      for (const r of app.results) if (r && r !== 'running') r.stale = true;
      hud.renderMission(app);
    }
    toast(dt ? `快轉了 ${fmtDur(dt)}，網路已經穩定` : '網路已經是穩定的', 'ok');
  },

  /** 任何設定或接線變動之後呼叫 */
  changed() {
    recompute(app.state);
    app.scene.sync(app.state);
    hud.updateClock(app);
    app.render2d();
    tutorialTick(app);
    const now = snapOf(app.state);
    if (now !== app.snap) {
      if (!app.restoring) {
        if (app.attempt) app.attempt.changes++;
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
      app.store.saves[app.level.id] = saveOf(app.state);
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
    const sel = app.selected, cur = app.state;
    app.state = JSON.parse(from.pop());
    app.state.clock = cur.clock; app.state.dyn = cur.dyn; // 只復原設定，時間繼續往前走
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
  togglePower(id, force) {
    const st = app.state, d = st.devices[id];
    const off = !(st.down || {})[id];
    // IOS 設備斷電後只剩 startup-config：有沒存檔的變更就先問
    if (off && !force && isIos(d) && iosDirty(st, d)) {
      return hud.confirmPowerOff(d.name, () => { saveStartup(d); app.togglePower(id, true); }, () => app.togglePower(id, true));
    }
    const down = { ...(st.down || {}) };
    if (off) down[id] = true; else delete down[id];
    st.down = down;
    let lost = false;
    if (off && isIos(d)) { lost = iosDirty(st, d); restoreStartup(d); app.cliSess = {}; }
    app.changed();
    app.renderPanel();
    const wait = !off && (st.rt.booting || {})[id];
    if (!off && (st.rt.rommon || {})[id]) { toast(`${d.name} 沒有開機成功，停在 ROMMON：${st.rt.rommon[id]}`, 'bad', 5000); app.scene.pulse(id, RED, true); return; }
    toast(off ? `${d.name} 已關機${lost ? '，沒有存檔的設定已經消失' : ' — 可以測試其他路徑有沒有接手'}`
      : `${d.name} 開機中${wait ? `，大約要 ${fmtDur(wait)}` : ''}${isIos(d) ? '；設定會從 startup-config 載入' : ''}`, off ? 'bad' : 'ok', lost ? 5000 : 3200);
    app.scene.pulse(id, off ? RED : GREEN, true);
  },

  /** 2D 邏輯拓撲圖：開著的時候每次狀態改變就重畫 */
  view2d: false,
  render2d() {
    const el = topoEl();
    document.body.classList.toggle('view2d', !!app.view2d);
    el.root.hidden = !app.view2d;
    if (!app.view2d || !app.state) return;
    const ins = app.scene.insets, W = window.innerWidth, H = window.innerHeight;
    renderTopo(app, el.svg, { x: ins.left, y: ins.top, w: W - ins.left - ins.right, h: H - ins.top - ins.bottom });
  },
  toggle2d(on = !app.view2d) {
    app.view2d = on;
    app.store.view2d = on;
    app.saveStore();
    hud.renderTopbar(app);
    app.render2d();
  },

  renderPanel() {
    const dev = renderDevicePanel(app, app.el.panel);
    if (!dev) hud.renderGuide(app, app.el.panel);
    // 學習筆記收起來的時候右邊只留一條窄邊：場景變寬，鏡頭跟著重新對焦
    const fold = !dev && !!app.store.guideFold;
    if (document.body.classList.contains('guide-fold') !== fold) {
      document.body.classList.toggle('guide-fold', fold);
      updateInsets();
      if (app.state) { app.scene.fit(true); app.render2d(); }
    }
  },

  select(id) {
    if (app.selected === id) return;
    app.selected = id;
    app.scene.select(id);
    app.renderPanel();
    app.render2d();
    tutorialTick(app);
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
    // 虛擬機器只有一張虛擬網卡，接在主機的下一個空的虛擬埠上，不用選
    if ((simple(A) && simple(B)) || pair[0].media === 'virt') return app.connect(a, pair[0].id, b, pair[1].id);
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
      sfx.link(app);
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
    // 網路還在收斂：幾秒內就會好的直接等它；要等比較久的照樣測，失敗原因會說明還要多久
    const pend = pendingOf(app.state);
    if (pend.length) {
      const left = Math.ceil(pend[pend.length - 1].at - app.state.clock);
      if (left <= 5) { settle(app.state); app.tick(0); toast(`等了 ${left} 秒讓網路收斂`); }
      else toast(`網路還在收斂（${pend[pend.length - 1].text}），還要 ${fmtDur(left)}。可以等它，或按時鐘旁的「收斂中」快轉。`, 'info', 6000);
    }
    const lv = app.level;
    const token = (app.runToken = (app.runToken || 0) + 1);
    const list = indices || objs.map((_, i) => i);
    app.running = true;
    app.scene.fast = false;
    app.scene.clearBubbles();
    if (!indices) { app.results = []; if (app.attempt) app.attempt.runs++; }
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
      app.lastHops = r.hops;
      app.render2d();
      await app.scene.playHops(r.hops);
      if (app.runToken !== token) return;
      feedback(o, r);
      (r.pass ? sfx.ok : sfx.bad)(app);
      app.results[i] = r;
      app.con.result(r.pass, r.pass ? '✔ 通過' : '✘ 未通過' + (o.expect === false ? '：這條連線應該被擋下來' : r.reason ? '：' + r.reason : ''));
      hud.renderMission(app);
      if (!app.scene.fast) await sleep(r.hops.length ? 480 : 200);
    }
    app.running = false;
    app.scene.fast = false;
    hud.renderMission(app);
    tutorialTick(app);
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
    app.lastHops = hops;
    app.render2d();
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

  /** 觀察題作答：答案存進狀態（可以復原、跟著存檔）。網路沒有變，其他目標的測試結果照舊，只重測這一題 */
  answer(i, value) {
    const o = app.objectives()[i];
    if (!o || o.type !== 'ask' || app.running) return;
    app.state.answers = { ...(app.state.answers || {}), [o.id]: value };
    const now = snapOf(app.state);
    if (now !== app.snap) {
      if (app.attempt) app.attempt.changes++;
      app.undoStack.push(app.snap);
      if (app.undoStack.length > 80) app.undoStack.shift();
      app.redoStack = [];
      app.snap = now;
      hud.updateHistory(app);
    }
    clearTimeout(app.saveTimer);
    app.saveTimer = setTimeout(() => { app.store.saves[app.level.id] = saveOf(app.state); app.saveStore(); }, 400);
    app.run([i]);
  },

  useHint() {
    app.hintsShown = Math.min(app.level.hints.length, app.hintsShown + 1);
    app.store.hints[app.level.id] = app.hintsShown;
    app.saveStore();
  },

  async complete() {
    const lv = app.level;
    const ids = Object.keys(app.state.devices);
    if (lv.drill) {
      const secs = Math.round(app.attempt.ms / 1000), late = !!lv.drill.timed && secs > lv.drill.timed * 60;
      (app.store.drills ||= []).push({ base: lv.drill.base, count: lv.drill.count, timed: lv.drill.timed, secs, hints: app.hintsShown, ok: !late, at: Date.now() });
      if (app.store.drills.length > 30) app.store.drills.shift();
      app.saveStore();
      ids.forEach((id, n) => setTimeout(() => app.scene.pulse(id, GREEN, true), n * 70));
      await sleep(900);
      if (app.level === lv) openDrillComplete(app, hud, { secs, late, hints: app.hintsShown });
      return;
    }
    if (app.attempt && app.attempt.demo) {
      // 參考解法的示範：不記成過關
      ids.forEach((id, n) => setTimeout(() => app.scene.pulse(id, GREEN, true), n * 70));
      await sleep(900);
      if (app.level === lv) hud.openDemoDone(app);
      return;
    }
    const stars = Math.max(1, 3 - app.hintsShown);
    const sc = scoreOf(lv, app.attempt, app.hintsShown);
    const prev = app.store.done[lv.id] || {};
    app.store.done[lv.id] = { stars: Math.max(stars, prev.stars || 0), best: Math.max(sc.score, prev.best || 0) };
    app.saveStore();
    ids.forEach((id, n) => setTimeout(() => app.scene.pulse(id, GREEN, true), n * 70));
    await sleep(900);
    if (app.level === lv) { sfx.win(app); hud.openComplete(app, stars, { ...sc, prevBest: prev.best || 0 }); }
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

/**
 * 存檔用的狀態。觀察用的表（MAC 位址表、連線表）不寫進存檔，紀錄只留最近的幾筆：
 * 這些東西每一關都會累積，全部存起來很快就會塞滿瀏覽器的儲存空間。
 */
function saveOf(st) {
  const s = cloneState(st), d = s.dyn;
  s.ver = SAVE_VER; // 存檔格式的版本（engine/migrate.js）
  if (d) {
    delete d.mac; delete d.ct; delete d.outbox;
    for (const k of ['cap', 'epc', 'con', 'sniff', 'dflow', 'dbg', 'dbgSeen', 'vty', 'bgAcc', 'ifcAcc']) delete d[k];
    for (const k of Object.keys(d.log || {})) d.log[k] = d.log[k].slice(-15);
    for (const k of Object.keys(d.syslog || {})) d.syslog[k] = d.syslog[k].slice(-40);
  }
  return s;
}

let topo = null;
function topoEl() {
  if (topo) return topo;
  const root = document.createElement('div');
  root.id = 'topo2d';
  root.hidden = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 't2');
  root.append(svg);
  // 文件產出：拓撲圖匯出成圖片、IP 位址規劃表
  root.append(h('div', { class: 't2-tools' },
    button('匯出圖片', { ic: 'download', small: true, onclick: () => exportTopoDialog(app, svg) }),
    button('IP 位址表', { ic: 'grid', small: true, onclick: () => ipPlanDialog(app) }),
    button('流量熱圖', { ic: 'bolt', small: true, onclick: (e) => { app.heat = !app.heat; e.currentTarget.classList.toggle('on', app.heat); app.render2d(); } }),
    button('VLAN 配色', { ic: 'grid', small: true, kind: 'on', title: 'Access 埠的線照 VLAN 上色，一眼看出哪些設備在同一個廣播網域', onclick: (e) => { app.t2vlan = app.t2vlan === false; e.currentTarget.classList.toggle('on', app.t2vlan !== false); app.render2d(); } })));
  document.body.append(root);
  // 點設備：和 3D 場景一樣打開設定；點空白處取消選取（拖曳平移結束時的那一下不算）
  svg.addEventListener('click', (e) => {
    if (svg.__dragged) { svg.__dragged = false; return; }
    const g = e.target.closest && e.target.closest('[data-dev]');
    app.select(g ? g.getAttribute('data-dev') : null);
  });
  topo = { root, svg };
  bindTopoView(app, svg, () => app.render2d());
  return topo;
}

function updateInsets() {
  const m = app.el.mission.getBoundingClientRect(), p = app.el.panel.getBoundingClientRect(), t = app.el.topbar.getBoundingClientRect();
  app.scene.setInsets({ left: m.right + 4, right: window.innerWidth - p.left + 4, top: t.bottom + 46, bottom: 236 });
  // 時鐘放在場景上方的正中間（任務面板與設定面板之間）
  if (app.clockUi) {
    app.clockUi.el.style.left = (m.right + p.left) / 2 + 'px';
    app.clockUi.avail = Math.max(120, Math.floor(p.left - m.right - 16));
    hud.fitClock(app);
  }
  document.getElementById('toasts').style.left = (m.right + p.left) / 2 + 'px';
}

// ───────────── 啟動 ─────────────
for (const k of ['topbar', 'mission', 'panel', 'console']) app.el[k].classList.add('glass');
app.con = hud.initConsole(app);
app.scene = new Scene3D(app.el.stage, {
  onSelect: (id) => app.select(id),
  // 2D 拓撲圖開著的時候，封包動畫與到站的閃光也畫在 2D 圖上
  onPacket: (p) => { if (topo && (app.view2d || !p)) topoPacket(topo.svg, p); },
  onPulse: (id, color) => { if (topo && app.view2d) topoPulse(topo.svg, id, color); },
  onLink: (a, b) => app.link(a, b),
  onCable: (id, x, y) => hud.openCableMenu(app, id, x, y),
  canMove: () => !!app.level.sandbox,
  onMoved: () => app.sandboxMoved(),
  onWall: (a, b, mat) => {
    if (!app.level.sandbox || (a[0] === b[0] && a[1] === b[1])) return;
    (app.state.walls ||= []).push({ a, b, mat });
    app.changed();
    app.scene.load(app.state, { keep: true });
  },
  onSurvey: (x, z) => {
    const aps = apsOf(app.state).filter((ap) => meshServes(app.state, ap)); // 回程沒連上的 mesh 基地台不廣播，量不到
    if (!aps.length) return ['訊號量測', '（場景裡沒有正在發射的基地台）'];
    const rows = aps.map((ap) => ({ ap, rf: rfAt(app.state, ap, [x, z]) })).sort((a, b) => Math.max(b.rf.rssi5, b.rf.rssi24) - Math.max(a.rf.rssi5, a.rf.rssi24));
    const q = (v) => (v >= -60 ? '很好' : v >= -67 ? '好' : v >= -75 ? '普通' : v >= -80 ? '很弱' : '收不到');
    return [`訊號量測 (${x.toFixed(1)}, ${z.toFixed(1)})`, ...rows.slice(0, 4).map(({ ap, rf }) => `${ap.name}：5 GHz ${rf.rssi5} dBm（${q(rf.rssi5)}）· 2.4 GHz ${rf.rssi24} dBm（${q(rf.rssi24)}）${rf.walls.length ? ` · 穿過 ${rf.walls.length} 道牆` : ''}`)];
  },
});
installSandbox(app, { renderMission: () => hud.renderMission(app) });
installTables(document.getElementById('panel'));
installKb(app, { renderMission: () => hud.renderMission(app), levelNo: hud.levelNo, closeModal: hud.closeModal });
hud.initClock(app);

// 模擬時間跟著真實時間走（可以暫停或加速）。對話框開著、或分頁在背景時暫停
let lastTick = performance.now(), carry = 0;
setInterval(() => {
  const t = performance.now(), dt = Math.min(2, (t - lastTick) / 1000);
  lastTick = t;
  if (app.attempt && app.level && !app.level.sandbox && !document.hidden && !hud.modalOpen()) {
    app.attempt.ms += dt * 1000;
    const tm = document.getElementById('drill-timer');
    if (tm && app.level.drill) {
      const lim = app.level.drill.timed * 60, used = app.attempt.ms / 1000;
      tm.textContent = lim ? `剩下 ${fmtSecs(Math.max(0, lim - used))}` : `已經 ${fmtSecs(used)}`;
      tm.classList.toggle('low', !!lim && lim - used < 60);
      if (lim && used >= lim && !app.timeUp) { app.timeUp = true; toast('時間到！可以繼續修，但這次演練會記成超時', 'bad', 5000); }
    }
  }
  if (app.paused || document.hidden || !app.state || hud.modalOpen()) return;
  carry += dt * app.speed;
  const n = Math.floor(carry);
  if (n >= 1) { carry -= n; app.tick(n); }
}, 250);

// 先讓畫布量到新的大小再對焦（畫布自己的 ResizeObserver 比 resize 事件晚，對焦會用到舊的寬高）
window.addEventListener('resize', () => { updateInsets(); app.scene.resize(); app.scene.fit(); app.render2d(); });
// 兩側面板的寬度變了（版面斷點、縮放）也要重新對齊時鐘與場景邊界
if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(() => updateInsets());
  ro.observe(app.el.mission);
  ro.observe(app.el.panel);
}
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

// 其他快捷鍵（? 看清單）
installShortcuts(app, hud);

// 離線使用 (PWA)：正式建置才註冊 service worker（開發伺服器、Claude Artifact 不用）
if (import.meta.env.PROD && import.meta.env.MODE !== 'artifact' && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  const link = document.createElement('link');
  link.rel = 'manifest'; link.href = './manifest.webmanifest';
  document.head.append(link);
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 不能註冊（例如無痕模式）：照常線上使用 */ });
}

if (app.store.last === 'sandbox') app.openSandbox();
else if (app.store.last === 'drill' && app.store.drill) app.openDrill(app.store.drill, { resume: true });
else if (/^custom-/.test(app.store.last || '')) {
  const c = (app.store.custom || []).find((x) => x.id === app.store.last) || (app.store.customTest && app.store.customTest.id === app.store.last ? app.store.customTest : null);
  if (c) { app.openLevel(customLevel(c)); app.level.test = c === app.store.customTest; } else app.loadLevel(0);
}
else app.loadLevel(Math.max(0, LEVELS.findIndex((l) => l.id === app.store.last)));
hud.openLevels(app);
app.levelNo = hud.levelNo;
if (app.store.view2d) app.toggle2d(true);
app.levels = LEVELS;
window.linkup = app; // 方便在主控台除錯，瀏覽器端測試（e2e/）也從這裡切換關卡
