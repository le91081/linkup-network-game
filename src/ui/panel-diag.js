// 診斷用的頁面：介面計數器、連接埠鏡像 (SPAN)、封包擷取 (Wireshark)
import { h, button, icon, ownKeys } from './dom.js';
import { note, cardHead, field, sel } from './form.js';
import { fmtIp } from '../engine/ip.js';
import { isBridgePort } from '../engine/sim.js';
import { counters, clearCounters, setCapture, captureOf, protoName, infoOf, displayFilter, BCAST } from '../engine/wire.js';
import { pcapBytes } from '../engine/pcap.js';
import { SIM_EPOCH } from '../engine/ops.js';
import { saveBinary } from './save.js';

const num = (n) => Number(n || 0).toLocaleString('en-US');

// ───────────────────────── 介面計數器 ─────────────────────────

export function countersCard(ctx) {
  const { dev, state } = ctx;
  return h('div', { class: 'card' },
    cardHead('介面計數器', button('歸零', { small: true, onclick: () => { clearCounters(state, dev.id); ctx.app.refreshLive(); } })),
    ctx.live(() => {
      const has = (state.dyn && state.dyn.ifc && state.dyn.ifc[dev.id]) || {};
      const ports = dev.ports.filter((p) => state.rt.links[dev.id + ':' + p.id] || has[p.id]);
      if (!ports.length) return note('muted', '沒有任何接線的連接埠。');
      let bad = false;
      const rows = ports.map((p) => {
        const c = counters(state, dev.id, p.id), err = c.crc + c.runts + c.late;
        if (err) bad = true;
        return h('div', { class: 'ctr-row' + (err ? ' bad' : c.coll ? ' warn' : '') },
          h('b', { class: 'mono', text: p.label }),
          h('span', { class: 'mono', text: `收 ${num(c.ip)}　送 ${num(c.op)}` }),
          h('span', { class: 'mono muted', text: err ? `CRC ${num(c.crc)} · runt ${num(c.runts)} · late ${num(c.late)}` : c.coll ? `碰撞 ${num(c.coll)}` : '沒有錯誤' }));
      });
      return [h('div', { class: 'ctr-list' }, rows),
        bad ? note('warn', 'CRC 錯誤、runt（過短的訊框）、late collision 一直增加，通常是雙工不一致 (duplex mismatch) 或線路品質不好。先按「歸零」，再看它們還會不會繼續長。')
          : note('muted', '交換器每 2 秒會送出 STP 的 BPDU、Cisco 設備每 60 秒送一次 CDP，所以就算沒有人在用，計數器也會一直增加。')];
    }));
}

// ───────────────────────── 連接埠鏡像 (SPAN) ─────────────────────────

export function spanCard(ctx) {
  const { dev } = ctx;
  const sw = dev.sw;
  const s = (sw.span || {})['1'] || { src: {}, dst: '' };
  const save = (fn) => {
    const cur = ((sw.span ||= {})['1'] ||= { src: {}, dst: '' });
    fn(cur);
    if (!Object.keys(cur.src).length && !cur.dst) delete sw.span['1'];
    if (!Object.keys(sw.span).length) delete sw.span;
    ctx.commit(true);
  };
  const ports = dev.ports.filter((p) => isBridgePort(dev, p.id));
  const dir = Object.values(s.src)[0] || 'both';
  const others = Object.keys(sw.span || {}).filter((k) => k !== '1');
  return h('div', { class: 'card' }, cardHead('連接埠鏡像 (SPAN)'),
    h('p', { class: 'tip', text: '把來源埠進出的訊框複製一份，從目的埠送出去。在目的埠接一台電腦開 Wireshark，就看得到別人的流量。目的埠只送出複製的訊框，接在上面的設備不能再用它上網。' }),
    h('span', { class: 'f-label', text: '來源埠（要觀察的埠）' }),
    h('div', { class: 'chips' }, ports.filter((p) => p.id !== s.dst).map((p) => h('button', {
      type: 'button', class: 'chip btnchip' + (s.src[p.id] ? ' on' : ''), text: p.label,
      onclick: () => save((cur) => { if (cur.src[p.id]) delete cur.src[p.id]; else cur.src[p.id] = dir; }),
    }))),
    h('div', { class: 'grid2' },
      field('方向', sel(ctx, () => dir, (v) => save((cur) => { for (const k of Object.keys(cur.src)) cur.src[k] = v; }), [['both', '進出都複製 (both)'], ['rx', '只複製進來的 (rx)'], ['tx', '只複製送出的 (tx)']])),
      field('目的埠（接分析用的電腦）', sel(ctx, () => s.dst || '', (v) => save((cur) => { cur.dst = v; delete cur.src[v]; }), [['', '（不使用）'], ...ports.map((p) => [p.id, p.label])]))),
    ctx.live(() => {
      if (!s.dst) return Object.keys(s.src).length ? note('warn', '還沒有指定目的埠，複製的訊框沒有地方送。') : null;
      const l = ctx.state.rt.links[dev.id + ':' + s.dst];
      const who = l ? ctx.state.devices[l.dev].name : null;
      return note(Object.keys(s.src).length ? 'ok' : 'warn',
        `${(dev.ports.find((p) => p.id === s.dst) || {}).label} 是目的埠${who ? `，接著 ${who}：它會收到複製的訊框，但不能再透過這個埠上網` : '，目前沒有接任何設備'}。${Object.keys(s.src).length ? '' : '還沒有選來源埠。'}`);
    }),
    others.length > 0 && note('muted', `另外還有 session ${others.join('、')}，請用 CLI 的 show monitor 查看。`));
}

// ───────────────────────── 封包擷取 (Wireshark) ─────────────────────────

const PROTO_CLASS = { ARP: 'arp', ICMP: 'icmp', DHCP: 'dhcp', STP: 'stp', CDP: 'stp', TELNET: 'bad', SSHv2: 'tcp', TCP: 'tcp', DNS: 'udp', UDP: 'udp', ESP: 'esp', 'TLSv1.3': 'esp' };

function layers(f) {
  const L = (title, rows, cls) => h('div', { class: 'cap-layer' + (cls ? ' ' + cls : '') }, h('b', { text: title }), rows.filter(Boolean).map(([k, v]) => h('div', { class: 'cap-kv' }, h('span', { text: k }), h('code', { text: v }))));
  const out = [];
  const how = f.how === 'span' ? '（交換器鏡像過來的複本）' : f.how === 'promisc' ? '（不是給這台電腦的：Hub 或交換器泛洪送過來的）' : '';
  out.push(L(`Frame ${f.no}：${f.len} 位元組${how}`, [['時間', `${f.t.toFixed(6)} 秒`]]));
  out.push(L('Ethernet II', [['來源 MAC', f.smac || '-'], ['目的 MAC', f.dmac === BCAST ? `${f.dmac}（廣播）` : f.dmac || '-'], f.tag != null && ['802.1Q', `VLAN ${f.tag}（這一段是 Trunk，訊框帶著標籤）`],
    ['Type', f.proto === 'arp' ? '0x0806 (ARP)' : ['stp', 'cdp'].includes(f.proto) ? '802.3 LLC' : '0x0800 (IPv4)']]));
  if (f.proto === 'arp') {
    out.push(L('Address Resolution Protocol', [['Opcode', f.arp.op === 1 ? 'request (1)' : 'reply (2)'], ['Sender MAC', f.arp.sha], ['Sender IP', fmtIp(f.arp.sip)],
      ['Target MAC', f.arp.op === 1 ? '00:00:00:00:00:00（還不知道，所以才要問）' : f.dmac], ['Target IP', fmtIp(f.arp.tip)]]));
    return out;
  }
  if (f.proto === 'stp') {
    out.push(L('Spanning Tree Protocol', [['BPDU', 'Configuration (Rapid PVST+)'], ['Root Bridge', `${f.stp.prio} / ${f.stp.root}`], ['Root Path Cost', String(f.stp.cost)], ['VLAN', String(f.stp.vlan)],
      ['說明', '交換器每 2 秒從指定埠送出一次。接電腦的埠如果開了 BPDU Guard，收到這種訊框就會被關掉']]));
    return out;
  }
  if (f.proto === 'cdp') {
    out.push(L('Cisco Discovery Protocol', [['Device ID', f.cdp.id], ['Port ID', f.cdp.port], ['說明', '每 60 秒一次，裡面有設備名稱、型號、介面與 IP。攻擊者也看得到，所以接使用者的埠常會關掉 CDP']], 'warn'));
    return out;
  }
  const PN = { icmp: 1, tcp: 6, udp: 17, esp: 50, dhcp: 17, gre: 47 };
  out.push(L('Internet Protocol Version 4', [['來源', fmtIp(f.src)], ['目的', f.dst === 0xffffffff ? '255.255.255.255（廣播）' : fmtIp(f.dst)], f.ttl != null && ['TTL', String(f.ttl)], ['Protocol', `${PN[f.proto]} (${f.proto === 'dhcp' ? 'UDP' : f.proto.toUpperCase()})`]]));
  if (f.proto === 'icmp') out.push(L('ICMP', [['Type', f.reply ? '0 (Echo reply)' : '8 (Echo request)'], ['Identifier', '0x' + (f.reply ? f.dport : f.sport).toString(16)]]));
  if (f.proto === 'tcp') out.push(L('Transmission Control Protocol', [['埠', `${f.sport} → ${f.dport}`], ['Flags', f.data ? 'PSH, ACK' : f.ack ? 'ACK' : f.reply ? 'SYN, ACK' : 'SYN']]));
  if (f.proto === 'udp' || f.proto === 'dhcp') out.push(L('User Datagram Protocol', [['埠', `${f.sport} → ${f.dport}`]]));
  if (f.proto === 'dhcp') out.push(L('Dynamic Host Configuration Protocol', [['Message type', { discover: 'Discover (1)', offer: 'Offer (2)', request: 'Request (3)', ack: 'ACK (5)' }[f.dhcp.type]], ['Transaction ID', '0x' + f.dhcp.xid], f.dhcp.ip != null && ['Your IP', fmtIp(f.dhcp.ip)]]));
  if (f.proto === 'esp' || f.natt) out.push(L(f.ssl ? 'TLS（SSL-VPN）' : 'Encapsulating Security Payload', [f.natt && ['NAT-T', 'ESP 包在 UDP 4500 裡（中間有 NAT，PAT 要靠 UDP 的埠號才能轉換）'], ['內容', '加密過的資料：看不到裡面原本的 IP、埠號與內容'], !f.ssl && ['SPI', '0x' + (f.spi || 0).toString(16)]]));
  if (f.proto === 'gre') {
    const q = (f.gre && f.gre.inner) || {};
    out.push(L('Generic Routing Encapsulation (IP)', [['Flags and Version', f.gre && f.gre.key != null ? '0x2000（有 Key）' : '0x0000'], f.gre && f.gre.key != null && ['Key', String(f.gre.key)], ['Protocol Type', 'IP (0x0800)']]));
    out.push(L('Internet Protocol Version 4（GRE 裡面的封包）', [['來源', q.src != null ? fmtIp(q.src) : '?'], ['目的', q.dst != null ? fmtIp(q.dst) : '?'], ['Protocol', (q.proto || 'ip').toUpperCase()], q.sport != null && q.proto !== 'icmp' && ['埠', `${q.sport} → ${q.dport}`],
      ['說明', 'GRE 只是再包一層標頭，完全沒有加密：線路上看得到裡面原本的位址、埠號與內容。要保密就加上 tunnel protection（IPsec）']], 'warn'));
  }
  const name = protoName(f);
  if (name === 'TELNET') {
    const d = f.data;
    out.push(L('Telnet（明文）', d.kind === 'login' ? [['使用者名稱', d.user], ['密碼', d.pass], ['說明', 'Telnet 不加密：線路上任何一個看得到這個訊框的人，都能直接讀到帳號密碼']] : d.kind === 'cmd' ? [['輸入的指令', d.text]] : [['內容', '設備回傳的畫面（也是明文）']], 'bad'));
  }
  if (name === 'SSHv2') out.push(L('SSH Protocol', [['內容', 'Encrypted packet：帳號密碼與指令都加密了，就算被擷取也看不到'], ['方向', f.reply ? 'Server → Client' : 'Client → Server']]));
  return out;
}

export function captureTab(ctx, body) {
  const { dev, state, app } = ctx;
  const ui = ((app.capUi ||= {})[dev.id] ||= { text: '', sel: null });
  const on = !!(captureOf(state, dev.id) || {}).on;
  body.append(h('p', { class: 'tip', text: '像 Wireshark 一樣把這台電腦網路卡收到與送出的訊框記下來。接在交換器上只看得到「給自己的」和「廣播」；接在 Hub 上，或交換器把別的埠鏡像 (SPAN) 過來，才看得到別人的流量。' }));
  const filter = h('input', { class: 'inp mono', value: ui.text, placeholder: '顯示篩選，例如 ip.addr == 192.168.1.10 && icmp', spellcheck: 'false', autocomplete: 'off' });
  filter.addEventListener('input', () => { ui.text = filter.value; app.refreshLive(); });
  filter.addEventListener('keydown', ownKeys);
  body.append(h('div', { class: 'card' },
    cardHead(on ? '擷取中' : '封包擷取',
      button(on ? '停止' : '開始擷取', { small: true, kind: on ? '' : 'primary', ic: on ? 'pause' : 'play', onclick: () => { setCapture(state, dev.id, !on); if (!on) ui.sel = null; app.renderPanel(); } }),
      button('清除', { small: true, onclick: () => { const c = captureOf(state, dev.id); if (c) { c.frames = []; c.seq = 0; c.t0 = state.clock; } ui.sel = null; app.refreshLive(); } }),
      button('匯出 .pcap', { small: true, ic: 'download', onclick: () => {
        const c = captureOf(state, dev.id);
        if (!c || !c.frames.length) return;
        const name = `${dev.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || dev.id}.pcap`;
        saveBinary(name, pcapBytes(c.frames, Math.floor(SIM_EPOCH / 1000) + c.t0), 'application/vnd.tcpdump.pcap', `已匯出 ${c.frames.length} 個訊框：用 Wireshark 打開`);
      } })),
    filter,
    ctx.live(() => {
      const c = captureOf(state, dev.id);
      const m = displayFilter(ui.text);
      if (m.error) return note('warn', m.error);
      if (!c) return note('muted', '按「開始擷取」之後，到終端機 ping 一下、或讓時間走一會兒，訊框就會出現在這裡。');
      const list = c.frames.filter(m.fn);
      const head = h('div', { class: 'muted cap-sum', text: `${c.on ? '擷取中' : '已停止'} · 共 ${c.frames.length} 個訊框${ui.text ? `，符合篩選的 ${list.length} 個` : ''}（最新的在上面）` });
      if (!list.length) return [head, note('muted', c.frames.length ? '沒有符合篩選條件的訊框。' : '還沒有擷取到任何訊框。')];
      return [head, h('div', { class: 'cap-list' }, list.slice(-150).reverse().map((f) => {
        const name = protoName(f);
        return h('button', {
          type: 'button', class: 'cap-row' + (ui.sel === f.no ? ' sel' : '') + (f.how ? ' ' + f.how : ''),
          onclick: () => { ui.sel = ui.sel === f.no ? null : f.no; app.refreshLive(); },
        },
        h('span', { class: 'cap-top' }, h('i', { class: 'mono', text: String(f.no) }), h('i', { class: 'mono', text: f.t.toFixed(4) }),
          h('em', { class: 'ptag p-' + (PROTO_CLASS[name] || 'udp'), text: name }), h('i', { class: 'mono', text: String(f.len) })),
        h('span', { class: 'mono cap-addr', text: f.proto === 'arp' || f.proto === 'stp' || f.proto === 'cdp' ? `${f.smac} → ${f.dmac === BCAST ? 'Broadcast' : f.dmac}` : `${fmtIp(f.src)} → ${f.dst === 0xffffffff ? '255.255.255.255' : fmtIp(f.dst)}` }),
        h('span', { class: 'cap-info', text: infoOf(f) }));
      }))];
    }),
    ctx.live(() => {
      const c = captureOf(state, dev.id), f = c && ui.sel != null && c.frames.find((x) => x.no === ui.sel);
      return f ? h('div', { class: 'cap-detail' }, layers(f)) : null;
    })));
  void icon;
}
