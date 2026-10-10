import { describe, expect, it } from 'vitest';
import { decodeValue, encodeDoc, encodeValue, isoToTs, tsToIso } from './codec';
import { fileName, jstStamp, parseName, planRetention, selectTrash, stampToMs, type DriveFile } from './retention';
import { isBlockedPath } from './index';
import { DELETION_RETENTION_DAYS } from '../shared/deletions';

class FakeTs {
  constructor(public seconds: number, public nanoseconds: number) {}
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
}

describe('Timestamp 往復', () => {
  it('ナノ秒まで往復できる', () => {
    const t = new FakeTs(1790000000, 123456789);
    const enc = encodeValue({ a: t, nested: { list: [t, 1, 'x', null, true] } }) as Record<string, any>;
    expect(enc.a).toEqual({ __ts: '2026-09-21T14:13:20.123456789Z' });
    const dec = decodeValue(JSON.parse(JSON.stringify(enc)), (s, n) => new FakeTs(s, n)) as Record<string, any>;
    expect(dec.a).toBeInstanceOf(FakeTs);
    expect(dec.a.seconds).toBe(1790000000);
    expect(dec.a.nanoseconds).toBe(123456789);
    expect(dec.nested.list[0].nanoseconds).toBe(123456789);
    expect(dec.nested.list.slice(1)).toEqual([1, 'x', null, true]);
  });
  it('ISO 変換', () => {
    expect(isoToTs(tsToIso(0, 5))).toEqual({ seconds: 0, nanoseconds: 5 });
    expect(isoToTs('2026-01-01T00:00:00Z')).toEqual({ seconds: Date.UTC(2026, 0, 1) / 1000, nanoseconds: 0 });
    expect(() => isoToTs('bad')).toThrow();
  });
  it('Date も Timestamp として保存', () => {
    expect(encodeValue(new Date(1500))).toEqual({ __ts: '1970-01-01T00:00:01.500000000Z' });
  });
});

describe('端末トークンの除外', () => {
  it('devices の fcmToken は含めない', () => {
    const d = encodeDoc('users/u1/devices/d1', { fcmToken: 'secret', platform: 'ios', pushEnabled: true }) as { data: Record<string, unknown> };
    expect(d.data).toEqual({ platform: 'ios', pushEnabled: true });
    const o = encodeDoc('families/f1', { fcmToken: 'keep-because-not-device' }) as { data: Record<string, unknown> };
    expect(o.data.fcmToken).toBeDefined();
  });
});

describe('ファイル名', () => {
  it('生成と解析が往復する', () => {
    const stamp = jstStamp(Date.UTC(2026, 9, 10, 18, 0)); // JST 10/11 03:00
    expect(stamp).toBe('20261011-0300');
    expect(fileName('full', stamp, 1)).toBe('chub-full-20261011-0300.json');
    expect(parseName(fileName('incremental', stamp, 3))).toEqual({ kind: 'incremental', stamp, part: 3 });
    expect(parseName(fileName('full', stamp, 'manifest'))).toEqual({ kind: 'full', stamp, part: 'manifest' });
    expect(parseName('other.json')).toBeNull();
    expect(stampToMs(stamp)).toBe(Date.UTC(2026, 9, 10, 18, 0));
  });
});

describe('世代選別', () => {
  let seq = 0;
  const mk = (kind: 'full' | 'incremental', stamp: string, complete = true): DriveFile[] => {
    const out: DriveFile[] = [{ id: `${kind}${stamp}-1`, name: fileName(kind, stamp, 1), createdAt: new Date() }];
    if (complete) out.push({ id: `${kind}${stamp}-m${seq++}`, name: fileName(kind, stamp, 'manifest'), createdAt: new Date() });
    return out;
  };
  const now = Date.UTC(2026, 9, 12, 0, 0); // JST 10/12 09:00

  it('フルも14日以上経過した全ファイルを削除する', () => {
    const files = ['20260901', '20260908', '20260915', '20260922', '20260929', '20261006'].flatMap((d) => mk('full', `${d}-0300`));
    const trash = selectTrash(files, now);
    expect(trash.sort()).toEqual(files.filter((f) => /20260901|20260908|20260915|20260922/.test(f.name)).map((f) => f.id).sort());
  });
  it('差分は14日を超えたものを削除', () => {
    const files = [...mk('incremental', '20260920-0300'), ...mk('incremental', '20261001-0300'), ...mk('incremental', '20261011-0300')];
    const trash = selectTrash(files, now);
    expect(trash.filter((id) => id.includes('20260920')).length).toBe(2);
    expect(trash.some((id) => id.includes('20261001') || id.includes('20261011'))).toBe(false);
  });
  it('未完了は3日以内なら残し、超えたら削除。無関係なファイルには触れない', () => {
    const files = [...mk('full', '20261011-0300', false), ...mk('full', '20261001-0300', false),
      { id: 'x', name: 'notes.txt', createdAt: new Date() }];
    const trash = selectTrash(files, now);
    expect(trash).toEqual(['full20261001-0300-1']);
  });
});

describe('最新バックアップの保持', () => {
  const mk = (kind: 'full' | 'incremental', stamp: string, complete = true): DriveFile[] => {
    const out: DriveFile[] = [{ id: `${kind}${stamp}-1`, name: fileName(kind, stamp, 1), createdAt: new Date() }];
    if (complete) out.push({ id: `${kind}${stamp}-m`, name: fileName(kind, stamp, 'manifest'), createdAt: new Date() });
    return out;
  };
  const now = Date.UTC(2026, 9, 12, 0, 0);
  it('期限内のフルがあれば古いフルは削除し、stale ではない', () => {
    const files = [...mk('full', '20260920-0300'), ...mk('full', '20261011-0300')];
    const plan = planRetention(files, now);
    expect(plan.stale).toBe(false);
    expect(plan.trash.every((id) => id.includes('20260920'))).toBe(true);
    expect(plan.trash.length).toBe(2);
  });
  it('期限外のフルしか無ければ最新フルとその後の差分を残し stale にする', () => {
    const files = [...mk('full', '20260901-0300'), ...mk('full', '20260915-0300'), ...mk('incremental', '20260910-0300'), ...mk('incremental', '20260916-0300')];
    const plan = planRetention(files, now);
    expect(plan.stale).toBe(true);
    expect(plan.trash.sort()).toEqual(['full20260901-0300-1', 'full20260901-0300-m', 'incremental20260910-0300-1', 'incremental20260910-0300-m']);
  });
  it('未完了フルだけの場合は完了世代が無いので stale ではない', () => {
    expect(planRetention(mk('full', '20261011-0300', false), now).stale).toBe(false);
  });
});

describe('削除記録の判定と期限', () => {
  it('パスと祖先プレフィックスで判定する', () => {
    const set = new Set(['families/f1', 'users/u1/familyRefs/f1']);
    expect(isBlockedPath(set, 'families/f1')).toBe(true);
    expect(isBlockedPath(set, 'families/f1/children/c1/events/e1')).toBe(true);
    expect(isBlockedPath(set, 'families/f2/members/u1')).toBe(false);
    expect(isBlockedPath(set, 'users/u1/familyRefs/f1')).toBe(true);
    expect(isBlockedPath(set, 'users/u1/settings/main')).toBe(false);
  });
  it('削除記録の保持はバックアップ14日より長い', () => {
    expect(DELETION_RETENTION_DAYS).toBe(21);
  });
});
