// Firebase 初期化。永続キャッシュは「信頼端末」のみ（共有端末はメモリキャッシュ）
import { initializeApp } from 'firebase/app';
import { browserLocalPersistence, browserSessionPersistence, connectAuthEmulator, getAuth, setPersistence } from 'firebase/auth';
import {
  clearIndexedDbPersistence,
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
} from 'firebase/firestore';
import { getMessaging, getToken, isSupported, type Messaging } from 'firebase/messaging';

import { WIPE_TIMEOUT_MESSAGE, WIPE_TIMEOUT_MS, raceWithTimeout } from './startup';
import { PENDING_WIPE_KEY, TRUSTED_KEY, idbNamesFor, isPreservedKey, nextPendingWipe, parsePendingWipe, serializePendingWipe, type WipeTarget } from './wipe';

export { TRUSTED_KEY, LOCAL_PREFIX } from './wipe';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

export function isTrustedDevice(): boolean {
  try {
    return localStorage.getItem(TRUSTED_KEY) === '1';
  } catch {
    return false;
  }
}

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: isTrustedDevice() && readPending().length === 0
    ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    : memoryLocalCache(),
});

if (useEmulators) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
}

/**
 * 信頼端末の設定を保存する。Firestore のキャッシュ種別は初期化時に決まるため、
 * 反映は次回のページ読み込み後（呼び出し側で location.reload() するとよい）。
 */
export async function enableTrustedDeviceCache(trusted: boolean): Promise<void> {
  await setPersistence(auth, trusted ? browserLocalPersistence : browserSessionPersistence);
  try {
    if (trusted) localStorage.setItem(TRUSTED_KEY, '1');
    else localStorage.removeItem(TRUSTED_KEY);
  } catch {
    throw new Error('端末の設定を保存できませんでした。');
  }
}

/** FCM が使えるブラウザなら Messaging、不可なら null */
export async function getMessagingIfSupported(): Promise<Messaging | null> {
  try {
    if (!(await isSupported())) return null;
    return getMessaging(app);
  } catch {
    return null;
  }
}

/** FCM トークン取得（許可済みの場合のみ呼ぶこと）。SW へ設定値をクエリで渡す */
export async function getFcmToken(): Promise<string | null> {
  const messaging = await getMessagingIfSupported();
  if (!messaging || !('serviceWorker' in navigator)) return null;
  const q = new URLSearchParams({
    apiKey: config.apiKey ?? '',
    projectId: config.projectId ?? '',
    messagingSenderId: config.messagingSenderId ?? '',
    appId: config.appId ?? '',
  });
  const registration = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${q}`);
  return getToken(messaging, { vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY, serviceWorkerRegistration: registration });
}

function deleteIdb(name: string): Promise<boolean> {
  return new Promise((res) => {
    try {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => res(true);
      r.onerror = () => res(false);
      r.onblocked = () => res(false); // 他タブが開いている。やり残しとして次回起動時に再試行
    } catch { res(false); }
  });
}
async function deleteIdbByTarget(target: WipeTarget): Promise<boolean> {
  try {
    if (!indexedDB.databases) return true; // 独自 IndexedDB は現在使用していない。Firestore は SDK の削除 API で処理する
    const names = idbNamesFor(target, (await indexedDB.databases()).map((d) => d.name));
    return (await Promise.all(names.map(deleteIdb))).every(Boolean);
  } catch { return false; }
}
function readPending(): WipeTarget[] {
  try { return parsePendingWipe(localStorage.getItem(PENDING_WIPE_KEY)); } catch { return []; }
}
function writePending(t: WipeTarget[]): void {
  try {
    const v = serializePendingWipe(t);
    if (v) localStorage.setItem(PENDING_WIPE_KEY, v); else localStorage.removeItem(PENDING_WIPE_KEY);
  } catch { /* ignore */ }
}

/**
 * 前回の清掃のやり残し（ch.pendingWipe）を、Firestore を使う前に削除する。成功した対象だけフラグを外す。
 * AuthProvider がこれの完了を待ってから購読を始める。
 */
async function runPendingWipe(): Promise<void> {
  const pending = readPending();
  if (!isTrustedDevice() && !pending.includes('firestore')) pending.push('firestore');
  if (!pending.length) return;
  const ok: WipeTarget[] = [];
  for (const t of pending) {
    if (t === 'firestore') {
      try { await clearIndexedDbPersistence(db); ok.push(t); } catch { /* retry next startup */ }
    } else if (await deleteIdbByTarget(t)) ok.push(t);
  }
  const remaining = nextPendingWipe(pending, [], ok);
  writePending(remaining);
  if (remaining.length) throw new Error(WIPE_TIMEOUT_MESSAGE);
}
// 消去が止まる（他タブが IndexedDB を掴んでいる等）場合も 15 秒で失敗として扱い、画面は開かない
export const pendingWipeDone: Promise<void> = raceWithTimeout(runPendingWipe(), WIPE_TIMEOUT_MS, WIPE_TIMEOUT_MESSAGE);
export const authPersistenceReady = setPersistence(auth, isTrustedDevice() ? browserLocalPersistence : browserSessionPersistence);
// Attach handlers immediately; AuthProvider also surfaces failures to the user.
void pendingWipeDone.catch(() => undefined);
void authPersistenceReady.catch(() => undefined);

/**
 * ログアウト時の端末清掃。Firestore 終了 → 永続キャッシュ削除 → 独自 LocalStorage/IndexedDB 削除。
 * 終了後の db は使えないため、呼び出し後はページを再読み込みすること。
 * 失敗したステップは ch.pendingWipe に残し、次回起動時に再削除する（localStorage 自体の削除は対象外）。
 */
let clearing: Promise<void> | null = null;
export function clearLocalData(): Promise<void> {
  return (clearing ??= doClearLocalData());
}
async function doClearLocalData(): Promise<void> {
  const failed: WipeTarget[] = [];
  const ok: WipeTarget[] = [];
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
    ok.push('firestore');
  } catch (e) {
    console.warn('Firestore キャッシュの削除に失敗（他のタブが開いている可能性）。次回起動時に再削除します', e);
    failed.push('firestore');
  }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('ch.') && !isPreservedKey(k)) localStorage.removeItem(k);
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('ch.')) sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  if (await deleteIdbByTarget('app')) ok.push('app'); else failed.push('app');
  writePending(nextPendingWipe(readPending(), failed, ok));
  if (failed.length) throw new Error('端末のデータを消去できません。他のタブを閉じて、再読み込み後にもう一度消去してください。');
}

// Stop caching in other open tabs when this browser becomes a shared device.
window.addEventListener('storage', (event) => {
  if (event.key === TRUSTED_KEY && event.newValue !== '1') {
    void setPersistence(auth, browserSessionPersistence).then(() => terminate(db)).finally(() => window.location.reload());
  }
});
