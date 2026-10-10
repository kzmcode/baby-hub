import { Link } from 'react-router-dom';
import { CategoryIcon, SyncBadge, syncStateOf } from '../../components';
import { useFamily } from '../../context';
import { formatTime } from '../../lib/time';
import { categoryOf, describeEvent, whoText } from './logic/describe';
import type { Ev } from './logic/types';

interface Props {
  ev: Ev;
  compact?: boolean;
  /** 日付も表示（日跨ぎの一覧） */
  showDate?: boolean;
  highlight?: boolean;
  /** 補足ラベル（「範囲外の直前の哺乳」など） */
  tag?: string;
  to?: string;
}

/** 記録1件の行。「◯◯が実施（△△が入力）」と同期状態を表示。色だけに依存しない */
export function EventRow({ ev, showDate, highlight, tag, to, compact }: Props) {
  const { memberName } = useFamily();
  const d = describeEvent(ev);
  const cat = categoryOf(ev.type);
  return (
    <Link to={to ?? `/records/${ev.id}`} className={`rec-row${compact ? ' rec-row--compact' : ''}${highlight ? ' is-target' : ''}`}>
      <span className="rec-row__icon" style={{ background: `var(--cat-${cat}-bg)`, color: `var(--cat-${cat}-fg)` }}>
        <CategoryIcon name={cat} size={26} />
      </span>
      <span className="rec-row__main">
        <span className="rec-row__title">
          {compact && <strong>{d.title}</strong>}
          <span className="num">{showDate ? `${ev.occurredAt.getMonth() + 1}/${ev.occurredAt.getDate()} ` : ''}{formatTime(ev.occurredAt)}</span>{' '}
          {!compact && <strong>{d.title}</strong>}
          {d.detail && <span className="rec-row__detail">{compact ? ' · ' : ' '}{d.detail}</span>}
          {tag && <span className="rec-row__tag">{tag}</span>}
        </span>
        <span className="rec-row__who small muted">{compact && ev.caregiverUid === ev.createdBy ? `お世話：${memberName(ev.caregiverUid)}` : whoText(ev, memberName)}</span>
        {ev.note && <span className="rec-row__who small muted">メモあり</span>}
      </span>
      {ev.pending && <SyncBadge state={syncStateOf({ pending: true })} />}
    </Link>
  );
}
