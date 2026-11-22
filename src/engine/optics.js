// 光纖收發器（SFP / SFP+ / SFP28 / QSFP28）：每條光纖的兩端各插一顆。
// 連得起來要：收發器和光纖的種類相符（SR 用多模、LR 用單模）、兩端的波長一樣、速率一樣、距離在規格以內，
// 而且收到的光功率 (Rx) 在收發器的靈敏度以上。光功率差一點點：燈會亮，但收到的訊框有 CRC 錯誤、會掉封包；差太多：沒有燈號 (LOS)。
// Cisco 的設備只接受 Cisco 編碼的收發器：第三方的會被關成 err-disabled (gbic-invalid)，除非 service unsupported-transceiver。
//
// 線材：c.optics = { a: 料號, b: 料號 }（沒有的話依照線材與兩端的埠自動挑）；c.dirty = { a: true }（那一端的接頭髒了）

/** 收發器的規格：Tx 是發射功率、rx 是接收靈敏度（dBm），reach 是規格的最長距離（公尺） */
export const OPTICS = {
  'GLC-SX-MMD': { type: '1000BASE-SX', form: 'sfp', speed: 1000, nm: 850, fiber: 'mmf', reach: 550, tx: -5.0, rx: -17.0, vendor: 'Cisco' },
  'GLC-LH-SMD': { type: '1000BASE-LX/LH', form: 'sfp', speed: 1000, nm: 1310, fiber: 'smf', reach: 10000, tx: -6.0, rx: -20.0, vendor: 'Cisco' },
  'SFP-10G-SR': { type: '10GBASE-SR', form: 'sfp', speed: 10000, nm: 850, fiber: 'mmf', reach: 300, tx: -2.4, rx: -11.1, vendor: 'Cisco' },
  'SFP-10G-LR': { type: '10GBASE-LR', form: 'sfp', speed: 10000, nm: 1310, fiber: 'smf', reach: 10000, tx: -1.5, rx: -14.4, vendor: 'Cisco' },
  'SFP-25G-SR-S': { type: '25GBASE-SR', form: 'sfp', speed: 25000, nm: 850, fiber: 'mmf', reach: 100, tx: -2.0, rx: -10.3, vendor: 'Cisco' },
  'QSFP-100G-SR4-S': { type: '100GBASE-SR4', form: 'qsfp', speed: 100000, nm: 850, fiber: 'mmf', reach: 100, tx: -2.0, rx: -10.3, vendor: 'Cisco' },
  'QSFP-100G-LR4-S': { type: '100GBASE-LR4', form: 'qsfp', speed: 100000, nm: 1310, fiber: 'smf', reach: 10000, tx: 0.5, rx: -10.6, vendor: 'Cisco' },
  // 第三方（沒有 Cisco 的編碼）：便宜，規格一樣，但 Cisco 的設備預設不接受
  'SFP-10GSR-85': { type: '10GBASE-SR', form: 'sfp', speed: 10000, nm: 850, fiber: 'mmf', reach: 300, tx: -2.4, rx: -11.1, vendor: 'Generic' },
  'SFP-10GLR-31': { type: '10GBASE-LR', form: 'sfp', speed: 10000, nm: 1310, fiber: 'smf', reach: 10000, tx: -1.5, rx: -14.4, vendor: 'Generic' },
};
const ATTEN = { mmf: 3.0, smf: 0.35 }; // 每公里的衰減 (dB)：多模 850 nm、單模 1310 nm
const CONN = 0.75; // 一路上的接頭（兩端的配線架）
const DIRTY = 7.5; // 髒污或刮傷的接頭：多出來的損耗
export const FIBER = { mmf: '多模光纖 (OM4)', smf: '單模光纖 (OS2)' };

/** 這一種線材、這個速率，預設插哪一顆（Cisco 原廠） */
export function defaultOptic(fiber, form, speed) {
  const list = Object.entries(OPTICS).filter(([, o]) => o.vendor === 'Cisco' && o.fiber === fiber && o.form === form);
  const fit = list.filter(([, o]) => o.speed <= speed).sort((x, y) => y[1].speed - x[1].speed);
  return (fit[0] || list.sort((x, y) => x[1].speed - y[1].speed)[0] || [null])[0];
}

/** 線材兩端的收發器：{ a, b }（料號）；不是光纖就是 null */
export function opticsOf(c, speedA, speedB, media) {
  if (c.kind !== 'mmf' && c.kind !== 'smf') return null;
  const o = c.optics || {};
  const sp = Math.min(speedA, speedB);
  const def = defaultOptic(c.kind, media, sp);
  return { a: o.a || def, b: o.b || def };
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * 光纖這一段：{ down: 原因 } 或 { speed, rx: { a, b }（dBm）, margin: { a, b }, marginal: 'a' | 'b' | null }
 * portA / portB：兩端的埠最高速率；meters：距離
 */
export function opticLink(c, ends, meters) {
  const { a: pa, b: pb } = ends.optics, A = OPTICS[pa], B = OPTICS[pb];
  const nameA = ends.nameA, nameB = ends.nameB;
  for (const [o, pn, port, nm] of [[A, pa, ends.portA, nameA], [B, pb, ends.portB, nameB]]) {
    if (!o) return { down: `${nm} 插的收發器 ${pn} 不認得` };
    if (o.form !== ends.media) return { down: `${nm} 的 ${pn} 是 ${o.form === 'qsfp' ? 'QSFP' : 'SFP'} 的收發器，插不進這個埠` };
    if (o.speed > port) return { down: `${nm} 的 ${pn} 是 ${fmt(o.speed)} 的收發器，這個埠最高只支援 ${fmt(port)}` };
  }
  if (A.nm !== B.nm) return { down: `兩端的收發器波長不同（${pa} 是 ${A.nm} nm、${pb} 是 ${B.nm} nm）：對方發的光收不到` };
  for (const [o, pn, nm] of [[A, pa, nameA], [B, pb, nameB]]) {
    if (o.fiber !== c.kind) return { down: `${nm} 的 ${pn}（${o.type}）要接${FIBER[o.fiber]}，這條是${FIBER[c.kind]}：光幾乎進不去，沒有燈號` };
  }
  if (A.speed !== B.speed) return { down: `兩端的收發器速率不同（${pa} 是 ${fmt(A.speed)}、${pb} 是 ${fmt(B.speed)}）：連線建立不起來` };
  const reach = Math.min(A.reach, B.reach);
  if (meters > reach) return { down: `${A.type} 最長 ${reach >= 1000 ? reach / 1000 + ' 公里' : reach + ' 公尺'}，但這兩台設備相距 ${meters} 公尺` };
  const loss = ATTEN[c.kind] * meters / 1000 + CONN;
  const dirty = c.dirty || {};
  // a 端收到的是 b 端發出來的光
  const rx = { a: r1(B.tx - loss - (dirty.a ? DIRTY : 0) - (dirty.b ? DIRTY * 0.3 : 0)), b: r1(A.tx - loss - (dirty.b ? DIRTY : 0) - (dirty.a ? DIRTY * 0.3 : 0)) };
  const margin = { a: r1(rx.a - A.rx), b: r1(rx.b - B.rx) };
  const los = ['a', 'b'].find((k) => margin[k] < -3);
  if (los) return { down: `${los === 'a' ? nameA : nameB} 收到的光太弱（${rx[los]} dBm，收發器至少要 ${(los === 'a' ? A : B).rx} dBm）：Loss of Signal` };
  const marginal = ['a', 'b'].find((k) => margin[k] < 0) || null;
  return { speed: A.speed, rx, margin, marginal, loss: r1(loss) };
}
const fmt = (m) => (m >= 1000 ? m / 1000 + 'G' : m + 'M');

/** Cisco 的設備插了第三方的收發器，而且沒有 service unsupported-transceiver：會被 err-disable */
export const rejectsOptic = (dev, pn, catalogVendor) => catalogVendor === 'Cisco' && OPTICS[pn] && OPTICS[pn].vendor !== 'Cisco' && !(dev.sw && dev.sw.unsupportedXcvr) && !dev.unsupportedXcvr;

/** IOS 的 media type 字串（show interfaces、show interfaces status 的 Type） */
export const MEDIA_TYPE = { 'GLC-SX-MMD': '1000BaseSX SFP', 'GLC-LH-SMD': '1000BaseLX SFP', 'SFP-10G-SR': 'SFP-10GBase-SR', 'SFP-10G-LR': 'SFP-10GBase-LR', 'SFP-25G-SR-S': 'SFP-25GBase-SR', 'QSFP-100G-SR4-S': 'QSFP 100G SR4', 'QSFP-100G-LR4-S': 'QSFP 100G LR4', 'SFP-10GSR-85': 'SFP-10GBase-SR', 'SFP-10GLR-31': 'SFP-10GBase-LR' };

/** 一個埠上的收發器：{ pn, o, cable, end, link }；沒有插（或不是光纖）回傳 null */
export function xcvrAt(state, d, pid, fiberLink) {
  const c = state.cables.find((x) => (x.a.dev === d.id && x.a.port === pid) || (x.b.dev === d.id && x.b.port === pid));
  const f = c && fiberLink(state, c);
  if (!f) return null;
  const end = c.a.dev === d.id && c.a.port === pid ? 'a' : 'b';
  return { pn: f.optics[end], o: OPTICS[f.optics[end]], cable: c, end, link: f.link };
}
/** 序號（同一個埠每次都一樣） */
export function xcvrSerial(pn, key) {
  let x = 2166136261;
  for (const ch of pn + '|' + key) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  const v = (x >>> 0).toString(36).toUpperCase().padStart(7, '0');
  return (OPTICS[pn] && OPTICS[pn].vendor === 'Cisco' ? 'AVD' : 'FS') + v.slice(0, 8);
}
