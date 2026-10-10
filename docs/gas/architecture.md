# GAS 移植アーキテクチャ（開発契約）

Firebase を **Spark プラン**で運用するため、Cloud Functions（`functions/`）の機能を Google Apps Script（`gas/`）へ移植する。`docs/architecture.md` の **6章の関数名・入出力・エラーコード・details** は維持する（Web 側の画面コードは変更不要にする）。`functions/` は参照用に残し、デプロイ対象から外す。

## 1. 全体構成

```
Web(PWA) ──Firestore直接（Rules）──> Firestore
   │ fetch POST (text/plain JSON: {fn, data, idToken})
   ▼
GAS Webアプリ doPost（実行ユーザー=スクリプト所有者 <OWNER_EMAIL>、アクセス=全員）
   ├ ID トークン検証: Identity Toolkit accounts:lookup
   ├ Firestore REST API（所有者の OAuth トークン。Rules を迂回＝Admin 相当）
   ├ FCM HTTP v1（所有者の OAuth トークン）
   └ Drive（バックアップ）
GAS 時間主導トリガー: dispatchNotifications（5分毎）, dailyBackup（毎日 3時台 JST）
```

- **同期実行**: GAS は `doPost` が値を同期で返す必要があるため、コア処理はすべて**同期関数**で書く（`async/await` 禁止）。HTTP はプラットフォーム抽象 `Platform.http.fetch` 経由。
- **Node でも動く**: 同じコアを Node 上で動かす `core/platform/node.ts`（同期 HTTP は `child_process.execFileSync(process.execPath, [helper])` で実装）と、ローカル開発サーバー `core/dev-server.ts`（`http://localhost:8787`、Auth/Firestore エミュレータに接続）を用意する。これでエミュレータ上の e2e テストとローカル Web 開発が可能。
- **通知は即時**: Firestore トリガーが無いため、Web は申し送り・予定を作成した直後に `notifyHandoverCreated` / `syncScheduleReminder` を呼ぶ（ベストエフォート）。静穏時間外なら GAS がその場で FCM 送信。5分毎のトリガーは「延期ジョブの送信」と「呼び出し漏れの補完（スイープ）」を行う。予定の更新・削除は `updateDoc`/`deleteDoc` 内で同じ処理を呼ぶ。

## 2. ディレクトリと担当（機能ごとのフォルダ）

コードは `gas/<機能>/`、設定手順は `docs/gas/<機能>/README.md` に置く。各機能フォルダの `index.ts` が `export const handlers: Record<string, Handler>` を出し、`core/router.ts` が統合する。

```
gas/package.json, tsconfig.json, build.mjs, appsscript.json, .clasp.json.example, vitest.config.ts  ← G1
gas/core/        platform（types/gas/node/同期fetchヘルパ）, firestore（Admin風同期クライアント・codec）,
                 errors, auth, guards, context, router, log, main.gas.ts（GASエントリ）, dev-server.ts  ← G1
gas/shared/      types.ts（配置済み）, validate.ts, pure.ts（functions/src から移植）               ← G2
gas/family/      createFamily, createInvite, revokeInvite, previewInvite, acceptInvite, leaveFamily, transferOwnership, removeMember ← G2
gas/documents/   updateEvent, setEventStatus, updateDoc, deleteDoc                                    ← G2
gas/medication/  createDoseOccurrence, claimDose, releaseDose, completeDose, skipDose                  ← G2
gas/account/     exportFamilyData, deleteFamily, deleteAccount                                        ← G2
gas/notify/      registerDevice, sendTestNotification, notifyHandoverCreated, syncScheduleReminder, dispatchNotifications, スイープ, FCM, 静穏時間 ← G3
gas/backup/      dailyBackup, restoreBackup, 世代管理                                                  ← G3
docs/gas/README.md（全体のセットアップ・デプロイ手順と各機能へのリンク）, docs/gas/core/README.md   ← G1
docs/gas/{family,documents,medication,account}/README.md                                            ← G2
docs/gas/{notify,backup}/README.md                                                                  ← G3
web/**, firebase.json, firestore.indexes.json, firestore.rules                                      ← W
e2e/**                                                                                              ← 後続の E
```

各機能の README には「その機能が提供する関数・入出力」「必要なスクリプトプロパティ／OAuth スコープ／トリガー／Firebase Console 設定」「動作確認方法」「制約・注意」を書く。テストは各機能フォルダ内に `*.test.ts`（vitest）。

## 3. G1 が提供する共通インターフェース（G2/G3 はこれに従って書く）

```ts
// core/errors.ts
export type ErrorCode = 'unauthenticated'|'permission-denied'|'invalid-argument'|'not-found'
  |'failed-precondition'|'aborted'|'already-exists'|'resource-exhausted'|'internal'|'unavailable';
export class ApiError extends Error { constructor(code: ErrorCode, message: string, details?: unknown) }
// functions の HttpsError(code, msg, details) を ApiError(code, msg, details) に置換するだけで移植できる

// firestore/index.ts — firebase-admin のサブセットを同期 API で
export const FieldValue: { serverTimestamp(); delete(); increment(n: number); arrayUnion(...v); arrayRemove(...v) };
export class Timestamp { seconds; nanoseconds; static now(); static fromDate(d); static fromMillis(ms); toDate(); toMillis(); isEqual(t) }
export interface Firestore {
  doc(path: string): DocumentReference;
  collection(path: string): CollectionReference;
  runTransaction<T>(fn: (tx: Transaction) => T): T;      // 競合時は最大5回リトライ（REST beginTransaction/commit）
  batch(): WriteBatch;                                    // set/update/delete/create, commit()（500件超は分割）
  recursiveDelete(ref: DocumentReference | CollectionReference): void;  // listCollectionIds で再帰
  listCollections(docPath: string): CollectionReference[];
}
DocumentReference { id; path; parent: CollectionReference; collection(id); get(): DocumentSnapshot; set(data, opts?: {merge?: boolean}); update(data); create(data); delete() }
CollectionReference { id; path; doc(id?: string); add(data): DocumentReference; where(field, op, value): Query; orderBy(field, dir?): Query; limit(n): Query; get(): QuerySnapshot }
Query { where; orderBy; limit; startAfter(...values); get(): QuerySnapshot }   // op: == != < <= > >= in not-in array-contains array-contains-any
DocumentSnapshot { id; ref; exists: boolean; data(): any | undefined; get(field: string): any; createTime?: Timestamp; updateTime?: Timestamp }
QuerySnapshot { docs: DocumentSnapshot[]; empty: boolean; size: number }
Transaction { get(refOrQuery): DocumentSnapshot | QuerySnapshot; set; update; create; delete }   // 読みは書きより前
// update(data) のキーはドット区切りでネスト更新（admin と同じ）。値の undefined は無視、FieldValue.delete() で削除。

// platform/types.ts
export interface Platform {
  fetch(url: string, init: { method: 'GET'|'POST'|'PATCH'|'DELETE'; headers?: Record<string,string>; body?: string }): { status: number; body: string };
  getAccessToken(): string;                       // GAS: ScriptApp.getOAuthToken() / Node: 'owner'（エミュレータ）
  config: { projectId: string; webApiKey: string; firestoreBaseUrl: string; identityBaseUrl: string; fcmEnabled: boolean; emulator: boolean };
  randomToken(bytes: number): string;             // base64url。GAS は Utilities.getUuid() を複数連結→SHA-256 等で 256bit 以上
  sha256Hex(s: string): string;
  cacheGet(key: string): string | null; cachePut(key: string, value: string, ttlSec: number): void;
  log(level: 'info'|'warn'|'error', msg: string, fields?: Record<string, string|number|boolean>): void;  // ID・種別のみ
  drive?: DriveAdapter;                            // バックアップ用（GAS のみ。Node はローカルディレクトリ実装）
}
export interface DriveAdapter { ensureFolder(name: string): string; writeJson(folderId: string, name: string, json: string): string; listFiles(folderId: string): { id: string; name: string; createdAt: Date }[]; readJson(fileId: string): string; trash(fileId: string): void }

// core/context.ts
export interface CallContext { uid: string; authTime: number /* epoch sec */; email?: string; signInProvider?: string; platform: Platform; db: Firestore; now(): Date }
export type Handler = (ctx: CallContext, data: any) => unknown;

// core/guards.ts（functions/src/common.ts 相当）
requireMember(ctx, familyId: string, roles?: Role[]): { member: Member; family: Family }   // members/{uid}.status==='active'
assertRecentAuth(ctx, maxAgeSec = 300): void   // failed-precondition, details.reason='recent-auth-required'
writeAudit(db | tx, familyId, entry: { action: string; actorUid: string; target?: { kind: string; id: string } }): void
getPlatform(): Platform; getDb(): Firestore      // トリガー（ctx なし）用

// core/router.ts
// family/documents/medication/account/notify の各 index.ts の `handlers` を統合して dispatch
handleRequest(platform, rawBody: string): string    // 戻り値は JSON 文字列 {ok:true,result} | {ok:false,error:{code,message,details}}
```

- **ID トークン検証（core/auth.ts）**: 本番はRS256署名・aud/iss/exp/subを検証し、JWKSのみキャッシュする。管理者OAuthで `accounts:lookup` を毎回実行し、無効化と `auth_time < validSince` の失効を確認する。uidの認可結果はキャッシュしない。詳細は [core/README.md](core/README.md)。
- **Firestore REST**: `{firestoreBaseUrl}/v1/projects/{projectId}/databases/(default)/documents/...`。ヘッダ `Authorization: Bearer {token}`、本番は `x-goog-user-project: {projectId}` も付ける。エミュレータは `http://127.0.0.1:8080`、`Authorization: Bearer owner`。
- **応答**: GAS は HTTP ステータスを設定できないため常に 200 + JSON。Web は `ok` で判定。
- **リクエスト**: `Content-Type: text/plain;charset=utf-8`（CORS プリフライト回避）、本文 `{"fn":"createInvite","data":{...},"idToken":"..."}`。`fn` が未登録なら `not-found`。本文 64KB 超は拒否。
- **GAS 設定**: スクリプトプロパティ `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`, `BACKUP_FOLDER_ID`（自動作成）。`appsscript.json` の oauthScopes: `script.external_request`, `datastore`, `identitytoolkit`, `firebase.messaging`, `drive.file`, `script.scriptapp`（S1 で `cloud-platform` / `userinfo.email` を削除。変更後は再承認が必要）。webapp: `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`。runtimeVersion V8, timeZone Asia/Tokyo。
- **ビルド**: esbuild で `core/main.gas.ts` を IIFE（globalName `CH`）にバンドルし `dist/Code.js`、末尾に GAS が認識するトップレベル関数 `function doPost(e){return CH.doPost(e)}` `function doGet(e){...}`（ヘルスチェック）`function dispatchNotifications(){...}` `function dailyBackup(){...}` `function setupTriggers(){...}` `function restoreBackup(...){...}` を footer で付与。`appsscript.json` を dist にコピー。`npx clasp push`（rootDir=dist）。

## 4. 追加の関数（G3 実装、Web から呼ぶ）

| 名前 | 入力 | 出力 | 概要 |
| --- | --- | --- | --- |
| `notifyHandoverCreated` | `{ familyId, handoverId }` | `{ queued: number, sent: number }` | メンバー検査、handover.createdBy===呼出者。recipientUids（空なら作成者以外の active 全員）宛のジョブを決定的ID（`handover_{handoverId}_r{revision}_{uid}`）で作成（既存ならスキップ＝冪等）。静穏時間外かつ通知設定 ON ならその場で送信、それ以外は延期または skipped |
| `syncScheduleReminder` | `{ familyId, scheduleId }` | `{ action: 'created'\|'updated'\|'cancelled'\|'none' }` | functions の onScheduleWritten と同等（開始60分前ジョブの作成／更新／取消）。`updateDoc`(kind schedule) と `deleteDoc`(schedule) からも内部で呼ぶ（G2 は `gas/notify/index.ts` の `syncScheduleReminderInternal(db, familyId, scheduleId)` と `cancelScheduleReminderInternal(db, familyId, scheduleId)` を import して呼ぶ） |

- `dispatchNotifications`（5分毎トリガー）: (1) dueAt ≤ now の pending ジョブを最大100件送信（functions の dispatch と同じ規則: 設定・静穏時間・attempts≤3・無効トークン削除・定型文言）。(2) スイープ: 全 active family について、過去24時間に作成された open な handovers のジョブ欠落を補完、今後3時間以内に開始する planned schedules のリマインダ欠落を補完。家族数は少ない前提で collectionGroup は使わない。
- `sendTestNotification`, `registerDevice` も G3 が `gas/notify` の handlers として実装（functions/src/account.ts から移動）。

## 5. バックアップ（G3）

- Drive フォルダ `BabyHub-Backup`（ID はスクリプトプロパティに保存）。
- **日曜はフル、他の日は差分**（Spark の読取上限 5万件/日 対策）。差分は各コレクションで `updatedAt > 前回バックアップ時刻`（自動の単一フィールドインデックスで足りる）。users/{uid}・familyRefs・devices も含める（devices の fcmToken は除外）。削除は auditLogs で追跡される旨をメタに記録。
- 形式: `{ kind: 'full'|'incremental', projectId, startedAt, since?, docs: [{ path, data }] }`、Timestamp は `{ "__ts": ISO }`。ファイル名 `chub-{full|inc}-{yyyyMMdd-HHmm}.json`。
- 保持: 差分 14 日、フル 4 世代。読取件数を log（件数のみ）。
- `restoreBackup(targetProjectId, fullFileId, incrementalFileIdsCsv)`: 本番と同じ projectId への復元は `confirm` 引数が `'OVERWRITE_PRODUCTION'` でない限り拒否。バッチ書込み。手動実行用。

## 6. Web 側の変更（W）

- `web/src/lib/api.ts`: `httpsCallable` → `fetch(import.meta.env.VITE_GAS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn, data, idToken: await auth.currentUser.getIdToken() }) })`。`ok:false` は既存の `ApiError` に変換（code/details 互換）。ネットワーク失敗は `unavailable`。`recent-auth-required` 系の再認証後は `getIdToken(true)`。`notifyHandoverCreated`, `syncScheduleReminder` を追加。
- 呼び出し追加: 申し送り作成後（features/plans）に `notifyHandoverCreated`、予定作成後（features/plans、features/health の「予定にも追加」）に `syncScheduleReminder`。失敗は握りつぶす（オフライン可、スイープで補完）。
- `web/src/lib/firebase.ts`: `firebase/functions` を除去。`.env.example` に `VITE_GAS_ENDPOINT`（開発: `http://localhost:8787`）。
- `firebase.json`: functions セクションと functions エミュレータを削除。

## 7. セキュリティ修正 S1 で追加した共通の取り決め（Web・e2e も前提とする）

- **回数制限**: 超過は `ApiError('resource-exhausted', msg, { reason: 'rate-limited', retryAfterSec })`。uid 単位で全関数合計 60/分ほか（[README.md](README.md) の表）。
- **管理者移譲は 2 段階**: `transferOwnership({familyId,toUid})`（owner・再認証必須）→ `{ pending: true, expiresAt }`、`acceptOwnershipTransfer({familyId})`（宛先本人・再認証必須）→ `{ ok: true }`（reason: `no-pending-transfer` / `transfer-expired`）、`cancelOwnershipTransfer({familyId})`（owner または宛先）→ `{ ok: true }`。`Family.pendingOwnerTransfer?: { toUid, proposedBy, proposedAt, expiresAt } | null`。通知ジョブ type `ownerTransfer`（定型文「管理者の移譲が提案されています」、url `/more/family`）。
- **dev-server**: `127.0.0.1` のみ、`demo-` プロジェクト＋エミュレータ環境変数が無いと起動拒否、`/__test/*` は `NODE_ENV=test && ENABLE_TEST_ENDPOINTS=1`、CORS は localhost 系 Origin のみ。
- **registerDevice**: `platform` は `ios|android|desktop|other`、端末は 1 uid 10 台まで、同一 `fcmToken` は重複排除。
