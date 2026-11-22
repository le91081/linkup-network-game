// 交換器的第二層安全：Port Security（最多幾個 MAC、違規動作、sticky）、Storm Control、Protected port、RA Guard、
// 靜態 MAC、MAC 位址表的使用量、Native VLAN 加標籤、Private VLAN。和 CLI 是同一份設定
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, del, cardHead, grid2, bind, badge, toggle, isNum, isMacList } from './form.js';
import { macRows, macsBehind, macAgeOf, clearMac } from '../engine/sim.js';
import { psMax, psMode, camSize, stormLimit } from '../engine/l2sec.js';
import { linkInfo } from '../engine/model.js';
import { isCat9300, isNexus } from '../engine/mtu.js';

const nameOf = (ctx, id) => (ctx.state.devices[id] || {}).name || id;
const macs = (s) => String(s || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
export const pvlanOk = (d) => isCat9300(d) || isNexus(d);

/** 連接埠進階設定裡的 Port Security */
export function psecBlock(ctx, p, pc) {
  const { dev, state } = ctx;
  const ps = pc.ps;
  if (!ps || !ps.on) return null;
  return h('div', { class: 'sub' },
    grid2(
      field('最多幾個 MAC (maximum)', inp(ctx, () => String(psMax(ps)), (v) => { if (+v > 1) ps.max = Math.min(8192, +v); else delete ps.max; }, { ph: '1', check: isNum(1, 8192) }), '接電話又接電腦的埠設 2'),
      field('違規時的動作', sel(ctx, () => psMode(ps), (v) => { ps.mode = v; }, [['shutdown', 'Shutdown — 整個埠關掉 (err-disabled，預設)'], ['restrict', 'Restrict — 丟掉違規的封包，記紀錄、計次數'], ['protect', 'Protect — 默默丟掉，不記紀錄']]))),
    h('div', { class: 'toggles' }, toggle(ctx, () => !!ps.sticky, (v) => { if (v) ps.sticky = true; else { delete ps.sticky; delete ps.stickyMacs; } }, 'Sticky：學到的 MAC 自動寫進 running-config（存檔之後重開機還記得）', { rerender: true })),
    field('固定允許的 MAC（靜態的安全位址）', h('div', { class: 'addrow' }, inp(ctx, ...bind(ps, 'macs'), { ph: '留空＝依序學到的前 N 個 MAC', check: isMacList }), button('帶入目前看到的', {
      small: true,
      onclick: () => { ps.macs = macsBehind(state, dev, p.id).map((m) => m.mac).slice(0, psMax(ps)).join(', '); ctx.commit(true); },
    })), '多個 MAC 用逗號分隔；沒有寫的話，交換器會把先看到的 MAC 學成安全位址'),
    ps.sticky && macs(ps.stickyMacs).length ? note('muted', 'Sticky 學到的：' + macs(ps.stickyMacs).join('、')) : null,
    ctx.live(() => {
      if (dev.rt.err[p.id] === true) return null; // 上面的 err-disabled 說明已經講了
      const r = (dev.rt.psec || {})[p.id], rec = (state.dyn.psec || {})[dev.id + ':' + p.id] || { viol: 0 };
      const seen = macsBehind(state, dev, p.id);
      if (!seen.length && !(r && r.bad.length)) return note('muted', '這個埠後面目前沒有看到任何設備。');
      const rows = seen.map((m) => {
        const ok = r ? r.allowed.has(m.mac) : macs(ps.macs).includes(m.mac);
        return h('div', { class: 'line' }, h('b', { text: nameOf(ctx, m.dev) }), h('span', { class: 'mono muted', text: m.mac }), badge(ok ? 'on' : 'warn', ok ? '安全位址' : '違規，擋下'));
      });
      if (r && r.bad.some((b) => b.flood)) rows.push(note('warn', `${nameOf(ctx, r.bad.find((b) => b.flood).dev)} 在狂送來源 MAC 都不一樣的訊框 (MAC flooding)：超過 maximum 的全部被丟掉，交換器的 MAC 位址表不會被塞滿。`));
      if (rec.viol) rows.push(note('muted', `違規次數 (Security Violation Count)：${rec.viol.toLocaleString('en')}`));
      return rows;
    }));
}

/** 連接埠進階設定：Storm Control、Protected、RA Guard */
export function portGuards(ctx, p, pc) {
  const { dev, state } = ctx;
  const pols = Object.keys(dev.sw.raPolicies || {});
  return h('div', { class: 'sub' },
    grid2(
      field('Storm Control：廣播上限（% 頻寬）', inp(ctx, () => (pc.storm && pc.storm.bcast != null ? String(pc.storm.bcast) : ''), (v) => {
        if (v === '' || !(+v >= 0 && +v <= 100)) { if (pc.storm) { delete pc.storm.bcast; if (!pc.storm.action) delete pc.storm; } return; }
        (pc.storm ||= {}).bcast = +(+v).toFixed(2);
      }, { ph: '不限制（例如 1.00）', check: (v) => /^\d+(\.\d+)?$/.test(v) && +v <= 100 }), '超過的廣播會被丟掉'),
      field('超過時', sel(ctx, () => (pc.storm && pc.storm.action) || '', (v) => { if (v) (pc.storm ||= {}).action = v; else if (pc.storm) { delete pc.storm.action; if (pc.storm.bcast == null) delete pc.storm; } },
        [['', '只丟掉超過的部分（預設）'], ['shutdown', '關掉這個埠 (err-disabled)'], ['trap', '丟掉並送 SNMP Trap']]))),
    ctx.live(() => {
      const st = (state.rt.storms || []).find((x) => x.lim && x.lim.dev === dev.id && x.lim.port === p.id);
      if (dev.rt.err[p.id] === 'storm') return null;
      if (st) return note('warn', `${nameOf(ctx, st.dev)} 正在狂送廣播（約 ${Math.round(st.rate)} Mbps），超過門檻的 ${Math.round(st.rate - st.lim.mbps)} Mbps 被丟掉了`);
      const li = linkInfo(state, dev.id, p.id), lim = pc.storm ? stormLimit(pc, (li && li.speed) || 1000) : null;
      return lim != null ? note('muted', `門檻約 ${lim >= 10 ? Math.round(lim) : lim.toFixed(1)} Mbps 的廣播`) : null;
    }),
    h('div', { class: 'toggles' },
      toggle(ctx, () => !!pc.protected, (v) => { if (v) pc.protected = true; else delete pc.protected; }, 'Protected port（switchport protected）：和這台的其他 protected 埠彼此不通，只能往上行走')),
    field('RA Guard（IPv6）', sel(ctx, () => pc.raGuard || '', (v) => { if (v) pc.raGuard = v; else delete pc.raGuard; }, [['', '不檢查'], ...pols.map((n) => [n, `${n}（device-role ${dev.sw.raPolicies[n].role}）`])]),
      pols.length ? 'device-role host：從這個埠進來的 Router Advertisement 一律丟掉' : '先在「安全」分頁建立 RA Guard 政策'));
}

/** Private VLAN 的連接埠模式（Catalyst 9300、Nexus） */
export function pvlanPortBlock(ctx, p, pc) {
  const { dev } = ctx;
  if (!pvlanOk(dev) || !dev.sw.vlans.some((v) => v.pvlan)) return null;
  const pri = dev.sw.vlans.filter((v) => v.pvlan === 'primary');
  const sec = dev.sw.vlans.filter((v) => v.pvlan === 'isolated' || v.pvlan === 'community');
  const mode = pc.mode === 'pvlan-host' ? 'host' : pc.mode === 'pvlan-promisc' ? 'promisc' : '';
  return h('div', { class: 'sub' },
    field('Private VLAN', sel(ctx, () => mode, (v) => {
      if (v === 'host') { pc.mode = 'pvlan-host'; pc.pvHost ||= { primary: (pri[0] || {}).id, secondary: (sec[0] || {}).id }; }
      else if (v === 'promisc') { pc.mode = 'pvlan-promisc'; pc.pvMap ||= { primary: (pri[0] || {}).id, secondaries: (pri[0] || {}).assoc || [] }; }
      else { if (/^pvlan/.test(pc.mode)) pc.mode = 'access'; delete pc.pvHost; delete pc.pvMap; }
    }, [['', '不使用'], ['host', 'host（接一般設備）'], ['promisc', 'promiscuous（接閘道、共用伺服器）']], { rerender: true }),
    'isolated 的 host 埠彼此不通；community 的同一組可以互通；promiscuous 誰都通'),
    mode === 'host' && grid2(
      field('primary VLAN', sel(ctx, () => String((pc.pvHost || {}).primary || ''), (v) => { pc.pvHost = { ...(pc.pvHost || {}), primary: +v }; }, pri.map((v) => [v.id, `${v.id} ${v.name}`]))),
      field('secondary VLAN', sel(ctx, () => String((pc.pvHost || {}).secondary || ''), (v) => { pc.pvHost = { ...(pc.pvHost || {}), secondary: +v }; }, sec.map((v) => [v.id, `${v.id} ${v.name}（${v.pvlan}）`])))),
    mode === 'promisc' && grid2(
      field('primary VLAN', sel(ctx, () => String((pc.pvMap || {}).primary || ''), (v) => { const p0 = pri.find((x) => x.id === +v); pc.pvMap = { primary: +v, secondaries: (p0 && p0.assoc) || [] }; }, pri.map((v) => [v.id, `${v.id} ${v.name}`])), '對應這個 primary 底下所有的 secondary')));
}

/** 「安全」分頁：MAC 位址表、靜態 MAC、Native VLAN 加標籤、RA Guard 政策 */
export function l2secCards(ctx, body) {
  const { dev, state } = ctx;
  const sw = dev.sw;
  const draft = (ctx.app.l2Draft ||= {});
  body.append(h('div', { class: 'card' }, cardHead('MAC 位址表'),
    ctx.live(() => {
      const rows = macRows(state, dev), bg = rows.bogus, used = rows.length + (bg ? bg.n : 0), cap = camSize(dev);
      return [note(bg ? 'warn' : 'muted', `已使用 ${used.toLocaleString('en')} / ${cap.toLocaleString('en')} 筆`),
        bg && note('warn', `表滿了：${bg.label} 學到了 ${bg.n.toLocaleString('en')} 個亂造的 MAC（有人在跑 macof 之類的 MAC flooding 工具）。新的 MAC 學不進來，目的地不在表裡的訊框會往整個 VLAN 泛洪，攻擊者因此收到別人的流量。在那個埠開 Port Security 限制 MAC 的數量；亂造的項目要等 ${macAgeOf(dev)} 秒老化，或按下面的按鈕清掉。`),
        bg && h('div', { class: 'addrow' }, button('清除動態學到的項目', { small: true, title: 'clear mac address-table dynamic', onclick: () => { clearMac(state, dev); toast('已清除動態學到的 MAC', 'ok'); ctx.commit(true); } }))];
    }),
    h('div', { class: 'acl-h' }, h('span', { text: '靜態 MAC' }), h('em', { text: '固定在某個埠，不會老化、也不會被偽造的 MAC 搬走' })),
    (sw.staticMacs || []).map((e, n) => h('div', { class: 'line' }, h('b', { class: 'mono', text: e.mac }), h('span', { class: 'muted', text: `VLAN ${e.vlan} → ${e.drop ? '丟棄 (drop)' : e.port}` }), del(() => { sw.staticMacs.splice(n, 1); if (!sw.staticMacs.length) delete sw.staticMacs; ctx.commit(true); }))),
    h('div', { class: 'addrow' },
      inp({ commit() {} }, ...bind(draft, 'mac'), { ph: 'MAC，例如 02:1a:2b:3c:4d:5e', check: isMacList }),
      inp({ commit() {} }, ...bind(draft, 'vlan'), { ph: 'VLAN', w: '4.5em', check: isNum(1, 4094) }),
      sel({ commit() {} }, () => draft.port || dev.ports[0].id, (v) => { draft.port = v; }, [...dev.ports.map((p) => [p.id, p.label]), ['@drop', '丟棄 (drop)']]),
      button('新增', { small: true, onclick: () => {
        const m = String(draft.mac || '').toLowerCase().replace(/[.-]/g, ':');
        const hex = m.replace(/:/g, '');
        if (!/^[0-9a-f]{12}$/.test(hex)) return toast('MAC 的格式：02:1a:2b:3c:4d:5e', 'bad');
        const v = +(draft.vlan || 1);
        if (!sw.vlans.some((x) => x.id === v)) return toast(`VLAN ${v} 不存在`, 'bad');
        const mac = hex.match(/../g).join(':'), port = draft.port || dev.ports[0].id;
        sw.staticMacs = [...(sw.staticMacs || []).filter((x) => !(x.mac === mac && +x.vlan === v)), port === '@drop' ? { mac, vlan: v, drop: true } : { mac, vlan: v, port }];
        draft.mac = '';
        ctx.commit(true);
        return undefined;
      } }))));
  const pols = Object.entries(sw.raPolicies || {});
  body.append(h('div', { class: 'card' }, cardHead('Trunk 與 IPv6 的第一跳防護'),
    h('div', { class: 'toggles' }, toggle(ctx, () => !!sw.tagNative, (v) => { if (v) sw.tagNative = true; else delete sw.tagNative; }, 'Native VLAN 也加標籤（vlan dot1q tag native）：防雙重標籤攻擊')),
    note('muted', '雙重標籤 (double tagging)：攻擊者在 Native VLAN 的埠送出兩層標籤，第一台交換器拿掉外層、從 Trunk 不加標籤送出去，對面看到的是裡面那層，訊框就跳到別的 VLAN。把 Trunk 的 Native VLAN 改成沒人用的 VLAN，或打開這個選項。'),
    h('div', { class: 'acl-h' }, h('span', { text: 'RA Guard 政策' }), h('em', { text: '擋掉冒牌路由器送的 IPv6 Router Advertisement' })),
    pols.map(([n, p]) => h('div', { class: 'line' }, h('b', { class: 'mono', text: n }),
      sel(ctx, () => p.role || 'host', (v) => { p.role = v; }, [['host', 'device-role host（接電腦的埠：RA 一律丟掉）'], ['router', 'device-role router（接路由器的埠）']]),
      del(() => { delete sw.raPolicies[n]; for (const pc of Object.values(sw.ports)) if (pc.raGuard === n) delete pc.raGuard; if (!Object.keys(sw.raPolicies).length) delete sw.raPolicies; ctx.commit(true); }))),
    h('div', { class: 'addrow' },
      inp({ commit() {} }, ...bind(draft, 'ra'), { ph: '政策名稱，例如 HOSTS', mono: true }),
      button('新增政策', { small: true, onclick: () => {
        const n = String(draft.ra || '').trim();
        if (!/^[\w-]{1,32}$/.test(n)) return toast('名稱只能用英文、數字、- 與 _', 'bad');
        (sw.raPolicies ||= {})[n] ||= { role: 'host' };
        draft.ra = '';
        ctx.commit(true);
        return undefined;
      } }),
      button('套用到接電腦的埠', { small: true, title: '把第一個 device-role host 的政策掛到所有 Access 埠', onclick: () => {
        const n = Object.keys(sw.raPolicies || {}).find((k) => sw.raPolicies[k].role === 'host');
        if (!n) return toast('先建立一個 device-role host 的政策', 'bad');
        let k = 0;
        for (const [pid, pc] of Object.entries(sw.ports)) if (pc.mode === 'access' || /^dynamic/.test(pc.mode) || pc.mode === 'pvlan-host') { if (pc.mode !== 'trunk') { pc.raGuard = n; k++; } void pid; }
        toast(`${k} 個埠套用了 ${n}`, 'ok');
        ctx.commit(true);
        return undefined;
      } }))));
}

/** VLAN 分頁：Private VLAN 的種類與關聯（Catalyst 9300、Nexus） */
export function pvlanField(ctx, v) {
  const { dev } = ctx;
  if (!pvlanOk(dev) || v.id === 1) return null;
  const secs = dev.sw.vlans.filter((x) => x.pvlan === 'isolated' || x.pvlan === 'community');
  return h('div', { class: 'addrow tight' },
    sel(ctx, () => v.pvlan || '', (t) => { if (t) v.pvlan = t; else delete v.pvlan; if (t !== 'primary') delete v.assoc; }, [['', '一般 VLAN'], ['primary', 'Private VLAN：primary'], ['isolated', 'secondary：isolated（彼此不通）'], ['community', 'secondary：community（同組互通）']], { rerender: true }),
    v.pvlan === 'primary' && inp(ctx, () => (v.assoc || []).join(','), (t) => { const l = String(t).split(/[,\s]+/).filter(Boolean).map(Number).filter((x) => secs.some((y) => y.id === x)); if (l.length) v.assoc = l; else delete v.assoc; }, { ph: `關聯的 secondary（${secs.map((x) => x.id).join(',') || '先建立 isolated / community'}）`, w: '12em' }));
}
