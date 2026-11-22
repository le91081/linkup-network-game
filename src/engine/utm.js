// FortiGate 的安全設定檔（NGFW）：FortiGuard 網頁過濾與 SSL 檢查
//
// 網頁過濾設定檔：d.wf = { 名稱: { block: [類別編號], comment } }
// 政策：p.utm（set utm-status enable）、p.wf（webfilter-profile）、p.ssl（ssl-ssh-profile：no-inspection / certificate-inspection / deep-inspection）
// - HTTP：看得到網址，依 FortiGuard 類別封鎖（回一頁 403 的封鎖頁面）
// - HTTPS：no-inspection 什麼都看不到；certificate-inspection 看 SNI / 憑證上的名稱就能依類別封鎖；
//   deep-inspection 解密整個連線，但 FortiGate 用自己的 CA (Fortinet_CA_SSL) 重新簽發憑證 → 電腦沒裝這張 CA 就跳憑證錯誤
// 網際網路上的主機用 inet.hosts[].cat 標示類別（沒有的算 Unrated）

export const FG_CATS = {
  11: 'Gambling', 14: 'Pornography', 20: 'Games', 23: 'Web-based Email', 24: 'File Sharing and Storage', 25: 'Streaming Media and Download',
  26: 'Malicious Websites', 31: 'Finance and Banking', 36: 'News and Media', 37: 'Social Networking', 41: 'Search Engines and Portals', 42: 'Shopping',
  49: 'Business', 52: 'Information Technology', 59: 'Proxy Avoidance', 61: 'Phishing', 72: 'Peer-to-peer File Sharing', 86: 'Spam URLs', 0: 'Unrated',
};
export const CAT_ZH = {
  11: '線上博弈', 14: '色情', 20: '遊戲', 23: '網頁郵件', 24: '檔案分享與儲存', 25: '串流媒體與下載', 26: '惡意網站', 31: '金融', 36: '新聞', 37: '社群網路',
  41: '搜尋引擎與入口網站', 42: '購物', 49: '商業', 52: '資訊科技', 59: '代理伺服器規避', 61: '網路釣魚', 72: '點對點檔案分享', 86: '垃圾郵件網址', 0: '未分類',
};
export const SSL_PROFILES = ['no-inspection', 'certificate-inspection', 'deep-inspection'];
export const FG_SSL_CA = 'Fortinet_CA_SSL';
const KNOWN = { 'www.example.com': 52, 'example.com': 52, 'dns.google': 41 };
export const catName = (c) => `${FG_CATS[c] || 'Unrated'}（${CAT_ZH[c] || '未分類'}）`;

/** 網際網路上這個主機（名稱或 IP）的 FortiGuard 類別 */
export function rate(state, host, ip) {
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'internet') continue;
    const h = d.inet.hosts.find((x) => (host && (x.name === host || x.fqdn === host)) || (ip != null && ipOf(x.ip) === ip));
    if (h && h.cat != null) return +h.cat;
    if (host && KNOWN[host] != null) return KNOWN[host];
    if (h && KNOWN[h.name] != null) return KNOWN[h.name];
  }
  return 0;
}
const ipOf = (s) => { const p = String(s).split('.').map(Number); return p.length === 4 && p.every((x) => x >= 0 && x <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null; };
/** IP 對應回網際網路上的名稱（用憑證 / SNI 時要用到） */
function nameOf(state, ip) {
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'internet') continue;
    const n = Object.entries(d.inet.dns || {}).find(([, v]) => ipOf(v) === ip);
    if (n) return n[0];
    const h = d.inet.hosts.find((x) => ipOf(x.ip) === ip);
    if (h) return h.fqdn || h.name;
  }
  return null;
}

/**
 * 政策 #n（p）放行之後，安全設定檔要不要擋：回傳 { drop, note, deep, block }
 * pkt.host 是網址上的主機名稱（HTTP 的 Host、HTTPS 的 SNI）
 */
export function utmCheck(state, dev, p, n, pkt) {
  if (!p || !p.utm || pkt.reply || pkt.proto !== 'tcp' || pkt.ack) return {};
  const web = pkt.dport === 80 || pkt.dport === 443;
  if (!web) return {};
  const https = pkt.dport === 443, ssl = p.ssl || 'no-inspection';
  const deep = https && ssl === 'deep-inspection';
  if (!p.wf) return deep ? { deep: true } : {};
  const prof = (dev.wf || {})[p.wf];
  if (!prof) return {};
  if (https && ssl === 'no-inspection') return { note: `政策 #${n} 的 SSL 檢查是 no-inspection：HTTPS 是加密的，FortiGate 看不到網址，網頁過濾「${p.wf}」沒有作用（至少要 certificate-inspection）` };
  const host = pkt.host || nameOf(state, pkt.dst);
  const cat = rate(state, host, pkt.dst);
  if ((prof.block || []).map(Number).includes(cat)) {
    const what = host || `${pkt.dst >>> 24}.${(pkt.dst >>> 16) & 255}.${(pkt.dst >>> 8) & 255}.${pkt.dst & 255}`;
    const how = https ? (deep ? '（deep-inspection：解密後看到完整的網址）' : '（certificate-inspection：看 SNI / 憑證上的名稱）') : '';
    return { drop: `FortiGuard 網頁過濾：${what} 屬於「${catName(cat)}」，被政策 #${n} 的設定檔「${p.wf}」封鎖${how}`, block: { cat, host: what, http: !https }, deep };
  }
  return { deep, note: `FortiGuard 網頁過濾：${host || '這個網站'} 屬於「${catName(cat)}」，允許` };
}

/** deep-inspection：FortiGate 用自己的 CA 重新簽發的憑證 */
export const resignCert = (host, from, to) => ({ cn: host, san: [host], issuer: FG_SSL_CA, from, to, resigned: true });

// ── FortiOS 的 config webfilter profile（兩層的 config：ftgd-wf → filters，整段收下來再套用） ──
export function wfConfigLines(d) {
  const o = [];
  const all = Object.entries(d.wf || {});
  if (!all.length) return o;
  o.push('config webfilter profile');
  for (const [n, p] of all) {
    o.push(`    edit "${n}"`);
    if (p.comment) o.push(`        set comment "${p.comment}"`);
    o.push('        config ftgd-wf', '            config filters');
    (p.block || []).forEach((c, k) => o.push(`                edit ${k + 1}`, `                    set category ${c}`, '                    set action block', '                next'));
    o.push('            end', '        end', '    next');
  }
  o.push('end');
  return o;
}

/** 套用 config webfilter profile 的內容（edit / delete / next；filters 裡的 category 與 action）。回傳錯誤訊息或 null */
export function applyWfCli(d, lines) {
  const wf = JSON.parse(JSON.stringify(d.wf || {}));
  let cur = null, filt = null, inFilters = false;
  const tok = (l) => (l.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, ''));
  for (const l of lines) {
    const t = tok(l), w = (t[0] || '').toLowerCase();
    if (w === 'edit' && !inFilters) { cur = (wf[t[1]] ||= { block: [] }); continue; }
    if (w === 'delete' && !inFilters) { delete wf[t[1]]; continue; }
    if (!cur) return `command parse error before '${t[0]}'`;
    if (w === 'config') { if ((t[1] || '').toLowerCase() === 'filters') inFilters = true; continue; }
    if (w === 'end') { if (inFilters) { inFilters = false; if (filt) commit(); } continue; }
    if (inFilters) {
      if (w === 'edit') { if (filt) commit(); filt = { k: t[1], cat: null, act: 'block' }; continue; }
      if (w === 'next') { if (filt) commit(); continue; }
      if (w === 'delete') continue;
      if (w === 'set' && t[1] === 'category') { if (!(+t[2] in FG_CATS) || !/^\d+$/.test(t[2])) return `value parse error before '${t[2]}'（這個模擬認得的類別：${Object.keys(FG_CATS).filter((x) => x !== '0').join('、')}）`; filt.cat = +t[2]; continue; }
      if (w === 'set' && t[1] === 'action') { if (!['block', 'monitor', 'warning', 'authenticate'].includes(t[2])) return `value parse error before '${t[2]}'`; filt.act = t[2]; continue; }
      continue;
    }
    if (w === 'set' && t[1] === 'comment') { cur.comment = t.slice(2).join(' '); continue; }
    if (w === 'next') { cur = null; continue; }
  }
  function commit() { if (filt && filt.cat != null) { cur.block = cur.block.filter((c) => c !== filt.cat); if (filt.act === 'block') cur.block.push(filt.cat); } filt = null; }
  if (Object.keys(wf).length) d.wf = wf; else delete d.wf;
  return null;
}
