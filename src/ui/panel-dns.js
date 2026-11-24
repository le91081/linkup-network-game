// DNS 伺服器的記錄（A / CNAME / MX / PTR 與 TTL）
import { h, button } from './dom.js';
import { inp, sel, toggle, field, note, cardHead, del, isNum, isCidr6 } from './form.js';
import { DNS_TYPES, DNS_TTL, zoneRecords } from '../engine/dns.js';

const HINT = {
  A: '名稱 → IPv4 位址', AAAA: '名稱 → IPv6 位址（有全域 IPv6 的電腦會優先用它）', CNAME: '別名 → 另一個名稱（例如 www → web01）', MX: '這個網域的郵件伺服器（數字小的優先）', PTR: '反查：IP 位址 → 名稱',
};

export function dnsTab(ctx, body) {
  const { dev } = ctx;
  // 舊的「名稱 → IP」對照表轉成一般的記錄
  if (dev.dnsRecords && !dev.dnsZone) {
    dev.dnsZone = { records: zoneRecords(dev).map((r) => ({ ...r })) };
    delete dev.dnsRecords;
  }
  const z = (dev.dnsZone ||= { records: [] });
  body.append(h('div', { class: 'card' }, cardHead(`DNS 記錄（${z.records.length}）`),
    note('muted', '名稱寫完整的網域名稱（例如 www.corp.local）。TTL 是用戶端可以把答案記在快取裡多久：改記錄之前先把 TTL 調短，大家才會很快看到新的位址。'),
    h('div', { class: 'thead c-dns' }, h('span', { text: '名稱' }), h('span', { text: '類型' }), h('span', { text: '值' }), h('span', { text: 'TTL（秒）' }), h('span')),
    z.records.map((r, n) => h('div', { class: 'trow c-dns', title: HINT[r.type] || '' },
      inp(ctx, () => r.name, (v) => { r.name = v.trim().toLowerCase(); }, { ph: 'www.corp.local' }),
      sel(ctx, () => r.type, (v) => { r.type = v; }, DNS_TYPES.map((t) => [t, t])),
      inp(ctx, () => (r.type === 'MX' && r.pref != null ? `${r.pref} ${r.value}` : r.value), (v) => {
        const m = r.type === 'MX' && v.trim().match(/^(\d+)\s+(\S+)$/);
        if (m) { r.pref = +m[1]; r.value = m[2]; } else r.value = v.trim();
      }, { ph: r.type === 'A' ? '10.0.0.10' : r.type === 'AAAA' ? '2001:db8::10' : r.type === 'MX' ? '10 mail.corp.local' : r.type === 'PTR' ? 'web01.corp.local' : 'web01.corp.local' }),
      inp(ctx, () => String(r.ttl ?? DNS_TTL), (v) => { r.ttl = +v || DNS_TTL; }, { ph: String(DNS_TTL), check: isNum(0, 2147483647) }),
      del(() => { z.records.splice(n, 1); ctx.commit(true); }))),
    h('div', { class: 'addrow' }, button('新增記錄', { ic: 'plus', small: true, onclick: () => { z.records.push({ name: '', type: 'A', value: '', ttl: DNS_TTL }); ctx.commit(true); } }))));
  // 遞迴查詢與 DNS64：自己的記錄裡沒有的名稱，轉送給這台設定的 DNS（例如 8.8.8.8）
  const is96 = (v) => isCidr6(v) && v.endsWith('/96');
  body.append(h('div', { class: 'card' }, cardHead('轉送與 DNS64'),
    toggle(ctx, () => dev.dnsForward, (v) => { if (v) dev.dnsForward = true; else delete dev.dnsForward; }, '轉送查不到的名稱 (forwarder)', { title: '記錄裡沒有的名稱，改問這台電腦設定的 DNS 伺服器，再把答案回給用戶端' }),
    field('DNS64 前綴', inp(ctx, () => dev.dns64 || '', (v) => { if (v) dev.dns64 = v; else delete dev.dns64; }, { ph: '64:ff9b::/96（空白＝不使用）', check: is96, rerender: true }),
      '名稱只有 A 記錄時，用「前綴 + IPv4 位址」合成 AAAA 給 IPv6-only 的用戶端；前綴要和路由器上的 NAT64 一樣，長度 /96'),
    dev.dns64 && !is96(dev.dns64) ? note('warn', `${dev.dns64} 不是 /96 的 IPv6 前綴，DNS64 不會合成位址`) : null));
  body.append(note('muted', '用戶端查到之後會照 TTL 記在快取裡（resolvectl show-cache 看得到），到期之前不會再來問。nslookup 例外：它直接問伺服器，所以「nslookup 已經是新的，瀏覽器卻還連到舊的」通常就是快取還沒到期，resolvectl flush-caches 可以立刻清掉。'));
}
