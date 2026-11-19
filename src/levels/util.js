// 關卡定義共用的小工具（建立狀態、解題、檢查）
import { addCable, peerOf } from '../engine/model.js';

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
