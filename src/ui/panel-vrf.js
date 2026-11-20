// VRF（路由器上的虛擬化：一台路由器切成好幾份獨立的路由表）
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, cardHead, del } from './form.js';
import { routeRows } from '../engine/sim.js';

/** 介面屬於哪個 VRF（路由器有建立 VRF 時才顯示） */
export function vrfField(ctx, i) {
  const vs = Object.keys(ctx.dev.vrfs || {});
  if (!vs.length && !i.vrf) return null;
  return field('VRF', sel(ctx, () => i.vrf || '', (v) => { if (v) i.vrf = v; else delete i.vrf; }, [['', '全域（預設的路由表）'], ...vs.map((v) => [v, v])], { rerender: true }),
    '不同 VRF 的介面各用各的路由表，位址可以重疊。CLI 的 vrf forwarding 會把介面的位址清掉，要重新設定');
}

/** 路由分頁：VRF 清單與各自的路由表 */
export function vrfCard(ctx) {
  const { dev } = ctx;
  const vs = Object.entries(dev.vrfs || {});
  const draft = (ctx.app.vrfDraft ||= { name: '', rd: '' });
  return h('div', { class: 'card' }, cardHead(`VRF（${vs.length}）`),
    note('muted', 'VRF 把一台路由器切成好幾個獨立的路由器：每個 VRF 有自己的路由表，彼此看不到，所以不同的客戶可以用一樣的網段。介面放進哪個 VRF，就只用那個 VRF 的路由表轉送。'),
    vs.map(([n, v]) => {
      const ifs = dev.ifaces.filter((i) => i.vrf === n).map((i) => i.label);
      const rows = routeRows(dev, n);
      return h('div', { class: 'sub vrf' },
        h('div', { class: 'card-h' }, h('b', { class: 'mono', text: n }), h('span', { class: 'muted mono', text: v.rd ? `RD ${v.rd}` : '沒有 RD' }),
          del(() => {
            for (const i of dev.ifaces) if (i.vrf === n) delete i.vrf;
            dev.routes = dev.routes.filter((r) => r.vrf !== n);
            delete dev.vrfs[n];
            if (!Object.keys(dev.vrfs).length) delete dev.vrfs;
            ctx.commit(true);
          })),
        note(ifs.length ? 'muted' : 'warn', ifs.length ? `介面：${ifs.join('、')}` : '還沒有任何介面在這個 VRF 裡（在「介面」分頁選 VRF，或 CLI 的 vrf forwarding）'),
        rows.length ? h('div', { class: 'vrf-rt mono' }, rows.map((r) => h('div', { text: `${r.type}  ${r.dst}  ${r.via === '直連' ? 'is directly connected, ' + r.iface : 'via ' + r.via}` }))) : null);
    }),
    h('div', { class: 'addrow' },
      inp({ commit() {} }, () => draft.name, (v) => { draft.name = v.trim(); }, { ph: 'VRF 名稱，例如 TENANT-A', mono: true }),
      inp({ commit() {} }, () => draft.rd, (v) => { draft.rd = v.trim(); }, { ph: 'RD，例如 65000:1', w: '8.5em' }),
      button('新增', { small: true, onclick: () => {
        if (!/^[\w-]{1,32}$/.test(draft.name)) return toast('VRF 名稱只能用英文、數字、- 與 _', 'bad');
        if ((dev.vrfs || {})[draft.name]) return toast('已經有這個 VRF', 'bad');
        if (draft.rd && !/^(\d+|\d+\.\d+\.\d+\.\d+):\d+$/.test(draft.rd)) return toast('RD 的格式是 ASN:編號，例如 65000:1', 'bad');
        (dev.vrfs ||= {})[draft.name] = { style: 'def', af4: true, ...(draft.rd ? { rd: draft.rd } : {}) };
        draft.name = ''; draft.rd = '';
        ctx.commit(true);
        return undefined;
      } })));
}
