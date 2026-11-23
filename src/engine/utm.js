// FortiGate 的安全設定檔（NGFW）：FortiGuard 網頁過濾、SSL 檢查、應用程式控管、IPS
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

// ── 應用程式控管（application list）：依特徵辨識應用程式，封鎖整個類別 ──
// d.appList = { 名稱: { block: [類別編號] } }；政策 p.app
export const APP_CATS = { 2: 'P2P', 5: 'Video/Audio', 6: 'Proxy', 8: 'Game', 23: 'Social.Media' };
export const APP_CAT_ZH = { 2: '點對點下載', 5: '影音串流', 6: '代理 / 匿名網路', 8: '線上遊戲', 23: '社群媒體' };
// 這個模擬認得的應用程式：用埠號或網址上的主機名稱辨識（真的 FortiGate 看封包內容的特徵）
export const APPS = [
  { name: 'BitTorrent', cat: 2, port: [6881, 6889] },
  { name: 'Tor', cat: 6, port: [9001, 9001] },
  { name: 'Tor', cat: 6, port: [9030, 9030] },
  { name: 'Facebook', cat: 23, host: /(^|\.)facebook\./ },
  { name: 'YouTube', cat: 5, host: /(^|\.)youtube\./ },
  { name: 'Steam', cat: 8, port: [27015, 27015] },
];
/** 這個連線是哪個應用程式（認不出來就是 null） */
export function appOf(pkt) {
  return APPS.find((a) => (a.port && (pkt.proto === 'tcp' || pkt.proto === 'udp') && pkt.dport >= a.port[0] && pkt.dport <= a.port[1]) || (a.host && pkt.host && a.host.test(pkt.host))) || null;
}

// ── IPS：特徵比對；感測器決定封鎖哪些嚴重程度 ──
// d.ips = { 名稱: { sev: ['high', 'critical'] } }；政策 p.ips
export const IPS_SEV = ['info', 'low', 'medium', 'high', 'critical'];
export const ATTACKS = {
  log4j: { sig: 'Apache.Log4j.Error.Log.Remote.Code.Execution', sev: 'critical', cve: 'CVE-2021-44228' },
  sqli: { sig: 'HTTP.URI.SQL.Injection', sev: 'high', cve: '' },
  shellshock: { sig: 'Bash.Function.Definitions.Remote.Code.Execution', sev: 'critical', cve: 'CVE-2014-6271' },
};

/** 應用程式控管與 IPS（在網頁過濾之後檢查）：回傳 { drop, note } */
export function appIpsCheck(dev, p, n, pkt) {
  if (!p || !p.utm || pkt.reply || pkt.ack) return {};
  if (pkt.attack && p.ips) {
    const a = ATTACKS[pkt.attack], s = (dev.ips || {})[p.ips];
    if (a && s && (s.sev || []).includes(a.sev)) return { drop: `IPS：偵測到攻擊 ${a.sig}${a.cve ? `（${a.cve}）` : ''}，嚴重程度 ${a.sev}，被政策 #${n} 的 IPS 感測器「${p.ips}」封鎖`, ips: a };
    if (a && s) return { note: `IPS：偵測到 ${a.sig}（${a.sev}），但感測器「${p.ips}」沒有封鎖這個嚴重程度，只記錄` };
  }
  if (p.app) {
    const app = appOf(pkt), l = (dev.appList || {})[p.app];
    if (app && l && (l.block || []).map(Number).includes(app.cat)) {
      if (app.host && pkt.dport === 443 && (p.ssl || 'no-inspection') === 'no-inspection') return { note: `應用程式控管：${app.name} 走 HTTPS，SSL 檢查是 no-inspection，辨識不出來` };
      return { drop: `應用程式控管：辨識出 ${app.name}（${APP_CATS[app.cat]}，${APP_CAT_ZH[app.cat]}），被政策 #${n} 的「${p.app}」封鎖`, app };
    }
  }
  return {};
}

// ── FortiOS：config application list / config ips sensor（兩層：entries） ──
export function appIpsConfigLines(d) {
  const o = [];
  const apps = Object.entries(d.appList || {}), ips = Object.entries(d.ips || {});
  if (apps.length) {
    o.push('config application list');
    for (const [n, l] of apps) {
      o.push(`    edit "${n}"`, '        config entries');
      if ((l.block || []).length) o.push('            edit 1', `                set category ${l.block.join(' ')}`, '                set action block', '            next');
      o.push('        end', '    next');
    }
    o.push('end');
  }
  if (ips.length) {
    o.push('config ips sensor');
    for (const [n, s] of ips) {
      o.push(`    edit "${n}"`, '        config entries');
      if ((s.sev || []).length) o.push('            edit 1', `                set severity ${s.sev.join(' ')}`, '                set action block', '            next');
      o.push('        end', '    next');
    }
    o.push('end');
  }
  return o;
}

/** 套用 config application list / ips sensor 的內容。kind：'app' | 'ips'。回傳錯誤訊息或 null */
export function applyAppIpsCli(d, kind, lines) {
  const key = kind === 'app' ? 'appList' : 'ips', field = kind === 'app' ? 'block' : 'sev';
  const all = JSON.parse(JSON.stringify(d[key] || {}));
  let cur = null, ent = null, inEnt = false;
  const tok = (l) => (l.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, ''));
  const commit = () => {
    if (!ent || !cur) return;
    if (ent.vals && ent.act === 'block') cur[field] = [...new Set([...(cur[field] || []), ...ent.vals])];
    if (ent.vals && ent.act !== 'block') cur[field] = (cur[field] || []).filter((x) => !ent.vals.includes(x));
    ent = null;
  };
  for (const l of lines) {
    const t = tok(l), w = (t[0] || '').toLowerCase();
    if (!inEnt && w === 'edit') { cur = (all[t[1]] ||= { [field]: [] }); continue; }
    if (!inEnt && w === 'delete') { delete all[t[1]]; continue; }
    if (!cur) return `command parse error before '${t[0]}'`;
    if (w === 'config') { if ((t[1] || '').toLowerCase() === 'entries') inEnt = true; continue; }
    if (w === 'end') { if (inEnt) { commit(); inEnt = false; } continue; }
    if (inEnt) {
      if (w === 'edit') { commit(); ent = { vals: null, act: 'block' }; continue; }
      if (w === 'next') { commit(); continue; }
      if (w === 'set' && kind === 'app' && t[1] === 'category') {
        const bad = t.slice(2).find((x) => !(x in APP_CATS));
        if (bad) return `value parse error before '${bad}'（這個模擬認得的應用程式類別：${Object.entries(APP_CATS).map(([k, v]) => `${k} ${v}`).join('、')}）`;
        ent.vals = t.slice(2).map(Number); continue;
      }
      if (w === 'set' && kind === 'ips' && t[1] === 'severity') {
        const bad = t.slice(2).find((x) => !IPS_SEV.includes(x));
        if (bad) return `value parse error before '${bad}'（severity：${IPS_SEV.join('、')}）`;
        ent.vals = t.slice(2); continue;
      }
      if (w === 'set' && t[1] === 'action') { if (!['block', 'pass', 'monitor', 'reset', 'default'].includes(t[2])) return `value parse error before '${t[2]}'`; ent.act = t[2] === 'reset' ? 'block' : t[2]; continue; }
      continue;
    }
    if (w === 'next') { cur = null; continue; }
  }
  if (Object.keys(all).length) d[key] = all; else delete d[key];
  return null;
}

// ── DNS 過濾（config dnsfilter profile）：DNS 查詢經過 FortiGate 時，依 FortiGuard 類別改回封鎖頁面的位址 ──
// d.dnsf = { 名稱: { block: [類別編號] } }；政策 p.dnsf（dnsfilter-profile）
// 不用解密：HTTPS 的網站也擋得住（查不到真正的位址）；可是電腦改用 DoH（DNS over HTTPS）或直接打 IP 就繞過了
export const DNS_BLOCK_IP = '208.91.112.55'; // FortiGuard 的封鎖頁面
export function dnsfVerdict(state, dev, p, n, name) {
  if (!p || !p.utm || !p.dnsf) return null;
  const prof = (dev.dnsf || {})[p.dnsf];
  if (!prof) return null;
  const cat = rate(state, name, null);
  if ((prof.block || []).map(Number).includes(cat)) return { block: true, cat, note: `FortiGate 的 DNS 過濾：${name} 屬於「${catName(cat)}」，政策 #${n} 的設定檔「${p.dnsf}」把答案換成封鎖頁面的位址 ${DNS_BLOCK_IP}` };
  return { block: false, cat, note: `FortiGate 的 DNS 過濾：${name} 屬於「${catName(cat)}」，允許` };
}

// ── 防毒（config antivirus profile）：下載的檔案比對病毒碼 ──
// d.av = { 名稱: { scan: ['http', 'ftp'] } }；政策 p.av（av-profile）；網際網路上的主機用 inet.hosts[].virus 標示放了什麼病毒
export function virusOf(state, host, ip) {
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'internet') continue;
    const h = d.inet.hosts.find((x) => (host && (x.name === host || x.fqdn === host)) || (ip != null && ipOf(x.ip) === ip));
    if (h && h.virus) return h.virus;
  }
  return null;
}
export function avCheck(state, dev, p, n, pkt) {
  if (!p || !p.utm || !p.av || pkt.reply || pkt.proto !== 'tcp' || pkt.ack) return {};
  const prof = (dev.av || {})[p.av];
  if (!prof || (pkt.dport !== 80 && pkt.dport !== 443)) return {};
  const v = virusOf(state, pkt.host || nameOf(state, pkt.dst), pkt.dst);
  if (!v) return {};
  if (pkt.dport === 443 && (p.ssl || 'no-inspection') !== 'deep-inspection') return { note: `FortiGate 防毒：HTTPS 下載是加密的，政策 #${n} 的 SSL 檢查是 ${p.ssl || 'no-inspection'}，防毒設定檔「${p.av}」看不到檔案內容（要 deep-inspection 才掃得到）` };
  if (!(prof.scan || []).includes('http')) return { note: `FortiGate 防毒：設定檔「${p.av}」沒有掃描 HTTP（config http → set av-scan block）` };
  return { drop: `FortiGate 防毒：下載的檔案裡有病毒「${v}」，被政策 #${n} 的設定檔「${p.av}」擋下（使用者看到一頁「High Security Alert」的替換訊息）` };
}

/** config dnsfilter profile / config antivirus profile 的設定檔 */
export function dnsfAvConfigLines(d) {
  const o = [];
  const dn = Object.entries(d.dnsf || {}), av = Object.entries(d.av || {});
  if (dn.length) {
    o.push('config dnsfilter profile');
    for (const [n, p] of dn) {
      o.push(`    edit "${n}"`, '        config ftgd-dns', '            config filters');
      (p.block || []).forEach((c, k) => o.push(`                edit ${k + 1}`, `                    set category ${c}`, '                    set action block', '                next'));
      o.push('            end', '        end', '    next');
    }
    o.push('end');
  }
  if (av.length) {
    o.push('config antivirus profile');
    for (const [n, p] of av) {
      o.push(`    edit "${n}"`);
      if ((p.scan || []).includes('http')) o.push('        config http', '            set av-scan block', '        end');
      if ((p.scan || []).includes('ftp')) o.push('        config ftp', '            set av-scan block', '        end');
      o.push('    next');
    }
    o.push('end');
  }
  return o;
}
/** 套用 config dnsfilter profile（kind 'dnsf'）或 config antivirus profile（kind 'av'）。回傳錯誤訊息或 null */
export function applyDnsfAvCli(d, kind, lines) {
  const key = kind === 'dnsf' ? 'dnsf' : 'av';
  const all = JSON.parse(JSON.stringify(d[key] || {}));
  let cur = null, filt = null, sub = null, depth = 0;
  const tok = (l) => (l.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, ''));
  const commit = () => { if (filt && filt.cat != null) { cur.block = cur.block.filter((c) => c !== filt.cat); if (filt.act === 'block') cur.block.push(filt.cat); } filt = null; };
  for (const l of lines) {
    const t = tok(l), w = (t[0] || '').toLowerCase();
    if (!depth && w === 'edit') { cur = (all[t[1]] ||= kind === 'dnsf' ? { block: [] } : { scan: [] }); continue; }
    if (!depth && w === 'delete') { delete all[t[1]]; continue; }
    if (!depth && w === 'next') { cur = null; continue; }
    if (!cur) return `command parse error before '${t[0]}'`;
    if (w === 'config') { depth++; sub = (t[1] || '').toLowerCase(); continue; }
    if (w === 'end') { if (filt) commit(); depth = Math.max(0, depth - 1); sub = depth ? sub : null; continue; }
    if (kind === 'dnsf' && sub === 'filters') {
      if (w === 'edit') { if (filt) commit(); filt = { cat: null, act: 'block' }; continue; }
      if (w === 'next') { commit(); continue; }
      if (w === 'set' && t[1] === 'category') { if (!/^\d+$/.test(t[2] || '') || !(+t[2] in FG_CATS)) return `value parse error before '${t[2]}'（這個模擬認得的類別：${Object.keys(FG_CATS).filter((x) => x !== '0').join('、')}）`; filt.cat = +t[2]; continue; }
      if (w === 'set' && t[1] === 'action') { if (!['block', 'monitor'].includes(t[2])) return `value parse error before '${t[2]}'`; filt.act = t[2]; continue; }
      continue;
    }
    if (kind === 'av' && (sub === 'http' || sub === 'ftp') && w === 'set' && t[1] === 'av-scan') {
      if (!['block', 'monitor', 'disable'].includes(t[2])) return `value parse error before '${t[2]}'`;
      cur.scan = (cur.scan || []).filter((x) => x !== sub); if (t[2] !== 'disable') cur.scan.push(sub);
      continue;
    }
  }
  if (Object.keys(all).length) d[key] = all; else delete d[key];
  return null;
}
