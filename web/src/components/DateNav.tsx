import { CategoryIcon } from './CategoryIcon';
import { addDaysStr, formatDateLabel, formatDateJa, todayStr } from '../lib/time';

interface Props {
  /** yyyy-MM-dd */
  date: string;
  onChange: (date: string) => void;
  /** 未来日へ進めない（既定 false） */
  disableFuture?: boolean;
}

/** 前日／翌日／今日 の日付ナビ */
export function DateNav({ date, onChange, disableFuture }: Props) {
  const today = todayStr();
  const nextDisabled = disableFuture && date >= today;
  return (
    <div className="ch-datenav">
      <button type="button" className="ch-iconbtn" onClick={() => onChange(addDaysStr(date, -1))} aria-label="前の日">
        <CategoryIcon name="chevronLeft" />
      </button>
      <div className="ch-datenav__label" aria-live="polite">
        <strong>{formatDateLabel(date)}</strong>
        {formatDateLabel(date) !== formatDateJa(date) && <span className="muted small">{formatDateJa(date)}</span>}
      </div>
      <button type="button" className="ch-iconbtn" onClick={() => onChange(addDaysStr(date, 1))} disabled={nextDisabled} aria-label="次の日">
        <CategoryIcon name="chevronRight" />
      </button>
      <button type="button" className="ch-btn ch-btn--ghost" onClick={() => onChange(today)} disabled={date === today}>
        今日
      </button>
    </div>
  );
}
