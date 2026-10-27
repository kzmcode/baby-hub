# GAS 版バックエンド セットアップ

Firebase を **Spark プラン**で運用するため、Cloud Functions の機能を Google Apps Script（GAS）へ移植したもの。開発契約は [architecture.md](architecture.md)。Web は `fetch` で GAS Web アプリ（`doPost`）を呼び、Firestore は Rules 経由で直接読み書きする。

```
Web(PWA) ── Firestore（Rules）
   └ fetch POST ──> GAS Web アプリ ──> Firestore REST / FCM / Identity Toolkit / Drive
GAS 時間主導トリガー: dispatchNotifications（5分毎）, dailyBackup（毎時起動・1日1回実行）
```

## 前提

- **所有者の Google アカウント（本書では `<OWNER_EMAIL>` と表記。実際のメールアドレスに読み替える）**で Apps Script と Firebase を使う（スクリプト所有者＝実行ユーザー）。Web アプリは「実行ユーザー: 自分」で動くため、GAS は**所有者の権限**で Firestore を読み書きし（Rules を迂回）、Identity Toolkit の管理 API（アカウント削除）も呼ぶ。所有者アカウントはそのプロジェクトの Owner/Editor であること。所有者アカウントの漏えいは全データの漏えいになるため、2 段階認証を必ず有効にする。
- Node **22.23.4 以上の 22.x / 24.22.1 以上の 24.x / 26.12.1 以上の 26.x**（CVE-2026-111497 修正版）。リポジトリルートで `nvm install && nvm use` を実行する。各パッケージの `engines.node` と `.npmrc` で未修正版を拒否する。`cd gas && npm install`。devDependencies は脆弱性解消版（vitest 5 / esbuild 0.28 / clasp 3 / TypeScript 7 など）に更新済み。`npm audit` に残る 3 件（high, `braces` ← `micromatch` ← `@google/clasp`）は clasp の開発用依存で、修正版が存在せず本番バンドル（`dist/Code.js`）には含まれない。clasp 3 でも `login` / `create` / `push` / `deploy` は同じコマンド名で使える（実機のデプロイは未検証）。

## 1. clasp ログインとスクリプト作成

```bash
cd gas
npx clasp login          # ブラウザで <OWNER_EMAIL> を選ぶ
npx clasp login --status # ログイン中のアカウントを確認（別アカウントなら clasp logout してやり直し）
```

Apps Script API を有効化: https://script.google.com/home/usersettings で「Google Apps Script API」をオン。

```bash
npm run build
npx clasp create --type standalone --title "KosodateHub API" --rootDir dist
```

生成された `.clasp.json`（`scriptId` と `rootDir: dist`。`.clasp.json.example` 参照）はコミットしない。`clasp create` が `dist/appsscript.json` を上書きした場合は `npm run build` で戻す（スコープ・webapp 設定が必要）。

## 2. GCP プロジェクトの紐付け

標準ではスクリプトは専用の「デフォルト GCP プロジェクト」に属し、Firestore API 等を使えない。**Firebase プロジェクトの GCP プロジェクト**に切り替える。

1. Firebase Console → プロジェクトの設定 → 「プロジェクト番号」を控える。
2. Apps Script エディタ（`npx clasp open`）→ 「プロジェクトの設定」→ 「Google Cloud Platform (GCP) プロジェクト」→「プロジェクトを変更」→ プロジェクト番号を入力。
3. GCP コンソール（同プロジェクト）で **OAuth 同意画面** を設定: ユーザータイプ「外部」、テストモードのままなら**テストユーザーに `<OWNER_EMAIL>` を追加**（テストモードはリフレッシュトークンが 7 日で失効する場合があるため、運用は「本番環境に公開」（未確認アプリの警告は所有者のみなので許容）を推奨）。
4. API を有効化（GCP コンソール → API とサービス → ライブラリ）:
   - **Cloud Firestore API**（`firestore.googleapis.com`）
   - **Firebase Cloud Messaging API**（`fcm.googleapis.com`、FCM HTTP v1）
   - **Identity Toolkit API**（`identitytoolkit.googleapis.com`）
5. Firestore のデータベース（(default)）を作成済みであること。

## 3. スクリプトプロパティ

Apps Script エディタ → プロジェクトの設定 → スクリプト プロパティ:

| キー | 値 |
| --- | --- |
| `FIREBASE_PROJECT_ID` | Firebase のプロジェクト ID |
| `FIREBASE_WEB_API_KEY` | Firebase の Web API キー（Web アプリ設定の `apiKey`） |
| `BACKUP_FOLDER_ID` | 自動作成されるので設定不要 |

## 4. デプロイ

```bash
npm run push        # build && clasp push
```

1. エディタで「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」→ 実行ユーザー: **自分**、アクセスできるユーザー: **全員**。
2. 発行された URL（`https://script.google.com/macros/s/AKfy.../exec`）を `web/.env` の `VITE_GAS_ENDPOINT` に設定。
3. 初回は権限承認が必要。エディタで関数 `setupTriggers` を選んで「実行」→ 権限を確認・許可（「安全でないページ」→ 詳細 → 移動）。これで必要スコープが一括で承認される。Drive は最小権限の `drive.file`（スクリプトが作成したファイルのみ）で、REST API を使うため GCP プロジェクトで **Google Drive API の有効化**が必要（`appsscript.json` の oauthScopes を参照）。
4. `setupTriggers` を実行してトリガーを作成（既存トリガーは削除して作り直す）。実行後「トリガー」画面で `dispatchNotifications`（5分毎）と `dailyBackup`（1時間毎。実処理は JST 3 時以降に 1 日 1 回）を確認。
5. 動作確認: ブラウザで URL を開くと `{"ok":true}`。

### 更新時

`npm run push` の後、エディタの「デプロイを管理」→ 既存デプロイの鉛筆 → バージョン「新バージョン」→ デプロイ。**新規デプロイを作ると URL が変わる**ので、必ず既存デプロイを更新する（`/exec` の URL は固定される）。`clasp deploy` は新しいデプロイを作るため、URL 固定運用では使わない（`npm run deploy` は初回用）。

### トリガー・手動実行

エディタから手動実行できる関数: `setupTriggers`, `dispatchNotifications`, `dailyBackup`, `backupNow(kind)`, `backupFullNow`, `restoreBackup(targetProjectId, fullFileId, incrementalFileIdsCsv, confirm)`。詳細は [backup](backup/README.md) / [notify](notify/README.md)。

## OAuth スコープの変更と再承認（セキュリティ修正 S1）

`appsscript.json` の `oauthScopes` から `cloud-platform` と `userinfo.email`（未使用）を削除し、`https://www.googleapis.com/auth/identitytoolkit`（`accounts:delete` 用）を追加した。現在は `script.external_request` / `datastore` / `identitytoolkit` / `firebase.messaging` / `drive.file` / `script.scriptapp` のみ。**スコープが変わったので、デプロイ後に所有者がエディタで `setupTriggers` を手動実行して再承認し、デプロイも新バージョンにすること**（再承認しないと Web アプリ・トリガーが 401 になる）。Firestore / FCM / Drive / Identity Toolkit の REST 呼び出しには `x-goog-user-project`（`FIREBASE_PROJECT_ID`）を付与している（GCP 紐付けと各 API の有効化が前提）。

## API の回数制限（uid 単位）

超過時は `resource-exhausted` / `details: { reason: 'rate-limited', retryAfterSec }`。**strict**（厳密）な上限は `LockService.getScriptLock()` を `tryLock(2 秒)` で短時間だけ取って read-modify-write し、取得できなければ fail-closed（同じ `rate-limited`、`retryAfterSec: 3`）。それ以外は CacheService の固定窓カウンタ（原子的でなく同時実行では多少超過し得る）。6 時間を超える窓は **JST の暦日**窓で、スクリプトプロパティ `rld:{uid}`（uid ごとに 1 キー）に保持する（古いキーは通知ディスパッチが約 6 時間毎に掃除）。

| 対象 | 上限 | 方式 |
| --- | --- | --- |
| 全関数合計（署名・クレーム検証の直後、`accounts:lookup` の**前**に消費） | 60 回/分 | Cache |
| `exportFamilyData` | 3 回/時 | Cache |
| `sendTestNotification` | 1 回/分 | strict |
| `registerDevice` | 10 回/時 | Cache |
| `previewInvite` + `acceptInvite`（**失敗時のみ**カウント、共有。実行前に 1 回分を予約し、成功したら返却） | 10 回/時 | strict |
| `createDoseOccurrence` | 30 回/時 | Cache |
| `createFamily` | 5 回/日（JST） | strict |
| `deleteFamily` / `deleteAccount` | 各 5 回/時 | strict |
| `transferOwnership` / `acceptOwnershipTransfer` | 各 10 回/時 | strict |
| 書込み系合計（`updateEvent` `setEventStatus` `updateDoc` `deleteDoc` `createDoseOccurrence` `claimDose` `releaseDose` `completeDose` `skipDose` `notifyHandoverCreated` `syncScheduleReminder`） | 1,000 回/日（JST） | プロパティ |
| `deleteDoc` | 200 回/日 | プロパティ |
| `updateDoc` + `updateEvent`（合算） | 500 回/日 | プロパティ |
| `notifyHandoverCreated` / `syncScheduleReminder` | 各 200 回/日 | プロパティ |

ID トークンの RS256 署名は GAS 内で検証する（[core](core/README.md)）。署名不正のリクエストは UrlFetch を消費しない。署名が正しい正規トークンの連打は、全体バケット（60/分）と `accounts:lookup` 結果の 60 秒キャッシュ、日次 UrlFetch 予算で抑える。

## 日次 UrlFetch 予算

GAS の UrlFetch は 2 万回/日。リクエスト（doPost）の枠 **15,000 回/日** とトリガー（通知ディスパッチ・バックアップ）の枠 **5,000 回/日** を別カウンタ（スクリプトプロパティ `ub:req` / `ub:trigger`、値 `JST日付:回数`）で管理する。リクエストは `fetch` 回数を処理終了時に計上し、枠を使い切ると `unavailable` / `details.reason: 'daily-budget'` で拒否する（トリガー枠には影響しない）。トリガー側は超過を警告ログに出すのみで止めない。ロックを使わないため同時実行では少なめに数える。JST 0 時にリセット。

## 利用上限（無料の Gmail アカウント）

- URL Fetch: **2 万回/日**（Firestore REST・FCM・Identity Toolkit のすべてが 1 回ずつ数える）
- トリガーの合計実行時間: **90 分/日**、1 実行あたり **6 分**
- 1 リクエストの `doPost` も 6 分まで。ペイロード 64KB 制限（本実装）
- 5 分毎のディスパッチは実行時間の目安: 1 回 数秒 × 288 回/日。長引く場合は間隔を延ばす

## ローカル開発（エミュレータ + dev-server）

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21; export PATH=$JAVA_HOME/bin:$PATH
firebase emulators:start --only firestore,auth --project demo-kosodate-hub   # リポジトリルート
cd gas && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run dev   # http://127.0.0.1:8787
```

`web/.env.local` に `VITE_GAS_ENDPOINT=http://127.0.0.1:8787`（`localhost` でも可）。環境変数: `FIREBASE_PROJECT_ID`（既定 demo-kosodate-hub。**`demo-` で始まらないと起動拒否**）, `FIREBASE_WEB_API_KEY`（既定 fake-api-key）, `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST`（**両方必須**、無いと起動拒否）。`127.0.0.1` でのみ待ち受け。詳細は [core](core/README.md)。Drive は `gas/.local-drive/` に保存。FCM は無効（`FCM_ENABLED=1` で有効化）。

テスト: `npm test`（エミュレータ不要）、`npm run test:emu`（`firebase emulators:exec` で Firestore/Auth エミュレータ結合テスト。Java 21 が必要）、`npm run typecheck`。

## 機能別ドキュメント

- [core（共通基盤）](core/README.md)
- [family（家族・招待）](family/README.md)
- [documents（更新・削除）](documents/README.md)
- [medication（服薬）](medication/README.md)
- [account（エクスポート・削除）](account/README.md)
- [notify（通知）](notify/README.md)
- [backup（バックアップ）](backup/README.md)
