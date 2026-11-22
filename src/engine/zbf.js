// IOS 的 Zone-Based Firewall (ZBF)
//
// - 介面用 zone-member security <zone> 加進 zone；同一個 zone 裡的介面互通
// - 不同 zone 之間預設全部拒絕，要有 zone-pair（來源 zone → 目的 zone）套用 policy-map type inspect 才放行
// - 有 zone 的介面和沒有 zone 的介面之間一律不通
// - class-map type inspect 依 match protocol / match access-group 分類；policy-map 的動作：
//     inspect：有狀態，回程自動放行（連線表）
//     pass：無狀態、只放行這一個方向，回程要另外一條 zone-pair 也 pass
//     drop：丟掉（class-default 預設就是 drop）
// - self zone 是路由器自己：沒有指向 self 的 zone-pair 時，進出路由器本身的流量都放行
//
// d.zbf = { zones: { 名稱: { desc } }, cmaps: { 名稱: { any, match: [{ t: 'protocol' | 'acl', v }] } },
//           pmaps: { 名稱: [{ cls, act: 'inspect' | 'pass' | 'drop', log }] }, pairs: { 名稱: { src, dst, policy } } }
// i.zone = 'INSIDE'

// match protocol 認得的協定 → [協定, 埠]
export const ZBF_PROTO = {
  http: [['tcp', 80]], https: [['tcp', 443]], dns: [['udp', 53], ['tcp', 53]], icmp: [['icmp']], ssh: [['tcp', 22]], telnet: [['tcp', 23]],
  ftp: [['tcp', 21]], smtp: [['tcp', 25]], pop3: [['tcp', 110]], imap: [['tcp', 143]], ntp: [['udp', 123]], snmp: [['udp', 161]],
  syslog: [['udp', 514]], tftp: [['udp', 69]], sip: [['udp', 5060], ['tcp', 5060]], 'ms-wbt': [['tcp', 3389]], tcp: [['tcp']], udp: [['udp']],
};
export const newZbf = () => ({ zones: {}, cmaps: {}, pmaps: {}, pairs: {} });
/** 這台路由器有沒有在用 ZBF（任何一個介面加進了 zone） */
export const zbfActive = (d) => !!d.zbf && d.ifaces.some((i) => i.zone);
const protoHit = (p, pkt) => (ZBF_PROTO[p] || []).some(([proto, port]) => proto === pkt.proto && (port == null || pkt.dport === port));
/** 封包符不符合這個 class-map（aclOk(名稱, 封包)：ACL 有沒有放行） */
export function cmapHit(cm, pkt, aclOk) {
  if (!cm || !cm.match.length) return false;
  const one = (m) => (m.t === 'protocol' ? protoHit(m.v, pkt) : m.t === 'acl' ? aclOk(m.v, pkt) : false);
  return cm.any ? cm.match.some(one) : cm.match.every(one);
}
/** 這兩個介面之間需不需要 zone-pair（null = 不受 ZBF 管） */
export function zbfNeeds(d, inIf, outIf) {
  if (!zbfActive(d)) return false;
  const zi = inIf ? inIf.zone || null : 'self', zo = outIf ? outIf.zone || null : 'self';
  if (zi === 'self' || zo === 'self') return !!pairOf(d, zi, zo);
  if (!zi && !zo) return false;
  return zi !== zo;
}
const pairOf = (d, zi, zo) => Object.entries((d.zbf && d.zbf.pairs) || {}).find(([, p]) => p.src === zi && p.dst === zo);

/**
 * 依 ZBF 判斷這個封包能不能從 inIf 到 outIf（inIf / outIf 是 null 代表路由器自己：self zone）。
 * 回傳 { ok, act, pair, cls, reason }
 */
export function zbfCheck(d, inIf, outIf, pkt, aclOk) {
  if (!zbfActive(d)) return { ok: true };
  const zi = inIf ? inIf.zone || null : 'self', zo = outIf ? outIf.zone || null : 'self';
  const lab = (i) => (i ? i.label : d.name);
  if (zi === 'self' || zo === 'self') {
    if (!pairOf(d, zi, zo)) return { ok: true }; // 沒有指向 self 的 zone-pair：路由器本身的流量都放行
  } else {
    if (!zi && !zo) return { ok: true };
    if (!zi || !zo) {
      const [z, i] = zi ? [zi, inIf] : [zo, outIf], other = zi ? outIf : inIf;
      return { ok: false, reason: `${d.name} 的 ${lab(i)} 在 zone ${z}，${lab(other)} 不屬於任何 zone：有 zone 的介面和沒有 zone 的介面之間一律不通（ZBF）` };
    }
    if (zi === zo) return { ok: true };
  }
  const pr = pairOf(d, zi, zo);
  if (!pr) return { ok: false, reason: `${d.name} 沒有 ${zi} → ${zo} 的 zone-pair：不同 zone 之間預設全部拒絕（ZBF）${pkt.reply ? '。這是回程的封包：去程如果用的是 pass（無狀態），回程也要有一條 zone-pair 放行；用 inspect 的話回程會自動放行' : ''}` };
  const [name, p] = pr;
  const pm = p.policy && d.zbf.pmaps[p.policy];
  if (!pm) return { ok: false, reason: `${d.name} 的 zone-pair ${name}（${zi} → ${zo}）沒有套用 service-policy type inspect，全部拒絕` };
  for (const c of pm) {
    if (c.cls === 'class-default') continue;
    if (cmapHit(d.zbf.cmaps[c.cls], pkt, aclOk)) {
      c.hits = (c.hits || 0) + 1;
      return c.act === 'drop' ? { ok: false, act: 'drop', pair: name, cls: c.cls, reason: `${d.name} 的 zone-pair ${name} 裡 class ${c.cls} 的動作是 drop` }
        : { ok: true, act: c.act || 'inspect', pair: name, cls: c.cls };
    }
  }
  const def = pm.find((c) => c.cls === 'class-default');
  if (def && def.act === 'pass') return { ok: true, act: 'pass', pair: name, cls: 'class-default' };
  if (def && def.act === 'inspect') return { ok: true, act: 'inspect', pair: name, cls: 'class-default' };
  return { ok: false, act: 'drop', pair: name, cls: 'class-default', reason: `${d.name} 的 zone-pair ${name}（${zi} → ${zo}）沒有任何 class 符合這個封包，class-default 丟掉 (drop)` };
}

/** running-config 的 ZBF 部分（class-map、policy-map、zone、zone-pair；介面的 zone-member 另外印） */
export function zbfConfigLines(d) {
  const z = d.zbf;
  if (!z) return [];
  const o = [];
  for (const [n, cm] of Object.entries(z.cmaps)) {
    o.push(`class-map type inspect ${cm.any ? 'match-any' : 'match-all'} ${n}`);
    for (const m of cm.match) o.push(m.t === 'protocol' ? ` match protocol ${m.v}` : ` match access-group name ${m.v}`);
    o.push('!');
  }
  for (const [n, pm] of Object.entries(z.pmaps)) {
    o.push(`policy-map type inspect ${n}`);
    for (const c of pm) o.push(c.cls === 'class-default' ? ' class class-default' : ` class type inspect ${c.cls}`, `  ${c.act || 'drop'}${c.log ? ' log' : ''}`);
    o.push('!');
  }
  for (const [n, x] of Object.entries(z.zones)) o.push(`zone security ${n}`, ...(x.desc ? [` description ${x.desc}`] : []));
  for (const [n, p] of Object.entries(z.pairs)) o.push(`zone-pair security ${n} source ${p.src} destination ${p.dst}`, ...(p.policy ? [` service-policy type inspect ${p.policy}`] : []));
  if (Object.keys(z.zones).length || Object.keys(z.pairs).length) o.push('!');
  return o;
}
