import type { ReactNode } from 'react';
import { formatDateJa } from '../../lib/time';
import { MARKER_LABEL } from './logic/describe';
import type { DayRoutine, Marker, MarkerKind } from './logic/routine';

interface Props {
  rows: DayRoutine[];
  /** 表示時間帯（時）。既定 0〜24 */
  fromHour?: number;
  toHour?: number;
  rowHeight?: number;
  onRowClick?: (date: string) => void;
  onMarkerClick?: (eventId: string) => void;
  /** 日付ラベル（既定は M/d） */
  labelOf?: (date: string) => string;
  showAxis?: boolean;
  /** 行ごとの補足（読み上げ用）。睡眠合計など */
  describeRow?: (r: DayRoutine) => string;
}

const W = 360;
const LABEL_W = 46;
const PLOT_W = W - LABEL_W - 6;

interface Glyph { shape: 'circle' | 'square' | 'tri' | 'diamond'; cat: string; ch: string; lane: 0 | 1 }
const GLYPH: Record<MarkerKind, Glyph> = {
  breast: { shape: 'circle', cat: 'feeding', ch: '母', lane: 0 },
  formula: { shape: 'circle', cat: 'feeding', ch: 'ミ', lane: 0 },
  expressed: { shape: 'circle', cat: 'feeding', ch: '搾', lane: 0 },
  pumping: { shape: 'diamond', cat: 'feeding', ch: '搾', lane: 0 },
  urine: { shape: 'square', cat: 'diaper', ch: '尿', lane: 1 },
  stool: { shape: 'square', cat: 'diaper', ch: '便', lane: 1 },
  both: { shape: 'square', cat: 'diaper', ch: '両', lane: 1 },
  diaper_only: { shape: 'square', cat: 'diaper', ch: '替', lane: 1 },
  diaper_unknown: { shape: 'square', cat: 'diaper', ch: '？', lane: 1 },
  vomit: { shape: 'tri', cat: 'vomit', ch: '吐', lane: 1 },
  bath: { shape: 'circle', cat: 'bath', ch: '浴', lane: 1 },
  other: { shape: 'diamond', cat: 'other', ch: '他', lane: 1 },
};

function MarkerShape({ g, x, y, count }: { g: Glyph; x: number; y: number; count: number }) {
  const r = 6.5;
  const fill = `var(--cat-${g.cat}-bg)`;
  const stroke = `var(--cat-${g.cat}-fg)`;
  const common = { fill, stroke, strokeWidth: 1.4 };
  let shape: ReactNode;
  if (g.shape === 'circle') shape = <circle cx={x} cy={y} r={r} {...common} />;
  else if (g.shape === 'square') shape = <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={2} {...common} />;
  else if (g.shape === 'tri') shape = <path d={`M${x} ${y - r - 1} L${x + r + 1} ${y + r} L${x - r - 1} ${y + r} Z`} {...common} />;
  else shape = <path d={`M${x} ${y - r - 1} L${x + r + 1} ${y} L${x} ${y + r + 1} L${x - r - 1} ${y} Z`} {...common} />;
  return (
    <>
      {shape}
      <text x={x} y={y + 3.4} textAnchor="middle" fontSize={count > 1 ? 8 : 8.5} fontWeight={700} fill={stroke}>
        {count > 1 ? count : g.ch}
      </text>
    </>
  );
}

/** 近接する同種マークを件数にまとめる */
function cluster(markers: Marker[], toX: (m: number) => number) {
  const sorted = [...markers].sort((a, b) => a.minute - b.minute);
  const out: { kind: MarkerKind; x: number; ids: string[]; first: Marker }[] = [];
  for (const m of sorted) {
    const x = toX(m.minute);
    const last = [...out].reverse().find((c) => GLYPH[c.kind].lane === GLYPH[m.kind].lane && GLYPH[c.kind].cat === GLYPH[m.kind].cat);
    if (last && x - last.x < 12) last.ids.push(m.eventId);
    else out.push({ kind: m.kind, x, ids: [m.eventId], first: m });
  }
  return out;
}

/** 生活リズム表（SVG自作）。横軸=時刻、縦=日付。色＋形＋文字でカテゴリを区別 */
export function RoutineChart({ rows, fromHour = 0, toHour = 24, rowHeight = 40, onRowClick, onMarkerClick, labelOf, showAxis = true, describeRow }: Props) {
  const span = (toHour - fromHour) * 60;
  const toX = (min: number) => LABEL_W + ((Math.min(Math.max(min, fromHour * 60), toHour * 60) - fromHour * 60) / span) * PLOT_W;
  const top = showAxis ? 16 : 2;
  const H = top + rows.length * rowHeight + 2;
  const ticks: number[] = [];
  const step = toHour - fromHour <= 6 ? 1 : toHour - fromHour <= 12 ? 2 : 6;
  for (let h = fromHour; h <= toHour; h += step) ticks.push(h);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rec-chart" role="group" aria-label="生活リズム表">
      <defs>
        <pattern id="rec-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="transparent" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-border-strong)" strokeWidth="1.5" />
        </pattern>
        <pattern id="rec-hatch-w" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="5" height="5" fill="var(--cat-sleep-bg)" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--cat-vomit-fg)" strokeWidth="1.5" />
        </pattern>
      </defs>
      {showAxis &&
        ticks.map((h) => (
          <text key={h} x={toX(h * 60)} y={11} fontSize={10} textAnchor="middle" fill="var(--color-text-secondary)">
            {h}
          </text>
        ))}
      {rows.map((r, i) => {
        const y = top + i * rowHeight;
        const mid = y + rowHeight / 2;
        const lanes = [y + rowHeight * 0.3, y + rowHeight * 0.72];
        const sleepTotal = r.bands.filter((b) => b.kind === 'closed').reduce((a, b) => a + (b.endMin - b.startMin), 0);
        const hasOpen = r.bands.some((b) => b.kind === 'open');
        const hasConflict = r.bands.some((b) => b.kind === 'conflict');
        const label = labelOf ? labelOf(r.date) : r.date.slice(5).replace('-', '/');
        const aria = describeRow
          ? describeRow(r)
          : `${formatDateJa(r.date)}。記録${r.markers.length}件、確定した睡眠${Math.round(sleepTotal / 60 * 10) / 10}時間${hasOpen ? '、終了未記録の睡眠あり' : ''}${hasConflict ? '、確認待ちの睡眠あり' : ''}。`;
        const clusters = cluster(r.markers, toX);
        return (
          <g key={r.date}>
            <g
              role={onRowClick ? 'button' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={`${aria}${onRowClick ? ' 押すとその日の一覧を開きます' : ''}`}
              onClick={() => onRowClick?.(r.date)}
              onKeyDown={(e) => { if (onRowClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRowClick(r.date); } }}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              <rect x={LABEL_W} y={y + 1} width={PLOT_W} height={rowHeight - 2} rx={(rowHeight - 2) / 2} fill="var(--color-background)" stroke="var(--color-border)" />
              <text x={2} y={mid + 4} fontSize={11} fill="var(--color-text-primary)">{label}</text>
              {ticks.filter((h) => h > fromHour && h < toHour).map((h) => (
                <line key={h} x1={toX(h * 60)} x2={toX(h * 60)} y1={y + 2} y2={y + rowHeight - 2} stroke="var(--color-border)" strokeWidth={1} />
              ))}
              {/* 睡眠の帯 */}
              {r.bands.map((b, k) => {
                const x1 = toX(b.startMin), x2 = toX(b.endMin);
                if (b.endMin <= fromHour * 60 || b.startMin >= toHour * 60 || x2 - x1 < 0.5) return null;
                const props =
                  b.kind === 'closed'
                    ? { fill: 'var(--cat-sleep-fg)', fillOpacity: 0.3, stroke: 'var(--cat-sleep-fg)' }
                    : b.kind === 'open'
                      ? { fill: 'var(--cat-sleep-bg)', stroke: 'var(--cat-sleep-fg)', strokeDasharray: '4 3' }
                      : { fill: 'url(#rec-hatch-w)', stroke: 'var(--cat-vomit-fg)', strokeDasharray: '2 2' };
                return (
                  <g key={`${b.sessionId}-${k}`}>
                    <rect x={x1} y={y + 5} width={Math.max(x2 - x1, 1)} height={rowHeight - 10} rx={(rowHeight - 10) / 2} strokeWidth={1.5} {...props} />
                    {b.kind !== 'closed' && x2 - x1 > 34 && (
                      <text x={(x1 + x2) / 2} y={mid + 3.5} fontSize={9.5} textAnchor="middle" fill="var(--color-text-primary)" fontWeight={700}>
                        {b.kind === 'open' ? '未終了' : '確認待ち'}
                      </text>
                    )}
                  </g>
                );
              })}
              {/* 未到来 */}
              {r.nowMin < 1440 && toX(r.nowMin) < LABEL_W + PLOT_W && (
                <rect x={toX(r.nowMin)} y={y + 1} width={LABEL_W + PLOT_W - toX(r.nowMin)} height={rowHeight - 2} fill="url(#rec-hatch)" opacity={0.35}>
                  <title>まだ来ていない時間</title>
                </rect>
              )}
              {/* マーク */}
              {clusters.map((c) => {
                const m = c.first;
                if (m.minute < fromHour * 60 || m.minute > toHour * 60) return null;
                const g = GLYPH[c.kind];
                return (
                  <g
                    key={c.ids[0]}
                    onClick={(ev) => {
                      if (!onMarkerClick) return;
                      ev.stopPropagation();
                      onMarkerClick(c.ids[0]);
                    }}
                  >
                    <title>{`${MARKER_LABEL[c.kind]}${c.ids.length > 1 ? ` ほか${c.ids.length}件` : ''}`}</title>
                    <MarkerShape g={g} x={c.x} y={lanes[g.lane]} count={c.ids.length} />
                  </g>
                );
              })}
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/** 凡例（色＋形＋文字） */
export function RoutineLegend() {
  const items: { k: MarkerKind; t: string }[] = [
    { k: 'breast', t: '母乳' }, { k: 'formula', t: 'ミルク' }, { k: 'expressed', t: '搾母乳' }, { k: 'pumping', t: '搾乳' },
    { k: 'urine', t: '尿' }, { k: 'stool', t: '便' }, { k: 'both', t: '尿+便' }, { k: 'diaper_only', t: '交換のみ' }, { k: 'diaper_unknown', t: '未確認' },
    { k: 'vomit', t: '吐いた' }, { k: 'bath', t: '沐浴' }, { k: 'other', t: 'その他' },
  ];
  return (
    <div className="rec-legend small" aria-label="凡例">
      <span className="rec-legend__item"><span className="rec-legend__sleep" />睡眠</span>
      <span className="rec-legend__item"><span className="rec-legend__sleep rec-legend__sleep--open" />未終了</span>
      <span className="rec-legend__item"><span className="rec-legend__sleep rec-legend__sleep--conf" />確認待ち</span>
      {items.map(({ k, t }) => (
        <span key={k} className="rec-legend__item">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><MarkerShape g={GLYPH[k]} x={8} y={8} count={1} /></svg>
          {t}
        </span>
      ))}
    </div>
  );
}
