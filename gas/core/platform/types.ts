export interface PlatformConfig {
  projectId: string;
  webApiKey: string;
  firestoreBaseUrl: string;
  identityBaseUrl: string;
  fcmEnabled: boolean;
  emulator: boolean;
  /** エミュレータ専用：回数制限を無効化（e2e 用。本番 GAS では常に未設定） */
  rateLimitDisabled?: boolean;
}

export interface DriveAdapter {
  ensureFolder(name: string): string;
  writeJson(folderId: string, name: string, json: string): string;
  listFiles(folderId: string, includeTrashed?: boolean): { id: string; name: string; createdAt: Date }[];
  readJson(fileId: string): string;
  trash(fileId: string): void;
  remove(fileId: string): void;
}

export interface Platform {
  fetch(
    url: string,
    init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string },
  ): { status: number; body: string; headers?: Record<string, string> };
  getAccessToken(): string;
  config: PlatformConfig;
  randomToken(bytes: number): string;
  sha256Hex(s: string): string;
  cacheGet(key: string): string | null;
  cachePut(key: string, value: string, ttlSec: number): void;
  /** 永続ストア（GAS: スクリプトプロパティ）。CacheService が空振りしても残したい小さな値用（JWKS など）。省略可 */
  propGet?(key: string): string | null;
  propPut?(key: string, value: string): void;
  /** 永続ストアの削除・列挙（回数制限・予算キーの掃除用。省略可） */
  propRemove?(key: string): void;
  propKeys?(): string[];
  cacheRemove?(key: string): void;
  /**
   * スクリプト全体の排他ロックを tryLock する（GAS: LockService.getScriptLock）。取得できれば解放関数、できなければ null。
   * 未実装のプラットフォーム（Node の単一プロセス）では排他不要として扱う。
   */
  tryScriptLock?(timeoutMs: number): (() => void) | null;
  /** この実行で呼んだ fetch の累計回数（日次 UrlFetch 予算の計上用。省略可） */
  fetchCount?(): number;
  log(level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, string | number | boolean>): void;
  drive?: DriveAdapter;
}
