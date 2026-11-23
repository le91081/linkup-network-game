// 交換器堆疊（StackWise）：成員與角色、優先權、模擬成員故障、堆疊線、跨成員的 EtherChannel
import { h, button, toast } from './dom.js';
import { inp, note, cardHead, badge, toggle, isNum } from './form.js';
import { stackRoles, ringState, memberOfPort, electActive } from '../engine/stack.js';

const ROLE = { Active: 'on', Standby: 'warn', Member: 'warn', Removed: 'off' };

export function stackTab(ctx, body) {
  const { dev, state } = ctx, S = dev.stack;
  body.append(note('muted', `${S.members.length} 台 Catalyst 9300 用背後的 StackWise-480 堆疊線接成一個環，對外是一台交換器：一份設定、一個 STP 的 bridge。埠名稱的第一個數字是成員編號（Gi2/0/1 在 Switch 2）。Active 負責控制平面，Standby 隨時接手 (SSO)；Active 恢復之後不會搶回。`));
  // 成員
  body.append(h('div', { class: 'card' }, cardHead('成員', ctx.live(() => { const r = stackRoles(state, dev); const up = r.filter((x) => x.role !== 'Removed').length; return badge(up === r.length ? 'on' : 'warn', `${up} / ${r.length} 台 Ready`); })),
    h('div', { class: 'thead c-stk' }, h('span', { text: 'Switch#' }), h('span', { text: '角色' }), h('span', { text: '優先權' }), h('span', { text: '模擬故障' })),
    S.members.map((m) => h('div', { class: 'trow c-stk' },
      h('b', { class: 'mono', text: String(m.num) }),
      ctx.live(() => { const r = stackRoles(state, dev).find((x) => x.num === m.num); return badge(ROLE[r.role], r.role); }),
      inp(ctx, () => String(m.prio || 1), (x) => { m.prio = +x; }, { ph: '1', check: isNum(1, 15) }),
      toggle(ctx, () => !!m.fail, (x) => {
        // 故障的是 Active：Standby 接手，之後 Active 不會被搶回
        const before = stackRoles(state, dev);
        m.fail = x;
        if (x && before.find((r) => r.num === m.num).role === 'Active') { const sb = before.find((r) => r.role === 'Standby'); if (sb) S.active = sb.num; }
        if (!x && !S.members.some((y) => y.num === S.active && !y.fail)) S.active = m.num;
      }, '拔掉電源', { rerender: true }))),
    note('muted', '優先權 1–15（預設 1），數字大的當 Active；一樣就看 MAC 位址小的。改了優先權不會馬上換 Active，要整個堆疊一起重新開機才重新選（CLI：switch 1 priority 15，在特權模式下）。'),
    h('div', { class: 'addrow' }, button('整個堆疊重新開機（重新選 Active）', { ic: 'power', small: true, onclick: () => {
      S.active = electActive(dev);
      toast(`重新選舉：Switch ${S.active} 是 Active（優先權 ${S.members.find((x) => x.num === S.active).prio || 1}）`, 'ok', 3500);
      ctx.commit(true);
    } }))));
  // 堆疊線
  S.cables ||= [true, true];
  body.append(h('div', { class: 'card' }, cardHead('堆疊線 (StackWise-480)', ctx.live(() => { const r = ringState(state, dev); return badge(r.full ? 'on' : r.ok ? 'warn' : 'off', r.full ? 'Full ring' : r.ok ? 'Half ring' : '分裂'); })),
    S.cables.map((c, k) => toggle(ctx, () => S.cables[k] !== false, (x) => { S.cables[k] = x; }, `堆疊線 ${k + 1}（Switch ${k + 1} Port 2 ↔ Switch ${(k + 1) % S.members.length + 1} Port 1）`, { rerender: true })),
    ctx.live(() => note(ringState(state, dev).full ? 'ok' : 'warn', ringState(state, dev).text))));
  // 跨成員的 EtherChannel：Port-channel 的成員埠分散在不同的堆疊成員上，一台壞了另一條照樣通
  const lags = {};
  for (const [pid, pc] of Object.entries(dev.sw.ports)) if (+pc.lag > 0) (lags[+pc.lag] ||= []).push(pid);
  body.append(h('div', { class: 'card' }, cardHead('跨成員的 EtherChannel (Cross-stack)'),
    Object.keys(lags).length ? Object.entries(lags).map(([n, pids]) => {
      const mem = [...new Set(pids.map(memberOfPort))];
      return note(mem.length > 1 ? 'ok' : 'warn', `Port-channel${n}：${pids.join('、')}${mem.length > 1 ? `（分散在 Switch ${mem.join('、')}：一台壞了照樣通）` : `（全部在 Switch ${mem[0]}：這台一壞整條都斷）`}`);
    }) : note('muted', '還沒有 Port-channel。往下接的交換器、伺服器，最好各接一條到不同的成員，再綁成一個 EtherChannel (LACP)：兩條都在用，一台成員壞了也不用等 STP。')));
}
