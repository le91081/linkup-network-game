// IPv6 的設定頁面：介面（位址、RA 的 M / O / A 旗標、DHCPv6、OSPFv3、ACL）、路由（靜態路由、OSPFv3）、DHCPv6 位址池、IPv6 ACL。
// 和 CLI 改的是同一份設定。
import { h, button, toast } from './dom.js';
import { inp, sel, toggle, seg, field, note, kv, del, cardHead, grid2, bind, isIp6, isCidr6, isNum, badge } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { fmtIp6, parseIp6, parseCidr6, isLinkLocal } from '../engine/ip6.js';
import { route6Rows, mode6, hits6Of, ACL6_IMPLICIT, acl6Line, ICMP6_TYPES, duidOf } from '../engine/sim6.js';

const isLl = (v) => isIp6(v) && isLinkLocal(parseIp6(v));
/** ACL 的位址：any、host <位址>、<前綴>/<長度> */
const isAddr6 = (v) => { const s = v.trim().toLowerCase(); return s === 'any' || (s.startsWith('host ') && isIp6(s.slice(5).trim())) || isCidr6(s); };
const SRC_NAME = { static: '全域位址', slaac: '全域位址 (SLAAC)', dhcp6: '全域位址 (DHCPv6)' };

/** 介面目前的 IPv6 狀態：位址從哪來、收到的 RA、DHCPv6 */
function v6Status(ctx, i) {
  return ctx.live(() => {
    const v = i.rt.v6;
    if (!v) return null;
    if (v.ll == null) return mode6(ctx.dev, i) === 'off' ? null : note('muted', '介面沒有連線，IPv6 尚未啟用。');
    const st = ctx.state, r = v.ra;
    const dh = v.dhcp;
    return [h('div', { class: 'kv ' + (v.addrs.length ? 'ok' : '') },
      v.addrs.map((a) => kv(SRC_NAME[a.src] || '全域位址', `${fmtIp6(a.ip)}/${a.bits}`)),
      kv('Link-local', fmtIp6(v.ll)),
      v.gw != null && kv('預設閘道', fmtIp6(v.gw) + (r ? '（來自 RA）' : '')),
      v.dns.length > 0 && kv('IPv6 DNS', v.dns.map(fmtIp6).join('、')),
      r && kv('收到的 RA', `${st.devices[r.dev].name} · M=${r.M ? 1 : 0} O=${r.O ? 1 : 0} A=${r.A ? 1 : 0}`),
      dh && dh.ok && kv('DHCPv6', `${dh.stateful ? 'stateful（位址 + DNS）' : 'stateless（只拿 DNS）'} · ${st.devices[dh.server].name}${dh.relay ? ' 經 ' + st.devices[dh.relay].name + ' 轉送' : ''}`),
      v.note && kv('狀態', v.note)),
    dh && !dh.ok && note('warn', 'DHCPv6：' + dh.why)];
  });
}

/** 終端設備的 IPv6 設定 */
export function hostV6(ctx, i) {
  if (!ctx.state.v6) return null;
  const m = mode6(ctx.dev, i);
  return h('div', { class: 'sub' }, h('span', { class: 'f-label', text: 'IPv6' }),
    seg(ctx, () => m, (v) => { i.mode6 = v; }, [['auto', '自動取得'], ['static', '手動'], ['off', '關閉']]),
    m === 'auto' && h('span', { class: 'f-hint', text: '依路由器 RA 的旗標：A → SLAAC 自己產生位址、M → 向 DHCPv6 要位址、O → 向 DHCPv6 要 DNS' }),
    m === 'static' && grid2(
      field('IPv6 位址 / 前綴', inp(ctx, ...bind(i, 'ip6'), { ph: '2001:db8:a::10/64', check: isCidr6 })),
      field('IPv6 預設閘道', inp(ctx, ...bind(i, 'gw6'), { ph: '2001:db8:a::1 或路由器的 fe80::', check: isIp6 }))),
    v6Status(ctx, i));
}

/** 路由器介面的 IPv6 設定 */
export function routerV6(ctx, i) {
  const d = ctx.dev;
  const pools = Object.keys(d.dhcp6Pools || {}), acls = Object.keys(d.acl6 || {});
  const role = i.dhcp6 != null ? 'server' : i.relay6 != null ? 'relay' : '';
  const flag = (k, label, inv) => toggle(ctx, () => (inv ? !i[k] : !!i[k]), (v) => { if (inv ? !v : v) i[k] = true; else delete i[k]; }, label);
  return h('div', { class: 'sub' }, h('span', { class: 'f-label', text: 'IPv6' }),
    grid2(
      field('IPv6 位址 / 前綴', inp(ctx, ...bind(i, 'ip6'), { ph: '例如 2001:db8:a::1/64', check: isCidr6 })),
      field('Link-local', inp(ctx, () => i.ll6 || '', (v) => { if (v) i.ll6 = v; else delete i.ll6; }, { ph: '自動 (EUI-64)，或手動 fe80::1', check: isLl }))),
    h('div', { class: 'toggles' },
      toggle(ctx, ...bind(i, 'ra'), '發送 Router Advertisement（主機從這裡知道網段前綴與預設閘道）', { rerender: true }),
      i.ra && flag('raNoAuto', 'A 旗標：主機可以用 SLAAC 自己產生位址', true),
      i.ra && flag('raM', 'M 旗標：位址向 DHCPv6 要（stateful · managed-config-flag）'),
      i.ra && flag('raO', 'O 旗標：DNS 等其他設定向 DHCPv6 要（other-config-flag）')),
    grid2(
      field('DHCPv6', sel(ctx, () => role, (v) => { delete i.dhcp6; delete i.relay6; if (v === 'server') i.dhcp6 = pools[0] || ''; if (v === 'relay') i.relay6 = ''; }, [['', '不使用'], ['server', '這台當伺服器'], ['relay', '轉送給別台 (relay)']], { rerender: true })),
      role === 'server' ? field('位址池', pools.length ? sel(ctx, () => i.dhcp6, (v) => { i.dhcp6 = v; }, pools.map((p) => [p, p])) : note('warn', '還沒有位址池：在這一頁最下方的「DHCPv6 位址池」新增'))
        : role === 'relay' ? field('轉送到（伺服器的 IPv6 位址）', inp(ctx, () => i.relay6 || '', (v) => { i.relay6 = v; }, { ph: '例如 2001:db8:f::1', check: isIp6 })) : null),
    d.v6routing && grid2(
      field('OSPFv3 區域', inp(ctx, () => (i.ospf6Area ?? '') + '', (v) => { if (v === '') delete i.ospf6Area; else if (/^\d+$/.test(v)) { i.ospf6Area = +v; d.ospf6 ||= {}; } }, { ph: '留空＝不跑 OSPFv3', check: isNum(0, 4294967295), rerender: true })),
      i.ospf6Area != null && field('OSPFv3 cost', inp(ctx, () => (i.ospf6Cost ? String(i.ospf6Cost) : ''), (v) => { if (+v > 0) i.ospf6Cost = +v; else delete i.ospf6Cost; }, { ph: '自動（參考頻寬 ÷ 介面頻寬）', check: isNum(1, 65535) })),
      i.ospf6Area != null && field('OSPFv3 priority', inp(ctx, () => (i.ospf6Prio != null ? String(i.ospf6Prio) : ''), (v) => { if (v === '' || +v === 1) delete i.ospf6Prio; else if (/^\d+$/.test(v)) i.ospf6Prio = +v; }, { ph: '預設 1；0 表示不當 DR / BDR', check: isNum(0, 255) })),
      i.ospf6Area != null && field('OSPFv3 網路類型', sel(ctx, () => i.ospf6Net || '', (v) => { if (v) i.ospf6Net = v; else delete i.ospf6Net; }, [['', 'broadcast（選 DR / BDR）'], ['p2p', 'point-to-point']]))),
    acls.length > 0 && grid2(
      field('IPv6 ACL：進入 (in)', sel(ctx, () => i.acl6In || '', (v) => { if (v) i.acl6In = v; else delete i.acl6In; }, [['', '不套用'], ...acls.map((a) => [a, a])])),
      field('IPv6 ACL：離開 (out)', sel(ctx, () => i.acl6Out || '', (v) => { if (v) i.acl6Out = v; else delete i.acl6Out; }, [['', '不套用'], ...acls.map((a) => [a, a])]))),
    ctx.live(() => {
      if (i.ospf6Area == null || !d.v6routing) return null;
      const o = d.rt.ospf6;
      if (o && o.norid) return note('warn', 'OSPFv3 起不來：選不出 Router ID。OSPFv3 的 Router ID 還是 32 位元的 IPv4 格式，這台路由器沒有任何 IPv4 位址，要在「路由」分頁的 OSPFv3 手動設定。');
      const f = o && o.ifs[i.id];
      if (!f) return note('muted', '介面沒有連線，OSPFv3 還沒有在這個介面上執行。');
      const nb = (d.rt.nbrs6 || []).filter((x) => x.iface === i.id);
      const full = nb.filter((x) => x.state === 'full' || x.state === '2way').length;
      return note(f.why.length ? 'warn' : 'muted', `OSPFv3 狀態：${f.state} · cost ${f.cost} · 鄰居 ${full}/${nb.length}${f.why.length ? '；' + f.why.join('；') : ''}`);
    }),
    v6Status(ctx, i));
}

/** 路由分頁：IPv6 路由開關、靜態路由、路由表，以及 OSPFv3 */
export function v6Routes(ctx, body) {
  const { dev } = ctx;
  const list = (dev.routes6 ||= []);
  const card = h('div', { class: 'card' }, cardHead('IPv6'),
    h('div', { class: 'toggles' }, toggle(ctx, ...bind(dev, 'v6routing'), 'IPv6 路由（ipv6 unicast-routing）', { rerender: true })),
    ctx.live(() => (dev.v6routing ? null : note('warn', '尚未啟用：這台路由器不會轉送 IPv6 封包，也不會送出 Router Advertisement。'))));
  if (list.length) card.append(h('div', { class: 'thead c-r6' }, h('span', { text: '目的前綴' }), h('span', { text: '下一站' }), h('span', { text: 'AD' }), h('span')));
  list.forEach((r, n) => card.append(h('div', { class: 'trow c-r6' },
    inp(ctx, ...bind(r, 'dst'), { ph: '2001:db8:2::/64 或 ::/0', check: isCidr6 }),
    inp(ctx, ...bind(r, 'via'), { ph: '2001:db8:12::2', check: isIp6 }),
    inp(ctx, () => (r.ad ? String(r.ad) : ''), (v) => { if (+v > 1) r.ad = +v; else delete r.ad; }, { ph: '1', check: isNum(1, 254) }),
    del(() => { list.splice(n, 1); ctx.commit(true); }))));
  card.append(h('div', { class: 'addrow' }, button('新增 IPv6 靜態路由', { ic: 'plus', small: true, onclick: () => { list.push({ dst: '', via: '' }); ctx.commit(true); } })),
    ctx.live(() => {
      const rows = route6Rows(dev);
      if (!rows.length) return note('muted', 'IPv6 路由表是空的。');
      return h('div', { class: 'rtable' }, rows.map((r) => h('div', { class: 'rrow t-' + r.type + (r.bad ? ' bad' : '') },
        h('span', { class: 'tag', text: r.typeName + (r.sub ? ' ' + r.sub : '') }), h('b', { class: 'mono', text: r.dst }), h('span', { class: 'mono', text: '→ ' + r.via }),
        h('span', { class: 'mono muted', text: r.iface }), r.bad && h('em', { text: '無效：' + r.bad }))));
    }));
  body.append(card);
  if (dev.v6routing) body.append(ospf6Card(ctx));
}

function ospf6Card(ctx) {
  const { dev, state } = ctx;
  if (!dev.ospf6) {
    return h('div', { class: 'card' }, cardHead('OSPFv3'),
      note('muted', 'IPv6 的 OSPF。和 OSPFv2 一樣選 DR、算 SPF，但鄰居用 link-local 位址互相認識，路由的下一站也是對方的 link-local。直接在介面上指定區域（ipv6 ospf 1 area 0），沒有 network 敘述。'),
      h('div', { class: 'addrow' }, button('啟用 OSPFv3（ipv6 router ospf 1）', { small: true, onclick: () => { dev.ospf6 = {}; ctx.commit(true); } })));
  }
  const c = dev.ospf6;
  return h('div', { class: 'card' }, cardHead('OSPFv3', button('停用', { small: true, onclick: () => { delete dev.ospf6; for (const i of dev.ifaces) delete i.ospf6Area; ctx.commit(true); } })),
    grid2(field('Router ID', inp(ctx, () => c.rid || '', (v) => { if (v) c.rid = v; else delete c.rid; }, { ph: '留空＝最大的 IPv4 Loopback / 介面位址', check: (v) => /^\d+\.\d+\.\d+\.\d+$/.test(v) }))),
    h('div', { class: 'toggles' },
      toggle(ctx, () => !!c.default, (v) => { if (v) c.default = true; else delete c.default; }, '向 OSPFv3 發布預設路由（default-information originate；自己要先有 ::/0）'),
      toggle(ctx, () => !!c.passiveDefault, (v) => { if (v) { c.passiveDefault = true; c.noPassive = []; } else { delete c.passiveDefault; delete c.noPassive; } }, '所有介面預設都是被動的 (passive-interface default)')),
    ctx.live(() => {
      const o = dev.rt.ospf6;
      if (!o) return note('muted', '還沒有任何介面加入 OSPFv3：到「介面」分頁填 OSPFv3 區域。');
      if (o.norid) return note('warn', '%OSPFv3-4-NORTRID：選不出 Router ID。OSPFv3 的 Router ID 是 32 位元的 IPv4 格式，這台路由器沒有任何 IPv4 位址，請在上方手動設定（例如 1.1.1.1）。');
      const nb = dev.rt.nbrs6 || [];
      const ST = { full: 'FULL', '2way': '2WAY', exstart: 'EXSTART', forming: '建立中', dying: 'FULL（等 Dead timer）' };
      return [h('div', { class: 'kv ok' }, kv('目前的 Router ID', fmtIp(o.rid)), o.abr && kv('角色', 'ABR（區域邊界路由器）')),
        o.pending && note('warn', '設定了新的 Router ID，要 clear ipv6 ospf process（或重新開機）才會換。'),
        nb.length ? h('div', { class: 'rtable' }, nb.map((x) => h('div', { class: 'rrow t-O' },
          h('span', { class: 'tag', text: ST[x.state] || x.state }), h('b', { class: 'mono', text: fmtIp(x.rid) }),
          h('span', { class: 'mono', text: `${state.devices[x.dev].name} · ${x.role === 'P2P' ? 'P2P' : x.role || ''}` }),
          h('span', { class: 'mono muted', text: `${fmtIp6(x.ip)} · ${(dev.ifaces.find((i) => i.id === x.iface) || {}).label}` }), x.note && h('em', { text: x.note }))))
          : note('muted', '還沒有 OSPFv3 鄰居。')];
    }));
}

/** 介面分頁最下方：DHCPv6 位址池 */
export function dhcp6PoolsCard(ctx) {
  const { dev, state } = ctx;
  if (!state.v6 || dev.kind !== 'router') return null;
  const pools = (dev.dhcp6Pools ||= {});
  const draft = (ctx.app.dhcp6Draft ||= {});
  const card = h('div', { class: 'card' }, cardHead('DHCPv6 位址池'),
    note('muted', '有 address prefix 的位址池可以發位址（stateful，RA 要設 M 旗標）；只有 DNS 的位址池給 stateless 用（RA 設 O 旗標，位址由主機用 SLAAC 自己產生）。不管哪一種，預設閘道都來自 RA，DHCPv6 不提供閘道。'));
  for (const [name, p] of Object.entries(pools)) {
    const used = Object.values((state.dyn && state.dyn.lease6 && state.dyn.lease6[dev.id]) || {}).filter((b) => b.pool === name).length;
    const users = dev.ifaces.filter((i) => i.dhcp6 === name).map((i) => i.label);
    card.append(h('div', { class: 'qos-pm' },
      h('div', { class: 'line' }, h('b', { class: 'mono', text: name }), h('span', { class: 'muted', text: users.length ? '用在 ' + users.join('、') : '還沒有介面使用' }),
        h('span', { style: { marginLeft: 'auto' } }, used ? badge('on', `${used} 個 binding`) : null),
        del(() => { delete pools[name]; for (const i of dev.ifaces) if (i.dhcp6 === name) delete i.dhcp6; ctx.commit(true); })),
      grid2(
        field('位址前綴 (address prefix)', inp(ctx, ...bind(p, 'prefix'), { ph: '留空＝只提供 DNS (stateless)', check: (v) => isCidr6(v) && parseCidr6(v).bits <= 64 })),
        field('DNS 伺服器', inp(ctx, () => (p.dns || []).join(', '), (v) => { p.dns = v.split(/[,\s]+/).filter(Boolean); }, { ph: '例如 2001:db8:f::53', check: (v) => v.split(/[,\s]+/).filter(Boolean).every(isIp6) })),
        field('網域名稱', inp(ctx, ...bind(p, 'domain'), { ph: '例如 corp.example', mono: false })))));
  }
  card.append(h('div', { class: 'addrow' }, inp({ commit() {} }, ...bind(draft, 'name'), { ph: '位址池名稱，例如 LAN-A', mono: false }),
    button('新增位址池', { ic: 'plus', small: true, onclick: () => {
      const n = String(draft.name || '').trim();
      if (!/^[\w-]+$/.test(n)) return toast('位址池名稱只能用英文、數字、- 與 _', 'bad');
      if (pools[n]) return toast('已經有這個位址池', 'bad');
      pools[n] = { prefix: '', dns: [], domain: '' };
      draft.name = '';
      ctx.commit(true);
    } })));
  return card;
}

/** ACL 分頁的 IPv6 部分 */
export function acl6Cards(ctx, body) {
  const { dev, state } = ctx;
  if (!state.v6 || dev.kind !== 'router') return;
  const all = (dev.acl6 ||= {});
  const draft = (ctx.app.acl6Draft ||= {});
  body.append(h('p', { class: 'tip', text: 'IPv6 ACL 是另外一套：IPv4 的 ACL 完全管不到 IPv6 的流量。每份 IPv6 ACL 結尾都隱含三條規則：允許鄰居探索的 NA 與 NS，然後拒絕全部。自己在最後加了 deny ipv6 any any，隱含的 ND 允許規則就輪不到了，整個網段的 IPv6 都會斷。' }));
  for (const [name, list] of Object.entries(all)) {
    const where = dev.ifaces.flatMap((i) => [i.acl6In === name && `${i.label} 進`, i.acl6Out === name && `${i.label} 出`].filter(Boolean));
    const card = h('div', { class: 'card' }, cardHead(`IPv6 ACL · ${name}`, h('span', { class: 'muted', text: where.length ? '套用在 ' + where.join('、') : '還沒有套用到介面' }),
      del(() => { delete all[name]; for (const i of dev.ifaces) { if (i.acl6In === name) delete i.acl6In; if (i.acl6Out === name) delete i.acl6Out; } ctx.commit(true); })));
    const sorted = list.slice().sort((a, b) => a.seq - b.seq);
    sorted.forEach((r, n) => {
      card.append(h('div', { class: 'acl-row ' + r.action },
        h('div', { class: 'acl-l1' }, h('span', { class: 'pno', text: r.seq }),
          sel(ctx, ...bind(r, 'action'), [['permit', '允許 permit'], ['deny', '拒絕 deny']], { rerender: true }),
          sel(ctx, () => r.proto || 'ipv6', (v) => { r.proto = v; if (v !== 'icmp') delete r.icmp; if (v !== 'tcp' && v !== 'udp') delete r.port; }, [['ipv6', 'ipv6（全部）'], ['tcp', 'tcp'], ['udp', 'udp'], ['icmp', 'icmp']], { rerender: true }),
          r.proto === 'icmp' ? sel(ctx, () => r.icmp || '', (v) => { if (v) r.icmp = v; else delete r.icmp; }, [['', '全部類型'], ...ICMP6_TYPES.map((t) => [t, t])])
            : (r.proto === 'tcp' || r.proto === 'udp') ? inp(ctx, () => r.port || '', (v) => { if (v) r.port = v; else delete r.port; }, { ph: '目的埠', check: (v) => /^\d+$/.test(v) && +v <= 65535, w: '72px' }) : null,
          h('button', { class: 'mini', type: 'button', title: '上移', disabled: n === 0, onclick: () => { const a = sorted[n - 1]; [a.seq, r.seq] = [r.seq, a.seq]; ctx.commit(true); } }, '↑'),
          del(() => { list.splice(list.indexOf(r), 1); ctx.commit(true); })),
        h('div', { class: 'acl-l2' },
          inp(ctx, ...bind(r, 'src'), { ph: '來源：any、host 2001:db8::5、2001:db8:a::/64', check: isAddr6 }), h('span', { text: '→' }),
          inp(ctx, ...bind(r, 'dst'), { ph: '目的', check: isAddr6 }),
          ctx.live(() => h('span', { class: 'hits' + (hits6Of(r) ? ' hot' : ''), title: '這條規則被比對命中的次數（執行測試或 ping 之後會增加）', text: `命中 ${hits6Of(r)}` })))));
    });
    card.append(...ACL6_IMPLICIT.map((r) => h('div', { class: 'acl-deny', text: '（隱含）' + acl6Line(r) })),
      h('div', { class: 'addrow' }, button('新增規則', { ic: 'plus', small: true, onclick: () => {
        list.push({ seq: (list.reduce((m, x) => Math.max(m, x.seq), 0) || 0) + 10, action: 'permit', proto: 'ipv6', src: 'any', dst: 'any' });
        ctx.commit(true);
      } }), button('加上 ND 的允許規則', { small: true, title: '在最前面加 permit icmp any any nd-ns / nd-na', onclick: () => {
        const min = list.reduce((m, x) => Math.min(m, x.seq), 10);
        for (const [k, t] of [[2, 'nd-na'], [1, 'nd-ns']]) if (!list.some((x) => x.proto === 'icmp' && x.icmp === t && x.action === 'permit')) list.push({ seq: Math.max(1, min - k), action: 'permit', proto: 'icmp', src: 'any', dst: 'any', icmp: t });
        ctx.commit(true);
      } })));
    body.append(card);
  }
  body.append(h('div', { class: 'card' }, cardHead('新增 IPv6 ACL'),
    h('div', { class: 'addrow' }, inp({ commit() {} }, ...bind(draft, 'name'), { ph: 'ACL 名稱，例如 GUEST-IN', mono: false }),
      button('新增', { ic: 'plus', small: true, onclick: () => {
        const n = String(draft.name || '').trim();
        if (!/^[\w-]+$/.test(n)) return toast('名稱只能用英文、數字、- 與 _', 'bad');
        if (all[n]) return toast('已經有這個 ACL', 'bad');
        all[n] = [];
        draft.name = '';
        ctx.commit(true);
      } })),
    note('muted', '建好之後到「介面」分頁的 IPv6 區塊選擇要套用在哪個方向（ipv6 traffic-filter）。')));
}

void duidOf;
