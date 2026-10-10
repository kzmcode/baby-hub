import type { HTMLAttributes } from 'react';

interface Props extends HTMLAttributes<HTMLDivElement> {
  /** handover=淡いアプリコット / warning=確認が必要 / danger=失敗など */
  tone?: 'default' | 'handover' | 'warning' | 'danger';
}

export function Card({ tone = 'default', className = '', ...rest }: Props) {
  return <div className={`ch-card ch-card--${tone} ${className}`} {...rest} />;
}
