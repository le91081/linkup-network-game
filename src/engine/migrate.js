// 存檔格式的版本與遷移
//
// 每次改了設定的資料結構（欄位改名、搬家、拆開），就在 STEPS 加一步、SAVE_VER 加一：
// 舊的存檔（瀏覽器裡的進度、匯出的拓撲檔與關卡檔）載入時從它的版本一步一步升級，玩家的進度不用丟掉。
// 每一步都要能安全地重複執行（沒有舊欄位就什麼都不做）。
import { DNS_TTL } from './dns.js';

export const SAVE_VER = 2;

/** 從第 n 版升到第 n + 1 版 */
const STEPS = {
  // 1 → 2：DNS 伺服器舊的「名稱 → IP」對照表 (d.dnsRecords) 改成一般的記錄 (d.dnsZone.records)
  1(st) {
    for (const d of Object.values(st.devices || {})) {
      if (!d || !d.dnsRecords) continue;
      if (!d.dnsZone) d.dnsZone = { records: Object.entries(d.dnsRecords).map(([name, value]) => ({ name, type: 'A', value, ttl: DNS_TTL })) };
      delete d.dnsRecords;
    }
  },
};

/**
 * 把一份狀態（state：devices、cables…）升級到目前的版本。回傳 { state, from, newer }：
 * newer 代表存檔來自比較新的版本（不動它，交給呼叫的人決定要不要用）
 */
export function migrateState(st) {
  if (!st || typeof st !== 'object' || !st.devices) return { state: st, from: null, newer: false };
  const from = Number.isInteger(st.ver) && st.ver > 0 ? st.ver : 1;
  if (from > SAVE_VER) return { state: st, from, newer: true };
  for (let v = from; v < SAVE_VER; v++) STEPS[v](st);
  st.ver = SAVE_VER;
  return { state: st, from, newer: false };
}

/** 整份進度（localStorage 裡的 store）：每一關的存檔都升級 */
export function migrateStore(store) {
  if (!store || typeof store !== 'object') return store;
  // 比較新的版本存的關卡留著不動（開那一關時當作沒有存檔），換回新版本時還找得回來
  for (const st of Object.values(store.saves || {})) migrateState(st);
  for (const c of store.custom || []) if (c && c.state) migrateState(c.state); // 自訂關卡（自由模式做的、匯入的）
  store.ver = Math.max(SAVE_VER, +store.ver || 0);
  return store;
}
