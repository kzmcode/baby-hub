import { useId } from 'react';
import { combineDateTime, formatTime, toDateStr } from '../lib/time';

interface Props {
  value: Date;
  onChange: (d: Date) => void;
  label?: string;
  /** 日付も変更できるようにする（時刻訂正で日跨ぎがあり得る場合） */
  withDate?: boolean;
}

/** 時刻（必要なら日付）入力。Asia/Tokyo 基準で Date を返す */
export function TimeInput({ value, onChange, label = '時刻', withDate }: Props) {
  const id = useId();
  const dateStr = toDateStr(value);
  const time = formatTime(value);
  return (
    <div className="ch-field">
      <label className="ch-field__label" htmlFor={id}>{label}</label>
      <div className={withDate ? 'ch-pair' : undefined}>
        {withDate && (
          <input
            type="date"
            className="ch-input"
            aria-label={`${label}の日付`}
            value={dateStr}
            onChange={(e) => e.target.value && onChange(combineDateTime(e.target.value, time))}
          />
        )}
        <input
          id={id}
          type="time"
          className="ch-input"
          value={time}
          onChange={(e) => e.target.value && onChange(combineDateTime(dateStr, e.target.value))}
        />
      </div>
    </div>
  );
}
