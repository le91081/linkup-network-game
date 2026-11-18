// IOS 風格的設定指令：把 configure terminal 之後輸入的指令套用到設備的設定物件上。
// 不依賴瀏覽器，可以直接用 Node 測試。支援的範圍就是 show running-config 會印出來的那些指令，
// 所以把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定。
import { parseIp, fmtIp, parseMask, fmtMask, maskOf, netOf, bcastOf } from './ip.js';
import { parseCidr6, parseIp6 } from './ip6.js';
import { newIface } from './model.js';
import { macsBehind } from './sim.js';

export const hostName = (dev) => dev.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'Device';
export const aclName = (i, dir) => (i.aclNames && i.aclNames[dir]) || `${i.label.replace(/[^\w.]+/g, '_')}_${dir}`.toUpperCase();
export const poolName = (i) => (i.dhcp && i.dhcp.pool) || i.label.replace(/[^\w.]+/g, '_').toUpperCase();

const isSw = (d) => !!d.sw && d.sw.mode === 'vlan';
const TYPES = { gi: 'gigabitethernet', te: 'tengigabitethernet', fa: 'fastethernet', eth: 'ethernet' };
const PROMPT = {
  exec: '#', config: '(config)#', if: '(config-if)#', vlan: '(config-vlan)#', router: '(config-router)#', dhcp: '(dhcp-config)#',
  line: '(config-line)#', acl: '(config-ext-nacl)#', stdacl: '(config-std-nacl)#', radius: '(config-radius-server)#',
  isakmp: '(config-isakmp)#', tset: '(cfg-crypto-trans)#', cmap: '(config-crypto-map)#',
};
const SERVICE_PORT = { www: 80, http: 80, https: 443, domain: 53, dns: 53, ssh: 22, telnet: 23, ftp: 21, smtp: 25, ntp: 123, snmp: 161, tftp: 69 };

// 設定檔裡的密碼不是明文：和真的 IOS 一樣，印出來的字串可以原樣貼回另一台設備
const hex = (s) => [...String(s)].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const unhex = (h) => (h.match(/.{4}/g) || []).map((x) => String.fromCharCode(parseInt(x, 16))).join('');
const secret9 = (s) => '$9$' + hex(s);
/** 解析 [類型] 密碼：0 或沒寫類型是明文，7 與 9 是 running-config 印出來的編碼 */
function readSecret(tok) {
  if (tok.length < 2 || !/^[0579]$/.test(tok[0])) return tok[0] || '';
  const v = tok[1];
  if (tok[0] === '9' && /^\$9\$([0-9a-f]{4})*$/i.test(v)) return unhex(v.slice(3));
  if (tok[0] === '7' && /^([0-9a-f]{4})+$/i.test(v)) return unhex(v);
  return v;
}

// ── IPsec VPN（crypto map）和設定物件之間的對應 ──
const ENC_IOS = { aes128: 'aes', aes256: 'aes 256' };
const HASH_IOS = { sha1: 'sha', sha256: 'sha256' };
const cmapOf = (t) => t.cmap || 'CMAP';
const seqOf = (d, t) => t.seq || (d.vpns.indexOf(t) + 1) * 10;
const tsetOf = (t) => t.tset || `ESP-${(t.enc2 || t.enc || 'aes128').toUpperCase()}-${(t.hash2 || t.hash || 'sha1').toUpperCase()}`;
const vpnAclOf = (t) => t.acl || 'VPN-' + String(t.name || 'VPN').replace(/[^\w.-]+/g, '_').toUpperCase();
const splitList = (s) => String(s || '').split(/[,\s]+/).filter(Boolean);
/** 通道的本地 / 遠端網段 → 定義「哪些流量要加密」的 ACL 規則 */
const selRules = (t) => splitList(t.local).flatMap((src) => splitList(t.remote).map((dst) => ({ action: 'permit', proto: 'ip', src, dst, port: '' })));
/** 這台設備的第一階段政策：用指令設定過就是那一份，否則從各通道的設定整理出來 */
function isakmpOf(d) {
  if (d.isakmp && d.isakmp.length) return d.isakmp;
  const out = [];
  for (const t of d.vpns || []) {
    const p = { enc: t.enc || 'aes128', hash: t.hash || 'sha1', dh: String(t.dh || '2') };
    if (!out.some((x) => x.enc === p.enc && x.hash === p.hash && x.dh === p.dh)) out.push({ n: (out.length + 1) * 10, ...p });
  }
  return out;
}
/** ACL 改了之後，把它套回引用這份 ACL 的通道 */
function syncVpnAcl(d, name) {
  const rules = ((d.aclDefs || {})[name] || []).filter((r) => r.action === 'permit');
  const uniq = (k) => [...new Set(rules.map((r) => (r[k] === 'any' ? '0.0.0.0/0' : r[k])))].join(', ');
  for (const t of d.vpns || []) if (t.acl === name) { t.local = uniq('src'); t.remote = uniq('dst'); }
}

const err = (s) => '% ' + s;
const isErr = (r) => typeof r === 'string' && r.startsWith('%');
const dotted = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s || '');
const maskBits = (s) => (dotted(s) ? parseMask(s) : null);
const wildBits = (s) => (dotted(s) && parseIp(s) != null ? parseMask(fmtIp(~parseIp(s) >>> 0)) : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 比對指令樣式：文字只要打出開頭幾個字母（IOS 的縮寫），<x> 是參數，<...> 吃掉剩下所有字，[...] 則可以是空的 */
function match(tok, pattern) {
  const pt = pattern.split(' ');
  const args = [];
  for (let n = 0; n < pt.length; n++) {
    const p = pt[n];
    if (p === '<...>') return tok.length > n ? [...args, tok.slice(n).join(' ')] : null;
    if (p === '[...]') return [...args, tok.slice(n).join(' ')];
    const t = tok[n];
    if (t == null) return null;
    if (p[0] === '<') args.push(t);
    else if (!p.startsWith(t.toLowerCase())) return null;
  }
  return tok.length === pt.length ? args : null;
}

function findPort(dev, type, path) {
  return dev.ports.find((x) => {
    const m = x.label.toLowerCase().match(/^([a-z]+)([\d/]+)$/);
    return !!m && m[2] === path && ((TYPES[m[1]] || m[1]).startsWith(type) || m[1] === type);
  });
}

/** 把輸入的介面名稱（可以縮寫，例如 gi0/1、g0/0/0.10、vlan 10）對應到設備上的埠或 L3 介面 */
function resolveIf(dev, text) {
  const s = text.toLowerCase().replace(/\s+/g, '');
  const vl = s.match(/^vl[a-z]*(\d+)$/);
  if (vl) {
    const v = +vl[1];
    if (v < 1 || v > 4094) return err('VLAN ID 必須是 1 – 4094');
    if (dev.kind === 'mswitch') return { name: 'Vlan' + v, iface: dev.ifaces.find((x) => x.id === 'mgmt'), mgmtVlan: v };
    if (dev.kind !== 'l3switch') return err('這台設備沒有 VLAN 介面。路由器請用子介面，例如 interface Gi0/0/0.10');
    let i = dev.ifaces.find((x) => x.bind.t === 'svi' && x.bind.vlan === v);
    if (!i) { i = newIface('vlan' + v, 'Vlan' + v, { t: 'svi', vlan: v }); dev.ifaces.push(i); }
    return { name: 'Vlan' + v, iface: i };
  }
  const m = s.match(/^([a-z]+)([\d/]+)(?:\.(\d+))?$/);
  const p = m && findPort(dev, m[1], m[2]);
  if (!p) return err(`找不到介面「${text}」。這台設備的介面：${dev.ports.slice(0, 4).map((x) => x.label).join('、')}${dev.ports.length > 4 ? ' …' : ''}`);
  if (m[3] != null) {
    if (dev.kind !== 'router') return err('只有路由器可以建立子介面');
    const id = `${p.id}.${+m[3]}`;
    let i = dev.ifaces.find((x) => x.bind.t === 'sub' && x.id === id);
    if (!i) { i = newIface(id, `${p.label}.${+m[3]}`, { t: 'sub', port: p.id, vlan: +m[3] }); dev.ifaces.push(i); }
    return { name: i.label, iface: i, sub: true };
  }
  return { name: p.label, port: p, pc: isSw(dev) ? dev.sw.ports[p.id] : null, iface: dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id) || null };
}

/** interface range gi0/1 - 4 , gi0/7 - 8 */
function resolveRange(dev, text) {
  const out = [];
  for (const part of text.toLowerCase().replace(/\s+/g, '').split(',')) {
    const m = part.match(/^([a-z]+)((?:\d+\/)*)(\d+)-(\d+)$/);
    if (!m) { const one = resolveIf(dev, part); if (isErr(one)) return one; out.push(one); continue; }
    for (let n = +m[3]; n <= +m[4]; n++) {
      const one = resolveIf(dev, m[1] + m[2] + n);
      if (isErr(one)) return one;
      out.push(one);
    }
  }
  return out.length ? out : err('用法：interface range gi0/1 - 4');
}

const staticNet = (i) => {
  const ip = parseIp(i.ip || ''), bits = parseMask(i.mask || '');
  return i.mode === 'static' && ip != null && bits != null ? { ip, bits, net: netOf(ip, bits) } : null;
};

/** 依排除清單算出位址池的起訖 */
function applyPoolRange(dev, i) {
  const n = staticNet(i);
  if (!n) return;
  let a = n.net + 1, b = bcastOf(n.ip, n.bits) - 1;
  for (const [x, y] of (dev.dhcpExcl || []).slice().sort((p, q) => p[0] - q[0])) {
    if (y < a || x > b) continue;
    if (x - a <= b - y) a = y + 1; else b = x - 1;
  }
  i.dhcp.start = fmtIp(a); i.dhcp.end = fmtIp(b);
}

/** 保留位址在 IOS 裡是一個只有一台主機的位址池 (manual binding) */
export const rsvName = (r) => r.pool || 'HOST-' + String(r.ip || '').replace(/\./g, '-');
const colonMac = (s) => { const h = String(s || '').toLowerCase().replace(/[.:-]/g, ''); return /^[0-9a-f]{12}$/.test(h) ? h.match(/../g).join(':') : null; };

/** 還沒有對應介面的位址池（先建 pool、後設介面 IP 的情況）在這裡補接上去 */
function attachPools(dev) {
  let rest = [];
  for (const p of dev.dhcpPools || []) {
    const i = p.net != null && dev.ifaces.find((x) => { const n = staticNet(x); return n && n.bits === p.bits && n.net === p.net; });
    if (!i) { rest.push(p); continue; }
    Object.assign(i.dhcp, { on: true, pool: p.name, gw: p.gw || '', dns: p.dns || '' });
    applyPoolRange(dev, i);
  }
  // 單一主機的位址池：掛到有 DHCP 伺服器、而且包含這個 IP 的介面上
  const pending = rest;
  rest = [];
  for (const p of pending) {
    const ip = parseIp(p.host || '');
    const i = ip != null && p.mac && dev.ifaces.find((x) => { const n = staticNet(x); return n && x.dhcp && x.dhcp.on && netOf(ip, n.bits) === n.net; });
    if (!i) { rest.push(p); continue; }
    const list = (i.dhcp.reserved ||= []);
    const cur = list.find((r) => rsvName(r) === p.name);
    if (cur) Object.assign(cur, { mac: p.mac, ip: p.host });
    else list.push({ mac: p.mac, ip: p.host, pool: p.name });
  }
  if (dev.dhcpPools) dev.dhcpPools = rest;
}

function parseAclRule(tok) {
  let n = 0;
  if (/^\d+$/.test(tok[0])) n++;
  const action = ['permit', 'deny'].find((a) => a.startsWith((tok[n] || ' ').toLowerCase()));
  const proto = (tok[n + 1] || '').toLowerCase();
  if (!action || !['ip', 'tcp', 'udp', 'icmp'].includes(proto)) return null;
  n += 2;
  const addr = () => {
    const t = (tok[n] || '').toLowerCase();
    if (t === 'any') { n++; return 'any'; }
    if (t === 'host' && parseIp(tok[n + 1] || '') != null) { n += 2; return tok[n - 1]; }
    const ip = parseIp(t), bits = wildBits(tok[n + 1]);
    if (ip == null || bits == null) return null;
    n += 2;
    return bits === 32 ? fmtIp(ip) : `${fmtIp(netOf(ip, bits))}/${bits}`;
  };
  const src = addr(), dst = src && addr();
  if (!src || !dst) return null;
  let port = '';
  if ((tok[n] || '').toLowerCase() === 'eq') {
    const p = (tok[n + 1] || '').toLowerCase();
    port = String(SERVICE_PORT[p] || p);
    if (!/^\d+$/.test(port)) return null;
  }
  return { action, proto, src, dst, port: proto === 'tcp' || proto === 'udp' ? port : '' };
}

const HELP = {
  exec: ['configure terminal    進入設定模式', 'show ...              查看狀態（輸入 show ? 列出全部）', 'ping <IP>             測試連線', 'write memory          儲存設定'],
  config: ['hostname <名稱>', 'interface <介面> | interface range <介面> - <n> | interface vlan <ID>', 'vlan <ID>', 'ip route <網段> <遮罩> <下一站> [距離]',
    'router ospf 1', 'ip dhcp pool <名稱> / ip dhcp excluded-address <起> <迄>', 'ip nat inside source list 1 interface <介面> overload',
    'ip nat inside source static <內部 IP> <公用 IP>', 'ip access-list extended <名稱>', 'spanning-tree vlan <清單> priority <值>',
    'ip dhcp snooping / ip arp inspection vlan <清單>', 'line vty 0 4', 'ntp server / logging host / snmp-server community', 'do <show 指令>、end、exit'],
  if: ['ip address <IP> <遮罩> | ip address dhcp', 'shutdown / no shutdown', 'switchport mode access|trunk', 'switchport access vlan <ID>',
    'switchport trunk native vlan <ID> / allowed vlan <清單>', 'no switchport（L3 交換器改成 Routed 埠）', 'ip nat inside|outside', 'ip helper-address <IP>',
    'ip ospf cost <值>', 'ip access-group <名稱> in|out', 'encapsulation dot1q <VLAN>（子介面）', 'vrrp 1 ip <虛擬 IP> / vrrp 1 priority <值>',
    'channel-group <編號> mode active|passive|on', 'switchport port-security [mac-address <MAC> | violation <模式>]',
    'spanning-tree bpduguard enable / spanning-tree guard root', 'ip dhcp snooping trust', 'ipv6 address <位址/前綴>'],
  vlan: ['name <名稱>'],
  router: ['network <網段> <萬用遮罩> area 0', 'default-information originate'],
  dhcp: ['network <網段> <遮罩>', 'default-router <IP>', 'dns-server <IP> [IP]', 'host <IP> <遮罩> 加上 hardware-address <MAC>（保留位址）'],
  line: ['transport input ssh | telnet | all | none', 'access-class <名稱> in', 'login local'],
  acl: ['permit|deny <ip|tcp|udp|icmp> <來源> <目的> [eq <埠>]', '來源 / 目的的寫法：any、host <IP>、<網段> <萬用遮罩>', 'no <序號>   刪除一條規則'],
  stdacl: ['permit <網段> <萬用遮罩> | permit host <IP>'],
  radius: ['address ipv4 <IP>', 'key <共用密鑰>'],
  isakmp: ['encryption aes | aes 256', 'hash sha | sha256', 'group 2 | 5 | 14 | 19', 'authentication pre-share'],
  tset: ['mode tunnel'],
  cmap: ['set peer <對端 IP>', 'set transform-set <名稱>', 'set pfs group14', 'match address <ACL 名稱>', 'description <通道名稱>'],
};

/**
 * 建立一個 CLI 工作階段。getDev() 回傳目前的設備物件，getState() 回傳目前的狀態。
 * exec(line) 回傳 { out: [文字…], changed: 是否改了設定, pass: 這一行不是設定指令（交給 show / ping 處理） }
 */
export function iosSession(getDev, getState) {
  const S = { mode: 'exec', cur: null };
  const dev = () => getDev();

  // ── 介面模式 ──
  const each = (fn) => { for (const t of S.cur) { const r = fn(t); if (isErr(r)) return r; } return undefined; };
  const l3 = (t) => (t.iface && (!t.pc || t.pc.mode === 'routed') ? null : err(`${t.name} 是第二層的連接埠，不能設定 IP 相關的指令${dev().kind === 'l3switch' ? '（先下 no switchport）' : ''}`));
  const l2 = (t) => (t.pc ? null : err(`${t.name} 不是交換器的連接埠`));
  const onL3 = (fn) => each((t) => l3(t) || fn(t.iface, t));
  const onL2 = (fn) => each((t) => l2(t) || fn(t.pc, t));
  const ensureVlan = (id, out) => {
    const sw = dev().sw;
    if (sw.vlans.some((v) => v.id === id)) return;
    sw.vlans.push({ id, name: 'VLAN' + String(id).padStart(4, '0') });
    out.push(`% Access VLAN does not exist. Creating vlan ${id}`);
  };
  const syncNat = () => {
    for (const i of dev().ifaces) {
      if (i.nat) i.natOut = i.natRule = true;
      else if (i.natOut && i.natRule) i.natOut = i.natRule = false; // 在圖形介面關掉了
    }
  };
  const setNat = (i) => { i.nat = !!(i.natOut && i.natRule); };
  const bindAcl = (i, name, dir) => {
    const d = dev(), key = dir === 'in' ? 'aclIn' : 'aclOut';
    const def = (d.aclDefs || {})[name];
    const other = d.ifaces.flatMap((x) => [['in', 'aclIn'], ['out', 'aclOut']].filter(([dd, k]) => (x !== i || dd !== dir) && x[k] && x[k].length && aclName(x, dd) === name).map(([, k]) => x[k]))[0];
    if (def) { i[key] = def.map((r) => ({ ...r })); delete d.aclDefs[name]; } else if (other) i[key] = other.map((r) => ({ ...r }));
    (i.aclNames ||= {})[dir] = name;
    if (!i[key]) i[key] = [];
  };

  const IF = [
    ['ip address dhcp', () => onL3((i) => { i.mode = 'dhcp'; })],
    ['ip address <ip> <mask>', ([ip, mask]) => {
      if (parseIp(ip) == null) return err('IP 位址的格式不正確');
      if (maskBits(mask) == null) return err('子網路遮罩的格式不正確，例如 255.255.255.0');
      const r = onL3((i, t) => { if (t.mgmtVlan) i.bind.vlan = t.mgmtVlan; Object.assign(i, { mode: 'static', ip, mask }); });
      attachPools(dev());
      return r;
    }],
    ['no ip address', () => onL3((i) => { Object.assign(i, { mode: 'static', ip: '', mask: '' }); })],
    ['pppoe-client [...]', () => onL3((i) => { i.mode = 'pppoe'; }) || 'PPPoE 的帳號與密碼請到「介面」分頁填寫'],
    ['ip nat outside', () => {
      syncNat();
      const r = onL3((i) => { i.natOut = true; setNat(i); });
      return r || (S.cur.some((t) => t.iface && !t.iface.nat) ? '（還要在設定模式下 ip nat inside source list 1 interface <這個介面> overload，才會開始轉換位址）' : undefined);
    }],
    ['no ip nat outside', () => { syncNat(); return onL3((i) => { i.natOut = false; setNat(i); }); }],
    ['ip nat inside', () => onL3(() => {})],
    ['no ip nat inside', () => onL3(() => {})],
    ['ip helper-address <ip>', ([ip]) => (parseIp(ip) == null ? err('IP 位址的格式不正確') : onL3((i) => { i.helper = ip; }))],
    ['no ip helper-address [...]', () => onL3((i) => { i.helper = ''; })],
    ['ip ospf cost <n>', ([n]) => (+n >= 1 && +n <= 65535 ? onL3((i) => { i.ospfCost = String(+n); }) : err('cost 必須是 1 – 65535'))],
    ['no ip ospf cost', () => onL3((i) => { i.ospfCost = ''; })],
    ['ip ospf <pid> area <a>', () => onL3((i) => { i.ospf = true; })],
    ['no ip ospf <pid> area <a>', () => onL3((i) => { i.ospf = false; })],
    ['ip access-group <name> <dir>', ([name, dir]) => (['in', 'out'].includes(dir.toLowerCase()) ? onL3((i) => bindAcl(i, name.toUpperCase(), dir.toLowerCase())) : err('方向必須是 in 或 out'))],
    ['no ip access-group <name> <dir>', ([, dir]) => onL3((i) => { i[dir.toLowerCase() === 'in' ? 'aclIn' : 'aclOut'] = []; if (i.aclNames) delete i.aclNames[dir.toLowerCase()]; })],
    ['vrrp <g> ip <vip>', ([, vip]) => (parseIp(vip) == null ? err('IP 位址的格式不正確') : onL3((i) => { Object.assign((i.vrrp ||= { on: false, vip: '', prio: '100' }), { on: true, vip }); }))],
    ['vrrp <g> priority <n>', ([, n]) => (+n >= 1 && +n <= 254 ? onL3((i) => { (i.vrrp ||= { on: false, vip: '', prio: '100' }).prio = String(+n); }) : err('priority 必須是 1 – 254'))],
    ['no vrrp <g>', () => onL3((i) => { if (i.vrrp) i.vrrp.on = false; })],
    ['standby <g> ip <vip>', ([, vip]) => (parseIp(vip) == null ? err('IP 位址的格式不正確') : onL3((i) => { Object.assign((i.vrrp ||= { on: false, vip: '', prio: '100' }), { on: true, vip }); }))],
    ['standby <g> priority <n>', ([, n]) => onL3((i) => { (i.vrrp ||= { on: false, vip: '', prio: '100' }).prio = String(+n); })],
    ['ipv6 address <cidr>', ([c]) => (parseCidr6(c) == null ? err('IPv6 位址要帶前綴長度，例如 2001:db8:a::1/64') : onL3((i) => { if (!i.ip6) i.ra = true; i.ip6 = c; }))],
    ['no ipv6 address [...]', () => onL3((i) => { i.ip6 = ''; })],
    ['ipv6 nd ra suppress [...]', () => onL3((i) => { i.ra = false; })],
    ['no ipv6 nd ra suppress [...]', () => onL3((i) => { i.ra = true; })],
    ['encapsulation dot1q <vlan>', ([v]) => each((t) => {
      if (!t.sub) return err('encapsulation 只能用在子介面，例如 interface Gi0/0/0.10');
      if (!(+v >= 1 && +v <= 4094)) return err('VLAN ID 必須是 1 – 4094');
      t.iface.bind.vlan = +v;
      return undefined;
    })],
    ['crypto map <name>', ([name]) => onL3((i) => { i.cmap = name; })],
    ['no crypto map [...]', () => onL3((i) => { i.cmap = ''; })],
    ['shutdown', () => each((t) => { if (t.pc) t.pc.shut = true; else if (t.port && t.iface) t.iface.shut = true; })],
    ['no shutdown', () => each((t) => { if (t.pc) t.pc.shut = false; else if (t.port && t.iface) t.iface.shut = false; })],
    ['description [...]', () => undefined],
    ['no description', () => undefined],
    // ── 第二層 ──
    ['switchport mode <m>', ([m]) => {
      const mode = ['access', 'trunk'].find((x) => x.startsWith(m.toLowerCase()));
      return mode ? onL2((pc) => { pc.mode = mode; }) : err('模式必須是 access 或 trunk');
    }],
    ['switchport access vlan <id>', ([id], out) => (+id >= 1 && +id <= 4094 ? onL2((pc) => { ensureVlan(+id, out); pc.vlan = +id; }) : err('VLAN ID 必須是 1 – 4094'))],
    ['no switchport access vlan', () => onL2((pc) => { pc.vlan = 1; })],
    ['switchport trunk native vlan <id>', ([id]) => (+id >= 1 && +id <= 4094 ? onL2((pc) => { pc.native = +id; }) : err('VLAN ID 必須是 1 – 4094'))],
    ['no switchport trunk native vlan', () => onL2((pc) => { pc.native = 1; })],
    ['switchport trunk allowed vlan add <list>', ([list]) => onL2((pc) => { pc.allowed = pc.allowed === 'all' || !pc.allowed ? 'all' : [...new Set([...pc.allowed.split(','), ...list.split(',')])].join(','); })],
    ['switchport trunk allowed vlan <list>', ([list]) => (/^(all|\d+(-\d+)?(,\d+(-\d+)?)*)$/i.test(list) ? onL2((pc) => { pc.allowed = list.toLowerCase(); }) : err('VLAN 清單的格式：10,20 或 10-20 或 all'))],
    ['no switchport trunk allowed vlan', () => onL2((pc) => { pc.allowed = 'all'; })],
    ['switchport trunk encapsulation <e>', () => onL2(() => {})],
    ['switchport nonegotiate', () => onL2(() => {})],
    ['no switchport', () => each((t) => {
      const d = dev();
      if (!t.pc || d.kind !== 'l3switch') return err('只有 L3 交換器的連接埠可以改成 Routed 埠');
      t.pc.mode = 'routed';
      if (!t.iface) { t.iface = newIface(t.port.id, t.port.label, { t: 'port', port: t.port.id }); d.ifaces.push(t.iface); }
      return undefined;
    })],
    ['switchport', () => onL2((pc) => { if (pc.mode === 'routed') pc.mode = 'access'; })],
    ['switchport port-security', () => onL2((pc) => { (pc.ps ||= { on: false, macs: '', mode: 'shutdown' }).on = true; })],
    ['no switchport port-security', () => onL2((pc) => { if (pc.ps) pc.ps.on = false; })],
    ['switchport port-security maximum <n>', () => onL2(() => {})],
    ['switchport port-security mac-address sticky', () => onL2((pc, t) => {
      const ps = (pc.ps ||= { on: false, macs: '', mode: 'shutdown' });
      ps.macs = macsBehind(getState(), dev(), t.port.id).map((m) => m.mac).join(', ');
    })],
    ['switchport port-security mac-address <mac>', ([mac]) => {
      const hex = mac.toLowerCase().replace(/[.:-]/g, '');
      if (!/^[0-9a-f]{12}$/.test(hex)) return err('MAC 位址的格式：0011.2233.4455 或 00:11:22:33:44:55');
      const m = hex.match(/../g).join(':');
      return onL2((pc) => {
        const ps = (pc.ps ||= { on: false, macs: '', mode: 'shutdown' });
        const list = String(ps.macs || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
        if (!list.includes(m)) list.push(m);
        ps.macs = list.join(', ');
      });
    }],
    ['switchport port-security violation <mode>', ([m]) => {
      const mode = ['restrict', 'shutdown', 'protect'].find((x) => x.startsWith(m.toLowerCase()));
      return mode ? onL2((pc) => { (pc.ps ||= { on: false, macs: '', mode: 'shutdown' }).mode = mode === 'protect' ? 'restrict' : mode; }) : err('模式必須是 restrict、shutdown 或 protect');
    }],
    ['spanning-tree portfast [...]', () => onL2(() => {})],
    ['no spanning-tree portfast', () => onL2(() => {})],
    ['spanning-tree bpduguard <x>', ([x]) => onL2((pc) => { pc.bpduguard = 'enable'.startsWith(x.toLowerCase()); })],
    ['no spanning-tree bpduguard [...]', () => onL2((pc) => { pc.bpduguard = false; })],
    ['spanning-tree guard root', () => onL2((pc) => { pc.rootguard = true; })],
    ['no spanning-tree guard [...]', () => onL2((pc) => { pc.rootguard = false; })],
    ['ip dhcp snooping trust', () => onL2((pc) => { pc.trust = true; })],
    ['no ip dhcp snooping trust', () => onL2((pc) => { pc.trust = false; })],
    ['ip arp inspection trust', () => onL2((pc) => { pc.trust = true; })],
    ['no ip arp inspection trust', () => onL2((pc) => { pc.trust = false; })],
    ['channel-group <n> mode <m>', ([n, m]) => {
      const mode = ['active', 'passive', 'on'].find((x) => x.startsWith(m.toLowerCase()));
      if (!(+n >= 1 && +n <= 48) || !mode) return err('用法：channel-group <1-48> mode active|passive|on');
      return onL2((pc) => { pc.lag = String(+n); pc.lagMode = mode; });
    }],
    ['no channel-group [...]', () => onL2((pc) => { pc.lag = ''; })],
    ['authentication port-control <x>', ([x]) => onL2((pc) => { pc.dot1x = 'auto'.startsWith(x.toLowerCase()); })],
    ['no authentication port-control [...]', () => onL2((pc) => { pc.dot1x = false; })],
    ['dot1x port-control <x>', ([x]) => onL2((pc) => { pc.dot1x = 'auto'.startsWith(x.toLowerCase()); })],
    ['dot1x pae authenticator', () => onL2(() => {})],
  ];

  // ── 全域設定模式 ──
  const needSw = () => (isSw(dev()) ? null : err('這個指令只適用於交換器'));
  const needRouting = () => (dev().routing ? null : err('這台是 L2 交換器，沒有路由功能（要讓它能被遠端管理請用 ip default-gateway）'));
  const enter = (mode, cur) => { S.mode = mode; S.cur = cur; };
  const ifByName = (name) => { const t = resolveIf(dev(), name); return isErr(t) ? t : t.iface || err(`${t.name} 不是第三層介面`); };
  const addUnique = (list, item) => { if (!list.some((x) => same(x, item))) list.push(item); };

  const CONFIG = [
    ['hostname <name>', ([name]) => { dev().name = name; }],
    ['interface range <...>', ([text]) => { const r = resolveRange(dev(), text); if (isErr(r)) return r; enter('if', r); return undefined; }],
    ['interface <...>', ([text]) => { const r = resolveIf(dev(), text); if (isErr(r)) return r; enter('if', [r]); return undefined; }],
    ['no interface <...>', ([text]) => {
      const d = dev(), s = text.toLowerCase().replace(/\s+/g, '');
      const before = d.ifaces.length;
      const vl = s.match(/^vl[a-z]*(\d+)$/);
      if (vl && d.kind === 'l3switch') d.ifaces = d.ifaces.filter((i) => !(i.bind.t === 'svi' && i.bind.vlan === +vl[1]));
      else {
        const m = s.match(/^([a-z]+)([\d/]+)\.(\d+)$/), p = m && findPort(d, m[1], m[2]);
        if (p) d.ifaces = d.ifaces.filter((i) => !(i.bind.t === 'sub' && i.id === `${p.id}.${+m[3]}`));
      }
      return d.ifaces.length < before ? undefined : err('只能刪除子介面或 VLAN 介面，而且它必須存在');
    }],
    ['vlan <id>', ([id]) => {
      const e = needSw(); if (e) return e;
      if (!(+id >= 1 && +id <= 4094) || !/^\d+$/.test(id)) return err('VLAN ID 必須是 1 – 4094');
      const sw = dev().sw;
      let v = sw.vlans.find((x) => x.id === +id);
      if (!v) { v = { id: +id, name: 'VLAN' + String(+id).padStart(4, '0') }; sw.vlans.push(v); }
      enter('vlan', v);
      return undefined;
    }],
    ['no vlan <id>', ([id]) => {
      const e = needSw(); if (e) return e;
      if (+id === 1) return err('預設的 VLAN 1 不能刪除');
      const sw = dev().sw;
      sw.vlans = sw.vlans.filter((x) => x.id !== +id);
      for (const p of Object.values(sw.ports)) { if (p.vlan === +id) p.vlan = 1; if (p.native === +id) p.native = 1; }
      return undefined;
    }],
    ['ip routing', () => needRouting() || undefined],
    ['ipv6 unicast-routing', () => { if (dev().kind !== 'router') return err('這個模擬只有路由器支援 IPv6 路由'); dev().v6routing = true; return undefined; }],
    ['no ipv6 unicast-routing', () => { dev().v6routing = false; }],
    ['ip default-gateway <ip>', ([ip]) => {
      const mg = dev().ifaces.find((x) => x.id === 'mgmt');
      if (!mg) return err('有路由功能的設備請用 ip route 0.0.0.0 0.0.0.0 <下一站>');
      if (parseIp(ip) == null) return err('IP 位址的格式不正確');
      mg.gateway = ip;
      return undefined;
    }],
    ['no ip default-gateway [...]', () => { const mg = dev().ifaces.find((x) => x.id === 'mgmt'); if (mg) mg.gateway = ''; }],
    ['ip route <net> <mask> <via> [...]', ([net, mask, via, ad]) => {
      const e = needRouting(); if (e) return e;
      if (parseIp(net) == null || maskBits(mask) == null) return err('用法：ip route <目的網段> <遮罩> <下一站 IP> [管理距離]');
      if (parseIp(via) == null) return err('下一站必須是 IP 位址（這個模擬不支援只寫出口介面）');
      if (ad && !(+ad >= 1 && +ad <= 255)) return err('管理距離必須是 1 – 255');
      const d = dev(), cur = d.routes.find((r) => r.dst === net && parseMask(r.mask || '') === maskBits(mask) && r.via === via);
      if (cur) cur.ad = ad || '';
      else d.routes.push({ dst: net, mask, via, ad: ad || '' });
      return undefined;
    }],
    ['no ip route <net> <mask> [...]', ([net, mask, via]) => {
      const d = dev(), n = d.routes.length;
      const hit = (r) => r.dst === net && parseMask(r.mask || '') === maskBits(mask) && (!via || r.via === via);
      d.routes = d.routes.filter((r) => !hit(r));
      let gw = false;
      if (parseIp(net) === 0 && maskBits(mask) === 0) for (const i of d.ifaces) if (i.gateway && (!via || i.gateway === via)) { i.gateway = ''; gw = true; }
      return d.routes.length < n || gw ? undefined : err('路由表裡沒有這一筆靜態路由');
    }],
    ['ipv6 route <prefix> <via>', ([prefix, via]) => {
      const d = dev();
      if (!d.routes6) return err('這個模擬只有路由器支援 IPv6 路由');
      if (parseCidr6(prefix) == null || parseIp6(via) == null) return err('用法：ipv6 route <前綴/長度> <下一站>');
      addUnique(d.routes6, { dst: prefix, via });
      return undefined;
    }],
    ['no ipv6 route <prefix> [...]', ([prefix, via]) => { const d = dev(); if (d.routes6) d.routes6 = d.routes6.filter((r) => !(r.dst === prefix && (!via || r.via === via))); }],
    ['router ospf <pid>', () => { if (!('ospfDefault' in dev())) return err('這台設備不支援 OSPF'); enter('router', null); return undefined; }],
    ['no router ospf <pid>', () => { for (const i of dev().ifaces) i.ospf = false; dev().ospfDefault = false; }],
    ['ip dhcp excluded-address <a> [...]', ([a, b]) => {
      const x = parseIp(a), y = b ? parseIp(b) : x;
      if (x == null || y == null || y < x) return err('用法：ip dhcp excluded-address <起始 IP> [結束 IP]');
      const d = dev();
      addUnique((d.dhcpExcl ||= []), [x, y]);
      for (const i of d.ifaces) if (i.dhcp && i.dhcp.pool) applyPoolRange(d, i);
      return undefined;
    }],
    ['no ip dhcp excluded-address <a> [...]', ([a, b]) => {
      const d = dev(), x = parseIp(a), y = b ? parseIp(b) : x;
      d.dhcpExcl = (d.dhcpExcl || []).filter((r) => !(r[0] === x && r[1] === y));
      for (const i of d.ifaces) if (i.dhcp && i.dhcp.pool) applyPoolRange(d, i);
    }],
    ['ip dhcp pool <name>', ([name]) => {
      const e = needRouting(); if (e) return e;
      const d = dev(), N = name.toUpperCase();
      const i = d.ifaces.find((x) => x.dhcp && x.dhcp.on && poolName(x) === N);
      const rsv = d.ifaces.flatMap((x) => (x.dhcp && x.dhcp.reserved) || []).find((r) => rsvName(r) === N);
      let p = i ? { name: N, iface: i } : rsv ? { name: N, rsv } : (d.dhcpPools ||= []).find((x) => x.name === N);
      if (!p) { p = { name: N, net: null, bits: null, gw: '', dns: '' }; d.dhcpPools.push(p); }
      enter('dhcp', p);
      return undefined;
    }],
    ['no ip dhcp pool <name>', ([name]) => {
      const d = dev(), N = name.toUpperCase();
      for (const i of d.ifaces) if (i.dhcp && i.dhcp.on && poolName(i) === N) i.dhcp.on = false;
      for (const i of d.ifaces) if (i.dhcp && i.dhcp.reserved) i.dhcp.reserved = i.dhcp.reserved.filter((r) => rsvName(r) !== N);
      if (d.dhcpPools) d.dhcpPools = d.dhcpPools.filter((x) => x.name !== N);
    }],
    ['ip dhcp snooping vlan <list>', () => needSw() || undefined],
    ['ip dhcp snooping', () => needSw() || void (dev().sw.snoop = { ...(dev().sw.snoop || {}), on: true })],
    ['no ip dhcp snooping [...]', () => needSw() || void (dev().sw.snoop = { ...(dev().sw.snoop || {}), on: false })],
    ['ip arp inspection vlan <list>', () => needSw() || void (dev().sw.dai = { ...(dev().sw.dai || {}), on: true })],
    ['no ip arp inspection vlan [...]', () => needSw() || void (dev().sw.dai = { ...(dev().sw.dai || {}), on: false })],
    ['spanning-tree mode <m>', () => needSw() || undefined],
    ['spanning-tree vlan <list> priority <n>', ([, n]) => {
      const e = needSw(); if (e) return e;
      if (!/^\d+$/.test(n) || +n > 61440 || +n % 4096) return err('priority 必須是 4096 的倍數（0、4096、8192 … 61440）');
      Object.assign((dev().sw.stp ||= {}), { on: true, prio: +n });
      return undefined;
    }],
    ['spanning-tree vlan <list> root <which>', ([, w]) => {
      const e = needSw(); if (e) return e;
      Object.assign((dev().sw.stp ||= {}), { on: true, prio: 'primary'.startsWith(w.toLowerCase()) ? 24576 : 28672 });
      return undefined;
    }],
    ['no spanning-tree vlan <list> priority', () => needSw() || void ((dev().sw.stp ||= {}).prio = 32768)],
    ['spanning-tree vlan <list>', () => needSw() || void ((dev().sw.stp ||= {}).on = true)],
    ['no spanning-tree vlan <list>', () => needSw() || void ((dev().sw.stp ||= {}).on = false)],
    ['ip nat inside source list <acl> interface <if> [...]', ([acl, name]) => {
      const i = ifByName(name); if (isErr(i)) return i;
      syncNat();
      i.natRule = true; setNat(i);
      i.natAcl = acl === '1' && !(dev().aclDefs || {})['1'] ? '' : acl.toUpperCase(); // list 1 permit any 是預設：全部轉換
      i.natSkip = '';
      return i.nat ? undefined : `（${i.label} 還要在介面模式下 ip nat outside，才會開始轉換位址）`;
    }],
    ['no ip nat inside source list <acl> interface <if> [...]', ([, name]) => { const i = ifByName(name); if (isErr(i)) return i; syncNat(); i.natRule = false; setNat(i); return undefined; }],
    ['ip nat inside source static <proto> <ip> <port> interface <if> <eport>', ([proto, ip, port, , eport]) => {
      const d = dev(), p = proto.toLowerCase();
      if (!d.portForwards) return err('這台設備不支援 NAT');
      if (!['tcp', 'udp'].includes(p) || parseIp(ip) == null || !/^\d+$/.test(port) || !/^\d+$/.test(eport)) return err('用法：ip nat inside source static tcp <內部 IP> <內部埠> interface <對外介面> <對外埠>');
      addUnique(d.portForwards, { proto: p, port: eport, toIp: ip, toPort: port === eport ? '' : port });
      return undefined;
    }],
    ['no ip nat inside source static <proto> <ip> <port> interface <if> <eport>', ([proto, ip, , , eport]) => {
      const d = dev();
      if (d.portForwards) d.portForwards = d.portForwards.filter((f) => !((f.proto || 'tcp') === proto.toLowerCase() && f.toIp === ip && String(f.port) === eport));
    }],
    ['ip nat inside source static <priv> <pub>', ([priv, pub]) => {
      const d = dev();
      if (!d.staticNat) return err('這台設備不支援靜態 NAT');
      if (parseIp(priv) == null || parseIp(pub) == null) return err('用法：ip nat inside source static <內部 IP> <公用 IP>');
      addUnique(d.staticNat, { pub, priv });
      return undefined;
    }],
    ['no ip nat inside source static <priv> <pub>', ([priv, pub]) => { const d = dev(); if (d.staticNat) d.staticNat = d.staticNat.filter((n) => !(n.priv === priv && n.pub === pub)); }],
    ['access-list <n> <...>', ([n, rest]) => {
      const d = dev(), t = rest.split(/\s+/);
      if (!/^\d+$/.test(n)) return err('用法：access-list <編號> permit|deny …（1-99 是標準 ACL，100-199 是延伸 ACL）');
      let rule = null;
      if (+n < 100) {
        // 標準 ACL 只比對來源位址
        const action = ['permit', 'deny'].find((a) => a.startsWith((t[0] || ' ').toLowerCase()));
        const a = (t[1] || '').toLowerCase();
        let src = null;
        if (a === 'any') src = 'any';
        else if (a === 'host' && parseIp(t[2] || '') != null) src = t[2];
        else if (parseIp(a) != null) { const bits = t[2] ? wildBits(t[2]) : 32; if (bits != null) src = bits === 32 ? a : `${fmtIp(netOf(parseIp(a), bits))}/${bits}`; }
        if (action && src) rule = { action, proto: 'ip', src, dst: 'any', port: '' };
      } else rule = parseAclRule(t);
      if (!rule) return err(+n < 100 ? '用法：access-list <1-99> permit|deny <any | host IP | 網段 萬用遮罩>' : '用法：access-list <100-199> permit|deny <ip|tcp|udp|icmp> <來源> <目的> [eq <埠>]');
      if (n === '1' && !(d.aclDefs || {})['1'] && same(rule, { action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: '' })) return undefined; // 預設的 NAT 清單
      addUnique(((d.aclDefs ||= {})[n] ||= []), rule);
      syncVpnAcl(d, n);
      return undefined;
    }],
    ['no access-list <n>', ([n]) => { const d = dev(); if (d.aclDefs) delete d.aclDefs[n]; }],
    ['ip access-list extended <name>', ([name]) => {
      const d = dev(), N = name.toUpperCase();
      if (!d.routing) return err('這台設備不支援 ACL');
      // 圖形介面建立的 VPN 通道沒有具名的 ACL：第一次用指令編輯時，先把它目前的網段變成規則
      for (const t of d.vpns || []) if (!t.acl && vpnAclOf(t) === N && !(d.aclDefs || {})[N]) { t.acl = N; (d.aclDefs ||= {})[N] = selRules(t); }
      enter('acl', N);
      return undefined;
    }],
    ['no ip access-list extended <name>', ([name]) => {
      const d = dev(), N = name.toUpperCase();
      if (d.aclDefs) delete d.aclDefs[N];
      for (const i of d.ifaces) for (const [dir, key] of [['in', 'aclIn'], ['out', 'aclOut']]) if (i[key] && i[key].length && aclName(i, dir) === N) i[key] = [];
    }],
    ['ip access-list standard <name>', ([name]) => { if (!dev().mgmt) return err('這台設備不支援'); enter('stdacl', name.toUpperCase()); return undefined; }],
    ['no ip access-list standard <name>', ([name]) => {
      const d = dev(), N = name.toUpperCase();
      if (d.stdAcls) delete d.stdAcls[N];
      if (d.mgmt && (d.mgmt.aclName || 'MGMT') === N) d.mgmt.allow = '';
    }],
    ['line vty [...]', () => { if (!dev().mgmt) return err('這台設備不支援'); enter('line', null); return undefined; }],
    ['line console [...]', () => { enter('line', 'console'); return undefined; }],
    ['ip http server', () => void (dev().mgmt && (dev().mgmt.http = true))],
    ['no ip http server', () => void (dev().mgmt && (dev().mgmt.http = false))],
    ['ip http secure-server', () => void (dev().mgmt && (dev().mgmt.https = true))],
    ['no ip http secure-server', () => void (dev().mgmt && (dev().mgmt.https = false))],
    ['ntp server <ip>', ([ip]) => (parseIp(ip) == null ? err('IP 位址的格式不正確') : void (dev().mgmt && (dev().mgmt.ntp = ip)))],
    ['no ntp server [...]', () => void (dev().mgmt && (dev().mgmt.ntp = ''))],
    ['logging host <ip>', ([ip]) => (parseIp(ip) == null ? err('IP 位址的格式不正確') : void (dev().mgmt && (dev().mgmt.syslog = ip)))],
    ['logging <ip>', ([ip]) => (parseIp(ip) == null ? err('用法：logging host <Syslog 伺服器 IP>') : void (dev().mgmt && (dev().mgmt.syslog = ip)))],
    ['no logging [...]', () => void (dev().mgmt && (dev().mgmt.syslog = ''))],
    ['snmp-server community <str> [...]', ([str]) => void (dev().mgmt && Object.assign(dev().mgmt, { snmp: 'v2c', community: str }))],
    ['no snmp-server community [...]', () => void (dev().mgmt && dev().mgmt.snmp !== 'v3' && (dev().mgmt.snmp = 'off'))],
    ['snmp-server group <...>', ([rest]) => void (dev().mgmt && /\bv3\b/i.test(rest) && (dev().mgmt.snmp = 'v3'))],
    ['snmp-server user <...>', () => undefined],
    ['no snmp-server', () => void (dev().mgmt && (dev().mgmt.snmp = 'off'))],
    ['username <...>', ([rest]) => {
      const m = dev().mgmt, t = rest.split(/\s+/);
      const k = t.findIndex((x) => ['secret', 'password'].includes(x.toLowerCase()));
      if (!m || k < 0 || !t[k + 1]) return err('用法：username <帳號> privilege 15 secret <密碼>');
      m.user = t[0];
      m.pass = readSecret(t.slice(k + 1));
      return undefined;
    }],
    ['enable secret <...>', () => undefined],
    ['service <...>', () => undefined],
    ['aaa <...>', () => undefined],
    ['dot1x system-auth-control', () => undefined],
    ['radius server <name>', () => { if (!dev().radius) return err('這台設備不支援 RADIUS'); enter('radius', null); return undefined; }],
    // ── IPsec VPN ──
    ['crypto isakmp policy <n>', ([n]) => {
      const d = dev();
      if (!d.vpns) return err('這台設備不支援 IPsec VPN');
      if (!/^\d+$/.test(n) || +n < 1) return err('優先順序必須是 1 以上的數字（越小越優先）');
      d.isakmp = isakmpOf(d).map((x) => ({ ...x }));
      let p = d.isakmp.find((x) => x.n === +n);
      if (!p) { p = { n: +n, enc: 'aes128', hash: 'sha1', dh: '2' }; d.isakmp.push(p); d.isakmp.sort((a, b) => a.n - b.n); }
      enter('isakmp', p);
      return undefined;
    }],
    ['no crypto isakmp policy <n>', ([n]) => { const d = dev(); if (d.vpns) d.isakmp = isakmpOf(d).filter((x) => x.n !== +n); }],
    ['crypto isakmp enable', () => undefined],
    ['crypto isakmp key <...>', ([rest]) => {
      const d = dev(), t = rest.split(/\s+/);
      const a = t.findIndex((x, n) => n > 0 && x.length >= 3 && 'address'.startsWith(x.toLowerCase()));
      const key = a > 0 ? readSecret(t.slice(0, a)) : '', peer = t[a + 1] || '';
      if (!d.vpns) return err('這台設備不支援 IPsec VPN');
      if (!key || parseIp(peer) == null) return err('用法：crypto isakmp key <金鑰> address <對端 IP>');
      (d.ikeKeys ||= {})[peer] = key;
      for (const v of d.vpns) if (v.peer === peer) v.psk = key;
      return undefined;
    }],
    ['no crypto isakmp key <...>', ([rest]) => {
      const d = dev(), peer = rest.split(/\s+/).pop();
      if (d.ikeKeys) delete d.ikeKeys[peer];
      for (const v of d.vpns || []) if (v.peer === peer) v.psk = '';
    }],
    ['crypto ipsec transform-set <name> <...>', ([name, rest]) => {
      const d = dev(), w = rest.toLowerCase().split(/\s+/);
      if (!d.vpns) return err('這台設備不支援 IPsec VPN');
      const ei = w.indexOf('esp-aes');
      if (ei < 0) return err('這個模擬支援 esp-aes 與 esp-aes 256（DES / 3DES 已經不安全）');
      const hash2 = w.includes('esp-sha256-hmac') ? 'sha256' : w.includes('esp-sha-hmac') ? 'sha1' : null;
      if (!hash2) return err('transform-set 還需要驗證演算法：esp-sha-hmac 或 esp-sha256-hmac');
      const set = { enc2: w[ei + 1] === '256' ? 'aes256' : 'aes128', hash2 };
      (d.tsets ||= {})[name] = set;
      for (const v of d.vpns) if (v.tset === name) Object.assign(v, set);
      enter('tset', null);
      return undefined;
    }],
    ['no crypto ipsec transform-set <name>', ([name]) => {
      const d = dev();
      if ((d.vpns || []).some((v) => v.tset === name)) return err(`transform-set ${name} 正被 crypto map 使用，不能刪除`);
      if (d.tsets) delete d.tsets[name];
      return undefined;
    }],
    ['crypto map <name> <seq> ipsec-isakmp', (a) => cmapEnter(a)],
    ['crypto map <name> <seq>', (a) => cmapEnter(a)],
    ['no crypto map <name> [...]', ([name, seq]) => {
      const d = dev();
      if (!d.vpns) return undefined;
      d.vpns = d.vpns.filter((v) => !(cmapOf(v) === name && (!seq || seqOf(d, v) === +seq)));
      if (!d.vpns.some((v) => cmapOf(v) === name)) for (const i of d.ifaces) if (i.cmap === name) i.cmap = '';
      return undefined;
    }],
    ['crypto <...>', () => err('這個模擬支援的 VPN 指令：crypto isakmp policy、crypto isakmp key、crypto ipsec transform-set、crypto map')],
  ];

  function setRsvMac(text) {
    const mac = colonMac(text), p = S.cur;
    if (!mac) return err('MAC 位址的格式：0011.2233.4455；client-identifier 則是前面多一個 01');
    if (p.iface) return err('這個位址池已經是一個網段，保留位址請另外建一個位址池');
    if (p.rsv) p.rsv.mac = mac; else { p.mac = mac; attachPools(dev()); }
    return undefined;
  }

  function cmapEnter([name, seq]) {
    const d = dev();
    if (!d.vpns || d.kind !== 'router') return err('這台設備不支援 crypto map');
    if (!/^\d+$/.test(seq) || +seq < 1) return err('用法：crypto map <名稱> <序號> ipsec-isakmp');
    let t = d.vpns.find((v) => cmapOf(v) === name && seqOf(d, v) === +seq), note;
    if (t) t.seq = +seq;
    else {
      const p = isakmpOf(d)[0] || { enc: 'aes128', hash: 'sha1', dh: '2' };
      t = { name: `${name}-${+seq}`, cmap: name, seq: +seq, peer: '', psk: '', local: '', remote: '', enc: p.enc, hash: p.hash, dh: p.dh };
      d.vpns.push(t);
      note = 'NOTE: This new crypto map will remain disabled until a peer and a valid access list have been configured.';
    }
    enter('cmap', t);
    return note;
  }

  const SUB = {
    if: IF,
    vlan: [['name <...>', ([name]) => { S.cur.name = name; }]],
    router: [
      ['network <ip> <wild> area <a>', ([ip, wild]) => {
        const net = parseIp(ip), bits = wildBits(wild);
        if (net == null || bits == null) return err('用法：network <網段> <萬用遮罩> area 0，例如 network 10.0.0.0 0.0.0.255 area 0');
        const hit = dev().ifaces.filter((i) => {
          const n = staticNet(i), a = n ? n.ip : i.rt && i.rt.ip;
          return a != null && netOf(a, bits) === netOf(net, bits);
        });
        for (const i of hit) i.ospf = true;
        return hit.length ? `OSPF 已在 ${hit.map((i) => i.label).join('、')} 啟用` : '（目前沒有任何介面的 IP 落在這個範圍內，OSPF 沒有在任何介面啟用）';
      }],
      ['no network <ip> <wild> area <a>', ([ip, wild]) => {
        const net = parseIp(ip), bits = wildBits(wild);
        if (net == null || bits == null) return err('用法：no network <網段> <萬用遮罩> area 0');
        for (const i of dev().ifaces) { const n = staticNet(i); if (n && netOf(n.ip, bits) === netOf(net, bits)) i.ospf = false; }
        return undefined;
      }],
      ['default-information originate [...]', () => { dev().ospfDefault = true; }],
      ['no default-information originate', () => { dev().ospfDefault = false; }],
      ['router-id <id>', () => undefined],
      ['passive-interface <...>', () => '（這個模擬沒有 passive-interface，要關閉某個介面的 OSPF 請用 no network）'],
    ],
    dhcp: [
      ['network <net> <mask>', ([net, mask]) => {
        const n = parseIp(net), bits = maskBits(mask);
        if (n == null || bits == null) return err('用法：network <網段> <遮罩>，例如 network 192.168.10.0 255.255.255.0');
        const p = S.cur, d = dev();
        if (p.iface) return staticNet(p.iface) && staticNet(p.iface).net === netOf(n, bits) ? undefined : err('這個位址池已經綁在另一個網段，請先 no ip dhcp pool 再重建');
        Object.assign(p, { net: netOf(n, bits), bits });
        attachPools(d);
        const i = d.ifaces.find((x) => x.dhcp && x.dhcp.pool === p.name);
        if (i) { S.cur = { name: p.name, iface: i }; return undefined; }
        return '（這個網段還沒有對應的介面 — 等某個介面設定了這個網段的 IP，位址池就會生效）';
      }],
      ['default-router <ip>', ([ip]) => { if (parseIp(ip) == null) return err('IP 位址的格式不正確'); const p = S.cur; (p.iface ? p.iface.dhcp : p).gw = ip; return undefined; }],
      ['dns-server <...>', ([list]) => {
        const ips = list.split(/[,\s]+/).filter(Boolean);
        if (!ips.length || ips.some((x) => parseIp(x) == null)) return err('用法：dns-server <IP> [IP]');
        const p = S.cur; (p.iface ? p.iface.dhcp : p).dns = ips.join(', ');
        return undefined;
      }],
      // 保留位址：host + hardware-address（或 client-identifier）
      ['host <ip> [...]', ([ip]) => {
        if (parseIp(ip) == null) return err('用法：host <IP> <遮罩>');
        const p = S.cur;
        if (p.iface) return err('這個位址池已經是一個網段，保留位址請另外建一個位址池');
        if (p.rsv) p.rsv.ip = ip; else { p.host = ip; attachPools(dev()); }
        return undefined;
      }],
      ['hardware-address <mac> [...]', ([mac]) => setRsvMac(mac)],
      ['client-identifier <id>', ([id]) => setRsvMac(id.replace(/[.:-]/g, '').replace(/^01(?=[0-9a-f]{12}$)/i, ''))],
      ['lease <...>', () => undefined],
      ['domain-name <...>', () => undefined],
    ],
    line: [
      ['transport input [...]', ([list]) => {
        const m = dev().mgmt;
        if (!m || S.cur === 'console') return undefined;
        const t = list.toLowerCase().split(/\s+/);
        if (!t.every((x) => ['ssh', 'telnet', 'all', 'none'].includes(x))) return err('用法：transport input ssh | telnet | all | none');
        m.ssh = t.includes('ssh') || t.includes('all');
        m.telnet = t.includes('telnet') || t.includes('all');
        return undefined;
      }],
      ['access-class <name> in', ([name]) => {
        const d = dev(), N = name.toUpperCase();
        const list = (d.stdAcls || {})[N];
        d.mgmt.aclName = N;
        if (list) d.mgmt.allow = list.join(', ');
        return undefined;
      }],
      ['no access-class [...]', () => { dev().mgmt.allow = ''; }],
      ['login [...]', () => undefined],
      ['password <...>', () => undefined],
      ['exec-timeout <...>', () => undefined],
    ],
    acl: [
      ['no <seq>', ([seq]) => {
        const d = dev(), n = Math.round(+seq / 10) - 1;
        const lists = aclLists(d, S.cur);
        if (!(n >= 0) || !lists.some((l) => l[n])) return err('沒有這個序號的規則（序號是 10、20、30…）');
        for (const l of lists) l.splice(n, 1);
        syncVpnAcl(d, S.cur);
        return undefined;
      }],
      ['<...>', ([line]) => {
        const rule = parseAclRule(line.split(/\s+/));
        if (!rule) return err('用法：permit|deny <ip|tcp|udp|icmp> <來源> <目的> [eq <埠>]，位址寫 any、host <IP> 或 <網段> <萬用遮罩>');
        for (const l of aclLists(dev(), S.cur)) addUnique(l, { ...rule });
        syncVpnAcl(dev(), S.cur);
        return undefined;
      }],
    ],
    stdacl: [
      ['<...>', ([line]) => {
        const t = line.split(/\s+/);
        let n = /^\d+$/.test(t[0]) ? 1 : 0;
        if (!'permit'.startsWith((t[n] || ' ').toLowerCase())) return err('這個模擬的標準 ACL 只支援 permit <網段> <萬用遮罩> 或 permit host <IP>');
        n++;
        let cidr = null;
        if ((t[n] || '').toLowerCase() === 'host' && parseIp(t[n + 1] || '') != null) cidr = t[n + 1];
        else if (parseIp(t[n] || '') != null) {
          const bits = t[n + 1] ? wildBits(t[n + 1]) : 32;
          if (bits != null) cidr = bits === 32 ? t[n] : `${fmtIp(netOf(parseIp(t[n]), bits))}/${bits}`;
        }
        if (!cidr) return err('用法：permit <網段> <萬用遮罩>，例如 permit 10.0.99.0 0.0.0.255');
        const d = dev(), list = ((d.stdAcls ||= {})[S.cur] ||= []);
        if (!list.includes(cidr)) list.push(cidr);
        if (d.mgmt && d.mgmt.allow && (d.mgmt.aclName || 'MGMT') === S.cur) d.mgmt.allow = list.join(', ');
        return undefined;
      }],
    ],
    radius: [
      ['address ipv4 <ip> [...]', ([ip]) => { if (parseIp(ip) == null) return err('IP 位址的格式不正確'); dev().radius.ip = ip; return undefined; }],
      ['key <...>', ([k]) => { dev().radius.secret = readSecret(k.split(/\s+/)); }],
    ],
    isakmp: [
      ['encryption aes [...]', ([bits]) => { if (bits && !['128', '256'].includes(bits)) return err('金鑰長度支援 128 與 256'); S.cur.enc = bits === '256' ? 'aes256' : 'aes128'; return undefined; }],
      ['encryption <x>', ([x]) => err(`這個模擬不支援 ${x}（DES / 3DES 已經不安全），請用 aes 或 aes 256`)],
      ['hash <h>', ([h]) => { const v = { sha: 'sha1', sha1: 'sha1', sha256: 'sha256' }[h.toLowerCase()]; if (!v) return err('hash 支援 sha（SHA-1）與 sha256'); S.cur.hash = v; return undefined; }],
      ['group <g>', ([g]) => { if (!['2', '5', '14', '19'].includes(g)) return err('DH 群組支援 2、5、14、19'); S.cur.dh = g; return undefined; }],
      ['authentication <a>', ([a]) => ('pre-share'.startsWith(a.toLowerCase()) ? undefined : err('這個模擬只支援 pre-share（預先共用金鑰）'))],
      ['lifetime <n>', () => undefined],
    ],
    tset: [['mode <m>', () => undefined]],
    cmap: [
      ['set peer <ip>', ([ip]) => {
        if (parseIp(ip) == null) return err('IP 位址的格式不正確');
        const d = dev(), t = S.cur;
        t.peer = ip;
        if (d.ikeKeys && d.ikeKeys[ip]) t.psk = d.ikeKeys[ip];
        return t.psk ? undefined : `（還沒有給 ${ip} 的預先共用金鑰：crypto isakmp key <金鑰> address ${ip}）`;
      }],
      ['set transform-set <name>', ([name]) => {
        const set = (dev().tsets || {})[name];
        if (!set) return err(`ERROR: transform set with tag ${name} does not exist.（先用 crypto ipsec transform-set 定義）`);
        Object.assign(S.cur, { tset: name }, set);
        return undefined;
      }],
      ['set pfs <g>', ([g]) => { const m = g.toLowerCase().match(/^group(2|5|14|19)$/); if (!m) return err('用法：set pfs group14（支援 group2、group5、group14、group19）'); S.cur.pfs = m[1]; return undefined; }],
      ['no set pfs', () => { S.cur.pfs = ''; }],
      ['set security-association <...>', () => undefined],
      ['match address <name>', ([name]) => { S.cur.acl = name.toUpperCase(); syncVpnAcl(dev(), S.cur.acl); return undefined; }],
      ['description <...>', ([text]) => { S.cur.name = text; }],
    ],
  };

  function aclLists(d, name) {
    const bound = d.ifaces.flatMap((i) => [['in', 'aclIn'], ['out', 'aclOut']].filter(([dir, k]) => i[k] && ((i.aclNames && i.aclNames[dir] === name) || (i[k].length && aclName(i, dir) === name))).map(([, k]) => i[k]));
    return bound.length ? bound : [((d.aclDefs ||= {})[name] ||= [])];
  }

  const run = (rules, tok, out) => {
    for (const [pattern, fn] of rules) {
      const args = match(tok, pattern);
      if (args) { const r = fn(args, out); return { hit: true, r }; }
    }
    return { hit: false };
  };

  function exec(line) {
    const text = line.trim();
    const tok = text.split(/\s+/).filter(Boolean);
    const out = [];
    const done = (changed) => ({ out, changed: !!changed });
    if (!tok.length || tok[0].startsWith('!')) return done(false);
    const t0 = tok[0].toLowerCase();
    if (S.mode === 'exec') {
      if (match(tok, 'configure terminal') || match(tok, 'configure')) { S.mode = 'config'; out.push('Enter configuration commands, one per line.  End with CNTL/Z.'); return done(false); }
      if (match(tok, 'enable') || match(tok, 'disable') || match(tok, 'end') || match(tok, 'terminal <...>')) return done(false);
      if (match(tok, 'write [...]') || match(tok, 'copy running-config startup-config')) { out.push('Building configuration...', '[OK]'); return done(false); }
      return { out, changed: false, pass: true };
    }
    if (text === 'Building configuration...' || /^current configuration/i.test(text)) return done(false);
    if (match(tok, 'end') || t0 === '^z') { S.mode = 'exec'; S.cur = null; return done(false); }
    if (match(tok, 'exit')) { S.mode = S.mode === 'config' ? 'exec' : 'config'; S.cur = null; return done(false); }
    if (t0 === 'do') return { out, changed: false, pass: true, doLine: tok.slice(1).join(' ') };
    // 介面模式裡單獨一個 sh 是 shutdown；後面還有字（sh ip int br）才是想看 show
    if (tok.length >= 2 && 'show'.startsWith(t0) && t0.length >= 2) { out.push('% 在設定模式要查看狀態請在前面加 do，例如 do show ip interface brief'); return done(false); }
    // ACL 模式的規則是整行一起解析，只有長得像規則的才交給它，其餘當成全域指令（可以直接跳到別的設定）
    const aclMode = S.mode === 'acl' || S.mode === 'stdacl';
    const trySub = S.mode !== 'config' && (!aclMode || /^(\d+\s+)?(permit|deny)\b/i.test(text) || /^no\s+\d+$/i.test(text));
    let res = trySub ? run(SUB[S.mode], tok, out) : { hit: false };
    if (!res.hit && S.mode === 'config') res = run(CONFIG, tok, out);
    else if (!res.hit) {
      // 在子模式下輸入全域指令：和真的 IOS 一樣，會直接離開子模式去執行
      const prev = S.mode, prevCur = S.cur;
      S.mode = 'config'; S.cur = null;
      res = run(CONFIG, tok, out);
      if (!res.hit || isErr(res.r)) { S.mode = prev; S.cur = prevCur; }
    }
    if (!res.hit) { out.push(err(`Invalid input detected：不認識的指令「${text}」，輸入 ? 查看這個模式可用的指令`)); return done(false); }
    if (isErr(res.r)) { out.push(res.r); return done(false); }
    for (const x of [].concat(res.r ?? [])) out.push(x);
    return done(true);
  }

  /**
   * Tab 補齊與「?」：依目前的模式找出下一個可以接的字。
   * extra 是顯示層提供的指令（show …）。回傳 { line: 補齊後的整行或 null, options: 候選字 }
   */
  function complete(line, extra = []) {
    const tok = line.trim().split(/\s+/).filter(Boolean);
    const partial = /\s$/.test(line) || !tok.length ? '' : tok.pop().toLowerCase();
    const own = S.mode === 'exec'
      ? ['configure terminal', 'write memory', 'copy running-config startup-config', 'ping <ip>', ...extra]
      : [...(SUB[S.mode] || []).map((r) => r[0]), ...CONFIG.map((r) => r[0]), 'end', 'exit', 'permit <...>', 'deny <...>', ...extra.map((c) => 'do ' + c)];
    const words = new Set();
    for (const pattern of own) {
      const pt = pattern.split(' ');
      if (pt.length <= tok.length) continue;
      const fits = tok.every((t, n) => pt[n][0] === '<' ? pt[n] !== '<...>' : pt[n][0] !== '[' && pt[n].startsWith(t.toLowerCase()));
      const w = pt[tok.length];
      if (fits && w[0] !== '<' && w[0] !== '[' && w.startsWith(partial)) words.add(w);
    }
    const options = [...words].sort();
    if (!options.length) return { line: null, options };
    let common = options[0];
    for (const w of options) while (!w.startsWith(common)) common = common.slice(0, -1);
    const done = options.length === 1;
    return { line: common.length > partial.length || done ? [...tok, common].join(' ') + (done ? ' ' : '') : null, options };
  }

  return {
    exec,
    complete,
    prompt: () => hostName(dev()) + PROMPT[S.mode],
    help: () => HELP[S.mode] || [],
    get mode() { return S.mode; },
  };
}

// ───────────────────────── show running-config ─────────────────────────

const wild = (bits) => fmtIp(~maskOf(bits) >>> 0);
const dotMac = (m) => m.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');

function aclAddr(spec) {
  const s = String(spec || 'any').trim().toLowerCase();
  if (s === '' || s === 'any') return 'any';
  const m = s.match(/^([\d.]+)(?:\/(\d+))?$/);
  const ip = m && parseIp(m[1]);
  if (ip == null) return s;
  const bits = m[2] == null ? 32 : +m[2];
  return bits === 32 ? 'host ' + fmtIp(ip) : `${fmtIp(netOf(ip, bits))} ${wild(bits)}`;
}
export const aclLine = (r) => `${r.action} ${r.proto || 'ip'} ${aclAddr(r.src)} ${aclAddr(r.dst)}${r.port && r.proto !== 'ip' && r.proto !== 'icmp' ? ' eq ' + r.port : ''}`;

/** 產生等效的 running-config */
export function runningConfig(state, dev) {
  const o = ['Building configuration...', '', '!', `hostname ${hostName(dev)}`, '!'];
  const m = dev.mgmt;
  if (m) o.push(`username ${m.user || 'admin'} privilege 15 secret 9 ${secret9(m.pass || '')}`, '!');
  if (dev.v6routing) o.push('ipv6 unicast-routing', '!');
  if (isSw(dev)) {
    const sw = dev.sw;
    for (const v of sw.vlans.slice().sort((a, b) => a.id - b.id)) if (v.id !== 1) o.push(`vlan ${v.id}`, ` name ${v.name.replace(/\s+/g, '_')}`);
    o.push('!', 'spanning-tree mode rapid-pvst');
    const stp = sw.stp || {};
    if (stp.on === false) o.push('no spanning-tree vlan 1-4094');
    else if (stp.prio != null && stp.prio !== '' && +stp.prio !== 32768) o.push(`spanning-tree vlan 1-4094 priority ${+stp.prio}`);
    const vl = sw.vlans.map((v) => v.id).sort((a, b) => a - b).join(',');
    if (sw.snoop && sw.snoop.on) o.push('ip dhcp snooping', `ip dhcp snooping vlan ${vl}`);
    if (sw.dai && sw.dai.on) o.push(`ip arp inspection vlan ${vl}`);
    if (Object.values(sw.ports).some((p) => p.dot1x)) o.push('aaa new-model', 'aaa authentication dot1x default group radius', 'dot1x system-auth-control');
    o.push('!');
  }
  // DHCP 位址池
  for (const i of dev.ifaces) {
    if (!i.dhcp || !i.dhcp.on || !i.rt || i.rt.ip == null) continue;
    const a = parseIp(i.dhcp.start), b = parseIp(i.dhcp.end);
    const net = netOf(i.rt.ip, i.rt.bits), bc = bcastOf(i.rt.ip, i.rt.bits);
    if (a != null && a > net + 1) o.push(`ip dhcp excluded-address ${fmtIp(net + 1)} ${fmtIp(a - 1)}`);
    if (b != null && b < bc - 1) o.push(`ip dhcp excluded-address ${fmtIp(b + 1)} ${fmtIp(bc - 1)}`);
    o.push(`ip dhcp pool ${poolName(i)}`, ` network ${fmtIp(net)} ${fmtMask(i.rt.bits)}`, ` default-router ${i.dhcp.gw || fmtIp(i.rt.ip)}`);
    if (i.dhcp.dns) o.push(` dns-server ${i.dhcp.dns.replace(/[,\s]+/g, ' ')}`);
    o.push('!');
    for (const r of i.dhcp.reserved || []) {
      if (parseIp(r.ip || '') == null || !colonMac(r.mac)) continue;
      o.push(`ip dhcp pool ${rsvName(r)}`, ` host ${r.ip} ${fmtMask(i.rt.bits)}`, ` hardware-address ${dotMac(colonMac(r.mac))}`, '!');
    }
  }
  for (const p of dev.dhcpPools || []) {
    o.push(`ip dhcp pool ${p.name}`);
    if (p.host) o.push(` host ${p.host}`);
    if (p.mac) o.push(` hardware-address ${dotMac(p.mac)}`);
    if (p.net != null) o.push(` network ${fmtIp(p.net)} ${fmtMask(p.bits)}`);
    if (p.gw) o.push(` default-router ${p.gw}`);
    if (p.dns) o.push(` dns-server ${p.dns.replace(/[,\s]+/g, ' ')}`);
    o.push('!');
  }
  // IPsec VPN：第一階段政策、金鑰、第二階段的 transform-set，最後用 crypto map 把它們和對端、ACL 綁在一起
  const vp = dev.vpns || [];
  const cmIf = new Map(); // 圖形介面建立的通道沒有明確套用 crypto map：視為套用在通往對端的那個介面上
  for (const T of (dev.rt && dev.rt.tunnels) || []) {
    const i = T.cfg && !T.cfg.cmap && T.localIp != null && dev.ifaces.find((x) => x.rt && x.rt.ip === T.localIp);
    if (i) cmIf.set(i, cmapOf(T.cfg));
  }
  if (vp.length || (dev.isakmp && dev.isakmp.length)) {
    for (const p of isakmpOf(dev)) o.push(`crypto isakmp policy ${p.n}`, ` encryption ${ENC_IOS[p.enc] || 'aes'}`, ` hash ${HASH_IOS[p.hash] || 'sha'}`, ' authentication pre-share', ` group ${p.dh}`);
    for (const t of vp) if (t.psk && t.peer) o.push(`crypto isakmp key ${t.psk} address ${t.peer}`);
    o.push('!');
    const sets = new Map(Object.entries(dev.tsets || {}));
    for (const t of vp) if (!sets.has(tsetOf(t))) sets.set(tsetOf(t), { enc2: t.enc2 || t.enc || 'aes128', hash2: t.hash2 || t.hash || 'sha1' });
    for (const [name, s] of sets) o.push(`crypto ipsec transform-set ${name} esp-${ENC_IOS[s.enc2]} esp-${HASH_IOS[s.hash2]}-hmac`, ' mode tunnel');
    if (sets.size) o.push('!');
    for (const t of vp) {
      o.push(`crypto map ${cmapOf(t)} ${seqOf(dev, t)} ipsec-isakmp`);
      if (t.name && t.name !== `${cmapOf(t)}-${seqOf(dev, t)}`) o.push(` description ${t.name}`);
      if (t.peer) o.push(` set peer ${t.peer}`);
      o.push(` set transform-set ${tsetOf(t)}`);
      if (t.pfs) o.push(` set pfs group${t.pfs}`);
      o.push(` match address ${vpnAclOf(t)}`);
    }
    if (vp.length) o.push('!');
  }
  const natOut = (i) => i.nat || (i.natOut && !i.natRule);
  const natRule = (i) => i.nat || (i.natRule && !i.natOut);
  const anyNat = dev.ifaces.some(natOut);
  const l3lines = (i) => {
    const l = [];
    if (i.mode === 'dhcp') l.push(' ip address dhcp');
    else if (i.mode === 'pppoe') l.push(' pppoe-client dial-pool-number 1', ` ! PPPoE 帳號 ${i.user || '(未設定)'}`);
    else if (i.ip && parseMask(i.mask) != null) l.push(` ip address ${i.ip} ${fmtMask(parseMask(i.mask))}`);
    else l.push(' no ip address');
    if (anyNat) l.push(natOut(i) ? ' ip nat outside' : i.ip || i.mode !== 'static' ? ' ip nat inside' : null);
    if (i.helper) l.push(` ip helper-address ${i.helper}`);
    if (i.ospf && i.ospfCost) l.push(` ip ospf cost ${i.ospfCost}`);
    if (i.aclIn && i.aclIn.length) l.push(` ip access-group ${aclName(i, 'in')} in`);
    if (i.aclOut && i.aclOut.length) l.push(` ip access-group ${aclName(i, 'out')} out`);
    if (i.vrrp && i.vrrp.on) l.push(` vrrp 1 ip ${i.vrrp.vip || '(未設定)'}`, ` vrrp 1 priority ${i.vrrp.prio || 100}`);
    if (i.ip6) l.push(` ipv6 address ${i.ip6}`);
    if (i.ip6 && !i.ra) l.push(' ipv6 nd ra suppress all');
    if (i.cmap || cmIf.has(i)) l.push(` crypto map ${i.cmap || cmIf.get(i)}`);
    return l.filter(Boolean);
  };
  for (const p of dev.ports) {
    const peer = state.cables.find((c) => (c.a.dev === dev.id && c.a.port === p.id) || (c.b.dev === dev.id && c.b.port === p.id));
    const other = peer && state.devices[peer.a.dev === dev.id ? peer.b.dev : peer.a.dev];
    const desc = other ? [` description to ${other.kind === 'internet' ? 'ISP' : hostName(other)}`] : [];
    const pc = dev.sw && dev.sw.ports[p.id];
    if (pc && isSw(dev)) {
      const def = pc.mode === 'access' && pc.vlan === 1 && !pc.shut && !peer && !pc.trust && !(+pc.lag > 0) && !(pc.ps && pc.ps.on) && !pc.bpduguard && !pc.rootguard && !pc.dot1x;
      if (def) continue;
      o.push(`interface ${p.label}`, ...desc);
      if (pc.mode === 'routed') {
        const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
        o.push(' no switchport', ...(i ? l3lines(i) : []));
      } else if (pc.mode === 'trunk') {
        o.push(' switchport mode trunk');
        if (pc.native !== 1) o.push(` switchport trunk native vlan ${pc.native}`);
        if (pc.allowed && pc.allowed !== 'all') o.push(` switchport trunk allowed vlan ${pc.allowed}`);
      } else {
        o.push(' switchport mode access');
        if (pc.vlan !== 1) o.push(` switchport access vlan ${pc.vlan}`);
        o.push(' spanning-tree portfast');
      }
      if (+pc.lag > 0) o.push(` channel-group ${+pc.lag} mode ${pc.lagMode || 'active'}`);
      if (pc.ps && pc.ps.on) {
        o.push(' switchport port-security');
        for (const mac of String(pc.ps.macs || '').split(/[,\s]+/).filter(Boolean)) o.push(` switchport port-security mac-address ${dotMac(mac)}`);
        o.push(` switchport port-security violation ${pc.ps.mode || 'restrict'}`);
      }
      if (pc.trust) o.push(' ip dhcp snooping trust', ...(dev.sw.dai && dev.sw.dai.on ? [' ip arp inspection trust'] : []));
      if (pc.bpduguard) o.push(' spanning-tree bpduguard enable');
      if (pc.rootguard) o.push(' spanning-tree guard root');
      if (pc.dot1x) o.push(' authentication port-control auto', ' dot1x pae authenticator');
      if (pc.shut) o.push(' shutdown');
      o.push('!');
    } else if (!pc) {
      const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
      if (!i) continue;
      o.push(`interface ${p.label}`, ...desc, ...l3lines(i), i.shut ? ' shutdown' : ' no shutdown', '!');
      for (const s of dev.ifaces.filter((x) => x.bind.t === 'sub' && x.bind.port === p.id)) {
        o.push(`interface ${s.label}`, ` encapsulation dot1Q ${s.bind.vlan}`, ...l3lines(s), '!');
      }
    }
  }
  for (const i of dev.ifaces.filter((x) => x.bind.t === 'svi')) {
    if (!i.ip && dev.kind === 'mswitch') continue;
    o.push(`interface Vlan${i.bind.vlan}`, ...l3lines(i), ' no shutdown', '!');
  }
  if (dev.kind === 'mswitch') {
    const mg = dev.ifaces.find((x) => x.id === 'mgmt');
    if (mg && mg.gateway) o.push(`ip default-gateway ${mg.gateway}`, '!');
  }
  const os = dev.ifaces.filter((i) => i.ospf && i.rt && i.rt.ip != null).sort((a, b) => netOf(a.rt.ip, a.rt.bits) - netOf(b.rt.ip, b.rt.bits));
  if (os.length) {
    o.push('router ospf 1');
    for (const i of os) o.push(` network ${fmtIp(netOf(i.rt.ip, i.rt.bits))} ${wild(i.rt.bits)} area 0`);
    if (dev.ospfDefault) o.push(' default-information originate');
    o.push('!');
  }
  for (const i of dev.ifaces) if (i.mode === 'static' && i.gateway && dev.routing) o.push(`ip route 0.0.0.0 0.0.0.0 ${i.gateway}`);
  for (const r of dev.routes || []) {
    if (!r.dst || !r.via) continue;
    o.push(`ip route ${r.dst} ${parseMask(r.mask || '') != null ? fmtMask(parseMask(r.mask)) : r.mask} ${r.via}${+r.ad > 1 ? ' ' + r.ad : ''}`);
  }
  for (const r of dev.routes6 || []) if (r.dst && r.via) o.push(`ipv6 route ${r.dst} ${r.via}`);
  const out = dev.ifaces.filter(natRule);
  // NAT 的範圍：指定的 ACL、圖形介面填的「NAT 例外」（轉成一份 ACL），或預設的 list 1（全部轉換）
  const natList = (i) => i.natAcl || (splitList(i.natSkip).length ? 'NAT-' + i.label.replace(/[^\w.]+/g, '_').toUpperCase() : '1');
  for (const i of out) o.push(`ip nat inside source list ${natList(i)} interface ${i.label} overload`);
  for (const n of dev.staticNat || []) if (n.pub && n.priv) o.push(`ip nat inside source static ${n.priv} ${n.pub}`);
  for (const f of dev.portForwards || []) {
    if (f.port && f.toIp && out[0]) o.push(`ip nat inside source static ${f.proto || 'tcp'} ${f.toIp} ${f.toPort || f.port} interface ${out[0].label} ${f.port}`);
  }
  if (out.some((i) => natList(i) === '1') && !(dev.aclDefs || {})['1']) o.push('access-list 1 permit any');
  for (const i of out) {
    if (i.natAcl || !splitList(i.natSkip).length) continue;
    o.push('!', `ip access-list extended ${natList(i)}`, ...splitList(i.natSkip).map((n) => ' ' + aclLine({ action: 'deny', proto: 'ip', src: 'any', dst: n, port: '' })), ' permit ip any any');
  }
  for (const i of dev.ifaces) {
    for (const [key, dir] of [['aclIn', 'in'], ['aclOut', 'out']]) {
      if (!i[key] || !i[key].length) continue;
      o.push('!', `ip access-list extended ${aclName(i, dir)}`);
      for (const r of i[key]) o.push(' ' + aclLine(r));
    }
  }
  for (const t of vp) {
    const rules = selRules(t);
    if (!rules.length) continue;
    o.push('!', `ip access-list extended ${vpnAclOf(t)}`);
    for (const r of rules) o.push(' ' + aclLine(r));
  }
  for (const [name, list] of Object.entries(dev.aclDefs || {})) {
    if (!list.length || vp.some((t) => vpnAclOf(t) === name)) continue;
    if (/^\d+$/.test(name)) { // 編號的 ACL：1-99 是標準（只有來源），100 以上是延伸
      o.push('!');
      for (const r of list) o.push(`access-list ${name} ${+name < 100 ? `${r.action} ${aclAddr(r.src)}` : aclLine(r)}`);
      continue;
    }
    o.push('!', `ip access-list extended ${name}`);
    for (const r of list) o.push(' ' + aclLine(r));
  }
  if (dev.radius && dev.radius.ip) o.push('!', 'radius server AAA', ` address ipv4 ${dev.radius.ip} auth-port 1812 acct-port 1813`, ` key 7 ${hex(dev.radius.secret || '')}`);
  if (m) {
    o.push('!');
    if (m.ntp) o.push(`ntp server ${m.ntp}`);
    if (m.syslog) o.push(`logging host ${m.syslog}`);
    const snmp = m.snmp || 'v2c';
    if (snmp === 'v2c') o.push(`snmp-server community ${m.community || 'public'} RO`);
    else if (snmp === 'v3') o.push('snmp-server group NMS v3 priv'); // SNMPv3 的使用者不會出現在 running-config 裡，真的 IOS 也是如此
    o.push(m.http ? 'ip http server' : 'no ip http server', m.https ? 'ip http secure-server' : 'no ip http secure-server');
    const allow = String(m.allow || '').split(/[,\s]+/).filter(Boolean).map((s) => { const x = s.match(/^([\d.]+)(?:\/(\d+))?$/); const ip = x && parseIp(x[1]); return ip == null ? null : { net: ip, bits: x[2] == null ? 32 : +x[2] }; }).filter(Boolean);
    const an = m.aclName || 'MGMT';
    if (allow.length) { o.push(`ip access-list standard ${an}`); for (const c of allow) o.push(c.bits === 32 ? ` permit host ${fmtIp(c.net)}` : ` permit ${fmtIp(netOf(c.net, c.bits))} ${wild(c.bits)}`); }
    const tr = [m.ssh && 'ssh', m.telnet && 'telnet'].filter(Boolean).join(' ') || 'none';
    o.push('line vty 0 4', ` transport input ${tr}`, ...(allow.length ? [` access-class ${an} in`] : []), ' login local');
  }
  o.push('!', 'end');
  return o;
}
