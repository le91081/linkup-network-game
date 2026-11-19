// IOS 風格的設定指令：把 configure terminal 之後輸入的指令套用到設備的設定物件上。
// 不依賴瀏覽器，可以直接用 Node 測試。支援的範圍就是 show running-config 會印出來的那些指令，
// 所以把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定。
import { parseIp, fmtIp, parseMask, fmtMask, maskOf, netOf, bcastOf } from './ip.js';
import { parseCidr6, parseIp6 } from './ip6.js';
import { newIface, cloneState, CATALOG, makeDevice, defaultPortMode } from './model.js';
import { cdpCfg, lldpCfg, portNd, setPortNd, speaksCdp, clearNeighbors, CDP_TIMER, CDP_HOLD, LLDP_TIMER, LLDP_HOLD } from './disc.js';
import { transfer, configFile, ensureFlash, flashFree, flashPath, fsName, IMAGES, PLATFORM, PLATFORM_NAME, imageFile, fmtBytes } from './files.js';
import { macsBehind, recompute, ospfOn } from './sim.js';
import { logEvent, markReboot, setClock, deviceTime, SEVERITY, bootTime } from './ops.js';
import { spanDest } from './wire.js';
import { genKey } from './remote.js';

// ───────────────────────── running-config 與 startup-config ─────────────────────────
// IOS 設備改的是記憶體裡的 running-config；要下 write memory 才會存進 startup-config。
// 沒有存檔就重新開機（reload 或斷電），設定會回到上一次存檔的樣子。

/** 這台設備是不是跑 IOS（有 running / startup 兩份設定） */
export const isIos = (dev) => !dev.locked && CATALOG[dev.model].vendor === 'Cisco' && ['router', 'mswitch', 'l3switch'].includes(dev.kind);
// fw（正在跑的韌體）與 flash 裡的檔案不是設定：重新開機、還原設定都不會動到它們
const KEEP = new Set(['id', 'model', 'kind', 'pos', 'ports', 'rt', 'startup', 'locked', 'note', 'fw', 'flash', 'fwNext']);
const snapshot = (dev) => JSON.stringify(Object.fromEntries(Object.entries(dev).filter(([k]) => !KEEP.has(k))), (k, v) => (k === 'rt' ? undefined : v));
/** write memory：把目前的設定存成 startup-config */
export function saveStartup(dev) { dev.startup = snapshot(dev); }
/** 重新開機：running-config 回到 startup-config */
export function restoreStartup(dev) {
  if (dev.startup == null) return;
  for (const k of Object.keys(dev)) if (!KEEP.has(k)) delete dev[k];
  Object.assign(dev, JSON.parse(dev.startup));
}
/**
 * 用一份設定檔（running-config 的格式）建立 startup-config：從出廠狀態開始，把每一行套上去。
 * copy tftp: startup-config 再 reload，就是「整份換掉」的還原方式。RSA 金鑰存在另一個地方，不受影響
 */
export function startupFromText(state, dev, lines) {
  const s2 = cloneState(state);
  const fresh = makeDevice(dev.model, dev.id, { name: dev.name, pos: dev.pos });
  for (const k of KEEP) if (k in dev && k !== 'rt' && k !== 'startup') fresh[k] = JSON.parse(JSON.stringify(dev[k]));
  s2.devices[dev.id] = fresh;
  recompute(s2);
  const sess = iosSession(() => s2.devices[dev.id], () => s2);
  sess.exec('configure terminal');
  const bad = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t === '!' || t === 'end' || /^Building configuration/.test(t) || /^Current configuration/i.test(t)) continue;
    const r = sess.exec(l);
    if (r.out.some((x) => x.startsWith('%'))) bad.push(t);
  }
  const key = dev.mgmt && dev.mgmt.sshKey;
  if (key && fresh.mgmt) fresh.mgmt.sshKey = key;
  dev.startup = snapshot(fresh);
  return bad;
}

/** startup-config 的內容（和 show running-config 同樣的格式） */
export function startupConfig(state, dev) {
  if (dev.startup == null) return null;
  const s2 = cloneState(state);
  restoreStartup(s2.devices[dev.id]);
  recompute(s2);
  return runningConfig(s2, s2.devices[dev.id]);
}
/** running-config 有沒有還沒存檔的變更 */
export function iosDirty(state, dev) {
  const saved = startupConfig(state, dev);
  return saved != null && saved.join('\n') !== runningConfig(state, dev).join('\n');
}

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
const DTP_OK = (d) => defaultPortMode(d.model) !== 'access';
function tidy(d, k) {
  const o = d[k];
  if (!o) return;
  for (const x of Object.keys(o)) if (o[x] === undefined) delete o[x];
  if (!Object.keys(o).length) delete d[k];
}
const isErr = (r) => typeof r === 'string' && r.startsWith('%');
const dotted = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s || '');
const maskBits = (s) => (dotted(s) ? parseMask(s) : null);
const wildBits = (s) => (dotted(s) && parseIp(s) != null ? parseMask(fmtIp(~parseIp(s) >>> 0)) : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 比對指令樣式：文字只要打出開頭幾個字母（IOS 的縮寫），<x> 是參數，<...> 吃掉剩下所有字，[...] 則可以是空的 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// ip nat translation 的計時器 → 連線表裡對應的種類。timeout 是通用的（一次設定三種）
const NAT_TIMER = {
  timeout: ['tcp', 'udp', 'icmp'], 'tcp-timeout': ['tcp'], 'udp-timeout': ['udp'], 'icmp-timeout': ['icmp'],
  'dns-timeout': ['dns'], 'syn-timeout': ['syn'], 'finrst-timeout': ['fin'],
};

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

/** 介面名稱（可以縮寫：gi0/1、GigabitEthernet0/1、g0/0/0）→ 設備上的實體埠，找不到就回傳 null */
export function portByName(dev, text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^([a-z]+)([\d/]+)$/);
  return (m && findPort(dev, m[1], m[2])) || dev.ports.find((p) => p.id.toLowerCase() === s || p.label.toLowerCase() === s) || null;
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
    Object.assign(i.dhcp, { on: true, pool: p.name, gw: p.gw || '', dns: p.dns || '', lease: p.lease || '' });
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
  exec: ['configure terminal    進入設定模式', 'show ...              查看狀態（輸入 show ? 列出全部）', 'ping <IP>             測試連線',
    'write memory          把 running-config 存成 startup-config（沒存檔的設定重新開機後會消失）', 'reload                重新開機，回到 startup-config'],
  config: ['hostname <名稱>', 'interface <介面> | interface range <介面> - <n> | interface vlan <ID>', 'vlan <ID>', 'ip route <網段> <遮罩> <下一站> [距離]',
    'router ospf 1', 'ip dhcp pool <名稱> / ip dhcp excluded-address <起> <迄>', 'ip nat inside source list 1 interface <介面> overload',
    'ip nat inside source static <內部 IP> <公用 IP>', 'ip access-list extended <名稱>', 'spanning-tree vlan <清單> priority <值>',
    'ip dhcp snooping / ip arp inspection vlan <清單>', 'line vty 0 4', 'ntp server / logging host / snmp-server community', 'cdp run / no cdp run / lldp run / cdp timer / lldp timer', 'do <show 指令>、end、exit'],
  if: ['ip address <IP> <遮罩> | ip address dhcp', 'shutdown / no shutdown', 'switchport mode access|trunk|dynamic auto|dynamic desirable', 'switchport nonegotiate', 'switchport voice vlan <ID>', 'no cdp enable / no lldp transmit / no lldp receive', 'switchport access vlan <ID>',
    'switchport trunk native vlan <ID> / allowed vlan <清單>', 'no switchport（L3 交換器改成 Routed 埠）', 'ip nat inside|outside', 'ip helper-address <IP>',
    'ip ospf cost <值>', 'ip access-group <名稱> in|out', 'encapsulation dot1q <VLAN>（子介面）', 'vrrp 1 ip <虛擬 IP> / vrrp 1 priority <值>',
    'channel-group <編號> mode active|passive|on', 'switchport port-security [mac-address <MAC> | violation <模式>]',
    'spanning-tree bpduguard enable / spanning-tree guard root', 'ip dhcp snooping trust', 'ipv6 address <位址/前綴>', 'speed 10|100|1000|auto、duplex auto|full|half'],
  vlan: ['name <名稱>'],
  router: ['network <網段> <萬用遮罩> area 0', 'default-information originate'],
  dhcp: ['network <網段> <遮罩>', 'default-router <IP>', 'dns-server <IP> [IP]', 'lease <天> [小時] [分鐘]', 'host <IP> <遮罩> 加上 hardware-address <MAC>（保留位址）'],
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
/** who：從遠端登入時是誰、從哪裡（{ user, line, ip }），用在紀錄裡 */
export function iosSession(getDev, getState, who = null) {
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
    ['switchport mode dynamic <m>', ([m]) => {
      const mode = ['auto', 'desirable'].find((x) => x.startsWith(m.toLowerCase()));
      if (!mode) return err('用法：switchport mode dynamic auto | desirable');
      if (!DTP_OK(dev())) return err('這台交換器不支援 DTP（Nexus 沒有 dynamic 模式），請用 switchport mode access 或 trunk');
      return onL2((pc, t) => (pc.noneg ? err(`Conflict between 'nonegotiate' and 'dynamic' status on this interface: ${t.name}`) : void (pc.mode = 'dynamic-' + mode)));
    }],
    ['switchport mode <m>', ([m]) => {
      const mode = ['access', 'trunk'].find((x) => x.startsWith(m.toLowerCase()));
      return mode ? onL2((pc) => { pc.mode = mode; }) : err('模式必須是 access、trunk、dynamic auto 或 dynamic desirable');
    }],
    ['no switchport mode', () => onL2((pc, t) => (pc.noneg && DTP_OK(dev()) ? err(`Conflict between 'nonegotiate' and 'dynamic' status on this interface: ${t.name}`) : void (pc.mode = defaultPortMode(dev().model))))],
    ['switchport voice vlan <id>', ([id], out) => {
      if (!(+id >= 1 && +id <= 4094)) return err('VLAN ID 必須是 1 – 4094（也可以用 dot1p、untagged、none，但這裡只支援 VLAN 編號）');
      return onL2((pc) => {
        const sw = dev().sw;
        if (!sw.vlans.some((v) => v.id === +id)) { sw.vlans.push({ id: +id, name: 'VLAN' + String(id).padStart(4, '0') }); out.push(`% Voice VLAN does not exist. Creating vlan ${+id}`); }
        pc.voice = +id;
      });
    }],
    ['no switchport voice vlan [...]', () => onL2((pc) => { delete pc.voice; })],
    ['switchport access vlan <id>', ([id], out) => (+id >= 1 && +id <= 4094 ? onL2((pc) => { ensureVlan(+id, out); pc.vlan = +id; }) : err('VLAN ID 必須是 1 – 4094'))],
    ['no switchport access vlan', () => onL2((pc) => { pc.vlan = 1; })],
    ['switchport trunk native vlan <id>', ([id]) => (+id >= 1 && +id <= 4094 ? onL2((pc) => { pc.native = +id; }) : err('VLAN ID 必須是 1 – 4094'))],
    ['no switchport trunk native vlan', () => onL2((pc) => { pc.native = 1; })],
    ['switchport trunk allowed vlan add <list>', ([list]) => onL2((pc) => { pc.allowed = pc.allowed === 'all' || !pc.allowed ? 'all' : [...new Set([...pc.allowed.split(','), ...list.split(',')])].join(','); })],
    ['switchport trunk allowed vlan <list>', ([list]) => (/^(all|\d+(-\d+)?(,\d+(-\d+)?)*)$/i.test(list) ? onL2((pc) => { pc.allowed = list.toLowerCase(); }) : err('VLAN 清單的格式：10,20 或 10-20 或 all'))],
    ['no switchport trunk allowed vlan', () => onL2((pc) => { pc.allowed = 'all'; })],
    ['switchport trunk encapsulation <e>', () => onL2(() => {})],
    ['switchport nonegotiate', () => onL2((pc, t) => (/^dynamic/.test(pc.mode) ? err(`Conflict between 'nonegotiate' and 'dynamic' status on this interface: ${t.name}`) : void (pc.noneg = true)))],
    ['no switchport nonegotiate', () => onL2((pc) => { delete pc.noneg; })],
    // ── CDP / LLDP（介面）──
    ['cdp enable', () => ndIf('cdp', true)],
    ['no cdp enable', () => ndIf('cdp', false)],
    ['lldp transmit', () => ndIf('tx', true)],
    ['no lldp transmit', () => ndIf('tx', false)],
    ['lldp receive', () => ndIf('rx', true)],
    ['no lldp receive', () => ndIf('rx', false)],
    ['no switchport', () => each((t) => {
      const d = dev();
      if (!t.pc || d.kind !== 'l3switch') return err('只有 L3 交換器的連接埠可以改成 Routed 埠');
      t.pc.mode = 'routed';
      if (!t.iface) { t.iface = newIface(t.port.id, t.port.label, { t: 'port', port: t.port.id }); d.ifaces.push(t.iface); }
      return undefined;
    })],
    ['switchport', () => onL2((pc) => { if (pc.mode === 'routed') pc.mode = defaultPortMode(dev().model); })],
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
    ['spanning-tree portfast [...]', ([opt]) => onL2((pc) => { pc.portfast = !(opt || '').toLowerCase().startsWith('dis'); })],
    ['no spanning-tree portfast', () => onL2((pc) => { delete pc.portfast; })],
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
    // ── 實體層：速率與雙工（要放在 spanning-tree 之後，sp 的縮寫才不會被搶走） ──
    ['speed <v>', ([v]) => (['auto', '10', '100', '1000'].includes(v.toLowerCase()) ? setPhy('speed', v.toLowerCase()) : err('speed 可用的值：10、100、1000、auto'))],
    ['no speed', () => setPhy('speed', 'auto')],
    ['duplex <v>', ([v]) => { const d = ['auto', 'full', 'half'].find((x) => x.startsWith(v.toLowerCase())); return d ? setPhy('duplex', d) : err('duplex 可用的值：auto、full、half'); }],
    ['no duplex', () => setPhy('duplex', 'auto')],
  ];
  /** cdp enable / lldp transmit 這類介面指令：只能下在實體介面上 */
  function ndIf(key, on) {
    return each((t) => {
      if (!t.port) return err(`${t.name} 不是實體介面；CDP / LLDP 要設定在實體介面上`);
      if (key === 'cdp' && !speaksCdp(dev())) return err('這台設備不支援 CDP');
      setPortNd(dev(), t.port.id, key, on);
      return undefined;
    });
  }
  function setPhy(key, v) {
    return each((t) => {
      const c = t.pc || (t.port && t.iface);
      if (!c) return err('只有實體連接埠可以設定速率與雙工');
      if (t.port.media !== 'rj45' && v !== 'auto') return err('光纖埠的速率由收發器決定，不能手動設定');
      c[key] = v === 'auto' ? '' : v;
      return undefined;
    });
  }

  // ── 全域設定模式 ──
  const needSw = () => (isSw(dev()) ? null : err('這個指令只適用於交換器'));
  const needRouting = () => (dev().routing ? null : err('這台是 L2 交換器，沒有路由功能（要讓它能被遠端管理請用 ip default-gateway）'));
  const enter = (mode, cur) => { S.mode = mode; S.cur = cur; };
  const ifByName = (name) => { const t = resolveIf(dev(), name); return isErr(t) ? t : t.iface || err(`${t.name} 不是第三層介面`); };
  const addUnique = (list, item) => { if (!list.some((x) => same(x, item))) list.push(item); };

  const CONFIG = [
    ['hostname <name>', ([name]) => { dev().name = name; }],
    ['cdp run', () => { delete (dev().cdp ||= {}).run; tidy(dev(), 'cdp'); }],
    ['no cdp run', () => { (dev().cdp ||= {}).run = false; }],
    ['cdp timer <n>', ([n]) => (+n >= 5 && +n <= 254 ? void ((dev().cdp ||= {}).timer = +n === CDP_TIMER ? undefined : +n, tidy(dev(), 'cdp')) : err('CDP timer 的範圍是 5 – 254 秒'))],
    ['no cdp timer', () => { if (dev().cdp) delete dev().cdp.timer; tidy(dev(), 'cdp'); }],
    ['cdp holdtime <n>', ([n]) => (+n >= 10 && +n <= 255 ? void ((dev().cdp ||= {}).hold = +n === CDP_HOLD ? undefined : +n, tidy(dev(), 'cdp')) : err('CDP holdtime 的範圍是 10 – 255 秒'))],
    ['no cdp holdtime', () => { if (dev().cdp) delete dev().cdp.hold; tidy(dev(), 'cdp'); }],
    ['cdp advertise-v2', () => { if (dev().cdp) delete dev().cdp.v2; tidy(dev(), 'cdp'); }],
    ['no cdp advertise-v2', () => { (dev().cdp ||= {}).v2 = false; }],
    ['lldp run', () => { (dev().lldp ||= {}).run = true; }],
    ['no lldp run', () => { (dev().lldp ||= {}).run = false; }],
    ['lldp timer <n>', ([n]) => (+n >= 5 && +n <= 65534 ? void ((dev().lldp ||= {}).timer = +n === LLDP_TIMER ? undefined : +n, tidy(dev(), 'lldp')) : err('LLDP timer 的範圍是 5 – 65534 秒'))],
    ['no lldp timer', () => { if (dev().lldp) delete dev().lldp.timer; tidy(dev(), 'lldp'); }],
    ['lldp holdtime <n>', ([n]) => (+n >= 0 && +n <= 65535 ? void ((dev().lldp ||= {}).hold = +n === LLDP_HOLD ? undefined : +n, tidy(dev(), 'lldp')) : err('LLDP holdtime 的範圍是 0 – 65535 秒'))],
    ['no lldp holdtime', () => { if (dev().lldp) delete dev().lldp.hold; tidy(dev(), 'lldp'); }],
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
    ['no router ospf <pid>', () => { const d = dev(); for (const i of d.ifaces) i.ospf = false; d.ospfDefault = false; d.ospfNets = []; }],
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
    ['spanning-tree portfast default', () => needSw() || void ((dev().sw.stp ||= {}).portfastDefault = true)],
    ['no spanning-tree portfast default', () => needSw() || void ((dev().sw.stp ||= {}).portfastDefault = false)],
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
    // 登入失敗太多次就暫時拒絕所有登入（擋暴力破解）
    ['login block-for <sec> attempts <n> within <w>', ([sec, n, w]) => {
      const m = dev().mgmt;
      if (!m) return err('這台設備不支援');
      if (![sec, n, w].every((x) => /^\d+$/.test(x)) || +sec < 1 || +sec > 65535 || +n < 1 || +n > 65535 || +w < 1 || +w > 65535) return err('用法：login block-for <封鎖幾秒> attempts <失敗幾次> within <幾秒之內>');
      m.block = { sec: +sec, tries: +n, within: +w };
      return undefined;
    }],
    ['no login block-for [...]', () => { if (dev().mgmt) delete dev().mgmt.block; }],
    ['login on-failure log [...]', () => { const m = dev().mgmt; if (m) (m.loginLog ||= {}).fail = true; }],
    ['login on-success log [...]', () => { const m = dev().mgmt; if (m) (m.loginLog ||= {}).ok = true; }],
    ['no login on-failure [...]', () => { const m = dev().mgmt; if (m && m.loginLog) { delete m.loginLog.fail; if (!m.loginLog.ok) delete m.loginLog; } }],
    ['no login on-success [...]', () => { const m = dev().mgmt; if (m && m.loginLog) { delete m.loginLog.ok; if (!m.loginLog.fail) delete m.loginLog; } }],
    // 登入時顯示的訊息。前後用同一個符號包起來
    ['banner motd <...>', ([text]) => {
      const m = dev().mgmt, x = text.trim(), end = x.indexOf(x[0], 1);
      if (!m) return err('這台設備不支援');
      if (x.length < 3 || end < 0) return err('用法：banner motd #要顯示的文字#（前後用同一個符號包起來，文字只能一行）');
      m.banner = x.slice(1, end);
      return undefined;
    }],
    ['no banner motd [...]', () => { if (dev().mgmt) delete dev().mgmt.banner; }],
    // ── 連接埠鏡像 (SPAN)：把來源埠進出的訊框複製一份到目的埠，接上電腦就能用 Wireshark 看 ──
    ['monitor session <n> source interface <...>', ([n, rest]) => {
      const e = needSw();
      if (e) return e;
      if (!/^\d+$/.test(n) || +n < 1 || +n > 66) return err('session 編號是 1 – 66');
      const t = rest.trim().split(/\s+/), last = t[t.length - 1].toLowerCase();
      const dir = ['rx', 'tx', 'both'].includes(last) ? (t.pop(), last) : 'both';
      const r = resolveRange(dev(), t.join(' '));
      if (isErr(r)) return r;
      const sw = dev().sw, s = ((sw.span ||= {})[n] ||= { src: {}, dst: '' });
      for (const x of r) {
        if (!x.port) return err(`${x.name} 不是實體連接埠`);
        if (s.dst === x.port.id) return err(`% ${x.port.label} 已經是這個 session 的目的埠，不能同時當來源`);
        s.src[x.port.id] = dir;
      }
      return undefined;
    }],
    ['monitor session <n> destination interface <...>', ([n, rest]) => {
      const e = needSw();
      if (e) return e;
      if (!/^\d+$/.test(n) || +n < 1 || +n > 66) return err('session 編號是 1 – 66');
      const t = resolveIf(dev(), rest.trim().split(/\s+/)[0]);
      if (isErr(t)) return t;
      if (!t.port) return err(`${t.name} 不是實體連接埠`);
      const sw = dev().sw, s = ((sw.span ||= {})[n] ||= { src: {}, dst: '' });
      if (s.src[t.port.id]) return err(`% ${t.port.label} 已經是這個 session 的來源埠，不能同時當目的埠`);
      const other = Object.entries(sw.span).find(([k, x]) => k !== n && x.dst === t.port.id);
      if (other) return err(`% ${t.port.label} 已經是 session ${other[0]} 的目的埠`);
      s.dst = t.port.id;
      return `（${t.port.label} 現在是 SPAN 的目的埠：交換器只會從這裡送出複製的訊框，接在上面的設備不能再用它上網）`;
    }],
    ['no monitor session <n> source interface <...>', ([n, rest]) => {
      const s = ((dev().sw || {}).span || {})[n];
      if (!s) return err(`沒有 session ${n}`);
      const r = resolveRange(dev(), rest.trim().split(/\s+/).filter((x) => !['rx', 'tx', 'both'].includes(x.toLowerCase())).join(' '));
      if (isErr(r)) return r;
      for (const x of r) if (x.port) delete s.src[x.port.id];
      return undefined;
    }],
    ['no monitor session <n> [...]', ([n]) => {
      const sw = dev().sw;
      if (!sw || !sw.span) return undefined;
      if (n.toLowerCase() === 'all' || n.toLowerCase() === 'local') delete sw.span; else delete sw.span[n];
      if (sw.span && !Object.keys(sw.span).length) delete sw.span;
      return undefined;
    }],
    // ── 檔案傳輸與開機 ──
    ['boot system <...>', ([rest]) => {
      const t = rest.trim().split(/\s+/), f = t[t.length - 1];
      if (!/^(boot)?flash:/i.test(f)) return err('用法：boot system flash:<映像檔的檔名>');
      const d = dev();
      if (!PLATFORM[d.model]) return err('這台設備不支援');
      const name = `${fsName(d)}:${flashPath(f)}`;
      if (!(d.bootSys ||= []).includes(name)) d.bootSys.push(name);
      return (d.flash && d.flash.files[flashPath(f)]) ? undefined : `（${name} 現在不存在。開機時會跳過它，改用下一個）`;
    }],
    ['no boot system [...]', ([rest]) => {
      const d = dev(), f = (rest || '').trim().split(/\s+/).pop();
      if (!f) delete d.bootSys;
      else if (d.bootSys) { d.bootSys = d.bootSys.filter((b) => flashPath(b) !== flashPath(f)); if (!d.bootSys.length) delete d.bootSys; }
    }],
    ['ip ftp username <user>', ([u]) => { (dev().ftpLogin ||= {}).user = u; }],
    ['ip ftp password <...>', ([p]) => { (dev().ftpLogin ||= {}).pass = readSecret(p.split(/\s+/)); }],
    ['no ip ftp username [...]', () => { if (dev().ftpLogin) delete dev().ftpLogin.user; }],
    ['no ip ftp password [...]', () => { if (dev().ftpLogin) delete dev().ftpLogin.pass; }],
    ['ip tftp blocksize <n>', ([n]) => { if (!/^\d+$/.test(n) || +n < 512 || +n > 8192) return err('用法：ip tftp blocksize <512-8192>'); if (+n === 512) delete dev().tftpBlk; else dev().tftpBlk = +n; return undefined; }],
    ['no ip tftp blocksize [...]', () => { delete dev().tftpBlk; }],
    ['line vty [...]', () => { if (!dev().mgmt) return err('這台設備不支援'); enter('line', null); return undefined; }],
    ['line console [...]', () => { enter('line', 'console'); return undefined; }],
    ['ip http server', () => void (dev().mgmt && (dev().mgmt.http = true))],
    ['no ip http server', () => void (dev().mgmt && (dev().mgmt.http = false))],
    ['ip http secure-server', () => void (dev().mgmt && (dev().mgmt.https = true))],
    ['no ip http secure-server', () => void (dev().mgmt && (dev().mgmt.https = false))],
    ['ntp server <ip> [...]', ([ip]) => (parseIp(ip) == null ? err('IP 位址的格式不正確') : void (dev().mgmt && (dev().mgmt.ntp = ip)))],
    ['no ntp server [...]', () => void (dev().mgmt && (dev().mgmt.ntp = ''))],
    // 把自己的時鐘當成時間來源，替其他設備報時（沒有上游可以對時的時候用）
    ['ntp master [...]', ([n]) => {
      const m = dev().mgmt, s = n ? +n : 8;
      if (!m) return err('這台設備不支援');
      if (!Number.isInteger(s) || s < 1 || s > 15) return err('stratum 必須是 1 – 15（數字越小代表離標準時間越近，預設 8）');
      m.ntpMaster = s;
      return undefined;
    }],
    ['no ntp master [...]', () => { if (dev().mgmt) delete dev().mgmt.ntpMaster; }],
    ['clock timezone <name> <hours> [...]', ([name, hours]) => {
      const m = dev().mgmt, off = +hours;
      if (!m) return err('這台設備不支援');
      if (!Number.isInteger(off) || off < -12 || off > 14) return err('用法：clock timezone <名稱> <和 UTC 差幾小時>，例如 clock timezone TST 8');
      m.tz = { name, off };
      return undefined;
    }],
    ['no clock timezone [...]', () => { if (dev().mgmt) delete dev().mgmt.tz; }],
    // 嚴重程度在這個門檻以內的訊息才送到 Syslog 伺服器（預設 informational）
    ['logging trap <level>', ([lv]) => {
      const m = dev().mgmt, n = /^[0-7]$/.test(lv) ? +lv : SEVERITY.findIndex((s) => s.startsWith(lv.toLowerCase()));
      if (!m) return err('這台設備不支援');
      if (n < 0) return err('用法：logging trap <0-7 或名稱>：emergencies、alerts、critical、errors、warnings、notifications、informational、debugging');
      if (n === 6) delete m.logTrap; else m.logTrap = n;
      return undefined;
    }],
    ['no logging trap [...]', () => { if (dev().mgmt) delete dev().mgmt.logTrap; }],
    ['logging buffered [...]', () => undefined],
    ['logging console [...]', () => undefined],
    // MAC 位址表的項目多久沒看到就忘記（預設 300 秒）
    ['mac address-table aging-time <n>', ([n]) => {
      const e = needSw();
      if (e) return e;
      if (!/^\d+$/.test(n) || +n < 10 || +n > 1000000) return err('用法：mac address-table aging-time <10-1000000>（秒，預設 300）');
      if (+n === 300) delete dev().sw.macAge; else dev().sw.macAge = +n;
      return undefined;
    }],
    ['no mac address-table aging-time [...]', () => needSw() || void delete dev().sw.macAge],
    // NAT 轉換表的閒置逾時
    ['ip nat translation <kind> <n>', ([kind, n]) => {
      const d = dev(), k = NAT_TIMER[kind.toLowerCase()];
      if (!d.routing || !d.staticNat) return err('這台設備不支援 NAT');
      if (!k) return err('用法：ip nat translation timeout | tcp-timeout | udp-timeout | icmp-timeout | dns-timeout | syn-timeout | finrst-timeout <秒>');
      if (!/^\d+$/.test(n) || +n < 1 || +n > 536870) return err('秒數必須是 1 – 536870');
      for (const x of k) (d.natTimeout ||= {})[x] = +n;
      return undefined;
    }],
    ['no ip nat translation <kind> [...]', ([kind]) => {
      const d = dev(), k = NAT_TIMER[kind.toLowerCase()];
      if (!k) return err('沒有這個計時器');
      for (const x of k) if (d.natTimeout) delete d.natTimeout[x];
      if (d.natTimeout && !Object.keys(d.natTimeout).length) delete d.natTimeout;
      return undefined;
    }],
    ['logging host <ip>', ([ip]) => (parseIp(ip) == null ? err('IP 位址的格式不正確') : void (dev().mgmt && (dev().mgmt.syslog = ip)))],
    ['logging <ip>', ([ip]) => (parseIp(ip) == null ? err('用法：logging host <Syslog 伺服器 IP>') : void (dev().mgmt && (dev().mgmt.syslog = ip)))],
    ['no logging [...]', () => void (dev().mgmt && (dev().mgmt.syslog = ''))],
    // snmp-server community <字串> [RO|RW] [ACL]：ACL 限制只有哪些來源可以查詢
    ['snmp-server community <str> [...]', ([str, rest]) => {
      const m = dev().mgmt;
      if (!m) return err('這台設備不支援');
      const t = (rest || '').split(/\s+/).filter(Boolean);
      let rw = false, acl = null;
      for (let k = 0; k < t.length; k++) {
        if (/^ro$/i.test(t[k])) rw = false; else if (/^rw$/i.test(t[k])) rw = true; else if (/^view$/i.test(t[k])) k++; else acl = t[k].toUpperCase();
      }
      Object.assign(m, { snmp: 'v2c', community: str });
      if (rw) m.snmpRw = true; else delete m.snmpRw;
      if (acl) m.snmpAcl = acl; else delete m.snmpAcl;
      return rw ? '（RW community 可以用 SNMP 改設定：除非真的需要，只給 RO）' : undefined;
    }],
    ['no snmp-server community [...]', () => { const m = dev().mgmt; if (m && m.snmp !== 'v3') { m.snmp = 'off'; delete m.snmpAcl; delete m.snmpRw; } }],
    ['snmp-server group <...>', ([rest]) => { const m = dev().mgmt; if (m && /\bv3\b/i.test(rest)) { m.snmp = 'v3'; m.snmpGroup = rest.split(/\s+/)[0]; } }],
    // snmp-server user <使用者> <群組> v3 auth sha <認證密碼> priv aes 128 <加密密碼>（這一行不會出現在 running-config 裡）
    ['snmp-server user <...>', ([rest]) => {
      const m = dev().mgmt, t = rest.split(/\s+/), lo = t.map((x) => x.toLowerCase());
      if (!m) return err('這台設備不支援');
      const a = lo.indexOf('auth'), p = lo.indexOf('priv');
      if (t.length < 3 || lo[2] !== 'v3') return err('用法：snmp-server user <使用者> <群組> v3 auth sha <認證密碼> priv aes 128 <加密密碼>');
      if (a < 0 || !t[a + 2]) return err('SNMPv3 要設定認證：auth sha <密碼>（至少 8 個字元）');
      if (t[a + 2].length < 8) return err('% Password too short：認證密碼至少要 8 個字元');
      const pw = p >= 0 ? t[p + (['aes', '3des', 'des'].includes(lo[p + 1]) ? (lo[p + 1] === 'aes' ? 3 : 2) : 1)] : '';
      m.snmpUser = { user: t[0], group: t[1], auth: t[a + 2], priv: pw || '' };
      m.snmp = 'v3';
      if (!m.snmpGroup) m.snmpGroup = t[1];
      return pw ? undefined : '（沒有設定 priv：查詢的內容不會加密。公司規定要 v3 的話，通常是 auth 加上 priv）';
    }],
    ['no snmp-server user <...>', () => { const m = dev().mgmt; if (m) delete m.snmpUser; }],
    // snmp-server host <IP> [traps] [version 2c|3 [auth|noauth|priv]] <community 或使用者>：Trap 要送去哪裡
    ['snmp-server host <ip> [...]', ([ip, rest]) => {
      const m = dev().mgmt;
      if (!m) return err('這台設備不支援');
      if (parseIp(ip) == null) return err('用法：snmp-server host <IP> version 2c <community>');
      const t = (rest || '').split(/\s+/).filter(Boolean).filter((x) => !/^(traps|informs)$/i.test(x));
      let ver = 'v2c';
      const v = t.findIndex((x) => /^version$/i.test(x));
      if (v >= 0) { ver = t[v + 1] === '3' ? 'v3' : 'v2c'; t.splice(v, ver === 'v3' && /^(auth|noauth|priv)$/i.test(t[v + 2] || '') ? 3 : 2); }
      const name = t[0];
      if (!name) return err('最後要寫 community（v2c）或 SNMPv3 的使用者名稱');
      m.trapHosts = [...(m.trapHosts || []).filter((h) => h.ip !== ip), { ip, ver, name }];
      return m.traps ? undefined : '（還要 snmp-server enable traps，設備才會真的送出 Trap）';
    }],
    ['no snmp-server host <ip> [...]', ([ip]) => { const m = dev().mgmt; if (m && m.trapHosts) m.trapHosts = m.trapHosts.filter((h) => h.ip !== ip); }],
    ['snmp-server enable traps [...]', () => { if (dev().mgmt) dev().mgmt.traps = true; }],
    ['no snmp-server enable traps [...]', () => { if (dev().mgmt) delete dev().mgmt.traps; }],
    ['snmp-server location <...>', ([t]) => { if (dev().mgmt) dev().mgmt.location = t; }],
    ['snmp-server contact <...>', ([t]) => { if (dev().mgmt) dev().mgmt.contact = t; }],
    ['no snmp-server location [...]', () => { if (dev().mgmt) delete dev().mgmt.location; }],
    ['no snmp-server contact [...]', () => { if (dev().mgmt) delete dev().mgmt.contact; }],
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
    // ── SSH ──
    ['crypto key generate rsa [...]', ([rest]) => {
      const d = dev(), m = d.mgmt;
      if (!m) return err('這台設備不支援');
      const t = (rest || '').toLowerCase().split(/\s+/), k = t.indexOf('modulus');
      const gen = (bits, o) => {
        const e = genKey(getState(), d, bits);
        if (e) { o.push(e); return { out: o, changed: false }; }
        o.push(`The name for the keys will be: ${hostName(d)}.${m.domain}`, '', `% The key modulus size is ${bits} bits`, `% Generating ${bits} bit RSA keys, keys will be non-exportable...`,
          `[OK] (elapsed time was ${bits >= 4096 ? 9 : bits >= 2048 ? 2 : 1} seconds)`, ...(bits < 768 ? ['', '（768 位元以下的金鑰不能用在 SSH 2，建議至少 2048）'] : []));
        return { out: o, changed: true };
      };
      const start = (bits, o) => {
        if (!(bits >= 360 && bits <= 4096)) { o.push('% 金鑰長度要在 360 – 4096 之間（建議 2048）'); return { out: o, changed: false }; }
        if (m.sshKey && !/^(Router|Switch)$/i.test(hostName(d)) && m.domain) {
          o.push(`% You already have RSA keys defined named ${hostName(d)}.${m.domain}.`, '% They will be replaced.', '', 'Do you really want to replace them? [yes/no]: ');
          S.pending = { fn: (ans, o2) => { S.pending = null; if (!/^y/i.test(ans)) { o2.push('（已取消）'); return { out: o2, changed: false }; } return gen(bits, o2); } };
          return { out: o, changed: false };
        }
        return gen(bits, o);
      };
      if (k >= 0) return { delegate: (o) => start(+t[k + 1], o) };
      return { delegate: (o) => { o.push('The name for the keys will be: ' + hostName(d) + '.' + (m.domain || '(none)'), 'Choose the size of the key modulus in the range of 360 to 4096 for your', '  General Purpose Keys. Choosing a key modulus greater than 512 may take', '  a few minutes.', '', 'How many bits in the modulus [512]: ');
        S.pending = { fn: (ans, o2) => { S.pending = null; return start(+(ans.trim() || 512), o2); } };
        return { out: o, changed: false };
      } };
    }],
    ['crypto key zeroize rsa [...]', () => ({ delegate: (o) => {
      const d = dev(), m = d.mgmt;
      if (!m || !m.sshKey) { o.push('% No Signature RSA Keys found in configuration.'); return { out: o, changed: false }; }
      o.push('% All keys will be removed.', '% All router certs issued using these keys will also be removed.', 'Do you really want to remove these keys? [yes/no]: ');
      S.pending = { fn: (ans, o2) => {
        S.pending = null;
        if (!/^y/i.test(ans)) return { out: o2, changed: false };
        m.sshKey = null;
        logEvent(getState(), d, 5, 'SSH-5-DISABLED', `SSH ${m.sshVer === 2 ? '2.0' : '1.99'} has been disabled`);
        return { out: o2, changed: true };
      } };
      return { out: o, changed: false };
    } })],
    ['ip domain name <name>', ([n]) => { if (!dev().mgmt) return err('這台設備不支援'); dev().mgmt.domain = n; return undefined; }],
    ['ip domain-name <name>', ([n]) => { if (!dev().mgmt) return err('這台設備不支援'); dev().mgmt.domain = n; return undefined; }],
    ['no ip domain name [...]', () => { if (dev().mgmt) delete dev().mgmt.domain; }],
    ['no ip domain-name [...]', () => { if (dev().mgmt) delete dev().mgmt.domain; }],
    ['ip ssh version <v>', ([v]) => { if (!['1', '2'].includes(v)) return err('用法：ip ssh version 2'); if (v === '2') dev().mgmt.sshVer = 2; else delete dev().mgmt.sshVer; return undefined; }],
    ['no ip ssh version [...]', () => { delete dev().mgmt.sshVer; }],
    ['ip ssh time-out <n>', ([n]) => { if (!/^\d+$/.test(n) || +n < 1 || +n > 120) return err('用法：ip ssh time-out <1-120>'); if (+n === 120) delete dev().mgmt.sshTimeout; else dev().mgmt.sshTimeout = +n; return undefined; }],
    ['ip ssh authentication-retries <n>', ([n]) => { if (!/^\d+$/.test(n) || +n < 0 || +n > 5) return err('用法：ip ssh authentication-retries <0-5>'); if (+n === 3) delete dev().mgmt.sshRetries; else dev().mgmt.sshRetries = Math.max(1, +n); return undefined; }],
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
    // Dead Peer Detection：沒有設定的話，對端失聯之後要等 SA 到期才會發現
    ['crypto isakmp keepalive <sec> [...]', ([sec, rest]) => {
      const d = dev(), r = rest ? rest.split(/\s+/)[0] : '';
      if (!d.vpns) return err('這台設備不支援 IPsec VPN');
      if (!/^\d+$/.test(sec) || +sec < 10 || +sec > 3600) return err('用法：crypto isakmp keepalive <10-3600> [重試間隔 2-60]');
      if (r && /^\d+$/.test(r) && (+r < 2 || +r > 60)) return err('重試間隔必須是 2 – 60 秒');
      d.ikeKeepalive = { sec: +sec, retry: /^\d+$/.test(r) ? +r : 2 };
      return undefined;
    }],
    ['no crypto isakmp keepalive [...]', () => { delete dev().ikeKeepalive; }],
    ['crypto ipsec security-association lifetime seconds <n>', ([n]) => {
      const d = dev();
      if (!d.vpns) return err('這台設備不支援 IPsec VPN');
      if (!/^\d+$/.test(n) || +n < 120 || +n > 86400) return err('用法：crypto ipsec security-association lifetime seconds <120-86400>（預設 3600）');
      if (+n === 3600) delete d.ipsecLife; else d.ipsecLife = +n;
      return undefined;
    }],
    ['no crypto ipsec security-association lifetime [...]', () => { delete dev().ipsecLife; }],
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
        const d = dev(), stmt = { net: netOf(net, bits), bits };
        addUnique((d.ospfNets ||= []), stmt);
        const hit = d.ifaces.filter((i) => {
          const n = staticNet(i), a = n ? n.ip : i.rt && i.rt.ip;
          return a != null && netOf(a, bits) === stmt.net;
        });
        return hit.length ? `OSPF 已在 ${hit.map((i) => i.label).join('、')} 啟用` : '（目前還沒有介面的 IP 落在這個範圍內；之後設定了符合的 IP，那個介面就會自動加入 OSPF）';
      }],
      ['no network <ip> <wild> area <a>', ([ip, wild]) => {
        const net = parseIp(ip), bits = wildBits(wild);
        if (net == null || bits == null) return err('用法：no network <網段> <萬用遮罩> area 0');
        const d = dev(), n0 = netOf(net, bits);
        const had = (d.ospfNets || []).length;
        d.ospfNets = (d.ospfNets || []).filter((n) => !(n.net === n0 && n.bits === bits));
        let off = 0;
        for (const i of d.ifaces) { const n = staticNet(i); if (i.ospf && n && netOf(n.ip, bits) === n0) { i.ospf = false; off++; } }
        return d.ospfNets.length < had || off ? undefined : err('沒有這一條 network 敘述');
      }],
      ['default-information originate [...]', () => { dev().ospfDefault = true; }],
      ['no default-information originate', () => { dev().ospfDefault = false; }],
      ['router-id <id>', ([id]) => { if (parseIp(id) == null) return err('用法：router-id <A.B.C.D>'); dev().ospfRid = id; return undefined; }],
      ['no router-id [...]', () => { delete dev().ospfRid; }],
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
      ['lease <...>', ([rest]) => {
        const t = rest.toLowerCase().split(/\s+/);
        const secs = t[0] === 'infinite' ? 315360000 : (+t[0] || 0) * 86400 + (+t[1] || 0) * 3600 + (+t[2] || 0) * 60;
        if (!(secs > 0) || t.slice(0, 3).some((x) => x !== 'infinite' && !/^\d+$/.test(x))) return err('用法：lease <天> [小時] [分鐘]，或 lease infinite');
        const p = S.cur;
        if (p.rsv) return undefined;
        (p.iface ? p.iface.dhcp : p).lease = secs === 86400 ? '' : secs;
        return undefined;
      }],
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
      // login local：用 username 建的帳號；login：只問線路密碼；no login：不驗證（非常危險）
      ['login [...]', ([rest]) => {
        const m = dev().mgmt;
        if (!m || S.cur === 'console') return undefined;
        const r = (rest || '').trim().toLowerCase();
        if (!r) m.vtyLogin = 'line';
        else if ('local'.startsWith(r)) m.vtyLogin = 'local';
        return undefined;
      }],
      ['no login', () => { const m = dev().mgmt; if (m && S.cur !== 'console') m.vtyLogin = 'none'; return S.cur === 'console' ? undefined : '（no login：任何人連進來都不用驗證就能下指令，非常危險）'; }],
      ['password <...>', ([p]) => { const m = dev().mgmt; if (m && S.cur !== 'console') m.vtyPass = readSecret(p.split(/\s+/)); }],
      ['no password [...]', () => { const m = dev().mgmt; if (m && S.cur !== 'console') delete m.vtyPass; }],
      // 登入之後閒置多久自動登出。預設 10 分鐘；0 0 代表永遠不會
      ['exec-timeout <...>', ([rest]) => {
        const m = dev().mgmt, t = rest.split(/\s+/);
        if (!m || S.cur === 'console') return undefined;
        if (t.length > 2 || !t.every((x) => /^\d+$/.test(x)) || +t[0] > 35791 || +(t[1] || 0) > 2147483) return err('用法：exec-timeout <分鐘> [秒]（0 0 代表永遠不會自動登出）');
        const s = +t[0] * 60 + +(t[1] || 0);
        if (s === 600) delete m.execTimeout; else m.execTimeout = s;
        return undefined;
      }],
      ['no exec-timeout [...]', () => { const m = dev().mgmt; if (m && S.cur !== 'console') m.execTimeout = 0; }],
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
      ['lifetime <n>', ([n]) => {
        if (!/^\d+$/.test(n) || +n < 60 || +n > 86400) return err('用法：lifetime <60-86400>（秒，預設 86400）');
        if (+n === 86400) delete S.cur.life; else S.cur.life = +n;
        return undefined;
      }],
      ['no lifetime [...]', () => { delete S.cur.life; }],
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
      ['set security-association lifetime seconds <n>', ([n]) => {
        if (!/^\d+$/.test(n) || +n < 120 || +n > 86400) return err('用法：set security-association lifetime seconds <120-86400>');
        S.cur.life2 = +n;
        return undefined;
      }],
      ['no set security-association lifetime [...]', () => { delete S.cur.life2; }],
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

  const doReload = (out) => {
    restoreStartup(dev());
    markReboot(getState(), dev().id); // 記憶體裡的表（ARP、MAC、紀錄…）全部消失，時鐘也重新開始
    S.mode = 'exec'; S.cur = null; S.pending = null;
    out.push('', '*** 設備重新開機中 ***', '', `${hostName(dev())} 大約 ${bootTime(dev())} 秒後開機完成，設定會從 startup-config 載入。這段時間它和關機沒有兩樣。`);
    return { out, changed: true, reloaded: true };
  };

  function exec(line) {
    const text = line.trim();
    const tok = text.split(/\s+/).filter(Boolean);
    const out = [];
    const done = (changed) => ({ out, changed: !!changed });
    // ROMMON：找不到可以開機的映像檔，只剩開機程式的命令列
    const clk = (getState().dyn && getState().dyn.clk && getState().dyn.clk[dev().id]) || {};
    if (clk.rommon) return rommon(text, tok, out);
    // copy、delete 的一連串問題
    if (S.pending && typeof S.pending === 'object') return S.pending.fn(text, out);
    // reload 的兩個確認問題
    if (S.pending === 'save') {
      if (/^y/i.test(text)) { saveStartup(dev()); out.push('Building configuration...', '[OK]'); } else if (!/^n/i.test(text)) { out.push("% Please answer 'yes' or 'no'.", 'System configuration has been modified. Save? [yes/no]:'); return done(false); }
      S.pending = 'confirm';
      out.push('Proceed with reload? [confirm]');
      return done(/^y/i.test(text));
    }
    if (S.pending === 'confirm') {
      if (text === '' || /^y/i.test(text)) return doReload(out);
      S.pending = null;
      out.push('Reload cancelled.');
      return done(false);
    }
    if (!tok.length || tok[0].startsWith('!')) return done(false);
    const t0 = tok[0].toLowerCase();
    if (S.mode === 'exec') {
      if (match(tok, 'clear cdp table')) { clearNeighbors(getState(), dev(), 'cdp'); return done(false); }
      if (match(tok, 'clear lldp table')) { clearNeighbors(getState(), dev(), 'lldp'); return done(false); }
      if (match(tok, 'clear cdp counters') || match(tok, 'clear lldp counters')) { const c = ((getState().dyn.ndCnt ||= {})[dev().id] ||= {}); const k = tok[1].toLowerCase().startsWith('c') ? 'cdp' : 'lldp'; c[k + 'Out'] = 0; c[k + 'In'] = 0; return done(false); }
      if (match(tok, 'configure terminal') || match(tok, 'configure')) { S.mode = 'config'; out.push('Enter configuration commands, one per line.  End with CNTL/Z.'); return done(false); }
      if (match(tok, 'enable') || match(tok, 'disable') || match(tok, 'end') || match(tok, 'terminal <...>')) return done(false);
      if (match(tok, 'write') || match(tok, 'write memory') || match(tok, 'copy running-config startup-config')) {
        saveStartup(dev());
        out.push('Building configuration...', '[OK]');
        return done(true);
      }
      const fileCmd = fileExec(tok, text, out);
      if (fileCmd) return fileCmd;
      // clock set 14:30:00 5 January 2026（月份和日期的順序兩種都可以）
      const cs = match(tok, 'clock set <...>');
      if (cs) {
        const m = cs[0].match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(\w+)\s+(\w+)\s+(\d{4})$/);
        const mon = (s) => MONTHS.findIndex((x) => x.startsWith(s.toLowerCase().slice(0, 3)));
        const day = m && (/^\d+$/.test(m[4]) ? +m[4] : /^\d+$/.test(m[5]) ? +m[5] : NaN);
        const mo = m && (/^\d+$/.test(m[4]) ? mon(m[5]) : mon(m[4]));
        if (!m || !(day >= 1 && day <= 31) || mo < 0 || +m[1] > 23 || +m[2] > 59 || +m[3] > 59) { out.push('% 用法：clock set <時:分:秒> <日> <月份> <年>，例如 clock set 14:30:00 5 January 2026'); return done(false); }
        const tz = (dev().mgmt && dev().mgmt.tz) || { off: 0 };
        setClock(getState(), dev(), Date.UTC(+m[6], mo, day, +m[1], +m[2], +m[3]) - tz.off * 3600000);
        logEvent(getState(), dev(), 6, 'SYS-6-CLOCKUPDATE', `System clock has been updated from ${new Date(deviceTime(getState(), dev()).ms).toISOString().slice(11, 19)} UTC, configured from console by console.`);
        return done(true);
      }
      if (match(tok, 'reload')) {
        if (dev().startup == null) saveStartup(dev());
        const dirty = iosDirty(getState(), dev());
        S.pending = dirty ? 'save' : 'confirm';
        out.push(dirty ? 'System configuration has been modified. Save? [yes/no]:' : 'Proceed with reload? [confirm]');
        return done(false);
      }
      return { out, changed: false, pass: true };
    }
    if (text === 'Building configuration...' || /^current configuration/i.test(text)) return done(false);
    // 離開設定模式時，IOS 會記下一筆「有人改過設定」
    const leave = () => {
      const touched = S.touched;
      S.touched = false;
      if (touched) logEvent(getState(), dev(), 5, 'SYS-5-CONFIG_I', who ? `Configured from console by ${who.user} on ${who.line} (${who.ip})` : 'Configured from console by console');
      return done(touched);
    };
    if (match(tok, 'end') || t0 === '^z') { S.mode = 'exec'; S.cur = null; return leave(); }
    if (match(tok, 'exit')) {
      const top = S.mode === 'config';
      S.mode = top ? 'exec' : 'config'; S.cur = null;
      return top ? leave() : done(false);
    }
    if (t0 === 'do') {
      // 在設定模式下也可以 do copy …、do dir、do write
      const inner = tok.slice(1);
      if (inner.length && /^(copy|dir|del|verify|wr|show)$/i.test(inner[0].replace(/^(cop|cop?y|del(e(te?)?)?|veri(fy?)?|wri(te?)?|wr)$/i, (m) => ({ cop: 'copy', copy: 'copy', del: 'del', dele: 'del', delet: 'del', delete: 'del', veri: 'verify', verif: 'verify', verify: 'verify', wr: 'wr', wri: 'wr', writ: 'wr', write: 'wr' }[m.toLowerCase()] || m)))) {
        const r = fileExec(inner, inner.join(' '), out) || (/^wr/i.test(inner[0]) ? (saveStartup(dev()), out.push('Building configuration...', '[OK]'), done(true)) : null);
        if (r) return r;
      }
      return { out, changed: false, pass: true, doLine: tok.slice(1).join(' ') };
    }
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
    if (res.r && typeof res.r === 'object' && res.r.delegate) { const r = res.r.delegate(out); if (r.changed) S.touched = true; return r; }
    if (isErr(res.r)) { out.push(res.r); return done(false); }
    for (const x of [].concat(res.r ?? [])) out.push(x);
    S.touched = true;
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
      ? ['configure terminal', 'write memory', 'copy running-config startup-config', 'reload', 'ping <ip>', ...extra]
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

  // ───────────────────────── 檔案：copy、dir、delete、verify ─────────────────────────

  /** copy 的來源與目的：running-config、startup-config、flash:檔名、tftp:、tftp://IP/檔名、ftp://帳號:密碼@IP/檔名 */
  function loc(s) {
    const t = String(s || '').trim(), low = t.toLowerCase();
    if (low.length >= 3 && ('running-config'.startsWith(low) || low === 'system:running-config')) return { kind: 'run' };
    if (low.length >= 3 && ('startup-config'.startsWith(low) || low === 'nvram:startup-config')) return { kind: 'start' };
    const u = t.match(/^(tftp|ftp):(?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/]+)(?:\/(.*))?)?$/i);
    if (u) return { kind: u[1].toLowerCase(), user: u[2] || null, pass: u[3] ?? null, host: u[4] || null, file: u[5] || null };
    const f = t.match(/^(boot)?flash:\/?(.*)$/i);
    if (f) return { kind: 'flash', file: f[2] || null };
    return null;
  }
  const remoteKind = (x) => x.kind === 'tftp' || x.kind === 'ftp';
  const urlOf = (x, ip, file) => `${x.kind}://${ip}/${file}`;
  /** 問一個問題，答案交給 next；直接按 Enter 就用中括號裡的預設值 */
  const ask = (out, q, def, next) => {
    out.push(`${q} [${def || ''}]? `);
    S.pending = { fn: (text, o) => { S.pending = null; const r = next(text.trim() || def || '', o); return r || { out: o, changed: false }; } };
    return { out, changed: false };
  };
  const confirm = (out, q, next) => {
    out.push(`${q} [confirm]`);
    S.pending = { fn: (text, o) => { S.pending = null; if (text && !/^y/i.test(text)) { o.push('%Aborted'); return { out: o, changed: false }; } return next(o) || { out: o, changed: false }; } };
    return { out, changed: false };
  };
  const bang = (bytes) => '!'.repeat(Math.max(1, Math.min(60, Math.round(bytes / 400000))));
  const copied = (r) => `${r.bytes} bytes copied in ${r.secs.toFixed(3)} secs (${r.rate} bytes/sec)`;

  /** dir、delete、verify、copy、show flash / boot；不是這幾個就回傳 null */
  function fileExec(tok, text, out) {
    const d = dev(), c0 = (tok[0] || '').toLowerCase();
    const isFs = (s) => /^(boot)?flash:/i.test(s || '');
    if ((c0 === 'dir' && (!tok[1] || isFs(tok[1]))) || (c0.length >= 2 && 'show'.startsWith(c0) && /^(boot)?flash:?$/i.test(tok[1] || ''))) {
      ensureFlash(d);
      if (!d.flash) { out.push('% 這台設備沒有 flash 檔案系統'); return { out, changed: false }; }
      out.push(...dirLines(d));
      return { out, changed: false };
    }
    if (c0.length >= 2 && 'show'.startsWith(c0) && /^boot(var)?$/i.test(tok[1] || '')) {
      out.push(`BOOT variable = ${(d.bootSys || []).map((b) => b + ',1').join(';')}${(d.bootSys || []).length ? ';' : ''}`, 'CONFIG_FILE variable = ', 'Config register is 0x2102',
        ...(!(d.bootSys || []).length ? ['（沒有設定 boot system：開機時會用 flash 裡第一個能開機的映像檔）'] : []));
      return { out, changed: false };
    }
    if (c0.length >= 3 && 'delete'.startsWith(c0)) {
      ensureFlash(d);
      const force = tok.includes('/force');
      const arg = tok.slice(1).find((x) => !x.startsWith('/'));
      const name = flashPath(arg);
      if (!arg || !isFs(arg) || !name) { out.push('% 用法：delete flash:<檔名>'); return { out, changed: false }; }
      const go = (o) => {
        if (!d.flash.files[name]) { o.push(`%Error deleting ${fsName(d)}:/${name} (No such file or directory)`); return { out: o, changed: false }; }
        delete d.flash.files[name];
        if (d.fw && d.fw.image === name) o.push('（注意：刪掉的是現在正在執行的映像檔。設備照常運作，但下次開機就不能再用它了）');
        return { out: o, changed: true };
      };
      if (force) return go(out);
      return ask(out, 'Delete filename', name, (n, o) => confirm(o, `Delete ${fsName(d)}:/${flashPath(n)}?`, go));
    }
    if (c0.length >= 4 && 'verify'.startsWith(c0)) {
      ensureFlash(d);
      const arg = tok.find((x) => isFs(x)), name = flashPath(arg), want = tok[tok.indexOf(arg) + 1];
      if (!tok.includes('/md5') || !arg) { out.push('% 用法：verify /md5 flash:<檔名> [原廠公布的 MD5]'); return { out, changed: false }; }
      const f = d.flash.files[name];
      if (!f) { out.push(`%Error opening ${fsName(d)}:/${name} (No such file or directory)`); return { out, changed: false }; }
      out.push('.'.repeat(Math.min(70, Math.max(5, Math.round(f.size / 10000000)))) + 'Done!');
      if (!want) out.push(`verify /md5 (${fsName(d)}:${name}) = ${f.md5}`);
      else if (want.toLowerCase() === f.md5) out.push(`Verified (${fsName(d)}:${name}) = ${f.md5}`);
      else out.push(`%Error verifying ${fsName(d)}:${name}`, `Computed signature  = ${f.md5}`, `Submitted signature = ${want.toLowerCase()}`, '（MD5 不一樣：檔案傳輸不完整或被竄改，不要拿它開機）');
      return { out, changed: false, wait: Math.round(f.size / 40000000) };
    }
    if (c0.length >= 3 && 'copy'.startsWith(c0) && tok.length >= 3) {
      const src = loc(tok[1]), dst = loc(tok[2]);
      if (!src || !dst) return null;
      if (src.kind === 'run' && dst.kind === 'start') return null; // write memory，前面已經處理
      if ((remoteKind(src) && remoteKind(dst)) || (!remoteKind(src) && !remoteKind(dst))) {
        out.push('% 這個模擬支援的 copy：running-config / startup-config / flash:檔案 ↔ tftp: / ftp:');
        return { out, changed: false };
      }
      const job = { src, dst };
      return copyStep(job, out);
    }
    return null;
  }

  function dirLines(d) {
    const fs = fsName(d);
    const two = (n) => String(n).padStart(2, '0');
    const when = (t) => {
      if (t < 0) return 'Nov 12 2025 10:22:41 +00:00';
      const x = new Date(Date.UTC(2026, 0, 5, 1, 0, 0) + t * 1000);
      return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()]} ${String(x.getUTCDate()).padStart(2)} ${x.getUTCFullYear()} ${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())} +00:00`;
    };
    const o = [`Directory of ${fs}:/`, ''];
    Object.entries(d.flash.files).forEach(([n, f], k) => o.push(`${String(k + 2).padStart(6)}  ${f.kind === 'dir' ? 'drwx' : '-rwx'} ${String(f.size).padStart(12)}  ${when(f.t)}  ${n}`));
    o.push('', `${d.flash.size} bytes total (${flashFree(d)} bytes free)`);
    return o;
  }

  /** copy 的每一步：缺什麼就問什麼，問完就開始傳 */
  function copyStep(job, out) {
    const d = dev(), { src, dst } = job, rem = remoteKind(src) ? src : dst;
    if (!rem.host) return ask(out, 'Address or name of remote host', '', (v, o) => { rem.host = v; return copyStep(job, o); });
    if (remoteKind(src) && !src.file) return ask(out, 'Source filename', '', (v, o) => { src.file = v; return copyStep(job, o); });
    if (src.kind === 'flash' && !src.file) return ask(out, 'Source filename', '', (v, o) => { src.file = flashPath(v); return copyStep(job, o); });
    if (!job.asked) {
      job.asked = true;
      const def = remoteKind(dst) ? (src.kind === 'flash' ? src.file : `${hostName(d).toLowerCase()}-confg`) : dst.kind === 'flash' ? (dst.file || src.file) : dst.kind === 'run' ? 'running-config' : 'startup-config';
      return ask(out, 'Destination filename', dst.file || def, (v, o) => { if (dst.kind !== 'run' && dst.kind !== 'start') dst.file = dst.kind === 'flash' ? flashPath(v) : v; return copyStep(job, o); });
    }
    return copyRun(job, out);
  }

  function copyRun(job, out) {
    const st = getState(), d = dev(), { src, dst } = job, rem = remoteKind(src) ? src : dst;
    const ip = parseIp(rem.host);
    if (ip == null) { out.push(`%Error parsing ${rem.kind}://${rem.host}/ (Invalid IP address)`); return { out, changed: false }; }
    const creds = rem.kind === 'ftp' ? { user: rem.user || (d.ftpLogin || {}).user || '', pass: rem.pass ?? (d.ftpLogin || {}).pass ?? '' } : {};
    const url = urlOf(rem, rem.host, rem.file);
    const failed = (r, verb) => {
      out.push(`%Error ${verb} ${url} (${r.err})`);
      if (r.reason) out.push(`（${r.reason}）`);
      return { out, changed: false, wait: r.secs, xfer: r.res };
    };
    if (remoteKind(dst)) {
      // 上傳：running-config / startup-config / flash 的檔案 → 伺服器
      let put;
      if (src.kind === 'run') put = configFile(runningConfig(st, d), st.clock);
      else if (src.kind === 'start') {
        const s = startupConfig(st, d);
        if (!s) { out.push('%Error opening nvram:/startup-config (No such file or directory)'); return { out, changed: false }; }
        put = configFile(s, st.clock);
      } else {
        ensureFlash(d);
        put = d.flash && d.flash.files[src.file];
        if (!put) { out.push(`%Error opening ${fsName(d)}:/${src.file} (No such file or directory)`); return { out, changed: false }; }
      }
      const r = transfer(st, d.id, { proto: rem.kind, server: ip, file: rem.file, dir: 'put', bytes: put.size, put, blksize: d.tftpBlk, ...creds });
      if (!r.ok) return failed(r, 'opening');
      out.push(bang(r.bytes), copied(r));
      return { out, changed: true, wait: r.secs, xfer: r.res };
    }
    // 下載：伺服器 → running-config（合併）/ startup-config（整份換掉）/ flash
    if (dst.kind === 'flash') {
      ensureFlash(d);
      if (!d.flash) { out.push('% 這台設備沒有 flash 檔案系統'); return { out, changed: false }; }
      const exists = d.flash.files[dst.file];
      const go = (o) => {
        out = o;
        const r = transfer(st, d.id, { proto: rem.kind, server: ip, file: rem.file, dir: 'get', blksize: d.tftpBlk, ...creds });
        if (!r.ok) return failed(r, 'opening');
        const need = r.bytes - (exists ? exists.size : 0);
        if (need > flashFree(d)) {
          out.push(`Accessing ${url}...`, `%Error copying ${url} (Not enough space on device)`,
            `（${fsName(d)}: 只剩 ${fmtBytes(flashFree(d))}，這個檔案要 ${fmtBytes(r.bytes)}。先用 dir 看看有哪些檔案，把用不到的舊映像檔 delete 掉；不要刪現在正在跑的那一個）`);
          return { out, changed: false, wait: 2, xfer: r.res };
        }
        d.flash.files[dst.file] = { ...JSON.parse(JSON.stringify(r.file)), t: st.clock };
        out.push(`Accessing ${url}...`, `Loading ${rem.file} from ${rem.host} (via ${viaIf(r)}): ${bang(r.bytes)}`, `[OK - ${r.bytes} bytes]`, '', copied(r));
        return { out, changed: true, wait: r.secs, xfer: r.res };
      };
      if (exists) { out.push('%Warning:There is a file already existing with this name'); return confirm(out, 'Do you want to over write?', go); }
      return go(out);
    }
    const r = transfer(st, d.id, { proto: rem.kind, server: ip, file: rem.file, dir: 'get', blksize: d.tftpBlk, ...creds });
    if (!r.ok) return failed(r, 'opening');
    if (r.file.kind !== 'config') {
      out.push(`Accessing ${url}...`, `%Error: ${rem.file} 不是設定檔`);
      return { out, changed: false, wait: r.secs, xfer: r.res };
    }
    out.push(`Accessing ${url}...`, `Loading ${rem.file} from ${rem.host} (via ${viaIf(r)}): ${bang(r.bytes)}`, `[OK - ${r.bytes} bytes]`);
    if (dst.kind === 'start') {
      const bad = startupFromText(st, d, r.file.lines);
      out.push('', copied(r));
      if (bad.length) out.push(`（有 ${bad.length} 行沒有辦法套用，例如：${bad[0]}）`);
      out.push('（startup-config 已經換成這份檔案。要 reload 之後才會生效；在那之前不要 write memory，否則會被目前的設定蓋掉）');
      return { out, changed: true, wait: r.secs, xfer: r.res };
    }
    // 合併到 running-config：和把每一行貼進設定模式一樣。檔案裡沒有寫到的設定，不會被拿掉
    const sub = iosSession(getDev, getState, who);
    sub.exec('configure terminal');
    let n = 0;
    for (const l of r.file.lines) {
      const t = l.trim();
      if (!t || t === '!' || t === 'end' || /^Building configuration/.test(t) || /^Current configuration/i.test(t)) continue;
      const x = sub.exec(l);
      for (const e of x.out) if (e.startsWith('%')) { out.push(`${t}`, e); n++; }
    }
    out.push('', copied(r));
    logEvent(st, d, 5, 'SYS-5-CONFIG_I', `Configured from ${url} by ${who ? who.user + ' on ' + who.line : 'console'}`);
    if (n) out.push(`（有 ${n} 行套用失敗）`);
    return { out, changed: true, wait: r.secs, xfer: r.res };
  }
  const viaIf = (r) => {
    const i = dev().ifaces.find((x) => x.rt && x.rt.ip === r.res.srcIp);
    return i ? (i.bind.t === 'svi' ? 'Vlan' + i.bind.vlan : i.label) : 'unknown';
  };

  // ───────────────────────── ROMMON ─────────────────────────
  function rommon(text, tok, out) {
    const st = getState(), d = dev(), c = st.dyn.clk[d.id], c0 = (tok[0] || '').toLowerCase();
    const res = (changed, extra) => ({ out, changed: !!changed, ...extra });
    if (!c0) return res(false);
    if (c0 === 'dir') {
      ensureFlash(d);
      out.push(`File size           Checksum   File name`, ...Object.entries(d.flash.files).filter(([, f]) => f.kind !== 'dir').map(([n, f]) => `${String(f.size).padStart(10)} bytes (0x${f.size.toString(16)})  0x${f.md5.slice(0, 8)}    ${n}`));
      return res(false);
    }
    if (c0 === 'boot') {
      const name = flashPath(tok[1]);
      if (!name) { out.push('usage: boot <file>   例如 boot flash:' + (Object.keys(d.flash.files)[0] || 'image.bin')); return res(false); }
      const f = d.flash.files[name];
      const img = f && f.img && IMAGES[f.img];
      if (!f) { out.push(`boot: cannot open "${fsName(d)}:${name}"`, 'boot: cannot determine first file name on device "flash:"'); return res(false); }
      if (!img || img.platform !== PLATFORM[d.model]) { out.push(`boot: ${name} 不是這台設備（${PLATFORM_NAME[PLATFORM[d.model]]}）可以用的映像檔`); return res(false); }
      if (f.md5 !== img.md5 || f.size !== img.size) { out.push(`Image validation failed: ${name} 的檔案已經損毀`); return res(false); }
      d.fw = { image: name, ver: img.ver };
      delete c.rommon;
      c.up = st.clock + bootTime(d);
      out.push(`Loading ${fsName(d)}:${name}...`, '', `${hostName(d)} 開機中，大約 ${bootTime(d)} 秒後完成。（boot system 沒有改：下次 reload 還是會照原本的順序找映像檔）`);
      return res(true, { reloaded: true });
    }
    if (c0 === 'reset') { markReboot(st, d.id); out.push('（重新開機，照 boot system 的順序再找一次映像檔）'); return res(true, { reloaded: true }); }
    out.push(`monitor: command "${tok[0]}" not found`, '可用的指令：dir flash:（列出檔案）、boot flash:<檔名>（用指定的映像檔開機）、reset（重新開機）', `（為什麼在這裡：${c.rommon.why}）`);
    return res(false);
  }

  return {
    exec,
    complete,
    prompt: () => ((((getState().dyn || {}).clk || {})[dev().id] || {}).rommon ? 'rommon 1 >' : S.pending ? '' : hostName(dev()) + PROMPT[S.mode]),
    get pending() { return S.pending; },
    help: () => HELP[S.mode] || [],
    get mode() { return S.mode; },
  };
}

// ───────────────────────── show running-config ─────────────────────────

const wild = (bits) => fmtIp(~maskOf(bits) >>> 0);
const leaseText = (s) => (s >= 315360000 ? 'infinite' : `${Math.floor(s / 86400)} ${Math.floor((s % 86400) / 3600)} ${Math.floor((s % 3600) / 60)}`);
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
  if ((dev.bootSys || []).length) o.push(...dev.bootSys.map((b) => `boot system ${b}`), '!');
  if (dev.ftpLogin && (dev.ftpLogin.user || dev.ftpLogin.pass)) o.push(...(dev.ftpLogin.user ? [`ip ftp username ${dev.ftpLogin.user}`] : []), ...(dev.ftpLogin.pass ? [`ip ftp password 7 ${hex(dev.ftpLogin.pass)}`] : []), '!');
  if (+dev.tftpBlk > 512) o.push(`ip tftp blocksize ${+dev.tftpBlk}`, '!');
  const m = dev.mgmt;
  if (m) o.push(`username ${m.user || 'admin'} privilege 15 secret 9 ${secret9(m.pass || '')}`, '!');
  if (m && (m.domain || m.sshVer === 2 || m.sshTimeout || m.sshRetries)) {
    o.push(...(m.domain ? [`ip domain name ${m.domain}`] : []), ...(m.sshVer === 2 ? ['ip ssh version 2'] : []),
      ...(m.sshTimeout ? [`ip ssh time-out ${m.sshTimeout}`] : []), ...(m.sshRetries ? [`ip ssh authentication-retries ${m.sshRetries}`] : []), '!');
  }
  if (dev.v6routing) o.push('ipv6 unicast-routing', '!');
  {
    const c = cdpCfg(dev), l = lldpCfg(dev), raw = dev.lldp || {};
    const g = [];
    if (speaksCdp(dev) && !c.run) g.push('no cdp run');
    if (c.timer !== CDP_TIMER) g.push(`cdp timer ${c.timer}`);
    if (c.hold !== CDP_HOLD) g.push(`cdp holdtime ${c.hold}`);
    if (!c.v2) g.push('no cdp advertise-v2');
    if (raw.run === true) g.push('lldp run');
    else if (raw.run === false && l.run !== lldpCfg({ ...dev, lldp: {} }).run) g.push('no lldp run');
    if (l.timer !== LLDP_TIMER) g.push(`lldp timer ${l.timer}`);
    if (l.hold !== LLDP_HOLD) g.push(`lldp holdtime ${l.hold}`);
    if (g.length) o.push(...g, '!');
  }
  if (isSw(dev)) {
    const sw = dev.sw;
    for (const v of sw.vlans.slice().sort((a, b) => a.id - b.id)) if (v.id !== 1) o.push(`vlan ${v.id}`, ` name ${v.name.replace(/\s+/g, '_')}`);
    o.push('!', 'spanning-tree mode rapid-pvst');
    const stp = sw.stp || {};
    if (stp.on === false) o.push('no spanning-tree vlan 1-4094');
    else if (stp.prio != null && stp.prio !== '' && +stp.prio !== 32768) o.push(`spanning-tree vlan 1-4094 priority ${+stp.prio}`);
    if (stp.portfastDefault) o.push('spanning-tree portfast default');
    if (+sw.macAge > 0 && +sw.macAge !== 300) o.push(`mac address-table aging-time ${+sw.macAge}`);
    for (const [n, s] of Object.entries(sw.span || {})) {
      const lab = (pid) => (dev.ports.find((p) => p.id === pid) || {}).label || pid;
      for (const [pid, dir] of Object.entries(s.src || {})) o.push(`monitor session ${n} source interface ${lab(pid)}${dir === 'both' ? '' : ' ' + dir}`);
      if (s.dst) o.push(`monitor session ${n} destination interface ${lab(s.dst)}`);
    }
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
    if (+i.dhcp.lease > 0 && +i.dhcp.lease !== 86400) o.push(` lease ${leaseText(+i.dhcp.lease)}`);
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
    for (const p of isakmpOf(dev)) o.push(`crypto isakmp policy ${p.n}`, ` encryption ${ENC_IOS[p.enc] || 'aes'}`, ` hash ${HASH_IOS[p.hash] || 'sha'}`, ' authentication pre-share', ` group ${p.dh}`, ...(+p.life > 0 && +p.life !== 86400 ? [` lifetime ${+p.life}`] : []));
    for (const t of vp) if (t.psk && t.peer) o.push(`crypto isakmp key ${t.psk} address ${t.peer}`);
    if (dev.ikeKeepalive && +dev.ikeKeepalive.sec > 0) o.push(`crypto isakmp keepalive ${dev.ikeKeepalive.sec} ${dev.ikeKeepalive.retry || 2}`);
    if (+dev.ipsecLife > 0 && +dev.ipsecLife !== 3600) o.push(`crypto ipsec security-association lifetime seconds ${+dev.ipsecLife}`);
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
      if (+t.life2 > 0) o.push(` set security-association lifetime seconds ${+t.life2}`);
      o.push(` match address ${vpnAclOf(t)}`);
    }
    if (vp.length) o.push('!');
  }
  const natOut = (i) => i.nat || (i.natOut && !i.natRule);
  const natRule = (i) => i.nat || (i.natRule && !i.natOut);
  const anyNat = dev.ifaces.some(natOut);
  const stp0 = (dev.sw && dev.sw.stp) || {};
  const l3lines = (i) => {
    const l = [];
    if (i.mode === 'dhcp') l.push(' ip address dhcp');
    else if (i.mode === 'pppoe') l.push(' pppoe-client dial-pool-number 1', ` ! PPPoE 帳號 ${i.user || '(未設定)'}`);
    else if (i.ip && parseMask(i.mask) != null) l.push(` ip address ${i.ip} ${fmtMask(parseMask(i.mask))}`);
    else l.push(' no ip address');
    if (anyNat) l.push(natOut(i) ? ' ip nat outside' : i.ip || i.mode !== 'static' ? ' ip nat inside' : null);
    if (i.helper) l.push(` ip helper-address ${i.helper}`);
    if (ospfOn(dev, i) && i.ospfCost) l.push(` ip ospf cost ${i.ospfCost}`);
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
      const phy = [pc.speed && pc.speed !== 'auto' ? ` speed ${pc.speed}` : null, pc.duplex && pc.duplex !== 'auto' ? ` duplex ${pc.duplex}` : null].filter(Boolean);
      const nd = portNd(dev, p.id), ndl = [nd.cdp === false ? ' no cdp enable' : null, nd.tx === false ? ' no lldp transmit' : null, nd.rx === false ? ' no lldp receive' : null].filter(Boolean);
      const def = pc.mode === defaultPortMode(dev.model) && pc.vlan === 1 && pc.native === 1 && (!pc.allowed || pc.allowed === 'all') && !pc.voice && !pc.noneg && !ndl.length && !pc.shut && !peer && !pc.trust && !(+pc.lag > 0) && !(pc.ps && pc.ps.on) && !pc.bpduguard && !pc.rootguard && !pc.dot1x && !phy.length && pc.portfast == null;
      if (def) continue;
      o.push(`interface ${p.label}`, ...desc, ...phy);
      if (pc.mode === 'routed') {
        const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
        o.push(' no switchport', ...(i ? l3lines(i) : []), ...ndl);
      } else {
        // 真的 IOS 的順序：access vlan、trunk 的設定、mode、nonegotiate、voice vlan。出廠預設的模式不會印出來
        if (pc.vlan !== 1) o.push(` switchport access vlan ${pc.vlan}`);
        if (pc.native !== 1) o.push(` switchport trunk native vlan ${pc.native}`);
        if (pc.allowed && pc.allowed !== 'all') o.push(` switchport trunk allowed vlan ${pc.allowed}`);
        if (pc.mode !== defaultPortMode(dev.model) || (pc.mode === 'access' && !DTP_OK(dev))) o.push(` switchport mode ${pc.mode.replace('-', ' ')}`);
        if (pc.noneg) o.push(' switchport nonegotiate');
        if (pc.voice) o.push(` switchport voice vlan ${pc.voice}`);
        if (pc.mode === 'trunk') { if (pc.portfast === true) o.push(' spanning-tree portfast trunk'); }
        else if (pc.portfast === true) o.push(' spanning-tree portfast');
        else if (pc.portfast === false && stp0.portfastDefault) o.push(' spanning-tree portfast disable');
      }
      if (pc.mode !== 'routed') o.push(...ndl);
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
      const nd = portNd(dev, p.id);
      o.push(`interface ${p.label}`, ...desc, ...l3lines(i),
        ...(i.speed && i.speed !== 'auto' ? [` speed ${i.speed}`] : []), ...(i.duplex && i.duplex !== 'auto' ? [` duplex ${i.duplex}`] : []),
        ...(nd.cdp === false ? [' no cdp enable'] : []), ...(nd.tx === false ? [' no lldp transmit'] : []), ...(nd.rx === false ? [' no lldp receive'] : []),
        i.shut ? ' shutdown' : ' no shutdown', '!');
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
  // network 敘述照原樣列出；在圖形介面上個別啟用、而且沒有被任何敘述涵蓋的介面，各自列一條
  const stmts = dev.ospfNets || [];
  const os = dev.ifaces.filter((i) => i.ospf && i.rt && i.rt.ip != null && !stmts.some((n) => netOf(i.rt.ip, n.bits) === n.net))
    .sort((a, b) => netOf(a.rt.ip, a.rt.bits) - netOf(b.rt.ip, b.rt.bits));
  if (os.length || stmts.length) {
    o.push('router ospf 1');
    if (dev.ospfRid) o.push(` router-id ${dev.ospfRid}`);
    for (const n of stmts) o.push(` network ${fmtIp(n.net)} ${wild(n.bits)} area 0`);
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
  // 改過的 NAT 逾時才會出現在設定裡
  const nt = dev.natTimeout || {};
  for (const [name, keys] of Object.entries(NAT_TIMER)) {
    if (name === 'timeout') continue;
    if (+nt[keys[0]] > 0) o.push(`ip nat translation ${name} ${+nt[keys[0]]}`);
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
    if (m.tz && m.tz.name) o.push(`clock timezone ${m.tz.name} ${m.tz.off}`);
    if (+m.ntpMaster > 0) o.push(`ntp master ${+m.ntpMaster}`);
    if (m.ntp) o.push(`ntp server ${m.ntp}`);
    if (m.logTrap != null && m.logTrap !== '' && +m.logTrap !== 6) o.push(`logging trap ${SEVERITY[+m.logTrap]}`);
    if (m.syslog) o.push(`logging host ${m.syslog}`);
    if (m.block && +m.block.sec > 0) o.push(`login block-for ${m.block.sec} attempts ${m.block.tries} within ${m.block.within}`);
    if (m.loginLog && m.loginLog.fail) o.push('login on-failure log');
    if (m.loginLog && m.loginLog.ok) o.push('login on-success log');
    if (m.banner) { const q = ['#', '^', '$', '%', '~'].find((c) => !m.banner.includes(c)) || '#'; o.push(`banner motd ${q}${m.banner}${q}`); }
    const snmp = m.snmp || 'off';
    if (snmp === 'v2c') o.push(`snmp-server community ${m.community || 'public'} ${m.snmpRw ? 'RW' : 'RO'}${m.snmpAcl ? ' ' + m.snmpAcl : ''}`);
    else if (snmp === 'v3') o.push(`snmp-server group ${m.snmpGroup || 'NMS'} v3 priv`); // SNMPv3 的使用者不會出現在 running-config 裡，真的 IOS 也是如此
    if (snmp !== 'off') {
      if (m.location) o.push(`snmp-server location ${m.location}`);
      if (m.contact) o.push(`snmp-server contact ${m.contact}`);
      if (m.traps) o.push('snmp-server enable traps snmp authentication linkdown linkup coldstart');
      for (const h of m.trapHosts || []) o.push(`snmp-server host ${h.ip} version ${h.ver === 'v3' ? '3 priv' : '2c'} ${h.name}`);
    }
    o.push(m.http ? 'ip http server' : 'no ip http server', m.https ? 'ip http secure-server' : 'no ip http secure-server');
    const allow = String(m.allow || '').split(/[,\s]+/).filter(Boolean).map((s) => { const x = s.match(/^([\d.]+)(?:\/(\d+))?$/); const ip = x && parseIp(x[1]); return ip == null ? null : { net: ip, bits: x[2] == null ? 32 : +x[2] }; }).filter(Boolean);
    const an = m.aclName || 'MGMT';
    if (allow.length) { o.push(`ip access-list standard ${an}`); for (const c of allow) o.push(c.bits === 32 ? ` permit host ${fmtIp(c.net)}` : ` permit ${fmtIp(netOf(c.net, c.bits))} ${wild(c.bits)}`); }
    const tr = [m.ssh && 'ssh', m.telnet && 'telnet'].filter(Boolean).join(' ') || 'none';
    const et = m.execTimeout == null || m.execTimeout === '' ? null : +m.execTimeout;
    o.push('line vty 0 4', ` transport input ${tr}`, ...(allow.length ? [` access-class ${an} in`] : []),
      ...(et != null && et !== 600 ? [` exec-timeout ${Math.floor(et / 60)} ${et % 60}`] : []), ...(m.vtyPass ? [` password 7 ${hex(m.vtyPass)}`] : []),
      m.vtyLogin === 'local' ? ' login local' : m.vtyLogin === 'none' ? ' no login' : ' login');
  }
  o.push('!', 'end');
  return o;
}
