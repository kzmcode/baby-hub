import type { ReactNode } from 'react';
import { CategoryIcon, type CategoryName } from './CategoryIcon';

interface Props {
  category: CategoryName;
  label: string;
  /** 補助表示（最終時刻など） */
  sublabel?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}

/** 記録ボタン等のカテゴリタイル（高さ 72px 以上、文字併記、カテゴリ色） */
export function CategoryTile({ category, label, sublabel, onClick, active, disabled }: Props) {
  return (
    <button
      type="button"
      className={`ch-tile${active ? ' is-active' : ''}`}
      style={{ background: `var(--cat-${category}-bg)` }}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      <span style={{ color: `var(--cat-${category}-fg)`, display: 'inline-flex' }}><CategoryIcon name={category} size={34} strokeWidth={1.7} /></span>
      <span className="ch-tile__text">
        <span className="ch-tile__label">{label}</span>
        {sublabel && <span className="ch-tile__sub">{sublabel}</span>}
      </span>
    </button>
  );
}
