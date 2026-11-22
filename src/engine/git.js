// Git：設定檔的版本控制。備份伺服器上的 ./backup.sh 用 SSH 把每台設備的 running-config 抓回工作目錄，
// 再用 git 看差異 (diff)、加進暫存區 (add)、提交 (commit)。提交的歷史就是「誰、在什麼時候、改了什麼」。
//
// 備份伺服器：d.git = { commits: [{ id, parent, author, email, t, msg, files }], index: { 檔名: 內容 }, wt: { 檔名: 內容 }, devices: [{ id, ip, file }], backups: [...] }
//   commits[最後一筆] 是 HEAD（main 分支）。t 是相對模擬開始的秒數（可以是負的：模擬開始以前的提交）。
import { parseIp } from './ip.js';
import { transact } from './sim.js';
import { runningConfig } from './ios.js';
import { SIM_EPOCH } from './ops.js';

// ───────────────────────── 工具 ─────────────────────────

function sha(s) {
  let out = '', x = 2166136261, y = 0x9e3779b9;
  while (out.length < 40) {
    for (let i = 0; i < s.length; i++) { x = Math.imul(x ^ s.charCodeAt(i), 16777619); y = Math.imul(y ^ (x >>> 7), 2246822519); }
    out += (x >>> 0).toString(16).padStart(8, '0') + (y >>> 0).toString(16).padStart(8, '0');
    s += out;
  }
  return out.slice(0, 40);
}
const short = (id) => id.slice(0, 7);
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
/** 台灣時間 (+0800) */
function when(t) {
  const x = new Date(SIM_EPOCH + t * 1000 + 8 * 3600 * 1000);
  const hms = `${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())}`;
  return { log: `${DAY[x.getUTCDay()]} ${MON[x.getUTCMonth()]} ${x.getUTCDate()} ${hms} ${x.getUTCFullYear()} +0800`, iso: `${x.getUTCFullYear()}-${two(x.getUTCMonth() + 1)}-${two(x.getUTCDate())} ${hms} +0800` };
}
const lines = (s) => (s === '' || s == null ? [] : String(s).replace(/\n$/, '').split('\n'));

/** 設備現在的設定（備份檔的樣子：拿掉 Building configuration... 這種每次都會變的開頭） */
export function cfgText(state, d) {
  const l = runningConfig(state, d);
  while (l.length && (/^Building configuration/.test(l[0]) || /^Current configuration/.test(l[0]) || l[0] === '')) l.shift();
  return l.join('\n') + '\n';
}

// ───────────────────────── 差異 ─────────────────────────

/** 一行一行比對（最長共同子序列）：[{ op: ' ' | '-' | '+', a, b, text }] */
export function lineDiff(A, B) {
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push({ op: ' ', a: i, b: j, text: A[i] }); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] > L[i + 1][j])) { out.push({ op: '+', a: i, b: j, text: B[j] }); j++; }
    else { out.push({ op: '-', a: i, b: j, text: A[i] }); i++; }
  }
  return out;
}

/** unified diff 的區塊（前後各 3 行）：[{ head, rows }] */
function hunks(A, B) {
  const d = lineDiff(A, B), out = [];
  const ch = d.map((x, k) => (x.op !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!ch.length) return out;
  let s = 0;
  while (s < ch.length) {
    let e = s;
    while (e + 1 < ch.length && ch[e + 1] - ch[e] <= 6) e++;
    const from = Math.max(0, ch[s] - 3), to = Math.min(d.length - 1, ch[e] + 3);
    const rows = d.slice(from, to + 1);
    const a0 = rows[0].a, b0 = rows[0].b;
    const na = rows.filter((x) => x.op !== '+').length, nb = rows.filter((x) => x.op !== '-').length;
    // 區塊標頭後面的「所在的段落」：往上找最近一行不是縮排開頭的（例如 interface GigabitEthernet1/0/2）
    let ctx = '';
    for (let k = a0 - 1; k >= 0; k--) if (/^[A-Za-z_$]/.test(A[k])) { ctx = A[k]; break; }
    const rng = (x, c) => (c === 1 ? `${x + 1}` : `${c ? x + 1 : x},${c}`);
    out.push({ head: `@@ -${rng(a0, na)} +${rng(b0, nb)} @@${ctx ? ' ' + ctx : ''}`, rows });
    s = e + 1;
  }
  return out;
}

/** 兩組檔案的差異：[{ t, c }]（git diff 的輸出） */
function diffFiles(from, to, only) {
  const out = [], P = (t, c) => out.push({ t, c });
  const names = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().filter((f) => !only || only.includes(f));
  for (const f of names) {
    const a = from[f], b = to[f];
    if (a === b) continue;
    P(`diff --git a/${f} b/${f}`, 'git head');
    if (a == null) P('new file mode 100644', 'git head');
    if (b == null) P('deleted file mode 100644', 'git head');
    P(`index ${short(sha(a || ''))}..${short(sha(b || ''))}${a != null && b != null ? ' 100644' : ''}`, 'git head');
    P(`--- ${a == null ? '/dev/null' : 'a/' + f}`, 'git head');
    P(`+++ ${b == null ? '/dev/null' : 'b/' + f}`, 'git head');
    for (const h of hunks(lines(a), lines(b))) {
      P(h.head, 'git hunk');
      for (const r of h.rows) P(r.op + r.text, r.op === '+' ? 'git ok' : r.op === '-' ? 'git bad' : 'git');
    }
  }
  return out;
}
/** --stat：每個檔案改了幾行 */
function statFiles(from, to, only) {
  const rows = [];
  for (const f of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    if ((only && !only.includes(f)) || from[f] === to[f]) continue;
    const d = lineDiff(lines(from[f]), lines(to[f]));
    rows.push({ f, add: d.filter((x) => x.op === '+').length, del: d.filter((x) => x.op === '-').length });
  }
  return rows;
}
function statLines(rows) {
  if (!rows.length) return [];
  const w = Math.max(...rows.map((r) => r.f.length));
  const A = rows.reduce((s, r) => s + r.add, 0), D = rows.reduce((s, r) => s + r.del, 0);
  return [...rows.map((r) => ({ t: ` ${r.f.padEnd(w)} | ${String(r.add + r.del).padStart(2)} ${'+'.repeat(Math.min(r.add, 30))}${'-'.repeat(Math.min(r.del, 30))}`, c: 'git' })),
    { t: ` ${rows.length} file${rows.length > 1 ? 's' : ''} changed${A ? `, ${A} insertion${A > 1 ? 's' : ''}(+)` : ''}${D ? `, ${D} deletion${D > 1 ? 's' : ''}(-)` : ''}`, c: 'git' }];
}

// ───────────────────────── 版本 ─────────────────────────

const head = (g) => g.commits[g.commits.length - 1];
/** HEAD、HEAD~2、HEAD^、main、提交編號（至少 4 碼） → 提交；找不到回傳 null */
function rev(g, r) {
  const m = String(r).match(/^(HEAD|main|@)((?:~\d*|\^+)*)$/);
  if (m) {
    let k = g.commits.length - 1;
    for (const x of m[2].match(/~\d*|\^/g) || []) k -= x === '^' ? 1 : x === '~' ? 1 : +x.slice(1);
    return g.commits[k] || null;
  }
  if (/^[0-9a-f]{4,40}$/i.test(r)) { const c = g.commits.filter((x) => x.id.startsWith(r.toLowerCase())); return c.length === 1 ? c[0] : null; }
  return null;
}
const parentOf = (g, c) => g.commits.find((x) => x.id === c.parent) || null;
const badRev = (r) => [{ t: `fatal: ambiguous argument '${r}': unknown revision or path not in the working tree.`, c: 'bad' }, { t: "Use '--' to separate paths from revisions, like this:", c: '' }, { t: "'git <command> [<revision>...] -- [<file>...]'", c: '' }];

function logEntry(g, c, P, oneline) {
  const tag = c === head(g) ? ' (HEAD -> main)' : '';
  if (oneline) { P(`${short(c.id)}${tag} ${c.msg.split('\n')[0]}`, 'git commit'); return; }
  P(`commit ${c.id}${tag}`, 'git commit');
  P(`Author: ${c.author} <${c.email}>`, 'git');
  P(`Date:   ${when(c.t).log}`, 'git');
  P('', 'git');
  for (const l of c.msg.split('\n')) P('    ' + l, 'git');
  P('', 'git');
}

/** 新的提交 */
export function makeCommit(g, o) {
  const parent = g.commits.length ? head(g).id : null;
  const c = { id: sha(`${parent}|${o.author}|${o.t}|${o.msg}|${JSON.stringify(o.files)}`), parent, author: o.author, email: o.email, t: o.t, msg: o.msg, files: { ...o.files } };
  g.commits.push(c);
  return c;
}
/** 新的備份伺服器儲存庫：history = [{ author, email, t, msg, files }]（最舊的在前面） */
export function newRepo(history, devices, extra = {}) {
  const g = { commits: [], index: {}, wt: {}, devices, backups: [] };
  for (const h of history) makeCommit(g, h);
  g.index = { ...head(g).files };
  g.wt = { ...head(g).files, ...extra };
  return g;
}

// ───────────────────────── ./backup.sh ─────────────────────────

/** 用 SSH 把每台設備的 running-config 抓回工作目錄 */
export function runBackup(state, devId) {
  const d = state.devices[devId], g = d.git, out = [], P = (t, c = '') => out.push({ t, c });
  const res = {};
  for (const x of g.devices) {
    const dev = state.devices[x.id];
    const r = transact(state, devId, { proto: 'tcp', dst: parseIp(x.ip), dport: 22, quiet: true });
    if (!dev || !r.ok) {
      res[x.id] = false;
      const why = r.reason || '';
      P(`${x.file.replace(/\.cfg$/, '').padEnd(6)} ${x.ip.padEnd(13)} FAILED  ssh: connect to host ${x.ip} port 22: ${/拒絕|refused|允許管理/.test(why) ? 'Connection refused' : 'Connection timed out'}`, 'bad');
      P(`         ↳ ${why}`, 'hint');
      continue;
    }
    const text = cfgText(state, dev), was = g.wt[x.file];
    g.wt[x.file] = text;
    res[x.id] = true;
    P(`${x.file.replace(/\.cfg$/, '').padEnd(6)} ${x.ip.padEnd(13)} ok      ${x.file}（${lines(text).length} 行${was === text ? '，沒有變更' : '，有變更'}）`, 'ok');
  }
  g.backups.push({ t: state.clock, res });
  if (g.backups.length > 10) g.backups.splice(0, g.backups.length - 10);
  const n = Object.values(res).filter((v) => !v).length;
  P('');
  P(n ? `完成：${n} 台備份失敗（工作目錄裡那幾台還是上一次抓到的設定）。` : '完成：用 git status / git diff 看看有什麼變更。', n ? 'warn' : 'dim');
  return { lines: out, res };
}

// ───────────────────────── git 指令 ─────────────────────────

const USER = { author: 'netops', email: 'netops@corp.local' };

/** 執行 git <args>：回傳 [{ t, c }] */
export function git(state, devId, args) {
  const d = state.devices[devId], g = d.git, out = [], P = (t, c = 'git') => out.push({ t, c });
  const [sub, ...rest] = args;
  const dashdash = rest.indexOf('--'), paths = dashdash >= 0 ? rest.slice(dashdash + 1) : null;
  const opts = dashdash >= 0 ? rest.slice(0, dashdash) : rest;
  const flags = opts.filter((x) => x.startsWith('-')), pos = opts.filter((x) => !x.startsWith('-'));
  const files = Object.keys(g.wt);
  // 位置參數裡的檔名也算路徑（git diff core.cfg）
  const fileArgs = paths || pos.filter((x) => files.includes(x) || g.index[x] != null);
  const revArgs = paths ? pos : pos.filter((x) => !files.includes(x) && g.index[x] == null);
  const H = head(g);
  switch (sub) {
    case undefined: case 'help': case '--help':
      ['usage: git <command> [<args>]', '', '這個模擬支援：', '   status     顯示工作目錄的狀態', '   diff       顯示差異（git diff、git diff --staged、git diff HEAD~1 HEAD、-- <檔名>）', '   add        把變更加進暫存區（git add core.cfg、git add -A）', '   commit     提交（git commit -m "說明"，-a 自動加入已追蹤的檔案）', '   restore    放棄工作目錄的修改（git restore <檔名>、--staged）', '   log        提交紀錄（--oneline、-p、-n 3、-- <檔名>）', '   show       顯示一筆提交與它的差異（git show HEAD~1、git show <編號>:<檔名>）', '   blame      每一行最後是哪一筆提交、誰改的'].forEach((l) => P(l));
      return out;
    case '--version': case 'version': P('git version 2.43.0'); return out;
    case 'status': {
      const staged = statFiles(H.files, g.index), unstaged = statFiles(g.index, g.wt);
      const kind = (from, to, f) => (from[f] == null ? 'new file:   ' : to[f] == null ? 'deleted:    ' : 'modified:   ');
      P('On branch main');
      if (!staged.length && !unstaged.length) { P('nothing to commit, working tree clean'); return out; }
      if (staged.length) { P('Changes to be committed:'); P('  (use "git restore --staged <file>..." to unstage)'); for (const r of staged) P(`\t${kind(H.files, g.index, r.f)}${r.f}`, 'git ok'); P(''); }
      if (unstaged.length) { P('Changes not staged for commit:'); P('  (use "git add <file>..." to update what will be committed)'); P('  (use "git restore <file>..." to discard changes in working directory)'); for (const r of unstaged) P(`\t${kind(g.index, g.wt, r.f)}${r.f}`, 'git bad'); P(''); }
      if (!staged.length) P('no changes added to commit (use "git add" and/or "git commit -a")');
      return out;
    }
    case 'add': {
      const all = flags.some((x) => x === '-A' || x === '--all') || pos.includes('.') || pos.includes('*');
      if (!all && !pos.length) { P('Nothing specified, nothing added.', 'warn'); P("hint: Maybe you wanted to say 'git add .'?", 'dim'); return out; }
      for (const f of all ? files : pos) {
        if (!(f in g.wt) && !(f in g.index)) { P(`fatal: pathspec '${f}' did not match any files`, 'bad'); return out; }
        if (f in g.wt) g.index[f] = g.wt[f]; else delete g.index[f];
      }
      return out; // git add 成功時不會印任何東西
    }
    case 'restore': case 'checkout': {
      if (sub === 'checkout' && dashdash < 0) { P('這個模擬只支援 git checkout -- <檔名>（放棄修改），沒有分支可以切換', 'warn'); return out; }
      const targets = sub === 'checkout' ? paths : pos;
      if (!targets || !targets.length) { P(`fatal: you must specify path(s) to restore`, 'bad'); return out; }
      for (const f of targets.includes('.') ? files : targets) {
        if (!(f in g.wt) && !(f in g.index)) { P(`error: pathspec '${f}' did not match any file(s) known to git`, 'bad'); return out; }
        if (flags.includes('--staged') || flags.includes('-S')) g.index[f] = H.files[f]; else g.wt[f] = g.index[f];
      }
      return out;
    }
    case 'commit': {
      const k = opts.findIndex((x) => x === '-m' || x === '--message' || /^-[a-z]*m$/.test(x));
      if (flags.some((x) => x === '-a' || x === '--all' || /^-a[a-z]*$/.test(x))) for (const f of Object.keys(g.index)) if (f in g.wt) g.index[f] = g.wt[f];
      const msg = k >= 0 ? opts[k + 1] : null;
      const staged = statFiles(H.files, g.index);
      if (!staged.length) {
        const unstaged = statFiles(g.index, g.wt);
        P('On branch main');
        if (!unstaged.length) { P('nothing to commit, working tree clean'); return out; }
        P('Changes not staged for commit:');
        for (const r of unstaged) P(`\tmodified:   ${r.f}`, 'git bad');
        P('');
        P('no changes added to commit (use "git add" and/or "git commit -a")');
        return out;
      }
      if (msg == null) { P('hint: Waiting for your editor to close the file...', 'dim'); P('（這個模擬不會開編輯器：請用 git commit -m "說明"）', 'hint'); P('Aborting commit due to empty commit message.', 'bad'); return out; }
      if (!String(msg).trim()) { P('Aborting commit due to empty commit message.', 'bad'); return out; }
      const c = makeCommit(g, { ...USER, t: state.clock, msg: String(msg).trim(), files: { ...g.index } });
      P(`[main ${short(c.id)}] ${c.msg.split('\n')[0]}`);
      statLines(staged).slice(-1).forEach((l) => P(l.t));
      return out;
    }
    case 'log': {
      const one = flags.includes('--oneline'), patch = flags.includes('-p') || flags.includes('--patch'), stat = flags.includes('--stat');
      let n = Infinity;
      const nk = opts.findIndex((x) => x === '-n');
      if (nk >= 0) n = +opts[nk + 1] || Infinity;
      for (const x of flags) if (/^-\d+$/.test(x)) n = +x.slice(1);
      const start = revArgs.filter((x) => !(nk >= 0 && x === opts[nk + 1]));
      let tip = H;
      if (start.length) { tip = rev(g, start[0]); if (!tip) return badRev(start[0]); }
      let list = g.commits.slice(0, g.commits.indexOf(tip) + 1).reverse();
      if (fileArgs.length) list = list.filter((c) => { const p = parentOf(g, c); return fileArgs.some((f) => (p ? p.files[f] : undefined) !== c.files[f]); });
      for (const c of list.slice(0, n)) {
        logEntry(g, c, P, one);
        const p = parentOf(g, c);
        if (stat) { statLines(statFiles(p ? p.files : {}, c.files, fileArgs.length ? fileArgs : null)).forEach((l) => P(l.t)); P(''); }
        if (patch) { out.push(...diffFiles(p ? p.files : {}, c.files, fileArgs.length ? fileArgs : null)); P(''); }
      }
      return out;
    }
    case 'show': {
      const r = revArgs[0] || 'HEAD';
      const m = r.match(/^([^:]*):(.+)$/);
      if (m) {
        const c = rev(g, m[1] || 'HEAD');
        if (!c) return badRev(m[1]);
        if (c.files[m[2]] == null) { P(`fatal: path '${m[2]}' does not exist in '${m[1] || 'HEAD'}'`, 'bad'); return out; }
        lines(c.files[m[2]]).forEach((l) => P(l));
        return out;
      }
      const c = rev(g, r);
      if (!c) return badRev(r);
      logEntry(g, c, P, false);
      const p = parentOf(g, c);
      if (flags.includes('--stat')) statLines(statFiles(p ? p.files : {}, c.files)).forEach((l) => P(l.t));
      else out.push(...diffFiles(p ? p.files : {}, c.files, fileArgs.length ? fileArgs : null));
      return out;
    }
    case 'diff': {
      const only = fileArgs.length ? fileArgs : null, stat = flags.includes('--stat');
      let from, to;
      if (flags.includes('--staged') || flags.includes('--cached')) { from = H.files; to = g.index; }
      else if (revArgs.length === 0) { from = g.index; to = g.wt; }
      else {
        const rs = revArgs.length === 1 && revArgs[0].includes('..') ? revArgs[0].split('..') : revArgs;
        const a = rev(g, rs[0]);
        if (!a) return badRev(rs[0]);
        from = a.files;
        if (rs.length > 1) { const b = rev(g, rs[1] || 'HEAD'); if (!b) return badRev(rs[1]); to = b.files; } else to = g.wt;
      }
      if (stat) statLines(statFiles(from, to, only)).forEach((l) => out.push(l));
      else out.push(...diffFiles(from, to, only));
      return out;
    }
    case 'blame': {
      const f = fileArgs[0] || pos[0];
      if (!f) { P('usage: git blame <file>', 'bad'); return out; }
      if (H.files[f] == null) { P(`fatal: no such path '${f}' in HEAD`, 'bad'); return out; }
      // 從最舊的提交往後走：沒變的行沿用原本的來源，新增的行算在這一筆提交
      let origin = [], prev = [];
      for (const c of g.commits) {
        const now = lines(c.files[f]);
        if (c.files[f] == null) { origin = []; prev = []; continue; }
        const next = new Array(now.length);
        for (const x of lineDiff(prev, now)) if (x.op === ' ') next[x.b] = origin[x.a]; else if (x.op === '+') next[x.b] = c;
        origin = next; prev = now;
      }
      const w = Math.max(...g.commits.map((c) => c.author.length));
      prev.forEach((l, k) => { const c = origin[k]; P(`${c.id.slice(0, 8)} (${c.author.padEnd(w)} ${when(c.t).iso} ${String(k + 1).padStart(3)}) ${l}`, c === H ? 'git ok' : 'git'); });
      return out;
    }
    default:
      P(`git: '${sub}' is not a git command. See 'git --help'.`, 'bad');
      return out;
  }
}

/** HEAD 的檔案和每台設備現在的設定一樣嗎？（關卡用）：回傳 true 或說明 */
export function repoInSync(state, d) {
  const g = d.git, H = head(g);
  for (const x of g.devices) {
    const dev = state.devices[x.id];
    if (dev && H.files[x.file] !== cfgText(state, dev)) return `Git 裡的 ${x.file}（最新的提交 ${short(H.id)}）和 ${dev.name} 現在的設定不一樣`;
  }
  if (statFiles(H.files, g.index).length || statFiles(g.index, g.wt).length) return '工作目錄還有沒提交的修改（git status 不是 clean）';
  return true;
}
export const repoHead = head;
