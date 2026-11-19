// IOS 風格的 CLI：用 show 指令查看狀態；configure terminal 之後可以直接用指令修改設定
import { h } from './dom.js';
import { fmtIp, parseIp, parseMask, netOf } from '../engine/ip.js';
import { fmtIp6 } from '../engine/ip6.js';
import { transact, routeRows, isBridgePort, arpRows, clearArp, hitsOf, fmtDur, portfastOn, macRows, clearMac, macAgeOf, sessionRows, clearSessions, saInfo, isTrunk, dtpSpeaker } from '../engine/sim.js';
import { cdpCfg, lldpCfg, cdpOn, lldpTxOn, lldpRxOn, neighbors, ndCounters, cdpCapText, speaksCdp, speaksLldp } from '../engine/disc.js';
import { dscpName, COS_DSCP_DEFAULT, portTrust, egressOf, classify, QLIMIT } from '../engine/qos.js';
import { ospfArea, ospfCost, ospfPassive, ospfHello, ospfDead, ospfPrio, ospfNetType, isLoopback } from '../engine/ospf.js';
import { bgpCfg } from '../engine/bgp.js';
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
  'show ip route': (st, d) => routeLines(st, d, () => true),
  'show ip route connected': (st, d) => routeLines(st, d, (r) => r.type === 'C' || r.type === 'L'),
  'show ip route static': (st, d) => routeLines(st, d, (r) => r.type === 'S' || r.type === 'D'),
  'show ip route ospf': (st, d) => routeLines(st, d, (r) => r.type === 'O'),
  'show ip route bgp': (st, d) => routeLines(st, d, (r) => r.type === 'B'),
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
  'show ip protocols': (st, d) => {
    if (!d.routing) return ['% 這台設備沒有啟用 IP 路由'];
    const stmts = d.ospfNets || [], on = d.ifaces.filter((i) => i.ospf && i.rt && i.rt.ip != null);
    if (!stmts.length && !on.length) return ['（沒有啟用任何動態路由協定，路由表只有直連與靜態路由）'];
    const rid = routerId(d), wild = (b) => fmtIp(b === 0 ? 0xffffffff : ((1 << (32 - b)) - 1) >>> 0);
    return ['*** IP Routing is NSF aware ***', '', 'Routing Protocol is "ospf 1"', '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set',
      `  Router ID ${rid != null ? fmtIp(rid) : '0.0.0.0'}`, `  Number of areas in this router is ${((d.rt.ospf || {}).areas || [0]).length}. ${((d.rt.ospf || {}).areas || [0]).length} normal 0 stub 0 nssa`, `  Maximum path: ${+d.ospfMaxPaths || 4}`, '  Routing for Networks:',
      ...stmts.map((n) => `    ${fmtIp(n.net)} ${wild(n.bits)} area ${+(n.area || 0)}`),
      ...(d.ifaces.some((i) => ospfPassive(d, i) && !isLoopback(i) && ospfArea(d, i) != null) ? ['  Passive Interface(s):', ...d.ifaces.filter((i) => ospfPassive(d, i) && !isLoopback(i) && ospfArea(d, i) != null).map((i) => '    ' + longIf(i.label))] : []),
      ...on.filter((i) => !stmts.some((n) => (i.rt.ip >>> (32 - n.bits || 0)) === (n.net >>> (32 - n.bits || 0)))).map((i) => `    ${longIf(i.label)}`),
      '  Routing Information Sources:', '    Gateway         Distance      Last Update',
      ...(d.rt.nbrs || []).filter((n) => n.state === 'full').map((n) => `    ${pad(fmtIp(routerId(st.devices[n.dev]) ?? n.ip), 16)}${pad(110, 14)}${hms(Math.min(st.clock, 3600))}`),
      '  Distance: (default is 110)'];
  },
  'show ip ospf interface brief': (st, d) => {
    const ifs = (d.rt.ospf && d.rt.ospf.ifs) || {};
    const on = d.ifaces.filter((i) => ifs[i.id]);
    if (!on.length) return ['（沒有任何介面啟用 OSPF）'];
    const SHORT = { DROTHER: 'DROTH', WAITING: 'WAIT', P2P: 'P2P', LOOP: 'LOOP', PASSIVE: 'DR' };
    return [pad('Interface', 12) + pad('PID', 6) + pad('Area', 16) + pad('IP Address/Mask', 20) + pad('Cost', 6) + pad('State', 6) + 'Nbrs F/C',
      ...on.map((i) => {
        const f = ifs[i.id], nb = (d.rt.nbrs || []).filter((n) => n.iface === i.id), full = nb.filter((n) => n.state === 'full');
        return pad(i.label.replace('Loopback', 'Lo'), 12) + pad(1, 6) + pad(f.area, 16) + pad(`${fmtIp(i.rt.ip)}/${i.rt.bits}`, 20) + pad(f.cost, 6) + pad(SHORT[f.state] || f.state, 6) + `${full.length}/${nb.length}`;
      })];
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
    return all.flatMap(([n, l]) => l.flatMap((e) => [`route-map ${n}, ${e.action}, sequence ${e.seq}`, '  Match clauses:', ...(e.match.pl ? [`    ip address prefix-lists: ${e.match.pl} `] : []), ...(e.match.fl ? [`    as-path (as-path filter): ${e.match.fl} `] : []),
      '  Set clauses:', ...(e.set.lp != null ? [`    local-preference ${e.set.lp}`] : []), ...(e.set.prepend ? [`    as-path prepend ${e.set.prepend.join(' ')}`] : []), ...(e.set.med != null ? [`    metric ${e.set.med}`] : []), ...(e.set.weight != null ? [`    weight ${e.set.weight}`] : []), '  Policy routing matches: 0 packets, 0 bytes']));
  },
  'show ip as-path-access-list': (st, d) => {
    const all = Object.entries(d.asPathAcl || {});
    if (!all.length) return ['（沒有任何 as-path access-list）'];
    return all.flatMap(([n, l]) => [`AS path access list ${n}`, ...l.map((e) => `    ${e.action} ${e.re}`)]);
  },
  'show ip ospf': (st, d) => {
    const o2 = d.rt.ospf;
    if (!o2) return ['%OSPF: Router process 1 is not running, please configure a router-id'];
    const areas = o2.areas || [];
    return [` Routing Process "ospf 1" with ID ${o2.rid != null ? fmtIp(o2.rid) : '0.0.0.0'}`, ' Start time: 00:00:12.345, Time elapsed: ' + hms(st.clock + 273600),
      ...(o2.pending ? [` （設定了新的 router-id ${d.ospfRid}，但要 clear ip ospf process 才會生效）`] : []),
      ' Supports only single TOS(TOS0) routes', ' Supports opaque LSA', ' Supports Link-local Signaling (LLS)',
      ...(o2.abr ? [' It is an area border router'] : []), ...(o2.asbr ? [' It is an autonomous system boundary router'] : []),
      ` Router is not originating router-LSAs with maximum metric`, ' Initial SPF schedule delay 5000 msecs', ' Number of external LSA ' + (st.rt.ospf ? st.rt.ospf.asbrs.length : 0),
      ` Number of areas in this router is ${areas.length}. ${areas.length} normal 0 stub 0 nssa`, ` Reference bandwidth unit is ${+d.ospfRefBw || 100} mbps`,
      ...areas.flatMap((a) => {
        const n = Object.values(o2.ifs).filter((x) => x.area === a).length;
        return [`    Area ${a === 0 ? 'BACKBONE(0)' : a}`, `        Number of interfaces in this area is ${n}`,
          `        Area has ${(d.ospfAreaAuth || {})[a] === 'md5' ? 'message digest authentication' : (d.ospfAreaAuth || {})[a] === 'plain' ? 'simple password authentication' : 'no authentication'}`,
          ...(d.ospfRanges || []).filter((r) => +r.area === a).map((r) => `        Area ranges are\n           ${fmtIp(r.net)}/${r.bits} Active Advertise`).join('\n').split('\n').filter(Boolean)];
      })];
  },
  'show ip ospf database': (st, d) => {
    const o2 = d.rt.ospf, db = st.rt.ospf;
    if (!o2 || !db) return ['%OSPF: Router process 1 is not running'];
    const age = (x) => String(((x * 7 + st.clock) % 1800) | 0).padStart(4);
    const seq = (x) => '0x800000' + (((x >>> 0) % 200) + 16).toString(16).toUpperCase().padStart(2, '0');
    const o = [`            OSPF Router with ID (${fmtIp(o2.rid)}) (Process ID 1)`];
    for (const a of o2.areas || []) {
      // 這個區域裡的路由器：每一台送一筆 Router LSA (Type 1)
      const rs = Object.entries(db.stubs).filter(([, l]) => l.some((x) => x.area === a)).map(([id]) => id);
      o.push('', `\t\tRouter Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum Link count');
      for (const id of rs) { const r = db.rid[id] ?? (st.dyn.rid[id] || {}).rid; if (r == null) continue; o.push(pad(fmtIp(r), 16) + pad(fmtIp(r), 16) + pad(age(r), 12) + pad(seq(r), 11) + pad('0x00' + (r % 0xffff).toString(16).padStart(4, '0').toUpperCase(), 9) + db.stubs[id].filter((x) => x.area === a).length); }
      // 有 DR 的廣播網段：DR 送一筆 Network LSA (Type 2)
      const nets = [];
      for (const x of Object.values(st.devices)) for (const i of x.ifaces) { const f = x.rt && x.rt.ospf && x.rt.ospf.ifs[i.id]; if (f && f.area === a && f.state === 'DR' && f.full) nets.push({ ip: i.rt.ip, rid: x.rt.ospf.rid }); }
      if (nets.length) { o.push('', `\t\tNet Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum'); for (const n of nets) o.push(pad(fmtIp(n.ip), 16) + pad(fmtIp(n.rid), 16) + pad(age(n.ip), 12) + pad(seq(n.ip), 11) + '0x00' + (n.ip % 0xffff).toString(16).padStart(4, '0').toUpperCase()); }
      // ABR 送進這個區域的 Summary LSA (Type 3)
      const sums = [];
      for (const b of db.abrs) {
        const list = a === 0 ? Object.values(db.sumInto0[b] || {}) : Object.values(((db.sumOut[b] || {})[a]) || {});
        for (const x of list) sums.push({ ...x, rid: db.rid[b] });
      }
      if (sums.length) { o.push('', `\t\tSummary Net Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum'); for (const x of sums) o.push(pad(fmtIp(x.net), 16) + pad(fmtIp(x.rid), 16) + pad(age(x.net), 12) + pad(seq(x.net), 11) + '0x00' + (x.net % 0xffff).toString(16).padStart(4, '0').toUpperCase()); }
    }
    if (db.asbrs.length) { o.push('', '\t\tType-5 AS External Link States', '', 'Link ID         ADV Router      Age         Seq#       Checksum Tag'); for (const id of db.asbrs) o.push(pad('0.0.0.0', 16) + pad(fmtIp(db.rid[id]), 16) + pad(age(1), 12) + pad(seq(1), 11) + pad('0x00A1B2', 9) + '1'); }
    return o;
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
    const v = d.ifaces.filter((i) => i.vrrp && i.vrrp.on);
    if (!v.length) return ['沒有設定 VRRP'];
    return [pad('Interface', 16) + pad('Grp', 5) + pad('Pri', 5) + pad('State', 9) + 'Group addr',
      ...v.map((i) => pad(i.label, 16) + pad(1, 5) + pad(i.vrrp.prio || 100, 5) + pad(i.rt.vrrp ? { master: 'Master', backup: 'Backup', init: 'Init' }[i.rt.vrrp.state] : 'Init', 9) + (i.vrrp.vip || '')
        + (i.rt.vrrp && i.rt.vrrp.wait > 0 ? `   (Master down，${Math.ceil(i.rt.vrrp.wait)} 秒後接手)` : ''))];
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
/** show interfaces <埠> switchport */
function switchportLines(st, d, p) {
  const pc = d.sw.ports[p.id], t = (d.rt.dtp || {})[p.id] || { oper: 'down' };
  const vname = (v) => { const x = d.sw.vlans.find((y) => y.id === v); return x ? x.name.replace(/\s+/g, '_') : 'Inactive'; };
  const adm = pc.mode === 'dynamic-auto' ? 'dynamic auto' : pc.mode === 'dynamic-desirable' ? 'dynamic desirable' : pc.mode === 'trunk' ? 'trunk' : 'static access';
  const oper = t.oper === 'trunk' ? 'trunk' : t.oper === 'down' ? 'down' : 'static access';
  const neg = dtpSpeaker(d) && pc.mode !== 'access' && !pc.noneg;
  return [`Name: ${p.label}`, 'Switchport: Enabled', `Administrative Mode: ${adm}`, `Operational Mode: ${oper}`, 'Administrative Trunking Encapsulation: dot1q',
    `Operational Trunking Encapsulation: ${t.oper === 'trunk' ? 'dot1q' : 'native'}`, `Negotiation of Trunking: ${neg ? 'On' : 'Off'}`,
    `Access Mode VLAN: ${pc.vlan} (${pc.vlan === 1 ? 'default' : vname(pc.vlan)})`, `Trunking Native Mode VLAN: ${pc.native} (${pc.native === 1 ? 'default' : vname(pc.native)})`,
    'Administrative Native VLAN tagging: enabled', `Voice VLAN: ${pc.voice ? `${pc.voice} (${vname(pc.voice)})` : 'none'}`,
    'Administrative private-vlan host-association: none', 'Administrative private-vlan mapping: none', 'Operational private-vlan: none',
    `Trunking VLANs Enabled: ${pc.allowed === 'all' || !pc.allowed ? 'ALL' : pc.allowed}`, 'Pruning VLANs Enabled: 2-1001', 'Capture Mode Disabled', 'Capture VLANs Allowed: ALL', '',
    'Protected: false', 'Unknown unicast blocked: disabled', 'Unknown multicast blocked: disabled', 'Appliance trust: none',
    ...(t.why ? [`（DTP：${t.why}）`] : []), ...(pc.noneg ? ['（nonegotiate：這個埠不送 DTP，對面的 dynamic 埠不會因為它而變成 Trunk）'] : [])];
}

// ───────────────────────── BGP ─────────────────────────
/** 有類別的網段（A /8、B /16、C /24）不印長度，其他的才印，和 IOS 一樣 */
const bgpNet = (r) => { const a = r.net >>> 24, cls = a < 128 ? 8 : a < 192 ? 16 : 24; return r.bits === cls || (r.net === 0 && r.bits === 0) ? fmtIp(r.net) : `${fmtIp(r.net)}/${r.bits}`; };
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
function ribOf(d) {
  const all = d.rt.routes || [], key = (r) => r.net + '/' + r.bits, best = {};
  for (const r of all) {
    if (r.bad) continue;
    const b = best[key(r)];
    if (!b || r.ad < b.ad || (r.ad === b.ad && r.metric < b.metric)) best[key(r)] = r;
  }
  const rib = [], out = [];
  for (const r of all) { const b = best[key(r)]; (!r.bad && b && b.ad === r.ad && b.metric === r.metric && b.type === r.type ? rib : out).push(r); }
  for (const i of d.ifaces) if (i.rt && i.rt.ip != null && i.rt.link && i.rt.bits < 32) rib.push({ net: i.rt.ip, bits: 32, via: null, iface: i, type: 'L', ad: 0, metric: 0 });
  rib.sort((a, b) => a.net - b.net || a.bits - b.bits); // 穩定排序：等價的路維持原本的順序
  return { rib, out };
}
const routeTail = (st, r) => {
  if (r.type === 'C' || r.type === 'L') return `is directly connected, ${longIf(r.iface.label)}`;
  const m = `[${r.ad}/${r.metric}] via ${fmtIp(r.via)}`;
  if (r.type === 'O') return `${m}, ${rtAge(st, r)}, ${longIf(r.iface.label)}`;
  if (r.type === 'B') return `${m}, ${rtAge(st, r)}`; // BGP 的下一站要再查一次路由表（遞迴），所以不寫介面
  return m; // 靜態路由只寫下一站
};
function routeLines(st, d, keep) {
  if (!d.routing) {
    // L2 交換器沒有路由表：只有管理用的預設閘道
    const gw = d.ifaces.find((i) => i.rt && i.rt.gw != null);
    return [gw ? `Default gateway is ${fmtIp(gw.rt.gw)}` : 'Default gateway is not set', '', 'Host               Gateway           Last Use    Total Uses  Interface', 'ICMP redirect cache is empty',
      '（這是一台 L2 交換器，沒有啟用 ip routing：它只有管理用的預設閘道，不會替別人轉送封包）'];
  }
  const { rib, out } = ribOf(d);
  const def = rib.filter((r) => r.bits === 0).sort((a, b) => a.ad - b.ad)[0];
  const o = [...ROUTE_CODES, def ? `Gateway of last resort is ${fmtIp(def.via)} to network 0.0.0.0` : 'Gateway of last resort is not set', ''];
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
    const type = r.sub === 'IA' ? 'inter area' : r.sub === 'E2' ? 'extern 2' : 'intra area';
    if (r.sub === 'E2') o.push(`  Known via "ospf 1", distance 110, metric ${r.metric}${def ? ', candidate default path' : ''}`, `  Tag 1, type ${type}, forward metric ${r.fwd ?? 1}`);
    else o.push(`  Known via "ospf 1", distance 110, metric ${r.metric}, type ${type}`);
    o.push(`  Last update from ${fmtIp(r.via)} on ${longIf(r.iface.label)}, ${rtAge(st, r)} ago`, '  Routing Descriptor Blocks:');
    rs.forEach((x, k) => o.push(`  ${k ? ' ' : '*'} ${fmtIp(x.via)}, from ${x.adv != null ? fmtIp(x.adv) : fmtIp(x.via)}, ${rtAge(st, x)} ago, via ${longIf(x.iface.label)}`, metricLine(x.metric)));
  } else if (r.type === 'B') {
    const asn = (bgpCfg(d) || {}).asn, path = r.aspath || [];
    o.push(`  Known via "bgp ${asn}", distance ${r.ad}, metric ${r.metric}${def ? ', candidate default path' : ''}`, `  Tag ${path[0] ?? 0}, type external`,
      `  Last update from ${fmtIp(r.via)} ${rtAge(st, r)} ago`, '  Routing Descriptor Blocks:');
    rs.forEach((x, k) => o.push(`  ${k ? ' ' : '*'} ${fmtIp(x.via)}, from ${fmtIp(x.via)}, ${rtAge(st, x)} ago`, metricLine(x.metric), `      AS Hops ${path.length}`, `      Route tag ${path[0] ?? 0}`, '      MPLS label: none'));
  }
  return o;
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
    o.push(` ${r.best ? '*>' : '* '}  ` + pad(net, 17) + pad(r.local || r.adv ? '0.0.0.0' : fmtIp(r.nh), 20) + pad(r.med != null ? String(r.med).padStart(6) : r.local ? '     0' : '', 7)
      + pad(r.lp != null && r.lp !== 100 ? String(r.lp).padStart(6) : r.local || r.adv ? '' : '   100', 7) + pad(String(r.weight || 0).padStart(6), 7) + ((r.adv ? r.sentPath : r.aspath).join(' ') + ' ' + (r.origin || 'i')).trim());
  }
  o.push('', `Total number of prefixes ${new Set(rows.map((r) => r.net + '/' + r.bits)).size} `);
  return o;
}

// ───────────────────────── OSPF ─────────────────────────
/** show ip ospf interface [介面] */
function ospfIfLines(st, d, only) {
  const ifs = (d.rt.ospf && d.rt.ospf.ifs) || {}, rid = d.rt.ospf ? d.rt.ospf.rid : null;
  const list = d.ifaces.filter((i) => ifs[i.id] && (!only || i === only));
  if (!list.length) return [only ? `%OSPF: OSPF not enabled on ${only.label}` : '（沒有任何介面啟用 OSPF）'];
  const who = (k) => { if (!k) return null; const [id, iid] = k.split('/'); const x = st.devices[id]; const i = x && x.ifaces.find((y) => y.id === iid); return x && i ? { rid: x.rt.ospf ? x.rt.ospf.rid : null, ip: i.rt.ip } : null; };
  const o = [];
  for (const i of list) {
    const f = ifs[i.id], nb = (d.rt.nbrs || []).filter((n) => n.iface === i.id), full = nb.filter((n) => n.state === 'full');
    const dr = who(f.dr), bdr = who(f.bdr);
    o.push(`${longIf(i.label)} is up, line protocol is up`, `  Internet Address ${fmtIp(i.rt.ip)}/${i.rt.bits}, Area ${f.area}, Attached via Network Statement`,
      `  Process ID 1, Router ID ${rid != null ? fmtIp(rid) : '0.0.0.0'}, Network Type ${f.type === 'point-to-point' ? 'POINT_TO_POINT' : f.type === 'loopback' ? 'LOOPBACK' : 'BROADCAST'}, Cost: ${f.cost}`);
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
  return o;
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
  if (tok[0].length >= 2 && 'show'.startsWith(tok[0]) && tok[1] === 'ip' && (tok[2] || '').length >= 2 && 'route'.startsWith(tok[2]) && tok[3] && parseIp(tok[3]) != null) {
    if (!d.routing) { routeLines(st, d, () => true).forEach((l) => print(l, l.startsWith('（') ? 'hint' : 'pre')); return true; }
    const ip = parseIp(tok[3]), bits = tok[4] != null ? parseMask(tok[4]) : null;
    if (tok[4] != null && bits == null) { print(`% Invalid input detected：${tok[4]} 不是子網路遮罩`, 'warn'); return true; }
    const { rib } = ribOf(d);
    let hit;
    if (bits != null) hit = rib.filter((r) => r.bits === bits && r.net === netOf(ip, bits));
    else {
      // 和真的 IOS 一樣：只符合預設路由的位址算「不在路由表裡」（要看預設路由就查 0.0.0.0）
      const best = rib.filter((r) => netOf(ip, r.bits) === r.net && (r.bits > 0 || ip === 0)).reduce((a, r) => (!a || r.bits > a.bits ? r : a), null);
      hit = best ? rib.filter((r) => r.net === best.net && r.bits === best.bits) : [];
    }
    if (!hit.length) { print(bits != null ? '% Subnet not in table' : '% Network not in table', 'warn'); return true; }
    routeEntry(st, d, hit).forEach((l) => print(l, 'pre'));
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
        [`BGP neighbor is ${x.ip},  remote AS ${x.remoteAs}, external link`, ...(x.desc ? [` Description: ${x.desc}`] : []), `  BGP version 4, remote router ID ${x.state === 'Established' ? (() => { const o = Object.values(st.devices).find((y) => y.ifaces.some((i) => i.rt && fmtIp(i.rt.ip) === x.ip)); return o && o.rt.bgp ? fmtIp(o.rt.bgp.rid) : '0.0.0.0'; })() : '0.0.0.0'}`,
          `  BGP state = ${x.state}${x.state === 'Established' ? `, up for ${hms(x.up)}` : ''}`, '  Last read 00:00:12, last write 00:00:21, hold time is 180, keepalive interval is 60 seconds',
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
