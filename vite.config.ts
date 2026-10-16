import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 部署到 GitHub Pages 的**项目页**时，站点在 https://<user>.github.io/<repo>/ 下，
  // 所有资源都必须带 /<repo>/ 前缀，否则全站 404。仓库名取 battlechess-web。
  // 换仓库名、或改传到 <user>.github.io 用户主页 / 绑自定义域名（那种情况应为 '/'）改这里，
  // 也可以用 BASE_PATH 环境变量覆盖。
  // 注意：这个 base 对 dev server 同样生效 —— 本地地址是
  //   http://localhost:5173/battlechess-web/
  // 开发与生产同路径，base 写错在本地就能发现。
  base: process.env.BASE_PATH ?? '/battlechess-web/',
  plugins: [react()],
  test: {
    environment: 'node',
    // 有些 shell 会导出 NODE_ENV=production（这台机器就是），那样 React 会解析到
    // production 构建：React.act 不存在 → @testing-library/react 全线报
    // "React.act is not a function"。这里显式钉住，不依赖调用方的环境。
    env: { NODE_ENV: 'test' },
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test-setup.ts',
        'src/main.tsx',
        'src/core/test-helpers.ts',
      ],
    },
  },
});
