// 容器 (Docker)：一台 Linux 主機上跑好幾個容器，共用主機的作業系統核心
//
// 容器接在主機裡的橋接網路 docker0（172.17.0.0/16），外面看不到這些位址。
// 要讓外面連得到，就要「發佈連接埠」：docker run -p 8080:80 nginx → 主機的 8080 轉給容器的 80。
//   -p 127.0.0.1:3000:3000 只綁在 127.0.0.1：只有主機自己連得到，別台連不進來
//   主機的埠對到容器裡沒有程式在聽的埠：連得上主機，但馬上被重設 (Connection reset by peer)
//   沒有發佈的埠（例如資料庫的 3306）：外面完全連不到，這通常是對的
// d.docker = { containers: [{ id, name, image, state: 'running' | 'exited', ip, created, publish: [{ hostIp, host, ctr, proto }] }] }
import { parseIp, fmtIp } from './ip.js';

export const IMAGES = {
  nginx: { ports: [80], cmd: '"/docker-entrypoint.…"', desc: 'Nginx 網頁伺服器（容器裡聽 80）' },
  httpd: { ports: [80], cmd: '"httpd-foreground"', desc: 'Apache 網頁伺服器（聽 80）' },
  'grafana/grafana': { ports: [3000], cmd: '"/run.sh"', desc: 'Grafana 監控儀表板（聽 3000）' },
  mysql: { ports: [3306], cmd: '"docker-entrypoint.s…"', desc: 'MySQL 資料庫（聽 3306）' },
  postgres: { ports: [5432], cmd: '"docker-entrypoint.s…"', desc: 'PostgreSQL 資料庫（聽 5432）' },
  redis: { ports: [6379], cmd: '"docker-entrypoint.s…"', desc: 'Redis（聽 6379）' },
  'portainer/portainer-ce': { ports: [9443], cmd: '"/portainer"', desc: 'Portainer 管理介面（聽 9443）' },
};
export const imageBase = (img) => String(img || '').replace(/:[\w.-]+$/, '');
export const imagePorts = (img) => ((IMAGES[imageBase(img)] || {}).ports || []);

/** 用名稱或 ID 開頭找容器 */
export function findCtr(d, ref) {
  const list = (d.docker && d.docker.containers) || [];
  return list.find((c) => c.name === ref) || (ref && ref.length >= 3 ? list.find((c) => c.id.startsWith(ref)) : null) || null;
}

/** 新的容器：回傳 { ctr } 或 { err }（和 docker 一樣的錯誤訊息） */
export function addContainer(state, d, { name, image, publish = [] }) {
  const dk = (d.docker ||= { containers: [] });
  if (!IMAGES[imageBase(image)]) return { err: `Unable to find image '${image}${image.includes(':') ? '' : ':latest'}' locally\ndocker: Error response from daemon: pull access denied for ${imageBase(image)}, repository does not exist or may require 'docker login'.` };
  const n = name || `${['eager', 'brave', 'quiet', 'lucid'][dk.containers.length % 4]}_${['turing', 'hopper', 'lovelace', 'knuth'][dk.containers.length % 4]}`;
  if (dk.containers.some((c) => c.name === n)) return { err: `docker: Error response from daemon: Conflict. The container name "/${n}" is already in use by container "${findCtr(d, n).id}". You have to remove (or rename) that container to be able to reuse that name.` };
  for (const p of publish) {
    const used = dk.containers.find((c) => c.state === 'running' && c.publish.some((q) => q.host === p.host && q.proto === p.proto));
    if (used) return { err: `docker: Error response from daemon: driver failed programming external connectivity on endpoint ${n}: Bind for ${p.hostIp}:${p.host} failed: port is already allocated.` };
  }
  const k = dk.seq = (dk.seq || 1) + 1;
  const id = (k * 2654435761 >>> 0).toString(16).padStart(8, '0') + 'a3c9';
  const ctr = { id, name: n, image, state: 'running', ip: `172.17.0.${k}`, created: state.clock, publish: publish.map((p) => ({ hostIp: p.hostIp || '0.0.0.0', host: +p.host, ctr: +p.ctr, proto: p.proto || 'tcp' })) };
  dk.containers.push(ctr);
  return { ctr };
}

/** 解析 -p 的寫法：8080:80、127.0.0.1:3000:3000、5353:53/udp */
export function parsePublish(spec) {
  const m = String(spec).match(/^(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):(\d+)(?:\/(tcp|udp))?$/);
  if (!m || (m[1] && parseIp(m[1]) == null)) return null;
  return { hostIp: m[1] || '0.0.0.0', host: +m[2], ctr: +m[3], proto: m[4] || 'tcp' };
}

/**
 * 封包到了 Docker 主機：這個埠有沒有發佈給某個容器。沒有發佈就回傳 null（交給主機自己的服務判斷）。
 * local：封包是主機自己送給自己的（curl localhost:…）
 */
export function dockerDeliver(d, pkt, local = false) {
  const list = (d.docker && d.docker.containers) || [];
  for (const c of list) {
    const p = c.publish.find((x) => x.host === pkt.dport && x.proto === pkt.proto);
    if (!p) continue;
    if (c.state !== 'running') return { ok: false, reason: `${d.name} 的 ${pkt.dport} 發佈給容器 ${c.name}，但它沒有在執行（docker ps -a 看得到它是 Exited）：連線被拒絕` };
    if (p.hostIp === '127.0.0.1' && !local) return { ok: false, reason: `容器 ${c.name} 的埠只發佈在 127.0.0.1:${p.host}（只有主機自己連得到），從 ${fmtIp(pkt.src)} 連過來被拒絕` };
    if (!imagePorts(c.image).includes(p.ctr)) return { ok: false, reset: true, reason: `連線被重設：${d.name} 的 ${p.host} 轉給容器 ${c.name} 的 ${p.ctr}，可是 ${imageBase(c.image)} 在容器裡聽的是 ${imagePorts(c.image).join('、') || '（沒有）'}` };
    return { ok: true, ctr: c, text: `Docker：${d.name} 的 ${p.host} 轉給容器 ${c.name}（${c.ip}）的 ${p.ctr}` };
  }
  return null;
}

/** docker ps 的 PORTS 欄位 */
export function portsText(c) {
  const pub = c.publish.map((p) => `${p.hostIp}:${p.host}->${p.ctr}/${p.proto}`);
  const exposed = imagePorts(c.image).filter((x) => !c.publish.some((p) => p.ctr === x)).map((x) => `${x}/tcp`);
  return c.state === 'running' ? [...pub, ...exposed].join(', ') : '';
}
