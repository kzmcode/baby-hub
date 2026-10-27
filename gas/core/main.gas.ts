// GAS エントリポイント。build.mjs が esbuild で IIFE（グローバル名 CH）にまとめ、
// footer のトップレベル関数（doPost 等）から CH.* を呼ぶ。
import { runBackupNow, runDailyBackup, runRestore } from '../backup';
import { runDispatch } from '../notify';
import { metered } from './budget';
import { setPlatform } from './context';
import { gasPlatform } from './platform/gas';
import { handleRequest } from './router';

function json(s: string): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

export function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  return json(handleRequest(gasPlatform, e?.postData?.contents ?? ''));
}

export function doGet(_e?: unknown): GoogleAppsScript.Content.TextOutput {
  return json(JSON.stringify({ ok: true }));
}

/**
 * 時間主導トリガーの多重実行を避けるソフトロック（CacheService のキー＋短期 TTL）。
 * ScriptLock を共有しないので、通知ディスパッチとバックアップが互いをブロックしない。
 * 同名の実行同士（dispatch の重複、dailyBackup と backupNow）だけが排他になる。
 * TTL は 1 実行の上限（6 分）より少し長い 7 分。異常終了してもそれ以降は自動で解放される。
 */
const SOFT_LOCK_TTL_SEC = 420;
function withLock<T>(name: string, fn: () => T, lockName: string = name): T | undefined {
  const cache = CacheService.getScriptCache();
  const key = `lock:${lockName}`;
  const mine = gasPlatform.randomToken(8);
  if (cache.get(key)) {
    gasPlatform.log('warn', 'skipped: another run holds the lock', { name });
    return undefined;
  }
  cache.put(key, mine, SOFT_LOCK_TTL_SEC);
  Utilities.sleep(200);
  if (cache.get(key) !== mine) { // 同時に取りに行った別実行に負けた
    gasPlatform.log('warn', 'skipped: lost the lock race', { name });
    return undefined;
  }
  try {
    return fn();
  } finally {
    try { if (cache.get(key) === mine) cache.remove(key); } catch { /* TTL で解放される */ }
  }
}

export function dispatchNotifications(): void {
  setPlatform(gasPlatform);
  withLock('dispatchNotifications', () => metered(gasPlatform, 'trigger', () => runDispatch()));
}

export function dailyBackup(): void {
  setPlatform(gasPlatform);
  withLock('dailyBackup', () => metered(gasPlatform, 'trigger', () => runDailyBackup()));
}

/** 手動実行用。本番と同じ projectId への復元は confirm='OVERWRITE_PRODUCTION' が必要 */
export function restoreBackup(targetProjectId: string, fullFileId: string, incrementalFileIdsCsv: string, confirm?: string): void {
  setPlatform(gasPlatform);
  const r = runRestore(targetProjectId, fullFileId, incrementalFileIdsCsv, confirm);
  gasPlatform.log('info', 'restoreBackup finished', { written: r.written, files: r.files, complete: r.complete });
}

/** 手動実行用。kind 省略時は曜日で自動判定（'full' | 'incremental'） */
export function backupNow(kind?: 'full' | 'incremental'): void {
  setPlatform(gasPlatform);
  withLock('backupNow', () => metered(gasPlatform, 'trigger', () => runBackupNow(kind)), 'dailyBackup');
}

/** 手動実行用。エディタの「実行」は引数を渡せないため、フルを強制する入口を別に置く */
export function backupFullNow(): void {
  backupNow('full');
}

/** 初回に 1 回だけ手動実行する。既存トリガーを全削除して作り直す */
export function setupTriggers(): void {
  for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('dispatchNotifications').timeBased().everyMinutes(5).create();
  // runDailyBackup が JST 3 時以降に 1 日 1 回だけ開始し、途中再開も判定する
  ScriptApp.newTrigger('dailyBackup').timeBased().everyHours(1).create();
}
