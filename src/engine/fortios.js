// FortiOS 風格的 CLI：config → edit → set → next → end。
// 每個設定區段都定義「怎麼從設備的設定讀出 FortiOS 的欄位」和「怎麼把欄位寫回去」，
// 所以 show 印出來的內容可以整份貼到另一台 FortiGate 上，得到相同的設定。不依賴瀏覽器，可用 Node 測試。
import { parseIp, fmtIp, parseMask, fmtMask, netOf } from './ip.js';
import { SERVICE_NAMES, accessOf, sessionLog, routeRows, sessionRows, clearSessions, saInfo } from './sim.js';
import { ntpInfo, plainStamp, logRows, clearLog, syslogStats, vtyRows, markReboot, bootTime } from './ops.js';
import { counters, startSniff, bpf, dflowOf, fgIfName } from './wire.js';
import { linkInfo, cloneState, makeDevice } from './model.js';
import { recompute } from './sim.js';
import { transfer, configFile, IMAGES, PLATFORM, PLATFORM_NAME, ensureFlash } from './files.js';

/**
 * execute restore config：整份設定換掉。FortiGate 沒有 running / startup 之分，
 * 還原時從出廠狀態開始套用檔案裡的每一行，然後重新開機。回傳套用失敗的行數
 */
export function fortiFromText(state, dev, lines) {
  const s2 = cloneState(state);
  const fresh = makeDevice(dev.model, dev.id, { name: dev.name, pos: dev.pos });
  s2.devices[dev.id] = fresh;
  recompute(s2);
  const sess = fortiSession(() => s2.devices[dev.id], () => s2);
  const clear = ['config system interface', ...fresh.ifaces.flatMap((i) => [`edit "${i.id}"`, 'unset allowaccess', 'next']), 'end'];
  let bad = 0;
  for (const l of [...clear, ...lines]) { const r = sess.exec(l); if (r.out.some((o) => /parse error|Command fail|not found in datasource|operator error/.test(o))) bad++; }
  const keep = new Set(['id', 'model', 'kind', 'pos', 'ports', 'locked', 'note', 'fw', 'fwNext', 'rt']);
  for (const k of Object.keys(dev)) if (!keep.has(k)) delete dev[k];
  for (const [k, v] of Object.entries(s2.devices[dev.id])) if (!keep.has(k)) dev[k] = v;
  return bad;
}
/** FortiOS 顯示密碼時會加密（ENC …），貼回去的時候再解開 */
const encPw = (s) => { let o = ''; for (const c of String(s)) o += c.charCodeAt(0).toString(16).padStart(4, '0'); return o; };
const decPw = (h) => (String(h).match(/.{4}/g) || []).map((x) => String.fromCharCode(parseInt(x, 16))).join('');
/** FortiOS 的版本號 7.2.10 → [7, 2, 10] */
const verOf = (v) => String(v || '0').split('.').map((x) => parseInt(x, 10) || 0);

const ACCESS = ['ping', 'https', 'ssh', 'snmp', 'http', 'telnet', 'fgfm', 'radius-acct', 'fabric'];
/** 可以放好幾個值、能用 append / unselect 的欄位 */
const MULTI = new Set(['allowaccess', 'member', 'srcintf', 'dstintf', 'srcaddr', 'dstaddr', 'service', 'proposal', 'dhgrp', 'dns-server', 'interface']);
const PROPOSALS = ['aes128-sha1', 'aes128-sha256', 'aes256-sha1', 'aes256-sha256'];
const DH = ['2', '5', '14', '19'];
const P1_DEFAULT = ['aes128-sha256', 'aes256-sha256', 'aes128-sha1', 'aes256-sha1']; // FortiOS 新建通道時的預設提案
const DH_DEFAULT = ['14', '5'];

const dottedBits = (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s || '') ? parseMask(s) : null);
const list = (s) => String(s || '').split(/[,\s]+/).filter(Boolean);
const uniq = (a) => [...new Set(a)];
const clone = (x) => JSON.parse(JSON.stringify(x));
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
/** "10.1.0.5/24" → "10.1.0.0/24"；單一位址不帶長度 */
function normCidr(s) {
  const m = String(s).trim().match(/^([\d.]+)(?:\/(\d+))?$/);
  const ip = m && parseIp(m[1]);
  if (ip == null) return null;
  const bits = m[2] == null ? 32 : +m[2];
  return bits > 32 ? null : bits === 32 ? fmtIp(ip) : `${fmtIp(netOf(ip, bits))}/${bits}`;
}
const cidrTok = (c) => { const [a, b] = normCidr(c).split('/'); return [a, fmtMask(b == null ? 32 : +b)]; };
function tokCidr(t) {
  if (!t) return null;
  if (t.length === 1) return normCidr(t[0]);
  const ip = parseIp(t[0] || ''), bits = dottedBits(t[1]);
  return ip == null || bits == null ? null : bits === 32 ? fmtIp(ip) : `${fmtIp(netOf(ip, bits))}/${bits}`;
}
const qv = (s) => '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
function tokenize(line) {
  const out = [], re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}
const hostOf = (d) => d.name.replace(/\s+/g, '-');
const ERR = (msg) => ({ err: msg });
const notFound = (what) => ERR(`entry not found in datasource\n（${what}）`);

// ───────────────────────── 名稱與設定物件之間的對應 ─────────────────────────

const tunnels = (d) => d.vpns || [];
const vipName = (f) => f.name || `vip-${f.proto || 'tcp'}-${f.port}`;
const natName = (n) => n.name || `vip-${n.pub}`;
const poolName = (vs) => vs.pool || 'SSLVPN_TUNNEL_ADDR1';
const sslIntf = 'ssl.root';

function intfName(d, id) {
  if (id === 'vpn:remote') return sslIntf;
  return String(id).startsWith('vpn:') ? String(id).slice(4) : id;
}
function intfId(d, name) {
  if (name === 'any') return 'any';
  if (d.ifaces.some((i) => i.id === name)) return name;
  if (name === sslIntf && d.vpnServer) return 'vpn:remote';
  if (tunnels(d).some((t) => t.name === name)) return 'vpn:' + name;
  return null;
}
/** 位址常值 → 物件名稱（沒有對應的物件就用位址本身當名稱） */
function addrName(d, lit) {
  if (!lit || lit === 'any' || lit === 'all') return 'all';
  const n = normCidr(lit) || lit;
  for (const [name, o] of Object.entries(d.addrObjs || {})) if (o.cidr === n) return name;
  return n;
}
function rangeList(o) {
  const a = parseIp(o.start || ''), b = parseIp(o.end || '');
  if (a == null || b == null || b < a || b - a > 255) return null;
  return Array.from({ length: b - a + 1 }, (_, n) => fmtIp(a + n));
}
/** 物件名稱（位址、位址群組、VIP）→ 位址常值的清單；找不到回傳 null */
function addrResolve(d, name, seen = new Set()) {
  if (name === 'all' || name === 'any') return ['any'];
  const o = (d.addrObjs || {})[name];
  if (o) return o.cidr ? [o.cidr] : rangeList(o);
  const g = (d.addrGrps || {})[name];
  if (g && !seen.has(name)) {
    seen.add(name);
    const parts = g.map((m) => addrResolve(d, m, seen));
    return parts.some((p) => !p) ? null : parts.flat();
  }
  const vip = (d.portForwards || []).find((f) => vipName(f) === name) || null;
  if (vip) return [vip.toIp];
  const sn = (d.staticNat || []).find((n) => natName(n) === name);
  if (sn) return [sn.priv];
  const n = normCidr(name);
  return n ? [n] : null;
}
const specNames = (d, spec, isDst) => {
  const items = list(spec);
  if (!items.length || items.some((x) => x === 'any' || x === 'all')) return ['all'];
  return items.map((x) => {
    const vip = isDst && ((d.portForwards || []).find((f) => f.toIp === x) || null);
    const sn = isDst && !vip && (d.staticNat || []).find((n) => n.priv === x);
    return vip ? vipName(vip) : sn ? natName(sn) : addrName(d, x);
  });
};
function resolveSpec(d, toks) {
  const out = [];
  for (const t of toks) {
    const r = addrResolve(d, t);
    if (!r) return null;
    out.push(...r);
  }
  return out.includes('any') ? 'any' : uniq(out).join(', ');
}
function ensureIds(d) {
  let max = 0;
  for (const p of d.policies) if (+p.id > max) max = +p.id;
  for (const p of d.policies) if (!(+p.id > 0)) p.id = ++max;
}
/** 通道的第二階段：一筆對應一組「本地網段 ↔ 遠端網段」 */
function p2list(t) {
  const lo = list(t.local).map(normCidr), re = list(t.remote).map(normCidr);
  if (t.p2 && sameSet(uniq(t.p2.map((e) => e.src)), lo) && sameSet(uniq(t.p2.map((e) => e.dst)), re)) return t.p2;
  if (!lo.length || !re.length) return []; // 還沒有第二階段
  return lo.flatMap((src) => re.map((dst) => ({ src, dst }))).map((e, n) => ({ name: n ? `${t.name}-${n + 1}` : t.name, ...e }));
}
const setP2 = (t, entries) => { t.p2 = entries; t.local = uniq(entries.map((e) => e.src)).join(', '); t.remote = uniq(entries.map((e) => e.dst)).join(', '); };
const wanOf = (d, t) => {
  const T = ((d.rt && d.rt.tunnels) || []).find((x) => x.cfg === t);
  const i = T && T.localIp != null && d.ifaces.find((x) => x.rt && x.rt.ip === T.localIp);
  return t.wan || (i && i.id) || (d.ifaces.find((x) => /^wan/.test(x.id)) || d.ifaces[0]).id;
};
function parseProposals(toks) {
  if (!toks || !toks.length) return null;
  return toks.every((x) => PROPOSALS.includes(x.toLowerCase())) ? toks.map((x) => x.toLowerCase()) : null;
}

// ───────────────────────── 設定區段 ─────────────────────────
// read(d, st) → [{ key, f: { 欄位: [字串…] }, sub: { 子表: [{ key, f }] } }]
// write(d, key, f, sub, st, isNew) → 失敗時回傳 { err }；fields 的值：'q' 輸出時加引號，'b' 不加

const SEC = {
  'system global': {
    single: true, fields: { hostname: 'q', admintimeout: 'b' },
    // admintimeout：管理者登入之後閒置幾分鐘自動登出（預設 5）
    read: (d) => [{ key: '', f: { hostname: [d.name], ...(d.mgmt && +d.mgmt.adminTimeout > 0 && +d.mgmt.adminTimeout !== 5 ? { admintimeout: [String(d.mgmt.adminTimeout)] } : {}) } }],
    write(d, key, f) {
      const a = (f.admintimeout || [])[0];
      if (a != null && (!/^\d+$/.test(a) || +a < 1 || +a > 480)) return ERR('admintimeout 必須是 1 – 480 分鐘（預設 5）');
      if (f.hostname && f.hostname.length) d.name = f.hostname.join(' ');
      if (d.mgmt) { if (a == null || +a === 5) delete d.mgmt.adminTimeout; else d.mgmt.adminTimeout = +a; }
      return undefined;
    },
  },
  'system interface': {
    noCreate: true, fields: { type: 'b', mode: 'b', ip: 'b', allowaccess: 'b', username: 'q', password: 'b' },
    read: (d) => d.ifaces.map((i) => ({
      key: i.id,
      f: {
        ...(i.bind.t === 'bridge' ? { type: ['hard-switch'] } : {}),
        mode: [i.mode],
        ...(i.mode === 'static' && i.ip && parseMask(i.mask || '') != null ? { ip: [i.ip, fmtMask(parseMask(i.mask))] } : {}),
        ...(accessOf(d, i).length ? { allowaccess: accessOf(d, i) } : {}),
        ...(i.mode === 'pppoe' ? { username: [i.user || ''], password: [i.pass || ''] } : {}),
      },
    })),
    write(d, key, f) {
      const i = d.ifaces.find((x) => x.id === key);
      if (!i) return notFound(`沒有 ${key} 這個介面；可用的介面：${d.ifaces.map((x) => x.id).join('、')}`);
      const mode = f.mode ? f.mode[0] : i.mode;
      if (!['static', 'dhcp', 'pppoe'].includes(mode)) return ERR('mode 必須是 static、dhcp 或 pppoe');
      if (f.ip && (parseIp(f.ip[0] || '') == null || dottedBits(f.ip[1]) == null)) return ERR('用法：set ip <IP> <遮罩>，例如 set ip 192.168.1.1 255.255.255.0');
      const acc = (f.allowaccess || []).map((x) => x.toLowerCase());
      const bad = acc.find((x) => !ACCESS.includes(x));
      if (bad) return ERR(`allowaccess 不認識「${bad}」；可用的值：${ACCESS.join(' ')}`);
      i.mode = mode;
      if (mode === 'static') { i.ip = f.ip ? f.ip[0] : ''; i.mask = f.ip ? f.ip[1] : ''; }
      if (mode === 'pppoe') { i.user = (f.username || [''])[0]; i.pass = (f.password || [''])[0]; }
      i.access = ACCESS.filter((x) => acc.includes(x));
      i.ping = i.access.includes('ping');
      return undefined;
    },
    remove: () => ERR('實體介面不能刪除'),
  },
  'system admin': {
    only: (d) => !!d.mgmt, fields: { accprofile: 'q', password: 'b', ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`trusthost${n + 1}`, 'b'])) },
    read: (d) => [{
      key: d.mgmt.user || 'admin',
      f: { accprofile: ['super_admin'], ...Object.fromEntries(list(d.mgmt.allow).filter(normCidr).map((c, n) => [`trusthost${n + 1}`, cidrTok(c)])), password: [d.mgmt.pass || ''] },
    }],
    write(d, key, f) {
      const hosts = [];
      for (let n = 1; n <= 10; n++) {
        const t = f['trusthost' + n];
        if (!t) continue;
        const c = tokCidr(t);
        if (!c) return ERR(`trusthost${n} 的格式：<IP> <遮罩>`);
        if (c !== '0.0.0.0/0') hosts.push(c);
      }
      d.mgmt.user = key;
      if (f.password) d.mgmt.pass = f.password.join(' ');
      d.mgmt.allow = hosts.join(', ');
      return undefined;
    },
    remove: () => ERR('唯一的管理員帳號不能刪除'),
  },
  'system ntp': {
    single: true, only: (d) => !!d.mgmt, fields: { ntpsync: 'b', type: 'b', syncinterval: 'b' },
    subs: { ntpserver: { numeric: true, fields: { server: 'q' } } },
    read: (d) => [d.mgmt.ntp ? { key: '', f: { ntpsync: ['enable'], type: ['custom'] }, sub: { ntpserver: [{ key: '1', f: { server: [d.mgmt.ntp] } }] } } : { key: '', f: {} }],
    write(d, key, f, sub) {
      const srv = (((sub.ntpserver || [])[0] || {}).f || {}).server;
      if (srv && parseIp(srv[0] || '') == null) return ERR('ntpserver 的 server 請填 IP 位址');
      d.mgmt.ntp = srv && (f.ntpsync || ['enable'])[0] !== 'disable' ? srv[0] : '';
      return undefined;
    },
  },
  'log syslogd setting': {
    single: true, only: (d) => !!d.mgmt, fields: { status: 'b', server: 'q', port: 'b' },
    read: (d) => [{ key: '', f: d.mgmt.syslog ? { status: ['enable'], server: [d.mgmt.syslog] } : {} }],
    write(d, key, f) {
      const on = (f.status || [])[0] === 'enable';
      if (on && parseIp((f.server || [''])[0]) == null) return ERR('啟用 syslog 之前要先 set server <Syslog 伺服器 IP>');
      d.mgmt.syslog = on ? f.server[0] : '';
      return undefined;
    },
  },
  // 連線可以閒置多久（TCP）。UDP 與 ICMP 另有較短的固定逾時
  'system session-ttl': {
    single: true, only: (d) => !!d.policies, fields: { default: 'b' },
    read: (d) => [{ key: '', f: d.natTimeout && +d.natTimeout.tcp > 0 ? { default: [String(d.natTimeout.tcp)] } : {} }],
    write(d, key, f) {
      const v = (f.default || [])[0];
      if (v != null && (!/^\d+$/.test(v) || +v < 300 || +v > 2764800)) return ERR('default 必須是 300 – 2764800 秒（預設 3600）');
      if (v == null || +v === 3600) { if (d.natTimeout) delete d.natTimeout.tcp; } else (d.natTimeout ||= {}).tcp = +v;
      if (d.natTimeout && !Object.keys(d.natTimeout).length) delete d.natTimeout;
      return undefined;
    },
  },
  // SNMP 代理本身要先開：config system snmp sysinfo → set status enable
  'system snmp sysinfo': {
    single: true, only: (d) => !!d.mgmt, fields: { status: 'b', description: 'q', location: 'q', 'contact-info': 'q' },
    read: (d) => [{ key: '', f: d.mgmt.snmpAgent ? { status: ['enable'], ...(d.mgmt.location ? { location: [d.mgmt.location] } : {}), ...(d.mgmt.contact ? { 'contact-info': [d.mgmt.contact] } : {}) } : {} }],
    write(d, key, f) {
      d.mgmt.snmpAgent = (f.status || [])[0] === 'enable';
      if (f.location) d.mgmt.location = f.location.join(' '); else delete d.mgmt.location;
      if (f['contact-info']) d.mgmt.contact = f['contact-info'].join(' '); else delete d.mgmt.contact;
      return undefined;
    },
  },
  'system snmp community': {
    numeric: true, only: (d) => !!d.mgmt, fields: { name: 'q', status: 'b', events: 'b' },
    subs: { hosts: { numeric: true, fields: { ip: 'b', 'host-type': 'b' } } },
    read: (d) => (d.mgmt.snmp === 'v2c' ? [{ key: '1', f: { name: [d.mgmt.community || 'public'] }, sub: { hosts: (d.mgmt.snmpHosts || []).map((h, n) => ({ key: String(n + 1), f: { ip: cidrTok(h) } })) } }] : []),
    write(d, key, f, sub) {
      if (!f.name || !f.name[0]) return ERR('community 需要名稱：set name "<字串>"');
      const hosts = ((sub && sub.hosts) || []).map((e) => tokCidr((e.f || {}).ip || [])).filter(Boolean);
      Object.assign(d.mgmt, { snmp: 'v2c', community: f.name[0], snmpHosts: hosts });
      return undefined;
    },
    remove(d) { d.mgmt.snmp = 'off'; delete d.mgmt.snmpHosts; },
  },
  'system snmp user': {
    only: (d) => !!d.mgmt, fields: { 'security-level': 'b', 'auth-proto': 'b', 'auth-pwd': 'b', 'priv-proto': 'b', 'priv-pwd': 'b', 'notify-hosts': 'b', status: 'b' },
    read: (d) => (d.mgmt.snmp === 'v3' && d.mgmt.snmpUser ? [{
      key: d.mgmt.snmpUser.user,
      f: { 'security-level': ['auth-priv'], 'auth-proto': ['sha256'], 'auth-pwd': ['ENC', encPw(d.mgmt.snmpUser.auth)], 'priv-proto': ['aes256'], 'priv-pwd': ['ENC', encPw(d.mgmt.snmpUser.priv)],
        ...((d.mgmt.snmpHosts || []).length ? { 'notify-hosts': d.mgmt.snmpHosts.map((h) => h.split('/')[0]) } : {}) },
    }] : []),
    write(d, key, f) {
      const pw = (k) => { const v = f[k] || []; return v[0] === 'ENC' ? decPw(v[1] || '') : v.join(' '); };
      if (!pw('auth-pwd') || pw('auth-pwd').length < 8) return ERR('auth-pwd 至少要 8 個字元（SNMPv3 的認證密碼）');
      d.mgmt.snmp = 'v3';
      d.mgmt.snmpUser = { user: key, auth: pw('auth-pwd'), priv: pw('priv-pwd') };
      if (f['notify-hosts']) d.mgmt.snmpHosts = f['notify-hosts'].map((ip) => ip + '/32');
      return undefined;
    },
    remove(d) { d.mgmt.snmp = 'off'; delete d.mgmt.snmpUser; },
  },
  'system dhcp server': {
    numeric: true, fields: { 'default-gateway': 'b', netmask: 'b', interface: 'q', 'dns-service': 'b', 'dns-server1': 'b', 'dns-server2': 'b', 'dns-server3': 'b', 'lease-time': 'b', 'tftp-server': 'q' },
    subs: {
      'ip-range': { numeric: true, fields: { 'start-ip': 'b', 'end-ip': 'b' } },
      'reserved-address': { numeric: true, fields: { ip: 'b', mac: 'b', description: 'q' } },
    },
    servers: (d) => d.ifaces.filter((i) => i.dhcp && i.dhcp.on),
    read(d) {
      return this.servers(d).map((i, n) => ({
        key: String(n + 1),
        f: {
          ...(i.dhcp.gw || i.ip ? { 'default-gateway': [i.dhcp.gw || i.ip] } : {}),
          ...(parseMask(i.mask || '') != null ? { netmask: [fmtMask(parseMask(i.mask))] } : {}),
          interface: [i.id],
          ...Object.fromEntries(list(i.dhcp.dns).slice(0, 3).map((x, k) => [`dns-server${k + 1}`, [x]])),
          ...(+i.dhcp.lease > 0 ? { 'lease-time': [String(+i.dhcp.lease)] } : {}),
          ...(i.dhcp.tftp ? { 'tftp-server': list(i.dhcp.tftp) } : {}),
        },
        sub: {
          'ip-range': i.dhcp.start && i.dhcp.end ? [{ key: '1', f: { 'start-ip': [i.dhcp.start], 'end-ip': [i.dhcp.end] } }] : [],
          'reserved-address': (i.dhcp.reserved || []).filter((r) => r.ip && r.mac).map((r, k) => ({ key: String(k + 1), f: { ip: [r.ip], mac: [r.mac] } })),
        },
      }));
    },
    write(d, key, f, sub, st, isNew) {
      const i = d.ifaces.find((x) => x.id === (f.interface || [])[0]);
      if (!i) return notFound('DHCP 伺服器要先指定介面：set interface "internal"');
      const r = ((sub['ip-range'] || [])[0] || {}).f || {};
      const a = (r['start-ip'] || [''])[0], b = (r['end-ip'] || [''])[0];
      if (parseIp(a) == null || parseIp(b) == null) return ERR('還沒有位址範圍：config ip-range → edit 1 → set start-ip … / set end-ip … → next → end');
      const gw = (f['default-gateway'] || [''])[0];
      if (gw && parseIp(gw) == null) return ERR('default-gateway 請填 IP 位址');
      const dns = ['dns-server1', 'dns-server2', 'dns-server3'].map((k) => (f[k] || [''])[0]).filter(Boolean);
      if (dns.some((x) => parseIp(x) == null)) return ERR('dns-server 請填 IP 位址');
      const prev = !isNew && this.servers(d)[+key - 1];
      if (prev && prev !== i) prev.dhcp.on = false;
      const rsv = (sub['reserved-address'] || []).map((e) => ({ ip: (e.f.ip || [''])[0], mac: (e.f.mac || [''])[0].toLowerCase() })).filter((x) => x.ip && x.mac);
      const lease = (f['lease-time'] || [''])[0];
      if (lease && !(+lease >= 300)) return ERR('lease-time 是秒數，最短 300');
      const tftp = (f['tftp-server'] || []).map((x) => x.replace(/"/g, ''));
      if (tftp.some((x) => parseIp(x) == null)) return ERR('tftp-server 請填 IP 位址');
      Object.assign(i.dhcp, { on: true, start: a, end: b, gw: gw && gw !== i.ip ? gw : '', dns: dns.join(', '), reserved: rsv, lease: lease ? +lease : '', tftp: tftp.join(', ') });
      return undefined;
    },
    remove(d, key) { const i = this.servers(d)[+key - 1]; if (!i) return notFound('沒有這個編號的 DHCP 伺服器'); i.dhcp.on = false; return undefined; },
  },
  'firewall address': {
    fields: { type: 'b', subnet: 'b', 'start-ip': 'b', 'end-ip': 'b', comment: 'q' },
    read(d) {
      const out = Object.entries(d.addrObjs || {}).map(([key, o]) => ({ key, f: o.cidr ? { subnet: cidrTok(o.cidr) } : { type: ['iprange'], 'start-ip': [o.start], 'end-ip': [o.end] } }));
      const have = new Set(out.map((e) => e.key));
      const vs = d.vpnServer;
      if (vs && vs.start && vs.end && !have.has(poolName(vs))) { out.push({ key: poolName(vs), f: { type: ['iprange'], 'start-ip': [vs.start], 'end-ip': [vs.end] } }); have.add(poolName(vs)); }
      // 政策裡直接寫位址的地方，在 FortiOS 裡都必須是一個位址物件
      const used = [...(d.policies || []).flatMap((p) => [...list(p.src), ...list(p.dst)]), ...(vs ? list(vs.subnets) : [])];
      for (const lit of used) {
        const n = normCidr(lit);
        if (!n || have.has(addrName(d, n))) continue;
        if ((d.portForwards || []).some((f) => f.toIp === n) || (d.staticNat || []).some((x) => x.priv === n)) continue; // 會以 VIP 的名稱出現
        have.add(n);
        out.push({ key: n, f: { subnet: cidrTok(n) } });
      }
      return out;
    },
    write(d, key, f) {
      if (key === 'all' || key === 'any') return ERR('"all" 是內建的位址物件，不能修改');
      const objs = (d.addrObjs ||= {}), old = objs[key];
      if ((f.type || ['ipmask'])[0] === 'iprange') {
        const a = (f['start-ip'] || [''])[0], b = (f['end-ip'] || [''])[0];
        if (parseIp(a) == null || parseIp(b) == null || parseIp(b) < parseIp(a)) return ERR('iprange 需要 set start-ip 與 set end-ip');
        objs[key] = { start: a, end: b };
        const vs = d.vpnServer;
        if (vs && poolName(vs) === key) Object.assign(vs, { start: a, end: b });
        return undefined;
      }
      const c = tokCidr(f.subnet);
      if (!c) return ERR('用法：set subnet <網段> <遮罩>，例如 set subnet 10.1.10.0 255.255.255.0');
      objs[key] = { cidr: c };
      // 物件的內容改了，引用它的政策跟著變
      if (old && old.cidr && old.cidr !== c && !Object.values(objs).some((o) => o.cidr === old.cidr)) {
        const swap = (s) => list(s).map((x) => (normCidr(x) === old.cidr ? c : x)).join(', ');
        for (const p of d.policies || []) { if (p.src !== 'any') p.src = swap(p.src); if (p.dst !== 'any') p.dst = swap(p.dst); }
      }
      return undefined;
    },
    remove(d, key) {
      const o = (d.addrObjs || {})[key];
      if (!o) return notFound(`沒有名為 ${key} 的位址物件（政策裡直接填的位址不是物件，改政策就好）`);
      const n = (d.policies || []).filter((p) => o.cidr && [...list(p.src), ...list(p.dst)].some((x) => normCidr(x) === o.cidr)).length;
      if (n) return ERR(`The entry is used by other ${n} entries\n（還有 ${n} 條政策在使用這個位址物件）`);
      delete d.addrObjs[key];
      return undefined;
    },
  },
  'firewall addrgrp': {
    fields: { member: 'q', comment: 'q' },
    read: (d) => Object.entries(d.addrGrps || {}).map(([key, m]) => ({ key, f: { member: m } })),
    write(d, key, f) {
      const m = f.member || [];
      if (!m.length) return ERR('群組至少要有一個成員：set member "物件1" "物件2"');
      const bad = m.find((x) => x === key || !addrResolve(d, x));
      if (bad) return notFound(`找不到位址物件 ${bad}`);
      (d.addrGrps ||= {})[key] = m;
      return undefined;
    },
    remove(d, key) { if (!(d.addrGrps || {})[key]) return notFound(`沒有名為 ${key} 的位址群組`); delete d.addrGrps[key]; return undefined; },
  },
  'firewall vip': {
    fields: { extip: 'b', mappedip: 'q', extintf: 'q', portforward: 'b', protocol: 'b', extport: 'b', mappedport: 'b', comment: 'q' },
    read: (d) => [
      ...(d.portForwards || []).filter((f) => f.port && f.toIp).map((f) => ({
        key: vipName(f),
        f: { extip: [f.extIp || '0.0.0.0'], mappedip: [f.toIp], extintf: ['any'], portforward: ['enable'], protocol: [f.proto || 'tcp'], extport: [String(f.port)], mappedport: [String(f.toPort || f.port)] },
      })),
      ...(d.staticNat || []).filter((n) => n.pub && n.priv).map((n) => ({ key: natName(n), f: { extip: [n.pub], mappedip: [n.priv], extintf: ['any'] } })),
    ],
    write(d, key, f) {
      const ext = (f.extip || ['0.0.0.0'])[0].split('-')[0], map = (f.mappedip || [''])[0].split('-')[0];
      if (parseIp(ext) == null) return ERR('extip 請填對外的 IP 位址');
      if (parseIp(map) == null) return ERR('還沒有 set mappedip "<內部伺服器 IP>"');
      const pf = (d.portForwards ||= []), drop = () => {
        d.portForwards = pf.filter((x) => vipName(x) !== key);
        if (d.staticNat) d.staticNat = d.staticNat.filter((x) => natName(x) !== key);
      };
      if ((f.portforward || ['disable'])[0] === 'enable') {
        const proto = (f.protocol || ['tcp'])[0].toLowerCase(), ep = (f.extport || [''])[0], mp = (f.mappedport || [ep])[0];
        if (!['tcp', 'udp'].includes(proto)) return ERR('protocol 必須是 tcp 或 udp');
        if (!/^\d+$/.test(ep) || !/^\d+$/.test(mp)) return ERR('連接埠轉發需要 set extport <對外埠> 與 set mappedport <內部埠>');
        const cur = pf.find((x) => vipName(x) === key);
        const val = { name: key, proto, port: ep, toIp: map, toPort: mp === ep ? '' : mp, extIp: ext === '0.0.0.0' ? '' : ext };
        if (cur && !(d.staticNat || []).some((x) => natName(x) === key)) Object.assign(cur, val);
        else { drop(); d.portForwards.push(val); }
        return undefined;
      }
      if (ext === '0.0.0.0') return ERR('一對一的 VIP（沒有 portforward）必須指定對外的公用 IP：set extip <IP>');
      drop();
      (d.staticNat ||= []).push({ name: key, pub: ext, priv: map });
      return undefined;
    },
    remove(d, key) {
      const n = (d.portForwards || []).length + (d.staticNat || []).length;
      d.portForwards = (d.portForwards || []).filter((x) => vipName(x) !== key);
      if (d.staticNat) d.staticNat = d.staticNat.filter((x) => natName(x) !== key);
      return (d.portForwards || []).length + (d.staticNat || []).length < n ? undefined : notFound(`沒有名為 ${key} 的 VIP`);
    },
  },
  'user local': {
    only: (d) => !!d.vpnServer, fields: { type: 'b', passwd: 'b', status: 'b' },
    read: (d) => d.vpnServer.users.filter((u) => u.user).map((u) => ({ key: u.user, f: { type: ['password'], passwd: [u.pass || ''] } })),
    write(d, key, f) {
      const pass = (f.passwd || []).join(' ');
      if (!pass) return ERR('還沒有密碼：set passwd <密碼>');
      const u = d.vpnServer.users.find((x) => x.user === key);
      if (u) u.pass = pass; else d.vpnServer.users.push({ user: key, pass });
      return undefined;
    },
    remove(d, key) { const n = d.vpnServer.users.length; d.vpnServer.users = d.vpnServer.users.filter((u) => u.user !== key); return d.vpnServer.users.length < n ? undefined : notFound(`沒有 ${key} 這個使用者`); },
  },
  'user group': {
    only: (d) => !!d.vpnServer, fields: { member: 'q' },
    read: (d) => (d.vpnServer.users.some((u) => u.user) ? [{ key: d.vpnServer.group || 'vpn-users', f: { member: d.vpnServer.users.filter((u) => u.user).map((u) => u.user) } }] : []),
    write(d, key, f) {
      const bad = (f.member || []).find((m) => !d.vpnServer.users.some((u) => u.user === m));
      if (bad) return notFound(`沒有 ${bad} 這個使用者，先用 config user local 建立`);
      d.vpnServer.group = key;
      return undefined;
    },
    remove: () => undefined,
  },
  'vpn ipsec phase1-interface': {
    only: (d) => !!d.vpns,
    fields: { type: 'b', interface: 'q', 'ike-version': 'b', peertype: 'b', 'net-device': 'b', proposal: 'b', dhgrp: 'b', 'remote-gw': 'b', psksecret: 'b', 'psksecret-remote': 'b', comments: 'q', keylife: 'b', dpd: 'b', 'dpd-retrycount': 'b', 'dpd-retryinterval': 'b', nattraversal: 'b' },
    read: (d) => tunnels(d).map((t) => ({
      key: t.name,
      f: {
        interface: [wanOf(d, t)], ...(+t.ike === 2 ? { 'ike-version': ['2'] } : {}), peertype: ['any'], 'net-device': ['disable'],
        proposal: t.props && t.props.length ? t.props : [`${t.enc || 'aes128'}-${t.hash || 'sha1'}`],
        dhgrp: t.dhs && t.dhs.length ? t.dhs : [String(t.dh || '2')],
        ...(t.peer ? { 'remote-gw': [t.peer] } : {}), ...(t.psk ? { psksecret: [t.psk] } : {}), ...(+t.ike === 2 && t.pskRemote ? { 'psksecret-remote': [t.pskRemote] } : {}),
        // 只有改過的才會出現在設定裡：金鑰壽命預設 86400 秒，DPD 預設 on-demand、每 20 秒一次、重試 3 次
        ...(+t.life1 > 0 ? { keylife: [String(t.life1)] } : {}), ...(t.dpd ? { dpd: [t.dpd] } : {}),
        ...(+t.dpdRetry > 0 ? { 'dpd-retrycount': [String(t.dpdRetry)] } : {}), ...(+t.dpdInterval > 0 ? { 'dpd-retryinterval': [String(t.dpdInterval)] } : {}),
      },
    })),
    write(d, key, f, sub, st, isNew) {
      if ((f.type || ['static'])[0] !== 'static') return ERR('這個模擬的 IPsec 只支援站對站（type static）。使用者撥入請用 SSL-VPN：config vpn ssl settings');
      const ike = (f['ike-version'] || ['1'])[0];
      if (!['1', '2'].includes(ike)) return ERR('ike-version 可用的值：1、2');
      if (f['psksecret-remote'] && ike !== '2') return ERR('psksecret-remote 只有 IKEv2 才能用（set ike-version 2）');
      if (!f.interface || !d.ifaces.some((i) => i.id === f.interface[0])) return notFound('要指定通道從哪個介面出去：set interface "wan1"');
      const props = f.proposal ? parseProposals(f.proposal) : isNew ? P1_DEFAULT : null;
      if (!props) return ERR(`proposal 可用的值：${PROPOSALS.join(' ')}（可以列好幾組）`);
      const dhs = f.dhgrp || (isNew ? DH_DEFAULT : null);
      if (!dhs || !dhs.every((g) => DH.includes(g))) return ERR(`dhgrp 可用的值：${DH.join(' ')}（可以列好幾個）`);
      const gw = (f['remote-gw'] || [''])[0];
      if (parseIp(gw) == null) return ERR('還沒有對端的位址：set remote-gw <對端的公用 IP>');
      const num = (k, lo, hi) => { const v = (f[k] || [])[0]; return v == null ? null : /^\d+$/.test(v) && +v >= lo && +v <= hi ? +v : NaN; };
      const life = num('keylife', 120, 172800), dr = num('dpd-retrycount', 1, 10), di = num('dpd-retryinterval', 1, 3600);
      if (Number.isNaN(life)) return ERR('keylife 必須是 120 – 172800 秒（預設 86400）');
      if (Number.isNaN(dr)) return ERR('dpd-retrycount 必須是 1 – 10（預設 3）');
      if (Number.isNaN(di)) return ERR('dpd-retryinterval 必須是 1 – 3600 秒（預設 20）');
      const dpd = (f.dpd || ['on-demand'])[0];
      if (!['disable', 'on-idle', 'on-demand'].includes(dpd)) return ERR('dpd 可用的值：disable、on-idle、on-demand');
      let t = tunnels(d).find((x) => x.name === key);
      if (!t) { t = { name: key, peer: '', psk: '', local: '', remote: '', manualRoute: true, routes: [] }; d.vpns.push(t); }
      const [enc, hash] = props[0].split('-');
      Object.assign(t, { wan: f.interface[0], peer: gw, psk: (f.psksecret || []).join(' '), enc, hash, dh: dhs[0], props: props.length > 1 ? props : undefined, dhs: dhs.length > 1 ? dhs : undefined,
        ike: ike === '2' ? 2 : undefined, pskRemote: ike === '2' && f['psksecret-remote'] ? f['psksecret-remote'].join(' ') : undefined });
      Object.assign(t, {
        life1: life && life !== 86400 ? life : undefined, dpd: dpd === 'on-demand' ? undefined : dpd,
        dpdRetry: dr && dr !== 3 ? dr : undefined, dpdInterval: di && di !== 20 ? di : undefined,
      });
      return undefined;
    },
    remove(d, key) {
      if (!tunnels(d).some((t) => t.name === key)) return notFound(`沒有名為 ${key} 的通道`);
      const n = (d.policies || []).filter((p) => p.srcIf === 'vpn:' + key || p.dstIf === 'vpn:' + key).length;
      if (n) return ERR(`The entry is used by other ${n} entries\n（還有 ${n} 條政策在使用這個通道介面，先刪掉政策）`);
      d.vpns = d.vpns.filter((t) => t.name !== key);
      return undefined;
    },
  },
  'vpn ipsec phase2-interface': {
    only: (d) => !!d.vpns,
    fields: { phase1name: 'q', proposal: 'b', pfs: 'b', dhgrp: 'b', 'src-subnet': 'b', 'dst-subnet': 'b', 'auto-negotiate': 'b', keylifeseconds: 'b', comments: 'q' },
    read: (d) => tunnels(d).flatMap((t) => p2list(t).map((e) => ({
      key: e.name,
      f: {
        phase1name: [t.name],
        proposal: t.props2 && t.props2.length ? t.props2 : [`${t.enc2 || t.enc || 'aes128'}-${t.hash2 || t.hash || 'sha1'}`],
        ...(t.pfs || (t.pfsList && t.pfsList.length) ? { dhgrp: t.pfsList && t.pfsList.length ? t.pfsList : [String(t.pfs)] } : { pfs: ['disable'] }),
        ...(e.src ? { 'src-subnet': cidrTok(e.src) } : {}), ...(e.dst ? { 'dst-subnet': cidrTok(e.dst) } : {}),
        ...(+t.life2 > 0 ? { keylifeseconds: [String(t.life2)] } : {}),
      },
    }))),
    write(d, key, f, sub, st, isNew) {
      const t = tunnels(d).find((x) => x.name === (f.phase1name || [])[0]);
      if (!t) return notFound('第二階段要掛在一個第一階段底下：set phase1name "<phase1 的名稱>"');
      const props = f.proposal ? parseProposals(f.proposal) : isNew ? P1_DEFAULT : null;
      if (!props) return ERR(`proposal 可用的值：${PROPOSALS.join(' ')}（可以列好幾組）`);
      const pfsOn = (f.pfs || ['enable'])[0] !== 'disable';
      const groups = pfsOn ? f.dhgrp || DH_DEFAULT : [];
      if (!groups.every((g) => DH.includes(g))) return ERR(`dhgrp 可用的值：${DH.join(' ')}`);
      // 沒有指定網段就是 0.0.0.0/0：所有流量都符合，實際要送哪些由靜態路由決定
      const src = f['src-subnet'] ? tokCidr(f['src-subnet']) : '0.0.0.0/0', dst = f['dst-subnet'] ? tokCidr(f['dst-subnet']) : '0.0.0.0/0';
      if (!src || !dst) return ERR('用法：set src-subnet <本地網段> <遮罩>、set dst-subnet <遠端網段> <遮罩>');
      const kl = (f.keylifeseconds || [])[0];
      if (kl != null && (!/^\d+$/.test(kl) || +kl < 120 || +kl > 172800)) return ERR('keylifeseconds 必須是 120 – 172800 秒（預設 43200）');
      const [enc2, hash2] = props[0].split('-');
      Object.assign(t, { enc2, hash2, props2: props.length > 1 ? props : undefined, pfs: groups[0] || '', pfsList: groups.length > 1 ? groups : undefined, life2: kl != null && +kl !== 43200 ? +kl : undefined });
      const cur = p2list(t).filter((e) => e.src && e.dst && e.name !== key);
      setP2(t, [...cur, { name: key, src, dst }]);
      return undefined;
    },
    remove(d, key) {
      const t = tunnels(d).find((x) => p2list(x).some((e) => e.name === key && e.src));
      if (!t) return notFound(`沒有名為 ${key} 的第二階段`);
      setP2(t, p2list(t).filter((e) => e.name !== key));
      return undefined;
    },
  },
  'vpn ssl settings': {
    single: true, only: (d) => !!d.vpnServer, fields: { status: 'b', 'source-interface': 'q', port: 'b', 'tunnel-ip-pools': 'q', servercert: 'q' },
    read(d) {
      const vs = d.vpnServer;
      return [{ key: '', f: vs.on ? { status: ['enable'], 'source-interface': [vs.wan || 'wan1'], port: [String(+vs.port || 10443)], ...(vs.start && vs.end ? { 'tunnel-ip-pools': [poolName(vs)] } : {}) } : {} }];
    },
    write(d, key, f) {
      const vs = d.vpnServer;
      if (f.port && !/^\d+$/.test(f.port[0])) return ERR('port 必須是數字');
      if (f['source-interface'] && !d.ifaces.some((i) => i.id === f['source-interface'][0])) return notFound('source-interface 請填對外的介面，例如 "wan1"');
      const pool = (f['tunnel-ip-pools'] || [])[0];
      if (pool) {
        const o = (d.addrObjs || {})[pool];
        if (o && o.start) Object.assign(vs, { start: o.start, end: o.end, pool });
        else if (!(vs.start && poolName(vs) === pool)) return notFound(`找不到位址範圍物件 ${pool}：先用 config firewall address 建一個 type iprange 的物件`);
      }
      vs.on = (f.status || [])[0] === 'enable';
      if (f.port) vs.port = +f.port[0] === 10443 ? '' : f.port[0];
      if (f['source-interface']) vs.wan = f['source-interface'][0];
      return undefined;
    },
  },
  'vpn ssl web portal': {
    only: (d) => !!d.vpnServer, fields: { 'tunnel-mode': 'b', 'ip-pools': 'q', 'split-tunneling': 'b', 'split-tunneling-routing-address': 'q', 'web-mode': 'b' },
    read(d) {
      const vs = d.vpnServer, nets = list(vs.subnets).filter(normCidr);
      if (!vs.on || !nets.length) return [];
      return [{ key: vs.portal || 'full-access', f: { 'tunnel-mode': ['enable'], ...(vs.start && vs.end ? { 'ip-pools': [poolName(vs)] } : {}), 'split-tunneling': ['enable'], 'split-tunneling-routing-address': nets.map((n) => addrName(d, n)) } }];
    },
    write(d, key, f) {
      const vs = d.vpnServer;
      const nets = resolveSpec(d, f['split-tunneling-routing-address'] || []);
      if (nets == null) return notFound('split-tunneling-routing-address 裡有不存在的位址物件');
      if (!nets || nets === 'any') return ERR('請用 set split-tunneling-routing-address 指定 VPN 用戶可以存取的內部網段（位址物件）');
      Object.assign(vs, { subnets: nets, portal: key });
      return undefined;
    },
    remove(d) { d.vpnServer.subnets = ''; },
  },
  'firewall policy': {
    numeric: true, fields: { name: 'q', srcintf: 'q', dstintf: 'q', srcaddr: 'q', dstaddr: 'q', action: 'b', schedule: 'q', service: 'q', nat: 'b', status: 'b', logtraffic: 'b', comments: 'q', groups: 'q' },
    read(d) {
      ensureIds(d);
      return d.policies.map((p) => ({
        key: String(p.id),
        f: {
          ...(p.name ? { name: [p.name] } : {}),
          srcintf: [intfName(d, p.srcIf)], dstintf: [intfName(d, p.dstIf)],
          srcaddr: specNames(d, p.src, false), dstaddr: specNames(d, p.dst, true),
          action: [p.action === 'accept' ? 'accept' : 'deny'], schedule: ['always'], service: list(p.service || 'ALL'),
          ...(p.action === 'accept' && p.nat ? { nat: ['enable'] } : {}), ...(p.off ? { status: ['disable'] } : {}),
        },
      }));
    },
    write(d, key, f) {
      ensureIds(d);
      for (const k of ['srcintf', 'dstintf', 'srcaddr', 'dstaddr', 'service']) if (!f[k] || !f[k].length) return ERR(`政策還缺少必填欄位 ${k}（必填：srcintf、dstintf、srcaddr、dstaddr、service、action）`);
      const srcIf = intfId(d, f.srcintf[0]), dstIf = intfId(d, f.dstintf[0]);
      if (!srcIf || !dstIf) return notFound(`沒有 ${!srcIf ? f.srcintf[0] : f.dstintf[0]} 這個介面；可用的介面：any、${d.ifaces.map((i) => i.id).join('、')}${tunnels(d).length ? '、' + tunnels(d).map((t) => t.name).join('、') : ''}${d.vpnServer ? '、' + sslIntf : ''}`);
      const src = resolveSpec(d, f.srcaddr), dst = resolveSpec(d, f.dstaddr);
      if (src == null || dst == null) return notFound(`找不到位址物件 ${(src == null ? f.srcaddr : f.dstaddr).find((x) => !addrResolve(d, x))}：先用 config firewall address 建立，或使用 "all"`);
      const svc = f.service.map((s) => s.toUpperCase());
      const bad = svc.find((s) => !SERVICE_NAMES.includes(s));
      if (bad) return notFound(`沒有 ${bad} 這個服務；可用的服務：${SERVICE_NAMES.join('、')}`);
      const action = (f.action || ['deny'])[0].toLowerCase();
      if (!['accept', 'deny'].includes(action)) return ERR('action 必須是 accept 或 deny');
      const val = { name: (f.name || [''])[0], srcIf, dstIf, src, dst, service: svc.includes('ALL') ? 'ALL' : svc.join(', '), action, nat: action === 'accept' && (f.nat || [])[0] === 'enable', off: (f.status || [])[0] === 'disable' };
      const cur = d.policies.find((p) => String(p.id) === key);
      if (cur) Object.assign(cur, val); else d.policies.push({ id: +key, ...val });
      return undefined;
    },
    remove(d, key) { ensureIds(d); const n = d.policies.length; d.policies = d.policies.filter((p) => String(p.id) !== key); return d.policies.length < n ? undefined : notFound(`沒有編號 ${key} 的政策`); },
    move(d, a, where, b) {
      ensureIds(d);
      const x = d.policies.find((p) => String(p.id) === a);
      if (!x || !d.policies.some((p) => String(p.id) === b) || a === b) return notFound('move <政策編號> before|after <政策編號>');
      d.policies = d.policies.filter((p) => p !== x);
      d.policies.splice(d.policies.findIndex((p) => String(p.id) === b) + (where === 'after' ? 1 : 0), 0, x);
      return undefined;
    },
  },
  'router static': {
    numeric: true, fields: { dst: 'b', gateway: 'b', device: 'q', distance: 'b', comment: 'q' },
    refs(d) {
      const out = [];
      for (const i of d.ifaces) if (i.mode === 'static' && i.gateway) out.push({ t: 'gw', i, f: { gateway: [i.gateway], device: [i.id] } });
      for (const r of d.routes || []) {
        const dst = parseIp(r.dst || ''), bits = parseMask(r.mask || ''), via = parseIp(r.via || '');
        if (dst == null || bits == null || via == null) continue;
        const own = d.ifaces.find((i) => { const ip = parseIp(i.ip || ''), b = parseMask(i.mask || ''); return i.mode === 'static' && ip != null && b != null && netOf(ip, b) === netOf(via, b); });
        out.push({ t: 'route', r, f: { ...(bits === 0 ? {} : { dst: [fmtIp(netOf(dst, bits)), fmtMask(bits)] }), gateway: [r.via], ...(+r.ad > 0 && +r.ad !== 10 ? { distance: [String(+r.ad)] } : {}), ...(own ? { device: [own.id] } : {}) } });
      }
      for (const t of tunnels(d)) {
        for (const n of (t.manualRoute ? t.routes || [] : list(t.remote)).map(normCidr).filter(Boolean)) out.push({ t: 'tun', tun: t, net: n, f: { ...(n === '0.0.0.0/0' ? {} : { dst: cidrTok(n) }), device: [t.name] } });
      }
      return out;
    },
    read(d) { return this.refs(d).map((x, n) => ({ key: String(n + 1), f: x.f })); },
    write(d, key, f, sub, st, isNew) {
      const ref = isNew ? null : this.refs(d)[+key - 1];
      const dst = f.dst ? tokCidr(f.dst) : '0.0.0.0/0';
      if (!dst) return ERR('用法：set dst <目的網段> <遮罩>（不寫就是預設路由 0.0.0.0/0）');
      const devName = (f.device || [''])[0];
      const tun = tunnels(d).find((t) => t.name === devName);
      if (tun) {
        if (!tun.manualRoute) return list(tun.remote).map(normCidr).includes(dst) ? undefined : ERR(`通道 ${tun.name} 是在圖形介面建立的，通往對端的路由會跟著「遠端網段」自動建立，不用另外加`);
        if (ref && ref.t === 'tun') ref.tun.routes = (ref.tun.routes || []).filter((x) => normCidr(x) !== ref.net);
        tun.routes = uniq([...(tun.routes || []), dst]);
        return undefined;
      }
      if (devName && !d.ifaces.some((i) => i.id === devName)) return notFound(`沒有 ${devName} 這個介面或通道`);
      const gw = (f.gateway || [''])[0];
      if (parseIp(gw) == null) return ERR('還沒有下一站：set gateway <IP>（走 VPN 通道的路由則是 set device "<通道名稱>"）');
      const ad = (f.distance || [''])[0];
      if (ad && !(+ad >= 1 && +ad <= 255)) return ERR('distance 必須是 1 – 255');
      const [net, len] = dst.split('/');
      const val = { dst: net, mask: fmtMask(len == null ? 32 : +len), via: gw, ad: ad || '' };
      if (ref && ref.t === 'gw' && dst === '0.0.0.0/0') ref.i.gateway = gw;
      else if (ref && ref.t === 'route') Object.assign(ref.r, val);
      else { if (ref && ref.t === 'gw') ref.i.gateway = ''; (d.routes ||= []).push(val); }
      return undefined;
    },
    remove(d, key) {
      const ref = this.refs(d)[+key - 1];
      if (!ref) return notFound(`沒有編號 ${key} 的靜態路由`);
      if (ref.t === 'gw') ref.i.gateway = '';
      else if (ref.t === 'route') d.routes = d.routes.filter((r) => r !== ref.r);
      else if (ref.tun.manualRoute) ref.tun.routes = (ref.tun.routes || []).filter((x) => normCidr(x) !== ref.net);
      else return ERR('這筆路由是跟著圖形介面的 VPN 通道自動建立的，要移除請改通道的遠端網段');
      return undefined;
    },
  },
};
const ORDER = Object.keys(SEC);

// ───────────────────────── 輸出 ─────────────────────────

function fmtVal(kind, v) { return v.map((x) => (kind === 'q' || /[\s"]/.test(x) || x === '' ? qv(x) : x)).join(' '); }
function block(name, sec, entries, indent = '') {
  const o = [`${indent}config ${name}`], ind = indent + '    ';
  for (const e of entries) {
    const fi = sec.single ? ind : ind + '    ';
    if (!sec.single) o.push(`${ind}edit ${sec.numeric ? e.key : qv(e.key)}`);
    for (const [k, v] of Object.entries(e.f)) if (v && v.length) o.push(`${fi}set ${k} ${fmtVal(sec.fields[k], v)}`);
    for (const [sn, rows] of Object.entries(e.sub || {})) if (rows.length) o.push(...block(sn, sec.subs[sn], rows, fi));
    if (!sec.single) o.push(`${ind}next`);
  }
  o.push(`${indent}end`);
  return o;
}
const hasContent = (entries) => entries.some((e) => Object.values(e.f).some((v) => v && v.length) || Object.values(e.sub || {}).some((r) => r.length));

/** 整台設備的設定（show full-configuration） */
export function fortiConfig(state, dev) {
  const o = [];
  for (const name of ORDER) {
    const sec = SEC[name];
    if (sec.only && !sec.only(dev)) continue;
    const entries = sec.read(dev, state);
    if (hasContent(entries)) o.push(...block(name, sec, entries));
  }
  return o;
}

function getInfo(state, d, what) {
  if (what === 'system status') {
    const s = plainStamp(state, d);
    ensureFlash(d);
    const img = d.fw && IMAGES[d.fw.image];
    return [`Version: FortiGate-${d.model === 'fg100f' ? '100F' : '60F'} v${d.fw ? d.fw.ver : '7.4.7'},build${img ? d.fw.image.match(/build(\d+)/)[1] : '2731'} (GA)`, `Hostname: ${hostOf(d)}`, 'Operation Mode: NAT', 'Current virtual domain: root',
      `System time: ${s.day} ${s.mon} ${String(s.dd).padStart(2)} ${s.time} ${s.yyyy}`];
  }
  if (what === 'system info admin status') {
    const rows = vtyRows(state, d);
    return ['Index  User name        Login type  From', ...rows.map((v, n) => `${String(n).padEnd(7)}${v.user.padEnd(17)}${v.proto.padEnd(12)}${v.ip}`), `logged in users: ${rows.length}`];
  }
  if (what === 'system interface') {
    return d.ifaces.map((i) => `== [ ${i.id} ]\nname: ${i.id}   mode: ${i.mode}   ip: ${i.rt && i.rt.ip != null ? `${fmtIp(i.rt.ip)} ${fmtMask(i.rt.bits)}` : '0.0.0.0 0.0.0.0'}   status: ${i.rt && i.rt.link ? 'up' : 'down'}   allowaccess: ${accessOf(d, i).join(' ') || '(none)'}`).join('\n').split('\n');
  }
  if (what === 'router info routing-table all') {
    const rows = routeRows(d);
    if (!rows.length) return ['路由表是空的'];
    return ['Codes: C - connected, S - static, O - OSPF, * - candidate default', '', ...rows.map((r) => {
      const dst = r.dst.replace('（預設）', '');
      const code = (r.type === 'D' ? 'S' : r.type) + (dst.startsWith('0.0.0.0/0') ? '*' : ' ');
      return r.via === '直連' ? `${code}      ${dst} is directly connected, ${r.iface}` : `${code}      ${dst} [${r.ad}/${r.metric}] via ${r.via}, ${r.iface}${r.bad ? '   (inactive)' : ''}`;
    })];
  }
  if (what === 'vpn ipsec tunnel summary') {
    const ts = tunnels(d);
    return ts.length ? ts.map((t) => {
      const sa = saInfo(state, d.id, t.name);
      return `'${t.name}' ${t.peer || '0.0.0.0'}:0  selectors(total,up): ${p2list(t).length}/${t.rt && t.rt.up ? p2list(t).length : 0}  rx(pkt,err): ${sa ? sa.rx : 0}/0  tx(pkt,err): ${sa ? sa.tx : 0}/0`;
    }) : ['沒有任何 IPsec 通道'];
  }
  return null;
}
function diagnose(state, d, what, raw = what) {
  if (what === 'vpn tunnel list') {
    const ts = tunnels(d);
    if (!ts.length) return ['list all ipsec tunnel in vd 0', '沒有任何 IPsec 通道'];
    return ['list all ipsec tunnel in vd 0', ...ts.flatMap((t) => {
      const sa = saInfo(state, d.id, t.name), dpd = t.dpd || 'on-demand';
      return ['------------------------------------------------------',
        `name=${t.name} ver=${+t.ike === 2 ? 2 : 1} ${wanOf(d, t)} -> ${t.peer || '0.0.0.0'}`,
        `status=${t.rt && t.rt.up ? 'up' : 'down'}${t.rt && !t.rt.up && t.rt.why ? `  (${t.rt.why})` : ''}${t.rt && t.rt.stale ? `  (對端已經沒有回應，DPD 探測中，再 ${Math.ceil(t.rt.stale - state.clock)} 秒判定失聯)` : ''}`,
        `stat: rxp=${sa ? sa.rx : 0} txp=${sa ? sa.tx : 0}`,
        `dpd: mode=${dpd} on=${dpd === 'disable' ? 0 : 1} idle=${(+t.dpdInterval || 20) * 1000}ms retry=${+t.dpdRetry || 3}`,
        ...p2list(t).filter((e) => e.src).flatMap((e) => [`proxyid=${e.name} src=${e.src} dst=${e.dst}`,
          ...(sa ? [`  SA:  expire=${sa.left2}  life: timeout=${sa.left2}/${sa.life2}  rekey=${sa.rekey2}`] : [])])];
    })];
  }
  if (what === 'vpn ike gateway list') {
    const ts = tunnels(d);
    if (!ts.length) return ['沒有任何 IPsec 通道'];
    return ts.flatMap((t) => {
      const sa = saInfo(state, d.id, t.name);
      return ['', 'vd: root/0', `name: ${t.name}`, `version: ${+t.ike === 2 ? 2 : 1}`, `interface: ${wanOf(d, t)}`, `addr: ${wanOf(d, t)}:500 -> ${t.peer || '0.0.0.0'}:500`,
        ...(sa ? [`created: ${sa.age}s ago`, 'IKE SA: created 1/1  established 1/1', 'IPsec SA: created 1/1  established 1/1', '  status: established',
          `  proposal: ${t.enc || 'aes128'}-${t.hash || 'sha1'}`, `  lifetime/rekey: ${sa.life1}/${sa.left1}`,
          ...(t.rt && t.rt.pfsBad ? [`  （注意：${t.rt.pfsBad}。IKEv2 的第一個 CHILD_SA 不做 PFS，現在通，${Math.max(0, Math.ceil(t.rt.rekeyFail - state.clock))} 秒後第一次重新協商時會失敗）`] : [])]
          : [`  status: ${t.rt && t.rt.nego ? 'connecting' : 'not established'}${t.rt && t.rt.why ? `（${t.rt.why}）` : ''}`])];
    });
  }
  if (what === 'sys session list') {
    // 目前還留在表裡的連線。expire 是還能閒置幾秒，時間到就會被移除
    const rows = sessionRows(state, d);
    if (!rows.length) return ['total session 0', '（連線表是空的：先讓流量經過這台設備。閒置太久的連線會自動移除）'];
    const o = [];
    for (const e of rows) {
      const pn = { icmp: 1, tcp: 6, udp: 17 }[e.proto] || 0;
      const ps = e.proto === 'tcp' ? (e.st === 'est' ? '01' : e.st === 'fin' ? '05' : '02') : '00';
      const snat = e.nSrc !== e.src, dnat = e.nDst !== e.dst;
      o.push(`session info: proto=${pn} proto_state=${ps} duration=${e.age} expire=${e.left} timeout=${e.ttl}`,
        `orgin->sink: org pre->post, reply pre->post dev=${e.inIf}->${e.outIf}/${e.outIf}->${e.inIf}`,
        `hook=${snat ? 'post' : 'pre'} dir=org act=${snat ? 'snat' : dnat ? 'dnat' : 'noop'} ${fmtIp(e.src)}:${e.sport}->${fmtIp(e.dst)}:${e.dport}(${snat ? `${fmtIp(e.nSrc)}:${e.nSport}` : dnat ? `${fmtIp(e.nDst)}:${e.nDport}` : '0.0.0.0:0'})`,
        `hook=${snat ? 'pre' : 'post'} dir=reply act=${snat ? 'dnat' : dnat ? 'snat' : 'noop'} ${fmtIp(e.nDst)}:${e.nDport}->${fmtIp(e.nSrc)}:${e.nSport}(${snat || dnat ? `${fmtIp(snat ? e.src : e.dst)}:${snat ? e.sport : e.dport}` : '0.0.0.0:0'})`,
        `policy_id=${e.rule || 0}`, '');
    }
    o.push(`total session ${rows.length}`);
    return o;
  }
  if (what === 'sys session clear') { clearSessions(state, d); return ['（連線表已清空）']; }
  // diagnose sniffer packet <介面> '<篩選條件>' [詳細程度] [數量]
  const sn = raw.match(/^sniffer\s+packet\s+(\S+)(?:\s+(?:'([^']*)'|"([^"]*)"|(none)))?(?:\s+(\d))?(?:\s+(\d+))?(?:\s+\S+)?\s*$/i);
  if (/^sniffer/.test(what)) {
    if (!sn) return ["用法：diagnose sniffer packet <介面|any> '<篩選條件>' [詳細程度 1-6] [數量]", "例如：diagnose sniffer packet any 'host 10.1.0.50 and icmp' 4 10"];
    const intf = sn[1].toLowerCase(), filter = (sn[2] ?? sn[3] ?? '').trim(), level = +(sn[5] || 1), count = +(sn[6] || 0);
    if (intf !== 'any' && !d.ifaces.some((i) => i.id === intf)) return [`interface ${intf} is not found`];
    const f = bpf(filter);
    if (f.error) return [f.error];
    startSniff(state, d.id, intf, filter, level, count);
    return [`interfaces=[${intf}]`, `filters=[${filter || 'none'}]`, `（開始擷取${count ? `，抓到 ${count} 個封包就停止` : '；輸入任何指令就會停止，相當於 Ctrl-C'}。符合條件的封包會即時出現在這裡）`];
  }
  // diagnose debug flow …：追蹤封包在防火牆裡的每一步（政策、路由、NAT）
  if (/^debug/.test(what)) {
    const x = dflowOf(state, d.id);
    let m;
    if (what === 'debug enable') { x.on = true; return x.left > 0 ? [] : ['（debug 已開啟。還要用 diagnose debug flow trace start <數量> 指定要追蹤幾個封包）']; }
    if (what === 'debug disable') { x.on = false; return []; }
    if (what === 'debug reset') { Object.assign(x, { on: false, left: 0, filter: {} }); return []; }
    if (/^debug flow show (function-name|iprope)/.test(what)) { x.fn = !/disable$/.test(what); return [`show ${what.split(' ')[3]} ${x.fn ? 'enabled' : 'disabled'}`]; }
    if (what === 'debug flow filter clear') { x.filter = {}; return []; }
    if ((m = what.match(/^debug flow filter addr (\S+)$/))) { if (parseIp(m[1]) == null) return ['用法：diagnose debug flow filter addr <IP>']; x.filter.addr = parseIp(m[1]); return []; }
    if ((m = what.match(/^debug flow filter proto (\d+)$/))) { x.filter.proto = +m[1]; return []; }
    if ((m = what.match(/^debug flow filter port (\d+)$/))) { x.filter.port = +m[1]; return []; }
    if ((m = what.match(/^debug flow trace start (\d+)$/))) { x.left = +m[1]; return x.on ? [] : ['（還要 diagnose debug enable，輸出才會出現在畫面上）']; }
    if (what === 'debug flow trace stop') { x.left = 0; return []; }
    if (what === 'debug info') {
      const f = x.filter;
      return [`debug output:           ${x.on ? 'enable' : 'disable'}`, `flow trace left:        ${x.left}`,
        `filter: addr=${f.addr != null ? fmtIp(f.addr) : 'any'} proto=${f.proto ?? 'any'} port=${f.port ?? 'any'}`];
    }
    return ['用法：diagnose debug flow filter addr <IP> / proto <編號> / port <埠> / clear', '      diagnose debug flow trace start <數量>', '      diagnose debug enable / disable / reset / info'];
  }
  // diagnose hardware deviceinfo nic <埠>：網路卡的計數器
  const nic = what.match(/^hardware deviceinfo nic(?:\s+(\S+))?$/);
  if (nic) {
    const names = d.ports.map((p) => (d.ifaces.some((i) => i.bind.t === 'port' && i.bind.port === p.id) ? fgIfName(d, p.id) : 'internal' + p.id));
    if (!nic[1]) return ['用法：diagnose hardware deviceinfo nic <埠>', '可以看的埠：' + names.join(' ')];
    const k = names.indexOf(nic[1]);
    const p = k >= 0 ? d.ports[k] : d.ports.find((x) => x.id === nic[1]);
    if (!p) return [`Network interface ${nic[1]} is not found`, '可以看的埠：' + names.join(' ')];
    const c = counters(state, d.id, p.id), up = !!state.rt.links[d.id + ':' + p.id], li = up && linkInfo(state, d.id, p.id);
    return [`Name:            ${names[d.ports.indexOf(p)]}`, `Link:            ${up ? 'up' : 'down'}`, `Speed:           ${li ? li.speed + 'Mbps' : '0'}`, `Duplex:          ${li ? (li.duplex === 'half' ? 'Half' : 'Full') : 'Half'}`,
      `Rx_Packets:      ${c.ip}`, `Tx_Packets:      ${c.op}`, `Rx_Bytes:        ${c.ib}`, `Tx_Bytes:        ${c.ob}`,
      `Rx_CRC_Errors:   ${c.crc}`, `Rx_Errors:       ${c.crc + c.runts}`, `Tx_Errors:       ${c.late}`, `Collisions:      ${c.coll}`, `Rx_Multicast:    ${c.imc}`];
  }
  if (what === 'sys ntp status') {
    const n = ntpInfo(state, d);
    if (n.server == null) return ['synchronized: no, ntpsync: disabled, server-mode: disabled', '（還沒有設定 NTP 伺服器：config system ntp）'];
    return [`synchronized: ${n.synced ? 'yes' : 'no'}, ntpsync: enabled, server-mode: disabled`, '',
      `ipv4 server(${fmtIp(n.server)}) ${fmtIp(n.server)} -- ${n.reachable ? 'reachable' : 'unreachable'}(0x${n.reach.toString(16)}) S:${n.reachable ? n.serverStratum : 16} T:${n.when}${n.synced ? ' selected' : ''}`,
      ...(n.reachable ? [`\tserver-version=4, stratum=${n.serverStratum}`] : [`\t（${n.why || '還沒有收到回應'}）`])];
  }
  if (what === 'log history' || what === 'log display') {
    const rows = logRows(state, d), st = syslogStats(state, d);
    return [`${rows.length} logs found.`, ...rows.map((r, k) => `${k + 1}: ${r.line}`),
      ...(d.mgmt && d.mgmt.syslog ? [`（已送到 Syslog 伺服器 ${d.mgmt.syslog}：${st.sent} 筆${st.lost ? `，${st.lost} 筆沒有送達：${st.why}` : ''}）`] : [])];
  }
  return null;
}
void sessionLog;

// ───────────────────────── 工作階段 ─────────────────────────

/** exec(line) → { out: [文字], changed, ping: 要 ping 的位址（交給顯示層播放） } */
export function fortiSession(getDev, getState) {
  const stack = [];
  const dev = () => getDev(), st = () => getState();
  const top = () => stack[stack.length - 1];
  const spec = (t) => (t.nested ? t.spec : t.sec);
  const parseErr = (w) => [`command parse error before '${w}'`, 'Command fail. Return code -61'];
  const label = (name) => name.split(' ').pop();

  function commit(t) {
    if (t.nested) {
      const n = t.list.findIndex((e) => e.key === t.key);
      if (n >= 0) t.list[n] = { key: t.key, f: t.f }; else t.list.push({ key: t.key, f: t.f });
      return null;
    }
    const r = t.sec.write(dev(), t.key, t.f, t.sub || {}, st(), !!t.isNew);
    return r && r.err ? r.err : null;
  }
  let pend = null; // 等使用者回答 (y/n)

  function exec(line) {
    const out = [];
    let changed = false;
    const res = (extra) => ({ out, changed, ...extra });
    if (pend) { const p = pend; pend = null; return p(line.trim(), out); }
    const tok = tokenize(line.trim());
    if (!tok.length || tok[0].startsWith('#')) return res();
    const cmd = tok[0].toLowerCase(), t = top(), d = dev();
    const fail = (msg) => { out.push(...[].concat(msg).join('\n').split('\n')); return res(); };

    if (cmd === 'config') {
      const name = tok.slice(1).join(' ').toLowerCase();
      if (!t) {
        const sec = SEC[name];
        if (!sec || (sec.only && !sec.only(d))) return fail([...parseErr(tok[1] || ''), '（輸入 ? 可以看到有哪些設定區段）']);
        if (sec.single) stack.push({ t: 'edit', single: true, sec, label: label(name), name, key: '', ...clone({ f: {}, sub: {}, ...sec.read(d, st())[0] }) });
        else stack.push({ t: 'cfg', sec, label: label(name), name });
        return res();
      }
      if (t.t === 'edit' && !t.nested && t.sec.subs && t.sec.subs[name]) {
        stack.push({ t: 'cfg', nested: true, spec: t.sec.subs[name], label: name, name, list: ((t.sub ||= {})[name] ||= []) });
        return res();
      }
      return fail(parseErr(tok[1] || ''));
    }
    if (cmd === 'edit') {
      if (!t || t.t !== 'cfg') return fail(parseErr('edit'));
      let key = tok[1];
      if (key == null) return fail(['incomplete command', 'Command fail. Return code -160']);
      const sp = spec(t);
      if (sp.numeric && !/^\d+$/.test(key)) return fail(['value parse error before \'' + key + '\'', '（這個表的項目用數字編號，例如 edit 1；edit 0 會自動用下一個可用的編號）']);
      const entries = t.nested ? t.list : t.sec.read(d, st());
      if (sp.numeric && key === '0') key = String(entries.reduce((m, e) => Math.max(m, +e.key), 0) + 1);
      const cur = entries.find((e) => String(e.key) === key);
      if (!cur && sp.noCreate) return fail(notFound(`沒有 ${key}；可用的項目：${entries.map((e) => e.key).join('、')}`).err);
      if (!cur) out.push(`new entry '${key}' added`);
      stack.push({ t: 'edit', nested: !!t.nested, sec: t.sec, spec: t.spec, list: t.list, key, isNew: !cur, ...clone({ f: {}, sub: {}, ...(cur || {}) }), key2: key });
      return res();
    }
    if (cmd === 'set' || cmd === 'unset' || cmd === 'append' || cmd === 'unselect') {
      if (!t || t.t !== 'edit') return fail(parseErr(cmd));
      const field = (tok[1] || '').toLowerCase();
      if (!(field in spec(t).fields)) return fail([...parseErr(tok[1] || ''), `（這裡可以設定的欄位：${Object.keys(spec(t).fields).join('、')}）`]);
      if (cmd === 'unset') { delete t.f[field]; return res(); }
      if (tok.length < 3) return fail(['incomplete command', 'Command fail. Return code -160']);
      if (cmd === 'set') { t.f[field] = tok.slice(2); return res(); }
      // append / unselect 只能用在可以放好幾個值的欄位（allowaccess、member、srcaddr…）
      if (!MULTI.has(field)) return fail([`command parse error before '${tok[1]}'`, `（${cmd} 只能用在可以放好幾個值的欄位，例如 allowaccess、member、srcaddr）`, 'Command fail. Return code -61']);
      const cur = t.f[field] || [], low = (x) => x.toLowerCase();
      t.f[field] = cmd === 'append' ? [...cur, ...tok.slice(2).filter((x) => !cur.some((y) => low(y) === low(x)))] : cur.filter((y) => !tok.slice(2).some((x) => low(x) === low(y)));
      if (!t.f[field].length) delete t.f[field];
      return res();
    }
    if (cmd === 'next' || cmd === 'end') {
      if (!t) return res();
      if (t.t === 'edit') {
        if (cmd === 'next' && t.single) return fail(parseErr('next'));
        const e = commit(t);
        if (e) return fail([e, 'object check operator error, -651, discard the setting', 'Command fail. Return code -651']);
        changed = !t.nested;
        stack.pop();
        if (cmd === 'end' && !t.single) stack.pop();
        return res();
      }
      if (cmd === 'next') return fail(parseErr('next'));
      stack.pop();
      return res();
    }
    if (cmd === 'abort') {
      if (!t) return res();
      stack.pop();
      if (t.t === 'edit' && !t.single) stack.pop();
      return res();
    }
    if (cmd === 'delete') {
      if (!t || t.t !== 'cfg') return fail(parseErr('delete'));
      const key = tok[1];
      if (key == null) return fail(['incomplete command', 'Command fail. Return code -160']);
      if (t.nested) { const n = t.list.findIndex((e) => e.key === key); if (n < 0) return fail(notFound(`沒有 ${key}`).err); t.list.splice(n, 1); return res(); }
      if (!t.sec.remove) return fail('這個區段的項目不能刪除');
      const r = t.sec.remove(d, key, st());
      if (r && r.err) return fail([r.err, 'Command fail. Return code -23']);
      changed = true;
      return res();
    }
    if (cmd === 'move') {
      if (!t || t.t !== 'cfg' || !t.sec.move) return fail(parseErr('move'));
      const where = (tok[2] || '').toLowerCase();
      if (!['before', 'after'].includes(where)) return fail('用法：move <政策編號> before|after <政策編號>');
      const r = t.sec.move(d, tok[1], where, tok[3]);
      if (r && r.err) return fail(r.err);
      changed = true;
      return res();
    }
    if (cmd === 'show') {
      if (t && t.t === 'edit') {
        const sp = spec(t);
        out.push(...block(t.name || t.label || '', { ...sp, single: !!t.single }, [{ key: t.key, f: t.f, sub: t.sub }]));
        if (!t.single) { out[0] = `config ${stack[stack.length - 2].name}`; }
        return res();
      }
      if (t) { out.push(...block(t.name, spec(t), t.nested ? t.list : t.sec.read(d, st()))); return res(); }
      const name = tok.slice(1).join(' ').toLowerCase();
      if (!name || name === 'full-configuration') { out.push(...fortiConfig(st(), d)); return res(); }
      const sec = SEC[name];
      if (!sec || (sec.only && !sec.only(d))) return fail(parseErr(tok[1]));
      out.push(...block(name, sec, sec.read(d, st())));
      return res();
    }
    if (cmd === 'get') {
      if (t && t.t === 'edit') { for (const [k, v] of Object.entries(t.f)) out.push(`${k.padEnd(20)}: ${v.join(' ')}`); return res(); }
      const r = getInfo(st(), d, tok.slice(1).join(' ').toLowerCase());
      if (!r) return fail([...parseErr(tok[1] || ''), '（可用：get system status、get system interface、get system info admin status、get router info routing-table all、get vpn ipsec tunnel summary）']);
      out.push(...r);
      return res();
    }
    if (cmd === 'diagnose' || cmd === 'diag') {
      const r = diagnose(st(), d, tok.slice(1).join(' ').toLowerCase(), line.trim().replace(/^diag(nose)?\s+/i, ''));
      if (!r) return fail([...parseErr(tok[1] || ''), '（可用：diagnose vpn tunnel list、diagnose vpn ike gateway list、diagnose sys session list、diagnose sys session clear、diagnose sys ntp status）']);
      out.push(...r);
      return res();
    }
    if (cmd === 'execute' || cmd === 'exec') {
      if ((tok[1] || '').toLowerCase() === 'ping' && parseIp(tok[2] || '') != null) return res({ ping: tok[2] });
      if ((tok[1] || '').toLowerCase() === 'traceroute' && parseIp(tok[2] || '') != null) return res({ trace: tok[2] });
      const sub = tok.slice(1).join(' ').toLowerCase();
      // ── 備份與還原：execute backup config tftp <檔名> <伺服器>、execute restore config / image tftp <檔名> <伺服器> ──
      const bk = tok.slice(1).map((x) => x.toLowerCase());
      if (bk[0] === 'backup' || bk[0] === 'restore') {
        const what = bk[1], proto = bk[2], file = tok[4], ip = parseIp(tok[5] || ''), user = tok[6], pass = tok[7];
        const usage = '用法：execute backup config tftp <檔名> <伺服器 IP>、execute backup config ftp <檔名> <伺服器 IP> <帳號> <密碼>、execute restore config tftp …、execute restore image tftp <檔名> <伺服器 IP>';
        if (!['config', 'image'].includes(what) || !['tftp', 'ftp'].includes(proto) || !file || ip == null || (bk[0] === 'backup' && what !== 'config')) return fail(usage);
        const creds = proto === 'ftp' ? { user: user || '', pass: pass || '' } : {};
        const srvName = `${proto} server ${tok[5]}`;
        if (bk[0] === 'backup') {
          const put = configFile(fortiConfig(st(), d), st().clock);
          const r = transfer(st(), d.id, { proto, server: ip, file, dir: 'put', bytes: put.size, put, ...creds });
          out.push('Please wait...', '', `Connect to ${srvName} ...`, '#');
          if (!r.ok) return fail([`Send config file to ${proto} server via vdom root failed.`, `Command fail. Return code -${proto === 'tftp' ? 1 : 3}`, `（${r.reason}）`]);
          out.push(`Send config file to ${proto} server OK.`);
          changed = true;
          return res({ wait: r.secs, xfer: r.res });
        }
        out.push(what === 'config' ? 'This operation will overwrite the current setting and could possibly reboot the system!' : 'This operation will replace the current firmware version!', 'Do you want to continue? (y/n)');
        pend = (ans, o) => {
          const R = (extra) => ({ out: o, changed: false, ...extra });
          if (!/^y/i.test(ans)) { o.push('（已取消）'); return R(); }
          const r = transfer(st(), d.id, { proto, server: ip, file, dir: 'get', ...creds });
          o.push('Please wait...', '', `Connect to ${srvName} ...`);
          if (!r.ok) { o.push(`Get ${what === 'config' ? 'config file' : 'image'} from ${proto} server failed.`, 'Command fail. Return code -1', `（${r.reason}）`); return R({ wait: r.secs, xfer: r.res }); }
          if (what === 'config') {
            if (r.file.kind !== 'config') { o.push('File check failed.', `（${file} 不是設定檔）`); return R({ wait: r.secs, xfer: r.res }); }
            const bad = fortiFromText(st(), d, r.file.lines);
            markReboot(st(), d.id);
            o.push(`Get config file from ${proto} server OK.`, 'File check OK.', `（設定已經整份換掉${bad ? `，有 ${bad} 行沒有辦法套用` : ''}。設備重新開機中，大約 ${bootTime(d)} 秒）`);
            return { out: o, changed: true, reloaded: true, wait: r.secs, xfer: r.res };
          }
          // 韌體：檢查型號、檔案完整、升級路徑，通過之後重新開機換成新版本
          const img = r.file.img && IMAGES[r.file.img];
          o.push(`Get image from ${proto} server OK.`, 'Verifying the integrity of the firmware image.');
          if (!img || r.file.kind !== 'image') { o.push('Image validation failed: invalid image', `（${file} 不是 FortiGate 的韌體）`); return R({ wait: r.secs, xfer: r.res }); }
          if (img.platform !== PLATFORM[d.model]) { o.push(`Image validation failed: The image is for ${PLATFORM_NAME[img.platform]}`, `（這台是 ${PLATFORM_NAME[PLATFORM[d.model]]}，要用給它的韌體）`); return R({ wait: r.secs, xfer: r.res }); }
          if (r.file.md5 !== img.md5 || r.file.size !== img.size) { o.push('Image validation failed: the image is corrupted', '（檔案大小或 MD5 和原廠公布的不一樣：下載不完整或被竄改過）'); return R({ wait: r.secs, xfer: r.res }); }
          ensureFlash(d);
          const [a, b] = verOf(d.fw.ver), [x, y] = verOf(img.ver);
          if (a === x && y - b > 2) {
            o.push(`Upgrade path check failed: ${d.fw.ver} → ${img.ver}`, `（FortiOS 每次只能往上升一個主要版本：${d.fw.ver} 要先升到 ${a}.${b + 2}.x，再升到 ${img.ver}。跳著升，設定檔的轉換會出問題）`);
            return R({ wait: r.secs, xfer: r.res });
          }
          d.fwNext = { image: r.file.img, ver: img.ver };
          markReboot(st(), d.id);
          o.push('Please wait for system to restart.', '', `（新的韌體 ${img.ver} 會在重新開機之後生效，大約 ${bootTime(d)} 秒）`);
          return { out: o, changed: true, reloaded: true, wait: r.secs, xfer: r.res };
        };
        return res();
      }
      if (sub === 'reboot') {
        // FortiGate 的設定是即時存檔的，重開機不會遺失設定；但記憶體裡的連線、紀錄都會消失
        markReboot(st(), d.id);
        out.push('This operation will reboot the system !', `System is rebooting...（大約 ${bootTime(d)} 秒後恢復）`);
        return res({ changed: true, reloaded: true });
      }
      if (sub === 'log display') { out.push(...diagnose(st(), d, 'log display')); return res(); }
      if (sub === 'log delete-all') { clearLog(st(), d); out.push('（紀錄已清除）'); return res(); }
      if (sub === 'date' || sub === 'time') {
        const s = plainStamp(st(), d), n = ntpInfo(st(), d);
        out.push(sub === 'date' ? `current date is: ${s.date}` : `current time is: ${s.time}`,
          ...(sub === 'time' ? [n.synced ? `last ntp sync: 已和 ${fmtIp(n.server)} 同步` : 'last ntp sync: 尚未同步（時間來自設備自己的硬體時鐘，可能有偏差）'] : []));
        return res();
      }
      return fail('用法：execute ping <IP>、execute traceroute <IP>、execute log display、execute date、execute time、execute reboot');
    }
    if (cmd === 'exit' || cmd === 'quit') return res();
    return fail([`Unknown action 0`, ...parseErr(tok[0])]);
  }

  /** 目前可以輸入的指令（給「?」與 Tab 補齊用） */
  function words(line) {
    const tok = tokenize(line), partial = /\s$/.test(line) || !tok.length ? '' : tok.pop().toLowerCase();
    const t = top(), d = dev();
    let cand;
    const first = (tok[0] || '').toLowerCase();
    if (!tok.length) cand = !t ? ['config', 'show', 'get', 'diagnose', 'execute'] : t.t === 'cfg' ? ['edit', 'delete', 'show', 'end', ...(t.sec && t.sec.move ? ['move'] : [])] : ['set', 'unset', 'append', 'unselect', 'show', 'get', 'end', 'abort', ...(t.single ? [] : ['next']), ...(!t.nested && t.sec.subs ? ['config'] : [])];
    else if (first === 'config' || (first === 'show' && !t)) {
      const names = t ? Object.keys((t.sec && t.sec.subs) || {}) : ORDER.filter((n) => !SEC[n].only || SEC[n].only(d));
      const pre = tok.slice(1).join(' ').toLowerCase();
      cand = uniq(names.filter((n) => n.startsWith(pre ? pre + ' ' : '')).map((n) => n.slice(pre ? pre.length + 1 : 0).split(' ')[0]).filter(Boolean));
    } else if ((first === 'set' || first === 'unset') && t && t.t === 'edit' && tok.length === 1) cand = Object.keys(spec(t).fields);
    else if ((first === 'append' || first === 'unselect') && t && t.t === 'edit' && tok.length === 1) cand = Object.keys(spec(t).fields).filter((f) => MULTI.has(f));
    else if ((first === 'edit' || first === 'delete') && t && t.t === 'cfg' && tok.length === 1) cand = (t.nested ? t.list : t.sec.read(d, st())).map((e) => String(e.key));
    else cand = [];
    const options = cand.filter((w) => w.toLowerCase().startsWith(partial)).sort();
    if (!options.length) return { line: null, options };
    let common = options[0];
    for (const w of options) while (!w.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
    const done = options.length === 1;
    const word = /\s/.test(common) ? qv(common) : common;
    return { line: common.length > partial.length || done ? [...tok.map((x) => (/\s/.test(x) ? qv(x) : x)), word].join(' ') + (done ? ' ' : '') : null, options };
  }

  return {
    exec,
    complete: words,
    prompt: () => { if (pend) return ''; const t = top(); return `${hostOf(dev())}${!t ? '' : ` (${t.t === 'edit' && !t.single ? t.key : t.label})`} # `; },
    get depth() { return stack.length; },
  };
}
