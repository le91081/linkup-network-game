// 伺服器虛擬化：VMware ESXi 這類的虛擬化主機 (Type 1 hypervisor)
//
// 主機裡面有一台虛擬交換器 (vSwitch)：實體網卡 vmnic0、vmnic1 是上行（NIC teaming），每台虛擬機器 (VM) 的虛擬網卡接在一個虛擬埠上。
// 虛擬埠屬於哪一個「連接埠群組 (port group)」，就決定它在哪個 VLAN：
//   VLAN ID 0     不加標籤，從上行出去就落在實體交換器那個埠的 native / access VLAN
//   VLAN ID 1–4094 從上行送出去時加上 802.1Q 標籤（Virtual Switch Tagging），實體交換器那一端要是 Trunk
// vSwitch 不跑 STP、不送 BPDU；主機自己的管理介面 vmk0 (VMkernel) 也接在一個連接埠群組上。
//
// 設定：d.vsw = { pgs: [{ name, vlan }], vmkPg }；虛擬埠：d.sw.ports[埠].pg = 連接埠群組的名稱
// 引擎把它當成一台 VLAN 交換器來算：每次計算前用 syncVsw 把連接埠群組換算成埠的 VLAN。

export const isHypervisor = (d) => !!d && d.kind === 'hypervisor';
/** 連接埠群組在 vSwitch 內部用的 VLAN：0（不加標籤）走上行的 native VLAN 1 */
export const pgVlan = (pg) => (pg && +pg.vlan > 0 && +pg.vlan < 4095 ? +pg.vlan : 1);
export const pgOf = (d, name) => (d.vsw.pgs.find((p) => p.name === name) || d.vsw.pgs[0] || null);

/** 把連接埠群組換算成 vSwitch 的 VLAN 與各埠的設定 */
export function syncVsw(d) {
  if (!isHypervisor(d) || !d.vsw) return;
  const vlans = new Map([[1, 'native']]);
  for (const p of d.vsw.pgs) if (!vlans.has(pgVlan(p)) || vlans.get(pgVlan(p)) === 'native') vlans.set(pgVlan(p), p.name);
  d.sw.vlans = [...vlans.entries()].sort((a, b) => a[0] - b[0]).map(([id, name]) => ({ id, name }));
  for (const p of d.ports) {
    const pc = d.sw.ports[p.id];
    if (p.media === 'virt') Object.assign(pc, { mode: 'access', vlan: pgVlan(pgOf(d, pc.pg)) });
    else Object.assign(pc, { mode: 'trunk', native: 1, allowed: 'all' });
  }
  const vmk = d.ifaces.find((i) => i.id === 'vmk0');
  if (vmk) vmk.bind.vlan = pgVlan(pgOf(d, d.vsw.vmkPg));
}

/**
 * NIC teaming（預設的負載平衡：Route based on originating virtual port）：每一個虛擬埠（和 vmk0）固定走一張「目前有連線」的上行，
 * 依虛擬埠的編號輪流分配；那張網卡斷線 (link down) 就改走另一張。vSwitch 不會把一張上行收到的訊框從另一張上行送出去（沒有迴圈，也不需要 STP）。
 * d.vsw.standby = ['vmnic1']：備用的上行，平常不用，作用中的都斷了才接手
 */
export function teamUplinks(state, d) {
  const ups = d.ports.filter((p) => p.media !== 'virt').map((p) => p.id);
  const linked = ups.filter((id) => state.rt.links[d.id + ':' + id]);
  const standby = new Set((d.vsw && d.vsw.standby) || []);
  const active = linked.filter((id) => !standby.has(id));
  return { ups, linked, active: active.length ? active : linked };
}
/** 這個虛擬埠（或 'vmk0'）現在走哪一張上行 */
export function pinnedUplink(state, d, vport) {
  const { active } = teamUplinks(state, d);
  if (!active.length) return null;
  const n = vport === 'vmk0' ? 0 : +(String(vport).match(/(\d+)$/) || [0, 0])[1];
  return active[n % active.length];
}

/** 接在這台主機上的虛擬機器：[{ port, vm（設備）}] */
export function vmsOn(state, d) {
  const out = [];
  for (const p of d.ports) {
    if (p.media !== 'virt') continue;
    const c = state.cables.find((x) => (x.a.dev === d.id && x.a.port === p.id) || (x.b.dev === d.id && x.b.port === p.id));
    if (!c) continue;
    const o = c.a.dev === d.id ? c.b : c.a;
    if (state.devices[o.dev]) out.push({ port: p.id, vm: state.devices[o.dev] });
  }
  return out;
}
