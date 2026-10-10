import { describe, expect, it } from 'vitest';
import { FieldValue } from './field-value';
import { Timestamp } from './timestamp';
import { buildCreate, buildSet, buildUpdate } from './writes';

const root = 'projects/p/databases/(default)/documents';
const name = `${root}/d/1`;

describe('writes', () => {
  it('set: serverTimestamp becomes a transform and is removed from fields', () => {
    const w = buildSet(name, { a: 1, at: FieldValue.serverTimestamp(), m: { t: FieldValue.serverTimestamp(), x: 'y' } }, false, root);
    expect(w.update!.fields).toEqual({ a: { integerValue: '1' }, m: { mapValue: { fields: { x: { stringValue: 'y' } } } } });
    expect(w.updateTransforms).toEqual([
      { fieldPath: 'at', setToServerValue: 'REQUEST_TIME' },
      { fieldPath: 'm.t', setToServerValue: 'REQUEST_TIME' },
    ]);
    expect(w.updateMask).toBeUndefined();
    expect(w.currentDocument).toBeUndefined();
  });
  it('set: sentinel-only nested map is omitted from fields', () => {
    const w = buildSet(name, { m: { t: FieldValue.serverTimestamp() } }, false, root);
    expect(w.update!.fields).toEqual({});
  });
  it('set: FieldValue.delete() without merge is rejected', () => {
    expect(() => buildSet(name, { a: FieldValue.delete() }, false, root)).toThrow();
  });
  it('set merge: mask lists leaf paths and deletes', () => {
    const w = buildSet(name, { a: { b: 1, c: { d: 2 } }, e: FieldValue.delete(), f: {} }, true, root);
    expect(w.updateMask!.fieldPaths.sort()).toEqual(['a.b', 'a.c.d', 'e', 'f']);
  });
  it('create: precondition exists=false', () => {
    expect(buildCreate(name, { a: 1 }, root).currentDocument).toEqual({ exists: false });
  });
  it('update: dotted keys build nested fields and mask; exists=true', () => {
    const w = buildUpdate(name, { 'a.b.c': 1, 'x': 'y', z: undefined }, root);
    expect(w.update!.fields).toEqual({
      a: { mapValue: { fields: { b: { mapValue: { fields: { c: { integerValue: '1' } } } } } } },
      x: { stringValue: 'y' },
    });
    expect(w.updateMask!.fieldPaths).toEqual(['a.b.c', 'x']);
    expect(w.currentDocument).toEqual({ exists: true });
  });
  it('update: a map value replaces the whole field', () => {
    const w = buildUpdate(name, { settings: { theme: 'dark' } }, root);
    expect(w.updateMask!.fieldPaths).toEqual(['settings']);
  });
  it('update: delete / increment / arrayUnion / arrayRemove / Timestamp', () => {
    const t = Timestamp.fromMillis(0);
    const w = buildUpdate(name, {
      gone: FieldValue.delete(), 'n.count': FieldValue.increment(2), tags: FieldValue.arrayUnion('a', 'b'), old: FieldValue.arrayRemove('z'), ts: t,
      at: FieldValue.serverTimestamp(),
    }, root);
    expect(w.updateMask!.fieldPaths).toEqual(['gone', 'ts']);
    expect(w.update!.fields).toEqual({ ts: { timestampValue: '1970-01-01T00:00:00.000000000Z' } });
    expect(w.updateTransforms).toEqual([
      { fieldPath: 'n.count', increment: { integerValue: '2' } },
      { fieldPath: 'tags', appendMissingElements: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
      { fieldPath: 'old', removeAllFromArray: { values: [{ stringValue: 'z' }] } },
      { fieldPath: 'at', setToServerValue: 'REQUEST_TIME' },
    ]);
  });
  it('quotes unusual field names', () => {
    const w = buildSet(name, { 'a-b': { 'c d': 1 } }, true, root);
    expect(w.updateMask!.fieldPaths).toEqual(['`a-b`.`c d`']);
  });
});
