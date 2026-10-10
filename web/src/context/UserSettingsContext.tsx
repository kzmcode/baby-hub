import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { setDoc } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { paths, useDocument } from '../lib/db';
import type { UserDoc, UserSettings } from '../types/models';

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'system',
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  notify: { handoverImportant: true, handoverNormal: true, scheduleReminder: true, taskDue: true, dose: true },
  homeItems: [
    { key: 'status', visible: true },
    { key: 'recent', visible: true },
    { key: 'quickRecord', visible: true },
    { key: 'todayRhythm', visible: true },
    { key: 'handovers', visible: true },
    { key: 'todayPlans', visible: true },
    { key: 'shopping', visible: true },
  ],
  quickRecordTypes: ['diaper', 'feeding', 'vomit', 'sleep', 'bath', 'other'],
};

const THEME_KEY = 'ch.theme';

/** 保存済み設定に既定値を重ねる（新しい項目が増えても欠けないように） */
export function mergeSettings(saved?: Partial<UserSettings> | null): UserSettings {
  const s = saved ?? {};
  const known = new Set((s.homeItems ?? []).map((h) => h.key));
  let homeItems = s.homeItems
    ? [...s.homeItems, ...DEFAULT_SETTINGS.homeItems.filter((h) => !known.has(h.key))]
    : DEFAULT_SETTINGS.homeItems;
  // Upgrade the previous default layout while preserving custom ordering and visibility.
  const previousOrder = 'status,quickRecord,todayRhythm,recent,handovers,todayPlans,shopping';
  if (homeItems.map((item) => item.key).join(',') === previousOrder) {
    homeItems = DEFAULT_SETTINGS.homeItems.map((item) => homeItems.find((saved) => saved.key === item.key)!);
  }
  return {
    theme: s.theme ?? DEFAULT_SETTINGS.theme,
    quietHours: { ...DEFAULT_SETTINGS.quietHours, ...s.quietHours },
    notify: { ...DEFAULT_SETTINGS.notify, ...s.notify },
    homeItems,
    quickRecordTypes: s.quickRecordTypes ?? DEFAULT_SETTINGS.quickRecordTypes,
  };
}

/** data-theme を反映。system のときは属性を外して prefers-color-scheme に任せる */
export function applyTheme(theme: UserSettings['theme']): void {
  const el = document.documentElement;
  if (theme === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

/** 起動直後（描画前）に呼ぶ: 前回のテーマを即時反映してちらつきを防ぐ */
export function applyStoredTheme(): void {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch { /* ignore */ }
}

interface Value {
  settings: UserSettings;
  update(partial: Partial<UserSettings>): Promise<void>;
}
const Ctx = createContext<Value | null>(null);

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const doc = useDocument<UserDoc>(uid ? paths.user(uid) : null);
  const settings = useMemo(() => mergeSettings(doc.data?.settings), [doc.data?.settings]);

  useEffect(() => { if (uid && !doc.loading) applyTheme(settings.theme); }, [uid, doc.loading, settings.theme]);

  const update = useCallback(
    async (partial: Partial<UserSettings>) => {
      if (!uid) return;
      await setDoc(paths.user(uid), { settings: { ...settings, ...partial } }, { merge: true });
    },
    [uid, settings],
  );

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUserSettings(): Value {
  const v = useContext(Ctx);
  if (!v) throw new Error('UserSettingsProvider が必要です');
  return v;
}
