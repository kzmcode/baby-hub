import { defineConfig } from 'vitest/config';

// 通常の `npm test` はエミュレータ不要のテストのみ。`*.emu.test.ts` は エミュレータ環境（npm run test:emu）のときだけ実行する。
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', ...((process.env.EMU || process.env.FIRESTORE_EMULATOR_HOST) ? [] : ['**/*.emu.test.ts'])],
    testTimeout: 30000,
  },
});
