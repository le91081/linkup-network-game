// Terraform（基礎架構即程式碼）：控制主機上的 main.tf 描述「應該長什麼樣子」，plan 比對雲端實際的樣子，apply 把它改成一樣。
// 這裡支援 HCL 的一小部分：terraform / provider "aws" 區塊、resource "aws_security_group"（inline 的 ingress / egress 區塊）。
// inline 規則是「整組管理」：在主控台手動加的規則不在 main.tf 裡，下一次 apply 就會被拿掉（drift）。
//
// 控制主機：d.tf = { main（main.tf 的內容）, inited, state: { 'aws_security_group.web': { id, in, out } } }
//   state 記的是「上一次 apply 之後」的樣子：plan 拿它和雲端現在的樣子比，就知道有人在 Terraform 之外改過（drift）
import { parseCidr, parseIp } from './ip.js';
import { transact } from './sim.js';

// ───────────────────────── HCL ─────────────────────────

const hclErr = (msg, line) => Object.assign(new Error(msg), { hcl: true, line });

/** 把 HCL 拆成 token：字串、數字、識別字、符號 */
function tokens(src) {
  const out = [];
  const re = /\s+|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"\\\n]|\\.)*)"|(-?\d+)|([A-Za-z_][\w.-]*)|([{}[\]=,])/g;
  let m, line = 1, last = 0;
  while ((m = re.exec(src))) {
    if (m.index !== last) break;
    const at = line;
    line += (m[0].match(/\n/g) || []).length;
    last = re.lastIndex;
    if (m[1] != null) out.push({ t: 'str', v: m[1], line: at });
    else if (m[2] != null) out.push({ t: 'num', v: +m[2], line: at });
    else if (m[3] != null) out.push({ t: 'id', v: m[3], line: at });
    else if (m[4] != null) out.push({ t: m[4], line: at });
  }
  if (last < src.length) {
    const rest = src.slice(last);
    throw hclErr(rest[0] === '"' ? '字串沒有結束（少了右邊的 "）' : `無法辨識的字元「${rest.trim().slice(0, 12)}」`, line);
  }
  return out;
}

/** 解析成 [{ kind: 'resource' | 'provider' | 'terraform', type, name, body: { attrs, blocks: [{ name, body }] }, line }] */
export function parseHcl(src) {
  const t = tokens(src);
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const lastLine = () => (t[t.length - 1] || {}).line || 1;
  const show = (x) => (x.t === 'str' ? `"${x.v}"` : x.v ?? x.t);
  const expect = (k, what) => {
    const x = next();
    if (!x) throw hclErr(`檔案結束了，還少了${what || `「${k}」`}`, lastLine());
    if (x.t !== k) throw hclErr(`這裡應該是${what || `「${k}」`}，看到的是「${show(x)}」`, x.line);
    return x;
  };
  const value = () => {
    const x = next();
    if (!x) throw hclErr('值還沒寫完，檔案就結束了', lastLine());
    if (x.t === 'str' || x.t === 'num') return x.v;
    if (x.t === 'id') return x.v === 'true' ? true : x.v === 'false' ? false : { ref: x.v };
    if (x.t === '[') {
      const arr = [];
      while (peek() && peek().t !== ']') {
        arr.push(value());
        if (peek() && peek().t === ',') next();
        else if (peek() && peek().t !== ']') throw hclErr(`清單裡的值要用逗號隔開（看到「${show(peek())}」）`, peek().line);
      }
      expect(']', '清單結尾的「]」');
      return arr;
    }
    // 物件：{ source = "hashicorp/aws", version = "~> 5.0" }（required_providers 會用到）
    if (x.t === '{') {
      const obj = {};
      while (peek() && peek().t !== '}') {
        const k = next();
        if (k.t !== 'id' && k.t !== 'str') throw hclErr(`物件裡要寫「名稱 = 值」，看到的是「${show(k)}」`, k.line);
        expect('=', `「${k.v}」後面的「=」`);
        obj[k.v] = value();
        if (peek() && peek().t === ',') next();
      }
      expect('}', '物件結尾的「}」');
      return obj;
    }
    throw hclErr(`「=」後面要接值，看到的是「${show(x)}」`, x.line);
  };
  const body = () => {
    const open = expect('{', '區塊開頭的「{」');
    const b = { attrs: {}, blocks: [], line: open.line };
    while (peek() && peek().t !== '}') {
      const k = expect('id', '屬性名稱');
      if (peek() && peek().t === '=') { next(); if (k.v in b.attrs) throw hclErr(`屬性「${k.v}」寫了兩次`, k.line); b.attrs[k.v] = value(); b.attrs[k.v + '@'] = k.line; }
      else if (peek() && peek().t === '{') b.blocks.push({ name: k.v, body: body(), line: k.line });
      else throw hclErr(`「${k.v}」後面要接「=」（屬性）或「{」（區塊）`, k.line);
    }
    expect('}', '區塊結尾的「}」');
    return b;
  };
  const out = [];
  while (i < t.length) {
    const k = expect('id', 'terraform、provider 或 resource');
    if (k.v === 'resource') { const ty = expect('str', '資源類型（例如 "aws_security_group"）'), nm = expect('str', '資源名稱（例如 "web"）'); out.push({ kind: 'resource', type: ty.v, name: nm.v, body: body(), line: k.line }); }
    else if (k.v === 'provider') { const nm = expect('str', 'provider 名稱（例如 "aws"）'); out.push({ kind: 'provider', name: nm.v, body: body(), line: k.line }); }
    else if (k.v === 'terraform') out.push({ kind: 'terraform', body: body(), line: k.line });
    else throw hclErr(`頂層只能是 terraform、provider 或 resource（看到「${k.v}」）`, k.line);
  }
  return out;
}

// ───────────────────────── 規則 ─────────────────────────

const PROTO = { tcp: 'tcp', udp: 'udp', icmp: 'icmp', '-1': 'all', all: 'all', 6: 'tcp', 17: 'udp', 1: 'icmp' };

/** HCL 的 ingress / egress 區塊 → 模擬裡的安全群組規則；有錯就丟 hclErr */
function rulesOf(r, dir) {
  const out = [];
  for (const b of r.body.blocks.filter((x) => x.name === dir)) {
    const a = b.body.attrs, where = `${r.type}.${r.name} 的 ${dir} 區塊（第 ${b.line} 行）`;
    for (const k of ['from_port', 'to_port', 'protocol']) if (!(k in a)) throw hclErr(`${where}少了必要的屬性「${k}」`, b.line);
    const proto = PROTO[String(a.protocol).toLowerCase()];
    if (!proto) throw hclErr(`${where}：protocol「${a.protocol}」不認得（tcp、udp、icmp 或 "-1" 代表全部）`, a['protocol@']);
    const f = +a.from_port, t = +a.to_port;
    if (proto === 'tcp' || proto === 'udp') {
      if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || t > 65535 || f > t) throw hclErr(`${where}：埠的範圍 ${a.from_port}～${a.to_port} 不對`, a['from_port@']);
    }
    const port = proto === 'tcp' || proto === 'udp' ? (f === t ? String(f) : `${f}-${t}`) : '';
    const cidrs = a.cidr_blocks == null ? [] : a.cidr_blocks, sgs = a.security_groups == null ? [] : a.security_groups;
    if (!Array.isArray(cidrs)) throw hclErr(`${where}：cidr_blocks 要是清單，例如 ["0.0.0.0/0"]`, a['cidr_blocks@']);
    if (!Array.isArray(sgs)) throw hclErr(`${where}：security_groups 要是清單，例如 ["sg-0123"]`, a['security_groups@']);
    for (const c of cidrs) if (typeof c !== 'string' || !parseCidr(c)) throw hclErr(`${where}：「${typeof c === 'object' ? c.ref : c}」不是正確的 CIDR（例如 "203.0.113.34/32"）`, a['cidr_blocks@']);
    if (!cidrs.length && !sgs.length) throw hclErr(`${where}：要有 cidr_blocks 或 security_groups`, b.line);
    for (const c of [...cidrs, ...sgs.map((x) => (typeof x === 'object' ? x.ref : x))]) out.push(dir === 'ingress' ? { proto, port, src: c } : { proto, port, dst: c });
  }
  return out;
}
const peerOf = (r, dir) => (dir === 'in' ? r.src : r.dst);
const key = (r, dir) => `${dir}|${r.proto}|${r.port || ''}|${peerOf(r, dir)}`;
/** 規則用 HCL 的樣子印出來：{ protocol = "tcp", from_port = 22, to_port = 22, cidr_blocks = ["0.0.0.0/0"] } */
export function ruleHcl(r, dir) {
  const [f, t] = r.port ? r.port.split('-').concat(r.port).slice(0, 2) : [0, 0];
  const p = peerOf(r, dir);
  return `{ protocol = "${r.proto === 'all' ? '-1' : r.proto}", from_port = ${+f}, to_port = ${+t}, ${/^sg-/.test(p) ? 'security_groups' : 'cidr_blocks'} = ["${p}"] }`;
}
const copyRules = (a) => a.map((r) => ({ ...r }));

/** main.tf → 想要的安全群組（{ list, errs }） */
function desired(state, conf) {
  const out = [], errs = [];
  if (!conf.some((x) => x.kind === 'provider' && x.name === 'aws')) errs.push('Missing required provider: 找不到 provider "aws" 區塊（要寫 region）');
  for (const r of conf.filter((x) => x.kind === 'resource')) {
    if (r.type !== 'aws_security_group') { errs.push(`Invalid resource type: 這個模擬只支援 aws_security_group（第 ${r.line} 行是 ${r.type}）`); continue; }
    if (out.some((x) => x.addr === `${r.type}.${r.name}`)) { errs.push(`Duplicate resource "${r.type}" configuration: 「${r.name}」寫了兩次`); continue; }
    const a = r.body.attrs;
    const cloud = Object.values(state.devices).find((d) => d.vpc && d.vpc.id === a.vpc_id);
    if (!a.vpc_id) { errs.push(`${r.type}.${r.name}：少了 vpc_id`); continue; }
    if (!cloud) { errs.push(`${r.type}.${r.name}：vpc_id = "${typeof a.vpc_id === 'object' ? a.vpc_id.ref : a.vpc_id}" 不存在 (InvalidVpcID.NotFound)`); continue; }
    try { out.push({ addr: `${r.type}.${r.name}`, rname: r.name, name: a.name || r.name, cloud, in: rulesOf(r, 'ingress'), out: rulesOf(r, 'egress') }); } catch (e) { errs.push(e.message); }
  }
  return { list: out, errs };
}

/** 兩組規則的差異：[[dir, rule, '+' | '-'], ...] */
function diff(fromIn, fromOut, toIn, toOut) {
  const have = new Set([...fromIn.map((r) => key(r, 'in')), ...fromOut.map((r) => key(r, 'out'))]);
  const want = new Set([...toIn.map((r) => key(r, 'in')), ...toOut.map((r) => key(r, 'out'))]);
  return [
    ...fromIn.filter((r) => !want.has(key(r, 'in'))).map((r) => ['in', r, '-']), ...fromOut.filter((r) => !want.has(key(r, 'out'))).map((r) => ['out', r, '-']),
    ...toIn.filter((r) => !have.has(key(r, 'in'))).map((r) => ['in', r, '+']), ...toOut.filter((r) => !have.has(key(r, 'out'))).map((r) => ['out', r, '+']),
  ];
}
const findSg = (x, id) => x.cloud.vpc.sgs.find((g) => g.id === id);

/**
 * 算出計畫（不連線、不改東西）：{ err?: [字串], drift: [...], changes: [...] }
 * changes：{ addr, x, sg, create?, d: [[dir, rule, '+'|'-']] }
 */
export function tfPlan(state, d) {
  const tf = d.tf;
  let conf;
  try { conf = parseHcl(tf.main || ''); } catch (e) { return { err: [`Error: ${e.hcl ? 'Invalid configuration syntax' : 'Error'}`, '', `  on main.tf line ${e.line || 1}:`, `  ${e.message}`] }; }
  const { list, errs } = desired(state, conf);
  if (errs.length) return { err: errs.map((x) => `Error: ${x}`) };
  const drift = [], changes = [], refresh = [];
  for (const x of list) {
    const st = tf.state[x.addr];
    const sg = st ? findSg(x, st.id) : null;
    refresh.push(st ? `${x.addr}: Refreshing state... [id=${st.id}]` : null);
    if (st && !sg) drift.push({ addr: x.addr, gone: true });
    else if (st && st.in) { const dd = diff(st.in, st.out, sg.in, sg.out); if (dd.length) drift.push({ addr: x.addr, sg, d: dd }); }
    if (!sg) { changes.push({ addr: x.addr, x, create: true, d: [...x.in.map((r) => ['in', r, '+']), ...x.out.map((r) => ['out', r, '+'])] }); continue; }
    const dd = diff(sg.in, sg.out, x.in, x.out);
    if (dd.length) changes.push({ addr: x.addr, x, sg, d: dd });
  }
  // state 裡有、main.tf 裡沒有了：要刪掉
  for (const [addr, st] of Object.entries(tf.state)) {
    if (list.some((x) => x.addr === addr)) continue;
    const cloud = Object.values(state.devices).find((c) => c.vpc && c.vpc.sgs.some((g) => g.id === st.id));
    refresh.push(`${addr}: Refreshing state... [id=${st.id}]`);
    if (cloud) changes.push({ addr, destroy: true, sg: cloud.vpc.sgs.find((g) => g.id === st.id), cloud, d: [] });
  }
  return { refresh: refresh.filter(Boolean), drift, changes };
}

/** 計畫印出來的樣子（terraform plan 的輸出）：[{ t, c }] */
function planLines(p, applyMode) {
  const out = [], P = (t, c = '') => out.push({ t, c });
  const sign = { '+': 'ok', '-': 'bad', '~': 'warn' };
  for (const l of p.refresh) P(l);
  if (p.drift.length) {
    P('');
    P('Note: Objects have changed outside of Terraform', 'warn');
    P('');
    P('Terraform detected the following changes made outside of Terraform since the last "terraform apply" which may have affected this plan:');
    for (const x of p.drift) {
      P('');
      if (x.gone) { P(`  # ${x.addr} has been deleted`, 'warn'); P(`  - resource "aws_security_group" "${x.addr.split('.')[1]}" {`, 'bad'); P('    }'); continue; }
      P(`  # ${x.addr} has changed`, 'warn');
      P(`  ~ resource "aws_security_group" "${x.addr.split('.')[1]}" {`, 'warn');
      P(`        id      = "${x.sg.id}"`);
      for (const [dir, r, s] of x.d) P(`      ${s} ${dir === 'in' ? 'ingress' : 'egress '} ${ruleHcl(r, dir)}`, sign[s]);
      P('    }');
    }
    P('');
    P('Unless you have made equivalent changes to your configuration, or ignored the relevant attributes using ignore_changes, the following plan may include actions to undo or respond to these changes.', 'dim');
  }
  P('');
  if (!p.changes.length) {
    P('No changes. Your infrastructure matches the configuration.', 'ok');
    P('');
    if (p.drift.length) { P('Your configuration already matches the changes detected above. If you\'d like to update the Terraform state to match, create and apply a refresh-only plan:', 'dim'); P('  terraform apply -refresh-only', 'dim'); }
    else P('Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.', 'dim');
    return out;
  }
  P('Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:');
  if (p.changes.some((c) => c.create)) P('  + create', 'ok');
  if (p.changes.some((c) => !c.create && !c.destroy)) P('  ~ update in-place', 'warn');
  if (p.changes.some((c) => c.destroy)) P('  - destroy', 'bad');
  P('');
  P('Terraform will perform the following actions:');
  for (const c of p.changes) {
    const nm = c.addr.split('.')[1];
    P('');
    if (c.create) {
      P(`  # ${c.addr} will be created`);
      P(`  + resource "aws_security_group" "${nm}" {`, 'ok');
      P(`      + id      = (known after apply)`, 'ok');
      P(`      + name    = "${c.x.name}"`, 'ok');
      P(`      + vpc_id  = "${c.x.cloud.vpc.id}"`, 'ok');
      for (const [dir, r] of c.d) P(`      + ${dir === 'in' ? 'ingress' : 'egress '} ${ruleHcl(r, dir)}`, 'ok');
      P('    }');
    } else if (c.destroy) {
      P(`  # ${c.addr} will be destroyed`);
      P(`  # (because ${c.addr} is not in configuration)`, 'dim');
      P(`  - resource "aws_security_group" "${nm}" {`, 'bad');
      P(`      - id      = "${c.sg.id}" -> null`, 'bad');
      P(`      - name    = "${c.sg.name}" -> null`, 'bad');
      P('    }');
    } else {
      P(`  # ${c.addr} will be updated in-place`);
      P(`  ~ resource "aws_security_group" "${nm}" {`, 'warn');
      P(`        id      = "${c.sg.id}"`);
      P(`        name    = "${c.sg.name}"`);
      for (const [dir, r, s] of c.d) P(`      ${s} ${dir === 'in' ? 'ingress' : 'egress '} ${ruleHcl(r, dir)}`, sign[s]);
      P('    }');
    }
  }
  const n = (f) => p.changes.filter(f).length;
  P('');
  P(`Plan: ${n((c) => c.create)} to add, ${n((c) => !c.create && !c.destroy)} to change, ${n((c) => c.destroy)} to destroy.`, 'head');
  if (!applyMode) { P(''); P('─'.repeat(60), 'dim'); P(''); P('Note: You didn\'t use the -out option to save this plan, so Terraform can\'t guarantee to take exactly these actions if you run "terraform apply" now.', 'dim'); }
  return out;
}

// ───────────────────────── 連線 ─────────────────────────

/** 雲端的 API 與 Terraform Registry（關卡在「網際網路」上加這兩台主機） */
export const TF_HOSTS = [
  { ip: '52.119.161.5', name: 'ec2.ap-northeast-1.amazonaws.com', services: [{ proto: 'tcp', port: 443 }] },
  { ip: '151.101.2.49', name: 'registry.terraform.io', services: [{ proto: 'tcp', port: 443 }] },
];
export function addTfHosts(inet) {
  for (const x of TF_HOSTS) { inet.inet.hosts.push({ ...x, services: x.services.map((s) => ({ ...s })) }); inet.inet.dns[x.name] = x.ip; }
}
/** 控制主機連得上 HTTPS 的 API 嗎？連不上回傳錯誤字串 */
function reach(state, devId, host) {
  const h = TF_HOSTS.find((x) => x.name === host);
  const r = transact(state, devId, { proto: 'tcp', dst: parseIp(h.ip), dport: 443, quiet: true });
  return r.ok ? null : `dial tcp ${h.ip}:443: ${/拒絕|refused|RST/i.test(r.reason || '') ? 'connect: connection refused' : 'i/o timeout'}（${r.reason || '連不上'}）`;
}

// ───────────────────────── 指令 ─────────────────────────

const box = (lines) => [{ t: '╷', c: 'bad' }, ...lines.map((t, i) => ({ t: '│ ' + t, c: i === 0 ? 'bad' : '' })), { t: '╵', c: 'bad' }];
const NOT_INITED = ['Error: Inconsistent dependency lock file', '', 'The following dependency selections recorded in the lock file are inconsistent with the current configuration:', '  - provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected', '', 'To make the initial dependency selections that will initialize the dependency lock file, run:', '  terraform init'];

/** 印出 import 用的 id（找 state 裡的資源用） */
function stateIds(tf) { return Object.entries(tf.state).map(([a, s]) => `${a}  ${s.id}`); }

/**
 * 執行一個 terraform 指令。args 例如 ['plan']、['apply', '-auto-approve']、['import', 'aws_security_group.web', 'sg-0web']
 * 回傳 { lines: [{ t, c }], rc, applied }。改了雲端之後呼叫的一方要 recompute。
 */
export function terraform(state, devId, args) {
  const d = state.devices[devId], tf = d.tf;
  const sub = args[0] || '', flags = args.slice(1);
  const out = [], P = (t, c = '') => out.push({ t, c });
  const done = (rc, extra = {}) => ({ lines: out, rc, ...extra });
  const fail = (lines) => { out.push(...box(lines)); return done(1); };
  if (!sub || sub === '-help' || sub === '--help' || sub === 'help') {
    ['Usage: terraform [global options] <subcommand> [args]', '', 'Main commands:', '  init          Prepare your working directory for other commands', '  validate      Check whether the configuration is valid', '  plan          Show changes required by the current configuration', '  apply         Create or update infrastructure', '', 'All other commands:', '  import        Associate existing infrastructure with a Terraform resource', '  state list    List resources in the state', '  version       Show the current Terraform version'].forEach((l) => P(l));
    return done(sub ? 0 : 127);
  }
  if (sub === 'version' || sub === '-version' || sub === '--version') { P('Terraform v1.6.6'); P('on linux_amd64'); if (tf.inited) P('+ provider registry.terraform.io/hashicorp/aws v5.31.0'); return done(0); }
  if (sub === 'init') {
    P('');
    P('Initializing the backend...', 'head');
    P('');
    P('Initializing provider plugins...', 'head');
    if (!tf.inited) {
      const e = reach(state, devId, 'registry.terraform.io');
      if (e) return fail(['Error: Failed to query available provider packages', '', 'Could not retrieve the list of available versions for provider hashicorp/aws: could not connect to registry.terraform.io: failed to request discovery document: Get "https://registry.terraform.io/.well-known/terraform.json": ' + e]);
      P('- Finding hashicorp/aws versions matching "~> 5.0"...');
      P('- Installing hashicorp/aws v5.31.0...');
      P('- Installed hashicorp/aws v5.31.0 (signed by HashiCorp)');
      P('');
      P('Terraform has created a lock file .terraform.lock.hcl to record the provider selections it made above. Include this file in your version control repository so that Terraform can guarantee to make the same selections by default when you run "terraform init" in the future.', 'dim');
    } else P('- Reusing previous version of hashicorp/aws from the dependency lock file');
    tf.inited = true;
    P('');
    P('Terraform has been successfully initialized!', 'ok');
    return done(0);
  }
  if (!['validate', 'plan', 'apply', 'import', 'state', 'show'].includes(sub)) { P(`Terraform has no command named "${sub}".`, 'bad'); P(''); P('To see all of Terraform\'s top-level commands, run:'); P('  terraform -help'); return done(1); }
  if (!tf.inited) return fail(NOT_INITED);
  if (sub === 'state') {
    if (flags[0] !== 'list') { P('Usage: terraform state list', 'bad'); return done(1); }
    Object.keys(tf.state).forEach((a) => P(a));
    return done(0);
  }
  if (sub === 'show') { if (!Object.keys(tf.state).length) P('No state.'); else stateIds(tf).forEach((l) => P(l)); return done(0); }
  const p = tfPlan(state, d);
  if (p.err) return fail(p.err);
  if (sub === 'validate') { P('Success! The configuration is valid.', 'ok'); return done(0); }
  const api = reach(state, devId, 'ec2.ap-northeast-1.amazonaws.com');
  if (api) return fail(['Error: configuring Terraform AWS Provider: validating provider credentials: retrieving caller identity from STS: operation error STS: GetCallerIdentity, exceeded maximum number of attempts, 9, https response error StatusCode: 0, RequestID: , request send failed, Post "https://sts.ap-northeast-1.amazonaws.com/": ' + api]);
  if (sub === 'import') {
    const [addr, id] = flags;
    if (!addr || !id) { P('Usage: terraform import [options] ADDRESS ID', 'bad'); return done(1); }
    const conf = parseHcl(tf.main);
    const r = conf.find((x) => x.kind === 'resource' && `${x.type}.${x.name}` === addr);
    if (!r) return fail([`Error: resource address "${addr}" does not exist in the configuration.`, '', 'Before importing this resource, please create its configuration in the root module. For example:', '', `resource "${addr.split('.')[0]}" "${addr.split('.')[1] || 'name'}" {`, '  # (resource arguments)', '}']);
    if (tf.state[addr]) return fail(['Error: Resource already managed by Terraform', '', `Terraform is already managing a remote object for ${addr}. To import to this address you must first remove the existing object from the state.`]);
    const cloud = Object.values(state.devices).find((c) => c.vpc && c.vpc.sgs.some((g) => g.id === id));
    if (!cloud) return fail([`Error: Cannot import non-existent remote object`, '', `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`]);
    const sg = cloud.vpc.sgs.find((g) => g.id === id);
    P(`${addr}: Importing from ID "${id}"...`, 'head');
    P(`${addr}: Import prepared!`, 'ok');
    P(`  Prepared aws_security_group for import`);
    P(`${addr}: Refreshing state... [id=${id}]`);
    P('');
    P('Import successful!', 'ok');
    P('');
    P('The resources that were imported are shown above. These resources are now in your Terraform state and will henceforth be managed by Terraform.', 'dim');
    tf.state[addr] = { id, in: copyRules(sg.in), out: copyRules(sg.out) };
    return done(0);
  }
  if (sub === 'plan') { out.push(...planLines(p, false)); return done(0, { changes: p.changes.length }); }
  // apply
  const auto = flags.includes('-auto-approve') || flags.includes('--auto-approve');
  if (flags.includes('-refresh-only')) {
    p.refresh.forEach((l) => P(l));
    P('');
    if (!p.drift.length) { P('No changes. Your infrastructure still matches the configuration.', 'ok'); return done(0); }
    for (const x of p.drift) {
      if (x.gone) delete tf.state[x.addr];
      else tf.state[x.addr] = { id: x.sg.id, in: copyRules(x.sg.in), out: copyRules(x.sg.out) };
      P(`  # ${x.addr} has ${x.gone ? 'been deleted' : 'changed'}`, 'warn');
    }
    P('');
    P('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.', 'ok');
    P('（只把 state 更新成雲端現在的樣子，雲端本身沒有改變。main.tf 和雲端不一樣的地方，下一次 plan 仍然會要改回來）', 'dim');
    return done(0);
  }
  out.push(...planLines(p, true));
  if (!p.changes.length) { P(''); P('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.', 'ok'); return done(0); }
  P('');
  if (!auto) {
    P('Do you want to perform these actions?', 'head');
    P('  Terraform will perform the actions described above.');
    P('  Only \'yes\' will be accepted to approve.');
    P('');
    P('  Enter a value: ', 'head');
    return done(0, { ask: true });
  }
  return applyChanges(state, d, p, out);
}

/** 照計畫改雲端（apply 確認之後） */
export function tfApplyConfirmed(state, devId) {
  const d = state.devices[devId], out = [];
  const p = tfPlan(state, d);
  if (p.err) { out.push(...box(p.err)); return { lines: out, rc: 1 }; }
  return applyChanges(state, d, p, out);
}

function applyChanges(state, d, p, out) {
  const P = (t, c = '') => out.push({ t, c }), tf = d.tf;
  let add = 0, chg = 0, del = 0;
  for (const c of p.changes) {
    if (c.create) {
      const v = c.x.cloud.vpc;
      if (v.sgs.some((g) => g.name === c.x.name)) {
        P(`${c.addr}: Creating...`, 'head');
        out.push(...box([`Error: creating Security Group (${c.x.name}): operation error EC2: CreateSecurityGroup, https response error StatusCode: 400, api error InvalidGroup.Duplicate: The security group '${c.x.name}' already exists for VPC '${v.id}'`, '', `  with ${c.addr},`, '  on main.tf, in resource "aws_security_group":', '', `（雲端已經有這個安全群組了，只是 Terraform 的 state 裡沒有它：用 terraform import ${c.addr} <sg-id> 把它納入管理）`]));
        return { lines: out, rc: 1, applied: add + chg + del > 0 };
      }
      let n = 0, id;
      do { id = 'sg-0' + ((c.addr.length * 2654435761 + v.sgs.length * 40503 + n++ * 97) >>> 0).toString(16).padStart(8, '0') + 'e3f1a29c'; } while (v.sgs.some((g) => g.id === id));
      v.sgs.push({ id, name: c.x.name, in: copyRules(c.x.in), out: copyRules(c.x.out) });
      tf.state[c.addr] = { id, in: copyRules(c.x.in), out: copyRules(c.x.out) };
      P(`${c.addr}: Creating...`, 'head');
      P(`${c.addr}: Creation complete after 3s [id=${id}]`, 'ok');
      add++;
    } else if (c.destroy) {
      const v = c.cloud.vpc, inUse = [...v.instances, ...(v.lbs || [])].find((x) => (x.sgs || [x.sg]).includes(c.sg.id));
      P(`${c.addr}: Destroying... [id=${c.sg.id}]`, 'head');
      if (inUse) {
        out.push(...box([`Error: deleting Security Group (${c.sg.id}): DependencyViolation: resource ${c.sg.id} has a dependent object`, '', `（${inUse.name} 還掛著這個安全群組，刪不掉）`]));
        return { lines: out, rc: 1, applied: add + chg + del > 0 };
      }
      v.sgs.splice(v.sgs.indexOf(c.sg), 1);
      delete tf.state[c.addr];
      P(`${c.addr}: Destruction complete after 1s`, 'ok');
      del++;
    } else {
      P(`${c.addr}: Modifying... [id=${c.sg.id}]`, 'head');
      c.sg.in = copyRules(c.x.in);
      c.sg.out = copyRules(c.x.out);
      tf.state[c.addr] = { id: c.sg.id, in: copyRules(c.x.in), out: copyRules(c.x.out) };
      P(`${c.addr}: Modifications complete after 2s [id=${c.sg.id}]`, 'ok');
      chg++;
    }
  }
  P('');
  P(`Apply complete! Resources: ${add} added, ${chg} changed, ${del} destroyed.`, 'ok');
  (tf.log ||= []).push({ t: state.clock, add, chg, del });
  return { lines: out, rc: 0, applied: true };
}

/** 新的控制主機：main.tf 與空的 state */
export function newTf(main, o = {}) {
  return { main, inited: !!o.inited, state: o.state || {}, log: [] };
}

/** terraform.tfstate 的樣子（唯讀，給分頁與 cat 看） */
export function tfStateJson(tf) {
  const rule = (r, dir) => {
    const [f, t] = r.port ? r.port.split('-').concat(r.port).slice(0, 2) : [0, 0];
    const p = dir === 'in' ? r.src : r.dst, sg = /^sg-/.test(p);
    return { cidr_blocks: sg ? [] : [p], from_port: +f, protocol: r.proto === 'all' ? '-1' : r.proto, security_groups: sg ? [p] : [], to_port: +t };
  };
  const res = Object.entries(tf.state).map(([addr, st]) => ({
    mode: 'managed', type: addr.split('.')[0], name: addr.split('.')[1], provider: 'provider["registry.terraform.io/hashicorp/aws"]',
    instances: [{ schema_version: 1, attributes: { id: st.id, ingress: (st.in || []).map((r) => rule(r, 'in')), egress: (st.out || []).map((r) => rule(r, 'out')) } }],
  }));
  return JSON.stringify({ version: 4, terraform_version: '1.6.6', serial: 7 + (tf.log || []).length, lineage: '3f9b2c1e-7a4d-4e8b-9c21-5d0e6f8a1b47', outputs: {}, resources: res }, null, 2);
}
