import { describe, expect, it } from 'vitest';
import { layoutRibbonMarkers, ribbonX } from './ribbon';
import type { Marker } from './routine';

describe('ribbon markers', () => {
  it('does not let an event outside the zoom absorb the first visible event', () => {
    const events: Marker[] = [
      { eventId: 'before', minute: 719, kind: 'formula' },
      { eventId: 'visible', minute: 720, kind: 'formula' },
      { eventId: 'after', minute: 1080, kind: 'formula' },
    ];
    expect(layoutRibbonMarkers(events, 12, 18).map((marker) => marker.events.map((event) => event.eventId))).toEqual([['visible']]);
  });

  it('groups colliding events in each lane while keeping every event and its kind', () => {
    const events: Marker[] = [
      { eventId: 'feed-1', minute: 600, kind: 'formula' },
      { eventId: 'diaper', minute: 600, kind: 'urine' },
      { eventId: 'bath', minute: 601, kind: 'bath' },
      { eventId: 'feed-2', minute: 602, kind: 'breast' },
      { eventId: 'other', minute: 1000, kind: 'other' },
    ];
    const result = layoutRibbonMarkers(events);
    expect(result).toHaveLength(3);
    expect(result[0].events.map((event) => event.eventId)).toEqual(['feed-1', 'feed-2']);
    expect(result[1].events.map((event) => event.kind)).toEqual(['urine', 'bath']);
    expect(result.flatMap((marker) => marker.events).map((event) => event.eventId).sort()).toEqual(events.map((event) => event.eventId).sort());
    for (const lane of [0, 1]) {
      const markers = result.filter((marker) => marker.lane === lane);
      for (let i = 1; i < markers.length; i++) expect(markers[i].x - markers[i - 1].x).toBeGreaterThanOrEqual(24);
    }
  });

  it('clips bands and future time to the same endpoints as the zoomed axis', () => {
    expect(ribbonX(0, 12, 18)).toBe(12);
    expect(ribbonX(720, 12, 18)).toBe(12);
    expect(ribbonX(900, 12, 18)).toBe(180);
    expect(ribbonX(1440, 12, 18)).toBe(348);
  });
});
