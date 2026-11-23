// 供電與連線、err-disabled、DTP、語音 VLAN、LACP、STP 與連接埠的 STP 計時
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { stpPrio, isMst, mstKey, bpduFilterIf, bpduGuardOn, loopGuardOn } from '../stpcfg.js';
import { CABLES, CATALOG, DTP_MODELS, POE_CLASS_W, cableDist, cableKind, linkInfo, fiberLink, looseNext } from '../model.js';
import { rejectsOptic } from '../optics.js';
import { cdpOn, lldpRxOn, lldpTxOn, speaksCdp } from '../disc.js';
import { spanDest } from '../wire.js';
import { cmp, isTrunk, isVlanSw, macOf } from './core.js';
import { isBridgePort, macsBehind, vlanAllowed, vlanExists } from './l2.js';
import { psecEval, psecForget, stormLimit } from '../l2sec.js';

// ───────────────────── 供電、連線、LACP、STP、Wi-Fi ─────────────────────

/**
 * PoE：受電設備 (PD) 從交換器 (PSE) 的 PoE 埠拿電。交換器有總預算，依埠的順序分配，不夠的埠會被拒絕供電。
 * 每個 PD 依等級保留上限（Class 2 是 7 W、Class 0 / 3 是 15.4 W）；Cisco 電話和 Cisco 交換器之間開著 CDP 時，
 * 會用 CDP 協商出實際需要的瓦數，保留得比較少。power inline never 的埠不供電。
 * 回傳 { '交換器:埠': { pd, state: 'on' | 'denied' | 'never' | 'off', watts, alloc, cls, cdp } }
 */
export function poeTable(state, isDead) {
  const out = {}, cut = state.cut || {};
  const shutPort = (D, pid) => !!(D.sw && D.sw.ports[pid] && D.sw.ports[pid].shut);
  for (const d of Object.values(state.devices)) {
    if (!d.ports.some((p) => p.poe)) continue;
    const budget = CATALOG[d.model].poeBudget ?? Infinity;
    let sum = 0;
    for (const p of d.ports) {
      if (!p.poe) continue;
      const c = state.cables.find((x) => (x.a.dev === d.id && x.a.port === p.id) || (x.b.dev === d.id && x.b.port === p.id));
      if (!c || cut[c.id]) continue;
      const o = c.a.dev === d.id && c.a.port === p.id ? c.b : c.a, x = state.devices[o.dev], xm = CATALOG[x.model];
      if (!xm.needsPoe || (xm.poeIn && xm.poeIn !== o.port)) continue;
      const key = d.id + ':' + p.id, cls = xm.poe ? xm.poe.cls : 0, watts = xm.poe ? xm.poe.watts : 12;
      const pc = d.sw && d.sw.ports[p.id];
      if (pc && pc.poe === 'never') { out[key] = { pd: x.id, state: 'never', watts: 0, alloc: 0, cls }; continue; }
      if (isDead(d.id) || shutPort(d, p.id)) { out[key] = { pd: x.id, state: 'off', watts: 0, alloc: 0, cls }; continue; }
      const cdp = speaksCdp(x) && !isDead(x.id) && cdpOn(d, p.id) && cdpOn(x, o.port); // 還在開機的電話還沒送 CDP，先依等級保留
      // Cisco 的 AP 也會用 LLDP 的 Power via MDI 協商（802.3at 的 DLL 分級）：兩邊的 LLDP 都要能送能收
      const lldp = !cdp && xm.lwap && xm.vendor === 'Cisco' && !isDead(x.id) && lldpTxOn(d, p.id) && lldpRxOn(d, p.id) && lldpTxOn(x, o.port) && lldpRxOn(x, o.port);
      const alloc = cdp || lldp ? watts : POE_CLASS_W[cls];
      if (sum + alloc > budget + 1e-9) { out[key] = { pd: x.id, state: 'denied', watts: 0, alloc, cls, cdp, lldp }; continue; }
      sum += alloc;
      out[key] = { pd: x.id, state: 'on', watts, alloc, cls, cdp, lldp };
    }
  }
  return out;
}

export function prepPhysical(state) {
  const rt = state.rt, down = state.down || {}, cut = state.cut || {};
  // 交換器的連接埠，或路由器的實體介面被 shutdown
  const shut = (D, pid) => !!(D.sw && D.sw.ports[pid] && D.sw.ports[pid].shut) || D.ifaces.some((i) => i.shut && i.bind.t === 'port' && i.bind.port === pid);
  rt.poe = poeTable(state, (id) => !!down[id]);
  const powered = new Set(Object.values(rt.poe).filter((e) => e.state === 'on').map((e) => e.pd));
  for (const d of Object.values(state.devices)) if (CATALOG[d.model] && CATALOG[d.model].needsPoe && !powered.has(d.id)) rt.off[d.id] = true;
  // 接觸不良的網路線：下一次斷線或恢復的時間點要重算一次
  for (const c of state.cables) if (c.loose && state.devices[c.a.dev] && state.devices[c.b.dev]) rt.pending.push({ at: looseNext(state, c), dev: c[c.loose === 'a' ? 'a' : 'b'].dev, kind: 'link', text: `${state.devices[c.a.dev].name} ↔ ${state.devices[c.b.dev].name}：網路線接觸不良，連線一下斷一下` });
  for (const c of state.cables) {
    const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
    if (cut[c.id] || down[A.id] || down[B.id] || rt.off[A.id] || rt.off[B.id] || shut(A, c.a.port) || shut(B, c.b.port)) {
      rt.cable[c.id] = 'down';
      const dead = [A, B].find((x) => down[x.id]);
      const adm = shut(A, c.a.port) ? [A, c.a.port] : shut(B, c.b.port) ? [B, c.b.port] : null;
      if (cut[c.id]) rt.why[c.id] = (state.cutWhy || {})[c.id] || '線路斷了';
      else if (dead) rt.why[c.id] = `${dead.name} 已經關機`;
      else if ([A, B].some((x) => (rt.offWhy || {})[x.id])) rt.why[c.id] = rt.offWhy[[A, B].find((x) => (rt.offWhy || {})[x.id]).id];
      else if (adm) rt.why[c.id] = `${adm[0].name} 的 ${(adm[0].ports.find((p) => p.id === adm[1]) || {}).label || adm[1]} 被停用 (shutdown)`;
      continue;
    }
    const kind = CABLES[cableKind(c)], meters = cableDist(state, c);
    if (meters > kind.max && !fiberLink(state, c)) {
      rt.cable[c.id] = 'down';
      rt.why[c.id] = `${kind.name}最長只能拉 ${kind.max} 公尺，但這兩台設備相距 ${meters} 公尺`;
      continue;
    }
    const neg = linkInfo(state, A.id, c.a.port);
    if (neg && neg.down) { rt.cable[c.id] = 'down'; rt.why[c.id] = neg.down; continue; }
    rt.links[A.id + ':' + c.a.port] = { dev: B.id, port: c.b.port, cable: c.id };
    rt.links[B.id + ':' + c.b.port] = { dev: A.id, port: c.a.port, cable: c.id };
    rt.cable[c.id] = 'up';
  }
  // ── err-disabled ──
  // 違規一發生埠就被關掉，而且會一直維持：就算原因排除了（拔掉那台設備、改了設定）也不會自己恢復，
  // 要 shutdown 再 no shutdown；或是設定了 errdisable recovery，計時器到了交換器自己試著打開（原因還在就馬上又被關掉）。
  // 設備關機、重新開機也會清掉。state.dyn.errdis = { '設備:埠': { cause: 'psec' | 'bpdu' | 'storm', at, n（第幾次被關） } }
  const ED = (state.dyn.errdis ||= {}), now = state.clock, retry = {};
  const cutPort = (d, pid, l, why) => {
    delete rt.links[d.id + ':' + pid];
    delete rt.links[l.dev + ':' + l.port];
    rt.cable[l.cable] = 'down';
    rt.why[l.cable] = why;
  };
  // Port Security：每個埠算出安全位址與違規。restrict / protect 在 l2 的 ingress 丟掉違規的訊框，shutdown 把整個埠關掉。
  // dry：只看原因還在不在（已經 err-disabled 的埠不會再學新的安全位址）
  const alive = (x) => x && !down[x.id] && !rt.off[x.id];
  const psecRun = (d, pid, dry) => {
    const pc = d.sw.ports[pid];
    if (!pc.ps || !pc.ps.on) return null;
    if (!rt.links[d.id + ':' + pid]) { if (!dry) psecForget(state, d, pid); return null; }
    const seen = macsBehind(state, d, pid);
    const fl = seen.find((m) => { const x = state.devices[m.dev]; return alive(x) && x.macFlood; });
    const flood = fl ? { mac: 'macof', dev: fl.dev } : null;
    if (dry) {
      const r = psecEval({ dyn: { psec: { [d.id + ':' + pid]: JSON.parse(JSON.stringify((state.dyn.psec || {})[d.id + ':' + pid] || { dyn: [], viol: 0 })) } } }, { ...d, sw: { ...d.sw, ports: { ...d.sw.ports, [pid]: { ...pc, ps: { ...pc.ps } } } } }, pid, seen, flood, now);
      return r;
    }
    const r = psecEval(state, d, pid, seen, flood, now);
    (d.rt.psec ||= {})[pid] = r;
    return r;
  };
  const psecBad = (d, pid, dry) => { const r = psecRun(d, pid, dry); return !!r && r.mode === 'shutdown' && r.bad.length > 0; };
  // Storm Control：這個埠後面有人狂送廣播，超過門檻；action shutdown 才會把埠關掉（其他的只是丟掉超過的部分）
  const stormSrc = (d, pid) => {
    const pc = d.sw.ports[pid];
    if (!pc.storm || !rt.links[d.id + ':' + pid]) return null;
    const li = linkInfo(state, d.id, pid), speed = (li && li.speed) || 1000, lim = stormLimit(pc, speed);
    if (lim == null) return null;
    const src = macsBehind(state, d, pid).map((m) => state.devices[m.dev]).find((x) => alive(x) && +x.bcastFlood > 0);
    if (!src) return null;
    const rate = Math.min(+src.bcastFlood, speed);
    return rate > lim ? { src, rate, lim, speed } : null;
  };
  const stormBad = (d, pid) => { const pc = d.sw.ports[pid]; return !!(pc.storm && pc.storm.action === 'shutdown' && stormSrc(d, pid)); };
  const bpduBad = (d, pid) => {
    const pc = d.sw.ports[pid], l = rt.links[d.id + ':' + pid];
    if (!l || !bpduGuardOn(d, pid, portfastOn(d, pc, pid)) || bpduFilterIf(d, pid)) return false;
    const x = state.devices[l.dev];
    return isVlanSw(x) && !(x.sw.stp && x.sw.stp.on === false) && isBridgePort(x, l.port) && !bpduFilterIf(x, l.port);
  };
  // 第三方的收發器：Cisco 的交換器不接受（gbic-invalid），除非 service unsupported-transceiver
  const gbicPn = (d, pid) => {
    const c = state.cables.find((x) => (x.a.dev === d.id && x.a.port === pid) || (x.b.dev === d.id && x.b.port === pid));
    const f = c && fiberLink(state, c);
    return f ? f.optics[c.a.dev === d.id && c.a.port === pid ? 'a' : 'b'] : null;
  };
  const gbicBad = (d, pid) => { const pn = gbicPn(d, pid); return !!pn && rejectsOptic(d, pn, (CATALOG[d.model] || {}).vendor); };
  const what = (c) => (c === 'bpdu' ? 'BPDU Guard 收到 BPDU' : c === 'storm' ? 'Storm Control 偵測到廣播風暴' : c === 'gbic' ? '插了不支援的收發器 (gbic-invalid)' : 'Port Security 違規');
  const markErr = (d, pid, cause) => { d.rt.err[pid] = cause === 'bpdu' ? 'bpdu' : cause === 'storm' ? 'storm' : cause === 'gbic' ? 'gbic' : true; };
  for (const [key, e] of Object.entries(ED)) {
    const k = key.indexOf(':'), d = state.devices[key.slice(0, k)], pid = key.slice(k + 1);
    if (!d || !isVlanSw(d) || !d.sw.ports[pid] || down[d.id] || shut(d, pid)) { delete ED[key]; continue; }
    const secs = errRecoverSecs(d, e.cause);
    // 計時器到了：埠重新打開，下面照常檢查，原因還在就再關一次
    if (secs && now >= e.at + secs - 1e-9) { retry[key] = e.n || 1; delete ED[key]; continue; }
    const still = e.cause === 'bpdu' ? bpduBad(d, pid) : e.cause === 'storm' ? stormBad(d, pid) : e.cause === 'gbic' ? gbicBad(d, pid) : psecBad(d, pid, true);
    markErr(d, pid, e.cause);
    const l = rt.links[key];
    if (l) {
      cutPort(d, pid, l, still
        ? `${d.name} 的 ${pid} 處於 err-disabled（${what(e.cause)}），原因還在${secs ? `：errdisable recovery 打開之後會馬上再被關掉` : ''}`
        : `${d.name} 的 ${pid} 還是 err-disabled：${what(e.cause)}的原因已經排除，但埠不會自己恢復，要 shutdown 再 no shutdown${secs ? `，或等 errdisable recovery（還要 ${Math.ceil(e.at + secs - now)} 秒）` : ''}`);
    }
    if (secs && !still) rt.pending.push({ at: e.at + secs, dev: d.id, kind: 'errdis', text: `${d.name} ${pid}：errdisable recovery` });
  }
  const errOn = (d, pid, cause, why) => {
    const key = d.id + ':' + pid, l = rt.links[key];
    ED[key] = { cause, at: now, n: (retry[key] || 0) + 1 };
    markErr(d, pid, cause);
    cutPort(d, pid, l, why + '。排除原因之後要 shutdown 再 no shutdown 才會恢復' + (errRecoverSecs(d, cause) ? '（或等 errdisable recovery 的計時器）' : ''));
  };
  // Port Security：算出每個埠的安全位址；shutdown 模式發現超過 maximum 的 MAC 就把整個埠關掉
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const pid of Object.keys(d.sw.ports)) {
      if (ED[d.id + ':' + pid]) continue;
      const r = psecRun(d, pid, false);
      if (r && r.mode === 'shutdown' && r.bad.length) {
        const b = r.bad[0];
        errOn(d, pid, 'psec', `${d.name} 的 ${pid} 因為 Port Security 違規而被關閉 (err-disabled)：${b.flood ? `${(state.devices[b.dev] || {}).name || '後面的設備'} 在狂送來源 MAC 都不一樣的訊框 (MAC flooding)` : `看到第 ${r.max + 1} 個 MAC ${b.mac}（最多只允許 ${r.max} 個）`}`);
      }
    }
  }
  // 第三方的收發器：插上去（線接好）就被關成 err-disabled
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const pid of Object.keys(d.sw.ports)) {
      if (ED[d.id + ':' + pid] || !gbicBad(d, pid)) continue;
      errOn(d, pid, 'gbic', `${d.name} 的 ${pid} 插的 ${gbicPn(d, pid)} 不是 Cisco 的收發器，交換器不接受，連接埠被關閉 (err-disabled，原因 gbic-invalid)：換成原廠的收發器，或設定 service unsupported-transceiver`);
    }
  }
  // Storm Control 的 shutdown：廣播超過門檻就把埠關掉（err-disabled，原因是 storm-control）
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const pid of Object.keys(d.sw.ports)) {
      if (ED[d.id + ':' + pid] || !stormBad(d, pid)) continue;
      const x = stormSrc(d, pid);
      errOn(d, pid, 'storm', `${d.name} 的 ${pid} 收到的廣播超過 storm-control 的門檻（${x.src.name} 每秒送出約 ${Math.round(x.rate)} Mbps 的廣播，門檻 ${+d.sw.ports[pid].storm.bcast}%），連接埠被關閉 (err-disabled)`);
    }
  }
  // Root Guard：啟用的埠只能是 Designated。如果從這個埠收到「根橋在對面」的 BPDU（superior BPDU），
  // 埠就進入 root-inconsistent 而被擋下。擋下之後拓撲改變，所以要重複檢查到穩定為止。
  {
    const swOn = (x) => isVlanSw(x) && !(x.sw.stp && x.sw.stp.on === false) && !down[x.id];
    const bridgeId = (x) => { const s = x.sw.stp || {}; return [s.prio == null || s.prio === '' ? 32768 : +s.prio, macOf(x.id, 'br')]; };
    const better = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    /** 從 start 出發、不經過 skipDev 這台交換器，能走到的所有交換器 */
    const reach = (start, skipDev) => {
      const seen = new Map([[start.id, start]]), todo = [start];
      while (todo.length) {
        const x = todo.pop();
        for (const p of x.ports) {
          const l = rt.links[x.id + ':' + p.id];
          if (!l || l.dev === skipDev || seen.has(l.dev)) continue;
          const y = state.devices[l.dev];
          if (!swOn(y) || !isBridgePort(x, p.id) || !isBridgePort(y, l.port)) continue;
          seen.set(y.id, y); todo.push(y);
        }
      }
      return seen;
    };
    /** 從 start 走到 target 最少要經過幾段交換器之間的線（不經過 skipDev）；走不到是 Infinity */
    const hops = (start, skipDev, target) => {
      if (start.id === target) return 0;
      const dist = new Map([[start.id, 0]]), q = [start];
      while (q.length) {
        const x = q.shift();
        for (const p of x.ports) {
          const l = rt.links[x.id + ':' + p.id];
          if (!l || l.dev === skipDev || dist.has(l.dev)) continue;
          const y = state.devices[l.dev];
          if (!swOn(y) || !isBridgePort(x, p.id) || !isBridgePort(y, l.port)) continue;
          dist.set(y.id, dist.get(x.id) + 1);
          if (y.id === target) return dist.get(y.id);
          q.push(y);
        }
      }
      return Infinity;
    };
    for (let round = 0, again = true; again && round < 16; round++) {
      again = false;
      scan: for (const d of Object.values(state.devices)) {
        if (!swOn(d)) continue;
        for (const [pid, pc] of Object.entries(d.sw.ports)) {
          const l = rt.links[d.id + ':' + pid];
          if (!l || !pc.rootguard || !isBridgePort(d, pid)) continue;
          const x = state.devices[l.dev];
          if (!swOn(x) || !isBridgePort(x, l.port)) continue;
          let root = d;
          for (const y of reach(d, null).values()) if (better(bridgeId(y), bridgeId(root))) root = y;
          if (root === d || !reach(x, d.id).has(root.id)) continue; // 自己就是根橋，或對面不會送來根橋的 BPDU
          // 對面送來的是「更好的」BPDU 才算（這個埠會變成 Root Port）：環狀的拓撲裡，根橋也可能從別的埠更近
          const viaX = 1 + hops(x, d.id, root.id);
          let best = Infinity, bestNb = null;
          for (const p of d.ports) {
            if (p.id === pid) continue;
            const l2 = rt.links[d.id + ':' + p.id];
            if (!l2 || !isBridgePort(d, p.id)) continue;
            const y = state.devices[l2.dev];
            if (!swOn(y) || !isBridgePort(y, l2.port)) continue;
            const c = 1 + hops(y, d.id, root.id);
            if (c < best || (c === best && bestNb && better(bridgeId(y), bridgeId(bestNb)))) { best = c; bestNb = y; }
          }
          if (viaX > best || (viaX === best && bestNb && better(bridgeId(bestNb), bridgeId(x)))) continue;
          d.rt.err[pid] = 'root';
          delete rt.links[d.id + ':' + pid];
          delete rt.links[l.dev + ':' + l.port];
          rt.cable[l.cable] = 'down';
          rt.why[l.cable] = `${d.name} 的 ${pid} 啟用了 Root Guard，卻從這個埠收到更優先的根橋 BPDU（${root.name}），連接埠已被擋下 (root-inconsistent)`;
          again = true;
          break scan;
        }
      }
    }
  }
  // BPDU Guard：接使用者的埠如果收到 BPDU（對面是一台交換器），就把埠關掉
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const pid of Object.keys(d.sw.ports)) {
      if (ED[d.id + ':' + pid] || !bpduBad(d, pid)) continue;
      errOn(d, pid, 'bpdu', `${d.name} 的 ${pid} 啟用了 BPDU Guard，偵測到對面是交換器，連接埠已被關閉 (err-disabled)`);
    }
  }
}

/** errdisable recovery 認得的原因（IOS 的名稱） */
export const ERR_CAUSES = { psec: 'psecure-violation', bpdu: 'bpduguard', storm: 'storm-control', gbic: 'gbic-invalid' };
export const ERR_RECOVERY_DEFAULT = 300;
/** 這個原因有設定 errdisable recovery 的話，回傳計時器的秒數；沒有設定回傳 0 */
export function errRecoverSecs(d, cause) {
  const r = d.sw && d.sw.errRec;
  if (!r || !(r.causes || []).includes(ERR_CAUSES[cause])) return 0;
  return +r.interval > 0 ? +r.interval : ERR_RECOVERY_DEFAULT;
}
/** 交換器上目前 err-disabled 的埠：[{ pid, cause, at, n, left（recovery 還要幾秒，沒設定是 null） }] */
export function errdisRows(state, d) {
  const ED = (state.dyn && state.dyn.errdis) || {}, out = [];
  for (const [key, e] of Object.entries(ED)) {
    if (!key.startsWith(d.id + ':')) continue;
    const secs = errRecoverSecs(d, e.cause);
    out.push({ pid: key.slice(d.id.length + 1), cause: e.cause, at: e.at, n: e.n || 1, left: secs ? Math.max(0, Math.ceil(e.at + secs - state.clock)) : null });
  }
  return out;
}
/** 圖形介面的「重新啟用」：等於 shutdown 再 no shutdown */
export function bouncePort(state, d, pid) { if (state.dyn && state.dyn.errdis) delete state.dyn.errdis[d.id + ':' + pid]; }

// ── DTP ──
// Catalyst 的連接埠預設是 dynamic auto：對面要求 (trunk / desirable) 才變成 Trunk。兩端都是 auto 就維持 Access。
// switchport nonegotiate 不送 DTP，對面的 dynamic 埠永遠等不到要求。路由器、電腦、Nexus 都不講 DTP。
const DYN = { 'dynamic-auto': 'auto', 'dynamic-desirable': 'desirable' };
export const dtpSpeaker = (d) => isVlanSw(d) && DTP_MODELS.has(d.model);
/** 對面那個埠在 DTP 裡的態度：trunk / desirable / auto / access，或 null（不送 DTP） */
function dtpOf(x, port) {
  if (x.kind === 'host' && x.dtp) return x.dtp; // 攻擊工具（例如 Yersinia）假裝成交換器送 DTP
  if (!dtpSpeaker(x)) return null;
  const pc = x.sw.ports[port];
  if (!pc || pc.mode === 'routed' || pc.noneg) return null;
  return pc.mode === 'trunk' ? 'trunk' : pc.mode === 'access' ? 'access' : DYN[pc.mode] || null;
}
export function prepDtp(state) {
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    d.rt.dtp = {};
    for (const [pid, pc] of Object.entries(d.sw.ports)) {
      if (pc.mode === 'routed') continue;
      const l = state.rt.links[d.id + ':' + pid];
      let oper = pc.mode === 'trunk' ? 'trunk' : 'access', why = '', peer = null;
      if (!l) oper = 'down';
      else if (DYN[pc.mode] && dtpSpeaker(d)) {
        const x = state.devices[l.dev];
        peer = dtpOf(x, l.port);
        const mine = DYN[pc.mode];
        if (peer === 'trunk' || peer === 'desirable' || (mine === 'desirable' && peer === 'auto')) {
          oper = 'trunk';
          why = `和 ${x.name} 用 DTP 協商成 Trunk（這一端 ${mine}、對面 ${peer}）`;
        } else {
          why = !peer ? `${x.name} 不送 DTP，所以維持 Access` : peer === 'auto' ? '兩端都是 dynamic auto，沒有人主動要求，維持 Access' : `對面是 ${peer}，維持 Access`;
        }
      }
      d.rt.dtp[pid] = { admin: pc.mode, oper, why, peer };
    }
  }
}

// ── IP 電話的語音 VLAN ──
// 電話從交換器的 CDP（Appliance VLAN）或 LLDP-MED（Network Policy）知道語音 VLAN 是幾號，之後語音流量就帶著這個標籤。
// 兩種都沒有，就跟接在後面的電腦一樣不帶標籤，拿到的是資料 VLAN 的位址（也可以在電話上手動設定）
export function prepVoice(state) {
  for (const d of Object.values(state.devices)) {
    if (!d.sw || d.sw.mode !== 'phone') continue;
    const l = state.rt.links[d.id + ':sw'];
    const manual = d.phone && +d.phone.vlan > 0 ? +d.phone.vlan : null;
    if (manual) { d.rt.voice = { vlan: manual, via: 'manual' }; continue; }
    const x = l && state.devices[l.dev];
    if (!x || !isVlanSw(x)) continue;
    const pc = x.sw.ports[l.port];
    if (!pc || !pc.voice || isTrunk(x, l.port)) continue;
    if (cdpOn(x, l.port) && cdpOn(d, 'sw')) d.rt.voice = { vlan: pc.voice, via: 'cdp', from: x.id };
    else if (lldpTxOn(x, l.port) && lldpRxOn(x, l.port) && lldpTxOn(d, 'sw') && lldpRxOn(d, 'sw')) d.rt.voice = { vlan: pc.voice, via: 'lldp', from: x.id };
  }
}

export function prepLag(state) {
  const rt = state.rt, groups = new Map();
  const lagOf = (D, pid) => (isVlanSw(D) && isBridgePort(D, pid) && +D.sw.ports[pid].lag > 0 ? D.sw.ports[pid] : null);
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d)) continue;
    for (const [pid, pc] of Object.entries(d.sw.ports)) if (+pc.lag > 0) d.rt.lag[pid] = { state: 'down', why: '沒有連線', id: +pc.lag };
  }
  const suspend = (c, why) => {
    for (const e of [c.a, c.b]) {
      const D = state.devices[e.dev];
      if (lagOf(D, e.port)) D.rt.lag[e.port] = { state: 'suspended', why, id: +D.sw.ports[e.port].lag };
    }
    rt.cable[c.id] = 'susp';
  };
  for (const c of state.cables) {
    if (rt.cable[c.id] !== 'up') continue;
    const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
    const la = lagOf(A, c.a.port), lb = lagOf(B, c.b.port);
    if (!la && !lb) continue;
    if (!la || !lb) { suspend(c, `對端 ${(la ? B : A).name} 的連接埠沒有加入 Port-channel`); continue; }
    const ma = la.lagMode || 'active', mb = lb.lagMode || 'active';
    if ((ma === 'on') !== (mb === 'on')) { suspend(c, '一端是靜態 (on)、另一端是 LACP，模式不相容'); continue; }
    if (ma === 'passive' && mb === 'passive') { suspend(c, '兩端都是 LACP passive，沒有任何一端主動發起協商'); continue; }
    const sa = `${A.id}#${la.lag}`, sb = `${B.id}#${lb.lag}`;
    const key = sa < sb ? sa + '|' + sb : sb + '|' + sa;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const owner = {};
  for (const key of groups.keys()) for (const s of key.split('|')) (owner[s] ||= []).push(key);
  for (const [key, list] of groups) {
    let why = key.split('|').some((s) => owner[s].length > 1) ? '同一個 Port-channel 的成員接到了不同的對端' : '';
    if (!why) {
      const sig = {};
      for (const c of list) {
        for (const e of [c.a, c.b]) {
          const pc = state.devices[e.dev].sw.ports[e.port];
          (sig[e.dev] ||= new Set()).add(`${pc.mode}/${pc.vlan}/${pc.native}/${pc.allowed}`);
        }
      }
      if (Object.values(sig).some((s) => s.size > 1)) why = '成員埠的模式或 VLAN 設定不一致';
    }
    if (why) { list.forEach((c) => suspend(c, why)); continue; }
    list.forEach((c, n) => {
      for (const e of [c.a, c.b]) {
        const D = state.devices[e.dev];
        D.rt.lag[e.port] = { state: 'bundled', carrier: n === 0, id: +D.sw.ports[e.port].lag, size: list.length };
      }
      if (n > 0) rt.cable[c.id] = 'lag';
    });
  }
}

/** 每個 VLAN 各算一棵生成樹（近似 Rapid PVST+） */
export function prepStp(state) {
  const rt = state.rt, down = state.down || {};
  const sws = Object.values(state.devices).filter((d) => isVlanSw(d) && !down[d.id]);
  for (const d of sws) {
    const s = d.sw.stp || {};
    d.rt.stp = { on: s.on !== false, prio: s.prio == null || s.prio === '' ? 32768 : +s.prio, mac: macOf(d.id, 'br'), blocked: new Set(), roles: {}, root: {} };
  }
  // 優先權依 VLAN（PVST+）或 MST 的 instance；MST 要所有交換器都是同一個區域才照 instance 算
  const stpSws = sws.filter((d) => d.rt.stp.on), region = stpSws.length > 0 && stpSws.every((d) => isMst(d) && mstKey(d) === mstKey(stpSws[0]));
  for (const d of sws) d.rt.stp.region = isMst(d) ? (region ? 'same' : 'boundary') : null;
  let curV = 1;
  const bid = (d) => [((d.rt.stp.vp ||= {})[curV] = stpPrio(d, curV, region)), d.rt.stp.mac];
  const edges = [];
  for (const c of state.cables) {
    if (rt.cable[c.id] !== 'up') continue;
    const A = state.devices[c.a.dev], B = state.devices[c.b.dev];
    if (!isVlanSw(A) || !isVlanSw(B) || !A.rt.stp.on || !B.rt.stp.on) continue;
    if (!isBridgePort(A, c.a.port) || !isBridgePort(B, c.b.port)) continue;
    edges.push({ c, A, B, pa: c.a.port, pb: c.b.port, filt: bpduFilterIf(A, c.a.port) || bpduFilterIf(B, c.b.port) });
  }
  if (!edges.length) return;
  const vlans = new Set();
  for (const d of sws) for (const v of d.sw.vlans) vlans.add(v.id);
  const carries = (D, pid, v) => {
    const pc = D.sw.ports[pid];
    return vlanExists(D, v) && (isTrunk(D, pid) ? vlanAllowed(pc, v) : pc.vlan === v || pc.voice === v);
  };
  const pidx = (D, pid) => D.ports.findIndex((p) => p.id === pid);
  let role = (D, pid, v, r) => { (D.rt.stp.roles[pid] ||= {})[v] = r; };
  /**
   * 一個 VLAN 的生成樹。apply 為 false 時只回傳每個埠的角色（給 Loop Guard 判斷「BPDU 正常的話這個埠應該是什麼」）
   */
  const tree = (v, es, apply) => {
    const R = new Map();
    if (!apply) {
      const r0 = role;
      role = (D, pid, vv, r) => R.set(D.id + ':' + pid, r);
      try { solve(v, es, false); } finally { role = r0; }
      return R;
    }
    solve(v, es, true);
    return R;
  };
  for (const v of vlans) {
    curV = v;
    const all = edges.filter((e) => carries(e.A, e.pa, v) && carries(e.B, e.pb, v));
    const es = all.filter((e) => !e.filt);
    if (es.length) tree(v, es, true);
    // BPDU Filter 的線：開 filter 的那一端不送 BPDU，對面收不到，以為自己是 Designated 也開始轉送（迴圈）。
    // 對面開了 Loop Guard：原本應該是 Root / Alternate 的埠收不到 BPDU，就擋下來 (loop-inconsistent)
    const filt = all.filter((e) => e.filt);
    if (!filt.length) continue;
    let healthy = null;
    for (const e of filt) {
      for (const [O, op, F, fp] of [[e.A, e.pa, e.B, e.pb], [e.B, e.pb, e.A, e.pa]]) {
        if (bpduFilterIf(O, op) || !bpduFilterIf(F, fp) || !loopGuardOn(O, op)) continue;
        healthy ||= tree(v, all, false);
        const r = healthy.get(O.id + ':' + op);
        if (r !== 'root' && r !== 'altn') continue;
        role(O, op, v, 'loopinc');
        O.rt.stp.blocked.add(op + '|' + v);
        (O.rt.stp.loopinc ||= {})[op] = [...(O.rt.stp.loopinc[op] || []), v];
        rt.cable[e.c.id] = 'blocked';
      }
    }
  }
  function solve(v, es, apply) {
    const adj = new Map();
    const add = (x, a) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push(a); };
    for (const e of es) {
      add(e.A, { e, port: e.pa, nb: e.B, nport: e.pb });
      add(e.B, { e, port: e.pb, nb: e.A, nport: e.pa });
    }
    const todo = new Set(adj.keys());
    while (todo.size) {
      const first = todo.values().next().value;
      todo.delete(first);
      const comp = [], st = [first];
      while (st.length) {
        const x = st.pop();
        comp.push(x);
        for (const a of adj.get(x)) if (todo.has(a.nb)) { todo.delete(a.nb); st.push(a.nb); }
      }
      let root = comp[0];
      for (const x of comp) if (cmp(bid(x), bid(root)) < 0) root = x;
      const dist = new Map([[root, 0]]), q = [root];
      while (q.length) {
        const x = q.shift();
        for (const a of adj.get(x)) if (!dist.has(a.nb)) { dist.set(a.nb, dist.get(x) + 1); q.push(a.nb); }
      }
      const rootEdge = new Map();
      for (const x of comp) {
        if (apply) x.rt.stp.root[v] = root.id;
        if (x === root) continue;
        let best = null;
        for (const a of adj.get(x)) {
          const k = [dist.get(a.nb), ...bid(a.nb), pidx(a.nb, a.nport), pidx(x, a.port)];
          if (!best || cmp(k, best.k) < 0) best = { a, k };
        }
        rootEdge.set(x, best.a.e);
        role(x, best.a.port, v, 'root');
      }
      for (const e of es) {
        if (!comp.includes(e.A)) continue;
        if (rootEdge.get(e.A) === e) { role(e.B, e.pb, v, 'desg'); continue; }
        if (rootEdge.get(e.B) === e) { role(e.A, e.pa, v, 'desg'); continue; }
        const aWins = cmp([dist.get(e.A), ...bid(e.A)], [dist.get(e.B), ...bid(e.B)]) <= 0;
        const [D, dp, X, xp] = aWins ? [e.A, e.pa, e.B, e.pb] : [e.B, e.pb, e.A, e.pa];
        role(D, dp, v, 'desg');
        role(X, xp, v, 'altn');
        if (!apply) continue;
        X.rt.stp.blocked.add(xp + '|' + v);
        rt.cable[e.c.id] = 'blocked';
      }
    }
  }
}

// ── STP 的連接埠狀態 ──
const STP_EDGE_DELAY = 30; // 沒有 PortFast 的埠：listening 15 秒 + learning 15 秒
const STP_P2P_DELAY = 2; // 交換器之間用 RSTP 的 proposal / agreement 快速協商
/** PortFast：這個埠接的是終端設備，連線後直接開始轉送 */
export const portfastOn = (d, pc, pid) => (pc.portfast != null ? !!pc.portfast : !!(d.sw.stp && d.sw.stp.portfastDefault) && !(pid ? isTrunk(d, pid) : pc.mode === 'trunk'));

export function prepStpTimers(state) {
  const rt = state.rt, dyn = state.dyn, now = state.clock, live = new Set();
  rt.tcSrc = []; // 這一輪開始轉送的非 Edge 埠（拓撲變更的來源）
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d) || (d.sw.stp && d.sw.stp.on === false) || (state.down || {})[d.id]) continue;
    for (const [pid, pc] of Object.entries(d.sw.ports)) {
      const l = rt.links[d.id + ':' + pid];
      if (!l || pc.mode === 'routed' || (d.sw.span && spanDest(d, pid))) continue; // SPAN 的目的埠不跑 STP
      const key = d.id + ':' + pid;
      live.add(key);
      // 連線剛建立，或這個埠換了 VLAN / 模式：STP 要重新走一次
      const sig = isTrunk(d, pid) ? `t|${pc.native}|${pc.allowed}` : `a|${pc.vlan}|${pc.voice || ''}`;
      let rec = dyn.port[key];
      if (!rec || rec.sig !== sig) {
        // Trunk 只是增減允許的 VLAN：每個 VLAN 各跑一個 STP (PVST+)，原本就在轉送的 VLAN 不受影響
        const keep = rec && rec.sig.startsWith('t|') && sig.startsWith('t|') && rec.sig.split('|')[1] === sig.split('|')[1];
        rec = dyn.port[key] = { since: keep ? rec.since : dyn.boot ? -1e9 : now, sig };
      }
      const x = state.devices[l.dev];
      const toSwitch = isVlanSw(x) && !(x.sw.stp && x.sw.stp.on === false) && isBridgePort(x, l.port);
      const delay = toSwitch ? STP_P2P_DELAY : portfastOn(d, pc, pid) ? 0 : STP_EDGE_DELAY;
      const left = rec.since + delay - now;
      if (left <= 0) {
        // 非 Edge 的埠（交換器之間的線、沒有 PortFast 的埠）開始轉送：發出拓撲變更 (TC)
        if (!rec.fwd) {
          rec.fwd = true;
          if (rec.since > -1e8 && (toSwitch || !portfastOn(d, pc, pid))) rt.tcSrc.push({ dev: d.id, pid, vlans: portVlans(d, pid), at: rec.since + delay });
        }
        continue;
      }
      d.rt.wait[pid] = left;
      rt.wait[l.cable] = Math.max(rt.wait[l.cable] || 0, left);
      rt.pending.push({ at: rec.since + delay, dev: d.id, kind: 'stp', text: `${d.name} 的 ${pid}：STP ${toSwitch ? '協商中' : left > 15 ? 'listening' : 'learning'}` });
    }
  }
  for (const k of Object.keys(dyn.port)) if (!live.has(k)) delete dyn.port[k];
}

/** 這個埠帶著哪些 VLAN（Trunk 是允許的、這台也有的 VLAN） */
export function portVlans(d, pid) {
  const pc = d.sw.ports[pid];
  return isTrunk(d, pid) ? d.sw.vlans.map((v) => v.id).filter((v) => vlanAllowed(pc, v)) : [pc.vlan, ...(pc.voice ? [pc.voice] : [])];
}

/** TC 從 origin 的 pid 開始，沿著這個 VLAN 在轉送的交換器之間的線傳出去：[[交換器, 從哪個埠收到]] */
function tcReach(state, origin, pid, v) {
  const rt = state.rt, out = [[origin, pid]], seen = new Set([origin]), q = [origin];
  const fwd = (x, p) => isBridgePort(x, p) && !(x.rt.stp && x.rt.stp.blocked.has(p + '|' + v)) && portVlans(x, p).includes(v);
  while (q.length) {
    const x = state.devices[q.shift()];
    for (const p of x.ports) {
      const l = rt.links[x.id + ':' + p.id];
      if (!l || seen.has(l.dev) || !fwd(x, p.id)) continue;
      const y = state.devices[l.dev];
      if (!isVlanSw(y) || !y.rt.stp || !y.rt.stp.on || !fwd(y, l.port)) continue;
      seen.add(y.id); q.push(y.id); out.push([y.id, l.port]);
    }
  }
  return out;
}

/**
 * 拓撲變更 (Topology Change)：非 Edge 的埠開始轉送，或某個埠的生成樹狀態變了（被擋下、解除）。
 * TC 傳遍那個 VLAN 的交換器，每一台都把那個 VLAN 學到的 MAC 清掉重學（RSTP），
 * show spanning-tree detail 的 Number of topology changes 加一、記下從哪個埠收到。
 * 回傳這一輪要清掉 MAC 的 VLAN（字串）
 */
export function stpTopologyChange(state) {
  const dyn = state.dyn, rt = state.rt, now = state.clock;
  const tcs = (dyn.tc ||= {}), sig = (dyn.stpSigDev ||= {});
  const events = [...(rt.tcSrc || [])];
  for (const d of Object.values(state.devices)) {
    if (!isVlanSw(d) || !d.rt.stp || (state.down || {})[d.id]) continue;
    const s = [...d.rt.stp.blocked].sort().join(',');
    if (sig[d.id] != null && sig[d.id] !== s) {
      const a = new Set(sig[d.id] ? sig[d.id].split(',') : []), b = new Set(s ? s.split(',') : []);
      for (const k of [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x)))) {
        const cut = k.lastIndexOf('|');
        events.push({ dev: d.id, pid: k.slice(0, cut), vlans: [+k.slice(cut + 1)], at: now });
      }
    }
    sig[d.id] = s;
  }
  const flush = new Set();
  for (const e of events) {
    for (const v of e.vlans) {
      flush.add(String(v));
      for (const [id, pid] of tcReach(state, e.dev, e.pid, v)) {
        const r = ((tcs[id] ||= {})[v] ||= { n: 0 });
        r.n++; r.at = e.at; r.from = pid;
      }
    }
  }
  return flush;
}
