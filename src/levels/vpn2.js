// 第七章補充：三個據點的 Hub-and-Spoke VPN 與 IKEv2
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { dev } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const threeLines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }, { id: 'line3', label: '線路 3', media: 'rj45' }];
const PSK = 'Hub&Spoke#2026';
const HQ_IP = '203.0.113.18', TC_IP = '198.51.100.34', KH_IP = '192.0.2.66';

export const LEVELS9 = [
  {
    id: 'l54', chapter: 7, title: '三個據點，一個中心', subtitle: 'Hub-and-Spoke VPN、IKEv2', tags: ['Hub-and-Spoke', 'IKEv2', 'IPsec', 'NAT 例外'],
    brief: '公司在高雄開了第二家分公司。資安稽核把 IKEv1 列為弱點，要求所有站對站通道改用 IKEv2；同時兩家分公司之間要能互傳檔案，但不另外拉通道，一律經過總公司（Hub-and-Spoke）。總公司往高雄的通道已經照新規定設好了，高雄的 Cisco 路由器是外包廠商用舊範本設定的。',
    given: [
      ['總公司 HQ-FW', `${HQ_IP} · 10.1.0.0/24（ERP 10.1.0.10）`],
      ['台中 TC-FW（FortiGate）', `${TC_IP} · 10.2.0.0/24`],
      ['高雄 KH-RT（Cisco ISR）', `${KH_IP} · 10.3.0.0/24`],
      ['所有通道', `IKEv2 · PSK ${PSK} · AES256 / SHA256 / DH 14 · PFS DH 14（總公司往高雄已設定）`],
    ],
    learn: [
      { t: 'Hub-and-Spoke', d: '分公司只和總公司建通道。台中往高雄的封包先進總公司、解密、比對防火牆政策，再加密送往高雄。N 個分公司只要 N 條通道，全網狀 (full mesh) 要 N(N-1)/2 條。代價是分公司之間的流量都要繞一趟總公司。' },
      { t: '加密範圍要包含另一個分公司', d: '每條通道的本地 / 遠端網段（IOS 的 crypto ACL、FortiGate 的 phase2 selector）決定哪些流量進通道。台中的「遠端」要加上高雄的網段，總公司往台中的「本地」也要加上高雄，兩端仍然要互為鏡像。總公司還要有一條「VPN → VPN」的政策。' },
      { t: 'IKEv2', d: 'IKEv1 要 Main Mode 六個訊息加 Quick Mode 三個；IKEv2 只要 IKE_SA_INIT 與 IKE_AUTH 四個訊息，就建好 IKE SA 和第一個 CHILD_SA。兩端的版本必須一樣：一端改成 IKEv2，另一端還在 IKEv1 就談不起來。' },
      { t: 'IKEv2 與 PFS 的陷阱', d: '第一個 CHILD_SA 是在 IKE_AUTH 裡順便建立的，不做 PFS 的 DH 交換。所以兩端 PFS 設定不同時，通道一開始照樣通，要到第一次重新協商 (CREATE_CHILD_SA) 才失敗 — IOS 預設一小時後。' },
      { t: '先 NAT 再加密', d: 'Cisco 路由器先做 NAT 才比對要不要加密。高雄往台中的流量如果沒有列在 NAT 例外裡，來源被換成公用 IP，就不符合通道的加密範圍了。' },
    ],
    setup: () => {
      const fw = (id, name, pos, wan, mask, gw, lan, init) => D('fg60f', id, {
        name, pos,
        init(d) {
          const g = (x) => d.ifaces.find((i) => i.id === x);
          Object.assign(g('wan1'), { ip: wan, mask, gateway: gw, ping: false });
          Object.assign(g('internal'), { ip: lan, mask: '255.255.255.0' });
          d.policies.push(allow('內網上網', 'internal', 'wan1', { nat: true }));
          init(d);
        },
      });
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: threeLines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: HQ_IP });
      setLine(inet, 'line2', { type: 'static', gw: '198.51.100.33', mask: '255.255.255.252', assign: TC_IP });
      setLine(inet, 'line3', { type: 'static', gw: '192.0.2.65', mask: '255.255.255.252', assign: KH_IP });
      return makeState([
        inet,
        fw('hq', 'HQ-FW', [0, -4.5], HQ_IP, '255.255.255.248', '203.0.113.17', '10.1.0.1', (d) => {
          // 往台中：舊的 IKEv1 通道（運作中）；往高雄：照新規定設好的 IKEv2，第二階段開了 PFS
          d.vpns.push({ name: 'Taichung', peer: TC_IP, psk: PSK, local: '10.1.0.0/24', remote: '10.2.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14' });
          d.vpns.push({ name: 'Kaohsiung', peer: KH_IP, psk: PSK, local: '10.1.0.0/24', remote: '10.3.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14', ike: 2, pfs: '14' });
          d.policies.push(allow('往台中', 'internal', 'vpn:Taichung'), allow('台中進來', 'vpn:Taichung', 'internal'),
            allow('往高雄', 'internal', 'vpn:Kaohsiung'), allow('高雄進來', 'vpn:Kaohsiung', 'internal'));
        }),
        fw('tc', 'TC-FW', [-9.5, -1.5], TC_IP, '255.255.255.252', '198.51.100.33', '10.2.0.1', (d) => {
          d.vpns.push({ name: 'HQ', peer: HQ_IP, psk: PSK, local: '10.2.0.0/24', remote: '10.1.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14' });
          d.policies.push(allow('往總公司', 'internal', 'vpn:HQ'), allow('總公司進來', 'vpn:HQ', 'internal'));
        }),
        D('isr4321', 'kh', {
          name: 'KH-RT', pos: [9.5, -1.5],
          init(d) {
            // 外包廠商的舊範本：crypto map + ISAKMP（IKEv1），沒有 PFS；NAT 例外只寫了總公司
            Object.assign(d.ifaces[0], { ip: KH_IP, mask: '255.255.255.252', gateway: '192.0.2.65', nat: true, natSkip: '10.1.0.0/24', cmap: 'VPN' });
            Object.assign(d.ifaces[1], { ip: '10.3.0.1', mask: '255.255.255.0' });
            d.isakmp = [{ n: 10, enc: 'aes256', hash: 'sha256', dh: '14' }];
            d.ikeKeys = { [HQ_IP]: PSK };
            d.tsets = { 'TS-AES256': { enc2: 'aes256', hash2: 'sha256' } };
            d.vpns.push({ name: 'HQ', cmap: 'VPN', seq: 10, peer: HQ_IP, psk: PSK, local: '10.3.0.0/24', remote: '10.1.0.0/24', enc: 'aes256', hash: 'sha256', dh: '14', tset: 'TS-AES256', enc2: 'aes256', hash2: 'sha256' });
          },
        }),
        D('sw5', 'hq-sw', { name: 'HQ-Switch', pos: [0, 0.5] }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-2.8, 4.8], ip: '10.1.0.10', gw: '10.1.0.1', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }] }),
        D('pc', 'hq-pc', { name: '總公司 PC', pos: [2.8, 4.8], ip: '10.1.0.50', gw: '10.1.0.1', dns: '8.8.8.8' }),
        D('pc', 'tc-pc', { name: '台中 PC', pos: [-9.5, 3.5], ip: '10.2.0.50', gw: '10.2.0.1', dns: '8.8.8.8' }),
        D('pc', 'kh-pc', { name: '高雄 PC', pos: [9.5, 3.5], ip: '10.3.0.50', gw: '10.3.0.1', dns: '8.8.8.8' }),
      ], [
        ['inet:line1', 'hq:wan1'], ['inet:line2', 'tc:wan1'], ['inet:line3', 'kh:Gi0/0/0'],
        ['hq:1', 'hq-sw:1'], ['erp:eth0', 'hq-sw:2'], ['hq-pc:eth0', 'hq-sw:3'],
        ['tc:1', 'tc-pc:eth0'], ['kh:Gi0/0/1', 'kh-pc:eth0'],
      ]);
    },
    objectives: [
      {
        type: 'check', label: '總公司往台中、往高雄的兩條通道都已建立，而且兩端都是 IKEv2',
        test(s) {
          for (const [id, name] of [['hq', 'Taichung'], ['hq', 'Kaohsiung'], ['tc', 'HQ'], ['kh', 'HQ']]) {
            const d = dev(s, id), t = d.vpns.find((x) => x.name === name);
            if (!t) return `${d.name} 上找不到通道「${name}」`;
            const r = t.rt || {};
            if (!r.up) return `${d.name} 的通道「${name}」沒有建立：${r.why || '設定中'}`;
            if (r.ver !== 2) return `${d.name} 的通道「${name}」還在用 IKEv1`;
          }
          return true;
        },
      },
      { type: 'tcp', from: 'tc-pc', ip: '10.1.0.10', port: 443, label: '台中 PC 可以使用總公司的 ERP' },
      { type: 'tcp', from: 'kh-pc', ip: '10.1.0.10', port: 443, label: '高雄 PC 可以使用總公司的 ERP' },
      { type: 'ping', from: 'tc-pc', to: 'kh-pc', label: '台中 PC ping 得到高雄 PC（經過總公司）' },
      { type: 'ping', from: 'kh-pc', to: 'tc-pc', label: '高雄 PC ping 得到台中 PC（經過總公司）' },
      { type: 'after', secs: 3700, label: '一個多小時後（通道第一次重新協商之後），高雄照樣連得到 ERP', test: { type: 'tcp', from: 'kh-pc', ip: '10.1.0.10', port: 443 } },
      {
        type: 'check', label: '分公司之間沒有直接的通道：全部經過總公司（Hub-and-Spoke）',
        test(s) {
          for (const id of ['tc', 'kh']) {
            const d = dev(s, id), other = d.vpns.find((t) => t.peer && t.peer !== HQ_IP);
            if (other) return `${d.name} 另外建了往 ${other.peer} 的通道：這次的規定是分公司只連總公司`;
          }
          return true;
        },
      },
      { type: 'tcp', from: 'kh-pc', name: 'www.example.com', port: 443, label: '高雄 PC 上網不受影響' },
    ],
    hints: [
      '先把四個通道端點都改成 IKEv2：HQ-FW 的 Taichung、TC-FW 的 HQ（「VPN」分頁的「IKE 版本」），高雄 KH-RT 也一樣（或用 CLI 建 crypto ikev2 proposal / policy / keyring / profile，再在 crypto map 裡 set ikev2-profile）。只改一端的話，會看到「IKE 版本不一致」。',
      '分公司互通：TC-FW 的遠端網段加上 10.3.0.0/24、HQ-FW 往台中的本地網段加上 10.3.0.0/24；KH-RT 的遠端加上 10.2.0.0/24、HQ-FW 往高雄的本地加上 10.2.0.0/24。HQ-FW 還要兩條政策：VPN Taichung ↔ VPN Kaohsiung。KH-RT 的 Gi0/0/0「NAT 例外」也要加上 10.2.0.0/24（路由器先 NAT 再加密）。',
      '高雄的通道建起來了，但一小時後會斷？總公司往高雄開了 PFS（DH 14），KH-RT 沒有：IKEv2 的第一個 CHILD_SA 不做 PFS，所以一開始通，第一次重新協商才失敗。KH-RT 的「PFS」選 DH 14（CLI：crypto map VPN 10 → set pfs group14）。',
    ],
    solve(s) {
      const hq = dev(s, 'hq'), tc = dev(s, 'tc'), kh = dev(s, 'kh');
      const t = (d, n) => d.vpns.find((x) => x.name === n);
      Object.assign(t(hq, 'Taichung'), { ike: 2, local: '10.1.0.0/24, 10.3.0.0/24' });
      Object.assign(t(hq, 'Kaohsiung'), { local: '10.1.0.0/24, 10.2.0.0/24' });
      hq.policies.push(allow('台中 → 高雄', 'vpn:Taichung', 'vpn:Kaohsiung'), allow('高雄 → 台中', 'vpn:Kaohsiung', 'vpn:Taichung'));
      Object.assign(t(tc, 'HQ'), { ike: 2, remote: '10.1.0.0/24, 10.3.0.0/24' });
      Object.assign(t(kh, 'HQ'), { ike: 2, remote: '10.1.0.0/24, 10.2.0.0/24', pfs: '14' });
      kh.ifaces[0].natSkip = '10.1.0.0/24, 10.2.0.0/24';
    },
    recap: ['Hub-and-Spoke：分公司只連總公司，分公司之間的流量在總公司解密、過政策、再加密。加密範圍、政策、NAT 例外三個地方都要記得另一個分公司。', 'IKEv2 只要四個訊息；兩端版本要一致。PFS 不一致時第一個 CHILD_SA 照樣建立，要到重新協商才斷 — 這種「過一小時才壞」的問題最難查。'],
  },
];
