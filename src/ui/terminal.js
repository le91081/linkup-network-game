// 主機上的終端機：ping / ipconfig / tracert / nslookup / curl
import { h } from './dom.js';
import { fmtIp, fmtMask, parseIp } from '../engine/ip.js';
import { transact, resolveName } from '../engine/sim.js';
import { transact6 } from '../engine/sim6.js';
import { parseIp6, fmtIp6 } from '../engine/ip6.js';

const v6Lines = (rt) => (rt.v6 && rt.v6.ll != null
  ? [...rt.v6.addrs.map((a) => `   IPv6 位址 . . . . . . : ${fmtIp6(a.ip)}/${a.bits}${a.src === 'slaac' ? '（SLAAC）' : ''}`),
    `   連結-本機 IPv6 位址 . : ${fmtIp6(rt.v6.ll)}`, ...(rt.v6.gw != null ? [`   IPv6 預設閘道 . . . . : ${fmtIp6(rt.v6.gw)}`] : [])]
  : []);

const HELP = [
  '可用指令：',
  '  ping <IP 或網域>        測試連線（會在場景中播放封包動畫）',
  '  ipconfig                顯示本機的網路設定',
  '  tracert <IP 或網域>     顯示封包經過的每一台路由器',
  '  nslookup <網域>         向 DNS 查詢網域的 IP',
  '  curl <IP 或網域>[:埠]   測試 TCP 連線（預設 443）',
  '  cls                     清除畫面',
];

export function buildTerminal(ctx, body) {
  const { app, dev } = ctx;
  const logs = (app.termLog[dev.id] ||= [{ t: `${dev.name} 終端機 — 輸入 help 查看指令`, c: 'dim' }]);
  const hist = (app.termHist[dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'ping 192.168.1.1' });
  const draw = () => {
    out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || '\u00a0' })));
    out.scrollTop = out.scrollHeight;
  };
  const print = (t, c) => logs.push({ t, c });
  const st = () => app.state;

  const resolve = (name) => {
    if (parseIp(name) != null) return { ok: true, ip: parseIp(name), hops: [], log: [] };
    return resolveName(st(), dev.id, name);
  };

  const run = async (line) => {
    print('C:\\> ' + line, 'cmd');
    const [cmd, ...args] = line.trim().split(/\s+/);
    const c = (cmd || '').toLowerCase();
    if (c === 'help' || c === '?') HELP.forEach((x) => print(x, 'dim'));
    else if (c === 'cls' || c === 'clear') logs.length = 0;
    else if (c === 'ipconfig' || c === 'ifconfig' || (c === 'ip' && args[0])) {
      for (const i of dev.ifaces) {
        const rt = i.rt || {};
        print('');
        print(`${i.bind.t === 'wlan' ? '無線區域網路介面卡' : '乙太網路卡'} ${i.label}:`);
        if (rt.ip == null || !rt.link) {
          print(`   媒體狀態 . . . . . . : ${rt.link ? '尚未設定 IP' : '媒體已中斷連線'}` + (rt.note ? `（${rt.note}）` : ''), 'warn');
          print(`   實體位址 (MAC) . . . : ${rt.mac}`);
          v6Lines(rt).forEach((x) => print(x));
          continue;
        }
        print(`   實體位址 (MAC) . . . : ${rt.mac}`);
        print(`   DHCP 已啟用 . . . . . : ${i.mode === 'dhcp' ? '是' : '否'}`);
        print(`   IPv4 位址 . . . . . . : ${fmtIp(rt.ip)}${rt.src === 'apipa' ? '（APIPA，自動設定）' : ''}`, rt.src === 'apipa' ? 'warn' : '');
        print(`   子網路遮罩  . . . . . : ${fmtMask(rt.bits)}`);
        print(`   預設閘道 . . . . . . : ${rt.gw != null ? fmtIp(rt.gw) : ''}`);
        print(`   DNS 伺服器  . . . . . : ${rt.dns.map(fmtIp).join(', ')}`);
        v6Lines(rt).forEach((x) => print(x));
      }
    } else if (c === 'ping' || c === 'tracert' || c === 'traceroute') {
      const target = args[0];
      if (!target) print(`用法：${c} <IP 或網域>`, 'warn');
      else if (target.includes(':')) {
        const d6 = parseIp6(target);
        if (d6 == null) print('IPv6 位址的格式不正確', 'bad');
        else {
          const res = transact6(st(), dev.id, d6);
          app.showTrace(`${dev.name}> ${line}`, res.log, res.hops, res);
          print('');
          print(`Ping ${fmtIp6(d6)} (使用 32 位元組的資料):`);
          for (let n = 0; n < 4; n++) print(res.ok ? `回覆自 ${fmtIp6(d6)}: 時間=${Math.max(1, res.hops.length)}ms` : res.phase === 'reply' ? '要求等候逾時。' : '目的地主機無法連線。', res.ok ? 'ok' : 'bad');
          if (!res.ok) print('  ↳ ' + res.reason, 'hint');
        }
      } else {
        const r = resolve(target);
        if (!r.ok) print(`Ping 要求找不到主機 ${target}。${r.reason}`, 'bad');
        else {
          const res = transact(st(), dev.id, { proto: 'icmp', dst: r.ip });
          const ip = fmtIp(r.ip);
          app.showTrace(`${dev.name}> ${line}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
          if (c === 'ping') {
            print('');
            print(`Ping ${target === ip ? ip : `${target} [${ip}]`} (使用 32 位元組的資料):`);
            const ms = Math.max(1, res.hops.length) + (res.l3.some((x) => st().devices[x.dev].kind === 'internet') ? 9 : 0);
            for (let n = 0; n < 4; n++) {
              print(res.ok ? `回覆自 ${ip}: 位元組=32 時間=${ms}ms TTL=${64 - res.l3.length}` : res.phase === 'reply' ? '要求等候逾時。' : '目的地主機無法連線。', res.ok ? 'ok' : 'bad');
            }
            print('');
            print(`    封包: 已傳送 = 4，已收到 = ${res.ok ? 4 : 0}，已遺失 = ${res.ok ? 0 : 4}`);
            if (!res.ok) print('  ↳ ' + res.reason, 'hint');
          } else {
            print('');
            print(`追蹤 ${ip} 的路由：`);
            res.l3.forEach((x, n) => print(`  ${String(n + 1).padStart(2)}    ${String(n + 1).padStart(2)} ms    ${(x.ip == null ? 'VPN 通道' : fmtIp(x.ip)).padEnd(16)} ${st().devices[x.dev].name}`));
            if (res.ok || res.phase === 'reply') print(`  ${String(res.l3.length + 1).padStart(2)}    ${String(res.l3.length + 1).padStart(2)} ms    ${ip}`, res.ok ? 'ok' : '');
            if (!res.ok) { print(`  ${String(res.l3.length + 1 + (res.phase === 'reply' ? 1 : 0)).padStart(2)}     *        *        要求等候逾時。`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
            else print('追蹤完成。');
          }
        }
      }
    } else if (c === 'nslookup') {
      if (!args[0]) print('用法：nslookup <網域>', 'warn');
      else {
        const r = resolveName(st(), dev.id, args[0]);
        app.showTrace(`${dev.name}> ${line}`, r.log, r.hops, r);
        if (r.ok) { print(`名稱:    ${args[0]}`); print(`Address: ${fmtIp(r.ip)}`, 'ok'); }
        else print('*** ' + r.reason, 'bad');
      }
    } else if (c === 'curl' || c === 'telnet') {
      let t = (args[0] || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      let port = /^http:/.test(args[0] || '') ? 80 : 443;
      const m = t.match(/^(.*):(\d+)$/);
      if (m) { t = m[1]; port = +m[2]; }
      if (args[1] && /^\d+$/.test(args[1])) port = +args[1];
      if (!t) print(`用法：${c} <IP 或網域>[:埠]`, 'warn');
      else {
        const r = resolve(t);
        if (!r.ok) print(`curl: (6) 無法解析主機 ${t} — ${r.reason}`, 'bad');
        else {
          const res = transact(st(), dev.id, { proto: 'tcp', dst: r.ip, dport: port });
          app.showTrace(`${dev.name}> ${line}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
          if (res.ok) print(`已連線到 ${fmtIp(r.ip)}:${port} — HTTP/1.1 200 OK`, 'ok');
          else { print(`curl: (7) 無法連線到 ${fmtIp(r.ip)} 埠 ${port}`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
        }
      }
    } else if (c) print(`'${cmd}' 不是內部或外部命令。輸入 help 查看可用指令。`, 'warn');
    draw();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const line = input.value.trim();
      input.value = '';
      if (!line) return;
      hist.push(line); hi = hist.length;
      run(line);
    } else if (e.key === 'ArrowUp') {
      if (hi > 0) { hi--; input.value = hist[hi]; }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      hi = Math.min(hist.length, hi + 1);
      input.value = hist[hi] || '';
      e.preventDefault();
    }
    e.stopPropagation();
  });
  const term = h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, h('span', { class: 'prompt', text: 'C:\\>' }), input));
  body.append(term, h('div', { class: 'chips' }, ['ipconfig', 'ping 8.8.8.8', 'tracert 8.8.8.8', 'nslookup www.example.com', 'help'].map((x) =>
    h('button', { class: 'chip btnchip', type: 'button', text: x, onclick: () => { hist.push(x); hi = hist.length; run(x); } }))));
  draw();
  setTimeout(() => input.focus(), 30);
}
