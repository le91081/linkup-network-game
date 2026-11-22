// 音效：用 Web Audio 即時合成幾個短音（不需要音檔）。音量很小，可以用 M 鍵或說明視窗關掉（記在進度裡）
let ctx = null;
function ac() {
  if (ctx) return ctx;
  // 瀏覽器要等使用者操作過頁面才允許發出聲音：在那之前不建立 AudioContext（不然會跳出警告）
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  return ctx;
}
/** 一串音：[頻率, 開始的秒數, 長度, 波形] */
function play(app, notes, vol = 0.06) {
  if (!app || !app.store || app.store.sound === false) return;
  const a = ac();
  if (!a) return;
  try {
    if (a.state === 'suspended') a.resume();
    const t0 = a.currentTime + 0.01;
    for (const [f, at, len, type = 'sine'] of notes) {
      const o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(vol, t0 + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(g).connect(a.destination);
      o.start(t0 + at); o.stop(t0 + at + len + 0.02);
    }
  } catch { /* 有些環境不能播放：安靜就好 */ }
}

export const sfx = {
  /** 一個目標通過 */
  ok: (app) => play(app, [[880, 0, 0.09], [1320, 0.07, 0.12]]),
  /** 一個目標沒過 */
  bad: (app) => play(app, [[220, 0, 0.16, 'triangle'], [185, 0.1, 0.2, 'triangle']], 0.07),
  /** 接上網路線 */
  link: (app) => play(app, [[1200, 0, 0.04, 'square']], 0.025),
  /** 過關 */
  win: (app) => play(app, [[523, 0, 0.14], [659, 0.12, 0.14], [784, 0.24, 0.14], [1047, 0.36, 0.3]], 0.07),
};

/** 開 / 關音效。回傳新的狀態 */
export function toggleSound(app) {
  app.store.sound = app.store.sound === false;
  app.saveStore();
  if (app.store.sound) sfx.ok(app);
  return app.store.sound;
}
