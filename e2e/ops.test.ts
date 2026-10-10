// 結合テスト(運用系): 招待取消・メンバー管理・所有権移譲・家族/アカウント削除・通知・ディスパッチ・バックアップ/復元。
// GAS dev-server(NODE_ENV=test) + Auth/Firestore エミュレータ。
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getDocs, collection, getFirestore, serverTimestamp, setDoc, Timestamp, type Firestore } from 'firebase/firestore';
import { PROJECT, gasCall, GasError, restCount, restDelete, restGet, restPatchTimestamp, restSetPendingTransferExpiry, testCall, ENDPOINT_RL } from './helpers';

interface Client { name: string; app: FirebaseApp; auth: Auth; db: Firestore; uid: string; email: string }
const PASSWORD = 'password123';

async function makeClient(name: string): Promise<Client> {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-key', appId: 'fake' }, `ops-${name}-${Date.now()}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const email = `ops-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const cred = await createUserWithEmailAndPassword(auth, email, PASSWORD);
  return { name, app, auth, db, uid: cred.user.uid, email };
}
const call = <O = any>(c: Client, fn: string, data: unknown) => gasCall<O>(c.auth, fn, data);
async function callErr(c: Client, fn: string, data: unknown): Promise<{ code: string; details?: any }> {
  try { await call(c, fn, data); } catch (e) { if (e instanceof GasError) return { code: e.code, details: e.details }; throw e; }
  throw new Error(`${fn} は失敗するはずが成功した`);
}
async function denied(p: Promise<unknown>) {
  try { await p; } catch (e: any) { expect(e.code).toBe('permission-denied'); return; }
  throw new Error('permission-denied のはずが成功した');
}
async function createFamilyDoc(c: Client, path: string, data: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  await setDoc(doc(c.db, path, id), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: c.uid, updatedBy: c.uid, revision: 1 });
  return id;
}
const strVal = (d: any, f: string) => d?.fields?.[f]?.stringValue;

let O: Client, B: Client, C: Client, D: Client;
let familyId = '', childId = '';
const NO_QUIET = {
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  notify: { handoverImportant: true, handoverNormal: true, scheduleReminder: true, taskDue: true, dose: true },
};

beforeAll(async () => {
  [O, B, C, D] = await Promise.all([makeClient('owner'), makeClient('b'), makeClient('c'), makeClient('d')]);
  const r = await call(O, 'createFamily', { familyName: '運用家', displayName: 'オーナー', child: { nickname: 'そら', birthDate: '2026-08-01' } });
  familyId = r.familyId; childId = r.childId;
  for (const c of [O, B, C]) await setDoc(doc(c.db, 'users', c.uid), { settings: NO_QUIET }, { merge: true }).catch(() => undefined);
});

async function join(c: Client, name: string) {
  const { token } = await call(O, 'createInvite', { familyId });
  await call(c, 'acceptInvite', { token, displayName: name });
}

describe('招待取消・メンバー管理・所有権移譲', () => {
  it('revokeInvite: 取消した招待は使えない / 家族違い・非オーナーは拒否', async () => {
    const { token, inviteId } = await call(O, 'createInvite', { familyId });
    expect((await call(B, 'previewInvite', { token })).familyName).toBe('運用家');
    expect((await callErr(B, 'revokeInvite', { familyId, inviteId })).code).toBe('permission-denied');
    await call(O, 'revokeInvite', { familyId, inviteId });
    expect((await getDoc(doc(O.db, 'invites', inviteId)).catch(() => null))).toBeDefined();
    const inv = await restGet(PROJECT, `invites/${inviteId}`);
    expect(strVal(inv, 'status')).toBe('revoked');
    const e = await callErr(B, 'acceptInvite', { token, displayName: 'B' });
    expect(['failed-precondition', 'not-found', 'permission-denied']).toContain(e.code);
    expect((await callErr(O, 'revokeInvite', { familyId, inviteId: 'nonexistent' })).code).toBe('not-found');
  });

  it('removeMember: オーナーが B を除名 -> B は読めない・再招待で復帰可。自分自身・非オーナーは拒否', async () => {
    await join(B, 'ビー');
    expect((await getDocs(collection(O.db, 'families', familyId, 'members'))).size).toBe(2);
    expect((await callErr(B, 'removeMember', { familyId, uid: O.uid })).code).toBe('permission-denied');
    expect((await callErr(O, 'removeMember', { familyId, uid: O.uid })).code).toBe('invalid-argument');
    await call(O, 'removeMember', { familyId, uid: B.uid });
    expect(strVal(await restGet(PROJECT, `families/${familyId}/members/${B.uid}`), 'status')).toBe('removed');
    await denied(getDoc(doc(B.db, 'families', familyId)));
    await denied(getDocs(collection(B.db, 'families', familyId, 'children', childId, 'events')));
    expect(Number((await restGet(PROJECT, `families/${familyId}`)).fields.memberCount.integerValue)).toBe(1);
    await join(B, 'ビー'); // 除名後の再参加
    expect(Number((await restGet(PROJECT, `families/${familyId}`)).fields.memberCount.integerValue)).toBe(2);
    expect((await getDoc(doc(B.db, 'families', familyId))).exists()).toBe(true);
  });

  it('移譲(2段階): O が提案 -> B が承諾でオーナー交代。提案だけでは交代しない', async () => {
    expect((await callErr(B, 'transferOwnership', { familyId, toUid: O.uid })).code).toBe('permission-denied');
    expect((await callErr(O, 'transferOwnership', { familyId, toUid: O.uid })).code).toBe('invalid-argument');
    expect((await callErr(O, 'transferOwnership', { familyId, toUid: C.uid })).code).toBe('failed-precondition'); // 非メンバー
    const r = await call(O, 'transferOwnership', { familyId, toUid: B.uid });
    expect(r.pending).toBe(true);
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const fam = await restGet(PROJECT, `families/${familyId}`);
    expect(strVal(fam, 'ownerUid')).toBe(O.uid); // まだ交代していない
    expect(fam.fields.pendingOwnerTransfer.mapValue.fields.toUid.stringValue).toBe(B.uid);
    // 宛先以外は承諾できない
    expect((await callErr(O, 'acceptOwnershipTransfer', { familyId })).details?.reason).toBe('no-pending-transfer');
    expect((await callErr(C, 'acceptOwnershipTransfer', { familyId })).code).toBeDefined();
    await call(B, 'acceptOwnershipTransfer', { familyId });
    expect(strVal(await restGet(PROJECT, `families/${familyId}`), 'ownerUid')).toBe(B.uid);
    expect((await restGet(PROJECT, `families/${familyId}`)).fields.pendingOwnerTransfer).toBeUndefined();
    expect(strVal(await restGet(PROJECT, `families/${familyId}/members/${B.uid}`), 'role')).toBe('owner');
    expect(strVal(await restGet(PROJECT, `families/${familyId}/members/${O.uid}`), 'role')).toBe('editor');
    expect(strVal(await restGet(PROJECT, `users/${B.uid}/familyRefs/${familyId}`), 'role')).toBe('owner');
    expect((await callErr(O, 'createInvite', { familyId })).code).toBe('permission-denied');
    await call(B, 'createInvite', { familyId });
    // 元に戻す（以降のテストは O がオーナー）
    await call(B, 'transferOwnership', { familyId, toUid: O.uid });
    await call(O, 'acceptOwnershipTransfer', { familyId });
    expect(strVal(await restGet(PROJECT, `families/${familyId}`), 'ownerUid')).toBe(O.uid);
  });

  it('移譲: 宛先の辞退(cancel)・オーナーの取消し・第三者は取消せない', async () => {
    await call(O, 'transferOwnership', { familyId, toUid: B.uid });
    expect((await callErr(C, 'cancelOwnershipTransfer', { familyId })).code).toBe('permission-denied'); // 非メンバー
    await call(B, 'cancelOwnershipTransfer', { familyId }); // 辞退
    expect((await restGet(PROJECT, `families/${familyId}`)).fields.pendingOwnerTransfer).toBeUndefined();
    expect((await callErr(B, 'acceptOwnershipTransfer', { familyId })).details?.reason).toBe('no-pending-transfer');
    await call(O, 'transferOwnership', { familyId, toUid: B.uid });
    await call(O, 'cancelOwnershipTransfer', { familyId }); // 取消し
    expect((await restGet(PROJECT, `families/${familyId}`)).fields.pendingOwnerTransfer).toBeUndefined();
    expect((await call(O, 'cancelOwnershipTransfer', { familyId })).ok).toBe(true); // 提案なしでも ok
    expect(strVal(await restGet(PROJECT, `families/${familyId}`), 'ownerUid')).toBe(O.uid);
  });

  it('移譲: 期限切れの提案は承諾できない(transfer-expired)', async () => {
    await call(O, 'transferOwnership', { familyId, toUid: B.uid });
    await restSetPendingTransferExpiry(PROJECT, `families/${familyId}`, new Date(Date.now() - 60_000));
    expect((await callErr(B, 'acceptOwnershipTransfer', { familyId })).details?.reason).toBe('transfer-expired');
    expect(strVal(await restGet(PROJECT, `families/${familyId}`), 'ownerUid')).toBe(O.uid);
    await call(O, 'cancelOwnershipTransfer', { familyId });
  });

  it('移譲: validSinceより古いトークンでは提案も承諾も拒否', async () => {
    const stale = async (c: Client) => {
      const real = await c.auth.currentUser!.getIdToken(true);
      const [h, p] = real.split('.');
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      payload.auth_time = Math.floor(Date.now() / 1000) - 3600;
      return `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
    };
    const e1 = await gasCall(O.auth, 'transferOwnership', { familyId, toUid: B.uid }, { idToken: await stale(O) }).then(() => null, (x) => x as GasError);
    expect(e1).toBeInstanceOf(GasError);
    expect(e1!.code).toBe('unauthenticated');
    expect((await restGet(PROJECT, `families/${familyId}`)).fields.pendingOwnerTransfer).toBeUndefined();
    await call(O, 'transferOwnership', { familyId, toUid: B.uid });
    const e2 = await gasCall(B.auth, 'acceptOwnershipTransfer', { familyId }, { idToken: await stale(B) }).then(() => null, (x) => x as GasError);
    expect(e2).toBeInstanceOf(GasError);
    expect(e2!.code).toBe('unauthenticated');
    expect(strVal(await restGet(PROJECT, `families/${familyId}`), 'ownerUid')).toBe(O.uid);
    await call(O, 'cancelOwnershipTransfer', { familyId });
  });
});

describe('通知', () => {
  it('registerDevice / sendTestNotification (FCM 無効でも成功)', async () => {
    await call(B, 'registerDevice', { deviceId: 'dev-b1', fcmToken: 'tok-b1', platform: 'desktop' });
    await call(B, 'registerDevice', { deviceId: 'dev-b1', fcmToken: 'tok-b1-new', platform: 'desktop' }); // 更新
    const d = await restGet(PROJECT, `users/${B.uid}/devices/dev-b1`);
    expect(strVal(d, 'fcmToken')).toBe('tok-b1-new');
    expect((await getDoc(doc(B.db, 'users', B.uid, 'devices', 'dev-b1'))).exists()).toBe(true);
    expect((await callErr(B, 'registerDevice', { deviceId: 'bad id', fcmToken: 't', platform: 'desktop' })).code).toBe('invalid-argument');
    // platform は enum 外なら 'other' に正規化。同一 fcmToken は重複排除（古い端末ドキュメントが消える）
    await call(B, 'registerDevice', { deviceId: 'dev-bx', fcmToken: 'tok-dup', platform: 'web' });
    expect(strVal(await restGet(PROJECT, `users/${B.uid}/devices/dev-bx`), 'platform')).toBe('other');
    await call(B, 'registerDevice', { deviceId: 'dev-by', fcmToken: 'tok-dup', platform: 'ios' });
    expect(await restGet(PROJECT, `users/${B.uid}/devices/dev-bx`)).toBeNull();
    expect(strVal(await restGet(PROJECT, `users/${B.uid}/devices/dev-by`), 'platform')).toBe('ios');
    await call(B, 'registerDevice', { deviceId: 'dev-by', fcmToken: 'tok-dup', platform: 'ios' });
    const r = await call(B, 'sendTestNotification', {});
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect((await call(O, 'sendTestNotification', {})).sent).toBe(0); // 端末なし
  });

  it('notifyHandoverCreated: 決定的IDのジョブ作成・冪等・作成者以外は拒否', async () => {
    const hid = await createFamilyDoc(O, `families/${familyId}/handovers`, { text: '通知テスト', priority: 'important', recipientUids: [B.uid], expiresAt: null, relatedRefs: [], status: 'open' });
    expect((await callErr(B, 'notifyHandoverCreated', { familyId, handoverId: hid })).code).toBe('permission-denied');
    expect((await callErr(C, 'notifyHandoverCreated', { familyId, handoverId: hid })).code).toBe('permission-denied'); // 非メンバー
    const r1 = await call(O, 'notifyHandoverCreated', { familyId, handoverId: hid });
    expect(r1.queued).toBe(1);
    expect(r1.sent).toBe(1);
    const jobId = `handover_${hid}_r1_${B.uid}`;
    const job = await restGet(PROJECT, `notificationJobs/${jobId}`);
    expect(job).toBeTruthy();
    expect(strVal(job, 'status')).toBe('sent');
    const r2 = await call(O, 'notifyHandoverCreated', { familyId, handoverId: hid });
    expect(r2.queued).toBe(0);
    expect(r2.sent).toBe(0);
    expect((await callErr(O, 'notifyHandoverCreated', { familyId, handoverId: 'nope' })).code).toBe('not-found');
  });

  it('syncScheduleReminder: created -> updated -> cancelled (+ updateDoc/deleteDoc 内部連動)', async () => {
    const start = new Date(Date.now() + 3 * 3600_000);
    const sid = await createFamilyDoc(O, `families/${familyId}/schedules`, {
      title: '通院', category: 'medical', allDay: false, startAt: Timestamp.fromDate(start), timezone: 'Asia/Tokyo', assigneeUids: [B.uid], status: 'planned', relatedRefs: [],
    });
    const key = (ms: number) => `schedule_${sid}_${ms - 3600_000}_${B.uid}`;
    const find = async () => {
      const j = await restGet(PROJECT, `notificationJobs/${key(start.getTime())}`);
      return j;
    };
    const first = await call(O, 'syncScheduleReminder', { familyId, scheduleId: sid });
    expect(first.action).toBe('created');
    expect(strVal(await find(), 'status')).toBe('pending');
    expect((await call(O, 'syncScheduleReminder', { familyId, scheduleId: sid })).action).toBe('none'); // 冪等

    // 時刻変更（Admin 相当で直接書換え）-> updated。旧ジョブは skipped
    const start2 = new Date(start.getTime() + 3600_000);
    await restPatchTimestamp(PROJECT, `families/${familyId}/schedules/${sid}`, 'startAt', start2);
    expect((await call(O, 'syncScheduleReminder', { familyId, scheduleId: sid })).action).toBe('updated');
    const old = await find();
    expect(strVal(old, 'status')).toBe('skipped');
    expect(strVal(old, 'resultNote')).toBe('schedule-changed');

    // 予定削除（Admin 相当）-> cancelled
    await restDelete(PROJECT, `families/${familyId}/schedules/${sid}`);
    expect((await call(O, 'syncScheduleReminder', { familyId, scheduleId: sid })).action).toBe('cancelled');
    expect((await call(O, 'syncScheduleReminder', { familyId, scheduleId: sid })).action).toBe('none');

    // updateDoc / deleteDoc からの内部連動
    const sid2 = await createFamilyDoc(O, `families/${familyId}/schedules`, {
      title: '健診', category: 'medical', allDay: false, startAt: Timestamp.fromDate(start), timezone: 'Asia/Tokyo', assigneeUids: [B.uid], status: 'planned', relatedRefs: [],
    });
    await call(O, 'syncScheduleReminder', { familyId, scheduleId: sid2 });
    const k2 = `notificationJobs/schedule_${sid2}_${start.getTime() - 3600_000}_${B.uid}`;
    expect(strVal(await restGet(PROJECT, k2), 'status')).toBe('pending');
    const newStart = new Date(start.getTime() + 7200_000);
    await call(O, 'updateDoc', { familyId, kind: 'schedule', docId: sid2, expectedRevision: 1, patch: { startAt: newStart.toISOString() } });
    expect(strVal(await restGet(PROJECT, k2), 'status')).toBe('skipped');
    expect(strVal(await restGet(PROJECT, `notificationJobs/schedule_${sid2}_${newStart.getTime() - 3600_000}_${B.uid}`), 'status')).toBe('pending');
    await call(O, 'deleteDoc', { familyId, kind: 'schedule', docId: sid2, expectedRevision: 2 });
    expect(strVal(await restGet(PROJECT, `notificationJobs/schedule_${sid2}_${newStart.getTime() - 3600_000}_${B.uid}`), 'status')).toBe('skipped');
  });

  it('runDispatch: 呼び出し漏れの申し送りをスイープして送信する', async () => {
    const hid = await createFamilyDoc(O, `families/${familyId}/handovers`, { text: 'スイープ対象', priority: 'normal', recipientUids: [B.uid], expiresAt: null, relatedRefs: [], status: 'open' });
    const r = await testCall('runDispatch');
    expect(r.swept).toBeGreaterThanOrEqual(1);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const job = await restGet(PROJECT, `notificationJobs/handover_${hid}_r1_${B.uid}`);
    expect(strVal(job, 'status')).toBe('sent');
    // 再実行しても重複しない
    const r2 = await testCall('runDispatch');
    expect(r2.sent).toBe(0);
  });
});

describe('回数制限 (DISABLE_RATE_LIMIT なしの別プロセス)', () => {
  it('sendTestNotification は 1分に1回: 2回目は resource-exhausted / rate-limited', async () => {
    const R = await makeClient('rl');
    const rl = { endpoint: ENDPOINT_RL };
    await gasCall(R.auth, 'sendTestNotification', {}, rl);
    const e = await gasCall(R.auth, 'sendTestNotification', {}, rl).then(() => null, (x) => x as GasError);
    expect(e).toBeInstanceOf(GasError);
    expect(e!.code).toBe('resource-exhausted');
    expect(e!.details?.reason).toBe('rate-limited');
    expect(e!.details?.retryAfterSec).toBeGreaterThan(0);
    // 別ユーザーには影響しない
    const R2 = await makeClient('rl2');
    await gasCall(R2.auth, 'sendTestNotification', {}, rl);
  });
});

describe('追加シナリオ', () => {
  it('移譲提案先が退出すると提案が消える', async () => {
    const E = await makeClient('te'), F = await makeClient('tf');
    const { familyId: fid } = await call(E, 'createFamily', { familyName: '提案家', displayName: 'E', child: { nickname: 'e' } });
    const { token } = await call(E, 'createInvite', { familyId: fid });
    await call(F, 'acceptInvite', { token, displayName: 'F' });
    await call(E, 'transferOwnership', { familyId: fid, toUid: F.uid });
    expect((await restGet(PROJECT, `families/${fid}`)).fields.pendingOwnerTransfer).toBeDefined();
    await call(F, 'leaveFamily', { familyId: fid });
    expect((await restGet(PROJECT, `families/${fid}`)).fields.pendingOwnerTransfer).toBeUndefined();
    expect(strVal(await restGet(PROJECT, `families/${fid}`), 'ownerUid')).toBe(E.uid);
  });

  it('registerDevice: 他 uid の同一 fcmToken は除去される（A の端末が消え B に残る）', async () => {
    const A = await makeClient('da'), Bc = await makeClient('db');
    await call(A, 'registerDevice', { deviceId: 'dev-a', fcmToken: 'tok-shared-xyz', platform: 'web' });
    expect(await restGet(PROJECT, `users/${A.uid}/devices/dev-a`)).not.toBeNull();
    await call(Bc, 'registerDevice', { deviceId: 'dev-b', fcmToken: 'tok-shared-xyz', platform: 'web' });
    expect(await restGet(PROJECT, `users/${A.uid}/devices/dev-a`)).toBeNull();
    expect(await restGet(PROJECT, `users/${Bc.uid}/devices/dev-b`)).not.toBeNull();
  });

  it('exportFamilyData: 監査ログ family.export が1件だけ書かれる', async () => {
    const E = await makeClient('xe');
    const { familyId: fid } = await call(E, 'createFamily', { familyName: '出力家', displayName: 'E', child: { nickname: 'e' } });
    const count = async () => {
      const r = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'}/v1/projects/${PROJECT}/databases/(default)/documents/families/${fid}/auditLogs?pageSize=300`, { headers: { Authorization: 'Bearer owner' } });
      const j = (await r.json()) as { documents?: any[] };
      return (j.documents ?? []).filter((d) => strVal(d, 'action') === 'family.export').length;
    };
    expect(await count()).toBe(0);
    await call(E, 'exportFamilyData', { familyId: fid });
    expect(await count()).toBe(1);
  });

  it('exportFamilyData は1時間に3回まで（回数制限プロセス）', async () => {
    const R = await makeClient('rlx');
    const rl = { endpoint: ENDPOINT_RL };
    const { familyId: fid } = await gasCall(R.auth, 'createFamily', { familyName: '制限家', displayName: 'R', child: { nickname: 'r' } }, rl);
    for (let i = 0; i < 3; i++) await gasCall(R.auth, 'exportFamilyData', { familyId: fid }, rl);
    const e = await gasCall(R.auth, 'exportFamilyData', { familyId: fid }, rl).then(() => null, (x) => x as GasError);
    expect(e).toBeInstanceOf(GasError);
    expect(e!.code).toBe('resource-exhausted');
    expect(e!.details?.reason).toBe('rate-limited');
  });
});

describe('バックアップ・復元', () => {
  const RESTORE = 'demo-baby-hub-restore';
  const driveRoot = resolve(process.env.LOCAL_DRIVE_DIR ?? resolve(__dirname, '../gas/.local-drive'));
  let manifest: any;
  let fullIds: string[] = [];

  it('runBackupNow(full) -> ローカル Drive にパートと manifest', async () => {
    // 十分なデータ量にするため少し書いておく
    await createFamilyDoc(O, `families/${familyId}/tasks`, { title: 'バックアップ確認', category: 'procedure', status: 'todo', deadlineVerified: false, relatedRefs: [] });
    for (let i = 0; i < 3; i++) {
      await setDoc(doc(O.db, 'families', familyId, 'children', childId, 'events', crypto.randomUUID()), {
        schemaVersion: 1, childId, type: 'diaper', occurredAt: Timestamp.fromDate(new Date(Date.now() - i * 60_000)), recordedAt: Timestamp.now(),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: O.uid, updatedBy: O.uid, caregiverUid: O.uid,
        payload: { urine: 'yes', stool: 'no', changed: true }, revision: 1, status: 'active',
      });
    }
    const r = await testCall('runBackupNow', { kind: 'full' });
    expect(r.status).toBe('complete');
    expect(r.kind).toBe('full');
    expect(r.docs).toBeGreaterThan(10);
    const list: { name: string; id: string }[] = await testCall('listBackups');
    const mf = list.find((f) => f.name.endsWith('.manifest.json'));
    expect(mf).toBeTruthy();
    expect(existsSync(resolve(driveRoot, mf!.id))).toBe(true);
    manifest = JSON.parse(readFileSync(resolve(driveRoot, mf!.id), 'utf8'));
    expect(manifest.kind).toBe('full');
    expect(manifest.projectId).toBe(PROJECT);
    expect(manifest.docs).toBe(r.docs);
    const stamp = /chub-full-(\d{8}-\d{4})/.exec(mf!.name)![1];
    fullIds = list.filter((f) => f.name.startsWith(`chub-full-${stamp}`) && !f.name.endsWith('.manifest.json')).sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => f.id);
    expect(fullIds.length).toBe(manifest.parts);
    // バックアップに fcmToken が含まれない
    const txt = fullIds.map((id) => readFileSync(resolve(driveRoot, id), 'utf8')).join('');
    expect(txt).not.toContain('tok-b1-new');
  });

  it('本番と同じ projectId への復元は confirm なしで拒否', async () => {
    const args = { targetProjectId: PROJECT, fullFileId: fullIds.join(',') };
    await expect(testCall('runRestore', args)).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(testCall('runRestore', { ...args, confirm: 'yes' })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(testCall('runRestore', { targetProjectId: 'Bad_ID', fullFileId: fullIds.join(',') })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('別プロジェクトIDへ復元: users は復元されず、members は removed・匿名化、現在の displayName は維持される', async () => {
    // 復元先に O の members 文書だけ「現在値」として先に置く（現在の文書は上書きされない）
    const keep = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'}/v1/projects/${RESTORE}/databases/(default)/documents/families/${familyId}/members/${O.uid}`, {
      method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { displayName: { stringValue: '現在の名前' }, status: { stringValue: 'active' }, role: { stringValue: 'owner' } } }),
    });
    expect(keep.ok).toBe(true);
    const r = await testCall('runRestore', { targetProjectId: RESTORE, fullFileId: fullIds.join(',') });
    expect(r.complete).toBe(true);
    expect(r.written).toBeLessThan(manifest.docs); // devices / users は復元しない
    for (const p of ['families', `families/${familyId}/members`, `families/${familyId}/handovers`, `families/${familyId}/tasks`, `families/${familyId}/children`,
      `families/${familyId}/children/${childId}/events`]) {
      const src = await restCount(PROJECT, p);
      const dst = await restCount(RESTORE, p);
      expect(dst, p).toBe(src);
      expect(src, p).toBeGreaterThan(0);
    }
    // 空の復元先には users/* を復元しない
    expect(await restCount(PROJECT, 'users')).toBeGreaterThan(0);
    expect(await restCount(RESTORE, 'users')).toBe(0);
    expect(await restCount(RESTORE, `users/${B.uid}/familyRefs`)).toBe(0);
    // 現在の displayName / status は維持され、不在メンバーは removed + 匿名名
    const cur = await restGet(RESTORE, `families/${familyId}/members/${O.uid}`);
    expect(strVal(cur, 'displayName')).toBe('現在の名前');
    expect(strVal(cur, 'status')).toBe('active');
    const gone = await restGet(RESTORE, `families/${familyId}/members/${B.uid}`);
    expect(strVal(gone, 'status')).toBe('removed');
    expect(strVal(gone, 'displayName')).toBe('退出したメンバー');
    const a = await restGet(PROJECT, `families/${familyId}`);
    const b = await restGet(RESTORE, `families/${familyId}`);
    expect(strVal(b, 'name')).toBe(strVal(a, 'name'));
    expect(strVal(b, 'status')).toBe('restoring');
    expect(await restCount(RESTORE, `users/${B.uid}/devices`)).toBe(0);
    expect(b.fields.createdAt.timestampValue).toBe(a.fields.createdAt.timestampValue); // Timestamp が往復で保たれる
    // 本番側は変更されていない
    expect(Number((await restGet(PROJECT, `families/${familyId}`)).fields.memberCount.integerValue)).toBe(2);
  });
});

describe('削除系', () => {
  it('deleteFamily: 確認名不一致/非オーナーは拒否、オーナーは全削除（再認証済み）', async () => {
    const r = await call(D, 'createFamily', { familyName: '消す家', displayName: 'D', child: { nickname: 'd' } });
    const fid = r.familyId;
    expect((await callErr(D, 'deleteFamily', { familyId: fid, confirmName: '違う名前' })).details?.reason).toBe('confirm-mismatch');
    expect((await callErr(C, 'deleteFamily', { familyId: fid, confirmName: '消す家' })).code).toBe('permission-denied');
    await call(D, 'deleteFamily', { familyId: fid, confirmName: '消す家' });
    expect(await restGet(PROJECT, `families/${fid}`)).toBeNull();
    expect(await restCount(PROJECT, `families/${fid}/members`)).toBe(0);
    expect(await restCount(PROJECT, `families/${fid}/children`)).toBe(0);
    await denied(getDoc(doc(D.db, 'families', fid)));
  });

  it('validSinceより古いトークンは unauthenticated (deleteFamily / deleteAccount)', async () => {
    const U = await makeClient('stale');
    const f = await call(U, 'createFamily', { familyName: '古い家', displayName: 'U', child: { nickname: 'u' } });
    const real = await U.auth.currentUser!.getIdToken(true);
    const [h, p] = real.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.auth_time = Math.floor(Date.now() / 1000) - 3600;
    const stale = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
    for (const [fn, data] of [['deleteFamily', { familyId: f.familyId, confirmName: '古い家' }], ['deleteAccount', {}]] as const) {
      const e = await gasCall(U.auth, fn, data, { idToken: stale }).then(() => null, (x) => x as GasError);
      expect(e, `${fn}: エミュレータが無署名トークンを受理しない場合は unauthenticated になる`).toBeInstanceOf(GasError);
      expect(e!.code).toBe('unauthenticated');
    }
    expect((await restGet(PROJECT, `families/${f.familyId}`))).toBeTruthy(); // 何も消えていない
  });

  it('deleteAccount: 他メンバーがいるオーナーは拒否 / 単独家族のみのユーザーは家族ごと削除され Auth ユーザーも消える', async () => {
    const e = await callErr(O, 'deleteAccount', {});
    expect(e.code).toBe('failed-precondition');
    expect(e.details?.reason).toBe('owner-has-members');

    const E = await makeClient('del');
    const f = await call(E, 'createFamily', { familyName: '退会家', displayName: 'E', child: { nickname: 'e' } });
    await setDoc(doc(E.db, 'users', E.uid), { settings: NO_QUIET }, { merge: true });
    await call(E, 'registerDevice', { deviceId: 'dev-e', fcmToken: 'tok-e', platform: 'desktop' });
    await call(E, 'deleteAccount', {});
    expect(await restGet(PROJECT, `users/${E.uid}`)).toBeNull();
    expect(await restGet(PROJECT, `users/${E.uid}/devices/dev-e`)).toBeNull();
    expect(await restGet(PROJECT, `families/${f.familyId}`)).toBeNull();
    // Identity Toolkit accounts:delete が Auth エミュレータで効いている
    const chk = getAuth(initializeApp({ projectId: PROJECT, apiKey: 'k', appId: 'a' }, `chk-${Date.now()}`));
    connectAuthEmulator(chk, 'http://127.0.0.1:9099', { disableWarnings: true });
    await expect(signInWithEmailAndPassword(chk, E.email, PASSWORD)).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('deleteAccount: 一般メンバー(B)は退会扱いで家族は残る', async () => {
    await call(B, 'deleteAccount', {});
    expect(strVal(await restGet(PROJECT, `families/${familyId}/members/${B.uid}`), 'status')).toBe('left');
    expect(await restGet(PROJECT, `users/${B.uid}`)).toBeNull();
    expect(await restGet(PROJECT, `families/${familyId}`)).toBeTruthy();
    expect(Number((await restGet(PROJECT, `families/${familyId}`)).fields.memberCount.integerValue)).toBe(1);
  });
});
