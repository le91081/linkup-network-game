// 語音與 QoS 的頁面：IP 電話（螢幕、撥號、網路設定）、CUCM、PoE 預算、路由器的 QoS 政策、交換器的 mls qos
import { h, button, toast } from './dom.js';
import { inp, sel, toggle, field, note, kv, del, cardHead, grid2, bind, badge, isIp, isNum, isMask, ifaceNote } from './form.js';
import { fmtIp, fmtMask } from '../engine/ip.js';
import { CATALOG, peerOf } from '../engine/model.js';
import { fmtDur } from '../engine/sim.js';
import { phoneState, PHONE_TEXT, callQuality, mosText, phoneName, isPhone } from '../engine/voice.js';
import { portNd, setPortNd, neighbors } from '../engine/disc.js';
import { DSCP, dscpName, parseDscp, COS_DSCP_DEFAULT, egressOf } from '../engine/qos.js';
import { deviceTime } from '../engine/ops.js';

const two = (n) => String(n).padStart(2, '0');
const VIA = { cdp: 'CDP', lldp: 'LLDP-MED', manual: '手動設定' };

// ───────────────────────── IP 電話 ─────────────────────────

/** 電話的螢幕：分機、狀態、時間，和真的電話一樣只顯示最重要的事 */
function screen(ctx) {
  const { dev, state } = ctx;
  return ctx.live(() => {
    const st = phoneState(state, dev), i = dev.ifaces[0];
    // 電話的時間來自 CUCM（Date/Time Group 設成台北，UTC+8）
    const t = new Date(deviceTime(state, dev).ms + 8 * 3600000);
    const reg = st.st === 'reg';
    return h('div', { class: 'phone-lcd' + (reg ? ' ok' : st.st === 'off' ? ' off' : ' warn') },
      h('div', { class: 'lcd-top' }, h('span', { text: reg ? `分機 ${st.ext}` : phoneName(dev) }), h('span', { text: st.st === 'off' ? '' : `${two(t.getUTCHours())}:${two(t.getUTCMinutes())}` })),
      h('div', { class: 'lcd-main', text: st.st === 'off' ? '' : PHONE_TEXT[st.st] }),
      st.st !== 'off' && h('div', { class: 'lcd-sub', text: reg ? `${state.devices[st.cucm].name}` : st.why }),
      st.st !== 'off' && st.st !== 'boot' && h('div', { class: 'lcd-foot' },
        h('span', { text: `VLAN ${st.vlan ? st.vlan.vlan + '（' + VIA[st.vlan.via] + '）' : '不帶標籤'}` }),
        h('span', { text: i.rt.ip != null ? fmtIp(i.rt.ip) : '沒有位址' })));
  });
}

/** 撥號：測一次通話，看品質 */
function dialCard(ctx) {
  const { dev, state, app } = ctx;
  const draft = (app.dial ||= {})[dev.id] ||= { ext: '' };
  const out = h('div');
  const run = () => {
    const st = phoneState(state, dev);
    if (st.st !== 'reg') { out.replaceChildren(note('warn', `這支電話還沒有註冊：${st.why || PHONE_TEXT[st.st]}`)); return; }
    const target = Object.values(state.devices).find((x) => isPhone(x) && x !== dev && phoneState(state, x).ext === draft.ext.trim() && phoneState(state, x).cucm === st.cucm);
    if (!target) { out.replaceChildren(note('warn', `撥 ${draft.ext || '（空白）'}：CUCM 找不到這個分機（對方沒有註冊，或號碼不對）`)); return; }
    out.replaceChildren(callResult(ctx, callQuality(state, dev.id, target.id), target));
  };
  const others = Object.values(state.devices).filter((x) => isPhone(x) && x !== dev);
  return h('div', { class: 'card' }, cardHead('撥號'),
    h('div', { class: 'addrow' }, inp({ commit() {} }, ...bind(draft, 'ext'), { ph: '分機號碼，例如 2002' }), button('撥號', { small: true, onclick: run })),
    others.length ? h('p', { class: 'tip', text: '其他電話：' + others.map((x) => `${x.name}（${phoneState(state, x).ext || '未註冊'}）`).join('、') }) : null,
    out,
    h('div', { class: 'toggles' }, toggle(ctx, () => (state.calls || []).some((c) => c.a === dev.id && c.on !== false),
      (on) => {
        state.calls = (state.calls || []).filter((c) => c.a !== dev.id);
        if (!on) return;
        const st = phoneState(state, dev);
        const target = Object.values(state.devices).find((x) => isPhone(x) && x !== dev && phoneState(state, x).ext === draft.ext.trim() && phoneState(state, x).cucm === st.cucm);
        if (!target) { toast('先輸入一個已經註冊的分機號碼'); return; }
        state.calls.push({ id: 'call-' + dev.id, a: dev.id, b: target.id, label: `${dev.name} ↔ ${target.name}` });
      }, '保持通話（掛著不掛斷，持續佔用頻寬，品質會跟著網路的狀況變）', { rerender: true })),
    ctx.live(() => {
      const c = (state.calls || []).find((x) => x.a === dev.id);
      return c && c.rt ? callResult(ctx, c.rt, state.devices[c.b], true) : null;
    }));
}

/** 通話品質：MOS、延遲、抖動、遺失，以及沿路每一站的情形 */
export function callResult(ctx, q, target, live) {
  const { state } = ctx;
  if (!q.ok) return note('warn', q.why);
  const row = (name, x) => h('div', { class: 'call-dir' },
    h('b', { text: name }),
    h('span', { class: 'mono', text: `單向延遲 ${x.mouth} ms · 抖動 ${x.jitter} ms · 遺失 ${x.loss}% · MOS ${x.mos}` }));
  const good = q.mos >= 4.0;
  return h('div', { class: 'card call ' + (good ? 'ok' : 'bad') },
    h('div', { class: 'call-h' }, h('b', { text: `${live ? '通話中' : '試撥'}：${target.name}` }), h('span', { class: 'mos ' + (good ? 'ok' : q.mos >= 3.6 ? 'warn' : 'bad'), text: `MOS ${q.mos}` }), h('span', { class: 'muted', text: mosText(q.mos) })),
    row('我 → 對方', q.ab), row('對方 → 我', q.ba),
    q.worst.why.length ? q.worst.why.map((w) => note('warn', w)) : note('ok', '一路上都沒有排隊：語音不是在 priority 佇列裡，就是線路沒有塞車。'),
    h('details', {}, h('summary', { text: '沿路每一站（送出時的 DSCP、進到哪個佇列）' }),
      q.worst.hops.map((x) => h('div', { class: 'line' }, h('span', { text: `${state.devices[x.from].name} → ${state.devices[x.to].name}` }),
        h('span', { class: 'mono muted', style: { marginLeft: 'auto' }, text: `DSCP ${dscpName(x.dscp)}${x.cls ? ' · ' + x.cls : ''} · ${Math.round(x.delay * 10) / 10} ms${x.loss ? ' · 丟 ' + x.loss + '%' : ''}` })))));
}

export function phoneTab(ctx, body) {
  body.append(screen(ctx),
    h('p', { class: 'tip', text: '電話插上 PoE 之後開機，從交換器的 CDP / LLDP-MED 學到語音 VLAN，用 DHCP 拿位址（option 150 告訴它 TFTP 伺服器），下載設定檔，再向 CUCM 註冊。任何一步卡住，螢幕上都看得到。' }),
    dialCard(ctx), phoneInfoCard(ctx));
}

function phoneInfoCard(ctx) {
  const { dev, state } = ctx;
  return h('div', { class: 'card' }, cardHead('狀態'), ctx.live(() => {
    const i = dev.ifaces[0], st = phoneState(state, dev);
    // 開機中的電話還沒有連線，PoE 要看網路線接在哪個埠
    const l = peerOf(state, dev.id, 'sw');
    const poe = l && (state.rt.poe || {})[l.dev + ':' + l.port];
    const nb = neighbors(state, dev).filter((r) => r.pid === 'sw');
    return [
      kv('電源', poe && poe.state === 'on' ? `PoE · ${state.devices[l.dev].name} ${l.port} · ${poe.watts} W${poe.cdp ? '（用 CDP 協商）' : ''}` : poe && poe.state === 'denied' ? '交換器的 PoE 預算不夠，拒絕供電' : '沒有 PoE'),
      kv('語音 VLAN', st.vlan ? `${st.vlan.vlan}（從 ${VIA[st.vlan.via]} 學到）` : '沒有（語音和電腦一樣不帶標籤，在資料 VLAN 裡）'),
      kv('IP 位址', i.rt.ip != null ? `${fmtIp(i.rt.ip)}/${i.rt.bits}` : '—'),
      kv('TFTP 伺服器', dev.phone.tftp ? `${dev.phone.tftp}（手動）` : (i.rt.tftp || []).length ? `${i.rt.tftp.map(fmtIp).join(', ')}（DHCP option 150）` : '—'),
      kv('鄰居', nb.length ? nb.map((r) => `${r.info.id} ${r.info.port}（${r.proto.toUpperCase()}）`).join('、') : '—'),
      st.st === 'reg' && kv('註冊', `${fmtDur(state.clock - st.since)}前`),
    ];
  }));
}

export function phoneNetTab(ctx, body) {
  const { dev } = ctx;
  const i = dev.ifaces[0], p = dev.phone;
  body.append(h('div', { class: 'card' }, cardHead('網路設定'),
    h('div', { class: 'toggles' }, toggle(ctx, () => i.mode === 'dhcp', (v) => { i.mode = v ? 'dhcp' : 'static'; }, '用 DHCP 取得位址', { rerender: true })),
    i.mode !== 'dhcp' && grid2(
      field('IP 位址', inp(ctx, ...bind(i, 'ip'), { ph: '例如 10.1.110.20', check: isIp })),
      field('子網路遮罩', inp(ctx, ...bind(i, 'mask'), { ph: '255.255.255.0', check: isMask })),
      field('預設閘道', inp(ctx, ...bind(i, 'gateway'), { ph: '例如 10.1.110.1', check: isIp }))),
    ifaceNote(ctx, i)),
  h('div', { class: 'card' }, cardHead('語音 VLAN 與設定檔'),
    grid2(
      field('Admin VLAN ID', inp(ctx, ...bind(p, 'vlan'), { ph: '留空＝從 CDP / LLDP 學', check: isNum(1, 4094) }), '交換器沒有開 CDP / LLDP 時，可以在電話上手動指定'),
      field('備用 TFTP 伺服器', inp(ctx, ...bind(p, 'tftp'), { ph: '留空＝用 DHCP 的 option 150', check: isIp }), 'DHCP 沒有給 option 150 時的替代方案')),
    h('div', { class: 'toggles' },
      toggle(ctx, () => portNd(dev, 'sw').cdp !== false, (v) => setPortNd(dev, 'sw', 'cdp', v), 'CDP（向交換器學語音 VLAN、協商 PoE 瓦數）'),
      toggle(ctx, () => portNd(dev, 'sw').tx !== false, (v) => { setPortNd(dev, 'sw', 'tx', v); setPortNd(dev, 'sw', 'rx', v); }, 'LLDP-MED（非 Cisco 交換器用這個告訴電話語音 VLAN）'),
      toggle(ctx, () => p.pcPort !== false, (v) => { p.pcPort = v; }, 'PC 埠（後面接電腦）'))));
}

// ───────────────────────── CUCM ─────────────────────────

export function cucmTab(ctx, body) {
  const { dev, state } = ctx;
  const c = (dev.cucm ||= { autoReg: false, first: 2001, phones: [] });
  body.append(h('p', { class: 'tip', text: 'Cisco Unified CM：電話用 TFTP 從這裡下載設定檔（SEP + MAC.cnf.xml），再用 SIP (UDP 5060) 註冊。資料庫裡沒有的電話，要開自動註冊才會配給分機。' }),
    h('div', { class: 'card' }, cardHead('自動註冊'),
      h('div', { class: 'toggles' }, toggle(ctx, ...bind(c, 'autoReg'), '自動註冊（新電話自動配一個分機）')),
      field('從哪個分機號碼開始', inp(ctx, () => String(c.first || 2001), (v) => { c.first = +v || 2001; }, { check: isNum(1000, 99999) }))),
    h('div', { class: 'card' }, cardHead(`電話（${(c.phones || []).length}）`), ctx.live(() => {
      const rows = (c.phones || []).map((e, n) => {
        const ph = Object.values(state.devices).find((x) => isPhone(x) && x.ifaces[0].rt && x.ifaces[0].rt.mac === String(e.mac).toLowerCase());
        const st = ph && phoneState(state, ph);
        return h('div', { class: 'trow c-cucm' },
          h('span', { class: 'mono', text: 'SEP' + String(e.mac).replace(/:/g, '').toUpperCase() }),
          inp(ctx, ...bind(e, 'ext'), { ph: '分機', check: isNum(1000, 99999) }),
          h('span', { text: ph ? ph.name : '（找不到這支電話）' }),
          st && st.st === 'reg' && st.cucm === dev.id ? badge('on', '已註冊') : badge('off', st ? PHONE_TEXT[st.st] : '離線'),
          del(() => { c.phones.splice(n, 1); ctx.commit(true); }));
      });
      return rows.length ? rows : note('muted', '資料庫裡還沒有任何電話。');
    }),
    h('div', { class: 'addrow' }, sel({ commit() {} }, () => '', (v) => { ctx.app.cucmPick = v; }, [['', '把場上的電話加進資料庫…'],
      ...Object.values(state.devices).filter((x) => isPhone(x) && !(c.phones || []).some((e) => e.mac === x.ifaces[0].rt.mac)).map((x) => [x.id, `${x.name}（${phoneName(x)}）`])]),
      button('加入', { small: true, onclick: () => {
        const x = state.devices[ctx.app.cucmPick];
        if (!x) return toast('先選一支電話');
        const used = new Set((c.phones || []).map((e) => +e.ext));
        let ext = +c.first || 2001;
        while (used.has(ext)) ext++;
        (c.phones ||= []).push({ mac: x.ifaces[0].rt.mac, ext: String(ext), name: x.name });
        ctx.commit(true);
      } }))));
}

// ───────────────────────── PoE ─────────────────────────

export function poeCard(ctx) {
  const { dev, state } = ctx;
  if (!dev.ports.some((p) => p.poe)) return null;
  const budget = CATALOG[dev.model].poeBudget || 0;
  return h('div', { class: 'card' }, cardHead('PoE 供電'), ctx.live(() => {
    const rows = dev.ports.filter((p) => p.poe).map((p) => ({ p, e: (state.rt.poe || {})[dev.id + ':' + p.id] })).filter((r) => r.e);
    const used = rows.reduce((a, r) => a + (r.e.state === 'on' ? r.e.alloc : 0), 0);
    return [
      h('div', { class: 'ubar' + (used / budget > 0.9 ? ' hot' : '') }, h('i', { style: { width: Math.min(100, (used / budget) * 100) + '%' } })),
      h('p', { class: 'tip', text: `預算 ${budget} W，已保留 ${used.toFixed(1)} W，剩 ${(budget - used).toFixed(1)} W。交換器依 PoE 等級先保留上限；Cisco 設備開著 CDP 時會協商出實際用量，保留得比較少。` }),
      ...rows.map(({ p, e }) => h('div', { class: 'line' }, h('b', { class: 'mono', text: p.label }), h('span', { text: state.devices[e.pd].name }),
        h('span', { class: 'mono muted', style: { marginLeft: 'auto' }, text: e.state === 'on' ? `Class ${e.cls} · 保留 ${e.alloc.toFixed(1)} W` : e.state === 'denied' ? '預算不夠，拒絕供電' : e.state === 'never' ? 'power inline never' : '沒有供電' }))),
    ];
  }));
}

// ───────────────────────── 交換器的 QoS（mls qos） ─────────────────────────

export function mlsQosCard(ctx) {
  const { dev } = ctx;
  if (dev.kind !== 'mswitch') return null;
  const sw = dev.sw;
  const q = () => (sw.qos ||= { on: false });
  return h('div', { class: 'card' }, cardHead('QoS（mls qos）'),
    h('div', { class: 'toggles' }, toggle(ctx, () => !!(sw.qos && sw.qos.on), (v) => { q().on = v; }, '開啟 mls qos', { rerender: true })),
    sw.qos && sw.qos.on
      ? note('warn', '開了 mls qos 之後，沒有設定信任 (trust) 的埠會把收到的 DSCP 與 CoS 全部改成 0。接電話的埠要設定信任，或用 auto qos voip cisco-phone。')
      : note('muted', 'mls qos 沒有開：交換器不看也不改封包上的標記，原樣轉送。'),
    field('CoS → DSCP 對應', h('span', { class: 'mono', text: ((sw.qos && sw.qos.cosDscp) || COS_DSCP_DEFAULT).map((x, n) => `${n}→${x}`).join('  ') }),
      '預設 CoS 5 對應到 DSCP 40 (CS5)，不是語音用的 EF (46)。AutoQoS 會把它改成 46'),
    button('CoS 5 → EF（和 AutoQoS 一樣）', { small: true, onclick: () => { q().cosDscp = [0, 8, 16, 26, 32, 46, 48, 56]; ctx.commit(true); } }));
}

/** 交換器埠的信任設定（放在連接埠的進階設定裡） */
export function portTrustField(ctx, pc) {
  if (ctx.dev.kind !== 'mswitch') return null;
  const v = pc.trustDevice ? 'phone' : pc.qosTrust || '';
  return field('QoS 信任 (mls qos trust)', sel(ctx, () => v, (x) => {
    delete pc.trustDevice; delete pc.qosTrust;
    if (x === 'phone') { pc.qosTrust = 'cos'; pc.trustDevice = 'cisco-phone'; } else if (x) pc.qosTrust = x;
  }, [['', '不信任（mls qos 開著時標記歸零）'], ['dscp', '信任 DSCP'], ['cos', '信任 CoS'], ['phone', '只信任 Cisco IP 電話（trust device cisco-phone）']]), 'mls qos 沒開時這個設定沒有作用');
}

// ───────────────────────── 路由器的 QoS（class-map / policy-map） ─────────────────────────

const DSCP_OPTS = [['', '（不改）'], ...Object.entries(DSCP).map(([k, v]) => [String(v), `${k} (${v})`])];

export function qosTab(ctx, body) {
  const { dev } = ctx;
  dev.classMaps ||= {}; dev.policyMaps ||= {};
  body.append(h('p', { class: 'tip', text: '三個步驟：class-map 把流量分類（例如 DSCP EF 是語音）→ policy-map 決定每一類怎麼處理（priority、bandwidth、shape）→ 在介面上 service-policy output 套用。壅塞只會發生在出口，所以 QoS 要做在出口。' }),
    wizardCard(ctx), classMapsCard(ctx), policyMapsCard(ctx), attachCard(ctx));
}

/** 一鍵建立常見的語音 QoS：VOICE (EF) 走 LLQ、其他公平佇列，外層整形到營運商的合約頻寬 */
function wizardCard(ctx) {
  const { dev, state } = ctx;
  const w = (ctx.app.qosWiz ||= {});
  const ifs = dev.ifaces.filter((i) => i.bind.t === 'port' || i.bind.t === 'sub');
  return h('div', { class: 'card' }, cardHead('快速建立：語音優先'),
    grid2(
      field('套用在介面（出口）', sel({ commit() {} }, () => w.iface || '', (v) => { w.iface = v; }, [['', '選一個介面…'], ...ifs.map((i) => [i.id, i.label])])),
      field('整形到 (Mbps)', inp({ commit() {} }, () => w.mbps || '', (v) => { w.mbps = v; }, { ph: '營運商的合約頻寬；不需要就留空', check: isNum(1, 100000) })),
      field('語音保留', sel({ commit() {} }, () => w.pct || '30', (v) => { w.pct = v; }, [['10', '10%'], ['20', '20%'], ['30', '30%'], ['33', '33%']]))),
    button('建立並套用', { small: true, onclick: () => {
      const i = dev.ifaces.find((x) => x.id === w.iface);
      if (!i) return toast('先選擇要套用的介面', 'bad');
      dev.classMaps.VOICE = { any: true, rules: [{ t: 'dscp', v: [46] }] };
      dev.policyMaps['VOICE-PRIORITY'] = [{ cls: 'VOICE', priority: { pct: +(w.pct || 30) } }, { cls: 'class-default', fq: true }];
      if (+w.mbps > 0) {
        dev.policyMaps[`SHAPE-${+w.mbps}M`] = [{ cls: 'class-default', shape: { bps: +w.mbps * 1e6 }, child: 'VOICE-PRIORITY' }];
        i.qosOut = `SHAPE-${+w.mbps}M`;
      } else i.qosOut = 'VOICE-PRIORITY';
      toast(`已在 ${i.label} 套用 ${i.qosOut}`, 'ok');
      ctx.commit(true);
    } }),
    note('muted', '等於在 CLI 下 class-map match-any VOICE / match dscp ef、policy-map VOICE-PRIORITY（priority percent + class-default fair-queue），再用 parent policy 的 shape average 包起來。'));
  void state;
}

function classMapsCard(ctx) {
  const { dev } = ctx;
  const draft = (ctx.app.cmDraft ||= { name: '' });
  const ruleText = (r) => (r.t === 'any' ? 'any' : r.t === 'dscp' ? `dscp ${r.v.map(dscpName).join(' ')}` : r.t === 'cos' ? `cos ${r.v.join(' ')}` : r.t === 'acl' ? `access-group ${r.v}` : `protocol ${r.v}`);
  const parseRule = (t) => {
    const w = t.trim().toLowerCase().split(/\s+/);
    if (w[0] === 'any') return { t: 'any' };
    if (w[0] === 'dscp') { const v = w.slice(1).map(parseDscp); return v.length && v.every((x) => x != null) ? { t: 'dscp', v } : null; }
    if (w[0] === 'cos') { const v = w.slice(1).map(Number); return v.length && v.every((x) => x >= 0 && x <= 7) ? { t: 'cos', v } : null; }
    if (w[0] === 'access-group' && w[1]) return { t: 'acl', v: w[w.length - 1].toUpperCase() };
    if (w[0] === 'protocol' && ['rtp', 'sip'].includes(w[1])) return { t: 'protocol', v: w[1] };
    return null;
  };
  return h('div', { class: 'card' }, cardHead('Class-map（分類）'),
    Object.entries(dev.classMaps).map(([name, m]) => h('div', { class: 'qos-cm' },
      h('div', { class: 'line' }, h('b', { class: 'mono', text: name }), sel(ctx, () => (m.any ? 'any' : 'all'), (v) => { m.any = v === 'any'; }, [['any', 'match-any（符合任一條）'], ['all', 'match-all（全部符合）']]),
        del(() => { delete dev.classMaps[name]; for (const pm of Object.values(dev.policyMaps)) for (let n = pm.length - 1; n >= 0; n--) if (pm[n].cls === name) pm.splice(n, 1); ctx.commit(true); })),
      inp(ctx, () => m.rules.map(ruleText).join('; '), (v) => { const rs = v.split(';').map(parseRule); if (rs.every(Boolean)) m.rules = rs; else toast('看不懂的條件：寫法例如 dscp ef; protocol rtp; access-group VOICE-ACL', 'bad'); },
        { ph: 'dscp ef; protocol rtp; access-group 名稱', mono: true }))),
    h('div', { class: 'addrow' }, inp({ commit() {} }, ...bind(draft, 'name'), { ph: '新的 class-map 名稱，例如 VOICE' }),
      button('新增', { small: true, onclick: () => {
        const n = draft.name.trim();
        if (!/^[\w-]+$/.test(n) || n === 'class-default') return toast('名稱只能有英文、數字、- 與 _', 'bad');
        dev.classMaps[n] ||= { any: true, rules: [{ t: 'dscp', v: [46] }] };
        draft.name = '';
        ctx.commit(true);
      } })));
}

function policyMapsCard(ctx) {
  const { dev } = ctx;
  const draft = (ctx.app.pmDraft ||= { name: '' });
  const pms = Object.keys(dev.policyMaps);
  return h('div', { class: 'card' }, cardHead('Policy-map（處理方式）'),
    Object.entries(dev.policyMaps).map(([name, pm]) => h('div', { class: 'qos-pm' },
      h('div', { class: 'line' }, h('b', { class: 'mono', text: name }),
        sel({ commit() {} }, () => '', (v) => { if (!v || pm.some((c) => c.cls === v)) return; const n = pm.findIndex((c) => c.cls === 'class-default'); const c = { cls: v }; if (v === 'class-default' || n < 0) pm.push(c); else pm.splice(n, 0, c); ctx.commit(true); },
          [['', '加入 class…'], ...[...Object.keys(dev.classMaps), 'class-default'].filter((c) => !pm.some((x) => x.cls === c)).map((c) => [c, c])]),
        del(() => { if (dev.ifaces.some((i) => i.qosIn === name || i.qosOut === name)) return toast('這個政策還套用在介面上，先取消套用', 'bad'); delete dev.policyMaps[name]; ctx.commit(true); })),
      pm.map((c, n) => h('div', { class: 'qos-cls' },
        h('b', { class: 'mono', text: c.cls }),
        sel(ctx, () => (c.priority ? 'pri' : c.bandwidth ? 'bw' : c.fq ? 'fq' : ''), (v) => {
          delete c.priority; delete c.bandwidth; delete c.fq;
          if (v === 'pri') c.priority = { pct: 30 }; else if (v === 'bw') c.bandwidth = { pct: 20 }; else if (v === 'fq') c.fq = true;
        }, [['', '不排隊（FIFO）'], ['pri', 'priority（LLQ，語音用）'], ['bw', 'bandwidth（保證頻寬）'], ['fq', 'fair-queue（公平佇列）']], { rerender: true }),
        (c.priority || c.bandwidth) && inp(ctx, () => String((c.priority || c.bandwidth).pct || ''), (v) => { (c.priority || c.bandwidth).pct = +v || 0; }, { ph: '%', w: '4.5em', check: isNum(1, 100) }),
        sel(ctx, () => (c.set ? String(c.set.dscp) : ''), (v) => { if (v === '') delete c.set; else c.set = { dscp: +v }; }, DSCP_OPTS.map(([v, t]) => [v, v === '' ? '標記不變' : '標成 ' + t])),
        inp(ctx, () => (c.shape ? String(c.shape.bps / 1e6) : ''), (v) => { if (+v > 0) c.shape = { bps: +v * 1e6 }; else delete c.shape; }, { ph: 'shape Mbps', w: '6em', check: isNum(1, 100000) }),
        c.shape && sel(ctx, () => c.child || '', (v) => { if (v) c.child = v; else delete c.child; }, [['', '（沒有子政策）'], ...pms.filter((x) => x !== name).map((x) => [x, '子政策 ' + x])]),
        del(() => { pm.splice(n, 1); ctx.commit(true); }))))),
    h('div', { class: 'addrow' }, inp({ commit() {} }, ...bind(draft, 'name'), { ph: '新的 policy-map 名稱' }),
      button('新增', { small: true, onclick: () => {
        const n = draft.name.trim();
        if (!/^[\w-]+$/.test(n)) return toast('名稱只能有英文、數字、- 與 _', 'bad');
        dev.policyMaps[n] ||= [{ cls: 'class-default' }];
        draft.name = '';
        ctx.commit(true);
      } })));
}

function attachCard(ctx) {
  const { dev, state } = ctx;
  const pms = Object.keys(dev.policyMaps);
  const ifs = dev.ifaces.filter((i) => i.bind.t === 'port' || i.bind.t === 'sub');
  return h('div', { class: 'card' }, cardHead('套用在介面 (service-policy)'),
    ifs.map((i) => h('div', { class: 'qos-if' },
      h('b', { class: 'mono', text: i.label }),
      field('output', sel(ctx, () => i.qosOut || '', (v) => { if (v) i.qosOut = v; else delete i.qosOut; }, [['', '（沒有）'], ...pms.map((x) => [x, x])])),
      field('input', sel(ctx, () => i.qosIn || '', (v) => { if (v) i.qosIn = v; else delete i.qosIn; }, [['', '（沒有）'], ...pms.map((x) => [x, x])])),
      ctx.live(() => {
        const l = state.rt.links[dev.id + ':' + i.bind.port];
        if (!l) return null;
        const hop = { cable: l.cable, from: dev.id, fromPort: i.bind.port, to: l.dev, toPort: l.port, tag: i.bind.t === 'sub' ? i.bind.vlan : null };
        const eg = egressOf(state, hop), q = (state.rt.qload || {})[l.cable + '>' + l.dev];
        if (!eg || !q) return null;
        const cong = q.elastic.length && q.offered >= eg.rate * 0.98;
        return note(cong ? 'warn' : 'muted', `送出：${Math.round(q.rate * 10) / 10} Mbps 資料 + ${Math.round(q.fixed)} kbps 語音；出口速率 ${eg.shape ? `整形到 ${eg.shape} Mbps` : `${eg.phys} Mbps`}${eg.cir ? `，營運商合約 ${eg.cir} Mbps` : ''}${cong ? '：塞車中，佇列一直是滿的' : ''}`);
      }))));
}
void fmtMask; void two;
