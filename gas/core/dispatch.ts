// リクエスト処理本体（ハンドラ表を引数に取るので、テストでは任意のハンドラを注入できる）
import { verifyIdToken } from './auth';
import { assertRequestBudget, chargeBudget } from './budget';
import { FAIL_COUNTED_FNS, FAIL_LIMIT, GLOBAL_LIMIT, consume, limitsFor, release } from './ratelimit';
import { dbFor, setPlatform, type Handler } from './context';
import { ApiError } from './errors';
import type { Platform } from './platform/types';

export const MAX_BODY_BYTES = 64 * 1024;

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function fail(code: string, message: string, details?: unknown): string {
  return JSON.stringify({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
}

export function dispatch(platform: Platform, rawBody: string, handlers: Record<string, Handler>): string {
  setPlatform(platform);
  const started = Date.now();
  const fetchBefore = platform.fetchCount?.() ?? 0;
  let fn = '';
  try {
    if (typeof rawBody !== 'string' || rawBody.length === 0) throw new ApiError('invalid-argument', 'Empty request');
    if (utf8Length(rawBody) > MAX_BODY_BYTES) throw new ApiError('invalid-argument', 'Request too large');
    let req: { fn?: unknown; data?: unknown; idToken?: unknown };
    try {
      req = JSON.parse(rawBody);
    } catch {
      throw new ApiError('invalid-argument', 'Malformed JSON');
    }
    if (!req || typeof req !== 'object' || typeof req.fn !== 'string') throw new ApiError('invalid-argument', 'fn is required');
    fn = req.fn;
    const handler = Object.prototype.hasOwnProperty.call(handlers, fn) ? handlers[fn] : undefined;
    if (!handler) throw new ApiError('not-found', 'Unknown function');

    // 署名・クレーム検証の直後、accounts:lookup（UrlFetch）の前に uid 単位の全体バケットと日次予算を確認する
    const nowMs = Date.now();
    const t = verifyIdToken(platform, req.idToken, nowMs, (v) => {
      consume(platform, v.uid, GLOBAL_LIMIT, nowMs);
      assertRequestBudget(platform, nowMs);
    });
    const ctx = {
      uid: t.uid,
      authTime: t.authTime,
      email: t.email,
      signInProvider: t.signInProvider,
      platform,
      db: dbFor(platform),
      now: () => new Date(),
    };
    // 関数別 → 失敗カウント対象は先に 1 回分を予約（strict）し、成功したら返却する
    for (const l of limitsFor(fn)) consume(platform, t.uid, l, nowMs);
    const failCounted = FAIL_COUNTED_FNS.has(fn);
    if (failCounted) consume(platform, t.uid, FAIL_LIMIT, nowMs);
    let result: unknown;
    try {
      result = handler(ctx, req.data ?? {});
    } catch (e) {
      if (failCounted && !(e instanceof ApiError)) release(platform, t.uid, FAIL_LIMIT, nowMs);
      throw e;
    }
    if (failCounted) release(platform, t.uid, FAIL_LIMIT, nowMs);
    platform.log('info', 'call', { fn, uid: t.uid, ms: Date.now() - started });
    return JSON.stringify({ ok: true, result: result === undefined ? null : result });
  } catch (e) {
    if (e instanceof ApiError) {
      platform.log('warn', 'call failed', { fn, code: e.code, ms: Date.now() - started });
      return fail(e.code, e.message, e.details);
    }
    // 予期しない例外：詳細はクライアントに返さず、エラー ID と例外名のみログに出す
    const errorId = platform.randomToken(6);
    platform.log('error', 'unexpected error', { fn, errorId, name: e instanceof Error ? e.name : typeof e });
    return fail('internal', `Internal error (${errorId})`);
  } finally {
    chargeBudget(platform, 'req', (platform.fetchCount?.() ?? 0) - fetchBefore, Date.now());
  }
}
