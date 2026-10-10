import { describe, expect, it } from 'vitest';
import { safeHttpsUrl, telHref } from './safeUrl';

describe('safeHttpsUrl', () => {
  it('accepts https', () => expect(safeHttpsUrl(' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1'));
  it.each(['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'https://u:p@example.com', 'example.com', '', null, undefined])('rejects %s', (v) => {
    expect(safeHttpsUrl(v as string)).toBeNull();
  });
});
describe('telHref', () => {
  it('keeps digits + -', () => expect(telHref('+81 (3) 1234-5678')).toBe('tel:+8131234-5678'));
  it('strips scripts', () => expect(telHref('javascript:1;123')).toBe('tel:1123'));
  it('rejects short', () => expect(telHref('12')).toBeNull());
});
