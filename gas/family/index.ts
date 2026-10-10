import { ApiError } from '../core/errors';
import type { CallContext, Handler } from '../core/context';
import { assertRecentAuth, requireMember, writeAudit } from '../core/guards';
import { enqueueOwnerTransferNotice } from '../notify';
import { FieldValue, Timestamp, type Transaction } from '../core/firestore';
import { EVENT_TYPES } from '../shared/validate';
import { DEFAULT_SETTINGS, hashToken, isPlausibleToken } from '../shared/pure';
import { idField as id, strField as str, parseInput, activeMemberUids, skipPendingJobs } from '../shared/helpers';
import { REMOVED_NAME, deactivateMember, revokeActiveInvites } from '../shared/family-ops';
import type { Family, Invite, Member } from '../shared/types';

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 2;
const INVITES_PER_HOUR = 10;

type Snap = { exists: boolean; data(): unknown };
type QSnap = { empty: boolean; size: number; docs: { id: string; ref: any; data(): unknown }[] };

function activeFamilyRefs(ctx: CallContext, uid: string, tx?: Transaction): QSnap {
  const q = ctx.db.collection(`users/${uid}/familyRefs`).where('status', '==', 'active');
  return (tx ? tx.get(q) : q.get()) as QSnap;
}

// ---------- createFamily ----------
function createFamily(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const v = parseInput(data, {
    familyName: str(100),
    displayName: str(50),
    child: {
      spec: {
        k: 'obj',
        fields: {
          nickname: str(),
          birthDate: { spec: { k: 'date' }, null: 'store' },
          dueDate: { spec: { k: 'date' }, null: 'store' },
          isSample: { spec: { k: 'bool' } },
        },
      },
    },
  }, ['familyName', 'displayName', 'child']);
  const { familyName, displayName, child } = v.set as { familyName: string; displayName: string; child: Record<string, unknown> };
  if (typeof child.nickname !== 'string') throw new ApiError('invalid-argument', 'Invalid field: child.nickname');

  const familyRef = db.collection('families').doc();
  const childRef = familyRef.collection('children').doc();

  db.runTransaction((tx) => {
    if (tx.get(db.doc(`system/accountDeletion/users/${uid}`)).exists) throw new ApiError('permission-denied', 'Account deletion in progress');
    const refs = activeFamilyRefs(ctx, uid, tx);
    if (!refs.empty) throw new ApiError('already-exists', 'Already belongs to a family');
    const uref = db.doc(`users/${uid}`);
    const usnap = tx.get(uref) as Snap;
    const now = FieldValue.serverTimestamp();
    const base = { createdAt: now, updatedAt: now, createdBy: uid, updatedBy: uid };

    tx.set(familyRef, { name: familyName, timezone: 'Asia/Tokyo', ownerUid: uid, status: 'active', memberCount: 1, ...base });
    tx.set(familyRef.collection('members').doc(uid), { uid, role: 'owner', status: 'active', joinedAt: now, displayName, ...base });
    tx.set(db.doc(`users/${uid}/familyRefs/${familyRef.id}`), { familyId: familyRef.id, role: 'owner', status: 'active', joinedAt: now });
    const childDoc: Record<string, unknown> = {
      nickname: child.nickname,
      birthDate: child.birthDate ?? null,
      dueDate: child.dueDate ?? null,
      status: 'active',
      enabledRecordTypes: EVENT_TYPES.filter((t) => t !== 'medication_taken'),
      revision: 1,
      ...base,
    };
    if (child.isSample === true) childDoc.isSample = true;
    tx.set(childRef, childDoc);
    if (!usnap.exists) tx.set(uref, { displayName, createdAt: now, settings: DEFAULT_SETTINGS });
    writeAudit(tx, familyRef.id, { action: 'family.create', actorUid: uid, target: { kind: 'family', id: familyRef.id } });
  });
  ctx.platform.log('info', 'createFamily', { familyId: familyRef.id });
  return { familyId: familyRef.id, childId: childRef.id };
}

// ---------- 招待 ----------
function createInvite(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const { familyId } = parseInput(data, { familyId: id }, ['familyId']).set as { familyId: string };
  const token = ctx.platform.randomToken(32);
  const expiresAt = Timestamp.fromMillis(ctx.now().getTime() + INVITE_TTL_MS);
  const ref = db.collection('invites').doc();
  db.runTransaction((tx) => {
    const { member: me } = requireMember(ctx, familyId, ['owner'], tx);
    const hourAgo = Timestamp.fromMillis(ctx.now().getTime() - 60 * 60 * 1000);
    const recent = tx.get(db.collection('invites').where('familyId', '==', familyId).where('createdAt', '>=', hourAgo));
    const active = tx.get(db.collection('invites').where('familyId', '==', familyId).where('status', '==', 'active'));
    if (recent.size >= INVITES_PER_HOUR) throw new ApiError('resource-exhausted', 'Too many invites');
    for (const d of active.docs) tx.update(d.ref, { status: 'revoked' });
    tx.set(ref, {
      familyId, tokenHash: hashToken(token), role: 'editor', createdBy: uid, inviterName: me.displayName,
      expiresAt, status: 'active', usedBy: null, usedAt: null, createdAt: Timestamp.now(),
    });
    writeAudit(tx, familyId, { action: 'invite.create', actorUid: uid, target: { kind: 'invite', id: ref.id } });
  });
  ctx.platform.log('info', 'createInvite', { familyId, inviteId: ref.id });
  return { inviteId: ref.id, token, expiresAt: expiresAt.toDate().toISOString() };
}

function revokeInvite(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const { familyId, inviteId } = parseInput(data, { familyId: id, inviteId: id }, ['familyId', 'inviteId']).set as { familyId: string; inviteId: string };
  requireMember(ctx, familyId, ['owner']);
  const ref = db.doc(`invites/${inviteId}`);
  db.runTransaction((tx) => {
    requireMember(ctx, familyId, ['owner'], tx);
    const s = tx.get(ref) as Snap;
    if (!s.exists || (s.data() as Invite).familyId !== familyId) throw new ApiError('not-found', 'Invite not found');
    if ((s.data() as Invite).status === 'active') tx.update(ref, { status: 'revoked' });
    writeAudit(tx, familyId, { action: 'invite.revoke', actorUid: uid, target: { kind: 'invite', id: inviteId } });
  });
  return { ok: true as const };
}

function findInviteByToken(ctx: CallContext, token: string, tx?: Transaction) {
  const q = ctx.db.collection('invites').where('tokenHash', '==', hashToken(token)).limit(1);
  const qs = (tx ? tx.get(q) : q.get()) as QSnap;
  return qs.docs[0];
}

function assertInviteUsable(ctx: CallContext, inv: Invite | undefined): asserts inv is Invite {
  if (!inv) throw new ApiError('not-found', 'Invite not found');
  if (inv.status !== 'active') throw new ApiError('failed-precondition', 'Invite is no longer valid', { reason: inv.status });
  if (inv.expiresAt.toMillis() <= ctx.now().getTime()) throw new ApiError('failed-precondition', 'Invite expired', { reason: 'expired' });
}

function previewInvite(ctx: CallContext, data: unknown) {
  const { token } = parseInput(data, { token: { spec: { k: 'str', max: 128 } } }, ['token']).set as { token: string };
  if (!isPlausibleToken(token)) throw new ApiError('not-found', 'Invite not found');
  const doc = findInviteByToken(ctx, token);
  const inv = doc?.data() as Invite | undefined;
  assertInviteUsable(ctx, inv);
  const fam = ctx.db.doc(`families/${inv.familyId}`).get();
  const inviter = ctx.db.doc(`families/${inv.familyId}/members/${inv.createdBy}`).get();
  const f = fam.data() as Family | undefined;
  const im = inviter.data() as Member | undefined;
  if (!f || f.status !== 'active' || !im || im.status !== 'active' || im.role !== 'owner') {
    throw new ApiError('failed-precondition', 'Invite is no longer valid', { reason: 'inviter-changed' });
  }
  return { familyName: f.name, inviterName: im.displayName, role: inv.role, expiresAt: inv.expiresAt.toDate().toISOString() };
}

function acceptInvite(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const { token, displayName } = parseInput(data, {
    token: { spec: { k: 'str', max: 128 } },
    displayName: str(50),
  }, ['token', 'displayName']).set as { token: string; displayName: string };
  if (!isPlausibleToken(token)) throw new ApiError('not-found', 'Invite not found');

  const familyId = db.runTransaction((tx) => {
    if (tx.get(db.doc(`system/accountDeletion/users/${uid}`)).exists) throw new ApiError('permission-denied', 'Account deletion in progress');
    const doc = findInviteByToken(ctx, token, tx);
    const inv = doc?.data() as Invite | undefined;
    assertInviteUsable(ctx, inv);
    const fid = inv.familyId;
    const famRef = db.doc(`families/${fid}`);
    const famSnap = tx.get(famRef) as Snap;
    const inviterSnap = tx.get(db.doc(`families/${fid}/members/${inv.createdBy}`)) as Snap;
    const mySnap = tx.get(db.doc(`families/${fid}/members/${uid}`)) as Snap;
    const activeMembers = tx.get(db.collection(`families/${fid}/members`).where('status', '==', 'active')) as QSnap;
    const myRefs = activeFamilyRefs(ctx, uid, tx);
    const userSnap = tx.get(db.doc(`users/${uid}`)) as Snap;
    const fam = famSnap.data() as Family | undefined;
    const inviter = inviterSnap.data() as Member | undefined;
    if (!fam || fam.status !== 'active' || !inviter || inviter.status !== 'active' || inviter.role !== 'owner') {
      throw new ApiError('failed-precondition', 'Invite is no longer valid', { reason: 'inviter-changed' });
    }
    if ((mySnap.data() as Member | undefined)?.status === 'active') throw new ApiError('already-exists', 'Already a member');
    if (!myRefs.empty) throw new ApiError('failed-precondition', 'Already belongs to another family', { reason: 'has-other-family' });
    if (activeMembers.size >= MAX_MEMBERS) throw new ApiError('failed-precondition', 'Family is full', { reason: 'family-full' });

    const now = FieldValue.serverTimestamp();
    tx.set(db.doc(`families/${fid}/members/${uid}`), {
      uid, role: inv.role, status: 'active', joinedAt: now, displayName,
      createdAt: now, updatedAt: now, createdBy: uid, updatedBy: uid,
    });
    tx.set(db.doc(`users/${uid}/familyRefs/${fid}`), { familyId: fid, role: inv.role, status: 'active', joinedAt: now });
    tx.update(famRef, { memberCount: activeMembers.size + 1, updatedAt: now });
    tx.update(doc.ref, { status: 'used', usedBy: uid, usedAt: now });
    if (!userSnap.exists) tx.set(db.doc(`users/${uid}`), { displayName, createdAt: now, settings: DEFAULT_SETTINGS });
    writeAudit(tx, fid, { action: 'member.join', actorUid: uid, target: { kind: 'member', id: uid } });
    return fid;
  });
  ctx.platform.log('info', 'acceptInvite', { familyId });
  return { familyId };
}

// ---------- メンバー管理 ----------
function leaveFamily(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const { familyId } = parseInput(data, { familyId: id }, ['familyId']).set as { familyId: string };
  const { member: me } = requireMember(ctx, familyId);
  if (me.role === 'owner') {
    const others = activeMemberUids(ctx.db, familyId).filter((u) => u !== uid);
    if (others.length > 0) throw new ApiError('failed-precondition', 'Transfer ownership first', { reason: 'transfer-required' });
    throw new ApiError('failed-precondition', 'Last member: delete the family instead', { reason: 'delete-family-required' });
  }
  deactivateMember(ctx.db, familyId, uid, 'left', uid, 'member.leave');
  return { ok: true as const };
}

// ---------- 管理者の移譲（2 段階：提案 → 相手が承認） ----------
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

function transferOwnership(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const { familyId, toUid } = parseInput(data, { familyId: id, toUid: id }, ['familyId', 'toUid']).set as { familyId: string; toUid: string };
  if (toUid === uid) throw new ApiError('invalid-argument', 'Invalid field: toUid');
  assertRecentAuth(ctx);
  requireMember(ctx, familyId, ['owner']);
  const nowMs = ctx.now().getTime();
  const proposedAt = Timestamp.fromMillis(nowMs);
  const expiresAt = Timestamp.fromMillis(nowMs + TRANSFER_TTL_MS);
  db.runTransaction((tx) => {
    const fam = tx.get(db.doc(`families/${familyId}`)) as Snap;
    const from = tx.get(db.doc(`families/${familyId}/members/${uid}`)) as Snap;
    const to = tx.get(db.doc(`families/${familyId}/members/${toUid}`)) as Snap;
    const f = from.data() as Member | undefined;
    const t = to.data() as Member | undefined;
    const fa = fam.data() as Family | undefined;
    if (!fa || fa.status !== 'active') throw new ApiError('failed-precondition', 'Family unavailable');
    if (!f || f.status !== 'active' || f.role !== 'owner' || fa.ownerUid !== uid) throw new ApiError('permission-denied', 'Not owner');
    if (!t || t.status !== 'active' || t.role !== 'editor') throw new ApiError('failed-precondition', 'Target must be an active editor');
    // 既存の提案は上書き
    tx.update(db.doc(`families/${familyId}`), {
      pendingOwnerTransfer: { toUid, proposedBy: uid, proposedAt, expiresAt },
      updatedAt: FieldValue.serverTimestamp(),
    });
    writeAudit(tx, familyId, { action: 'owner.transfer.propose', actorUid: uid, target: { kind: 'member', id: toUid } });
  });
  skipPendingJobs(db, { familyId, relatedId: familyId }, 'transfer-replaced'); // 旧提案の未送信通知
  enqueueOwnerTransferNotice(db, ctx.platform, familyId, toUid, nowMs, ctx.now());
  ctx.platform.log('info', 'transferOwnership proposed', { familyId });
  return { pending: true as const, expiresAt: expiresAt.toDate().toISOString() };
}

function acceptOwnershipTransfer(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const { familyId } = parseInput(data, { familyId: id }, ['familyId']).set as { familyId: string };
  assertRecentAuth(ctx);
  db.runTransaction((tx) => {
    const famRef = db.doc(`families/${familyId}`);
    const fam = tx.get(famRef) as Snap;
    const fa = fam.data() as Family | undefined;
    if (!fa) throw new ApiError('not-found', 'Family not found');
    const pend = fa.pendingOwnerTransfer;
    if (!pend || pend.toUid !== uid) throw new ApiError('failed-precondition', 'No pending transfer', { reason: 'no-pending-transfer' });
    if (pend.expiresAt.toMillis() <= ctx.now().getTime()) throw new ApiError('failed-precondition', 'Transfer expired', { reason: 'transfer-expired' });
    if (fa.status !== 'active') throw new ApiError('failed-precondition', 'Family unavailable');
    const fromSnap = tx.get(db.doc(`families/${familyId}/members/${pend.proposedBy}`)) as Snap;
    const toSnap = tx.get(db.doc(`families/${familyId}/members/${uid}`)) as Snap;
    const f = fromSnap.data() as Member | undefined;
    const t = toSnap.data() as Member | undefined;
    // 提案者がまだ owner であること（提案後に状況が変わっていたら無効）
    if (!f || f.status !== 'active' || f.role !== 'owner' || fa.ownerUid !== pend.proposedBy) {
      throw new ApiError('failed-precondition', 'No pending transfer', { reason: 'no-pending-transfer' });
    }
    if (!t || t.status !== 'active' || t.role !== 'editor') throw new ApiError('permission-denied', 'Not an active editor');
    // 提案後に相手が退出して再参加していた場合（joinedAt が提案より後）は、古い提案として無効
    if (t.joinedAt && pend.proposedAt && t.joinedAt.toMillis() > pend.proposedAt.toMillis()) {
      throw new ApiError('failed-precondition', 'No pending transfer', { reason: 'no-pending-transfer' });
    }
    const now = FieldValue.serverTimestamp();
    tx.update(db.doc(`families/${familyId}/members/${pend.proposedBy}`), { role: 'editor', updatedAt: now, updatedBy: uid });
    tx.update(db.doc(`families/${familyId}/members/${uid}`), { role: 'owner', updatedAt: now, updatedBy: uid });
    tx.update(famRef, { ownerUid: uid, pendingOwnerTransfer: FieldValue.delete(), updatedAt: now });
    tx.set(db.doc(`users/${pend.proposedBy}/familyRefs/${familyId}`), { role: 'editor' }, { merge: true });
    tx.set(db.doc(`users/${uid}/familyRefs/${familyId}`), { role: 'owner' }, { merge: true });
    writeAudit(tx, familyId, { action: 'owner.transfer', actorUid: uid, target: { kind: 'member', id: uid } });
  });
  revokeActiveInvites(db, familyId); // 発行者が現 owner でなくなるため
  skipPendingJobs(db, { familyId, relatedId: familyId }, 'transfer-done');
  ctx.platform.log('info', 'acceptOwnershipTransfer', { familyId });
  return { ok: true as const };
}

function cancelOwnershipTransfer(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const db = ctx.db;
  const { familyId } = parseInput(data, { familyId: id }, ['familyId']).set as { familyId: string };
  const { member, family } = requireMember(ctx, familyId);
  const pend = family.pendingOwnerTransfer;
  if (!pend) return { ok: true as const };
  if (member.role !== 'owner' && pend.toUid !== uid) throw new ApiError('permission-denied', 'Not allowed to cancel');
  db.runTransaction((tx) => {
    const famRef = db.doc(`families/${familyId}`);
    const { member, family: fa } = requireMember(ctx, familyId, undefined, tx);
    if (member.role !== 'owner' && fa.pendingOwnerTransfer?.toUid !== uid) throw new ApiError('permission-denied', 'Not allowed to cancel');
    if (!fa?.pendingOwnerTransfer) return;
    tx.update(famRef, { pendingOwnerTransfer: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    writeAudit(tx, familyId, { action: 'owner.transfer.cancel', actorUid: uid, target: { kind: 'member', id: fa.pendingOwnerTransfer.toUid } });
  });
  skipPendingJobs(db, { familyId, relatedId: familyId }, 'transfer-cancelled');
  return { ok: true as const };
}

function removeMember(ctx: CallContext, data: unknown) {
  const uid = ctx.uid;
  const { familyId, uid: target } = parseInput(data, { familyId: id, uid: id }, ['familyId', 'uid']).set as { familyId: string; uid: string };
  requireMember(ctx, familyId, ['owner']);
  if (target === uid) throw new ApiError('invalid-argument', 'Cannot remove yourself');
  deactivateMember(ctx.db, familyId, target, 'removed', uid, 'member.remove');
  return { ok: true as const };
}

export { REMOVED_NAME };
export const handlers: Record<string, Handler> = {
  createFamily, createInvite, revokeInvite, previewInvite, acceptInvite, leaveFamily, transferOwnership, acceptOwnershipTransfer, cancelOwnershipTransfer, removeMember,
};
