// OSPF 的設定頁面：程序（全域與每個 VRF 的）、Router ID、參考頻寬、預設路由、區域彙總、區域的種類（stub / NSSA）
// 和 CLI 是同一份設定：全域的程序放在設備上，router ospf <pid> vrf <名稱> 放在 d.ospfVrf[名稱]
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, del, cardHead, grid2, bind, toggle, isIp, isNum } from './form.js';
import { fmtIp, parseIp } from '../engine/ip.js';
import { ospfProc, ospfKeys, ospfArea, ospfAreaType } from '../engine/ospf.js';

const KINDS = [['normal', '一般區域'], ['stub', 'stub（不收外部路由）'], ['tstub', 'totally stubby（連區域間的路也不收，只有預設路由）'], ['nssa', 'NSSA（不收外部路由，但區域裡可以重分配）'], ['tnssa', 'totally NSSA']];
const kindOf = (a) => (a.nssa ? (a.noSum ? 'tnssa' : 'nssa') : a.stub ? (a.noSum ? 'tstub' : 'stub') : 'normal');

/** 這個程序目前要顯示的區域：用到的（介面上的）加上設定過的，骨幹除外 */
function areasOf(dev, vrf, c) {
  const s = new Set(Object.keys(c.ospfAreas || {}).map(Number));
  for (const i of dev.ifaces) if ((i.vrf || '') === vrf) { const a = ospfArea(dev, i); if (a != null) s.add(a); }
  s.delete(0);
  return [...s].sort((a, b) => a - b);
}

/** 區域種類的一列：種類、預設路由的 cost、NSSA 的選項 */
function areaRow(ctx, c, area) {
  // 畫面上只讀；真的改了才建立 c.ospfAreas[area]，改回一般區域就整筆拿掉
  const ar = (c.ospfAreas || {})[area] || {};
  const edit = (fn) => (v) => {
    const w = ((c.ospfAreas ||= {})[area] ||= {});
    fn(w, v);
    if (!Object.keys(w).length) delete c.ospfAreas[area];
    if (!Object.keys(c.ospfAreas).length) delete c.ospfAreas;
  };
  const setKind = edit((w, k) => {
    for (const x of ['stub', 'nssa', 'noSum', 'nssaDef', 'nssaDefMetric', 'nssaDefType', 'noRedist']) delete w[x];
    if (k === 'stub' || k === 'tstub') w.stub = true;
    if (k === 'nssa' || k === 'tnssa') w.nssa = true;
    if (k === 'tstub' || k === 'tnssa') w.noSum = true;
    if (k === 'normal') delete w.cost;
  });
  const k = kindOf(ar);
  const kids = [
    h('div', { class: 'line' }, h('b', { class: 'mono', text: `area ${area}` }), sel(ctx, () => k, setKind, KINDS, { rerender: true })),
  ];
  if (k !== 'normal') {
    kids.push(grid2(
      field('送進來的預設路由 cost (default-cost)', inp(ctx, () => (ar.cost != null ? String(ar.cost) : ''), edit((w, v) => { if (v === '' || +v === 1) delete w.cost; else w.cost = +v; }), { ph: '預設 1（ABR 才用得到）', check: isNum(0, 16777215) }))));
    if (k === 'nssa' || k === 'tnssa') {
      kids.push(h('div', { class: 'toggles' },
        k === 'nssa' && toggle(ctx, () => !!ar.nssaDef, edit((w, v) => { if (v) w.nssaDef = true; else { delete w.nssaDef; delete w.nssaDefMetric; delete w.nssaDefType; } }), 'ABR 送一筆 Type-7 的預設路由進來（default-information-originate）：NSSA 預設沒有往外的預設路由'),
        toggle(ctx, () => !!ar.noRedist, edit((w, v) => { if (v) w.noRedist = true; else delete w.noRedist; }), '這台是 ABR 又重分配時，不把重分配的路送進這個 NSSA（no-redistribution）')));
    }
  }
  kids.push(note('muted', {
    normal: '一般區域：收得到區域間 (O IA) 與外部 (O E1 / E2) 的路由。',
    stub: 'stub：ABR 不送外部路由 (Type-5) 進來，改送一筆 O*IA 的預設路由；區域裡不能重分配。',
    tstub: 'totally stubby：連區域間的路也不送，只剩一筆預設路由。no-summary 只要設在 ABR 上；區域裡其他的路由器設 stub 就好。',
    nssa: 'NSSA：外面的 Type-5 一樣進不來，但區域裡的路由器可以重分配（Type-7，顯示成 O N2），ABR 再轉成 Type-5 送進骨幹。',
    tnssa: 'totally NSSA：NSSA 加上不收區域間的路，ABR 改送一筆 O*IA 的預設路由。',
  }[k] + ' 同一個區域裡每一台路由器的種類都要一樣，不然鄰居關係建立不起來。'));
  return h('div', { class: 'sub' }, kids);
}

export function ospfCard(ctx) {
  const { dev } = ctx;
  const draft = (ctx.app.ospfDraft ||= {});
  const procs = [['', 'router ospf 1（全域的路由表）'], ...Object.entries(dev.ospfVrf || {}).map(([v, c]) => [v, `router ospf ${c.pid} vrf ${v}`])];
  let vrf = ctx.app.ospfProc || '';
  if (!procs.some(([v]) => v === vrf)) vrf = ctx.app.ospfProc = '';
  const c = ospfProc(dev, vrf) || dev;
  const k = ospfKeys(vrf);
  const rt = () => dev.rt[k.key];
  const rangeDraft = (ctx.app.rangeDraft ||= {});
  const freeVrfs = Object.keys(dev.vrfs || {}).filter((v) => !(dev.ospfVrf || {})[v]);
  const areas = areasOf(dev, vrf, c);
  return h('div', { class: 'card' }, cardHead('OSPF'),
    (procs.length > 1 || freeVrfs.length) && grid2(
      field('程序', sel(ctx, () => vrf, (v) => { ctx.app.ospfProc = v; }, procs, { rerender: true }), vrf ? `只涵蓋 VRF ${vrf} 的介面，學到的路裝進 VRF ${vrf} 的路由表` : 'VRF 裡的介面不會被全域的程序涵蓋'),
      freeVrfs.length ? field('在 VRF 裡跑 OSPF', h('div', { class: 'addrow tight' },
        sel({ commit() {} }, () => draft.vrf || freeVrfs[0], (v) => { draft.vrf = v; }, freeVrfs.map((v) => [v, v])),
        inp({ commit() {} }, ...bind(draft, 'pid'), { ph: '程序編號', w: '6em', check: isNum(2, 65535) }),
        button('建立', { small: true, onclick: () => {
          const v = freeVrfs.includes(draft.vrf) ? draft.vrf : freeVrfs[0];
          const used = new Set([1, ...Object.values(dev.ospfVrf || {}).map((x) => +x.pid)]);
          let pid = +draft.pid;
          if (draft.pid && (!(pid >= 2 && pid <= 65535) || used.has(pid))) return toast('程序編號要是 2 – 65535，而且不能和其他程序重複（1 是全域的）', 'bad');
          if (!draft.pid) { pid = 2; while (used.has(pid)) pid++; }
          (dev.ospfVrf ||= {})[v] = { pid, ospfNets: [] };
          ctx.app.ospfProc = v; draft.pid = '';
          ctx.commit(true);
          return undefined;
        } })), '每個 VRF 要用自己的程序編號（router ospf <編號> vrf <名稱>）') : null),
    vrf && h('div', { class: 'addrow' }, h('span', { class: 'muted', text: `VRF ${vrf} 的 OSPF 程序：在「介面」分頁勾選 VRF ${vrf} 的介面啟用 OSPF` }),
      button('刪除這個程序', { small: true, onclick: () => {
        for (const i of dev.ifaces) if (i.vrf === vrf) { i.ospf = false; delete i.ospfArea; }
        delete dev.ospfVrf[vrf];
        if (!Object.keys(dev.ospfVrf).length) delete dev.ospfVrf;
        ctx.app.ospfProc = '';
        ctx.commit(true);
      } })),
    grid2(
      field('Router ID', inp(ctx, ...bind(c, 'ospfRid'), { ph: vrf ? `留空＝VRF ${vrf} 裡最大的 Loopback，再來是最大的介面 IP` : '留空＝最大的 Loopback，再來是最大的介面 IP', check: isIp })),
      field('參考頻寬 (Mbps)', inp(ctx, () => (c.ospfRefBw ? String(c.ospfRefBw) : ''), (v) => { if (+v > 0 && +v !== 100) c.ospfRefBw = +v; else delete c.ospfRefBw; }, { ph: '預設 100：1G 和 10G 的 cost 都是 1', check: isNum(1, 4294967) })),
      field('最多幾條等價路徑', inp(ctx, () => (c.ospfMaxPaths ? String(c.ospfMaxPaths) : ''), (v) => { if (+v > 0 && +v !== 4) c.ospfMaxPaths = +v; else delete c.ospfMaxPaths; }, { ph: '預設 4', check: isNum(1, 32) }))),
    ctx.live(() => {
      const o = rt();
      if (!o) return null;
      if (o.pending) return note('warn', `Router ID 改了，但 OSPF 程序還在用 ${fmtIp(o.rid)}：要 clear ip ospf process（CLI）才會換。`);
      if (o.rid == null) return null;
      const tr = (o.translates || []).length ? ` · 負責把 area ${o.translates.join('、')} 的 Type-7 轉成 Type-5` : '';
      return note('muted', `目前的 Router ID：${fmtIp(o.rid)}${o.abr ? ' · 這台是 ABR（連著骨幹與其他區域）' : ''}${o.asbr ? ' · 這台是 ASBR' : ''}${tr}`);
    }),
    h('div', { class: 'toggles' },
      toggle(ctx, () => !!c.ospfDefault, (v) => { c.ospfDefault = v; }, '向 OSPF 發布預設路由（default-information originate）'),
      toggle(ctx, () => !!c.ospfPassiveDefault, (v) => { if (v) { c.ospfPassiveDefault = true; c.ospfNoPassive = []; } else { delete c.ospfPassiveDefault; delete c.ospfNoPassive; } }, '所有介面預設都是被動的 (passive-interface default)，要建立鄰居的介面再個別取消')),
    h('div', { class: 'acl-h' }, h('span', { text: '區域的種類' }), h('em', { text: 'stub / NSSA：讓分支區域的路由表變小' })),
    areas.length ? areas.map((a) => areaRow(ctx, c, a)) : note('muted', '這個程序只有骨幹 (area 0)：骨幹不能設成 stub 或 NSSA。介面放進其他區域之後，這裡就可以設定它的種類。'),
    h('div', { class: 'acl-h' }, h('span', { text: '區域彙總 (area range)' }), h('em', { text: 'ABR 把某個區域的網段合併成一筆送進骨幹' })),
    (c.ospfRanges || []).map((r, n) => h('div', { class: 'line' }, h('b', { class: 'mono', text: `area ${r.area}` }), h('span', { class: 'mono', text: `${fmtIp(r.net)}/${r.bits}` }), del(() => { c.ospfRanges.splice(n, 1); ctx.commit(true); }))),
    h('div', { class: 'addrow' },
      inp({ commit() {} }, ...bind(rangeDraft, 'area'), { ph: '區域', w: '5em', check: isNum(1, 4294967295) }),
      inp({ commit() {} }, ...bind(rangeDraft, 'cidr'), { ph: '例如 10.1.0.0/16', check: (v) => /^[\d.]+\/\d+$/.test(v) }),
      button('新增', { small: true, onclick: () => {
        const m = String(rangeDraft.cidr || '').match(/^([\d.]+)\/(\d+)$/), ip = m && parseIp(m[1]);
        if (!(+rangeDraft.area > 0) || ip == null || !(+m[2] <= 32)) return toast('區域請填非 0 的數字，網段寫成 10.1.0.0/16', 'bad');
        (c.ospfRanges ||= []).push({ area: +rangeDraft.area, net: (ip >>> (32 - +m[2])) << (32 - +m[2]) >>> 0, bits: +m[2] });
        rangeDraft.cidr = '';
        ctx.commit(true);
        return undefined;
      } })),
    h('p', { class: 'tip', text: 'OSPF 在各介面上個別啟用（或用 CLI 的 network 敘述）。有通往外部的預設路由的那一台勾選「發布預設路由」，其他 OSPF 路由器就會學到 O*E2 的預設路由。' }));
}

/** 狀態分頁的 OSPF 鄰居：每個程序都列出來 */
export function ospfNeighborRows(dev) {
  const out = [];
  for (const [vrf, label] of [['', ''], ...Object.entries(dev.ospfVrf || {}).map(([v, c]) => [v, `VRF ${v}（ospf ${c.pid}）`])]) {
    for (const n of dev.rt[ospfKeys(vrf).nkey] || []) out.push({ ...n, proc: label });
  }
  return out;
}
export { ospfAreaType };
