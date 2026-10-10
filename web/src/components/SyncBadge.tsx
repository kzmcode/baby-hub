import { CategoryIcon } from './CategoryIcon';
import { formatTime } from '../lib/time';

export type SyncState = 'local' | 'pending' | 'synced' | 'failed' | 'cache';

interface Props {
  state: SyncState;
  /** state='cache' のとき「キャッシュ表示（最終確認 HH:mm）」に使う */
  lastSyncedAt?: Date | null;
}

const LABEL: Record<SyncState, string> = {
  local: '端末に保存',
  pending: '未同期',
  synced: '共有済み',
  failed: '失敗',
  cache: 'キャッシュ表示',
};

/** 書き込みメタデータから状態を決める補助 */
export function syncStateOf(opts: { pending?: boolean; failed?: boolean }): SyncState {
  if (opts.failed) return 'failed';
  return opts.pending ? 'pending' : 'synced';
}

/** 同期状態の表示。アイコン＋文字で色だけに依存しない */
export function SyncBadge({ state, lastSyncedAt }: Props) {
  const icon = state === 'synced' ? 'check' : state === 'failed' ? 'alert' : state === 'cache' ? 'cloudOff' : 'cloud';
  const text =
    state === 'cache' && lastSyncedAt ? `${LABEL.cache}（最終確認 ${formatTime(lastSyncedAt)}）` : LABEL[state];
  return (
    <span className={`ch-badge ch-badge--${state}`}>
      <CategoryIcon name={icon} size={14} />
      {text}
    </span>
  );
}
