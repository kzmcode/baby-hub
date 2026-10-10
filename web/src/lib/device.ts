// 端末の通知登録まわり（端末ID・platform 判定・ログアウト/削除時の整理）
import { deleteDoc, doc } from 'firebase/firestore';
import { deleteToken } from 'firebase/messaging';
import { db, getMessagingIfSupported, isTrustedDevice } from './firebase';
import { needsRegistrationCleanup } from './startup';

const DEVICE_KEY = 'ch.deviceId';
export const FCM_SW_PATH = '/firebase-messaging-sw.js';

export type DevicePlatform = 'ios' | 'android' | 'desktop' | 'other';

/** UA から registerDevice の platform enum を判定（iPadOS は Macintosh UA + タッチで判定） */
export function platformFromUA(ua: string, maxTouchPoints = 0): DevicePlatform {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows NT|Macintosh|X11|CrOS|Linux/.test(ua)) return 'desktop';
  return 'other';
}
export function currentPlatform(): DevicePlatform {
  return platformFromUA(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/** この端末の ID（端末ごとの通知登録用）。localStorage 不可なら都度生成 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 * ログアウト・アカウント削除前の端末の通知登録の整理。アカウント削除前（認証が有効なうち）に呼ぶこと。
 * FCM トークン削除 → devices ドキュメント削除 → FCM 用 SW の登録解除。どれが失敗しても続行する。
 */
export async function cleanupDeviceRegistration(uid: string | null | undefined): Promise<void> {
  try {
    const m = await getMessagingIfSupported();
    if (m) await withTimeout(deleteToken(m), 5000);
  } catch { /* ignore */ }
  try {
    // オフライン時は deleteDoc が完了しないためタイムアウトで諦める
    if (uid) await withTimeout(deleteDoc(doc(db, 'users', uid, 'devices', getDeviceId())), 5000);
  } catch { /* ignore: Rules で不可でもトークン削除済み */ }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs
          .filter((r) => [r.active, r.waiting, r.installing].some((w) => w?.scriptURL && new URL(w.scriptURL).pathname === FCM_SW_PATH))
          .map((r) => r.unregister()),
      );
    }
  } catch { /* ignore */ }
}

/** この端末に通知登録（端末ID または FCM 用 SW）が残っているか */
export async function hasDeviceRegistration(): Promise<boolean> {
  let hasId = false;
  try { hasId = !!localStorage.getItem(DEVICE_KEY); } catch { /* ignore */ }
  let hasSw = false;
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      hasSw = regs.some((r) => [r.active, r.waiting, r.installing].some((w) => w?.scriptURL && new URL(w.scriptURL).pathname === FCM_SW_PATH));
    }
  } catch { /* ignore */ }
  return needsRegistrationCleanup(isTrustedDevice(), hasId, hasSw);
}

/** 通知登録を解除し、端末IDも消す（再度有効化するときは新しい端末IDで登録し直す） */
export async function releaseDeviceRegistration(uid: string | null | undefined): Promise<void> {
  await cleanupDeviceRegistration(uid);
  try { localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ }
}

/** 共有端末に通知登録が残っていれば解除（未ログインなら FCM トークンと SW のみ） */
export async function cleanupIfSharedDevice(uid: string | null | undefined): Promise<void> {
  if (await hasDeviceRegistration()) await releaseDeviceRegistration(uid);
}
