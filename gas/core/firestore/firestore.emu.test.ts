// Firestore / Auth エミュレータに対する結合テスト（npm run test:emu）
import { describe, expect, it } from 'vitest';
import { verifyIdToken } from '../auth';
import type { CallContext } from '../context';
import { dispatch } from '../dispatch';
import { requireMember } from '../guards';
import { nodePlatform as platform } from '../platform/node';
import { FieldValue, Timestamp, createFirestore } from './index';

const db = createFirestore(platform);
const run = `t${Date.now()}`;
const col = (n: string) => `emu_${run}/${n}/items`;

describe('firestore emulator', () => {
  it('set/get/update (dotted)/delete with FieldValue', () => {
    const ref = db.doc(`${col('a')}/d1`);
    ref.set({ name: 'x', n: 1, nested: { a: 1, b: 2 }, tags: ['a'], at: FieldValue.serverTimestamp(), ts: Timestamp.fromMillis(1700000000123) });
    let s = ref.get();
    expect(s.exists).toBe(true);
    expect(s.data().nested).toEqual({ a: 1, b: 2 });
    expect(s.data().at).toBeInstanceOf(Timestamp);
    expect(s.data().ts.toMillis()).toBe(1700000000123);
    ref.update({ 'nested.a': 10, n: FieldValue.increment(2), tags: FieldValue.arrayUnion('b'), name: FieldValue.delete(), upd: FieldValue.serverTimestamp() });
    s = ref.get();
    expect(s.data()).toMatchObject({ n: 3, nested: { a: 10, b: 2 }, tags: ['a', 'b'] });
    expect(s.data().name).toBeUndefined();
    expect(s.get('nested.a')).toBe(10);
    expect(s.updateTime).toBeInstanceOf(Timestamp);
    ref.set({ nested: { c: 3 } }, { merge: true });
    expect(ref.get().data().nested).toEqual({ a: 10, b: 2, c: 3 });
    ref.delete();
    expect(ref.get().exists).toBe(false);
  });
  it('transform-only update (empty mask) works', () => {
    const ref = db.doc(`${col('a')}/d2`);
    ref.set({ n: 1 });
    ref.update({ n: FieldValue.increment(1) });
    expect(ref.get().data().n).toBe(2);
  });
  it('create fails if exists; update fails if missing', () => {
    const ref = db.doc(`${col('b')}/d1`);
    ref.create({ a: 1 });
    expect(() => ref.create({ a: 2 })).toThrow(expect.objectContaining({ code: 'already-exists' }));
    expect(() => db.doc(`${col('b')}/missing`).update({ a: 1 })).toThrow(expect.objectContaining({ code: 'not-found' }));
  });
  it('query where/orderBy/limit/startAfter and getAll', () => {
    const c = db.collection(col('q'));
    for (let i = 1; i <= 5; i++) c.doc(`d${i}`).set({ i, g: i % 2 ? 'odd' : 'even', at: Timestamp.fromMillis(i * 1000) });
    expect(c.where('g', '==', 'odd').get().size).toBe(3);
    const ordered = c.orderBy('i', 'desc').limit(2).get();
    expect(ordered.docs.map((d) => d.id)).toEqual(['d5', 'd4']);
    const next = c.orderBy('i', 'desc').startAfter(4).limit(2).get();
    expect(next.docs.map((d) => d.id)).toEqual(['d3', 'd2']);
    expect(c.where('at', '<=', Timestamp.fromMillis(2000)).orderBy('at').get().docs.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(c.where('i', 'in', [1, 2]).get().size).toBe(2);
    const [a, m] = db.getAll(c.doc('d1'), c.doc('nope'));
    expect([a!.exists, m!.exists]).toEqual([true, false]);
  });
  it('transaction: read-modify-write (commit is atomic; contention retry is covered by unit tests)', () => {
    const ref = db.doc(`${col('t')}/counter`);
    ref.set({ n: 0 });
    let attempts = 0;
    db.runTransaction((tx) => {
      attempts++;
      const n = tx.get(ref).data().n as number;
      tx.update(ref, { n: n + 1 });
    });
    expect(ref.get().data().n).toBe(1);
    expect(attempts).toBe(1);
  });
  it('batch writes', () => {
    const b = db.batch();
    for (let i = 0; i < 3; i++) b.set(db.doc(`${col('batch')}/b${i}`), { i });
    b.commit();
    expect(db.collection(col('batch')).get().size).toBe(3);
  });
  it('recursiveDelete removes subcollections', () => {
    const root = db.doc(`emu_${run}/rd`);
    root.set({ a: 1 });
    root.collection('sub').doc('s1').set({ a: 1 });
    root.collection('sub').doc('s1').collection('deep').doc('x').set({ a: 1 });
    expect(db.listCollections(root.path).map((c) => c.id)).toEqual(['sub']);
    db.recursiveDelete(root);
    expect(root.get().exists).toBe(false);
    expect(db.collection(`${root.path}/sub/s1/deep`).get().size).toBe(0);
    db.recursiveDelete(db.collection(col('batch')));
    expect(db.collection(col('batch')).get().size).toBe(0);
  });
});

function signUp(email: string): { idToken: string; localId: string } {
  const { config } = platform;
  const r = platform.fetch(`${config.identityBaseUrl}/v1/accounts:signUp?key=${config.webApiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
  });
  return JSON.parse(r.body);
}

describe('auth emulator + router', () => {
  it('verifies an emulator ID token and rejects garbage', () => {
    const u = signUp(`${run}@example.com`);
    const v = verifyIdToken(platform, u.idToken);
    expect(v.uid).toBe(u.localId);
    expect(v.authTime).toBeGreaterThan(0);
    expect(() => verifyIdToken(platform, 'garbage')).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
  });
  it('end to end through dispatch with requireMember', () => {
    const u = signUp(`${run}-2@example.com`);
    const fid = `fam_${run}`;
    db.doc(`families/${fid}`).set({ name: 'F', ownerUid: u.localId, status: 'active' });
    db.doc(`families/${fid}/members/${u.localId}`).set({ uid: u.localId, role: 'owner', status: 'active' });
    const handlers = { who: (ctx: CallContext, d: { familyId: string }) => requireMember(ctx, d.familyId).member.role };
    const ok = JSON.parse(dispatch(platform, JSON.stringify({ fn: 'who', data: { familyId: fid }, idToken: u.idToken }), handlers));
    expect(ok).toEqual({ ok: true, result: 'owner' });
    const other = signUp(`${run}-3@example.com`);
    const ng = JSON.parse(dispatch(platform, JSON.stringify({ fn: 'who', data: { familyId: fid }, idToken: other.idToken }), handlers));
    expect(ng.error.code).toBe('permission-denied');
    db.recursiveDelete(db.doc(`families/${fid}`));
  });
});
