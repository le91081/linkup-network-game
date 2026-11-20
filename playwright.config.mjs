// 瀏覽器端測試：用電腦上已經裝好的 Google Chrome（channel: 'chrome'），不另外下載瀏覽器。
// 開一個獨立的開發伺服器（4519 埠）：不同的埠就是不同的來源，瀏覽器的存檔和平常玩的 5173 完全分開。
// （Windows 的 Hyper-V 會保留 5164–5363 等埠段，選在保留範圍之外）
import { defineConfig } from '@playwright/test';

const PORT = 4519;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  outputDir: 'e2e/.results',
  use: {
    channel: 'chrome',
    headless: true,
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: '1440x900', use: { viewport: { width: 1440, height: 900 } } },
    { name: '1024x768', use: { viewport: { width: 1024, height: 768 } }, testMatch: /ui|levels/ },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
