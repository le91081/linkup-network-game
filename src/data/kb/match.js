// 知識庫的查詢：在一段文字裡找出提到的觀念（給「名詞連結」用）、某一關會用到哪些觀念、某個觀念在哪些關卡出現
// 純函式，沒有 DOM，Node 的單元測試也能跑

const ASCII = /^[\x20-\x7e]+$/;
const WORD = /[A-Za-z0-9]/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 建立索引：每個關鍵字對應到哪個觀念；長的關鍵字先比對（Native VLAN 先於 VLAN） */
export function buildIndex(concepts) {
  const map = new Map();
  const command = (k) => /^[a-z0-9 ./:-]+$/.test(k); // 指令或小寫的英文（ping、spanning-tree）：只給搜尋用，不在文字裡連結
  for (const c of concepts) for (const k of [c.t, ...(c.keys || [])]) if (k && !map.has(k) && (k === c.t || !command(k))) map.set(k, c.id);
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  return { map, re: new RegExp(keys.map(esc).join('|'), 'g') };
}

/**
 * 把一段文字切成 [{ text }, { text, id }]：提到觀念的地方帶 id。
 * 同一段文字裡，每個觀念只連結第一次出現的地方；英文的關鍵字前後不能緊接著英數字（NAT 不會連到 NATT 裡）。
 * skip：不要連結的觀念（例如文章自己）
 */
export function splitTerms(index, text, skip = null) {
  const out = [], seen = new Set(skip ? [skip] : []);
  if (!text) return out;
  let last = 0;
  index.re.lastIndex = 0;
  for (let m = index.re.exec(text); m; m = index.re.exec(text)) {
    const k = m[0], id = index.map.get(k), a = m.index, b = a + k.length;
    if (ASCII.test(k) && ((a > 0 && WORD.test(text[a - 1]) && WORD.test(k[0])) || (b < text.length && WORD.test(text[b]) && WORD.test(k[k.length - 1])))) {
      index.re.lastIndex = a + 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (a > last) out.push({ text: text.slice(last, a) });
    out.push({ text: k, id });
    last = b;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** 一段文字提到了哪些觀念（依出現順序，不重複） */
export const termsIn = (index, text) => splitTerms(index, text).filter((x) => x.id).map((x) => x.id);

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** 某個觀念和某一關的關聯程度：關卡的標籤對到觀念的標籤或關鍵字（3 分）、學習卡的標題提到它（2 分）、說明或學習卡內文提到它（1 分） */
function score(index, c, lv) {
  const names = new Set([c.t, ...(c.keys || []), ...(c.tags || [])].map(norm));
  let s = 0;
  if ((lv.tags || []).some((t) => names.has(norm(t)))) s += 3;
  if ((lv.learn || []).some((x) => termsIn(index, x.t).includes(c.id))) s += 2;
  if (termsIn(index, lv.brief || '').includes(c.id) || (lv.learn || []).some((x) => termsIn(index, x.d).includes(c.id))) s += 1;
  return s;
}

/** 這一關會用到的觀念：分數高的在前面 */
export function levelConcepts(index, concepts, lv, max = 12) {
  return concepts.map((c) => ({ c, s: score(index, c, lv) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.c);
}

/** 這個觀念在哪些關卡出現（標籤或學習卡標題對得上的才算，免得太多） */
export function conceptLevels(index, c, levels) {
  return levels.filter((lv) => !lv.sandbox && !lv.drill && score(index, c, lv) >= 2);
}

/** 搜尋：標題、英文名稱、關鍵字、摘要、內文；標題命中的排前面 */
export function searchConcepts(concepts, q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const rows = [];
  for (const c of concepts) {
    const head = norm([c.t, c.en || '', ...(c.keys || [])].join(' '));
    const deep = (c.deep || []).flatMap((s) => [s.h, ...(s.p || []), ...(s.list || []), s.note || '']);
    const all = head + ' ' + norm([c.sum, ...(c.body || []), ...((c.steps && c.steps.items) || []), ...(c.pit || []), ...deep].join(' '));
    if (!words.every((w) => all.includes(w))) continue;
    rows.push({ c, s: words.reduce((t, w) => t + (head.includes(w) ? 2 : 0), 0) + (norm(c.t).startsWith(words[0]) ? 3 : 0) });
  }
  return rows.sort((a, b) => b.s - a.s).map((x) => x.c);
}
