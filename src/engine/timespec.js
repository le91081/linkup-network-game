// time-range 的 periodic 參數（沒有任何相依：ios.js 也要用，避免循環載入）
export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GROUP = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekend: [0, 6] };
const hhmm = (s) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
export const fmtHm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** periodic 後面的參數 → { days, from, to } 或錯誤訊息 */
export function parsePeriodic(words) {
  const t = words.map((x) => String(x).toLowerCase());
  const k = t.indexOf('to');
  if (k < 2 || k !== t.length - 2) return '用法：periodic daily | weekdays | weekend | <星期幾…> <hh:mm> to <hh:mm>，例如 periodic weekdays 12:00 to 13:00';
  const from = hhmm(t[k - 1]), to = hhmm(t[k + 1]);
  if (from == null || to == null) return '時間要寫成 hh:mm（24 小時制），例如 8:00、18:30';
  if (to <= from) return '結束時間要比開始時間晚（這個模擬不支援跨過午夜的區間：拆成兩條 periodic）';
  const days = new Set();
  for (const w of t.slice(0, k - 1)) {
    if (GROUP[w]) GROUP[w].forEach((x) => days.add(x));
    else { const n = DAYS.findIndex((d) => d.startsWith(w) && w.length >= 3); if (n < 0) return `看不懂「${w}」：可以寫 daily、weekdays、weekend 或 Monday … Sunday`; days.add(n); }
  }
  const txt = t.slice(0, k - 1).map((w) => (GROUP[w] ? w : DAYS.find((d) => d.startsWith(w)).replace(/^./, (c) => c.toUpperCase()))).join(' ');
  return { days: [...days].sort(), from, to, text: `${txt} ${fmtHm(from)} to ${fmtHm(to)}` };
}

