// 起動時・端末設定まわりの純粋関数（テスト用に firebase から分離）
/** 起動時の端末消去の打ち切り時間 */
export const WIPE_TIMEOUT_MS = 15_000;
export const WIPE_TIMEOUT_MESSAGE = '端末のデータを消去できませんでした。他のタブやウィンドウで Childcare Hub を開いている場合は閉じてから再読み込みしてください。';

/** p が ms 以内に終わらなければ message で reject する（p 自体は止めない） */
export function raceWithTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** プッシュ通知を有効にできるのは信頼端末のみ */
export function canEnableNotifications(trusted: boolean): boolean {
  return trusted;
}
export const SHARED_DEVICE_NOTIFY_MESSAGE = '共有端末では通知を有効にできません。この端末を信頼端末に設定してください';

/** 共有端末に通知登録（端末ID・FCM 用 SW）が残っていれば解除が必要 */
export function needsRegistrationCleanup(trusted: boolean, hasDeviceId: boolean, hasFcmSw: boolean): boolean {
  return !trusted && (hasDeviceId || hasFcmSw);
}
