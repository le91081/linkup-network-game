// 第十七章補充：vMotion — 主機要維護，把虛擬機器搬到另一台；vMotion 網路要通、目的主機同名的連接埠群組 VLAN 要一樣
import { makeDevice as D, makeState, newIface } from '../engine/model.js';
import { vmsOn, vmotion, pgOf, pgVlan } from '../engine/virt.js';
import { dev, swp, WEB, DB } from './util.js';

const sub = (d, port, vlan, ip) => d.ifaces.push(newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' }));
const attach = (s, host, n, vm, pg) => { s.cables.push({ id: 'c' + s.seq++, a: { dev: vm, port: 'eth0' }, b: { dev: host, port: 'vp' + n }, media: 'virt', kind: 'virtual' }); s.devices[host].sw.ports['vp' + n].pg = pg; };
const host = (id, name, pos, n, dbVlan) => D('esxi', id, {
  name, pos,
  init(d) {
    d.vsw.pgs = [{ name: 'Web', vlan: 10 }, { name: 'DB', vlan: dbVlan }, { name: 'vMotion', vlan: 40 }, { name: 'Management Network', vlan: 0 }];
    d.vsw.vmkPg = 'Management Network';
    d.ifaces.push(newIface('vmk1', 'vmk1', { t: 'svi', vlan: 1 }, { ip: `10.0.40.1${n}`, mask: '255.255.255.0', pg: 'vMotion', vmotion: true }));
  },
});

export const LEVELS78 = [
  {
    id: 'l158', chapter: 17, title: '主機要維護，虛擬機器搬家', subtitle: 'vMotion：不關機搬到另一台主機', tags: ['虛擬化', 'vMotion', 'VMkernel', '連接埠群組', '維護模式'],
    brief: 'ESXi-01 今晚要更新韌體，必須先進入維護模式：上面的 web-vm 和 db-vm 要先用 vMotion 搬到 ESXi-02，網站不能停。ESXi-02 是上個月新加的主機，由另一位同事設定。你試著搬第一台，vCenter 就說 vMotion 失敗了。請把兩台虛擬機器都搬到 ESXi-02，而且搬過去之後網站和資料庫都要正常。',
    given: [
      ['VLAN 10 Web', '10.0.10.0/24 · web-vm 10.0.10.10'], ['VLAN 20 DB', '10.0.20.0/24 · db-vm 10.0.20.10'], ['VLAN 30 使用者', '10.0.30.0/24'],
      ['VLAN 40 vMotion', '10.0.40.0/24（不路由）· ESXi-01 vmk1 10.0.40.11、ESXi-02 vmk1 10.0.40.12'],
      ['上行', 'ESXi-01 vmnic0 → SW Gi0/11、ESXi-02 vmnic0 → SW Gi0/12（Trunk）'],
    ],
    learn: [
      { t: 'vMotion', d: '把正在執行的虛擬機器從一台主機搬到另一台，不用關機、連線也不會斷：記憶體的內容透過 vMotion 網路一點一點複製過去，最後一瞬間切換。主機要更新、維修之前，先把虛擬機器都搬走（進入維護模式）。' },
      { t: 'vMotion 網路', d: '每台主機要有一張啟用 vMotion 的 VMkernel 介面卡（例如 vmk1），通常放在自己的 VLAN、自己的網段。兩台主機的 vMotion 介面卡要互相連得到（TCP 8000）：實體交換器接主機的 Trunk 也要放行 vMotion 的 VLAN。' },
      { t: 'vCenter 只比對名稱', d: '遷移前的相容性檢查會確認目的主機有「同名」的連接埠群組，但不會比對 VLAN ID。目的主機的 DB 群組 VLAN 打錯，虛擬機器照樣搬得過去，搬過去之後就斷線。所以每台主機的連接埠群組要一模一樣（大型環境用 Distributed Switch 統一管理）。' },
      { t: '維護模式', d: '主機進入維護模式之前，上面的虛擬機器都要搬走或關機。DRS 會自動幫你用 vMotion 搬；沒有 DRS 就要手動搬。' },
    ],
    setup() {
      const s = makeState([
        D('isr4331', 'rt', { name: 'R1', pos: [-8, -6], init(d) { for (const v of [10, 20, 30]) sub(d, 'Gi0/0/1', v, `10.0.${v}.1`); } }),
        D('c2960', 'sw', {
          name: 'SW-Core', pos: [-1, -2],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'Web' }, { id: 20, name: 'DB' }, { id: 30, name: 'Users' }, { id: 40, name: 'vMotion' });
            d.sw.ports['Gi0/9'].mode = 'trunk'; d.sw.ports['Gi0/9'].allowed = '10,20,30';
            Object.assign(d.sw.ports['Gi0/11'], { mode: 'trunk', allowed: '10,20,40', portfast: true, desc: 'ESXi-01' });
            Object.assign(d.sw.ports['Gi0/12'], { mode: 'trunk', allowed: '10,20', portfast: true, desc: 'ESXi-02' }); // 新主機：忘了 vMotion 的 VLAN 40
            d.sw.ports['Gi0/1'].vlan = 30;
            d.sw.stp.portfastDefault = true;
          },
        }),
        host('esx1', 'ESXi-01', [4, -6], 1, 20),
        host('esx2', 'ESXi-02', [9.5, -1.5], 2, 21), // DB 群組的 VLAN 打錯
        D('vm', 'web', { name: 'web-vm', pos: [2, -1], ip: '10.0.10.10', gw: '10.0.10.1', services: WEB }),
        D('vm', 'db', { name: 'db-vm', pos: [5.5, -1], ip: '10.0.20.10', gw: '10.0.20.1', services: DB }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-7, 4], ip: '10.0.30.50', gw: '10.0.30.1' }),
      ], [['rt:Gi0/0/1', 'sw:Gi0/9'], ['esx1:vmnic0', 'sw:Gi0/11'], ['esx2:vmnic0', 'sw:Gi0/12'], ['pc:eth0', 'sw:Gi0/1']]);
      attach(s, 'esx1', 1, 'web', 'Web');
      attach(s, 'esx1', 2, 'db', 'DB');
      return s;
    },
    objectives: [
      {
        type: 'check', label: 'ESXi-01 上已經沒有虛擬機器（可以進入維護模式）',
        test(s) { const v = vmsOn(s, dev(s, 'esx1')); return !v.length || `ESXi-01 上還有 ${v.map((x) => x.vm.name).join('、')}：選取 ESXi-01 →「虛擬機器」分頁 → 遷移 (vMotion)`; },
      },
      { type: 'tcp', from: 'pc', to: 'web', port: 443, label: '使用者打得開網站（web-vm）' },
      { type: 'tcp', from: 'web', to: 'db', port: 3306, label: '網站連得到資料庫（db-vm）' },
      {
        type: 'check', label: '兩台主機的連接埠群組 VLAN 一樣（Web 10、DB 20、vMotion 40）',
        test(s) {
          for (const id of ['esx1', 'esx2']) for (const [pg, v] of [['Web', 10], ['DB', 20], ['vMotion', 40]]) {
            const got = pgVlan(pgOf(dev(s, id), pg));
            if (got !== v) return `${dev(s, id).name} 的連接埠群組「${pg}」是 VLAN ${got}，應該是 ${v}`;
          }
          return true;
        },
      },
    ],
    hints: [
      'ESXi-01 →「虛擬機器」分頁：選 ESXi-02，按 web-vm 的「遷移 (vMotion)」。相容性檢查說 vMotion 網路不通：ESXi-01 的 vmk1 (10.0.40.11) 連不到 ESXi-02 的 vmk1 (10.0.40.12)。',
      'vMotion 在 VLAN 40。SW-Core 接 ESXi-02 的 Gi0/12：switchport trunk allowed vlan add 40（show interfaces trunk 看兩個埠放行的 VLAN）。',
      '兩台都搬過去之後，網站連不到資料庫：ESXi-02 →「虛擬交換器」分頁，DB 群組的 VLAN 是 21（vCenter 只比對群組的名稱，不比對 VLAN）。改成 20。',
    ],
    solve(s) {
      swp(s, 'sw', 'Gi0/12').allowed = '10,20,40';
      pgOf(dev(s, 'esx2'), 'DB').vlan = 20;
      const e1 = dev(s, 'esx1'), e2 = dev(s, 'esx2');
      for (const { port } of vmsOn(s, e1)) vmotion(s, e1, e2, port);
    },
    recap: ['vMotion 要兩台主機的 vMotion 介面卡互相連得到：實體交換器的 Trunk 也要放行那個 VLAN。', 'vCenter 只比對連接埠群組的名稱，不比對 VLAN：每台主機的群組要一模一樣，不然搬過去就斷線。'],
  },
];
