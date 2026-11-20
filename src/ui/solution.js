// 參考解法：把關卡一開始的樣子和套用參考解法之後的樣子比一比，列出改了哪些地方
// Cisco 設備用 running-config 的差異（和 show archive config differences 一樣的格式），其他設備列出改了哪些欄位。
// 「示範」會把關卡重置、套用參考解法，再跑一次全部的測試給你看（不計星、不計分）。
import { h, icon, button, toast } from './dom.js';
import { cloneState } from '../engine/model.js';
import { settle } from '../engine/sim.js';
import { isIos, runningConfig } from '../engine/ios.js';
import { cfgDiff } from '../engine/archive.js';

const SKIP = new Set(['rt', 'pos', 'ports', 'startup', 'flash', 'fw', 'fwNext', 'note', 'locked', 'model', 'kind', 'id', 'seq', 'files', 'sshKey']);
const LABEL = {
  ip: 'IP 位址', mask: '遮罩', gateway: '預設閘道', dns: 'DNS', mode: '模式', vlan: 'VLAN', native: 'Native VLAN', allowed: '允許的 VLAN', shut: '停用 (shutdown)',
  ifaces: '介面', routes: '靜態路由', policies: '防火牆政策', portForwards: '連接埠轉發', staticNat: '靜態 NAT', vpns: 'VPN', sw: '交換', vlans: 'VLAN', stp: 'STP',
  prio: '優先權', dhcp: 'DHCP', start: '起始位址', end: '結束位址', on: '啟用', nat: 'NAT', ospf: 'OSPF', vrrp: 'VRRP / HSRP', vip: '虛擬 IP', wifi: 'Wi-Fi',
  ssids: 'SSID', sec: '加密', pass: '密碼', user: '帳號', mgmt: '管理', ssh: 'SSH', telnet: 'Telnet', allow: '允許的管理來源', dnsZone: 'DNS', records: '記錄', ttl: 'TTL',
  track: '追蹤', sla: 'IP SLA', vsw: '虛擬交換器', pgs: '連接埠群組', vmkPg: 'vmk0 的連接埠群組', ps: 'Port Security', bpduguard: 'BPDU Guard', rootguard: 'Root Guard',
  trust: 'DHCP Snooping 信任埠', lag: 'Port-channel', lagMode: 'LACP 模式', ad: '管理距離', dst: '目的', via: '下一站', services: '服務', name: '名稱', psk: '預先共用金鑰',
  peer: '對端', local: '本地網段', remote: '遠端網段', enc: '加密', hash: '雜湊', dh: 'DH 群組', snoop: 'DHCP Snooping', dai: 'DAI', aclIn: 'ACL（進）', aclOut: 'ACL（出）',
  preempt: 'preempt', group: '群組', proto: '協定', portfast: 'PortFast', voice: '語音 VLAN', ch24: '2.4 GHz 頻道', ch5: '5 GHz 頻道', power: '發射功率', radius: 'RADIUS',
  secret: '共用密鑰', dot1x: '802.1X', ospfNets: 'OSPF network 敘述', ospfPassive: 'OSPF 被動介面', ospfDefault: '發布預設路由', ospfRid: 'Router ID', bgp: 'BGP',
  neighbors: '鄰居', line: '線路', wan: 'WAN', lan: 'LAN', speed: '速率', duplex: '雙工', poe: 'PoE', dnsCache: 'DNS 快取', vpc: 'VPC', instances: 'EC2', subnets: '子網路',
  sgs: '安全群組', rules: '規則', tables: '路由表', inet: '網際網路', fault: '骨幹故障', archive: '設定封存', log: '紀錄',
};
const lab = (k) => LABEL[k] || k;
const show = (v) => {
  if (v === undefined || v === null || v === '') return '（無）';
  if (v === true) return '開';
  if (v === false) return '關';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.length ? v.map(show).join('、') : '（空）';
  const e = Object.entries(v).filter(([k, x]) => !SKIP.has(k) && x !== '' && x != null && typeof x !== 'object');
  return e.slice(0, 5).map(([k, x]) => `${lab(k)} ${show(x)}`).join('，') + (e.length > 5 ? '…' : '');
};
const keyOf = (x) => (x && typeof x === 'object' ? x.id ?? x.name ?? null : null);

/** 兩個設定物件的差異：[{ path: [標籤…], from, to }] 或 [{ path, add | del }] */
function diffVal(path, a, b, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (obj(a) && obj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!SKIP.has(k)) diffVal([...path, lab(k)], a[k], b[k], out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyed = [...a, ...b].every((x) => keyOf(x) != null);
    if (keyed) {
      const ka = new Map(a.map((x) => [keyOf(x), x])), kb = new Map(b.map((x) => [keyOf(x), x]));
      for (const k of new Set([...ka.keys(), ...kb.keys()])) {
        if (!ka.has(k)) out.push({ path: [...path], add: kb.get(k) });
        else if (!kb.has(k)) out.push({ path: [...path], del: ka.get(k) });
        else diffVal([...path, String(k)], ka.get(k), kb.get(k), out);
      }
      return;
    }
    const sa = a.map((x) => JSON.stringify(x)), sb = b.map((x) => JSON.stringify(x));
    b.forEach((x, n) => { if (!sa.includes(sb[n])) out.push({ path: [...path], add: x }); });
    a.forEach((x, n) => { if (!sb.includes(sa[n])) out.push({ path: [...path], del: x }); });
    return;
  }
  out.push({ path, from: a, to: b });
}

/** 參考解法改了什麼：{ cables: [文字], devs: [{ name, ios, lines }] } */
export function solutionChanges(lv) {
  const s0 = lv.setup();
  settle(s0);
  const s1 = cloneState(s0);
  lv.solve(s1);
  settle(s1);
  const name = (s, id) => (s.devices[id] ? s.devices[id].name : id);
  const pl = (s, e) => { const d = s.devices[e.dev], p = d && d.ports.find((x) => x.id === e.port); return `${name(s, e.dev)} ${p ? p.label : e.port}`; };
  const ck = (c) => [c.a.dev + ':' + c.a.port, c.b.dev + ':' + c.b.port].sort().join('|');
  const k0 = new Set(s0.cables.map(ck)), k1 = new Set(s1.cables.map(ck));
  const cables = [
    ...s1.cables.filter((c) => !k0.has(ck(c))).map((c) => `接線：${pl(s1, c.a)} ↔ ${pl(s1, c.b)}`),
    ...s0.cables.filter((c) => !k1.has(ck(c))).map((c) => `拔掉：${pl(s0, c.a)} ↔ ${pl(s0, c.b)}`),
  ];
  const devs = [];
  // 比對用的副本：拿掉執行期的狀態（rt），虛擬化主機的 vSwitch VLAN 是從連接埠群組算出來的，也不列
  const c0 = cloneState(s0), c1 = cloneState(s1);
  for (const c of [c0, c1]) for (const d of Object.values(c.devices)) if (d.kind === 'hypervisor') { delete d.sw; for (const i of d.ifaces) delete i.bind; }
  for (const id of Object.keys(s1.devices)) {
    const a = s0.devices[id], b = s1.devices[id];
    if (!a) { devs.push({ name: b.name, ios: false, lines: ['（新增的設備）'] }); continue; }
    if (isIos(b)) {
      const lines = cfgDiff(runningConfig(s0, a), runningConfig(s1, b));
      if (lines.length) devs.push({ name: b.name, ios: true, lines });
      continue;
    }
    const out = [];
    diffVal([], c0.devices[id], c1.devices[id], out);
    if (out.length) devs.push({ name: b.name, ios: false, lines: out.map((x) => `${x.path.join(' › ')}${x.add !== undefined ? '：新增 ' + show(x.add) : x.del !== undefined ? '：移除 ' + show(x.del) : `：${show(x.from)} → ${show(x.to)}`}`) });
  }
  if (JSON.stringify(s0.down || {}) !== JSON.stringify(s1.down || {})) devs.push({ name: '電源', ios: false, lines: [`關機中的設備：${Object.keys(s1.down || {}).map((id) => name(s1, id)).join('、') || '（無）'}`] });
  return { cables, devs };
}

/** 參考解法的對話框 */
export function openSolution(app, { modal, closeModal }) {
  const lv = app.level;
  let ch;
  try { ch = solutionChanges(lv); } catch (e) { toast('這一關的參考解法沒辦法用比對的方式呈現：' + e.message, 'bad'); return; }
  const dlg = modal([
    h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('route', 30)),
      h('div', null, h('h1', { text: '參考解法' }), h('p', { text: '從關卡一開始的樣子出發，參考解法改了下面這些地方。這只是其中一種做法：只要目標都通過，用別的方法也可以。' }))),
    ch.cables.length ? h('section', { class: 'sol-sec' }, h('h3', { text: '接線' }), h('div', { class: 'sol-list' }, ch.cables.map((t) => h('div', { text: t })))) : null,
    ...ch.devs.map((d) => h('section', { class: 'sol-sec' }, h('h3', null, d.name, d.ios && h('span', { class: 'chip tiny', text: 'running-config 的差異' })),
      h('div', { class: 'sol-list' + (d.ios ? ' mono' : '') }, d.lines.map((t) => h('div', { class: d.ios ? (/^\s*\+/.test(t) ? 'add' : /^\s*-/.test(t) ? 'del' : 'ctx') : '', text: t }))))),
    !ch.cables.length && !ch.devs.length ? h('p', { class: 'muted', text: '參考解法沒有改任何設定（這一關的答案在操作上，例如清除快取、重新開機）。看看提示的最後一個。' }) : null,
    h('p', { class: 'muted', style: { fontSize: '12px' }, text: 'running-config 的差異：+ 是要加上的設定、- 是要拿掉的設定，前面沒有符號的那一行是它所在的區塊（例如哪一個介面）。' }),
    h('div', { class: 'd-actions' }, button('關閉', { kind: 'ghost', onclick: closeModal }),
      button('示範一次（重置並套用，不計星）', { ic: 'play', kind: 'primary', onclick: () => { closeModal(); demo(app); } })),
  ], { wide: true });
  dlg.classList.add('sol');
}

/** 示範：重置關卡、套用參考解法、跑一次全部的測試 */
async function demo(app) {
  const lv = app.level;
  app.openLevel(lv, { fresh: true });
  lv.solve(app.state);
  app.attempt.demo = true;
  app.changed();
  app.settleNow();
  app.renderPanel();
  toast('已套用參考解法：接著跑一次全部的測試。這一次不計星；按「重置」可以自己再做一次。', 'ok', 5000);
  await app.run();
}
