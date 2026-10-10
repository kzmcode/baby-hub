import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const braces = require('braces');
const micromatch = require('micromatch');
describe('installed brace security patch', () => {
  it('rejects the stack exhaustion payload in every public walker', () => {
    const payload = '{'.repeat(10000) + 'a,b' + '}'.repeat(10000);
    for (const method of ['compile', 'expand', 'stringify', 'parse']) expect(() => braces[method](payload)).toThrow(SyntaxError);
    const malformed = '{]'.repeat(10000);
    expect(() => braces.compile(malformed)).toThrow(SyntaxError);
  });
  it('rejects deep and cyclic direct ASTs', () => {
    const ast: any = { type: 'root', nodes: [] }; let tail = ast;
    for (let i = 0; i < 1000; i++) { const node = { type: 'brace', nodes: [] }; tail.nodes.push(node); tail = node; }
    for (const method of ['compile', 'expand', 'stringify']) expect(() => braces[method](ast)).toThrow(SyntaxError);
    const cyclic: any = { type: 'root', nodes: [] }; cyclic.nodes.push(cyclic);
    expect(() => braces.compile(cyclic)).toThrow(SyntaxError);
  });
  it('preserves ordinary clasp ignore pattern matching', () => {
    expect(micromatch.not(['src/a.ts', 'src/a.js', 'dist/out.js'], ['dist/**', '**/*.{ts,tsx}'], { dot: true })).toEqual(['src/a.js']);
    expect(braces.expand('a/{b,c}/d')).toEqual(['a/b/d', 'a/c/d']);
  });
});
