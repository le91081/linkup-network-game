// 網路攝影機與 NVR 的分頁：攝影機送到哪一台 NVR、畫質（位元率）；NVR 看得到每一台攝影機錄得順不順
import { h } from './dom.js';
import { sel, field, note, cardHead, badge, inp, isIp } from './form.js';
import { fmtIp, parseIp } from '../engine/ip.js';

// 常見的畫質設定：H.264 / H.265 的位元率
export const CAM_PROFILES = [
  ['2', '1080p · H.265 · 2 Mbps'], ['4', '1080p · H.264 · 4 Mbps'], ['6', '4MP · H.264 · 6 Mbps'], ['8', '4K · H.265 · 8 Mbps'], ['16', '4K · H.264 · 16 Mbps'],
];

/** 攝影機：影像送到哪一台 NVR、畫質，以及現在實際送出去多少 */
export function camTab(ctx, body) {
  const { dev, state } = ctx;
  const c = dev.cam;
  const f = ((state.rt && state.rt.cams) || {})[dev.id], r = f && f.rt;
  const off = (state.rt.off || {})[dev.id];
  const card = h('div', { class: 'card' }, cardHead('影像串流', off ? badge('off', '沒有電') : !c.nvr ? badge('off', '沒有設定 NVR') : r && r.mbps >= +c.mbps - 0.5 ? badge('on', '錄影正常') : badge('warn', r && r.mbps > 0 ? '畫面會卡' : '送不到 NVR')));
  card.append(...[
    field('NVR 的位址', inp(ctx, () => c.nvr || '', (v) => { c.nvr = v; }, { ph: '例如 10.10.50.10', check: isIp })),
    field('畫質（位元率）', sel(ctx, () => String(c.mbps), (v) => { c.mbps = +v; }, CAM_PROFILES, { rerender: true }), '影像是固定的位元率：線路剩下的頻寬比它少，畫面就會卡、掉格'),
    off ? note('warn', '攝影機沒有電：要接在有 PoE 的交換器埠上（Class 3，大約 6.5 W）。') : null,
    r ? (r.mbps >= +c.mbps - 0.5 ? note('ok', `NVR 收到 ${r.mbps} Mbps，錄影正常。`) : note('warn', r.mbps > 0 ? `只送得出 ${r.mbps} Mbps（需要 ${c.mbps} Mbps）：${r.where || '線路的頻寬不夠'}` : `影像送不到 NVR：${r.why || '連不上'}`)) : null].filter(Boolean)); // DOM 的 append 會把 null 印成字
  body.append(card);
}

/** NVR：哪些攝影機在對它送影像，每一台錄得順不順 */
export function nvrTab(ctx, body) {
  const { dev, state } = ctx;
  const mine = dev.ifaces.map((i) => i.rt && i.rt.ip).filter((x) => x != null);
  const cams = Object.values(state.devices).filter((d) => d.cam && mine.includes(parseIp(d.cam.nvr || '')));
  const card = h('div', { class: 'card' }, cardHead(`錄影頻道（${cams.length} / 8）`));
  if (!cams.length) card.append(note('muted', '還沒有攝影機把影像送到這台 NVR：在攝影機的「攝影機」分頁填這台的位址。'));
  let total = 0;
  for (const d of cams) {
    const f = ((state.rt && state.rt.cams) || {})[d.id], r = f && f.rt;
    const got = r ? r.mbps : 0;
    total += got;
    const ok = got >= +d.cam.mbps - 0.5;
    card.append(h('div', { class: 'line' }, h('b', { text: d.name }), h('span', { class: 'muted mono', text: `${got} / ${d.cam.mbps} Mbps` }),
      badge(ok ? 'on' : got > 0 ? 'warn' : 'off', ok ? '正常' : got > 0 ? '畫面卡頓' : '沒有影像')));
  }
  if (cams.length > 8) card.append(note('warn', '這台 NVR 最多 8 路，超過的攝影機不會被錄下來。'));
  if (cams.length) card.append(note('muted', `合計收到 ${Math.round(total * 10) / 10} Mbps。每一台攝影機的影像是固定的位元率，經過的每一段線路都要有足夠的頻寬。`));
  body.append(card);
  void fmtIp;
}

/** 多點傳送：來源送出哪些群組、送到了誰；接收端加入了哪些群組（IGMP）、有沒有收到 */
export function mcastTab(ctx, body) {
  const { dev, state } = ctx;
  const streams = (state.rt && state.rt.mstreams) || [], nm = (id) => (state.devices[id] || {}).name || id;
  if ((dev.mcastSrc || []).length) {
    const card = h('div', { class: 'card' }, cardHead('送出的多點傳送串流'));
    for (const s of streams.filter((x) => x.src === dev.id)) {
      card.append(h('div', { class: 'line' }, h('b', { text: s.name }), h('span', { class: 'muted mono', text: `${s.group} · ${s.mbps} Mbps` }),
        badge(s.flooded ? 'warn' : 'on', s.flooded ? '泛洪到整個 VLAN' : 'IGMP snooping 只送給有加入的')));
      card.append(note('muted', `收看的：${s.members.map(nm).join('、') || '（沒有）'}${s.extra.length ? `；沒有加入也收到的：${s.extra.map(nm).join('、')}（網卡會丟掉，但線路的頻寬已經被佔掉了）` : ''}`));
    }
    card.append(note('muted', '多點傳送是固定速率的 UDP 串流：線路塞車時不會讓路，TCP 只能用剩下的頻寬。'));
    body.append(card);
  }
  const card = h('div', { class: 'card' }, cardHead('加入的群組 (IGMP)'));
  const list = (dev.igmp ||= []);
  if (!list.length) card.append(note('muted', '沒有加入任何多點傳送群組。打開 IPTV 或數位看板的播放程式，電腦就會送出 IGMP Report 加入那個群組。'));
  list.forEach((g, k) => {
    const s = streams.find((x) => x.group === g && x.members.includes(dev.id)), miss = streams.find((x) => x.group === g && x.missed.includes(dev.id));
    card.append(h('div', { class: 'line' }, h('b', { class: 'mono', text: g }),
      s ? badge('on', `收看中 · ${s.name} ${s.mbps} Mbps`) : badge('off', miss ? '收不到' : '沒有這個群組的串流'),
      h('button', { class: 'mini', type: 'button', title: '離開這個群組', onclick: () => { list.splice(k, 1); ctx.commit(true); } }, '離開')));
    if (miss && miss.why && miss.why[dev.id]) card.append(note('warn', miss.why[dev.id]));
  });
  let draft = '';
  card.append(h('div', { class: 'addrow' }, inp(ctx, () => draft, (v) => { draft = v; }, { ph: '例如 239.1.1.1' }),
    h('button', { class: 'mini', type: 'button', onclick: () => { const g = String(draft).trim(); const ip = parseIp(g); if (ip != null && (ip >>> 28) === 14 && !list.includes(g)) { list.push(g); ctx.commit(true); } } }, '加入')));
  body.append(card);
}
