// e2e 共通: GAS dev-server への fetch（web/src/lib/api.ts と同じ形式）と簡易ヘルパ
import type { Auth } from 'firebase/auth';

export const PROJECT = 'demo-kosodate-hub';
export const ENDPOINT = process.env.GAS_ENDPOINT ?? 'http://127.0.0.1:8787';

export class GasError extends Error {
  constructor(public code: string, message: string, public details?: any) {
    super(message);
  }
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  return res.json();
}

export async function gasCall<O = any>(auth: Auth, fn: string, data: unknown, opts: { forceRefresh?: boolean; idToken?: string; endpoint?: string } = {}): Promise<O> {
  const idToken = opts.idToken ?? (await auth.currentUser!.getIdToken(opts.forceRefresh));
  const json = await post(opts.endpoint ?? ENDPOINT, { fn, data, idToken });
  if (json.ok) return json.result as O;
  throw new GasError(json.error?.code, json.error?.message, json.error?.details);
}

/** 回数制限が有効な別プロセス */
export const ENDPOINT_RL = process.env.GAS_ENDPOINT_RL ?? 'http://127.0.0.1:8788';

/** NODE_ENV=test の dev-server だけが提供するテスト用内部エンドポイント */
export async function testCall<O = any>(name: string, args: unknown = {}): Promise<O> {
  const json = await post(`${ENDPOINT}/__test/${name}`, args);
  if (json.ok) return json.result as O;
  throw new GasError(json.error?.code, json.error?.message, json.error?.details);
}

// ---- Firestore REST（エミュレータ Admin 相当: Bearer owner はルールを迂回）----
const FS = `http://${process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'}/v1/projects`;
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

export async function restGet(project: string, path: string): Promise<any | null> {
  const r = await fetch(`${FS}/${project}/databases/(default)/documents/${path}`, { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`REST GET ${path}: ${r.status}`);
  return r.json();
}
export async function restCount(project: string, path: string): Promise<number> {
  let n = 0;
  let pageToken = '';
  do {
    const r = await fetch(`${FS}/${project}/databases/(default)/documents/${path}?pageSize=300&showMissing=false${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: H });
    if (!r.ok) throw new Error(`REST LIST ${path}: ${r.status}`);
    const j = (await r.json()) as { documents?: unknown[]; nextPageToken?: string };
    n += j.documents?.length ?? 0;
    pageToken = j.nextPageToken ?? '';
  } while (pageToken);
  return n;
}
export async function restPatchTimestamp(project: string, path: string, field: string, d: Date): Promise<void> {
  const r = await fetch(`${FS}/${project}/databases/(default)/documents/${path}?updateMask.fieldPaths=${field}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ fields: { [field]: { timestampValue: d.toISOString() } } }),
  });
  if (!r.ok) throw new Error(`REST PATCH ${path}: ${r.status}`);
}
export async function restDelete(project: string, path: string): Promise<void> {
  const r = await fetch(`${FS}/${project}/databases/(default)/documents/${path}`, { method: 'DELETE', headers: H });
  if (!r.ok) throw new Error(`REST DELETE ${path}: ${r.status}`);
}
/** families/{id}.pendingOwnerTransfer.expiresAt を書き換える（Admin 相当。期限切れの再現用） */
export async function restSetPendingTransferExpiry(project: string, familyPath: string, d: Date): Promise<void> {
  const cur = await restGet(project, familyPath);
  const f = cur?.fields?.pendingOwnerTransfer?.mapValue?.fields;
  if (!f) throw new Error('pendingOwnerTransfer がありません');
  const body = { fields: { pendingOwnerTransfer: { mapValue: { fields: { ...f, expiresAt: { timestampValue: d.toISOString() } } } } } };
  const r = await fetch(`${FS}/${project}/databases/(default)/documents/${familyPath}?updateMask.fieldPaths=pendingOwnerTransfer`, {
    method: 'PATCH', headers: H, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`REST PATCH ${familyPath}: ${r.status}`);
}
