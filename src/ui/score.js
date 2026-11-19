// 關卡評分：用時、提示、測試次數（設定變更的次數只列出來參考，不扣分：多試幾次本來就是學習的一部分）
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 標準時間：基本 3 分鐘，每個目標再加 1.5 分鐘 */
export const parOf = (lv) => 180 + 90 * lv.objectives.length;

export function scoreOf(lv, att, hints) {
  const secs = Math.round((att && att.ms) / 1000) || 0;
  const par = parOf(lv);
  const runs = (att && att.runs) || 0;
  const pTime = Math.min(300, Math.max(0, Math.round((secs - par) / 3)));
  const pHint = 150 * hints;
  const pRuns = Math.min(150, Math.max(0, runs - 3) * 15);
  const score = Math.max(100, 1000 - pTime - pHint - pRuns);
  const grade = score >= 950 ? 'S' : score >= 850 ? 'A' : score >= 700 ? 'B' : 'C';
  return {
    score, grade, secs, par,
    rows: [
      ['用時', `${fmtTime(secs)}（標準 ${fmtTime(par)}，超過的部分每 3 秒扣 1 分）`, -pTime],
      ['提示', hints ? `看了 ${hints} 個` : '沒有看', -pHint],
      ['完整測試', `${runs} 次（前 3 次不扣分）`, -pRuns],
      ['設定變更', `${(att && att.changes) || 0} 次（只供參考）`, 0],
    ],
  };
}
