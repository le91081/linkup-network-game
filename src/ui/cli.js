// IOS 風格的唯讀 CLI：把圖形介面的設定翻譯成等效的指令，並支援常用的 show 指令
import { h } from './dom.js';
import { fmtIp, fmtMask, parseIp, parseMask, netOf, maskOf, bcastOf, parseCidr } from '../engine/ip.js';
import { fmtIp6 } from '../engine/ip6.js';
import { transact, routeRows, macsBehind, isBridgePort } from '../engine/sim.js';
import { route6Rows } from '../engine/sim6.js';
import { CATALOG, peerOf, portOf } from '../engine/model.js';

const host = (dev) => dev.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'Device';
const wild = (bits) => fmtIp(~maskOf(bits) >>> 0);
const pad = (s, n) => String(s).padEnd(n);
const isSw = (d) => !!d.sw && d.sw.mode === 'vlan';

function aclAddr(spec) {
  const s = String(spec || 'any').trim().toLowerCase();
  if (s === '' || s === 'any') return 'any';
  const c = parseCidr(s);
  if (!c) return s;
  return c.bits === 32 ? 'host ' + fmtIp(c.net) : `${fmtIp(c.net)} ${wild(c.bits)}`;
}
const aclName = (i, dir) => `${i.label.replace(/[^\w.]+/g, '_')}_${dir}`.toUpperCase();

/** 產生等效的 running-config */
export function runningConfig(state, dev) {
  const o = ['Building configuration...', '', '!', `hostname ${host(dev)}`, '!'];
  const m = dev.mgmt;
  if (m) o.push(`username ${m.user || 'admin'} privilege 15 secret ********`, '!');
  if (dev.v6routing) o.push('ipv6 unicast-routing', '!');
  if (isSw(dev)) {
    const sw = dev.sw;
    for (const v of sw.vlans.slice().sort((a, b) => a.id - b.id)) if (v.id !== 1) o.push(`vlan ${v.id}`, ` name ${v.name.replace(/\s+/g, '_')}`);
    o.push('!', 'spanning-tree mode rapid-pvst');
    const stp = sw.stp || {};
    if (stp.on === false) o.push('no spanning-tree vlan 1-4094');
    else if (stp.prio != null && +stp.prio !== 32768) o.push(`spanning-tree vlan 1-4094 priority ${+stp.prio}`);
    const vl = sw.vlans.map((v) => v.id).sort((a, b) => a - b).join(',');
    if (sw.snoop && sw.snoop.on) o.push('ip dhcp snooping', `ip dhcp snooping vlan ${vl}`);
    if (sw.dai && sw.dai.on) o.push(`ip arp inspection vlan ${vl}`);
    if (Object.values(sw.ports).some((p) => p.dot1x)) o.push('aaa new-model', 'aaa authentication dot1x default group radius', 'dot1x system-auth-control');
    o.push('!');
  }
  // DHCP 位址池
  for (const i of dev.ifaces) {
    if (!i.dhcp || !i.dhcp.on || !i.rt || i.rt.ip == null) continue;
    const a = parseIp(i.dhcp.start), b = parseIp(i.dhcp.end);
    const net = netOf(i.rt.ip, i.rt.bits), bc = bcastOf(i.rt.ip, i.rt.bits);
    if (a != null && a > net + 1) o.push(`ip dhcp excluded-address ${fmtIp(net + 1)} ${fmtIp(a - 1)}`);
    if (b != null && b < bc - 1) o.push(`ip dhcp excluded-address ${fmtIp(b + 1)} ${fmtIp(bc - 1)}`);
    o.push(`ip dhcp pool ${i.label.replace(/[^\w.]+/g, '_').toUpperCase()}`, ` network ${fmtIp(net)} ${fmtMask(i.rt.bits)}`,
      ` default-router ${i.dhcp.gw || fmtIp(i.rt.ip)}`);
    if (i.dhcp.dns) o.push(` dns-server ${i.dhcp.dns.replace(/[,\s]+/g, ' ')}`);
    o.push('!');
  }
  const anyNat = dev.ifaces.some((i) => i.nat);
  const l3lines = (i) => {
    const l = [];
    if (i.mode === 'dhcp') l.push(' ip address dhcp');
    else if (i.mode === 'pppoe') l.push(' pppoe-client dial-pool-number 1', ` ! PPPoE 帳號 ${i.user || '(未設定)'}`);
    else if (i.ip && parseMask(i.mask) != null) l.push(` ip address ${i.ip} ${fmtMask(parseMask(i.mask))}`);
    else l.push(' no ip address');
    if (anyNat) l.push(i.nat ? ' ip nat outside' : i.ip || i.mode !== 'static' ? ' ip nat inside' : null);
    if (i.helper) l.push(` ip helper-address ${i.helper}`);
    if (i.ospf && i.ospfCost) l.push(` ip ospf cost ${i.ospfCost}`);
    if (i.aclIn && i.aclIn.length) l.push(` ip access-group ${aclName(i, 'in')} in`);
    if (i.aclOut && i.aclOut.length) l.push(` ip access-group ${aclName(i, 'out')} out`);
    if (i.vrrp && i.vrrp.on) l.push(` vrrp 1 ip ${i.vrrp.vip || '(未設定)'}`, ` vrrp 1 priority ${i.vrrp.prio || 100}`);
    if (i.ip6) l.push(` ipv6 address ${i.ip6}`);
    if (i.ip6 && !i.ra) l.push(' ipv6 nd ra suppress all');
    return l.filter(Boolean);
  };
  for (const p of dev.ports) {
    const peer = peerOf(state, dev.id, p.id);
    const desc = peer ? [` description to ${host(state.devices[peer.dev])}`] : [];
    const pc = dev.sw && dev.sw.ports[p.id];
    if (pc && isSw(dev)) {
      const def = pc.mode === 'access' && pc.vlan === 1 && !pc.shut && !peer && !pc.trust && !(+pc.lag > 0) && !(pc.ps && pc.ps.on) && !pc.bpduguard && !pc.dot1x;
      if (def) continue;
      o.push(`interface ${p.label}`, ...desc);
      if (pc.mode === 'routed') {
        const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
        o.push(' no switchport', ...(i ? l3lines(i) : []));
      } else if (pc.mode === 'trunk') {
        o.push(' switchport mode trunk');
        if (pc.native !== 1) o.push(` switchport trunk native vlan ${pc.native}`);
        if (pc.allowed && pc.allowed !== 'all') o.push(` switchport trunk allowed vlan ${pc.allowed}`);
      } else {
        o.push(' switchport mode access');
        if (pc.vlan !== 1) o.push(` switchport access vlan ${pc.vlan}`);
        o.push(' spanning-tree portfast');
      }
      if (+pc.lag > 0) o.push(` channel-group ${+pc.lag} mode ${pc.lagMode || 'active'}`);
      if (pc.ps && pc.ps.on) {
        o.push(' switchport port-security');
        for (const mac of String(pc.ps.macs || '').split(/[,\s]+/).filter(Boolean)) o.push(` switchport port-security mac-address ${mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.')}`);
        o.push(` switchport port-security violation ${pc.ps.mode || 'restrict'}`);
      }
      if (pc.trust) o.push(' ip dhcp snooping trust', ...(dev.sw.dai && dev.sw.dai.on ? [' ip arp inspection trust'] : []));
      if (pc.bpduguard) o.push(' spanning-tree bpduguard enable');
      if (pc.dot1x) o.push(' authentication port-control auto', ' dot1x pae authenticator');
      if (pc.shut) o.push(' shutdown');
      o.push('!');
    } else if (!pc) {
      const i = dev.ifaces.find((x) => x.bind.t === 'port' && x.bind.port === p.id);
      if (!i) continue;
      o.push(`interface ${p.label}`, ...desc, ...l3lines(i), ' no shutdown', '!');
      for (const s of dev.ifaces.filter((x) => x.bind.t === 'sub' && x.bind.port === p.id)) {
        o.push(`interface ${s.label}`, ` encapsulation dot1Q ${s.bind.vlan}`, ...l3lines(s), '!');
      }
    }
  }
  for (const i of dev.ifaces.filter((x) => x.bind.t === 'svi')) {
    if (!i.ip && dev.kind === 'mswitch') continue;
    o.push(`interface Vlan${i.bind.vlan}`, ...l3lines(i), ' no shutdown', '!');
  }
  if (dev.kind === 'mswitch') {
    const mg = dev.ifaces.find((x) => x.id === 'mgmt');
    if (mg && mg.gateway) o.push(`ip default-gateway ${mg.gateway}`, '!');
  }
  const os = dev.ifaces.filter((i) => i.ospf && i.rt && i.rt.ip != null);
  if (os.length) {
    o.push('router ospf 1');
    for (const i of os) o.push(` network ${fmtIp(netOf(i.rt.ip, i.rt.bits))} ${wild(i.rt.bits)} area 0`);
    if (dev.ospfDefault) o.push(' default-information originate');
    o.push('!');
  }
  for (const i of dev.ifaces) if (i.mode === 'static' && i.gateway && dev.routing) o.push(`ip route 0.0.0.0 0.0.0.0 ${i.gateway}`);
  for (const r of dev.routes || []) {
    if (!r.dst || !r.via) continue;
    o.push(`ip route ${r.dst} ${parseMask(r.mask || '') != null ? fmtMask(parseMask(r.mask)) : r.mask} ${r.via}${+r.ad > 1 ? ' ' + r.ad : ''}`);
  }
  for (const r of dev.routes6 || []) if (r.dst && r.via) o.push(`ipv6 route ${r.dst} ${r.via}`);
  const out = dev.ifaces.filter((i) => i.nat);
  for (const i of out) o.push(`ip nat inside source list 1 interface ${i.label} overload`);
  for (const n of dev.staticNat || []) if (n.pub && n.priv) o.push(`ip nat inside source static ${n.priv} ${n.pub}`);
  for (const f of dev.portForwards || []) {
    if (f.port && f.toIp && out[0]) o.push(`ip nat inside source static ${f.proto || 'tcp'} ${f.toIp} ${f.toPort || f.port} interface ${out[0].label} ${f.port}`);
  }
  if (out.length) o.push('access-list 1 permit any');
  for (const i of dev.ifaces) {
    for (const [key, dir] of [['aclIn', 'in'], ['aclOut', 'out']]) {
      if (!i[key] || !i[key].length) continue;
      o.push('!', `ip access-list extended ${aclName(i, dir)}`);
      for (const r of i[key]) o.push(` ${r.action} ${r.proto || 'ip'} ${aclAddr(r.src)} ${aclAddr(r.dst)}${r.port && r.proto !== 'ip' && r.proto !== 'icmp' ? ' eq ' + r.port : ''}`);
    }
  }
  for (const t of dev.vpns || []) {
    o.push('!', `crypto isakmp policy 10`, ` encryption ${(t.enc || 'aes128') === 'aes256' ? 'aes 256' : 'aes'}`, ` hash ${t.hash || 'sha1'}`, ` group ${t.dh || 2}`, ' authentication pre-share',
      `crypto isakmp key ******** address ${t.peer || '(未設定)'}`, `! 通道 ${t.name}：${t.local || '?'} ↔ ${t.remote || '?'}`);
  }
  if (dev.radius && dev.radius.ip) o.push('!', 'radius server AAA', ` address ipv4 ${dev.radius.ip} auth-port 1812 acct-port 1813`, ' key ********');
  if (m) {
    o.push('!');
    if (m.ntp) o.push(`ntp server ${m.ntp}`);
    if (m.syslog) o.push(`logging host ${m.syslog}`);
    const snmp = m.snmp || 'v2c';
    if (snmp === 'v2c') o.push(`snmp-server community ${m.community || 'public'} RO`);
    else if (snmp === 'v3') o.push('snmp-server group NMS v3 priv', 'snmp-server user monitor NMS v3 auth sha ******** priv aes 128 ********');
    o.push(m.http ? 'ip http server' : 'no ip http server', m.https ? 'ip http secure-server' : 'no ip http secure-server');
    const allow = String(m.allow || '').split(/[,\s]+/).map(parseCidr).filter(Boolean);
    if (allow.length) { o.push('ip access-list standard MGMT'); for (const c of allow) o.push(` permit ${fmtIp(c.net)} ${wild(c.bits)}`); }
    const tr = [m.ssh && 'ssh', m.telnet && 'telnet'].filter(Boolean).join(' ') || 'none';
    o.push('line vty 0 4', ` transport input ${tr}`, ...(allow.length ? [' access-class MGMT in'] : []), ' login local');
  }
  o.push('!', 'end');
  return o;
}

const SHOW = {
  'show running-config': (st, d) => runningConfig(st, d),
  'show version': (st, d) => [`${CATALOG[d.model].title}`, `${host(d)} uptime is 3 days, 4 hours`, '（LinkUp 模擬的 IOS 風格介面）'],
  'show ip interface brief': (st, d) => {
    const o = [pad('Interface', 22) + pad('IP-Address', 17) + pad('Method', 8) + pad('Status', 22) + 'Protocol'];
    for (const i of d.ifaces) {
      if (!i.rt || i.rt.active === false) continue;
      const pc = d.sw && i.bind.port && d.sw.ports[i.bind.port];
      const adm = pc && pc.shut;
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
        if (r) o.push(pad(pid, 16) + pad({ root: 'Root', desg: 'Desg', altn: 'Altn' }[r], 6) + pad(r === 'altn' ? 'BLK' : 'FWD', 5) + 'P2p');
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
    return [pad('Neighbor ID', 18) + pad('State', 12) + pad('Address', 17) + 'Interface',
      ...n.map((x) => pad(host(st.devices[x.dev]).slice(0, 16), 18) + pad('FULL/ -', 12) + pad(fmtIp(x.ip), 17) + (d.ifaces.find((i) => i.id === x.iface) || {}).label)];
  },
  'show ip dhcp binding': (st, d) => {
    const o = [pad('IP address', 18) + pad('Client', 22) + 'Type'];
    for (const [key, tbl] of Object.entries(st.leases)) {
      if (!key.startsWith(d.id + '/')) continue;
      for (const [c, ip] of Object.entries(tbl)) o.push(pad(fmtIp(ip), 18) + pad(st.devices[c.split('/')[0]].name, 22) + 'Automatic');
    }
    return o.length > 1 ? o : ['沒有任何租約'];
  },
  'show access-lists': (st, d) => {
    const o = [];
    for (const i of d.ifaces) for (const [key, dir] of [['aclIn', 'in'], ['aclOut', 'out']]) {
      if (!i[key] || !i[key].length) continue;
      o.push(`Extended IP access list ${aclName(i, dir)}`);
      i[key].forEach((r, n) => o.push(`    ${(n + 1) * 10} ${r.action} ${r.proto || 'ip'} ${aclAddr(r.src)} ${aclAddr(r.dst)}${r.port && r.proto !== 'ip' && r.proto !== 'icmp' ? ' eq ' + r.port : ''}`));
    }
    return o.length ? o : ['沒有設定任何 ACL'];
  },
  'show vrrp brief': (st, d) => {
    const v = d.ifaces.filter((i) => i.vrrp && i.vrrp.on);
    if (!v.length) return ['沒有設定 VRRP'];
    return [pad('Interface', 16) + pad('Grp', 5) + pad('Pri', 5) + pad('State', 9) + 'Group addr',
      ...v.map((i) => pad(i.label, 16) + pad(1, 5) + pad(i.vrrp.prio || 100, 5) + pad(i.rt.vrrp ? { master: 'Master', backup: 'Backup', init: 'Init' }[i.rt.vrrp.state] : 'Init', 9) + (i.vrrp.vip || ''))];
  },
};
const CMDS = Object.keys(SHOW);
const match = (tokens, cmd) => {
  const w = cmd.split(' ');
  return tokens.length === w.length && tokens.every((t, i) => w[i].startsWith(t));
};

export function buildCli(ctx, body) {
  const { app, dev } = ctx;
  const prompt = host(dev) + '#';
  const logs = (app.termLog['cli:' + dev.id] ||= [{ t: '唯讀的 IOS 風格介面：設定請用其他分頁的圖形介面，這裡可以看到等效的指令。輸入 ? 查看可用指令。', c: 'dim' }]);
  const hist = (app.termHist['cli:' + dev.id] ||= []);
  let hi = hist.length;
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'term-input', spellcheck: 'false', autocomplete: 'off', placeholder: 'show running-config' });
  const draw = () => {
    out.replaceChildren(...logs.map((l) => h('div', { class: 'tl ' + (l.c || ''), text: l.t || ' ' })));
    out.scrollTop = out.scrollHeight;
  };
  const print = (t, c) => logs.push({ t, c });
  const run = (line) => {
    print(prompt + ' ' + line, 'cmd');
    const tok = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const st = app.state;
    if (!tok.length) { /* 空行 */ } else if (tok[0] === '?' || tok[0] === 'help') {
      print('可用指令（可以縮寫，例如 sh ip int br）：', 'dim');
      CMDS.forEach((c) => print('  ' + c, 'dim'));
      print('  ping <IP>', 'dim');
    } else if (tok[0] === 'cls' || tok[0] === 'clear') logs.length = 0;
    else if ('ping'.startsWith(tok[0]) && tok[0].length >= 2) {
      const ip = parseIp(tok[1] || '');
      if (ip == null) print('% 用法：ping <IPv4 位址>', 'warn');
      else if (!dev.ifaces.some((i) => i.rt && i.rt.ip != null)) print('% 這台設備沒有任何 IP 位址，無法送出封包', 'warn');
      else {
        const r = transact(st, dev.id, { proto: 'icmp', dst: ip });
        app.showTrace(`${dev.name}# ${line}`, r.log, r.hops, r);
        print(`Sending 5, 100-byte ICMP Echos to ${fmtIp(ip)}, timeout is 2 seconds:`);
        print(r.ok ? '!!!!!' : '.....', r.ok ? 'ok' : 'bad');
        print(`Success rate is ${r.ok ? 100 : 0} percent (${r.ok ? 5 : 0}/5)`);
        if (!r.ok) print('  ↳ ' + r.reason, 'hint');
      }
    } else if (['configure', 'conf', 'enable', 'en', 'interface', 'int'].includes(tok[0]) || (tok[0] === 'no')) {
      print('% 這個 CLI 是唯讀的。請在其他分頁用圖形介面修改，再用 show running-config 看對應的指令。', 'warn');
    } else {
      const cmd = CMDS.find((c) => match(tok, c));
      if (cmd) SHOW[cmd](st, dev).forEach((l) => print(l));
      else print(`% Invalid input detected：不認識的指令「${line}」，輸入 ? 查看可用指令`, 'warn');
    }
    draw();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const line = input.value.trim();
      input.value = '';
      if (!line) return;
      hist.push(line); hi = hist.length;
      run(line);
    } else if (e.key === 'ArrowUp') { if (hi > 0) { hi--; input.value = hist[hi]; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
    e.stopPropagation();
  });
  const quick = ['show running-config', 'show ip interface brief', dev.routing ? 'show ip route' : 'show vlan brief',
    isSw(dev) ? 'show spanning-tree' : 'show cdp neighbors', isSw(dev) ? 'show mac address-table' : 'show access-lists'];
  body.append(h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, h('span', { class: 'prompt', text: prompt }), input)),
    h('div', { class: 'chips' }, quick.map((x) => h('button', { class: 'chip btnchip', type: 'button', text: x, onclick: () => { hist.push(x); hi = hist.length; run(x); } }))));
  draw();
}
