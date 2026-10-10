import { recordDeletion } from '../shared/deletions';
import { ApiError } from '../core/errors';
import type { CallContext, Handler } from '../core/context';
import { requireMember, writeAudit } from '../core/guards';
import { FieldValue, type Timestamp, type Transaction } from '../core/firestore';
import type { DoseOccurrence } from '../shared/types';
import { cancelScheduleReminderInternal, syncScheduleReminderInternal } from '../notify';
import {
  asRevision, applyPatch, assertPayloadComplete, DELETABLE_KINDS, DOC_KINDS, KIND_DEFS, resolveDocPath,
  validateDocPatch, validateEventPatch, validatePayloadPatch, type DocKind, type Field,
} from '../shared/validate';
import { idField as id, parseInput, assertActiveMembers, assertDocsExist, updateWithRevision, conflict } from '../shared/helpers';

function rawFields(extra: Record<string, Field>) {
  return { familyId: id, ...extra };
}

/** patch / payload はキー検証を専用バリデータで行うため、トップレベルでは生のまま取り出す */
function rawInput(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ApiError('invalid-argument', 'Invalid field: request');
  return data as Record<string, unknown>;
}
function onlyKeys(o: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ApiError('invalid-argument', `Invalid field: request.${k}`);
}

// ---------- updateEvent ----------
function updateEvent(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const raw = rawInput(data);
  onlyKeys(raw, ['familyId', 'childId', 'eventId', 'expectedRevision', 'patch']);
  const head = parseInput({ familyId: raw.familyId, childId: raw.childId, eventId: raw.eventId }, rawFields({ childId: id, eventId: id }), ['familyId', 'childId', 'eventId']).set as { familyId: string; childId: string; eventId: string };
  const expectedRevision = asRevision(raw.expectedRevision);
  const { v, payloadPatch } = validateEventPatch(raw.patch);
  requireMember(ctx, head.familyId);

  const ref = db.doc(`families/${head.familyId}/children/${head.childId}/events/${head.eventId}`);
  const rev = updateWithRevision({
    db, ref, expectedRevision, uid, familyId: head.familyId,
    audit: { action: 'event.update', target: { kind: 'event', id: head.eventId } },
    precheck: (tx) => {
      const cg = v.set.caregiverUid;
      if (typeof cg === 'string') assertActiveMembers(db, head.familyId, [cg], tx);
      // contextEventIds は同じ子どもの events に実在するものだけ
      const ctxIds = v.set.contextEventIds;
      if (Array.isArray(ctxIds)) {
        assertDocsExist(db, (ctxIds as string[]).map((e) => `families/${head.familyId}/children/${head.childId}/events/${e}`), tx, 'Invalid field: patch.contextEventIds');
      }
    },
    build: (cur) => {
      const set: Record<string, unknown> = { ...v.set };
      const del = [...v.del];
      const type = cur.type as string;
      if (cur.status === 'void') throw new ApiError('failed-precondition', 'Event is void', { reason: 'event-void' });
      if (type === 'medication_taken') {
        // 服薬記録は実施時刻・担当者を変えられない（note のみ変更可）
        if ([...Object.keys(set), ...del].some((k) => k !== 'note')) throw new ApiError('failed-precondition', 'medication_taken allows note changes only');
      }
      if (payloadPatch !== undefined) {
        if (type === 'medication_taken') throw new ApiError('failed-precondition', 'medication_taken payload is immutable');
        const pv = validatePayloadPatch(type, payloadPatch);
        const merged = applyPatch((cur.payload ?? {}) as Record<string, unknown>, pv);
        assertPayloadComplete(type, merged);
        set.payload = merged;
      }
      if (Array.isArray(set.contextEventIds) && (set.contextEventIds as string[]).includes(head.eventId)) {
        throw new ApiError('invalid-argument', 'Invalid field: patch.contextEventIds');
      }
      const occ = (set.occurredAt ?? cur.occurredAt) as Timestamp;
      const end = (del.includes('endedAt') ? undefined : (set.endedAt ?? cur.endedAt)) as Timestamp | undefined;
      if (end && end.toMillis() < occ.toMillis()) throw new ApiError('invalid-argument', 'Invalid field: patch.endedAt');
      return { set, del };
    },
  });
  return { revision: rev };
}

// ---------- setEventStatus ----------
/** medication_taken の void / 復元に合わせて doseOccurrence を同一トランザクションで戻す／再完了にする */
function syncDoseOccurrence(
  ctx: CallContext, tx: Transaction,
  p: { familyId: string; childId: string; eventId: string; status: 'active' | 'void' },
  cur: Record<string, unknown>,
): void {
  const occId = (cur.payload as { occurrenceId?: unknown } | undefined)?.occurrenceId;
  if (typeof occId !== 'string' || !occId) return;
  const occRef = ctx.db.doc(`families/${p.familyId}/children/${p.childId}/doseOccurrences/${occId}`);
  const snap = tx.get(occRef) as { exists: boolean; data(): unknown };
  if (!snap.exists) return;
  const occ = snap.data() as DoseOccurrence;
  const bump = { revision: occ.revision + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: ctx.uid };
  if (p.status === 'void') {
    if (occ.state === 'completed' && occ.completedEventId === p.eventId) {
      tx.update(occRef, { ...bump, state: 'planned', completedEventId: null, claimedBy: null, claimedAt: null });
    }
    return;
  }
  // 復元：occurrence が未完了（planned / 自分が claim 中）のときだけ再び completed に
  const takenByOther = occ.state === 'completed' && occ.completedEventId !== p.eventId;
  const free = occ.state === 'planned' || (occ.state === 'claimed' && occ.claimedBy === ctx.uid);
  if (occ.state === 'completed' && occ.completedEventId === p.eventId) return;
  if (takenByOther || !free) {
    throw new ApiError('failed-precondition', 'Dose occurrence is no longer available', { reason: 'occurrence-unavailable', state: occ.state });
  }
  tx.update(occRef, {
    ...bump, state: 'completed', completedEventId: p.eventId,
    claimedBy: occ.claimedBy ?? ctx.uid, claimedAt: occ.claimedAt ?? FieldValue.serverTimestamp(),
  });
}

function setEventStatus(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const raw = rawInput(data);
  const p = parseInput(raw, rawFields({
    childId: id, eventId: id,
    expectedRevision: { spec: { k: 'num', min: 1, int: true } },
    status: { spec: { k: 'enum', values: ['active', 'void'] } },
  }), ['familyId', 'childId', 'eventId', 'expectedRevision', 'status']).set as { familyId: string; childId: string; eventId: string; expectedRevision: number; status: 'active' | 'void' };
  requireMember(ctx, p.familyId);
  const ref = ctx.db.doc(`families/${p.familyId}/children/${p.childId}/events/${p.eventId}`);
  const rev = updateWithRevision({
    db: ctx.db, ref, expectedRevision: p.expectedRevision, uid, familyId: p.familyId,
    audit: { action: p.status === 'void' ? 'event.void' : 'event.restore', target: { kind: 'event', id: p.eventId } },
    build: (cur, tx) => {
      if (cur.type === 'medication_taken' && cur.status !== p.status) syncDoseOccurrence(ctx, tx, p, cur);
      return { set: { status: p.status } };
    },
  });
  return { revision: rev };
}

// ---------- updateDoc ----------
const kindEnum: Field = { spec: { k: 'enum', values: DOC_KINDS } };

function updateDoc(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const raw = rawInput(data);
  onlyKeys(raw, ['familyId', 'kind', 'childId', 'docId', 'expectedRevision', 'patch']);
  const p = parseInput({ familyId: raw.familyId, kind: raw.kind, childId: raw.childId, docId: raw.docId, expectedRevision: raw.expectedRevision },
    rawFields({ kind: kindEnum, childId: id, docId: id, expectedRevision: { spec: { k: 'num', min: 1, int: true } } }),
    ['familyId', 'kind', 'docId', 'expectedRevision']).set as { familyId: string; kind: DocKind; childId?: string; docId: string; expectedRevision: number };
  const v = validateDocPatch(p.kind, raw.patch);
  const path = resolveDocPath(p.kind, p.familyId, p.childId, p.docId);
  requireMember(ctx, p.familyId);
  const def = KIND_DEFS[p.kind];

  const rev = updateWithRevision({
    db, ref: db.doc(path), expectedRevision: p.expectedRevision, uid, familyId: p.familyId,
    audit: { action: `doc.update:${p.kind}`, target: { kind: p.kind, id: p.docId } },
    precheck: (tx) => {
      assertActiveMembers(db, p.familyId, v.uids, tx);
      // schedule.childId / relatedRefs[].childId は同一家族内の実在する子ども
      const childIds = new Set<string>();
      if (p.kind === 'schedule' && typeof v.set.childId === 'string') childIds.add(v.set.childId);
      if (Array.isArray(v.set.relatedRefs)) {
        for (const r of v.set.relatedRefs as { childId?: string }[]) if (typeof r.childId === 'string') childIds.add(r.childId);
      }
      assertDocsExist(db, [...childIds].map((c) => `families/${p.familyId}/children/${c}`), tx, 'Invalid child reference');
    },
    build: (cur) => {
      const set: Record<string, unknown> = { ...v.set };
      const del = [...v.del];
      const merged = applyPatch(cur, { set, del });
      def.check?.(merged);
      if (p.kind === 'schedule' && merged.allDay === true) {
        // 終日予定では時刻項目を持たせない
        for (const k of ['startAt', 'endAt']) if (merged[k] !== undefined && !del.includes(k)) del.push(k);
        delete set.startAt; delete set.endAt;
      }
      if (p.kind === 'schedule' && merged.allDay === false && merged.date !== undefined && !del.includes('date')) del.push('date');
      if (p.kind === 'handover' && set.status !== undefined && set.status !== cur.status) {
        if (set.status === 'resolved') { set.resolvedBy = uid; set.resolvedAt = FieldValue.serverTimestamp(); }
        else { set.resolvedBy = null; set.resolvedAt = null; }
      }
      if (p.kind === 'medication' && merged.startDate && merged.endDate && String(merged.endDate) < String(merged.startDate)) {
        throw new ApiError('invalid-argument', 'Invalid field: patch.endDate');
      }
      return { set, del };
    },
  });
  if (p.kind === 'schedule') {
    // Firestore トリガーの代替。失敗しても本処理は成功扱い（5分毎のスイープで補完）
    try { syncScheduleReminderInternal(db, p.familyId, p.docId); } catch {
      ctx.platform.log('warn', 'syncScheduleReminder failed', { familyId: p.familyId, scheduleId: p.docId });
    }
  }
  return { revision: rev };
}

// ---------- deleteDoc ----------
function deleteDoc(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const p = parseInput(data, rawFields({
    kind: kindEnum, childId: id, docId: id, expectedRevision: { spec: { k: 'num', min: 1, int: true } },
  }), ['familyId', 'kind', 'docId', 'expectedRevision']).set as { familyId: string; kind: DocKind; childId?: string; docId: string; expectedRevision: number };
  if (!DELETABLE_KINDS.includes(p.kind)) throw new ApiError('failed-precondition', 'This kind cannot be deleted');
  const path = resolveDocPath(p.kind, p.familyId, p.childId, p.docId);
  requireMember(ctx, p.familyId);
  const ref = db.doc(path);
  db.runTransaction((tx) => {
    requireMember(ctx, p.familyId, undefined, tx);
    const s = tx.get(ref) as { exists: boolean; data(): unknown };
    if (!s.exists) throw new ApiError('not-found', 'Document not found');
    const cur = s.data() as Record<string, unknown>;
    if (cur.revision !== p.expectedRevision) throw conflict(cur);
    recordDeletion(db, tx, path);
    tx.delete(ref);
    writeAudit(tx, p.familyId, { action: `doc.delete:${p.kind}`, actorUid: uid, target: { kind: p.kind, id: p.docId } });
  });
  if (p.kind === 'handover') db.recursiveDelete(db.collection(`${path}/acks`)); // 確認(ack)も削除
  if (p.kind === 'schedule') {
    try { cancelScheduleReminderInternal(db, p.familyId, p.docId); } catch {
      ctx.platform.log('warn', 'cancelScheduleReminder failed', { familyId: p.familyId, scheduleId: p.docId });
    }
  }
  return { ok: true as const };
}

export const handlers: Record<string, Handler> = { updateEvent, setEventStatus, updateDoc, deleteDoc };
