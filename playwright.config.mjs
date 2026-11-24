// 瀏覽器端測試：用電腦上已經裝好的 Google Chrome（channel: 'chrome'），不另外下載瀏覽器。
// 開一個獨立的伺服器（4519 埠）：不同的埠就是不同的來源，瀏覽器的存檔和平常玩的 5173 完全分開。
// （Windows 的 Hyper-V 會保留 5164–5363 等埠段，選在保留範圍之外）
//
// 速度（563 個測試，8 核心 16 執行緒的電腦上量的）：
// - 測的是打包好的版本（vite build --mode e2e → dist-e2e/，再用 vite preview 提供）：每開一頁只抓 6 個檔案。
//   開發伺服器沒有打包，每頁要抓 280 多個原始檔，而且它是單一執行緒：平行數開再多也是它在塞車
//   （3 個和 8 個平行跑一樣久）。想直接測原始碼（不建置、改了馬上測）：PW_DEV=1 npx playwright test。
// - 平行數跟著 CPU：邏輯核心數的一半，最多 8 個（再多 CPU 就滿了，反而變慢）。PW_WORKERS=4 可以自己指定。
// - trace 只在重試的時候錄：每個測試都錄大約多花四成的時間。失敗的測試會自動重跑一次並錄下 trace；
//   重跑才過的（不穩定的測試）一樣算失敗 (failOnFlakyTests)，不會被悄悄放過。
import os from 'node:os';
import { defineConfig } from '@playwright/test';

const PORT = 4519;
const DEV = !!process.env.PW_DEV;
const WORKERS = +process.env.PW_WORKERS || Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: WORKERS,
  retries: 1,
  failOnFlakyTests: true,
  reporter: [['list']],
  outputDir: 'e2e/.results',
  use: {
    channel: 'chrome',
    headless: true,
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: '1440x900', use: { viewport: { width: 1440, height: 900 } } },
    { name: '1024x768', use: { viewport: { width: 1024, height: 768 } }, testMatch: /ui|levels/ },
  ],
  webServer: {
    command: DEV
      ? `npx vite --port ${PORT} --strictPort`
      : `npx vite build --mode e2e && npx vite preview --mode e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
