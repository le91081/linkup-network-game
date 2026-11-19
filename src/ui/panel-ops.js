// 維運相關的頁面：伺服器角色（TFTP / FTP / Syslog / NTP / 網管）、檔案、SNMP 網管、背景流量、SSH 設定
import { h, button, toast } from './dom.js';
import { inp, sel, toggle, field, note, kv, del, cardHead, grid2, bind, isIp, isNum } from './form.js';
import { fmtIp, parseIp } from '../engine/ip.js';
import { fmtDur } from '../engine/sim.js';
import { isTftp, isFtp, fmtBytes, isCiscoOs } from '../engine/files.js';
import { nmsOf, pollOne } from '../engine/snmp.js';
import { genKey, vtyMode, hostKey } from '../engine/remote.js';

const SERVER_MODELS = new Set(['tower', 'rack1u', 'nas']);
export const isServer = (d) => SERVER_MODELS.has(d.model);

// ───────────────────────── 伺服器角色 ─────────────────────────

const ROLES = [
  ['tftp', 'TFTP 伺服器', 'udp', 69, '備份設定、放韌體。不用帳號密碼，任何人都能讀寫'],
  ['ftp', 'FTP 伺服器', 'tcp', 21, '要帳號密碼，但帳號密碼和檔案內容都是明文'],
  ['syslog', 'Syslog 伺服器', 'udp', 514, '收集各設備送來的紀錄'],
  ['ntp', 'NTP 伺服器', 'udp', 123, '替其他設備報時'],
  ['nms', 'SNMP 網管 (NMS)', 'udp', 162, '定時向設備查詢流量與狀態，也接收設備送來的 Trap'],
];
const hasRole = (d, proto, port) => (d.services || []).some((s) => s.proto === proto && s.port === port);

export function serverRolesCard(ctx) {
  const { dev } = ctx;
  return h('div', { class: 'card' }, cardHead('伺服器角色'),
    h('p', { class: 'tip', text: '這台伺服器上跑哪些服務。開啟之後，其他設備才連得到對應的連接埠。' }),
    h('div', { class: 'toggles' }, ROLES.map(([id, label, proto, port, hint]) => toggle(ctx, () => hasRole(dev, proto, port), (on) => {
      dev.services = (dev.services || []).filter((s) => !(s.proto === proto && s.port === port));
      if (on) dev.services.push({ proto, port, name: label.replace(/ 伺服器| \(NMS\)/, '') });
      if (id === 'tftp' || id === 'ftp') dev.files ||= {};
      if (id === 'ftp' && on) dev.ftpUsers ||= [{ user: 'backup', pass: 'Backup#2026' }];
      if (id === 'nms') { if (on) dev.nms ||= { targets: [] }; else delete dev.nms; }
    }, `${label}（${proto.toUpperCase()} ${port}）`, { rerender: true, title: hint })),
    toggle(ctx, () => !!dev.cucm, (on) => {
      // CUCM 同時提供 TFTP（電話的設定檔）與 SIP（註冊、撥號）
      if (on) {
        dev.cucm ||= { autoReg: true, first: 2001, phones: [] };
        for (const [proto, port, name] of [['udp', 69, 'TFTP'], ['udp', 5060, 'SIP']]) if (!hasRole(dev, proto, port)) (dev.services ||= []).push({ proto, port, name });
        dev.files ||= {};
      } else {
        delete dev.cucm;
        dev.services = (dev.services || []).filter((x) => !(x.proto === 'udp' && x.port === 5060));
      }
    }, 'Cisco Unified CM（IP 電話的通話伺服器：TFTP 69 + SIP 5060）', { rerender: true, title: '電話從這裡下載設定檔並註冊' })));
}

// ───────────────────────── 檔案 ─────────────────────────

export function filesTab(ctx, body) {
  const { dev, state } = ctx;
  const files = (dev.files ||= {});
  body.append(h('p', { class: 'tip', text: '網路設備用 TFTP / FTP 把設定備份到這裡，也從這裡下載設定與韌體。設備端的指令：copy running-config tftp:、copy tftp: flash:（Cisco），execute backup config tftp …（FortiGate）。' }));
  const card = h('div', { class: 'card' }, cardHead(`檔案（${Object.keys(files).length}）`));
  const names = Object.keys(files).sort();
  if (!names.length) card.append(note('muted', '還沒有任何檔案。'));
  for (const n of names) {
    const f = files[n];
    card.append(h('div', { class: 'line' }, h('b', { class: 'mono', text: n }),
      h('span', { class: 'mono muted', style: { marginLeft: 'auto' }, text: `${fmtBytes(f.size)} · ${f.kind === 'config' ? '設定檔' : f.kind === 'image' ? '韌體' : '其他'}${f.t >= 0 ? ` · ${fmtDur(state.clock - f.t)}前` : ''}` }),
      del(() => { delete files[n]; ctx.commit(true); })));
    if (f.kind === 'image') card.append(h('div', { class: 'mono muted', style: { fontSize: '11px', paddingLeft: '4px' }, text: `MD5 ${f.md5}` }));
  }
  body.append(card);
  if (isFtp(dev)) {
    const users = (dev.ftpUsers ||= []);
    const c2 = h('div', { class: 'card' }, cardHead('FTP 帳號'), h('div', { class: 'thead c-user' }, h('span', { text: '帳號' }), h('span', { text: '密碼' }), h('span')));
    users.forEach((u, n) => c2.append(h('div', { class: 'trow c-user' }, inp(ctx, ...bind(u, 'user'), { ph: '帳號', mono: false }), inp(ctx, ...bind(u, 'pass'), { ph: '密碼' }), del(() => { users.splice(n, 1); ctx.commit(true); }))));
    c2.append(h('div', { class: 'addrow' }, button('新增帳號', { ic: 'plus', small: true, onclick: () => { users.push({ user: '', pass: '' }); ctx.commit(true); } })),
      note('warn', 'FTP 的帳號密碼和 Telnet 一樣是明文：在線路上側錄就看得到。'));
    body.append(c2);
  }
  void isTftp;
}

// ───────────────────────── SNMP 網管 ─────────────────────────

const pct = (x) => (x == null ? '—' : x < 0.1 && x > 0 ? '<0.1%' : `${x.toFixed(x < 10 ? 1 : 0)}%`);
function bar(v) {
  const w = Math.max(0, Math.min(100, v || 0));
  return h('span', { class: 'ubar' + (w >= 80 ? ' hot' : w >= 50 ? ' warm' : '') }, h('i', { style: { width: w + '%' } }));
}
function spark(hist, key) {
  if (!hist || hist.length < 2) return null;
  const W = 120, H = 22, n = hist.length;
  const pts = hist.map((x, k) => `${((k / (n - 1)) * W).toFixed(1)},${(H - (Math.min(100, x[key]) / 100) * H).toFixed(1)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'spark');
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', pts);
  svg.append(pl);
  return svg;
}
const TRAP_TEXT = { linkDown: '介面斷線', linkUp: '介面上線', coldStart: '設備重新開機', authenticationFailure: '有人用錯誤的 community 查詢' };

export function nmsTab(ctx, body) {
  const { dev, state, app } = ctx;
  const cfg = (dev.nms ||= { targets: [] });
  body.append(h('p', { class: 'tip', text: '網管伺服器每 60 秒用 SNMP 問一次每台設備：各個介面收送了多少位元組、有沒有錯誤。兩次之間的差就是使用率。設備那一端要先開啟 SNMP，而且帳號 / community 要對得上。' }));
  const card = h('div', { class: 'card' }, cardHead('監控的設備'));
  cfg.targets.forEach((t, n) => {
    card.append(h('div', { class: 'sub' },
      grid2(
        field('設備 IP', inp(ctx, ...bind(t, 'ip'), { ph: '例如 10.0.99.2', check: isIp })),
        field('版本', sel(ctx, () => t.ver || 'v2c', (v) => { t.ver = v; }, [['v2c', 'v2c（community）'], ['v3', 'v3（帳號 + 認證 + 加密）']], { rerender: true })),
        (t.ver || 'v2c') === 'v2c' && field('Community', inp(ctx, ...bind(t, 'community'), { ph: '例如 public' })),
        t.ver === 'v3' && field('使用者', inp(ctx, ...bind(t, 'user'), { ph: '例如 nms', mono: false })),
        t.ver === 'v3' && field('認證密碼 (SHA)', inp(ctx, ...bind(t, 'auth'), { ph: '至少 8 個字元' })),
        t.ver === 'v3' && field('加密密碼 (AES)', inp(ctx, ...bind(t, 'priv'), { ph: '至少 8 個字元' }))),
      h('div', { class: 'addrow' }, del(() => { cfg.targets.splice(n, 1); ctx.commit(true); }, '不再監控這台'))));
  });
  card.append(h('div', { class: 'addrow' },
    button('新增監控的設備', { ic: 'plus', small: true, onclick: () => { cfg.targets.push({ ip: '', ver: 'v2c', community: '' }); ctx.commit(true); } }),
    button('立刻輪詢一次', { small: true, onclick: () => { for (const t of cfg.targets) if (t.ip) pollOne(state, dev, t); app.refreshLive(); toast('已經向每台設備查詢一次（使用率要有兩次輪詢才算得出來）'); } })));
  body.append(card);
  body.append(ctx.live(() => {
    const r = nmsOf(state, dev.id);
    return cfg.targets.filter((t) => t.ip).map((t) => {
      const x = r.targets[t.ip];
      if (!x) return h('div', { class: 'card' }, cardHead(t.ip), note('muted', '還沒有輪詢過（每 60 秒一次）。'));
      if (!x.ok) return h('div', { class: 'card' }, cardHead(t.ip), note('warn', `沒有回應：${x.why}`), note('muted', `上次查詢 ${fmtDur(state.clock - x.t)}前`));
      const ifs = Object.entries(x.ifs).filter(([, i]) => i.up);
      return h('div', { class: 'card' }, cardHead(`${x.sys.name}（${t.ip}）`),
        h('div', { class: 'kv ok' }, kv('開機時間', fmtDur(x.sys.uptime)), kv('版本', x.sys.descr), x.sys.location && kv('位置', x.sys.location), kv('上次查詢', `${fmtDur(state.clock - x.t)}前`)),
        ifs.length ? h('div', { class: 'nms-ifs' }, ifs.map(([pid, i]) => h('div', { class: 'nms-if' + (i.errD > 0 ? ' bad' : '') },
          h('b', { class: 'mono', text: i.name }), h('span', { class: 'mono muted', text: i.speed >= 1000 ? i.speed / 1000 + 'G' : i.speed + 'M' }),
          h('span', { class: 'mono', text: '收' }), bar(i.util && i.util.in), h('span', { class: 'mono', text: pct(i.util && i.util.in) }),
          h('span', { class: 'mono', text: '送' }), bar(i.util && i.util.out), h('span', { class: 'mono', text: pct(i.util && i.util.out) }),
          spark(x.hist[pid], i.util && i.util.in > i.util.out ? 'in' : 'out'),
          i.errD > 0 && h('em', { text: `這段時間多了 ${i.errD} 個錯誤` })))) : note('muted', '沒有任何介面在線上。'),
        ifs.some(([, i]) => !i.util) && note('muted', '使用率要等第二次輪詢才算得出來。'));
    });
  }));
  body.append(h('div', { class: 'card' }, cardHead('收到的 Trap'), ctx.live(() => {
    const tr = nmsOf(state, dev.id).traps;
    if (!tr.length) return note('muted', '還沒有收到任何 Trap。設備要設定 Trap 的接收端（snmp-server host）並開啟 snmp-server enable traps，發生事件時才會主動通知。');
    return tr.slice(-20).reverse().map((x) => h('div', { class: 'line' }, h('b', { class: 'mono', text: x.from }),
      h('span', { text: `${x.info && x.info.admin ? '介面被關閉 (shutdown)' : TRAP_TEXT[x.kind] || x.kind}${x.info && x.info.ifName ? '：' + x.info.ifName : ''}` }), h('span', { class: 'muted', style: { marginLeft: 'auto' }, text: `${fmtDur(state.clock - x.t)}前` })));
  })));
}

// ───────────────────────── 背景流量 ─────────────────────────

export function flowsCard(ctx) {
  const { dev, state } = ctx;
  const all = (state.flows ||= []);
  const mine = all.filter((f) => f.from === dev.id);
  const card = h('div', { class: 'card' }, cardHead('持續傳輸（背景流量）'),
    h('p', { class: 'tip', text: '讓這台主機一直送資料到另一個位址（像是備份或影音串流）。共用同一條線的其他連線會被分走頻寬。' }));
  for (const f of mine) {
    card.append(h('div', { class: 'sub' },
      grid2(
        field('名稱', inp(ctx, ...bind(f, 'label'), { ph: '例如 夜間備份', mono: false })),
        field('目的 IP', inp(ctx, ...bind(f, 'ip'), { ph: '例如 10.0.10.20', check: isIp })),
        field('想要的速率 (Mbps)', inp(ctx, () => String(f.mbps ?? ''), (v) => { f.mbps = +v || 0; }, { ph: '例如 400', check: isNum(1, 100000) }))),
      h('div', { class: 'toggles' }, toggle(ctx, () => f.on !== false, (v) => { f.on = v; }, '傳輸中')),
      ctx.live(() => {
        const r = f.rt;
        if (f.on === false) return note('muted', '已暫停。');
        if (!r) return null;
        if (r.why) return note('warn', `送不出去：${r.why}`);
        return note(r.full ? 'warn' : 'ok', `目前 ${r.mbps} Mbps${r.full ? `，想要 ${f.mbps}：瓶頸在 ${r.where}` : ''}`);
      }),
      h('div', { class: 'addrow' }, del(() => { state.flows = all.filter((x) => x !== f); ctx.commit(true); }, '刪除這個傳輸'))));
  }
  card.append(h('div', { class: 'addrow' }, button('新增持續傳輸', { ic: 'plus', small: true, onclick: () => { all.push({ id: 'f' + Date.now().toString(36), from: dev.id, ip: '', mbps: 100, label: '', on: true }); ctx.commit(true); } })));
  return card;
}

// ───────────────────────── SSH ─────────────────────────

export function sshCard(ctx) {
  const { dev, state } = ctx;
  if (!isCiscoOs(dev)) return null;
  const m = dev.mgmt;
  return h('div', { class: 'card' }, cardHead('SSH 與遠端登入'),
    grid2(
      field('網域名稱 (ip domain name)', inp(ctx, ...bind(m, 'domain'), { ph: '例如 corp.local' })),
      field('SSH 版本', sel(ctx, () => (m.sshVer === 2 ? '2' : '1.99'), (v) => { if (v === '2') m.sshVer = 2; else delete m.sshVer; }, [['1.99', '1.99（相容 1 與 2）'], ['2', '只用 2（建議）']])),
      field('vty 的登入方式', sel(ctx, () => vtyMode(dev), (v) => { m.vtyLogin = v; }, [['local', 'login local（本機帳號）'], ['line', 'login（線路密碼）'], ['none', 'no login（不驗證）']], { rerender: true })),
      vtyMode(dev) === 'line' && field('線路密碼 (password)', inp(ctx, () => m.vtyPass || '', (v) => { if (v) m.vtyPass = v; else delete m.vtyPass; }, { ph: '沒有設定就不能 Telnet 進來' }))),
    ctx.live(() => {
      const k = m.sshKey;
      return h('div', { class: 'kv ' + (k && k.bits >= 768 ? 'ok' : '') },
        kv('RSA 金鑰', k ? `${k.bits} 位元` : '沒有（SSH 沒有啟用）'), k && kv('指紋', hostKey(dev)));
    }),
    h('div', { class: 'addrow' }, button(m.sshKey ? '重新產生 RSA 金鑰' : '產生 RSA 金鑰（2048 位元）', {
      small: true, kind: m.sshKey ? '' : 'primary',
      onclick: () => {
        const e = genKey(state, dev, 2048);
        if (e) toast(e.replace(/^% /, '').replace('Please define a hostname other than', '請先把主機名稱改掉，不能是').replace('Please define a domain-name first.', '請先設定網域名稱。'), 'bad', 4000);
        else toast(`已產生 2048 位元的 RSA 金鑰${m.sshKey.gen > 1 ? '。連過這台設備的電腦會發現指紋變了' : ''}`, 'ok');
        ctx.commit(true);
      },
    })),
    ctx.live(() => {
      const w = [];
      if (vtyMode(dev) === 'none') w.push('no login：任何人連進來都不用帳號密碼就能下指令。');
      if (vtyMode(dev) !== 'local' && m.ssh) w.push('SSH 要用本機帳號登入：登入方式請選 login local。');
      if (!m.sshKey) w.push(/^(Router|Switch)$/i.test(dev.name) ? '產生金鑰之前，要先把主機名稱改掉（不能是原廠的 Router / Switch），也要設定網域名稱。' : '產生金鑰之前要先設定網域名稱。');
      return w.map((x) => note('warn', x));
    }));
}

// ───────────────────────── SNMP（設備端）─────────────────────────

export function snmpExtra(ctx) {
  const m = ctx.dev.mgmt, fw = ctx.dev.kind === 'firewall';
  const ver = m.snmp || 'off';
  if (ver === 'off') return null;
  const u = (m.snmpUser ||= { user: '', auth: '', priv: '' });
  return h('div', { class: 'sub' },
    fw && h('div', { class: 'toggles' }, toggle(ctx, ...bind(m, 'snmpAgent'), 'SNMP 代理（config system snmp sysinfo 的 status）')),
    ver === 'v3' && grid2(
      field('SNMPv3 使用者', inp(ctx, ...bind(u, 'user'), { ph: '例如 nms', mono: false })),
      field('認證密碼 (SHA)', inp(ctx, ...bind(u, 'auth'), { ph: '至少 8 個字元' })),
      field('加密密碼 (AES)', inp(ctx, ...bind(u, 'priv'), { ph: '至少 8 個字元' }))),
    !fw && grid2(
      field('Trap 接收端', inp(ctx, () => ((m.trapHosts || [])[0] || {}).ip || '', (v) => {
        m.trapHosts = v && parseIp(v) != null ? [{ ip: v, ver, name: ver === 'v3' ? u.user : m.community || '' }] : [];
      }, { ph: '例如 10.0.99.20', check: isIp })),
      h('div', { class: 'toggles' }, toggle(ctx, ...bind(m, 'traps'), '送出 Trap（snmp-server enable traps）'))),
    fw && field('允許查詢的網管位址 (hosts)', inp(ctx, () => (m.snmpHosts || []).join(', '), (v) => { m.snmpHosts = v.split(/[,\s]+/).filter(Boolean).map((x) => (x.includes('/') ? x : x + '/32')); }, { ph: '例如 10.0.99.20' })),
    fw && note('muted', 'FortiGate 還要在接收查詢的介面上開放 snmp（介面分頁的「允許的管理協定」）。'),
    void fmtIp);
}
