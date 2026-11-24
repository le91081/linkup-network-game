import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// 分塊：three.js、模擬引擎、關卡與題庫、介面各自一個檔案。
// 改了關卡或介面時，瀏覽器快取裡的 three.js 與引擎不用重新下載；四個檔案也可以平行載入。
const chunkOf = (id) => {
  const p = id.replace(/\\/g, '/');
  if (p.includes('/node_modules/three/')) return 'three';
  if (p.includes('/src/engine/')) return 'engine';
  if (p.includes('/src/levels/') || p.includes('/src/data/')) return 'content';
  return undefined;
};

// 發佈成 Claude 的 Artifact（vite build --mode artifact，輸出到 dist-artifact/）：
// - three.js 不打包進來，改從 jsDelivr 載入（Artifact 只允許幾個 CDN 的外部程式），版本和 node_modules 裡的一樣
// - 另外產生 page.html：拿掉 <html>、<head>、<body>，因為 Artifact 發佈時會自己包上這一層
const THREE = JSON.parse(fs.readFileSync(new URL('./node_modules/three/package.json', import.meta.url), 'utf8')).version;
const IMPORTS = {
  three: `https://cdn.jsdelivr.net/npm/three@${THREE}/build/three.module.min.js`,
  'three/addons/': `https://cdn.jsdelivr.net/npm/three@${THREE}/examples/jsm/`,
};
const OUT_ARTIFACT = 'dist-artifact';
const artifactPage = () => ({
  name: 'linkup-artifact',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    // import map 要在任何 module script 之前
    handler: (html) => html.replace('<head>', `<head>\n    <script type="importmap">${JSON.stringify({ imports: IMPORTS })}</script>`),
  },
  closeBundle() {
    const full = fs.readFileSync(path.join(OUT_ARTIFACT, 'index.html'), 'utf8');
    const page = full
      .replace(/<!doctype html>\s*/i, '')
      .replace(/<\/?html[^>]*>\s*/gi, '')
      .replace(/<\/?(head|body)>\s*/gi, '')
      .replace(/\s*<meta (charset|name="viewport")[^>]*>/gi, '')
      .replace(/\s*<link rel="icon"[^>]*>/gi, '')
      .replace(/<title>[^<]*<\/title>/i, '<title>LinkUp</title>')
      .replace(/^\s+/, '');
    // 名稱要在最前面（Artifact 只看檔案開頭找 <title>）
    const title = '<title>LinkUp</title>';
    fs.writeFileSync(path.join(OUT_ARTIFACT, 'page.html'), `${title}\n${page.replace(title, '').trim()}\n`);
  },
});

export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  // 瀏覽器端測試用的建置（vite build --mode e2e）：輸出到 dist-e2e/，附 source map（測試失敗時看得懂是哪一行），不註冊 service worker
  const e2e = mode === 'e2e';
  return {
    base: './',
    server: { port: 5173, strictPort: true },
    plugins: artifact ? [artifactPage()] : [],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 700,
      outDir: artifact ? OUT_ARTIFACT : e2e ? 'dist-e2e' : 'dist',
      sourcemap: e2e,
      rollupOptions: {
        external: artifact ? [/^three(\/.*)?$/] : [],
        output: { manualChunks: chunkOf },
      },
    },
  };
});
