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

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    rollupOptions: { output: { manualChunks: chunkOf } },
  },
});
