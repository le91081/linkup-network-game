// BIG-IP 的 tmsh：show / list 看 LTM 的狀態與設定，modify / create 改設定（直接生效，save sys config 存檔）
import { h, escLine } from './dom.js';
import { ltmHealth, poolStatus, allMonitors } from '../engine/ltm.js';

const AV = { up: 'available', unknown: 'unknown', down: 'offline', disabled: 'available', offline: 'offline' };

/** 執行一行 tmsh：回傳 { changed } */
export function tmshRun(state, d, line, print) {
  const L = d.ltm, s = line.replace(/\s+/g, ' ').trim().replace(/^tmsh /, '');
  const H = ltmHealth(state, d);
  const vsLine = (v) => {
    const p = L.pools.find((x) => x.name === v.pool), st = p ? poolStatus(H.pools[p.name] || []) : { st: 'offline', text: '沒有 pool' };
    return [`Ltm::Virtual Server: ${v.name}`, '------------------------------------------------------------------',
      'Status', `  Availability     : ${v.off ? 'unknown' : st.st === 'up' ? 'available' : st.st === 'unknown' ? 'unknown' : 'offline'}`,
      `  State            : ${v.off ? 'disabled' : 'enabled'}`,
      `  Reason           : ${v.off ? 'The virtual server is disabled' : st.st === 'up' ? 'The virtual server is available' : st.st === 'unknown' ? 'The children pool member(s) either don\'t have service checking enabled, or service check results are not available yet' : 'The children pool member(s) are down'}`,
      `  Destination      : ${v.dst}:${v.port}`, ''];
  };
  const poolLines = (p, members) => {
    const hs = H.pools[p.name] || [], st = poolStatus(hs);
    const o = [`Ltm::Pool: ${p.name}`, '------------------------------------------------------------------', 'Status',
      `  Availability : ${st.st === 'up' ? 'available' : st.st === 'unknown' ? 'unknown' : 'offline'}`, `  State        : enabled`, `  Reason       : ${st.text}`, `  Monitor      : ${p.monitor || 'none'}`,
      `  Available Members : ${hs.filter((x) => x.st === 'up' || x.st === 'unknown').length}  Total Members : ${hs.length}`, ''];
    if (members) for (const m of hs) o.push(`  | Ltm::Pool Member: ${m.ip}:${m.port}`, `  |   Availability : ${AV[m.st]}`, `  |   State        : ${m.st === 'disabled' ? 'disabled' : m.st === 'offline' ? 'forced offline' : 'enabled'}`, `  |   Reason       : ${m.why}`, '  |');
    return o;
  };
  let m;
  if ((m = s.match(/^show ltm virtual( (\S+))?$/))) { const vs = L.virtuals.filter((v) => !m[2] || v.name === m[2]); if (!vs.length) print(`01020036:3: The requested Virtual Server (/Common/${m[2]}) was not found.`); vs.forEach((v) => vsLine(v).forEach((x) => print(x))); return {}; }
  if ((m = s.match(/^show ltm pool( (\S+))?( members)?$/))) { const ps = L.pools.filter((p) => !m[2] || p.name === m[2] || m[2] === 'members'); ps.forEach((p) => poolLines(p, !!m[3] || m[2] === 'members').forEach((x) => print(x))); if (!ps.length) print(`01020036:3: The requested Pool (/Common/${m[2]}) was not found.`); return {}; }
  if (s === 'list ltm virtual') { for (const v of L.virtuals) [`ltm virtual ${v.name} {`, `    destination ${v.dst}:${v.port}`, `    ip-protocol tcp`, ...(v.pool ? [`    pool ${v.pool}`] : []), ...(v.persist === 'source_addr' ? ['    persist {', '        source_addr {', '            default yes', '        }', '    }'] : []), `    source-address-translation {`, `        type ${v.snat === 'automap' ? 'automap' : 'none'}`, '    }', ...(v.off ? ['    disabled'] : []), '}'].forEach((x) => print(x)); return {}; }
  if (s === 'list ltm pool') { for (const p of L.pools) [`ltm pool ${p.name} {`, '    members {', ...p.members.flatMap((x) => [`        ${x.ip}:${x.port} {`, `            address ${x.ip}`, ...(x.state === 'disabled' ? ['            session user-disabled'] : x.state === 'offline' ? ['            state user-down'] : []), '        }']), '    }', ...(p.lb && p.lb !== 'round-robin' ? [`    load-balancing-mode ${p.lb}`] : []), ...(p.monitor ? [`    monitor ${p.monitor}`] : []), '}'].forEach((x) => print(x)); return {}; }
  if (s === 'list ltm monitor') { for (const x of allMonitors(d)) [`ltm monitor ${x.type === 'gateway_icmp' ? 'gateway-icmp' : x.type} ${x.name} {`, ...(x.builtin ? ['    defaults-from none'] : [`    defaults-from ${x.type}`]), ...(x.send != null ? [`    send "${x.send}"`] : []), ...(x.recv ? [`    recv "${x.recv}"`] : []), '}'].forEach((y) => print(y)); return {}; }
  if ((m = s.match(/^modify ltm virtual (\S+) source-address-translation \{ type (automap|none) \}$/))) {
    const v = L.virtuals.find((x) => x.name === m[1]);
    if (!v) { print(`01020036:3: The requested Virtual Server (/Common/${m[1]}) was not found.`); return {}; }
    v.snat = m[2]; return { changed: true };
  }
  if ((m = s.match(/^modify ltm pool (\S+) monitor (\S+)$/))) {
    const p = L.pools.find((x) => x.name === m[1]);
    if (!p) { print(`01020036:3: The requested Pool (/Common/${m[1]}) was not found.`); return {}; }
    if (m[2] !== 'none' && !allMonitors(d).some((x) => x.name === m[2])) { print(`01020036:3: The requested monitor (/Common/${m[2]}) was not found.`); return {}; }
    p.monitor = m[2] === 'none' ? '' : m[2]; return { changed: true };
  }
  if ((m = s.match(/^create ltm monitor (http|https|tcp) (\S+)(.*)$/))) {
    if (allMonitors(d).some((x) => x.name === m[2])) { print(`01020066:3: The requested monitor (/Common/${m[2]}) already exists in partition Common.`); return {}; }
    const rest = m[3], q = (k) => { const r = rest.match(new RegExp(k + ' "([^"]*)"')); return r ? r[1] : ''; };
    L.monitors.push({ name: m[2], type: m[1], send: q('send') || 'GET /\\r\\n', recv: q('recv') });
    return { changed: true };
  }
  if (s === 'save sys config') { print('Saving running configuration...', '  /config/bigip.conf', '  /config/bigip_base.conf'); return {}; }
  print(`Syntax Error: "${s.split(' ')[0] || ''}" unknown command`);
  print('（支援：show ltm virtual / pool [members]、list ltm virtual / pool / monitor、modify ltm virtual <名稱> source-address-translation { type automap }、modify ltm pool <名稱> monitor <monitor>、create ltm monitor http <名稱> recv "200 OK"、save sys config）');
  return {};
}

/** 「tmsh」分頁 */
export function buildTmsh(ctx, body) {
  const { app, dev } = ctx;
  const logs = (app.termLog['tm:' + dev.id] ||= [{ t: 'BIG-IP 的 tmsh。show / list 看狀態與設定；modify / create 改設定（直接生效，save sys config 存檔）。', c: 'hint' }]);
  const hist = (app.termHist['tm:' + dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'show ltm pool members' });
  const PS = `root@(${dev.name})(cfg-sync Standalone)(Active)(/Common)(tmos)# `;
  const draw = () => { out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || ' ' }))); out.scrollTop = out.scrollHeight; };
  input.addEventListener('keydown', (e) => {
    if (escLine(e, input)) return;
    if (e.key === 'Enter') {
      const line = input.value.trim(); input.value = '';
      if (!line) return;
      hist.push(line); hi = hist.length;
      logs.push({ t: PS + line, c: 'cmd' });
      const r = tmshRun(app.state, app.state.devices[dev.id] || dev, line, (...t) => t.forEach((x) => logs.push({ t: x })));
      if (r.changed) ctx.commit(false);
      draw();
    } else if (e.key === 'ArrowUp' && hi > 0) { hi--; input.value = hist[hi] || ''; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
  });
  body.append(h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, h('span', { class: 'prompt', text: '(tmos)# ' }), input)));
  draw();
}
