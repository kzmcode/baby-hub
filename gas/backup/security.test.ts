import { describe, expect, it } from 'vitest';
import { setPlatform } from '../core/context';
import { fakePlatform } from '../core/test-utils';
import { runDailyBackup } from './index';
import { jstStamp } from './retention';

describe('backup retention before database access', () => {
  it('permanently removes expired full and incremental files even if the database is unavailable', () => {
    const p = fakePlatform(() => { throw new Error('database unavailable'); });
    const removed: string[] = [];
    const list = { id: 'expired-full', name: 'chub-full-20200101-0300.manifest.json', createdAt: new Date(0) };
    p.drive = {
      ensureFolder: () => 'folder', listFiles: (_folder, includeTrash) => { expect(includeTrash).toBe(true); return [list, { ...list, id: 'expired-inc', name: 'chub-inc-20200101-0300.manifest.json' }, { ...list, id: 'fresh-full', name: `chub-full-${jstStamp(Date.now() - 86400000)}.manifest.json` }]; },
      remove: (id) => { removed.push(id); }, trash: () => { throw new Error('must permanently remove'); }, writeJson: () => 'unused', readJson: () => '{}',
    };
    setPlatform(p);
    expect(() => runDailyBackup()).toThrow();
    expect(removed.sort()).toEqual(['expired-full', 'expired-inc']);
  });
});
