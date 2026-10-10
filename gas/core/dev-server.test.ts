import { describe, expect, it } from 'vitest';
import { assertSafeEnvironment, corsHeaders, testEndpointsEnabled } from './dev-server';

const emu = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };

describe('dev-server safety', () => {
  it('starts only for demo- projects with emulator env vars', () => {
    expect(() => assertSafeEnvironment({ ...emu })).not.toThrow();
    expect(() => assertSafeEnvironment({ ...emu, FIREBASE_PROJECT_ID: 'demo-x' })).not.toThrow();
    expect(() => assertSafeEnvironment({ ...emu, FIREBASE_PROJECT_ID: 'baby-hub-prod' })).toThrow(/demo-/);
    expect(() => assertSafeEnvironment({})).toThrow(/EMULATOR_HOST/);
    expect(() => assertSafeEnvironment({ FIRESTORE_EMULATOR_HOST: 'x:1' })).toThrow(/EMULATOR_HOST/);
  });
  it('enables /__test only with NODE_ENV=test and ENABLE_TEST_ENDPOINTS=1', () => {
    expect(testEndpointsEnabled({ NODE_ENV: 'test', ENABLE_TEST_ENDPOINTS: '1' })).toBe(true);
    expect(testEndpointsEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(testEndpointsEnabled({ ENABLE_TEST_ENDPOINTS: '1' })).toBe(false);
    expect(testEndpointsEnabled({ NODE_ENV: 'development', ENABLE_TEST_ENDPOINTS: '1' })).toBe(false);
  });
  it('reflects only localhost / 127.0.0.1 origins in CORS', () => {
    expect(corsHeaders('http://localhost:5173')['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(corsHeaders('http://127.0.0.1:4173')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4173');
    expect(corsHeaders('http://localhost')['Access-Control-Allow-Origin']).toBe('http://localhost');
    for (const o of ['https://evil.example', 'http://localhost.evil.example', 'http://evil.example:5173', 'https://localhost:5173', undefined]) {
      expect(corsHeaders(o)['Access-Control-Allow-Origin']).toBeUndefined();
    }
  });
});
