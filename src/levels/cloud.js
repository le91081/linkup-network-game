// 第十六章：雲端網路 — VPC、公有 / 私有子網路、IGW 與 NAT 閘道、安全群組與網路 ACL、混合雲的站對站 VPN
import { makeDevice as D, makeState, setLine } from '../engine/model.js';
import { iosSession } from '../engine/ios.js';
import { vpnConfig } from '../engine/cloud.js';
import { terraform, tfPlan, addTfHosts, newTf, ruleHcl } from '../engine/terraform.js';
import { recompute } from '../engine/sim.js';
import { dev } from './util.js';

export const CHAPTERS10 = [
  { id: 16, title: '雲端網路', desc: '公有雲的虛擬私有雲 (VPC)：子網路與路由表、網際網路閘道與彈性 IP、NAT 閘道、安全群組與網路 ACL，以及用站對站 VPN 組成混合雲。' },
];

const two = [{ id: 'line1', label: '線路 1', media: 'rj45' }, { id: 'line2', label: '線路 2', media: 'rj45' }];
const OFFICE_PUB = '203.0.113.34';
const WEB_EIP = '54.199.20.10', NAT_EIP = '54.199.20.11';
const WEB = { id: 'i-0a3f9c2e71b45d801', name: 'web-1', subnet: 'subnet-0pub1a', ip: '10.50.1.10', eip: '', sgs: ['sg-0web'], type: 't3.small', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }, { proto: 'tcp', port: 80, name: 'HTTP' }, { proto: 'tcp', port: 22, name: 'SSH' }] };
const DB = { id: 'i-0d71e5b0c9a2f4436', name: 'db-1', subnet: 'subnet-0prv1a', ip: '10.50.2.20', eip: '', sgs: ['sg-0db'], type: 'r6g.large', services: [{ proto: 'tcp', port: 3306, name: 'MySQL' }, { proto: 'tcp', port: 22, name: 'SSH' }] };
const UPDATES = '93.184.216.34';
const VPN_PSK = 'Kq7vX2mR9tLw4pZ8nB3cH6yJ1sD5fG0a';

const PARTNER = '198.51.100.25';
/** 16-5 的 main.tf（partner：有沒有補上合作夥伴的 8443） */
const mainTf = (partner) => `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

# 官網 web-1 的安全群組：HTTPS 對外，SSH 只給公司
resource "aws_security_group" "web" {
  name        = "web"
  description = "web-1: HTTPS public, SSH from office"
  vpc_id      = "vpc-0c4e8a1f27d9b3650"

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH from office"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["${OFFICE_PUB}/32"]
  }
${partner ? `
  ingress {
    description = "Partner API"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = ["${PARTNER}/32"]
  }
` : ''}
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;

/** 公司（地端）與網際網路：兩章共用 */
function office() {
  const inet = D('internet', 'inet', { name: '網際網路', pos: [0, -9.5], ports: two });
  setLine(inet, 'line1', { type: 'static', gw: '203.0.113.33', mask: '255.255.255.252', assign: OFFICE_PUB });
  setLine(inet, 'line2', { type: 'static', gw: '54.199.20.1', mask: '255.255.255.192', assign: '54.199.20.2' });
  return [
    inet,
    D('isr4321', 'rt', {
      name: 'R1（公司）', pos: [-7, -4],
      init(d) {
        Object.assign(d.ifaces[0], { ip: OFFICE_PUB, mask: '255.255.255.252', gateway: '203.0.113.33', nat: true });
        Object.assign(d.ifaces[1], { ip: '10.20.0.1', mask: '255.255.255.0' });
      },
    }),
    D('sw8', 'sw', { name: '公司交換器', pos: [-7, 0.5] }),
    D('pc', 'pc', { name: '管理員 PC', pos: [-10, 5], ip: '10.20.0.10', gw: '10.20.0.1', dns: '8.8.8.8' }),
  ];
}
const officeCables = [['inet:line1', 'rt:Gi0/0/0'], ['rt:Gi0/0/1', 'sw:1'], ['pc:eth0', 'sw:2']];

/** 雲端的 VPC（一開始的樣子：網站搬上去了，但還沒有對外） */
function cloud(init) {
  return D('vpc', 'aws', {
    name: 'AWS · 正式環境 VPC', pos: [7.5, -3],
    init(d) {
      Object.assign(d.ifaces[0], { ip: '54.199.20.2', mask: '255.255.255.192', gateway: '54.199.20.1' });
      const v = d.vpc;
      Object.assign(v, { id: 'vpc-0c4e8a1f27d9b3650', cidr: '10.50.0.0/16', eips: [WEB_EIP] });
      v.subnets.push({ id: 'subnet-0pub1a', name: 'public-a', cidr: '10.50.1.0/24', az: 'ap-northeast-1a' });
      v.rts[0].id = 'rtb-0main5e2a91c7d40';
      v.sgs.push({ id: 'sg-0web', name: 'web', in: [{ proto: 'tcp', port: '22', src: '10.20.0.0/24' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] });
      v.instances.push({ ...WEB, sgs: [...WEB.sgs], services: WEB.services.map((x) => ({ ...x })) });
      if (init) init(d, v);
    },
  });
}
/** 16-1 的解法：IGW、路由、EIP、安全群組 */
function publicDone(v) {
  v.igw = true;
  v.rts[0].routes.push({ dst: '0.0.0.0/0', target: 'igw' });
  v.instances[0].eip = WEB_EIP;
  v.sgs.find((g) => g.id === 'sg-0web').in = [{ proto: 'tcp', port: '443', src: '0.0.0.0/0' }, { proto: 'tcp', port: '22', src: OFFICE_PUB + '/32' }];
}

export const LEVELS12 = [
  // ════════════════════════ 16-1 ════════════════════════
  {
    id: 'l60', chapter: 16, title: '把網站搬上雲端', subtitle: 'VPC、網際網路閘道、彈性 IP、安全群組', tags: ['雲端', 'VPC', 'IGW', 'Elastic IP', '安全群組'],
    brief: '公司把官網搬到 AWS 東京區域：VPC 和子網路都建好了，web-1 這台 EC2 也已經裝好網站，但外面完全連不到。請讓網路上的人可以用 https://54.199.20.10 開網站，web-1 自己也要能連外下載更新；SSH 只開放給公司（從公司的網路連進來），HTTP 不對外。',
    given: [
      ['VPC', '10.50.0.0/16 · public-a 10.50.1.0/24'], ['web-1', '私有 IP 10.50.1.10 · 網站 HTTPS 443、管理 SSH 22'],
      ['已配置的彈性 IP', WEB_EIP], ['公司對外的公用 IP', `${OFFICE_PUB}（R1 做 NAT）`], ['公司內部', '10.20.0.0/24'],
    ],
    learn: [
      { t: 'IaaS、PaaS、SaaS', d: 'IaaS 租的是基礎設施（虛擬機器、網路、儲存），作業系統以上自己管，例如 EC2 與 VPC；PaaS 連作業系統與執行環境都交給業者，只管程式；SaaS 直接用現成的軟體，例如 Microsoft 365。越往 SaaS，自己要管的越少、能調整的也越少。' },
      { t: '公有雲、私有雲、混合雲', d: '公有雲是和其他客戶共用業者的機房（多租戶，靠虛擬化隔離），按用量計費、可以隨時擴充或縮減（彈性）；私有雲是自己的機房；兩者用 VPN 或專線連起來就是混合雲。' },
      { t: 'VPC 與公有子網路', d: 'VPC 是雲端上自己的私有網路。子網路是公有還是私有，看它的路由表：有 0.0.0.0/0 → 網際網路閘道 (IGW) 的才是公有子網路。光是建立 IGW 不夠，還要連接到 VPC、再寫進路由表。' },
      { t: '彈性 IP 與一對一 NAT', d: '執行個體自己只有私有 IP。IGW 替關聯了公用 IP（彈性 IP）的執行個體做一對一的位址轉換：外面連 54.199.20.10，IGW 換成 10.50.1.10 送進去。沒有公用 IP 的執行個體從 IGW 出不去。' },
      { t: '安全群組', d: '掛在執行個體上的防火牆，只有允許規則、而且有狀態：允許連進來，回應就自動放行。來源要寫「雲端看到的位址」——公司的電腦經過 NAT 出去，雲端看到的是公司的公用 IP，不是 10.20.0.x。' },
    ],
    setup() {
      return makeState([...office(), cloud()], [...officeCables, ['inet:line2', 'aws:inet']]);
    },
    objectives: [
      { type: 'tcp', from: 'inet', ip: WEB_EIP, port: 443, label: `網路上的人可以開啟 https://${WEB_EIP}` },
      { type: 'tcp', from: 'aws', srcIp: WEB.ip, ip: UPDATES, port: 443, label: 'web-1 可以連上網際網路（下載更新）' },
      { type: 'tcp', from: 'pc', ip: WEB_EIP, port: 22, label: '公司的管理員可以 SSH 到 web-1' },
      { type: 'tcp', from: 'inet', ip: WEB_EIP, port: 22, expect: false, label: '公司以外的人 SSH 連不進去' },
      { type: 'tcp', from: 'inet', ip: WEB_EIP, port: 80, expect: false, label: 'HTTP (80) 不對外開放' },
    ],
    hints: [
      '選取雲端 →「VPC」分頁：把網際網路閘道 (IGW) 連接到這個 VPC。',
      '「路由表」分頁：主路由表新增 0.0.0.0/0 → 網際網路閘道。這樣 public-a 才是公有子網路（分頁上的標籤會從「私有」變成「公有」）。',
      '「EC2」分頁：web-1 的公用 IP 選 54.199.20.10。',
      `「安全群組」分頁的 web：輸入規則加上 TCP 443、來源 0.0.0.0/0。SSH 的來源要改成公司的公用 IP ${OFFICE_PUB}/32——公司的電腦經過 R1 的 NAT，雲端看到的來源是公用 IP。`,
      '可以在 EC2 分頁打開 EC2 Instance Connect，從 web-1 測試 curl 93.184.216.34。',
    ],
    solve(s) { publicDone(dev(s, 'aws').vpc); },
    recap: ['公有子網路 = 路由表有 0.0.0.0/0 → IGW；執行個體還要有公用 IP，IGW 才會替它做一對一 NAT。', '安全群組是有狀態的、只有允許規則；來源要寫雲端「看到」的位址（NAT 之後的公用 IP）。'],
  },

  // ════════════════════════ 16-2 ════════════════════════
  {
    id: 'l61', chapter: 16, title: '私有子網路與混合雲', subtitle: 'NAT 閘道、網路 ACL、站對站 VPN', tags: ['NAT 閘道', '網路 ACL', '無狀態', '混合雲', '站對站 VPN'],
    brief: '網站上線了，接著把資料庫 db-1 放進私有子網路：它不能有公用 IP，但要能經由 NAT 閘道下載更新；web-1 要連得到它的 MySQL (3306)。公司的電腦則要經由站對站 VPN 直接連到資料庫（不經過網際網路明文傳送）。同事已經建好了 NAT 閘道、網路 ACL 和 VPN 連線，但什麼都不通。',
    given: [
      ['private-a', '10.50.2.0/24 · 路由表 rtb-private · 網路 ACL acl-private'], ['db-1', '10.50.2.20 · MySQL 3306 · 安全群組 db'],
      ['NAT 閘道', `nat-0f1e…（EIP ${NAT_EIP}）`], ['VPN 連線', `客戶閘道 ${OFFICE_PUB}（R1）· 地端 10.20.0.0/24 · IKEv2`],
      ['預先共用金鑰', VPN_PSK],
    ],
    learn: [
      { t: 'NAT 閘道', d: '讓私有子網路「由內往外」連上網際網路，外面連不進來。它本身要放在公有子網路、要有彈性 IP；私有子網路的路由表把 0.0.0.0/0 指向它。放錯子網路是最常見的錯誤：NAT 閘道自己也出不去。' },
      { t: '網路 ACL 是無狀態的', d: '掛在子網路上，規則有編號、可以拒絕，而且不記得連線：web-1 連 db-1 的 3306，db-1 的回應從 3306 送往 web-1 的臨時連接埠 (1024 – 65535)。只允許「輸出 3306」的話，回應就被擋了。安全群組才是有狀態的。' },
      { t: '混合雲與站對站 VPN', d: 'VPC 連接虛擬私有閘道 (VGW)，對公司的路由器（客戶閘道）建立 IPsec 通道。AWS 那一端的參數是固定的，業者提供各家設備的設定檔下載；公司這一端照著設定，往 VPC 的流量還要排除在 NAT 之外。' },
      { t: '雲端的路由也要設定', d: 'VPN 通了不代表流量會走進去：私有子網路的路由表要有 10.20.0.0/24 → vgw，或開啟「路由傳播」讓 VPN 連線的地端網段自動加進來。' },
    ],
    setup() {
      const s = makeState([...office(), cloud((d, v) => {
        publicDone(v);
        v.eips.push(NAT_EIP);
        v.subnets.push({ id: 'subnet-0prv1a', name: 'private-a', cidr: '10.50.2.0/24', az: 'ap-northeast-1a', rtb: 'rtb-0private3b8e', nacl: 'acl-0private7c1d' });
        v.rts.push({ id: 'rtb-0private3b8e', name: 'rtb-private', routes: [], prop: false });
        // 同事照著輸入規則「鏡像」寫了輸出規則：只放行 3306，回應封包的臨時連接埠被擋
        v.nacls.push({ id: 'acl-0private7c1d', name: 'acl-private', in: [{ n: 100, act: 'allow', proto: 'tcp', port: '3306', cidr: '10.50.0.0/16' }], out: [{ n: 100, act: 'allow', proto: 'tcp', port: '3306', cidr: '10.50.0.0/16' }] });
        v.sgs.push({ id: 'sg-0db', name: 'db', in: [{ proto: 'tcp', port: '3306', src: 'sg-0web' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] });
        v.instances.push({ ...DB, sgs: [...DB.sgs], services: DB.services.map((x) => ({ ...x })) });
        // NAT 閘道被建在私有子網路裡
        v.natgws.push({ id: 'nat-0f1e2d3c4b5a69788', subnet: 'subnet-0prv1a', eip: NAT_EIP });
        d.vpns.push({ name: 'vpn-07b3c9e1d5a2f4680', peer: OFFICE_PUB, remote: '10.20.0.0/24', psk: VPN_PSK, ike: 2 });
      })], [...officeCables, ['inet:line2', 'aws:inet']]);
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'aws', srcIp: WEB.ip, ip: DB.ip, port: 3306, label: 'web-1 連得到 db-1 的 MySQL (3306)' },
      { type: 'tcp', from: 'aws', srcIp: DB.ip, ip: UPDATES, port: 443, label: 'db-1 經由 NAT 閘道下載更新' },
      {
        type: 'check', label: 'db-1 沒有公用 IP，網際網路連不進去',
        test(s) {
          const v = dev(s, 'aws').vpc, x = v.instances.find((i) => i.name === 'db-1');
          if (x.eip) return 'db-1 關聯了彈性 IP：私有子網路的資料庫不應該有公用 IP';
          return !v.sgs.some((g) => (x.sgs || []).includes(g.id) && g.in.some((r) => r.src === '0.0.0.0/0')) || 'db 安全群組允許 0.0.0.0/0 連進來：資料庫只該開放給 web-1 與公司';
        },
      },
      { type: 'check', label: '站對站 VPN 通道建立 (UP)', test: (s) => { const t = dev(s, 'aws').vpns[0]; return (t.rt && t.rt.up) || `VPN 通道沒有建立：${(t.rt && t.rt.why) || '尚未協商'}`; } },
      { type: 'tcp', from: 'pc', ip: DB.ip, port: 3306, label: '公司的管理員 PC 經由 VPN 連到 db-1 (3306)' },
    ],
    hints: [
      '先看 NAT 閘道分頁：它被建在 private-a，要改到公有的 public-a。再到路由表 rtb-private 加上 0.0.0.0/0 → NAT 閘道。',
      '網路 ACL acl-private 是無狀態的：輸出要允許回應封包，例如規則 100 允許 TCP 1024-65535 → 0.0.0.0/0；下載更新還要輸出 TCP 443 → 0.0.0.0/0、輸入 TCP 1024-65535 ← 0.0.0.0/0（更新伺服器的回應）。從公司經由 VPN 來的 3306 也要在輸入規則允許（來源 10.20.0.0/24）。',
      'VPN 分頁：先連接虛擬私有閘道 (VGW)。路由表 rtb-private 開啟「路由傳播」，或手動加 10.20.0.0/24 → vgw。安全群組 db 加上 TCP 3306、來源 10.20.0.0/24。',
      '公司那一端：VPN 分頁按「下載設定檔」選 Cisco ISR，把內容貼到 R1 的 CLI（configure terminal 之後）。往 10.50.0.0/16 的流量不能被 NAT：R1 的 NAT 要排除這段（圖形介面「NAT / 轉發」的 NAT 例外填 10.50.0.0/16）。',
    ],
    solve(s) {
      recompute(s);
      const d = dev(s, 'aws'), v = d.vpc;
      v.natgws[0].subnet = 'subnet-0pub1a';
      v.vgw = true;
      const rt = v.rts.find((r) => r.name === 'rtb-private');
      rt.routes.push({ dst: '0.0.0.0/0', target: v.natgws[0].id });
      rt.prop = true;
      const acl = v.nacls.find((a) => a.name === 'acl-private');
      acl.in = [{ n: 100, act: 'allow', proto: 'tcp', port: '3306', cidr: '10.50.0.0/16' }, { n: 110, act: 'allow', proto: 'tcp', port: '3306', cidr: '10.20.0.0/24' }, { n: 120, act: 'allow', proto: 'tcp', port: '1024-65535', cidr: '0.0.0.0/0' }];
      acl.out = [{ n: 100, act: 'allow', proto: 'tcp', port: '1024-65535', cidr: '0.0.0.0/0' }, { n: 110, act: 'allow', proto: 'tcp', port: '443', cidr: '0.0.0.0/0' }];
      v.sgs.find((g) => g.name === 'db').in.push({ proto: 'tcp', port: '3306', src: '10.20.0.0/24' });
      // 公司的 R1：貼上「下載設定檔」，再把往 VPC 的流量排除在 NAT 之外
      const sess = iosSession(() => s.devices.rt, () => s);
      for (const l of ['configure terminal', ...vpnConfig(d, d.vpns[0], 'ios').split('\n'), 'end']) sess.exec(l);
      s.devices.rt.ifaces[0].natSkip = '10.50.0.0/16';
    },
    recap: ['NAT 閘道放在公有子網路，私有子網路的路由表把 0.0.0.0/0 指向它；外面連不進私有子網路。', '網路 ACL 無狀態：回應封包的目的是臨時連接埠 (1024 – 65535)，進出兩個方向都要允許。混合雲的 VPN：兩端參數要一致、雲端路由表要有往地端的路由、地端往 VPC 的流量不能被 NAT。'],
  },
  // ════════════════════════ 16-3 ════════════════════════
  {
    id: 'l109', chapter: 16, title: '加了負載平衡器，網站反而打不開', subtitle: '應用程式負載平衡器 (ALB)、目標群組與健康檢查', tags: ['雲端', 'ALB', '負載平衡', '健康檢查', '安全群組'],
    brief: '官網的流量越來越大，工程師把網站改成兩台 EC2（web-1、web-2，放在私有子網路），前面放一台應用程式負載平衡器 (ALB)，對外的位址是 https://54.199.20.12。切換之後網站整個打不開，ALB 回應「503 Service Unavailable」。網站伺服器沒有動過，安全群組也是從舊的 web-1 複製過來的。請讓網站恢復，兩台都要分到流量；網站伺服器不能直接對網際網路開放。',
    given: [
      ['VPC', '10.50.0.0/16 · public-a 10.50.1.0/24（ALB）· private-a 10.50.11.0/24、private-c 10.50.12.0/24'], ['web-alb', '彈性 IP 54.199.20.12 · 接聽 TCP 443 → 目標埠 443 · 安全群組 alb'],
      ['web-1 / web-2', '10.50.11.10、10.50.12.10 · HTTPS 443 · 安全群組 web'], ['公司', '對外 IP 203.0.113.34'],
    ],
    learn: [
      { t: '負載平衡器', d: '用戶端連到負載平衡器的位址，負載平衡器再把連線分給後面好幾台伺服器：流量分散，壞了一台也不影響。ALB 是第七層的反向代理：用戶端的連線在 ALB 結束，ALB 再自己連到目標。' },
      { t: '健康檢查', d: 'ALB 定期連到每個目標的目標埠，連得上才算「健康」，只把流量分給健康的目標；一台都不健康就回 503。健康檢查的來源是 ALB 自己的位址，所以目標的安全群組要允許 ALB 進來。' },
      { t: '用安全群組當來源', d: '目標的安全群組不必寫 ALB 的 IP（ALB 的 IP 會變），而是寫「來源 = ALB 的安全群組」：掛著那個安全群組的東西（ALB）都可以進來。網站伺服器放在私有子網路、沒有公用 IP，外面只能經過 ALB。' },
    ],
    setup() {
      const W1 = { id: 'i-0b5e2d9a4c71f3820', name: 'web-1', subnet: 'subnet-0prv1a', ip: '10.50.11.10', eip: '', sgs: ['sg-0web'], type: 't3.small', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }] };
      const W2 = { id: 'i-0e7c1a4f2b98d6053', name: 'web-2', subnet: 'subnet-0prv1c', ip: '10.50.12.10', eip: '', sgs: ['sg-0web'], type: 't3.small', services: [{ proto: 'tcp', port: 443, name: 'HTTPS' }] };
      return makeState([
        ...office(),
        D('vpc', 'aws', {
          name: 'AWS · 正式環境 VPC', pos: [7.5, -3],
          init(d) {
            Object.assign(d.ifaces[0], { ip: '54.199.20.2', mask: '255.255.255.192', gateway: '54.199.20.1' });
            const v = d.vpc;
            Object.assign(v, { id: 'vpc-0c4e8a1f27d9b3650', cidr: '10.50.0.0/16', eips: ['54.199.20.12'], igw: true });
            v.rts[0].id = 'rtb-0main5e2a91c7d40';
            v.rts.push({ id: 'rtb-0pub7c1e40a9b2d5', name: 'public', routes: [{ dst: '0.0.0.0/0', target: 'igw' }], prop: false });
            v.subnets.push({ id: 'subnet-0pub1a', name: 'public-a', cidr: '10.50.1.0/24', az: 'ap-northeast-1a', rtb: 'rtb-0pub7c1e40a9b2d5' },
              { id: 'subnet-0prv1a', name: 'private-a', cidr: '10.50.11.0/24', az: 'ap-northeast-1a' }, { id: 'subnet-0prv1c', name: 'private-c', cidr: '10.50.12.0/24', az: 'ap-northeast-1c' });
            v.sgs.push({ id: 'sg-0alb', name: 'alb', in: [{ proto: 'tcp', port: '443', src: '0.0.0.0/0' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] },
              { id: 'sg-0web', name: 'web', in: [{ proto: 'tcp', port: '443', src: OFFICE_PUB + '/32' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] });
            v.instances.push(W1, W2);
            v.lbs = [{ id: 'alb-0web3f81c2a7d', name: 'web-alb', subnet: 'subnet-0pub1a', eip: '54.199.20.12', sg: 'sg-0alb', port: 443, tgPort: 443, targets: [W1.id, W2.id] }];
          },
        }),
      ], [...officeCables, ['inet:line2', 'aws:inet']]);
    },
    objectives: [
      { type: 'tcp', from: 'pc', ip: '54.199.20.12', port: 443, label: '從公司打得開 https://54.199.20.12（經過 ALB）' },
      {
        type: 'check', label: 'web-1、web-2 都通過健康檢查（兩台都分得到流量）',
        test(s) {
          const v = dev(s, 'aws').vpc, r = ((dev(s, 'aws').rt.cloud || {}).lb || {})['alb-0web3f81c2a7d'] || { healthy: [], why: {} };
          for (const x of v.instances) if (!r.healthy.includes(x.id)) return `${x.name} 不健康：${r.why[x.id] || '不在目標群組裡'}`;
          return true;
        },
      },
      {
        type: 'check', label: '網站伺服器不直接對網際網路開放（沒有公用 IP、安全群組不開放 0.0.0.0/0）',
        test(s) {
          const v = dev(s, 'aws').vpc;
          for (const x of v.instances) if (x.eip) return `${x.name} 有公用 IP ${x.eip}：網站伺服器只能經過 ALB`;
          const web = v.sgs.find((g) => g.id === 'sg-0web');
          if (web && web.in.some((r) => (r.src || '') === '0.0.0.0/0')) return '安全群組 web 對 0.0.0.0/0 開放：只要允許 ALB（來源用安全群組 alb）';
          return true;
        },
      },
    ],
    hints: [
      'EC2 主控台 →「負載平衡器」：兩個目標都不健康，原因寫著安全群組 web 沒有允許 ALB 的健康檢查。安全群組 web 只允許公司的 203.0.113.34（從舊的 web-1 複製來的）。',
      '健康檢查是 ALB 自己（在 public-a 裡）連到目標的 TCP 443。「安全群組」→ web → 新增輸入規則：TCP 443，來源選安全群組 alb（sg-0alb）。',
      '不要改成來源 0.0.0.0/0：網站伺服器應該只讓 ALB 進來。',
    ],
    solve(s) { dev(s, 'aws').vpc.sgs.find((g) => g.id === 'sg-0web').in.push({ proto: 'tcp', port: '443', src: 'sg-0alb' }); },
    recap: ['ALB 只把流量分給通過健康檢查的目標；一台都不健康就回 503。', '健康檢查從 ALB 發出：目標的安全群組用「來源 = ALB 的安全群組」允許它，網站伺服器放在私有子網路、不對外開放。'],
  },
  // ════════════════════════ 16-4 ════════════════════════
  {
    id: 'l110', chapter: 16, title: '兩條 peering 接好了，開發環境還是連不到正式環境', subtitle: 'VPC peering 不能轉送：改用 Transit Gateway', tags: ['雲端', 'VPC peering', 'Transit Gateway', '路由表', 'non-transitive'],
    brief: '公司在 AWS 有三個 VPC：正式環境 prod、共用服務 shared、開發環境 dev。prod ↔ shared、dev ↔ shared 各有一條 peering，dev 的路由表也把 prod 的網段指向往 shared 的 peering，可是 dev 的 app 怎麼樣都連不到 prod 的資料庫。接下來還要再加十幾個 VPC，網路團隊已經建好一個 Transit Gateway。請讓 dev 的 app 經過 Transit Gateway 連到 prod 的 db（MySQL 3306），shared 的監控照樣連得到 db。',
    given: [
      ['prod', '10.10.0.0/16 · db 10.10.1.20（MySQL 3306，安全群組 db 只允許 shared 的網段）'], ['shared', '10.20.0.0/16 · mon 10.20.1.10（監控）'], ['dev', '10.30.0.0/16 · app 10.30.1.10'],
      ['peering', 'prod ↔ shared、dev ↔ shared'], ['Transit Gateway', '已經建好，還沒有任何 attachment'],
    ],
    learn: [
      { t: 'peering 不能轉送', d: 'VPC peering 是兩個 VPC 之間的一對一連線。A ↔ B、B ↔ C 都接了，A 的封包到了 B 也不會被轉給 C (non-transitive)：從 peering 進來的封包只能到 B 自己的執行個體。要互通就得 A ↔ C 再接一條，N 個 VPC 要 N×(N-1)/2 條。' },
      { t: 'Transit Gateway', d: '區域裡的雲端路由器：每個 VPC 用一個 attachment 接上去，路由表由各 VPC 的網段傳播 (propagation) 而來，任兩個 VPC 都經過它互通，VPN 與專線也可以接上來。新增 VPC 只要多一個 attachment。' },
      { t: '兩個方向都要有路', d: '去程：dev 的子網路路由表把 prod 的網段指向 Transit Gateway。回程：prod 的路由表也要把 dev 的網段指向 Transit Gateway，不然回應找不到路。目的地的安全群組也要允許新的來源網段。' },
    ],
    setup() {
      const vpc = (id, name, pos, cidr, sub, inst, sgs, routes, peers) => D('vpc', id, {
        name, pos,
        init(d) {
          const v = d.vpc;
          Object.assign(v, { id: `vpc-0${id}7a2c91e4d3b5f`, cidr });
          v.rts[0].id = `rtb-0${id}main4c8e2`;
          v.rts[0].routes.push(...routes);
          v.subnets.push(sub);
          v.sgs.push(...sgs);
          v.instances.push(inst);
          v.peers = peers;
        },
      });
      const PS = 'pcx-0a7e3c19d2b84f560', SD = 'pcx-0c41f8e2a95b7d031';
      const s = makeState([
        vpc('prod', 'AWS · prod（正式環境）', [-8, -2], '10.10.0.0/16', { id: 'subnet-0proda', name: 'prod-a', cidr: '10.10.1.0/24', az: 'ap-northeast-1a' },
          { id: 'i-0db71e5c9a2f44360', name: 'db', subnet: 'subnet-0proda', ip: '10.10.1.20', eip: '', sgs: ['sg-0db'], type: 'r6g.large', services: [{ proto: 'tcp', port: 3306, name: 'MySQL' }] },
          [{ id: 'sg-0db', name: 'db', in: [{ proto: 'tcp', port: '3306', src: '10.20.0.0/16' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] }],
          [{ dst: '10.20.0.0/16', target: PS }], [{ id: PS, peer: 'shared', status: 'active' }]),
        vpc('shared', 'AWS · shared（共用服務）', [0, -6.5], '10.20.0.0/16', { id: 'subnet-0shra', name: 'shared-a', cidr: '10.20.1.0/24', az: 'ap-northeast-1a' },
          { id: 'i-0e9a4c2d7b13f8605', name: 'mon', subnet: 'subnet-0shra', ip: '10.20.1.10', eip: '', sgs: ['sg-0mon'], type: 't3.medium', services: [{ proto: 'tcp', port: 443, name: '監控' }] },
          [{ id: 'sg-0mon', name: 'mon', in: [{ proto: 'tcp', port: '443', src: '10.0.0.0/8' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] }],
          [{ dst: '10.10.0.0/16', target: PS }, { dst: '10.30.0.0/16', target: SD }], [{ id: PS, peer: 'prod', status: 'active' }, { id: SD, peer: 'dev', status: 'active' }]),
        vpc('dev', 'AWS · dev（開發環境）', [8, -2], '10.30.0.0/16', { id: 'subnet-0deva', name: 'dev-a', cidr: '10.30.1.0/24', az: 'ap-northeast-1a' },
          { id: 'i-0a5f3e8c1d27b9402', name: 'app', subnet: 'subnet-0deva', ip: '10.30.1.10', eip: '', sgs: ['sg-0app'], type: 't3.small', services: [{ proto: 'tcp', port: 443, name: 'App' }] },
          [{ id: 'sg-0app', name: 'app', in: [{ proto: 'tcp', port: '443', src: '10.0.0.0/8' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] }],
          [{ dst: '10.20.0.0/16', target: SD }, { dst: '10.10.0.0/16', target: SD }], [{ id: SD, peer: 'shared', status: 'active' }]),
        D('tgw', 'tgw', { name: 'Transit Gateway', pos: [0, 3] }),
      ], []);
      s.devices.tgw.tgw.id = 'tgw-0f3a8c27d1e94b605';
      return s;
    },
    objectives: [
      { type: 'tcp', from: 'dev', srcIp: '10.30.1.10', ip: '10.10.1.20', port: 3306, via: 'tgw', label: 'dev 的 app 經過 Transit Gateway 連到 prod 的 db（3306）' },
      { type: 'tcp', from: 'shared', srcIp: '10.20.1.10', ip: '10.10.1.20', port: 3306, label: 'shared 的監控照樣連得到 prod 的 db' },
      {
        type: 'check', label: '三個 VPC 都 attach 到 Transit Gateway（之後新增 VPC 只要再接一個）',
        test(s) {
          const t = dev(s, 'tgw').tgw;
          for (const id of ['prod', 'shared', 'dev']) if (!(t.attach || []).includes(id)) return `${dev(s, id).name} 還沒有 attach 到 Transit Gateway`;
          return true;
        },
      },
    ],
    hints: [
      '先看現在為什麼不通：dev 把 10.10.0.0/16 送進往 shared 的 peering，到了 shared 就被丟掉 — peering 不能轉送。',
      'Transit Gateway 的主控台：把 prod、shared、dev 三個 VPC 都 attach 上去（路由傳播會自動學到三個網段）。再到 dev 的路由表把 10.10.0.0/16 改指向 Transit Gateway；prod 的路由表也要加 10.30.0.0/16 → Transit Gateway（回程）。',
      '還是不通？prod 的安全群組 db 只允許 shared 的 10.20.0.0/16，要加上 dev 的 10.30.0.0/16（TCP 3306）。',
    ],
    solve(s) {
      const T = 'tgw-0f3a8c27d1e94b605';
      dev(s, 'tgw').tgw.attach = ['prod', 'shared', 'dev'];
      dev(s, 'dev').vpc.rts[0].routes.find((r) => r.dst === '10.10.0.0/16').target = T;
      dev(s, 'prod').vpc.rts[0].routes.push({ dst: '10.30.0.0/16', target: T });
      dev(s, 'prod').vpc.sgs.find((g) => g.id === 'sg-0db').in.push({ proto: 'tcp', port: '3306', src: '10.30.0.0/16' });
    },
    recap: ['VPC peering 是一對一、不能轉送的：A ↔ B、B ↔ C 不代表 A 到得了 C。', 'Transit Gateway 讓所有 VPC 接到同一台雲端路由器；兩邊的子網路路由表都要指向它，目的地的安全群組也要允許新的來源。'],
  },

  // ════════════════════════ 16-5 ════════════════════════
  {
    id: 'l112', chapter: 16, title: '昨晚有人在主控台改了安全群組', subtitle: 'Terraform：基礎架構即程式碼與組態漂移 (drift)', tags: ['雲端', 'Terraform', 'IaC', 'drift', '安全群組'],
    brief: `公司的 AWS 安全群組一律用 Terraform 管理，main.tf 放在 Git 上（自動化工作站剛 clone 下來）。昨晚值班的同事為了救火，直接在 AWS 主控台改了 web 的安全群組：替合作夥伴開了 8443（他們的 API 今天正式上線，要保留），又為了讓廠商遠端除錯，把 SSH 開給了全世界（忘了關）。請讓 main.tf 重新成為唯一的依據：合作夥伴照樣連得上 8443、SSH 只開給公司，最後 terraform plan 要顯示沒有任何變更。`,
    given: [
      ['自動化工作站', '10.20.0.50 · Linux · main.tf 在「Terraform」分頁（終端機也可以下 terraform 指令）'],
      ['web 安全群組', 'sg-0web · 由 Terraform 管理（state 裡有它）'],
      ['合作夥伴', `${PARTNER} · 呼叫 https://${WEB_EIP}:8443`], ['公司對外的公用 IP', OFFICE_PUB],
    ],
    learn: [
      { t: '基礎架構即程式碼 (IaC)', d: '把雲端資源寫成文字檔（Terraform 的 .tf，HCL 語法），放進 Git 做版本控制與審查。它是宣告式的：檔案寫的是「最後要長什麼樣子」，不是一步一步的操作；同一份檔案套用幾次，結果都一樣。' },
      { t: 'init、plan、apply', d: 'terraform init 下載 provider（和雲端 API 溝通的外掛）。plan 先讀取雲端現況 (refresh)，和 .tf 比對，列出要新增 (+)、修改 (~)、刪除 (-) 的地方；apply 照計畫真的去改，要回答 yes 才會動手。state 檔 (terraform.tfstate) 記錄 Terraform 管理了哪些資源、它們在雲端的 ID。' },
      { t: '組態漂移 (drift)', d: '有人繞過 Terraform 直接在主控台改，雲端就和程式碼不一樣了。plan 會先列出「Objects have changed outside of Terraform」，接著計畫把它改回 .tf 寫的樣子。要保留的手動變更就補進 .tf（程式碼才是依據），不要的就讓 apply 拿掉。' },
      { t: 'inline 規則是整組管理', d: 'ingress / egress 直接寫在 aws_security_group 裡時，Terraform 管的是「整組規則」：不在 .tf 裡的規則，apply 一律刪掉。所以先看清楚 plan 的每一個「-」再 apply。' },
    ],
    setup() {
      const o = office();
      addTfHosts(o[0]);
      o[0].inet.hosts.push({ ip: PARTNER, name: '合作夥伴（API 用戶端）', services: [] });
      return makeState([
        ...o,
        D('laptop', 'tf', { name: '自動化工作站', pos: [-4, 5], ip: '10.20.0.50', gw: '10.20.0.1', dns: '8.8.8.8', init(d) { d.tf = newTf(mainTf(false), { state: { 'aws_security_group.web': { id: 'sg-0web', in: [{ proto: 'tcp', port: '443', src: '0.0.0.0/0' }, { proto: 'tcp', port: '22', src: OFFICE_PUB + '/32' }], out: [{ proto: 'all', port: '', dst: '0.0.0.0/0' }] } } }); } }),
        cloud((d, v) => {
          publicDone(v);
          // 昨晚在主控台手動加的兩條
          v.sgs.find((g) => g.id === 'sg-0web').in.push({ proto: 'tcp', port: '8443', src: PARTNER + '/32' }, { proto: 'tcp', port: '22', src: '0.0.0.0/0' });
          v.instances[0].services.push({ proto: 'tcp', port: 8443, name: 'Partner API' });
        }),
      ], [...officeCables, ['inet:line2', 'aws:inet'], ['tf:eth0', 'sw:3']]);
    },
    objectives: [
      { type: 'tcp', from: 'inet', srcIp: PARTNER, ip: WEB_EIP, port: 8443, label: `合作夥伴（${PARTNER}）連得上 https://${WEB_EIP}:8443` },
      { type: 'tcp', from: 'inet', ip: WEB_EIP, port: 443, label: '官網照常對外（443）' },
      { type: 'tcp', from: 'pc', ip: WEB_EIP, port: 22, label: '公司的管理員照樣可以 SSH 到 web-1' },
      { type: 'tcp', from: 'inet', ip: WEB_EIP, port: 22, expect: false, label: '公司以外的人 SSH 連不進去' },
      {
        type: 'check', label: 'main.tf 和雲端一致：terraform plan 顯示 No changes',
        test(s) {
          const d = dev(s, 'tf');
          if (!d.tf.inited) return '自動化工作站還沒有 terraform init';
          const p = tfPlan(s, d);
          if (p.err) return 'main.tf 有錯誤：' + p.err[0].replace(/^Error: /, '');
          if (!p.changes.length) return true;
          const c = p.changes[0];
          return `terraform plan 還有要改的：${c.addr} ${c.d.map(([dir, r, sg]) => `${sg === '+' ? '加上' : '拿掉'}${dir === 'in' ? '輸入' : '輸出'}規則 ${ruleHcl(r, dir)}`).join('；')}`;
        },
      },
    ],
    hints: [
      '自動化工作站 →「Terraform」分頁（或終端機）：先 terraform init 下載 AWS provider，再 terraform plan 看看。',
      'plan 最上面的「Objects have changed outside of Terraform」就是昨晚在主控台改的兩條。直接 apply 會兩條都拿掉 — 包括合作夥伴要用的 8443。',
      `在 main.tf 的 web 加一個 ingress 區塊：from_port = 8443、to_port = 8443、protocol = "tcp"、cidr_blocks = ["${PARTNER}/32"]。再 plan 一次，應該只剩「拿掉 SSH 0.0.0.0/0」。`,
      'terraform apply，看清楚計畫之後回答 yes（分頁上按「yes」，或在終端機用 terraform apply -auto-approve）。最後再 plan 一次：No changes。',
    ],
    solve(s) {
      recompute(s);
      dev(s, 'tf').tf.main = mainTf(true);
      terraform(s, 'tf', ['init']);
      terraform(s, 'tf', ['apply', '-auto-approve']);
      recompute(s);
    },
    recap: ['Terraform 的 .tf 寫的是「應該長什麼樣子」：plan 比對雲端現況、列出差異，apply 把差異改掉。', '在主控台手動改是 drift：要留的補進程式碼，不要的交給 apply 拿掉；改設定一律走「程式碼 → plan → apply」。'],
  },
];
