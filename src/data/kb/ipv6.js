// 知識庫：IPv6
export const IPV6 = [
  {
    id: 'ipv6-addr', t: 'IPv6 位址', en: 'IPv6 addressing', cat: 'ipv6', keys: ['IPv6', 'IPv6 位址', 'link-local', 'Link-local', 'fe80', '全域單播', 'GUA'], tags: ['IPv6', 'IPv6-only', 'IPv6 靜態路由', 'ipv6'],
    sum: '128 位元，寫成 8 組十六進位（2001:db8:1::10）；每個介面通常同時有一個 link-local（fe80::，只在本地）和一個或幾個全域位址。',
    body: [
      '連續的 0 可以縮寫成 ::（一個位址只能用一次），每組前面的 0 可以省略。網段幾乎都是 /64：前 64 位元是網段、後 64 位元是介面 ID。',
      'link-local 只在同一條線上有效，路由協定的鄰居與預設閘道都用它；路由器要開 ipv6 unicast-routing 才會轉送 IPv6 與送 RA。IPv6 沒有廣播，改用多點傳送（ff02::1 所有節點、ff02::2 所有路由器）。',
    ],
    fig: { type: 'table', head: ['開頭', '類型', '用途'], rows: [['2000::/3', '全域單播（GUA）', '網際網路上唯一'], ['fe80::/10', 'link-local', '同一條線，每個介面都有'], ['fc00::/7（fd..）', 'ULA', '內部用，像私有位址'], ['ff00::/8', '多點傳送', '取代廣播'], ['::1', '本機迴路', '像 127.0.0.1']] },
    cmd: [{ v: 'Cisco IOS', c: ['ipv6 unicast-routing', 'interface Gi0/0/1', ' ipv6 address 2001:db8:1::1/64', ' ipv6 enable', 'show ipv6 interface brief'] }, { v: 'Linux', c: ['ip -6 addr', 'ip -6 route', 'ping -6 2001:db8:1::10'] }],
    see: ['slaac', 'ndp', 'dual-stack'],
  },
  {
    id: 'slaac', t: 'SLAAC 與 RA', en: 'SLAAC / Router Advertisement', cat: 'ipv6', keys: ['SLAAC', 'RA', 'Router Advertisement', 'M 旗標', 'O 旗標'], tags: ['SLAAC', 'Router Advertisement'],
    sum: '路由器定期送 RA 宣告網段（/64）與自己是閘道；電腦用這個網段加上自己產生的介面 ID 組出位址，不需要 DHCP 伺服器。',
    body: ['RA 的旗標告訴用戶端怎麼拿位址：A = 自己用 SLAAC 組；M = 位址找 DHCPv6（有狀態）；O = 位址自己組，但 DNS 這些其他設定找 DHCPv6（無狀態）。路由器沒開 ipv6 unicast-routing 就不會送 RA，電腦只有 link-local。'],
    see: ['ipv6-addr', 'dhcpv6', 'ra-guard'],
  },
  {
    id: 'dhcpv6', t: 'DHCPv6 與 Prefix Delegation', en: 'DHCPv6 / PD', cat: 'ipv6', keys: ['DHCPv6', 'DHCPv6-PD', 'Prefix Delegation', '一般前綴'], tags: ['DHCPv6', 'DHCPv6-PD', '一般前綴', 'ISP'],
    sum: 'DHCPv6 發位址或 DNS 等設定（閘道仍然靠 RA）；Prefix Delegation 讓 ISP 發一整段前綴（例如 /56）給客戶的路由器，路由器再切成好幾個 /64 給內部的網段用。',
    body: ['ISP 換了發給你的前綴時，用「一般前綴」（general prefix）寫的介面位址會自動跟著改，不用一個一個改。'],
    see: ['slaac', 'ipv6-addr'],
  },
  {
    id: 'ndp', t: 'NDP', en: 'Neighbor Discovery Protocol', cat: 'ipv6', keys: ['NDP', 'Neighbor Discovery', 'Neighbor Solicitation', 'DAD'], tags: [],
    sum: 'IPv6 用 ICMPv6 取代 ARP 與很多零碎的功能：問鄰居的 MAC（NS / NA）、找路由器（RS / RA）、檢查位址有沒有重複（DAD）、Redirect。',
    body: ['因為 NDP 都是 ICMPv6：IPv6 的 ACL 隱含的 permit icmp nd-na / nd-ns 被自己寫的 deny ipv6 any any 蓋掉時，鄰居會找不到彼此。'],
    see: ['arp', 'slaac', 'ra-guard'],
  },
  {
    id: 'dual-stack', t: '雙協定', en: 'Dual stack / Happy Eyeballs', cat: 'ipv6', keys: ['雙協定', 'Dual Stack', 'dual-stack', 'Happy Eyeballs', 'AAAA'], tags: ['Dual Stack', '雙協定', 'Happy Eyeballs', 'AAAA', '過渡機制'],
    sum: '設備同時有 IPv4 和 IPv6：DNS 同時查 A 與 AAAA，作業系統優先用 IPv6；Happy Eyeballs 讓 IPv6 一下子連不上時很快改用 IPv4，使用者感覺不到。',
    body: ['IPv6 的路壞了但沒有完全不通（例如防火牆擋了 IPv6）：沒有 Happy Eyeballs 的程式會先卡在 IPv6 等很久才放棄。只有 IPv4 的防火牆政策也要記得補上 IPv6 的。'],
    see: ['ipv6-addr', 'dns', 'nat64'],
  },
  {
    id: 'nat64', t: 'NAT64 與 DNS64', en: 'NAT64 / DNS64', cat: 'ipv6', keys: ['NAT64', 'DNS64', '64:ff9b::'], tags: ['NAT64', 'DNS64', 'IPv6-only'],
    sum: '只有 IPv6 的用戶端要連只有 IPv4 的網站：DNS64 把 A 記錄合成成 64:ff9b::/96 的 AAAA，NAT64 把這些位址的流量轉換成 IPv4 送出去。',
    body: ['只有 NAT64 沒有 DNS64：用戶端查不到 AAAA，根本不會送封包。寫死 IPv4 位址的程式（不查 DNS）在純 IPv6 的網路上也會失敗。'],
    see: ['dual-stack', 'nat'],
  },
  {
    id: 'ra-guard', t: 'RA Guard', en: 'IPv6 RA Guard', cat: 'ipv6', keys: ['RA Guard'], tags: ['RA Guard'],
    sum: '交換器只讓接路由器的埠送出 RA：有人（或中毒的電腦）送假的 RA，宣稱自己是閘道，整個網段的 IPv6 流量就會被騙過去。',
    body: ['就像 IPv4 的 DHCP Snooping：存取埠套用 device-role host 的政策，擋掉 RA；往真正路由器的埠設成 router。'],
    see: ['slaac', 'dhcp-snooping'],
  },
];
