// 隨機故障：把一個「已經正常運作」的網路改壞幾個地方，每次都不一樣（給故障演練與模擬考的實作題用）。
//
// 每一種故障都是現場真的會遇到的：閘道打錯、埠被放錯 VLAN、Trunk 少了一個 VLAN、介面被 shutdown、
// 靜態路由被刪、NAT 被關、有人加了一條 ACL…。挑選時會先在副本上試：真的讓至少一個任務目標失敗的才算數，
// 而且一台設備最多只壞一個地方，玩家才能一個一個找出來。
import { cloneState, peerOf } from './model.js';
import { settle, evaluate, setOspf, ospfOn } from './sim.js';
import { parseIp, fmtIp, parseMask } from './ip.js';

/** 可以重現的亂數（同一個種子，壞的地方一樣） */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const bump = (ip, k = 1) => { const n = parseIp(ip); if (n == null) return ip; const last = n & 255; return fmtIp((n & ~255) + ((last + k + 253) % 254) + 1); };

const isHostDev = (d) => d.kind === 'host' && !d.locked;

/** 這個網路可以壞在哪些地方。每一項：{ kind, dev, area, text, apply(state) } */
export function faultCandidates(state) {
  const out = [];
  const add = (kind, d, area, text, apply) => out.push({ kind, dev: d.id, name: d.name, area, text, apply });
  for (const d of Object.values(state.devices)) {
    if (d.locked) continue;
    // ── 主機 ──
    if (isHostDev(d) && d.ifaces[0] && d.ifaces[0].mode === 'static' && d.ifaces[0].ip) {
      const i = d.ifaces[0];
      if (i.gateway) {
        const bad = bump(i.gateway, 9);
        add('host-gw', d, '網路設定', `${d.name} 的預設閘道被改成 ${bad}（應該是 ${i.gateway}）`, (s) => { s.devices[d.id].ifaces[0].gateway = bad; });
      }
      if (parseMask(i.mask) != null && parseMask(i.mask) <= 24) {
        add('host-mask', d, '網路設定', `${d.name} 的子網路遮罩被改成 255.255.255.252（應該是 ${i.mask}）`, (s) => { s.devices[d.id].ifaces[0].mask = '255.255.255.252'; });
      }
      if (i.dns) add('host-dns', d, '網路設定', `${d.name} 的 DNS 伺服器被改成 10.255.255.53（應該是 ${i.dns}）`, (s) => { s.devices[d.id].ifaces[0].dns = '10.255.255.53'; });
    }
    if (isHostDev(d) && d.ifaces[0] && d.ifaces[0].mode === 'dhcp' && d.ports.length) {
      add('host-static', d, '網路設定', `${d.name} 被改成手動設定 192.168.254.20/24（原本是自動取得）`, (s) => { Object.assign(s.devices[d.id].ifaces[0], { mode: 'static', ip: '192.168.254.20', mask: '255.255.255.0', gateway: '192.168.254.1' }); });
    }
    // ── 網管交換器 ──
    if (d.sw && d.sw.mode === 'vlan' && d.kind !== 'wlc') {
      const vlans = d.sw.vlans.map((v) => v.id);
      for (const p of d.ports) {
        const pc = d.sw.ports[p.id], peer = peerOf(state, d.id, p.id);
        if (!pc || !peer || pc.mode === 'routed') continue;
        const other = state.devices[peer.dev];
        if (pc.mode === 'access' && other.kind === 'host') {
          const wrong = vlans.find((v) => v !== pc.vlan && v !== 1) ?? 999;
          add('sw-vlan', d, '連接埠的 VLAN', `${d.name} 的 ${p.label}（接 ${other.name}）被放到 VLAN ${wrong}（應該是 VLAN ${pc.vlan}）`, (s) => { s.devices[d.id].sw.ports[p.id].vlan = wrong; });
          add('sw-shut', d, '連接埠', `${d.name} 的 ${p.label}（接 ${other.name}）被 shutdown`, (s) => { s.devices[d.id].sw.ports[p.id].shut = true; });
        }
        if (pc.mode === 'trunk' && (other.sw || other.kind === 'router' || other.kind === 'l3switch')) {
          const used = vlans.filter((v) => v !== 1);
          const allowed = pc.allowed === 'all' || !pc.allowed ? used : String(pc.allowed).split(',').map(Number).filter((v) => used.includes(v));
          if (allowed.length >= 2) {
            const drop = allowed[allowed.length - 1];
            const keep = allowed.filter((v) => v !== drop).join(',');
            add('sw-trunk', d, 'Trunk', `${d.name} 的 ${p.label}（往 ${other.name} 的 Trunk）允許的 VLAN 被改成 ${keep}，少了 VLAN ${drop}`, (s) => { s.devices[d.id].sw.ports[p.id].allowed = keep; });
          }
          add('sw-trunk-mode', d, 'Trunk', `${d.name} 的 ${p.label}（往 ${other.name}）被改成 access 模式（應該是 Trunk）`, (s) => { Object.assign(s.devices[d.id].sw.ports[p.id], { mode: 'access', vlan: 1 }); });
        }
      }
      const inUse = d.sw.vlans.filter((v) => v.id !== 1 && Object.values(d.sw.ports).some((pc) => pc.mode === 'access' && pc.vlan === v.id));
      if (inUse.length) {
        const v = inUse[0];
        add('sw-vlan-del', d, 'VLAN', `${d.name} 的 VLAN ${v.id}（${v.name}）被刪除了：那些埠還設在 VLAN ${v.id}，但 VLAN 不存在就不會轉送`, (s) => { s.devices[d.id].sw.vlans = s.devices[d.id].sw.vlans.filter((x) => x.id !== v.id); });
      }
    }
    // ── 路由器、L3 交換器、防火牆的介面 ──
    if (d.routing && d.kind !== 'internet' && d.kind !== 'cloud') {
      for (const i of d.ifaces) {
        const ip = parseIp(i.ip || '');
        if (ip == null || i.mode !== 'static') continue;
        if (i.bind.t === 'port' && d.kind === 'router') add('rt-shut', d, '介面', `${d.name} 的 ${i.label} 被 shutdown`, (s) => { s.devices[d.id].ifaces.find((x) => x.id === i.id).shut = true; });
        if (i.bind.t !== 'loop' && !(i.dhcp && i.dhcp.on)) {
          const bad = bump(i.ip, 100);
          add('rt-ip', d, '介面位址', `${d.name} 的 ${i.label} 的 IP 被改成 ${bad}（應該是 ${i.ip}）`, (s) => { s.devices[d.id].ifaces.find((x) => x.id === i.id).ip = bad; });
        }
        if (i.nat && d.kind === 'router') add('rt-nat', d, 'NAT', `${d.name} 的 ${i.label} 的 NAT（ip nat outside）被關掉了`, (s) => { s.devices[d.id].ifaces.find((x) => x.id === i.id).nat = false; });
        if (i.dhcp && i.dhcp.on && d.kind !== 'firewall') add('rt-dhcp', d, 'DHCP', `${d.name} 的 ${i.label} 的 DHCP 位址池被停用`, (s) => { s.devices[d.id].ifaces.find((x) => x.id === i.id).dhcp.on = false; });
        if (i.helper) add('rt-helper', d, 'DHCP Relay', `${d.name} 的 ${i.label} 的 ip helper-address（${i.helper}）被拿掉了`, (s) => { delete s.devices[d.id].ifaces.find((x) => x.id === i.id).helper; });
        if (ospfOn(d, i) && i.bind.t !== 'loop') add('rt-ospf', d, 'OSPF', `${d.name} 的 ${i.label} 沒有跑 OSPF 了`, (s) => { const D = s.devices[d.id]; setOspf(D, D.ifaces.find((x) => x.id === i.id), false); });
        if (d.kind === 'router' && i.bind.t !== 'loop' && !(i.aclIn || []).length && !i.nat) {
          add('rt-acl', d, 'ACL', `${d.name} 的 ${i.label} 進入方向被加了一份只允許 ICMP 的 ACL（ping 會通，其他全部被擋）`, (s) => { s.devices[d.id].ifaces.find((x) => x.id === i.id).aclIn = [{ action: 'permit', proto: 'icmp', src: 'any', dst: 'any', port: '' }]; });
        }
      }
      (d.routes || []).forEach((r, n) => {
        if (!r.via) return;
        add('rt-route', d, '路由', `${d.name} 往 ${r.dst} ${r.mask} 的靜態路由被刪掉了（下一站 ${r.via}）`, (s) => { s.devices[d.id].routes.splice(n, 1); });
        add('rt-via', d, '路由', `${d.name} 往 ${r.dst} 的靜態路由下一站被改成 ${bump(r.via, 20)}（應該是 ${r.via}）`, (s) => { s.devices[d.id].routes[n].via = bump(r.via, 20); });
      });
    }
    if (d.kind === 'firewall') {
      (d.policies || []).forEach((p, n) => {
        if (p.off || p.action !== 'accept') return;
        add('fw-policy', d, '防火牆政策', `${d.name} 的政策 #${n + 1}「${p.name || ''}」被停用了`, (s) => { s.devices[d.id].policies[n].off = true; });
      });
    }
    // ── 雲端的 VPC ──
    if (d.kind === 'cloud' && d.vpc) {
      const v = d.vpc;
      v.rts.forEach((rt, k) => rt.routes.forEach((x, n) => add('cl-route', d, '路由表', `${d.name} 的路由表「${rt.name}」少了 ${x.dst} → ${x.target} 這條路由`, (s) => { s.devices[d.id].vpc.rts[k].routes.splice(n, 1); })));
      v.sgs.forEach((g, k) => (g.in || []).forEach((x, n) => add('cl-sg', d, '安全群組', `${d.name} 的安全群組 ${g.name} 少了輸入規則 ${x.proto.toUpperCase()} ${x.port || '全部'} ← ${x.src}`, (s) => { s.devices[d.id].vpc.sgs[k].in.splice(n, 1); })));
      v.instances.forEach((x, n) => { if (x.eip) add('cl-eip', d, '彈性 IP', `${d.name} 的 ${x.name} 的彈性 IP ${x.eip} 被解除關聯`, (s) => { s.devices[d.id].vpc.instances[n].eip = ''; }); });
    }
    if (d.wifi && (d.wifi.ssids || []).length) {
      d.wifi.ssids.forEach((x, n) => {
        if (!x.pass || x.sec === 'open') return;
        add('ap-psk', d, '無線網路', `${d.name} 的 SSID「${x.name}」密碼被改掉了（原本是 ${x.pass}）`, (s) => { s.devices[d.id].wifi.ssids[n].pass = x.pass + '!'; });
      });
    }
  }
  return out;
}

/**
 * 把網路改壞 count 個地方。state 要是「每個目標都通過」的狀態（例如關卡套用參考解法之後）。
 * 回傳 { faults: [{ kind, dev, name, area, text, breaks: [目標索引] }] }，state 直接被修改
 */
export function injectFaults(state, objectives, { count = 2, seed = 1, maxTries = 24 } = {}) {
  const r = rng(seed);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // 依種類分組、輪流挑：主機很多的關卡不會每次都是「遮罩打錯」
  const byKind = new Map();
  for (const f of faultCandidates(state)) (byKind.get(f.kind) || byKind.set(f.kind, []).get(f.kind)).push(f);
  const kinds = shuffle([...byKind.keys()]);
  for (const k of kinds) shuffle(byKind.get(k));
  const cands = [];
  for (let round = 0; cands.length < [...byKind.values()].reduce((n, l) => n + l.length, 0); round++) for (const k of kinds) if (byKind.get(k)[round]) cands.push(byKind.get(k)[round]);
  const chosen = [], usedDev = new Set(), usedKind = new Map();
  let tries = 0;
  for (const f of cands) {
    if (chosen.length >= count || tries >= maxTries) break;
    if (usedDev.has(f.dev)) continue;
    tries++;
    const t = cloneState(state);
    f.apply(t);
    settle(t);
    const res = evaluate(t, objectives);
    const breaks = res.map((x, n) => (x.pass ? -1 : n)).filter((n) => n >= 0);
    if (!breaks.length) continue;
    chosen.push({ kind: f.kind, dev: f.dev, name: f.name, area: f.area, text: f.text, breaks, apply: f.apply });
    usedDev.add(f.dev);
    usedKind.set(f.kind, (usedKind.get(f.kind) || 0) + 1);
  }
  for (const f of chosen) f.apply(state);
  return { faults: chosen.map(({ apply, ...x }) => x) };
}

/** 這一關能不能拿來做故障演練：參考解法要能讓目標全部通過，而且目標不能依賴「做過什麼操作」 */
export const drillable = (lv) => !lv.noDrill && !lv.sandbox && typeof lv.solve === 'function' && lv.objectives.length >= 2
  && !lv.objectives.some((o) => o.type === 'roam' || o.type === 'after');
