// 交換器的 VTP 卡片（放在 VLAN 分頁最上面）：網域、模式、密碼、版本，以及目前的 revision 與同步來源
import { h } from './dom.js';
import { inp, field, note, cardHead, badge, grid2, seg, kv } from './form.js';
import { vtpCapable, vtpOf, vtpSet } from '../engine/vtp.js';

const MODE = { server: 'Server', client: 'Client', transparent: 'Transparent', off: 'Off' };

export function vtpCard(ctx) {
  const { dev, state } = ctx;
  if (!vtpCapable(dev)) return null;
  const v = vtpOf(dev), r = (dev.rt && dev.rt.vtp) || {};
  const by = v.from && v.from !== dev.id && state.devices[v.from];
  const sync = ['server', 'client'].includes(v.mode);
  const c = h('div', { class: 'card vtp' }, cardHead('VTP（VLAN 資料庫同步）', badge(v.domain && sync ? 'on' : 'off', v.domain ? `網域 ${v.domain}` : '沒有網域')),
    field('模式', seg(ctx, () => v.mode, (m) => vtpSet(dev, { mode: m }), Object.entries(MODE))),
    grid2(
      field('網域名稱 (vtp domain)', inp(ctx, () => v.domain, (x) => vtpSet(dev, { domain: x }), { ph: '空白 = NULL', rerender: true })),
      field('密碼 (vtp password)', inp(ctx, () => v.pass, (x) => vtpSet(dev, { pass: x }), { ph: '網域裡要一樣', rerender: true })),
    ),
    field('版本', seg(ctx, () => String(v.ver), (x) => vtpSet(dev, { ver: +x }), [['1', '1'], ['2', '2']])),
    kv('Configuration Revision', sync ? String(v.rev) : '0（transparent / off 不同步）'),
  );
  if (by) c.append(note('muted', `VLAN 資料庫最近一次是照 ${by.name} 的通告（revision ${v.rev}）整份更新的。`));
  if (r.err) c.append(note('warn', r.err));
  if (v.mode === 'client') c.append(note('muted', 'Client 不能新增或刪除 VLAN，只接收 Server 的通告；要改 VLAN 請到網域裡的 Server。'));
  if (v.mode === 'server' && v.domain) c.append(note('muted', `每改一次 VLAN，revision 加一並通告給整個網域。revision 比較大的交換器一接上 Trunk，大家的 VLAN 都會被它整份取代 — 接上舊交換器之前先把它切到 transparent，或改網域名稱讓 revision 歸零。`));
  if (v.mode === 'transparent') c.append(note('muted', 'Transparent：自己的 VLAN 自己管，不採用別人的通告（但會轉送給其他交換器），revision 永遠是 0。'));
  return c;
}
