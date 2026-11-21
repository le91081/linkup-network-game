// 802.1X / RADIUS 與 Dynamic ARP Inspection
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { fmtIp, parseIp } from '../ip.js';
import { apsOf, rfAt, ssidsOf } from './wifi.js';
import { isVlanSw } from './core.js';
import { transact } from './transact.js';

// ───────────────────────── 802.1X / RADIUS ─────────────────────────

/** 由驗證者（交換器或基地台）向 RADIUS 伺服器查詢帳密。回傳 null 代表通過，否則回傳原因 */
function radiusCheck(state, nas, user, pass) {
  const r = nas.radius || {};
  const ip = parseIp(r.ip || '');
  if (ip == null) return `${nas.name} 還沒有設定 RADIUS 伺服器`;
  const res = transact(state, nas.id, { proto: 'udp', dst: ip, dport: 1812, quiet: true });
  if (!res.ok) return `${nas.name} 連不到 RADIUS 伺服器 ${fmtIp(ip)}（${res.reason}）`;
  const srv = state.devices[res.responder].radiusServer;
  if (!r.secret || r.secret !== srv.secret) return `${nas.name} 與 RADIUS 伺服器的共用密鑰 (shared secret) 不一致`;
  if (!user) return '用戶端沒有提供帳號';
  if (!(srv.users || []).some((u) => u.user === user && u.pass === pass)) return `RADIUS 拒絕了帳號「${user}」：帳號或密碼錯誤`;
  return null;
}

export function computeAuth(state) {
  const auth = { dot1x: {}, ent: {} };
  const res = (why) => (why ? { ok: false, why } : { ok: true });
  for (const d of Object.values(state.devices)) {
    if (isVlanSw(d)) {
      for (const [pid, pc] of Object.entries(d.sw.ports)) {
        if (!pc.dot1x) continue;
        const l = state.rt.links[d.id + ':' + pid];
        const h = l && state.devices[l.dev];
        const sup = (h && h.dot1x) || {};
        auth.dot1x[d.id + ':' + pid] = res(!l ? '沒有設備接上' : h.kind !== 'host' ? `對面的 ${h.name} 不是支援 802.1X 的終端設備`
          : !sup.user ? `${h.name} 沒有提供 802.1X 帳號` : radiusCheck(state, d, sup.user, sup.pass));
      }
    }
    for (const i of d.ifaces) {
      if (i.bind.t !== 'wlan' || !i.wifi || !i.wifi.ssid) continue;
      const key = d.id + '/' + i.id;
      for (const ap of apsOf(state)) {
        if (!rfAt(state, ap, d.pos).band || !ssidsOf(state, ap).some((s) => !s.off && s.name === i.wifi.ssid && s.sec === 'wpa2ent')) continue;
        if (auth.ent[key] && auth.ent[key].ok) continue;
        const nas = ap.lwap && ap.rt.capwap && ap.rt.capwap.wlc ? state.devices[ap.rt.capwap.wlc] : ap;
        auth.ent[key] = res(radiusCheck(state, nas, i.wifi.user, i.wifi.pass));
      }
    }
  }
  return auth;
}

/** DAI：交換器在不信任的埠上，只接受和 DHCP Snooping 綁定表相符的 ARP */
export function daiBlock(state, path, srcIf, dstIf) {
  const on = (d) => isVlanSw(d) && d.sw.dai && d.sw.dai.on;
  const bound = (i) => i.rt.src === 'dhcp';
  for (const h of path) {
    if (h.wifi) continue;
    const a = state.devices[h.to], b = state.devices[h.from];
    if (on(a) && !a.sw.ports[h.toPort].trust && !bound(srcIf)) return `ARP 被 ${a.name} 的 Dynamic ARP Inspection 丟棄：${h.toPort} 不是信任埠，而且來源沒有 DHCP 綁定紀錄`;
    if (on(b) && !b.sw.ports[h.fromPort].trust && !bound(dstIf)) return `${state.devices[path[path.length - 1].to].name} 的 ARP 回應被 ${b.name} 的 Dynamic ARP Inspection 丟棄：${h.fromPort} 不是信任埠，而且它沒有 DHCP 綁定紀錄`;
  }
  return null;
}
