import { useId } from 'react';
import { CategoryIcon, type CategoryName } from '../../components';
import { MARKER_LABEL } from './logic/describe';
import { layoutRibbonMarkers, ribbonX } from './logic/ribbon';
import type { DayRoutine } from './logic/routine';

interface Props {
  routine: DayRoutine;
  fromHour?: number;
  toHour?: number;
  onMarkerClick?: (eventId: string) => void;
}

/** Shared by home and records: the bar, marker lanes and time axis scale together. */
export function RoutineRibbon({ routine, fromHour = 0, toHour = 24, onMarkerClick }: Props) {
  const hatchId = useId().replace(/:/g, '');
  const x = (minute: number) => ribbonX(minute, fromHour, toHour);
  const ticks: number[] = [];
  const step = toHour - fromHour <= 6 ? 1 : 6;
  for (let hour = fromHour; hour <= toHour; hour += step) ticks.push(hour);
  const markers = layoutRibbonMarkers(routine.markers, fromHour, toHour);

  return (
    <svg className="rec-ribbon" viewBox="0 0 360 100" role={onMarkerClick ? 'group' : undefined} aria-label={onMarkerClick ? `${fromHour}時から${toHour}時の記録` : undefined} aria-hidden={onMarkerClick ? undefined : true}>
      <defs>
        <pattern id={hatchId} width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="5" height="5" fill="var(--cat-sleep-bg)" />
          <line x1="0" x2="0" y1="0" y2="5" stroke="var(--cat-vomit-fg)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="12" y="50" width="336" height="20" rx="10" fill="var(--color-border)" fillOpacity="0.55" />
      {ticks.slice(1, -1).map((hour) => <line key={hour} x1={x(hour * 60)} x2={x(hour * 60)} y1="50" y2="70" stroke="var(--color-surface)" strokeWidth="2" />)}
      {routine.bands.map((band, index) => {
        if (band.endMin <= fromHour * 60 || band.startMin >= toHour * 60) return null;
        const width = x(band.endMin) - x(band.startMin);
        if (width <= 0) return null;
        return <g key={`${band.sessionId}-${index}`}>
          <title>{band.kind === 'closed' ? '睡眠' : band.kind === 'open' ? '終了未記録の睡眠' : '確認待ちの睡眠'}</title>
          <rect x={x(band.startMin)} y="50" width={width} height="20" rx="10" fill={band.kind === 'conflict' ? `url(#${hatchId})` : 'var(--cat-sleep-bg)'} stroke={band.kind === 'closed' ? 'none' : 'var(--cat-sleep-fg)'} strokeDasharray={band.kind === 'closed' ? undefined : '3 3'} />
          {width > 22 && <g transform={`translate(${x(band.startMin) + width / 2 - 7} 53)`} color="var(--cat-sleep-fg)"><CategoryIcon name="sleep" size={14} /></g>}
        </g>;
      })}
      <rect x={x(routine.nowMin)} y="50" width={348 - x(routine.nowMin)} height="20" fill="var(--color-surface)" fillOpacity="0.7" />
      {markers.map((marker) => {
        const y = marker.lane === 0 ? 12 : 35;
        const first = marker.events[0];
        const time = `${Math.floor(first.minute / 60)}:${String(Math.floor(first.minute % 60)).padStart(2, '0')}`;
        const label = `${time} ${MARKER_LABEL[first.kind]}${marker.events.length > 1 ? `、ほか${marker.events.length - 1}件` : ''}。記録の詳細を開く`;
        return <g key={first.eventId} className={onMarkerClick ? 'rec-ribbon__marker' : undefined} role={onMarkerClick ? 'button' : undefined} tabIndex={onMarkerClick ? 0 : undefined} aria-label={onMarkerClick ? label : undefined}
          onClick={onMarkerClick ? () => onMarkerClick(first.eventId) : undefined}
          onKeyDown={(event) => { if (onMarkerClick && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onMarkerClick(first.eventId); } }}>
          <title>{marker.events.map((event) => MARKER_LABEL[event.kind]).join('、')}</title>
          <line x1={marker.x} x2={marker.x} y1={y + 10} y2="68" stroke={`var(--cat-${marker.category}-fg)`} strokeOpacity="0.4" />
          <circle cx={marker.x} cy={y} r="10" fill={`var(--cat-${marker.category}-bg)`} />
          <g transform={`translate(${marker.x - 8} ${y - 8})`} color={`var(--cat-${marker.category}-fg)`}><CategoryIcon name={marker.category} size={16} strokeWidth={1.5} /></g>
          {marker.events.length > 1 && <text x={marker.x + 7} y={y - 7} fontSize="8" fontWeight="600" fill="var(--color-text-primary)" stroke="var(--color-surface)" strokeWidth="3" paintOrder="stroke">{marker.events.length}</text>}
        </g>;
      })}
      {ticks.map((hour) => <g key={hour}>
        <line x1={x(hour * 60)} x2={x(hour * 60)} y1="73" y2="78" stroke="var(--color-text-secondary)" strokeOpacity="0.5" />
        <text x={x(hour * 60)} y="92" textAnchor="middle" fontSize="13" fill="var(--color-text-secondary)">{hour}</text>
      </g>)}
    </svg>
  );
}

const CATEGORIES: { category: CategoryName; label: string }[] = [
  { category: 'sleep', label: '睡眠' }, { category: 'feeding', label: '授乳・ミルク' }, { category: 'diaper', label: 'おむつ' },
  { category: 'vomit', label: '吐いた' }, { category: 'bath', label: '沐浴' }, { category: 'other', label: 'その他' },
];

export function RibbonLegend({ compact = false }: { compact?: boolean }) {
  return <div className="rec-ribbon-legend" aria-label="リズムの凡例">
    {(compact ? CATEGORIES.slice(0, 3) : CATEGORIES).map(({ category, label }) => <span key={category}>
      <i style={{ background: `var(--cat-${category}-bg)`, borderColor: `var(--cat-${category}-fg)` }} />{label}
    </span>)}
  </div>;
}
