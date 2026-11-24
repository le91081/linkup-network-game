// 第七章補充：SSL-VPN 改成全通道之後，連著 VPN 就不能上網（少了 VPN → wan1 的政策與 NAT）
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { dev, WEB } from './util.js';

const allow = (name, srcIf, dstIf, o = {}) => ({ name, srcIf, dstIf, src: 'any', dst: 'any', service: 'ALL', action: 'accept', nat: false, ...o });
const twoLines = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];

export const LEVELS92 = [
  {
    id: 'l172', chapter: 7, title: '連上 VPN 就不能上網', subtitle: 'SSL-VPN 的全通道：VPN → wan1 的政策與 NAT', tags: ['SSL-VPN', '全通道', 'Split Tunnel', 'NAT', 'FortiGate'],
    brief: '資安稽核要求：在家工作的人連上 VPN 之後，所有上網流量都要經過公司 FortiGate 的網頁過濾。網管昨天把 SSL-VPN 的入口改成全通道（split-tunneling disable），結果今天 Amy 一連上 VPN，ERP 還開得了，但所有網站都打不開；斷開 VPN 又正常。請讓 Amy 連著 VPN 也能上網，而且上網的流量要經過公司的防火牆（不可以改回分割通道）。',
    given: [
      ['HQ-FW', 'wan1 203.0.113.18 · internal 10.1.0.1 · SSL-VPN 位址池 10.99.0.10 – 10.99.0.50 · 入口 full-access（全通道）'],
      ['ERP', '10.1.0.10（政策：遠端使用者 VPN → internal，只放行 HTTPS）'],
      ['Amy', '在家，家用路由器後面（192.168.50.x），已經連上 VPN'],
    ],
    learn: [
      { t: '分割通道與全通道', d: '分割通道（split tunnel）：只有公司的網段走 VPN，上網直接從家裡出去。全通道（full tunnel）：用戶端的預設路由指向 VPN，連上網都先到公司的防火牆，才能套用網頁過濾、記錄與 DLP；代價是公司的對外頻寬要多扛這些流量。用戶端自己的區域網路（家裡的印表機）還是直接走。' },
      { t: '全通道要多一條政策', d: 'VPN 用戶的上網流量從 ssl.root（遠端使用者 VPN）進來、要從 wan1 出去：沒有這條政策就被隱含拒絕。這條政策還要開 NAT：VPN 位址池是私有位址，不換成 wan1 的位址，ISP 直接丟掉。' },
      { t: 'FortiOS 的寫法', d: 'config vpn ssl web portal → edit full-access → set split-tunneling disable；config firewall policy → set srcintf ssl.root → set dstintf wan1 → set srcaddr SSLVPN_TUNNEL_ADDR1 → set nat enable，再掛上網頁過濾的設定檔。' },
    ],
    setup() {
      const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: twoLines });
      setLine(inet, 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' });
      setLine(inet, 'line2', { type: 'dhcp', gw: '198.51.100.1', assign: '198.51.100.120' });
      return makeState([
        inet,
        D('fg60f', 'hq', {
          name: 'HQ-FW', pos: [-6, -4.5],
          init(d) {
            const g = (x) => d.ifaces.find((i) => i.id === x);
            Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
            Object.assign(g('internal'), { ip: '10.1.0.1', mask: '255.255.255.0' });
            d.policies.push(allow('內網上網', 'internal', 'wan1', { nat: true }));
            d.policies.push(allow('VPN 用戶到 ERP', 'vpn:remote', 'internal', { dst: '10.1.0.10', service: 'HTTPS' }));
            Object.assign(d.vpnServer, { on: true, start: '10.99.0.10', end: '10.99.0.50', full: true, users: [{ user: 'amy', pass: 'Vpn#Amy2026' }] });
          },
        }),
        D('sw5', 'hq-sw', { name: 'HQ-Switch', pos: [-6, 0.3] }),
        D('tower', 'erp', { name: 'ERP 伺服器', pos: [-9, 4.8], ip: '10.1.0.10', gw: '10.1.0.1', services: WEB }),
        D('homerouter', 'home', { name: '家用路由器', pos: [7, -4], init(d) { Object.assign(d.ifaces[1].dhcp, { on: true, start: '192.168.50.100', end: '192.168.50.200' }); } }),
        D('laptop', 'nb', { name: 'Amy 的筆電', pos: [7, 1.5], dhcp: true, init(d) { d.vpnClient = { on: true, server: '203.0.113.18', user: 'amy', pass: 'Vpn#Amy2026' }; } }),
      ], [['inet:line1', 'hq:wan1'], ['inet:line2', 'home:wan'], ['hq:1', 'hq-sw:1'], ['erp:eth0', 'hq-sw:2'], ['nb:eth0', 'home:lan1']]);
    },
    objectives: [
      { type: 'tcp', from: 'nb', to: 'erp', port: 443, label: 'Amy 經由 VPN 用得了 ERP' },
      { type: 'tcp', from: 'nb', name: 'www.example.com', port: 443, via: 'hq', label: 'Amy 連著 VPN 打得開 https://www.example.com，而且經過公司的防火牆' },
      {
        type: 'check', label: 'SSL-VPN 還是全通道（稽核要求）',
        test(s) { return !!dev(s, 'hq').vpnServer.full || 'SSL-VPN 被改回分割通道了：稽核要求上網也要經過公司的防火牆'; },
      },
    ],
    hints: [
      '先看 Amy 打不開網站的封包追蹤：封包進了 VPN 通道，到了 HQ-FW 要從 wan1 出去，卻沒有符合的政策（隱含拒絕）。',
      'HQ-FW →「政策」新增：來源介面「遠端使用者 VPN」→ 目的介面 wan1，服務 ALL，允許。',
      '還是不通？VPN 用戶的位址是 10.99.0.x（私有位址）：這條政策要開 NAT，換成 wan1 的位址出去。',
    ],
    solve(s) { dev(s, 'hq').policies.push(allow('VPN 用戶上網', 'vpn:remote', 'wan1', { nat: true })); },
    recap: ['全通道讓上網流量也經過公司的防火牆，但要多一條 VPN → wan1 的政策，而且要 NAT。', '分割通道省頻寬，全通道好控管：依公司的規定選，不是越安全越好用。'],
  },
];
