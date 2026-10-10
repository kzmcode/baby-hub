import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors';
import { fakePlatform } from '../test-utils';
import { Firestore } from './client';

const ok = (b: unknown = {}) => ({ status: 200, body: JSON.stringify(b) });
const aborted = { status: 409, body: JSON.stringify({ error: { code: 409, status: 'ABORTED', message: 'x' } }) };

describe('Firestore client', () => {
  it('runTransaction retries on ABORTED at commit and succeeds', () => {
    const urls: string[] = [];
    let commits = 0;
    const p = fakePlatform((url) => {
      urls.push(url.replace('http://fs/v1/projects/demo-test/databases/(default)/documents', ''));
      if (url.endsWith(':beginTransaction')) return ok({ transaction: 'T' });
      if (url.endsWith(':commit')) return ++commits < 3 ? aborted : ok({});
      return ok({});
    });
    let runs = 0;
    const r = new Firestore(p).runTransaction((tx) => {
      runs++;
      tx.set(tx.firestore.doc('a/b'), { x: 1 });
      return 'done';
    });
    expect(r).toBe('done');
    expect(runs).toBe(3);
  });
  it('does not retry user ApiError(aborted) and rolls back', () => {
    const urls: string[] = [];
    const p = fakePlatform((url) => {
      urls.push(url);
      return url.endsWith(':beginTransaction') ? ok({ transaction: 'T' }) : ok({});
    });
    let runs = 0;
    expect(() => new Firestore(p).runTransaction(() => { runs++; throw new ApiError('aborted', 'mine'); })).toThrow('mine');
    expect(runs).toBe(1);
    expect(urls.some((u) => u.endsWith(':rollback'))).toBe(true);
  });
  it('gives up after 5 attempts with aborted', () => {
    const p = fakePlatform((url) => (url.endsWith(':beginTransaction') ? ok({ transaction: 'T' }) : url.endsWith(':commit') ? aborted : ok({})));
    let runs = 0;
    try { new Firestore(p).runTransaction(() => { runs++; }); } catch (e) { expect((e as ApiError).code).toBe('aborted'); }
    expect(runs).toBe(5);
  });
  it('rejects reads after writes in a transaction', () => {
    const p = fakePlatform((url) => (url.endsWith(':beginTransaction') ? ok({ transaction: 'T' }) : ok({})));
    expect(() => new Firestore(p).runTransaction((tx) => {
      tx.set(tx.firestore.doc('a/b'), {});
      tx.get(tx.firestore.doc('a/b'));
    })).toThrow(/reads/);
  });
  it('batch splits into chunks of 500', () => {
    let commits = 0;
    const p = fakePlatform((url) => { if (url.endsWith(':commit')) commits++; return ok({}); });
    const db = new Firestore(p);
    const b = db.batch();
    for (let i = 0; i < 1001; i++) b.set(db.doc(`c/${i}`), { i });
    b.commit();
    expect(commits).toBe(3);
  });
  it('maps statuses to ApiError codes and validates paths', () => {
    const p = fakePlatform(() => ({ status: 409, body: JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }) }));
    const db = new Firestore(p);
    expect(() => db.doc('a/b').create({})).toThrow(expect.objectContaining({ code: 'already-exists' }));
    expect(() => db.doc('a')).toThrow();
    expect(() => db.collection('a/b')).toThrow();
    expect(() => db.doc('a/../b')).toThrow();
  });
  it('builds a structured query', () => {
    const urls: { url: string; body: string }[] = [];
    const p = fakePlatform((url, init) => { urls.push({ url, body: init.body! }); return ok([{ readTime: 'x' }]); });
    const db = new Firestore(p);
    const qs = db.collection('families/f/events').where('status', '==', 'active').where('n', '>', 1).orderBy('at', 'desc').limit(3).get();
    expect(qs.empty).toBe(true);
    expect(urls[0]!.url).toBe('http://fs/v1/projects/demo-test/databases/(default)/documents/families/f:runQuery');
    const sq = JSON.parse(urls[0]!.body).structuredQuery;
    expect(sq.from).toEqual([{ collectionId: 'events' }]);
    expect(sq.where.compositeFilter.filters).toHaveLength(2);
    expect(sq.orderBy).toEqual([{ field: { fieldPath: 'at' }, direction: 'DESCENDING' }]);
    expect(sq.limit).toBe(3);
  });
  it('403 logs only status codes, never the message (which may contain resource paths)', () => {
    const p = fakePlatform(() => ({ status: 403, body: JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Missing permission on projects/x/databases/(default)/documents/families/SECRETFAMILY' } }) }), { emulator: false });
    const db = new Firestore(p);
    expect(() => db.doc('a/b').get()).toThrow(expect.objectContaining({ code: 'internal' }));
    const dump = JSON.stringify(p.logs);
    expect(dump).not.toContain('SECRETFAMILY');
    expect(dump).toContain('PERMISSION_DENIED');
  });
});
