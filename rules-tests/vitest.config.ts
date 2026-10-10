import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['*.test.ts'], testTimeout: 20000, hookTimeout: 30000, fileParallelism: false },
});
