// 第三章補充：公司自己的 DNS 伺服器。內部的名稱它自己答，外面的名稱要「轉送」給上游去查，
// 而且防火牆要讓它（也只讓它）問得到外面的 DNS。
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { dev, WEB } from './util.js';

const ZONE = [{ name: 'intranet.corp.local', type: 'A', value: '192.168.1.80', ttl: 3600 }, { name: 'dns.corp.local', type: 'A', value: '192.168.1.53', ttl: 3600 }];

export const LEVELS94 = [
  {
    id: 'l178', chapter: 3, title: '內部網站打得開，外面的全部打不開', subtitle: '公司自己的 DNS 伺服器：轉送器 (forwarder) 與查詢的接力', tags: ['DNS', 'forwarder', '遞迴查詢', '防火牆政策', '最小權限'],
    brief: '公司新架了一台 DNS 伺服器，內部網站終於可以用名稱連（intranet.corp.local）。可是把大家的 DNS 改成它之後，外面的網站全部打不開；直接打 IP 卻是通的。資安的要求是：使用者的電腦不能自己去問外面的 DNS，一律經過公司的 DNS 伺服器。',
    given: [
      ['公司的 DNS 伺服器', '192.168.1.53（負責 corp.local）'], ['內部網站', 'intranet.corp.local = 192.168.1.80'], ['使用者', '192.168.1.0/24，DHCP 發的 DNS 是 192.168.1.53'],
      ['電信業者的 DNS', '8.8.8.8'], ['防火牆', 'internal → wan1 只放行 HTTP 與 HTTPS'],
    ],
    learn: [
      { t: '查詢是一棒接一棒', d: '電腦只問自己設定的那一台 DNS 伺服器（遞迴查詢）。那一台自己有答案（它負責的網域、或快取裡有）就直接回；沒有的話要替你去問別人，問到了再回給你。' },
      { t: '轉送器 (forwarder)', d: '公司的 DNS 伺服器只知道 corp.local。其他的名稱它要轉送給上游（電信業者或公用的 DNS）。沒有開轉送，它對外面的名稱只能回「查不到」。' },
      { t: '伺服器自己也要有上游', d: '開了轉送之後，伺服器是用「它自己的 DNS 設定」往上問。伺服器的網路設定裡 DNS 是空的（或指向自己），一樣問不出去。' },
      { t: '防火牆要放行那一棒', d: '使用者只碰得到內部的 DNS 伺服器；真正往外送 UDP 53 的是那台伺服器。防火牆政策的來源只要寫它的位址，其他電腦直接對外的 DNS 查詢照樣擋掉：惡意程式常用 DNS 把資料偷帶出去。' },
    ],
    setup: () => makeState([
      setLine(D('internet', 'inet', { name: '網際網路', pos: [0, -9] }), 'line1', { type: 'static', gw: '203.0.113.17', mask: '255.255.255.248', assign: '203.0.113.18' }),
      D('fg60f', 'fw', {
        name: 'Firewall', pos: [0, -4.4],
        init(d) {
          const g = (id) => d.ifaces.find((i) => i.id === id);
          Object.assign(g('wan1'), { ip: '203.0.113.18', mask: '255.255.255.248', gateway: '203.0.113.17', ping: false });
          Object.assign(g('wan2'), { ping: false });
          Object.assign(g('internal'), { ip: '192.168.1.1', mask: '255.255.255.0' });
          Object.assign(g('internal').dhcp, { on: true, start: '192.168.1.100', end: '192.168.1.199', dns: '192.168.1.53' });
          d.policies.push(
            { name: '上網 HTTPS', srcIf: 'internal', dstIf: 'wan1', src: 'any', dst: 'any', service: 'HTTPS', action: 'accept', nat: true },
            { name: '上網 HTTP', srcIf: 'internal', dstIf: 'wan1', src: 'any', dst: 'any', service: 'HTTP', action: 'accept', nat: true },
          );
        },
      }),
      D('sw8', 'sw', { name: 'LAN Switch', pos: [0, 0] }),
      D('pc', 'pc-1', { name: 'PC-1', pos: [-9, 4.2], dhcp: true }),
      D('pc', 'pc-2', { name: 'PC-2', pos: [-3.4, 5.2], dhcp: true }),
      D('tower', 'dns', {
        name: 'DNS 伺服器', pos: [3.4, 5.2], ip: '192.168.1.53', gw: '192.168.1.1', services: [{ proto: 'udp', port: 53, name: 'DNS' }],
        init(d) { d.dnsZone = { records: ZONE.map((r) => ({ ...r })) }; },
      }),
      D('tower', 'web', { name: '內部網站', pos: [9, 4.2], ip: '192.168.1.80', gw: '192.168.1.1', dns: '192.168.1.53', services: WEB }),
    ], [['inet:line1', 'fw:wan1'], ['fw:1', 'sw:1'], ['pc-1:eth0', 'sw:2'], ['pc-2:eth0', 'sw:3'], ['dns:eth0', 'sw:4'], ['web:eth0', 'sw:5']]),
    objectives: [
      { type: 'tcp', from: 'pc-1', name: 'intranet.corp.local', port: 443, label: 'PC-1 用名稱打開內部網站（intranet.corp.local）' },
      { type: 'tcp', from: 'pc-1', name: 'www.example.com', port: 443, label: 'PC-1 打開 https://www.example.com' },
      { type: 'tcp', from: 'pc-2', name: 'www.example.com', port: 443, label: 'PC-2 也可以' },
      { type: 'udp', from: 'pc-1', ip: '8.8.8.8', port: 53, expect: false, label: '使用者的電腦不能自己問外面的 DNS（PC-1 ✕ 8.8.8.8 的 UDP 53）' },
      {
        type: 'check', label: '防火牆沒有對所有人放行 DNS：來源只有 DNS 伺服器',
        test(s) {
          const bad = dev(s, 'fw').policies.find((p) => p.action === 'accept' && (p.dstIf === 'wan1' || p.dstIf === 'any') && (p.service === 'ALL' || p.service === 'DNS') && !/^192\.168\.1\.53(\/32)?$/.test(String(p.src).trim()));
          return bad ? `政策「${bad.name}」讓${bad.src === 'any' ? '所有的電腦' : ' ' + bad.src + ' '}都可以對外送 ${bad.service === 'ALL' ? '任何流量' : 'DNS 查詢'}。來源只要寫 DNS 伺服器的位址（192.168.1.53）` : true;
        },
      },
    ],
    hints: [
      '在 PC-1 的終端機輸入 nslookup www.example.com 與 nslookup intranet.corp.local 比較：回答的都是 192.168.1.53，只是外面的名稱它說查不到。點「DNS 伺服器」→「DNS」分頁，把「轉送查不到的名稱 (forwarder)」打開。',
      '開了轉送還是不行：伺服器是用它自己的 DNS 設定往上問。點「DNS 伺服器」→「網路設定」，DNS 填 8.8.8.8。',
      '最後是防火牆：internal → wan1 只放行了 HTTP 與 HTTPS，DNS 伺服器的查詢出不去。加一條政策：來源 192.168.1.53、服務 DNS、開 NAT。來源不要寫 any，否則每台電腦都可以自己問外面的 DNS。',
    ],
    solve(s) {
      const d = dev(s, 'dns');
      d.dnsForward = true;
      d.ifaces[0].dns = '8.8.8.8';
      dev(s, 'fw').policies.push({ name: 'DNS 伺服器對外查詢', srcIf: 'internal', dstIf: 'wan1', src: '192.168.1.53', dst: 'any', service: 'DNS', action: 'accept', nat: true });
    },
    recap: ['電腦只問一台 DNS；那一台沒有答案就要靠轉送器往上問，它自己也要設好上游、過得了防火牆。', '對外的 DNS 只放行公司的 DNS 伺服器：好管理、有紀錄，也擋掉用 DNS 偷帶資料的管道。'],
  },
];
