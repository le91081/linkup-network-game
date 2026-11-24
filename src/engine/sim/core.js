// 模擬引擎共用的小工具：VRF、MAC、雜湊、位址清單、時間格式、連線紀錄與命中次數
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { fmtIp, netOf, parseCidr, parseIp } from '../ip.js';
import { logEvent } from '../ops.js';
import { OUI, ONE_OUI, ouiKey } from '../oui.js';

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

const hex2 = (arr) => arr.map((x) => x.toString(16).padStart(2, '0')).join(':');
/** 以前的寫法：全部是 02 開頭的本機管理位址（只給舊存檔的遷移用，engine/migrate.js） */
export function legacyMac(devId, key) {
  const a = hash(devId + '/' + key), b = hash(key + '#' + devId);
  return hex2([0x02, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255]);
}
/**
 * 每個介面固定的 MAC 位址（由設備 id 推導，重開遊戲也不會變）。
 * 和真的設備一樣：前三個位元組是那個型號的製造商登記的廠商碼 (OUI，engine/oui.js)；
 * 同一台設備的位址是連號的 — 基底位址（交換器自己、SVI 用的）之後，第 n 個埠就是基底 + n。
 * key：埠的 id、'wlan'（無線網卡）或 'br'（基底位址）；idx：這個埠是設備的第幾個埠（從 0 算）
 */
export function macOf(devId, key, model, idx = 0) {
  const v = ouiKey(model, key), list = OUI[v];
  if (!list) {
    // 沒有廠商碼的介面：雲端的虛擬網卡、手機對每個 Wi-Fi 隨機產生的私人位址。第一個位元組的「本機管理」位元是 1
    const a = hash(devId + '/' + key), b = hash(key + '#' + devId);
    const first = v === 'private' ? ((a >>> 24) & 0xfc) | 0x02 : v === 'aws' ? [0x02, 0x06, 0x0a, 0x0e][a >>> 30] : 0x02;
    return hex2([first, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255]);
  }
  const oui = ONE_OUI.has(model) ? list[0] : list[hash('oui/' + devId) % list.length];
  const n = ((hash(devId + '/br') & 0xffffc0) + (key === 'br' ? 0 : idx + 1)) & 0xffffff;
  return oui + ':' + hex2([n >>> 16, (n >>> 8) & 255, n & 255]);
}
// ── 作業系統：送出的封包一開始的 TTL、用戶端連線用的來源埠，各家不一樣 ──
const WIN_MODELS = new Set(['pc', 'laptop', 'laptop6e', 'tower', 'rack1u', 'vm']);
const TTL255 = new Set(['isr4321', 'isr4331', 'c2960', 'c2960p', 'c9300', 'n93180', 'n9332', 'c9800', 'fg60f', 'fg100f', 'bigip', 'metroe', 'metroelan']);
/** 這台主機跑的是 Linux（終端機是 bash）：自動化、容器、備份用的主機，或關卡指定 os: 'linux'。其他的電腦與伺服器是 Windows */
export const isLinuxHost = (dev) => !!dev && (!!dev.ansible || !!dev.docker || !!dev.tf || !!dev.git || dev.os === 'linux');
/** 'windows'（電腦、筆電、Windows 伺服器）、'net'（Cisco IOS / NX-OS、FortiOS、BIG-IP）、'linux'（其他：Linux、手機、NAS、印表機、Junos、RouterOS…） */
export function osOf(dev) {
  if (!dev) return 'linux';
  if (dev.kind === 'host') return WIN_MODELS.has(dev.model) && !isLinuxHost(dev) ? 'windows' : 'linux';
  return TTL255.has(dev.model) ? 'net' : 'linux';
}
/**
 * 送出的封包一開始的 TTL：Windows 128、Linux 與多數設備 64、Cisco / FortiGate / BIG-IP 255。
 * 所以從 ping 回來的 TTL 可以回推「對方大概是什麼系統、中間隔了幾台路由器」（126 = Windows、隔兩台）。
 * ip：回應的是哪個位址 — 網際網路那一台，自己的介面是業者的路由器 (255)，上面的主機是伺服器 (64)
 */
export function initTtl(dev, ip) {
  if (dev && dev.kind === 'internet') return ip == null || dev.ifaces.some((i) => i.rt && i.rt.ip === ip) ? 255 : 64;
  return { windows: 128, net: 255, linux: 64 }[osOf(dev)];
}
/** 用戶端的來源埠（暫時埠）：Windows 用 49152–65535，Linux 與多數設備用 32768–60999。n 是封包的流水號，換算成看起來不連續的埠 */
export const ephPort = (dev, n) => (osOf(dev) === 'windows' ? 49152 + ((n * 7919) % 16384) : 32768 + ((n * 7919) % 28232));

export function ifaceMac(dev, i) {
  const b = i.bind;
  if (b.t === 'port' || b.t === 'sub') return macOf(dev.id, b.port, dev.model, Math.max(0, dev.ports.findIndex((p) => p.id === b.port)));
  if (b.t === 'wlan') return macOf(dev.id, 'wlan', dev.model, dev.ports.length);
  return macOf(dev.id, 'br', dev.model);
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
