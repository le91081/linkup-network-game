// 錯題本：答錯的題目用間隔重複（Leitner 盒子）排程複習
// 答錯就放進第 1 盒，馬上可以複習；答對往下一盒移，下次複習的間隔 1 → 3 → 7 → 14 → 30 天，第 5 盒再答對就畢業。
// 複習時又答錯，回到第 1 盒。用的是真實的日期，不是遊戲裡的模擬時鐘。
// app.store.review = { 題目代碼: { box, due（毫秒）, wrong（答錯幾次）, topic, item?（隨機產生的題目要整題存下來） } }
import { QUESTIONS } from '../data/quiz.js';

const DAY = 86400000;
export const INTERVAL_DAYS = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 30 };
/** 題目的代碼：題目文字的雜湊（題庫改了字，就當成新的題目） */
export function qKey(item) {
  let h = 5381;
  for (const ch of String(item.q)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return 'q' + h.toString(36);
}
let BANK = null;
/** 題庫裡所有題目：代碼 → { item, topic } */
function bank() {
  if (BANK) return BANK;
  BANK = new Map();
  for (const [topic, list] of Object.entries(QUESTIONS)) for (const item of list) BANK.set(qKey(item), { item, topic });
  return BANK;
}

/** 記下一次作答。回傳這一題的新排程（null 表示從錯題本畢業或不在錯題本裡） */
export function noteAnswer(app, item, ok, now = Date.now()) {
  const R = (app.store.review ||= {});
  const k = qKey(item), e = R[k];
  if (!ok) {
    const inBank = bank().has(k);
    R[k] = { box: 1, due: now, wrong: ((e && e.wrong) || 0) + 1, topic: inBank ? bank().get(k).topic : 'subnet', ...(inBank ? {} : { item: { q: item.q, a: item.a, c: item.c, e: item.e, r: item.r } }) };
  } else if (e) {
    if (e.box >= 5) delete R[k];
    else { e.due = now + INTERVAL_DAYS[e.box] * DAY; e.box += 1; }
  }
  app.saveStore();
  return R[k] || null;
}

/** 到期的題目（可以複習的）：[{ key, item, entry }] */
export function dueItems(app, now = Date.now()) {
  const out = [];
  for (const [key, entry] of Object.entries(app.store.review || {})) {
    if (entry.due > now) continue;
    const item = entry.item || (bank().get(key) || {}).item;
    if (item) out.push({ key, item, entry });
  }
  return out.sort((a, b) => a.entry.box - b.entry.box || a.entry.due - b.entry.due);
}

/** 錯題本的狀況：{ total, due, next（最近一題還要多久，毫秒）} */
export function reviewStats(app, now = Date.now()) {
  const all = Object.entries(app.store.review || {}).filter(([k, e]) => e.item || bank().has(k));
  const due = all.filter(([, e]) => e.due <= now).length;
  const later = all.filter(([, e]) => e.due > now).map(([, e]) => e.due - now);
  return { total: all.length, due, next: later.length ? Math.min(...later) : null };
}

export const fmtWait = (ms) => (ms < 3600000 ? `${Math.max(1, Math.ceil(ms / 60000))} 分鐘` : ms < DAY ? `${Math.ceil(ms / 3600000)} 小時` : `${Math.ceil(ms / DAY)} 天`);
