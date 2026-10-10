import { Card } from '../../components';
import { formatDuration } from '../../lib/time';
import type { DailySummary } from './logic/aggregate';

/** 当日の基本集計。量未入力は合計から除外して件数を併記、搾乳は別、睡眠は確定と未終了を分ける */
export function SummaryCard({ s, title = '当日の集計' }: { s: DailySummary; title?: string }) {
  const feedTotal = s.breastCount + s.formulaCount + s.expressedCount;
  return (
    <Card aria-label={title}>
      <h2 className="rec-h2">{title}</h2>
      <dl className="rec-sum">
        <dt>哺乳</dt>
        <dd>
          {feedTotal}回（母乳 {s.breastCount} / ミルク {s.formulaCount} / 搾母乳 {s.expressedCount}）
          <br />
          ミルク・搾母乳の量 <strong className="num">{s.milkMl}mL</strong>
          {s.milkUnknownCount > 0 && <span className="muted">（量未入力 {s.milkUnknownCount}件は含まず）</span>}
        </dd>
        <dt>搾乳</dt>
        <dd>
          {s.pumpingCount}回 {s.pumpingMl > 0 && <span className="num">{s.pumpingMl}mL</span>}
          {s.pumpingUnknownCount > 0 && <span className="muted">（量未入力 {s.pumpingUnknownCount}件）</span>}
          <span className="muted small"> ※哺乳量には加えません</span>
        </dd>
        <dt>おむつ</dt>
        <dd>
          交換 {s.diaperCount}回 ・ 尿 {s.urineCount}回 ・ 便 {s.stoolCount}回
          {s.diaperUnknownCount > 0 && <span className="muted">（尿便が未確認 {s.diaperUnknownCount}件）</span>}
        </dd>
        <dt>睡眠</dt>
        <dd>
          確定 <strong className="num">{formatDuration(s.sleepConfirmedSeconds)}</strong>
          {s.sleepOpenSeconds > 0 && <span>　＋ 終了未記録 {formatDuration(s.sleepOpenSeconds)}（暫定・別枠）</span>}
          {s.sleepConflictCount > 0 && <span className="rec-warn-text">　確認待ち {s.sleepConflictCount}件</span>}
        </dd>
        <dt>吐いた</dt><dd>{s.vomitCount}回</dd>
        <dt>沐浴</dt><dd>{s.bathCount}回</dd>
        <dt>その他</dt><dd>{s.otherCount}件</dd>
      </dl>
      <p className="small muted">記録された内容の集計です。未記録の時間は含まれません。</p>
    </Card>
  );
}
