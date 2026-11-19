// 迷你 YAML 解析器：Ansible playbook 用得到的部分（區塊 mapping / sequence、引號字串、flow [ ] { }、| 與 > 區塊字串、註解）。
// 錯誤訊息仿照 PyYAML：說明哪一行哪一欄、出了什麼問題，並附上那一行與 ^ 標記。

export class YamlError extends Error {
  constructor(msg, line, col, src) { super(msg); this.line = line; this.col = col; this.src = src; }
}

/** 去掉行尾的註解（# 前面要是空白，或在行首；引號裡的 # 不算） */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && !(q === '"' && s[i - 1] === '\\')) q = null; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,-]/.test(s[i - 1]))) { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, '');
  }
  return s.replace(/\s+$/, '');
}

/** 第一個不在引號 / 括號裡、後面接空白或行尾的冒號 */
function keyColon(s) {
  let q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && i === 0) { q = c; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && (i + 1 === s.length || s[i + 1] === ' ')) return i;
  }
  return -1;
}

export function parseYaml(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').split('\n');
  const L = [];
  for (let n = 0; n < raw.length; n++) {
    const r = raw[n];
    const tab = r.match(/^( *)\t/);
    if (tab) throw new YamlError("found character '\\t' that cannot start any token（YAML 的縮排只能用空白，不能用 Tab）", n + 1, tab[1].length + 1, r);
    if (/^(---|\.\.\.)\s*$/.test(r)) continue;
    const t = stripComment(r);
    if (!t.trim()) continue;
    const indent = t.match(/^ */)[0].length;
    L.push({ n: n + 1, indent, text: t.slice(indent), raw: r });
  }
  if (!L.length) return null;
  let i = 0;
  const fail = (msg, l, col) => { throw new YamlError(msg, l ? l.n : raw.length, col ?? (l ? l.indent + 1 : 1), l ? l.raw : ''); };
  const isSeq = (l) => l.text === '-' || l.text.startsWith('- ');

  function scalar(s, l) {
    s = s.trim();
    if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
    if (s[0] === '"') {
      const m = s.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (!m) fail(s.indexOf('"', 1) < 0 ? 'found unexpected end of stream while scanning a quoted scalar（雙引號沒有結束）' : "did not find expected key（引號結束之後還有其他字）", l, l.indent + 1 + l.text.indexOf('"'));
      return m[1].replace(/\\(["\\/nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c));
    }
    if (s[0] === "'") {
      const m = s.match(/^'((?:[^']|'')*)'$/);
      if (!m) fail("found unexpected end of stream while scanning a quoted scalar（單引號沒有結束）", l, l.indent + 1 + l.text.indexOf("'"));
      return m[1].replace(/''/g, "'");
    }
    if (s.startsWith('{{')) {
      const e = new YamlError('template expression brackets（{{ }}）放在值的開頭時一定要加引號', l.n, l.indent + 1 + l.text.indexOf('{{'), l.raw);
      e.quoteHint = true;
      throw e;
    }
    if (s[0] === '[' || s[0] === '{') return flow(s, l);
    if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(s)) return true;
    if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(s)) return false;
    if (/^[-+]?\d+$/.test(s) && !/^0\d/.test(s)) return +s;
    if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return +s;
    if (keyColon(s) >= 0) fail('mapping values are not allowed here（同一行出現了第二個「: 」。值裡面有冒號加空白時要加引號）', l, l.indent + 1 + l.text.indexOf(s) + keyColon(s));
    return s;
  }
  /** flow 集合：[a, b, {k: v}] 與 {k: v, k2: [1, 2]} */
  function flow(s, l) {
    let p = 0;
    const ws = () => { while (s[p] === ' ') p++; };
    function item() {
      ws();
      if (s[p] === '[') {
        p++; const out = [];
        ws();
        if (s[p] === ']') { p++; return out; }
        for (;;) { out.push(item()); ws(); if (s[p] === ',') { p++; continue; } if (s[p] === ']') { p++; return out; } fail("did not find expected ',' or ']'", l, l.indent + 1 + p); }
      }
      if (s[p] === '{') {
        p++; const out = {};
        ws();
        if (s[p] === '}') { p++; return out; }
        for (;;) {
          ws();
          const k = token(true);
          ws();
          if (s[p] !== ':') fail("did not find expected ':' in flow mapping", l, l.indent + 1 + p);
          p++;
          out[k] = item();
          ws();
          if (s[p] === ',') { p++; continue; }
          if (s[p] === '}') { p++; return out; }
          fail("did not find expected ',' or '}'", l, l.indent + 1 + p);
        }
      }
      return token(false);
    }
    function token(isKey) {
      ws();
      if (s[p] === '"' || s[p] === "'") {
        const q = s[p]; let j = p + 1;
        while (j < s.length && !(s[j] === q && s[j - 1] !== '\\')) j++;
        const v = s.slice(p + 1, j); p = j + 1;
        return v;
      }
      let j = p;
      while (j < s.length && !(isKey ? /[:,}\]]/ : /[,}\]]/).test(s[j])) j++;
      const v = s.slice(p, j).trim(); p = j;
      return isKey ? v : scalar(v, l);
    }
    const v = item();
    ws();
    if (p < s.length) fail('flow 集合結束之後還有其他字', l, l.indent + 1 + p);
    return v;
  }
  /** | 與 > 的區塊字串 */
  function block(style, ind) {
    const lines = [];
    let base = null;
    while (i < L.length && L[i].indent > ind) {
      const l = L[i];
      if (base == null) base = l.indent;
      lines.push(l.raw.slice(base));
      i++;
    }
    const keep = style[0] === '|' ? lines.join('\n') : lines.join(' ');
    return style.includes('-') ? keep : keep + '\n';
  }
  function node(ind) {
    if (i >= L.length) return null;
    const l = L[i];
    if (l.indent < ind) return null;
    if (isSeq(l)) return seq(l.indent);
    if (keyColon(l.text) >= 0) return map(l.indent);
    i++;
    const v = scalar(l.text, l);
    if (i < L.length && L[i].indent > l.indent) fail('mapping values are not allowed here（下一行縮排更深，可是這一行不是「名稱: 」）', L[i]);
    return v;
  }
  function seq(ind) {
    const out = [];
    while (i < L.length && L[i].indent === ind && isSeq(L[i])) {
      const l = L[i];
      const rest = l.text === '-' ? '' : l.text.slice(2);
      const off = l.text.length - l.text.slice(1).trimStart().length;
      if (!rest.trim()) {
        i++;
        out.push(i < L.length && L[i].indent > ind ? node(ind + 1) : null);
      } else if (rest.trimStart().startsWith('- ') || keyColon(rest.trimStart()) >= 0) {
        // 「- name: xxx」：同一行就開始一個 mapping，後面的鍵對齊在 name 那一欄
        L[i] = { ...l, indent: ind + off, text: rest.trimStart() };
        out.push(node(ind + off));
      } else {
        i++;
        if (/^[|>][-+]?$/.test(rest.trim())) out.push(block(rest.trim(), ind));
        else {
          out.push(scalar(rest, { ...l, indent: ind + off, text: rest.trimStart() }));
          if (i < L.length && L[i].indent > ind && !isSeq(L[i])) fail('did not find expected - indicator（清單的項目下面多了一行縮排，可能是少了「- 」或冒號）', L[i]);
        }
      }
    }
    if (i < L.length && L[i].indent > ind) fail('did not find expected - indicator（縮排對不齊）', L[i]);
    return out;
  }
  function map(ind) {
    const out = {};
    while (i < L.length && L[i].indent === ind) {
      const l = L[i];
      if (isSeq(l)) fail("did not find expected key（這裡是 mapping，不能突然接清單的「- 」；檢查上一行的縮排）", l);
      const c = keyColon(l.text);
      if (c < 0) fail("could not find expected ':'（這一行應該是「名稱: 值」）", l, l.indent + l.text.length + 1);
      let k = l.text.slice(0, c).trim();
      if (/^["'].*["']$/.test(k)) k = k.slice(1, -1);
      const v = l.text.slice(c + 1).trim();
      i++;
      if (!v) {
        if (i < L.length && L[i].indent > ind) out[k] = node(ind + 1);
        else if (i < L.length && L[i].indent === ind && isSeq(L[i])) out[k] = seq(ind); // 清單可以和鍵對齊
        else out[k] = null;
      } else if (/^[|>][-+]?$/.test(v)) out[k] = block(v, ind);
      else {
        out[k] = scalar(v, { ...l, text: l.text });
        if (i < L.length && L[i].indent > ind) fail('mapping values are not allowed here（這個鍵已經有值了，下一行卻縮排得更深）', L[i]);
      }
    }
    if (i < L.length && L[i].indent > ind) fail('did not find expected key（縮排對不齊）', L[i]);
    return out;
  }
  const top = node(0);
  if (i < L.length) fail('did not find expected <document start>（縮排對不齊：這一行比上面的層級還要外面）', L[i]);
  return top;
}

/** PyYAML / Ansible 的錯誤訊息格式 */
export function yamlErrorText(e, file) {
  if (!(e instanceof YamlError)) return [String(e.message || e)];
  const caret = ' '.repeat(Math.max(0, e.col - 1)) + '^ here';
  const out = ['ERROR! Syntax Error while loading YAML.', `  ${e.message}`, '', `The error appears to be in '/home/netops/${file}': line ${e.line}, column ${e.col}, but may`, 'be elsewhere in the file depending on the exact syntax problem.', '', 'The offending line appears to be:', '', e.src, caret];
  if (e.quoteHint) out.push('We could be wrong, but this one looks like it might be an issue with', 'missing quotes. Always quote template expression brackets when they', 'start a value. For instance:', '', '    with_items:', '      - {{ foo }}', '', 'Should be written as:', '', '    with_items:', '      - "{{ foo }}"');
  return out;
}
