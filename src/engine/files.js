// 檔案與韌體：TFTP / FTP 伺服器上的檔案、網路設備的 flash、映像檔、開機時挑哪一個映像檔
//
// 伺服器（主機）：d.files = { 檔名: { size, md5, kind: 'config' | 'image' | 'other', lines?, img?, t } }
//                 d.ftpUsers = [{ user, pass }]；services 裡有 UDP 69 是 TFTP、TCP 21 是 FTP
// 網路設備：     d.flash = { size, files: { 檔名: { size, md5, kind, img?, t } } }   d.fw = { image, ver }
//                 開機用哪一個映像檔：設定裡的 boot system（d.bootSys），沒有就用 flash 裡第一個能用的
import { mgmtSpec } from './mgmtsrc.js';
import { CATALOG } from './model.js';
import { transact, throughput } from './sim.js';
import { fmtIp } from './ip.js';

export const isCiscoOs = (d) => !d.locked && CATALOG[d.model] && CATALOG[d.model].vendor === 'Cisco' && ['router', 'mswitch', 'l3switch'].includes(d.kind);

// ───────────────────────── 映像檔 ─────────────────────────

export const PLATFORM = { c2960: 'c2960cx', c2960p: 'c2960cx', isr4321: 'isr4300', isr4331: 'isr4300', c9300: 'cat9k', n93180: 'n9k', n9332: 'n9k', fg60f: 'FGT_60F', fg100f: 'FGT_100F' };
export const PLATFORM_NAME = { c2960cx: 'Catalyst 2960-CX', isr4300: 'ISR 4300', isr4400: 'ISR 4400', cat9k: 'Catalyst 9300', n9k: 'Nexus 9000', FGT_60F: 'FortiGate 60F', FGT_100F: 'FortiGate 100F' };

function hex(s, n) {
  let out = '', h = 2166136261;
  for (let k = 0; out.length < n; k++) {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ k, 2246822519) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, n);
}
/** 檔案的 MD5（模擬：由內容推導，同樣的內容永遠得到同樣的值） */
export const md5Of = (content) => hex(String(content), 32);

/** 原廠的映像檔。md5 是原廠公布的值，下載回來的檔案要和它一樣才是完整的 */
export const IMAGES = Object.fromEntries([
  ['c2960c405ex-universalk9-mz.152-7.E8.bin', 'c2960cx', '15.2(7)E8', 26117632],
  ['c2960c405ex-universalk9-mz.152-7.E10.bin', 'c2960cx', '15.2(7)E10', 26183168],
  ['isr4300-universalk9.16.12.04.SPA.bin', 'isr4300', '16.12.4', 594305024],
  ['isr4300-universalk9.17.03.04a.SPA.bin', 'isr4300', '17.3.4a', 648017920],
  ['isr4300-universalk9.17.06.05.SPA.bin', 'isr4300', '17.6.5', 689143808],
  ['isr4300-universalk9.17.09.05a.SPA.bin', 'isr4300', '17.9.5a', 722546688],
  ['isr4400-universalk9.17.09.05a.SPA.bin', 'isr4400', '17.9.5a', 740818944],
  ['cat9k_iosxe.17.09.05.SPA.bin', 'cat9k', '17.9.5', 1184620544],
  ['nxos64-cs.10.3.4a.M.bin', 'n9k', '10.3(4a)', 2026438656],
  ['FGT_60F-v7.0.15.M-build0632-FORTINET.out', 'FGT_60F', '7.0.15', 73400320],
  ['FGT_60F-v7.2.10.M-build1706-FORTINET.out', 'FGT_60F', '7.2.10', 83886080],
  ['FGT_60F-v7.4.7.F-build2731-FORTINET.out', 'FGT_60F', '7.4.7', 92274688],
  ['FGT_100F-v7.0.15.M-build0632-FORTINET.out', 'FGT_100F', '7.0.15', 98566144],
  ['FGT_100F-v7.2.10.M-build1706-FORTINET.out', 'FGT_100F', '7.2.10', 109051904],
  ['FGT_100F-v7.4.7.F-build2731-FORTINET.out', 'FGT_100F', '7.4.7', 117440512],
].map(([name, platform, ver, size]) => [name, { platform, ver, size, md5: md5Of('image:' + name) }]));

/** 出廠時裝的版本 */
const FACTORY = {
  c2960cx: 'c2960c405ex-universalk9-mz.152-7.E10.bin', isr4300: 'isr4300-universalk9.17.09.05a.SPA.bin', cat9k: 'cat9k_iosxe.17.09.05.SPA.bin',
  n9k: 'nxos64-cs.10.3.4a.M.bin', FGT_60F: 'FGT_60F-v7.4.7.F-build2731-FORTINET.out', FGT_100F: 'FGT_100F-v7.4.7.F-build2731-FORTINET.out',
};
/** flash 的容量（位元組，格式化之後可以用的空間） */
const FLASH_SIZE = { c2960cx: 122185728, isr4300: 3_281_510_400, cat9k: 11_353_194_496, n9k: 53_660_876_800 };
/** IOS-XE 與 NX-OS 的檔案系統叫 bootflash:，傳統 IOS 叫 flash: */
export const fsName = (d) => (['isr4300', 'cat9k', 'n9k'].includes(PLATFORM[d.model]) ? 'bootflash' : 'flash');

/** 第一次用到時，替設備裝上出廠的韌體與 flash（舊的存檔也一樣） */
export function ensureFlash(d) {
  const p = PLATFORM[d.model];
  if (!p || d.locked) return;
  if (!d.fw) { const img = FACTORY[p]; d.fw = { image: img, ver: IMAGES[img].ver }; }
  if (d.kind === 'firewall' || d.flash) return;
  const files = { [d.fw.image]: imageFile(d.fw.image, -1) };
  if (d.sw && d.sw.mode === 'vlan') files['vlan.dat'] = { size: 676, md5: md5Of('vlan.dat/' + d.id), kind: 'other', t: -1 };
  if (p === 'isr4300' || p === 'cat9k') Object.assign(files, { 'tracelogs/': { size: 0, kind: 'dir', md5: '', t: -1 }, 'packages.conf': { size: 7354, md5: md5Of('pk' + d.id), kind: 'other', t: -1 } });
  d.flash = { size: FLASH_SIZE[p], files };
}
export const imageFile = (name, t) => ({ size: IMAGES[name].size, md5: IMAGES[name].md5, kind: 'image', img: name, t });
export const flashUsed = (d) => Object.values((d.flash && d.flash.files) || {}).reduce((a, f) => a + (f.size || 0), 0);
export const flashFree = (d) => (d.flash ? d.flash.size - flashUsed(d) : 0);
/** flash:x、bootflash:x、flash:/x → x */
export const flashPath = (s) => String(s || '').replace(/^(boot)?flash:\/?/i, '');

/**
 * 開機時要用哪一個映像檔。依序試 boot system 指定的檔案，都不行就用 flash 裡第一個能開機的映像檔。
 * 回傳 { image, notes: [開機過程的訊息] }，或 { rommon: 原因, notes }
 */
export function bootPick(d) {
  ensureFlash(d);
  const p = PLATFORM[d.model], fs = fsName(d), notes = [];
  const usable = (name) => {
    const f = d.flash.files[name];
    if (!f) return `${fs}:${name} 不存在`;
    if (f.kind !== 'image' || !f.img) return `${fs}:${name} 不是可以開機的映像檔`;
    const img = IMAGES[f.img];
    if (img.platform !== p) return `${fs}:${name} 是給 ${PLATFORM_NAME[img.platform]} 的映像檔，這台是 ${PLATFORM_NAME[p]}`;
    if (f.md5 !== img.md5 || f.size !== img.size) return `${fs}:${name} 已經損毀（大小或 MD5 不對）`;
    return null;
  };
  for (const b of d.bootSys || []) {
    const name = flashPath(b);
    const why = usable(name);
    if (!why) return { image: name, notes };
    notes.push(`Boot of ${fs}:${name} failed: ${why}`);
  }
  const first = Object.keys(d.flash.files).find((n) => !usable(n));
  if (first) {
    if ((d.bootSys || []).length) notes.push(`所有 boot system 指定的檔案都不能用，改用 ${fs} 裡第一個能開機的映像檔：${first}`);
    return { image: first, notes };
  }
  return { rommon: `${fs} 裡沒有任何可以開機的映像檔`, notes };
}

// ───────────────────────── 伺服器 ─────────────────────────

export const isTftp = (d) => (d.services || []).some((s) => s.proto === 'udp' && s.port === 69);
export const isFtp = (d) => (d.services || []).some((s) => s.proto === 'tcp' && s.port === 21);
/** SCP / SFTP：跑 SSH（TCP 22）的伺服器，帳號和 FTP 共用 ftpUsers */
export const isScp = (d) => (d.kind === 'host' || d.kind === 'server') && !!d.files && (d.services || []).some((s) => s.proto === 'tcp' && s.port === 22);
export const configFile = (lines, t) => ({ size: lines.join('\n').length + 1, md5: md5Of(lines.join('\n')), kind: 'config', lines: lines.slice(), t });

/** 設備自己的檔案寫入速度（位元組 / 秒）：小交換器的 flash 寫得很慢 */
const WRITE = { c2960cx: 2_200_000, isr4300: 28_000_000, cat9k: 45_000_000, n9k: 60_000_000, FGT_60F: 18_000_000, FGT_100F: 25_000_000 };

/**
 * 和 TFTP / FTP 伺服器之間傳一個檔案。
 * o: { proto: 'tftp' | 'ftp', server（IP 數值）, file, dir: 'get' | 'put', bytes（put 的大小）, user, pass, blksize, put（要寫入的檔案物件） }
 * 回傳 { ok, err（IOS 風格的錯誤原因）, reason（說明）, res（給動畫用）, secs, bytes, file（get 到的檔案）, srv（伺服器設備） }
 */
export function transfer(state, devId, o) {
  const d = state.devices[devId];
  const tftp = o.proto === 'tftp', scp = o.proto === 'scp';
  // SCP 走 SSH（TCP 22）：帳號、密碼與檔案內容都加密了，擷取只看得到 Encrypted packet
  const data = tftp ? { kind: 'tftp', op: o.dir === 'get' ? 'RRQ' : 'WRQ', file: o.file } : scp ? { kind: 'out' } : { kind: 'ftp', user: o.user || 'anonymous', pass: o.pass || '', cmd: `${o.dir === 'get' ? 'RETR' : 'STOR'} ${o.file}` };
  // ip tftp | ftp source-interface：從那個介面（和它的 VRF，例如帶外管理埠的 Mgmt-vrf）送出去
  const res = transact(state, devId, { proto: tftp ? 'udp' : 'tcp', dst: o.server, dport: tftp ? 69 : scp ? 22 : 21, data, ...mgmtSpec(d, tftp ? 'tftp' : scp ? 'scp' : 'ftp') });
  const fail = (err, reason) => ({ ok: false, err, reason, res, secs: tftp ? 30 : 0 });
  if (!res.ok) return fail(tftp ? 'Timed out' : /拒絕/.test(res.reason) ? 'Connection refused' : 'Timed out', res.reason);
  const srv = state.devices[res.responder];
  if (scp && !srv.files) return fail('Connection refused', `${srv.name} 有 SSH，但不是放檔案的伺服器（沒有開 SCP / SFTP 伺服器的角色）`);
  if (scp && !(srv.ftpUsers || []).some((u) => u.user === o.user && u.pass === o.pass)) return fail('Permission denied', `${srv.name} 的 SSH 帳號或密碼錯誤（scp://帳號@伺服器/檔名；密碼會另外問）`);
  if (!tftp && !scp) {
    const users = srv.ftpUsers || [];
    if (!users.some((u) => u.user === o.user && u.pass === o.pass)) return fail('Not logged in', `${srv.name} 的 FTP 帳號或密碼錯誤${o.user ? '' : '（還沒有設定 FTP 帳號：ip ftp username / ip ftp password，或寫在網址裡 ftp://帳號:密碼@伺服器/檔名）'}`);
  }
  const files = (srv.files ||= {});
  let file = null, bytes = o.bytes || 0;
  if (o.dir === 'get') {
    file = files[o.file];
    if (!file) return fail('No such file or directory', `${srv.name} 上沒有 ${o.file} 這個檔案（有：${Object.keys(files).join('、') || '沒有任何檔案'}）`);
    bytes = file.size;
  }
  // 傳輸要多久：TFTP 一次只送一個區塊（預設 512 位元組），等對方確認才送下一個，所以很慢；FTP 走 TCP，跑得到線路的速度
  const m = throughput(state, res.hops);
  const l3 = res.l3.length;
  const p = PLATFORM[d.model];
  if (tftp && m.loss >= 30) return { ...fail('Timed out', `線路上大量掉封包（${m.where}），TFTP 等不到確認，傳到一半就逾時了`), secs: 45 };
  const line = Math.max(0.05, m.mbps) * 1e6 / 8;
  const rtt = 0.0011 + 0.0006 * l3 + (res.l3.some((x) => state.devices[x.dev].kind === 'internet') ? 0.02 : 0);
  const rate = tftp ? Math.min(line, (o.blksize || 512) / rtt) : Math.min(line * 0.92, WRITE[p] || 50_000_000);
  const secs = Math.max(0.1, bytes / rate);
  if (o.dir === 'put') files[o.file] = { ...o.put, t: state.clock };
  return { ok: true, res, secs, bytes, rate: Math.round(bytes / secs), file, srv, where: m.where };
}

/** 檔案大小的寫法 */
export const fmtBytes = (n) => (n >= 1e9 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
export const serverLabel = (srv, ip) => `${srv ? srv.name : ''}（${fmtIp(ip)}）`;
