// 觀察題：不是「把網路弄通」，而是「看懂網路正在做什麼」的任務目標。
// 玩家用封包追蹤、ARP 快取、MAC 位址表、封包擷取觀察之後作答，答案存在 state.answers[題目 id]（跟著存檔、復原）。
//
// 目標的格式（type: 'ask'）：
//   id        題目的識別名稱（同一關裡不重複）
//   label     任務清單上顯示的文字
//   q         完整的題目（省略就用 label）
//   tip       可以用哪些工具觀察（不算提示，不扣星）
//   options   選擇題：[{ v: 值, t: 文字, why: 選錯時的說明 }]，也可以是 (state) => 陣列
//   multi     複選（答案是一組值）
//   input     填空題：'mac'（MAC 位址）、'ip'、'number'、'port'（連接埠名稱）、'text'
//   answer    正確答案，或 (state) => 答案：從目前的網路算出來，所以設備的位址換了答案也會跟著對。
//             填空題可以給陣列，表示好幾種寫法都算對
//   explain   答對之後的說明
//   miss      填空題答錯時的說明；也可以是 (state, 玩家的答案) => 說明，針對常見的錯誤答案給不同的回饋

const hexOnly = (s) => String(s).toLowerCase().replace(/[^0-9a-f]/g, '');
/** 連接埠名稱：GigabitEthernet0/3、Gi0/3、gi 0/3、g0/3 都當成同一個（第一個字母 + 數字） */
const portNorm = (s) => {
  const m = String(s).toLowerCase().replace(/\s+/g, '').match(/^([a-z-]*)([\d/.:]+)$/);
  return m ? m[1].slice(0, 1) + m[2] : String(s).toLowerCase().replace(/\s+/g, '');
};

export const askOptions = (state, o) => (typeof o.options === 'function' ? o.options(state) : o.options) || null;
export const askWant = (state, o) => (typeof o.answer === 'function' ? o.answer(state) : o.answer);

/** 把答案整理成可以比對的樣子（MAC 不管分隔符號與大小寫、數字不管前面的 0…） */
export function askNorm(o, v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(String).sort().join(',');
  const s = String(v).trim();
  if (o.input === 'mac') return hexOnly(s);
  if (o.input === 'number') return s === '' || isNaN(+s) ? s : String(+s);
  if (o.input === 'port') return portNorm(s);
  if (o.input === 'ip') return s.replace(/\s+/g, '').replace(/\/\d+$/, '');
  return s.toLowerCase().replace(/\s+/g, '');
}

/** 玩家目前的答案（還沒答是 null） */
export function askGot(state, o) {
  const v = (state.answers || {})[o.id];
  return v == null || v === '' || (Array.isArray(v) && !v.length) ? null : v;
}

/** 檢查答案：{ pass, reason, empty } */
export function askCheck(state, o) {
  const got = askGot(state, o);
  if (got == null) return { pass: false, empty: true, reason: '還沒有作答（點這一項來回答）' };
  const want = askWant(state, o);
  const wants = o.multi || !Array.isArray(want) ? [want] : want;
  if (wants.some((w) => askNorm(o, w) === askNorm(o, got))) return { pass: true, reason: '' };
  const opts = askOptions(state, o);
  if (opts && o.multi) {
    // 複選：說明多選了哪一個、或少選了幾個（不直接講答案）
    const g = new Set([].concat(got).map(String)), w = new Set([].concat(want).map(String));
    const extra = opts.find((x) => g.has(String(x.v)) && !w.has(String(x.v)));
    if (extra) return { pass: false, reason: `答案不對：「${extra.t}」不該選${extra.why ? '。' + extra.why : ''}` };
    return { pass: false, reason: `答案不對：選到的都對，但還少了 ${[...w].filter((x) => !g.has(x)).length} 個` };
  }
  const opt = opts && opts.find((x) => String(x.v) === String(got));
  const why = opt ? opt.why : typeof o.miss === 'function' ? o.miss(state, got) : o.miss;
  return { pass: false, reason: '答案不對' + (why ? '：' + why : '。再觀察一次看看') };
}

/** 答案顯示在任務清單上的文字 */
export function askText(state, o) {
  const got = askGot(state, o);
  if (got == null) return '';
  const opts = askOptions(state, o);
  if (!opts) return String(got);
  return [].concat(got).map((v) => (opts.find((x) => String(x.v) === String(v)) || { t: String(v) }).t).join('、');
}
