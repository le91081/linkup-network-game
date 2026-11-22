// IOS 的 debug ip ospf adj / hello、debug crypto isakmp / ikev2 / ipsec
// 這些 debug 開著的時候，每過一個 Hello 間隔（或 IKE 的重送間隔），就把鄰居 / 通道現在卡在哪裡用 IOS 的格式印出來：
// 和 debug ip packet 一樣進紀錄緩衝區、出現在 console（SSH 要 terminal monitor）
// state.dyn.dbg[設備] = { packet, icmp, ospfAdj, ospfHello, isakmp, ikev2, ipsec }
// state.dyn.dbgSeen[設備][訊息的鍵] = { t: 上次印的時間, n: 印了幾次 }
import { fmtIp, maskOf } from './ip.js';
import { debugLog, logEvent, longIf } from './ops.js';
import { isIos } from './ios.js';

export const DEBUG_KINDS = {
  packet: 'IP packet debugging is',
  icmp: 'ICMP packet debugging is',
  ospfAdj: 'OSPF adjacency debugging is',
  ospfHello: 'OSPF hello debugging is',
  isakmp: 'Crypto ISAKMP debugging is',
  ikev2: 'IKEv2 default debugging is',
  ipsec: 'Crypto IPSEC debugging is',
  dhcpPkt: 'DHCP server packet debugging is',
  dhcpEv: 'DHCP server event debugging is',
};

const ridTxt = (r) => (r != null ? fmtIp(r) : '0.0.0.0');
const areaDot = (a) => fmtIp(+a >>> 0);
const maskTxt = (b) => fmtIp(maskOf(b));
const AUTH_N = { none: 0, plain: 1, md5: 2 };

/** 同一則訊息每 period 秒最多印一次；真的設備每收到一個 Hello、每重送一次就印一次 */
function emit(state, d, key, period, lines) {
  const seen = ((state.dyn.dbgSeen ||= {})[d.id] ||= {});
  const x = seen[key];
  if (x && state.clock - x.t < period) return 0;
  const n = x ? x.n + 1 : 1;
  seen[key] = { t: state.clock, n };
  for (const l of typeof lines === 'function' ? lines(n) : lines) debugLog(state, d, l);
  return n;
}

/** OSPF 鄰居建不起來的原因 → IOS 15 的 debug 訊息（R = 收到的，C = 自己設定的） */
function ospfLines(lbl, b, f) {
  const ip = fmtIp(b.ip), rid = ridTxt(b.rid), w = b.why, out = [];
  const rcv = `OSPF-1 HELLO ${lbl}: Rcv hello from ${rid} area ${b.oArea} ${ip}`;
  if (/區域種類不一致|選項位元/.test(w)) { if (f.ospfHello) out.push(rcv, `OSPF-1 HELLO ${lbl}: Hello from ${ip} with mismatched Stub/Transit area option bit`); }
  else if (/區域不一致/.test(w)) { if (f.ospfAdj || f.ospfHello) out.push(`OSPF-1 ADJ   ${lbl}: Rcv pkt from ${ip}, area ${areaDot(b.area)}, mismatched area ${areaDot(b.oArea)} in the header`); }
  else if (/子網路遮罩|Hello \/ Dead/.test(w)) {
    if (f.ospfHello) out.push(rcv, `OSPF-1 HELLO ${lbl}: Mismatched hello parameters from ${ip}`, `OSPF-1 HELLO ${lbl}: Dead R ${b.oDead} C ${b.dead}, Hello R ${b.oHello} C ${b.hello} Mask R ${maskTxt(b.oBits)} C ${maskTxt(b.bits)}`);
  } else if (/驗證方式不一致/.test(w)) { if (f.ospfAdj) out.push(`OSPF-1 ADJ   ${lbl}: Rcv pkt from ${ip} : Mismatched Authentication type. Input packet specified type ${AUTH_N[b.oAuth] ?? 0}, we use type ${AUTH_N[b.auth] ?? 0}`); }
  else if (/金鑰不一致/.test(w)) { if (f.ospfAdj) out.push(`OSPF-1 ADJ   ${lbl}: Rcv pkt from ${ip} : Mismatched Authentication Key - ${b.auth === 'md5' ? 'Message Digest Key ' + (b.keyId || 1) : 'Clear Text'}`); }
  // 單向：聽得到對方、對方卻聽不到自己（Hello 裡的鄰居清單沒有自己的 Router ID），停在 INIT
  else if (/Hello 送不|Hello 送不過來/.test(w)) { if (f.ospfHello && (b.first ? /只收得到/.test(w) : /送不過來/.test(w))) out.push(rcv); }
  else if (/point-to-point/.test(w)) { if (f.ospfAdj) out.push(`OSPF-1 ADJ   ${lbl}: Neighbor change event`, `OSPF-1 ADJ   ${lbl}: Nbr ${rid}: Adjacency forced to reset`); }
  return out;
}

function ospfTick(state, d, f) {
  for (const [k, o] of Object.entries(d.rt)) {
    if (!/^ospf(@|$)/.test(k) || !o || !o.ifs) continue;
    for (const [ifId, inf] of Object.entries(o.ifs)) {
      const i = d.ifaces.find((x) => x.id === ifId), lbl = i ? i.label : ifId;
      for (const b of inf.bad || []) {
        const lines = ospfLines(lbl, b, f);
        if (lines.length) emit(state, d, `ospf|${ifId}|${b.dev}|${b.why}`, inf.hello || 10, lines);
      }
    }
  }
  if (!f.ospfAdj) return;
  // 卡在 EXSTART：兩端的介面 MTU 不一樣，DBD 一直重送
  for (const [k, nbrs] of Object.entries(d.rt)) {
    if (!/^nbrs(@|$)/.test(k) || !Array.isArray(nbrs)) continue;
    for (const n of nbrs) {
      if (n.state !== 'exstart') continue;
      const i = d.ifaces.find((x) => x.id === n.iface), lbl = i ? i.label : n.iface, r = ridTxt(n.rid);
      const m = /這一端 (\d+)，對面 (\d+)/.exec(n.note || '');
      const seq = '0x' + ((((n.rid >>> 0) % 0xffff) + 0x1000) >>> 0).toString(16).toUpperCase();
      emit(state, d, `exstart|${n.iface}|${n.dev}`, 5, (cnt) => [
        `OSPF-1 ADJ   ${lbl}: Rcv DBD from ${r} seq ${seq} opt 0x52 flag 0x7 len 32  mtu ${m ? m[2] : 1500} state EXSTART`,
        ...(m && +m[2] > +m[1] ? [`OSPF-1 ADJ   ${lbl}: Nbr ${r} has larger interface MTU`] : []),
        `OSPF-1 ADJ   ${lbl}: Retransmitting DBD to ${r} [${cnt}]`,
      ]);
    }
  }
}

/** 通道建不起來的原因 → debug crypto isakmp（IKEv1）/ debug crypto ikev2 / debug crypto ipsec */
function ikeLines(T, ver, f) {
  const w = T.why, peer = fmtIp(T.peerIp), me = T.localIp != null ? fmtIp(T.localIp) : '0.0.0.0', out = [];
  const v2 = ver === 2, sess = `IKEv2:(SESSION ID = 1,SA ID = 1)`;
  const pkt = (dir, ex, extra = '') => `${sess}:${dir === 'tx' ? `Sending Packet [To ${peer}:500/From ${me}:500/VRF i0:f0]` : `Received Packet [From ${peer}:500/To ${me}:500/VRF i0:f0]`}`
    + `\nInitiator SPI : 6B2E8A31C2D05F17 - Responder SPI : ${dir === 'tx' && ex === 'IKE_SA_INIT' ? '0000000000000000' : '9F04D7A2E1B3C845'} Message id: ${ex === 'IKE_SA_INIT' ? 0 : 1}\nIKEv2 ${ex} Exchange ${dir === 'tx' ? 'REQUEST' : 'RESPONSE'}${extra}`;
  const p1 = /協商中/.test(w);
  if (!v2 && f.isakmp) {
    if (/沒有回應|到不了對端|沒有通往對端|沒有指向|那一端的通道已停用|IKE 版本/.test(w)) {
      if (/沒有通往對端/.test(w)) out.push(`ISAKMP:(0):Can not start Aggressive mode, trying Main mode.`, `ISAKMP:(0): no outgoing route to ${peer}`);
      else out.push(`ISAKMP:(0): beginning Main Mode exchange`, `ISAKMP:(0): sending packet to ${peer} my_port 500 peer_port 500 (I) MM_NO_STATE`, `ISAKMP:(0):Sending an IKE IPv4 Packet.`, `ISAKMP (0): retransmitting phase 1 MM_NO_STATE...`, `ISAKMP (0): incrementing error counter on sa, attempt 1 of 5: retransmit phase 1`);
    } else if (/預先共用金鑰|PSK/.test(w) && /沒有給|尚未設定|keyring/.test(w)) out.push(`ISAKMP:(0):No pre-shared key with ${peer}!`, `ISAKMP : Scanning profiles for xauth ...`, `ISAKMP:(0): phase 1 SA policy not acceptable! (local ${me} remote ${peer})`);
    else if (/PSK.*不一致/.test(w)) out.push(`ISAKMP (1001): received packet from ${peer} dport 500 sport 500 Global (I) MM_KEY_EXCH`, `%CRYPTO-4-IKMP_BAD_MESSAGE: IKE message from ${peer} failed its sanity check or is malformed`, `ISAKMP:(1001): retransmitting phase 1 MM_KEY_EXCH...`);
    else if (/第一階段的加密提案/.test(w)) out.push(`ISAKMP:(0):Checking ISAKMP transform 1 against priority 10 policy`, `ISAKMP:(0):atts are not acceptable. Next payload is 0`, `ISAKMP:(0):no offers accepted!`, `ISAKMP:(0): phase 1 SA policy not acceptable! (local ${me} remote ${peer})`, `%CRYPTO-6-IKMP_MODE_FAILURE: Processing of Main mode failed with peer at ${peer}`);
    else if (/UDP 4500/.test(w)) out.push(`ISAKMP:(1001): NAT found, the node outside NAT`, `ISAKMP:(1001): sending packet to ${peer} my_port 4500 peer_port 4500 (I) MM_KEY_EXCH`, `ISAKMP (1001): retransmitting phase 1 MM_KEY_EXCH...`);
    else if (/第二階段|proxy ID|網段沒有互相對應/.test(w)) out.push(`ISAKMP:(1001): processing SA payload. message ID = 2836471`, `ISAKMP:(1001): IPSec policy invalidated proposal with error ${/proxy|網段/.test(w) ? 32 : 256}`, `ISAKMP:(1001): phase 2 SA policy not acceptable! (local ${me} remote ${peer})`, `ISAKMP: set new node 2836471 to QM_IDLE`);
    else if (p1) out.push(`ISAKMP:(0): beginning Main Mode exchange`, `ISAKMP:(0):Old State = IKE_READY  New State = IKE_I_MM1`, `ISAKMP:(1001):Old State = IKE_I_MM4  New State = IKE_I_MM5`, `ISAKMP:(1001):SA authentication status: authenticated`, `ISAKMP:(1001):Old State = IKE_I_MM6  New State = IKE_P1_COMPLETE`, `ISAKMP:(1001):beginning Quick Mode exchange, M-ID of 2836471`);
  }
  if (v2 && f.ikev2) {
    if (/沒有回應|到不了對端|沒有通往對端|沒有指向|那一端的通道已停用|IKE 版本/.test(w)) out.push(pkt('tx', 'IKE_SA_INIT', '\nPayload contents:\n SA KE N VID VID NOTIFY(NAT_DETECTION_SOURCE_IP) NOTIFY(NAT_DETECTION_DESTINATION_IP)'), `${sess}:Retransmitting packet`);
    else if (/AUTHENTICATION_FAILED/.test(w)) out.push(pkt('rx', 'IKE_AUTH', '\nPayload contents:\n NOTIFY(AUTHENTICATION_FAILED)'), `${sess}:Auth exchange failed`, `%IKEV2-5-SA_DOWN: Bad SA ${me}:500 ${peer}:500`);
    else if (/IKE_SA_INIT.*加密提案/.test(w)) out.push(pkt('rx', 'IKE_SA_INIT', '\nPayload contents:\n NOTIFY(NO_PROPOSAL_CHOSEN)'), `${sess}:Received no proposal chosen notify`, `${sess}:Failed SA init exchange`);
    else if (/CHILD_SA|proxy ID|網段沒有互相對應|找不到可用的 profile|沒有指定 keyring|keyring/.test(w)) {
      if (/profile/.test(w) && !/CHILD_SA/.test(w)) out.push(`${sess}:Failed to locate an item in the database`, `${sess}:Verification of peer's authentication data FAILED`);
      else out.push(pkt('rx', 'IKE_AUTH', `\nPayload contents:\n IDr AUTH NOTIFY(${/proxy|網段/.test(w) ? 'TS_UNACCEPTABLE' : 'NO_PROPOSAL_CHOSEN'})`), `${sess}:Processing IKE_AUTH message`, `${sess}:Create child SA failed`);
    } else if (p1) out.push(pkt('tx', 'IKE_SA_INIT'), pkt('rx', 'IKE_SA_INIT'), `${sess}:Sending Packet [To ${peer}:500/From ${me}:500/VRF i0:f0] IKE_AUTH Exchange REQUEST`);
  }
  if (f.ipsec && /第二階段|CHILD_SA|proxy ID|網段沒有互相對應/.test(w)) {
    const proxy = /proxy|網段/.test(w);
    out.push(`IPSEC(validate_proposal_request): proposal part #1`, `IPSEC(validate_proposal_request): proposal part #1,\n  (key eng. msg.) INBOUND local= ${me}:0, remote= ${peer}:0,\n    local_proxy= ${T.cfg && T.cfg.local ? T.cfg.local : '0.0.0.0/0'},\n    remote_proxy= ${T.cfg && T.cfg.remote ? T.cfg.remote : '0.0.0.0/0'}`,
      proxy ? `IPSEC(ipsec_process_proposal): proxy identities not supported` : `IPSEC(ipsec_process_proposal): transform proposal not supported for identity:\n    {esp-aes esp-sha-hmac }`);
  }
  return out;
}

function ikeTick(state, d, f) {
  for (const T of d.rt.tunnels || []) {
    if (!T.cfg || T.peerIp == null || T.up) continue;
    if (!T.why || /通道已停用$|尚未設定(對端|本地)/.test(T.why)) continue;
    const ver = (T.cfg.rt && T.cfg.rt.ver) || (T.cfg.ikev2 ? 2 : 1);
    const lines = ikeLines(T, ver, f);
    // 一行一則：多行的 IKEv2 封包內容拆開來印
    if (lines.length) emit(state, d, `ike|${T.name}|${T.why.replace(/[0-9]+/g, '#')}`, /協商中/.test(T.why) ? 1e9 : 10, (n) => lines.flatMap((l) => l.split('\n')).map((l) => l.replace('attempt 1 of 5', `attempt ${Math.min(n, 5)} of 5`)));
  }
}

// ── DHCP 伺服器：debug ip dhcp server packet / events ──
const hex12 = (mac) => String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
const dotted = (h) => (h.match(/.{1,4}/g) || []).join('.');
/** 用戶端識別碼：01（乙太網路）加上 MAC，IOS 用四個一組的寫法 */
const clientId = (mac) => dotted('01' + hex12(mac));

function dhcpTick(state) {
  const all = state.dyn.dbg || {};
  for (const e of state.rt.dhcpEv || []) {
    const d = state.devices[e.srv], f = all[e.srv];
    if (!d || !f || !(f.dhcpPkt || f.dhcpEv) || !isIos(d)) continue;
    const i = d.ifaces.find((x) => x.id === e.sif), lbl = longIf(i ? i.label : e.sif), id = clientId(e.mac), ip = fmtIp(e.ip);
    const lines = [];
    if (!e.renew) {
      if (f.dhcpPkt) lines.push(`DHCPD: DHCPDISCOVER received from client ${id} on interface ${lbl}.`);
      if (f.dhcpEv) lines.push('DHCPD: Seeing if there is an internally specified pool class:', `  DHCPD: htype 1 chaddr ${dotted(hex12(e.mac))}`, '  DHCPD: circuit id 00000000',
        `DHCPD: Adding binding to radix tree (${ip})`, `DHCPD: assigned IP address ${ip} to client ${id}.`);
      if (f.dhcpPkt) lines.push(`DHCPD: Sending DHCPOFFER to client ${id} (${ip}).`, `DHCPD: broadcasting BOOTREPLY to client ${dotted(hex12(e.mac))}.`);
    }
    if (f.dhcpPkt) lines.push(`DHCPD: DHCPREQUEST received from client ${id}.`, `DHCPD: Sending DHCPACK to client ${id} (${ip}).`,
      e.renew ? `DHCPD: unicasting BOOTREPLY to client ${dotted(hex12(e.mac))} (${ip}).` : `DHCPD: broadcasting BOOTREPLY to client ${dotted(hex12(e.mac))}.`);
    if (lines.length) emit(state, d, `dhcp|${e.cli}/${e.cif}|${e.ip}|${state.clock}`, 1e9, lines);
  }
  // 一次性的訊息不用一直記著
  for (const seen of Object.values(state.dyn.dbgSeen || {})) for (const [k, x] of Object.entries(seen)) if (k.startsWith('dhcp|') && state.clock - x.t > 600) delete seen[k];
}

/** OSPF 偵測到 Router ID 重複：不用開 debug，IOS 本來就會記一筆（每個鄰居一分鐘最多一次） */
function dupRid(state, d) {
  for (const [k, o] of Object.entries(d.rt)) {
    if (!/^ospf(@|$)/.test(k) || !o || !o.ifs) continue;
    for (const [ifId, inf] of Object.entries(o.ifs)) {
      const i = d.ifaces.find((x) => x.id === ifId);
      for (const b of inf.bad || []) {
        if (!/Router ID 重複/.test(b.why)) continue;
        const seen = ((state.dyn.dbgSeen ||= {})[d.id] ||= {}), key = `dup|${ifId}|${b.dev}`;
        if (seen[key] && state.clock - seen[key].t < 60) continue;
        seen[key] = { t: state.clock, n: 1 };
        logEvent(state, d, 4, 'OSPF-4-DUP_RTRID_NBR', `OSPF detected duplicate router-id ${ridTxt(b.rid)} from ${fmtIp(b.ip)} on interface ${longIf(i ? i.label : ifId)}`);
      }
    }
  }
}

/** 每次重新計算之後（opsAfter）呼叫 */
export function debugTick(state) {
  const dyn = state.dyn;
  if (!dyn || dyn.boot) return;
  const all = dyn.dbg || {};
  for (const d of Object.values(state.devices)) {
    if (!d.rt || !d.mgmt || (state.down || {})[d.id] || (state.rt.off || {})[d.id]) continue;
    if (isIos(d)) dupRid(state, d);
    const f = all[d.id];
    if (!f) continue;
    if (f.ospfAdj || f.ospfHello) ospfTick(state, d, f);
    if (f.isakmp || f.ikev2 || f.ipsec) ikeTick(state, d, f);
  }
  dhcpTick(state);
  for (const id of Object.keys(dyn.dbgSeen || {})) if (!state.devices[id]) delete dyn.dbgSeen[id];
}
