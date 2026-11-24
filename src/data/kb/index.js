// 知識庫：觀念、技術與演算法的說明（左側「知識庫」分頁）
//
// 每一則：
//   id      識別名稱（英文小寫）
//   t       標題（畫面上的名稱，也是連結的關鍵字）
//   en      英文全名（可省略）
//   cat     分類（CATS 的 id）
//   keys    文字裡出現這些字就連結到這一則（標題本身一定算）
//   tags    關卡標籤對得上這些字，就算「這一關會用到」（關鍵字本身也算）
//   sum     一句話的摘要（滑鼠移到名詞上看到的就是這一句）
//   body    說明的段落
//   steps   { t: 標題, items: [...] }：運作流程或演算法的步驟
//   fig     圖：{ type: 'fields' | 'ladder' | 'table' | 'bits', ... }（見 ui/kb.js 的 figure）
//   pit     常見的錯誤與誤解
//   cmd     [{ v: 平台, c: [指令…] }]
//   see     相關的觀念（id）
import { BASICS } from './basics.js';
import { SERVICES } from './services.js';
import { SWITCHING } from './switching.js';
import { ROUTING } from './routing.js';
import { SECURITY } from './security.js';
import { WAN } from './wan.js';
import { WIRELESS } from './wireless.js';
import { IPV6 } from './ipv6.js';
import { PHYSICAL } from './physical.js';
import { OPS } from './ops.js';
import { CLOUD } from './cloud.js';
import { MORE } from './more.js';
import { buildIndex } from './match.js';

export const CATS = [
  { id: 'basics', name: '網路基礎', desc: 'IP 位址、子網路、MAC、ARP、TCP / UDP' },
  { id: 'services', name: 'IP 服務', desc: 'DHCP、DNS、NAT、NTP、Syslog、QoS' },
  { id: 'switching', name: '交換與 VLAN', desc: 'MAC 位址表、VLAN、Trunk、STP、EtherChannel' },
  { id: 'routing', name: '路由', desc: '路由表、靜態路由、OSPF、EIGRP、BGP、FHRP' },
  { id: 'security', name: '網路安全', desc: 'ACL、防火牆、L2 安全、802.1X、憑證' },
  { id: 'wan', name: 'VPN 與廣域網路', desc: 'IPsec、GRE、DMVPN、SSL-VPN、SD-WAN、MPLS' },
  { id: 'wireless', name: '無線網路', desc: '頻段與頻道、WPA2 / WPA3、漫遊、無線控制器' },
  { id: 'ipv6', name: 'IPv6', desc: '位址、SLAAC、DHCPv6、雙協定、NAT64' },
  { id: 'physical', name: '實體層與機房', desc: '線材、收發器、雙工、介面計數器、UPS' },
  { id: 'ops', name: '高可用與維運', desc: '帶外管理、設定管理、韌體、AAA、監控' },
  { id: 'cloud', name: '自動化、雲端與虛擬化', desc: 'RESTCONF、Ansible、Terraform、VPC、虛擬交換器' },
];

export const CONCEPTS = [...BASICS, ...SERVICES, ...SWITCHING, ...ROUTING, ...SECURITY, ...WAN, ...WIRELESS, ...IPV6, ...PHYSICAL, ...OPS, ...CLOUD, ...MORE];
export const CONCEPT = Object.fromEntries(CONCEPTS.map((c) => [c.id, c]));
export const KB_INDEX = buildIndex(CONCEPTS);
