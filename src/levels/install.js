// 第十一章補充：Catalyst 9300 的升級 — IOS XE 的 install 模式、flash 滿了、沒存檔的設定在重新開機時消失
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { recompute } from '../engine/sim.js';
import { iosSession, saveStartup, iosDirty } from '../engine/ios.js';
import { ensureFlash, imageFile, pkgFiles, installedImgs, flashFree, md5Of } from '../engine/files.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const OLD = 'cat9k_iosxe.17.06.05.SPA.bin', CUR = 'cat9k_iosxe.17.09.05.SPA.bin', NEW = 'cat9k_iosxe.17.12.04.SPA.bin';
const SRV = '10.10.99.30', FTP = 'netadmin:Fw#Upgrade2026';

export const LEVELS63 = [
  {
    id: 'l143', chapter: 11, title: '核心交換器要升級，flash 卻滿了', subtitle: 'IOS XE 的 install 模式', tags: ['IOS XE', 'install 模式', 'packages.conf', '韌體升級', 'write memory'],
    brief: `資安公告要求核心交換器 Core-SW（Catalyst 9300）從 17.9.5 升到 17.12.4。新版的映像檔 ${NEW} 放在檔案伺服器 ${SRV}（FTP 帳號 netadmin / Fw#Upgrade2026）。昨天同事替會議室新增了 VLAN 30，還沒存檔。請用 install 模式完成升級並確認 (commit)，升級後會議室照樣能用，flash 裡舊版本沒在用的檔案也清乾淨。`,
    given: [
      ['Core-SW', 'Catalyst 9300 · 17.9.5（INSTALL 模式，從 bootflash:packages.conf 開機）'],
      ['VLAN 10', '辦公室 10.10.10.1/24'], ['VLAN 30', '會議室 10.10.30.1/24（昨天新增，還沒有 write memory）'],
      ['檔案伺服器', `${SRV} · FTP ${FTP.replace(':', ' / ')} · ${NEW}`],
    ],
    learn: [
      { t: 'BUNDLE 與 INSTALL 模式', d: 'IOS XE 可以直接從 .bin 開機（BUNDLE 模式），也可以先把 .bin 解開成一個個 .pkg，開機讀 packages.conf（INSTALL 模式）。Catalyst 9000 建議用 INSTALL 模式：開機比較快、比較省記憶體，也支援 install 指令的升級、確認與還原。' },
      { t: 'install add / activate / commit', d: 'install add file bootflash:<bin> 把映像檔解開成套件（I = Inactive）；activate 改寫 packages.conf 並重新開機（U = 啟用但還沒確認）；commit 確認之後才是 C。沒有 commit 的話，計時器 (auto abort timer) 到了會自動退回舊版本。三步可以合成一行：install add file … activate commit。' },
      { t: 'flash 的空間', d: '解開的套件和 .bin 差不多大，所以升級時 flash 裡會同時有：新的 .bin、新的套件、正在用的舊套件。install remove inactive 會刪掉沒在用的套件與 .bin（連剛下載、還沒 add 的 .bin 也會刪），要在下載新版本之前先清。' },
      { t: '重新開機前先存檔', d: 'activate 會重新開機，而重新開機只會載入 startup-config：沒有 write memory 的設定（例如昨天新增的 VLAN 30）會不見。' },
    ],
    setup() {
      const s = makeState([
        D('c9300', 'core', {
          name: 'Core-SW', pos: [0, -4],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'OFFICE' }, { id: 99, name: 'MGMT' });
            Object.assign(d.sw.ports['Gi1/0/1'], { mode: 'access', vlan: 10 });
            Object.assign(d.sw.ports['Gi1/0/3'], { mode: 'access', vlan: 99 });
            d.ifaces.push(newIface('vlan10', 'Vlan10', { t: 'svi', vlan: 10 }, { ip: '10.10.10.1', mask: '255.255.255.0' }));
            d.ifaces.push(newIface('vlan99', 'Vlan99', { t: 'svi', vlan: 99 }, { ip: '10.10.99.1', mask: '255.255.255.0' }));
            Object.assign(d.mgmt, { sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local' });
            d.sw.stp.portfastDefault = true;
            // 上次升級留下來的東西：17.6.5 的套件與 .bin、17.9.5 的 .bin，還有一份很大的系統報告
            ensureFlash(d);
            const f = d.flash.files;
            Object.assign(f, pkgFiles(OLD, -1));
            f[OLD] = imageFile(OLD, -1);
            f[CUR] = imageFile(CUR, -1);
            f['crashinfo/system-report_1_20251103-021455-UTC.tar.gz'] = { size: 0, md5: md5Of('report'), kind: 'other', t: -1 };
            f['crashinfo/system-report_1_20251103-021455-UTC.tar.gz'].size = Math.max(0, flashFree(d) - 900 * 1048576);
          },
        }),
        D('pc', 'pc1', { name: '辦公室 PC', pos: [-6, 2], ip: '10.10.10.21', gw: '10.10.10.1' }),
        D('laptop', 'pc3', { name: '會議室筆電', pos: [-1, 4], ip: '10.10.30.21', gw: '10.10.30.1' }),
        D('tower', 'srv', {
          name: '檔案伺服器', pos: [7, 1], ip: SRV, gw: '10.10.99.1', services: [{ proto: 'udp', port: 69, name: 'TFTP' }, { proto: 'tcp', port: 21, name: 'FTP' }],
          init(d) { d.files = { [NEW]: imageFile(NEW, -1) }; d.ftpUsers = [{ user: 'netadmin', pass: 'Fw#Upgrade2026' }]; },
        }),
      ], [['pc1:eth0', 'core:Gi1/0/1'], ['pc3:eth0', 'core:Gi1/0/2'], ['srv:eth0', 'core:Gi1/0/3']]);
      recompute(s);
      saveStartup(s.devices.core);
      // 昨天新增的會議室 VLAN：還沒存檔
      typeIn(s, 'core', ['enable', 'configure terminal', 'vlan 30', 'name MEETING', 'exit', 'interface Vlan30', 'ip address 10.10.30.1 255.255.255.0', 'no shutdown', 'exit',
        'interface Gi1/0/2', 'switchport mode access', 'switchport access vlan 30', 'end']);
      recompute(s);
      return s;
    },
    objectives: [
      {
        type: 'check', label: 'Core-SW 跑 17.12.4，INSTALL 模式',
        test(s) {
          const d = dev(s, 'core');
          if ((s.rt.rommon || {}).core) return `Core-SW 沒有開機成功，停在 ROMMON：${s.rt.rommon.core}`;
          if ((s.rt.booting || {}).core > 0) return 'Core-SW 還在開機中';
          if (!d.fw || d.fw.ver !== '17.12.4') return `Core-SW 現在跑的是 ${d.fw ? d.fw.ver : '?'}（show version 看）`;
          return d.fw.mode === 'install' || 'Core-SW 是從 .bin 開機（BUNDLE 模式）：要用 install add file … activate commit';
        },
      },
      { type: 'check', label: '新版本已經確認 (commit)', test: (s) => !(dev(s, 'core').install && dev(s, 'core').install.pending) || '新版本啟用了但還沒 commit（show install summary 是 U）：install commit，不然計時器到了會自動退回舊版本' },
      { type: 'ping', from: 'pc3', ip: '10.10.30.1', label: '升級之後，會議室照樣連得到閘道（VLAN 30 還在）' },
      {
        type: 'check', label: 'flash 裡沒有沒在用的舊套件與映像檔',
        test(s) {
          const d = dev(s, 'core'), extra = installedImgs(d).filter((x) => !x.active);
          const bins = Object.keys(d.flash.files).filter((n) => d.flash.files[n].kind === 'image');
          if (extra.length) return `flash 裡還有沒在用的套件（show install summary 的 I）：install remove inactive`;
          return !bins.length || `flash 裡還有用不到的 .bin：${bins.join('、')}`;
        },
      },
      { type: 'check', label: '設定都已經存檔', test: (s) => !iosDirty(s, dev(s, 'core')) || 'Core-SW 還有沒存檔的設定（write memory）' },
    ],
    hints: [
      `先 write memory：activate 會重新開機，昨天新增的 VLAN 30 還沒存檔。再看 dir bootflash: 與 show install summary：只剩 900 MB，新的 .bin 要 ${Math.round(1249050624 / 1048576)} MB。`,
      `install remove inactive 刪掉 17.6.5 的套件和舊的 .bin（回答 y），再 copy ftp://${FTP}@${SRV}/${NEW} bootflash:。`,
      `install add file bootflash:${NEW} activate commit（回答 y），重新開機之後 show version 確認是 17.12.4、INSTALL。最後再 install remove inactive 清掉 17.9.5 的套件與 .bin。`,
    ],
    solve(s) {
      typeIn(s, 'core', ['enable', 'write memory', 'install remove inactive', 'y']);
      dev(s, 'core').flash.files[NEW] = imageFile(NEW, s.clock);
      typeIn(s, 'core', ['install add file bootflash:' + NEW + ' activate commit', 'y']);
      recompute(s);
      typeIn(s, 'core', ['enable', 'install remove inactive', 'y']);
    },
    recap: [
      'Catalyst 9000 用 INSTALL 模式：install add（解開）→ activate（重新開機）→ commit（確認），show install summary 看 I / U / C。',
      '升級前先 write memory、先 install remove inactive 清出空間，再下載新的 .bin。',
    ],
  },
];
