// Console 線與帶外管理
// - 設備設了 remoteOnly：它在機房的機櫃裡，面板上不能直接改設定，只能用 SSH（電腦的終端機）或帶筆電去接 Console 線
// - 筆電的「Console」分頁：接上 USB 轉 RJ45 的 Console 線、選 COM 埠與速率 (9600 bps)，就是那台設備的命令列
import { h, button, toast } from './dom.js';
import { sel, field, note, cardHead, badge, kv } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { isIos } from '../engine/ios.js';
import { buildCli } from './cli.js';
import { buildFortiCli } from './forticli.js';

export const CONSOLE_BAUD = 9600;
const SPEEDS = [9600, 19200, 38400, 57600, 115200];
/** 有 Console 埠、這個模擬能用 Console 登入的設備 */
export const consoleCapable = (d) => !d.locked && (isIos(d) || d.kind === 'firewall');
/** 這個場景裡有沒有「只能遠端管理」的設備（筆電才會多一個 Console 分頁） */
export const needsConsole = (state) => Object.values(state.devices).some((d) => d.remoteOnly);

/** remoteOnly 的設備：面板只顯示資訊與怎麼連進去 */
export function remoteOnlyInfo(ctx, body) {
  const { dev, state } = ctx;
  const ips = dev.ifaces.filter((i) => i.rt && i.rt.ip != null).map((i) => `${i.label} ${fmtIp(i.rt.ip)}`);
  const via = Object.entries(state.consoles || {}).filter(([, c]) => c.to === dev.id).map(([id]) => state.devices[id] && state.devices[id].name).filter(Boolean);
  body.append(h('div', { class: 'card' }, cardHead('在機房的機櫃裡', badge(via.length ? 'on' : 'off', via.length ? `Console 接在 ${via.join('、')}` : '沒有 Console 線')),
    note('muted', '這台設備裝在機房，面板上不能直接改設定。管理它的方式：'),
    kv('遠端 (in-band)', ips.length ? `電腦的終端機：ssh <帳號>@${ips[0].split(' ').pop()}` : '沒有 IP 位址，只能用 Console'),
    kv('Console（帶外）', '帶一台筆電過去，接上 Console 線，在筆電的「Console」分頁操作'),
    ips.length ? kv('管理位址', ips.join('、')) : null,
    note('muted', 'SSH 被 ACL 擋住、管理 VLAN 設錯、密碼忘了的時候，Console 是最後的入口：它不走網路，不受這些設定影響。')));
}

/** 筆電的 Console 分頁 */
export function consoleTab(ctx, body) {
  const { dev, state } = ctx;
  const link = (state.consoles || {})[dev.id];
  const targets = Object.values(state.devices).filter((d) => d.id !== dev.id && consoleCapable(d));
  if (!link || !state.devices[link.to]) {
    const draft = { to: (targets.find((d) => d.remoteOnly) || targets[0] || {}).id || '' };
    const quiet = { commit() {} };
    body.append(h('p', { class: 'tip', text: 'Console 線（USB 轉 RJ45 或傳統的 rollover 線）直接接到設備的 Console 埠，不經過網路：IP、VLAN、ACL 設錯都還進得去。' }),
      h('div', { class: 'card' }, cardHead('接上 Console 線'),
        targets.length ? field('接到哪一台的 Console 埠', sel(quiet, () => draft.to, (v) => { draft.to = v; }, targets.map((d) => [d.id, `${d.name}${d.remoteOnly ? '（機房）' : ''}`]))) : note('muted', '這裡沒有可以接 Console 的設備'),
        targets.length ? h('div', { class: 'addrow' }, button('接上 Console 線', { ic: 'plus', kind: 'primary', small: true, onclick: () => {
          if (!draft.to) return;
          (state.consoles ||= {})[dev.id] = { to: draft.to, baud: CONSOLE_BAUD };
          toast(`${dev.name} 的 Console 線接到 ${state.devices[draft.to].name}`, 'ok');
          ctx.commit(true);
        } })) : null));
    return;
  }
  const t = state.devices[link.to];
  body.append(h('div', { class: 'card console-cfg' }, cardHead(`Console → ${t.name}`, badge(+link.baud === CONSOLE_BAUD ? 'on' : 'warn', `COM3 · ${link.baud} bps`)),
    field('速率 (Speed)', sel(ctx, () => String(link.baud), (v) => { link.baud = +v; }, SPEEDS.map((s) => [String(s), `${s} bps`]), { rerender: true })),
    kv('格式', '8 data bits · no parity · 1 stop bit · 無流量控制 (8N1)'),
    h('div', { class: 'addrow' }, button('拔掉 Console 線', { ic: 'trash', small: true, onclick: () => { delete state.consoles[dev.id]; ctx.commit(true); } }))));
  if (+link.baud !== CONSOLE_BAUD) {
    body.append(h('div', { class: 'term' }, h('div', { class: 'term-out' },
      ...['ÿþ\u008fÃæxàø\u0080', 'þæ\u0098à\u0086xø\u0080à', 'æ\u0098xø\u0080àþ'].map((x) => h('div', { class: 'tl', text: x }))),
    note('warn', `畫面上全是亂碼：速率不對。${isIos(t) ? 'Cisco' : 'FortiGate'} 的 Console 預設是 ${CONSOLE_BAUD} bps（8N1）。`)));
    return;
  }
  const sub = { ...ctx, dev: t };
  if (t.kind === 'firewall') buildFortiCli(sub, body);
  else buildCli(sub, body);
}
