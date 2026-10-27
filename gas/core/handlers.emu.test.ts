// セキュリティ修正（S1）の結合テスト：実ハンドラを Auth / Firestore エミュレータ上で dispatch 経由で呼ぶ（npm run test:emu）
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackupNow, runRestore, listBackups } from '../backup';
import { handlers as accountHandlers } from '../account';
import { sendToUser, setSender } from '../notify/fcm';
import { dbFor, setPlatform } from './context';
import { Timestamp } from './firestore';
import { createNodePlatform } from './platform/node';
import { handleRequest } from './router';
import { makeJwt } from './test-utils';

const platform = createNodePlatform({ ...process.env, DISABLE_RATE_LIMIT: '1' }); // 回数制限は別途テスト
const limited = createNodePlatform({ ...process.env });
const db = dbFor(platform);
const run = `s1${Date.now()}`;
let seq = 0;

interface User { idToken: string; uid: string }
function signUp(label: string): User {
  const { config } = platform;
  const r = platform.fetch(`${config.identityBaseUrl}/v1/accounts:signUp?key=${config.webApiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${run}-${label}-${seq++}@example.com`, password: 'password123', returnSecureToken: true }),
  });
  const j = JSON.parse(r.body) as { idToken: string; localId: string };
  return { idToken: j.idToken, uid: j.localId };
}
type Res = { ok: boolean; result?: any; error?: { code: string; message: string; details?: any } };
function call(u: User, fn: string, data: unknown = {}, p = platform): Res {
  return JSON.parse(handleRequest(p, JSON.stringify({ fn, data, idToken: u.idToken })));
}
const ok = (r: Res) => { expect(r.error).toBeUndefined(); expect(r.ok).toBe(true); return r.result; };
const err = (r: Res) => { expect(r.ok).toBe(false); return r.error!; };

/** 2 人家族：owner と editor（招待経由）と子ども 1 人 */
function makeFamily() {
  const owner = signUp('owner');
  const editor = signUp('editor');
  const c = ok(call(owner, 'createFamily', { familyName: 'F', displayName: 'Owner', child: { nickname: 'C' } })) as { familyId: string; childId: string };
  const inv = ok(call(owner, 'createInvite', { familyId: c.familyId })) as { token: string };
  ok(call(editor, 'acceptInvite', { token: inv.token, displayName: 'Editor' }));
  return { owner, editor, familyId: c.familyId, childId: c.childId };
}

describe('registerDevice', () => {
  it('dedups tokens, caps devices at 10 (evicting the oldest), normalizes platform', () => {
    const u = signUp('dev');
    ok(call(u, 'registerDevice', { deviceId: 'd0', fcmToken: 'tok-0', platform: 'ios' }));
    expect(db.doc(`users/${u.uid}/devices/d0`).get().data().platform).toBe('ios');
    ok(call(u, 'registerDevice', { deviceId: 'd1', fcmToken: 'tok-0', platform: 'weird-os' })); // 同じトークン → d0 は削除
    expect(db.doc(`users/${u.uid}/devices/d0`).get().exists).toBe(false);
    expect(db.doc(`users/${u.uid}/devices/d1`).get().data().platform).toBe('other');
    for (let i = 2; i <= 11; i++) ok(call(u, 'registerDevice', { deviceId: `d${i}`, fcmToken: `tok-${i}`, platform: 'android' }));
    const ids = db.collection(`users/${u.uid}/devices`).get().docs.map((d) => d.id).sort();
    expect(ids).toHaveLength(10);
    expect(ids).not.toContain('d1'); // 最古が削除された
    expect(ids).toContain('d11');
    ok(call(u, 'registerDevice', { deviceId: 'd11', fcmToken: 'tok-11b', platform: 'desktop' })); // 既存の更新は件数を増やさない
    expect(db.collection(`users/${u.uid}/devices`).get().size).toBe(10);
    expect(err(call(u, 'registerDevice', { deviceId: 'bad id!', fcmToken: 'x', platform: 'ios' })).code).toBe('invalid-argument');
  });
});

describe('rate limiting end to end', () => {
  it('createFamily is limited (5 per window) and reports retryAfterSec', () => {
    const u = signUp('rl');
    let last: Res = { ok: true };
    for (let i = 0; i < 6; i++) last = call(u, 'createFamily', { familyName: 'F', displayName: 'N', child: { nickname: 'C' } }, limited);
    expect(err(last)).toMatchObject({ code: 'resource-exhausted', details: { reason: 'rate-limited' } });
    expect(typeof err(last).details.retryAfterSec).toBe('number');
  });
});

describe('ownership transfer (two steps)', () => {
  it('propose -> notify -> accept swaps roles; only the target can accept', () => {
    const { owner, editor, familyId } = makeFamily();
    const r = ok(call(owner, 'transferOwnership', { familyId, toUid: editor.uid })) as { pending: boolean; expiresAt: string };
    expect(r.pending).toBe(true);
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    const fam = db.doc(`families/${familyId}`).get().data();
    expect(fam.ownerUid).toBe(owner.uid); // まだ移っていない
    expect(fam.pendingOwnerTransfer).toMatchObject({ toUid: editor.uid, proposedBy: owner.uid });
    const jobs = db.collection('notificationJobs').where('familyId', '==', familyId).where('type', '==', 'ownerTransfer').get();
    expect(jobs.size).toBe(1);
    expect(jobs.docs[0]!.data()).toMatchObject({ recipientUid: editor.uid, relatedKind: 'family' });
    // 提案者本人・無関係者は承認できない
    expect(err(call(owner, 'acceptOwnershipTransfer', { familyId })).details.reason).toBe('no-pending-transfer');
    // 承認
    ok(call(editor, 'acceptOwnershipTransfer', { familyId }));
    const after = db.doc(`families/${familyId}`).get().data();
    expect(after.ownerUid).toBe(editor.uid);
    expect(after.pendingOwnerTransfer).toBeUndefined();
    expect(db.doc(`families/${familyId}/members/${editor.uid}`).get().data().role).toBe('owner');
    expect(db.doc(`families/${familyId}/members/${owner.uid}`).get().data().role).toBe('editor');
    expect(db.doc(`users/${editor.uid}/familyRefs/${familyId}`).get().data().role).toBe('owner');
    expect(db.doc(`users/${owner.uid}/familyRefs/${familyId}`).get().data().role).toBe('editor');
    expect(err(call(editor, 'acceptOwnershipTransfer', { familyId })).details.reason).toBe('no-pending-transfer');
  });
  it('rejects non-owner / bad target / stale auth; supports cancel by owner or target; overwrites a pending proposal', () => {
    const { owner, editor, familyId } = makeFamily();
    expect(err(call(editor, 'transferOwnership', { familyId, toUid: owner.uid })).code).toBe('permission-denied');
    expect(err(call(owner, 'transferOwnership', { familyId, toUid: 'nobody' })).code).toBe('failed-precondition');
    // 再認証が古いトークン（auth_time を巻き戻した無署名トークン。エミュレータは署名を検証しない）
    const stale: User = { uid: owner.uid, idToken: makeJwt({ ...JSON.parse(Buffer.from(owner.idToken.split('.')[1]!, 'base64url').toString()), auth_time: Math.floor(Date.now() / 1000) - 3600 }) };
    expect(err(call(stale, 'transferOwnership', { familyId, toUid: editor.uid })).code).toBe('unauthenticated');
    ok(call(owner, 'transferOwnership', { familyId, toUid: editor.uid }));
    const first = db.doc(`families/${familyId}`).get().data().pendingOwnerTransfer.proposedAt.toMillis();
    ok(call(owner, 'transferOwnership', { familyId, toUid: editor.uid }));
    expect(db.doc(`families/${familyId}`).get().data().pendingOwnerTransfer.proposedAt.toMillis()).toBeGreaterThanOrEqual(first);
    const staleEditor: User = { uid: editor.uid, idToken: makeJwt({ ...JSON.parse(Buffer.from(editor.idToken.split('.')[1]!, 'base64url').toString()), auth_time: Math.floor(Date.now() / 1000) - 3600 }) };
    expect(err(call(staleEditor, 'acceptOwnershipTransfer', { familyId })).code).toBe('unauthenticated');
    ok(call(editor, 'cancelOwnershipTransfer', { familyId }));
    expect(db.doc(`families/${familyId}`).get().data().pendingOwnerTransfer).toBeUndefined();
    ok(call(owner, 'transferOwnership', { familyId, toUid: editor.uid }));
    ok(call(owner, 'cancelOwnershipTransfer', { familyId }));
    expect(db.doc(`families/${familyId}`).get().data().pendingOwnerTransfer).toBeUndefined();
    ok(call(owner, 'cancelOwnershipTransfer', { familyId })); // 提案なしでも冪等
  });
  it('expired proposals cannot be accepted', () => {
    const { owner, editor, familyId } = makeFamily();
    ok(call(owner, 'transferOwnership', { familyId, toUid: editor.uid }));
    db.doc(`families/${familyId}`).update({ 'pendingOwnerTransfer.expiresAt': Timestamp.fromMillis(Date.now() - 1000) });
    expect(err(call(editor, 'acceptOwnershipTransfer', { familyId })).details.reason).toBe('transfer-expired');
  });
  it('is void if the proposer is no longer the owner', () => {
    const { owner, editor, familyId } = makeFamily();
    ok(call(owner, 'transferOwnership', { familyId, toUid: editor.uid }));
    db.doc(`families/${familyId}/members/${owner.uid}`).update({ role: 'editor' });
    expect(err(call(editor, 'acceptOwnershipTransfer', { familyId })).details.reason).toBe('no-pending-transfer');
  });
});

describe('medication integrity', () => {
  function setup() {
    const f = makeFamily();
    const medPath = `families/${f.familyId}/children/${f.childId}/medications/m1`;
    db.doc(medPath).set({ name: 'M', instructionText: 'x', instructionSource: 'doctor', asNeeded: false, status: 'active', revision: 1 });
    const mk = (planned?: string) => ok(call(f.owner, 'createDoseOccurrence', { familyId: f.familyId, childId: f.childId, medicationId: 'm1', ...(planned ? { plannedAt: planned } : {}) })).occurrenceId as string;
    const complete = (occ: string, eventId: string, extra: object = {}) =>
      call(f.owner, 'completeDose', { familyId: f.familyId, childId: f.childId, occurrenceId: occ, eventId, occurredAt: new Date().toISOString(), ...extra });
    const occ = (id: string) => db.doc(`families/${f.familyId}/children/${f.childId}/doseOccurrences/${id}`).get().data();
    const ev = (id: string) => db.doc(`families/${f.familyId}/children/${f.childId}/events/${id}`).get().data();
    const setStatus = (eventId: string, status: 'active' | 'void', rev: number) =>
      call(f.owner, 'setEventStatus', { familyId: f.familyId, childId: f.childId, eventId, expectedRevision: rev, status });
    return { ...f, medPath, mk, complete, occ, ev, setStatus };
  }
  it('createDoseOccurrence returns the existing unfinished occurrence for the same (medicationId, plannedAt)', () => {
    const s = setup();
    const t = '2026-12-01T00:00:00.000Z';
    const a = s.mk(t);
    expect(s.mk(t)).toBe(a);
    expect(s.mk('2026-12-01T01:00:00.000Z')).not.toBe(a);
    const n1 = s.mk();
    expect(s.mk()).toBe(n1);
    ok(s.complete(a, 'e1'));
    expect(s.mk(t)).not.toBe(a); // 完了済みは再利用しない
  });
  it('void returns the occurrence to planned; restore completes it again; restore fails if another event completed it', () => {
    const s = setup();
    const o = s.mk('2026-12-01T00:00:00.000Z');
    ok(s.complete(o, 'e1'));
    expect(s.occ(o)).toMatchObject({ state: 'completed', completedEventId: 'e1' });
    ok(s.setStatus('e1', 'void', 1));
    expect(s.occ(o)).toMatchObject({ state: 'planned', completedEventId: null, claimedBy: null });
    ok(s.setStatus('e1', 'active', 2));
    expect(s.occ(o)).toMatchObject({ state: 'completed', completedEventId: 'e1' });
    // 取り消し → 別 event で再完了 → 元 event の復元は不可
    ok(s.setStatus('e1', 'void', 3));
    ok(s.complete(o, 'e2'));
    const e = err(s.setStatus('e1', 'active', 4));
    expect(e.code).toBe('failed-precondition');
    expect(s.ev('e1').status).toBe('void');
    expect(s.occ(o)).toMatchObject({ state: 'completed', completedEventId: 'e2' });
  });
  it('updateEvent: medication_taken allows only note; void events cannot be edited', () => {
    const s = setup();
    const o = s.mk('2026-12-02T00:00:00.000Z');
    ok(s.complete(o, 'e1'));
    const upd = (patch: object, rev = 1) => call(s.owner, 'updateEvent', { familyId: s.familyId, childId: s.childId, eventId: 'e1', expectedRevision: rev, patch });
    expect(err(upd({ occurredAt: new Date().toISOString() })).code).toBe('failed-precondition');
    expect(err(upd({ caregiverUid: s.editor.uid })).code).toBe('failed-precondition');
    ok(upd({ note: 'with food' }));
    ok(s.setStatus('e1', 'void', 2));
    expect(err(upd({ note: 'again' }, 3)).code).toBe('failed-precondition');
  });
  it('completeDose rejects future times and ended / missing medications', () => {
    const s = setup();
    const o = s.mk('2026-12-03T00:00:00.000Z');
    expect(err(s.complete(o, 'ef', { occurredAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() })).code).toBe('invalid-argument');
    ok(s.complete(s.mk('2026-12-03T01:00:00.000Z'), 'ok1', { occurredAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
    db.doc(s.medPath).update({ status: 'ended' });
    expect(err(s.complete(o, 'e9')).code).toBe('failed-precondition');
    db.doc(s.medPath).delete();
    expect(err(s.complete(o, 'e10')).code).toBe('not-found');
  });
});

describe('reference checks', () => {
  it('updateDoc verifies schedule.childId / relatedRefs[].childId; updateEvent verifies contextEventIds', () => {
    const f = makeFamily();
    const sp = `families/${f.familyId}/schedules/s1`;
    db.doc(sp).set({ title: 'T', category: 'other', allDay: true, date: '2026-12-01', timezone: 'Asia/Tokyo', assigneeUids: [], status: 'planned', relatedRefs: [], revision: 1 });
    const upd = (patch: object, rev: number) => call(f.owner, 'updateDoc', { familyId: f.familyId, kind: 'schedule', docId: 's1', expectedRevision: rev, patch });
    expect(err(upd({ childId: 'ghost' }, 1)).code).toBe('invalid-argument');
    expect(err(upd({ relatedRefs: [{ kind: 'event', id: 'x', childId: 'ghost' }] }, 1)).code).toBe('invalid-argument');
    ok(upd({ childId: f.childId, relatedRefs: [{ kind: 'event', id: 'x', childId: f.childId }] }, 1));
    expect(db.doc(sp).get().data().childId).toBe(f.childId);

    const evBase = `families/${f.familyId}/children/${f.childId}/events`;
    const mkEv = (id: string) => db.doc(`${evBase}/${id}`).set({
      schemaVersion: 1, childId: f.childId, type: 'memo', occurredAt: Timestamp.now(), recordedAt: Timestamp.now(), createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      createdBy: f.owner.uid, updatedBy: f.owner.uid, payload: {}, revision: 1, status: 'active',
    });
    mkEv('a'); mkEv('b');
    const ue = (ids: string[], rev: number) => call(f.owner, 'updateEvent', { familyId: f.familyId, childId: f.childId, eventId: 'a', expectedRevision: rev, patch: { contextEventIds: ids } });
    expect(err(ue(['ghost'], 1)).code).toBe('invalid-argument');
    expect(err(ue(['b', 'ghost'], 1)).code).toBe('invalid-argument');
    ok(ue(['b'], 1));
    expect(db.doc(`${evBase}/a`).get().data().contextEventIds).toEqual(['b']);
  });
});

describe('deletion races', () => {
  it('acceptInvite is refused for a family that is deleting', () => {
    const owner = signUp('o');
    const joiner = signUp('j');
    const c = ok(call(owner, 'createFamily', { familyName: 'F', displayName: 'O', child: { nickname: 'C' } })) as { familyId: string };
    const inv = ok(call(owner, 'createInvite', { familyId: c.familyId })) as { token: string };
    db.doc(`families/${c.familyId}`).update({ status: 'deleting' });
    expect(err(call(joiner, 'acceptInvite', { token: inv.token, displayName: 'J' })).code).toBe('failed-precondition');
    expect(db.doc(`families/${c.familyId}/members/${joiner.uid}`).get().exists).toBe(false);
  });
  it('deleteFamily marks deleting first and removes all members refs', () => {
    const f = makeFamily();
    ok(call(f.owner, 'deleteFamily', { familyId: f.familyId, confirmName: 'F' }));
    expect(db.doc(`families/${f.familyId}`).get().exists).toBe(false);
    expect(db.doc(`users/${f.editor.uid}/familyRefs/${f.familyId}`).get().exists).toBe(false);
    expect(db.doc(`users/${f.owner.uid}/familyRefs/${f.familyId}`).get().exists).toBe(false);
  });
  it('deleteAccount detects ownership from members/ownerUid even if familyRefs is missing', () => {
    const f = makeFamily();
    db.doc(`users/${f.owner.uid}/familyRefs/${f.familyId}`).delete();
    const e = err(call(f.owner, 'deleteAccount', {}));
    expect(e).toMatchObject({ code: 'failed-precondition', details: { reason: 'owner-has-members' } });
    expect(db.doc(`families/${f.familyId}`).get().exists).toBe(true);
  });
  it('deleteAccount works for the editor of a two-person family and invalidates the cached uid', () => {
    const f = makeFamily();
    ok(call(f.editor, 'deleteAccount', {}));
    expect(db.doc(`families/${f.familyId}/members/${f.editor.uid}`).get().data().status).toBe('left');
    expect(call(f.editor, 'createFamily', { familyName: 'x', displayName: 'y', child: { nickname: 'z' } }).ok).toBe(false);
  });
});

function interleaveBeforeTransaction(fn: () => void): () => void {
  const original = platform.fetch;
  let armed = true;
  platform.fetch = (url, init) => {
    if (armed && url.endsWith(':beginTransaction')) { armed = false; fn(); }
    return original(url, init);
  };
  return () => { platform.fetch = original; expect(armed).toBe(false); };
}

describe('authorization cannot race with revocation', () => {
  it('a former owner cannot remove the new owner after ownership transfer', () => {
    const f = makeFamily();
    ok(call(f.owner, 'transferOwnership', { familyId: f.familyId, toUid: f.editor.uid }));
    const reset = interleaveBeforeTransaction(() => ok(call(f.editor, 'acceptOwnershipTransfer', { familyId: f.familyId })));
    try { expect(err(call(f.owner, 'removeMember', { familyId: f.familyId, uid: f.editor.uid })).code).toBe('permission-denied'); }
    finally { reset(); }
    expect(db.doc(`families/${f.familyId}/members/${f.editor.uid}`).get().data().status).toBe('active');
  });
  it('an editor removed after the initial check cannot commit an update', () => {
    const f = makeFamily();
    const ref = db.doc(`families/${f.familyId}/tasks/race`);
    ref.set({ title: 'before', status: 'todo', revision: 1 });
    const reset = interleaveBeforeTransaction(() => ok(call(f.owner, 'removeMember', { familyId: f.familyId, uid: f.editor.uid })));
    try { expect(err(call(f.editor, 'updateDoc', { familyId: f.familyId, kind: 'task', docId: 'race', expectedRevision: 1, patch: { title: 'after' } })).code).toBe('permission-denied'); }
    finally { reset(); }
    expect(ref.get().data().title).toBe('before');
  });
  it('an account deletion lock blocks creating a new family', () => {
    const u = signUp('deleting');
    db.doc(`system/accountDeletion/users/${u.uid}`).set({ startedAt: Timestamp.now() });
    expect(err(call(u, 'createFamily', { familyName: 'F', displayName: 'N', child: { nickname: 'C' } })).code).toBe('permission-denied');
  });
});

describe('notification send defense', () => {
  it('bounds and deduplicates legacy or forged device records', () => {
    const u = signUp('send-bound');
    for (let i = 0; i < 15; i++) db.doc(`users/${u.uid}/devices/d${i}`).set({ fcmToken: 'duplicate', pushEnabled: true });
    const sent: string[] = [];
    setSender((_p, msg) => { sent.push(msg.token); return { ok: true }; });
    try {
      expect(sendToUser(db, platform, u.uid, 'test', {}, 'test').sent).toBe(1);
      expect(sent).toEqual(['duplicate']);
    } finally { setSender(null); }
  });
});

describe('backup deletion and permissions', () => {
  it('full + incremental cannot resurrect a deleted family, even when only the old full is restored', () => {
    const f = makeFamily();
    const raw = createNodePlatform({ ...process.env, DISABLE_RATE_LIMIT: '1', LOCAL_DRIVE_DIR: mkdtempSync(join(tmpdir(), 'kosodate-hub-backup-regression-')) });
    const local = { ...raw, config: { ...raw.config, projectId: `demo-backup-${Date.now()}` } };
    const source = dbFor(local);
    for (const path of [`families/${f.familyId}`, `families/${f.familyId}/members/${f.owner.uid}`, `families/${f.familyId}/members/${f.editor.uid}`, `users/${f.owner.uid}/familyRefs/${f.familyId}`, `users/${f.editor.uid}/familyRefs/${f.familyId}`]) source.doc(path).set(db.doc(path).get().data());
    source.doc(`users/${f.owner.uid}`).set({ displayName: 'owner' });
    source.doc(`users/${f.editor.uid}`).set({ displayName: 'editor' });
    setPlatform(local);
    expect(runBackupNow('full').status).toBe('complete');
    const full = listBackups().filter((d) => /chub-full-/.test(d.name) && !d.name.includes('manifest')).map((d) => d.id).join(',');
    accountHandlers.deleteFamily!({ db: source, platform: local, uid: f.owner.uid, authTime: Math.floor(Date.now() / 1000), now: () => new Date() }, { familyId: f.familyId, confirmName: 'F' });
    setPlatform(local);
    expect(runBackupNow('incremental').status).toBe('complete');
    const inc = listBackups().filter((d) => /chub-inc-/.test(d.name) && !d.name.includes('manifest')).map((d) => d.id).join(',');
    const target = `demo-restore-${Date.now()}`;
    expect(runRestore(target, full, inc).complete).toBe(true);
    const dest = dbFor({ ...local, config: { ...local.config, projectId: target } });
    expect(dest.doc(`families/${f.familyId}`).get().exists).toBe(false);
    expect(dest.doc(`families/${f.familyId}/members/${f.owner.uid}`).get().exists).toBe(false);
    expect(dest.doc(`users/${f.owner.uid}/familyRefs/${f.familyId}`).get().exists).toBe(false);
    expect(runRestore(target, full, '').complete).toBe(true);
    expect(dest.doc(`families/${f.familyId}`).get().exists).toBe(false);
    setPlatform(platform);
  });
  it('old snapshots cannot grant membership or ownership, and legacy backups are refused', () => {
    const f = makeFamily();
    const local = createNodePlatform({ ...process.env, LOCAL_DRIVE_DIR: mkdtempSync(join(tmpdir(), 'kosodate-hub-restore-permissions-')) });
    const folder = local.drive!.ensureFolder('BabyHub-Backup');
    const file = local.drive!.writeJson(folder, 'snapshot.json', JSON.stringify({ formatVersion: 2, projectId: local.config.projectId, kind: 'full', startedAt: new Date().toISOString(), part: 1, docs: [
      { path: `families/${f.familyId}`, data: { name: 'old', ownerUid: f.owner.uid, status: 'active', memberCount: 2 } },
      { path: `families/${f.familyId}/members/${f.editor.uid}`, data: { uid: f.editor.uid, role: 'owner', status: 'active' } },
    ] }));
    ok(call(f.owner, 'removeMember', { familyId: f.familyId, uid: f.editor.uid }));
    setPlatform(local);
    runRestore(local.config.projectId, file, '', 'OVERWRITE_PRODUCTION');
    expect(db.doc(`families/${f.familyId}/members/${f.editor.uid}`).get().data()).toMatchObject({ role: 'editor', status: 'removed' });
    const target = `demo-quarantine-${Date.now()}`;
    runRestore(target, file, '');
    const dest = dbFor({ ...local, config: { ...local.config, projectId: target } });
    expect(dest.doc(`families/${f.familyId}`).get().data().status).toBe('restoring');
    expect(dest.doc(`families/${f.familyId}/members/${f.editor.uid}`).get().data().status).toBe('removed');
    const old = local.drive!.writeJson(folder, 'legacy.json', JSON.stringify({ kind: 'full', part: 1, docs: [] }));
    expect(() => runRestore(target, old, '')).toThrow('Only version 2');
    setPlatform(platform);
  });
});
