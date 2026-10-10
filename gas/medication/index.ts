import { ApiError } from '../core/errors';
import type { CallContext, Handler } from '../core/context';
import { requireMember, writeAudit } from '../core/guards';
import { FieldValue, Timestamp, type DocumentReference, type Transaction } from '../core/firestore';
import { idField as id, parseInput } from '../shared/helpers';
import type { DoseOccurrence, Medication } from '../shared/types';

const base = { familyId: id, childId: id };
const occPath = (f: string, c: string, o: string) => `families/${f}/children/${c}/doseOccurrences/${o}`;

function createDoseOccurrence(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const p = parseInput(data, { ...base, medicationId: id, plannedAt: { spec: { k: 'iso' } } }, ['familyId', 'childId', 'medicationId']).set as
    { familyId: string; childId: string; medicationId: string; plannedAt?: Timestamp };
  requireMember(ctx, p.familyId);
  return ctx.db.runTransaction((tx) => {
    requireMember(ctx, p.familyId, undefined, tx);
    const med = tx.get(ctx.db.doc(`families/${p.familyId}/children/${p.childId}/medications/${p.medicationId}`));
    if (!med.exists) throw new ApiError('not-found', 'Medication not found');
    if ((med.data() as Medication).status !== 'active') throw new ApiError('failed-precondition', 'Medication is not active');
    // 同じ (medicationId, plannedAt) の未完了 occurrence があればそれを返す（重複防止）
    const query = ctx.db.collection(`families/${p.familyId}/children/${p.childId}/doseOccurrences`)
      .where('medicationId', '==', p.medicationId).where('plannedAt', '==', p.plannedAt ?? null);
    const dup = tx.get(query).docs.find((d) => d.get('state') === 'planned' || d.get('state') === 'claimed');
    if (dup) return { occurrenceId: dup.id };
    const ref = ctx.db.collection(`families/${p.familyId}/children/${p.childId}/doseOccurrences`).doc();
    const now = FieldValue.serverTimestamp();
    tx.set(ref, {
      medicationId: p.medicationId, plannedAt: p.plannedAt ?? null, state: 'planned', claimedBy: null, claimedAt: null,
      completedEventId: null, revision: 1, createdAt: now, updatedAt: now, createdBy: uid, updatedBy: uid,
  });
  writeAudit(tx, p.familyId, { action: 'dose.create', actorUid: uid, target: { kind: 'doseOccurrence', id: ref.id } });
  return { occurrenceId: ref.id };
  });
}

function loadOcc(tx: Transaction, ref: DocumentReference): DoseOccurrence {
  const s = tx.get(ref) as { exists: boolean; data(): unknown };
  if (!s.exists) throw new ApiError('not-found', 'Occurrence not found');
  return s.data() as DoseOccurrence;
}
const bump = (uid: string, occ: DoseOccurrence, extra: Record<string, unknown>) => ({
  ...extra, revision: occ.revision + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
});

function claimDose(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const p = parseInput(data, { ...base, occurrenceId: id }, ['familyId', 'childId', 'occurrenceId']).set as { familyId: string; childId: string; occurrenceId: string };
  requireMember(ctx, p.familyId);
  const ref = ctx.db.doc(occPath(p.familyId, p.childId, p.occurrenceId));
  return ctx.db.runTransaction((tx) => {
    requireMember(ctx, p.familyId, undefined, tx);
    const occ = loadOcc(tx, ref);
    if (occ.state === 'claimed') {
      if (occ.claimedBy === uid) return { state: 'claimed' as const, claimedBy: uid };
      throw new ApiError('failed-precondition', 'Already claimed by another member', { claimedBy: occ.claimedBy });
    }
    if (occ.state !== 'planned') throw new ApiError('failed-precondition', 'Occurrence is not claimable', { state: occ.state });
    tx.update(ref, bump(uid, occ, { state: 'claimed', claimedBy: uid, claimedAt: FieldValue.serverTimestamp() }));
    writeAudit(tx, p.familyId, { action: 'dose.claim', actorUid: uid, target: { kind: 'doseOccurrence', id: p.occurrenceId } });
    return { state: 'claimed' as const, claimedBy: uid };
  });
}

function releaseDose(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const p = parseInput(data, { ...base, occurrenceId: id }, ['familyId', 'childId', 'occurrenceId']).set as { familyId: string; childId: string; occurrenceId: string };
  requireMember(ctx, p.familyId);
  const ref = ctx.db.doc(occPath(p.familyId, p.childId, p.occurrenceId));
  ctx.db.runTransaction((tx) => {
    requireMember(ctx, p.familyId, undefined, tx);
    const occ = loadOcc(tx, ref);
    if (occ.state === 'planned') return;
    if (occ.state !== 'claimed') throw new ApiError('failed-precondition', 'Occurrence is not claimed', { state: occ.state });
    if (occ.claimedBy !== uid) throw new ApiError('permission-denied', 'Claimed by another member', { claimedBy: occ.claimedBy });
    tx.update(ref, bump(uid, occ, { state: 'planned', claimedBy: null, claimedAt: null }));
    writeAudit(tx, p.familyId, { action: 'dose.release', actorUid: uid, target: { kind: 'doseOccurrence', id: p.occurrenceId } });
  });
  return { ok: true as const };
}

function completeDose(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const p = parseInput(data, {
    ...base, occurrenceId: id, eventId: id,
    occurredAt: { spec: { k: 'iso' } },
    amount: { spec: { k: 'num', min: 0, max: 100000 } },
    unit: { spec: { k: 'str', max: 50 } },
    note: { spec: { k: 'text' } },
  }, ['familyId', 'childId', 'occurrenceId', 'eventId', 'occurredAt']).set as
    { familyId: string; childId: string; occurrenceId: string; eventId: string; occurredAt: Timestamp; amount?: number; unit?: string; note?: string };
  requireMember(ctx, p.familyId);
  if (p.occurredAt.toMillis() > ctx.now().getTime() + 10 * 60 * 1000) throw new ApiError('invalid-argument', 'Invalid field: occurredAt');
  const ref = ctx.db.doc(occPath(p.familyId, p.childId, p.occurrenceId));
  const evRef = ctx.db.doc(`families/${p.familyId}/children/${p.childId}/events/${p.eventId}`);

  return ctx.db.runTransaction((tx) => {
    requireMember(ctx, p.familyId, undefined, tx);
    const occ = loadOcc(tx, ref);
    const evSnap = tx.get(evRef) as { exists: boolean };
    const medSnap = tx.get(ctx.db.doc(`families/${p.familyId}/children/${p.childId}/medications/${occ.medicationId}`)) as { exists: boolean; data(): unknown };
    if (occ.completedEventId) return { eventId: occ.completedEventId, alreadyCompleted: true };
    if (!medSnap.exists) throw new ApiError('not-found', 'Medication not found');
    if ((medSnap.data() as Medication).status !== 'active') throw new ApiError('failed-precondition', 'Medication is not active');
    if (occ.state !== 'planned' && occ.state !== 'claimed') throw new ApiError('failed-precondition', 'Occurrence cannot be completed', { state: occ.state });
    if (occ.state === 'claimed' && occ.claimedBy !== uid) throw new ApiError('failed-precondition', 'Claimed by another member', { claimedBy: occ.claimedBy });
    if (evSnap.exists) throw new ApiError('already-exists', 'Event id already used');

    const payload: Record<string, unknown> = { medicationId: occ.medicationId, occurrenceId: p.occurrenceId };
    if (p.amount !== undefined) payload.amount = p.amount;
    if (p.unit !== undefined) payload.unit = p.unit;
    const now = FieldValue.serverTimestamp();
    const ev: Record<string, unknown> = {
      schemaVersion: 1, childId: p.childId, type: 'medication_taken',
      occurredAt: p.occurredAt, recordedAt: Timestamp.now(),
      createdAt: now, updatedAt: now, createdBy: uid, updatedBy: uid,
      caregiverUid: uid, sourceRef: { kind: 'doseOccurrence', id: p.occurrenceId },
      payload, revision: 1, status: 'active',
    };
    if (p.note !== undefined) ev.note = p.note;
    tx.set(evRef, ev);
    tx.update(ref, bump(uid, occ, {
      state: 'completed', completedEventId: p.eventId,
      claimedBy: occ.claimedBy ?? uid, claimedAt: occ.claimedAt ?? FieldValue.serverTimestamp(),
    }));
    writeAudit(tx, p.familyId, { action: 'dose.complete', actorUid: uid, target: { kind: 'doseOccurrence', id: p.occurrenceId } });
    return { eventId: p.eventId, alreadyCompleted: false };
  });
}

function skipDose(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const p = parseInput(data, { ...base, occurrenceId: id, reason: { spec: { k: 'str', max: 200 } } }, ['familyId', 'childId', 'occurrenceId']).set as
    { familyId: string; childId: string; occurrenceId: string; reason?: string };
  requireMember(ctx, p.familyId);
  const ref = ctx.db.doc(occPath(p.familyId, p.childId, p.occurrenceId));
  ctx.db.runTransaction((tx) => {
    requireMember(ctx, p.familyId, undefined, tx);
    const occ = loadOcc(tx, ref);
    if (occ.state === 'skipped') return;
    if (occ.state !== 'planned' && occ.state !== 'claimed') throw new ApiError('failed-precondition', 'Occurrence cannot be skipped', { state: occ.state });
    if (occ.state === 'claimed' && occ.claimedBy !== uid) throw new ApiError('failed-precondition', 'Claimed by another member', { claimedBy: occ.claimedBy });
    const extra: Record<string, unknown> = { state: 'skipped' };
    if (p.reason !== undefined) extra.skipReason = p.reason;
    tx.update(ref, bump(uid, occ, extra));
    writeAudit(tx, p.familyId, { action: 'dose.skip', actorUid: uid, target: { kind: 'doseOccurrence', id: p.occurrenceId } });
  });
  return { ok: true as const };
}

export const handlers: Record<string, Handler> = { createDoseOccurrence, claimDose, releaseDose, completeDose, skipDose };
