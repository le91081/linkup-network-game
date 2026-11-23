// VPN 通道：IKE 的兩個階段、提案與金鑰比對、SA 的壽命與 DPD、封包要走哪一條通道
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { fmtIp, parseIp } from '../ip.js';
import { cidrList, selMatch } from './core.js';
import { findOwner } from './forward.js';
import { leaseFrom, lookupRoute } from './l3.js';
import { transact } from './transact.js';
import { isTun, protPeers, tunMode } from './gre.js';
import { tpOf, urlTarget, verifyPeer } from '../pki.js';
import { vpnLogin } from '../ldap.js';

// ───────────────────────────── VPN 通道 ─────────────────────────────

// IPsec 分兩個階段協商：第一階段 (IKE) 建立管理通道，第二階段 (IPsec SA) 才是真正加密資料的通道
export const P1 = (t) => `${(t.enc || 'aes128').toUpperCase()} / ${(t.hash || 'sha1').toUpperCase()} / DH ${t.dh || '2'}`;
export const P2 = (t) => `${(t.enc2 || t.enc || 'aes128').toUpperCase()} / ${(t.hash2 || t.hash || 'sha1').toUpperCase()}${t.pfs ? ' / PFS ' + t.pfs : ''}`;
// ── IKE 的版本 ──
// IKEv1：Main Mode 六個訊息 + Quick Mode 三個；IKEv2：IKE_SA_INIT 與 IKE_AUTH 四個訊息就建好 IKE SA 和第一個 CHILD_SA。
// IOS 用 crypto ikev2 proposal / policy / keyring / profile，再在 crypto map 裡 set ikev2-profile；
// FortiGate 與圖形介面是通道上的 ike: 2。IKEv2 的預先共用金鑰可以兩個方向不同（pskRemote、keyring 的 local / remote）
export const ikeVer = (d, t) => (t.ikev2 || +t.ike === 2 ? 2 : 1);
const IKE2_TIME = 1; // IKEv2 只要兩次來回
/** IOS 沒有設定 crypto ikev2 policy 時的預設提案（smart defaults，這裡簡化成 AES-CBC-128/256、SHA-1/256、DH 2/5/14/19） */
const IOS_V2_DEFAULT = ['aes256', 'aes128'].flatMap((e) => ['sha256', 'sha1'].flatMap((x) => ['19', '14', '5', '2'].map((g) => `${e.toUpperCase()} / ${x.toUpperCase()} / DH ${g}`)));
/** IOS 的 crypto map 用了 ikev2 profile：回傳 profile 與整台的 ikev2 物件 */
function v2obj(d, t) {
  const v = d.ikev2 || {};
  const prof = t.ikev2 && (v.profs || {})[t.ikev2];
  return prof ? { prof, v } : null;
}
/** 這一端送出去的金鑰 (loc) 與用來驗證對方的金鑰 (rem)。IKEv1 兩個一樣 */
export function pskOf(d, t) {
  const o = v2obj(d, t);
  if (o) {
    const kr = (o.v.krs || {})[o.prof.keyring];
    const peer = kr && (Object.values(kr.peers || {}).find((x) => x.address === t.peer) || Object.values(kr.peers || {}).find((x) => x.address === '0.0.0.0'));
    if (!peer) return { loc: '', rem: '', why: o.prof.keyring ? `keyring ${o.prof.keyring} 裡沒有對端 ${t.peer} 的金鑰` : `ikev2 profile ${t.ikev2} 沒有指定 keyring` };
    return { loc: peer.pskLocal || peer.psk || '', rem: peer.pskRemote || peer.psk || '' };
  }
  return { loc: t.psk || '', rem: (ikeVer(d, t) === 2 && t.pskRemote) || t.psk || '' };
}
const pfsText = (t) => (t.pfsList && t.pfsList.length ? 'DH ' + t.pfsList.join(' / ') : t.pfs ? 'DH ' + t.pfs : '不使用');
/**
 * 一台設備願意接受的提案。IOS 的 crypto isakmp policy 是整台共用、可以有好幾組；
 * FortiGate 每個通道可以列出好幾組提案與 DH 群組（用 CLI 設定時存在 props / dhs）。兩端只要有一組相同就能談成。
 */
const p1set = (d, t) => {
  const o = v2obj(d, t);
  if (o) {
    // IOS 的 IKEv2：所有 policy 引用的 proposal；沒有 policy 就用預設提案
    const pols = Object.values(o.v.pols || {});
    if (!pols.length) return IOS_V2_DEFAULT;
    return [...new Set(pols.flatMap((x) => x.props.flatMap((n) => {
      const pr = (o.v.props || {})[n];
      return pr ? pr.encs.flatMap((e) => pr.hashes.flatMap((hh) => pr.dhs.map((g) => `${e.toUpperCase()} / ${hh.toUpperCase()} / DH ${g}`))) : [];
    })))];
  }
  if (ikeVer(d, t) === 1 && d.isakmp && d.isakmp.length) return d.isakmp.map(P1);
  const props = t.props && t.props.length ? t.props.map((x) => x.split('-')) : [[t.enc || 'aes128', t.hash || 'sha1']];
  const dhs = t.dhs && t.dhs.length ? t.dhs : [t.dh || '2'];
  return props.flatMap(([e, h]) => dhs.map((g) => `${e.toUpperCase()} / ${h.toUpperCase()} / DH ${g}`));
};
const p2set = (t) => {
  const props = t.props2 && t.props2.length ? t.props2.map((x) => x.split('-')) : [[t.enc2 || t.enc || 'aes128', t.hash2 || t.hash || 'sha1']];
  const pfs = t.pfsList && t.pfsList.length ? t.pfsList : [t.pfs || ''];
  return props.flatMap(([e, h]) => pfs.map((g) => `${e.toUpperCase()} / ${h.toUpperCase()}${g ? ' / PFS ' + g : ''}`));
};
/** IKEv2 的提案比對：先不看 PFS（第一個 CHILD_SA 不做 DH） */
const strip6 = (xs) => [...new Set(xs.map((x) => x.replace(/ \/ PFS \d+$/, '')))];
/** IKEv1：兩端同一把金鑰；IKEv2：A 送出的要等於 B 用來驗證的，反過來也一樣 */
/** 這一端證明自己用什麼方法：IKEv2 的 profile 可以是 rsa-sig（憑證），其他都是預先共用金鑰 */
const authL = (d, t) => { const o = v2obj(d, t); return (o && o.prof.authL) || 'pre-share'; };
const authR = (d, t) => { const o = v2obj(d, t); return (o && o.prof.authR) || 'pre-share'; };
/** 需不需要預先共用金鑰：兩個方向都用憑證就不用 */
export const needsPsk = (d, t) => authL(d, t) === 'pre-share' || authR(d, t) === 'pre-share';
/**
 * IKEv2 的 IKE_AUTH：每一端用自己的 local 方法證明身分，對方依它的 profile（match identity、authentication remote）驗證。
 * 只有用到憑證或 FQDN 身分時才走這裡；回傳 null（通過）或 { why, log, at }（log 是驗證失敗那一端記的 PKI 訊息）
 */
function certAuth(state, A, ta, B, tb, ipA, ipB) {
  const pa = (v2obj(A, ta) || {}).prof || {}, pb = (v2obj(B, tb) || {}).prof || {};
  const fancy = (p) => p.authL === 'rsa-sig' || p.authR === 'rsa-sig' || p.idFqdn || p.remoteFqdn || p.remoteAny;
  if (!fancy(pa) && !fancy(pb)) return undefined; // 傳統的預先共用金鑰：沿用原本的檢查
  for (const [x, px, tx, ipx, y, py, ty] of [[A, pa, ta, ipA, B, pb, tb], [B, pb, tb, ipB, A, pa, ta]]) {
    // 對方要找得到符合這個身分的 profile
    const id = px.idFqdn ? { t: 'fqdn', v: px.idFqdn } : { t: 'address', v: ipx };
    const idTxt = id.t === 'fqdn' ? `FQDN ${id.v}` : `位址 ${fmtIp(id.v)}`;
    if (py.remoteFqdn && !(id.t === 'fqdn' && (id.v === py.remoteFqdn || id.v.endsWith('.' + py.remoteFqdn)))) return { why: `${y.name} 找不到符合的 ikev2 profile：${x.name} 的身分是 ${idTxt}，profile 要的是 match identity remote fqdn domain ${py.remoteFqdn}${id.t === 'address' ? `（${x.name} 要 identity local fqdn <名稱>）` : ''}`, log: 'IKEv2:% IKEv2 profile not found', at: y.id };
    if (py.remote && !py.remoteFqdn && !(id.t === 'address' && id.v === parseIp(py.remote))) return { why: `${y.name} 找不到符合的 ikev2 profile：${x.name} 的身分是 ${idTxt}，profile 要的是 match identity remote address ${py.remote}`, log: 'IKEv2:% IKEv2 profile not found', at: y.id };
    const mine = px.authL || 'pre-share', theirs = py.authR || 'pre-share';
    if (mine !== theirs) return { why: `IKEv2 驗證失敗 (AUTHENTICATION_FAILED)：${x.name} 用 ${mine} 證明自己（authentication local ${mine}），${y.name} 卻要用 ${theirs} 驗證它（authentication remote ${theirs}）` };
    if (mine === 'pre-share') {
      const a = pskOf(x, tx), b = pskOf(y, ty);
      if (!a.loc || a.loc !== b.rem) return { why: `IKEv2 驗證失敗 (AUTHENTICATION_FAILED)：${x.name} 用來簽的金鑰，和 ${y.name} 用來驗證它的金鑰不同` };
      continue;
    }
    const v = verifyPeer(state, x, px.tp, y, py.tp);
    if (v) return { why: `IKEv2 驗證失敗 (AUTHENTICATION_FAILED)：${v.why}`, log: v.log, at: y.id };
    // 撤銷檢查：IOS 的 trustpoint 預設 revocation-check crl，要連得到 CA 拿 CRL（crl none 是拿不到就算了）
    const tpy = tpOf(y, py.tp);
    if (tpy && (tpy.revoke || 'crl') === 'crl') {
      const tgt = urlTarget(tpy.url), r = tgt && transact(state, y.id, { proto: 'tcp', dst: tgt.ip, dport: tgt.port, quiet: true });
      if (!r || !r.ok) return { why: `IKEv2 驗證失敗 (AUTHENTICATION_FAILED)：${y.name} 的 trustpoint ${py.tp} 要檢查撤銷清單（revocation-check crl，IOS 的預設），可是連不到 CA${tgt ? ' ' + fmtIp(tgt.ip) : ''} 拿不到 CRL${r && r.reason ? '（' + r.reason + '）' : ''}。CA 在通道的另一邊時，改成 revocation-check crl none 或 none`, log: `%PKI-3-CRL_FETCH_FAIL: CRL fetch for trustpoint ${py.tp} failed`, at: y.id };
    }
  }
  return null;
}
function pskMatch(da, ta, db, tb) {
  const a = pskOf(da, ta), b = pskOf(db, tb);
  return ikeVer(da, ta) === 1 ? a.loc === b.loc : a.loc === b.rem && a.rem === b.loc;
}
const sameSel = (a, b) => a.length === b.length && a.every((x) => b.some((y) => y.net === x.net && y.bits === x.bits));

// ── IPsec 的時間面 ──
export const IKE_TIME = 2; // 兩個階段協商完成大約要這麼久
/** 第一階段 (IKE SA) 的壽命，預設一天。IOS 的 isakmp policy 整台共用 */
const life1Of = (d, t) => (d.isakmp && d.isakmp.length ? Math.min(...d.isakmp.map((p) => +p.life || 86400)) : +t.life1 || 86400);
/** 第二階段 (IPsec SA) 的壽命：IOS 預設一小時，FortiGate 預設十二小時 */
const life2Of = (d, t) => +t.life2 || +d.ipsecLife || (d.kind === 'firewall' ? 43200 : 3600);
/**
 * 對端失聯之後多久才會發現 (Dead Peer Detection)。回傳 null 代表沒有這個機制，只能等 SA 到期。
 * FortiGate 預設開啟：每 20 秒探測一次、三次沒回應就判定失聯。IOS 要自己設定 crypto isakmp keepalive。
 */
function dpdTime(d, t) {
  if (d.kind === 'firewall') return t.dpd === 'disable' ? null : (+t.dpdRetry || 3) * (+t.dpdInterval || 20);
  const k = d.ikeKeepalive;
  return k && +k.sec > 0 ? +k.sec + 5 * (+k.retry || 2) : null;
}

function tunnelTimers(state, all) {
  const sa = state.dyn.sa, now = state.clock, down = state.down || {}, live = new Set();
  for (const T of all) {
    const d = state.devices[T.dev], key = T.dev + '/' + T.name;
    if (down[T.dev] || state.rt.off[T.dev]) continue; // 設備關機：SA 跟著消失
    let rec = sa[key];
    if (!T.why) {
      const pd = state.devices[T.peer.dev];
      const sig = JSON.stringify([T.peerIp, T.localIp, pskOf(d, T.cfg), ikeVer(d, T.cfg), T.cfg.local, T.cfg.remote, p1set(d, T.cfg), p2set(T.cfg)]);
      // 第一次建立、設定改過、或對端曾經失聯：重新協商
      if (!rec || rec.sig !== sig || rec.lost != null) rec = sa[key] = { sig, since: state.dyn.boot ? -1e9 : now, tx: 0, rx: 0, r1: 0, r2: 0 };
      live.add(key);
      rec.life1 = Math.min(life1Of(d, T.cfg), life1Of(pd, T.peer.cfg));
      rec.life2 = Math.min(life2Of(d, T.cfg), life2Of(pd, T.peer.cfg));
      const v2 = ikeVer(d, T.cfg) === 2;
      const ready = rec.since + (v2 ? IKE2_TIME : IKE_TIME);
      if (now < ready) {
        T.nego = ready - now;
        T.why = `${v2 ? 'IKEv2' : 'IKE'} 協商中，再 ${Math.ceil(T.nego)} 秒建立`;
        state.rt.pending.push({ at: ready, dev: d.id, kind: 'vpn', text: `${d.name}：VPN 通道「${T.name}」協商中 (${v2 ? 'IKEv2' : 'IKE'})` });
        continue;
      }
      if (rec.t1 == null) rec.t1 = rec.t2 = state.dyn.boot ? now : ready;
      // IKEv2 的第一個 CHILD_SA 是在 IKE_AUTH 裡順便建立的，不做 PFS 的 DH 交換：兩端 PFS 不同，一開始照樣通，
      // 到了第一次重新協商 (CREATE_CHILD_SA，要交換 DH) 才失敗，通道就斷了
      if (T.pfsBad && now >= rec.t2 + rec.life2) {
        rec.up = false;
        T.why = `IKEv2 的 CHILD_SA 重新協商失敗 (NO_PROPOSAL_CHOSEN)：${T.pfsBad}。第一個 CHILD_SA 在 IKE_AUTH 裡建立、不做 PFS，所以一開始通得了；第一次重新協商時才失敗`;
        continue;
      }
      if (T.pfsBad) T.rekeyFail = rec.t2 + rec.life2;
      // 金鑰到期就重新協商。新的 SA 先建好才換過去，流量不會中斷
      while (now >= rec.t1 + rec.life1) { rec.t1 += rec.life1; rec.r1++; }
      while (now >= rec.t2 + rec.life2) { rec.t2 += rec.life2; rec.r2++; }
      rec.up = true;
    } else if (rec && rec.up && T.dead) {
      // 對端突然失聯：手上的 SA 還在，封包照樣加密送出去。要等 DPD 探測失敗（或 SA 到期）才會把通道拆掉
      if (rec.lost == null) rec.lost = now;
      const dpd = dpdTime(d, T.cfg);
      const until = dpd != null ? rec.lost + dpd : rec.t2 + rec.life2;
      if (now >= until) continue;
      live.add(key);
      T.stale = { until, why: T.why, dpd: dpd != null };
      T.why = '';
      state.rt.pending.push({ at: until, dev: d.id, kind: 'vpn', text: `${d.name}：還沒發現 VPN 通道「${T.name}」的對端已經失聯（${dpd != null ? 'DPD 探測中' : '沒有設定 keepalive，要等 SA 到期'}）` });
    }
  }
  for (const k of Object.keys(sa)) if (!live.has(k)) delete sa[k];
}

/** 站對站通道目前的 SA：剩餘壽命、重新協商的次數、加解密的封包數。還沒建立就回傳 null */
export function saInfo(state, devId, name) {
  const r = state.dyn && state.dyn.sa && state.dyn.sa[devId + '/' + name];
  if (!r || !r.up) return null;
  const now = state.clock;
  return {
    life1: r.life1, life2: r.life2, left1: Math.ceil(r.t1 + r.life1 - now), left2: Math.ceil(r.t2 + r.life2 - now),
    rekey1: r.r1, rekey2: r.r2, tx: r.tx, rx: r.rx, age: Math.floor(now - r.t2), lost: r.lost != null ? Math.floor(now - r.lost) : null,
  };
}
const tunIface = (id, label) => ({ id, label, bind: { t: 'tun' }, rt: { ip: null, vips: [], link: true }, nat: false });

/** NAT-T：IOS 預設開啟（no crypto ipsec nat-transparency udp-encapsulation 關掉），FortiGate 預設也開 */
const nattOn = (d) => !d.noNatT;
/** crypto isakmp key：先找對端的位址，沒有就用萬用的 0.0.0.0（DMVPN 的 spoke 之間要靠它） */
const ikeKey = (d, peer) => ((d.ikeKeys || {})[peer] ?? (d.ikeKeys || {})['0.0.0.0'] ?? '');
/**
 * Tunnel 介面上的 tunnel protection ipsec profile：把 profile 換算成和 crypto map 一樣的通道設定。
 * GRE 的 proxy ID 是「gre host 本端 host 對端」，VTI（tunnel mode ipsec ipv4）是 0.0.0.0/0 ↔ 0.0.0.0/0
 */
function protT(d, i, peerIp, responder) {
  const prof = (d.ipsecProfiles || {})[i.tun.prot] || {};
  const ts = (d.tsets || {})[prof.tset] || {};
  const vti = tunMode(i) === 'ipsec', peer = fmtIp(peerIp), src = i.rt.tun.src;
  const name = tunMode(i) === 'mgre' ? `${i.label}-${peer}` : i.label;
  const cfg = {
    name, peer, psk: ikeKey(d, peer), ...(prof.ikev2 ? { ikev2: prof.ikev2 } : {}),
    ...(ts.enc2 ? { enc2: ts.enc2, hash2: ts.hash2 } : {}), pfs: prof.pfs || '', ...(prof.life2 ? { life2: prof.life2 } : {}),
    local: vti ? '0.0.0.0/0' : `${fmtIp(src)}/32`, remote: vti ? '0.0.0.0/0' : `${peer}/32`, prot: i.tun.prot, tif: i.id,
  };
  const T = {
    name, cfg, dev: d.id, up: false, why: '', local: cidrList(cfg.local), remote: cidrList(cfg.remote),
    iface: vti ? i : tunIface('vpn:' + name, `IPsec ${i.label}`), peerIp, localIp: src, tif: i.id, prot: true, responder: !!responder,
    ...(vti ? { vti: true } : { proto: tunMode(i) === 'ipv6ip' ? 'ipv6ip' : 'gre' }),
  };
  if (prof.tset && !(d.tsets || {})[prof.tset]) T.why = `IPsec profile ${i.tun.prot} 用的 transform-set ${prof.tset} 不存在`;
  else if (prof.ikev2 && !v2obj(d, cfg)) T.why = `IPsec profile ${i.tun.prot} 指定的 ikev2 profile「${prof.ikev2}」不存在`;
  else if (needsPsk(d, cfg) && !pskOf(d, cfg).loc) T.why = pskOf(d, cfg).why || `沒有給 ${peer} 的預先共用金鑰（crypto isakmp key <金鑰> address ${peer}${tunMode(i) === 'mgre' ? '，DMVPN 的 spoke 之間要用 address 0.0.0.0' : ''}）`;
  return T;
}

export function prepTunnels(state) {
  const devs = Object.values(state.devices);
  const all = [];
  for (const d of devs) d.rt.tunnels = []; // 有 Tunnel 介面時這裡會跑兩次（外層的路由算好時、全部算好之後）
  for (const d of devs) {
    for (const t of d.vpns || []) {
      const name = t.name || 'VPN';
      const T = {
        name, cfg: t, dev: d.id, up: false, why: '', local: cidrList(t.local), remote: cidrList(t.remote),
        iface: tunIface('vpn:' + name, 'VPN ' + name), peerIp: parseIp(t.peer || ''), localIp: null,
      };
      d.rt.tunnels.push(T);
      all.push(T);
      if (t.off) T.why = t.offWhy || '通道已停用';
      else if (T.peerIp == null) T.why = '尚未設定對端的公用 IP';
      else if (!T.local.length || !T.remote.length) T.why = '尚未設定本地 / 遠端網段';
      else if (t.ikev2 && !v2obj(d, t)) T.why = `crypto map 指定的 ikev2 profile「${t.ikev2}」不存在`;
      else if (t.ikev2 && v2obj(d, t).prof.remote && v2obj(d, t).prof.remote !== '0.0.0.0' && v2obj(d, t).prof.remote !== t.peer) T.why = `ikev2 profile「${t.ikev2}」的 match identity remote address 是 ${v2obj(d, t).prof.remote}，和對端 ${t.peer} 不符：IKEv2 找不到可用的 profile`;
      else if (needsPsk(d, t) && !pskOf(d, t).loc) T.why = pskOf(d, t).why || '尚未設定預先共用金鑰 (PSK)';
      else {
        const r = lookupRoute(d, T.peerIp);
        if (!r) T.why = `沒有通往對端 ${fmtIp(T.peerIp)} 的路由`;
        else if (t.cmap && r.iface.cmap !== t.cmap) T.why = `crypto map ${t.cmap} 還沒有套用到對外的介面 ${r.iface.label}（在介面模式下輸入 crypto map ${t.cmap}）`;
        else T.localIp = r.iface.rt.ip;
      }
    }
  }
  // Tunnel 介面的 tunnel protection：點對點（GRE、VTI）兩端各自建；mGRE 的 spoke 主動找 hub 與解析到的 spoke，hub 被動接受
  for (const d of devs) for (const i of d.ifaces) {
    if (!isTun(i) || !i.tun || !i.tun.prot || !i.rt.tun || !i.rt.tun.base) continue;
    for (const ip of protPeers(state, d, i)) { const T = protT(d, i, ip); d.rt.tunnels.push(T); all.push(T); }
  }
  for (const T of all.slice()) {
    if (!T.prot || T.why) continue;
    const pd = findOwner(state, T.peerIp);
    if (!pd || all.some((x) => x.dev === pd.id && x.peerIp === T.localIp)) continue;
    const j = pd.ifaces.find((x) => isTun(x) && tunMode(x) === 'mgre' && x.tun.prot && x.rt.tun && x.rt.tun.base && x.rt.tun.src === T.peerIp);
    if (j) { const R = protT(pd, j, T.localIp, true); pd.rt.tunnels.push(R); all.push(R); }
  }
  // NAT 偵測（NAT-D）：這一端在 NAT 後面，IKE 從 UDP 500 出去之後，對端看到的來源位址就不是這一端自己的位址
  for (const T of all) {
    if (T.why || T.responder) continue;
    const pd = findOwner(state, T.peerIp);
    if (pd && all.some((x) => x.dev === pd.id && x.peerIp === T.localIp)) continue;
    const r = transact(state, T.dev, { proto: 'udp', dst: T.peerIp, dport: 500, sport: 500, quiet: true });
    if (r.ok && r.seenSrc != null && r.seenSrc !== T.localIp) {
      const by = findOwner(state, r.seenSrc);
      T.nat = { seen: r.seenSrc, by: by ? by.id : null, peerDev: r.responder };
    }
  }
  for (const T of all) {
    if (T.why) continue;
    let pd = findOwner(state, T.peerIp);
    let P = pd && (all.find((x) => x.dev === pd.id && x.peerIp === T.localIp && !!x.vti === !!T.vti) || all.find((x) => x.dev === pd.id && x.peerIp === T.localIp));
    // 這一端在 NAT 後面：對端的設定要指向 NAT 之後的位址
    if (!P && T.nat) { const Q = all.find((x) => x.dev === T.nat.peerDev && x.peerIp === T.nat.seen); if (Q) { P = Q; pd = state.devices[Q.dev]; } }
    // 對端在 NAT 後面：設定的對端位址是那台 NAT 設備的公用位址，真正的對端由它主動來連
    let viaNat = null;
    if (!P) { const Q = all.find((x) => x.nat && x.nat.seen === T.peerIp && x.peerIp === T.localIp && x.nat.peerDev === T.dev); if (Q) { P = Q; pd = state.devices[Q.dev]; viaNat = Q.nat; } }
    const nat = T.nat || viaNat;
    if (!pd) { T.why = `對端 ${fmtIp(T.peerIp)} 沒有回應`; T.dead = true; }
    else if (!P && T.nat) T.why = `這一端在 NAT 後面：${pd.name} 看到的來源位址是 ${fmtIp(T.nat.seen)}（不是 ${fmtIp(T.localIp)}），它那一端的通道設定要指向 ${fmtIp(T.nat.seen)}`;
    else if (!P) T.why = `${pd.name} 上沒有指向 ${fmtIp(T.localIp)} 的通道設定`;
    else if (P.cfg.off) T.why = `${pd.name} 那一端的通道已停用`;
    else if (ikeVer(state.devices[T.dev], T.cfg) !== ikeVer(pd, P.cfg)) {
      const mine = ikeVer(state.devices[T.dev], T.cfg);
      T.why = `IKE 版本不一致（本端 IKEv${mine}，對端 IKEv${3 - mine}）— ${mine === 2 ? '對端只聽得懂 IKEv1 的 Main Mode，不回應 IKE_SA_INIT' : '對端送來的是 IKEv2 的 IKE_SA_INIT，這一端只跑 IKEv1'}，協商失敗`;
    } else if ((T.auth = certAuth(state, state.devices[T.dev], T.cfg, pd, P.cfg, T.localIp, T.peerIp))) {
      T.why = T.auth.why;
    } else if (T.auth === undefined && !pskMatch(state.devices[T.dev], T.cfg, pd, P.cfg)) {
      const v2 = ikeVer(pd, P.cfg) === 2, a = pskOf(state.devices[T.dev], T.cfg), b = pskOf(pd, P.cfg);
      T.why = !v2 ? '兩端的預先共用金鑰 (PSK) 不一致 — IKE 驗證失敗'
        : `IKEv2 驗證失敗 (AUTHENTICATION_FAILED)：${a.loc !== b.rem ? `這一端用來簽的金鑰，和 ${pd.name} 用來驗證它的金鑰不同` : `${pd.name} 用來簽的金鑰，和這一端用來驗證它的金鑰不同`}`;
    } else if (!p1set(state.devices[T.dev], T.cfg).some((x) => p1set(pd, P.cfg).includes(x))) {
      const v2 = ikeVer(pd, P.cfg) === 2;
      T.why = `${v2 ? 'IKE_SA_INIT' : '第一階段'}的加密提案不一致（本端 ${p1set(state.devices[T.dev], T.cfg).join('、')}，對端 ${p1set(pd, P.cfg).join('、')}）— ${v2 ? 'NO_PROPOSAL_CHOSEN' : 'IKE 協商失敗'}`;
    } else if (ikeVer(pd, P.cfg) === 2 && !strip6(p2set(T.cfg)).some((x) => strip6(p2set(P.cfg)).includes(x))) {
      T.why = `CHILD_SA 的加密提案不一致（本端 ${strip6(p2set(T.cfg)).join('、')}，對端 ${strip6(p2set(P.cfg)).join('、')}）— IKE SA 建好了，但 IPsec SA 建不起來 (NO_PROPOSAL_CHOSEN)`;
    } else if (ikeVer(pd, P.cfg) === 1 && !p2set(T.cfg).some((x) => p2set(P.cfg).includes(x))) T.why = `第二階段 (IPsec) 的加密提案不一致（本端 ${p2set(T.cfg).join('、')}，對端 ${p2set(P.cfg).join('、')}）— IKE 通過了，但資料通道建不起來`;
    else if (!!T.vti !== !!P.vti) T.why = `一端是 tunnel mode ipsec ipv4（VTI，proxy ID 是 0.0.0.0/0）、另一端是 GRE（proxy ID 是 gre host … host …）：IPsec 的 proxy ID 對不起來，第二階段建不起來`;
    else if (!sameSel(T.local, P.remote) || !sameSel(T.remote, P.local)) T.why = T.prot || P.prot ? `IPsec 的 proxy ID 對不起來（本端 ${T.cfg.local} → ${T.cfg.remote}，對端 ${P.cfg.local} → ${P.cfg.remote}）` : '兩端的本地 / 遠端網段沒有互相對應';
    else {
      // 對端在 NAT 後面時，IKE 由它主動發起（從外面連不進 NAT 裡面），這一端不用自己試
      const r = viaNat ? { ok: true } : transact(state, T.dev, { proto: 'udp', dst: T.peerIp, dport: 500, sport: 500, quiet: true });
      // NAT-T（RFC 3948）：偵測到 NAT，兩端都支援就改用 UDP 4500，把 ESP 包在 UDP 裡穿過 PAT
      const natT = nat && nattOn(state.devices[T.dev]) && nattOn(pd);
      const r2 = natT && !viaNat ? transact(state, T.dev, { proto: 'udp', dst: T.peerIp, dport: 4500, sport: 4500, quiet: true }) : { ok: true };
      if (!r.ok) { T.why = 'IKE 封包到不了對端：' + r.reason; T.dead = true; }
      else if (!r2.ok) { T.why = `偵測到 NAT（對端看到的來源是 ${fmtIp(nat.seen)}），IKE 改用 UDP 4500 (NAT-T)，但 UDP 4500 過不去：${r2.reason}`; T.dead = true; }
      else {
        T.peer = P;
        if (nat) T.natInfo = { seen: nat.seen, by: nat.by, natT: !!natT, behind: !!T.nat };
        if (natT) T.natT = true;
        // IKEv2：兩端的 PFS 不同時，現在建得起來，第一次重新協商才會失敗
        if (ikeVer(pd, P.cfg) === 2 && !p2set(T.cfg).some((x) => p2set(P.cfg).includes(x))) T.pfsBad = `兩端的 PFS 設定不同（本端 ${pfsText(T.cfg)}，對端 ${pfsText(P.cfg)}）`;
      }
    }
  }
  // 對端在 NAT 後面：NAT 設備替 UDP 4500 留著轉換（keepalive 讓它不過期），外面送進來的 NAT-T 封包才轉得回去
  state.rt.natt = all.filter((T) => T.natT && T.nat && T.nat.by).map((T) => ({ by: T.nat.by, peer: T.peerIp, local: T.localIp, dev: T.dev }));
  tunnelTimers(state, all);
  for (const T of all) {
    T.up = !T.why;
    T.cfg.rt = { natT: !!T.natT, nat: T.natInfo ? fmtIp(T.natInfo.seen) : '', up: T.up, why: T.why, nego: T.nego || 0, stale: T.stale ? T.stale.until : 0, staleWhy: T.stale ? T.stale.why : '', ver: ikeVer(state.devices[T.dev], T.cfg), rekeyFail: T.up && T.rekeyFail ? T.rekeyFail : 0, pfsBad: T.up ? T.pfsBad || '' : '' };
  }

  // 遠端存取 VPN（用戶端撥入）
  const old = state.vpnLeases || {};
  state.vpnLeases = {};
  for (const d of devs) {
    const c = d.vpnClient;
    if (!c) continue;
    d.rt.vpn = { up: false, why: '' };
    if (!c.on) { d.rt.vpn.why = '尚未連線'; continue; }
    const server = parseIp(c.server || '');
    if (server == null) { d.rt.vpn.why = '請填入 VPN 伺服器的位址'; continue; }
    const sd = findOwner(state, server);
    if (sd && !(sd.vpnServer && sd.vpnServer.on)) { d.rt.vpn.why = `${sd.name} 沒有開啟遠端存取 VPN`; continue; }
    // 遠端存取用的是 SSL-VPN：用戶端對伺服器的 TCP 連接埠（預設 10443）建立 TLS 連線
    const res = transact(state, d.id, { proto: 'tcp', dst: server, dport: +c.port || 10443, quiet: true });
    if (!res.ok) { d.rt.vpn.why = '連不到 VPN 伺服器：' + res.reason; continue; }
    const vs = sd.vpnServer;
    // 帳號：FortiGate 本機的使用者，或群組對應到的 LDAP (AD)
    const auth = vpnLogin(state, sd, c.user, c.pass);
    if (!auth.ok) { d.rt.vpn.why = auth.why; continue; }
    const subnets = cidrList(vs.subnets);
    if (!subnets.length) { d.rt.vpn.why = `${sd.name} 沒有設定 VPN 用戶可以存取的內部網段`; continue; }
    const key = sd.id;
    const st = { leases: state.vpnLeases };
    const vip = leaseFrom(st, old, key, parseIp(vs.start || ''), parseIp(vs.end || ''), null, d.id);
    if (vip == null) { d.rt.vpn.why = `${sd.name} 的 VPN 位址池還沒設定或已用完`; continue; }
    const mine = [{ net: vip, bits: 32 }];
    d.rt.tunnels.push({ name: 'VPN', dev: d.id, up: true, vip, localIp: res.srcIp, peerIp: server, local: mine, remote: subnets, iface: tunIface('vpn0', 'VPN') });
    sd.rt.tunnels.push({ name: 'ra:' + d.id, dev: sd.id, up: true, localIp: server, peerIp: res.seenSrc, local: subnets, remote: mine, iface: tunIface('vpn:remote', '遠端使用者 VPN') });
    d.rt.vpn = { up: true, vip, server: sd.id };
  }
}

export function findTunnel(dev, pkt) {
  let hit = null;
  for (const t of dev.rt.tunnels) {
    if (t.vti || (t.proto && pkt.proto !== t.proto)) continue; // VTI 只加密路由到 Tunnel 介面的封包；GRE 的 proxy ID 只比對 GRE
    if (!selMatch(t.local, pkt.src) || !selMatch(t.remote, pkt.dst)) continue;
    // 用 CLI 建立的 FortiGate 通道是 route-based：除了第二階段的網段要符合，還要有一筆靜態路由把目的地指向通道
    if (t.cfg && t.cfg.manualRoute && !selMatch(cidrList((t.cfg.routes || []).join(',')), pkt.dst)) continue;
    if (t.up) return t;
    hit ||= t;
  }
  return hit;
}
