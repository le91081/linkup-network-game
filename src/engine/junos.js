// Juniper Junos（EX 系列交換器）
//
// Junos 和 IOS 最大的不同：設定是「候選設定 (candidate)」，改完要 commit 才生效；commit 之前可以 show | compare 看差異、
// rollback 回到之前的版本。設定是一棵樹，這裡用 set 指令的形式存（show configuration | display set 看到的那種）。
//
// d.junos = { active: [set 指令…], candidate: null | [set 指令…], commits: [{ at, lines }] }
// commit 時依 active 重建交換器的設定 (d.sw)：VLAN、每個埠的 access / trunk、vlan members、native-vlan-id、disable、irb 的位址
// 和 Cisco 接在一起要注意：Junos 不會 DTP（Catalyst 的 dynamic auto 會一直停在 access）；
// Junos 的 trunk 預設沒有 native VLAN，不帶標籤的訊框直接丟掉，要 native-vlan-id（而且那個 VLAN 也要在 vlan members 裡）
import { parseIp, maskOf, fmtIp } from './ip.js';

export const isJunos = (d) => !!(d && d.junos);
export const JUNOS_DEFAULT = ['set system host-name EX2300', 'set vlans default vlan-id 1', 'set protocols rstp'];
const portOf = (d, name) => d.ports.find((p) => p.id === name);
const tokens = (s) => s.replace(/\[|\]/g, ' ').trim().split(/\s+/).filter(Boolean);

/** 把 set 指令解析成設定的結構 */
function parse(lines) {
  const cfg = { host: 'EX2300', vlans: {}, ifs: {}, irb: {}, l3: {}, rstp: false };
  for (const l of lines) {
    const t = tokens(l);
    if (t[0] !== 'set') continue;
    if (t[1] === 'system' && t[2] === 'host-name') cfg.host = t[3];
    else if (t[1] === 'protocols' && t[2] === 'rstp') cfg.rstp = true;
    else if (t[1] === 'vlans') {
      const v = (cfg.vlans[t[2]] ||= {});
      if (t[3] === 'vlan-id') v.id = +t[4];
      if (t[3] === 'l3-interface') v.l3 = t[4];
    } else if (t[1] === 'interfaces' && t[2] === 'irb') {
      if (t[3] === 'unit' && t[5] === 'family' && t[6] === 'inet' && t[7] === 'address') cfg.irb[t[4]] = t[8];
    } else if (t[1] === 'interfaces') {
      const f = (cfg.ifs[t[2]] ||= { members: [] });
      if (t[3] === 'disable') f.disable = true;
      else if (t[3] === 'native-vlan-id') f.native = +t[4];
      else if (t[3] === 'description') f.desc = t.slice(4).join(' ');
      else if (t[3] === 'unit' && t[5] === 'family' && t[6] === 'ethernet-switching') {
        if (t[7] === 'interface-mode') f.mode = t[8];
        if (t[7] === 'vlan' && t[8] === 'members') f.members.push(...t.slice(9));
      }
    }
  }
  return cfg;
}
const vlanId = (cfg, m) => (/^\d+$/.test(m) ? +m : cfg.vlans[m] ? cfg.vlans[m].id : null);

/** commit check：回傳錯誤訊息的陣列（Junos 的格式） */
export function commitCheck(d, lines) {
  const cfg = parse(lines), errs = [];
  const ids = {};
  for (const [n, v] of Object.entries(cfg.vlans)) {
    if (!(v.id >= 1 && v.id <= 4094)) errs.push(`vlans ${n}: vlan-id 沒有設定（set vlans ${n} vlan-id <1-4094>）`);
    else if (ids[v.id]) errs.push(`vlans ${n}: vlan-id ${v.id} 和 ${ids[v.id]} 重複`);
    else ids[v.id] = n;
  }
  for (const [name, f] of Object.entries(cfg.ifs)) {
    if (!portOf(d, name)) { errs.push(`interfaces ${name}: 這台交換器沒有這個介面`); continue; }
    for (const m of f.members) if (vlanId(cfg, m) == null || !Object.values(cfg.vlans).some((v) => v.id === vlanId(cfg, m))) errs.push(`interfaces ${name} unit 0 family ethernet-switching vlan members ${m}: VLAN「${m}」沒有定義（set vlans ${m} vlan-id …）`);
    if (f.mode !== 'trunk' && f.members.length > 1) errs.push(`interfaces ${name}: access 模式只能有一個 VLAN（要多個 VLAN 改成 interface-mode trunk）`);
    if (f.native != null) {
      if (f.mode !== 'trunk') errs.push(`interfaces ${name}: native-vlan-id 只用在 trunk`);
      else if (!f.members.some((m) => vlanId(cfg, m) === f.native)) errs.push(`interfaces ${name}: native-vlan-id ${f.native} 也要放進 vlan members`);
    }
  }
  for (const [n, v] of Object.entries(cfg.vlans)) if (v.l3 && !cfg.irb[String(v.l3).replace(/^irb\./, '')]) errs.push(`vlans ${n}: l3-interface ${v.l3} 沒有設定位址`);
  return errs;
}

/** 依 active 的設定重建交換器 */
export function applyJunos(d) {
  const cfg = parse(d.junos.active);
  d.junosHost = cfg.host;
  d.sw.vlans = Object.entries(cfg.vlans).filter(([, v]) => v.id >= 1).map(([name, v]) => ({ id: v.id, name })).sort((a, b) => a.id - b.id);
  if (!d.sw.vlans.some((v) => v.id === 1)) d.sw.vlans.unshift({ id: 1, name: 'default' });
  for (const p of d.ports) {
    const f = cfg.ifs[p.id] || { members: [] }, pc = d.sw.ports[p.id];
    const ids = f.members.map((m) => vlanId(cfg, m)).filter((x) => x != null);
    if (f.mode === 'trunk') Object.assign(pc, { mode: 'trunk', allowed: ids.length ? ids.join(',') : '0', native: f.native ?? 0, vlan: 1 });
    else Object.assign(pc, { mode: 'access', vlan: ids[0] || 1, native: 1, allowed: 'all' });
    pc.shut = !!f.disable;
    if (f.desc) pc.desc = f.desc; else delete pc.desc;
  }
  d.sw.stp = { ...(d.sw.stp || {}), on: cfg.rstp };
  // 管理位址：irb 的 unit（掛在某個 VLAN 的 l3-interface）
  const mg = d.ifaces.find((i) => i.id === 'mgmt');
  const vl = Object.values(cfg.vlans).find((v) => v.l3), unit = vl && String(vl.l3).replace(/^irb\./, '');
  const addr = unit != null && cfg.irb[unit];
  if (mg) {
    if (addr) { const [ip, len] = addr.split('/'); Object.assign(mg, { mode: 'static', ip, mask: fmtIp(maskOf(+len)) }); mg.bind.vlan = vl.id; mg.label = 'irb.' + unit; }
    else Object.assign(mg, { mode: 'static', ip: '', mask: '' });
  }
}

/** 候選設定和現在生效的設定差在哪（show | compare） */
export function compareLines(d) {
  const a = d.junos.active, c = d.junos.candidate || a;
  return [...a.filter((l) => !c.includes(l)).map((l) => '- ' + l), ...c.filter((l) => !a.includes(l)).map((l) => '+ ' + l)];
}
export const junosDirty = (d) => !!d.junos.candidate && compareLines(d).length > 0;
export { parse as parseJunos };
export const junosIp = (s) => { const [ip, len] = String(s || '').split('/'); return parseIp(ip) != null && +len >= 0 && +len <= 32; };
