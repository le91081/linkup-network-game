// IOS 的 show 指令：NetFlow（傳統的 show ip cache flow、Flexible NetFlow 的 show flow monitor … cache）
import { fmtIp } from '../engine/ip.js';
import { nfRows, nfExport } from '../engine/netflow.js';

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const hex = (n) => (n >>> 0).toString(16).toUpperCase().padStart(4, '0');
const ifl = (d, id) => (d.ifaces.find((x) => x.id === id) || { label: id }).label;

/** show ip cache flow */
export function cacheFlowLines(st, d) {
  if (!d.nf || !((d.nf.ingress || []).length || Object.keys(d.nf.ifMon || {}).length)) return ['（這台沒有任何介面在收集 NetFlow：介面上 ip flow ingress，或 ip flow monitor <名稱> input）'];
  const rows = nfRows(st, d);
  const total = rows.reduce((a, r) => a + r.pkts, 0);
  const o = ['IP packet size distribution (' + total + ' total packets):', '', 'IP Flow Switching Cache, 278544 bytes', `  ${rows.length} active, ${4096 - rows.length} inactive, ${rows.length} added`, `  ${rows.length} ager polls, 0 flow alloc failures`, '  Active flows timeout in 30 minutes', '  Inactive flows timeout in 15 seconds', '',
    pad('SrcIf', 14) + pad('SrcIPaddress', 16) + pad('DstIf', 14) + pad('DstIPaddress', 16) + 'Pr SrcP DstP  Pkts'];
  for (const r of rows) o.push(pad(ifl(d, r.inIf), 14) + pad(fmtIp(r.src), 16) + pad(r.outIf ? ifl(d, r.outIf) : 'Null', 14) + pad(fmtIp(r.dst), 16) + `06 ${hex(r.sport)} ${hex(r.dport)} ${lpad(r.pkts, 6)}`);
  if (!rows.length) o.push('（現在沒有流量經過有開 NetFlow 的介面）');
  return o;
}

/** show flow monitor <名稱> cache [sort …] */
export function flowMonitorLines(st, d, name) {
  const m = ((d.nf || {}).monitors || {})[name];
  if (!m) return [`% Flow Monitor: ${name} does not exist`];
  const rows = nfRows(st, d).filter((r) => r.mon === name);
  const o = ['  Cache type:                               Normal (Platform cache)', '  Cache size:                                 4096', `  Current entries:                           ${rows.length}`, `  Flows added:                               ${rows.length}`, '',
    pad('IPV4 SRC ADDR', 18) + pad('IPV4 DST ADDR', 18) + pad('TRNS SRC PORT', 15) + pad('TRNS DST PORT', 15) + pad('INTF INPUT', 13) + pad('IP PROT', 9) + 'bytes long',
    '================  ================  =============  =============  ===========  =======  ==========='];
  for (const r of rows) o.push(pad(fmtIp(r.src), 18) + pad(fmtIp(r.dst), 18) + pad(r.sport, 15) + pad(r.dport, 15) + pad(ifl(d, r.inIf), 13) + pad(6, 9) + Math.round(r.bytes));
  if (!rows.length) o.push('（快取是空的：介面上要 ip flow monitor ' + name + ' input，而且要有流量經過）');
  return o;
}

/** show flow exporter / show ip flow export */
export function flowExporterLines(st, d) {
  const N = d.nf || {}, o = [];
  for (const [n, e] of Object.entries(N.exporters || {})) {
    o.push(`Flow Exporter ${n}:`, '  Description:              User defined', '  Export protocol:          NetFlow Version 9', '  Transport Configuration:', `    Destination IP address: ${e.ip || '(not configured)'}`, `    Source IP address:      ${e.src ? (() => { const i = d.ifaces.find((x) => x.id === e.src); return i && i.rt.ip != null ? fmtIp(i.rt.ip) : '0.0.0.0'; })() : '（出口介面的位址）'}`, '    Transport Protocol:     UDP', `    Destination Port:       ${e.port || 9995}`, '');
  }
  if (N.export && N.export.ip) o.push(`Flow export v${N.export.ver || 5} is enabled for main cache`, `  Export source and destination details :`, `  VRF ID : Default`, `    Destination(1)  ${N.export.ip} (${N.export.port})`, '');
  return o.length ? o : ['（沒有設定 flow exporter，也沒有 ip flow-export destination）'];
}
void nfExport;
