// 通知（G3）: registerDevice / sendTestNotification / notifyHandoverCreated / syncScheduleReminder / 5分毎の延期分送信とスイープ
import { FieldValue, Timestamp, type DocumentReference, type Firestore } from '../core/firestore';
import { ApiError } from '../core/errors';
import type { CallContext, Handler } from '../core/context';
import { getDb, getPlatform, requireMember } from '../core/guards';
import type { Platform } from '../core/platform/types';
import type { Handover, NotificationJob, Schedule } from '../shared/types';
import { evictTokenFromOtherUser, tokenRefPath } from './device-tokens';
import { sendToUser } from './fcm';
import { sweepStaleDeletionLocks } from '../account/locks';
import { sweepDayCounters } from '../core/ratelimit';
import {
  LEASE_MS, MAX_ATTEMPTS, NOTIFY_TEXT, RETRY_DELAY_MS, decideDelivery, handoverJobId, reminderDueMs, scheduleJobId,
  textFor, urlFor, type QuietHours,
} from './quiet';

type JobDraft = Omit<NotificationJob, 'createdAt' | 'updatedAt'>;
export type ProcessResult = 'sent' | 'skipped' | 'failed' | 'deferred' | 'retry' | 'unclaimed';

// ---------- 共通 ----------
function activeMemberUids(db: Firestore, familyId: string): string[] {
  return db.collection(`families/${familyId}/members`).where('status', '==', 'active').get().docs.map((d) => d.id);
}

/** 決定的 ID で作成。既に存在すれば false（冪等）。 */
function createJob(db: Firestore, jobKey: string, job: JobDraft): boolean {
  const ref = db.doc(`notificationJobs/${jobKey}`);
  if (ref.get().exists) return false;
  try {
    ref.create({ ...job, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return true;
  } catch (e) {
    if (ref.get().exists) return false; // 競合: 他の呼び出しが先に作成
    throw e;
  }
}

// ---------- ジョブ作成 ----------
type HandoverDoc = Handover & { createdBy?: string; createdAt?: Timestamp };

/** 申し送り 1 件分のジョブを（無ければ）作成。作成したジョブID を返す。 */
function ensureHandoverJobs(db: Firestore, familyId: string, handoverId: string, h: HandoverDoc, active: string[], now: Date): string[] {
  if (h.status !== 'open') return [];
  const wanted = h.recipientUids?.length ? h.recipientUids : active;
  const recipients = wanted.filter((u) => u !== h.createdBy && active.includes(u));
  const created: string[] = [];
  for (const uid of new Set(recipients)) {
    const revision = h.revision ?? 1;
    const key = handoverJobId(handoverId, revision, uid);
    const ok = createJob(db, key, {
      familyId, type: 'handover', priority: h.priority === 'important' ? 'important' : 'normal',
      recipientUid: uid, dueAt: Timestamp.fromDate(now), status: 'pending', attempts: 0,
      relatedKind: 'handover', relatedId: handoverId, relatedRevision: revision,
    });
    if (ok) created.push(key);
  }
  return created;
}

function ensureScheduleJobs(db: Firestore, familyId: string, scheduleId: string, s: Schedule, active: string[]): { desired: Set<string>; created: string[] } {
  const startMs = (s.startAt as Timestamp).toMillis();
  const dueMs = reminderDueMs(startMs);
  const targets = s.assigneeUids?.length ? s.assigneeUids.filter((u) => active.includes(u)) : active;
  const desired = new Set<string>();
  const created: string[] = [];
  for (const uid of new Set(targets)) {
    const key = scheduleJobId(scheduleId, dueMs, uid);
    desired.add(key);
    const ok = createJob(db, key, {
      familyId, type: 'scheduleReminder', priority: 'normal', recipientUid: uid,
      dueAt: Timestamp.fromMillis(dueMs), status: 'pending', attempts: 0,
      relatedKind: 'schedule', relatedId: scheduleId, relatedRevision: s.revision ?? 1,
      startAt: Timestamp.fromMillis(startMs),
    });
    if (ok) created.push(key);
  }
  return { desired, created };
}

function syncSchedule(db: Firestore, familyId: string, scheduleId: string, nowMs: number): { action: 'created' | 'updated' | 'cancelled' | 'none'; created: string[] } {
  const after = db.doc(`families/${familyId}/schedules/${scheduleId}`).get().data() as Schedule | undefined;
  const valid = !!after && after.status === 'planned' && !after.allDay && !!after.startAt;
  let desired = new Set<string>();
  let created: string[] = [];
  if (valid && (after!.startAt as Timestamp).toMillis() > nowMs) {
    const r = ensureScheduleJobs(db, familyId, scheduleId, after!, activeMemberUids(db, familyId));
    desired = r.desired;
    created = r.created;
  }
  const pending = db.collection('notificationJobs')
    .where('familyId', '==', familyId).where('relatedId', '==', scheduleId).where('status', '==', 'pending').get();
  let cancelled = 0;
  for (const d of pending.docs) {
    if (d.get('relatedKind') !== 'schedule' || desired.has(d.id)) continue;
    d.ref.update({ status: 'skipped', resultNote: 'schedule-changed', leaseUntil: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    cancelled++;
  }
  let action: 'created' | 'updated' | 'cancelled' | 'none' = 'none';
  if (desired.size === 0) action = cancelled > 0 ? 'cancelled' : 'none';
  else if (created.length > 0) action = cancelled > 0 ? 'updated' : 'created';
  else if (cancelled > 0) action = 'updated';
  return { action, created };
}

/**
 * 管理者移譲の提案を相手へ通知する（定型文のみ）。ジョブ ID は提案時刻ごとに決定的（再提案は別ジョブ）。
 * 静穏時間・通知設定に関わらず即時送信を試みる。失敗しても例外は投げない（ジョブは pending のまま 5 分毎のトリガーが再試行）。
 */
export function enqueueOwnerTransferNotice(db: Firestore, platform: Platform, familyId: string, toUid: string, proposedAtMs: number, now: Date = new Date()): void {
  try {
    const key = `ownerTransfer_${familyId}_${toUid}_${proposedAtMs}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const created = createJob(db, key, {
      familyId, type: 'ownerTransfer', priority: 'important', recipientUid: toUid,
      dueAt: Timestamp.fromDate(now), status: 'pending', attempts: 0,
      relatedKind: 'family', relatedId: familyId, relatedRevision: 1,
    });
    if (created) processJob(db, platform, db.doc(`notificationJobs/${key}`), now);
  } catch (e) {
    platform.log('warn', 'ownerTransfer notice failed', { familyId, name: (e as Error).name });
  }
}

/** updateDoc(kind schedule) 等から呼ぶ。開始60分前ジョブの作成／更新／取消し。 */
export function syncScheduleReminderInternal(db: Firestore, familyId: string, scheduleId: string): 'created' | 'updated' | 'cancelled' | 'none' {
  return syncSchedule(db, familyId, scheduleId, Date.now()).action;
}

/** deleteDoc(schedule) から呼ぶ。予定が既に無い状態で pending ジョブを取り消す。 */
export function cancelScheduleReminderInternal(db: Firestore, familyId: string, scheduleId: string): void {
  syncSchedule(db, familyId, scheduleId, Date.now());
}

// ---------- ジョブ処理（claim → evaluate → 結果反映） ----------
function claim(db: Firestore, ref: DocumentReference, nowMs: number): NotificationJob | 'failed' | null {
  return db.runTransaction((tx) => {
    const s = tx.get(ref) as ReturnType<DocumentReference['get']>;
    if (!s.exists) return null;
    const j = s.data() as NotificationJob;
    if (j.status !== 'pending' || j.dueAt.toMillis() > nowMs) return null;
    if (j.leaseUntil && j.leaseUntil.toMillis() > nowMs) return null;
    const attempts = (j.attempts ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      tx.update(ref, { status: 'failed', resultNote: 'max-attempts', leaseUntil: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      return 'failed' as const;
    }
    tx.update(ref, { attempts, leaseUntil: Timestamp.fromMillis(nowMs + LEASE_MS), updatedAt: FieldValue.serverTimestamp() });
    return { ...j, attempts };
  });
}

type Outcome = { status: 'sent' | 'skipped'; note: string } | { status: 'defer'; until: Date } | { status: 'retry'; note: string };

function evaluate(db: Firestore, platform: Platform, jobKey: string, j: NotificationJob, now: Date): Outcome {
  const fam = db.doc(`families/${j.familyId}`).get();
  const mem = db.doc(`families/${j.familyId}/members/${j.recipientUid}`).get();
  const user = db.doc(`users/${j.recipientUid}`).get();
  if (!fam.exists || fam.get('status') !== 'active') return { status: 'skipped', note: 'family-unavailable' };
  if (!mem.exists || mem.get('status') !== 'active') return { status: 'skipped', note: 'member-inactive' };

  if (j.relatedKind === 'handover') {
    const h = db.doc(`families/${j.familyId}/handovers/${j.relatedId}`).get().data() as Handover | undefined;
    if (!h) return { status: 'skipped', note: 'related-missing' };
    if (h.status !== 'open') return { status: 'skipped', note: 'related-closed' };
    if (h.expiresAt && h.expiresAt.toMillis() <= now.getTime()) return { status: 'skipped', note: 'expired' };
  } else if (j.relatedKind === 'family') {
    const pend = fam.get('pendingOwnerTransfer') as { toUid?: string; expiresAt?: Timestamp } | null | undefined;
    if (!pend || pend.toUid !== j.recipientUid) return { status: 'skipped', note: 'related-closed' };
    if (!pend.expiresAt || pend.expiresAt.toMillis() <= now.getTime()) return { status: 'skipped', note: 'expired' };
  } else {
    const s = db.doc(`families/${j.familyId}/schedules/${j.relatedId}`).get().data() as Schedule | undefined;
    if (!s) return { status: 'skipped', note: 'related-missing' };
    if (s.status !== 'planned' || s.allDay || !s.startAt) return { status: 'skipped', note: 'related-closed' };
    if (s.startAt.toMillis() !== j.startAt?.toMillis()) return { status: 'skipped', note: 'schedule-changed' };
    if (s.startAt.toMillis() <= now.getTime()) return { status: 'skipped', note: 'already-started' };
  }

  const settings = user.get('settings') as { notify?: Record<string, boolean>; quietHours?: QuietHours } | undefined;
  const type = j.type === 'scheduleReminder' ? 'scheduleReminder' : j.type === 'ownerTransfer' ? 'ownerTransfer' : 'handover';
  const d = decideDelivery({ type, priority: j.priority, startMs: j.startAt?.toMillis() }, settings, now);
  if (d.status === 'skipped') return d;
  if (d.status === 'defer') return d;

  const r = sendToUser(db, platform, j.recipientUid, textFor(type, j.priority), { type: j.type, url: urlFor(type, j.relatedId), jobId: jobKey }, jobKey);
  if (r.devices === 0) return { status: 'skipped', note: 'no-device' };
  if (r.sent > 0) return { status: 'sent', note: 'ok' };
  if (r.retryable) return { status: 'retry', note: 'send-failed' };
  return { status: 'skipped', note: 'no-valid-token' };
}

export function processJob(db: Firestore, platform: Platform, ref: DocumentReference, now: Date = new Date()): ProcessResult {
  const c = claim(db, ref, now.getTime());
  if (c === null) return 'unclaimed';
  if (c === 'failed') return 'failed';
  const job = c;
  const upd = (data: Record<string, unknown>) => ref.update({ ...data, leaseUntil: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
  try {
    const o = evaluate(db, platform, ref.id, job, now);
    if (o.status === 'defer') {
      upd({ dueAt: Timestamp.fromDate(o.until), attempts: job.attempts - 1 });
      return 'deferred';
    }
    if (o.status === 'retry') {
      if (job.attempts >= MAX_ATTEMPTS) { upd({ status: 'failed', resultNote: o.note }); return 'failed'; }
      upd({ dueAt: Timestamp.fromMillis(now.getTime() + RETRY_DELAY_MS), resultNote: o.note });
      return 'retry';
    }
    upd({ status: o.status, resultNote: o.note, ...(o.status === 'sent' ? { sentAt: FieldValue.serverTimestamp() } : {}) });
    return o.status;
  } catch (e) {
    platform.log('error', 'processJob error', { jobId: ref.id, name: (e as Error).name });
    try {
      if (job.attempts >= MAX_ATTEMPTS) { upd({ status: 'failed', resultNote: 'error' }); return 'failed'; }
      upd({ dueAt: Timestamp.fromMillis(now.getTime() + RETRY_DELAY_MS), resultNote: 'error' });
    } catch { /* lease の期限切れで再試行される */ }
    return 'retry';
  }
}

// ---------- Web から呼ぶハンドラ ----------
function str(v: unknown, name: string, max = 128): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new ApiError('invalid-argument', `Invalid ${name}`);
  return v;
}
function id(v: unknown, name: string): string {
  const s = str(v, name, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new ApiError('invalid-argument', `Invalid ${name}`);
  return s;
}

import { MAX_DEVICES_PER_USER } from '../shared/devices';
export { MAX_DEVICES_PER_USER } from '../shared/devices';
const PLATFORMS = ['ios', 'android', 'desktop', 'other'] as const;
export function normalizePlatform(v: unknown): (typeof PLATFORMS)[number] {
  return typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v) ? (v as (typeof PLATFORMS)[number]) : 'other';
}

const registerDevice: Handler = (ctx, data) => {
  const d = (data ?? {}) as Record<string, unknown>;
  const deviceId = id(d.deviceId, 'deviceId');
  const fcmToken = str(d.fcmToken, 'fcmToken', 4096);
  const platform = normalizePlatform(d.platform);
  const col = ctx.db.collection(`users/${ctx.uid}/devices`);
  const ref = col.doc(deviceId);
  const revRef = ctx.db.doc(tokenRefPath(fcmToken));
  // 同じ fcmToken を持つ他 uid の端末登録を、逆引き文書で検出して削除する（トランザクション外。collectionGroup は使わない）
  const existing = revRef.get();
  const otherUid = existing.exists ? existing.get('uid') : undefined;
  if (typeof otherUid === 'string' && otherUid !== ctx.uid) evictTokenFromOtherUser(ctx.db, otherUid, fcmToken);
  ctx.db.runTransaction((tx) => {
    const lock = ctx.db.doc(`system/deviceRegistry/users/${ctx.uid}`);
    tx.get(lock);
    if (tx.get(ctx.db.doc(`system/accountDeletion/users/${ctx.uid}`)).exists) throw new ApiError('permission-denied', 'Account deletion in progress');
    const all = tx.get(col).docs;
    const mine = all.find((x) => x.id === deviceId);
    // 同一 fcmToken を持つ他の自端末ドキュメントは削除（重複排除。重複送信の防止）
    let others = all.filter((x) => x.id !== deviceId);
    const dups = others.filter((o) => o.get('fcmToken') === fcmToken);
    others = others.filter((o) => o.get('fcmToken') !== fcmToken);
    // 既存の過剰登録も整理し、最古の端末から削除する
    const ms = (x: (typeof all)[number]) => {
      const t = x.get('updatedAt') as { toMillis?: () => number } | undefined;
      return typeof t?.toMillis === 'function' ? t.toMillis() : 0;
    };
    others.sort((a, b) => ms(a) - ms(b));
    const trimmed = others.slice(0, Math.max(0, others.length - (MAX_DEVICES_PER_USER - 1)));
    // 逆引き文書：置き換え・削除される古いトークン分（自分のものだけ）を整理する。読取は書込みの前にまとめて行う
    const oldTokens = new Set<string>();
    for (const x of trimmed) { const t = x.get('fcmToken'); if (typeof t === 'string') oldTokens.add(t); }
    const prev = mine?.get('fcmToken');
    if (typeof prev === 'string' && prev !== fcmToken) oldTokens.add(prev);
    oldTokens.delete(fcmToken);
    const oldRefs = Array.from(oldTokens, (t) => ctx.db.doc(tokenRefPath(t)));
    const oldSnaps = oldRefs.length ? tx.getAll(...oldRefs) : [];

    for (const x of dups) tx.delete(x.ref);
    for (const x of trimmed) tx.delete(x.ref);
    oldSnaps.forEach((snap, i) => { if (snap.exists && snap.get('uid') === ctx.uid) tx.delete(oldRefs[i]!); });
    if (mine) {
      tx.update(ref, { fcmToken, platform, updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(ref, { fcmToken, platform, trusted: false, pushEnabled: true, updatedAt: FieldValue.serverTimestamp() });
    }
    tx.set(revRef, { uid: ctx.uid, deviceId, updatedAt: FieldValue.serverTimestamp() });
    tx.set(lock, { updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true as const };
};

const sendTestNotification: Handler = (ctx) => {
  const r = sendToUser(ctx.db, ctx.platform, ctx.uid, NOTIFY_TEXT.test, { type: 'test' }, `test-${ctx.uid}`);
  ctx.platform.log('info', 'sendTestNotification', { devices: r.devices, sent: r.sent });
  return { sent: r.sent };
};

const notifyHandoverCreated: Handler = (ctx, data) => {
  const familyId = id(data?.familyId, 'familyId');
  const handoverId = id(data?.handoverId, 'handoverId');
  requireMember(ctx, familyId);
  const h = ctx.db.doc(`families/${familyId}/handovers/${handoverId}`).get().data() as HandoverDoc | undefined;
  if (!h) throw new ApiError('not-found', 'Handover not found');
  if (h.createdBy !== ctx.uid) throw new ApiError('permission-denied', 'Only the author can notify');
  const now = ctx.now();
  const created = ensureHandoverJobs(ctx.db, familyId, handoverId, h, activeMemberUids(ctx.db, familyId), now);
  let sent = 0;
  for (const key of created) {
    // 静穏時間中は processJob が dueAt を静穏終了へ延期する
    if (processJob(ctx.db, ctx.platform, ctx.db.doc(`notificationJobs/${key}`), now) === 'sent') sent++;
  }
  ctx.platform.log('info', 'notifyHandoverCreated', { familyId, handoverId, queued: created.length, sent });
  return { queued: created.length, sent };
};

const syncScheduleReminder: Handler = (ctx, data) => {
  const familyId = id(data?.familyId, 'familyId');
  const scheduleId = id(data?.scheduleId, 'scheduleId');
  requireMember(ctx, familyId);
  const now = ctx.now();
  const r = syncSchedule(ctx.db, familyId, scheduleId, now.getTime());
  // 開始まで60分未満の予定は dueAt が既に過去なので、その場で処理する
  for (const key of r.created) {
    const ref = ctx.db.doc(`notificationJobs/${key}`);
    if (ref.get().get('dueAt').toMillis() <= now.getTime()) processJob(ctx.db, ctx.platform, ref, now);
  }
  ctx.platform.log('info', 'syncScheduleReminder', { familyId, scheduleId, action: r.action });
  return { action: r.action };
};

export const handlers: Record<string, Handler> = { registerDevice, sendTestNotification, notifyHandoverCreated, syncScheduleReminder };

// ---------- 5分毎: 延期分の送信 + スイープ ----------
export interface DispatchResult { sent: number; skipped: number; failed: number; deferred: number; swept: number }

const DISPATCH_BUDGET_MS = 4.5 * 60 * 1000; // GAS 6分制限に対する余裕
const SWEEP_INTERVAL_SEC = 540;             // スイープは約10分毎（読取削減）
export const SWEEP_HANDOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SWEEP_SCHEDULE_WINDOW_MS = 3 * 60 * 60 * 1000;

function sweep(db: Firestore, platform: Platform, startedMs: number, now: Date): number {
  let created = 0;
  const families = db.collection('families').where('status', '==', 'active').get();
  for (const fam of families.docs) {
    if (Date.now() - startedMs > DISPATCH_BUDGET_MS) break;
    const familyId = fam.id;
    try {
      const handovers = db.collection(`families/${familyId}/handovers`)
        .where('createdAt', '>=', Timestamp.fromMillis(now.getTime() - SWEEP_HANDOVER_WINDOW_MS)).get()
        .docs.filter((d) => d.get('status') === 'open' && (d.get('revision') ?? 1) <= 1); // 編集後の再通知を避けるため初版のみ補完
      const schedules = db.collection(`families/${familyId}/schedules`)
        .where('startAt', '>=', Timestamp.fromDate(now))
        .where('startAt', '<=', Timestamp.fromMillis(now.getTime() + SWEEP_SCHEDULE_WINDOW_MS)).get()
        .docs.filter((d) => d.get('status') === 'planned' && d.get('allDay') !== true);
      if (handovers.length === 0 && schedules.length === 0) continue;
      const active = activeMemberUids(db, familyId);
      for (const d of handovers) created += ensureHandoverJobs(db, familyId, d.id, d.data() as HandoverDoc, active, now).length;
      for (const d of schedules) created += ensureScheduleJobs(db, familyId, d.id, d.data() as Schedule, active).created.length;
    } catch (e) {
      platform.log('error', 'sweep family failed', { familyId, name: (e as Error).name });
    }
  }
  return created;
}

export function runDispatch(): DispatchResult {
  const db = getDb();
  const platform = getPlatform();
  const startedMs = Date.now();
  const res: DispatchResult = { sent: 0, skipped: 0, failed: 0, deferred: 0, swept: 0 };

  // 日次の後始末（約 6 時間に 1 回）：古い日次カウンタ、7 日以上残った削除ロック
  try {
    if (!platform.cacheGet('housekeeping')) {
      platform.cachePut('housekeeping', '1', 6 * 60 * 60 - 60);
      try { sweepDayCounters(platform, Date.now()); } catch (e) { platform.log('error', 'sweep counters failed', { name: (e as Error).name }); }
      try { sweepStaleDeletionLocks(db, platform, Date.now()); } catch (e) { platform.log('error', 'sweep locks failed', { name: (e as Error).name }); }
    }
  } catch { /* キャッシュ不可なら今回は行わない */ }

  // スイープで作ったジョブ（dueAt=now）も同じ実行で送れるよう、先にスイープする
  let doSweep = true;
  try {
    if (platform.cacheGet('notify.sweep')) doSweep = false;
    else platform.cachePut('notify.sweep', '1', SWEEP_INTERVAL_SEC);
  } catch { /* キャッシュ不可なら毎回実行 */ }
  if (doSweep) {
    try { res.swept = sweep(db, platform, startedMs, new Date()); }
    catch (e) { platform.log('error', 'sweep failed', { name: (e as Error).name }); }
  }

  const qs = db.collection('notificationJobs')
    .where('status', '==', 'pending').where('dueAt', '<=', Timestamp.now()).orderBy('dueAt').limit(100).get();
  for (const d of qs.docs) {
    if (Date.now() - startedMs > DISPATCH_BUDGET_MS) { platform.log('warn', 'dispatch budget exceeded'); break; }
    const r = processJob(db, platform, d.ref);
    if (r === 'sent') res.sent++;
    else if (r === 'skipped') res.skipped++;
    else if (r === 'failed') res.failed++;
    else if (r === 'deferred') res.deferred++;
  }
  platform.log('info', 'dispatchNotifications', { picked: qs.size, ...res });
  return res;
}

export type { CallContext };
