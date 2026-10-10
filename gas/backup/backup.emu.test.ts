// バックアップ・復元の結合テスト（Firestore エミュレータ）。npm run test:emu
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackups, runBackupNow, runRestore } from './index';
import { dbFor, setPlatform } from '../core/context';
import { Timestamp } from '../core/firestore';
import { createNodePlatform } from '../core/platform/node';
import { hashToken } from '../shared/pure';

const run = `b${Date.now()}`;
function setup(label: string) {
  const raw = createNodePlatform({ ...process.env, DISABLE_RATE_LIMIT: '1', LOCAL_DRIVE_DIR: mkdtempSync(join(tmpdir(), 'baby-hub-bk-')) });
  const local = { ...raw, config: { ...raw.config, projectId: `demo-${label}-${run}` } };
  setPlatform(local);
  return { local, src: dbFor(local) };
}
const dbOf = (local: ReturnType<typeof setup>['local'], projectId: string) => dbFor({ ...local, config: { ...local.config, projectId } });
const ids = (kind: string) => listBackups().filter((d) => d.name.startsWith(`chub-${kind}-`) && !d.name.includes('manifest')).map((d) => d.id).join(',');

function seed(src: ReturnType<typeof setup>['src'], fid: string) {
  src.doc('users/u1').set({ displayName: 'Alice-old' });
  src.doc('users/u2').set({ displayName: 'Bob-old' });
  src.doc('users/u2/settings/main').set({ theme: 'x' });
  src.doc(`users/u2/familyRefs/${fid}`).set({ status: 'active', role: 'owner' });
  src.doc(`families/${fid}`).set({ name: 'F', ownerUid: 'u1', status: 'active', memberCount: 2 });
  src.doc(`families/${fid}/members/u1`).set({ uid: 'u1', displayName: 'Alice-old', role: 'owner', status: 'active' });
  src.doc(`families/${fid}/members/u2`).set({ uid: 'u2', displayName: 'Bob-old', role: 'editor', status: 'active' });
  for (let i = 0; i < 7; i++) src.doc(`families/${fid}/tasks/t${i}`).set({ title: `t${i}`, updatedAt: Timestamp.now() });
}

describe('復元の個人情報と users', () => {
  it('現在値を優先し、不在の members は匿名化、users 不在なら復元しない', () => {
    const { local, src } = setup('priv');
    const fid = `f${run}`;
    seed(src, fid);
    expect(runBackupNow('full').status).toBe('complete');
    const full = ids('full');
    const target = `demo-priv-t-${run}`;
    const dest = dbOf(local, target);
    dest.doc('users/u1').set({ displayName: 'Alice-new' });
    dest.doc(`families/${fid}`).set({ name: 'F', ownerUid: 'u1', status: 'active', memberCount: 1 });
    dest.doc(`families/${fid}/members/u1`).set({ uid: 'u1', displayName: 'Alice-new', role: 'owner', status: 'active' });
    expect(runRestore(target, full, '').complete).toBe(true);
    expect(dest.doc(`families/${fid}/members/u1`).get().data()).toMatchObject({ displayName: 'Alice-new', status: 'active', role: 'owner' });
    expect(dest.doc('users/u1').get().data()).toMatchObject({ displayName: 'Alice-new' });
    expect(dest.doc(`families/${fid}/members/u2`).get().data()).toMatchObject({ displayName: '退出したメンバー', status: 'removed' });
    expect(dest.doc('users/u2').get().exists).toBe(false);
    expect(dest.doc('users/u2/settings/main').get().exists).toBe(false);
    expect(dest.doc(`users/u2/familyRefs/${fid}`).get().exists).toBe(false);
    expect(dest.doc(`families/${fid}/tasks/t3`).get().exists).toBe(true);
    setPlatform(local);
  });
});

describe('復元の再開', () => {
  it('中断後に同じ引数で続きから再開し、重複して書き込まない', () => {
    const { local, src } = setup('resume');
    const fid = `f${run}`;
    seed(src, fid);
    runBackupNow('full');
    const full = ids('full');
    const whole = `demo-resume-a-${run}`;
    const total = runRestore(whole, full, '').written;
    const target = `demo-resume-b-${run}`;
    const dest = dbOf(local, target);
    const first = runRestore(target, full, '', undefined, { chunkSize: 2, maxChunks: 1 });
    expect(first.complete).toBe(false);
    expect(first.written).toBeLessThanOrEqual(2);
    const st = dest.doc('system/restoreState').get().data();
    expect(st.docIndex).toBe(2);
    // 別引数（ここでは差分の指定が違う扱い）ではなく、同じ引数で再実行
    const second = runRestore(target, full, '', undefined, { chunkSize: 2 });
    expect(second.complete).toBe(true);
    expect(second.written).toBe(total);
    expect(dest.doc('system/restoreState').get().exists).toBe(false);
    setPlatform(local);
  });
});

describe('削除記録の清掃と整合検証', () => {
  it('期限切れの削除記録だけを清掃し、バックアップには各記録を1回だけ保存する', () => {
    const { local, src } = setup('purge');
    const old = Timestamp.fromMillis(Date.now() - 30 * 86400000);
    for (let i = 0; i < 3; i++) src.doc(`deletions/${hashToken(`families/old${i}`)}`).set({ path: `families/old${i}`, deletedAt: old });
    src.doc(`deletions/${hashToken('families/recent')}`).set({ path: 'families/recent', deletedAt: Timestamp.now() });
    expect(runBackupNow('full').status).toBe('complete');
    expect(src.collection('deletions').get().size).toBe(1);
    expect(src.doc(`deletions/${hashToken('families/recent')}`).get().exists).toBe(true);
    const part = JSON.parse(local.drive!.readJson(ids('full').split(',')[0])) as { docs: { path: string }[] };
    expect(part.docs.filter((d) => d.path.startsWith('deletions/')).length).toBe(1);
    setPlatform(local);
  });

  it('完了印の無い世代・フルより古い差分は復元前に拒否', () => {
    const { local, src } = setup('pre');
    src.doc('users/u1').set({ displayName: 'x' });
    runBackupNow('incremental'); // 先に差分（フルより古い）
    const inc = ids('inc');
    runBackupNow('full');
    const full = ids('full');
    expect(() => runRestore(`demo-pre-t-${run}`, full, inc)).toThrow(/older than the full/);
    const folder = local.drive!.ensureFolder('BabyHub-Backup');
    const mf = local.drive!.listFiles(folder).find((f) => f.name.startsWith('chub-full-') && f.name.includes('manifest'))!;
    local.drive!.remove(mf.id);
    expect(() => runRestore(`demo-pre-t-${run}`, full, '')).toThrow(/manifest/);
    setPlatform(local);
  });
});
