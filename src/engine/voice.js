// IP 電話與通話：開機 → 學語音 VLAN → DHCP → TFTP 下載設定檔 → 向 CUCM 註冊 → 打電話
//
// 電話（CATALOG 的 phone）：d.phone = { vlan: 手動的語音 VLAN, tftp: 備用 TFTP 伺服器, pcPort: PC 埠是否啟用 }
// 通話伺服器（Cisco Unified CM）：d.cucm = { autoReg: 自動註冊, first: 自動註冊從哪個分機號碼開始, phones: [{ mac, ext, name }] }
//   伺服器要提供 TFTP（UDP 69，電話的設定檔）與 SIP（UDP 5060，註冊與撥號）
// state.dyn.phone[電話] = { st, why, ext, cucm, since, ok }   電話螢幕上看到的狀態
// state.calls = [{ id, a, b, on }]                            一直在進行的通話（關卡或玩家建立的）
import { CATALOG } from './model.js';
import { fmtIp, parseIp } from './ip.js';
import { transact } from './sim.js';
import { egressOf, markAlong, classify, queueFate, policerFate } from './qos.js';

export const isPhone = (d) => !!d && !!(CATALOG[d.model] || {}).phone;
export const isCucm = (d) => !!d && !!d.cucm;
export const REG_TIME = 8; // 拿到位址之後，下載設定檔、註冊大約要幾秒
export const KEEPALIVE = 120; // 註冊之後每 120 秒確認一次 CUCM 還在；連續失敗才顯示未註冊
const dotMacU = (m) => String(m || '').replace(/:/g, '').toUpperCase();
export const phoneName = (d) => (CATALOG[d.model].vendor === 'Cisco' ? 'SEP' : '') + dotMacU(d.ifaces[0] && d.ifaces[0].rt && d.ifaces[0].rt.mac);
/** 電話開機後去 TFTP 下載的設定檔：Cisco 是 SEP + MAC.cnf.xml，Yealink 是 MAC.cfg */
export const configName = (d) => (CATALOG[d.model].vendor === 'Cisco' ? phoneName(d) + '.cnf.xml' : phoneName(d).toLowerCase() + '.cfg');

/** CUCM 的資料庫裡這支電話的資料；自動註冊會在第一次聯絡時建一筆 */
function lookup(srv, mac, create) {
  const db = (srv.cucm.phones ||= []);
  let e = db.find((x) => String(x.mac || '').toLowerCase() === mac);
  if (!e && create && srv.cucm.autoReg) {
    const used = new Set(db.map((x) => +x.ext));
    let ext = +srv.cucm.first || 2001;
    while (used.has(ext)) ext++;
    e = { mac, ext: String(ext), name: '自動註冊 ' + ext, auto: true };
    db.push(e);
  }
  return e || null;
}

/** 每次重新計算之後：每支電話走一遍開機到註冊的流程 */
export function phoneTick(state) {
  const dyn = state.dyn, now = state.clock, down = state.down || {}, booting = state.rt.booting || {};
  const tbl = (dyn.phone ||= {});
  for (const id of Object.keys(tbl)) if (!state.devices[id]) delete tbl[id];
  for (const d of Object.values(state.devices)) {
    if (!isPhone(d)) continue;
    const prev = tbl[d.id] || {};
    const put = (o) => { tbl[d.id] = { since: prev.st === o.st ? prev.since : now, ...o }; if (d.rt) d.rt.phone = tbl[d.id]; return tbl[d.id]; };
    if (state.rt.off[d.id] && !down[d.id]) { put({ st: 'off', why: '沒有電：交換器的埠不提供 PoE、PoE 預算不夠，或那個埠被停用了' }); continue; }
    if (down[d.id] && !(booting[d.id] > 0)) { put({ st: 'off', why: '關機' }); continue; }
    if (booting[d.id] > 0) { put({ st: 'boot', why: `開機中，還要 ${Math.ceil(booting[d.id])} 秒` }); continue; }
    const i = d.ifaces[0], v = d.rt.voice;
    if (i.rt.ip == null) { put({ st: 'ip', why: `正在設定 IP：${i.rt.note || 'DHCP 沒有回應'}`, vlan: v }); continue; }
    // TFTP：備用 TFTP 伺服器（手動）優先，其次是 DHCP 的 option 150
    const manual = parseIp(d.phone.tftp || '');
    const tftp = manual ?? (i.rt.tftp || [])[0];
    if (tftp == null) { put({ st: 'tftp', why: 'DHCP 沒有提供 TFTP 伺服器（option 150），電話不知道去哪裡下載設定檔', vlan: v }); continue; }
    const t = transact(state, d.id, { proto: 'udp', dst: tftp, dport: 69, quiet: true, data: { kind: 'tftp' } });
    if (!t.ok) { put({ st: 'tftp', why: `TFTP 逾時（${fmtIp(tftp)}）：${t.reason}`, vlan: v }); continue; }
    const srv = state.devices[t.responder];
    if (!isCucm(srv)) { put({ st: 'tftp', why: `${srv.name}（${fmtIp(tftp)}）上沒有 ${configName(d)}：它只是一台 TFTP 伺服器，不是 CUCM`, vlan: v }); continue; }
    const e = lookup(srv, i.rt.mac, true);
    if (!e) { put({ st: 'reject', why: `註冊被拒絕：${srv.name} 的資料庫裡沒有 ${phoneName(d)}，也沒有開自動註冊`, vlan: v, cucm: srv.id }); continue; }
    const sip = transact(state, d.id, { proto: 'udp', dst: t.dst ?? tftp, dport: 5060, quiet: true });
    if (!sip.ok) {
      // 已經註冊的電話要等下一次 keepalive 才發現 CUCM 不見了
      if (prev.st === 'reg' && prev.ok != null && now - prev.ok < KEEPALIVE) { put({ ...prev, lost: sip.reason }); continue; }
      put({ st: 'unreg', why: `未註冊：SIP 註冊沒有回應（${sip.reason}）`, vlan: v, cucm: srv.id, ext: e.ext });
      continue;
    }
    // 下載設定檔與註冊要幾秒鐘
    const ready = prev.st === 'reg' || prev.st === 'regging' ? prev.readyAt ?? now : now + (dyn.boot ? 0 : REG_TIME);
    if (now < ready) {
      put({ st: 'regging', why: '正在註冊…', vlan: v, cucm: srv.id, ext: e.ext, readyAt: ready });
      state.rt.pending.push({ at: ready, dev: d.id, kind: 'phone', text: `${d.name}：正在向 CUCM 註冊` });
      continue;
    }
    put({ st: 'reg', why: '', vlan: v, cucm: srv.id, ext: e.ext, ok: now, readyAt: ready, ip: i.rt.ip });
  }
}

export const phoneState = (state, d) => ((state.dyn && state.dyn.phone) || {})[d.id] || { st: 'off', why: '' };
export const PHONE_TEXT = { off: '沒有電', boot: '開機中', ip: '正在設定 IP', tftp: '正在下載設定', reject: '註冊被拒絕', unreg: '未註冊', regging: '正在註冊', reg: '已註冊' };

/** 用分機號碼找電話（同一台 CUCM、已經註冊的） */
export function phoneByExt(state, cucmId, ext) {
  return Object.values(state.devices).find((x) => isPhone(x) && phoneState(state, x).st === 'reg' && phoneState(state, x).cucm === cucmId && phoneState(state, x).ext === String(ext)) || null;
}

// ───────────────────────── 通話品質（E-model，ITU-T G.107） ─────────────────────────

/**
 * 單向的通話品質：delay（毫秒，從嘴巴到耳朵）、jitter（毫秒）、loss（%）。
 * G.711：Ie = 0，有封包遺失補償時 Bpl = 25.1。網路壅塞造成的遺失是一陣一陣的 (BurstR = 2)
 */
export function mosOf({ delay, jitter, loss, burst = 1 }) {
  // 抖動緩衝：抖動越大，緩衝越深（多出來的延遲），超過緩衝的封包等於掉了
  const buf = Math.min(80, Math.max(20, jitter * 2));
  const late = jitter > 40 ? Math.min(15, (jitter - 40) / 8) : 0;
  const d = delay + buf;
  const ppl = Math.min(100, loss + late);
  const Id = 0.024 * d + (d > 177.3 ? 0.11 * (d - 177.3) : 0);
  const Ie = (95 * ppl) / (ppl / burst + 25.1);
  const R = Math.max(0, Math.min(100, 93.2 - Id - Ie));
  const mos = R <= 0 ? 1 : 1 + 0.035 * R + R * (R - 60) * (100 - R) * 7e-6;
  return { R: Math.round(R * 10) / 10, mos: Math.round(Math.max(1, Math.min(4.5, mos)) * 100) / 100, mouth: Math.round(d), late: Math.round(late * 10) / 10 };
}
export const mosText = (m) => (m >= 4.3 ? '非常好' : m >= 4.0 ? '好' : m >= 3.6 ? '尚可，偶爾斷斷續續' : m >= 3.1 ? '差，聽得到明顯的斷續' : '很差，幾乎無法通話');

// ───────────────────────── 通話 ─────────────────────────

const RTP_KBPS = 87.2; // G.711、每 20 毫秒一個封包，加上 IP / UDP / RTP 與乙太網路的標頭
const RTP_PORT = 16384;
const dirKey = (h) => h.cable + '>' + h.to;
const fwd = (r) => r.hops.filter((h) => !h.wave && !h.reply && h.proto !== 'arp' && h.cable && !h.wifi);
const once = (hops) => { const s = new Set(); return hops.filter((h) => !s.has(dirKey(h)) && s.add(dirKey(h))); };

/** 從 X 送語音到 Y：走哪一條路、沿路每個出口看到的 DSCP */
function mediaPath(state, X, Y) {
  const ip = Y.ifaces[0].rt.ip;
  const r = transact(state, X.id, { proto: 'udp', dst: ip, dport: RTP_PORT, quiet: true, data: { kind: 'rtp' } });
  if (!r.ok) return { ok: false, why: r.reason };
  const hops = once(fwd(r));
  const pkt = { proto: 'udp', kind: 'rtp', src: X.ifaces[0].rt.ip, dst: ip, dport: RTP_PORT };
  return { ok: true, hops, pkt, marks: markAlong(state, hops, { ...pkt, dscp: 46, cos: 5 }) };
}

/** 一個方向的品質：把沿路每個出口佇列的延遲、抖動、遺失加起來 */
function pathQuality(state, p) {
  let delay = 25, jit2 = 0, keep = 1, burst = 1;
  const why = [], hops = [];
  p.hops.forEach((h, n) => {
    const eg = egressOf(state, h);
    if (!eg) return;
    const q = (state.rt.qload || {})[dirKey(h)] || { offered: 0, fixed: 0, elastic: [], byCls: {} };
    const f = queueFate(eg, q, p.marks[n], p.pkt, eg.dev);
    const pol = policerFate(eg, q);
    const cable = state.cables.find((c) => c.id === h.cable);
    delay += f.delay + (cable && +cable.cir > 0 ? 2 : 0.01); // 營運商的網路多 2 毫秒
    jit2 += f.jitter * f.jitter;
    const loss = 1 - (1 - f.loss / 100) * (1 - (pol ? pol.loss / 100 : 0));
    keep *= 1 - loss;
    if (f.loss > 0 || pol) burst = 2;
    const where = `${state.devices[h.from].name} → ${state.devices[h.to].name}`;
    if (f.why) why.push(`${where}：${f.why}`);
    if (pol) why.push(`${where}：${pol.why}`);
    hops.push({ from: h.from, to: h.to, dscp: p.marks[n], cls: f.cls, delay: f.delay, loss: Math.round(loss * 1000) / 10 });
  });
  const q = { delay: Math.round(delay * 10) / 10, jitter: Math.round(Math.sqrt(jit2) * 10) / 10, loss: Math.round((1 - keep) * 1000) / 10, burst };
  const m = mosOf(q);
  // 一開始的標記：語音是 EF；如果到了某一站變成別的值，說明是誰改的
  const notes = (p.marks.notes || []).filter(Boolean);
  if (notes.length) why.unshift(...notes.map((t) => t + '：後面的設備認不出這是語音'));
  return { ...q, ...m, why, hops };
}

/** 兩支電話之間的通話品質（雙向）。回傳 { ok, why, ab, ba, mos } */
export function callQuality(state, aId, bId) {
  const A = state.devices[aId], B = state.devices[bId];
  if (!isPhone(A) || !isPhone(B)) return { ok: false, why: '只有 IP 電話之間才能通話' };
  for (const X of [A, B]) {
    const st = phoneState(state, X);
    if (st.st !== 'reg') return { ok: false, why: `${X.name} 沒有註冊：${st.why || PHONE_TEXT[st.st]}` };
  }
  if (phoneState(state, A).cucm !== phoneState(state, B).cucm) return { ok: false, why: '兩支電話註冊在不同的 CUCM，彼此找不到對方的分機' };
  const ab = mediaPath(state, A, B), ba = mediaPath(state, B, A);
  if (!ab.ok && !ba.ok) return { ok: false, why: `電話響了也接起來了，但雙方都聽不到聲音：語音封包 (RTP，UDP ${RTP_PORT}) 送不過去 — ${ab.why}` };
  if (!ab.ok) return { ok: false, oneWay: true, why: `單向通話：${B.name} 聽不到 ${A.name} 的聲音 — ${ab.why}` };
  if (!ba.ok) return { ok: false, oneWay: true, why: `單向通話：${A.name} 聽不到 ${B.name} 的聲音 — ${ba.why}` };
  const qa = pathQuality(state, ab), qb = pathQuality(state, ba);
  const worst = qa.mos <= qb.mos ? qa : qb;
  return { ok: true, ab: qa, ba: qb, mos: worst.mos, worst, why: worst.why[0] || '' };
}

/**
 * 進行中的通話（state.calls）：先把語音流量算進沿路的出口負載，再算每一通的品質。
 * Q(dirKey) 回傳那個出口的負載紀錄（背景流量已經先放進去了）
 */
export function callsTick(state, Q) {
  const calls = (state.calls || []).filter((c) => c.on !== false && state.devices[c.a] && state.devices[c.b]);
  for (const c of calls) delete c.rt;
  const paths = [];
  for (const c of calls) {
    const A = state.devices[c.a], B = state.devices[c.b];
    if (phoneState(state, A).st !== 'reg' || phoneState(state, B).st !== 'reg') { c.rt = { ok: false, unreg: true, why: '電話沒有註冊' }; continue; }
    for (const [X, Y] of [[A, B], [B, A]]) {
      const p = mediaPath(state, X, Y);
      if (!p.ok) continue;
      p.hops.forEach((h, n) => {
        const q = Q(dirKey(h), h), eg = egressOf(state, h);
        q.fixed += RTP_KBPS; q.offered += RTP_KBPS / 1000;
        const cls = eg && eg.queues ? classify(eg.dev, eg.queues, { ...p.pkt, dscp: p.marks[n] }).cls : null;
        if (cls) (q.byCls[cls] ||= { n: 0, fixed: 0, rate: 0 }).fixed += RTP_KBPS;
      });
      paths.push(p);
    }
  }
  for (const c of calls) if (!(c.rt && c.rt.unreg)) c.rt = callQuality(state, c.a, c.b);
  void paths;
}
