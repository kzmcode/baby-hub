import { Link, Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { SyncBadge } from './SyncBadge';
import { CategoryIcon } from './CategoryIcon';
import { Logo } from './Logo';
import { useAuth, useFamily } from '../context';
import { useSyncStatus } from '../lib/sync';
import { formatAge } from '../lib/time';
import { useScrollRestoration } from './useScrollRestoration';

/** 上部バー（アプリ名・子ども・共有状態）＋本文＋下部ナビ。セーフエリア対応 */
export function AppShell() {
  const { child, family } = useFamily();
  const { user } = useAuth();
  const pt = family?.pendingOwnerTransfer;
  const transferForMe = !!pt && pt.toUid === user?.uid && pt.expiresAt.toMillis() > Date.now();
  const { online, pendingWrites, lastSyncedAt } = useSyncStatus();
  useScrollRestoration();

  const state = pendingWrites ? 'pending' : online ? 'synced' : 'cache';
  const age = formatAge(child?.birthDate);
  return (
    <div className="ch-shell">
      <header className="ch-topbar">
        <div className="ch-brand">
          <Logo size={44} />
          <div className="ch-topbar__title">
            <strong className="ch-topbar__name">Baby hub</strong>
            <span className="ch-topbar__sub">{child ? `${child.nickname}${age ? `（${age}）` : ''}` : 'つながる、育てる、毎日を。'}</span>
          </div>
        </div>
        <SyncBadge state={state} lastSyncedAt={lastSyncedAt} />
      </header>
      {!online && (
        <div className="ch-offline" role="status">
          <CategoryIcon name="cloudOff" size={18} />
          オフラインです。記録は端末に保存され、接続後に共有されます。
        </div>
      )}
      {transferForMe && (
        <Link to="/more/family" className="ch-offline" role="status">管理者の移譲が提案されています。タップして確認</Link>
      )}
      <main className="ch-main">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
