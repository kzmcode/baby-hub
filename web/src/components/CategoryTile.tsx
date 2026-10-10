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
  icon?: 'sun' | 'alert';
}

/** 記録ボタン等のカテゴリタイル（高さ 72px 以上、文字併記、カテゴリ色） */
export function CategoryTile({ category, label, sublabel, onClick, active, disabled, icon }: Props) {
  return (
    <button
      type="button"
      className={`ch-tile ch-tile--${icon === 'sun' ? 'wake' : category}${active ? ' is-active' : ''}`}
      style={{ background: `var(--cat-${icon === 'sun' ? 'wake' : category}-bg)` }}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      <span className="ch-tile__icon" style={{ color: `var(--cat-${icon === 'sun' ? 'wake' : category}-fg)` }}><CategoryIcon name={icon ?? category} size={42} strokeWidth={1.5} /></span>
      <span className="ch-tile__text">
        <span className="ch-tile__label">{label}</span>
        {sublabel && <span className="ch-tile__sub">{sublabel}</span>}
      </span>
    </button>
  );
}
