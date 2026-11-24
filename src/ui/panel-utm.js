// FortiGate 的安全設定檔：網頁過濾（FortiGuard 類別）、應用程式控管、IPS 感測器、DNS 過濾、防毒，與政策上的 SSL 檢查
import { h, button, toast } from './dom.js';
import { sel, toggle, field, note, cardHead, badge, del } from './form.js';
import { FG_CATS, CAT_ZH, SSL_PROFILES, APP_CATS, APP_CAT_ZH, IPS_SEV } from '../engine/utm.js';

const SSL_TEXT = {
  'no-inspection': 'no-inspection（不檢查：HTTPS 看不到網址）',
  'certificate-inspection': 'certificate-inspection（看 SNI / 憑證：可以依類別封鎖 HTTPS）',
  'deep-inspection': 'deep-inspection（解密：電腦要信任 Fortinet_CA_SSL）',
};
const SEV_ZH = { info: '資訊', low: '低', medium: '中', high: '高', critical: '嚴重' };

/** 政策卡片裡的「安全設定檔」欄位 */
export function policyUtmFields(ctx, p) {
  const { dev } = ctx;
  const opt = (obj) => [['', '（不使用）'], ...Object.keys(obj || {}).map((n) => [n, n])];
  const pick = (label, key, obj) => field(label, sel(ctx, () => p[key] || '', (v) => { if (v) p[key] = v; else delete p[key]; }, opt(obj), { rerender: true }));
  return h('div', { class: 'utm-fields' },
    toggle(ctx, () => !!p.utm, (v) => { if (v) { p.utm = true; p.ssl ||= 'no-inspection'; } else { for (const k of ['utm', 'ssl', 'wf', 'app', 'ips', 'dnsf', 'av']) delete p[k]; } }, '安全設定檔 (utm-status)', { rerender: true }),
    p.utm && pick('網頁過濾 (webfilter-profile)', 'wf', dev.wf),
    p.utm && pick('應用程式控管 (application-list)', 'app', dev.appList),
    p.utm && pick('IPS (ips-sensor)', 'ips', dev.ips),
    p.utm && pick('DNS 過濾 (dnsfilter-profile)', 'dnsf', dev.dnsf),
    p.utm && pick('防毒 (av-profile)', 'av', dev.av),
    p.utm && field('SSL 檢查 (ssl-ssh-profile)', sel(ctx, () => p.ssl || 'no-inspection', (v) => { p.ssl = v; }, SSL_PROFILES.map((x) => [x, SSL_TEXT[x]]), { rerender: true })),
    p.utm && p.wf && (p.ssl || 'no-inspection') === 'no-inspection' && note('warn', 'SSL 檢查是 no-inspection：HTTPS 的網站看不到網址，網頁過濾只對 HTTP 有效。'),
    p.utm && p.av && p.ssl !== 'deep-inspection' && note('muted', '防毒只掃得到沒加密的下載（HTTP、FTP）；HTTPS 的檔案要 deep-inspection 才掃得到。'),
    p.utm && p.ssl === 'deep-inspection' && note('muted', 'deep-inspection 會解密 HTTPS：電腦收到的是 FortiGate 用 Fortinet_CA_SSL 重新簽的憑證，沒有安裝這張 CA 的電腦會跳憑證錯誤。'));
}

/** 一種設定檔的卡片：名稱、勾選清單、刪除 */
function profileCards(ctx, body, { key, title, field: fk, items, used, unit, verb = '封鎖' }) {
  const { dev } = ctx;
  for (const [name, prof] of Object.entries(dev[key] || {})) {
    const list = prof[fk] || [];
    const c = h('div', { class: `card ${key}-prof` }, cardHead(`${title} · ${name}`, badge(list.length ? 'on' : 'off', `${verb} ${list.length} ${unit}`),
      del(() => { if ((dev.policies || []).some((p) => p[used] === name)) return toast(`「${name}」還被政策使用中`, 'bad'); delete dev[key][name]; if (!Object.keys(dev[key]).length) delete dev[key]; ctx.commit(true); }, `刪除 ${name}`)));
    c.append(h('div', { class: 'chips' }, items.map(([v, label, tip]) => toggle(ctx, () => list.map(String).includes(String(v)),
      (on) => { prof[fk] = on ? [...new Set([...list, v])] : list.filter((x) => String(x) !== String(v)); }, label, { title: tip, rerender: true }))));
    if (!(dev.policies || []).some((p) => p[used] === name)) c.append(note('warn', '還沒有任何政策使用它：到「政策」分頁啟用安全設定檔並選擇它。'));
    body.append(c);
  }
}
function addCard(ctx, body, { key, title, ph, make }) {
  const { dev } = ctx;
  const inp = h('input', { class: 'inp mono', placeholder: ph, spellcheck: 'false' });
  const add = () => {
    const n = inp.value.trim();
    if (!/^[\w.-]{1,35}$/.test(n)) return toast('名稱用英文、數字、底線、點或連字號（最多 35 個字）', 'bad');
    if ((dev[key] || {})[n]) return toast(`「${n}」已經存在`, 'bad');
    (dev[key] ||= {})[n] = make();
    ctx.commit(true);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  body.append(h('div', { class: 'card' }, cardHead(title), h('div', { class: 'addrow' }, inp, button('新增', { ic: 'plus', kind: 'primary', small: true, onclick: add }))));
}

/** 「安全設定檔」分頁 */
export function utmTab(ctx, body) {
  body.append(h('p', { class: 'tip', text: '安全設定檔掛在政策上才會作用：網頁過濾依 FortiGuard 的網站類別封鎖、應用程式控管依特徵辨識應用程式、IPS 比對攻擊特徵。HTTPS 要搭配 SSL 檢查（至少 certificate-inspection）才看得到是哪個網站。DNS 過濾在查名稱時就把網站換成封鎖頁面的位址，不用解密 HTTPS。' }));
  profileCards(ctx, body, { key: 'wf', title: '網頁過濾', field: 'block', used: 'wf', unit: '個類別', items: Object.keys(FG_CATS).filter((k) => k !== '0').map((k) => [+k, `${CAT_ZH[k]}（${k}）`, FG_CATS[k]]) });
  addCard(ctx, body, { key: 'wf', title: '新增網頁過濾設定檔', ph: '設定檔名稱，例如 corp-wf', make: () => ({ block: [] }) });
  profileCards(ctx, body, { key: 'appList', title: '應用程式控管', field: 'block', used: 'app', unit: '個類別', items: Object.keys(APP_CATS).map((k) => [+k, `${APP_CAT_ZH[k]}（${APP_CATS[k]}）`, `類別 ${k}`]) });
  addCard(ctx, body, { key: 'appList', title: '新增應用程式控管清單', ph: '清單名稱，例如 corp-app', make: () => ({ block: [] }) });
  profileCards(ctx, body, { key: 'ips', title: 'IPS 感測器', field: 'sev', used: 'ips', unit: '種嚴重程度', items: IPS_SEV.map((s) => [s, `${SEV_ZH[s]}（${s}）`, `嚴重程度 ${s} 的攻擊直接封鎖`]) });
  addCard(ctx, body, { key: 'ips', title: '新增 IPS 感測器', ph: '感測器名稱，例如 protect-web', make: () => ({ sev: ['high', 'critical'] }) });
  profileCards(ctx, body, { key: 'dnsf', title: 'DNS 過濾', field: 'block', used: 'dnsf', unit: '個類別', items: Object.keys(FG_CATS).filter((k) => k !== '0').map((k) => [+k, `${CAT_ZH[k]}（${k}）`, FG_CATS[k]]) });
  addCard(ctx, body, { key: 'dnsf', title: '新增 DNS 過濾設定檔', ph: '設定檔名稱，例如 corp-dns', make: () => ({ block: [] }) });
  profileCards(ctx, body, { key: 'av', title: '防毒', field: 'scan', used: 'av', unit: '種協定', verb: '掃描', items: [['http', 'HTTP 下載', 'config http → set av-scan block'], ['ftp', 'FTP 下載', 'config ftp → set av-scan block']] });
  addCard(ctx, body, { key: 'av', title: '新增防毒設定檔', ph: '設定檔名稱，例如 corp-av', make: () => ({ scan: ['http'] }) });
}
