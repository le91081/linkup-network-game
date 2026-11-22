// MTU：一個訊框最多可以裝多大的 IP 封包
//
// 第三層（路由器、主機）：封包比出去那個介面的 MTU 大時
//   沒有設 DF → 切成好幾片（分段），到了目的地再組回來
//   設了 DF   → 丟掉，回一個 ICMP「需要分段」(type 3 code 4) 給送的人，裡面寫著下一段的 MTU。
//               送的人收到之後改送小一點的封包，這就是 Path MTU Discovery (PMTUD)
//   ICMP 被 ACL 擋掉的話，送的人永遠不知道 → PMTUD 黑洞：連線建立得起來，大的資料卻一直送不過去
// 第二層（交換器）：訊框比這個埠能收的大，就當成 giant 直接丟掉，不會通知任何人
//   兩台主機都開了 Jumbo Frame (MTU 9000)，中間的交換器沒開 → ping 會通、傳檔卻卡住
// TCP：交握時兩端各自告訴對方 MSS（自己的 MTU − 40），取小的那一個；
//   路由器的 ip tcp adjust-mss 會把經過的 SYN 裡的 MSS 改小（常用在 VPN、PPPoE）
//
// 設定放在：
//   i.mtu          第三層介面的 IP MTU（路由器的 ip mtu、主機網卡的 MTU、Nexus 的 SVI）
//   i.l2mtu        路由器介面的 mtu（介面本身能收送多大的訊框，ip mtu 預設跟著它）
//   i.adjMss       ip tcp adjust-mss
//   d.sw.jumbo     Catalyst 2960 的 system mtu jumbo（重新開機才生效，生效中的值在 state.dyn.clk[id].jumbo）
//   d.sw.sysMtu    Catalyst 9300 的 system mtu（馬上生效）
//   d.sw.ports[p].mtu  Nexus 每個埠的 mtu
//   d.vsw.mtu      ESXi 虛擬交換器的 MTU
import { CATALOG } from './model.js';

export const MTU_DEF = 1500;
/** 站對站 IPsec（ESP 通道模式、AES、SHA）多出來的標頭：外層 IP 20 + ESP 8 + IV 16 + 填充與尾端最多 17 + 驗證 12 */
export const IPSEC_OVERHEAD = 73;
export const PPPOE_OVERHEAD = 8;
/** 802.11 的一個訊框最多 2304 位元組：無線網路不能跑 Jumbo Frame */
export const WIFI_MTU = 2304;

const NEXUS = new Set(['n93180', 'n9332']);
export const isNexus = (d) => NEXUS.has(d.model);
export const isCat2960 = (d) => d.kind === 'mswitch' && /^c2960/.test(d.model);
export const isCat9300 = (d) => d.model === 'c9300';

/** Catalyst 2960 目前生效的 Jumbo MTU（system mtu jumbo 要重新開機才換） */
export function jumboNow(state, d) {
  const c = state && state.dyn && state.dyn.clk && state.dyn.clk[d.id];
  return (c && c.jumbo) || +(d.sw && d.sw.jumbo) || MTU_DEF;
}

/** 這台第二層設備的某個埠，能收（和送）多大的 IP 封包 */
export function l2Mtu(state, d, pid) {
  switch (d.kind) {
    case 'hub': return 65535; // 集線器只是把電訊號複製出去，不看訊框
    case 'switch': return 16000; // TL-SG105 / TL-SG108 原生就支援 16 KB 的 Jumbo Frame
    case 'mswitch': return isCat2960(d) ? jumboNow(state, d) : +(d.sw && d.sw.sysMtu) || MTU_DEF;
    case 'l3switch':
      if (isNexus(d)) return +((d.sw.ports[pid] || {}).mtu) || MTU_DEF;
      return +d.sw.sysMtu || MTU_DEF;
    case 'hypervisor': return +(d.vsw && d.vsw.mtu) || MTU_DEF;
    case 'ap': return WIFI_MTU;
    default: return MTU_DEF;
  }
}

/** 第三層介面送出去的 IP 封包最大多大 */
export function ipMtu(state, d, i) {
  if (!i) return MTU_DEF;
  if (+i.mtu > 0) return +i.mtu;
  const b = i.bind || {};
  if (b.t === 'loop') return MTU_DEF;
  if (b.t === 'gre') return (i.rt && i.rt.tun && i.rt.tun.mtu) || MTU_DEF - 24; // Tunnel：外層介面的 MTU 扣掉 GRE / IPsec 的標頭
  let m = MTU_DEF;
  if (d.kind === 'l3switch') {
    if (isNexus(d)) m = b.t === 'port' ? +((d.sw.ports[b.port] || {}).mtu) || MTU_DEF : MTU_DEF;
    else m = +d.sw.sysMtu || MTU_DEF; // Catalyst 9300：SVI 與 routed 埠跟著 system mtu
  } else if (d.kind === 'router' || d.kind === 'firewall') m = +i.l2mtu || MTU_DEF;
  if (i.mode === 'pppoe') m -= PPPOE_OVERHEAD; // PPPoE 的標頭佔掉 8 位元組：1492
  return m;
}

/** 第三層介面收得進來的 IP 封包最大多大（訊框太大，網卡直接丟掉） */
export function rxMtu(state, d, i) {
  if (!i) return MTU_DEF;
  if (d.kind === 'router' || d.kind === 'firewall') return Math.max(+i.l2mtu || MTU_DEF, +i.mtu || 0);
  if (d.kind === 'internet' || d.kind === 'cloud') return 9216;
  return ipMtu(state, d, i);
}

/** IP 封包加上乙太網路的標頭（不含 FCS）：Windows 的「Jumbo Packet 9014 Bytes」就是 9000 + 14 */
export const frameOf = (len) => len + 14;

/** 這台設備經過的 SYN 會被改成多少 MSS（沒有限制就是 Infinity） */
export function mssClampOf(state, d, inIf, outIf) {
  let m = Infinity;
  for (const i of [inIf, outIf]) if (i && +i.adjMss > 0) m = Math.min(m, +i.adjMss);
  // 家用路由器會自動把 MSS 改成 WAN 的 MTU − 40（PPPoE 就是 1452），使用者不用設定
  if (d.kind === 'homerouter') {
    const wan = [inIf, outIf].find((i) => i && /^wan/.test(i.id));
    if (wan) m = Math.min(m, ipMtu(state, d, wan) - 40);
  }
  return m;
}

/** ACL 可以比對的 ICMP 類型 */
export const ICMP_TYPES = ['echo', 'echo-reply', 'unreachable', 'packet-too-big', 'time-exceeded', 'administratively-prohibited'];
/** 一個 ICMP 封包符不符合 ACL 寫的類型 */
export function icmpTypeMatch(type, pkt) {
  if (!type) return true;
  if (pkt.icmpErr === 'frag') return type === 'packet-too-big' || type === 'unreachable';
  if (pkt.icmpErr) return type === 'unreachable';
  return type === (pkt.reply ? 'echo-reply' : 'echo');
}

/** 主機的網卡能不能開 Jumbo Frame（手機、IP 電話、印表機不行） */
export const jumboCapable = (d) => d.kind === 'host' && !(CATALOG[d.model] || {}).phone && !/printer/.test(d.model);
