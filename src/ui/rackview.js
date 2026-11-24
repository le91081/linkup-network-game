// 機櫃立面圖：每個機櫃的前視圖（U1 在最下面），點設備拿起來、點空的 U 裝上去
import { h, icon, button, toast } from './dom.js';
import { modal, closeModal } from './hud.js';
import { CATALOG } from '../engine/model.js';
import { floorPlan } from './floorplan.js';
import {
  rackList, rackSlots, unracked, mountOf, mount, unmount, canMount, addRack, removeRack, autoRack, rackPower, rackIssues, crossRackCables, wattsOf, PDU_W,
} from '../engine/rack.js';

const UH = 15; // 每 U 的高度（px）
const VENDOR = { Cisco: 'v-cisco', Juniper: 'v-juniper', Aruba: 'v-aruba', Fortinet: 'v-forti', Dell: 'v-dell', VMware: 'v-dell', F5: 'v-f5', APC: 'v-apc', 配線架: 'v-patch', MikroTik: 'v-mt', Ubiquiti: 'v-mt', ZTE: 'v-mt', 'TP-Link': 'v-mt', ASUS: 'v-mt', Synology: 'v-dell', Hikvision: 'v-dell', 電信業者: 'v-carrier' };

function leds(state, d) {
  const ports = d.ports.filter((p) => p.media !== 'virt' && p.media !== 'wifi').slice(0, 28);
  const off = (state.down || {})[d.id] || (state.rt && state.rt.off && state.rt.off[d.id]);
  return h('span', { class: 'r-leds' }, ports.map((p) => h('i', { class: !off && state.rt && state.rt.links[d.id + ':' + p.id] ? 'on' : '', title: p.label })));
}

export function openRacks(app, tab = 'rack') {
  const dlg = modal([], { wide: true });
  let band = '5';
  let held = null; // 拿在手上、準備裝上去（或搬動）的設備 id
  const st = () => app.state;
  const commit = (msg) => { app.changed(); if (msg) toast(msg); draw(); };
  const place = (rackId, u) => {
    const d = st().devices[held];
    if (!d) return;
    // 點的那一格當作設備最上面的那一 U，比較符合「從上面往下裝」的直覺；放不下再試著當作最下面
    const m = mountOf(d), top = u - m.ru + 1;
    const at = top >= 1 && !canMount(st(), d, rackId, top) ? top : u;
    const why = mount(st(), d, rackId, at);
    if (why) return toast(why, 'bad');
    held = null;
    commit(`${d.name} 裝在 ${rackList(st()).find((r) => r.id === rackId).name} 的 U${at}${m.ru > 1 ? '–U' + (at + m.ru - 1) : ''}`);
  };

  const rackEl = (r) => {
    const slots = rackSlots(st(), r.id), used = slots.reduce((t, s) => t + s.ru, 0), pw = rackPower(st(), r.id);
    const body = h('div', { class: 'r-body' + (held ? ' holding' : ''), style: { height: r.u * UH + 'px' } });
    for (let u = 1; u <= r.u; u++) {
      body.append(h('div', { class: 'r-u', style: { bottom: (u - 1) * UH + 'px', height: UH + 'px' }, onclick: () => held && place(r.id, u) }, h('span', { class: 'r-no', text: u })));
    }
    for (const s of slots) {
      const c = CATALOG[s.d.model];
      body.append(h('div', {
        class: `r-unit ${VENDOR[c.vendor] || ''}${s.shelf ? ' shelf' : ''}${held === s.d.id ? ' held' : ''}${app.selected === s.d.id ? ' sel' : ''}`,
        style: { bottom: (s.u - 1) * UH + 'px', height: s.ru * UH - 1 + 'px' },
        title: `${s.d.name} · ${c.title} · U${s.u}${s.ru > 1 ? '–U' + s.top : ''}${s.shelf ? '（層板）' : ''} · 約 ${wattsOf(s.d)} W`,
        onclick: (e) => { e.stopPropagation(); held = held === s.d.id ? null : s.d.id; draw(); },
      }, h('b', { text: s.d.name }), s.ru > 1 || !s.shelf ? h('span', { class: 'r-model', text: c.title.replace(/^(Cisco|Juniper|Aruba|Fortinet|Dell|F5|APC|VMware) /, '') }) : null, leds(st(), s.d)));
    }
    return h('div', { class: 'rack' },
      h('div', { class: 'r-head' }, h('b', { text: r.name }), h('span', { class: 'muted mono', text: `${used} / ${r.u}U · ${pw.w} W（PDU ${pw.pct}%）` }),
        !slots.length ? h('button', { type: 'button', class: 'btn ghost icon', title: '拆掉這個空的機櫃', onclick: () => { removeRack(st(), r.id); commit(); } }, icon('trash', 14)) : null),
      h('div', { class: 'r-frame' }, body));
  };

  const side = () => {
    const S = st(), list = unracked(S), d = held && S.devices[held];
    const kids = [];
    if (d) {
      const m = mountOf(d), r = d.rack && rackList(S).find((x) => x.id === d.rack);
      kids.push(h('div', { class: 'card r-held' },
        h('b', { text: `手上：${d.name}` }),
        h('p', { class: 'muted', text: `${CATALOG[d.model].title} · ${m.ru}U${m.shelf ? '（桌上型，連層板）' : ''}${r ? ` · 現在在 ${r.name} 的 U${d.u}` : ''}。點機櫃裡空的那一格裝上去。` }),
        h('div', { class: 'row' },
          r ? button('下架', { kind: 'ghost', onclick: () => { unmount(d); held = null; commit(`${d.name} 下架了`); } }) : null,
          button('在面板裡看', { kind: 'ghost', onclick: () => { closeModal(); app.select(d.id); } }),
          button('放下', { kind: 'ghost', onclick: () => { held = null; draw(); } }))));
    }
    kids.push(h('div', { class: 'card' }, h('b', { text: `還沒上架（${list.length}）` }),
      list.length ? h('div', { class: 'r-chips' }, list.map((x) => h('button', { type: 'button', class: 'chip' + (held === x.id ? ' on' : ''), title: `${CATALOG[x.model].title} · ${mountOf(x).ru}U`, onclick: () => { held = held === x.id ? null : x.id; draw(); } }, `${x.name} · ${mountOf(x).ru}U`)))
        : h('p', { class: 'muted', text: '機架式的設備都裝好了。電腦、AP、電話不會放進機櫃。' })));
    const issues = rackIssues(S), cross = crossRackCables(S);
    kids.push(h('div', { class: 'card' }, h('b', { text: '檢查' }),
      ...issues.map((i) => h('p', { class: 'note ' + i.kind, text: i.text })),
      cross.length ? h('p', { class: 'muted', text: `${cross.length} 條線跨機櫃，要走機櫃上方的線槽（${cross.map((c) => `${S.devices[c.a.dev].name} ↔ ${S.devices[c.b.dev].name}`).slice(0, 4).join('、')}${cross.length > 4 ? '…' : ''}）。` }) : null,
      !issues.length && !cross.length ? h('p', { class: 'muted', text: rackList(S).length ? '沒有問題。' : '還沒有機櫃。' }) : null,
      h('p', { class: 'muted', style: { fontSize: '12px' }, text: `U1 在最下面。重的（UPS）放下面，配線架放在交換器旁邊，跳線最短。一條 16 A 的 PDU 約 ${PDU_W} W，持續負載不要超過 80%。` })));
    return h('div', { class: 'r-side' }, ...kids);
  };

  const seg = () => h('div', { class: 'seg r-seg' }, [['rack', '機櫃立面圖'], ['floor', '樓層平面圖']].map(([k, t]) => h('button', { type: 'button', class: tab === k ? 'on' : '', onclick: () => { tab = k; held = null; draw(); } }, t)));
  const drawFloor = () => {
    const fp = floorPlan(app, { band, onPick: (id) => { closeModal(); app.select(id); } });
    dlg.replaceChildren(
      h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('topo', 30)),
        h('div', null, h('h1', { text: '樓層平面圖' }), h('p', { text: '從正上方看整層樓：牆、設備、線路、機櫃，以及基地台的訊號熱圖（穿牆的衰減照牆的材質算）。' })),
        fp.aps ? h('div', { class: 'seg prog' }, [['5', '5 GHz'], ['2.4', '2.4 GHz'], ['off', '不顯示訊號']].map(([k, t]) => h('button', { type: 'button', class: band === k ? 'on' : '', onclick: () => { band = k; draw(); } }, t))) : null),
      seg(), fp.legend, fp.el, fp.readout);
  };
  function draw() {
    if (tab === 'floor') return drawFloor();
    const S = st();
    dlg.replaceChildren(
      h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, icon('rack', 30)),
        h('div', null, h('h1', { text: '機櫃立面圖' }), h('p', { text: '機架式設備裝在哪個機櫃的第幾 U。只是實體的位置，不會改變網路的行為。' })),
        h('div', { class: 'row prog' },
          Object.assign(button('自動上架', { kind: 'ghost', onclick: () => { const n = autoRack(S); held = null; commit(`裝好了 ${n} 台：配線架與交換器在上面、伺服器在中間、UPS 在最下面`); } }), { disabled: !unracked(S).length }),
          button('新增機櫃', { kind: 'ghost', onclick: () => { const r = addRack(S); commit(`新增了 ${r.name}`); } }))),
      seg(),
      h('div', { class: 'r-wrap' },
        h('div', { class: 'r-racks' }, rackList(S).length ? rackList(S).map(rackEl) : h('p', { class: 'muted', text: '還沒有機櫃：按「自動上架」，或「新增機櫃」再一台一台裝。' })),
        side()));
  }
  draw();
}
