// 第一次玩的導覽：在第 1-1 關一步一步帶著做（接線 → 點設備 → 設定 IP → 執行測試）
// 每一步都看遊戲真正的狀態來判斷有沒有做到，做到了就自動進到下一步；隨時可以跳過，說明裡可以重看。
import { h, toast } from './dom.js';

const linked = (s, a, b) => s.cables.some((c) => (c.a.dev === a && c.b.dev === b) || (c.a.dev === b && c.b.dev === a));
const ipOf = (s, id) => ((s.devices[id] || {}).ifaces || [])[0] || {};
const STEPS = [
  { t: '接上第一條網路線', d: '在 PC-A 上按住滑鼠，拖曳到 Hub 再放開。', hl: ['dev:pc-a', 'dev:hub'], done: (app) => linked(app.state, 'pc-a', 'hub') },
  { t: '再接一條', d: '用同樣的方法，把 PC-B 也接到 Hub。接好的線會亮起來。', hl: ['dev:pc-b', 'dev:hub'], done: (app) => linked(app.state, 'pc-b', 'hub') },
  { t: '打開 PC-A 的設定', d: '點一下 PC-A，右邊會換成它的設定頁面。', hl: ['dev:pc-a'], done: (app) => app.selected === 'pc-a' },
  {
    t: '替 PC-A 設定 IP', d: '選「手動設定」，IP 位址填 192.168.1.10、子網路遮罩填 255.255.255.0，每一格填完按 Enter。', hl: ['#panel .card'],
    done: (app) => { const i = ipOf(app.state, 'pc-a'); return i.mode === 'static' && i.ip === '192.168.1.10' && i.mask === '255.255.255.0'; },
  },
  {
    t: 'PC-B 也一樣', d: '點 PC-B，IP 填 192.168.1.20，遮罩一樣是 255.255.255.0。前三段相同、最後一段不重複，兩台就在同一個網段。', hl: ['dev:pc-b'],
    done: (app) => { const i = ipOf(app.state, 'pc-b'); return i.mode === 'static' && i.ip === '192.168.1.20' && i.mask === '255.255.255.0'; },
  },
  { t: '測試看看', d: '按左下角的「執行測試」，看封包怎麼走：橘色的是 ARP（問對方的 MAC），藍色是請求、綠色是回應。', hl: ['#mission .m-foot .btn'], done: (app) => app.results.length > 0 && app.results.every((r) => r && r.pass) },
];

let ui = null;

/** 開始導覽（會先把第 1-1 關重置） */
export function startTutorial(app) {
  const idx = app.levels.findIndex((l) => l.id === 'l01');
  app.loadLevel(idx, { fresh: true });
  app.store.tutorial = { step: 0 };
  app.store.seenHelp = true;
  app.saveStore();
  render(app);
}
export function skipTutorial(app) {
  app.store.tutorial = 'skipped';
  app.saveStore();
  close();
}
const active = (app) => app.store.tutorial && typeof app.store.tutorial === 'object' && app.level && app.level.id === 'l01';

/** 狀態變了之後呼叫：做到了就前進一步 */
export function tutorialTick(app) {
  if (!active(app)) { close(); return; }
  const t = app.store.tutorial;
  let moved = false;
  while (t.step < STEPS.length && STEPS[t.step].done(app)) { t.step++; moved = true; }
  if (t.step >= STEPS.length) {
    app.store.tutorial = 'done';
    app.saveStore();
    close();
    toast('導覽完成！之後的關卡都是同樣的節奏：看需求 → 接線、設定 → 測試 → 從封包追蹤找原因。', 'ok', 6500);
    return;
  }
  if (moved) app.saveStore();
  render(app);
}

function close() {
  if (ui) { ui.el.remove(); ui = null; }
  for (const e of document.querySelectorAll('.coach-hl')) e.classList.remove('coach-hl');
}

function render(app) {
  const t = app.store.tutorial, s = STEPS[t.step];
  if (!ui) {
    const el = h('div', { id: 'coach', class: 'glass' });
    document.body.append(el);
    ui = { el };
  }
  ui.el.replaceChildren(
    h('div', { class: 'co-top' }, h('span', { class: 'co-no', text: `導覽 ${t.step + 1} / ${STEPS.length}` }),
      h('button', { type: 'button', class: 'co-skip', text: '跳過導覽', onclick: () => skipTutorial(app) })),
    h('b', { text: s.t }), h('p', { text: s.d }),
    h('div', { class: 'co-bar' }, h('i', { style: { width: `${(t.step / STEPS.length) * 100}%` } })),
  );
  for (const e of document.querySelectorAll('.coach-hl')) e.classList.remove('coach-hl');
  for (const sel of s.hl) {
    const els = sel.startsWith('dev:') ? document.querySelectorAll(`.dev-label[data-dev="${sel.slice(4)}"]`) : [document.querySelector(sel)];
    for (const e of els) if (e) e.classList.add('coach-hl');
  }
}
