// Junos 的 CLI：operational 模式（>）與設定模式（#）；set / delete 改的是候選設定，commit 才生效
import { h, escLine } from './dom.js';
import { commitCheck, applyJunos, compareLines, junosDirty, parseJunos, junosIp } from '../engine/junos.js';
import { macRows } from '../engine/sim.js';
import { fmtIp } from '../engine/ip.js';

const pad = (s, n) => String(s).padEnd(n);
const SYNTAX = ['syntax error.'];

export function junosSession() { return { mode: 'op', pending: null }; }
const prompt = (d, S) => `root@${d.junosHost || 'EX2300'}${S.mode === 'cfg' ? '#' : '>'} `;

/** set 指令的格式檢查：回傳正規化之後的指令（vlan members [ a b ] 拆成一個一個），或 null（語法錯誤） */
function normSet(d, rest) {
  const t = rest.replace(/\[|\]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const ok = (cond) => (cond ? ['set ' + t.join(' ')] : null);
  if (t[0] === 'system' && t[1] === 'host-name' && t[2] && t.length === 3) return ok(true);
  if (t[0] === 'protocols' && t[1] === 'rstp' && t.length === 2) return ok(true);
  if (t[0] === 'vlans' && t[1] && ((t[2] === 'vlan-id' && /^\d+$/.test(t[3] || '') && t.length === 4) || (t[2] === 'l3-interface' && /^irb\.\d+$/.test(t[3] || '') && t.length === 4))) return ok(true);
  if (t[0] === 'interfaces' && t[1] === 'irb' && t[2] === 'unit' && /^\d+$/.test(t[3] || '') && t[4] === 'family' && t[5] === 'inet' && t[6] === 'address' && junosIp(t[7]) && t.length === 8) return ok(true);
  if (t[0] === 'interfaces' && t[1] && t[1] !== 'irb') {
    if (!d.ports.some((p) => p.id === t[1])) return null;
    if (t[2] === 'disable' && t.length === 3) return ok(true);
    if (t[2] === 'native-vlan-id' && /^\d+$/.test(t[3] || '') && t.length === 4) return ok(true);
    if (t[2] === 'description' && t.length >= 4) return ok(true);
    if (t[2] === 'unit' && t[3] === '0' && t[4] === 'family' && t[5] === 'ethernet-switching') {
      if (t.length === 6) return ok(true);
      if (t[6] === 'interface-mode' && ['access', 'trunk'].includes(t[7]) && t.length === 8) return ok(true);
      if (t[6] === 'vlan' && t[7] === 'members' && t.length >= 9) return t.slice(8).map((m) => `set interfaces ${t[1]} unit 0 family ethernet-switching vlan members ${m}`);
    }
  }
  return null;
}

function opCmd(state, d, S, line, out) {
  const s = line.replace(/\s+/g, ' ').trim();
  const cfg = parseJunos(d.junos.active);
  const vname = (id) => (Object.entries(cfg.vlans).find(([, v]) => v.id === id) || [String(id)])[0];
  const up = (pid) => !!state.rt.links[d.id + ':' + pid] && !(d.sw.ports[pid] || {}).shut;
  if (/^show vlans?( brief)?$/.test(s)) {
    out.push('Routing instance        VLAN name             Tag          Interfaces');
    for (const v of d.sw.vlans) {
      out.push(`default-switch          ${pad(v.name, 21)} ${v.id}`);
      for (const p of d.ports) {
        const pc = d.sw.ports[p.id], inV = pc.mode === 'trunk' ? String(pc.allowed).split(',').map(Number).includes(v.id) : +pc.vlan === v.id;
        if (inV) out.push(`${' '.repeat(59)}${p.id}.0${up(p.id) ? '*' : ''}`);
      }
    }
    return;
  }
  if (s === 'show interfaces terse') {
    out.push('Interface               Admin Link Proto    Local                 Remote');
    for (const p of d.ports) {
      const pc = d.sw.ports[p.id];
      out.push(`${pad(p.id, 24)}${pad(pc.shut ? 'down' : 'up', 6)}${up(p.id) ? 'up' : 'down'}`, `${pad(p.id + '.0', 24)}${pad(pc.shut ? 'down' : 'up', 6)}${pad(up(p.id) ? 'up' : 'down', 5)}eth-switch`);
    }
    for (const [u, a] of Object.entries(cfg.irb)) out.push(`irb.${pad(u, 20)}up    up   inet     ${a}`);
    return;
  }
  if (s === 'show ethernet-switching table') {
    const rows = macRows(state, d);
    out.push('MAC flags (S - static MAC, D - dynamic MAC, L - locally learned)', '', `Ethernet switching table : ${rows.length} entries, ${rows.filter((r) => !/STATIC/.test(r.type)).length} learned`,
      'Routing instance : default-switch', '   Vlan                MAC                 MAC         Logical', '   name                address             flags       interface');
    for (const r of rows) out.push(`   ${pad(vname(r.vlan), 20)}${pad(r.mac, 20)}${pad(/STATIC/.test(r.type) ? 'S' : 'D', 12)}${r.port}.0`);
    return;
  }
  if (/^show configuration( \| display set)?$/.test(s)) { out.push(...d.junos.active); return; }
  if (s === 'show system commit') { d.junos.commits.forEach((c, n) => out.push(`${n}   ${new Date(Date.UTC(2026, 0, 1) + (c.at || 0) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC by root via cli`)); if (!d.junos.commits.length) out.push('（還沒有 commit 過）'); return; }
  if (s === 'show version') { out.push(`Hostname: ${d.junosHost || 'EX2300'}`, 'Model: ex2300-24t', 'Junos: 21.4R3-S5.4', 'JUNOS OS Kernel 64-bit  [20230823.6b8bc3e_builder_stable_12]'); return; }
  out.push(...SYNTAX, '（operational 模式的指令：show vlans、show interfaces terse、show ethernet-switching table、show configuration、show system commit；設定要先 configure）');
}

/** 執行一行：回傳 { changed } */
export function junosRun(state, d, S, line, print) {
  const out = [];
  const done = (changed) => { out.forEach((l) => print(l)); return { changed: !!changed }; };
  const s = line.replace(/\s+/g, ' ').trim();
  if (S.pending) { const fn = S.pending; S.pending = null; return done(fn(s, out)); }
  if (S.mode === 'op') {
    if (/^configure( private| exclusive)?$/.test(s)) {
      S.mode = 'cfg';
      d.junos.candidate ||= [...d.junos.active];
      out.push('Entering configuration mode', ...(junosDirty(d) ? ['The configuration has been changed but not committed'] : []), '', '[edit]');
      return done(false);
    }
    if (s === 'exit' || s === 'quit') { out.push('（模擬裡不會登出）'); return done(false); }
    opCmd(state, d, S, s, out);
    return done(false);
  }
  // 設定模式
  const C = d.junos.candidate ||= [...d.junos.active];
  if (s.startsWith('run ')) { opCmd(state, d, S, s.slice(4), out); return done(false); }
  if (s.startsWith('set ')) {
    const n = normSet(d, s.slice(4));
    if (!n) { out.push(...SYNTAX, '（支援：set vlans <名稱> vlan-id <ID>、set interfaces <介面> unit 0 family ethernet-switching interface-mode access|trunk、… vlan members <VLAN>、set interfaces <介面> native-vlan-id <ID>、set interfaces <介面> disable、set interfaces irb unit <n> family inet address <IP/長度>、set vlans <名稱> l3-interface irb.<n>、set system host-name、set protocols rstp）'); return done(false); }
    for (const l of n) {
      // 同一個「單值」的欄位只留一個（例如 vlan-id、interface-mode、native-vlan-id）
      const key = l.replace(/ (vlan-id|interface-mode|native-vlan-id|host-name|l3-interface|address) \S+$/, ' $1');
      if (key !== l) for (let k = C.length - 1; k >= 0; k--) if (C[k].replace(/ (vlan-id|interface-mode|native-vlan-id|host-name|l3-interface|address) \S+$/, ' $1') === key) C.splice(k, 1);
      if (!C.includes(l)) C.push(l);
    }
    out.push('', '[edit]');
    return done(false);
  }
  if (s.startsWith('delete ')) {
    const p = 'set ' + s.slice(7).replace(/\[|\]/g, ' ').replace(/\s+/g, ' ').trim();
    const before = C.length;
    for (let k = C.length - 1; k >= 0; k--) if (C[k] === p || C[k].startsWith(p + ' ')) C.splice(k, 1);
    out.push(...(C.length === before ? ['warning: statement not found'] : []), '', '[edit]');
    return done(false);
  }
  if (s === 'show | compare') { const c = compareLines(d); out.push('[edit]', ...(c.length ? c : ['（沒有改過：候選設定和現在生效的一樣）'])); return done(false); }
  if (/^show( \| display set)?$/.test(s)) { out.push(...C, '', '[edit]'); return done(false); }
  if (s === 'commit check' || s === 'commit' || s === 'commit and-quit') {
    const errs = commitCheck(d, C);
    if (errs.length) { out.push(...errs.map((e) => 'error: ' + e), 'error: configuration check-out failed'); return done(false); }
    if (s === 'commit check') { out.push('configuration check succeeds'); return done(false); }
    d.junos.active = [...C];
    d.junos.commits.unshift({ at: state.clock || 0, lines: [...C] });
    if (d.junos.commits.length > 10) d.junos.commits.pop();
    applyJunos(d);
    out.push('commit complete');
    if (s === 'commit and-quit') { S.mode = 'op'; out.push('Exiting configuration mode'); }
    return done(true);
  }
  const rb = s.match(/^rollback( (\d+))?$/);
  if (rb) {
    const n = +(rb[2] || 0), src = n === 0 ? d.junos.active : (d.junos.commits[n] || {}).lines;
    if (!src) { out.push(`error: rollback ${n} 不存在（show system commit 看有幾個版本）`); return done(false); }
    d.junos.candidate = [...src];
    out.push('load complete', '', '[edit]');
    return done(false);
  }
  if (s === 'exit' || s === 'quit' || s === 'exit configuration-mode') {
    if (junosDirty(d)) {
      out.push('The configuration has been changed but not committed', 'Exit with uncommitted changes? [yes,no] (yes) ');
      S.pending = (ans, o2) => { if (ans && !/^y/i.test(ans)) { o2.push('', '[edit]'); return false; } S.mode = 'op'; o2.push('Exiting configuration mode（候選設定還留著：還沒有生效）'); return false; };
      return done(false);
    }
    S.mode = 'op'; out.push('Exiting configuration mode');
    return done(false);
  }
  if (s.startsWith('edit') || s === 'top' || s === 'up') { out.push('（這個模擬只支援完整路徑的 set / delete，例如 set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members v10）', '', '[edit]'); return done(false); }
  out.push(...SYNTAX);
  return done(false);
}

/** 「CLI」分頁 */
export function buildJunosCli(ctx, body) {
  const { app, dev } = ctx;
  const sess = ((app.cliSess ||= {})['jn:' + dev.id] ||= junosSession());
  const logs = (app.termLog['jn:' + dev.id] ||= [{ t: 'Junos 的 CLI。operational 模式 (>) 看狀態；configure 進入設定模式 (#)，set / delete 改的是候選設定，commit 才會生效（show | compare 看差異、rollback 回到之前的版本）。', c: 'hint' }]);
  const hist = (app.termHist['jn:' + dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'show vlans' });
  const promptEl = h('span', { class: 'prompt', text: prompt(dev, sess) });
  const draw = () => {
    out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || ' ' })));
    out.scrollTop = out.scrollHeight;
    promptEl.textContent = prompt(app.state.devices[dev.id] || dev, sess);
  };
  const print = (t, c) => logs.push({ t, c });
  input.addEventListener('keydown', (e) => {
    if (escLine(e, input)) return;
    if (e.key === 'Enter') {
      const line = input.value.trim();
      input.value = '';
      if (!line && !sess.pending) return;
      if (line) { hist.push(line); hi = hist.length; }
      print(prompt(app.state.devices[dev.id] || dev, sess) + line, 'cmd');
      const r = junosRun(app.state, app.state.devices[dev.id] || dev, sess, line, print);
      if (r.changed) ctx.commit(false);
      draw();
    } else if (e.key === 'ArrowUp' && hi > 0) { hi--; input.value = hist[hi] || ''; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
  });
  body.append(h('div', { class: 'term' }, out, h('div', { class: 'term-line' }, promptEl, input)));
  draw();
  setTimeout(() => input.focus(), 0);
}
export { fmtIp as _fmtIp };
