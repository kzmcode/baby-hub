# バックアップ・復元（gas/backup）

Firestore の公式バックアップ（Blaze 必須）の代わりに、GAS が所有者（`<OWNER_EMAIL>`）の Google ドライブへ JSON を保存する。

## 保存先と形式

- フォルダ: マイドライブ `BabyHub-Backup`（`DriveAdapter.ensureFolder` が無ければ作成。実行ユーザー＝スクリプト所有者のドライブ）。
- ファイル名（時刻は JST）:
  - `chub-full-20261011-0300.json`（日曜、フル）／`chub-inc-20261012-0300.json`（月〜土、差分）
  - データが大きい場合は `...p2.json`, `...p3.json` と分割（約5MB単位）
  - 完了時に `....manifest.json`（種別・件数・読取数・パート数）を作成。**manifest がある世代だけが「完了」**として扱われる。
- 中身: `{ formatVersion: 2, kind, projectId, startedAt, since, part, docs: [{ path, data }] }`。Timestamp は `{ "__ts": "2026-10-11T03:00:00.123456789Z" }`（ナノ秒まで復元）。
- 対象: `users/{uid}`（`settings` 含む）、`users/*/familyRefs`、`users/*/devices`（**`fcmToken` は除外**）、`families/{id}` 配下すべて（members, children と配下の events / healthProfiles / medications / doseOccurrences / medicalVisits / vaccinations、schedules, tasks, shopping, handovers と acks, contacts, auditLogs）。削除記録 `deletions/{hash}` も対象。`invites`・`notificationJobs` は対象外（機微なハッシュ／一時データ）。

## フルと差分

- **日曜はフル**（全件。初回や直近フルから8日超でもフル）。それ以外は**差分**。
- 差分は前回完了バックアップの開始時刻（5分の重なり付き）以降に更新された文書のみ。コレクションごとに `updatedAt > since`（`acks` は `acknowledgedAt`、`auditLogs` は `at`）。`members` / `familyRefs` / `devices` / `healthProfiles` は件数が少なく時刻で変更検知できないため毎回全件。`children` と `handovers` は配下を辿るため全件走査して、変更分のみ保存する。
- **削除記録も保存する**。削除開始のトランザクションで、削除対象のパスと時刻を家族外の `deletions/{hash}` に記録する。復元はバックアップ内と現在の削除記録を合わせて適用し、配下の文書・所属索引も復活させない。削除記録は健康情報を含まず（パスと削除時刻のみ）、古い復元による再生成を防ぐために保持する。バックアップには削除記録を1回の走査でまとめて保存する。
- **削除記録の保持は21日**（バックアップ保持14日＋余裕7日）。`runDailyBackup`／`runBackupNow` の冒頭で、`deletedAt` が21日より古い記録を最大約30秒の時間予算内で500件ずつ削除する。家族・アカウントの削除は、家族／ユーザー単位と所属索引の記録だけを積み、配下の子文書単位の記録は積まない。`deleteDoc`（個別文書）の記録は子文書単位だが、同じ期限で清掃される。
- Spark の読取上限（5万/日）対策: 差分は更新分だけを読む。1日の読取がバジェット（35,000件）を超えそうなら中断し、翌日以降に続きを実行する。読取件数はログ（`backup complete` の `reads`）に出る。通知処理と合わせた1日の合計が5万を超えないよう、家族データが大きくなったらフルの頻度を下げる。

## 6分制限と再開

処理は約4.5分で打ち切り、状態を Firestore `system/backupState`（クライアントからは Rules で拒否）に保存して、**次の実行で続きから再開**する。トリガーは**毎時**の実行を推奨（`dailyBackup` は JST 3時以降に1日1回だけ新規開始し、未完了なら再開、完了済みなら即 return）。5回連続で失敗すると中断して次の日からやり直す。

## 保持

- フル・差分とも開始から14日以上経過したファイルは Drive API の `DELETE` で**完全削除**する。フルは期間内でも最大4世代。未完了（manifest なし）は3日経過で削除する。各トリガー実行の開始時に適用し、バックアップがスキップ・失敗する場合にも清掃する。以前ゴミ箱へ移した同フォルダのバックアップも期限切れなら対象。
- トリガーやGoogle APIが停止している間は削除できない。再開時に清掃されるため、稼働・失敗ログを監視する。期限内に残る完了フル以降の差分だけを復元に使用する。
- **最新の完了フルは消さない**: 期限内の完了フルが1世代も無い場合（定期処理の停止後など）、最新の完了フルとそれ以降の差分は期限切れでも残し、より古い世代だけを削除する。この状態はログに警告 `backup.stale` として出力され、`system/backupState.staleSince` に開始時刻が残る（運用ログ用。Web には出さない）。新しいフルが完了すると自動で解除され、古いフルは次回清掃で削除される。`backup.stale` が出ていたら、トリガーの停止やエラーを確認し、`runBackupNow('full')` で新しいフルを取得する。
- パートのアップロード前に `uploadingPart` を `system/backupState` に記録する。アップロード中に中断した場合、再開時に同名の残骸ファイルを削除してから作り直すため、パートが重複しない。3日以上中断した実行は新しいフルから再開する。

## 手動実行

- Apps Script エディタから `dailyBackup`（通常ロジック）。強制で今すぐ取る場合は `runBackupNow('full')`（エントリ化は G1 に依頼済み）。
- ドライブのファイル ID は `listBackups()`（名前と ID の一覧）または URL から取得する。

## 復元手順

**本番に直接書き戻す前に、必ず開発用プロジェクトで復元演習を行う。**

1. 復元先の Firebase プロジェクト（開発用）を用意し、所有者アカウントに Firestore 書込み権限（Cloud Datastore ユーザー）を付与。GAS の `datastore` スコープの OAuth トークンでそのプロジェクトに書き込む。
2. 対象世代を決める: 直近の完了フル（manifest あり）1世代 + そのフル以降の差分すべて。
3. Apps Script エディタで実行:
   ```
   restoreBackup('baby-hub-kzm', 'FULL_FILE_ID[,FULL_P2_FILE_ID]', 'INC1_ID,INC2_ID,...')
   ```
   フルの複数パートはカンマ区切りで `fullFileId` に渡す。差分は `startedAt` 順に自動で並べ替えて適用する。同じ文書は `set` で上書きされる。
4. **本番と同じ projectId を指定した場合は、第4引数 `'OVERWRITE_PRODUCTION'` が無いと拒否される。** 本番復元は、障害時にデータの確認が済んでいる場合に限る。
5. 実行が 4.5 分を超えると `complete:false` で止まる。進捗は復元先の `system/restoreState`（対象ファイルID群・ファイル位置・文書位置・削除記録の適用位置）に保存される。**同じ引数で再実行すると続きから再開**する（引数が違うと最初から）。`complete:true` で状態は消える。削除記録の先行適用にも同じ時間予算があり、予算切れでも状態を保存して `complete:false` を返す。書込みは100件ずつのバッチで、削除記録・現在の家族状態は各チャンクで一括取得する。
   復元前に、フルが1世代であること、パート欠落が無いこと、manifest（完了印）が存在しパート数が一致すること、差分の `startedAt` がフル以降であることを検証し、不整合なら `failed-precondition`。
6. Auth ユーザー、Hosting、Rules などは対象外。別途復旧が必要。RTO/RPO の目標は requirements.md 25.3 を参照。
7. **個人情報と権限はバックアップから復活させない。** 現在の文書が存在する `members/*`・`familyRefs/*` は現在の値を優先し、バックアップでは上書きしない。現在の文書が無い `members` は `status:'removed'`・`displayName:'退出したメンバー'` に匿名化して復元する。`users/{uid}` は現在存在しなければ（アカウント削除済みの可能性）、その配下（settings・familyRefs）も含めて復元しない。存在する場合も現在値を維持する。したがって空の環境へ復元しても `users` は戻らない（Auth ユーザーの再ログイン時に再作成される）。 復元先に現存する家族の `ownerUid/status/memberCount` とメンバー・所属索引の `role/status` はトランザクションで維持する。復元先に情報がない場合は家族を `restoring`、メンバー・所属索引を `removed` として復元し、端末登録は復元しない。管理者が現在の正当な所属・管理者を本人確認し、家族・メンバー・所属索引を一貫して再設定してから `active` にする。現在の失効情報を確認できない場合は有効化しない。
8. 削除記録のない旧形式（formatVersionなし）は拒否する。更新後に新しいフルを取得する。更新前に削除済みだった家族を旧バックアップから自動復元しない。
9. 本番復元は利用を止めて行う。復元中の管理者による権限・削除操作を避け、最後にルールで削除済み／退出済みアカウントのアクセスが拒否されることを確認する。

## 注意

- バックアップには**健康情報（症状・服薬・体温など）が含まれる**。`BabyHub-Backup` フォルダは**共有しない**（リンク共有もしない）。必要最小限の人にだけ権限を付け、所有者アカウントには 2 段階認証を設定する。
- スコープは `drive.file`（このスクリプトが作ったファイルのみ。所有者の他のドライブ内容にはアクセスできない）。実装は Drive REST API v3（`UrlFetchApp` + `ScriptApp.getOAuthToken()`、multipart upload、`files.list` は `'<folderId>' in parents and trashed=false`）で、`DriveApp` は使わない。スクリプトに紐付けた GCP プロジェクトで **Google Drive API を有効化**しておくこと。フォルダを手で作り直した場合は同名で作成される別フォルダになる（旧フォルダは自動削除されない）。
- 端末にダウンロードしたバックアップは遠隔消去できない。
