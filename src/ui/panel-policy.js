// 路由重分配與政策路由 (PBR) 的設定畫面（和 CLI 改的是同一份設定：ospfRedist、bgp.redist、routeMaps、aclDefs、介面的 policyRm）
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, cardHead, toggle, del, grid2, isAddr, isPortNo } from './form.js';
import { parseIp, sameNet } from '../engine/ip.js';
import { pbrHits } from '../engine/sim.js';
import { aclRules } from '../engine/policy.js';
import { eigrpOn } from '../engine/eigrp.js';
import { ripOn } from '../engine/rip.js';

const SRC_NAME = { static: '靜態路由', connected: '直連網段（沒有跑 OSPF 的介面）', bgp: 'BGP 學到的路', ospf: 'OSPF 學到的路（含跑 OSPF 的直連網段）', eigrp: 'EIGRP 學到的路（含跑 EIGRP 的直連網段）', rip: 'RIP 學到的路（含跑 RIP 的直連網段）' };
const SEED_EIGRP = [10000, 100, 255, 1, 1500]; // 重分配進 EIGRP 的種子 metric：頻寬 kbps、延遲（十微秒）、可靠度、負載、MTU

/** 路由重分配：OSPF / EIGRP 收進哪些外部路由、BGP 送出哪些路 */
export function redistCard(ctx) {
  const { dev } = ctx;
  const ospf = (dev.ospfNets || []).length > 0 || dev.ifaces.some((i) => i.ospf);
  const bgp = !!(dev.bgp && dev.bgp.asn), eig = eigrpOn(dev), rip = ripOn(dev);
  if (!ospf && !bgp && !eig) return null;
  const rmOpts = [['', '全部都送（不過濾）'], ...Object.keys(dev.routeMaps || {}).map((n) => [n, `route-map ${n}`])];
  const block = (title, getList, setList, srcs, into) => {
    const list = getList();
    return [h('div', { class: 'acl-h' }, h('span', { text: title }), h('em', { text: into === 'ospf' ? '這台變成 ASBR' : into === 'eigrp' ? '外部路由 D EX（AD 170）' : 'origin 是 ?' })),
      ...srcs.map((src) => {
        const cur = list.find((x) => x.src === src);
        return h('div', { class: 'redist-row' },
          toggle(ctx, () => !!cur, (v) => {
            const l = getList().filter((x) => x.src !== src);
            if (into === 'eigrp') { if (v) l.push({ src, ...(src === 'ospf' ? { pid: 1 } : {}), ...(src !== 'connected' && !dev.eigrp.defMetric ? { metric: SEED_EIGRP } : {}) }); setList(l); return; }
            if (v) l.push({ src, ...(src === 'bgp' ? { as: +dev.bgp.asn } : src === 'ospf' ? { as: 1 } : src === 'eigrp' ? { as: +dev.eigrp.as } : {}) });
            setList(l);
          }, into === 'eigrp' && src === 'connected' ? '直連網段（沒有跑 EIGRP 的介面）' : SRC_NAME[src], { rerender: true }),
          cur && into === 'eigrp' && h('div', { class: 'redist-opts' }, h('span', { class: 'muted mono', text: cur.metric ? `metric ${cur.metric.join(' ')}` : src === 'connected' ? '用介面的頻寬與延遲' : `default-metric ${dev.eigrp.defMetric.join(' ')}` })),
          cur && into !== 'eigrp' && h('div', { class: 'redist-opts' },
            into === 'ospf' && sel(ctx, () => String(cur.type || 2), (v) => { if (+v === 1) cur.type = 1; else delete cur.type; }, [['2', 'E2（metric 固定）'], ['1', 'E1（加上內部的 cost）']]),
            sel(ctx, () => cur.rm || '', (v) => { if (v) cur.rm = v; else delete cur.rm; }, rmOpts, { rerender: true })));
      })];
  };
  return h('div', { class: 'card' }, cardHead('路由重分配'),
    note('muted', '把一種來源的路放進另一個路由協定，其他路由器才學得到。預設路由不會跟著出去（OSPF 要用「發布預設路由」）。只想送其中幾筆時，先在 CLI 寫 prefix-list 與 route-map，再在這裡選它。'),
    ospf ? block('重分配進 OSPF', () => dev.ospfRedist || [], (l) => { if (l.length) dev.ospfRedist = l; else delete dev.ospfRedist; }, ['static', 'connected', ...(bgp ? ['bgp'] : []), ...(eig ? ['eigrp'] : []), ...(rip ? ['rip'] : [])], 'ospf') : [],
    eig ? block(`重分配進 EIGRP（AS ${dev.eigrp.as}）`, () => dev.eigrp.redist || [], (l) => { if (l.length) dev.eigrp.redist = l; else delete dev.eigrp.redist; }, ospf ? ['static', 'connected', 'ospf'] : ['static', 'connected'], 'eigrp') : [],
    bgp ? block(`重分配進 BGP（AS ${dev.bgp.asn}）`, () => dev.bgp.redist || [], (l) => { if (l.length) dev.bgp.redist = l; else delete dev.bgp.redist; }, ospf ? ['static', 'connected', 'ospf'] : ['static', 'connected'], 'bgp') : []);
}

const ruleText = (r) => `${r.action === 'deny' ? '不含 ' : ''}${r.proto === 'ip' ? '' : r.proto + ' '}${r.src === 'any' ? '任何來源' : r.src} → ${r.dst === 'any' ? '任何目的' : r.dst}${r.port ? ' 埠 ' + r.port : ''}`;

/** 政策路由：哪個介面進來的哪些流量，交給指定的下一站 */
export function pbrCard(ctx) {
  const { dev, app } = ctx;
  if (dev.kind !== 'router') return null;
  const ifs = dev.ifaces.filter((i) => i.bind.t === 'port' || i.bind.t === 'sub');
  const bound = ifs.filter((i) => i.policyRm);
  const draft = ((app.pbrDraft ||= {})[dev.id] ||= { iface: (ifs[ifs.length - 1] || {}).id || '', src: '', dst: 'any', proto: 'ip', port: '', nh: '' });
  const conn = (ip) => dev.ifaces.some((i) => i.rt && i.rt.ip != null && i.rt.link && sameNet(ip, i.rt.ip, i.rt.bits) && ip !== i.rt.ip);
  const bindBlock = (i) => {
    const rm = (dev.routeMaps || {})[i.policyRm];
    return h('div', { class: 'sub pbr' },
      h('div', { class: 'card-h' }, h('b', { class: 'mono', text: i.label }), h('span', { class: 'muted mono', text: `ip policy route-map ${i.policyRm}` }),
        del(() => { delete i.policyRm; ctx.commit(true); }, '不再套用（no ip policy route-map）')),
      !rm ? note('warn', `route-map ${i.policyRm} 不存在：從這個介面進來的封包照一般的路由表`)
        : rm.slice().sort((a, b) => a.seq - b.seq).map((e) => {
          const rules = e.match.acl ? aclRules(dev, e.match.acl) || [] : null;
          const what = e.match.acl ? (rules.length ? rules.map(ruleText).join('；') : `ACL ${e.match.acl}（不存在：全部符合）`) : '全部的封包';
          const to = (e.set.nh || []).length ? `交給 ${e.set.nh.join('、')}${e.set.nh.some((x) => conn(parseIp(x))) ? '' : '（不是直連：照路由表）'}` : (e.set.defNh || []).length ? `沒有明確的路才交給 ${e.set.defNh.join('、')}` : '照路由表';
          return h('div', { class: 'pbr-rule' },
            h('span', { class: 'chip tiny', text: `${e.action} ${e.seq}` }),
            h('span', { class: 'pbr-what', text: `${what} → ${e.action === 'deny' ? '照路由表' : to}` }),
            ctx.live(() => h('span', { class: 'muted mono', text: `${pbrHits(e).pk} 個封包` })),
            del(() => {
              dev.routeMaps[i.policyRm] = rm.filter((x) => x !== e);
              if (!dev.routeMaps[i.policyRm].length) delete dev.routeMaps[i.policyRm];
              ctx.commit(true);
            }, '刪除這一條'));
        }));
  };
  const add = () => {
    const i = ifs.find((x) => x.id === draft.iface), nh = parseIp(draft.nh);
    if (!i) return toast('先選流量進來的介面', 'bad');
    if (!draft.src || !isAddr(draft.src) || !isAddr(draft.dst || 'any')) return toast('來源、目的寫 any、一個 IP 或網段（例如 10.2.0.0/24）', 'bad');
    if ((draft.proto === 'tcp' || draft.proto === 'udp') && draft.port && !isPortNo(draft.port)) return toast('埠號是 1 – 65535', 'bad');
    if (nh == null) return toast('下一站要填 IP 位址', 'bad');
    const name = i.policyRm || `PBR-${i.label.replace(/[^\w]/g, '')}`;
    const list = ((dev.routeMaps ||= {})[name] ||= []);
    const seq = (list.reduce((m, e) => Math.max(m, e.seq), 0) || 0) + 10;
    const acl = `${name}-${seq}`.toUpperCase(); // 和 CLI 一樣，具名的 ACL 用大寫
    (dev.aclDefs ||= {})[acl] = [{ action: 'permit', proto: draft.proto, src: draft.src, dst: draft.dst || 'any', port: draft.proto === 'tcp' || draft.proto === 'udp' ? draft.port || '' : '' }];
    list.push({ seq, action: 'permit', match: { acl }, set: { nh: [draft.nh] } });
    i.policyRm = name;
    if (!conn(nh)) toast(`${draft.nh} 不是這台的直連網段：PBR 不會生效，封包照路由表走`, 'warn', 6000);
    Object.assign(draft, { src: '', port: '' });
    ctx.commit(true);
    return undefined;
  };
  const q = { commit() {} };
  return h('div', { class: 'card' }, cardHead(`政策路由 (PBR)${bound.length ? `（${bound.length} 個介面）` : ''}`),
    note('muted', '路由表只看目的地。政策路由依來源、目的、協定與埠選出流量，直接交給指定的下一站。要套在流量「進來」的介面上；回程照對方的路由表走。'),
    bound.map(bindBlock),
    h('div', { class: 'acl-h' }, h('span', { text: '新增一條政策' }), h('em', { text: '會建立 ACL 與 route-map，CLI 看得到' })),
    grid2(
      field('流量從哪個介面進來', sel(q, () => draft.iface, (v) => { draft.iface = v; }, ifs.map((x) => [x.id, x.label + (x.rt && x.rt.ip != null ? ' · ' + x.ip : '')]))),
      field('協定', sel(q, () => draft.proto, (v) => { draft.proto = v; }, [['ip', '全部 (ip)'], ['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP']])),
      field('來源', inp(q, () => draft.src, (v) => { draft.src = v.trim(); }, { ph: '例如 10.2.0.20 或 10.2.0.0/24', check: isAddr })),
      field('目的', inp(q, () => draft.dst, (v) => { draft.dst = v.trim() || 'any'; }, { ph: 'any', check: isAddr })),
      field('目的埠（TCP / UDP）', inp(q, () => draft.port, (v) => { draft.port = v.trim(); }, { ph: '全部', check: isPortNo })),
      field('交給下一站 (set ip next-hop)', inp(q, () => draft.nh, (v) => { draft.nh = v.trim(); }, { ph: '直連網段上的路由器', check: (v) => parseIp(v) != null }))),
    h('div', { class: 'addrow' }, button('新增政策', { ic: 'plus', small: true, onclick: add })));
}
