// 雲端主控台（以 AWS 的 VPC 主控台為藍本）：VPC、子網路、路由表、EC2、安全群組、網路 ACL、NAT 閘道、站對站 VPN
import { h, button, icon, toast, ownKeys, escLine } from './dom.js';
import { inp, sel, toggle, field, note, kv, del, cardHead, grid2, bind, badge } from './form.js';
import { parseIp, parseCidr, fmtIp, netOf } from '../engine/ip.js';
import { transact } from '../engine/sim.js';
import { rttSamples } from '../engine/latency.js';
import { subnetOf, rtOf, naclOf, isPublic, reservedWhy, CLOUD_REGION, AWS_P1, AWS_DH, awsPsk, vpnConfig, lbIp, peerState, tgwRoutes } from '../engine/cloud.js';

const isCidr = (v) => v.includes('/') && parseCidr(v) != null;
const isIpv4 = (v) => parseIp(v) != null;
let seq = 0;
/** AWS 風格的資源 ID：subnet-0a1b2c3d4e5f6789a */
export function awsId(prefix, seed = '') {
  let x = 2166136261;
  const s = `${prefix}/${seed}/${Date.now()}/${++seq}`;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  let y = x >>> 0, hex = '';
  for (let i = 0; i < 17; i++) { y = Math.imul(y ^ (y >>> 13), 1103515245) + 12345 >>> 0; hex += (y % 16).toString(16); }
  return `${prefix}-0${hex.slice(0, 16)}`;
}
const AZS = ['a', 'c', 'd'].map((z) => [`${CLOUD_REGION}${z}`, `${CLOUD_REGION}${z}`]);
const PROTOS = [['all', '全部流量'], ['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP']];
const tip = (t) => h('p', { class: 'tip', text: t });
const typeBadge = (v, s) => (isPublic(v, s) ? badge('on', '公有') : badge('off', '私有'));
const sizeOf = (s) => { const c = parseCidr(s.cidr); return c ? 2 ** (32 - c.bits) : 0; };

// ───────────────────────── VPC ─────────────────────────

export function vpcTab(ctx, body) {
  const { dev } = ctx, v = dev.vpc, igw = dev.ifaces.find((i) => i.id === 'igw');
  v.id ||= awsId('vpc', dev.id);
  body.append(tip('VPC（虛擬私有雲）是你在雲端業者的機房裡切出來的一塊私有網路：自己決定位址範圍、切子網路、設定路由與防火牆。底下的伺服器、交換器、路由器都由業者維護 (IaaS)，你看到的是軟體定義的網路。'));
  body.append(h('div', { class: 'card' }, cardHead(v.id),
    grid2(field('IPv4 CIDR', inp(ctx, ...bind(v, 'cidr'), { ph: '10.0.0.0/16', check: isCidr })), field('區域 (Region)', h('div', { class: 'inp mono ro', text: `${CLOUD_REGION}（東京）` }))),
    note('muted', 'VPC 的位址範圍用私有位址 (RFC 1918)，大小在 /16 到 /28 之間。日後要和公司的網路用 VPN 相連的話，不能和地端的網段重疊。')));
  body.append(h('div', { class: 'card' }, cardHead('網際網路閘道 (IGW)', ctx.live(() => (v.igw ? badge('on', '已連接') : badge('off', '未連接')))),
    toggle(ctx, ...bind(v, 'igw'), '把網際網路閘道連接到這個 VPC', { rerender: true }),
    h('div', { class: 'kv' }, kv('業者端的公用位址', igw.ip || '—'), kv('上游閘道', igw.gateway || '—')),
    note('muted', 'IGW 替有公用 IP 的執行個體做一對一的位址轉換。光是連接 IGW 還不夠：子網路的路由表要有 0.0.0.0/0 → igw，這個子網路才叫「公有子網路」。')));
  // 彈性 IP
  const owner = (e) => { const x = v.instances.find((i) => i.eip === e); if (x) return `執行個體 ${x.name}`; const n = v.natgws.find((g) => g.eip === e); return n ? `NAT 閘道 ${n.id}` : ''; };
  body.append(h('div', { class: 'card' }, cardHead('彈性 IP (Elastic IP)'),
    v.eips.length ? v.eips.map((e) => h('div', { class: 'line' }, h('b', { class: 'mono', text: e }), h('span', { class: 'muted', text: owner(e) || '未關聯（沒有關聯的 EIP 一樣要計費）' }))) : note('muted', '還沒有配置彈性 IP。'),
    h('div', { class: 'addrow' }, button('配置彈性 IP', {
      ic: 'plus', small: true,
      onclick: () => {
        const c = igw.ip && parseIp(igw.ip), bits = 26;
        if (c == null) return;
        const base = netOf(c, bits);
        for (let k = 10; k < 62; k++) { const ip = fmtIp(base + k); if (!v.eips.includes(ip) && ip !== igw.ip && ip !== igw.gateway) { v.eips.push(ip); break; } }
        ctx.commit(true);
      },
    }))));
  // 架構總覽
  body.append(h('div', { class: 'card' }, cardHead('資源總覽'), ctx.live(() => {
    const issues = (dev.rt.cloud && dev.rt.cloud.issues) || [];
    return [
      ...v.subnets.map((s) => h('div', { class: 'cl-sum' },
        h('div', { class: 'line' }, h('b', { text: s.name }), h('span', { class: 'mono muted', text: `${s.cidr} · ${s.az || ''}` }), h('span', { style: { marginLeft: 'auto' } }, typeBadge(v, s))),
        ...v.instances.filter((x) => x.subnet === s.id).map((x) => h('div', { class: 'cl-res mono', text: `EC2 ${x.name}　${x.ip}${x.eip ? '　EIP ' + x.eip : ''}` })),
        ...v.natgws.filter((n) => n.subnet === s.id).map((n) => h('div', { class: 'cl-res mono', text: `NAT 閘道 ${n.id}${n.eip ? '　EIP ' + n.eip : ''}` })))),
      ...issues.map((t) => note('warn', t)),
    ];
  })));
}

// ───────────────────────── 子網路 ─────────────────────────

export function subnetTab(ctx, body) {
  const { dev } = ctx, v = dev.vpc;
  body.append(tip('子網路是 VPC 位址範圍裡的一段，固定在一個可用區域 (AZ)。每個子網路有一張路由表（決定它是公有還是私有）和一份網路 ACL。AWS 會保留每個子網路的前四個和最後一個位址。'));
  v.subnets.forEach((s, n) => {
    const used = v.instances.filter((x) => x.subnet === s.id).length + v.natgws.filter((g) => g.subnet === s.id).length;
    body.append(h('div', { class: 'card' }, cardHead(s.id, typeBadge(v, s), del(() => { v.subnets.splice(n, 1); ctx.commit(true); })),
      grid2(field('名稱', inp(ctx, ...bind(s, 'name'), { mono: false })), field('IPv4 CIDR', inp(ctx, ...bind(s, 'cidr'), { ph: '10.0.1.0/24', check: isCidr })),
        field('可用區域', sel(ctx, ...bind(s, 'az'), AZS)),
        field('可用的 IPv4 位址', h('div', { class: 'inp mono ro', text: sizeOf(s) ? `${sizeOf(s) - 5 - used}（共 ${sizeOf(s)}，AWS 保留 5 個）` : '—' })),
        field('路由表', sel(ctx, () => s.rtb || '', (x) => { if (x) s.rtb = x; else delete s.rtb; }, [['', `主路由表（${(v.rts.find((r) => r.main) || {}).name || ''}）`], ...v.rts.filter((r) => !r.main).map((r) => [r.id, r.name])], { rerender: true })),
        field('網路 ACL', sel(ctx, () => s.nacl || '', (x) => { if (x) s.nacl = x; else delete s.nacl; }, [['', '預設 ACL'], ...v.nacls.filter((a) => !a.def).map((a) => [a.id, a.name])], { rerender: true })))));
  });
  body.append(h('div', { class: 'addrow' }, button('建立子網路', { ic: 'plus', kind: 'primary', small: true, onclick: () => { v.subnets.push({ id: awsId('subnet'), name: `subnet-${v.subnets.length + 1}`, cidr: '', az: AZS[0][0] }); ctx.commit(true); } })));
}

// ───────────────────────── 路由表 ─────────────────────────

export function rtTab(ctx, body) {
  const { dev } = ctx, v = dev.vpc;
  body.append(tip('子網路送出的封包，依照它那張路由表的「最長相符」決定往哪裡送。每張路由表都有一條不能刪的 local 路由（VPC 內部互通）；沒有明確指定路由表的子網路用主路由表。'));
  const tgws = Object.values(ctx.state.devices).filter((x) => x.tgw && (x.tgw.attach || []).includes(dev.id));
  const targets = [['igw', '網際網路閘道 (igw)'], ...v.natgws.map((n) => [n.id, `NAT 閘道 ${n.id}`]), ['vgw', '虛擬私有閘道 (vgw)'],
    ...(v.peers || []).map((p) => [p.id, `peering ${p.id}（${(ctx.state.devices[p.peer] || {}).name || p.peer}）`]), ...tgws.map((x) => [x.tgw.id, `Transit Gateway ${x.tgw.id}`])];
  v.rts.forEach((r, n) => {
    const subs = v.subnets.filter((s) => rtOf(v, s) === r).map((s) => s.name);
    const card = h('div', { class: 'card' }, cardHead(r.name, r.main ? badge('on', '主路由表') : null, !r.main && del(() => { v.rts.splice(n, 1); for (const s of v.subnets) if (s.rtb === r.id) delete s.rtb; ctx.commit(true); })),
      h('div', { class: 'muted cl-small', text: `${r.id} · 關聯的子網路：${subs.length ? subs.join('、') : '（沒有）'}` }),
      h('div', { class: 'cl-route head' }, h('span', { text: '目的地' }), h('span', { text: '目標' }), h('span')),
      h('div', { class: 'cl-route' }, h('span', { class: 'mono', text: v.cidr }), h('span', { class: 'mono', text: 'local' }), h('span')));
    r.routes.forEach((x, k) => card.append(h('div', { class: 'cl-route' },
      inp(ctx, ...bind(x, 'dst'), { ph: '0.0.0.0/0', check: isCidr }),
      sel(ctx, ...bind(x, 'target'), targets.some((t) => t[0] === x.target) ? targets : [...targets, [x.target, `${x.target}（不存在）`]], { rerender: true }),
      del(() => { r.routes.splice(k, 1); ctx.commit(true); }))));
    if (r.prop && v.vgw) for (const t of dev.vpns || []) for (const c of String(t.remote || '').split(/[,\s]+/).filter(Boolean)) card.append(h('div', { class: 'cl-route prop' }, h('span', { class: 'mono', text: c }), h('span', { class: 'mono', text: 'vgw（傳播）' }), h('span')));
    card.append(h('div', { class: 'addrow' }, button('新增路由', { ic: 'plus', small: true, onclick: () => { r.routes.push({ dst: '0.0.0.0/0', target: 'igw' }); ctx.commit(true); } })));
    if (v.vgw) card.append(toggle(ctx, ...bind(r, 'prop'), '路由傳播：自動加入 VPN 連線的地端網段 → vgw', { rerender: true }));
    body.append(card);
  });
  body.append(h('div', { class: 'addrow' }, button('建立路由表', { ic: 'plus', kind: 'primary', small: true, onclick: () => { v.rts.push({ id: awsId('rtb'), name: `rtb-${v.rts.length + 1}`, routes: [] }); ctx.commit(true); } })));
}

// ───────────────────────── EC2 ─────────────────────────

export function ec2Tab(ctx, body) {
  const { dev, app, state } = ctx, v = dev.vpc;
  body.append(tip('EC2 執行個體是雲端上的虛擬機器。每台有一個私有 IP（在所屬子網路的範圍裡）；要從網際網路連進來，或不經過 NAT 閘道連出去，還要關聯一個公用 IP（彈性 IP）。'));
  const free = (x) => v.eips.filter((e) => e === x.eip || (!v.instances.some((i) => i.eip === e) && !v.natgws.some((g) => g.eip === e)));
  for (const x of v.instances) {
    const ui = ((app.cloudUi ||= {})[x.id] ||= { out: [], line: '' });
    const out = h('div', { class: 'term-out cl-term-out' });
    const draw = () => { out.replaceChildren(...ui.out.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t }))); out.scrollTop = out.scrollHeight; };
    const run = (line) => {
      const [c, a, b] = line.trim().split(/\s+/);
      ui.out.push({ t: `[ec2-user@${x.name} ~]$ ${line}`, c: 'cmd' });
      const target = (a || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const m = target.match(/^([\d.]+)(?::(\d+))?$/);
      const ip = m && parseIp(m[1]);
      if (!['ping', 'curl', 'nc'].includes(c)) ui.out.push({ t: `-bash: ${c}: command not found（可以用 ping <IP>、curl <IP>[:埠]、nc -zv <IP> <埠>）`, c: 'warn' });
      else if (c === 'nc' && (a !== '-zv' || parseIp(b || '') == null)) ui.out.push({ t: '用法：nc -zv <IP> <埠>', c: 'warn' });
      else if (c !== 'nc' && ip == null) ui.out.push({ t: `用法：${c} <IP>${c === 'curl' ? '[:埠]' : ''}`, c: 'warn' });
      else {
        const dst = c === 'nc' ? parseIp(b) : ip, port = c === 'nc' ? +line.trim().split(/\s+/)[3] : c === 'curl' ? +(m[2] || (/^http:/.test(a) ? 80 : 443)) : 0;
        const res = transact(state, dev.id, { proto: c === 'ping' ? 'icmp' : 'tcp', dst, dport: port, srcIp: parseIp(x.ip) });
        app.showTrace(`${x.name}$ ${line}`, res.log, res.hops, res);
        if (res.ok) ui.out.push({ t: c === 'ping' ? `64 bytes from ${fmtIp(dst)}: icmp_seq=1 ttl=${res.l3.length ? 64 - res.l3.length : 64} time=${rttSamples(state, res, 1, 98)[0].toFixed(2)} ms` : c === 'nc' ? `Ncat: Connected to ${fmtIp(dst)}:${port}.` : `HTTP/1.1 200 OK（${fmtIp(dst)}:${port}）`, c: 'ok' });
        else { ui.out.push({ t: c === 'ping' ? `From ${x.ip} icmp_seq=1 Destination Host Unreachable` : `${c}: (28) Failed to connect to ${fmtIp(dst)} port ${port} after 30000 ms: Timeout was reached`, c: 'bad' }); ui.out.push({ t: '  ↳ ' + res.reason, c: 'hint' }); }
      }
      if (ui.out.length > 40) ui.out.splice(0, ui.out.length - 40);
      draw();
    };
    const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'curl 8.8.8.8:443' });
    input.addEventListener('keydown', (e) => { if (escLine(e, input)) return; if (e.key === 'Enter' && input.value.trim()) { run(input.value); input.value = ''; } ownKeys(e); });
    const s = subnetOf(v, x);
    body.append(h('div', { class: 'card' }, cardHead(x.name, badge('on', '執行中')), h('div', { class: 'mono muted cl-small', text: `${x.id} · ${x.type || 't3.micro'}` }),
      grid2(field('子網路', sel(ctx, ...bind(x, 'subnet'), v.subnets.map((q) => [q.id, `${q.name}（${q.cidr}）`]), { rerender: true })),
        field('私有 IPv4', inp(ctx, ...bind(x, 'ip'), { check: (val) => { const ip = parseIp(val), c = s && parseCidr(s.cidr); return ip != null && !!c && netOf(ip, c.bits) === c.net && !reservedWhy(ip, s); } })),
        field('公用 IP（彈性 IP）', v.igw || x.eip ? sel(ctx, () => x.eip || '', (val) => { x.eip = val; }, [['', '（沒有）'], ...free(x).map((e) => [e, e])], { rerender: true })
          : h('div', { class: 'inp ro', text: '要先連接 IGW', title: `AWS 不允許：Network ${v.id || 'vpc'} is not attached to any internet gateway` }))),
      h('div', { class: 'f-label', text: '安全群組' }),
      h('div', { class: 'toggles' }, v.sgs.map((g) => toggle(ctx, () => (x.sgs || []).includes(g.id), (on) => { x.sgs = on ? [...new Set([...(x.sgs || []), g.id])] : (x.sgs || []).filter((id) => id !== g.id); }, `${g.name}（${g.id}）`))),
      (x.services || []).length ? h('div', { class: 'chips' }, x.services.map((sv) => h('span', { class: 'chip', text: `${sv.name || ''} ${sv.proto.toUpperCase()}/${sv.port}` }))) : null,
      x.rtWhy ? note('warn', x.rtWhy) : null,
      h('details', { class: 'api-tpl', open: ui.out.length > 0 },
        h('summary', { text: 'EC2 Instance Connect（從這台執行個體測試連線）' }),
        h('div', { class: 'term cl-term' }, out, h('div', { class: 'term-line' }, h('span', { class: 'prompt', text: '$' }), input)))));
    draw();
  }
}

// ───────────────────────── 安全群組 ─────────────────────────

export function sgTab(ctx, body) {
  const { dev } = ctx, v = dev.vpc;
  body.append(tip('安全群組掛在執行個體上，像是每台虛擬機器自己的防火牆：只有「允許」規則（沒有拒絕），而且有狀態——允許了連進來，回應就會自動放行。來源可以是 CIDR，也可以是另一個安全群組（代表「掛著那個群組的執行個體」）。'));
  v.sgs.forEach((g, n) => {
    const users = v.instances.filter((x) => (x.sgs || []).includes(g.id)).map((x) => x.name);
    const card = h('div', { class: 'card' }, cardHead(g.name, h('span', { class: 'mono muted cl-small', text: g.id }), g.id !== 'sg-default' && del(() => { v.sgs.splice(n, 1); for (const x of v.instances) x.sgs = (x.sgs || []).filter((id) => id !== g.id); ctx.commit(true); })),
      h('div', { class: 'muted cl-small', text: `使用中的執行個體：${users.length ? users.join('、') : '（沒有）'}` }));
    for (const [dir, title, who] of [['in', '輸入規則', 'src'], ['out', '輸出規則', 'dst']]) {
      const list = (g[dir] ||= []);
      card.append(h('div', { class: 'acl-h' }, h('span', { text: title }), h('em', { text: dir === 'in' ? '允許誰連進來' : '允許連到哪裡' }),
        button('新增規則', { ic: 'plus', small: true, onclick: () => { list.push({ proto: 'tcp', port: '443', [who]: '0.0.0.0/0' }); ctx.commit(true); } })));
      list.forEach((r, k) => card.append(h('div', { class: 'cl-rule sg' },
        h('div', { class: 'r1' },
          sel(ctx, ...bind(r, 'proto'), PROTOS, { rerender: true }),
          r.proto === 'tcp' || r.proto === 'udp' ? inp(ctx, ...bind(r, 'port'), { ph: '埠：443 或 1024-65535' }) : h('span', { class: 'muted', text: '全部連接埠' }),
          del(() => { list.splice(k, 1); ctx.commit(true); })),
        h('div', { class: 'r2' }, h('span', { text: dir === 'in' ? '來源' : '目的' }),
          inp(ctx, ...bind(r, who), { ph: dir === 'in' ? '0.0.0.0/0、203.0.113.34/32 或 sg-…' : '0.0.0.0/0', check: (val) => isCidr(val) || v.sgs.some((x) => x.id === val) })))));
      if (!list.length) card.append(h('div', { class: 'acl-deny', text: dir === 'in' ? '（沒有規則：任何連線都進不來）' : '（沒有規則：執行個體連不出去）' }));
    }
    body.append(card);
  });
  body.append(h('div', { class: 'addrow' }, button('建立安全群組', { ic: 'plus', kind: 'primary', small: true, onclick: () => { v.sgs.push({ id: awsId('sg'), name: `sg-${v.sgs.length + 1}`, in: [], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] }); ctx.commit(true); } })));
}

// ───────────────────────── 網路 ACL ─────────────────────────

export function naclTab(ctx, body) {
  const { dev } = ctx, v = dev.vpc;
  body.append(tip('網路 ACL 掛在子網路上，封包進出子網路時檢查：規則依編號由小到大比對，第一條符合的決定允許或拒絕，最後一條「*」拒絕全部。它是無狀態的——回應封包也要有規則允許，回應的目的埠是對方的臨時連接埠 (1024 – 65535)。'));
  v.nacls.forEach((a, n) => {
    const subs = v.subnets.filter((s) => naclOf(v, s) === a).map((s) => s.name);
    const card = h('div', { class: 'card' }, cardHead(a.name, a.def ? badge('on', '預設') : null, !a.def && del(() => { v.nacls.splice(n, 1); for (const s of v.subnets) if (s.nacl === a.id) delete s.nacl; ctx.commit(true); })),
      h('div', { class: 'muted cl-small', text: `${a.id} · 關聯的子網路：${subs.length ? subs.join('、') : '（沒有）'}` }));
    for (const [dir, title] of [['in', '輸入規則'], ['out', '輸出規則']]) {
      const list = (a[dir] ||= []);
      card.append(h('div', { class: 'acl-h' }, h('span', { text: title }), h('em', { text: dir === 'in' ? '進入子網路的封包' : '離開子網路的封包' }),
        button('新增規則', { ic: 'plus', small: true, onclick: () => { list.push({ n: (Math.max(0, ...list.map((r) => +r.n || 0)) + 10) - ((Math.max(0, ...list.map((r) => +r.n || 0)) + 10) % 10), act: 'allow', proto: 'tcp', port: '443', cidr: '0.0.0.0/0' }); ctx.commit(true); } })));
      list.slice().sort((x, y) => x.n - y.n).forEach((r) => card.append(h('div', { class: 'cl-rule nacl ' + r.act },
        h('div', { class: 'r1' },
          inp(ctx, () => String(r.n), (val) => { r.n = +val || r.n; }, { check: (val) => /^\d+$/.test(val) && +val >= 1 && +val <= 32766, rerender: true }),
          sel(ctx, ...bind(r, 'act'), [['allow', '允許'], ['deny', '拒絕']], { rerender: true }),
          sel(ctx, ...bind(r, 'proto'), PROTOS, { rerender: true }),
          del(() => { list.splice(list.indexOf(r), 1); ctx.commit(true); })),
        h('div', { class: 'r2 two' },
          r.proto === 'tcp' || r.proto === 'udp' ? inp(ctx, ...bind(r, 'port'), { ph: '埠：443 或 1024-65535' }) : h('span', { class: 'muted', text: '全部連接埠' }),
          inp(ctx, ...bind(r, 'cidr'), { ph: dir === 'in' ? '來源 CIDR' : '目的 CIDR', check: isCidr })))));
      card.append(h('div', { class: 'acl-deny', text: '*　拒絕　全部流量　0.0.0.0/0' }));
    }
    body.append(card);
  });
  body.append(h('div', { class: 'addrow' }, button('建立網路 ACL', { ic: 'plus', kind: 'primary', small: true, onclick: () => { v.nacls.push({ id: awsId('acl'), name: `acl-${v.nacls.length + 1}`, in: [], out: [] }); ctx.commit(true); } })));
}

// ───────────────────────── NAT 閘道 ─────────────────────────

export function natTab(ctx, body) {
  const { dev } = ctx, v = dev.vpc;
  body.append(tip('NAT 閘道讓私有子網路的執行個體可以連上網際網路（下載更新），但外面的人連不進來。它本身要放在「公有」子網路、要有一個彈性 IP；私有子網路的路由表再把 0.0.0.0/0 指向它。'));
  const free = (g) => v.eips.filter((e) => e === g.eip || (!v.instances.some((i) => i.eip === e) && !v.natgws.some((x) => x.eip === e)));
  v.natgws.forEach((g, n) => {
    const s = subnetOf(v, g);
    body.append(h('div', { class: 'card' }, cardHead(g.id, s && isPublic(v, s) ? badge('on', '可用') : badge('warn', '放在私有子網路'), del(() => { v.natgws.splice(n, 1); ctx.commit(true); })),
      grid2(field('子網路', sel(ctx, ...bind(g, 'subnet'), v.subnets.map((q) => [q.id, `${q.name}（${isPublic(v, q) ? '公有' : '私有'}）`]), { rerender: true })),
        field('彈性 IP', sel(ctx, () => g.eip || '', (val) => { g.eip = val; }, [['', '（沒有）'], ...free(g).map((e) => [e, e])], { rerender: true }))),
      s && !isPublic(v, s) ? note('warn', `${s.name} 的路由表沒有 0.0.0.0/0 → igw：NAT 閘道自己出不去，要放在公有子網路。`) : null));
  });
  body.append(h('div', { class: 'addrow' }, button('建立 NAT 閘道', { ic: 'plus', kind: 'primary', small: true, onclick: () => { v.natgws.push({ id: awsId('nat'), subnet: (v.subnets[0] || {}).id || '', eip: '' }); ctx.commit(true); } })));
}

// ───────────────────────── VPC peering ─────────────────────────

export function peeringTab(ctx, body) {
  const { dev, state } = ctx, v = dev.vpc;
  v.peers ||= [];
  body.append(tip('VPC peering 把兩個 VPC 一對一接起來（網段不能重疊、對方要接受）。它不能轉送 (non-transitive)：A ↔ B、B ↔ C 都接了，A 還是到不了 C。接好之後，兩邊子網路的路由表都要加往對方網段 → pcx 的路由。VPC 一多，改用 Transit Gateway。'));
  const others = Object.values(state.devices).filter((x) => x.vpc && x.id !== dev.id);
  v.peers.forEach((p, n) => {
    const st = peerState(state, dev, p), B = state.devices[p.peer];
    body.append(h('div', { class: 'card' }, cardHead(p.id, st.ok ? badge('on', 'active') : badge('warn', p.status === 'pending' ? '等你接受' : p.status === 'requested' ? '等對方接受' : '失敗'), del(() => {
      v.peers.splice(n, 1);
      if (B && B.vpc) B.vpc.peers = (B.vpc.peers || []).filter((x) => x.id !== p.id);
      ctx.commit(true);
    })),
      kv('對方的 VPC', B ? `${B.name}（${B.vpc.cidr}）` : p.peer),
      !st.ok ? note('warn', st.why) : note('ok', `已經接通。兩邊子網路的路由表要有往對方網段 → ${p.id} 的路由。`),
      p.status === 'pending' && h('div', { class: 'addrow' }, button('接受這個 peering 要求', { ic: 'check', small: true, onclick: () => {
        p.status = 'active';
        const q = B && B.vpc && (B.vpc.peers || []).find((x) => x.id === p.id);
        if (q) q.status = 'active';
        ctx.commit(true);
      } }))));
  });
  if (!others.length) body.append(note('muted', '這個關卡沒有別的 VPC 可以接。'));
  else body.append(h('div', { class: 'addrow' }, ...others.filter((x) => !v.peers.some((p) => p.peer === x.id)).map((x) => button(`向 ${x.name} 提出 peering`, { ic: 'plus', small: true, onclick: () => {
    const id = awsId('pcx');
    v.peers.push({ id, peer: x.id, status: 'requested' });
    (x.vpc.peers ||= []).push({ id, peer: dev.id, status: 'pending' });
    ctx.commit(true);
  } }))));
}

// ───────────────────────── Transit Gateway ─────────────────────────

export function tgwTab(ctx, body) {
  const { dev, state } = ctx, t = dev.tgw;
  body.append(tip('Transit Gateway 是區域裡的雲端路由器：每個 VPC 用一個 attachment 接上來，路由表自動學到各 VPC 的網段（路由傳播），任兩個 VPC 都能經過它互通。別忘了每個 VPC 的子網路路由表，也要把往其他 VPC 的網段指向這個 Transit Gateway。'));
  const vpcs = Object.values(state.devices).filter((x) => x.vpc);
  body.append(h('div', { class: 'card' }, cardHead('VPC attachment'), kv('Transit Gateway ID', t.id),
    h('div', { class: 'toggles' }, vpcs.map((x) => toggle(ctx, () => (t.attach || []).includes(x.id), (on) => { t.attach = on ? [...new Set([...(t.attach || []), x.id])] : (t.attach || []).filter((y) => y !== x.id); }, `${x.name}（${x.vpc.cidr}）`, { rerender: true }))),
    (t.attach || []).length ? h('div', { class: 'toggles' }, (t.attach || []).map((id) => toggle(ctx, () => !(t.noProp || []).includes(id), (on) => { t.noProp = on ? (t.noProp || []).filter((y) => y !== id) : [...new Set([...(t.noProp || []), id])]; }, `路由傳播：${(state.devices[id] || {}).name || id}`, { rerender: true }))) : null));
  const card = h('div', { class: 'card' }, cardHead('路由表'), h('div', { class: 'cl-route head' }, h('span', { text: '目的地' }), h('span', { text: '目標' }), h('span')));
  card.append(ctx.live(() => tgwRoutes(state, dev).filter((r) => r.prop).map((r) => h('div', { class: 'cl-route prop' }, h('span', { class: 'mono', text: r.dst }), h('span', { class: 'mono', text: `${(state.devices[r.attach] || {}).name}（傳播）` }), h('span')))));
  (t.routes ||= []).forEach((r, k) => card.append(h('div', { class: 'cl-route' },
    inp(ctx, ...bind(r, 'dst'), { ph: '10.0.0.0/8', check: isCidr }),
    sel(ctx, ...bind(r, 'attach'), (t.attach || []).map((id) => [id, (state.devices[id] || {}).name || id])),
    del(() => { t.routes.splice(k, 1); ctx.commit(true); }))));
  card.append(h('div', { class: 'addrow' }, button('新增靜態路由', { ic: 'plus', small: true, onclick: () => { t.routes.push({ dst: '', attach: (t.attach || [])[0] || '' }); ctx.commit(true); } })));
  body.append(card);
}

// ───────────────────────── 負載平衡器 ─────────────────────────

export function lbTab(ctx, body) {
  const { dev } = ctx, v = dev.vpc;
  v.lbs ||= [];
  body.append(tip('應用程式負載平衡器 (ALB)：用戶端連到 ALB 的公用 IP，ALB 再把連線分給目標群組裡「健康」的執行個體。目標可以放在私有子網路（不需要公用 IP）；健康檢查是 ALB 自己連到目標的目標埠，所以目標的安全群組要允許 ALB（通常用 ALB 的安全群組當來源）。'));
  const free = (l) => v.eips.filter((e) => e === l.eip || (!v.instances.some((i) => i.eip === e) && !v.natgws.some((x) => x.eip === e) && !v.lbs.some((x) => x !== l && x.eip === e)));
  v.lbs.forEach((l, n) => {
    const s = v.subnets.find((q) => q.id === l.subnet);
    body.append(h('div', { class: 'card' }, cardHead(l.name || l.id, ctx.live(() => { const r = ((dev.rt.cloud || {}).lb || {})[l.id] || { healthy: [] }; return badge(r.healthy.length ? 'on' : 'warn', `健康的目標 ${r.healthy.length} / ${(l.targets || []).length}`); }), del(() => { v.lbs.splice(n, 1); ctx.commit(true); })),
      grid2(
        field('名稱', inp(ctx, ...bind(l, 'name'), { mono: false, ph: '例如 web-alb' })),
        field('子網路', sel(ctx, ...bind(l, 'subnet'), v.subnets.map((q) => [q.id, `${q.name}（${isPublic(v, q) ? '公有' : '私有'}）`]), { rerender: true })),
        field('彈性 IP（對外的位址）', sel(ctx, () => l.eip || '', (val) => { l.eip = val; }, [['', '（沒有）'], ...free(l).map((e) => [e, e])], { rerender: true })),
        field('安全群組', sel(ctx, () => l.sg || '', (val) => { l.sg = val; }, [['', '（沒有）'], ...v.sgs.map((g) => [g.id, `${g.name}（${g.id}）`])])),
        field('接聽器 (TCP)', inp(ctx, () => String(l.port || 80), (val) => { l.port = +val || 80; }, { ph: '443' })),
        field('目標埠', inp(ctx, () => String(l.tgPort || 80), (val) => { l.tgPort = +val || 80; }, { ph: '80' }))),
      h('div', { class: 'acl-h' }, h('span', { text: '目標群組' }), h('em', { text: s ? `ALB 在 ${s.name} 的位址：${fmtIp(lbIp(v, l))}` : '' })),
      h('div', { class: 'toggles' }, v.instances.map((x) => toggle(ctx, () => (l.targets || []).includes(x.id), (on) => { l.targets = on ? [...new Set([...(l.targets || []), x.id])] : (l.targets || []).filter((t) => t !== x.id); }, `${x.name}（${x.ip}）`, { rerender: true }))),
      ctx.live(() => {
        const r = ((dev.rt.cloud || {}).lb || {})[l.id] || { healthy: [], why: {} };
        return (l.targets || []).map((id) => { const x = v.instances.find((i) => i.id === id); return r.why[id] ? note('warn', `${x ? x.name : id}：不健康 — ${r.why[id]}`) : note('ok', `${x ? x.name : id}：健康`); });
      }),
      s && !isPublic(v, s) ? note('warn', `${s.name} 是私有子網路：對外的 ALB 要放在公有子網路（路由表有 0.0.0.0/0 → igw）。`) : null));
  });
  body.append(h('div', { class: 'addrow' }, button('建立負載平衡器', { ic: 'plus', kind: 'primary', small: true, onclick: () => { v.lbs.push({ id: awsId('alb'), name: 'web-alb', subnet: (v.subnets[0] || {}).id || '', eip: '', sg: '', port: 80, tgPort: 80, targets: [] }); ctx.commit(true); } })));
}

// ───────────────────────── VPN ─────────────────────────

export function cloudVpnTab(ctx, body) {
  const { dev, app } = ctx, v = dev.vpc, igw = dev.ifaces.find((i) => i.id === 'igw');
  body.append(tip('站對站 VPN：在 VPC 連接一個虛擬私有閘道 (VGW)，再建立 VPN 連線指向公司的路由器（客戶閘道，CGW）。AWS 那一端的設定是固定的，下載設定檔照著設定公司的設備；最後別忘了路由表要有往地端網段 → vgw 的路由（或開啟路由傳播）。'));
  body.append(h('div', { class: 'card' }, cardHead('虛擬私有閘道 (VGW)', ctx.live(() => (v.vgw ? badge('on', '已連接') : badge('off', '未連接')))),
    toggle(ctx, ...bind(v, 'vgw'), '把虛擬私有閘道連接到這個 VPC', { rerender: true })));
  (dev.vpns ||= []).forEach((t, n) => {
    const st = t.rt || {};
    const ui = ((app.cloudUi ||= {})['vpn:' + n] ||= { show: false, vendor: 'ios' });
    body.append(h('div', { class: 'card' }, cardHead(t.name, ctx.live(() => (t.rt && t.rt.up ? badge('on', '通道 UP') : badge('off', '通道 DOWN'))), del(() => { dev.vpns.splice(n, 1); ctx.commit(true); })),
      grid2(field('客戶閘道（公司路由器的公用 IP）', inp(ctx, ...bind(t, 'peer'), { check: isIpv4 })), field('靜態路由（地端網段）', inp(ctx, ...bind(t, 'remote'), { ph: '10.20.0.0/24', check: (val) => val.split(/[,\s]+/).filter(Boolean).every(isCidr) })),
        field('IKE 版本', sel(ctx, () => String(t.ike || 2), (val) => { t.ike = +val; }, [['2', 'IKEv2'], ['1', 'IKEv1']], { rerender: true })),
        field('預先共用金鑰', inp(ctx, ...bind(t, 'psk')))),
      h('div', { class: 'kv' }, kv('AWS 端的通道外部 IP', igw.ip || '—'), kv('VPC 端的網段', v.cidr), kv('AWS 接受的提案', 'AES128 / AES256、SHA1 / SHA2-256、DH 2 / 14 – 21，第二階段要有 PFS')),
      ctx.live(() => (t.rt && !t.rt.up && t.rt.why ? note('warn', t.rt.why) : null)),
      h('div', { class: 'addrow' }, button(ui.show ? '收起設定檔' : '下載設定檔', { ic: 'save', small: true, onclick: () => { ui.show = !ui.show; ctx.commit(true); } }),
        ui.show ? sel(ctx, () => ui.vendor, (val) => { ui.vendor = val; }, [['ios', 'Cisco ISR（IOS XE）'], ['forti', 'Fortinet FortiGate']], { rerender: true }) : null,
        ui.show ? button('複製', { small: true, onclick: () => navigator.clipboard?.writeText(vpnConfig(dev, t, ui.vendor)).then(() => toast('已複製設定檔：到設備的 CLI（設定模式）直接貼上，會一行一行執行', 'ok', 4000), () => toast('瀏覽器不允許複製，請手動選取', 'bad')) }) : null),
      ui.show ? h('pre', { class: 'api-body mono', text: vpnConfig(dev, t, ui.vendor) }) : null));
    void st;
  });
  body.append(h('div', { class: 'addrow' }, button('建立 VPN 連線', {
    ic: 'plus', kind: 'primary', small: true,
    onclick: () => { dev.vpns.push({ name: awsId('vpn'), peer: '', remote: '', local: v.cidr, psk: awsPsk(), ike: 2, props: AWS_P1, dhs: AWS_DH, props2: AWS_P1, pfsList: AWS_DH }); ctx.commit(true); },
  })));
}
void icon;
