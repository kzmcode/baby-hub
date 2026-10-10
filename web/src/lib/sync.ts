// 同期状態の購読。「端末に保存／未同期／共有済み／失敗」の判定材料を提供
import { useEffect, useState } from 'react';
import { waitForPendingWrites } from 'firebase/firestore';
import { db } from './firebase';

export interface SyncStatus {
  online: boolean;
  pendingWrites: boolean;
  lastSyncedAt: Date | null;
}

const LAST_SYNC_KEY = 'ch.lastSyncedAt'; // 端末ごとに保持（他端末と混ぜない）

function readLast(): Date | null {
  try {
    const v = localStorage.getItem(LAST_SYNC_KEY);
    return v ? new Date(v) : null;
  } catch {
    return null;
  }
}

export function useSyncStatus(): SyncStatus {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pendingWrites, setPending] = useState(false);
  const [lastSyncedAt, setLast] = useState<Date | null>(readLast);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // 未送信書き込みを周期的に確認（オンライン中のみ解決する waitForPendingWrites を競争させる）
  useEffect(() => {
    let alive = true;
    const check = async () => {
      let settled = false;
      const timer = new Promise<'pending'>((r) => setTimeout(() => r('pending'), 1500));
      const done = waitForPendingWrites(db).then(() => ((settled = true), 'done' as const));
      const r = await Promise.race([timer, done]);
      if (!alive) return;
      setPending(r === 'pending' && !settled);
      if (r === 'done' && navigator.onLine) {
        const now = new Date();
        setLast(now);
        try { localStorage.setItem(LAST_SYNC_KEY, now.toISOString()); } catch { /* ignore */ }
      }
    };
    void check();
    const t = setInterval(check, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [online]);

  return { online, pendingWrites, lastSyncedAt };
}
