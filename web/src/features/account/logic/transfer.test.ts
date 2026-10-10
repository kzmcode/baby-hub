import { describe, expect, it } from 'vitest';
import { transferErrorMessage, transferView } from './transfer';

const ts = (ms: number) => ({ toMillis: () => ms });
const p = { toUid: 'b', proposedBy: 'a', expiresAt: ts(2000) };
describe('transferView', () => {
  it('none', () => { expect(transferView(null, 'a', 0).kind).toBe('none'); expect(transferView(p, null, 0).kind).toBe('none'); });
  it('roles', () => {
    expect(transferView(p, 'a', 1000).kind).toBe('proposer');
    expect(transferView(p, 'b', 1000).kind).toBe('recipient');
    expect(transferView(p, 'c', 1000).kind).toBe('other');
  });
  it('expiry', () => {
    expect(transferView(p, 'b', 1999)).toMatchObject({ expired: false });
    expect(transferView(p, 'b', 2000)).toMatchObject({ expired: true });
  });
});
describe('transferErrorMessage', () => {
  it('maps reasons', () => {
    expect(transferErrorMessage({ details: { reason: 'transfer-expired' } }, 'x')).toContain('有効期限');
    expect(transferErrorMessage({ details: { reason: 'no-pending-transfer' } }, 'x')).toContain('取り消された');
    expect(transferErrorMessage({}, 'x')).toBe('x');
  });
});
