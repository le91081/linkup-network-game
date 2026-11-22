// NetFlow：路由器記下經過的每一條流量（來源、目的、協定、埠、從哪個介面進來、多少位元組），匯出給收集器（網管伺服器）
//
// 設定（IOS）：
//   傳統 NetFlow：介面 ip flow ingress | egress；全域 ip flow-export destination <IP> <埠>、ip flow-export version 9、ip flow-export source <介面>
//   Flexible NetFlow：flow record <名稱>（match / collect，這裡只記下來）、flow exporter <名稱>（destination、transport udp、source）、
//     flow monitor <名稱>（record、exporter、cache timeout active / inactive），介面 ip flow monitor <名稱> input | output
//   d.nf = { ingress: [介面 id], egress: [介面 id], export: { ip, port, src, ver }, records: {}, exporters: { 名稱: { ip, port, src } }, monitors: { 名稱: { record, exporter, active, inactive } }, ifMon: { 介面 id: { in, out } } }
// 執行期：state.dyn.nf[設備] = { 鍵: { src, dst, proto, sport, dport, inIf, outIf, bytes, pkts, first, last, mon } }
//   state.dyn.nfc[收集器][匯出的設備] = { 同上的鍵: {...}, last }（收集器收到的）
import { fmtIp } from './ip.js';

export const NF_INACTIVE = 15; // 沒有新封包超過 15 秒，這筆流量就從快取裡拿掉（匯出）
export const NF_ACTIVE = 1800; // 傳統 NetFlow 的 active timeout 30 分鐘

/** 這個介面有沒有在收集進來的流量：傳統的 ip flow ingress，或 ip flow monitor … input */
export function nfIn(d, i) {
  const c = d.nf;
  if (!c || !i) return null;
  if ((c.ingress || []).includes(i.id)) return 'ingress';
  const m = c.ifMon && c.ifMon[i.id] && c.ifMon[i.id].in;
  return m && (c.monitors || {})[m] ? m : null;
}
/** 匯出到哪裡：傳統的 ip flow-export，或監控用的 exporter */
export function nfExport(d, mon) {
  const c = d.nf || {};
  if (mon && mon !== 'ingress') { const m = (c.monitors || {})[mon], e = m && (c.exporters || {})[m.exporter]; return e && e.ip ? e : null; }
  return c.export && c.export.ip ? c.export : null;
}

/**
 * 背景流量算完速率之後呼叫：每條流量經過的每一台有開 NetFlow 的路由器，把這段時間的位元組數記進快取，
 * 能送到收集器的話也記到收集器那裡
 */
export function nfAccount(state, items, dt, deliverable) {
  const now = state.clock, dyn = state.dyn, tbl = (dyn.nf ||= {}), col = (dyn.nfc ||= {});
  for (const x of items) {
    if (!(x.rate > 0) || !x.hops.length) continue;
    const bytes = (x.rate * 1e6 * dt) / 8;
    x.hops.forEach((h, idx) => {
      const d = state.devices[h.to];
      if (!d || !d.nf || !d.routing) return;
      const i = d.ifaces.find((y) => (y.bind.t === 'port' && y.bind.port === h.toPort) || (y.bind.t === 'sub' && y.bind.port === h.toPort && y.bind.vlan === h.tag));
      const mon = nfIn(d, i);
      if (!mon) return;
      const nx = x.hops[idx + 1], oi = nx && nx.from === h.to ? d.ifaces.find((y) => (y.bind.t === 'port' || y.bind.t === 'sub') && y.bind.port === nx.fromPort) : null;
      const k = `${x.src}|${x.ip}|tcp|${x.sport}|${x.dport}|${i.id}`;
      const e = ((tbl[d.id] ||= {})[k] ||= { src: x.src, dst: x.ip, proto: 'tcp', sport: x.sport, dport: x.dport, inIf: i.id, outIf: oi ? oi.id : null, bytes: 0, pkts: 0, first: now, mon });
      e.bytes += bytes; e.pkts += Math.max(1, Math.round(bytes / 1400)); e.last = now; e.mon = mon;
      const ex = nfExport(d, mon);
      const cid = ex && dt > 0 ? deliverable(d, ex) : null;
      if (cid) {
        const c = ((col[cid] ||= {})[d.id] ||= {});
        const ce = (c[k] ||= { ...e, bytes: 0, pkts: 0 });
        ce.bytes += bytes; ce.pkts += Math.max(1, Math.round(bytes / 1400)); ce.last = now;
      }
    });
  }
  // 太久沒有新封包的項目：從快取拿掉
  for (const t of Object.values(tbl)) for (const [k, e] of Object.entries(t)) if (now - e.last > NF_INACTIVE) delete t[k];
}

/** 快取裡還在的流量，位元組多的在前面 */
export function nfRows(state, d) {
  return Object.values(((state.dyn && state.dyn.nf) || {})[d.id] || {}).sort((a, b) => b.bytes - a.bytes);
}
/** 收集器（網管伺服器）收到的 Top Talkers：依來源位址加總 */
export function nfTop(state, collector) {
  const all = ((state.dyn && state.dyn.nfc) || {})[collector.id] || {};
  const by = {};
  for (const [dev, t] of Object.entries(all)) for (const e of Object.values(t)) {
    const k = e.src;
    const r = (by[k] ||= { src: e.src, bytes: 0, flows: 0, dsts: new Set(), via: new Set() });
    r.bytes += e.bytes; r.flows++; r.dsts.add(fmtIp(e.dst) + ':' + e.dport); r.via.add(dev);
  }
  return Object.values(by).sort((a, b) => b.bytes - a.bytes);
}
