// 主機上的終端機（Linux 的 bash）：ip / ping / traceroute / nslookup / dig / curl …
import { h, ownKeys, escLine } from './dom.js';
import { fmtIp, parseIp, maskOf, parseMask, sameNet } from '../engine/ip.js';
import { transact, resolveName, dualStack, dnsQuery, dhcpTrace, arpRows, clearArp, dhcpRelease, dhcpRenew, fmtDur, throughput, unreachOf } from '../engine/sim.js';
import { rttSamples, pingStats, linuxMs, ispRows } from '../engine/latency.js';
import { linkInfo } from '../engine/model.js';
import { lookupRoute } from '../engine/sim.js';
import { redirectRows, redirectRoute, clearRedirects } from '../engine/redirect.js';
import { cacheRows, cacheFlush, ptrName } from '../engine/dns.js';
import { plainStamp } from '../engine/ops.js';
import { remoteOpen, remoteLogin, remoteSend, remoteAlive, remoteClose, remoteBusy } from '../engine/remote.js';
import { iosSession } from '../engine/ios.js';
import { fortiSession } from '../engine/fortios.js';
import { iosRun, IOS_CMDS, consoleFollow } from './cli.js';
import { counters, onBulk } from '../engine/wire.js';
import { fortiRun } from './forticli.js';
import { transact6, dhcp6Trace, duidOf, iaidOf } from '../engine/sim6.js';
import { parseIp6, fmtIp6, net6 } from '../engine/ip6.js';
import { isApiCurl, curlApi, ansibleCmd, fileCmd, netconfCmd, terraformCmd, tfAnswer, tfFileCmd, gitCmd, backupCmd, gitFileCmd } from './term-auto.js';
import { dockerCmd } from './term-docker.js';
import { dockerDeliver } from '../engine/docker.js';
import { tlsCheck, fmtDate, certSelf, CORP_CA, PUBLIC_CAS, acmeRenew, certDaysLeft } from '../engine/web.js';
import { httpStatus } from '../engine/ltm.js';
import { FG_CATS } from '../engine/utm.js';
import { ipMtu, jumboCapable } from '../engine/mtu.js';

// ── 電腦與伺服器都是 Linux（終端機是 bash）──
// Windows 的指令打進來：照 bash 的說法「command not found」，再告訴使用者 Linux 上對應的是什麼
const WIN_CMD = {
  ipconfig: 'ip addr 看位址與 MAC、ip route 看閘道、resolvectl status 看 DNS，或 nmcli device show 一次看完（/renew → sudo dhclient -v eth0；/displaydns → resolvectl show-cache；/flushdns → resolvectl flush-caches）',
  tracert: 'traceroute <IP 或網域>',
  pathping: 'traceroute <IP 或網域>',
  netsh: 'ip link（MTU）、ip route get <位址>（實際走哪一條）、ip maddr（加入的群播群組）',
  w32tm: 'timedatectl 看時間同步；sudo timedatectl set-ntp true 打開自動校時',
  certutil: 'sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/ 再 sudo update-ca-certificates',
  cls: 'clear',
  getmac: 'ip link',
  ver: 'uname -a 或 cat /etc/os-release',
  dir: 'ls',
};
// net-tools（ifconfig、arp、netstat、route）新的發行版預設沒有裝，已經由 iproute2 的 ip 指令取代
const NET_TOOLS = { ifconfig: 'ip addr', arp: 'ip neigh（清掉：sudo ip neigh flush all）', netstat: 'ip -s link（網卡的計數器）', route: 'ip route' };
/** date 的格式：Mon Jan  5 09:00:12 CST 2026 */
const linuxDate = (t) => `${t.day} ${t.mon} ${String(t.dd).padStart(2)} ${t.time} CST ${t.yyyy}`;

const HELP = [
  '可用指令（這台是 Linux）：',
  '  ip addr                 網路介面的位址與 MAC（ip -br addr 是簡短版、ip -6 addr 只看 IPv6）',
  '  ip route                路由表與預設閘道（ip route get <位址> 看實際走哪一條；收到 ICMP Redirect 的標 <redirected>）',
  '  ip neigh                鄰居表，也就是 ARP 快取：IP 對應到哪個 MAC（sudo ip neigh flush all 清掉）',
  '  ip -s link              網卡收送了多少封包、有沒有錯誤（sudo ip link set eth0 mtu 9000 改 MTU；ip maddr 看加入的群播群組）',
  '  ethtool eth0            速率、雙工、有沒有連線（ethtool -S eth0 看錯誤的計數器）',
  '  nmcli device show       每張網卡的位址、閘道、DNS、DHCP 伺服器與租約一次看完',
  '  nmcli connection show [eth0]   連線設定；sudo nmcli connection modify eth0 ipv4.method manual ipv4.addresses <IP/長度> ipv4.gateway <閘道> → sudo nmcli connection up eth0',
  '  sudo dhclient -v eth0   重新向 DHCP 伺服器要一次 IP（看得到 DORA 四個步驟）；sudo dhclient -r eth0 歸還；加 -6 是 DHCPv6',
  '  ping <IP 或網域>        測試連線（會在場景中播放封包動畫）。-c 次數、-4 / -6 指定 IPv4 或 IPv6',
  '  ping -M do -s 1472 <IP> 送 1472 位元組的資料、設 DF 不可分段：找出路徑上的 MTU（1472 + 28 = 1500；Jumbo Frame 是 8972）',
  '  traceroute <IP 或網域>  顯示封包經過的每一台路由器',
  '  nslookup <網域>         直接向 DNS 伺服器查詢，不經過本機的快取（-type=mx 查郵件伺服器、-type=aaaa 查 IPv6 位址、nslookup <IP> 反查）',
  '  dig <網域> [mx|aaaa]    同上，看得到 TTL 與旗標（dig +short 只印答案、dig -x <IP> 反查）',
  '  resolvectl status       這台用哪幾台 DNS 伺服器（resolvectl show-cache 看快取、resolvectl flush-caches 清掉、resolvectl query <網域> 經過快取查詢）',
  '  curl http(s)://<主機>[:埠]   開網頁：HTTPS 會驗證憑證（-k 略過、-v 看憑證、-I 只看標頭、-L 跟著轉址）',
  '  nc -zv <IP> <埠>        測試某個 TCP 連接埠通不通（telnet <IP> <埠> 也可以）',
  '  ssh <帳號>@<IP>         登入網路設備的命令列（加密）。輸入 exit 登出；telnet <IP> 是明文的，帳號密碼在線路上看得到',
  '  iperf3 -c <IP>          量測到另一台主機的實際傳輸速率（跑 10 秒）',
  '  date / timedatectl      這台電腦的時間、NTP 同步的狀態（sudo timedatectl set-ntp true 打開自動校時）',
  '  sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates   安裝公司的根憑證（ls /etc/ssl/certs 看信任哪些）',
  '  clear                   清除畫面',
];

export function buildTerminal(ctx, body) {
  const { app, dev } = ctx;
  // 電腦與伺服器都是 Linux：提示字元是「使用者@主機名稱:~$」
  const HOST = dev.git ? 'backup' : dev.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || (dev.ansible ? 'ansible' : dev.id.replace(/[^\w-]+/g, '-').toLowerCase());
  const USER = dev.git || dev.ansible || dev.tf ? 'netops' : dev.docker ? 'admin' : 'user';
  const PS = dev.git ? 'netops@backup:~/network-configs$' : `${USER}@${HOST}:~$`;
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

  const run = async (line, chained) => {
    if (remote()) { remoteInput(line); draw(); return; }
    // terraform apply 在等 yes / no
    if (dev.tf && (app.tfAsk || {})[dev.id]) { tfAnswer(app, dev, line, print); ctx.commit(false); draw(); return; }
    if (!chained) print(PS + ' ' + line, 'cmd');
    // a && b：前一個做完再做下一個
    if (!chained && /\s&&\s/.test(line)) { for (const part of line.split(/\s&&\s/)) if (part.trim()) await run(part.trim(), true); return; }
    const parts = line.trim().split(/\s+/);
    const sudo = parts[0] === 'sudo' && parts.length > 1;
    if (sudo) parts.shift();
    const [cmd, ...args] = parts;
    const c = (cmd || '').toLowerCase();
    if (c === 'help' || c === '?') {
      HELP.forEach((x) => print(x, 'dim'));
      if (dev.web && dev.web.acme) print('  sudo certbot certificates / sudo certbot renew [--dry-run]   Let\'s Encrypt 的憑證與續約（HTTP-01 要從網際網路連得到 TCP 80）', 'dim');
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
    else if (c === 'clear') logs.length = 0;
    else if (WIN_CMD[c]) {
      print(`${cmd}: command not found`, 'warn');
      print('  ↳ 那是 Windows 的指令。這台是 Linux：' + WIN_CMD[c], 'hint');
    } else if (NET_TOOLS[c]) {
      // Ubuntu 的原話
      print(`Command '${cmd}' not found, but can be installed with:`, 'warn');
      print('sudo apt install net-tools', 'warn');
      print(`  ↳ ${cmd} 屬於舊的 net-tools，新的 Linux 預設沒有裝：改用 ${NET_TOOLS[c]}`, 'hint');
    }
    else if (c === 'date') {
      const t = plainStamp(st(), dev), off = dev.clock && !dev.clock.sync;
      print(linuxDate(t), off ? 'warn' : '');
      if (off) print('  ↳ 這台電腦的自動校時是關的（timedatectl 看得到）：時間可能不準，HTTPS 憑證的有效期間也是用這個時間判斷。sudo timedatectl set-ntp true 打開，或到「網路設定」分頁打開自動校時', 'hint');
    }
    else if (c === 'hostname') print(HOST);
    else if (c === 'whoami') print(sudo ? 'root' : USER);
    else if (c === 'uname') print(args.some((a) => /^-\w*a/.test(a)) ? `Linux ${HOST} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux` : 'Linux');
    else if (c === 'ethtool') ethtool(args);
    else if (c === 'resolvectl' || c === 'systemd-resolve') resolvectl(args, line);
    else if (c === 'dhclient') dhclient(args, sudo, line);
    else if (c === 'update-ca-certificates' || (c === 'cp' && /corp-root-ca|ca-certificates/.test(line)) || (c === 'ls' && /ca-certificates|\/etc\/ssl\/certs/.test(line))) caCmd(c, args, sudo);
    else if (c === 'cat' && /^\/etc\/(resolv\.conf|os-release|hostname)$/.test(args[0] || '')) sysFile(args[0]);
    else if (c === 'systemctl') {
      // 只有時間同步的服務：systemctl status | start | restart | stop systemd-timesyncd
      const unit = (args[1] || '').replace(/\.service$/, ''), off = !!(dev.clock && dev.clock.sync === false);
      if (unit !== 'systemd-timesyncd') print(`Unit ${args[1] || ''}.service could not be found.`, 'bad');
      else if (args[0] === 'status') {
        print(`${off ? '○' : '●'} systemd-timesyncd.service - Network Time Synchronization`, 'pre');
        print(`     Loaded: loaded (/usr/lib/systemd/system/systemd-timesyncd.service; ${off ? 'disabled' : 'enabled'}; preset: enabled)`, 'pre');
        print(`     Active: ${off ? 'inactive (dead)' : 'active (running)'}`, off ? 'warn' : 'ok');
      } else if (['start', 'restart', 'stop'].includes(args[0])) {
        if (!sudo) { print(`Failed to ${args[0]} systemd-timesyncd.service: Interactive authentication required.`, 'bad'); print('  ↳ 啟動或停止服務要 root 權限：前面加 sudo', 'hint'); }
        else { dev.clock = { ...(dev.clock || {}), sync: args[0] !== 'stop' }; ctx.commit(true); }
      } else print('用法：systemctl status systemd-timesyncd、sudo systemctl restart systemd-timesyncd', 'warn');
    }
    else if (c === 'ip') {
      linuxIp(args, sudo);
    } else if (c === 'certbot') {
      // Let's Encrypt 的 certbot：certificates 看憑證、renew [--dry-run] 續約（HTTP-01：CA 要從網際網路連得到這台的 TCP 80）
      const d = app.state.devices[dev.id], a = d.web && d.web.acme;
      if (!sudo) { print('The following error was encountered:', 'bad'); print('[Errno 13] Permission denied: \'/var/log/letsencrypt/.certbot.lock\'', 'bad'); print('  ↳ certbot 要 root 權限：前面加 sudo', 'hint'); }
      else if (!a) print('No certificates found.', 'warn');
      else if (args[0] === 'certificates') {
        const cert = d.web.cert, left = cert ? certDaysLeft(app.state, cert) : -1;
        print('Found the following certs:', 'pre');
        print(`  Certificate Name: ${a.domain}`, 'pre');
        print(`    Domains: ${a.domain}`, 'pre');
        print(`    Expiry Date: ${cert ? fmtDate(cert.to) : '-'} (${left >= 0 ? 'VALID: ' + left + ' days' : 'INVALID: EXPIRED'})`, left >= 0 ? 'pre' : 'bad');
        print(`    Certificate Path: /etc/letsencrypt/live/${a.domain}/fullchain.pem`, 'pre');
      } else if (args[0] === 'renew') {
        const r = acmeRenew(app.state, d, transact, { dry: args.includes('--dry-run') });
        r.lines.forEach((l) => print(l, r.ok ? (/Congratulations/.test(l) ? 'ok' : 'pre') : /Detail|failed/.test(l) ? 'bad' : 'pre'));
        if (r.ok && !args.includes('--dry-run')) { ctx.commit(false); print('（新的憑證已經放好，nginx 由 deploy hook 重新載入）', 'hint'); }
      } else print('用法：sudo certbot certificates | sudo certbot renew [--dry-run]', 'warn');
    } else if (c === 'nmcli') {
      nmcli(args, sudo);
    } else if (c === 'timedatectl') {
      const off = !!(dev.clock && dev.clock.sync === false);
      if (args[0] === 'set-ntp') {
        if (!sudo) { print('Failed to set ntp: Interactive authentication required.', 'bad'); print('  ↳ 改系統的時間設定要 root 權限：前面加 sudo', 'hint'); }
        else { dev.clock = { ...(dev.clock || {}), sync: /^(true|yes|on|1)$/i.test(args[1] || '') }; ctx.commit(true); }
      } else if (args[0] === 'timesync-status') {
        if (off) { print('Failed to query server: The name org.freedesktop.timesync1 was not provided by any .service files', 'bad'); print('  ↳ 時間同步的服務沒有在跑：sudo timedatectl set-ntp true', 'hint'); }
        else ['       Server: 185.125.190.56 (ntp.ubuntu.com)', 'Poll interval: 34min 8s (min: 32s; max 34min 8s)', '         Leap: normal', '      Version: 4', '      Stratum: 2', '    Precision: 1us (-25)', 'Root distance: 1.220ms (max: 5s)', '       Offset: +412us', '        Delay: 11.874ms', '       Jitter: 1.013ms'].forEach((x) => print(x, 'pre'));
      } else {
        const t = plainStamp(st(), dev);
        [`               Local time: ${t.day} ${t.date} ${t.time} CST`, '                Time zone: Asia/Taipei (CST, +0800)', `System clock synchronized: ${off ? 'no' : 'yes'}`, `              NTP service: ${off ? 'inactive' : 'active'}`, '          RTC in local TZ: no'].forEach((x) => print(x, x.includes(': no') && off ? 'warn' : 'pre'));
        if (off) print('  ↳ NTP 沒有開，時間不會自動校正：sudo timedatectl set-ntp true', 'hint');
      }
    } else if (c === 'ping' || c === 'ping6' || c === 'traceroute' || c === 'traceroute6') {
      pingCmd(c, args, line);
    } else if (c === 'nslookup' || c === 'dig' || c === 'host') {
      dnsTool(c, args, line);
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
        if (res.ok && c === 'telnet') { print(`Trying ${fmtIp6(d6)}...`); print(`Connected to ${fmtIp6(d6)}.`, 'ok'); print("Escape character is '^]'.", 'dim'); }
        else if (res.ok) print('HTTP/1.1 200 OK', 'ok');
        else { print(c === 'telnet' ? 'telnet: Unable to connect to remote host: Connection timed out' : `curl: (28) Failed to connect to ${fmtIp6(d6)} port ${port}: Timed out`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
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
        if (!r.ok) { print(`telnet: could not resolve ${t}/${port}: Name or service not known`, 'bad'); print('  ↳ ' + r.reason, 'hint'); }
        else {
          const res = transact(st(), dev.id, { proto: 'tcp', dst: r.ip, dport: port });
          app.showTrace(`${dev.name}> ${line}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
          if (res.ok) { print(`Trying ${fmtIp(r.ip)}...`); print(`Connected to ${t}.`, 'ok'); print("Escape character is '^]'.", 'dim'); print('  ↳ TCP 三向交握完成：這個埠是通的（之後畫面一片空白是正常的）', 'hint'); }
          else { print(`Trying ${fmtIp(r.ip)}...`); print(`telnet: Unable to connect to remote host: ${/拒絕|沒有在|重設/.test(res.reason || '') ? 'Connection refused' : 'Connection timed out'}`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
        }
      }
    } else if (c === 'nc' || c === 'ncat' || c === 'netcat') {
      const pos = args.filter((x) => !x.startsWith('-')), t = pos[0] || '', port = +pos[1];
      if (!t || !(port >= 1 && port <= 65535)) print('用法：nc -zv <IP 或網域> <埠>（-z 只測連線、不送資料；-v 顯示結果）', 'warn');
      else {
        const r = resolve(t);
        if (!r.ok) { print(`nc: getaddrinfo for host "${t}" port ${port}: Name or service not known`, 'bad'); print('  ↳ ' + r.reason, 'hint'); }
        else {
          const res = transact(st(), dev.id, { proto: 'tcp', dst: r.ip, dport: port });
          app.showTrace(`${dev.name}> ${line}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
          if (res.ok) print(`Connection to ${t} (${fmtIp(r.ip)}) ${port} port [tcp/*] succeeded!`, 'ok');
          else { print(`nc: connect to ${t} (${fmtIp(r.ip)}) port ${port} (tcp) failed: ${/拒絕|沒有在|重設/.test(res.reason || '') ? 'Connection refused' : 'Connection timed out'}`, 'bad'); print('  ↳ ' + res.reason, 'hint'); }
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
          print(`[  5] local ${fmtIp(res.srcIp)} port ${res.sport} connected to ${fmtIp(ip)} port 5201`, 'pre');
          print('[ ID] Interval           Transfer     Bitrate         Retr', 'pre');
          print(`[  5]   0.00-10.00  sec  ${amt(m.mbps).padStart(11)}  ${rate(m.mbps).padEnd(15)} ${String(m.retr).padStart(4)}   sender`, m.retr ? 'bad' : 'ok');
          print(`[  5]   0.00-10.00  sec  ${amt(m.mbps).padStart(11)}  ${rate(m.mbps).padEnd(15)}        receiver`, 'pre');
          print('');
          print(`  ↳ 最慢的一段：${m.where}`, m.retr ? 'hint' : 'dim');
          app.tick(10); // 測試本身跑了 10 秒
        }
      }
    } else if ((c === 'ls' || c === 'pwd') && !dev.git && !dev.tf && !dev.ansible) {
      print(c === 'pwd' ? `/home/${USER}` : 'Desktop  Documents  Downloads  corp-root-ca.crt', 'pre');
    } else if (c) print(`${cmd}: command not found（輸入 help 查看可用指令）`, 'warn');
    draw();
  };

  /**
   * NetworkManager 的 nmcli：nmcli con mod 只改連線設定檔，nmcli con up 才套用到網卡（NM 的連線設定 = 網卡上的 i.nm，還沒套用的）
   * ipv4.addresses 沒寫 /長度 就是 /32（閘道會不在同一個網段）
   */
  function nmcli(argv, su) {
    const maskLen = (m) => parseMask(m || '') ?? 0;
    const st = app.state, d = st.devices[dev.id];
    const nics = d.ifaces.filter((i) => i.bind.t === 'port' || i.bind.t === 'wlan');
    const conOf = (name) => nics.find((i) => i.label === name || i.id === name);
    const prof = (i) => (i.nm ||= { method: i.mode === 'dhcp' ? 'auto' : 'manual', addresses: i.ip && i.mask ? `${i.ip}/${maskLen(i.mask)}` : '', gateway: i.gateway || '', dns: i.dns || '' });
    const [obj = '', verb = '', ...rest] = argv;
    const isObj = (x, full) => x && full.startsWith(x);
    if (isObj(obj, 'device') && verb && isObj(verb, 'show')) {
      const one = rest[0] && conOf(rest[0]);
      if (rest[0] && !one) { print(`Error: Device '${rest[0]}' not found.`, 'bad'); return; }
      const kv = (k, v) => print(`${(k + ':').padEnd(40)}${v}`, 'pre');
      (one ? [one] : nics).forEach((i, n) => {
        const rt = i.rt || {}, v6 = rt.v6 && rt.v6.ll != null ? rt.v6 : null, up = !!rt.link;
        if (n) print('');
        kv('GENERAL.DEVICE', i.id);
        kv('GENERAL.TYPE', i.bind.t === 'wlan' ? 'wifi' : 'ethernet');
        kv('GENERAL.HWADDR', String(rt.mac || '').toUpperCase());
        kv('GENERAL.MTU', String(ipMtu(st, d, i)));
        kv('GENERAL.STATE', !up ? '20 (unavailable)' : rt.ip != null && rt.src !== 'apipa' ? '100 (connected)' : '70 (connecting (getting IP configuration))');
        kv('GENERAL.CONNECTION', up ? i.id : '--');
        if (i.bind.t !== 'wlan') kv('WIRED-PROPERTIES.CARRIER', up ? 'on' : 'off');
        if (rt.ip != null) kv('IP4.ADDRESS[1]', `${fmtIp(rt.ip)}/${rt.bits}`);
        kv('IP4.GATEWAY', rt.gw != null ? fmtIp(rt.gw) : '--');
        (rt.dns || []).forEach((x, k) => kv(`IP4.DNS[${k + 1}]`, fmtIp(x)));
        if (rt.src === 'dhcp') {
          const sd = st.devices[rt.server], near = sd && (sd.ifaces.find((x) => x.rt && x.rt.ip != null && x.rt.bits && sameNet(x.rt.ip, rt.ip, x.rt.bits)) || sd.ifaces.find((x) => x.rt && x.rt.ip != null));
          if (near) kv('DHCP4.OPTION[1]', `dhcp_server_identifier = ${fmtIp(near.rt.ip)}`);
          if (rt.exp != null) kv('DHCP4.OPTION[2]', `dhcp_lease_time_left = ${Math.max(0, Math.ceil(rt.exp - st.clock))}`);
          kv('DHCP4.OPTION[3]', `ip_address = ${fmtIp(rt.ip)}`);
        }
        if (v6) {
          [...v6.addrs.map((a) => `${fmtIp6(a.ip)}/${a.bits}`), `${fmtIp6(v6.ll)}/64`].forEach((x, k) => kv(`IP6.ADDRESS[${k + 1}]`, x));
          kv('IP6.GATEWAY', v6.gw != null ? fmtIp6(v6.gw) : '--');
          (v6.dns || []).forEach((x, k) => kv(`IP6.DNS[${k + 1}]`, fmtIp6(x)));
          if (v6.dhcp && v6.dhcp.ok) { kv('DHCP6.OPTION[1]', `dhcp6_client_id = ${duidOf(i)}`); kv('DHCP6.OPTION[2]', `iaid = ${iaidOf(i)}`); }
        }
        if (rt.src === 'apipa') print(`  ↳ ${i.id} 向 DHCP 要不到位址，只有自己編的 169.254.x.x（IPv4 link-local）${rt.note ? '：' + rt.note : ''}`, 'hint');
        else if (up && rt.ip == null && rt.note) print(`  ↳ ${i.id} 沒有 IPv4 位址：${rt.note}`, 'hint');
        if (rt.held) print(`  ↳ ${i.id} 目前連不到 DHCP 伺服器，先繼續用還沒到期的租約`, 'hint');
      });
      return;
    }
    if (isObj(obj, 'device')) {
      print('DEVICE  TYPE      STATE         CONNECTION', 'pre');
      for (const i of nics) print(`${i.id.padEnd(8)}${(i.bind.t === 'wlan' ? 'wifi' : 'ethernet').padEnd(10)}${(!i.rt.link ? 'unavailable' : i.rt.ip != null ? 'connected' : 'connecting').padEnd(14)}${i.rt.link ? i.id : '--'}`, 'pre');
      print('lo      loopback  connected (externally)  lo', 'pre');
      return;
    }
    if (!isObj(obj, 'connection')) { print('用法：nmcli device status | nmcli device show [介面] | nmcli connection show [名稱] | sudo nmcli connection modify <名稱> ipv4.method manual ipv4.addresses <IP/長度> ipv4.gateway <閘道> ipv4.dns <DNS> | sudo nmcli connection up <名稱>', 'warn'); return; }
    if (!verb || isObj(verb, 'show')) {
      const i = rest[0] && conOf(rest[0]);
      if (rest[0] && !i) { print(`Error: ${rest[0]} - no such connection profile.`, 'bad'); return; }
      if (!i) {
        print('NAME  UUID                                  TYPE      DEVICE', 'pre');
        for (const x of nics) print(`${x.id.padEnd(6)}${('5fb06bd0-0bb0-7ffb-45f1-' + (x.rt.mac || '000000000000').replace(/:/g, '')).slice(0, 36).padEnd(38)}${(x.bind.t === 'wlan' ? 'wifi' : 'ethernet').padEnd(10)}${x.rt.link ? x.id : '--'}`, 'pre');
        return;
      }
      const p = prof(i);
      print(`connection.id:                          ${i.id}`, 'pre');
      print(`ipv4.method:                            ${p.method}`, 'pre');
      print(`ipv4.addresses:                         ${p.addresses || '--'}`, 'pre');
      print(`ipv4.gateway:                           ${p.gateway || '--'}`, 'pre');
      print(`ipv4.dns:                               ${p.dns || '--'}`, 'pre');
      if (i.rt.ip != null) { print(`IP4.ADDRESS[1]:                         ${fmtIp(i.rt.ip)}/${i.rt.bits}`, 'pre'); print(`IP4.GATEWAY:                            ${i.rt.gw != null ? fmtIp(i.rt.gw) : '--'}`, 'pre'); }
      const pend = (p.method === 'manual') !== (i.mode === 'static') || (p.method === 'manual' && (p.addresses !== `${i.ip}/${maskLen(i.mask)}` || (p.gateway || '') !== (i.gateway || '')));
      if (pend) print('  ↳ 設定檔改過，還沒套用到網卡：sudo nmcli connection up ' + i.id, 'hint');
      return;
    }
    if (isObj(verb, 'modify')) {
      const i = conOf(rest[0] || '');
      if (!i) { print(`Error: unknown connection '${rest[0] || ''}'.`, 'bad'); return; }
      if (!su) { print('Error: Failed to modify connection \'' + i.id + '\': Insufficient privileges', 'bad'); print('  ↳ 改網路設定要 root 權限：前面加 sudo', 'hint'); return; }
      const p = { ...prof(i) }, kv = rest.slice(1);
      if (!kv.length || kv.length % 2) { print('Error: <setting>.<property> argument is missing.', 'bad'); return; }
      for (let k = 0; k < kv.length; k += 2) {
        const key = kv[k].replace(/^\+/, ''), v = kv[k + 1];
        if (key === 'ipv4.method') { if (!['auto', 'manual'].includes(v)) { print(`Error: failed to modify ipv4.method: '${v}' not among [auto, manual, link-local, shared, disabled].`, 'bad'); return; } p.method = v; }
        else if (key === 'ipv4.addresses') { const [ip, len] = v.split('/'); if (parseIp(ip) == null || (len != null && !(+len >= 0 && +len <= 32))) { print(`Error: failed to modify ipv4.addresses: invalid IP address: '${v}'.`, 'bad'); return; } p.addresses = len == null ? ip + '/32' : v; }
        else if (key === 'ipv4.gateway') { if (v !== '' && parseIp(v) == null) { print(`Error: failed to modify ipv4.gateway: invalid IP address '${v}'.`, 'bad'); return; } p.gateway = v; }
        else if (key === 'ipv4.dns') p.dns = v;
        else { print(`Error: invalid or not allowed setting '${key}'.`, 'bad'); return; }
      }
      if (p.method === 'manual' && !p.addresses) { print(`Error: Failed to modify connection '${i.id}': ipv4.addresses: this property cannot be empty for 'method=manual'`, 'bad'); return; }
      i.nm = p;
      if (/\/32$/.test(p.addresses) && !kv.some((x) => /\/\d+$/.test(x))) print('  ↳ ipv4.addresses 沒寫 /長度，NetworkManager 當成 /32（只有自己一個位址，閘道會不在同一個網段）', 'hint');
      print('  ↳ 只改了連線設定檔：要 sudo nmcli connection up ' + i.id + ' 才會套用到網卡', 'hint');
      ctx.commit(false);
      return;
    }
    if (isObj(verb, 'up')) {
      const i = conOf(rest[0] || '');
      if (!i) { print(`Error: unknown connection '${rest[0] || ''}'.`, 'bad'); return; }
      if (!su) { print('Error: Connection activation failed: Insufficient privileges', 'bad'); print('  ↳ 前面加 sudo', 'hint'); return; }
      const p = prof(i);
      if (p.method === 'auto') Object.assign(i, { mode: 'dhcp' });
      else { const [ip, len] = p.addresses.split('/'); Object.assign(i, { mode: 'static', ip, mask: fmtIp(maskOf(+len)), gateway: p.gateway || '', dns: p.dns || '' }); }
      ctx.commit(false);
      print('Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/' + (2 + nics.indexOf(i)) + ')', 'ok');
      return;
    }
    print(`Error: argument '${verb}' not understood. Try passing --help instead.`, 'bad');
  }

  // ───────────────────── Linux 的網路指令 ─────────────────────
  /** 網卡的名稱是 eth0、wlan0（畫面上的中文名稱也認得） */
  const ifOf = (name) => dev.ifaces.find((x) => x.id === name || x.label === name);
  /** DHCP 伺服器的位址（伺服器在別的網段、經過 Relay 時，是伺服器自己的位址，不是轉送的那台路由器） */
  const dhcpServerIp = (rt) => {
    const sd = rt && rt.src === 'dhcp' ? st().devices[rt.server] : null;
    if (!sd) return null;
    const near = sd.ifaces.find((x) => x.rt && x.rt.ip != null && x.rt.bits && sameNet(x.rt.ip, rt.ip, x.rt.bits)) || sd.ifaces.find((x) => x.rt && x.rt.ip != null);
    return near ? near.rt.ip : null;
  };
  const needRoot = (what) => { print('RTNETLINK answers: Operation not permitted', 'bad'); print(`  ↳ ${what}要 root 權限：前面加 sudo`, 'hint'); };
  /** 這台的 DNS 伺服器（/etc/resolv.conf 的 nameserver） */
  const dnsOf = (i) => [...(i.rt && i.rt.v6 && i.rt.v6.dns ? i.rt.v6.dns.map(fmtIp6) : []), ...((i.rt && i.rt.dns) || []).map(fmtIp)];

  /**
   * iproute2 的 ip：addr、link、route、neigh、maddr（Docker 主機多了 docker0 與每個容器的 veth）。
   * 全域的選項寫在物件前面：-br 簡短、-s 統計、-4 / -6 只看一種位址
   */
  function linuxIp(argv0, sudo) {
    const flags = argv0.filter((a) => /^-/.test(a)), argv = argv0.filter((a) => !/^-/.test(a));
    const brief = flags.some((f) => /^-br/.test(f)), stats = flags.some((f) => /^-s/.test(f)), only6 = flags.includes('-6'), only4 = flags.includes('-4');
    const sub = argv[0] || '', is = (full) => !!sub && full.startsWith(sub);
    if (!sub) {
      print('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }', 'warn');
      print('where  OBJECT := { address | link | route | neigh | maddress }', 'warn');
      print('       OPTIONS := { -4 | -6 | -s[tatistics] | -br[ief] }', 'warn');
      return;
    }
    if (is('link') && argv[1] === 'set') {
      // ip link set eth0 mtu 9000
      const name = argv[2] === 'dev' ? argv[3] : argv[2], i = ifOf(name || '');
      const k = argv.indexOf('mtu'), v = k > 0 ? +argv[k + 1] : NaN;
      if (!i) { print(`Cannot find device "${name || ''}"`, 'bad'); return; }
      if (k < 0) { print('用法：sudo ip link set <介面> mtu <68-9000>', 'warn'); return; }
      if (!sudo) { needRoot('改網卡的設定'); return; }
      if (!(v >= 68 && v <= (jumboCapable(dev) && i.bind.t !== 'wlan' ? 9000 : 1500))) { print('Error: mtu greater than device maximum.', 'bad'); return; }
      if (v === 1500) delete i.mtu; else i.mtu = v;
      ctx.commit(true);
      return;
    }
    if (is('route') && argv[1] === 'get' && argv[2]) {
      // ip route get <位址>：實際會走哪一條（收到 ICMP Redirect 的目的地標 <redirected>）
      const ip = parseIp(argv[2]);
      if (ip == null) { print(`Error: any valid prefix is expected rather than "${argv[2]}".`, 'bad'); return; }
      const rd = redirectRoute(st(), dev, ip), r = rd || lookupRoute(dev, ip);
      if (!r) { print('RTNETLINK answers: Network is unreachable', 'bad'); return; }
      const e = rd && redirectRows(st(), dev).find((x) => x.dst === ip);
      print(`${fmtIp(ip)} ${r.via != null ? `via ${fmtIp(r.via)} ` : ''}dev ${r.iface.id} src ${fmtIp(r.iface.rt.ip)} uid 1000`, 'pre');
      print(`    cache${e ? ` <redirected> expires ${e.left}sec` : ''}`, 'pre');
      if (e) print(`  ↳ ${st().devices[e.by] ? st().devices[e.by].name : '路由器'} 用 ICMP Redirect 告訴這台「往 ${fmtIp(ip)} 直接找 ${fmtIp(e.gw)} 比較近」，大約 ${Math.ceil(e.left / 60)} 分鐘後過期（sudo ip route flush cache 清掉）`, 'hint');
      return;
    }
    if (is('route') && argv[1] === 'flush' && argv[2] === 'cache') {
      if (!sudo) { print('Failed to send flush request: Operation not permitted', 'bad'); return; }
      clearRedirects(st(), dev);
      return;
    }
    const ctrs = dev.docker ? dev.docker.containers.filter((x) => x.state === 'running') : [];
    if (is('route')) {
      if (only6) {
        for (const i of dev.ifaces) {
          const v = i.rt && i.rt.v6;
          if (!v || v.ll == null) continue;
          for (const a of v.addrs) if (a.bits < 128) print(`${fmtIp6(net6(a.ip, a.bits))}/${a.bits} dev ${i.id} proto ${a.src === 'slaac' ? 'ra' : 'kernel'} metric ${a.src === 'slaac' ? 100 : 256} pref medium`, 'pre');
          print(`fe80::/64 dev ${i.id} proto kernel metric 1024 pref medium`, 'pre');
          if (v.gw != null) print(`default via ${fmtIp6(v.gw)} dev ${i.id} proto ${v.ra ? 'ra' : 'static'} metric 100 pref medium`, 'pre');
        }
        return;
      }
      for (const i of dev.ifaces) if (i.rt && i.rt.ip != null && i.rt.gw != null) print(`default via ${fmtIp(i.rt.gw)} dev ${i.id} proto ${i.mode === 'dhcp' ? 'dhcp' : 'static'}`, 'pre');
      for (const i of dev.ifaces) if (i.rt && i.rt.ip != null) print(`${fmtIp((i.rt.ip & (i.rt.bits ? 0xffffffff << (32 - i.rt.bits) : 0)) >>> 0)}/${i.rt.bits} dev ${i.id} proto kernel scope link src ${fmtIp(i.rt.ip)}`, 'pre');
      if (dev.docker) print(`172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1${ctrs.length ? '' : ' linkdown'}`, 'pre');
      if (!dev.ifaces.some((i) => i.rt && i.rt.ip != null && i.rt.gw != null)) print('  ↳ 沒有 default 那一行：這台沒有預設閘道，只到得了同一個網段', 'hint');
      return;
    }
    if (is('neighbour') || is('neighbor')) {
      // 鄰居表：IPv4 的部分就是 ARP 快取
      const act = argv[1] || 'show';
      if (act === 'flush') {
        if (!argv[2]) { print('Flush requires arguments.', 'bad'); print('  ↳ sudo ip neigh flush all（或 flush dev eth0）', 'hint'); return; }
        if (!sudo) { needRoot('清掉鄰居表'); return; }
        clearArp(st(), dev);
        app.refreshLive();
        return;
      }
      if (/^del/.test(act)) {
        const ip = parseIp(argv[2] || ''), tbl = ((st().dyn || {}).arp || {})[dev.id];
        if (ip == null) { print('用法：sudo ip neigh del <IP> dev eth0', 'warn'); return; }
        if (!sudo) { needRoot('改鄰居表'); return; }
        if (tbl && tbl[ip] != null) { delete tbl[ip]; app.refreshLive(); } else print('RTNETLINK answers: No such file or directory', 'bad');
        return;
      }
      const rows = arpRows(st(), dev).sort((a, b) => a.ip - b.ip), up = dev.ifaces.filter((x) => x.rt && x.rt.ip != null);
      for (const r of rows) {
        const i = up.find((x) => sameNet(r.ip, x.rt.ip, x.rt.bits)) || up[0];
        print(`${fmtIp(r.ip)} dev ${i ? i.id : 'eth0'} lladdr ${r.mac} ${r.age < 30 ? 'REACHABLE' : 'STALE'}`, 'pre');
      }
      if (!rows.length) print('  ↳ 鄰居表（ARP 快取）是空的：先 ping 一個位址，電腦才會去問它的 MAC。項目一陣子沒用到就會過期', 'hint');
      return;
    }
    if (is('maddress')) {
      // 加入的群播群組（224.0.0.1 是每台主機都在的 all-hosts 群組）
      print('1:\tlo', 'pre');
      print('\tinet  224.0.0.1', 'pre');
      dev.ifaces.forEach((i, k) => {
        print(`${k + 2}:\t${i.id}`, 'pre');
        print('\tlink  01:00:5e:00:00:01', 'pre');
        for (const g of ['224.0.0.1', ...(dev.igmp || [])]) print(`\tinet  ${g}`, g === '224.0.0.1' ? 'pre' : 'ok');
      });
      return;
    }
    if (!is('address') && !is('link')) { print(`Object "${sub}" is unknown, try "ip help".`, 'bad'); return; }
    const linkOnly = !is('address');
    const want = argv.includes('dev') ? argv[argv.indexOf('dev') + 1] : argv[1] === 'show' || argv[1] === 'list' ? argv[2] : null;
    if (want && want !== 'lo' && !ifOf(want)) { print(`Device "${want}" does not exist.`, 'bad'); return; }
    const bc = (ip, bits) => fmtIp((ip | (bits >= 32 ? 0 : 0xffffffff >>> bits)) >>> 0);
    const lft = (sec) => { const s = sec == null ? 'forever' : Math.max(0, Math.ceil(sec)) + 'sec'; return `       valid_lft ${s} preferred_lft ${s}`; };
    const flagsOf = (up) => (up ? 'BROADCAST,MULTICAST,UP,LOWER_UP' : 'NO-CARRIER,BROADCAST,MULTICAST,UP');
    const v6Of = (i) => (i.rt && i.rt.v6 && i.rt.v6.ll != null ? i.rt.v6 : null);
    const shown = dev.ifaces.filter((i) => !want || i === ifOf(want));
    if (brief) {
      if (!want || want === 'lo') print(`${'lo'.padEnd(17)}${'UNKNOWN'.padEnd(15)}${linkOnly ? '00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>' : [only6 ? '' : '127.0.0.1/8', only4 ? '' : '::1/128'].filter(Boolean).join(' ')}`, 'pre');
      for (const i of shown) {
        const rt = i.rt || {}, v6 = v6Of(i);
        const addrs = [rt.ip != null && !only6 ? `${fmtIp(rt.ip)}/${rt.bits}` : '', ...(v6 && !only4 ? [...v6.addrs.map((a) => `${fmtIp6(a.ip)}/${a.bits}`), `${fmtIp6(v6.ll)}/64`] : [])].filter(Boolean).join(' ');
        print(`${i.id.padEnd(17)}${(rt.link ? 'UP' : 'DOWN').padEnd(15)}${linkOnly ? `${String(rt.mac || '').toLowerCase()} <${flagsOf(!!rt.link)}>` : addrs}`, rt.link ? 'pre' : 'warn');
      }
      return;
    }
    const notes = [];
    let n = 1, dyn6 = false;
    if (!want || want === 'lo') {
      print('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000', 'pre');
      print('    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00', 'pre');
      if (!linkOnly && !only6) { print('    inet 127.0.0.1/8 scope host lo', 'pre'); print(lft(null), 'pre'); }
      if (!linkOnly && !only4) { print('    inet6 ::1/128 scope host', 'pre'); print(lft(null), 'pre'); }
    }
    for (const i of dev.ifaces) {
      n++;
      if (!shown.includes(i)) continue;
      const rt = i.rt || {}, up = !!rt.link, v6 = v6Of(i), wl = i.bind.t === 'wlan';
      print(`${n}: ${i.id}: <${flagsOf(up)}> mtu ${ipMtu(st(), dev, i)} qdisc ${wl ? 'noqueue' : 'fq_codel'} state ${up ? 'UP' : 'DOWN'} group default qlen 1000`, up ? 'pre' : 'warn');
      print(`    link/ether ${String(rt.mac || '').toLowerCase()} brd ff:ff:ff:ff:ff:ff`, 'pre');
      if (stats && i.bind.port) {
        const x = counters(st(), dev.id, i.bind.port), rxErr = x.crc + x.runts + (x.giants || 0);
        print('    RX:  bytes packets errors dropped  missed   mcast', 'pre');
        print(`    ${String(x.ib).padStart(10)} ${String(x.ip).padStart(7)} ${String(rxErr).padStart(6)} ${'0'.padStart(7)} ${'0'.padStart(7)} ${String(x.imc).padStart(7)}`, rxErr ? 'bad' : 'pre');
        print('    TX:  bytes packets errors dropped carrier collsns', 'pre');
        print(`    ${String(x.ob).padStart(10)} ${String(x.op).padStart(7)} ${String(x.late).padStart(6)} ${'0'.padStart(7)} ${'0'.padStart(7)} ${String(x.coll || 0).padStart(7)}`, x.late ? 'bad' : 'pre');
        if (x.giants) notes.push(`${i.id} 收到 ${x.giants} 個比網卡的 MTU 還大的訊框，被丟掉了：網段裡有人開了 Jumbo Frame，這台沒有`);
        if (rxErr - (x.giants || 0) > 0 || x.late) notes.push(`${i.id} 有收送的錯誤：ethtool -S ${i.id} 看是哪一種（CRC、late collision…），ethtool ${i.id} 看雙工`);
        if (x.imc) notes.push('收到的群播 (mcast) 大多是交換器的 STP BPDU（每 2 秒一個）');
      }
      if (!linkOnly) {
        if (rt.ip != null && !only6) {
          const ll = rt.src === 'apipa';
          print(`    inet ${fmtIp(rt.ip)}/${rt.bits} brd ${bc(rt.ip, rt.bits)} scope ${ll ? 'link' : 'global'} ${i.mode === 'dhcp' && !ll ? 'dynamic ' : ''}${i.id}`, ll ? 'warn' : 'pre');
          print(lft(rt.exp != null && !ll ? rt.exp - st().clock : null), 'pre');
        }
        if (v6 && !only4) {
          for (const a of v6.addrs) {
            const dynamic = a.src === 'slaac' || a.src === 'dhcp6';
            if (dynamic) dyn6 = true;
            print(`    inet6 ${fmtIp6(a.ip)}/${a.bits} scope global${a.src === 'slaac' ? ' dynamic mngtmpaddr' : a.src === 'dhcp6' ? ' dynamic' : ''}`, 'pre');
            print(dynamic ? '       valid_lft 2591998sec preferred_lft 604798sec' : lft(null), 'pre');
          }
          print(`    inet6 ${fmtIp6(v6.ll)}/64 scope link`, 'pre');
          print(lft(null), 'pre');
        }
        if (rt.src === 'apipa') notes.push(`${i.id} 的 169.254.x.x 是 IPv4 link-local 位址（Windows 叫 APIPA）：向 DHCP 要不到位址，自己編了一個。沒有閘道，只能和同網段裡同樣情況的主機互通${rt.note ? '（' + rt.note + '）' : ''}`);
        else if (up && rt.ip == null && !only6) notes.push(`${i.id} 沒有 IPv4 位址${rt.note ? '：' + rt.note : ''}`);
        if (rt.held) notes.push(`${i.id} 目前連不到 DHCP 伺服器，先繼續用還沒到期的租約（valid_lft 是剩下的秒數）`);
        if (v6 && v6.dhcp && !v6.dhcp.ok) notes.push(`${i.id} 的 DHCPv6 失敗：${v6.dhcp.why}`);
      }
      if (!up) notes.push(`${i.id} 是 NO-CARRIER / DOWN：${wl ? 'Wi-Fi 沒有連上' : '網路線沒有接上，或對面的連接埠沒有啟用'}${rt.note && rt.ip == null ? '（' + rt.note + '）' : ''}`);
    }
    if (dev.docker && !want) {
      print(`${++n}: docker0: <BROADCAST,MULTICAST,UP${ctrs.length ? ',LOWER_UP' : ''}> mtu 1500 qdisc noqueue state ${ctrs.length ? 'UP' : 'DOWN'} group default`, 'pre');
      print('    link/ether 02:42:5e:9a:1c:07 brd ff:ff:ff:ff:ff:ff', 'pre');
      if (!linkOnly) print('    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0', 'pre');
      for (const x of ctrs) {
        print(`${++n}: veth${x.id.slice(1, 8)}@if${2 * n}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master docker0 state UP group default`, 'pre');
        print(`    link/ether ${x.id.slice(0, 2)}:${x.id.slice(2, 4)}:${x.id.slice(4, 6)}:1e:0b:${x.ip.split('.')[3].padStart(2, '0').slice(-2)} brd ff:ff:ff:ff:ff:ff`, 'pre');
      }
      print('（容器的 172.17.0.x 只存在主機裡的 docker0 橋接網路：每個容器用一條 veth 接上去。外面要連，靠的是發佈的連接埠，docker ps 的 PORTS 欄）', 'hint');
    }
    if (dyn6) notes.push('inet6 那幾行：dynamic mngtmpaddr 是照路由器通告 (RA) 的前綴自己組出來的（SLAAC）；/128 的 dynamic 是 DHCPv6 給的；scope link 的 fe80:: 是每張網卡都有的連結本機位址');
    for (const x of notes) print('  ↳ ' + x, 'hint');
  }

  /** ethtool eth0：速率、雙工、有沒有連線；ethtool -S eth0：網卡的計數器 */
  function ethtool(args) {
    const S = args.includes('-S') || args.includes('--statistics'), name = args.find((a) => !a.startsWith('-')), i = name && ifOf(name);
    if (!name) { print('ethtool: bad command line argument(s)', 'bad'); print('  ↳ 用法：ethtool eth0（速率、雙工、有沒有連線）、ethtool -S eth0（收送與錯誤的計數器）', 'hint'); return; }
    if (!i) { print('netlink error: no device matches name (offset 24)', 'bad'); print('netlink error: No such device', 'bad'); return; }
    const p = i.bind.port, up = !!(i.rt && i.rt.link);
    if (!p) { print(`Settings for ${i.id}:`, 'pre'); print(`\tLink detected: ${up ? 'yes' : 'no'}`, up ? 'pre' : 'warn'); return; }
    if (S) {
      const x = counters(st(), dev.id, p);
      print('NIC statistics:', 'pre');
      for (const [k, v] of [['rx_packets', x.ip], ['tx_packets', x.op], ['rx_bytes', x.ib], ['tx_bytes', x.ob], ['rx_broadcast', x.ibc], ['rx_multicast', x.imc], ['tx_broadcast', x.obc], ['tx_multicast', x.omc],
        ['rx_crc_errors', x.crc], ['rx_short_length_errors', x.runts], ['rx_long_length_errors', x.giants || 0], ['tx_window_errors', x.late], ['collisions', x.coll || 0]]) print(`     ${k}: ${v}`, v && /error|collision/.test(k) ? 'bad' : 'pre');
      if (x.crc || x.runts) print('  ↳ rx_crc_errors / rx_short_length_errors：收到的訊框是壞的 — 線材、水晶頭、光功率，或對面是半雙工撞出來的碎片', 'hint');
      if (x.late) print('  ↳ tx_window_errors 是 late collision：這一端是半雙工，卻在訊框送到一半之後才撞到 — 雙工不一致的典型症狀', 'hint');
      if (x.giants) print('  ↳ rx_long_length_errors：收到比網卡的 MTU 還大的訊框（對面開了 Jumbo Frame，這台沒有）', 'hint');
      return;
    }
    const li = linkInfo(st(), dev.id, p), ok = up && li && !li.down;
    const port = (dev.ports.find((q) => q.id === p) || {}).media, tp = !port || port === 'rj45';
    print(`Settings for ${i.id}:`, 'pre');
    print(`\tSupported ports: [ ${tp ? 'TP' : 'FIBRE'} ]`, 'pre');
    if (tp) { print('\tSupported link modes:   10baseT/Half 10baseT/Full', 'pre'); print('\t                        100baseT/Half 100baseT/Full', 'pre'); print('\t                        1000baseT/Full', 'pre'); }
    print(`\tSupports auto-negotiation: ${tp ? 'Yes' : 'No'}`, 'pre');
    print(`\tSpeed: ${ok ? li.speed + 'Mb/s' : 'Unknown!'}`, 'pre');
    print(`\tDuplex: ${ok ? (li.duplex === 'half' ? 'Half' : 'Full') : 'Unknown! (255)'}`, ok && li.duplex === 'half' ? 'warn' : 'pre');
    print(`\tAuto-negotiation: ${tp ? 'on' : 'off'}`, 'pre');
    print(`\tPort: ${tp ? 'Twisted Pair' : port === 'virt' ? 'Other' : 'FIBRE'}`, 'pre');
    print(`\tLink detected: ${ok ? 'yes' : 'no'}`, ok ? 'pre' : 'warn');
    if (ok && li.mismatch) print(`  ↳ 雙工不一致：這一端是${li.duplex === 'half' ? '半' : '全'}雙工，對面是${li.peerDuplex === 'half' ? '半' : '全'}雙工。會通但又慢又不穩（一端寫死、一端自動協商最常發生）`, 'hint');
    if (ok && li.downshift) print(`  ↳ 兩端都支援更快的速率，卻只協商到 ${li.speed}Mb/s：網路線有線對斷了（1000BASE-T 要四對線都正常）`, 'hint');
    if (!ok && li && li.down) print('  ↳ ' + li.down, 'hint');
  }

  /** systemd-resolved：status（用哪幾台 DNS）、query（經過快取查詢）、show-cache、flush-caches */
  function resolvectl(args, line) {
    const sub = (args[0] || 'status').toLowerCase().replace(/^--/, '');
    if (sub === 'status') {
      print('Global', 'pre');
      print('         Protocols: -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported', 'pre');
      print('  resolv.conf mode: uplink', 'pre');
      dev.ifaces.forEach((i, k) => {
        const d = dnsOf(i), on = d.length && i.rt && i.rt.link;
        print('');
        print(`Link ${k + 2} (${i.id})`, 'pre');
        print(`    Current Scopes: ${on ? 'DNS' : 'none'}`, 'pre');
        print('         Protocols: +DefaultRoute -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported', 'pre');
        if (on) { print(`Current DNS Server: ${d[0]}`, 'pre'); print(`       DNS Servers: ${d.join(' ')}`, 'pre'); }
      });
      if (!dev.ifaces.some((i) => dnsOf(i).length)) print('  ↳ 沒有任何 DNS 伺服器：用名稱連線都會失敗（用 IP 還是通）', 'hint');
    } else if (sub === 'flush-caches') cacheFlush(st(), dev);
    else if (sub === 'show-cache') {
      const rows = cacheRows(st(), dev), i0 = dev.ifaces.find((i) => i.rt && i.rt.link && i.rt.ip != null) || dev.ifaces[0];
      print(`Scope protocol=dns ifindex=${dev.ifaces.indexOf(i0) + 2} ifname=${i0 ? i0.id : 'eth0'}`, 'pre');
      for (const r of rows) {
        print(`${r.name} IN ${r.ip6 != null ? 'AAAA' : 'A'} ${r.ip6 != null ? fmtIp6(r.ip6) : fmtIp(r.ip)}`, 'ok');
        print(`  ↳ 還有 ${r.left} 秒到期${r.alias ? `（經由別名 ${r.alias}）` : ''}`, 'dim');
      }
      if (!rows.length) print('  ↳ 快取是空的：查過的名稱會照 TTL 記在這裡，到期之前不會再問伺服器', 'hint');
    } else if (sub === 'query') {
      const name = args.find((a, k) => k > 0 && !a.startsWith('-'));
      if (!name) { print('用法：resolvectl query <網域>', 'warn'); return; }
      const r = resolveName(st(), dev.id, name);
      app.showTrace(`${dev.name}> ${line}`, r.log, r.hops, r);
      if (!r.ok) { print(`${name}: resolve call failed: ${/NXDOMAIN|找不到/.test(r.reason || '') ? `'${name}' not found` : 'All attempts to contact name servers or networks failed'}`, 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
      const i0 = dev.ifaces.find((i) => i.rt && i.rt.link && i.rt.ip != null) || dev.ifaces[0];
      print(`${name}: ${fmtIp(r.ip)}${' '.repeat(Math.max(1, 32 - name.length - fmtIp(r.ip).length))}-- link: ${i0 ? i0.id : 'eth0'}`, 'ok');
      print('');
      print(`-- Information acquired via protocol DNS in ${r.cached ? '1.2' : '14.6'}ms.`, 'pre');
      print(`-- Data from: ${r.cached ? 'cache' : 'network'}`, 'pre');
    } else print('用法：resolvectl status | query <網域> | show-cache | flush-caches', 'warn');
  }

  /** dhclient：向 DHCP 伺服器要位址（-v 看得到 DORA）、-r 歸還、-6 是 DHCPv6 */
  function dhclient(args, sudo, line) {
    const rel = args.includes('-r'), six = args.includes('-6'), verbose = args.some((a) => /^-[a-z0-9]*v/.test(a));
    const name = args.find((a) => !a.startsWith('-')), i = name ? ifOf(name) : dev.ifaces.find((x) => x.mode === 'dhcp') || dev.ifaces[0];
    if (!i) { print(`Cannot find device "${name || ''}"`, 'bad'); return; }
    if (!sudo) { needRoot('向 DHCP 要位址會改網卡的設定，'); return; }
    if (six) {
      // DHCPv6 沒有 DORA：stateful 是 Solicit / Advertise / Request / Reply，stateless 只有 Information-Request / Reply
      const tr = dhcp6Trace(st(), dev.id);
      app.showTrace(`${dev.name}> ${line}`, tr.log, tr.hops, { ok: tr.ok, reason: tr.reason, failDev: dev.id });
      if (verbose && tr.ok) { print(`XMT: Solicit on ${i.id}, interval 1010ms.`, 'pre'); print(`RCV: Reply message on ${i.id}.`, 'ok'); }
      if (!tr.ok) { print('No DHCPv6 servers responded.', 'bad'); print('  ↳ ' + tr.reason, 'hint'); }
      return;
    }
    const mac = String((i.rt && i.rt.mac) || '').toLowerCase();
    const head = () => { print('Internet Systems Consortium DHCP Client 4.4.3-P1', 'pre'); print(`Listening on LPF/${i.id}/${mac}`, 'pre'); print(`Sending on   LPF/${i.id}/${mac}`, 'pre'); print('Sending on   Socket/fallback', 'pre'); };
    if (rel) {
      const old = i.rt && i.rt.src === 'dhcp' ? i.rt.ip : null, srv = dhcpServerIp(i.rt);
      dhcpRelease(st(), dev.id);
      ctx.commit(false);
      if (verbose) { head(); if (old != null) print(`DHCPRELEASE of ${fmtIp(old)} on ${i.id} to ${srv != null ? fmtIp(srv) : '255.255.255.255'} port 67`, 'pre'); }
      return;
    }
    dhcpRenew(st(), dev.id);
    ctx.commit(false);
    const tr = dhcpTrace(st(), dev.id);
    app.showTrace(`${dev.name}> ${line}`, tr.log, tr.hops, { ok: tr.ok, reason: tr.reason, failDev: dev.id });
    const rt = i.rt || {}, ip = rt.ip != null ? fmtIp(rt.ip) : '', srv = dhcpServerIp(rt);
    if (verbose) { head(); print(`DHCPDISCOVER on ${i.id} to 255.255.255.255 port 67 interval 3`, 'pre'); }
    if (tr.ok && rt.src === 'dhcp') {
      if (!verbose) return;
      const from = srv != null ? fmtIp(srv) : '?';
      print(`DHCPOFFER of ${ip} from ${from}`, 'pre');
      print(`DHCPREQUEST for ${ip} on ${i.id} to 255.255.255.255 port 67`, 'pre');
      print(`DHCPACK of ${ip} from ${from}`, 'pre');
      print(`bound to ${ip} -- renewal in ${Math.max(1, Math.round((rt.exp - st().clock) / 2))} seconds.`, 'ok');
    } else {
      print('No DHCPOFFERS received.', 'bad');
      print('No working leases in persistent database - sleeping.', 'bad');
      print('  ↳ ' + (tr.reason || rt.note || 'DHCP 伺服器沒有回應'), 'hint');
    }
  }

  /** 根憑證（Ubuntu / Debian）：.crt 檔放進 /usr/local/share/ca-certificates/，再 update-ca-certificates 才會加進系統信任的清單 */
  function caCmd(c, args, sudo) {
    const trust = (dev.trust ||= []), has = trust.includes(CORP_CA), drop = !!(app.caDrop ||= {})[dev.id];
    const pem = (n) => n.replace(/[^\w]+/g, '_') + '.pem';
    if (c === 'ls') {
      if (/\/etc\/ssl\/certs/.test(args.join(' '))) print([...PUBLIC_CAS, ...trust].map(pem).concat('ca-certificates.crt').join('  '), 'pre');
      else if (has || drop) print('corp-root-ca.crt', 'pre');
      return;
    }
    if (c === 'cp') {
      const [src, dst] = args.filter((a) => !a.startsWith('-'));
      if (!/(^|\/)corp-root-ca\.crt$/.test(src || '')) { print(`cp: cannot stat '${src || ''}': No such file or directory`, 'bad'); print('  ↳ IT 放在家目錄的是 corp-root-ca.crt（ls 看得到）', 'hint'); return; }
      if (!/^\/usr\/local\/share\/ca-certificates(\/|$)/.test(dst || '')) { print(`cp: 這個模擬只認得放進 /usr/local/share/ca-certificates/`, 'warn'); return; }
      if (!sudo) { print("cp: cannot create regular file '/usr/local/share/ca-certificates/corp-root-ca.crt': Permission denied", 'bad'); print('  ↳ 那是系統的目錄，要 root 權限：前面加 sudo', 'hint'); return; }
      app.caDrop[dev.id] = true;
      if (!has) print('  ↳ 檔案放好了，還要 sudo update-ca-certificates 才會加進系統信任的清單', 'hint');
      return;
    }
    if (!sudo) { print("ln: failed to create symbolic link '/etc/ssl/certs/ca-certificates.crt.new': Permission denied", 'bad'); print('  ↳ 更新系統信任的憑證要 root 權限：前面加 sudo', 'hint'); return; }
    const add = drop && !has;
    print('Updating certificates in /etc/ssl/certs...', 'pre');
    print(`${add ? 1 : 0} added, 0 removed; done.`, add ? 'ok' : 'pre');
    print('Running hooks in /etc/ca-certificates/update.d...', 'pre');
    print('done.', 'pre');
    if (add) { dev.trust = [...trust, CORP_CA]; ctx.commit(true); }
    else if (!has) print('  ↳ 沒有新的憑證：先 sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/（副檔名要是 .crt 才會被收進去）', 'hint');
  }

  /** cat /etc/resolv.conf、/etc/os-release、/etc/hostname */
  function sysFile(path) {
    if (path === '/etc/hostname') { print(HOST, 'pre'); return; }
    if (path === '/etc/os-release') { ['PRETTY_NAME="Ubuntu 24.04.1 LTS"', 'NAME="Ubuntu"', 'VERSION_ID="24.04"', 'VERSION="24.04.1 LTS (Noble Numbat)"', 'ID=ubuntu', 'ID_LIKE=debian'].forEach((x) => print(x, 'pre')); return; }
    const dns = [...new Set(dev.ifaces.flatMap(dnsOf))];
    print('# This is /run/systemd/resolve/resolv.conf managed by man:systemd-resolved(8).', 'dim');
    print('# Do not edit.', 'dim');
    for (const d of dns) print(`nameserver ${d}`, 'pre');
    print('search .', 'pre');
    if (!dns.length) print('  ↳ 沒有 nameserver：這台沒有設定 DNS 伺服器', 'hint');
  }

  /**
   * nslookup、dig、host：它們自己就是 DNS 用戶端，直接問 /etc/resolv.conf 裡的伺服器，不看、也不寫本機（systemd-resolved）的快取。
   * ping、curl 這些程式才會用快取（resolvectl show-cache）
   */
  function dnsTool(c, args, line) {
    let type = '', target = '', short = false;
    if (c === 'nslookup') {
      const tm = (args.find((a) => /^-(type|q|query|querytype)=/i.test(a)) || '').split('=')[1];
      target = args.find((a) => !a.startsWith('-')) || '';
      type = (tm || '').toUpperCase() || (parseIp(target) != null ? 'PTR' : 'A');
    } else if (c === 'dig') {
      const rest = args.filter((a) => !a.startsWith('@'));
      short = rest.includes('+short');
      const x = rest.indexOf('-x'), ti = rest.indexOf('-t');
      const words = rest.filter((a, k) => !/^[+-]/.test(a) && k !== x + 1 - (x < 0 ? 1 : 0) && (ti < 0 || k !== ti + 1));
      const ty = ti >= 0 ? rest[ti + 1] : words.find((w) => /^(a|aaaa|mx|ptr|ns|txt|cname|soa|any)$/i.test(w));
      if (x >= 0) { type = 'PTR'; target = rest[x + 1] || ''; } else { type = (ty || 'A').toUpperCase(); target = words.find((w) => w !== ty) || ''; }
    } else {
      const ti = args.indexOf('-t');
      target = args.find((a, k) => !a.startsWith('-') && (ti < 0 || k !== ti + 1)) || '';
      type = ti >= 0 ? (args[ti + 1] || '').toUpperCase() : parseIp(target) != null ? 'PTR' : 'A';
    }
    if (!target) { print({ nslookup: '用法：nslookup <網域>、nslookup -type=mx <網域>、nslookup <IP>', dig: '用法：dig <網域> [a|aaaa|mx]、dig +short <網域>、dig -x <IP>', host: '用法：host <網域>、host -t mx <網域>、host <IP>' }[c], 'warn'); return; }
    if (!['A', 'AAAA', 'MX', 'PTR'].includes(type) || (type === 'PTR' && parseIp(target) == null)) { print('這個模擬支援的查詢類型：A（預設）、AAAA、MX，以及用 IP 反查 (PTR)', 'warn'); return; }
    // 查詢
    let r, recs = [], qname = target, q6 = null;
    if (type === 'A' || type === 'AAAA') {
      r = resolveName(st(), dev.id, target, 0, { nocache: true, ...(type === 'AAAA' ? { type: 'AAAA' } : {}) });
      if (r.ok) recs = [{ name: r.canonical || target, type, value: type === 'AAAA' ? fmtIp6(r.ip6) : fmtIp(r.ip), ttl: r.ttl ?? 300 }];
      // nslookup 與 host 預設 A、AAAA 都問
      if (r.ok && type === 'A' && c !== 'dig' && st().v6) q6 = resolveName(st(), dev.id, target, 0, { nocache: true, type: 'AAAA' });
    } else {
      qname = type === 'PTR' ? ptrName(parseIp(target)) : target;
      r = dnsQuery(st(), dev.id, qname, type);
      if (r.ok) recs = r.records.map((x) => ({ name: qname, type, value: type === 'MX' ? `${x.pref ?? 10} ${x.value}.` : `${x.value}.`, ttl: x.ttl ?? 300 }));
    }
    app.showTrace(`${dev.name}> ${line}`, r.log, r.hops, r);
    const cfg = dev.ifaces.flatMap(dnsOf)[0] || '', srv = r.serverIp == null ? cfg : typeof r.serverIp === 'bigint' ? fmtIp6(r.serverIp) : fmtIp(r.serverIp);
    // 伺服器有回答「沒有這個名稱」，和「根本問不到伺服器」是兩回事
    const nx = !r.ok && /NXDOMAIN|Non-existent|沒有 IPv6 位址|找不到/.test(r.reason || '') && !/沒有設定 DNS/.test(r.reason || '');
    const dead = !r.ok && !nx;
    const alias = r.ok && r.alias && r.canonical && r.canonical !== target ? r.canonical : null;
    if (c === 'nslookup') {
      if (dead) { if (cfg) print(`;; communications error to ${cfg}#53: timed out`, 'bad'); print(';; no servers could be reached', 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
      print(`Server:\t\t${srv}`);
      print(`Address:\t${srv}#53`);
      print('');
      if (!r.ok) { print(`** server can't find ${qname}: NXDOMAIN`, 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
      if (type === 'A' || type === 'AAAA') {
        if (!r.auth) print('Non-authoritative answer:');
        if (alias) print(`${target}\tcanonical name = ${alias}.`);
        print(`Name:\t${recs[0].name}`);
        print(`Address: ${recs[0].value}`, 'ok');
        if (q6 && q6.ok) { print(`Name:\t${recs[0].name}`); print(`Address: ${fmtIp6(q6.ip6)}`, 'ok'); }
      } else for (const x of recs) print(type === 'MX' ? `${target}\tmail exchanger = ${x.value}` : `${qname}\tname = ${x.value}`, 'ok');
      return;
    }
    if (c === 'host') {
      if (dead) { print(';; communications error to ' + (cfg || '?') + '#53: timed out', 'bad'); print(';; no servers could be reached', 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
      if (!r.ok) { print(`Host ${qname} not found: 3(NXDOMAIN)`, 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
      if (alias) print(`${target} is an alias for ${alias}.`);
      for (const x of recs) print(type === 'MX' ? `${target} mail is handled by ${x.value}` : type === 'PTR' ? `${qname} domain name pointer ${x.value}` : `${x.name} has ${type === 'AAAA' ? 'IPv6 ' : ''}address ${x.value}`, 'ok');
      if (q6 && q6.ok) print(`${recs[0].name} has IPv6 address ${fmtIp6(q6.ip6)}`, 'ok');
      return;
    }
    // dig
    if (short) { if (dead) { print(';; communications error to ' + (cfg || '?') + '#53: timed out', 'bad'); print('  ↳ ' + r.reason, 'hint'); } else { if (alias) print(alias + '.', 'pre'); for (const x of recs) print(x.value, 'ok'); if (!r.ok) print('  ↳ ' + r.reason, 'hint'); } return; }
    print('');
    print(`; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${args.join(' ')}`, 'dim');
    print(';; global options: +cmd', 'dim');
    if (dead) { if (cfg) print(`;; communications error to ${cfg}#53: timed out`, 'bad'); print(';; no servers could be reached', 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
    const answers = [...(alias ? [{ name: target, type: 'CNAME', value: alias + '.', ttl: recs[0].ttl }] : []), ...recs];
    print(';; Got answer:', 'dim');
    print(`;; ->>HEADER<<- opcode: QUERY, status: ${r.ok ? 'NOERROR' : 'NXDOMAIN'}, id: ${10000 + (Math.floor(st().clock * 7) % 50000)}`, r.ok ? 'dim' : 'bad');
    print(`;; flags: qr${r.auth ? ' aa' : ''} rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1`, 'dim');
    print('');
    print(';; QUESTION SECTION:', 'dim');
    print(`;${qname}.\t\tIN\t${type}`, 'pre');
    if (answers.length) {
      print('');
      print(';; ANSWER SECTION:', 'dim');
      for (const x of answers) print(`${x.name}.\t${x.ttl}\tIN\t${x.type}\t${x.value}`, 'ok');
    }
    print('');
    print(`;; Query time: ${r.ok && r.auth ? 1 : 12} msec`, 'dim');
    print(`;; SERVER: ${srv}#53(${srv}) (UDP)`, 'dim');
    print(`;; WHEN: ${linuxDate(plainStamp(st(), dev))}`, 'dim');
    if (!r.ok) print('  ↳ ' + r.reason, 'hint');
    else print(`  ↳ 第二欄是 TTL（秒）：用戶端會把答案記在快取裡這麼久。${r.auth ? 'flags 裡的 aa 代表這台伺服器就是這個網域的權威伺服器' : '沒有 aa：這台伺服器是幫你去問別人再轉述的（遞迴查詢）'}`, 'hint');
  }

  /** ping（iputils）與 traceroute。ping -M do -s 1472 <IP>：-s 是資料的大小（IP 封包再多 28 位元組），-M do 設 DF 不可分段 */
  function pingCmd(c, args, line) {
    const trace = c.startsWith('trace');
    const takes = ['-s', '-c', '-M', '-W', '-i', '-t', '-I', '-w', '-m', '-q', '-f'];
    let target = '', data = null, df = false, badSize = null, count = 4;
    for (let k = 0; k < args.length; k++) {
      const x = args[k];
      if (takes.includes(x)) {
        const v = args[++k];
        if (x === '-s') { data = +v; if (!(Number.isInteger(data) && data >= 0 && data <= 65507)) badSize = v; }
        if (x === '-M') df = v === 'do';
        if (x === '-c' && +v >= 1) count = Math.min(10, Math.floor(+v));
        continue;
      }
      if (!x.startsWith('-') && !target) target = x;
    }
    if (badSize != null) { print(`ping: invalid argument: '${badSize}': out of range: 0 <= value <= 65507`, 'bad'); return; }
    const dataLen = data ?? 56, numeric = args.includes('-n');
    // 用名稱連線：電腦有全域的 IPv6 位址、名稱又有 AAAA 時優先用 IPv6（-4 / -6 可以指定）
    const fam = args.includes('-4') ? 4 : args.includes('-6') || c.endsWith('6') ? 6 : 0;
    const named = !!target && !target.includes(':') && parseIp(target) == null;
    const r6 = named && fam !== 4 && st().v6 && (fam === 6 || dev.ifaces.some((i) => i.rt.v6 && i.rt.v6.addrs.length)) ? resolveName(st(), dev.id, target, 0, { type: 'AAAA' }) : null;
    const ms3 = (list) => list.map((v) => `${v.toFixed(3)} ms`).join('  ');
    const row = (n, text, cls) => print(`${String(n).padStart(2)}  ${text}`, cls);
    const stat = (name, got, res, t, errs) => {
      print('');
      print(`--- ${name} ping statistics ---`);
      print(`${count} packets transmitted, ${got} received, ${errs ? `+${count} errors, ` : ''}${Math.round((1 - got / count) * 100)}% packet loss, time ${(count - 1) * 1001 + 2}ms`, got === count ? '' : 'bad');
      if (res.ok) print(`rtt min/avg/max/mdev = ${[t.min, t.avg, t.max, t.mdev].map((v) => v.toFixed(3)).join('/')} ms`);
      if (!res.ok) print('  ↳ ' + res.reason, 'hint');
    };
    if (!target) { print(trace ? '用法：traceroute <IP 或網域>' : '用法：ping [-c 次數] [-4 | -6] <IP 或網域>', 'warn'); return; }
    if (named && fam === 6 && !(r6 && r6.ok)) { print(`${trace ? target : 'ping'}: ${trace ? 'Name or service not known' : `${target}: Name or service not known`}`, 'bad'); print('  ↳ ' + (r6 ? r6.reason : '這台電腦沒有 IPv6'), 'hint'); return; }
    if (target.includes(':') || (r6 && r6.ok)) {
      // ── IPv6 ──
      const d6 = r6 && r6.ok ? r6.ip6 : parseIp6(target);
      if (d6 == null) { print(`${trace ? 'traceroute' : 'ping'}: ${target}: Name or service not known`, 'bad'); print('  ↳ IPv6 位址的格式不正確', 'hint'); return; }
      const res = transact6(st(), dev.id, d6), a6 = fmtIp6(d6);
      app.showTrace(`${dev.name}> ${line}`, [...(r6 ? r6.log : []), ...res.log], [...(r6 ? r6.hops : []), ...res.hops], res);
      if (r6 && r6.ok && fam !== 6) print(`  ↳ ${target} 有 AAAA 記錄，這台電腦也有 IPv6 位址，所以用 IPv6；要用 IPv4 請加 -4`, 'hint');
      if (trace) {
        print(`traceroute to ${named ? target : a6} (${a6}), 30 hops max, 80 byte packets`);
        const cols = (dv) => ms3(rttSamples(st(), res, 3, 74, dv));
        res.l3.forEach((x, n) => row(n + 1, `${numeric ? fmtIp6(x.ip6) : `${fmtIp6(x.ip6)} (${fmtIp6(x.ip6)})`}  ${cols(x.dev)}  （${st().devices[x.dev].name}）`));
        if (res.ok) row(res.l3.length + 1, `${numeric ? a6 : `${named ? target : a6} (${a6})`}  ${cols(null)}`, 'ok');
        else { row(res.l3.length + 1, '* * *', 'bad'); print('  ↳ ' + res.reason, 'hint'); }
        return;
      }
      print(`PING ${named ? target : a6}(${a6}) ${dataLen} data bytes`);
      const t = pingStats(st(), res, count, dataLen + 62);
      for (let n = 1; n <= count; n++) {
        if (res.ok) print(`${dataLen + 8} bytes from ${a6}: icmp_seq=${n} ttl=${64 - res.l3.length} time=${linuxMs(t.list[n - 1])} ms`, 'ok');
        else if (res.phase !== 'reply' && !res.silent && res.failDev === dev.id) print(`From ${a6} icmp_seq=${n} Destination unreachable: Address unreachable`, 'bad');
      }
      stat(named ? target : a6, res.ok ? count : 0, res, t, false);
      return;
    }
    // ── IPv4 ──
    const r = resolve(target);
    if (!r.ok) { print(`${trace ? target : 'ping: ' + target}: ${/逾時|沒有回應|連不到|失敗/.test(r.reason || '') ? 'Temporary failure in name resolution' : 'Name or service not known'}`, 'bad'); print('  ↳ ' + r.reason, 'hint'); return; }
    const res = transact(st(), dev.id, { proto: 'icmp', dst: r.ip, ...(trace ? {} : { size: dataLen + 28, ...(df ? { df: true } : {}) }) });
    const ip = fmtIp(r.ip), isName = target !== ip;
    app.showTrace(`${dev.name}> ${line}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
    const unr = unreachOf(st(), dev.id, res);
    const out = lookupRoute(dev, r.ip), mine = out && out.iface && out.iface.rt ? out.iface.rt.ip : null;
    if (trace) {
      print(`traceroute to ${target} (${ip}), 30 hops max, 60 byte packets`);
      const gw = out && out.iface && out.iface.rt ? out.iface.rt.gw : null;
      // Ubuntu 會把預設閘道顯示成 _gateway；其他的站沒有反解，名稱就是位址
      const nm = (a) => (numeric ? fmtIp(a) : `${a === gw ? '_gateway' : fmtIp(a)} (${fmtIp(a)})`);
      const cols = (dv) => ms3(rttSamples(st(), res, 3, 74, dv));
      let n = 0;
      // 括號裡的設備名稱是遊戲加的註解：真的 traceroute 只有位址（查得到反解的才有名稱）
      for (const x of res.l3) row(++n, x.ip == null ? `* * *  （VPN 通道裡的那一站：${st().devices[x.dev].name}）` : `${nm(x.ip)}  ${cols(x.dev)}  （${st().devices[x.dev].name}）`);
      // 目的地在網際網路上：業者的閘道之後，骨幹裡還有幾站
      const far = res.ok || res.phase === 'reply' ? ispRows(st(), res, 3, 74) : [], first = n + 1;
      far.forEach((x, k) => row(++n, x.ip == null ? '* * *' : `${nm(x.ip)}  ${ms3(x.ms)}${k === 0 && res.isp.edge != null ? '  （業者的閘道）' : ''}`));
      if (res.ok) row(++n, `${numeric ? ip : `${isName ? target : ip} (${ip})`}  ${cols(null)}`, 'ok');
      else if (unr) { row(++n, `${nm(unr.from)}  ${cols(unr.dev)} !${unr.code === 'A' ? 'X' : unr.code}  * *`, 'bad'); print(`  ↳ !${unr.code === 'A' ? 'X' : unr.code}：${unr.code === 'A' ? '被那一站的 ACL 擋掉（administratively prohibited）' : unr.code === 'N' ? '那一站沒有通往目的地的路由（network unreachable）' : '那一站找不到目的主機（host unreachable）'}。${res.reason}`, 'hint'); }
      else {
        if (res.phase === 'reply') row(++n, '* * *');
        row(++n, '* * *', 'bad');
        print('  ↳ ' + res.reason, 'hint');
      }
      if (far.length > 1) print(`  ↳ 第 ${first}–${first + far.length - 1} 站在網際網路上：業者與上游骨幹的路由器。100.64.x.x 是電信業者內部共用的位址（RFC 6598），「* * *」是那一站不回應 traceroute — 都很常見，不代表不通`, 'hint');
      return;
    }
    if (mine == null && !res.ok && res.failDev === dev.id) { print('ping: connect: Network is unreachable', 'bad'); print('  ↳ ' + res.reason, 'hint'); return; }
    print(`PING ${target} (${ip}) ${dataLen}(${dataLen + 28}) bytes of data.`);
    const t = pingStats(st(), res, count, dataLen + 42);
    t.list[0] += res.hops.filter((x) => x.wave).length * 0.5; // 第一個封包要先等 ARP 的回答，所以比較慢
    let errs = false;
    for (let n = 1; n <= count; n++) {
      if (res.ok) print(`${dataLen + 8} bytes from ${isName ? `${target} (${ip})` : ip}: icmp_seq=${n} ttl=${res.rttl ?? 64 - res.l3.length} time=${linuxMs(t.list[n - 1])} ms`, 'ok');
      else if (res.dfLocal) { errs = true; print(`ping: local error: message too long, mtu=${res.dfLocal}`, 'bad'); }
      else if (res.ptb) { errs = true; print(`From ${fmtIp(res.ptb.from)} icmp_seq=${n} Frag needed and DF set (mtu = ${res.ptb.mtu})`, 'bad'); }
      else if (unr) { errs = true; print(`From ${fmtIp(unr.from)} icmp_seq=${n} ${unr.code === 'A' ? 'Packet filtered' : unr.code === 'N' ? 'Destination Net Unreachable' : 'Destination Host Unreachable'}`, 'bad'); }
      else if (res.phase !== 'reply' && !res.silent && res.failDev === dev.id && mine != null) { errs = true; print(`From ${fmtIp(mine)} icmp_seq=${n} Destination Host Unreachable`, 'bad'); }
    }
    stat(target, res.ok ? count : 0, res, t, errs);
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
        res = transact(st(), dev.id, { proto: 'tcp', dst: r.ip, dport: port, ...(parseIp(host) == null ? { host } : {}) });
        app.showTrace(`${dev.name}> curl ${u}`, [...r.log, ...res.log], [...r.hops, ...res.hops], res);
      }
      const shown = r.ip6 != null ? fmtIp6(r.ip6) : fmtIp(r.ip);
      // FortiGate 的網頁過濾：HTTP 收到一頁封鎖頁面，HTTPS（沒有解密）只能把連線重設
      if (!res.ok && res.wfBlock) {
        if (res.wfBlock.http) { print('HTTP/1.1 403 Forbidden', 'bad'); print('<h1>Web Page Blocked!</h1>', 'pre'); print(`<p>The page you have requested has been blocked because the URL is categorized as ${FG_CATS[res.wfBlock.cat] || 'Unrated'}.</p>`, 'pre'); }
        else print('curl: (35) Recv failure: Connection reset by peer', 'bad');
        print('  ↳ ' + res.reason, 'hint');
        return;
      }
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
        const t = tlsCheck(st(), dev, srv, host, res.deep && st().devices[res.deep.dev], { aia: false });
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
      const hs = httpStatus(srv);
      print(hs.line, hs.code >= 400 ? 'bad' : 'ok');
      if (head || verbose) { print(`Server: ${srv.kind === 'internet' ? 'ECAcc (sec/96EE)' : web.server || 'nginx'}`, 'pre'); print('Content-Type: text/html; charset=UTF-8', 'pre'); if (https) print('Strict-Transport-Security: max-age=31536000', 'pre'); }
      if (!head) print(`<title>${hs.code >= 400 ? hs.code + ' ' + hs.text : srv.kind === 'internet' ? 'Example Domain' : web.title || srv.name}</title>`, 'pre');
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
  const chips = dev.docker ? ['docker ps -a', 'docker port web', 'curl http://localhost:8080', 'ip addr', 'help'] : dev.tf ? ['ls', 'cat main.tf', 'terraform init', 'terraform plan', 'terraform apply', 'help'] : dev.git ? ['git log --oneline', 'git show HEAD', './backup.sh', 'git status', 'git diff', 'help']
    : dev.ansible ? ['ls', 'cat inventory.ini', `ansible-playbook -i inventory.ini ${dev.ansible.file}`, `ansible-playbook -i inventory.ini ${dev.ansible.file} --check -v`, 'help']
      : ['ip addr', 'ip route', 'ping 8.8.8.8', 'traceroute 8.8.8.8', 'nslookup www.example.com', 'ip neigh', 'help'];
  body.append(term, h('div', { class: 'chips' }, chips.map((x) =>
    h('button', { class: 'chip btnchip', type: 'button', title: x, onclick: () => { hist.push(x); hi = hist.length; run(x); } }, h('span', { class: 'ell', text: x })))));
  draw();
  setTimeout(() => input.focus(), 30);
}
