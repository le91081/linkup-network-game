// EEM（Embedded Event Manager）：設備上發生某個事件時，自動執行一串 CLI 指令
//
// 設定：d.eem = { 名稱: { event: { t: 'syslog', pattern } | { t: 'track', id, st: 'up' | 'down' | 'any' } | null, actions: [{ id: '1.0', t: 'cli' | 'syslog', v }] } }
//   event manager applet <名稱>
//    event syslog pattern "<正規表示式>"        這台自己寫進紀錄的訊息符合就觸發
//    event track <編號> state up | down | any    追蹤物件改變狀態
//    action <標籤> cli command "<指令>"         從使用者模式開始：第一步通常是 enable
//    action <標籤> syslog msg "<文字>"          寫一筆 %HA_EM-6-LOG
// 執行：事件寫進紀錄時（ops.js 的 logEvent）排進 state.dyn.eemQ；這一次重新計算結束之後照順序執行（sim.js），
//   指令改了設定就再算一次。同一個 applet 在同一輪只跑一次，連鎖最多四層。
// 紀錄：state.dyn.eemHist[設備 id] = [{ at, name, why }]
let runner = null;
/** ios.js 載入時把「在這台設備上執行一串 CLI」的函式交進來（避免互相 import） */
export const setEemRunner = (fn) => { runner = fn; };

/** action 的標籤照字串排序（IOS 也是：10.0 排在 2.0 前面，所以習慣寫 1.0、1.5、2.0 或補零） */
export const eemActions = (a) => (a.actions || []).slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

/** 設備寫了一筆紀錄：看有沒有 applet 在等它 */
export function eemOnLog(state, d, tag, msg) {
  if (!d.eem || !state.dyn || state.dyn.boot) return;
  const text = `%${tag}: ${msg}`;
  for (const [name, a] of Object.entries(d.eem)) {
    const ev = a.event;
    if (!ev || !(a.actions || []).length) continue;
    if (tag === 'HA_EM-6-LOG' && msg.startsWith(name + ':')) continue; // 自己寫的紀錄不會再觸發自己
    let hit = false;
    if (ev.t === 'syslog') { try { hit = new RegExp(ev.pattern).test(text); } catch { hit = text.includes(ev.pattern); } }
    else if (ev.t === 'track' && tag === 'TRACK-6-STATE') { const m = msg.match(/^(\d+) .* -> (Up|Down)$/); hit = !!m && +m[1] === +ev.id && (ev.st === 'any' || ev.st === m[2].toLowerCase()); }
    if (hit) (state.dyn.eemQ ||= []).push({ dev: d.id, name, why: text });
  }
}

/** 執行排隊中的 applet。回傳有沒有執行任何一個（有的話設定可能變了，要再算一次） */
export function eemDrain(state, logEvent) {
  const q = state.dyn.eemQ;
  if (!q || !q.length) return false;
  delete state.dyn.eemQ;
  if (!runner) return false;
  let ran = false;
  const done = new Set(); // 同一個 applet 在這一輪只跑一次
  for (const e of q.slice(0, 8)) {
    const d = state.devices[e.dev], a = d && d.eem && d.eem[e.name];
    if (!a || (state.down || {})[d.id]) continue;
    const H = ((state.dyn.eemHist ||= {})[d.id] ||= []);
    if (done.has(e.dev + '/' + e.name)) continue;
    done.add(e.dev + '/' + e.name);
    const acts = eemActions(a), out = runner(state, d, acts.filter((x) => x.t === 'cli').map((x) => x.v));
    H.push({ at: state.clock, name: e.name, why: e.why, ...(out && out.error ? { error: out.error } : {}) });
    if (H.length > 40) H.shift();
    for (const x of acts) if (x.t === 'syslog') logEvent(state, d, 6, 'HA_EM-6-LOG', `${e.name}: ${x.v}`);
    ran = true;
  }
  return ran;
}

const evText = (ev) => (!ev ? '（還沒有設定 event）' : ev.t === 'syslog' ? `syslog: pattern {${ev.pattern}}` : `track: ${ev.id} state ${ev.st}`);
/** show event manager policy registered */
export function eemPolicyLines(d) {
  const o = ['No.  Class     Type    Event Type          Trap  Time Registered           Name'];
  const names = Object.keys(d.eem || {});
  if (!names.length) return ['（沒有註冊任何 EEM applet：event manager applet <名稱>）'];
  names.forEach((name, k) => {
    const a = d.eem[name];
    o.push(`${String(k + 1).padEnd(5)}applet    user    ${(a.event ? a.event.t : 'none').padEnd(20)}Off   Mon Jan 1 00:00:00 2026  ${name}`, ` ${evText(a.event)}`, ' maxrun 20.000',
      ...eemActions(a).map((x) => ` action ${x.id} ${x.t === 'cli' ? 'cli command' : 'syslog msg'} "${x.v}"`), '');
    if (!a.event) o.push('（這個 applet 沒有 event，永遠不會被觸發）', '');
    else if (a.actions.some((x) => x.t === 'cli') && !/^en(a(b(l(e)?)?)?)?$/i.test((eemActions(a).find((x) => x.t === 'cli') || { v: '' }).v.trim())) o.push('（第一個 cli command 不是 enable：applet 從使用者模式開始，後面的 configure terminal 會失敗）', '');
  });
  return o;
}
/** show event manager history events */
export function eemHistoryLines(state, d, hms) {
  const H = ((state.dyn.eemHist || {})[d.id] || []).slice().reverse();
  if (!H.length) return ['No.  Job Id Proc Status Time of Event            Event Type        Name', '（還沒有任何 applet 被觸發過）'];
  return ['No.  Job Id Proc Status Time of Event            Event Type        Name',
    ...H.flatMap((h, k) => [`${String(k + 1).padEnd(5)}${String(H.length - k).padEnd(7)}Actv ${h.error ? 'fail  ' : 'success'} T+${hms(h.at).padEnd(22)}${((d.eem[h.name] || {}).event || { t: 'none' }).t.padEnd(18)}applet: ${h.name}`,
      `       觸發的事件：${h.why}`, ...(h.error ? [`       （指令失敗：${h.error}）`] : [])])];
}
