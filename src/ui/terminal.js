// 主機上的終端機：ping / ipconfig / tracert / nslookup / curl
import { h, ownKeys, escLine } from './dom.js';
import { fmtIp, fmtMask, parseIp } from '../engine/ip.js';
import { transact, resolveName, dualStack, dnsQuery, dhcpTrace, arpRows, clearArp, dhcpRelease, dhcpRenew, fmtDur, throughput } from '../engine/sim.js';
import { cacheRows, cacheFlush, ptrName } from '../engine/dns.js';
import { plainStamp } from '../engine/ops.js';
import { remoteOpen, remoteLogin, remoteSend, remoteAlive, remoteClose, remoteBusy } from '../engine/remote.js';
import { iosSession } from '../engine/ios.js';
import { fortiSession } from '../engine/fortios.js';
import { iosRun, IOS_CMDS, consoleFollow } from './cli.js';
import { counters, onBulk } from '../engine/wire.js';
import { fortiRun } from './forticli.js';
import { transact6, dhcp6Trace, duidOf, iaidOf } from '../engine/sim6.js';
import { parseIp6, fmtIp6 } from '../engine/ip6.js';
import { isApiCurl, curlApi, ansibleCmd, fileCmd, netconfCmd, terraformCmd, tfAnswer, tfFileCmd, gitCmd, backupCmd, gitFileCmd } from './term-auto.js';
import { dockerCmd } from './term-docker.js';
import { dockerDeliver } from '../engine/docker.js';
import { tlsCheck, fmtDate, certSelf, CORP_CA, PUBLIC_CAS } from '../engine/web.js';
import { ipMtu, jumboCapable } from '../engine/mtu.js';

const V6SRC = { slaac: '（SLAAC）', dhcp6: '（DHCPv6）' };
const v6Lines = (rt, i) => (rt.v6 && rt.v6.ll != null
  ? [...rt.v6.addrs.map((a) => `   IPv6 位址 . . . . . . : ${fmtIp6(a.ip)}${a.bits === 128 && a.src === 'dhcp6' ? '' : '/' + a.bits}${V6SRC[a.src] || ''}`),
    `   連結-本機 IPv6 位址 . : ${fmtIp6(rt.v6.ll)}`, ...(rt.v6.gw != null ? [`   IPv6 預設閘道 . . . . : ${fmtIp6(rt.v6.gw)}`] : []),
    ...(rt.v6.dhcp && rt.v6.dhcp.ok ? [`   DHCPv6 IAID . . . . . : ${iaidOf(i)}`, `   DHCPv6 用戶端 DUID  . : ${duidOf(i)}`] : []),
    ...(rt.v6.dns && rt.v6.dns.length ? [`   IPv6 DNS 伺服器 . . . : ${rt.v6.dns.map(fmtIp6).join(', ')}`] : []),
    ...(rt.v6.dhcp && !rt.v6.dhcp.ok ? [`   DHCPv6 . . . . . . . : 失敗（${rt.v6.dhcp.why}）`] : [])]
  : []);

const HELP = [
  '可用指令：',
  '  ping <IP 或網域>        測試連線（會在場景中播放封包動畫）',
  '  ping -f -l 1472 <IP>    送 1472 位元組的資料、設 DF 不可分段：找出路徑上的 MTU（1472 + 28 = 1500）',
  '  netsh interface ipv4 show subinterfaces   看每張網卡的 MTU（set subinterface "乙太網路" mtu=9000 修改）',
  '  ipconfig                顯示本機的網路設定',
  '  ipconfig /renew         重新向 DHCP 伺服器要一次 IP（播放 DORA 四個步驟）',
  '  ipconfig /release       歸還 DHCP 位址',
  '  ipconfig /renew6        重新向 DHCPv6 要位址或 DNS（依 RA 的 M / O 旗標）',
  '  ipconfig /displaydns    顯示 DNS 快取（查過的名稱，到期之前不會再問伺服器）',
  '  ipconfig /flushdns      清除 DNS 快取',
  '  arp -a                  顯示 ARP 快取（IP 對應到哪個 MAC）',
  '  arp -d                  清空 ARP 快取',
  '  tracert <IP 或網域>     顯示封包經過的每一台路由器',
  '  nslookup <網域>         直接向 DNS 伺服器查詢（不看本機的快取）',
  '  nslookup -type=mx <網域> 查郵件伺服器；-type=aaaa 查 IPv6 位址；nslookup <IP> 反查名稱 (PTR)',
  '  ping -4 / ping -6 <網域>  指定用 IPv4 或 IPv6（有 AAAA、電腦也有 IPv6 時預設用 IPv6）',
  '  curl https://<網域>     開網頁：HTTPS 會驗證憑證（-k 略過、-v 看憑證、-I 只看標頭、-L 跟著轉址）',
  '  date                    看這台電腦的時間（憑證的有效期間用它判斷）',
  '  iperf3 -c <IP>          量測到另一台主機的實際傳輸速率（跑 10 秒）',
  '  ssh <帳號>@<IP>         登入網路設備的命令列（加密）。輸入 exit 登出',
  '  telnet <IP>             登入網路設備的命令列（明文，帳號密碼在線路上看得到）',
  '  telnet <IP> <埠>        測試某個 TCP 連接埠通不通',
  '  netstat -e              網路卡收送了多少封包、有沒有錯誤',
  '  w32tm /resync           立刻和時間伺服器對時（「自動設定時間」要開著）',
  '  certutil -store root    列出信任的根憑證；certutil -addstore root <檔名>.cer 匯入',
  '  cls                     清除畫面',
];
/** Linux 主機（Ansible 控制主機、Docker 主機）的說明 */
const HELP_LINUX = [
  '可用指令：',
  '  ping <IP 或網域>        測試連線（會在場景中播放封包動畫）',
  '  ip addr / ip route      網路介面的位址 / 路由表（sudo ip link set eth0 mtu 9000 改 MTU）',
  '  ping -M do -s 8972 <IP> 送 8972 位元組的資料、設 DF 不可分段：測 Jumbo Frame（8972 + 28 = 9000）',
  '  traceroute <IP 或網域>  顯示封包經過的每一台路由器',
  '  nslookup <網域>         直接向 DNS 伺服器查詢',
  '  curl http(s)://<主機>[:埠]   開網頁：-k 略過憑證檢查、-v 看憑證、-I 只看標頭、-L 跟著轉址',
  '  ssh <帳號>@<IP>         登入網路設備的命令列。輸入 exit 登出',
  '  telnet <IP> <埠>        測試某個 TCP 連接埠通不通',
  '  timedatectl             時間與 NTP 同步的狀態（timedatectl set-ntp true 打開自動校時）',
  '  date                    顯示目前的日期與時間',
  '  clear                   清除畫面',
];

export function buildTerminal(ctx, body) {
  const { app, dev } = ctx;
  // Ansible 的控制主機跑的是 Linux（Ansible 不能裝在 Windows 上）
  const linux = !!dev.ansible || !!dev.docker || !!dev.tf || !!dev.git;
  const PS = dev.git ? 'netops@backup:~/network-configs$' : linux ? `${dev.ansible || dev.tf ? 'netops' : 'admin'}@${dev.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'ansible'}:~$` : 'C:\\>';
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
    r.sess = r.kind === 'ios' ? iosSession(() => st().devices[c.to], st, { user: c.user || '(line)', line, ip: c.seen, priv: c.priv ?? 15 }) : fortiSession(() => st().devices[c.to], st);
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
        if (a.aaa) print(`（AAA：${a.aaa.trail.join(' → ')}；權限等級 ${a.priv}）`, 'dim');
        shell(r);
        print('');
      } else if (a.closed) {
        endRemote(c.proto === 'ssh' ? `${c.user}@${ip}: Permission denied (publickey,password).` : r.auth === 'line' ? '% Bad passwords' : '% Login invalid', 'bad', a.reason);
        if (c.proto === 'telnet') print('Connection closed by foreign host.', 'dim');
      } else if (c.proto === 'ssh') { print('Permission denied, please try again.', 'bad'); if (a.aaa) print('  ↳ AAA：' + a.aaa.trail.join(' → '), 'hint'); askPass(r); }
      else if (r.auth === 'line') { print('% Login invalid', 'bad'); print(''); r.stage = 'pass'; }
      else { print('% Login invalid', 'bad'); print(''); r.stage = 'user'; }
      return;
    }
    // 已經登入：這一行送到對方的命令列
    const ios = r.kind === 'ios';
    if (!(r.sess.pending && r.sess.pending.secret)) print(r.sess.prompt() + (ios ? ' ' : '') + line, 'cmd');
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
    // terraform apply 在等 yes / no
    if (dev.tf && (app.tfAsk || {})[dev.id]) { tfAnswer(app, dev, line, print); ctx.commit(false); draw(); return; }
    print(PS + ' ' + line, 'cmd');
    const parts = line.trim().split(/\s+/);
    const sudo = linux && parts[0] === 'sudo' && parts.length > 1;
    if (sudo) parts.shift();
    const [cmd, ...args] = parts;
    const c = (cmd || '').toLowerCase();
    if (c === 'help' || c === '?') {
      (linux ? HELP_LINUX : HELP).forEach((x) => print(x, 'dim'));
      if ((dev.apps || []).includes('api')) print('  curl -k -u 帳號:密碼 -H "Accept: application/yang-data+json" https://<IP>/restconf/data/…   呼叫 REST API（-X 方法、-d 內容、-i 顯示標頭）', 'dim');
      if ((dev.apps || []).includes('api')) print('  netconf-console2 --host=<IP> --port=830 -u 帳號 -p 密碼 --hello | --get-config   NETCONF（SSH 的 830 埠；edit-config 用 API 分頁）', 'dim');
      if (dev.git) { print('  ./backup.sh             用 SSH 把每台設備的 running-config 抓回工作目錄', 'dim'); print('  git status | diff | add | commit -m "說明" | log [--oneline] [-p] | show <版本> | blame <檔名> | restore <檔名>', 'dim'); print('  ls / cat / head / tail <檔名>   工作目錄裡的設定檔', 'dim'); }
      if (dev.tf) { print('  terraform init | validate | plan | apply [-auto-approve]   Terraform（main.tf 也可以在 Terraform 分頁編輯）', 'dim'); print('  terraform import <位址> <ID> · terraform state list · ls / cat main.tf', 'dim'); }
      if (dev.ansible) { print('  ansible-playbook -i inventory.ini <playbook> [--check] [-v] [--limit 主機]   執行 playbook', 'dim'); print('  ls / cat <檔名>          列出 / 顯示控制主機上的檔案', 'dim'); }
      if (dev.docker) {
        print('  docker ps [-a]          列出容器；PORTS 欄是發佈的連接埠（主機:埠->容器埠）', 'dim');
        print('  docker run -d --name <名稱> -p [位址:]主機埠:容器埠 <映像檔>   建立並啟動容器', 'dim');
        print('  docker stop / start / restart / rm [-f] / port / logs / inspect <容器>', 'dim');
        print('  docker images、docker network ls', 'dim');
      }
    }
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
        print(`${'錯誤'.padEnd(14)}${w(x.crc + x.runts + (x.giants || 0), x.late)}`, x.crc + x.runts + (x.giants || 0) + x.late ? 'bad' : 'pre');
        if (x.giants) print(`  ↳ 收到 ${x.giants} 個比網卡的 MTU 還大的訊框，被丟掉了：網段裡有人開了 Jumbo Frame，這台沒有`, 'hint');
        if (x.imc) print(`  ↳ 收到的非單點傳送封包大多是交換器的 STP BPDU（每 2 秒一個）`, 'hint');
      }
    }
    else if (c === 'date' || c === 'time') { const t = plainStamp(st(), dev); const off = dev.clock && !dev.clock.sync; print(`${t.date} ${t.time}${off ? '' : '（電腦的時間由作業系統自動校正）'}`, off ? 'warn' : ''); if (off) print('（這台電腦的自動校時是關的：時間可能不準，HTTPS 憑證的有效期間也是用這個時間判斷。「網路設定」分頁可以打開自動校時）', 'hint'); }
    else if (c === 'arp' && /^-d/i.test(args[0] || '')) { clearArp(st(), dev); app.refreshLive(); }
    else if (c === 'arp') {
      const rows = arpRows(st(), dev);
      if (!rows.length) print('找不到 ARP 項目。（先 ping 一個位址，電腦才會去問它的 MAC；項目兩分鐘沒用到就會過期）', 'dim');
      else {
        print('');
        print('  網際網路位址      實體位址            類型', 'pre');
        rows.forEach((r) => print(`  ${fmtIp(r.ip).padEnd(18)}${r.mac.replace(/:/g, '-').padEnd(20)}動態`, 'pre'));
      }
    } else if (linux && (c === 'ipconfig' || c === 'w32tm' || c === 'certutil' || c === 'cls')) {
      print(`${cmd}: command not found`, 'warn');
      print(`  ↳ 這台是 Linux：${{ ipconfig: '用 ip addr 看位址、ip route 看路由', w32tm: '用 timedatectl 看時間同步', certutil: '根憑證放進 /usr/local/share/ca-certificates/ 再 update-ca-certificates', cls: '用 clear' }[c]}`, 'hint');
    } else if (linux && (c === 'ip' || c === 'ifconfig')) {
      linuxIp(c === 'ifconfig' ? ['addr'] : args);
    } else if (!linux && c === 'netsh') {
      const a = args.map((x) => x.toLowerCase());
      const ifName = (i) => (i.bind.t === 'wlan' ? 'Wi-Fi' : dev.ifaces.filter((x) => x.bind.t !== 'wlan').indexOf(i) > 0 ? `乙太網路 ${dev.ifaces.filter((x) => x.bind.t !== 'wlan').indexOf(i) + 1}` : '乙太網路');
      if (a[0] === 'interface' && /^ip(v4)?$/.test(a[1] || '') && a[2] === 'show' && /^subinterfaces?$/.test(a[3] || '')) {
        print('');
        print('   MTU  MediaSenseState   Bytes In  Bytes Out  Interface', 'pre');
        print('------  ---------------  ---------  ---------  -------------', 'pre');
        print('4294967295                1          0          0  Loopback Pseudo-Interface 1', 'pre');
        for (const i of dev.ifaces) {
          const p = i.bind.port, x = p ? counters(st(), dev.id, p) : { ib: 0, ob: 0 };
          print(`${String(ipMtu(st(), dev, i)).padStart(6)}  ${String(i.rt && i.rt.link ? 1 : 5).padStart(15)}  ${String(x.ib).padStart(9)}  ${String(x.ob).padStart(9)}  ${ifName(i)}`, 'pre');
        }
      } else if (a[0] === 'interface' && /^ip(v4)?$/.test(a[1] || '') && a[2] === 'set' && /^subinterface$/.test(a[3] || '')) {
        const m = line.match(/subinterface\s+(?:"([^"]+)"|(\S+))/i), mt = line.match(/mtu=(\d+)/i);
        const name = m && (m[1] || m[2]), i = dev.ifaces.find((x) => ifName(x) === name);
        if (!i) print(`找不到這個介面：${name || ''}（netsh interface ipv4 show subinterfaces 看名稱）`, 'bad');
        else if (!mt) print('用法：netsh interface ipv4 set subinterface "乙太網路" mtu=9000 store=persistent', 'warn');
        else if (!(+mt[1] >= 576 && +mt[1] <= (jumboCapable(dev) && i.bind.t !== 'wlan' ? 9000 : 1500))) print(`設定 MTU 失敗：${i.bind.t === 'wlan' ? 'Wi-Fi 介面卡最大只有 1500' : '超過網路卡支援的最大值（Jumbo Packet 9014 Bytes = MTU 9000）'}`, 'bad');
        else { if (+mt[1] === 1500) delete i.mtu; else i.mtu = +mt[1]; print('確定。', 'ok'); ctx.commit(true); }
      } else print('用法：netsh interface ipv4 show subinterfaces、netsh interface ipv4 set subinterface "乙太網路" mtu=<576-9000> store=persistent', 'warn');
    } else if (!linux && c === 'w32tm') {
      const a = args.join(' ').toLowerCase(), off = !!(dev.clock && dev.clock.sync === false);
      if (/\/resync/.test(a)) {
        print('正在傳送重新同步命令到本機電腦');
        if (off) { print('發生下列錯誤: 服務尚未啟動。 (0x80070426)', 'bad'); print('  ↳ 「自動設定時間」是關的，Windows Time 服務沒有在跑：到「網路設定」分頁打開自動設定時間', 'hint'); }
        else print('命令已順利完成。', 'ok');
      } else if (/\/query/.test(a) && /\/status/.test(a)) {
        if (off) print('發生下列錯誤: 服務尚未啟動。 (0x80070426)', 'bad');
        else { const t = plainStamp(st(), dev); ['躍點數: 4 (次要參照 - 以 (S)NTP 同步)', '精確度: -23 (每個刻度 119.209ns)', '來源: time.windows.com,0x9', `上次成功同步處理時間: ${t.date} ${t.time}`, '輪詢間隔: 10 (1024s)'].forEach((x) => print(x, 'pre')); }
      } else print('用法：w32tm /resync、w32tm /query /status', 'warn');
    } else if (linux && c === 'timedatectl') {
      const off = !!(dev.clock && dev.clock.sync === false);
      if (args[0] === 'set-ntp') { dev.clock = { ...(dev.clock || {}), sync: /^(true|yes|on|1)$/i.test(args[1] || '') }; ctx.commit(true); }
      else {
        const t = plainStamp(st(), dev);
        [`               Local time: ${t.day} ${t.date} ${t.time} CST`, '                Time zone: Asia/Taipei (CST, +0800)', `System clock synchronized: ${off ? 'no' : 'yes'}`, `              NTP service: ${off ? 'inactive' : 'active'}`, '          RTC in local TZ: no'].forEach((x) => print(x, x.includes(': no') && off ? 'warn' : 'pre'));
        if (off) print('（NTP 沒有開：timedatectl set-ntp true）', 'hint');
      }
    } else if (!linux && c === 'certutil') {
      const a = args.map((x) => x.toLowerCase());
      const trust = (dev.trust ||= []);
      if (a[0] === '-store' && a[1] === 'root') {
        print('Root "受信任的根憑證授權單位"');
        [...PUBLIC_CAS, ...trust].forEach((n, k) => { print(`================ 憑證 ${k} ================`, 'dim'); print(`主體: CN=${n}`, 'pre'); print(`簽發者: CN=${n}`, 'pre'); });
        print('CertUtil: -store 命令已順利完成。', 'ok');
      } else if (a[0] === '-addstore' || (a[0] === '-f' && a[1] === '-addstore')) {
        const rest = args.filter((x) => !/^-/.test(x));
        const store = (rest[0] || '').toLowerCase(), file = rest[1] || '';
        if (store !== 'root') print(`CertUtil: -addstore 命令失敗: 0x80092004 (-2146885628 CRYPT_E_NOT_FOUND)${store ? '' : '（用法：certutil -addstore root <檔名>.cer）'}`, 'bad');
        else if (!/corp-root-ca\.(cer|crt)$/i.test(file)) { print(`CertUtil: -addstore 命令失敗: 0x80070002 (WIN32: 2 ERROR_FILE_NOT_FOUND)`, 'bad'); print('  ↳ IT 放在桌面上的是 corp-root-ca.cer', 'hint'); }
        else {
          print('Root "受信任的根憑證授權單位"');
          print('簽章符合公開金鑰', 'dim');
          print(trust.includes(CORP_CA) ? `憑證 "${CORP_CA}" 已經在存放區中。` : `憑證 "${CORP_CA}" 已新增到存放區。`);
          print('CertUtil: -addstore 命令已順利完成。', 'ok');
          if (!trust.includes(CORP_CA)) { dev.trust = [...trust, CORP_CA]; ctx.commit(true); }
        }
      } else print('用法：certutil -store root、certutil -addstore root corp-root-ca.cer（要用系統管理員身分）', 'warn');
    } else if (c === 'ipconfig' && /^\/?displaydns$/i.test(args[0] || '')) {
      const rows = cacheRows(st(), dev);
      print('');
      print('Windows IP 設定');
      if (!rows.length) print('（DNS 解析程式快取是空的）', 'dim');
      for (const r of rows) {
        print('');
        print(`    ${r.name}`);
        print('    ----------------------------------------');
        print(`    記錄名稱 . . . . . . : ${r.name}`);
        print(`    記錄類型 . . . . . . : ${r.ip6 != null ? 28 : 1}`);
        print(`    存留時間 . . . . . . : ${r.left}`);
        print(`    資料長度 . . . . . . : ${r.ip6 != null ? 16 : 4}`);
        print('    區段 . . . . . . . . : 回答');
        if (r.alias) print(`    CNAME 記錄 . . . . . : （經由別名 ${r.alias}）`);
        if (r.ip6 != null) print(`    AAAA 記錄  . . . . . : ${fmtIp6(r.ip6)}`, 'ok');
        else print(`    A (主機) 記錄  . . . : ${fmtIp(r.ip)}`, 'ok');
      }
    } else if (c === 'ipconfig' && /^\/?flushdns$/i.test(args[0] || '')) {
      cacheFlush(st(), dev);
      print('');
      print('Windows IP 設定');
      print('');
      print('已成功清除 DNS 解析程式快取。', 'ok');
    } else if (c === 'ipconfig' || c === 'ifconfig' || (c === 'ip' && args[0])) {
      if (/^\/?release$/i.test(args[0] || '')) { dhcpRelease(st(), dev.id); ctx.commit(false); }
      if (/^\/?renew6$/i.test(args[0] || '')) {
        // DHCPv6 沒有「續約」的 DORA：stateful 是 Solicit / Advertise / Request / Reply，stateless 只有 Information-Request / Reply
        const tr = dhcp6Trace(st(), dev.id);
        app.showTrace(`${dev.name}> ${line}`, tr.log, tr.hops, { ok: tr.ok, reason: tr.reason, failDev: dev.id });
        if (!tr.ok) print('更新介面時發生錯誤：' + tr.reason, 'bad');
      }
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
          // 線有接、只是沒有 IPv4（例如純 IPv6 的網段）：不是「媒體中斷」
          if (rt.link) print(`   IPv4 位址 . . . . . . : （尚未設定${rt.note ? '：' + rt.note : ''}）`, rt.v6 && rt.v6.addrs.length ? 'dim' : 'warn');
          else print('   媒體狀態 . . . . . . : 媒體已中斷連線', 'warn');
          print(`   實體位址 (MAC) . . . : ${rt.mac}`);
          v6Lines(rt, i).forEach((x) => print(x));
          continue;
        }
        print(`   實體位址 (MAC) . . . : ${rt.mac}`);
        print(`   DHCP 已啟用 . . . . . : ${i.mode === 'dhcp' ? '是' : '否'}`);
        if (rt.exp != null) print(`   租約到期 . . . . . . : ${fmtDur(rt.exp - st().clock)}後${rt.held ? '（目前連不到 DHCP 伺服器）' : ''}`, rt.held ? 'warn' : '');
        print(`   IPv4 位址 . . . . . . : ${fmtIp(rt.ip)}${rt.src === 'apipa' ? '（APIPA，自動設定）' : ''}`, rt.src === 'apipa' ? 'warn' : '');
        print(`   子網路遮罩  . . . . . : ${fmtMask(rt.bits)}`);
        print(`   預設閘道 . . . . . . : ${rt.gw != null ? fmtIp(rt.gw) : ''}`);
        print(`   DNS 伺服器  . . . . . : ${rt.dns.map(fmtIp).join(', ')}`);
        v6Lines(rt, i).forEach((x) => print(x));
      }
    } else if (c === 'ping' || c === 'tracert' || c === 'traceroute') {
      // Windows：ping -f -l 1472 <IP>；Linux：ping -M do -s 1472 <IP>（-l / -s 是資料的大小，IP 封包再多 28 位元組）
      const takes = linux ? ['-s', '-c', '-M', '-W', '-i', '-t', '-I'] : ['-l', '-n', '-w', '-i', '-S'];
      let target = '', data = null, df = false, badSize = null;
      for (let k = 0; k < args.length; k++) {
        const x = args[k];
        if (takes.includes(x)) { const v = args[++k]; if (x === '-l' || x === '-s') { data = +v; if (!(Number.isInteger(data) && data >= 0 && data <= (linux ? 65507 : 65500))) badSize = v; } if (x === '-M') df = v === 'do'; continue; }
        if (x === '-f' && !linux) { df = true; continue; }
        if (!x.startsWith('-') && !target) target = x;
      }
      if (badSize != null) { print(linux ? `ping: invalid argument: '${badSize}': out of range: 0 <= value <= 65507` : `錯誤的值給選項 -l，有效範圍是從 0 到 65500。`, 'bad'); draw(); return; }
      const dataLen = data ?? (linux ? 56 : 32);
      // 用名稱 ping：電腦有全域的 IPv6 位址、名稱又有 AAAA 時優先用 IPv6（ping -4 / -6 可以指定）
      const fam = args.includes('-4') ? 4 : args.includes('-6') ? 6 : 0;
      const named = !!target && !target.includes(':') && parseIp(target) == null;
      const r6 = named && fam !== 4 && st().v6 && (fam === 6 || dev.ifaces.some((i) => i.rt.v6 && i.rt.v6.addrs.length)) ? resolveName(st(), dev.id, target, 0, { type: 'AAAA' }) : null;
      if (!target) print(`用法：${c} <IP 或網域>`, 'warn');
      else if (named && fam === 6 && !(r6 && r6.ok)) print(`Ping 要求找不到主機 ${target}。${r6 ? r6.reason : '這台電腦沒有 IPv6'}`, 'bad');
      else if (target.includes(':') || (r6 && r6.ok)) {
        const d6 = r6 && r6.ok ? r6.ip6 : parseIp6(target);
        if (d6 == null) print('IPv6 位址的格式不正確', 'bad');
        else {
          const res = transact6(st(), dev.id, d6);
          app.showTrace(`${dev.name}> ${line}`, [...(r6 ? r6.log : []), ...res.log], [...(r6 ? r6.hops : []), ...res.hops], res);
          print('');
          if (r6 && r6.ok) print(`（${target} 有 AAAA 記錄，這台電腦也有 IPv6 位址，所以用 IPv6；要用 IPv4 請 ping -4 ${target}）`, 'hint');
          if (c !== 'ping') {
            print(`在上限 30 個躍點上追蹤 ${fmtIp6(d6)} 的路由：`);
            res.l3.forEach((x, n) => print(`  ${String(n + 1).padStart(2)}    ${String(n + 1).padStart(2)} ms    ${fmtIp6(x.ip6).padEnd(28)} ${st().devices[x.dev].name}`));
            if (res.ok || res.phase === 'reply') print(`  ${String(res.l3.length + 1).padStart(2)}    ${String(res.l3.length + 1).padStart(2)} ms    ${fmtIp6(d6)}`, res.ok ? 'ok' : '');
            if (!res.ok) { print(`  ${String(res.l3.length + 1 + (res.phase === 'reply' ? 1 : 0)).padStart(2)}     *        *        要求等候逾時。`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
            else print('追蹤完成。');
          } else {
            print(`Ping ${r6 && r6.ok ? `${target} [${fmtIp6(d6)}]` : fmtIp6(d6)} (使用 32 位元組的資料):`);
            for (let n = 0; n < 4; n++) print(res.ok ? `回覆自 ${fmtIp6(d6)}: 時間=${Math.max(1, res.hops.length)}ms` : res.phase === 'reply' ? '要求等候逾時。' : '目的地主機無法連線。', res.ok ? 'ok' : 'bad');
            if (!res.ok) print('  ↳ ' + res.reason, 'hint');
          }
        }
      } else {
        const r = resolve(target);
        if (!r.ok) print(`Ping 要求找不到主機 ${target}。${r.reason}`, 'bad');
        else {
          const res = transact(st(), dev.id, { proto: 'icmp', dst: r.ip, ...(c === 'ping' ? { size: dataLen + 28, ...(df ? { df: true } : {}) } : {}) });
          const ip = fmtIp(r.ip);
          app.showTrace(`${dev.name}> ${line}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
          if (c === 'ping' && linux) {
            // Linux 的 ping（iputils）
            const ms = (Math.max(1, res.hops.filter((x) => !x.wave && x.proto !== 'arp').length) * 0.21 + (res.l3.some((x) => st().devices[x.dev].kind === 'internet') ? 8.6 : 0)).toFixed(3);
            print(`PING ${target} (${ip}) ${dataLen}(${dataLen + 28}) bytes of data.`);
            for (let n = 1; n <= 4; n++) {
              if (res.ok) print(`${dataLen + 8} bytes from ${ip}: icmp_seq=${n} ttl=${64 - res.l3.length} time=${ms} ms`, 'ok');
              else if (res.dfLocal) print(`ping: local error: message too long, mtu=${res.dfLocal}`, 'bad');
              else if (res.ptb) print(`From ${fmtIp(res.ptb.from)} icmp_seq=${n} Frag needed and DF set (mtu = ${res.ptb.mtu})`, 'bad');
            }
            print('');
            print(`--- ${target} ping statistics ---`);
            print(`4 packets transmitted, ${res.ok ? 4 : 0} received, ${!res.ok && (res.ptb || res.dfLocal) ? '+4 errors, ' : ''}${res.ok ? 0 : 100}% packet loss, time 3005ms`, res.ok ? '' : 'bad');
            if (!res.ok) print('  ↳ ' + res.reason, 'hint');
          } else if (c === 'ping') {
            print('');
            print(`Ping ${target === ip ? ip : `${target} [${ip}]`} (使用 ${dataLen} 位元組的資料):`);
            const arp = res.hops.filter((x) => x.wave).length; // 第一個封包要先等 ARP，所以比較慢
            const ms = Math.max(1, res.hops.filter((x) => !x.wave && x.proto !== 'arp').length) + (res.l3.some((x) => st().devices[x.dev].kind === 'internet') ? 9 : 0);
            for (let n = 0; n < 4; n++) {
              print(res.ok ? `回覆自 ${ip}: 位元組=${dataLen} 時間=${ms + (n === 0 ? arp * 2 : 0)}ms TTL=${64 - res.l3.length}`
                : res.dfLocal ? '封包需要分段，但設定了 DF。'
                  : res.ptb ? `回覆自 ${fmtIp(res.ptb.from)}: 封包需要分段，但設定了 DF。`
                    : res.phase === 'reply' || res.silent ? '要求等候逾時。' : '目的地主機無法連線。', res.ok ? 'ok' : 'bad');
            }
            print('');
            // Windows 把「需要分段」的 ICMP 回應也算成收到
            const got = res.ok || res.ptb ? 4 : 0;
            print(`    封包: 已傳送 = 4，已收到 = ${got}，已遺失 = ${4 - got} (${(4 - got) * 25}% 遺失)，`);
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
      const tm = (args.find((a) => /^-(type|q|querytype)=/i.test(a)) || '').split('=')[1];
      const target = args.find((a) => !a.startsWith('-'));
      const type = (tm || '').toUpperCase() || (parseIp(target || '') != null ? 'PTR' : 'A');
      const srvLine = (r) => {
        const sd = r.server && st().devices[r.server];
        print(`伺服器:  ${sd ? sd.name.replace(/\s+/g, '-') : 'UnKnown'}`);
        print(`Address:  ${r.serverIp != null ? fmtIp(r.serverIp) : '—'}`);
        print('');
      };
      if (!target) print('用法：nslookup <網域>、nslookup -type=mx <網域>、nslookup <IP>', 'warn');
      else if (type === 'A') {
        // nslookup 自己就是一個 DNS 用戶端：直接問伺服器，不看、也不寫本機的快取
        const r = resolveName(st(), dev.id, target, 0, { nocache: true });
        // Windows 的 nslookup 也會問 AAAA：兩種都有就列成 Addresses
        const q6 = r.ok && st().v6 ? resolveName(st(), dev.id, target, 0, { nocache: true, type: 'AAAA' }) : null;
        app.showTrace(`${dev.name}> ${line}`, r.log, r.hops, r);
        if (r.ok) {
          srvLine(r);
          if (!r.auth) print('未經授權的回答:');
          print(`名稱:    ${r.canonical || target}`);
          if (q6 && q6.ok) { print(`Addresses:  ${fmtIp6(q6.ip6)}`, 'ok'); print(`          ${fmtIp(r.ip)}`, 'ok'); }
          else print(`Address:  ${fmtIp(r.ip)}`, 'ok');
          if (r.alias) print(`Aliases:  ${target}`);
        } else print('*** ' + r.reason, 'bad');
      } else if (type === 'AAAA') {
        const r = resolveName(st(), dev.id, target, 0, { nocache: true, type: 'AAAA' });
        app.showTrace(`${dev.name}> ${line}`, r.log, r.hops, r);
        if (r.ok) {
          srvLine(r);
          if (!r.auth) print('未經授權的回答:');
          print(`名稱:    ${r.canonical || target}`);
          print(`Address:  ${fmtIp6(r.ip6)}`, 'ok');
          if (r.alias) print(`Aliases:  ${target}`);
        } else print('*** ' + r.reason, 'bad');
      } else if (type === 'MX' || type === 'PTR') {
        const name = type === 'PTR' ? ptrName(parseIp(target)) : target;
        const r = dnsQuery(st(), dev.id, name, type);
        app.showTrace(`${dev.name}> ${line}`, r.log, r.hops, r);
        if (!r.ok) print('*** ' + r.reason, 'bad');
        else {
          srvLine(r);
          for (const x of r.records) {
            if (type === 'MX') print(`${target}	MX preference = ${x.pref ?? 10}, mail exchanger = ${x.value}`, 'ok');
            else print(`${name}	name = ${x.value}`, 'ok');
          }
        }
      } else print(`這個模擬支援的查詢類型：A（預設）、AAAA、MX、PTR`, 'warn');
    } else if (c === 'docker' && dev.docker) {
      dockerCmd(app, dev, args, print, () => ctx.commit(false));
    } else if (c === 'curl' && isApiCurl(line)) {
      curlApi(app, dev, line.trim(), print);
      ctx.commit(false);
    } else if (c === 'netconf-console2' && ((dev.apps || []).includes('api') || dev.ansible)) {
      netconfCmd(app, dev, line.trim(), print);
      ctx.commit(false);
    } else if (c === 'git' && dev.git) {
      gitCmd(app, dev, line.trim(), print);
      ctx.commit(false);
    } else if (dev.git && (c === './backup.sh' || ((c === 'sh' || c === 'bash') && /^(\.\/)?backup\.sh$/.test(args[0] || '')))) {
      backupCmd(app, dev, print);
      ctx.commit(false);
    } else if (dev.git && c === 'backup.sh') {
      print('backup.sh: command not found', 'warn');
      print('  ↳ 目前目錄裡的程式要寫成 ./backup.sh（Linux 不會在目前目錄找指令）', 'hint');
    } else if (dev.git && ['ls', 'pwd', 'cat', 'less', 'more', 'head', 'tail'].includes(c) && gitFileCmd(dev, c, args, print)) {
      // 備份伺服器的工作目錄
    } else if (c === 'terraform' && dev.tf) {
      terraformCmd(app, dev, line.trim(), print);
      ctx.commit(false);
    } else if (dev.tf && ['ls', 'cat', 'less', 'more'].includes(c) && tfFileCmd(dev, c, args, print)) {
      // Terraform 控制主機上的檔案
    } else if (c === 'ansible-playbook' && dev.ansible) {
      ansibleCmd(app, dev, line.trim(), print);
      ctx.commit(false);
    } else if (dev.ansible && ['ls', 'cat', 'less', 'more', 'ansible', 'ansible-galaxy'].includes(c) && fileCmd(dev, c, args, print)) {
      // 控制主機上的檔案
    } else if ((c === 'curl' || c === 'telnet') && /^(https?:\/\/)?\[|^[0-9a-f]*:[0-9a-f:]*:/i.test(args.find((x) => !x.startsWith('-')) || '')) {
      const url6 = args.find((x) => !x.startsWith('-')) || '';
      const raw = url6.replace(/^https?:\/\//, '');
      const m6 = raw.match(/^\[([^\]]+)\](?::(\d+))?/);
      const addr = m6 ? m6[1] : raw.replace(/\/.*$/, '');
      let port = m6 && m6[2] ? +m6[2] : /^http:/.test(url6) ? 80 : 443;
      if (args[1] && /^\d+$/.test(args[1])) port = +args[1];
      const d6 = parseIp6(addr);
      if (d6 == null) print('IPv6 位址的格式不正確（網址裡的 IPv6 位址要加中括號，例如 curl http://[2001:db8::10]/）', 'bad');
      else {
        const res = transact6(st(), dev.id, d6, { proto: 'tcp', dport: port });
        app.showTrace(`${dev.name}> ${line}`, res.log, res.hops, res);
        if (res.ok) print(c === 'telnet' ? `已連線到 [${fmtIp6(d6)}]:${port}` : `已連線到 [${fmtIp6(d6)}]:${port} — HTTP/1.1 200 OK`, 'ok');
        else { print(`${c}: 無法連線到 [${fmtIp6(d6)}] 埠 ${port}`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
      }
    } else if (c === 'curl') {
      webCurl(args);
    } else if (c === 'telnet') {
      let t = (args[0] || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      let port = /^http:/.test(args[0] || '') ? 80 : 443;
      const m = t.match(/^(.*):(\d+)$/);
      if (m) { t = m[1]; port = +m[2]; }
      if (args[1] && /^\d+$/.test(args[1])) port = +args[1];
      if (!t) print(`用法：${c} <IP 或網域>[:埠]`, 'warn');
      else {
        const r = resolve(t);
        if (!r.ok) { print(linux ? `telnet: could not resolve ${t}/${port}: Name or service not known` : '正在連線到 ' + t + '...無法開啟到主機的連線，在連接埠 ' + port + ': 連線失敗', 'bad'); print('  ↳ ' + r.reason, 'hint'); }
        else {
          const res = transact(st(), dev.id, { proto: 'tcp', dst: r.ip, dport: port });
          app.showTrace(`${dev.name}> ${line}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
          if (res.ok && linux) { print(`Trying ${fmtIp(r.ip)}...`); print(`Connected to ${t}.`, 'ok'); print("Escape character is '^]'.", 'dim'); }
          else if (res.ok) print(`已連線到 ${fmtIp(r.ip)}:${port}（TCP 三向交握完成，畫面一片空白是正常的）`, 'ok');
          else { print(linux ? `telnet: Unable to connect to remote host: ${/拒絕|沒有在/.test(res.reason || '') ? 'Connection refused' : 'Connection timed out'}` : `正在連線到 ${fmtIp(r.ip)}...無法開啟到主機的連線，在連接埠 ${port}: 連線失敗`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
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
    } else if (c) print(linux ? `${cmd}: command not found（輸入 help 查看可用指令）` : `'${cmd}' 不是內部或外部命令。輸入 help 查看可用指令。`, 'warn');
    draw();
  };

  /** Linux 的 ip addr / ip route（Docker 主機多了 docker0 與每個容器的 veth） */
  function linuxIp(argv) {
    const sub = argv[0] || '';
    if (sub === 'link' && argv[1] === 'set') {
      // ip link set eth0 mtu 9000
      const i = dev.ifaces.find((x) => x.label === argv[2] || x.id === argv[2]);
      const k = argv.indexOf('mtu'), v = k > 0 ? +argv[k + 1] : NaN;
      if (!i) { print(`Cannot find device "${argv[2] || ''}"`, 'bad'); return; }
      if (k < 0) { print('用法：sudo ip link set <介面> mtu <68-9000>', 'warn'); return; }
      if (!sudo) { print('RTNETLINK answers: Operation not permitted', 'bad'); print('  ↳ 改網卡的設定要 root 權限：前面加 sudo', 'hint'); return; }
      if (!(v >= 68 && v <= (jumboCapable(dev) && i.bind.t !== 'wlan' ? 9000 : 1500))) { print('Error: mtu greater than device maximum.', 'bad'); return; }
      if (v === 1500) delete i.mtu; else i.mtu = v;
      ctx.commit(true);
      return;
    }
    const ctrs = dev.docker ? dev.docker.containers.filter((x) => x.state === 'running') : [];
    const bc = (ip, bits) => fmtIp((ip | (bits >= 32 ? 0 : 0xffffffff >>> bits)) >>> 0);
    if (/^r/.test(sub)) {
      for (const i of dev.ifaces) if (i.rt && i.rt.ip != null && i.rt.gw != null) print(`default via ${fmtIp(i.rt.gw)} dev ${i.label} proto ${i.mode === 'dhcp' ? 'dhcp' : 'static'}`, 'pre');
      for (const i of dev.ifaces) if (i.rt && i.rt.ip != null) print(`${fmtIp((i.rt.ip & (i.rt.bits ? 0xffffffff << (32 - i.rt.bits) : 0)) >>> 0)}/${i.rt.bits} dev ${i.label} proto kernel scope link src ${fmtIp(i.rt.ip)}`, 'pre');
      if (dev.docker) print(`172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1${ctrs.length ? '' : ' linkdown'}`, 'pre');
      return;
    }
    if (sub && !/^a/.test(sub) && sub !== 'link') { print(`Object "${sub}" is unknown, try "ip help".`, 'bad'); return; }
    let n = 1;
    print('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000', 'pre');
    print('    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00', 'pre');
    if (sub !== 'link') print('    inet 127.0.0.1/8 scope host lo', 'pre');
    for (const i of dev.ifaces) {
      const rt = i.rt || {}, up = !!rt.link;
      print(`${++n}: ${i.label}: <BROADCAST,MULTICAST${up ? ',UP,LOWER_UP' : ',UP'}> mtu ${ipMtu(st(), dev, i)} qdisc fq_codel state ${up ? 'UP' : 'DOWN'} group default qlen 1000`, up ? 'pre' : 'warn');
      print(`    link/ether ${String(rt.mac || '').toLowerCase()} brd ff:ff:ff:ff:ff:ff`, 'pre');
      if (sub !== 'link' && rt.ip != null) print(`    inet ${fmtIp(rt.ip)}/${rt.bits} brd ${bc(rt.ip, rt.bits)} scope global ${i.mode === 'dhcp' ? 'dynamic ' : ''}${i.label}`, 'pre');
    }
    if (dev.docker) {
      print(`${++n}: docker0: <BROADCAST,MULTICAST,UP${ctrs.length ? ',LOWER_UP' : ''}> mtu 1500 qdisc noqueue state ${ctrs.length ? 'UP' : 'DOWN'} group default`, 'pre');
      print('    link/ether 02:42:5e:9a:1c:07 brd ff:ff:ff:ff:ff:ff', 'pre');
      if (sub !== 'link') print('    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0', 'pre');
      for (const x of ctrs) {
        print(`${++n}: veth${x.id.slice(1, 8)}@if${2 * n}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master docker0 state UP group default`, 'pre');
        print(`    link/ether ${x.id.slice(0, 2)}:${x.id.slice(2, 4)}:${x.id.slice(4, 6)}:1e:0b:${x.ip.split('.')[3].padStart(2, '0').slice(-2)} brd ff:ff:ff:ff:ff:ff`, 'pre');
      }
      print('（容器的 172.17.0.x 只存在主機裡的 docker0 橋接網路：每個容器用一條 veth 接上去。外面要連，靠的是發佈的連接埠，docker ps 的 PORTS 欄）', 'hint');
    }
  }

  /** curl：HTTP 會跟著 301 轉到 HTTPS（加 -L）、HTTPS 會驗證憑證（-k 略過）、-I 只看標頭、-v 看 TLS 的細節 */
  function webCurl(args) {
    const flags = new Set(args.filter((a) => a.startsWith('-')).flatMap((a) => (a.startsWith('--') ? [a] : a.slice(1).split('').map((x) => '-' + x))));
    const k = flags.has('-k') || flags.has('--insecure'), head = flags.has('-I') || flags.has('--head'), verbose = flags.has('-v') || flags.has('--verbose'), follow = flags.has('-L') || flags.has('--location');
    const url = args.find((a) => !a.startsWith('-'));
    if (!url) { print('用法：curl [-k] [-I] [-v] [-L] http(s)://<主機>[:埠]/', 'warn'); return; }
    const one = (u, hop) => {
      const https = /^https:\/\//i.test(u); // 和真的 curl 一樣：沒寫 https:// 就是 HTTP
      let host = u.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''), port = https ? 443 : 80;
      const m = host.match(/^(.*):(\d+)$/);
      if (m) { host = m[1]; port = +m[2]; }
      // Docker 主機自己連自己：看發佈的連接埠
      if (/^(localhost|127\.0\.0\.1)$/i.test(host)) {
        const dk = dev.docker ? dockerDeliver(dev, { proto: 'tcp', dport: port, src: 0x7f000001 }, true) : null;
        if (dk && dk.ok) { print('HTTP/1.1 200 OK', 'ok'); print(`Server: ${dk.ctr.image.split(':')[0] === 'nginx' ? 'nginx/1.27.3' : dk.ctr.image}`, 'pre'); print(`（${dk.text}）`, 'hint'); }
        else if (dk && dk.reset) { print('curl: (56) Recv failure: Connection reset by peer', 'bad'); print('  ↳ ' + dk.reason, 'hint'); }
        else if (dk) { print(`curl: (7) Failed to connect to ${host} port ${port}: Connection refused`, 'bad'); print('  ↳ ' + dk.reason, 'hint'); }
        else print(`curl: (7) Failed to connect to ${host} port ${port}: Connection refused`, 'bad');
        return;
      }
      let r, res;
      if (parseIp(host) == null && st().v6) {
        // 雙協定：先試 IPv6，連不上就改用 IPv4（Happy Eyeballs）
        const ds = dualStack(st(), dev.id, host, { proto: 'tcp', dport: port, happy: true });
        if (!ds.res) { print(`curl: (6) Could not resolve host: ${host}`, 'bad'); print('  ↳ ' + ds.reason, 'hint'); app.showTrace(`${dev.name}> curl ${u}`, ds.log, ds.hops, ds); return; }
        res = ds.res;
        r = { ip: ds.family === 4 ? ds.ip : null, ip6: ds.family === 6 ? ds.ip6 : null };
        app.showTrace(`${dev.name}> curl ${u}`, ds.log, ds.hops, res);
        if (ds.fallback && verbose) print(`*   Trying [${fmtIp6(ds.ip6)}]:${port}...`, 'dim'), print('* Happy Eyeballs timeout，改試 IPv4', 'dim');
        if (ds.fallback) print(`（Happy Eyeballs：先試 IPv6 [${fmtIp6(ds.ip6)}] 沒有回應：${ds.fallback}。250 毫秒後改用 IPv4 才連上，所以感覺「卡一下」）`, 'hint');
      } else {
        r = resolve(host);
        if (!r.ok) { print(`curl: (6) Could not resolve host: ${host}`, 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
        res = transact(st(), dev.id, { proto: 'tcp', dst: r.ip, dport: port });
        app.showTrace(`${dev.name}> curl ${u}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
      }
      const shown = r.ip6 != null ? fmtIp6(r.ip6) : fmtIp(r.ip);
      if (!res.ok) {
        const reset = /連線被重設/.test(res.reason || ''), refused = /拒絕|沒有在/.test(res.reason || '');
        print(reset ? 'curl: (56) Recv failure: Connection reset by peer' : `curl: (${refused ? 7 : 28}) ${refused ? `Failed to connect to ${host} port ${port}: Connection refused` : `Failed to connect to ${host} port ${port} after 21032 ms: Timed out`}`, 'bad');
        print('  ↳ ' + res.reason, 'hint');
        return;
      }
      const srv = st().devices[res.responder], web = (srv && srv.web) || {};
      if (verbose) print(`*   Trying ${r.ip6 != null ? `[${shown}]` : shown}:${port}...`, 'dim'), print(`* Connected to ${host} (${shown}) port ${port}`, 'dim');
      // 協定和連接埠對不上：明文的 HTTP 送到 443、TLS 送到 80
      if (!https && port === 443) { print('HTTP/1.1 400 Bad Request', 'warn'); print('<center>The plain HTTP request was sent to HTTPS port</center>', 'pre'); print('  ↳ 443 是 HTTPS：網址要寫 https://', 'hint'); return; }
      if (https && port === 80) { print('curl: (35) OpenSSL/3.0.13: error:0A00010B:SSL routines::wrong version number', 'bad'); print('  ↳ 80 是明文的 HTTP：要用 https:// 就連 443，或把網址改成 http://', 'hint'); return; }
      if (https) {
        const t = tlsCheck(st(), dev, srv, host);
        if (verbose && t.cert) {
          print('* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384', 'dim');
          print('* Server certificate:', 'dim');
          print(`*  subject: CN=${t.cert.cn}`, 'dim');
          print(`*  start date: ${fmtDate(t.cert.from)}`, 'dim');
          print(`*  expire date: ${fmtDate(t.cert.to)}`, 'dim');
          print(`*  subjectAltName: ${(t.cert.san || [t.cert.cn]).map((n) => 'DNS:' + n).join(', ')}`, 'dim');
          print(`*  issuer: CN=${certSelf(t.cert) ? t.cert.cn : t.cert.issuer}`, 'dim');
        }
        if (!t.ok && !k) {
          print(`curl: (${t.code}) ${t.msg}`, 'bad');
          if (t.code === 60) print('More details here: https://curl.se/docs/sslcerts.html', 'dim');
          print('  ↳ ' + t.why, 'hint');
          return;
        }
        if (!t.ok) print(`（-k：略過憑證檢查。真正的問題還在：${t.why}）`, 'warn');
      } else if (web.redirect && hop < 3) {
        print('HTTP/1.1 301 Moved Permanently', 'ok');
        print(`Location: https://${host}/`, 'pre');
        if (follow) { print(''); one(`https://${host}/`, hop + 1); } else print('（網站把 HTTP 轉到 HTTPS：加 -L 會跟著轉過去）', 'hint');
        return;
      }
      print('HTTP/1.1 200 OK', 'ok');
      if (head || verbose) { print(`Server: ${srv.kind === 'internet' ? 'ECAcc (sec/96EE)' : web.server || 'nginx'}`, 'pre'); print('Content-Type: text/html; charset=UTF-8', 'pre'); if (https) print('Strict-Transport-Security: max-age=31536000', 'pre'); }
      if (!head) print(`<title>${srv.kind === 'internet' ? 'Example Domain' : web.title || srv.name}</title>`, 'pre');
    };
    one(url, 0);
  }

  input.addEventListener('keydown', (e) => {
    if (escLine(e, input)) return;
    const r = remote();
    if (e.key === 'Enter') {
      const secret = r && (r.stage === 'pass' || !!(r.sess && r.sess.pending && r.sess.pending.secret));
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
    ownKeys(e);
  });
  // 一次貼上好幾行（例如 SSH 進設備之後貼整份設定）：一行一行送出
  input.addEventListener('paste', async (e) => {
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!/\n/.test(t) || (remote() && remote().stage === 'pass')) return;
    e.preventDefault();
    const lines = t.replace(/\r/g, '').split('\n');
    const last = lines.pop();
    lines[0] = input.value + lines[0];
    input.value = '';
    for (const l of lines) { if (!l.trim()) continue; hist.push(l.trim()); await run(l.trim()); }
    hi = hist.length;
    input.value = last;
  });
  const promptEl = h('span', { class: 'prompt', text: PS });
  const term = h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, promptEl, input));
  // 提示字元跟著目前的狀態變：本機、等待輸入密碼，或已經登入對方的命令列
  drawPrompt = () => {
    const r = remote();
    const sec = !!(r && r.sess && r.sess.pending && r.sess.pending.secret);
    promptEl.textContent = !r ? ((app.tfAsk || {})[dev.id] ? '  Enter a value:' : PS) : r.stage === 'key' ? '(yes/no)?' : r.stage === 'user' ? 'Username:' : r.stage === 'pass' || sec ? 'Password:' : r.sess.prompt();
    input.type = r && (r.stage === 'pass' || sec) ? 'password' : 'text';
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
  const chips = dev.docker ? ['docker ps -a', 'docker port web', 'curl http://localhost:8080', 'ip addr', 'help'] : dev.tf ? ['ls', 'cat main.tf', 'terraform init', 'terraform plan', 'terraform apply', 'help'] : dev.git ? ['git log --oneline', 'git show HEAD', './backup.sh', 'git status', 'git diff', 'help'] : linux ? ['ls', 'cat inventory.ini', `ansible-playbook -i inventory.ini ${dev.ansible.file}`, `ansible-playbook -i inventory.ini ${dev.ansible.file} --check -v`, 'help']
    : ['ipconfig', 'ping 8.8.8.8', 'tracert 8.8.8.8', 'nslookup www.example.com', 'arp -a', 'help'];
  body.append(term, h('div', { class: 'chips' }, chips.map((x) =>
    h('button', { class: 'chip btnchip', type: 'button', title: x, onclick: () => { hist.push(x); hi = hist.length; run(x); } }, h('span', { class: 'ell', text: x })))));
  draw();
  setTimeout(() => input.focus(), 30);
}
