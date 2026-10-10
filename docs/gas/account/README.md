# account（データエクスポート・家族削除・アカウント削除）

実装: `gas/account/index.ts`。移植元 `functions/src/account.ts`（`registerDevice` / `sendTestNotification` は `gas/notify` に移動）。

## 提供関数

| fn | 入力 | 出力 | 主なエラー（details） |
| --- | --- | --- | --- |
| `exportFamilyData` | `{ familyId }` | `{ exportedAt, family, members, children[], schedules, tasks, shopping, handovers, contacts }`（Timestamp は ISO 文字列） | `permission-denied`, `not-found` |
| `deleteFamily` | `{ familyId, confirmName }`（owner、直近5分以内の再認証） | `{ ok: true }` | `failed-precondition`（`reason: 'recent-auth-required'` / `'confirm-mismatch'`）, `not-found` |
| `deleteAccount` | `{}`（直近5分以内の再認証） | `{ ok: true }` | `failed-precondition`（`reason: 'recent-auth-required'` / `'owner-has-members'` + `familyId`）, `internal`（Auth ユーザー削除失敗。`details.reason: 'auth-delete-failed'`） |

- `deleteAccount`: 自分だけの家族は丸ごと削除、他メンバーがいる家族は `left` + 表示名匿名化。最後に `users/{uid}` を再帰削除し、Auth ユーザーを削除する。
- **削除後の後始末**: Auth ユーザー削除に**成功した後**に `system/deviceRegistry/users/{uid}` と `system/accountDeletion/users/{uid}`（削除ロック）を削除する。端末トークンの逆引き文書（`system/deviceTokens/tokens/{sha256(token)}`、自分のもの）も削除する。**Auth 削除に失敗したときはロックを残し**、`internal` / `details.reason: 'auth-delete-failed'` を返す。**再実行手順: 再ログインして（直近 5 分以内の再認証）、もう一度「アカウント削除」を実行する**（冪等。ロックの `createdAt` は最初の作成時刻を維持）。ロックは `createdAt` を持ち、**7 日以上残ったロックは通知ディスパッチ（約 6 時間毎）が `accounts:lookup` で Auth ユーザーの存在を確認し、存在しなければ削除**（存在すれば残す）。
- **Auth ユーザー削除**: GAS には Admin SDK が無いため、`POST {identityBaseUrl}/v1/projects/{projectId}/accounts:delete`、body `{localId: uid}` を **スクリプト所有者の OAuth トークン**（`Platform.getAccessToken()`）で呼ぶ（呼び出し元の idToken は使わない）。USER_NOT_FOUND は成功扱い（再実行対応）。

## 必要な設定

- Google Cloud プロジェクトで **Identity Toolkit API を有効化**する。
- スクリプト所有者（`<OWNER_EMAIL>`）が Firebase プロジェクトの Owner、または `Firebase Authentication Admin`（`roles/firebaseauth.admin`）を持つこと。
- GAS の GCP プロジェクトをこのプロジェクトに紐付け、`appsscript.json` の oauthScopes に `https://www.googleapis.com/auth/identitytoolkit`（`accounts:delete` 用。`cloud-platform` は付与しない）が必要。`ScriptApp.getOAuthToken()` が返すトークンに `accounts:delete` の権限スコープが無い場合は 403 になるため、core 側のスコープ設定（G1）を確認する。
- エミュレータでは `identityBaseUrl=http://127.0.0.1:9099/identitytoolkit.googleapis.com` に対して Bearer `owner` で呼ばれる。

## 実行時間・再実行

- GAS の 1 回の実行は **6 分まで**。`deleteFamily` / `deleteAccount` / `exportFamilyData` は Firestore REST を逐次呼ぶため、目安として **ドキュメント合計 数千件（概ね 3,000〜5,000 件程度、1 リクエスト 約 50〜100ms 換算）** までを想定。家族 2 人・1 児の通常利用なら収まる。
- 途中で失敗/タイムアウトした場合: `deleteFamily` は家族を `status: 'deleting'` にしてから削除するため、**同じ呼び出しをもう一度実行すれば続きから削除できる**（`deleting` 中は ownerUid 一致で再実行を許可。members が消えていても可）。`deleteAccount` も冪等（残った家族 refs から再計画、Auth 削除は最後）。ただしタイムアウト後は idToken の再認証（5分）が必要な場合がある。
- `exportFamilyData` は読み取り専用トランザクション（`beginTransaction` の `options.readOnly`）で権限確認と全読取を一貫したスナップショットで行い、監査ログ `family.export` は読取り後に別書込みする。読取件数が多いと 6 分を超える可能性がある（イベント数万件規模）。その場合は期間分割が必要（現状未対応）。

## Web からの呼び出し

`api.exportFamilyData({ familyId })`, `api.deleteFamily({ familyId, confirmName })`, `api.deleteAccount({})`。再認証が必要な場合 `details.reason === 'recent-auth-required'` が返るので、再認証後 `getIdToken(true)` で再試行。

## 動作確認

エミュレータで: 家族作成 → `exportFamilyData` → `deleteAccount`（owner 単独）→ Auth エミュレータからユーザーが消え、`families/{id}` 配下と `users/{uid}` が空になる。本番確認は検証用アカウントで実施すること。

## 制約・注意

- Spark プランの Firestore 書込上限（2万/日）・削除も書込に数えられる点に注意。
- 監査ログ `auditLogs` は家族ごと削除される。
- **家族削除の中断**: `deleteFamily` / `deleteAccount`（単独家族）は、`deleting` への更新と同じトランザクションで `system/familyDeletion/families/{fid}`（`{ ownerUid, members[], startedAt }`）を保存する。`purgeFamily` は先に全メンバーの `familyRefs` を `removed` にしてから再帰削除し、最後に familyRefs と記録を削除する。家族文書が既に無くても、記録の `ownerUid` が呼出者なら `deleteFamily`（`confirmName` は不問）や `deleteAccount` が記録から後始末を再実行する。
- `deleteFamily` / `deleteAccount` の競合対策: `purgeFamily` は先に `families/{fid}.status='deleting'` に更新してから members を列挙する（`acceptInvite` は active のみ許可）。`deleteAccount` は `familyRefs` に加え `families.ownerUid == uid` の家族と各家族の `members/{uid}` から owner を判定する。回数制限は両方 5 回/時（strict）、`exportFamilyData` は 3 回/時。他メンバーのアカウント削除時、移譲提案の相手が削除対象なら `pendingOwnerTransfer` も削除する。
