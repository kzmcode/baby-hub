import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// SW と同じ読み込み方（グローバル self に関数を生やす）で検証する
const sandbox: { self: Record<string, unknown>; URL: typeof URL } = { self: {}, URL };
runInNewContext(readFileSync(new URL('../../public/notification-url.js', import.meta.url), 'utf8'), sandbox);
const resolveNotificationUrl = sandbox.self.resolveNotificationUrl as (r: unknown, o: string) => string;
const O = 'https://app.example.com';
describe('resolveNotificationUrl', () => {
  it('keeps same-origin path', () => expect(resolveNotificationUrl('/plans/tasks/1?x=1#h', O)).toBe('/plans/tasks/1?x=1#h'));
  it('accepts same-origin absolute', () => expect(resolveNotificationUrl('https://app.example.com/more', O)).toBe('/more'));
  it.each(['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 'data:text/html,x', 'http://app.example.com/x', '\\\\evil.example', 123, undefined])('rejects %s', (v) => {
    expect(resolveNotificationUrl(v, O)).toBe('/');
  });
  it('allows http localhost', () => expect(resolveNotificationUrl('/a', 'http://localhost:5173')).toBe('/a'));
});
