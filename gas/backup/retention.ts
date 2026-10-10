// バックアップのファイル名・世代管理（純粋関数）
// 名前: chub-{full|inc}-{yyyyMMdd-HHmm}.json（1つ目のパート）, ....p{n}.json（2つ目以降）, ....manifest.json（完了印）
import { JST_OFFSET_MS } from '../notify/quiet';

export const KEEP_FULL = 4;
export const KEEP_INC_DAYS = 14;
export const INCOMPLETE_GRACE_DAYS = 3;

export type BackupKind = 'full' | 'incremental';

export function jstStamp(ms: number): string {
  const s = new Date(ms + JST_OFFSET_MS).toISOString(); // 2026-10-11T03:00:00.000Z
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}`;
}
export function jstDate(ms: number): string { return jstStamp(ms).slice(0, 8); }
export function jstHour(ms: number): number { return new Date(ms + JST_OFFSET_MS).getUTCHours(); }
export function jstWeekday(ms: number): number { return new Date(ms + JST_OFFSET_MS).getUTCDay(); } // 0=日
export function stampToMs(stamp: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - JST_OFFSET_MS;
}

export function fileName(kind: BackupKind, stamp: string, part: number | 'manifest'): string {
  const k = kind === 'full' ? 'full' : 'inc';
  if (part === 'manifest') return `chub-${k}-${stamp}.manifest.json`;
  return part <= 1 ? `chub-${k}-${stamp}.json` : `chub-${k}-${stamp}.p${part}.json`;
}

export interface ParsedName { kind: BackupKind; stamp: string; part: number | 'manifest' }
export function parseName(name: string): ParsedName | null {
  const m = /^chub-(full|inc)-(\d{8}-\d{4})(?:\.(p(\d+)|manifest))?\.json$/.exec(name);
  if (!m) return null;
  const part = m[3] === 'manifest' ? 'manifest' : m[4] ? Number(m[4]) : 1;
  return { kind: m[1] === 'full' ? 'full' : 'incremental', stamp: m[2], part };
}

export interface DriveFile { id: string; name: string; createdAt: Date }
export interface Group { kind: BackupKind; stamp: string; files: DriveFile[]; complete: boolean; ms: number }

export function groupBackups(files: DriveFile[]): Group[] {
  const map = new Map<string, Group>();
  for (const f of files) {
    const p = parseName(f.name);
    if (!p) continue;
    const key = `${p.kind}:${p.stamp}`;
    let g = map.get(key);
    if (!g) { g = { kind: p.kind, stamp: p.stamp, files: [], complete: false, ms: stampToMs(p.stamp) }; map.set(key, g); }
    g.files.push(f);
    if (p.part === 'manifest') g.complete = true;
  }
  return [...map.values()].sort((a, b) => b.ms - a.ms);
}

export interface RetentionPlan { trash: string[]; stale: boolean }

/**
 * 保持ルール: フル・差分とも14日（フルは最大4世代）、未完了は3日経過で削除。
 * ただし期限内の完了フルが1世代も無い場合は、最新の完了フルとそれ以降の差分を残す（復元手段の全消去を避ける）。
 * その状態は stale として返す（運用ログ backup.stale 用）。完全削除するファイルIDを trash に返す。
 */
export function planRetention(files: DriveFile[], nowMs: number): RetentionPlan {
  const groups = groupBackups(files); // 新しい順
  const maxAge = KEEP_INC_DAYS * 86400000;
  const completeFulls = groups.filter((g) => g.complete && g.kind === 'full');
  const fresh = completeFulls.some((g) => nowMs - g.ms < maxAge);
  const newestFull = completeFulls[0];
  const stale = !fresh && groups.some((g) => g.complete); // 完了世代がまだ無い初回運用は警告しない
  const keepLatest = !fresh;
  const trash: string[] = [];
  let fulls = 0;
  for (const g of groups) {
    let drop = false;
    if (!g.complete) drop = nowMs - g.ms > INCOMPLETE_GRACE_DAYS * 86400000;
    else if (g.kind === 'full') {
      fulls++;
      drop = fulls > KEEP_FULL || nowMs - g.ms >= maxAge;
      if (keepLatest && g === newestFull) drop = false;
    } else {
      drop = nowMs - g.ms >= maxAge;
      if (keepLatest && newestFull && g.ms >= newestFull.ms) drop = false;
    }
    if (drop) for (const f of g.files) trash.push(f.id);
  }
  return { trash, stale };
}

export function selectTrash(files: DriveFile[], nowMs: number): string[] { return planRetention(files, nowMs).trash; }
