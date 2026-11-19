// 線路上真正跑過的訊框：介面計數器、封包擷取 (Wireshark)、連接埠鏡像 (SPAN)、
// FortiGate 的 sniffer 與 debug flow、IOS 的 debug ip packet / debug ip icmp。
//
// state.dyn.ifc[設備][埠]   介面計數器
// state.dyn.cap[設備]       主機上的封包擷取（Wireshark）
// state.dyn.con[設備]       只會出現在命令列畫面上的輸出（FortiGate 的 sniffer、debug flow）
// state.dyn.dbg[設備]       IOS 開了哪些 debug
// state.dyn.sniff / dflow   FortiGate 的 sniffer 與 debug flow 設定
import { linkInfo } from './model.js';
import { fmtIp, parseIp, parseCidr, netOf } from './ip.js';
import { isIos } from './ios.js';

export const BCAST = 'ff:ff:ff:ff:ff:ff';
const STP_MAC = '01:80:c2:00:00:00', CDP_MAC = '01:00:0c:cc:cc:cc';
const PROTO_NO = { icmp: 1, tcp: 6, udp: 17, esp: 50 };

// ───────────────────────── 訊框 ─────────────────────────

/** 訊框的長度（位元組，不含前導碼與 FCS），給計數器與擷取畫面用 */
export function frameLen(f) {
  const tag = f.tag != null ? 4 : 0;
  if (f.proto === 'arp') return 42 + tag;
  if (f.proto === 'stp') return 60 + tag;
  if (f.proto === 'cdp') return 371;
  if (f.proto === 'dhcp') return 342 + tag;
  if (f.proto === 'icmp') return (f.big ? 114 : 74) + tag;
  if (f.proto === 'udp') return (f.dport === 53 || f.sport === 53 ? 82 : f.dport === 514 ? 150 : 90) + tag;
  if (f.proto === 'esp') return (f.ssl ? 140 : 134) + tag;
  if (f.proto === 'tcp') return (f.data ? (f.data.kind === 'out' ? 590 : 110) : 66) + tag;
  return 64 + tag;
}
const isMulti = (mac) => mac === BCAST || /^01:/.test(mac || '');

/** Wireshark 的 Protocol 欄位 */
export function protoName(f) {
  const p = (n) => f.sport === n || f.dport === n;
  if (f.proto === 'arp') return 'ARP';
  if (f.proto === 'stp') return 'STP';
  if (f.proto === 'cdp') return 'CDP';
  if (f.proto === 'dhcp') return 'DHCP';
  if (f.proto === 'icmp') return 'ICMP';
  if (f.proto === 'esp') return f.ssl ? 'TLSv1.3' : 'ESP';
  if (f.proto === 'udp') return p(53) ? 'DNS' : p(123) ? 'NTP' : p(514) ? 'Syslog' : p(500) || p(4500) ? 'ISAKMP' : p(1812) ? 'RADIUS' : p(69) || (f.data && f.data.kind === 'tftp') ? 'TFTP' : p(161) || p(162) ? 'SNMP' : 'UDP';
  if (f.proto === 'tcp' && f.data) return p(23) ? 'TELNET' : p(22) ? 'SSHv2' : p(21) ? 'FTP' : p(443) || p(10443) ? 'TLSv1.3' : p(80) ? 'HTTP' : 'TCP';
  return f.proto.toUpperCase();
}
const flags = (f) => (f.proto !== 'tcp' ? '' : f.data ? '[PSH, ACK]' : f.ack ? '[ACK]' : f.reply ? '[SYN, ACK]' : '[SYN]');
const DHCP_TYPE = { discover: 'Discover', offer: 'Offer', request: 'Request', ack: 'ACK' };

/** Wireshark 的 Info 欄位 */
export function infoOf(f) {
  if (f.proto === 'arp') return f.arp.op === 1 ? `Who has ${fmtIp(f.arp.tip)}? Tell ${fmtIp(f.arp.sip)}` : `${fmtIp(f.arp.sip)} is at ${f.arp.sha}`;
  if (f.proto === 'stp') return `Conf. Root = ${f.stp.prio}/${f.stp.vlan}/${f.stp.root}  Cost = ${f.stp.cost}  Port = 0x80${String(f.stp.port).padStart(2, '0')}`;
  if (f.proto === 'cdp') return `Device ID: ${f.cdp.id}  Port ID: ${f.cdp.port}`;
  if (f.proto === 'dhcp') return `DHCP ${DHCP_TYPE[f.dhcp.type]}  - Transaction ID 0x${f.dhcp.xid}`;
  if (f.proto === 'icmp') return `Echo (ping) ${f.reply ? 'reply  ' : 'request'}  id=0x${(f.reply ? f.dport : f.sport).toString(16).padStart(4, '0')}, seq=1/256, ttl=${f.ttl}`;
  if (f.proto === 'esp') return f.ssl ? 'Application Data（SSL-VPN 的加密內容）' : `ESP (SPI=0x${(f.spi || 0).toString(16).padStart(8, '0')})`;
  const name = protoName(f);
  if (f.proto === 'tcp' && f.data) {
    if (name === 'TELNET') {
      const d = f.data;
      return d.kind === 'login' ? `Telnet Data …  使用者名稱：${d.user}　密碼：${d.pass}` : d.kind === 'cmd' ? `Telnet Data …  ${d.text}` : 'Telnet Data …（設備回傳的畫面）';
    }
    if (name === 'SSHv2') return `${f.reply ? 'Server' : 'Client'}: Encrypted packet (len=${f.data.kind === 'out' ? 524 : 52})`;
    if (name === 'FTP') return f.data.kind === 'ftp' ? `Request: USER ${f.data.user}　Request: PASS ${f.data.pass}　Request: ${f.data.cmd}` : 'Response: 226 Transfer complete';
    return `${f.sport} → ${f.dport} [PSH, ACK] Len=${frameLen(f) - 66}`;
  }
  if (f.proto === 'tcp') return `${f.sport} → ${f.dport} ${flags(f)} Seq=${f.ack ? 1 : 0}${f.ack || f.reply ? ' Ack=1' : ''} Win=64240 Len=0`;
  if (name === 'DNS') return f.reply ? 'Standard query response A' : 'Standard query A';
  if (name === 'TFTP') return f.data && f.data.kind === 'tftp' ? `${f.data.op === 'RRQ' ? 'Read' : 'Write'} Request, File: ${f.data.file}, Transfer type: octet` : 'Acknowledgement, Block: 1';
  if (name === 'SNMP') return snmpInfo(f);
  return `${f.sport} → ${f.dport} Len=${frameLen(f) - 42}`;
}

/** SNMP：v1 / v2c 的 community 是明文；v3 加密之後只看得到使用者名稱 */
function snmpInfo(f) {
  const s = f.data && f.data.snmp;
  if (!s) return f.dport === 162 ? 'snmpV2-trap' : 'get-response';
  if (s.trap) return `${s.ver === 'v3' ? 'encryptedPDU: privKey Unknown' : `snmpV2-trap  community=${s.community}`}  ${s.trap}`;
  if (s.ver === 'v3') return `msgUserName=${s.user}  encryptedPDU: privKey Unknown`;
  return `${f.reply ? 'get-response' : 'get-bulk-request'}  community=${s.community}  1.3.6.1.2.1.31.1.1.1.6 (ifHCInOctets)`;
}

// ───────────────────────── 介面計數器 ─────────────────────────

const blank = (now) => ({ ip: 0, op: 0, ib: 0, ob: 0, ibc: 0, obc: 0, imc: 0, omc: 0, crc: 0, runts: 0, coll: 0, late: 0, lastIn: null, lastOut: null, cleared: null, w: { t: now, ib: 0, ob: 0, ip: 0, op: 0 }, pw: null });
function ctr(state, devId, pid) {
  const all = ((state.dyn.ifc ||= {})[devId] ||= {});
  const c = (all[pid] ||= blank(state.clock));
  // 五分鐘的平均速率：每五分鐘換一次取樣的起點
  if (state.clock - c.w.t >= 300) { c.pw = c.w; c.w = { t: state.clock, ib: c.ib, ob: c.ob, ip: c.ip, op: c.op }; }
  return c;
}
/** 這個埠的計數器（沒有就是全部 0） */
export function counters(state, devId, pid) {
  const c = ((state.dyn.ifc || {})[devId] || {})[pid];
  if (!c) return { ...blank(state.clock), inRate: 0, outRate: 0, inPps: 0, outPps: 0 };
  const ref = c.pw || c.w, dt = Math.max(1, state.clock - ref.t);
  return { ...c, inRate: Math.round(((c.ib - ref.ib) * 8) / dt), outRate: Math.round(((c.ob - ref.ob) * 8) / dt), inPps: Math.round((c.ip - ref.ip) / dt), outPps: Math.round((c.op - ref.op) / dt) };
}
/** clear counters：全部歸零（不會影響連線） */
export function clearCounters(state, devId, pid) {
  const all = (state.dyn.ifc || {})[devId];
  if (!all) return;
  for (const k of pid ? [pid] : Object.keys(all)) { all[k] = blank(state.clock); all[k].cleared = state.clock; }
  if (pid == null) ((state.dyn.ifcClr ||= {})[devId] = state.clock);
}
export const clearedAt = (state, devId, pid) => { const c = ((state.dyn.ifc || {})[devId] || {})[pid]; return (c && c.cleared) ?? (state.dyn.ifcClr || {})[devId] ?? null; };

function linkErrors(state, from, fromPort, to, toPort, frames) {
  const li = linkInfo(state, from, fromPort);
  if (!li || li.down || !(li.half || li.mismatch)) return;
  const acc = (state.dyn.ifcAcc ||= {}), key = [from + ':' + fromPort, to + ':' + toPort].sort().join('|');
  const before = acc[key] || 0;
  acc[key] = before + frames;
  const hits = (every) => Math.floor(acc[key] / every) - Math.floor(before / every);
  if (li.mismatch) {
    // 雙工不一致：半雙工的那一端以為發生碰撞（而且是在訊框送到一半之後，所以是 late collision）；
    // 全雙工的那一端收到被打斷的訊框，就是 CRC 錯誤與過短的訊框 (runt)
    const [half, full] = li.duplex === 'half' ? [[from, fromPort], [to, toPort]] : [[to, toPort], [from, fromPort]];
    const n = hits(3);
    if (n > 0) {
      const h = ctr(state, half[0], half[1]), f = ctr(state, full[0], full[1]);
      h.late += n; h.coll += n; f.crc += n; f.runts += Math.ceil(n * 0.6);
    }
  } else {
    const n = hits(25); // 半雙工 (Hub)：偶爾兩端同時送，正常的碰撞
    if (n > 0) ctr(state, from, fromPort).coll += n;
  }
}

/** 一個訊框從 from 的 fromPort 送出、從 to 的 toPort 收進來 */
function countFrame(state, from, fromPort, to, toPort, f, n = 1, bytes = null, noErr = false) {
  const len = bytes ?? frameLen(f) * n, multi = isMulti(f.dmac), now = state.clock;
  if (fromPort != null) {
    const a = ctr(state, from, fromPort);
    a.op += n; a.ob += len; a.lastOut = now;
    if (f.dmac === BCAST) a.obc += n; else if (multi) a.omc += n;
  }
  if (toPort != null) {
    const b = ctr(state, to, toPort);
    b.ip += n; b.ib += len; b.lastIn = now;
    if (f.dmac === BCAST) b.ibc += n; else if (multi) b.imc += n;
  }
  if (fromPort != null && toPort != null && !noErr) linkErrors(state, from, fromPort, to, toPort, n);
}

const portAt = (state, cableId, devId) => {
  const c = state.cables.find((x) => x.id === cableId);
  return !c ? null : c.a.dev === devId ? c.a.port : c.b.dev === devId ? c.b.port : null;
};

// ───────────────────────── 封包擷取 ─────────────────────────

/** 開始 / 停止擷取。開始時清掉上一次的結果 */
export function setCapture(state, devId, on) {
  const cap = (state.dyn.cap ||= {});
  if (on) cap[devId] = { on: true, t0: state.clock, seq: 0, frames: [] };
  else if (cap[devId]) cap[devId].on = false;
}
export const captureOf = (state, devId) => ((state.dyn.cap || {})[devId]) || null;
const MAX_FRAMES = 500;

function record(state, devId, f, how) {
  const c = (state.dyn.cap || {})[devId];
  if (!c || !c.on) return;
  const d = state.devices[devId], own = d && d.ifaces.some((i) => i.rt && i.rt.mac === f.dmac || i.rt && i.rt.mac === f.smac);
  c.seq++;
  // 同一秒之內的訊框，時間往後錯開一點點，才排得出先後
  const t = state.clock - c.t0 + ((c.seq % 5000) * 0.000213) % 0.95;
  c.frames.push({ ...f, no: c.seq, t, how: how || (own || isMulti(f.dmac) ? '' : 'promisc'), len: frameLen(f) });
  if (c.frames.length > MAX_FRAMES) c.frames.shift();
}

// ───────────────────────── SPAN ─────────────────────────

/** 這台交換器有哪些埠是 SPAN 的目的埠（這些埠只送出鏡像的訊框，不轉送一般流量） */
export function spanDest(d, pid) {
  const s = d.sw && d.sw.span;
  return !!s && Object.values(s).some((x) => x.dst === pid);
}
/** 訊框從 pid 進來 (rx) 或送出 (tx) 時，要不要複製一份到某個 SPAN 目的埠。回傳目的埠的清單 */
function spanCopies(d, pid, dir) {
  const s = d.sw && d.sw.span;
  if (!s) return [];
  const out = [];
  for (const x of Object.values(s)) {
    const m = x.src && x.src[pid];
    if (x.dst && m && (m === 'both' || m === dir) && x.dst !== pid) out.push(x.dst);
  }
  return out;
}

// ───────────────────────── 每一段線路 ─────────────────────────

/**
 * 訊框走過一段線路（引擎的每一個 hop 都會呼叫）：計數、擷取、鏡像、FortiGate 的 sniffer。
 * h: { cable, wifi, from, fromPort, to, toPort, tag }；leak: Hub 或泛洪時多送出去的副本
 */
export function onHop(state, h, frame, leak) {
  const f = { ...frame, tag: h.tag ?? null };
  if (!h.wifi) countFrame(state, h.from, h.fromPort, h.to, h.toPort, f);
  record(state, h.from, f, 'out');
  record(state, h.to, f);
  sniff(state, h.from, h.fromPort, 'out', f);
  sniff(state, h.to, h.toPort, 'in', f);
  for (const x of leak || []) {
    const fp = portAt(state, x.cable, x.from), tp = portAt(state, x.cable, x.to);
    countFrame(state, x.from, fp, x.to, tp, f);
    record(state, x.to, f);
  }
  // 連接埠鏡像：同一個訊框在同一個目的埠只複製一次
  const done = new Set();
  const mirror = (sw, pid, dir) => {
    const d = state.devices[sw];
    if (!d || !d.sw || pid == null) return;
    for (const dst of spanCopies(d, pid, dir)) {
      if (done.has(sw + ':' + dst)) continue;
      done.add(sw + ':' + dst);
      const l = state.rt.links[sw + ':' + dst];
      if (!l) continue;
      countFrame(state, sw, dst, l.dev, l.port, f);
      record(state, l.dev, f, 'span');
    }
  };
  if (!h.wifi) { mirror(h.to, h.toPort, 'rx'); mirror(h.from, h.fromPort, 'tx'); }
}

/** 持續的背景流量：一段線路上這段時間送了多少位元組（另一個方向是 TCP 的確認封包） */
export function countBytes(state, h, bytes) {
  if (h.wifi || !h.cable || bytes <= 0) return;
  const pk = Math.max(1, Math.round(bytes / 1514));
  countFrame(state, h.from, h.fromPort, h.to, h.toPort, { dmac: '' }, pk, bytes, true);
  countFrame(state, h.to, h.toPort, h.from, h.fromPort, { dmac: '' }, Math.ceil(pk / 2), Math.ceil(pk / 2) * 66, true);
}

/** iperf3 之類的大量資料：只算計數器（不逐一擷取） */
export function onBulk(state, hops, mbps, secs, retr) {
  const seen = new Set();
  for (const h of hops) {
    if (h.wave || h.wifi || h.reply || !h.cable || seen.has(h.cable) || h.proto === 'arp') continue;
    seen.add(h.cable);
    const pk = Math.max(1, Math.round((mbps * 1e6 * secs) / 8 / 1514));
    countFrame(state, h.from, h.fromPort, h.to, h.toPort, { dmac: '' }, pk, pk * 1514);
    countFrame(state, h.to, h.toPort, h.from, h.fromPort, { dmac: '' }, Math.ceil(pk / 2), Math.ceil(pk / 2) * 66);
    const li = linkInfo(state, h.from, h.fromPort);
    if (li && li.mismatch && retr) {
      const [half, full] = li.duplex === 'half' ? [[h.from, h.fromPort], [h.to, h.toPort]] : [[h.to, h.toPort], [h.from, h.fromPort]];
      const a = ctr(state, half[0], half[1]), b = ctr(state, full[0], full[1]);
      a.late += Math.round(retr * 0.7); a.coll += retr; b.crc += Math.round(retr * 0.8); b.runts += Math.round(retr * 0.5);
    } else if (li && li.half) ctr(state, h.from, h.fromPort).coll += Math.round(pk * 0.03);
  }
}

// ───────────────────────── 背景流量 ─────────────────────────

/**
 * 時間前進時，網路上本來就有的控制訊框：STP 的 BPDU（每 2 秒）、CDP（每 60 秒）、
 * OSPF Hello（每 10 秒）、VRRP 通告（每秒）。計數器會一直往上跳，接著交換器的電腦用 Wireshark 也看得到 BPDU。
 */
export function background(state, { isBridge, ospfOn, uptime0 }) {
  const dyn = state.dyn, now = state.clock, first = dyn.ifcT == null;
  const t0 = first ? now - uptime0 : dyn.ifcT;
  dyn.ifcT = now;
  if (now <= t0) return;
  const ticks = (every) => Math.floor(now / every) - Math.floor(t0 / every);
  const down = state.down || {}, booting = state.rt.booting || {};
  const alive = (d) => !down[d.id] && !state.rt.off[d.id] && !(booting[d.id] > 0);
  const send = (d, pid, f, n) => {
    const l = state.rt.links[d.id + ':' + pid];
    if (!l || n <= 0) return;
    countFrame(state, d.id, pid, l.dev, l.port, f, n, null, true);
    // 控制訊框只有一個方向在送，很少剛好和對方撞在一起；雙工不一致的線還是會零星出錯
    const li = linkInfo(state, d.id, pid);
    if (li && li.mismatch) {
      const acc = (dyn.bgAcc ||= {}), k = d.id + ':' + pid, before = acc[k] || 0;
      acc[k] = before + n;
      const e = Math.floor(acc[k] / 40) - Math.floor(before / 40);
      if (e > 0) {
        const [half, full] = li.duplex === 'half' ? [[d.id, pid], [l.dev, l.port]] : [[l.dev, l.port], [d.id, pid]];
        const a = ctr(state, half[0], half[1]), b = ctr(state, full[0], full[1]);
        a.late += e; a.coll += e; b.crc += e; b.runts += Math.ceil(e * 0.6);
      }
    }
    // 剛好在擷取的主機：最近的幾個控制訊框也會出現在畫面上
    const cap = (dyn.cap || {})[l.dev];
    if (!first && cap && cap.on) {
      const every = f.proto === 'stp' ? 2 : 60;
      for (let k = Math.min(n, 12) - 1; k >= 0; k--) {
        const saved = state.clock;
        state.clock = Math.max(cap.t0, now - k * every);
        record(state, l.dev, f);
        state.clock = saved;
      }
    }
  };
  for (const d of Object.values(state.devices)) {
    if (!alive(d)) continue;
    // STP：指定埠 (designated) 每 2 秒送出一個 BPDU；根埠與替代埠只收不送
    if (d.sw && d.sw.mode === 'vlan' && !(d.sw.stp && d.sw.stp.on === false) && d.rt.stp) {
      const s = d.rt.stp, n = ticks(2);
      for (const [pid, pc] of Object.entries(d.sw.ports)) {
        if (!isBridge(d, pid) || spanDest(d, pid) || pc.bpdufilter) continue;
        const roles = Object.values(s.roles[pid] || {});
        if (roles.length && roles.every((r) => r === 'root' || r === 'altn')) continue;
        const vl = pc.mode === 'trunk' ? d.sw.vlans.length : 1;
        const v = pc.mode === 'trunk' ? pc.native : pc.vlan, root = state.devices[s.root[v] || s.root[Object.keys(s.root)[0]] || d.id];
        const rmac = (root && root.rt.stp && root.rt.stp.mac) || s.mac;
        const port = Math.max(1, d.ports.findIndex((p) => p.id === pid) + 1);
        send(d, pid, { proto: 'stp', smac: s.mac, dmac: STP_MAC, stp: { prio: (root && root.rt.stp && root.rt.stp.prio) || s.prio, vlan: v, root: rmac, cost: root === d ? 0 : 4, port } }, n * vl);
      }
    }
    // CDP：Cisco 設備每 60 秒在每一個有接線的埠送出一次
    if (isIos(d)) {
      const n = ticks(60);
      for (const p of d.ports) {
        if (!state.rt.links[d.id + ':' + p.id] || (d.sw && spanDest(d, p.id))) continue;
        send(d, p.id, { proto: 'cdp', smac: (d.ifaces.find((i) => i.rt && i.rt.mac) || { rt: {} }).rt.mac || '', dmac: CDP_MAC, cdp: { id: d.name, port: p.label } }, n);
      }
    }
    for (const i of d.ifaces) {
      if (!i.rt || i.rt.ip == null || !i.rt.link || (i.bind.t !== 'port' && i.bind.t !== 'sub')) continue;
      if (i.rt.vrrp && i.rt.vrrp.state === 'master') send(d, i.bind.port, { proto: 'vrrp', dmac: '01:00:5e:00:00:12' }, ticks(1));
      if (ospfOn(d, i)) send(d, i.bind.port, { proto: 'ospf', dmac: '01:00:5e:00:00:05' }, ticks(10));
    }
  }
  // 剛才一次補上的是開機以來三天的量：五分鐘平均速率從現在開始算
  if (first) for (const all of Object.values(dyn.ifc || {})) for (const c of Object.values(all)) { c.w = { t: now, ib: c.ib, ob: c.ob, ip: c.ip, op: c.op }; c.pw = null; }
}

// ───────────────────────── 命令列上的即時輸出 ─────────────────────────

/** 只會出現在命令列畫面上的一行（不進紀錄、不送 Syslog） */
export function consoleLine(state, devId, line) {
  const n = (state.dyn.conSeq = (state.dyn.conSeq || 0) + 1);
  const buf = ((state.dyn.con ||= {})[devId] ||= []);
  buf.push({ n, line });
  if (buf.length > 400) buf.shift();
}
export const consoleRows = (state, devId) => ((state.dyn.con || {})[devId]) || [];

// ───────────────────────── 篩選條件 ─────────────────────────

/**
 * tcpdump / FortiGate sniffer 的篩選語法 (BPF)：host、src host、dst host、net、port、src port、dst port、
 * icmp、tcp、udp、arp、esp，用 and / or / not 組合。回傳 { fn } 或 { error }
 */
export function bpf(text) {
  const s = String(text || '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  if (!s || s === 'none') return { fn: () => true };
  const prim = (t) => {
    let not = false;
    if (t[0] === 'not' || t[0] === '!') { not = true; t = t.slice(1); }
    const wrap = (fn) => (not ? (f) => !fn(f) : fn);
    const [a, b, c] = t;
    const ipOk = (x) => parseIp(x) != null;
    const ips = (f) => (f.proto === 'arp' ? [f.arp.sip, f.arp.tip] : [f.src, f.dst]);
    if (t.length === 1 && ['icmp', 'tcp', 'udp', 'arp', 'esp', 'stp'].includes(a)) return wrap((f) => f.proto === a);
    if (a === 'host' && ipOk(b) && t.length === 2) return wrap((f) => ips(f).includes(parseIp(b)));
    if ((a === 'src' || a === 'dst') && b === 'host' && ipOk(c)) return wrap((f) => (a === 'src' ? ips(f)[0] : ips(f)[1]) === parseIp(c));
    if ((a === 'src' || a === 'dst') && ipOk(b) && t.length === 2) return wrap((f) => (a === 'src' ? ips(f)[0] : ips(f)[1]) === parseIp(b));
    if (a === 'net' && parseCidr(b || '')) { const n = parseCidr(b); return wrap((f) => ips(f).some((x) => x != null && netOf(x, n.bits) === n.net)); }
    if (a === 'port' && /^\d+$/.test(b || '')) return wrap((f) => f.sport === +b || f.dport === +b);
    if ((a === 'src' || a === 'dst') && b === 'port' && /^\d+$/.test(c || '')) return wrap((f) => (a === 'src' ? f.sport : f.dport) === +c);
    return null;
  };
  const ors = s.split(/\s+or\s+/);
  const groups = [];
  for (const o of ors) {
    const ands = o.split(/\s+and\s+/).map((x) => prim(x.trim().split(/\s+/)));
    if (ands.some((x) => !x)) return { error: `看不懂篩選條件「${text}」。可以用：host <IP>、net <網段/遮罩>、port <埠>、src host / dst host、icmp、tcp、udp、arp，用 and / or / not 組合` };
    groups.push(ands);
  }
  return { fn: (f) => groups.some((g) => g.every((fn) => fn(f))) };
}

/** Wireshark 的顯示篩選：ip.addr == x、ip.src、ip.dst、tcp.port == n、udp.port、協定名稱，用 && || ! 組合 */
export function displayFilter(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return { fn: () => true };
  const prim = (t) => {
    let not = false;
    t = t.trim();
    if (t.startsWith('!')) { not = true; t = t.slice(1).trim(); } else if (t.startsWith('not ')) { not = true; t = t.slice(4).trim(); }
    const wrap = (fn) => (not ? (f) => !fn(f) : fn);
    const m = t.match(/^([a-z.]+)\s*==\s*([\w.:/]+)$/);
    if (m) {
      const [, k, v] = m, ip = parseIp(v), cidr = parseCidr(v);
      const ips = (f) => (f.proto === 'arp' ? [f.arp.sip, f.arp.tip] : [f.src, f.dst]);
      const inNet = (x) => x != null && (ip != null ? x === ip : cidr && netOf(x, cidr.bits) === cidr.net);
      if (k === 'ip.addr' && (ip != null || cidr)) return wrap((f) => ips(f).some(inNet));
      if (k === 'ip.src' && (ip != null || cidr)) return wrap((f) => inNet(ips(f)[0]));
      if (k === 'ip.dst' && (ip != null || cidr)) return wrap((f) => inNet(ips(f)[1]));
      if ((k === 'tcp.port' || k === 'udp.port') && /^\d+$/.test(v)) return wrap((f) => f.proto === k.slice(0, 3) && (f.sport === +v || f.dport === +v));
      if (k === 'eth.addr') return wrap((f) => f.smac === v || f.dmac === v);
      if (k === 'vlan.id' && /^\d+$/.test(v)) return wrap((f) => f.tag === +v);
      return null;
    }
    const names = { arp: 'ARP', icmp: 'ICMP', tcp: null, udp: null, telnet: 'TELNET', ssh: 'SSHv2', dns: 'DNS', dhcp: 'DHCP', stp: 'STP', cdp: 'CDP', esp: 'ESP', tls: 'TLSv1.3', http: 'HTTP' };
    if (t in names) return wrap((f) => (names[t] ? protoName(f) === names[t] : f.proto === t));
    return null;
  };
  const groups = [];
  for (const o of s.split(/\s*\|\|\s*|\s+or\s+/)) {
    const ands = o.split(/\s*&&\s*|\s+and\s+/).map(prim);
    if (ands.some((x) => !x)) return { error: '篩選條件的寫法：ip.addr == 10.0.0.1、tcp.port == 22、arp、icmp、telnet、ssh、dhcp、stp，用 && 或 || 組合，前面加 ! 是排除' };
    groups.push(ands);
  }
  return { fn: (f) => groups.some((g) => g.every((fn) => fn(f))) };
}

// ───────────────────────── FortiGate：sniffer ─────────────────────────

/** 防火牆上某個埠對應的介面名稱（hard-switch 的成員都算 internal） */
export function fgIfName(d, pid) {
  const i = d.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === pid);
  return i ? i.id : (d.ifaces.find((x) => x.bind.t === 'bridge') || {}).id || String(pid);
}
export function startSniff(state, devId, intf, filter, level, count) {
  (state.dyn.sniff ||= {})[devId] = { intf, filter, level, left: count > 0 ? count : Infinity, got: 0, t0: state.clock };
}
/** 結束 sniffer（抓到指定的數量，或使用者按了 Ctrl-C），印出最後的統計 */
export function stopSniff(state, devId, done) {
  const s = (state.dyn.sniff || {})[devId];
  if (!s) return null;
  delete state.dyn.sniff[devId];
  consoleLine(state, devId, '');
  consoleLine(state, devId, `${s.got} packets received by filter`);
  consoleLine(state, devId, '0 packets dropped by kernel');
  if (!done) consoleLine(state, devId, '（sniffer 已經停止：一開始輸入別的指令，就等於按了 Ctrl-C）');
  return s;
}
export const sniffing = (state, devId) => ((state.dyn.sniff || {})[devId]) || null;

function sniff(state, devId, pid, dir, f) {
  const s = (state.dyn.sniff || {})[devId];
  const d = state.devices[devId];
  if (!s || !d || d.kind !== 'firewall' || pid == null || s.left <= 0) return;
  const name = fgIfName(d, pid);
  if (s.intf !== 'any' && s.intf !== name) return;
  const m = bpf(s.filter);
  if (m.fn && !m.fn(f)) return;
  s.got++; s.left--;
  const t = (state.clock - s.t0 + s.got * 0.000271).toFixed(6);
  const ep = (ip, port) => (f.proto === 'tcp' || f.proto === 'udp' ? `${fmtIp(ip)}.${port}` : fmtIp(ip));
  let body;
  if (f.proto === 'arp') body = f.arp.op === 1 ? `arp who-has ${fmtIp(f.arp.tip)} tell ${fmtIp(f.arp.sip)}` : `arp reply ${fmtIp(f.arp.sip)} is-at ${f.arp.sha}`;
  else {
    const what = f.proto === 'icmp' ? `icmp: echo ${f.reply ? 'reply' : 'request'}` : f.proto === 'tcp' ? (f.data ? 'psh 1 ack 1' : f.ack ? 'ack 1' : f.reply ? 'syn 1 ack 1' : 'syn 1') : f.proto === 'udp' ? `udp ${frameLen(f) - 42}` : f.proto;
    body = `${ep(f.src, f.sport)} -> ${ep(f.dst, f.dport)}: ${what}`;
  }
  consoleLine(state, devId, s.level >= 4 ? `${t} ${name} ${dir} ${body}` : `${t} ${body}`);
  if (s.left <= 0) stopSniff(state, devId, true);
}

// ───────────────────────── FortiGate：debug flow ─────────────────────────

export const dflowOf = (state, devId) => ((state.dyn.dflow ||= {})[devId] ||= { on: false, left: 0, filter: {}, trace: 0, fn: false });

/** 這個封包要不要追蹤：debug 有開、還有剩下的追蹤次數、符合篩選條件 */
export function flowTraceStart(state, d, pkt) {
  if (!d || d.kind !== 'firewall') return null;
  const x = (state.dyn.dflow || {})[d.id];
  if (!x || !x.on || x.left <= 0) return null;
  const fl = x.filter;
  if (fl.addr != null && pkt.src !== fl.addr && pkt.dst !== fl.addr) return null;
  if (fl.proto != null && PROTO_NO[pkt.proto] !== fl.proto) return null;
  if (fl.port != null && pkt.sport !== fl.port && pkt.dport !== fl.port) return null;
  x.left--;
  const id = ++x.trace;
  return (fn, msg) => consoleLine(state, d.id, `id=20085 trace_id=${id} func=${fn} line=${4000 + (fn.length * 97) % 3000} msg="${msg}"`);
}

// ───────────────────────── IOS：debug ─────────────────────────

export const debugOf = (state, devId) => ((state.dyn.dbg || {})[devId]) || null;
export function setDebug(state, devId, what, on) {
  const all = (state.dyn.dbg ||= {});
  if (what === 'all') { if (!on) delete all[devId]; return; }
  const x = (all[devId] ||= {});
  if (on) x[what] = true; else delete x[what];
  if (!Object.keys(x).length) delete all[devId];
}
