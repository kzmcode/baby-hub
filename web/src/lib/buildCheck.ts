// ビルド時の安全確認（vite.config.ts から使用）
/** 本番ビルドでエミュレータ接続が有効なら失敗させる */
export function assertNoEmulatorsInProduction(mode: string, env: Record<string, string | undefined>): void {
  if (mode === 'production' && env.VITE_USE_EMULATORS === 'true') {
    throw new Error('本番ビルドで VITE_USE_EMULATORS=true は使えません。.env.production などで false にしてください。');
  }
}
