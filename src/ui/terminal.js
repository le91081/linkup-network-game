// 主機上的終端機：ping / ipconfig / tracert / nslookup / curl
import { h } from './dom.js';
import { fmtIp, fmtMask, parseIp } from '../engine/ip.js';
import { transact, resolveName, dhcpTrace, arpRows, clearArp, dhcpRelease, dhcpRenew, fmtDur, throughput } from '../engine/sim.js';
import { plainStamp } from '../engine/ops.js';
import { remoteOpen, remoteLogin, remoteSend, remoteAlive, remoteClose, remoteBusy } from '../engine/remote.js';
import { iosSession } from '../engine/ios.js';
import { fortiSession } from '../engine/fortios.js';
import { iosRun, IOS_CMDS, consoleFollow } from './cli.js';
import { counters, onBulk } from '../engine/wire.js';
import { fortiRun } from './forticli.js';
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
  '  ipconfig /renew         重新向 DHCP 伺服器要一次 IP（播放 DORA 四個步驟）',
  '  ipconfig /release       歸還 DHCP 位址',
  '  arp -a                  顯示 ARP 快取（IP 對應到哪個 MAC）',
  '  arp -d                  清空 ARP 快取',
  '  tracert <IP 或網域>     顯示封包經過的每一台路由器',
  '  nslookup <網域>         向 DNS 查詢網域的 IP',
  '  curl <IP 或網域>[:埠]   測試 TCP 連線（預設 443）',
  '  iperf3 -c <IP>          量測到另一台主機的實際傳輸速率（跑 10 秒）',
  '  ssh <帳號>@<IP>         登入網路設備的命令列（加密）。輸入 exit 登出',
  '  telnet <IP>             登入網路設備的命令列（明文，帳號密碼在線路上看得到）',
  '  telnet <IP> <埠>        測試某個 TCP 連接埠通不通',
  '  netstat -e              網路卡收送了多少封包、有沒有錯誤',
  '  date                    顯示目前的日期與時間',
  '  cls                     清除畫面',
];

export function buildTerminal(ctx, body) {
  const { app, dev } = ctx;
  const logs = (app.termLog[dev.id] ||= [{ t: `${dev.name} 終端機 — 輸入 help 查看指令`, c: 'dim' }]);
  const hist = (app.termHist[dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'ping 192.168.1.1' });
  let drawPrompt = () => {};
  const draw = () => {
    out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || '\u00a0' })));
    out.scrollTop = out.scrollHeight;
    drawPrompt();
  };
  const print = (t, c) => logs.push({ t, c });
  const st = () => app.state;

  const resolve = (name) => {
    if (parseIp(name) != null) return { ok: true, ip: parseIp(name), hops: [], log: [] };
    return resolveName(st(), dev.id, name);
  };

  // ── 遠端登入 (SSH / Telnet)：登入之後，這個終端機打的每一行都送到對方的命令列 ──
  const remote = () => (app.remote ||= {})[dev.id];
  const endRemote = (msg, cls, hint) => {
    delete app.remote[dev.id];
    if (msg) print(msg, cls);
    if (hint) print('  ↳ ' + hint, 'hint');
  };
  const askPass = (r) => { r.stage = 'pass'; if (r.conn.proto === 'ssh') print(`${r.conn.user}@${r.ip}'s password:`); };
  const banner = (r) => { const b = (st().devices[r.conn.to].mgmt || {}).banner; if (b) { print(''); print(b); print(''); } };

  const startRemote = (line, proto, target, user) => {
    const r0 = resolve(target);
    if (!r0.ok) { print(`${proto}: Could not resolve hostname ${target}: ${r0.reason}`, 'bad'); return; }
    const ip = fmtIp(r0.ip);
    const o = remoteOpen(st(), dev.id, proto, r0.ip, user);
    app.showTrace(`${dev.name}> ${line}`, [...r0.log, ...o.res.log], [...r0.hops, ...o.res.hops], o.res);
    if (proto === 'telnet') print(`Trying ${ip} ...`);
    if (o.noPass) {
      // TCP 連得上，但設備說「這條線路要密碼，可是沒有設定」就把連線關掉
      print(`Connected to ${ip}.`);
      print('');
      print('Password required, but none set', 'bad');
      print('Connection closed by foreign host.', 'dim');
      print('  ↳ ' + o.reason, 'hint');
      return;
    }
    if (!o.ok) {
      const why = o.refused ? 'Connection refused' : o.res.phase === 'request' && /沒有.*路由|沒有設定預設閘道/.test(o.reason) ? 'No route to host' : /連線被拒絕|沒有開啟|沒有開放|不在.*允許/.test(o.reason) ? 'Connection refused' : 'Connection timed out';
      print(proto === 'ssh' ? `ssh: connect to host ${ip} port 22: ${why}` : `telnet: Unable to connect to remote host: ${why}`, 'bad');
      print('  ↳ ' + o.reason, 'hint');
      return;
    }
    const r = (app.remote[dev.id] = { conn: o.conn, kind: o.kind, key: o.key, ip, stage: null, sess: null, auth: o.auth });
    if (o.open) {
      // no login：不用驗證就直接進去了
      print(`Connected to ${ip}.`);
      banner(r);
      shell(r);
      print('（這台設備的 line vty 是 no login：任何人連進來都不用帳號密碼）', 'hint');
      return;
    }
    if (proto === 'ssh') {
      // 第一次連到這台主機：先確認它的金鑰指紋。之後同一個 IP 換了一台設備（或有人冒充），用戶端會拒絕連線
      const known = ((app.knownHosts ||= {})[dev.id] ||= {});
      if (known[ip] && known[ip] !== o.key) {
        remoteClose(st(), o.conn);
        ['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
          'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!', `The fingerprint for the RSA key sent by the remote host is ${o.key}.`, 'Host key verification failed.'].forEach((l) => print(l, 'bad'));
        endRemote(null, null, `${ip} 現在是另一台設備在回應（金鑰和上次不一樣）。確定是設備換過的話，輸入 ssh-keygen -R ${ip} 把舊的紀錄刪掉再連一次。`);
        return;
      }
      if (!known[ip]) {
        print(`The authenticity of host '${ip} (${ip})' can't be established.`);
        print(`RSA key fingerprint is ${o.key}.`);
        print('Are you sure you want to continue connecting (yes/no)?');
        r.stage = 'key';
      } else askPass(r);
    } else {
      print(`Connected to ${ip}.`);
      banner(r);
      print('User Access Verification');
      print('');
      if (o.auth === 'line') { r.stage = 'pass'; } else r.stage = 'user';
    }
  };
  /** 登入成功，接下來打的每一行都送到對方的命令列 */
  const shell = (r) => {
    const c = r.conn;
    r.stage = 'shell';
    const line = 'vty' + Math.max(0, ((st().dyn.vty || {})[c.to] || []).findIndex((v) => v.cid === c.cid));
    r.sess = r.kind === 'ios' ? iosSession(() => st().devices[c.to], st, { user: c.user || '(line)', line, ip: c.seen }) : fortiSession(() => st().devices[c.to], st);
    consoleFollow(app, c.to, 'vty:' + c.cid, () => {}); // 從現在開始看：以前的紀錄不會倒出來
  };

  const remoteInput = (line) => {
    const r = remote(), s = st(), c = r.conn, ip = r.ip;
    if (r.stage === 'key') {
      print('(yes/no)? ' + line, 'cmd');
      if (/^y(es)?$/i.test(line.trim())) {
        app.knownHosts[dev.id][ip] = r.key;
        print(`Warning: Permanently added '${ip}' (RSA) to the list of known hosts.`, 'dim');
        askPass(r);
      } else { remoteClose(s, c); endRemote('Host key verification failed.', 'bad'); }
      return;
    }
    if (r.stage === 'user') { print('Username: ' + line, 'cmd'); c.user = line.trim(); r.stage = 'pass'; return; }
    if (r.stage === 'pass') {
      if (c.proto === 'telnet') print('Password: ', 'cmd'); // 密碼不會顯示在畫面上
      const a = remoteLogin(s, c, line);
      ctx.commit(false);
      if (a.ok) {
        if (c.proto === 'ssh') banner(r);
        shell(r);
        print('');
      } else if (a.closed) {
        endRemote(c.proto === 'ssh' ? `${c.user}@${ip}: Permission denied (publickey,password).` : r.auth === 'line' ? '% Bad passwords' : '% Login invalid', 'bad', a.reason);
        if (c.proto === 'telnet') print('Connection closed by foreign host.', 'dim');
      } else if (c.proto === 'ssh') { print('Permission denied, please try again.', 'bad'); askPass(r); }
      else if (r.auth === 'line') { print('% Login invalid', 'bad'); print(''); r.stage = 'pass'; }
      else { print('% Login invalid', 'bad'); print(''); r.stage = 'user'; }
      return;
    }
    // 已經登入：這一行送到對方的命令列
    const ios = r.kind === 'ios';
    print(r.sess.prompt() + (ios ? ' ' : '') + line, 'cmd');
    const low = line.trim().toLowerCase();
    const atTop = ios ? r.sess.mode === 'exec' && !r.sess.pending : !r.sess.depth;
    if (atTop && ['exit', 'logout', 'quit'].includes(low)) {
      remoteClose(s, c);
      ctx.commit(false);
      endRemote(c.proto === 'ssh' ? `Connection to ${ip} closed.` : 'Connection closed by foreign host.', 'dim');
      return;
    }
    const sent = remoteSend(s, c, line);
    if (!sent.ok) { lost(r, sent); return; }
    // terminal monitor：用 SSH / Telnet 登入時，紀錄與 debug 的訊息預設只會出現在 console 上，要自己打開才看得到
    if (ios && /^term(i(n(a(l)?)?)?)?\s+mon/i.test(low)) r.monitor = true;
    if (ios && /^term(i(n(a(l)?)?)?)?\s+no\s+mon/i.test(low)) r.monitor = false;
    const out = ios ? iosRun(app, c.to, r.sess, line, print) : fortiRun(app, c.to, r.sess, line, print);
    if (out.clear) logs.length = 0;
    if (out.changed) ctx.commit(false);
    if (out.xfer) app.showTrace(`${st().devices[c.to].name}# ${line}`, out.xfer.log, out.xfer.hops, out.xfer);
    if (out.wait > 0) {
      // 指令執行期間（例如 copy 傳一個大檔案）時間照樣在走，但這條連線不算閒置
      remoteBusy(s, c, true);
      app.tick(Math.ceil(out.wait));
      remoteBusy(s, c, false);
    }
    if (!ios || r.monitor) consoleFollow(app, c.to, 'vty:' + c.cid, print); else consoleFollow(app, c.to, 'vty:' + c.cid, () => {});
    if (out.reloaded) endRemote(`Connection to ${ip} closed by remote host.`, 'warn', '設備重新開機了，所有登入的連線都會中斷。');
  };

  /** 連線斷了：說明是設備那一端主動結束，還是路上有設備把這條連線忘了 */
  const lost = (r, why) => {
    const d = st().devices[r.conn.to], c = r.conn;
    if (why.by === 'net') {
      remoteClose(st(), c);
      endRemote(c.proto === 'ssh' ? `packet_write_wait: Connection to ${r.ip} port 22: Broken pipe` : 'Connection closed by foreign host.', 'bad', '這一行沒有送到對方：' + why.reason);
    } else {
      const lim = why.limit;
      endRemote(c.proto === 'ssh' ? `Connection to ${r.ip} closed by remote host.` : 'Connection closed by foreign host.', 'warn',
        d && lim > 0 ? `${d.name} 把這條登入連線結束了：閒置超過 ${fmtDur(lim)} 就會自動登出（${r.kind === 'ios' ? 'line vty 的 exec-timeout' : 'config system global 的 admintimeout'}），或是設備重新開機了。` : '設備那一端已經把這條登入連線結束了。');
    }
  };

  const run = async (line) => {
    if (remote()) { remoteInput(line); draw(); return; }
    print('C:\\> ' + line, 'cmd');
    const [cmd, ...args] = line.trim().split(/\s+/);
    const c = (cmd || '').toLowerCase();
    if (c === 'help' || c === '?') HELP.forEach((x) => print(x, 'dim'));
    else if (c === 'ssh' || (c === 'telnet' && args[0] && (args[1] == null || args[1] === '23') && !args[0].includes(':'))) {
      // ssh admin@10.0.99.1、ssh -l admin 10.0.99.1、telnet 10.0.99.1
      let user = '', target = '';
      const rest = args.slice();
      const l = rest.indexOf('-l');
      if (l >= 0) { user = rest[l + 1] || ''; rest.splice(l, 2); }
      target = rest.find((x) => !x.startsWith('-')) || '';
      if (target.includes('@')) [user, target] = target.split('@');
      if (!target || (c === 'ssh' && !user)) print(c === 'ssh' ? '用法：ssh <帳號>@<IP>，例如 ssh admin@10.0.99.1' : '用法：telnet <IP>', 'warn');
      else startRemote(line, c, target, user);
    } else if (c === 'ssh-keygen') {
      const ip = args[0] === '-R' ? args[1] : null;
      if (!ip) print('用法：ssh-keygen -R <IP>（把這個位址的主機金鑰紀錄刪掉）', 'warn');
      else if (((app.knownHosts || {})[dev.id] || {})[ip]) { delete app.knownHosts[dev.id][ip]; print(`# Host ${ip} found: line 1`); print('known_hosts updated.'); } else print(`Host ${ip} not found in known_hosts`, 'dim');
    }
    else if (c === 'cls' || c === 'clear') logs.length = 0;
    else if (c === 'netstat') {
      const p = dev.ports[0];
      if (!/^-e$/i.test(args[0] || '')) print('用法：netstat -e（網路卡收送了多少封包、有沒有錯誤）', 'warn');
      else if (!p) print('這台設備沒有有線網路卡。', 'dim');
      else {
        const x = counters(st(), dev.id, p.id), w = (a, b) => `${String(a).padStart(18)}${String(b).padStart(18)}`;
        print('介面統計資料');
        print('');
        print(`${''.padEnd(16)}${'已接收'.padStart(15)}${'已傳送'.padStart(15)}`, 'pre');
        print('');
        print(`${'位元組'.padEnd(14)}${w(x.ib, x.ob)}`, 'pre');
        print(`${'單點傳送封包'.padEnd(10)}${w(x.ip - x.ibc - x.imc, x.op - x.obc - x.omc)}`, 'pre');
        print(`${'非單點傳送封包'.padEnd(9)}${w(x.ibc + x.imc, x.obc + x.omc)}`, 'pre');
        print(`${'捨棄'.padEnd(14)}${w(0, 0)}`, 'pre');
        print(`${'錯誤'.padEnd(14)}${w(x.crc + x.runts, x.late)}`, x.crc + x.runts + x.late ? 'bad' : 'pre');
        if (x.imc) print(`  ↳ 收到的非單點傳送封包大多是交換器的 STP BPDU（每 2 秒一個）`, 'hint');
      }
    }
    else if (c === 'date' || c === 'time') { const t = plainStamp(st(), dev); print(`${t.date} ${t.time}（電腦的時間由作業系統自動校正，這裡當作是準的）`); }
    else if (c === 'arp' && /^-d/i.test(args[0] || '')) { clearArp(st(), dev); app.refreshLive(); }
    else if (c === 'arp') {
      const rows = arpRows(st(), dev);
      if (!rows.length) print('找不到 ARP 項目。（先 ping 一個位址，電腦才會去問它的 MAC；項目兩分鐘沒用到就會過期）', 'dim');
      else {
        print('');
        print('  網際網路位址      實體位址            類型', 'pre');
        rows.forEach((r) => print(`  ${fmtIp(r.ip).padEnd(18)}${r.mac.replace(/:/g, '-').padEnd(20)}動態`, 'pre'));
      }
    } else if (c === 'ipconfig' || c === 'ifconfig' || (c === 'ip' && args[0])) {
      if (/^\/?release$/i.test(args[0] || '')) { dhcpRelease(st(), dev.id); ctx.commit(false); }
      if (/^\/?renew$/i.test(args[0] || '')) {
        dhcpRenew(st(), dev.id);
        ctx.commit(false);
        const tr = dhcpTrace(st(), dev.id);
        app.showTrace(`${dev.name}> ${line}`, tr.log, tr.hops, { ok: tr.ok, reason: tr.reason, failDev: dev.id });
        if (!tr.ok) print('更新介面時發生錯誤：' + tr.reason, 'bad');
      }
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
        if (rt.exp != null) print(`   租約到期 . . . . . . : ${fmtDur(rt.exp - st().clock)}後${rt.held ? '（目前連不到 DHCP 伺服器）' : ''}`, rt.held ? 'warn' : '');
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
            const arp = res.hops.filter((x) => x.wave).length; // 第一個封包要先等 ARP，所以比較慢
            const ms = Math.max(1, res.hops.filter((x) => !x.wave && x.proto !== 'arp').length) + (res.l3.some((x) => st().devices[x.dev].kind === 'internet') ? 9 : 0);
            for (let n = 0; n < 4; n++) {
              print(res.ok ? `回覆自 ${ip}: 位元組=32 時間=${ms + (n === 0 ? arp * 2 : 0)}ms TTL=${64 - res.l3.length}` : res.phase === 'reply' ? '要求等候逾時。' : '目的地主機無法連線。', res.ok ? 'ok' : 'bad');
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
    } else if (c === 'iperf3' || c === 'iperf') {
      const t = args.filter((x) => !x.startsWith('-'))[0];
      const ip = parseIp(t || '');
      if (ip == null) print('用法：iperf3 -c <伺服器 IP>', 'warn');
      else {
        const res = transact(st(), dev.id, { proto: 'tcp', dst: ip, dport: 5201 });
        app.showTrace(`${dev.name}> ${line}`, res.log, res.hops, res);
        if (!res.ok) { print(`iperf3: error - unable to connect to server: ${res.phase === 'reply' ? 'Connection timed out' : 'No route to host'}`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
        else {
          const m = throughput(st(), res.hops);
          onBulk(st(), res.hops, m.mbps, 10, m.retr); // 10 秒內實際送了多少資料：計數器跟著增加
          const amt = (mbps) => { const mb = (mbps * 10) / 8; return mb >= 1000 ? (mb / 1000).toFixed(2) + ' GBytes' : mb >= 1 ? mb.toFixed(1) + ' MBytes' : (mb * 1000).toFixed(0) + ' KBytes'; };
          const rate = (mbps) => (mbps >= 1 ? `${mbps} Mbits/sec` : `${Math.round(mbps * 1000)} Kbits/sec`);
          print(`Connecting to host ${fmtIp(ip)}, port 5201`);
          print(`[  5] local ${fmtIp(res.srcIp)} port ${30000 + Math.floor(st().clock) % 20000} connected to ${fmtIp(ip)} port 5201`, 'pre');
          print('[ ID] Interval           Transfer     Bitrate         Retr', 'pre');
          print(`[  5]   0.00-10.00  sec  ${amt(m.mbps).padStart(11)}  ${rate(m.mbps).padEnd(15)} ${String(m.retr).padStart(4)}   sender`, m.retr ? 'bad' : 'ok');
          print(`[  5]   0.00-10.00  sec  ${amt(m.mbps).padStart(11)}  ${rate(m.mbps).padEnd(15)}        receiver`, 'pre');
          print('');
          print(`  ↳ 最慢的一段：${m.where}`, m.retr ? 'hint' : 'dim');
          app.tick(10); // 測試本身跑了 10 秒
        }
      }
    } else if (c) print(`'${cmd}' 不是內部或外部命令。輸入 help 查看可用指令。`, 'warn');
    draw();
  };

  input.addEventListener('keydown', (e) => {
    const r = remote();
    if (e.key === 'Enter') {
      const secret = r && r.stage === 'pass';
      const line = secret ? input.value : input.value.trim();
      input.value = '';
      // 密碼可以是空的；reload 的 [confirm] 也可以直接按 Enter
      if (!line && !(secret || (r && r.sess && r.sess.pending))) return;
      if (!secret) { hist.push(line); hi = hist.length; } // 密碼不留在歷史紀錄裡
      run(line);
    } else if (e.key === 'Tab' && r && r.stage === 'shell') {
      e.preventDefault();
      const c = r.kind === 'ios' ? r.sess.complete(input.value, IOS_CMDS) : r.sess.complete(input.value);
      if (c.line) input.value = c.line;
      if (c.options.length > 1) { print(r.sess.prompt() + ' ' + input.value, 'cmd'); print('  ' + c.options.join('   '), 'dim'); draw(); }
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
  const promptEl = h('span', { class: 'prompt', text: 'C:\\>' });
  const term = h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, promptEl, input));
  // 提示字元跟著目前的狀態變：本機、等待輸入密碼，或已經登入對方的命令列
  drawPrompt = () => {
    const r = remote();
    promptEl.textContent = !r ? 'C:\\>' : r.stage === 'key' ? '(yes/no)?' : r.stage === 'user' ? 'Username:' : r.stage === 'pass' ? 'Password:' : r.sess.prompt();
    input.type = r && r.stage === 'pass' ? 'password' : 'text';
    input.placeholder = r ? '' : 'ping 192.168.1.1';
  };
  // 沒有在打字的時候，設備那一端也可能因為閒置太久而把連線切掉
  app.refreshers.push(() => {
    const r = remote();
    if (!r || r.stage !== 'shell') return;
    const a = remoteAlive(st(), r.conn);
    if (!a.ok) { lost(r, a); draw(); return; }
    if ((r.kind !== 'ios' || r.monitor) && consoleFollow(app, r.conn.to, 'vty:' + r.conn.cid, print)) draw();
  });
  body.append(term, h('div', { class: 'chips' }, ['ipconfig', 'ping 8.8.8.8', 'tracert 8.8.8.8', 'nslookup www.example.com', 'arp -a', 'help'].map((x) =>
    h('button', { class: 'chip btnchip', type: 'button', text: x, onclick: () => { hist.push(x); hi = hist.length; run(x); } }))));
  draw();
  setTimeout(() => input.focus(), 30);
}
