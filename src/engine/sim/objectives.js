// 任務目標的檢查
// （從 sim.js 拆出來的一部分；其他程式一律從 engine/sim.js 引入，不直接引入這裡）
import { PHONE_TEXT, callQuality, sipQuality, mosText, phoneState } from '../voice.js';
import { cloneState, primaryIface } from '../model.js';
import { fmtIp, netOf, parseCidr, parseIp } from '../ip.js';
import { globalIp6, transact6 } from '../sim6.js';
import { parseIp6 } from '../ip6.js';
import { remoteClose, remoteLogin, remoteOpen } from '../remote.js';
import { tlsCheck } from '../web.js';
import { dhcpTrace } from './l3.js';
import { fmtDur } from './core.js';
import { recompute, settle } from '../sim.js';
import { resolveName } from './resolve.js';
import { throughput } from './bandwidth.js';
import { transact, flowSend } from './transact.js';

// ───────────────────────────── 任務目標 ─────────────────────────────

/**
 * 目標格式：
 *  { type:'ping'|'tcp'|'udp', from, to | ip | name, port, expect:true|false, via?:devId }
 *  { type:'dhcp', dev, subnet? }
 *  { type:'check', test(state) → true | '原因' }
 *  { type:'failover', down?:[devId], cut?:[[devId, portId]], test:{...} }
 *    feed:['A'] 某一路電斷了（設備的電源供應器接在哪一路，見 engine/power.js）
 *    keep:{ from, ip, port } 取代 test：故障之前先建立 TCP 連線，故障之後在同一條連線上繼續送資料（連線表要跟著換手）
 */
export function runObjective(state, o) {
  if (o.type === 'login') {
    // 真的用 SSH / Telnet 登入一次：連得上、而且帳號密碼對得上才算
    const expect = o.expect ?? true, proto = o.proto || 'ssh';
    const op = remoteOpen(state, o.from, proto, parseIp(o.ip), o.user || '');
    let ok = false, reason = '';
    if (!op.ok) reason = op.reason;
    else if (op.open) ok = true;
    else {
      const a = remoteLogin(state, op.conn, o.pass || '');
      ok = a.ok;
      if (!ok) reason = a.reason || (a.hint ? `登入失敗：${a.hint}` : `${proto === 'ssh' ? 'SSH' : 'Telnet'} 連上了，但登入失敗（帳號或密碼不對，或 line vty 的登入方式不對）`);
    }
    if (op.conn) remoteClose(state, op.conn);
    const pass = ok === expect;
    return { pass, ok, reason: pass ? '' : expect ? reason : `${proto === 'ssh' ? 'SSH' : 'Telnet'} 登入成功了，但這應該要被擋下`, failDev: o.from, log: op.res ? op.res.log : [], hops: op.res ? op.res.hops : [] };
  }
  if (o.type === 'check') {
    const r = o.test(state);
    return { pass: r === true, ok: r === true, reason: r === true ? '' : r, log: [], hops: [] };
  }
  if (o.type === 'phone') {
    // IP 電話已經向 CUCM 註冊（可以指定分機號碼）
    const d = state.devices[o.dev], st = phoneState(state, d);
    const ok = st.st === 'reg' && (!o.ext || st.ext === String(o.ext));
    const reason = ok ? '' : st.st === 'reg' ? `${d.name} 註冊成分機 ${st.ext}，不是 ${o.ext}` : `${d.name}：${st.why || PHONE_TEXT[st.st]}`;
    return { pass: ok, ok, reason, failDev: o.dev, log: [], hops: [] };
  }
  if (o.type === 'call') {
    // 兩支電話之間通話，品質 (MOS) 要達到門檻
    const q = callQuality(state, o.from, o.to), min = o.mos || 4.0;
    const ok = q.ok && q.mos >= min;
    const reason = ok ? '' : !q.ok ? q.why : `通話品質 MOS ${q.mos}（${mosText(q.mos)}），要 ${min} 以上：${q.why || '延遲、抖動或遺失太多'}`;
    return { pass: ok, ok, reason, call: q, failDev: o.from, log: [], hops: [] };
  }
  if (o.type === 'voip') {
    // 電腦上的軟體電話打到網際網路上的 SIP 業者：語音的品質 (MOS)
    const q = sipQuality(state, o.from, parseIp(o.ip), o.port || 16384), min = o.mos || 4.0;
    const ok = q.ok && q.mos >= min;
    const reason = ok ? '' : !q.ok ? `語音封包送不到 ${o.ip}：${q.why}` : `通話品質 MOS ${q.mos}（${mosText(q.mos)}），要 ${min} 以上：${q.why[0] || '延遲、抖動或遺失太多'}`;
    return { pass: ok, ok, reason, failDev: o.from, log: q.res ? q.res.log : [], hops: q.res ? q.res.hops : [], voip: q };
  }
  if (o.type === 'ping6') {
    const expect = o.expect ?? true;
    const dst = o.ip6 ? parseIp6(o.ip6) : globalIp6(state.devices[o.to]);
    if (dst == null) {
      const t = state.devices[o.to];
      const reason = `${t.name} 還沒有 IPv6 位址${t.ifaces.map((i) => i.rt.v6 && i.rt.v6.note).find(Boolean) ? '（' + t.ifaces.map((i) => i.rt.v6 && i.rt.v6.note).find(Boolean) + '）' : ''}`;
      return { pass: !expect, ok: false, reason, failDev: t.id, log: [{ dev: t.id, kind: 'drop', text: reason }], hops: [] };
    }
    // port 有值時測的是 TCP / UDP 連線（例如 IPv6 的 SSH、HTTP），不然是 ICMPv6 Echo
    const r = transact6(state, o.from, dst, o.port ? { proto: o.proto || 'tcp', dport: o.port } : {});
    const what = o.port ? `${(o.proto || 'tcp').toUpperCase()}/${o.port} 的連線` : 'ping ';
    return { pass: r.ok === expect, ok: r.ok, reason: r.ok === expect ? '' : expect ? r.reason : `${what}成功了，但這應該要被擋下`, failDev: r.failDev, log: r.log, hops: r.hops };
  }
  if (o.type === 'dhcp') {
    const d = state.devices[o.dev];
    const i = d.ifaces.find((x) => x.rt.src === 'dhcp') || d.ifaces.find((x) => x.mode === 'dhcp' && x.rt.link) || d.ifaces[0];
    let reason = '';
    if (i.mode !== 'dhcp') reason = `${d.name} 沒有設成「自動取得 IP (DHCP)」`;
    else if (i.rt.src !== 'dhcp') reason = `${d.name} 沒有拿到 DHCP 租約${i.rt.note ? '：' + i.rt.note : ''}`;
    else if (o.subnet) {
      const c = parseCidr(o.subnet);
      if (netOf(i.rt.ip, c.bits) !== c.net) reason = `${d.name} 拿到 ${fmtIp(i.rt.ip)}（由 ${state.devices[i.rt.server].name} 發出），不在 ${o.subnet} 裡`;
    }
    const tr = dhcpTrace(state, o.dev); // 播放 Discover → Offer → Request → Ack
    const log = [...tr.log];
    if (reason && !log.some((l) => l.text === reason)) log.push({ dev: d.id, kind: 'drop', text: reason });
    return { pass: !reason, ok: !reason, reason, failDev: reason ? d.id : null, log, hops: tr.hops };
  }
  if (o.type === 'roam') {
    // 漫遊：拿著筆電走到另一個位置（在複本上），看它有沒有換到該換的基地台、IP 有沒有變、連線還在不在
    const s2 = cloneState(state);
    recompute(s2);
    const d = s2.devices[o.dev], i = d.ifaces.find((x) => x.bind.t === 'wlan');
    const ip0 = i.rt.ip, ap0 = i.rt.assoc ? i.rt.assoc.ap : null;
    d.pos = [...o.to];
    recompute(s2);
    const a = i.rt.assoc, nm = (id) => (s2.devices[id] || {}).name || id;
    const log = [{ dev: d.id, kind: 'info', text: `${d.name} 走到 ${o.where || '另一個位置'}${ap0 ? `（原本連在 ${nm(ap0)}）` : ''}` }];
    let reason = '';
    if (!a) reason = `${d.name} 走到 ${o.where || '那裡'} 之後連不上無線網路：${i.rt.note || '收不到訊號'}`;
    else if (o.ap && a.ap !== o.ap) {
      reason = a.sticky
        ? `${d.name} 還連在 ${nm(a.ap)}（${a.rssi} dBm），旁邊的 ${nm(a.sticky.ap)} 有 ${a.sticky.rssi} dBm 卻不換：用戶端要等目前的訊號低於 -75 dBm 才會自己找新的基地台 (sticky client)。在 SSID 開啟 802.11k/v，基地台會建議它換過去`
        : `${d.name} 連到了 ${nm(a.ap)}，不是 ${nm(o.ap)}`;
    } else if (o.minRssi && a.rssi < o.minRssi) reason = `${d.name} 連在 ${nm(a.ap)}，訊號只有 ${a.rssi} dBm（要 ${o.minRssi} dBm 以上）`;
    else if (o.maxRoamMs && a.roamed && a.roamed.ms > o.maxRoamMs) reason = `${d.name} 從 ${nm(a.roamed.from)} 換到 ${nm(a.ap)} 中斷了大約 ${a.roamed.ms} ms（要 ${o.maxRoamMs} ms 以內，語音和視訊才不會斷）：${a.roamed.parts.join('、')}`;
    else if (o.keepIp && ip0 != null && i.rt.ip !== ip0) reason = `${d.name} 換到 ${nm(a.ap)} 之後，IP 從 ${fmtIp(ip0)} 變成 ${i.rt.ip != null ? fmtIp(i.rt.ip) : '沒有 IP'}：兩台基地台把同一個 SSID 放進不同的 VLAN，換基地台就換了網段，進行中的連線全部會斷`;
    if (a) log.push({ dev: d.id, kind: 'info', text: `連在 ${nm(a.ap)} · ${a.band} ${a.rssi} dBm${a.roamed ? `（從 ${nm(a.roamed.from)} 漫遊過來：${a.roamed.why}，中斷約 ${a.roamed.ms} ms）` : ''}` });
    if (!reason && o.test) {
      const r = runObjective(s2, o.test);
      return { ...r, log: [...log, ...r.log] };
    }
    return { pass: !reason, ok: !reason, reason, failDev: d.id, log, hops: [] };
  }
  if (o.type === 'after') {
    // 過一段時間之後再測（例如 VPN 第一次重新協商之後）：在複本上把時鐘往前撥，不影響玩家眼前的網路
    const s2 = cloneState(state);
    recompute(s2);
    s2.clock += o.secs;
    recompute(s2);
    const r = runObjective(s2, o.test);
    r.log.unshift({ dev: o.test.from, kind: 'info', text: `時間快轉 ${fmtDur(o.secs)}之後再測試` });
    if (!r.pass && r.reason) r.reason = `${fmtDur(o.secs)}之後：${r.reason}`;
    return r;
  }
  if (o.type === 'failover') {
    const s2 = cloneState(state);
    let keep = null;
    if (o.keep) {
      recompute(s2);
      const dst = parseIp(o.keep.ip), k = transact(s2, o.keep.from, { proto: 'tcp', dst, dport: o.keep.port, keep: 'keep-' + o.keep.port });
      if (!k.ok) return { pass: false, ok: false, reason: `故障之前就連不上 ${o.keep.ip}:${o.keep.port}：${k.reason}`, failDev: k.failDev, log: k.log, hops: k.hops };
      keep = { cid: 'keep-' + o.keep.port, to: k.responder, src: k.srcIp, sport: k.sport, dst, dport: o.keep.port, data: { kind: 'enc' }, echo: { kind: 'out' } };
    }
    s2.down = { ...(state.down || {}), ...Object.fromEntries((o.down || []).map((id) => [id, true])) };
    s2.cut = {};
    const what = (o.down || []).map((id) => state.devices[id].name + ' 斷電');
    for (const [dv, pid] of o.cut || []) {
      const c = s2.cables.find((x) => (x.a.dev === dv && x.a.port === pid) || (x.b.dev === dv && x.b.port === pid));
      if (c) s2.cut[c.id] = true;
      what.push(`${state.devices[dv].name} 的 ${pid} 斷線`);
    }
    // 某一路電斷了（A 路 / B 路）：只接在那一路的設備關機
    if ((o.feed || []).length) {
      s2.feeds = { ...(state.feeds || {}), ...Object.fromEntries(o.feed.map((f) => [f, false])) };
      what.push(...o.feed.map((f) => `${f} 路斷電`));
    }
    for (const id of o.ispFail || []) {
      s2.devices[id].inet = { ...s2.devices[id].inet, fault: true };
      what.push(`${state.devices[id].name} 的骨幹故障（線路燈號正常）`);
    }
    // 故障發生後要等網路重新收斂（VRRP 換手、OSPF 的 Dead timer…）才測試
    recompute(s2);
    const t0 = s2.clock;
    settle(s2);
    const took = Math.round(s2.clock - t0);
    let r;
    if (keep) {
      const f = flowSend(s2, o.keep.from, keep);
      r = { pass: f.ok, ok: f.ok, reason: f.ok ? '' : `進行中的連線（${o.keep.ip}:${o.keep.port}）斷了：${f.reason}`, failDev: f.failDev, log: f.log, hops: f.hops };
      if (f.ok) r.log.push({ dev: o.keep.from, kind: 'ok', text: `故障之前建立的連線（${o.keep.ip}:${o.keep.port}）照常收送資料` });
    } else r = runObjective(s2, o.test);
    r.log.unshift({ dev: (o.down || [])[0] || (o.cut || [[]])[0][0], kind: 'info', text: `故障演練：${what.join('、')}${took ? `；${fmtDur(took)}後網路重新收斂，再進行測試` : ''}` });
    if (!r.pass && r.reason) r.reason = `故障演練（${what.join('、')}）：${r.reason}`;
    return r;
  }
  const from = state.devices[o.from];
  const log = [], hops = [];
  const expect = o.expect ?? true;
  const what = o.attack ? `攻擊流量（${o.attack}）` : o.type === 'tcp' ? `TCP ${o.port} 的連線` : o.type === 'udp' ? `UDP ${o.port}` : o.type === 'ping' ? 'ping ' : '連線';
  const finish = (ok, reason, failDev) => ({ pass: ok === expect, ok, reason: ok && !expect ? `${what}成功了，但這應該要被擋下` : reason, failDev, log, hops });
  let dst;
  if (o.name) {
    const r = resolveName(state, o.from, o.name);
    log.push(...r.log); hops.push(...r.hops);
    if (!r.ok) return finish(false, r.reason, r.failDev);
    dst = r.ip;
  } else if (o.ip) {
    dst = parseIp(o.ip);
  } else {
    const t = state.devices[o.to];
    const i = o.toIface ? t.ifaces.find((x) => x.id === o.toIface) : primaryIface(t);
    if (!i || i.rt.ip == null) {
      const why = state.rt.off[t.id] ? '它沒有電' : t.ifaces.map((x) => x.rt.note).find(Boolean);
      const reason = `${t.name} 還沒有 IP 位址${why ? '（' + why + '）' : ''}`;
      log.push({ dev: t.id, kind: 'drop', text: reason });
      return finish(false, reason, t.id);
    }
    dst = i.rt.ip;
  }
  const srcIp = o.srcIp ? parseIp(o.srcIp) : from.kind === 'internet' ? parseIp(from.inet.client) : undefined;
  const proto = o.type === 'ping' ? 'icmp' : o.type === 'speed' || o.type === 'https' ? 'tcp' : o.type;
  const r = transact(state, o.from, { proto, dst, dport: o.type === 'speed' ? o.port ?? 5201 : o.port ?? 443, srcIp, ...(o.size ? { size: o.size } : {}), ...(o.df ? { df: true } : {}), ...(o.bulk != null ? { bulk: o.bulk } : o.type === 'speed' ? { bulk: 'up' } : {}), ...(o.name ? { host: o.name } : {}), ...(o.attack ? { attack: o.attack } : {}) });
  log.push(...r.log); hops.push(...r.hops);
  if (r.ok && o.type === 'speed') {
    // 傳輸速率測試（iperf3）：連得上之後，看路徑上最慢的那一段
    const t = throughput(state, r.hops, r.mss, o.bulk === 'down'), min = o.min || 0, pass = t.mbps >= min;
    log.push({ dev: pass ? o.from : t.dev || o.from, kind: pass ? 'ok' : 'drop', text: `iperf3：${t.mbps} Mbps${t.retr ? `，重傳 ${t.retr} 次` : ''}。最慢的一段是 ${t.where}${r.mss ? `（MSS ${r.mss}）` : ''}` });
    if (!pass) return { pass: false, ok: true, reason: `只跑得到 ${t.mbps} Mbps（目標 ${min} Mbps 以上）。最慢的一段：${t.where}`, failDev: t.dev || o.from, log, hops, speed: t };
    return { pass: true, ok: true, reason: '', failDev: null, log, hops, speed: t };
  }
  if (r.ok && o.type === 'https') {
    // HTTPS：TCP 連得上之後還要 TLS 交握，用戶端用自己的信任清單與時鐘驗證憑證
    const t = tlsCheck(state, from, state.devices[r.responder], o.name || fmtIp(dst), r.deep && state.devices[r.deep.dev]);
    if (!t.ok) {
      log.push({ dev: o.from, kind: 'drop', text: `TLS 交握失敗：${t.msg}（${t.why}）` });
      return finish(false, `憑證錯誤：${t.why}`, o.from);
    }
    log.push({ dev: o.from, kind: 'ok', text: `TLS 交握成功：憑證是「${t.cert.issuer}」簽給 ${(t.cert.san || [t.cert.cn]).join('、')} 的` });
  }
  if (r.ok && (o.via || o.avoid)) {
    const seen = new Set();
    for (const h of r.hops) if (!h.reply && !h.wave) { seen.add(h.from); seen.add(h.to); }
    // via：一定要經過這台；avoid：不能經過這台（例如流量不該繞經實驗室的交換器）
    const reason = o.via && !seen.has(o.via) ? `連線是通的，但封包沒有經過 ${state.devices[o.via].name}`
      : o.avoid && seen.has(o.avoid) ? `連線是通的，但封包繞經了 ${state.devices[o.avoid].name}` : '';
    if (reason) {
      log.push({ dev: o.from, kind: 'drop', text: reason });
      return { pass: false, ok: true, reason, failDev: o.avoid && seen.has(o.avoid) ? o.avoid : o.from, log, hops };
    }
  }
  return finish(r.ok, r.reason, r.failDev);
}
export function evaluate(state, objectives) {
  return objectives.map((o) => runObjective(state, o));
}
