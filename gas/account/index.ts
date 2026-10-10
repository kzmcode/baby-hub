import { recordDeletion } from '../shared/deletions';
import { ApiError } from '../core/errors';
import type { CallContext, Handler } from '../core/context';
import { assertRecentAuth, requireMember, writeAudit } from '../core/guards';
import { FieldValue, type Firestore, type Transaction } from '../core/firestore';
import { invalidateAccountCache } from '../core/auth';
import { purgeDeviceTokenRefs } from '../notify/device-tokens';
import { idField as id, parseInput, toJson, skipPendingJobs, batchDeleteQuery } from '../shared/helpers';
import { REMOVED_NAME, revokeActiveInvites } from '../shared/family-ops';
import type { Family, Member } from '../shared/types';

// ---------- exportFamilyData ----------
function dumpCollection(db: Firestore, path: string, tx: Transaction) {
  return tx.get(db.collection(path)).docs.map((d) => ({ id: d.id, ...(toJson(d.data()) as object) }));
}

function exportFamilyData(ctx: CallContext, data: unknown) {
  const db = ctx.db;
  const { familyId } = parseInput(data, { familyId: id }, ['familyId']).set as { familyId: string };
  // 権限確認と全読取を 1 つの読み取り専用トランザクション（一貫したスナップショット）で行う。監査ログは読取り後に別書込み
  const out = db.runTransaction((tx) => {
    requireMember(ctx, familyId, undefined, tx);
    const fam = tx.get(db.doc(`families/${familyId}`));
    if (!fam.exists) throw new ApiError('not-found', 'Family not found');
    const base = `families/${familyId}`;
    const childDocs = tx.get(db.collection(`${base}/children`));
    const children = [];
    for (const c of childDocs.docs) {
      const cp = `${base}/children/${c.id}`;
      const hp = dumpCollection(db, `${cp}/healthProfiles`, tx);
      children.push({
        child: { id: c.id, ...(toJson(c.data()) as object) },
        events: dumpCollection(db, `${cp}/events`, tx),
        healthProfile: hp.find((h) => h.id === 'main') ?? null,
        medications: dumpCollection(db, `${cp}/medications`, tx),
        doseOccurrences: dumpCollection(db, `${cp}/doseOccurrences`, tx),
        medicalVisits: dumpCollection(db, `${cp}/medicalVisits`, tx),
        vaccinations: dumpCollection(db, `${cp}/vaccinations`, tx),
      });
    }
    const [members, schedules, tasks, shopping, handovers, contacts] =
      ['members', 'schedules', 'tasks', 'shopping', 'handovers', 'contacts'].map((c) => dumpCollection(db, `${base}/${c}`, tx));
    return {
      exportedAt: ctx.now().toISOString(),
      family: { id: familyId, ...(toJson(fam.data()) as object) },
      members, children, schedules, tasks, shopping, handovers, contacts,
    };
  }, { readOnly: true });
  writeAudit(db, familyId, { action: 'family.export', actorUid: ctx.uid, target: { kind: 'family', id: familyId } });
  ctx.platform.log('info', 'exportFamilyData', { familyId });
  return out;
}

// ---------- 家族削除 ----------
const familyDeletionPath = (familyId: string) => `system/familyDeletion/families/${familyId}`;

/**
 * 家族の削除本体（再実行可能）。先に全メンバーの familyRefs を removed にし（メンバーリストは
 * system/familyDeletion/families/{fid} に保存済み）、それから再帰削除する。途中で中断しても、家族文書が無い状態でも
 * 記録から再実行・後始末できる。Authorization and the deleting marker are committed by the caller.
 */
function purgeFamily(db: Firestore, familyId: string): void {
  const famRef = db.doc(`families/${familyId}`);
  const recRef = db.doc(familyDeletionPath(familyId));
  const rec = recRef.get();
  const memberUids = new Set<string>((rec.exists ? (rec.get('members') as string[] | undefined) : undefined) ?? []);
  for (const d of famRef.collection('members').get().docs) memberUids.add(d.id);
  if (memberUids.size > 0) {
    const b = db.batch();
    for (const u of memberUids) b.set(db.doc(`users/${u}/familyRefs/${familyId}`), { familyId, status: 'removed' }, { merge: true });
    b.commit();
  }
  for (const col of ['invites', 'notificationJobs']) batchDeleteQuery(db, col, familyId);
  db.recursiveDelete(famRef);
  for (const u of memberUids) db.doc(`users/${u}/familyRefs/${familyId}`).delete();
  recRef.delete();
}

/** 削除記録（メンバーリスト）を保存する。既存の記録とはメンバーの和集合を取る */
function saveDeletionRecord(db: Firestore, tx: Transaction, familyId: string, ownerUid: string, members: string[], existing: { exists: boolean; get(f: string): unknown }): void {
  const prev = (existing.exists ? (existing.get('members') as string[] | undefined) : undefined) ?? [];
  tx.set(db.doc(familyDeletionPath(familyId)), {
    ownerUid, members: Array.from(new Set([...prev, ...members])),
    startedAt: existing.exists ? existing.get('startedAt') : FieldValue.serverTimestamp(),
  });
}

function deleteFamily(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const { familyId, confirmName } = parseInput(data, { familyId: id, confirmName: { spec: { k: 'str' } } }, ['familyId', 'confirmName']).set as { familyId: string; confirmName: string };
  assertRecentAuth(ctx);
  ctx.db.runTransaction((tx) => {
    const ref = ctx.db.doc(`families/${familyId}`);
    const f = tx.get(ref).data() as Family | undefined;
    const rec = tx.get(ctx.db.doc(familyDeletionPath(familyId)));
    if (!f) {
      // 家族文書が既に無くても、自分が開始した削除の記録があれば後始末を再実行できる
      if (rec.exists && rec.get('ownerUid') === uid) return;
      throw new ApiError('not-found', 'Family not found');
    }
    if (!(f.status === 'deleting' && f.ownerUid === uid)) requireMember(ctx, familyId, ['owner'], tx);
    const members = tx.get(ref.collection('members'));
    if (confirmName !== f.name) throw new ApiError('failed-precondition', 'Confirmation name mismatch', { reason: 'confirm-mismatch' });
    recordDeletion(ctx.db, tx, ref.path);
    for (const m of members.docs) recordDeletion(ctx.db, tx, `users/${m.id}/familyRefs/${familyId}`);
    saveDeletionRecord(ctx.db, tx, familyId, f.ownerUid, members.docs.map((m) => m.id), rec);
    tx.update(ref, { status: 'deleting', updatedAt: FieldValue.serverTimestamp() });
  });
  purgeFamily(ctx.db, familyId);
  ctx.platform.log('info', 'deleteFamily', { familyId });
  return { ok: true as const };
}

// ---------- アカウント削除 ----------
/** Identity Toolkit accounts:delete を所有者 OAuth トークンで呼ぶ（Admin SDK 相当）。 */
function deleteAuthUser(ctx: CallContext, uid: string): void {
  const p = ctx.platform;
  const { projectId, identityBaseUrl } = p.config;
  const res = p.fetch(`${identityBaseUrl}/v1/projects/${projectId}/accounts:delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.getAccessToken()}`,
      'x-goog-user-project': projectId,
    },
    body: JSON.stringify({ localId: uid }),
  });
  if (res.status >= 200 && res.status < 300) return;
  // 既に削除済み（再実行）は成功扱い
  if (res.body.includes('USER_NOT_FOUND')) return;
  p.log('error', 'accounts:delete failed', { status: res.status });
  // 削除ロックは残す。本人が再ログインして再度アカウント削除を実行すると完了する
  throw new ApiError('internal', 'Failed to delete auth user', { reason: 'auth-delete-failed' });
}

function deleteAccount(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  parseInput(data, {}, []);
  assertRecentAuth(ctx);

  const plans = db.runTransaction((tx) => {
    const lock = db.doc(`system/accountDeletion/users/${uid}`);
    const lockSnap = tx.get(lock);
    const orphanRecs = tx.get(db.collection('system/familyDeletion/families').where('ownerUid', '==', uid));
    const refs = tx.get(db.collection(`users/${uid}/familyRefs`));
    const owned = tx.get(db.collection('families').where('ownerUid', '==', uid));
    const ids = new Set([...refs.docs.map((d) => d.id), ...owned.docs.map((d) => d.id)]);
    const plans: { familyId: string; sole: boolean; members: string[]; count: number; orphan?: boolean; clearTransfer?: boolean; rec?: { exists: boolean; get(f: string): unknown } }[] = [];
    for (const familyId of ids) {
      const m = tx.get(db.doc(`families/${familyId}/members/${uid}`)).data() as Member | undefined;
      const fam = tx.get(db.doc(`families/${familyId}`)).data() as Family | undefined;
      if (!fam) continue;
      const members = tx.get(db.collection(`families/${familyId}/members`));
      const others = members.docs.filter((d) => d.id !== uid && d.get('status') === 'active').length;
      const owner = fam.ownerUid === uid;
      if (owner && others > 0) throw new ApiError('failed-precondition', 'Transfer ownership or delete the family first', { reason: 'owner-has-members', familyId });
      if (m?.status === 'active' || (owner && fam.status === 'deleting')) {
        plans.push({
          familyId, sole: owner && others === 0, members: members.docs.map((d) => d.id), count: others,
          clearTransfer: fam.pendingOwnerTransfer?.toUid === uid || fam.pendingOwnerTransfer?.proposedBy === uid,
          rec: tx.get(db.doc(familyDeletionPath(familyId))),
        });
      }
    }
    // 家族文書が既に消えているが削除記録が残っている（自分が開始した家族削除の中断）：記録から後始末を再実行する
    for (const r of orphanRecs.docs) {
      if (ids.has(r.id)) continue;
      plans.push({ familyId: r.id, sole: true, orphan: true, members: (r.get('members') as string[] | undefined) ?? [], count: 0 });
    }
    // No writes occur until every family has been checked. The lock also conflicts with concurrent joins/creates.
    // createdAt は最初のロック作成時刻（7 日以上残ったロックの後始末用。再実行しても更新しない）
    const startedAt = FieldValue.serverTimestamp();
    tx.set(lock, { startedAt, createdAt: lockSnap.exists && lockSnap.get('createdAt') ? lockSnap.get('createdAt') : startedAt });
    recordDeletion(db, tx, `users/${uid}`);
    for (const p of plans) {
      recordDeletion(db, tx, `users/${uid}/familyRefs/${p.familyId}`);
      if (p.sole) {
        recordDeletion(db, tx, `families/${p.familyId}`);
        for (const u of p.members) recordDeletion(db, tx, `users/${u}/familyRefs/${p.familyId}`);
        if (p.orphan) continue;
        saveDeletionRecord(db, tx, p.familyId, uid, p.members, p.rec!);
        tx.update(db.doc(`families/${p.familyId}`), { status: 'deleting', updatedAt: FieldValue.serverTimestamp() });
      } else {
        tx.update(db.doc(`families/${p.familyId}/members/${uid}`), { status: 'left', displayName: REMOVED_NAME, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
        tx.update(db.doc(`families/${p.familyId}`), {
          memberCount: p.count, updatedAt: FieldValue.serverTimestamp(),
          ...(p.clearTransfer ? { pendingOwnerTransfer: FieldValue.delete() } : {}),
        });
        writeAudit(tx, p.familyId, { action: 'member.account-delete', actorUid: uid, target: { kind: 'member', id: uid } });
      }
    }
    return plans;
  });
  for (const p of plans) {
    if (p.sole) purgeFamily(db, p.familyId);
    else {
      skipPendingJobs(db, { familyId: p.familyId, recipientUid: uid }, 'member-inactive');
      revokeActiveInvites(db, p.familyId, uid);
    }
  }
  purgeDeviceTokenRefs(db, uid);
  db.recursiveDelete(db.doc(`users/${uid}`));
  deleteAuthUser(ctx, uid); // 失敗時は例外（削除ロックは残す）
  // Auth ユーザー削除に成功したので、端末レジストリと削除ロックを後始末する（ユーザー自体が存在しなくなるためロックは不要）
  db.doc(`system/deviceRegistry/users/${uid}`).delete();
  db.doc(`system/accountDeletion/users/${uid}`).delete();
  invalidateAccountCache(ctx.platform, uid);
  ctx.platform.log('info', 'deleteAccount', { families: plans.length });
  return { ok: true as const };
}

export const handlers: Record<string, Handler> = { exportFamilyData, deleteFamily, deleteAccount };
