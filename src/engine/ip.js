// IPv4 小工具：所有位址在引擎內部都以 0 ~ 2^32-1 的數字表示

export function parseIp(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = +m[i];
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

export function fmtIp(n) {
  if (n == null) return '';
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function maskOf(bits) {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** 接受 "255.255.255.0"、"24"、"/24"，回傳前綴長度；不合法回傳 null */
export function parseMask(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  const p = s.match(/^\/?(\d{1,2})$/);
  if (p) {
    const b = +p[1];
    return b <= 32 ? b : null;
  }
  const m = parseIp(s);
  if (m == null) return null;
  for (let b = 0; b <= 32; b++) if (maskOf(b) === m) return b;
  return null;
}

export const fmtMask = (bits) => fmtIp(maskOf(bits));
export const netOf = (ip, bits) => (ip & maskOf(bits)) >>> 0;
export const sameNet = (a, b, bits) => netOf(a, bits) === netOf(b, bits);
export const bcastOf = (ip, bits) => (netOf(ip, bits) | (~maskOf(bits) >>> 0)) >>> 0;

/** "10.0.0.0/24" 或單一 IP → { net, bits } */
export function parseCidr(s) {
  if (typeof s !== 'string') return null;
  const [a, b] = s.trim().split('/');
  const ip = parseIp(a);
  if (ip == null) return null;
  if (b === undefined) return { net: ip, bits: 32 };
  const bits = parseMask(b);
  if (bits == null) return null;
  return { net: netOf(ip, bits), bits };
}

export function isPrivate(ip) {
  return (
    sameNet(ip, 0x0a000000, 8) || // 10.0.0.0/8
    sameNet(ip, 0xac100000, 12) || // 172.16.0.0/12
    sameNet(ip, 0xc0a80000, 16) || // 192.168.0.0/16
    sameNet(ip, 0xa9fe0000, 16) || // 169.254.0.0/16
    sameNet(ip, 0x64400000, 10) // 100.64.0.0/10
  );
}

/** 介面位址是否可用（不是網路位址也不是廣播位址） */
export function hostAddrProblem(ip, bits) {
  if (bits >= 31) return null;
  if (ip === netOf(ip, bits)) return '這是網路位址，不能指派給設備';
  if (ip === bcastOf(ip, bits)) return '這是廣播位址，不能指派給設備';
  return null;
}

/** "10,20,30-32" → [10,20,30,31,32]；"all" → null（代表全部） */
export function parseVlanList(s) {
  if (s == null) return null;
  s = String(s).trim().toLowerCase();
  if (s === '' || s === 'all') return null;
  const out = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let v = a; v <= b && v <= 4094; v++) out.push(v);
  }
  return out;
}
