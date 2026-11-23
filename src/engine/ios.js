// IOS 風格的設定指令：把 configure terminal 之後輸入的指令套用到設備的設定物件上。
// 不依賴瀏覽器，可以直接用 Node 測試。支援的範圍就是 show running-config 會印出來的那些指令，
// 所以把一台設備的 running-config 整份貼到另一台同型號的設備上，會得到相同的設定。
import { parseIp, fmtIp, parseMask, fmtMask, maskOf, netOf, bcastOf, parseVlanList } from './ip.js';
import { parseCidr6, parseIp6, fmtIp6, net6, isLinkLocal } from './ip6.js';
import { ICMP6_TYPES } from './sim6.js';
import { newIface, cloneState, CATALOG, makeDevice, defaultPortMode } from './model.js';
import { cdpCfg, lldpCfg, portNd, setPortNd, speaksCdp, clearNeighbors, CDP_TIMER, CDP_HOLD, LLDP_TIMER, LLDP_HOLD } from './disc.js';
import { parseDscp, dscpName, COS_DSCP_DEFAULT } from './qos.js';
import { clearOspfProcess, clearOspfAll, ospfArea, ospfProc, ospfKeys, ospfProcs } from './ospf.js';
import { parseComm } from './bgp.js';
import { transfer, configFile, ensureFlash, flashFree, flashPath, fsName, IMAGES, PLATFORM, PLATFORM_NAME, imageFile, fmtBytes } from './files.js';
import { macsBehind, recompute, ospfOn, ikeVer, isTun, tunMode, transact } from './sim.js';
import { parseMethods, METHOD_TEXT, aaaAuthorize, aaaAccount } from './aaa.js';
import { tpOf, urlTarget, caCert, validityError, issue, certHex, hexCert } from './pki.js';
import { logEvent, markReboot, setClock, deviceTime, SEVERITY, bootTime, longIf, localUsers, iosClock } from './ops.js';
import { isNexus, isCat2960, isCat9300, ICMP_TYPES } from './mtu.js';
import { spanDest } from './wire.js';
import { genKey } from './remote.js';
import { fhrpProto, fhrpGroup, fhrpPreempt } from './track.js';
import { archiveNow, archiveLines, cfgLog, cfgDiff, ARCH_MAX_DEFAULT } from './archive.js';
import { vtpCapable, vtpOf, vtpSet } from './vtp.js';
import { ZBF_PROTO, newZbf, zbfConfigLines } from './zbf.js';
import { breakoutPort, unbreakoutPort, breakoutLines, BREAKOUT_MAPS } from './breakout.js';
// EIGRP 的設定小工具（不從 eigrp.js 匯入：那邊會拉進整個模擬引擎，造成循環匯入）
const eigrpOn = (d) => !!(d && d.eigrp && +d.eigrp.as > 0);
import { parsePeriodic } from './timespec.js';
import { vlanNums, vlanText } from './stpcfg.js';
const classBitsOf = (ip) => (ip == null ? null : (ip >>> 24) < 128 ? 8 : (ip >>> 24) < 192 ? 16 : 24);
/** ip rip send / receive version 後面的「1」「2」「1 2」 */
const ripVers = (v) => { const l = [...new Set(String(v || '').split(/\s+/).filter(Boolean))]; return l.length && l.every((x) => x === '1' || x === '2') ? l.map(Number).sort() : null; };

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
  const r = snapFromText(state, dev, lines);
  dev.startup = r.snap;
  return r.bad;
}
/** 從出廠狀態開始把每一行設定套上去，回傳 { snap：設定快照, bad：套不上去的行 } */
export function snapFromText(state, dev, lines) {
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
  return { snap: snapshot(fresh), bad };
}
/** 把設備的設定整份換成一份快照（configure replace） */
export function applySnap(dev, snap) {
  for (const k of Object.keys(dev)) if (!KEEP.has(k)) delete dev[k];
  Object.assign(dev, JSON.parse(snap));
}
/** 封存目前的 running-config */
export function archiveRunning(state, dev) { return archiveNow(state, dev, runningConfig(state, dev), snapshot(dev)); }

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

/** 跑 IOS XE 的型號（有 RESTCONF / NETCONF） */
export const IOS_XE = new Set(['isr4321', 'isr4331', 'c9300', 'c9800']);
export const hostName = (dev) => dev.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'Device';
export const aclName = (i, dir) => (i.aclNames && i.aclNames[dir]) || `${i.label.replace(/[^\w.]+/g, '_')}_${dir}`.toUpperCase();
export const poolName = (i) => (i.dhcp && i.dhcp.pool) || i.label.replace(/[^\w.]+/g, '_').toUpperCase();

const isSw = (d) => !!d.sw && d.sw.mode === 'vlan';
/** errdisable recovery cause 認得的原因（Catalyst 的清單；模擬裡真的會觸發的是 bpduguard 與 psecure-violation） */
export const ERR_RECOVERY_CAUSES = ['arp-inspection', 'bpduguard', 'channel-misconfig', 'dhcp-rate-limit', 'dtp-flap', 'gbic-invalid', 'inline-power', 'link-flap', 'loopback', 'mac-limit', 'pagp-flap', 'port-mode-failure', 'psecure-violation', 'security-violation', 'sfp-config-mismatch', 'storm-control', 'udld', 'vmps'];
const TYPES = { gi: 'gigabitethernet', te: 'tengigabitethernet', fa: 'fastethernet', eth: 'ethernet' };
const PROMPT = {
  eigrp: '(config-router)#', rip: '(config-router)#', trange: '(config-time-range)#', mstcfg: '(config-mst)#', keychain: '(config-keychain)#', kckey: '(config-keychain-key)#',
  zone: '(config-sec-zone)#', zpair: '(config-sec-zone-pair)#', icmap: '(config-cmap)#', ipmap: '(config-pmap)#', ipmapc: '(config-pmap-c)#',
  exec: '#', config: '(config)#', if: '(config-if)#', vlan: '(config-vlan)#', raguard: '(config-ra-guard)#', router: '(config-router)#', dhcp: '(dhcp-config)#',
  line: '(config-line)#', tacacs: '(config-server-tacacs)#', acl: '(config-ext-nacl)#', stdacl: '(config-std-nacl)#', radius: '(config-radius-server)#',
  isakmp: '(config-isakmp)#', tset: '(cfg-crypto-trans)#', cmap: '(config-crypto-map)#', ipsecprof: '(ipsec-profile)#', flowrec: '(config-flow-record)#', flowexp: '(config-flow-exporter)#', flowmon: '(config-flow-monitor)#', pkitp: '(ca-trustpoint)#', pkichain: '(config-cert-chain)#', pkicert: '(config-pubkey)#',
  ikev2prop: '(config-ikev2-proposal)#', ikev2pol: '(config-ikev2-policy)#', ikev2kr: '(config-ikev2-keyring)#', ikev2peer: '(config-ikev2-keyring-peer)#', ikev2prof: '(config-ikev2-profile)#', track: '(config-track)#', vrfdef: '(config-vrf)#', vrfaf: '(config-vrf-af)#', ipvrf: '(config-vrf)#', archive: '(config-archive)#', archlog: '(config-archive-log-cfg)#', ipsla: '(config-ip-sla)#', slaecho: '(config-ip-sla-echo)#', bgp: '(config-router)#', rmap: '(config-route-map)#', qcmap: '(config-cmap)#', pmap: '(config-pmap)#', pmapc: '(config-pmap-c)#',
};
const SERVICE_PORT = { www: 80, http: 80, https: 443, domain: 53, dns: 53, ssh: 22, telnet: 23, ftp: 21, smtp: 25, ntp: 123, snmp: 161, snmptrap: 162, tftp: 69, bgp: 179, syslog: 514, isakmp: 500, bootps: 67, bootpc: 68, 'non500-isakmp': 4500 };

/** IOS 印 IPv6 位址一律用大寫 */
export const up6 = (a) => (a === 'any' ? 'any' : String(a).startsWith('host ') ? 'host ' + String(a).slice(5).toUpperCase() : String(a).toUpperCase());
/** IPv6 ACL 的一條規則（IOS 的寫法） */
export const acl6Text = (r) => `${r.action} ${r.proto || 'ipv6'} ${up6(r.src)}${r.sport ? ' eq ' + r.sport : ''} ${up6(r.dst)}${r.port ? ' eq ' + r.port : ''}${r.icmp ? ' ' + r.icmp : ''}`;
/**
 * [sequence <n>] permit|deny <ipv6|tcp|udp|icmp> <來源> [eq <埠>] <目的> [eq <埠>] [ICMP 類型] [log] [sequence <n>]
 * 位址：any、host <位址>、<前綴>/<長度>。回傳規則物件或 null
 */
export function parseAcl6(t) {
  let n = 0, seq = null;
  const low = (k) => (t[k] || '').toLowerCase();
  if (low(0) === 'sequence' && /^\d+$/.test(t[1] || '')) { seq = +t[1]; n = 2; }
  const action = ['permit', 'deny'].find((x) => low(n) && x.startsWith(low(n)));
  if (!action) return null;
  n++;
  let proto = low(n++);
  if (proto === 'ip') proto = 'ipv6';
  if (!['ipv6', 'tcp', 'udp', 'icmp'].includes(proto)) return null;
  const addr = () => {
    const w = low(n);
    if (w === 'any') { n++; return 'any'; }
    if (w === 'host' && parseIp6(t[n + 1] || '') != null) { n += 2; return 'host ' + fmtIp6(parseIp6(t[n - 1])); }
    const c = w.includes('/') ? parseCidr6(w) : null;
    if (c) { n++; return `${fmtIp6(net6(c.ip, c.bits))}/${c.bits}`; }
    return null;
  };
  const port = () => {
    if (low(n) !== 'eq' || (proto !== 'tcp' && proto !== 'udp')) return '';
    const v = SERVICE_PORT[low(n + 1)] || low(n + 1);
    n += 2;
    return /^\d+$/.test(String(v)) && +v <= 65535 ? String(v) : null;
  };
  const src = addr();
  if (!src) return null;
  const sport = port();
  if (sport == null) return null;
  const dst = addr();
  if (!dst) return null;
  const dport = port();
  if (dport == null) return null;
  let icmp = '';
  if (proto === 'icmp' && ICMP6_TYPES.includes(low(n))) icmp = low(n++);
  if (low(n) === 'log') n++;
  if (low(n) === 'sequence' && /^\d+$/.test(t[n + 1] || '')) { seq = +t[n + 1]; n += 2; }
  if (n < t.length) return null;
  return { seq, action, proto, src, dst, ...(sport ? { sport } : {}), ...(dport ? { port: dport } : {}), ...(icmp ? { icmp } : {}) };
}

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
    if (ikeVer(d, t) === 2) continue; // IKEv2 的提案在 crypto ikev2 proposal
    const p = { enc: t.enc || 'aes128', hash: t.hash || 'sha1', dh: String(t.dh || '2') };
    if (!out.some((x) => x.enc === p.enc && x.hash === p.hash && x.dh === p.dh)) out.push({ n: (out.length + 1) * 10, ...p });
  }
  return out;
}
// ── IKEv2 ──
const ENC_V2 = { 'aes-cbc-128': 'aes128', 'aes-cbc-256': 'aes256' }, ENC_V2_IOS = { aes128: 'aes-cbc-128', aes256: 'aes-cbc-256' };
const HASH_V2 = { sha1: 'sha1', sha256: 'sha256' };
const v2tag = (t) => String(t.name || 'VPN').replace(/[^\w.-]+/g, '_').toUpperCase();
/**
 * running-config 要印的 IKEv2 物件：CLI 建的照原樣，圖形介面設成 IKEv2 的通道（沒有 profile）換算成同樣格式的物件，
 * 名稱固定，所以把設定貼回去之後會得到一模一樣的 running-config
 */
function ikev2Objects(d) {
  const x = d.ikev2 || {};
  const v = { props: { ...(x.props || {}) }, pols: { ...(x.pols || {}) }, krs: {}, profs: { ...(x.profs || {}) } };
  for (const [k, kr] of Object.entries(x.krs || {})) v.krs[k] = { peers: { ...kr.peers } };
  const prof = {};
  for (const t of d.vpns || []) {
    if (+t.ike !== 2 || t.ikev2) continue;
    const enc = t.enc || 'aes128', hash = t.hash || 'sha1', dh = String(t.dh || '2');
    const pn = `PROP-${enc.toUpperCase()}-${hash.toUpperCase()}-G${dh}`;
    v.props[pn] ||= { encs: [enc], hashes: [hash], dhs: [dh] };
    const pol = (v.pols['IKEV2-POLICY'] ||= { props: [] });
    if (!pol.props.includes(pn)) v.pols['IKEV2-POLICY'] = { props: [...pol.props, pn] };
    const kr = (v.krs['IKEV2-KEYS'] ||= { peers: {} });
    kr.peers['PEER-' + v2tag(t)] = t.pskRemote ? { address: t.peer, pskLocal: t.psk, pskRemote: t.pskRemote } : { address: t.peer, psk: t.psk };
    v.profs['PROF-' + v2tag(t)] = { remote: t.peer, keyring: 'IKEV2-KEYS' };
    prof[t.name] = 'PROF-' + v2tag(t);
  }
  return { v, prof };
}

/** WLC 的位址清單 → option 43 的十六進位（每四個字一個點，和 IOS 的寫法一樣） */
const opt43 = (list) => {
  const ips = String(list).split(/[,\s]+/).map(parseIp).filter((x) => x != null);
  const hex = 'f1' + (ips.length * 4).toString(16).padStart(2, '0') + ips.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  return hex.match(/.{1,4}/g).join('.');
};
/** ACL 改了之後，把它套回引用這份 ACL 的通道 */
function syncVpnAcl(d, name) {
  const rules = ((d.aclDefs || {})[name] || []).filter((r) => r.action === 'permit');
  const uniq = (k) => [...new Set(rules.map((r) => (r[k] === 'any' ? '0.0.0.0/0' : r[k])))].join(', ');
  for (const t of d.vpns || []) if (t.acl === name) { t.local = uniq('src'); t.remote = uniq('dst'); }
}

// 訊息本身已經是 IOS 的「% …」格式時不再多加一個 %
const err = (s) => (String(s).startsWith('%') ? String(s) : '% ' + s);
const VTP_CLIENT = '% VTP VLAN configuration not allowed when device is in CLIENT mode.';
const DTP_OK = (d) => defaultPortMode(d.model) !== 'access';
function tidy(d, k) {
  const o = d[k];
  if (!o) return;
  for (const x of Object.keys(o)) if (o[x] === undefined) delete o[x];
  if (!Object.keys(o).length) delete d[k];
}
const isErr = (r) => typeof r === 'string' && r.startsWith('%');
const macList = (x) => String(x || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
/** 0011.2233.4455、00:11:22:33:44:55、00-11-22-33-44-55 → 00:11:22:33:44:55；格式不對回傳 null */
const normMac = (mac) => { const hex = String(mac).toLowerCase().replace(/[.:-]/g, ''); return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g).join(':') : null; };
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
    // 縮寫可以，但完整的關鍵字優先：ip 就是 ip，不是 ipv6 的縮寫（和真的 IOS 一樣）
    else if (!p.startsWith(t.toLowerCase()) || (t.toLowerCase() === 'ip' && p === 'ipv6')) return null;
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
  const lo = s.match(/^lo[a-z]*(\d+)$/);
  if (lo) {
    if (!dev.routing) return err('這台設備沒有 Loopback 介面（L2 交換器沒有路由功能）');
    const n = +lo[1], id = 'Lo' + n;
    let i = dev.ifaces.find((x) => x.bind.t === 'loop' && x.bind.n === n);
    if (!i) { i = newIface(id, 'Loopback' + n, { t: 'loop', n }); dev.ifaces.push(i); }
    return { name: 'Loopback' + n, iface: i, loop: true };
  }
  const tu = s.match(/^tu[a-z]*(\d+)$/);
  if (tu) {
    if (dev.kind !== 'router') return err('這個模擬只有路由器可以建立 Tunnel 介面');
    const n = +tu[1];
    if (n > 2147483647) return err('Tunnel 介面的編號是 0 – 2147483647');
    let i = dev.ifaces.find((x) => x.bind.t === 'gre' && x.bind.n === n);
    if (!i) { i = newIface('Tu' + n, 'Tunnel' + n, { t: 'gre', n }); i.tun = {}; dev.ifaces.push(i); }
    i.tun ||= {};
    return { name: 'Tunnel' + n, iface: i, tunnel: true };
  }
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
    Object.assign(i.dhcp, { on: true, pool: p.name, gw: p.gw || '', dns: p.dns || '', lease: p.lease || '', ...(p.tftp ? { tftp: p.tftp } : {}), ...(p.wlc ? { wlc: p.wlc } : {}) });
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

/**
 * ACL 每一條規則的序號：CLI 寫過序號的記在 r.seq，其他的接在前一條後面 +10（和 IOS 一樣，刪掉一條不會讓後面的重新編號；
 * running-config 不印序號，所以存檔重開機之後才會變回 10、20、30…）
 */
export function aclSeqs(list) {
  let last = 0;
  return (list || []).map((r) => (last = r.seq != null && +r.seq > last ? +r.seq : last + 10));
}
const stripSeq = ({ seq, ...r }) => r;

function parseAclRule(tok0) {
  const tok1 = [...tok0], extra = {};
  // reflect <名稱> [timeout <秒>]：Reflexive ACL，只能寫在 permit 上
  const ri = tok1.findIndex((x) => String(x).toLowerCase() === 'reflect');
  if (ri > 0) {
    if (!tok1[ri + 1]) return null;
    let cut = 2;
    if (String(tok1[ri + 2] || '').toLowerCase() === 'timeout') {
      const t = +tok1[ri + 3];
      if (!(t >= 1 && t <= 2147483)) return null;
      extra.rtimeout = t; cut = 4;
    }
    extra.reflect = tok1[ri + 1];
    tok1.splice(ri, cut);
  }
  // established：只比對 TCP 的 ACK / RST（連線的回應），不比對主動連線的 SYN
  const ei = tok1.findIndex((x) => String(x).toLowerCase() === 'established');
  if (ei > 0) { extra.established = true; tok1.splice(ei, 1); }
  // 最後面的 time-range <名稱>：在那個時段才生效
  const ti = tok1.findIndex((x) => String(x).toLowerCase() === 'time-range');
  const tr = ti > 0 ? tok1[ti + 1] : null;
  if (ti > 0 && !tr) return null;
  const tok = ti > 0 ? [...tok1.slice(0, ti), ...tok1.slice(ti + 2)] : tok1;
  const r = parseAclRule0(tok);
  if (!r || (extra.reflect && r.action !== 'permit') || (extra.established && r.proto !== 'tcp')) return null;
  return { ...r, ...extra, ...(tr ? { tr } : {}) };
}
function parseAclRule0(tok) {
  let n = 0;
  if (/^\d+$/.test(tok[0])) n++;
  const action = ['permit', 'deny'].find((a) => a.startsWith((tok[n] || ' ').toLowerCase()));
  const proto = (tok[n + 1] || '').toLowerCase();
  if (!action || !['ip', 'tcp', 'udp', 'icmp', 'esp', 'gre', 'ahp'].includes(proto)) return null; // esp = IP 協定 50、gre = 47、ahp = 51
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
  const src = addr();
  if (!src) return null;
  // 來源埠：permit tcp any eq 179 any（回應的封包、或對方主動連過來時的來源埠）
  let sport = '';
  if ((tok[n] || '').toLowerCase() === 'eq' && (proto === 'tcp' || proto === 'udp')) {
    const p = (tok[n + 1] || '').toLowerCase();
    sport = String(SERVICE_PORT[p] || (p === 'bgp' ? 179 : p));
    if (!/^\d+$/.test(sport)) return null;
    n += 2;
  }
  const dst = addr();
  if (!dst) return null;
  let port = '';
  if ((tok[n] || '').toLowerCase() === 'eq') {
    const p = (tok[n + 1] || '').toLowerCase();
    port = String(SERVICE_PORT[p] || p);
    if (!/^\d+$/.test(port)) return null;
  }
  // permit icmp any any packet-too-big：只比對某一種 ICMP
  let icmp = '';
  if (proto === 'icmp' && tok[n] && !/^(log|log-input)$/i.test(tok[n])) {
    icmp = ICMP_TYPES.find((x) => x === tok[n].toLowerCase()) || (/^ttl-exceeded$/i.test(tok[n]) ? 'time-exceeded' : '');
    if (!icmp) return null;
  }
  return { action, proto, src, dst, port: proto === 'tcp' || proto === 'udp' ? port : '', ...(sport ? { sport } : {}), ...(icmp ? { icmp } : {}) };
}

const HELP = {
  exec: ['configure terminal    進入設定模式', 'show ...              查看狀態（輸入 show ? 列出全部）', 'ping <IP>             測試連線',
    'write memory          把 running-config 存成 startup-config（沒存檔的設定重新開機後會消失）', 'reload                重新開機，回到 startup-config'],
  config: ['hostname <名稱>', 'interface <介面> | interface range <介面> - <n> | interface vlan <ID>', 'vlan <ID>', 'ip route <網段> <遮罩> <下一站> [距離] [track <物件>]', 'system mtu jumbo <1500-9000>（2960，重新開機後生效）| system mtu <1500-9198>（9300）', 'vrf definition <名稱> → rd / address-family ipv4；介面上 vrf forwarding <名稱>；ip route vrf <名稱> …', 'track <編號> interface <介面> line-protocol | track <編號> ip sla <操作> reachability', 'ip sla <編號> → icmp-echo <IP> source-interface <介面> → frequency <秒>；ip sla schedule <編號> life forever start-time now',
    'router ospf 1', 'router bgp <AS>', 'route-map / ip prefix-list / ip as-path access-list', 'ip dhcp pool <名稱> / ip dhcp excluded-address <起> <迄>', 'ip nat inside source list 1 interface <介面> overload',
    'ip nat inside source static <內部 IP> <公用 IP>', 'ip access-list extended <名稱>', 'spanning-tree vlan <清單> priority <值>',
    'ip dhcp snooping / ip arp inspection vlan <清單>', 'line vty 0 4', 'ntp server / logging host / snmp-server community', 'archive → path flash:<名稱> / maximum <n> / write-memory / log config → logging enable / notify syslog / hidekeys', 'cdp run / no cdp run / lldp run / cdp timer / lldp timer', 'class-map / policy-map（QoS）', 'mls qos（Catalyst 2960）', 'do <show 指令>、end、exit'],
  if: ['ip address <IP> <遮罩> | ip address dhcp', 'shutdown / no shutdown', 'switchport mode access|trunk|dynamic auto|dynamic desirable', 'switchport nonegotiate', 'switchport voice vlan <ID>', 'no cdp enable / no lldp transmit / no lldp receive', 'service-policy input | output <政策>', 'mls qos trust dscp | cos | device cisco-phone', 'auto qos voip cisco-phone', 'power inline auto | never', 'switchport access vlan <ID>',
    'switchport trunk native vlan <ID> / allowed vlan <清單>', 'no switchport（L3 交換器改成 Routed 埠）', 'ip nat inside|outside', 'ip helper-address <IP>',
    'ip ospf cost <值>', 'ip access-group <名稱> in|out', 'encapsulation dot1q <VLAN>（子介面）', 'vrrp 1 ip <虛擬 IP> / vrrp 1 priority <值> / vrrp 1 track <物件> decrement <值>', 'standby 1 ip <虛擬 IP> / standby 1 priority <值> / standby 1 preempt / standby 1 track <物件> decrement <值>',
    'channel-group <編號> mode active|passive|on', 'switchport port-security [mac-address <MAC> | violation <模式>]',
    'spanning-tree bpduguard enable / bpdufilter enable / guard root | loop | none', 'ip dhcp snooping trust', 'ipv6 address <位址/前綴>', 'speed 10|100|1000|auto、duplex auto|full|half'],
  vlan: ['name <名稱>'],
  router: ['network <網段> <萬用遮罩> area 0', 'default-information originate', 'redistribute static | connected | bgp <AS> [subnets] [metric <n>] [metric-type 1|2] [route-map <名稱>]'],
  dhcp: ['network <網段> <遮罩>', 'default-router <IP>', 'dns-server <IP> [IP]', 'option 150 ip <TFTP 伺服器>（IP 電話下載設定檔）', 'option 43 hex f104.<WLC 的 IP（十六進位）>（Cisco AP 找無線控制器）', 'lease <天> [小時] [分鐘]', 'host <IP> <遮罩> 加上 hardware-address <MAC>（保留位址）'],
  line: ['transport input ssh | telnet | all | none', 'access-class <名稱> in', 'login local'],
  acl: ['permit|deny <ip|tcp|udp|icmp|esp|gre> <來源> <目的> [eq <埠>]', 'ICMP 可以指定類型：echo、echo-reply、unreachable、packet-too-big、time-exceeded', '來源 / 目的的寫法：any、host <IP>、<網段> <萬用遮罩>', 'no <序號>   刪除一條規則'],
  stdacl: ['permit <網段> <萬用遮罩> | permit host <IP>'],
  radius: ['address ipv4 <IP>', 'key <共用密鑰>'],
  isakmp: ['encryption aes | aes 256', 'hash sha | sha256', 'group 2 | 5 | 14 | 19', 'authentication pre-share'],
  tset: ['mode tunnel'],
  ikev2prop: ['encryption aes-cbc-128 | aes-cbc-256', 'integrity sha1 | sha256', 'group 2 | 5 | 14 | 19'],
  ikev2pol: ['proposal <名稱>'],
  ikev2kr: ['peer <名稱>'],
  ikev2peer: ['address <對端 IP>', 'pre-shared-key <金鑰>', 'pre-shared-key local <金鑰> / pre-shared-key remote <金鑰>'],
  ikev2prof: ['match identity remote address <對端 IP> 255.255.255.255 | fqdn domain <網域>', 'identity local address <IP> | fqdn <名稱>', 'match identity remote any', 'authentication remote pre-share | rsa-sig', 'authentication local pre-share | rsa-sig', 'keyring local <名稱>', 'pki trustpoint <名稱>'],
  pkitp: ['enrollment url http://<CA 的 IP>[:埠][/路徑]', 'subject-name CN=<名稱>', 'revocation-check none | crl | crl none', 'rsakeypair <名稱>', 'fqdn <名稱>', 'serial-number none', 'ip-address none'],
  qcmap: ['match dscp ef | af41 | cs3 | <0-63>', 'match access-group name <ACL>', 'match protocol rtp | sip', 'match cos <0-7>', 'match any'],
  pmap: ['class <class-map 名稱> | class class-default'],
  pmapc: ['priority percent <n> | priority <kbps>（LLQ：語音用）', 'bandwidth percent <n> | bandwidth remaining percent <n>', 'set dscp <值>', 'police cir <bps>', 'shape average <bps>', 'service-policy <子政策>（parent 做 shape、child 排隊）', 'fair-queue', 'queue-limit <n> packets'],
  cmap: ['set peer <對端 IP>', 'set transform-set <名稱>', 'set pfs group14', 'set ikev2-profile <名稱>（改用 IKEv2）', 'match address <ACL 名稱>', 'description <通道名稱>'],
};

/**
 * 建立一個 CLI 工作階段。getDev() 回傳目前的設備物件，getState() 回傳目前的狀態。
 * exec(line) 回傳 { out: [文字…], changed: 是否改了設定, pass: 這一行不是設定指令（交給 show / ping 處理） }
 */
/** who：從遠端登入時是誰、從哪裡（{ user, line, ip }），用在紀錄裡 */
export function iosSession(getDev, getState, who = null) {
  const S = { mode: 'exec', cur: null, priv: who && who.priv != null ? +who.priv : 15, tries: 0 };
  const dev = () => getDev();

  // ── 介面模式 ──
  const each = (fn) => { for (const t of S.cur) { const r = fn(t); if (isErr(r)) return r; } return undefined; };
  const l3 = (t) => (t.iface && (!t.pc || t.pc.mode === 'routed') ? null : err(`${t.name} 是第二層的連接埠，不能設定 IP 相關的指令${dev().kind === 'l3switch' ? '（先下 no switchport）' : ''}`));
  const l2 = (t) => (t.pc ? null : err(`${t.name} 不是交換器的連接埠`));
  const onL3 = (fn) => each((t) => l3(t) || fn(t.iface, t));
  const onL2 = (fn) => each((t) => l2(t) || fn(t.pc, t));
  /** 第三層介面能設定的最大 ip mtu：路由器看介面的 mtu、Catalyst 9300 看 system mtu */
  const l2Of = (i) => {
    const d = dev();
    if (d.kind === 'router' || d.kind === 'firewall') return +i.l2mtu || 1500;
    if (isCat9300(d)) return +d.sw.sysMtu || 1500;
    if (isNexus(d) && i.bind.t === 'port') return +((d.sw.ports[i.bind.port] || {}).mtu) || 1500;
    return isNexus(d) ? 9216 : 1500;
  };
  const ensureVlan = (id, out) => {
    const sw = dev().sw;
    if (sw.vlans.some((v) => v.id === id)) return;
    if (vtpOf(dev()).mode === 'client') return; // VTP client 不能自己建 VLAN：埠會停在不存在的 VLAN 裡 (inactive)
    sw.vlans.push({ id, name: 'VLAN' + String(id).padStart(4, '0') });
    out.push(`% Access VLAN does not exist. Creating vlan ${id}`);
  };
  /** spanning-tree vlan <清單> priority：清單涵蓋全部 VLAN 時改預設值，否則只改那幾個 VLAN（n 是 null 就是取消） */
  const setVlanPrio = (list, n) => {
    const nums = vlanNums(list);
    if (!nums) return err('VLAN 清單的格式：10,20 或 10-20 或 1-4094');
    const s = (dev().sw.stp ||= {});
    s.on = true;
    if (nums === 'all') { s.prio = n == null ? 32768 : n; delete s.vprio; return undefined; }
    s.vprio ||= {};
    for (const v of nums) { if (n == null) delete s.vprio[v]; else s.vprio[v] = n; }
    if (!Object.keys(s.vprio).length) delete s.vprio;
    return undefined;
  };
  const syncNat = () => {
    for (const i of dev().ifaces) {
      if (i.nat) i.natOut = i.natRule = true;
      else if (i.natOut && i.natRule) i.natOut = i.natRule = false; // 在圖形介面關掉了
    }
  };
  const setNat = (i) => { i.nat = !!(i.natOut && i.natRule); };
  /** 這個位址池還有一對一的轉換在用（沒有 overload 的動態 NAT） */
  const natInUse = (d, pool) => { const st = getState() || {}, ttl = +((d.natTimeout || {}).simple) || 86400; return Object.values((((st.dyn || {}).natPool || {})[d.id] || {})[pool] || {}).some((v) => st.clock - v.t <= ttl); };
  const bindAcl = (i, name, dir) => {
    const d = dev(), key = dir === 'in' ? 'aclIn' : 'aclOut';
    const def = (d.aclDefs || {})[name];
    const other = d.ifaces.flatMap((x) => [['in', 'aclIn'], ['out', 'aclOut']].filter(([dd, k]) => (x !== i || dd !== dir) && x[k] && x[k].length && aclName(x, dd) === name).map(([, k]) => x[k]))[0];
    if (def) { i[key] = def.map((r) => ({ ...r })); delete d.aclDefs[name]; } else if (other) i[key] = other.map((r) => ({ ...r }));
    (i.aclNames ||= {})[dir] = name;
    if (!i[key]) i[key] = [];
  };

  const nfOf = () => (dev().nf ||= {});
  const tidyNf = () => { const n = dev().nf; if (!n) return; for (const k of Object.keys(n)) { const v = n[k]; if (v == null || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete n[k]; } if (!Object.keys(n).length) delete dev().nf; };
  // ── Tunnel 介面（GRE、mGRE、IPsec VTI）與 DMVPN 的 NHRP ──
  const onTun = (fn) => each((t) => (t.iface && isTun(t.iface) ? fn(t.iface, t) : err(`${t.name} 不是 Tunnel 介面`)));
  const nhrpOf = (i) => (i.nhrp ||= {});
  const tidyNhrp = (i) => { const n = i.nhrp; if (!n) return; for (const k of Object.keys(n)) if (n[k] == null || n[k] === false || (Array.isArray(n[k]) && !n[k].length)) delete n[k]; if (!Object.keys(n).length) delete i.nhrp; };
  const TUN_IF = [
    ['tunnel source <...>', ([x]) => onTun((i) => {
      if (parseIp(x) != null) { i.tun.src = x; return undefined; }
      const t = resolveIf(dev(), x);
      if (isErr(t)) return t;
      if (!t.iface) return err(`${t.name} 不是第三層介面`);
      if (isTun(t.iface)) return err('% tunnel source 不能是另一個 Tunnel 介面');
      i.tun.src = t.iface.id;
      return undefined;
    })],
    ['no tunnel source [...]', () => onTun((i) => { delete i.tun.src; })],
    ['tunnel destination <x>', ([x]) => (parseIp(x) == null ? err('用法：tunnel destination <對端的 IP 位址>') : onTun((i) => {
      if (tunMode(i) === 'mgre') return err('% Tunnel destination is not allowed for multipoint GRE tunnels（mGRE 的對端由 NHRP 決定）');
      i.tun.dst = x;
      return undefined;
    }))],
    ['no tunnel destination [...]', () => onTun((i) => { delete i.tun.dst; })],
    ['tunnel mode <...>', ([m]) => {
      const w = m.toLowerCase().split(/\s+/);
      const v = w[0] === 'gre' && (!w[1] || w[1] === 'ip') ? 'gre' : w[0] === 'gre' && /^multi/.test(w[1] || '') ? 'mgre' : w[0] === 'ipsec' && (!w[1] || w[1] === 'ipv4') ? 'ipsec' : w[0] === 'ipv6ip' && !w[1] ? 'ipv6ip' : null;
      if (!v) return err('這個模擬支援：tunnel mode gre ip、tunnel mode gre multipoint、tunnel mode ipsec ipv4、tunnel mode ipv6ip');
      return onTun((i) => {
        if (v === 'gre') delete i.tun.mode; else i.tun.mode = v;
        if (v === 'mgre' && i.tun.dst) { delete i.tun.dst; return '（multipoint GRE 不用 tunnel destination，已經移除；對端的位址由 NHRP 決定）'; }
        return undefined;
      });
    }],
    ['no tunnel mode [...]', () => onTun((i) => { delete i.tun.mode; })],
    ['tunnel key <n>', ([n]) => (/^\d+$/.test(n) && +n <= 4294967295 ? onTun((i) => { i.tun.key = +n; }) : err('用法：tunnel key <0-4294967295>'))],
    ['no tunnel key [...]', () => onTun((i) => { delete i.tun.key; })],
    ['tunnel protection ipsec profile <name> [...]', ([n]) => onTun((i) => {
      if (!(dev().ipsecProfiles || {})[n]) return err(`% IPSEC profile ${n} not found（先用 crypto ipsec profile ${n} 建立）`);
      i.tun.prot = n;
      return undefined;
    })],
    ['no tunnel protection [...]', () => onTun((i) => { delete i.tun.prot; })],
    ['keepalive [...]', ([rest]) => {
      const w = String(rest || '').split(/\s+/).filter(Boolean);
      const sec = w[0] != null ? +w[0] : 10, retry = w[1] != null ? +w[1] : 3;
      if (!(sec >= 1 && sec <= 32767) || !(retry >= 1 && retry <= 255)) return err('用法：keepalive [週期 1-32767 秒] [重試次數 1-255]（預設 10 秒、3 次）');
      return onTun((i) => { if (tunMode(i) === 'ipsec') return err('% Keepalive is not supported on IPsec tunnel（VTI 的 line protocol 本來就跟著 IPsec SA）'); i.tun.ka = { sec, retry }; return undefined; });
    }],
    ['no keepalive [...]', () => onTun((i) => { delete i.tun.ka; })],
    ['ip nhrp network-id <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 ? onTun((i) => { nhrpOf(i).id = +n; }) : err('用法：ip nhrp network-id <1-4294967295>'))],
    ['no ip nhrp network-id [...]', () => onTun((i) => { if (i.nhrp) delete i.nhrp.id; tidyNhrp(i); })],
    ['ip nhrp authentication <s>', ([x]) => (x.length > 8 ? err('% NHRP 的驗證字串最多 8 個字元') : onTun((i) => { nhrpOf(i).auth = x; }))],
    ['no ip nhrp authentication [...]', () => onTun((i) => { if (i.nhrp) delete i.nhrp.auth; tidyNhrp(i); })],
    ['ip nhrp holdtime <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 65535 ? onTun((i) => { if (+n === 7200) delete nhrpOf(i).hold; else nhrpOf(i).hold = +n; }) : err('用法：ip nhrp holdtime <1-65535 秒>（預設 7200）'))],
    ['no ip nhrp holdtime [...]', () => onTun((i) => { if (i.nhrp) delete i.nhrp.hold; tidyNhrp(i); })],
    ['ip nhrp nhs <ip> [...]', ([ip, rest]) => {
      if (parseIp(ip) == null) return err('用法：ip nhrp nhs <NHS 的 Tunnel 位址> [nbma <NHS 的公用 IP>] [multicast]');
      const w = String(rest || '').split(/\s+/).filter(Boolean);
      const k = w.findIndex((x) => /^nbma$/i.test(x)), nbma = k >= 0 ? w[k + 1] : '';
      if (k >= 0 && parseIp(nbma || '') == null) return err('用法：ip nhrp nhs <NHS 的 Tunnel 位址> nbma <NHS 的公用 IP> [multicast]');
      return onTun((i) => {
        const n = nhrpOf(i), list = (n.nhs ||= []);
        const e = list.find((x) => x.ip === ip) || (list.push({ ip }), list[list.length - 1]);
        if (nbma) e.nbma = nbma;
        if (w.some((x) => /^multicast$/i.test(x))) e.mcast = true;
        return undefined;
      });
    }],
    ['no ip nhrp nhs [...]', ([ip]) => onTun((i) => { if (i.nhrp) i.nhrp.nhs = ip ? (i.nhrp.nhs || []).filter((x) => x.ip !== ip.split(/\s+/)[0]) : []; tidyNhrp(i); })],
    ['ip nhrp map multicast <x>', ([x]) => (x.toLowerCase() !== 'dynamic' && parseIp(x) == null ? err('用法：ip nhrp map multicast dynamic | <對端的 NBMA 位址>') : onTun((i) => {
      const n = nhrpOf(i), v = x.toLowerCase() === 'dynamic' ? 'dynamic' : x;
      n.mcast = [...new Set([...(n.mcast || []), v])];
      return undefined;
    }))],
    ['no ip nhrp map multicast <x>', ([x]) => onTun((i) => { if (i.nhrp) i.nhrp.mcast = (i.nhrp.mcast || []).filter((y) => y !== (x.toLowerCase() === 'dynamic' ? 'dynamic' : x)); tidyNhrp(i); })],
    ['ip nhrp map <ip> <nbma>', ([ip, nbma]) => (parseIp(ip) == null || parseIp(nbma) == null ? err('用法：ip nhrp map <對端的 Tunnel 位址> <對端的 NBMA 位址>') : onTun((i) => {
      const n = nhrpOf(i), list = (n.maps ||= []);
      const e = list.find((x) => x.ip === ip);
      if (e) e.nbma = nbma; else list.push({ ip, nbma });
      return undefined;
    }))],
    ['no ip nhrp map <ip> [...]', ([ip]) => onTun((i) => { if (i.nhrp) i.nhrp.maps = (i.nhrp.maps || []).filter((x) => x.ip !== ip); tidyNhrp(i); })],
    ['ip nhrp redirect [...]', () => onTun((i) => { nhrpOf(i).redirect = true; })],
    ['no ip nhrp redirect [...]', () => onTun((i) => { if (i.nhrp) delete i.nhrp.redirect; tidyNhrp(i); })],
    ['ip nhrp shortcut', () => onTun((i) => { nhrpOf(i).shortcut = true; })],
    ['no ip nhrp shortcut', () => onTun((i) => { if (i.nhrp) delete i.nhrp.shortcut; tidyNhrp(i); })],
  ];

  const IF = [
    ['description <...>', ([t]) => each((x) => { if (x.pc) x.pc.desc = t; else if (x.iface) x.iface.desc = t; })],
    ['no description [...]', () => each((x) => { if (x.pc) delete x.pc.desc; else if (x.iface) delete x.iface.desc; })],
    ['ip address dhcp', () => onL3((i) => { i.mode = 'dhcp'; })],
    ['ip address <ip> <mask>', ([ip, mask]) => {
      if (parseIp(ip) == null) return err('IP 位址的格式不正確');
      if (maskBits(mask) == null) return err('子網路遮罩的格式不正確，例如 255.255.255.0');
      const r = onL3((i, t) => {
        // 同一個 VRF（或都在全域）裡，兩個介面的網段不能重疊；放進不同的 VRF 就可以用一樣的位址
        const v = i.vrf || '', a = parseIp(ip), b = maskBits(mask);
        const vd = v && (dev().vrfs || {})[v];
        if (vd && vd.style === 'def' && !vd.af4) return err(`% VRF ${v} 還沒有啟用 IPv4：vrf definition ${v} 底下要有 address-family ipv4`);
        for (const x of dev().ifaces) {
          if (x === i || (x.vrf || '') !== v || x.mode !== 'static' || parseIp(x.ip || '') == null || maskBits(x.mask || '') == null) continue;
          const xb = maskBits(x.mask), m = Math.min(b, xb);
          if (netOf(a, m) === netOf(parseIp(x.ip), m)) return err(`% ${fmtIp(netOf(a, b))} overlaps with ${longIf(x.label)}${v ? '' : '（要讓兩個介面用重疊的網段，就把它們放進不同的 VRF）'}`);
        }
        if (t.mgmtVlan) i.bind.vlan = t.mgmtVlan;
        Object.assign(i, { mode: 'static', ip, mask });
        return undefined;
      });
      attachPools(dev());
      return r;
    }],
    ['no ip address', () => onL3((i) => { Object.assign(i, { mode: 'static', ip: '', mask: '' }); })],
    ...[['vrf forwarding <v>', 'def'], ['ip vrf forwarding <v>', 'ip']].map(([pat, style]) => [pat, ([v], out) => {
      const vd = (dev().vrfs || {})[v];
      if (!vd) return err(`% VRF ${v} not configured.（先用 ${style === 'def' ? 'vrf definition' : 'ip vrf'} ${v} 建立）`);
      if (vd.style !== style) return err(`% ${v} 是用 ${vd.style === 'def' ? 'vrf definition' : 'ip vrf'} 建立的，介面上要用 ${vd.style === 'def' ? 'vrf forwarding' : 'ip vrf forwarding'}`);
      return onL3((i) => {
        if ((i.vrf || '') === v) return undefined;
        if (i.ip) out.push(`% Interface ${longIf(i.label)} IPv4 disabled and address(es) removed due to enabling VRF ${v}`);
        Object.assign(i, { vrf: v, ip: '', mask: '' });
        return undefined;
      });
    }]),
    ...['no vrf forwarding [...]', 'no ip vrf forwarding [...]'].map((pat) => [pat, (_, out) => onL3((i) => {
      if (!i.vrf) return undefined;
      if (i.ip) out.push(`% Interface ${longIf(i.label)} IPv4 disabled and address(es) removed due to disabling VRF ${i.vrf}`);
      delete i.vrf; Object.assign(i, { ip: '', mask: '' });
      return undefined;
    })]),
    ['pppoe-client [...]', () => onL3((i) => { i.mode = 'pppoe'; }) || 'PPPoE 的帳號與密碼請到「介面」分頁填寫'],
    ['ip nat outside', () => {
      syncNat();
      const r = onL3((i) => { i.natOut = true; setNat(i); });
      return r || (S.cur.some((t) => t.iface && !t.iface.nat) && !(dev().natPoolRules || []).length ? '（還要在設定模式下 ip nat inside source list 1 interface <這個介面> overload，才會開始轉換位址）' : undefined);
    }],
    ['no ip nat outside', () => { syncNat(); return onL3((i) => { i.natOut = false; setNat(i); }); }],
    ['ip nat inside', () => onL3(() => {})],
    ['no ip nat inside', () => onL3(() => {})],
    // NVI (NAT Virtual Interface)：不分 inside / outside，進出這些介面的都照 ip nat source … 轉換
    ['ip nat enable', () => onL3((i) => { i.nvi = true; })],
    ['no ip nat enable', () => onL3((i) => { delete i.nvi; })],
    ['ip helper-address <ip>', ([ip]) => (parseIp(ip) == null ? err('IP 位址的格式不正確') : onL3((i) => { i.helper = ip; }))],
    ['no ip helper-address [...]', () => onL3((i) => { i.helper = ''; })],
    ['ip ospf cost <n>', ([n]) => (+n >= 1 && +n <= 65535 ? onL3((i) => { i.ospfCost = String(+n); }) : err('cost 必須是 1 – 65535'))],
    ['no ip ospf cost', () => onL3((i) => { i.ospfCost = ''; })],
    ['ip ospf <pid> area <a>', ([pid, a]) => (/^\d+$/.test(a) ? onL3((i) => {
      // 介面在 VRF 裡：程序要是那個 VRF 的（router ospf <pid> vrf <名稱>）；全域的介面不能用 VRF 的程序
      const d = dev(), mine = i.vrf ? (d.ospfVrf || {})[i.vrf] : null;
      const owner = Object.entries(d.ospfVrf || {}).find(([, c]) => +c.pid === +pid);
      if (i.vrf && !mine) return err(`% ${i.label} 在 VRF ${i.vrf} 裡：先用 router ospf <程序> vrf ${i.vrf} 建立這個 VRF 的 OSPF 程序`);
      if (i.vrf && +mine.pid !== +pid) return err(`% ${i.label} 在 VRF ${i.vrf} 裡，那個 VRF 的 OSPF 程序是 ${mine.pid}，不是 ${pid}`);
      if (!i.vrf && owner) return err(`% OSPF 程序 ${pid} 屬於 VRF ${owner[0]}，${i.label} 在全域的路由表`);
      i.ospf = true; i.ospfArea = +a;
      return undefined;
    }) : err('區域請寫數字，例如 area 0'))],
    ['no ip ospf <pid> area <a>', () => onL3((i) => { i.ospf = false; delete i.ospfArea; })],
    ['ip ospf priority <n>', ([n]) => (+n >= 0 && +n <= 255 && /^\d+$/.test(n) ? onL3((i) => { if (+n === 1) delete i.ospfPrio; else i.ospfPrio = +n; }) : err('priority 的範圍是 0 – 255（0 表示永遠不當 DR / BDR）'))],
    ['no ip ospf priority [...]', () => onL3((i) => { delete i.ospfPrio; })],
    ['ip ospf hello-interval <n>', ([n]) => (+n >= 1 && +n <= 65535 ? onL3((i) => { if (+n === 10) delete i.ospfHello; else i.ospfHello = +n; }) : err('hello-interval 的範圍是 1 – 65535 秒'))],
    ['no ip ospf hello-interval [...]', () => onL3((i) => { delete i.ospfHello; })],
    ['ip ospf dead-interval minimal hello-multiplier <n>', ([n]) => (+n >= 3 && +n <= 20 ? onL3((i) => { i.ospfFast = +n; delete i.ospfDead; delete i.ospfHello; }) : err('hello-multiplier 的範圍是 3 – 20（每秒送幾個 Hello）'))],
    ['ip ospf dead-interval <n>', ([n]) => (+n >= 1 && +n <= 65535 ? onL3((i) => { i.ospfDead = +n; }) : err('dead-interval 的範圍是 1 – 65535 秒'))],
    ['no ip ospf dead-interval [...]', () => onL3((i) => { delete i.ospfDead; delete i.ospfFast; })],
    ['ip ospf network <t>', ([t]) => {
      if ('point-to-multipoint'.startsWith(t.toLowerCase()) && t.length > 8) return err('% 這個模擬還不支援 point-to-multipoint（DMVPN 請用 broadcast，spoke 設 ip ospf priority 0）');
      const v = ['point-to-point', 'broadcast'].find((x) => x.startsWith(t.toLowerCase()));
      return v ? onL3((i) => { if (v === 'broadcast') { if (isTun(i)) i.ospfNet = 'broadcast'; else delete i.ospfNet; } else i.ospfNet = 'p2p'; }) : err('用法：ip ospf network point-to-point | broadcast');
    }],
    ['no ip ospf network [...]', () => onL3((i) => { delete i.ospfNet; })],
    ['ip ospf authentication message-digest', () => onL3((i) => { i.ospfAuth = 'md5'; })],
    ['ip ospf authentication null', () => onL3((i) => { i.ospfAuth = 'null'; })],
    ['ip ospf authentication', () => onL3((i) => { i.ospfAuth = 'plain'; })],
    ['no ip ospf authentication [...]', () => onL3((i) => { delete i.ospfAuth; })],
    ['ip ospf authentication-key <...>', ([k]) => onL3((i) => { i.ospfKey = { id: '', key: readSecret(k.split(/\s+/)) }; })],
    ['ip ospf message-digest-key <id> md5 <...>', ([id, k]) => (/^\d+$/.test(id) ? onL3((i) => { i.ospfKey = { id: +id, key: readSecret(k.split(/\s+/)) }; }) : err('用法：ip ospf message-digest-key 1 md5 <金鑰>'))],
    ['no ip ospf message-digest-key [...]', () => onL3((i) => { delete i.ospfKey; })],
    ['no ip ospf authentication-key [...]', () => onL3((i) => { delete i.ospfKey; })],
    ['ip ospf mtu-ignore', () => onL3((i) => { i.ospfMtuIgnore = true; })],
    ['bfd interval <tx> min_rx <rx> multiplier <m>', ([tx, rx, m]) => {
      if (!(+tx >= 50 && +tx <= 9999) || !(+rx >= 50 && +rx <= 9999) || !(+m >= 3 && +m <= 50)) return err('用法：bfd interval <50-9999 毫秒> min_rx <50-9999 毫秒> multiplier <3-50>');
      return onL3((i) => { i.bfd = { tx: +tx, rx: +rx, mult: +m }; });
    }],
    ['no bfd interval [...]', () => onL3((i) => { delete i.bfd; })],
    ['ip ospf bfd [...]', ([rest]) => onL3((i) => { if (/disable/i.test(rest || '')) { i.ospfBfdOff = true; delete i.ospfBfd; } else { i.ospfBfd = true; delete i.ospfBfdOff; } })],
    ['no ip ospf bfd [...]', () => onL3((i) => { delete i.ospfBfd; delete i.ospfBfdOff; })],
    ['no ip ospf mtu-ignore', () => onL3((i) => { delete i.ospfMtuIgnore; })],
    ['ip mtu <n>', ([n]) => (+n >= 68 && +n <= 9216 ? onL3((i) => {
      const lim = l2Of(i);
      if (+n > lim) return err(`% ip mtu 不能比介面本身的 MTU（${lim}）大${dev().kind === 'router' ? '：先用 mtu <1500-9216> 把介面的 MTU 調大' : isCat9300(dev()) ? '：先用 system mtu 調大' : ''}`);
      if (+n === lim) delete i.mtu; else i.mtu = +n;
      return undefined;
    }) : err('ip mtu 的範圍是 68 – 9216'))],
    ['no ip mtu', () => onL3((i) => { delete i.mtu; })],
    ['ip policy route-map <name>', ([name]) => onL3((i) => { i.policyRm = name; })],
    ['no ip policy route-map [...]', () => onL3((i) => { delete i.policyRm; })],
    ['ip tcp adjust-mss <n>', ([n]) => (/^\d+$/.test(n) && +n >= 500 && +n <= 1460 ? onL3((i) => { i.adjMss = +n; }) : err('% ip tcp adjust-mss 的範圍是 500 – 1460（IPsec 常用 1360、PPPoE 用 1452）'))],
    ['no ip tcp adjust-mss [...]', () => onL3((i) => { delete i.adjMss; })],
    // ICMP Redirect：預設開著
    ['ip redirects', () => onL3((i) => { delete i.redirects; })],
    ['no ip redirects', () => onL3((i) => { i.redirects = false; })],
    ['mtu <n>', ([n]) => {
      const d = dev(), v = +n;
      if (!/^\d+$/.test(n)) return err('用法：mtu <位元組>');
      if (isCat2960(d)) return err('% Catalyst 2960 不能各別設定連接埠的 MTU：用全域的 system mtu jumbo <1500-9000>（重新開機之後才生效）');
      if (d.kind === 'l3switch' && !isNexus(d)) return err('% Catalyst 9300 的 MTU 是整台一起設定：用全域的 system mtu <1500-9198>');
      return each((t) => {
        if (isNexus(d)) {
          if (v < 576 || v > 9216) return err('% mtu 的範圍是 576 – 9216');
          if (t.pc) { if (v === 1500) delete t.pc.mtu; else t.pc.mtu = v; } // 第二層的埠、routed 埠
          else if (t.iface) { if (v === 1500) delete t.iface.mtu; else t.iface.mtu = v; } // SVI
          return undefined;
        }
        if (!t.iface || t.pc) return err(`${t.name} 不能設定 MTU`);
        if (t.iface.bind.t === 'loop') return err('% Loopback 的 MTU 不能改');
        if (v < 1500 || v > 9216) return err('% mtu 的範圍是 1500 – 9216（要比 1500 小，請用 ip mtu）');
        if (v === 1500) delete t.iface.l2mtu; else t.iface.l2mtu = v;
        if (+t.iface.mtu >= v) delete t.iface.mtu; // ip mtu 不能比介面的 MTU 大
        return undefined;
      });
    }],
    ['no mtu', () => each((t) => {
      if (isNexus(dev())) { if (t.pc) delete t.pc.mtu; else if (t.iface) delete t.iface.mtu; return undefined; }
      if (t.iface) { delete t.iface.l2mtu; if (+t.iface.mtu > 1500) delete t.iface.mtu; }
      return undefined;
    })],
    ['bandwidth <kbps>', ([k]) => (+k >= 1 && +k <= 100000000 ? onL3((i) => { i.bandwidth = +k; }) : err('bandwidth 的單位是 kbps，例如 bandwidth 20000'))],
    ['no bandwidth', () => onL3((i) => { delete i.bandwidth; })],
    ['ip access-group <name> <dir>', ([name, dir]) => (['in', 'out'].includes(dir.toLowerCase()) ? onL3((i) => bindAcl(i, name.toUpperCase(), dir.toLowerCase())) : err('方向必須是 in 或 out'))],
    ['no ip access-group <name> <dir>', ([, dir]) => onL3((i) => { i[dir.toLowerCase() === 'in' ? 'aclIn' : 'aclOut'] = []; if (i.aclNames) delete i.aclNames[dir.toLowerCase()]; })],
    // FHRP：VRRP（vrrp …，預設會搶回 Master）與 HSRP（standby …，預設不搶，要 standby <g> preempt）
    ['standby version <n>', () => undefined],
    ...['vrrp', 'standby', 'glbp'].flatMap((kw) => {
      const proto = kw === 'vrrp' ? 'vrrp' : kw === 'glbp' ? 'glbp' : 'hsrp', max = proto === 'vrrp' ? 254 : 255;
      const grpOk = (g) => /^\d+$/.test(g) && +g >= (proto === 'vrrp' ? 1 : 0) && +g <= (proto === 'glbp' ? 1023 : 255);
      const G = (g, fn) => (grpOk(g) ? onL3((i) => fn(fhrpOn(i, proto, g), i)) : err(`群組號碼必須是 ${proto === 'vrrp' ? '1' : '0'} – 255`));
      return [
        [`${kw} <g> ip <vip>`, ([g, vip]) => (parseIp(vip) == null ? err('IP 位址的格式不正確') : G(g, (v) => { Object.assign(v, { on: true, vip }); }))],
        [`${kw} <g> priority <n>`, ([g, n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= max ? G(g, (v) => { v.prio = String(+n); }) : err(`priority 必須是 1 – ${max}`))],
        [`no ${kw} <g> priority [...]`, ([g]) => G(g, (v) => { v.prio = '100'; })],
        [`${kw} <g> preempt [...]`, ([g]) => G(g, (v) => { if (proto === 'vrrp') delete v.preempt; else v.preempt = true; })],
        [`no ${kw} <g> preempt [...]`, ([g]) => G(g, (v) => { if (proto === 'vrrp') v.preempt = false; else delete v.preempt; })],
        [`${kw} <g> track <obj> [...]`, ([g, obj, rest]) => {
          if (!/^\d+$/.test(obj)) return err(`用法：${kw} ${g} track <物件編號> [decrement <值>]（先用 track <編號> interface … 或 track <編號> ip sla … 定義物件）`);
          const m = String(rest || '').match(/^decrement\s+(\d+)$/i);
          if (rest && !m) return err(`用法：${kw} ${g} track ${obj} decrement <1-${max}>`);
          return G(g, (v) => {
            const list = (v.track ||= []), cur = list.find((t) => +t.obj === +obj);
            const dec = m ? +m[1] : undefined;
            if (cur) { if (dec == null) delete cur.dec; else cur.dec = dec; } else list.push(dec == null ? { obj: +obj } : { obj: +obj, dec });
          });
        }],
        [`no ${kw} <g> track <obj> [...]`, ([g, obj]) => G(g, (v) => { v.track = (v.track || []).filter((t) => +t.obj !== +obj); if (!v.track.length) delete v.track; })],
        ...(proto === 'glbp' ? [[`glbp <g> load-balancing <lb>`, ([g, lb]) => {
          const x = ['round-robin', 'host-dependent', 'weighted'].find((y) => y.startsWith(lb.toLowerCase()));
          return x ? G(g, (v) => { if (x === 'round-robin') delete v.lb; else v.lb = x; }) : err('用法：glbp <群組> load-balancing round-robin | host-dependent | weighted');
        }]] : []),
        [`no ${kw} <g> ip [...]`, ([g]) => G(g, (v) => { v.on = false; })],
        [`no ${kw} <g>`, ([g]) => G(g, (v) => { v.on = false; })],
        [`${kw} <g> <...>`, () => err(`這個模擬支援的 ${kw} 指令：ip、priority、preempt、track（timers、authentication 沒有模擬）`)],
      ];
    }),

    ['ipv6 address <ll> link-local', ([a]) => (parseIp6(a) != null && isLinkLocal(parseIp6(a)) ? onL3((i) => { i.ll6 = fmtIp6(parseIp6(a)); }) : err('link-local 位址要在 FE80::/10 裡，例如 ipv6 address FE80::1 link-local'))],
    ['no ipv6 address <ll> link-local', () => onL3((i) => { delete i.ll6; })],
    // WAN 用 SLAAC 取得位址；加 default 才會把送 RA 的路由器當成預設路由
    ['ipv6 address autoconfig [...]', ([rest]) => {
      const t = String(rest || '').trim().toLowerCase();
      if (t && t !== 'default') return err('用法：ipv6 address autoconfig [default]');
      return onL3((i) => { i.mode6 = 'auto'; if (t) i.v6default = true; else delete i.v6default; });
    }],
    ['no ipv6 address autoconfig [...]', () => onL3((i) => { delete i.mode6; delete i.v6default; })],
    // 用 DHCPv6 PD 拿到的一般前綴寫位址：ipv6 address HOME ::1:0:0:0:1/64
    ['ipv6 address <name> <sfx>', ([name, sfx]) => {
      if (parseIp6(name) != null || parseCidr6(name) != null) return err('用法：ipv6 address <位址/前綴長度>，或 ipv6 address <一般前綴名稱> <後面的位址/前綴長度>');
      const x = parseCidr6(sfx);
      if (!x) return err(`用法：ipv6 address ${name} ::1:0:0:0:1/64（一般前綴後面接的位址：子網路編號與主機的部分）`);
      return onL3((i) => { if (!i.ip6 && !i.gp6) i.ra = true; i.gp6 = { name, suffix: sfx.toLowerCase() }; });
    }],
    ['ipv6 address <cidr>', ([c]) => {
      const x = parseCidr6(c);
      if (x == null) return err('IPv6 位址要帶前綴長度，例如 2001:db8:a::1/64');
      if (isLinkLocal(x.ip)) return err('FE80:: 開頭的是 link-local 位址：要手動指定請用 ipv6 address FE80::1 link-local');
      return onL3((i) => { if (!i.ip6) i.ra = true; i.ip6 = c; });
    }],
    ['no ipv6 address [...]', ([rest]) => onL3((i) => {
      const t = String(rest || '').trim().split(/\s+/)[0] || '';
      if (i.gp6 && (!t || t === i.gp6.name)) delete i.gp6;
      if (!t || parseCidr6(t)) i.ip6 = '';
      if (!t) { delete i.mode6; delete i.v6default; }
    })],
    // DHCPv6 Prefix Delegation 的用戶端：向 ISP 要一段前綴，存成一般前綴
    ['ipv6 dhcp client pd <name> [...]', ([name]) => onL3((i) => { i.pd6 = name; })],
    ['delay <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 16777215 ? onL3((i) => { i.eigrpDelay = +n; }) : err('delay 的單位是十微秒，1 – 16777215'))],
    ['no delay', () => onL3((i) => { delete i.eigrpDelay; })],
    ['ip hello-interval eigrp <as> <sec>', ([, s]) => (+s >= 1 && +s <= 65535 ? onL3((i) => { i.eigrpHello = +s; }) : err('Hello 間隔是 1 – 65535 秒'))],
    ['no ip hello-interval eigrp [...]', () => onL3((i) => { delete i.eigrpHello; })],
    ['ip hold-time eigrp <as> <sec>', ([, s]) => (+s >= 1 && +s <= 65535 ? onL3((i) => { i.eigrpHold = +s; }) : err('Hold time 是 1 – 65535 秒'))],
    ['no ip hold-time eigrp [...]', () => onL3((i) => { delete i.eigrpHold; })],
    ['ip authentication mode eigrp <as> md5', ([as]) => onL3((i) => { i.eigrpAuth = { ...(i.eigrpAuth || {}), as: +as, md5: true }; })],
    ['no ip authentication mode eigrp [...]', () => onL3((i) => { if (i.eigrpAuth) { delete i.eigrpAuth.md5; if (!i.eigrpAuth.chain) delete i.eigrpAuth; } })],
    ['ip authentication key-chain eigrp <as> <chain>', ([as, c]) => onL3((i) => { i.eigrpAuth = { ...(i.eigrpAuth || {}), as: +as, chain: c }; })],
    ['no ip authentication key-chain eigrp [...]', () => onL3((i) => { if (i.eigrpAuth) { delete i.eigrpAuth.chain; if (!i.eigrpAuth.md5) delete i.eigrpAuth; } })],
    ['ip summary-address eigrp <as> <net> <mask> [...]', ([, n, m]) => {
      const net = parseIp(n), bits = parseMask(m);
      if (net == null || bits == null) return err('用法：ip summary-address eigrp <AS> <網段> <遮罩>');
      return onL3((i) => { const s = { net: netOf(net, bits), bits }; i.eigrpSum = [...(i.eigrpSum || []).filter((x) => !(x.net === s.net && x.bits === s.bits)), s]; });
    }],
    ['no ip summary-address eigrp <as> <net> <mask> [...]', ([, n, m]) => {
      const net = parseIp(n), bits = parseMask(m);
      if (net == null || bits == null) return err('用法：no ip summary-address eigrp <AS> <網段> <遮罩>');
      return onL3((i) => { i.eigrpSum = (i.eigrpSum || []).filter((x) => !(x.net === netOf(net, bits) && x.bits === bits)); if (!i.eigrpSum.length) delete i.eigrpSum; });
    }],
    ['no ip split-horizon eigrp <as>', () => onL3((i) => { i.eigrpNoSplit = true; })],
    ['ip split-horizon eigrp <as>', () => onL3((i) => { delete i.eigrpNoSplit; })],
    ['ip rip send version <...>', ([v]) => { const l = ripVers(v); return l ? onL3((i) => { i.ripSend = l; }) : err('用法：ip rip send version 1 | 2 | 1 2'); }],
    ['no ip rip send version [...]', () => onL3((i) => { delete i.ripSend; })],
    ['ip rip receive version <...>', ([v]) => { const l = ripVers(v); return l ? onL3((i) => { i.ripRecv = l; }) : err('用法：ip rip receive version 1 | 2 | 1 2'); }],
    ['no ip rip receive version [...]', () => onL3((i) => { delete i.ripRecv; })],
    ['ip rip authentication key-chain <chain>', ([c]) => onL3((i) => { i.ripAuth = { ...(i.ripAuth || {}), chain: c }; })],
    ['no ip rip authentication key-chain [...]', () => onL3((i) => { if (i.ripAuth) { delete i.ripAuth.chain; if (!i.ripAuth.md5) delete i.ripAuth; } })],
    ['ip rip authentication mode <m>', ([m]) => {
      const v = String(m).toLowerCase();
      if (!['md5', 'text'].includes(v)) return err('用法：ip rip authentication mode md5 | text');
      return onL3((i) => { i.ripAuth = { ...(i.ripAuth || {}) }; if (v === 'md5') i.ripAuth.md5 = true; else delete i.ripAuth.md5; if (!i.ripAuth.chain && !i.ripAuth.md5) delete i.ripAuth; });
    }],
    ['no ip rip authentication mode [...]', () => onL3((i) => { if (i.ripAuth) { delete i.ripAuth.md5; if (!i.ripAuth.chain) delete i.ripAuth; } })],
    ['ip summary-address rip <net> <mask>', ([n, m]) => {
      const net = parseIp(n), bits = parseMask(m);
      if (net == null || bits == null) return err('用法：ip summary-address rip <網段> <遮罩>');
      return onL3((i) => { const s = { net: netOf(net, bits), bits }; i.ripSum = [...(i.ripSum || []).filter((x) => !(x.net === s.net && x.bits === s.bits)), s]; });
    }],
    ['no ip summary-address rip <net> <mask>', ([n, m]) => {
      const net = parseIp(n), bits = parseMask(m);
      if (net == null || bits == null) return err('用法：no ip summary-address rip <網段> <遮罩>');
      return onL3((i) => { i.ripSum = (i.ripSum || []).filter((x) => !(x.net === netOf(net, bits) && x.bits === bits)); if (!i.ripSum.length) delete i.ripSum; });
    }],
    ['no ip split-horizon', () => onL3((i) => { i.ripNoSplit = true; })],
    ['ip split-horizon', () => onL3((i) => { delete i.ripNoSplit; })],
    ['zone-member security <z>', ([z]) => {
      const Z = dev().zbf;
      if (!Z || !Z.zones[z]) return err(`Zone ${z} does not exist（先用 zone security ${z} 建立）`);
      return onL3((i) => { i.zone = z; });
    }],
    ['no zone-member security [...]', () => onL3((i) => { delete i.zone; })],
    ['nat64 enable', () => onL3((i) => { i.nat64 = true; })],
    ['no nat64 enable', () => onL3((i) => { delete i.nat64; })],
    ['no ipv6 dhcp client pd [...]', () => onL3((i) => { delete i.pd6; })],
    ['ipv6 enable', () => onL3(() => {})],
    ['no ipv6 enable', () => onL3(() => {})],
    ['ipv6 nd ra suppress [...]', () => onL3((i) => { i.ra = false; })],
    ['no ipv6 nd ra suppress [...]', () => onL3((i) => { i.ra = true; })],
    // RA 的旗標：M = 位址向 DHCPv6 要 (stateful)、O = 其他設定 (DNS) 向 DHCPv6 要、前綴的 A = 可以用 SLAAC
    ['ipv6 nd managed-config-flag', () => onL3((i) => { i.raM = true; })],
    ['no ipv6 nd managed-config-flag', () => onL3((i) => { delete i.raM; })],
    ['ipv6 nd other-config-flag', () => onL3((i) => { i.raO = true; })],
    ['no ipv6 nd other-config-flag', () => onL3((i) => { delete i.raO; })],
    ['ipv6 nd prefix default no-autoconfig', () => onL3((i) => { i.raNoAuto = true; })],
    ['ipv6 nd prefix <pfx> [...]', ([, rest]) => onL3((i) => { if (/\bno-autoconfig\b/i.test(rest || '')) i.raNoAuto = true; else delete i.raNoAuto; })],
    ['no ipv6 nd prefix [...]', () => onL3((i) => { delete i.raNoAuto; })],
    ['ipv6 dhcp server <pool> [...]', ([name]) => onL3((i) => { i.dhcp6 = name; delete i.relay6; })],
    ['no ipv6 dhcp server [...]', () => onL3((i) => { delete i.dhcp6; })],
    ['ipv6 dhcp relay destination <ip> [...]', ([ip]) => (parseIp6(ip) == null ? err('用法：ipv6 dhcp relay destination <DHCPv6 伺服器的 IPv6 位址>') : onL3((i) => { i.relay6 = fmtIp6(parseIp6(ip)); delete i.dhcp6; }))],
    ['no ipv6 dhcp relay destination [...]', () => onL3((i) => { delete i.relay6; })],
    // OSPFv3：直接在介面上啟用（沒有 network 敘述）
    ['ipv6 ospf <pid> area <a>', ([, a]) => {
      const d = dev();
      if (!d.v6routing) return err('% OSPFv3: IPv6 routing not enabled（先下 ipv6 unicast-routing）');
      if (!/^\d+$/.test(a)) return err('區域請寫數字，例如 area 0');
      const r = onL3((i) => { i.ospf6Area = +a; });
      d.ospf6 ||= {};
      return r;
    }],
    ['no ipv6 ospf <pid> area [...]', () => onL3((i) => { delete i.ospf6Area; })],
    ['ipv6 ospf cost <n>', ([n]) => (+n >= 1 && +n <= 65535 ? onL3((i) => { i.ospf6Cost = +n; }) : err('cost 必須是 1 – 65535'))],
    ['no ipv6 ospf cost [...]', () => onL3((i) => { delete i.ospf6Cost; })],
    ['ipv6 ospf priority <n>', ([n]) => (/^\d+$/.test(n) && +n <= 255 ? onL3((i) => { if (+n === 1) delete i.ospf6Prio; else i.ospf6Prio = +n; }) : err('priority 的範圍是 0 – 255（0 表示永遠不當 DR / BDR）'))],
    ['no ipv6 ospf priority [...]', () => onL3((i) => { delete i.ospf6Prio; })],
    ['ipv6 ospf hello-interval <n>', ([n]) => (+n >= 1 && +n <= 65535 ? onL3((i) => { if (+n === 10) delete i.ospf6Hello; else i.ospf6Hello = +n; }) : err('hello-interval 的範圍是 1 – 65535 秒'))],
    ['no ipv6 ospf hello-interval [...]', () => onL3((i) => { delete i.ospf6Hello; })],
    ['ipv6 ospf dead-interval <n>', ([n]) => (+n >= 1 && +n <= 65535 ? onL3((i) => { i.ospf6Dead = +n; }) : err('dead-interval 的範圍是 1 – 65535 秒'))],
    ['no ipv6 ospf dead-interval [...]', () => onL3((i) => { delete i.ospf6Dead; })],
    ['ipv6 ospf network <t>', ([t]) => {
      const v = ['point-to-point', 'broadcast'].find((x) => x.startsWith(t.toLowerCase()));
      return v ? onL3((i) => { if (v === 'broadcast') delete i.ospf6Net; else i.ospf6Net = 'p2p'; }) : err('用法：ipv6 ospf network point-to-point | broadcast');
    }],
    ['no ipv6 ospf network [...]', () => onL3((i) => { delete i.ospf6Net; })],
    ['ipv6 traffic-filter <name> <dir>', ([name, dir]) => (['in', 'out'].includes(dir.toLowerCase()) ? onL3((i) => { i[dir.toLowerCase() === 'in' ? 'acl6In' : 'acl6Out'] = name; }) : err('方向必須是 in 或 out'))],
    ['no ipv6 traffic-filter <name> <dir>', ([, dir]) => onL3((i) => { delete i[dir.toLowerCase() === 'in' ? 'acl6In' : 'acl6Out']; })],
    ['encapsulation dot1q <vlan>', ([v]) => each((t) => {
      if (!t.sub) return err('encapsulation 只能用在子介面，例如 interface Gi0/0/0.10');
      if (!(+v >= 1 && +v <= 4094)) return err('VLAN ID 必須是 1 – 4094');
      t.iface.bind.vlan = +v;
      return undefined;
    })],
    ...TUN_IF,
    // NetFlow：傳統的 ip flow ingress / egress，或 Flexible NetFlow 的 ip flow monitor <名稱> input | output
    ['ip flow ingress', () => onL3((i) => { const n = nfOf(); n.ingress = [...new Set([...(n.ingress || []), i.id])]; })],
    ['no ip flow ingress', () => onL3((i) => { const n = nfOf(); n.ingress = (n.ingress || []).filter((x) => x !== i.id); tidyNf(); })],
    ['ip flow egress', () => onL3((i) => { const n = nfOf(); n.egress = [...new Set([...(n.egress || []), i.id])]; })],
    ['no ip flow egress', () => onL3((i) => { const n = nfOf(); n.egress = (n.egress || []).filter((x) => x !== i.id); tidyNf(); })],
    ['ip flow monitor <m> <dir>', ([m, dir]) => {
      const d = dev();
      if (!((d.nf || {}).monitors || {})[m]) return err(`% Flow Monitor: ${m} does not exist（先用 flow monitor ${m} 建立）`);
      const w = /^in/i.test(dir) ? 'in' : /^out/i.test(dir) ? 'out' : null;
      if (!w) return err('用法：ip flow monitor <名稱> input | output');
      return onL3((i) => { ((nfOf().ifMon ||= {})[i.id] ||= {})[w] = m; });
    }],
    ['no ip flow monitor <m> <dir>', ([, dir]) => onL3((i) => { const n = nfOf(), x = (n.ifMon || {})[i.id]; if (x) { delete x[/^in/i.test(dir) ? 'in' : 'out']; if (!Object.keys(x).length) delete n.ifMon[i.id]; } tidyNf(); })],
    ['crypto map <name>', ([name]) => onL3((i) => { i.cmap = name; })],
    ['no crypto map [...]', () => onL3((i) => { i.cmap = ''; })],
    // shutdown 也會清掉 err-disabled（之後 no shutdown，原因還在的話會馬上再被關）
    ['shutdown', () => each((t) => {
      if (t.pc) t.pc.shut = true; else if ((t.port || t.loop || t.tunnel) && t.iface) t.iface.shut = true;
      const ed = (getState().dyn || {}).errdis;
      if (ed && t.port) delete ed[dev().id + ':' + t.port.id];
    })],
    ['no shutdown', () => each((t) => { if (t.pc) t.pc.shut = false; else if ((t.port || t.loop || t.tunnel) && t.iface) t.iface.shut = false; })],
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
    ['power inline <m> [...]', ([m]) => {
      const mode = ['auto', 'never', 'static'].find((x) => x.startsWith(m.toLowerCase()));
      if (!mode) return err('用法：power inline auto | never');
      return onL2((pc, t) => (t.port.poe ? void (mode === 'never' ? (pc.poe = 'never') : delete pc.poe) : err(`${t.name} 不支援 PoE`)));
    }],
    ['no power inline [...]', () => onL2((pc) => { delete pc.poe; })],
    ['mls qos trust device <x>', ([x]) => ('cisco-phone'.startsWith(x.toLowerCase()) ? onL2((pc) => { pc.trustDevice = 'cisco-phone'; }) : err('用法：mls qos trust device cisco-phone'))],
    ['no mls qos trust device [...]', () => onL2((pc) => { delete pc.trustDevice; })],
    ['mls qos trust <x>', ([x]) => {
      const t = ['dscp', 'cos', 'ip-precedence'].find((y) => y.startsWith(x.toLowerCase()));
      if (!t || t === 'ip-precedence') return err('用法：mls qos trust dscp | cos | device cisco-phone');
      return onL2((pc) => { pc.qosTrust = t; });
    }],
    ['no mls qos trust', () => onL2((pc) => { delete pc.qosTrust; })],
    ['auto qos voip <x>', ([x], out) => {
      const kind = ['cisco-phone', 'trust'].find((y) => y.startsWith(x.toLowerCase()));
      if (!kind) return err('用法：auto qos voip cisco-phone | trust');
      const sw = dev().sw;
      if (!sw || !isSw(dev()) || dev().kind !== 'mswitch') return err('這台設備不支援 auto qos');
      // AutoQoS：打開 mls qos，把 CoS 5 對應到 EF，信任電話（或上行埠）的標記
      sw.qos = { ...(sw.qos || {}), on: true, cosDscp: [0, 8, 16, 26, 32, 46, 48, 56] };
      const r = onL2((pc) => { pc.qosTrust = kind === 'trust' ? 'dscp' : 'cos'; if (kind === 'cisco-phone') pc.trustDevice = 'cisco-phone'; else delete pc.trustDevice; pc.autoQos = kind; });
      if (!r) out.push('（AutoQoS 已經打開 mls qos，並把 CoS 5 對應到 DSCP 46 (EF)）');
      return r;
    }],
    ['no auto qos voip [...]', () => onL2((pc) => { delete pc.autoQos; delete pc.qosTrust; delete pc.trustDevice; })],
    ['service-policy <dir> <name>', ([dir, name]) => {
      const dr = ['input', 'output'].find((x) => x.startsWith(dir.toLowerCase()));
      if (!dr) return err('用法：service-policy input | output <政策名稱>');
      const d = dev(), pm = (d.policyMaps || {})[name];
      if (!pm) return err(`policy map ${name} not configured`);
      const queuing = (p) => p.some((c) => c.priority || c.bandwidth || c.fq || c.qlimit);
      if (dr === 'input' && (queuing(pm) || pm.some((c) => c.shape))) return err('Configuration failed: queueing and shaping are not supported in the input direction（佇列與整形只能用在 output）');
      for (const c of pm) {
        const child = c.child && (d.policyMaps || {})[c.child];
        if (child && queuing(child) && !c.shape) return err(`A child policy with queueing actions requires shape in the parent class（${c.cls} 要先 shape average，子政策 ${c.child} 的 priority / bandwidth 才有意義）`);
      }
      // 保留的頻寬加起來不能超過 100%
      const flat = pm.some((c) => c.shape) ? (d.policyMaps[pm.find((c) => c.shape).child] || []) : pm;
      const pct = flat.reduce((a, c) => a + ((c.priority && c.priority.pct) || 0) + ((c.bandwidth && c.bandwidth.pct) || 0), 0);
      if (pct > 100) return err(`I/f: Total bandwidth requested ${pct}% exceeds 100% of available bandwidth`);
      return onL3((i) => { i[dr === 'input' ? 'qosIn' : 'qosOut'] = name; });
    }],
    ['no service-policy <dir> [...]', ([dir]) => onL3((i) => { delete i[(dir || '').toLowerCase().startsWith('i') ? 'qosIn' : 'qosOut']; })],
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
    ['switchport port-security maximum <n> [...]', ([n]) => {
      if (!/^\d+$/.test(n) || +n < 1 || +n > 8192) return err('用法：switchport port-security maximum <1-8192>');
      return onL2((pc, t) => {
        const ps = (pc.ps ||= { on: false, macs: '', mode: 'shutdown' });
        const have = [...macList(ps.macs), ...macList(ps.stickyMacs)].length;
        if (+n < have) return err(`% ${t.name}：已經設定了 ${have} 個安全位址，maximum 不能比它小（先 no switchport port-security mac-address …）`);
        if (+n === 1) delete ps.max; else ps.max = +n;
        return undefined;
      });
    }],
    ['no switchport port-security maximum [...]', () => onL2((pc) => { if (pc.ps) delete pc.ps.max; })],
    // sticky：之後動態學到的安全位址自動寫進 running-config（存檔之後重開機還在）
    ['switchport port-security mac-address sticky', () => onL2((pc) => { (pc.ps ||= { on: false, macs: '', mode: 'shutdown' }).sticky = true; })],
    ['no switchport port-security mac-address sticky', () => onL2((pc) => { if (pc.ps) { delete pc.ps.sticky; delete pc.ps.stickyMacs; } })],
    ['switchport port-security mac-address sticky <mac>', ([mac]) => {
      const m = normMac(mac);
      if (!m) return err('MAC 位址的格式：0011.2233.4455 或 00:11:22:33:44:55');
      return onL2((pc) => { const ps = (pc.ps ||= { on: false, macs: '', mode: 'shutdown' }); const l = macList(ps.stickyMacs); if (!l.includes(m)) l.push(m); ps.stickyMacs = l.join(', '); });
    }],
    ['switchport port-security mac-address <mac>', ([mac]) => {
      const m = normMac(mac);
      if (!m) return err('MAC 位址的格式：0011.2233.4455 或 00:11:22:33:44:55');
      return onL2((pc) => {
        const ps = (pc.ps ||= { on: false, macs: '', mode: 'shutdown' });
        const list = macList(ps.macs);
        if (!list.includes(m)) list.push(m);
        ps.macs = list.join(', ');
      });
    }],
    ['no switchport port-security mac-address <mac>', ([mac]) => {
      const m = normMac(mac);
      return onL2((pc) => { if (!pc.ps) return; pc.ps.macs = macList(pc.ps.macs).filter((x) => x !== m).join(', '); pc.ps.stickyMacs = macList(pc.ps.stickyMacs).filter((x) => x !== m).join(', '); });
    }],
    ['switchport port-security violation <mode>', ([m]) => {
      const mode = ['restrict', 'shutdown', 'protect'].find((x) => x.startsWith(m.toLowerCase()));
      return mode ? onL2((pc) => { (pc.ps ||= { on: false, macs: '', mode: 'shutdown' }).mode = mode; }) : err('模式必須是 protect、restrict 或 shutdown');
    }],
    ['no switchport port-security violation [...]', () => onL2((pc) => { if (pc.ps) pc.ps.mode = 'shutdown'; })],
    // ── Storm Control：broadcast level 是連接埠頻寬的百分比
    ['storm-control broadcast level <pct> [...]', ([p]) => (/^\d+(\.\d+)?$/.test(p) && +p <= 100 ? onL2((pc) => { (pc.storm ||= {}).bcast = +(+p).toFixed(2); }) : err('用法：storm-control broadcast level <0.00-100.00>（連接埠頻寬的百分比）'))],
    ['no storm-control broadcast [...]', () => onL2((pc) => { if (pc.storm) { delete pc.storm.bcast; if (!Object.keys(pc.storm).length) delete pc.storm; } })],
    ['storm-control action <a>', ([a]) => { const v = ['shutdown', 'trap'].find((x) => x.startsWith(a.toLowerCase())); return v ? onL2((pc) => { (pc.storm ||= {}).action = v; }) : err('用法：storm-control action shutdown | trap'); }],
    ['no storm-control action [...]', () => onL2((pc) => { if (pc.storm) { delete pc.storm.action; if (!Object.keys(pc.storm).length) delete pc.storm; } })],
    ['storm-control <...>', () => err('這個模擬的 storm-control 只有 broadcast level 與 action（multicast、unicast 沒有模擬）')],
    // ── Protected port（PVLAN edge）：同一台交換器的 protected 埠彼此不通
    // SVI 的 private-vlan mapping：secondary VLAN 的主機也能用這個 SVI 當閘道
    ['private-vlan mapping <...>', ([list]) => {
      if (!pvlanOk()) return err('% Private VLANs are not supported on this platform');
      const v = parseVlanList(String(list).replace(/^add\s+/i, ''));
      if (!v) return err('用法：private-vlan mapping <secondary 清單>（在 interface vlan <primary> 底下）');
      return each((t) => (t.iface && t.iface.bind.t === 'svi' ? void (t.iface.pvMap = v) : err(`${t.name} 不是 VLAN 介面：private-vlan mapping 要在 interface vlan <primary> 底下`)));
    }],
    ['no private-vlan mapping [...]', () => each((t) => { if (t.iface) delete t.iface.pvMap; })],
    ['switchport protected', () => onL2((pc) => { pc.protected = true; })],
    ['no switchport protected', () => onL2((pc) => { delete pc.protected; })],
    // ── Private VLAN（Catalyst 9300、Nexus）
    ['switchport mode private-vlan <m>', ([m]) => {
      if (!pvlanOk()) return err('% Private VLANs are not supported on this platform（Catalyst 2960 只有 switchport protected）');
      const v = ['host', 'promiscuous'].find((x) => x.startsWith(m.toLowerCase()));
      return v ? onL2((pc) => { pc.mode = v === 'host' ? 'pvlan-host' : 'pvlan-promisc'; }) : err('用法：switchport mode private-vlan host | promiscuous');
    }],
    ['switchport private-vlan host-association <p> <s>', ([p, sec]) => {
      if (!pvlanOk()) return err('% Private VLANs are not supported on this platform');
      return /^\d+$/.test(p) && /^\d+$/.test(sec) ? onL2((pc) => { pc.pvHost = { primary: +p, secondary: +sec }; }) : err('用法：switchport private-vlan host-association <primary> <secondary>');
    }],
    ['switchport private-vlan mapping <p> <...>', ([p, list]) => {
      if (!pvlanOk()) return err('% Private VLANs are not supported on this platform');
      const v = parseVlanList(String(list).replace(/^add\s+/i, ''));
      return /^\d+$/.test(p) && v ? onL2((pc) => { pc.pvMap = { primary: +p, secondaries: v }; }) : err('用法：switchport private-vlan mapping <primary> <secondary 清單>');
    }],
    ['no switchport private-vlan [...]', () => onL2((pc) => { delete pc.pvHost; delete pc.pvMap; })],
    // ── RA Guard
    ['ipv6 nd raguard attach-policy <name>', ([n]) => { if (!(dev().sw.raPolicies || {})[n]) return err(`% Policy ${n} not found（先用 ipv6 nd raguard policy ${n} 建立）`); return onL2((pc) => { pc.raGuard = n; }); }],
    ['no ipv6 nd raguard [...]', () => onL2((pc) => { delete pc.raGuard; })],
    ['spanning-tree portfast [...]', ([opt]) => onL2((pc) => { pc.portfast = !(opt || '').toLowerCase().startsWith('dis'); })],
    ['no spanning-tree portfast', () => onL2((pc) => { delete pc.portfast; })],
    ['spanning-tree bpduguard <x>', ([x]) => onL2((pc) => { pc.bpduguard = 'enable'.startsWith(x.toLowerCase()); })],
    ['no spanning-tree bpduguard [...]', () => onL2((pc) => { pc.bpduguard = false; })],
    // BPDU Filter：這個埠不送也不收 BPDU（等於這個埠沒有 STP）
    ['spanning-tree bpdufilter <x>', ([x]) => { const k = x.toLowerCase(); if (!'enable'.startsWith(k) && !'disable'.startsWith(k)) return err('% 用法：spanning-tree bpdufilter enable | disable'); return onL2((pc) => { pc.bpdufilter = 'enable'.startsWith(k); }); }],
    ['no spanning-tree bpdufilter [...]', () => onL2((pc) => { delete pc.bpdufilter; })],
    // guard root | loop | none：一個埠只能有一種
    ['spanning-tree guard <x>', ([x]) => {
      const k = x.toLowerCase(), w = ['root', 'loop', 'none'].find((o) => o.startsWith(k));
      if (!w) return err('% 用法：spanning-tree guard root | loop | none');
      return onL2((pc) => { pc.rootguard = w === 'root'; if (w === 'loop') pc.loopguard = true; else if (w === 'none') pc.loopguard = false; else delete pc.loopguard; });
    }],
    ['no spanning-tree guard [...]', () => onL2((pc) => { pc.rootguard = false; delete pc.loopguard; })],
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
  /** router bgp 底下的 neighbor 指令：鄰居要先用 remote-as 建立 */
  /** 這台自己的位址（設定的或執行中的） */
  const ownIp = (ip) => dev().ifaces.some((i) => i.ip === ip || (i.rt && i.rt.ip != null && fmtIp(i.rt.ip) === ip));
  function nb(ip, fn) {
    const n = dev().bgp.neighbors.find((x) => x.ip === ip);
    if (!n) return err(`Specify remote-as or peer-group commands first（先下 neighbor ${ip} remote-as <AS>）`);
    fn(n);
    return undefined;
  }
  /**
   * redistribute 的參數：static | connected | bgp <AS> | ospf <程序>，後面可以接 subnets、metric <n>、metric-type 1|2、route-map <名稱>、tag <n>
   * 回傳 { src, as?, metric?, type?, rm?, tag? } 或錯誤
   */
  function redistArgs(src, rest, into) {
    const t = String(rest || '').split(/\s+/).filter(Boolean);
    const S2 = ['static', 'connected', ...(into === 'ospf' ? ['bgp', 'eigrp', 'rip'] : ['ospf'])].find((x) => x.startsWith(String(src).toLowerCase()) && String(src).length >= 2);
    if (!S2) return err(into === 'ospf' ? '用法：redistribute static | connected | rip | bgp <AS> | eigrp <AS> [subnets] [metric <n>] [metric-type 1|2] [route-map <名稱>]' : '用法：redistribute static | connected | ospf <程序> [metric <n>] [route-map <名稱>]');
    const o = { src: S2 };
    let k = 0;
    if (S2 === 'bgp' || S2 === 'ospf' || S2 === 'eigrp') {
      if (!/^\d+$/.test(t[0] || '')) return err(`用法：redistribute ${S2} <${S2 === 'ospf' ? '程序號碼' : 'AS 號碼'}> …`);
      o.as = +t[0]; k = 1;
      if (S2 === 'eigrp' && !(eigrpOn(dev()) && +dev().eigrp.as === o.as)) return err(`% EIGRP process ${o.as} not running（這台的 router eigrp 是 ${eigrpOn(dev()) ? dev().eigrp.as : '還沒有設定'}）`);
      if (S2 === 'bgp' && !(dev().bgp && +dev().bgp.asn === o.as)) return err(`% BGP process ${o.as} not running（這台的 router bgp 是 ${(dev().bgp && dev().bgp.asn) || '還沒有設定'}）`);
    }
    for (; k < t.length; k++) {
      const w = t[k].toLowerCase();
      if (w === 'subnets') continue; // IOS XE 一律包含子網路，會自己補上 subnets
      if (w === 'metric' && /^\d+$/.test(t[k + 1] || '')) { o.metric = +t[++k]; continue; }
      if (w === 'metric-type' && /^[12]$/.test(t[k + 1] || '') && into === 'ospf') { o.type = +t[++k]; continue; }
      if (w === 'route-map' && t[k + 1]) { o.rm = t[++k]; continue; }
      if (w === 'tag' && /^\d+$/.test(t[k + 1] || '') && into === 'ospf') { o.tag = +t[++k]; continue; }
      if (w === 'match' && into === 'bgp') { k = t.length; continue; } // match internal external …：只接受，不改變行為
      return err(`% 看不懂「${t[k]}」：redistribute 後面可以接 ${into === 'ospf' ? 'subnets、metric <n>、metric-type 1|2、tag <n>、' : 'metric <n>、'}route-map <名稱>`);
    }
    if (o.metric != null && into === 'ospf' && !(o.metric >= 0 && o.metric <= 16777214)) return err('% OSPF 的 metric 是 0 – 16777214');
    if (o.type === 2) delete o.type;
    return o;
  }
  const upsertRedist = (list, o) => { const k = list.findIndex((x) => x.src === o.src); if (k >= 0) list[k] = o; else list.push(o); };
  function rm(fn) {
    const e = (dev().routeMaps[S.cur.name] || []).find((x) => x.seq === S.cur.seq);
    if (!e) return err('找不到目前的 route-map');
    fn(e);
    return undefined;
  }
  /** class-map 裡加一條 match */
  function addMatch(r) {
    const m = dev().classMaps[S.cur];
    if (!m.rules.some((x) => same(x, r))) m.rules.push(r);
    return undefined;
  }
  function matchDscp(list) {
    const v = list.split(/\s+/).map(parseDscp);
    if (!v.length || v.some((x) => x == null)) return err('DSCP 可以寫名稱（ef、af41、cs3、default）或數字 0 – 63');
    return addMatch({ t: 'dscp', v });
  }
  /** policy-map 裡進入某個 class */
  function pmClass(name) {
    const d = dev(), pm = d.policyMaps[S.cur.pm];
    if (name !== 'class-default' && !(d.classMaps || {})[name]) return err(`class-map ${name} 不存在（先建立 class-map）`);
    let c = pm.find((x) => x.cls === name);
    if (!c) { c = { cls: name }; if (name === 'class-default') pm.push(c); else { const n = pm.findIndex((x) => x.cls === 'class-default'); if (n < 0) pm.push(c); else pm.splice(n, 0, c); } }
    S.mode = 'pmapc'; S.cur = { pm: S.cur.pm, cls: name };
    return undefined;
  }
  /** ZBF：policy-map type inspect 裡進入某個 class（新的 class 放在 class-default 前面） */
  function zClass(name) {
    const z = dev().zbf, pm = z.pmaps[S.cur.pm];
    if (name !== 'class-default' && !z.cmaps[name]) return err(`class-map type inspect ${name} 不存在（先建立 class-map type inspect）`);
    let c = pm.find((x) => x.cls === name);
    if (!c) { c = { cls: name, act: 'drop' }; const n = pm.findIndex((x) => x.cls === 'class-default'); if (n < 0) pm.push(c); else pm.splice(n, 0, c); }
    S.mode = 'ipmapc'; S.cur = { pm: S.cur.pm, cls: name };
    return undefined;
  }
  function zAct(act, log) {
    const c = dev().zbf.pmaps[S.cur.pm].find((x) => x.cls === S.cur.cls);
    if (!c) return err('找不到目前的 class');
    c.act = act; if (log) c.log = true; else delete c.log;
    return undefined;
  }
  /** ZBF 的設定全部拿掉了：連物件一起移除 */
  function tidyZbf() {
    const z = dev().zbf;
    if (z && !Object.keys(z.zones).length && !Object.keys(z.cmaps).length && !Object.keys(z.pmaps).length && !Object.keys(z.pairs).length) delete dev().zbf;
  }
  function pmSet(fn) {
    const c = dev().policyMaps[S.cur.pm].find((x) => x.cls === S.cur.cls);
    return c ? fn(c) : err('找不到目前的 class');
  }
  function setDscp(v) {
    const n = parseDscp(v);
    return n == null ? err('DSCP 可以寫名稱（ef、af41、cs3、default）或數字 0 – 63') : pmSet((c) => { c.set = { dscp: n }; });
  }
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
  const pvlanOk = () => isCat9300(dev()) || isNexus(dev());
  const needRouting = () => (dev().routing ? null : err('這台是 L2 交換器，沒有路由功能（要讓它能被遠端管理請用 ip default-gateway）'));
  const enter = (mode, cur) => { S.mode = mode; S.cur = cur; };
  // router ospf 模式：目前在設定哪一個程序（全域的放在設備上，router ospf <pid> vrf <名稱> 的放在 d.ospfVrf）
  const ocVrf = () => (S.cur && S.cur.vrf) || '';
  const oc = () => ospfProc(dev(), ocVrf()) || dev();
  const areaOf = (a) => ((oc().ospfAreas ||= {})[+a] ||= {});
  const tidyArea = (a) => { const c = oc(); if (c.ospfAreas && c.ospfAreas[a] && !Object.keys(c.ospfAreas[a]).length) delete c.ospfAreas[a]; if (c.ospfAreas && !Object.keys(c.ospfAreas).length) delete c.ospfAreas; };
  const ifByName = (name) => { const t = resolveIf(dev(), name); return isErr(t) ? t : t.iface || err(`${t.name} 不是第三層介面`); };
  const addUnique = (list, item) => { if (!list.some((x) => same(x, item))) list.push(item); };

  /**
   * ip route 後面的參數：[出口介面] <下一站> [global] [管理距離] [name …] [track …] [permanent]。
   * 回傳 { via, outIf, global, ad, track } 或錯誤。vrf：這條路由放進哪個 VRF（global 只能和 vrf 一起用）
   */
  const ROUTE_USAGE = '用法：ip route [vrf <名稱>] <目的網段> <遮罩> [出口介面] <下一站 IP> [global] [管理距離] [track <物件>]';
  const routeCmd = (net, mask, via, rest, vrf = '') => {
    if (parseIp(net) == null || maskBits(mask) == null) return err(ROUTE_USAGE);
    const w = String(rest || '').split(/\s+/).filter(Boolean);
    let outIf = null;
    if (parseIp(via) == null) {
      // 先寫出口介面、再寫下一站：出口介面可以在別的 VRF（VRF 之間的路由洩漏）。「GigabitEthernet 0/0/1」中間有空白也可以
      if (w[0] && /^\d+\/[\d/.]+$|^\d+$/.test(w[0]) && parseIp(w[0]) == null && !/\d$/.test(via)) via += w.shift();
      const i = ifByName(via);
      if (isErr(i)) return err(`${ROUTE_USAGE}（「${via}」不是 IP 位址，也不是這台的介面）`);
      if (parseIp(w[0] || '') == null && !isTun(i)) return err(`% 寫了出口介面 ${i.label}，後面還要接下一站的 IP（乙太網路介面只寫出口介面要靠 Proxy ARP，這個模擬不支援；點對點的 Tunnel 介面可以只寫介面）`);
      outIf = i.id; via = parseIp(w[0] || '') != null ? w.shift() : '';
    }
    let ad = '', track = null, global = false;
    for (let k = 0; k < w.length; k++) {
      if (/^\d+$/.test(w[k]) && !ad) ad = w[k];
      else if (/^global$/i.test(w[k])) global = true;
      else if (/^track$/i.test(w[k]) && /^\d+$/.test(w[k + 1] || '')) track = +w[++k];
      else if (/^name$/i.test(w[k]) && w[k + 1]) k++;
      else if (/^permanent$/i.test(w[k])) continue;
      else return err(ROUTE_USAGE);
    }
    if (global && !vrf) return err('% global 只能用在 ip route vrf <名稱> …：表示下一站要到全域的路由表找');
    if (global && outIf) return err('% 寫了出口介面就不用再加 global（出口介面本身決定下一站在哪個路由表）');
    if (ad && !(+ad >= 1 && +ad <= 255)) return err('管理距離必須是 1 – 255');
    return { via, outIf, global, ad, track };
  };
  /** 同一條靜態路由（目的網段、遮罩、下一站、出口介面都一樣）：重打一次只更新管理距離與 track */
  const sameRoute = (x, v, net, mask, r) => (x.vrf || '') === v && x.dst === net && parseMask(x.mask || '') === maskBits(mask) && x.via === r.via && (x.outIf || null) === (r.outIf || null) && !!x.global === !!r.global;
  const putRoute = (v, net, mask, r) => {
    const d = dev(), cur = d.routes.find((x) => sameRoute(x, v, net, mask, r));
    const e = cur || { dst: net, mask, via: r.via, ...(v ? { vrf: v } : {}) };
    if (r.outIf) e.outIf = r.outIf; else delete e.outIf;
    if (r.global) e.global = true; else delete e.global;
    e.ad = r.ad || '';
    if (r.track != null) e.track = r.track; else delete e.track;
    if (!cur) d.routes.push(e);
  };
  /** no ip route … 後面的 [出口介面] [下一站]：沒寫下一站就刪掉這個網段所有的靜態路由 */
  const routeHit = (v, net, mask, rest) => {
    const w = String(rest || '').split(/\s+/).filter(Boolean);
    let outIf = null;
    if (w[0] && parseIp(w[0]) == null) { const i = ifByName(w[0]); if (!isErr(i)) { outIf = i.id; w.shift(); } }
    const via = w[0] && parseIp(w[0]) != null ? w[0] : null;
    return (x) => (x.vrf || '') === v && x.dst === net && parseMask(x.mask || '') === maskBits(mask) && (!via || x.via === via) && (!outIf || x.outIf === outIf);
  };
  const CONFIG = [
    ['hostname <name>', ([name]) => { dev().name = name; }],
    ['mls qos', () => { if (dev().kind !== 'mswitch') return err('mls qos 是 Catalyst 2960 這類交換器的指令（路由器用 class-map / policy-map）'); const sw = dev().sw; sw.qos = { ...(sw.qos || {}), on: true }; return '（開了 mls qos 之後，沒有設定 trust 的埠會把收到的 DSCP 與 CoS 全部改成 0）'; }],
    ['no mls qos', () => { const sw = dev().sw; if (sw && sw.qos) { sw.qos.on = false; if (!sw.qos.cosDscp) delete sw.qos; } }],
    ['mls qos map cos-dscp <...>', ([list]) => {
      const v = list.split(/\s+/).map(Number);
      if (v.length !== 8 || v.some((x) => !(x >= 0 && x <= 63))) return err('用法：mls qos map cos-dscp <8 個 DSCP 值>，例如 0 8 16 24 32 46 48 56');
      const sw = dev().sw; if (!sw) return err('這個指令只適用於交換器');
      sw.qos = { ...(sw.qos || { on: false }), cosDscp: v };
      return undefined;
    }],
    ['no mls qos map cos-dscp', () => { const sw = dev().sw; if (sw && sw.qos) delete sw.qos.cosDscp; }],
    // ── Zone-Based Firewall ──
    ['zone security <name>', ([n]) => { const d = dev(); if (d.kind !== 'router') return err('這個模擬的 ZBF 只在路由器上'); if (n === 'self') return err('self 是系統內建的 zone'); (d.zbf ||= newZbf()).zones[n] ||= {}; enter('zone', n); return undefined; }],
    ['no zone security <name>', ([n]) => {
      const d = dev(), z = d.zbf;
      if (!z || !z.zones[n]) return err(`Zone ${n} does not exist`);
      if (d.ifaces.some((i) => i.zone === n)) return err(`Zone ${n} 還有介面（先在介面上 no zone-member security）`);
      if (Object.values(z.pairs).some((p) => p.src === n || p.dst === n)) return err(`Zone ${n} 還被 zone-pair 使用`);
      delete z.zones[n]; tidyZbf(); return undefined;
    }],
    ['class-map type inspect <...>', ([rest]) => {
      const t = rest.split(/\s+/), any = /^match-any$/i.test(t[0]), all = /^match-all$/i.test(t[0]);
      const name = any || all ? t[1] : t[0];
      if (!name) return err('用法：class-map type inspect [match-any | match-all] <名稱>');
      if (dev().kind !== 'router') return err('這個模擬的 ZBF 只在路由器上');
      const m = ((dev().zbf ||= newZbf()).cmaps[name] ||= { any: false, match: [] });
      if (any || all) m.any = any;
      enter('icmap', name);
      return undefined;
    }],
    ['no class-map type inspect <...>', ([rest]) => {
      const name = rest.split(/\s+/).pop(), z = dev().zbf;
      if (!z || !z.cmaps[name]) return err(`class-map ${name} not configured`);
      if (Object.values(z.pmaps).some((pm) => pm.some((c) => c.cls === name))) return err(`Class-map ${name} is being used`);
      delete z.cmaps[name]; tidyZbf(); return undefined;
    }],
    ['policy-map type inspect <name>', ([n]) => {
      if (dev().kind !== 'router') return err('這個模擬的 ZBF 只在路由器上');
      (dev().zbf ||= newZbf()).pmaps[n] ||= [{ cls: 'class-default', act: 'drop' }];
      enter('ipmap', { pm: n });
      return undefined;
    }],
    ['no policy-map type inspect <name>', ([n]) => {
      const z = dev().zbf;
      if (!z || !z.pmaps[n]) return err(`policy-map ${n} not configured`);
      if (Object.values(z.pairs).some((p) => p.policy === n)) return err(`Policy map ${n} is being used by a zone-pair`);
      delete z.pmaps[n]; tidyZbf(); return undefined;
    }],
    ['zone-pair security <name> source <s> destination <d>', ([n, s, t]) => {
      const d = dev(), z = (d.zbf ||= newZbf());
      if (d.kind !== 'router') return err('這個模擬的 ZBF 只在路由器上');
      const ok = (x) => x === 'self' || !!z.zones[x];
      if (!ok(s)) return err(`Zone ${s} does not exist`);
      if (!ok(t)) return err(`Zone ${t} does not exist`);
      if (s === t) return err('來源和目的 zone 不能一樣（同一個 zone 裡的介面本來就互通）');
      const dup = Object.entries(z.pairs).find(([k, p]) => k !== n && p.src === s && p.dst === t);
      if (dup) return err(`zone-pair ${dup[0]} 已經是 ${s} → ${t}`);
      z.pairs[n] = { ...(z.pairs[n] || {}), src: s, dst: t };
      enter('zpair', n);
      return undefined;
    }],
    ['no zone-pair security <name>', ([n]) => { const z = dev().zbf; if (!z || !z.pairs[n]) return err(`Zone-pair ${n} does not exist`); delete z.pairs[n]; tidyZbf(); return undefined; }],
    ['class-map <...>', ([rest]) => {
      const t = rest.split(/\s+/), any = /^match-any$/i.test(t[0]), all = /^match-all$/i.test(t[0]);
      const name = any || all ? t[1] : t[0];
      if (!name) return err('用法：class-map [match-any | match-all] <名稱>');
      if (/^class-default$/i.test(name)) return err('class-default 是內建的，不能重新定義');
      const d = dev(), m = ((d.classMaps ||= {})[name] ||= { any: false, rules: [] });
      if (any || all) m.any = any;
      enter('qcmap', name);
      return undefined;
    }],
    ['no class-map <...>', ([rest]) => { const name = rest.split(/\s+/).pop(); const d = dev(); if (!(d.classMaps || {})[name]) return err(`class-map ${name} not configured`); delete d.classMaps[name]; return undefined; }],
    ['policy-map <name>', ([name]) => { const d = dev(); (d.policyMaps ||= {})[name] ||= []; enter('pmap', { pm: name }); return undefined; }],
    ['no policy-map <name>', ([name]) => {
      const d = dev();
      if (!(d.policyMaps || {})[name]) return err(`policy-map ${name} not configured`);
      if (d.ifaces.some((i) => i.qosIn === name || i.qosOut === name)) return err(`Policy map ${name} is being used（先在介面上 no service-policy）`);
      delete d.policyMaps[name];
      return undefined;
    }],
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
    // Nexus：QSFP 埠拆成 4 個子埠（要放在 interface <名稱> 前面先比對）
    ['interface breakout module <m> port <n> map <map>', ([m, n, map]) => {
      const d = dev();
      if (!isNexus(d)) return err('interface breakout 是 NX-OS 的指令（Nexus 的 QSFP 埠）');
      if (m !== '1') return err('這台只有 module 1');
      if (!BREAKOUT_MAPS[map.toLowerCase()]) return err(`map 要是 ${Object.keys(BREAKOUT_MAPS).join(' 或 ')}`);
      const e = breakoutPort(getState(), d, 'Eth1/' + n, map.toLowerCase());
      return e ? err(e) : undefined;
    }],
    ['no interface breakout module <m> port <n> [...]', ([m, n]) => {
      const d = dev();
      if (!isNexus(d)) return err('interface breakout 是 NX-OS 的指令');
      const e = unbreakoutPort(getState(), d, 'Eth1/' + n);
      return e ? err(e) : undefined;
    }],
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
      const lo = s.match(/^lo[a-z]*(\d+)$/);
      if (lo) d.ifaces = d.ifaces.filter((i) => !(i.bind.t === 'loop' && i.bind.n === +lo[1]));
      const tu = s.match(/^tu[a-z]*(\d+)$/);
      if (tu) {
        const gone = d.ifaces.find((i) => i.bind.t === 'gre' && i.bind.n === +tu[1]);
        d.ifaces = d.ifaces.filter((i) => i !== gone);
        if (gone) d.routes = (d.routes || []).filter((r) => r.outIf !== gone.id);
      }
      return d.ifaces.length < before ? undefined : err('只能刪除子介面、VLAN 介面、Loopback 或 Tunnel，而且它必須存在');
    }],
    ['vlan <id>', ([id]) => {
      const e = needSw(); if (e) return e;
      if (!(+id >= 1 && +id <= 4094) || !/^\d+$/.test(id)) return err('VLAN ID 必須是 1 – 4094');
      if (vtpCapable(dev()) && vtpOf(dev()).mode === 'client' && +id !== 1) return VTP_CLIENT;
      const sw = dev().sw;
      let v = sw.vlans.find((x) => x.id === +id);
      if (!v) { v = { id: +id, name: 'VLAN' + String(+id).padStart(4, '0') }; sw.vlans.push(v); }
      enter('vlan', v);
      return undefined;
    }],
    ['no vlan <id>', ([id]) => {
      const e = needSw(); if (e) return e;
      if (+id === 1) return err('預設的 VLAN 1 不能刪除');
      if (vtpCapable(dev()) && vtpOf(dev()).mode === 'client') return VTP_CLIENT;
      const sw = dev().sw;
      sw.vlans = sw.vlans.filter((x) => x.id !== +id);
      for (const p of Object.values(sw.ports)) { if (p.vlan === +id) p.vlan = 1; if (p.native === +id) p.native = 1; }
      return undefined;
    }],
    ['mac address-table static <mac> vlan <v> <...>', ([mac, v, rest]) => {
      const e0 = needSw(); if (e0) return e0;
      const m = normMac(mac);
      if (!m) return err('MAC 位址的格式：0011.2233.4455');
      if (!/^\d+$/.test(v) || !dev().sw.vlans.some((x) => x.id === +v)) return err(`% VLAN ${v} 不存在`);
      const t = rest.trim().split(/\s+/);
      let e;
      if (/^drop$/i.test(t[0])) e = { mac: m, vlan: +v, drop: true };
      else if (/^interface$/i.test(t[0]) || /^int/i.test(t[0])) {
        const r = resolveIf(dev(), t.slice(1).join(''));
        if (isErr(r) || !r.port) return err('用法：mac address-table static <MAC> vlan <VLAN> interface <介面> | drop');
        e = { mac: m, vlan: +v, port: r.port.id };
      } else return err('用法：mac address-table static <MAC> vlan <VLAN> interface <介面> | drop');
      const sw = dev().sw;
      sw.staticMacs = (sw.staticMacs || []).filter((x) => !(x.mac === m && +x.vlan === +v));
      sw.staticMacs.push(e);
      return undefined;
    }],
    ['no mac address-table static <mac> [...]', ([mac, rest]) => {
      const m = normMac(mac), v = (String(rest || '').match(/vlan\s+(\d+)/i) || [])[1];
      const sw = dev().sw; if (!sw) return err('這個指令只適用於交換器');
      const n = (sw.staticMacs || []).length;
      sw.staticMacs = (sw.staticMacs || []).filter((x) => !(x.mac === m && (!v || +x.vlan === +v)));
      if (!sw.staticMacs.length) delete sw.staticMacs;
      return (sw.staticMacs || []).length < n ? undefined : err('沒有這一筆靜態 MAC');
    }],
    // ── VTP ──
    ['vtp mode <m>', ([m], out) => {
      const e0 = needSw(); if (e0) return e0;
      if (!vtpCapable(dev())) return err('這台交換器沒有 VTP');
      const k = ['server', 'client', 'transparent', 'off'].find((x) => x.startsWith(String(m).toLowerCase()));
      if (!k) return err('用法：vtp mode server | client | transparent | off');
      const name = { server: 'Server', client: 'Client', transparent: 'Transparent', off: 'Off' }[k];
      if (vtpOf(dev()).mode === k) { out.push(`Device mode already VTP ${name} for VLANS.`); return undefined; }
      vtpSet(dev(), { mode: k });
      out.push(`Setting device to VTP ${name} mode for VLANS.`);
      return undefined;
    }],
    ['vtp domain <name>', ([n], out) => {
      const e0 = needSw(); if (e0) return e0;
      if (!vtpCapable(dev())) return err('這台交換器沒有 VTP');
      if (n.length > 32) return err('VTP 網域名稱最長 32 個字元');
      const old = vtpOf(dev()).domain;
      if (old === n) { out.push(`Domain name already set to ${n}.`); return undefined; }
      vtpSet(dev(), { domain: n });
      out.push(`Changing VTP domain name from ${old || 'NULL'} to ${n}`);
      return undefined;
    }],
    ['vtp password <pw>', ([p], out) => {
      const e0 = needSw(); if (e0) return e0;
      if (!vtpCapable(dev())) return err('這台交換器沒有 VTP');
      if (p.length > 64) return err('VTP 密碼最長 64 個字元');
      vtpSet(dev(), { pass: p });
      out.push(`Setting device VTP password to ${p}`);
      return undefined;
    }],
    ['no vtp password', (args, out) => { if (!vtpCapable(dev())) return err('這台交換器沒有 VTP'); vtpSet(dev(), { pass: '' }); out.push('Clearing device VTP password.'); return undefined; }],
    ['vtp version <n>', ([n]) => {
      const e0 = needSw(); if (e0) return e0;
      if (!vtpCapable(dev())) return err('這台交換器沒有 VTP');
      if (n === '3') return err('VTP 版本 3 這個模擬還沒有（只有 1 和 2）');
      if (n !== '1' && n !== '2') return err('用法：vtp version 1 | 2');
      vtpSet(dev(), { ver: +n });
      return undefined;
    }],
    ['vlan dot1q tag native', () => { const e0 = needSw(); if (e0) return e0; dev().sw.tagNative = true; return undefined; }],
    ['no vlan dot1q tag native', () => { if (dev().sw) delete dev().sw.tagNative; }],
    ['ipv6 nd raguard policy <name>', ([n]) => { const e0 = needSw(); if (e0) return e0; ((dev().sw.raPolicies ||= {})[n] ||= { role: 'host' }); enter('raguard', n); return undefined; }],
    ['no ipv6 nd raguard policy <name>', ([n]) => { const sw = dev().sw; if (!sw || !(sw.raPolicies || {})[n]) return err(`% Policy ${n} not found`); delete sw.raPolicies[n]; for (const pc of Object.values(sw.ports)) if (pc.raGuard === n) delete pc.raGuard; return undefined; }],
    ['ip routing', () => needRouting() || undefined],
    ['ipv6 unicast-routing', () => { if (dev().kind !== 'router') return err('這個模擬只有路由器支援 IPv6 路由'); dev().v6routing = true; return undefined; }],
    ['no ipv6 unicast-routing', () => { dev().v6routing = false; }],
    ['ipv6 router ospf <pid>', () => {
      const d = dev();
      if (d.kind !== 'router') return err('這個模擬只有路由器支援 OSPFv3');
      if (!d.v6routing) return err('% IPv6 routing not enabled（先下 ipv6 unicast-routing）');
      d.ospf6 ||= {};
      enter('ospf6', null);
      return undefined;
    }],
    ['no ipv6 router ospf <pid>', () => { const d = dev(); delete d.ospf6; for (const i of d.ifaces) delete i.ospf6Area; }],
    ['ipv6 dhcp pool <name>', ([name]) => {
      const d = dev();
      if (d.kind !== 'router') return err('這個模擬只有路由器能當 DHCPv6 伺服器');
      ((d.dhcp6Pools ||= {})[name] ||= { prefix: '', dns: [], domain: '' });
      enter('dhcp6', name);
      return undefined;
    }],
    ['no ipv6 dhcp pool <name>', ([name]) => { const d = dev(); if (!(d.dhcp6Pools || {})[name]) return err('沒有這個 DHCPv6 位址池'); delete d.dhcp6Pools[name]; return undefined; }],
    ['ipv6 access-list <name>', ([name]) => {
      const d = dev();
      if (d.kind !== 'router') return err('這個模擬只有路由器支援 IPv6 ACL');
      ((d.acl6 ||= {})[name] ||= []);
      enter('acl6', name);
      return undefined;
    }],
    ['no ipv6 access-list <name>', ([name]) => { const d = dev(); if (!(d.acl6 || {})[name]) return err('沒有這個 IPv6 ACL'); delete d.acl6[name]; return undefined; }],
    ['ip default-gateway <ip>', ([ip]) => {
      const mg = dev().ifaces.find((x) => x.id === 'mgmt');
      if (!mg) return err('有路由功能的設備請用 ip route 0.0.0.0 0.0.0.0 <下一站>');
      if (parseIp(ip) == null) return err('IP 位址的格式不正確');
      mg.gateway = ip;
      return undefined;
    }],
    ['no ip default-gateway [...]', () => { const mg = dev().ifaces.find((x) => x.id === 'mgmt'); if (mg) mg.gateway = ''; }],
    // ip route vrf … 要排在一般的 ip route 前面，不然「vrf」會被當成目的網段
    ['ip route vrf <v> <net> <mask> <via> [...]', ([v, net, mask, via, rest]) => {
      const e0 = needRouting(); if (e0) return e0;
      if (!(dev().vrfs || {})[v]) return err(`% VRF ${v} not configured.`);
      const r = routeCmd(net, mask, via, rest, v);
      if (isErr(r)) return r;
      putRoute(v, net, mask, r);
      return undefined;
    }],
    ['no ip route vrf <v> <net> <mask> [...]', ([v, net, mask, rest]) => {
      const d = dev(), n = d.routes.length, hit = routeHit(v, net, mask, rest);
      d.routes = d.routes.filter((x) => !hit(x));
      return d.routes.length < n ? undefined : err('路由表裡沒有這一筆靜態路由');
    }],
    ['ip route <net> <mask> <via> [...]', ([net, mask, via, rest]) => {
      const e = needRouting(); if (e) return e;
      // 後面可以接：管理距離、name <名稱>、track <物件編號>、permanent；下一站前面可以先寫出口介面
      const rc = routeCmd(net, mask, via, rest);
      if (isErr(rc)) return rc;
      putRoute('', net, mask, rc);
      return undefined;
    }],
    ['vrf definition <v>', ([v]) => {
      const e = needRouting(); if (e) return e;
      const vs = (dev().vrfs ||= {});
      if (vs[v] && vs[v].style !== 'def') return err(`% ${v} 已經用 ip vrf 建立了`);
      vs[v] ||= { style: 'def' };
      enter('vrfdef', v);
      return undefined;
    }],
    ['ip vrf <v>', ([v]) => {
      const e = needRouting(); if (e) return e;
      if (/^forwarding$/i.test(v)) return err('ip vrf forwarding 是介面模式的指令');
      const vs = (dev().vrfs ||= {});
      if (vs[v] && vs[v].style !== 'ip') return err(`% ${v} 已經用 vrf definition 建立了`);
      vs[v] ||= { style: 'ip', af4: true };
      enter('ipvrf', v);
      return undefined;
    }],
    ...['no vrf definition <v>', 'no ip vrf <v>'].map((pat) => [pat, ([v]) => {
      const d = dev();
      if (!(d.vrfs || {})[v]) return err(`% VRF ${v} not configured.`);
      const n = d.ifaces.filter((i) => i.vrf === v);
      for (const i of n) { delete i.vrf; Object.assign(i, { ip: '', mask: '' }); }
      d.routes = d.routes.filter((r) => r.vrf !== v);
      if (d.ospfVrf && d.ospfVrf[v]) { delete d.ospfVrf[v]; if (!Object.keys(d.ospfVrf).length) delete d.ospfVrf; } // 那個 VRF 的 OSPF 程序也一起刪掉
      delete d.vrfs[v];
      if (!Object.keys(d.vrfs).length) delete d.vrfs;
      return n.length ? `% IPv4 addresses from all interfaces in VRF ${v} have been removed` : undefined;
    }]),
    ['no ip route <net> <mask> [...]', ([net, mask, rest]) => {
      const d = dev(), n = d.routes.length;
      const hit = routeHit('', net, mask, rest);
      const via = (String(rest || '').split(/\s+/).find((x) => parseIp(x) != null)) || null;
      d.routes = d.routes.filter((r) => !hit(r));
      let gw = false;
      if (parseIp(net) === 0 && maskBits(mask) === 0) for (const i of d.ifaces) if (i.gateway && (!via || i.gateway === via)) { i.gateway = ''; gw = true; }
      return d.routes.length < n || gw ? undefined : err('路由表裡沒有這一筆靜態路由');
    }],
    ['ipv6 route <prefix> <a> [...]', ([prefix, a, rest]) => {
      const d = dev();
      if (!d.routes6) return err('這個模擬只有路由器支援 IPv6 路由');
      const t = (rest || '').split(/\s+/).filter(Boolean);
      // ipv6 route ::/0 Gi0/0/1 FE80::1 [AD]：下一站是 link-local 時要寫出口介面
      let via = a, ad = t[0];
      if (parseIp6(a) == null) {
        const i = ifByName(a);
        if (isErr(i)) return err('用法：ipv6 route <前綴/長度> <下一站> [管理距離]，或 ipv6 route <前綴/長度> <出口介面> <link-local 下一站>');
        via = t[0]; ad = t[1];
        if (parseIp6(via || '') == null) return err('寫了出口介面，後面要接下一站的位址（通常是對方的 link-local，例如 FE80::2）');
      } else if (isLinkLocal(parseIp6(a))) return err('下一站是 link-local 位址時要指定出口介面：ipv6 route <前綴> <介面> <FE80::…>');
      if (parseCidr6(prefix) == null) return err('用法：ipv6 route <前綴/長度> <下一站>');
      if (ad != null && !(+ad >= 1 && +ad <= 254)) return err('管理距離必須是 1 – 254');
      const cur = d.routes6.find((r) => r.dst === prefix && r.via === via);
      if (cur) { if (ad) cur.ad = +ad; else delete cur.ad; } else d.routes6.push({ dst: prefix, via, ...(ad ? { ad: +ad } : {}), ...(parseIp6(a) == null ? { dev: ifByName(a).label } : {}) });
      return undefined;
    }],
    ['no ipv6 route <prefix> [...]', ([prefix, rest]) => {
      const d = dev(), want = parseCidr6(prefix);
      if (!d.routes6 || !want) return err('用法：no ipv6 route <前綴/長度> [下一站]');
      const via = (rest || '').split(/\s+/).map(parseIp6).find((x) => x != null);
      const n = d.routes6.length;
      d.routes6 = d.routes6.filter((r) => { const c = parseCidr6(r.dst); return !(c && c.ip === want.ip && c.bits === want.bits && (via == null || parseIp6(r.via) === via)); });
      return d.routes6.length < n ? undefined : err('沒有這一筆 IPv6 靜態路由');
    }],
    ['router bgp <asn>', ([asn]) => {
      const d = dev();
      if (!d.routing || d.kind !== 'router') return err('這個模擬只有路由器能跑 BGP');
      if (!(+asn >= 1 && +asn <= 4294967295)) return err('AS 號碼的範圍是 1 – 4294967295');
      if (d.bgp && d.bgp.asn && +d.bgp.asn !== +asn) return err(`BGP is already running; AS is ${d.bgp.asn}`);
      d.bgp ||= { asn: +asn, neighbors: [], networks: [] };
      d.bgp.asn = +asn;
      enter('bgp', null);
      return undefined;
    }],
    ['no router bgp <asn>', () => { delete dev().bgp; }],
    ['ip prefix-list <name> <...>', ([name, rest]) => {
      const t = rest.toLowerCase().split(/\s+/);
      let k = 0, seq = null;
      if (t[0] === 'seq') { seq = +t[1]; k = 2; }
      const action = ['permit', 'deny'].find((x) => x === t[k]);
      const m = (t[k + 1] || '').match(/^([\d.]+)\/(\d+)$/), ip = m && parseIp(m[1]);
      if (!action || ip == null || +m[2] > 32) return err('用法：ip prefix-list <名稱> [seq 5] permit | deny <網段/長度> [ge n] [le n]');
      const e = { action, net: netOf(ip, +m[2]), bits: +m[2] };
      for (let n = k + 2; n < t.length; n += 2) { if (t[n] === 'ge') e.ge = +t[n + 1]; if (t[n] === 'le') e.le = +t[n + 1]; }
      const list = ((dev().prefixLists ||= {})[name] ||= []);
      e.seq = seq ?? (list.reduce((a, x) => Math.max(a, x.seq), 0) + 5);
      const n2 = list.findIndex((x) => x.seq === e.seq);
      if (n2 >= 0) list[n2] = e; else list.push(e);
      return undefined;
    }],
    ['no ip prefix-list <name> [...]', ([name]) => { const d = dev(); if (!(d.prefixLists || {})[name]) return err(`prefix-list ${name} 不存在`); delete d.prefixLists[name]; return undefined; }],
    ['ip bgp-community new-format', () => { dev().commNewFormat = true; }],
    ['no ip bgp-community new-format', () => { delete dev().commNewFormat; }],
    ['ip community-list <...>', ([rest]) => {
      // ip community-list <1-99> permit|deny <值…>，或 ip community-list standard <名稱> permit|deny <值…>
      const t = rest.split(/\s+/);
      let name = t.shift();
      if (/^standard$/i.test(name)) name = t.shift();
      else if (/^expanded$/i.test(name)) return err('這個模擬只支援 standard 的 community-list');
      else if (!/^\d+$/.test(name) || +name < 1 || +name > 99) return err('用法：ip community-list <1-99> permit | deny <AA:NN …>，或 ip community-list standard <名稱> permit | deny <AA:NN …>');
      const action = (t.shift() || '').toLowerCase();
      if (!['permit', 'deny'].includes(action) || !t.length || t.some((x) => parseComm(x) == null)) return err('用法：ip community-list standard <名稱> permit | deny <AA:NN | no-export | internet …>');
      ((dev().commLists ||= {})[name] ||= []).push({ action, values: t.map((x) => x.toLowerCase()) });
      return undefined;
    }],
    ['no ip community-list <...>', ([rest]) => { const t = rest.split(/\s+/); const name = /^standard$/i.test(t[0]) ? t[1] : t[0]; const d = dev(); if (!(d.commLists || {})[name]) return err(`community-list ${name} 不存在`); delete d.commLists[name]; return undefined; }],
    ['ip as-path access-list <n> <action> <...>', ([n, action, re]) => {
      const a = ['permit', 'deny'].find((x) => x.startsWith(action.toLowerCase()));
      if (!/^\d+$/.test(n) || !a) return err('用法：ip as-path access-list <1-500> permit | deny <正規表示式>，例如 ^$');
      try { new RegExp(re.replace(/_/g, ' ')); } catch { return err('正規表示式的格式不正確'); }
      ((dev().asPathAcl ||= {})[n] ||= []).push({ action: a, re });
      return undefined;
    }],
    ['no ip as-path access-list <n>', ([n]) => { const d = dev(); if (d.asPathAcl) delete d.asPathAcl[n]; }],
    ['ip local policy route-map <name>', ([name]) => { const e = needRouting(); if (e) return e; dev().localPolicy = name; return undefined; }],
    ['no ip local policy route-map [...]', () => { delete dev().localPolicy; }],
    ['route-map <name> [...]', ([name, rest]) => {
      const t = (rest || '').toLowerCase().split(/\s+/).filter(Boolean);
      const action = ['permit', 'deny'].find((x) => x === t[0]) || 'permit';
      const seq = +(t[action === t[0] ? 1 : 0] || 10) || 10;
      const list = ((dev().routeMaps ||= {})[name] ||= []);
      let e = list.find((x) => x.seq === seq);
      if (!e) { e = { seq, action, match: {}, set: {} }; list.push(e); list.sort((a, b) => a.seq - b.seq); }
      e.action = action;
      enter('rmap', { name, seq });
      return undefined;
    }],
    ['no route-map <name> [...]', ([name]) => { const d = dev(); if (!(d.routeMaps || {})[name]) return err(`route-map ${name} 不存在`); delete d.routeMaps[name]; return undefined; }],
    // router ospf <pid> vrf <名稱>：這個 VRF 自己的 OSPF 程序（只涵蓋這個 VRF 的介面，路由裝進這個 VRF 的路由表）
    ['router ospf <pid> vrf <v>', ([pid, v]) => {
      const d = dev();
      if (!('ospfDefault' in d)) return err('這台設備不支援 OSPF');
      if (!/^\d+$/.test(pid) || !(+pid >= 1 && +pid <= 65535)) return err('程序編號的範圍是 1 – 65535');
      if (!(d.vrfs || {})[v]) return err(`% VRF ${v} not configured.（先用 vrf definition ${v} 建立）`);
      if (+pid === 1) return err('% OSPF: 程序 1 是全域路由表的 OSPF 程序：每個 VRF 要用自己的程序編號，例如 router ospf 2 vrf ' + v);
      const other = Object.entries(d.ospfVrf || {}).find(([n, c]) => n !== v && +c.pid === +pid);
      if (other) return err(`% OSPF: process ${pid} is already in use by VRF ${other[0]}`);
      const cur = (d.ospfVrf || {})[v];
      if (cur && +cur.pid !== +pid) return err(`% VRF ${v} 已經有 OSPF 程序 ${cur.pid} 了（一個 VRF 只跑一個 OSPF 程序；要換編號先 no router ospf ${cur.pid}）`);
      ((d.ospfVrf ||= {})[v] ||= { pid: +pid, ospfNets: [] });
      enter('router', { vrf: v });
      return undefined;
    }],
    // ── EIGRP（傳統模式） ──
    ['router eigrp <as>', ([as]) => {
      const d = dev();
      if (!('ospfDefault' in d)) return err('這台設備不支援 EIGRP');
      if (!/^\d+$/.test(as) || +as < 1 || +as > 65535) return err('AS 號碼是 1 – 65535');
      if (eigrpOn(d) && +d.eigrp.as !== +as) return err(`% 這台已經在跑 EIGRP AS ${d.eigrp.as}（這個模擬一台只跑一個 EIGRP 程序；要換先 no router eigrp ${d.eigrp.as}）`);
      d.eigrp ||= { as: +as, nets: [] };
      enter('eigrp', null);
      return undefined;
    }],
    ['no router eigrp <as>', ([as]) => { const d = dev(); if (!eigrpOn(d) || +d.eigrp.as !== +as) return err(`% EIGRP AS ${as} 沒有在執行`); delete d.eigrp; return undefined; }],
    // ── 時間型 ACL ──
    ['time-range <name>', ([n]) => { const d = dev(); ((d.timeRanges ||= {})[n] ||= []); enter('trange', n); return undefined; }],
    ['no time-range <name>', ([n]) => { const d = dev(); if (!(d.timeRanges || {})[n]) return err(`% time-range ${n} 不存在`); delete d.timeRanges[n]; if (!Object.keys(d.timeRanges).length) delete d.timeRanges; return undefined; }],
    // ── RIP ──
    ['router rip', () => {
      const d = dev();
      if (!('ospfDefault' in d)) return err('這台設備不支援 RIP');
      d.rip ||= { nets: [] };
      enter('rip', null);
      return undefined;
    }],
    ['no router rip', () => { const d = dev(); if (!d.rip) return err('% RIP 沒有在執行'); delete d.rip; return undefined; }],
    ['key chain <name>', ([n]) => { const d = dev(); ((d.keyChains ||= {})[n] ||= []); enter('keychain', n); return undefined; }],
    ['no key chain <name>', ([n]) => { const d = dev(); if (!(d.keyChains || {})[n]) return err(`% key chain ${n} 不存在`); delete d.keyChains[n]; if (!Object.keys(d.keyChains).length) delete d.keyChains; return undefined; }],
    ['router ospf <pid>', ([pid]) => {
      const d = dev();
      if (!('ospfDefault' in d)) return err('這台設備不支援 OSPF');
      // 已經是某個 VRF 的程序：不用再寫 vrf 就能回到它
      const inVrf = Object.entries(d.ospfVrf || {}).find(([, c]) => +c.pid === +pid);
      enter('router', inVrf ? { vrf: inVrf[0] } : null);
      return undefined;
    }],
    ['no router ospf <pid> [...]', ([pid]) => {
      const d = dev();
      const inVrf = Object.entries(d.ospfVrf || {}).find(([, c]) => +c.pid === +pid);
      if (inVrf) {
        const [v] = inVrf;
        for (const i of d.ifaces) if (i.vrf === v) { i.ospf = false; delete i.ospfArea; }
        delete d.ospfVrf[v];
        if (!Object.keys(d.ospfVrf).length) delete d.ospfVrf;
        return undefined;
      }
      for (const i of d.ifaces) if (!i.vrf) i.ospf = false;
      d.ospfDefault = false; d.ospfNets = [];
      for (const k of ['ospfRedist', 'ospfRid', 'ospfAreas', 'ospfRanges', 'ospfAreaAuth', 'ospfPassive', 'ospfPassiveDefault', 'ospfNoPassive', 'ospfRefBw', 'ospfMaxPaths']) delete d[k];
      return undefined;
    }],
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
    ['system mtu jumbo <n>', ([n]) => {
      const d = dev();
      if (!isCat2960(d)) return err(isCat9300(d) ? '% Catalyst 9300 沒有 jumbo 的分別：用 system mtu <1500-9198>' : isNexus(d) ? '% Nexus 在每個介面上設定：interface ethernet1/1 → mtu 9216' : '% 這台設備沒有這個指令');
      if (!/^\d+$/.test(n) || +n < 1500 || +n > 9000) return err('% system mtu jumbo 的範圍是 1500 – 9000');
      if (+n === 1500) delete d.sw.jumbo; else d.sw.jumbo = +n;
      return 'Changes to the system jumbo MTU will not take effect until the next reload is done（先 write memory 再 reload，show system mtu 看得到現在與下次開機的值）';
    }],
    ['no system mtu jumbo', () => { const d = dev(); if (!isCat2960(d)) return err('% 這台設備沒有這個指令'); delete d.sw.jumbo; return 'Changes to the system jumbo MTU will not take effect until the next reload is done'; }],
    ['system mtu <n>', ([n]) => {
      const d = dev();
      if (isCat2960(d)) return err('% system mtu 只影響 10/100 的埠；這台 2960-CX 都是 Gigabit 埠，要用 system mtu jumbo <1500-9000>');
      if (!isCat9300(d)) return err(isNexus(d) ? '% Nexus 在每個介面上設定：interface ethernet1/1 → mtu 9216' : '% 這台設備沒有 system mtu：路由器在介面上用 mtu / ip mtu');
      if (!/^\d+$/.test(n) || +n < 1500 || +n > 9198) return err('% system mtu 的範圍是 1500 – 9198');
      if (+n === 1500) delete d.sw.sysMtu; else d.sw.sysMtu = +n;
      for (const i of d.ifaces) if (+i.mtu > (+d.sw.sysMtu || 1500)) delete i.mtu;
      return `Global Ethernet MTU is set to ${+n} bytes.`;
    }],
    ['no system mtu', () => { const d = dev(); if (!isCat9300(d)) return err('% 這台設備沒有 system mtu'); delete d.sw.sysMtu; for (const i of d.ifaces) if (+i.mtu > 1500) delete i.mtu; return 'Global Ethernet MTU is set to 1500 bytes.'; }],
    ['spanning-tree mode <m>', ([m]) => {
      const e = needSw(); if (e) return e;
      const v = String(m).toLowerCase();
      if (!['pvst', 'rapid-pvst', 'mst'].some((x) => x.startsWith(v))) return err('spanning-tree mode pvst | rapid-pvst | mst');
      const s = (dev().sw.stp ||= {});
      if ('mst'.startsWith(v)) s.mode = 'mst'; else delete s.mode;
      return undefined;
    }],
    ['spanning-tree mst configuration', () => { const e = needSw(); if (e) return e; const s = (dev().sw.stp ||= {}); s.mst ||= {}; enter('mstcfg', null); return undefined; }],
    ['spanning-tree mst <id> priority <n>', ([id, n]) => {
      const e = needSw(); if (e) return e;
      if (!/^\d+$/.test(id) || +id > 4094) return err('MST instance 是 0 – 4094');
      if (!/^\d+$/.test(n) || +n > 61440 || +n % 4096) return err('priority 必須是 4096 的倍數（0、4096、8192 … 61440）');
      const m = ((dev().sw.stp ||= {}).mst ||= {});
      (m.prio ||= {})[+id] = +n;
      return undefined;
    }],
    ['spanning-tree mst <id> root <which>', ([id, w]) => {
      const e = needSw(); if (e) return e;
      const m = ((dev().sw.stp ||= {}).mst ||= {});
      (m.prio ||= {})[+id] = 'primary'.startsWith(w.toLowerCase()) ? 24576 : 28672;
      return undefined;
    }],
    ['no spanning-tree mst <id> priority', ([id]) => { const m = ((dev().sw.stp || {}).mst || {}); if (m.prio) delete m.prio[+id]; return undefined; }],
    ['spanning-tree portfast default', () => needSw() || void ((dev().sw.stp ||= {}).portfastDefault = true)],
    ['no spanning-tree portfast default', () => needSw() || void ((dev().sw.stp ||= {}).portfastDefault = false)],
    // PortFast 的埠（接終端設備）預設開 BPDU Guard / BPDU Filter；Loop Guard 套在交換器之間的點對點線
    ['spanning-tree portfast bpduguard default', () => needSw() || void ((dev().sw.stp ||= {}).bpduguardDefault = true)],
    ['no spanning-tree portfast bpduguard default', () => needSw() || void ((dev().sw.stp ||= {}).bpduguardDefault = false)],
    ['spanning-tree portfast bpdufilter default', () => needSw() || void ((dev().sw.stp ||= {}).bpdufilterDefault = true)],
    ['no spanning-tree portfast bpdufilter default', () => needSw() || void ((dev().sw.stp ||= {}).bpdufilterDefault = false)],
    ['spanning-tree loopguard default', () => needSw() || void ((dev().sw.stp ||= {}).loopguardDefault = true)],
    ['no spanning-tree loopguard default', () => needSw() || void ((dev().sw.stp ||= {}).loopguardDefault = false)],
    // 每個 VLAN 各自的優先權（Rapid PVST+）；1-4094 就是全部的 VLAN
    ['spanning-tree vlan <list> priority <n>', ([list, n]) => {
      const e = needSw(); if (e) return e;
      if (!/^\d+$/.test(n) || +n > 61440 || +n % 4096) return err('priority 必須是 4096 的倍數（0、4096、8192 … 61440）');
      return setVlanPrio(list, +n);
    }],
    ['spanning-tree vlan <list> root <which>', ([list, w]) => {
      const e = needSw(); if (e) return e;
      if (!'primary'.startsWith(w.toLowerCase())) return setVlanPrio(list, 28672);
      // root primary 是巨集：設成 24576；現在的根橋比 24576 還小的話，設成比它再小 4096
      const nums = vlanNums(list);
      if (!nums) return err('VLAN 清單的格式：10,20 或 10-20 或 1-4094');
      const st = getState(), d = dev(), rs = (d.rt && d.rt.stp) || {};
      const want = (v) => {
        const r = st && st.devices[(rs.root || {})[v]];
        const rp = r && r !== d && r.rt && r.rt.stp ? ((r.rt.stp.vp || {})[v] ?? r.rt.stp.prio) : null;
        return rp != null && rp <= 24576 ? Math.max(0, rp - 4096) : 24576;
      };
      if (nums === 'all') return setVlanPrio(list, Math.min(...Object.keys(rs.root || { 1: 1 }).map(want)));
      for (const v of nums) { const r = setVlanPrio(String(v), want(v)); if (r) return r; }
      return undefined;
    }],
    ['no spanning-tree vlan <list> priority', ([list]) => needSw() || setVlanPrio(list, null)],
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
    ['ip nat source list <acl> interface <if> [...]', ([acl, name]) => {
      const i = ifByName(name); if (isErr(i)) return i;
      dev().nviSrc = { acl: acl === '1' && !(dev().aclDefs || {})['1'] ? '' : acl.toUpperCase(), iface: i.id };
      return i.nvi ? undefined : `（NVI：${i.label} 與 inside 的介面都要 ip nat enable 才會轉換）`;
    }],
    ['no ip nat source list [...]', () => { delete dev().nviSrc; }],
    ['ip nat source static <priv> <pub>', ([priv, pub]) => {
      const d = dev();
      if (!d.staticNat) return err('這台設備不支援靜態 NAT');
      if (parseIp(priv) == null || parseIp(pub) == null) return err('用法：ip nat source static <內部 IP> <公用 IP>');
      addUnique(d.staticNat, { pub, priv, nvi: true });
      return undefined;
    }],
    ['no ip nat source static <priv> <pub>', ([priv, pub]) => { const d = dev(); if (d.staticNat) d.staticNat = d.staticNat.filter((n) => !(n.nvi && n.priv === priv && n.pub === pub)); }],
    ['no ip nat inside source list <acl> interface <if> [...]', ([, name]) => { const i = ifByName(name); if (isErr(i)) return i; syncNat(); i.natRule = false; setNat(i); return undefined; }],
    ['ip nat pool <name> <start> <end> <...>', ([name, a, b, rest]) => {
      const d = dev();
      if (!d.portForwards) return err('這台設備不支援 NAT');
      const t = String(rest || '').trim().split(/\s+/), s = parseIp(a), e = parseIp(b);
      const bits = t[0] === 'netmask' ? parseMask(t[1] || '') : t[0] === 'prefix-length' && /^\d+$/.test(t[1] || '') && +t[1] <= 32 ? +t[1] : null;
      if (s == null || e == null || bits == null) return err('用法：ip nat pool <名稱> <起始 IP> <結束 IP> netmask <遮罩> | prefix-length <長度>');
      if ((s >>> 0) > (e >>> 0)) return err('%End address less than start address');
      if (netOf(s, bits) !== netOf(e, bits)) return err('%Start and end addresses on different subnets');
      (d.natPools ||= {})[name] = { start: a, end: b, bits };
      return undefined;
    }],
    ['no ip nat pool <name>', ([name]) => {
      const d = dev();
      if (!(d.natPools || {})[name]) return err(`%Pool ${name} not found`);
      if ((d.natPoolRules || []).some((r) => r.pool === name)) return err(`%Pool ${name} in use, cannot destroy`);
      delete d.natPools[name];
      if (!Object.keys(d.natPools).length) delete d.natPools;
      return undefined;
    }],
    ['ip nat inside source list <acl> pool <name> [...]', ([acl, name, rest]) => {
      const d = dev();
      if (!d.portForwards) return err('這台設備不支援 NAT');
      const ov = /^overload$/i.test(String(rest || '').trim());
      if (rest && !ov) return err('用法：ip nat inside source list <ACL> pool <名稱> [overload]');
      const old = (d.natPoolRules || []).find((r) => r.acl === acl.toUpperCase());
      if (old && (old.pool !== name || !!old.overload !== ov) && natInUse(d, old.pool)) return err('%Dynamic mapping in use, cannot change（這條規則還有轉換在用：先 clear ip nat translation *）');
      d.natPoolRules =[...(d.natPoolRules || []).filter((r) => r.acl !== acl.toUpperCase()), { acl: acl.toUpperCase(), pool: name, ...(ov ? { overload: true } : {}) }];
      const notes = [];
      if (!(d.natPools || {})[name]) notes.push(`位址池 ${name} 還不存在（ip nat pool ${name} …）`);
      if (!d.ifaces.some((i) => i.natOut)) notes.push('還沒有介面設 ip nat outside');
      return notes.length ? `（${notes.join('；')}：在那之前不會轉換）` : undefined;
    }],
    ['no ip nat inside source list <acl> pool <name> [...]', ([acl]) => {
      const d = dev(), n = (d.natPoolRules || []).length, old = (d.natPoolRules || []).find((r) => r.acl === acl.toUpperCase());
      if (old && natInUse(d, old.pool)) return err('%Dynamic mapping in use, do you want to delete all entries? [no]: （這個模擬請先 clear ip nat translation *，再刪掉規則）');
      d.natPoolRules =(d.natPoolRules || []).filter((r) => r.acl !== acl.toUpperCase());
      if (!d.natPoolRules.length) delete d.natPoolRules;
      return (d.natPoolRules || []).length < n ? undefined : err('%Dynamic mapping not found');
    }],
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
      if (rule && rule.reflect) return err('% Reflexive ACL（reflect）只能寫在具名的延伸 ACL：ip access-list extended <名稱>');
      if (!rule) return err(+n < 100 ? '用法：access-list <1-99> permit|deny <any | host IP | 網段 萬用遮罩>' : '用法：access-list <100-199> permit|deny <ip|tcp|udp|icmp|esp|gre> <來源> <目的> [eq <埠>]');
      if (n === '1' && !(d.aclDefs || {})['1'] && same(rule, { action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: '' })) return undefined; // 預設的 NAT 清單
      addUnique(((d.aclDefs ||= {})[n] ||= []), rule);
      syncVpnAcl(d, n);
      return undefined;
    }],
    ['no access-list <n>', ([n]) => { const d = dev(); if (d.aclDefs) delete d.aclDefs[n]; }],
    // Reflexive ACL 暫時規則的預設逾時（每一條 reflect 也可以自己寫 timeout）
    ['ip reflexive-list timeout <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 ? void (dev().reflexTimeout = +n) : err('% 用法：ip reflexive-list timeout <秒>（預設 300）'))],
    ['no ip reflexive-list timeout [...]', () => { delete dev().reflexTimeout; }],
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
    // 設定封存
    ['archive', () => { const d = dev(); if (!d.mgmt) return err('這台設備不支援'); d.archive ||= {}; enter('archive', null); return undefined; }],
    ['no archive', () => { delete dev().archive; }],
    // 物件追蹤：介面的線路協定，或 IP SLA 的探測結果
    ['track <n> interface <if> line-protocol', ([n, name]) => {
      const e = needRouting(); if (e) return e;
      if (!/^\d+$/.test(n) || +n < 1 || +n > 1000) return err('track 物件的編號是 1 – 1000');
      const i = ifByName(name);
      if (isErr(i)) return i;
      (dev().track ||= {})[+n] = { type: 'iface', iface: i.id };
      enter('track', +n);
      return undefined;
    }],
    ['track <n> interface <if> <...>', () => err('這個模擬只支援 line-protocol（ip routing 沒有模擬）')],
    ['track <n> ip sla <m> [...]', ([n, m, rest]) => {
      const e = needRouting(); if (e) return e;
      if (!/^\d+$/.test(n) || +n < 1 || +n > 1000) return err('track 物件的編號是 1 – 1000');
      if (rest && !/^(reachability|state)$/i.test(rest)) return err('用法：track <編號> ip sla <操作編號> reachability');
      (dev().track ||= {})[+n] = { type: 'sla', sla: +m };
      enter('track', +n);
      return undefined;
    }],
    ['no track <n>', ([n]) => { if (dev().track) { delete dev().track[+n]; if (!Object.keys(dev().track).length) delete dev().track; } }],
    ['ip sla schedule <n> [...]', ([n, rest]) => {
      const op = (dev().sla || {})[+n];
      if (!op) return err(`%IP SLAs: operation ${n} does not exist（先用 ip sla ${n} 定義）`);
      // 沒有寫 start-time now 的話，排程是 pending：一直不會開始探測
      op.sched = /start-time\s+now/i.test(rest || '');
      op.life = /life\s+forever/i.test(rest || '') ? 'forever' : undefined;
      return op.sched ? undefined : '（沒有寫 start-time now：這個操作的狀態是 pending，不會開始探測）';
    }],
    ['no ip sla schedule <n>', ([n]) => { const op = (dev().sla || {})[+n]; if (op) op.sched = false; }],
    ['ip sla <n>', ([n]) => {
      const e = needRouting(); if (e) return e;
      if (!/^\d+$/.test(n) || +n < 1 || +n > 2147483647) return err('用法：ip sla <操作編號>');
      const op = (dev().sla ||= {})[+n];
      if (op && op.sched) return err(`%Entry already being scheduled. Please use "no ip sla ${n}" to delete first.（排程中的 IP SLA 不能直接修改）`);
      if (!op) dev().sla[+n] = { dst: '', src: '', freq: 60, sched: false };
      enter('ipsla', +n);
      return undefined;
    }],
    ['no ip sla <n>', ([n]) => { if (dev().sla) { delete dev().sla[+n]; if (!Object.keys(dev().sla).length) delete dev().sla; } }],
    ['line console [...]', () => { enter('line', 'console'); return undefined; }],
    ['restconf', () => {
      const d = dev();
      if (!IOS_XE.has(d.model)) return err(`${CATALOG[d.model].title} 跑的不是 IOS XE，沒有 RESTCONF（Catalyst 2960 是 IOS 15、Nexus 用的是 NX-API）`);
      d.mgmt.restconf = true;
      return d.mgmt.https ? undefined : '（RESTCONF 走 HTTPS：還要 ip http secure-server）';
    }],
    ['no restconf', () => { if (dev().mgmt) delete dev().mgmt.restconf; }],
    // NETCONF：SSH 的 830 埠（要有 RSA 金鑰，SSH 才在聽）
    ['netconf-yang', () => {
      const d = dev();
      if (!IOS_XE.has(d.model)) return err(`${CATALOG[d.model].title} 跑的不是 IOS XE，沒有 NETCONF`);
      d.mgmt.netconf = true;
      return d.mgmt.sshKey ? undefined : '（NETCONF 走 SSH：還要 ip domain name 與 crypto key generate rsa，SSH 才會在 830 埠聽）';
    }],
    ['no netconf-yang', () => { if (dev().mgmt) delete dev().mgmt.netconf; }],
    ['ip http authentication local', () => undefined],
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
    // service timestamps log | debug datetime [msec] [localtime] [show-timezone] [year] | uptime
    ['service timestamps [...]', ([rest]) => {
      const m = dev().mgmt, w = String(rest || '').toLowerCase().split(' ').filter(Boolean);
      if (!m) return err('這台設備不支援');
      const kinds = !w[0] ? ['log', 'debug'] : 'log'.startsWith(w[0]) ? ['log'] : 'debug'.startsWith(w[0]) ? ['debug'] : null;
      if (!kinds) return err('用法：service timestamps log | debug datetime [msec] [localtime] [show-timezone] [year]，或 service timestamps log uptime');
      const opt = w.slice(1);
      let c;
      if (!opt.length || 'uptime'.startsWith(opt[0]) && opt[0].length >= 2) c = { dt: false };
      else if (opt[0].length >= 2 && 'datetime'.startsWith(opt[0])) {
        c = { dt: true, msec: false, local: false, tz: false, year: false };
        for (const x of opt.slice(1)) {
          const k = x.length >= 2 && ['msec', 'localtime', 'show-timezone', 'year'].find((o) => o.startsWith(x));
          if (!k) return err(`% Invalid input detected：service timestamps 不認識「${x}」（可以用 msec、localtime、show-timezone、year）`);
          c[{ msec: 'msec', localtime: 'local', 'show-timezone': 'tz', year: 'year' }[k]] = true;
        }
      } else return err(`% Invalid input detected：service timestamps ${w[0]} 後面要接 datetime 或 uptime`);
      m.stamps ||= {};
      for (const k of kinds) m.stamps[k] = c;
      return undefined;
    }],
    ['no service timestamps [...]', ([rest]) => {
      const m = dev().mgmt, w = String(rest || '').toLowerCase().split(' ').filter(Boolean);
      if (!m) return err('這台設備不支援');
      m.stamps ||= {};
      for (const k of !w[0] ? ['log', 'debug'] : 'log'.startsWith(w[0]) ? ['log'] : ['debug']) m.stamps[k] = { off: true };
      return undefined;
    }],
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
    // errdisable recovery：err-disabled 的埠過一段時間自動試著打開（預設不會，要自己 shutdown → no shutdown）
    ['errdisable recovery cause <cause>', ([c]) => {
      const e = needSw();
      if (e) return e;
      const names = c.toLowerCase() === 'all' ? ERR_RECOVERY_CAUSES : ERR_RECOVERY_CAUSES.filter((x) => x.startsWith(c.toLowerCase()));
      if (names.length !== 1 && c.toLowerCase() !== 'all') return err(names.length ? `% Ambiguous command: "${c}"` : `% Invalid input：可以用的原因有 all、${ERR_RECOVERY_CAUSES.join('、')}`);
      const r = (dev().sw.errRec ||= { causes: [] });
      for (const n of names) if (!r.causes.includes(n)) r.causes.push(n);
      return undefined;
    }],
    ['no errdisable recovery cause <cause>', ([c]) => {
      const e = needSw();
      if (e) return e;
      const r = dev().sw.errRec;
      if (!r) return undefined;
      const names = c.toLowerCase() === 'all' ? ERR_RECOVERY_CAUSES : ERR_RECOVERY_CAUSES.filter((x) => x.startsWith(c.toLowerCase()));
      r.causes = (r.causes || []).filter((x) => !names.includes(x));
      if (!r.causes.length && !r.interval) delete dev().sw.errRec;
      return undefined;
    }],
    ['errdisable recovery interval <n>', ([n]) => {
      const e = needSw();
      if (e) return e;
      if (!/^\d+$/.test(n) || +n < 30 || +n > 86400) return err('用法：errdisable recovery interval <30-86400>（秒，預設 300）');
      const r = (dev().sw.errRec ||= { causes: [] });
      if (+n === 300) delete r.interval; else r.interval = +n;
      if (!r.causes.length && !r.interval) delete dev().sw.errRec;
      return undefined;
    }],
    ['no errdisable recovery interval [...]', () => {
      const e = needSw();
      if (e) return e;
      const r = dev().sw.errRec;
      if (r) { delete r.interval; if (!(r.causes || []).length) delete dev().sw.errRec; }
      return undefined;
    }],
    // NAT 轉換表的閒置逾時
    ['ip nat translation <kind> <n>', ([kind, n]) => {
      const d = dev(), k = NAT_TIMER[kind.toLowerCase()];
      if (!d.routing || !d.staticNat) return err('這台設備不支援 NAT');
      if (!k) return err('用法：ip nat translation timeout | tcp-timeout | udp-timeout | icmp-timeout | dns-timeout | syn-timeout | finrst-timeout <秒>');
      if (!/^\d+$/.test(n) || +n < 1 || +n > 536870) return err('秒數必須是 1 – 536870');
      for (const x of k) (d.natTimeout ||= {})[x] = +n;
      if (kind.toLowerCase() === 'timeout') d.natTimeout.simple = +n; // 位址池一對一轉換（不含埠號）的逾時
      return undefined;
    }],
    ['no ip nat translation <kind> [...]', ([kind]) => {
      const d = dev(), k = NAT_TIMER[kind.toLowerCase()];
      if (!k) return err('沒有這個計時器');
      for (const x of k) if (d.natTimeout) delete d.natTimeout[x];
      if (d.natTimeout && kind.toLowerCase() === 'timeout') delete d.natTimeout.simple;
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
      const name = t[0], pass = readSecret(t.slice(k + 1));
      const pk = t.findIndex((x) => x.toLowerCase() === 'privilege');
      if (pk >= 0 && pk < k && !(/^\d+$/.test(t[pk + 1] || '') && +t[pk + 1] <= 15)) return err('用法：username <帳號> privilege <0-15> secret <密碼>');
      const priv = pk >= 0 && pk < k ? +t[pk + 1] : 1; // 沒寫 privilege 就是 1：登入之後在使用者模式 (>)，要 enable 才能設定
      // 第一個帳號（或同名）是主要帳號，其他人的帳號另外存。
      // 模擬裡出廠的 admin / admin 只是方便用的預設值（真的 IOS 出廠沒有帳號），建立第一個帳號就取代它
      const factory = m.user === 'admin' && m.pass === 'admin' && !(m.users || []).length;
      if (m.user == null || m.user === '' || m.user === name || factory) { m.user = name; m.pass = pass; m.priv = priv; return undefined; }
      const list = (m.users ||= []), cur = list.find((u) => u.user === name);
      if (cur) Object.assign(cur, { pass, priv }); else list.push({ user: name, pass, priv });
      return undefined;
    }],
    ['no username <name> [...]', ([name]) => {
      const m = dev().mgmt;
      if (!m) return err('這台設備不支援');
      if (!localUsers(m).some((u) => u.user === name)) return err(`% 沒有 ${name} 這個帳號`);
      if ((m.user ?? 'admin') === name) {
        const nx = (m.users || []).shift();
        if (nx) { m.user = nx.user; m.pass = nx.pass; m.priv = nx.priv; } else { m.user = ''; m.pass = ''; delete m.priv; }
      } else m.users = (m.users || []).filter((u) => u.user !== name);
      if (m.users && !m.users.length) delete m.users;
      return undefined;
    }],
    // enable secret：從使用者模式 (>) 進入特權模式 (#) 的密碼。遠端登入（vty）沒有設定的話，enable 會被拒絕
    ['enable secret <...>', ([rest]) => { const m = dev().mgmt; if (!m) return err('這台設備不支援'); const t = rest.split(/\s+/); m.enableSecret = readSecret(t); if (!m.enableSecret) return err('用法：enable secret <密碼>'); return undefined; }],
    ['no enable secret [...]', () => { if (dev().mgmt) delete dev().mgmt.enableSecret; }],
    // 隱藏指令：接受第三方的收發器（Cisco 不保證、TAC 也不支援）。已經 err-disabled 的埠要 shutdown 再 no shutdown
    ['service unsupported-transceiver', (args, out) => {
      dev().unsupportedXcvr = true;
      out.push('Warning: When Cisco determines that a fault or defect can be traced to the use of third-party transceivers', 'installed by a customer or reseller, then, at Cisco\'s discretion, Cisco may withhold support under', 'warranty or a Cisco support program.');
    }],
    ['no service unsupported-transceiver', () => { delete dev().unsupportedXcvr; }],
    ['service <...>', () => undefined],
    // ── AAA ──
    // ── NAT64（stateful）──
    ['nat64 prefix stateful <pfx>', ([p]) => { const c = parseCidr6(p); if (!c || c.bits !== 96) return err('用法：nat64 prefix stateful 64:ff9b::/96（前綴要是 /96）'); (dev().nat64 ||= {}).prefix = p.toLowerCase(); return undefined; }],
    ['nat64 v6v4 list <acl> interface <...>', ([acl, rest]) => {
      const t = rest.trim().split(/\s+/), ov = t[t.length - 1].toLowerCase() === 'overload';
      if (!ov) return err('用法：nat64 v6v4 list <IPv6 ACL> interface <外面的介面> overload');
      const r = resolveIf(dev(), t.slice(0, -1).join(''));
      if (isErr(r)) return r;
      if (!r.iface) return err('要指定有 IPv4 位址的介面');
      Object.assign((dev().nat64 ||= {}), { list: acl, out: r.iface.id });
      return undefined;
    }],
    ['no nat64 [...]', () => { delete dev().nat64; }],
    ['aaa new-model', () => { (dev().aaa ||= {}).on = true; }],
    ['no aaa new-model', () => { if (dev().aaa) dev().aaa.on = false; }],
    ['aaa authentication login <name> <...>', ([name, rest]) => {
      const d = dev();
      if (!(d.aaa && d.aaa.on)) return err('AAA command requires "aaa new-model"');
      const m = parseMethods(rest.split(/\s+/));
      if (!m) return err('用法：aaa authentication login default group tacacs+ local（方法可以是 group tacacs+、local、none）');
      (d.aaa.authn ||= {})[name] = m;
      return undefined;
    }],
    ['no aaa authentication login <name> [...]', ([name]) => { const a = dev().aaa; if (a && a.authn) delete a.authn[name]; }],
    ['aaa authorization exec <name> <...>', ([name, rest]) => {
      const d = dev();
      if (!(d.aaa && d.aaa.on)) return err('AAA command requires "aaa new-model"');
      const m = parseMethods(rest.split(/\s+/));
      if (!m || name !== 'default') return err('用法：aaa authorization exec default group tacacs+ local');
      d.aaa.authzExec = m;
      return undefined;
    }],
    ['no aaa authorization exec [...]', () => { if (dev().aaa) delete dev().aaa.authzExec; }],
    ['aaa authorization commands <lvl> <name> <...>', ([lvl, name, rest]) => {
      const d = dev();
      if (!(d.aaa && d.aaa.on)) return err('AAA command requires "aaa new-model"');
      const m = parseMethods(rest.split(/\s+/));
      if (!m || lvl !== '15' || name !== 'default') return err('用法：aaa authorization commands 15 default group tacacs+ local（這個模擬只支援 15 級）');
      d.aaa.authzCmd = m;
      return undefined;
    }],
    ['no aaa authorization commands [...]', () => { if (dev().aaa) delete dev().aaa.authzCmd; }],
    ['aaa accounting <kind> <...>', ([kind, rest]) => {
      const d = dev();
      if (!(d.aaa && d.aaa.on)) return err('AAA command requires "aaa new-model"');
      const w = rest.split(/\s+/), k = kind.toLowerCase();
      // aaa accounting commands 15 default start-stop group tacacs+ / aaa accounting exec default start-stop group tacacs+
      const lvl = k === 'commands' ? w.shift() : null;
      const name = w.shift(), how = (w.shift() || '').toLowerCase();
      const m = parseMethods(w);
      if (!['commands', 'exec'].includes(k) || (k === 'commands' && lvl !== '15') || name !== 'default' || !['start-stop', 'stop-only'].includes(how) || !m || !m.includes('tacacs'))
        return err('用法：aaa accounting commands 15 default start-stop group tacacs+（或 aaa accounting exec default start-stop group tacacs+）');
      if (k === 'commands') d.aaa.acctCmd = how; else d.aaa.acctExec = how;
      return undefined;
    }],
    ['no aaa accounting <kind> [...]', ([kind]) => { const a = dev().aaa; if (!a) return; if (/^c/i.test(kind)) delete a.acctCmd; else delete a.acctExec; }],
    ['aaa <...>', () => undefined],
    // ── TACACS+ 伺服器 ──
    ['tacacs server <name>', ([name]) => {
      const d = dev(), list = (d.tacacs ||= []);
      let t = list.find((x) => x.name === name);
      if (!t) list.push((t = { name, ip: '', key: '' }));
      enter('tacacs', t);
      return undefined;
    }],
    ['no tacacs server <name>', ([name]) => { const d = dev(); if (d.tacacs) d.tacacs = d.tacacs.filter((x) => x.name !== name); }],
    ['ip tacacs source-interface <...>', ([text]) => {
      const r = resolveIf(dev(), text);
      if (isErr(r)) return r;
      if (!r.iface) return err('這個介面不能當來源（要有 IP 的介面，例如 Loopback0 或 Vlan99）');
      (dev().aaa ||= {}).src = r.iface.id;
      return undefined;
    }],
    ['no ip tacacs source-interface [...]', () => { if (dev().aaa) delete dev().aaa.src; }],
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
      enter('tset', name);
      return undefined;
    }],
    ['no crypto ipsec transform-set <name>', ([name]) => {
      const d = dev();
      if ((d.vpns || []).some((v) => v.tset === name)) return err(`transform-set ${name} 正被 crypto map 使用，不能刪除`);
      if (Object.values(d.ipsecProfiles || {}).some((p) => p.tset === name)) return err(`transform-set ${name} 正被 IPsec profile 使用，不能刪除`);
      if (d.tsets) delete d.tsets[name];
      return undefined;
    }],
    ['ip flow-export destination <ip> <port> [...]', ([ip, port]) => {
      if (dev().kind !== 'router') return err('這個模擬只有路由器支援 NetFlow');
      if (parseIp(ip) == null || !(+port >= 1 && +port <= 65535)) return err('用法：ip flow-export destination <收集器的 IP> <UDP 埠（常用 2055、9996）>');
      const n = nfOf(); n.export = { ...(n.export || {}), ip, port: +port };
      return undefined;
    }],
    ['no ip flow-export destination [...]', () => { const n = nfOf(); if (n.export) delete n.export.ip, delete n.export.port; tidyNf(); }],
    ['ip flow-export version <v> [...]', ([v]) => (['5', '9'].includes(v) ? (nfOf().export = { ...(nfOf().export || {}), ver: +v }, undefined) : err('用法：ip flow-export version 5 | 9'))],
    ['ip flow-export source <...>', ([x]) => { const i = ifByName(x); if (isErr(i)) return i; nfOf().export = { ...(nfOf().export || {}), src: i.id }; return undefined; }],
    ['flow record <name>', ([n]) => { if (dev().kind !== 'router') return err('這個模擬只有路由器支援 NetFlow'); (nfOf().records ||= {})[n] ||= { lines: [] }; enter('flowrec', n); return undefined; }],
    ['no flow record <name>', ([n]) => { const r = (dev().nf || {}).records; if (r) delete r[n]; tidyNf(); }],
    ['flow exporter <name>', ([n]) => { if (dev().kind !== 'router') return err('這個模擬只有路由器支援 NetFlow'); (nfOf().exporters ||= {})[n] ||= { port: 9995 }; enter('flowexp', n); return undefined; }],
    ['no flow exporter <name>', ([n]) => { const x = (dev().nf || {}).exporters; if (x) delete x[n]; tidyNf(); }],
    ['flow monitor <name>', ([n]) => { if (dev().kind !== 'router') return err('這個模擬只有路由器支援 NetFlow'); (nfOf().monitors ||= {})[n] ||= {}; enter('flowmon', n); return undefined; }],
    ['no flow monitor <name>', ([n]) => {
      const d = dev();
      if (Object.values((d.nf || {}).ifMon || {}).some((x) => x.in === n || x.out === n)) return err(`% Flow Monitor: ${n} is in use（先在介面上 no ip flow monitor ${n} input）`);
      const x = (d.nf || {}).monitors; if (x) delete x[n]; tidyNf();
      return undefined;
    }],
    ['crypto ipsec profile <name>', ([n]) => {
      const d = dev();
      if (!d.vpns || d.kind !== 'router') return err('這台設備不支援 IPsec VPN');
      (d.ipsecProfiles ||= {})[n] ||= {};
      enter('ipsecprof', n);
      return undefined;
    }],
    ['no crypto ipsec profile <name>', ([n]) => {
      const d = dev();
      if (d.ifaces.some((i) => isTun(i) && i.tun && i.tun.prot === n)) return err(`% IPSEC profile ${n} 正被 Tunnel 介面使用，先 no tunnel protection`);
      if (d.ipsecProfiles) { delete d.ipsecProfiles[n]; if (!Object.keys(d.ipsecProfiles).length) delete d.ipsecProfiles; }
      return undefined;
    }],
    ['crypto ipsec nat-transparency udp-encapsulation', () => { delete dev().noNatT; }],
    ['no crypto ipsec nat-transparency udp-encapsulation', () => { if (!dev().vpns) return err('這台設備不支援 IPsec VPN'); dev().noNatT = true; return '（關掉 NAT-T：中間有 NAT 的時候，ESP 會被 PAT 擋掉）'; }],
    ['crypto isakmp nat keepalive <sec>', ([n]) => (/^\d+$/.test(n) && +n >= 5 && +n <= 3600 ? (dev().natKa = +n, undefined) : err('用法：crypto isakmp nat keepalive <5-3600 秒>'))],
    ['no crypto isakmp nat keepalive [...]', () => { delete dev().natKa; }],
    ['crypto map <name> <seq> ipsec-isakmp', (a) => cmapEnter(a)],
    ['crypto map <name> <seq>', (a) => cmapEnter(a)],
    ['no crypto map <name> [...]', ([name, seq]) => {
      const d = dev();
      if (!d.vpns) return undefined;
      d.vpns = d.vpns.filter((v) => !(cmapOf(v) === name && (!seq || seqOf(d, v) === +seq)));
      if (!d.vpns.some((v) => cmapOf(v) === name)) for (const i of d.ifaces) if (i.cmap === name) i.cmap = '';
      return undefined;
    }],
    ['crypto ikev2 proposal <name>', ([n]) => { const v = v2of(); if (!v) return err('這台設備不支援 IPsec VPN'); v.props[n] ||= { encs: [], hashes: [], dhs: [] }; enter('ikev2prop', n); return undefined; }],
    ['no crypto ikev2 proposal <name>', ([n]) => { const v = v2of(); if (v) { delete v.props[n]; for (const x of Object.values(v.pols)) x.props = x.props.filter((y) => y !== n); } }],
    ['crypto ikev2 policy <name>', ([n]) => { const v = v2of(); if (!v) return err('這台設備不支援 IPsec VPN'); v.pols[n] ||= { props: [] }; enter('ikev2pol', n); return undefined; }],
    ['no crypto ikev2 policy <name>', ([n]) => { const v = v2of(); if (v) delete v.pols[n]; }],
    ['crypto ikev2 keyring <name>', ([n]) => { const v = v2of(); if (!v) return err('這台設備不支援 IPsec VPN'); v.krs[n] ||= { peers: {} }; enter('ikev2kr', n); return undefined; }],
    ['no crypto ikev2 keyring <name>', ([n]) => { const v = v2of(); if (v) delete v.krs[n]; }],
    // ── PKI：trustpoint、向 CA 取得根憑證 (authenticate)、申請自己的憑證 (enroll) ──
    ['crypto pki trustpoint <name>', ([n]) => { if (dev().kind !== 'router') return err('這個模擬只有路由器支援 PKI'); ((dev().pki ||= { tps: {} }).tps ||= {})[n] ||= { revoke: 'crl' }; enter('pkitp', n); return undefined; }],
    ['no crypto pki trustpoint <name>', ([n]) => ({ delegate: (o) => {
      const tp = tpOf(dev(), n);
      if (!tp) { o.push(`% Trustpoint ${n} not found`); return { out: o, changed: false }; }
      const drop = (o2) => { delete dev().pki.tps[n]; return { out: o2, changed: true }; };
      if (!tp.ca && !tp.cert) return drop(o);
      o.push('% Removing an enrolled trustpoint will destroy all certificates', 'received from the related Certificate Authority.', '', 'Are you sure you want to do this? [yes/no]: ');
      S.pending = { fn: (ans, o2) => { S.pending = null; if (!/^y/i.test(ans)) return { out: o2, changed: false }; o2.push('% Be sure to ask the CA administrator to revoke your certificates.'); return drop(o2); } };
      return { out: o, changed: false };
    } })],
    ['crypto pki authenticate <name>', ([n]) => ({ delegate: (o) => pkiAuthenticate(n, o) })],
    ['crypto pki enroll <name>', ([n]) => ({ delegate: (o) => pkiEnroll(n, o) })],
    ['crypto pki certificate chain <name>', ([n]) => { if (!tpOf(dev(), n)) return err(`% Trustpoint ${n} not found（先用 crypto pki trustpoint ${n} 建立）`); enter('pkichain', n); return undefined; }],
    ['crypto ikev2 profile <name>', ([n]) => { const v = v2of(); if (!v) return err('這台設備不支援 IPsec VPN'); v.profs[n] ||= {}; enter('ikev2prof', n); return undefined; }],
    ['no crypto ikev2 profile <name>', ([n]) => {
      const v = v2of();
      if (!v) return undefined;
      if ((dev().vpns || []).some((t) => t.ikev2 === n)) return err(`IKEv2 profile ${n} 正被 crypto map 使用，先 no set ikev2-profile`);
      delete v.profs[n];
      return undefined;
    }],
    ['crypto <...>', () => err('這個模擬支援的 VPN 指令：crypto isakmp policy、crypto isakmp key、crypto ipsec transform-set、crypto ipsec profile、crypto ikev2 proposal / policy / keyring / profile、crypto map')],
  ];

  function setRsvMac(text) {
    const mac = colonMac(text), p = S.cur;
    if (!mac) return err('MAC 位址的格式：0011.2233.4455；client-identifier 則是前面多一個 01');
    if (p.iface) return err('這個位址池已經是一個網段，保留位址請另外建一個位址池');
    if (p.rsv) p.rsv.mac = mac; else { p.mac = mac; attachPools(dev()); }
    return undefined;
  }

  /** 整台的 IKEv2 物件（第一次用到時建立） */
  function v2of() {
    const d = dev();
    if (!d.vpns || d.kind !== 'router') return null;
    const v = (d.ikev2 ||= {});
    for (const k of ['props', 'pols', 'krs', 'profs']) v[k] ||= {};
    return v;
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
    vlan: [
      ['name <...>', ([name]) => { S.cur.name = name; }],
      ['private-vlan <t>', ([t]) => {
        if (!pvlanOk()) return err('% Private VLANs are not supported on this platform（Catalyst 2960 只有 switchport protected）');
        const v = ['primary', 'isolated', 'community'].find((x) => x.startsWith(t.toLowerCase()));
        if (!v) return err('用法：private-vlan primary | isolated | community');
        if (S.cur.id === 1) return err('% VLAN 1 不能當成 private VLAN');
        S.cur.pvlan = v;
        if (v !== 'primary') delete S.cur.assoc;
        return undefined;
      }],
      ['private-vlan association <...>', ([list]) => {
        if (S.cur.pvlan !== 'primary') return err('% 只有 primary VLAN 可以設定 association（先 private-vlan primary）');
        const add = /^add\s+/i.test(list), rm = /^remove\s+/i.test(list), v = parseVlanList(list.replace(/^(add|remove)\s+/i, ''));
        if (!v) return err('用法：private-vlan association <secondary 清單>');
        S.cur.assoc = rm ? (S.cur.assoc || []).filter((x) => !v.includes(x)) : add ? [...new Set([...(S.cur.assoc || []), ...v])] : v;
        return undefined;
      }],
      ['no private-vlan [...]', () => { delete S.cur.pvlan; delete S.cur.assoc; }],
    ],
    raguard: [
      ['device-role <r>', ([r]) => { const v = ['host', 'router'].find((x) => x.startsWith(r.toLowerCase())); return v ? void (dev().sw.raPolicies[S.cur].role = v) : err('用法：device-role host | router'); }],
      ['no device-role [...]', () => { dev().sw.raPolicies[S.cur].role = 'host'; }],
    ],
    router: [
      ['network <ip> <wild> area <a>', ([ip, wild, a]) => {
        const net = parseIp(ip), bits = wildBits(wild);
        if (net == null || bits == null) return err('用法：network <網段> <萬用遮罩> area 0，例如 network 10.0.0.0 0.0.0.255 area 0');
        const d = dev(), c = oc(), area = +(a || 0);
        if (!/^\d+$/.test(String(a))) return err('區域請寫數字，例如 area 0（這個模擬不支援 0.0.0.1 這種寫法）');
        const stmt = { net: netOf(net, bits), bits, area };
        c.ospfNets = (c.ospfNets || []).filter((n) => !(n.net === stmt.net && n.bits === stmt.bits));
        c.ospfNets.push(stmt);
        const v = ocVrf();
        const hit = d.ifaces.filter((i) => {
          const n = staticNet(i), a = n ? n.ip : i.rt && i.rt.ip;
          return (i.vrf || '') === v && a != null && netOf(a, bits) === stmt.net;
        });
        return hit.length ? `OSPF 已在 ${hit.map((i) => i.label).join('、')} 啟用` : `（目前還沒有${v ? ` VRF ${v} 的` : ''}介面的 IP 落在這個範圍內；之後設定了符合的 IP，那個介面就會自動加入 OSPF）`;
      }],
      ['no network <ip> <wild> area <a>', ([ip, wild]) => {
        const net = parseIp(ip), bits = wildBits(wild);
        if (net == null || bits == null) return err('用法：no network <網段> <萬用遮罩> area 0');
        const d = dev(), c = oc(), n0 = netOf(net, bits), v = ocVrf();
        const had = (c.ospfNets || []).length;
        c.ospfNets = (c.ospfNets || []).filter((n) => !(n.net === n0 && n.bits === bits));
        let off = 0;
        for (const i of d.ifaces) { const n = staticNet(i); if ((i.vrf || '') === v && i.ospf && n && netOf(n.ip, bits) === n0) { i.ospf = false; off++; } }
        return c.ospfNets.length < had || off ? undefined : err('沒有這一條 network 敘述');
      }],
      ['default-information originate [...]', () => { oc().ospfDefault = true; }],
      ['no default-information originate', () => { oc().ospfDefault = false; }],
      ['redistribute <src> [...]', ([src, rest]) => {
        const o = redistArgs(src, rest, 'ospf');
        if (isErr(o)) return o;
        upsertRedist((oc().ospfRedist ||= []), o);
        const miss = o.rm && !(dev().routeMaps || {})[o.rm];
        return miss ? `（route-map ${o.rm} 還不存在：在它建立之前，什麼路都不會被重分配）` : undefined;
      }],
      ['no redistribute <src> [...]', ([src]) => {
        const c = oc(), n = (c.ospfRedist || []).length;
        c.ospfRedist = (c.ospfRedist || []).filter((x) => !x.src.startsWith(String(src).toLowerCase()));
        if (!c.ospfRedist.length) delete c.ospfRedist;
        return (c.ospfRedist || []).length < n ? undefined : err('沒有這一條 redistribute');
      }],
      ['router-id <id>', ([id]) => {
        if (parseIp(id) == null) return err('用法：router-id <A.B.C.D>');
        const d = dev(), cur = ((getState().dyn || {})['rid' + ospfKeys(ocVrf()).ns] || {})[d.id];
        oc().ospfRid = id;
        // 程序已經在跑了：新的 Router ID 要重新啟動程序才會生效
        return cur && cur.rid !== parseIp(id) ? '% OSPF: Reload or use "clear ip ospf process" command, for this to take effect' : undefined;
      }],
      ['passive-interface default', () => { const c = oc(); c.ospfPassiveDefault = true; c.ospfNoPassive = []; }],
      ['bfd all-interfaces', () => { oc().bfdAll = true; }],
      ['no bfd all-interfaces', () => { delete oc().bfdAll; }],
      ['no passive-interface default', () => { const c = oc(); delete c.ospfPassiveDefault; delete c.ospfNoPassive; }],
      ['passive-interface <...>', ([t]) => { const i = ifByName(t); if (isErr(i)) return i; const c = oc(); if (c.ospfPassiveDefault) c.ospfNoPassive = (c.ospfNoPassive || []).filter((x) => x !== i.id); else if (!(c.ospfPassive ||= []).includes(i.id)) c.ospfPassive.push(i.id); return undefined; }],
      ['no passive-interface <...>', ([t]) => { const i = ifByName(t); if (isErr(i)) return i; const c = oc(); if (c.ospfPassiveDefault) { if (!(c.ospfNoPassive ||= []).includes(i.id)) c.ospfNoPassive.push(i.id); } else c.ospfPassive = (c.ospfPassive || []).filter((x) => x !== i.id); return undefined; }],
      ['auto-cost reference-bandwidth <n>', ([n]) => (+n >= 1 && +n <= 4294967 ? void (oc().ospfRefBw = +n === 100 ? undefined : +n) || '% OSPF: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.' : err('reference-bandwidth 的單位是 Mbps，範圍 1 – 4294967'))],
      ['no auto-cost reference-bandwidth [...]', () => { delete oc().ospfRefBw; }],
      ['maximum-paths <n>', ([n]) => (+n >= 1 && +n <= 32 ? void (oc().ospfMaxPaths = +n === 4 ? undefined : +n) : err('maximum-paths 的範圍是 1 – 32'))],
      ['no maximum-paths [...]', () => { delete oc().ospfMaxPaths; }],
      ['area <a> range <ip> <mask> [...]', ([a, ip, mask]) => {
        const n = parseIp(ip), bits = maskBits(mask);
        if (!/^\d+$/.test(a) || n == null || bits == null) return err('用法：area 1 range 10.1.0.0 255.255.0.0');
        const c = oc();
        c.ospfRanges = (c.ospfRanges || []).filter((r) => !(+r.area === +a && r.net === netOf(n, bits) && r.bits === bits));
        c.ospfRanges.push({ area: +a, net: netOf(n, bits), bits });
        return undefined;
      }],
      ['no area <a> range <ip> <mask> [...]', ([a, ip, mask]) => { const n = parseIp(ip), bits = maskBits(mask); const c = oc(); c.ospfRanges = (c.ospfRanges || []).filter((r) => !(+r.area === +a && r.net === netOf(n, bits) && r.bits === bits)); }],
      ['area <a> authentication message-digest', ([a]) => { (oc().ospfAreaAuth ||= {})[+a] = 'md5'; }],
      ['area <a> authentication', ([a]) => { (oc().ospfAreaAuth ||= {})[+a] = 'plain'; }],
      ['no area <a> authentication [...]', ([a]) => { const c = oc(); if (c.ospfAreaAuth) delete c.ospfAreaAuth[+a]; }],
      // ── 區域的種類：stub / totally stubby / NSSA / totally NSSA ──
      ['area <a> stub [...]', ([a, rest]) => {
        if (!/^\d+$/.test(a)) return err('用法：area 1 stub [no-summary]');
        if (+a === 0) return err('% OSPF: Backbone can not be configured as stub area');
        const w = String(rest || '').trim().toLowerCase();
        if (w && !'no-summary'.startsWith(w)) return err('用法：area <區域> stub [no-summary]');
        const ar = areaOf(a);
        if (ar.nssa) return err(`% OSPF: Area ${+a} is configured as NSSA already（先 no area ${+a} nssa）`);
        ar.stub = true;
        if (w) ar.noSum = true;
        return undefined;
      }],
      ['no area <a> stub [...]', ([a, rest]) => {
        const ar = ((oc().ospfAreas || {})[+a]);
        if (!ar || !ar.stub) return err(`area ${a} 不是 stub 區域`);
        // no area 1 stub no-summary：只拿掉 no-summary，還是 stub
        if (String(rest || '').trim()) delete ar.noSum; else { delete ar.stub; delete ar.noSum; }
        tidyArea(+a);
        return undefined;
      }],
      ['area <a> nssa [...]', ([a, rest]) => {
        if (!/^\d+$/.test(a)) return err('用法：area 1 nssa [no-summary] [default-information-originate] [no-redistribution]');
        if (+a === 0) return err('% OSPF: Backbone can not be configured as NSSA area');
        const ar = areaOf(a);
        if (ar.stub) return err(`% OSPF: Area ${+a} is configured as stub area already（先 no area ${+a} stub）`);
        const t = String(rest || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        const o = {};
        for (let k = 0; k < t.length; k++) {
          if ('no-summary'.startsWith(t[k]) && t[k].length >= 4) o.noSum = true;
          else if ('no-redistribution'.startsWith(t[k]) && t[k].length >= 4) o.noRedist = true;
          else if ('default-information-originate'.startsWith(t[k]) && t[k].length >= 3) {
            o.nssaDef = true;
            while (t[k + 1] === 'metric' || t[k + 1] === 'metric-type') {
              const kw = t[++k], v = t[++k];
              if (kw === 'metric' && /^\d+$/.test(v || '')) o.nssaDefMetric = +v;
              else if (kw === 'metric-type' && /^[12]$/.test(v || '')) o.nssaDefType = +v;
              else return err('用法：default-information-originate [metric <n>] [metric-type 1|2]');
            }
          } else return err(`% 看不懂「${t[k]}」：area <區域> nssa 後面可以接 no-summary、default-information-originate、no-redistribution`);
        }
        ar.nssa = true;
        Object.assign(ar, o);
        return undefined;
      }],
      ['no area <a> nssa [...]', ([a, rest]) => {
        const ar = ((oc().ospfAreas || {})[+a]);
        if (!ar || !ar.nssa) return err(`area ${a} 不是 NSSA`);
        const t = String(rest || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!t.length) { for (const k of ['nssa', 'noSum', 'noRedist', 'nssaDef', 'nssaDefMetric', 'nssaDefType']) delete ar[k]; }
        for (const w of t) {
          if ('no-summary'.startsWith(w)) delete ar.noSum;
          else if ('no-redistribution'.startsWith(w)) delete ar.noRedist;
          else if ('default-information-originate'.startsWith(w)) { delete ar.nssaDef; delete ar.nssaDefMetric; delete ar.nssaDefType; }
        }
        tidyArea(+a);
        return undefined;
      }],
      ['area <a> default-cost <n>', ([a, n]) => {
        if (!/^\d+$/.test(a) || !/^\d+$/.test(n) || +n > 16777215) return err('用法：area <區域> default-cost <0-16777215>');
        if (+a === 0) return err('% OSPF: Backbone can not be configured as stub area');
        const ar = areaOf(a);
        if (+n === 1) delete ar.cost; else ar.cost = +n;
        tidyArea(+a);
        return ar.stub || ar.nssa ? undefined : `（area ${+a} 現在不是 stub 或 NSSA：default-cost 只有 ABR 往 stub / NSSA 送預設路由時才用得到）`;
      }],
      ['no area <a> default-cost [...]', ([a]) => { const ar = (oc().ospfAreas || {})[+a]; if (ar) { delete ar.cost; tidyArea(+a); } }],
      ['log-adjacency-changes [...]', () => undefined],
      ['no router-id [...]', () => { delete oc().ospfRid; }],
    ],
    ospf6: [
      ['router-id <id>', ([id]) => {
        if (parseIp(id) == null) return err('用法：router-id <A.B.C.D>（OSPFv3 的 Router ID 還是 32 位元的 IPv4 格式）');
        const d = dev(), cur = ((getState().dyn || {}).rid6 || {})[d.id];
        d.ospf6.rid = id;
        return cur && cur.rid !== parseIp(id) ? '% OSPFv3: Reload or use "clear ipv6 ospf process" command, for this to take effect' : undefined;
      }],
      ['no router-id [...]', () => { delete dev().ospf6.rid; }],
      ['default-information originate [...]', () => { dev().ospf6.default = true; }],
      ['no default-information originate', () => { delete dev().ospf6.default; }],
      ['passive-interface default', () => { const c = dev().ospf6; c.passiveDefault = true; c.noPassive = []; }],
      ['no passive-interface default', () => { const c = dev().ospf6; delete c.passiveDefault; delete c.noPassive; }],
      ['passive-interface <...>', ([t]) => { const i = ifByName(t); if (isErr(i)) return i; const c = dev().ospf6; if (c.passiveDefault) c.noPassive = (c.noPassive || []).filter((x) => x !== i.id); else if (!(c.passive ||= []).includes(i.id)) c.passive.push(i.id); return undefined; }],
      ['no passive-interface <...>', ([t]) => { const i = ifByName(t); if (isErr(i)) return i; const c = dev().ospf6; if (c.passiveDefault) { if (!(c.noPassive ||= []).includes(i.id)) c.noPassive.push(i.id); } else c.passive = (c.passive || []).filter((x) => x !== i.id); return undefined; }],
      ['auto-cost reference-bandwidth <n>', ([n]) => (+n >= 1 && +n <= 4294967 ? void (+n === 100 ? delete dev().ospf6.refBw : (dev().ospf6.refBw = +n)) || '% OSPFv3: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.' : err('reference-bandwidth 的單位是 Mbps，範圍 1 – 4294967'))],
      ['no auto-cost reference-bandwidth [...]', () => { delete dev().ospf6.refBw; }],
      ['maximum-paths <n>', ([n]) => (+n >= 1 && +n <= 32 ? void (+n === 4 ? delete dev().ospf6.maxPaths : (dev().ospf6.maxPaths = +n)) : err('maximum-paths 的範圍是 1 – 32'))],
      ['no maximum-paths [...]', () => { delete dev().ospf6.maxPaths; }],
      ['log-adjacency-changes [...]', () => undefined],
    ],
    dhcp6: [
      ['address prefix <cidr> [...]', ([c]) => {
        const x = parseCidr6(c);
        if (!x || x.bits > 64) return err('用法：address prefix <前綴>/<長度>，例如 address prefix 2001:DB8:A::/64（長度最多 64）');
        dev().dhcp6Pools[S.cur].prefix = `${fmtIp6(net6(x.ip, x.bits))}/${x.bits}`;
        return undefined;
      }],
      ['no address prefix [...]', () => { dev().dhcp6Pools[S.cur].prefix = ''; }],
      ['dns-server <ip>', ([ip]) => {
        if (parseIp6(ip) == null) return err('用法：dns-server <IPv6 位址>（可以下好幾次，加入多台）');
        const p = dev().dhcp6Pools[S.cur], a = fmtIp6(parseIp6(ip));
        if (!(p.dns ||= []).includes(a)) p.dns.push(a);
        return undefined;
      }],
      ['no dns-server <ip>', ([ip]) => { const p = dev().dhcp6Pools[S.cur]; p.dns = (p.dns || []).filter((x) => parseIp6(x) !== parseIp6(ip)); }],
      ['domain-name <name>', ([n]) => { dev().dhcp6Pools[S.cur].domain = n; }],
      ['no domain-name [...]', () => { dev().dhcp6Pools[S.cur].domain = ''; }],
    ],
    acl6: [
      ['no sequence <n>', ([n]) => {
        const l = dev().acl6[S.cur], k = l.findIndex((r) => r.seq === +n);
        if (k < 0) return err(`沒有 sequence ${n} 這一條`);
        l.splice(k, 1);
        return undefined;
      }],
      ['no <...>', ([line]) => {
        const r = parseAcl6(line.split(/\s+/));
        const l = dev().acl6[S.cur];
        const k = r ? l.findIndex((x) => acl6Text(x) === acl6Text(r)) : -1;
        if (k < 0) return err('沒有這一條規則（也可以用 no sequence <序號> 刪除）');
        l.splice(k, 1);
        return undefined;
      }],
      ['<...>', ([line]) => {
        const r = parseAcl6(line.split(/\s+/));
        if (!r) return err('用法：permit|deny <ipv6|tcp|udp|icmp> <來源> [eq <埠>] <目的> [eq <埠>] [nd-ns|nd-na|echo-request|…]，位址寫 any、host <位址> 或 <前綴>/<長度>');
        const l = dev().acl6[S.cur];
        if (l.some((x) => acl6Text(x) === acl6Text(r))) return undefined;
        if (r.seq == null) r.seq = (l.reduce((m, x) => Math.max(m, x.seq), 0) || 0) + 10;
        else if (l.some((x) => x.seq === r.seq)) return err(`% Duplicate sequence number ${r.seq}`);
        l.push(r);
        l.sort((a, b) => a.seq - b.seq);
        return undefined;
      }],
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
      ['option 150 ip <...>', ([list]) => {
        const ips = list.split(/[,\s]+/).filter(Boolean);
        if (!ips.length || ips.some((x) => parseIp(x) == null)) return err('用法：option 150 ip <TFTP 伺服器 IP>');
        const p = S.cur; (p.iface ? p.iface.dhcp : p).tftp = ips.join(', ');
        return undefined;
      }],
      ['option 66 ascii <ip>', ([ip]) => { if (parseIp(ip) == null) return err('用法：option 66 ascii <TFTP 伺服器 IP>'); const p = S.cur; (p.iface ? p.iface.dhcp : p).tftp = ip; return undefined; }],
      // option 43：type f1、長度（4 × WLC 數量）、每台 WLC 的 IPv4 位址，例如 10.10.10.5 → f104.0a0a.0a05
      ['option 43 hex <...>', ([hex]) => {
        const h = hex.replace(/[.\s]/g, '').toLowerCase();
        const m = h.match(/^f1([0-9a-f]{2})((?:[0-9a-f]{8})+)$/);
        if (!m || parseInt(m[1], 16) !== m[2].length / 2) return err('Cisco AP 的 option 43 格式：f1 + 長度（04 × WLC 的數量）+ 每台 WLC 的 IP（十六進位）。例如 WLC 是 10.10.10.5 → option 43 hex f104.0a0a.0a05');
        const ips = m[2].match(/.{8}/g).map((x) => fmtIp(parseInt(x, 16) >>> 0));
        const p = S.cur; (p.iface ? p.iface.dhcp : p).wlc = ips.join(', ');
        return undefined;
      }],
      ['option 43 <...>', () => err('Cisco AP 的 option 43 要用十六進位：option 43 hex f104.0a0a.0a05（f1 = 類型、04 = 一台 WLC、後面是 WLC 的 IP）')],
      ['no option <n> [...]', ([n]) => { const p = S.cur, o = p.iface ? p.iface.dhcp : p; if (n === '43') delete o.wlc; else delete o.tftp; }],
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
      ['no access-class [...]', () => { dev().mgmt.allow = ''; delete dev().mgmt.aclName; }],
      // login local：用 username 建的帳號；login：只問線路密碼；no login：不驗證（非常危險）
      ['login authentication <name>', ([name]) => {
        const m = dev().mgmt;
        if (!m || S.cur === 'console') return undefined;
        if (name === 'default') delete m.vtyAuthList; else m.vtyAuthList = name;
        return undefined;
      }],
      ['no login authentication [...]', () => { const m = dev().mgmt; if (m) delete m.vtyAuthList; }],
      ['login [...]', ([rest]) => {
        const m = dev().mgmt;
        if (!m || S.cur === 'console') return undefined;
        const r = (rest || '').trim().toLowerCase();
        if (!r) m.vtyLogin = 'line';
        else if ('local'.startsWith(r)) m.vtyLogin = 'local';
        return undefined;
      }],
      // privilege level：用線路密碼（login）或不驗證（no login）登入的人，一進來是第幾級
      ['privilege level <n>', ([n]) => { const m = dev().mgmt; if (!m || S.cur === 'console') return undefined; if (!/^\d+$/.test(n) || +n > 15) return err('用法：privilege level <0-15>'); if (+n === 1) delete m.vtyPriv; else m.vtyPriv = +n; return undefined; }],
      ['no privilege level [...]', () => { const m = dev().mgmt; if (m) delete m.vtyPriv; }],
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
        const d = dev();
        const lists = aclLists(d, S.cur);
        const n = aclSeqs(lists[0]).indexOf(+seq);
        if (!/^\d+$/.test(seq) || n < 0) return err(`沒有序號 ${seq} 的規則（show access-lists ${S.cur} 看得到每一條的序號）`);
        for (const l of lists) { aclSeqs(l).forEach((q, k) => { l[k].seq = q; }); l.splice(n, 1); } // 後面的規則保留原本的序號
        syncVpnAcl(d, S.cur);
        return undefined;
      }],
      ['<...>', ([line]) => {
        const t = line.split(/\s+/);
        // evaluate <名稱>：在這裡比對 reflexive list 的暫時規則
        const ev = /^\d+$/.test(t[0]) ? 1 : 0;
        let rule = (t[ev] || '').toLowerCase() === 'evaluate' ? (t[ev + 1] ? { action: 'evaluate', proto: 'ip', src: 'any', dst: 'any', port: '', evaluate: t[ev + 1] } : null) : parseAclRule(t);
        if (!rule && (t[ev] || '').toLowerCase() === 'evaluate') return err('用法：evaluate <reflexive list 的名稱>');
        if (!rule) return err('用法：[序號] permit|deny <ip|tcp|udp|icmp|esp|gre> <來源> <目的> [eq <埠> | ICMP 類型]，位址寫 any、host <IP> 或 <網段> <萬用遮罩>');
        const seq = /^\d+$/.test(t[0]) ? +t[0] : null;
        const lists = aclLists(dev(), S.cur);
        if (seq != null && lists.some((l) => { const k = aclSeqs(l).indexOf(seq); return k >= 0 && !same(stripSeq(l[k]), rule); })) return err('% Duplicate sequence number');
        for (const l of lists) {
          if (l.some((x) => same(stripSeq(x), rule))) continue;
          const qs = aclSeqs(l);
          qs.forEach((q, k) => { l[k].seq = q; });
          if (seq == null) l.push({ ...rule, seq: (qs[qs.length - 1] || 0) + 10 });
          else l.splice(qs.filter((q) => q < seq).length, 0, { ...rule, seq }); // 序號 25 插在 20 與 30 之間
        }
        syncVpnAcl(dev(), S.cur);
        return undefined;
      }],
    ],
    stdacl: [
      ['no permit <...>', ([rest]) => {
        const t = rest.split(/\s+/);
        const ip = (t[0] || '').toLowerCase() === 'host' ? t[1] : t[0];
        const bits = (t[0] || '').toLowerCase() === 'host' || !t[1] ? 32 : wildBits(t[1]);
        if (parseIp(ip || '') == null || bits == null) return err('用法：no permit host <IP> 或 no permit <網段> <萬用遮罩>');
        const cidr = bits === 32 ? ip : `${fmtIp(netOf(parseIp(ip), bits))}/${bits}`;
        const d = dev(), list = (d.stdAcls || {})[S.cur] || [];
        if (!list.includes(cidr)) return err(`這個 ACL 裡沒有 permit ${rest}`);
        d.stdAcls[S.cur] = list.filter((x) => x !== cidr);
        if (d.mgmt && d.mgmt.aclName === S.cur) d.mgmt.allow = d.stdAcls[S.cur].join(', '); // 空的 ACL 和不存在一樣：全部放行
        return undefined;
      }],
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
        if (d.mgmt && (d.mgmt.aclName ? d.mgmt.aclName === S.cur : d.mgmt.allow && S.cur === 'MGMT')) d.mgmt.allow = list.join(', ');
        return undefined;
      }],
    ],
    tacacs: [
      ['address ipv4 <ip>', ([ip]) => { if (parseIp(ip) == null) return err('IP 位址的格式不正確'); S.cur.ip = ip; return undefined; }],
      ['key <...>', ([k]) => { S.cur.key = readSecret(k.split(/\s+/)); }],
      ['timeout <n>', () => undefined],
      ['single-connection', () => undefined],
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
    tset: [['mode <m>', ([m]) => {
      const ts = (dev().tsets || {})[S.cur];
      if (!/^(tunnel|transport)$/i.test(m)) return err('用法：mode tunnel | transport');
      if (ts) { if (/^transport$/i.test(m)) ts.mode = 'transport'; else delete ts.mode; }
      return undefined;
    }]],
    pkitp: [
      ['enrollment url <url>', ([u]) => (urlTarget(u) ? void (dev().pki.tps[S.cur].url = u) : err('用法：enrollment url http://<CA 的 IP>[:埠][/路徑]'))],
      ['no enrollment url [...]', () => { delete dev().pki.tps[S.cur].url; }],
      ['enrollment <...>', () => err('這個模擬只支援 enrollment url（SCEP）')],
      ['subject-name <...>', ([x]) => { dev().pki.tps[S.cur].subject = x; }],
      ['no subject-name [...]', () => { delete dev().pki.tps[S.cur].subject; }],
      ['revocation-check <...>', ([x]) => { const w = x.toLowerCase().split(' ').filter(Boolean); if (!w.length || !w.every((y) => y === 'none' || y === 'crl')) return err('用法：revocation-check none | crl | crl none'); dev().pki.tps[S.cur].revoke = w.join(' '); return undefined; }],
      ['no revocation-check [...]', () => { dev().pki.tps[S.cur].revoke = 'crl'; }],
      ['rsakeypair <name> [...]', ([n]) => { dev().pki.tps[S.cur].rsakey = n; }],
      ['no rsakeypair [...]', () => { delete dev().pki.tps[S.cur].rsakey; }],
      ['fqdn <name>', ([n]) => { dev().pki.tps[S.cur].fqdn = n; }],
      ['serial-number none', () => { dev().pki.tps[S.cur].noSerial = true; }],
      ['ip-address none', () => { dev().pki.tps[S.cur].noIp = true; }],
    ],
    pkichain: [
      ['certificate ca <serial>', ([sn]) => { enter('pkicert', { tp: S.cur, ca: true, serial: sn, lines: [] }); return undefined; }],
      ['certificate <serial>', ([sn]) => { enter('pkicert', { tp: S.cur, ca: false, serial: sn, lines: [] }); return undefined; }],
      ['no certificate [...]', ([x]) => { const tp = tpOf(dev(), S.cur); if (/^ca\b/i.test(x || '')) delete tp.ca; else delete tp.cert; }],
    ],
    pkicert: [
      ['quit', () => {
        const c = S.cur, cert = hexCert(c.lines), tp = tpOf(dev(), c.tp);
        enter('pkichain', c.tp);
        if (!cert || !tp) return err('% 憑證的內容不完整，無法匯入');
        if (c.ca) tp.ca = cert; else tp.cert = cert;
        return undefined;
      }],
      ['<...>', ([x]) => { if (!/^[0-9A-F ]+$/i.test(x)) return err('% 憑證的內容是十六進位，最後一行輸入 quit 結束'); S.cur.lines.push(x); return undefined; }],
    ],
    flowrec: [
      ['match <...>', ([x]) => { const r = dev().nf.records[S.cur]; r.lines = [...new Set([...r.lines, 'match ' + x.toLowerCase()])]; }],
      ['collect <...>', ([x]) => { const r = dev().nf.records[S.cur]; r.lines = [...new Set([...r.lines, 'collect ' + x.toLowerCase()])]; }],
      ['description <...>', ([x]) => { dev().nf.records[S.cur].desc = x; }],
    ],
    flowexp: [
      ['destination <ip>', ([ip]) => (parseIp(ip) == null ? err('用法：destination <收集器的 IP>') : (dev().nf.exporters[S.cur].ip = ip, undefined))],
      ['transport udp <port>', ([p]) => (+p >= 1 && +p <= 65535 ? (dev().nf.exporters[S.cur].port = +p, undefined) : err('用法：transport udp <埠>'))],
      ['source <...>', ([x]) => { const i = ifByName(x); if (isErr(i)) return i; dev().nf.exporters[S.cur].src = i.id; return undefined; }],
      ['export-protocol <...>', () => undefined],
      ['description <...>', ([x]) => { dev().nf.exporters[S.cur].desc = x; }],
    ],
    flowmon: [
      ['record <...>', ([x]) => {
        const name = x.trim();
        if (!/^netflow /i.test(name) && !(dev().nf.records || {})[name]) return err(`% Flow Record: ${name} does not exist（或用預先定義的 record netflow ipv4 original-input）`);
        dev().nf.monitors[S.cur].record = name;
        return undefined;
      }],
      ['exporter <name>', ([n]) => { if (!(dev().nf.exporters || {})[n]) return err(`% Flow Exporter: ${n} does not exist`); dev().nf.monitors[S.cur].exporter = n; return undefined; }],
      ['no exporter [...]', () => { delete dev().nf.monitors[S.cur].exporter; }],
      ['cache timeout active <n>', ([n]) => { dev().nf.monitors[S.cur].active = +n; }],
      ['cache timeout inactive <n>', ([n]) => { dev().nf.monitors[S.cur].inactive = +n; }],
      ['description <...>', ([x]) => { dev().nf.monitors[S.cur].desc = x; }],
    ],
    ipsecprof: [
      ['set transform-set <name>', ([n]) => {
        if (!(dev().tsets || {})[n]) return err(`ERROR: transform set with tag ${n} does not exist.（先用 crypto ipsec transform-set 定義）`);
        dev().ipsecProfiles[S.cur].tset = n;
        return undefined;
      }],
      ['no set transform-set [...]', () => { delete dev().ipsecProfiles[S.cur].tset; }],
      ['set pfs <g>', ([g]) => { const m = g.toLowerCase().match(/^group(2|5|14|19)$/); if (!m) return err('用法：set pfs group14（支援 group2、group5、group14、group19）'); dev().ipsecProfiles[S.cur].pfs = m[1]; return undefined; }],
      ['no set pfs', () => { delete dev().ipsecProfiles[S.cur].pfs; }],
      ['set ikev2-profile <name>', ([n]) => {
        if (!(((dev().ikev2 || {}).profs) || {})[n]) return err(`% IKEv2 profile ${n} does not exist（先用 crypto ikev2 profile 定義）`);
        dev().ipsecProfiles[S.cur].ikev2 = n;
        return undefined;
      }],
      ['no set ikev2-profile [...]', () => { delete dev().ipsecProfiles[S.cur].ikev2; }],
      ['set security-association lifetime seconds <n>', ([n]) => {
        if (!/^\d+$/.test(n) || +n < 120 || +n > 86400) return err('用法：set security-association lifetime seconds <120-86400>');
        dev().ipsecProfiles[S.cur].life2 = +n;
        return undefined;
      }],
      ['no set security-association lifetime [...]', () => { delete dev().ipsecProfiles[S.cur].life2; }],
      ['description <...>', ([t]) => { dev().ipsecProfiles[S.cur].desc = t; }],
    ],
    ikev2prop: [
      ['encryption <...>', ([list]) => {
        const w = list.toLowerCase().split(/\s+/), v = w.map((x) => ENC_V2[x]);
        if (v.some((x) => !x)) return err('這個模擬支援 encryption aes-cbc-128 與 aes-cbc-256（可以列好幾個）');
        dev().ikev2.props[S.cur].encs = [...new Set(v)];
        return undefined;
      }],
      ['integrity <...>', ([list]) => {
        const w = list.toLowerCase().split(/\s+/), v = w.map((x) => HASH_V2[x]);
        if (v.some((x) => !x)) return err('這個模擬支援 integrity sha1 與 sha256（可以列好幾個）');
        dev().ikev2.props[S.cur].hashes = [...new Set(v)];
        return undefined;
      }],
      ['group <...>', ([list]) => {
        const w = list.split(/\s+/);
        if (!w.every((g) => ['2', '5', '14', '19'].includes(g))) return err('DH 群組支援 2、5、14、19（可以列好幾個）');
        dev().ikev2.props[S.cur].dhs = [...new Set(w)];
        return undefined;
      }],
      ['prf <...>', () => undefined],
    ],
    ikev2pol: [
      ['proposal <name>', ([n]) => {
        const v = dev().ikev2;
        if (!v.props[n]) return err(`% Proposal ${n} does not exist（先用 crypto ikev2 proposal 定義）`);
        const pol = v.pols[S.cur];
        if (!pol.props.includes(n)) pol.props.push(n);
        return undefined;
      }],
      ['no proposal <name>', ([n]) => { const pol = dev().ikev2.pols[S.cur]; pol.props = pol.props.filter((x) => x !== n); }],
      ['match <...>', () => undefined],
    ],
    ikev2kr: [
      ['peer <name>', ([n]) => { dev().ikev2.krs[S.cur].peers[n] ||= {}; enter('ikev2peer', { kr: S.cur, peer: n }); return undefined; }],
      ['no peer <name>', ([n]) => { delete dev().ikev2.krs[S.cur].peers[n]; }],
    ],
    ikev2peer: [
      ['address <ip> [...]', ([ip]) => { if (parseIp(ip) == null) return err('用法：address <對端 IP>'); dev().ikev2.krs[S.cur.kr].peers[S.cur.peer].address = ip; return undefined; }],
      ['pre-shared-key local <...>', ([k]) => { const x = dev().ikev2.krs[S.cur.kr].peers[S.cur.peer]; x.pskLocal = readSecret(k.split(/\s+/)); delete x.psk; }],
      ['pre-shared-key remote <...>', ([k]) => { const x = dev().ikev2.krs[S.cur.kr].peers[S.cur.peer]; x.pskRemote = readSecret(k.split(/\s+/)); delete x.psk; }],
      ['pre-shared-key <...>', ([k]) => { const x = dev().ikev2.krs[S.cur.kr].peers[S.cur.peer]; x.psk = readSecret(k.split(/\s+/)); delete x.pskLocal; delete x.pskRemote; }],
      ['no pre-shared-key [...]', () => { const x = dev().ikev2.krs[S.cur.kr].peers[S.cur.peer]; delete x.psk; delete x.pskLocal; delete x.pskRemote; }],
      ['description <...>', () => undefined],
      // 在 peer 底下直接輸入下一個 peer：和 IOS 一樣回到 keyring 那一層
      ['peer <name>', ([n]) => { const kr = S.cur.kr; dev().ikev2.krs[kr].peers[n] ||= {}; S.cur = { kr, peer: n }; return undefined; }],
    ],
    archive: [
      ['path <url>', ([u]) => {
        if (!/^(boot)?flash:\/?[\w.$-]+$/i.test(u)) return err('用法：path flash:<檔名開頭>，例如 path flash:archive（這個模擬只能封存到 flash）');
        dev().archive.path = u.replace(/\$h/gi, hostName(dev()));
        return undefined;
      }],
      ['no path [...]', () => { delete dev().archive.path; }],
      ['maximum <n>', ([n]) => {
        if (!/^\d+$/.test(n) || +n < 1 || +n > 14) return err('maximum 的範圍是 1 – 14');
        if (!dev().archive.path) return err('%Archive path is not configured（先設定 path）');
        if (+n === ARCH_MAX_DEFAULT) delete dev().archive.max; else dev().archive.max = +n;
        return undefined;
      }],
      ['no maximum [...]', () => { delete dev().archive.max; }],
      ['write-memory', () => { dev().archive.wm = true; }],
      ['no write-memory', () => { delete dev().archive.wm; }],
      ['time-period <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 525600 ? void (dev().archive.period = +n) : err('time-period 的範圍是 1 – 525600 分鐘'))],
      ['no time-period [...]', () => { delete dev().archive.period; }],
      ['log config', () => { dev().archive.log ||= {}; enter('archlog', null); return undefined; }],
      ['no log config', () => { delete dev().archive.log; }],
    ],
    archlog: [
      ['logging enable', () => { dev().archive.log.on = true; }],
      ['no logging enable', () => { delete dev().archive.log.on; }],
      ['logging size <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 1000 ? void (dev().archive.log.size = +n) : err('logging size 的範圍是 1 – 1000'))],
      ['notify syslog [...]', () => { dev().archive.log.notify = true; }],
      ['no notify syslog [...]', () => { delete dev().archive.log.notify; }],
      ['hidekeys', () => { dev().archive.log.hide = true; }],
      ['no hidekeys', () => { delete dev().archive.log.hide; }],
    ],
    vrfdef: [
      ['rd <rd>', ([rd]) => (/^(\d+|\d+\.\d+\.\d+\.\d+):\d+$/.test(rd) ? void (dev().vrfs[S.cur].rd = rd) : err('用法：rd <ASN:編號> 或 rd <IP:編號>，例如 rd 65000:1'))],
      ['no rd [...]', () => { delete dev().vrfs[S.cur].rd; }],
      ['description <...>', ([t]) => { dev().vrfs[S.cur].desc = t; }],
      ['address-family ipv4 [...]', () => { dev().vrfs[S.cur].af4 = true; enter('vrfaf', S.cur); return undefined; }],
      ['no address-family ipv4 [...]', () => { delete dev().vrfs[S.cur].af4; }],
      ['address-family ipv6 [...]', () => err('這個模擬的 VRF 只支援 IPv4')],
    ],
    vrfaf: [
      ['exit-address-family', () => { enter('vrfdef', S.cur); return undefined; }],
      ['route-target <...>', () => undefined],
    ],
    ipvrf: [
      ['rd <rd>', ([rd]) => (/^(\d+|\d+\.\d+\.\d+\.\d+):\d+$/.test(rd) ? void (dev().vrfs[S.cur].rd = rd) : err('用法：rd <ASN:編號>，例如 rd 65000:1'))],
      ['no rd [...]', () => { delete dev().vrfs[S.cur].rd; }],
      ['description <...>', ([t]) => { dev().vrfs[S.cur].desc = t; }],
      ['route-target <...>', () => undefined],
    ],
    track: [
      ['delay <...>', () => err('這個模擬沒有 track 的 delay：狀態一改變就生效')],
    ],
    ipsla: [
      ['icmp-echo <ip> [...]', ([ip, rest]) => {
        if (parseIp(ip) == null) return err('用法：icmp-echo <目的 IP> [source-interface <介面>]');
        const op = dev().sla[S.cur];
        op.dst = ip; op.src = '';
        const m = String(rest || '').match(/^source-(?:interface|ip)\s+(.+)$/i);
        if (rest && !m) return err('用法：icmp-echo <目的 IP> [source-interface <介面>]');
        if (m) {
          const i = ifByName(m[1]);
          if (isErr(i)) return i;
          op.src = i.id;
        }
        enter('slaecho', S.cur);
        return undefined;
      }],
      ...['udp-jitter', 'udp-echo', 'tcp-connect', 'http', 'dns', 'path-echo', 'path-jitter', 'dhcp', 'ethernet'].map((k) => [`${k} [...]`, () => err('這個模擬只支援 icmp-echo（udp-jitter、http 等沒有模擬）')]),
    ],
    slaecho: [
      ['frequency <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 604800 ? void (dev().sla[S.cur].freq = +n) : err('frequency 的範圍是 1 – 604800 秒'))],
      ['no frequency [...]', () => { dev().sla[S.cur].freq = 60; }],
      ['timeout <n>', () => undefined],
      ['threshold <n>', () => undefined],
    ],
    ikev2prof: [
      ['match identity remote address <ip> [...]', ([ip]) => { if (parseIp(ip) == null) return err('用法：match identity remote address <對端 IP> 255.255.255.255'); const p = dev().ikev2.profs[S.cur]; p.remote = ip; delete p.remoteFqdn; delete p.remoteAny; return undefined; }],
      ['match identity remote fqdn domain <name>', ([n]) => { const p = dev().ikev2.profs[S.cur]; p.remoteFqdn = n.toLowerCase(); delete p.remote; delete p.remoteAny; return undefined; }],
      ['no match identity remote [...]', () => { const p = dev().ikev2.profs[S.cur]; delete p.remote; delete p.remoteFqdn; delete p.remoteAny; }],
      ['match identity remote any', () => { const p = dev().ikev2.profs[S.cur]; p.remoteAny = true; delete p.remote; delete p.remoteFqdn; }],
      ['identity local fqdn <name>', ([n]) => { dev().ikev2.profs[S.cur].idFqdn = n.toLowerCase(); }],
      ['identity local address [...]', () => { delete dev().ikev2.profs[S.cur].idFqdn; }],
      ['identity local <...>', () => err('這個模擬支援 identity local address <IP> 與 identity local fqdn <名稱>')],
      ['no identity local [...]', () => { delete dev().ikev2.profs[S.cur].idFqdn; }],
      ['authentication <dir> <method>', ([dir, m]) => {
        const p = dev().ikev2.profs[S.cur], k = 'remote'.startsWith(dir.toLowerCase()) ? 'authR' : 'local'.startsWith(dir.toLowerCase()) ? 'authL' : null;
        const meth = 'pre-share'.startsWith(m.toLowerCase()) ? 'pre-share' : 'rsa-sig'.startsWith(m.toLowerCase()) ? 'rsa-sig' : null;
        if (!k || !meth) return err('用法：authentication remote | local pre-share | rsa-sig（這個模擬沒有 ecdsa-sig 與 eap）');
        if (meth === 'pre-share') delete p[k]; else p[k] = meth;
        return undefined;
      }],
      ['authentication <...>', () => err('用法：authentication remote | local pre-share | rsa-sig')],
      ['pki trustpoint <name> [...]', ([n]) => { if (!tpOf(dev(), n)) return err(`% Trustpoint ${n} does not exist（先用 crypto pki trustpoint ${n} 建立）`); dev().ikev2.profs[S.cur].tp = n; return undefined; }],
      ['no pki trustpoint [...]', () => { delete dev().ikev2.profs[S.cur].tp; }],
      ['keyring local <name>', ([n]) => { if (!dev().ikev2.krs[n]) return err(`% Keyring ${n} does not exist（先用 crypto ikev2 keyring 定義）`); dev().ikev2.profs[S.cur].keyring = n; return undefined; }],
      ['no keyring [...]', () => { delete dev().ikev2.profs[S.cur].keyring; }],
      ['lifetime <n>', ([n]) => (/^\d+$/.test(n) && +n >= 120 && +n <= 86400 ? void (dev().ikev2.profs[S.cur].life = +n === 86400 ? undefined : +n) : err('lifetime 的範圍是 120 – 86400 秒'))],
      ['dpd <...>', () => undefined],
    ],
    bgp: [
      ['bgp router-id <ip>', ([ip]) => (parseIp(ip) == null ? err('用法：bgp router-id <A.B.C.D>') : void (dev().bgp.rid = ip))],
      ['no bgp router-id [...]', () => { delete dev().bgp.rid; }],
      ['bgp log-neighbor-changes', () => undefined],
      ['no bgp default ipv4-unicast', () => undefined],
      ['address-family ipv4 [...]', () => undefined],
      ['exit-address-family', () => undefined],
      ['neighbor <ip> activate', () => undefined],
      ['neighbor <ip> remote-as <asn>', ([ip, asn]) => {
        if (parseIp(ip) == null) return err('用法：neighbor <IP> remote-as <AS>');
        if (!(+asn >= 1)) return err('AS 號碼的範圍是 1 – 4294967295');
        if (ownIp(ip)) return err(`% Cannot configure the local system as neighbor（${ip} 是這台自己的位址）`);
        const b = dev().bgp, cur = b.neighbors.find((n) => n.ip === ip);
        if (cur) {
          // 從 iBGP 改成 eBGP（或反過來）：只有 iBGP 才能用的設定跟著拿掉
          if ((+cur.remoteAs === +b.asn) !== (+asn === +b.asn)) delete cur.rrClient;
          cur.remoteAs = +asn;
        } else b.neighbors.push({ ip, remoteAs: +asn });
        return undefined;
      }],
      ['neighbor <ip> description <...>', ([ip, t]) => nb(ip, (n) => { n.desc = t; })],
      ['neighbor <ip> route-map <name> <dir>', ([ip, name, dir]) => nb(ip, (n) => { n[dir.toLowerCase().startsWith('i') ? 'rmIn' : 'rmOut'] = name; })],
      ['neighbor <ip> prefix-list <name> <dir>', ([ip, name, dir]) => nb(ip, (n) => { n[dir.toLowerCase().startsWith('i') ? 'plIn' : 'plOut'] = name; })],
      ['neighbor <ip> filter-list <num> <dir>', ([ip, num, dir]) => nb(ip, (n) => { n[dir.toLowerCase().startsWith('i') ? 'flIn' : 'flOut'] = num; })],
      ['neighbor <ip> weight <n>', ([ip, w]) => nb(ip, (n) => { n.weight = +w; })],
      ['neighbor <ip> default-originate', ([ip]) => nb(ip, (n) => { n.defOrig = true; })],
      ['neighbor <ip> update-source <...>', ([ip, t]) => { const i = ifByName(t); if (isErr(i)) return i; return nb(ip, (n) => { n.updSrc = i.id; }); }],
      ['no neighbor <ip> update-source [...]', ([ip]) => nb(ip, (n) => { delete n.updSrc; })],
      ['neighbor <ip> next-hop-self [...]', ([ip]) => nb(ip, (n) => { n.nhSelf = true; })],
      ['neighbor <ip> allowas-in [...]', ([ip, k]) => (k && !(/^\d+$/.test(k) && +k >= 1 && +k <= 10) ? err('allowas-in 後面的次數是 1 – 10（預設 3）') : nb(ip, (n) => { n.allowAs = k ? +k : 3; }))],
      ['no neighbor <ip> allowas-in [...]', ([ip]) => nb(ip, (n) => { delete n.allowAs; })],
      ['neighbor <ip> as-override', ([ip]) => nb(ip, (n) => { n.asOverride = true; })],
      ['no neighbor <ip> as-override', ([ip]) => nb(ip, (n) => { delete n.asOverride; })],
      ['no neighbor <ip> next-hop-self [...]', ([ip]) => nb(ip, (n) => { delete n.nhSelf; })],
      ['neighbor <ip> route-reflector-client', ([ip]) => {
        const n = dev().bgp.neighbors.find((x) => x.ip === ip);
        if (n && +n.remoteAs !== +dev().bgp.asn) return err(`% Invalid command for an EBGP peer（route-reflector-client 只能設在 iBGP 鄰居上：${ip} 是 AS ${n.remoteAs}）`);
        return nb(ip, (x) => { x.rrClient = true; });
      }],
      ['no neighbor <ip> route-reflector-client', ([ip]) => nb(ip, (n) => { delete n.rrClient; })],
      ['neighbor <ip> ebgp-multihop [...]', ([ip, ttl]) => {
        const v = ttl ? +ttl : 255;
        if (!(v >= 1 && v <= 255) || (ttl && !/^\d+$/.test(ttl))) return err('用法：neighbor <IP> ebgp-multihop [1-255]');
        const n = dev().bgp.neighbors.find((x) => x.ip === ip);
        if (n && +n.remoteAs === +dev().bgp.asn) return '（ebgp-multihop 只對 eBGP 鄰居有作用：iBGP 本來就可以隔好幾台路由器）';
        return nb(ip, (x) => { x.multihop = v; });
      }],
      ['no neighbor <ip> ebgp-multihop [...]', ([ip]) => nb(ip, (n) => { delete n.multihop; })],
      ['neighbor <ip> disable-connected-check', ([ip]) => nb(ip, (n) => { n.dcc = true; })],
      ['neighbor <ip> fall-over bfd [...]', ([ip]) => nb(ip, (n) => { n.bfd = true; })],
      ['no neighbor <ip> fall-over [...]', ([ip]) => nb(ip, (n) => { delete n.bfd; })],
      ['no neighbor <ip> disable-connected-check', ([ip]) => nb(ip, (n) => { delete n.dcc; })],
      ['neighbor <ip> send-community [...]', ([ip, k]) => nb(ip, (n) => { n.sendComm = /^(both|extended)$/i.test(k || '') ? k.toLowerCase() : 'standard'; })],
      ['no neighbor <ip> send-community [...]', ([ip]) => nb(ip, (n) => { delete n.sendComm; })],
      ['no neighbor <ip> weight [...]', ([ip]) => nb(ip, (n) => { delete n.weight; })],
      ['no neighbor <ip> default-originate', ([ip]) => nb(ip, (n) => { delete n.defOrig; })],
      ['bgp redistribute-internal', () => { dev().bgp.redistInternal = true; }],
      ['no bgp redistribute-internal', () => { delete dev().bgp.redistInternal; }],
      ['neighbor <ip> shutdown', ([ip]) => nb(ip, (n) => { n.shut = true; })],
      ['no neighbor <ip> shutdown', ([ip]) => nb(ip, (n) => { delete n.shut; })],
      ['no neighbor <ip> route-map <name> <dir>', ([ip, , dir]) => nb(ip, (n) => { delete n[dir.toLowerCase().startsWith('i') ? 'rmIn' : 'rmOut']; })],
      ['no neighbor <ip> prefix-list <name> <dir>', ([ip, , dir]) => nb(ip, (n) => { delete n[dir.toLowerCase().startsWith('i') ? 'plIn' : 'plOut']; })],
      ['no neighbor <ip> filter-list <num> <dir>', ([ip, , dir]) => nb(ip, (n) => { delete n[dir.toLowerCase().startsWith('i') ? 'flIn' : 'flOut']; })],
      ['no neighbor <ip> [...]', ([ip]) => { const b = dev().bgp; const had = b.neighbors.length; b.neighbors = b.neighbors.filter((n) => n.ip !== ip); return b.neighbors.length < had ? undefined : err(`沒有 ${ip} 這個鄰居`); }],
      ['network <ip> mask <mask>', ([ip, mask]) => {
        const n = parseIp(ip), bits = maskBits(mask);
        if (n == null || bits == null) return err('用法：network <網段> mask <遮罩>');
        const b = dev().bgp;
        if (!b.networks.some((x) => x.net === netOf(n, bits) && x.bits === bits)) b.networks.push({ net: netOf(n, bits), bits });
        const has = (dev().rt.routes || []).some((r) => r.net === netOf(n, bits) && r.bits === bits && r.type !== 'B') || dev().ifaces.some((i) => { const x = staticNet(i); return x && x.net === netOf(n, bits) && x.bits === bits; });
        return has ? undefined : '（路由表裡還沒有一模一樣的這個網段：BGP 的 network 只會通告路由表裡已經有的網段）';
      }],
      ['no network <ip> mask <mask>', ([ip, mask]) => { const n = parseIp(ip), bits = maskBits(mask); const b = dev().bgp; b.networks = b.networks.filter((x) => !(x.net === netOf(n, bits) && x.bits === bits)); }],
      ['redistribute <src> [...]', ([src, rest]) => {
        const o = redistArgs(src, rest, 'bgp');
        if (isErr(o)) return o;
        upsertRedist((dev().bgp.redist ||= []), o);
        return o.rm && !(dev().routeMaps || {})[o.rm] ? `（route-map ${o.rm} 還不存在：在它建立之前，什麼路都不會被重分配）` : undefined;
      }],
      ['no redistribute <src> [...]', ([src]) => {
        const b = dev().bgp, n = (b.redist || []).length;
        b.redist = (b.redist || []).filter((x) => !x.src.startsWith(String(src).toLowerCase()));
        if (!b.redist.length) delete b.redist;
        return (b.redist || []).length < n ? undefined : err('沒有這一條 redistribute');
      }],
    ],
    rmap: [
      ['match ip address prefix-list <name>', ([name]) => rm((e) => { e.match.pl = name; })],
      ['match as-path <n>', ([n]) => rm((e) => { e.match.fl = n; })],
      ['match ip address <name>', ([name]) => rm((e) => { e.match.acl = /^\d+$/.test(name) ? name : name.toUpperCase(); })],
      ['match tag <n>', ([n]) => (/^\d+$/.test(n) ? rm((e) => { e.match.tag = +n; }) : err('用法：match tag <數字>'))],
      ['match community <name> [...]', ([name]) => rm((e) => { e.match.cl = name; })],
      ['set community <...>', ([list]) => {
        const t = list.split(/\s+/), add = t.includes('additive'), v = t.filter((x) => x !== 'additive');
        if (v.length === 1 && v[0] === 'none') return rm((e) => { e.set.comm = []; delete e.set.commAdd; });
        if (!v.length || v.some((x) => parseComm(x) == null)) return err('用法：set community <AA:NN | no-export | no-advertise | local-AS …> [additive]');
        return rm((e) => { e.set.comm = v.map((x) => x.toLowerCase()); if (add) e.set.commAdd = true; else delete e.set.commAdd; });
      }],
      ['no set community [...]', () => rm((e) => { delete e.set.comm; delete e.set.commAdd; })],
      ['no match ip address [...]', () => rm((e) => { delete e.match.acl; delete e.match.pl; })],
      ['no match [...]', () => rm((e) => { e.match = {}; })],
      ['set local-preference <n>', ([n]) => (+n >= 0 ? rm((e) => { e.set.lp = +n; }) : err('local-preference 是 0 – 4294967295'))],
      ['set as-path prepend <...>', ([list]) => { const v = list.split(/\s+/).map(Number); return v.every((x) => x >= 1) ? rm((e) => { e.set.prepend = v; }) : err('用法：set as-path prepend <AS> <AS> …'); }],
      ['set metric <n>', ([n]) => rm((e) => { e.set.med = +n; })],
      ['set weight <n>', ([n]) => rm((e) => { e.set.weight = +n; })],
      ['set metric-type <t>', ([t]) => { const v = /^(type-?1|internal)$/i.test(t) ? 1 : /^(type-?2|external)$/i.test(t) ? 2 : null; return v ? rm((e) => { e.set.metricType = v; }) : err('用法：set metric-type type-1 | type-2'); }],
      ['set tag <n>', ([n]) => (/^\d+$/.test(n) ? rm((e) => { e.set.tag = +n; }) : err('用法：set tag <數字>'))],
      ['set ip default next-hop <...>', ([list]) => { const v = list.split(/\s+/); return v.every((x) => parseIp(x) != null) ? rm((e) => { e.set.defNh = v; }) : err('用法：set ip default next-hop <IP> [<IP> …]'); }],
      ['set ip next-hop <...>', ([list]) => {
        const v = list.split(/\s+/).filter((x) => !/^(verify-availability|recursive)$/i.test(x));
        return v.length && v.every((x) => parseIp(x) != null) ? rm((e) => { e.set.nh = v; }) : err('用法：set ip next-hop <IP> [<IP> …]（下一站要是直連網段上的位址）');
      }],
      ['no set ip next-hop [...]', () => rm((e) => { delete e.set.nh; })],
      ['no set ip default next-hop [...]', () => rm((e) => { delete e.set.defNh; })],
      ['no set [...]', () => rm((e) => { e.set = {}; })],
      ['description [...]', () => undefined],
    ],
    zone: [['description [...]', ([t]) => { dev().zbf.zones[S.cur].desc = t; return undefined; }]],
    eigrp: [
      ['network <ip> [...]', ([ip, w]) => {
        const net = parseIp(ip), bits = w ? wildBits(w) : classBitsOf(net);
        if (net == null || bits == null) return err('用法：network <網段> [萬用遮罩]，例如 network 10.0.0.0 0.0.0.255');
        const e = dev().eigrp, s = { net: netOf(net, bits), bits };
        e.nets = [...(e.nets || []).filter((n) => !(n.net === s.net && n.bits === s.bits)), s];
        const hit = dev().ifaces.filter((i) => { const n = staticNet(i), a = n ? n.ip : i.rt && i.rt.ip; return !i.vrf && a != null && netOf(a, bits) === s.net; });
        return hit.length ? `EIGRP 已在 ${hit.map((i) => i.label).join('、')} 啟用` : '（目前還沒有介面的 IP 落在這個範圍內；之後設定了符合的 IP，那個介面就會自動加入 EIGRP）';
      }],
      ['no network <ip> [...]', ([ip, w]) => {
        const net = parseIp(ip), bits = w ? wildBits(w) : classBitsOf(net);
        if (net == null || bits == null) return err('用法：no network <網段> [萬用遮罩]');
        const e = dev().eigrp, had = (e.nets || []).length;
        e.nets = (e.nets || []).filter((n) => !(n.net === netOf(net, bits) && n.bits === bits));
        return e.nets.length < had ? undefined : err('沒有這一條 network 敘述');
      }],
      ['passive-interface default', () => { const e = dev().eigrp; e.passiveDefault = true; delete e.passive; return undefined; }],
      ['no passive-interface default', () => { const e = dev().eigrp; delete e.passiveDefault; delete e.noPassive; return undefined; }],
      ['passive-interface <if>', ([t]) => {
        const r = resolveIf(dev(), t); if (isErr(r)) return r;
        const e = dev().eigrp, id = (r.iface || {}).id;
        if (!id) return err('這個介面沒有 IP（不能當 L3 介面）');
        if (e.passiveDefault) e.noPassive = (e.noPassive || []).filter((x) => x !== id); else e.passive = [...new Set([...(e.passive || []), id])];
        return undefined;
      }],
      ['no passive-interface <if>', ([t]) => {
        const r = resolveIf(dev(), t); if (isErr(r)) return r;
        const e = dev().eigrp, id = (r.iface || {}).id;
        if (!id) return err('這個介面沒有 IP');
        if (e.passiveDefault) e.noPassive = [...new Set([...(e.noPassive || []), id])]; else e.passive = (e.passive || []).filter((x) => x !== id);
        return undefined;
      }],
      ['eigrp router-id <ip>', ([ip]) => (parseIp(ip) == null ? err('Router ID 要寫成 IP 位址的格式') : void (dev().eigrp.rid = ip))],
      ['no eigrp router-id [...]', () => { delete dev().eigrp.rid; }],
      ['eigrp log-neighbor-changes', () => undefined],
      ['no eigrp log-neighbor-changes', () => undefined],
      ['variance <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 128 ? void (+n === 1 ? delete dev().eigrp.variance : (dev().eigrp.variance = +n)) : err('variance 是 1 – 128'))],
      ['no variance [...]', () => { delete dev().eigrp.variance; }],
      ['maximum-paths <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 32 ? void (+n === 4 ? delete dev().eigrp.maxPaths : (dev().eigrp.maxPaths = +n)) : err('maximum-paths 是 1 – 32'))],
      ['no maximum-paths [...]', () => { delete dev().eigrp.maxPaths; }],
      ['metric weights <tos> <k1> <k2> <k3> <k4> <k5>', ([, ...k]) => {
        const v = k.map(Number);
        if (v.some((x, n) => !/^\d+$/.test(k[n]) || x > 255)) return err('用法：metric weights 0 <K1> <K2> <K3> <K4> <K5>（0 – 255）');
        if (v.join() === '1,0,1,0,0') delete dev().eigrp.k; else dev().eigrp.k = v;
        return undefined;
      }],
      ['no metric weights [...]', () => { delete dev().eigrp.k; }],
      ['auto-summary', () => err('這個模擬只支援 no auto-summary（IOS 15 之後的預設，不會自動彙總成有類別的網段）')],
      ['no auto-summary', () => undefined],
      ['default-metric <bw> <dly> <rel> <load> <mtu>', (a) => {
        const v = a.map(Number);
        if (v.some((x) => !Number.isFinite(x) || x < 0) || v[0] < 1) return err('用法：default-metric <頻寬 kbps> <延遲 十微秒> <可靠度> <負載> <MTU>，例如 default-metric 10000 100 255 1 1500');
        dev().eigrp.defMetric = v;
        return undefined;
      }],
      ['no default-metric [...]', () => { delete dev().eigrp.defMetric; }],
      ['redistribute <src> [...]', ([src, rest]) => {
        const s = String(src).toLowerCase(), t = String(rest || '').split(/\s+/).filter(Boolean);
        const kind = 'static'.startsWith(s) ? 'static' : 'connected'.startsWith(s) ? 'connected' : 'ospf'.startsWith(s) ? 'ospf' : null;
        if (!kind) return err('這個模擬的 EIGRP 可以重分配 static、connected、ospf <程序>');
        const mi = t.indexOf('metric');
        let metric = null;
        if (mi >= 0) {
          metric = t.slice(mi + 1, mi + 6).map(Number);
          if (metric.length !== 5 || metric.some((x) => !Number.isFinite(x) || x < 0) || metric[0] < 1) return err('metric 要寫五個值：頻寬 (kbps) 延遲 (十微秒) 可靠度 負載 MTU，例如 metric 10000 100 255 1 1500');
        }
        const e = dev().eigrp;
        e.redist = [...(e.redist || []).filter((r) => r.src !== kind), { src: kind, ...(kind === 'ospf' ? { pid: +t[0] || 1 } : {}), ...(metric ? { metric } : {}) }];
        return kind !== 'connected' && !metric && !e.defMetric ? '（還沒有種子 metric：static / OSPF 的路要有 metric 或 default-metric 才會宣告出去）' : undefined;
      }],
      ['no redistribute <src> [...]', ([src]) => { const e = dev().eigrp, s = String(src).toLowerCase(); e.redist = (e.redist || []).filter((r) => !r.src.startsWith(s)); if (!e.redist.length) delete e.redist; return undefined; }],
    ],
    mstcfg: [
      ['name <n>', ([n]) => { dev().sw.stp.mst.name = n; }],
      ['no name', () => { delete dev().sw.stp.mst.name; }],
      ['revision <n>', ([n]) => (/^\d+$/.test(n) && +n <= 65535 ? void (dev().sw.stp.mst.rev = +n) : err('revision 是 0 – 65535'))],
      ['no revision', () => { delete dev().sw.stp.mst.rev; }],
      ['instance <id> vlan <list>', ([id, list]) => {
        if (!/^\d+$/.test(id) || +id < 1 || +id > 4094) return err('instance 是 1 – 4094（instance 0 是 CIST，不用設定）');
        const nums = vlanNums(list);
        if (!nums || nums === 'all') return err('VLAN 清單的格式：10,20 或 10-20');
        const m = dev().sw.stp.mst, map = (m.map ||= {});
        for (const [k, l] of Object.entries(map)) map[k] = l.filter((v) => !nums.includes(v)); // 一個 VLAN 只能在一個 instance
        map[+id] = [...new Set([...(map[+id] || []), ...nums])].sort((a, b) => a - b);
        for (const k of Object.keys(map)) if (!map[k].length) delete map[k];
        return undefined;
      }],
      ['no instance <id> [...]', ([id]) => { const map = dev().sw.stp.mst.map || {}; delete map[+id]; return undefined; }],
      ['show current', () => undefined],
      ['show pending', () => undefined],
    ],
    trange: [
      ['periodic <...>', ([rest]) => {
        const p = parsePeriodic(String(rest).split(/\s+/));
        if (typeof p === 'string') return err(p);
        const l = dev().timeRanges[S.cur];
        if (!l.some((x) => x.text === p.text)) l.push(p);
        return undefined;
      }],
      ['no periodic <...>', ([rest]) => {
        const p = parsePeriodic(String(rest).split(/\s+/));
        if (typeof p === 'string') return err(p);
        const tr = dev().timeRanges, n = tr[S.cur].length;
        tr[S.cur] = tr[S.cur].filter((x) => x.text !== p.text);
        return tr[S.cur].length < n ? undefined : err('沒有這一條 periodic');
      }],
      ['absolute [...]', () => err('這個模擬的 time-range 只支援 periodic（每週固定的時段）')],
    ],
    rip: [
      ['version <v>', ([v]) => (v === '1' || v === '2' ? void (dev().rip.ver = +v) : err('version 1 或 version 2'))],
      ['no version [...]', () => { delete dev().rip.ver; }],
      ['network <ip>', ([ip]) => {
        const a = parseIp(ip);
        if (a == null) return err('用法：network <主網段>，例如 network 10.0.0.0');
        const n = netOf(a, classBitsOf(a)), r = dev().rip;
        r.nets = [...new Set([...(r.nets || []), n])];
        const hit = dev().ifaces.filter((i) => { const s = staticNet(i), x = s ? s.ip : i.rt && i.rt.ip; return !i.vrf && x != null && netOf(x, classBitsOf(n)) === n; });
        const note = n !== a ? `（RIP 的 network 只能寫有類別的主網段：記成 network ${fmtIp(n)}）` : '';
        return (note + (hit.length ? `RIP 已在 ${hit.map((i) => i.label).join('、')} 啟用` : '')) || undefined;
      }],
      ['no network <ip>', ([ip]) => {
        const a = parseIp(ip);
        if (a == null) return err('用法：no network <主網段>');
        const n = netOf(a, classBitsOf(a)), r = dev().rip, had = (r.nets || []).length;
        r.nets = (r.nets || []).filter((x) => x !== n);
        return r.nets.length < had ? undefined : err('沒有這一條 network 敘述');
      }],
      ['passive-interface default', () => { const r = dev().rip; r.passiveDefault = true; delete r.passive; return undefined; }],
      ['no passive-interface default', () => { const r = dev().rip; delete r.passiveDefault; delete r.noPassive; return undefined; }],
      ['passive-interface <if>', ([t]) => {
        const x = resolveIf(dev(), t); if (isErr(x)) return x;
        const r = dev().rip, id = (x.iface || {}).id;
        if (!id) return err('這個介面沒有 IP（不能當 L3 介面）');
        if (r.passiveDefault) r.noPassive = (r.noPassive || []).filter((y) => y !== id); else r.passive = [...new Set([...(r.passive || []), id])];
        return undefined;
      }],
      ['no passive-interface <if>', ([t]) => {
        const x = resolveIf(dev(), t); if (isErr(x)) return x;
        const r = dev().rip, id = (x.iface || {}).id;
        if (!id) return err('這個介面沒有 IP');
        if (r.passiveDefault) r.noPassive = [...new Set([...(r.noPassive || []), id])]; else r.passive = (r.passive || []).filter((y) => y !== id);
        return undefined;
      }],
      ['auto-summary', () => { delete dev().rip.auto; }],
      ['no auto-summary', () => { dev().rip.auto = false; }],
      ['default-information originate [...]', () => { dev().rip.defOrig = true; }],
      ['no default-information originate [...]', () => { delete dev().rip.defOrig; }],
      ['default-metric <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 16 ? void (dev().rip.defMetric = +n) : err('RIP 的 default-metric 是跳數 1 – 16'))],
      ['no default-metric [...]', () => { delete dev().rip.defMetric; }],
      ['maximum-paths <n>', ([n]) => (/^\d+$/.test(n) && +n >= 1 && +n <= 32 ? void (+n === 4 ? delete dev().rip.maxPaths : (dev().rip.maxPaths = +n)) : err('maximum-paths 是 1 – 32'))],
      ['no maximum-paths [...]', () => { delete dev().rip.maxPaths; }],
      ['timers basic <u> <i> <h> <f>', (a) => {
        const v = a.map(Number);
        if (v.some((x, k) => !/^\d+$/.test(a[k]) || x < 1)) return err('用法：timers basic <更新> <invalid> <holddown> <flush>（秒），預設 30 180 180 240');
        if (v.join() === '30,180,180,240') delete dev().rip.timers; else dev().rip.timers = v;
        return undefined;
      }],
      ['no timers basic [...]', () => { delete dev().rip.timers; }],
      ['redistribute <src> [...]', ([src, rest]) => {
        const s = String(src).toLowerCase(), t = String(rest || '').split(/\s+/).filter(Boolean);
        const kind = ['static', 'connected', 'ospf', 'eigrp'].find((k) => k.startsWith(s) && s.length >= 2);
        if (!kind) return err('這個模擬的 RIP 可以重分配 static、connected、ospf <程序>、eigrp <AS>');
        const o = { src: kind };
        let k = 0;
        if (kind === 'ospf' || kind === 'eigrp') {
          if (!/^\d+$/.test(t[0] || '')) return err(`用法：redistribute ${kind} <${kind === 'ospf' ? '程序號碼' : 'AS 號碼'}> [metric <跳數>]`);
          o.as = +t[0]; k = 1;
        }
        for (; k < t.length; k++) {
          if (t[k] === 'metric' && /^\d+$/.test(t[k + 1] || '') && +t[k + 1] >= 1 && +t[k + 1] <= 16) { o.metric = +t[++k]; continue; }
          if (t[k] === 'metric' && t[k + 1] === 'transparent') { k++; continue; }
          return err(`% 看不懂「${t[k]}」：redistribute 後面可以接 metric <跳數 1 – 16>`);
        }
        const r = dev().rip;
        r.redist = [...(r.redist || []).filter((x) => x.src !== kind), o];
        return (kind === 'ospf' || kind === 'eigrp') && o.metric == null && r.defMetric == null ? '（沒有給 metric：從 OSPF / EIGRP 重分配進 RIP 的路預設是 16（到不了），要加 metric <跳數> 或 default-metric）' : undefined;
      }],
      ['no redistribute <src> [...]', ([src]) => { const r = dev().rip, s = String(src).toLowerCase(); r.redist = (r.redist || []).filter((x) => !x.src.startsWith(s)); if (!r.redist.length) delete r.redist; return undefined; }],
    ],
    keychain: [
      ['key <id>', ([id]) => {
        if (!/^\d+$/.test(id) || +id > 2147483647) return err('key 的編號是 0 – 2147483647');
        const l = dev().keyChains[S.cur];
        if (!l.some((k) => k.id === +id)) l.push({ id: +id, str: '' });
        enter('kckey', { chain: S.cur, id: +id });
        return undefined;
      }],
      ['no key <id>', ([id]) => { const kc = dev().keyChains; kc[S.cur] = kc[S.cur].filter((k) => k.id !== +id); return undefined; }],
    ],
    kckey: [
      ['key-string <...>', ([s]) => { const k = dev().keyChains[S.cur.chain].find((x) => x.id === S.cur.id); k.str = s; return undefined; }],
      ['no key-string [...]', () => { const k = dev().keyChains[S.cur.chain].find((x) => x.id === S.cur.id); k.str = ''; return undefined; }],
    ],
    icmap: [
      ['match protocol <p>', ([p]) => {
        const v = p.toLowerCase();
        if (!ZBF_PROTO[v]) return err(`這個模擬的 match protocol 認得：${Object.keys(ZBF_PROTO).join('、')}`);
        const m = dev().zbf.cmaps[S.cur];
        if (!m.match.some((x) => x.t === 'protocol' && x.v === v)) m.match.push({ t: 'protocol', v });
        return undefined;
      }],
      ['match access-group name <n>', ([n]) => { const m = dev().zbf.cmaps[S.cur]; if (!m.match.some((x) => x.t === 'acl' && x.v === n.toUpperCase())) m.match.push({ t: 'acl', v: n.toUpperCase() }); return undefined; }],
      ['match access-group <n>', ([n]) => { const m = dev().zbf.cmaps[S.cur]; if (!m.match.some((x) => x.t === 'acl' && x.v === n.toUpperCase())) m.match.push({ t: 'acl', v: n.toUpperCase() }); return undefined; }],
      ['no match protocol <p>', ([p]) => { const m = dev().zbf.cmaps[S.cur]; m.match = m.match.filter((x) => !(x.t === 'protocol' && x.v === p.toLowerCase())); return undefined; }],
      ['no match access-group [...]', ([r]) => { const m = dev().zbf.cmaps[S.cur], n = String(r || '').split(/\s+/).pop().toUpperCase(); m.match = m.match.filter((x) => !(x.t === 'acl' && (!n || x.v === n))); return undefined; }],
      ['description [...]', () => undefined],
    ],
    ipmap: [
      ['class type inspect <name>', ([n]) => zClass(n)],
      ['class class-default', () => zClass('class-default')],
      ['no class type inspect <name>', ([n]) => { const pm = dev().zbf.pmaps[S.cur.pm]; const k = pm.findIndex((c) => c.cls === n); if (k < 0) return err(`class ${n} 不在這個政策裡`); pm.splice(k, 1); return undefined; }],
      ['description [...]', () => undefined],
    ],
    ipmapc: [
      ['class type inspect <name>', ([n]) => zClass(n)],
      ['class class-default', () => zClass('class-default')],
      ['inspect [...]', () => zAct('inspect')],
      ['pass [...]', () => zAct('pass')],
      ['drop [...]', ([r]) => zAct('drop', /\blog\b/i.test(r || ''))],
      ['no inspect [...]', () => zAct('drop')],
      ['no pass [...]', () => zAct('drop')],
      ['no drop [...]', () => zAct('drop')],
    ],
    zpair: [
      ['service-policy type inspect <pm>', ([pm]) => { const z = dev().zbf; if (!z.pmaps[pm]) return err(`Policy map ${pm} not configured（policy-map type inspect ${pm}）`); z.pairs[S.cur].policy = pm; return undefined; }],
      ['no service-policy type inspect [...]', () => { delete dev().zbf.pairs[S.cur].policy; return undefined; }],
      ['description [...]', () => undefined],
    ],
    qcmap: [
      ['match any', () => addMatch({ t: 'any' })],
      ['match ip dscp <...>', ([l]) => matchDscp(l)],
      ['match dscp <...>', ([l]) => matchDscp(l)],
      ['match cos <...>', ([l]) => { const v = l.split(/\s+/).map(Number); return v.every((x) => x >= 0 && x <= 7) ? addMatch({ t: 'cos', v }) : err('CoS 的範圍是 0 – 7'); }],
      ['match access-group name <n>', ([n]) => addMatch({ t: 'acl', v: n.toUpperCase() })],
      ['match access-group <n>', ([n]) => addMatch({ t: 'acl', v: n.toUpperCase() })],
      ['match protocol <p> [...]', ([p]) => { const v = ['rtp', 'sip'].find((x) => x === p.toLowerCase()); return v ? addMatch({ t: 'protocol', v }) : err('這個模擬的 NBAR 只認得 rtp（語音）和 sip（訊令）'); }],
      ['no match <...>', ([rest]) => {
        const m = dev().classMaps[S.cur], t = rest.toLowerCase().split(/\s+/);
        const kind = t[0] === 'ip' ? t[1] : t[0];
        m.rules = m.rules.filter((r) => !(r.t === (kind === 'access-group' ? 'acl' : kind)));
        return undefined;
      }],
      ['description [...]', () => undefined],
    ],
    pmap: [
      ['class <name>', ([name]) => pmClass(name)],
      ['no class <name>', ([name]) => { const pm = dev().policyMaps[S.cur.pm]; const n = pm.findIndex((c) => c.cls === name); if (n < 0) return err(`class ${name} 不在這個政策裡`); pm.splice(n, 1); return undefined; }],
      ['description [...]', () => undefined],
    ],
    pmapc: [
      ['class <name>', ([name]) => pmClass(name)],
      ['priority percent <n>', ([n]) => (+n >= 1 && +n <= 100 ? pmSet((c) => (c.bandwidth ? err('Only one of bandwidth or priority can be configured in a class') : void (c.priority = { pct: +n }))) : err('percent 的範圍是 1 – 100'))],
      ['priority level <l> [...]', ([, ...rest]) => pmSet((c) => { const m = String(rest).match(/percent (\d+)/); c.priority = m ? { pct: +m[1] } : { pct: 100 }; })],
      ['priority <kbps> [...]', ([k]) => (+k >= 8 ? pmSet((c) => (c.bandwidth ? err('Only one of bandwidth or priority can be configured in a class') : void (c.priority = { kbps: +k }))) : err('用法：priority <kbps> 或 priority percent <n>'))],
      ['no priority [...]', () => pmSet((c) => { delete c.priority; })],
      ['bandwidth remaining percent <n>', ([n]) => pmSet((c) => (c.priority ? err('Only one of bandwidth or priority can be configured in a class') : void (c.bandwidth = { rpct: +n })))],
      ['bandwidth percent <n>', ([n]) => (+n >= 1 && +n <= 100 ? pmSet((c) => (c.priority ? err('Only one of bandwidth or priority can be configured in a class') : void (c.bandwidth = { pct: +n }))) : err('percent 的範圍是 1 – 100'))],
      ['bandwidth <kbps>', ([k]) => (+k >= 8 ? pmSet((c) => (c.priority ? err('Only one of bandwidth or priority can be configured in a class') : void (c.bandwidth = { kbps: +k }))) : err('用法：bandwidth <kbps> | percent <n> | remaining percent <n>'))],
      ['no bandwidth [...]', () => pmSet((c) => { delete c.bandwidth; })],
      ['set ip dscp <v>', ([v]) => setDscp(v)],
      ['set dscp <v>', ([v]) => setDscp(v)],
      ['no set [...]', () => pmSet((c) => { delete c.set; })],
      ['police cir <bps> [...]', ([b]) => (+b >= 8000 ? pmSet((c) => { c.police = { bps: +b }; }) : err('用法：police cir <bps>，例如 police cir 1000000'))],
      ['police <bps> [...]', ([b]) => (+b >= 8000 ? pmSet((c) => { c.police = { bps: +b }; }) : err('用法：police <bps>'))],
      ['no police [...]', () => pmSet((c) => { delete c.police; })],
      // running-config 在 police 底下印出 conform-action / exceed-action：貼回去時照單全收（這個模擬固定是 transmit / drop）
      ['conform-action <...>', () => undefined],
      ['exceed-action <...>', () => undefined],
      ['violate-action <...>', () => undefined],
      ['shape average <bps> [...]', ([b]) => (+b >= 8000 ? pmSet((c) => { c.shape = { bps: +b }; }) : err('用法：shape average <bps>，例如 shape average 20000000'))],
      ['no shape [...]', () => pmSet((c) => { delete c.shape; })],
      ['service-policy <name>', ([n]) => { const d = dev(); if (!(d.policyMaps || {})[n]) return err(`policy map ${n} not configured`); if (n === S.cur.pm) return err('政策不能套用自己'); return pmSet((c) => { c.child = n; }); }],
      ['no service-policy [...]', () => pmSet((c) => { delete c.child; })],
      ['fair-queue [...]', () => pmSet((c) => { c.fq = true; })],
      ['no fair-queue', () => pmSet((c) => { delete c.fq; })],
      ['queue-limit <n> [...]', ([n]) => (+n >= 1 && +n <= 8192 ? pmSet((c) => { c.qlimit = +n; }) : err('queue-limit 的範圍是 1 – 8192'))],
      ['no queue-limit [...]', () => pmSet((c) => { delete c.qlimit; })],
    ],
    cmap: [
      ['set peer <ip>', ([ip]) => {
        if (parseIp(ip) == null) return err('IP 位址的格式不正確');
        const d = dev(), t = S.cur;
        t.peer = ip;
        if (d.ikeKeys && d.ikeKeys[ip]) t.psk = d.ikeKeys[ip];
        if (t.ikev2) return undefined; // IKEv2 的金鑰在 keyring
        return t.psk ? undefined : `（還沒有給 ${ip} 的預先共用金鑰：crypto isakmp key <金鑰> address ${ip}）`;
      }],
      ['set transform-set <name>', ([name]) => {
        const set = (dev().tsets || {})[name];
        if (!set) return err(`ERROR: transform set with tag ${name} does not exist.（先用 crypto ipsec transform-set 定義）`);
        Object.assign(S.cur, { tset: name }, set);
        return undefined;
      }],
      ['set ikev2-profile <name>', ([n]) => {
        const v = (dev().ikev2 || {}).profs || {};
        if (!v[n]) return err(`% IKEv2 profile ${n} does not exist（先用 crypto ikev2 profile 定義）`);
        S.cur.ikev2 = n;
        delete S.cur.ike;
        return undefined;
      }],
      ['no set ikev2-profile [...]', () => { delete S.cur.ikev2; }],
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
    // AAA：遠端登入的人打的 15 級指令，先問 TACACS+ 能不能執行（authorization），再送去記錄（accounting）
    if (who && who.user && dev().aaa && dev().aaa.on && S.priv >= 15) {
      const deny = aaaAuthorize(getState(), dev(), who.user, S.priv, text);
      if (deny) { out.push(deny); return done(false); }
      aaaAccount(getState(), dev(), who, S.priv, text);
    }
    if (S.mode === 'exec' && S.priv < 15) {
      if (match(tok, 'enable') || match(tok, 'enable 15')) {
        const sec = (dev().mgmt || {}).enableSecret;
        if (!sec && !(who && /vty/i.test(String(who.line || '')))) { S.priv = 15; return done(false); }
        if (!sec) { out.push('% No password set'); out.push('（遠端登入要先在設備上設定 enable secret，才能從使用者模式進入特權模式；或用 privilege 15 的帳號登入）'); return done(false); }
        out.push('Password: ');
        S.pending = { secret: true, fn: (ans, o2) => {
          if (ans === sec) { S.pending = null; S.priv = 15; S.tries = 0; return { out: o2, changed: false }; }
          S.tries++;
          if (S.tries >= 3) { S.pending = null; S.tries = 0; o2.push('% Bad secrets'); return { out: o2, changed: false }; }
          o2.push('% Access denied', 'Password: ');
          return { out: o2, changed: false };
        } };
        return done(false);
      }
      if (match(tok, 'disable') || match(tok, 'terminal <...>')) return done(false);
      // 使用者模式只看得到一部分：設定相關的指令都不存在
      const view = /^sh/i.test(tok[0]) && !(tok[1] && /^(run|start|arch|flash|tech|aaa|priv)/i.test(tok[1]));
      if (view || /^(ping|tracer|traceroute|telnet|ssh|exit|logout|quit)$/i.test(tok[0])) return { out, changed: false, pass: true };
      out.push(err(`Invalid input detected：使用者模式 (>) 不能用「${text}」，先 enable 進入特權模式 (#)`));
      return done(false);
    }
    if (S.mode === 'exec') {
      if (match(tok, 'disable')) { S.priv = 1; return done(false); }
      if (tok[0] === 'clear' && (tok[1] || '') === 'ip' && (tok[2] || '').startsWith('bg') && tok[3]) {
        // clear ip bgp *：重設所有鄰居（要重新建立）；加上 soft 只重新套用政策
        if (!(tok.length > 4 && 'soft'.startsWith(tok[4]))) {
          const st = getState();
          for (const k of Object.keys((st.dyn && st.dyn.bgp) || {})) if (k.split('|').some((x) => x.startsWith(dev().id + '>') && (tok[3] === '*' || x.endsWith('>' + tok[3])))) delete st.dyn.bgp[k];
        }
        recompute(getState());
        return done(false);
      }
      if (match(tok, 'clear ip ospf process') || match(tok, 'clear ip ospf <n> process')) {
        out.push('Reset ALL OSPF processes? [no]: ');
        S.pending = { fn: (ans, o2) => { S.pending = null; if (!/^y/i.test(ans.trim())) return { out: o2, changed: false }; clearOspfAll(getState(), dev()); recompute(getState()); o2.push('（OSPF 程序重新啟動：重新選 Router ID，所有鄰居關係從頭建立）'); return { out: o2, changed: true }; } };
        return done(false);
      }
      if (match(tok, 'clear ipv6 ospf process') || match(tok, 'clear ipv6 ospf <n> process')) {
        out.push('Reset OSPF process? [no]: ');
        S.pending = { fn: (ans, o2) => { S.pending = null; if (!/^y/i.test(ans.trim())) return { out: o2, changed: false }; clearOspfProcess(getState(), dev(), '6'); recompute(getState()); o2.push('（OSPFv3 程序重新啟動：重新選 Router ID，所有鄰居關係從頭建立）'); return { out: o2, changed: true }; } };
        return done(false);
      }
      if (match(tok, 'clear ipv6 dhcp binding [...]')) { const st = getState(); if (st.dyn && st.dyn.lease6) delete st.dyn.lease6[dev().id]; recompute(st); return done(false); }
      if (match(tok, 'clear cdp table')) { clearNeighbors(getState(), dev(), 'cdp'); return done(false); }
      if (match(tok, 'clear lldp table')) { clearNeighbors(getState(), dev(), 'lldp'); return done(false); }
      if (match(tok, 'clear cdp counters') || match(tok, 'clear lldp counters')) { const c = ((getState().dyn.ndCnt ||= {})[dev().id] ||= {}); const k = tok[1].toLowerCase().startsWith('c') ? 'cdp' : 'lldp'; c[k + 'Out'] = 0; c[k + 'In'] = 0; return done(false); }
      if (match(tok, 'archive config')) {
        const r = archiveRunning(getState(), dev());
        if (r.err) { out.push(r.err); return done(false); }
        return done(true);
      }
      const cr = match(tok, 'configure replace <file> [...]');
      if (cr) return configReplace(cr[0], cr[1] || '', out);
      if (match(tok, 'configure terminal') || match(tok, 'configure')) { S.mode = 'config'; out.push('Enter configuration commands, one per line.  End with CNTL/Z.'); return done(false); }
      if (match(tok, 'enable') || match(tok, 'disable') || match(tok, 'end') || match(tok, 'terminal <...>')) return done(false);
      if (match(tok, 'write') || match(tok, 'write memory') || match(tok, 'copy running-config startup-config')) {
        saveStartup(dev());
        out.push('Building configuration...', '[OK]');
        if (dev().archive && dev().archive.wm) { const r = archiveRunning(getState(), dev()); if (r.err) out.push(r.err); }
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
        // IOS 的訊息：from 舊的時間 to 新的時間（不含毫秒與 * 記號）
        const clk = () => iosClock(getState(), dev()).replace(/^[*.]/, '').replace(/[.][0-9]{3}/, '');
        const was = clk();
        setClock(getState(), dev(), Date.UTC(+m[6], mo, day, +m[1], +m[2], +m[3]) - tz.off * 3600000);
        logEvent(getState(), dev(), 6, 'SYS-6-CLOCKUPDATE', `System clock has been updated from ${was} to ${clk()}, configured from console by console.`);
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
    if (match(tok, 'exit') && S.mode === 'pmapc') { S.mode = 'pmap'; S.cur = { pm: S.cur.pm }; return done(false); }
    if (match(tok, 'exit') && S.mode === 'ipmapc') { S.mode = 'ipmap'; S.cur = { pm: S.cur.pm }; return done(false); }
    if (match(tok, 'exit') && S.mode === 'kckey') { S.mode = 'keychain'; S.cur = S.cur.chain; return done(false); }
    if (match(tok, 'exit') && S.mode === 'ikev2peer') { S.mode = 'ikev2kr'; S.cur = S.cur.kr; return done(false); }
    // 巢狀的子模式：exit 只回到上一層（和真的 IOS 一樣）
    if (match(tok, 'exit') && S.mode === 'archlog') { S.mode = 'archive'; S.cur = null; return done(false); }
    if (match(tok, 'exit') && S.mode === 'vrfaf') { S.mode = 'vrfdef'; return done(false); }
    if (match(tok, 'exit') && S.mode === 'slaecho') { S.mode = 'ipsla'; return done(false); }
    if (match(tok, 'exit') && S.mode === 'ikev2peer') { S.mode = 'ikev2kr'; S.cur = S.cur.kr; return done(false); }
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
    const aclMode = S.mode === 'acl' || S.mode === 'stdacl' || S.mode === 'acl6';
    const trySub = S.mode !== 'config' && (!aclMode || /^(\d+\s+|sequence\s+\d+\s+)?(permit|deny|evaluate)\b/i.test(text) || /^no\s+(\d+|sequence\s+\d+|permit\b|deny\b)/i.test(text));
    let res = trySub ? run(SUB[S.mode], tok, out) : { hit: false };
    let viaSub = res.hit;
    // 巢狀的子模式不認得的指令，先往上一層找（例如貼上設定時 log config 底下接著 archive 的 path）
    const UP = { vrfaf: ['vrfdef', (c) => c], archlog: ['archive', () => null], slaecho: ['ipsla', (c) => c], ikev2peer: ['ikev2kr', (c) => c.kr], pmapc: ['pmap', (c) => ({ pm: c.pm })], ipmapc: ['ipmap', (c) => ({ pm: c.pm })], kckey: ['keychain', (c) => c.chain] };
    if (!res.hit && trySub && UP[S.mode]) {
      const [pm, pc] = UP[S.mode], prev = S.mode, prevCur = S.cur;
      S.mode = pm; S.cur = pc(prevCur);
      res = run(SUB[pm], tok, out);
      if (!res.hit || isErr(res.r)) { S.mode = prev; S.cur = prevCur; res = { hit: false }; } else viaSub = true;
    }
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
    logCfg(text, viaSub);
    return done(true);
  }

  /** PKI：連到 enrollment url（SCEP，TCP 80），回傳 { caDev } 或錯誤說明 */
  function pkiReach(tp) {
    const d = dev(), st = getState(), tgt = urlTarget(tp.url);
    if (!tgt) return { why: '' };
    const r = transact(st, d.id, { proto: 'tcp', dst: tgt.ip, dport: tgt.port, quiet: true });
    if (!r.ok) return { why: `連不到 ${fmtIp(tgt.ip)} 的 TCP ${tgt.port}：${r.reason}` };
    const caDev = st.devices[r.responder];
    if (!caDev || !caDev.ca) return { why: `${caDev ? caDev.name : fmtIp(tgt.ip)} 不是 CA（沒有提供 SCEP 的憑證服務）` };
    return { caDev };
  }
  const pkiLog = (v) => { const m = /^%([^:]+): (.*)$/.exec(v.log); if (m) logEvent(getState(), dev(), 3, m[1], m[2]); };
  /** 指紋：同一張憑證每次都一樣（看起來像 MD5 / SHA1） */
  const fp = (cert, n) => { let h = 2166136261; const s = cert.cn + cert.serial + cert.from + '/' + n; const out = []; for (let i = 0; i < n; i++) { for (const ch of s + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); out.push((h >>> 0).toString(16).toUpperCase().padStart(8, '0')); } return out.join(' '); };
  /** crypto pki authenticate：向 CA 取得它的根憑證，確認指紋之後存進 trustpoint */
  function pkiAuthenticate(n, o) {
    const d = dev(), st = getState(), tp = tpOf(d, n);
    if (!tp) { o.push(`% Trustpoint ${n} not found`); return { out: o, changed: false }; }
    if (!tp.url) { o.push(`% You must configure an enrollment url or enrollment terminal for trustpoint ${n}`); return { out: o, changed: false }; }
    const r = pkiReach(tp);
    if (!r.caDev) { o.push('% Error in receiving Certificate Authority certificate: status = FAIL, cert length = 0', `（${r.why}）`); return { out: o, changed: false }; }
    const cert = caCert(r.caDev.ca), v = validityError(st, d, cert);
    if (v) { pkiLog(v); o.push('% Error in saving certificate: status = FAIL', `（${v.why}）`); return { out: o, changed: false }; }
    o.push('Certificate has the following attributes:', `       Fingerprint MD5: ${fp(cert, 4)}`, `      Fingerprint SHA1: ${fp(cert, 5)}`, '', '% Do you accept this certificate? [yes/no]: ');
    S.pending = { fn: (ans, o2) => {
      S.pending = null;
      if (!/^y/i.test(ans)) { o2.push('% Certificate not accepted.'); return { out: o2, changed: false }; }
      tp.ca = cert;
      o2.push('Trustpoint CA certificate accepted.');
      return { out: o2, changed: true };
    } };
    return { out: o, changed: false };
  }
  /** crypto pki enroll：向 CA 申請自己的憑證（CA 自動核發），收到之後用自己的時鐘檢查 */
  function pkiEnroll(n, o) {
    const d = dev(), st = getState(), tp = tpOf(d, n), m = d.mgmt || {};
    if (!tp) { o.push(`% Trustpoint ${n} not found`); return { out: o, changed: false }; }
    if (!tp.ca) { o.push('% You must authenticate the Certificate Authority before', '  you can enroll with it.', `（先 crypto pki authenticate ${n}）`); return { out: o, changed: false }; }
    const subject = tp.subject || `CN=${hostName(d)}${m.domain ? '.' + m.domain : ''}`;
    if (tp.cert) o.push('%', '% You already have a certificate from the CA.', '% Re-enrolling will replace the existing certificate.');
    o.push('%', '% Start certificate enrollment ..', '', `% The subject name in the certificate will include: ${subject}`, ...(tp.fqdn ? [`% The fully-qualified domain name in the certificate will be: ${tp.fqdn}`] : []), 'Request certificate from CA? [yes/no]: ');
    S.pending = { fn: (ans, o2) => {
      S.pending = null;
      if (!/^y/i.test(ans)) return { out: o2, changed: false };
      if (!tp.key) { tp.key = true; o2.push(`% Generating 2048 bit RSA keys, keys will be non-exportable...`, '[OK] (elapsed time was 2 seconds)'); }
      const r = pkiReach(tp);
      if (!r.caDev) { o2.push('% Certificate request sent to Certificate Authority', `%PKI-3-POLLRACERT: Polling RA certificate .....`, `（${r.why}，申請送不出去）`); return { out: o2, changed: true }; }
      const cert = issue(st, r.caDev, subject), v = validityError(st, d, cert);
      o2.push('% Certificate request sent to Certificate Authority', `% The 'show crypto pki certificate verbose ${n}' commmand will show the fingerprint.`);
      if (v) { pkiLog(v); o2.push(`（收到憑證了，但${v.why}，被丟棄）`); return { out: o2, changed: true }; }
      tp.cert = cert;
      logEvent(st, d, 6, 'PKI-6-CERTRET', 'Certificate received from Certificate Authority');
      return { out: o2, changed: true };
    } };
    return { out: o, changed: false };
  }

  /** archive log config：記下這一行（子模式裡的指令前面空一格，和 show archive log config 一樣） */
  function logCfg(text, sub) {
    const d = dev(), st = getState();
    if (!d.archive || !d.archive.log || !d.archive.log.on || !st.dyn) return;
    // 剛打開 logging enable 的那一行本身就是第一筆，上一層（log config）沒有被記到，所以不縮排
    const indent = sub && !!S.logSess;
    if (!S.logSess) { const n = (st.dyn.cfgSess ||= {}); n[d.id] = (n[d.id] || 0) + 1; S.logSess = n[d.id]; }
    cfgLog(st, d, { sess: S.logSess, user: who ? who.user : 'console', line: who ? String(who.line).replace(/\s+/g, '') : 'console', cmd: (indent ? ' ' : '') + text }, logEvent);
  }

  /** configure replace：整份換成封存檔（或 flash 裡的設定檔）的內容 */
  function configReplace(file, opts, out) {
    const d = dev(), st = getState();
    ensureFlash(d);
    const f = d.flash && d.flash.files[flashPath(file)];
    if (!f || f.kind !== 'config') { out.push(`%Error opening ${file} (No such file or directory)`); return { out, changed: false }; }
    const go = (o) => {
      const before = runningConfig(st, d);
      const snap = f.snap || snapFromText(st, d, f.lines).snap;
      applySnap(d, snap);
      recompute(st);
      const after = runningConfig(st, d);
      if (/\blist\b/i.test(opts)) {
        const diff = cfgDiff(before, after);
        o.push('!Pass 1', '', '!List of Commands:', ...(diff.length ? diff : ['（沒有任何差異）']), 'end');
      }
      o.push('', 'Total number of passes: 1', 'Rollback Done');
      logEvent(st, d, 5, 'SYS-5-CONFIG_I', who ? `Configured from ${file} by ${who.user} on ${who.line} (${who.ip})` : `Configured from ${file} by console`);
      S.mode = 'exec'; S.cur = null;
      return { out: o, changed: true };
    };
    if (/\bforce\b/i.test(opts)) return go(out);
    out.push('This will apply all necessary additions and deletions', 'to replace the current running configuration with the', 'contents of the specified configuration file, which is',
      'assumed to be a complete configuration, not a partial', 'configuration. Enter Y if you are sure you want to proceed. ? [no]: ');
    S.pending = { fn: (ans, o2) => { S.pending = null; if (!/^y/i.test(ans.trim())) return { out: o2, changed: false }; return go(o2); } };
    return { out, changed: false };
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
    const u = t.match(/^(tftp|ftp|scp):(?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/]+)(?:\/(.*))?)?$/i);
    if (u) return { kind: u[1].toLowerCase(), user: u[2] || null, pass: u[3] ?? null, host: u[4] || null, file: u[5] || null };
    const f = t.match(/^(boot)?flash:\/?(.*)$/i);
    if (f) return { kind: 'flash', file: f[2] || null };
    return null;
  }
  const remoteKind = (x) => x.kind === 'tftp' || x.kind === 'ftp' || x.kind === 'scp';
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
        out.push('% 這個模擬支援的 copy：running-config / startup-config / flash:檔案 ↔ tftp: / ftp: / scp:');
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
      if (t === -1) return 'Nov 12 2025 10:22:41 +00:00';
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
    // SCP：帳號寫在網址裡（scp://帳號@伺服器/檔名），密碼另外問，不會出現在設定或指令紀錄裡
    if (rem.kind === 'scp' && !rem.user) return ask(out, `${job.dst === rem ? 'Destination' : 'Source'} username`, '', (v, o) => { rem.user = v; return copyStep(job, o); });
    if (rem.kind === 'scp' && rem.pass == null) { out.push('Password: '); S.pending = { secret: true, fn: (text, o) => { S.pending = null; rem.pass = text; return copyStep(job, o) || { out: o, changed: false }; } }; return { out, changed: false }; }
    const creds = rem.kind === 'ftp' ? { user: rem.user || (d.ftpLogin || {}).user || '', pass: rem.pass ?? (d.ftpLogin || {}).pass ?? '' } : rem.kind === 'scp' ? { user: rem.user, pass: rem.pass } : {};
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
    prompt: () => ((((getState().dyn || {}).clk || {})[dev().id] || {}).rommon ? 'rommon 1 >' : S.pending ? '' : hostName(dev()) + (S.mode === 'exec' && S.priv < 15 ? '>' : PROMPT[S.mode])),
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
/** running-config 裡的 redistribute：metric、metric-type、subnets、tag、route-map 的順序和 IOS 一樣 */
const redistLine = (r, into) => ` redistribute ${r.src}${r.as != null ? ' ' + r.as : ''}${r.metric != null ? ' metric ' + r.metric : ''}${r.type === 1 ? ' metric-type 1' : ''}${into === 'ospf' && r.src !== 'ospf' ? ' subnets' : ''}${r.tag ? ' tag ' + r.tag : ''}${r.rm ? ' route-map ' + r.rm : ''}`;
export const aclLine = (r) => (r.evaluate ? `evaluate ${r.evaluate}` : `${r.action} ${r.proto || 'ip'} ${aclAddr(r.src)}${r.sport ? ' eq ' + r.sport : ''} ${aclAddr(r.dst)}${r.port && r.proto !== 'ip' && r.proto !== 'icmp' ? ' eq ' + r.port : ''}${r.icmp ? ' ' + r.icmp : ''}${r.established ? ' established' : ''}${r.reflect ? ` reflect ${r.reflect}${r.rtimeout ? ' timeout ' + r.rtimeout : ''}` : ''}${r.tr ? ' time-range ' + r.tr : ''}`);

/** 產生等效的 running-config */
/**
 * aaa 的區塊印在設定檔前面（帳號後面）：有設定方法清單、授權、記錄，或沒有 802.1X 的時候。
 * 只有 802.1X 的交換器（aaa new-model 只是為了 dot1x）維持印在交換器的區段裡
 */
function aaaTop(dev) {
  const a = dev.aaa;
  if (!a || !a.on) return false;
  const dot1x = !!(dev.sw && Object.values(dev.sw.ports).some((p) => p.dot1x));
  return !dot1x || !!(Object.keys(a.authn || {}).length || a.authzExec || a.authzCmd || a.acctCmd || a.acctExec);
}

export function runningConfig(state, dev) {
  const o = ['Building configuration...', '', '!', `hostname ${hostName(dev)}`, '!'];
  if ((dev.bootSys || []).length) o.push(...dev.bootSys.map((b) => `boot system ${b}`), '!');
  if (dev.ftpLogin && (dev.ftpLogin.user || dev.ftpLogin.pass)) o.push(...(dev.ftpLogin.user ? [`ip ftp username ${dev.ftpLogin.user}`] : []), ...(dev.ftpLogin.pass ? [`ip ftp password 7 ${hex(dev.ftpLogin.pass)}`] : []), '!');
  if (+dev.tftpBlk > 512) o.push(`ip tftp blocksize ${+dev.tftpBlk}`, '!');
  const m = dev.mgmt;
  if (m && m.enableSecret) o.push(`enable secret 9 ${secret9(m.enableSecret)}`, '!');
  const aaa = aaaTop(dev) ? dev.aaa : null;
  if (aaa) {
    const ml = (x) => x.map((k) => METHOD_TEXT[k]).join(' ');
    o.push('aaa new-model', '!');
    for (const [n, x] of Object.entries(aaa.authn || {})) o.push(`aaa authentication login ${n} ${ml(x)}`);
    if (dev.sw && Object.values(dev.sw.ports).some((p) => p.dot1x)) o.push('aaa authentication dot1x default group radius');
    if (aaa.authzExec) o.push(`aaa authorization exec default ${ml(aaa.authzExec)}`);
    if (aaa.authzCmd) o.push(`aaa authorization commands 15 default ${ml(aaa.authzCmd)}`);
    if (aaa.acctExec) o.push(`aaa accounting exec default ${aaa.acctExec} group tacacs+`);
    if (aaa.acctCmd) o.push(`aaa accounting commands 15 default ${aaa.acctCmd} group tacacs+`);
    o.push('!');
  }
  if (m && localUsers(m).length) o.push(...localUsers(m).map((u) => `username ${u.user}${u.priv === 1 ? '' : ` privilege ${u.priv}`} secret 9 ${secret9(u.pass || '')}`), '!');
  if (m && (m.domain || m.sshVer === 2 || m.sshTimeout || m.sshRetries)) {
    o.push(...(m.domain ? [`ip domain name ${m.domain}`] : []), ...(m.sshVer === 2 ? ['ip ssh version 2'] : []),
      ...(m.sshTimeout ? [`ip ssh time-out ${m.sshTimeout}`] : []), ...(m.sshRetries ? [`ip ssh authentication-retries ${m.sshRetries}`] : []), '!');
  }
  if (dev.v6routing) o.push('ipv6 unicast-routing', '!');
  for (const [name, p] of Object.entries(dev.dhcp6Pools || {})) {
    o.push(`ipv6 dhcp pool ${name}`, ...(p.prefix ? [` address prefix ${p.prefix.toUpperCase()}`] : []), ...(p.dns || []).map((a) => ` dns-server ${a.toUpperCase()}`), ...(p.domain ? [` domain-name ${p.domain}`] : []), '!');
  }
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
    if (isNexus(dev) && dev.breakout) o.push(...breakoutLines(dev), '!');
    // VTP：真的 IOS 把這些存在 vlan.dat，這裡為了貼回設定方便印在 running-config；client 的 VLAN 由 server 同步，不印
    const vt = vtpCapable(dev) ? vtpOf(dev) : null;
    if (vt && (vt.domain || vt.mode !== 'server' || vt.pass || vt.ver !== 1)) o.push(...(vt.domain ? [`vtp domain ${vt.domain}`] : []), ...(vt.mode !== 'server' ? [`vtp mode ${vt.mode}`] : []), ...(vt.ver !== 1 ? [`vtp version ${vt.ver}`] : []), ...(vt.pass ? [`vtp password ${vt.pass}`] : []), '!');
    if (!(vt && vt.mode === 'client')) for (const v of sw.vlans.slice().sort((a, b) => a.id - b.id)) if (v.id !== 1) o.push(`vlan ${v.id}`, ...(v.pvlan ? [` private-vlan ${v.pvlan}`] : []), ...(v.pvlan === 'primary' && (v.assoc || []).length ? [` private-vlan association ${v.assoc.join(',')}`] : []), ` name ${v.name.replace(/\s+/g, '_')}`);
    if (sw.tagNative) o.push('!', 'vlan dot1q tag native');
    for (const [n, p] of Object.entries(sw.raPolicies || {})) o.push('!', `ipv6 nd raguard policy ${n}`, ` device-role ${p.role || 'host'}`);
    // 和真的 Catalyst 一樣，errdisable recovery 印在 spanning-tree 前面
    const er = sw.errRec;
    if (er && ((er.causes || []).length || er.interval)) {
      o.push('!', ...ERR_RECOVERY_CAUSES.filter((c) => er.causes.includes(c)).map((c) => `errdisable recovery cause ${c}`));
      if (er.interval) o.push(`errdisable recovery interval ${er.interval}`);
    }
    if (isCat2960(dev) && +sw.jumbo) o.push('!', `system mtu jumbo ${+sw.jumbo}`);
    if (isCat9300(dev) && +sw.sysMtu) o.push('!', `system mtu ${+sw.sysMtu}`);
    if ((sw.staticMacs || []).length) o.push('!', ...sw.staticMacs.map((e) => `mac address-table static ${dotMac(e.mac)} vlan ${e.vlan} ${e.drop ? 'drop' : 'interface ' + longIf((dev.ports.find((p) => p.id === e.port) || { label: e.port }).label)}`));
    const stp = sw.stp || {};
    o.push('!', `spanning-tree mode ${stp.mode === 'mst' ? 'mst' : 'rapid-pvst'}`);
    if (stp.on === false) o.push('no spanning-tree vlan 1-4094');
    else if (stp.prio != null && stp.prio !== '' && +stp.prio !== 32768) o.push(`spanning-tree vlan 1-4094 priority ${+stp.prio}`);
    // 個別 VLAN 的優先權：一樣的值寫成一行
    const byP = {};
    for (const [v, p] of Object.entries(stp.vprio || {})) (byP[p] ||= []).push(+v);
    for (const [p, l] of Object.entries(byP)) o.push(`spanning-tree vlan ${vlanText(l)} priority ${p}`);
    if (stp.mst && (stp.mst.name || stp.mst.rev || Object.keys(stp.mst.map || {}).length)) {
      o.push('!', 'spanning-tree mst configuration');
      if (stp.mst.name) o.push(` name ${stp.mst.name}`);
      if (+stp.mst.rev) o.push(` revision ${+stp.mst.rev}`);
      for (const [i, l] of Object.entries(stp.mst.map || {})) o.push(` instance ${i} vlan ${vlanText(l)}`);
    }
    for (const [i, p] of Object.entries((stp.mst || {}).prio || {})) o.push(`spanning-tree mst ${i} priority ${p}`);
    if (stp.portfastDefault) o.push('spanning-tree portfast default');
    if (stp.bpduguardDefault) o.push('spanning-tree portfast bpduguard default');
    if (stp.bpdufilterDefault) o.push('spanning-tree portfast bpdufilter default');
    if (stp.loopguardDefault) o.push('spanning-tree loopguard default');
    if (+sw.macAge > 0 && +sw.macAge !== 300) o.push(`mac address-table aging-time ${+sw.macAge}`);
    for (const [n, s] of Object.entries(sw.span || {})) {
      const lab = (pid) => (dev.ports.find((p) => p.id === pid) || {}).label || pid;
      for (const [pid, dir] of Object.entries(s.src || {})) o.push(`monitor session ${n} source interface ${lab(pid)}${dir === 'both' ? '' : ' ' + dir}`);
      if (s.dst) o.push(`monitor session ${n} destination interface ${lab(s.dst)}`);
    }
    const vl = sw.vlans.map((v) => v.id).sort((a, b) => a - b).join(',');
    if (sw.snoop && sw.snoop.on) o.push('ip dhcp snooping', `ip dhcp snooping vlan ${vl}`);
    if (sw.dai && sw.dai.on) o.push(`ip arp inspection vlan ${vl}`);
    if (Object.values(sw.ports).some((p) => p.dot1x)) o.push(...(aaaTop(dev) ? [] : ['aaa new-model', 'aaa authentication dot1x default group radius']), 'dot1x system-auth-control');
    if (sw.qos && sw.qos.on) o.push('mls qos');
    if (sw.qos && sw.qos.cosDscp && sw.qos.cosDscp.join() !== COS_DSCP_DEFAULT.join()) o.push(`mls qos map cos-dscp ${sw.qos.cosDscp.join(' ')}`);
    o.push('!');
  }
  // key chain（EIGRP 的 MD5 驗證用；金鑰照實印出，和 IOS 沒開 service password-encryption 時一樣）
  for (const [n, keys] of Object.entries(dev.keyChains || {})) {
    o.push(`key chain ${n}`);
    for (const k of keys.slice().sort((a, b) => a.id - b.id)) o.push(` key ${k.id}`, ...(k.str ? [`  key-string ${k.str}`] : []));
    o.push('!');
  }
  // QoS：class-map 與 policy-map
  for (const [name, m] of Object.entries(dev.classMaps || {})) {
    o.push(`class-map match-${m.any ? 'any' : 'all'} ${name}`);
    for (const r of m.rules) {
      if (r.t === 'any') o.push(' match any');
      else if (r.t === 'dscp') o.push(` match dscp ${r.v.map(dscpName).join(' ')}`);
      else if (r.t === 'cos') o.push(` match cos ${r.v.join(' ')}`);
      else if (r.t === 'acl') o.push(` match access-group name ${r.v}`);
      else if (r.t === 'protocol') o.push(` match protocol ${r.v}`);
    }
  }
  // 子政策要先出現（貼回設定時，parent 的 service-policy 才找得到它）
  const pmOrder = [], pmSeen = new Set(), pmAll = dev.policyMaps || {};
  const pmVisit = (n) => { if (pmSeen.has(n) || !pmAll[n]) return; pmSeen.add(n); for (const c of pmAll[n]) if (c.child) pmVisit(c.child); pmOrder.push(n); };
  Object.keys(pmAll).forEach(pmVisit);
  for (const [name, pm] of pmOrder.map((n) => [n, pmAll[n]])) {
    o.push(`policy-map ${name}`);
    for (const c of pm) {
      o.push(` class ${c.cls}`);
      if (c.priority) o.push(c.priority.kbps ? `  priority ${c.priority.kbps}` : `  priority percent ${c.priority.pct}`);
      if (c.bandwidth) o.push(c.bandwidth.kbps ? `  bandwidth ${c.bandwidth.kbps}` : c.bandwidth.rpct ? `  bandwidth remaining percent ${c.bandwidth.rpct}` : `  bandwidth percent ${c.bandwidth.pct}`);
      if (c.fq) o.push('  fair-queue');
      if (c.qlimit) o.push(`  queue-limit ${c.qlimit} packets`);
      if (c.set) o.push(`  set dscp ${dscpName(c.set.dscp)}`);
      if (c.police) o.push(`  police cir ${c.police.bps}`, '   conform-action transmit ', '   exceed-action drop ');
      if (c.shape) o.push(`  shape average ${c.shape.bps}`);
      if (c.child) o.push(`  service-policy ${c.child}`);
    }
  }
  if (Object.keys(dev.classMaps || {}).length || Object.keys(dev.policyMaps || {}).length) o.push('!');
  o.push(...zbfConfigLines(dev)); // Zone-Based Firewall：介面的 zone-member 要先有 zone
  // DHCP 位址池
  for (const i of dev.ifaces) {
    if (!i.dhcp || !i.dhcp.on || !i.rt || i.rt.ip == null) continue;
    const a = parseIp(i.dhcp.start), b = parseIp(i.dhcp.end);
    const net = netOf(i.rt.ip, i.rt.bits), bc = bcastOf(i.rt.ip, i.rt.bits);
    if (a != null && a > net + 1) o.push(`ip dhcp excluded-address ${fmtIp(net + 1)} ${fmtIp(a - 1)}`);
    if (b != null && b < bc - 1) o.push(`ip dhcp excluded-address ${fmtIp(b + 1)} ${fmtIp(bc - 1)}`);
    o.push(`ip dhcp pool ${poolName(i)}`, ` network ${fmtIp(net)} ${fmtMask(i.rt.bits)}`, ` default-router ${i.dhcp.gw || fmtIp(i.rt.ip)}`);
    if (i.dhcp.dns) o.push(` dns-server ${i.dhcp.dns.replace(/[,\s]+/g, ' ')}`);
    if (i.dhcp.tftp) o.push(` option 150 ip ${i.dhcp.tftp.replace(/[,\s]+/g, ' ')}`);
    if (i.dhcp.wlc) o.push(` option 43 hex ${opt43(i.dhcp.wlc)}`);
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
    if (p.tftp) o.push(` option 150 ip ${p.tftp.replace(/[,\s]+/g, ' ')}`);
    if (p.wlc) o.push(` option 43 hex ${opt43(p.wlc)}`);
    o.push('!');
  }
  // IPsec VPN：第一階段政策、金鑰、第二階段的 transform-set，最後用 crypto map 把它們和對端、ACL 綁在一起
  const vp = dev.vpns || [];
  const cmIf = new Map(); // 圖形介面建立的通道沒有明確套用 crypto map：視為套用在通往對端的那個介面上
  for (const T of (dev.rt && dev.rt.tunnels) || []) {
    const i = T.cfg && !T.cfg.cmap && !T.prot && T.localIp != null && dev.ifaces.find((x) => x.rt && x.rt.ip === T.localIp);
    if (i) cmIf.set(i, cmapOf(T.cfg));
  }
  for (const [n, tp] of Object.entries((dev.pki && dev.pki.tps) || {})) {
    o.push(`crypto pki trustpoint ${n}`, ...(tp.url ? [` enrollment url ${tp.url}`] : []), ...(tp.noSerial ? [' serial-number none'] : []), ...(tp.fqdn ? [` fqdn ${tp.fqdn}`] : []), ...(tp.noIp ? [' ip-address none'] : []),
      ...(tp.subject ? [` subject-name ${tp.subject}`] : []), ...(tp.revoke && tp.revoke !== 'crl' ? [` revocation-check ${tp.revoke}`] : []), ...(tp.rsakey ? [` rsakeypair ${tp.rsakey}`] : []), '!');
  }
  for (const [n, tp] of Object.entries((dev.pki && dev.pki.tps) || {})) {
    if (!tp.ca && !tp.cert) continue;
    o.push(`crypto pki certificate chain ${n}`);
    if (tp.cert) o.push(` certificate ${tp.cert.serial}`, ...certHex(tp.cert).map((l) => '  ' + l), '  \tquit');
    if (tp.ca) o.push(` certificate ca ${tp.ca.serial}`, ...certHex(tp.ca).map((l) => '  ' + l), '  \tquit');
    o.push('!');
  }
  const v2 = ikev2Objects(dev);
  {
    const V = v2.v;
    for (const [n, x] of Object.entries(V.props)) o.push(`crypto ikev2 proposal ${n}`, ...(x.encs.length ? [` encryption ${x.encs.map((e) => ENC_V2_IOS[e]).join(' ')}`] : []), ...(x.hashes.length ? [` integrity ${x.hashes.join(' ')}`] : []), ...(x.dhs.length ? [` group ${x.dhs.join(' ')}`] : []), '!');
    for (const [n, x] of Object.entries(V.pols)) o.push(`crypto ikev2 policy ${n}`, ...x.props.map((y) => ` proposal ${y}`), '!');
    for (const [n, x] of Object.entries(V.krs)) {
      o.push(`crypto ikev2 keyring ${n}`);
      for (const [pn, pe] of Object.entries(x.peers)) o.push(` peer ${pn}`, ...(pe.address ? [`  address ${pe.address}`] : []), ...(pe.psk ? [`  pre-shared-key ${pe.psk}`] : []), ...(pe.pskLocal ? [`  pre-shared-key local ${pe.pskLocal}`] : []), ...(pe.pskRemote ? [`  pre-shared-key remote ${pe.pskRemote}`] : []), ' !');
      o.push('!');
    }
    for (const [n, x] of Object.entries(V.profs)) o.push(`crypto ikev2 profile ${n}`, ...(x.remote ? [` match identity remote address ${x.remote} 255.255.255.255`] : []), ...(x.remoteFqdn ? [` match identity remote fqdn domain ${x.remoteFqdn}`] : []), ...(x.remoteAny ? [' match identity remote any'] : []),
      ...(x.idFqdn ? [` identity local fqdn ${x.idFqdn}`] : []), ` authentication remote ${x.authR || 'pre-share'}`, ` authentication local ${x.authL || 'pre-share'}`, ...(x.keyring ? [` keyring local ${x.keyring}`] : []), ...(x.tp ? [` pki trustpoint ${x.tp}`] : []), ...(+x.life > 0 ? [` lifetime ${x.life}`] : []), '!');
  }
  const profs = Object.entries(dev.ipsecProfiles || {});
  if (vp.length || (dev.isakmp && dev.isakmp.length) || profs.length || Object.keys(dev.ikeKeys || {}).length || Object.keys(dev.tsets || {}).length) {
    for (const p of isakmpOf(dev)) o.push(`crypto isakmp policy ${p.n}`, ` encryption ${ENC_IOS[p.enc] || 'aes'}`, ` hash ${HASH_IOS[p.hash] || 'sha'}`, ' authentication pre-share', ` group ${p.dh}`, ...(+p.life > 0 && +p.life !== 86400 ? [` lifetime ${+p.life}`] : []));
    const keys = new Map();
    for (const t of vp) if (t.psk && t.peer && ikeVer(dev, t) === 1) keys.set(t.peer, t.psk);
    for (const [peer, k] of Object.entries(dev.ikeKeys || {})) if (!keys.has(peer) && (peer === '0.0.0.0' || !vp.some((t) => t.peer === peer && ikeVer(dev, t) === 2))) keys.set(peer, k);
    for (const [peer, k] of keys) o.push(`crypto isakmp key ${k} address ${peer}`);
    if (+dev.natKa > 0) o.push(`crypto isakmp nat keepalive ${+dev.natKa}`);
    if (dev.ikeKeepalive && +dev.ikeKeepalive.sec > 0) o.push(`crypto isakmp keepalive ${dev.ikeKeepalive.sec} ${dev.ikeKeepalive.retry || 2}`);
    if (+dev.ipsecLife > 0 && +dev.ipsecLife !== 3600) o.push(`crypto ipsec security-association lifetime seconds ${+dev.ipsecLife}`);
    o.push('!');
    const sets = new Map(Object.entries(dev.tsets || {}));
    for (const t of vp) if (!sets.has(tsetOf(t))) sets.set(tsetOf(t), { enc2: t.enc2 || t.enc || 'aes128', hash2: t.hash2 || t.hash || 'sha1' });
    for (const [name, s] of sets) o.push(`crypto ipsec transform-set ${name} esp-${ENC_IOS[s.enc2]} esp-${HASH_IOS[s.hash2]}-hmac`, ` mode ${s.mode || 'tunnel'}`);
    if (sets.size) o.push('!');
    if (dev.noNatT) o.push('no crypto ipsec nat-transparency udp-encapsulation', '!');
    for (const [n, p] of profs) {
      o.push(`crypto ipsec profile ${n}`, ...(p.desc ? [` description ${p.desc}`] : []), ...(p.tset ? [` set transform-set ${p.tset}`] : []), ...(p.pfs ? [` set pfs group${p.pfs}`] : []), ...(p.ikev2 ? [` set ikev2-profile ${p.ikev2}`] : []), ...(+p.life2 > 0 ? [` set security-association lifetime seconds ${+p.life2}`] : []), '!');
    }
    for (const t of vp) {
      o.push(`crypto map ${cmapOf(t)} ${seqOf(dev, t)} ipsec-isakmp`);
      if (t.name && t.name !== `${cmapOf(t)}-${seqOf(dev, t)}`) o.push(` description ${t.name}`);
      if (t.peer) o.push(` set peer ${t.peer}`);
      o.push(` set transform-set ${tsetOf(t)}`);
      if (t.ikev2 || v2.prof[t.name]) o.push(` set ikev2-profile ${t.ikev2 || v2.prof[t.name]}`);
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
    if (+i.l2mtu) l.push(` mtu ${+i.l2mtu}`);
    if (i.vrf) l.push(((dev.vrfs || {})[i.vrf] || {}).style === 'ip' ? ` ip vrf forwarding ${i.vrf}` : ` vrf forwarding ${i.vrf}`);
    if (i.mode === 'dhcp') l.push(' ip address dhcp');
    else if (i.mode === 'pppoe') l.push(' pppoe-client dial-pool-number 1', ` ! PPPoE 帳號 ${i.user || '(未設定)'}`);
    else if (i.ip && parseMask(i.mask) != null) l.push(` ip address ${i.ip} ${fmtMask(parseMask(i.mask))}`);
    else l.push(' no ip address');
    if (i.nvi) l.push(' ip nat enable');
    else if (anyNat) l.push(natOut(i) ? ' ip nat outside' : i.ip || i.mode !== 'static' ? ' ip nat inside' : null);
    if (i.helper) l.push(` ip helper-address ${i.helper}`);
    if (i.policyRm) l.push(` ip policy route-map ${i.policyRm}`);
    if (+i.bandwidth > 0) l.push(` bandwidth ${i.bandwidth}`);
    if (i.mtu) l.push(isNexus(dev) ? ` mtu ${i.mtu}` : ` ip mtu ${i.mtu}`);
    if (+i.adjMss) l.push(` ip tcp adjust-mss ${+i.adjMss}`);
    if (i.redirects === false) l.push(' no ip redirects');
    if (i.ospfAuth) l.push(i.ospfAuth === 'md5' ? ' ip ospf authentication message-digest' : i.ospfAuth === 'null' ? ' ip ospf authentication null' : ' ip ospf authentication');
    if (i.ospfKey && i.ospfKey.id !== '' && i.ospfKey.id != null) l.push(` ip ospf message-digest-key ${i.ospfKey.id} md5 7 ${hex(i.ospfKey.key || '')}`);
    else if (i.ospfKey) l.push(` ip ospf authentication-key 7 ${hex(i.ospfKey.key || '')}`);
    if (i.ospfNet === 'p2p') l.push(' ip ospf network point-to-point');
    if (i.ospfNet === 'broadcast') l.push(' ip ospf network broadcast');
    if (i.ospfPrio != null && i.ospfPrio !== '') l.push(` ip ospf priority ${i.ospfPrio}`);
    if (i.ospfFast) l.push(` ip ospf dead-interval minimal hello-multiplier ${i.ospfFast}`);
    if (i.ospfHello) l.push(` ip ospf hello-interval ${i.ospfHello}`);
    if (i.ospfDead) l.push(` ip ospf dead-interval ${i.ospfDead}`);
    if (i.ospfMtuIgnore) l.push(' ip ospf mtu-ignore');
    if (i.ospfBfd) l.push(' ip ospf bfd');
    if (i.ospfBfdOff) l.push(' ip ospf bfd disable');
    if (i.bfd) l.push(` bfd interval ${i.bfd.tx} min_rx ${i.bfd.rx} multiplier ${i.bfd.mult}`);
    if (ospfOn(dev, i) && i.ospfCost) l.push(` ip ospf cost ${i.ospfCost}`);
    if (i.aclIn && i.aclIn.length) l.push(` ip access-group ${aclName(i, 'in')} in`);
    if (i.aclOut && i.aclOut.length) l.push(` ip access-group ${aclName(i, 'out')} out`);
    if (i.vrrp && (i.vrrp.on || +i.vrrp.prio !== 100 || (i.vrrp.track || []).length)) l.push(...fhrpLines(i.vrrp));
    if (i.ll6) l.push(` ipv6 address ${i.ll6.toUpperCase()} link-local`);
    if (i.ip6) l.push(` ipv6 address ${i.ip6.toUpperCase()}`);
    if (i.gp6) l.push(` ipv6 address ${i.gp6.name} ${i.gp6.suffix.toUpperCase()}`);
    if (i.mode6 === 'auto' && dev.kind !== 'host') l.push(` ipv6 address autoconfig${i.v6default ? ' default' : ''}`);
    if (i.raNoAuto) l.push(' ipv6 nd prefix default no-autoconfig');
    if (i.raM) l.push(' ipv6 nd managed-config-flag');
    if (i.raO) l.push(' ipv6 nd other-config-flag');
    if ((i.ip6 || i.gp6) && !i.ra) l.push(' ipv6 nd ra suppress all');
    if (i.pd6) l.push(` ipv6 dhcp client pd ${i.pd6}`);
    if (i.zone) l.push(` zone-member security ${i.zone}`);
    if (i.eigrpDelay) l.push(` delay ${i.eigrpDelay}`);
    { const as = eigrpOn(dev) ? dev.eigrp.as : (i.eigrpAuth && i.eigrpAuth.as) || 1;
      if (i.eigrpAuth && i.eigrpAuth.md5) l.push(` ip authentication mode eigrp ${i.eigrpAuth.as || as} md5`);
      if (i.eigrpAuth && i.eigrpAuth.chain) l.push(` ip authentication key-chain eigrp ${i.eigrpAuth.as || as} ${i.eigrpAuth.chain}`);
      if (i.eigrpHello) l.push(` ip hello-interval eigrp ${as} ${i.eigrpHello}`);
      if (i.eigrpHold) l.push(` ip hold-time eigrp ${as} ${i.eigrpHold}`);
      if (i.eigrpNoSplit) l.push(` no ip split-horizon eigrp ${as}`);
      for (const s of i.eigrpSum || []) l.push(` ip summary-address eigrp ${as} ${fmtIp(s.net)} ${fmtMask(s.bits)}`); }
    if (i.ripSend) l.push(` ip rip send version ${i.ripSend.join(' ')}`);
    if (i.ripRecv) l.push(` ip rip receive version ${i.ripRecv.join(' ')}`);
    if (i.ripAuth && i.ripAuth.md5) l.push(' ip rip authentication mode md5');
    if (i.ripAuth && i.ripAuth.chain) l.push(` ip rip authentication key-chain ${i.ripAuth.chain}`);
    for (const s of i.ripSum || []) l.push(` ip summary-address rip ${fmtIp(s.net)} ${fmtMask(s.bits)}`);
    if (i.ripNoSplit) l.push(' no ip split-horizon');
    if (i.nat64) l.push(' nat64 enable');
    if (i.dhcp6) l.push(` ipv6 dhcp server ${i.dhcp6}`);
    if (i.relay6) l.push(` ipv6 dhcp relay destination ${i.relay6.toUpperCase()}`);
    if (i.ospf6Cost) l.push(` ipv6 ospf cost ${i.ospf6Cost}`);
    if (i.ospf6Net === 'p2p') l.push(' ipv6 ospf network point-to-point');
    if (i.ospf6Prio != null && i.ospf6Prio !== '') l.push(` ipv6 ospf priority ${i.ospf6Prio}`);
    if (i.ospf6Hello) l.push(` ipv6 ospf hello-interval ${i.ospf6Hello}`);
    if (i.ospf6Dead) l.push(` ipv6 ospf dead-interval ${i.ospf6Dead}`);
    if (i.ospf6Area != null && i.ospf6Area !== '' && dev.ospf6) l.push(` ipv6 ospf 1 area ${i.ospf6Area}`);
    if (i.acl6In) l.push(` ipv6 traffic-filter ${i.acl6In} in`);
    if (i.acl6Out) l.push(` ipv6 traffic-filter ${i.acl6Out} out`);
    if (i.cmap || cmIf.has(i)) l.push(` crypto map ${i.cmap || cmIf.get(i)}`);
    if (((dev.nf || {}).ingress || []).includes(i.id)) l.push(' ip flow ingress');
    if (((dev.nf || {}).egress || []).includes(i.id)) l.push(' ip flow egress');
    { const m = ((dev.nf || {}).ifMon || {})[i.id]; if (m && m.in) l.push(` ip flow monitor ${m.in} input`); if (m && m.out) l.push(` ip flow monitor ${m.out} output`); }
    if (i.qosIn) l.push(` service-policy input ${i.qosIn}`);
    if (i.qosOut) l.push(` service-policy output ${i.qosOut}`);
    return l.filter(Boolean);
  };
  for (const [n, v] of Object.entries(dev.vrfs || {})) {
    if (v.style === 'ip') o.push(`ip vrf ${n}`, ...(v.desc ? [` description ${v.desc}`] : []), ...(v.rd ? [` rd ${v.rd}`] : []), '!');
    else o.push(`vrf definition ${n}`, ...(v.desc ? [` description ${v.desc}`] : []), ...(v.rd ? [` rd ${v.rd}`] : []), ...(v.af4 ? [' !', ' address-family ipv4', ' exit-address-family'] : []), '!');
  }
  o.push(...archiveLines(dev));
  {
    const N = dev.nf || {}, ifl = (id) => { const x = dev.ifaces.find((y) => y.id === id); return x ? longIf(x.label) : id; };
    for (const [n, r] of Object.entries(N.records || {})) o.push(`flow record ${n}`, ...(r.desc ? [` description ${r.desc}`] : []), ...r.lines.map((x) => ' ' + x), '!');
    for (const [n, e] of Object.entries(N.exporters || {})) o.push(`flow exporter ${n}`, ...(e.desc ? [` description ${e.desc}`] : []), ...(e.ip ? [` destination ${e.ip}`] : []), ...(e.src ? [` source ${ifl(e.src)}`] : []), ...(e.port ? [` transport udp ${e.port}`] : []), '!');
    for (const [n, m] of Object.entries(N.monitors || {})) o.push(`flow monitor ${n}`, ...(m.desc ? [` description ${m.desc}`] : []), ...(m.exporter ? [` exporter ${m.exporter}`] : []), ...(m.active ? [` cache timeout active ${m.active}`] : []), ...(m.inactive ? [` cache timeout inactive ${m.inactive}`] : []), ...(m.record ? [` record ${m.record}`] : []), '!');
  }
  for (const [n, t] of Object.entries(dev.track || {})) {
    const ti = t.type === 'iface' && dev.ifaces.find((x) => x.id === t.iface);
    o.push(t.type === 'sla' ? `track ${n} ip sla ${t.sla} reachability` : `track ${n} interface ${longIf(ti ? ti.label : t.iface)} line-protocol`, '!');
  }
  for (const i of dev.ifaces.filter((x) => x.bind.t === 'loop').sort((a, b) => a.bind.n - b.bind.n)) o.push(`interface Loopback${i.bind.n}`, ...(i.desc ? [` description ${i.desc}`] : []), ...l3lines(i).filter((x) => !/ip nat (inside|outside)/.test(x)), ...(i.shut ? [' shutdown'] : []), '!');
  for (const i of dev.ifaces.filter((x) => x.bind.t === 'gre').sort((a, b) => a.bind.n - b.bind.n)) {
    const t = i.tun || {}, n = i.nhrp || {};
    const srcIf = t.src && dev.ifaces.find((x) => x.id === t.src);
    o.push(`interface Tunnel${i.bind.n}`, ...(i.desc ? [` description ${i.desc}`] : []), ...l3lines(i).filter((x) => !/ip nat (inside|outside)/.test(x)),
      ...(n.auth ? [` ip nhrp authentication ${n.auth}`] : []), ...(n.mcast || []).map((x) => ` ip nhrp map multicast ${x}`), ...(n.maps || []).map((m) => ` ip nhrp map ${m.ip} ${m.nbma}`),
      ...(n.id != null ? [` ip nhrp network-id ${n.id}`] : []), ...(+n.hold > 0 ? [` ip nhrp holdtime ${+n.hold}`] : []),
      ...(n.nhs || []).map((x) => ` ip nhrp nhs ${x.ip}${x.nbma ? ` nbma ${x.nbma}` : ''}${x.mcast ? ' multicast' : ''}`),
      ...(n.redirect ? [' ip nhrp redirect'] : []), ...(n.shortcut ? [' ip nhrp shortcut'] : []),
      ...(t.ka ? [` keepalive ${t.ka.sec} ${t.ka.retry}`] : []),
      ...(t.src ? [` tunnel source ${srcIf ? longIf(srcIf.label) : t.src}`] : []), ...(t.dst ? [` tunnel destination ${t.dst}`] : []),
      ...(t.mode === 'mgre' ? [' tunnel mode gre multipoint'] : t.mode === 'ipsec' ? [' tunnel mode ipsec ipv4'] : t.mode === 'ipv6ip' ? [' tunnel mode ipv6ip'] : []),
      ...(t.key != null ? [` tunnel key ${t.key}`] : []), ...(t.prot ? [` tunnel protection ipsec profile ${t.prot}`] : []),
      ...(i.shut ? [' shutdown'] : []), '!');
  }
  for (const p of dev.ports) {
    const peer = state.cables.find((c) => (c.a.dev === dev.id && c.a.port === p.id) || (c.b.dev === dev.id && c.b.port === p.id));
    const other = peer && state.devices[peer.a.dev === dev.id ? peer.b.dev : peer.a.dev];
    const auto = other ? [` description to ${other.kind === 'internet' ? 'ISP' : hostName(other)}`] : [];
    const pc = dev.sw && dev.sw.ports[p.id];
    const pi = !pc && dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
    // 自己設定的 description 優先，沒有才用「to 對端」的自動說明
    const desc = pc && pc.desc ? [` description ${pc.desc}`] : pi && pi.desc ? [` description ${pi.desc}`] : auto;
    if (pc && isSw(dev)) {
      const phy = [pc.speed && pc.speed !== 'auto' ? ` speed ${pc.speed}` : null, pc.duplex && pc.duplex !== 'auto' ? ` duplex ${pc.duplex}` : null].filter(Boolean);
      const nd = portNd(dev, p.id), ndl = [nd.cdp === false ? ' no cdp enable' : null, nd.tx === false ? ' no lldp transmit' : null, nd.rx === false ? ' no lldp receive' : null].filter(Boolean);
      const def = pc.mode === defaultPortMode(dev.model) && pc.vlan === 1 && pc.native === 1 && (!pc.allowed || pc.allowed === 'all') && !pc.voice && !pc.noneg && !pc.qosTrust && !pc.trustDevice && !pc.poe && !ndl.length && !pc.shut && !peer && !pc.trust && !(+pc.lag > 0) && !(pc.ps && pc.ps.on) && !pc.storm && !pc.protected && !pc.raGuard && !pc.pvHost && !pc.pvMap && !/^pvlan/.test(pc.mode) && !pc.bpduguard && !pc.rootguard && pc.bpdufilter == null && pc.loopguard == null && !pc.dot1x && !phy.length && pc.portfast == null && !pc.desc && !pc.mtu;
      if (def) continue;
      o.push(`interface ${longIf(p.label)}`, ...desc, ...phy, ...(+pc.mtu ? [` mtu ${+pc.mtu}`] : []));
      if (pc.mode === 'routed') {
        const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
        o.push(' no switchport', ...(i ? l3lines(i) : []), ...ndl);
      } else {
        // 真的 IOS 的順序：access vlan、trunk 的設定、mode、nonegotiate、voice vlan。出廠預設的模式不會印出來
        if (pc.vlan !== 1) o.push(` switchport access vlan ${pc.vlan}`);
        if (pc.native !== 1) o.push(` switchport trunk native vlan ${pc.native}`);
        if (pc.allowed && pc.allowed !== 'all') o.push(` switchport trunk allowed vlan ${pc.allowed}`);
        if (pc.mode === 'pvlan-host') o.push(...(pc.pvHost ? [` switchport private-vlan host-association ${pc.pvHost.primary} ${pc.pvHost.secondary}`] : []), ' switchport mode private-vlan host');
        else if (pc.mode === 'pvlan-promisc') o.push(...(pc.pvMap ? [` switchport private-vlan mapping ${pc.pvMap.primary} ${(pc.pvMap.secondaries || []).join(',')}`] : []), ' switchport mode private-vlan promiscuous');
        else if (pc.mode !== defaultPortMode(dev.model) || (pc.mode === 'access' && !DTP_OK(dev))) o.push(` switchport mode ${pc.mode.replace('-', ' ')}`);
        if (pc.protected) o.push(' switchport protected');
        if (pc.noneg) o.push(' switchport nonegotiate');
        if (pc.voice) o.push(` switchport voice vlan ${pc.voice}`);
        if (pc.autoQos) o.push(` auto qos voip ${pc.autoQos}`);
        if (pc.trustDevice) o.push(' mls qos trust device cisco-phone');
        if (pc.qosTrust) o.push(` mls qos trust ${pc.qosTrust}`);
        if (pc.poe === 'never') o.push(' power inline never');
        if (pc.mode === 'trunk') { if (pc.portfast === true) o.push(' spanning-tree portfast trunk'); }
        else if (pc.portfast === true) o.push(' spanning-tree portfast');
        else if (pc.portfast === false && stp0.portfastDefault) o.push(' spanning-tree portfast disable');
      }
      if (pc.mode !== 'routed') o.push(...ndl);
      if (+pc.lag > 0) o.push(` channel-group ${+pc.lag} mode ${pc.lagMode || 'active'}`);
      if (pc.ps && pc.ps.on) {
        // 和真的 IOS 一樣：預設的 maximum 1、violation shutdown 不印出來；sticky 學到的位址會出現在這裡
        o.push(' switchport port-security');
        if (+pc.ps.max > 1) o.push(` switchport port-security maximum ${+pc.ps.max}`);
        if (pc.ps.mode === 'restrict' || pc.ps.mode === 'protect') o.push(` switchport port-security violation ${pc.ps.mode}`);
        if (pc.ps.sticky) o.push(' switchport port-security mac-address sticky');
        for (const mac of macList(pc.ps.stickyMacs)) o.push(` switchport port-security mac-address sticky ${dotMac(mac)}`);
        for (const mac of macList(pc.ps.macs)) o.push(` switchport port-security mac-address ${dotMac(mac)}`);
      }
      if (pc.storm && pc.storm.bcast != null) o.push(` storm-control broadcast level ${(+pc.storm.bcast).toFixed(2)}`);
      if (pc.storm && pc.storm.action) o.push(` storm-control action ${pc.storm.action}`);
      if (pc.raGuard) o.push(` ipv6 nd raguard attach-policy ${pc.raGuard}`);
      if (pc.trust) o.push(' ip dhcp snooping trust', ...(dev.sw.dai && dev.sw.dai.on ? [' ip arp inspection trust'] : []));
      if (pc.bpdufilter != null) o.push(` spanning-tree bpdufilter ${pc.bpdufilter ? 'enable' : 'disable'}`);
      if (pc.bpduguard) o.push(' spanning-tree bpduguard enable');
      if (pc.rootguard) o.push(' spanning-tree guard root');
      else if (pc.loopguard != null) o.push(` spanning-tree guard ${pc.loopguard ? 'loop' : 'none'}`);
      if (pc.dot1x) o.push(' authentication port-control auto', ' dot1x pae authenticator');
      if (pc.shut) o.push(' shutdown');
      o.push('!');
    } else if (!pc) {
      const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
      if (!i) continue;
      const nd = portNd(dev, p.id);
      o.push(`interface ${longIf(p.label)}`, ...desc, ...l3lines(i),
        ...(i.speed && i.speed !== 'auto' ? [` speed ${i.speed}`] : []), ...(i.duplex && i.duplex !== 'auto' ? [` duplex ${i.duplex}`] : []),
        ...(nd.cdp === false ? [' no cdp enable'] : []), ...(nd.tx === false ? [' no lldp transmit'] : []), ...(nd.rx === false ? [' no lldp receive'] : []),
        i.shut ? ' shutdown' : ' no shutdown', '!');
      for (const s of dev.ifaces.filter((x) => x.bind.t === 'sub' && x.bind.port === p.id)) {
        o.push(`interface ${longIf(s.label)}`, ...(s.desc ? [` description ${s.desc}`] : []), ` encapsulation dot1Q ${s.bind.vlan}`, ...l3lines(s), '!');
      }
    }
  }
  for (const i of dev.ifaces.filter((x) => x.bind.t === 'svi')) {
    if (!i.ip && dev.kind === 'mswitch') continue;
    o.push(`interface Vlan${i.bind.vlan}`, ...(i.desc ? [` description ${i.desc}`] : []), ...l3lines(i), ...((i.pvMap || []).length ? [` private-vlan mapping ${i.pvMap.join(',')}`] : []), ' no shutdown', '!');
  }
  if (dev.kind === 'mswitch') {
    const mg = dev.ifaces.find((x) => x.id === 'mgmt');
    if (mg && mg.gateway) o.push(`ip default-gateway ${mg.gateway}`, '!');
  }
  if (eigrpOn(dev)) {
    const e = dev.eigrp, wild = (bits) => fmtIp(~(bits ? 0xffffffff << (32 - bits) : 0) >>> 0);
    o.push(`router eigrp ${e.as}`);
    for (const n of (e.nets || []).slice().sort((a, b) => (a.net >>> 0) - (b.net >>> 0) || a.bits - b.bits)) o.push(` network ${fmtIp(n.net)} ${wild(n.bits)}`); // IOS 照網段排序
    if (e.defMetric) o.push(` default-metric ${e.defMetric.join(' ')}`);
    for (const r of e.redist || []) o.push(` redistribute ${r.src}${r.src === 'ospf' ? ' ' + (r.pid || 1) : ''}${r.metric ? ' metric ' + r.metric.join(' ') : ''}`);
    if (e.k) o.push(` metric weights 0 ${e.k.join(' ')}`);
    if (e.variance) o.push(` variance ${e.variance}`);
    if (e.maxPaths) o.push(` maximum-paths ${e.maxPaths}`);
    if (e.passiveDefault) { o.push(' passive-interface default'); for (const id of e.noPassive || []) { const i = dev.ifaces.find((x) => x.id === id); if (i) o.push(` no passive-interface ${longIf(i.label)}`); } }
    else for (const id of e.passive || []) { const i = dev.ifaces.find((x) => x.id === id); if (i) o.push(` passive-interface ${longIf(i.label)}`); }
    if (e.rid) o.push(` eigrp router-id ${e.rid}`);
    o.push('!');
  }
  // network 敘述照原樣列出；在圖形介面上個別啟用、而且沒有被任何敘述涵蓋的介面，各自列一條。VRF 的程序寫成 router ospf <pid> vrf <名稱>
  for (const { vrf, pid, c } of ospfProcs(dev)) {
    const stmts = c.ospfNets || [];
    const os = dev.ifaces.filter((i) => (i.vrf || '') === vrf && i.ospf && i.rt && i.rt.ip != null && !stmts.some((n) => netOf(i.rt.ip, n.bits) === n.net))
      .sort((a, b) => netOf(a.rt.ip, a.rt.bits) - netOf(b.rt.ip, b.rt.bits));
    if (!vrf && !(os.length || stmts.length || (c.ospfRedist || []).length)) continue;
    o.push(vrf ? `router ospf ${pid} vrf ${vrf}` : 'router ospf 1');
    if (c.ospfRid) o.push(` router-id ${c.ospfRid}`);
    for (const r of c.ospfRedist || []) o.push(redistLine(r, 'ospf'));
    if (c.ospfRefBw) o.push(` auto-cost reference-bandwidth ${c.ospfRefBw}`);
    for (const [a, t] of Object.entries(c.ospfAreaAuth || {})) o.push(` area ${a} authentication${t === 'md5' ? ' message-digest' : ''}`);
    for (const [a, x] of Object.entries(c.ospfAreas || {})) {
      if (x.cost != null) o.push(` area ${a} default-cost ${x.cost}`);
      if (x.nssa) o.push(` area ${a} nssa${x.noRedist ? ' no-redistribution' : ''}${x.nssaDef ? ' default-information-originate' + (x.nssaDefMetric != null ? ' metric ' + x.nssaDefMetric : '') + (x.nssaDefType === 1 ? ' metric-type 1' : '') : ''}${x.noSum ? ' no-summary' : ''}`);
      if (x.stub) o.push(` area ${a} stub${x.noSum ? ' no-summary' : ''}`);
    }
    for (const r of c.ospfRanges || []) o.push(` area ${r.area} range ${fmtIp(r.net)} ${fmtMask(r.bits)}`);
    const ifl = (id) => longIf((dev.ifaces.find((x) => x.id === id) || { label: id }).label);
    if (c.bfdAll) o.push(' bfd all-interfaces');
    if (c.ospfPassiveDefault) { o.push(' passive-interface default'); for (const id of c.ospfNoPassive || []) o.push(` no passive-interface ${ifl(id)}`); }
    else for (const id of c.ospfPassive || []) o.push(` passive-interface ${ifl(id)}`);
    for (const n of stmts) o.push(` network ${fmtIp(n.net)} ${wild(n.bits)} area ${+(n.area || 0)}`);
    for (const i of os) o.push(i.bind.t === 'loop' ? ` network ${fmtIp(i.rt.ip)} 0.0.0.0 area ${+(i.ospfArea || 0)}` : ` network ${fmtIp(netOf(i.rt.ip, i.rt.bits))} ${wild(i.rt.bits)} area ${+(i.ospfArea || 0)}`);
    if (c.ospfMaxPaths) o.push(` maximum-paths ${c.ospfMaxPaths}`);
    if (c.ospfDefault) o.push(' default-information originate');
    o.push('!');
  }
  if (dev.rip) {
    const r = dev.rip, ifl = (id) => longIf((dev.ifaces.find((x) => x.id === id) || { label: id }).label);
    o.push('router rip');
    if (r.ver) o.push(` version ${r.ver}`);
    if (r.timers) o.push(` timers basic ${r.timers.join(' ')}`);
    for (const x of r.redist || []) o.push(` redistribute ${x.src}${x.as != null ? ' ' + x.as : ''}${x.metric != null ? ' metric ' + x.metric : ''}`);
    if (r.passiveDefault) { o.push(' passive-interface default'); for (const id of r.noPassive || []) o.push(` no passive-interface ${ifl(id)}`); }
    else for (const id of r.passive || []) o.push(` passive-interface ${ifl(id)}`);
    for (const n of (r.nets || []).slice().sort((a, b) => (a >>> 0) - (b >>> 0))) o.push(` network ${fmtIp(n)}`);
    if (r.defOrig) o.push(' default-information originate');
    if (r.defMetric != null) o.push(` default-metric ${r.defMetric}`);
    if (r.maxPaths) o.push(` maximum-paths ${r.maxPaths}`);
    if (r.auto === false) o.push(' no auto-summary');
    o.push('!');
  }
  if (dev.bgp && dev.bgp.asn) {
    const b = dev.bgp;
    o.push(`router bgp ${b.asn}`, ...(b.rid ? [` bgp router-id ${b.rid}`] : []), ' bgp log-neighbor-changes');
    if (b.redistInternal) o.push(' bgp redistribute-internal');
    for (const n of b.neighbors) {
      const us = n.updSrc && dev.ifaces.find((x) => x.id === n.updSrc);
      o.push(` neighbor ${n.ip} remote-as ${n.remoteAs}`);
      if (n.desc) o.push(` neighbor ${n.ip} description ${n.desc}`);
      if (n.multihop) o.push(` neighbor ${n.ip} ebgp-multihop ${n.multihop}`);
      if (n.dcc) o.push(` neighbor ${n.ip} disable-connected-check`);
      if (us) o.push(` neighbor ${n.ip} update-source ${longIf(us.label)}`);
      if (n.shut) o.push(` neighbor ${n.ip} shutdown`);
    }
    for (const x of b.networks) o.push(` network ${fmtIp(x.net)} mask ${fmtMask(x.bits)}`);
    for (const r of b.redist || []) o.push(redistLine(r, 'bgp'));
    for (const n of b.neighbors) {
      if (n.rrClient) o.push(` neighbor ${n.ip} route-reflector-client`);
      if (n.nhSelf) o.push(` neighbor ${n.ip} next-hop-self`);
      if (n.allowAs) o.push(` neighbor ${n.ip} allowas-in${+n.allowAs === 3 ? '' : ' ' + n.allowAs}`);
      if (n.asOverride) o.push(` neighbor ${n.ip} as-override`);
      if (n.bfd) o.push(` neighbor ${n.ip} fall-over bfd`);
      if (n.sendComm) o.push(` neighbor ${n.ip} send-community${n.sendComm !== 'standard' ? ' ' + n.sendComm : ''}`);
      if (n.defOrig) o.push(` neighbor ${n.ip} default-originate`);
      if (n.weight != null) o.push(` neighbor ${n.ip} weight ${n.weight}`);
      if (n.plIn) o.push(` neighbor ${n.ip} prefix-list ${n.plIn} in`);
      if (n.plOut) o.push(` neighbor ${n.ip} prefix-list ${n.plOut} out`);
      if (n.flIn) o.push(` neighbor ${n.ip} filter-list ${n.flIn} in`);
      if (n.flOut) o.push(` neighbor ${n.ip} filter-list ${n.flOut} out`);
      if (n.rmIn) o.push(` neighbor ${n.ip} route-map ${n.rmIn} in`);
      if (n.rmOut) o.push(` neighbor ${n.ip} route-map ${n.rmOut} out`);
    }
    o.push('!');
  }
  for (const i of dev.ifaces) if (i.mode === 'static' && i.gateway && dev.routing) o.push(`ip route 0.0.0.0 0.0.0.0 ${i.gateway}`);
  for (const r of dev.routes || []) {
    const oi = r.outIf && dev.ifaces.find((x) => x.id === r.outIf);
    if (!r.dst || (!r.via && !oi)) continue; // 沒有下一站的只有「ip route … Tunnel0」
    o.push(`ip route ${r.vrf ? 'vrf ' + r.vrf + ' ' : ''}${r.dst} ${parseMask(r.mask || '') != null ? fmtMask(parseMask(r.mask)) : r.mask} ${oi ? longIf(oi.label) + (r.via ? ' ' : '') : ''}${r.via || ''}${r.global ? ' global' : ''}${+r.ad > 1 ? ' ' + r.ad : ''}${r.track != null && r.track !== '' ? ' track ' + r.track : ''}`);
  }
  { const X = (dev.nf || {}).export; if (X && X.ver) o.push(`ip flow-export version ${X.ver}`); if (X && X.src) { const x = dev.ifaces.find((y) => y.id === X.src); o.push(`ip flow-export source ${x ? longIf(x.label) : X.src}`); } if (X && X.ip) o.push(`ip flow-export destination ${X.ip} ${X.port}`); }
  if (dev.localPolicy) o.push(`ip local policy route-map ${dev.localPolicy}`);
  for (const [n, op] of Object.entries(dev.sla || {})) {
    const si = op.src && dev.ifaces.find((x) => x.id === op.src);
    o.push(`ip sla ${n}`, ...(op.dst ? [` icmp-echo ${op.dst}${si ? ' source-interface ' + longIf(si.label) : ''}`] : []), ...(op.dst && +op.freq !== 60 ? [` frequency ${+op.freq || 60}`] : []));
    if (op.sched) o.push(`ip sla schedule ${n} life forever start-time now`);
  }
  for (const r of dev.routes6 || []) if (r.dst && r.via) o.push(`ipv6 route ${r.dst.toUpperCase()} ${r.dev ? r.dev + ' ' : ''}${r.via.toUpperCase()}${+r.ad > 1 ? ' ' + r.ad : ''}`);
  if (dev.ospf6) {
    const c = dev.ospf6, ifl = (id) => (dev.ifaces.find((x) => x.id === id) || { label: id }).label;
    o.push('ipv6 router ospf 1', ...(c.rid ? [` router-id ${c.rid}`] : []), ...(c.refBw ? [` auto-cost reference-bandwidth ${c.refBw}`] : []));
    if (c.passiveDefault) { o.push(' passive-interface default'); for (const id of c.noPassive || []) o.push(` no passive-interface ${ifl(id)}`); }
    else for (const id of c.passive || []) o.push(` passive-interface ${ifl(id)}`);
    if (c.maxPaths) o.push(` maximum-paths ${c.maxPaths}`);
    if (c.default) o.push(' default-information originate');
    o.push('!');
  }
  const out = dev.ifaces.filter(natRule);
  // NAT 的範圍：指定的 ACL、圖形介面填的「NAT 例外」（轉成一份 ACL），或預設的 list 1（全部轉換）
  const natList = (i) => i.natAcl || (splitList(i.natSkip).length ? 'NAT-' + i.label.replace(/[^\w.]+/g, '_').toUpperCase() : '1');
  for (const i of out) o.push(`ip nat inside source list ${natList(i)} interface ${longIf(i.label)} overload`);
  for (const [name, p] of Object.entries(dev.natPools || {})) o.push(`ip nat pool ${name} ${p.start} ${p.end} netmask ${fmtMask(p.bits)}`);
  for (const r of dev.natPoolRules || []) o.push(`ip nat inside source list ${r.acl} pool ${r.pool}${r.overload ? ' overload' : ''}`);
  for (const n of dev.staticNat || []) if (n.pub && n.priv) o.push(`ip nat ${n.nvi ? '' : 'inside '}source static ${n.priv} ${n.pub}`);
  if (dev.nviSrc) { const wi = dev.ifaces.find((x) => x.id === dev.nviSrc.iface); if (wi) o.push(`ip nat source list ${dev.nviSrc.acl || '1'} interface ${longIf(wi.label)} overload`); }
  for (const f of dev.portForwards || []) {
    if (f.port && f.toIp && out[0]) o.push(`ip nat inside source static ${f.proto || 'tcp'} ${f.toIp} ${f.toPort || f.port} interface ${longIf(out[0].label)} ${f.port}`);
  }
  // 改過的 NAT 逾時才會出現在設定裡
  const nt = dev.natTimeout || {};
  for (const [name, keys] of Object.entries(NAT_TIMER)) {
    if (name === 'timeout') continue;
    if (+nt[keys[0]] > 0) o.push(`ip nat translation ${name} ${+nt[keys[0]]}`);
  }
  if (out.some((i) => natList(i) === '1') && !(dev.aclDefs || {})['1']) o.push('access-list 1 permit any');
  for (const [n, l] of Object.entries(dev.timeRanges || {})) o.push('!', `time-range ${n}`, ...l.map((p) => ` periodic ${p.text}`));
  if (+dev.reflexTimeout) o.push(`ip reflexive-list timeout ${+dev.reflexTimeout}`);
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
  // 圖形介面填的 NAT 例外：轉成一份 ACL。貼回去之後它是一般的具名 ACL，所以排在 VPN 的 ACL 後面
  for (const i of out) {
    if (i.natAcl || !splitList(i.natSkip).length) continue;
    o.push('!', `ip access-list extended ${natList(i)}`, ...splitList(i.natSkip).map((n) => ' ' + aclLine({ action: 'deny', proto: 'ip', src: 'any', dst: n, port: '' })), ' permit ip any any');
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
  for (const [name, list] of Object.entries(dev.acl6 || {})) {
    o.push('!', `ipv6 access-list ${name}`);
    // 序號照預設（10、20、30…）的不用寫出來；插進中間的（例如 15）要寫，貼回去順序才會一樣
    list.slice().sort((a, b) => a.seq - b.seq).forEach((r, k) => o.push(` ${r.seq !== (k + 1) * 10 ? 'sequence ' + r.seq + ' ' : ''}${acl6Text(r)}`));
  }
  if (dev.commNewFormat) o.push('ip bgp-community new-format');
  for (const [n, list] of Object.entries(dev.commLists || {})) for (const e of list) o.push(`ip community-list ${/^\d+$/.test(n) ? n : 'standard ' + n} ${e.action} ${e.values.join(' ')}`);
  for (const [n, list] of Object.entries(dev.asPathAcl || {})) for (const e of list) o.push(`ip as-path access-list ${n} ${e.action} ${e.re}`);
  for (const [name, list] of Object.entries(dev.prefixLists || {})) for (const e of list.slice().sort((a, b) => a.seq - b.seq)) o.push(`ip prefix-list ${name} seq ${e.seq} ${e.action} ${fmtIp(e.net)}/${e.bits}${e.ge ? ' ge ' + e.ge : ''}${e.le ? ' le ' + e.le : ''}`);
  for (const [name, list] of Object.entries(dev.routeMaps || {})) {
    for (const e of list) {
      o.push('!', `route-map ${name} ${e.action} ${e.seq}`);
      if (e.match.pl) o.push(` match ip address prefix-list ${e.match.pl}`);
      if (e.match.fl) o.push(` match as-path ${e.match.fl}`);
      if (e.match.acl) o.push(` match ip address ${e.match.acl}`);
      if (e.match.tag != null) o.push(` match tag ${e.match.tag}`);
      if (e.match.cl) o.push(` match community ${e.match.cl}`);
      if (e.set.lp != null) o.push(` set local-preference ${e.set.lp}`);
      if (e.set.weight != null) o.push(` set weight ${e.set.weight}`);
      if (e.set.med != null) o.push(` set metric ${e.set.med}`);
      if (e.set.prepend) o.push(` set as-path prepend ${e.set.prepend.join(' ')}`);
      if (e.set.metricType) o.push(` set metric-type type-${e.set.metricType}`);
      if (e.set.tag != null) o.push(` set tag ${e.set.tag}`);
      if (e.set.comm) o.push(` set community ${e.set.comm.length ? e.set.comm.join(' ') : 'none'}${e.set.commAdd ? ' additive' : ''}`);
      if ((e.set.nh || []).length) o.push(` set ip next-hop ${e.set.nh.join(' ')}`);
      if ((e.set.defNh || []).length) o.push(` set ip default next-hop ${e.set.defNh.join(' ')}`);
    }
  }
  if (dev.nat64 && dev.nat64.prefix) { o.push('!', `nat64 prefix stateful ${dev.nat64.prefix.toUpperCase()}`); const oi = dev.ifaces.find((x) => x.id === dev.nat64.out); if (dev.nat64.list && oi) o.push(`nat64 v6v4 list ${dev.nat64.list} interface ${longIf(oi.label)} overload`); }
  if (dev.aaa && dev.aaa.src) { const i = dev.ifaces.find((x) => x.id === dev.aaa.src); if (i) o.push('!', `ip tacacs source-interface ${i.label}`); }
  for (const t of dev.tacacs || []) o.push('!', `tacacs server ${t.name}`, ...(t.ip ? [` address ipv4 ${t.ip}`] : []), ...(t.key ? [` key 7 ${hex(t.key)}`] : []));
  if (dev.radius && dev.radius.ip) o.push('!', 'radius server AAA', ` address ipv4 ${dev.radius.ip} auth-port 1812 acct-port 1813`, ` key 7 ${hex(dev.radius.secret || '')}`);
  if (m) {
    o.push('!');
    for (const k of ['debug', 'log']) {
      const c = (m.stamps || {})[k];
      if (!c) continue;
      o.push(c.off ? `no service timestamps ${k}` : !c.dt ? `service timestamps ${k} uptime` : `service timestamps ${k} datetime${c.msec ? ' msec' : ''}${c.local ? ' localtime' : ''}${c.tz ? ' show-timezone' : ''}${c.year ? ' year' : ''}`);
    }
    if (dev.unsupportedXcvr) o.push('service unsupported-transceiver');
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
    if (m.restconf) o.push('ip http authentication local', 'restconf');
    if (m.netconf) o.push('netconf-yang');
    const allow = String(m.allow || '').split(/[,\s]+/).filter(Boolean).map((s) => { const x = s.match(/^([\d.]+)(?:\/(\d+))?$/); const ip = x && parseIp(x[1]); return ip == null ? null : { net: ip, bits: x[2] == null ? 32 : +x[2] }; }).filter(Boolean);
    const an = m.aclName || 'MGMT';
    if (allow.length) { o.push(`ip access-list standard ${an}`); for (const c of allow) o.push(c.bits === 32 ? ` permit host ${fmtIp(c.net)}` : ` permit ${fmtIp(netOf(c.net, c.bits))} ${wild(c.bits)}`); }
    const tr = [m.ssh && 'ssh', m.telnet && 'telnet'].filter(Boolean).join(' ') || 'none';
    const et = m.execTimeout == null || m.execTimeout === '' ? null : +m.execTimeout;
    o.push('line vty 0 4', ` transport input ${tr}`, ...(allow.length ? [` access-class ${an} in`] : []),
      ...(et != null && et !== 600 ? [` exec-timeout ${Math.floor(et / 60)} ${et % 60}`] : []), ...(m.vtyPriv != null ? [` privilege level ${m.vtyPriv}`] : []), ...(m.vtyPass ? [` password 7 ${hex(m.vtyPass)}`] : []),
      ...(dev.aaa && dev.aaa.on && (m.vtyAuthList || Object.keys(dev.aaa.authn || {}).length) ? (m.vtyAuthList ? [` login authentication ${m.vtyAuthList}`] : []) : [m.vtyLogin === 'local' ? ' login local' : m.vtyLogin === 'none' ? ' no login' : ' login']));
  }
  o.push('!', 'end');
  return o;
}

/** FHRP 的設定行：VRRP 印 vrrp …、HSRP 印 standby …；預設值（priority 100、VRRP 的 preempt）不印 */
function fhrpLines(v) {
  const kw = fhrpProto(v) === 'hsrp' ? 'standby' : fhrpProto(v) === 'glbp' ? 'glbp' : 'vrrp', g = fhrpGroup(v);
  const l = [];
  if (v.on && v.vip) l.push(` ${kw} ${g} ip ${v.vip}`);
  if (+v.prio && +v.prio !== 100) l.push(` ${kw} ${g} priority ${+v.prio}`);
  if (kw !== 'vrrp' && fhrpPreempt(v)) l.push(` ${kw} ${g} preempt`);
  if (kw === 'glbp' && v.lb) l.push(` glbp ${g} load-balancing ${v.lb}`);
  if (kw === 'vrrp' && !fhrpPreempt(v)) l.push(` no vrrp ${g} preempt`);
  for (const t of v.track || []) l.push(` ${kw} ${g} track ${t.obj}${t.dec != null ? ' decrement ' + t.dec : ''}`);
  return l;
}
/** 把介面設定成某個 FHRP 群組（換協定或群組號碼就是換一組新的設定） */
function fhrpOn(i, proto, g) {
  let v = i.vrrp;
  if (!v || fhrpProto(v) !== proto || fhrpGroup(v) !== +g) {
    const keep = v && fhrpProto(v) === proto ? { prio: v.prio, track: v.track } : {};
    v = i.vrrp = { on: false, vip: '', prio: '100', ...keep };
    if (!v.track) delete v.track;
  }
  if (proto === 'hsrp' || proto === 'glbp') v.proto = proto; else delete v.proto;
  if (+g !== 1) v.group = +g; else delete v.group;
  return v;
}
