# core（共通基盤）

`gas/core/` は全機能が共有する基盤。契約は [../architecture.md](../architecture.md) 3章。

## 構成

| パス | 役割 |
| --- | --- |
| `platform/types.ts` | `Platform`（fetch・アクセストークン・設定・乱数・SHA-256・キャッシュ・ログ・Drive） |
| `platform/gas.ts` | GAS 実装（UrlFetchApp `muteHttpExceptions`、`ScriptApp.getOAuthToken`、CacheService、PropertiesService、Utilities）。Drive は `platform/drive-rest.ts`（Drive REST API v3 を UrlFetchApp + `ScriptApp.getOAuthToken` で呼ぶ。`DriveApp` は使わない） |
| `platform/node.ts` + `node-sync-fetch-helper.mjs` | Node 実装。同期 HTTP は `execFileSync` で helper（`fetch`）を子プロセス起動。キャッシュは Map、Drive は `gas/.local-drive/` |
| `firestore/` | Firestore REST v1 の同期クライアント（firebase-admin のサブセット） |
| `errors.ts` | `ApiError(code, message, details)` |
| `auth.ts` | ID トークン検証 |
| `guards.ts` | `requireMember` / `assertRecentAuth` / `writeAudit` / `getPlatform` / `getDb` |
| `context.ts` | `CallContext`・`Handler`・現在の Platform / Firestore |
| `dispatch.ts` / `router.ts` | リクエスト処理（ハンドラ表を注入可能）／各機能の `handlers` を統合 |
| `log.ts` | `logInfo/logWarn/logError` |
| `main.gas.ts` | GAS エントリ（`doPost`, `doGet`, `dispatchNotifications`, `dailyBackup`, `backupNow`, `restoreBackup`, `setupTriggers`） |
| `ratelimit.ts` | uid 単位の回数制限（Cache の固定窓、strict は ScriptLock、日次は JST 暦日窓をプロパティに保持） |
| `budget.ts` | 日次 UrlFetch 予算（リクエスト 15,000 / トリガー 5,000） |
| `dev-server.ts` | ローカル HTTP サーバー（127.0.0.1:8787、localhost 系 Origin のみ CORS 許可） |

ビルドは `build.mjs`（esbuild、IIFE `CH`、`dist/Code.js` に footer でトップレベル関数を付与）。**全処理は同期**（async 禁止）。

## 認証方式

Web は Firebase の ID トークンを本文 `{fn, data, idToken}` で送る（`Content-Type: text/plain` で CORS プリフライト回避）。`auth.ts`（本番 = `config.emulator === false`）:

1. JWT ペイロードを base64url デコードし `aud === projectId`、`iss === https://securetoken.google.com/{projectId}`、`exp > now`、`sub` を確認（不一致は `unauthenticated`）。
2. **RS256 署名を GAS 内で検証**する。ヘッダは `alg === 'RS256'` かつ `kid` 必須（`none` / HS256 などは拒否）。公開鍵は `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`（JWKS）を取得し、CacheService（空振り時はスクリプトプロパティ `jwks:v1` にも保存）へ `Cache-Control: max-age`（上限 6 時間）で保持。**未知の kid や期限切れによる再取得は 10 分に 1 回まで**（失敗した試行も数える。ランダム kid を送り付けて UrlFetch を枯渇させる DoS の防止）。検証は BigInt の modexp（RSA, e=65537 など）で復元した EM を、PKCS#1 v1.5 + SHA-256 の DigestInfo から組み立てた期待値と完全一致比較（SHA-256 は `shared/pure.ts` の純 JS 実装）。
3. **署名が正しい場合のみ**、`accounts:lookup` の**前**に uid（検証済み `sub`）単位の全体バケット（60/分）と日次 UrlFetch 予算を確認する（`verifyIdToken` の `beforeLookup` フック。正規トークンの連打で UrlFetch を枯渇させる攻撃の防止）。その後 `POST {identity}/v1/accounts:lookup?key={webApiKey}` に管理者 OAuth と `{localId:[uid], targetProjectId}` を送り、`localId === sub`、無効化されていないこと、`auth_time >= validSince` を確認する。**正の結果だけ** `uid + auth_time` をキーに 60 秒キャッシュする（CacheService `lk:{uid}:{authTime}`）。このため **アカウント無効化・トークン失効の反映は最大 60 秒遅れる**。`deleteAccount` 成功時は uid 単位の墓標（`lkdel:{uid}`、120 秒）でそのキャッシュを破棄する。エミュレータの `DISABLE_RATE_LIMIT=1`（テスト専用）ではキャッシュしない。400系は `unauthenticated`、5xx・429は `unavailable`。所有者には対象プロジェクトの `firebaseauth.users.get` 権限が必要。参考: [Identity Platform accounts.lookup](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/lookup)、[Firebase セッション失効](https://firebase.google.com/docs/auth/admin/manage-sessions)。
4. **未知の kid**: 再取得枠（10 分に 1 回）を使い切った状態で未知の kid が来たら `unavailable`（`details.reason: 'keys-refreshing'`）を返す。鍵ローテーション直後の正規トークンをログアウトさせず、クライアントが再試行できる。再取得した結果にも kid が無ければ `unauthenticated`。

エミュレータ（Node, `config.emulator === true`）のトークンは無署名なので署名検証は省略する。**本番 GAS（`platform/gas.ts`）は `emulator: false` 固定**。

## 回数制限（`ratelimit.ts`）と予算（`budget.ts`）

`dispatch` が uid 単位で適用する。上限の一覧と方式は [../README.md](../README.md) の表。全体バケットは署名・クレーム検証の直後・`accounts:lookup` の前に消費する。関数別の上限は認証完了後に消費する。`previewInvite` / `acceptInvite` は実行前に失敗枠を 1 回分予約し（strict）、成功したら返却する（招待トークンの総当たり対策。並列でも上限を超えない）。strict な上限は `getScriptLock` を `tryLock(2 秒)` で取り、カウンタの read-modify-write の間だけ保持する（ハンドラ実行中は保持しない）。取得失敗は `resource-exhausted`（`rate-limited`, `retryAfterSec: 3`）で fail-closed。6 時間を超える窓（日次）は JST 暦日で、プロパティ `rld:{uid}` に `{d: 日付, b: {bucket: 回数}}` を保持する。Platform は `tryScriptLock` / `propKeys` / `propRemove` / `cacheRemove` / `fetchCount`（任意）を持つ。エミュレータ限定で `DISABLE_RATE_LIMIT=1`（Node 環境変数）を指定すると回数制限・予算・lookup キャッシュを無効化できる（e2e 用。本番 GAS には無い）。

日次 UrlFetch 予算（リクエスト 15,000/日・トリガー 5,000/日）の仕組みは [../README.md](../README.md) を参照。`dispatch` は処理終了時にその実行で行った `fetch` 回数を計上し、`main.gas.ts` のトリガーは `metered()` で別枠に計上する。

`assertRecentAuth` は ID トークンの `auth_time` を使う（`failed-precondition`, `details.reason='recent-auth-required'`）。

## Firestore REST

- URL: `{firestoreBaseUrl}/v1/projects/{id}/databases/(default)/documents/...`。ヘッダ `Authorization: Bearer <ScriptApp.getOAuthToken()>`、本番は `x-goog-user-project`。所有者の OAuth トークンなので **Rules を迂回**する。
- 書込みは `:commit`。`FieldValue.serverTimestamp/increment/arrayUnion/arrayRemove` は `updateTransforms`、`delete()` は `updateMask` に入り値なし。`update()` のキーはドット区切り（値がマップならそのフィールドを置換）。`create` は `exists=false`、`update` は `exists=true` の precondition。
- `runTransaction(fn, { readOnly: true })`: 読み取り専用トランザクション（`beginTransaction` の `options.readOnly`。書込みは例外、終了時は commit せず rollback）。`exportFamilyData` が使う。
- `runTransaction`: `beginTransaction` → 読取（`batchGet`/`runQuery` に transaction を付与）→ `commit`。ABORTED は最大 5 回再試行（コールバックが再実行される。**副作用を持たせない**）。ユーザー例外はロールバックして再スロー。読取は書込みより前。
- `batch()`/`recursiveDelete` は 500 件ごとに commit。500 件を超えるとバッチ全体のアトミック性はない。`recursiveDelete` は `listCollectionIds` で子コレクションを辿る。
- クエリ: 単一フィールドの組み合わせ（複合インデックスが必要な組は `firestore.indexes.json`）。`collectionGroup` と `offset` は未対応。`startAfter` の値は `orderBy` の並びに対応させる。戻り件数に上限は無いので必ず `limit` を付ける。
- 型: Timestamp は `Timestamp` クラス。比較は `a.toMillis() < b.toMillis()`（`a < b` も `valueOf` により動くが `toMillis` 推奨）。`JSON.stringify` で ISO 文字列になる。整数値は `integerValue`、小数は `doubleValue`（JS では区別されない）。DocumentReference は `referenceValue`。

## dev-server の安全策

- `127.0.0.1` でのみ待ち受ける。
- 起動条件: `FIREBASE_PROJECT_ID`（未指定は `demo-baby-hub`）が `demo-` で始まり、`FIRESTORE_EMULATOR_HOST` と `FIREBASE_AUTH_EMULATOR_HOST` の両方が設定されていること。満たさないと例外で起動を拒否する（本番プロジェクトへの誤接続防止）。
- `POST /__test/*`（`runDispatch` / `runBackupNow` / `listBackups` / `runRestore`）は **`NODE_ENV=test` かつ `ENABLE_TEST_ENDPOINTS=1`** のときだけ有効。`e2e/scripts/with-dev-server.sh` は `NODE_ENV=test` のみ設定しているため、**`ENABLE_TEST_ENDPOINTS=1` の追加が必要（e2e 担当 S4 が対応）**。e2e は回数制限に当たらないよう `DISABLE_RATE_LIMIT=1` も指定してよい。
- CORS: `Origin` が `http://localhost:*` / `http://127.0.0.1:*` のときだけ `Access-Control-Allow-Origin` にその Origin を反映（それ以外は ACAO なし）。
- `dist/Code.js`（本番 GAS）には dev-server・`/__test` は含まれない。

## ロック

回数制限の strict な上限だけが `getScriptLock` を短時間（≤2 秒）使う。`main.gas.ts` の時間主導実行は `getScriptLock` を共有せず、CacheService のキー＋短期 TTL（7 分）のソフトロックを名前ごとに使う。通知ディスパッチとバックアップは互いをブロックしない（`dailyBackup` と `backupNow` は同じロック名）。

## ログ方針

`platform.log` には **ID・種別・件数のみ**（子どもの名前、自由文、薬名、トークンは出さない）。予期しない例外は Web へ `internal`（`Internal error (<errorId>)`）とだけ返し、ログに `errorId` と例外名のみを残す。Firestore の失敗は HTTP ステータスと REST の `status` 文字列のみ（403 でもメッセージ＝リソースパスを含み得る文言は出さない）。GAS では「実行数」画面または Cloud Logging で確認。

## トラブルシュート

| 症状 | 原因・対処 |
| --- | --- |
| Firestore 403 `PERMISSION_DENIED` / "API has not been used" / `x-goog-user-project` | スクリプトの GCP プロジェクトが Firebase のプロジェクトではない、または Cloud Firestore API 未有効。README の「GCP プロジェクトの紐付け」を実施。所有者が当該プロジェクトの Owner/Editor か確認 |
| 401 / `insufficient authentication scopes` | `appsscript.json` の `oauthScopes` にスコープが無い、または追加後に再承認していない。`npm run build && clasp push` 後、エディタで任意の関数（`setupTriggers`）を手動実行して再承認。デプロイも新バージョンにする |
| 認証が常に `unauthenticated` | `FIREBASE_WEB_API_KEY` / `FIREBASE_PROJECT_ID` の誤り、Identity Toolkit API 未有効、端末時計のずれ（`exp`）|
| Web から `CORS` エラー・`Failed to fetch` | `Content-Type: text/plain;charset=utf-8` で送っているか。デプロイのアクセスが「全員」か（ログインを要求されると HTML が返る）。URL が `/exec` か（`/dev` は所有者のみ）。リダイレクト先でエラーになる場合は URL 末尾を確認 |
| 変更が反映されない | 「デプロイを管理」で新バージョンにしていない（`/exec` は固定バージョンを実行） |
| トリガーが動かない / 権限エラー | `setupTriggers` を所有者が実行して承認済みか。トリガーは作成者権限で動く。承認が切れた（テストモード 7 日失効）場合は再承認。`script.scriptapp` スコープが必要 |
| `Service invoked too many times: URL Fetch` | 2 万回/日の上限。トリガー間隔を延ばす／家族数・通知数を確認 |
| `Exceeded maximum execution time` | 1 実行 6 分の上限。ディスパッチ・バックアップは分割実行（各 README 参照） |
| Drive 関連の 403 / スコープエラー | Drive は REST API v3 を `drive.file` スコープで呼ぶ（`DriveApp` は全ドライブ権限が要るため不使用）。スクリプトに紐付けた GCP プロジェクトで **Google Drive API を有効化**し、`appsscript.json` に `drive.file` があること、`setupTriggers` 等で再承認済みであることを確認 |
