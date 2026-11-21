// 自由模式：自己擺設備、自由接線、任意測試連線
import { h, icon, button, toast } from './dom.js';
import { saveJson } from './save.js';
import { CATALOG, makeDevice, makeState, setLine, uniqueId, cloneState } from '../engine/model.js';
import { recompute, runObjective } from '../engine/sim.js';
import { isIos, saveStartup } from '../engine/ios.js';
import { editorSection } from './editor.js';

const VENDOR = /^(Cisco|TP-Link|Ubiquiti|Fortinet|NETGEAR|ASUS|Dell|Lenovo|Apple|HP|Synology|VMware) /;
const HOST_NAME = { pc: 'PC', laptop: '筆電', phone: '手機', printer: '印表機', wprinter: '無線印表機', nas: 'NAS', tower: '伺服器', rack1u: '機架伺服器', vm: 'VM' };
const GROUPS = [
  ['終端設備', ['pc', 'laptop', 'phone', 'printer', 'nas', 'tower', 'rack1u']],
  ['交換器', ['hub4', 'sw5', 'sw8', 'c2960', 'c2960p', 'c9300', 'n93180', 'n9332']],
  ['路由器與防火牆', ['homerouter', 'erx', 'isr4321', 'isr4331', 'fg60f', 'fg100f']],
  ['無線與外部線路', ['ap', 'internet']],
  ['虛擬化', ['esxi', 'vm']],
];
const SERVER_MODELS = ['tower', 'rack1u'];
const shortName = (model) => (CATALOG[model].kind === 'internet' ? '網際網路 (ISP)' : CATALOG[model].title.replace(VENDOR, ''));

export const SANDBOX = {
  id: 'sandbox', sandbox: true, chapter: 0, title: '自由模式', subtitle: '自己擺設備、自由接線', tags: ['沙盒', '沒有任務目標'],
  brief: '這裡沒有任務。從下方挑設備放到桌面上，自己規劃拓撲、接線、設定，再用連線測試或終端機驗證你的設計。',
  learn: [
    { t: '怎麼開始', d: '在左側點設備的名稱就會放到桌面上。拖曳一台設備到另一台設備上可以接線，點設備可以設定。' },
    { t: '移動、改名與刪除', d: '按住 Shift 再拖曳設備可以移動位置。選取設備後，面板最上方可以直接改名，旁邊的垃圾桶可以刪除。' },
    { t: '測試連線', d: '用左側的「連線測試」選來源與目的，或打開電腦的終端機用 ping、tracert。Cisco 設備有 CLI 分頁，可以直接用指令設定。' },
    { t: '自訂目標', d: '把常用的測試存成目標（應該要通，或應該被擋下），之後改設定時按「執行全部目標」就能一次驗證，像關卡一樣。' },
    { t: '匯出與匯入', d: '整個拓撲（設備、接線、設定與目標）可以匯出成一個 JSON 檔，之後再匯入，或傳給別人。' },
    { t: '時間', d: '這裡的設備都是原廠預設值。網管交換器的埠連線後要等 30 秒（STP 的 listening 與 learning）才會轉送資料，除非打開 PortFast；OSPF 鄰居要 40 秒才會建立。場景上方的時鐘可以加速或快轉。' },
  ],
  objectives: [], hints: [], recap: [],
  setup: () => { const s = makeState([]); s.v6 = true; return s; },
};

const TESTS = [['ping', 'Ping (ICMP)'], ['tcp:443', 'HTTPS (TCP 443)'], ['tcp:80', 'HTTP (TCP 80)'], ['tcp:22', 'SSH (TCP 22)'], ['speed', '傳輸速率 (iperf3)']];
const splitTest = (v) => { const [type, port] = String(v).split(':'); return { type, port: port ? +port : undefined }; };

/** 自由模式的自訂目標 → 和關卡一樣的目標物件 */
export function sandboxObjectives(state) {
  return (state.goals || []).filter((g) => state.devices[g.from] && state.devices[g.to]).map((g) => {
    const a = state.devices[g.from].name, b = state.devices[g.to].name;
    if (g.type === 'speed') return { type: 'speed', from: g.from, to: g.to, min: g.min || 100, label: `${a} 到 ${b} 至少 ${g.min || 100} Mbps` };
    const what = g.type === 'ping' ? ` ping 到 ${b}` : `連到 ${b} 的 TCP ${g.port}`;
    return { type: g.type, from: g.from, to: g.to, port: g.port, expect: g.expect === false ? false : undefined, label: g.expect === false ? `${a} 不能${what}（應該被擋下）` : `${a} 可以${what}` };
  });
}

/** 檢查匯入的內容；有問題就回傳錯誤訊息 */
export function checkImport(data) {
  const st = data && typeof data === 'object' ? data.state : null;
  if (!st || typeof st.devices !== 'object' || !Array.isArray(st.cables)) return '這不是 LinkUp 匯出的拓撲檔';
  for (const [id, d] of Object.entries(st.devices)) {
    if (!/^[\w.-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !d || d.id !== id) return '設備資料不正確';
    if (!CATALOG[d.model] || CATALOG[d.model].kind !== d.kind) return `不認識的設備型號：${String(d.model).slice(0, 30)}`;
    if (!Array.isArray(d.ports) || !Array.isArray(d.ifaces) || !Array.isArray(d.pos)) return `設備 ${id} 的資料不完整`;
  }
  for (const c of st.cables) {
    for (const e of [c && c.a, c && c.b]) {
      const d = e && st.devices[e.dev];
      if (!d || !d.ports.some((p) => p.id === e.port)) return '接線資料指向不存在的設備或連接埠';
    }
  }
  if (st.goals && !Array.isArray(st.goals)) return '目標資料不正確';
  return null;
}

export function renderSandbox(app) {
  const lv = app.level, root = app.el.mission;
  const keep = root.querySelector('.m-scroll')?.scrollTop || 0;
  const devs = Object.values(app.state.devices).filter((d) => d.ifaces.length);
  const sbx = (app.sbx ||= { type: 'ping' });
  if (!devs.some((d) => d.id === sbx.from)) sbx.from = devs[0]?.id;
  if (!devs.some((d) => d.id === sbx.to) || sbx.to === sbx.from) sbx.to = (devs.find((d) => d.id !== sbx.from) || {}).id;
  const pick = (key) => {
    const el = h('select', { class: 'inp sel' }, devs.map((d) => h('option', { value: d.id, selected: sbx[key] === d.id, text: d.name })));
    el.addEventListener('change', () => { sbx[key] = el.value; });
    return el;
  };
  if (!TESTS.some((t) => t[0] === sbx.type)) sbx.type = 'ping';
  const type = h('select', { class: 'inp sel' }, TESTS.map(([v, t]) => h('option', { value: v, selected: sbx.type === v, text: t })));
  type.addEventListener('change', () => { sbx.type = type.value; });
  const goals = sandboxObjectives(app.state);
  const addGoal = (expect) => {
    if (!sbx.from || !sbx.to || sbx.from === sbx.to) return toast('先在上面選好來源與目的', 'bad');
    if (sbx.type === 'speed' && !expect) return toast('傳輸速率的目標只有「至少 100 Mbps」，沒有「應該不通」', 'bad');
    (app.state.goals ||= []).push({ ...splitTest(sbx.type), from: sbx.from, to: sbx.to, expect, ...(sbx.type === 'speed' ? { min: 100 } : {}) });
    app.results = [];
    app.changed();
    renderSandbox(app);
  };
  const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => app.sandboxImport(String(rd.result));
    rd.readAsText(f);
    file.value = '';
  });
  const scroll = h('div', { class: 'm-scroll' },
    h('div', { class: 'm-head' }, h('span', { class: 'm-no', text: '∞' }), h('div', null, h('h1', { text: lv.title }), h('p', { text: lv.subtitle }))),
    h('p', { class: 'brief', text: lv.brief }),
    GROUPS.map(([name, models]) => [
      h('h3', { class: 'sec', text: name }),
      h('div', { class: 'chips palette' }, models.map((m) => h('button', {
        type: 'button', class: 'chip btnchip k-' + CATALOG[m].kind, title: `${CATALOG[m].title} — ${CATALOG[m].tagline}`, onclick: () => app.sandboxAdd(m),
      }, icon('plus', 11), shortName(m)))),
    ]),
    h('h3', { class: 'sec', text: '連線測試' }),
    devs.length >= 2
      ? h('div', { class: 'sbx-test' },
        h('label', { class: 'field' }, h('span', { class: 'f-label', text: '從' }), pick('from')),
        h('label', { class: 'field' }, h('span', { class: 'f-label', text: '到' }), pick('to')),
        h('label', { class: 'field' }, h('span', { class: 'f-label', text: '方式' }), type),
        button('測試', { ic: 'play', kind: 'primary', onclick: () => app.sandboxTest(sbx.from, sbx.to, sbx.type) }))
      : h('p', { class: 'tip', text: '桌面上至少要有兩台有網路介面的設備才能測試。' }),
    h('h3', { class: 'sec', text: '自訂目標' }),
    devs.length >= 2 && h('div', { class: 'sbx-row' },
      h('span', { class: 'muted', text: '把上面的測試存成目標：' }),
      button('應該要通', { ic: 'plus', small: true, onclick: () => addGoal(true) }),
      button('應該不通', { ic: 'plus', small: true, onclick: () => addGoal(false) })),
    goals.length
      ? h('div', { class: 'objs' }, goals.map((o, i) => {
        const r = app.results[i];
        const st = r === 'running' ? 'running' : !r ? '' : r.pass ? 'pass' : 'fail';
        const why = st !== 'fail' ? '' : o.expect === false ? '這條連線應該被擋下來，但現在是通的。' : r.reason;
        return h('div', { class: 'goal' },
          h('button', { type: 'button', class: `obj ${st} ${r && r.stale ? 'old' : ''}`, title: '點一下只測試這一項', onclick: () => app.run([i]) },
            h('span', { class: 'st' }, st === 'pass' ? icon('check', 13) : st === 'fail' ? icon('x', 13) : null),
            h('span', { class: 'lb', text: o.label }),
            why && h('span', { class: 'why', text: why })),
          h('button', { class: 'mini danger', type: 'button', title: '移除這個目標', onclick: () => app.sandboxDropGoal(i) }, icon('x', 13)));
      }))
      : h('p', { class: 'tip', text: '還沒有目標。存幾個「應該要通」與「應該不通」的測試，改設定之後就能一鍵驗證。' }),
    h('h3', { class: 'sec', text: '關卡設計' }),
    editorSection(app),
    h('h3', { class: 'sec', text: '儲存與分享' }),
    h('div', { class: 'sbx-row' },
      button('匯出拓撲', { ic: 'download', small: true, onclick: () => app.sandboxExport() }),
      button('匯入拓撲', { ic: 'upload', small: true, onclick: () => file.click() }),
      file),
  );
  root.replaceChildren(scroll, h('div', { class: 'm-foot' },
    goals.length > 0 && button(app.running ? '測試中… 按空白鍵快轉' : `執行全部目標（${goals.length}）`, { ic: app.running ? 'fast' : 'play', kind: 'primary big', onclick: () => (app.running ? app.fastForward() : app.run()) }),
    h('small', { text: `桌面上有 ${Object.keys(app.state.devices).length} 台設備、${app.state.cables.length} 條線 · 按住 Shift 拖曳可移動設備` })));
  scroll.scrollTop = keep;
}

/** 把自由模式需要的動作掛到 app 上 */
export function installSandbox(app, hooks) {
  const after = (sel) => {
    recompute(app.state);
    app.scene.load(app.state, { keep: true });
    app.selected = sel;
    app.scene.select(sel);
    app.changed();
    hooks.renderMission();
    app.renderPanel();
  };
  app.sandboxAdd = (model) => {
    const st = app.state, m = CATALOG[model];
    const id = uniqueId(st, model), n = +id.split('-').pop();
    const name = (m.kind === 'host' ? HOST_NAME[model] : m.kind === 'internet' ? '網際網路' : shortName(model).split(' ')[0]) + '-' + n;
    const taken = Object.values(st.devices).map((d) => d.pos);
    let pos = [0, 0];
    find: for (let r = 0; r < 14; r++) {
      for (let z = -r; z <= r; z++) for (let x = -r; x <= r; x++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== r) continue;
        const p = [x * 6.5, z * 5.5];
        if (!taken.some((t) => Math.hypot(t[0] - p[0], t[1] - p[1]) < 5)) { pos = p; break find; }
      }
    }
    // 伺服器預設就開著常見的服務，才能拿來測 HTTPS / SSH
    const services = SERVER_MODELS.includes(model) ? [{ proto: 'tcp', port: 443, name: 'HTTPS 網站' }, { proto: 'tcp', port: 80, name: 'HTTP 網站' }, { proto: 'tcp', port: 22, name: 'SSH' }] : [];
    const d = makeDevice(model, id, { name, pos, dhcp: m.kind === 'host', services });
    if (m.kind === 'internet') setLine(d, 'line1', { type: 'dhcp', gw: '203.0.113.1', assign: '203.0.113.' + (20 + n) });
    if (isIos(d)) saveStartup(d); // 新設備的 startup-config 是空白的原廠設定
    st.devices[id] = d;
    after(id);
    app.scene.fit(Object.keys(st.devices).length > 1); // 讓新設備一定在畫面裡
    toast(`已加入 ${name}（${m.title}）`, 'ok');
  };
  app.sandboxRemove = (id) => {
    const st = app.state, name = st.devices[id].name;
    st.cables = st.cables.filter((c) => c.a.dev !== id && c.b.dev !== id);
    delete st.devices[id];
    if (st.goals) st.goals = st.goals.filter((g) => g.from !== id && g.to !== id);
    if (st.down) delete st.down[id];
    app.results = [];
    after(null);
    app.scene.fit(true);
    toast(`已刪除 ${name}`);
  };
  app.sandboxTest = (from, to, type) => {
    if (app.running || !from || !to) return;
    if (from === to) return toast('來源和目的是同一台設備', 'bad');
    const st = app.state;
    const t = splitTest(type);
    const r = runObjective(st, { type: t.type, from, to, port: t.port });
    app.showTrace(`${st.devices[from].name} → ${st.devices[to].name}（${(TESTS.find((x) => x[0] === type) || TESTS[0])[1]}）`, r.log, r.hops, { ok: r.ok, reason: r.reason, failDev: r.failDev });
  };
  app.sandboxDropGoal = (n) => {
    const st = app.state;
    const live = (st.goals || []).filter((g) => st.devices[g.from] && st.devices[g.to]);
    st.goals = live.filter((_, i) => i !== n);
    app.results = [];
    app.changed();
    hooks.renderMission();
  };
  app.sandboxExport = () => {
    const data = { app: 'LinkUp', kind: 'sandbox', version: 1, state: cloneState(app.state) };
    saveJson(`linkup-topology-${new Date().toISOString().slice(0, 10)}.json`, data, `已匯出 ${Object.keys(app.state.devices).length} 台設備的拓撲`);
  };
  /** 匯入拓撲：text 是匯出檔的內容。成功回傳 true */
  app.sandboxImport = (text) => {
    if (!app.level.sandbox || app.running) return false;
    let data;
    try { data = JSON.parse(text); } catch { toast('讀不懂這個檔案：它不是 JSON', 'bad'); return false; }
    const bad = checkImport(data);
    if (bad) { toast('無法匯入：' + bad, 'bad', 5000); return false; }
    const st = cloneState(data.state);
    st.leases ||= {}; st.seq ||= 1; st.v6 = true;
    try { recompute(st); } catch { toast('無法匯入：檔案裡的設定資料不完整', 'bad', 5000); return false; }
    for (const d of Object.values(st.devices)) if (isIos(d) && typeof d.startup !== 'string') saveStartup(d);
    app.state = st;
    app.results = [];
    app.cliSess = {};
    after(null);
    app.scene.fit();
    toast(`已匯入 ${Object.keys(st.devices).length} 台設備、${st.cables.length} 條線（可以用 Ctrl + Z 復原）`, 'ok', 4500);
    return true;
  };
  app.sandboxMoved = () => after(app.selected);
}
