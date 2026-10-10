# family（家族・招待・メンバー管理）

実装: `gas/family/index.ts`（共有処理: `gas/shared/family-ops.ts`）。functions 版 `functions/src/families.ts` と同名・同入出力・同エラーコード。呼び出し形式は `docs/gas/architecture.md` 3章（`POST {fn, data, idToken}`）。

## 提供関数

| fn | 入力 | 出力 | 主なエラー（code / details） |
| --- | --- | --- | --- |
| `createFamily` | `{ familyName, displayName, child: { nickname, birthDate?, dueDate?, isSample? } }` | `{ familyId, childId }` | `already-exists`（既に所属あり）, `invalid-argument` |
| `createInvite` | `{ familyId }`（owner のみ） | `{ inviteId, token, expiresAt }` | `permission-denied`, `resource-exhausted`（1時間10件超）, `failed-precondition` |
| `revokeInvite` | `{ familyId, inviteId }`（owner） | `{ ok: true }` | `not-found` |
| `previewInvite` | `{ token }` | `{ familyName, inviterName, role, expiresAt }` | `not-found`, `failed-precondition`（details.reason: `expired` / `used` / `revoked` / `inviter-changed`） |
| `acceptInvite` | `{ token, displayName }` | `{ familyId }` | `not-found`, `already-exists`, `failed-precondition`（reason: `has-other-family` / `family-full` / `expired` / `inviter-changed` ほか） |
| `leaveFamily` | `{ familyId }` | `{ ok: true }` | `failed-precondition`（reason: `transfer-required` / `delete-family-required`） |
| `transferOwnership` | `{ familyId, toUid }`（owner。**要再認証**） | `{ pending: true, expiresAt }` | `failed-precondition`（`recent-auth-required` / 相手が active editor でない）, `invalid-argument`, `permission-denied` |
| `acceptOwnershipTransfer` | `{ familyId }`（提案の宛先本人。**要再認証**） | `{ ok: true }` | `failed-precondition`（details.reason: `no-pending-transfer` / `transfer-expired` / `recent-auth-required`） |
| `cancelOwnershipTransfer` | `{ familyId }`（owner または宛先） | `{ ok: true }` | `permission-denied`（提案なしなら冪等に成功） |
| `removeMember` | `{ familyId, uid }`（owner） | `{ ok: true }` | `invalid-argument`（自分自身）, `failed-precondition` |

- 招待トークンは `Platform.randomToken(32)`（256bit）で生成し、Firestore には SHA-256 ハッシュのみ保存。24時間有効、1家族 active 1件（新規発行で旧招待は失効）。
- **管理者の移譲は 2 段階**: `transferOwnership` は即時には移さず、`families/{fid}.pendingOwnerTransfer = { toUid, proposedBy, proposedAt, expiresAt(24時間後) }` を設定する（既存の提案は上書き）。監査ログ `owner.transfer.propose`。相手へ通知ジョブ（type `ownerTransfer`、定型文「管理者の移譲が提案されています」、url `/more/family`、設定・静穏時間に関わらず送信）を作る。`acceptOwnershipTransfer` は、呼出者が `toUid`・期限内・提案者がまだ owner のときに、トランザクションで role 入替・`ownerUid` 更新・`familyRefs` 更新・`pendingOwnerTransfer` 削除を行い、発行済みの招待を失効する。`cancelOwnershipTransfer` は提案を削除する。提案の相手（`toUid`）または提案者が退出・除外（`leaveFamily` / `removeMember`、同一トランザクション）・アカウント削除されると、提案も同時に削除する。承認時、相手の `joinedAt` が `proposedAt` より後（退出→再参加）なら `no-pending-transfer` で拒否する。`createFamily` は 5 回/日（JST）、`transferOwnership` / `acceptOwnershipTransfer` は各 10 回/時（いずれも strict、[回数制限](../README.md)）。
- `acceptInvite` は家族が `status==='active'` でなければ拒否する（`deleteFamily` が先に `deleting` にするため、削除中の家族への参加はできない）。
- メンバー上限は 2 名。退出/削除時は当該ユーザー宛の pending 通知ジョブを `skipped` にし、そのユーザーが発行した active 招待を失効する。

## 必要な設定

特別な設定なし（core の共通設定: Firestore REST 用の `datastore` スコープ、`FIREBASE_PROJECT_ID`/`FIREBASE_WEB_API_KEY`）。`invites` を `tokenHash`/`familyId`+`status`+`createdBy` 等で検索するが、複合インデックスは `firestore.indexes.json` に既存のものを使う（functions 版と同じクエリ。新規クエリは追加していない）。

## Web からの呼び出し

`web/src/lib/api.ts` の `api.createFamily(...)`, `api.createInvite(...)` など（関数名と同名）。

## 動作確認

1. `cd gas && npm run dev`（ローカル開発サーバー、エミュレータ接続）を起動。
2. Web から家族作成 → 招待発行 → 別ユーザーで `previewInvite`/`acceptInvite` → `leaveFamily`。
3. 期待結果: `families/{id}.memberCount` が増減し、`auditLogs` に `family.create` / `invite.create` / `member.join` / `member.leave` が残る。

## 制約・注意

- Firestore REST のトランザクションは楽観的（競合時 core が最大5回リトライ）。招待受諾の二重使用は tx 内の `status` 再検証で防ぐ。
- GAS は同時実行ロックを使っていない。メンバー上限の競合は Firestore トランザクションに依存する。
