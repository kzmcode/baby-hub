// 招待トークンの抽出（純粋関数）。トークンはフラグメント `#token=...` で受け取る
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

export const INVITE_STORAGE_KEY = 'ch.inviteToken';

export function isValidToken(t: string): boolean {
  return TOKEN_RE.test(t);
}

/** `#token=xxx` / `token=xxx` / `#a=1&token=xxx` からトークンを取り出す。無い・形式不正は null */
export function parseHashToken(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const t = new URLSearchParams(h).get('token');
  return t && isValidToken(t.trim()) ? t.trim() : null;
}

/** 手入力・貼り付け用: 招待リンク全体 / フラグメント / 生トークンのいずれからでもトークンを取り出す */
export function extractToken(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (isValidToken(s)) return s;
  const i = s.indexOf('#');
  if (i >= 0) return parseHashToken(s.slice(i));
  const m = /[?&#]?token=([A-Za-z0-9_-]+)/.exec(s);
  return m && isValidToken(m[1]) ? m[1] : null;
}

export function buildInviteLink(origin: string, token: string): string {
  return `${origin}/join#token=${token}`;
}

/**
 * 未ログインで保護ルートを開いたときの戻り先 (state.from) を作る。`/join#token=` のトークンは
 * save() で退避し、戻り先からはハッシュ（トークン）を取り除く。その他のハッシュは保持する。
 */
export function stashInviteFromLocation(loc: { pathname: string; search: string; hash: string }, save: (token: string) => void): string {
  const token = parseHashToken(loc.hash);
  if (token) {
    save(token);
    return `${loc.pathname}${loc.search}`;
  }
  return `${loc.pathname}${loc.search}${loc.hash && /token=/.test(loc.hash) ? '' : loc.hash}`;
}
