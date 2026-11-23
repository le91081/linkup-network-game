// 虛擬化主機（ESXi）的設定頁面：虛擬交換器、連接埠群組、虛擬機器
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, cardHead, badge, grid2, del, bind, linkBadge, isIp, isMask, isNum, toggle } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { pgVlan, vmsOn, teamUplinks, pinnedUplink, vmotionCheck, vmotion } from '../engine/virt.js';
import { transact } from '../engine/sim.js';
import { newIface } from '../engine/model.js';
import { vswMtuField, vmkMtuField } from './panel-mtu.js';

const vlanText = (v) => (+v > 0 ? `VLAN ${+v}（加標籤）` : '不加標籤（VLAN 0）');

/** 虛擬交換器：連接埠群組、每台虛擬機器在哪個群組、上行、管理介面 vmk0 */
export function vswTab(ctx, body) {
  const { dev, state } = ctx;
  const v = dev.vsw;
  const names = v.pgs.map((p) => p.name);
  // NIC teaming：兩張上行、每台 VM 固定走哪一張、備用的上行
  const team = teamUplinks(state, dev), vmsT = vmsOn(state, dev);
  body.append(h('div', { class: 'card' }, cardHead('上行（NIC teaming）'),
    field('負載平衡', sel(ctx, () => v.teaming || 'port', (x) => { if (x === 'port') delete v.teaming; else v.teaming = x; }, [['port', 'Route based on originating virtual port'], ['iphash', 'Route based on IP hash']], { rerender: true })),
    note('muted', v.teaming === 'iphash' ? 'IP hash：兩張上行當成一條 EtherChannel，每條連線依來源 / 目的 IP 分散。標準 vSwitch 不會 LACP：實體交換器那一端要 channel-group … mode on（靜態），而且兩張上行要接同一台交換器（或堆疊 / vPC）。' : '負載平衡：Route based on originating virtual port。每台 VM 固定走一張有連線的上行（依虛擬埠輪流分配），那張斷線就改走另一張。兩張上行接到的實體交換器埠，VLAN 設定要一模一樣：不然固定走某一張的 VM 會不通。'),
    v.teaming === 'iphash' ? ctx.live(() => { const l = dev.ports.filter((p) => p.media !== 'virt').map((p) => dev.rt.lag && dev.rt.lag[p.id]).filter(Boolean); const bad = l.find((x) => x.state !== 'bundled'); return bad ? note('warn', `EtherChannel 沒有綁起來：${bad.why}`) : l.length ? note('ok', `兩張上行綁成一條 EtherChannel（${l.length} 條都在用）`) : null; }) : null,
    team.ups.map((id) => h('div', { class: 'line' }, h('b', { class: 'mono', text: id }), linkBadge(ctx, id),
      h('span', { class: 'muted', text: (() => { const on = vmsT.filter((m) => pinnedUplink(state, dev, m.port) === id).map((m) => m.vm.name); if (pinnedUplink(state, dev, 'vmk0') === id) on.unshift('vmk0'); return on.length ? '走這張：' + on.join('、') : team.linked.includes(id) ? '（沒有 VM 走這張）' : '（沒有連線）'; })() }),
      toggle(ctx, () => ((v.standby ||= []).includes(id)), (x) => { v.standby = x ? [...new Set([...(v.standby || []), id])] : (v.standby || []).filter((y) => y !== id); }, '備用 (standby)', { rerender: true })))));
  // 連接埠群組
  const pgCard = h('div', { class: 'card' }, cardHead('連接埠群組 (Port Group)'),
    note('muted', '虛擬機器的網卡接在哪個連接埠群組，就在哪個 VLAN。VLAN ID 0 不加標籤；1 – 4094 從上行 (vmnic) 送出去時加上 802.1Q 標籤，實體交換器那一端要是 Trunk。'),
    h('div', { class: 'thead c-pg' }, h('span', { text: '名稱' }), h('span', { text: 'VLAN ID' }), h('span', { text: '使用中' }), h('span')),
    v.pgs.map((p, n) => {
      const used = dev.ports.filter((x) => x.media === 'virt' && dev.sw.ports[x.id].pg === p.name && vmsOn(state, dev).some((m) => m.port === x.id)).length + (v.vmkPg === p.name ? 1 : 0);
      return h('div', { class: 'trow c-pg' },
        inp(ctx, () => p.name, (x) => {
          const nm = x.trim();
          if (!nm || v.pgs.some((q) => q !== p && q.name === nm)) return;
          for (const pc of Object.values(dev.sw.ports)) if (pc.pg === p.name) pc.pg = nm;
          if (v.vmkPg === p.name) v.vmkPg = nm;
          p.name = nm;
        }, { mono: false, ph: '群組名稱' }),
        inp(ctx, () => String(p.vlan ?? 0), (x) => { p.vlan = +x || 0; }, { ph: '0', check: isNum(0, 4094) }),
        h('span', { class: 'muted', text: used ? `${used} 個` : '—' }),
        del(() => {
          if (used) return toast(`還有 ${used} 個介面接在「${p.name}」，先把它們改到別的群組`, 'bad');
          if (v.pgs.length <= 1) return toast('至少要留一個連接埠群組', 'bad');
          v.pgs.splice(n, 1); ctx.commit(true);
          return undefined;
        }));
    }),
    h('div', { class: 'addrow' }, button('新增連接埠群組', { ic: 'plus', small: true, onclick: () => {
      let k = v.pgs.length + 1;
      while (names.includes('PG-' + k)) k++;
      v.pgs.push({ name: 'PG-' + k, vlan: 0 });
      ctx.commit(true);
    } })));
  // 虛擬機器的網卡
  const vms = vmsOn(state, dev);
  const vmCard = h('div', { class: 'card' }, cardHead('虛擬機器的網卡'),
    vms.length ? vms.map(({ port, vm }) => h('div', { class: 'line' },
      h('b', { text: vm.name }), h('span', { class: 'muted mono', text: (dev.ports.find((p) => p.id === port) || {}).label }),
      sel(ctx, () => dev.sw.ports[port].pg, (x) => { dev.sw.ports[port].pg = x; }, names.map((nm) => [nm, `${nm} · ${vlanText((v.pgs.find((p) => p.name === nm) || {}).vlan)}`]))))
      : note('muted', '還沒有虛擬機器。從虛擬機器拖曳到這台主機就會接上一個虛擬埠。'));
  // 上行與管理介面
  const up = dev.ports.find((p) => p.media !== 'virt');
  const vmk = dev.ifaces.find((i) => i.id === 'vmk0');
  const tagged = [...new Set(v.pgs.filter((p) => +p.vlan > 0).map((p) => +p.vlan))].sort((a, b) => a - b);
  const upCard = h('div', { class: 'card' }, cardHead(`實體網卡 ${up.label}（上行）`, linkBadge(ctx, up.id)),
    note('muted', tagged.length ? `會從這裡送出帶標籤的 VLAN：${tagged.join('、')}。實體交換器的那個埠要設成 Trunk 並放行這些 VLAN；不加標籤的群組落在那個埠的 native VLAN。ESXi 不送 DTP，Catalyst 的 dynamic auto 不會自己變成 Trunk。` : '所有連接埠群組都不加標籤：實體交換器的那個埠可以是一般的 Access 埠。'),
    note('muted', 'vSwitch 不跑 STP、不送 BPDU，也不會把上行收到的封包再轉回上行。'),
    vswMtuField(ctx));
  const vmkCard = vmk && h('div', { class: 'card' }, cardHead('管理介面 vmk0 (VMkernel)', vmk.rt && vmk.rt.ip != null ? badge('on', fmtIp(vmk.rt.ip)) : badge('warn', '沒有位址')),
    field('連接埠群組', sel(ctx, () => v.vmkPg, (x) => { v.vmkPg = x; }, names.map((nm) => [nm, `${nm} · ${vlanText((v.pgs.find((p) => p.name === nm) || {}).vlan)}`]))),
    grid2(
      field('IP 位址', inp(ctx, ...bind(vmk, 'ip'), { ph: '例如 10.0.99.11', check: isIp })),
      field('子網路遮罩', inp(ctx, ...bind(vmk, 'mask'), { ph: '255.255.255.0', check: isMask })),
      field('預設閘道', inp(ctx, ...bind(vmk, 'gateway'), { ph: '選填', check: isIp })),
      vmkMtuField(ctx, vmk)),
    note('muted', `管理員用瀏覽器開 https://${vmk.ip || '這個位址'} 登入 ESXi Host Client；vCenter 也是透過它管理這台主機。目前在 ${vlanText((v.pgs.find((p) => p.name === v.vmkPg) || {}).vlan)}。`));
  // 其他的 VMkernel 介面卡（vMotion 用的 vmk1…）
  const extra = dev.ifaces.filter((i) => /^vmk[1-9]\d*$/.test(i.id));
  const vmkMore = h('div', { class: 'card' }, cardHead('其他的 VMkernel 介面卡'),
    extra.map((i) => h('div', { class: 'card nested' }, cardHead(i.id, i.rt && i.rt.ip != null ? badge('on', fmtIp(i.rt.ip)) : badge('warn', '沒有位址'), del(() => { dev.ifaces = dev.ifaces.filter((x) => x !== i); ctx.commit(true); })),
      grid2(
        field('連接埠群組', sel(ctx, () => i.pg || names[0], (x) => { i.pg = x; }, names.map((nm) => [nm, `${nm} · ${vlanText((v.pgs.find((p) => p.name === nm) || {}).vlan)}`]))),
        field('IP 位址', inp(ctx, ...bind(i, 'ip'), { ph: '例如 10.0.30.11', check: isIp })),
        field('子網路遮罩', inp(ctx, ...bind(i, 'mask'), { ph: '255.255.255.0', check: isMask }))),
      toggle(ctx, () => !!i.vmotion, (x) => { i.vmotion = x; }, '啟用 vMotion', { rerender: true }))),
    note('muted', 'vMotion 用一張獨立的 VMkernel 介面卡，通常在自己的 VLAN 裡。兩台主機的 vMotion 介面卡要互相連得到（TCP 8000），虛擬機器才搬得過去。'),
    h('div', { class: 'addrow' }, button('新增 VMkernel 介面卡', { ic: 'plus', small: true, onclick: () => {
      let k = 1; while (dev.ifaces.some((x) => x.id === 'vmk' + k)) k++;
      dev.ifaces.push(newIface('vmk' + k, 'vmk' + k, { t: 'svi', vlan: 1 }, { pg: names[0] }));
      ctx.commit(true);
    } })));
  body.append(pgCard, vmCard, upCard, ...(vmkCard ? [vmkCard] : []), vmkMore);
}

/** 虛擬機器清單：電源與網路狀態 */
export function vmsTab(ctx, body) {
  const { dev, state, app } = ctx;
  const vms = vmsOn(state, dev);
  // vMotion：可以搬到的其他虛擬化主機；ui 記住選的目的地與上一次的錯誤
  const hosts = Object.values(state.devices).filter((x) => x.kind === 'hypervisor' && x !== dev);
  const ui = ((app.vmUi ||= {})[dev.id] ||= {});
  body.append(h('div', { class: 'card' }, cardHead(`虛擬機器（${vms.length} 台）`),
    vms.length ? vms.map(({ port, vm }) => {
      const off = !!(state.down || {})[vm.id];
      const i = vm.ifaces[0], pg = dev.sw.ports[port].pg;
      return h('div', { class: 'line' },
        h('b', { text: vm.name }),
        h('span', { class: 'muted', text: `${pg} · ${off ? '已關機' : i && i.rt && i.rt.ip != null ? fmtIp(i.rt.ip) : '沒有位址'}` }),
        button(off ? '開機' : '關機', { small: true, onclick: () => app.togglePower(vm.id, true) }),
        hosts.length ? button('遷移 (vMotion)', { small: true, onclick: () => {
          const dst = state.devices[(ui.to ||= hosts[0].id)];
          const chk = vmotionCheck(state, dev, dst, port, transact);
          if (!chk.ok) { ui.err = { vm: vm.id, list: chk.errors }; toast(`無法遷移 ${vm.name}：${chk.errors[0]}`, 'bad', 5000); ctx.commit(true); return; }
          vmotion(state, dev, dst, port);
          ui.err = null;
          toast(`${vm.name} 已經遷移到 ${dst.name}（vMotion：不關機、不斷線地搬過去）`, 'ok', 4000);
          ctx.commit(true);
          app.scene.load(state, { keep: true });
        } }) : null);
    }) : note('muted', '還沒有虛擬機器。'),
    hosts.length ? field('遷移到哪一台主機', sel(ctx, () => ui.to || hosts[0].id, (x) => { ui.to = x; }, hosts.map((x) => [x.id, x.name]))) : null,
    ui.err ? h('div', {}, ui.err.list.map((e) => note('warn', `相容性檢查失敗（${state.devices[ui.err.vm] ? state.devices[ui.err.vm].name : ''}）：${e}`))) : null,
    note('muted', `每台虛擬機器的內部 VLAN：${vms.map(({ port, vm }) => `${vm.name} → ${pgVlan(dev.vsw.pgs.find((p) => p.name === dev.sw.ports[port].pg))}`).join('、') || '—'}（0 表示不加標籤，引擎內部當成 native VLAN 1）`)));
}
