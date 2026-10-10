// families / account で共有するメンバー操作
import { ApiError } from '../core/errors';
import { FieldValue, type Firestore } from '../core/firestore';
import { requireMember, writeAudit } from '../core/guards';
import { skipPendingJobs } from './helpers';
import type { Member } from './types';

export const REMOVED_NAME = '退出したメンバー';

export function revokeActiveInvites(db: Firestore, familyId: string, onlyBy?: string): void {
  let q = db.collection('invites').where('familyId', '==', familyId).where('status', '==', 'active');
  if (onlyBy) q = q.where('createdBy', '==', onlyBy);
  const qs = q.get();
  if (qs.empty) return;
  const b = db.batch();
  for (const d of qs.docs) b.update(d.ref, { status: 'revoked' });
  b.commit();
}

export function deactivateMember(
  db: Firestore, familyId: string, targetUid: string, status: 'left' | 'removed', actorUid: string, auditAction: string, anonymize = false,
): void {
  db.runTransaction((tx) => {
    const { family } = requireMember({ db, uid: actorUid }, familyId, [status === 'removed' ? 'owner' : 'editor'], tx);
    if ((status === 'left' && actorUid !== targetUid) || (status === 'removed' && actorUid === targetUid)) throw new ApiError('permission-denied', 'Invalid member operation');
    const mref = db.doc(`families/${familyId}/members/${targetUid}`);
    const m = tx.get(mref) as { exists: boolean; data(): unknown };
    const active = tx.get(db.collection(`families/${familyId}/members`).where('status', '==', 'active')) as { size: number };
    if (!m.exists || (m.data() as Member).status !== 'active' || (m.data() as Member).role === 'owner') throw new ApiError('failed-precondition', 'Not an active member');
    const upd: Record<string, unknown> = { status, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (anonymize) upd.displayName = REMOVED_NAME;
    tx.update(mref, upd);
    tx.set(db.doc(`users/${targetUid}/familyRefs/${familyId}`), { familyId, status }, { merge: true });
    const famUpd: Record<string, unknown> = { memberCount: Math.max(0, active.size - 1), updatedAt: FieldValue.serverTimestamp() };
    // 退出・除外対象が移譲提案の相手または提案者なら、同一トランザクションで提案を削除する（古い提案が残らないように）
    const pend = family.pendingOwnerTransfer;
    if (pend && (pend.toUid === targetUid || pend.proposedBy === targetUid)) famUpd.pendingOwnerTransfer = FieldValue.delete();
    tx.update(db.doc(`families/${familyId}`), famUpd);
    writeAudit(tx, familyId, { action: auditAction, actorUid, target: { kind: 'member', id: targetUid } });
  });
  skipPendingJobs(db, { familyId, recipientUid: targetUid }, 'member-inactive');
  revokeActiveInvites(db, familyId, targetUid);
}
