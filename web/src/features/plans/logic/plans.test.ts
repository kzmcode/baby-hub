import { describe, expect, it } from 'vitest';
import { ackState, compareTasks, groupSchedules, homeDueTasks, isForMe, isSafeHttpsUrl, pendingHandoversForMe, taskUrgency, todaysSchedules } from './plans';
import { buildTemplateTask, missingTemplates, PROCEDURE_TEMPLATES } from './templates';
import { addDaysStr } from '../../../lib/time';

const ts = (iso: string) => ({ toDate: () => new Date(iso) });
const sch = (o: object) => ({ allDay: false, status: 'planned' as const, ...o });

describe('groupSchedules', () => {
  it('今日・明日・以降・過去に分け、終日を先に並べる', () => {
    const list = [
      sch({ id: 'a', startAt: ts('2026-10-08T03:00:00Z') }), // 12:00 JST 今日
      sch({ id: 'b', allDay: true, date: '2026-10-08' }),
      sch({ id: 'c', allDay: true, date: '2026-10-09' }),
      sch({ id: 'd', allDay: true, date: '2026-10-20' }),
      sch({ id: 'e', allDay: true, date: '2026-10-01' }),
      sch({ id: 'f', allDay: true, date: '2026-10-05' }),
    ];
    const g = groupSchedules(list, '2026-10-08');
    expect(g.today.map((s) => (s as any).id)).toEqual(['b', 'a']);
    expect(g.tomorrow).toHaveLength(1);
    expect(g.later[0].date).toBe('2026-10-20');
    expect(g.past.map((p) => p.date)).toEqual(['2026-10-05', '2026-10-01']);
  });
  it('UTC日付と JST 日付のずれを家族TZで判定', () => {
    const g = groupSchedules([sch({ startAt: ts('2026-10-07T16:00:00Z') })], '2026-10-08'); // JST 10/08 01:00
    expect(g.today).toHaveLength(1);
  });
  it('todaysSchedules はキャンセルを除く', () => {
    const l = [sch({ allDay: true, date: '2026-10-08' }), sch({ allDay: true, date: '2026-10-08', status: 'cancelled' })];
    expect(todaysSchedules(l, '2026-10-08')).toHaveLength(1);
  });
});

describe('tasks', () => {
  const t = (o: object) => ({ status: 'todo' as const, ...o });
  it('urgency', () => {
    expect(taskUrgency(t({ dueDate: '2026-10-07' }), '2026-10-08')).toBe('overdue');
    expect(taskUrgency(t({ dueDate: '2026-10-08' }), '2026-10-08')).toBe('today');
    expect(taskUrgency(t({ dueDate: '2026-10-10' }), '2026-10-08')).toBe('soon');
    expect(taskUrgency(t({ dueDate: '2026-11-10' }), '2026-10-08')).toBe('none');
    expect(taskUrgency({ status: 'done', dueDate: '2026-10-01' }, '2026-10-08')).toBe('none');
  });
  it('compare: 完了は後、期限なしは後', () => {
    const l: { status: 'todo' | 'done'; dueDate?: string }[] = [t({}), { status: 'done', dueDate: '2026-01-01' }, t({ dueDate: '2026-10-09' })];
    l.sort(compareTasks);
    expect(l[0].dueDate).toBe('2026-10-09');
    expect(l[2].status).toBe('done');
  });
  it('homeDueTasks: 本人→未担当、他者担当と未来を除外', () => {
    const l = [
      t({ id: 'un', dueDate: '2026-10-08', assigneeUid: null }),
      t({ id: 'me', dueDate: '2026-10-08', assigneeUid: 'u1' }),
      t({ id: 'other', dueDate: '2026-10-08', assigneeUid: 'u2' }),
      t({ id: 'future', dueDate: '2026-10-09', assigneeUid: 'u1' }),
      t({ id: 'nodue', assigneeUid: 'u1' }),
    ];
    expect(homeDueTasks(l, 'u1', '2026-10-08').map((x) => (x as any).id)).toEqual(['me', 'un']);
  });
  it('https のみ', () => {
    expect(isSafeHttpsUrl('https://city.example.jp/a')).toBe(true);
    expect(isSafeHttpsUrl('http://x.jp')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpsUrl('abc')).toBe(false);
  });
});

describe('handover', () => {
  const h = (o: object) => ({ priority: 'normal' as const, recipientUids: [], status: 'open' as const, revision: 1, createdBy: 'u2', ...o });
  it('ackState', () => {
    expect(ackState({ revision: 1 }, null)).toBe('none');
    expect(ackState({ revision: 2 }, { handoverRevision: 1 })).toBe('stale');
    expect(ackState({ revision: 2 }, { handoverRevision: 2 })).toBe('acked');
  });
  it('isForMe', () => {
    expect(isForMe(h({}), 'u1')).toBe(true);
    expect(isForMe(h({}), 'u2')).toBe(false);
    expect(isForMe(h({ recipientUids: ['u3'] }), 'u1')).toBe(false);
  });
  it('pending: 重要が上、確認済み・解決済み・期限切れを除外、stale は含む', () => {
    const now = new Date('2026-10-08T00:00:00Z');
    const l = [
      { id: 'n', ...h({ createdAtMs: 5 }) },
      { id: 'i', ...h({ priority: 'important', createdAtMs: 1 }) },
      { id: 'acked', ...h({}) },
      { id: 'res', ...h({ status: 'resolved' }) },
      { id: 'exp', ...h({ expiresAt: ts('2026-10-01T00:00:00Z') }) },
      { id: 'stale', ...h({ revision: 2, createdAtMs: 9 }) },
    ];
    const acks = { acked: { handoverRevision: 1 }, stale: { handoverRevision: 1 } };
    const r = pendingHandoversForMe(l, acks, (x) => x.id, 'u1', now);
    expect(r.map((x) => x.id)).toEqual(['i', 'stale', 'n']);
  });
});

describe('templates', () => {
  it('確定期限・URLを持たない', () => {
    const t = buildTemplateTask(PROCEDURE_TEMPLATES[0], '2026-10-01', addDaysStr);
    expect(t.deadlineVerified).toBe(false);
    expect(t.dueDate).toBe('2026-10-15');
    expect(buildTemplateTask(PROCEDURE_TEMPLATES[2], '2026-10-01', addDaysStr).dueDate).toBeNull();
    expect(buildTemplateTask(PROCEDURE_TEMPLATES[0], null, addDaysStr).dueDate).toBeNull();
    expect('sourceUrl' in t).toBe(false);
  });
  it('既存を除く', () => {
    expect(missingTemplates([PROCEDURE_TEMPLATES[0].title])).toHaveLength(PROCEDURE_TEMPLATES.length - 1);
  });
});
