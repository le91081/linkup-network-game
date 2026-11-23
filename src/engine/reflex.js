// IOS 的 Reflexive ACL：具名的延伸 ACL 裡 permit … reflect <名稱> [timeout <秒>]，
// 封包符合這一條離開時，記下一筆「位址與連接埠反過來」的暫時規則；另一個方向的 ACL 用 evaluate <名稱> 比對這些暫時規則。
// 只有自己這邊先送出去的連線，回應才進得來（TCP、UDP、ICMP 都可以，不像 established 只看 TCP 的旗標）。
// 暫時規則沒有再被用到就在 timeout 之後消失（預設 300 秒，ip reflexive-list timeout 改全域的預設值）。
//
// state.dyn.reflex[設備][名稱] = [{ proto, src, dst, sport, dport, at, timeout, hits }]
export const REFLEX_TIMEOUT = 300;

const listOf = (state, dev, name) => (((state.dyn.reflex ||= {})[dev.id] ||= {})[name] ||= []);
const live = (state, e) => state.clock - e.at < e.timeout;
const ported = (p) => p === 'tcp' || p === 'udp';

/** 這個封包要離開：記下反過來的暫時規則（同一條連線只記一筆，重新計時） */
export function reflexAdd(state, dev, name, pkt, timeout) {
  const l = listOf(state, dev, name), t = +timeout || +dev.reflexTimeout || REFLEX_TIMEOUT;
  const m = { proto: pkt.proto, src: pkt.dst, dst: pkt.src, sport: ported(pkt.proto) ? pkt.dport : null, dport: ported(pkt.proto) ? pkt.sport : null };
  const e = l.find((x) => x.proto === m.proto && x.src === m.src && x.dst === m.dst && x.sport === m.sport && x.dport === m.dport);
  if (e) { e.at = state.clock; e.timeout = t; return e; }
  const n = { ...m, at: state.clock, timeout: t, hits: 0 };
  l.push(n);
  return n;
}

/** evaluate <名稱>：進來的封包符不符合某一筆還沒過期的暫時規則（符合就重新計時） */
export function reflexHit(state, dev, name, pkt) {
  const l = ((state.dyn.reflex || {})[dev.id] || {})[name];
  if (!l) return null;
  for (let k = l.length - 1; k >= 0; k--) if (!live(state, l[k])) l.splice(k, 1);
  const e = l.find((x) => x.proto === pkt.proto && x.src === pkt.src && x.dst === pkt.dst && (!ported(x.proto) || (x.sport === pkt.sport && x.dport === pkt.dport)));
  if (e) { e.hits++; e.at = state.clock; }
  return e || null;
}

/** show access-lists 用：這台設備每一個 reflexive list 與還在的暫時規則（剩幾秒） */
export function reflexLists(state, dev) {
  const names = new Set();
  for (const i of dev.ifaces) for (const k of ['aclIn', 'aclOut']) for (const r of i[k] || []) { if (r.reflect) names.add(r.reflect); if (r.evaluate) names.add(r.evaluate); }
  const t = ((state.dyn && state.dyn.reflex) || {})[dev.id] || {};
  return [...names].sort().map((name) => ({ name, rows: (t[name] || []).filter((e) => live(state, e)).map((e) => ({ ...e, left: Math.ceil(e.timeout - (state.clock - e.at)) })) }));
}
export function clearReflex(state, dev) { if (state.dyn && state.dyn.reflex) delete state.dyn.reflex[dev.id]; }
