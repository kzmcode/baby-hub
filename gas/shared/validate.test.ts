import { describe, it, expect } from 'vitest';
import { Timestamp } from '../core/firestore';
import {
  validateObject, validateEventPatch, validatePayloadPatch, assertPayloadComplete, validateDocPatch, resolveDocPath,
  isValidDateString, isValidIso, isHttpsUrl, isValidId, applyPatch, validateFullPayload, KIND_DEFS, asRevision,
} from './validate';

const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };

describe('primitives', () => {
  it('date', () => {
    expect(isValidDateString('2026-02-28')).toBe(true);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026/02/28')).toBe(false);
  });
  it('iso', () => {
    expect(isValidIso('2026-10-08T12:00:00+09:00')).toBe(true);
    expect(isValidIso('yesterday')).toBe(false);
  });
  it('https only', () => {
    expect(isHttpsUrl('https://example.com/a')).toBe(true);
    expect(isHttpsUrl('http://example.com')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
  });
  it('id', () => {
    expect(isValidId('abc')).toBe(true);
    expect(isValidId('a/b')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId('..')).toBe(false);
  });
  it('revision', () => {
    expect(asRevision(3)).toBe(3);
    expect(code(() => asRevision(0))).toBe('invalid-argument');
    expect(code(() => asRevision('1'))).toBe('invalid-argument');
  });
});

describe('validateObject', () => {
  it('rejects unknown keys and bad types', () => {
    const f = { a: { spec: { k: 'str' as const } } };
    expect(code(() => validateObject(f, { a: 'x', b: 1 }))).toBe('invalid-argument');
    expect(code(() => validateObject(f, { a: 1 }))).toBe('invalid-argument');
    expect(code(() => validateObject(f, { a: 'x'.repeat(201) }))).toBe('invalid-argument');
    expect(code(() => validateObject(f, {}, { required: ['a'] }))).toBe('invalid-argument');
    expect(code(() => validateObject(f, [] as unknown))).toBe('invalid-argument');
    expect(code(() => validateObject(f, { __proto__: 1, a: 'x' }))).toBe('ok');
  });
  it('null semantics', () => {
    const f = { s: { spec: { k: 'str' as const }, null: 'store' as const }, d: { spec: { k: 'str' as const }, null: 'delete' as const } };
    const v = validateObject(f, { s: null, d: null });
    expect(v.set).toEqual({ s: null });
    expect(v.del).toEqual(['d']);
  });
  it('error message does not leak values', () => {
    try { validateObject({ a: { spec: { k: 'str' } } }, { a: 5 }); } catch (e) { expect((e as Error).message).not.toContain('5'); }
  });
});

describe('event payload', () => {
  it('range checks', () => {
    expect(code(() => validatePayloadPatch('feeding', { consumedMl: 501 }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('feeding', { consumedMl: -1 }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('feeding', { consumedMl: NaN }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('feeding', { leftSeconds: 7201 }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('temperature', { celsius: 29.9 }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('temperature', { celsius: 45.1 }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('temperature', { celsius: 36.8 }))).toBe('ok');
    expect(code(() => validatePayloadPatch('growth', { heightCm: 19 }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('growth', { weightGrams: 299 }))).toBe('invalid-argument');
    expect(code(() => validatePayloadPatch('feeding', { bogus: 1 }))).toBe('invalid-argument');
  });
  it('medication_taken / unknown type is not editable', () => {
    expect(code(() => validatePayloadPatch('medication_taken', {}))).toBe('failed-precondition');
  });
  it('sleep session link is immutable', () => {
    expect(code(() => validatePayloadPatch('sleep_start', { sessionId: 'x' }))).toBe('invalid-argument');
  });
  it('completeness after merge', () => {
    expect(code(() => assertPayloadComplete('diaper', { urine: 'yes', stool: 'no' }))).toBe('invalid-argument');
    expect(code(() => assertPayloadComplete('diaper', { urine: 'yes', stool: 'no', changed: true }))).toBe('ok');
    expect(code(() => assertPayloadComplete('growth', {}))).toBe('invalid-argument');
    expect(code(() => assertPayloadComplete('growth', { weightGrams: 3000 }))).toBe('ok');
  });
  it('full payload', () => {
    expect(code(() => validateFullPayload('feeding', { method: 'breast' }))).toBe('ok');
    expect(code(() => validateFullPayload('feeding', {}))).toBe('invalid-argument');
  });
  it('applyPatch removes deleted keys', () => {
    const v = validatePayloadPatch('feeding', { consumedMl: null, leftSeconds: 60 });
    expect(applyPatch({ method: 'formula', consumedMl: 100 }, v)).toEqual({ method: 'formula', leftSeconds: 60 });
  });
});

describe('validateEventPatch', () => {
  it('rejects empty / unknown / type change', () => {
    expect(code(() => validateEventPatch({}))).toBe('invalid-argument');
    expect(code(() => validateEventPatch({ type: 'memo' }))).toBe('invalid-argument');
    expect(code(() => validateEventPatch({ status: 'void' }))).toBe('invalid-argument');
  });
  it('converts times and keeps null caregiver', () => {
    const { v } = validateEventPatch({ occurredAt: '2026-10-08T10:00:00Z', caregiverUid: null, endedAt: null, note: null });
    expect(v.set.occurredAt).toBeInstanceOf(Timestamp);
    expect(v.set.caregiverUid).toBeNull();
    expect(v.del.sort()).toEqual(['endedAt', 'note']);
  });
  it('contextEventIds <= 20', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `e${i}`);
    expect(code(() => validateEventPatch({ contextEventIds: ids }))).toBe('invalid-argument');
    expect(code(() => validateEventPatch({ contextEventIds: ids.slice(0, 20) }))).toBe('ok');
  });
});

describe('updateDoc kinds', () => {
  it('whitelist per kind', () => {
    expect(code(() => validateDocPatch('task', { title: 't', revision: 5 }))).toBe('invalid-argument');
    expect(code(() => validateDocPatch('task', { sourceUrl: 'http://x.example' }))).toBe('invalid-argument');
    expect(code(() => validateDocPatch('task', { sourceUrl: 'https://x.example', dueDate: null }))).toBe('ok');
    expect(code(() => validateDocPatch('shopping', { quantity: 1.5 }))).toBe('invalid-argument');
    expect(code(() => validateDocPatch('handover', { text: 'x'.repeat(2001) }))).toBe('invalid-argument');
    expect(code(() => validateDocPatch('contact', {}))).toBe('invalid-argument');
    expect(code(() => validateDocPatch('healthProfile', { allergies: [{ name: 'egg', confirmation: 'suspected' }] }))).toBe('ok');
    expect(code(() => validateDocPatch('healthProfile', { allergies: [{ name: 'egg', confirmation: 'maybe' }] }))).toBe('invalid-argument');
  });
  it('collects uids', () => {
    expect(validateDocPatch('schedule', { assigneeUids: ['a', 'b'] }).uids).toEqual(['a', 'b']);
  });
  it('schedule consistency', () => {
    const check = KIND_DEFS.schedule.check!;
    expect(code(() => check({ allDay: true }))).toBe('invalid-argument');
    expect(code(() => check({ allDay: true, date: '2026-10-08' }))).toBe('ok');
    expect(code(() => check({ allDay: false }))).toBe('invalid-argument');
    const s = Timestamp.fromMillis(2000);
    const e = Timestamp.fromMillis(1000);
    expect(code(() => check({ allDay: false, startAt: s, endAt: e }))).toBe('invalid-argument');
  });
  it('path resolution', () => {
    expect(resolveDocPath('task', 'f', undefined, 't')).toBe('families/f/tasks/t');
    expect(resolveDocPath('medication', 'f', 'c', 'm')).toBe('families/f/children/c/medications/m');
    expect(resolveDocPath('healthProfile', 'f', 'c', 'main')).toBe('families/f/children/c/healthProfiles/main');
    expect(code(() => resolveDocPath('medication', 'f', undefined, 'm'))).toBe('invalid-argument');
    expect(resolveDocPath('child', 'f', undefined, 'c')).toBe('families/f/children/c');
    expect(code(() => resolveDocPath('child', 'f', 'x', 'c'))).toBe('invalid-argument');
  });
});

describe('web が送る updateDoc patch の null クリア', () => {
  it('optional fields accept null', () => {
    const cases: [Parameters<typeof validateDocPatch>[0], Record<string, unknown>][] = [
      ['healthProfile', { allergies: [], conditionsNote: null, primaryClinic: null }],
      ['medication', { amount: null, unit: null, startDate: null, endDate: null, status: 'ended' }],
      ['vaccination', { doseLabel: '', scheduledDate: null, administeredDate: null, provider: null, source: null, scheduleId: null }],
      ['schedule', { location: null, preparation: null, date: null, startAt: null, endAt: null }],
      ['task', { deadlineBasis: null, step: null, sourceUrl: null, dueDate: null, assigneeUid: null }],
      ['handover', { expiresAt: null, status: 'resolved' }],
      ['contact', { phone: null, url: null, note: null }],
      ['medicalVisit', { observations: null, questions: null, clinicianInstructions: null, nextAction: null }],
      ['child', { birthDate: null, dueDate: null }],
    ];
    for (const [k, p] of cases) expect(code(() => validateDocPatch(k, p)), k).toBe('ok');
  });
  it('required fields reject null', () => {
    expect(code(() => validateDocPatch('medication', { name: null }))).toBe('invalid-argument');
    expect(code(() => validateDocPatch('handover', { text: null }))).toBe('invalid-argument');
  });
});
