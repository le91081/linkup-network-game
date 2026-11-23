// 模擬引擎共用的小工具：VRF、MAC、雜湊、位址清單、時間格式、連線紀錄與命中次數
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { fmtIp, netOf, parseCidr, parseIp } from '../ip.js';
import { logEvent } from '../ops.js';

/** 介面屬於哪一個 VRF（'' 是全域的路由表） */
export const vrfOf = (i) => (i && i.vrf) || '';

export const DROP = Symbol('drop');
export const isVlanSw = (d) => !!d.sw && d.sw.mode === 'vlan';
/** 這個埠「現在」是不是 Trunk：dynamic auto / desirable 要看 DTP 協商的結果 */
export const isTrunk = (d, pid) => {
  const t = d.rt && d.rt.dtp && d.rt.dtp[pid];
  return t ? t.oper === 'trunk' : !!(d.sw && d.sw.ports[pid] && d.sw.ports[pid].mode === 'trunk');
};
/** IP 電話的內建交換器：電話自己的介面接在哪個 VLAN（學到語音 VLAN 之前跟電腦一樣不帶標籤） */
export const bridgeKey = (d) => (d.sw && d.sw.mode === 'phone' && d.rt && d.rt.voice ? d.rt.voice.vlan : 'u');
/**
 * IP 電話有兩個埠：SW 接交換器、PC 接電腦。電腦的訊框不帶標籤直接通過；
 * 電話自己的語音流量帶著語音 VLAN 的標籤（從 CDP / LLDP-MED 學到，或手動設定）
 */
export function phoneIngress(dev, pid, tag) {
  const v = dev.rt && dev.rt.voice ? dev.rt.voice.vlan : null;
  if (pid === 'pc') return dev.phone && dev.phone.pcPort === false ? DROP : tag == null ? 'u' : DROP;
  return tag == null ? 'u' : tag === v ? v : DROP;
}
export function phoneEgress(dev, pid, key) {
  const v = dev.rt && dev.rt.voice ? dev.rt.voice.vlan : null;
  if (pid === 'pc') return dev.phone && dev.phone.pcPort === false ? DROP : key === 'u' ? null : DROP;
  return key === 'u' ? null : key === v ? v : DROP;
}

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 每個介面固定的 MAC 位址（由設備 id 推導，重開遊戲也不會變） */
export function macOf(devId, key) {
  const a = hash(devId + '/' + key), b = hash(key + '#' + devId);
  return [0x02, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255].map((x) => x.toString(16).padStart(2, '0')).join(':');
}
export function ifaceMac(dev, i) {
  const b = i.bind;
  return macOf(dev.id, b.t === 'port' || b.t === 'sub' ? b.port : b.t === 'wlan' ? 'wlan' : 'br');
}

export const cidrList = (s) => String(s || '').split(/[,\s]+/).map(parseCidr).filter(Boolean);
export const selMatch = (list, ip) => list.some((c) => netOf(ip, c.bits) === c.net);
export const dnsList = (s) => String(s || '').split(/[,\s]+/).map(parseIp).filter((x) => x != null);
export const macList = (s) => String(s || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
export function cmp(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
export const fmtDur = (s) => {
  s = Math.max(0, Math.ceil(s));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分${s % 60 ? ` ${s % 60} 秒` : '鐘'}`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} 分` : ''}`;
  return `${Math.floor(s / 86400)} 天${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} 小時` : ''}`;
};
export const PROTO_NUM = { icmp: 1, tcp: 6, udp: 17, esp: 50 };
/** IP 封包的長度（debug ip packet 的 len） */
export const ipLen = (p) => p.len || (p.proto === 'icmp' ? 60 : p.proto === 'tcp' ? (p.data ? 96 : p.ack ? 40 : 44) : p.proto === 'udp' ? 68 : 120);
/** FortiGate 連線的編號（同一條連線固定） */
export const sessId = (e) => hash(`${e.proto}|${e.src}|${e.sport}|${e.dst}|${e.dport}`).toString(16).padStart(8, '0');
/** 防火牆拒絕連線時留下的流量紀錄（會送到 Syslog 伺服器） */
export function denyLog(state, dev, pkt, o, inIf, outIf, rule) {
  if (QUIET || dev.kind !== 'firewall') return;
  logEvent(state, dev, 5, '', '', `logid="0000000013" type="traffic" subtype="forward" level="notice" vd="root" srcip=${fmtIp(o.src)} srcport=${o.sport} srcintf="${inIf.id}" dstip=${fmtIp(o.dst)} dstport=${o.dport} dstintf="${outIf.id}" policyid=${rule || 0} proto=${PROTO_NUM[pkt.proto] || 0} action="deny"`);
}

export let QUIET = false; // 引擎內部的控制流量（IKE、RADIUS、DHCP Relay）不記入紀錄
let logSeq = 0;
const LOGS = new WeakMap(), HITS = new WeakMap();
/** 設備最近處理過的連線（防火牆放行 / 拒絕、NAT 轉換），最新的在前面 */
export const sessionLog = (dev) => LOGS.get(dev) || [];
/** 某條政策或 ACL 規則被命中的次數 */
export const hitsOf = (rule) => HITS.get(rule) || 0;
export const clearSessionLog = (dev) => { LOGS.delete(dev); };
export function sess(dev, e) {
  if (QUIET) return;
  let l = LOGS.get(dev);
  if (!l) LOGS.set(dev, (l = []));
  l.unshift({ n: ++logSeq, ...e });
  if (l.length > 40) l.pop();
}
export function hit(rule) { if (!QUIET) HITS.set(rule, (HITS.get(rule) || 0) + 1); }

/** transact 期間暫時不記錄（引擎內部的控制流量）：回傳原本的值，用完要還原 */
export function setQuiet(v) { const p = QUIET; QUIET = v; return p; }

/** 政策路由 (PBR) 每一條 route-map 符合了幾個封包、多少位元組（show route-map 的 Policy routing matches） */
export const PBR_HITS = new WeakMap();
export const pbrHits = (e) => PBR_HITS.get(e) || { pk: 0, by: 0 };

/** 因為 time-range 現在不在時間內而暫時不生效的 ACL 規則（每次重算時由 timerange.js 更新） */
export const TR_OFF = new WeakSet();
