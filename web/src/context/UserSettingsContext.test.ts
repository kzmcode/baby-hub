import { describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types/models';

vi.mock('firebase/firestore', () => ({ setDoc: vi.fn() }));
vi.mock('./AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../lib/db', () => ({ paths: {}, useDocument: vi.fn() }));

import { DEFAULT_SETTINGS, mergeSettings } from './UserSettingsContext';

describe('home layout settings', () => {
  it('upgrades the previous standard layout and retains hidden sections', () => {
    const homeItems: UserSettings['homeItems'] = [
      { key: 'status', visible: true },
      { key: 'quickRecord', visible: true },
      { key: 'todayRhythm', visible: true },
      { key: 'recent', visible: true },
      { key: 'handovers', visible: false },
      { key: 'todayPlans', visible: true },
      { key: 'shopping', visible: false },
    ];
    const result = mergeSettings({ homeItems, theme: 'dark', quickRecordTypes: ['feeding', 'diaper'] });
    expect(result.homeItems.map((item) => item.key)).toEqual(DEFAULT_SETTINGS.homeItems.map((item) => item.key));
    expect(result.homeItems.filter((item) => !item.visible).map((item) => item.key)).toEqual(['handovers', 'shopping']);
    expect(result.theme).toBe('dark');
    expect(result.quickRecordTypes).toEqual(['feeding', 'diaper']);
    expect(homeItems[1].key).toBe('quickRecord');
  });

  it('keeps a personalized order and adds only missing sections', () => {
    const saved: UserSettings['homeItems'] = [
      { key: 'quickRecord', visible: true },
      { key: 'handovers', visible: false },
      { key: 'status', visible: true },
    ];
    const items = mergeSettings({ homeItems: saved }).homeItems;
    expect(items.slice(0, saved.length)).toEqual(saved);
    expect(new Set(items.map((item) => item.key)).size).toBe(DEFAULT_SETTINGS.homeItems.length);
  });

  it('places recent records before care actions for new users', () => {
    expect(mergeSettings().homeItems.slice(0, 4).map((item) => item.key)).toEqual(['status', 'recent', 'quickRecord', 'todayRhythm']);
  });
});
