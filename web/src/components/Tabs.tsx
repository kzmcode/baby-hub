import type { ReactNode } from 'react';

export interface TabItem<K extends string = string> {
  key: K;
  label: string;
  /** 件数バッジなど */
  badge?: ReactNode;
}

interface Props<K extends string> {
  tabs: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  ariaLabel?: string;
}

export function Tabs<K extends string>({ tabs, value, onChange, ariaLabel }: Props<K>) {
  return (
    <div className="ch-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          className={`ch-tab${t.key === value ? ' is-active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.badge != null && <span className="ch-tab__badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
