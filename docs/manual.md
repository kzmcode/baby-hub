# Baby hub 手作業セットアップ・運用マニュアル

生成されたコードを受け取った開発者本人が、手作業で調整・セットアップ・デプロイするための手順書です。コマンドは macOS (zsh) 前提で、リポジトリ直下 `/Users/kazuma/Documents/dev/baby-hub` で実行します。

> **Blaze 版から GAS 版への切替経緯**: 当初は Cloud Functions（Blaze 従量課金必須）でバックエンドを実装しましたが、課金を避けるため Firebase を **Spark（無料）プラン**のまま運用する構成に変更し、Functions の機能を **Google Apps Script（GAS, `gas/`）** へ移植しました。`functions/` は参考用に残してありますが**デプロイしません**。将来 Blaze に戻す場合は `functions/` を使えます（その際は Web の `web/src/lib/api.ts` を `httpsCallable` 方式に戻し、`firebase.json` に functions を復元する必要があります。`docs/architecture.md` を参照）。

**使用アカウント**: GitHub・Firebase・Apps Script・Google ドライブは**すべて同じ所有者の Google アカウント（本書では `<OWNER_EMAIL>` と表記。実際のメールアドレスに読み替えてください）**を使います（clasp のログインも同じアカウント。GAS は所有者の権限で動き、バックアップは所有者のドライブに保存されます）。

**現在の状態（前提）**
- ローカルで `git init` 済み・未コミット
- Firebase プロジェクト `baby-hub-kzm` を作成済み（単一プロジェクト構成。dev/prod の分離はしていない）
- `web/.env` 未作成、GAS 未デプロイ
- 型チェック・単体テスト・Rules テスト・GAS のエミュレータ結合テストは通過。**実 GAS 環境・実機・画面での動作は未確認**

---

## 1. 概要と構成

夫婦で育児の記録・予定・健康情報を共有する PWA。Firestore を原本とし、通常の読み書きは Web から Firestore へ直接（Rules で保護）。更新・削除、招待、薬の担当取得、通知、バックアップなどは GAS Web アプリ経由。

```
Web(PWA) ── Firestore（Rules、直接読み書き）
   └ fetch POST ──> GAS Web アプリ(doPost) ──> Firestore REST / FCM / Identity Toolkit / Drive
GAS 時間主導トリガー: dispatchNotifications（5分毎）, dailyBackup（毎時起動・1日1回実行）
```

詳細設計は [docs/gas/architecture.md](gas/architecture.md)、GAS の手順は [docs/gas/README.md](gas/README.md)。

### 技術スタック
| 層 | 採用 |
| --- | --- |
| Web | TypeScript, React 18, Vite, react-router-dom v6, vite-plugin-pwa, firebase v11 |
| バックエンド | Google Apps Script（`gas/`, V8, TypeScript を esbuild でバンドルし clasp で push） |
| DB | Firestore `(default)` / `asia-northeast1`（Spark） |
| 認証 | Firebase Authentication（Google, メール/パスワード） |
| 通知 | FCM (Web Push)。GAS が即時送信＋5分毎トリガーで延期分・取りこぼしを補完 |
| バックアップ | GAS → `<OWNER_EMAIL>` の Google ドライブ（JSON） |
| ホスティング | Firebase Hosting（`web/dist`） |

### 料金と上限（すべて無料枠で運用）
Spark プランでは課金は発生せず、上限を超えると該当操作が失敗するだけです（請求なし。Blaze 用の予算アラートは不要）。

| 区分 | 上限（目安） |
| --- | --- |
| Firestore（Spark） | 読取 5 万/日、書込 2 万/日、削除 2 万/日、保存 1 GiB |
| Hosting（Spark） | 保存 10 GB、転送 10 GB/月 |
| GAS（無料 Gmail） | URL Fetch 2 万回/日、トリガー合計実行 90 分/日、1 実行 6 分、`doPost` も 6 分 |

### ディレクトリ
```
firebase.json / .firebaserc          Firebase 設定（hosting / firestore / emulators: auth, firestore）
firestore.rules / firestore.indexes.json   Rules とインデックス
rules-tests/                         Rules テスト（エミュレータ上で vitest）
gas/                                 GAS バックエンド（core, family, documents, medication, account, notify, backup）
functions/                           旧 Cloud Functions（参考用・デプロイしない）
web/                                 React アプリ
  .env.example                       環境変数の雛形
  vite.config.ts                     PWA(manifest/workbox) 設定
  public/firebase-messaging-sw.js    FCM 背景通知用 Service Worker
  src/lib/api.ts                     GAS 呼び出し（fetch）
  src/lib/firebase.ts                Firebase 初期化・エミュレータ接続・信頼端末キャッシュ
  src/features/{records,plans,health,account}/   機能別画面
e2e/                                 結合スモークテスト
docs/architecture.md                 実装契約（データモデル・API 仕様）
docs/gas/                            GAS 版の設計・セットアップ・機能別 README
docs/web-foundation.md               Web 基盤の説明
requirements.md                      要件定義
```

### GAS が提供する関数
- 家族: `createFamily, createInvite, revokeInvite, previewInvite, acceptInvite, leaveFamily, transferOwnership, removeMember`
- 更新: `updateEvent, setEventStatus, updateDoc, deleteDoc`
- 薬: `createDoseOccurrence, claimDose, releaseDose, completeDose, skipDose`
- アカウント: `exportFamilyData, deleteFamily, deleteAccount`
- 通知: `registerDevice, sendTestNotification, notifyHandoverCreated, syncScheduleReminder`（Web から即時呼出し）、`dispatchNotifications`（5分毎トリガー）
- バックアップ: `dailyBackup`（トリガー）、`restoreBackup`（手動）

機能別の詳細は [core](gas/core/README.md) / [family](gas/family/README.md) / [documents](gas/documents/README.md) / [medication](gas/medication/README.md) / [account](gas/account/README.md) / [notify](gas/notify/README.md) / [backup](gas/backup/README.md)。

### 作業の全体の流れ
1. ツール導入（2）→ GitHub（3）→ Firebase プロジェクトを Spark のまま作成（4）→ Authentication（5）
2. Web アプリ登録と `web/.env`（6）
3. GAS のセットアップとデプロイ → URL を `VITE_GAS_ENDPOINT` に設定（7）
4. ローカル確認（8）→ テスト（9）→ rules/indexes/hosting をデプロイ（10）→ 実機確認（11）

---

## 2. 前提ツール

```bash
# Homebrew 経由（未導入のものだけ実行）
brew install node@22 gh openjdk@21
npm install -g firebase-tools
# 任意: gcloud は Spark 運用では必須ではありません（API 有効化は Console でも可）
brew install --cask google-cloud-sdk

node -v        # v22.x
npm -v
firebase --version
gh --version
gcloud --version   # 任意
```
clasp は `gas/` の devDependency（`@google/clasp`）なので、`npx clasp ...` で使えます（グローバル導入は不要）。

Node 22 が PATH に無い場合:
```bash
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
```

### Java 21（エミュレータ、特に Firestore エミュレータに必須）
```bash
echo 'export JAVA_HOME=/opt/homebrew/opt/openjdk@21' >> ~/.zshrc
echo 'export PATH="$JAVA_HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
java -version   # openjdk 21 と表示されること
```

### 依存関係のインストール
```bash
cd /Users/kazuma/Documents/dev/baby-hub
npm --prefix web install
npm --prefix gas install
npm --prefix rules-tests install
npm --prefix e2e install
# functions/ は参考用のためインストール不要
```

---

## 3. GitHub リポジトリ作成と初回 push

アカウントは **`<OWNER_EMAIL>`** に紐づく GitHub アカウントを使います。

```bash
gh auth status                 # 現在のログイン先を確認
gh auth login                  # 未ログインなら: GitHub.com → HTTPS → ブラウザ認証（<OWNER_EMAIL> のアカウントで）
# 別アカウントでログイン済みの場合
gh auth login                  # もう一方を追加ログイン
gh auth switch                 # 使うアカウントを選択
gh auth status                 # Active account が目的のアカウントか確認
```

### .env をコミットしないことの確認
```bash
cd /Users/kazuma/Documents/dev/baby-hub
cat .gitignore 2>/dev/null || echo "(.gitignore がありません)"
```
無い/不足していれば作成します（既にあれば不足行だけ追記）。
```bash
cat >> .gitignore <<'EOT'
node_modules/
dist/
lib/
.env
.env.*
!.env.example
*.local
.firebase/
firebase-debug*.log
firestore-debug.log
ui-debug.log
.DS_Store
EOT
```
コミット前に確認:
```bash
git add -A
git status --short | grep -E '\.env($|\.)' | grep -v '\.env\.example' && echo "!! .env が含まれています。git reset して .gitignore を直す" || echo "OK: .env は含まれていません"
git ls-files | grep -E 'node_modules|/lib/|/dist/' | head   # 何も出なければOK
```

### コミットと push（private 推奨）
```bash
git config user.email "<OWNER_EMAIL>"   # このリポジトリ限定の設定
git commit -m "Initial commit: Baby hub"
git branch -M main
gh repo create baby-hub --private --source=. --remote=origin --push
gh repo view --web      # オーナーが <OWNER_EMAIL> のアカウントか確認
```
`requirements.md` には家庭の運用方針が含まれるので、公開しない（private）ことを推奨します。

---

## 4. Firebase プロジェクト作成（Spark のまま）

**Blaze へのアップグレードは不要です。請求先アカウントの登録も予算アラートも要りません。**

### 4.1 ログインアカウントの確認・切替
```bash
firebase login                 # ブラウザで <OWNER_EMAIL> を選ぶ
firebase login:list            # ログイン済みアカウント一覧
firebase login:add             # 別アカウントを追加
firebase login:use <OWNER_EMAIL>   # 使用アカウントをこのプロジェクトディレクトリで切替
```
（gcloud を使う場合のみ `gcloud auth login` / `gcloud config set account <OWNER_EMAIL>`。）

### 4.2 プロジェクト分離（推奨）
開発用と本番用を分けます。ID は世界で一意なので、衝突したら末尾に数字を足してください。**GAS は 1 スクリプトにつき 1 つの GCP プロジェクトにしか紐付けられない**ため、dev / prod で別々の GAS スクリプト（`.clasp.json` を切り替え）が必要です。まず 1 環境で試し、運用開始時に本番を用意する進め方でも構いません。

| 用途 | プロジェクト ID 例 | エイリアス |
| --- | --- | --- |
| 開発 | `baby-hub-kzm` | `dev` |
| 本番 | `baby-hub-prod-kzm` | `prod` |

```bash
firebase projects:create baby-hub-kzm --display-name "Baby hub Dev"
firebase projects:create baby-hub-prod-kzm --display-name "Baby hub Prod"
```
（Google Analytics は不要です。）

### 4.3 Firestore の作成（asia-northeast1）
```bash
firebase firestore:databases:create '(default)' --location=asia-northeast1 --project baby-hub-kzm
```
Console の「Firestore Database > データベースを作成 > ロケーション: asia-northeast1 (Tokyo) > 本番モード」でも同じです。**ロケーションは後から変更できません。**

### 4.4 .firebaserc の書換えと `firebase use --add`
```json
{
  "projects": {
    "default": "baby-hub-kzm",
    "dev": "baby-hub-kzm",
    "prod": "baby-hub-prod-kzm"
  }
}
```
または対話的に `firebase use --add` でエイリアス(dev/prod)を付けます。`firebase use dev` で対象を切替、`firebase use` で確認。本番デプロイ時は必ず `firebase use prod` または `--project prod` を明示してください。

---

## 5. Authentication 設定

Console > Authentication > 「始める」。

1. **Sign-in method**
   - 「Google」を有効化。**プロジェクトのサポートメール**に `<OWNER_EMAIL>` を選択して保存。
   - 「メール/パスワード」を有効化（メールリンクは不要）。
2. **設定 > 承認済みドメイン**: `localhost` と Hosting のドメイン（`<project-id>.web.app`, `<project-id>.firebaseapp.com`）が入っていることを確認。独自ドメインを使うならここに追加。
3. **テンプレート（認証 > Templates）**: 「パスワード再設定」「メールアドレスの確認」の言語を **日本語** に変更。件名・差出人名（例: Baby hub）も必要に応じて編集。
4. パスワードポリシーは Authentication > 設定 > パスワードポリシーで必要に応じて強化。

dev / prod の両方で実施します。

---

## 6. Web アプリ登録と `web/.env` 作成

1. Console > プロジェクトの設定（歯車）> 「全般」> 「マイアプリ」> **ウェブ (`</>`)** を追加。ニックネーム `baby-hub-web`。**Firebase Hosting の設定は後で行うのでチェック不要**。
2. 表示される `firebaseConfig` の値を `web/.env` に写します。

```bash
cp web/.env.example web/.env
open -e web/.env
```

| 変数 | 取得場所 |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | firebaseConfig の `apiKey`（GAS のスクリプトプロパティ `FIREBASE_WEB_API_KEY` にも同じ値） |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain`（`<project-id>.firebaseapp.com`） |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket`（Storage は未使用だが値は入れる） |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `VITE_FIREBASE_APP_ID` | `appId` |
| `VITE_FIREBASE_VAPID_KEY` | プロジェクトの設定 > **Cloud Messaging** > **Web Push certificates** > 「Generate key pair」で生成した公開鍵 |
| `VITE_USE_EMULATORS` | ローカルのエミュレータ利用時 `true`、実環境に繋ぐ・本番ビルド時は `false` |
| `VITE_GAS_ENDPOINT` | GAS Web アプリの URL。開発（`npm run dev`）は `http://localhost:8787`、本番は 7 章で発行される `https://script.google.com/macros/s/.../exec` |

**重要**
- 本番ビルド（`npm --prefix web run build`）の前に `VITE_USE_EMULATORS=false` にし、`VITE_GAS_ENDPOINT` を本番 GAS の URL にすること。`true` や localhost のままだと本番サイトが localhost に接続しようとします。
- dev / prod で値が違うので、`web/.env.development` / `web/.env.production` に分けるのが安全です（`.gitignore` の `.env.*` で除外済み）。GAS の URL は 7 章の後で書き込みます。
- `apiKey` は秘匿情報ではありませんが、`.env` はコミットしない運用で統一します。
- Service Worker 側の設定は `firebase-messaging-sw.js?apiKey=...` のクエリでアプリが渡すため、ビルド時の置換作業は不要です。

---

## 7. GAS のセットアップとデプロイ

手順の詳細は [docs/gas/README.md](gas/README.md) が正です（ここでは流れと要点のみ）。**すべて `<OWNER_EMAIL>` で行います。** 所有者アカウントは GAS 経由で Rules を迂回して全データを読み書きできるため、**2 段階認証を必ず有効化**してください。

1. **clasp ログイン**（アカウント確認が重要）
   ```bash
   cd /Users/kazuma/Documents/dev/baby-hub/gas
   npx clasp login              # ブラウザで <OWNER_EMAIL> を選ぶ
   npx clasp login --status     # 別アカウントなら npx clasp logout してやり直す
   ```
   https://script.google.com/home/usersettings で「Google Apps Script API」をオンにする。
2. **スクリプト作成**: `npm run build` → `npx clasp create --type standalone --title "BabyHub API" --rootDir dist`。生成される `.clasp.json` はコミットしない。`dist/appsscript.json` が上書きされたら `npm run build` で戻す（スコープと webapp 設定が必要）。
3. **GCP プロジェクト紐付け**: Firebase Console でプロジェクト番号を確認 → Apps Script エディタ（`npx clasp open`）> プロジェクトの設定 > GCP プロジェクトを変更。OAuth 同意画面を設定（外部。テストモードなら `<OWNER_EMAIL>` をテストユーザーに追加。リフレッシュトークンの 7 日失効を避けるなら「本番環境に公開」を推奨）。API を有効化: **Cloud Firestore API / Firebase Cloud Messaging API / Identity Toolkit API / Google Drive API**。
4. **スクリプトプロパティ**: `FIREBASE_PROJECT_ID`（プロジェクト ID）、`FIREBASE_WEB_API_KEY`（6 章の `apiKey`）。`BACKUP_FOLDER_ID` は自動作成。
5. **push とデプロイ**: `npm run push`（= build && clasp push）→ エディタの「デプロイ > 新しいデプロイ > ウェブアプリ」、実行ユーザー **自分**、アクセスできるユーザー **全員**。発行された `/exec` URL を `web/.env` の `VITE_GAS_ENDPOINT` に設定。ブラウザでその URL を開き `{"ok":true}` が返ること。
6. **権限承認とトリガー**: エディタで `setupTriggers` を実行し、権限を承認（「安全でないページ」> 詳細 > 移動）。`dispatchNotifications`（5 分毎）と `dailyBackup`（1 時間毎起動・実処理は JST 3 時以降に 1 日 1 回）が「トリガー」画面に並ぶことを確認。
7. **FCM 設定**: [notify README](gas/notify/README.md) の「初期設定」（FCM API V1 の有効化、VAPID 鍵）。

### 更新時のデプロイ管理（URL を固定する）
`npm run push` の後、エディタの「デプロイを管理」> 既存デプロイの鉛筆 > バージョン「新バージョン」> デプロイ。**新規デプロイを作ると URL が変わり、Web の `VITE_GAS_ENDPOINT` と再ビルド・再デプロイが必要になります。** `clasp deploy` / `npm run deploy` は新しいデプロイを作るため、初回以外は使いません。

### 手動実行できる関数
エディタから `setupTriggers`, `dispatchNotifications`, `dailyBackup`, `backupNow(kind)`, `restoreBackup(targetProjectId, fullFileId, incrementalFileIdsCsv, confirm)` を実行できます（[backup README](gas/backup/README.md)）。

### 利用上限（無料 Gmail の GAS）
- URL Fetch **2 万回/日**（Firestore REST・FCM・Identity Toolkit の呼び出しがすべて 1 回ずつ数えられる）。このうちリクエスト（`doPost`）に **15,000 回/日**、トリガー（通知ディスパッチ・バックアップ）に **5,000 回/日** を別カウンタで割り当てています（詳細は 13.1b）。
- トリガー合計実行時間 **90 分/日**、1 実行 **6 分**（`doPost` も 6 分）
- 5 分毎の通知ディスパッチは 1 回数秒 × 288 回/日（目安約 15 分/日）。長引く場合は間隔を延ばす

---

## 8. ローカル開発（エミュレータ + GAS dev-server）

`web/.env.local`（または `.env.development`）に `VITE_USE_EMULATORS=true` と `VITE_GAS_ENDPOINT=http://localhost:8787` を設定。ポートは Auth 9099 / Firestore 8080 / Hosting 5000 / Emulator UI(自動)。GAS 用 dev-server は 8787。

### 手順（ターミナル3つ）
```bash
# ターミナル1: エミュレータ起動（Java 21 が必要。functions エミュレータは使わない）
cd /Users/kazuma/Documents/dev/baby-hub
firebase emulators:start --only auth,firestore

# ターミナル2: GAS ローカルサーバー（Node 上で GAS コアを動かす）
cd /Users/kazuma/Documents/dev/baby-hub/gas
npm run dev

# ターミナル3: Web 開発サーバー
cd /Users/kazuma/Documents/dev/baby-hub/web
npm run dev
```
- アプリ: http://localhost:5173、Emulator UI: http://localhost:4000
- dev-server の既定は `FIREBASE_PROJECT_ID=demo-baby-hub` なので、エミュレータを `--project demo-baby-hub` で起動するか環境変数を揃えること（[docs/gas/README.md](gas/README.md#ローカル開発エミュレータ--dev-server) 参照）。
- エミュレータのデータは終了で消えます。残すなら `firebase emulators:start --only auth,firestore --export-on-exit=./.emulator-data --import=./.emulator-data`（`.emulator-data` は gitignore に追加）。
- ローカルでは FCM は送信されず（ログのみ）、ドライブは `gas/.local-drive/` に保存されます。トリガーによる定期実行もありません。Push の確認は 11 章で実環境に対して行います。

### 夫婦2アカウントの招待フロー確認
通常ウィンドウ = 「Aさん（owner）」、シークレットウィンドウ = 「Bさん（editor）」。
1. 通常ウィンドウで http://localhost:5173 を開き、メール/パスワードで新規登録（エミュレータなので架空アドレスで可）。
2. 初期設定（`/setup`）で家族名・表示名・子どものニックネームを入力して作成。
3. 招待を発行して表示される URL（`/join#token=...`）をコピー。
4. シークレットウィンドウでその URL を開き、別メールで登録→表示名入力→参加。
5. 両方のホームで同じ子ども・メンバーが表示されることを確認。片方で記録→もう片方に反映されること、実施者・入力者の表示を確認。
6. 招待 URL の再利用・24時間経過後（Emulator UI で invites の `expiresAt` を過去へ書換え）が拒否されることも確認。

---

## 9. テスト実行

```bash
cd /Users/kazuma/Documents/dev/baby-hub
npm --prefix web run typecheck
npm --prefix web test                  # vitest（純粋関数）
npm --prefix gas run typecheck
npm --prefix gas test                  # vitest（エミュレータ不要）
npm --prefix gas run test:emu          # Firestore/Auth エミュレータ結合（firebase emulators:exec。Java 21 必須）
npm --prefix rules-tests test          # firebase emulators:exec で Firestore エミュレータを自動起動（Java 21 必須）
```
`rules-tests` と `gas test:emu` は `--project demo-baby-hub` を使うため、本物のプロジェクトには接続しません。

結合スモークテスト（`e2e/`）:
```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21; export PATH=$JAVA_HOME/bin:$PATH
npm --prefix e2e test
```
> e2e は GAS の dev-server を Auth/Firestore エミュレータに接続して実行します（`cd e2e && npm test`、52 シナリオ）。Java 21 の `JAVA_HOME` 設定が必要です。
> - `e2e/scripts/with-dev-server.sh` は `NODE_ENV=test` と **`ENABLE_TEST_ENDPOINTS=1`**（`/__test/*` を有効化）を付けて dev-server を起動します。dev-server は `127.0.0.1` のみで待ち受け、`demo-` プロジェクトかつエミュレータ環境変数が無いと起動しません。
> - 本体（:8787）は `DISABLE_RATE_LIMIT=1`（回数制限を無効化。エミュレータの Node のみ有効で、本番 GAS には存在しない）。回数制限のテスト用に、制限が有効な別プロセス（:8788）も起動します。
> - 管理者移譲（提案→承諾／辞退／取消し／期限切れ／古い再認証）、medication_taken の void と occurrence の連動、`contextEventIds` の updateEvent 限定、registerDevice の platform 正規化・fcmToken 重複排除（他ユーザーとの重複も）、移譲提案先の退出で提案が消えること、`exportFamilyData` の監査ログ、バックアップ復元（空の復元先に users を復元しない・現在の表示名の維持）、回数制限（`sendTestNotification` は 1 分 1 回、`exportFamilyData` は 1 時間 3 回）を含みます。

Web 側の書込み形式（`web/src/lib/db.ts` や `features/*` の setDoc 内容）を変えたときは `e2e/smoke.test.ts` の対応箇所も合わせて更新してください。

---

## 10. デプロイ

Spark では Functions を使わないため、Firebase 側のデプロイは **rules / indexes / hosting** のみです（`firebase deploy` に `--only` を付けて Functions を対象にしないこと。`firebase.json` に functions セクションはありません）。GAS は 7 章のとおり clasp で別に更新します。

### 10.1 事前確認
```bash
firebase use              # 対象が baby-hub-kzm であることを確認
```
gcloud による API 有効化は不要です（GAS 用の API 有効化は 7 章の GCP 紐付けで行う）。

### 10.2 順番どおりにデプロイ
**GAS（先に最新化）→ rules/indexes → hosting** の順で行います（Web が呼ぶ GAS・インデックスが先に存在している必要があるため）。
```bash
# 0) GAS を更新（変更がある場合）: cd gas && npm run push、その後エディタの「デプロイを管理」で既存デプロイを新バージョンに（7章）

# 1) Rules とインデックス
firebase deploy --only firestore:rules,firestore:indexes

# 2) Web をビルドして Hosting
#    ※ .env の VITE_USE_EMULATORS=false と VITE_GAS_ENDPOINT（本番 URL）を確認
#    （本番ビルドで VITE_USE_EMULATORS=true だとビルドが失敗します）
npm --prefix web run build
firebase deploy --only hosting
```
インデックスは構築に数分かかります。`firebase firestore:indexes` や Console の「インデックス」タブで「有効」になるまで待ってから画面を確認してください。

### 10.3 デプロイ後のセキュリティヘッダ確認（CSP ほか）
Hosting は `firebase.json` の `hosting.headers` で `Content-Security-Policy`（enforce）、`Strict-Transport-Security`、`Permissions-Policy`、`Cross-Origin-Opener-Policy: same-origin-allow-popups`、`X-Frame-Options` などを付与します（vite dev / エミュレータの Hosting では効かない場合があります。必ず本番 URL で確認）。

1. `curl -sI https://<プロジェクト>.web.app/ | grep -i -E "content-security|strict-transport|permissions-policy|cross-origin-opener"` で各ヘッダが返ること。
2. 本番 URL をシークレットウィンドウで開き、**DevTools > Console** に `Refused to ...` / `violates the following Content Security Policy directive` が出ていないこと。
3. 次の操作を一通り行い、同様に違反が出ないこと: Google ログイン（ポップアップ）、メール/パスワードログイン、記録の保存（Firestore）、招待作成（GAS）、通知の許可と端末登録（FCM）、再認証（家族削除・管理者移譲）。
4. `index.html` にインラインスクリプトが無いこと（`script-src` に `'unsafe-inline'` を入れていません）。

---

## 11. PWA・プッシュ通知の実機確認

HTTPS の Hosting URL（`https://<project-id>.web.app`）で確認します（エミュレータの localhost では実 Push は確認不可）。

### iPhone（iOS/iPadOS 16.4 以降）
1. **Safari** で URL を開く → 共有ボタン → **ホーム画面に追加**。
2. **ホーム画面のアイコンから起動**（通常の Safari タブでは Web Push は動きません）。
3. アプリの通知設定画面で通知を有効化する操作をタップ → OS の許可ダイアログで「許可」。許可は**ユーザー操作から**要求されます。
4. 「テスト通知」（`sendTestNotification`）を押して端末に届くか、タップで該当画面が開くか確認。
5. 届かない場合: iOS の設定 > 通知 > Baby hub が許可か、集中モード/おやすみモードを確認。

### Android (Chrome)
1. Chrome で URL を開く → メニュー > 「ホーム画面に追加 / アプリをインストール」。
2. 通知を許可 → テスト通知。インストール版で確認するのが望ましい。

### 追加確認
- 重要な申し送りを 1 台で作成 → もう 1 台に**数秒〜数十秒で**届くこと（Web からの即時呼出し経路）。
- 22:00〜07:00 の通常申し送りは翌 07:00 まで延期されること。
- 通知を拒否/未対応でも、ホームの予定・期限・未確認申し送りが使えること（要件 20.3）。
- 通知は補助であり到達保証なし。通知を読んだだけでは薬の実施や申し送りの確認済みにならない。
- アプリ更新: 新しいデプロイ後に「更新があります」トーストが出て、適用で最新になること（`registerType: 'prompt'`）。
- 通信断（機内モード）で起動・記録できること。

---

## 12. App Check

現状は未適用です。**GAS 経由の呼び出しでは App Check トークンを検証できない**（GAS の `doPost` は Firebase の App Check 検証機構を持たず、`access: ANYONE_ANONYMOUS` のため）ので、当面は適用しません。GAS 側の認証は Firebase ID トークンの検証（Identity Toolkit）で行います。

将来、**Web から Firestore へ直接アクセスする経路のみ**に適用することは可能です（GAS は所有者の OAuth トークンで REST を叩くため、Firestore 側で App Check を「適用」すると GAS からの呼び出しは対象外になるか影響を受けないことを確認してから行う）。手順の骨子:

1. Console > Build > **App Check** > ウェブアプリ > プロバイダに **reCAPTCHA Enterprise** を選択（サイトキー作成、Hosting のドメインを登録）。
2. ローカル開発用に `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` でデバッグトークンを発行し登録。
3. `web/src/lib/firebase.ts` の `initializeApp` 直後に `initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(import.meta.env.VITE_RECAPTCHA_SITE_KEY), isTokenAutoRefreshEnabled: true })` を追加し、`.env` に `VITE_RECAPTCHA_SITE_KEY` を追加。
4. まず「監視」でリクエスト比率が検証済みになることを確認してから Firestore を「適用」。適用後に古いクライアントが弾かれる点に注意（PWA の更新を先に配布）。

---

## 13. 運用

### 13.1 Google ドライブへのバックアップ
- `dailyBackup` が毎日 JST 3 時台に、`<OWNER_EMAIL>` のマイドライブ `BabyHub-Backup` へ JSON を保存します（**日曜はフル、他は差分**。差分 14 日・フル 4 世代保持、完了ごとに manifest 作成）。仕様は [backup README](gas/backup/README.md)。
- Firestore の公式スケジュールバックアップ（gcloud）は Blaze 専用のため使いません。
- 月 1 回は Apps Script の実行ログ（`backup complete` の `reads`）とドライブ上の最新 manifest を確認します。ログに警告 `backup.stale`（期限内の完了フルが無く、最新フルを期限切れのまま保持している状態）が出ていたら、トリガーの停止・エラーを確認し、`runBackupNow('full')` で新しいフルを取得してください（新しいフルの完了で自動解除）。
- **フォルダは共有しない**（健康情報を含む）。所有者アカウントの 2 段階認証を維持。

### 13.1b 回数制限・管理者移譲・端末・スコープ
- **回数制限**（uid 単位。超過は `resource-exhausted` / reason `rate-limited`。待ち秒数が `retryAfterSec` で返り、Web に表示されます）。値の正本は [docs/gas/README.md](gas/README.md) の表です。
  - 全関数合計 60 回/分（署名検証の直後、`accounts:lookup` の前に消費）
  - `createFamily` 5 回/日（JST）、`deleteFamily` / `deleteAccount` 各 5 回/時、`transferOwnership` / `acceptOwnershipTransfer` 各 10 回/時
  - `sendTestNotification` 1 回/分、`exportFamilyData` 3 回/時、`registerDevice` 10 回/時、`createDoseOccurrence` 30 回/時
  - 招待の失敗（`previewInvite` / `acceptInvite` 合算、失敗時のみ）10 回/時
  - 日次上限（JST、書込み系）: 書込み系合計 1,000 回/日、`deleteDoc` 200 回/日、`updateDoc` + `updateEvent` 合算 500 回/日、`notifyHandoverCreated` 200 回/日、`syncScheduleReminder` 200 回/日
  - 方式: 上限の厳密さは関数ごとに異なります。strict な上限（`createFamily`、削除系、移譲、`sendTestNotification`、招待失敗）は `LockService` で厳密に数えます。それ以外は CacheService の固定窓で、原子的でないため同時実行では多少超過し得ます。
- **日次 UrlFetch 予算**: リクエスト 15,000 回/日・トリガー 5,000 回/日（スクリプトプロパティ `ub:req` / `ub:trigger`、JST 0 時にリセット）。リクエスト側は枠を使い切ると `unavailable` / reason `daily-budget` で拒否します（トリガー枠には影響しません）。トリガー側は超過を警告ログに出すだけで止めません。
- **トークン失効の反映遅延**: `accounts:lookup` の正の結果を 60 秒キャッシュするため、アカウント無効化・トークン失効（`validSince`）の反映は**最大 60 秒遅れ**ます。`deleteAccount` 成功時はキャッシュを破棄します。
- **PropertiesService の書込みに関する注意**: 日次カウンタ（`rld:{uid}`）と UrlFetch 予算カウンタ（`ub:*`）は、**リクエストごとに**スクリプトプロパティへ書き込みます。GAS にはプロパティの書込み回数・容量（合計 500 KB、1 値 9 KB）の上限があるため、利用者・リクエストが大幅に増える場合は実行ログで書込みエラーを確認してください。古い `rld:*` は約 6 時間毎の通知ディスパッチが掃除します。
- **管理者の移譲は 2 段階**: オーナーが提案（`transferOwnership`、有効期限 24 時間、再認証必須）→ 相手（編集者）が承諾（`acceptOwnershipTransfer`、再認証必須）で初めて交代。取消し・辞退は `cancelOwnershipTransfer`。承諾前でも家族のオーナーは変わりません。
- **端末**: 1 ユーザーあたり 10 台まで（超えると最古の端末を削除）。同じ FCM トークンの端末は重複排除。`platform` は `ios` / `android` / `desktop` / `other`。
- **端末と通知の運用**: プッシュ通知は信頼端末でのみ有効にできます（共有端末では通知ボタンが無効）。信頼端末を共有端末に切り替えたとき、「端末のキャッシュを消去」を行ったとき、起動時に共有端末へ通知登録（端末 ID・FCM 用 SW）が残っていたときは、FCM トークン・`devices`・SW の登録を解除します。キャッシュ消去後は通知を再度有効にしてください。
- **利用上限の表示**: GAS が `unavailable` / reason `daily-budget` を返すと「本日の利用上限に達しました。時間をおいてお試しください」と表示します（URL Fetch の日次上限に近づいたとき）。reason `keys-refreshing`（認証用の鍵を更新中）はログアウトせず、少し待って再試行します。`deleteAccount` が `internal`（reason `auth-delete-failed`、Auth ユーザーの削除失敗）を返した場合は、再ログインしてもう一度削除します（冪等）。Web は reason を優先して文言を決めるため、コードが違っても同じ案内になります。
- **GAS のスコープを変更した場合**（`appsscript.json` の `oauthScopes`）は、デプロイ後に所有者アカウントで再承認（エディタから関数を 1 回実行して許可）が必要です。承認しないと Web アプリが認可エラーになります。
- **リリース物の確認**: `cd gas && npm run build` 後の `dist/Code.js` に `DISABLE_RATE_LIMIT` / `ENABLE_TEST_ENDPOINTS` / `__test` / `dev-server` / `emulator: true` / `child_process` が含まれないことを `grep` で確認します（`emulator: false` は含まれます）。

### 13.2 復元演習（本番前に dev で 1 回通す）
```
restoreBackup('baby-hub-kzm', 'FULL_FILE_ID[,P2_ID]', 'INC1_ID,INC2_ID,...')
```
- ファイル ID は `listBackups()` かドライブの URL から取得。対象は直近の完了フル + それ以降の差分。
- 復元先 projectId が本番と同じ場合は第 4 引数 `'OVERWRITE_PRODUCTION'` が必要（誤爆防止）。
- 復元先プロジェクトへ書き込めるよう、所有者アカウントに Cloud Datastore ユーザー権限が必要。
- **再開手順**: 1 回の実行は約 4.5 分で打ち切られ、`complete:false` を返します。進捗は復元先の `system/restoreState` に保存されるので、**`complete:true` が返るまで同じ引数でもう一度実行**してください（引数を変えると最初からやり直し）。
- **復元の挙動**: `users/*`（ユーザー本人の情報）は、復元先に現在のアカウントがなければ復元しません（空の復元先では 0 件）。`members` / `familyRefs` は現在の文書があればそれを優先（`displayName` も現在値を維持）し、無いものは `status: 'removed'`・`displayName: '退出したメンバー'` で戻します。`devices` は復元しません。
- 復元後、Web を復元先プロジェクトへ向けてログイン・家族データ・申し送りの表示を確認。
- 削除は `deletions/{hash}` に記録され（保持 21 日）、復元時に先行適用されるため、削除済みの家族・文書は復活しません。ただし 21 日より古い削除記録は清掃済みのため、それより古い（保持期間外の）バックアップからの復元は避けてください。
- 対象は Firestore の原本・設定のみ。Auth ユーザー（`firebase auth:export users.json` で別途エクスポート可）、Hosting、Rules は別途。目標 RPO 最大 24 時間、RTO 48 時間（要件 25.3）。

### 13.3 GAS の実行ログ確認
- Apps Script エディタ > 「実行数」で各実行の成否・所要時間を確認。ログ詳細は Cloud Logging（GCP コンソール > ログ エクスプローラ。`exceptionLogging: STACKDRIVER`）。
- 確認する値: `dispatchNotifications` の `{ sent, skipped, failed, deferred, swept }`、`dispatch budget exceeded`、`backup complete` の `reads`、`backup.stale` 警告。
- トリガー画面の「失敗率」が出ていないか月 1 回確認。失敗通知メールの設定（トリガーの通知設定）も推奨。

### 13.4 Spark 上限の監視方法
- **Firestore**: Console > Firestore Database > 「使用状況」タブで日次の読取/書込/削除と保存量を確認（読取 5 万/日・書込 2 万/日が目安）。バックアップと通知で読取を消費するため、家族データが増えたらフル頻度を下げる。
- **GAS**: エディタ「実行数」で 1 日の合計実行時間（90 分/日）を概算。URL Fetch 2 万/日は Firestore REST 呼出し数の増加（端末数・家族数の増加、スイープ）で近づく。
- **Hosting**: Console > Hosting の使用状況で転送量（10 GB/月）。
- 上限到達時は Firestore が `resource-exhausted`、GAS が "Service invoked too many times" 等で失敗する（課金は発生しない。翌日（太平洋時間のリセット）まで待つ）。
- 通知ジョブ（`notificationJobs`）が溜まっていないかを、試用期間中に Emulator UI/Console で確認。

### 13.5 ログに個人情報を出さない方針
- ログ・エラーメッセージに子どもの名前、健康の自由記述、薬名、メールアドレス、招待トークン、FCM トークンを出さない（ID と件数のみ）。
- Push の本文は定型文のみ（健康の自由文・薬名を含めない）。
- コード変更時も `Platform.log` に `data` 全体を渡さない。

---

## 14. 実装後の確認チェックリスト

要件 26.1 / 27.3 の受入シナリオから抜粋。エミュレータ（2 ウィンドウ）と実機で確認します。




- [ ] **別アカウント同期**: A のミルク記録を B のホームで確認（量・時刻・入力者が一致）
- [ ] **代理入力の実施者表示**: B のお世話を A が入力 → 実施者 B・入力者 A が区別され、次の初期実施者は A に戻る
- [ ] **オフライン記録→同期**: 機内モードで記録→復帰後に同じイベントが増えず「共有済み」になる
- [ ] **睡眠の日付跨ぎ**: 夜の就寝が翌日のホームに残り、起床で正しく終了。担当者絞り込みでも帯が壊れない
- [ ] **二重開始の確認**: 両端末で同時に睡眠開始 → 未確定/確認表示が出て勝手に削除されない
- [ ] **服薬の担当競合**: 同じ薬を A と B が同時に「担当する」→ 一方のみ担当、他方に「担当中」表示。再完了が二重にならない
- [ ] **招待の期限・一回限り**: 使用済み、24 時間超過、2 名上限、権限の自己昇格が拒否される
- [ ] **退出・削除**: 退出後に別ユーザーのキャッシュが見えない／家族削除でサブコレクション・ジョブが残らない／JSON 出力が取れる
- [ ] **ダークテーマ**: システム/ライト/ダーク切替で全画面が読める
- [ ] **5 秒入力**: 片手で一般記録（おむつ・ミルク等）が 5 秒以内に入れられる
- [ ] 吐いた 1 タップ保存が生活リズム・健康・振返りに 1 件として出る
- [ ] 過去の最後の授乳を訂正・無効化 → ホームの最終記録が再計算される
- [ ] 通知を許可しなくても予定・期限・重要事項がホームで確認できる
- [ ] 夫婦のスマホで PWA 起動、ログイン維持、同期、通信断、通知、更新を確認（27.3）

- [ ] **GAS 疎通**: デプロイした `/exec` URL を開くと `{"ok":true}`。Web で家族作成・招待・更新・削除が成功する
- [ ] **トリガー**: Apps Script の「トリガー」に `dispatchNotifications`（5 分毎）と `dailyBackup`（1 時間毎）があり、直近の実行が成功
- [ ] **即時通知**: 重要な申し送りが相手端末に数秒〜数十秒で届く。静穏時間中の通常申し送りは延期される
- [ ] **バックアップ**: ドライブ `BabyHub-Backup` に `chub-full-*.json` と manifest があり、dev で復元演習が通る


---

## 15. 既知の制限・未実装・調整ポイント

### GAS 版の制約
- **呼び出しが 1〜3 秒かかる**: GAS Web アプリのコールドスタート・同期 HTTP のため。更新・削除・服薬担当などの操作は Cloud Functions 版より遅い（Web 側は進行表示で対応）。
- **Firestore トリガーがない**: 通知は Web が作成直後に `notifyHandoverCreated` / `syncScheduleReminder` を呼ぶ（ベストエフォート）ことで即時化し、5 分毎の `dispatchNotifications` のスイープ（約 10 分に 1 回）で呼出し漏れを補完する。Web を経由しない直書きの通知は最大約 10 分遅れる。
- **削除記録の保持は 21 日**: 復元は削除記録（`deletions/*`）を先行適用して削除済み文書の復活を防ぎます。記録は 21 日で清掃されるため、バックアップ保持（14 日）を超えた古いバックアップは使わないでください。
- **500 件超の一括処理は非アトミック**: 家族削除・エクスポート・復元などで 500 件を超える書込みは分割コミットされる（途中失敗時は再実行で冪等に完了させる設計）。
- **実際の GAS 環境での動作は未確認**: エミュレータ + Node 上のコア（`gas test` / `test:emu` / dev-server）でのみ検証済み。`UrlFetchApp`、`CacheService`、`DriveApp`、トリガー、OAuth スコープ承認、本番 FCM は実機で最初に確認が必要。
- 上限: URL Fetch 2 万/日、トリガー 90 分/日、6 分/実行、リクエスト本文 64KB。端末が多いと FCM の UrlFetch が増える（端末ごとに 1 リクエスト）。
- 通知は申し送りの編集では再通知しない。重複送信ゼロ・到達保証なし。
- GAS は HTTP ステータスを設定できず常に 200 + JSON を返す。ID トークン検証は Identity Toolkit 経由（キャッシュ 5 分）。
- 所有者アカウント（`<OWNER_EMAIL>`）への依存が大きい（漏えい＝全データ、アカウント停止＝サービス停止）。

### 全般・PWA
- PWA アイコンは SVG のみ。iOS 用に 180px 等の PNG `apple-touch-icon`（`web/public/icons/` に置き、`index.html` に `<link rel="apple-touch-icon" ...>` を追加）を用意すると良い。
- メイン JS チャンクが 500KB 超（firebase 同梱）。必要なら `React.lazy` や `build.rollupOptions.output.manualChunks` でコード分割。
- 信頼端末切替・キャッシュ消去は再読込で反映される。
- **共有端末ではプッシュ通知を有効にできない**（信頼端末のみ）。信頼端末を解除する、またはキャッシュを消去すると、この端末の通知登録は解除され、再度有効にする必要がある。
- **起動時の端末データ消去は 15 秒で打ち切る**。他のタブやウィンドウで開いていて消去が終わらない場合は、安全のため画面を開かず「再読み込み」画面を表示する（他のタブを閉じて再読み込み）。
- 各種確認は `window.confirm`（独自ダイアログ未実装）。

### アカウント・家族
- 記録方法（母乳中心/ミルク中心）・共有端末かどうかの初期設定選択は未実装。既存方式へのアカウント連携（`linkWithCredential`）も未実装。
- 練習データ→本番は「家族削除→作り直し」の案内のみ（自動移行なし）。
- 管理者の移譲は 2 段階（提案→承諾、期限 24 時間）。承諾には両者の再認証が必要。
- ヘルスプロフィールの初回作成時のアレルギーは最大 5 件（それ以上は作成後に編集で追加）。
- 退出・除外を検知すると端末のデータを消去して `/setup` へ戻る。購読の permission-denied だけの場合は、サーバーで `members/{自分}` を確認し、active でないと確定したときだけ消去する（ネットワークエラー等で確認できなければ消さず、15 秒後に再確認）。未同期の記録がある場合は消去前に通知する（件数は端末キャッシュ上の未送信イベントのみ数える。ほかのコレクションの未送信は件数なし）。

### 予定・ToDo・買い物・申し送り
- 買い物の編集 UI なし。予定の関連先編集なし。予定終了は同日のみ。
- ToDo の `sourceCheckedAt` 入力なし。申し送りから ToDo 等への変換なし。
- 新規の予定・Task・受診メモ等はオンライン確定（オフライン下書きなし）。

### 健康・薬
- 完了済み `doseOccurrence` の履歴一覧なし（`medication_taken` イベントから表示）。

### セキュリティ・Rules
- App Check 未適用（12 章。GAS 経路では検証不可）。
- **CSP**: 配信ヘッダの設定は 10.3 / 16 章を参照。`frame-ancestors` は `<meta>` では効かないためヘッダ側が必要（GitHub Pages 等ではヘッダを設定できない）。
- Rules の event create は `contextEventIds` を拒否（関連付けは GAS `updateEvent` で実在確認）、時刻は現在 +10 分まで、`memo` 等のタグは Web の `OTHER_TAGS`・症状タグは `SYMPTOM_TAGS` の値のみ、ドキュメント ID は `^[A-Za-z0-9_-]{1,128}$`。申し送りの宛先・予定の担当は active メンバー 2 人まで、`relatedRefs` は 5 件まで。
- **依存パッケージの残存脆弱性（いずれも開発用で本番配信物には含まれない）**: `gas` の clasp 経由 `braces`（3 件）、`rules-tests` の firebase 11 経由 `@grpc/grpc-js`（5 件）。`npm audit` で出ますが、`--force` による更新は破壊的変更を含むため様子見です。
- Rules は配列要素（`relatedRefs`, `contextEventIds` 等）の中身を検証しない（件数上限のみ）。同一家族内参照の検証は、今後 GAS 経由の作成にする余地あり。

### 記録・ホーム
- 訂正履歴は版番号と訂正者・日時のみ（差分表示なし）。
- 確認待ち睡眠は個別の訂正・無効化で解決する（専用の関連付け画面なし）。
- `feedingSessionId` による授乳セッションの関連づけは未対応。
- 「吐いた」「沐浴」「寝た・起きた」の1タップ保存は本人・現在時刻固定（ホームの「時刻・実施者を指定して記録」から指定可）。
- ミルク量プリセットは固定値（家族で編集不可）。
- 7日表示の日ごとの要点は、フィルタ前の全記録で集計される。
- 保存直後の「詳細を追加・取り消す」は専用バーで実装。オフライン時は取り消し不可。
- 体温・症状・成長の訂正は健康画面側で行う。

---

### 結合テストで未検証の範囲・注意
- e2e（`e2e/`）および GAS のテストで未検証: 実 GAS 上での全関数、実 FCM での通知（registerDevice・sendTestNotification・dispatchNotifications）、トリガー実行、オフライン再送、実ブラウザでの UI 操作。実機・エミュレータ UI で確認してください。
- 退出済みメンバーのイベント作成が拒否される際、Firestore エミュレータが「Rules の評価式が上限（1000）に達した」旨を出力しました。拒否自体は正しい動作ですが、`firestore.rules` のイベント create 検証が複雑なため、payload 検証を type ごとの関数に分けて早期に打ち切る等の簡素化を検討してください。

---

## 16. トラブルシューティング

### 全般
| 症状 | 原因と対処 |
| --- | --- |
| `auth/unauthorized-domain` | 開いているドメインが未承認。Authentication > 設定 > 承認済みドメインに追加（`localhost`、`*.web.app`、独自ドメイン）。127.0.0.1 ではなく `localhost` で開く |
| `The query requires an index` | エラー文中の URL をブラウザで開き「インデックスを作成」。恒久化は `firebase firestore:indexes > firestore.indexes.json` で取り込みコミット→ `firebase deploy --only firestore:indexes`。構築完了まで数分 |
| `Could not spawn java -version` / Firestore エミュレータが起動しない | Java 未検出。2 章の `JAVA_HOME` を設定し `java -version` が 21 になっていること。新しいターミナルを開き直す |
| `Port 8080 is not open` / 既に使用中 | `lsof -i :8080` で確認し終了、または `firebase.json` の emulators ポートを変更（`web/src/lib/firebase.ts` の接続ポートも合わせる） |
| 本番サイトが「ネットワークエラー」 | `VITE_USE_EMULATORS=true` または `VITE_GAS_ENDPOINT=http://localhost:8787` のままビルドした可能性。本番値で再ビルド→再デプロイ |
| 更新したのに古い画面のまま | Service Worker のキャッシュ。「更新があります」トーストを適用、または DevTools で Unregister。`index.html`/`sw.js` は `no-cache` 配信済み |
| Push が届かない | (1) iPhone はホーム画面に追加した PWA か (2) 通知許可 (3) `VITE_FIREBASE_VAPID_KEY` が正しい公開鍵か (4) `/firebase-messaging-sw.js` が 200 で配信されるか (5) `users/{uid}/devices` に `fcmToken` が保存されているか (6) 静穏時間（既定 22:00〜07:00）・通知種別設定 (7) GAS 実行ログの `dispatchNotifications` と `notificationJobs` の状態 (8) 下記 GAS 項目（401/403、トリガー） |
| 起動時に「端末のデータを消去できませんでした。他のタブやウィンドウで…」と表示される | 共有端末のキャッシュ消去が 15 秒以内に終わらなかった。他のタブ・ウィンドウ・PWA を閉じてから「再読み込み」 |
| 通知を有効にするボタンが押せない（「共有端末では通知を有効にできません」） | この端末が共有端末設定。「この端末」で信頼端末にしてから有効にする。キャッシュ消去後も通知は再度有効にする必要がある |
| 「本日の利用上限に達しました」 | GAS の URL Fetch 日次上限（2 万回/日）付近。翌日まで待つ。頻発する場合は 7 章の利用上限を確認 |
| 「アカウント削除の途中で失敗しました」 | 認証ユーザー削除に失敗。再ログインして `deleteAccount` をやり直す |
| 別アカウントでログインしてしまっている | `firebase login:list` → `firebase login:use <OWNER_EMAIL>`、`gh auth switch`、`cd gas && npx clasp logout && npx clasp login`（`--status` で確認） |

### CSP（Content-Security-Policy）違反
| 症状 | 原因と対処 |
| --- | --- |
| ログインのポップアップが開かない/空白、Console に `Refused to frame` / `Refused to load the script` | DevTools > Console の `violates the following Content Security Policy directive: "<ディレクティブ>"` と `Blocked URI` を確認。許可するドメインを `firebase.json` の `hosting.headers`（`source: "**"`）内 `Content-Security-Policy` の該当ディレクティブに追加し、`firebase deploy --only hosting`（`index.html`/`sw.js` は `no-cache` だが、反映されない場合はハードリロード） |
| `Refused to connect to ...`（データ取得・GAS 呼び出し・通知登録が失敗） | `connect-src` に当該ドメインを追加。現在の許可: `'self'`, `https://*.googleapis.com`（Firestore / Identity Toolkit / securetoken / FCM / Installations）, `https://*.firebaseapp.com`, `https://script.google.com`, `https://script.googleusercontent.com`。GAS の URL が別ドメインを返す場合はそのドメインを追加 |
| 独自の認証ドメイン（`authDomain` に独自ドメイン）でログインできない | `frame-src` と `connect-src` にそのドメインを追加（`*.firebaseapp.com` のみ許可しているため） |
| 通知の SW が動かない（`importScripts` が拒否） | `script-src` の `https://www.gstatic.com` が必要（`firebase-messaging-sw.js` が Firebase SDK を読み込む）。SW 自身のヘッダにも `**` のルールが適用される |
| Console の Report-Only を使って事前検証したい | `firebase.json` の `Content-Security-Policy` を一時的に `Content-Security-Policy-Report-Only` に変えてデプロイ→ Console で違反を確認→値を戻す |

### GAS 固有
| 症状 | 原因と対処 |
| --- | --- |
| Firestore/FCM/Identity Toolkit が **403**（"API has not been used in project ... / disabled"） | GCP 側で API 未有効化、またはスクリプトが Firebase の GCP プロジェクトに紐付いていない。7 章の手順 3 で紐付けを確認し、**Cloud Firestore API / Firebase Cloud Messaging API / Identity Toolkit API / Google Drive API** を有効化。数分待って再試行 |
| 403 "requires a quota project" / `x-goog-user-project` | 本番の REST 呼出しには `x-goog-user-project: <projectId>` ヘッダが必要（コアが付与済み）。出る場合は GCP 紐付け先が違う、またはスクリプトプロパティ `FIREBASE_PROJECT_ID` の誤り。所有者アカウントがそのプロジェクトの Owner/Editor かも確認 |
| 権限エラー・新機能が動かない（スコープ変更後） | `appsscript.json` の `oauthScopes` を変えたら、エディタで `setupTriggers` 等を再実行して**再承認**。デプロイ済みウェブアプリも「新バージョン」で更新が必要 |
| Web で CORS エラー、または JSON でなく **HTML のエラーページ**が返る | (1) デプロイが「アクセスできるユーザー: 全員」か (2) `VITE_GAS_ENDPOINT` が `/exec` の URL か（`/dev` ではない）(3) 古いデプロイ URL を使っていないか (4) リクエストは `Content-Type: text/plain` の POST（プリフライト回避）か (5) GAS 側の未処理例外・クォータ超過で HTML が返っていないか。ブラウザで URL を開き `{"ok":true}` を確認 |
| トリガーが動かない | エディタ > トリガー画面で `dispatchNotifications` / `dailyBackup` の存在と失敗履歴を確認。なければ `setupTriggers` を再実行（承認が必要）。承認が切れた場合は再承認。OAuth 同意画面がテストモードだと 7 日で失効し得るため「本番環境に公開」を検討 |
| クォータ超過（"Service invoked too many times" / `Exception: ... limit`、Firestore `resource-exhausted`） | URL Fetch 2 万/日、トリガー 90 分/日、Firestore 読取 5 万/日・書込 2 万/日のいずれか。実行ログで原因を特定し、5 分毎の間隔延長・バックアップのフル頻度低減を検討。リセット後に回復 |
| デプロイ後も古い挙動 | ウェブアプリのデプロイが旧バージョンのまま。「デプロイを管理」で既存デプロイを「新バージョン」に更新（URL は変わらない） |
| 新規デプロイして URL が変わった | `web/.env.production` の `VITE_GAS_ENDPOINT` を更新して再ビルド・`firebase deploy --only hosting` |
| `firebase deploy` で Functions を求められる / `Billing account required` | `functions/` はデプロイ対象外。`--only firestore:rules,firestore:indexes` や `--only hosting` を使う（Blaze にしない） |
