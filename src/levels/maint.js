// 第十一章：維運與管理。網路架好之後的日常工作：備份與還原、韌體升級、安全的遠端管理、用 SNMP 監控流量
import { makeDevice as D, makeState, setLine, newIface, removeCable } from '../engine/model.js';
import { recompute, linkUtil } from '../engine/sim.js';
import { iosSession, runningConfig, saveStartup, iosDirty } from '../engine/ios.js';
import { configFile, imageFile, IMAGES, md5Of, flashPath, bootPick } from '../engine/files.js';
import { genKey } from '../engine/remote.js';
import { markReboot } from '../engine/ops.js';
import { pollOne } from '../engine/snmp.js';
import { dev, link } from './util.js';

export const CHAPTERS5 = [
  { id: 11, title: '維運與管理', desc: '網路架好之後的日常：設定備份與還原、韌體升級、安全的遠端管理、用 SNMP 監控流量找出瓶頸。' },
];

/** 關卡一開始的狀態要當作「剛載入」：拿掉產生檔案時暫時算出來的執行期狀態 */
function fresh(s) {
  delete s.dyn; delete s.rt; s.clock = 0;
  for (const d of Object.values(s.devices)) delete d.rt;
  return s;
}
/** 前任管理員已經設好的遠端管理（和其他章節的關卡一樣） */
const managed = (d) => Object.assign(d.mgmt, { sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local', snmp: 'v2c', community: 'public' });
const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
const mgmtIp = (d, vlan, ip, gw = '') => { const i = d.ifaces.find((x) => x.id === 'mgmt'); i.bind.vlan = vlan; Object.assign(i, { ip, mask: '255.255.255.0', gateway: gw }); };
/** 在 CLI 上依序輸入幾行（解題用） */
const typeIn = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); for (const l of lines) sess.exec(l); };

const NEW_IMG = 'isr4300-universalk9.17.09.05a.SPA.bin', OLD_IMG = 'isr4300-universalk9.17.06.05.SPA.bin';
const OLDER = ['isr4300-universalk9.17.03.04a.SPA.bin', 'isr4300-universalk9.16.12.04.SPA.bin'];
const WRONG_IMG = 'isr4400-universalk9.17.09.05a.SPA.bin';
const CORE = 'core/isr4300_RP_0_iosd_10251_20251022-081132-UTC.core.gz';
const SNMP_USER = { user: 'nms', auth: 'Mon!tor-Auth26', priv: 'Mon!tor-Priv26' };

export const LEVELS5 = [
  // ─────────────────────────────────────────────── 11-1
  {
    id: 'l40', chapter: 11, title: '還好有備份', subtitle: '用 TFTP 備份與還原設定', tags: ['TFTP', '設定備份', 'copy', 'write memory'],
    brief: '上週五有人改了核心交換器 SW-Core，還順手 write memory 存了檔：業務部的 VLAN 20 不見了、業務部的印表機那個埠也被關掉。幸好備份伺服器上有上週的備份。請把交換器救回來，並照公司規定把路由器 R1 目前的設定也備份上去。',
    given: [
      ['備份伺服器', '10.0.99.30（TFTP，UDP 69）'], ['交換器的備份', 'sw-core-confg（上週的版本）'], ['路由器備份的檔名', 'r1-confg'],
      ['網段', '研發 VLAN 10 · 業務 VLAN 20 · 管理 VLAN 99（10.0.99.0/24）'],
    ],
    learn: [
      { t: '設定檔要有備份', d: '設備壞掉、被改壞或要換新的時候，有一份最近的設定檔就能在幾分鐘內恢復。常見的做法是用 TFTP 或 FTP 把 running-config 複製到伺服器上：copy running-config tftp:。' },
      { t: '合併還是取代', d: 'copy tftp: running-config 等於把檔案裡的每一行貼進設定模式：檔案裡有的會套用，但檔案裡「沒寫到」的設定不會被拿掉（例如多出來的 shutdown）。要整份換掉，就複製到 startup-config 再 reload。' },
      { t: 'TFTP 的特性', d: 'TFTP 用 UDP 69，不需要帳號密碼，也不加密，所以只適合放在受保護的管理網段裡。' },
      { t: '別忘了存檔', d: '還原到 running-config 之後還要 write memory，不然下次重新開機又會回到壞掉的樣子。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'rt', { name: 'R1', pos: [0, -6.5], init(d) { sub(d, 'Gi0/0/1', 10, '10.0.10.1'); sub(d, 'Gi0/0/1', 20, '10.0.20.1'); sub(d, 'Gi0/0/1', 99, '10.0.99.1'); } }),
        D('c2960', 'sw', {
          name: 'SW-Core', pos: [0, -1.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'RD' }, { id: 20, name: 'Sales' }, { id: 99, name: 'MGMT' });
            d.sw.ports['Gi0/1'].vlan = 10; d.sw.ports['Gi0/2'].vlan = 20; d.sw.ports['Gi0/3'].vlan = 99; d.sw.ports['Gi0/4'].vlan = 20;
            d.sw.ports['Gi0/9'].mode = 'trunk';
            d.sw.stp.portfastDefault = true;
            mgmtIp(d, 99, '10.0.99.2', '10.0.99.1');
          },
        }),
        D('pc', 'pc-a', { name: '研發 PC', pos: [-9, 4], ip: '10.0.10.10', gw: '10.0.10.1' }),
        D('pc', 'pc-b', { name: '業務 PC', pos: [-3.5, 5], ip: '10.0.20.10', gw: '10.0.20.1' }),
        D('printer', 'prn', { name: '業務部印表機', pos: [3.5, 5], ip: '10.0.20.50', gw: '10.0.20.1' }),
        D('tower', 'bak', { name: '備份伺服器', pos: [9, 3.5], ip: '10.0.99.30', gw: '10.0.99.1', services: [{ proto: 'udp', port: 69, name: 'TFTP' }] }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['pc-a:eth0', 'sw:Gi0/1'], ['pc-b:eth0', 'sw:Gi0/2'], ['bak:eth0', 'sw:Gi0/3'], ['prn:eth0', 'sw:Gi0/4']]);
      managed(s.devices.rt); managed(s.devices.sw);
      recompute(s);
      // 上週的備份：交換器還是好的時候的設定
      s.devices.bak.files = { 'sw-core-confg': configFile(runningConfig(s, s.devices.sw), -3 * 86400) };
      // 上週五被改壞，而且存了檔
      const sw = s.devices.sw;
      sw.sw.vlans = sw.sw.vlans.filter((v) => v.id !== 20);
      sw.sw.ports['Gi0/4'].shut = true;
      saveStartup(sw); saveStartup(s.devices.rt);
      return fresh(s);
    },
    objectives: [
      { type: 'ping', from: 'pc-b', ip: '10.0.20.1', label: '業務部的電腦連得到閘道（VLAN 20 回來了）' },
      { type: 'tcp', from: 'pc-b', to: 'prn', port: 9100, label: '業務部可以列印（印表機 TCP 9100）' },
      {
        type: 'check', label: 'SW-Core 已經存檔：重新開機也不會再壞掉',
        test: (s) => (iosDirty(s, dev(s, 'sw')) ? 'SW-Core 的 running-config 還沒有存成 startup-config（write memory）：重新開機就會回到壞掉的樣子' : true),
      },
      {
        type: 'check', label: '路由器 R1 目前的設定已經備份到伺服器（r1-confg）',
        test(s) {
          const f = (dev(s, 'bak').files || {})['r1-confg'];
          if (!f) return '備份伺服器上還沒有 r1-confg（在 R1 上 copy running-config tftp:）';
          if (f.kind !== 'config') return 'r1-confg 不是設定檔';
          return f.lines.join('\n') === runningConfig(s, dev(s, 'rt')).join('\n') ? true : 'r1-confg 和 R1 現在的設定不一樣：備份之後又改過設定，要再備份一次';
        },
      },
    ],
    hints: [
      '在 SW-Core 的 CLI 輸入 copy tftp: running-config，伺服器 10.0.99.30，檔名 sw-core-confg。',
      '合併不會拿掉檔案裡沒寫到的設定：Gi0/4 的 shutdown 還在，要自己 no shutdown（或改用 copy tftp: startup-config 再 reload，整份換掉）。最後 write memory。',
      '在 R1 輸入 copy running-config tftp://10.0.99.30/r1-confg。',
    ],
    solve(s) {
      recompute(s);
      typeIn(s, 'sw', ['copy tftp://10.0.99.30/sw-core-confg running-config', '', 'configure terminal', 'interface gi0/4', 'no shutdown', 'end', 'write memory']);
      recompute(s);
      typeIn(s, 'rt', ['copy running-config tftp://10.0.99.30/r1-confg', '']);
    },
    recap: ['copy … running-config 是合併；要整份取代就複製到 startup-config 再重新開機。', '設定改好之後要 write memory，並把最新的設定備份出去。'],
  },

  // ─────────────────────────────────────────────── 11-2
  {
    id: 'l41', chapter: 11, title: '韌體升級', subtitle: '空間、校驗碼與開機順序', tags: ['韌體升級', 'FTP', 'MD5', 'boot system'],
    brief: `資安公告：分公司路由器 R2 跑的 IOS XE 17.6.5 有高風險漏洞，要升級到 17.9.5a。新的映像檔已經放在檔案伺服器上。注意：R2 的 bootflash 快滿了，而且升級完要確定它下次開機也會用新版本。`,
    given: [
      ['目標版本', `IOS XE 17.9.5a（${NEW_IMG}）`], ['原廠公布的 MD5', IMAGES[NEW_IMG].md5],
      ['檔案伺服器', '10.0.99.30：TFTP，以及 FTP（帳號 netadmin / 密碼 Fw#Upgrade2026）'], ['R2 管理位址', '10.0.99.1'],
    ],
    learn: [
      { t: '升級前先看空間', d: 'dir bootflash: 看看還剩多少空間。不夠就刪掉用不到的舊映像檔或舊的 core dump，但不要刪掉現在正在跑的那一個：萬一新版本開不起來，它是退路。' },
      { t: 'TFTP 很慢', d: 'TFTP 一次只送 512 位元組，每一塊都要等對方確認，幾百 MB 的映像檔要傳半個小時。FTP 走 TCP，跑得到線路的速度。' },
      { t: '一定要驗證 MD5', d: '下載回來的檔案要和原廠公布的 MD5 一樣才是完整、沒被竄改的。verify /md5 bootflash:<檔名> 會算出它的值。' },
      { t: '開機用哪一個映像檔', d: 'boot system 決定開機順序，要 write memory 才會保留下來。指定的檔案不能用，設備會試下一個；全部都不行就停在 ROMMON。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -11] }), 'line1', { type: 'static', gw: '203.0.113.1', mask: '255.255.255.252', assign: '203.0.113.2' }),
        D('isr4321', 'rt', {
          name: 'R2', pos: [0, -5.5],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.2', mask: '255.255.255.252', gateway: '203.0.113.1', nat: true });
            Object.assign(d.ifaces[1], { ip: '10.0.99.1', mask: '255.255.255.0' });
            d.fw = { image: OLD_IMG, ver: IMAGES[OLD_IMG].ver };
            d.flash = {
              size: 3281510400,
              files: {
                [OLD_IMG]: imageFile(OLD_IMG, -1), [OLDER[0]]: imageFile(OLDER[0], -1), [OLDER[1]]: imageFile(OLDER[1], -1),
                [CORE]: { size: 812646400, md5: md5Of(CORE), kind: 'other', t: -1 }, 'tracelogs/': { size: 0, md5: '', kind: 'dir', t: -1 },
                'packages.conf': { size: 7354, md5: md5Of('pk-r2'), kind: 'other', t: -1 },
              },
            };
            d.bootSys = ['bootflash:' + OLD_IMG];
          },
        }),
        D('sw8', 'sw', { name: 'Switch', pos: [0, -0.5] }),
        D('pc', 'adm', { name: '管理員 PC', pos: [-7, 4], ip: '10.0.99.10', gw: '10.0.99.1', dns: '8.8.8.8' }),
        D('pc', 'usr', { name: '辦公室 PC', pos: [0, 5], ip: '10.0.99.50', gw: '10.0.99.1', dns: '8.8.8.8' }),
        D('tower', 'srv', {
          name: '檔案伺服器', pos: [7, 4], ip: '10.0.99.30', gw: '10.0.99.1', services: [{ proto: 'udp', port: 69, name: 'TFTP' }, { proto: 'tcp', port: 21, name: 'FTP' }],
          init(d) {
            d.files = { [NEW_IMG]: imageFile(NEW_IMG, -1), [WRONG_IMG]: imageFile(WRONG_IMG, -1) };
            d.ftpUsers = [{ user: 'netadmin', pass: 'Fw#Upgrade2026' }];
          },
        }),
      ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ['adm:eth0', 'sw:2'], ['usr:eth0', 'sw:3'], ['srv:eth0', 'sw:4']]);
      managed(s.devices.rt);
      saveStartup(s.devices.rt);
      return s;
    },
    objectives: [
      {
        type: 'check', label: 'R2 現在跑的是 17.9.5a',
        test(s) {
          const d = dev(s, 'rt');
          if ((s.rt.rommon || {}).rt) return `R2 沒有開機成功，停在 ROMMON：${s.rt.rommon.rt}`;
          if ((s.rt.booting || {}).rt > 0) return 'R2 還在開機中';
          return d.fw && d.fw.ver === '17.9.5a' ? true : `R2 現在跑的是 ${d.fw ? d.fw.ver : '?'}（用 show version 看）：要從新的映像檔重新開機`;
        },
      },
      {
        type: 'check', label: '下次開機也會用 17.9.5a（boot system 已經存檔）',
        test(s) {
          const d = dev(s, 'rt');
          const saved = d.startup ? JSON.parse(d.startup).bootSys || [] : d.bootSys || [];
          const pick = bootPick({ ...d, bootSys: saved });
          if (pick.rommon) return `照 startup-config 的開機順序會停在 ROMMON：${pick.rommon}`;
          const f = d.flash.files[pick.image];
          return f && IMAGES[f.img] && IMAGES[f.img].ver === '17.9.5a' ? true : `照 startup-config 裡的 boot system，下次開機會用 ${pick.image}`;
        },
      },
      { type: 'ping', from: 'usr', ip: '8.8.8.8', label: '升級之後，辦公室照樣上得了網' },
    ],
    hints: [
      `在 R2 輸入 dir bootflash:：新的映像檔要 ${Math.round(IMAGES[NEW_IMG].size / 1048576)} MB，空間不夠。用 delete bootflash:<舊映像檔> 刪掉用不到的舊版本（不要刪正在跑的 17.06.05）。`,
      `FTP 比 TFTP 快很多：copy ftp://netadmin:Fw#Upgrade2026@10.0.99.30/${NEW_IMG} bootflash:。下載完用 verify /md5 對照原廠的值。伺服器上另一個檔案是給 ISR 4400 的，不要拿錯。`,
      `configure terminal → no boot system → boot system bootflash:${NEW_IMG} → end → write memory → reload。大約三分鐘後用 show version 確認。`,
    ],
    solve(s) {
      recompute(s);
      const d = dev(s, 'rt');
      delete d.flash.files[OLDER[0]];
      d.flash.files[NEW_IMG] = imageFile(NEW_IMG, s.clock);
      d.bootSys = ['bootflash:' + NEW_IMG];
      saveStartup(d);
      markReboot(s, 'rt');
    },
    recap: ['升級前：看空間、保留目前的版本、驗證 MD5。', 'boot system 指向新的映像檔並 write memory，重新開機之後用 show version 確認。'],
  },

  // ─────────────────────────────────────────────── 11-3
  {
    id: 'l42', chapter: 11, title: '讓 SSH 能用', subtitle: '金鑰、帳號與 vty', tags: ['SSH', 'RSA 金鑰', 'login local', 'ip default-gateway'],
    brief: '新到貨的交換器剛上架，只做了 VLAN 與管理 IP。主管規定：只能用 SSH（第 2 版）管理，帳號 netadmin、密碼 Sw!tch-Admin-2026，Telnet 一律關閉。管理員的電腦在另一個網段。',
    given: [
      ['交換器管理 IP', '10.0.98.2 / 24（VLAN 98），閘道 10.0.98.1'], ['管理員 PC', '10.0.99.10（另一個網段）'],
      ['帳號', 'netadmin / Sw!tch-Admin-2026'], ['命名規則', '主機名稱 SW-Floor3，網域 corp.local'],
    ],
    learn: [
      { t: 'SSH 需要金鑰', d: '原廠的 Cisco 設備沒有 RSA 金鑰，所以 SSH 連不進去。產生金鑰之前要先有主機名稱（不能是原廠的 Switch）與網域名稱，因為金鑰的名字就是「主機名稱.網域名稱」：crypto key generate rsa modulus 2048。' },
      { t: 'line vty 的登入方式', d: 'login 只問線路密碼，login local 才會用 username 建立的帳號。SSH 一定要有帳號，所以要 login local；transport input ssh 則把 Telnet 關掉。' },
      { t: 'L2 交換器也要閘道', d: '交換器的管理介面只是一台「主機」。從別的網段連進來時，它要用 ip default-gateway 才知道回應要交給誰。' },
    ],
    setup() {
      return makeState([
        D('isr4321', 'rt', { name: 'R1', pos: [0, -6], init(d) { sub(d, 'Gi0/0/1', 98, '10.0.98.1'); sub(d, 'Gi0/0/1', 99, '10.0.99.1'); } }),
        D('c2960', 'sw', {
          name: 'Switch', pos: [0, -1.5],
          init(d) {
            d.sw.vlans.push({ id: 98, name: 'SW-MGMT' }, { id: 99, name: 'IT' });
            d.sw.ports['Gi0/1'].vlan = 99; d.sw.ports['Gi0/9'].mode = 'trunk';
            mgmtIp(d, 98, '10.0.98.2');
            // 原廠的樣子：沒有金鑰、沒有網域名稱、line vty 只有 login（沒設密碼）、SNMP 沒開
            Object.assign(d.mgmt, { sshKey: null, vtyLogin: 'line', snmp: 'off' });
          },
        }),
        D('pc', 'adm', { name: '管理員 PC', pos: [-6, 4], ip: '10.0.99.10', gw: '10.0.99.1' }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['adm:eth0', 'sw:Gi0/1']]);
    },
    objectives: [
      { type: 'login', from: 'adm', ip: '10.0.98.2', proto: 'ssh', user: 'netadmin', pass: 'Sw!tch-Admin-2026', label: '管理員可以用 SSH 登入交換器（netadmin）' },
      { type: 'tcp', from: 'adm', ip: '10.0.98.2', port: 23, expect: false, label: 'Telnet 連不進去' },
      {
        type: 'check', label: '主機名稱 SW-Floor3、只用 SSH 第 2 版、金鑰至少 2048 位元',
        test(s) {
          const d = dev(s, 'sw'), m = d.mgmt;
          if (d.name !== 'SW-Floor3') return `主機名稱是 ${d.name}，規定是 SW-Floor3`;
          if (!m.sshKey) return '還沒有 RSA 金鑰';
          if (m.sshKey.bits < 2048) return `RSA 金鑰只有 ${m.sshKey.bits} 位元，規定至少 2048`;
          return m.sshVer === 2 ? true : '還要 ip ssh version 2（不接受舊的 SSH 1）';
        },
      },
    ],
    hints: [
      'hostname SW-Floor3、ip domain name corp.local，然後 crypto key generate rsa modulus 2048、ip ssh version 2。',
      'username netadmin privilege 15 secret Sw!tch-Admin-2026；line vty 0 4 底下 login local、transport input ssh。',
      '管理員在 10.0.99.0/24，交換器在 10.0.98.0/24：交換器要 ip default-gateway 10.0.98.1，回應才回得去。',
    ],
    solve(s) {
      recompute(s);
      const d = dev(s, 'sw'), m = d.mgmt;
      d.name = 'SW-Floor3';
      m.domain = 'corp.local';
      genKey(s, d, 2048);
      Object.assign(m, { sshVer: 2, user: 'netadmin', pass: 'Sw!tch-Admin-2026', vtyLogin: 'local', telnet: false, ssh: true });
      d.ifaces.find((x) => x.id === 'mgmt').gateway = '10.0.98.1';
    },
    recap: ['SSH 的必要條件：主機名稱、網域名稱、RSA 金鑰、本機帳號（login local）。', 'L2 交換器要 ip default-gateway，才能從別的網段管理。'],
  },

  // ─────────────────────────────────────────────── 11-4
  {
    id: 'l43', chapter: 11, title: '網路怎麼變慢了', subtitle: '用 SNMP 找出滿載的線路', tags: ['SNMPv3', '網管 (NMS)', '使用率', '線材'],
    brief: '設計部每天都在抱怨存檔很慢。網管伺服器已經架好了，但還沒有監控任何設備。請照公司規定用 SNMPv3 把三台交換器加進監控，從各條線路的使用率找出瓶頸並排除，讓設計部到檔案伺服器的速度至少有 250 Mbps。',
    given: [
      ['網段', '10.0.50.0/24'], ['交換器管理 IP', 'SW-Core 10.0.50.2 · SW-Design 10.0.50.3 · SW-Office 10.0.50.4'],
      ['網管伺服器', '10.0.50.30'], ['SNMPv3（auth + priv）', `使用者 ${SNMP_USER.user} · 認證密碼 ${SNMP_USER.auth}（SHA）· 加密密碼 ${SNMP_USER.priv}（AES）`],
      ['一直在跑的流量', '設計部的 CAD 檔同步（約 300 Mbps）、NAS 每小時的備份（約 500 Mbps）'],
    ],
    learn: [
      { t: 'SNMP 怎麼監控', d: '網管伺服器 (NMS) 定時向設備的 SNMP 代理查詢介面的計數器（收送了多少位元組）。兩次查詢的差 × 8 ÷ 時間 ÷ 線路速率，就是這段時間的使用率。' },
      { t: 'v2c 與 v3', d: 'v2c 用 community 字串當密碼，而且是明文；v3 有帳號、認證 (SHA) 與加密 (AES)，查詢的內容別人看不到。' },
      { t: '自動降速', d: 'Gigabit 乙太網路要四對線都正常。網路線有線對斷了，兩端會自動降到 100 Mbps（只用兩對線），而且燈還是亮的，很容易被忽略。' },
      { t: '頻寬是共用的', d: '同一條線上的連線會平分頻寬。背景的大流量（備份、同步）會讓其他人的連線變慢。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'core', { name: 'SW-Core', pos: [0, -4], init(d) { mgmtIp(d, 1, '10.0.50.2'); } }),
        D('c2960', 'dsg', { name: 'SW-Design', pos: [-8, 1], init(d) { mgmtIp(d, 1, '10.0.50.3'); } }),
        D('c2960', 'ofc', { name: 'SW-Office', pos: [8, 1], init(d) { mgmtIp(d, 1, '10.0.50.4'); } }),
        D('tower', 'files', { name: '檔案伺服器', pos: [-4.5, -9], ip: '10.0.50.20', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
        D('tower', 'nms', { name: '網管伺服器', pos: [4.5, -9], ip: '10.0.50.30', services: [{ proto: 'udp', port: 162, name: 'SNMP Trap' }], init(d) { d.nms = { targets: [] }; } }),
        D('pc', 'dpc', { name: '設計部 PC', pos: [-10, 6], ip: '10.0.50.101' }),
        D('pc', 'opc', { name: '業務 PC', pos: [5, 6], ip: '10.0.50.102' }),
        D('nas', 'nas', { name: 'NAS（備份）', pos: [11, 6], ip: '10.0.50.40', services: [{ proto: 'tcp', port: 445, name: 'SMB 檔案分享' }] }),
      ], [['core:Gi0/1', 'files:eth0'], ['core:Gi0/2', 'nms:eth0'], ['core:Gi0/9', 'dsg:Gi0/9'], ['core:Gi0/10', 'ofc:Gi0/9'],
        ['dpc:eth0', 'dsg:Gi0/1'], ['opc:eth0', 'ofc:Gi0/1'], ['nas:eth0', 'ofc:Gi0/2']]);
      for (const id of ['core', 'dsg', 'ofc']) { managed(s.devices[id]); s.devices[id].mgmt.snmp = 'off'; delete s.devices[id].mgmt.community; }
      // 設計部的上行線：接頭裡有一對線斷了
      s.cables.find((c) => [c.a.dev, c.b.dev].sort().join() === 'core,dsg').damaged = true;
      s.flows = [
        { id: 'cad', from: 'dpc', ip: '10.0.50.20', port: 445, mbps: 300, label: 'CAD 檔案同步', on: true },
        { id: 'bak', from: 'nas', ip: '10.0.50.20', port: 445, mbps: 500, label: 'NAS 每小時備份', on: true },
      ];
      return s;
    },
    objectives: [
      {
        type: 'check', label: '網管伺服器用 SNMPv3 查得到三台交換器',
        test(s) {
          const nms = dev(s, 'nms');
          for (const ip of ['10.0.50.2', '10.0.50.3', '10.0.50.4']) {
            const t = (nms.nms.targets || []).find((x) => x.ip === ip);
            if (!t) return `網管伺服器還沒有監控 ${ip}`;
            if (t.ver !== 'v3') return `${ip} 用的是 ${t.ver}：公司規定要用 SNMPv3`;
            const r = pollOne(s, nms, t);
            if (!r.ok) return `查詢 ${ip} 失敗：${r.why}`;
          }
          return true;
        },
      },
      {
        type: 'check', label: '找出並排除瓶頸：設計部的上行線路不再滿載（使用率低於 80%）',
        test(s) {
          const u = linkUtil(s, 'dsg', 'Gi0/9');
          if (!u) return 'SW-Design 的上行線路沒有連線';
          return u.util < 80 ? true : `SW-Design ↔ SW-Core 的使用率 ${Math.round(u.util)}%（${u.note}）`;
        },
      },
      { type: 'speed', from: 'dpc', to: 'files', min: 250, label: '設計部 PC 到檔案伺服器至少 250 Mbps' },
    ],
    hints: [
      `每台交換器：snmp-server group NMS v3 priv、snmp-server user ${SNMP_USER.user} NMS v3 auth sha ${SNMP_USER.auth} priv aes 128 ${SNMP_USER.priv}（或在「管理」分頁把 SNMP 改成 v3 並填帳號密碼）。`,
      '網管伺服器的「網管」分頁把 10.0.50.2、.3、.4 加進去（v3、帳號與兩組密碼）。等兩次輪詢（每 60 秒），看哪一條線一直接近 100%，它的速率是多少？',
      'SW-Design 的 Gi0/9 只協商到 100 Mbps，兩端明明都是 Gigabit 埠：網路線有線對斷了，自動降速。把那條線拔掉，重新接一條新的。',
    ],
    solve(s) {
      for (const id of ['core', 'dsg', 'ofc']) Object.assign(dev(s, id).mgmt, { snmp: 'v3', snmpGroup: 'NMS', snmpUser: { ...SNMP_USER, group: 'NMS' } });
      dev(s, 'nms').nms.targets = ['10.0.50.2', '10.0.50.3', '10.0.50.4'].map((ip) => ({ ip, ver: 'v3', ...SNMP_USER }));
      const c = s.cables.find((x) => x.damaged);
      removeCable(s, c.id);
      link(s, 'core:Gi0/9', 'dsg:Gi0/9');
    },
    recap: ['SNMP 輪詢看得到每條線路的使用率；一直接近 100% 的就是瓶頸。', '燈亮著不代表正常：用 show interfaces 或 SNMP 看協商出來的速率。'],
  },
];
void flashPath;
