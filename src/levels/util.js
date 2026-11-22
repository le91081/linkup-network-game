// 關卡定義共用的小工具（建立狀態、解題、檢查）
import { addCable, peerOf } from '../engine/model.js';
import { isCiscoOs } from '../engine/files.js';

/**
 * 每一關的設備都已經由「前任管理員」設好的東西（index.js 在每一關的 setup() 之後套用；
 * 關卡自己另外建的狀態，例如拿來產生 Git 歷史的舊版網路，也要套用才會一樣）
 */
export function levelDefaults(s) {
  // spanning-tree portfast default：接終端設備的埠一連上就開始轉送。原廠預設是關閉的（要等 30 秒），在自由模式放一台新的交換器就會遇到。
  for (const d of Object.values(s.devices)) if (d.sw && d.sw.stp && d.sw.stp.portfastDefault == null) d.sw.stp.portfastDefault = true;
  // 遠端管理：網域名稱、SSH 用的 RSA 金鑰、vty 用本機帳號登入（login local）。
  // 原廠的 Cisco 設備這些都沒有，所以 SSH 連不進去；在自由模式或第 11 章會遇到
  for (const d of Object.values(s.devices)) {
    if (!d.mgmt || !isCiscoOs(d)) continue;
    if (d.mgmt.sshKey === undefined) { d.mgmt.sshKey = { bits: 2048, gen: 1 }; d.mgmt.domain ||= 'corp.local'; }
    if (d.mgmt.vtyLogin === undefined) d.mgmt.vtyLogin = 'local';
    if (d.mgmt.snmp === undefined) { d.mgmt.snmp = 'v2c'; d.mgmt.community ||= 'public'; } // 前任留下的 SNMP v2c public
  }
  return s;
}

export const dev = (s, id) => s.devices[id];
export const ifc = (s, id, iid) => dev(s, id).ifaces.find((i) => i.id === iid);
export const link = (s, a, b, kind) => {
  const [ad, ap] = a.split(':'), [bd, bp] = b.split(':');
  const e = addCable(s, ad, ap, bd, bp, kind);
  if (e) throw new Error(e);
};
export const setIp = (s, id, ip, mask = '255.255.255.0', gw = '', dns = '') =>
  Object.assign(dev(s, id).ifaces[0], { mode: 'static', ip, mask, gateway: gw, dns });
export const useDhcp = (s, id) => { dev(s, id).ifaces[0].mode = 'dhcp'; };
export const swp = (s, id, pid) => dev(s, id).sw.ports[pid];
export const addVlan = (s, id, vid, name) => {
  const v = dev(s, id).sw.vlans;
  if (!v.some((x) => x.id === vid)) v.push({ id: vid, name });
};
/** 交換器上接到某台設備的那個埠的設定 */
export const portTo = (s, swId, devId) => {
  for (const p of dev(s, swId).ports) {
    const peer = peerOf(s, swId, p.id);
    if (peer && peer.dev === devId) return dev(s, swId).sw.ports[p.id];
  }
  return null;
};
/** 交換器上接到某台設備的那個埠「現在」的模式：access / trunk / down（dynamic 的埠要看 DTP 的結果） */
export const operTo = (s, swId, devId) => {
  for (const p of dev(s, swId).ports) {
    const peer = peerOf(s, swId, p.id);
    if (peer && peer.dev === devId) { const t = dev(s, swId).rt && dev(s, swId).rt.dtp && dev(s, swId).rt.dtp[p.id]; return t ? t.oper : dev(s, swId).sw.ports[p.id].mode; }
  }
  return null;
};
export const wlan = (s, id) => dev(s, id).ifaces.find((i) => i.bind.t === 'wlan');
export const joinWifi = (s, id, ssid, pass) => Object.assign(wlan(s, id).wifi, { ssid, pass });

export const WEB = [{ proto: 'tcp', port: 443, name: 'HTTPS 網站' }, { proto: 'tcp', port: 80, name: 'HTTP 網站' }];
export const DB = [{ proto: 'tcp', port: 3306, name: 'MySQL 資料庫' }];
export const SSH = [{ proto: 'tcp', port: 22, name: 'SSH' }];
