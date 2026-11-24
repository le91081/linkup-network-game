// ESLint（npm run lint）：抓真正的錯誤（未定義的變數、打錯的名稱、到不了的程式、重複的 key…），不管排版
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'dist-artifact/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
  },
  { files: ['public/sw.js'], languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } } },
  {
    // 引擎在 Node 裡也會跑（單元測試）：只能用兩邊都有的東西，但這裡不另外限制
    files: ['test/**/*.mjs', 'e2e/**/*.mjs', '*.config.js', '*.config.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      // 沒用到的參數常常是為了保持介面一致（例如 (ctx, body) 的面板函式），只檢查變數
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 中文的全形空白（　）是故意的：出現在畫面上的文字、樣板字串與註解裡
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true, skipRegExps: true }],
      // 比對命令列輸出的正規表示式，常常故意寫好幾個空白（和畫面上的對齊一樣），比 / {3}/ 好讀
      'no-regex-spaces': 'off',
    },
  },
];
