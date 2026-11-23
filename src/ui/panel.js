// 設備設定面板：依設備類別產生對應的管理頁面
import * as AUTO from './panel-auto.js';
import { sdwanTab } from './panel-sdwan.js';
import { haTab } from './panel-ha.js';
import { vtpCard } from './panel-vtp.js';
import { vtpOf } from '../engine/vtp.js';
import { utmTab, policyUtmFields } from './panel-utm.js';
import { powerTab } from './panel-power.js';
import { consoleTab, remoteOnlyInfo, needsConsole } from './panel-console.js';
import { hasPsuSlots } from '../engine/power.js';
import { breakoutCard } from './panel-breakout.js';
import { openAnnot } from './annot.js';
import { eigrpCard } from './panel-eigrp.js';
import * as CAM from './panel-cam.js';
import { ripCard } from './panel-rip.js';
import { ZONE, sdwanOn } from '../engine/sdwan.js';
import * as CL from './panel-cloud.js';
import * as W from './panel-wlc.js';
import { h, icon, button, faceplate, toast } from './dom.js';
import {
  inp, sel, toggle, seg, field, note, kv, del, cardHead, grid2, bind, linkBadge, ifaceNote, badge,
  isIp, isMask, isIpList, isVlanSpec, isPortNo, isAddr, isAddrList, isNum, isMacList, isCidrList, isCidr6,
} from './form.js';
import { fmtIp6 } from '../engine/ip6.js';
import { CATALOG, MEDIA, peerOf, newIface, defaultPortMode } from '../engine/model.js';
import { parseIp, fmtIp } from '../engine/ip.js';
import { routeRows, SERVICE_NAMES, hitsOf, ospfOn, setOspf, fmtDur } from '../engine/sim.js';
import { ospfArea, ospfCost, ospfPassive, isLoopback, ospfProcOf, ospfKeys, ospfBfd } from '../engine/ospf.js';
import { ospfCard, ospfNeighborRows } from './panel-ospf.js';
import * as L2S from './panel-l2sec.js';
import { buildTerminal } from './terminal.js';
import * as X from './panel-extra.js';
import * as M from './panel-more.js';
import * as DG from './panel-diag.js';
import * as OPS from './panel-ops.js';
import * as V from './panel-voice.js';
import { bgpCard } from './panel-bgp.js';
import * as TR from './panel-track.js';
import * as VZ from './panel-virt.js';
import * as LTM from './panel-ltm.js';
import { stackTab } from './panel-stack.js';
import { isStack } from '../engine/stack.js';
import { dnsTab } from './panel-dns.js';
import { vrfField, vrfCard } from './panel-vrf.js';
import { webTab, clientTlsCard } from './panel-web.js';
import { hostMtuField, routerMtuBlock, switchMtuCard, nexusPortMtu } from './panel-mtu.js';
import { redistCard, pbrCard } from './panel-policy.js';
import { tunnelCards } from './panel-tun.js';
import { dockerTab } from './term-docker.js';
import { isDnsServer } from '../engine/dns.js';
import { isTftp, isFtp, isScp } from '../engine/files.js';
import { buildCli } from './cli.js';
import { buildFortiCli } from './forticli.js';
import { isIos, iosDirty, saveStartup } from '../engine/ios.js';

/** 介面上的 OSPF 參數：區域、cost、priority、網路類型、被動介面、計時器、驗證 */
function ospfIfBlock(ctx, i) {
  const d = ctx.dev;
  const area = ospfArea(d, i);
  const fromStmt = !i.ospf; // 由 router ospf 的 network 敘述啟用的：區域跟著敘述走
  // 介面在 VRF 裡：被動介面、參考頻寬都是那個 VRF 的程序的設定
  const c = ospfProcOf(d, i) || d;
  const setPassive = (on) => {
    if (c.ospfPassiveDefault) { c.ospfNoPassive = (c.ospfNoPassive || []).filter((x) => x !== i.id); if (!on) c.ospfNoPassive.push(i.id); }
    else { c.ospfPassive = (c.ospfPassive || []).filter((x) => x !== i.id); if (on) c.ospfPassive.push(i.id); }
  };
  return h('div', { class: 'sub' },
    grid2(
      field('OSPF 區域', fromStmt ? h('span', { class: 'mono', text: `area ${area}（由 network 敘述決定）` }) : inp(ctx, () => String(i.ospfArea || 0), (v) => { i.ospfArea = +v || 0; }, { check: isNum(0, 4294967295) })),
      field('Cost', inp(ctx, ...bind(i, 'ospfCost'), { ph: `自動：${ospfCost(ctx.state, d, i)}（參考頻寬 ${+c.ospfRefBw || 100} Mbps ÷ 介面頻寬）`, check: isNum(1, 65535) })),
      !isLoopback(i) && field('Priority（DR 選舉）', inp(ctx, () => (i.ospfPrio == null ? '' : String(i.ospfPrio)), (v) => { if (v === '') delete i.ospfPrio; else i.ospfPrio = +v; }, { ph: '預設 1；0 表示不當 DR / BDR', check: isNum(0, 255) })),
      !isLoopback(i) && field('網路類型', sel(ctx, () => i.ospfNet || '', (v) => { if (v) i.ospfNet = v; else delete i.ospfNet; }, i.bind.t === 'gre' ? [['', 'point-to-point（Tunnel 的預設）'], ['broadcast', 'broadcast（DMVPN：hub 當 DR，spoke 設 priority 0）']] : [['', 'broadcast（要選 DR / BDR）'], ['p2p', 'point-to-point（兩台直連，不選 DR）']])),
      !isLoopback(i) && field('Hello / Dead（秒）', inp(ctx, () => (i.ospfHello || i.ospfDead ? `${i.ospfHello || 10}/${i.ospfDead || 4 * (i.ospfHello || 10)}` : ''), (v) => {
        const m = String(v).match(/^(\d+)\s*\/\s*(\d+)$/);
        if (!m) { delete i.ospfHello; delete i.ospfDead; return; }
        if (+m[1] === 10) delete i.ospfHello; else i.ospfHello = +m[1];
        if (+m[2] === 4 * (+m[1])) delete i.ospfDead; else i.ospfDead = +m[2];
      }, { ph: '10/40（兩端要一樣）' })),
      !isLoopback(i) && field('驗證', sel(ctx, () => i.ospfAuth || '', (v) => { if (v) i.ospfAuth = v; else delete i.ospfAuth; if (v === 'md5' && !(i.ospfKey && i.ospfKey.id)) i.ospfKey = { id: 1, key: (i.ospfKey || {}).key || '' }; }, [['', '跟著區域的設定（預設不驗證）'], ['md5', 'MD5 (message-digest)'], ['plain', '明文密碼'], ['null', '不驗證 (null)']], { rerender: true })),
      i.ospfAuth && i.ospfAuth !== 'null' && field('驗證金鑰', inp(ctx, () => (i.ospfKey || {}).key || '', (v) => { i.ospfKey = { id: i.ospfAuth === 'md5' ? (i.ospfKey || {}).id || 1 : '', key: v }; }, { ph: '兩端要一樣' }))),
    !isLoopback(i) && h('div', { class: 'toggles' }, toggle(ctx, () => ospfPassive(d, i), setPassive, '被動介面 (passive-interface)：通告這個網段，但不送 Hello、不建立鄰居（接使用者的介面建議打開）'),
      i.bind.t !== 'gre' && toggle(ctx, () => ospfBfd(d, i), (on) => { if (on) { i.bfd ||= { tx: 300, rx: 300, mult: 3 }; i.ospfBfd = true; delete i.ospfBfdOff; } else { delete i.ospfBfd; delete i.bfd; } }, 'BFD：每 300 毫秒互送一次，對面失聯一秒內通知 OSPF，不用等 Dead timer（兩端都要開）')),
    isLoopback(i) && note('muted', 'Loopback 一律以 /32 主機路由通告；它永遠是 up 的，很適合拿來當 Router ID。'),
    i.vrf && note('muted', `這個介面在 VRF ${i.vrf} 裡：由 router ospf ${(c.pid || '?')} vrf ${i.vrf} 涵蓋，學到的路裝進 VRF ${i.vrf} 的路由表`),
    ctx.live(() => {
      const o = d.rt[ospfKeys(i.vrf || '').key], f = o && o.ifs[i.id];
      if (!f) return null;
      const st = { DR: 'DR（指定路由器）', BDR: 'BDR（備援指定路由器）', DROTHER: 'DROTHER', WAITING: '等 Wait timer，還沒選 DR', P2P: '點對點', PASSIVE: '被動介面', LOOP: 'Loopback' }[f.state] || f.state;
      return [note('muted', `OSPF 狀態：${st} · cost ${f.cost} · 鄰居 ${f.full}/${f.nbrs} FULL`), ...f.why.map((w) => note('warn', '沒有成為鄰居：' + w))];
    }));
}

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
        '用戶端過了一半的時間會自動續約；到期還續不到就會失去位址。'),
      ctx.dev.kind !== 'homerouter' && field('TFTP 伺服器（option 150）', inp(ctx, ...bind(d, 'tftp'), { ph: 'IP 電話下載設定檔用，沒有電話就留空', check: isIpList })),
      ctx.dev.kind === 'router' && field('WLC 位址（option 43）', inp(ctx, ...bind(d, 'wlc'), { ph: 'Cisco 輕量型 AP 找控制器用，沒有就留空', check: isIpList }),
        d.wlc ? `IOS 的寫法：option 43 hex f1${(String(d.wlc).split(/[,\s]+/).filter(Boolean).length * 4).toString(16).padStart(2, '0')}…（類型 f1、長度、控制器 IP 的十六進位）` : '')),
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
  if (ctx.dev.kind === 'router' && i.bind.t !== 'loop') { const vf = vrfField(ctx, i); if (vf) parts.unshift(vf); }
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
  if (o.ospf && ospfOn(ctx.dev, i)) parts.push(ospfIfBlock(ctx, i));
  if (o.helper) parts.push(grid2(field('DHCP Relay', inp(ctx, ...bind(i, 'helper'), { ph: '遠端 DHCP 伺服器 IP（選填）', check: isIp }))));
  if (o.phy) parts.push(X.phyFields(ctx, i), X.phyNote(ctx, o.port));
  if (o.mtu) parts.push(routerMtuBlock(ctx, i));
  if (o.access) parts.push(X.accessRow(ctx, i));
  if (o.extra) parts.push(...[].concat(o.extra()).filter(Boolean));
  parts.push(ifaceNote(ctx, i));
  if (o.v6 && ctx.state.v6) parts.push(M.routerV6(ctx, i));
  if (o.dhcp) parts.push(dhcpBlock(ctx, i));
  if (o.vrrp) parts.push(TR.fhrpBlock(ctx, i));
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
        dev.dot1x && i === dev.ifaces[0] && M.hostDot1x(ctx), M.hostV6(ctx, i), hostMtuField(ctx, i), macLine(ctx, i)));
    }
  }
  if (dev.services.length) {
    body.append(h('div', { class: 'card' }, cardHead('這台設備提供的服務'),
      h('div', { class: 'chips' }, dev.services.map((s) => h('span', { class: 'chip', text: `${s.name ? s.name + ' · ' : ''}${s.proto.toUpperCase()} ${s.port}` })))));
  }
  if (OPS.isServer(dev)) body.append(OPS.serverRolesCard(ctx));
  // 這一關有內部的 HTTPS 網站：電腦要信任公司的 CA、時鐘要準
  if (!dev.web && (dev.trust || dev.clock || Object.values(ctx.state.devices).some((x) => x.web))) body.append(clientTlsCard(ctx));
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
  const adv = (pc) => pc.shut || pc.trust || +pc.lag > 0 || (pc.ps && pc.ps.on) || pc.bpduguard || pc.rootguard || pc.bpdufilter != null || pc.loopguard != null || pc.dot1x || (pc.speed && pc.speed !== 'auto') || (pc.duplex && pc.duplex !== 'auto');
  const isDefault = (pc) => pc.mode === defaultPortMode(dev.model) && pc.vlan === 1 && !pc.voice && !adv(pc);
  const shown = dev.ports.filter((p) => peerOf(state, dev.id, p.id) || !isDefault(sw.ports[p.id]) || pinned.has(p.id));
  if (!shown.length) body.append(note('muted', `所有連接埠都是預設值（${defaultPortMode(dev.model) === 'access' ? 'Access' : 'Dynamic Auto'} · VLAN 1）。`));
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
    if (defaultPortMode(dev.model) !== 'access') modes.push(['dynamic-auto', 'Dynamic Auto（DTP，出廠預設）'], ['dynamic-desirable', 'Dynamic Desirable（DTP，主動要求）']);
    if (dev.kind === 'l3switch') modes.push(['routed', 'Routed (L3)']);
    const dyn = /^dynamic/.test(pc.mode), trunkish = pc.mode === 'trunk' || dyn, accessish = pc.mode !== 'trunk' && pc.mode !== 'routed';
    const voiceOpts = () => [['', '（不使用）'], ...vlanOpts(pc.voice || 1).filter(([id]) => id !== 1 || pc.voice === 1)];
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
        accessish && field(dyn ? 'Access VLAN（協商成 Access 時）' : 'VLAN', sel(ctx, () => pc.vlan, (v) => { pc.vlan = +v; }, vlanOpts(pc.vlan))),
        accessish && field('Voice VLAN（IP 電話）', sel(ctx, () => pc.voice || '', (v) => { if (v === '' || v == null) delete pc.voice; else pc.voice = +v; }, voiceOpts())),
        trunkish && field(dyn ? 'Native VLAN（協商成 Trunk 時）' : 'Native VLAN', sel(ctx, () => pc.native, (v) => { pc.native = +v; }, vlanOpts(pc.native))),
        trunkish && field('允許的 VLAN', inp(ctx, ...bind(pc, 'allowed'), { ph: 'all 或 10,20', check: isVlanSpec })),
        routed && ri && field('IP 位址', inp(ctx, ...bind(ri, 'ip'), { ph: '例如 10.0.1.2', check: isIp })),
        routed && ri && field('子網路遮罩', inp(ctx, ...bind(ri, 'mask'), { ph: '255.255.255.252', check: isMask })),
        nexusPortMtu(ctx, pc)),
      routed && ri && h('div', { class: 'toggles' }, toggle(ctx, () => ospfOn(dev, ri), (v) => setOspf(dev, ri, v), 'OSPF（在此介面啟用動態路由）')),
      routed && ri && ifaceNote(ctx, ri),
      !routed && X.dtpLine(ctx, p, pc),
      !routed && X.portWarn(ctx, p, pc),
      !routed && h('button', {
        type: 'button', class: 'advbtn' + (open ? ' on' : ''),
        onclick: () => { if (app.adv.has(key)) app.adv.delete(key); else app.adv.add(key); app.renderPanel(); },
      }, icon(open ? 'down' : 'chevron', 13), '進階：停用、DTP、CDP / LLDP、速率 / 雙工、Port-channel、Port Security、802.1X、BPDU / Root Guard'),
      !routed && open && X.portAdvanced(ctx, p, pc)));
  }
  body.append(DG.spanCard(ctx));
  for (const c of [V.poeCard(ctx), V.mlsQosCard(ctx), switchMtuCard(ctx), breakoutCard(ctx)]) if (c) body.append(c);
}

function swVlans(ctx, body) {
  const { dev } = ctx;
  const sw = dev.sw;
  const vc = vtpCard(ctx);
  if (vc) body.append(vc);
  const client = vtpOf(dev).mode === 'client' && !!vc;
  const list = h('div', { class: 'card' }, cardHead('VLAN 資料庫'));
  for (const v of sw.vlans.slice().sort((a, b) => a.id - b.id)) {
    const n = Object.values(sw.ports).filter((p) => p.mode !== 'trunk' && p.mode !== 'routed' && p.vlan === v.id).length;
    list.append(h('div', { class: 'line' },
      h('b', { class: 'mono vid', text: v.id }),
      inp(ctx, ...bind(v, 'name'), { mono: false, ph: '名稱' }),
      h('span', { class: 'muted nowrap', text: v.pvlan ? `PVLAN ${v.pvlan}` : `${n} 個 Access 埠` }),
      v.id === 1 || client ? h('span', { class: 'mini ghost' }) : del(() => {
        sw.vlans = sw.vlans.filter((x) => x.id !== v.id);
        for (const p of Object.values(sw.ports)) { if (p.vlan === v.id) p.vlan = 1; if (p.native === v.id) p.native = 1; if (p.voice === v.id) delete p.voice; }
        ctx.commit(true);
      })));
    const pv = L2S.pvlanField(ctx, v);
    if (pv) list.append(pv);
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
  if (!client) body.append(h('div', { class: 'card' }, cardHead('新增 VLAN'),
    h('div', { class: 'addrow' }, idInp, nmInp, button('新增', { ic: 'plus', kind: 'primary', small: true, onclick: add }))));
  body.append(
  h('p', { class: 'tip', text: 'VLAN 必須先建立，才能指派給連接埠。Trunk 經過的每一台交換器都要有同樣的 VLAN。' }));
}

function swL3(ctx, body) {
  const { dev } = ctx;
  const svis = dev.ifaces.filter((i) => i.bind.t === 'svi').sort((a, b) => a.bind.vlan - b.bind.vlan);
  body.append(h('p', { class: 'tip', text: 'VLAN 介面 (SVI) 是交換器在某個 VLAN 裡的 IP，通常就是該網段的閘道。Routed 埠請到「連接埠」分頁把模式改成 Routed。' }));
  for (const i of svis) {
    const card = ifaceCard(ctx, i, {
      title: i.label, ospf: true, dhcp: true, helper: true, vrrp: true, badge: h('span', { class: 'chip tiny', text: 'VLAN ' + i.bind.vlan }),
      onDelete: () => { dev.ifaces = dev.ifaces.filter((x) => x !== i); ctx.commit(true); },
    });
    // Private VLAN 的 primary：secondary VLAN 的主機也要用這個 SVI 當閘道（private-vlan mapping）
    const pv = dev.sw.vlans.find((v) => v.id === i.bind.vlan && v.pvlan === 'primary');
    if (pv && L2S.pvlanOk(dev)) card.append(h('div', { class: 'toggles' }, toggle(ctx, () => (i.pvMap || []).length > 0, (on) => { if (on) i.pvMap = (pv.assoc || []).slice(); else delete i.pvMap; },
      `secondary VLAN（${(pv.assoc || []).join(', ') || '尚未關聯'}）的主機也用這個介面當閘道（private-vlan mapping）`)));
    body.append(card);
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

/** 負載平衡器：每個埠是一個 VLAN，上面設一個 self IP（預設閘道寫在「路由」分頁的 0.0.0.0/0） */
function lbIfaces(ctx, body) {
  body.append(note('muted', 'BIG-IP 在每個 VLAN 上有一個 self IP。self IP 是它自己的位址：送健康檢查、SNAT Automap 都用它。預設閘道在「路由」分頁新增 0.0.0.0 / 0.0.0.0。'));
  for (const p of ctx.dev.ports) {
    const i = ctx.dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
    body.append(ifaceCard(ctx, i, { title: `${p.label}${i.desc ? '（' + i.desc + '）' : ''}`, port: p.id, shut: true, phy: p.media === 'rj45', modes: [['static', '固定 IP (Self IP)']] }));
  }
}
function rtIfaces(ctx, body) {
  const { dev } = ctx;
  for (const p of dev.ports) {
    const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
    body.append(ifaceCard(ctx, i, {
      title: p.label, port: p.id, gateway: true, nat: true, dhcp: true, ospf: true, helper: true, vrrp: true, v6: true, shut: true, phy: p.media === 'rj45', mtu: true,
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
  const pools6 = M.dhcp6PoolsCard(ctx);
  if (pools6) body.append(pools6);
  loopbackCards(ctx, body);
  tunnelCards(ctx, body, ifaceCard);
}

/** Loopback：不靠任何實體線路、永遠是 up 的虛擬介面，常拿來當 Router ID 與管理位址 */
function loopbackCards(ctx, body) {
  const { dev } = ctx;
  const loops = dev.ifaces.filter((x) => x.bind.t === 'loop').sort((a, b) => a.bind.n - b.bind.n);
  for (const l of loops) {
    body.append(ifaceCard(ctx, l, {
      title: l.label, ospf: true, badge: h('span', { class: 'chip tiny', text: '虛擬介面' }),
      onDelete: () => { dev.ifaces = dev.ifaces.filter((x) => x !== l); ctx.commit(true); },
    }));
  }
  body.append(h('div', { class: 'addrow' }, h('span', { class: 'muted', text: 'Loopback 介面不會斷線，適合當 Router ID 與管理位址' }),
    button('新增 Loopback', { ic: 'plus', small: true, onclick: () => {
      let n = 0;
      while (loops.some((x) => x.bind.n === n)) n++;
      dev.ifaces.push(newIface('Lo' + n, 'Loopback' + n, { t: 'loop', n }, { mask: '255.255.255.255' }));
      ctx.commit(true);
    } })));
}

function routesTab(ctx, body) {
  const { dev } = ctx;
  const card = h('div', { class: 'card' }, cardHead('靜態路由'));
  // 有追蹤物件（或已經有路由用了 track）才多一欄「追蹤」
  const trk = !!(dev.track && Object.keys(dev.track).length) || dev.routes.some((r) => r.track != null);
  const vrfs = Object.keys(dev.vrfs || {});
  const vr = vrfs.length > 0 || dev.routes.some((r) => r.vrf || r.outIf);
  const cls = 'c-route' + (trk ? ' t' : '');
  // 出口介面：留空＝在這條路由自己的路由表找下一站；global＝下一站在全域的路由表；選介面＝從那個介面出去（可以是別的 VRF：路由洩漏）
  const exitOpts = (r) => [['', '出口：自動'], ...(r.vrf ? [['@global', '下一站在全域 (global)']] : []),
    ...dev.ifaces.filter((i) => i.bind.t !== 'wlan').map((i) => [i.id, `出口 ${i.label}${vrfs.length ? (i.vrf ? '（' + i.vrf + '）' : '（全域）') : ''}`])];
  const exitOf = (r) => (r.global ? '@global' : r.outIf || '');
  const setExit = (r, v) => { delete r.global; delete r.outIf; if (v === '@global') r.global = true; else if (v) r.outIf = v; };
  if (!dev.routes.length) card.append(note('muted', '還沒有靜態路由。路由器只認識自己直連的網段。'));
  else card.append(h('div', { class: 'thead ' + cls }, h('span', { text: '目的網段' }), h('span', { text: '遮罩' }), h('span', { text: '下一站' }), h('span', { text: '距離' }), trk && h('span', { text: '追蹤' }), h('span')));
  dev.routes.forEach((r, n) => {
    if (vr) {
      card.append(h('div', { class: 'trow c-routex', title: '上：這條路由放進哪個路由表 · 出口：下一站在哪裡找（選另一個 VRF 的介面或「下一站在全域」就是路由洩漏）' },
        sel(ctx, () => r.vrf || '', (v) => { if (v) r.vrf = v; else { delete r.vrf; delete r.global; } }, [['', '全域'], ...vrfs.map((v) => [v, v])], { rerender: true }),
        sel(ctx, () => exitOf(r), (v) => setExit(r, v), exitOpts(r))));
    }
    card.append(h('div', { class: 'trow ' + cls + (vr ? ' under' : '') },
      inp(ctx, ...bind(r, 'dst'), { ph: '10.2.0.0', check: isIp }),
      inp(ctx, ...bind(r, 'mask'), { ph: '255.255.255.0', check: isMask }),
      inp(ctx, ...bind(r, 'via'), { ph: '172.16.0.2', check: isIp }),
      inp(ctx, ...bind(r, 'ad'), { ph: '1', check: isNum(1, 255) }),
      trk && TR.routeTrackInput(ctx, r),
      del(() => { dev.routes.splice(n, 1); ctx.commit(true); })));
  });
  card.append(h('div', { class: 'addrow' }, button('新增路由', { ic: 'plus', small: true, onclick: () => { dev.routes.push({ dst: '', mask: '', via: '', ad: '' }); ctx.commit(true); } }),
    h('span', { class: 'muted', text: vr ? '預設路由：0.0.0.0 / 0.0.0.0。距離越小越優先。VRF 之間的路由洩漏：出口選另一個 VRF 的介面，或選「下一站在全域的路由表」。' : '預設路由：0.0.0.0 / 0.0.0.0。距離越小越優先。' })));
  body.append(card);
  if (dev.kind === 'l3switch' || dev.kind === 'router') body.append(TR.trackCard(ctx));
  if (dev.kind === 'router') body.append(vrfCard(ctx));
  if (dev.kind === 'l3switch' || dev.kind === 'router') {
    body.append(ospfCard(ctx));
    const ec = eigrpCard(ctx);
    if (ec) body.append(ec);
    const rc = ripCard(ctx);
    if (rc) body.append(rc);
  }
  const bc = bgpCard(ctx);
  if (bc) body.append(bc);
  for (const c of [redistCard(ctx), pbrCard(ctx)]) if (c) body.append(c);
  body.append(routeTable(ctx));
  if (ctx.state.v6 && dev.kind === 'router') M.v6Routes(ctx, body);
}

function routeTable(ctx) {
  return h('div', { class: 'card' }, cardHead('目前的路由表'), ctx.live(() => {
    const rows = routeRows(ctx.dev);
    if (!rows.length) return note('muted', '路由表是空的 — 還沒有任何介面取得 IP。');
    return h('div', { class: 'rtable' }, rows.map((r) =>
      h('div', { class: 'rrow t-' + r.type + (r.bad ? ' bad' : '') },
        h('span', { class: 'tag', text: r.typeName + (r.sub ? ' ' + r.sub : '') }), h('b', { class: 'mono', text: r.dst }),
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
      const n = ospfNeighborRows(dev);
      if (!n.length) return note('muted', '沒有 OSPF 鄰居。兩端的介面都要有同網段的 IP 並勾選 OSPF。');
      return n.map((x) => h('div', { class: 'line' }, h('b', { text: state.devices[x.dev].name }),
        h('span', { class: 'mono muted', text: `${x.proc ? x.proc + ' · ' : ''}${fmtIp(x.ip)} · 經由 ${dev.ifaces.find((i) => i.id === x.iface)?.label} · cost ${x.cost}${x.role && x.role !== 'P2P' && x.role !== 'WAITING' ? ' · 對方是 ' + x.role : ''}${x.note ? ' · ' + x.note : ''}` }),
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
  const nc = X.neighborsCard(ctx);
  if (nc) body.append(nc);
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
  const npc = M.natPoolCard(ctx);
  if (npc) body.append(npc);
}

function hrWan(ctx, body) {
  const i = ctx.dev.ifaces.find((x) => x.id === 'wan');
  // 光纖數據機：路由模式 / 橋接模式
  if (ctx.dev.ont) {
    const o = ctx.dev.ont;
    body.append(h('div', { class: 'card' }, cardHead('運作模式', o.bridge ? badge('warn', '橋接模式') : badge('on', '路由模式')),
      toggle(ctx, () => !!o.bridge, (v) => { o.bridge = v; }, '橋接模式 (Bridge)：只把光纖轉成乙太網路', { rerender: true }),
      note('muted', o.bridge ? '橋接模式：數據機沒有自己的 IP，不撥接、不做 NAT、不發 DHCP。後面的路由器直接用 PPPoE 撥接，拿到公用 IP（只有一層 NAT，連接埠轉發才收得到外面的連線）。'
        : '路由模式（出廠值）：數據機自己撥 PPPoE、做 NAT、LAN 發 192.168.1.x。後面再接自己的路由器，就變成兩層 NAT（double NAT）：外面連進來會先被數據機擋下。')));
    if (o.bridge) return;
  }
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
    if (state.v6) body.append(h('div', { class: 'card' }, cardHead(`${isBr ? 'internal' : i.label} · IPv6`), fgV6(ctx, i)));
  }
}

/** FortiGate 介面的 IPv6：固定、DHCPv6（WAN：自動取得並要求前綴委派）、委派（從上游介面拿到的前綴切一段） */
function fgV6(ctx, i) {
  const d = ctx.dev;
  const mode = i.gp6 ? 'delegated' : i.mode6 === 'auto' ? 'dhcp' : i.ip6 ? 'static' : '';
  const setMode = (v) => {
    delete i.gp6; delete i.pd6; delete i.v6default; delete i.mode6; i.ip6 = '';
    if (v === 'static') { i.ip6 = '2001:db8::1/64'; i.ra = true; }
    if (v === 'dhcp') Object.assign(i, { mode6: 'auto', v6default: true, pd6: i.id });
    if (v === 'delegated') { const up = d.ifaces.find((x) => x.pd6) || d.ifaces.find((x) => /^wan/.test(x.id)); i.gp6 = { name: up ? up.id : 'wan1', suffix: '::1:0:0:0:1/64' }; i.ra = true; }
  };
  return h('div', null,
    field('取得方式 (ip6-mode)', sel(ctx, () => mode, setMode, [['', '不使用 IPv6'], ['static', '固定 (static)'], ['dhcp', 'DHCPv6（WAN：自動取得、向 ISP 要求前綴委派）'], ['delegated', '委派 (delegated)：從上游介面拿到的前綴切一段']], { rerender: true })),
    mode === 'static' && field('IPv6 位址 / 前綴', inp(ctx, ...bind(i, 'ip6'), { ph: '2001:db8:1::1/64', check: isCidr6 })),
    mode === 'dhcp' && toggle(ctx, () => !!i.pd6, (v) => { if (v) i.pd6 = i.id; else delete i.pd6; }, '向 ISP 要求前綴委派（dhcp6-prefix-delegation）'),
    mode === 'delegated' && grid2(
      field('上游介面 (ip6-upstream-interface)', sel(ctx, () => i.gp6.name, (v) => { i.gp6.name = v; }, d.ifaces.filter((x) => x !== i).map((x) => [x.id, x.label]))),
      field('子網路 (ip6-subnet)', inp(ctx, () => i.gp6.suffix, (v) => { i.gp6.suffix = v; }, { ph: '::1:0:0:0:1/64', check: isCidr6 }))),
    (mode === 'static' || mode === 'delegated') && toggle(ctx, ...bind(i, 'ra'), '發送 Router Advertisement（ip6-send-adv）：電腦用 SLAAC 自己產生位址'),
    ctx.live(() => {
      const v = i.rt && i.rt.v6;
      if (!mode) return null;
      if (!v || !v.addrs.length) return note('warn', `還沒有 IPv6 位址${v && v.note ? '：' + v.note : ''}`);
      const gp = i.pd6 && ((d.rt && d.rt.gp) || {})[i.pd6];
      return note('ok', `${v.addrs.map((a) => fmtIp6(a.ip) + '/' + a.bits).join('、')}${gp && gp.prefix != null ? `；ISP 委派的前綴 ${fmtIp6(gp.prefix)}/${gp.bits}` : ''}`);
    }));
}

function fwPolicies(ctx, body) {
  const { dev } = ctx;
  const ifOpts = [['any', 'any（任何介面）'], ...dev.ifaces.map((i) => [i.id, i.label]),
    ...(sdwanOn(dev) ? [[ZONE, `${ZONE}（SD-WAN）`]] : []), ...(dev.vpns || []).map((t) => ['vpn:' + (t.name || 'VPN'), 'VPN ' + (t.name || 'VPN')])];
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
      ctx.state.v6 && grid2(
        field('IPv6 來源位址 (srcaddr6)', inp(ctx, () => p.src6 || '', (v) => { p.src6 = v; }, { ph: '留空＝不比對 IPv6；all 或 2001:db8::/32' })),
        field('IPv6 目的位址 (dstaddr6)', inp(ctx, () => p.dst6 || '', (v) => { p.dst6 = v; }, { ph: '留空＝不比對 IPv6；all 或 2001:db8::/32' }))),
      p.action === 'accept' && policyUtmFields(ctx, p),
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
        kv('ISP 閘道', i.ip), kv('子網路遮罩', i.mask), kv('DNS', ln.dns || '—'),
        ...(ln.v6 ? [kv('IPv6 鏈路', ln.v6.link || '—'), kv('委派的前綴 (DHCPv6 PD)', ln.v6.pd || '—')] : []),
        ...(ln.q ? [kv('線路品質', `延遲 ${ln.q.delay ?? 4} ms、抖動 ${ln.q.jitter ?? 1} ms、遺失 ${ln.q.loss ?? 0}%`)] : []))));
  }
  body.append(h('div', { class: 'card' }, cardHead('網際網路上的主機'),
    dev.inet.hosts.map((x) => h('div', { class: 'line' }, h('b', { text: x.name }), h('span', { class: 'mono muted', text: x.ip })))),
  // 故障模擬：和設備的電源鈕一樣，用來測試自己做的備援
  h('div', { class: 'card' }, cardHead('故障模擬'),
    h('div', { class: 'toggles' }, toggle(ctx, () => !!dev.inet.fault, (on) => { if (on) dev.inet.fault = true; else delete dev.inet.fault; }, '業者骨幹故障（線路燈號照常亮著，但封包出不去）', { rerender: true })),
    dev.inet.fault ? note('warn', '故障中：到這家業者閘道的 ping 還會通，再往外就全部丟掉。只看介面狀態的備援（浮動靜態路由）偵測不到這種故障。')
      : note('muted', '用來測試備援設計：線路斷掉（拔線）和業者內部故障，對路由器來說是兩回事。')),
  h('p', { class: 'tip', text: '這是電信業者與外面的世界，無法設定。私有 IP（10.x、172.16–31.x、192.168.x）在這裡無法路由。' }));
}

const T = {
  net: ['net', '網路設定', hostNet], term: ['term', '終端機', buildTerminal], ports: ['ports', '連接埠', plainPorts],
  swports: ['ports', '連接埠', swPorts], vlan: ['vlan', 'VLAN', swVlans], l3: ['l3', 'L3 介面', (ctx, body) => { swL3(ctx, body); loopbackCards(ctx, body); }], route: ['route', '路由', routesTab],
  status: ['status', '狀態', statusTab], sec: ['sec', '安全', X.secTab], mgmt: ['mgmt', '管理', X.mgmtTab], acl: ['acl', 'ACL', X.aclTab],
  vpn: ['vpn', 'VPN', X.vpnTab], ifs: ['if', '介面', rtIfaces], nat: ['nat', 'NAT / 轉發', forwardsTab],
};

function tabsFor(dev, state) {
  // 在機房裡、只能遠端管理的設備：沒有設定分頁（用 SSH 或 Console 線）
  if (dev.remoteOnly) return [['info', '設備資訊', remoteOnlyInfo]];
  const t = baseTabs(dev);
  // 場景裡有只能遠端管理的設備時，筆電多一個 Console 分頁（接 Console 線）
  if (/^laptop/.test(dev.model) && state && needsConsole(state)) t.push(['con', 'Console', consoleTab]);
  // 有兩個電源槽的設備（核心交換器、資料中心交換器、防火牆、機架伺服器）：電源分頁
  if (!dev.locked && hasPsuSlots(dev)) t.push(['power', '電源', powerTab]);
  // Cisco 的網路設備多一個唯讀的 IOS 風格 CLI
  if (!dev.locked && CATALOG[dev.model].vendor === 'Cisco' && ['router', 'mswitch', 'l3switch', 'wlc'].includes(dev.kind)) t.push(['cli', 'CLI', buildCli]);
  return t;
}

function baseTabs(dev) {
  if (dev.locked && dev.kind !== 'internet') return [['info', '設備資訊', X.lockedInfo]];
  switch (dev.kind) {
    case 'host': if (CATALOG[dev.model].phone) return [['phone', '電話', V.phoneTab], ['pnet', '網路設定', V.phoneNetTab]];
      return [T.net, dev.vpnClient && ['vpn', 'VPN', X.vpnClientTab], dev.dhcpScopes && ['dhcp', 'DHCP 服務', X.dhcpScopesTab],
      dev.radiusServer && ['radius', 'RADIUS', M.radiusServerTab], dev.ad && ['ad', 'Active Directory', M.adTab], dev.mail && ['mail', '郵件伺服器', M.mailServerTab], dev.mailClient && ['mailc', '郵件', M.mailClientTab], dev.tacacsServer && ['tacacs', 'TACACS+', M.tacacsServerTab], isDnsServer(dev) && ['dns', 'DNS', dnsTab],
      dev.web && ['web', '網站', webTab], dev.docker && ['docker', 'Docker', dockerTab],
      (dev.services || []).some((s) => s.proto === 'udp' && s.port === 514) && ['syslog', 'Syslog', M.syslogTab],
      (isTftp(dev) || isFtp(dev) || isScp(dev)) && ['files', '檔案', OPS.filesTab], dev.nms && ['nms', '網管', OPS.nmsTab], dev.cucm && ['cucm', 'CUCM', V.cucmTab],
      (dev.apps || []).includes('api') && ['api', 'API', AUTO.apiTab], dev.dnac && ['dnac', 'Catalyst Center', AUTO.dnacTab], ((dev.apps || []).includes('ansible') || dev.ansible) && ['ansible', 'Ansible', AUTO.ansibleTab], dev.tf && ['tf', 'Terraform', AUTO.terraformTab],
      dev.cam && ['cam', '攝影機', CAM.camTab], CATALOG[dev.model].nvr && ['nvr', '錄影', CAM.nvrTab],
      ((dev.mcastSrc || []).length || (dev.igmp || []).length) && ['mcast', '多點傳送', CAM.mcastTab],
      ['cap', '封包擷取', DG.captureTab], T.term].filter(Boolean);
    case 'hub': case 'switch': return [T.ports];
    case 'ap': return dev.lwap ? [['lwap', 'AP', W.lwapTab]] : [['ssid', '無線網路', X.ssidTab], ['radio', '無線電', X.radioTab], T.ports];
    case 'hypervisor': return [['vsw', '虛擬交換器', VZ.vswTab], ['vms', '虛擬機器', VZ.vmsTab], T.status];
    case 'lb': return [['if', 'Self IP', lbIfaces], T.route, ['vs', 'Virtual Servers', LTM.vsTab], ['pool', 'Pools', LTM.poolTab], ['mon', 'Monitors', LTM.monTab], T.status];
    case 'cloud': return dev.tgw ? [['tgw', 'Transit Gateway', CL.tgwTab]] : [['vpc', 'VPC', CL.vpcTab], ['sub', '子網路', CL.subnetTab], ['rtb', '路由表', CL.rtTab], ['ec2', 'EC2', CL.ec2Tab], ['sg', '安全群組', CL.sgTab], ['nacl', '網路 ACL', CL.naclTab], ['nat', 'NAT 閘道', CL.natTab], ['alb', '負載平衡器', CL.lbTab], ['pcx', 'Peering', CL.peeringTab], ['cvpn', 'VPN', CL.cloudVpnTab]];
    case 'wlc': return [['wlan', 'WLAN', W.wlanTab], ['aps', 'AP', W.apsTab], ['wcl', '用戶端', W.wlcClientsTab], ['wmi', '管理介面', W.wmiTab], T.swports];
    case 'mswitch': return [T.swports, T.vlan, T.sec, T.mgmt, T.status];
    case 'l3switch': return [T.swports, isStack(dev) && ['stack', '堆疊', stackTab], T.vlan, T.l3, T.route, T.sec, ['qos', 'QoS', V.qosTab], T.mgmt, T.status].filter(Boolean);
    case 'router': return [T.ifs, T.route, T.nat, T.acl, T.vpn, ['qos', 'QoS', V.qosTab], T.mgmt, T.status];
    case 'homerouter': return [['wan', '網際網路 (WAN)', hrWan], ['lan', '區域網路 (LAN)', hrLan], ['wifi', '無線網路', X.ssidTab], ['nat', '連接埠轉發', forwardsTab], T.status];
    case 'firewall': return [['if', '介面', fwIfaces], ['sdwan', 'SD-WAN', sdwanTab], ['pol', '政策', fwPolicies], ['utm', '安全設定檔', utmTab], ['nat', '虛擬 IP', forwardsTab], T.vpn, T.route, ['ha', 'HA', haTab], T.mgmt, ['log', '紀錄', M.logTab], T.status, ['fcli', 'CLI', buildFortiCli]];
    default: return [['info', '線路資訊', inetInfo]];
  }
}

const KIND_NAME = {
  host: '終端設備', hub: '集線器', switch: '交換器', mswitch: '網管型交換器', l3switch: 'L3 交換器',
  router: '路由器', homerouter: '家用路由器', firewall: '防火牆', ap: '無線基地台', wlc: '無線控制器', internet: 'ISP', cloud: '公有雲', hypervisor: '虛擬化主機', lb: '負載平衡器',
};

/** 把選取的設備畫到面板上；回傳 false 表示沒有選取設備 */
export function renderDevicePanel(app, root) {
  const dev = app.selected && app.state.devices[app.selected];
  app.refreshers = [];
  if (!dev) return false;
  const m = CATALOG[dev.model];
  const tabs = tabsFor(dev, app.state);
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
    // HA 的次要機：設定由主要機同步，在這裡改的會被蓋掉
    if (dev.kind === 'firewall') body.append(ctx.live(() => {
      const r = dev.rt && dev.rt.ha;
      return r && r.role === 'secondary' && cur !== 'ha' ? note('muted', `這台是 HA 的次要機：設定由主要機 ${(app.state.devices[r.peer] || {}).name || ''} 同步過來，在這裡改的設定會被主要機蓋掉（要改請到主要機）。`) : null;
    }));
  }
  const tabBar = tabs.length > 1 && h('div', { class: 'tabs' + (tabs.length > 8 ? ' many many9' : tabs.length > 7 ? ' many' : '') }, tabs.map(([id, label]) =>
    h('button', { type: 'button', class: 'tab' + (id === cur ? ' on' : ''), onclick: () => { app.panelTab[dev.id] = id; app.renderPanel(); } }, label)));
  root.dataset.view = viewKey;
  root.replaceChildren(...[
    h('div', { class: 'p-head k-' + dev.kind },
      h('div', { class: 'p-badge', text: m.phone ? 'IP 電話' : m.vm ? '虛擬機器' : m.ont ? '光纖數據機' : KIND_NAME[dev.kind] }),
      h('div', { class: 'p-title' },
        app.level.sandbox ? inp(ctx, () => dev.name, (v) => { if (v) dev.name = v; }, { mono: false, ph: '設備名稱' }) : h('h2', { text: dev.name }),
        h('p', { text: isStack(dev) ? `${m.title} ×${dev.stack.members.length}（StackWise-480 堆疊）` : m.title }), h('p', { class: 'muted', text: isStack(dev) ? `${dev.stack.members.length} 台堆疊成一台交換器 · 每台 24×GE + 4×10G SFP+ · 埠名稱的第一個數字是成員編號` : m.tagline })),
      isIos(dev) && ctx.live(() => {
        const dirty = iosDirty(app.state, dev);
        return h('button', {
          class: 'mini save' + (dirty ? ' dirty' : ''), type: 'button', disabled: !dirty,
          title: dirty ? '有尚未儲存的設定：點一下執行 write memory。沒有存檔就關機或 reload，這些設定會消失。' : '設定已儲存到 startup-config',
          onclick: () => { saveStartup(dev); toast(`${dev.name}：已把 running-config 存成 startup-config`, 'ok'); ctx.commit(false); },
        }, icon('save', 15));
      }),
      h('button', { class: 'mini annot' + ((app.state.notes || []).some((n) => n.at === dev.id) || (app.state.groups || []).some((g) => (g.devs || []).includes(dev.id)) ? ' on' : ''), type: 'button', title: '標註：註解與群組框', onclick: () => openAnnot(app, dev.id) }, icon('edit', 15)),
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
