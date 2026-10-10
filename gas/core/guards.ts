import type { Member, Role, Family } from '../shared/types';
import type { CallContext } from './context';
import { getDb, getPlatform } from './context';
import { ApiError } from './errors';
import { FieldValue } from './firestore';
import type { Firestore, Transaction, WriteBatch } from './firestore';

export { getPlatform, getDb };

/** members/{uid}.status==='active'、roles 指定時は role も確認。family も返す */
export function requireMember(ctx: Pick<CallContext, "db" | "uid">, familyId: string, roles?: Role[], tx?: Transaction): { member: Member; family: Family } {
  const lock = ctx.db.doc(`system/accountDeletion/users/${ctx.uid}`);
  if ((tx ? tx.get(lock) : lock.get()).exists) throw new ApiError('permission-denied', 'Account deletion in progress');
  const [mSnap, fSnap] = (tx ?? ctx.db).getAll(
    ctx.db.doc(`families/${familyId}/members/${ctx.uid}`),
    ctx.db.doc(`families/${familyId}`),
  );
  const member = mSnap!.data() as Member | undefined;
  if (!mSnap!.exists || !member || member.status !== 'active') throw new ApiError('permission-denied', 'Not an active member');
  if (roles && !roles.includes(member.role)) throw new ApiError('permission-denied', 'Insufficient role');
  if (!fSnap!.exists) throw new ApiError('not-found', 'Family not found');
  const family = fSnap!.data() as Family;
  if (family.status !== 'active' || (member.role === 'owner' && family.ownerUid !== ctx.uid)) throw new ApiError('permission-denied', 'Family unavailable');
  return { member, family };
}

export function isRecentAuth(authTimeSec: unknown, nowMs: number, maxSec = 300): boolean {
  return typeof authTimeSec === 'number' && authTimeSec > 0 && nowMs / 1000 - authTimeSec <= maxSec && authTimeSec <= nowMs / 1000 + 60;
}

export function assertRecentAuth(ctx: CallContext, maxAgeSec = 300): void {
  if (!isRecentAuth(ctx.authTime, ctx.now().getTime(), maxAgeSec)) {
    throw new ApiError('failed-precondition', 'Recent sign-in required', { reason: 'recent-auth-required' });
  }
}

export interface AuditEntry {
  action: string;
  actorUid: string;
  target?: { kind: string; id: string };
}

/** db 直接、またはトランザクション／バッチの一部として監査ログを書く */
export function writeAudit(dbOrTx: Firestore | Transaction | WriteBatch, familyId: string, entry: AuditEntry): void {
  const db = 'firestore' in dbOrTx ? (dbOrTx as Transaction).firestore : (dbOrTx as Firestore);
  const ref = db.collection(`families/${familyId}/auditLogs`).doc();
  const data: Record<string, unknown> = { action: entry.action, actorUid: entry.actorUid, at: FieldValue.serverTimestamp() };
  if (entry.target) data.target = entry.target;
  if (dbOrTx === db) ref.set(data);
  else (dbOrTx as Transaction | WriteBatch).set(ref, data);
}
