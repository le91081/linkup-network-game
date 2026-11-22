// 自動化主機上的工具：API 用戶端（像 Postman）與 Ansible（ansible-playbook）
import { h, button, ownKeys } from './dom.js';
import { note, cardHead, badge, toggle, inp, field } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { restconf, netconf } from '../engine/restconf.js';
import { runPlaybook, MODULES } from '../engine/automation.js';
import { parseYaml, YamlError } from '../engine/yaml.js';
import { IOS_XE, iosSession, hostName } from '../engine/ios.js';
import { inventory, tplVars, tplLatest, tplCommit, tplDeploy } from '../engine/dnac.js';
import { iosRun } from './cli.js';
import { parseHcl, terraform, tfApplyConfirmed, tfStateJson } from '../engine/terraform.js';

const YANG = 'application/yang-data+json';
const CTYPES = [[YANG, YANG], ['application/yang-data+xml', 'application/yang-data+xml'], ['application/json', 'application/json'], ['', '（不指定）']];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HAS_BODY = new Set(['POST', 'PUT', 'PATCH']);

/** 一個 IOS XE 設備的 IP（拿來當網址的預設值）：優先選和這台電腦同一個網段的介面 */
function guessTarget(state, me) {
  const mine = me && me.ifaces[0] && me.ifaces[0].rt;
  const near = (i) => mine && mine.ip != null && mine.bits != null && i.rt.ip >>> (32 - mine.bits) === mine.ip >>> (32 - mine.bits);
  let any = null;
  for (const d of Object.values(state.devices)) {
    if (!IOS_XE.has(d.model) || !d.mgmt) continue;
    for (const i of d.ifaces) {
      if (!i.rt || i.rt.ip == null) continue;
      if (near(i)) return fmtIp(i.rt.ip);
      any ||= fmtIp(i.rt.ip);
    }
  }
  return any || '192.168.1.1';
}
const TEMPLATES = (ip) => [
  ['讀取介面清單', { method: 'GET', url: `https://${ip}/restconf/data/ietf-interfaces:interfaces`, body: '' }],
  ['讀取一個介面', { method: 'GET', url: `https://${ip}/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0%2F0`, body: '' }],
  ['修改介面說明', { method: 'PATCH', url: `https://${ip}/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0%2F0`, body: JSON.stringify({ 'ietf-interfaces:interface': { name: 'GigabitEthernet0/0/0', description: '說明文字' } }, null, 2) }],
  ['建立 Loopback', { method: 'POST', url: `https://${ip}/restconf/data/ietf-interfaces:interfaces`, body: JSON.stringify({ 'ietf-interfaces:interface': { name: 'Loopback1', description: '', type: 'iana-if-type:softwareLoopback', enabled: true, 'ietf-ip:ipv4': { address: [{ ip: '10.255.255.1', netmask: '255.255.255.255' }] } } }, null, 2) }],
  ['刪除 Loopback', { method: 'DELETE', url: `https://${ip}/restconf/data/ietf-interfaces:interfaces/interface=Loopback1`, body: '' }],
  ['介面的運作狀態', { method: 'GET', url: `https://${ip}/restconf/data/ietf-interfaces:interfaces-state`, body: '' }],
  ['主機名稱', { method: 'GET', url: `https://${ip}/restconf/data/Cisco-IOS-XE-native:native/hostname`, body: '' }],
  ['VLAN 清單', { method: 'GET', url: `https://${ip}/restconf/data/Cisco-IOS-XE-native:native/vlan`, body: '' }],
  ['靜態路由', { method: 'GET', url: `https://${ip}/restconf/data/Cisco-IOS-XE-native:native/ip/route`, body: '' }],
];

/** JSON 的語法檢查：錯在第幾行第幾欄 */
export function jsonCheck(text) {
  if (!text.trim()) return { ok: false, msg: '內容是空的' };
  try { JSON.parse(text); return { ok: true }; } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    let where = '';
    if (m) { const pre = text.slice(0, +m[1]); const line = pre.split('\n').length, col = pre.length - pre.lastIndexOf('\n'); where = `第 ${line} 行第 ${col} 欄：`; }
    const tips = [];
    if (/'/.test(text)) tips.push('JSON 的字串要用雙引號 "，不能用單引號');
    if (/,\s*[}\]]/.test(text)) tips.push('最後一項後面不能有逗號');
    if (/[{,]\s*[A-Za-z_][\w-]*\s*:/.test(text)) tips.push('鍵也要加雙引號');
    return { ok: false, msg: `${where}${e.message.replace(/ in JSON at position \d+.*$/, '')}${tips.length ? '（' + tips.join('；') + '）' : ''}` };
  }
}

/** 等效的 curl 指令（教學用） */
export function curlOf(r) {
  const q = (s) => (/[\s"{}!$&*?;|<>()`\\]/.test(s) ? `'${s}'` : s);
  const parts = ['curl'];
  if (!r.verify) parts.push('-k');
  if (r.method !== 'GET' || HAS_BODY.has(r.method)) parts.push('-X', r.method);
  if (r.user || r.pass) parts.push('-u', q(`${r.user}:${r.pass}`));
  if (r.accept) parts.push('-H', q(`Accept: ${r.accept}`));
  if (HAS_BODY.has(r.method) && r.ctype) parts.push('-H', q(`Content-Type: ${r.ctype}`));
  for (const l of String(r.extra || '').split('\n').filter((x) => /:/.test(x))) parts.push('-H', q(l.trim()));
  if (HAS_BODY.has(r.method) && r.body) parts.push('-d', `'${r.body.replace(/\s*\n\s*/g, ' ')}'`);
  parts.push(r.url);
  return parts.join(' ');
}

const statusKind = (s) => (s >= 200 && s < 300 ? 'on' : s >= 400 ? 'off' : 'warn');

/** 送出請求，回傳要顯示的結果；也記錄在 app 上 */
export function sendApi(app, devId, r) {
  const st = app.state;
  const headers = Object.fromEntries(String(r.extra || '').split('\n').map((l) => l.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1].toLowerCase(), m[2]]));
  const res = restconf(st, devId, { method: r.method, url: r.url, user: r.user, pass: r.pass, contentType: HAS_BODY.has(r.method) ? r.ctype : '', accept: r.accept, body: HAS_BODY.has(r.method) ? r.body : '', verify: r.verify, headers });
  const out = { ...res, at: Date.now(), req: { ...r }, ms: res.res ? 12 + (res.res.hops || []).length * 3 + (res.status === 201 || res.status === 204 ? 40 : 0) : 0 };
  // 封包追蹤的結果：TCP 連上了不代表成功——憑證被拒絕、HTTP 4xx 都算失敗
  const verdict = !res.res ? null : res.certErr ? { ...res.res, ok: false, reason: 'TCP 連上了，但 TLS 交握時用戶端拒絕了設備自己簽的憑證（SSL certificate problem）', failDev: devId }
    : res.res.ok && res.status ? { ...res.res, ok: res.status < 400, reason: `HTTP ${res.status} ${res.statusText}`, failDev: res.status >= 400 ? res.dev : undefined } : res.res;
  if (res.res) app.showTrace(`${st.devices[devId].name} → ${r.method} ${r.url.replace(/^https:\/\/[^/]+/, '')}`, res.res.log, res.res.hops, verdict);
  return out;
}

/** NETCONF 的範本：建立 Loopback 並設定描述與 IP */
const NC_TEMPLATE = '<config>\n  <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">\n    <interface>\n      <name>Loopback100</name>\n      <description>MGMT</description>\n      <type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:softwareLoopback</type>\n      <enabled>true</enabled>\n      <ipv4 xmlns="urn:ietf:params:xml:ns:yang:ietf-ip">\n        <address>\n          <ip>10.255.255.1</ip>\n          <netmask>255.255.255.255</netmask>\n        </address>\n      </ipv4>\n    </interface>\n  </interfaces>\n</config>';
/** 等效的 netconf-console2 指令 */
export const ncCmd = (n) => `netconf-console2 --host=${n.host || '<IP>'} --port=${n.port || 830} -u ${n.user || '<帳號>'} -p ${n.pass ? '********' : '<密碼>'} ${n.op === 'hello' ? '--hello' : n.op === 'edit-config' ? `--db=${n.db || 'running'} --edit-config=edit.xml` : `--db=${n.db || 'running'} --get-config`}`;
export function sendNetconf(app, devId, n) {
  const st = app.state, r = netconf(st, devId, { host: n.host, port: n.port, user: n.user, pass: n.pass, op: n.op, target: n.db, source: n.db, config: n.xml });
  if (r.res) app.showTrace(`${st.devices[devId].name} → NETCONF ${n.op}`, r.res.log, r.res.hops, r.res.ok ? { ...r.res, ok: r.ok, reason: r.ok ? '' : r.error || 'rpc-error', failDev: r.ok ? undefined : r.dev } : r.res);
  return r;
}
/** API 分頁的 NETCONF 模式：SSH 的 830 埠、XML 的 RPC */
function netconfPanel(ctx, body, ui) {
  const { app, dev, state } = ctx;
  const n = (ui.nc ||= { host: guessTarget(state, dev), port: 830, user: '', pass: '', op: 'hello', db: 'running', xml: NC_TEMPLATE });
  const rerender = () => app.renderPanel();
  const fld = (label, el) => h('label', { class: 'field' }, h('span', { class: 'f-label', text: label }), el);
  const txt = (k, ph, type = 'text') => h('input', { class: 'inp mono', type, value: n[k], placeholder: ph, spellcheck: 'false', autocomplete: 'off', oninput: (e) => { n[k] = e.target.value; cmd.textContent = ncCmd(n); } });
  const sel = (k, opts) => h('select', { class: 'inp sel', onchange: (e) => { n[k] = e.target.value; rerender(); } }, opts.map(([v, t]) => h('option', { value: v, selected: v === n[k], text: t })));
  body.append(h('p', { class: 'tip', text: 'NETCONF：用 SSH 連到設備的 830 埠，送 XML 格式的 RPC。<hello> 交換彼此支援的功能 (capabilities)，<get-config> 讀出設定，<edit-config> 修改設定。IOS XE 要先 netconf-yang，帳號是 privilege 15 的本機帳號；資料模型和 RESTCONF 一樣是 YANG。' }));
  const area = n.op === 'edit-config' && h('textarea', { class: 'code', rows: 14, spellcheck: 'false', wrap: 'off', value: n.xml, oninput: (e) => { n.xml = e.target.value; } });
  if (area) area.addEventListener('keydown', (e) => { if (codeKey(area, e)) n.xml = area.value; ownKeys(e); });
  const cmd = h('div', { class: 'api-curl mono', text: ncCmd(n) });
  const send = () => { n.last = sendNetconf(app, dev.id, n); ctx.commit(false); rerender(); };
  body.append(h('div', { class: 'card api-req' }, cardHead('NETCONF 請求'),
    h('div', { class: 'grid2' }, fld('設備 (--host)', txt('host', '10.0.0.1')), fld('埠 (--port)', txt('port', '830')), fld('帳號', txt('user', 'admin')), fld('密碼', txt('pass', '', 'password')),
      fld('操作', sel('op', [['hello', '<hello>（看看設備支援什麼）'], ['get-config', '<get-config>（讀設定）'], ['edit-config', '<edit-config>（改設定）']])),
      n.op !== 'hello' ? fld('資料庫 (datastore)', sel('db', [['running', 'running'], ['candidate', 'candidate']])) : h('span')),
    area && fld('<config> 的內容 (edit.xml)', area),
    h('div', { class: 'addrow' }, button('送出', { ic: 'play', kind: 'primary', small: true, onclick: send }), area && button('範本：建立 Loopback100', { small: true, onclick: () => { n.xml = NC_TEMPLATE; rerender(); } })),
    h('div', { class: 'f-label', text: '等效的指令（也可以在終端機輸入 --hello 或 --get-config）' }), cmd));
  const r = n.last;
  if (r) body.append(h('div', { class: 'card api-resp' }, cardHead('回應', r.ok ? badge('on', r.xml && r.xml.includes('<ok/>') ? '<ok/>' : 'OK') : badge('off', r.xml ? 'rpc-error' : '失敗')),
    r.error && note('warn', r.error), r.why && note('muted', r.why), r.xml ? h('pre', { class: 'api-body mono', text: r.xml }) : null));
}

export function apiTab(ctx, body) {
  const { app, dev, state } = ctx;
  const ui = ((app.apiUi ||= {})[dev.id] ||= { method: 'GET', url: `https://${guessTarget(state, dev)}/restconf/data/ietf-interfaces:interfaces`, user: '', pass: '', ctype: YANG, accept: '', body: '', verify: true, hist: [] });
  const rerender = () => app.renderPanel();
  body.append(h('div', { class: 'seg' }, [['restconf', 'RESTCONF（HTTPS + JSON）'], ['netconf', 'NETCONF（SSH + XML）']].map(([v, t]) => h('button', { type: 'button', class: (ui.proto || 'restconf') === v ? 'on' : '', onclick: () => { ui.proto = v; rerender(); } }, t))));
  if (ui.proto === 'netconf') { netconfPanel(ctx, body, ui); return; }
  const set = (k) => (e) => { ui[k] = e.target.value; };
  body.append(h('p', { class: 'tip', text: '用 HTTPS 呼叫設備的 REST API（RESTCONF）。方法 + 網址決定要對哪一份資料做什麼，帳號密碼用 HTTP Basic 驗證；寫入的內容是 JSON。按「送出」會看到封包真的從這台電腦出發。' }));

  // ── 請求 ──
  const url = h('input', { class: 'inp mono', value: ui.url, spellcheck: 'false', autocomplete: 'off', oninput: set('url'), style: { flex: '1' } });
  const method = h('select', { class: 'inp sel api-method', onchange: (e) => { ui.method = e.target.value; rerender(); } }, METHODS.map((m) => h('option', { value: m, selected: m === ui.method, text: m })));
  const fld = (label, el) => h('label', { class: 'field' }, h('span', { class: 'f-label', text: label }), el);
  const txt = (k, ph, type = 'text') => h('input', { class: 'inp mono', type, value: ui[k], placeholder: ph, spellcheck: 'false', autocomplete: 'off', oninput: set(k) });
  const sel = (k, opts) => h('select', { class: 'inp sel', onchange: (e) => { ui[k] = e.target.value; rerender(); } }, opts.map(([v, t]) => h('option', { value: v, selected: v === ui[k], text: t })));
  const lint = h('div', { class: 'api-lint' });
  const doLint = () => {
    if (!HAS_BODY.has(ui.method)) return;
    const c = jsonCheck(ui.body);
    lint.replaceChildren(c.ok ? note('ok', 'JSON 格式正確') : note(ui.body.trim() ? 'warn' : 'muted', c.msg));
  };
  // 取得 Token 的請求不需要內容（帳號密碼放在 Basic Auth）
  const tokenReq = /\/auth\/token\/?$/.test(ui.url);
  const area = HAS_BODY.has(ui.method) && !tokenReq && h('textarea', { class: 'code', rows: 9, spellcheck: 'false', value: ui.body, placeholder: '{\n  "ietf-interfaces:interface": { … }\n}', oninput: (e) => { ui.body = e.target.value; doLint(); } });
  if (area) area.addEventListener('keydown', (e) => { if (codeKey(area, e)) { ui.body = area.value; doLint(); curl.textContent = curlOf(ui); } ownKeys(e); });
  const curl = h('div', { class: 'api-curl mono', text: curlOf(ui) });
  const send = () => {
    if (HAS_BODY.has(ui.method)) { const c = jsonCheck(ui.body); if (!c.ok && ui.body.trim()) { /* 照樣送出：讓設備回 400，和真的一樣 */ } }
    const r = sendApi(app, dev.id, ui);
    ui.last = r;
    if (r.status === 200 && r.body && r.body.Token) ui.lastToken = r.body.Token;
    ui.hist.unshift({ method: ui.method, url: ui.url, status: r.status, body: ui.body });
    ui.hist.length = Math.min(ui.hist.length, 8);
    ui.scrollToResp = true;
    ctx.commit(false);
    rerender();
  };
  body.append(h('div', { class: 'card api-req' }, cardHead('請求'),
    h('div', { class: 'api-line' }, method, url),
    h('div', { class: 'grid2' }, fld('帳號（Basic Auth）', txt('user', '例如 admin')), fld('密碼', txt('pass', '', 'password')),
      fld('Accept（要什麼格式的回應）', sel('accept', CTYPES)), HAS_BODY.has(ui.method) ? fld('Content-Type（送出的內容格式）', sel('ctype', CTYPES)) : h('span')),
    fld('其他標頭（一行一個，例如 X-Auth-Token: …）', (() => { const t = h('textarea', { class: 'code api-hdr', rows: 2, spellcheck: 'false', value: ui.extra || '', placeholder: 'X-Auth-Token: eyJ0eXAi…', oninput: (e) => { ui.extra = e.target.value; curl.textContent = curlOf(ui); } }); t.addEventListener('keydown', ownKeys); return t; })()),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ui.verify, onchange: (e) => { ui.verify = e.target.checked; rerender(); } }), h('i'), h('span', { text: '驗證 SSL 憑證（設備用的是自己簽的憑證時要關掉，curl 是 -k）' })),
    area && fld('內容 (Body)', area), area && lint,
    HAS_BODY.has(ui.method) && tokenReq && note('muted', '取得 Token 不需要內容：帳號密碼放在上面的 Basic Auth，回應裡的 Token 之後放在 X-Auth-Token 標頭。'),
    h('div', { class: 'addrow' },
      button('送出', { ic: 'play', kind: 'primary', small: true, onclick: send }),
      area && button('整理 JSON', { small: true, onclick: () => { try { ui.body = JSON.stringify(JSON.parse(ui.body), null, 2); area.value = ui.body; doLint(); } catch { doLint(); } } })),
    h('details', { class: 'api-tpl' }, h('summary', { text: '範本' }),
      h('div', { class: 'chips' }, [...dnacTemplates(state, ui), ...TEMPLATES(urlHost(ui.url) || guessTarget(state, dev))].map(([t, o]) => h('button', { class: 'chip btnchip', type: 'button', text: t, onclick: () => { Object.assign(ui, { ctype: YANG, accept: YANG }, o); rerender(); } })))),
    h('div', { class: 'f-label', text: '等效的 curl 指令（也可以在終端機直接輸入）' }), curl));
  url.addEventListener('input', () => { curl.textContent = curlOf(ui); });
  for (const el of body.querySelectorAll('.api-req input, .api-req select')) el.addEventListener('input', () => { curl.textContent = curlOf(ui); });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); ownKeys(e); });
  doLint();

  // ── 回應 ──
  const r = ui.last;
  if (r) {
    const st = r.status ? badge(statusKind(r.status), `${r.status} ${r.statusText}`) : badge('off', r.certErr ? 'SSL 錯誤' : '連線失敗');
    const meta = r.status ? h('div', { class: 'muted mono api-meta', text: `${r.ms} ms · ${new Blob([r.text || '']).size} B${r.ctype ? ' · ' + r.ctype : ''}` }) : null;
    const card = h('div', { class: 'card api-resp' }, cardHead('回應', st), meta,
      r.error && note('warn', r.certErr ? `${r.error}：設備的 HTTPS 憑證是它自己簽的，不是公認的憑證機構簽發。實驗環境可以取消「驗證 SSL 憑證」；正式環境應該替設備換上公司 CA 簽的憑證。` : r.error),
      r.text ? h('pre', { class: 'api-body mono', text: r.text }) : r.status ? h('div', { class: 'muted', text: '（沒有內容）' }) : null,
      !!r.status && r.ctype === 'application/yang-data+xml' && note('muted', '回應是 XML：請求沒有說要什麼格式時，IOS XE 預設回 XML。要 JSON 的話，Accept 選 application/yang-data+json。'),
      r.note && note(r.status >= 400 ? 'warn' : 'muted', r.note));
    body.append(card);
    // 剛送出：把回應捲進畫面（面板重畫之後才量得到位置）
    if (ui.scrollToResp) {
      ui.scrollToResp = false;
      requestAnimationFrame(() => { const top = card.getBoundingClientRect().top - body.getBoundingClientRect().top; if (top > body.clientHeight - 120 || top < 0) body.scrollTop += top - 12; });
    }
  }
  if (ui.hist.length) {
    body.append(h('div', { class: 'card' }, cardHead('最近的請求'), ui.hist.map((x) => h('button', {
      class: 'api-hist', type: 'button', onclick: () => { Object.assign(ui, { method: x.method, url: x.url, body: x.body || '' }); rerender(); },
    }, h('b', { class: 'mono', text: x.method }), h('span', { class: 'mono', text: x.url.replace(/^https:\/\/[^/]+/, '') }), x.status ? badge(statusKind(x.status), String(x.status)) : badge('off', '失敗')))));
  }
}
/** Catalyst Center 的範本（拿 Token、設備清單、問題清單） */
function dnacTemplates(state, ui) {
  const c = Object.values(state.devices).find((d) => d.dnac);
  const ip = c && c.ifaces[0] && c.ifaces[0].ip;
  if (!ip) return [];
  const last = (ui.lastToken && `X-Auth-Token: ${ui.lastToken}`) || ui.extra || '';
  return [
    ['Catalyst Center：取得 Token', { method: 'POST', url: `https://${ip}/dna/system/api/v1/auth/token`, body: '', extra: '', accept: 'application/json', ctype: 'application/json' }],
    ['Catalyst Center：設備清單', { method: 'GET', url: `https://${ip}/dna/intent/api/v1/network-device`, body: '', extra: last, accept: 'application/json' }],
    ['Catalyst Center：問題清單', { method: 'GET', url: `https://${ip}/dna/intent/api/v1/issues`, body: '', extra: last, accept: 'application/json' }],
  ];
}
const urlHost = (u) => (String(u).match(/^https?:\/\/([\d.]+)/) || [])[1];
function insertAt(el, s) {
  const a = el.selectionStart, b = el.selectionEnd;
  el.value = el.value.slice(0, a) + s + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + s.length;
}
/**
 * 程式碼編輯框的按鍵（YAML / JSON 用空白縮排）：
 * Tab 插入兩個空白，選了好幾行就整段往右縮；Shift + Tab 往左縮；Enter 新的一行沿用目前的縮排（行尾是「:」、「{」、「[」再多縮一層）。
 * 回傳 true 表示內容有變
 */
export function codeKey(el, e) {
  const v = el.value, a = el.selectionStart, b = el.selectionEnd;
  const lineStart = (i) => v.lastIndexOf('\n', i - 1) + 1;
  if (e.key === 'Tab') {
    e.preventDefault();
    const s0 = lineStart(a), multi = v.slice(a, b).includes('\n');
    if (!e.shiftKey && !multi) { insertAt(el, '  '); return true; }
    const end = b > a && v[b - 1] === '\n' ? b - 1 : b;
    const lines = v.slice(s0, end).split('\n');
    let first = 0, total = 0;
    const out = lines.map((l, i) => {
      if (!e.shiftKey) { if (i === 0) first = 2; total += 2; return '  ' + l; }
      const n = Math.min(2, l.match(/^ */)[0].length);
      if (i === 0) first = -n;
      total -= n;
      return l.slice(n);
    });
    el.value = v.slice(0, s0) + out.join('\n') + v.slice(end);
    el.selectionStart = Math.max(s0, a + first);
    el.selectionEnd = Math.max(el.selectionStart, end + total + (b - end));
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const s0 = lineStart(a), cur = v.slice(s0, a);
    const ind = cur.match(/^ */)[0] + (/[:{[]\s*$/.test(cur) ? '  ' : '') + (/^\s*- /.test(cur) && /:\s*$/.test(cur) ? '  ' : '');
    e.preventDefault();
    insertAt(el, '\n' + ind);
    return true;
  }
  return false;
}

// ───────────────────────── Ansible ─────────────────────────

const DEFAULT_INV = `[switches]
sw1 ansible_host=192.168.1.2

[switches:vars]
ansible_connection=ansible.netcommon.network_cli
ansible_network_os=cisco.ios.ios
ansible_user=admin
ansible_password=admin
`;
const DEFAULT_PB = `---
- name: 查看交換器
  hosts: switches
  gather_facts: no
  tasks:
    - name: show version
      cisco.ios.ios_command:
        commands:
          - show version
      register: out

    - name: 印出結果
      ansible.builtin.debug:
        var: out.stdout_lines
`;
const CLS = { head: 'cmd', ok: 'ok', chg: 'warn', bad: 'bad', skip: 'dim', hint: 'hint', warn: 'warn', dim: 'dim', '': '' };

/** 跑 playbook（Ansible 分頁的按鈕與終端機的 ansible-playbook 共用） */
export function ansibleRun(app, devId, o = {}) {
  const st = app.state, d = st.devices[devId], a = d.ansible;
  const show = (state, id, sess, line) => { const out = []; iosRun({ state }, id, sess, line, (t) => out.push(t)); return out; };
  const r = runPlaybook(st, devId, { inventory: a.inventory, playbook: a.playbook, file: a.file, check: !!o.check, verbose: !!o.verbose, limit: o.limit || '', show });
  // 畫面上播放一條連線：有失敗的就播失敗的那一條
  const tr = r.traces.find((t) => !t.res.ok) || r.traces[0];
  if (tr) app.showTrace(`${d.name} → ${tr.host}（SSH）`, tr.res.log, tr.res.hops, tr.res);
  if (r.secs) app.tick(r.secs);
  return r;
}
void iosSession;

export function ansibleTab(ctx, body) {
  const { app, dev } = ctx;
  const a = (dev.ansible ||= { inventory: DEFAULT_INV, playbook: DEFAULT_PB, file: 'site.yml' });
  const ui = ((app.ansUi ||= {})[dev.id] ||= { file: 'pb', check: false, verbose: false, limit: '', out: null });
  const rerender = () => app.renderPanel();
  body.append(h('p', { class: 'tip', text: 'Ansible 控制主機：inventory 列出受管的設備與登入方式，playbook 用 YAML 描述要的結果。執行時會用 SSH 一台一台登入設備下指令，最後的 PLAY RECAP 列出每台的結果。' }));
  const key = ui.file === 'inv' ? 'inventory' : 'playbook';
  const area = h('textarea', { class: 'code ans-edit', rows: 14, spellcheck: 'false', value: a[key], wrap: 'off' });
  const lint = h('div', { class: 'api-lint' });
  const doLint = () => {
    if (ui.file === 'inv') { lint.replaceChildren(); return; }
    try { parseYaml(area.value); lint.replaceChildren(note('ok', 'YAML 語法正確')); } catch (e) { lint.replaceChildren(note('warn', e instanceof YamlError ? `第 ${e.line} 行第 ${e.col} 欄：${e.message}` : e.message)); }
  };
  area.addEventListener('keydown', (e) => { if (codeKey(area, e)) doLint(); ownKeys(e); });
  area.addEventListener('input', doLint);
  area.addEventListener('change', () => { a[key] = area.value; ctx.commit(false); });
  const fileBtn = (id, label) => h('button', { type: 'button', class: ui.file === id ? 'on' : '', onclick: () => { a[key] = area.value; ui.file = id; ctx.commit(false); rerender(); } }, label);
  const cmd = () => `ansible-playbook -i inventory.ini ${a.file}${ui.check ? ' --check' : ''}${ui.verbose ? ' -v' : ''}${ui.limit ? ' --limit ' + ui.limit : ''}`;
  const cmdEl = h('div', { class: 'api-curl mono', text: '$ ' + cmd() });
  const run = () => {
    a[key] = area.value;
    const r = ansibleRun(app, dev.id, ui);
    ui.out = { cmd: cmd(), lines: r.lines, rc: r.rc };
    ui.scrollToOut = true;
    ctx.commit(false);
    rerender();
  };
  // 執行鈕放在編輯框上面：編輯框很高，放在下面要捲很久才按得到
  const bar = h('div', { class: 'ans-bar' }, cmdEl, button('執行', { ic: 'play', kind: 'primary', small: true, onclick: run }));
  body.append(h('div', { class: 'card' }, h('div', { class: 'seg' }, fileBtn('inv', 'inventory.ini'), fileBtn('pb', a.file)), bar, area, lint,
    h('div', { class: 'toggles' },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ui.check, onchange: (e) => { ui.check = e.target.checked; cmdEl.textContent = '$ ' + cmd(); } }), h('i'), h('span', { text: '--check：只算出要改什麼，不真的改（乾跑）' })),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ui.verbose, onchange: (e) => { ui.verbose = e.target.checked; cmdEl.textContent = '$ ' + cmd(); } }), h('i'), h('span', { text: '-v：顯示每個 task 的結果（例如送出的指令）' }))),
    h('label', { class: 'field' }, h('span', { class: 'f-label', text: '--limit（只對這些主機執行，空白表示全部）' }),
      h('input', { class: 'inp mono', value: ui.limit, placeholder: '例如 sw-c 或 access', spellcheck: 'false', oninput: (e) => { ui.limit = e.target.value.trim(); cmdEl.textContent = '$ ' + cmd(); }, onkeydown: ownKeys }))));
  doLint();
  if (ui.out) {
    const outCard = h('div', { class: 'card' }, cardHead('輸出', badge(ui.out.rc === 0 ? 'on' : 'off', `結束代碼 ${ui.out.rc}`)),
      h('div', { class: 'term ans-out' }, h('div', { class: 'term-out' }, h('div', { class: 'tl cmd', text: '$ ' + ui.out.cmd }), ...ui.out.lines.map((l) => (l.c === 'head'
        // PLAY / TASK 的標題：星號填滿這一行的寬度（終端機是 80 欄，面板比較窄）
        ? h('div', { class: 'tl ans-head' }, h('span', { text: l.t.replace(/\s*\*+$/, '') }), h('span', { class: 'stars' }))
        : h('div', { class: `tl ${CLS[l.c] ?? ''}${/^\S+\s+: ok=/.test(l.t) ? ' recap' : ''}`, text: l.t || ' ' }))))));
    body.append(outCard);
    // 剛執行完：把輸出捲進畫面
    if (ui.scrollToOut) { ui.scrollToOut = false; requestAnimationFrame(() => { body.scrollTop += outCard.getBoundingClientRect().top - body.getBoundingClientRect().top - 12; }); }
  }
  body.append(h('details', { class: 'card api-tpl' }, h('summary', { text: '支援的模組' }),
    h('div', { class: 'mono muted ans-mods', text: [
      'cisco.ios.ios_vlans        config: [{vlan_id, name}]  state: merged | replaced | overridden | deleted',
      'cisco.ios.ios_l2_interfaces config: [{name, mode, access: {vlan}, trunk: {allowed_vlans, native_vlan}}]',
      'cisco.ios.ios_interfaces   config: [{name, description, enabled}]',
      'cisco.ios.ios_l3_interfaces config: [{name, ipv4: [{address: 10.0.0.1/24}]}]',
      'cisco.ios.ios_config       lines: [...]  parents: [...]  save_when: modified',
      'cisco.ios.ios_command      commands: [show ...]（搭配 register 與 debug）',
      'cisco.ios.ios_facts        取得 ansible_net_version 等資訊',
      'ansible.builtin.debug      msg: 或 var:',
      'ansible.builtin.assert     that: [...]',
      'task 的選項：name、register、loop、when、ignore_errors、check_mode、changed_when',
    ].join('\n') }), h('div', { class: 'muted', text: `（共 ${MODULES.length} 個模組）` })));
  void toggle;
}

// ───────────────────────── Terraform ─────────────────────────

const TF_CMDS = [['init', 'init'], ['validate', 'validate'], ['plan', 'plan'], ['apply', 'apply']];
const tfLine = (l) => h('div', { class: `tl tf ${l.c || ''}`, text: l.t || ' ' });

export function terraformTab(ctx, body) {
  const { app, dev } = ctx, tf = dev.tf;
  const ui = ((app.tfUi ||= {})[dev.id] ||= { file: 'main', out: null, ask: false });
  const rerender = () => app.renderPanel();
  const isMain = ui.file === 'main';
  body.append(h('p', { class: 'tip', text: 'Terraform 控制主機：main.tf 用 HCL 描述雲端資源「應該長什麼樣子」。plan 先讀取雲端現況，列出要新增 (+)、修改 (~)、刪除 (-) 的地方；apply 要你回答 yes 才真的去改。' }));
  const area = h('textarea', { class: 'code ans-edit', rows: 16, spellcheck: 'false', wrap: 'off', value: isMain ? tf.main : tfStateJson(tf) });
  area.readOnly = !isMain;
  const lint = h('div', { class: 'api-lint' });
  const doLint = () => {
    if (!isMain) { lint.replaceChildren(note('info', '唯讀：state 是 Terraform 自己維護的，不要手動改')); return; }
    try { parseHcl(area.value); lint.replaceChildren(note('ok', 'HCL 語法正確')); } catch (e) { lint.replaceChildren(note('warn', e.hcl ? `第 ${e.line} 行：${e.message}` : e.message)); }
  };
  if (isMain) {
    area.addEventListener('keydown', (e) => { if (codeKey(area, e)) doLint(); ownKeys(e); });
    area.addEventListener('input', doLint);
    area.addEventListener('change', () => { tf.main = area.value; ui.ask = false; ctx.commit(false); });
  }
  const fileBtn = (id, label) => h('button', { type: 'button', class: ui.file === id ? 'on' : '', onclick: () => { if (isMain) tf.main = area.value; ui.file = id; ctx.commit(false); rerender(); } }, label);
  const run = (args) => {
    if (isMain) tf.main = area.value;
    const r = terraform(app.state, dev.id, args);
    ui.out = { cmd: 'terraform ' + args.join(' '), lines: r.lines, rc: r.rc };
    ui.ask = !!r.ask;
    ui.scrollToOut = true;
    ctx.commit(false);
    rerender();
  };
  const answer = (yes) => {
    const r = yes ? tfApplyConfirmed(app.state, dev.id) : { lines: [{ t: 'Apply cancelled.', c: 'bad' }], rc: 1 };
    ui.out = { cmd: ui.out.cmd, lines: [...ui.out.lines.slice(0, -1), { t: '  Enter a value: ' + (yes ? 'yes' : 'no'), c: 'head' }, { t: '' }, ...r.lines], rc: r.rc };
    ui.ask = false;
    ui.scrollToOut = true;
    ctx.commit(false);
    rerender();
  };
  const bar = h('div', { class: 'ans-bar tf-bar' }, h('span', { class: 'mono muted', text: '$ terraform' }),
    ...TF_CMDS.map(([sub, label]) => button(label, { kind: sub === 'apply' ? 'primary' : undefined, small: true, onclick: () => run([sub]) })));
  body.append(h('div', { class: 'card' }, h('div', { class: 'seg' }, fileBtn('main', 'main.tf'), fileBtn('state', 'terraform.tfstate')), bar, area, lint));
  doLint();
  if (ui.out) {
    const outCard = h('div', { class: 'card' }, cardHead('輸出', badge(ui.out.rc === 0 ? 'on' : 'off', `結束代碼 ${ui.out.rc}`)),
      h('div', { class: 'term ans-out' }, h('div', { class: 'term-out' }, h('div', { class: 'tl cmd', text: '$ ' + ui.out.cmd }), ...ui.out.lines.map(tfLine))),
      ui.ask && h('div', { class: 'ans-bar tf-ask' }, h('span', { text: '確定要照上面的計畫修改雲端嗎？' }),
        button('yes', { kind: 'primary', small: true, onclick: () => answer(true) }), button('取消', { small: true, onclick: () => answer(false) })));
    body.append(outCard);
    if (ui.scrollToOut) { ui.scrollToOut = false; requestAnimationFrame(() => { body.scrollTop += outCard.getBoundingClientRect().top - body.getBoundingClientRect().top - 12; }); }
  }
  body.append(h('details', { class: 'card api-tpl' }, h('summary', { text: '支援的語法' }),
    h('div', { class: 'mono muted ans-mods', text: [
      'terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }',
      'provider "aws" { region = "ap-northeast-1" }',
      'resource "aws_security_group" "名稱" {',
      '  name   = "web"            vpc_id = "vpc-…"',
      '  ingress { from_port = 443  to_port = 443  protocol = "tcp"  cidr_blocks = ["0.0.0.0/0"] }',
      '  egress  { from_port = 0    to_port = 0    protocol = "-1"   cidr_blocks = ["0.0.0.0/0"] }',
      '}',
      'protocol：tcp、udp、icmp、"-1"（全部）· 來源也可以寫 security_groups = ["sg-…"]',
      '指令：init、validate、plan、apply（-auto-approve、-refresh-only）、import <位址> <ID>、state list',
    ].join('\n') })));
}

// ───────────────────────── Catalyst Center（設備清單、範本、部署） ─────────────────────────

export function dnacTab(ctx, body) {
  const { app, state, dev } = ctx, C = dev.dnac;
  const ui = ((app.dnacUi ||= {})[dev.id] ||= { tpl: null, sel: {}, msg: '', note: null, out: null });
  const rerender = () => app.renderPanel();
  body.append(h('p', { class: 'tip', text: 'Catalyst Center：把標準設定寫成範本，每台不同的地方用變數（$hostname）表示。編輯的是草稿，提交 (commit) 之後才是新的版本；部署時控制器用 SSH 登入每一台設備，送出最新提交的版本。' }));
  // 設備清單（只顯示控制器看得到的：可達性與失敗的類型）
  const inv = inventory(state, dev), okN = inv.filter((x) => x.json.reachabilityStatus === 'Reachable').length;
  body.append(h('div', { class: 'card' }, cardHead('設備清單', badge(okN === inv.length ? 'on' : 'off', `${okN} / ${inv.length} Reachable`)),
    h('div', { class: 'dn-list' }, inv.map((x) => h('div', { class: 'dn-row' },
      h('b', { class: 'mono', text: x.json.hostname }), h('span', { class: 'mono muted', text: x.json.managementIpAddress }),
      h('span', { class: 'mono muted', text: x.json.platformId }),
      badge(x.json.reachabilityStatus === 'Reachable' ? 'on' : 'off', x.json.reachabilityStatus + (x.json.reachabilityFailureReason ? `（${x.json.reachabilityFailureReason}）` : '')))))));
  const T = C.templates || [];
  if (!T.length) { body.append(note('info', '範本庫 (Template Hub) 裡還沒有任何範本。')); return; }
  const t = T.find((x) => x.id === ui.tpl) || T[0];
  const last = tplLatest(t), dirty = !last || last.text !== t.draft;
  // 範本編輯器
  const area = h('textarea', { class: 'code ans-edit dn-edit', rows: 13, spellcheck: 'false', wrap: 'off', value: t.draft });
  const varsEl = h('div', { class: 'api-lint' });
  const showVars = () => { const v = tplVars(area.value); varsEl.replaceChildren(note(v.length ? 'ok' : 'info', v.length ? `變數：${v.map((x) => '$' + x).join('、')}` : '這個範本沒有變數（每台都送一樣的設定）')); };
  area.addEventListener('keydown', (e) => { if (codeKey(area, e)) showVars(); ownKeys(e); });
  area.addEventListener('input', showVars);
  area.addEventListener('change', () => { t.draft = area.value; ctx.commit(false); rerender(); });
  const msgIn = h('input', { class: 'inp', placeholder: '提交說明（例如：加上 logging host）', value: ui.msg, spellcheck: 'false', oninput: (e) => { ui.msg = e.target.value; }, onkeydown: ownKeys });
  const doCommit = () => {
    t.draft = area.value;
    const r = tplCommit(state, dev, t.id, ui.msg);
    ui.note = r.error ? ['warn', r.error] : ['ok', `已提交 v${r.ver.v}：${r.ver.msg}`];
    if (r.ok) ui.msg = '';
    ctx.commit(false);
    rerender();
  };
  body.append(h('div', { class: 'card' },
    cardHead(`${t.project} / ${t.name}`, badge(dirty ? 'off' : 'on', last ? `已提交 v${last.v}${dirty ? '・草稿已修改' : ''}` : '還沒有提交')),
    T.length > 1 && h('div', { class: 'seg' }, T.map((x) => h('button', { type: 'button', class: x === t ? 'on' : '', onclick: () => { ui.tpl = x.id; rerender(); } }, x.name))),
    area, varsEl,
    h('div', { class: 'ans-bar' }, msgIn, button('提交', { ic: 'check', kind: 'primary', small: true, onclick: doCommit })),
    ui.note && note(ui.note[0], ui.note[1]),
    h('details', { class: 'dn-vers' }, h('summary', { text: `版本紀錄（${t.versions.length}）` }),
      t.versions.slice().reverse().map((v) => h('details', { class: 'dn-ver' }, h('summary', {}, h('b', { class: 'mono', text: `v${v.v}` }), h('span', { text: ` ${v.msg}` }), h('span', { class: 'muted mono', text: ` · ${v.by}` })),
        h('pre', { class: 'mono dn-cfg', text: v.text.replace(/\n$/, '') }))))));
  showVars();
  // 部署：每台設備填自己的變數
  const vars = last ? tplVars(last.text) : [];
  const P = (C.params ||= {});
  const sel = (id) => ui.sel[id] ?? true;
  const rows = (C.managed || []).map((m) => {
    const d = state.devices[m.id], pv = (P[m.id] ||= {});
    return h('div', { class: 'dn-target' + (sel(m.id) ? '' : ' off') },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: sel(m.id), onchange: (e) => { ui.sel[m.id] = e.target.checked; rerender(); } }), h('i'), h('span', { class: 'mono', text: `${d ? hostName(d) : m.id} · ${m.ip}` })),
      sel(m.id) && vars.length ? h('div', { class: 'grid2' }, vars.map((k) => field('$' + k, inp(ctx, () => pv[k], (v) => { pv[k] = v; }, { ph: '必填' })))) : null);
  });
  const deploy = () => {
    const targets = (C.managed || []).filter((m) => sel(m.id)).map((m) => ({ dev: m.id, params: { ...(P[m.id] || {}) } }));
    ui.out = tplDeploy(state, dev, t.id, targets);
    ui.scrollToOut = true;
    ctx.commit(false);
    rerender();
  };
  body.append(h('div', { class: 'card' }, cardHead('部署 (Provision)', h('span', { class: 'muted', text: last ? `${t.name} v${last.v}` : '' })),
    !last ? note('warn', '範本還沒有提交過，不能部署') : dirty ? note('warn', `草稿有未提交的修改：部署會送出已提交的 v${last.v}，不是編輯框裡的內容`) : null,
    rows,
    h('div', { class: 'ans-bar' }, button('部署到選取的設備', { ic: 'play', kind: 'primary', small: true, onclick: deploy }))));
  // 部署結果
  if (ui.out) {
    const r = ui.out, okR = r.results ? r.results.filter((x) => x.status === 'SUCCESS').length : 0;
    const card = h('div', { class: 'card' }, cardHead('部署結果', r.error ? badge('off', '沒有部署') : badge(okR === r.results.length ? 'on' : 'off', `${okR} / ${r.results.length} SUCCESS`)),
      r.error ? note('warn', r.error) : [
        h('div', { class: 'muted mono dn-dep', text: `${r.name} v${r.ver} · deployment ${r.id.slice(0, 8)}` }),
        ...r.results.map((x) => h('details', { class: 'dn-res', open: x.status !== 'SUCCESS' },
          h('summary', {}, badge(x.status === 'SUCCESS' ? 'on' : 'off', x.status), h('b', { class: 'mono', text: ` ${x.host}` }), h('span', { class: 'mono muted', text: ` ${x.ip}` })),
          h('div', { class: 'dn-detail', text: x.detail }),
          h('pre', { class: 'mono dn-cfg', text: x.lines.join('\n') }))),
      ]);
    body.append(card);
    if (ui.scrollToOut) { ui.scrollToOut = false; requestAnimationFrame(() => { body.scrollTop += card.getBoundingClientRect().top - body.getBoundingClientRect().top - 12; }); }
  }
}
