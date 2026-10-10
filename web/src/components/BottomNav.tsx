import { NavLink } from 'react-router-dom';
import { CategoryIcon, type UiIconName } from './CategoryIcon';

const ITEMS: { to: string; label: string; icon: UiIconName; end?: boolean }[] = [
  { to: '/', label: '今日', icon: 'home', end: true },
  { to: '/records', label: '記録', icon: 'records' },
  { to: '/plans', label: '予定・用事', icon: 'plans' },
  { to: '/health', label: '健康', icon: 'health' },
  { to: '/more', label: 'その他', icon: 'more' },
];

/** 下部ナビ 5 項目（固定・セーフエリア対応）。アイコン＋文字 */
export function BottomNav() {
  return (
    <nav className="ch-nav" aria-label="メインメニュー">
      {ITEMS.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `ch-nav__item${isActive ? ' is-active' : ''}`}>
          <CategoryIcon name={it.icon} size={24} />
          <span>{it.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
