// 負載平衡器（F5 BIG-IP 的 LTM）
//
// 用戶端連的是 virtual server（VIP:埠）。BIG-IP 從 pool 裡挑一台「健康」的成員，把目的位址換成成員的 IP:埠（DNAT）再送過去。
// 健康與否由健康檢查 (monitor) 決定：tcp 只看連得上、http / https 還要看回應內容符不符合 Receive String、gateway_icmp 只 ping。
//
// d.ltm = {
//   monitors: [{ name, type: 'http' | 'https' | 'tcp' | 'gateway_icmp', send, recv }]   自訂的健康檢查（內建 tcp、http、https、gateway_icmp）
//   pools:    [{ name, monitor, lb: 'round-robin' | 'least-connections-member', members: [{ ip, port, state: 'enabled' | 'disabled' | 'offline' }] }]
//   virtuals: [{ name, dst, port, pool, snat: 'none' | 'automap', persist: 'none' | 'source_addr', off }]
// }
//
// 回程：成員的回應一定要回到 BIG-IP，它才能把來源換回 VIP。兩種做法：
//   SNAT Automap：送給成員時，來源換成 BIG-IP 在那個 VLAN 的 self IP，回應自然回到 BIG-IP（一臂式 one-arm 的拓撲一定要這樣）
//   不做 SNAT：成員的預設閘道要是 BIG-IP 的 self IP（BIG-IP 擋在伺服器的路上，routed mode）
// 兩個都沒有：成員把回應直接送給用戶端，來源是成員自己的 IP，用戶端不認得，連線失敗（非對稱路由）
import { parseIp, fmtIp } from './ip.js';
import { transact } from './sim/transact.js';

export const BUILTIN_MONITORS = [
  { name: 'gateway_icmp', type: 'gateway_icmp', builtin: true },
  { name: 'tcp', type: 'tcp', builtin: true },
  { name: 'http', type: 'http', send: 'GET /\\r\\n', recv: '', builtin: true },
  { name: 'https', type: 'https', send: 'GET /\\r\\n', recv: '', builtin: true },
];
export const MON_TYPES = ['http', 'https', 'tcp', 'gateway_icmp'];
export const LB_METHODS = [['round-robin', 'Round Robin（輪流）'], ['least-connections-member', 'Least Connections（連線數最少）']];

const REASON = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };
/** 網站伺服器回應的狀態列：d.web.status（沒寫就是 200） */
export function httpStatus(srv) {
  const code = +((srv && srv.web && srv.web.status) || 200);
  return { code, text: REASON[code] || '', line: `HTTP/1.1 ${code} ${REASON[code] || ''}`.trim() };
}

export const isLb = (d) => !!(d && d.kind === 'lb' && d.ltm);
export function monitorOf(d, name) {
  if (!name) return null;
  return (d.ltm.monitors || []).find((m) => m.name === name) || BUILTIN_MONITORS.find((m) => m.name === name) || null;
}
export const allMonitors = (d) => [...BUILTIN_MONITORS, ...(d.ltm.monitors || [])];

/** 一個成員的健康檢查：{ st: 'up' | 'down' | 'unknown' | 'disabled' | 'offline', why } */
function probe(state, d, pool, m) {
  if (m.state === 'offline') return { st: 'offline', why: '強制離線 (Forced Offline)：新的、既有的連線都不給它' };
  if (m.state === 'disabled') return { st: 'disabled', why: '停用 (Disabled)：只處理既有的連線，不接新的連線' };
  const ip = parseIp(m.ip || '');
  if (ip == null || !(+m.port >= 0)) return { st: 'down', why: `成員的位址 ${m.ip}:${m.port} 不正確` };
  const mon = monitorOf(d, pool.monitor);
  if (!mon) return { st: 'unknown', why: '沒有設定健康檢查：BIG-IP 不知道它活不活著，一律當成可用（狀態 Unknown）' };
  if (mon.type === 'gateway_icmp') {
    const r = transact(state, d.id, { proto: 'icmp', dst: ip, quiet: true });
    return r.ok ? { st: 'up', why: `${mon.name}：ping 得到` } : { st: 'down', why: `${mon.name}：ping ${m.ip} 沒有回應（${r.reason}）` };
  }
  const port = +m.port;
  const r = transact(state, d.id, { proto: 'tcp', dst: ip, dport: port, quiet: true, bulk: false });
  if (!r.ok) return { st: 'down', why: `${mon.name}：TCP ${m.ip}:${port} 連不上（${r.reason}）` };
  if (mon.type === 'tcp') return { st: 'up', why: `${mon.name}：TCP ${port} 連得上（只看連線，不管應用程式回什麼）` };
  if (mon.type === 'https' && port === 80) return { st: 'down', why: `${mon.name}：${port} 是明文的 HTTP，TLS 交握失敗` };
  const srv = state.devices[r.responder];
  const s = mon.type === 'http' && port === 443 ? { code: 400, line: 'HTTP/1.1 400 Bad Request' } : httpStatus(srv);
  const body = `${s.line}\r\n\r\n<title>${(srv && srv.web && srv.web.title) || (srv && srv.name) || ''}</title>`;
  if (mon.recv && !body.includes(mon.recv)) return { st: 'down', why: `${mon.name}：回應是「${s.line}」，不符合 Receive String「${mon.recv}」` };
  return { st: 'up', why: `${mon.name}：回應「${s.line}」${mon.recv ? `，符合「${mon.recv}」` : '（Receive String 是空的：有回應就算活著）'}` };
}

let rrFallback = 0;
/**
 * 這台 BIG-IP 每個 pool 的成員狀態：{ pools: { 名稱: [{ ip, port, st, why }] }, rr: { virtual 的名稱: 計數 } }
 * 一次計算之後算一次就好（state.rt.ltmOk：路由已經算好），之後的查詢都用同一份
 */
export function ltmHealth(state, d) {
  const rt = state.rt || {};
  const cache = rt.ltmOk ? (rt.ltm ||= {}) : null;
  if (cache && cache[d.id]) return cache[d.id];
  const out = { pools: {}, rr: {} };
  if (cache) cache[d.id] = out;
  for (const p of d.ltm.pools || []) out.pools[p.name] = (p.members || []).map((m) => ({ ip: m.ip, port: +m.port, ...probe(state, d, p, m) }));
  return out;
}
export const availOf = (h) => h.filter((x) => x.st === 'up' || x.st === 'unknown');
/** pool 的整體狀態：available（綠）、offline（紅，沒有可用的成員）、unknown（藍，沒有健康檢查） */
export function poolStatus(h) {
  if (!h.length) return { st: 'offline', text: '沒有成員' };
  const a = availOf(h);
  if (!a.length) return { st: 'offline', text: `沒有可用的成員（0 / ${h.length}）` };
  if (a.every((x) => x.st === 'unknown')) return { st: 'unknown', text: `沒有健康檢查（${a.length} / ${h.length}）` };
  return { st: 'up', text: `可用 ${a.length} / ${h.length}` };
}

const hash = (s) => { let k = 0; for (const c of String(s)) k = (k * 31 + c.charCodeAt(0)) >>> 0; return k; };
export const vsMatch = (v, pkt) => !v.off && parseIp(v.dst || '') === pkt.dst && (pkt.proto === (v.proto || 'tcp')) && (+v.port === 0 || +v.port === pkt.dport);

/**
 * 封包到了 BIG-IP：符合某個 virtual server 就挑一個成員。
 * 回傳 null（不是給 virtual server 的）、{ drop }（沒有可用的成員：BIG-IP 重設連線）、或 { ip, port, lb }
 */
export function ltmPick(state, d, pkt) {
  if (!isLb(d)) return null;
  const vs = (d.ltm.virtuals || []).find((v) => vsMatch(v, pkt));
  if (!vs) return null;
  const pool = (d.ltm.pools || []).find((p) => p.name === vs.pool);
  if (!pool) return { drop: `${d.name} 的 virtual server ${vs.name} 沒有指定 pool：BIG-IP 收下連線之後不知道要交給誰，連線被重設 (RST)` };
  const H = ltmHealth(state, d), h = H.pools[pool.name] || [], a = availOf(h);
  if (!a.length) return { drop: `${d.name} 的 virtual server ${vs.name}（${vs.dst}:${vs.port}）：pool ${pool.name} 沒有可用的成員，連線被重設 (RST)。${h.map((x) => `${x.ip}:${x.port} ${x.why}`).join('；') || 'pool 裡沒有成員'}` };
  let k;
  if (vs.persist === 'source_addr') k = hash(fmtIp(pkt.src));
  else { k = H.rr[vs.name] ?? rrFallback++; H.rr[vs.name] = k + 1; }
  const m = a[k % a.length];
  return { ip: parseIp(m.ip), port: m.port || pkt.dport, lb: { vs, pool, member: m, n: a.length, total: h.length } };
}

/** 給 DNAT 的紀錄：Virtual server 挑了哪個成員 */
export function pickText(dnat, pkt) {
  const { vs, pool, member, n, total } = dnat.lb;
  const how = vs.persist === 'source_addr' ? '來源位址 persistence：同一個用戶端固定給同一台' : pool.lb === 'least-connections-member' ? 'Least Connections' : 'Round Robin';
  return `Virtual server ${vs.name}（${fmtIp(pkt.dst)}:${pkt.dport}）：pool ${pool.name} 挑了 ${member.ip}:${member.port}（${how}，可用的成員 ${n} / ${total}），目的位址換成成員`;
}

/** 不屬於任何 virtual server 的流量：BIG-IP 預設不轉送 */
export const noVsReason = (d, pkt) => `${d.name} 不轉送不屬於任何 virtual server 的流量（${fmtIp(pkt.src)} → ${fmtIp(pkt.dst)}${pkt.proto === 'icmp' ? '' : ':' + pkt.dport}）：BIG-IP 是預設拒絕的全代理 (default deny)，要讓伺服器經過它連出去，得另外建一個 Forwarding (IP) 類型的 virtual server`;
