import { describe, expect, it } from 'vitest';
import { createDriveRestAdapter, qLiteral } from './drive-rest';

function mk(responses: { status: number; body: string }[], userProject?: string) {
  const calls: { url: string; init: any }[] = [];
  const http = {
    fetch: (url: string, init: any) => { calls.push({ url, init }); return responses.shift() ?? { status: 500, body: '' }; },
    getAccessToken: () => 'tok',
    userProject: userProject ? () => userProject : undefined,
  };
  return { calls, drive: createDriveRestAdapter(http) };
}

describe('DriveRestAdapter', () => {
  it('qLiteral は引用符とバックスラッシュをエスケープ', () => {
    expect(qLiteral("a'b\\c")).toBe("'a\\'b\\\\c'");
  });
  it('ensureFolder: 既存を再利用 / 無ければ作成', () => {
    const a = mk([{ status: 200, body: JSON.stringify({ files: [{ id: 'F1' }] }) }]);
    expect(a.drive.ensureFolder('X')).toBe('F1');
    expect(decodeURIComponent(a.calls[0].url)).toContain("name='X' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    expect(a.calls[0].init.headers.Authorization).toBe('Bearer tok');
    const b = mk([{ status: 200, body: '{}' }, { status: 200, body: '{"id":"F2"}' }]);
    expect(b.drive.ensureFolder('X')).toBe('F2');
    expect(b.calls[1].init.method).toBe('POST');
  });
  it('writeJson: multipart、parents 指定', () => {
    const a = mk([{ status: 200, body: '{"id":"N1"}' }]);
    expect(a.drive.writeJson('F1', 'a.json', '{"k":1}')).toBe('N1');
    const c = a.calls[0];
    expect(c.url).toContain('uploadType=multipart');
    expect(c.init.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(c.init.body).toContain('"parents":["F1"]');
    expect(c.init.body).toContain('{"k":1}');
  });
  it('listFiles: parents 条件・ページング', () => {
    const a = mk([
      { status: 200, body: JSON.stringify({ files: [{ id: '1', name: 'a', createdTime: '2026-01-01T00:00:00.000Z' }], nextPageToken: 'P' }) },
      { status: 200, body: JSON.stringify({ files: [{ id: '2', name: 'b', createdTime: '2026-01-02T00:00:00.000Z' }] }) },
    ]);
    const files = a.drive.listFiles('F1');
    expect(files.map((f) => f.id)).toEqual(['1', '2']);
    expect(files[0].createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(decodeURIComponent(a.calls[0].url)).toContain("'F1' in parents and trashed=false");
    expect(a.calls[1].url).toContain('pageToken=P');
  });
  it('readJson / trash / エラー', () => {
    const a = mk([{ status: 200, body: '{"x":1}' }, { status: 200, body: '{}' }, { status: 404, body: 'no' }]);
    expect(a.drive.readJson('Z')).toBe('{"x":1}');
    expect(a.calls[0].url).toContain('/files/Z?alt=media');
    a.drive.trash('Z');
    expect(JSON.parse(a.calls[1].init.body)).toEqual({ trashed: true });
    expect(() => a.drive.readJson('Q')).toThrow('HTTP 404');
  });
  it('adds x-goog-user-project when a user project is configured', () => {
    const a = mk([{ status: 200, body: JSON.stringify({ files: [{ id: 'F1' }] }) }], 'proj-1');
    a.drive.ensureFolder('X');
    expect(a.calls[0].init.headers['x-goog-user-project']).toBe('proj-1');
    const b = mk([{ status: 200, body: JSON.stringify({ files: [{ id: 'F1' }] }) }]);
    b.drive.ensureFolder('X');
    expect(b.calls[0].init.headers['x-goog-user-project']).toBeUndefined();
  });
});

it('permanently deletes expired backups, including files already in Drive trash', () => {
  const calls: { url: string; method: string }[] = [];
  const drive = createDriveRestAdapter({ getAccessToken: () => 'token', fetch: (url, init) => { calls.push({ url, method: init.method }); return { status: init.method === 'DELETE' ? 204 : 200, body: init.method === 'DELETE' ? '' : '{"files":[]}' }; } });
  drive.listFiles('folder', true);
  drive.remove('expired');
  expect(decodeURIComponent(calls[0]!.url)).not.toContain('trashed=false');
  expect(calls[1]).toEqual({ url: 'https://www.googleapis.com/drive/v3/files/expired', method: 'DELETE' });
});
