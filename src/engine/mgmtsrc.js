// 設備自己的管理流量（TFTP / FTP 傳檔、Syslog、NTP）從哪個介面、哪個 VRF 送出去。
// 帶外管理埠（Catalyst 9300 的 Gi0/0）在 Mgmt-vrf 裡：伺服器只接在管理網路時，要指定 source-interface 或 vrf，
// 不然會照全域的路由表送，走正式的網路 (in-band)。
//
// d.srcIf = { tftp, ftp }（ip tftp | ftp source-interface <介面>）；d.mgmt.syslogVrf（logging host <IP> vrf <名稱>）、d.mgmt.ntpVrf（ntp server vrf <名稱> <IP>）
export function mgmtSpec(d, kind) {
  const id = (d.srcIf || {})[kind], i = id && d.ifaces.find((x) => x.id === id);
  if (i && i.rt && i.rt.ip != null) return { vrf: i.vrf || '', srcIp: i.rt.ip };
  const m = d.mgmt || {}, v = kind === 'syslog' ? m.syslogVrf : kind === 'ntp' ? m.ntpVrf : '';
  return v ? { vrf: v } : {};
}
/** 帶外管理埠：不是交換埠、只能在 Mgmt-vrf */
export const isMgmtPort = (d, pid) => !!(d.ports || []).find((p) => p.id === pid && p.mgmt);
