// 負載平衡器（F5 BIG-IP 的 Local Traffic）：Virtual Servers、Pools、Monitors
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, cardHead, badge, grid2, del, bind, isIp, isNum } from './form.js';
import { allMonitors, ltmHealth, poolStatus, availOf, MON_TYPES, LB_METHODS, BUILTIN_MONITORS } from '../engine/ltm.js';

const ST = { up: ['on', 'Available'], unknown: ['warn', 'Unknown'], down: ['off', 'Offline'], disabled: ['warn', 'Disabled'], offline: ['off', 'Forced Offline'] };
const stBadge = (st, text) => badge(ST[st][0], text || ST[st][1]);
const isPortOrAny = (v) => /^\d+$/.test(v) && +v >= 0 && +v <= 65535;

/** Virtual Servers：對外的位址與埠、交給哪個 pool、SNAT、persistence */
export function vsTab(ctx, body) {
  const { dev, state } = ctx, L = dev.ltm;
  body.append(note('muted', 'Virtual server 是用戶端連的位址 (VIP) 與埠。BIG-IP 收下連線，從 pool 裡挑一台健康的成員，把目的位址換成成員的 IP。成員的回應一定要回到 BIG-IP：一臂式 (one-arm) 的架構要開 SNAT Automap，不然成員的預設閘道要是 BIG-IP 的 self IP。'));
  L.virtuals.forEach((v, n) => {
    body.append(h('div', { class: 'card' }, cardHead(v.name || '(未命名)', ctx.live(() => {
      if (v.off) return badge('warn', 'Disabled');
      const p = L.pools.find((x) => x.name === v.pool);
      if (!p) return badge('off', '沒有 pool');
      const s = poolStatus(ltmHealth(state, dev).pools[p.name] || []);
      return s.st === 'up' ? badge('on', 'Available') : s.st === 'unknown' ? badge('warn', 'Unknown') : badge('off', 'Offline');
    }), del(() => { L.virtuals.splice(n, 1); ctx.commit(true); })),
    grid2(
      field('名稱', inp(ctx, ...bind(v, 'name'), { ph: 'vs_web_443' })),
      field('目的位址 (Destination)', inp(ctx, ...bind(v, 'dst'), { ph: '10.0.10.100', check: isIp })),
      field('服務埠 (Service Port)', inp(ctx, () => String(v.port ?? ''), (x) => { v.port = +x; }, { ph: '443', check: isPortOrAny })),
      field('預設的 Pool', sel(ctx, () => v.pool || '', (x) => { v.pool = x; }, [['', '（沒有）'], ...L.pools.map((p) => [p.name, p.name])], { rerender: true })),
      field('來源位址轉換 (SNAT)', sel(ctx, () => v.snat || 'none', (x) => { v.snat = x; }, [['none', 'None'], ['automap', 'Auto Map']])),
      field('Persistence', sel(ctx, () => v.persist || 'none', (x) => { v.persist = x; }, [['none', 'None'], ['source_addr', 'source_addr（同一個來源位址給同一台）']])),
      field('狀態', sel(ctx, () => (v.off ? 'off' : 'on'), (x) => { v.off = x === 'off'; }, [['on', 'Enabled'], ['off', 'Disabled']], { rerender: true }))),
    ctx.live(() => {
      const p = L.pools.find((x) => x.name === v.pool);
      if (!p || v.off) return null;
      const h0 = ltmHealth(state, dev).pools[p.name] || [], a = availOf(h0);
      return a.length ? note('ok', `${v.dst}:${v.port} → pool ${p.name}：可用的成員 ${a.map((x) => x.ip + ':' + x.port).join('、')}`) : note('warn', `pool ${p.name} 沒有可用的成員：連到 ${v.dst}:${v.port} 的連線會被重設 (RST)`);
    })));
  });
  body.append(h('div', { class: 'addrow' }, button('建立 Virtual Server', { ic: 'plus', kind: 'primary', small: true, onclick: () => {
    L.virtuals.push({ name: 'vs_' + (L.virtuals.length + 1), dst: '', port: 443, pool: (L.pools[0] || {}).name || '', snat: 'none', persist: 'none' });
    ctx.commit(true);
  } })));
}

/** Pools：成員、負載平衡的方法、健康檢查；每個成員的狀態與原因 */
export function poolTab(ctx, body) {
  const { dev, state } = ctx, L = dev.ltm;
  body.append(note('muted', 'Pool 是一群提供同一個服務的伺服器（成員 = IP:埠）。健康檢查 (monitor) 失敗的成員會被標成 Offline，不再分到新的連線。tcp 只看埠開不開；http 會送出 Send String、比對回應裡有沒有 Receive String。'));
  const mons = [['', '（沒有健康檢查）'], ...allMonitors(dev).map((m) => [m.name, m.builtin ? m.name : `${m.name}（自訂，${m.type}）`])];
  L.pools.forEach((p, n) => {
    p.members ||= [];
    const used = L.virtuals.filter((v) => v.pool === p.name).map((v) => v.name);
    body.append(h('div', { class: 'card' }, cardHead(p.name || '(未命名)', ctx.live(() => { const s = poolStatus(ltmHealth(state, dev).pools[p.name] || []); return stBadge(s.st === 'offline' ? 'down' : s.st, s.text); }),
      del(() => { if (used.length) return toast(`pool ${p.name} 還被 ${used.join('、')} 使用`, 'bad'); L.pools.splice(n, 1); ctx.commit(true); })),
    grid2(
      field('名稱', inp(ctx, () => p.name, (x) => { const old = p.name; p.name = x.trim(); for (const v of L.virtuals) if (v.pool === old) v.pool = p.name; }, { ph: 'pool_web' })),
      field('健康檢查 (Health Monitor)', sel(ctx, () => p.monitor || '', (x) => { p.monitor = x; }, mons, { rerender: true })),
      field('負載平衡的方法', sel(ctx, () => p.lb || 'round-robin', (x) => { p.lb = x; }, LB_METHODS))),
    h('div', { class: 'thead c-lbm' }, h('span', { text: '成員位址' }), h('span', { text: '埠' }), h('span', { text: '狀態' }), h('span')),
    p.members.map((m, k) => h('div', { class: 'trow c-lbm' },
      inp(ctx, ...bind(m, 'ip'), { ph: '10.0.20.11', check: isIp }),
      inp(ctx, () => String(m.port ?? ''), (x) => { m.port = +x; }, { ph: '80', check: isNum(1, 65535) }),
      sel(ctx, () => m.state || 'enabled', (x) => { m.state = x; }, [['enabled', 'Enabled'], ['disabled', 'Disabled'], ['offline', 'Forced Offline']]),
      del(() => { p.members.splice(k, 1); ctx.commit(true); }))),
    ctx.live(() => (ltmHealth(state, dev).pools[p.name] || []).map((x) => note(x.st === 'up' ? 'ok' : x.st === 'unknown' ? 'muted' : 'warn', `${x.ip}:${x.port} — ${ST[x.st][1]}：${x.why}`))),
    h('div', { class: 'addrow' }, button('新增成員', { ic: 'plus', small: true, onclick: () => { p.members.push({ ip: '', port: (p.members[0] || {}).port || 80, state: 'enabled' }); ctx.commit(true); } }),
      used.length ? h('span', { class: 'muted', text: `使用中：${used.join('、')}` }) : null)));
  });
  body.append(h('div', { class: 'addrow' }, button('建立 Pool', { ic: 'plus', kind: 'primary', small: true, onclick: () => {
    L.pools.push({ name: 'pool_' + (L.pools.length + 1), monitor: 'tcp', lb: 'round-robin', members: [] });
    ctx.commit(true);
  } })));
}

/** Monitors：自訂的健康檢查（內建的 tcp、http、https、gateway_icmp 不能改） */
export function monTab(ctx, body) {
  const { dev } = ctx, L = dev.ltm;
  body.append(h('div', { class: 'card' }, cardHead('內建的健康檢查'),
    BUILTIN_MONITORS.map((m) => h('div', { class: 'line' }, h('b', { class: 'mono', text: m.name }),
      h('span', { class: 'muted', text: m.type === 'tcp' ? 'TCP 連得上就算活著（不管應用程式回什麼）' : m.type === 'gateway_icmp' ? '只 ping：主機活著就算' : `送出 ${m.send}，Receive String 是空的：有任何回應就算活著（連 500 錯誤也算）` })))));
  L.monitors.forEach((m, n) => {
    const used = L.pools.filter((p) => p.monitor === m.name).map((p) => p.name);
    body.append(h('div', { class: 'card' }, cardHead(m.name || '(未命名)', used.length ? badge('on', '使用中') : badge('off', '沒有 pool 使用'),
      del(() => { if (used.length) return toast(`monitor ${m.name} 還被 ${used.join('、')} 使用`, 'bad'); L.monitors.splice(n, 1); ctx.commit(true); })),
    grid2(
      field('名稱', inp(ctx, () => m.name, (x) => { const old = m.name; m.name = x.trim(); for (const p of L.pools) if (p.monitor === old) p.monitor = m.name; }, { ph: 'http_200' })),
      field('類型 (Type)', sel(ctx, () => m.type, (x) => { m.type = x; }, MON_TYPES.map((t) => [t, t.toUpperCase()]), { rerender: true })),
      ...(m.type === 'http' || m.type === 'https' ? [
        field('Send String', inp(ctx, ...bind(m, 'send'), { ph: 'GET /health HTTP/1.1\\r\\nHost: www\\r\\n\\r\\n' })),
        field('Receive String', inp(ctx, ...bind(m, 'recv'), { mono: true, ph: '200 OK' })),
      ] : [])),
    m.type === 'http' || m.type === 'https' ? note('muted', 'Receive String 留空：有回應就算活著。填 200 OK：只有應用程式真的正常 (HTTP 200) 才算活著。') : null));
  });
  body.append(h('div', { class: 'addrow' }, button('建立 Monitor', { ic: 'plus', kind: 'primary', small: true, onclick: () => {
    L.monitors.push({ name: 'http_' + (L.monitors.length + 1), type: 'http', send: 'GET / HTTP/1.1\\r\\nHost: www\\r\\n\\r\\n', recv: '200 OK' });
    ctx.commit(true);
  } })));
}
