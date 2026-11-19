// FortiGate 的 CLI 分頁：FortiOS 的 config → edit → set → next → end
import { h } from './dom.js';
import { parseIp, fmtIp } from '../engine/ip.js';
import { transact } from '../engine/sim.js';
import { fortiSession } from '../engine/fortios.js';

const HELP = {
  config: '進入一個設定區段，例如 config firewall policy',
  show: '顯示設定；在最外層可以接區段名稱，例如 show firewall policy',
  get: 'get system status / get system interface / get router info routing-table all / get vpn ipsec tunnel summary / get system info admin status',
  diagnose: 'diagnose vpn tunnel list / diagnose vpn ike gateway list / diagnose sys session list / diagnose sys session clear / diagnose sys ntp status',
  execute: 'execute ping <IP> / execute log display / execute date / execute time / execute reboot',
  edit: '編輯或新增一筆，例如 edit 1、edit "HQ"；edit 0 會自動用下一個編號',
  delete: '刪除一筆',
  move: 'move <政策編號> before|after <政策編號>（政策由上往下比對）',
  set: '設定欄位，例如 set srcintf "internal"',
  unset: '把欄位還原成預設值',
  next: '儲存這一筆，回到表格',
  end: '儲存並離開這個區段',
  abort: '不儲存就離開',
};
const isError = (l) => /parse error|Command fail|not found in datasource|operator error|incomplete command|Unknown action|The entry is used/.test(l);

/**
 * 執行一行 FortiOS 指令。CLI 分頁和遠端登入 (SSH / Telnet) 共用。
 * 回傳 { clear：要清空畫面, changed：設定有變動, renamed：設備改名了 }
 */
export function fortiRun(app, devId, sess, line, print) {
  const text = line.trim(), low = text.toLowerCase();
  const booting = (app.state.rt.booting || {})[devId];
  if (booting > 0) { print(`設備還在開機中，還要 ${Math.ceil(booting)} 秒才能下指令`, 'warn'); return {}; }
  const before = app.state.devices[devId].name;
  if (text.endsWith('?')) {
    const r = sess.complete(text.slice(0, -1));
    if (!r.options.length) print('  （這裡要輸入的是數值、名稱或位址）', 'dim');
    else if (text === '?') r.options.forEach((w) => print(`  ${w.padEnd(10)} ${HELP[w] || ''}`, 'dim'));
    else print('  ' + r.options.join('   '), 'dim');
    return {};
  }
  if (low === 'cls' || low === 'clear') return { clear: true };
  const r = sess.exec(text);
  r.out.forEach((l) => print(l, isError(l) ? 'warn' : /^（.*）$/.test(l) ? 'hint' : 'pre'));
  if (r.ping) {
    const st = app.state, d = st.devices[devId], ip = parseIp(r.ping);
    if (!d.ifaces.some((i) => i.rt && i.rt.ip != null)) print('這台設備沒有任何 IP 位址，無法送出封包', 'warn');
    else {
      const res = transact(st, d.id, { proto: 'icmp', dst: ip });
      app.showTrace(`${d.name} # ${text}`, res.log, res.hops, res);
      print(`PING ${fmtIp(ip)} (${fmtIp(ip)}): 56 data bytes`);
      if (res.ok) for (let n = 0; n < 5; n++) print(`64 bytes from ${fmtIp(ip)}: icmp_seq=${n} ttl=${64 - res.l3.length} time=${Math.max(1, res.hops.length)}.0 ms`, 'ok');
      print(`--- ${fmtIp(ip)} ping statistics ---`);
      print(`5 packets transmitted, ${res.ok ? 5 : 0} packets received, ${res.ok ? 0 : 100}% packet loss`, res.ok ? 'ok' : 'bad');
      if (!res.ok) print('  ↳ ' + res.reason, 'hint');
    }
  }
  const d = app.state.devices[devId];
  return { changed: !!r.changed, reloaded: !!r.reloaded, renamed: !!r.changed && (!!r.reloaded || !d || d.name !== before) };
}

export function buildFortiCli(ctx, body) {
  const { app, dev } = ctx;
  const sess = ((app.cliSess ||= {})['fg:' + dev.id] ||= fortiSession(() => app.state.devices[dev.id] || dev, () => app.state));
  const logs = (app.termLog['fg:' + dev.id] ||= [{
    t: 'FortiOS 風格的 CLI。設定是階層式的：config 進入區段 → edit 選一筆 → set 改欄位 → next 存檔 → end 離開。改的和其他分頁是同一份設定。輸入 ? 查看可用的指令，按 Tab 可以補齊。', c: 'dim',
  }]);
  const hist = (app.termHist['fg:' + dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'config firewall policy' });
  const promptEl = h('span', { class: 'prompt', text: sess.prompt() });
  const draw = () => {
    out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || ' ' })));
    out.scrollTop = out.scrollHeight;
    promptEl.textContent = sess.prompt();
  };
  const print = (t, c) => logs.push({ t, c });

  const run = (line) => {
    print(sess.prompt() + line, 'cmd');
    const r = fortiRun(app, dev.id, sess, line, print);
    if (r.clear) logs.length = 0;
    if (r.changed) ctx.commit(false);
    if (r.renamed) app.renderPanel();
    else draw();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const line = input.value.trim();
      input.value = '';
      if (!line) return;
      hist.push(line); hi = hist.length;
      run(line);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const r = sess.complete(input.value);
      if (r.line) input.value = r.line;
      if (r.options.length > 1) { print(sess.prompt() + input.value, 'cmd'); print('  ' + r.options.join('   '), 'dim'); draw(); }
    } else if (e.key === 'ArrowUp') { if (hi > 0) { hi--; input.value = hist[hi]; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
    e.stopPropagation();
  });
  const quick = ['show firewall policy', 'get system interface', 'get router info routing-table all', 'diagnose vpn tunnel list', 'config firewall policy', 'end'];
  body.append(h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, promptEl, input)),
    h('div', { class: 'chips' }, quick.map((x) => h('button', { class: 'chip btnchip', type: 'button', text: x, onclick: () => { hist.push(x); hi = hist.length; run(x); input.focus(); } }))));
  draw();
  setTimeout(() => input.focus(), 30);
}
