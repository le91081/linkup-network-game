// 設備設定面板：依設備類別產生對應的管理頁面
import { h, icon, button, faceplate, toast } from './dom.js';
import {
  inp, sel, toggle, seg, field, note, kv, del, cardHead, grid2, bind, linkBadge, ifaceNote,
  isIp, isMask, isIpList, isVlanSpec, isPortNo, isAddr, isAddrList, isNum, isMacList, isCidrList,
} from './form.js';
import { CATALOG, MEDIA, peerOf, newIface } from '../engine/model.js';
import { parseIp, fmtIp } from '../engine/ip.js';
import { routeRows, SERVICE_NAMES, hitsOf, ospfOn, setOspf, fmtDur } from '../engine/sim.js';
import { buildTerminal } from './terminal.js';
import * as X from './panel-extra.js';
import * as M from './panel-more.js';
import * as DG from './panel-diag.js';
import * as OPS from './panel-ops.js';
import { isTftp, isFtp } from '../engine/files.js';
import { buildCli } from './cli.js';
import { buildFortiCli } from './forticli.js';
import { isIos, iosDirty, saveStartup } from '../engine/ios.js';

function dhcpBlock(ctx, i) {
  const d = i.dhcp;
  return h('div', { class: 'sub' },
    toggle(ctx, ...bind(d, 'on'), 'DHCP 伺服器', { rerender: true }),
    d.on && grid2(
      field('起始 IP', inp(ctx, ...bind(d, 'start'), { ph: '例如 192.168.1.100', check: isIp })),
      field('結束 IP', inp(ctx, ...bind(d, 'end'), { ph: '例如 192.168.1.200', check: isIp })),
      field('發給用戶端的 DNS', inp(ctx, ...bind(d, 'dns'), { ph: ctx.dev.dnsProxy ? '留空＝由本機代理' : '例如 168.95.1.1', check: isIpList })),
      field('發給用戶端的閘道', inp(ctx, ...bind(d, 'gw'), { ph: '留空＝本介面 IP', check: isIp })),
      field('租約時間', sel(ctx, () => String(d.lease || ''), (v) => { d.lease = v ? +v : ''; }, [['', '1 天（預設）'], ['300', '5 分鐘'], ['3600', '1 小時'], ['28800', '8 小時'], ['604800', '7 天']]),
        '用戶端過了一半的時間會自動續約；到期還續不到就會失去位址。')),
    d.on && h('div', { class: 'rsv' },
      h('div', { class: 'acl-h' }, h('span', { text: '保留位址' }), h('em', { text: '指定的 MAC 永遠拿到同一個 IP' }),
        button('新增', { ic: 'plus', small: true, onclick: () => { (d.reserved ||= []).push({ mac: '', ip: '' }); ctx.commit(true); } })),
      (d.reserved || []).map((r, n) => h('div', { class: 'trow c-rsv' },
        inp(ctx, ...bind(r, 'mac'), { ph: 'MAC，例如 02:1a:2b:3c:4d:5e', check: isMacList }),
        inp(ctx, ...bind(r, 'ip'), { ph: '要固定發給它的 IP', check: isIp }),
        del(() => { d.reserved.splice(n, 1); ctx.commit(true); })))),
    d.on && ctx.live(() => {
      const rt = i.rt || {};
      if (rt.ip == null) return note('warn', '介面本身要先有 IP，DHCP 伺服器才能運作');
      const a = parseIp(d.start), b = parseIp(d.end);
      if (a == null || b == null) return note('muted', '請填寫位址池的起始與結束 IP');
      const net = (x) => rt.bits === 0 || (x >>> (32 - rt.bits)) === (rt.ip >>> (32 - rt.bits));
      if (b < a || !net(a) || !net(b)) return note('warn', `位址池必須落在介面的子網路 ${fmtIp(rt.ip)}/${rt.bits} 之內`);
      const tbl = Object.entries(ctx.state.leases[`${ctx.dev.id}/${i.id}`] || {});
      if (!tbl.length) return note('muted', '目前沒有用戶端租用位址');
      const held = new Set((d.reserved || []).map((r) => parseIp(r.ip || '')));
      const hold = (ctx.state.dyn.hold || {})[`${ctx.dev.id}/${i.id}`] || {};
      return note('ok', '已發出：' + tbl.map(([k, ip]) => `${ctx.state.devices[k.split('/')[0]].name} ${fmtIp(ip)}${held.has(ip) ? '（保留）' : ''}${hold[k] ? `（剩 ${fmtDur(hold[k].exp - ctx.state.clock)}）` : ''}`).join('、'));
    }));
}

/** 通用的 L3 介面卡片 */
function ifaceCard(ctx, i, o = {}) {
  const parts = [];
  if (o.modes) parts.push(field('位址取得方式', sel(ctx, ...bind(i, 'mode'), o.modes, { rerender: true })));
  if (i.mode === 'static') {
    parts.push(grid2(
      field('IP 位址', inp(ctx, ...bind(i, 'ip'), { ph: o.ipPh || '例如 192.168.1.1', check: isIp })),
      field('子網路遮罩', inp(ctx, ...bind(i, 'mask'), { ph: '255.255.255.0', check: isMask })),
      o.gateway && field('預設閘道', inp(ctx, ...bind(i, 'gateway'), { ph: '選填（對外介面才需要）', check: isIp })),
      o.dns && field('DNS 伺服器', inp(ctx, ...bind(i, 'dns'), { ph: '選填', check: isIpList }))));
  }
  if (i.mode === 'pppoe') {
    parts.push(grid2(
      field('上網帳號', inp(ctx, ...bind(i, 'user'), { ph: '例如 12345678@hinet.net' })),
      field('上網密碼', inp(ctx, ...bind(i, 'pass'), { ph: '密碼' }))));
  }
  const toggles = [
    o.nat && toggle(ctx, ...bind(i, 'nat'), 'NAT（從此介面出去時偽裝成本介面 IP）', { rerender: true }),
    o.ospf && toggle(ctx, () => ospfOn(ctx.dev, i), (v) => setOspf(ctx.dev, i, v), 'OSPF（在此介面啟用動態路由）', { rerender: true }),
    o.ping && toggle(ctx, ...bind(i, 'ping'), '允許外部 ping 此介面'),
    o.shut && toggle(ctx, ...bind(i, 'shut'), '停用此介面 (shutdown)'),
  ].filter(Boolean);
  if (toggles.length) parts.push(h('div', { class: 'toggles' }, toggles));
  if (o.nat && i.nat && ctx.dev.kind === 'router') {
    parts.push(i.natAcl
      ? note('muted', `哪些流量要做 NAT 由 ACL「${i.natAcl}」決定（用 CLI 的 ip nat inside source list 設定）。`)
      : field('NAT 例外（往這些網段不轉換位址）', inp(ctx, ...bind(i, 'natSkip'), { ph: '例如站對站 VPN 的遠端網段 10.1.0.0/24', check: isCidrList }),
        '路由器會先做 NAT 再判斷要不要走 VPN。往對端內網的流量如果被 NAT，就不會進加密通道。'));
  }
  if ((o.ospf && ospfOn(ctx.dev, i)) || o.helper) {
    parts.push(grid2(
      o.ospf && ospfOn(ctx.dev, i) && field('OSPF Cost', inp(ctx, ...bind(i, 'ospfCost'), { ph: '預設 1，越小越優先', check: isNum(1, 65535) })),
      o.helper && field('DHCP Relay', inp(ctx, ...bind(i, 'helper'), { ph: '遠端 DHCP 伺服器 IP（選填）', check: isIp }))));
  }
  if (o.phy) parts.push(X.phyFields(ctx, i), X.phyNote(ctx, o.port));
  if (o.access) parts.push(X.accessRow(ctx, i));
  parts.push(ifaceNote(ctx, i));
  if (o.v6 && ctx.state.v6) parts.push(M.routerV6(ctx, i));
  if (o.dhcp) parts.push(dhcpBlock(ctx, i));
  if (o.vrrp) parts.push(X.vrrpBlock(ctx, i));
  return h('div', { class: 'card' + (o.nested ? ' nested' : '') },
    cardHead(o.title || i.label, o.badge, o.port && linkBadge(ctx, o.port), o.onDelete && del(o.onDelete)), parts);
}

const macLine = (ctx, i) => ctx.live(() => h('div', {
  class: 'macline', title: '點一下複製',
  onclick: () => navigator.clipboard?.writeText(i.rt.mac).then(() => toast('已複製 MAC：' + i.rt.mac), () => {}),
}, h('span', { text: 'MAC 位址' }), h('b', { class: 'mono', text: i.rt.mac })));

// ───────────────────────── 各類設備的分頁 ─────────────────────────

function hostNet(ctx, body) {
  const { dev } = ctx;
  const ipFields = (i) => i.mode === 'static' && grid2(
    field('IP 位址', inp(ctx, ...bind(i, 'ip'), { ph: '例如 192.168.1.10', check: isIp })),
    field('子網路遮罩', inp(ctx, ...bind(i, 'mask'), { ph: '255.255.255.0', check: isMask })),
    field('預設閘道', inp(ctx, ...bind(i, 'gateway'), { ph: '選填', check: isIp })),
    field('DNS 伺服器', inp(ctx, ...bind(i, 'dns'), { ph: '選填', check: isIpList })));
  const modeSeg = (i) => seg(ctx, ...bind(i, 'mode'), [['dhcp', '自動取得 (DHCP)'], ['static', '手動設定']]);
  for (const i of dev.ifaces) {
    if (i.bind.t === 'wlan') {
      body.append(h('div', { class: 'card' }, cardHead('Wi-Fi', X.assocBadge(ctx, i)), X.wifiPicker(ctx, i), X.wifiSignal(ctx, i), modeSeg(i), ipFields(i), ifaceNote(ctx, i), M.hostV6(ctx, i), macLine(ctx, i)));
    } else {
      body.append(h('div', { class: 'card' }, cardHead(i.label, linkBadge(ctx, i.bind.port)), modeSeg(i), ipFields(i), ifaceNote(ctx, i),
        dev.dot1x && i === dev.ifaces[0] && M.hostDot1x(ctx), M.hostV6(ctx, i), macLine(ctx, i)));
    }
  }
  if (dev.services.length) {
    body.append(h('div', { class: 'card' }, cardHead('這台設備提供的服務'),
      h('div', { class: 'chips' }, dev.services.map((s) => h('span', { class: 'chip', text: `${s.name ? s.name + ' · ' : ''}${s.proto.toUpperCase()} ${s.port}` })))));
  }
  if (OPS.isServer(dev)) body.append(OPS.serverRolesCard(ctx));
  body.append(OPS.flowsCard(ctx));
}

const KIND_TEXT = {
  hub: 'Hub 工作在第一層：不看位址，從任何一個埠收到的訊號都會複製到其他所有埠。不需要任何設定，插上線就能用。',
  switch: '非網管型交換器：會學習每個埠後面的 MAC 位址，只把訊框送往正確的埠。同樣不需要設定，所有埠都在同一個網段。它不支援 STP，接成迴圈就會發生廣播風暴。',
  ap: '基地台把無線用戶端橋接到有線網路。它只有一個網路孔，同時負責上行與 PoE 受電。',
};

function plainPorts(ctx, body) {
  const { dev, state } = ctx;
  body.append(faceplate(state, dev), h('p', { class: 'tip', text: KIND_TEXT[dev.kind] }));
  const used = dev.ports.filter((p) => peerOf(state, dev.id, p.id));
  body.append(h('div', { class: 'card' }, cardHead(`已接線 ${used.length} / ${dev.ports.length} 埠`),
    used.length ? used.map((p) => h('div', { class: 'line' }, h('b', { class: 'mono', text: '埠 ' + p.label }), linkBadge(ctx, p.id)))
      : note('muted', '還沒有任何設備接上來。從其他設備拖曳到這裡就能接線。')));
}

function swPorts(ctx, body) {
  const { dev, state, app } = ctx;
  const sw = dev.sw;
  const pinned = (app.pinned[dev.id] ||= new Set());
  body.append(faceplate(state, dev, { onPick: (p) => { pinned.add(p.id); app.renderPanel(); } }),
    h('p', { class: 'tip', text: '下方列出已接線或已調整過的連接埠；點面板上的埠可以把它加入清單預先設定。' }));
  const adv = (pc) => pc.shut || pc.trust || +pc.lag > 0 || (pc.ps && pc.ps.on) || pc.bpduguard || pc.rootguard || pc.dot1x || (pc.speed && pc.speed !== 'auto') || (pc.duplex && pc.duplex !== 'auto');
  const isDefault = (pc) => pc.mode === 'access' && pc.vlan === 1 && !adv(pc);
  const shown = dev.ports.filter((p) => peerOf(state, dev.id, p.id) || !isDefault(sw.ports[p.id]) || pinned.has(p.id));
  if (!shown.length) body.append(note('muted', '所有連接埠都是預設值（Access · VLAN 1）。'));
  const vlans = sw.vlans.slice().sort((a, b) => a.id - b.id);
  const vlanOpts = (curId) => {
    const o = vlans.map((v) => [v.id, `${v.id} · ${v.name}`]);
    if (!vlans.some((v) => v.id === curId)) o.push([curId, `${curId} · （VLAN 不存在）`]);
    return o;
  };
  for (const p of shown) {
    const pc = sw.ports[p.id];
    const key = dev.id + ':' + p.id;
    const modes = [['access', 'Access'], ['trunk', 'Trunk']];
    if (dev.kind === 'l3switch') modes.push(['routed', 'Routed (L3)']);
    const ri = dev.ifaces.find((i) => i.bind.t === 'port' && i.bind.port === p.id);
    const setMode = (v) => {
      pc.mode = v;
      if (v === 'routed' && !ri) dev.ifaces.push(newIface(p.id, p.label, { t: 'port', port: p.id }));
    };
    const routed = pc.mode === 'routed';
    const open = app.adv.has(key) || !!adv(pc);
    body.append(h('div', { class: 'card' + (pc.shut ? ' dim' : '') },
      cardHead(p.label, h('span', { class: 'chip tiny', text: MEDIA[p.media].name + (p.poe ? ' · PoE' : '') }), linkBadge(ctx, p.id)),
      grid2(
        field('模式', sel(ctx, () => pc.mode, setMode, modes, { rerender: true })),
        pc.mode === 'access' && field('VLAN', sel(ctx, () => pc.vlan, (v) => { pc.vlan = +v; }, vlanOpts(pc.vlan))),
        pc.mode === 'trunk' && field('Native VLAN', sel(ctx, () => pc.native, (v) => { pc.native = +v; }, vlanOpts(pc.native))),
        pc.mode === 'trunk' && field('允許的 VLAN', inp(ctx, ...bind(pc, 'allowed'), { ph: 'all 或 10,20', check: isVlanSpec })),
        routed && ri && field('IP 位址', inp(ctx, ...bind(ri, 'ip'), { ph: '例如 10.0.1.2', check: isIp })),
        routed && ri && field('子網路遮罩', inp(ctx, ...bind(ri, 'mask'), { ph: '255.255.255.252', check: isMask }))),
      routed && ri && h('div', { class: 'toggles' }, toggle(ctx, () => ospfOn(dev, ri), (v) => setOspf(dev, ri, v), 'OSPF（在此介面啟用動態路由）')),
      routed && ri && ifaceNote(ctx, ri),
      !routed && X.portWarn(ctx, p, pc),
      !routed && h('button', {
        type: 'button', class: 'advbtn' + (open ? ' on' : ''),
        onclick: () => { if (app.adv.has(key)) app.adv.delete(key); else app.adv.add(key); app.renderPanel(); },
      }, icon(open ? 'down' : 'chevron', 13), '進階：停用、速率 / 雙工、Port-channel、Port Security、802.1X、BPDU / Root Guard'),
      !routed && open && X.portAdvanced(ctx, p, pc)));
  }
  body.append(DG.spanCard(ctx));
}

function swVlans(ctx, body) {
  const { dev } = ctx;
  const sw = dev.sw;
  const list = h('div', { class: 'card' }, cardHead('VLAN 資料庫'));
  for (const v of sw.vlans.slice().sort((a, b) => a.id - b.id)) {
    const n = Object.values(sw.ports).filter((p) => p.mode === 'access' && p.vlan === v.id).length;
    list.append(h('div', { class: 'line' },
      h('b', { class: 'mono vid', text: v.id }),
      inp(ctx, ...bind(v, 'name'), { mono: false, ph: '名稱' }),
      h('span', { class: 'muted nowrap', text: `${n} 個 Access 埠` }),
      v.id === 1 ? h('span', { class: 'mini ghost' }) : del(() => {
        sw.vlans = sw.vlans.filter((x) => x.id !== v.id);
        for (const p of Object.values(sw.ports)) { if (p.vlan === v.id) p.vlan = 1; if (p.native === v.id) p.native = 1; }
        ctx.commit(true);
      })));
  }
  body.append(list);
  const quiet = { commit() {} };
  const draft = { id: '', name: '' };
  const idInp = inp(quiet, ...bind(draft, 'id'), { ph: 'ID，例如 10', check: isNum(2, 4094) });
  const nmInp = inp(quiet, ...bind(draft, 'name'), { ph: '名稱（選填）', mono: false });
  const add = () => {
    const id = +idInp.value.trim(), name = nmInp.value.trim();
    if (!Number.isInteger(id) || id < 2 || id > 4094) return toast('VLAN ID 必須是 2 – 4094 的整數', 'bad');
    if (sw.vlans.some((v) => v.id === id)) return toast(`VLAN ${id} 已經存在`, 'bad');
    sw.vlans.push({ id, name: name || 'VLAN' + id });
    ctx.commit(true);
  };
  for (const el of [idInp, nmInp]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  body.append(h('div', { class: 'card' }, cardHead('新增 VLAN'),
    h('div', { class: 'addrow' }, idInp, nmInp, button('新增', { ic: 'plus', kind: 'primary', small: true, onclick: add }))),
  h('p', { class: 'tip', text: 'VLAN 必須先建立，才能指派給連接埠。Trunk 經過的每一台交換器都要有同樣的 VLAN。' }));
}

function swL3(ctx, body) {
  const { dev } = ctx;
  const svis = dev.ifaces.filter((i) => i.bind.t === 'svi').sort((a, b) => a.bind.vlan - b.bind.vlan);
  body.append(h('p', { class: 'tip', text: 'VLAN 介面 (SVI) 是交換器在某個 VLAN 裡的 IP，通常就是該網段的閘道。Routed 埠請到「連接埠」分頁把模式改成 Routed。' }));
  for (const i of svis) {
    body.append(ifaceCard(ctx, i, {
      title: i.label, ospf: true, dhcp: true, helper: true, vrrp: true, badge: h('span', { class: 'chip tiny', text: 'VLAN ' + i.bind.vlan }),
      onDelete: () => { dev.ifaces = dev.ifaces.filter((x) => x !== i); ctx.commit(true); },
    }));
  }
  const free = dev.sw.vlans.filter((v) => !svis.some((i) => i.bind.vlan === v.id)).sort((a, b) => a.id - b.id);
  if (free.length) {
    const pickEl = h('select', { class: 'inp sel' }, free.map((v) => h('option', { value: v.id, text: `VLAN ${v.id} · ${v.name}` })));
    body.append(h('div', { class: 'card' }, cardHead('新增 VLAN 介面'),
      h('div', { class: 'addrow' }, pickEl, button('新增', {
        ic: 'plus', kind: 'primary', small: true,
        onclick: () => {
          const v = +pickEl.value;
          dev.ifaces.push(newIface('vlan' + v, 'Vlan' + v, { t: 'svi', vlan: v }));
          ctx.commit(true);
        },
      }))));
  } else {
    body.append(note('muted', '所有 VLAN 都已經有介面了。要新增請先到「VLAN」分頁建立 VLAN。'));
  }
  const routed = dev.ifaces.filter((i) => i.bind.t === 'port' && dev.sw.ports[i.bind.port]?.mode === 'routed');
  if (routed.length) {
    body.append(h('div', { class: 'card' }, cardHead('Routed 埠'),
      routed.map((i) => h('div', { class: 'line' }, h('b', { class: 'mono', text: i.label }),
        ctx.live(() => h('span', { class: 'mono muted', text: i.rt?.ip != null ? `${fmtIp(i.rt.ip)}/${i.rt.bits}${ospfOn(dev, i) ? ' · OSPF' : ''}` : '未設定 IP' }))))));
  }
}

function rtIfaces(ctx, body) {
  const { dev } = ctx;
  for (const p of dev.ports) {
    const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
    body.append(ifaceCard(ctx, i, {
      title: p.label, port: p.id, gateway: true, nat: true, dhcp: true, ospf: true, helper: true, vrrp: true, v6: true, shut: true, phy: p.media === 'rj45',
      modes: [['static', '固定 IP'], ['dhcp', '自動取得 (DHCP)'], ['pppoe', 'PPPoE 撥接']],
    }));
    const subs = dev.ifaces.filter((x) => x.bind.t === 'sub' && x.bind.port === p.id).sort((a, b) => a.bind.vlan - b.bind.vlan);
    for (const s of subs) {
      body.append(ifaceCard(ctx, s, {
        title: s.label, nested: true, dhcp: true, helper: true, vrrp: true, v6: true, badge: h('span', { class: 'chip tiny', text: '802.1Q VLAN ' + s.bind.vlan }),
        onDelete: () => { dev.ifaces = dev.ifaces.filter((x) => x !== s); ctx.commit(true); },
      }));
    }
    const vidInp = h('input', { class: 'inp mono', placeholder: 'VLAN ID', style: { width: '96px' } });
    const add = () => {
      const v = +vidInp.value.trim();
      if (!Number.isInteger(v) || v < 1 || v > 4094) return toast('VLAN ID 必須是 1 – 4094 的整數', 'bad');
      if (subs.some((s) => s.bind.vlan === v)) return toast(`${p.label}.${v} 已經存在`, 'bad');
      dev.ifaces.push(newIface(`${p.id}.${v}`, `${p.label}.${v}`, { t: 'sub', port: p.id, vlan: v }));
      ctx.commit(true);
    };
    vidInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    body.append(h('div', { class: 'addrow nested' }, h('span', { class: 'muted', text: `在 ${p.label} 新增子介面` }), vidInp,
      button('新增', { ic: 'plus', small: true, onclick: add })));
  }
}

function routesTab(ctx, body) {
  const { dev } = ctx;
  const card = h('div', { class: 'card' }, cardHead('靜態路由'));
  if (!dev.routes.length) card.append(note('muted', '還沒有靜態路由。路由器只認識自己直連的網段。'));
  else card.append(h('div', { class: 'thead c-route' }, h('span', { text: '目的網段' }), h('span', { text: '遮罩' }), h('span', { text: '下一站' }), h('span', { text: '距離' }), h('span')));
  dev.routes.forEach((r, n) => {
    card.append(h('div', { class: 'trow c-route' },
      inp(ctx, ...bind(r, 'dst'), { ph: '10.2.0.0', check: isIp }),
      inp(ctx, ...bind(r, 'mask'), { ph: '255.255.255.0', check: isMask }),
      inp(ctx, ...bind(r, 'via'), { ph: '172.16.0.2', check: isIp }),
      inp(ctx, ...bind(r, 'ad'), { ph: '1', check: isNum(1, 255) }),
      del(() => { dev.routes.splice(n, 1); ctx.commit(true); })));
  });
  card.append(h('div', { class: 'addrow' }, button('新增路由', { ic: 'plus', small: true, onclick: () => { dev.routes.push({ dst: '', mask: '', via: '', ad: '' }); ctx.commit(true); } }),
    h('span', { class: 'muted', text: '預設路由：0.0.0.0 / 0.0.0.0。距離越小越優先。' })));
  body.append(card);
  if (dev.kind === 'l3switch' || dev.kind === 'router') {
    body.append(h('div', { class: 'card' }, cardHead('OSPF'),
      h('div', { class: 'toggles' }, toggle(ctx, ...bind(dev, 'ospfDefault'), '向 OSPF 發布預設路由（default-information originate）')),
      h('p', { class: 'tip', text: 'OSPF 在各介面上個別啟用。有通往外部的預設路由的那一台勾選這個選項，其他 OSPF 路由器就會自動學到「往外走要找它」。' })));
  }
  body.append(routeTable(ctx));
  if (ctx.state.v6 && dev.kind === 'router') M.v6Routes(ctx, body);
}

function routeTable(ctx) {
  return h('div', { class: 'card' }, cardHead('目前的路由表'), ctx.live(() => {
    const rows = routeRows(ctx.dev);
    if (!rows.length) return note('muted', '路由表是空的 — 還沒有任何介面取得 IP。');
    return h('div', { class: 'rtable' }, rows.map((r) =>
      h('div', { class: 'rrow t-' + r.type + (r.bad ? ' bad' : '') },
        h('span', { class: 'tag', text: r.typeName }), h('b', { class: 'mono', text: r.dst }),
        h('span', { class: 'mono', text: '→ ' + r.via }), h('span', { class: 'mono muted', text: `${r.iface} [${r.ad}${r.type === 'O' ? '/' + r.metric : ''}]` }),
        r.bad && h('em', { text: '無效：' + r.bad }))));
  }));
}

function statusTab(ctx, body) {
  const { dev, state } = ctx;
  if (dev.sw && dev.sw.mode === 'vlan') X.switchStatus(ctx, body);
  if (dev.routing) body.append(routeTable(ctx));
  if (dev.routing && dev.kind !== 'homerouter' && dev.kind !== 'firewall') {
    body.append(h('div', { class: 'card' }, cardHead('OSPF 鄰居'), ctx.live(() => {
      const n = dev.rt.nbrs || [];
      if (!n.length) return note('muted', '沒有 OSPF 鄰居。兩端的介面都要有同網段的 IP 並勾選 OSPF。');
      return n.map((x) => h('div', { class: 'line' }, h('b', { text: state.devices[x.dev].name }),
        h('span', { class: 'mono muted', text: `${fmtIp(x.ip)} · 經由 ${dev.ifaces.find((i) => i.id === x.iface)?.label} · cost ${x.cost}` }),
        X.nbrBadge(x)));
    })));
  }
  if (dev.routing) {
    body.append(h('div', { class: 'card' }, cardHead('DHCP 租約'), ctx.live(() => {
      const rows = [];
      for (const [key, tbl] of Object.entries(state.leases)) {
        if (!key.startsWith(dev.id + '/')) continue;
        const hold = (state.dyn.hold || {})[key] || {};
        for (const [c, ip] of Object.entries(tbl)) rows.push(h('div', { class: 'line' }, h('b', { text: state.devices[c.split('/')[0]].name }),
          h('span', { class: 'mono muted', text: fmtIp(ip) + (hold[c] ? ` · 剩 ${fmtDur(hold[c].exp - state.clock)}` : '') })));
      }
      const hit = Object.entries(state.rt.dhcpConflict || {}).filter(([k]) => k.startsWith(dev.id + '/')).flatMap(([, v]) => v);
      if (hit.length) rows.push(note('warn', `發放前先 ping 過，發現 ${hit.map(fmtIp).join('、')} 已經有設備在用，所以跳過沒有發出去。固定 IP 最好移到位址池之外。`));
      return rows.length ? rows : note('muted', '目前沒有發出任何租約。');
    })));
    body.append(M.arpCard(ctx));
  }
  if (dev.kind === 'router' || dev.kind === 'homerouter') body.append(M.sessionTableCard(ctx), M.sessionCard(ctx, '連線紀錄（最新的在上面）'));
  if ((dev.sw && dev.sw.mode === 'vlan') || dev.kind === 'router' || dev.kind === 'firewall') body.append(DG.countersCard(ctx));
  body.append(X.neighborsCard(ctx));
}

function forwardsTab(ctx, body) {
  const { dev } = ctx;
  const fw = dev.kind === 'firewall';
  body.append(h('p', {
    class: 'tip',
    text: fw
      ? '虛擬 IP (VIP)：把打到對外介面某個埠的連線，轉給內部伺服器。別忘了還要有一條放行的政策，目的位址填「內部伺服器的 IP」。'
      : '連接埠轉發：外部連到本機對外 IP 的指定埠時，轉送給內部的伺服器。',
  }));
  const card = h('div', { class: 'card' }, cardHead(fw ? '虛擬 IP' : '連接埠轉發規則'));
  if (!dev.portForwards.length) card.append(note('muted', '目前沒有任何規則。'));
  else card.append(h('div', { class: 'thead c-fwd' }, h('span', { text: '協定' }), h('span', { text: '外部埠' }), h('span', { text: '內部 IP' }), h('span', { text: '內部埠' }), h('span')));
  dev.portForwards.forEach((f, n) => {
    card.append(h('div', { class: 'trow c-fwd' },
      sel(ctx, () => f.proto || 'tcp', (v) => { f.proto = v; }, [['tcp', 'TCP'], ['udp', 'UDP']]),
      inp(ctx, ...bind(f, 'port'), { ph: '443', check: isPortNo }),
      inp(ctx, ...bind(f, 'toIp'), { ph: '192.168.10.5', check: isIp }),
      inp(ctx, ...bind(f, 'toPort'), { ph: '同左', check: isPortNo }),
      del(() => { dev.portForwards.splice(n, 1); ctx.commit(true); })));
  });
  card.append(h('div', { class: 'addrow' }, button('新增規則', {
    ic: 'plus', small: true, onclick: () => { dev.portForwards.push({ proto: 'tcp', port: '', toIp: '', toPort: '' }); ctx.commit(true); },
  })));
  body.append(card);
  if (dev.staticNat) body.append(M.staticNatCard(ctx));
}

function hrWan(ctx, body) {
  const i = ctx.dev.ifaces.find((x) => x.id === 'wan');
  body.append(ifaceCard(ctx, i, {
    title: 'WAN', port: 'wan', gateway: true, dns: true,
    modes: [['dhcp', '自動取得 IP (DHCP)'], ['static', '固定 IP'], ['pppoe', 'PPPoE 撥接']],
  }), h('p', { class: 'tip', text: '家用路由器會自動替 LAN 的設備做 NAT，並擋下從 WAN 主動連進來的連線。' }));
}

function hrLan(ctx, body) {
  const { dev, state } = ctx;
  const i = dev.ifaces.find((x) => x.id === 'lan');
  body.append(faceplate(state, dev), ifaceCard(ctx, i, { title: 'LAN（LAN 1 – 4 與 Wi-Fi 共用）', dhcp: true }));
  const used = dev.ports.filter((p) => peerOf(state, dev.id, p.id));
  if (used.length) body.append(h('div', { class: 'card' }, cardHead('接線狀況'), used.map((p) => h('div', { class: 'line' }, h('b', { class: 'mono', text: p.label }), linkBadge(ctx, p.id)))));
}

function fwIfaces(ctx, body) {
  const { dev, state } = ctx;
  body.append(faceplate(state, dev));
  for (const i of dev.ifaces) {
    const isBr = i.bind.t === 'bridge';
    const wan = /^wan/.test(i.id);
    body.append(ifaceCard(ctx, i, {
      title: isBr ? 'internal（埠 1 – 5）' : i.label, port: isBr ? null : i.bind.port, gateway: wan, access: true, dhcp: !wan,
    }));
  }
}

function fwPolicies(ctx, body) {
  const { dev } = ctx;
  const ifOpts = [['any', 'any（任何介面）'], ...dev.ifaces.map((i) => [i.id, i.label]),
    ...(dev.vpns || []).map((t) => ['vpn:' + (t.name || 'VPN'), 'VPN ' + (t.name || 'VPN')])];
  if (dev.vpnServer) ifOpts.push(['vpn:remote', '遠端使用者 VPN']);
  const withCur = (cur) => (ifOpts.some((o) => o[0] === cur) ? ifOpts : [...ifOpts, [cur, cur + '（不存在）']]);
  body.append(h('p', { class: 'tip', text: '由上往下比對，第一條符合的政策決定放行或拒絕。回程封包會自動放行，只需要為「發起連線的方向」寫政策。' }));
  dev.policies.forEach((p, n) => {
    const move = (d) => { const [x] = dev.policies.splice(n, 1); dev.policies.splice(n + d, 0, x); ctx.commit(true); };
    body.append(h('div', { class: 'card policy ' + (p.action === 'accept' ? 'accept' : 'deny') },
      h('div', { class: 'card-h' }, h('span', { class: 'pno', text: '#' + (n + 1) }),
        inp(ctx, ...bind(p, 'name'), { mono: false, ph: '政策名稱' }),
        X.hitBadge(ctx, p),
        h('button', { class: 'mini', type: 'button', title: '上移', disabled: n === 0, onclick: () => move(-1) }, icon('up', 14)),
        h('button', { class: 'mini', type: 'button', title: '下移', disabled: n === dev.policies.length - 1, onclick: () => move(1) }, icon('down', 14)),
        del(() => { dev.policies.splice(n, 1); ctx.commit(true); })),
      grid2(
        field('來源介面', sel(ctx, ...bind(p, 'srcIf'), withCur(p.srcIf))),
        field('目的介面', sel(ctx, ...bind(p, 'dstIf'), withCur(p.dstIf))),
        field('來源位址', inp(ctx, ...bind(p, 'src'), { ph: 'any 或 10.1.10.0/24', check: isAddrList })),
        field('目的位址', inp(ctx, ...bind(p, 'dst'), { ph: 'any 或 172.16.1.10', check: isAddrList })),
        field('服務', sel(ctx, ...bind(p, 'service'), SERVICE_NAMES.includes(p.service) ? SERVICE_NAMES.map((s) => [s, s]) : [[p.service, p.service], ...SERVICE_NAMES.map((s) => [s, s])])),
        field('動作', sel(ctx, ...bind(p, 'action'), [['accept', '允許 ACCEPT'], ['deny', '拒絕 DENY']], { rerender: true }))),
      h('div', { class: 'toggles' },
        p.action === 'accept' && toggle(ctx, ...bind(p, 'nat'), 'NAT（來源位址換成出口介面的 IP）'),
        p.off && toggle(ctx, () => !p.off, (v) => { p.off = !v; }, '啟用這條政策（目前是停用狀態）', { rerender: true }))));
  });
  body.append(
    h('div', { class: 'addrow' }, button('新增政策', {
      ic: 'plus', kind: 'primary', small: true,
      onclick: () => {
        dev.policies.push({ name: '', srcIf: dev.ifaces[0].id, dstIf: dev.ifaces[0].id, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false });
        ctx.commit(true);
      },
    })),
    h('div', { class: 'card policy implicit' }, h('div', { class: 'card-h' }, icon('shield', 15), h('b', { text: '隱含拒絕 (Implicit Deny)' })),
      h('p', { class: 'muted', text: '以上政策都不符合的流量，一律拒絕。' })));
}

function inetInfo(ctx, body) {
  const { dev } = ctx;
  const T = { pppoe: 'PPPoE 撥接', dhcp: '自動取得 (DHCP)', static: '固定 IP' };
  for (const i of dev.ifaces) {
    const ln = i.line || {};
    body.append(h('div', { class: 'card' }, cardHead(i.label, linkBadge(ctx, i.bind.port)),
      h('div', { class: 'kv' }, kv('連線方式', T[ln.type] || '—'), kv('配發給客戶的 IP', ln.assign || '—'),
        kv('ISP 閘道', i.ip), kv('子網路遮罩', i.mask), kv('DNS', ln.dns || '—'))));
  }
  body.append(h('div', { class: 'card' }, cardHead('網際網路上的主機'),
    dev.inet.hosts.map((x) => h('div', { class: 'line' }, h('b', { text: x.name }), h('span', { class: 'mono muted', text: x.ip })))),
  h('p', { class: 'tip', text: '這是電信業者與外面的世界，無法設定。私有 IP（10.x、172.16–31.x、192.168.x）在這裡無法路由。' }));
}

const T = {
  net: ['net', '網路設定', hostNet], term: ['term', '終端機', buildTerminal], ports: ['ports', '連接埠', plainPorts],
  swports: ['ports', '連接埠', swPorts], vlan: ['vlan', 'VLAN', swVlans], l3: ['l3', 'L3 介面', swL3], route: ['route', '路由', routesTab],
  status: ['status', '狀態', statusTab], sec: ['sec', '安全', X.secTab], mgmt: ['mgmt', '管理', X.mgmtTab], acl: ['acl', 'ACL', X.aclTab],
  vpn: ['vpn', 'VPN', X.vpnTab], ifs: ['if', '介面', rtIfaces], nat: ['nat', 'NAT / 轉發', forwardsTab],
};

function tabsFor(dev) {
  const t = baseTabs(dev);
  // Cisco 的網路設備多一個唯讀的 IOS 風格 CLI
  if (!dev.locked && CATALOG[dev.model].vendor === 'Cisco' && ['router', 'mswitch', 'l3switch'].includes(dev.kind)) t.push(['cli', 'CLI', buildCli]);
  return t;
}

function baseTabs(dev) {
  if (dev.locked && dev.kind !== 'internet') return [['info', '設備資訊', X.lockedInfo]];
  switch (dev.kind) {
    case 'host': return [T.net, dev.vpnClient && ['vpn', 'VPN', X.vpnClientTab], dev.dhcpScopes && ['dhcp', 'DHCP 服務', X.dhcpScopesTab],
      dev.radiusServer && ['radius', 'RADIUS', M.radiusServerTab],
      (dev.services || []).some((s) => s.proto === 'udp' && s.port === 514) && ['syslog', 'Syslog', M.syslogTab],
      (isTftp(dev) || isFtp(dev)) && ['files', '檔案', OPS.filesTab], dev.nms && ['nms', '網管', OPS.nmsTab],
      ['cap', '封包擷取', DG.captureTab], T.term].filter(Boolean);
    case 'hub': case 'switch': return [T.ports];
    case 'ap': return [['ssid', '無線網路', X.ssidTab], ['radio', '無線電', X.radioTab], T.ports];
    case 'mswitch': return [T.swports, T.vlan, T.sec, T.mgmt, T.status];
    case 'l3switch': return [T.swports, T.vlan, T.l3, T.route, T.sec, T.mgmt, T.status];
    case 'router': return [T.ifs, T.route, T.nat, T.acl, T.vpn, T.mgmt, T.status];
    case 'homerouter': return [['wan', '網際網路 (WAN)', hrWan], ['lan', '區域網路 (LAN)', hrLan], ['wifi', '無線網路', X.ssidTab], ['nat', '連接埠轉發', forwardsTab], T.status];
    case 'firewall': return [['if', '介面', fwIfaces], ['pol', '政策', fwPolicies], ['nat', '虛擬 IP', forwardsTab], T.vpn, T.route, T.mgmt, ['log', '紀錄', M.logTab], T.status, ['fcli', 'CLI', buildFortiCli]];
    default: return [['info', '線路資訊', inetInfo]];
  }
}

const KIND_NAME = {
  host: '終端設備', hub: '集線器', switch: '交換器', mswitch: '網管型交換器', l3switch: 'L3 交換器',
  router: '路由器', homerouter: '家用路由器', firewall: '防火牆', ap: '無線基地台', internet: 'ISP',
};

/** 把選取的設備畫到面板上；回傳 false 表示沒有選取設備 */
export function renderDevicePanel(app, root) {
  const dev = app.selected && app.state.devices[app.selected];
  app.refreshers = [];
  if (!dev) return false;
  const m = CATALOG[dev.model];
  const tabs = tabsFor(dev);
  let cur = app.panelTab[dev.id];
  if (!tabs.some((t) => t[0] === cur)) cur = tabs[0][0];
  const viewKey = dev.id + ':' + cur;
  const prevBody = root.querySelector('.p-body');
  const keepScroll = prevBody && root.dataset.view === viewKey ? prevBody.scrollTop : 0;
  const prevTabs = root.querySelector('.tabs');
  const keepTabScroll = prevTabs ? prevTabs.scrollLeft : 0;
  const ctx = {
    app, state: app.state, dev,
    commit(rerender) { app.changed(); if (rerender) app.renderPanel(); },
    live(fn) {
      const el = h('div', { class: 'live' });
      const upd = () => el.replaceChildren(...[].concat(fn()).filter((x) => x != null && x !== false));
      upd();
      app.refreshers.push(upd);
      return el;
    },
  };
  const body = h('div', { class: 'p-body' });
  const isDown = !!(app.state.down || {})[dev.id];
  if (isDown) body.append(note('warn', '這台設備目前是關機狀態（故障模擬），所有連接埠都沒有燈號。按右上角的電源鈕可以開機。'));
  else {
    body.append(ctx.live(() => {
      const left = (app.state.rt.booting || {})[dev.id], rom = (app.state.rt.rommon || {})[dev.id];
      if (rom) return note('warn', `這台設備沒有開機成功，停在 ROMMON（開機程式）：${rom}。到 CLI 分頁用 dir flash: 看看有哪些檔案，再用 boot flash:<檔名> 手動開機。`);
      return left > 0 ? note('warn', `這台設備正在開機，還要 ${Math.ceil(left)} 秒才會開始工作。在那之前所有連接埠都沒有燈號，也不會回應任何封包。`) : null;
    }));
  }
  const tabBar = tabs.length > 1 && h('div', { class: 'tabs' + (tabs.length > 8 ? ' many many9' : tabs.length > 7 ? ' many' : '') }, tabs.map(([id, label]) =>
    h('button', { type: 'button', class: 'tab' + (id === cur ? ' on' : ''), onclick: () => { app.panelTab[dev.id] = id; app.renderPanel(); } }, label)));
  root.dataset.view = viewKey;
  root.replaceChildren(...[
    h('div', { class: 'p-head k-' + dev.kind },
      h('div', { class: 'p-badge', text: KIND_NAME[dev.kind] }),
      h('div', { class: 'p-title' },
        app.level.sandbox ? inp(ctx, () => dev.name, (v) => { if (v) dev.name = v; }, { mono: false, ph: '設備名稱' }) : h('h2', { text: dev.name }),
        h('p', { text: m.title }), h('p', { class: 'muted', text: m.tagline })),
      isIos(dev) && ctx.live(() => {
        const dirty = iosDirty(app.state, dev);
        return h('button', {
          class: 'mini save' + (dirty ? ' dirty' : ''), type: 'button', disabled: !dirty,
          title: dirty ? '有尚未儲存的設定：點一下執行 write memory。沒有存檔就關機或 reload，這些設定會消失。' : '設定已儲存到 startup-config',
          onclick: () => { saveStartup(dev); toast(`${dev.name}：已把 running-config 存成 startup-config`, 'ok'); ctx.commit(false); },
        }, icon('save', 15));
      }),
      !dev.locked && h('button', {
        class: 'mini power' + (isDown ? ' off' : ''), type: 'button', title: isDown ? '開機' : '關機 — 模擬這台設備故障，看看網路還通不通',
        onclick: () => app.togglePower(dev.id),
      }, icon('power', 15)),
      app.level.sandbox && h('button', { class: 'mini danger', type: 'button', title: '刪除這台設備', onclick: () => app.sandboxRemove(dev.id) }, icon('trash', 15)),
      h('button', { class: 'mini close', type: 'button', title: '關閉 (Esc)', onclick: () => app.select(null) }, icon('x', 16))),
    tabBar, body].filter(Boolean)); // replaceChildren 會把 false 變成文字，所以要先濾掉
  tabs.find((t) => t[0] === cur)[2](ctx, body);
  body.scrollTop = keepScroll;
  if (tabBar) tabBar.scrollLeft = keepTabScroll;
  return true;
}
