import { describe, expect, it } from 'vitest';
import { BOM, buildCsvFiles, csvCell, flatten, toCsv } from './csv';
import type { ExportData } from '../../../lib/api';

describe('csv', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });
  it('neutralises formula injection for strings only', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(-3)).toBe('-3');
  });
  it('flattens nested objects and arrays', () => {
    expect(flatten({ a: { b: 1 }, c: [1, 2], d: null })).toEqual({ 'a.b': 1, c: '[1,2]', d: '' });
  });
  it('builds union columns', () => {
    const csv = toCsv([{ id: 'a', payload: { x: 1 } }, { id: 'b', payload: { y: 2 } }]);
    expect(csv).toBe('id,payload.x,payload.y\r\na,1,\r\nb,,2\r\n');
  });
  it('builds per-collection files with BOM and childId', () => {
    const data = {
      exportedAt: '2026-10-08T00:00:00Z', family: {}, members: [],
      children: [{ child: { id: 'c1', nickname: 'もも' }, events: [{ id: 'e1', type: 'diaper' }], healthProfile: null, medications: [], doseOccurrences: [], medicalVisits: [], vaccinations: [] }],
      schedules: [], tasks: [], shopping: [], handovers: [], contacts: [],
    } as ExportData;
    const files = buildCsvFiles(data);
    const ev = files.find((f) => f.key === 'events')!;
    expect(ev.content.startsWith(BOM)).toBe(true);
    expect(ev.content).toContain('childId,id,type');
    expect(ev.filename).toBe('baby-hub-events-2026-10-08.csv');
    expect(files.map((f) => f.key)).toEqual(['events', 'children']);
  });
});
