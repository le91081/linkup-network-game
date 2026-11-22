// FortiGate 的 HA 分頁：叢集的狀態（誰是主要機、為什麼沒有組成）與 config system ha 的設定
import { h } from './dom.js';
import { inp, toggle, field, note, cardHead, badge, grid2, seg, kv, isNum } from './form.js';
import { newHa, haOn, serialOf, haIfUp } from '../engine/ha.js';

const BY = { monitor: '監控的介面連線正常的比較多', uptime: '它本來就是主要機（HA uptime 比較長）', priority: 'priority 比較高', serial: '其他條件都一樣，序號比較大' };

export function haTab(ctx, body) {
  const { dev, state } = ctx;
  body.append(h('p', { class: 'tip', text: '兩台同型號、同版本的 FortiGate 用 heartbeat 線對接，群組名稱、群組 ID、密碼都一樣，就會組成 HA 叢集 (FGCP)：主要機處理所有流量、把設定同步給次要機；主要機監控的介面斷線或整台故障，次要機馬上接手。' }));
  const ha = dev.ha || newHa();
  const edit = () => (dev.ha ||= newHa());
  const r = (dev.rt && dev.rt.ha) || { role: 'standalone' };
  const peer = r.peer && state.devices[r.peer];

  // ── 狀態 ──
  const roleBadge = !haOn(dev) ? badge('off', '單機 (standalone)') : r.role === 'primary' ? badge(r.lost ? 'warn' : 'on', r.lost ? '主要機（找不到對方）' : '主要機 (primary)') : r.role === 'secondary' ? badge('on', '次要機 (secondary)') : badge('warn', '沒有組成叢集');
  const sc = h('div', { class: 'card ha-status' }, cardHead('叢集狀態', roleBadge), kv('序號', serialOf(dev)));
  if (haOn(dev)) {
    if (peer) sc.append(kv(r.role === 'secondary' ? '主要機' : '另一台', `${peer.name}（${serialOf(peer)}）`));
    if (r.role === 'primary' && !r.lost) sc.append(note('ok', `${dev.name} 是主要機：${BY[r.by] || ''}。設定已經同步給 ${peer ? peer.name : '次要機'}。`));
    if (r.role === 'secondary') sc.append(note('muted', `這台是次要機：資料介面不處理流量，設定由主要機 ${peer ? peer.name : ''} 同步過來（在這裡改的設定會被主要機蓋掉，要改請到主要機）。主要機出問題時這台會接手。`));
    if (r.lost) sc.append(note('warn', `收不到 ${peer ? peer.name : '對方'} 的 heartbeat，這台自己當主要機。如果對方其實還活著（只是 heartbeat 線斷了），兩台會同時當主要機 (split brain)，同一個 IP 出現在兩台上 — 所以 heartbeat 最好接兩條。`));
    if (r.role === 'standalone' && r.why) sc.append(note('warn', `還沒有組成叢集：${r.why}`));
    const mon = ha.monitor || [];
    if (mon.length) sc.append(h('div', { class: 'ha-mon' }, mon.map((n) => kv(`監控 ${n}`, haIfUp(state, dev, n) ? '● 連線正常' : '○ 斷線'))));
  }
  body.append(sc);

  // ── 設定 ──
  const ports = dev.ifaces.filter((i) => i.bind.t === 'port');
  const flipIn = (key, id) => { const x = edit(); const l = x[key] || []; x[key] = l.includes(id) ? l.filter((v) => v !== id) : [...l, id]; };
  const cfg = h('div', { class: 'card ha-cfg' }, cardHead('HA 設定（config system ha）'),
    field('模式', seg(ctx, () => ha.mode, (v) => { edit().mode = v; }, [['standalone', '單機 (standalone)'], ['a-p', 'Active-Passive']])));
  if (haOn(dev)) {
    cfg.append(
      grid2(
        field('群組名稱 (group-name)', inp(ctx, () => ha.group, (v) => { edit().group = v; }, { ph: '例如 FGT-HA', mono: true })),
        field('群組 ID (group-id)', inp(ctx, () => String(ha.gid ?? 0), (v) => { edit().gid = +v || 0; }, { ph: '0', check: isNum(0, 1023) })),
      ),
      grid2(
        field('密碼 (password)', inp(ctx, () => ha.pass, (v) => { edit().pass = v; }, { ph: '兩台要一樣' })),
        field('priority', inp(ctx, () => String(ha.prio ?? 128), (v) => { edit().prio = Math.max(0, Math.min(255, +v || 0)); }, { ph: '128', check: isNum(0, 255) }), '0 – 255，大的優先當主要機（預設 128）'),
      ),
      field('Heartbeat 介面 (hbdev)', h('div', { class: 'chips' }, ports.map((i) => toggle(ctx, () => (ha.hbdev || []).includes(i.id), () => flipIn('hbdev', i.id), i.label, { rerender: true }))),
        '兩台的 heartbeat 介面直接用線對接；這個介面就不要再拿來接其他網路'),
      field('監控的介面 (monitor)', h('div', { class: 'chips' }, dev.ifaces.filter((i) => !(ha.hbdev || []).includes(i.id)).map((i) => toggle(ctx, () => (ha.monitor || []).includes(i.id), () => flipIn('monitor', i.id), i.label, { rerender: true }))),
        '主要機監控的介面斷線時，交給監控的介面比較完整的那一台'),
      toggle(ctx, () => ha.pickup, (v) => { edit().pickup = v; }, '同步連線表 (session-pickup)', { title: '切換之後，進行中的連線（遠端桌面、檔案傳輸、VoIP）不會中斷', rerender: true }),
      toggle(ctx, () => ha.override, (v) => { edit().override = v; }, 'override（priority 高的會搶回主要機）', { rerender: true }),
      note('muted', 'priority 與 override 是每一台自己的設定；其他的設定（群組、heartbeat、監控、session-pickup）組成叢集之後由主要機同步。override disable（預設）時，主要機恢復之後不會搶回角色：比的是 HA uptime。'),
    );
  }
  body.append(cfg);
}
