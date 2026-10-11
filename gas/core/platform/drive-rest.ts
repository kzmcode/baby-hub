// Drive REST API v3 による DriveAdapter（スコープ drive.file で動く）。DriveApp は全ドライブ権限が必要になるため使わない。
// drive.file では「このアプリ（スクリプト）が作成したファイル」だけが見える。HTTP と トークン取得は注入する。
import type { DriveAdapter } from './types';

export interface DriveHttp {
  fetch(url: string, init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string }): { status: number; body: string };
  getAccessToken(): string;
  /** 指定すると全リクエストに x-goog-user-project を付ける */
  userProject?(): string | undefined;
}

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive の q 文字列リテラル用エスケープ */
export function qLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function createDriveRestAdapter(http: DriveHttp): DriveAdapter {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { contentType?: string; body?: string } = {}): string => {
    const headers: Record<string, string> = { Authorization: `Bearer ${http.getAccessToken()}` };
    const up = http.userProject?.();
    if (up) headers['x-goog-user-project'] = up;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    const res = http.fetch(url, { method, headers, body: opts.body });
    if (res.status < 200 || res.status >= 300) {
      // 原因の切り分け用に Google API エラーの reason / message を添える（本文に個人情報は含まれない）
      let detail = '';
      try {
        const e = (JSON.parse(res.body) as { error?: { message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } }).error;
        const reason = e?.errors?.[0]?.reason ?? e?.details?.[0]?.reason;
        detail = [reason, e?.message?.slice(0, 200)].filter(Boolean).join(': ');
      } catch { /* 本文が JSON でない */ }
      throw new Error(`Drive API ${method} failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
    }
    return res.body;
  };
  const list = (q: string, fields: string): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    let pageToken = '';
    do {
      const url = `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${fields})`)}&pageSize=1000&spaces=drive${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const j = JSON.parse(call('GET', url)) as { files?: Record<string, unknown>[]; nextPageToken?: string };
      out.push(...(j.files ?? []));
      pageToken = j.nextPageToken ?? '';
    } while (pageToken);
    return out;
  };

  return {
    ensureFolder(name) {
      const found = list(`name=${qLiteral(name)} and mimeType='${FOLDER_MIME}' and trashed=false`, 'id');
      if (found.length > 0) return found[0].id as string;
      const body = call('POST', `${API}/files?fields=id`, { contentType: 'application/json', body: JSON.stringify({ name, mimeType: FOLDER_MIME }) });
      return (JSON.parse(body) as { id: string }).id;
    },
    writeJson(folderId, name, json) {
      const boundary = `chub${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
        + `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n--${boundary}--`;
      const res = call('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, { contentType: `multipart/related; boundary=${boundary}`, body });
      return (JSON.parse(res) as { id: string }).id;
    },
    listFiles(folderId, includeTrashed = false) {
      return list(`${qLiteral(folderId)} in parents${includeTrashed ? '' : ' and trashed=false'}`, 'id,name,createdTime').map((f) => ({
        id: f.id as string, name: f.name as string, createdAt: new Date(f.createdTime as string),
      }));
    },
    readJson(fileId) {
      return call('GET', `${API}/files/${encodeURIComponent(fileId)}?alt=media`);
    },
    remove(fileId) { call('DELETE', `${API}/files/${encodeURIComponent(fileId)}`); },
    trash(fileId) {
      call('PATCH', `${API}/files/${encodeURIComponent(fileId)}`, { contentType: 'application/json', body: JSON.stringify({ trashed: true }) });
    },
  };
}
