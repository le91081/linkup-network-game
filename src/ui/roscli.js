// MikroTik RouterOS 的終端機：選單路徑（/ip address、/ip route…）＋ print / add / remove / set，改了立刻生效（沒有 commit）
import { h, escLine } from './dom.js';
import { parseIp, fmtIp, maskOf, parseMask, netOf } from '../engine/ip.js';
import { transact } from '../engine/sim.js';

const pad = (s, n) => String(s).padEnd(n);
export function rosSession() { return { path: [] }; }
const prompt = (d, S) => `[admin@${(d.ros && d.ros.identity) || 'MikroTik'}] ${S.path.length ? '/' + S.path.join(' ') : ''}> `;
const ifOf = (d, name) => d.ifaces.find((i) => i.id === name || i.label === name);
/** key=value 參數 */
function kv(toks) { const o = {}, rest = []; for (const t of toks) { const m = t.match(/^([a-z-]+)=(.*)$/); if (m) o[m[1]] = m[2].replace(/^"|"$/g, ''); else rest.push(t); } return { o, rest }; }
const statics = (d) => d.ifaces.filter((i) => i.bind.t === 'port' && i.mode === 'static' && i.ip && i.mask);
const cidr = (i) => `${i.ip}/${parseMask(i.mask)}`;

/** 執行一行：回傳 { changed } */
export function rosRun(state, d, S, line, print) {
  let toks = line.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return {};
  let path = [...S.path];
  // 絕對路徑：/ip address print；也接受 /ip/address/print 的寫法
  if (toks[0].startsWith('/')) { const p = toks.shift().slice(1).split('/').filter(Boolean); path = p; }
  const VERBS = ['print', 'add', 'remove', 'set', 'export', 'enable', 'disable'];
  while (toks.length && !VERBS.includes(toks[0]) && !toks[0].includes('=') && !/^\d+$/.test(toks[0]) && !(path.join(' ') === 'ping' || path[0] === 'ping')) {
    const t = toks.shift();
    if (t === '..') path.pop(); else path.push(t);
  }
  const p = path.join(' '), verb = toks.shift(), { o, rest } = kv(toks);
  const r = { changed: false };
  if (!verb && p !== 'ping' && p !== 'quit' && p !== 'export') { S.path = path; return r; } // 只是切換選單
  const ok = () => { r.changed = true; return r; };
  const bad = (t) => { print(t); return r; };
  // ── /ip address ──
  if (p === 'ip address') {
    if (verb === 'print') {
      print('Flags: X - disabled, I - invalid, D - dynamic', ' #   ADDRESS            NETWORK         INTERFACE');
      let n = 0;
      for (const i of d.ifaces.filter((x) => x.bind.t === 'port')) {
        if (i.mode === 'static' && i.ip && i.mask) print(` ${pad(n++, 3)} ${pad(cidr(i), 18)} ${pad(fmtIp(netOf(parseIp(i.ip), parseMask(i.mask))), 15)} ${i.id}`);
        else if (i.mode === 'dhcp' && i.rt.ip != null) print(` ${pad(n++, 1)} D ${pad(fmtIp(i.rt.ip) + '/' + i.rt.bits, 18)} ${pad(fmtIp(netOf(i.rt.ip, i.rt.bits)), 15)} ${i.id}`);
      }
      return r;
    }
    if (verb === 'add') {
      const i = ifOf(d, o.interface || ''), [ip, len] = String(o.address || '').split('/');
      if (!i) return bad(`input does not match any value of interface`);
      if (parseIp(ip) == null || !(+len >= 1 && +len <= 32)) return bad('invalid value for argument address');
      Object.assign(i, { mode: 'static', ip, mask: fmtIp(maskOf(+len)) });
      return ok();
    }
    if (verb === 'remove') {
      const n = +(o.numbers ?? rest[0]), i = statics(d)[n];
      if (!i) return bad('no such item');
      Object.assign(i, { ip: '', mask: '' });
      return ok();
    }
  }
  // ── /ip dhcp-client ──
  if (p === 'ip dhcp-client') {
    if (verb === 'print') {
      print('Flags: X - disabled, I - invalid, D - dynamic', ' #   INTERFACE   USE-PEER-DNS ADD-DEFAULT-ROUTE STATUS        ADDRESS');
      d.ifaces.filter((i) => i.bind.t === 'port' && i.mode === 'dhcp').forEach((i, n) => print(` ${pad(n, 3)} ${pad(i.id, 11)} yes          yes               ${pad(i.rt.ip != null ? 'bound' : 'searching...', 13)} ${i.rt.ip != null ? fmtIp(i.rt.ip) + '/' + i.rt.bits : ''}`));
      return r;
    }
    if (verb === 'add') { const i = ifOf(d, o.interface || ''); if (!i) return bad('input does not match any value of interface'); Object.assign(i, { mode: 'dhcp', ip: '', mask: '' }); return ok(); }
    if (verb === 'remove') { const i = d.ifaces.filter((x) => x.mode === 'dhcp')[+(o.numbers ?? rest[0])]; if (!i) return bad('no such item'); i.mode = 'static'; return ok(); }
  }
  // ── /ip route ──
  if (p === 'ip route') {
    if (verb === 'print') {
      print('Flags: X - disabled, A - active, D - dynamic, C - connect, S - static', ' #      DST-ADDRESS        GATEWAY            DISTANCE');
      ((d.rt && d.rt.routes) || []).forEach((x, n) => print(` ${pad(n, 2)}${pad('A' + (x.type === 'C' ? 'DC' : x.type === 'D' ? 'DS' : 'S'), 5)} ${pad(fmtIp(x.net) + '/' + x.bits, 18)} ${pad(x.via != null ? fmtIp(x.via) : x.iface ? x.iface.id : '', 18)} ${x.ad}`));
      return r;
    }
    if (verb === 'add') {
      const [dst, len] = String(o['dst-address'] || '').split('/');
      if (parseIp(dst) == null || !(+len >= 0 && +len <= 32) || parseIp(o.gateway || '') == null) return bad('failure: dst-address 和 gateway 要寫對（例如 dst-address=0.0.0.0/0 gateway=203.0.113.1）');
      d.routes.push({ dst, mask: fmtIp(maskOf(+len)), via: o.gateway, ad: o.distance || '' });
      return ok();
    }
    if (verb === 'remove') { const n = +(o.numbers ?? rest[0]); if (!d.routes[n]) return bad('no such item'); d.routes.splice(n, 1); return ok(); }
  }
  // ── /ip firewall nat ──
  if (p === 'ip firewall nat') {
    d.ros.nat ||= [];
    if (verb === 'print') { print('Flags: X - disabled, I - invalid, D - dynamic'); d.ros.nat.forEach((x, n) => print(` ${pad(n, 3)} chain=${x.chain} action=${x.action}${x.out ? ' out-interface=' + x.out : ''}`)); return r; }
    if (verb === 'add') {
      if (o.chain !== 'srcnat' || o.action !== 'masquerade') return bad('（這個模擬只支援 chain=srcnat action=masquerade out-interface=<介面>）');
      const i = ifOf(d, o['out-interface'] || '');
      if (!i) return bad('input does not match any value of out-interface');
      d.ros.nat.push({ chain: 'srcnat', action: 'masquerade', out: i.id });
      i.nat = true;
      return ok();
    }
    if (verb === 'remove') { const n = +(o.numbers ?? rest[0]), x = d.ros.nat[n]; if (!x) return bad('no such item'); d.ros.nat.splice(n, 1); const i = ifOf(d, x.out); if (i && !d.ros.nat.some((y) => y.out === i.id)) i.nat = false; return ok(); }
  }
  // ── /ip dns ──
  if (p === 'ip dns') {
    if (verb === 'print') { print(`                      servers: ${d.ros.dns || ''}`, `  allow-remote-requests: ${d.dnsProxy ? 'yes' : 'no'}`); return r; }
    if (verb === 'set') { if (o.servers != null) d.ros.dns = o.servers; if (o['allow-remote-requests'] != null) d.dnsProxy = o['allow-remote-requests'] === 'yes'; return ok(); }
  }
  // ── /interface ──
  if (p === 'interface' && verb === 'print') {
    print('Flags: D - dynamic, X - disabled, R - running', ' #     NAME          TYPE       MTU');
    d.ports.forEach((x, n) => print(` ${pad(n, 2)}${pad(state.rt.links[d.id + ':' + x.id] ? 'R' : '', 4)}${pad(x.id, 14)}${pad('ether', 11)}1500`));
    return r;
  }
  // ── /system identity ──
  if (p === 'system identity') {
    if (verb === 'print') { print(`  name: ${d.ros.identity}`); return r; }
    if (verb === 'set' && o.name) { d.ros.identity = o.name; return ok(); }
  }
  // ── /ping ──
  if (p === 'ping' || path[0] === 'ping') {
    const dst = parseIp(o.address || verb || rest[0] || ''), n = Math.min(+(o.count || 3), 5);
    if (dst == null) return bad('用法：/ping 8.8.8.8 count=3');
    print('  SEQ HOST                                     SIZE TTL TIME       STATUS');
    let got = 0;
    for (let k = 0; k < n; k++) { const t = transact(state, d.id, { proto: 'icmp', dst, quiet: true }); if (t.ok) got++; print(`    ${k} ${pad(fmtIp(dst), 41)}${t.ok ? '  56  57 12ms' : '                ' + 'timeout'}`); }
    print(`    sent=${n} received=${got} packet-loss=${Math.round((1 - got / n) * 100)}%`);
    return r;
  }
  if (p === 'export' || verb === 'export') {
    print(`# RouterOS 7.16 · ${d.ros.identity}`);
    if (statics(d).length) print('/ip address', ...statics(d).map((i) => `add address=${cidr(i)} interface=${i.id} network=${fmtIp(netOf(parseIp(i.ip), parseMask(i.mask)))}`));
    const dc = d.ifaces.filter((i) => i.mode === 'dhcp' && i.bind.t === 'port');
    if (dc.length) print('/ip dhcp-client', ...dc.map((i) => `add interface=${i.id}`));
    if (d.ros.dns || d.dnsProxy) print('/ip dns', `set allow-remote-requests=${d.dnsProxy ? 'yes' : 'no'}${d.ros.dns ? ' servers=' + d.ros.dns : ''}`);
    if ((d.ros.nat || []).length) print('/ip firewall nat', ...d.ros.nat.map((x) => `add action=masquerade chain=srcnat out-interface=${x.out}`));
    if (d.routes.length) print('/ip route', ...d.routes.map((x) => `add dst-address=${x.dst}/${parseMask(x.mask)} gateway=${x.via}`));
    print('/system identity', `set name=${d.ros.identity}`);
    return r;
  }
  if (p === 'quit') { print('（模擬裡不會登出）'); return r; }
  print(`bad command name ${verb || p} (line 1 column 1)`);
  print('（常用：/ip address add address=192.168.88.1/24 interface=ether2、/ip dhcp-client add interface=ether1、/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade、/ip route print、/ping 8.8.8.8、/export）');
  return r;
}

/** 「Terminal」分頁 */
export function buildRosCli(ctx, body) {
  const { app, dev } = ctx;
  const sess = ((app.cliSess ||= {})['ros:' + dev.id] ||= rosSession());
  const logs = (app.termLog['ros:' + dev.id] ||= [{ t: 'MikroTik RouterOS 的終端機：/ip address、/ip route、/ip firewall nat 這樣的選單路徑加上 print / add / remove / set。改了立刻生效（沒有 commit），/export 看整份設定。', c: 'hint' }]);
  const hist = (app.termHist['ros:' + dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: '/ip address print' });
  const promptEl = h('span', { class: 'prompt', text: prompt(dev, sess) });
  const draw = () => { out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || ' ' }))); out.scrollTop = out.scrollHeight; promptEl.textContent = prompt(app.state.devices[dev.id] || dev, sess); };
  input.addEventListener('keydown', (e) => {
    if (escLine(e, input)) return;
    if (e.key === 'Enter') {
      const line = input.value.trim(); input.value = '';
      if (!line) return;
      hist.push(line); hi = hist.length;
      logs.push({ t: prompt(app.state.devices[dev.id] || dev, sess) + line, c: 'cmd' });
      const r = rosRun(app.state, app.state.devices[dev.id] || dev, sess, line, (...t) => t.forEach((x) => logs.push({ t: x })));
      if (r.changed) ctx.commit(false);
      draw();
    } else if (e.key === 'ArrowUp' && hi > 0) { hi--; input.value = hist[hi] || ''; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
  });
  body.append(h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, promptEl, input)));
  draw();
}
