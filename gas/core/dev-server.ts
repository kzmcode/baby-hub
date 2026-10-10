// ローカル開発サーバー。Auth / Firestore エミュレータに接続し、GAS の doPost と同じ処理を提供する。
//   FIREBASE_PROJECT_ID（既定 demo-baby-hub）, FIREBASE_WEB_API_KEY（既定 fake-api-key）,
//   FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST（両方必須。demo- 以外のプロジェクト ID は起動拒否）
//   /__test/* は NODE_ENV=test && ENABLE_TEST_ENDPOINTS=1 のときだけ。127.0.0.1 のみで待ち受け
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { listBackups, runBackupNow, runRestore } from '../backup';
import { runDispatch } from '../notify';
import { setPlatform } from './context';
import { nodePlatform } from './platform/node';
import { handleRequest } from './router';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** CORS ヘッダ。Origin が http://localhost:* / http://127.0.0.1:* のときだけ許可として反映する */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (origin && LOCAL_ORIGIN.test(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/** /__test/* を有効にしてよいか（NODE_ENV=test かつ ENABLE_TEST_ENDPOINTS=1 のときだけ） */
export function testEndpointsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'test' && env.ENABLE_TEST_ENDPOINTS === '1';
}

/**
 * 起動条件。本番プロジェクトへ誤接続しないよう、demo- で始まるプロジェクト ID と
 * Auth / Firestore エミュレータの環境変数が揃っているときだけ起動する。違反は例外。
 */
export function assertSafeEnvironment(env: Record<string, string | undefined> = process.env): void {
  const projectId = env.FIREBASE_PROJECT_ID || 'demo-baby-hub';
  if (!projectId.startsWith('demo-')) throw new Error(`dev-server refuses to start: FIREBASE_PROJECT_ID must start with "demo-" (got "${projectId}")`);
  if (!env.FIRESTORE_EMULATOR_HOST || !env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('dev-server refuses to start: FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must be set (run under the Firebase emulators)');
  }
}

/** NODE_ENV=test かつ ENABLE_TEST_ENDPOINTS=1 のときだけ有効なテスト用内部エンドポイント（POST /__test/<name>、本文は JSON 引数）。本番 GAS には存在しない。 */
function handleTestEndpoint(name: string, rawBody: string): { status: number; body: string } {
  setPlatform(nodePlatform);
  try {
    const a = (rawBody ? JSON.parse(rawBody) : {}) as Record<string, string | undefined>;
    let result: unknown;
    if (name === 'runDispatch') result = runDispatch();
    else if (name === 'runBackupNow') result = runBackupNow(a.kind as 'full' | 'incremental' | undefined);
    else if (name === 'listBackups') result = listBackups();
    else if (name === 'runRestore') result = runRestore(a.targetProjectId ?? '', a.fullFileId ?? '', a.incrementalFileIdsCsv ?? '', a.confirm);
    else return { status: 404, body: JSON.stringify({ ok: false, error: { code: 'not-found', message: 'Unknown test endpoint' } }) };
    return { status: 200, body: JSON.stringify({ ok: true, result }) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { status: 200, body: JSON.stringify({ ok: false, error: { code: err.code ?? 'internal', message: err.message ?? 'error' } }) };
  }
}

export function startDevServer(port = 8787): Server {
  assertSafeEnvironment();
  const server = createServer((req, res) => {
    const CORS = corsHeaders(typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, CORS).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const body = size > 1024 * 1024 ? 'x'.repeat(70000) : Buffer.concat(chunks).toString('utf8');
      const m = testEndpointsEnabled() ? /^\/__test\/(\w+)$/.exec(req.url ?? '') : null;
      if (m) {
        const r = handleTestEndpoint(m[1], body);
        res.writeHead(r.status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }).end(r.body);
        return;
      }
      const out = handleRequest(nodePlatform, body);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }).end(out);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`dev-server listening on http://127.0.0.1:${port} (project=${nodePlatform.config.projectId})`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDevServer(Number(process.env.PORT) || 8787);
}
