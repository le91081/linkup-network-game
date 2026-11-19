// 自動化主機上的工具：API 用戶端（像 Postman）與 Ansible（ansible-playbook）
import { h, button } from './dom.js';
import { note, cardHead, badge, toggle } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { restconf } from '../engine/restconf.js';
import { runPlaybook, MODULES } from '../engine/automation.js';
import { parseYaml, YamlError } from '../engine/yaml.js';
import { IOS_XE, iosSession } from '../engine/ios.js';
import { iosRun } from './cli.js';

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
  if (HAS_BODY.has(r.method) && r.body) parts.push('-d', `'${r.body.replace(/\s*\n\s*/g, ' ')}'`);
  parts.push(r.url);
  return parts.join(' ');
}

const statusKind = (s) => (s >= 200 && s < 300 ? 'on' : s >= 400 ? 'off' : 'warn');

/** 送出請求，回傳要顯示的結果；也記錄在 app 上 */
export function sendApi(app, devId, r) {
  const st = app.state;
  const res = restconf(st, devId, { method: r.method, url: r.url, user: r.user, pass: r.pass, contentType: HAS_BODY.has(r.method) ? r.ctype : '', accept: r.accept, body: HAS_BODY.has(r.method) ? r.body : '', verify: r.verify });
  const out = { ...res, at: Date.now(), req: { ...r }, ms: res.res ? 12 + (res.res.hops || []).length * 3 + (res.status === 201 || res.status === 204 ? 40 : 0) : 0 };
  if (res.res) app.showTrace(`${st.devices[devId].name} → ${r.method} ${r.url.replace(/^https:\/\/[^/]+/, '')}`, res.res.log, res.res.hops, res.res.ok && res.status ? { ...res.res, ok: res.status < 400, reason: `HTTP ${res.status} ${res.statusText}` } : res.res);
  return out;
}

export function apiTab(ctx, body) {
  const { app, dev, state } = ctx;
  const ui = ((app.apiUi ||= {})[dev.id] ||= { method: 'GET', url: `https://${guessTarget(state, dev)}/restconf/data/ietf-interfaces:interfaces`, user: '', pass: '', ctype: YANG, accept: '', body: '', verify: true, hist: [] });
  const rerender = () => app.renderPanel();
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
  const area = HAS_BODY.has(ui.method) && h('textarea', { class: 'code', rows: 9, spellcheck: 'false', value: ui.body, placeholder: '{\n  "ietf-interfaces:interface": { … }\n}', oninput: (e) => { ui.body = e.target.value; doLint(); } });
  if (area) area.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); insertAt(area, '  '); ui.body = area.value; } e.stopPropagation(); });
  const curl = h('div', { class: 'api-curl mono', text: curlOf(ui) });
  const send = () => {
    if (HAS_BODY.has(ui.method)) { const c = jsonCheck(ui.body); if (!c.ok && ui.body.trim()) { /* 照樣送出：讓設備回 400，和真的一樣 */ } }
    const r = sendApi(app, dev.id, ui);
    ui.last = r;
    ui.hist.unshift({ method: ui.method, url: ui.url, status: r.status, body: ui.body });
    ui.hist.length = Math.min(ui.hist.length, 8);
    ctx.commit(false);
    rerender();
  };
  body.append(h('div', { class: 'card api-req' }, cardHead('請求'),
    h('div', { class: 'api-line' }, method, url),
    h('div', { class: 'grid2' }, fld('帳號（Basic Auth）', txt('user', '例如 admin')), fld('密碼', txt('pass', '', 'password')),
      fld('Accept（要什麼格式的回應）', sel('accept', CTYPES)), HAS_BODY.has(ui.method) ? fld('Content-Type（送出的內容格式）', sel('ctype', CTYPES)) : h('span')),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ui.verify, onchange: (e) => { ui.verify = e.target.checked; rerender(); } }), h('i'), h('span', { text: '驗證 SSL 憑證（設備用的是自己簽的憑證時要關掉，curl 是 -k）' })),
    area && fld('內容 (Body)', area), area && lint,
    h('div', { class: 'addrow' },
      button('送出', { ic: 'play', kind: 'primary', small: true, onclick: send }),
      area && button('整理 JSON', { small: true, onclick: () => { try { ui.body = JSON.stringify(JSON.parse(ui.body), null, 2); area.value = ui.body; doLint(); } catch { doLint(); } } })),
    h('details', { class: 'api-tpl' }, h('summary', { text: '範本' }),
      h('div', { class: 'chips' }, TEMPLATES(urlHost(ui.url) || guessTarget(state, dev)).map(([t, o]) => h('button', { class: 'chip btnchip', type: 'button', text: t, onclick: () => { Object.assign(ui, o, { ctype: YANG, accept: YANG }); rerender(); } })))),
    h('div', { class: 'f-label', text: '等效的 curl 指令（也可以在終端機直接輸入）' }), curl));
  url.addEventListener('input', () => { curl.textContent = curlOf(ui); });
  for (const el of body.querySelectorAll('.api-req input, .api-req select')) el.addEventListener('input', () => { curl.textContent = curlOf(ui); });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); e.stopPropagation(); });
  doLint();

  // ── 回應 ──
  const r = ui.last;
  if (r) {
    const head = r.status
      ? h('div', { class: 'api-status' }, badge(statusKind(r.status), `${r.status} ${r.statusText}`), h('span', { class: 'muted mono', text: `${r.ms} ms · ${new Blob([r.text || '']).size} B${r.ctype ? ' · ' + r.ctype : ''}` }))
      : h('div', { class: 'api-status' }, badge('off', r.certErr ? 'SSL 錯誤' : '連線失敗'));
    body.append(h('div', { class: 'card' }, cardHead('回應'), head,
      r.error && note('warn', r.certErr ? `${r.error}：設備的 HTTPS 憑證是它自己簽的，不是公認的憑證機構簽發。實驗環境可以取消「驗證 SSL 憑證」；正式環境應該替設備換上公司 CA 簽的憑證。` : r.error),
      r.text ? h('pre', { class: 'api-body mono', text: r.text }) : r.status ? h('div', { class: 'muted', text: '（沒有內容）' }) : null,
      r.status && r.ctype === 'application/yang-data+xml' && note('muted', '回應是 XML：請求沒有說要什麼格式時，IOS XE 預設回 XML。要 JSON 的話，Accept 選 application/yang-data+json。'),
      r.note && note(r.status >= 400 ? 'warn' : 'muted', r.note)));
  }
  if (ui.hist.length) {
    body.append(h('div', { class: 'card' }, cardHead('最近的請求'), ui.hist.map((x) => h('button', {
      class: 'api-hist', type: 'button', onclick: () => { Object.assign(ui, { method: x.method, url: x.url, body: x.body || '' }); rerender(); },
    }, h('b', { class: 'mono', text: x.method }), h('span', { class: 'mono', text: x.url.replace(/^https:\/\/[^/]+/, '') }), x.status ? badge(statusKind(x.status), String(x.status)) : badge('off', '失敗')))));
  }
}
const urlHost = (u) => (String(u).match(/^https?:\/\/([\d.]+)/) || [])[1];
function insertAt(el, s) {
  const a = el.selectionStart, b = el.selectionEnd;
  el.value = el.value.slice(0, a) + s + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + s.length;
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
  const area = h('textarea', { class: 'code', rows: 16, spellcheck: 'false', value: a[key], wrap: 'off' });
  const lint = h('div', { class: 'api-lint' });
  const doLint = () => {
    if (ui.file === 'inv') { lint.replaceChildren(); return; }
    try { parseYaml(area.value); lint.replaceChildren(note('ok', 'YAML 語法正確')); } catch (e) { lint.replaceChildren(note('warn', e instanceof YamlError ? `第 ${e.line} 行第 ${e.col} 欄：${e.message}` : e.message)); }
  };
  area.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); insertAt(area, '  '); } e.stopPropagation(); });
  area.addEventListener('input', doLint);
  area.addEventListener('change', () => { a[key] = area.value; ctx.commit(false); });
  const fileBtn = (id, label) => h('button', { type: 'button', class: ui.file === id ? 'on' : '', onclick: () => { a[key] = area.value; ui.file = id; ctx.commit(false); rerender(); } }, label);
  const cmd = () => `ansible-playbook -i inventory.ini ${a.file}${ui.check ? ' --check' : ''}${ui.verbose ? ' -v' : ''}${ui.limit ? ' --limit ' + ui.limit : ''}`;
  const cmdEl = h('div', { class: 'api-curl mono', text: '$ ' + cmd() });
  const run = () => {
    a[key] = area.value;
    const r = ansibleRun(app, dev.id, ui);
    ui.out = { cmd: cmd(), lines: r.lines, rc: r.rc };
    ctx.commit(false);
    rerender();
  };
  body.append(h('div', { class: 'card' }, h('div', { class: 'seg' }, fileBtn('inv', 'inventory.ini'), fileBtn('pb', a.file)), area, lint,
    h('div', { class: 'toggles' },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ui.check, onchange: (e) => { ui.check = e.target.checked; cmdEl.textContent = '$ ' + cmd(); } }), h('i'), h('span', { text: '--check：只算出要改什麼，不真的改（乾跑）' })),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ui.verbose, onchange: (e) => { ui.verbose = e.target.checked; cmdEl.textContent = '$ ' + cmd(); } }), h('i'), h('span', { text: '-v：顯示每個 task 的結果（例如送出的指令）' }))),
    h('label', { class: 'field' }, h('span', { class: 'f-label', text: '--limit（只對這些主機執行，空白表示全部）' }),
      h('input', { class: 'inp mono', value: ui.limit, placeholder: '例如 sw-c 或 access', spellcheck: 'false', oninput: (e) => { ui.limit = e.target.value.trim(); cmdEl.textContent = '$ ' + cmd(); }, onkeydown: (e) => e.stopPropagation() })),
    cmdEl,
    h('div', { class: 'addrow' }, button('執行', { ic: 'play', kind: 'primary', small: true, onclick: run }))));
  doLint();
  if (ui.out) {
    body.append(h('div', { class: 'card' }, cardHead('輸出', badge(ui.out.rc === 0 ? 'on' : 'off', `結束代碼 ${ui.out.rc}`)),
      h('div', { class: 'term ans-out' }, h('div', { class: 'term-out' }, h('div', { class: 'tl cmd', text: '$ ' + ui.out.cmd }), ...ui.out.lines.map((l) => h('div', { class: `tl pre ${CLS[l.c] ?? ''}${l.c === 'head' ? ' ans-head' : ''}`, text: l.t || ' ' }))))));
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
