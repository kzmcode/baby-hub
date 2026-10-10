import type { ReactNode } from 'react';
import { CategoryIcon, type CategoryName, type UiIconName } from './CategoryIcon';

interface Props {
  title: string;
  description?: string;
  icon?: CategoryName | UiIconName;
  /** 入力導線（Button など） */
  action?: ReactNode;
}

export function EmptyState({ title, description, icon = 'info', action }: Props) {
  return (
    <div className="ch-empty">
      <CategoryIcon name={icon} size={32} />
      <p className="ch-empty__title">{title}</p>
      {description && <p className="muted small">{description}</p>}
      {action}
    </div>
  );
}
