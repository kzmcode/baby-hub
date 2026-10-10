import { CategoryIcon } from '../../components';
import { calendarDays, shiftCalendarMonth } from './logic/calendar';
import type { PSchedule } from './types';

export function ScheduleCalendar({ selected, today, byDate, onSelect }: {
  selected: string;
  today: string;
  byDate: Map<string, PSchedule[]>;
  onSelect: (date: string) => void;
}) {
  const days = calendarDays(selected);
  const [year, month] = selected.split('-').map(Number);
  return (
    <section className="pl-calendar" aria-label="予定カレンダー">
      <div className="pl-calendar__head">
        <button type="button" className="ch-iconbtn" aria-label="前の月" onClick={() => onSelect(shiftCalendarMonth(selected, -1))}><CategoryIcon name="chevronLeft" size={20} /></button>
        <h2 aria-live="polite">{year}年{month}月</h2>
        <button type="button" className="ch-iconbtn" aria-label="次の月" onClick={() => onSelect(shiftCalendarMonth(selected, 1))}><CategoryIcon name="chevronRight" size={20} /></button>
        <button type="button" className="pl-calendar__today" onClick={() => onSelect(today)}>今日</button>
      </div>
      <div className="pl-calendar__week" aria-hidden="true">{['日', '月', '火', '水', '木', '金', '土'].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="pl-calendar__days">
        {days.map((date) => {
          const items = byDate.get(date) ?? [];
          const active = items.filter((s) => s.status === 'planned').length;
          const [y, m, d] = date.split('-').map(Number);
          return (
            <button type="button" key={date} data-date={date}
              className={`pl-calendar__date${date.slice(0, 7) !== selected.slice(0, 7) ? ' is-outside' : ''}${date === selected ? ' is-selected' : ''}`}
              aria-label={`${y}年${m}月${d}日、予定${items.length}件${active !== items.length ? `（未完了${active}件）` : ''}`}
              aria-pressed={date === selected} aria-current={date === today ? 'date' : undefined}
              onClick={() => onSelect(date)}>
              <span>{d}</span>
              <span className={`pl-calendar__count${active ? ' has-active' : ''}`} aria-hidden="true">{items.length || '\u00a0'}</span>
            </button>
          );
        })}
      </div>
      <p className="small muted pl-calendar__hint">日付を選ぶと予定を表示します。数字は予定の件数です。</p>
    </section>
  );
}
