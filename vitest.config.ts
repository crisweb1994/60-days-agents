import { defineConfig } from 'vitest/config';

const e2e = process.env.CHECK_MODE === 'e2e';

export default defineConfig({
  test: {
    include: ['days/*/tests/**/*.test.ts', 'shared/**/*.test.ts'],
    // 真实模型比 mock 慢得多
    testTimeout: e2e ? 120_000 : 5_000,
    // e2e 时测试文件一个一个跑，免得同时发太多请求触发限流
    fileParallelism: !e2e,
  },
});
