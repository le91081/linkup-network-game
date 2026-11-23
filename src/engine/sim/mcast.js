// 多點傳送 (multicast) 與 IGMP snooping（第二層）
//
// 來源：d.mcastSrc = [{ group, mbps, name }]（IPTV 編碼器、數位看板的播放伺服器）：固定速率的 UDP 串流，不會因為塞車而降速。
// 接收端：d.igmp = [群組…]（加入的群組：電腦送出 IGMP Membership Report）。
// 交換器沒有 IGMP snooping（非網管型、或 no ip igmp snooping）：多點傳送和廣播一樣，送往這個 VLAN 的每一個埠。
// 有 snooping、而且這個 VLAN 有 IGMP querier（ip igmp snooping querier，交換器在這個 VLAN 要有 IP）：只送往有人加入的埠。
// 沒有 querier：電腦只在加入時送一次 Report，表項大約 260 秒後過期，之後的多點傳送又變成泛洪 (unregistered multicast)。
// 結果記在 state.rt.mcast（每一段線路、每個方向被多點傳送佔掉的 Mbps，也算進 rt.bcast 讓 TCP 拿不到）、
// rt.mstreams（每一道串流送到了哪些主機）、rt.mgroups（每台交換器的 snooping 表：VLAN|群組 → 埠）
import { l2Explore } from './l2.js';

export const isMcast = (ip) => ip != null && (ip >>> 28) === 14;
/** 交換器有沒有開 IGMP snooping（Catalyst 出廠就開著；非網管型的交換器沒有） */
export const snoopOn = (d) => !!(d && d.sw && d.sw.mode === 'vlan' && !(d.sw.igmp && d.sw.igmp.off));
const snoopVlan = (d, v) => !!(d && d.sw && d.sw.mode === 'vlan' && !(d.sw.igmp && d.sw.igmp.off) && !((d.sw.igmp && d.sw.igmp.vlanOff) || []).includes(+v));

/** 這個 VLAN 的 IGMP querier：開了 ip igmp snooping querier、在這個 VLAN 有 IP 的交換器（IP 最小的那一台當選） */
export function querierOf(state, vlan) {
  let best = null;
  for (const d of Object.values(state.devices)) {
    if (!d.sw || !d.sw.igmp || !d.sw.igmp.querier || (state.down || {})[d.id] || !snoopVlan(d, vlan)) continue;
    const i = d.ifaces.find((x) => x.bind.t === 'svi' && x.bind.vlan === +vlan && x.rt && x.rt.ip != null);
    if (i && (!best || i.rt.ip < best.ip)) best = { dev: d.id, ip: i.rt.ip };
  }
  return best;
}

export function prepMcast(state) {
  const rt = state.rt;
  rt.mcast = {}; rt.mstreams = []; rt.mgroups = {}; rt.mair = {};
  rt.bcast ||= {};
  const down = state.down || {};
  for (const d of Object.values(state.devices)) {
    if (!(d.mcastSrc || []).length || down[d.id] || (rt.off || {})[d.id]) continue;
    const iface = d.ifaces.find((i) => i.bind.t === 'port' && rt.links[d.id + ':' + i.bind.port]);
    if (!iface) continue;
    const e = l2Explore(state, d.id, iface, { trace: true });
    const keyOf = new Map((e.sws || []).map((w) => [w.dev, w.key]));
    const kids = new Map();
    for (const l of e.links || []) { if (!kids.has(l.from)) kids.set(l.from, []); kids.get(l.from).push(l); }
    const ends = new Set(e.map((x) => x.dev));
    for (const s of d.mcastSrc) {
      const mbps = +s.mbps || 0;
      if (!(mbps > 0)) continue;
      const members = new Set([...ends].filter((id) => (state.devices[id].igmp || []).includes(s.group) && !down[id]));
      const memo = new Map();
      const hasMember = (id, seen = new Set()) => {
        if (memo.has(id)) return memo.get(id);
        if (seen.has(id)) return false;
        seen.add(id);
        const v = members.has(id) || (kids.get(id) || []).some((l) => hasMember(l.to, seen));
        memo.set(id, v);
        return v;
      };
      const got = new Set([d.id]);
      let links = 0;
      for (const l of e.links || []) {
        if (!got.has(l.from)) continue;
        const f = state.devices[l.from], key = keyOf.get(l.from);
        const q = f.sw && key != null && snoopVlan(f, key) ? querierOf(state, key) : null;
        if (q && !hasMember(l.to)) continue; // snooping：沒有人加入的埠不送
        if (q) (((rt.mgroups[f.id] ||= {})[key + '|' + s.group] ||= [])).push(l.fromPort);
        got.add(l.to); links++;
        const k = l.cable + '>' + l.to;
        rt.mcast[k] = (rt.mcast[k] || 0) + mbps;
        rt.bcast[k] = (rt.bcast[k] || 0) + mbps;
        // 送到基地台：無線上要用最低的基本速率送給每一台（5 GHz 6 Mbps、2.4 GHz 1 Mbps），佔掉很多空中時間。
        // 基地台開了「多點傳送轉單點傳送」：只送給有加入的用戶端，用它們各自的速率
        const ap = state.devices[l.to];
        if (ap && ap.kind === 'ap' && ap.wifi) {
          const cl = (rt.clients[ap.id] || []).map((c) => c.iface.rt.assoc).filter(Boolean);
          const air = ap.wifi.m2u
            ? (rt.clients[ap.id] || []).filter((c) => members.has(c.dev)).reduce((a, c) => a + mbps / Math.max(6, ((c.iface.rt.assoc || {}).rate || 54) * 0.5), 0)
            : cl.length ? mbps / (cl.some((a) => a.band === '2.4GHz') ? 1 : 6) : 0;
          rt.mair[ap.id] = (rt.mair[ap.id] || 0) + air;
        }
      }
      // 基地台收到了：它的無線用戶端也收到（多點傳送轉單點傳送只送給有加入的）
      for (const id of [...got]) {
        const ap = state.devices[id];
        if (ap && ap.kind === 'ap') for (const c of rt.clients[id] || []) if (!ap.wifi.m2u || members.has(c.dev)) got.add(c.dev);
      }
      const vlan = keyOf.size ? keyOf.values().next().value : null;
      rt.mstreams.push({ src: d.id, group: s.group, name: s.name || s.group, mbps, vlan, members: [...members].filter((id) => got.has(id)), missed: [...members].filter((id) => !got.has(id)),
        extra: [...got].filter((id) => ends.has(id) && !members.has(id) && state.devices[id].kind === 'host'), flooded: !querierOf(state, vlan), links });
    }
  }
}
