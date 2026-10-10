// G2 共通ヘルパ（functions/src/common.ts の同期版）。core 側の guards とは別に、業務ハンドラ共通の処理だけを持つ。
import { ApiError } from '../core/errors';
import { FieldValue, Timestamp, type DocumentReference, type Firestore, type Transaction } from '../core/firestore';
import { requireMember, writeAudit } from '../core/guards';
import { asId, validateObject, type Field, type Validated } from './validate';
import type { Member } from './types';

export { asId, Timestamp, FieldValue };

export const idField: Field = { spec: { k: 'id' } };
export const strField = (max?: number): Field => ({ spec: { k: 'str', max } });

export function parseInput(data: unknown, fields: Record<string, Field>, required: string[]): Validated {
  return validateObject(fields, data ?? {}, { required, label: 'request' });
}

/** 全 uid が当該家族の有効メンバーであることを確認 */
export function assertActiveMembers(db: Firestore, familyId: string, uids: string[], tx?: Transaction): void {
  const unique = Array.from(new Set(uids));
  for (const u of unique) {
    const ref = db.doc(`families/${familyId}/members/${u}`);
    const s = tx ? (tx.get(ref) as { exists: boolean; data(): unknown }) : ref.get();
    if (!s.exists || (s.data() as Member).status !== 'active') throw new ApiError('invalid-argument', 'Invalid member reference');
  }
}

export function activeMemberUids(db: Firestore, familyId: string): string[] {
  return db.collection(`families/${familyId}/members`).where('status', '==', 'active').get().docs.map((d) => d.id);
}

// ---------- JSON 変換 ----------
export function toJson(v: unknown): unknown {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.path === 'string' && 'parent' in o && typeof o.get === 'function') return o.path;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toJson(x)]));
  }
  return v;
}

// ---------- 楽観ロック ----------
export function conflict(current: Record<string, unknown>): ApiError {
  return new ApiError('aborted', 'Revision mismatch', { currentRevision: current.revision, current: toJson(current) });
}

export interface RevisionUpdate {
  db: Firestore;
  ref: DocumentReference;
  expectedRevision: number;
  uid: string;
  familyId: string;
  audit: { action: string; target: { kind: string; id: string } };
  /** 現在値から更新内容を作る。ここで ApiError を投げて拒否できる。tx で追加の読取（→書込み）も可能（対象ドキュメントの書込みはこの後）。 */
  build: (current: Record<string, unknown>, tx: Transaction) => { set: Record<string, unknown>; del?: string[] };
  /** トランザクション内の追加検証（有効メンバー確認など） */
  precheck?: (tx: Transaction) => void;
}

export function updateWithRevision(o: RevisionUpdate): number {
  return o.db.runTransaction((tx) => {
    requireMember(o, o.familyId, undefined, tx);
    if (o.precheck) o.precheck(tx);
    const snap = tx.get(o.ref) as { exists: boolean; data(): unknown };
    if (!snap.exists) throw new ApiError('not-found', 'Document not found');
    const cur = snap.data() as Record<string, unknown>;
    if (cur.revision !== o.expectedRevision) throw conflict(cur);
    const { set, del = [] } = o.build(cur, tx);
    const next = (cur.revision as number) + 1;
    const upd: Record<string, unknown> = { ...set, revision: next, updatedAt: FieldValue.serverTimestamp(), updatedBy: o.uid };
    for (const k of del) upd[k] = FieldValue.delete();
    tx.update(o.ref, upd);
    writeAudit(tx, o.familyId, { action: o.audit.action, actorUid: o.uid, target: o.audit.target });
    return next;
  });
}

// ---------- 通知ジョブの取消し ----------
export function skipPendingJobs(db: Firestore, filters: { familyId: string; recipientUid?: string; relatedId?: string }, note: string): number {
  let q = db.collection('notificationJobs').where('familyId', '==', filters.familyId).where('status', '==', 'pending');
  if (filters.recipientUid) q = q.where('recipientUid', '==', filters.recipientUid);
  if (filters.relatedId) q = q.where('relatedId', '==', filters.relatedId);
  const qs = q.get();
  const b = db.batch();
  for (const d of qs.docs) b.update(d.ref, { status: 'skipped', resultNote: note, updatedAt: FieldValue.serverTimestamp() });
  if (qs.size > 0) b.commit();
  return qs.size;
}

export function batchDeleteQuery(db: Firestore, col: string, familyId: string): void {
  const qs = db.collection(col).where('familyId', '==', familyId).get();
  if (qs.empty) return;
  const b = db.batch();
  qs.docs.forEach((d) => b.delete(d.ref));
  b.commit();
}

/** 参照先ドキュメントの実在を一括確認（getAll 1 回）。存在しないものがあれば invalid-argument */
export function assertDocsExist(db: Firestore, paths: string[], tx?: Transaction, label = 'Invalid reference'): void {
  const unique = Array.from(new Set(paths));
  if (unique.length === 0) return;
  const refs = unique.map((p) => db.doc(p));
  const snaps = tx ? tx.getAll(...refs) : db.getAll(...refs);
  if (snaps.some((x) => !x.exists)) throw new ApiError('invalid-argument', label);
}
