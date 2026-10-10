import { CategoryIcon } from '../../components';
import { formatDateJa } from '../../lib/time';
import { RibbonLegend, RoutineRibbon } from './RoutineRibbon';
import type { DayRoutine } from './logic/routine';

interface Props {
  rows: DayRoutine[];
  fromHour?: number;
  toHour?: number;
  onRowClick?: (date: string) => void;
  onMarkerClick?: (eventId: string) => void;
  labelOf?: (date: string) => string;
}

/** Date labels stay outside each ribbon so seven-day views retain the same readable scale. */
export function RoutineChart({ rows, fromHour = 0, toHour = 24, onRowClick, onMarkerClick, labelOf }: Props) {
  return <div className="rec-routine" role="group" aria-label="生活リズム表">
    {rows.map((routine) => {
      const sleepMinutes = routine.bands.filter((band) => band.kind === 'closed').reduce((sum, band) => sum + band.endMin - band.startMin, 0);
      const description = `${formatDateJa(routine.date)}。記録${routine.markers.length}件、確定した睡眠${Math.round(sleepMinutes / 6) / 10}時間。${routine.bands.some((band) => band.kind === 'open') ? '終了未記録の睡眠あり。' : ''}${routine.bands.some((band) => band.kind === 'conflict') ? '確認待ちの睡眠あり。' : ''}`;
      const label = <><strong>{labelOf ? labelOf(routine.date) : formatDateJa(routine.date)}</strong><span>{routine.markers.length}件のお世話</span>{onRowClick && <CategoryIcon name="chevronRight" size={16} />}</>;
      return <section key={routine.date} className="rec-routine__day" aria-label={description}>
        {onRowClick ? <button type="button" className="rec-routine__date" aria-label={`${formatDateJa(routine.date)}の記録を開く`} onClick={() => onRowClick(routine.date)}>{label}</button> : <div className="rec-routine__date">{label}</div>}
        <RoutineRibbon routine={routine} fromHour={fromHour} toHour={toHour} onMarkerClick={onMarkerClick} />
      </section>;
    })}
  </div>;
}

export function RoutineLegend() {
  return <RibbonLegend />;
}
