// Docker 主機的終端機指令與「Docker」分頁
import { h, button, toast } from './dom.js';
import { inp, sel, field, note, cardHead, badge, del } from './form.js';
import { fmtDur } from '../engine/sim.js';
import { IMAGES, findCtr, addContainer, parsePublish, portsText, imageBase, imagePorts } from '../engine/docker.js';

const pad = (s, n) => String(s).padEnd(n);
/** docker inspect 的 NetworkSettings.Ports：映像檔聽的埠，有發佈的列出主機的位址與埠 */
const portMap = (c) => Object.fromEntries([...new Set([...imagePorts(c.image).map((x) => `${x}/tcp`), ...c.publish.map((p) => `${p.ctr}/${p.proto}`)])].map((k) => {
  const ps = c.publish.filter((p) => `${p.ctr}/${p.proto}` === k);
  return [k, ps.length ? ps.map((p) => ({ HostIp: p.hostIp, HostPort: String(p.host) })) : null];
}));
const ago = (state, t) => `${fmtDur(Math.max(1, (state.clock || 0) - t))}前`;
const statusOf = (state, c) => (c.state === 'running' ? `Up ${fmtDur(Math.max(1, (state.clock || 0) - (c.started ?? c.created)))}` : `Exited (${c.exit ?? 0}) ${fmtDur(Math.max(1, (state.clock || 0) - (c.stopped ?? c.created)))}前`);

/** docker …：回傳 true 表示有處理（設定有變就呼叫 commit） */
export function dockerCmd(app, dev, args, print, commit) {
  const st = app.state, sub = args[0];
  const ctrs = (dev.docker ||= { containers: [] }).containers;
  if (!sub || sub === '--help') { print('Usage:  docker COMMAND'); print('常用：ps [-a]、run -d --name <名稱> -p [位址:]主機埠:容器埠 <映像檔>、stop / start / restart / rm [-f] <容器>、port <容器>、logs <容器>、images', 'dim'); return; }
  if (sub === 'ps') {
    const all = args.includes('-a') || args.includes('--all');
    print(pad('CONTAINER ID', 15) + pad('IMAGE', 26) + pad('COMMAND', 24) + pad('CREATED', 16) + pad('STATUS', 22) + pad('PORTS', 34) + 'NAMES', 'pre');
    for (const c of ctrs.filter((x) => all || x.state === 'running')) print(pad(c.id.slice(0, 12), 15) + pad(c.image, 26) + pad((IMAGES[imageBase(c.image)] || {}).cmd || '""', 24) + pad(ago(st, c.created), 16) + pad(statusOf(st, c), 22) + pad(portsText(c), 34) + c.name, 'pre');
    if (!all && ctrs.some((x) => x.state !== 'running')) print('（還有停止的容器：docker ps -a）', 'hint');
    return;
  }
  if (sub === 'images') {
    print(pad('REPOSITORY', 26) + pad('TAG', 10) + pad('IMAGE ID', 15) + 'SIZE', 'pre');
    for (const img of [...new Set(ctrs.map((c) => imageBase(c.image)))]) print(pad(img, 26) + pad('latest', 10) + pad((img.length * 2654435761 >>> 0).toString(16).slice(0, 12), 15) + '187MB', 'pre');
    return;
  }
  if (sub === 'run') {
    const o = { publish: [] };
    let image = null;
    for (let k = 1; k < args.length; k++) {
      const a = args[k];
      if (a === '-d' || a === '--detach' || a === '-it' || a === '--rm') continue;
      if (a === '--name') { o.name = args[++k]; continue; }
      if (a.startsWith('--name=')) { o.name = a.slice(7); continue; }
      if (a === '-p' || a === '--publish') { const p = parsePublish(args[++k]); if (!p) { print(`docker: invalid publish spec: ${args[k]}（寫法：-p 8080:80、-p 127.0.0.1:3000:3000）`, 'bad'); return; } o.publish.push(p); continue; }
      if (a === '--restart' || a === '-e' || a === '-v' || a === '--network') { k++; continue; }
      if (!a.startsWith('-')) { image = a; break; }
    }
    if (!image) { print('"docker run" requires at least 1 argument.', 'bad'); return; }
    const r = addContainer(st, dev, { name: o.name, image, publish: o.publish });
    if (r.err) { r.err.split('\n').forEach((l) => print(l, 'bad')); return; }
    r.ctr.started = st.clock;
    print(r.ctr.id + 'f2b19c0e5d71a8c4e3b2a19d07c6f5e4b3a2918d07c6f5e', 'ok');
    commit();
    return;
  }
  // 容器的名稱：跳過 -f / --format 後面接的格式字串
  const fi = sub === 'inspect' ? args.findIndex((x) => x === '-f' || x === '--format') : -1; // docker rm -f 的 -f 是強制
  const fmt = fi > 0 ? args[fi + 1] || '' : '';
  const ref = args.slice(1).filter((x, k) => !x.startsWith('-') && !(fi > 0 && k + 1 === fi + 1))[0];
  const c = ref ? findCtr(dev, ref) : null;
  if (['stop', 'start', 'restart', 'rm', 'port', 'logs', 'inspect'].includes(sub) && !c) { print(`Error response from daemon: No such container: ${ref || ''}`, 'bad'); return; }
  if (sub === 'stop') { if (c.state === 'running') Object.assign(c, { state: 'exited', exit: 0, stopped: st.clock }); print(c.name); commit(); return; }
  if (sub === 'start' || sub === 'restart') {
    const clash = c.publish.find((p) => ctrs.some((x) => x !== c && x.state === 'running' && x.publish.some((q) => q.host === p.host && q.proto === p.proto)));
    if (clash) { print(`Error response from daemon: driver failed programming external connectivity on endpoint ${c.name}: Bind for ${clash.hostIp}:${clash.host} failed: port is already allocated`, 'bad'); return; }
    Object.assign(c, { state: 'running', started: st.clock });
    print(c.name); commit(); return;
  }
  if (sub === 'rm') {
    if (c.state === 'running' && !args.includes('-f') && !args.includes('--force')) { print(`Error response from daemon: You cannot remove a running container ${c.id}. Stop the container before attempting removal or force remove`, 'bad'); return; }
    dev.docker.containers = ctrs.filter((x) => x !== c);
    print(c.name); commit(); return;
  }
  if (sub === 'port') { if (!c.publish.length) print('（這個容器沒有發佈任何連接埠：外面連不到它）', 'hint'); for (const p of c.publish) print(`${p.ctr}/${p.proto} -> ${p.hostIp}:${p.host}`); return; }
  if (sub === 'logs') {
    const img = imageBase(c.image);
    const lines = img === 'nginx' ? ['/docker-entrypoint.sh: Configuration complete; ready for start up', `${c.started ? '' : ''}2026/01/05 01:00:00 [notice] 1#1: nginx/1.27.3`, '2026/01/05 01:00:00 [notice] 1#1: start worker processes']
      : img === 'grafana/grafana' ? ['logger=http.server t=2026-01-05T01:00:01Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http']
        : img === 'mysql' ? ['[System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. port: 3306'] : [`${img} started, listening on ${imagePorts(c.image).join(', ')}`];
    lines.forEach((l) => print(l, 'pre'));
    return;
  }
  if (sub === 'inspect') {
    if (fmt) { print(/IPAddress/.test(fmt) ? c.ip : /Status/.test(fmt) ? c.state : /Ports/.test(fmt) ? JSON.stringify(portMap(c)) : '<no value>', 'pre'); return; }
    const j = [{
      Id: c.id + 'f2b19c0e5d71a8c4e3b2a19d07c6f5e4b3a2918d07c6f5e', Name: '/' + c.name,
      State: { Status: c.state, Running: c.state === 'running', ExitCode: c.state === 'running' ? 0 : c.exit ?? 0 },
      Config: { Image: c.image, ExposedPorts: Object.fromEntries(imagePorts(c.image).map((x) => [`${x}/tcp`, {}])) },
      HostConfig: { PortBindings: Object.fromEntries(c.publish.map((p) => [`${p.ctr}/${p.proto}`, [{ HostIp: p.hostIp === '0.0.0.0' ? '' : p.hostIp, HostPort: String(p.host) }]])) },
      NetworkSettings: { Ports: c.state === 'running' ? portMap(c) : {}, Networks: { bridge: c.state === 'running' ? { Gateway: '172.17.0.1', IPAddress: c.ip, IPPrefixLen: 16 } : { Gateway: '', IPAddress: '', IPPrefixLen: 0 } } },
    }];
    JSON.stringify(j, null, 4).split('\n').forEach((l) => print(l, 'pre'));
    return;
  }
  if (sub === 'network' && args[1] === 'ls') { print('NETWORK ID     NAME      DRIVER    SCOPE', 'pre'); print('3f1a2b9c8d7e   bridge    bridge    local', 'pre'); print('9e8d7c6b5a41   host      host      local', 'pre'); print('1a2b3c4d5e6f   none      null      local', 'pre'); return; }
  print(`docker: '${sub}' is not a docker command.（這個模擬支援 ps、run、stop、start、restart、rm、port、logs、images、network ls）`, 'warn');
}

/** 「Docker」分頁：容器清單、新增容器 */
export function dockerTab(ctx, body) {
  const { dev, state, app } = ctx;
  const ctrs = (dev.docker ||= { containers: [] }).containers;
  const draft = (app.dockerDraft ||= { name: '', image: 'nginx', bind: '0.0.0.0', host: '', ctr: '' });
  body.append(note('muted', '容器接在主機裡的橋接網路（172.17.0.0/16），外面看不到。要讓別台連得到，就要把主機的一個埠「發佈」給容器的埠（docker run -p 主機埠:容器埠）。只綁在 127.0.0.1 的話，只有主機自己連得到。'));
  body.append(h('div', { class: 'card' }, cardHead(`容器（${ctrs.length}）`),
    ctrs.length ? ctrs.map((c) => h('div', { class: 'ctr-row' },
      h('div', { class: 'ctr-top' }, h('b', { class: 'mono', text: c.name }), h('span', { class: 'muted mono', text: c.image }), badge(c.state === 'running' ? 'on' : 'warn', c.state === 'running' ? '執行中' : '已停止'),
        button(c.state === 'running' ? '停止' : '啟動', { small: true, onclick: () => {
          if (c.state === 'running') Object.assign(c, { state: 'exited', exit: 0, stopped: state.clock });
          else {
            // 和 docker start 一樣：主機的埠已經被別的容器佔走就起不來
            const clash = c.publish.find((p) => ctrs.some((x) => x !== c && x.state === 'running' && x.publish.some((q) => q.host === p.host && q.proto === p.proto)));
            if (clash) return toast(`Bind for ${clash.hostIp}:${clash.host} failed: port is already allocated（主機的 ${clash.host} 已經發佈給別的容器）`, 'bad', 6000);
            Object.assign(c, { state: 'running', started: state.clock });
          }
          ctx.commit(true);
          return undefined;
        } }),
        del(() => { dev.docker.containers = ctrs.filter((x) => x !== c); ctx.commit(true); }, '刪除容器（docker rm -f）')),
      h('div', { class: 'mono muted ctr-ports', text: `${c.ip} · ${c.publish.length ? c.publish.map((p) => `${p.hostIp}:${p.host} → ${p.ctr}/${p.proto}`).join('、') : '沒有發佈連接埠'} · 映像檔聽 ${imagePorts(c.image).join('、') || '—'}` })))
      : note('muted', '還沒有容器。'),
    h('div', { class: 'acl-h' }, h('span', { text: '新增容器（docker run -d）' }), h('em', { text: '同一個名稱要先刪掉舊的' })),
    h('div', { class: 'ctr-new' },
      field('名稱', inp({ commit() {} }, () => draft.name, (v) => { draft.name = v.trim(); }, { ph: 'web' })),
      field('映像檔', sel({ commit() {} }, () => draft.image, (v) => { draft.image = v; }, Object.entries(IMAGES).map(([k, x]) => [k, `${k} — ${x.desc}`]))),
      field('綁定位址', sel({ commit() {} }, () => draft.bind, (v) => { draft.bind = v; }, [['0.0.0.0', '0.0.0.0（所有介面）'], ['127.0.0.1', '127.0.0.1（只有主機自己）']])),
      field('主機埠 : 容器埠', h('div', { class: 'addrow' },
        inp({ commit() {} }, () => draft.host, (v) => { draft.host = v.trim(); }, { ph: '8080', w: '5em' }), h('span', { text: ':' }),
        inp({ commit() {} }, () => draft.ctr, (v) => { draft.ctr = v.trim(); }, { ph: '80', w: '5em' })))),
    h('div', { class: 'addrow' }, button('建立並啟動', { ic: 'play', small: true, onclick: () => {
      const publish = draft.host || draft.ctr ? [parsePublish(`${draft.bind}:${draft.host}:${draft.ctr}`)] : [];
      if (publish.some((p) => !p)) return toast('連接埠要填數字，例如 8080 : 80', 'bad');
      const r = addContainer(state, dev, { name: draft.name || undefined, image: draft.image, publish });
      if (r.err) return toast(r.err.split('\n').pop(), 'bad', 6000);
      r.ctr.started = state.clock;
      toast(`已建立容器 ${r.ctr.name}`, 'ok');
      ctx.commit(true);
      return undefined;
    } }))));
}
