// 故障演練：拿一個已經完成的關卡，把網路隨機改壞幾個地方，玩家要自己找出來修好
import { h, icon, button } from './dom.js';
import { LEVELS, CHAPTERS } from '../levels/index.js';
import { injectFaults, drillable } from '../engine/faults.js';
import { recompute, settle } from '../engine/sim.js';

const COUNT_NAME = { 1: '一個', 2: '兩個', 3: '三個' };

/** 建立一個演練用的「關卡」：設定好之後的網路 + 隨機的故障 */
export function makeDrill(base, { count = 2, seed = 1, timed = 0 } = {}) {
  const lv = {
    ...base, id: 'drill', base, drill: { base: base.id, count, seed, timed }, faults: [],
    title: `故障演練：${base.title}`, subtitle: `有人改壞了${COUNT_NAME[count] || count + ' 個'}地方`,
    tags: ['故障演練', ...base.tags.slice(0, 3)],
    brief: `這是「${base.title}」完成之後的網路，本來每一個目標都通過。剛剛有人動了設定，壞了${COUNT_NAME[count] || count + ' 個'}地方，現在有些服務斷了。找出被改壞的地方並修好，讓所有目標再次通過。${timed ? `限時 ${timed} 分鐘。` : ''}`,
    given: base.given,
    learn: [
      { t: '先確認症狀', d: '按「執行測試」看哪些目標失敗。失敗的目標通常有共同點：同一個網段、同一台設備、同一種服務。這會告訴你問題大概在哪裡。' },
      { t: '跟著封包走', d: '失敗的那一行會說封包停在哪一台設備、為什麼被丟掉。從那台設備的設定看起：介面有沒有開、IP 與遮罩、VLAN、路由、ACL、NAT。' },
      { t: '由下往上', d: '實體層（燈號、線）→ 資料鏈結層（VLAN、Trunk）→ 網路層（IP、閘道、路由）→ 傳輸層以上（ACL、防火牆、服務）。一層一層排除，不要同時改好幾個地方。' },
      ...base.learn.slice(0, 1),
    ],
    hints: [`一共有 ${count} 個地方被改壞。先按「執行測試」，看哪些目標失敗、封包卡在哪一台設備。`],
    recap: [],
    setup() {
      const s = base.setup();
      recompute(s);
      base.solve(s);
      settle(s);
      const { faults } = injectFaults(s, base.objectives, { count, seed });
      lv.faults = faults;
      lv.hints = [lv.hints[0], ...faults.map((f) => `其中一個問題在 ${f.name}（${f.area}）。`)];
      lv.recap = faults.map((f) => '被改壞的地方：' + f.text);
      recompute(s);
      return s;
    },
    solve: null,
  };
  return lv;
}
export const randomSeed = () => (Math.random() * 2 ** 31) >>> 0;

/** 演練的選單：挑關卡、壞幾個地方、要不要限時 */
export function openDrillPicker(app, { modal, closeModal, levelNo }) {
  const done = app.store.done;
  const pool = LEVELS.filter(drillable);
  let count = 2, timed = 0, pick = '';
  const dlg = modal([], { wide: true });
  const draw = () => {
    const doneList = pool.filter((l) => done[l.id]);
    dlg.replaceChildren(
      h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('bolt', 30)),
        h('div', null, h('h1', { text: '故障演練' }), h('p', { text: '從一個已經做好的網路開始，系統隨機改壞幾個地方：可能是閘道打錯、埠被放錯 VLAN、Trunk 少了 VLAN、介面被關、路由被刪、多了一條 ACL…。每次都不一樣，最接近真實的維運工作。' }))),
      h('div', { class: 'drill-opts' },
        h('div', null, h('div', { class: 'f-label', text: '壞幾個地方' }), h('div', { class: 'seg' }, [1, 2, 3].map((n) => h('button', { type: 'button', class: count === n ? 'on' : '', onclick: () => { count = n; draw(); } }, `${n} 個`)))),
        h('div', null, h('div', { class: 'f-label', text: '時間限制' }), h('div', { class: 'seg' }, [[0, '不限時'], [10, '10 分鐘'], [20, '20 分鐘']].map(([n, t]) => h('button', { type: 'button', class: timed === n ? 'on' : '', onclick: () => { timed = n; draw(); } }, t))))),
      h('div', { class: 'd-actions' },
        button('隨機挑一個網路', { ic: 'shuffle', kind: 'primary', onclick: () => start((doneList.length ? doneList : pool)[Math.floor(Math.random() * (doneList.length ? doneList.length : pool.length))]) })),
      h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: doneList.length ? `隨機會從你已經完成的 ${doneList.length} 關挑選。也可以直接指定：` : '還沒有完成任何關卡：隨機會從全部的關卡挑選。也可以直接指定：' }),
      ...CHAPTERS.map((ch) => {
        const list = pool.filter((l) => l.chapter === ch.id);
        if (!list.length) return null;
        return h('section', { class: 'chapter' }, h('h2', { text: `第 ${ch.id} 章　${ch.title}` }),
          h('div', { class: 'drill-list' }, list.map((l) => h('button', { type: 'button', class: 'chip lvchip' + (done[l.id] ? ' done' : '') + (pick === l.id ? ' on' : ''), title: l.title, onclick: () => start(l) }, `${levelNo(l)} ${l.title}`))));
      }),
      drillHistory(app));
  };
  const start = (base) => {
    closeModal();
    app.openDrill({ base: base.id, count, seed: randomSeed(), timed });
  };
  draw();
}

function drillHistory(app) {
  const list = (app.store.drills || []).slice(-6).reverse();
  if (!list.length) return null;
  return h('section', { class: 'chapter' }, h('h2', { text: '最近的演練' }),
    h('div', { class: 'crows' }, list.map((x) => {
      const lv = LEVELS.find((l) => l.id === x.base);
      return h('div', { class: 'crow' + (x.ok ? ' all' : '') },
        h('span', { class: 'ccode mono', text: fmtSecs(x.secs) }),
        h('span', { class: 'ctitle', text: `${lv ? lv.title : x.base} · 壞了 ${x.count} 個地方${x.hints ? ` · 看了 ${x.hints} 個提示` : ''}${x.timed ? ` · 限時 ${x.timed} 分鐘` : ''}` }),
        h('span', { class: 'clv', text: x.ok ? '完成' : '超時' }));
    })));
}
export const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 演練完成：揭曉被改壞的地方 */
export function openDrillComplete(app, { modal, closeModal }, info) {
  const lv = app.level;
  modal([
    h('div', { class: 'done-top' }, h('div', { class: 'done-ring' + (info.late ? ' soft' : '') }, icon(info.late ? 'clock' : 'check', 34)),
      h('h2', { text: info.late ? '修好了，但超過時間' : '網路恢復正常！' }),
      h('p', { class: 'muted', text: `${lv.base.title} · 用時 ${fmtSecs(info.secs)}${info.hints ? ` · 看了 ${info.hints} 個提示` : ''}` })),
    h('div', { class: 'recap' }, lv.faults.map((f) => h('div', null, icon('check', 14), h('span', { text: f.text })))),
    h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: '你的修法不一定要和原本一模一樣：只要所有目標都通過，就是有效的修復。' }),
    h('div', { class: 'd-actions' }, button('留在這裡', { kind: 'ghost', onclick: closeModal }),
      button('同一個網路再壞一次', { ic: 'reset', onclick: () => { closeModal(); app.openDrill({ ...lv.drill, seed: randomSeed() }); } }),
      button('換一個網路', { ic: 'shuffle', kind: 'primary', onclick: () => { closeModal(); openDrillPicker(app, { modal, closeModal, levelNo: app.levelNo }); } })),
  ]);
}
