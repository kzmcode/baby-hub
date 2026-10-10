import { Link } from 'react-router-dom';
import { RibbonLegend, RoutineRibbon } from './RoutineRibbon';
import type { DayRoutine } from './logic/routine';

export function HomeRhythm({ routine }: { routine: DayRoutine }) {
  const open = routine.bands.some((band) => band.kind === 'open');
  const conflict = routine.bands.some((band) => band.kind === 'conflict');
  return <>
    <Link to={`/records?date=${routine.date}&view=day`} className="rec-rhythm" aria-label={`今日の記録を開く。お世話の記録${routine.markers.length}件。${open ? '終了未記録の睡眠あり。' : ''}${conflict ? '確認待ちの睡眠あり。' : ''}`}>
      <RoutineRibbon routine={routine} />
    </Link>
    <RibbonLegend compact />
    {conflict && <span className="small rec-warn-text">斜線：睡眠を確認</span>}
  </>;
}
