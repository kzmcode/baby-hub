import type { ReactElement, SVGProps } from 'react';

export type CategoryName =
  | 'diaper' | 'feeding' | 'vomit' | 'sleep' | 'bath' | 'other'
  | 'temperature' | 'medication' | 'growth' | 'schedule' | 'task' | 'shopping' | 'handover';

/** UI 用の汎用アイコン名（ナビ・操作） */
export type UiIconName =
  | 'home' | 'records' | 'plans' | 'health' | 'more' | 'family' | 'settings'
  | 'plus' | 'check' | 'chevronLeft' | 'chevronRight' | 'chevronUp' | 'chevronDown' | 'close' | 'sun' | 'alert' | 'cloudOff' | 'cloud' | 'info';

// 24x24 の丸みのある線画。stroke=currentColor
const PATHS: Record<CategoryName | UiIconName, ReactElement> = {
  diaper: <><path d="M5 4h14a2 2 0 0 1 2 2v5c0 5-4 9-9 10-5-1-9-5-9-10V6a2 2 0 0 1 2-2Z" /><path d="M3 8h4v3H3m18-3h-4v3h4M4 14c4-1 6 2 6 6m10-6c-4-1-6 2-6 6M8 4h8" /></>,
  feeding: <g transform="rotate(25 12 12)"><path d="M10 5V3a2 2 0 0 1 4 0v2M9 5h6v3H9zM9 8l-2 3v8a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-8l-2-3" /><path d="M8 12h3M8 15h2M8 18h3" /></g>,
  vomit: <><path d="M9 8c-4-1-7 2-6 6s7 2 10 6c2 3 6 1 5-2-1-3-5-4-5-7 0-2-2-3-4-3Z" /><path d="M18 8c0-3 4-5 4-2s-3 4-4 2Z" /><circle cx="14" cy="3" r="1.4" /></>,
  sleep: <path d="M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11Z" />,
  bath: <><path d="M2 12h20M3 12l1 4a5 5 0 0 0 5 4h6a5 5 0 0 0 5-4l1-4M7 20l-1 2M17 20l1 2" /><circle cx="6" cy="8" r="1.4" /><circle cx="11" cy="3.5" r="1.8" /><circle cx="18" cy="7" r="2.2" /></>,
  other: <><circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" /></>,
  temperature: <><path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z" /><path d="M12 9v7" /></>,
  medication: <><rect x="3" y="9" width="18" height="7" rx="3.5" transform="rotate(-35 12 12.5)" /><path d="M9.2 8.6l5.6 7.8" /></>,
  growth: <><path d="M4 20V4M4 20h16" /><path d="M7 16l4-4 3 2 5-6" /><path d="M16 8h3v3" /></>,
  schedule: <><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 3v4M16 3v4M4 10h16" /></>,
  task: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8 12l3 3 5-6" /></>,
  shopping: <><path d="M5 8h14l-1 11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 8z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>,
  handover: <><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" /><path d="M8 10h8M8 13h5" /></>,
  home: <><path d="M4 11l8-7 8 7" /><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" /><path d="M10 20v-5h4v5" /></>,
  records: <><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  plans: <><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 3v4M16 3v4M4 10h16M9 15l2 2 4-4" /></>,
  health: <><path d="M12 20s-8-4.8-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.2 12 20 12 20z" /></>,
  more: <><circle cx="6" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18" cy="12" r="1.7" /></>,
  family: <><circle cx="9" cy="6" r="3.5" /><path d="M2 21v-3a7 7 0 0 1 11-5.7" /><circle cx="17" cy="10" r="3" /><path d="M12 21v-3a5 5 0 0 1 10 0v3H2" /></>,
  settings: <><path d="m9 3 1-1h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1V3Z" transform="translate(0 0) scale(.95)" /><circle cx="12" cy="12" r="3.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chevronLeft: <path d="M15 5l-7 7 7 7" />,
  chevronRight: <path d="M9 5l7 7-7 7" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sun: <><circle cx="12" cy="12" r="6" /><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l1.4 1.4M18.6 18.6 20 20M4 20l1.4-1.4M18.6 5.4 20 4M9 11l.5.5.5-.5m4 0 .5.5.5-.5M11 15c.5-.5 1.5-.5 2 0" /></>,
  alert: <><path d="M12 4l9 16H3L12 4z" /><path d="M12 10v4M12 17.2v.1" /></>,
  cloudOff: <><path d="M7 18a4 4 0 0 1-.6-7.9A6 6 0 0 1 17.5 9 4.5 4.5 0 0 1 17 18H7z" /><path d="M4 4l16 16" /></>,
  cloud: <path d="M7 18a4 4 0 0 1-.6-7.9A6 6 0 0 1 17.5 9 4.5 4.5 0 0 1 17 18H7z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.8v.1" /></>,
};

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: CategoryName | UiIconName;
  size?: number;
  /** スクリーンリーダー向けラベル。省略時は装飾扱い（aria-hidden） */
  title?: string;
}

export function CategoryIcon({ name, size = 24, title, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
