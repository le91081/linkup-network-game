// 路由器的 Tunnel 介面（GRE、mGRE / DMVPN、IPsec VTI）與給 Tunnel 用的 IPsec 設定（IKE 政策、預先共用金鑰、IPsec profile）
// 和 CLI 是同一份設定：i.tun、i.nhrp、dev.isakmp、dev.ikeKeys、dev.tsets、dev.ipsecProfiles
import { h, button } from './dom.js';
import { inp, sel, field, note, del, cardHead, grid2, toggle, isIp, isNum } from './form.js';
import { newIface } from '../engine/model.js';
import { fmtIp } from '../engine/ip.js';
import { isTun, tunMode, saInfo, P1 } from '../engine/sim.js';

const DH = [['2', 'DH 2'], ['5', 'DH 5'], ['14', 'DH 14'], ['19', 'DH 19']];
const ENC = [['aes128', 'AES128'], ['aes256', 'AES256']], HASH = [['sha1', 'SHA1'], ['sha256', 'SHA256']];
const numOr = (lo, hi) => (v) => v === '' || isNum(lo, hi)(v);

/** 介面分頁：每個 Tunnel 介面一張卡片，最下面可以新增 */
export function tunnelCards(ctx, body, ifaceCard) {
  const { dev } = ctx;
  if (dev.kind !== 'router') return;
  const tuns = dev.ifaces.filter(isTun).sort((a, b) => a.bind.n - b.bind.n);
  for (const t of tuns) {
    body.append(ifaceCard(ctx, t, {
      title: t.label, ospf: true, shut: true, badge: tunBadge(ctx, t), extra: () => tunBlock(ctx, t),
      onDelete: () => { dev.ifaces = dev.ifaces.filter((x) => x !== t); dev.routes = (dev.routes || []).filter((r) => r.outIf !== t.id); ctx.commit(true); },
    }));
  }
  body.append(h('div', { class: 'addrow' }, h('span', { class: 'muted', text: 'Tunnel：把封包再包一層 IP 標頭送到遠端（GRE），可以在上面跑 OSPF；加上 IPsec 才會加密' }),
    button('新增 Tunnel', { ic: 'plus', small: true, onclick: () => {
      let n = 0;
      while (tuns.some((x) => x.bind.n === n)) n++;
      const wan = dev.ifaces.find((x) => x.bind.t === 'port' && (x.nat || x.gateway)) || dev.ifaces.find((x) => x.bind.t === 'port');
      const i = newIface('Tu' + n, 'Tunnel' + n, { t: 'gre', n }, { mask: '255.255.255.252' });
      i.tun = wan ? { src: wan.id } : {};
      dev.ifaces.push(i);
      ctx.commit(true);
    } })));
}

function tunBadge(ctx, t) {
  return ctx.live(() => h('span', { class: 'chip tiny ' + (t.rt && t.rt.link ? 'ok' : 'warn'), text: t.shut ? 'shutdown' : t.rt && t.rt.link ? 'up / up' : 'up / down' }));
}

function tunBlock(ctx, t) {
  const { dev, state } = ctx;
  const T = (t.tun ||= {}), mode = tunMode(t);
  const profs = Object.keys(dev.ipsecProfiles || {});
  const srcOpts = [['', '（選擇）'], ...dev.ifaces.filter((x) => !isTun(x) && x.bind.t !== 'wlan').map((x) => [x.id, x.label + (x.ip ? ` · ${x.ip}` : x.mode === 'dhcp' ? ' · DHCP' : '')])];
  const parts = [
    grid2(
      field('模式', sel(ctx, () => mode, (v) => { if (v === 'gre') delete T.mode; else T.mode = v; if (v === 'mgre') delete T.dst; if (v === 'ipsec') delete T.ka; if (v === 'mgre' && !t.nhrp) t.nhrp = { id: 1 }; },
        [['gre', 'GRE 點對點（tunnel mode gre ip）'], ['mgre', 'mGRE 多點（DMVPN：gre multipoint）'], ['ipsec', 'IPsec VTI（tunnel mode ipsec ipv4，只載 IPv4）'], ['ipv6ip', '6in4（tunnel mode ipv6ip，只載 IPv6）']], { rerender: true })),
      field('來源 (tunnel source)', sel(ctx, () => T.src || '', (v) => { if (v) T.src = v; else delete T.src; }, srcOpts)),
      mode !== 'mgre' && field('對端位址 (tunnel destination)', inp(ctx, () => T.dst || '', (v) => { if (v) T.dst = v; else delete T.dst; }, { ph: '對端的公用 IP', check: isIp })),
      mode !== 'ipsec' && mode !== 'ipv6ip' && field('Tunnel key（選填）', inp(ctx, () => (T.key != null ? String(T.key) : ''), (v) => { if (v === '') delete T.key; else T.key = +v; }, { ph: '兩端要一樣', check: numOr(0, 4294967295) })),
      field('加密 (tunnel protection)', sel(ctx, () => T.prot || '', (v) => { if (v) T.prot = v; else delete T.prot; },
        [['', mode === 'ipsec' ? '（VTI 一定要選一個 IPsec profile）' : '不加密（純 GRE，內容看得到）'], ...profs.map((p) => [p, `IPsec profile ${p}`])], { rerender: true })),
      field('IP MTU (ip mtu)', inp(ctx, () => (t.mtu ? String(t.mtu) : ''), (v) => { if (v === '') delete t.mtu; else t.mtu = +v; }, { ph: '自動', w: '7em', check: numOr(576, 1500) })),
      field('TCP MSS 調整 (adjust-mss)', inp(ctx, () => (t.adjMss ? String(t.adjMss) : ''), (v) => { if (v === '') delete t.adjMss; else t.adjMss = +v; }, { ph: '不調整', w: '7em', check: numOr(500, 1460) }))),
  ];
  if (mode === 'ipsec' && !profs.length) parts.push(note('warn', 'VTI 要靠 IPsec 才會 up：先到「VPN」分頁建立 IPsec profile。'));
  if (mode === 'gre') {
    parts.push(h('div', { class: 'toggles' }, toggle(ctx, () => !!T.ka, (v) => { if (v) T.ka = { sec: 10, retry: 3 }; else delete T.ka; }, 'Keepalive：對端沒有回應時把 line protocol 拉下來（沒有設定的話，只要有路到對端就一直是 up）', { rerender: true })));
    if (T.ka) parts.push(grid2(field('週期（秒）', inp(ctx, () => String(T.ka.sec), (v) => { T.ka.sec = Math.max(1, +v || 10); }, { check: isNum(1, 32767) })), field('重試次數', inp(ctx, () => String(T.ka.retry), (v) => { T.ka.retry = Math.max(1, +v || 3); }, { check: isNum(1, 255) }))));
  }
  if (mode !== 'ipsec' && mode !== 'ipv6ip') parts.push(nhrpBlock(ctx, t));
  parts.push(ctx.live(() => {
    const rt = t.rt && t.rt.tun;
    if (!rt) return null;
    if (t.shut) return note('muted', '介面被停用 (shutdown)。');
    if (!t.rt.link) return note('warn', `line protocol down：${rt.why || '設定還沒完成'}`);
    const out = [note('ok', `line protocol up · Tunnel 裡最多放得下 ${t.mtu ? Math.min(+t.mtu, rt.mtu) : rt.mtu} 位元組的封包（外面的線路 ${rt.mtu + (mode === 'ipv6ip' ? 20 : T.prot ? (mode === 'ipsec' ? 73 : 97) : 24)} 扣掉 ${mode === 'ipv6ip' ? '外層 IPv4' : mode === 'ipsec' ? 'ESP' : T.prot ? 'GRE + ESP' : 'GRE'} 的標頭）`)];
    if (mode === 'gre' && !T.ka && rt.note) out.push(note('warn', `${rt.note}。沒有 keepalive 的 GRE 照樣顯示 up。`));
    if (rt.kaLeft) out.push(note('warn', `對面沒有回應 keepalive，再 ${rt.kaLeft} 秒就會 down。`));
    const peers = rt.peers.filter((p) => p.ip != null);
    if (mode === 'mgre') out.push(peers.length ? h('div', { class: 'kv' }, ...peers.map((p) => h('div', { class: 'kv-row' }, h('span', { text: `${fmtIp(p.ip)}（${{ nhs: 'NHS', dyn: '註冊上來', res: '解析到', static: '靜態' }[p.kind] || ''}）` }), h('b', { class: 'mono', text: `NBMA ${fmtIp(p.nbma)}${p.ok ? '' : ' · 不通'}` }))))
      : note('muted', '還沒有任何 NHRP 對端。'));
    for (const n of rt.nhs.filter((x) => !x.ok)) out.push(note('warn', `向 NHS ${n.ip} 註冊失敗：${n.why}`));
    if (T.prot) {
      const sas = dev.rt.tunnels.filter((x) => x.tif === t.id);
      for (const x of sas) out.push(x.up ? note('ok', `IPsec 對 ${fmtIp(x.peerIp)}：已建立${(() => { const sa = saInfo(state, dev.id, x.name); return sa ? `（加密 ${sa.tx} / 解密 ${sa.rx} 個封包）` : ''; })()}${x.natT ? ' · NAT-T' : ''}`) : note('warn', `IPsec 對 ${fmtIp(x.peerIp)}：${x.why || '協商中'}`));
    }
    return out;
  }));
  return parts;
}

/** NHRP（DMVPN）：hub 收註冊、把 multicast 複製給 spoke；spoke 向 NHS（hub）註冊 */
function nhrpBlock(ctx, t) {
  const N = t.nhrp;
  const mode = tunMode(t);
  const on = toggle(ctx, () => !!N, (v) => { if (v) t.nhrp = { id: 1 }; else delete t.nhrp; }, 'NHRP（DMVPN）：用 NHRP 找出對端的公用位址', { rerender: true });
  if (!N) return h('div', { class: 'toggles' }, on);
  const hub = !(N.nhs || []).length;
  const mc = () => (N.mcast ||= []);
  const parts = [h('div', { class: 'toggles' }, on),
    grid2(
      field('角色', sel(ctx, () => (hub ? 'hub' : 'spoke'), (v) => { if (v === 'hub') { delete N.nhs; delete N.shortcut; } else { N.nhs = [{ ip: '', nbma: '', mcast: true }]; N.mcast = (N.mcast || []).filter((x) => x !== 'dynamic'); delete N.redirect; } },
        [['hub', 'Hub（NHS：等 spoke 來註冊）'], ['spoke', 'Spoke（向 hub 註冊）']], { rerender: true })),
      field('network-id', inp(ctx, () => String(N.id ?? ''), (v) => { N.id = +v || 1; }, { check: isNum(1, 4294967295), w: '7em' })),
      field('驗證字串（選填）', inp(ctx, () => N.auth || '', (v) => { if (v) N.auth = v.slice(0, 8); else delete N.auth; }, { ph: '最多 8 個字，兩端要一樣' })),
      field('holdtime（秒）', inp(ctx, () => (N.hold ? String(N.hold) : ''), (v) => { if (v === '' || +v === 7200) delete N.hold; else N.hold = +v; }, { ph: '7200', w: '7em', check: numOr(1, 65535) })))];
  if (hub) {
    parts.push(h('div', { class: 'toggles' },
      toggle(ctx, () => mc().includes('dynamic'), (v) => { N.mcast = v ? [...new Set([...mc(), 'dynamic'])] : mc().filter((x) => x !== 'dynamic'); }, 'ip nhrp map multicast dynamic：把 multicast（OSPF Hello）複製給每個註冊上來的 spoke'),
      toggle(ctx, () => !!N.redirect, (v) => { if (v) N.redirect = true; else delete N.redirect; }, 'ip nhrp redirect（phase 3）：流量在 hub 繞回同一個 Tunnel 時，通知 spoke 直接找對方')));
  } else {
    for (const [k, n] of N.nhs.entries()) {
      parts.push(h('div', { class: 'addrow' },
        inp(ctx, () => n.ip || '', (v) => { n.ip = v; }, { ph: 'NHS（hub）的 Tunnel 位址', check: isIp }),
        inp(ctx, () => n.nbma || '', (v) => { if (v) n.nbma = v; else delete n.nbma; }, { ph: 'hub 的公用 IP (NBMA)', check: isIp }),
        toggle(ctx, () => !!n.mcast, (v) => { if (v) n.mcast = true; else delete n.mcast; }, 'multicast'),
        N.nhs.length > 1 && del(() => { N.nhs.splice(k, 1); ctx.commit(true); })));
    }
    parts.push(h('div', { class: 'toggles' }, toggle(ctx, () => !!N.shortcut, (v) => { if (v) N.shortcut = true; else delete N.shortcut; }, 'ip nhrp shortcut（phase 3）：收到 hub 的 Redirect 之後，在路由表裝一筆直接到對方 spoke 的捷徑（H）')));
    if (mode !== 'mgre') parts.push(note('muted', '點對點的 GRE 只能連到 hub（DMVPN phase 1）；要 spoke 之間直接連線，模式改成 mGRE。'));
  }
  return h('div', { class: 'sub' }, parts);
}

/** VPN 分頁：給 Tunnel 介面用的 IPsec（IKE 政策、預先共用金鑰、transform-set、IPsec profile、NAT-T） */
export function ipsecCards(ctx, body) {
  const { dev } = ctx;
  if (dev.kind !== 'router' || !dev.vpns) return;
  const pols = dev.isakmp || [];
  const keys = Object.entries(dev.ikeKeys || {});
  const ike = h('div', { class: 'card' }, cardHead('IKE 第一階段（crypto isakmp）'),
    pols.length ? null : note('muted', '還沒有設定 IKE 政策：Tunnel 的 IPsec 會用預設的 AES128 / SHA1 / DH 2（兩端都沒設定才對得上）。'));
  pols.forEach((p, k) => ike.append(h('div', { class: 'addrow' }, h('span', { class: 'pno', text: `#${p.n}` }),
    sel(ctx, () => p.enc, (v) => { p.enc = v; }, ENC), sel(ctx, () => p.hash, (v) => { p.hash = v; }, HASH), sel(ctx, () => String(p.dh), (v) => { p.dh = v; }, DH),
    del(() => { dev.isakmp.splice(k, 1); if (!dev.isakmp.length) delete dev.isakmp; ctx.commit(true); }))));
  ike.append(h('div', { class: 'addrow' }, button('新增 IKE 政策', { ic: 'plus', small: true, onclick: () => { const n = ((pols[pols.length - 1] || {}).n || 0) + 10; (dev.isakmp ||= []).push({ n, enc: 'aes256', hash: 'sha256', dh: '14' }); ctx.commit(true); } })));
  if (pols.length) ike.append(note('muted', `兩端要有一組相同的提案：${pols.map(P1).join('；')}`));
  ike.append(h('b', { class: 'mini-h', text: '預先共用金鑰（crypto isakmp key）' }));
  for (const [addr, key] of keys) {
    ike.append(h('div', { class: 'addrow' },
      inp(ctx, () => addr, (v) => { if (!isIp(v) || v === addr) return; const ks = dev.ikeKeys; delete ks[addr]; ks[v] = key; for (const t of dev.vpns) if (t.peer === v) t.psk = key; }, { ph: '對端位址', check: isIp, rerender: true }),
      inp(ctx, () => key, (v) => { dev.ikeKeys[addr] = v; for (const t of dev.vpns) if (t.peer === addr) t.psk = v; }, { ph: '金鑰' }),
      del(() => { delete dev.ikeKeys[addr]; if (!Object.keys(dev.ikeKeys).length) delete dev.ikeKeys; ctx.commit(true); })));
  }
  ike.append(h('div', { class: 'addrow' }, button('新增金鑰', { ic: 'plus', small: true, onclick: () => { const ks = (dev.ikeKeys ||= {}); let a = '0.0.0.0'; if (a in ks) a = '192.0.2.1'; ks[a] = ''; ctx.commit(true); } })),
    note('muted', '位址寫 0.0.0.0 代表「任何對端」：DMVPN 的 spoke 之間互相不知道對方的位址，要靠萬用的金鑰。'),
    h('div', { class: 'toggles' }, toggle(ctx, () => !dev.noNatT, (v) => { if (v) delete dev.noNatT; else dev.noNatT = true; }, 'NAT-T：中間有 NAT 時把 ESP 包進 UDP 4500（IOS 預設開啟）')));
  body.append(ike);

  const profs = Object.entries(dev.ipsecProfiles || {});
  const card = h('div', { class: 'card' }, cardHead('IPsec profile（給 Tunnel 介面加密用）'),
    profs.length ? null : note('muted', 'IPsec profile 套在 Tunnel 介面上（tunnel protection ipsec profile）：GRE over IPsec、VTI、DMVPN 都用它。和 crypto map 不同，不用寫「哪些流量要加密」的 ACL：路由進 Tunnel 的封包就會被加密。'));
  for (const [name, p] of profs) {
    const tsName = p.tset || `TS-${name}`;
    const ts = (dev.tsets || {})[p.tset] || { enc2: 'aes128', hash2: 'sha1' };
    const setTs = (k, v) => { const all = (dev.tsets ||= {}); all[tsName] = { ...ts, ...(all[tsName] || {}), [k]: v }; if (k === 'mode' && v === 'tunnel') delete all[tsName].mode; p.tset = tsName; };
    const users = dev.ifaces.filter((i) => isTun(i) && i.tun && i.tun.prot === name).map((i) => i.label);
    card.append(h('div', { class: 'sub' },
      h('div', { class: 'addrow' }, h('b', { class: 'mono', text: name }), h('span', { class: 'muted', text: users.length ? `使用中：${users.join('、')}` : '還沒有 Tunnel 使用' }),
        !users.length && del(() => { delete dev.ipsecProfiles[name]; if (!Object.keys(dev.ipsecProfiles).length) delete dev.ipsecProfiles; ctx.commit(true); })),
      grid2(
        field(`加密（transform-set ${tsName}）`, sel(ctx, () => ts.enc2, (v) => setTs('enc2', v), ENC)),
        field('雜湊', sel(ctx, () => ts.hash2, (v) => setTs('hash2', v), HASH)),
        field('模式', sel(ctx, () => ts.mode || 'tunnel', (v) => setTs('mode', v), [['tunnel', 'tunnel'], ['transport', 'transport（GRE over IPsec 常用，少 20 位元組）']])),
        field('PFS', sel(ctx, () => p.pfs || '', (v) => { if (v) p.pfs = v; else delete p.pfs; }, [['', '不使用'], ...DH])),
        field('金鑰壽命（秒）', inp(ctx, () => (p.life2 ? String(p.life2) : ''), (v) => { if (v === '') delete p.life2; else p.life2 = +v; }, { ph: '3600', w: '7em', check: numOr(120, 86400) }))),
      p.tset ? null : note('muted', '還沒有選加密方式：用 IOS 預設的 AES128 / SHA1。')));
  }
  card.append(h('div', { class: 'addrow' }, button('新增 IPsec profile', { ic: 'plus', small: true, onclick: () => {
    const ps = (dev.ipsecProfiles ||= {});
    let n = 1;
    while (ps['PROF' + n]) n++;
    ps['PROF' + n] = {};
    ctx.commit(true);
  } })));
  body.append(card);
}
