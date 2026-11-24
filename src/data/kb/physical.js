// 知識庫：實體層與機房
export const PHYSICAL = [
  {
    id: 'cabling', t: '線材與距離', en: 'Copper, fiber and DAC', cat: 'physical', keys: ['Cat6', '銅纜', '多模光纖', '單模光纖', '光纖', 'DAC', 'OM4', 'OS2'], tags: ['光纖', '線材', '傳輸距離', '接線', '實體層'],
    sum: '銅纜（Cat6）最長 100 公尺；多模光纖便宜、短距離（機房內幾百公尺）；單模光纖可以拉幾公里到幾十公里；DAC 是兩端直接做好接頭的銅纜，只有幾公尺。',
    body: ['100 公尺是整個通道（牆裡的水平佈線加上兩端的跳線）的總長。超過距離就沒有燈號，或燈亮著但錯誤很多。光纖的兩端收發器要配對：多模用 SR、單模用 LR，波長要一樣。'],
    fig: { type: 'table', head: ['線材', '接頭', '距離', '常見用途'], rows: [['Cat6 銅纜', 'RJ45', '100 m', '桌面、AP'], ['DAC', 'SFP+ / QSFP', '1–5 m', '機櫃內，交換器到伺服器'], ['多模（OM4）+ SR', 'LC', '100–400 m', '機房、大樓內'], ['單模（OS2）+ LR', 'LC', '10 km 以上', '大樓之間、園區']] },
    see: ['transceiver', 'patch-panel', 'duplex'],
  },
  {
    id: 'transceiver', t: '收發器', en: 'Transceivers (SFP / QSFP) and breakout', cat: 'physical', keys: ['收發器', 'SFP', 'SFP+', 'SFP28', 'QSFP28', 'QSFP', 'breakout', '光功率', 'show interfaces transceiver'], tags: ['收發器', 'SFP', 'QSFP28', 'SFP28', 'breakout'],
    sum: '光纖埠要插收發器把電訊號轉成光：種類（SR / LR）、速率、波長要和線材與對端一致；收到的光太弱就有錯誤，太弱就 LOS（沒有燈號）。',
    body: [
      '光功率預算：發射功率 − 光纖每公里的衰減 − 接頭損耗 − 髒污 = 收到的功率，低於收發器的靈敏度就不行。接頭髒了是最常見的原因：燈亮著，但 CRC 一直增加。',
      'Cisco 交換器插第三方的收發器可能會被拒絕（err-disabled gbic-invalid）。QSFP28 的 100G 埠可以 breakout 成 4 個 25G（或 10G），用一分四的線接四台伺服器。',
    ],
    cmd: [{ v: 'Cisco IOS', c: ['show interfaces transceiver', 'show inventory'] }, { v: 'NX-OS', c: ['interface breakout module 1 port 49 map 25g-4x'] }],
    see: ['cabling', 'crc'],
  },
  {
    id: 'duplex', t: '速率與雙工', en: 'Speed / duplex / auto-negotiation', cat: 'physical', keys: ['雙工', '半雙工', '全雙工', '雙工不一致', 'duplex', 'speed', 'duplex mismatch', '自動協商'], tags: ['雙工不一致', '半雙工', 'speed'],
    sum: '兩端自動協商出速率與雙工；一端寫死、另一端自動，自動的那一端常常會退回半雙工，變成雙工不一致：通，但很慢、錯誤很多。',
    body: ['雙工不一致的徵兆：ping 正常、傳檔慢得離譜，半雙工那端看到 late collision、全雙工那端看到 CRC / runts。兩端都設自動（或都寫死成一樣）。網路線有一對斷了會降到 100 Mbps。'],
    cmd: [{ v: 'Cisco IOS', c: ['interface Gi0/5', ' speed auto', ' duplex auto', 'show interfaces Gi0/5'] }],
    see: ['crc', 'cabling'],
  },
  {
    id: 'crc', t: '介面計數器', en: 'Interface counters: CRC, runts, giants', cat: 'physical', keys: ['CRC', 'runts', 'giants', 'late collision', '介面計數器', 'show interfaces', 'flapping'], tags: ['CRC', '介面計數器', 'giants', 'flapping'],
    sum: 'show interfaces 的錯誤計數器說明線路的健康狀況：CRC 是收到的訊框檢查碼不對（線材、接頭、干擾）；runts 太小、giants 太大；late collision 多半是雙工不一致。',
    body: ['看計數器要看「有沒有一直增加」：先 clear counters，過一陣子再看。%LINK-3-UPDOWN 一直跳（flapping）加上 CRC 增加，通常是接觸不良的網路線。'],
    cmd: [{ v: 'Cisco IOS', c: ['show interfaces Gi0/5', 'clear counters Gi0/5', 'show logging | include UPDOWN'] }],
    see: ['duplex', 'transceiver', 'mtu'],
  },
  {
    id: 'patch-panel', t: '結構化佈線與配線架', en: 'Structured cabling / patch panel', cat: 'physical', keys: ['配線架', '結構化佈線', '跳線', 'Patch Panel'], tags: ['配線架', '結構化佈線', '跳線'],
    sum: '牆上的網路孔透過牆裡的水平佈線接到機房配線架的背面；正面再用短跳線接到交換器。配線架是被動元件，前後同一孔直接相通。',
    body: ['網路孔沒有燈號時一段一段查：電腦到牆面的跳線、牆裡的佈線（看標籤是配線架的哪一孔）、配線架正面那一孔有沒有跳到交換器。整條通道（兩端跳線加水平佈線）不能超過 100 公尺。標籤與文件是佈線最重要的部分。'],
    see: ['cabling', 'rack'],
  },
  {
    id: 'rack', t: '機櫃與電力', en: 'Rack / PDU', cat: 'physical', keys: ['機櫃', '42U', 'PDU', '1U', '2U'], tags: ['機房', 'PDU', 'PSU', '資料中心'],
    sum: '設備裝在 19 吋機櫃裡，高度以 U 計（1U = 4.45 公分，常見 42U）。重的（UPS）放下面、配線架放在交換器旁邊，每個機櫃的用電不要超過 PDU 的 80%。',
    body: ['雙電源的設備兩顆電源要接到不同的 PDU（A 路、B 路），任何一路斷電都不會停機。機櫃前進冷風、後排熱風，設備的方向要一致。'],
    see: ['ups', 'patch-panel'],
  },
  {
    id: 'ups', t: 'UPS 與電力備援', en: 'UPS / power redundancy', cat: 'physical', keys: ['UPS', '不斷電系統', '電力備援', '雙電源', 'PSU'], tags: ['UPS', '電力備援', '停電演練', '負載', 'PSU'],
    sum: '市電中斷時 UPS 用電池供電，撐到發電機啟動或安全關機：電池時間 ≈ 電池容量（Wh）× 效率 ÷ 負載（W）；超過額定瓦數會直接過載停止輸出。',
    body: ['只有 A 路有 UPS 時，停電的那一刻雙電源設備的全部負載都壓到 A 路：平常只用一半，停電時突然變兩倍，UPS 可能過載。不重要的設備可以只接沒有 UPS 的那一路，把電池留給核心設備。'],
    see: ['rack', 'ha-fw'],
  },
];
