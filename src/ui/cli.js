// IOS 風格的 CLI：用 show 指令查看狀態；configure terminal 之後可以直接用指令修改設定
import { h } from './dom.js';
import { fmtIp, parseIp } from '../engine/ip.js';
import { fmtIp6 } from '../engine/ip6.js';
import { transact, routeRows, macsBehind, isBridgePort, arpRows, clearArp, sessionLog, hitsOf, fmtDur, portfastOn } from '../engine/sim.js';
import { route6Rows } from '../engine/sim6.js';
import { CATALOG, MEDIA, peerOf, portOf, linkInfo, phyConfig } from '../engine/model.js';
import { iosSession, runningConfig, startupConfig, hostName as host, aclName, aclLine } from '../engine/ios.js';

const pad = (s, n) => String(s).padEnd(n);
const isSw = (d) => !!d.sw && d.sw.mode === 'vlan';
const dotMac = (m) => m.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');

const SHOW = {
  'show running-config': (st, d) => runningConfig(st, d),
  'show startup-config': (st, d) => {
    const c = startupConfig(st, d);
    return c ? c.filter((l) => l !== 'Building configuration...') : ['startup-config is not present'];
  },
  'show version': (st, d) => [`${CATALOG[d.model].title}`, `${host(d)} uptime is 3 days, 4 hours`, '（LinkUp 模擬的 IOS 風格介面）'],
  'show ip interface brief': (st, d) => {
    const o = [pad('Interface', 22) + pad('IP-Address', 17) + pad('Method', 8) + pad('Status', 22) + 'Protocol'];
    for (const i of d.ifaces) {
      if (!i.rt || i.rt.active === false) continue;
      const pc = d.sw && i.bind.port && d.sw.ports[i.bind.port];
      const adm = (pc && pc.shut) || i.shut;
      o.push(pad(i.bind.t === 'svi' ? 'Vlan' + i.bind.vlan : i.label, 22) + pad(i.rt.ip != null ? fmtIp(i.rt.ip) : 'unassigned', 17)
        + pad(i.mode === 'static' ? 'manual' : i.mode.toUpperCase(), 8) + pad(adm ? 'administratively down' : i.rt.link ? 'up' : 'down', 22) + (i.rt.link ? 'up' : 'down'));
    }
    if (isSw(d)) {
      for (const p of d.ports) {
        if (!isBridgePort(d, p.id)) continue;
        const up = !!st.rt.links[d.id + ':' + p.id];
        if (!up && !d.sw.ports[p.id].shut) continue;
        o.push(pad(p.label, 22) + pad('unassigned', 17) + pad('unset', 8) + pad(d.sw.ports[p.id].shut ? 'administratively down' : 'up', 22) + (up ? 'up' : 'down'));
      }
    }
    return o;
  },
  'show ip route': (st, d) => {
    if (!d.routing) return ['% 這台設備沒有啟用 IP 路由（L2 交換器）'];
    const rows = routeRows(d);
    if (!rows.length) return ['路由表是空的'];
    const o = ['Codes: C - connected, S - static, O - OSPF, * - candidate default', ''];
    for (const r of rows) {
      const code = (r.type === 'D' ? 'S' : r.type) + (r.dst.startsWith('0.0.0.0') ? '*' : ' ');
      const dst = r.dst.replace('（預設）', '');
      o.push(r.via === '直連' ? `${code}    ${dst} is directly connected, ${r.iface}` : `${code}    ${dst} [${r.ad}/${r.metric}] via ${r.via}, ${r.iface}${r.bad ? '   (inactive)' : ''}`);
    }
    return o;
  },
  'show ipv6 route': (st, d) => {
    const rows = route6Rows(d);
    return rows.length ? rows.map((r) => (r.via === '直連' ? `C   ${r.dst}\n     via ${r.iface}, directly connected` : `S   ${r.dst.replace('（預設）', '')}\n     via ${r.via}${r.bad ? '  (inactive)' : ''}`)).join('\n').split('\n') : ['IPv6 路由表是空的'];
  },
  'show ipv6 interface brief': (st, d) => {
    const o = d.ifaces.filter((i) => i.rt && i.rt.v6 && i.rt.v6.ll != null)
      .flatMap((i) => [`${pad(i.label, 24)}[up/up]`, '    ' + fmtIp6(i.rt.v6.ll), ...i.rt.v6.addrs.map((a) => '    ' + fmtIp6(a.ip))]);
    return o.length ? o : ['沒有任何介面啟用 IPv6'];
  },
  'show vlan brief': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const o = [pad('VLAN', 6) + pad('Name', 18) + pad('Status', 10) + 'Ports', '---- ' + '-'.repeat(17) + ' --------- ' + '-'.repeat(30)];
    for (const v of d.sw.vlans.slice().sort((a, b) => a.id - b.id)) {
      const ports = d.ports.filter((p) => d.sw.ports[p.id].mode === 'access' && d.sw.ports[p.id].vlan === v.id).map((p) => p.label);
      o.push(pad(v.id, 6) + pad(v.name.slice(0, 16), 18) + pad('active', 10) + ports.slice(0, 6).join(', ') + (ports.length > 6 ? ', ...' : ''));
    }
    return o;
  },
  'show interfaces trunk': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const tr = d.ports.filter((p) => d.sw.ports[p.id].mode === 'trunk');
    if (!tr.length) return ['沒有任何 Trunk 埠'];
    const o = [pad('Port', 14) + pad('Mode', 8) + pad('Encapsulation', 15) + pad('Status', 12) + 'Native vlan'];
    for (const p of tr) o.push(pad(p.label, 14) + pad('on', 8) + pad('802.1q', 15) + pad(st.rt.links[d.id + ':' + p.id] ? 'trunking' : 'not-connect', 12) + d.sw.ports[p.id].native);
    o.push('', pad('Port', 14) + 'Vlans allowed on trunk');
    for (const p of tr) o.push(pad(p.label, 14) + (d.sw.ports[p.id].allowed === 'all' ? '1-4094' : d.sw.ports[p.id].allowed));
    return o;
  },
  'show mac address-table': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const o = [pad('Vlan', 6) + pad('Mac Address', 18) + pad('Type', 10) + 'Ports', '----  ' + '-'.repeat(14) + '    --------  -----'];
    for (const p of d.ports) {
      if (!isBridgePort(d, p.id) || !st.rt.links[d.id + ':' + p.id]) continue;
      const pc = d.sw.ports[p.id];
      for (const m of macsBehind(st, d, p.id)) o.push(pad(pc.mode === 'trunk' ? pc.native : pc.vlan, 6) + pad(m.mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.'), 18) + pad('DYNAMIC', 10) + p.label);
    }
    return o.length > 2 ? o : ['MAC 位址表是空的'];
  },
  'show spanning-tree': (st, d) => {
    const s = d.rt.stp;
    if (!isSw(d) || !s) return ['% 這個指令只適用於交換器'];
    if (!s.on) return ['No spanning tree instance exists.（STP 已關閉）'];
    const o = [];
    const vl = Object.keys(s.root).length ? Object.keys(s.root) : ['1'];
    for (const v of vl) {
      const root = st.devices[s.root[v] || d.id];
      o.push(`VLAN${String(v).padStart(4, '0')}`, '  Spanning tree enabled protocol rstp',
        `  Root ID    Priority    ${root.rt.stp.prio}`, `             Address     ${root.rt.stp.mac}`, ...(root === d ? ['             This bridge is the root'] : []),
        `  Bridge ID  Priority    ${s.prio}`, `             Address     ${s.mac}`, '', pad('Interface', 16) + pad('Role', 6) + pad('Sts', 5) + 'Type');
      for (const [pid, roles] of Object.entries(s.roles)) {
        const r = roles[v];
        if (r) o.push(pad(pid, 16) + pad({ root: 'Root', desg: 'Desg', altn: 'Altn' }[r], 6) + pad(r === 'altn' ? 'BLK' : stpState(d, pid), 5) + 'P2p');
      }
      // 接終端設備的埠：一律是 Designated；還沒走完 listening / learning 的會顯示 LSN / LRN
      for (const p of d.ports) {
        const pc = d.sw.ports[p.id];
        if (!st.rt.links[d.id + ':' + p.id] || pc.mode === 'routed' || (s.roles[p.id] && s.roles[p.id][v])) continue;
        if (pc.mode === 'access' && pc.vlan !== +v) continue;
        o.push(pad(p.label, 16) + pad('Desg', 6) + pad(stpState(d, p.id), 5) + (portfastOn(d, pc) ? 'P2p Edge' : 'P2p'));
      }
      o.push('');
    }
    return o;
  },
  'show etherchannel summary': (st, d) => {
    const e = Object.entries(d.rt.lag || {});
    if (!e.length) return ['沒有設定任何 Port-channel'];
    const by = {};
    for (const [pid, l] of e) (by[l.id] ||= []).push(`${pid}(${l.state === 'bundled' ? 'P' : l.state === 'suspended' ? 's' : 'D'})`);
    return ['Flags:  P - bundled in port-channel   s - suspended   D - down', '', pad('Group', 7) + pad('Port-channel', 14) + pad('Protocol', 10) + 'Ports',
      ...Object.entries(by).map(([id, ps]) => pad(id, 7) + pad(`Po${id}(S${ps.some((x) => x.endsWith('(P)')) ? 'U' : 'D'})`, 14) + pad('LACP', 10) + ps.join(' '))];
  },
  'show port-security': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const ps = d.ports.filter((p) => d.sw.ports[p.id].ps && d.sw.ports[p.id].ps.on);
    if (!ps.length) return ['沒有任何連接埠啟用 Port Security'];
    return [pad('Secure Port', 14) + pad('MaxSecureAddr', 15) + pad('CurrentAddr', 13) + 'Security Action',
      ...ps.map((p) => {
        const c = d.sw.ports[p.id].ps, n = String(c.macs || '').split(/[,\s]+/).filter(Boolean).length;
        return pad(p.label, 14) + pad(Math.max(1, n), 15) + pad(n, 13) + (c.mode === 'shutdown' ? 'Shutdown' : 'Restrict') + (d.rt.err[p.id] ? '   (err-disabled)' : '');
      })];
  },
  'show cdp neighbors': (st, d) => {
    const o = [pad('Device ID', 20) + pad('Local Intrfce', 16) + pad('Platform', 26) + 'Port ID'];
    for (const p of d.ports) {
      const n = peerOf(st, d.id, p.id);
      if (!n || st.rt.cable[n.cable] === 'down') continue;
      const x = st.devices[n.dev];
      o.push(pad(host(x).slice(0, 18), 20) + pad(p.label, 16) + pad(CATALOG[x.model].title.replace(/^Cisco /, '').slice(0, 24), 26) + portOf(x, n.port).label);
    }
    return o.length > 1 ? o : ['沒有任何鄰居'];
  },
  'show ip ospf neighbor': (st, d) => {
    const n = d.rt.nbrs || [];
    if (!n.length) return ['沒有 OSPF 鄰居'];
    const two = (v) => String(Math.max(0, Math.ceil(v))).padStart(2, '0');
    return [pad('Neighbor ID', 18) + pad('State', 14) + pad('Dead Time', 11) + pad('Address', 17) + 'Interface',
      ...n.map((x) => pad(host(st.devices[x.dev]).slice(0, 16), 18) + pad(x.state === 'forming' ? '2WAY/DROTHER' : 'FULL/ -', 14)
        + pad('00:00:' + two(x.state === 'dying' ? x.left : x.state === 'forming' ? 40 - ((40 - x.left) % 10) : x.dead), 11) + pad(fmtIp(x.ip), 17) + (d.ifaces.find((i) => i.id === x.iface) || {}).label)];
  },
  'show ip dhcp binding': (st, d) => {
    const o = [pad('IP address', 18) + pad('Client', 22) + pad('Lease expiration', 20) + 'Type'];
    for (const [key, tbl] of Object.entries(st.leases)) {
      if (!key.startsWith(d.id + '/')) continue;
      const hold = (st.dyn.hold || {})[key] || {};
      for (const [c, ip] of Object.entries(tbl)) o.push(pad(fmtIp(ip), 18) + pad(st.devices[c.split('/')[0]].name, 22) + pad(hold[c] ? fmtDur(hold[c].exp - st.clock) + '後' : '-', 20) + 'Automatic');
    }
    return o.length > 1 ? o : ['沒有任何租約'];
  },
  'show ip dhcp conflict': (st, d) => {
    const hit = Object.entries(st.rt.dhcpConflict || {}).filter(([k]) => k.startsWith(d.id + '/')).flatMap(([, v]) => v);
    return hit.length ? [pad('IP address', 18) + pad('Detection method', 19) + 'Detection time', ...hit.map((ip) => pad(fmtIp(ip), 18) + pad('Ping', 19) + 'now')] : ['沒有偵測到位址衝突'];
  },
  'show clock': (st, d) => {
    // 沒有對時的設備，時鐘是從開機算起的預設時間（前面有 *），各設備的紀錄就對不起來
    const ntp = d.mgmt && parseIp(d.mgmt.ntp || '');
    const synced = ntp != null && transact(st, d.id, { proto: 'icmp', dst: ntp, quiet: true }).ok;
    const t = new Date(Date.UTC(synced ? 2026 : 1993, synced ? 10 : 2, synced ? 18 : 1, synced ? 8 : 0, 0, 0) + Math.floor(st.clock || 0) * 1000);
    const two = (n) => String(n).padStart(2, '0');
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()], mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()];
    return [`${synced ? '' : '*'}${two(t.getUTCHours())}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())}.000 UTC ${day} ${mon} ${t.getUTCDate()} ${t.getUTCFullYear()}`,
      synced ? `Time source is NTP (${fmtIp(ntp)})` : ntp != null ? `No time source（連不到 NTP 伺服器 ${fmtIp(ntp)}）` : 'No time source（沒有設定 NTP：ntp server <IP>）'];
  },
  'show access-lists': (st, d) => {
    const o = [];
    for (const i of d.ifaces) for (const [key, dir] of [['aclIn', 'in'], ['aclOut', 'out']]) {
      if (!i[key] || !i[key].length) continue;
      o.push(`Extended IP access list ${aclName(i, dir)}`);
      i[key].forEach((r, n) => o.push(`    ${(n + 1) * 10} ${aclLine(r)}${hitsOf(r) ? ` (${hitsOf(r)} matches)` : ''}`));
    }
    return o.length ? o : ['沒有設定任何 ACL'];
  },
  'show arp': (st, d) => {
    const o = [pad('Protocol', 10) + pad('Address', 18) + pad('Age (min)', 11) + pad('Hardware Addr', 17) + 'Type'];
    for (const i of d.ifaces) if (i.rt && i.rt.ip != null) o.push(pad('Internet', 10) + pad(fmtIp(i.rt.ip), 18) + pad('-', 11) + pad(dotMac(i.rt.mac), 17) + 'ARPA');
    for (const r of arpRows(st, d)) o.push(pad('Internet', 10) + pad(fmtIp(r.ip), 18) + pad(Math.floor(r.age / 60), 11) + pad(dotMac(r.mac), 17) + 'ARPA');
    return o;
  },
  'show ip nat translations': (st, d) => {
    const rows = sessionLog(d).filter((e) => e.act === 'snat' || e.act === 'dnat');
    if (!rows.length) return ['目前沒有任何 NAT 轉換（先讓流量經過這台設備，例如從內部的電腦 ping 外面）'];
    const o = [pad('Pro', 6) + pad('Inside global', 23) + pad('Inside local', 23) + 'Outside global'];
    for (const e of rows) {
      const out = e.proto === 'icmp' ? e.sport : e.dport; // ICMP 沒有埠號，IOS 會顯示識別碼
      if (e.act === 'snat') o.push(pad(e.proto, 6) + pad(`${fmtIp(e.nsrc)}:${e.sport}`, 23) + pad(`${fmtIp(e.src)}:${e.sport}`, 23) + `${fmtIp(e.dst)}:${out}`);
      else o.push(pad(e.proto, 6) + pad(`${fmtIp(e.dst)}:${e.dport}`, 23) + pad(`${fmtIp(e.ndst)}:${e.ndport}`, 23) + `${fmtIp(e.src)}:${e.sport}`);
    }
    return o;
  },
  'show interfaces status': (st, d) => {
    const o = [pad('Port', 14) + pad('Status', 14) + pad('Vlan', 8) + pad('Duplex', 9) + pad('Speed', 9) + 'Type'];
    for (const p of d.ports) {
      const pc = d.sw && d.sw.ports[p.id];
      const up = !!st.rt.links[d.id + ':' + p.id];
      const li = up && linkInfo(st, d.id, p.id);
      const status = pc && pc.shut ? 'disabled' : d.rt.err[p.id] ? 'err-disabled' : up ? 'connected' : 'notconnect';
      const vlan = !pc || pc.mode === 'routed' ? 'routed' : pc.mode === 'trunk' ? 'trunk' : pc.vlan;
      // 前面有 a- 的是自動協商出來的結果，沒有的是手動寫死的設定
      const cfg = phyConfig(d, p.id);
      const dup = cfg.duplex || (li ? 'a-' + li.duplex : 'auto'), spd = cfg.speed != null ? String(cfg.speed) : li ? 'a-' + li.speed : 'auto';
      o.push(pad(p.label, 14) + pad(status, 14) + pad(vlan, 8) + pad(dup, 9) + pad(spd, 9) + MEDIA[p.media].name);
    }
    return o;
  },
  'show vrrp brief': (st, d) => {
    const v = d.ifaces.filter((i) => i.vrrp && i.vrrp.on);
    if (!v.length) return ['沒有設定 VRRP'];
    return [pad('Interface', 16) + pad('Grp', 5) + pad('Pri', 5) + pad('State', 9) + 'Group addr',
      ...v.map((i) => pad(i.label, 16) + pad(1, 5) + pad(i.vrrp.prio || 100, 5) + pad(i.rt.vrrp ? { master: 'Master', backup: 'Backup', init: 'Init' }[i.rt.vrrp.state] : 'Init', 9) + (i.vrrp.vip || '')
        + (i.rt.vrrp && i.rt.vrrp.wait > 0 ? `   (Master down，${Math.ceil(i.rt.vrrp.wait)} 秒後接手)` : ''))];
  },
};
const stpState = (d, pid) => (d.rt.wait && d.rt.wait[pid] > 15 ? 'LSN' : d.rt.wait && d.rt.wait[pid] > 0 ? 'LRN' : 'FWD');
const CMDS = Object.keys(SHOW);
const match = (tokens, cmd) => {
  const w = cmd.split(' ');
  return tokens.length === w.length && tokens.every((t, i) => w[i].startsWith(t));
};

export function buildCli(ctx, body) {
  const { app, dev } = ctx;
  const sess = ((app.cliSess ||= {})[dev.id] ||= iosSession(() => app.state.devices[dev.id] || dev, () => app.state));
  const logs = (app.termLog['cli:' + dev.id] ||= [{
    t: 'IOS 風格的 CLI。用 show 指令查看狀態；輸入 configure terminal 進入設定模式後可以直接下指令修改設定（和其他分頁改的是同一份設定）。輸入 ? 查看目前可用的指令，按 Tab 可以補齊。', c: 'dim',
  }]);
  const hist = (app.termHist['cli:' + dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'configure terminal' });
  const promptEl = h('span', { class: 'prompt', text: sess.prompt() });
  const draw = () => {
    out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || ' ' })));
    out.scrollTop = out.scrollHeight;
    promptEl.textContent = sess.prompt();
  };
  const print = (t, c) => logs.push({ t, c });

  /** show 與 ping：回傳 false 表示不是這兩種指令 */
  const showOrPing = (line) => {
    const tok = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const st = app.state, d = st.devices[dev.id] || dev;
    if (!tok.length) return true;
    if ('ping'.startsWith(tok[0]) && tok[0].length >= 2) {
      const ip = parseIp(tok[1] || '');
      if (ip == null) print('% 用法：ping <IPv4 位址>', 'warn');
      else if (!d.ifaces.some((i) => i.rt && i.rt.ip != null)) print('% 這台設備沒有任何 IP 位址，無法送出封包', 'warn');
      else {
        const r = transact(st, d.id, { proto: 'icmp', dst: ip });
        app.showTrace(`${d.name}# ${line}`, r.log, r.hops, r);
        print(`Sending 5, 100-byte ICMP Echos to ${fmtIp(ip)}, timeout is 2 seconds:`);
        print(r.ok ? '!!!!!' : '.....', r.ok ? 'ok' : 'bad');
        print(`Success rate is ${r.ok ? 100 : 0} percent (${r.ok ? 5 : 0}/5)`);
        if (!r.ok) print('  ↳ ' + r.reason, 'hint');
      }
      return true;
    }
    if (tok[tok.length - 1] === '?' && 'show'.startsWith(tok[0])) { CMDS.forEach((c) => print('  ' + c, 'dim')); return true; }
    if (tok[0] === 'clear' && (tok[1] || '').startsWith('arp')) { clearArp(st, d); app.refreshLive(); return true; }
    const cmd = CMDS.find((c) => match(tok, c));
    if (!cmd) return false;
    SHOW[cmd](st, d).forEach((l) => print(l, 'pre')); // 表格不折行，太寬時左右捲動
    return true;
  };

  const run = (line) => {
    print(sess.prompt() + ' ' + line, 'cmd');
    const text = line.trim(), low = text.toLowerCase();
    const before = (app.state.devices[dev.id] || dev).name;
    let renamed = false;
    if (text.length > 1 && text.endsWith('?')) {
      // 指令打到一半加上 ?：列出接下來可以輸入的字
      const r = sess.complete(text.slice(0, -1), CMDS);
      print(r.options.length ? '  ' + r.options.join('   ') : '  （沒有符合的指令，或接下來要輸入的是數值 / 位址）', 'dim');
    } else if (low === '?' || low === 'help') {
      print(sess.mode === 'exec' ? '可用指令（可以縮寫，例如 conf t、sh ip int br）：' : '這個模式可用的指令（可以縮寫；前面加 no 是取消）：', 'dim');
      sess.help().forEach((c) => print('  ' + c, 'dim'));
      if (sess.mode !== 'exec') print('  exit 回上一層　end 回到最外層　do show … 在設定模式下查看狀態', 'dim');
    } else if (low === 'cls' || low === 'clear') logs.length = 0;
    else {
      const r = sess.exec(text);
      r.out.forEach((l) => print(l, l.startsWith('%') ? 'warn' : 'dim'));
      if (r.pass && !showOrPing(r.doLine != null ? r.doLine : text)) print(`% Invalid input detected：不認識的指令「${text}」，輸入 ? 查看可用指令`, 'warn');
      if (r.changed) {
        ctx.commit(false);
        renamed = r.reloaded || (app.state.devices[dev.id] || dev).name !== before;
      }
    }
    if (renamed) app.renderPanel(); // 設備改名或重新開機了：整個面板要跟著更新
    else draw();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const line = input.value.trim();
      input.value = '';
      if (!line && !sess.pending) return; // reload 的 [confirm] 可以直接按 Enter
      hist.push(line); hi = hist.length;
      run(line);
    } else if (e.key === 'Tab') {
      // Tab 補齊：只有一個候選就補完，有好幾個就列出來
      e.preventDefault();
      const r = sess.complete(input.value, CMDS);
      if (r.line) input.value = r.line;
      if (r.options.length > 1) { print(sess.prompt() + ' ' + input.value, 'cmd'); print('  ' + r.options.join('   '), 'dim'); draw(); }
    } else if (e.key === 'ArrowUp') { if (hi > 0) { hi--; input.value = hist[hi]; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
    e.stopPropagation();
  });
  const quick = ['show running-config', 'show ip interface brief', dev.routing ? 'show ip route' : 'show vlan brief', 'configure terminal', 'end'];
  body.append(h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, promptEl, input)),
    h('div', { class: 'chips' }, quick.map((x) => h('button', { class: 'chip btnchip', type: 'button', text: x, onclick: () => { hist.push(x); hi = hist.length; run(x); input.focus(); } }))));
  draw();
  setTimeout(() => input.focus(), 30);
}
