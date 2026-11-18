// 自由模式：自己擺設備、自由接線、任意測試連線
import { h, icon, button, toast } from './dom.js';
import { CATALOG, makeDevice, makeState, setLine, uniqueId } from '../engine/model.js';
import { recompute, runObjective } from '../engine/sim.js';

const VENDOR = /^(Cisco|TP-Link|Ubiquiti|Fortinet|NETGEAR|ASUS|Dell|Lenovo|Apple|HP|Synology) /;
const HOST_NAME = { pc: 'PC', laptop: '筆電', phone: '手機', printer: '印表機', wprinter: '無線印表機', nas: 'NAS', tower: '伺服器', rack1u: '機架伺服器' };
const GROUPS = [
  ['終端設備', ['pc', 'laptop', 'phone', 'printer', 'nas', 'tower', 'rack1u']],
  ['交換器', ['hub4', 'sw5', 'sw8', 'c2960', 'c2960p', 'c9300', 'n93180', 'n9332']],
  ['路由器與防火牆', ['homerouter', 'erx', 'isr4321', 'isr4331', 'fg60f', 'fg100f']],
  ['無線與外部線路', ['ap', 'internet']],
];
const shortName = (model) => (CATALOG[model].kind === 'internet' ? '網際網路 (ISP)' : CATALOG[model].title.replace(VENDOR, ''));

export const SANDBOX = {
  id: 'sandbox', sandbox: true, chapter: 0, title: '自由模式', subtitle: '自己擺設備、自由接線', tags: ['沙盒', '沒有任務目標'],
  brief: '這裡沒有任務。從下方挑設備放到桌面上，自己規劃拓撲、接線、設定，再用連線測試或終端機驗證你的設計。',
  learn: [
    { t: '怎麼開始', d: '在左側點設備的名稱就會放到桌面上。拖曳一台設備到另一台設備上可以接線，點設備可以設定。' },
    { t: '移動、改名與刪除', d: '按住 Shift 再拖曳設備可以移動位置。選取設備後，面板最上方可以直接改名，旁邊的垃圾桶可以刪除。' },
    { t: '測試連線', d: '用左側的「連線測試」選來源與目的，或打開電腦的終端機用 ping、tracert。Cisco 設備有 CLI 分頁可以看等效的指令。' },
  ],
  objectives: [], hints: [], recap: [],
  setup: () => { const s = makeState([]); s.v6 = true; return s; },
};

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
  const type = h('select', { class: 'inp sel' }, [['ping', 'Ping (ICMP)'], ['tcp', 'HTTPS (TCP 443)']].map(([v, t]) => h('option', { value: v, selected: sbx.type === v, text: t })));
  type.addEventListener('change', () => { sbx.type = type.value; });
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
  );
  root.replaceChildren(scroll, h('div', { class: 'm-foot' },
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
    const d = makeDevice(model, id, { name, pos, dhcp: m.kind === 'host' });
    if (m.kind === 'internet') setLine(d, 'line1', { type: 'dhcp', gw: '203.0.113.1', assign: '203.0.113.' + (20 + n) });
    st.devices[id] = d;
    after(id);
    app.scene.fit(Object.keys(st.devices).length > 1); // 讓新設備一定在畫面裡
    toast(`已加入 ${name}（${m.title}）`, 'ok');
  };
  app.sandboxRemove = (id) => {
    const st = app.state, name = st.devices[id].name;
    st.cables = st.cables.filter((c) => c.a.dev !== id && c.b.dev !== id);
    delete st.devices[id];
    after(null);
    app.scene.fit(true);
    toast(`已刪除 ${name}`);
  };
  app.sandboxTest = (from, to, type) => {
    if (app.running || !from || !to) return;
    if (from === to) return toast('來源和目的是同一台設備', 'bad');
    const st = app.state;
    const r = runObjective(st, { type, from, to, port: 443 });
    app.showTrace(`${st.devices[from].name} → ${st.devices[to].name}（${type === 'ping' ? 'Ping' : 'HTTPS'}）`, r.log, r.hops, { ok: r.ok, reason: r.reason, failDev: r.failDev });
  };
  app.sandboxMoved = () => after(app.selected);
}
