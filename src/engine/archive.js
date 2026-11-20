// 設定封存 (archive) 與設定變更紀錄 (archive log config)
//
// archive
//  path flash:archive          封存檔放在哪裡（檔名後面自動加 -1、-2…）
//  maximum 14                  最多留幾份，多了刪掉最舊的
//  write-memory                每次 write memory 自動封存一份
//  log config
//   logging enable             記下每一行設定指令：誰、從哪條線、打了什麼
//   notify syslog contenttype plaintext   同時送到 syslog（%PARSER-5-CFGLOG_LOGGEDCMD）
//   hidekeys                   密碼、金鑰不要記原文
// archive config                     手動封存
// show archive                       有哪些封存檔
// show archive config differences [A [B]]   兩份設定差在哪（沒寫就是 startup-config 對 running-config）
// show archive log config all        設定變更紀錄
// configure replace flash:archive-3  整份換回那一份（rollback）
//
// 設定：d.archive = { path, max, wm, period, log: { on, size, notify, hide } }
// 封存檔：d.flash.files[名稱] = { kind: 'config', lines, snap（設定快照，rollback 用）, arch: 編號, size, md5, t }
// 紀錄：state.dyn.cfglog[設備] = [{ n, sess, user, line, cmd, t }]
import { configFile, ensureFlash, flashPath, flashFree } from './files.js';

export const ARCH_MAX_DEFAULT = 10;
export const CFGLOG_SIZE_DEFAULT = 100;

export const archiveBase = (d) => (d.archive && d.archive.path ? flashPath(d.archive.path) : null);
/** 這台的封存檔，舊的在前 */
export function archiveFiles(d) {
  const base = archiveBase(d);
  return Object.entries((d.flash && d.flash.files) || {}).filter(([, f]) => f.arch != null && (!base || true)).map(([name, f]) => ({ name, f, n: f.arch })).sort((a, b) => a.n - b.n);
}
export const nextArchiveName = (d) => `${archiveBase(d)}-${(d.flash && d.flash.archN ? d.flash.archN : 0) + 1}`;

/** 封存一份目前的 running-config。回傳 { name } 或 { err } */
export function archiveNow(state, d, lines, snap) {
  const base = archiveBase(d);
  if (!base) return { err: '%Archive path is not configured（先在 archive 底下設定 path flash:<名稱>）' };
  ensureFlash(d);
  if (!d.flash) return { err: '% 這台設備沒有 flash 檔案系統' };
  const file = { ...configFile(lines, state.clock), snap };
  if (file.size > flashFree(d)) return { err: '%Error: Not enough space on device to archive the configuration' };
  const n = (d.flash.archN || 0) + 1;
  d.flash.archN = n;
  const name = `${base}-${n}`;
  d.flash.files[name] = { ...file, arch: n };
  const max = +(d.archive && d.archive.max) || ARCH_MAX_DEFAULT;
  const list = archiveFiles(d);
  while (list.length > max) delete d.flash.files[list.shift().name]; // 多了就刪掉最舊的
  return { name };
}

const IGNORE = /^(!.*|end|Building configuration\.\.\.|Current configuration : \d+ bytes|version .*|)$/;
/** 把設定分成「最上層的一行 + 底下縮排的子設定」 */
function sections(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (IGNORE.test(l.trim())) { if (!/^\s/.test(l)) cur = null; continue; }
    if (/^\s/.test(l) && cur) cur.kids.push(l.trim());
    else { cur = { head: l.trim(), kids: [] }; out.push(cur); }
  }
  return out;
}
/**
 * Contextual Config Diffs：+ 是只在第二份（新的）裡的，- 是只在第一份（舊的）裡的。
 * 兩份都有的區塊（例如同一個 interface）只列出裡面不一樣的行，前面帶著區塊的名稱當作位置
 */
export function cfgDiff(a, b) {
  const A = sections(a), B = sections(b);
  const keyOf = (s) => s.head;
  const mapA = new Map(A.map((s) => [keyOf(s), s])), mapB = new Map(B.map((s) => [keyOf(s), s]));
  const plus = [], minus = [];
  for (const s of B) {
    const o = mapA.get(keyOf(s));
    if (!o) { plus.push('+' + s.head, ...s.kids.map((k) => ' +' + k)); continue; }
    const add = s.kids.filter((k) => !o.kids.includes(k));
    if (add.length) plus.push(s.head, ...add.map((k) => ' +' + k));
  }
  for (const s of A) {
    const o = mapB.get(keyOf(s));
    if (!o) { minus.push('-' + s.head, ...s.kids.map((k) => ' -' + k)); continue; }
    const del = s.kids.filter((k) => !o.kids.includes(k));
    if (del.length) minus.push(s.head, ...del.map((k) => ' -' + k));
  }
  return [...plus, ...minus];
}

const SECRET = /\b(password|secret|key|pre-shared-key|community)(\s+\d)?\s+\S+/i;
/** 記下一行設定指令（archive log config 有開 logging enable 才記） */
export function cfgLog(state, d, e, logEvent) {
  const L = d.archive && d.archive.log;
  if (!L || !L.on || !state.dyn) return;
  const cmd = L.hide ? e.cmd.replace(SECRET, (m, k, n) => `${k}${n || ''} *****`) : e.cmd;
  const all = (state.dyn.cfglog ||= {});
  const list = (all[d.id] ||= []);
  const n = (state.dyn.cfglogN = (state.dyn.cfglogN || 0) + 1);
  list.push({ n, sess: e.sess, user: e.user, line: e.line, cmd, t: state.clock });
  const size = +L.size || CFGLOG_SIZE_DEFAULT;
  while (list.length > size) list.shift();
  if (L.notify) logEvent(state, d, 5, 'PARSER-5-CFGLOG_LOGGEDCMD', `User:${e.user}  logged command:${cmd.trim()}`);
}

/** archive 區塊的 running-config 寫法 */
export function archiveLines(d) {
  const a = d.archive;
  if (!a) return [];
  const o = ['archive'];
  const L = a.log;
  if (L && (L.on || L.size || L.notify || L.hide)) {
    o.push(' log config');
    if (L.on) o.push('  logging enable');
    if (+L.size && +L.size !== CFGLOG_SIZE_DEFAULT) o.push(`  logging size ${+L.size}`);
    if (L.notify) o.push('  notify syslog contenttype plaintext');
    if (L.hide) o.push('  hidekeys');
  }
  if (a.path) o.push(` path ${a.path}`);
  if (+a.max && +a.max !== ARCH_MAX_DEFAULT) o.push(` maximum ${+a.max}`);
  if (a.wm) o.push(' write-memory');
  if (+a.period) o.push(` time-period ${+a.period}`);
  return [...o, '!'];
}
