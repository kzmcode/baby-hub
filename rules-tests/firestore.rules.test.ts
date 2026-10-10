import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { setLogLevel } from 'firebase/firestore';
import { Timestamp, collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';

const F = 'fam1';
const OTHER_F = 'fam2';
const C = 'child1';
let env: RulesTestEnvironment;

beforeAll(async () => {
  setLogLevel('silent');
  env = await initializeTestEnvironment({
    projectId: 'demo-baby-hub',
    firestore: { rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8') },
  });
});
afterAll(async () => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [fam, uids] of [[F, ['alice', 'bob']], [OTHER_F, ['carol']]] as const) {
      await setDoc(doc(db, `families/${fam}`), { name: 'x', ownerUid: uids[0], status: 'active' });
      for (const u of uids) await setDoc(doc(db, `families/${fam}/members/${u}`), { uid: u, role: 'editor', status: 'active' });
      await setDoc(doc(db, `families/${fam}/children/${C}`), { nickname: 'c' });
    }
    await setDoc(doc(db, `families/${F}/members/gone`), { uid: 'gone', role: 'editor', status: 'removed' });
    await setDoc(doc(db, `families/${F}/handovers/h1`), { text: 'x', revision: 1 });
    await setDoc(doc(db, 'invites/i1'), { tokenHash: 'x' });
    await setDoc(doc(db, 'users/alice'), { displayName: 'A' });
    await setDoc(doc(db, 'users/bob'), { displayName: 'B' });
    await setDoc(doc(db, `families/${F}/children/${C}/events/e0`), { type: 'memo', status: 'active', revision: 1 });
  });
});

const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const gone = () => env.authenticatedContext('gone').firestore();
const carol = () => env.authenticatedContext('carol').firestore();
const anon = () => env.unauthenticatedContext().firestore();
const evRef = (db: ReturnType<typeof alice>, id = 'e1', fam = F) => doc(db, `families/${fam}/children/${C}/events/${id}`);

function ev(over: Record<string, unknown> = {}, uid = 'alice') {
  return {
    schemaVersion: 1,
    childId: C,
    type: 'diaper',
    occurredAt: Timestamp.now(),
    recordedAt: Timestamp.now(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: uid,
    updatedBy: uid,
    caregiverUid: uid,
    payload: { urine: 'yes', stool: 'no', changed: true },
    revision: 1,
    status: 'active',
    ...over,
  };
}
const common = (uid = 'alice') => ({
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: uid, updatedBy: uid, revision: 1,
});

describe('read access', () => {
  it('non-member cannot read events', async () => {
    await assertFails(getDoc(doc(carol(), `families/${F}/children/${C}/events/e0`)));
  });
  it('unauthenticated cannot read', async () => {
    await assertFails(getDoc(doc(anon(), `families/${F}`)));
  });
  it('removed member cannot read', async () => {
    await assertFails(getDoc(doc(gone(), `families/${F}/children/${C}/events/e0`)));
  });
  it('member can read own family events and list', async () => {
    await assertSucceeds(getDoc(doc(alice(), `families/${F}/children/${C}/events/e0`)));
    await assertSucceeds(getDocs(collection(alice(), `families/${F}/children/${C}/events`)));
  });
  it('member cannot read another family data', async () => {
    await assertFails(getDoc(doc(alice(), `families/${OTHER_F}/children/${C}/events/e0`)));
    await assertFails(getDoc(doc(alice(), `families/${OTHER_F}`)));
  });
  it('invites are unreadable and unwritable', async () => {
    await assertFails(getDoc(doc(alice(), 'invites/i1')));
    await assertFails(setDoc(doc(alice(), 'invites/i2'), { tokenHash: 'y' }));
  });
  it('notificationJobs are unreadable and unwritable', async () => {
    await assertFails(getDoc(doc(alice(), 'notificationJobs/j1')));
    await assertFails(setDoc(doc(alice(), 'notificationJobs/j1'), { a: 1 }));
  });
});

describe('events create', () => {
  it('member can create a valid diaper event', async () => {
    await assertSucceeds(setDoc(evRef(alice()), ev()));
  });
  it('member can create feeding / temperature / growth / sleep / memo events', async () => {
    await assertSucceeds(setDoc(evRef(alice(), 'f1'), ev({ type: 'feeding', payload: { method: 'formula', consumedMl: 120 } })));
    await assertSucceeds(setDoc(evRef(alice(), 'f2'), ev({ type: 'feeding', payload: { method: 'breast', leftSeconds: 300 } })));
    await assertSucceeds(setDoc(evRef(alice(), 't1'), ev({ type: 'temperature', payload: { celsius: 37.2, measurementMethod: 'axillary' } })));
    await assertSucceeds(setDoc(evRef(alice(), 'g1'), ev({ type: 'growth', payload: { weightGrams: 4200 } })));
    await assertSucceeds(setDoc(evRef(alice(), 's1'), ev({ type: 'sleep_start', sessionId: 'ss', payload: { sessionId: 'ss' } })));
    await assertSucceeds(setDoc(evRef(alice(), 's2'), ev({ type: 'sleep_end', sessionId: 'ss', payload: { sessionId: 'ss', startEventId: 's1' } })));
    await assertSucceeds(setDoc(evRef(alice(), 'm1'), ev({ type: 'memo', payload: { tags: ['ぐずり'] } })));
  });
  it('caregiverUid may be null, omitted, or another active member', async () => {
    await assertSucceeds(setDoc(evRef(alice(), 'a'), ev({ caregiverUid: null })));
    const { caregiverUid, ...noCg } = ev();
    void caregiverUid;
    await assertSucceeds(setDoc(evRef(alice(), 'b'), noCg));
    await assertSucceeds(setDoc(evRef(alice(), 'c'), ev({ caregiverUid: 'bob' })));
  });
  it('rejects caregiverUid of non-member / removed member', async () => {
    await assertFails(setDoc(evRef(alice(), 'a'), ev({ caregiverUid: 'carol' })));
    await assertFails(setDoc(evRef(alice(), 'b'), ev({ caregiverUid: 'gone' })));
  });
  it('non-member cannot create', async () => {
    await assertFails(setDoc(evRef(carol()), ev({}, 'carol')));
  });
  it('removed member cannot create', async () => {
    await assertFails(setDoc(evRef(gone()), ev({}, 'gone')));
  });
  it('rejects spoofed createdBy / updatedBy', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ createdBy: 'bob' })));
    await assertFails(setDoc(evRef(alice()), ev({ updatedBy: 'bob' })));
  });
  it('rejects revision != 1', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ revision: 2 })));
    await assertFails(setDoc(evRef(alice()), ev({ revision: 0 })));
  });
  it('rejects status void, wrong schemaVersion, mismatched childId', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ status: 'void' })));
    await assertFails(setDoc(evRef(alice()), ev({ schemaVersion: 2 })));
    await assertFails(setDoc(evRef(alice()), ev({ childId: 'other' })));
  });
  it('rejects client-supplied createdAt (must be server time)', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ createdAt: Timestamp.now() })));
    await assertFails(setDoc(evRef(alice()), ev({ updatedAt: Timestamp.fromDate(new Date('2020-01-01')) })));
  });
  it('rejects medication_taken', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ type: 'medication_taken', payload: { medicationId: 'm', occurrenceId: 'o' } })));
  });
  it('rejects unknown type', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ type: 'hack' })));
  });
  it('rejects negative / out-of-range / non-numeric amounts', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ type: 'feeding', payload: { method: 'formula', consumedMl: -10 } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'feeding', payload: { method: 'formula', consumedMl: 501 } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'feeding', payload: { method: 'formula', consumedMl: '100' } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'feeding', payload: { method: 'formula', consumedMl: NaN } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'feeding', payload: { method: 'breast', leftSeconds: 7201 } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'temperature', payload: { celsius: 50 } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'temperature', payload: { celsius: 20 } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'growth', payload: { heightCm: 500 } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'growth', payload: {} })));
  });
  it('rejects unknown top-level key and unknown payload key', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ admin: true })));
    await assertFails(setDoc(evRef(alice()), ev({ payload: { urine: 'yes', stool: 'no', changed: true, extra: 1 } })));
  });
  it('rejects invalid enum / missing required payload fields', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ payload: { urine: 'maybe', stool: 'no', changed: true } })));
    await assertFails(setDoc(evRef(alice()), ev({ payload: { urine: 'yes', stool: 'no' } })));
    await assertFails(setDoc(evRef(alice()), ev({ type: 'feeding', payload: { method: 'soda' } })));
  });
  it('rejects too-long note; contextEventIds cannot be sent on create', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ note: 'x'.repeat(2001) })));
    await assertFails(setDoc(evRef(alice()), ev({ contextEventIds: ['e0'] })));
    await assertSucceeds(setDoc(evRef(alice()), ev({ note: 'x'.repeat(2000) })));
  });
  it('rejects mismatched sleep sessionId', async () => {
    await assertFails(setDoc(evRef(alice()), ev({ type: 'sleep_start', sessionId: 'a', payload: { sessionId: 'b' } })));
  });
  it('rejects event for non-existent child', async () => {
    await assertFails(setDoc(doc(alice(), `families/${F}/children/nochild/events/e1`), ev({ childId: 'nochild' })));
  });
});

describe('events update/delete', () => {
  it('rejects update and delete from clients', async () => {
    await assertFails(updateDoc(doc(alice(), `families/${F}/children/${C}/events/e0`), { note: 'x' }));
    await assertFails(updateDoc(doc(alice(), `families/${F}/children/${C}/events/e0`), { status: 'void' }));
    await assertFails(deleteDoc(doc(alice(), `families/${F}/children/${C}/events/e0`)));
  });
  it('rejects overwrite via set of existing event', async () => {
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/events/e0`), ev()));
  });
});

describe('server-only collections', () => {
  it('members cannot be written by clients', async () => {
    await assertFails(setDoc(doc(alice(), `families/${F}/members/alice`), { uid: 'alice', role: 'owner', status: 'active' }));
    await assertFails(updateDoc(doc(alice(), `families/${F}/members/bob`), { status: 'removed' }));
    await assertFails(setDoc(doc(carol(), `families/${F}/members/carol`), { uid: 'carol', role: 'editor', status: 'active' }));
  });
  it('members readable by active members only', async () => {
    await assertSucceeds(getDoc(doc(alice(), `families/${F}/members/bob`)));
    await assertFails(getDoc(doc(carol(), `families/${F}/members/bob`)));
  });
  it('familyRefs: owner reads, nobody writes', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'users/alice/familyRefs/fam1')));
    await assertFails(getDoc(doc(bob(), 'users/alice/familyRefs/fam1')));
    await assertFails(setDoc(doc(alice(), 'users/alice/familyRefs/fam9'), { familyId: 'fam9' }));
  });
  it('family doc, children, auditLogs, doseOccurrences are not client-writable', async () => {
    await assertFails(updateDoc(doc(alice(), `families/${F}`), { name: 'y' }));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/c2`), { nickname: 'n' }));
    await assertFails(updateDoc(doc(alice(), `families/${F}/children/${C}`), { nickname: 'n' }));
    await assertFails(setDoc(doc(alice(), `families/${F}/auditLogs/a1`), { action: 'x' }));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/doseOccurrences/d1`), { state: 'completed' }));
  });
  it('unknown path denied', async () => {
    await assertFails(setDoc(doc(alice(), 'misc/x'), { a: 1 }));
    await assertFails(getDoc(doc(alice(), 'misc/x')));
  });
});

describe('users', () => {
  it('owner can read/update own user doc', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'users/alice')));
    await assertSucceeds(updateDoc(doc(alice(), 'users/alice'), { settings: { theme: 'dark', quietHours: { enabled: true, start: '22:00', end: '07:00' } } }));
  });
  it('cannot read or write other users', async () => {
    await assertFails(getDoc(doc(alice(), 'users/bob')));
    await assertFails(updateDoc(doc(alice(), 'users/bob'), { displayName: 'hax' }));
    await assertFails(setDoc(doc(alice(), 'users/bob'), { displayName: 'hax' }));
  });
  it('rejects invalid settings', async () => {
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { settings: { theme: 'neon' } }));
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { settings: { quietHours: { enabled: true, start: '25:99', end: '07:00' } } }));
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { settings: { notify: { dose: 'yes' } } }));
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { settings: { unknown: 1 } }));
  });
  it('cannot change createdAt or add unknown fields', async () => {
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { createdAt: Timestamp.now() }));
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { isAdmin: true }));
  });
  it('merge-writes {settings} only (create and update), both without displayName', async () => {
    const nb = env.authenticatedContext('nb').firestore();
    await assertSucceeds(setDoc(doc(nb, 'users/nb'), { settings: { theme: 'dark' } }, { merge: true }));
    await assertSucceeds(setDoc(doc(nb, 'users/nb'), { settings: { theme: 'light', notify: { dose: false } } }, { merge: true }));
    await assertFails(setDoc(doc(nb, 'users/nb'), { settings: { theme: 'bad' } }, { merge: true }));
  });
  it('familyRefs can be listed with where(status==active) by owner only', async () => {
    const { query, where } = await import('firebase/firestore');
    await assertSucceeds(getDocs(query(collection(alice(), 'users/alice/familyRefs'), where('status', '==', 'active'))));
    await assertFails(getDocs(query(collection(bob(), 'users/alice/familyRefs'), where('status', '==', 'active'))));
  });
  it('can create own user doc with default settings', async () => {
    await assertSucceeds(setDoc(doc(env.authenticatedContext('newbie').firestore(), 'users/newbie'), {
      displayName: 'N', createdAt: serverTimestamp(), settings: { theme: 'system' },
    }));
  });
  it('devices: registration cannot bypass the server cap; only self reads/deletes', async () => {
    const payload = { fcmToken: 'tok', platform: 'ios', trusted: false, pushEnabled: true, updatedAt: serverTimestamp() };
    await assertFails(setDoc(doc(alice(), 'users/alice/devices/d1'), payload));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users/alice/devices/d1'), { ...payload, updatedAt: Timestamp.now() });
    });
    await assertSucceeds(getDoc(doc(alice(), 'users/alice/devices/d1')));
    await assertFails(getDoc(doc(bob(), 'users/alice/devices/d1')));
    await assertFails(updateDoc(doc(alice(), 'users/alice/devices/d1'), { fcmToken: 'duplicate' }));
    await assertFails(updateDoc(doc(alice(), 'users/alice/devices/d1'), { platform: 'other' }));
    await assertFails(deleteDoc(doc(bob(), 'users/alice/devices/d1')));
    await assertSucceeds(deleteDoc(doc(alice(), 'users/alice/devices/d1')));
  });
});

describe('handover acks', () => {
  const ack = (uid = 'alice') => ({ uid, acknowledgedAt: serverTimestamp(), handoverRevision: 1 });
  it('member can ack as self (create and update)', async () => {
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), ack()));
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), { ...ack(), handoverRevision: 1 }));
  });
  it('cannot ack on behalf of someone else', async () => {
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/bob`), ack('bob')));
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), ack('bob')));
  });
  it('non-member cannot ack; bad data rejected', async () => {
    await assertFails(setDoc(doc(carol(), `families/${F}/handovers/h1/acks/carol`), ack('carol')));
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), { ...ack(), handoverRevision: 0 }));
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), { ...ack(), extra: 1 }));
  });
  it('members can read acks; cannot delete', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `families/${F}/handovers/h1/acks/bob`), { uid: 'bob', handoverRevision: 1 });
    });
    await assertSucceeds(getDoc(doc(alice(), `families/${F}/handovers/h1/acks/bob`)));
    await assertFails(deleteDoc(doc(bob(), `families/${F}/handovers/h1/acks/bob`)));
  });
});

describe('handover acks (S2 hardening)', () => {
  const ack = (over: Record<string, unknown> = {}) => ({ uid: 'alice', acknowledgedAt: serverTimestamp(), handoverRevision: 1, ...over });
  it('rejects ack to a non-existent handover', async () => {
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/nohandover/acks/alice`), ack()));
  });
  it('rejects revision mismatch (too high / too low)', async () => {
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), ack({ handoverRevision: 2 })));
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), `families/${F}/handovers/h1`), { text: 'x', revision: 3 }); });
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), ack({ handoverRevision: 1 })));
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), ack({ handoverRevision: 3 })));
  });
  it('rejects client-supplied acknowledgedAt', async () => {
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/h1/acks/alice`), ack({ acknowledgedAt: Timestamp.now() })));
  });
});

describe('orphan child / id format / time / lists (S2 hardening)', () => {
  const NOC = 'families/' + F + '/children/nochild';
  it('rejects creating child-scoped docs under a non-existent child', async () => {
    await assertFails(setDoc(doc(alice(), `${NOC}/healthProfiles/main`), { allergies: [], ...common() }));
    await assertFails(setDoc(doc(alice(), `${NOC}/medications/m1`), { name: 'A', instructionText: '', instructionSource: '', asNeeded: false, status: 'active', ...common() }));
    await assertFails(setDoc(doc(alice(), `${NOC}/medicalVisits/v1`), { occurredOn: '2026-10-01', provider: 'p', reason: 'r', ...common() }));
    await assertFails(setDoc(doc(alice(), `${NOC}/vaccinations/x1`), { name: 'n', doseLabel: '', status: 'planned', kind: 'vaccination', ...common() }));
  });
  it('rejects invalid document IDs; accepts UUID / auto IDs', async () => {
    await assertSucceeds(setDoc(evRef(alice(), crypto.randomUUID()), ev()));
    await assertSucceeds(setDoc(evRef(alice(), 'aB3_-xYz0123456789AB'), ev()));
    await assertFails(setDoc(evRef(alice(), 'bad id'), ev()));
    await assertFails(setDoc(evRef(alice(), 'x'.repeat(129)), ev()));
    await assertFails(setDoc(evRef(alice(), 'a.b'), ev()));
    const t = { title: 't', category: 'other', status: 'todo', deadlineVerified: false, relatedRefs: [], ...common() };
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/tasks/${crypto.randomUUID()}`), t));
    await assertFails(setDoc(doc(alice(), `families/${F}/tasks/bad%20id`), t));
    await assertFails(setDoc(doc(alice(), `families/${F}/tasks/${'y'.repeat(129)}`), t));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/medications/bad$id`), { name: 'A', instructionText: '', instructionSource: '', asNeeded: false, status: 'active', ...common() }));
  });
  it('rejects future occurredAt/endedAt/recordedAt (>10min), allows past and small skew', async () => {
    const fut = (min: number) => Timestamp.fromMillis(Date.now() + min * 60_000);
    await assertFails(setDoc(evRef(alice()), ev({ occurredAt: fut(30) })));
    await assertFails(setDoc(evRef(alice()), ev({ recordedAt: fut(30) })));
    await assertFails(setDoc(evRef(alice()), ev({ occurredAt: fut(-60), endedAt: fut(30) })));
    await assertSucceeds(setDoc(evRef(alice()), ev({ occurredAt: fut(5) })));
    await assertSucceeds(setDoc(evRef(alice(), 'p'), ev({ occurredAt: fut(-60 * 24 * 30) })));
  });
  it('rejects endedAt < occurredAt', async () => {
    const t = (min: number) => Timestamp.fromMillis(Date.now() + min * 60_000);
    await assertFails(setDoc(evRef(alice()), ev({ occurredAt: t(-10), endedAt: t(-20) })));
    await assertSucceeds(setDoc(evRef(alice()), ev({ occurredAt: t(-20), endedAt: t(-10) })));
  });
  it('schedules/tasks may have future dates', async () => {
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/schedules/sf`), {
      title: 't', category: 'other', allDay: false, startAt: Timestamp.fromMillis(Date.now() + 86400_000 * 90),
      timezone: 'Asia/Tokyo', assigneeUids: [], status: 'planned', relatedRefs: [], ...common(),
    }));
  });
  it('symptom/memo tags: fixed candidates only', async () => {
    await assertSucceeds(setDoc(evRef(alice(), 'sy'), ev({ type: 'symptom', payload: { symptomTags: ['咳', '鼻水'] } })));
    await assertFails(setDoc(evRef(alice(), 'sy2'), ev({ type: 'symptom', payload: { symptomTags: ['x'.repeat(5000)] } })));
    await assertFails(setDoc(evRef(alice(), 'sy3'), ev({ type: 'symptom', payload: { symptomTags: Array(10).fill('咳') } })));
    await assertFails(setDoc(evRef(alice(), 'mm'), ev({ type: 'memo', payload: { tags: ['smile'] } })));
  });
  it('vomit contextTags: free but <=10 items, <=30 chars, strings', async () => {
    const v = (contextTags: unknown) => ev({ type: 'vomit', payload: { contextTags } });
    await assertSucceeds(setDoc(evRef(alice(), 'v1'), v(Array.from({ length: 10 }, () => 'x'.repeat(30)))));
    await assertFails(setDoc(evRef(alice(), 'v2'), v(Array.from({ length: 11 }, () => 'x'))));
    await assertFails(setDoc(evRef(alice(), 'v3'), v(['x'.repeat(31)])));
    await assertFails(setDoc(evRef(alice(), 'v4'), v([1])));
    await assertFails(setDoc(evRef(alice(), 'v5'), v(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', { a: 1 }])));
  });
  it('sourceRef: allowed kind + ID format', async () => {
    await assertSucceeds(setDoc(evRef(alice(), 'sr1'), ev({ sourceRef: { kind: 'doseOccurrence', id: 'occ_1' } })));
    await assertFails(setDoc(evRef(alice(), 'sr2'), ev({ sourceRef: { kind: 'evil', id: 'occ_1' } })));
    await assertFails(setDoc(evRef(alice(), 'sr3'), ev({ sourceRef: { kind: 'event', id: '../x' } })));
  });
  const sch = (over: Record<string, unknown> = {}) => ({
    title: 't', category: 'other', allDay: false, startAt: Timestamp.now(), timezone: 'Asia/Tokyo',
    assigneeUids: [], status: 'planned', relatedRefs: [], ...common(), ...over,
  });
  it('assigneeUids / recipientUids: <=2, active members of same family only', async () => {
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/schedules/a1`), sch({ assigneeUids: ['alice', 'bob'] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/a2`), sch({ assigneeUids: ['alice', 'bob', 'carol'] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/a3`), sch({ assigneeUids: ['carol'] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/a4`), sch({ assigneeUids: ['alice', 'gone'] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/a5`), sch({ assigneeUids: [1] })));
    const h = (recipientUids: unknown[]) => ({ text: 't', priority: 'normal', recipientUids, relatedRefs: [], status: 'open', ...common() });
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/handovers/r1`), h(['bob'])));
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/r2`), h(['carol'])));
    await assertFails(setDoc(doc(alice(), `families/${F}/handovers/r3`), h(['bob', 'alice', 'x'])));
  });
  it('relatedRefs: <=5, shape, kind allow-list, ID format', async () => {
    const r = (i: number) => ({ kind: 'task', id: `t${i}`, childId: C });
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/schedules/rr1`), sch({ relatedRefs: [0, 1, 2, 3, 4].map(r) })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/rr2`), sch({ relatedRefs: [0, 1, 2, 3, 4, 5].map(r) })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/rr3`), sch({ relatedRefs: [{ kind: 'evil', id: 'a' }] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/rr4`), sch({ relatedRefs: [{ kind: 'task', id: 'a b' }] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/rr5`), sch({ relatedRefs: [{ kind: 'task', id: 'a', extra: 1 }] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/rr6`), sch({ relatedRefs: [{ kind: 'task', id: 'x'.repeat(5000) }] })));
    await assertFails(setDoc(doc(alice(), `families/${F}/schedules/rr7`), sch({ relatedRefs: ['str'] })));
  });
  it('allergies: element shape, enum, lengths; max-size valid data accepted', async () => {
    const hp = (allergies: unknown[]) => doc(alice(), `families/${F}/children/${C}/healthProfiles/main`);
    const full = (i: number) => ({ name: 'n'.repeat(100), confirmation: 'confirmed_by_doctor', source: 's'.repeat(200), note: 'm'.repeat(200) });
    await assertSucceeds(setDoc(hp([]), { allergies: Array.from({ length: 5 }, (_, i) => full(i)), conditionsNote: 'c'.repeat(2000),
      primaryClinic: { name: 'x', phone: '1', url: 'https://a.example' }, ...common() }));
  });
  it('allergies: rejects bad elements', async () => {
    const hp = () => doc(alice(), `families/${F}/children/${C}/healthProfiles/main`);
    const ok = { name: 'egg', confirmation: 'suspected' };
    await assertFails(setDoc(hp(), { allergies: Array(6).fill(ok), ...common() }));
    await assertFails(setDoc(hp(), { allergies: [{ ...ok, name: 'n'.repeat(101) }], ...common() }));
    await assertFails(setDoc(hp(), { allergies: [{ ...ok, confirmation: 'maybe' }], ...common() }));
    await assertFails(setDoc(hp(), { allergies: [{ ...ok, extra: 1 }], ...common() }));
    await assertFails(setDoc(hp(), { allergies: [{ ...ok, note: 'x'.repeat(5000) }], ...common() }));
    await assertFails(setDoc(hp(), { allergies: ['egg'], ...common() }));
  });
  it('max-size valid handover/schedule (2 uids + 5 refs) fits get/expression limits', async () => {
    const refs = [0, 1, 2, 3, 4].map((i) => ({ kind: 'event', id: `e${i}`, childId: C }));
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/handovers/max1`), {
      text: 't'.repeat(2000), priority: 'important', recipientUids: ['alice', 'bob'], relatedRefs: refs, status: 'open', ...common(),
    }));
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/schedules/max2`), sch({ assigneeUids: ['alice', 'bob'], childId: C, relatedRefs: refs })));
    await assertSucceeds(setDoc(evRef(alice(), 'max3'), ev({
      type: 'vomit', caregiverUid: 'bob', sessionId: 's', note: 'n'.repeat(2000), sourceRef: { kind: 'event', id: 'e0' },
      payload: { amountCategory: 'large', appearanceText: 'a'.repeat(200), contextTags: Array.from({ length: 10 }, () => 'x'.repeat(30)) },
    })));
  });
});

describe('schedules', () => {
  const sch = (over: Record<string, unknown> = {}) => ({
    title: '1か月健診', category: 'medical', childId: C, allDay: false, startAt: Timestamp.now(),
    timezone: 'Asia/Tokyo', assigneeUids: ['alice'], status: 'planned', relatedRefs: [], ...common(), ...over,
  });
  const ref = (db: ReturnType<typeof alice>, id = 's1', fam = F) => doc(db, `families/${fam}/schedules/${id}`);
  it('member can create timed and all-day schedules', async () => {
    await assertSucceeds(setDoc(ref(alice()), sch()));
    await assertSucceeds(setDoc(ref(alice(), 's2'), (() => { const { startAt, ...r } = sch({ allDay: true, date: '2026-10-20' }); void startAt; return r; })()));
  });
  it('accepts relatedRefs with childId (vaccination link from health) and optional fields omitted', async () => {
    const { startAt, ...r } = sch({
      allDay: true, date: '2026-10-20', assigneeUids: [],
      relatedRefs: [{ kind: 'vaccination', id: 'x1', childId: C }, { kind: 'handover', id: 'h1' }],
    });
    void startAt;
    await assertSucceeds(setDoc(ref(alice(), 's3'), r));
  });
  it('rejects too many relatedRefs', async () => {
    const refs = Array.from({ length: 6 }, (_, i) => ({ kind: 'task', id: `t${i}` }));
    await assertFails(setDoc(ref(alice(), 's4'), sch({ relatedRefs: refs })));
  });
  it('rejects all-day without date, timed without startAt', async () => {
    const { startAt, ...noStart } = sch();
    void startAt;
    await assertFails(setDoc(ref(alice()), noStart));
    await assertFails(setDoc(ref(alice()), sch({ allDay: true })));
  });
  it('rejects empty / too long title, bad category, bad status, bad revision, spoofed createdBy', async () => {
    await assertFails(setDoc(ref(alice()), sch({ title: '' })));
    await assertFails(setDoc(ref(alice()), sch({ title: 'x'.repeat(201) })));
    await assertFails(setDoc(ref(alice()), sch({ category: 'party' })));
    await assertFails(setDoc(ref(alice()), sch({ status: 'done' })));
    await assertFails(setDoc(ref(alice()), sch({ revision: 3 })));
    await assertFails(setDoc(ref(alice()), sch({ createdBy: 'bob' })));
    await assertFails(setDoc(ref(alice()), sch({ evil: 1 })));
  });
  it('non-member cannot create or read; clients cannot update/delete', async () => {
    await assertFails(setDoc(ref(carol()), sch({ ...common('carol') })));
    await assertFails(setDoc(ref(alice(), 's1', OTHER_F), sch()));
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(ref(ctx.firestore(), 'sx'), { title: 't' }); });
    await assertFails(getDoc(ref(carol(), 'sx')));
    await assertSucceeds(getDoc(ref(alice(), 'sx')));
    await assertFails(updateDoc(ref(alice(), 'sx'), { title: 'u' }));
    await assertFails(deleteDoc(ref(alice(), 'sx')));
  });
});

describe('tasks / shopping / handovers / contacts', () => {
  it('task: valid create, https-only URL, assignee must be active member', async () => {
    const t = (over: Record<string, unknown> = {}) => ({
      title: '出生届', category: 'procedure', status: 'todo', deadlineVerified: false, relatedRefs: [],
      dueDate: '2026-10-30', sourceUrl: 'https://city.example.jp/x', assigneeUid: 'bob', ...common(), ...over,
    });
    const r = (id: string) => doc(alice(), `families/${F}/tasks/${id}`);
    await assertSucceeds(setDoc(r('t1'), t()));
    await assertFails(setDoc(r('t2'), t({ sourceUrl: 'http://insecure.example' })));
    await assertFails(setDoc(r('t3'), t({ sourceUrl: 'javascript:alert(1)' })));
    await assertFails(setDoc(r('t4'), t({ assigneeUid: 'carol' })));
    await assertFails(setDoc(r('t5'), t({ dueDate: '10/30' })));
    await assertFails(setDoc(r('t6'), t({ status: 'done' })));
    await assertSucceeds(setDoc(r('t7'), t({ assigneeUid: null })));
  });
  it('shopping: valid create and invalid quantity', async () => {
    const s = (over: Record<string, unknown> = {}) => ({ name: 'おむつ', status: 'needed', quantity: 2, ...common(), ...over });
    const r = (id: string) => doc(alice(), `families/${F}/shopping/${id}`);
    await assertSucceeds(setDoc(r('s1'), s()));
    await assertFails(setDoc(r('s2'), s({ quantity: -1 })));
    await assertFails(setDoc(r('s3'), s({ status: 'purchased' })));
  });
  it('handover: valid create, invalid priority / resolved on create', async () => {
    const h = (over: Record<string, unknown> = {}) => ({
      text: '夜に薬の確認', priority: 'important', recipientUids: ['bob'], relatedRefs: [], status: 'open', ...common(), ...over,
    });
    const r = (id: string) => doc(alice(), `families/${F}/handovers/${id}`);
    await assertSucceeds(setDoc(r('n1'), h()));
    await assertFails(setDoc(r('n2'), h({ priority: 'urgent' })));
    await assertFails(setDoc(r('n3'), h({ status: 'resolved' })));
    await assertFails(setDoc(r('n4'), h({ text: '' })));
    await assertFails(setDoc(r('n5'), h({ resolvedBy: 'alice' })));
  });
  it('contact: https-only url', async () => {
    const c = (over: Record<string, unknown> = {}) => ({ name: 'クリニック', category: 'clinic', ...common(), ...over });
    const r = (id: string) => doc(alice(), `families/${F}/contacts/${id}`);
    await assertSucceeds(setDoc(r('c1'), c({ url: 'https://clinic.example.jp' })));
    await assertFails(setDoc(r('c2'), c({ url: 'http://clinic.example.jp' })));
  });
});

describe('child-scoped dedicated docs', () => {
  it('medication: create ok, bad status / negative amount rejected', async () => {
    const m = (over: Record<string, unknown> = {}) => ({
      name: 'A薬', instructionText: '1日2回', instructionSource: '処方箋', asNeeded: false, status: 'active', ...common(), ...over,
    });
    const r = (id: string) => doc(alice(), `families/${F}/children/${C}/medications/${id}`);
    await assertSucceeds(setDoc(r('m1'), m()));
    await assertFails(setDoc(r('m2'), m({ status: 'ended' })));
    await assertFails(setDoc(r('m3'), m({ amount: -1 })));
    await assertFails(updateDoc(r('m1'), { name: 'B' }));
  });
  it('healthProfile only at docId main', async () => {
    const p = { allergies: [], ...common() };
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/children/${C}/healthProfiles/main`), p));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/healthProfiles/other`), p));
    await assertFails(setDoc(doc(carol(), `families/${F}/children/${C}/healthProfiles/main`), { ...p, ...common('carol') }));
  });
  it('medicalVisit and vaccination create', async () => {
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/children/${C}/medicalVisits/v1`), {
      occurredOn: '2026-10-01', provider: '小児科', reason: '発熱', ...common(),
    }));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/medicalVisits/v2`), {
      occurredOn: 'yesterday', provider: '小児科', reason: '発熱', ...common(),
    }));
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/children/${C}/vaccinations/x1`), {
      name: 'ロタ', doseLabel: '1回目', status: 'planned', kind: 'vaccination', ...common(),
    }));
    await assertSucceeds(setDoc(doc(alice(), `families/${F}/children/${C}/vaccinations/x3`), {
      name: '3〜4か月児健診', doseLabel: '', status: 'planned', kind: 'checkup', scheduledDate: '2026-11-01', ...common(),
    }));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/vaccinations/x4`), {
      name: 'ロタ', doseLabel: 'x'.repeat(101), status: 'planned', kind: 'vaccination', ...common(),
    }));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/vaccinations/x2`), {
      name: 'ロタ', doseLabel: '1回目', status: 'unknown', kind: 'vaccination', ...common(),
    }));
  });
});

describe('deletion state access', () => {
  it('blocks reads and creates immediately when a family is being deleted', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => updateDoc(doc(ctx.firestore(), `families/${F}`), { status: 'deleting' }));
    await assertFails(getDoc(doc(alice(), `families/${F}/children/${C}/events/e0`)));
    await assertFails(setDoc(doc(alice(), `families/${F}/children/${C}/events/new`), ev()));
  });
  it('blocks family access once account deletion starts', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'system/accountDeletion/users/alice'), { startedAt: Timestamp.now() }));
    await assertFails(getDoc(doc(alice(), `families/${F}/children/${C}/events/e0`)));
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { displayName: 'recreated' }));
    await assertFails(setDoc(doc(alice(), 'users/alice/devices/new'), { platform: 'ios', updatedAt: serverTimestamp() }));
  });
});
