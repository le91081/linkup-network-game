// IOS 風格的 CLI：用 show 指令查看狀態；configure terminal 之後可以直接用指令修改設定
import { h, ownKeys, escLine } from './dom.js';
import { fmtIp, parseIp, parseMask, netOf } from '../engine/ip.js';
import { fmtIp6, parseIp6, parseCidr6, net6 } from '../engine/ip6.js';
import { dhcp6Bindings, hits6Of, ACL6_IMPLICIT, DHCP6_PREF, DHCP6_VALID, duidOf } from '../engine/sim6.js';
import { ospf6Area, ospf6Cost, ospf6Dead, ospf6Hello, ospf6Passive, ospf6Prio, ospf6NetType } from '../engine/ospf.js';
import { acl6Text, up6 } from '../engine/ios.js';
import { transact, routeRows, isBridgePort, arpRows, clearArp, hitsOf, fmtDur, portfastOn, macRows, clearMac, macAgeOf, sessionRows, clearSessions, saInfo, isTrunk, dtpSpeaker } from '../engine/sim.js';
import { cdpCfg, lldpCfg, cdpOn, lldpTxOn, lldpRxOn, neighbors, ndCounters, cdpCapText, speaksCdp, speaksLldp } from '../engine/disc.js';
import { dscpName, COS_DSCP_DEFAULT, portTrust, egressOf, classify, QLIMIT } from '../engine/qos.js';
import { ospfArea, ospfCost, ospfPassive, ospfHello, ospfDead, ospfPrio, ospfNetType, isLoopback, ospfProcs, ospfKeys, ospfAreaCfg, ospfAreaType, areaKindText } from '../engine/ospf.js';
import { bgpCfg, fmtComm, BEST_REASON } from '../engine/bgp.js';
import { ikeVer, errdisRows, ERR_CAUSES, vrfOf, pbrHits } from '../engine/sim.js';
import { ERR_RECOVERY_CAUSES } from '../engine/ios.js';
import { fhrpProto, fhrpGroup, trackUp, trackText, trackUsers, slaKey, SLA_FREQ } from '../engine/track.js';
import { archiveFiles, nextArchiveName, cfgDiff, ARCH_MAX_DEFAULT } from '../engine/archive.js';
import { psMax, psMode, psConfigured, camSize, stormLimit, camFull } from '../engine/l2sec.js';
import { iosClock, deviceTime, ntpInfo, logRows, clearLog, syslogStats, uptimeOf, routerId, longIf, SEVERITY, NTP_POLL, vtyRows, idleLimit } from '../engine/ops.js';
import { quietLeft } from '../engine/remote.js';
import { counters, clearCounters, clearedAt, spanDest, debugOf, setDebug, consoleRows } from '../engine/wire.js';
import { ensureFlash, IMAGES, PLATFORM, fsName, flashUsed } from '../engine/files.js';
import { hostKey, vtyMode } from '../engine/remote.js';
import { snmpStats } from '../engine/snmp.js';
import { portByName } from '../engine/ios.js';
import { isIos } from '../engine/ios.js';
import { fmtMask } from '../engine/ip.js';
import { route6Rows } from '../engine/sim6.js';
import { CATALOG, MEDIA, peerOf, portOf, linkInfo, phyConfig } from '../engine/model.js';
import { iosSession, runningConfig, startupConfig, hostName as host, aclName, aclLine } from '../engine/ios.js';
import { ipMtu, l2Mtu, jumboNow, isCat2960, isCat9300, isNexus } from '../engine/mtu.js';

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
  'show version': (st, d) => versionLines(st, d),
  'show ip ssh': (st, d) => {
    const m = d.mgmt || {}, k = m.sshKey;
    if (!k || k.bits < 768) return [`SSH Disabled - version ${m.sshVer === 2 ? '2.0' : '1.99'}`, '%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).',
      ...(!m.domain ? ['（還沒有設定 ip domain name：產生金鑰之前要先有網域名稱）'] : []), ...(/^(Router|Switch)$/i.test(host(d)) ? ['（主機名稱還是原廠的預設值：產生金鑰之前要先改掉）'] : [])];
    return [`SSH Enabled - version ${m.sshVer === 2 ? '2.0' : '1.99'}`, 'Authentication methods:publickey,keyboard-interactive,password',
      `Authentication timeout: ${m.sshTimeout || 120} secs; Authentication retries: ${m.sshRetries || 3}`, 'Minimum expected Diffie Hellman key size : 2048 bits',
      `IOS Keys in SECSH format(ssh-rsa, base64 encoded): ${host(d)}.${m.domain}`, `（RSA 金鑰 ${k.bits} 位元，指紋 ${hostKey(d)}；line vty 的登入方式：${{ local: 'login local（本機帳號）', line: 'login（只問線路密碼，SSH 不能用）', none: 'no login（不驗證）' }[vtyMode(d)]}）`];
  },
  'show crypto key mypubkey rsa': (st, d) => {
    const m = d.mgmt || {}, k = m.sshKey;
    if (!k) return ['% No Signature RSA Keys found in configuration.'];
    return [`% Key pair was generated at: ${iosClock(st, d)}`, `Key name: ${host(d)}.${m.domain || ''}`, 'Key type: RSA KEYS', ` Storage Device: private-config`, ' Usage: General Purpose Key', ' Key is not exportable.', ' Key Data:', `  ${hostKey(d).replace('SHA256:', '30820122 300D0609 2A864886 F70D0101 ').slice(0, 60)} ...（${k.bits} 位元）`];
  },
  'show ip interface brief': (st, d) => {
    const o = [pad('Interface', 24) + pad('IP-Address', 16) + pad('OK? Method', 11) + pad('Status', 22) + 'Protocol'];
    for (const i of d.ifaces) {
      if (!i.rt || i.rt.active === false) continue;
      const pc = d.sw && i.bind.port && d.sw.ports[i.bind.port];
      const adm = (pc && pc.shut) || i.shut;
      o.push(pad(i.bind.t === 'svi' ? 'Vlan' + i.bind.vlan : longIf(i.label), 24) + pad(i.rt.ip != null ? fmtIp(i.rt.ip) : 'unassigned', 16)
        + pad((i.rt.ip != null ? 'YES ' : 'NO  ') + (i.mode === 'static' ? (i.rt.ip != null ? 'manual' : 'unset') : i.mode.toUpperCase()), 11) + pad(adm ? 'administratively down' : i.rt.link ? 'up' : 'down', 22) + (i.rt.link ? 'up' : 'down'));
    }
    if (isSw(d)) {
      for (const p of d.ports) {
        if (!isBridgePort(d, p.id)) continue;
        const up = !!st.rt.links[d.id + ':' + p.id];
        if (!up && !d.sw.ports[p.id].shut) continue;
        o.push(pad(longIf(p.label), 24) + pad('unassigned', 16) + pad('YES unset', 11) + pad(d.sw.ports[p.id].shut ? 'administratively down' : 'up', 22) + (up ? 'up' : 'down'));
      }
    }
    return o;
  },
  'show ap summary': (st, d) => {
    if (d.kind !== 'wlc') return ['% 這個指令只有無線控制器有'];
    const aps = Object.values(st.devices).filter((x) => x.lwap && ((st.dyn.capwap || {})[x.id] || {}).wlc === d.id);
    const o = [`Number of APs: ${aps.filter((x) => (st.dyn.capwap[x.id] || {}).joined).length}`, '',
      pad('AP Name', 33) + pad('Slots', 9) + pad('AP Model', 21) + pad('Ethernet MAC', 16) + pad('Location', 18) + pad('Country', 9) + pad('IP Address', 17) + 'State', '-'.repeat(130)];
    for (const x of aps) {
      const rec = st.dyn.capwap[x.id];
      o.push(pad(x.name, 33) + pad(2, 9) + pad('C9120AXI-T', 21) + pad(dotMac(x.ifaces[0].rt.mac || '0000.0000.0000'), 16) + pad('default location', 18) + pad('TW', 9) + pad(x.ifaces[0].rt.ip != null ? fmtIp(x.ifaces[0].rt.ip) : '0.0.0.0', 17) + (rec.joined ? 'Registered' : 'Joining'));
    }
    const lost = Object.values(st.devices).filter((x) => x.lwap && !aps.includes(x));
    if (lost.length) o.push('', ...lost.map((x) => `（${x.name} 沒有加入這台控制器：${(x.rt.capwap || {}).why || ((st.dyn.capwap || {})[x.id] || {}).why || '找不到控制器'}）`));
    return o;
  },
  'show wlan summary': (st, d) => {
    if (d.kind !== 'wlc') return ['% 這個指令只有無線控制器有'];
    const SEC = { open: '[open]', wep: '[WEP]', wpa2: '[WPA2][PSK][AES]', wpa2wpa3: '[WPA2][WPA3][PSK][SAE][AES]', wpa3: '[WPA3][SAE][AES]', wpa2ent: '[WPA2][802.1x][AES]' };
    return [`Number of WLANs: ${d.wlc.wlans.length}`, '', pad('ID', 5) + pad('Profile Name', 33) + pad('SSID', 33) + pad('Status', 7) + 'Security', '-'.repeat(110),
      ...d.wlc.wlans.map((w) => pad(w.id, 5) + pad(w.ssid || '', 33) + pad(w.ssid || '', 33) + pad(w.on === false ? 'DOWN' : 'UP', 7) + (SEC[w.sec || 'wpa2'] || '') + (w.ft ? '[FT]' : '') + (w.kv ? '[11k/v]' : ''))];
  },
  'show wireless client summary': (st, d) => {
    if (d.kind !== 'wlc') return ['% 這個指令只有無線控制器有'];
    const list = [...(st.rt.clients[d.id] || []).map((c) => ({ c, ap: c.ap, mode: 'Local' })),
      ...Object.values(st.devices).filter((x) => x.lwap && x.rt.capwap && x.rt.capwap.wlc === d.id).flatMap((x) => (st.rt.clients[x.id] || []).map((c) => ({ c, ap: x.id, mode: 'Flex' })))];
    return [`Number of Clients: ${list.length}`, '', pad('MAC Address', 15) + pad('AP Name', 33) + pad('Type ID', 10) + pad('State', 13) + pad('Protocol', 10) + pad('Method', 11) + 'Role', '-'.repeat(100),
      ...list.map(({ c, ap, mode }) => { const a = c.iface.rt.assoc; const w = d.wlc.wlans.find((x) => x.ssid === a.ssid) || {}; return pad(dotMac(c.iface.rt.mac), 15) + pad(st.devices[ap].name, 33) + pad('WLAN ' + (w.id || '?'), 10) + pad(c.iface.rt.ip != null ? 'Run' : 'IP Learn', 13) + pad(a.band === '5GHz' ? '11ac' : '11n(2.4)', 10) + pad(a.sec === 'wpa2ent' ? 'Dot1x' : a.sec === 'open' ? 'None' : 'PSK', 11) + mode; })];
  },
  'show ap dot11 24ghz summary': (st, d) => apRadio(st, d, 'ch24'),
  'show ap dot11 5ghz summary': (st, d) => apRadio(st, d, 'ch5'),
  'show ip route': (st, d) => routeLines(st, d, () => true),
  'show ip route connected': (st, d) => routeLines(st, d, (r) => r.type === 'C' || r.type === 'L'),
  'show ip route static': (st, d) => routeLines(st, d, (r) => r.type === 'S' || r.type === 'D'),
  'show ip route ospf': (st, d) => routeLines(st, d, (r) => r.type === 'O'),
  'show ip route bgp': (st, d) => routeLines(st, d, (r) => r.type === 'B'),
  'show ipv6 route': (st, d) => route6Lines(st, d, () => true),
  'show ipv6 route connected': (st, d) => route6Lines(st, d, (r) => r.type === 'C'),
  'show ipv6 route local': (st, d) => route6Lines(st, d, (r) => r.type === 'L'),
  'show ipv6 route static': (st, d) => route6Lines(st, d, (r) => r.type === 'S'),
  'show ipv6 route ospf': (st, d) => route6Lines(st, d, (r) => r.type === 'O'),
  'show ipv6 interface brief': (st, d) => {
    if (!d.ifaces.some((i) => i.rt && i.rt.v6)) return ['% 這台設備沒有 IPv6'];
    return d.ifaces.filter((i) => i.rt && i.rt.v6 && i.bind.t !== 'mgmt').flatMap((i) => {
      const v = i.rt.v6, upDown = i.rt.link ? '[up/up]' : i.shut ? '[administratively down/down]' : '[down/down]';
      return [`${pad(longIf(i.label), 24)}${upDown}`, ...(v.ll == null ? ['    unassigned'] : ['    ' + fmtIp6(v.ll).toUpperCase(), ...v.addrs.map((a) => '    ' + fmtIp6(a.ip).toUpperCase())])];
    });
  },
  'show ipv6 interface': (st, d) => d.ifaces.filter((i) => i.rt && i.rt.v6 && i.rt.v6.ll != null).flatMap((i) => [...ipv6IfLines(st, d, i), '']),
  'show ipv6 ospf': (st, d) => {
    const o = d.rt.ospf6;
    if (!d.ospf6) return ['% 這台設備沒有設定 OSPFv3（ipv6 router ospf 1）'];
    if (!o || o.norid) return ['%OSPFv3-4-NORTRID: Process 1 could not pick a router-id, please configure manually', '（OSPFv3 的 Router ID 還是 32 位元的 IPv4 格式。這台路由器沒有任何 IPv4 位址，選不出來：在 ipv6 router ospf 1 底下設定 router-id）'];
    const areas = o.areas || [];
    return [` OSPFv3 Router with ID (${fmtIp(o.rid)}) (Process ID 1)`, ' Event-log enabled, Maximum number of events: 1000, Mode: cyclic',
      ...(o.pending ? ['（設定了新的 router-id，要 clear ipv6 ospf process 才會換）'] : []),
      ...(o.abr ? [' It is an area border router'] : []), ...(o.asbr ? [' It is an autonomous system boundary router', ' Redistributing External Routes from,', '   default'] : []),
      ' Router is not originating router-LSAs with maximum metric', ' Initial SPF schedule delay 5000 msecs', ' Minimum hold time between two consecutive SPFs 10000 msecs',
      ' Maximum wait time between two consecutive SPFs 10000 msecs', ' Minimum LSA interval 5 secs', ' Minimum LSA arrival 1000 msecs',
      ` Number of areas in this router is ${areas.length}. ${areas.length} normal 0 stub 0 nssa`, ` Reference bandwidth unit is ${+(d.ospf6.refBw || 100)} mbps`,
      ...areas.flatMap((a) => [`    Area ${a === 0 ? 'BACKBONE(0)' : a}`, `        Number of interfaces in this area is ${Object.values(o.ifs).filter((x) => x.area === a).length}`, '        SPF algorithm executed 2 times'])];
  },
  'show ipv6 ospf neighbor': (st, d) => {
    const o = d.rt.ospf6;
    if (!d.ospf6 || !o) return ['% 這台設備沒有在跑 OSPFv3'];
    if (o.norid) return ['%OSPFv3-4-NORTRID: Process 1 could not pick a router-id, please configure manually'];
    const n = d.rt.nbrs6 || [];
    const two = (v) => String(Math.max(0, Math.ceil(v))).padStart(2, '0');
    const ST = { full: 'FULL', '2way': '2WAY', exstart: 'EXSTART', forming: 'INIT', dying: 'FULL' };
    const role = (x) => (x.role === 'P2P' ? ' -' : x.role === 'WAITING' ? 'DROTHER' : x.role || 'DROTHER');
    const ifId = (x) => { const od = st.devices[x.dev]; const j = od && od.ifaces.findIndex((y) => y.rt && y.rt.v6 && y.rt.v6.ll === x.ip); return j >= 0 ? j + 1 : 0; };
    const notes = n.filter((x) => x.note).map((x) => `（${(st.devices[x.dev] || {}).name}：${x.note}）`);
    return [`            OSPFv3 Router with ID (${fmtIp(o.rid)}) (Process ID 1)`, '',
      pad('Neighbor ID', 16) + pad('Pri', 6) + pad('State', 16) + pad('Dead Time', 12) + pad('Interface ID', 16) + 'Interface',
      ...n.map((x) => pad(fmtIp(x.rid), 16) + pad(x.prio ?? 1, 6) + pad(`${ST[x.state] || 'INIT'}/${role(x)}`, 16) + pad('00:00:' + two(x.state === 'dying' ? x.left : x.dead), 12) + pad(ifId(x), 16) + longIf((d.ifaces.find((i) => i.id === x.iface) || {}).label || '')),
      ...(n.length ? [] : ['（沒有鄰居。OSPFv3 用 link-local 位址互相認識：兩端的全域前綴不一樣也能成為鄰居，但區域與 Hello / Dead 要一致）']), ...notes];
  },
  'show ipv6 ospf interface brief': (st, d) => {
    const o = d.rt.ospf6;
    if (!o || !Object.keys(o.ifs).length) return ['（沒有任何介面啟用 OSPFv3）'];
    const SHORT = { DROTHER: 'DROTH', WAITING: 'WAIT', P2P: 'P2P', LOOP: 'LOOP', PASSIVE: 'DR' };
    return [pad('Interface', 12) + pad('PID', 6) + pad('Area', 16) + pad('Intf ID', 11) + pad('Cost', 6) + pad('State', 6) + 'Nbrs F/C',
      ...d.ifaces.filter((i) => o.ifs[i.id]).map((i) => {
        const f = o.ifs[i.id], nb = (d.rt.nbrs6 || []).filter((x) => x.iface === i.id);
        return pad(i.label.replace('Loopback', 'Lo'), 12) + pad(1, 6) + pad(f.area, 16) + pad(d.ifaces.indexOf(i) + 1, 11) + pad(f.cost, 6) + pad(SHORT[f.state] || f.state, 6) + `${nb.filter((x) => x.state === 'full').length}/${nb.length}`;
      })];
  },
  'show ipv6 dhcp pool': (st, d) => {
    const pools = Object.entries(d.dhcp6Pools || {});
    if (!pools.length) return ['（沒有任何 DHCPv6 位址池）'];
    const binds = dhcp6Bindings(st, d.id);
    return pools.flatMap(([name, pl]) => {
      const used = binds.filter((b) => b.pool === name).length;
      return [`DHCPv6 pool: ${name}`, ...(pl.prefix ? [`  Address allocation prefix: ${pl.prefix.toUpperCase()} valid ${DHCP6_VALID} preferred ${DHCP6_PREF} (${used} in use, 0 conflicts)`] : []),
        ...(pl.dns || []).map((a) => `  DNS server: ${a.toUpperCase()}`), ...(pl.domain ? [`  Domain name: ${pl.domain}`] : []), `  Active clients: ${used}`,
        ...(pl.prefix ? [] : ['（沒有 address prefix：這個位址池只提供 DNS 這些「其他設定」，給 stateless DHCPv6 用）'])];
    });
  },
  'show ipv6 dhcp binding': (st, d) => {
    const b = dhcp6Bindings(st, d.id);
    if (!b.length) return ['（沒有任何 binding。stateful DHCPv6 才會有：RA 要設 M 旗標 (ipv6 nd managed-config-flag)，位址池要有 address prefix）'];
    return b.flatMap((x) => {
      const left = Math.max(0, Math.round(DHCP6_VALID - (st.clock - x.since)));
      return [`Client: ${x.client.toUpperCase()}`, `  DUID: ${x.duid.replace(/-/g, '')}`, '  Username : unassigned', '  VRF : default',
        `  IA NA: IA ID 0x${(x.iaid >>> 0).toString(16).toUpperCase().padStart(8, '0')}, T1 ${DHCP6_PREF / 2}, T2 ${DHCP6_PREF * 0.8}`,
        `    Address: ${x.addr.toUpperCase()}`, `            preferred lifetime ${DHCP6_PREF}, valid lifetime ${DHCP6_VALID}`, `            expires in ${left} seconds`];
    });
  },
  'show ipv6 dhcp interface': (st, d) => {
    const on = d.ifaces.filter((i) => i.dhcp6 || i.relay6);
    if (!on.length) return ['（沒有任何介面是 DHCPv6 伺服器或轉送）'];
    return on.flatMap((i) => i.dhcp6
      ? [`${longIf(i.label)} is in server mode`, `  Using pool: ${i.dhcp6}`, '  Preference value: 0', '  Hint from client: ignored', '  Rapid-Commit: disabled']
      : [`${longIf(i.label)} is in relay mode`, '  Relay destinations:', `    ${i.relay6.toUpperCase()}`]);
  },
  'show ipv6 access-list': (st, d) => {
    const all = Object.entries(d.acl6 || {});
    if (!all.length) return ['（沒有任何 IPv6 ACL）'];
    return all.flatMap(([name, l]) => [`IPv6 access list ${name}`, ...l.slice().sort((a, b) => a.seq - b.seq).map((r) => `    ${acl6Text(r)}${hits6Of(r) ? ` (${hits6Of(r)} match${hits6Of(r) > 1 ? 'es' : ''})` : ''} sequence ${r.seq}`),
      '（結尾隱含：permit icmp any any nd-na、permit icmp any any nd-ns、deny ipv6 any any）']);
  },
  'show vlan brief': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const o = [pad('VLAN', 6) + pad('Name', 18) + pad('Status', 10) + 'Ports', '---- ' + '-'.repeat(17) + ' --------- ' + '-'.repeat(30)];
    for (const v of d.sw.vlans.slice().sort((a, b) => a.id - b.id)) {
      const ports = d.ports.filter((p) => { const pc = d.sw.ports[p.id]; return pc.mode !== 'routed' && !isTrunk(d, p.id) && (pc.vlan === v.id || pc.voice === v.id); }).map((p) => p.label);
      o.push(pad(v.id, 6) + pad(v.name.slice(0, 16), 18) + pad('active', 10) + ports.slice(0, 6).join(', ') + (ports.length > 6 ? ', ...' : ''));
    }
    return o;
  },
  'show interfaces trunk': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const tr = d.ports.filter((p) => isTrunk(d, p.id));
    if (!tr.length) return ['沒有任何 Trunk 埠（dynamic auto 的埠要對面主動要求才會變成 Trunk）'];
    const mode = (pc) => (pc.mode === 'trunk' ? 'on' : pc.mode.replace('dynamic-', ''));
    const o = [pad('Port', 14) + pad('Mode', 13) + pad('Encapsulation', 15) + pad('Status', 12) + 'Native vlan'];
    for (const p of tr) o.push(pad(p.label, 14) + pad(mode(d.sw.ports[p.id]), 13) + pad('802.1q', 15) + pad('trunking', 12) + d.sw.ports[p.id].native);
    const allowed = (pc) => (pc.allowed === 'all' || !pc.allowed ? '1-4094' : pc.allowed);
    const active = (pc) => d.sw.vlans.map((v) => v.id).filter((v) => pc.allowed === 'all' || !pc.allowed || String(pc.allowed).split(',').some((r) => { const [a, b] = r.split('-').map(Number); return b ? v >= a && v <= b : v === a; })).sort((a, b) => a - b);
    o.push('', pad('Port', 14) + 'Vlans allowed on trunk');
    for (const p of tr) o.push(pad(p.label, 14) + allowed(d.sw.ports[p.id]));
    o.push('', pad('Port', 14) + 'Vlans allowed and active in management domain');
    for (const p of tr) o.push(pad(p.label, 14) + (active(d.sw.ports[p.id]).join(',') || 'none'));
    o.push('', pad('Port', 14) + 'Vlans in spanning tree forwarding state and not pruned');
    for (const p of tr) o.push(pad(p.label, 14) + (active(d.sw.ports[p.id]).filter((v) => !(d.rt.stp && d.rt.stp.blocked.has(p.id + '|' + v))).join(',') || 'none'));
    return o;
  },
  'show mac address-table': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const rows = macRows(st, d);
    const o = ['          Mac Address Table', '-------------------------------------------', '', pad('Vlan', 8) + pad('Mac Address', 18) + pad('Type', 12) + 'Ports', pad('----', 8) + pad('-----------', 18) + pad('--------', 12) + '-----'];
    for (const r of rows) o.push(pad(String(r.vlan).padStart(4), 8) + pad(dotMac(r.mac), 18) + pad(r.type, 12) + r.label);
    const bg = rows.bogus;
    if (bg) {
      for (const m of bg.sample) o.push(pad(String(bg.vlan).padStart(4), 8) + pad(dotMac(m), 18) + pad('DYNAMIC', 12) + bg.label);
      o.push(`（… 另外還有 ${(bg.n - bg.sample.length).toLocaleString('en')} 筆，全部學在 ${bg.label}：來源 MAC 都是亂造的，有人在跑 MAC flooding 的工具（macof）。表的容量 ${camSize(d).toLocaleString('en')} 筆已經滿了，新的 MAC 學不進來，目的地不在表裡的訊框只能往整個 VLAN 泛洪）`);
    }
    o.push(`Total Mac Addresses for this criterion: ${rows.length + (bg ? bg.n : 0)}`);
    if (!rows.length && !bg) o.push(`（表是空的。交換器要收到訊框才會學到來源 MAC：讓電腦 ping 一下，項目就會出現；${macAgeOf(d)} 秒沒有再看到就會過期）`);
    return o;
  },
  'show mac address-table count': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const rows = macRows(st, d), bg = rows.bogus, by = {};
    for (const r of rows) { const b = (by[r.vlan] ||= { dyn: 0, st: 0 }); if (r.type === 'STATIC') b.st++; else b.dyn++; }
    if (bg) (by[bg.vlan] ||= { dyn: 0, st: 0 }).dyn += bg.n;
    const total = rows.length + (bg ? bg.n : 0), o = [];
    for (const v of Object.keys(by).sort((a, b) => a - b)) o.push(`Mac Entries for Vlan ${v}:`, '---------------------------', `Dynamic Address Count  : ${by[v].dyn}`, `Static  Address Count  : ${by[v].st}`, `Total Mac Addresses    : ${by[v].dyn + by[v].st}`, '');
    o.push(`Total Mac Address Space Available: ${Math.max(0, camSize(d) - total)}`);
    if (bg) o.push('', `（表滿了：${bg.label} 後面的設備送出大量來源 MAC 都不一樣的訊框。Port Security 限制那個埠最多幾個 MAC 就擋得住；亂造的項目要等 ${macAgeOf(d)} 秒老化，或 clear mac address-table dynamic）`);
    return o;
  },
  'show mac address-table static': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const rows = macRows(st, d).filter((r) => r.type === 'STATIC');
    return ['          Mac Address Table', '-------------------------------------------', '', pad('Vlan', 8) + pad('Mac Address', 18) + pad('Type', 12) + 'Ports', pad('----', 8) + pad('-----------', 18) + pad('--------', 12) + '-----',
      ...rows.map((r) => pad(String(r.vlan).padStart(4), 8) + pad(dotMac(r.mac), 18) + pad(r.type, 12) + r.label), `Total Mac Addresses for this criterion: ${rows.length}`];
  },
  'show storm-control': (st, d) => stormLines(st, d, null),
  'show storm-control broadcast': (st, d) => stormLines(st, d, null),
  'show vlan private-vlan': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const pri = d.sw.vlans.filter((v) => v.pvlan === 'primary'), o = [pad('Primary', 8) + pad('Secondary', 10) + pad('Type', 18) + 'Ports', pad('-------', 8) + pad('---------', 10) + pad('-----------------', 18) + '------------------------------------------'];
    for (const p of pri) {
      const promisc = d.ports.filter((x) => d.sw.ports[x.id].mode === 'pvlan-promisc' && +(d.sw.ports[x.id].pvMap || {}).primary === p.id).map((x) => x.label);
      for (const sid of p.assoc || []) {
        const sv = d.sw.vlans.find((v) => v.id === sid);
        const hosts = d.ports.filter((x) => d.sw.ports[x.id].mode === 'pvlan-host' && +(d.sw.ports[x.id].pvHost || {}).secondary === sid).map((x) => x.label);
        const ord = (l) => d.ports.findIndex((x) => x.label === l);
        o.push(pad(p.id, 8) + pad(sid, 10) + pad(sv ? sv.pvlan || 'non-operational' : 'non-operational', 18) + [...promisc, ...hosts].sort((a, b) => ord(a) - ord(b)).join(', '));
      }
      if (!(p.assoc || []).length) o.push(pad(p.id, 8) + pad('', 10) + pad('', 18) + promisc.join(', '));
    }
    const lone = d.sw.vlans.filter((v) => v.pvlan && v.pvlan !== 'primary' && !pri.some((p) => (p.assoc || []).includes(v.id)));
    for (const v of lone) o.push(pad('none', 8) + pad(v.id, 10) + pad(v.pvlan, 18) + '（還沒有和任何 primary VLAN 關聯：primary 底下要 private-vlan association）');
    return pri.length || lone.length ? o : ['（沒有設定任何 Private VLAN）'];
  },
  'show ipv6 nd raguard policy': (st, d) => {
    if (!isSw(d)) return ['% 這個指令只適用於交換器'];
    const all = Object.entries(d.sw.raPolicies || {});
    if (!all.length) return ['（沒有任何 RA Guard 政策）'];
    return all.flatMap(([n, p]) => [`RA guard policy ${n} configuration:`, `  device-role ${p.role || 'host'}`, 'Policy ' + n + ' is applied on the following targets:', pad('Target', 18) + pad('Type', 6) + pad('Policy', 16) + pad('Feature', 12) + 'Target range',
      ...d.ports.filter((x) => d.sw.ports[x.id].raGuard === n).map((x) => pad(x.label, 18) + pad('PORT', 6) + pad(n, 16) + pad('RA guard', 12) + 'vlan all'), '']);
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
        if (!isTrunk(d, p.id) && pc.vlan !== +v && pc.voice !== +v) continue;
        o.push(pad(p.label, 16) + pad('Desg', 6) + pad(stpState(d, p.id), 5) + (portfastOn(d, pc, p.id) ? 'P2p Edge' : 'P2p'));
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
    const ACT = { shutdown: 'Shutdown', restrict: 'Restrict', protect: 'Protect' };
    return [pad('Secure Port', 12) + pad('MaxSecureAddr', 15) + pad('CurrentAddr', 13) + pad('SecurityViolation', 19) + 'Security Action', pad('', 12) + pad('(Count)', 15) + pad('(Count)', 13) + '(Count)',
      '---------------------------------------------------------------------------',
      ...ps.map((p) => {
        const c = d.sw.ports[p.id].ps, r = (d.rt.psec || {})[p.id], rec = (st.dyn.psec || {})[d.id + ':' + p.id] || { viol: 0 };
        const cur = r ? r.allowed.size : psConfigured(c).length;
        return pad(p.label, 12) + pad(psMax(c), 15) + pad(cur, 13) + pad(rec.viol || 0, 19) + ACT[psMode(c)] + (d.rt.err[p.id] === true ? '   (err-disabled)' : '');
      }), '---------------------------------------------------------------------------',
      `Total Addresses in System (excluding one mac per port)     : ${Math.max(0, ps.reduce((n, p) => n + ((d.rt.psec || {})[p.id] ? d.rt.psec[p.id].allowed.size : 0), 0) - ps.length)}`,
      `Max Addresses limit in System (excluding one mac per port) : ${camSize(d) >= 8192 ? 4096 : 1024}`];
  },
  'show crypto isakmp sa': (st, d) => {
    const o = ['IPv4 Crypto ISAKMP SA', pad('dst', 16) + pad('src', 16) + pad('state', 15) + pad('conn-id', 8) + 'status'];
    cryptoTunnels(d).filter(({ t }) => ikeVer(d, t.cfg) === 1).forEach(({ t }, n) => {
      const sa = saInfo(st, d.id, t.name);
      if (sa) o.push(pad(fmtIp(t.peerIp), 16) + pad(fmtIp(t.localIp), 16) + pad('QM_IDLE', 15) + pad(1001 + n, 8) + 'ACTIVE' + (t.stale ? '   （對端已經沒有回應，這筆 SA 還沒過期）' : ''));
      else if (t.nego) o.push(pad(fmtIp(t.peerIp), 16) + pad(fmtIp(t.localIp), 16) + pad('MM_KEY_EXCH', 15) + pad(0, 8) + 'ACTIVE');
    });
    const v1 = cryptoTunnels(d).filter(({ t }) => ikeVer(d, t.cfg) === 1);
    if (o.length === 2) o.push('', '（沒有任何 IKEv1 的 SA' + (v1.length ? '：' + v1.map(({ t }) => `${t.name} — ${t.why || '尚未建立'}`).join('；') : '') + (cryptoTunnels(d).length > v1.length ? '。IKEv2 的通道請用 show crypto ikev2 sa' : '') + '）');
    return o;
  },
  'show crypto ikev2 sa': (st, d) => {
    const list = cryptoTunnels(d).filter(({ t }) => ikeVer(d, t.cfg) === 2);
    const o = [' IPv4 Crypto IKEv2  SA ', '', pad('Tunnel-id', 10) + pad('Local', 22) + pad('Remote', 22) + pad('fvrf/ivrf', 21) + 'Status'];
    list.forEach(({ t }, n) => {
      const sa = saInfo(st, d.id, t.name);
      if (!sa && !t.nego) return;
      o.push(pad(n + 1, 10) + pad(`${fmtIp(t.localIp)}/500`, 22) + pad(`${fmtIp(t.peerIp)}/500`, 22) + pad('none/none', 21) + (sa ? 'READY' : 'IN-NEG'));
      if (sa) o.push(`      Encr: AES-CBC, keysize: ${(t.cfg.enc || 'aes128') === 'aes256' ? 256 : 128}, PRF: ${(t.cfg.hash || 'sha1').toUpperCase()}, Hash: ${(t.cfg.hash || 'sha1').toUpperCase()}96, DH Grp:${t.cfg.dh || 2}, Auth sign: PSK, Auth verify: PSK`,
        `      Life/Active Time: ${sa.life1}/${sa.life1 - sa.left1} sec`, ...(t.pfsBad ? [`      （注意：${t.pfsBad}。第一次重新協商 CHILD_SA 時會失敗，還有 ${Math.max(0, Math.ceil(t.rekeyFail - st.clock))} 秒）`] : []));
    });
    if (o.length === 3) o.push('', '（沒有任何 IKEv2 SA' + (list.length ? '：' + list.map(({ t }) => `${t.name} — ${t.why || '尚未建立'}`).join('；') : '：crypto map 要 set ikev2-profile 才會用 IKEv2') + '）');
    return o;
  },
  'show crypto ikev2 profile': (st, d) => {
    const profs = Object.entries((d.ikev2 || {}).profs || {});
    if (!profs.length) return ['（沒有任何 IKEv2 profile）'];
    return profs.flatMap(([n, x]) => [`IKEv2 profile: ${n}`, ' Ref Count: ' + (d.vpns || []).filter((t) => t.ikev2 === n).length, ' Match criteria:', '  Fvrf: global', '  Local address/interface: none', '  Identities:', `   address ${x.remote || '(none)'} 255.255.255.255`,
      ' Local identity: none', ' Remote identity: none', ' Local authentication method: pre-share', ' Remote authentication method(s): pre-share', ` Keyring: ${x.keyring || '(none)'}`, ` Lifetime: ${+x.life || 86400} seconds`, '']);
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
    const n = ospfViews(st, d).flatMap((v) => v.nbrs);
    if (!n.length) return ['沒有 OSPF 鄰居'];
    const two = (v) => String(Math.max(0, Math.ceil(v))).padStart(2, '0');
    const rid = (x) => fmtIp(x.rid ?? routerId(st.devices[x.dev]) ?? x.ip);
    const ST = { full: 'FULL', '2way': '2WAY', exstart: 'EXSTART', forming: 'INIT', dying: 'FULL' };
    const role = (x) => (x.role === 'P2P' ? ' -' : x.role === 'WAITING' ? 'DROTHER' : x.role || 'DROTHER');
    const lines = n.map((x) => pad(rid(x), 17) + pad(x.prio ?? 1, 5) + pad(`${ST[x.state] || 'INIT'}/${role(x)}`, 16)
      + pad('00:00:' + two(x.state === 'dying' ? x.left : x.dead), 11) + pad(fmtIp(x.ip), 17) + (d.ifaces.find((i) => i.id === x.iface) || {}).label);
    const notes = n.filter((x) => x.note).map((x) => `（${(st.devices[x.dev] || {}).name}：${x.note}）`);
    return [pad('Neighbor ID', 17) + pad('Pri', 5) + pad('State', 16) + pad('Dead Time', 11) + pad('Address', 17) + 'Interface', ...lines, ...notes];
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
  'show ip protocols': (st, d) => protocolLines(st, d, ''),
  'show ip ospf interface brief': (st, d) => {
    const rows = [];
    const SHORT = { DROTHER: 'DROTH', WAITING: 'WAIT', P2P: 'P2P', LOOP: 'LOOP', PASSIVE: 'DR' };
    for (const v of ospfViews(st, d)) {
      const ifs = (v.o2 && v.o2.ifs) || {};
      for (const i of d.ifaces.filter((x) => ifs[x.id])) {
        const f = ifs[i.id], nb = v.nbrs.filter((n) => n.iface === i.id), full = nb.filter((n) => n.state === 'full');
        rows.push(pad(i.label.replace('Loopback', 'Lo'), 12) + pad(v.pid, 6) + pad(f.area, 16) + pad(`${fmtIp(i.rt.ip)}/${i.rt.bits}`, 20) + pad(f.cost, 6) + pad(SHORT[f.state] || f.state, 6) + `${full.length}/${nb.length}`);
      }
    }
    if (!rows.length) return ['（沒有任何介面啟用 OSPF）'];
    return [pad('Interface', 12) + pad('PID', 6) + pad('Area', 16) + pad('IP Address/Mask', 20) + pad('Cost', 6) + pad('State', 6) + 'Nbrs F/C', ...rows];
  },
  'show ip ospf interface': (st, d) => ospfIfLines(st, d, null),
  'show ip bgp': (st, d) => bgpTable(st, d, null),
  'show ip bgp summary': (st, d) => {
    const b = d.rt.bgp;
    if (!b) return ['% BGP not active'];
    const o = [`BGP router identifier ${fmtIp(b.rid)}, local AS number ${b.asn}`, `BGP table version is ${10 + b.table.length}, main routing table version ${10 + b.table.length}`,
      `${new Set(b.table.map((r) => r.net + '/' + r.bits)).size} network entries using ${new Set(b.table.map((r) => r.net + '/' + r.bits)).size * 248} bytes of memory`,
      `${b.table.length} path entries using ${b.table.length * 136} bytes of memory`, '',
      pad('Neighbor', 16) + pad('V', 5) + pad('AS', 9) + pad('MsgRcvd', 8) + pad('MsgSent', 8) + pad('TblVer', 9) + pad('InQ', 5) + pad('OutQ', 5) + pad('Up/Down', 9) + 'State/PfxRcd'];
    const msgs = (p) => Math.max(1, Math.floor(p.up / 60)) + 3;
    for (const p of b.peers) o.push(pad(p.ip, 16) + pad(4, 5) + pad(p.remoteAs, 9) + pad(p.state === 'Established' ? msgs(p) : 0, 8) + pad(p.state === 'Established' ? msgs(p) + 1 : 0, 8) + pad(10 + b.table.length, 9) + pad(0, 5) + pad(0, 5)
      + pad(p.state === 'Established' ? hms(p.up) : 'never', 9) + (p.state === 'Established' ? String(p.pfx) : p.state));
    const bad = b.peers.filter((p) => p.state !== 'Established' && p.why);
    if (bad.length) o.push('', ...bad.map((p) => `（${p.ip}：${p.why}）`));
    return o;
  },
  'show ip prefix-list': (st, d) => {
    const all = Object.entries(d.prefixLists || {});
    if (!all.length) return ['（沒有任何 prefix-list）'];
    return all.flatMap(([n, l]) => [`ip prefix-list ${n}: ${l.length} entries`, ...l.slice().sort((a, b) => a.seq - b.seq).map((e) => `   seq ${e.seq} ${e.action} ${fmtIp(e.net)}/${e.bits}${e.ge ? ' ge ' + e.ge : ''}${e.le ? ' le ' + e.le : ''}`)]);
  },
  'show route-map': (st, d) => {
    const all = Object.entries(d.routeMaps || {});
    if (!all.length) return ['（沒有任何 route-map）'];
    return all.flatMap(([n, l]) => l.flatMap((e) => { const h = pbrHits(e); return [`route-map ${n}, ${e.action}, sequence ${e.seq}`, '  Match clauses:', ...(e.match.pl ? [`    ip address prefix-lists: ${e.match.pl} `] : []), ...(e.match.acl ? [`    ip address (access-lists): ${e.match.acl} `] : []), ...(e.match.fl ? [`    as-path (as-path filter): ${e.match.fl} `] : []), ...(e.match.tag != null ? [`    tag ${e.match.tag} `] : []), ...(e.match.cl ? [`    Community (community-list filter): ${e.match.cl} `] : []),
      '  Set clauses:', ...(e.set.lp != null ? [`    local-preference ${e.set.lp}`] : []), ...(e.set.prepend ? [`    as-path prepend ${e.set.prepend.join(' ')}`] : []), ...(e.set.med != null ? [`    metric ${e.set.med}`] : []), ...(e.set.metricType ? [`    metric-type type-${e.set.metricType}`] : []), ...(e.set.tag != null ? [`    tag ${e.set.tag}`] : []), ...(e.set.weight != null ? [`    weight ${e.set.weight}`] : []), ...(e.set.comm ? [`    community ${e.set.comm.length ? e.set.comm.join(' ') : 'none'}${e.set.commAdd ? ' additive' : ''}`] : []),
      ...((e.set.nh || []).length ? [`    ip next-hop ${e.set.nh.join(' ')}`] : []), ...((e.set.defNh || []).length ? [`    ip default next-hop ${e.set.defNh.join(' ')}`] : []), `  Policy routing matches: ${h.pk} packets, ${h.by} bytes`]; }));
  },
  'show ip policy': (st, d) => {
    const ifs = d.ifaces.filter((i) => i.policyRm);
    if (!ifs.length && !d.localPolicy) return ['（沒有任何介面套用政策路由：interface 底下 ip policy route-map <名稱>）'];
    return ['Interface      Route map', ...(d.localPolicy ? [pad('local', 15) + d.localPolicy] : []), ...ifs.map((i) => pad(i.label, 15) + i.policyRm + ((d.routeMaps || {})[i.policyRm] ? '' : '  （這個 route-map 不存在：封包照一般的路由表）'))];
  },
  'show ip as-path-access-list': (st, d) => {
    const all = Object.entries(d.asPathAcl || {});
    if (!all.length) return ['（沒有任何 as-path access-list）'];
    return all.flatMap(([n, l]) => [`AS path access list ${n}`, ...l.map((e) => `    ${e.action} ${e.re}`)]);
  },
  'show ip ospf': (st, d) => {
    const vs = ospfViews(st, d).filter((v) => v.o2);
    if (!vs.length) return ['%OSPF: Router process 1 is not running, please configure a router-id'];
    return vs.flatMap((v, k) => [...(k ? [''] : []), ...ospfProcLines(st, d, v)]);
  },
  'show ip ospf database': (st, d) => {
    const vs = ospfViews(st, d).filter((v) => v.o2 && v.db);
    if (!vs.length) return ['%OSPF: Router process 1 is not running'];
    return vs.flatMap((v, k) => [...(k ? [''] : []), ...ospfDbLines(st, d, v)]);
  },
  'show snmp': (st, d) => {
    const m = d.mgmt || {};
    if (!m.snmp || m.snmp === 'off') return ['%SNMP agent not enabled'];
    const bad = snmpStats(st, d).bad;
    return [`Chassis: ${host(d)}`, ...(m.contact ? [`Contact: ${m.contact}`] : []), ...(m.location ? [`Location: ${m.location}`] : []),
      `${bad} SNMP packets input`, `    0 Bad SNMP version errors`, `    ${bad} Unknown community name`, '    0 Illegal operation for community name supplied',
      `SNMP logging: ${m.traps && (m.trapHosts || []).length ? 'enabled' : 'disabled'}`, ...(m.trapHosts || []).map((h) => `    Logging to ${h.ip}.162, 0/10, 0 sent, 0 dropped.`)];
  },
  'show snmp user': (st, d) => {
    const u = (d.mgmt || {}).snmpUser;
    if (!u || d.mgmt.snmp !== 'v3') return ['（沒有任何 SNMPv3 使用者）'];
    const mac = (d.ifaces.find((i) => i.rt && i.rt.mac) || { rt: { mac: '' } }).rt.mac.replace(/:/g, '').toUpperCase();
    return [`User name: ${u.user}`, `Engine ID: 800000090300${mac}`, 'storage-type: nonvolatile        active',
      'Authentication Protocol: SHA', `Privacy Protocol: ${u.priv ? 'AES128' : 'None'}`, `Group-name: ${u.group || d.mgmt.snmpGroup || 'NMS'}`];
  },
  'show snmp host': (st, d) => {
    const m = d.mgmt || {};
    if (!(m.trapHosts || []).length) return ['（沒有設定 Trap 的接收端：snmp-server host）'];
    return (m.trapHosts || []).flatMap((h) => [`Notification host: ${h.ip}  udp-port: 162  type: trap`, `user: ${h.name}  security model: ${h.ver === 'v3' ? 'v3 priv' : 'v2c'}`, ''])
      .concat(m.traps ? [] : ['（還沒有 snmp-server enable traps：設定好了也不會送）']);
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
      const vlan = !pc || pc.mode === 'routed' ? 'routed' : isTrunk(d, p.id) ? 'trunk' : pc.vlan;
      // 前面有 a- 的是自動協商出來的結果，沒有的是手動寫死的設定
      const cfg = phyConfig(d, p.id);
      const dup = cfg.duplex || (li ? 'a-' + li.duplex : 'auto'), spd = cfg.speed != null ? String(cfg.speed) : li ? 'a-' + li.speed : 'auto';
      o.push(pad(p.label, 14) + pad(status, 14) + pad(vlan, 8) + pad(dup, 9) + pad(spd, 9) + MEDIA[p.media].name);
    }
    return o;
  },
  'show system mtu': (st, d) => {
    if (isCat2960(d)) {
      const now = jumboNow(st, d), next = +d.sw.jumbo || 1500;
      return ['', 'System MTU size is 1500 bytes', `System Jumbo MTU size is ${now} bytes`, 'System Alternate MTU size is 1500 bytes', 'Routing MTU size is 1500 bytes',
        ...(next !== now ? [`On next reload, System Jumbo MTU size will be ${next} bytes`, '（system mtu jumbo 要重新開機才生效：先 write memory，再 reload）'] : [])];
    }
    if (isCat9300(d)) return ['', `Global Ethernet MTU is ${+d.sw.sysMtu || 1500} bytes.`];
    if (isNexus(d)) return ['% Nexus 沒有整台的 MTU：每個介面各自設定（show interface ethernet1/1 看 MTU）'];
    return ['% 這台設備沒有 system mtu：路由器的 MTU 在介面上設定（show interfaces 看 MTU）'];
  },
  'show vrf': (st, d) => vrfTable(d, true),
  'show ip vrf': (st, d) => vrfTable(d, false),
  'show archive': (st, d) => {
    const a = d.archive;
    if (!a || !a.path) return ['Archive feature not enabled（先在 archive 底下設定 path flash:<名稱>）'];
    const max = +a.max || ARCH_MAX_DEFAULT, list = archiveFiles(d);
    const o = [`The maximum archive configurations allowed is ${max}.`, `There are currently ${list.length} archive configurations saved.`, `The next archive file will be named ${nextArchiveName(d).replace(/^/, (d.archive.path.match(/^\w+:/) || ['flash:'])[0])}`, ' Archive #  Name'];
    for (let k = 0; k < max; k++) {
      const x = list[k];
      o.push(`   ${String(k + 1).padEnd(9)}${x ? (d.archive.path.match(/^\w+:/) || ['flash:'])[0] + x.name + (k === list.length - 1 ? ' <- Most Recent' : '') : ''}`);
    }
    return o;
  },
  'show interfaces status err-disabled': (st, d) => {
    if (!d.sw) return ['% Invalid input detected（這台設備沒有交換埠）'];
    const rows = errdisRows(st, d);
    const o = [pad('Port', 10) + pad('Name', 19) + pad('Status', 13) + pad('Reason', 21) + 'Err-disabled Vlans'];
    for (const r of rows) o.push(pad(r.pid, 10) + pad((d.sw.ports[r.pid] || {}).desc || '', 19) + pad('err-disabled', 13) + ERR_CAUSES[r.cause]);
    if (!rows.length) o.push('（目前沒有 err-disabled 的埠）');
    return o;
  },
  'show errdisable recovery': (st, d) => {
    if (!d.sw) return ['% Invalid input detected（這台設備沒有交換埠）'];
    const r = d.sw.errRec || { causes: [] };
    const o = [pad('ErrDisable Reason', 29) + 'Timer Status', pad('-----------------', 29) + '--------------'];
    for (const c of ERR_RECOVERY_CAUSES) o.push(pad(c, 29) + ((r.causes || []).includes(c) ? 'Enabled' : 'Disabled'));
    o.push('', `Timer interval: ${+r.interval || 300} seconds`, '', 'Interfaces that will be enabled at the next timeout:', '');
    const rows = errdisRows(st, d).filter((x) => x.left != null);
    if (rows.length) {
      o.push(pad('Interface', 16) + pad('Errdisable reason', 24) + 'Time left(sec)', pad('---------', 16) + pad('-----------------', 24) + '--------------');
      for (const x of rows) o.push(pad(x.pid, 16) + pad(ERR_CAUSES[x.cause], 24) + String(x.left).padStart(6));
    }
    const stuck = errdisRows(st, d).filter((x) => x.left == null);
    if (stuck.length) o.push(`（${stuck.map((x) => x.pid).join('、')} 的原因沒有開 recovery：不會自己恢復，要 shutdown 再 no shutdown）`);
    return o;
  },
  'show cdp': (st, d) => {
    const c = cdpCfg(d);
    if (!c.run) return ['% CDP is not enabled'];
    return ['Global CDP information:', `\tSending CDP packets every ${c.timer} seconds`, `\tSending a holdtime value of ${c.hold} seconds`, `\tSending CDPv2 advertisements is  ${c.v2 ? 'enabled' : 'not enabled'}`];
  },
  'show cdp neighbors': (st, d) => cdpTable(st, d),
  'show cdp neighbors detail': (st, d) => cdpDetail(st, d),
  'show cdp entry *': (st, d) => cdpDetail(st, d),
  'show cdp interface': (st, d) => {
    const c = cdpCfg(d);
    if (!c.run) return ['% CDP is not enabled'];
    const o = [];
    for (const p of d.ports) {
      if (!cdpOn(d, p.id)) continue;
      const up = !!st.rt.links[d.id + ':' + p.id];
      o.push(`${longIf(p.label)} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'}`, '  Encapsulation ARPA', `  Sending CDP packets every ${c.timer} seconds`, `  Holdtime is ${c.hold} seconds`);
    }
    const off = d.ports.filter((p) => !cdpOn(d, p.id)).map((p) => p.label);
    if (off.length) o.push('', `（這些介面關掉了 CDP：${off.join('、')}）`);
    return o;
  },
  'show cdp traffic': (st, d) => {
    if (!cdpCfg(d).run) return ['% CDP is not enabled'];
    const c = ndCounters(st, d);
    return ['CDP counters :', `\tTotal packets output: ${c.cdpOut}, Input: ${c.cdpIn}`, '\tHdr syntax: 0, Chksum error: 0, Encaps failed: 0', '\tNo memory: 0, Invalid packet: 0,',
      '\tCDP version 1 advertisements output: 0, Input: 0', `\tCDP version 2 advertisements output: ${c.cdpOut}, Input: ${c.cdpIn}`];
  },
  'show lldp': (st, d) => {
    const l = lldpCfg(d);
    if (!l.run) return ['% LLDP is not enabled', '（Catalyst 與 ISR 出廠時 LLDP 是關的，要在設定模式下 lldp run）'];
    return ['', 'Global LLDP Information:', '    Status: ACTIVE', `    LLDP advertisements are sent every ${l.timer} seconds`, `    LLDP hold time advertised is ${l.hold} seconds`, '    LLDP interface reinitialisation delay is 2 seconds'];
  },
  'show lldp neighbors': (st, d) => lldpTable(st, d),
  'show lldp neighbors detail': (st, d) => lldpDetail(st, d),
  'show lldp entry *': (st, d) => lldpDetail(st, d),
  'show lldp interface': (st, d) => {
    if (!lldpCfg(d).run) return ['% LLDP is not enabled'];
    return d.ports.flatMap((p) => { const up = !!st.rt.links[d.id + ':' + p.id]; return [`${longIf(p.label)}:`, `    Tx: ${lldpTxOn(d, p.id) ? 'enabled' : 'disabled'}`, `    Rx: ${lldpRxOn(d, p.id) ? 'enabled' : 'disabled'}`, `    Tx state: ${up ? 'IDLE' : 'INIT'}`, `    Rx state: ${up ? 'WAIT FOR FRAME' : 'WAIT PORT OPER'}`, '']; });
  },
  'show lldp traffic': (st, d) => {
    if (!lldpCfg(d).run) return ['% LLDP is not enabled'];
    const c = ndCounters(st, d);
    return ['', 'LLDP traffic statistics: ', `    Total frames out: ${c.lldpOut}`, '    Total entries aged: 0', `    Total frames in: ${c.lldpIn}`, '    Total frames received in error: 0', '    Total frames discarded: 0', '    Total TLVs discarded: 0', '    Total TLVs unrecognized: 0'];
  },
  'show dtp': (st, d) => {
    if (!dtpSpeaker(d)) return ['% 這台設備不支援 DTP'];
    const n = Object.entries(d.sw.ports).filter(([, pc]) => pc.mode !== 'routed' && pc.mode !== 'access' && !pc.noneg).length;
    return ['Global DTP information', '\tSending DTP Hello packets every 30 seconds', '\tDynamic Trunk timeout is 300 seconds', `\t${n} interfaces using DTP`];
  },
  'show interfaces switchport': (st, d) => (isSw(d) ? d.ports.filter((p) => d.sw.ports[p.id].mode !== 'routed').flatMap((p) => [...switchportLines(st, d, p), '']) : ['% 這個指令只適用於交換器']),
  'show power inline': (st, d) => {
    if (!d.ports.some((p) => p.poe)) return ['% 這台交換器沒有 PoE 埠'];
    const budget = CATALOG[d.model].poeBudget || 0;
    const rows = d.ports.filter((p) => p.poe).map((p) => ({ p, e: (st.rt.poe || {})[d.id + ':' + p.id] }));
    const used = rows.reduce((a, r) => a + (r.e && r.e.state === 'on' ? r.e.alloc : 0), 0);
    const o = [`Available:${budget.toFixed(1)}(w)  Used:${used.toFixed(1)}(w)  Remaining:${(budget - used).toFixed(1)}(w)`, '',
      'Interface Admin  Oper       Power   Device              Class Max', '                           (Watts)                            ', '--------- ------ ---------- ------- ------------------- ----- ----'];
    for (const { p, e } of rows) {
      const pc = d.sw.ports[p.id], x = e && st.devices[e.pd];
      const oper = !e ? 'off' : e.state === 'on' ? 'on' : e.state === 'denied' ? 'faulty' : 'off';
      o.push(pad(p.label, 10) + pad(pc.poe === 'never' ? 'off' : 'auto', 7) + pad(oper, 11) + pad(e && e.state === 'on' ? e.alloc.toFixed(1) : '0.0', 8)
        + pad(x ? CATALOG[x.model].title.replace(/^(Cisco|Ubiquiti) /, '').slice(0, 19) : 'n/a', 20) + pad(e ? String(e.cls) : 'n/a', 6) + '30.0');
    }
    const denied = rows.filter((r) => r.e && r.e.state === 'denied');
    if (denied.length) o.push('', `（${denied.map((r) => r.p.label).join('、')} 被拒絕供電：PoE 預算 ${budget} W 已經用完）`);
    return o;
  },
  'show class-map': (st, d) => {
    const all = Object.entries(d.classMaps || {});
    const o = [' Class Map match-any class-default (id 0)', '   Match any ', ''];
    for (const [name, m] of all) {
      o.push(` Class Map match-${m.any ? 'any' : 'all'} ${name}`);
      for (const r of m.rules) o.push('   Match ' + (r.t === 'any' ? 'any' : r.t === 'dscp' ? `  dscp ${r.v.map((x) => `${dscpName(x)} (${x})`).join(' ')}` : r.t === 'cos' ? `cos  ${r.v.join(' ')}` : r.t === 'acl' ? `access-group name ${r.v}` : `protocol ${r.v}`));
      o.push('');
    }
    return o;
  },
  'show policy-map': (st, d) => {
    const all = Object.entries(d.policyMaps || {});
    if (!all.length) return ['（還沒有任何 policy-map）'];
    const o = [];
    for (const [name, pm] of all) {
      o.push(`  Policy Map ${name}`);
      for (const c of pm) {
        o.push(`    Class ${c.cls}`);
        if (c.priority) o.push(c.priority.kbps ? `      priority ${c.priority.kbps} (kbps)` : `      priority ${c.priority.pct} (%)`);
        if (c.bandwidth) o.push(c.bandwidth.kbps ? `      bandwidth ${c.bandwidth.kbps} (kbps)` : c.bandwidth.rpct ? `      bandwidth remaining ${c.bandwidth.rpct} (%)` : `      bandwidth ${c.bandwidth.pct} (%)`);
        if (c.fq) o.push('      fair-queue');
        if (c.set) o.push(`      set dscp ${dscpName(c.set.dscp)}`);
        if (c.police) o.push(`      police cir ${c.police.bps} bc 1500`, '        conform-action transmit ', '        exceed-action drop ');
        if (c.shape) o.push(`      Average Rate Traffic Shaping`, `      cir ${c.shape.bps} (bps)`);
        if (c.child) o.push(`      service-policy ${c.child}`);
      }
    }
    return o;
  },
  'show policy-map interface': (st, d) => d.ifaces.filter((i) => i.qosIn || i.qosOut).flatMap((i) => policyIfLines(st, d, i)),
  'show mls qos': (st, d) => (d.kind !== 'mswitch' ? ['% 這個指令只適用於 Catalyst 2960 這類交換器'] : [`QoS is ${d.sw.qos && d.sw.qos.on ? 'enabled' : 'disabled'}`, 'QoS ip packet dscp rewrite is enabled',
    ...(d.sw.qos && d.sw.qos.on ? [] : ['（mls qos 沒有開：交換器不看也不改封包上的標記，原樣轉送）'])]),
  'show mls qos interface': (st, d) => (d.kind !== 'mswitch' ? ['% 這個指令只適用於 Catalyst 2960 這類交換器'] : d.ports.filter((p) => st.rt.links[d.id + ':' + p.id]).flatMap((p) => [...mlsQosLines(st, d, p), ''])),
  'show mls qos maps cos-dscp': (st, d) => {
    const m = (d.sw && d.sw.qos && d.sw.qos.cosDscp) || COS_DSCP_DEFAULT;
    return ['   Cos-dscp map:', '        cos:   0  1  2  3  4  5  6  7', '     --------------------------------', '       dscp: ' + m.map((x) => String(x).padStart(2)).join(' ')];
  },
  'show vrrp brief': (st, d) => {
    const v = fhrpIfs(d, 'vrrp');
    if (!v.length) return ['（這台沒有設定 VRRP）'];
    const o = [pad('Interface', 19) + pad('Grp', 4) + pad('Pri', 4) + pad('Time', 6) + pad('Own', 4) + pad('Pre', 4) + pad('State', 8) + pad('Master addr', 16) + 'Group addr'];
    for (const i of v) {
      const r = i.rt.vrrp || { state: 'init' }, m = fhrpView(st, d, i);
      const pri = r.prio != null ? r.prio : +i.vrrp.prio || 100;
      o.push(pad(i.label, 19) + pad(fhrpGroup(i.vrrp), 4) + pad(pri, 4) + pad(3000 + Math.round(((256 - pri) * 1000) / 256), 6) + pad(i.vrrp.vip && i.rt.ip != null && i.vrrp.vip === fmtIp(i.rt.ip) ? 'Y' : '', 4) + pad(r.pre ? 'Y' : '', 4)
        + pad({ master: 'Master', backup: 'Backup', init: 'Init' }[r.state], 8) + pad(m.active || 'unknown', 16) + (i.vrrp.vip || ''));
      if (r.wait > 0) o.push(`（聽不到 Master，${Math.ceil(r.wait)} 秒後接手）`);
    }
    return o;
  },
  'show standby brief': (st, d) => {
    const v = fhrpIfs(d, 'hsrp');
    if (!v.length) return ['（這台沒有設定 HSRP）'];
    const o = ['                     P indicates configured to preempt.', '                     |',
      pad('Interface', 12) + pad('Grp', 5) + pad('Pri', 4) + pad('P', 2) + pad('State', 8) + pad('Active', 16) + pad('Standby', 16) + 'Virtual IP'];
    for (const i of v) {
      const r = i.rt.vrrp || { state: 'init' }, m = fhrpView(st, d, i);
      o.push(pad(i.label, 12) + pad(fhrpGroup(i.vrrp), 5) + pad(r.prio != null ? r.prio : +i.vrrp.prio || 100, 4) + pad(r.pre ? 'P' : '', 2) + pad(m.hsrpState, 8)
        + pad(m.active || 'unknown', 16) + pad(m.standby || 'unknown', 16) + (i.vrrp.vip || ''));
    }
    return o;
  },
  'show standby': (st, d) => {
    const v = fhrpIfs(d, 'hsrp');
    if (!v.length) return ['（這台沒有設定 HSRP）'];
    return v.flatMap((i) => {
      const r = i.rt.vrrp || { state: 'init' }, m = fhrpView(st, d, i), g = fhrpGroup(i.vrrp);
      const pri = r.prio != null ? r.prio : +i.vrrp.prio || 100;
      return [`${longIf(i.label)} - Group ${g}`, `  State is ${m.hsrpState}`, `  Virtual IP address is ${i.vrrp.vip || 'unknown'}`,
        `  Active virtual MAC address is 0000.0c07.ac${g.toString(16).padStart(2, '0')}`, '  Hello time 3 sec, hold time 10 sec',
        `  Preemption ${r.pre ? 'enabled' : 'disabled'}`, `  Active router is ${m.active || 'unknown'}`, `  Standby router is ${m.standby || 'unknown'}`,
        `  Priority ${pri} (configured ${+i.vrrp.prio || 100})`,
        ...(i.vrrp.track || []).map((t) => { const u = trackUp(st, d, t.obj); return `    Track object ${t.obj} state ${u.up ? 'Up' : 'Down'} decrement ${t.dec != null ? t.dec : 10}`; }),
        ...(r.why ? [`（${r.why}）`] : []), ...(m.odd ? [m.odd] : []), ''];
    });
  },
  'show track': (st, d) => {
    const T = Object.entries(d.track || {});
    if (!T.length) return ['（這台沒有設定 track 物件）'];
    const now = st.clock;
    return T.flatMap(([n, t]) => {
      const u = trackUp(st, d, n), rec = ((st.dyn && st.dyn.track) || {})[slaKey(d, n)] || { n: 0, at: now };
      const ago = Math.max(0, Math.round(now - rec.at)), hms = [Math.floor(ago / 3600), Math.floor(ago / 60) % 60, ago % 60].map((x) => String(x).padStart(2, '0')).join(':');
      const sla = t.type === 'sla' ? ((st.dyn && st.dyn.sla) || {})[slaKey(d, t.sla)] : null;
      const users = trackUsers(d, n);
      return [`Track ${n}`, `  ${trackText(d, t)}`, `  ${t.type === 'sla' ? 'Reachability' : 'Line protocol'} is ${u.up ? 'Up' : 'Down'}`,
        `    ${rec.n} change${rec.n === 1 ? '' : 's'}, last change ${hms}`,
        ...(t.type === 'sla' ? [`  Latest operation return code: ${sla ? sla.code : 'Unknown'}`, ...(sla && sla.ok ? [`  Latest RTT (millisecs) ${sla.rtt}`] : [])] : []),
        ...(users.length ? ['Tracked by:', ...users.map((x) => '  ' + x)] : []), ...(u.why && !u.up ? [`（${u.why}）`] : [])];
    });
  },
  'show ip sla statistics': (st, d) => {
    const ops = Object.entries(d.sla || {});
    if (!ops.length) return ['（這台沒有設定 IP SLA）'];
    const o = ['IPSLAs Latest Operation Statistics', ''];
    for (const [n, op] of ops) {
      const r = ((st.dyn && st.dyn.sla) || {})[slaKey(d, n)];
      o.push(`IPSLA operation id: ${n}`);
      if (!op.sched || !r) { o.push('        Latest RTT: NoConnection/Busy/Timeout', 'Latest operation start time: Unknown', 'Latest operation return code: Unknown', 'Number of successes: Unknown', 'Number of failures: Unknown', 'Operation time to live: 0', `（還沒有開始探測：${op.sched ? '等下一次計算' : `ip sla schedule ${n} life forever start-time now`}）`, ''); continue; }
      o.push(`        Latest RTT: ${r.ok ? r.rtt + ' milliseconds' : 'NoConnection/Busy/Timeout'}`, `Latest operation start time: ${iosClock({ ...st, clock: r.last }, d)}`,
        `Latest operation return code: ${r.code}`, `Number of successes: ${r.okN}`, `Number of failures: ${r.failN}`, 'Operation time to live: Forever',
        `（每 ${+op.freq || SLA_FREQ} 秒探測一次，下一次在 ${Math.max(0, Math.ceil(r.last + (+op.freq || SLA_FREQ) - st.clock))} 秒後）`, '');
    }
    return o;
  },
  'show ip sla configuration': (st, d) => {
    const ops = Object.entries(d.sla || {});
    if (!ops.length) return ['（這台沒有設定 IP SLA）'];
    return ops.flatMap(([n, op]) => {
      const si = op.src && d.ifaces.find((x) => x.id === op.src);
      return ['IP SLAs Infrastructure Engine-III', `Entry number: ${n}`, 'Type of operation to perform: icmp-echo', `Target address/Source interface: ${op.dst || '(未設定)'}/${si ? longIf(si.label) : '(未設定)'}`,
        'Operation timeout (milliseconds): 5000', 'Type Of Service parameters: 0x0', 'Request size (ARR data portion): 28', 'Verify data: No', 'Vrf Name: ', 'Schedule:',
        `   Operation frequency (seconds): ${+op.freq || SLA_FREQ}  (not considered if randomly scheduled)`, `   Next Scheduled Start Time: ${op.sched ? 'Start Time already passed' : 'Pending trigger'}`,
        `   Life (seconds): ${op.sched ? 'Forever' : '3600'}`, `   Entry Ageout (seconds): never`, ''];
    });
  },
};
// ───────────────────────── CDP / LLDP / switchport ─────────────────────────
/** CDP 表格裡的介面寫法：Gig 0/1、Ten 1/1/1、Eth 1/49 */
const cdpIf = (s) => String(s).replace(/^(GigabitEthernet|Gi)(?=\d)/, 'Gig ').replace(/^(TenGigabitEthernet|Te)(?=\d)/, 'Ten ').replace(/^(Ethernet|Eth)(?=\d)/, 'Eth ');
function cdpTable(st, d) {
  if (!cdpCfg(d).run) return ['% CDP is not enabled'];
  const rows = neighbors(st, d, 'cdp');
  const o = ['Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge', '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,', '                  D - Remote, C - CVTA, M - Two-port Mac Relay', '',
    'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID'];
  for (const r of rows) {
    const tail = pad(cdpIf(r.label), 18) + pad(String(r.left).padStart(5), 11) + pad(r.info.caps.join(' ').padStart(11), 12) + pad(r.info.platform.slice(0, 9), 10) + cdpIf(r.info.port);
    if (r.info.id.length > 16) o.push(r.info.id, ' '.repeat(17) + tail); // 名稱太長時自己一行（真的 IOS 也是這樣）
    else o.push(pad(r.info.id, 17) + tail);
  }
  o.push('', `Total cdp entries displayed : ${rows.length}`);
  if (!rows.length) o.push('（沒有收到任何 CDP 通告：對面不是 Cisco 設備、對面關掉了 CDP，或還沒到下一次通告的時間）');
  return o;
}
function cdpDetail(st, d) {
  if (!cdpCfg(d).run) return ['% CDP is not enabled'];
  const o = [];
  for (const r of neighbors(st, d, 'cdp')) {
    const i = r.info;
    o.push('-------------------------', `Device ID: ${i.id}`, 'Entry address(es): ', ...(i.ip ? [`  IP address: ${i.ip}`] : []),
      `Platform: ${/^Cisco/.test(i.platform) ? i.platform : 'cisco ' + i.platform},  Capabilities: ${cdpCapText(i.caps)} `,
      `Interface: ${longIf(r.label)},  Port ID (outgoing port): ${i.port}`, `Holdtime : ${r.left} sec`, '', 'Version :', i.ver, '', 'advertisement version: 2',
      ...(i.voice ? [`Appliance VLAN-ID TLV: 語音 VLAN ${i.voice}`] : []), ...(i.power ? [`Power drawn: ${i.power.toFixed(3)} Watts`] : []),
      ...(i.native != null ? ["VTP Management Domain: ''", `Native VLAN: ${i.native}`] : []), `Duplex: ${i.duplex}`, 'Management address(es): ', ...(i.ip ? [`  IP address: ${i.ip}`] : []), '');
  }
  o.push(`Total cdp entries displayed : ${neighbors(st, d, 'cdp').length}`);
  return o;
}
const LLDP_CAP = { R: 'R', B: 'B', T: 'T', W: 'W' };
function lldpTable(st, d) {
  if (!lldpCfg(d).run) return ['% LLDP is not enabled', '（Catalyst 與 ISR 出廠時 LLDP 是關的，要在設定模式下 lldp run）'];
  const rows = neighbors(st, d, 'lldp');
  const o = ['Capability codes:', '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device', '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other', '',
    pad('Device ID', 20) + pad('Local Intf', 15) + pad('Hold-time', 11) + pad('Capability', 16) + 'Port ID'];
  for (const r of rows) o.push(pad(r.info.id.slice(0, 19), 20) + pad(r.label, 15) + pad(r.hold, 11) + pad(r.info.caps.map((c) => LLDP_CAP[c] || c).join(','), 16) + r.info.port);
  o.push('', `Total entries displayed: ${rows.length}`);
  return o;
}
function lldpDetail(st, d) {
  if (!lldpCfg(d).run) return ['% LLDP is not enabled'];
  const o = [];
  for (const r of neighbors(st, d, 'lldp')) {
    const i = r.info, x = st.devices[r.dev];
    const mac = x && ((x.ifaces.find((y) => y.rt && y.rt.mac) || {}).rt || {}).mac;
    o.push('------------------------------------------------', `Local Intf: ${r.label}`, `Chassis id: ${mac ? dotMac(mac) : i.id}`, `Port id: ${i.port}`, `Port Description: ${longIf(i.port)}`, `System Name: ${i.id}`, '',
      'System Description: ', i.ver, '', `Time remaining: ${r.left} seconds`, `System Capabilities: ${i.caps.join(',')}`, `Enabled Capabilities: ${i.caps.join(',')}`,
      'Management Addresses:', i.ip ? `    IP: ${i.ip}` : '    （沒有）', 'Auto Negotiation - supported, enabled', 'Physical media capabilities:', '    1000baseT(FD)', '    100base-TX(FD)', 'Media Attachment Unit type: 30',
      ...(i.native != null ? [`Vlan ID: ${i.native}`] : []),
      ...(i.med ? ['', 'MED Information:', '', '    MED Codes:', '          (NP) Network Policy, (LI) Location Identification', '          (PS) Power Source Entity, (PD) Power Device', '          (IN) Inventory', '',
        '    H/W revision: 1', '    F/W revision: ' + i.ver, '    Manufacturer: Cisco Systems, Inc.', '    Model: ' + i.platform, '    Capabilities: NP, PD, IN', '    Device type: Endpoint Class III', `    PD device, Power source: Unknown, Power Priority: High, Wattage: ${i.power || 6.3}`] : []),
      ...(i.voice ? ['', `    Network Policy(Voice): VLAN ${i.voice}, tagged, Layer-2 priority: 5, DSCP: 46`, '    （LLDP-MED：交換器告訴電話語音 VLAN 是幾號）'] : []), '');
  }
  o.push(`Total entries displayed: ${neighbors(st, d, 'lldp').length}`);
  return o;
}
/** show port-security interface <埠> */
function psecIfLines(st, d, p) {
  const pc = d.sw.ports[p.id], c = pc.ps;
  if (!c) return ['Port Security              : Disabled', 'Port Status                : Secure-down', 'Violation Mode             : Shutdown', 'Maximum MAC Addresses      : 1', 'Total MAC Addresses        : 0'];
  const r = (d.rt.psec || {})[p.id], rec = (st.dyn.psec || {})[d.id + ':' + p.id] || { viol: 0, dyn: [] };
  const err = d.rt.err[p.id] === true, cfg = psConfigured(c);
  const status = !c.on ? 'Secure-down' : err ? 'Secure-shutdown' : st.rt.links[d.id + ':' + p.id] ? 'Secure-up' : 'Secure-down';
  const total = r ? r.allowed.size : cfg.length;
  const last = rec.last ? (rec.last === 'macof' ? '（macof 亂造的 MAC）' : rec.last.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.')) : '0000.0000.0000';
  return [`Port Security              : ${c.on ? 'Enabled' : 'Disabled'}`, `Port Status                : ${status}`, `Violation Mode             : ${({ shutdown: 'Shutdown', restrict: 'Restrict', protect: 'Protect' })[psMode(c)]}`,
    'Aging Time                 : 0 mins', 'Aging Type                 : Absolute', 'SecureStatic Address Aging : Disabled',
    `Maximum MAC Addresses      : ${psMax(c)}`, `Total MAC Addresses        : ${total}`, `Configured MAC Addresses   : ${String(c.macs || '').split(/[,\s]+/).filter(Boolean).length}`, `Sticky MAC Addresses       : ${String(c.stickyMacs || '').split(/[,\s]+/).filter(Boolean).length}`,
    `Last Source Address:Vlan   : ${last}:${pc.vlan}`, `Security Violation Count   : ${rec.viol || 0}`,
    ...(r && r.bad.length && psMode(c) !== 'shutdown' ? [`（違規的訊框被丟掉了：${psMode(c) === 'protect' ? 'protect 不記紀錄也不計次數' : 'restrict 會記一筆 syslog、違規次數加一'}，埠本身維持 up）`] : []),
    ...(err ? ['（埠因為違規被關閉 (err-disabled)：排除原因之後 shutdown 再 no shutdown，或設定 errdisable recovery cause psecure-violation）'] : [])];
}
/** show storm-control [介面] */
function stormLines(st, d, only) {
  if (!isSw(d)) return ['% 這個指令只適用於交換器'];
  const list = d.ports.filter((p) => (only ? p === only : d.sw.ports[p.id].storm));
  if (!list.length) return ['（沒有任何連接埠設定 storm-control）'];
  const o = [pad('Interface', 11) + pad('Filter State', 15) + pad('Upper', 13) + pad('Lower', 13) + 'Current', pad('---------', 11) + pad('-------------', 15) + pad('-----------', 13) + pad('-----------', 13) + '----------'];
  for (const p of list) {
    const pc = d.sw.ports[p.id], li = st.rt.links[d.id + ':' + p.id] && linkInfo(st, d.id, p.id), speed = (li && li.speed) || 1000;
    const lim = stormLimit(pc, speed);
    // 從這個埠進來的廣播：看狂送廣播的設備在不在這個埠後面
    const k = (st.rt.links[d.id + ':' + p.id] || {}).cable + '>' + d.id, cur = ((st.rt.bcast || {})[k] || 0) / speed * 100;
    const state = d.rt.err[p.id] === 'storm' ? 'Link Down' : !li ? 'Link Down' : lim != null && cur > +pc.storm.bcast ? 'Blocking' : 'Forwarding';
    const pct = (x) => (x == null ? '100.00%' : (+x).toFixed(2) + '%');
    o.push(pad(p.label, 11) + pad(state, 15) + pad(pct(pc.storm && pc.storm.bcast), 13) + pad(pct(pc.storm && pc.storm.bcast), 13) + pct(Math.min(100, cur)));
  }
  return o;
}
/** show interfaces <埠> switchport */
function switchportLines(st, d, p) {
  const pc = d.sw.ports[p.id], t = (d.rt.dtp || {})[p.id] || { oper: 'down' };
  const vname = (v) => { const x = d.sw.vlans.find((y) => y.id === v); return x ? x.name.replace(/\s+/g, '_') : 'Inactive'; };
  const pvl = pc.mode === 'pvlan-host' ? 'private-vlan host' : pc.mode === 'pvlan-promisc' ? 'private-vlan promiscuous' : null;
  const adm = pvl || (pc.mode === 'dynamic-auto' ? 'dynamic auto' : pc.mode === 'dynamic-desirable' ? 'dynamic desirable' : pc.mode === 'trunk' ? 'trunk' : 'static access');
  const oper = t.oper === 'down' ? 'down' : pvl || (t.oper === 'trunk' ? 'trunk' : 'static access');
  const neg = dtpSpeaker(d) && pc.mode !== 'access' && !pc.noneg;
  return [`Name: ${p.label}`, 'Switchport: Enabled', `Administrative Mode: ${adm}`, `Operational Mode: ${oper}`, 'Administrative Trunking Encapsulation: dot1q',
    `Operational Trunking Encapsulation: ${t.oper === 'trunk' ? 'dot1q' : 'native'}`, `Negotiation of Trunking: ${neg ? 'On' : 'Off'}`,
    `Access Mode VLAN: ${pc.vlan} (${pc.vlan === 1 ? 'default' : vname(pc.vlan)})`, `Trunking Native Mode VLAN: ${pc.native} (${pc.native === 1 ? 'default' : vname(pc.native)})`,
    `Administrative Native VLAN tagging: ${d.sw.tagNative ? 'enabled' : 'disabled'}`, `Voice VLAN: ${pc.voice ? `${pc.voice} (${vname(pc.voice)})` : 'none'}`,
    `Administrative private-vlan host-association: ${pc.pvHost ? `${pc.pvHost.primary} (${vname(pc.pvHost.primary)}) ${pc.pvHost.secondary} (${vname(pc.pvHost.secondary)})` : 'none'}`,
    `Administrative private-vlan mapping: ${pc.pvMap ? `${pc.pvMap.primary} (${vname(pc.pvMap.primary)}) ${(pc.pvMap.secondaries || []).join(',')}` : 'none'}`,
    `Operational private-vlan: ${pc.mode === 'pvlan-host' && pc.pvHost ? `${pc.pvHost.primary} (${vname(pc.pvHost.primary)}) ${pc.pvHost.secondary} (${vname(pc.pvHost.secondary)})` : pc.mode === 'pvlan-promisc' && pc.pvMap ? `${pc.pvMap.primary} (${vname(pc.pvMap.primary)}) ${(pc.pvMap.secondaries || []).join(',')}` : 'none'}`,
    `Trunking VLANs Enabled: ${pc.allowed === 'all' || !pc.allowed ? 'ALL' : pc.allowed}`, 'Pruning VLANs Enabled: 2-1001', 'Capture Mode Disabled', 'Capture VLANs Allowed: ALL', '',
    `Protected: ${pc.protected ? 'true' : 'false'}`, 'Unknown unicast blocked: disabled', 'Unknown multicast blocked: disabled', 'Appliance trust: none',
    ...(t.why ? [`（DTP：${t.why}）`] : []), ...(pc.noneg ? ['（nonegotiate：這個埠不送 DTP，對面的 dynamic 埠不會因為它而變成 Trunk）'] : [])];
}

// ───────────────────────── BGP ─────────────────────────
/** 有類別的網段（A /8、B /16、C /24）不印長度，其他的才印，和 IOS 一樣 */
const bgpNet = (r) => { const a = r.net >>> 24, cls = a < 128 ? 8 : a < 192 ? 16 : 24; return r.bits === cls || (r.net === 0 && r.bits === 0) ? fmtIp(r.net) : `${fmtIp(r.net)}/${r.bits}`; };
/** show ap dot11 24ghz | 5ghz summary：RRM 指定的頻道 */
function apRadio(st, d, k) {
  if (d.kind !== 'wlc') return ['% 這個指令只有無線控制器有'];
  const aps = Object.values(st.devices).filter((x) => x.lwap && x.rt.capwap && x.rt.capwap.joined && x.rt.capwap.wlc === d.id);
  return [pad('AP Name', 33) + pad('Mac Address', 16) + pad('Slot', 6) + pad('Admin State', 13) + pad('Oper State', 12) + pad('Width', 7) + pad('Txpwr', 10) + 'Channel', '-'.repeat(110),
    ...aps.map((x) => pad(x.name, 33) + pad(dotMac(x.ifaces[0].rt.mac || '0000.0000.0000'), 16) + pad(k === 'ch24' ? 0 : 1, 6) + pad('Enabled', 13) + pad('Up', 12) + pad(k === 'ch24' ? 20 : 40, 7) + pad(`*${{ low: 6, mid: 4, high: 1 }[x.wifi.power || 'mid']}/8`, 10) + `(${x.rt.rrm ? x.rt.rrm[k] : '-'})*`),
    '', '（* 代表由 RRM 自動指定）'];
}

// ── show ip route：和真的 IOS 一樣依主網段 (classful) 分組、列出介面自己的位址 (L)、動態路由的存在時間 ──
const ROUTE_CODES = ['Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
  '       + - replicated route, % - next hop override', ''];
/** A / B / C 類的主網段長度 */
const classBits = (net) => { const a = net >>> 24; return a < 128 ? 8 : a < 192 ? 16 : 24; };
/** 路由存在多久：一天以內 hh:mm:ss，再久就是 1d02h */
const rtAge = (st, r) => {
  const s = Math.max(0, Math.floor(st.clock - (r.since ?? st.clock)));
  return s < 86400 ? hms(s) : `${Math.floor(s / 86400)}d${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`;
};
/** 路由代碼：O IA、O*E2、S*、B* … （DHCP 學到的預設路由在 IOS 也是 S*） */
const routeCode = (r) => { const t = r.type === 'D' ? 'S' : r.type, def = r.bits === 0 ? '*' : ''; return t + def + (r.sub ? (def ? '' : ' ') + r.sub : ''); };
/**
 * 真正放進路由表的路：每個網段只留管理距離（再來是 metric）最好的那一種，等價的全部留下；再加上每個介面自己的 /32 (L)。
 * 沒放進去的（下一站不通的靜態路由、管理距離比較大的備援路由）另外列出來，畫面上用提示說明原因
 */
function ribOf(d, vrf = '') {
  const all = (d.rt.routes || []).filter((r) => (r.vrf || '') === vrf), key = (r) => r.net + '/' + r.bits, best = {};
  for (const r of all) {
    if (r.bad) continue;
    const b = best[key(r)];
    if (!b || r.ad < b.ad || (r.ad === b.ad && r.metric < b.metric)) best[key(r)] = r;
  }
  const rib = [], out = [];
  for (const r of all) { const b = best[key(r)]; (!r.bad && b && b.ad === r.ad && b.metric === r.metric && b.type === r.type ? rib : out).push(r); }
  for (const i of d.ifaces) if (i.rt && i.rt.ip != null && i.rt.link && i.rt.bits < 32 && vrfOf(i) === vrf) rib.push({ net: i.rt.ip, bits: 32, via: null, iface: i, type: 'L', ad: 0, metric: 0 });
  rib.sort((a, b) => a.net - b.net || a.bits - b.bits); // 穩定排序：等價的路維持原本的順序
  return { rib, out };
}
const routeTail = (st, r) => {
  if (r.type === 'C' || r.type === 'L') return `is directly connected, ${longIf(r.iface.label)}`;
  const m = `[${r.ad}/${r.metric}] via ${fmtIp(r.via)}`;
  if (r.type === 'O') return `${m}, ${rtAge(st, r)}, ${longIf(r.iface.label)}`;
  if (r.type === 'B') return `[${r.ad}/${r.metric}] via ${fmtIp(r.bnh ?? r.via)}, ${rtAge(st, r)}`; // BGP 的下一站要再查一次路由表（遞迴），所以不寫介面
  return r.exitIf && r.iface ? `${m}, ${longIf(r.iface.label)}` : m; // 靜態路由只寫下一站；有寫出口介面的才印介面
};
function routeLines(st, d, keep, vrf = '') {
  if (!d.routing) {
    // L2 交換器沒有路由表：只有管理用的預設閘道
    const gw = d.ifaces.find((i) => i.rt && i.rt.gw != null);
    return [gw ? `Default gateway is ${fmtIp(gw.rt.gw)}` : 'Default gateway is not set', '', 'Host               Gateway           Last Use    Total Uses  Interface', 'ICMP redirect cache is empty',
      '（這是一台 L2 交換器，沒有啟用 ip routing：它只有管理用的預設閘道，不會替別人轉送封包）'];
  }
  const { rib, out } = ribOf(d, vrf);
  const def = rib.filter((r) => r.bits === 0).sort((a, b) => a.ad - b.ad)[0];
  const o = [...(vrf ? ['', `Routing Table: ${vrf}`] : []), ...ROUTE_CODES, def ? `Gateway of last resort is ${fmtIp(def.via)} to network 0.0.0.0` : 'Gateway of last resort is not set', ''];
  // 依主網段分組；比主網段還大的（預設路由、supernet）自己一組、不印標題
  const groups = [];
  for (const r of rib.filter(keep)) {
    const cb = classBits(r.net), major = r.bits >= cb ? netOf(r.net, cb) : null;
    let g = groups[groups.length - 1];
    if (!g || major == null || g.major !== major) { g = { major, cb, rows: [] }; groups.push(g); }
    g.rows.push(r);
  }
  for (const g of groups) {
    const nets = new Set(g.rows.map((r) => r.net + '/' + r.bits)), masks = new Set(g.rows.map((r) => r.bits));
    const header = g.major != null && !(nets.size === 1 && g.rows[0].bits === g.cb);
    if (header) {
      o.push(masks.size === 1 ? `      ${fmtIp(g.major)}/${g.rows[0].bits} is subnetted, ${nets.size} subnets`
        : `      ${fmtIp(g.major)}/${g.cb} is variably subnetted, ${nets.size} subnets, ${masks.size} masks`);
    }
    const width = header ? 9 : 6, withMask = !header || masks.size > 1;
    let prev = null;
    for (const r of g.rows) {
      const dst = fmtIp(r.net) + (withMask ? '/' + r.bits : '');
      // 等價多路徑：第二條以後只印「[AD/metric] via …」，對齊在第一條的 [ 底下
      if (prev && prev.net === r.net && prev.bits === r.bits && prev.type === r.type && r.via != null) o.push(' '.repeat(width + dst.length + 1) + routeTail(st, r));
      else o.push(routeCode(r).padEnd(width) + dst + ' ' + routeTail(st, r));
      prev = r;
    }
  }
  const hidden = out.filter(keep);
  if (hidden.length) {
    o.push('');
    for (const r of hidden) {
      const what = `${routeCode(r)} ${fmtIp(r.net)}/${r.bits} [${r.ad}/${r.metric}] via ${fmtIp(r.via)}`;
      o.push(r.bad ? `（沒有放進路由表：${what}。${r.bad}）` : `（沒有放進路由表：${what}。同一個網段已經有管理距離更小的路，這條是備援，平常不會用到）`);
    }
  }
  return o;
}
/** show ip route <位址> [遮罩]：單一網段的詳細資料 */
function routeEntry(st, d, rs) {
  const r = rs[0], def = r.bits === 0;
  const o = [`Routing entry for ${fmtIp(r.net)}/${r.bits}${r.bits < classBits(r.net) ? ', supernet' : ''}`];
  const metricLine = (m) => `      Route metric is ${m}, traffic share count is 1`;
  if (r.type === 'C' || r.type === 'L') {
    o.push(`  Known via "connected", distance 0, metric 0 (connected${r.type === 'C' ? ', via interface' : ''})`, '  Routing Descriptor Blocks:', `  * directly connected, via ${longIf(r.iface.label)}`, metricLine(0));
  } else if (r.type === 'S' || r.type === 'D') {
    o.push(`  Known via "static", distance ${r.ad}, metric 0${def ? ', candidate default path' : ''}`, '  Routing Descriptor Blocks:');
    rs.forEach((x, k) => o.push(`  ${k ? ' ' : '*'} ${fmtIp(x.via)}`, metricLine(0)));
  } else if (r.type === 'O') {
    const type = { IA: 'inter area', E2: 'extern 2', E1: 'extern 1', N2: 'NSSA extern 2', N1: 'NSSA extern 1' }[r.sub] || 'intra area';
    const pid = r.vrf ? +((d.ospfVrf || {})[r.vrf] || {}).pid || 1 : 1;
    if (/^[EN][12]$/.test(r.sub || '')) o.push(`  Known via "ospf ${pid}", distance 110, metric ${r.metric}${def ? ', candidate default path' : ''}`, `  Tag ${r.tag ?? (def ? 1 : 0)}, type ${type}${/2$/.test(r.sub) ? `, forward metric ${r.fwd ?? 1}` : ''}`);
    else o.push(`  Known via "ospf ${pid}", distance 110, metric ${r.metric}${def ? ', candidate default path' : ''}, type ${type}`);
    o.push(`  Last update from ${fmtIp(r.via)} on ${longIf(r.iface.label)}, ${rtAge(st, r)} ago`, '  Routing Descriptor Blocks:');
    rs.forEach((x, k) => o.push(`  ${k ? ' ' : '*'} ${fmtIp(x.via)}, from ${x.adv != null ? fmtIp(x.adv) : fmtIp(x.via)}, ${rtAge(st, x)} ago, via ${longIf(x.iface.label)}`, metricLine(x.metric)));
  } else if (r.type === 'B') {
    const asn = (bgpCfg(d) || {}).asn, path = r.aspath || [];
    const nh = (x) => x.bnh ?? x.via;
    o.push(`  Known via "bgp ${asn}", distance ${r.ad}, metric ${r.metric}${def ? ', candidate default path' : ''}`, `  Tag ${path[0] ?? 0}, type ${r.ibgp ? 'internal' : 'external'}`,
      `  Last update from ${fmtIp(nh(r))} ${rtAge(st, r)} ago`, '  Routing Descriptor Blocks:');
    rs.forEach((x, k) => o.push(`  ${k ? ' ' : '*'} ${fmtIp(nh(x))}, from ${fmtIp(nh(x))}, ${rtAge(st, x)} ago`, metricLine(x.metric), `      AS Hops ${path.length}`, `      Route tag ${path[0] ?? 0}`, '      MPLS label: none',
      ...(x.ibgp && x.via !== x.bnh ? [`      （下一站 ${fmtIp(x.bnh)} 不在直連的網段上：轉送時再查一次路由表，實際從 ${longIf(x.iface.label)} 交給 ${fmtIp(x.via)}）`] : [])));
  }
  return o;
}

// ── show ipv6 route：IOS 的格式（每筆兩行，L 是介面自己的 /128，最後有 FF00::/8） ──
const ROUTE6_CODES = ['Codes: C - Connected, L - Local, S - Static, U - Per-user Static route',
  '       B - BGP, R - RIP, H - NHRP, I1 - ISIS L1',
  '       I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary, D - EIGRP',
  '       EX - EIGRP external, ND - ND Default, NDp - ND Prefix, DCE - Destination',
  '       NDr - Redirect, RL - RPL, O - OSPF Intra, OI - OSPF Inter',
  '       OE1 - OSPF ext 1, OE2 - OSPF ext 2, ON1 - OSPF NSSA ext 1',
  '       ON2 - OSPF NSSA ext 2, a - Application'];
const v6up = (n) => fmtIp6(n).toUpperCase();
const code6 = (r) => (r.type === 'O' ? (r.sub === 'IA' ? 'OI' : r.sub === 'E2' ? 'OE2' : 'O') : r.type);
/** 放進 IPv6 路由表的路：每個前綴只留管理距離最好的那種（等價的全部留），加上 L 與 FF00::/8 */
function rib6Of(d) {
  const all = d.rt.routes6 || [], key = (r) => r.net + '/' + r.bits, best = {};
  for (const r of all) { if (r.bad) continue; const b = best[key(r)]; if (!b || r.ad < b.ad || (r.ad === b.ad && r.metric < b.metric)) best[key(r)] = r; }
  const rib = [], out = [];
  for (const r of all) { const b = best[key(r)]; (!r.bad && b && b.ad === r.ad && b.metric === r.metric && b.type === r.type ? rib : out).push(r); }
  if (d.routing) {
    for (const i of d.ifaces) for (const a of (i.rt && i.rt.v6 ? i.rt.v6.addrs : [])) rib.push({ net: a.ip, bits: 128, via: null, iface: i, type: 'L', ad: 0, metric: 0 });
    rib.push({ net: parseIp6('ff00::'), bits: 8, via: null, iface: null, type: 'L', ad: 0, metric: 0, null0: true });
  }
  rib.sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : a.bits - b.bits));
  return { rib, out };
}
function route6Lines(st, d, keep) {
  if (!d.routing) return ['% 這台設備沒有 IPv6 路由功能'];
  if (!d.v6routing) return ['% IPv6 routing not enabled（ipv6 unicast-routing）'];
  const { rib, out } = rib6Of(d);
  const rows = rib.filter(keep);
  const o = [`IPv6 Routing Table - default - ${new Set(rib.map((r) => r.net + '/' + r.bits)).size} entries`, ...ROUTE6_CODES];
  let prev = null;
  for (const r of rows) {
    const same = prev && prev.net === r.net && prev.bits === r.bits && prev.type === r.type;
    if (!same) o.push(`${pad(code6(r), 4)}${v6up(r.net)}/${r.bits} [${r.ad}/${r.metric}]${r.sub === 'E2' ? ', tag 1' : ''}`);
    if (r.null0) o.push('     via Null0, receive');
    else if (r.type === 'C') o.push(`     via ${longIf(r.iface.label)}, directly connected`);
    else if (r.type === 'L') o.push(`     via ${longIf(r.iface.label)}, receive`);
    else if (r.type === 'O') o.push(`     via ${v6up(r.via)}, ${longIf(r.iface.label)}`);
    else o.push(`     via ${v6up(r.via)}${isLl6(r.via) && r.iface ? ', ' + longIf(r.iface.label) : ''}`);
    prev = r;
  }
  const hidden = out.filter(keep);
  if (hidden.length) o.push('', ...hidden.map((r) => `（沒有放進路由表：${code6(r)} ${v6up(r.net)}/${r.bits} via ${r.via != null ? v6up(r.via) : '-'}。${r.bad || '同一個前綴已經有管理距離更小的路'}）`));
  return o;
}
const isLl6 = (ip) => ip != null && (ip >> 118n) === 0x3fan;
/** show ipv6 route <位址或前綴> */
function route6Entry(st, d, rs) {
  const r = rs[0];
  const o = [`Routing entry for ${v6up(r.net)}/${r.bits}`];
  if (r.type === 'C' || r.type === 'L') {
    o.push(`  Known via "${r.type === 'C' ? 'connected' : 'local'}", distance 0, metric 0, type ${r.type === 'C' ? 'connected' : 'receive'}`, '  Route count is 1/1, share count 0', '  Routing paths:',
      r.null0 ? '    receive' : `    directly connected via ${longIf(r.iface.label)}`, '      Last updated 00:00:00 ago');
    return o;
  }
  const how = r.type === 'O' ? `"ospf 1", distance 110, metric ${r.metric}, type ${r.sub === 'IA' ? 'inter area' : r.sub === 'E2' ? 'extern 2' : 'intra area'}` : `"static", distance ${r.ad}, metric 0`;
  o.push(`  Known via ${how}`, `  Route count is ${rs.length}/${rs.length}, share count 0`, '  Routing paths:');
  for (const x of rs) {
    o.push(`    ${v6up(x.via)}${x.iface ? ', ' + longIf(x.iface.label) : ''}`, `      Route metric is ${x.metric}, traffic share count is 1`);
    if (x.type === 'O') o.push(`      From ${v6up(x.via)}`, `      Last updated ${hms(st.clock - (x.since ?? st.clock))} ago`);
  }
  return o;
}
/** show ip interface <介面>：位址、MTU、套用的 ACL、NAT、TCP MSS 調整 */
function ipIfLines(st, d, i) {
  const rt = i.rt || {}, up = rt.link && !i.shut;
  const acl = (dir, k) => (i[k] && i[k].length ? aclName(i, dir) : null);
  const ins = acl('in', 'aclIn'), outs = acl('out', 'aclOut');
  return [`${longIf(i.label)} is ${i.shut ? 'administratively down' : up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'}`,
    ...(rt.ip != null ? [`  Internet address is ${fmtIp(rt.ip)}/${rt.bits}`, '  Broadcast address is 255.255.255.255'] : ['  Internet protocol processing disabled']),
    ...(rt.ip != null ? [
      `  MTU is ${ipMtu(st, d, i)} bytes`, `  Helper address is ${i.helper || 'not set'}`, '  Directed broadcast forwarding is disabled',
      `  Outgoing Common access list is not set`, `  Outgoing access list is ${outs || 'not set'}`, `  Inbound Common access list is not set`, `  Inbound  access list is ${ins || 'not set'}`,
      '  Proxy ARP is enabled', '  Security level is default', '  Split horizon is enabled', '  ICMP redirects are always sent', '  ICMP unreachables are always sent', '  ICMP mask replies are never sent',
      '  IP fast switching is enabled', '  IP Flow switching is disabled', '  IP CEF switching is enabled', '  IP multicast fast switching is enabled',
      `  Network address translation is ${i.nat || i.natOut || i.natRule ? 'enabled, interface in domain ' + (i.nat || i.natOut ? 'outside' : 'inside') : 'disabled'}`,
      ...(+i.adjMss ? [`  TCP Adjust MSS is ${+i.adjMss}`] : []),
      '  BGP Policy Mapping is disabled', '  Input features: MCI Check', `  IPv4 WCCP Redirect outbound is disabled`] : []),
    ...(ins || outs ? ['', '（這個介面上的 ACL 也會擋到路由器自己以外的 ICMP：擋掉「需要分段」(packet-too-big) 會讓 PMTUD 失效）'] : [])];
}
/** show ipv6 interface <介面> */
function ipv6IfLines(st, d, i) {
  const v = i.rt.v6;
  if (!v || v.ll == null) return [`${longIf(i.label)} is ${i.rt.link ? 'up' : 'down'}, line protocol is ${i.rt.link ? 'up' : 'down'}`, '  IPv6 is disabled'];
  const o6 = d.rt.ospf6 && d.rt.ospf6.ifs[i.id];
  const groups = ['FF02::1', ...(d.routing && d.v6routing ? ['FF02::2'] : []), ...(o6 ? ['FF02::5', ...(['DR', 'BDR'].includes(o6.state) ? ['FF02::6'] : [])] : []), ...(i.dhcp6 ? ['FF02::1:2'] : []),
    ...[...new Set([v.ll, ...v.addrs.map((a) => a.ip)].map((a) => fmtIp6(parseIp6('ff02::1:ff00:0') | (a & 0xffffffn)).toUpperCase()))]];
  const hosts = i.raM ? 'Hosts use DHCP to obtain routable addresses.' : i.raO ? 'Hosts use stateless autoconfig for addresses.\n  Hosts use DHCP to obtain other configuration.' : 'Hosts use stateless autoconfig for addresses.';
  return [`${longIf(i.label)} is up, line protocol is up`, `  IPv6 is enabled, link-local address is ${v6up(v.ll)}`, '  No Virtual link-local address(es):',
    ...(v.addrs.length ? ['  Global unicast address(es):', ...v.addrs.map((a) => `    ${v6up(a.ip)}, subnet is ${v6up(net6(a.ip, a.bits))}/${a.bits}${a.src === 'slaac' ? ' [EUI]' : ''}`)] : ['  No global unicast address is configured']),
    '  Joined group address(es):', ...groups.map((g) => '    ' + g), `  MTU is ${ipMtu(st, d, i)} bytes`, '  ICMP error messages limited to one every 100 milliseconds', '  ICMP redirects are enabled', '  ICMP unreachables are sent',
    ...(i.acl6In ? [`  Inbound access list ${i.acl6In}`] : []), ...(i.acl6Out ? [`  Outgoing access list ${i.acl6Out}`] : []),
    '  ND DAD is enabled, number of DAD attempts: 1', '  ND reachable time is 30000 milliseconds (using 30000)',
    ...(d.routing ? ['  ND advertised reachable time is 0 (unspecified)', '  ND advertised retransmit interval is 0 (unspecified)',
      ...(i.ra && d.v6routing ? ['  ND router advertisements are sent every 200 seconds', '  ND router advertisements live for 1800 seconds', '  ND advertised default router preference is Medium', ...hosts.split('\n').map((x) => '  ' + x.trim()).map((x) => x)]
        : ['  ND RAs are suppressed (periodic)']),
      ...(i.raNoAuto ? ['（前綴的 A 旗標關掉了：主機不能用 SLAAC 自己產生位址）'] : [])] : []),
  ];
}

/** show ip bgp：只看某個鄰居時，adv = 送給它的（advertised-routes），不然是從它收到的 */
function bgpTable(st, d, only) {
  const b = d.rt.bgp;
  if (!b) return ['% BGP not active'];
  let rows = b.table;
  if (only && !only.adv) rows = rows.filter((r) => r.peerIp != null && fmtIp(r.peerIp) === only.ip);
  if (only && only.adv) {
    // 送給這個鄰居的：自己最佳路徑裡、不是從它學來的那些（過濾與 prepend 之後的樣子看對方收到的）
    const o = Object.values(st.devices).find((y) => y.ifaces.some((i) => i.rt && fmtIp(i.rt.ip) === only.ip));
    const mine = d.ifaces.find((i) => i.rt && i.rt.ip != null && o && o.rt.bgp && o.rt.bgp.table.some((r) => r.peerIp === i.rt.ip));
    rows = o && o.rt.bgp && mine ? o.rt.bgp.table.filter((r) => r.peerIp === mine.rt.ip).map((r) => ({ ...r, best: true, nh: 0, aspath: r.aspath.slice(1), lp: undefined, weight: 0, adv: true, sentPath: r.aspath })) : [];
  }
  const o = [`BGP table version is ${10 + b.table.length}, local router ID is ${fmtIp(b.rid)}`, 'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,', '              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter,',
    '              x best-external, a additional-path, c RIB-compressed,', 'Origin codes: i - IGP, e - EGP, ? - incomplete', 'RPKI validation codes: V valid, I invalid, N Not found', '',
    '     ' + pad('Network', 17) + pad('Next Hop', 20) + pad('Metric', 7) + pad('LocPrf', 7) + pad('Weight', 7) + 'Path'];
  let prev = null;
  for (const r of rows) {
    const k = r.net + '/' + r.bits;
    const net = k === prev ? '' : bgpNet(r);
    prev = k;
    // 第一欄：r = RIB-failure（路由表裡有管理距離更小的路）、* = 有效（下一站查得到）；> = 最佳；i = 從 iBGP 學到的
    const v = r.ribFail ? 'r' : r.valid === false ? ' ' : '*';
    o.push(` ${v}${r.best ? '>' : ' '}${r.ibgp && !r.adv ? 'i' : ' '} ` + pad(net, 17) + pad(r.local || r.adv ? '0.0.0.0' : fmtIp(r.nh), 20) + pad(r.med != null ? String(r.med).padStart(6) : r.local ? '     0' : '', 7)
      + pad(!r.adv && r.lp != null && (r.lp !== 100 || r.ibgp) ? String(r.lp).padStart(6) : '', 7) + pad(String(r.weight || 0).padStart(6), 7) + ((r.adv ? r.sentPath : r.aspath).join(' ') + ' ' + (r.origin || 'i')).trim());
  }
  o.push('', `Total number of prefixes ${new Set(rows.map((r) => r.net + '/' + r.bits)).size} `);
  if (rows.some((r) => r.valid === false)) o.push('（第一欄沒有 * 的路：下一站在路由表裡查不到 (inaccessible)，不能當最佳路徑。從 iBGP 學到的路下一站不會變，往往是外面 ISP 的位址：在邊界路由器上 neighbor … next-hop-self）');
  if (rows.some((r) => r.ribFail)) o.push('（r：RIB-failure，路由表裡已經有同一個網段、管理距離更小的路（例如 OSPF 的 110 比 iBGP 的 200 小），這條沒有裝進路由表）');
  return o;
}
/** show ip bgp <網段>：每一條路的細節 */
function bgpEntry(st, d, ip, bits) {
  const b = d.rt.bgp;
  if (!b) return ['% BGP not active'];
  let rows = b.table.filter((r) => (bits != null ? r.bits === bits && r.net === netOf(ip, bits) : netOf(ip, r.bits) === r.net));
  if (bits == null && rows.length) { const L = Math.max(...rows.map((r) => r.bits)); rows = rows.filter((r) => r.bits === L); }
  if (!rows.length) return ['% Network not in table'];
  const r0 = rows[0], bi = rows.findIndex((r) => r.best);
  const who = (r) => { const x = Object.values(st.devices).find((y) => y.rt && y.rt.bgp && y.rt.bgp.rid === r.peerRid); return x; };
  const o = [`BGP routing table entry for ${fmtIp(r0.net)}/${r0.bits}, version ${10 + b.table.indexOf(r0)}`, `Paths: (${rows.length} available, ${bi >= 0 ? `best #${bi + 1}` : 'no best path'}, table default)`];
  // 最佳路徑會送給哪些鄰居：學到它的那一個不送；從 iBGP 學到的不送給其他 iBGP 鄰居（route reflector 例外）
  const best = rows.find((r) => r.best), cfgOf = (ip) => ((d.bgp || {}).neighbors || []).find((n) => n.ip === ip) || {};
  const sentTo = !best ? [] : b.peers.filter((p) => p.state === 'Established' && !(best.peerIp != null && fmtIp(best.peerIp) === p.ip) && !(best.ibgp && p.ibgp && !best.fromClient && !cfgOf(p.ip).rrClient));
  o.push(sentTo.length ? '  Advertised to update-groups:' : '  Not advertised to any peer', ...(sentTo.length ? ['     ' + sentTo.map((p) => p.ip).join('  ')] : []), '  Refresh Epoch 1');
  rows.forEach((r, k) => {
    o.push('  ' + (r.aspath.length ? r.aspath.join(' ') : 'Local') + (r.ibgp && r.fromClient ? ', (Received from a RR-client)' : ''));
    if (r.local) o.push('    0.0.0.0 from 0.0.0.0 (' + fmtIp(b.rid) + ')');
    else o.push(`    ${fmtIp(r.nh)}${r.valid === false ? ' (inaccessible)' : r.igp ? ` (metric ${r.igp})` : ''} from ${fmtIp(r.peerIp)} (${fmtIp(r.peerRid)})`);
    const flags = [r.valid !== false && 'valid', r.local ? 'sourced' : r.ibgp ? 'internal' : 'external', r.best && 'best'].filter(Boolean).join(', ');
    o.push(`      Origin ${{ i: 'IGP', e: 'EGP', '?': 'incomplete' }[r.origin] || 'IGP'}, metric ${r.med || 0}, localpref ${r.lp ?? 100}${r.weight ? `, weight ${r.weight}` : ''}, ${flags}`);
    if ((r.comm || []).length) o.push('      Community: ' + r.comm.map((c) => fmtComm(c, d.commNewFormat)).join(' '));
    if (r.originator != null) o.push(`      Originator: ${fmtIp(r.originator)}, Cluster list: ${(r.cluster || []).map(fmtIp).join(' ')}`);
    if (r.ribFail) o.push('      （RIB-failure：路由表裡有管理距離更小的路，這條沒有裝進去）');
    o.push('      rx pathid: 0, tx pathid: ' + (r.best ? '0x0' : '0'));
    if (!r.best && bi >= 0 && r.valid !== false) o.push(`      （沒有被選上：最佳路徑 #${bi + 1} 的 ${BEST_REASON(rows[bi], r)}）`);
    void who; void k;
  });
  if (rows.some((r) => r.valid === false)) o.push('', '（inaccessible：下一站在路由表裡查不到。iBGP 送路由時下一站不會變，通常是外面 ISP 的位址；在邊界路由器的 iBGP 鄰居上加 next-hop-self，或把那個網段放進 IGP）');
  return o;
}

// ───────────────────────── OSPF ─────────────────────────
/** show ip ospf interface [介面] */
function ospfIfLines(st, d, only) {
  const o = [];
  for (const v of ospfViews(st, d)) {
    const ifs = (v.o2 && v.o2.ifs) || {}, rid = v.o2 ? v.o2.rid : null;
    const list = d.ifaces.filter((i) => ifs[i.id] && (!only || i === only));
    const who = (k) => { if (!k) return null; const [id, iid] = k.split('/'); const x = st.devices[id]; const i = x && x.ifaces.find((y) => y.id === iid); const xo = x && x.rt[ospfKeys(v.vrf).key]; return x && i ? { rid: xo ? xo.rid : null, ip: i.rt.ip } : null; };
    for (const i of list) {
      const f = ifs[i.id], nb = v.nbrs.filter((n) => n.iface === i.id), full = nb.filter((n) => n.state === 'full');
      const dr = who(f.dr), bdr = who(f.bdr);
      o.push(`${longIf(i.label)} is up, line protocol is up`, `  Internet Address ${fmtIp(i.rt.ip)}/${i.rt.bits}, Area ${f.area}, Attached via Network Statement`,
        `  Process ID ${v.pid}, Router ID ${rid != null ? fmtIp(rid) : '0.0.0.0'}, Network Type ${f.type === 'point-to-point' ? 'POINT_TO_POINT' : f.type === 'loopback' ? 'LOOPBACK' : 'BROADCAST'}, Cost: ${f.cost}`);
      if (f.type === 'loopback') { o.push('  Loopback interface is treated as a stub Host', ''); continue; }
      o.push(`  Transmit Delay is 1 sec, State ${f.state === 'P2P' ? 'POINT_TO_POINT' : f.state === 'PASSIVE' ? 'DR' : f.state}${f.type === 'broadcast' ? `, Priority ${f.prio}` : ''}`);
      if (f.type === 'broadcast' && dr) o.push(`  Designated Router (ID) ${fmtIp(dr.rid)}, Interface address ${fmtIp(dr.ip)}`);
      if (f.type === 'broadcast' && bdr) o.push(`  Backup Designated router (ID) ${fmtIp(bdr.rid)}, Interface address ${fmtIp(bdr.ip)}`);
      o.push(`  Timer intervals configured, Hello ${f.hello}, Dead ${f.dead}, Wait ${f.dead}, Retransmit 5`);
      if (f.passive) o.push('    No Hellos (Passive interface)');
      else o.push(`    Hello due in 00:00:0${(st.clock % f.hello) | 0}`);
      o.push(`  Neighbor Count is ${nb.length}, Adjacent neighbor count is ${full.length}`,
        ...full.map((n) => `    Adjacent with neighbor ${fmtIp(n.rid ?? n.ip)}${n.role === 'DR' ? '  (Designated Router)' : n.role === 'BDR' ? '  (Backup Designated Router)' : ''}`),
        ...(i.mtu ? [`  （ip mtu ${i.mtu}：兩端的 MTU 要一樣，不然資料庫交換會卡在 EXSTART）`] : []),
        ...f.why.map((w) => `  （沒有成為鄰居：${w}）`), '');
    }
  }
  if (!o.length) return [only ? `%OSPF: OSPF not enabled on ${only.label}` : '（沒有任何介面啟用 OSPF）'];
  return o;
}

/** 這台設備的每一個 IPv4 OSPF 程序：設定、執行狀態、鄰居、資料庫（全域的排第一個） */
function ospfViews(st, d) {
  return ospfProcs(d).map(({ vrf, pid, c }) => { const k = ospfKeys(vrf); return { vrf, pid, c, ns: k.ns, o2: d.rt[k.key], nbrs: d.rt[k.nkey] || [], db: st.rt.ospf }; });
}
/** 區域種類的統計：「2 normal 1 stub 0 nssa」 */
function areaCounts(v, areas) {
  const k = (a) => (v.o2 && v.o2.kinds ? v.o2.kinds[a] : ospfAreaType(v.c, a)) || 'normal';
  const n = (t) => areas.filter((a) => k(a) === t).length;
  return `${n('normal')} normal ${n('stub')} stub ${n('nssa')} nssa`;
}
/** show ip ospf：一個程序 */
function ospfProcLines(st, d, v) {
  const o2 = v.o2, c = v.c, areas = o2.areas || [];
  const dom = v.db && (v.db.domain || {})[o2.id], same = (id) => ((v.db && v.db.domain) || {})[id] === dom;
  const ext5 = v.db ? Object.entries(v.db.exts || {}).filter(([id]) => same(id)).reduce((n, [, l]) => n + l.length, 0) + (v.db.translated || []).filter((x) => same(x.by)).length : 0;
  const hasNormal = areas.some((a) => ((o2.kinds || {})[a] || 'normal') === 'normal');
  return [` Routing Process "ospf ${v.pid}" with ID ${o2.rid != null ? fmtIp(o2.rid) : '0.0.0.0'}`,
    ...(v.vrf ? [`   Domain ID type 0x0005, value 0.0.0.${v.pid}`] : []),
    ' Start time: 00:00:12.345, Time elapsed: ' + hms(st.clock + 273600),
    ...(o2.pending ? [` （設定了新的 router-id ${c.ospfRid}，但要 clear ip ospf process 才會生效）`] : []),
    ' Supports only single TOS(TOS0) routes', ' Supports opaque LSA', ' Supports Link-local Signaling (LLS)', ' Supports area transit capability', ' Supports NSSA (compatible with RFC 3101)',
    ...(v.vrf ? [` Connected to MPLS VPN Superbackbone, VRF ${v.vrf}`] : []),
    ...(o2.abr && o2.asbr ? [' It is an area border and autonomous system boundary router'] : o2.abr ? [' It is an area border router'] : o2.asbr ? [' It is an autonomous system boundary router'] : []),
    ...(o2.asbr && (c.ospfRedist || []).length ? [' Redistributing External Routes from,', ...(c.ospfRedist || []).map((r) => `    ${r.src}${r.as != null ? ' ' + r.as : ''}${r.metric != null ? ', metric ' + r.metric : ''}${r.type === 1 ? ', metric-type 1' : ''}, includes subnets in redistribution${r.rm ? ', route-map ' + r.rm : ''}`)] : []),
    ' Router is not originating router-LSAs with maximum metric', ' Initial SPF schedule delay 5000 msecs',
    ` Number of external LSA ${hasNormal ? ext5 : 0}`,
    ` Number of areas in this router is ${areas.length}. ${areaCounts(v, areas)}`, ` Reference bandwidth unit is ${+c.ospfRefBw || 100} mbps`,
    ...areas.flatMap((a) => {
      const n = Object.values(o2.ifs).filter((x) => x.area === a).length;
      const t = (o2.kinds || {})[a] || 'normal', ac = ospfAreaCfg(c, a);
      const kind = t === 'stub' ? [`        It is a stub area${ac.noSum ? ', no summary LSA in this area' : ''}`, ...(o2.abr ? [`          generates stub default route with cost ${ac.cost ?? 1}`] : [])]
        : t === 'nssa' ? [`        It is a NSSA area${ac.noSum ? ', no summary LSA in this area' : ''}`, ...((o2.translates || []).includes(a) ? ['        Perform type-7/type-5 LSA translation'] : []),
          ...(o2.abr && (ac.noSum || ac.nssaDef) ? [`          generates NSSA default route with cost ${ac.cost ?? 1}`] : [])] : [];
      return [`    Area ${a === 0 ? 'BACKBONE(0)' : a}`, `        Number of interfaces in this area is ${n}`, ...kind,
        `        Area has ${(c.ospfAreaAuth || {})[a] === 'md5' ? 'message digest authentication' : (c.ospfAreaAuth || {})[a] === 'plain' ? 'simple password authentication' : 'no authentication'}`,
        ...(c.ospfRanges || []).filter((r) => +r.area === a).map((r) => `        Area ranges are\n           ${fmtIp(r.net)}/${r.bits} Active Advertise`).join('\n').split('\n').filter(Boolean)];
    })];
}
/** show ip ospf database：一個程序 */
function ospfDbLines(st, d, v) {
  const o2 = v.o2, db = v.db, key = ospfKeys(v.vrf).key;
  const age = (x) => String(((x * 7 + st.clock) % 1800) | 0).padStart(4);
  const seq = (x) => '0x800000' + (((x >>> 0) % 200) + 16).toString(16).toUpperCase().padStart(2, '0');
  const ck = (x) => '0x00' + ((x >>> 0) % 0xffff).toString(16).padStart(4, '0').toUpperCase();
  // 節點 id：全域的程序是設備 id，VRF 的程序是「設備@VRF」
  const split = (id) => { const k = id.indexOf('@'); return k < 0 ? [id, ''] : [id.slice(0, k), id.slice(k + 1)]; };
  const ridOf = (id) => { const [dv, vr] = split(id); return db.rid[id] ?? ((st.dyn['rid' + ospfKeys(vr).ns] || {})[dv] || {}).rid; };
  const lsdb = o2.lsdb || {}, dom = (db.domain || {})[o2.id];
  const sameDom = (id) => (db.domain || {})[id] === dom;
  const o = [`            OSPF Router with ID (${fmtIp(o2.rid)}) (Process ID ${v.pid})`];
  const kinds = o2.kinds || {};
  for (const a of o2.areas || []) {
    // 這個區域裡的路由器：每一台送一筆 Router LSA (Type 1)
    const inArea = new Set(lsdb[a] || []);
    const rs = Object.entries(db.stubs).filter(([id, l]) => inArea.has(id) && l.some((x) => x.area === a)).map(([id]) => id);
    o.push('', `		Router Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum Link count');
    for (const id of rs) { const r = ridOf(id); if (r == null) continue; o.push(pad(fmtIp(r), 16) + pad(fmtIp(r), 16) + pad(age(r), 12) + pad(seq(r), 11) + pad(ck(r), 9) + db.stubs[id].filter((x) => x.area === a).length); }
    // 有 DR 的廣播網段：DR 送一筆 Network LSA (Type 2)
    const nets = [];
    for (const id of inArea) { const [dv, vr] = split(id), x = st.devices[dv], xo = x && x.rt && x.rt[ospfKeys(vr).key]; if (!xo) continue; for (const i of x.ifaces) { const f = xo.ifs[i.id]; if (f && f.area === a && f.state === 'DR' && f.full) nets.push({ ip: i.rt.ip, rid: xo.rid }); } }
    if (nets.length) { o.push('', `		Net Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum'); for (const n of nets) o.push(pad(fmtIp(n.ip), 16) + pad(fmtIp(n.rid), 16) + pad(age(n.ip), 12) + pad(seq(n.ip), 11) + ck(n.ip)); }
    // ABR 送進這個區域的 Summary LSA (Type 3)：stub 區域裡會有一筆 0.0.0.0（預設路由）
    const sums = [];
    for (const b of db.abrs.filter((x) => inArea.has(x))) {
      const list = a === 0 ? Object.values(db.sumInto0[b] || {}) : Object.values(((db.sumOut[b] || {})[a]) || {});
      for (const x of list) sums.push({ ...x, rid: db.rid[b] });
    }
    if (sums.length) { o.push('', `		Summary Net Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum'); for (const x of sums) o.push(pad(fmtIp(x.net), 16) + pad(fmtIp(x.rid), 16) + pad(age(x.net), 12) + pad(seq(x.net), 11) + ck(x.net)); }
    // NSSA：區域裡的 ASBR 送的 Type-7
    const t7 = kinds[a] === 'nssa' ? ((db.type7 || {})[a] || []).filter((x) => inArea.has(x.asbr)) : [];
    if (t7.length) { o.push('', `		Type-7 AS External Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum Tag'); for (const x of t7) o.push(pad(fmtIp(x.net), 16) + pad(fmtIp(ridOf(x.asbr)), 16) + pad(age(x.net + 3), 12) + pad(seq(x.net + 3), 11) + pad(ck(x.net + 11), 9) + (x.tag || 0)); }
  }
  // Type-5：整個網域的一般區域都有同一份；只在 stub / NSSA 區域裡的路由器完全沒有
  const hasNormal = (o2.areas || []).some((a) => (kinds[a] || 'normal') === 'normal');
  const ext = hasNormal ? [...db.asbrs.filter(sameDom).flatMap((id) => ((db.exts || {})[id] || []).map((x) => ({ ...x, rid: db.rid[id] }))), ...(db.translated || []).filter((x) => sameDom(x.by)).map((x) => ({ ...x, rid: db.rid[x.by] }))] : [];
  if (ext.length) { o.push('', '\t\tType-5 AS External Link States', '', 'Link ID         ADV Router      Age         Seq#       Checksum Tag'); for (const x of ext) o.push(pad(fmtIp(x.net), 16) + pad(fmtIp(x.rid), 16) + pad(age(x.net + 1), 12) + pad(seq(x.net + 1), 11) + pad(ck(x.net + 7), 9) + (x.tag || (x.def ? 1 : 0))); }
  return o;
}
/** show ip protocols [vrf <名稱>]：這個路由表的 OSPF 程序 */
function protocolLines(st, d, vrf) {
  if (!d.routing) return ['% 這台設備沒有啟用 IP 路由'];
  const v = ospfViews(st, d).find((x) => x.vrf === vrf);
  const c = v && v.c;
  const stmts = (c && c.ospfNets) || [], on = d.ifaces.filter((i) => (i.vrf || '') === vrf && i.ospf && i.rt && i.rt.ip != null && ospfArea(d, i) != null);
  if (!c || (!stmts.length && !on.length)) return [vrf ? `（VRF ${vrf} 沒有啟用任何動態路由協定，路由表只有直連與靜態路由）` : '（沒有啟用任何動態路由協定，路由表只有直連與靜態路由）'];
  const rid = v.o2 ? v.o2.rid : vrf ? null : routerId(d), wild = (b) => fmtIp(b === 0 ? 0xffffffff : ((1 << (32 - b)) - 1) >>> 0);
  const areas = (v.o2 || {}).areas || [0];
  const mine = (i) => (i.vrf || '') === vrf && ospfArea(d, i) != null;
  return [...(vrf ? [`Routing Protocol is "ospf ${v.pid}"`] : ['*** IP Routing is NSF aware ***', '', 'Routing Protocol is "ospf 1"']), '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set',
    `  Router ID ${rid != null ? fmtIp(rid) : '0.0.0.0'}`, ...(v.o2 && v.o2.asbr ? ['  It is an autonomous system boundary router'] : []), `  Number of areas in this router is ${areas.length}. ${areaCounts(v, areas)}`, `  Maximum path: ${+c.ospfMaxPaths || 4}`, '  Routing for Networks:',
    ...stmts.map((n) => `    ${fmtIp(n.net)} ${wild(n.bits)} area ${+(n.area || 0)}`),
    ...(d.ifaces.some((i) => mine(i) && ospfPassive(d, i) && !isLoopback(i)) ? ['  Passive Interface(s):', ...d.ifaces.filter((i) => mine(i) && ospfPassive(d, i) && !isLoopback(i)).map((i) => '    ' + longIf(i.label))] : []),
    ...on.filter((i) => !stmts.some((n) => (i.rt.ip >>> (32 - n.bits || 0)) === (n.net >>> (32 - n.bits || 0)))).map((i) => `    ${longIf(i.label)}`),
    ...((c.ospfRedist || []).length ? [`  Redistributing: ${(c.ospfRedist || []).map((r) => r.src + (r.as != null ? ' ' + r.as : '')).join(', ')}`] : []),
    '  Routing Information Sources:', '    Gateway         Distance      Last Update',
    ...v.nbrs.filter((n) => n.state === 'full').map((n) => `    ${pad(fmtIp(n.rid ?? n.ip), 16)}${pad(110, 14)}${hms(Math.min(st.clock, 3600))}`),
    '  Distance: (default is 110)'];
}

// ───────────────────────── QoS ─────────────────────────
const bps = (mbps) => String(Math.round(mbps * 1e6));
/** show policy-map interface：每個 class 的流量與丟棄，數字來自目前在跑的背景流量與通話 */
function policyIfLines(st, d, i) {
  const o = [` ${longIf(i.label)} `, ''];
  for (const [dir, name] of [['input', i.qosIn], ['output', i.qosOut]]) {
    if (!name) continue;
    const pm = (d.policyMaps || {})[name] || [];
    o.push(`  Service-policy ${dir}: ${name}`, '');
    // 這個介面送出去的方向：找出對應的那一段線路與它的負載
    const l = st.rt.links[d.id + ':' + i.bind.port];
    const h = l && { cable: l.cable, from: d.id, fromPort: i.bind.port, to: l.dev, toPort: l.port, tag: i.bind.t === 'sub' ? i.bind.vlan : null };
    const eg = dir === 'output' && h ? egressOf(st, h) : null;
    const q = h ? (st.rt.qload || {})[h.cable + '>' + h.to] : null;
    const offered = q ? q.offered : 0, fixed = q ? q.fixed / 1000 : 0;
    void offered;
    const rate = eg ? eg.rate : 0;
    const cong = eg && q && q.elastic.length && offered >= rate * 0.98;
    const drops = (st.dyn && st.dyn.qdrop) || {}, dk = h ? h.cable + '>' + h.to : '';
    const classLines = (list, ind, base) => {
      for (const c of list) {
        // 有 shape 的 parent：整個介面的量；其他 class：分到這個 class 的 TCP 速率加上語音
        const by = c.shape || (!eg || !eg.queues) ? { n: q ? q.elastic.length : 0, fixed: q ? q.fixed : 0, rate: q ? q.rate : 0 } : (q && q.byCls[c.cls]) || { n: 0, fixed: 0, rate: 0 };
        const off = by.rate + by.fixed / 1000;
        const p = c.fq ? 0.002 : Math.min(0.12, 0.02 + 0.015 * by.n);
        const drop = cong && by.n && !c.priority && !c.shape ? by.rate * p : 0;
        const total = drops[dk + '|' + (eg && eg.queues ? c.cls : 'fifo')] || 0;
        o.push(`${ind}Class-map: ${c.cls} (match-${c.cls === 'class-default' ? 'any' : (d.classMaps[c.cls] || {}).any ? 'any' : 'all'})  `,
          `${ind}  30 second offered rate ${bps(off)} bps, drop rate ${bps(drop)} bps`);
        if (c.cls === 'class-default') o.push(`${ind}  Match: any `);
        else for (const r of (d.classMaps[c.cls] || { rules: [] }).rules) o.push(`${ind}  Match: ${r.t === 'dscp' ? ` dscp ${r.v.map((x) => `${dscpName(x)} (${x})`).join(' ')}` : r.t === 'acl' ? `access-group name ${r.v}` : r.t === 'protocol' ? `protocol ${r.v}` : r.t === 'cos' ? `cos ${r.v.join(' ')}` : 'any'}`);
        if (c.priority) o.push(`${ind}  Priority: ${c.priority.kbps ? c.priority.kbps + ' kbps' : `${c.priority.pct}% (${Math.round((base * c.priority.pct) / 100 * 1000)} kbps)`}, burst bytes 1500, b/w exceed drops: 0`, '');
        else if ((c.bandwidth || c.fq || c.cls === 'class-default') && !c.child) { // 有子政策的 parent：佇列在子政策裡
          o.push(`${ind}  Queueing`, `${ind}  queue limit ${c.qlimit || QLIMIT} packets`, `${ind}  (queue depth/total drops/no-buffer drops) ${cong && by.n && !c.fq ? Math.round((c.qlimit || QLIMIT) * 0.7) : cong && by.n ? 2 : 0}/${total}/0`);
          if (c.bandwidth) o.push(`${ind}  bandwidth ${c.bandwidth.kbps ? c.bandwidth.kbps + ' kbps' : c.bandwidth.rpct ? 'remaining ' + c.bandwidth.rpct + '%' : c.bandwidth.pct + '%'}`);
          if (c.fq) o.push(`${ind}  Fair-queue: per-flow queue limit 16 packets`);
          o.push('');
        }
        if (c.set) o.push(`${ind}  QoS Set`, `${ind}    dscp ${dscpName(c.set.dscp)}`, '');
        if (c.shape) o.push(`${ind}  shape (average) cir ${c.shape.bps}, bc ${Math.round(c.shape.bps / 250)}, be ${Math.round(c.shape.bps / 250)}`, `${ind}  target shape rate ${c.shape.bps}`, '');
        if (c.child && (d.policyMaps || {})[c.child]) { o.push(`${ind}  Service-policy : ${c.child}`, ''); classLines(d.policyMaps[c.child], ind + '    ', c.shape ? c.shape.bps / 1e6 : base); }
      }
    };
    classLines(pm, '    ', dir === 'output' ? rate : offered);
    if (dir === 'output' && eg && eg.cir) o.push(`    （這條線是營運商的線路，合約頻寬 ${eg.cir} Mbps${eg.shape && eg.shape <= eg.cir ? '：已經整形到合約以內，不會被營運商丟封包' : '：送出去的量超過的話，營運商那一端會直接丟掉'}）`);
    void fixed;
  }
  return o;
}
function mlsQosLines(st, d, p) {
  const pc = d.sw.ports[p.id], tr = portTrust(st, d, p.id);
  const l = st.rt.links[d.id + ':' + p.id], x = l && st.devices[l.dev];
  return [longIf(p.label), `trust state: ${!(d.sw.qos && d.sw.qos.on) ? 'not trusted' : tr === 'none' ? 'not trusted' : 'trust ' + tr}`, `trust mode: ${pc.qosTrust ? 'trust ' + pc.qosTrust : 'not trusted'}`,
    `trust enabled flag: ${tr !== 'none' ? 'ena' : 'dis'}`, 'COS override: dis', 'default COS: 0', 'DSCP Mutation Map: Default DSCP Mutation Map', `Trust device: ${pc.trustDevice || 'none'}`, 'qos mode: port-based',
    ...(pc.trustDevice && tr === 'none' && d.sw.qos && d.sw.qos.on ? [`（trust device cisco-phone：${x ? x.name : '對面'} 不是 Cisco 的 IP 電話（或 CDP 沒有開），所以不信任）`] : []),
    ...(d.sw.qos && d.sw.qos.on && !pc.qosTrust ? ['（這個埠沒有 trust：收到的封包 DSCP 一律改成 0）'] : [])];
}

/** show version：跑的是哪一個版本、從哪一個映像檔開機 */
function versionLines(st, d) {
  ensureFlash(d);
  const p = PLATFORM[d.model], fw = d.fw || {}, fs = fsName(d);
  const xeVer = (fw.image || '').match(/\.(\d+\.\d+\.\d+\w*)\.SPA/);
  const codename = { '16.12': 'Gibraltar', '17.3': 'Amsterdam', '17.6': 'Bengaluru', '17.9': 'Cupertino' }[String(fw.ver).split('.').slice(0, 2).join('.')] || 'Cupertino';
  const head = p === 'n9k'
    ? ['Cisco Nexus Operating System (NX-OS) Software', `  NXOS: version ${fw.ver}`, `  NXOS image file is: bootflash:///${fw.image}`]
    : xeVer
      ? [`Cisco IOS XE Software, Version ${xeVer[1]}`, `Cisco IOS Software [${codename}], ${p === 'isr4300' ? 'ISR' : 'Catalyst L3 Switch'} Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version ${fw.ver}, RELEASE SOFTWARE (fc3)`]
      : [`Cisco IOS Software, C2960CX Software (C2960c405ex-UNIVERSALK9-M), Version ${fw.ver}, RELEASE SOFTWARE (fc2)`];
  return [...head, 'Technical Support: http://www.cisco.com/techsupport', '', `${host(d)} uptime is ${upText(uptimeOf(st, d))}`, 'System returned to ROM by reload',
    `System image file is "${fs}:${fw.image}"`, '', `cisco ${CATALOG[d.model].title.replace(/^Cisco /, '')} processor with 4194304K bytes of memory.`,
    `${d.ports.length} Gigabit Ethernet interfaces`, ...(d.flash ? [`${Math.round(d.flash.size / 1024)}K bytes of ${fs === 'flash' ? 'flash-simulated non-volatile configuration memory' : 'flash memory at bootflash:'}.`] : []), '',
    'Configuration register is 0x2102', ...(d.flash ? [`（${fs} 已經用了 ${Math.round(flashUsed(d) / 1048576)} MB / ${Math.round(d.flash.size / 1048576)} MB）`] : [])];
}
void IMAGES;

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
  const inErr = c.crc + c.runts + (c.giants || 0);
  const mtu = pc ? (pc.mode === 'routed' && i ? ipMtu(st, d, i) : l2Mtu(st, d, p.id)) : i ? (+i.l2mtu || 1500) : 1500;
  return [`${L} ${state}`,
    `  Hardware is ${p.media === 'rj45' ? 'Gigabit Ethernet' : 'Ten Gigabit Ethernet'}, address is ${dotMac(mac)} (bia ${dotMac(mac)})`,
    ...(i && i.rt && i.rt.ip != null ? [`  Internet address is ${fmtIp(i.rt.ip)}/${i.rt.bits}`] : []),
    `  MTU ${mtu} bytes, BW ${speed * 1000} Kbit/sec, DLY 10 usec,`,
    `     reliability ${inErr && c.ip ? Math.max(1, Math.round(255 * (1 - Math.min(1, inErr / Math.max(1, c.ip + inErr))))) : 255}/255, txload ${load(c.outRate)}/255, rxload ${load(c.inRate)}/255`,
    '  Encapsulation ARPA, loopback not set', '  Keepalive set (10 sec)',
    `  ${dup}, ${speed >= 1000 ? speed / 1000 + '000' : speed}Mb/s, media type is ${p.media === 'rj45' ? '10/100/1000BaseTX' : 'SFP'}`,
    `  Last input ${ago(c.lastIn)}, output ${ago(c.lastOut)}, output hang never`,
    `  Last clearing of "show interface" counters ${clr == null ? 'never' : hms(st.clock - clr)}`,
    '  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0', '  Queueing strategy: fifo', '  Output queue: 0/40 (size/max)',
    `  5 minute input rate ${c.inRate} bits/sec, ${c.inPps} packets/sec`, `  5 minute output rate ${c.outRate} bits/sec, ${c.outPps} packets/sec`,
    `     ${c.ip} packets input, ${c.ib} bytes, 0 no buffer`, `     Received ${c.ibc + c.imc} broadcasts (${c.imc} multicasts)`,
    `     ${c.runts} runts, ${c.giants || 0} giants, 0 throttles`, `     ${inErr} input errors, ${c.crc} CRC, 0 frame, 0 overrun, 0 ignored`,
    `     0 watchdog, ${c.imc} multicast, 0 pause input`, '     0 input packets with dribble condition detected',
    `     ${c.op} packets output, ${c.ob} bytes, 0 underruns`, `     ${c.late} output errors, ${c.coll} collisions, 1 interface resets`,
    '     0 unknown protocol drops', `     0 babbles, ${c.late} late collision, 0 deferred`, '     0 lost carrier, 0 no carrier, 0 pause output', '     0 output buffer failures, 0 output buffers swapped out',
    ...(c.giants ? ['', `（giants 是收到比 MTU（${mtu}）還大的訊框，被直接丟掉：對面開了 Jumbo Frame，這一端沒有）`] : []),
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

/** show vrf（IOS XE，有 Protocols 欄）與 show ip vrf */
function vrfTable(d, xe) {
  const vs = Object.entries(d.vrfs || {});
  if (!vs.length) return ['（這台沒有設定任何 VRF：所有介面都在全域的路由表裡）'];
  const o = [xe ? '  Name                             Default RD            Protocols   Interfaces' : '  Name                             Default RD            Interfaces'];
  for (const [n, v] of vs) {
    const ifs = d.ifaces.filter((i) => i.vrf === n).map((i) => i.label);
    o.push(`  ${pad(n, 33)}${pad(v.rd || '<not set>', 22)}${xe ? pad(v.af4 ? 'ipv4' : '', 12) : ''}${ifs[0] || ''}`);
    for (const x of ifs.slice(1)) o.push(' '.repeat(xe ? 69 : 57) + x);
  }
  return o;
}
/** 這台設備上某個協定的 FHRP 介面 */
const fhrpIfs = (d, proto) => d.ifaces.filter((i) => i.vrrp && (i.vrrp.on || i.vrrp.vip) && fhrpProto(i.vrrp) === proto);
/** 同一組的成員：誰是 Active / Master、誰是 Standby；HSRP 第三台以後是 Listen */
function fhrpView(st, d, i) {
  const r = i.rt.vrrp || { state: 'init', members: [] };
  const mem = (r.members || []).map(([dv, id]) => { const x = st.devices[dv], j = x && x.ifaces.find((y) => y.id === id); return j && j.rt && j.rt.vrrp ? { ip: fmtIp(j.rt.ip), r: j.rt.vrrp } : null; }).filter(Boolean);
  const me = { ip: 'local', r }, all = [me, ...mem];
  const key = (x) => [x.r.prio || 0, x.ip === 'local' ? (i.rt.ip || 0) : 0];
  const act = all.find((x) => x.r.state === 'master');
  const backs = all.filter((x) => x.r.state === 'backup').sort((a, b) => (b.r.prio || 0) - (a.r.prio || 0) || (key(b)[1] - key(a)[1]));
  const sb = backs[0];
  const hsrpState = r.state === 'init' ? 'Init' : r.state === 'master' ? 'Active' : sb === me ? 'Standby' : 'Listen';
  const odd = r.odd ? `（同一個網段上的 ${st.devices[r.odd.dev] ? st.devices[r.odd.dev].name : r.odd.dev} 用的是 ${r.odd.proto === 'hsrp' ? 'HSRP' : 'VRRP'} 群組 ${r.odd.grp}：協定或群組號碼不同，彼此不會協調，各自都當 Active）` : '';
  return { active: act && act.ip, standby: sb && sb.ip, hsrpState, odd };
}
const stpState = (d, pid) => (d.rt.wait && d.rt.wait[pid] > 15 ? 'LSN' : d.rt.wait && d.rt.wait[pid] > 0 ? 'LRN' : 'FWD');
const CMDS = Object.keys(SHOW);
const match = (tokens, cmd) => {
  const w = cmd.split(' ');
  // 完整的關鍵字優先：ip 不是 ipv6 的縮寫
  return tokens.length === w.length && tokens.every((t, i) => w[i].startsWith(t) && !(t === 'ip' && w[i] === 'ipv6'));
};

/** show、clear 與 ping：回傳 false 表示不是這幾種指令 */
function showOrPing(app, devId, line, print) {
  const tok = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const st = app.state, d = st.devices[devId];
  if (!tok.length || !d) return true;
  if ('ping'.startsWith(tok[0]) && tok[0].length >= 2) {
    // ping vrf <名稱> <IP>：從那個 VRF 的路由表送出去
    let vrf = '';
    if (tok[1] === 'vrf') {
      vrf = line.trim().split(/\s+/)[2] || '';
      if (!(d.vrfs || {})[vrf]) { print(`% VRF ${vrf || '<名稱>'} does not have a usable source address`, 'warn'); return true; }
      tok.splice(1, 2);
    }
    const ip = parseIp(tok[1] || '');
    const si = tok.indexOf('size'), size = si > 0 ? +tok[si + 1] : 100, df = tok.includes('df-bit');
    if (si > 0 && !(size >= 36 && size <= 18024)) { print('% 用法：ping <IP> size <36-18024> [df-bit]', 'warn'); return true; }
    // source <介面 | IP>：用哪個位址當來源（從 LAN 的位址送，才會符合 VPN 的加密範圍）
    let srcIp;
    const so = tok.indexOf('source');
    if (so > 0) {
      const nm = line.trim().split(/\s+/)[so + 1] || '';
      const p = parseIp(nm) == null && portByName(d, nm.replace(/\.\d+$/, ''));
      const sub = nm.match(/\.(\d+)$/);
      const si2 = parseIp(nm) != null ? d.ifaces.find((x) => x.rt && x.rt.ip === parseIp(nm))
        : /^lo/i.test(nm) ? d.ifaces.find((x) => isLoopback(x) && x.bind.n === +(nm.match(/(\d+)$/) || [])[1])
          : p && d.ifaces.find((x) => x.bind.port === p.id && (sub ? x.bind.t === 'sub' && x.bind.vlan === +sub[1] : x.bind.t === 'port'));
      if (!si2 || !si2.rt || si2.rt.ip == null) { print(`% Invalid source address- IP address not on any of our up interfaces`, 'warn'); return true; }
      srcIp = si2.rt.ip;
    }
    if (ip == null) print('% 用法：ping <IPv4 位址> [size <36-18024>] [df-bit]', 'warn');
    else if (!d.ifaces.some((i) => i.rt && i.rt.ip != null)) print('% 這台設備沒有任何 IP 位址，無法送出封包', 'warn');
    else {
      const r = transact(st, d.id, { proto: 'icmp', dst: ip, vrf, size, df, ...(srcIp != null ? { srcIp } : {}) });
      app.showTrace(`${d.name}# ${line}`, r.log, r.hops, r);
      print('Type escape sequence to abort.', 'dim');
      print(`Sending 5, ${size}-byte ICMP Echos to ${fmtIp(ip)}, timeout is 2 seconds:`);
      if (df) print('Packet sent with the DF bit set');
      // M：收到「需要分段」(could not fragment)
      print(r.ok ? '!!!!!' : r.ptb || r.dfLocal ? 'MMMMM' : '.....', r.ok ? 'ok' : 'bad');
      print(`Success rate is ${r.ok ? 100 : 0} percent (${r.ok ? 5 : 0}/5)${r.ok ? ', round-trip min/avg/max = 1/1/2 ms' : ''}`);
      if (r.ptb || r.dfLocal) print(`（M 代表 could not fragment：路徑上的 MTU 只有 ${r.ptb ? r.ptb.mtu : r.dfLocal}）`, 'hint');
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
  // show archive config differences [A [B]]、show archive log config all | user <名稱>
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && (tok[1] || '').length >= 3 && 'archive'.startsWith(tok[1]) && tok[2] && tok[2].length >= 3) {
    const raw = line.trim().split(/\s+/);
    if ('config'.startsWith(tok[2]) && tok[3] && tok[3].length >= 3 && 'differences'.startsWith(tok[3])) {
      const pick = (name) => {
        if (!name || /^(nvram:)?startup-config$/i.test(name)) return { lines: startupConfig(st, d), label: 'nvram:startup-config' };
        if (/^(system:)?running-config$/i.test(name)) return { lines: runningConfig(st, d), label: 'system:running-config' };
        const f = d.flash && d.flash.files[name.replace(/^(boot)?flash:\/?/i, '')];
        return f && f.kind === 'config' ? { lines: f.lines, label: name } : { err: `%Error opening ${name} (No such file or directory)` };
      };
      const A = raw[4] ? pick(raw[4]) : pick(null), B = raw[5] ? pick(raw[5]) : raw[4] ? pick('running-config') : pick('running-config');
      if (A.err || B.err) { print(A.err || B.err, 'warn'); return true; }
      if (!A.lines) { print('%Error opening nvram:startup-config (No such file or directory)', 'warn'); return true; }
      const diff = cfgDiff(A.lines, B.lines);
      print('', 'pre');
      print('!Contextual Config Diffs:', 'pre');
      if (!diff.length) print('!No changes were found', 'pre');
      diff.forEach((l) => print(l, /^\s*\+/.test(l) ? 'ok' : /^\s*-/.test(l) ? 'bad' : 'pre'));
      print(`（- 是只在 ${A.label} 裡的，+ 是只在 ${B.label} 裡的）`, 'hint');
      return true;
    }
    if ('log'.startsWith(tok[2]) && tok[3] && 'config'.startsWith(tok[3])) {
      const all = ((st.dyn && st.dyn.cfglog) || {})[d.id] || [];
      const L = d.archive && d.archive.log;
      if (!L || !L.on) { print('（archive log config 沒有開 logging enable：設定變更不會被記錄）', 'hint'); if (!all.length) return true; }
      const user = tok[4] && 'user'.startsWith(tok[4]) ? (raw[5] || '') : null;
      const rows = user ? all.filter((e) => e.user === user) : all;
      print(' idx   sess           user@line      Logged command', 'pre');
      for (const e of rows) print(`${String(e.n).padStart(5)} ${String(e.sess).padStart(6)} ${(e.user + '@' + e.line).padStart(22)}  |${e.cmd}`, 'pre');
      if (!rows.length) print(user ? `（${user} 沒有任何設定變更紀錄）` : '（還沒有任何設定變更紀錄）', 'hint');
      return true;
    }
  }
  // show port-security interface <埠>、show port-security address
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'port-security' && tok[2]) {
    if (!isSw(d)) { print('% 這個指令只適用於交換器', 'warn'); return true; }
    if (tok[2].length >= 2 && 'address'.startsWith(tok[2])) {
      print('               Secure Mac Address Table', 'pre');
      print('-----------------------------------------------------------------------------', 'pre');
      print(pad('Vlan', 8) + pad('Mac Address', 17) + pad('Type', 26) + pad('Ports', 10) + 'Remaining Age', 'pre');
      let n = 0;
      for (const p of d.ports) {
        const c = d.sw.ports[p.id].ps;
        if (!c || !c.on) continue;
        const v = d.sw.ports[p.id].vlan, rec = (st.dyn.psec || {})[d.id + ':' + p.id] || { dyn: [] };
        const rows = [...String(c.macs || '').split(/[,\s]+/).filter(Boolean).map((m) => [m, 'SecureConfigured']), ...String(c.stickyMacs || '').split(/[,\s]+/).filter(Boolean).map((m) => [m, 'SecureSticky']), ...rec.dyn.map((m) => [m, 'SecureDynamic'])];
        for (const [m, t] of rows) { print(pad(String(v).padStart(4), 8) + pad(dotMac(m), 17) + pad(t, 26) + pad(p.label, 10) + '-', 'pre'); n++; }
      }
      print('-----------------------------------------------------------------------------', 'pre');
      print(`Total Addresses in System (excluding one mac per port)     : ${Math.max(0, n - 1)}`, 'pre');
      return true;
    }
    if (tok[2].length >= 3 && 'interface'.startsWith(tok[2]) && tok[3]) {
      const p = portByName(d, tok.slice(3).join(''));
      if (!p) { print(`% 找不到介面「${tok.slice(3).join(' ')}」`, 'warn'); return true; }
      psecIfLines(st, d, p).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
      return true;
    }
  }
  // show storm-control <埠>
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] && tok[1].length >= 5 && 'storm-control'.startsWith(tok[1]) && tok[2] && !'broadcast'.startsWith(tok[2])) {
    const p = portByName(d, tok.slice(2).join(''));
    if (!p) { print(`% 找不到介面「${tok.slice(2).join(' ')}」`, 'warn'); return true; }
    stormLines(st, d, p).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  // show mac address-table interface <埠>
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'mac' && tok[2] && 'address-table'.startsWith(tok[2]) && tok[3] && tok[3].length >= 3 && 'interface'.startsWith(tok[3]) && tok[4]) {
    if (!isSw(d)) { print('% 這個指令只適用於交換器', 'warn'); return true; }
    const p = portByName(d, tok.slice(4).join(''));
    if (!p) { print(`% 找不到介面「${tok.slice(4).join(' ')}」`, 'warn'); return true; }
    const all = macRows(st, d), rows = all.filter((r) => r.port === p.id), bg = all.bogus && all.bogus.port === p.id ? all.bogus : null;
    print('          Mac Address Table', 'pre');
    print('-------------------------------------------', 'pre');
    print(pad('Vlan', 8) + pad('Mac Address', 18) + pad('Type', 12) + 'Ports', 'pre');
    for (const r of rows) print(pad(String(r.vlan).padStart(4), 8) + pad(dotMac(r.mac), 18) + pad(r.type, 12) + r.label, 'pre');
    if (bg) { for (const m of bg.sample) print(pad(String(bg.vlan).padStart(4), 8) + pad(dotMac(m), 18) + pad('DYNAMIC', 12) + bg.label, 'pre'); print(`（… 另外還有 ${(bg.n - bg.sample.length).toLocaleString('en')} 筆亂造的 MAC 都學在這個埠）`, 'hint'); }
    print(`Total Mac Addresses for this criterion: ${rows.length + (bg ? bg.n : 0)}`, 'pre');
    return true;
  }
  // show interfaces [名稱]、show monitor session <n>
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] && tok[1].length >= 3 && 'interfaces'.startsWith(tok[1]) && tok.length >= 4 && tok[tok.length - 1].length >= 2 && 'switchport'.startsWith(tok[tok.length - 1])) {
    const p = portByName(d, tok.slice(2, -1).join(''));
    if (!p) { print(`% 找不到介面「${tok.slice(2, -1).join(' ')}」`, 'warn'); return true; }
    if (!isSw(d) || d.sw.ports[p.id].mode === 'routed') { print(`Name: ${p.label}`, 'pre'); print('Switchport: Disabled', 'pre'); return true; }
    switchportLines(st, d, p).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] && tok[1].length >= 3 && 'interfaces'.startsWith(tok[1]) && !(tok[2] && ['status', 'trunk', 'counters', 'switchport'].some((w) => tok[2].length >= 2 && w.startsWith(tok[2])))) {
    const name = tok.slice(2).join('');
    const ports = name ? [portByName(d, name)] : d.ports.filter((p) => st.rt.links[d.id + ':' + p.id] || (d.sw && d.sw.ports[p.id] && d.sw.ports[p.id].shut));
    if (name && !ports[0]) { print(`% 找不到介面「${tok.slice(2).join(' ')}」`, 'warn'); return true; }
    for (const p of ports) ifaceDetail(st, d, p).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && (tok[1] || '').length >= 3 && 'policy-map'.startsWith(tok[1]) && tok[2] && tok[2].length >= 3 && 'interface'.startsWith(tok[2]) && tok[3]) {
    const p = portByName(d, tok.slice(3).join('').replace(/\.\d+$/, ''));
    const sub = tok.slice(3).join('').match(/\.(\d+)$/);
    const i = p && d.ifaces.find((x) => x.bind.port === p.id && (sub ? x.bind.t === 'sub' && x.bind.vlan === +sub[1] : x.bind.t === 'port'));
    if (!i) { print(`% 找不到介面「${tok.slice(3).join(' ')}」`, 'warn'); return true; }
    const lines = policyIfLines(st, d, i);
    (lines.length ? lines : [`（${i.label} 上沒有套用任何 service-policy）`]).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ipv6' && (tok[2] || '').length >= 2 && 'route'.startsWith(tok[2]) && tok[3] && (parseIp6(tok[3]) != null || parseCidr6(tok[3]) != null)) {
    if (!d.routing || !d.v6routing) { print('% IPv6 routing not enabled', 'warn'); return true; }
    const c = parseCidr6(tok[3]), exact = tok[3].includes('/');
    const { rib } = rib6Of(d);
    let hit;
    if (exact) hit = rib.filter((r) => r.bits === c.bits && r.net === net6(c.ip, c.bits));
    else {
      const best = rib.filter((r) => net6(c.ip, r.bits) === r.net && (r.bits > 0 || c.ip === 0n) && !r.null0).reduce((a, r) => (!a || r.bits > a.bits ? r : a), null);
      hit = best ? rib.filter((r) => r.net === best.net && r.bits === best.bits && r.type === best.type) : [];
    }
    if (!hit.length) { print('% Route not found', 'warn'); return true; }
    route6Entry(st, d, hit).forEach((l) => print(l, 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && (tok[2] || '').length >= 3 && 'interface'.startsWith(tok[2]) && tok[3] && !'brief'.startsWith(tok[3])) {
    const name = tok.slice(3).join('');
    const lo = name.match(/^lo[a-z]*(\d+)$/i), vl = name.match(/^vl[a-z]*(\d+)$/i);
    const i = lo ? d.ifaces.find((x) => isLoopback(x) && x.bind.n === +lo[1]) : vl ? d.ifaces.find((x) => x.bind.t === 'svi' && x.bind.vlan === +vl[1])
      : (() => { const p = portByName(d, name.replace(/\.\d+$/, '')); const sub = name.match(/\.(\d+)$/); return p && d.ifaces.find((x) => x.bind.port === p.id && (sub ? x.bind.t === 'sub' && x.bind.vlan === +sub[1] : x.bind.t === 'port')); })();
    if (!i) { print(`% 找不到介面「${tok.slice(3).join(' ')}」`, 'warn'); return true; }
    ipIfLines(st, d, i).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ipv6' && (tok[2] || '').length >= 3 && 'interface'.startsWith(tok[2]) && tok[3] && !'brief'.startsWith(tok[3])) {
    const name = tok.slice(3).join('');
    const lo = name.match(/^lo[a-z]*(\d+)$/i);
    const i = lo ? d.ifaces.find((x) => isLoopback(x) && x.bind.n === +lo[1]) : (() => { const p = portByName(d, name.replace(/\.\d+$/, '')); const sub = name.match(/\.(\d+)$/); return p && d.ifaces.find((x) => x.bind.port === p.id && (sub ? x.bind.t === 'sub' && x.bind.vlan === +sub[1] : x.bind.t === 'port')); })();
    if (!i) { print(`% 找不到介面「${tok.slice(3).join(' ')}」`, 'warn'); return true; }
    ipv6IfLines(st, d, i).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  // show ip protocols vrf <名稱>
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && (tok[2] || '').length >= 4 && 'protocols'.startsWith(tok[2]) && tok[3] === 'vrf') {
    const v = line.trim().split(/\s+/)[4];
    if (!v || !(d.vrfs || {})[v]) { print(v ? `% VRF ${v} does not exist` : '用法：show ip protocols vrf <名稱>', 'warn'); return true; }
    protocolLines(st, d, v).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  // show ip route vrf <名稱> [connected | static | ospf | bgp | <位址> [遮罩]]
  let rvrf = '';
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && (tok[2] || '').length >= 2 && 'route'.startsWith(tok[2]) && tok[3] === 'vrf') {
    const words = line.trim().split(/\s+/), v = words[4];
    if (!v || !(d.vrfs || {})[v]) { print(v ? `% IP routing table ${v} does not exist` : '用法：show ip route vrf <名稱>', 'warn'); return true; }
    const what = (tok[5] || '').toLowerCase();
    const KEEP = { connected: (r) => r.type === 'C' || r.type === 'L', static: (r) => r.type === 'S' || r.type === 'D', ospf: (r) => r.type === 'O', bgp: (r) => r.type === 'B' };
    const kw = what && Object.keys(KEEP).find((k) => k.startsWith(what) && what.length >= 2);
    if (!what || kw) { routeLines(st, d, kw ? KEEP[kw] : () => true, v).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre')); return true; }
    if (parseIp(tok[5]) == null) { print(`% Invalid input detected：${tok[5]}`, 'warn'); return true; }
    rvrf = v;
    tok.splice(3, 2); // 接下來和 show ip route <位址> 一樣處理，只是看這個 VRF 的路由表
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && (tok[2] || '').length >= 2 && 'route'.startsWith(tok[2]) && tok[3] && parseIp(tok[3]) != null) {
    if (!d.routing) { routeLines(st, d, () => true).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre')); return true; }
    const ip = parseIp(tok[3]), bits = tok[4] != null ? parseMask(tok[4]) : null;
    if (tok[4] != null && bits == null) { print(`% Invalid input detected：${tok[4]} 不是子網路遮罩`, 'warn'); return true; }
    const { rib } = ribOf(d, rvrf);
    let hit;
    if (bits != null) hit = rib.filter((r) => r.bits === bits && r.net === netOf(ip, bits));
    else {
      // 和真的 IOS 一樣：只符合預設路由的位址算「不在路由表裡」（要看預設路由就查 0.0.0.0）
      const best = rib.filter((r) => netOf(ip, r.bits) === r.net && (r.bits > 0 || ip === 0)).reduce((a, r) => (!a || r.bits > a.bits ? r : a), null);
      hit = best ? rib.filter((r) => r.net === best.net && r.bits === best.bits) : [];
    }
    if (!hit.length) { print(bits != null ? '% Subnet not in table' : '% Network not in table', 'warn'); return true; }
    if (rvrf) print(`Routing Table: ${rvrf}`, 'pre');
    routeEntry(st, d, hit).forEach((l) => print(l, 'pre'));
    return true;
  }
  // show ip bgp <網段> [遮罩]：每一條路的細節（下一站查不查得到、從誰學到的、community、route reflector）
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && tok[2] === 'bgp' && tok[3] && parseIp(tok[3]) != null) {
    const bits = tok[4] != null ? parseMask(tok[4]) : (tok[3].includes('/') ? null : null);
    if (tok[4] != null && bits == null) { print(`% Invalid input detected：${tok[4]} 不是子網路遮罩`, 'warn'); return true; }
    bgpEntry(st, d, parseIp(tok[3]), bits).forEach((l) => print(l, l.startsWith('（') || l.startsWith('      （') ? 'hint' : 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && (tok[2] || '').length >= 3 && 'community-list'.startsWith(tok[2])) {
    const all = Object.entries(d.commLists || {});
    if (!all.length) { print('（沒有任何 community-list）', 'hint'); return true; }
    for (const [n, l] of all) { print(`${/^\d+$/.test(n) ? 'Community standard list' : 'Named Community standard list'} ${n}`, 'pre'); for (const e of l) print(`    ${e.action} ${e.values.join(' ')}`, 'pre'); }
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && tok[2] === 'bgp' && tok[3] && tok[3].length >= 3 && 'neighbors'.startsWith(tok[3])) {
    const b = d.rt.bgp;
    if (!b) { print('% BGP not active', 'warn'); return true; }
    const ip = tok[4], what = tok[5] || '';
    const peer = ip && b.peers.find((x) => x.ip === ip);
    if (ip && !peer) { print(`% No such neighbor or address family`, 'warn'); return true; }
    if (!ip || !what) {
      for (const x of peer ? [peer] : b.peers) {
        const nc = ((d.bgp || {}).neighbors || []).find((n) => n.ip === x.ip) || {}, us = nc.updSrc && d.ifaces.find((i) => i.id === nc.updSrc);
        [`BGP neighbor is ${x.ip},  remote AS ${x.remoteAs}, ${x.ibgp ? 'internal' : 'external'} link`, ...(x.desc ? [` Description: ${x.desc}`] : []), `  BGP version 4, remote router ID ${x.state === 'Established' ? (() => { const o = Object.values(st.devices).find((y) => y.ifaces.some((i) => i.rt && fmtIp(i.rt.ip) === x.ip)); return o && o.rt.bgp ? fmtIp(o.rt.bgp.rid) : '0.0.0.0'; })() : '0.0.0.0'}`,
          `  BGP state = ${x.state}${x.state === 'Established' ? `, up for ${hms(x.up)}` : ''}`, '  Last read 00:00:12, last write 00:00:21, hold time is 180, keepalive interval is 60 seconds',
          ...(nc.rrClient ? ['  Route-Reflector Client'] : []), ...(nc.nhSelf ? ['  NEXT_HOP is always this router for eBGP paths'] : []), ...(nc.sendComm ? ['  Community attribute sent to this neighbor'] : []),
          ...(us ? [`  Interface associated: ${longIf(us.label)}（update-source：TCP 179 從這個介面的位址送出）`] : []),
          ...(!x.ibgp ? [`  External BGP neighbor ${nc.multihop ? `may be up to ${nc.multihop} hops away` : 'configured for connected checks (single-hop no-disable-connected-check)'}`] : []),
          ...(x.why ? [`  （${x.why}）`] : []), `  Prefixes received ${x.pfx}, advertised ${x.sent}`, ''].forEach((l) => print(l, l.startsWith('  （') ? 'hint' : 'pre'));
      }
      return true;
    }
    if ('advertised-routes'.startsWith(what) || 'received-routes'.startsWith(what) || 'routes'.startsWith(what)) {
      bgpTable(st, d, { ip, adv: what.startsWith('a') }).forEach((l) => print(l, 'pre'));
      return true;
    }
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && tok[2] && 'ospf'.startsWith(tok[2]) && tok[2].length >= 2 && tok[3] && tok[3].length >= 3 && 'interface'.startsWith(tok[3]) && tok[4] && !'brief'.startsWith(tok[4])) {
    const name = tok.slice(4).join('');
    const lo = name.match(/^lo[a-z]*(\d+)$/);
    const i = lo ? d.ifaces.find((x) => isLoopback(x) && x.bind.n === +lo[1]) : (() => { const p = portByName(d, name.replace(/\.\d+$/, '')); const sub = name.match(/\.(\d+)$/); return p && d.ifaces.find((x) => x.bind.port === p.id && (sub ? x.bind.t === 'sub' && x.bind.vlan === +sub[1] : x.bind.t === 'port')); })();
    if (!i) { print(`% 找不到介面「${tok.slice(4).join(' ')}」`, 'warn'); return true; }
    ospfIfLines(st, d, i).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
    return true;
  }
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'mls' && tok[2] && 'qos'.startsWith(tok[2]) && tok[3] && 'interface'.startsWith(tok[3]) && tok[4]) {
    const p = portByName(d, tok.slice(4).join(''));
    if (!p || !isSw(d)) { print(`% 找不到介面「${tok.slice(4).join(' ')}」`, 'warn'); return true; }
    mlsQosLines(st, d, p).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre'));
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
  SHOW[cmd](st, d).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre')); // 表格不折行，太寬時左右捲動；全形括號開頭的是說明
  return true;
}

/**
 * 執行一行 IOS 指令。CLI 分頁和遠端登入 (SSH / Telnet) 共用。
 * 回傳 { clear：要清空畫面, changed：設定或狀態有變動, renamed：設備改名或重新開機了 }
 */
export function iosRun(app, devId, sess, line, print) {
  const text = line.trim(), low = text.toLowerCase();
  if (app.state.devices[devId].kind === 'wlc' && low && !/^(sh|sho|show|ping|tr|traceroute|ter|terminal|exit|end|\?|help|cls|clear$)/.test(low)) {
    print('% 這個模擬的 Catalyst 9800 請用圖形介面設定（CCNA 也只要求用 GUI 設定 WLAN）；CLI 可以用 show ap summary、show wlan summary、show wireless client summary、show ap dot11 24ghz summary 查看', 'warn');
    return {};
  }
  const booting = (app.state.rt.booting || {})[devId], rom = (app.state.rt.rommon || {})[devId];
  if (booting > 0 && !rom) { print(`% 設備還在開機中，還要 ${Math.ceil(booting)} 秒才能下指令`, 'warn'); return {}; }
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
  // 輸出篩選：show … | include / exclude / begin / section / count <正規表示式>
  const pipe = text.match(/^((?:do\s+)?sh\S*\s.*?\S)\s+\|\s*(\S+)(?:\s+(.*))?$/i);
  if (pipe) {
    const kind = ['include', 'exclude', 'begin', 'section', 'count'].find((k) => k.startsWith(pipe[2].toLowerCase()) && pipe[2].length >= (k === 'count' ? 1 : 1));
    if (!kind || (kind !== 'count' && !pipe[3])) {
      print(`% Invalid input detected：| 後面可以接 include、exclude、begin、section、count，再加上要比對的字（例如 show running-config | include ip route）`, 'warn');
      return {};
    }
    const got = [];
    const res = iosRun(app, devId, sess, pipe[1], (t, c) => got.push([t, c]));
    let re;
    try { re = new RegExp((pipe[3] || '.').trim().replace(/^"(.*)"$/, '$1'), 'i'); } catch { re = new RegExp((pipe[3] || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const body = got.filter(([, c]) => c !== 'hint' && c !== 'cmd');
    let keep;
    if (kind === 'include') keep = body.filter(([t]) => re.test(t));
    else if (kind === 'exclude') keep = body.filter(([t]) => !re.test(t));
    else if (kind === 'begin') { const k = body.findIndex(([t]) => re.test(t)); keep = k < 0 ? [] : body.slice(k); }
    else if (kind === 'section') {
      // 區段：標題（不縮排的那一行）符合就整段列出；只有底下的某幾行符合，就列出標題與那幾行
      keep = [];
      const secs = [];
      for (const x of body) { if (!/^\s/.test(x[0]) || !secs.length) secs.push([x]); else secs[secs.length - 1].push(x); }
      for (const [head, ...kids] of secs) {
        if (re.test(head[0])) keep.push(head, ...kids);
        else { const m = kids.filter(([t]) => re.test(t)); if (m.length) keep.push(head, ...m); }
      }
    } else { print(`Number of lines which match regexp = ${body.filter(([t]) => re.test(t)).length}`, 'dim'); return res; }
    for (const [t, c] of keep) print(t, c);
    return res;
  }
  const r = sess.exec(text);
  r.out.forEach((l) => print(l, l.startsWith('%') ? 'warn' : 'dim'));
  if (r.pass && !showOrPing(app, devId, r.doLine != null ? r.doLine : text, print)) print(`% Invalid input detected：不認識的指令「${text}」，輸入 ? 查看可用指令`, 'warn');
  const d = app.state.devices[devId];
  return { changed: !!r.changed, reloaded: !!r.reloaded, renamed: !!r.changed && (!!r.reloaded || !d || d.name !== before), wait: r.wait || 0, xfer: r.xfer || null };
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
    if (r.xfer) app.showTrace(`${dev.name}# ${line}`, r.xfer.log, r.xfer.hops, r.xfer);
    if (r.wait > 0) app.tick(Math.ceil(r.wait)); // copy 這類指令要花時間：模擬時間跟著往前走
    follow();
    if (r.renamed) app.renderPanel(); // 設備改名或重新開機了：整個面板要跟著更新
    else draw();
  };
  // 在別的地方發生的事（介面斷線、debug 的輸出）也會出現在 console 上
  app.refreshers.push(() => { if (follow()) draw(); });
  input.addEventListener('keydown', (e) => {
    if (escLine(e, input)) return;
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
    ownKeys(e);
  });
  // 一次貼上好幾行（例如整份設定檔）：和真的 console 一樣一行一行執行；最後一行沒有換行的話留在輸入列
  input.addEventListener('paste', (e) => {
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!/\n/.test(t)) return;
    e.preventDefault();
    const lines = t.replace(/\r/g, '').split('\n');
    const last = lines.pop();
    const before = input.value;
    lines[0] = before + lines[0];
    input.value = '';
    for (const l of lines) { if (!l.trim()) continue; hist.push(l.trim()); run(l.trim()); }
    hi = hist.length;
    input.value = last;
  });
  const quick = ['show running-config', 'show ip interface brief', dev.routing ? 'show ip route' : 'show vlan brief', 'configure terminal', 'end'];
  body.append(h('div', { class: 'term', onclick: () => input.focus() }, out, h('div', { class: 'term-line' }, promptEl, input)),
    h('div', { class: 'chips' }, quick.map((x) => h('button', { class: 'chip btnchip', type: 'button', text: x, onclick: () => { hist.push(x); hi = hist.length; run(x); input.focus(); } }))));
  draw();
  setTimeout(() => input.focus(), 30);
}
