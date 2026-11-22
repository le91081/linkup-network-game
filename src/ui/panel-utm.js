// FortiGate 的安全設定檔：網頁過濾設定檔（FortiGuard 類別）與政策上的 SSL 檢查
import { h, button, toast } from './dom.js';
import { sel, toggle, field, note, cardHead, badge, del } from './form.js';
import { FG_CATS, CAT_ZH, SSL_PROFILES } from '../engine/utm.js';

const SSL_TEXT = {
  'no-inspection': 'no-inspection（不檢查：HTTPS 看不到網址）',
  'certificate-inspection': 'certificate-inspection（看 SNI / 憑證：可以依類別封鎖 HTTPS）',
  'deep-inspection': 'deep-inspection（解密：電腦要信任 Fortinet_CA_SSL）',
};

/** 政策卡片裡的「安全設定檔」欄位 */
export function policyUtmFields(ctx, p) {
  const { dev } = ctx;
  const profs = Object.keys(dev.wf || {});
  return h('div', { class: 'utm-fields' },
    toggle(ctx, () => !!p.utm, (v) => { if (v) { p.utm = true; p.ssl ||= 'no-inspection'; } else { delete p.utm; delete p.ssl; delete p.wf; } }, '安全設定檔 (utm-status)', { rerender: true }),
    p.utm && field('網頁過濾 (webfilter-profile)', sel(ctx, () => p.wf || '', (v) => { if (v) p.wf = v; else delete p.wf; }, [['', '（不使用）'], ...profs.map((n) => [n, n])], { rerender: true })),
    p.utm && field('SSL 檢查 (ssl-ssh-profile)', sel(ctx, () => p.ssl || 'no-inspection', (v) => { p.ssl = v; }, SSL_PROFILES.map((x) => [x, SSL_TEXT[x]]), { rerender: true })),
    p.utm && p.wf && (p.ssl || 'no-inspection') === 'no-inspection' && note('warn', 'SSL 檢查是 no-inspection：HTTPS 的網站看不到網址，網頁過濾只對 HTTP 有效。'),
    p.utm && p.ssl === 'deep-inspection' && note('muted', 'deep-inspection 會解密 HTTPS：電腦收到的是 FortiGate 用 Fortinet_CA_SSL 重新簽的憑證，沒有安裝這張 CA 的電腦會跳憑證錯誤。'));
}

/** 「安全設定檔」分頁：網頁過濾設定檔 */
export function utmTab(ctx, body) {
  const { dev } = ctx;
  body.append(h('p', { class: 'tip', text: '網頁過濾依 FortiGuard 的網站類別封鎖：設定檔裡勾選要封鎖的類別，再到政策上啟用安全設定檔、選這個設定檔。HTTPS 要搭配 SSL 檢查（至少 certificate-inspection）才看得到是哪個網站。' }));
  const wf = dev.wf || {};
  for (const [name, prof] of Object.entries(wf)) {
    const c = h('div', { class: 'card wf-prof' }, cardHead(`網頁過濾 · ${name}`, badge((prof.block || []).length ? 'on' : 'off', `封鎖 ${(prof.block || []).length} 個類別`),
      del(() => { if ((dev.policies || []).some((p) => p.wf === name)) return toast(`「${name}」還被政策使用中`, 'bad'); delete dev.wf[name]; if (!Object.keys(dev.wf).length) delete dev.wf; ctx.commit(true); }, `刪除設定檔 ${name}`)));
    c.append(h('div', { class: 'chips wf-cats' }, Object.keys(FG_CATS).filter((k) => k !== '0').map((k) => toggle(ctx, () => (prof.block || []).includes(+k),
      (v) => { prof.block = v ? [...new Set([...(prof.block || []), +k])].sort((a, b) => a - b) : (prof.block || []).filter((x) => x !== +k); },
      `${CAT_ZH[k]}（${k}）`, { title: FG_CATS[k], rerender: true }))));
    if (!(dev.policies || []).some((p) => p.wf === name)) c.append(note('warn', '還沒有任何政策使用這個設定檔：到「政策」分頁啟用安全設定檔並選擇它。'));
    body.append(c);
  }
  const inp = h('input', { class: 'inp mono', placeholder: '設定檔名稱，例如 corp-wf', spellcheck: 'false' });
  const add = () => {
    const n = inp.value.trim();
    if (!/^[\w.-]{1,35}$/.test(n)) return toast('名稱用英文、數字、底線、點或連字號（最多 35 個字）', 'bad');
    if (wf[n]) return toast(`「${n}」已經存在`, 'bad');
    (dev.wf ||= {})[n] = { block: [] };
    ctx.commit(true);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  body.append(h('div', { class: 'card' }, cardHead('新增網頁過濾設定檔'), h('div', { class: 'addrow' }, inp, button('新增', { ic: 'plus', kind: 'primary', small: true, onclick: add }))));
}
