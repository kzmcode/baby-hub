import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { auth, authPersistenceReady, clearLocalData, getFcmToken, isTrustedDevice, pendingWipeDone } from '../lib/firebase';
import { cleanupDeviceRegistration, cleanupIfSharedDevice, currentPlatform } from '../lib/device';
import { api } from '../lib/api';

interface AuthValue {
  user: User | null;
  loading: boolean;
  /** skipCleanup: 呼び出し側で cleanupDeviceRegistration 済み（アカウント削除など）の場合 */
  signOut(opts?: { skipCleanup?: boolean }): Promise<void>;
}
/**
 * ログイン後の端末再登録。通知許可済み＋この端末で一度有効化済み（ch.deviceId あり）の場合のみ、
 * トークンを取り直して現在のユーザーに紐付ける（別ユーザーでログインし直した端末でも通知が届くように）。失敗は無視。
 */
async function reregisterDevice(): Promise<void> {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!isTrustedDevice()) return; // 共有端末では通知を登録しない
    const deviceId = localStorage.getItem('ch.deviceId');
    if (!deviceId) return;
    const token = await getFcmToken();
    if (!token) return;
    await api.registerDevice({ deviceId, fcmToken: token, platform: currentPlatform() });
  } catch { /* best effort */ }
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);

  // 前回の端末清掃のやり残し（ch.pendingWipe）を、Firestore 利用前に削除してから認証状態を購読する
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    void Promise.all([pendingWipeDone, authPersistenceReady]).then(() => {
      if (cancelled) return;
      let sharedChecked = false;
      unsub = onAuthStateChanged(auth, (u) => {
        // 共有端末に通知登録が残っていれば解除（ログイン済みなら devices も削除、未ログインなら FCM と SW のみ）
        if (!sharedChecked) { sharedChecked = true; void cleanupIfSharedDevice(u?.uid); }
        setUser(u);
        setLoading(false);
        if (u) void reregisterDevice();
      });
    }).catch((e: unknown) => { if (!cancelled) setStartupError(e instanceof Error ? e.message : '端末の初期化に失敗しました。'); });
    return () => { cancelled = true; unsub?.(); };
  }, []);

  /**
   * ログアウト: 通知登録の整理（FCM トークン・devices・SW、認証が有効なうちに）→ 認証解除（各購読が停止）
   * → Firestore終了・キャッシュ削除 → 再読み込みで状態を完全に初期化
   */
  const signOut = useCallback(async (opts?: { skipCleanup?: boolean }) => {
    if (!opts?.skipCleanup) await cleanupDeviceRegistration(auth.currentUser?.uid);
    try { await fbSignOut(auth); } catch { /* 削除済みアカウント等。続行して端末を清掃する */ }
    await new Promise((r) => setTimeout(r, 50)); // 購読解除の effect cleanup を待つ
    try { await clearLocalData(); } finally { window.location.replace('/login'); }
  }, []);

  const value = useMemo(() => ({ user, loading, signOut }), [user, loading, signOut]);
  if (startupError) return <main role="alert"><p>{startupError}</p><button onClick={() => window.location.reload()}>再読み込み</button></main>;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('AuthProvider が必要です');
  return v;
}
