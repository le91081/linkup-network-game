// Aruba AOS-CX 的 CLI：和 IOS 很像，但介面是 成員/插槽/埠（1/1/1），VLAN 用 vlan access / vlan trunk native / vlan trunk allowed
import { h, escLine } from './dom.js';
import { parseVlanList } from '../engine/ip.js';
import { macRows } from '../engine/sim.js';
import { neighbors } from '../engine/disc.js';

const pad = (s, n) => String(s).padEnd(n);
export function cxSession() { return { mode: 'exec', cur: null }; }
const host = (d) => d.cxHost || 'switch';
const prompt = (d, S) => host(d) + (S.mode === 'exec' ? '# ' : S.mode === 'config' ? '(config)# ' : S.mode === 'vlan' ? `(config-vlan-${S.cur})# ` : `(config-if${S.cur.length > 1 ? '-<' + S.cur[0] + '-' + S.cur[S.cur.length - 1] + '>' : ''})# `);
const ports = (d, text) => {
  // 1/1/1、1/1/1-1/1/4
  const m = String(text).match(/^(\d+\/\d+\/\d+)(?:-(\d+\/\d+\/(\d+)))?$/);
  if (!m) return null;
  const a = d.ports.findIndex((p) => p.id === m[1]);
  if (a < 0) return null;
  if (!m[2]) return [d.ports[a].id];
  const b = d.ports.findIndex((p) => p.id === m[2]);
  return b < a ? null : d.ports.slice(a, b + 1).map((p) => p.id);
};
const hasVlan = (d, v) => d.sw.vlans.some((x) => x.id === v);

export function cxRun(state, d, S, line, print) {
  const s = line.trim().replace(/\s+/g, ' ');
  const r = { changed: false };
  if (!s) return r;
  const ok = () => { r.changed = true; return r; };
  const bad = (t) => { print(t); return r; };
  const t = s.split(' ');
  // 任何模式都可以：end、exit、show、write memory、do …
  if (s === 'end') { S.mode = 'exec'; S.cur = null; return r; }
  if (s === 'exit') { S.mode = S.mode === 'exec' ? 'exec' : S.mode === 'config' ? 'exec' : 'config'; S.cur = null; return r; }
  const sh = s.startsWith('do ') ? s.slice(3) : s;
  if (sh.startsWith('show ') || sh === 'write memory') return show(state, d, sh, print, r);
  if (S.mode === 'exec') {
    if (s === 'configure terminal' || s === 'config' || s === 'configure') { S.mode = 'config'; return r; }
    return bad(`Invalid input: ${t[0]}`);
  }
  if (S.mode === 'config') {
    if (t[0] === 'hostname' && t[1]) { d.cxHost = t[1]; return ok(); }
    if (t[0] === 'vlan' && /^\d+$/.test(t[1] || '') && t.length === 2) {
      const v = +t[1];
      if (!(v >= 1 && v <= 4094)) return bad('Invalid VLAN ID');
      if (!hasVlan(d, v)) { d.sw.vlans.push({ id: v, name: 'VLAN' + v }); d.sw.vlans.sort((a, b) => a.id - b.id); r.changed = true; }
      S.mode = 'vlan'; S.cur = v;
      return r;
    }
    if (t[0] === 'no' && t[1] === 'vlan' && /^\d+$/.test(t[2] || '')) { const v = +t[2]; if (v === 1) return bad('VLAN 1 is the default VLAN and cannot be deleted.'); d.sw.vlans = d.sw.vlans.filter((x) => x.id !== v); return ok(); }
    if (t[0] === 'interface' && t[1]) {
      const ps = ports(d, t[1]);
      if (!ps) return bad(`Invalid input: ${t[1]}（AOS-CX 的介面是 成員/插槽/埠，例如 1/1/1，或 1/1/1-1/1/4）`);
      S.mode = 'if'; S.cur = ps;
      return r;
    }
    return bad(`Invalid input: ${t[0]}`);
  }
  if (S.mode === 'vlan') {
    if (t[0] === 'name' && t[1]) { const v = d.sw.vlans.find((x) => x.id === S.cur); v.name = t.slice(1).join(' '); return ok(); }
    return bad(`Invalid input: ${t[0]}`);
  }
  // 介面模式
  const each = (fn) => { for (const pid of S.cur) fn(d.sw.ports[pid], pid); return ok(); };
  if (s === 'no shutdown') return each((pc) => { pc.shut = false; });
  if (s === 'shutdown') return each((pc) => { pc.shut = true; });
  if (t[0] === 'description') return each((pc) => { pc.desc = t.slice(1).join(' '); });
  if (t[0] === 'vlan' && t[1] === 'access' && /^\d+$/.test(t[2] || '')) {
    const v = +t[2];
    if (!hasVlan(d, v)) return bad(`VLAN ${v} does not exist.（先在設定模式下 vlan ${v} 建立）`);
    return each((pc) => { Object.assign(pc, { mode: 'access', vlan: v }); });
  }
  if (t[0] === 'vlan' && t[1] === 'trunk' && t[2] === 'native' && /^\d+$/.test(t[3] || '')) {
    const v = +t[3];
    if (!hasVlan(d, v)) return bad(`VLAN ${v} does not exist.`);
    return each((pc) => { Object.assign(pc, { mode: 'trunk', native: v }); if (pc.allowed == null || pc.cxAllowed == null) pc.allowed = String(v); });
  }
  if (t[0] === 'vlan' && t[1] === 'trunk' && t[2] === 'allowed' && t[3]) {
    const list = t[3] === 'all' ? null : parseVlanList(t[3]);
    if (t[3] !== 'all' && !list) return bad('Invalid VLAN list');
    const miss = (list || []).filter((v) => !hasVlan(d, v));
    if (miss.length) return bad(`VLAN ${miss.join(',')} does not exist.`);
    return each((pc) => { Object.assign(pc, { mode: 'trunk', allowed: t[3] === 'all' ? 'all' : t[3], cxAllowed: true }); if (!pc.native) pc.native = 1; });
  }
  if (s === 'no vlan trunk allowed') return each((pc) => { pc.allowed = String(pc.native || 1); delete pc.cxAllowed; });
  return bad(`Invalid input: ${t[0]}（介面模式：no shutdown、vlan access <ID>、vlan trunk native <ID>、vlan trunk allowed <清單>、description）`);
}

function show(state, d, s, print, r) {
  const up = (pid) => !!state.rt.links[d.id + ':' + pid] && !d.sw.ports[pid].shut;
  if (s === 'write memory') { print('Copying configuration: [Success]'); return r; }
  if (s === 'show vlan') {
    print('--------------------------------------------------------------------------------', 'VLAN  Name                              Status  Reason          Type      Interfaces', '--------------------------------------------------------------------------------');
    for (const v of d.sw.vlans) {
      const ifs = d.ports.filter((p) => { const pc = d.sw.ports[p.id]; return pc.mode === 'trunk' ? (pc.allowed === 'all' || (parseVlanList(pc.allowed) || []).includes(v.id)) : +pc.vlan === v.id; }).map((p) => p.id);
      print(`${pad(v.id, 6)}${pad(v.name, 34)}${pad(ifs.some(up) ? 'up' : 'down', 8)}${pad(ifs.some(up) ? 'ok' : 'no_member_port', 16)}${pad(v.id === 1 ? 'default' : 'static', 10)}${ifs.join(',') || ''}`);
    }
    return r;
  }
  if (s === 'show interface brief') {
    print('--------------------------------------------------------------------------------------------', 'Port      Native  Mode   Type           Enabled Status  Reason                  Speed', '          VLAN                                                                  (Mb/s)', '--------------------------------------------------------------------------------------------');
    for (const p of d.ports) {
      const pc = d.sw.ports[p.id];
      print(`${pad(p.id, 10)}${pad(pc.mode === 'trunk' ? pc.native || 1 : pc.vlan || 1, 8)}${pad(pc.mode === 'trunk' ? 'trunk' : 'access', 7)}${pad(p.media === 'rj45' ? '1GbT' : 'SFP+', 15)}${pad(pc.shut ? 'no' : 'yes', 8)}${pad(up(p.id) ? 'up' : 'down', 8)}${pad(pc.shut ? 'Administratively down' : up(p.id) ? '' : 'Waiting for link', 24)}${up(p.id) ? '1000' : '--'}`);
    }
    return r;
  }
  if (s === 'show running-config') {
    print('Current configuration:', '!', `hostname ${host(d)}`, `vlan ${d.sw.vlans.map((v) => v.id).join(',')}`);
    for (const v of d.sw.vlans) if (v.id !== 1 && v.name && v.name !== 'VLAN' + v.id) print(`vlan ${v.id}`, `    name ${v.name}`);
    for (const p of d.ports) {
      const pc = d.sw.ports[p.id], o = [];
      if (pc.desc) o.push(`    description ${pc.desc}`);
      o.push(pc.shut ? '    shutdown' : '    no shutdown');
      if (pc.mode === 'trunk') o.push(`    vlan trunk native ${pc.native || 1}`, `    vlan trunk allowed ${pc.allowed || 'all'}`);
      else if (+pc.vlan > 1) o.push(`    vlan access ${pc.vlan}`);
      print(`interface ${p.id}`, ...o);
    }
    return r;
  }
  if (s === 'show lldp neighbor-info') {
    const rows = neighbors(state, d, 'lldp');
    print(`LLDP Neighbor Information`, '=========================', '', `Total Neighbor Entries          : ${rows.length}`, '', 'LOCAL-PORT  CHASSIS-ID         PORT-ID          SYS-NAME', '------------------------------------------------------------');
    for (const n of rows) { const x = state.devices[n.dev] || {}; print(`${pad(n.pid, 12)}${pad((x.ifaces && x.ifaces[0] && x.ifaces[0].rt && x.ifaces[0].rt.mac) || '-', 19)}${pad(((x.ports || []).find((p) => p.id === n.port) || {}).label || n.port, 17)}${x.name || ''}`); }
    return r;
  }
  if (s === 'show mac-address-table') {
    print('MAC age-time            : 300 seconds', '', 'MAC Address          VLAN     Type                      Port', '--------------------------------------------------------------');
    for (const m of macRows(state, d)) print(`${pad(m.mac, 21)}${pad(m.vlan, 9)}${pad(/STATIC/.test(m.type) ? 'static' : 'dynamic', 26)}${m.port}`);
    return r;
  }
  if (s === 'show version') { print('-----------------------------------------------------------------------------', 'ArubaOS-CX', '(c) Copyright Hewlett Packard Enterprise Development LP', '-----------------------------------------------------------------------------', 'Version      : PL.10.13.1010', 'Platform     : 6100'); return r; }
  print(`Invalid input: ${s.split(' ')[1] || ''}`);
  return r;
}

/** 「CLI (AOS-CX)」分頁 */
export function buildCxCli(ctx, body) {
  const { app, dev } = ctx;
  const sess = ((app.cliSess ||= {})['cx:' + dev.id] ||= cxSession());
  const logs = (app.termLog['cx:' + dev.id] ||= [{ t: 'Aruba AOS-CX 的 CLI：和 IOS 很像，但介面是 1/1/1（成員/插槽/埠），埠上用 vlan access <ID>、vlan trunk native <ID>、vlan trunk allowed <清單>。改了立刻生效，write memory 存檔。', c: 'hint' }]);
  const hist = (app.termHist['cx:' + dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'show vlan' });
  const promptEl = h('span', { class: 'prompt', text: prompt(dev, sess) });
  const draw = () => { out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || ' ' }))); out.scrollTop = out.scrollHeight; promptEl.textContent = prompt(app.state.devices[dev.id] || dev, sess); };
  input.addEventListener('keydown', (e) => {
    if (escLine(e, input)) return;
    if (e.key === 'Enter') {
      const line = input.value.trim(); input.value = '';
      if (!line) return;
      hist.push(line); hi = hist.length;
      logs.push({ t: prompt(app.state.devices[dev.id] || dev, sess) + line, c: 'cmd' });
      const r = cxRun(app.state, app.state.devices[dev.id] || dev, sess, line, (...t) => t.forEach((x) => logs.push({ t: x })));
      if (r.changed) ctx.commit(false);
      draw();
    } else if (e.key === 'ArrowUp' && hi > 0) { hi--; input.value = hist[hi] || ''; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
  });
  body.append(h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, promptEl, input)));
  draw();
}
