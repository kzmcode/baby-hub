// 結合スモークテスト: Auth/Firestore エミュレータ + GAS dev-server 上で Web クライアントと同じ書込み形式の主要フローを通す。
// 書込み形式は web/src/lib/db.ts (createEvent, createFamilyDoc)、features/plans/{payload,data}.ts、
// features/health/{ProfilePage,MedicationsPage}.tsx、context/UserSettingsContext.tsx から写している。
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, type Auth } from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, deleteDoc as clientDeleteDoc, doc, getDoc, getDocs, getFirestore, serverTimestamp, setDoc, Timestamp, updateDoc as clientUpdateDoc,
  type Firestore,
} from 'firebase/firestore';
import { PROJECT, gasCall, GasError } from './helpers';


interface Client { name: string; app: FirebaseApp; auth: Auth; db: Firestore; uid: string }

async function makeClient(name: string): Promise<Client> {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-key', appId: 'fake' }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const cred = await createUserWithEmailAndPassword(auth, `${name}-${Date.now()}@example.com`, 'password123');
  return { name, app, auth, db, uid: cred.user.uid };
}

// ---- web/src/lib/api.ts 相当（GAS dev-server への fetch。エラーは code / details を取り出す） ----
async function call<O = any>(c: Client, name: string, data: unknown): Promise<O> {
  return gasCall<O>(c.auth, name, data);
}
async function callErr(c: Client, name: string, data: unknown): Promise<{ code: string; details?: any }> {
  try {
    await call(c, name, data);
  } catch (e: any) {
    if (e instanceof GasError) return { code: e.code, details: e.details };
    throw e;
  }
  throw new Error(`${name} は失敗するはずが成功した`);
}
async function denied(p: Promise<unknown>) {
  try { await p; } catch (e: any) { expect(e.code).toBe('permission-denied'); return; }
  throw new Error('permission-denied のはずが成功した');
}

// ---- web/src/lib/db.ts の stripUndefined / createEvent / createFamilyDoc を写したもの ----
function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripUndefined) as any;
  if (v && typeof v === 'object' && !(v instanceof Timestamp) && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = stripUndefined(val);
    return out as T;
  }
  return v;
}
interface EventInput {
  type: string; occurredAt: Date; endedAt?: Date; caregiverUid?: string | null; payload: Record<string, unknown>;
  note?: string; sessionId?: string; contextEventIds?: string[]; id?: string;
}
function eventRef(c: Client, f: string, ch: string, id: string) { return doc(c.db, 'families', f, 'children', ch, 'events', id); }
async function createEvent(c: Client, f: string, ch: string, input: EventInput): Promise<string> {
  const id = input.id ?? crypto.randomUUID();
  const data = stripUndefined({
    schemaVersion: 1, childId: ch, type: input.type,
    occurredAt: Timestamp.fromDate(input.occurredAt),
    endedAt: input.endedAt ? Timestamp.fromDate(input.endedAt) : undefined,
    recordedAt: Timestamp.now(),
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    createdBy: c.uid, updatedBy: c.uid,
    caregiverUid: input.caregiverUid === undefined ? c.uid : input.caregiverUid,
    sessionId: input.sessionId, contextEventIds: input.contextEventIds,
    payload: input.payload, note: input.note, revision: 1, status: 'active',
  });
  await setDoc(eventRef(c, f, ch, id), data);
  return id;
}
async function createFamilyDoc(c: Client, collectionPath: string, data: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  await setDoc(doc(c.db, collectionPath, id), stripUndefined({
    ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: c.uid, updatedBy: c.uid, revision: 1,
  }));
  return id;
}
// features/plans/types.ts omitNull
function omitNull(o: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

const T0 = Date.now() - 3 * 3600_000;
const at = (min: number) => new Date(T0 + min * 60_000);

let A: Client, B: Client, C: Client;
let familyId = '', childId = '', token = '', inviteId = '';
const ids: Record<string, string> = {};

beforeAll(async () => {
  A = await makeClient('userA');
  B = await makeClient('userB');
  C = await makeClient('userC');
});

describe('家族作成・招待', () => {
  it('A: createFamily (SetupPage と同じ入力)', async () => {
    const r = await call(A, 'createFamily', { familyName: 'テスト家', displayName: 'パパ', child: { nickname: 'はる', birthDate: '2026-08-01' } });
    familyId = r.familyId; childId = r.childId;
    expect(familyId && childId).toBeTruthy();
    const u = await getDoc(doc(A.db, 'users', A.uid));
    expect(u.exists()).toBe(true);
  });

  it('A: users/{uid}.settings を merge 書込み (UserSettingsContext.update)', async () => {
    const settings = {
      theme: 'dark',
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      notify: { handoverImportant: true, handoverNormal: false, scheduleReminder: true, taskDue: true, dose: true },
      homeItems: [
        { key: 'status', visible: true }, { key: 'quickRecord', visible: true }, { key: 'todayRhythm', visible: true },
        { key: 'recent', visible: true }, { key: 'handovers', visible: true }, { key: 'todayPlans', visible: true }, { key: 'shopping', visible: false },
      ],
      quickRecordTypes: ['diaper', 'feeding', 'vomit', 'sleep', 'bath', 'other'],
    };
    await setDoc(doc(A.db, 'users', A.uid), { settings }, { merge: true });
    const u = (await getDoc(doc(A.db, 'users', A.uid))).data()!;
    expect(u.settings.theme).toBe('dark');
    expect(u.displayName).toBeTruthy(); // 既存フィールドが merge で保持される
  });

  it('A: createInvite', async () => {
    const r = await call(A, 'createInvite', { familyId });
    token = r.token; inviteId = r.inviteId;
    expect(token.length).toBeGreaterThan(20);
  });

  it('B: previewInvite -> acceptInvite -> family/members/children 読取', async () => {
    const p = await call(B, 'previewInvite', { token });
    expect(p.familyName).toBe('テスト家');
    const r = await call(B, 'acceptInvite', { token, displayName: 'ママ' });
    expect(r.familyId).toBe(familyId);
    expect((await getDoc(doc(B.db, 'families', familyId))).exists()).toBe(true);
    const members = await getDocs(collection(B.db, 'families', familyId, 'members'));
    expect(members.size).toBe(2);
    const children = await getDocs(collection(B.db, 'families', familyId, 'children'));
    expect(children.size).toBe(1);
  });

  it('招待の再利用は拒否 (C) / 第三者 C は family を読めない', async () => {
    const e = await callErr(C, 'acceptInvite', { token, displayName: 'だれか' });
    expect(['failed-precondition', 'not-found', 'permission-denied', 'already-exists']).toContain(e.code);
    await denied(getDoc(doc(C.db, 'families', familyId)));
    await denied(getDocs(collection(C.db, 'families', familyId, 'children')));
    await denied(getDoc(doc(C.db, 'invites', inviteId)));
  });
});

describe('イベント', () => {
  it('A: feeding(量あり/量なし), diaper, vomit, bath, memo', async () => {
    ids.feedMl = await createEvent(A, familyId, childId, { type: 'feeding', occurredAt: at(0), payload: { method: 'formula', consumedMl: 120 } });
    ids.feedNoMl = await createEvent(A, familyId, childId, { type: 'feeding', occurredAt: at(10), payload: { method: 'formula' }, note: '量不明' });
    await createEvent(A, familyId, childId, { type: 'feeding', occurredAt: at(11), payload: { method: 'breast', leftSeconds: 300, rightSeconds: 240 } });
    await createEvent(A, familyId, childId, { type: 'pumping', occurredAt: at(12), payload: { expressedMl: 80 } });
    ids.diaper = await createEvent(A, familyId, childId, { type: 'diaper', occurredAt: at(20), payload: { urine: 'yes', stool: 'no', changed: true } });
    ids.vomit = await createEvent(A, familyId, childId, { type: 'vomit', occurredAt: at(30), payload: { amountCategory: 'small', appearanceText: 'ミルク様' } });
    await createEvent(A, familyId, childId, { type: 'bath', occurredAt: at(40), payload: { bathingMode: 'tub' } });
    await createEvent(A, familyId, childId, { type: 'bath', occurredAt: at(41), payload: {} });
    await createEvent(A, familyId, childId, { type: 'memo', occurredAt: at(50), payload: { tags: ['よく笑った'], text: '笑った' } });
  });

  it('A: sleep_start -> sleep_end (sessionId 一致)', async () => {
    const sessionId = crypto.randomUUID();
    const startId = await createEvent(A, familyId, childId, { type: 'sleep_start', occurredAt: at(60), sessionId, payload: { sessionId } });
    await createEvent(A, familyId, childId, { type: 'sleep_end', occurredAt: at(120), sessionId, payload: { sessionId, startEventId: startId } });
  });

  it('sleep の sessionId 不一致は拒否', async () => {
    const sessionId = crypto.randomUUID();
    await denied(createEvent(A, familyId, childId, { type: 'sleep_start', occurredAt: at(61), sessionId: 'other', payload: { sessionId } }));
  });

  it('B: caregiverUid=A の代理入力', async () => {
    ids.proxy = await createEvent(B, familyId, childId, { type: 'diaper', occurredAt: at(70), caregiverUid: A.uid, payload: { urine: 'no', stool: 'yes', changed: true, stoolNote: '普通' } });
    const d = (await getDoc(eventRef(A, familyId, childId, ids.proxy))).data()!;
    expect(d.caregiverUid).toBe(A.uid);
    expect(d.createdBy).toBe(B.uid);
  });

  it('クライアントから medication_taken 作成は拒否', async () => {
    await denied(createEvent(A, familyId, childId, { type: 'medication_taken', occurredAt: at(80), payload: { medicationId: 'x', occurrenceId: 'y' } }));
  });

  it('B: updateEvent 時刻訂正(RecordSheet の編集形: null で項目削除) expectedRevision=1', async () => {
    const r = await call(B, 'updateEvent', {
      familyId, childId, eventId: ids.feedNoMl, expectedRevision: 1,
      patch: { occurredAt: at(5).toISOString(), caregiverUid: B.uid, payload: { method: 'formula', consumedMl: 90 }, note: null },
    });
    expect(r.revision).toBe(2);
    const d = (await getDoc(eventRef(A, familyId, childId, ids.feedNoMl))).data()!;
    expect(d.payload.consumedMl).toBe(90);
    expect(d.note).toBeUndefined();
    expect(d.updatedBy).toBe(B.uid);
  });

  it('B: updateEvent で payload の null (量を消す / stoolNote を消す) が通る', async () => {
    const r1 = await call(B, 'updateEvent', {
      familyId, childId, eventId: ids.feedMl, expectedRevision: 1,
      patch: { occurredAt: at(1).toISOString(), caregiverUid: A.uid, payload: { method: 'formula', consumedMl: null }, note: null },
    });
    expect(r1.revision).toBe(2);
    expect((await getDoc(eventRef(A, familyId, childId, ids.feedMl))).data()!.payload.consumedMl).toBeUndefined();
    const r2 = await call(B, 'updateEvent', {
      familyId, childId, eventId: ids.proxy, expectedRevision: 1,
      patch: { occurredAt: at(71).toISOString(), caregiverUid: A.uid, payload: { urine: 'no', stool: 'yes', changed: true, stoolNote: null }, note: null },
    });
    expect(r2.revision).toBe(2);
    expect((await getDoc(eventRef(A, familyId, childId, ids.proxy))).data()!.payload.stoolNote).toBeUndefined();
  });

  it('A: 古い revision の updateEvent は aborted', async () => {
    const e = await callErr(A, 'updateEvent', {
      familyId, childId, eventId: ids.feedNoMl, expectedRevision: 1,
      patch: { occurredAt: at(6).toISOString() },
    });
    expect(e.code).toBe('aborted');
    expect(e.details?.currentRevision).toBe(2);
  });

  it('contextEventIds は updateEvent でのみ設定(実在確認)。作成時の指定は拒否', async () => {
    await denied(createEvent(A, familyId, childId, { type: 'diaper', occurredAt: at(90), contextEventIds: [ids.feedMl], payload: { urine: 'yes', stool: 'no', changed: true } }));
    const r = await call(A, 'updateEvent', { familyId, childId, eventId: ids.diaper, expectedRevision: 1, patch: { contextEventIds: [ids.feedMl] } });
    expect(r.revision).toBe(2);
    expect((await getDoc(eventRef(A, familyId, childId, ids.diaper))).data()!.contextEventIds).toEqual([ids.feedMl]);
    const e = await callErr(A, 'updateEvent', { familyId, childId, eventId: ids.diaper, expectedRevision: 2, patch: { contextEventIds: ['no-such-event'] } });
    expect(['not-found', 'failed-precondition', 'invalid-argument']).toContain(e.code);
  });

  it('setEventStatus void -> active', async () => {
    const v = await call(A, 'setEventStatus', { familyId, childId, eventId: ids.vomit, expectedRevision: 1, status: 'void' });
    expect(v.revision).toBe(2);
    expect((await getDoc(eventRef(B, familyId, childId, ids.vomit))).data()!.status).toBe('void');
    const a = await call(A, 'setEventStatus', { familyId, childId, eventId: ids.vomit, expectedRevision: 2, status: 'active' });
    expect(a.revision).toBe(3);
  });

  it('クライアントからの event update/delete は拒否', async () => {
    await denied(clientUpdateDoc(eventRef(A, familyId, childId, ids.vomit), { note: 'x' }));
    await denied(clientDeleteDoc(eventRef(A, familyId, childId, ids.vomit)));
  });
});

describe('予定・ToDo・買い物・申し送り', () => {
  const col = (n: string) => `families/${familyId}/${n}`;

  it('A: schedule (終日 / 時刻付き) — scheduleCreate と同形', async () => {
    ids.schedAllDay = await createFamilyDoc(A, col('schedules'), omitNull({
      title: '健診', category: 'medical', allDay: true, date: '2026-10-20', startAt: null, endAt: null,
      location: '市民センター', preparation: '母子手帳', timezone: 'Asia/Tokyo', assigneeUids: [A.uid], status: 'planned', relatedRefs: [],
    }));
    ids.schedTimed = await createFamilyDoc(A, col('schedules'), omitNull({
      title: '予防接種', category: 'procedure', allDay: false, date: null,
      startAt: Timestamp.fromDate(new Date(Date.now() + 86400_000)), endAt: Timestamp.fromDate(new Date(Date.now() + 86400_000 + 1800_000)),
      location: null, preparation: null, timezone: 'Asia/Tokyo', assigneeUids: [], status: 'planned', relatedRefs: [],
    }));
  });

  it('A: task / shopping / handover — taskCreate 等と同形', async () => {
    ids.task = await createFamilyDoc(A, col('tasks'), omitNull({
      title: '出生届', category: 'procedure', status: 'todo', assigneeUid: B.uid, dueDate: '2026-10-30', deadlineBasis: '14日以内',
      deadlineVerified: false, sourceUrl: 'https://example.com/a', step: '役所へ', relatedRefs: [],
    }));
    ids.shopping = await createFamilyDoc(A, col('shopping'), omitNull({ name: 'おむつ', brand: null, size: 'S', quantity: 2, assigneeUid: null, status: 'needed' }));
    ids.handover = await createFamilyDoc(A, col('handovers'), omitNull({
      text: '夜に38度あったら連絡', priority: 'important', recipientUids: [B.uid],
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400_000)), relatedRefs: [], status: 'open',
    }));
    ids.handover2 = await createFamilyDoc(A, col('handovers'), omitNull({
      text: '全員宛て', priority: 'normal', recipientUids: [], expiresAt: null, relatedRefs: [{ kind: 'event', id: ids.diaper, childId }], status: 'open',
    }));
  });

  it('B: ack (acknowledgeHandover と同形)、他人名義の ack は拒否', async () => {
    await setDoc(doc(B.db, col('handovers'), ids.handover, 'acks', B.uid), { uid: B.uid, acknowledgedAt: serverTimestamp(), handoverRevision: 1 });
    const ack = await getDoc(doc(A.db, col('handovers'), ids.handover, 'acks', B.uid));
    expect(ack.exists()).toBe(true);
    await denied(setDoc(doc(B.db, col('handovers'), ids.handover, 'acks', A.uid), { uid: A.uid, acknowledgedAt: serverTimestamp(), handoverRevision: 1 }));
  });

  it('B: updateDoc shopping purchased / handover resolved (resolvedBy 付与)', async () => {
    const s = await call(B, 'updateDoc', { familyId, kind: 'shopping', docId: ids.shopping, expectedRevision: 1, patch: { status: 'purchased' } });
    expect(s.revision).toBe(2);
    expect((await getDoc(doc(B.db, col('shopping'), ids.shopping))).data()!.status).toBe('purchased');
    const h = await call(B, 'updateDoc', { familyId, kind: 'handover', docId: ids.handover, expectedRevision: 1, patch: { status: 'resolved' } });
    expect(h.revision).toBe(2);
    const hd = (await getDoc(doc(B.db, col('handovers'), ids.handover))).data()!;
    expect(hd.status).toBe('resolved');
    expect(hd.resolvedBy).toBe(B.uid);
    expect(hd.resolvedAt).toBeTruthy();
    // 解決を戻す
    const o = await call(B, 'updateDoc', { familyId, kind: 'handover', docId: ids.handover, expectedRevision: 2, patch: { status: 'open' } });
    expect(o.revision).toBe(3);
    const od = (await getDoc(doc(B.db, col('handovers'), ids.handover))).data()!;
    expect(od.resolvedBy ?? null).toBeNull();
  });

  it('A: 編集フォームのパッチ (schedulePatch / taskPatch / handoverPatch) が通る', async () => {
    const sp = await call(A, 'updateDoc', {
      familyId, kind: 'schedule', docId: ids.schedTimed, expectedRevision: 1,
      patch: {
        title: '予防接種(変更)', category: 'procedure', allDay: false, date: null,
        startAt: new Date(Date.now() + 2 * 86400_000).toISOString(), endAt: null, location: '病院', preparation: null, assigneeUids: [A.uid, B.uid],
      },
    });
    expect(sp.revision).toBe(2);
    const sp2 = await call(A, 'updateDoc', {
      familyId, kind: 'schedule', docId: ids.schedAllDay, expectedRevision: 1,
      patch: { title: '健診', category: 'medical', allDay: true, date: '2026-10-21', startAt: null, endAt: null, location: null, preparation: null, assigneeUids: [A.uid] },
    });
    expect(sp2.revision).toBe(2);
    const tp = await call(A, 'updateDoc', {
      familyId, kind: 'task', docId: ids.task, expectedRevision: 1,
      patch: { title: '出生届', category: 'procedure', status: 'doing', assigneeUid: null, dueDate: null, deadlineBasis: null, deadlineVerified: true, sourceUrl: null, step: null },
    });
    expect(tp.revision).toBe(2);
    const hp = await call(A, 'updateDoc', {
      familyId, kind: 'handover', docId: ids.handover2, expectedRevision: 1,
      patch: { text: '全員宛て(修正)', priority: 'important', recipientUids: [], expiresAt: new Date(Date.now() + 86400_000).toISOString(), relatedRefs: [] },
    });
    expect(hp.revision).toBe(2);
  });

  it('deleteDoc (shopping / schedule)、client からの delete は拒否', async () => {
    await denied(clientDeleteDoc(doc(A.db, col('shopping'), ids.shopping)));
    await call(B, 'deleteDoc', { familyId, kind: 'shopping', docId: ids.shopping, expectedRevision: 2 });
    expect((await getDoc(doc(A.db, col('shopping'), ids.shopping))).exists()).toBe(false);
    await call(A, 'deleteDoc', { familyId, kind: 'schedule', docId: ids.schedAllDay, expectedRevision: 2 });
  });
});

describe('健康・薬', () => {
  const hp = () => doc(A.db, 'families', familyId, 'children', childId, 'healthProfiles', 'main');

  it('healthProfiles/main を ProfilePage と同じ setDoc 形式で作成 -> updateDoc', async () => {
    await setDoc(hp(), stripUndefined({
      allergies: [{ name: '卵', confirmation: 'suspected' }],
      conditionsNote: undefined,
      primaryClinic: { name: 'さくら小児科', phone: '03-0000-0000' },
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: A.uid, updatedBy: A.uid, revision: 1,
    }));
    const r = await call(B, 'updateDoc', {
      familyId, kind: 'healthProfile', childId, docId: 'main', expectedRevision: 1,
      patch: { allergies: [{ name: '卵', confirmation: 'confirmed_by_doctor', source: '〇〇医院' }], conditionsNote: null, primaryClinic: null },
    });
    expect(r.revision).toBe(2);
    const d = (await getDoc(hp())).data()!;
    expect(d.allergies[0].confirmation).toBe('confirmed_by_doctor');
  });

  it('medication 作成 -> createDoseOccurrence -> A claim -> B claim は failed-precondition -> A complete -> 再送で alreadyCompleted', async () => {
    const medId = await createFamilyDoc(A, `families/${familyId}/children/${childId}/medications`, stripUndefined({
      name: '解熱剤', instructionText: '医師の指示どおり', instructionSource: '〇〇医院', asNeeded: true, status: 'active',
      amount: 2.5, unit: 'mL', unitX: undefined, startDate: undefined, endDate: undefined,
    }));
    const { occurrenceId } = await call(A, 'createDoseOccurrence', { familyId, childId, medicationId: medId });
    const c1 = await call(A, 'claimDose', { familyId, childId, occurrenceId });
    expect(c1.claimedBy).toBe(A.uid);
    const e = await callErr(B, 'claimDose', { familyId, childId, occurrenceId });
    expect(e.code).toBe('failed-precondition');
    expect(e.details?.claimedBy).toBe(A.uid);

    const eventId = crypto.randomUUID();
    const input = { familyId, childId, occurrenceId, eventId, occurredAt: new Date().toISOString(), amount: 2.5, unit: 'mL', note: 'メモ' };
    const r1 = await call(A, 'completeDose', input);
    expect(r1.alreadyCompleted).toBe(false);
    const r2 = await call(A, 'completeDose', input);
    expect(r2.alreadyCompleted).toBe(true);
    expect(r2.eventId).toBe(eventId);

    const ev = (await getDoc(eventRef(B, familyId, childId, eventId))).data()!;
    expect(ev.type).toBe('medication_taken');
    expect(ev.payload.occurrenceId).toBe(occurrenceId);
    const occ = (await getDoc(doc(B.db, 'families', familyId, 'children', childId, 'doseOccurrences', occurrenceId))).data()!;
    expect(occ.state).toBe('completed');

    // 量・メモ省略 (MedicationsPage の complete で未入力のとき)
    const { occurrenceId: o2 } = await call(B, 'createDoseOccurrence', { familyId, childId, medicationId: medId, plannedAt: new Date().toISOString() });
    await call(B, 'claimDose', { familyId, childId, occurrenceId: o2 });
    await call(B, 'completeDose', { familyId, childId, occurrenceId: o2, eventId: crypto.randomUUID(), occurredAt: new Date().toISOString() });
    // release / skip
    const { occurrenceId: o3 } = await call(B, 'createDoseOccurrence', { familyId, childId, medicationId: medId });
    await call(B, 'claimDose', { familyId, childId, occurrenceId: o3 });
    await call(B, 'releaseDose', { familyId, childId, occurrenceId: o3 });
    await call(A, 'skipDose', { familyId, childId, occurrenceId: o3, reason: '見送り' });

    // medication の更新 (MedSheet の編集形)
    await call(A, 'updateDoc', {
      familyId, kind: 'medication', childId, docId: medId, expectedRevision: 1,
      patch: { name: '解熱剤', instructionText: '指示', instructionSource: '〇〇医院', asNeeded: true, amount: null, unit: null, startDate: null, endDate: null, status: 'ended' },
    });
  });

  it('medication_taken を void -> occurrence が planned に戻り再度 completeDose 可。payload 変更は拒否', async () => {
    const medId = await createFamilyDoc(A, `families/${familyId}/children/${childId}/medications`, { name: '整腸剤', instructionText: '指示', instructionSource: '〇〇医院', asNeeded: true, status: 'active' });
    const { occurrenceId } = await call(A, 'createDoseOccurrence', { familyId, childId, medicationId: medId });
    await call(A, 'claimDose', { familyId, childId, occurrenceId });
    const ev1 = crypto.randomUUID();
    await call(A, 'completeDose', { familyId, childId, occurrenceId, eventId: ev1, occurredAt: new Date().toISOString() });
    const occRef = doc(B.db, 'families', familyId, 'children', childId, 'doseOccurrences', occurrenceId);
    expect((await getDoc(occRef)).data()!.state).toBe('completed');
    // 未来時刻は拒否
    const e = await callErr(A, 'completeDose', { familyId, childId, occurrenceId, eventId: crypto.randomUUID(), occurredAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(e.code).toBe('invalid-argument');
    // payload は変更不可
    const pe = await callErr(A, 'updateEvent', { familyId, childId, eventId: ev1, expectedRevision: 1, patch: { payload: { medicationId: medId, occurrenceId, amount: 99 } } });
    expect(pe.code).toBe('failed-precondition');
    // void で occurrence が planned に戻る
    await call(A, 'setEventStatus', { familyId, childId, eventId: ev1, expectedRevision: 1, status: 'void' });
    const back = (await getDoc(occRef)).data()!;
    expect(back.state).toBe('planned');
    expect(back.completedEventId ?? null).toBeNull();
    // 再度 completeDose できる
    const ev2 = crypto.randomUUID();
    const r = await call(B, 'completeDose', { familyId, childId, occurrenceId, eventId: ev2, occurredAt: new Date().toISOString() });
    expect(r.alreadyCompleted).toBe(false);
    expect((await getDoc(occRef)).data()!.completedEventId).toBe(ev2);
    // 取消した旧イベントの復元は、別の記録で埋まっているので拒否
    const re = await callErr(A, 'setEventStatus', { familyId, childId, eventId: ev1, expectedRevision: 2, status: 'active' });
    expect(re.code).toBe('failed-precondition');
    expect(re.details?.reason).toBe('occurrence-unavailable');
    // 現在の記録を void -> 復元は可能
    await call(B, 'setEventStatus', { familyId, childId, eventId: ev2, expectedRevision: 1, status: 'void' });
    expect((await getDoc(occRef)).data()!.state).toBe('planned');
    await call(B, 'setEventStatus', { familyId, childId, eventId: ev2, expectedRevision: 2, status: 'active' });
    expect((await getDoc(occRef)).data()!.state).toBe('completed');
    // 同じ薬・時刻帯の重複 occurrence 防止は createDoseOccurrence 側(単体テストで担保)
  });

  it('medicalVisit / vaccination / contact の作成と更新', async () => {
    const visit = await createFamilyDoc(A, `families/${familyId}/children/${childId}/medicalVisits`, { occurredOn: '2026-10-01', provider: 'さくら小児科', reason: '発熱' });
    await call(A, 'updateDoc', { familyId, kind: 'medicalVisit', childId, docId: visit, expectedRevision: 1, patch: { observations: '咳', nextAction: null } });
    const vac = await createFamilyDoc(A, `families/${familyId}/children/${childId}/vaccinations`, { name: 'B型肝炎', doseLabel: '1回目', status: 'planned', kind: 'vaccination', scheduledDate: '2026-11-01' });
    await call(A, 'updateDoc', { familyId, kind: 'vaccination', childId, docId: vac, expectedRevision: 1, patch: { status: 'administered', administeredDate: '2026-11-01' } });
    const ct = await createFamilyDoc(A, `families/${familyId}/contacts`, { name: '小児科', category: 'clinic', phone: '03-1111-2222' });
    await call(A, 'updateDoc', { familyId, kind: 'contact', docId: ct, expectedRevision: 1, patch: { name: '小児科', category: 'clinic', phone: null, url: 'https://example.com/c', note: 'メモ' } });
    await call(A, 'updateDoc', { familyId, kind: 'child', docId: childId, expectedRevision: 1, patch: { nickname: 'はるき', birthDate: '2026-08-01', dueDate: null } });
    await call(A, 'deleteDoc', { familyId, kind: 'contact', docId: ct, expectedRevision: 2 });
  });
});

describe('エクスポート・退出', () => {
  it('exportFamilyData', async () => {
    const r = await call(A, 'exportFamilyData', { familyId });
    expect(r.members.length).toBe(2);
    expect(r.children[0].events.length).toBeGreaterThan(10);
    expect(r.children[0].medications.length).toBe(2);
    expect(r.children[0].doseOccurrences.length).toBeGreaterThan(0);
    expect(r.children[0].healthProfile).toBeTruthy();
    expect(r.tasks.length).toBe(1);
    expect(r.handovers.length).toBe(2);
    expect(typeof r.exportedAt).toBe('string');
  });

  it('C: 出産予定日・練習データ付き createFamily (SetupPage の child 形)', async () => {
    const r = await call(C, 'createFamily', { familyName: 'C家', displayName: 'C', child: { nickname: 'ゆめ', dueDate: '2027-01-01', isSample: true } });
    expect(r.familyId).toBeTruthy();
    const ch = (await getDoc(doc(C.db, 'families', r.familyId, 'children', r.childId))).data()!;
    expect(ch.isSample).toBe(true);
    expect(ch.dueDate).toBe('2027-01-01');
  });

  it('C は他家の export 不可', async () => {
    const e = await callErr(C, 'exportFamilyData', { familyId });
    expect(e.code).toBe('permission-denied');
  });

  it('leaveFamily(B) 後 B は読めない', async () => {
    await call(B, 'leaveFamily', { familyId });
    await denied(getDoc(doc(B.db, 'families', familyId)));
    await denied(getDocs(collection(B.db, 'families', familyId, 'children', childId, 'events')));
    await denied(createEvent(B, familyId, childId, { type: 'memo', occurredAt: new Date(), payload: { text: 'x' } }));
    // A はまだ読める
    expect((await getDoc(doc(A.db, 'families', familyId))).exists()).toBe(true);
  });
});
