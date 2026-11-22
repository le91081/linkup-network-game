// 終端機裡的自動化指令：curl（呼叫 REST API）與 ansible-playbook
import { sendApi, sendNetconf } from './panel-auto.js';
import { ansibleRun } from './panel-auto.js';
import { parseYaml, yamlErrorText } from '../engine/yaml.js';

/** 依照 shell 的規則切開參數：單引號、雙引號、反斜線 */
export function shellWords(s) {
  const out = [];
  let cur = '', q = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
    cur += c;
  }
  if (q) return { err: `${q === '"' ? '雙' : '單'}引號沒有結束` };
  if (cur || any) out.push(cur);
  return { words: out };
}

/** 這一行 curl 要不要當成 API 呼叫（有 -X、-u、-H、-d 這類參數，或網址是 /restconf） */
// 帶著 -X / -u / -H / -d 的才是呼叫 API；-k、-v、-I 這些一般的網頁也會用，交給一般的 curl
export const isApiCurl = (line) => /(^|\s)(-[XuHd][a-zA-Z]*|--(request|user|header|data|data-raw))(\s|$)/.test(line) || /\/(restconf|dna)\b/.test(line);

const b64 = (s) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s).toString('base64'));

export function curlApi(app, dev, line, print) {
  const sw = shellWords(line);
  if (sw.err) { print(`curl: ${sw.err}`, 'bad'); return; }
  const w = sw.words.slice(1);
  const r = { method: '', url: '', user: '', pass: '', ctype: '', accept: '', body: '', verify: true, extra: '' };
  let include = false, verbose = false, data = null;
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    const next = () => { if (i + 1 >= w.length) throw new Error(`curl: option ${a}: requires parameter`); return w[++i]; };
    try {
      if (a === '-X' || a === '--request') r.method = next().toUpperCase();
      else if (a === '-u' || a === '--user') { const v = next(); const k = v.indexOf(':'); r.user = k < 0 ? v : v.slice(0, k); r.pass = k < 0 ? '' : v.slice(k + 1); if (k < 0) print(`Enter host password for user '${v}':（這個模擬不會問密碼：請寫成 -u 帳號:密碼）`, 'warn'); }
      else if (a === '-H' || a === '--header') {
        const v = next(), m = v.match(/^([\w-]+)\s*:\s*(.*)$/);
        if (!m) { print(`curl: 標頭的格式是「名稱: 值」，例如 -H 'Accept: application/yang-data+json'（收到的是 ${v}）`, 'warn'); continue; }
        if (/^accept$/i.test(m[1])) r.accept = m[2]; else if (/^content-type$/i.test(m[1])) r.ctype = m[2]; else r.extra += `${m[1]}: ${m[2]}\n`;
      } else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary') data = (data == null ? '' : data + '&') + next();
      else if (a === '-k' || a === '--insecure') r.verify = false;
      else if (a === '-i' || a === '--include') include = true;
      else if (a === '-v' || a === '--verbose') verbose = true;
      else if (a === '-s' || a === '--silent' || a === '-S' || a === '-L' || a === '--location') { /* 不影響結果 */ }
      else if (/^-[kivsSL]{2,}$/.test(a)) { if (a.includes('k')) r.verify = false; if (a.includes('i')) include = true; if (a.includes('v')) verbose = true; }
      else if (a.startsWith('-')) { print(`curl: option ${a}: is unknown`, 'bad'); print("curl: try 'curl --help' for more information", 'dim'); return; }
      else r.url = a;
    } catch (e) { print(e.message, 'bad'); return; }
  }
  if (!r.url) { print('curl: no URL specified!', 'bad'); return; }
  if (/^http:\/\//i.test(r.url)) { print('（RESTCONF 只走 HTTPS：網址要用 https://）', 'hint'); }
  if (data != null) { r.body = data; if (!r.method) r.method = 'POST'; if (!r.ctype) r.ctype = 'application/x-www-form-urlencoded'; }
  r.method ||= 'GET';
  const path = (r.url.match(/^https?:\/\/[^/]+(\/.*)?$/) || [])[1] || '/';
  const host = (r.url.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
  if (verbose) {
    print(`*   Trying ${host}:443...`, 'dim');
  }
  const res = sendApi(app, dev.id, r);
  if (res.error && !res.status) {
    if (res.certErr) {
      if (verbose) print(`* Connected to ${host} port 443`, 'dim');
      print('curl: (60) SSL certificate problem: self-signed certificate', 'bad');
      print('More details here: https://curl.se/docs/sslcerts.html', 'dim');
      print('  ↳ 設備的 HTTPS 憑證是它自己簽的。實驗環境可以加 -k（--insecure）略過驗證；正式環境應該讓設備用公司 CA 簽的憑證。', 'hint');
    } else if (/URL 的格式/.test(res.error)) print(`curl: (3) URL rejected: ${res.error}`, 'bad');
    else { print(`curl: (7) Failed to connect to ${host} port 443 after ${10 + Math.floor(Math.random() * 20)} ms: ${/拒絕|沒有開啟/.test(res.error) ? 'Connection refused' : "Couldn't connect to server"}`, 'bad'); print('  ↳ ' + res.error.replace(/^連不上 [^：]+：/, ''), 'hint'); }
    return;
  }
  if (verbose) {
    print(`* Connected to ${host} port 443`, 'dim');
    print('* SSL connection using TLSv1.2 / ECDHE-RSA-AES256-GCM-SHA384', 'dim');
    print(`> ${r.method} ${path} HTTP/1.1`, 'dim'); print(`> Host: ${host}`, 'dim');
    if (r.user || r.pass) print(`> Authorization: Basic ${b64(`${r.user}:${r.pass}`)}`, 'dim');
    print('> User-Agent: curl/8.5.0', 'dim'); print(`> Accept: ${r.accept || '*/*'}`, 'dim');
    if (r.body) { print(`> Content-Type: ${r.ctype}`, 'dim'); print(`> Content-Length: ${new TextEncoder().encode(r.body).length}`, 'dim'); }
    print('>', 'dim');
  }
  if (include || verbose) {
    const pre = verbose ? '< ' : '';
    print(`${pre}HTTP/1.1 ${res.status} ${res.statusText}`, res.status < 400 ? 'ok' : 'bad');
    print(`${pre}Server: nginx`, 'dim');
    if (res.text) { print(`${pre}Content-Type: ${res.ctype}`, 'dim'); }
    print(`${pre}Cache-Control: private, no-cache, must-revalidate, proxy-revalidate`, 'dim');
    if (verbose) print('<', 'dim'); else print('');
  }
  if (res.text) for (const l of res.text.split('\n')) print(l, 'pre');
  if (!include && !verbose) print(`  ↳ HTTP ${res.status} ${res.statusText}${res.note ? '：' + res.note : ''}`, res.status < 400 ? 'dim' : 'hint');
  else if (res.note) print('  ↳ ' + res.note, 'hint');
}

/** ansible-playbook -i inventory.ini site.yml [--check] [-v] [--limit X] [--syntax-check] */
export function ansibleCmd(app, dev, line, print) {
  const a = dev.ansible;
  const sw = shellWords(line);
  if (sw.err) { print(`-bash: ${sw.err}`, 'bad'); return; }
  const w = sw.words.slice(1);
  const o = { check: false, verbose: false, limit: '' };
  let inv = null, book = null, syntax = false;
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (x === '-i' || x === '--inventory') inv = w[++i];
    else if (x === '-C' || x === '--check') o.check = true;
    else if (/^-v+$/.test(x) || x === '--verbose') o.verbose = true;
    else if (x === '-l' || x === '--limit') o.limit = w[++i] || '';
    else if (x === '--syntax-check') syntax = true;
    else if (x.startsWith('-')) { print(`ansible-playbook: error: unrecognized arguments: ${x}`, 'bad'); return; }
    else book = x;
  }
  if (!book) { print('usage: ansible-playbook [-h] [--version] [-v] [-i INVENTORY] [--check] [--limit SUBSET] playbook [playbook ...]', 'dim'); print('ansible-playbook: error: the following arguments are required: playbook', 'bad'); return; }
  if (book !== a.file) { print(`ERROR! the playbook: ${book} could not be found`, 'bad'); print(`  ↳ 這台主機上的 playbook 是 ${a.file}（用 ls 看看）`, 'hint'); return; }
  if (inv == null) { print('[WARNING]: No inventory was parsed, only implicit localhost is available', 'warn'); print('[WARNING]: provided hosts list is empty, only localhost is available. Note that the implicit localhost does not match \'all\'', 'warn'); print('  ↳ 要用 -i inventory.ini 指定 inventory', 'hint'); return; }
  if (!['inventory.ini', 'inventory', 'hosts', 'hosts.ini'].includes(inv)) { print(`[WARNING]: Unable to parse /home/netops/${inv} as an inventory source`, 'warn'); print('  ↳ inventory 的檔名是 inventory.ini', 'hint'); return; }
  if (syntax) {
    try { parseYaml(a.playbook); print(''); print(`playbook: ${a.file}`); } catch (e) { yamlErrorText(e, a.file).forEach((l, n) => print(l, n === 0 ? 'bad' : 'pre')); }
    return;
  }
  const r = ansibleRun(app, dev.id, o);
  const CLS = { head: 'cmd', ok: 'ok', chg: 'warn', bad: 'bad', skip: 'dim', hint: 'hint', warn: 'warn', dim: 'dim' };
  for (const l of r.lines) print(l.t, l.c === 'hint' ? 'hint' : 'pre ' + (CLS[l.c] || ''));
}

/** netconf-console2 --host=… --port=830 -u … -p … --hello | --get-config（edit-config 要 XML 檔，用 API 分頁的 NETCONF） */
export function netconfCmd(app, dev, line, print) {
  const sw = shellWords(line);
  if (sw.err) { print(`-bash: ${sw.err}`, 'bad'); return; }
  const o = { port: 830, op: '', db: 'running' };
  const w = sw.words.slice(1);
  for (let i = 0; i < w.length; i++) {
    const x = w[i], eq = x.indexOf('='), key = eq > 0 ? x.slice(0, eq) : x, val = eq > 0 ? x.slice(eq + 1) : null;
    const next = () => (val != null ? val : w[++i]);
    if (key === '--host') o.host = next();
    else if (key === '--port') o.port = +next();
    else if (key === '-u' || key === '--user') o.user = next();
    else if (key === '-p' || key === '--password') o.pass = next();
    else if (key === '--hello') o.op = 'hello';
    else if (key === '--get-config') o.op = 'get-config';
    else if (key === '--get') o.op = 'get';
    else if (key === '--db') o.db = next();
    else if (key === '--edit-config') { print('netconf-console2: --edit-config 要讀 XML 檔：這個模擬請用「API」分頁的 NETCONF 模式（可以直接貼 XML）', 'warn'); return; }
    else { print(`netconf-console2: error: unrecognized arguments: ${x}`, 'bad'); return; }
  }
  if (!o.host || !o.op) { print('usage: netconf-console2 --host=HOST [--port=830] -u USER -p PASS (--hello | --get-config | --get) [--db=running]', 'dim'); return; }
  const r = sendNetconf(app, dev.id, o);
  if (r.error) { print(r.error, 'bad'); if (r.why) print('  ↳ ' + r.why, 'hint'); return; }
  for (const l of r.xml.split('\n')) print(l, 'pre');
}

/** Linux 控制主機上的幾個檔案指令 */
export function fileCmd(dev, c, args, print) {
  const a = dev.ansible;
  const files = { 'inventory.ini': a.inventory, [a.file]: a.playbook };
  if (c === 'ls') { print(Object.keys(files).join('  ')); return true; }
  if (c === 'cat' || c === 'less' || c === 'more') {
    if (!args[0]) { print(`${c}: missing operand`, 'bad'); return true; }
    if (!(args[0] in files)) { print(`${c}: ${args[0]}: No such file or directory`, 'bad'); return true; }
    for (const l of files[args[0]].replace(/\n$/, '').split('\n')) print(l, 'pre');
    return true;
  }
  if (c === 'ansible' && args[0] === '--version') { ['ansible [core 2.16.3]', '  config file = /home/netops/ansible.cfg', '  python version = 3.11.6', '  jinja version = 3.1.3', '  libyaml = True'].forEach((l) => print(l, 'pre')); return true; }
  if (c === 'ansible-galaxy' && args[0] === 'collection' && args[1] === 'list') { ['# /home/netops/.ansible/collections/ansible_collections', 'Collection        Version', '----------------- -------', 'ansible.netcommon 6.1.1', 'ansible.utils     3.1.0', 'cisco.ios         8.0.0'].forEach((l) => print(l, 'pre')); return true; }
  return false;
}
