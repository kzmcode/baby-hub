// Firestore -> Google ドライブのバックアップと復元（G3）
// 日曜フル・他は差分。6分制限のため途中で打ち切り、状態 system/backupState から続きを再開する。
import { hashToken } from '../shared/pure';
import { Timestamp, createFirestore, type CollectionReference, type Firestore } from '../core/firestore';
import { ApiError } from '../core/errors';
import { getDb, getPlatform } from '../core/guards';
import type { DriveAdapter, Platform } from '../core/platform/types';
import { decodeValue, encodeDoc } from './codec';
import { purgeExpiredDeletions } from '../shared/deletions';
import { fileName, groupBackups, jstDate, jstHour, jstStamp, jstWeekday, parseName, planRetention, type BackupKind } from './retention';

export const BACKUP_FOLDER_NAME = 'BabyHub-Backup';
const STATE_PATH = 'system/backupState';
const BUDGET_MS = 4.5 * 60 * 1000;
const PART_BYTES = 5 * 1024 * 1024;
const DAILY_READ_BUDGET = 35000; // Spark の読取上限 5万/日 に対し、アプリ利用分の余裕を残す
const START_HOUR_JST = 3;
const SINCE_MARGIN_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const DELETION_PURGE_MS = 30 * 1000; // 削除記録の清掃に使う時間の上限
const DELETIONS_ROOT = 'deletions'; // roots 内の目印: 削除記録コレクションを1回の走査でまとめて保存する

/** 子コレクションを持つため全件走査して再帰するコレクション */
const RECURSE = new Set(['children', 'handovers']);
/** 時刻フィールドで差分を取れない（更新されても時刻が変わらない／件数が少ない）ため常に全件 */
const ALWAYS_FULL = new Set(['members', 'familyRefs', 'devices', 'healthProfiles']);
/** updatedAt 以外の時刻フィールドを使うコレクション */
const TIME_FIELD: Record<string, string> = { acks: 'acknowledgedAt', auditLogs: 'at' };

interface State {
  status: 'idle' | 'running';
  kind?: BackupKind; stamp?: string; startedAtMs?: number; sinceMs?: number | null;
  roots?: string[]; rootIndex?: number; partNo?: number; partIds?: string[];
  docCount?: number; readCount?: number; failures?: number;
  /** アップロード中のパート番号。再開時に同名ファイルが残っていれば削除して作り直す（重複防止） */
  uploadingPart?: number;
  /** 期限内の完了フルが無くなった最初の時刻（運用ログ用。Web 表示には使わない） */
  staleSince?: string;
  readsDate?: string; readsToday?: number;
  lastCompleted?: { kind: BackupKind; stamp: string; startedAtMs: number; date: string; lastFullMs: number };
}

export interface BackupResult { status: 'skipped' | 'paused' | 'complete'; kind?: BackupKind; docs?: number; reads?: number; parts?: number }

function loadState(db: Firestore): State {
  const s = db.doc(STATE_PATH).get();
  return s.exists ? (s.data() as State) : { status: 'idle' };
}
function saveState(db: Firestore, st: State): void {
  db.doc(STATE_PATH).set(JSON.parse(JSON.stringify(st)));
}

function tsMs(v: unknown): number | null {
  return v && typeof (v as { toMillis?: unknown }).toMillis === 'function' ? (v as { toMillis(): number }).toMillis() : null;
}

class Collector {
  docs: { path: string; data: unknown }[] = [];
  bytes = 0;
  reads = 0;
  constructor(private db: Firestore, private sinceMs: number | null) {}

  private add(path: string, data: Record<string, unknown>): void {
    const d = encodeDoc(path, data);
    this.docs.push(d);
    this.bytes += JSON.stringify(d).length;
  }

  collectRoot(rootPath: string): void {
    if (rootPath === DELETIONS_ROOT) {
      // 削除記録は全件を1回の走査で保存する（一覧取得と個別取得の二重読取をしない）
      const snap = this.db.collection('deletions').get();
      this.reads += Math.max(1, snap.size);
      for (const d of snap.docs) this.add(d.ref.path, d.data() as Record<string, unknown>);
      return;
    }
    const snap = this.db.doc(rootPath).get();
    this.reads++;
    if (!snap.exists) return;
    this.add(rootPath, snap.data() as Record<string, unknown>);
    this.walk(rootPath);
  }

  private walk(docPath: string): void {
    for (const col of this.db.listCollections(docPath)) this.collection(col);
  }

  private collection(col: CollectionReference): void {
    const name = col.id;
    const recurse = RECURSE.has(name);
    const field = TIME_FIELD[name] ?? 'updatedAt';
    const incremental = this.sinceMs !== null && !ALWAYS_FULL.has(name);
    // 再帰が必要なコレクションは配下の更新を拾うため全件を走査（件数は少ない）
    const snap = incremental && !recurse ? col.where(field, '>', Timestamp.fromMillis(this.sinceMs as number)).get() : col.get();
    this.reads += Math.max(1, snap.size);
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const include = !incremental || (tsMs(data[field]) ?? Infinity) > (this.sinceMs as number);
      if (include) this.add(d.ref.path, data);
      if (recurse) this.walk(d.ref.path);
    }
  }
}

function writePart(db: Firestore, drive: DriveAdapter, folderId: string, st: State, platform: Platform, docs: { path: string; data: unknown }[]): string {
  const partNo = (st.partNo ?? 0) + 1;
  // アップロード前に番号を記録する。保存前に中断しても、再開時に同名の残骸を削除して作り直せる。
  st.uploadingPart = partNo;
  saveState(db, st);
  const json = JSON.stringify({
    formatVersion: 2, kind: st.kind, projectId: platform.config.projectId, startedAt: new Date(st.startedAtMs as number).toISOString(),
    since: st.sinceMs ? new Date(st.sinceMs).toISOString() : null, part: partNo, docs,
  });
  const id = drive.writeJson(folderId, fileName(st.kind as BackupKind, st.stamp as string, partNo), json);
  st.partNo = partNo;
  st.uploadingPart = undefined;
  st.partIds = [...(st.partIds ?? []), id];
  return id;
}

function startNew(db: Firestore, platform: Platform, st: State, nowMs: number, force?: BackupKind): State {
  const last = st.lastCompleted;
  const fullDue = !last || nowMs - last.lastFullMs > 8 * 86400000;
  const kind: BackupKind = force ?? (jstWeekday(nowMs) === 0 || fullDue ? 'full' : 'incremental');
  const roots: string[] = [];
  for (const d of db.collection('users').get().docs) roots.push(`users/${d.id}`);
  for (const d of db.collection('families').get().docs) roots.push(`families/${d.id}`);
  roots.push(DELETIONS_ROOT);
  return {
    ...st, status: 'running', kind, stamp: jstStamp(nowMs), startedAtMs: nowMs,
    sinceMs: kind === 'incremental' && last ? last.startedAtMs - SINCE_MARGIN_MS : null,
    roots, rootIndex: 0, partNo: 0, partIds: [], docCount: 0, readCount: roots.length, failures: 0,
  };
}

export function runBackupNow(kind?: BackupKind): BackupResult { return step(kind, true); }
/** 時間主導トリガー（毎時推奨）から呼ぶ。JST 3時以降に1日1回開始し、未完了なら続きを再開する。 */
export function runDailyBackup(): BackupResult { return step(undefined, false); }

function step(force: BackupKind | undefined, manual: boolean): BackupResult {
  const platform = getPlatform();
  const db = getDb();
  const drive = platform.drive;
  if (!drive) throw new ApiError('failed-precondition', 'Drive is not available on this platform');
  const t0 = Date.now();
  const folderId = drive.ensureFolder(BACKUP_FOLDER_NAME);
  try { purgeExpiredDeletions(db, t0, t0 + DELETION_PURGE_MS); } catch (e) { platform.log('warn', 'deletion purge failed', { name: (e as Error).name }); }
  const stale0 = applyRetention(drive, folderId, platform, t0).stale;
  noteStale(db, stale0, t0);
  let st = loadState(db);
  if (st.status === 'running' && t0 - (st.startedAtMs ?? 0) > 3 * 86400000) {
    st = { status: 'idle', lastCompleted: st.lastCompleted, staleSince: st.staleSince };
    force = 'full';
  }

  if (st.status === 'running' && st.uploadingPart) removeStalePart(drive, folderId, st);
  if (st.status !== 'running') {
    const today = jstDate(t0);
    if (!manual && (st.lastCompleted?.date === today || jstHour(t0) < START_HOUR_JST)) return { status: 'skipped' };
    st = startNew(db, platform, st, t0, force);
    saveState(db, st);
  }

  try {
    const today = jstDate(t0);
    if (st.readsDate !== today) { st.readsDate = today; st.readsToday = 0; }
    const col = new Collector(db, st.sinceMs ?? null);
    let idx = st.rootIndex ?? 0;
    const roots = st.roots ?? [];
    let paused = false;
    const flush = () => {
      if (col.docs.length === 0) { st.rootIndex = idx; return; }
      writePart(db, drive, folderId, st, platform, col.docs);
      st.docCount = (st.docCount ?? 0) + col.docs.length;
      st.readCount = (st.readCount ?? 0) + col.reads;
      st.readsToday = (st.readsToday ?? 0) + col.reads;
      col.docs = []; col.bytes = 0; col.reads = 0;
      st.rootIndex = idx;
      saveState(db, st);
    };
    while (idx < roots.length) {
      if (Date.now() - t0 > BUDGET_MS || (st.readsToday ?? 0) + col.reads > DAILY_READ_BUDGET) { paused = true; break; }
      col.collectRoot(roots[idx]);
      idx++;
      if (col.bytes > PART_BYTES) flush();
    }
    flush();
    st.rootIndex = idx;
    if (paused) {
      saveState(db, st);
      platform.log('warn', 'backup paused', { kind: st.kind as string, done: idx, total: roots.length, reads: st.readCount ?? 0 });
      return { status: 'paused', kind: st.kind, docs: st.docCount, reads: st.readCount, parts: st.partNo };
    }

    // 完了: 空でも最低1パートを作り、manifest で完了を示す
    if ((st.partNo ?? 0) === 0) writePart(db, drive, folderId, st, platform, []);
    const kind = st.kind as BackupKind;
    const stamp = st.stamp as string;
    drive.writeJson(folderId, fileName(kind, stamp, 'manifest'), JSON.stringify({
      kind, projectId: platform.config.projectId, startedAt: new Date(st.startedAtMs as number).toISOString(),
      finishedAt: new Date().toISOString(), since: st.sinceMs ? new Date(st.sinceMs).toISOString() : null,
      parts: st.partNo, docs: st.docCount, reads: st.readCount,
      formatVersion: 2, notes: 'Deletion records included. Restore preserves current permissions; missing permissions remain disabled.',
    }));
    const lastFullMs = kind === 'full' ? (st.startedAtMs as number) : (st.lastCompleted?.lastFullMs ?? 0);
    const done: State = {
      status: 'idle', readsDate: st.readsDate, readsToday: st.readsToday, staleSince: st.staleSince,
      lastCompleted: { kind, stamp, startedAtMs: st.startedAtMs as number, date: jstDate(st.startedAtMs as number), lastFullMs },
    };
    saveState(db, done);
    const after = applyRetention(drive, folderId, platform, Date.now());
    const trashed = after.removed;
    noteStale(db, after.stale, Date.now());
    platform.log('info', 'backup complete', { kind, docs: st.docCount ?? 0, reads: st.readCount ?? 0, parts: st.partNo ?? 0, trashed });
    return { status: 'complete', kind, docs: st.docCount, reads: st.readCount, parts: st.partNo };
  } catch (e) {
    st.failures = (st.failures ?? 0) + 1;
    platform.log('error', 'backup failed', { name: (e as Error).name, failures: st.failures });
    if (st.failures >= MAX_FAILURES) st = { status: 'idle', lastCompleted: st.lastCompleted, staleSince: st.staleSince };
    try { saveState(db, st); } catch { /* 次回再試行 */ }
    throw e;
  }
}

function applyRetention(drive: DriveAdapter, folderId: string, platform: Platform, nowMs: number): { removed: number; stale: boolean } {
  const plan = planRetention(drive.listFiles(folderId, true), nowMs);
  for (const id of plan.trash) {
    try { drive.remove(id); } catch (e) { platform.log('warn', 'permanent backup removal failed', { name: (e as Error).name }); }
  }
  if (plan.stale) platform.log('warn', 'backup.stale', { note: 'no complete full backup within retention; keeping the latest full and later incrementals' });
  return { removed: plan.trash.length, stale: plan.stale };
}

/** 期限内の完了フルが無い状態の開始時刻を system/backupState.staleSince に記録／解除する（運用ログ用）。 */
function noteStale(db: Firestore, stale: boolean, nowMs: number): void {
  try {
    const st = loadState(db);
    if (stale && !st.staleSince) saveState(db, { ...st, staleSince: new Date(nowMs).toISOString() });
    else if (!stale && st.staleSince) { const { staleSince: _drop, ...rest } = st; saveState(db, rest); }
  } catch { /* 運用ログ用の付随情報。次回再試行 */ }
}

/** 中断した前回のアップロードが残した同名パートを削除する。 */
function removeStalePart(drive: DriveAdapter, folderId: string, st: State): void {
  const name = fileName(st.kind as BackupKind, st.stamp as string, st.uploadingPart as number);
  for (const f of drive.listFiles(folderId)) if (f.name === name) drive.remove(f.id);
  st.uploadingPart = undefined;
}

// ---------- 復元（手動実行） ----------
function openFirestore(platform: Platform, projectId: string): Firestore {
  if (projectId === platform.config.projectId) return getDb();
  return createFirestore({ ...platform, config: { ...platform.config, projectId } });
}

const RESTORE_STATE_PATH = 'system/restoreState';
const RESTORE_CHUNK = 100;
const RESTORE_PATH_RE = /^(users|families|deletions)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const ANON_MEMBER_NAME = '退出したメンバー'; // shared/family-ops.ts REMOVED_NAME と同じ値

export interface RestoreOptions { budgetMs?: number; chunkSize?: number; maxChunks?: number }
interface RestoreState { key: string; fileIndex: number; docIndex: number; written: number; startedAtMs: number; deleteIndex: number; files: string[] }
type RestorePart = { formatVersion?: number; projectId: string; kind: string; startedAt: string; part: number; docs: { path: string; data: Record<string, unknown> }[] };

/** 削除記録のパス集合。パスそのものか祖先パスが含まれていれば true（O(深さ)）。 */
export function isBlockedPath(deleted: Set<string>, path: string): boolean {
  const seg = path.split('/');
  for (let n = 2; n <= seg.length; n += 2) if (deleted.has(seg.slice(0, n).join('/'))) return true;
  return false;
}

/** 復元前の整合検証: 同一世代・パート欠落なし・manifest 完了・差分は対象フルより後。違反は failed-precondition。 */
function verifyRestoreSet(drive: DriveAdapter, ids: string[], fulls: RestorePart[], incs: RestorePart[]): void {
  const fail = (m: string): never => { throw new ApiError('failed-precondition', m); };
  const contiguous = (parts: RestorePart[]) => parts.every((p, i) => p.part === i + 1);
  if (new Set(fulls.map((p) => p.startedAt)).size !== 1) fail('fullFileId must contain exactly one full backup generation');
  if (!contiguous(fulls)) fail('Full backup parts are missing');
  const byGen = new Map<string, RestorePart[]>();
  for (const p of incs) byGen.set(p.startedAt, [...(byGen.get(p.startedAt) ?? []), p]);
  for (const [startedAt, ps] of byGen) {
    if (!contiguous(ps)) fail('Incremental backup parts are missing');
    if (startedAt < fulls[0].startedAt) fail('Incremental backup is older than the full backup');
  }
  // 名前から世代を特定できるファイルは manifest（完了印）と件数を照合する
  const folderId = drive.ensureFolder(BACKUP_FOLDER_NAME);
  const files = drive.listFiles(folderId);
  const names = new Map(files.map((f) => [f.id, f.name]));
  const groups = new Map(groupBackups(files).map((g) => [`${g.kind}:${g.stamp}`, g]));
  const given = new Map<string, Set<number>>();
  for (const id of ids) {
    const pn = names.has(id) ? parseName(names.get(id) as string) : null;
    if (!pn || pn.part === 'manifest') continue;
    const key = `${pn.kind}:${pn.stamp}`;
    given.set(key, (given.get(key) ?? new Set()).add(pn.part));
  }
  for (const [key, set] of given) {
    const g = groups.get(key);
    const mf = g?.files.find((f) => parseName(f.name)?.part === 'manifest');
    if (!g || !mf) fail('Backup is not complete (manifest is missing)');
    const total = (JSON.parse(drive.readJson((mf as { id: string }).id)) as { parts?: number }).parts;
    if (!Number.isInteger(total) || set.size !== total || [...set].some((n) => n < 1 || n > (total as number))) fail('Backup parts do not match the manifest');
  }
}

/**
 * フルバックアップ（複数パートはカンマ区切り）→ 差分（カンマ区切り、startedAt 昇順に適用）の順で書き戻す。
 * 本番（現在のプロジェクト）への復元は confirm==='OVERWRITE_PRODUCTION' が必要。
 * 進捗は復元先の system/restoreState に保存され、同じ引数で再実行すると続きから再開する（complete:true で消去）。
 */
export function runRestore(targetProjectId: string, fullFileId: string, incrementalFileIdsCsv: string, confirm?: string, opts: RestoreOptions = {}): { written: number; files: number; complete: boolean } {
  const platform = getPlatform();
  const drive = platform.drive;
  if (!drive) throw new ApiError('failed-precondition', 'Drive is not available on this platform');
  if (!/^[a-z][a-z0-9-]{3,28}[a-z0-9]$/.test(targetProjectId ?? '')) throw new ApiError('invalid-argument', 'Invalid targetProjectId');
  if (targetProjectId === platform.config.projectId && confirm !== 'OVERWRITE_PRODUCTION') {
    throw new ApiError('failed-precondition', "Restoring into the production project requires confirm='OVERWRITE_PRODUCTION'");
  }
  const split = (s: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const fullIds = split(fullFileId);
  if (fullIds.length === 0) throw new ApiError('invalid-argument', 'fullFileId is required');
  const incIds = split(incrementalFileIdsCsv);

  const read = (id: string): RestorePart => JSON.parse(drive.readJson(id)) as RestorePart;
  const fulls = fullIds.map(read);
  if (fulls.some((p) => p.kind !== 'full')) throw new ApiError('invalid-argument', 'fullFileId must refer to full backup files');
  const incs = incIds.map(read);
  if (incs.some((p) => p.kind !== 'incremental')) throw new ApiError('invalid-argument', 'incrementalFileIds must refer to incremental backup files');
  incs.sort((a, b) => (a.startedAt === b.startedAt ? a.part - b.part : a.startedAt < b.startedAt ? -1 : 1));
  fulls.sort((a, b) => a.part - b.part);

  const parts = [...fulls, ...incs];
  if (parts.some((p) => p.formatVersion !== 2 || p.projectId !== platform.config.projectId)) throw new ApiError('failed-precondition', 'Only version 2 backups from this project can be restored');
  verifyRestoreSet(drive, [...fullIds, ...incIds], fulls, incs);
  // Validate every path before the first write. System state, invites and notification jobs are never restored.
  for (const part of parts) for (const d of part.docs) {
    if (!RESTORE_PATH_RE.test(d.path) || d.path.split('/').length % 2 !== 0) throw new ApiError('invalid-argument', 'Invalid backup document path');
  }

  const db = openFirestore(platform, targetProjectId);
  const mk = (s: number, n: number) => new Timestamp(s, n);
  const t0 = Date.now();
  const budget = opts.budgetMs ?? BUDGET_MS;
  const chunkSize = opts.chunkSize ?? RESTORE_CHUNK;
  let chunksLeft = opts.maxChunks ?? Infinity;

  // 再開状態: 引数（対象・ファイル ID・順序）が同じ場合だけ続きから。
  const key = hashToken(JSON.stringify([targetProjectId, fullIds, incIds]));
  const saved = db.doc(RESTORE_STATE_PATH).get();
  let rs: RestoreState = saved.exists && (saved.data() as RestoreState).key === key
    ? (saved.data() as RestoreState)
    : { key, fileIndex: 0, docIndex: 0, written: 0, startedAtMs: t0, deleteIndex: 0, files: [...fullIds, ...incIds] };
  const persist = () => db.doc(RESTORE_STATE_PATH).set(rs);
  const stop = (): { written: number; files: number; complete: boolean } => {
    persist();
    platform.log('warn', 'restore paused', { target: targetProjectId, written: rs.written, fileIndex: rs.fileIndex, docIndex: rs.docIndex, deleteIndex: rs.deleteIndex });
    return { written: rs.written, files: parts.length, complete: false };
  };

  // 削除記録は本番・復元先・バックアップ内を各1回だけ読み、Set に集約（祖先パス照合で判定）。
  const deleted = new Set<string>();
  const addDeleted = (snap: { docs: { get(f: string): unknown }[] }) => { for (const d of snap.docs) { const p = d.get('path'); if (typeof p === 'string') deleted.add(p); } };
  addDeleted(getDb().collection('deletions').get());
  if (db !== getDb()) addDeleted(db.collection('deletions').get());
  for (const p of parts) for (const d of p.docs) if (d.path.startsWith('deletions/')) deleted.add((decodeValue(d.data, mk) as { path: string }).path);

  // 削除記録を先に適用（時間予算あり。進捗は deleteIndex）。
  const toDelete = [...deleted].filter((x) => /^(users|families)\//.test(x) && RESTORE_PATH_RE.test(x) && x.split('/').length % 2 === 0).sort();
  while (rs.deleteIndex < toDelete.length) {
    if (Date.now() - t0 > budget) return stop();
    db.recursiveDelete(db.doc(toDelete[rs.deleteIndex]));
    rs.deleteIndex++;
  }

  const FAMILY_ROOT = /^families\/([^/]+)$/;
  const MEMBER = /^families\/[^/]+\/members\/[^/]+$/;
  const FAMILY_REF = /^users\/[^/]+\/familyRefs\/[^/]+$/;
  const USER_ROOT = /^users\/([^/]+)$/;
  while (rs.fileIndex < parts.length) {
    const part = parts[rs.fileIndex];
    while (rs.docIndex < part.docs.length) {
      if (Date.now() - t0 > budget || chunksLeft <= 0) return stop();
      const slice = part.docs.slice(rs.docIndex, rs.docIndex + chunkSize);
      const cand = slice.filter((d) => !isBlockedPath(deleted, d.path) && !/\/devices\//.test(d.path) && !d.path.startsWith('deletions/'));
      // 現在の状態（家族・メンバー・所属索引・ユーザー）をまとめて1回で取得する。
      const need = new Map<string, ReturnType<Firestore['doc']>>();
      const want = (path: string) => { if (!need.has(path)) need.set(path, db.doc(path)); };
      for (const d of cand) {
        const seg = d.path.split('/');
        if (seg[0] === 'families') want(`families/${seg[1]}`);
        if (seg[0] === 'users') want(`users/${seg[1]}`);
        if (MEMBER.test(d.path) || FAMILY_REF.test(d.path) || FAMILY_ROOT.test(d.path)) want(d.path);
      }
      const refs = [...need.values()];
      const snaps = db.getAll(...refs);
      const live = new Map<string, Record<string, unknown> | undefined>();
      refs.forEach((r, i) => live.set(r.path, snaps[i].exists ? (snaps[i].data() as Record<string, unknown>) : undefined));
      const batch = db.batch();
      let n = 0;
      for (const d of cand) {
        const seg = d.path.split('/');
        if (seg[0] === 'families' && live.get(`families/${seg[1]}`)?.status === 'deleting') continue;
        // ユーザー本人の情報: 現在のアカウントが無ければ（削除済みの可能性）復元しない。あれば現在値を優先する。
        if (seg[0] === 'users') {
          if (USER_ROOT.test(d.path) || !live.get(`users/${seg[1]}`)) continue;
        }
        const cur = live.get(d.path);
        // 現在の文書がある members / familyRefs は現在値を優先（バックアップで上書きしない）。
        if ((MEMBER.test(d.path) || FAMILY_REF.test(d.path)) && cur) continue;
        const data = decodeValue(d.data, mk) as Record<string, unknown>;
        if (FAMILY_ROOT.test(d.path)) {
          data.status = cur?.status ?? 'restoring';
          data.ownerUid = cur?.ownerUid ?? data.ownerUid;
          data.memberCount = cur?.memberCount ?? 0;
          delete data.pendingOwnerTransfer;
        } else if (MEMBER.test(d.path)) {
          data.status = 'removed';
          data.role = 'editor';
          data.displayName = ANON_MEMBER_NAME; // 現在の文書が無い＝退出済みの可能性。過去の氏名を戻さない
        } else if (FAMILY_REF.test(d.path)) {
          data.status = 'removed';
          data.role = 'editor';
        }
        batch.set(db.doc(d.path), data);
        n++;
      }
      if (n > 0) batch.commit();
      rs.written += n;
      rs.docIndex += slice.length;
      chunksLeft--;
      persist();
    }
    rs.fileIndex++;
    rs.docIndex = 0;
  }
  db.doc(RESTORE_STATE_PATH).delete();
  platform.log('info', 'restore finished', { target: targetProjectId, written: rs.written, complete: true });
  return { written: rs.written, files: parts.length, complete: true };
}

/** ドライブ上のバックアップ一覧（ID 確認用。手動実行向け） */
export function listBackups(): { name: string; id: string }[] {
  const platform = getPlatform();
  const drive = platform.drive;
  if (!drive) throw new ApiError('failed-precondition', 'Drive is not available on this platform');
  const folderId = drive.ensureFolder(BACKUP_FOLDER_NAME);
  return drive.listFiles(folderId).filter((f) => parseName(f.name)).sort((a, b) => (a.name < b.name ? 1 : -1)).map((f) => ({ name: f.name, id: f.id }));
}
