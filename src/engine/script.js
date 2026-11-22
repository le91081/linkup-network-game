// 關卡劇本的排程事件：「三分鐘後施工挖斷主線」「十分鐘後修好」
// 關卡在 setup 裡設定 s.script = [{ at: 秒, text: '畫面上的通知', why: '線路斷掉的原因',
//   cut: [[設備, 埠]]（線路斷掉）, uncut: [[設備, 埠]]（修好）, flows: { 背景流量 id: true | false } }]
// 時間到了（模擬時鐘走到 at）才發生；快轉到收斂 (settle) 不會為了它們特地往前跳。
// 發生過的事件記下 fired（發生的時間），新的通知放進 state.scriptNews 給畫面顯示。

const cableAt = (state, dev, port) => state.cables.find((c) => (c.a.dev === dev && c.a.port === port) || (c.b.dev === dev && c.b.port === port));

/** 每次重新計算之前呼叫：把時間已經到了的事件套用到網路上，回傳這一次發生的事件 */
export function scriptTick(state) {
  const fired = [];
  for (const e of state.script || []) {
    if (e.fired != null || (state.clock || 0) < e.at) continue;
    e.fired = state.clock || 0;
    for (const [dv, pid] of e.cut || []) {
      const c = cableAt(state, dv, pid);
      if (!c) continue;
      (state.cut ||= {})[c.id] = true;
      (state.cutWhy ||= {})[c.id] = e.why || e.text || '線路斷了';
    }
    for (const [dv, pid] of e.uncut || []) {
      const c = cableAt(state, dv, pid);
      if (!c) continue;
      if (state.cut) delete state.cut[c.id];
      if (state.cutWhy) delete state.cutWhy[c.id];
    }
    for (const [id, on] of Object.entries(e.flows || {})) {
      const f = (state.flows || []).find((x) => x.id === id);
      if (f) f.on = !!on;
    }
    if (e.text) (state.scriptNews ||= []).push({ text: e.text, tone: e.tone || ((e.uncut || []).length && !(e.cut || []).length ? 'ok' : 'bad') });
    fired.push(e);
  }
  return fired;
}

/** 還沒發生的下一個事件（給畫面顯示倒數用） */
export const nextScript = (state) => (state.script || []).filter((e) => e.fired == null).sort((a, b) => a.at - b.at)[0] || null;

/** 畫面拿走新的通知 */
export function takeScriptNews(state) {
  const n = state.scriptNews || [];
  delete state.scriptNews;
  return n;
}
