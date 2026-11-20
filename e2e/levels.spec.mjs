// 每一關都在真的瀏覽器裡跑一遍：
// 打開關卡 → 每台設備的每個分頁都畫一次 → 執行全部目標（應該有沒通過的）→ 套用參考解法 → 每個分頁再畫一次
// → 執行全部目標 → 過關視窗出現。過程中不能有例外，畫面上不能出現 undefined / NaN / [object Object]。
import { test, expect, boot } from './helpers.mjs';
import { LEVELS } from '../src/levels/index.js';

test.describe.configure({ mode: 'parallel' });

for (const lv of LEVELS) {
  test(`${lv.id} ${lv.title}`, async ({ page }, info) => {
    await boot(page);
    // 小螢幕只檢查每個分頁的版面（面板比較窄，最容易擠出水平捲軸）；完整流程在大螢幕跑
    if (info.project.name !== '1440x900') {
      const issues = await page.evaluate(async (id) => {
        const app = window.linkup, out = [];
        const frame = () => new Promise((ok) => requestAnimationFrame(() => ok()));
        const lv = app.levels.find((l) => l.id === id);
        app.openLevel(lv, { fresh: true });
        for (const phase of ['初始', '解完']) {
          if (phase === '解完') { lv.solve(app.state); app.changed(); app.settleNow(); }
          out.push(...window.__scan(document.querySelector('#mission'), phase + '・任務面板'));
          for (const d of Object.keys(app.state.devices)) {
            app.select(d);
            const n = Math.max(1, document.querySelectorAll('#panel .tab').length);
            for (let t = 0; t < n; t++) {
              const tab = document.querySelectorAll('#panel .tab')[t];
              if (tab) tab.click();
              await frame();
              out.push(...window.__scan(document.querySelector('#panel'), `${phase}・${app.state.devices[d].name}・${tab ? tab.textContent : '面板'}`));
            }
          }
          app.select(null);
        }
        return out;
      }, lv.id);
      expect(issues, '畫面上出現不該出現的字或水平捲軸').toEqual([]);
      return;
    }
    const r = await page.evaluate(async (id) => {
      const app = window.linkup, issues = [];
      const lv = app.levels.find((l) => l.id === id);
      const S = (sel, where) => issues.push(...window.__scan(document.querySelector(sel), where));
      const frame = () => new Promise((ok) => requestAnimationFrame(() => ok()));
      app.openLevel(lv, { fresh: true });
      await frame();
      S('#topbar', '上方列'); S('#mission', '任務面板'); S('#panel', '說明面板');

      const panels = async (phase) => {
        for (const d of Object.keys(app.state.devices)) {
          app.select(d);
          const n = Math.max(1, document.querySelectorAll('#panel .tab').length);
          for (let t = 0; t < n; t++) {
            const tab = document.querySelectorAll('#panel .tab')[t];
            if (tab) tab.click();
            await frame();
            S('#panel', `${phase}・${app.state.devices[d].name}・${tab ? tab.textContent : '面板'}`);
          }
        }
        app.select(null);
      };
      await panels('初始');

      // 空白鍵快轉：測試時封包動畫一律跳過
      const ff = setInterval(() => app.fastForward(), 25);
      await app.run();
      const before = app.results.filter((x) => x && x.pass).length;
      S('#console', '初始測試的紀錄'); S('#mission', '初始測試後的任務面板');

      lv.solve(app.state);
      app.changed();
      app.settleNow();
      await panels('解完');
      await app.run();
      clearInterval(ff);
      const after = app.results.filter((x) => x && x.pass && !x.stale).length;
      const fails = app.results.map((x, i) => (x && x.pass ? null : `${lv.objectives[i].label}：${x && x.reason}`)).filter(Boolean);
      S('#console', '解完後的測試紀錄');
      // 過關之後 0.9 秒跳出結算視窗
      let dialog = '';
      for (let k = 0; k < 40 && !dialog; k++) {
        await new Promise((ok) => setTimeout(ok, 100));
        dialog = document.querySelector('#modal-root .dialog')?.textContent || '';
      }
      S('#modal-root', '過關視窗');
      return { issues, before, after, total: lv.objectives.length, fails, dialog };
    }, lv.id);

    expect(r.issues, '畫面上出現不該出現的字').toEqual([]);
    expect(r.before, '初始狀態不該全部通過').toBeLessThan(r.total);
    expect(r.fails, '套用解法後仍有沒通過的目標').toEqual([]);
    expect(r.after).toBe(r.total);
    expect(r.dialog, '過關視窗').toMatch(/(任務完成|全部破關).*\d+ 分/);
  });
}
