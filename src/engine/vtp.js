// VTP（VLAN Trunking Protocol）版本 1 / 2：同一個網域、密碼一樣的 Catalyst 交換器經由 Trunk 同步 VLAN 資料庫
//
// - server 可以新增 / 刪除 VLAN，每改一次 configuration revision 加一；client 不能改，只接收
// - 收到 revision 比自己大的通告，就用通告的內容「整份取代」自己的 VLAN 資料庫（client 也會送出自己的）
//   → 從實驗室拿回來、revision 比較大的交換器一接上 Trunk，整棟樓的 VLAN 就被它蓋掉
// - transparent：不同步、自己的 VLAN 自己管，但會轉送別人的通告；revision 永遠是 0。off：連轉送都不做
// - 網域名稱是空的 (NULL) 交換器：收到第一個通告就加入那個網域
// - 改網域名稱、或切到 transparent，revision 歸零（這是讓舊交換器安全加入的標準做法）
// - 網域裡要用同樣的密碼 (vtp password)：密碼不同，通告的 MD5 摘要對不起來，不會同步
// - 只同步一般範圍的 VLAN（2 – 1001）；擴充範圍 (1006 – 4094) 留在各台自己身上
//
// d.sw.vtp = { mode, domain, pass, ver, rev, sig, from, at }（沒有這個物件 = 原廠預設：server、網域空白、revision 0）
// d.rt.vtp = { domain, err, peers }（這一輪算出來的狀態）
import { isTrunk } from './sim/core.js';

export const VTP_DEF = { mode: 'server', domain: '', pass: '', ver: 1, rev: 0 };
/** 有 VTP 的交換器：Catalyst（2960、9300）。Nexus 與無線控制器不算 */
export const vtpCapable = (d) => !!d.sw && d.sw.mode === 'vlan' && (d.kind === 'mswitch' || d.kind === 'l3switch') && /^c/.test(d.model);
export const vtpOf = (d) => ({ ...VTP_DEF, ...((d.sw && d.sw.vtp) || {}) });
const normal = (v) => v.id >= 2 && v.id <= 1001;
/** VLAN 資料庫的指紋：判斷有沒有改過（server 每改一次 revision 加一） */
export const vtpSig = (d) => d.sw.vlans.filter(normal).sort((a, b) => a.id - b.id).map((v) => `${v.id}:${v.name}`).join('|');
const set = (d, o) => { d.sw.vtp = { ...vtpOf(d), ...o }; };
/**
 * 改 VTP 的設定（CLI 與圖形介面共用）：改網域名稱、切到 transparent / off，revision 歸零。
 * 全部回到原廠預設就拿掉 d.sw.vtp
 */
export function vtpSet(d, o) {
  const cur = vtpOf(d), next = { ...cur, ...o };
  if ((o.domain != null && o.domain !== cur.domain) || (o.mode && o.mode !== cur.mode && ['transparent', 'off'].includes(o.mode))) next.rev = 0;
  // 還沒改過的 VLAN 變更照樣要算進 revision：指紋只在第一次建立時記下
  if (cur.sig == null) next.sig = vtpSig(d);
  delete next.from; delete next.at;
  if (next.mode === 'server' && !next.domain && !next.pass && +next.ver === 1 && !next.rev) delete d.sw.vtp;
  else d.sw.vtp = next;
}

/** 在 Trunk 協商好之後、STP 之前呼叫：revision 的變化與網域內的同步 */
export function prepVtp(state) {
  const sws = Object.values(state.devices).filter((d) => vtpCapable(d) && !(state.down || {})[d.id] && !(state.rt.off || {})[d.id]);
  // 1. server 自己改了 VLAN：revision 加一
  for (const d of sws) {
    d.rt.vtp = { err: '', peers: [] };
    const v = d.sw.vtp;
    if (!v) continue;
    const sig = vtpSig(d);
    if (v.sig == null) v.sig = sig;
    else if (v.sig !== sig) {
      if ((v.mode || 'server') === 'server') { v.rev = (v.rev || 0) + 1; v.from = d.id; v.at = state.clock; }
      v.sig = sig;
    }
  }
  // 2. Trunk 上的鄰居（通告只在 Trunk 上送）
  const nb = new Map(sws.map((d) => [d.id, []]));
  for (const d of sws) {
    for (const pid of Object.keys(d.sw.ports)) {
      const l = state.rt.links[d.id + ':' + pid];
      if (!l || !nb.has(l.dev) || !isTrunk(d, pid)) continue;
      const p = state.devices[l.dev];
      if (!isTrunk(p, l.port)) continue;
      nb.get(d.id).push(p);
      d.rt.vtp.peers.push({ dev: p.id, port: pid });
    }
  }
  // 3. 通告能傳到哪裡：server / client / transparent 都會轉送，off 不轉送
  const relays = (d) => vtpOf(d).mode !== 'off';
  const reach = (d) => {
    const seen = new Set([d.id]), q = [d], out = [];
    while (q.length) {
      const x = q.shift();
      if (x !== d && !relays(x)) continue;
      for (const y of nb.get(x.id) || []) if (!seen.has(y.id)) { seen.add(y.id); out.push(y); q.push(y); }
    }
    return out;
  };
  const takes = (d) => ['server', 'client'].includes(vtpOf(d).mode);
  // 網域名稱空白的交換器：用收到的第一個通告的網域
  for (const d of sws) {
    if (!takes(d) || vtpOf(d).domain) continue;
    const first = reach(d).find((y) => takes(y) && vtpOf(y).domain);
    if (first) set(d, { domain: vtpOf(first).domain, sig: vtpSig(d) });
  }
  // 4. 同一個網域、通告傳得到的交換器：revision 最大的那一份蓋過其他的
  for (const d of sws) {
    if (!takes(d)) continue;
    const me = vtpOf(d);
    if (!me.domain) continue;
    d.rt.vtp.domain = me.domain;
    const others = reach(d).filter((y) => takes(y) && vtpOf(y).domain === me.domain);
    const bad = others.find((y) => (vtpOf(y).pass || '') !== (me.pass || ''));
    if (bad) d.rt.vtp.err = `${bad.name} 的 VTP 密碼不一樣：通告的 MD5 摘要對不起來，彼此不會同步`;
    const same = others.filter((y) => (vtpOf(y).pass || '') === (me.pass || ''));
    const src = same.reduce((a, y) => (vtpOf(y).rev > vtpOf(a).rev ? y : a), d);
    if (src === d || vtpOf(src).rev <= me.rev) continue;
    // 整份取代：一般範圍的 VLAN 換成通告的內容，擴充範圍的留著
    const keep = d.sw.vlans.filter((v) => !normal(v));
    d.sw.vlans = [...JSON.parse(JSON.stringify(src.sw.vlans.filter(normal))), ...keep].sort((a, b) => a.id - b.id);
    if (!d.sw.vlans.some((v) => v.id === 1)) d.sw.vlans.unshift({ id: 1, name: 'default' });
    const sv = vtpOf(src);
    set(d, { rev: sv.rev, sig: vtpSig(d), from: sv.from || src.id, at: sv.at ?? state.clock });
  }
}

/** show vtp status */
export function vtpStatusLines(state, d, mac) {
  const v = vtpOf(d), r = (d.rt && d.rt.vtp) || {};
  const by = v.from && state.devices[v.from];
  const byIp = by && (by.ifaces || []).map((i) => i.rt && i.rt.ip).find((x) => x != null);
  const ip = (x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');
  const mode = { server: 'Server', client: 'Client', transparent: 'Transparent', off: 'Off' }[v.mode];
  return [
    'VTP Version capable             : 1 to 3',
    `VTP version running             : ${v.ver}`,
    `VTP Domain Name                 : ${v.domain}`,
    'VTP Pruning Mode                : Disabled',
    'VTP Traps Generation            : Disabled',
    `Device ID                       : ${mac}`,
    v.mode === 'transparent' || v.mode === 'off' ? 'Configuration last modified by 0.0.0.0 at 0-0-00 00:00:00'
      : `Configuration last modified by ${byIp != null ? ip(byIp) : '0.0.0.0'} at ${v.rev ? '3-1-93 00:12:01' : '0-0-00 00:00:00'}${by && by !== d ? `（${by.name}）` : ''}`,
    '', 'Feature VLAN:', '--------------',
    `VTP Operating Mode                : ${mode}`,
    'Maximum VLANs supported locally   : 255',
    `Number of existing VLANs          : ${d.sw.vlans.length + 4}`,
    `Configuration Revision            : ${v.mode === 'transparent' || v.mode === 'off' ? 0 : v.rev}`,
    ...(r.err ? [`（${r.err}）`] : []),
  ];
}
