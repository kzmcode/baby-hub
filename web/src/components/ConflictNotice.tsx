import { Button } from './Button';
import { Card } from './Card';
import { CategoryIcon } from './CategoryIcon';

interface Props {
  /** 「最新の内容を見る」（サーバー側の最新を表示／再取得）。入力内容は呼び出し側で保持したままにする */
  onShowLatest?: () => void;
  /** 「この内容で保存し直す」（最新の revision を取り直して再送） */
  onRetry?: () => void;
  message?: string;
}

/** 楽観ロック競合の通知。自分の入力は消さず、再確認してから保存し直す導線を出す */
export function ConflictNotice({ onShowLatest, onRetry, message }: Props) {
  return (
    <Card tone="warning" role="alert">
      <div className="row">
        <CategoryIcon name="alert" />
        <strong>他の人が先に更新しました</strong>
      </div>
      <p className="small">{message ?? 'あなたの入力は残してあります。最新の内容を確認してから、保存し直してください。'}</p>
      <div className="row">
        {onShowLatest && <Button onClick={onShowLatest}>最新の内容を見る</Button>}
        {onRetry && <Button variant="primary" onClick={onRetry}>この内容で保存し直す</Button>}
      </div>
    </Card>
  );
}
