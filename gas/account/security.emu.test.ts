// セキュリティ修正 F1 の結合テスト（Auth / Firestore エミュレータ。npm run test:emu）
import { describe, expect, it } from 'vitest';
import { sweepStaleDeletionLocks } from './locks';
import { dbFor } from '../core/context';
import { Timestamp } from '../core/firestore';
import { createNodePlatform } from '../core/platform/node';
import type { Platform } from '../core/platform/types';
import { handleRequest } from '../core/router';
import { tokenRefPath } from '../notify/device-tokens';

const platform = createNodePlatform({ ...process.env, DISABLE_RATE_LIMIT: '1' });
const db = dbFor(platform);
const run = `f1${Date.now()}`;
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
function call(u: User, fn: string, data: unknown = {}, p: Platform = platform): Res {
  return JSON.parse(handleRequest(p, JSON.stringify({ fn, data, idToken: u.idToken })));
}
const ok = (r: Res) => { expect(r.error).toBeUndefined(); expect(r.ok).toBe(true); return r.result; };
const err = (r: Res) => { expect(r.ok).toBe(false); return r.error!; };
const withFetch = (f: (url: string, init: Parameters<Platform['fetch']>[1], orig: Platform['fetch']) => ReturnType<Platform['fetch']>): Platform =>
  ({ ...platform, fetch: (url, init) => f(url, init, platform.fetch) });
const authUserExists = (uid: string): boolean => {
  const { config } = platform;
  const r = platform.fetch(`${config.identityBaseUrl}/v1/accounts:lookup?key=${config.webApiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: [uid] }),
  });
  return r.status === 200 && (JSON.parse(r.body).users ?? []).length > 0;
};

function makeFamily() {
  const owner = signUp('owner');
  const editor = signUp('editor');
  const c = ok(call(owner, 'createFamily', { familyName: 'F', displayName: 'Owner', child: { nickname: 'C' } })) as { familyId: string; childId: string };
  const inv = ok(call(owner, 'createInvite', { familyId: c.familyId })) as { token: string };
  ok(call(editor, 'acceptInvite', { token: inv.token, displayName: 'Editor' }));
  return { owner, editor, familyId: c.familyId, childId: c.childId };
}

describe('exportFamilyData (read-only transaction)', () => {
  it('exports in a read-only transaction and writes the audit log afterwards', () => {
    const f = makeFamily();
    const calls: string[] = [];
    const p = withFetch((url, init, orig) => { if (url.endsWith(':beginTransaction')) calls.push(init.body ?? ''); return orig(url, init); });
    const out = ok(call(f.owner, 'exportFamilyData', { familyId: f.familyId }, p));
    expect(out.family.id).toBe(f.familyId);
    expect(out.children).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!)).toEqual({ options: { readOnly: {} } });
    const logs = db.collection(`families/${f.familyId}/auditLogs`).where('action', '==', 'family.export').get();
    expect(logs.size).toBe(1);
  });
  it('rejects writes inside a read-only transaction', () => {
    expect(() => db.runTransaction((tx) => { tx.set(db.doc('system/x/y/z'), { a: 1 }); }, { readOnly: true })).toThrow(/read-only/);
  });
  it('a non-member still cannot export', () => {
    const f = makeFamily();
    expect(err(call(signUp('x'), 'exportFamilyData', { familyId: f.familyId })).code).toBe('permission-denied');
  });
});

describe('deleteAccount cleanup', () => {
  it('removes the deletion lock, device registry and token index after the Auth user is deleted', () => {
    const f = makeFamily();
    ok(call(f.editor, 'registerDevice', { deviceId: 'd1', fcmToken: `tok-${run}-a`, platform: 'ios' }));
    expect(db.doc(tokenRefPath(`tok-${run}-a`)).get().data().uid).toBe(f.editor.uid);
    expect(db.doc(`system/deviceRegistry/users/${f.editor.uid}`).get().exists).toBe(true);
    ok(call(f.editor, 'deleteAccount', {}));
    expect(db.doc(`system/accountDeletion/users/${f.editor.uid}`).get().exists).toBe(false);
    expect(db.doc(`system/deviceRegistry/users/${f.editor.uid}`).get().exists).toBe(false);
    expect(db.doc(tokenRefPath(`tok-${run}-a`)).get().exists).toBe(false);
    expect(authUserExists(f.editor.uid)).toBe(false);
  });
  it('keeps the lock (with createdAt) and reports auth-delete-failed; re-running completes it', () => {
    const u = signUp('authfail');
    const failing = withFetch((url, init, orig) => (url.includes('accounts:delete') ? { status: 500, body: '{}' } : orig(url, init)));
    const e = err(call(u, 'deleteAccount', {}, failing));
    expect(e).toMatchObject({ code: 'internal', details: { reason: 'auth-delete-failed' } });
    const lock = db.doc(`system/accountDeletion/users/${u.uid}`).get();
    expect(lock.exists).toBe(true);
    const created = lock.get('createdAt') as Timestamp;
    expect(authUserExists(u.uid)).toBe(true);
    // 再実行（再ログイン相当）：createdAt は維持され、完了するとロックが消える
    ok(call(u, 'deleteAccount', {}));
    expect(db.doc(`system/accountDeletion/users/${u.uid}`).get().exists).toBe(false);
    expect(created).toBeTruthy();
    expect(authUserExists(u.uid)).toBe(false);
  });
  it('resumes an interrupted family deletion from the record even when the family document is gone', () => {
    const o = signUp('orphan-owner');
    const m = signUp('orphan-member');
    const fid = `orphan${run}`;
    db.doc(`system/familyDeletion/families/${fid}`).set({ ownerUid: o.uid, members: [o.uid, m.uid], startedAt: Timestamp.now() });
    db.doc(`users/${m.uid}/familyRefs/${fid}`).set({ familyId: fid, status: 'active' });
    ok(call(o, 'deleteAccount', {}));
    expect(db.doc(`system/familyDeletion/families/${fid}`).get().exists).toBe(false);
    expect(db.doc(`users/${m.uid}/familyRefs/${fid}`).get().exists).toBe(false);
  });
});

describe('deleteFamily interruption', () => {
  it('marks every member ref removed first, saves the member list, and can be re-run after a failure', () => {
    const f = makeFamily();
    const failing = withFetch((url, init, orig) => (url.endsWith(':listCollectionIds') ? { status: 500, body: '{}' } : orig(url, init)));
    expect(err(call(f.owner, 'deleteFamily', { familyId: f.familyId, confirmName: 'F' }, failing)).code).not.toBe('ok');
    const rec = db.doc(`system/familyDeletion/families/${f.familyId}`).get();
    expect(rec.exists).toBe(true);
    expect((rec.get('members') as string[]).sort()).toEqual([f.owner.uid, f.editor.uid].sort());
    expect(db.doc(`users/${f.editor.uid}/familyRefs/${f.familyId}`).get().data().status).toBe('removed');
    expect(db.doc(`users/${f.owner.uid}/familyRefs/${f.familyId}`).get().data().status).toBe('removed');
    ok(call(f.owner, 'deleteFamily', { familyId: f.familyId, confirmName: 'F' }));
    expect(db.doc(`families/${f.familyId}`).get().exists).toBe(false);
    expect(db.doc(`system/familyDeletion/families/${f.familyId}`).get().exists).toBe(false);
    expect(db.doc(`users/${f.editor.uid}/familyRefs/${f.familyId}`).get().exists).toBe(false);
  });
  it('can be finished from the record alone (family document missing), only by the recorded owner', () => {
    const o = signUp('rec-owner');
    const other = signUp('rec-other');
    const fid = `rec${run}`;
    db.doc(`system/familyDeletion/families/${fid}`).set({ ownerUid: o.uid, members: [o.uid], startedAt: Timestamp.now() });
    db.doc(`users/${o.uid}/familyRefs/${fid}`).set({ familyId: fid, status: 'removed' });
    expect(err(call(other, 'deleteFamily', { familyId: fid, confirmName: 'x' })).code).toBe('not-found');
    ok(call(o, 'deleteFamily', { familyId: fid, confirmName: 'x' }));
    expect(db.doc(`system/familyDeletion/families/${fid}`).get().exists).toBe(false);
    expect(db.doc(`users/${o.uid}/familyRefs/${fid}`).get().exists).toBe(false);
  });
});

describe('stale account deletion locks', () => {
  it('removes locks older than 7 days only when the Auth user no longer exists', () => {
    const live = signUp('lock-live');
    const old = Timestamp.fromMillis(Date.now() - 8 * 24 * 3600 * 1000);
    const ghost = `ghost${run}`;
    const legacy = `legacy${run}`;
    const fresh = signUp('lock-fresh');
    db.doc(`system/accountDeletion/users/${live.uid}`).set({ createdAt: old, startedAt: old });
    db.doc(`system/accountDeletion/users/${ghost}`).set({ createdAt: old, startedAt: old });
    db.doc(`system/deviceRegistry/users/${ghost}`).set({ updatedAt: old });
    db.doc(`system/accountDeletion/users/${legacy}`).set({ startedAt: old });
    db.doc(`system/accountDeletion/users/${fresh.uid}`).set({ createdAt: Timestamp.now(), startedAt: Timestamp.now() });
    sweepStaleDeletionLocks(db, platform, Date.now());
    expect(db.doc(`system/accountDeletion/users/${live.uid}`).get().exists).toBe(true);
    expect(db.doc(`system/accountDeletion/users/${ghost}`).get().exists).toBe(false);
    expect(db.doc(`system/deviceRegistry/users/${ghost}`).get().exists).toBe(false);
    expect(db.doc(`system/accountDeletion/users/${legacy}`).get().exists).toBe(false);
    expect(db.doc(`system/accountDeletion/users/${fresh.uid}`).get().exists).toBe(true);
  });
});

describe('pending ownership transfer cleanup', () => {
  it('removing the proposed target deletes the proposal in the same transaction', () => {
    const f = makeFamily();
    ok(call(f.owner, 'transferOwnership', { familyId: f.familyId, toUid: f.editor.uid }));
    ok(call(f.owner, 'removeMember', { familyId: f.familyId, uid: f.editor.uid }));
    expect(db.doc(`families/${f.familyId}`).get().data().pendingOwnerTransfer).toBeUndefined();
  });
  it('the proposed target leaving deletes the proposal', () => {
    const f = makeFamily();
    ok(call(f.owner, 'transferOwnership', { familyId: f.familyId, toUid: f.editor.uid }));
    ok(call(f.editor, 'leaveFamily', { familyId: f.familyId }));
    expect(db.doc(`families/${f.familyId}`).get().data().pendingOwnerTransfer).toBeUndefined();
  });
  it('an unrelated removal keeps the proposal; account deletion of the target clears it', () => {
    const f = makeFamily();
    ok(call(f.owner, 'transferOwnership', { familyId: f.familyId, toUid: f.editor.uid }));
    ok(call(f.editor, 'deleteAccount', {}));
    expect(db.doc(`families/${f.familyId}`).get().data().pendingOwnerTransfer).toBeUndefined();
  });
  it('a proposal older than the target joinedAt (leave and rejoin) cannot be accepted', () => {
    const f = makeFamily();
    ok(call(f.owner, 'transferOwnership', { familyId: f.familyId, toUid: f.editor.uid }));
    db.doc(`families/${f.familyId}/members/${f.editor.uid}`).update({ joinedAt: Timestamp.fromMillis(Date.now() + 60_000) });
    expect(err(call(f.editor, 'acceptOwnershipTransfer', { familyId: f.familyId })).details.reason).toBe('no-pending-transfer');
    expect(db.doc(`families/${f.familyId}`).get().data().ownerUid).toBe(f.owner.uid);
  });
});

describe('registerDevice token index', () => {
  it('removes the same fcmToken from another uid and keeps the index consistent', () => {
    const a = signUp('tok-a');
    const b = signUp('tok-b');
    const tok = `shared-${run}`;
    ok(call(a, 'registerDevice', { deviceId: 'da', fcmToken: tok, platform: 'ios' }));
    expect(db.doc(`users/${a.uid}/devices/da`).get().exists).toBe(true);
    ok(call(b, 'registerDevice', { deviceId: 'db', fcmToken: tok, platform: 'android' }));
    expect(db.doc(`users/${a.uid}/devices/da`).get().exists).toBe(false);
    expect(db.doc(`users/${b.uid}/devices/db`).get().exists).toBe(true);
    expect(db.doc(tokenRefPath(tok)).get().data()).toMatchObject({ uid: b.uid, deviceId: 'db' });
    // トークン更新で古い索引は消える
    ok(call(b, 'registerDevice', { deviceId: 'db', fcmToken: `${tok}-2`, platform: 'android' }));
    expect(db.doc(tokenRefPath(tok)).get().exists).toBe(false);
    expect(db.doc(tokenRefPath(`${tok}-2`)).get().data().uid).toBe(b.uid);
    // 古い索引（端末文書が無い）でも他 uid の登録を壊さずに自己修復する
    db.doc(tokenRefPath('stale-' + run)).set({ uid: a.uid, deviceId: 'gone' });
    ok(call(b, 'registerDevice', { deviceId: 'dc', fcmToken: 'stale-' + run, platform: 'other' }));
    expect(db.doc(tokenRefPath('stale-' + run)).get().data().uid).toBe(b.uid);
  });
});
