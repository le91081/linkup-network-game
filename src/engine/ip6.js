// IPv6 小工具：位址以 BigInt 表示（只存在執行期的 rt 裡，不會被存檔）

export function parseIp6(s) {
  if (typeof s !== 'string') return null;
  s = s.trim().toLowerCase();
  if (!s || !/^[0-9a-f:]+$/.test(s)) return null;
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  if (dbl.length === 1 && head.length !== 8) return null;
  if (dbl.length === 2 && head.length + tail.length > 7) return null;
  const parts = dbl.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  let n = 0n;
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    n = (n << 16n) | BigInt(parseInt(p, 16));
  }
  return n;
}

/** 依 RFC 5952 壓縮：最長的一段連續 0（至少兩組）換成 :: */
export function fmtIp6(n) {
  if (n == null) return '';
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let best = -1, len = 0;
  for (let i = 0; i < 8; i++) {
    if (g[i] !== 0) continue;
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > len) { best = i; len = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (len < 2) return hex.join(':');
  return hex.slice(0, best).join(':') + '::' + hex.slice(best + len).join(':');
}

/** "2001:db8::1/64" → { ip, bits } */
export function parseCidr6(s) {
  const [a, b] = String(s || '').trim().split('/');
  const ip = parseIp6(a);
  if (ip == null) return null;
  const bits = b === undefined ? 128 : +b;
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  return { ip, bits };
}

export const net6 = (ip, bits) => (bits === 0 ? 0n : (ip >> BigInt(128 - bits)) << BigInt(128 - bits));

function eui(mac) {
  const b = mac.split(':').map((x) => parseInt(x, 16));
  b[0] ^= 2;
  return [b[0], b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]].reduce((n, x) => (n << 8n) | BigInt(x), 0n);
}
/** fe80::/64 加上由 MAC 推導的 EUI-64 介面識別碼 */
export const linkLocal = (mac) => (0xfe80n << 112n) | eui(mac);
export const eui64 = (prefix, mac) => prefix | eui(mac);
export const isLinkLocal = (ip) => (ip >> 118n) === 0x3fan; // fe80::/10
