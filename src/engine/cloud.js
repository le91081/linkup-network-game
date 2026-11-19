// 公有雲的虛擬私有雲 (VPC)：以 AWS 的 Amazon VPC 為模型。
//
// 一台 kind: 'cloud' 的設備代表雲端業者的一個區域 (region) 裡的一個 VPC。它的「網際網路閘道」介面接到 ISP，
// 裡面的子網路、路由表、閘道、執行個體 (EC2) 都是虛擬的，封包在這裡依照 AWS 的規則處理：
//   ‧ 每個子網路用一張路由表：有 0.0.0.0/0 → igw 的才是「公有子網路」
//   ‧ 網際網路閘道 (IGW) 替有彈性 IP (EIP) 的執行個體做一對一 NAT；沒有公用 IP 的執行個體出不去
//   ‧ NAT 閘道放在公有子網路，讓私有子網路的執行個體只能「由內往外」連線
//   ‧ 安全群組 (SG) 掛在執行個體上，只有允許規則、有狀態：回應自動放行
//   ‧ 網路 ACL 掛在子網路上，有編號、有拒絕規則、無狀態：回應封包（目的是用戶端的臨時連接埠）也要明確允許
//   ‧ 虛擬私有閘道 (VGW) 與站對站 VPN：沿用 IPsec 的引擎（d.vpns），路由表要有往地端網段 → vgw 的路由（或開啟路由傳播）
import { parseIp, parseCidr, netOf, fmtIp, maskOf } from './ip.js';

export const CLOUD_REGION = 'ap-northeast-1';
/** AWS 站對站 VPN 接受的提案：客戶閘道提出其中任何一組都談得成；第二階段一定要有 PFS */
export const AWS_P1 = ['aes128-sha1', 'aes256-sha1', 'aes128-sha256', 'aes256-sha256'];
export const AWS_DH = ['2', '14', '15', '16', '19', '20', '21'];
const ALL = { proto: 'all', port: '', cidr: '0.0.0.0/0' };
export function newVpc() {
  return {
    cidr: '10.0.0.0/16', igw: false, eips: [], subnets: [],
    rts: [{ id: 'rtb-main', name: '主路由表', main: true, routes: [], prop: false }],
    nacls: [{ id: 'acl-default', name: '預設 ACL', def: true, in: [{ n: 100, act: 'allow', ...ALL }], out: [{ n: 100, act: 'allow', ...ALL }] }],
    sgs: [{ id: 'sg-default', name: 'default', in: [{ proto: 'all', port: '', src: 'sg-default' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] }],
    natgws: [], instances: [], vgw: false,
  };
}

/** AWS 每個子網路保留前四個與最後一個位址：網路位址、VPC 路由器 (.1)、DNS (.2)、保留 (.3)、廣播 */
export function reservedWhy(ip, sub) {
  const c = parseCidr(sub.cidr);
  if (!c) return '';
  const off = ip - c.net, size = 2 ** (32 - c.bits);
  return off === 0 ? '子網路的網路位址' : off === 1 ? 'AWS 保留給 VPC 路由器（子網路的第一個位址）' : off === 2 ? 'AWS 保留給 DNS（Amazon 提供的 DNS 伺服器）' : off === 3 ? 'AWS 保留的位址' : off === size - 1 ? 'AWS 保留的位址（子網路的最後一個位址）' : '';
}
const inCidr = (ip, c) => c && netOf(ip, c.bits) === c.net;
export const subnetOf = (v, x) => v.subnets.find((s) => s.id === x.subnet);
export const rtOf = (v, sub) => v.rts.find((r) => r.id === (sub && sub.rtb)) || v.rts.find((r) => r.main);
export const naclOf = (v, sub) => v.nacls.find((n) => n.id === (sub && sub.nacl)) || v.nacls.find((n) => n.def);
export const instOf = (v, ip) => v.instances.find((x) => parseIp(x.ip || '') === ip);
/** 子網路是公有還是私有：看它的路由表有沒有 0.0.0.0/0 → igw */
export const isPublic = (v, sub) => rtOf(v, sub).routes.some((r) => r.dst === '0.0.0.0/0' && r.target === 'igw');

function portIn(spec, port) {
  const s = String(spec ?? '').trim();
  if (!s || s === 'all') return true;
  const m = s.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  return !!m && port >= +m[1] && port <= +(m[2] ?? m[1]);
}
const protoIn = (p, pkt) => !p || p === 'all' || p === pkt.proto;

/** 網路 ACL：照規則編號由小到大，第一條符合的決定；都不符合就是最後的 * 拒絕。回傳 null 表示允許，否則回傳原因 */
export function naclCheck(acl, dir, pkt, peer, port) {
  const rules = (acl[dir] || []).slice().sort((a, b) => a.n - b.n);
  for (const r of rules) {
    if (!protoIn(r.proto, pkt)) continue;
    if (pkt.proto !== 'icmp' && !portIn(r.port, port)) continue;
    if (!inCidr(peer, parseCidr(r.cidr || '0.0.0.0/0'))) continue;
    return r.act === 'allow' ? null : `規則 #${r.n} 拒絕`;
  }
  return '沒有符合的規則（最後的 * 預設拒絕）';
}
/** 安全群組：只有允許規則，只要掛在執行個體上的任何一個群組允許就通過 */
function sgAllows(v, x, dir, pkt, peer, port) {
  for (const id of x.sgs || []) {
    const g = v.sgs.find((s) => s.id === id);
    if (!g) continue;
    for (const r of g[dir] || []) {
      if (!protoIn(r.proto, pkt)) continue;
      if (pkt.proto !== 'icmp' && !portIn(r.port, port)) continue;
      const who = dir === 'in' ? r.src : r.dst;
      if (/^sg-/.test(who || '')) { const p = instOf(v, peer); if (p && (p.sgs || []).includes(who)) return true; continue; }
      if (inCidr(peer, parseCidr(who || '0.0.0.0/0'))) return true;
    }
  }
  return false;
}
const sgNames = (v, x) => (x.sgs || []).map((id) => (v.sgs.find((g) => g.id === id) || {}).name || id).join('、') || '（沒有掛任何安全群組）';
const pdesc = (pkt, port) => (pkt.proto === 'icmp' ? 'ICMP' : `${pkt.proto.toUpperCase()} ${port}`);

/** 路由表查詢：local（VPC 的 CIDR）、自己加的路由、路由傳播來的 VPN 網段。最長相符 */
export function rtLookup(dev, v, rt, ip) {
  const cands = [{ dst: v.cidr, target: 'local' }, ...rt.routes];
  if (rt.prop && v.vgw) for (const t of dev.vpns || []) for (const c of String(t.remote || '').split(/[,\s]+/).filter(Boolean)) cands.push({ dst: c, target: 'vgw', prop: true });
  let best = null, bb = -1;
  for (const r of cands) {
    const c = parseCidr(r.dst);
    if (!c || !inCidr(ip, c)) continue;
    if (c.bits > bb) { best = r; bb = c.bits; }
  }
  return best;
}

/** 計算：把彈性 IP 掛到網際網路閘道上（讓 ISP 那一端的 ARP 找得到），順便檢查設定的問題 */
export function prepCloud(state) {
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'cloud' || !d.vpc) continue;
    const v = d.vpc, igw = d.ifaces.find((i) => i.id === 'igw');
    const issues = [];
    const vc = parseCidr(v.cidr);
    if (!vc) issues.push(`VPC 的 CIDR「${v.cidr}」格式不對`);
    else if (vc.bits < 16 || vc.bits > 28) issues.push(`VPC 的 CIDR 要在 /16 到 /28 之間（現在是 /${vc.bits}）`);
    for (const s of v.subnets) {
      const c = parseCidr(s.cidr);
      if (!c) { issues.push(`子網路 ${s.name} 的 CIDR 格式不對`); continue; }
      if (vc && !(c.bits >= vc.bits && netOf(c.net, vc.bits) === vc.net)) issues.push(`子網路 ${s.name}（${s.cidr}）不在 VPC 的 ${v.cidr} 裡面`);
      for (const o of v.subnets) { const oc = parseCidr(o.cidr); if (o !== s && oc && v.subnets.indexOf(o) < v.subnets.indexOf(s) && netOf(c.net, Math.min(c.bits, oc.bits)) === netOf(oc.net, Math.min(c.bits, oc.bits))) issues.push(`子網路 ${s.name} 和 ${o.name} 的位址範圍重疊`); }
    }
    for (const x of v.instances) {
      const s = subnetOf(v, x), ip = parseIp(x.ip || '');
      x.rtWhy = '';
      if (!s) x.rtWhy = '沒有指定子網路';
      else if (ip == null) x.rtWhy = '私有 IP 格式不對';
      else if (!inCidr(ip, parseCidr(s.cidr))) x.rtWhy = `私有 IP ${x.ip} 不在子網路 ${s.name}（${s.cidr}）裡`;
      else if (reservedWhy(ip, s)) x.rtWhy = `${x.ip} 是 ${reservedWhy(ip, s)}，不能給執行個體用`;
      if (x.rtWhy) issues.push(`${x.name}：${x.rtWhy}`);
    }
    for (const n of v.natgws) if (!subnetOf(v, n)) issues.push(`NAT 閘道 ${n.id} 沒有指定子網路`);
    // AWS 那一端的 VPN：本地網段就是整個 VPC，接受大部分的提案；沒有連接 VGW 的話通道建不起來
    for (const t of d.vpns || []) {
      t.local = v.cidr;
      t.props ||= AWS_P1; t.dhs ||= AWS_DH; t.props2 ||= AWS_P1; t.pfsList ||= AWS_DH;
      t.off = !v.vgw; t.offWhy = 'VPC 沒有連接虛擬私有閘道 (VGW)';
    }
    d.rt.cloud = { issues };
    if (!igw || !igw.rt.ip || !v.igw) continue;
    const pubs = [...v.instances.map((x) => x.eip), ...v.natgws.map((n) => n.eip)].map((e) => parseIp(e || '')).filter((e) => e != null);
    for (const p of pubs) if (!igw.rt.vips.includes(p)) igw.rt.vips.push(p);
  }
}

/** isLocal 用：這個 VPC 裡的私有 IP 或公用 IP */
export function cloudOwns(dev, ip) {
  const v = dev.vpc;
  if (!v) return false;
  return !!instOf(v, ip) || v.instances.some((x) => x.rtWhy === '' && parseIp(x.eip || '') === ip) || v.natgws.some((n) => parseIp(n.eip || '') === ip);
}

/**
 * 封包進到 VPC（或從 VPC 裡的執行個體送出）時的處理。回傳：
 *   { pass: true }      不是給執行個體的（VPN 端點自己的 IKE / ESP）：照一般路由器的流程
 *   { drop: 原因 }       丟棄
 *   { done: true }       送到了執行個體
 *   { out: {iface, via} } 從網際網路閘道送出去（位址已經換好）
 *   { tunnel: T }        走站對站 VPN
 */
export function cloudStep(state, ctx, dev, inIf, pkt, H) {
  const v = dev.vpc;
  const igw = dev.ifaces.find((i) => i.id === 'igw');
  const log = (kind, text) => ctx.log.push({ dev: dev.id, kind, text });
  if (!v || (igw && igw.rt.ip != null && (pkt.dst === igw.rt.ip || pkt.src === igw.rt.ip))) return { pass: true };

  /** 封包送到某一台執行個體：子網路的 NACL（跨子網路時）、安全群組（新連線）、上面有沒有服務 */
  const toInstance = (y, fromSub, via) => {
    if (!y) return { drop: `VPC 裡沒有 ${fmtIp(pkt.dst)} 這個位址` };
    if (y.rtWhy) return { drop: `${y.name} 的設定有問題：${y.rtWhy}` };
    const ys = subnetOf(v, y), port = pkt.dport;
    if (fromSub !== ys) {
      const why = naclCheck(naclOf(v, ys), 'in', pkt, pkt.src, port);
      if (why) return { drop: `子網路 ${ys.name} 的網路 ACL「${naclOf(v, ys).name}」（輸入）擋下 ${pdesc(pkt, port)}（來源 ${fmtIp(pkt.src)}）：${why}${pkt.reply ? '。網路 ACL 是無狀態的：這是回應封包，目的埠是臨時連接埠 (1024 – 65535)，輸入規則也要允許' : ''}` };
    }
    if (!pkt.reply) {
      if (!sgAllows(v, y, 'in', pkt, pkt.src, port)) return { drop: `${y.name} 的安全群組（${sgNames(v, y)}）沒有允許 ${pdesc(pkt, port)} 從 ${fmtIp(pkt.src)} 進來${pkt.proto === 'icmp' ? '（ping 也要另外允許 ICMP）' : ''}` };
      if (pkt.proto !== 'icmp' && !(y.services || []).some((s) => s.proto === pkt.proto && +s.port === port)) return { drop: `${y.name} 沒有在 ${pkt.proto.toUpperCase()}/${port} 提供服務（連線被拒絕）` };
    }
    log('ok', `${via}送達 ${y.name}（${y.ip}）${pkt.reply ? '' : `，安全群組 ${sgNames(v, y)} 允許`}`);
    return { done: true };
  };

  // ── 從網際網路閘道進來 ──
  if (inIf && inIf.id === 'igw') {
    if (!v.igw) return { drop: '這個 VPC 沒有連接網際網路閘道 (IGW)' };
    let y = null;
    if (pkt.reply) {
      // 由內往外的連線的回應：照連線表把公用 IP 換回私有 IP（NAT 閘道或 EIP）
      const e = (ctx.ct[dev.id] || []).find((x) => x.proto === pkt.proto && x.nDst === pkt.src && x.nSrc === pkt.dst && x.nDport === pkt.sport && x.nSport === pkt.dport);
      if (e) { log('nat', `${e.natgw ? 'NAT 閘道' : '網際網路閘道'}：${fmtIp(pkt.dst)} 換回 ${fmtIp(e.src)}`); pkt.dst = e.src; y = instOf(v, e.src); if (e.natgw) { const why = natSubnetCheck(v.natgws.find((g) => g.id === e.natgw) || {}, 'in', pkt.src, pkt.dport); if (why) return { drop: why }; } }
      else y = v.instances.find((x) => parseIp(x.eip || '') === pkt.dst);
      if (!y) return { drop: `${fmtIp(pkt.dst)} 沒有對應的執行個體` };
      if (!e) { log('nat', `網際網路閘道：EIP ${fmtIp(pkt.dst)} 換成 ${y.ip}`); pkt.dst = parseIp(y.ip); }
    } else {
      y = v.instances.find((x) => parseIp(x.eip || '') === pkt.dst);
      if (!y) {
        const n = v.natgws.find((x) => parseIp(x.eip || '') === pkt.dst);
        return { drop: n ? `${fmtIp(pkt.dst)} 是 NAT 閘道的 EIP：NAT 閘道只讓私有子網路「由內往外」連線，外面主動連進來的一律丟棄` : `${fmtIp(pkt.dst)} 沒有對應的執行個體` };
      }
      log('nat', `網際網路閘道：EIP ${fmtIp(pkt.dst)} 換成 ${y.name} 的私有 IP ${y.ip}（一對一 NAT）`);
      pkt.dst = parseIp(y.ip);
    }
    return toInstance(y, null, '');
  }
  // ── 從站對站 VPN 進來（已經解密） ──
  if (inIf && inIf.bind && inIf.bind.t === 'tun') {
    if (!v.vgw) return { drop: '這個 VPC 沒有連接虛擬私有閘道 (VGW)' };
    return toInstance(instOf(v, pkt.dst), null, 'VPN：');
  }
  if (inIf) return { drop: `${dev.name} 不轉送別人的封包` };

  // ── 從 VPC 裡的執行個體送出 ──
  const x = instOf(v, pkt.src);
  if (!x) return { pass: true };
  if (x.rtWhy) return { drop: `${x.name} 的設定有問題：${x.rtWhy}` };
  const xs = subnetOf(v, x), port = pkt.dport;
  if (!pkt.reply && !sgAllows(v, x, 'out', pkt, pkt.dst, pkt.dport)) return { drop: `${x.name} 的安全群組（${sgNames(v, x)}）的輸出規則不允許 ${pdesc(pkt, pkt.dport)} 到 ${fmtIp(pkt.dst)}` };
  const rt = rtOf(v, xs);
  const r = rtLookup(dev, v, rt, pkt.dst);
  if (!r) return { drop: `子網路 ${xs.name} 的路由表「${rt.name}」沒有往 ${fmtIp(pkt.dst)} 的路由（只有 VPC 內部的 local 路由）` };
  const crossing = r.target !== 'local' || (instOf(v, pkt.dst) && subnetOf(v, instOf(v, pkt.dst)) !== xs);
  if (crossing) {
    const why = naclCheck(naclOf(v, xs), 'out', pkt, pkt.dst, port);
    if (why) return { drop: `子網路 ${xs.name} 的網路 ACL「${naclOf(v, xs).name}」（輸出）擋下 ${pdesc(pkt, port)}（目的 ${fmtIp(pkt.dst)}）：${why}${pkt.reply ? '。網路 ACL 是無狀態的：回應封包的目的埠是用戶端的臨時連接埠 (1024 – 65535)，輸出規則也要允許' : ''}` };
  }
  log('fwd', `${x.name} 所在的子網路 ${xs.name} 用路由表「${rt.name}」：${r.dst} → ${r.target === 'local' ? 'local' : r.target}${r.prop ? '（路由傳播）' : ''}`);
  if (r.target === 'local') return toInstance(instOf(v, pkt.dst), xs, '');
  if (r.target === 'igw') {
    if (!v.igw) return { drop: `路由表「${rt.name}」指向網際網路閘道，但 VPC 沒有連接 IGW（黑洞路由）` };
    if (!x.eip) return { drop: `${x.name} 沒有公用 IP（彈性 IP）：網際網路閘道只替有公用 IP 的執行個體轉換位址，私有 IP 出不去。私有子網路要經過 NAT 閘道` };
    const nSrc = parseIp(x.eip);
    if (!pkt.reply && !pkt.ack) H.track(state, ctx, dev, { proto: pkt.proto, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport, nSrc, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport, inIf: xs.name, outIf: 'igw', rule: 0 });
    log('nat', `網際網路閘道：來源 ${x.ip} 換成 EIP ${x.eip}`);
    pkt.src = nSrc;
    return { out: { iface: igw, via: igw.rt.gw } };
  }
  if (/^nat-/.test(r.target)) {
    const n = v.natgws.find((g) => g.id === r.target);
    if (!n) return { drop: `路由表「${rt.name}」指向的 NAT 閘道 ${r.target} 不存在（黑洞路由）` };
    if (pkt.reply) return { drop: 'NAT 閘道只能由內往外：外面主動連進私有子網路的連線不會經過它' };
    const ns = subnetOf(v, n);
    if (!ns || !isPublic(v, ns)) return { drop: `NAT 閘道 ${n.id} 放在子網路 ${ns ? ns.name : '?'}，那個子網路的路由表沒有 0.0.0.0/0 → igw：NAT 閘道要放在「公有」子網路才出得去` };
    if (!v.igw) return { drop: 'NAT 閘道要經過網際網路閘道出去，但 VPC 沒有連接 IGW' };
    if (!n.eip) return { drop: `NAT 閘道 ${n.id} 沒有彈性 IP` };
    const why = natSubnetCheck(n, 'out', pkt.dst, pkt.dport);
    if (why) return { drop: why };
    const nSrc = parseIp(n.eip);
    if (!pkt.ack) H.track(state, ctx, dev, { proto: pkt.proto, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport, nSrc, nSport: pkt.sport, nDst: pkt.dst, nDport: pkt.dport, inIf: xs.name, outIf: 'igw', rule: 0, natgw: n.id });
    log('nat', `NAT 閘道 ${n.id}（在 ${ns.name}）：來源 ${x.ip} 換成 ${n.eip}`);
    pkt.src = nSrc;
    return { out: { iface: igw, via: igw.rt.gw } };
  }
  if (r.target === 'vgw') {
    if (!v.vgw) return { drop: `路由表「${rt.name}」指向虛擬私有閘道，但 VPC 沒有連接 VGW` };
    const t = H.findTunnel(dev, pkt);
    if (!t) return { drop: `沒有一條 VPN 連線的網段包含 ${fmtIp(pkt.dst)}` };
    return { tunnel: t };
  }
  return { drop: `路由的目標 ${r.target} 不存在` };

  // NAT 閘道所在子網路的 ACL：封包從私有子網路進到 NAT 閘道、再從 NAT 閘道出去
  function natSubnetCheck(n, dir, peer, p) {
    const ns = subnetOf(v, n), acl = naclOf(v, ns);
    const why = naclCheck(acl, dir, pkt, peer, p);
    return why ? `NAT 閘道所在的子網路 ${ns.name} 的網路 ACL「${acl.name}」（${dir === 'in' ? '輸入' : '輸出'}）擋下 ${pdesc(pkt, p)}：${why}` : '';
  }
}


/** AWS 產生的預先共用金鑰：32 個英數字（可以有 . 與 _，不能以 0 開頭） */
export function awsPsk() {
  const ch = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._';
  let s = '';
  for (let i = 0; i < 32; i++) s += ch[Math.floor(Math.random() * (i ? ch.length : 52))];
  return s;
}
/** 「下載設定檔」：給客戶閘道的範例設定 */
export function vpnConfig(dev, t, vendor) {
  const igw = dev.ifaces.find((i) => i.id === 'igw'), v = dev.vpc;
  const c = parseCidr(v.cidr), r = parseCidr(String(t.remote || '').split(/[,\s]+/)[0] || '');
  const mask = (x) => (x ? fmtIp(x.bits === 0 ? 0 : (0xffffffff << (32 - x.bits)) >>> 0) : '?');
  const wild = (x) => (x ? fmtIp(~(x.bits === 0 ? 0 : (0xffffffff << (32 - x.bits)) >>> 0) >>> 0) : '?');
  const aws = igw.ip || '?';
  if (vendor === 'forti') {
    return [`# Amazon Web Services — VPN 連線 ${t.name}`, `# 客戶閘道：FortiGate（${t.peer}）`, '', 'config vpn ipsec phase1-interface', '    edit "aws-vpn"', '        set interface "wan1"', `        set ike-version ${t.ike === 1 ? 1 : 2}`, '        set proposal aes256-sha256', '        set dhgrp 14', `        set remote-gw ${aws}`, `        set psksecret ${t.psk}`, '    next', 'end',
      'config vpn ipsec phase2-interface', '    edit "aws-vpn"', '        set phase1name "aws-vpn"', '        set proposal aes256-sha256', '        set dhgrp 14', `        set src-subnet ${r ? fmtIp(r.net) + ' ' + mask(r) : '?'}`, `        set dst-subnet ${c ? fmtIp(c.net) + ' ' + mask(c) : '?'}`, '    next', 'end',
      'config router static', '    edit 0', `        set dst ${c ? fmtIp(c.net) + ' ' + mask(c) : '?'}`, '        set device "aws-vpn"', '    next', 'end', '', '# 另外還要兩條防火牆政策：internal → aws-vpn 與 aws-vpn → internal'].join('\n');
  }
  const v2 = t.ike !== 1;
  return [`! Amazon Web Services — VPN 連線 ${t.name}`, `! 客戶閘道：Cisco ISR（${t.peer}）`, '! 以下設定在全域設定模式下輸入；外部介面請換成實際接 ISP 的介面', '!',
    ...(v2 ? ['crypto ikev2 proposal AWS-PROP', ' encryption aes-cbc-256', ' integrity sha256', ' group 14', 'crypto ikev2 policy AWS-POL', ' proposal AWS-PROP', 'crypto ikev2 keyring AWS-KR', ' peer AWS', `  address ${aws}`, `  pre-shared-key ${t.psk}`, 'crypto ikev2 profile AWS-PROF', ` match identity remote address ${aws} 255.255.255.255`, ' authentication remote pre-share', ' authentication local pre-share', ' keyring local AWS-KR']
      : ['crypto isakmp policy 200', ' encryption aes 256', ' hash sha256', ' authentication pre-share', ' group 14', ' lifetime 28800', `crypto isakmp key ${t.psk} address ${aws}`]),
    'crypto ipsec transform-set AWS-TS esp-aes 256 esp-sha256-hmac', ' mode tunnel',
    `ip access-list extended AWS-VPN`, ` permit ip ${r ? fmtIp(r.net) + ' ' + wild(r) : '?'} ${c ? fmtIp(c.net) + ' ' + wild(c) : '?'}`,
    'crypto map AWS-MAP 10 ipsec-isakmp', ` set peer ${aws}`, ' set transform-set AWS-TS', ' set pfs group14', ...(v2 ? [' set ikev2-profile AWS-PROF'] : []), ' match address AWS-VPN',
    'interface GigabitEthernet0/0/0', ' crypto map AWS-MAP', '!', '! 往 VPC 的流量不能被 NAT 轉換：NAT 用的 ACL 要先 deny 這段（NAT 例外）',
    `! 例如：ip access-list extended NAT-ACL → deny ip ${r ? fmtIp(r.net) + ' ' + wild(r) : '?'} ${c ? fmtIp(c.net) + ' ' + wild(c) : '?'} → permit ip ${r ? fmtIp(r.net) + ' ' + wild(r) : '?'} any`].join('\n');
}
