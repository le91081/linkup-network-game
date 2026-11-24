// 存檔格式的版本與遷移
//
// 每次改了設定的資料結構（欄位改名、搬家、拆開），就在 STEPS 加一步、SAVE_VER 加一：
// 舊的存檔（瀏覽器裡的進度、匯出的拓撲檔與關卡檔）載入時從它的版本一步一步升級，玩家的進度不用丟掉。
// 每一步都要能安全地重複執行（沒有舊欄位就什麼都不做）。
import { DNS_TTL } from './dns.js';
import { legacyMac, macOf } from './sim/core.js';

export const SAVE_VER = 3;

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
  // 2 → 3：MAC 位址改成真的廠商碼 (OUI) 加連號（以前全部是 02 開頭）。設定裡寫到舊位址的地方
  // （Port Security、DHCP 保留、無線的 MAC 過濾、靜態 MAC…）換成同一個介面現在的位址，玩家做到一半的關卡不會因此壞掉
  2(st) {
    const map = new Map();
    for (const d of Object.values(st.devices || {})) {
      if (!d || !d.id) continue;
      const ports = Array.isArray(d.ports) ? d.ports : [];
      ports.forEach((p, n) => p && p.id && map.set(legacyMac(d.id, p.id), macOf(d.id, p.id, d.model, n)));
      map.set(legacyMac(d.id, 'wlan'), macOf(d.id, 'wlan', d.model, ports.length));
      map.set(legacyMac(d.id, 'br'), macOf(d.id, 'br', d.model));
    }
    const re = /02(?:[:-][0-9a-f]{2}){5}|02[0-9a-f]{2}\.[0-9a-f]{4}\.[0-9a-f]{4}/gi;
    const fix = (str) => str.replace(re, (m) => {
      const hex = m.toLowerCase().replace(/[^0-9a-f]/g, ''), neu = map.get(hex.match(/../g).join(':'));
      if (!neu) return m;
      if (m.includes('.')) return neu.replace(/:/g, '').match(/.{4}/g).join('.');
      return m.includes('-') ? neu.replace(/:/g, '-') : neu;
    });
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 12) return;
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'string') { if (o[k].length >= 14 && o[k].includes('02')) o[k] = fix(o[k]); } else walk(o[k], depth + 1);
      }
    };
    walk(st.devices, 0);
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
