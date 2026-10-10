// Firestore REST v1 の同期クライアント（firebase-admin のサブセット）
import { ApiError, type ErrorCode } from '../errors';
import type { Platform } from '../platform/types';
import { Fields, Value, fromFields, toValue } from './codec';
import { Timestamp } from './timestamp';
import { Write, buildCreate, buildSet, buildUpdate, fieldPathOf } from './writes';

/** トランザクション競合（ABORTED）。runTransaction が再試行の対象にする */
class AbortedError extends ApiError {
  constructor() {
    super('aborted', 'Firestore transaction aborted');
  }
}

const STATUS_TO_CODE: Record<string, ErrorCode> = {
  NOT_FOUND: 'not-found',
  ALREADY_EXISTS: 'already-exists',
  ABORTED: 'aborted',
  FAILED_PRECONDITION: 'failed-precondition',
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  UNAVAILABLE: 'unavailable',
  DEADLINE_EXCEEDED: 'unavailable',
};

const MAX_TX_ATTEMPTS = 5;
const MAX_BATCH = 500;

type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains' | 'array-contains-any';
const OP_MAP: Record<WhereOp, string> = {
  '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL', in: 'IN', 'not-in': 'NOT_IN', 'array-contains': 'ARRAY_CONTAINS',
  'array-contains-any': 'ARRAY_CONTAINS_ANY',
};

function splitPath(path: string, kind: 'doc' | 'collection'): string[] {
  const segs = path.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new ApiError('invalid-argument', 'Invalid Firestore path');
  if ((kind === 'doc') !== (segs.length % 2 === 0)) throw new ApiError('invalid-argument', 'Invalid Firestore path');
  return segs;
}
const encPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export class DocumentSnapshot {
  constructor(
    readonly ref: DocumentReference,
    private readonly raw: { fields?: Fields; createTime?: string; updateTime?: string } | null,
  ) {}
  get id(): string { return this.ref.id; }
  get exists(): boolean { return this.raw !== null; }
  get createTime(): Timestamp | undefined { return this.raw?.createTime ? Timestamp.fromISO(this.raw.createTime) : undefined; }
  get updateTime(): Timestamp | undefined { return this.raw?.updateTime ? Timestamp.fromISO(this.raw.updateTime) : undefined; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data(): any | undefined {
    if (!this.raw) return undefined;
    const db = this.ref.firestore;
    return fromFields(this.raw.fields ?? {}, db.root, (p) => db.doc(p));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(field: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = this.data();
    for (const s of field.split('.')) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[s];
    }
    return cur;
  }
}

export class QuerySnapshot {
  constructor(readonly docs: DocumentSnapshot[]) {}
  get empty(): boolean { return this.docs.length === 0; }
  get size(): number { return this.docs.length; }
}

interface QState {
  filters: Value[];
  orders: { field: string; dir: 'ASCENDING' | 'DESCENDING' }[];
  limit?: number;
  startAfter?: Value[];
}

export class Query {
  constructor(readonly firestore: Firestore, readonly collectionPath: string, protected readonly state: QState = { filters: [], orders: [] }) {}

  protected derive(patch: Partial<QState>): Query {
    return new Query(this.firestore, this.collectionPath, { ...this.state, ...patch });
  }
  private fieldValue(field: string, v: unknown): Value {
    const db = this.firestore;
    if (field === '__name__' && typeof v === 'string') return { referenceValue: `${db.root}/${this.collectionPath}/${v}` };
    return toValue(v, db.root);
  }
  where(field: string, op: WhereOp, value: unknown): Query {
    const fieldRef = { fieldPath: field === '__name__' ? field : fieldPathOf(field.split('.')) };
    let filter: Value;
    if ((op === '==' || op === '!=') && value === null) {
      filter = { unaryFilter: { op: op === '==' ? 'IS_NULL' : 'IS_NOT_NULL', field: fieldRef } };
    } else if ((op === '==' || op === '!=') && typeof value === 'number' && Number.isNaN(value)) {
      filter = { unaryFilter: { op: op === '==' ? 'IS_NAN' : 'IS_NOT_NAN', field: fieldRef } };
    } else {
      const v = Array.isArray(value) && (op === 'in' || op === 'not-in' || op === 'array-contains-any')
        ? { arrayValue: { values: value.map((x) => this.fieldValue(field, x)) } }
        : this.fieldValue(field, value);
      filter = { fieldFilter: { field: fieldRef, op: OP_MAP[op], value: v } };
    }
    return this.derive({ filters: [...this.state.filters, filter] });
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): Query {
    const f = field === '__name__' ? field : fieldPathOf(field.split('.'));
    return this.derive({ orders: [...this.state.orders, { field: f, dir: dir === 'desc' ? 'DESCENDING' : 'ASCENDING' }] });
  }
  limit(n: number): Query {
    return this.derive({ limit: n });
  }
  /** 値は orderBy の並びに対応させること */
  startAfter(...values: unknown[]): Query {
    const names = this.state.orders.map((o) => o.field);
    return this.derive({ startAfter: values.map((v, i) => this.fieldValue(names[i] ?? '', v)) });
  }

  /** @internal */
  toStructured(): Value {
    const q: Value = { from: [{ collectionId: this.collectionPath.split('/').pop() }] };
    const f = this.state.filters;
    if (f.length === 1) q.where = f[0];
    else if (f.length > 1) q.where = { compositeFilter: { op: 'AND', filters: f } };
    if (this.state.orders.length) q.orderBy = this.state.orders.map((o) => ({ field: { fieldPath: o.field }, direction: o.dir }));
    if (this.state.limit !== undefined) q.limit = this.state.limit;
    if (this.state.startAfter) q.startAt = { values: this.state.startAfter, before: false };
    return q;
  }
  get(): QuerySnapshot {
    return this.firestore.runQuery(this, undefined);
  }
}

export class CollectionReference extends Query {
  constructor(firestore: Firestore, readonly path: string) {
    super(firestore, path);
  }
  get id(): string { return this.path.split('/').pop()!; }
  get parent(): DocumentReference | null {
    const i = this.path.lastIndexOf('/');
    return i < 0 ? null : this.firestore.doc(this.path.slice(0, i));
  }
  doc(id?: string): DocumentReference {
    return this.firestore.doc(`${this.path}/${id ?? this.firestore.autoId()}`);
  }
  add(data: object): DocumentReference {
    const ref = this.doc();
    ref.create(data);
    return ref;
  }
}

export class DocumentReference {
  readonly _isDocRef = true as const;
  constructor(readonly firestore: Firestore, readonly path: string) {}
  get id(): string { return this.path.split('/').pop()!; }
  get parent(): CollectionReference {
    return new CollectionReference(this.firestore, this.path.slice(0, this.path.lastIndexOf('/')));
  }
  collection(id: string): CollectionReference {
    return this.firestore.collection(`${this.path}/${id}`);
  }
  get(): DocumentSnapshot { return this.firestore.getDoc(this, undefined); }
  set(data: object, opts?: { merge?: boolean }): void {
    this.firestore.commit([buildSet(this.firestore.docName(this.path), data, !!opts?.merge, this.firestore.root)]);
  }
  update(data: object): void {
    this.firestore.commit([buildUpdate(this.firestore.docName(this.path), data, this.firestore.root)]);
  }
  create(data: object): void {
    this.firestore.commit([buildCreate(this.firestore.docName(this.path), data, this.firestore.root)]);
  }
  delete(): void {
    this.firestore.commit([{ delete: this.firestore.docName(this.path) }]);
  }
  toJSON(): string { return this.path; }
}

abstract class WriteCollector {
  protected writes: Write[] = [];
  constructor(readonly firestore: Firestore) {}
  protected add(w: Write): this {
    this.writes.push(w);
    return this;
  }
  set(ref: DocumentReference, data: object, opts?: { merge?: boolean }): this {
    return this.add(buildSet(this.firestore.docName(ref.path), data, !!opts?.merge, this.firestore.root));
  }
  update(ref: DocumentReference, data: object): this {
    return this.add(buildUpdate(this.firestore.docName(ref.path), data, this.firestore.root));
  }
  create(ref: DocumentReference, data: object): this {
    return this.add(buildCreate(this.firestore.docName(ref.path), data, this.firestore.root));
  }
  delete(ref: DocumentReference): this {
    return this.add({ delete: this.firestore.docName(ref.path) });
  }
}

export class WriteBatch extends WriteCollector {
  /** 500 件ごとに分割して commit する（件数が 500 を超える場合、全体のアトミック性はない） */
  commit(): void {
    for (let i = 0; i < this.writes.length; i += MAX_BATCH) this.firestore.commit(this.writes.slice(i, i + MAX_BATCH));
    this.writes = [];
  }
}

export class Transaction extends WriteCollector {
  constructor(firestore: Firestore, readonly id: string, readonly readOnly = false) {
    super(firestore);
  }
  protected override add(w: Write): this {
    if (this.readOnly) throw new Error('Cannot write in a read-only transaction');
    return super.add(w);
  }
  get hasWrites(): boolean { return this.writes.length > 0; }
  get pending(): Write[] { return this.writes; }
  private assertNoWrites(): void {
    if (this.writes.length) throw new Error('Firestore transactions require all reads to be executed before all writes');
  }
  get(ref: DocumentReference): DocumentSnapshot;
  get(q: Query): QuerySnapshot;
  get(x: DocumentReference | Query): DocumentSnapshot | QuerySnapshot {
    this.assertNoWrites();
    return x instanceof DocumentReference ? this.firestore.getDoc(x, this.id) : this.firestore.runQuery(x, this.id);
  }
  getAll(...refs: DocumentReference[]): DocumentSnapshot[] {
    this.assertNoWrites();
    return this.firestore.batchGet(refs, this.id);
  }
}

export class Firestore {
  readonly root: string;
  private readonly base: string;
  constructor(readonly platform: Platform) {
    const c = platform.config;
    this.root = `projects/${c.projectId}/databases/(default)/documents`;
    this.base = `${c.firestoreBaseUrl}/v1/${this.root}`;
  }

  // ---- 参照 ----
  doc(path: string): DocumentReference {
    splitPath(path, 'doc');
    return new DocumentReference(this, path);
  }
  collection(path: string): CollectionReference {
    splitPath(path, 'collection');
    return new CollectionReference(this, path);
  }
  batch(): WriteBatch { return new WriteBatch(this); }
  docName(path: string): string { return `${this.root}/${path}`; }
  autoId(): string { return this.platform.randomToken(20).slice(0, 20); }

  // ---- REST ----
  private call(method: 'GET' | 'POST', suffix: string, body?: unknown): unknown {
    const c = this.platform.config;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.platform.getAccessToken()}`, 'Content-Type': 'application/json' };
    if (!c.emulator) headers['x-goog-user-project'] = c.projectId;
    const res = this.platform.fetch(`${this.base}${suffix}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status >= 200 && res.status < 300) return res.body ? JSON.parse(res.body) : {};
    this.throwFor(res.status, res.body, `${method} ${suffix.replace(/[?:].*$/, '').split('/')[1] ?? ''}`);
  }

  private throwFor(status: number, bodyText: string, what: string): never {
    let st = '';
    try {
      const j = JSON.parse(bodyText);
      const e = (Array.isArray(j) ? j[0] : j)?.error;
      st = e?.status ?? '';
    } catch { /* 本文が JSON でない */ }
    if (!st) st = status === 404 ? 'NOT_FOUND' : status === 409 ? 'ABORTED' : status === 429 ? 'RESOURCE_EXHAUSTED' : status >= 500 ? 'UNAVAILABLE' : '';
    // 詳細（リソースパスやデータ値を含み得る）はログに出さない。ステータスコードのみ
    this.platform.log(status >= 500 || status === 401 || status === 403 ? 'error' : 'warn', 'firestore request failed', { status, fsStatus: st, op: what });
    if (st === 'ABORTED') throw new AbortedError();
    const code = STATUS_TO_CODE[st] ?? 'internal';
    throw new ApiError(code, code === 'internal' ? 'Firestore error' : `Firestore ${st}`);
  }

  private parseDoc(ref: DocumentReference, d: { fields?: Fields; createTime?: string; updateTime?: string } | null): DocumentSnapshot {
    return new DocumentSnapshot(ref, d);
  }

  /** @internal */
  getDoc(ref: DocumentReference, tx: string | undefined): DocumentSnapshot {
    // トランザクション内の読み取りは batchGet 経由（エミュレータは GET ?transaction= でハングするため）
    if (tx) return this.batchGet([ref], tx)[0]!;
    const q = '';
    const c = this.platform.config;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.platform.getAccessToken()}` };
    if (!c.emulator) headers['x-goog-user-project'] = c.projectId;
    const res = this.platform.fetch(`${this.base}/${encPath(ref.path)}${q}`, { method: 'GET', headers });
    if (res.status === 404) return this.parseDoc(ref, null);
    if (res.status >= 200 && res.status < 300) return this.parseDoc(ref, JSON.parse(res.body));
    this.throwFor(res.status, res.body, 'GET doc');
  }

  getAll(...refs: DocumentReference[]): DocumentSnapshot[] { return this.batchGet(refs, undefined); }

  /** @internal */
  batchGet(refs: DocumentReference[], tx: string | undefined): DocumentSnapshot[] {
    if (refs.length === 0) return [];
    const body: Record<string, unknown> = { documents: refs.map((r) => this.docName(r.path)) };
    if (tx) body.transaction = tx;
    const arr = this.call('POST', ':batchGet', body) as { found?: { name: string; fields?: Fields; createTime?: string; updateTime?: string } }[];
    const found = new Map<string, NonNullable<(typeof arr)[number]['found']>>();
    for (const x of arr) if (x.found) found.set(x.found.name, x.found);
    return refs.map((r) => this.parseDoc(r, found.get(this.docName(r.path)) ?? null));
  }

  /** @internal */
  runQuery(q: Query, tx: string | undefined): QuerySnapshot {
    const i = q.collectionPath.lastIndexOf('/');
    const parent = i < 0 ? '' : `/${encPath(q.collectionPath.slice(0, i))}`;
    const body: Record<string, unknown> = { structuredQuery: q.toStructured() };
    if (tx) body.transaction = tx;
    const arr = this.call('POST', `${parent}:runQuery`, body) as { document?: { name: string; fields?: Fields; createTime?: string; updateTime?: string } }[];
    const docs: DocumentSnapshot[] = [];
    for (const x of arr) {
      if (!x.document) continue;
      const path = x.document.name.slice(this.root.length + 1);
      docs.push(this.parseDoc(this.doc(path), x.document));
    }
    return new QuerySnapshot(docs);
  }

  /** @internal 単一 commit（アトミック） */
  commit(writes: Write[], tx?: string): void {
    if (writes.length === 0 && !tx) return;
    const body: Record<string, unknown> = { writes };
    if (tx) body.transaction = tx;
    this.call('POST', ':commit', body);
  }

  // ---- トランザクション ----
  /**
   * readOnly: true なら読み取り専用トランザクション（beginTransaction の options.readOnly。一貫したスナップショットで読み、
   * 書込みは不可。commit せず終了時に rollback して解放する）。
   */
  runTransaction<T>(fn: (tx: Transaction) => T, opts: { readOnly?: boolean } = {}): T {
    const readOnly = opts.readOnly === true;
    for (let attempt = 1; ; attempt++) {
      let id: string;
      try {
        id = (this.call('POST', ':beginTransaction', { options: readOnly ? { readOnly: {} } : { readWrite: {} } }) as { transaction: string }).transaction;
      } catch (e) {
        if (e instanceof AbortedError && attempt < MAX_TX_ATTEMPTS) continue;
        throw e instanceof AbortedError ? new ApiError('aborted', 'Transaction aborted') : e;
      }
      const tx = new Transaction(this, id, readOnly);
      let committing = false;
      try {
        const result = fn(tx);
        if (readOnly) {
          this.rollback(id);
          committing = true; // 解放済み
          return result;
        }
        committing = true;
        this.commit(tx.pending, id);
        return result;
      } catch (e) {
        if (!committing) this.rollback(id);
        if (e instanceof AbortedError) {
          if (attempt < MAX_TX_ATTEMPTS) continue;
          throw new ApiError('aborted', 'Transaction aborted');
        }
        throw e;
      }
    }
  }

  private rollback(id: string): void {
    try {
      this.call('POST', ':rollback', { transaction: id });
    } catch { /* 失敗は無視（タイムアウトで解放される） */ }
  }

  // ---- 一覧・削除 ----
  listCollections(docPath: string): CollectionReference[] {
    const out: CollectionReference[] = [];
    let token: string | undefined;
    const suffix = docPath === '' ? ':listCollectionIds' : `/${encPath(docPath)}:listCollectionIds`;
    do {
      const r = this.call('POST', suffix, { pageSize: 300, ...(token ? { pageToken: token } : {}) }) as { collectionIds?: string[]; nextPageToken?: string };
      for (const id of r.collectionIds ?? []) out.push(this.collection(docPath === '' ? id : `${docPath}/${id}`));
      token = r.nextPageToken;
    } while (token);
    return out;
  }

  private listDocPaths(collectionPath: string): string[] {
    const i = collectionPath.lastIndexOf('/');
    const parent = i < 0 ? '' : `/${encPath(collectionPath.slice(0, i))}`;
    const body = { structuredQuery: { from: [{ collectionId: collectionPath.slice(i + 1) }], select: { fields: [{ fieldPath: '__name__' }] } } };
    const arr = this.call('POST', `${parent}:runQuery`, body) as { document?: { name: string } }[];
    return arr.filter((x) => x.document).map((x) => x.document!.name.slice(this.root.length + 1));
  }

  recursiveDelete(ref: DocumentReference | CollectionReference): void {
    const deletes: string[] = [];
    const walkDoc = (path: string): void => {
      for (const c of this.listCollections(path)) walkColl(c.path);
      deletes.push(path); // 子を先に削除
    };
    const walkColl = (path: string): void => {
      for (const p of this.listDocPaths(path)) walkDoc(p);
    };
    if (ref instanceof DocumentReference) walkDoc(ref.path);
    else walkColl(ref.path);
    for (let i = 0; i < deletes.length; i += MAX_BATCH) {
      this.commit(deletes.slice(i, i + MAX_BATCH).map((p) => ({ delete: this.docName(p) })));
    }
  }
}

export function createFirestore(platform: Platform): Firestore {
  return new Firestore(platform);
}

