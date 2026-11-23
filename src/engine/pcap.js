// 把擷取到的訊框匯出成 .pcap（libpcap 格式，Ethernet），可以直接用真的 Wireshark 打開。
// 每個訊框依照它的欄位組出真正的位元組：Ethernet（含 802.1Q）、ARP、IPv4、ICMP、TCP、UDP、DNS、DHCP、STP、CDP、LLDP；
// IP、ICMP、TCP、UDP 的檢查碼都算好。內容是模擬出來的：Telnet / FTP / HTTP 放明文，SSH、TLS、ESP 放亂數（本來就看不懂）。

const macBytes = (m) => String(m || '00:00:00:00:00:00').split(/[:.-]/).join('').padEnd(12, '0').match(/../g).map((x) => parseInt(x, 16) || 0);
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ip4 = (n) => u32((n ?? 0) >>> 0);
const ascii = (s) => [...new TextEncoder().encode(String(s))];
/** 可重現的「亂數」：同一個訊框每次匯出都一樣 */
function noise(seed, n) { const o = []; let x = (seed * 2654435761) >>> 0 || 1; for (let k = 0; k < n; k++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; o.push(x & 255); } return o; }
function csum(bytes) {
  let s = 0;
  for (let k = 0; k < bytes.length; k += 2) s += (bytes[k] << 8) + (bytes[k + 1] || 0);
  while (s >>> 16) s = (s & 0xffff) + (s >>> 16);
  return (~s) & 0xffff;
}
const pad = (arr, n) => (arr.length >= n ? arr : [...arr, ...new Array(n - arr.length).fill(0)]);

function dnsName(name) { const o = []; for (const l of String(name || '').split('.').filter(Boolean)) { const b = ascii(l).slice(0, 63); o.push(b.length, ...b); } o.push(0); return o; }

/** UDP 的內容（依埠號） */
function udpPayload(f, want) {
  const p = (n) => f.sport === n || f.dport === n;
  if (p(53) && !f.natt) {
    const q = dnsName(f.qname || 'unknown.example');
    const id = ((f.sport ^ f.dport) * 97) & 0xffff;
    return [...u16(id), ...(f.reply ? [0x81, 0x80] : [0x01, 0x00]), ...u16(1), 0, 0, 0, 0, 0, 0, ...q, 0, 1, 0, 1];
  }
  if (p(1812) || p(161) || p(162)) {
    const s = (f.data && f.data.snmp) || {};
    if (p(161) || p(162)) {
      // SNMPv2c：SEQUENCE { version 1, community, PDU }（PDU 簡化成空的 GetResponse / Trap）
      const comm = ascii(s.ver === 'v3' ? '' : s.community || 'public');
      const pdu = [f.dport === 162 ? 0xa7 : f.reply ? 0xa2 : 0xa5, 11, 0x02, 1, 1, 0x02, 1, 0, 0x02, 1, 0, 0x30, 0];
      const body = [0x02, 1, 1, 0x04, comm.length, ...comm, ...pdu];
      return [0x30, body.length, ...body];
    }
  }
  if (f.natt) return [...u32(f.spi || 0x1001), ...u32(1), ...noise(f.spi || 7, Math.max(0, want - 8))];
  if (p(69) && f.data && f.data.kind === 'tftp') return [0, f.data.op === 'RRQ' ? 1 : 2, ...ascii(f.data.file || 'file'), 0, ...ascii('octet'), 0];
  if (p(514)) return ascii(`<189>${f.data && f.data.text ? f.data.text : '%SYS-5-CONFIG_I: Configured from console'}`);
  return new Array(Math.max(0, want)).fill(0);
}

/** DHCP（BOOTP 加上 magic cookie 與 option 53） */
function dhcpPayload(f) {
  const t = { discover: 1, offer: 2, request: 3, ack: 5 }[f.dhcp.type] || 1, reply = t === 2 || t === 5;
  const b = [reply ? 2 : 1, 1, 6, 0, ...u32(parseInt(f.dhcp.xid, 16) || 0), 0, 0, 0x80, 0, 0, 0, 0, 0, ...ip4(reply ? f.dhcp.ip : 0), ...ip4(reply ? f.src : 0), 0, 0, 0, 0];
  b.push(...pad(macBytes(reply ? f.dmac : f.smac), 16), ...new Array(192).fill(0), 0x63, 0x82, 0x53, 0x63, 53, 1, t);
  if (reply) b.push(54, 4, ...ip4(f.src), 51, 4, ...u32(86400), 1, 4, 255, 255, 255, 0);
  b.push(255);
  return pad(b, 300);
}

function tcpPayload(f, want) {
  const p = (n) => f.sport === n || f.dport === n, d = f.data;
  if (!d) return new Array(Math.max(0, want)).fill(0);
  if (p(23)) return ascii(d.kind === 'login' ? `${d.user}\r\n${d.pass}\r\n` : d.kind === 'cmd' ? `${d.text}\r\n` : 'Router#\r\n');
  if (p(21)) return ascii(d.kind === 'ftp' ? `USER ${d.user}\r\nPASS ${d.pass}\r\n${d.cmd || ''}\r\n` : '226 Transfer complete.\r\n');
  if (p(80)) return ascii(f.reply ? 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n' : `GET / HTTP/1.1\r\nHost: ${f.host || 'www.example.com'}\r\n\r\n`);
  const n = Math.max(16, want);
  if (p(443) || p(10443)) return [0x17, 0x03, 0x03, ...u16(n - 5), ...noise(f.sport + f.dport, n - 5)];
  return noise(f.sport * 31 + f.dport, n); // SSH 等加密的內容
}

/** 一個訊框 → Ethernet 的位元組 */
export function frameBytes(f) {
  const eth = [...macBytes(f.dmac), ...macBytes(f.smac)];
  const tag = f.tag != null ? [0x81, 0x00, ...u16((f.tag & 0xfff) | ((f.cos || 0) << 13))] : [];
  if (f.proto === 'arp') {
    const a = f.arp;
    return pad([...eth, ...tag, 0x08, 0x06, 0, 1, 0x08, 0x00, 6, 4, ...u16(a.op), ...macBytes(a.sha), ...ip4(a.sip), ...macBytes(a.op === 1 ? '00:00:00:00:00:00' : a.tha || f.dmac), ...ip4(a.tip)], 60);
  }
  if (f.proto === 'stp' || f.proto === 'cdp' || f.proto === 'lldp' || f.proto === 'dtp') return l2Control(f, eth, tag);
  // IPv4
  const proto = { icmp: 1, tcp: 6, udp: 17, dhcp: 17, esp: 50, gre: 47 }[f.proto] ?? 17;
  const ipLen = Math.max(28, (f.len || 74) - 14 - tag.length); // 擷取到的訊框：len 是整個 Ethernet 訊框的長度
  let l4;
  if (f.proto === 'icmp') {
    const type = f.icmpErr ? 3 : f.ttlExceeded ? 11 : f.reply ? 0 : 8, code = f.icmpErr ? 4 : 0;
    const rest = f.icmpErr ? [0, 0, ...u16(f.mtu || 1400)] : [...u16(f.reply ? f.dport : f.sport), 0, 1];
    const body = [type, code, 0, 0, ...rest, ...Array.from({ length: Math.max(0, ipLen - 28) }, (_, k) => 0x61 + (k % 23))]; // Windows 的 ping：abcdefghijklmnopqrstuvw…
    const c = csum(body); body[2] = c >>> 8; body[3] = c & 255;
    l4 = body;
  } else if (f.proto === 'tcp') {
    const fl = f.data ? 0x18 : f.ack ? 0x10 : f.reply ? 0x12 : 0x02;
    const pay = f.data ? tcpPayload(f, ipLen - 40) : f.bulk ? new Array(Math.max(0, ipLen - 40)).fill(0) : [];
    l4 = [...u16(f.sport || 0), ...u16(f.dport || 0), ...u32(f.ack || f.data ? 1001 : 1000), ...u32(f.ack || f.reply || f.data ? 2001 : 0), 0x50, fl, ...u16(64240), 0, 0, 0, 0, ...pay];
    const ph = [...ip4(f.src), ...ip4(f.dst), 0, 6, ...u16(l4.length)];
    const c = csum([...ph, ...l4]); l4[16] = c >>> 8; l4[17] = c & 255;
  } else if (f.proto === 'esp') {
    l4 = [...u32(f.spi || 0x1001), ...u32(1), ...noise(f.spi || 3, Math.max(8, ipLen - 28))];
  } else if (f.proto === 'gre') {
    l4 = [0, 0, 0x08, 0x00, ...noise(11, Math.max(20, ipLen - 24))];
  } else {
    const isDhcp = f.proto === 'dhcp';
    const sport = isDhcp ? f.sport || 68 : f.natt ? 4500 : f.sport || 0, dport = isDhcp ? f.dport || 67 : f.natt ? 4500 : f.dport || 0;
    const pay = isDhcp ? dhcpPayload(f) : udpPayload({ ...f, sport, dport }, ipLen - 28);
    l4 = [...u16(sport), ...u16(dport), ...u16(8 + pay.length), 0, 0, ...pay];
    const ph = [...ip4(f.src), ...ip4(f.dst), 0, 17, ...u16(l4.length)];
    let c = csum([...ph, ...l4]); if (c === 0) c = 0xffff;
    l4[6] = c >>> 8; l4[7] = c & 255;
  }
  const total = 20 + l4.length;
  const ip = [0x45, ((f.dscp || 0) << 2) & 255, ...u16(total), ...u16(((f.sport || 0) * 131 + (f.dport || 0)) & 0xffff), f.df ? 0x40 : 0, 0, f.ttl || 64, proto, 0, 0, ...ip4(f.src), ...ip4(f.dst)];
  const c = csum(ip); ip[10] = c >>> 8; ip[11] = c & 255;
  return pad([...eth, ...tag, 0x08, 0x00, ...ip, ...l4], 60);
}

/** STP（802.1D 設定 BPDU）、CDP、LLDP、DTP */
function l2Control(f, eth, tag) {
  if (f.proto === 'lldp') {
    const tlv = (t, v) => [((t << 1) | (v.length >>> 8)) & 255, v.length & 255, ...v];
    const body = [...tlv(1, [4, ...macBytes(f.smac)]), ...tlv(2, [5, ...ascii(f.lldp.port)]), ...tlv(3, u16(f.lldp.ttl || 120)), ...tlv(5, ascii(f.lldp.id)), 0, 0];
    return pad([...eth, 0x88, 0xcc, ...body], 60);
  }
  let llc;
  if (f.proto === 'stp') {
    const s = f.stp, bid = (prio, mac) => [...u16(((prio || 32768) & 0xf000) | ((s.vlan || 1) & 0xfff)), ...macBytes(mac)];
    llc = [0x42, 0x42, 0x03, 0, 0, 0, 0, 0, ...bid(s.prio, s.root), ...u32(s.cost || 0), ...bid(s.prio, f.smac), 0x80, (s.port || 1) & 255, 0, 0, 0x14, 0, 0x02, 0, 0x0f, 0];
  } else if (f.proto === 'cdp') {
    const tlv = (t, v) => [...u16(t), ...u16(v.length + 4), ...v];
    const body = [2, 180, 0, 0, ...tlv(1, ascii(f.cdp.id)), ...tlv(3, ascii(f.cdp.port))];
    llc = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x20, 0x00, ...body];
  } else {
    llc = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x20, 0x04, 1, 0, 1, 0, 5, 0x03];
  }
  return pad([...eth, ...tag, ...u16(llc.length), ...llc], 60);
}

/** 整份擷取 → .pcap 的位元組。t0 是擷取開始時的 Unix 時間（秒） */
export function pcapBytes(frames, t0 = 0) {
  const out = [0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 1, 0, 0, 0]; // little-endian：magic、2.4、snaplen 65535、Ethernet
  const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  // DNS 的回應沒有記查的名稱：用同一組位址與埠號的查詢補上
  const q = new Map();
  for (const f of frames) if (f.qname) q.set(`${f.src}:${f.sport}>${f.dst}:${f.dport}`, f.qname);
  frames = frames.map((f) => (!f.qname && f.reply && q.has(`${f.dst}:${f.dport}>${f.src}:${f.sport}`) ? { ...f, qname: q.get(`${f.dst}:${f.dport}>${f.src}:${f.sport}`) } : f));
  for (const f of frames) {
    let b;
    try { b = frameBytes(f); } catch { continue; }
    const t = t0 + (f.t || 0), sec = Math.floor(t), usec = Math.floor((t - sec) * 1e6);
    out.push(...le32(sec >>> 0), ...le32(usec), ...le32(b.length), ...le32(b.length), ...b);
  }
  return new Uint8Array(out);
}
