// MTU 的設定畫面：主機網卡的 Jumbo Frame、路由器介面的 MTU 與 TCP MSS、交換器整台的 MTU、Nexus 每個埠、ESXi 的虛擬交換器
import { h, icon, toast } from './dom.js';
import { inp, sel, field, note, cardHead, grid2 } from './form.js';
import { jumboNow, isCat2960, isCat9300, isNexus, jumboCapable, IPSEC_OVERHEAD } from '../engine/mtu.js';

/** 數字欄位：空白就刪掉（回到預設），範圍外的值不收 */
const numSet = (obj, key, lo, hi, def, what) => (v) => {
  if (v === '' || +v === def) { delete obj[key]; return; }
  const n = +v;
  if (!Number.isInteger(n) || n < lo || n > hi) { toast(`${what}的範圍是 ${lo} – ${hi}`, 'bad'); return; }
  obj[key] = n;
};
/** 下拉選單：常用的值，加上目前的值（如果不在清單裡） */
const opts = (cur, list) => (list.some(([v]) => v === String(cur)) ? list : [...list, [String(cur), String(cur)]]);

/** 主機網卡的 MTU：Windows 網卡內容裡的「Jumbo Packet」、Linux 的 ip link set mtu */
export function hostMtuField(ctx, i) {
  if (!jumboCapable(ctx.dev) || i.bind.t === 'wlan') return null;
  const cur = +i.mtu || 1500;
  return field('MTU', sel(ctx, () => String(cur), (v) => { if (+v === 1500) delete i.mtu; else i.mtu = +v; },
    opts(cur, [['1500', '1500（預設）'], ['9000', '9000（Jumbo Frame：網卡的 Jumbo Packet 設成 9014 Bytes）']]), { rerender: true }),
  cur > 1500 ? '同一個網段裡，交換器和另一端也都要開 Jumbo Frame，只開一邊大的封包會被丟掉' : null);
}

/** 路由器介面：介面的 MTU、IP MTU、TCP MSS 調整（收合起來，設定過才展開） */
export function routerMtuBlock(ctx, i) {
  const { dev, app } = ctx;
  const key = `${dev.id}:${i.id}:mtu`, set = +i.l2mtu || +i.mtu || +i.adjMss;
  const open = app.adv.has(key) || !!set;
  const sum = set ? `（${[+i.l2mtu ? `MTU ${i.l2mtu}` : '', +i.mtu ? `IP MTU ${i.mtu}` : '', +i.adjMss ? `MSS ${i.adjMss}` : ''].filter(Boolean).join('、')}）` : '';
  const btn = h('button', {
    type: 'button', class: 'advbtn' + (open ? ' on' : ''),
    onclick: () => { if (app.adv.has(key)) app.adv.delete(key); else app.adv.add(key); app.renderPanel(); },
  }, icon(open ? 'down' : 'chevron', 13), `MTU 與 TCP MSS${sum}`);
  if (!open) return btn;
  const l2 = +i.l2mtu || 1500;
  return h('div', { class: 'mtu-blk' }, btn,
    grid2(
      field('介面 MTU (mtu)', inp(ctx, () => (i.l2mtu ? String(i.l2mtu) : ''), (v) => { numSet(i, 'l2mtu', 1500, 9216, 1500, '介面 MTU ')(v); if (+i.mtu >= (+i.l2mtu || 1500)) delete i.mtu; }, { ph: '1500', w: '7em', rerender: true })),
      field('IP MTU (ip mtu)', inp(ctx, () => (i.mtu ? String(i.mtu) : ''), numSet(i, 'mtu', 68, l2, l2, 'IP MTU '), { ph: String(l2), w: '7em', rerender: true })),
      field('TCP MSS 調整 (ip tcp adjust-mss)', inp(ctx, () => (i.adjMss ? String(i.adjMss) : ''), numSet(i, 'adjMss', 500, 1460, 0, 'MSS '), { ph: '不調整', w: '7em', rerender: true }))),
    note('muted', `站對站 IPsec 加密之後多 ${IPSEC_OVERHEAD} 位元組（通道裡最多 ${1500 - IPSEC_OVERHEAD}），PPPoE 多 8 位元組（1492）。大封包過不去、ICMP「需要分段」又被擋掉時，把經過這個介面的 TCP SYN 的 MSS 改小（IPsec 常用 1360、PPPoE 用 1452）。`));
}

/** 交換器整台的 MTU：2960 的 system mtu jumbo（重新開機才生效）、9300 的 system mtu */
export function switchMtuCard(ctx) {
  const { dev, state } = ctx;
  if (isCat2960(dev)) {
    const now = jumboNow(state, dev), next = +dev.sw.jumbo || 1500;
    return h('div', { class: 'card' }, cardHead('MTU（Jumbo Frame）', h('span', { class: 'chip tiny', text: `生效中 ${now}` })),
      field('system mtu jumbo', sel(ctx, () => String(next), (v) => { if (+v === 1500) delete dev.sw.jumbo; else dev.sw.jumbo = +v; },
        opts(next, [['1500', '1500（預設）'], ['9000', '9000（最大）']]), { rerender: true })),
      next !== now ? note('warn', `下次開機才會變成 ${next}：Catalyst 2960 改了 Jumbo MTU 要先儲存設定（write memory），再重新開機（reload）`)
        : note('muted', '整台的 Gigabit 埠一起套用。比這個大的訊框會被當成 giant 丟掉，不會通知任何人。'));
  }
  if (isCat9300(dev)) {
    const cur = +dev.sw.sysMtu || 1500;
    return h('div', { class: 'card' }, cardHead('MTU（Jumbo Frame）'),
      field('system mtu', sel(ctx, () => String(cur), (v) => { if (+v === 1500) delete dev.sw.sysMtu; else dev.sw.sysMtu = +v; for (const i of dev.ifaces) if (+i.mtu > (+dev.sw.sysMtu || 1500)) delete i.mtu; },
        opts(cur, [['1500', '1500（預設）'], ['9000', '9000'], ['9198', '9198（最大）']]), { rerender: true })),
      note('muted', '馬上生效，整台的連接埠、SVI 與 routed 埠一起套用（SVI 可以再用 ip mtu 調小）。'));
  }
  if (isNexus(dev)) return h('div', { class: 'card' }, cardHead('MTU（Jumbo Frame）'), note('muted', 'Nexus 每個埠各自設定 MTU（mtu 9216）：在上面每個連接埠的卡片裡調整。一條路上每個埠都要一樣大。'));
  return null;
}

/** Nexus 每個埠的 MTU */
export function nexusPortMtu(ctx, pc) {
  if (!isNexus(ctx.dev)) return null;
  const cur = +pc.mtu || 1500;
  return field('MTU', sel(ctx, () => String(cur), (v) => { if (+v === 1500) delete pc.mtu; else pc.mtu = +v; }, opts(cur, [['1500', '1500（預設）'], ['9216', '9216（Jumbo）']]), { rerender: true }));
}

/** ESXi：虛擬交換器的 MTU */
export function vswMtuField(ctx) {
  const v = ctx.dev.vsw, cur = +v.mtu || 1500;
  return field('虛擬交換器的 MTU', sel(ctx, () => String(cur), (x) => { if (+x === 1500) delete v.mtu; else v.mtu = +x; }, opts(cur, [['1500', '1500（預設）'], ['9000', '9000（Jumbo Frame）']]), { rerender: true }),
    '虛擬機器、vmk 介面與實體交換器都要一起調大；vSwitch 比較小的話，大的訊框在主機裡就被丟掉');
}
/** ESXi：VMkernel 介面的 MTU */
export function vmkMtuField(ctx, vmk) {
  const cur = +vmk.mtu || 1500;
  return field('vmk0 的 MTU', sel(ctx, () => String(cur), (x) => { if (+x === 1500) delete vmk.mtu; else vmk.mtu = +x; }, opts(cur, [['1500', '1500（預設）'], ['9000', '9000']]), { rerender: true }));
}
