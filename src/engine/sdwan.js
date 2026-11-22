// SD-WAN（FortiGate）：好幾條 WAN 線路合成一個區域 (virtual-wan-link)，依流量的種類挑線路。
//
// 效能 SLA (health check)：持續量每條線路到偵測目標（例如 8.8.8.8）的延遲、抖動、遺失，和門檻比較。
// SD-WAN 規則由上往下比對（目的位址、協定、埠），符合的就照它的方式挑線路：
//   manual：照順序挑第一條活著的；sla：照順序挑第一條「符合 SLA」的，全部不符合就用第一條活著的；
//   latency：延遲最低的那條（最佳品質）。
// 沒有符合任何規則的流量（implicit rule）：所有活著的成員依來源位址分散（source-ip-based）。
// 成員的介面一旦加進 SD-WAN，防火牆政策的目的介面要寫 virtual-wan-link。
//
// 線路品質來自 ISP 那一端的線路：line.q = { delay（單向毫秒）, jitter（毫秒）, loss（%）}，沒寫就是品質很好的光纖。
//
// d.sdwan = { on, members: [{ seq, iface, gw }], hc: { name, server, latency, jitter, loss },
//             rules: [{ name, dst（位址清單，any 或 CIDR）, proto: 'any' | 'tcp' | 'udp', port（空白表示全部）, mode: 'manual' | 'sla' | 'latency', prio: [seq…] }] }
import { parseIp, fmtIp, parseCidr, netOf } from './ip.js';

export const ZONE = 'virtual-wan-link';
const GOOD = { delay: 4, jitter: 1, loss: 0 };

/** 新的 SD-WAN 設定（還沒有成員） */
export function newSdwan() {
  return { on: true, members: [], hc: { name: 'Default_DNS', server: '8.8.8.8', latency: 150, jitter: 30, loss: 1 }, rules: [] };
}
export const sdwanOn = (d) => !!(d && d.kind === 'firewall' && d.sdwan && d.sdwan.on);
/** 這個介面是不是 SD-WAN 的成員 */
export const isMember = (d, ifId) => sdwanOn(d) && d.sdwan.members.some((m) => m.iface === ifId);
/** 政策的介面欄位是不是指到這個介面（any、介面本身、或介面所在的 SD-WAN 區域） */
export const zoneHas = (d, name, i) => name === ZONE && !!i && isMember(d, i.id);

/** 一個埠接到 ISP 的那條線路：{ inet, port, q（線路品質）, ok（線路有沒有通） }；不是接到 ISP 回傳 null */
export function lineAt(state, devId, pid) {
  const c = state.cables.find((x) => (x.a.dev === devId && x.a.port === pid) || (x.b.dev === devId && x.b.port === pid));
  if (!c) return null;
  const o = c.a.dev === devId && c.a.port === pid ? c.b : c.a;
  const inet = state.devices[o.dev];
  if (!inet || inet.kind !== 'internet') return null;
  const i = inet.ifaces.find((x) => x.id === o.port) || {};
  const up = (state.rt.cable || {})[c.id] !== 'down' && !(state.cut || {})[c.id] && !(inet.inet && inet.inet.fault);
  return { inet, port: o.port, q: { ...GOOD, ...((i.line || {}).q || {}) }, ok: up };
}

/** 每個成員現在的狀態：{ m, iface, alive, why, latency, jitter, loss, sla } */
export function memberHealth(state, d) {
  if (!sdwanOn(d)) return [];
  const hc = d.sdwan.hc || {};
  return d.sdwan.members.map((m) => {
    const i = d.ifaces.find((x) => x.id === m.iface);
    const base = { m, iface: i, alive: false, latency: null, jitter: null, loss: null, sla: false };
    if (!i) return { ...base, why: `沒有 ${m.iface} 這個介面` };
    if (!i.rt || i.rt.ip == null || !i.rt.link) return { ...base, why: `${i.label} 沒有連線或沒有 IP` };
    const gw = parseIp(m.gw || '');
    if (gw == null) return { ...base, why: `成員 ${i.label} 沒有設定閘道 (gateway)` };
    if (netOf(gw, i.rt.bits) !== netOf(i.rt.ip, i.rt.bits)) return { ...base, why: `成員 ${i.label} 的閘道 ${m.gw} 不在 ${fmtIp(i.rt.ip)}/${i.rt.bits} 的網段裡` };
    const ln = lineAt(state, d.id, i.bind.port);
    if (ln && !ln.ok) return { ...base, why: `${i.label} 的線路不通：偵測 ${hc.server || '目標'} 沒有回應 (dead)` };
    const q = ln ? ln.q : GOOD;
    // 量到的是來回時間：去程 + 回程，再加上防火牆與 ISP 機房內部的一點時間
    const r = { ...base, alive: true, why: '', latency: Math.round((2 * q.delay + 2) * 10) / 10, jitter: q.jitter, loss: q.loss };
    r.sla = r.latency <= +hc.latency && r.jitter <= +hc.jitter && r.loss <= +hc.loss;
    const bad = [r.latency > +hc.latency && `延遲 ${r.latency} ms > ${hc.latency}`, r.jitter > +hc.jitter && `抖動 ${r.jitter} ms > ${hc.jitter}`, r.loss > +hc.loss && `遺失 ${r.loss}% > ${hc.loss}%`].filter(Boolean);
    r.slaWhy = bad.join('、');
    return r;
  });
}

/** 加進路由表的 SD-WAN 預設路由：每個活著的成員一條（同樣的距離，等價） */
export function sdwanRoutes(state, d) {
  return memberHealth(state, d).filter((h) => h.alive).map((h) => ({ net: 0, bits: 0, via: parseIp(h.m.gw), iface: h.iface, type: 'S', ad: 1, metric: 0, vrf: '', sdwan: h.m.seq }));
}

const inList = (spec, ip) => {
  const s = String(spec || 'any').trim();
  if (!s || /^(any|all)$/i.test(s)) return true;
  return s.split(/[,\s]+/).filter(Boolean).some((x) => { const c = parseCidr(x.includes('/') ? x : x + '/32'); return c && netOf(ip, c.bits) === c.net; });
};
const portIn = (spec, port) => {
  const s = String(spec || '').trim();
  if (!s) return true;
  return s.split(/[,\s]+/).some((x) => { const [a, b] = x.split('-').map(Number); return port >= a && port <= (b || a); });
};
/** 封包符合哪一條 SD-WAN 規則 */
export function ruleFor(d, pkt) {
  for (const r of d.sdwan.rules || []) {
    if (r.off) continue;
    if (!inList(r.dst, pkt.dst)) continue;
    if (r.proto && r.proto !== 'any' && r.proto !== pkt.proto) continue;
    if (r.port && !(pkt.proto === 'tcp' || pkt.proto === 'udp')) continue;
    if (r.port && !portIn(r.port, pkt.dport)) continue;
    return r;
  }
  return null;
}

/**
 * 符合規則的流量挑哪一個成員：{ route, rule, why }；沒有符合規則（交給等價路由分散）回傳 null
 * routes：路由表裡 SD-WAN 的預設路由（活著的成員）
 */
export function sdwanPick(state, d, pkt) {
  if (!sdwanOn(d)) return null;
  const rule = ruleFor(d, pkt);
  if (!rule) return null;
  const routes = (d.rt.routes || []).filter((r) => r.sdwan != null && !r.bad);
  if (!routes.length) return null;
  const H = memberHealth(state, d);
  const hOf = (seq) => H.find((x) => x.m.seq === seq);
  const order = (rule.prio || []).map(Number).filter((s) => routes.some((r) => r.sdwan === s));
  const routeOf = (seq) => routes.find((r) => r.sdwan === seq);
  const name = (seq) => { const h = hOf(seq); return h && h.iface ? h.iface.label : String(seq); };
  if (!order.length) return { route: null, rule, why: `SD-WAN 規則「${rule.name}」指定的成員都沒有活著` };
  if (rule.mode === 'latency') {
    const best = [...order].sort((a, b) => hOf(a).latency - hOf(b).latency)[0];
    return { route: routeOf(best), rule, why: `SD-WAN 規則「${rule.name}」（最佳品質：延遲最低）→ ${name(best)}（${hOf(best).latency} ms）` };
  }
  if (rule.mode === 'sla') {
    const ok = order.find((s) => hOf(s).sla);
    if (ok != null) {
      const skipped = order.slice(0, order.indexOf(ok)).map((s) => `${name(s)} 不符合 SLA（${hOf(s).slaWhy}）`);
      return { route: routeOf(ok), rule, why: `SD-WAN 規則「${rule.name}」（SLA）：${skipped.length ? skipped.join('；') + '，' : ''}改走 ${name(ok)}` };
    }
    return { route: routeOf(order[0]), rule, why: `SD-WAN 規則「${rule.name}」（SLA）：沒有任何成員符合 SLA，用順序第一條活著的 ${name(order[0])}` };
  }
  return { route: routeOf(order[0]), rule, why: `SD-WAN 規則「${rule.name}」（手動）→ ${name(order[0])}` };
}

// ───────────────────────── FortiOS 的輸出 ─────────────────────────

/** diagnose sys sdwan health-check */
export function diagHealth(state, d) {
  if (!sdwanOn(d)) return ['SD-WAN is disabled.（還沒有啟用 SD-WAN）'];
  const H = memberHealth(state, d), hc = d.sdwan.hc;
  const o = [`Health Check(${hc.name}):`];
  for (const h of H) {
    const nm = h.iface ? h.iface.id : h.m.iface;
    o.push(h.alive
      ? `Seq(${h.m.seq} ${nm}): state(alive), packet-loss(${h.loss.toFixed(3)}%) latency(${h.latency.toFixed(3)}), jitter(${h.jitter.toFixed(3)}), sla_map=0x${h.sla ? 1 : 0}`
      : `Seq(${h.m.seq} ${nm}): state(dead), packet-loss(100.000%) sla_map=0x0`);
  }
  o.push(`（SLA：延遲 ≤ ${hc.latency} ms、抖動 ≤ ${hc.jitter} ms、遺失 ≤ ${hc.loss}%；sla_map=0x1 表示符合）`);
  return o;
}
/** diagnose sys sdwan service */
export function diagService(state, d) {
  if (!sdwanOn(d)) return ['SD-WAN is disabled.（還沒有啟用 SD-WAN）'];
  const H = memberHealth(state, d), o = [];
  const MODE = { manual: 'manual', sla: 'sla', latency: 'priority' };
  (d.sdwan.rules || []).forEach((r, n) => {
    o.push(`Service(${n + 1}): Address Mode(IPV4) flags=0x200`, `  Gen(1), TOS(0x0/0x0), Protocol(${r.proto === 'tcp' ? 6 : r.proto === 'udp' ? 17 : 0}: ${r.port || '1->65535'}), Mode(${MODE[r.mode] || 'manual'})${r.mode === 'latency' ? ', link-cost-factor(latency)' : ''}`);
    const order = (r.prio || []).map(Number);
    o.push(`  Members(${order.length}):`);
    // 目前會選到的排在最前面（和 FortiOS 一樣）
    const pick = (() => { const ok = order.filter((s) => (H.find((x) => x.m.seq === s) || {}).alive); if (r.mode === 'sla') return ok.find((s) => H.find((x) => x.m.seq === s).sla) ?? ok[0]; if (r.mode === 'latency') return [...ok].sort((a, b) => H.find((x) => x.m.seq === a).latency - H.find((x) => x.m.seq === b).latency)[0]; return ok[0]; })();
    const sorted = [...order].sort((a, b) => (a === pick ? -1 : b === pick ? 1 : 0));
    sorted.forEach((s, k) => { const h = H.find((x) => x.m.seq === s); o.push(`    ${k + 1}: Seq_num(${s} ${h ? (h.iface || {}).id || h.m.iface : '?'}), ${h && h.alive ? 'alive' : 'dead'}, sla(0x${h && h.sla ? 1 : 0}), cfg_order(${order.indexOf(s)})${s === pick ? ', selected' : ''}`); });
    o.push('  Dst address(1):', `        ${/^(any|all|)$/i.test(String(r.dst || '').trim()) ? '0.0.0.0-255.255.255.255' : String(r.dst).split(/[,\s]+/).filter(Boolean).join(' ')}`, '');
  });
  if (!o.length) o.push('（還沒有任何 SD-WAN 規則：所有流量依來源位址分散到活著的成員）');
  return o;
}
/** show system sdwan（只顯示，設定請用圖形介面） */
export function sdwanConfigLines(d) {
  if (!d.sdwan) return [];
  const s = d.sdwan, hc = s.hc || {}, q = (x) => `"${x}"`;
  return ['config system sdwan', `    set status ${s.on ? 'enable' : 'disable'}`, '    config zone', `        edit ${q(ZONE)}`, '        next', '    end',
    '    config members', ...s.members.flatMap((m) => [`        edit ${m.seq}`, `            set interface ${q(m.iface)}`, ...(m.gw ? [`            set gateway ${m.gw}`] : []), '        next']), '    end',
    '    config health-check', `        edit ${q(hc.name || 'Default_DNS')}`, `            set server ${q(hc.server || '')}`, `            set members ${s.members.map((m) => m.seq).join(' ') || '0'}`,
    '            config sla', '                edit 1', `                    set latency-threshold ${hc.latency}`, `                    set jitter-threshold ${hc.jitter}`, `                    set packetloss-threshold ${hc.loss}`, '                next', '            end', '        next', '    end',
    '    config service', ...(s.rules || []).flatMap((r, n) => [`        edit ${n + 1}`, `            set name ${q(r.name || '')}`, `            set mode ${r.mode === 'latency' ? 'priority' : r.mode || 'manual'}`,
      ...(r.proto && r.proto !== 'any' ? [`            set protocol ${r.proto === 'tcp' ? 6 : 17}`] : []), ...(r.port ? [`            set start-port ${String(r.port).split('-')[0]}`, `            set end-port ${String(r.port).split('-')[1] || String(r.port).split('-')[0]}`] : []),
      `            set dst ${q(/^(any|all|)$/i.test(String(r.dst || '').trim()) ? 'all' : r.dst)}`, `            set src "all"`,
      ...(r.mode === 'sla' ? ['            config sla', `                edit ${q(hc.name || 'Default_DNS')}`, '                    set id 1', '                next', '            end'] : []),
      `            set priority-members ${(r.prio || []).join(' ')}`, '        next']), '    end', 'end'];
}

// ───────────────────────── 命令列：config system sdwan ─────────────────────────

/** 一行 FortiOS 指令拆成字（雙引號裡的空白不拆） */
function words(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}
/**
 * 套用 config system sdwan 底下的整段設定（從 config system sdwan 之後到最後的 end 之前）。
 * 成功回傳 null，失敗回傳錯誤訊息
 */
export function applySdwanCli(d, lines) {
  // 先拆成樹：每一層 config 底下有 edit 的項目、delete 的項目；項目裡有 set 與更深的 config
  const root = { set: {}, cfg: {} }, stack = [{ node: root }];
  for (const raw of lines) {
    const t = words(raw.trim());
    if (!t.length) continue;
    const w = t[0].toLowerCase(), top = stack[stack.length - 1];
    if (w === 'config') { const c = { entries: [], del: [] }; top.node.cfg[t.slice(1).join(' ')] = c; stack.push({ cfg: c, node: top.node }); }
    else if (w === 'edit' || w === 'delete') {
      if (!top.cfg) return `${w} 要在 config 底下`;
      if (w === 'delete') { top.cfg.del.push(t[1]); continue; }
      const e = { key: t[1], set: {}, unset: [], cfg: {} };
      top.cfg.entries.push(e);
      stack.push({ entry: e, node: e });
    } else if (w === 'next') { if (top.entry) stack.pop(); }
    else if (w === 'end') { if (top.entry) stack.pop(); stack.pop(); }
    else if (w === 'set') top.node.set[t[1]] = t.slice(2);
    else if (w === 'unset') (top.node.unset ||= []).push(t[1]);
    else return `command parse error before '${t[0]}'`;
  }
  // 和 FortiOS 一樣是「修改」：沒提到的項目維持原樣，edit 是新增或修改，delete 才會刪掉
  const one = (n, k) => (n.set[k] || [])[0];
  const s = d.sdwan ? JSON.parse(JSON.stringify(d.sdwan)) : { ...newSdwan(), on: false };
  if (one(root, 'status')) s.on = one(root, 'status') === 'enable';
  const mc = root.cfg.members;
  if (mc) {
    s.members = s.members.filter((m) => !mc.del.includes(String(m.seq)));
    for (const e of mc.entries) {
      let m = s.members.find((x) => String(x.seq) === e.key);
      if (!m) s.members.push((m = { seq: +e.key, iface: '', gw: '' }));
      const iface = one(e, 'interface') ?? m.iface;
      if (!d.ifaces.some((i) => i.id === iface)) return `members ${e.key}：沒有 ${iface || '（沒寫）'} 這個介面`;
      const inUse = iface !== m.iface ? (d.policies || []).findIndex((p) => p.srcIf === iface || p.dstIf === iface) : -1;
      if (inUse >= 0) return `members ${e.key}：${iface} 正被防火牆政策 ${inUse + 1} 使用（interface is in use）：先把政策的介面改成 ${ZONE}`;
      m.iface = iface;
      if (one(e, 'gateway') != null) m.gw = one(e, 'gateway');
    }
  }
  const hc = ((root.cfg['health-check'] || { entries: [] }).entries)[0];
  if (hc) {
    const sla = ((hc.cfg.sla || { entries: [] }).entries)[0] || { set: {} };
    s.hc = { name: hc.key, server: one(hc, 'server') ?? s.hc.server, latency: +(one(sla, 'latency-threshold') ?? s.hc.latency), jitter: +(one(sla, 'jitter-threshold') ?? s.hc.jitter), loss: +(one(sla, 'packetloss-threshold') ?? s.hc.loss) };
  }
  const sc = root.cfg.service;
  if (sc) {
    s.rules = s.rules.filter((r, n) => !sc.del.includes(String(n + 1)));
    for (const e of sc.entries) {
      const k = +e.key - 1;
      const r = s.rules[k] || (s.rules[k] = { name: '', dst: 'any', proto: 'any', port: '', mode: 'manual', prio: [] });
      if (one(e, 'name') != null) r.name = one(e, 'name');
      if (one(e, 'mode') != null) { const m = one(e, 'mode').toLowerCase(); r.mode = m === 'priority' ? 'latency' : m === 'sla' ? 'sla' : 'manual'; }
      if (one(e, 'protocol') != null) r.proto = { 6: 'tcp', 17: 'udp' }[one(e, 'protocol')] || 'any';
      const a = one(e, 'start-port'), b = one(e, 'end-port');
      if (a != null) r.port = b && b !== a ? `${a}-${b}` : a;
      if (e.set.dst) { const dst = e.set.dst.join(' '); r.dst = /^all$/i.test(dst) ? 'any' : dst; }
      if (e.set['priority-members']) r.prio = e.set['priority-members'].map(Number);
    }
    s.rules = s.rules.filter(Boolean);
  }
  d.sdwan = s;
  return null;
}
