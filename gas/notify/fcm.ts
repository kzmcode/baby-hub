// FCM HTTP v1 送信（同期）。1 トークン 1 リクエスト。送信関数は差し替え可能（テスト・エミュレータ用）。
import type { Platform } from '../core/platform/types';
import type { DocumentReference, Firestore } from '../core/firestore';
import { MAX_DEVICES_PER_USER } from '../shared/devices';
import { removeTokenRefIfOwned } from './device-tokens';
import { NOTIFY_TITLE } from './quiet';

export interface PushMessage { token: string; body: string; data: Record<string, string>; tag: string }
export type SendResult = { ok: true } | { ok: false; invalidToken: boolean; retryable: boolean; code: string };
export type Sender = (platform: Platform, msg: PushMessage) => SendResult;

export function linkFor(platform: Platform, path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https:\/\//.test(path)) return path;
  return `https://${platform.config.projectId}.web.app${path.startsWith('/') ? path : '/' + path}`;
}

/** FCM v1 のエラー応答から errorCode / status を取り出し、無効トークンかを判定する。 */
export function classifyFcmError(status: number, body: string): { code: string; invalidToken: boolean; retryable: boolean } {
  let rpcStatus = '';
  let errorCode = '';
  try {
    const e = JSON.parse(body)?.error;
    rpcStatus = typeof e?.status === 'string' ? e.status : '';
    for (const d of Array.isArray(e?.details) ? e.details : []) if (typeof d?.errorCode === 'string') errorCode = d.errorCode;
  } catch { /* 本文が JSON でない */ }
  const code = errorCode || rpcStatus || `HTTP_${status}`;
  const invalidToken = errorCode === 'UNREGISTERED' || errorCode === 'INVALID_ARGUMENT' || rpcStatus === 'INVALID_ARGUMENT' || rpcStatus === 'NOT_FOUND';
  const retryable = !invalidToken && (status === 429 || status >= 500 || status === 401 || status === 403 || rpcStatus === 'UNAVAILABLE' || rpcStatus === 'INTERNAL');
  return { code, invalidToken, retryable };
}

export const httpSender: Sender = (platform, msg) => {
  const url = `https://fcm.googleapis.com/v1/projects/${platform.config.projectId}/messages:send`;
  const link = linkFor(platform, msg.data.url);
  const message = {
    token: msg.token,
    notification: { title: NOTIFY_TITLE, body: msg.body },
    data: msg.data,
    webpush: { notification: { title: NOTIFY_TITLE, body: msg.body, tag: msg.tag }, ...(link ? { fcmOptions: { link } } : {}) },
  };
  let res: { status: number; body: string };
  const headers: Record<string, string> = { Authorization: `Bearer ${platform.getAccessToken()}`, 'Content-Type': 'application/json' };
  if (!platform.config.emulator) headers['x-goog-user-project'] = platform.config.projectId;
  try {
    res = platform.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
    });
  } catch {
    return { ok: false, invalidToken: false, retryable: true, code: 'NETWORK' };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, ...classifyFcmError(res.status, res.body) };
};

/** FCM 無効（エミュレータ等）ではログのみで成功扱い（トークンは出さない）。 */
export const logOnlySender: Sender = (platform, msg) => {
  platform.log('info', 'fcm-disabled: skip send', { type: msg.data.type ?? '' });
  return { ok: true };
};

let override: Sender | null = null;
/** テスト用：送信関数を差し替える（null で解除） */
export function setSender(s: Sender | null): void { override = s; }
export function currentSender(platform: Platform): Sender {
  if (override) return override;
  return platform.config.fcmEnabled && !platform.config.emulator ? httpSender : logOnlySender;
}

export interface PushResult { devices: number; sent: number; failed: number; invalidRemoved: number; retryable: boolean }

/** ユーザーの pushEnabled な端末へ送信。無効トークンは devices から削除。本文は呼び出し側の定型文のみ。 */
export function sendToUser(db: Firestore, platform: Platform, uid: string, body: string, data: Record<string, string>, tag: string): PushResult {
  const qs = db.collection(`users/${uid}/devices`).limit(MAX_DEVICES_PER_USER).get();
  const targets: { ref: DocumentReference; token: string }[] = [];
  const seen = new Set<string>();
  for (const d of qs.docs) {
    const token = d.get('fcmToken');
    if (d.get('pushEnabled') !== false && typeof token === 'string' && token.length > 0 && !seen.has(token)) { seen.add(token); targets.push({ ref: d.ref, token }); }
  }
  const r: PushResult = { devices: targets.length, sent: 0, failed: 0, invalidRemoved: 0, retryable: false };
  const send = currentSender(platform);
  for (const t of targets) {
    const res = send(platform, { token: t.token, body, data, tag });
    if (res.ok) { r.sent++; continue; }
    r.failed++;
    if (res.invalidToken) {
      r.invalidRemoved++;
      try { t.ref.delete(); } catch { /* 既に無い */ }
      removeTokenRefIfOwned(db, uid, t.token);
    } else if (res.retryable) {
      r.retryable = true;
    }
    platform.log('warn', 'fcm send failed', { code: res.code });
  }
  return r;
}
