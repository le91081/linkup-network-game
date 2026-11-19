// Ansible（ansible-playbook）的模擬：INI 格式的 inventory、YAML 的 playbook、cisco.ios 的模組。
//
// 真的走網路：每台受管設備用 network_cli 開一條 SSH（TCP 22）登入，帳號密碼、line vty、ACL、路由都要對；
// 設定是在設備的命令列上一行一行下的（和人用 SSH 登入下指令一樣，設備的紀錄也會寫 Configured from console by … on vty0）。
// 模組是「宣告式」的：先看設備現在的設定，只有不一樣才會改 (changed)；再跑一次就全部 ok —— 這就是冪等 (idempotent)。
import { parseYaml, yamlErrorText, YamlError } from './yaml.js';
import { remoteOpen, remoteLogin, remoteSend, remoteClose } from './remote.js';
import { iosSession, runningConfig, isIos, IOS_XE, hostName, saveStartup, iosDirty } from './ios.js';
import { parseIp, parseMask, fmtMask, parseCidr } from './ip.js';
import { recompute } from './sim.js';
import { CATALOG, defaultPortMode } from './model.js';
import { ensureFlash } from './files.js';
import { vtyRows } from './ops.js';

// ───────────────────────── inventory ─────────────────────────

/** INI 格式的 inventory → { hosts: {名稱: vars}, groups: {名稱: {hosts, vars, children}} , warn: [] } */
export function parseInventory(text) {
  const inv = { hosts: {}, groups: { all: { hosts: [], vars: {}, children: [] }, ungrouped: { hosts: [], vars: {}, children: [] } }, warn: [] };
  let sec = 'ungrouped', kind = 'hosts';
  const grp = (g) => (inv.groups[g] ||= { hosts: [], vars: {}, children: [] });
  String(text).replace(/\r/g, '').split('\n').forEach((raw, n) => {
    const line = raw.replace(/\s[#;].*$/, '').replace(/^[#;].*$/, '').trim();
    if (!line) return;
    const h = line.match(/^\[([\w.-]+)(?::(vars|children))?\]$/);
    if (h) { sec = h[1]; kind = h[2] || 'hosts'; grp(sec); return; }
    if (/^\[/.test(line)) { inv.warn.push(`[WARNING]: inventory.ini 第 ${n + 1} 行的群組名稱格式不對：${line}`); return; }
    if (kind === 'vars') {
      const m = line.match(/^([\w.]+)\s*=\s*(.*)$/);
      if (!m) { inv.warn.push(`[WARNING]: inventory.ini 第 ${n + 1} 行：[${sec}:vars] 底下只能寫「變數=值」`); return; }
      grp(sec).vars[m[1]] = unq(m[2]);
      return;
    }
    if (kind === 'children') { grp(line); if (!grp(sec).children.includes(line)) grp(sec).children.push(line); return; }
    const [name, ...kv] = tokens(line);
    const vars = (inv.hosts[name] ||= {});
    for (const t of kv) {
      const m = t.match(/^([\w.]+)=(.*)$/);
      if (!m) { inv.warn.push(`[WARNING]: inventory.ini 第 ${n + 1} 行：主機後面的「${t}」不是「變數=值」`); continue; }
      vars[m[1]] = unq(m[2]);
    }
    if (!grp(sec).hosts.includes(name)) grp(sec).hosts.push(name);
  });
  // 沒有放在任何群組裡的主機屬於 ungrouped；所有主機都屬於 all
  const inSome = new Set(Object.entries(inv.groups).filter(([g]) => g !== 'ungrouped' && g !== 'all').flatMap(([, g]) => g.hosts));
  inv.groups.ungrouped.hosts = inv.groups.ungrouped.hosts.filter((x) => !inSome.has(x));
  inv.groups.all.hosts = Object.keys(inv.hosts);
  return inv;
}
const unq = (s) => { s = s.trim(); return /^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s; };
function tokens(s) {
  const out = [];
  let cur = '', q = null;
  for (const c of s) {
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) out.push(cur), (cur = ''); continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
/** 群組（含子群組）裡所有的主機 */
function groupHosts(inv, g, seen = new Set()) {
  const G = inv.groups[g];
  if (!G || seen.has(g)) return [];
  seen.add(g);
  return [...G.hosts, ...G.children.flatMap((c) => groupHosts(inv, c, seen))];
}
/** 主機屬於哪些群組（由外到內：all 最先，越內層的越後面，後面的變數會蓋過前面的） */
function groupsOf(inv, host) {
  const out = [];
  const depth = (g, d = 0, seen = new Set()) => { if (seen.has(g)) return d; seen.add(g); const parents = Object.entries(inv.groups).filter(([, G]) => G.children.includes(g)).map(([n]) => n); return parents.length ? Math.max(...parents.map((p) => depth(p, d + 1, seen))) : d; };
  for (const g of Object.keys(inv.groups)) if (g !== 'all' && groupHosts(inv, g).includes(host)) out.push(g);
  return out.sort((a, b) => depth(a) - depth(b));
}
/** hosts: 的樣式：all、群組、主機，可以用 : 或 , 分隔；!排除、&交集 */
function matchHosts(inv, pattern) {
  const all = Object.keys(inv.hosts);
  let set = [];
  const parts = String(pattern ?? '').split(/[:,]/).map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    const neg = p.startsWith('!'), and = p.startsWith('&');
    const name = p.replace(/^[!&]/, '');
    const hit = name === 'all' || name === '*' ? all : inv.groups[name] ? groupHosts(inv, name) : all.filter((h) => h === name || (name.includes('*') && new RegExp('^' + name.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$').test(h)));
    if (neg) set = set.filter((h) => !hit.includes(h));
    else if (and) set = set.filter((h) => hit.includes(h));
    else for (const h of hit) if (!set.includes(h)) set.push(h);
  }
  return set;
}

// ───────────────────────── Jinja2（只做變數與幾個常用的 filter） ─────────────────────────

class Undef extends Error { constructor(name) { super(`'${name}' is undefined`); this.varName = name; } }
function lookup(vars, path) {
  const parts = path.match(/[\w-]+|\[\s*(['"]?)[^\]]*?\1\s*\]/g) || [];
  let v = vars, name = '';
  for (const p0 of parts) {
    const p = p0.startsWith('[') ? p0.slice(1, -1).trim().replace(/^(['"])(.*)\1$/, '$2') : p0;
    name = name ? `${name}.${p}` : p;
    if (v == null || typeof v !== 'object' || !(p in v)) throw new Undef(name.includes('.') ? `${typeof v === 'object' && v ? 'dict object' : name.split('.').slice(0, -1).join('.')}' has no attribute '${p}` : name);
    v = v[p];
  }
  return v;
}
function evalExpr(expr, vars) {
  const segs = splitTop(expr, '|');
  let v;
  const head = segs[0].trim();
  if (/^(['"]).*\1$/.test(head)) v = head.slice(1, -1);
  else if (/^-?\d+(\.\d+)?$/.test(head)) v = +head;
  else {
    try { v = lookup(vars, head); } catch (e) {
      if (!(e instanceof Undef) || !segs.slice(1).some((f) => /^\s*default\b|^\s*d\(/.test(f))) throw e;
      v = undefined;
    }
  }
  for (const f0 of segs.slice(1)) {
    const f = f0.trim(), m = f.match(/^(\w+)\s*(?:\((.*)\))?$/);
    if (!m) throw new Error(`template error while templating string: unexpected '${f}'`);
    const arg = m[2] != null ? m[2].trim().replace(/^(['"])(.*)\1$/, '$2') : undefined;
    switch (m[1]) {
      case 'default': case 'd': if (v === undefined) v = /^-?\d+$/.test(arg) ? +arg : arg; break;
      case 'upper': v = String(v).toUpperCase(); break;
      case 'lower': v = String(v).toLowerCase(); break;
      case 'string': v = String(v); break;
      case 'int': v = parseInt(v, 10) || 0; break;
      case 'length': case 'count': v = v == null ? 0 : (Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : String(v).length); break;
      case 'join': v = [].concat(v).join(arg ?? ''); break;
      case 'trim': v = String(v).trim(); break;
      default: throw new Error(`template error while templating string: No filter named '${m[1]}'.`);
    }
  }
  return v;
}
function splitTop(s, sep) {
  const out = []; let cur = '', q = null, d = 0;
  for (const c of s) {
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === '"' || c === "'") q = c;
    if (c === '(' || c === '[') d++;
    if (c === ')' || c === ']') d--;
    if (c === sep && d === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
/** 把字串裡的 {{ … }} 換成變數的值。整個字串就是一個 {{ x }} 的話保留原本的型別（例如清單） */
export function template(v, vars) {
  if (typeof v === 'string') {
    const whole = v.match(/^\s*\{\{(.*?)\}\}\s*$/);
    if (whole && !whole[1].includes('}}')) return evalExpr(whole[1], vars);
    return v.replace(/\{\{(.*?)\}\}/g, (_, e) => { const r = evalExpr(e, vars); return typeof r === 'object' && r ? pyRepr(r) : String(r); });
  }
  if (Array.isArray(v)) return v.map((x) => template(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, template(x, vars)]));
  return v;
}
/** when: 的條件：==、!=、in、not in、is defined、and / or / not */
function cond(expr, vars) {
  const e = String(expr).trim();
  const or = splitWord(e, 'or');
  if (or.length > 1) return or.some((x) => cond(x, vars));
  const and = splitWord(e, 'and');
  if (and.length > 1) return and.every((x) => cond(x, vars));
  if (/^not\s+/.test(e)) return !cond(e.replace(/^not\s+/, ''), vars);
  let m = e.match(/^(.+?)\s+is\s+(not\s+)?defined$/);
  if (m) { let ok = true; try { lookup(vars, m[1].trim()); } catch { ok = false; } return m[2] ? !ok : ok; }
  const val = (x) => evalExpr(x.trim(), vars);
  m = e.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) { const a = val(m[1]), b = val(m[3]); return { '==': a == b, '!=': a != b, '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b }[m[2]]; } // eslint-disable-line eqeqeq
  m = e.match(/^(.+?)\s+(not\s+in|in)\s+(.+)$/);
  if (m) { const a = val(m[1]), b = val(m[3]); const has = Array.isArray(b) ? b.includes(a) : String(b).includes(String(a)); return /not/.test(m[2]) ? !has : has; }
  const v = val(e);
  return !!v && !(Array.isArray(v) && !v.length);
}
function splitWord(s, w) { return s.split(new RegExp(`\\s+${w}\\s+`)).filter((x) => x.trim()); }

/** Python 的 repr（Ansible 的輸出裡 item= 長這樣） */
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  return '{' + Object.entries(v).map(([k, x]) => `'${k}': ${pyRepr(x)}`).join(', ') + '}';
}

// ───────────────────────── 設備端：running-config 的比對與套用 ─────────────────────────

/** running-config 切成區段：{ top: [頂層的行], sec: { 'interface Gi0/1': [子行…] } } */
function sections(lines) {
  const top = [], sec = {};
  let cur = null;
  for (const l of lines) {
    if (!l || l === '!' || l.startsWith('!')) { cur = null; continue; }
    if (/^\s/.test(l)) { if (cur) sec[cur].push(l.trim()); continue; }
    top.push(l.trim());
    cur = l.trim();
    sec[cur] ||= [];
  }
  return { top, sec };
}
/** 設定裡的介面名稱寫法：GigabitEthernet0/1 → 和 running-config 的 interface 行一樣的寫法 */
function ifLine(d, name) {
  const s = String(name).trim();
  const lo = s.match(/^lo\w*?(\d+)$/i), vl = s.match(/^vl\w*?(\d+)$/i);
  if (lo) return `interface Loopback${lo[1]}`;
  if (vl) return `interface Vlan${vl[1]}`;
  const m = s.match(/^([a-z]+)\s*([\d/.]+)$/i);
  if (!m) return `interface ${s}`;
  const pre = m[1].toLowerCase();
  const kind = 'gigabitethernet'.startsWith(pre) ? 'Gi' : 'tengigabitethernet'.startsWith(pre) || pre === 'te' ? 'Te' : 'fastethernet'.startsWith(pre) ? 'Fa' : 'ethernet'.startsWith(pre) ? 'Eth' : m[1];
  const [num, sub] = m[2].split('.');
  const p = d.ports.find((x) => x.label.toLowerCase() === (kind + num).toLowerCase());
  return `interface ${p ? p.label : kind + num}${sub ? '.' + sub : ''}`;
}

/** 一條受管設備的連線（network_cli） */
class Conn {
  constructor(state, from, host, vars) { Object.assign(this, { state, from, host, vars, conn: null, sess: null, dev: null }); }
  /** 開 SSH 並登入。失敗回傳 { unreachable: msg, hint } */
  open() {
    if (this.sess) return null;
    const st = this.state, v = this.vars;
    const ip = parseIp(String(v.ansible_host ?? this.host));
    if (ip == null) return { unreachable: `Failed to connect to the host via ssh: ssh: Could not resolve hostname ${v.ansible_host ?? this.host}: Name or service not known`, hint: `inventory 裡的 ${this.host} 沒有 ansible_host（設備的管理 IP），而 ${this.host} 也不是一個 IP` };
    const user = v.ansible_user ?? v.ansible_ssh_user;
    const pass = v.ansible_password ?? v.ansible_ssh_pass;
    const o = remoteOpen(st, this.from, 'ssh', ip, user || 'root');
    this.res = o.res;
    if (!o.ok) {
      const refused = o.refused || /連線被拒絕|沒有開啟|沒有開放|不在.*允許|SSH 沒有啟用/.test(o.reason || '');
      return { unreachable: `ssh connection failed: ssh connect failed: ${refused ? 'Connection refused' : `Timeout connecting to ${String(v.ansible_host ?? this.host)}`}`, hint: o.reason };
    }
    if (o.open) { this.conn = o.conn; } else {
      if (!user) { remoteClose(st, o.conn); return { unreachable: 'ssh connection failed: Failed to authenticate public key: Access denied for \'none\'. Authentication that can continue: publickey,keyboard-interactive,password', hint: 'inventory 沒有設定 ansible_user（登入設備的帳號）' }; }
      if (pass == null) { remoteClose(st, o.conn); return { unreachable: 'ssh connection failed: Failed to authenticate public key: Access denied for \'none\'. Authentication that can continue: publickey,keyboard-interactive,password', hint: 'inventory 沒有設定 ansible_password：設備沒有放你的 SSH 公鑰，只能用密碼登入' }; }
      const a = remoteLogin(st, o.conn, String(pass));
      if (!a.ok) { if (!a.closed) remoteClose(st, o.conn); return { unreachable: 'ssh connection failed: Failed to authenticate password: Access denied', hint: a.reason || a.hint || `${st.devices[o.conn.to].name} 拒絕了帳號 ${user} 的登入（設備上沒有這個帳號，或是密碼不對）` }; }
      this.conn = o.conn;
    }
    this.dev = () => st.devices[this.conn.to];
    if (!isIos(this.dev())) { this.close(); return { failed: `Unable to automatically determine host network os. Please manually configure ansible_network_os value for this host`, hint: `${this.dev().name} 不是 Cisco IOS 設備，cisco.ios 的模組管不了它` }; }
    const line = 'vty' + Math.max(0, vtyRows(st, this.dev()).findIndex((x) => x.cid === this.conn.cid));
    this.sess = iosSession(() => st.devices[this.conn.to], () => st, { user: this.conn.user || user, line, ip: this.conn.seen });
    this.sess.exec('terminal length 0');
    return null;
  }
  /** 送出一行指令（先確認這條 SSH 連線還在） */
  send(line) {
    const r = remoteSend(this.state, this.conn, line);
    if (!r.ok) return { lost: r.by === 'net' ? 'command timeout triggered, timeout value is 30 secs.' : 'socket is closed', hint: r.reason || '設備把這條 SSH 連線結束了' };
    return this.sess.exec(line);
  }
  run() { return runningConfig(this.state, this.dev()); }
  close() { if (this.conn) remoteClose(this.state, this.conn); this.sess = null; }
}

/** 在設定模式下依序送出指令；有一行出錯就停下來（和 ios_config 一樣把錯誤回報出來） */
function push(c, cmds) {
  const out = [];
  const go = (l) => { const r = c.send(l); if (r.lost) return r; out.push(...r.out); return r; };
  let r = go('configure terminal');
  if (r.lost) return r;
  for (const l of cmds) {
    r = go(l);
    if (r.lost) return r;
    const e = r.out.find((x) => x.startsWith('% '));
    if (e && !r.changed) { c.send('end'); return { error: `${l}\r\n${e}\r\n${hostName(c.dev())}(config)#`, hint: e.replace(/^% /, '') }; }
  }
  r = go('end');
  return r.lost ? r : { out };
}

// ───────────────────────── 模組 ─────────────────────────

const MOD_ALIAS = {
  ios_config: 'cisco.ios.ios_config', ios_command: 'cisco.ios.ios_command', ios_facts: 'cisco.ios.ios_facts', ios_vlans: 'cisco.ios.ios_vlans',
  ios_interfaces: 'cisco.ios.ios_interfaces', ios_l2_interfaces: 'cisco.ios.ios_l2_interfaces', ios_l3_interfaces: 'cisco.ios.ios_l3_interfaces',
  debug: 'ansible.builtin.debug', 'ansible.builtin.debug': 'ansible.builtin.debug', assert: 'ansible.builtin.assert', 'ansible.builtin.assert': 'ansible.builtin.assert',
  ping: 'ansible.builtin.ping', 'ansible.builtin.ping': 'ansible.builtin.ping', 'ansible.netcommon.cli_command': 'ansible.netcommon.cli_command', cli_command: 'ansible.netcommon.cli_command',
};
for (const m of ['ios_config', 'ios_command', 'ios_facts', 'ios_vlans', 'ios_interfaces', 'ios_l2_interfaces', 'ios_l3_interfaces']) MOD_ALIAS['cisco.ios.' + m] = 'cisco.ios.' + m;
export const MODULES = [...new Set(Object.values(MOD_ALIAS))];
const TASK_KEYS = new Set(['name', 'register', 'loop', 'with_items', 'when', 'ignore_errors', 'check_mode', 'vars', 'tags', 'loop_control', 'changed_when', 'failed_when', 'become', 'become_method', 'connection', 'delegate_to', 'notify', 'no_log', 'diff']);

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const vlanList = (s) => {
  const out = new Set();
  for (const p of String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (m) for (let v = +m[1]; v <= +(m[2] ?? m[1]); v++) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
};

function facts(c) {
  const d = c.dev();
  ensureFlash(d);
  const ifs = {};
  for (const p of d.ports) ifs[p.label] = { description: (d.sw && d.sw.ports[p.id] && d.sw.ports[p.id].desc) || null };
  return {
    ansible_net_hostname: hostName(d), ansible_net_model: CATALOG[d.model].title.replace(/^Cisco /, ''), ansible_net_version: (d.fw || {}).ver || '',
    ansible_net_iostype: IOS_XE.has(d.model) ? 'IOS-XE' : 'IOS', ansible_net_system: 'ios', ansible_net_api: 'cliconf', ansible_net_python_version: '3.11.6',
    ansible_net_serialnum: 'FOC' + (d.id.toUpperCase().replace(/[^A-Z0-9]/g, '') + '2650A1B2').slice(0, 8), ansible_net_interfaces: ifs,
  };
}

/** 依照「宣告的狀態」與設備現在的設定，算出要下的指令 */
function resourceCmds(mod, c, args) {
  const d = c.dev();
  const state = args.state || 'merged';
  if (!['merged', 'replaced', 'overridden', 'deleted'].includes(state)) return { fail: `value of state must be one of: merged, replaced, overridden, deleted, rendered, parsed, gathered, got: ${state}` };
  const conf = asList(args.config);
  const cmds = [];
  if (mod === 'cisco.ios.ios_vlans') {
    if (!d.sw || d.sw.mode !== 'vlan') return { fail: `${hostName(d)} 沒有 VLAN 資料庫（不是交換器）` };
    const have = d.sw.vlans;
    for (const x of conf) if (!(+x.vlan_id >= 1 && +x.vlan_id <= 4094)) return { fail: `vlan_id 要是 1 – 4094 的數字，收到的是 ${pyRepr(x.vlan_id)}` };
    if (state === 'deleted') {
      const ids = conf.length ? conf.map((x) => +x.vlan_id) : have.map((v) => v.id).filter((id) => id !== 1 && !(id >= 1002 && id <= 1005));
      for (const id of ids) if (have.some((v) => v.id === id) && id !== 1) cmds.push(`no vlan ${id}`);
      return { cmds };
    }
    if (state === 'overridden') for (const v of have) if (v.id !== 1 && !(v.id >= 1002 && v.id <= 1005) && !conf.some((x) => +x.vlan_id === v.id)) cmds.push(`no vlan ${v.id}`);
    for (const x of conf) {
      const id = +x.vlan_id, cur = have.find((v) => v.id === id);
      const want = x.name != null ? String(x.name) : (state === 'merged' ? null : `VLAN${String(id).padStart(4, '0')}`);
      const sub = [];
      if (want != null && (!cur || cur.name !== want)) sub.push(` name ${want}`);
      if (!cur || sub.length) cmds.push(`vlan ${id}`, ...sub);
    }
    return { cmds };
  }
  if (mod === 'cisco.ios.ios_l2_interfaces') {
    if (!d.sw) return { fail: `${hostName(d)} 沒有第二層的連接埠` };
    for (const x of conf) {
      if (!x.name) return { fail: 'missing required arguments: name found in config' };
      const il = ifLine(d, x.name), lbl = il.replace(/^interface /, '');
      const p = d.ports.find((q) => q.label === lbl);
      if (!p) return { fail: `${hostName(d)} 沒有介面 ${x.name}` };
      const pc = d.sw.ports[p.id], sub = [];
      if (state === 'deleted') {
        if (pc.mode !== defaultPortMode(d.model)) sub.push(' no switchport mode');
        if (pc.vlan !== 1) sub.push(' no switchport access vlan');
        if (pc.voice) sub.push(' no switchport voice vlan');
      }
      else {
        const mode = x.mode || (state === 'replaced' ? 'access' : null);
        if (mode && pc.mode !== mode) sub.push(` switchport mode ${mode}`);
        if (x.access && x.access.vlan != null && +x.access.vlan !== pc.vlan) sub.push(` switchport access vlan ${+x.access.vlan}`);
        if (x.voice && x.voice.vlan != null && +x.voice.vlan !== pc.voice) sub.push(` switchport voice vlan ${+x.voice.vlan}`);
        if (x.trunk) {
          if (x.trunk.native_vlan != null && +x.trunk.native_vlan !== (pc.native || 1)) sub.push(` switchport trunk native vlan ${+x.trunk.native_vlan}`);
          if (x.trunk.allowed_vlans != null) {
            const want = vlanList(asList(x.trunk.allowed_vlans).join(',')), cur = pc.allowed === 'all' || !pc.allowed ? null : vlanList(pc.allowed);
            // merged 是「加上去」：原本允許的 VLAN 保留，只 add 缺的；replaced / overridden 才整個換掉
            if (state === 'merged') { const add = cur ? want.filter((v) => !cur.includes(v)) : []; if (add.length) sub.push(` switchport trunk allowed vlan add ${add.join(',')}`); }
            else if (want.join(',') !== (cur || []).join(',')) sub.push(` switchport trunk allowed vlan ${want.join(',')}`);
          }
        }
      }
      if (sub.length) cmds.push(il, ...sub);
    }
    return { cmds };
  }
  if (mod === 'cisco.ios.ios_interfaces') {
    const run = sections(c.run());
    for (const x of conf) {
      if (!x.name) return { fail: 'missing required arguments: name found in config' };
      const il = ifLine(d, x.name), cur = run.sec[il];
      if (!cur && !/Loopback|Vlan|\./.test(il)) return { fail: `${hostName(d)} 沒有介面 ${x.name}` };
      const have = cur || [], sub = [];
      if (state === 'deleted') { if (have.some((l) => l.startsWith('description '))) sub.push(' no description'); if (have.includes('shutdown')) sub.push(' no shutdown'); }
      else {
        if (x.description != null && !have.includes(`description ${x.description}`)) sub.push(` description ${x.description}`);
        if (x.enabled === false && !have.includes('shutdown')) sub.push(' shutdown');
        if (x.enabled === true && have.includes('shutdown')) sub.push(' no shutdown');
      }
      if (sub.length) cmds.push(il, ...sub);
    }
    return { cmds };
  }
  if (mod === 'cisco.ios.ios_l3_interfaces') {
    const run = sections(c.run());
    for (const x of conf) {
      if (!x.name) return { fail: 'missing required arguments: name found in config' };
      const il = ifLine(d, x.name), have = run.sec[il] || [], sub = [];
      for (const a of asList(x.ipv4)) {
        const cidr = parseCidr(String(a.address || ''));
        if (!cidr || !String(a.address).includes('/')) return { fail: `ipv4 的 address 要寫成 10.0.0.1/24，收到的是 ${pyRepr(a.address)}` };
        const want = `ip address ${String(a.address).split('/')[0]} ${fmtMask(cidr.bits)}`;
        if (!have.includes(want)) sub.push(' ' + want);
      }
      if (sub.length) cmds.push(il, ...sub);
    }
    return { cmds };
  }
  return { fail: 'unsupported module' };
}

/** ios_config：lines（和 parents）裡沒有出現在 running-config 的行才送出去 */
function configCmds(c, args) {
  const lines = asList(args.lines ?? args.commands).map(String);
  if (!lines.length && !args.src) return { fail: 'one of the following is required: lines, src' };
  const parents = asList(args.parents).map(String);
  const match = args.match || 'line';
  const run = sections(c.run());
  // 只比對到第一層 parents（例如 interface Gi0/1）；更深的區段直接送出
  let have;
  if (!parents.length) have = new Set(run.top);
  else {
    const key = parents[0].trim().replace(/^int(e(r(f(a(c(e)?)?)?)?)?)?\s+/i, 'interface ');
    const k2 = /^interface /.test(key) ? ifLine(c.dev(), key.replace(/^interface /, '')) : key;
    have = new Set(parents.length === 1 ? run.sec[k2] || [] : []);
  }
  const missing = match === 'none' ? lines : lines.filter((l) => !have.has(l.trim()));
  if (!missing.length) return { cmds: [] };
  return { cmds: [...parents, ...missing], save: args.save_when };
}

// ───────────────────────── ansible-playbook ─────────────────────────

const W = (s) => [...String(s)].reduce((n, ch) => n + (/[⺀-￿]/.test(ch) ? 2 : 1), 0);
const banner = (s) => `${s} ${'*'.repeat(Math.max(3, 79 - W(s) - 1))}`;
const json = (o) => JSON.stringify(o, null, 4);

/**
 * 跑一個 playbook。opts = { inventory, playbook, file, check, verbose, limit, show(state, devId, sess, line) → 輸出的行 }。
 * 回傳 { lines: [{t, c}], recap: {主機: {ok, changed, unreachable, failed, skipped}}, secs, rc, traces }
 */
export function runPlaybook(state, fromId, opts) {
  const out = [], traces = [], hinted = new Set();
  // 同樣的說明只印一次（四台都錯在同一個地方時，不要重複四遍）
  const p = (t, c = '') => { if (c === 'hint') { if (hinted.has(t)) return; hinted.add(t); } out.push({ t, c }); };
  const file = opts.file || 'site.yml';
  let secs = 2;
  const inv = parseInventory(opts.inventory || '');
  for (const w of inv.warn) p(w, 'warn');
  if (!Object.keys(inv.hosts).length) p('[WARNING]: provided hosts list is empty, only localhost is available. Note that the implicit localhost does not match \'all\'', 'warn');
  let book;
  try { book = parseYaml(opts.playbook || ''); } catch (e) { yamlErrorText(e, file).forEach((l, n) => p(l, n === 0 ? 'bad' : '')); return { lines: out, recap: {}, secs, rc: 4, traces }; }
  const bad = (msg) => { const [first, ...rest] = msg.split('\n'); p(`ERROR! ${first}`, 'bad'); for (const l of rest) p(l, /^（/.test(l) ? 'hint' : ''); return { lines: out, recap: {}, secs, rc: 4, traces }; };
  // 錯誤發生在哪一行：找 task 的 name 那一行（Ansible 也會印出出錯的那一行）
  const where = (t) => {
    const lines = String(opts.playbook).split('\n');
    const n = t && t.name ? lines.findIndex((l) => /^\s*-\s+name:/.test(l) && l.includes(String(t.name))) : -1;
    if (n < 0) return `\nThe error appears to be in '/home/netops/${file}'`;
    const col = lines[n].indexOf('-') + 3;
    return `\nThe error appears to be in '/home/netops/${file}': line ${n + 1}, column ${col}, but may\nbe elsewhere in the file depending on the exact syntax problem.\n\nThe offending line appears to be:\n\n${lines[n]}\n${' '.repeat(col - 1)}^ here`;
  };
  if (book == null) return bad(`Empty playbook, nothing to do: /home/netops/${file}`);
  if (!Array.isArray(book)) return bad(`A playbook must be a list of plays, got a ${typeof book === 'object' ? 'AnsibleMapping' : typeof book} instead\n\nThe error appears to be in '/home/netops/${file}': line 1, column 1\n（playbook 的最外層是清單：每個 play 用「- name: …」開頭）`);
  for (const [n, play] of book.entries()) {
    if (!play || typeof play !== 'object' || Array.isArray(play)) return bad(`playbook 的第 ${n + 1} 個項目不是一個 play（應該是有 hosts: 與 tasks: 的 mapping）`);
    if (play.hosts == null) return bad(`the field 'hosts' is required but was not set（第 ${n + 1} 個 play 少了 hosts:）`);
    const unknown = Object.keys(play).find((k) => !['name', 'hosts', 'gather_facts', 'connection', 'vars', 'tasks', 'become', 'become_method', 'serial', 'strategy', 'collections', 'any_errors_fatal', 'ignore_errors', 'remote_user', 'tags', 'handlers', 'pre_tasks', 'post_tasks', 'check_mode'].includes(k));
    if (unknown) return bad(`'${unknown}' is not a valid attribute for a Play\n\n（play 的層級只能有 name、hosts、gather_facts、connection、vars、tasks…；${unknown} 可能是縮排錯了，應該放在 tasks 底下）`);
    for (const t of asList(play.tasks)) {
      if (!t || typeof t !== 'object') return bad('tasks 底下的每一項都要是一個 task（- name: … 加上模組）');
      const mods = Object.keys(t).filter((k) => !TASK_KEYS.has(k));
      if (!mods.length) return bad(`no module/action detected in task.\n${where(t)}\n\n（task「${t.name || '?'}」沒有指定模組，例如 cisco.ios.ios_vlans:；也可能是模組那一行的縮排和 name 沒有對齊）`);
      if (mods.length > 1) return bad(`conflicting action statements: ${mods.slice(0, 2).join(', ')}\n${where(t)}\n\n（一個 task 只能用一個模組；${mods[1]} 可能是模組的參數，縮排要比模組多一層）`);
      if (!MOD_ALIAS[mods[0]]) return bad(`couldn't resolve module/action '${mods[0]}'. This often indicates a misspelling, missing collection, or incorrect module path.\n${where(t)}\n\n（這個模擬支援：${MODULES.join('、')}）`);
    }
  }
  const recap = {};
  const R = (h) => (recap[h] ||= { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 });
  const conns = {}, hostDev = {};
  let rc = 0;

  for (const play of book) {
    let hosts = matchHosts(inv, play.hosts);
    if (opts.limit) { const lim = matchHosts(inv, opts.limit); hosts = hosts.filter((h) => lim.includes(h)); }
    p('');
    p(banner(`PLAY [${play.name || play.hosts}]`), 'head');
    if (!hosts.length) {
      p(`[WARNING]: Could not match supplied host pattern, ignoring: ${play.hosts}`, 'warn');
      p('skipping: no hosts matched', 'dim');
      continue;
    }
    const playVars = play.vars && typeof play.vars === 'object' ? play.vars : {};
    const hv = {};
    for (const h of hosts) {
      const v = {};
      for (const g of ['all', ...groupsOf(inv, h)]) Object.assign(v, inv.groups[g] ? inv.groups[g].vars : {});
      Object.assign(v, inv.hosts[h], playVars, { inventory_hostname: h, group_names: groupsOf(inv, h).filter((g) => g !== 'ungrouped') });
      if (play.connection) v.ansible_connection = play.connection;
      hv[h] = v;
      R(h);
    }
    let live = hosts.slice();
    /** 這台主機能不能用 cisco.ios 的模組（連線方式、network_os），可以的話開好連線 */
    const ready = (h, mod) => {
      const v = hv[h];
      const cn = String(v.ansible_connection || 'ssh');
      if (mod.startsWith('cisco.ios.') || mod === 'ansible.netcommon.cli_command') {
        if (!/network_cli$/.test(cn)) return { failed: `Connection type ${cn} is not valid for this module`, hint: 'cisco.ios 的模組要用 ansible_connection=ansible.netcommon.network_cli（Ansible 在控制主機上開 SSH 下 CLI 指令，網路設備上不必裝 Python）' };
        if (!v.ansible_network_os) return { failed: 'Unable to automatically determine host network os. Please manually configure ansible_network_os value for this host', hint: 'inventory 要設定 ansible_network_os=cisco.ios.ios，Ansible 才知道用哪一種 CLI 的語法跟設備溝通' };
        if (!/^(cisco\.ios\.)?ios$/.test(String(v.ansible_network_os))) return { failed: `network os ${v.ansible_network_os} is not supported`, hint: '這些是 Cisco IOS 設備：ansible_network_os 要是 cisco.ios.ios' };
      } else if (mod === 'ansible.builtin.ping' && /network_cli$/.test(cn)) return { failed: 'Connection type network_cli is not valid for this module', hint: 'ping 模組要在受管主機上跑 Python；網路設備請用 cisco.ios.ios_command 或 ios_facts 測試連線' };
      if (mod === 'ansible.builtin.debug' || mod === 'ansible.builtin.assert') return {};
      if (!conns[h]) conns[h] = new Conn(state, fromId, h, v);
      const e = conns[h].open();
      if (conns[h].res) { traces.push({ host: h, res: conns[h].res }); conns[h].res = null; }
      if (e) { delete conns[h]; return e; }
      if (conns[h].conn) hostDev[h] = conns[h].conn.to;
      return {};
    };

    const steps = [];
    if (play.gather_facts !== false && play.gather_facts !== 'no') steps.push({ name: 'Gathering Facts', facts: true });
    for (const t of asList(play.tasks)) steps.push(t);

    for (const t of steps) {
      if (!live.length) break;
      const mod = t.facts ? 'cisco.ios.ios_facts' : MOD_ALIAS[Object.keys(t).find((k) => !TASK_KEYS.has(k))];
      const key = t.facts ? null : Object.keys(t).find((k) => !TASK_KEYS.has(k));
      p('');
      p(banner(`TASK [${t.name || key}]`), 'head');
      secs += 1;
      for (const h of live.slice()) {
        const v = hv[h];
        const fail = (msg, hint, extra = {}) => {
          if (t.ignore_errors) { p(`fatal: [${h}]: FAILED! => ${json({ changed: false, msg, ...extra })}`, 'bad'); p('...ignoring', 'dim'); R(h).ignored++; R(h).ok++; if (hint) p('  ↳ ' + hint, 'hint'); return; }
          p(`fatal: [${h}]: FAILED! => ${json({ changed: false, msg, ...extra })}`, 'bad');
          if (hint) p('  ↳ ' + hint, 'hint');
          R(h).failed++; live = live.filter((x) => x !== h);
        };
        const unreach = (msg, hint) => {
          p(`fatal: [${h}]: UNREACHABLE! => ${json({ changed: false, msg, unreachable: true })}`, 'bad');
          if (hint) p('  ↳ ' + hint, 'hint');
          R(h).unreachable++; live = live.filter((x) => x !== h);
        };
        // facts（Gathering Facts）也算一次連線
        if (t.facts) {
          if (!/network_cli$/.test(String(v.ansible_connection || 'ssh'))) { fail('Connection type ssh is not valid for this module', '沒有設定 ansible_connection=ansible.netcommon.network_cli：Ansible 預設會用 SSH 登入後在受管主機上跑 Python 模組，網路設備沒有 Python'); continue; }
          const e = ready(h, mod);
          if (e.unreachable) { unreach(e.unreachable, e.hint); continue; }
          if (e.failed) { fail(e.failed, e.hint); continue; }
          Object.assign(v, facts(conns[h]));
          p(`ok: [${h}]`, 'ok'); R(h).ok++;
          continue;
        }
        let items = [null];
        if (t.loop != null || t.with_items != null) {
          try { items = asList(template(t.loop ?? t.with_items, v)); } catch (e) { fail(`The task includes an option with an undefined variable. The error was: ${e.message}`, '「loop:」用到的變數沒有定義：檢查 vars: 的名稱有沒有打錯'); continue; }
          if (!Array.isArray(items)) { fail(`Invalid data passed to 'loop', it requires a list, got this instead: ${items}. Hint: If you passed a list/dict of just one element, try adding wantlist=True to your lookup invocation or use q/query instead of lookup.`); continue; }
        }
        let any = false, anyFail = false, hostSkip = 0;
        const res = [];
        for (const item of items) {
          const iv = item === null && t.loop == null && t.with_items == null ? v : { ...v, item };
          const tag = item === null && t.loop == null && t.with_items == null ? '' : ` => (item=${pyRepr(item)})`;
          if (t.when != null) {
            let ok;
            try { ok = asList(t.when).every((w) => cond(typeof w === 'string' ? w.replace(/^\{\{\s*|\s*\}\}$/g, '') : String(w), iv)); } catch (e) { fail(`The conditional check '${t.when}' failed. The error was: error while evaluating conditional (${t.when}): ${e.message}`); anyFail = true; break; }
            if (!ok) { p(`skipping: [${h}]${tag}`, 'skip'); hostSkip++; continue; }
          }
          let args;
          try { args = template(t[key] ?? {}, iv); } catch (e) { fail(`The task includes an option with an undefined variable. The error was: ${e.message}`, '變數沒有定義：檢查名稱有沒有打錯，或是不是放在別台主機的 host_vars 裡'); anyFail = true; break; }
          if (typeof args === 'string' && mod === 'ansible.builtin.debug') args = Object.fromEntries(args.split(/\s+/).map((kv) => kv.split('=')));
          const e = ready(h, mod);
          if (e.unreachable) { unreach(e.unreachable, e.hint); anyFail = true; break; }
          if (e.failed) { fail(e.failed, e.hint); anyFail = true; break; }
          const r = runModule(mod, conns[h], args || {}, iv, { check: !!opts.check || t.check_mode === true, show: opts.show, state });
          if (r.lost) { unreach(r.lost, r.hint); anyFail = true; break; }
          if (r.fail) { fail(r.fail, r.hint, r.extra); anyFail = true; break; }
          res.push(r);
          secs += r.secs || 0.5;
          const changed = t.changed_when != null ? cond(String(t.changed_when), { ...iv, result: r.result }) : !!r.changed;
          if (changed) any = true;
          const word = changed ? 'changed' : 'ok';
          const body = r.show ? r.show : opts.verbose && r.result ? r.result : null;
          if (tag || body) p(`${word}: [${h}]${tag}${body ? (tag ? ' ' : ' => ') + json(body) : ''}`, changed ? 'chg' : 'ok');
          else p(`${word}: [${h}]`, changed ? 'chg' : 'ok');
          if (r.diff && opts.diff) for (const l of r.diff) p(l, l.startsWith('+') ? 'ok' : 'dim');
          if (opts.check && r.changed && r.cmds && r.cmds.length) p(`  ↳ 檢查模式 (--check)：只算出要下的指令，沒有真的送到設備：${r.cmds.join(' / ')}`, 'hint');
        }
        if (anyFail) continue;
        if (hostSkip === items.length) { R(h).skipped++; continue; }
        if (t.register) v[t.register] = res.length === 1 && t.loop == null && t.with_items == null ? res[0].result : { results: res.map((x) => x.result), changed: any };
        R(h).ok++;
        if (any) R(h).changed++;
      }
      if (!live.length) { p(''); p('NO MORE HOSTS LEFT ' + '*'.repeat(59), 'bad'); }
    }
    for (const h of Object.keys(conns)) { conns[h].close(); delete conns[h]; }
  }
  p('');
  p(banner('PLAY RECAP'), 'head');
  for (const [h, r] of Object.entries(recap)) {
    const col = (k) => `${k}=${String(r[k]).padEnd(4)}`;
    p(`${h.padEnd(26)} : ${col('ok')} ${col('changed')} ${col('unreachable')} ${col('failed')} ${col('skipped')} ${col('rescued')} ${col('ignored')}`, r.failed || r.unreachable ? 'bad' : r.changed ? 'chg' : 'ok');
    if (r.unreachable) rc = Math.max(rc, 4); else if (r.failed) rc = Math.max(rc, 2);
  }
  // 關卡用：記下每一次執行的結果（--check 也記，但會標示出來）
  const runs = (((state.dyn ||= {}).ansible ||= {}).runs ||= []);
  runs.push({ t: state.clock, from: fromId, check: !!opts.check, limit: opts.limit || '', recap: JSON.parse(JSON.stringify(recap)), devs: { ...hostDev } });
  if (runs.length > 12) runs.splice(0, runs.length - 12);
  recompute(state);
  return { lines: out, recap, secs: Math.round(secs), rc, traces };
}

function runModule(mod, c, args, vars, o) {
  const d = c && c.dev && c.dev();
  switch (mod) {
    case 'ansible.builtin.debug': {
      if (args.var != null) {
        let v;
        try { v = evalExpr(String(args.var), vars); } catch { v = 'VARIABLE IS NOT DEFINED!'; }
        return { show: { [args.var]: v }, result: { [args.var]: v } };
      }
      return { show: { msg: args.msg ?? 'Hello world!' }, result: { msg: args.msg } };
    }
    case 'ansible.builtin.assert': {
      const that = asList(args.that);
      for (const x of that) {
        let ok;
        try { ok = cond(String(x), vars); } catch (e) { return { fail: `The conditional check '${x}' failed. The error was: ${e.message}` }; }
        if (!ok) return { fail: args.fail_msg || args.msg || 'Assertion failed', extra: { assertion: x, evaluated_to: false } };
      }
      return { show: { msg: args.success_msg || 'All assertions passed' }, result: {} };
    }
    case 'cisco.ios.ios_facts': {
      const f = facts(c);
      Object.assign(vars, f);
      return { result: { ansible_facts: f } };
    }
    case 'cisco.ios.ios_command': case 'ansible.netcommon.cli_command': {
      const cmds = asList(mod === 'ansible.netcommon.cli_command' ? args.command : args.commands).map(String);
      if (!cmds.length) return { fail: 'missing required arguments: commands' };
      const stdout = [];
      for (const cmd of cmds) {
        if (mod === 'cisco.ios.ios_command' && /^conf/i.test(cmd.trim())) return { fail: 'ios_command does not support running config mode commands.  Please use ios_config instead', hint: 'ios_command 只能下 show 這類查看的指令；要改設定請用 ios_config 或 ios_vlans 這類模組' };
        const r = c.send(cmd);
        if (r.lost) return r;
        let lines = r.out.slice();
        if (r.pass && o.show) lines = o.show(o.state, d.id, c.sess, cmd);
        if (lines.some((l) => /^% (Invalid|Incomplete|Ambiguous)|不認識的指令/.test(l))) return { fail: lines.find((l) => l.startsWith('%')) || 'Invalid input', hint: `${hostName(d)} 不認識「${cmd}」` };
        stdout.push(lines.join('\n'));
      }
      const result = { changed: false, stdout, stdout_lines: stdout.map((s) => s.split('\n')) };
      return { result, secs: 0.5 * cmds.length };
    }
    case 'cisco.ios.ios_config': {
      const r = configCmds(c, args);
      if (r.fail) return r;
      if (!r.cmds.length) {
        if (args.save_when === 'always' && !o.check) { saveStartup(d); return { changed: true, result: { changed: true, saved: true } }; }
        return { result: { changed: false } };
      }
      if (o.check) return { changed: true, cmds: r.cmds, result: { changed: true, commands: r.cmds, updates: r.cmds } };
      const before = c.run().join('\n');
      const pr = push(c, r.cmds);
      if (pr.lost) return pr;
      if (pr.error) return { fail: pr.error, hint: pr.hint };
      // ios_config 只比對「這一行有沒有出現在 running-config」：有送出指令就算 changed。
      // 像 switchport trunk allowed vlan add 50 這種不會原樣出現在設定裡的指令，每次跑都會是 changed（不冪等）
      void before;
      if (args.save_when === 'always' || (args.save_when === 'modified' && iosDirty(o.state, d)) || args.save_when === 'changed') saveStartup(d);
      return { changed: true, cmds: r.cmds, result: { changed: true, commands: r.cmds, updates: r.cmds, banners: {} }, secs: 0.3 * r.cmds.length };
    }
    case 'cisco.ios.ios_vlans': case 'cisco.ios.ios_l2_interfaces': case 'cisco.ios.ios_interfaces': case 'cisco.ios.ios_l3_interfaces': {
      const r = resourceCmds(mod, c, args);
      if (r.fail) return r;
      if (!r.cmds.length) return { result: { changed: false, commands: [] } };
      if (o.check) return { changed: true, cmds: r.cmds, result: { changed: true, commands: r.cmds } };
      const before = c.run().join('\n');
      const pr = push(c, r.cmds.map((x) => x.trim()));
      if (pr.lost) return pr;
      if (pr.error) return { fail: pr.error, hint: pr.hint };
      return { changed: c.run().join('\n') !== before, cmds: r.cmds, result: { changed: true, commands: r.cmds.map((x) => x.trim()) }, secs: 0.3 * r.cmds.length };
    }
    case 'ansible.builtin.ping': return { result: { ping: 'pong' } };
    default: return { fail: `couldn't resolve module/action '${mod}'` };
  }
}

void parseMask; void YamlError;
