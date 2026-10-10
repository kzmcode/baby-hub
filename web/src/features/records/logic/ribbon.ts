import type { CategoryName } from '../../../components';
import type { Marker, MarkerKind } from './routine';

export function ribbonCategory(kind: MarkerKind): CategoryName {
  if (['breast', 'formula', 'expressed', 'pumping'].includes(kind)) return 'feeding';
  if (['urine', 'stool', 'both', 'diaper_only', 'diaper_unknown'].includes(kind)) return 'diaper';
  return kind === 'vomit' || kind === 'bath' ? kind : 'other';
}

export function ribbonX(minute: number, fromHour = 0, toHour = 24): number {
  const start = fromHour * 60;
  const end = toHour * 60;
  return 12 + (Math.max(start, Math.min(end, minute)) - start) / (end - start) * 336;
}

interface RibbonMarker {
  x: number;
  lane: 0 | 1;
  category: CategoryName;
  events: Marker[];
}

/** Filter before clustering so events outside a zoom cannot hide its first marker. */
export function layoutRibbonMarkers(markers: Marker[], fromHour = 0, toHour = 24): RibbonMarker[] {
  const visible = markers.filter((marker) => marker.minute >= fromHour * 60 && marker.minute < toHour * 60);
  const out: RibbonMarker[] = [];
  for (const marker of [...visible].sort((a, b) => a.minute - b.minute)) {
    const category = ribbonCategory(marker.kind);
    const lane = category === 'feeding' ? 0 : 1;
    const x = ribbonX(marker.minute, fromHour, toHour);
    const previous = [...out].reverse().find((item) => item.lane === lane);
    if (previous && x - previous.x < 24) previous.events.push(marker);
    else out.push({ x, lane, category, events: [marker] });
  }
  return out;
}
