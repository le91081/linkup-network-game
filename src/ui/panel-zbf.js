// 路由器的 Zone-Based Firewall 卡片（ACL 分頁最上面）
// 圖形介面用簡化的方式編輯：每個 zone-pair 一個「允許的協定」清單 → 自動產生 class-map type inspect <PAIR>-CM 與 policy-map type inspect <PAIR>-PM。
// 用 CLI 設定的複雜政策（好幾個 class、ACL 比對）只顯示，不在這裡改。
import { h, button, toast } from './dom.js';
import { sel, toggle, field, note, cardHead, badge, del, seg } from './form.js';
import { newZbf, zbfActive, ZBF_PROTO } from '../engine/zbf.js';

const COMMON = ['http', 'https', 'dns', 'icmp', 'ssh', 'ntp', 'smtp', 'ms-wbt', 'tcp', 'udp'];
const ACT = { inspect: 'inspect（有狀態）', pass: 'pass（單向）', drop: 'drop' };

/** 這個 zone-pair 的政策是不是圖形介面能編輯的樣子：一個 match-any 只比對協定的 class，加上 class-default drop */
function simple(z, p) {
  const pm = p.policy && z.pmaps[p.policy];
  if (!pm) return { ok: true, protos: [], act: 'inspect' };
  const cls = pm.filter((c) => c.cls !== 'class-default'), def = pm.find((c) => c.cls === 'class-default');
  if (cls.length > 1 || (def && def.act !== 'drop')) return { ok: false };
  if (!cls.length) return { ok: true, protos: [], act: 'inspect' };
  const cm = z.cmaps[cls[0].cls];
  if (!cm || !cm.any || cm.match.some((m) => m.t !== 'protocol')) return { ok: false };
  return { ok: true, protos: cm.match.map((m) => m.v), act: cls[0].act || 'drop', cls: cls[0].cls };
}

export function zbfCard(ctx) {
  const { dev } = ctx;
  if (dev.kind !== 'router') return null;
  const z = dev.zbf || newZbf();
  const edit = () => (dev.zbf ||= newZbf());
  const zones = Object.keys(z.zones);
  const card = h('div', { class: 'card zbf' }, cardHead('Zone-Based Firewall', badge(zbfActive(dev) ? 'on' : 'off', zbfActive(dev) ? '啟用中' : '沒有介面在 zone 裡')),
    note('muted', '介面加進 zone 之後：同一個 zone 互通；不同 zone 之間要有 zone-pair 放行（inspect 回程自動放行，pass 只放單一方向）；有 zone 和沒有 zone 的介面之間一律不通。路由器自己是 self zone。'));
  // zone 與介面
  const zl = h('div', { class: 'chips' }, zones.map((n) => h('span', { class: 'chip mono' }, n, del(() => {
    if (dev.ifaces.some((i) => i.zone === n) || Object.values(z.pairs).some((p) => p.src === n || p.dst === n)) return toast(`zone ${n} 還有介面或 zone-pair 在用`, 'bad');
    delete edit().zones[n]; ctx.commit(true);
  }, `刪除 zone ${n}`))));
  const nz = h('input', { class: 'inp mono', placeholder: '新的 zone 名稱，例如 INSIDE', spellcheck: 'false' });
  const addZone = () => {
    const n = nz.value.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,32}$/.test(n) || n === 'SELF') return toast('zone 名稱用英文、數字、底線或連字號（self 是內建的）', 'bad');
    edit().zones[n] ||= {}; ctx.commit(true);
  };
  nz.addEventListener('keydown', (e) => { if (e.key === 'Enter') addZone(); });
  card.append(field('Zone', h('div', {}, zl, h('div', { class: 'addrow' }, nz, button('新增 zone', { ic: 'plus', small: true, onclick: addZone })))));
  if (zones.length) {
    for (const i of dev.ifaces.filter((x) => x.bind.t !== 'loop')) {
      card.append(field(`${i.label} 的 zone`, sel(ctx, () => i.zone || '', (v) => { if (v) i.zone = v; else delete i.zone; }, [['', '（不屬於任何 zone）'], ...zones.map((n) => [n, n])], { rerender: true })));
    }
  }
  // zone-pair
  for (const [name, p] of Object.entries(z.pairs)) {
    const s = simple(z, p);
    const pc = h('div', { class: 'zbf-pair' }, h('div', { class: 'zbf-ph' }, h('b', { class: 'mono', text: name }), h('span', { class: 'muted', text: `${p.src} → ${p.dst}` }),
      del(() => { delete edit().pairs[name]; ctx.commit(true); }, `刪除 zone-pair ${name}`)));
    if (!s.ok) {
      const pm = z.pmaps[p.policy] || [];
      pc.append(note('muted', `政策 ${p.policy}（用 CLI 設定，這裡只顯示）：${pm.map((c) => `${c.cls} → ${c.act || 'drop'}`).join('、')}`));
    } else {
      const setPolicy = (protos, act) => {
        const Z = edit(), cm = `${name}-CM`, pm = `${name}-PM`;
        if (!protos.length) { delete Z.cmaps[cm]; Z.pmaps[pm] = [{ cls: 'class-default', act: 'drop' }]; }
        else { Z.cmaps[cm] = { any: true, match: protos.map((v) => ({ t: 'protocol', v })) }; Z.pmaps[pm] = [{ cls: cm, act }, { cls: 'class-default', act: 'drop' }]; }
        Z.pairs[name].policy = pm;
      };
      pc.append(field('動作', seg(ctx, () => s.act, (v) => setPolicy(s.protos, v), Object.entries(ACT).filter(([k]) => k !== 'drop'))),
        field('放行的協定（其餘的 class-default drop）', h('div', { class: 'chips' }, COMMON.map((v) => toggle(ctx, () => s.protos.includes(v), (on) => setPolicy(on ? [...s.protos, v] : s.protos.filter((x) => x !== v), s.act), v, { rerender: true, title: (ZBF_PROTO[v] || []).map((x) => x.join(' ')).join('、') })))));
      if (!p.policy) pc.append(note('warn', '還沒有套用政策：這個方向全部拒絕'));
    }
    card.append(pc);
  }
  if (zones.length) {
    const opts = [...zones, 'self'].map((n) => [n, n]);
    const draft = { src: zones[0], dst: zones[1] || 'self' };
    const addPair = () => {
      if (draft.src === draft.dst) return toast('來源和目的 zone 不能一樣', 'bad');
      const Z = edit();
      if (Object.values(Z.pairs).some((p) => p.src === draft.src && p.dst === draft.dst)) return toast(`已經有 ${draft.src} → ${draft.dst} 的 zone-pair`, 'bad');
      const name = `${draft.src}-TO-${draft.dst}`.toUpperCase();
      Z.pairs[name] = { src: draft.src, dst: draft.dst };
      ctx.commit(true);
    };
    const quiet = { commit() {} };
    card.append(h('div', { class: 'addrow' }, h('span', { class: 'muted', text: '新增 zone-pair' }),
      sel(quiet, () => draft.src, (v) => { draft.src = v; }, opts), h('span', { text: '→' }), sel(quiet, () => draft.dst, (v) => { draft.dst = v; }, opts),
      button('新增', { ic: 'plus', small: true, onclick: addPair })));
  }
  return card;
}
