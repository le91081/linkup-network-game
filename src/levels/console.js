// 第十一章補充：SSH 被自己鎖在門外，只剩 Console 線
import { makeDevice as D, makeState } from '../engine/model.js';
import { iosSession, iosDirty } from '../engine/ios.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

const typeIn = (s, id, lines) => { const S = iosSession(() => s.devices[id], () => s); for (const l of lines) S.exec(l); };
const SW = '10.1.98.11', USER = 'netadmin', PASS = 'Core-Admin#26';

export const LEVELS46 = [
  // ════════════════════════ 11-11 ════════════════════════
  {
    id: 'l126', chapter: 11, title: 'SSH 被自己鎖在門外', subtitle: 'Console 線與帶外管理', tags: ['Console', '帶外管理', 'access-class', 'SSH', 'write memory'],
    brief: `同事昨晚替機房的 SW-1 加了 access-class，只允許網管工作站 (10.1.98.60) 用 SSH 登入 — 結果 ACL 打錯了一個數字，今天早上連網管工作站也 SSH 不進去，而且設定已經存檔了。SW-1 在機房的機櫃裡（面板上不能直接改）：請帶著工程筆電到機房接 Console 線，把 ACL 改好，讓網管工作站登得進去、其他電腦照樣不行，改完記得存檔。`,
    given: [
      ['SW-1', `${SW} · SSH 帳號 ${USER} / ${PASS}`], ['網管工作站', '10.1.98.60（應該可以 SSH）'], ['一般員工 PC', '10.1.98.70（不應該可以 SSH）'],
      ['工程筆電', '帶在身上，有 USB 轉 RJ45 的 Console 線'], ['ACL', 'ip access-list standard VTY-ONLY · line vty 0 4 → access-class VTY-ONLY in'],
    ],
    learn: [
      { t: 'In-band 與 out-of-band', d: 'SSH、Telnet、網頁管理都走正式的網路 (in-band)：IP、VLAN、ACL 設錯就連不進去。Console 線、獨立的管理網路（帶外管理，out-of-band）不靠正式的網路，是設定出錯時的最後入口。' },
      { t: 'Console 線', d: 'Cisco 的 Console 埠是 RJ45（或 USB），用 rollover 線或 USB 轉 RJ45 接到筆電，終端機程式（PuTTY、SecureCRT）選 COM 埠，速率 9600、8 data bits、no parity、1 stop bit (8N1)。速率不對只會看到亂碼。' },
      { t: 'access-class', d: 'line vty 底下的 access-class <ACL> in 限制誰可以遠端登入；它依名稱參照標準 ACL：ACL 改了就跟著生效。打錯 ACL 最容易把自己鎖在外面 — 遠端改 vty 的 ACL 之前，先確定還有 Console 這條路，或用 reload in 10 預約重新開機當保險。' },
    ],
    setup() {
      const s = makeState([
        D('c2960', 'sw1', {
          name: 'SW-1', pos: [0, -3],
          init(d) {
            const i = d.ifaces.find((x) => x.id === 'mgmt');
            Object.assign(i, { ip: SW, mask: '255.255.255.0' });
            Object.assign(d.mgmt, { user: USER, pass: PASS, priv: 15, sshKey: { bits: 2048, gen: 1 }, domain: 'corp.local', vtyLogin: 'local', telnet: false, ssh: true, snmp: 'off' });
            d.sw.stp.portfastDefault = true; // 和其他關卡一樣（levelDefaults），先設好才不會讓存好的設定變成「沒存檔」
            d.remoteOnly = true;
          },
        }),
        D('pc', 'ops', { name: '網管工作站', pos: [-5, 2], ip: '10.1.98.60' }),
        D('pc', 'emp', { name: '一般員工 PC', pos: [1, 3], ip: '10.1.98.70' }),
        D('laptop', 'tech', { name: '工程筆電', pos: [6, 1] }),
      ], [['ops:eth0', 'sw1:Gi0/1'], ['emp:eth0', 'sw1:Gi0/2']]);
      // 昨晚的變更：ACL 打成 10.1.89.60，而且已經 write memory
      typeIn(s, 'sw1', ['configure terminal', 'ip access-list standard VTY-ONLY', 'permit host 10.1.89.60', 'exit', 'line vty 0 4', 'access-class VTY-ONLY in', 'end', 'write memory']);
      return s;
    },
    objectives: [
      { type: 'login', from: 'ops', ip: SW, proto: 'ssh', user: USER, pass: PASS, label: '網管工作站可以用 SSH 登入 SW-1' },
      { type: 'login', from: 'emp', ip: SW, proto: 'ssh', user: USER, pass: PASS, expect: false, label: '一般員工 PC 還是不能 SSH（就算知道密碼）' },
      { type: 'check', label: 'SW-1 改好的設定有存檔（重新開機也不會回到壞掉的設定）', test: (s) => !iosDirty(s, dev(s, 'sw1')) || 'SW-1 的 running-config 還沒存檔：copy running-config startup-config（或 write memory）' },
    ],
    hints: [
      '網管工作站的終端機：ssh netadmin@10.1.98.11 — 連線被拒絕：來源不在允許管理的範圍。',
      '工程筆電 →「Console」分頁：接上 Console 線到 SW-1，速率 9600。',
      'Console 上：show access-lists 或 show running-config | section line — ACL 寫成 10.1.89.60。configure terminal → ip access-list standard VTY-ONLY → no permit host 10.1.89.60 → permit host 10.1.98.60。',
      '最後 end → write memory，不然下次重新開機又會載入錯的那一份。',
    ],
    solve(s) {
      (s.consoles ||= {}).tech = { to: 'sw1', baud: 9600 };
      typeIn(s, 'sw1', ['configure terminal', 'ip access-list standard VTY-ONLY', 'no permit host 10.1.89.60', 'permit host 10.1.98.60', 'end', 'write memory']);
      recompute(s);
    },
    recap: ['遠端管理 (in-band) 會被自己的設定擋住；Console 線（帶外管理）不走網路，是最後的入口。', 'access-class 依名稱參照標準 ACL；改 vty 的 ACL 之前先確定有 Console 可以救，改完記得存檔。'],
  },
];
