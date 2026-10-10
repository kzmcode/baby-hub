// GAS Web アプリ（docs/gas/architecture.md 6章）の型付きラッパ。エラーは ApiError に正規化
import { auth } from './firebase';
import type { EventType } from '../types/models';

export type ApiErrorCode =
  | 'unauthenticated' | 'permission-denied' | 'invalid-argument' | 'not-found' | 'failed-precondition'
  | 'aborted' | 'already-exists' | 'resource-exhausted' | 'unavailable' | 'internal' | 'unknown';

export class ApiError extends Error {
  code: ApiErrorCode;
  details?: unknown;
  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
  /** 版不一致（競合）か */
  get isConflict(): boolean { return this.code === 'aborted'; }
  /** 競合時のサーバー側最新（details: { currentRevision, current }） */
  get conflict(): { currentRevision: number; current: unknown } | null {
    const d = this.details as { currentRevision?: number; current?: unknown } | undefined;
    return this.code === 'aborted' && d && typeof d.currentRevision === 'number'
      ? { currentRevision: d.currentRevision, current: d.current }
      : null;
  }
}

const MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  unauthenticated: 'ログインが必要です。',
  'permission-denied': 'この操作を行う権限がありません。',
  'invalid-argument': '入力内容を確認してください。',
  'not-found': '対象が見つかりません。',
  'failed-precondition': '現在の状態ではこの操作はできません。',
  aborted: '他の人が先に更新しました。内容を確認してください。',
  'already-exists': 'すでに存在します。',
  'resource-exhausted': '回数の上限に達しました。しばらくしてからお試しください。',
  unavailable: '通信できません。接続を確認してください。',
};

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const err = e as { code?: string; message?: string; details?: unknown };
  const code = (err?.code ?? 'unknown').replace(/^functions\//, '') as ApiErrorCode;
  // サーバーの message は入力値を含まない定型文の想定。無ければ既定文言
  return new ApiError(code, err?.message || MESSAGES[code] || '処理に失敗しました。', err?.details);
}

/** エラーをユーザー向け日本語文言にする（サーバー message が英語等でも定型文を優先） */
export function apiErrorMessage(e: unknown): string {
  const a = toApiError(e);
  const wait = rateLimitWaitSec(a);
  if (wait !== null) return wait > 0 ? `操作が多すぎます。${wait}秒ほど待ってからもう一度お試しください。` : '操作が多すぎます。しばらく待ってからもう一度お試しください。';
  const byReason = reasonMessage(a);
  if (byReason) return byReason;
  return MESSAGES[a.code] ?? a.message;
}

/** GAS が details.reason で返す個別の理由に対応する文言（無ければ null） */
export function reasonMessage(e: { code: string; details?: unknown }): string | null {
  const reason = (e.details as { reason?: unknown } | undefined)?.reason;
  if (e.code === 'unavailable' && reason === 'daily-budget') return '本日の利用上限に達しました。時間をおいてお試しください。';
  if (e.code === 'unavailable' && reason === 'keys-refreshing') return '認証情報を更新中です。少し待ってから再試行してください。';
  if (reason === 'auth-delete-failed') return 'アカウント削除の途中で失敗しました。再ログインしてもう一度削除してください。';
  return null;
}

/** 回数制限（resource-exhausted + details.reason='rate-limited'）なら待ち秒数（不明は 0）、違えば null */
export function rateLimitWaitSec(e: { code: string; details?: unknown }): number | null {
  const d = e.details as { reason?: string; retryAfterSec?: unknown } | undefined;
  if (e.code !== 'resource-exhausted' || d?.reason !== 'rate-limited') return null;
  const n = Number(d.retryAfterSec);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

const TIMEOUT_MS = 30_000;

function endpoint(): string {
  const url = import.meta.env.VITE_GAS_ENDPOINT as string | undefined;
  if (!url) throw new ApiError('unavailable', 'サーバーの接続先（VITE_GAS_ENDPOINT）が設定されていません。');
  return url;
}

function isRecentAuth(e: ApiError): boolean {
  return (e.details as { reason?: string } | undefined)?.reason === 'recent-auth-required';
}

async function send<O>(name: string, data: unknown, forceRefresh: boolean): Promise<O> {
  const user = auth.currentUser;
  if (!user) throw new ApiError('unauthenticated', MESSAGES.unauthenticated!);
  let idToken: string;
  try {
    idToken = await user.getIdToken(forceRefresh);
  } catch {
    throw new ApiError('unavailable', MESSAGES.unavailable!);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let json: { ok?: boolean; result?: O; error?: { code?: string; message?: string; details?: unknown } };
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: name, data, idToken }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    json = await res.json();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('unavailable', MESSAGES.unavailable!);
  } finally {
    clearTimeout(timer);
  }
  if (!json || typeof json !== 'object' || typeof json.ok !== 'boolean') throw new ApiError('unavailable', MESSAGES.unavailable!);
  if (json.ok) return json.result as O;
  throw toApiError({ code: json.error?.code, message: json.error?.message, details: json.error?.details });
}

async function call<I, O>(name: string, data: I): Promise<O> {
  try {
    try {
      return await send<O>(name, data, false);
    } catch (e) {
      // 再認証直後は古いトークンの auth_time の可能性があるため、最新トークンで1回だけ再試行
      if (e instanceof ApiError && isRecentAuth(e)) return await send<O>(name, data, true);
      throw e;
    }
  } catch (e) {
    throw toApiError(e);
  }
}

export type DocKind = 'child' | 'healthProfile' | 'medication' | 'medicalVisit' | 'vaccination' | 'schedule' | 'task' | 'shopping' | 'handover' | 'contact';
export type DeletableKind = 'schedule' | 'task' | 'shopping' | 'handover' | 'contact';

export interface EventPatch {
  occurredAt?: string; endedAt?: string | null; caregiverUid?: string | null;
  payload?: Record<string, unknown>; note?: string | null; contextEventIds?: string[];
}
export interface ExportData {
  exportedAt: string; family: unknown; members: unknown[];
  children: { child: unknown; events: unknown[]; healthProfile: unknown; medications: unknown[]; doseOccurrences: unknown[]; medicalVisits: unknown[]; vaccinations: unknown[] }[];
  schedules: unknown[]; tasks: unknown[]; shopping: unknown[]; handovers: unknown[]; contacts: unknown[];
}
type Rev = { revision: number };
type Ok = { ok: true };

export const api = {
  createFamily: (i: { familyName: string; displayName: string; child: { nickname: string; birthDate?: string; dueDate?: string; isSample?: boolean } }) =>
    call<typeof i, { familyId: string; childId: string }>('createFamily', i),
  createInvite: (i: { familyId: string }) => call<typeof i, { inviteId: string; token: string; expiresAt: string }>('createInvite', i),
  revokeInvite: (i: { familyId: string; inviteId: string }) => call<typeof i, Ok>('revokeInvite', i),
  previewInvite: (i: { token: string }) => call<typeof i, { familyName: string; inviterName: string; role: string; expiresAt: string }>('previewInvite', i),
  acceptInvite: (i: { token: string; displayName: string }) => call<typeof i, { familyId: string }>('acceptInvite', i),
  leaveFamily: (i: { familyId: string }) => call<typeof i, Ok>('leaveFamily', i),
  /** 管理者移譲の提案（再認証必須）。相手の承諾で成立する2段階方式 */
  transferOwnership: (i: { familyId: string; toUid: string }) => call<typeof i, { pending: true; expiresAt: string }>('transferOwnership', i),
  /** 受け手が承諾（再認証必須） */
  acceptOwnershipTransfer: (i: { familyId: string }) => call<typeof i, Ok>('acceptOwnershipTransfer', i),
  /** 提案者の取消し、または受け手の辞退 */
  cancelOwnershipTransfer: (i: { familyId: string }) => call<typeof i, Ok>('cancelOwnershipTransfer', i),
  removeMember: (i: { familyId: string; uid: string }) => call<typeof i, Ok>('removeMember', i),
  updateEvent: (i: { familyId: string; childId: string; eventId: string; expectedRevision: number; patch: EventPatch }) => call<typeof i, Rev>('updateEvent', i),
  setEventStatus: (i: { familyId: string; childId: string; eventId: string; expectedRevision: number; status: 'active' | 'void' }) => call<typeof i, Rev>('setEventStatus', i),
  updateDoc: (i: { familyId: string; kind: DocKind; childId?: string; docId: string; expectedRevision: number; patch: Record<string, unknown> }) => call<typeof i, Rev>('updateDoc', i),
  deleteDoc: (i: { familyId: string; kind: DeletableKind; childId?: string; docId: string; expectedRevision: number }) => call<typeof i, Ok>('deleteDoc', i),
  createDoseOccurrence: (i: { familyId: string; childId: string; medicationId: string; plannedAt?: string }) => call<typeof i, { occurrenceId: string }>('createDoseOccurrence', i),
  claimDose: (i: { familyId: string; childId: string; occurrenceId: string }) => call<typeof i, { state: string; claimedBy: string }>('claimDose', i),
  releaseDose: (i: { familyId: string; childId: string; occurrenceId: string }) => call<typeof i, Ok>('releaseDose', i),
  completeDose: (i: { familyId: string; childId: string; occurrenceId: string; eventId: string; occurredAt: string; amount?: number; unit?: string; note?: string }) =>
    call<typeof i, { eventId: string; alreadyCompleted: boolean }>('completeDose', i),
  skipDose: (i: { familyId: string; childId: string; occurrenceId: string; reason?: string }) => call<typeof i, Ok>('skipDose', i),
  exportFamilyData: (i: { familyId: string }) => call<typeof i, ExportData>('exportFamilyData', i),
  deleteFamily: (i: { familyId: string; confirmName: string }) => call<typeof i, Ok>('deleteFamily', i),
  deleteAccount: () => call<Record<string, never>, Ok>('deleteAccount', {}),
  registerDevice: (i: { deviceId: string; fcmToken: string; platform: 'ios' | 'android' | 'desktop' | 'other' }) => call<typeof i, Ok>('registerDevice', i),
  notifyHandoverCreated: (i: { familyId: string; handoverId: string }) => call<typeof i, unknown>('notifyHandoverCreated', i),
  syncScheduleReminder: (i: { familyId: string; scheduleId: string }) => call<typeof i, unknown>('syncScheduleReminder', i),
  sendTestNotification: () => call<Record<string, never>, { sent: number }>('sendTestNotification', {}),
};

export type { EventType };
