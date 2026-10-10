import { describe, expect, it, vi } from 'vitest';
vi.mock('./firebase', () => ({ db: {}, getMessagingIfSupported: async () => null }));
import { platformFromUA } from './device';

describe('platformFromUA', () => {
  it('detects', () => {
    expect(platformFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(platformFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(platformFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('desktop');
    expect(platformFromUA('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(platformFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
    expect(platformFromUA('curl/8')).toBe('other');
  });
});
