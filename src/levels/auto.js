// 第十五章：網路自動化 — RESTCONF 與 JSON、Ansible
import { makeDevice as D, makeState, setLine, newIface } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { restconf } from '../engine/restconf.js';
import { runPlaybook } from '../engine/automation.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

export const CHAPTERS9 = [
  { id: 15, title: '網路自動化', desc: '用程式管理網路：REST API 與 JSON（RESTCONF / YANG）、用 Ansible 一次設定很多台設備，宣告式與冪等。' },
];

const sub = (d, port, vlan, ip, pool) => {
  const i = newIface(`${port}.${vlan}`, `${port}.${vlan}`, { t: 'sub', port, vlan }, { ip, mask: '255.255.255.0' });
  if (pool) Object.assign(i.dhcp, { on: true, pool: pool.name, start: pool.start, end: pool.end, dns: '', gw: '' });
  d.ifaces.push(i);
};
const mgmtIp = (d, vlan, ip, gw) => { const i = d.ifaces.find((x) => x.id === 'mgmt'); i.bind.vlan = vlan; Object.assign(i, { ip, mask: '255.255.255.0', gateway: gw }); };
const typeIn = (s, id, lines) => { const sess = iosSession(() => s.devices[id], () => s); for (const l of lines) sess.exec(l); };
/** 關卡用：自動化主機送出過的 API 請求 */
const apiLog = (s, from, devId) => ((s.dyn && s.dyn.api) || []).filter((x) => x.from === from && x.dev === devId);

// ═══════════════════════════ 15-1 RESTCONF ═══════════════════════════
const RC = { user: 'netauto', pass: 'Aut0mate!26' };
const R1_LAN = '10.20.0.1';
const BASE = `https://${R1_LAN}/restconf/data`;

// ═══════════════════════════ 15-2 Ansible ═══════════════════════════
const ANS = { user: 'netadmin', pass: 'Ans1ble!Net' };
const SWITCHES = [['core', 'SW-Core', '10.0.99.2'], ['swa', 'SW-A', '10.0.99.11'], ['swb', 'SW-B', '10.0.99.12'], ['swc', 'SW-C', '10.0.99.13']];
const IOT_SRV = '10.0.40.10';
export const INVENTORY_L59 = `# 受管設備清單（inventory）
[access]
sw-a ansible_host=10.0.99.11
sw-b ansible_host=10.0.99.12
sw-c ansible_host=10.0.99.13

[core]
sw-core ansible_host=10.0.99.2

[campus:children]
access
core

[campus:vars]
ansible_user=${ANS.user}
ansible_password=${ANS.pass}
ansible_network_os=cisco.ios.ios
`;
export const PLAYBOOK_L59 = `---
# 新增 IoT 用的 VLAN 50（同事寫到一半）
- name: 新增 IoT VLAN
  hosts: campus
  gather_facts: no

  tasks:
    - name: 建立 VLAN 50
      cisco.ios.ios_vlans:
        config:
          - vlan_id: 50
            name: IOT
        state: merged

    - name: 感測器的埠放進 VLAN 50
      cisco.ios.ios_l2_interfaces:
      config:
        - name: GigabitEthernet0/5
          mode: access
          access:
            vlan: 50
      state: merged
`;
const SOLVED_L59 = `---
- name: 新增 IoT VLAN
  hosts: campus
  gather_facts: no
  tasks:
    - name: 建立 VLAN 50
      cisco.ios.ios_vlans:
        config:
          - vlan_id: 50
            name: IOT
        state: merged

- name: 接入交換器
  hosts: access
  gather_facts: no
  tasks:
    - name: 感測器的埠放進 VLAN 50，上行的 Trunk 加上 VLAN 50
      cisco.ios.ios_l2_interfaces:
        config:
          - name: GigabitEthernet0/5
            mode: access
            access:
              vlan: 50
          - name: GigabitEthernet0/9
            trunk:
              allowed_vlans: 50
        state: merged

- name: 核心交換器
  hosts: core
  gather_facts: no
  vars:
    trunks: [GigabitEthernet0/1, GigabitEthernet0/2, GigabitEthernet0/3, GigabitEthernet0/9]
  tasks:
    - name: 往接入交換器與路由器的 Trunk 加上 VLAN 50
      cisco.ios.ios_l2_interfaces:
        config:
          - name: "{{ item }}"
            trunk:
              allowed_vlans: 50
        state: merged
      loop: "{{ trunks }}"
`;
/** 最近一次（不是 --check）的 ansible-playbook，四台交換器都成功了嗎 */
function ansibleRuns(s) { return (((s.dyn || {}).ansible || {}).runs || []).filter((r) => !r.check); }
function cleanOn(run, ids) {
  const byDev = {};
  for (const [h, id] of Object.entries(run.devs || {})) byDev[id] = run.recap[h];
  const miss = ids.filter((id) => !byDev[id]);
  const bad = ids.filter((id) => byDev[id] && (byDev[id].failed || byDev[id].unreachable));
  return { byDev, miss, bad };
}

export const LEVELS11 = [
  // ════════════════════════ 15-1 ════════════════════════
  {
    id: 'l58', chapter: 15, title: '用 API 管理路由器', subtitle: 'REST、RESTCONF、YANG 與 JSON', tags: ['RESTCONF', 'REST API', 'JSON', 'YANG', 'HTTPS'],
    brief: '分公司換上了 IOS XE 的 ISR 4321。自動化小組不想再一台一台登入改設定，要改用程式呼叫 API。請在 R1 上啟用 RESTCONF（只能走 HTTPS，未加密的 HTTP 要關掉），然後從自動化工作站用 API：讀出介面清單、把連往 ISP 的介面說明改成 WAN-to-ISP、再建立一個 Loopback100（10.255.0.1/32，說明 Router-ID）。',
    given: [
      ['R1', `IOS XE · 內部 ${R1_LAN} · 已經有帳號 ${RC.user} / ${RC.pass}（privilege 15）`], ['自動化工作站', '10.20.0.50 ·「API」分頁或終端機的 curl'],
      ['API 的網址', `${BASE}/<YANG 路徑>`], ['YANG 路徑', 'ietf-interfaces:interfaces、…/interface=<名稱>'],
    ],
    learn: [
      { t: 'REST 與 CRUD', d: 'REST API 用 HTTP 的方法表示要做什麼：POST 建立 (Create)、GET 讀取 (Read)、PUT 整個取代或 PATCH 只改一部分 (Update)、DELETE 刪除 (Delete)。它是無狀態的 (stateless)：每一個請求都要自己帶上驗證資訊，伺服器不記得上一個請求。' },
      { t: 'RESTCONF 與 YANG', d: 'RESTCONF 是網路設備的 REST API，資料的結構由 YANG 模型定義：ietf-interfaces 是 IETF 的標準模型（各家通用），Cisco-IOS-XE-native 是 Cisco 自己的模型。網址就是資料的路徑：/restconf/data/<模組>:<容器>/<清單>=<鍵>，例如 …/ietf-interfaces:interfaces/interface=Loopback100。' },
      { t: 'JSON', d: '物件用 { }、陣列用 [ ]，裡面是「"鍵": 值」。字串一定用雙引號；數字、true / false、null 不加引號；最後一項後面不能有逗號。RESTCONF 的 JSON 鍵會帶模組名稱，例如 "ietf-interfaces:interface"。' },
      { t: 'HTTP 狀態碼', d: '2xx 成功（200 OK 有內容、201 Created 建立成功、204 No Content 改好了沒有內容）；4xx 是請求的問題（400 內容不對、401 帳號密碼錯、404 路徑不存在、405 這個方法不能用、409 已經存在、415 Content-Type 不對）。' },
      { t: '傳統管理與自動化', d: '傳統做法是逐台登入 CLI，靠人看輸出、靠人記得每台的差異。API 讓程式直接讀寫結構化的資料：結果可以比對、步驟可以重複，十台和一百台的工作量差不多，也比較不會打錯。' },
    ],
    setup() {
      const s = makeState([
        setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -10] }), 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: '203.0.113.34' }),
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -5],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '203.0.113.34', mask: '255.255.255.252', gateway: '203.0.113.33', nat: true });
            Object.assign(d.ifaces[1], { ip: R1_LAN, mask: '255.255.255.0' });
            // 前任只開了未加密的 http server（網頁管理），沒有 HTTPS、沒有 RESTCONF
            Object.assign(d.mgmt, { user: RC.user, pass: RC.pass, http: true, https: false });
          },
        }),
        D('sw8', 'sw', { name: 'LAN Switch', pos: [0, -0.5] }),
        D('laptop', 'auto', { name: '自動化工作站', pos: [-6, 4], ip: '10.20.0.50', gw: R1_LAN, dns: '8.8.8.8', init(d) { d.apps = ['api']; } }),
        D('pc', 'pc1', { name: '業務 PC', pos: [6, 4], ip: '10.20.0.60', gw: R1_LAN, dns: '8.8.8.8' }),
      ], [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ['auto:eth0', 'sw:2'], ['pc1:eth0', 'sw:3']]);
      return s;
    },
    objectives: [
      {
        type: 'check', label: `自動化工作站用 RESTCONF（帳號 ${RC.user}）讀得到 R1 的介面清單 (JSON)`,
        test(s) {
          const r = restconf(s, 'auto', { method: 'GET', url: `${BASE}/ietf-interfaces:interfaces`, user: RC.user, pass: RC.pass, accept: 'application/yang-data+json', quiet: true });
          if (r.error) return r.error;
          return r.status === 200 || `HTTP ${r.status} ${r.statusText}${r.note ? '：' + r.note : ''}`;
        },
      },
      { type: 'tcp', from: 'pc1', ip: R1_LAN, port: 80, expect: false, label: 'R1 不再提供未加密的 HTTP（API 與網頁管理只走 HTTPS）' },
      {
        type: 'check', label: '用 API 把 Gi0/0/0 的說明改成 WAN-to-ISP',
        test(s) {
          const i = dev(s, 'rt').ifaces.find((x) => x.bind.t === 'port' && x.bind.port === 'Gi0/0/0');
          const used = apiLog(s, 'auto', 'rt').some((x) => ['PATCH', 'PUT'].includes(x.method) && x.status === 204 && decodeURIComponent(x.path).includes('interface=GigabitEthernet0/0/0'));
          if (!used) return i.desc === 'WAN-to-ISP' ? '說明對了，但這次要用 API（PATCH …/interface=GigabitEthernet0%2F0%2F0）改，不是在 CLI 改' : '還沒有用 PATCH（或 PUT）成功修改 GigabitEthernet0/0/0';
          return i.desc === 'WAN-to-ISP' || `Gi0/0/0 的說明現在是「${i.desc || '（沒有）'}」，要是 WAN-to-ISP（大小寫也要一樣）`;
        },
      },
      {
        type: 'check', label: '用 API 建立 Loopback100（10.255.0.1/32，說明 Router-ID）',
        test(s) {
          const lo = dev(s, 'rt').ifaces.find((x) => x.bind.t === 'loop' && x.bind.n === 100);
          const used = apiLog(s, 'auto', 'rt').some((x) => x.method === 'POST' && x.status === 201);
          if (!lo) return '還沒有 Loopback100';
          if (!used) return 'Loopback100 要用 API 的 POST 建立（回應 201 Created）';
          if (lo.ip !== '10.255.0.1' || !['255.255.255.255', '32', '/32'].includes(String(lo.mask))) return `Loopback100 的位址是 ${lo.ip || '（沒有）'} ${lo.mask || ''}，要是 10.255.0.1 255.255.255.255`;
          return lo.desc === 'Router-ID' || `Loopback100 的說明是「${lo.desc || '（沒有）'}」，要是 Router-ID`;
        },
      },
      { type: 'ping', from: 'auto', ip: '10.255.0.1', label: '自動化工作站 ping 得到 10.255.0.1' },
    ],
    hints: [
      `RESTCONF 要 HTTPS 與本機帳號：在 R1 的 CLI 輸入 configure terminal → ip http secure-server → ip http authentication local → restconf；再 no ip http server 把未加密的 HTTP 關掉。`,
      `選取自動化工作站 →「API」分頁：GET ${BASE}/ietf-interfaces:interfaces，帳號 ${RC.user}。Accept 選 application/yang-data+json（不指定的話 IOS XE 回 XML）。設備的憑證是自己簽的，要取消「驗證 SSL 憑證」（curl 是 -k）。`,
      `改說明：PATCH ${BASE}/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0%2F0（名稱裡的 / 要寫成 %2F），Content-Type application/yang-data+json，內容 {"ietf-interfaces:interface": {"name": "GigabitEthernet0/0/0", "description": "WAN-to-ISP"}}。`,
      `建立 Loopback：POST ${BASE}/ietf-interfaces:interfaces，內容 {"ietf-interfaces:interface": {"name": "Loopback100", "description": "Router-ID", "type": "iana-if-type:softwareLoopback", "enabled": true, "ietf-ip:ipv4": {"address": [{"ip": "10.255.0.1", "netmask": "255.255.255.255"}]}}}。`,
    ],
    solve(s) {
      recompute(s);
      typeIn(s, 'rt', ['configure terminal', 'ip http secure-server', 'ip http authentication local', 'restconf', 'no ip http server', 'end']);
      recompute(s);
      const req = (o) => restconf(s, 'auto', { user: RC.user, pass: RC.pass, accept: 'application/yang-data+json', contentType: 'application/yang-data+json', ...o });
      req({ method: 'GET', url: `${BASE}/ietf-interfaces:interfaces` });
      req({ method: 'PATCH', url: `${BASE}/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0%2F0`, body: JSON.stringify({ 'ietf-interfaces:interface': { name: 'GigabitEthernet0/0/0', description: 'WAN-to-ISP' } }) });
      req({ method: 'POST', url: `${BASE}/ietf-interfaces:interfaces`, body: JSON.stringify({ 'ietf-interfaces:interface': { name: 'Loopback100', description: 'Router-ID', type: 'iana-if-type:softwareLoopback', enabled: true, 'ietf-ip:ipv4': { address: [{ ip: '10.255.0.1', netmask: '255.255.255.255' }] } } }) });
    },
    recap: ['REST 用 HTTP 的方法表示 CRUD，回應用狀態碼表示結果；RESTCONF 的資料結構由 YANG 模型定義，網址就是資料的路徑。', '寫入時 Content-Type 要是 application/yang-data+json；名稱裡的 / 要編碼成 %2F。API 改的和 CLI 改的是同一份設定。'],
  },

  // ════════════════════════ 15-2 ════════════════════════
  {
    id: 'l59', chapter: 15, title: '一次設定四台交換器', subtitle: 'Ansible：inventory、playbook、冪等', tags: ['Ansible', 'YAML', 'playbook', '冪等', 'network_cli'],
    brief: '工廠要裝一批 IoT 閘道器，網路組決定開一個 VLAN 50 (IOT)。路由器那一端（子介面與 DHCP）已經做好了；四台交換器要建 VLAN 50、把每台的 Gi0/5 放進去，Trunk 也要讓 VLAN 50 通過。同事開始用 Ansible 寫了 inventory 和 playbook，但還沒跑成功過就休假了。請用 Ansible 完成，而且要確認這份 playbook 再跑一次不會再改任何東西。',
    given: [
      ['Ansible 控制主機', '10.0.99.20 ·「Ansible」分頁'], ['交換器管理 IP（VLAN 99）', 'SW-Core .2 · SW-A .11 · SW-B .12 · SW-C .13'],
      ['登入帳號', `${ANS.user} / ${ANS.pass}（SSH）`], ['IoT VLAN', '50 · 10.0.50.0/24 · 名稱 IOT'], ['IoT 平台', `${IOT_SRV}（VLAN 40）· MQTT over TLS 8883`],
      ['Trunk', '接入交換器的 Gi0/9 上行；SW-Core 的 Gi0/1 – 3 往接入交換器、Gi0/9 往路由器'],
    ],
    learn: [
      { t: 'Ansible 怎麼管網路設備', d: 'Ansible 不用在設備上裝代理程式 (agentless)：控制主機用 SSH 登入設備，在 CLI 上替你下指令（network_cli 連線方式）。inventory 列出要管哪些設備、怎麼登入；playbook 用 YAML 寫要做的事。' },
      { t: '宣告式與冪等', d: 'ios_vlans、ios_l2_interfaces 這類「資源模組」是宣告式的：你寫的是「應該是什麼樣子」，模組先讀設備現在的設定，只補不一樣的部分。設定已經對了就什麼都不做 (ok)——同一份 playbook 跑幾次結果都一樣，這叫冪等 (idempotent)。' },
      { t: 'YAML', d: '用縮排表示階層，只能用空白、不能用 Tab；「- 」開頭是清單的一項，「鍵: 值」是對應。模組的參數要比模組名稱多縮排一層，否則 Ansible 會以為那是另一個模組。值以 {{ 開頭時要加引號。' },
      { t: 'PLAY RECAP', d: '最後的總表：ok 是不用改、changed 是改了設定、unreachable 是連不上（SSH、帳號密碼）、failed 是模組執行失敗。有 unreachable 或 failed 的設備，後面的 task 都不會再對它執行。' },
      { t: '其他工具', d: 'Terraform 也是宣告式，常用來建立雲端資源（先 plan 再 apply，用 state 檔記住現況）；Puppet、Chef 要在受管主機上裝代理程式 (agent-based)，Ansible 不用。' },
    ],
    setup() {
      const s = makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [0, -10.5],
          init(d) {
            d.ifaces[1].ip = '';
            sub(d, 'Gi0/0/1', 10, '10.0.10.1'); sub(d, 'Gi0/0/1', 40, '10.0.40.1');
            sub(d, 'Gi0/0/1', 50, '10.0.50.1', { name: 'IOT', start: '10.0.50.100', end: '10.0.50.199' });
            sub(d, 'Gi0/0/1', 99, '10.0.99.1');
          },
        }),
        D('c2960', 'core', {
          name: 'SW-Core', pos: [0, -5.5],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'STAFF' }, { id: 40, name: 'SERVERS' }, { id: 99, name: 'MGMT' });
            for (const p of ['Gi0/1', 'Gi0/2', 'Gi0/3']) Object.assign(d.sw.ports[p], { mode: 'trunk', allowed: '10,99' });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: '10,40,99' });
            Object.assign(d.sw.ports['Gi0/8'], { mode: 'access', vlan: 40 });
            Object.assign(d.sw.ports['Gi0/7'], { mode: 'access', vlan: 99 });
            mgmtIp(d, 99, '10.0.99.2', '10.0.99.1');
            Object.assign(d.mgmt, ANS);
          },
        }),
        ...SWITCHES.slice(1).map(([id, name, ip], n) => D('c2960', id, {
          name, pos: [-9.5 + n * 9.5, 0],
          init(d) {
            d.sw.vlans.push({ id: 10, name: 'STAFF' }, { id: 99, name: 'MGMT' });
            Object.assign(d.sw.ports['Gi0/9'], { mode: 'trunk', allowed: '10,99' });
            mgmtIp(d, 99, ip, '10.0.99.1');
            // SW-C 是上週才上架的：前任只留下原廠的 admin，還沒建 netadmin
            Object.assign(d.mgmt, id === 'swc' ? { user: 'admin', pass: 'C1sco-Lab!' } : ANS);
          },
        })),
        D('tower', 'iotp', { name: 'IoT 平台', pos: [-9, -6], ip: IOT_SRV, gw: '10.0.40.1', services: [{ proto: 'tcp', port: 8883, name: 'MQTT over TLS' }] }),
        D('pc', 'ctl', { name: 'Ansible 控制主機', pos: [9, -6], ip: '10.0.99.20', gw: '10.0.99.1', init(d) { d.apps = ['ansible']; d.ansible = { inventory: INVENTORY_L59, playbook: PLAYBOOK_L59, file: 'vlan50.yml' }; } }),
        ...['a', 'b', 'c'].map((x, n) => D('pc', 'iot-' + x, { name: `IoT 閘道器 ${x.toUpperCase()}`, pos: [-11 + n * 9.5, 5.5], dhcp: true })),
      ], [
        ['rt:Gi0/0/1', 'core:Gi0/9'], ['core:Gi0/1', 'swa:Gi0/9'], ['core:Gi0/2', 'swb:Gi0/9'], ['core:Gi0/3', 'swc:Gi0/9'],
        ['iotp:eth0', 'core:Gi0/8'], ['ctl:eth0', 'core:Gi0/7'], ['iot-a:eth0', 'swa:Gi0/5'], ['iot-b:eth0', 'swb:Gi0/5'], ['iot-c:eth0', 'swc:Gi0/5'],
      ]);
      return s;
    },
    objectives: [
      {
        type: 'check', label: '四台交換器都有 VLAN 50（名稱 IOT）',
        test(s) {
          for (const [id, name] of SWITCHES) {
            const v = dev(s, id).sw.vlans.find((x) => x.id === 50);
            if (!v) return `${name} 還沒有 VLAN 50`;
            if (v.name !== 'IOT') return `${name} 的 VLAN 50 名稱是 ${v.name}，要是 IOT`;
          }
          return true;
        },
      },
      ...['a', 'b', 'c'].map((x) => ({ type: 'tcp', from: 'iot-' + x, ip: IOT_SRV, port: 8883, label: `IoT 閘道器 ${x.toUpperCase()} 拿到 10.0.50.x，連得上 IoT 平台 (8883)` })),
      {
        type: 'check', label: '用 Ansible 對四台交換器跑完 playbook（沒有 failed、沒有 unreachable）',
        test(s) {
          const runs = ansibleRuns(s);
          if (!runs.length) return '還沒有執行過 ansible-playbook（--check 不算）';
          const ids = SWITCHES.map((x) => x[0]);
          if (runs.some((r) => { const c = cleanOn(r, ids); return !c.miss.length && !c.bad.length; })) return true;
          const c = cleanOn(runs[runs.length - 1], ids);
          const nm = (id) => SWITCHES.find((x) => x[0] === id)[1];
          return c.bad.length ? `最近一次執行，${c.bad.map(nm).join('、')} 失敗了（看 PLAY RECAP 的 failed / unreachable）` : `最近一次執行沒有成功登入 ${c.miss.map(nm).join('、')}`;
        },
      },
      {
        type: 'check', label: '最後再跑一次：四台都只有 ok、changed=0（冪等）',
        test(s) {
          const runs = ansibleRuns(s);
          const last = runs[runs.length - 1];
          if (!last) return '還沒有執行過 ansible-playbook';
          const ids = SWITCHES.map((x) => x[0]);
          const c = cleanOn(last, ids);
          if (c.miss.length || c.bad.length) return '最近一次執行有交換器沒有成功';
          const chg = ids.filter((id) => c.byDev[id].changed);
          return !chg.length || `最近一次執行還有 ${chg.length} 台是 changed：設定已經對了卻還在改，表示這份 playbook 不冪等（例如 ios_config 的 switchport trunk allowed vlan add 每次都會送出）。設定完成之後再跑一次，結果要全部是 ok`;
        },
      },
    ],
    hints: [
      '先按「執行」看錯誤訊息。「conflicting action statements」：第二個 task 的 config 與 state 沒有縮排在 cisco.ios.ios_l2_interfaces 底下，Ansible 以為那是另外兩個模組。往右縮兩格。',
      '「Connection type ssh is not valid for this module」：cisco.ios 的模組要用 network_cli 連線。inventory 的 [campus:vars] 加上 ansible_connection=ansible.netcommon.network_cli。',
      'SW-C 是 UNREACHABLE（Authentication failed）：它還沒有 netadmin 帳號。到 SW-C 的 CLI：username netadmin privilege 15 secret Ans1ble!Net。',
      'Trunk 也要放行 VLAN 50。用 ios_l2_interfaces 的 trunk: { allowed_vlans: 50 }（state: merged 會用 allowed vlan add，原本的 VLAN 保留）；接入交換器是 Gi0/9，SW-Core 是 Gi0/1、Gi0/2、Gi0/3 與 Gi0/9。可以分成 hosts: access 與 hosts: core 兩個 play。',
      '全部通了之後再按一次「執行」：PLAY RECAP 應該全部是 changed=0。',
    ],
    solve(s) {
      recompute(s);
      typeIn(s, 'swc', ['configure terminal', `username ${ANS.user} privilege 15 secret ${ANS.pass}`, 'end']);
      const ctl = dev(s, 'ctl');
      ctl.ansible.inventory = INVENTORY_L59.replace('ansible_network_os=cisco.ios.ios', 'ansible_network_os=cisco.ios.ios\nansible_connection=ansible.netcommon.network_cli');
      ctl.ansible.playbook = SOLVED_L59;
      recompute(s);
      runPlaybook(s, 'ctl', { inventory: ctl.ansible.inventory, playbook: ctl.ansible.playbook, file: 'vlan50.yml' });
      recompute(s);
      runPlaybook(s, 'ctl', { inventory: ctl.ansible.inventory, playbook: ctl.ansible.playbook, file: 'vlan50.yml' });
    },
    recap: ['Ansible 用 SSH 登入設備替你下 CLI 指令：inventory 決定管哪些設備、怎麼登入，playbook 用 YAML 描述要的結果。', '資源模組是宣告式、冪等的：設定對了就是 ok；不冪等的做法（例如每次都送 add 的 ios_config）會讓每次執行都顯示 changed。'],
  },
];
