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
    else Object.assign(pc, { mode: 'trunk', native: 1, allowed: 'all', lag: d.vsw.teaming === 'iphash' ? '1' : '', lagMode: 'on' }); // IP hash：上行是一條靜態的 EtherChannel
  }
  const vmk = d.ifaces.find((i) => i.id === 'vmk0');
  if (vmk) vmk.bind.vlan = pgVlan(pgOf(d, d.vsw.vmkPg));
  // 其他的 VMkernel 介面卡（vmk1…，例如 vMotion 用的）：各自接在自己的連接埠群組 (i.pg)
  for (const i of d.ifaces) if (/^vmk[1-9]\d*$/.test(i.id)) i.bind.vlan = pgVlan(pgOf(d, i.pg));
}

// ── vMotion：虛擬機器不關機，從一台主機搬到另一台 ──
// vCenter 先做相容性檢查：兩台主機都要有啟用 vMotion 的 VMkernel 介面卡、彼此連得到（vMotion 網路，TCP 8000）、
// 目的主機要有「同名」的連接埠群組、還有空的虛擬埠。注意：vCenter 只比對名稱，不比對 VLAN ID ——
// 目的主機的同名群組 VLAN 設錯，虛擬機器照樣搬過去，只是一到那邊就斷線。
export const vmotionVmk = (d) => d.ifaces.find((i) => /^vmk\d+$/.test(i.id) && i.vmotion);
const freeVport = (state, d) => d.ports.find((p) => p.media === 'virt' && !state.cables.some((c) => (c.a.dev === d.id && c.a.port === p.id) || (c.b.dev === d.id && c.b.port === p.id)));
/** 相容性檢查：回傳 { ok, errors: [原因…] }。transact 從引擎傳進來（避免循環引用） */
export function vmotionCheck(state, src, dst, vport, transact) {
  const errors = [];
  if (!dst || dst.kind !== 'hypervisor') return { ok: false, errors: ['目的地要是另一台虛擬化主機'] };
  if (dst === src) return { ok: false, errors: ['虛擬機器已經在這台主機上'] };
  if ((state.down || {})[dst.id] || state.rt.off[dst.id]) errors.push(`${dst.name} 沒有開機`);
  const pg = src.sw.ports[vport].pg;
  if (!dst.vsw.pgs.some((p) => p.name === pg)) errors.push(`目的主機 ${dst.name} 沒有連接埠群組「${pg}」（Network "${pg}" is not accessible on the destination host）`);
  if (!freeVport(state, dst)) errors.push(`${dst.name} 沒有空的虛擬埠`);
  const a = vmotionVmk(src), b = vmotionVmk(dst);
  if (!a) errors.push(`${src.name} 沒有啟用 vMotion 的 VMkernel 介面卡`);
  if (!b) errors.push(`${dst.name} 沒有啟用 vMotion 的 VMkernel 介面卡`);
  if (a && b) {
    if (a.rt.ip == null || b.rt.ip == null) errors.push(`vMotion 的 VMkernel 介面卡沒有位址（${a.rt.ip == null ? src.name : dst.name}）`);
    else {
      const r = transact(state, src.id, { proto: 'tcp', dst: b.rt.ip, dport: 8000, srcIp: a.rt.ip, quiet: true, bulk: false });
      if (!r.ok) errors.push(`vMotion 網路不通：${src.name} 的 ${a.id} 連不到 ${dst.name} 的 ${b.id}（${r.reason}）`);
    }
  }
  return { ok: !errors.length, errors };
}
/** 真的搬過去：虛擬網卡改接到目的主機的空虛擬埠，接在同名的連接埠群組上；虛擬機器在場景裡移到目的主機旁邊 */
export function vmotion(state, src, dst, vport) {
  const c = state.cables.find((x) => (x.a.dev === src.id && x.a.port === vport) || (x.b.dev === src.id && x.b.port === vport));
  const free = freeVport(state, dst);
  if (!c || !free) return null;
  const pg = src.sw.ports[vport].pg, end = c.a.dev === src.id ? c.a : c.b, vm = state.devices[(c.a.dev === src.id ? c.b : c.a).dev];
  end.dev = dst.id; end.port = free.id;
  dst.sw.ports[free.id].pg = pg;
  const n = vmsOn(state, dst).length;
  vm.pos = [dst.pos[0] - 3 + ((n - 1) % 4) * 2, dst.pos[1] + 4.5];
  return { vm, port: free.id };
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
/**
 * Route based on IP hash：上行綁成一條「靜態」的 EtherChannel（標準 vSwitch 不會 LACP），
 * 實體交換器那一端也要 channel-group … mode on，而且兩張上行要接同一台（或堆疊 / vPC）
 */
export const isIpHash = (d) => !!(d && d.vsw && d.vsw.teaming === 'iphash');
/** 這個虛擬埠（或 'vmk0'）現在走哪一張上行 */
export function pinnedUplink(state, d, vport) {
  if (isIpHash(d)) return null; // IP hash：每條連線依來源 / 目的 IP 分散到兩張上行（當成一條 EtherChannel）
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
