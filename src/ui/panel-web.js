// 網站與 HTTPS 憑證：伺服器的「網站」分頁、用戶端的「憑證與時間」卡片
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, cardHead, badge, toggle, kv } from './form.js';
import { certSelf, certDaysLeft, fmtDate, issueCert, PUBLIC_CAS, CORP_CA } from '../engine/web.js';
import { plainStamp } from '../engine/ops.js';

const isName = (v) => /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(v);
const splitNames = (v) => String(v || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** 憑證的狀態（用模擬世界真正的時間；用戶端時鐘錯了是用戶端的問題） */
export function certState(state, c) {
  if (!c) return ['bad', '沒有憑證'];
  const left = certDaysLeft(state, c);
  if (left < 0) return ['bad', `已過期 ${-left} 天`];
  if (left <= 30) return ['warn', `${left} 天後到期`];
  return ['on', `還有 ${left} 天`];
}

/** 伺服器的「網站」分頁 */
export function webTab(ctx, body) {
  const { dev, state, app } = ctx;
  const w = dev.web;
  const c = w.cert;
  body.append(note('muted', '瀏覽器連 HTTPS 時會檢查三件事：憑證是不是信任的 CA 簽的、現在是不是在有效期間內（用「瀏覽器那台電腦」的時鐘）、網址的名稱有沒有列在憑證的主體別名 (SAN) 裡。任何一項不對就會出現「你的連線不是私人連線」。'));
  body.append(h('div', { class: 'card' }, cardHead('網站'),
    field('網頁標題', inp(ctx, () => w.title || '', (v) => { w.title = v; }, { ph: dev.name, mono: false })),
    toggle(ctx, () => !!w.redirect, (v) => { w.redirect = v; }, 'HTTP (80) 一律轉到 HTTPS (443)（301 轉址）')));
  const [k, t] = certState(state, c);
  body.append(h('div', { class: 'card' }, cardHead('目前的憑證', badge(k, t)),
    c ? [
      kv('主體 (CN)', c.cn),
      kv('主體別名 (SAN)', (c.san && c.san.length ? c.san : [c.cn]).join(', ')),
      kv('簽發者', certSelf(c) ? `${c.cn}（自簽）` : c.issuer),
      kv('有效期間', `${fmtDate(c.from)} ～ ${fmtDate(c.to)}`),
      certSelf(c) && note('warn', '自簽憑證沒有人信任：每個使用者都會看到警告。'),
    ] : note('bad', '這個網站還沒有安裝憑證：443 有在聽，但 TLS 交握一開始就會失敗。')));
  // 申請新的憑證：產生金鑰與 CSR → 交給 CA 簽 → 安裝並重新載入網站
  const draft = ((app.certDraft ||= {})[dev.id] ||= { cn: (c && c.cn) || '', san: c ? (c.san || [c.cn]).join(', ') : '', issuer: CORP_CA, days: '365' });
  body.append(h('div', { class: 'card' }, cardHead('申請新的憑證'),
    note('muted', '產生新的私密金鑰與憑證簽署要求 (CSR)，送給 CA 簽發之後安裝到網站。Chrome 58 之後只看主體別名 (SAN)，不看 CN：使用者會打的每一個名稱都要列進去。'),
    field('主體 (CN)', inp({ commit() {} }, () => draft.cn, (v) => { draft.cn = v.trim(); }, { ph: 'intranet.corp.local', check: isName })),
    field('主體別名 (SAN)', inp({ commit() {} }, () => draft.san, (v) => { draft.san = v; }, { ph: 'intranet.corp.local, portal.corp.local', check: (v) => splitNames(v).every(isName) }), '用逗號分隔；可以用萬用字元 *.corp.local（只比對一層）'),
    field('交給哪個 CA 簽發', sel({ commit() {} }, () => draft.issuer, (v) => { draft.issuer = v; }, [[CORP_CA, `${CORP_CA}（公司的內部 CA）`], [PUBLIC_CAS[0], `${PUBLIC_CAS[0]}（公開 CA）`], ['self', '自簽（不經過 CA）']])),
    field('有效期間', sel({ commit() {} }, () => draft.days, (v) => { draft.days = v; }, [['90', '90 天'], ['365', '1 年'], ['730', '2 年']])),
    h('div', { class: 'addrow' }, button('產生 CSR、簽發並安裝', { ic: 'check', small: true, onclick: () => {
      const cn = draft.cn.toLowerCase(), san = splitNames(draft.san);
      if (!isName(cn)) return toast('主體 (CN) 要是一個網域名稱，例如 intranet.corp.local', 'bad');
      if (!san.every(isName)) return toast('主體別名裡有不是網域名稱的項目', 'bad');
      const names = san.length ? san : [cn];
      if (draft.issuer === PUBLIC_CAS[0] && names.some((n) => /\.(local|lan|internal|corp)$/.test(n))) return toast('公開 CA 不會簽發內部網域（.local 這類）的憑證：CA/B 論壇從 2015 年起禁止。內部的名稱要用公司自己的 CA', 'bad', 7000);
      if (draft.issuer === PUBLIC_CAS[0] && +draft.days > 398) return toast('公開 CA 簽發的憑證最長 398 天', 'bad');
      w.cert = issueCert(state, { cn, san: names, issuer: draft.issuer === 'self' ? cn : draft.issuer, days: +draft.days });
      toast(draft.issuer === 'self' ? '已安裝自簽憑證' : `${draft.issuer} 已簽發並安裝：${names.join('、')}`, 'ok', 5000);
      ctx.commit(true);
      return undefined;
    } }))));
}

/** 用戶端（電腦）的「憑證與時間」：信任哪些 CA、時鐘準不準 */
export function clientTlsCard(ctx) {
  const { dev, state } = ctx;
  const trust = (dev.trust ||= []);
  const t = plainStamp(state, dev);
  const clk = dev.clock;
  const sync = !clk || clk.sync !== false;
  return h('div', { class: 'card' }, cardHead('憑證與時間'),
    h('div', { class: 'acl-h' }, h('span', { text: '受信任的根憑證授權單位' }), h('em', { text: '作業系統內建公開的 CA' })),
    h('div', { class: 'chips' }, PUBLIC_CAS.map((n) => h('span', { class: 'chip', text: n }))),
    toggle(ctx, () => trust.includes(CORP_CA), (v) => { dev.trust = v ? [...new Set([...trust, CORP_CA])] : trust.filter((x) => x !== CORP_CA); },
      `安裝公司的根憑證「${CORP_CA}」（加入網域的電腦由群組原則自動安裝；自己帶的電腦要手動匯入）`, { rerender: true }),
    h('div', { class: 'acl-h' }, h('span', { text: '日期與時間' }), h('em', { text: `${t.date} ${t.time}` })),
    toggle(ctx, () => sync, (v) => { dev.clock = { ...(clk || {}), sync: v }; }, '自動設定時間（與 time.windows.com 同步）', { rerender: true }),
    !sync && note('warn', `自動校時關著，這台的時鐘差了 ${Math.round(Math.abs(+(clk && clk.skew) || 0) / 86400)} 天：憑證的有效期間是用這個時間判斷的。`));
}
