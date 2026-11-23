// 第十一章補充：Linux 伺服器用 nmcli 改固定 IP — con mod 只改設定檔、con up 才生效；位址沒寫 /長度 是 /32
import { makeDevice as D, makeState } from '../engine/model.js';
import { parseIp, parseMask } from '../engine/ip.js';
import { dev, WEB } from './util.js';

const IP = '10.0.20.15';

export const LEVELS82 = [
  {
    id: 'l162', chapter: 11, title: '伺服器的 IP 每天都不一樣', subtitle: 'Linux 的 nmcli：固定 IP', tags: ['Linux', 'nmcli', 'NetworkManager', '固定 IP'],
    brief: `新的網站伺服器 web-01（Rocky Linux）裝好之後一直用 DHCP，每次重開機位址都可能換。DNS 裡登記的是 ${IP}，所以使用者常常連不到。請用 nmcli 把 web-01 改成固定 IP：${IP}/24，閘道 10.0.20.1。`,
    given: [['web-01', `目前 DHCP · 要改成 ${IP}/24 · 閘道 10.0.20.1 · DNS 10.0.20.53`], ['使用者', '10.0.10.0/24 · PC 10.0.10.50'], ['登入', 'web-01 的終端機（admin，可以 sudo）']],
    learn: [
      { t: 'NetworkManager 與 nmcli', d: 'RHEL / Rocky / Ubuntu Server 大多用 NetworkManager 管網路。nmcli device status 看網卡，nmcli connection show eth0 看設定檔。ip addr 加的位址重開機就不見了，要長久的設定用 nmcli。' },
      { t: 'modify 之後要 up', d: 'sudo nmcli connection modify eth0 ipv4.method manual ipv4.addresses 10.0.20.15/24 ipv4.gateway 10.0.20.1 ipv4.dns 10.0.20.53 只改了設定檔；sudo nmcli connection up eth0（或重開機）才會套用到網卡。' },
      { t: '/長度一定要寫', d: 'ipv4.addresses 只寫 10.0.20.15 不寫 /24，NetworkManager 會當成 /32：網段裡只有自己，閘道 10.0.20.1 不在同一個網段，出不去也回不來。' },
    ],
    setup() {
      return makeState([
        D('isr4321', 'rt', {
          name: 'R1', pos: [-4, -5],
          init(d) {
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/0'), { ip: '10.0.10.1', mask: '255.255.255.0' });
            Object.assign(d.ifaces.find((i) => i.id === 'Gi0/0/1'), { ip: '10.0.20.1', mask: '255.255.255.0', dhcp: { on: true, start: '10.0.20.100', end: '10.0.20.199', dns: '10.0.20.53', gw: '' } });
          },
        }),
        D('sw8', 'sw1', { name: 'SW-Users', pos: [-8, 0] }),
        D('sw8', 'sw2', { name: 'SW-Servers', pos: [1, 0] }),
        D('pc', 'pc', { name: '使用者 PC', pos: [-9, 4.5], ip: '10.0.10.50', gw: '10.0.10.1' }),
        D('tower', 'web', { name: 'web-01', pos: [3, 4.5], dhcp: true, services: WEB, init(d) { d.os = 'linux'; } }),
      ], [['rt:Gi0/0/0', 'sw1:1'], ['pc:eth0', 'sw1:2'], ['rt:Gi0/0/1', 'sw2:1'], ['web:eth0', 'sw2:2']]);
    },
    objectives: [
      { type: 'tcp', from: 'pc', ip: IP, port: 443, label: `使用者連得到 https://${IP}` },
      {
        type: 'check', label: `web-01 用固定 IP：${IP}/24、閘道 10.0.20.1（不靠 DHCP）`,
        test(s) {
          const i = dev(s, 'web').ifaces[0];
          if (i.mode !== 'static') return 'web-01 還是 DHCP：nmcli connection modify 之後要 nmcli connection up 才會生效';
          if (i.ip !== IP) return `web-01 的位址是 ${i.ip}，應該是 ${IP}`;
          if (parseMask(i.mask || '') !== 24) return `web-01 的遮罩是 /${parseMask(i.mask || '')}：ipv4.addresses 要寫 ${IP}/24`;
          return parseIp(i.gateway || '') === parseIp('10.0.20.1') || 'web-01 的閘道不是 10.0.20.1';
        },
      },
    ],
    hints: [
      'web-01 的終端機：nmcli connection show eth0 看 ipv4.method（auto 就是 DHCP）。',
      `sudo nmcli connection modify eth0 ipv4.method manual ipv4.addresses ${IP}/24 ipv4.gateway 10.0.20.1 ipv4.dns 10.0.20.53（/24 一定要寫，不然是 /32）。`,
      'sudo nmcli connection up eth0：設定檔才會套用到網卡。ip addr 確認位址。',
    ],
    solve(s) { Object.assign(dev(s, 'web').ifaces[0], { mode: 'static', ip: IP, mask: '255.255.255.0', gateway: '10.0.20.1', dns: '10.0.20.53' }); },
    recap: ['nmcli connection modify 只改設定檔，nmcli connection up 才套用；長久的設定用 nmcli，不用 ip addr。', 'ipv4.addresses 一定要寫 /長度，不然是 /32，閘道會不在同一個網段。'],
  },
];
