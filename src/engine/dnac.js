// Catalyst Center（以前叫 DNA Center）：控制器式網路的管理平面。
// 北向 (northbound) 是給程式呼叫的 REST API：先用帳號密碼換一個 Token，之後每個請求都帶 X-Auth-Token。
// 南向 (southbound) 是它管理設備的方式：用 SNMP 與 SSH 輪詢設備——這裡真的會送封包，管理 IP、路由、ACL 有問題就是 Unreachable。
// Assurance 依照網路的實際狀態產生「問題」(issues)：設備連不到、某個 VLAN 的 DHCP 失敗率偏離基準 (AI)、雙工不一致、速率降級…
import { parseIp, fmtIp } from './ip.js';
import { transact } from './sim.js';
import { linkInfo, peerOf } from './model.js';
import { ensureFlash } from './files.js';
import { hostName, iosSession } from './ios.js';

const PLATFORM = { c9300: 'C9300-24T', c2960: 'WS-C2960CX-8TC-L', c2960p: 'WS-C2960CX-8PC-L', isr4321: 'ISR4321/K9', isr4331: 'ISR4331/K9', c9800: 'C9800-L-F-K9', n93180: 'N9K-C93180YC-FX', n9332: 'N9K-C9332C' };
const ROLE = { router: 'BORDER ROUTER', l3switch: 'DISTRIBUTION', mswitch: 'ACCESS', wlc: 'ACCESS' };
const FAMILY = { router: 'Routers', l3switch: 'Switches and Hubs', mswitch: 'Switches and Hubs', wlc: 'Wireless Controller' };
const TOKEN_LIFE = 3600;

function hex(s, n) {
  let x = 2166136261, out = '';
  while (out.length < n) { for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); out += (x >>> 0).toString(16).padStart(8, '0'); s += out.length; }
  return out.slice(0, n);
}
const uuid = (s) => { const h = hex('dnac/' + s, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };

/** 控制器看到的設備清單：每台都用 SNMP (UDP 161) 與 SSH (TCP 22) 實際輪詢一次 */
export function inventory(state, ctl) {
  return (ctl.dnac.managed || []).map((m) => {
    const d = state.devices[m.id];
    if (!d) return null;
    ensureFlash(d);
    const ip = parseIp(m.ip);
    const snmp = transact(state, ctl.id, { proto: 'udp', dst: ip, dport: 161, quiet: true });
    const ssh = snmp.ok ? transact(state, ctl.id, { proto: 'tcp', dst: ip, dport: 22, quiet: true }) : null;
    const ok = snmp.ok && ssh.ok;
    return {
      dev: d.id, why: ok ? '' : (snmp.ok ? ssh : snmp).reason,
      json: {
        hostname: hostName(d), managementIpAddress: m.ip, platformId: PLATFORM[d.model] || d.model, softwareVersion: (d.fw && d.fw.ver) || '',
        role: m.role || ROLE[d.kind] || 'UNKNOWN', family: FAMILY[d.kind] || 'Unknown', type: m.type || '',
        reachabilityStatus: ok ? 'Reachable' : 'Unreachable',
        reachabilityFailureReason: ok ? '' : snmp.ok ? 'SSH Connection Failed' : 'SNMP Timeouts',
        collectionStatus: ok ? 'Managed' : 'Partial Collection Failure',
        serialNumber: 'FOC' + hex(d.id, 8).toUpperCase(), id: uuid(d.id),
      },
    };
  }).filter(Boolean);
}

/** Assurance 的問題清單：由網路的實際狀態推導 */
export function issues(state, ctl) {
  const out = [];
  const inv = inventory(state, ctl);
  for (const x of inv) {
    if (x.json.reachabilityStatus === 'Unreachable') {
      out.push({ name: `Network Device ${x.json.managementIpAddress} Is Unreachable From Controller`, priority: 'P1', category: 'Availability', aiDriven: 'No', deviceId: x.json.id, device: x.json.hostname,
        description: `控制器用 ${x.json.reachabilityFailureReason === 'SNMP Timeouts' ? 'SNMP' : 'SSH'} 輪詢 ${x.json.hostname} 沒有回應。`, suggestedActions: ['確認設備的管理 IP 與預設閘道', '從控制器所在的網段 ping / traceroute 設備的管理 IP', '確認 SNMP 與 SSH 的設定、ACL'] });
    }
  }
  for (const m of ctl.dnac.managed || []) {
    const d = state.devices[m.id];
    if (!d || !d.sw || d.sw.mode !== 'vlan') continue;
    const byVlan = {};
    for (const p of d.ports) {
      const pc = d.sw.ports[p.id], peer = peerOf(state, d.id, p.id);
      if (!pc || !peer) continue;
      const h = state.devices[peer.dev];
      // 用戶端：DHCP 拿不到位址
      if (h.kind === 'host' && pc.mode === 'access' && h.ifaces[0] && h.ifaces[0].mode === 'dhcp') {
        const rt = h.ifaces[0].rt || {};
        const b = (byVlan[pc.vlan] ||= { n: 0, bad: 0 });
        b.n++;
        if (rt.ip == null || rt.src === 'apipa') b.bad++;
      }
      // 介面：雙工不一致、速率降級
      const li = linkInfo(state, d.id, p.id);
      if (li && !li.down && li.mismatch) out.push({ name: `Interface ${longName(p.label)} On ${hostName(d)} Has A Duplex Mismatch`, priority: 'P2', category: 'Connectivity', aiDriven: 'No', device: hostName(d), deviceId: uuid(d.id),
        description: `${longName(p.label)}（接 ${h.name}）一端是全雙工、另一端是半雙工：late collision 與 CRC 錯誤持續增加，傳輸速度遠低於 ${li.speed} Mbps。`, suggestedActions: ['兩端都改回 speed auto / duplex auto，或兩端寫死成一樣的設定'] });
      else if (li && !li.down && li.downshift) out.push({ name: `Interface ${longName(p.label)} On ${hostName(d)} Is Running At ${li.speed} Mbps`, priority: 'P3', category: 'Connectivity', aiDriven: 'Yes', device: hostName(d), deviceId: uuid(d.id),
        description: `AI 分析：這個介面過去 30 天都是 1000 Mbps，現在只協商到 ${li.speed} Mbps（偏離基準），可能是網路線的線對斷了。`, suggestedActions: ['更換網路線，或用線材測試儀檢查四對線'] });
    }
    for (const [vlan, b] of Object.entries(byVlan)) {
      if (!b.bad) continue;
      out.push({ name: `DHCP Failures For Clients On VLAN ${vlan} At ${hostName(d)}`, priority: 'P2', category: 'Onboarding', aiDriven: 'Yes', device: hostName(d), deviceId: uuid(d.id),
        description: `AI 分析：VLAN ${vlan} 過去 7 天的 DHCP 成功率是 99.6%（基準），現在 ${b.n} 台用戶端中有 ${b.bad} 台拿不到位址。同一時間其他 VLAN 正常，問題集中在這個 VLAN 的閘道或轉送。`,
        suggestedActions: [`確認 VLAN ${vlan} 的閘道 (SVI) 有 ip helper-address 指向 DHCP 伺服器`, '確認 DHCP 伺服器上有這個網段的位址池'] });
    }
  }
  return out.map((x, n) => ({ issueId: uuid(x.name), status: 'active', ...x, n }));
}
const longName = (s) => String(s).replace(/^Gi(?=\d)/, 'GigabitEthernet').replace(/^Te(?=\d)/, 'TenGigabitEthernet');

/** 北向 REST API。回傳 { status, body, note } */
export function dnacApi(state, ctl, req, method, path, query) {
  const R = (status, body, note) => ({ status, body, note: note || '' });
  const C = ctl.dnac;
  const dyn = ((state.dyn ||= {}).dnac ||= {});
  const tokens = (dyn.tokens ||= {});
  if (path === '/dna/system/api/v1/auth/token') {
    if (method !== 'POST') return R(405, { message: 'Method Not Allowed' }, '取得 Token 要用 POST');
    if ((req.user || '') !== C.user || (req.pass || '') !== C.pass) return R(401, { error: 'Authentication has failed. Please provide valid credentials.' }, '帳號或密碼錯誤：Token 是用 HTTP Basic 驗證換來的');
    const tok = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.' + hex(`${state.clock}/${Object.keys(tokens).length}`, 48) + '.' + hex(C.user + state.clock, 24);
    for (const [k, t] of Object.entries(tokens)) if (t < state.clock) delete tokens[k];
    tokens[tok] = state.clock + TOKEN_LIFE;
    return R(200, { Token: tok }, `Token 一小時內有效。之後的請求在標頭加上 X-Auth-Token: ${tok.slice(0, 16)}…`);
  }
  if (!/^\/dna\//.test(path)) return R(404, { message: 'Not Found' }, 'Catalyst Center 的 API 都在 /dna/ 底下（意圖 API 是 /dna/intent/api/v1/…）');
  const tok = (req.headers || {})['x-auth-token'];
  if (!tok) return R(401, { message: 'Unauthorized: missing X-Auth-Token' }, '每個請求都要在標頭帶 X-Auth-Token（先 POST /dna/system/api/v1/auth/token 拿到 Token）');
  if (!tokens[tok]) return R(401, { message: 'Unauthorized: invalid token' }, 'Token 不對（要複製完整的 Token）');
  if (tokens[tok] < state.clock) return R(401, { message: 'Unauthorized: token expired' }, 'Token 過期了（一小時），重新取得一個');
  if (method !== 'GET') return R(405, { message: 'Method Not Allowed' }, '這個模擬的意圖 API 只能讀取 (GET)');
  const wrap = (response) => R(200, { response, version: '1.0' });
  if (path === '/dna/intent/api/v1/network-device') {
    let list = inventory(state, ctl).map((x) => x.json);
    if (query.hostname) list = list.filter((x) => x.hostname === query.hostname);
    if (query.managementIpAddress) list = list.filter((x) => x.managementIpAddress === query.managementIpAddress);
    if (query.reachabilityStatus) list = list.filter((x) => x.reachabilityStatus === query.reachabilityStatus);
    return wrap(list);
  }
  if (path === '/dna/intent/api/v1/network-device/count') return wrap(inventory(state, ctl).length);
  if (path === '/dna/intent/api/v1/issues') {
    let list = issues(state, ctl).map(({ n, ...x }) => x);
    if (query.priority) list = list.filter((x) => x.priority === query.priority);
    if (query.aiDriven) list = list.filter((x) => x.aiDriven === query.aiDriven);
    return wrap(list);
  }
  return R(404, { message: 'Not Found' }, '這個模擬支援：/dna/system/api/v1/auth/token、/dna/intent/api/v1/network-device[/count]、/dna/intent/api/v1/issues（可以加 ?priority=P1、?hostname=…）');
}
void fmtIp;

// ───────────────────────── 範本 (Template Hub) ─────────────────────────
// 範本是一段 IOS 設定，可以有 Velocity 變數：$name 或 ${name}；## 開頭的是範本自己的註解，不會送到設備。
// 編輯的是草稿 (draft)；要提交 (commit) 才會產生新的版本，部署 (provision) 永遠用最新提交的版本。
// 部署時控制器用 SSH 登入每一台設備（南向），進設定模式一行一行送；遇到設備不接受的指令就停下來，這台算 FAILURE。

const VAR_RE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
const tplLines = (text) => String(text).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !/^\s*##/.test(l));

/** 範本裡用到的變數（依出現順序） */
export function tplVars(text) {
  const out = [];
  for (const l of tplLines(text)) for (const m of l.matchAll(VAR_RE)) { const k = m[1] || m[2]; if (!out.includes(k)) out.push(k); }
  return out;
}

/** 代入變數：{ lines, miss: [沒有值的變數] } */
export function tplRender(text, params = {}) {
  const miss = [];
  const lines = tplLines(text).map((l) => l.replace(VAR_RE, (m, a, b) => {
    const k = a || b, v = params[k];
    if (v == null || String(v).trim() === '') { if (!miss.includes(k)) miss.push(k); return m; }
    return String(v).trim();
  }));
  return { lines, miss };
}

export const tplLatest = (t) => t.versions[t.versions.length - 1] || null;

/** 提交草稿：回傳 { ok, ver } 或 { error } */
export function tplCommit(state, ctl, tplId, msg) {
  const t = (ctl.dnac.templates || []).find((x) => x.id === tplId);
  if (!t) return { error: '找不到這個範本' };
  const last = tplLatest(t);
  if (last && last.text === t.draft) return { error: '草稿和最新的版本一樣，沒有東西可以提交' };
  const ver = { v: (last ? last.v : 0) + 1, text: t.draft, msg: String(msg || '').trim() || `Version ${(last ? last.v : 0) + 1}`, t: state.clock, by: ctl.dnac.user };
  t.versions.push(ver);
  return { ok: true, ver };
}

/**
 * 部署範本：targets = [{ dev, params }]。回傳 { error } 或 { id, ver, results: [{ dev, ip, host, status, detail, lines, sent }] }
 * 改了設備之後呼叫的一方要 recompute。
 */
export function tplDeploy(state, ctl, tplId, targets) {
  const C = ctl.dnac, t = (C.templates || []).find((x) => x.id === tplId);
  if (!t) return { error: '找不到這個範本' };
  const ver = tplLatest(t);
  if (!ver) return { error: `範本「${t.name}」還沒有提交過 (Template is not committed)：要先提交，才能部署` };
  if (!targets.length) return { error: '沒有選擇要部署的設備' };
  // 先檢查每一台的變數：有缺的話整批都不部署（Catalyst Center 在部署前就會擋下來）
  const miss = targets.map((x) => ({ x, r: tplRender(ver.text, x.params) })).filter((y) => y.r.miss.length);
  if (miss.length) {
    const m = (C.managed || []).find((z) => z.id === miss[0].x.dev);
    return { error: `${m ? m.ip : miss[0].x.dev} 的變數沒有填：${miss[0].r.miss.join('、')}（Template variable not bound — 每個變數都要有值才能部署）` };
  }
  const src = (ctl.ifaces[0].rt || {}).ip;
  const results = [];
  for (const x of targets) {
    const m = (C.managed || []).find((z) => z.id === x.dev), d = state.devices[x.dev];
    const res = { dev: x.dev, ip: m ? m.ip : '', host: d ? hostName(d) : x.dev, status: 'FAILURE', detail: '', lines: tplRender(ver.text, x.params).lines, sent: 0 };
    results.push(res);
    if (!m || !d) { res.detail = '這台設備不在 Catalyst Center 的設備清單裡'; continue; }
    const ssh = transact(state, ctl.id, { proto: 'tcp', dst: parseIp(m.ip), dport: 22, quiet: true });
    if (!ssh.ok) { res.detail = `控制器用 SSH 連不到 ${m.ip}：${ssh.reason}`; continue; }
    // 以控制器的帳號從 vty 登入：設定改了之後，設備自己會記 %SYS-5-CONFIG_I ... by netops on vty0 (控制器的 IP)
    const S = iosSession(() => state.devices[x.dev], () => state, { user: C.user, line: 'vty0', ip: src != null ? fmtIp(src) : ctl.name });
    S.exec('configure terminal');
    let bad = null;
    for (const [n, l] of res.lines.entries()) {
      const cmd = l.trim();
      if (cmd === '!' || /^!/.test(cmd)) { res.sent++; continue; }
      const r = S.exec(cmd);
      const out = (r && r.out) || [];
      const e = out.find((o) => /^% (Invalid|Incomplete|Ambiguous)|不認識的指令|^%\s*Error/.test(o));
      if (e) { bad = { n: n + 1, cmd, e }; break; }
      res.sent++;
    }
    S.exec('end');
    res.host = hostName(d); // 範本可能改了主機名稱
    // 設備回的錯誤訊息（模擬的 CLI 會附上「輸入 ? 查看…」的提示，控制器的結果裡不需要）
    if (bad) { res.detail = `第 ${bad.n} 行「${bad.cmd}」：${bad.e.replace(/[，,]\s*輸入 \?.*$/, '')}（前面 ${bad.n - 1} 行已經套用）`; continue; }
    res.status = 'SUCCESS';
    res.detail = `${res.sent} 行設定已套用`;
  }
  const dep = { id: uuid(`deploy/${state.clock}/${(C.deployments || []).length}`), tpl: t.id, name: t.name, ver: ver.v, t: state.clock, results };
  (C.deployments ||= []).push(dep);
  if (C.deployments.length > 20) C.deployments.splice(0, C.deployments.length - 20);
  return dep;
}

/** 新的範本（關卡用） */
export function newTemplate(name, project, versions, draft) {
  return { id: uuid('tpl/' + name), name, project, versions: versions.map((text, i) => ({ v: i + 1, text, msg: i ? `Version ${i + 1}` : 'Initial version', t: 0, by: 'netops' })), draft: draft ?? versions[versions.length - 1] };
}
