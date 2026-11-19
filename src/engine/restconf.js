// RESTCONF（RFC 8040）：用 HTTPS 對 IOS XE 設備讀寫設定，資料格式是 YANG 模型的 JSON。
// 請求真的走一趟網路（TCP 443：路上的 ACL、防火牆都會檢查），到了設備再看：有沒有 restconf、帳號密碼、
// Content-Type、路徑與內容。改設定和用 CLI 改的是同一份設定，IOS XE 會記一筆 %DMI-5-CONFIG_I。
//
// 支援的路徑（data 底下）：
//   ietf-interfaces:interfaces                        GET、POST（建立 Loopback）
//   ietf-interfaces:interfaces/interface=<名稱>        GET、PATCH、PUT、DELETE（名稱裡的 / 要寫成 %2F）
//   ietf-interfaces:interfaces-state                  GET（運作狀態）
//   Cisco-IOS-XE-native:native/hostname               GET、PATCH、PUT
//   Cisco-IOS-XE-native:native/vlan                   GET、PATCH、POST（交換器）
//   Cisco-IOS-XE-native:native/ip/route               GET（靜態路由）
import { parseIp, fmtIp, fmtMask, parseMask } from './ip.js';
import { transact } from './sim.js';
import { IOS_XE } from './ios.js';
import { logEvent } from './ops.js';
import { CATALOG, newIface } from './model.js';
import { longIf } from './ops.js';
import { dnacApi } from './dnac.js';

const YANG = 'application/yang-data+json';
const STATUS = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type' };
/** RESTCONF 的錯誤格式（RFC 8040 7.1） */
const errBody = (tag, msg, type = 'application') => ({ 'ietf-restconf:errors': { error: [{ 'error-type': type, 'error-tag': tag, 'error-message': msg }] } });
const reply = (status, body, note) => ({ status, statusText: STATUS[status] || '', body: body ?? null, note: note || '' });

/** 設備上看得到的介面（YANG 的 name 用完整名稱） */
function ifaceList(d) {
  const out = [];
  for (const p of d.ports) {
    const pc = d.sw && d.sw.ports[p.id];
    const i = d.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
    if (pc && pc.mode !== 'routed') out.push({ name: longIf(p.label), kind: 'l2', pc, port: p });
    else if (i) out.push({ name: longIf(p.label), kind: 'l3', i, pc, port: p });
    for (const s of d.ifaces.filter((x) => x.bind.t === 'sub' && x.bind.port === p.id)) out.push({ name: longIf(s.label), kind: 'sub', i: s });
  }
  for (const i of d.ifaces) {
    if (i.bind.t === 'loop') out.push({ name: `Loopback${i.bind.n}`, kind: 'loop', i });
    else if (i.bind.t === 'svi') out.push({ name: `Vlan${i.bind.vlan}`, kind: 'svi', i });
  }
  return out;
}
const TYPE = { l2: 'iana-if-type:ethernetCsmacd', l3: 'iana-if-type:ethernetCsmacd', sub: 'iana-if-type:ethernetCsmacd', loop: 'iana-if-type:softwareLoopback', svi: 'iana-if-type:propVirtual' };
function ifaceJson(x) {
  const o = { name: x.name };
  const desc = x.pc && x.kind === 'l2' ? x.pc.desc : x.i && x.i.desc;
  if (desc) o.description = desc;
  o.type = TYPE[x.kind];
  o.enabled = !(x.kind === 'l2' ? x.pc.shut : x.i.shut || (x.pc && x.pc.shut));
  if (x.i && x.i.mode === 'static' && parseIp(x.i.ip || '') != null && parseMask(x.i.mask || '') != null) o['ietf-ip:ipv4'] = { address: [{ ip: x.i.ip, netmask: fmtMask(parseMask(x.i.mask)) }] };
  else o['ietf-ip:ipv4'] = {};
  o['ietf-ip:ipv6'] = {};
  return o;
}
/** 介面的內容（PATCH 合併、PUT 取代） */
function applyIface(x, body, replace) {
  const enabled = body.enabled ?? (replace ? true : null);
  const desc = 'description' in body ? String(body.description) : replace ? null : undefined;
  const v4 = body['ietf-ip:ipv4'];
  if (v4 && x.kind === 'l2') return '這是第二層的 switchport，不能設定 IP（要先改成 routed port）';
  const addr = v4 && Array.isArray(v4.address) ? v4.address[0] : null;
  if (addr && (parseIp(addr.ip || '') == null || parseMask(addr.netmask || '') == null)) return 'ietf-ip:ipv4 的 address 要有 ip 與 netmask，例如 {"ip": "10.0.0.1", "netmask": "255.255.255.0"}';
  const t = x.kind === 'l2' ? x.pc : x.i;
  if (desc === null) delete t.desc; else if (desc !== undefined) t.desc = desc;
  if (enabled != null) { if (x.kind === 'l3' && x.pc) x.pc.shut = !enabled; t.shut = !enabled; }
  if (addr) Object.assign(x.i, { mode: 'static', ip: addr.ip, mask: addr.netmask });
  else if (replace && x.i) Object.assign(x.i, { ip: '', mask: '' });
  return '';
}
/** URL 裡的介面名稱：GigabitEthernet0%2F0%2F1 → GigabitEthernet0/0/1 */
const keyOf = (s) => decodeURIComponent(s || '');

/** 送出一個 RESTCONF 請求。req = { method, url, user, pass, contentType, body（字串） } */
export function restconf(state, fromId, req) {
  const method = String(req.method || 'GET').toUpperCase();
  const m = String(req.url || '').trim().match(/^https:\/\/([\d.]+)(?::(\d+))?(\/[^\s?#]*)?(?:\?([^\s#]*))?$/i);
  if (!m) return { ...reply(0, null), error: 'URL 的格式：https://<設備 IP>/restconf/data/<YANG 路徑>（RESTCONF 一定走 HTTPS）', res: null };
  const ip = parseIp(m[1]), port = +(m[2] || 443), path = m[3] || '/';
  const query = Object.fromEntries(String(m[4] || '').split('&').filter(Boolean).map((kv) => { const [k, v = ''] = kv.split('='); return [decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, ' '))]; }));
  const res = transact(state, fromId, { proto: 'tcp', dst: ip, dport: port, quiet: !!req.quiet });
  if (!res.ok) return { ...reply(0, null), error: `連不上 ${m[1]}:${port}：${res.reason}`, res };
  const d = state.devices[res.responder];
  // 設備的 HTTPS 用的是自己簽的憑證 (self-signed)：用戶端預設會拒絕，要明確選擇不驗證（curl -k）或先匯入設備的憑證
  if (req.verify) return { ...reply(0, null), error: 'SSL certificate problem: self-signed certificate', certErr: true, res, dev: d.id };
  const out = (r, forceJson) => {
    const json = forceJson || /json/i.test(req.accept || '');
    const text = r.body == null ? '' : json ? JSON.stringify(r.body, null, 2) : toXml(r.body);
    if (!req.quiet) {
      const log = ((state.dyn ||= {}).api ||= []);
      log.push({ t: state.clock, from: fromId, dev: d.id, method, path, status: r.status });
      if (log.length > 40) log.splice(0, log.length - 40);
    }
    return { ...r, statusText: r.statusText || STATUS[r.status] || '', res, dev: d.id, text, ctype: r.body == null ? '' : forceJson ? 'application/json' : json ? 'application/yang-data+json' : 'application/yang-data+xml' };
  };
  // Catalyst Center：北向的 REST API（JSON、Token 驗證）
  if (d.dnac) return out(dnacApi(state, d, req, method, path, query), true);
  if (!d.mgmt || !IOS_XE.has(d.model)) return out(reply(404, null, `${d.name}（${CATALOG[d.model].title}）沒有 RESTCONF：${d.model === 'c2960' || d.model === 'c2960p' ? 'Catalyst 2960 跑的是 IOS 15，不是 IOS XE' : /^n9/.test(d.model) ? 'Nexus 用的是 NX-API' : '它不是 IOS XE 設備'}`));
  if (!/^\/restconf(\/|$)/.test(path)) return out(reply(404, null, 'RESTCONF 的路徑都在 /restconf/ 底下（資料在 /restconf/data/）'));
  if (!d.mgmt.restconf) return out(reply(404, null, `${d.name} 沒有啟用 RESTCONF（設定模式下輸入 restconf）`));
  // HTTP Basic 驗證：ip http authentication local → 用 username 建立的帳號
  if ((req.user || '') !== (d.mgmt.user ?? 'admin') || (req.pass || '') !== (d.mgmt.pass ?? 'admin')) return out(reply(401, errBody('access-denied', 'access-denied', 'protocol'), '帳號或密碼錯誤（RESTCONF 用 HTTP Basic 驗證，帳號是 username … privilege 15 建立的那一個）'));
  if (path === '/restconf' || path === '/restconf/') return out(reply(200, { 'ietf-restconf:restconf': { data: {}, operations: {}, 'yang-library-version': '2016-06-21' } }));
  const mm = path.match(/^\/restconf\/data\/?(.*)$/);
  if (!mm) return out(reply(404, errBody('invalid-value', 'uri keypath not found')));
  const rest = mm[1].replace(/\/+$/, '');
  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (!/^application\/yang-data\+json/i.test(req.contentType || '')) return out(reply(415, errBody('invalid-value', `unsupported media type: ${req.contentType || '(none)'}`), `寫入的請求要加 Content-Type: ${YANG}（不是 application/json）${/x-www-form-urlencoded/i.test(req.contentType || '') ? '。curl 用 -d 送資料卻沒有加 -H \'Content-Type: …\' 的話，預設是 application/x-www-form-urlencoded（網頁表單的格式）' : ''}`));
    try { body = JSON.parse(req.body || ''); } catch (e) { return out(reply(400, errBody('malformed-message', 'JSON parse error: ' + e.message), 'JSON 的格式不對：' + e.message)); }
    if (!body || typeof body !== 'object') return out(reply(400, errBody('malformed-message', 'body must be a JSON object')));
  }
  const r = route(state, d, method, rest, body, req.user || 'admin');
  return out(r);
}

/** 沒有指定 Accept: application/yang-data+json 的話，IOS XE 回的是 XML */
const NS = (mod) => (mod.startsWith('ietf-') ? `urn:ietf:params:xml:ns:yang:${mod}` : mod.startsWith('Cisco-IOS-XE-') ? `http://cisco.com/ns/yang/${mod}` : mod === 'iana-if-type' ? 'urn:ietf:params:xml:ns:yang:iana-if-type' : mod);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function toXml(o, ind = '') {
  const out = [];
  for (const [k0, v] of Object.entries(o)) {
    const [mod, name] = k0.includes(':') ? k0.split(':') : [null, k0];
    const attr = mod ? ` xmlns="${NS(mod)}"` : '';
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x && typeof x === 'object') {
        const inner = toXml(x, ind + '  ');
        out.push(inner ? `${ind}<${name}${attr}>\n${inner}\n${ind}</${name}>` : `${ind}<${name}${attr}/>`);
      } else {
        const t = String(x);
        const m = typeof x === 'string' && t.match(/^([\w-]+):([\w-]+)$/);
        out.push(m && m[1] === 'iana-if-type' ? `${ind}<${name}${attr} xmlns:ianaift="${NS(m[1])}">ianaift:${m[2]}</${name}>` : `${ind}<${name}${attr}>${esc(t)}</${name}>`);
      }
    }
  }
  return out.join('\n');
}

let txn = 0;
const changed = (state, d, user) => logEvent(state, d, 5, 'DMI-5-CONFIG_I', `${d.name} nesd: Configured from NETCONF/RESTCONF by ${user}, transaction-id ${++txn + 100}`);

function route(state, d, method, rest, body, user) {
  const not = () => reply(405, errBody('operation-not-supported', `method ${method} not supported on this resource`, 'protocol'));
  // ── 介面 ──
  if (rest === 'ietf-interfaces:interfaces') {
    if (method === 'GET') return reply(200, { 'ietf-interfaces:interfaces': { interface: ifaceList(d).map(ifaceJson) } });
    if (method === 'POST') {
      const x = body['ietf-interfaces:interface'];
      const o = Array.isArray(x) ? x[0] : x;
      if (!o || !o.name) return reply(400, errBody('missing-element', 'ietf-interfaces:interface with name required'), '內容要是 {"ietf-interfaces:interface": {"name": "Loopback100", "type": "iana-if-type:softwareLoopback", …}}');
      const lm = String(o.name).match(/^Loopback(\d+)$/i);
      if (!lm) return reply(400, errBody('invalid-value', `cannot create interface ${o.name}`), '用 POST 只能建立邏輯介面（Loopback）；實體介面本來就存在，要用 PATCH 修改');
      if (!d.routing) return reply(400, errBody('invalid-value', `cannot create interface ${o.name}`), `${d.name} 是第二層交換器，沒有 Loopback 介面`);
      if (ifaceList(d).some((y) => y.name === `Loopback${+lm[1]}`)) return reply(409, errBody('data-exists', 'object already exists: /ietf-interfaces:interfaces/interface=' + o.name), '已經有這個介面了：要修改請用 PATCH 或 PUT');
      const i = newIface('Lo' + +lm[1], `Loopback${+lm[1]}`, { t: 'loop', n: +lm[1] });
      d.ifaces.push(i);
      const e = applyIface({ name: o.name, kind: 'loop', i }, o, false);
      if (e) { d.ifaces.pop(); return reply(400, errBody('invalid-value', e), e); }
      changed(state, d, user);
      return reply(201, null);
    }
    return not();
  }
  const im = rest.match(/^ietf-interfaces:interfaces\/interface=([^/]+)$/);
  if (im) {
    const name = keyOf(im[1]);
    const x = ifaceList(d).find((y) => y.name.toLowerCase() === name.toLowerCase());
    if (!x) return reply(404, errBody('invalid-value', 'uri keypath not found'), `${d.name} 沒有 ${name}${/\//.test(im[1]) ? '：名稱裡的「/」在網址裡要寫成 %2F，例如 GigabitEthernet0%2F0%2F1' : ''}`);
    if (method === 'GET') return reply(200, { 'ietf-interfaces:interface': ifaceJson(x) });
    if (method === 'PATCH' || method === 'PUT') {
      const v = body['ietf-interfaces:interface'];
      const o = Array.isArray(v) ? v[0] : v;
      if (!o) return reply(400, errBody('missing-element', 'ietf-interfaces:interface required'), '內容要是 {"ietf-interfaces:interface": {…}}');
      if (o.name && o.name.toLowerCase() !== x.name.toLowerCase()) return reply(400, errBody('invalid-value', 'key leaf in body does not match uri'), '內容裡的 name 和網址上的介面不一樣');
      const e = applyIface(x, o, method === 'PUT');
      if (e) return reply(400, errBody('invalid-value', e), e);
      changed(state, d, user);
      return reply(204, null);
    }
    if (method === 'DELETE') {
      if (x.kind === 'loop' || x.kind === 'sub') { d.ifaces = d.ifaces.filter((y) => y !== x.i); changed(state, d, user); return reply(204, null); }
      return reply(400, errBody('invalid-value', 'cannot delete a physical interface'), '實體介面不能刪除（要關掉請 PATCH {"enabled": false}）');
    }
    return not();
  }
  if (rest === 'ietf-interfaces:interfaces-state') {
    if (method !== 'GET') return not();
    return reply(200, { 'ietf-interfaces:interfaces-state': { interface: ifaceList(d).map((x) => {
      const up = x.kind === 'l2' ? !!state.rt.links[d.id + ':' + x.port.id] && !x.pc.shut : !!(x.i.rt && x.i.rt.link && !x.i.shut);
      return { name: x.name, type: TYPE[x.kind], 'admin-status': ifaceJson(x).enabled ? 'up' : 'down', 'oper-status': up ? 'up' : 'down', 'phys-address': (x.i && x.i.rt && x.i.rt.mac) || '00:00:00:00:00:00' };
    }) } });
  }
  // ── hostname ──
  if (rest === 'Cisco-IOS-XE-native:native/hostname') {
    if (method === 'GET') return reply(200, { 'Cisco-IOS-XE-native:hostname': d.name });
    if (method === 'PATCH' || method === 'PUT') {
      const v = body['Cisco-IOS-XE-native:hostname'];
      if (typeof v !== 'string' || !/^[A-Za-z][\w-]{0,62}$/.test(v)) return reply(400, errBody('invalid-value', 'invalid hostname'), '內容要是 {"Cisco-IOS-XE-native:hostname": "新名稱"}（英文字母開頭，只能有英數字、- 與 _）');
      d.name = v;
      changed(state, d, user);
      return reply(204, null);
    }
    return not();
  }
  // ── VLAN（交換器）──
  if (rest === 'Cisco-IOS-XE-native:native/vlan') {
    if (!d.sw || d.sw.mode !== 'vlan') return reply(404, errBody('invalid-value', 'uri keypath not found'), `${d.name} 是路由器，沒有 VLAN 資料庫`);
    if (method === 'GET') return reply(200, { 'Cisco-IOS-XE-native:vlan': { 'Cisco-IOS-XE-vlan:vlan-list': d.sw.vlans.slice().sort((a, b) => a.id - b.id).map((v) => ({ id: v.id, name: v.name })) } });
    if (method === 'PATCH' || method === 'POST' || method === 'PUT') {
      const v = body['Cisco-IOS-XE-native:vlan'];
      const list = v && v['Cisco-IOS-XE-vlan:vlan-list'];
      if (!Array.isArray(list) || list.some((x) => !(+x.id >= 1 && +x.id <= 4094))) return reply(400, errBody('invalid-value', 'invalid vlan-list'), '內容要是 {"Cisco-IOS-XE-native:vlan": {"Cisco-IOS-XE-vlan:vlan-list": [{"id": 50, "name": "IOT"}]}}');
      if (method === 'POST' && list.some((x) => d.sw.vlans.some((y) => y.id === +x.id))) return reply(409, errBody('data-exists', 'object already exists'), 'POST 是「建立」：已經存在的 VLAN 要用 PATCH');
      if (method === 'PUT') d.sw.vlans = d.sw.vlans.filter((y) => y.id === 1 || list.some((x) => +x.id === y.id));
      for (const x of list) {
        const cur = d.sw.vlans.find((y) => y.id === +x.id);
        if (cur) { if (x.name) cur.name = String(x.name); } else d.sw.vlans.push({ id: +x.id, name: String(x.name || 'VLAN' + String(x.id).padStart(4, '0')) });
      }
      changed(state, d, user);
      return reply(method === 'POST' ? 201 : 204, null);
    }
    return not();
  }
  // ── 靜態路由 ──
  if (rest === 'Cisco-IOS-XE-native:native/ip/route') {
    if (method !== 'GET') return not();
    const routes = (d.routes || []).filter((r) => r.dst && r.via);
    return reply(200, { 'Cisco-IOS-XE-native:route': { 'ip-route-interface-forwarding-list': routes.map((r) => ({ prefix: r.dst, mask: r.mask, 'fwd-list': [{ fwd: r.via, ...(+r.ad > 1 ? { metric: +r.ad } : {}) }] })) } });
  }
  return reply(404, errBody('invalid-value', 'uri keypath not found'), '這個模擬支援的路徑：ietf-interfaces:interfaces[/interface=<名稱>]、ietf-interfaces:interfaces-state、Cisco-IOS-XE-native:native/hostname、Cisco-IOS-XE-native:native/vlan、Cisco-IOS-XE-native:native/ip/route');
}

void fmtIp;
