// IOS XE 的 Embedded Packet Capture（monitor capture）：在路由器、交換器的介面上直接擷取封包，
// 看 buffer、匯出成 .pcap 存到 flash（再用 copy 傳到 TFTP 伺服器，用 Wireshark 打開）
//
// state.dyn.epc[設備][名稱] = { port, label, dir: 'both' | 'in' | 'out', match, on, frames: [], t0, start, stopAt, got }
import { fmtIp, parseIp, netOf } from './ip.js';
import { protoName, frameLen } from './wire.js';
import { pcapBytes } from './pcap.js';

const MAX = 1000;
// match 的條件編好的函式（不放進 state：存檔與複製狀態時不能有函式）。改了 match 會換成新的物件，所以用物件當鍵就好
const FN = new WeakMap();
const fnOf = (c) => { if (!FN.has(c)) FN.set(c, (parseMatch(String(c.match || '').split(/\s+/)) || { fn: () => true }).fn); return FN.get(c); };
const longIf = (l) => String(l).replace(/^Gi(?=\d)/, 'GigabitEthernet').replace(/^Te(?=\d)/, 'TenGigabitEthernet').replace(/^Fa(?=\d)/, 'FastEthernet').replace(/^Eth(?=\d)/, 'Ethernet');
export const epcOf = (state, devId) => (((state.dyn.epc ||= {})[devId]) ||= {});

/** 介面名稱（縮寫或全名）→ 連接埠 */
function portByName(d, t) {
  const m = String(t || '').match(/^([a-z-]+)\s*([\d/.]+)$/i);
  if (!m) return null;
  const want = m[1].toLowerCase(), num = m[2];
  return d.ports.find((p) => { const x = String(p.label).match(/^([a-z-]+)([\d/.]+)$/i); if (!x || x[2] !== num) return false; const lab = x[1].toLowerCase(), full = longIf(p.label).replace(/[\d/.]+$/, '').toLowerCase(); return full.startsWith(want) || lab.startsWith(want) || want.startsWith(lab); }) || null;
}
/** match 的條件 → 函式 */
function parseMatch(words) {
  const w = words.map((x) => x.toLowerCase());
  if (w[0] === 'any') return { text: 'any', fn: () => true };
  if (w[0] !== 'ipv4') return null;
  let k = 1, proto = null;
  if (w[k] === 'protocol') { proto = w[k + 1]; k += 2; if (!['tcp', 'udp', 'icmp'].includes(proto)) return null; }
  const addr = () => {
    if (w[k] === 'any') { k++; return { t: 'any', fn: () => true }; }
    if (w[k] === 'host') { const ip = parseIp(w[k + 1] || ''); k += 2; return ip == null ? null : { t: `host ${fmtIp(ip)}`, fn: (x) => x === ip }; }
    const c = String(w[k] || '').match(/^([\d.]+)\/(\d+)$/); k++;
    if (!c || parseIp(c[1]) == null) return null;
    const bits = +c[2], net = netOf(parseIp(c[1]), bits);
    return { t: `${fmtIp(net)}/${bits}`, fn: (x) => x != null && netOf(x, bits) === net };
  };
  const s = addr(), d = s && addr();
  if (!s || !d) return null;
  const pr = (f) => !proto || f.proto === proto || (proto === 'udp' && f.proto === 'dhcp');
  return { text: `ipv4${proto ? ' protocol ' + proto : ''} ${s.t} ${d.t}`, src: s.t, dst: d.t, proto: proto || 'any', fn: (f) => f.proto !== 'arp' && f.proto !== 'stp' && f.proto !== 'cdp' && f.proto !== 'lldp' && f.proto !== 'dtp' && pr(f) && s.fn(f.src) && d.fn(f.dst) };
}

/** onHop 時呼叫：這個埠上有在擷取的 capture point 就記下來 */
export function epcRecord(state, devId, pid, dir, f) {
  const all = (state.dyn.epc || {})[devId];
  if (!all || pid == null) return;
  for (const c of Object.values(all)) {
    if (!c.on || c.port !== pid || (c.dir !== 'both' && c.dir !== dir)) continue;
    if (c.match && !fnOf(c)(f)) continue;
    c.got++;
    c.frames.push({ ...f, no: c.got, t: state.clock - c.start + ((c.got % 4000) * 0.000173) % 0.9, len: frameLen(f) });
    if (c.frames.length > MAX) c.frames.shift();
  }
}

/** 特權模式的 monitor capture 指令。回傳要印的行（錯誤以 % 開頭） */
export function epcCmd(state, d, words) {
  const [name, verb, ...rest] = words;
  if (!name) return ['% 用法：monitor capture <名稱> interface <介面> both | in | out、match any、start、stop、export flash:<檔名>.pcap'];
  const all = epcOf(state, d.id), c = all[name];
  const v = String(verb || '').toLowerCase();
  if (v === 'interface' || v === 'int') {
    const p = portByName(d, rest[0]);
    if (!p) return [`% Invalid interface ${rest[0] || ''}`];
    const dir = String(rest[1] || 'both').toLowerCase();
    if (!['both', 'in', 'out'].includes(dir)) return ['% 方向是 both、in 或 out'];
    all[name] = { ...(c || { frames: [], got: 0, on: false }), port: p.id, label: p.label, dir };
    return [];
  }
  if (v === 'match') {
    const m = parseMatch(rest);
    if (!m) return ['% 用法：monitor capture <名稱> match any | ipv4 any any | ipv4 [protocol tcp|udp|icmp] <來源> <目的>（any、host <IP>、<網段>/<長度>）'];
    all[name] = { ...(c || { frames: [], got: 0, on: false }), match: m.text };
    return [];
  }
  if (!c) return [`% Capture point ${name} does not exist`];
  if (v === 'start') {
    if (!c.port) return [`% Capture point ${name}：還沒有指定介面（monitor capture ${name} interface <介面> both）`];
    if (!c.match) return [`% Capture point ${name}：還沒有指定擷取的條件（monitor capture ${name} match any 或 match ipv4 …）`];
    if (c.on) return [`% Capture point ${name} is already active`];
    Object.assign(c, { on: true, start: state.clock, got: 0, frames: [] });
    return [`Started capture point : ${name}`];
  }
  if (v === 'stop') {
    if (!c.on) return [`% Capture point ${name} is not active`];
    c.on = false; c.stopAt = state.clock;
    return ['Capture statistics collected at software:', `        Capture duration - ${Math.round(state.clock - c.start)} seconds`, `        Packets received - ${c.got}`, '        Packets dropped - 0', '        Packets oversized - 0', '', 'Bytes dropped in asic - 0', '', `Stopped capture point : ${name}`];
  }
  if (v === 'clear') { c.frames = []; c.got = 0; return []; }
  if (v === 'export') {
    const dst = String(rest[0] || '');
    const m = dst.match(/^(?:bootflash|flash):\/?([\w.-]+\.pcap)$/i);
    if (!m) return ['% 用法：monitor capture <名稱> export flash:<檔名>.pcap（再用 copy flash:<檔名>.pcap tftp://<伺服器>/<檔名> 傳出去）'];
    if (!c.frames.length) return ['% 緩衝區裡沒有封包'];
    const bytes = pcapBytes(c.frames, 1767574800 + c.start);
    ((d.flash ||= { size: 0, files: {} }).files ||= {})[m[1]] = { size: bytes.length, md5: '', kind: 'pcap', frames: c.frames.map((f) => ({ ...f })), t0: c.start, t: state.clock };
    return [`Exported Successfully`];
  }
  return ['% 用法：monitor capture <名稱> interface | match | start | stop | clear | export'];
}

/** no monitor capture <名稱> */
export function epcDelete(state, d, name) {
  const all = epcOf(state, d.id);
  if (!all[name]) return [`% Capture point ${name} does not exist`];
  delete all[name];
  return [];
}

/** show monitor capture [<名稱>] [buffer brief | buffer detailed] */
export function epcShow(state, d, name, buffer) {
  const all = epcOf(state, d.id);
  const list = name ? (all[name] ? [[name, all[name]]] : []) : Object.entries(all);
  if (!list.length) return name ? [`% Capture point ${name} does not exist`] : ['（沒有任何 capture point：monitor capture <名稱> interface <介面> both）'];
  if (buffer) {
    const [, c] = list[0];
    const o = [' ----------------------------------------------------------------------------', ' #   size   timestamp     source             destination      dscp    protocol', ' ----------------------------------------------------------------------------'];
    c.frames.forEach((f, k) => {
      const ip = f.proto !== 'arp' && f.src != null;
      o.push(`${String(k).padStart(4)}  ${String(f.len).padStart(4)}  ${f.t.toFixed(6).padStart(10)}   ${ip ? fmtIp(f.src).padEnd(16) : (f.smac || '').padEnd(16)} ->  ${ip ? fmtIp(f.dst).padEnd(16) : (f.dmac || '').padEnd(16)} ${String(f.dscp || 0).padStart(2)}  ${f.dscp === 46 ? 'EF' : 'BE'}   ${protoName(f)}`);
      if (buffer === 'detailed') o.push(`      ${f.proto === 'icmp' ? `ICMP ${f.reply ? 'echo reply' : 'echo request'}` : f.proto === 'tcp' || f.proto === 'udp' ? `${f.proto.toUpperCase()} ${f.sport} > ${f.dport}` : f.proto.toUpperCase()}  TTL ${f.ttl ?? 64}`);
    });
    if (!c.frames.length) o.push('（緩衝區是空的：start 之後讓流量經過這個介面）');
    return o;
  }
  const o = [];
  for (const [n, c] of list) {
    const m = c.match ? parseMatch(String(c.match).split(/\s+/)) : null;
    o.push(`Status Information for Capture ${n}`, '  Target Type: ', ` Interface: ${c.label ? longIf(c.label) : '（還沒有指定）'}, Direction: ${String(c.dir || 'both').toUpperCase()}`, `   Status : ${c.on ? 'Active' : 'Inactive'}`, '  Filter Details: ',
      ...(!c.match ? ['   （還沒有指定：match any 或 match ipv4 …）'] : c.match === 'any' ? ['   Capture all packets'] : ['   IPv4 ', `    Source IP:  ${m ? m.src : 'any'}`, `    Destination IP:  ${m ? m.dst : 'any'}`, `   Protocol: ${m ? m.proto : 'any'}`]),
      '  Buffer Details: ', '   Buffer Type: LINEAR (default)', '   Buffer Size (in MB): 10', '  Limit Details: ', '   Number of Packets to capture: 0 (no limit)', `   Packets captured: ${c.got || 0}`, '');
  }
  return o;
}
