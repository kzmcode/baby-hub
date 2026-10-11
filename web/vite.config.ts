import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { assertNoEmulatorsInProduction } from './src/lib/buildCheck.ts';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// firebase-messaging-sw.js は public/ に置き、別スコープ（/firebase-cloud-messaging-push-scope）で動かす
export default defineConfig(({ mode }) => {
  assertNoEmulatorsInProduction(mode, { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env });
  return {
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // 更新は「更新があります」トーストでユーザーが適用
      includeAssets: ['icons/icon.svg'],
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/__\//, /^\/firebase-messaging-sw\.js$/],
        globIgnores: ['**/firebase-messaging-sw.js'],
      },
      manifest: {
        name: 'Baby hub',
        short_name: 'Baby hub',
        description: '夫婦で育児の記録・予定・健康情報を共有するアプリ',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#FCF8F4',
        background_color: '#FCF8F4',
        icons: [
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
};
});
