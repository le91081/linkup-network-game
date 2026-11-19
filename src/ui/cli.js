// IOS 風格的 CLI：用 show 指令查看狀態；configure terminal 之後可以直接用指令修改設定
import { h } from './dom.js';
import { fmtIp, parseIp } from '../engine/ip.js';
import { fmtIp6 } from '../engine/ip6.js';
import { transact, routeRows, isBridgePort, arpRows, clearArp, hitsOf, fmtDur, portfastOn, macRows, clearMac, macAgeOf, sessionRows, clearSessions, saInfo } from '../engine/sim.js';
import { iosClock, deviceTime, ntpInfo, logRows, clearLog, syslogStats, uptimeOf, routerId, longIf, SEVERITY, NTP_POLL, vtyRows, idleLimit } from '../engine/ops.js';
import { quietLeft } from '../engine/remote.js';
import { counters, clearCounters, clearedAt, spanDest, debugOf, setDebug, consoleRows } from '../engine/wire.js';
import { portByName } from '../engine/ios.js';
import { isIos } from '../engine/ios.js';
import { fmtMask } from '../engine/ip.js';
import { route6Rows } from '../engine/sim6.js';
import { CATALOG, MEDIA, peerOf, portOf, linkInfo, phyConfig } from '../engine/model.js';
import { iosSession, runningConfig, startupConfig, hostName as host, aclName, aclLine } from '../engine/ios.js';

const pad = (s, n) => String(s).padEnd(n);
const isSw = (d) => !!d.sw && d.sw.mode === 'vlan';
const dotMac = (m) => m.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.');
const hms = (s) => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
const upText = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d} day${d > 1 ? 's' : ''}`, (d || h) && `${h} hour${h === 1 ? '' : 's'}`, `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean).join(', ');
};
/** 站對站通道（有設定的那種），連同它從哪個介面出去 */
const cryptoTunnels = (d) => (d.rt.tunnels || []).filter((t) => t.cfg).map((t) => ({ t, iface: d.ifaces.find((i) => i.rt && i.rt.ip != null && i.rt.ip === t.localIp) }));

const SHOW = {
  'show running-config': (st, d) => runningConfig(st, d),
  'show startup-config': (st, d) => {
    const c = startupConfig(st, d);
    return c ? c.filter((l) => l !== 'Building configuration...') : ['startup-config is not present'];
  },
  'show version': (st, d) => [`${CATALOG[d.model].title}`, `${host(d)} uptime is ${upText(uptimeOf(st, d))}`, '（LinkUp 模擬的 IOS 風格介面）'],
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
    const rows = macRows(st, d);
    const o = ['          Mac Address Table', '-------------------------------------------', '', pad('Vlan', 8) + pad('Mac Address', 18) + pad('Type', 12) + 'Ports', pad('----', 8) + pad('-----------', 18) + pad('--------', 12) + '-----'];
    for (const r of rows) o.push(pad(String(r.vlan).padStart(4), 8) + pad(dotMac(r.mac), 18) + pad(r.type, 12) + r.label);
    o.push(`Total Mac Addresses for this criterion: ${rows.length}`);
    if (!rows.length) o.push(`（表是空的。交換器要收到訊框才會學到來源 MAC：讓電腦 ping 一下，項目就會出現；${macAgeOf(d)} 秒沒有再看到就會過期）`);
    return o;
  },
  'show mac address-table aging-time': (st, d) => (isSw(d) ? [`Global Aging Time:  ${macAgeOf(d)}`] : ['% 這個指令只適用於交換器']),
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
  'show crypto isakmp sa': (st, d) => {
    const o = ['IPv4 Crypto ISAKMP SA', pad('dst', 16) + pad('src', 16) + pad('state', 15) + pad('conn-id', 8) + 'status'];
    cryptoTunnels(d).forEach(({ t }, n) => {
      const sa = saInfo(st, d.id, t.name);
      if (sa) o.push(pad(fmtIp(t.peerIp), 16) + pad(fmtIp(t.localIp), 16) + pad('QM_IDLE', 15) + pad(1001 + n, 8) + 'ACTIVE' + (t.stale ? '   （對端已經沒有回應，這筆 SA 還沒過期）' : ''));
      else if (t.nego) o.push(pad(fmtIp(t.peerIp), 16) + pad(fmtIp(t.localIp), 16) + pad('MM_KEY_EXCH', 15) + pad(0, 8) + 'ACTIVE');
    });
    if (o.length === 2) o.push('', '（沒有任何 IKE SA' + (cryptoTunnels(d).length ? '：' + cryptoTunnels(d).map(({ t }) => `${t.name} — ${t.why || '尚未建立'}`).join('；') : '') + '）');
    return o;
  },
  'show crypto ipsec sa': (st, d) => {
    const list = cryptoTunnels(d);
    if (!list.length) return ['No SAs found'];
    const o = [];
    for (const { t, iface } of list) {
      const sa = saInfo(st, d.id, t.name);
      const id = (c) => `(${fmtIp(c.net)}/${fmtMask(c.bits)}/0/0)`;
      o.push(`interface: ${iface ? longIf(iface.label) : '(none)'}`, `    Crypto map tag: ${t.cfg.cmap || 'CMAP'}, local addr ${t.localIp != null ? fmtIp(t.localIp) : '0.0.0.0'}`, '');
      t.local.forEach((l, k) => {
        const r = t.remote[k] || t.remote[0];
        o.push(`   local  ident (addr/mask/prot/port): ${id(l)}`, `   remote ident (addr/mask/prot/port): ${r ? id(r) : '(0.0.0.0/0.0.0.0/0/0)'}`,
          `   current_peer ${t.peerIp != null ? fmtIp(t.peerIp) : '0.0.0.0'} port 500`,
          `    #pkts encaps: ${sa ? sa.tx : 0}, #pkts encrypt: ${sa ? sa.tx : 0}, #pkts digest: ${sa ? sa.tx : 0}`,
          `    #pkts decaps: ${sa ? sa.rx : 0}, #pkts decrypt: ${sa ? sa.rx : 0}, #pkts verify: ${sa ? sa.rx : 0}`);
        if (sa) {
          o.push(`     local crypto endpt.: ${fmtIp(t.localIp)}, remote crypto endpt.: ${fmtIp(t.peerIp)}`,
            '     inbound esp sas:', `        sa timing: remaining key lifetime (k/sec): (4608000/${sa.left2})`, '        Status: ACTIVE(ACTIVE)',
            '     outbound esp sas:', `        sa timing: remaining key lifetime (k/sec): (4608000/${sa.left2})`, '        Status: ACTIVE(ACTIVE)',
            ...(sa.rekey2 ? [`     （這組金鑰已經重新協商過 ${sa.rekey2} 次，每 ${sa.life2} 秒一次）`] : []));
        } else o.push('     inbound esp sas:', '', '     outbound esp sas:', '', `     （沒有 SA：${t.why || '通道尚未建立'}）`);
        o.push('');
      });
    }
    return o;
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
    const rid = (x) => { const r = routerId(st.devices[x.dev]); return fmtIp(r ?? x.ip); };
    return [pad('Neighbor ID', 18) + pad('State', 14) + pad('Dead Time', 11) + pad('Address', 17) + 'Interface',
      ...n.map((x) => pad(rid(x), 18) + pad(x.state === 'forming' ? '2WAY/DROTHER' : 'FULL/ -', 14)
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
  'show clock': (st, d) => [iosClock(st, d)],
  'show clock detail': (st, d) => {
    // 每台設備有自己的時鐘。前面的 * 代表不可信（沒有對過時），. 代表曾經對過時但現在失去同步
    const t = deviceTime(st, d);
    const src = { ntp: t.sync ? 'Time source is NTP' : 'Time source is NTP（目前失去同步，時鐘照原本的速度自己走）', manual: 'Time source is user configuration', rtc: 'Time source is hardware calendar', boot: 'No time source' }[t.src];
    const hint = t.src === 'boot' ? '（這台設備沒有硬體時鐘，時間是從開機那一刻的出廠預設值算起的。設定 ntp server 對時，或用 clock set 手動設定）'
      : t.src === 'rtc' ? '（時間來自設備自己的硬體時鐘，沒有對過時，可能快或慢幾分鐘）' : null;
    return [iosClock(st, d), src, hint].filter(Boolean);
  },
  'show ntp status': (st, d) => {
    const n = ntpInfo(st, d);
    if (n.synced) {
      return [`Clock is synchronized, stratum ${n.stratum}, reference is ${fmtIp(n.server)}`, `system poll interval is ${NTP_POLL}, last update was ${n.when} sec ago.`,
        n.lost && `（最近的輪詢沒有收到 ${fmtIp(n.server)} 的回應：${n.why}。連續八次都沒有回應就會失去同步）`].filter(Boolean);
    }
    if (n.master) return [`Clock is synchronized, stratum ${n.master}, reference is 127.127.1.1`, '（ntp master：這台設備把自己的時鐘當成時間來源，替別人報時。它自己的時間如果是錯的，下游全部跟著錯）'];
    const why = n.server == null ? '沒有設定 NTP 伺服器（ntp server <IP>）'
      : n.wait > 0 ? `已經收到 ${fmtIp(n.server)} 的回應，還要連續幾次輪詢才會採信，大約再 ${fmtDur(n.wait)}`
          : !n.reachable ? `連不到 ${fmtIp(n.server)}：${n.why || '還沒有收到回應'}（每 ${NTP_POLL} 秒重試一次，下一次在 ${n.next} 秒後）` : '';
    return ['Clock is unsynchronized, stratum 16, no reference clock', why && `（${why}）`].filter(Boolean);
  },
  'show ntp associations': (st, d) => {
    const n = ntpInfo(st, d);
    const o = ['  address         ref clock       st   when   poll reach  delay  offset   disp'];
    const row = (flag, addr, ref, stv, reach) => `${flag}${pad(addr, 16)}${pad(ref, 16)}${String(stv).padStart(2)} ${String(n.when).padStart(6)} ${String(NTP_POLL).padStart(6)} ${reach.toString(8).padStart(5)}  1.000   0.500  0.100`;
    if (n.master) o.push(row('*~', '127.127.1.1', '.LOCL.', n.master - 1, 255));
    if (n.server != null) o.push(row(n.synced ? '*~' : ' ~', fmtIp(n.server), n.reachable ? (n.serverStratum <= 1 ? '.GPS.' : 'time.google.com') : '.INIT.', n.reachable ? n.serverStratum : 16, n.reach));
    if (o.length === 1) return ['（沒有設定任何 NTP 伺服器）'];
    o.push(' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured');
    return o;
  },
  'show logging': (st, d) => {
    const rows = logRows(st, d), s = syslogStats(st, d), m = d.mgmt || {};
    const trap = m.logTrap == null || m.logTrap === '' ? 6 : +m.logTrap;
    const o = ['Syslog logging: enabled', `    Console logging: level debugging, ${rows.length} messages logged`, `    Buffer logging:  level debugging, ${rows.length} messages logged`,
      `    Trap logging: level ${SEVERITY[trap]}, ${s.sent + s.lost} message lines logged`];
    if (m.syslog) o.push(`        Logging to ${m.syslog}  (udp port 514), ${s.sent} message lines logged, ${s.lost} message lines dropped${s.lost ? `（${s.why}）` : ''}`);
    o.push('', 'Log Buffer (8192 bytes):', '', ...rows.map((r) => r.line));
    if (!rows.length) o.push('（緩衝區是空的：介面上線或斷線、鄰居關係改變、有人改設定時才會留下紀錄。重新開機之後這裡的內容會消失）');
    return o;
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
  'show ip nat translations': (st, d) => natTable(st, d, false),
  'show ip nat translations verbose': (st, d) => natTable(st, d, true),
  'show ip nat statistics': (st, d) => {
    const dyn = sessionRows(st, d).filter((e) => e.nSrc !== e.src || e.nDst !== e.dst).length;
    const stat = (d.staticNat || []).filter((n) => n.pub && n.priv).length + (d.portForwards || []).filter((f) => f.port && f.toIp && !f.off).length;
    const outIf = d.ifaces.filter((i) => i.nat).map((i) => i.label), inIf = d.ifaces.filter((i) => !i.nat && i.rt && i.rt.ip != null).map((i) => i.label);
    return [`Total active translations: ${dyn + stat} (${stat} static, ${dyn} dynamic; ${dyn} extended)`, 'Outside interfaces:', '  ' + (outIf.join(', ') || '(none)'), 'Inside interfaces:', '  ' + (inIf.join(', ') || '(none)')];
  },
  'show interfaces counters errors': (st, d) => {
    const ports = d.ports.filter((p) => st.rt.links[d.id + ':' + p.id] || ((st.dyn.ifc || {})[d.id] || {})[p.id]);
    const n = (v) => String(v).padStart(11);
    return [pad('Port', 10) + ['Align-Err', 'FCS-Err', 'Xmit-Err', 'Rcv-Err', 'UnderSize', 'OutDiscards'].map((x) => x.padStart(11)).join(''),
      ...ports.map((p) => { const c = counters(st, d.id, p.id); return pad(p.label, 10) + n(0) + n(c.crc) + n(0) + n(c.crc + c.runts) + n(c.runts) + n(0); }), '',
      pad('Port', 10) + ['Single-Col', 'Multi-Col', 'Late-Col', 'Excess-Col', 'Carri-Sen', 'Runts'].map((x) => x.padStart(11)).join(''),
      ...ports.map((p) => { const c = counters(st, d.id, p.id); const coll = Math.max(0, c.coll - c.late); return pad(p.label, 10) + n(Math.ceil(coll * 0.7)) + n(Math.floor(coll * 0.3)) + n(c.late) + n(0) + n(0) + n(c.runts); })];
  },
  'show monitor': (st, d) => monitorLines(d, null),
  'show debugging': (st, d) => {
    const x = debugOf(st, d.id);
    if (!x) return ['（目前沒有開啟任何 debug）'];
    return ['IP:', ...(x.packet ? ['  IP packet debugging is on'] : []), ...(x.icmp ? ['  ICMP packet debugging is on'] : []),
      '', '（debug 的輸出會出現在 console 上，也會進紀錄緩衝區 (show logging)。用 SSH 登入的話，要先輸入 terminal monitor 才看得到）'];
  },
  'show ip protocols': (st, d) => {
    if (!d.routing) return ['% 這台設備沒有啟用 IP 路由'];
    const stmts = d.ospfNets || [], on = d.ifaces.filter((i) => i.ospf && i.rt && i.rt.ip != null);
    if (!stmts.length && !on.length) return ['（沒有啟用任何動態路由協定，路由表只有直連與靜態路由）'];
    const rid = routerId(d), wild = (b) => fmtIp(b === 0 ? 0xffffffff : ((1 << (32 - b)) - 1) >>> 0);
    return ['*** IP Routing is NSF aware ***', '', 'Routing Protocol is "ospf 1"', '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set',
      `  Router ID ${rid != null ? fmtIp(rid) : '0.0.0.0'}`, '  Number of areas in this router is 1. 1 normal 0 stub 0 nssa', '  Maximum path: 4', '  Routing for Networks:',
      ...stmts.map((n) => `    ${fmtIp(n.net)} ${wild(n.bits)} area 0`),
      ...on.filter((i) => !stmts.some((n) => (i.rt.ip >>> (32 - n.bits || 0)) === (n.net >>> (32 - n.bits || 0)))).map((i) => `    ${longIf(i.label)}`),
      '  Routing Information Sources:', '    Gateway         Distance      Last Update',
      ...(d.rt.nbrs || []).filter((n) => n.state === 'full').map((n) => `    ${pad(fmtIp(routerId(st.devices[n.dev]) ?? n.ip), 16)}${pad(110, 14)}${hms(Math.min(st.clock, 3600))}`),
      '  Distance: (default is 110)'];
  },
  'show ip ospf interface brief': (st, d) => {
    const on = d.ifaces.filter((i) => i.rt && i.rt.ip != null && i.ospf !== undefined && (i.ospf || (d.ospfNets || []).some((n) => ((i.rt.ip >>> (32 - n.bits)) << (32 - n.bits)) >>> 0 === n.net)));
    if (!on.length) return ['（沒有任何介面啟用 OSPF）'];
    const rid = (x) => routerId(x) ?? 0;
    return [pad('Interface', 12) + pad('PID', 6) + pad('Area', 16) + pad('IP Address/Mask', 20) + pad('Cost', 6) + pad('State', 6) + 'Nbrs F/C',
      ...on.map((i) => {
        const nb = (d.rt.nbrs || []).filter((n) => n.iface === i.id), full = nb.filter((n) => n.state === 'full');
        // DR 選舉：同一個網段裡 Router ID 最大的當 DR，第二大的當 BDR（這裡不模擬「先上線的不讓位」）
        const all = [d, ...full.map((n) => st.devices[n.dev])].sort((a, b) => rid(b) - rid(a));
        const role = !nb.length ? 'DR' : all[0] === d ? 'DR' : all[1] === d ? 'BDR' : 'DROTH';
        return pad(i.label, 12) + pad(1, 6) + pad(0, 16) + pad(`${fmtIp(i.rt.ip)}/${i.rt.bits}`, 20) + pad(Math.max(1, +i.ospfCost || 1), 6) + pad(nb.length && full.length < nb.length ? 'WAIT' : role, 6) + `${full.length}/${nb.length}`;
      })];
  },
  'show users': (st, d) => {
    const o = ['    Line       User       Host(s)              Idle       Location', '*  0 con 0                idle                 00:00:00'];
    vtyRows(st, d).forEach((v, n) => o.push(`   ${String(n + 2).padStart(1)} vty ${n}     ${pad(v.user, 11)}${pad('idle', 21)}${hms(st.clock - v.last)} ${v.ip}`));
    const lim = idleLimit(d);
    o.push('', lim > 0 ? `（遠端登入閒置超過 ${fmtDur(lim)}會自動登出：line vty 的 exec-timeout）` : '（exec-timeout 0 0：遠端登入不會因為閒置而登出）');
    return o;
  },
  'show login': (st, d) => {
    const b = d.mgmt && d.mgmt.block, q = quietLeft(st, d);
    const fails = ((st.dyn.login || {})[d.id] || { fails: [] }).fails.filter((t) => !b || st.clock - t < b.within).length;
    if (!b) return ['     No login delay has been applied.', '     No Quiet-Mode access list has been configured.', '', '     Router NOT enabled to watch for login Attacks', '（還沒有設定 login block-for：密碼可以被無限次地嘗試）'];
    return ['     A default login delay of 1 seconds is applied.', '     No Quiet-Mode access list has been configured.', '', '     Router enabled to watch for login Attacks.',
      `     If more than ${b.tries} login failures occur in ${b.within} seconds or less,`, `     logins will be disabled for ${b.sec} seconds.`, '',
      q ? `     Router presently in Quiet-Mode.\n     Will remain in Quiet-Mode for ${q} seconds.` : '     Router presently in Normal-Mode.', `     Present login failure count ${fails}.`].join('\n').split('\n');
  },
  'show interfaces status': (st, d) => {
    const o = [pad('Port', 14) + pad('Status', 14) + pad('Vlan', 8) + pad('Duplex', 9) + pad('Speed', 9) + 'Type'];
    for (const p of d.ports) {
      const pc = d.sw && d.sw.ports[p.id];
      const up = !!st.rt.links[d.id + ':' + p.id];
      const li = up && linkInfo(st, d.id, p.id);
      const status = pc && pc.shut ? 'disabled' : d.rt.err[p.id] ? 'err-disabled' : d.sw && spanDest(d, p.id) ? 'monitoring' : up ? 'connected' : 'notconnect';
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
/** show monitor [session n] */
function monitorLines(d, only) {
  const span = (d.sw && d.sw.span) || {};
  const lab = (pid) => (d.ports.find((p) => p.id === pid) || {}).label || pid;
  const ids = Object.keys(span).filter((k) => only == null || k === String(only));
  if (!ids.length) return [only == null ? '（沒有設定任何 SPAN session）' : `% Session ${only} does not exist`];
  const o = [];
  for (const k of ids) {
    const s = span[k], src = Object.entries(s.src || {});
    const list = (dir) => src.filter(([, v]) => v === dir).map(([p]) => lab(p)).join(',');
    o.push(`Session ${k}`, '---------', 'Type                   : Local Session', 'Source Ports           :',
      ...(['both', 'rx', 'tx'].filter((x) => list(x)).map((x) => `    ${pad({ both: 'Both', rx: 'RX Only', tx: 'TX Only' }[x], 19)}: ${list(x)}`)),
      `Destination Ports      : ${s.dst ? lab(s.dst) : ''}`, '    Encapsulation      : Native', '          Ingress      : Disabled', '');
  }
  return o;
}

/** show interfaces <名稱>：一個連接埠的完整狀態與計數器 */
function ifaceDetail(st, d, p) {
  const pc = d.sw && d.sw.ports[p.id], i = d.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
  const up = !!st.rt.links[d.id + ':' + p.id], err = d.rt.err && d.rt.err[p.id];
  const admin = (pc && pc.shut) || (i && i.shut);
  const L = longIf(p.label);
  const state = admin ? 'is administratively down, line protocol is down (disabled)' : err ? 'is down, line protocol is down (err-disabled)'
    : d.sw && spanDest(d, p.id) ? `is up, line protocol is down (monitoring)` : up ? `is up, line protocol is up${pc ? ' (connected)' : ''}` : `is down, line protocol is down${pc ? ' (notconnect)' : ''}`;
  const mac = (i && i.rt && i.rt.mac) || (d.ifaces.find((x) => x.rt && x.rt.mac) || { rt: {} }).rt.mac || '0000.0000.0000';
  const li = up && linkInfo(st, d.id, p.id), cfg = phyConfig(d, p.id);
  const c = counters(st, d.id, p.id), clr = clearedAt(st, d.id, p.id);
  const ago = (t) => (t == null ? 'never' : hms(st.clock - t));
  const speed = li ? li.speed : cfg.speed || (p.media === 'rj45' ? 1000 : 10000);
  const dup = li ? (li.duplex === 'half' ? 'Half-duplex' : 'Full-duplex') : cfg.duplex === 'half' ? 'Half-duplex' : 'Auto-duplex';
  const load = (bps) => Math.max(1, Math.min(255, Math.round((bps / (speed * 1e6)) * 255)));
  const inErr = c.crc + c.runts;
  return [`${L} ${state}`,
    `  Hardware is ${p.media === 'rj45' ? 'Gigabit Ethernet' : 'Ten Gigabit Ethernet'}, address is ${dotMac(mac)} (bia ${dotMac(mac)})`,
    ...(i && i.rt && i.rt.ip != null ? [`  Internet address is ${fmtIp(i.rt.ip)}/${i.rt.bits}`] : []),
    `  MTU 1500 bytes, BW ${speed * 1000} Kbit/sec, DLY 10 usec,`,
    `     reliability ${inErr && c.ip ? Math.max(1, Math.round(255 * (1 - Math.min(1, inErr / Math.max(1, c.ip + inErr))))) : 255}/255, txload ${load(c.outRate)}/255, rxload ${load(c.inRate)}/255`,
    '  Encapsulation ARPA, loopback not set', '  Keepalive set (10 sec)',
    `  ${dup}, ${speed >= 1000 ? speed / 1000 + '000' : speed}Mb/s, media type is ${p.media === 'rj45' ? '10/100/1000BaseTX' : 'SFP'}`,
    `  Last input ${ago(c.lastIn)}, output ${ago(c.lastOut)}, output hang never`,
    `  Last clearing of "show interface" counters ${clr == null ? 'never' : hms(st.clock - clr)}`,
    '  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0', '  Queueing strategy: fifo', '  Output queue: 0/40 (size/max)',
    `  5 minute input rate ${c.inRate} bits/sec, ${c.inPps} packets/sec`, `  5 minute output rate ${c.outRate} bits/sec, ${c.outPps} packets/sec`,
    `     ${c.ip} packets input, ${c.ib} bytes, 0 no buffer`, `     Received ${c.ibc + c.imc} broadcasts (${c.imc} multicasts)`,
    `     ${c.runts} runts, 0 giants, 0 throttles`, `     ${inErr} input errors, ${c.crc} CRC, 0 frame, 0 overrun, 0 ignored`,
    `     0 watchdog, ${c.imc} multicast, 0 pause input`, '     0 input packets with dribble condition detected',
    `     ${c.op} packets output, ${c.ob} bytes, 0 underruns`, `     ${c.late} output errors, ${c.coll} collisions, 1 interface resets`,
    '     0 unknown protocol drops', `     0 babbles, ${c.late} late collision, 0 deferred`, '     0 lost carrier, 0 no carrier, 0 pause output', '     0 output buffer failures, 0 output buffers swapped out',
    ...(c.crc || c.late ? ['', `（${c.crc ? 'CRC 錯誤與 runts 代表收到的訊框是壞的' : ''}${c.crc && c.late ? '；' : ''}${c.late ? 'late collision 代表這一端是半雙工，卻在訊框送到一半之後才撞到' : ''} — 典型的 duplex mismatch 或線路品質問題）`] : [])];
}

/** IOS 的 traceroute：每一站的路由器回應一次 */
function traceLines(app, d, ip, print, line) {
  const st = app.state, r = transact(st, d.id, { proto: 'icmp', dst: ip });
  app.showTrace(`${d.name}# ${line}`, r.log, r.hops, r);
  print('Type escape sequence to abort.');
  print(`Tracing the route to ${fmtIp(ip)}`);
  print('VRF info: (vrf in name/id, vrf out name/id)');
  const ms = (n) => `${n} msec ${Math.max(0, n - 1)} msec ${n} msec`;
  r.l3.forEach((x, n) => print(`  ${n + 1} ${x.ip == null ? '*' : fmtIp(x.ip)} ${ms(n + 1)}`, 'pre'));
  if (r.ok) print(`  ${r.l3.length + 1} ${fmtIp(ip)} ${ms(r.l3.length + 2)}`, 'ok');
  else {
    for (let k = 1; k <= 3; k++) print(`  ${r.l3.length + k}  *  *  * `, 'bad');
    print('  ↳ ' + r.reason, 'hint');
  }
}

/**
 * 命令列上的即時輸出：IOS 的紀錄（console logging，包含 debug）、FortiGate 的 sniffer 與 debug flow。
 * key 代表是哪一個畫面在看（CLI 分頁、某一條 SSH 連線），各自記得看到哪裡。回傳印了幾行
 */
export function consoleFollow(app, devId, key, print) {
  const st = app.state, d = st.devices[devId];
  if (!d || !st.dyn) return 0;
  const rows = d.kind === 'firewall' ? consoleRows(st, devId) : isIos(d) ? logRows(st, d) : [];
  const seen = (app.conSeen ||= {});
  const last = rows.length ? rows[rows.length - 1].n : 0;
  if (seen[key] == null) { seen[key] = last; return 0; } // 第一次打開：不把以前的紀錄全部倒出來
  let k = 0;
  for (const r of rows) if (r.n > seen[key]) { print(r.line, d.kind === 'firewall' ? 'pre' : 'con'); k++; }
  seen[key] = Math.max(seen[key], last);
  return k;
}

/** NAT 轉換表：動態的項目閒置太久會被移除，靜態的一直都在 */
function natTable(st, d, verbose) {
  const W = 22;
  const o = [pad('Pro', 5) + pad('Inside global', W) + pad('Inside local', W) + pad('Outside local', W) + 'Outside global'];
  for (const e of sessionRows(st, d)) {
    const snat = e.nSrc !== e.src, dnat = e.nDst !== e.dst;
    if (!snat && !dnat) continue;
    const far = (ip, port) => `${fmtIp(ip)}:${e.proto === 'icmp' ? e.sport : port}`; // ICMP 沒有埠號，IOS 顯示的是識別碼
    if (snat) o.push(pad(e.proto, 5) + pad(`${fmtIp(e.nSrc)}:${e.nSport}`, W) + pad(`${fmtIp(e.src)}:${e.sport}`, W) + pad(far(e.dst, e.dport), W) + far(e.dst, e.dport));
    else o.push(pad(e.proto, 5) + pad(`${fmtIp(e.dst)}:${e.dport}`, W) + pad(`${fmtIp(e.nDst)}:${e.nDport}`, W) + pad(`${fmtIp(e.src)}:${e.sport}`, W) + `${fmtIp(e.src)}:${e.sport}`);
    if (verbose) o.push(`    create ${hms(e.age)}, use ${hms(st.clock - e.t)}, timeout: ${e.ttl}, left ${hms(e.left)}`);
  }
  const pub = d.ifaces.find((i) => i.nat && i.rt && i.rt.ip != null);
  for (const f of d.portForwards || []) {
    if (f.off || !f.port || !f.toIp || !pub) continue;
    o.push(pad(f.proto || 'tcp', 5) + pad(`${f.extIp || fmtIp(pub.rt.ip)}:${f.port}`, W) + pad(`${f.toIp}:${f.toPort || f.port}`, W) + pad('---', W) + '---');
  }
  for (const n of d.staticNat || []) if (n.pub && n.priv) o.push(pad('---', 5) + pad(n.pub, W) + pad(n.priv, W) + pad('---', W) + '---');
  if (o.length === 1) return ['目前沒有任何 NAT 轉換（先讓流量經過這台設備，例如從內部的電腦 ping 外面。動態的轉換閒置一段時間就會從表裡移除：ICMP 60 秒、UDP 5 分鐘、TCP 連線關閉後 60 秒）'];
  return o;
}

const stpState = (d, pid) => (d.rt.wait && d.rt.wait[pid] > 15 ? 'LSN' : d.rt.wait && d.rt.wait[pid] > 0 ? 'LRN' : 'FWD');
const CMDS = Object.keys(SHOW);
const match = (tokens, cmd) => {
  const w = cmd.split(' ');
  return tokens.length === w.length && tokens.every((t, i) => w[i].startsWith(t));
};

/** show、clear 與 ping：回傳 false 表示不是這幾種指令 */
function showOrPing(app, devId, line, print) {
  const tok = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const st = app.state, d = st.devices[devId];
  if (!tok.length || !d) return true;
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
  // traceroute <IP>
  if (tok[0].length >= 4 && 'traceroute'.startsWith(tok[0])) {
    const ip = parseIp(tok[1] || '');
    if (ip == null) print('% 用法：traceroute <IPv4 位址>', 'warn');
    else if (!d.ifaces.some((i) => i.rt && i.rt.ip != null)) print('% 這台設備沒有任何 IP 位址，無法送出封包', 'warn');
    else traceLines(app, d, ip, print, line);
    return true;
  }
  // debug / undebug：只是執行期的開關，不會寫進設定
  const isUndebug = (tok[0].length >= 1 && 'undebug'.startsWith(tok[0]) && tok[0] !== 'u' ? true : tok[0] === 'u' || tok[0] === 'un') || (tok[0] === 'no' && (tok[1] || '').length >= 2 && 'debug'.startsWith(tok[1]));
  if (isUndebug || (tok[0].length >= 3 && 'debug'.startsWith(tok[0]))) {
    const rest = tok.slice(isUndebug && tok[0] === 'no' ? 2 : 1);
    const what = rest[0] === 'all' ? 'all' : rest[0] === 'ip' && (rest[1] || '').startsWith('pa') ? 'packet' : rest[0] === 'ip' && (rest[1] || '').startsWith('ic') ? 'icmp' : null;
    if (!what) { print('% 這個模擬支援：debug ip packet、debug ip icmp、undebug all', 'warn'); return true; }
    if (what === 'all' && !isUndebug) { print('% debug all 會把設備塞爆，真的設備上請不要這樣做。這個模擬只支援 debug ip packet、debug ip icmp', 'warn'); return true; }
    setDebug(st, d.id, what, !isUndebug);
    if (what === 'all') print('All possible debugging has been turned off');
    else print(`${what === 'packet' ? 'IP packet' : 'ICMP packet'} debugging is ${isUndebug ? 'off' : 'on'}`);
    if (!isUndebug && what === 'packet') print('（只看得到給這台路由器自己、或它自己送出的封包，以及它丟掉的封包；經過它轉送的封包由 CEF 處理，不會出現在這裡）', 'hint');
    return true;
  }
  // show interfaces [名稱]、show monitor session <n>
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] && tok[1].length >= 3 && 'interfaces'.startsWith(tok[1]) && !(tok[2] && ['status', 'trunk', 'counters'].some((w) => tok[2].length >= 2 && w.startsWith(tok[2])))) {
    const name = tok.slice(2).join('');
    const ports = name ? [portByName(d, name)] : d.ports.filter((p) => st.rt.links[d.id + ':' + p.id] || (d.sw && d.sw.ports[p.id] && d.sw.ports[p.id].shut));
    if (name && !ports[0]) { print(`% 找不到介面「${tok.slice(2).join(' ')}」`, 'warn'); return true; }
    for (const p of ports) ifaceDetail(st, d, p).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && (tok[1] || '').length >= 3 && 'monitor'.startsWith(tok[1]) && tok[2] && 'session'.startsWith(tok[2]) && tok[3]) {
    monitorLines(d, tok[3]).forEach((l) => print(l, 'pre'));
    return true;
  }
  if (tok[0] === 'clear' && tok.length > 1) {
    const rest = tok.slice(1).join(' ');
    if (rest.startsWith('arp')) clearArp(st, d);
    else if (/^mac/.test(rest)) clearMac(st, d);
    else if (/^ip nat tr/.test(rest)) clearSessions(st, d);
    else if (/^log/.test(rest)) clearLog(st, d);
    else if (/^cou/.test(rest)) {
      // clear counters [介面]
      const name = tok.slice(2).join('');
      const p = name ? portByName(d, name) : null;
      if (name && !p) { print(`% 找不到介面「${name}」`, 'warn'); return true; }
      print(`Clear "show interface" counters on ${p ? 'this interface' : 'all interfaces'} [confirm]`);
      clearCounters(st, d.id, p ? p.id : undefined);
    }
    else return false;
    app.refreshLive();
    return true;
  }
  const cmd = CMDS.find((c) => match(tok, c));
  if (!cmd) return false;
  SHOW[cmd](st, d).forEach((l) => print(l, 'pre')); // 表格不折行，太寬時左右捲動
  return true;
}

/**
 * 執行一行 IOS 指令。CLI 分頁和遠端登入 (SSH / Telnet) 共用。
 * 回傳 { clear：要清空畫面, changed：設定或狀態有變動, renamed：設備改名或重新開機了 }
 */
export function iosRun(app, devId, sess, line, print) {
  const text = line.trim(), low = text.toLowerCase();
  const booting = (app.state.rt.booting || {})[devId];
  if (booting > 0) { print(`% 設備還在開機中，還要 ${Math.ceil(booting)} 秒才能下指令`, 'warn'); return {}; }
  const before = app.state.devices[devId].name;
  if (text.length > 1 && text.endsWith('?')) {
    // 指令打到一半加上 ?：列出接下來可以輸入的字
    const r = sess.complete(text.slice(0, -1), CMDS);
    print(r.options.length ? '  ' + r.options.join('   ') : '  （沒有符合的指令，或接下來要輸入的是數值 / 位址）', 'dim');
    return {};
  }
  if (low === '?' || low === 'help') {
    print(sess.mode === 'exec' ? '可用指令（可以縮寫，例如 conf t、sh ip int br）：' : '這個模式可用的指令（可以縮寫；前面加 no 是取消）：', 'dim');
    sess.help().forEach((c) => print('  ' + c, 'dim'));
    if (sess.mode !== 'exec') print('  exit 回上一層　end 回到最外層　do show … 在設定模式下查看狀態', 'dim');
    return {};
  }
  if (low === 'cls' || low === 'clear') return { clear: true };
  const r = sess.exec(text);
  r.out.forEach((l) => print(l, l.startsWith('%') ? 'warn' : 'dim'));
  if (r.pass && !showOrPing(app, devId, r.doLine != null ? r.doLine : text, print)) print(`% Invalid input detected：不認識的指令「${text}」，輸入 ? 查看可用指令`, 'warn');
  const d = app.state.devices[devId];
  return { changed: !!r.changed, reloaded: !!r.reloaded, renamed: !!r.changed && (!!r.reloaded || !d || d.name !== before) };
}
/** Tab 補齊時要一起列出來的 show 指令 */
export const IOS_CMDS = CMDS;

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

  const follow = () => consoleFollow(app, dev.id, 'cli:' + dev.id, print);
  follow(); // 上次離開這個分頁之後，console 上出現過的訊息
  const run = (line) => {
    print(sess.prompt() + ' ' + line, 'cmd');
    const r = iosRun(app, dev.id, sess, line, print);
    if (r.clear) logs.length = 0;
    if (r.changed) ctx.commit(false);
    follow();
    if (r.renamed) app.renderPanel(); // 設備改名或重新開機了：整個面板要跟著更新
    else draw();
  };
  // 在別的地方發生的事（介面斷線、debug 的輸出）也會出現在 console 上
  app.refreshers.push(() => { if (follow()) draw(); });
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
