// 大型拓撲的效能：Nexus 核心 + N 台 Catalyst 2960，每台接 7 台 PC，全部在同一個 VLAN（核心有 SVI）
// npm run bench            固定 IP
// npm run bench -- dhcp    PC 用 DHCP（核心的 SVI 發位址）：每次重算每台 PC 都要走一遍廣播網域，比較慢
import { makeDevice as D, makeState, newIface } from '../src/engine/model.js';
import { recompute, transact } from '../src/engine/sim.js';
import { parseIp } from '../src/engine/ip.js';

const dhcp = process.argv.includes('dhcp');

function build(nsw) {
  const devs = [], cables = [];
  devs.push(D('n93180', 'core', {
    name: 'Core', pos: [0, 0],
    init(d) { d.ifaces.push(newIface('vlan1', 'Vlan1', { t: 'svi', vlan: 1 }, { ip: '10.0.0.1', mask: '255.255.0.0', ...(dhcp ? { dhcp: { on: true, start: '10.0.1.1', end: '10.0.9.250', dns: '8.8.8.8' } } : {}) })); },
  }));
  let n = 10;
  for (let s = 1; s <= nsw; s++) {
    const id = 'sw' + s;
    devs.push(D('c2960', id, { name: 'SW' + s, pos: [s * 3, 5], init(d) { d.sw.ports['Gi0/11'].mode = 'trunk'; } }));
    cables.push([`core:Eth1/${s}`, `${id}:Gi0/11`]);
    for (let p = 1; p <= 7; p++) {
      const pid = `pc${s}_${p}`, a = n++;
      devs.push(D('pc', pid, { name: pid, pos: [s * 3 + p * 0.3, 9], ...(dhcp ? { dhcp: true } : { ip: `10.0.${Math.floor(a / 250)}.${(a % 250) + 2}`, mask: '255.255.0.0', gw: '10.0.0.1' }) }));
      cables.push([`${pid}:eth0`, `${id}:Gi0/${p}`]);
    }
  }
  return makeState(devs, cables);
}

console.log(dhcp ? 'PC 用 DHCP' : 'PC 用固定 IP');
for (const n of [3, 10, 24, 47]) {
  const s = build(n);
  let t = performance.now();
  recompute(s);
  const first = performance.now() - t;
  t = performance.now();
  for (let k = 0; k < 3; k++) recompute(s);
  const again = (performance.now() - t) / 3;
  t = performance.now();
  const r = transact(s, `pc${n}_7`, { proto: 'icmp', dst: parseIp('10.0.0.1'), quiet: true });
  console.log(`${String(Object.keys(s.devices).length).padStart(4)} 台設備 · 第一次重算 ${first.toFixed(0).padStart(4)} ms · 之後每次 ${again.toFixed(0).padStart(4)} ms · ping ${(performance.now() - t).toFixed(1)} ms${r.ok ? '' : '（失敗：' + r.reason + '）'}`);
}
