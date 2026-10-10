import { describe, expect, it } from 'vitest';
import { buildInviteLink, extractToken, parseHashToken, stashInviteFromLocation } from './invite';

const T = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12345';
describe('invite token', () => {
  it('parses hash', () => {
    expect(parseHashToken(`#token=${T}`)).toBe(T);
    expect(parseHashToken(`token=${T}`)).toBe(T);
    expect(parseHashToken('#token=short')).toBeNull();
    expect(parseHashToken('')).toBeNull();
  });
  it('extracts from link, fragment or raw', () => {
    expect(extractToken(` https://x.app/join#token=${T} `)).toBe(T);
    expect(extractToken(T)).toBe(T);
    expect(extractToken(`#token=${T}`)).toBe(T);
    expect(extractToken('hello')).toBeNull();
  });
  it('builds link', () => {
    expect(buildInviteLink('https://x.app', T)).toBe(`https://x.app/join#token=${T}`);
  });
});

describe('stashInviteFromLocation', () => {
  it('stores token and drops hash from from', () => {
    const saved: string[] = [];
    expect(stashInviteFromLocation({ pathname: '/join', search: '', hash: `#token=${T}` }, (t) => saved.push(t))).toBe('/join');
    expect(saved).toEqual([T]);
  });
  it('keeps unrelated hash', () => {
    expect(stashInviteFromLocation({ pathname: '/records', search: '?a=1', hash: '#x' }, () => { throw new Error('no'); })).toBe('/records?a=1#x');
  });
  it('drops malformed token hash too', () => {
    expect(stashInviteFromLocation({ pathname: '/join', search: '', hash: '#token=short' }, () => {})).toBe('/join');
  });
});
