import { Link } from 'react-router-dom';
import { useAuth, useFamily } from '../../context';
import { Card } from '../../components';
import { loadInvite } from './util';
import './account.css';

const ITEMS: { to: string; title: string; sub: string }[] = [
  { to: 'family', title: '家族', sub: 'メンバー・招待・退出' },
  { to: 'children', title: '子ども', sub: '呼び名・出生日・予定日' },
  { to: 'display', title: '表示設定', sub: 'テーマ・ホームの項目・記録ボタン' },
  { to: 'notifications', title: '通知', sub: '種類・静穏時間・この端末の許可' },
  { to: 'device', title: 'この端末', sub: 'オフライン保存・同期・ログイン方法' },
  { to: 'export', title: 'データ出力', sub: 'JSON / CSV' },
  { to: 'contacts', title: '連絡先・参考先', sub: 'かかりつけ・自治体など' },
  { to: 'account', title: 'アカウント・削除', sub: 'ログアウト・削除' },
  { to: 'about', title: 'アプリ情報', sub: 'バージョン・プライバシー' },
];

/** S11 その他・設定（メニュー） */
export function MorePage() {
  const { user } = useAuth();
  const { family, role, child } = useFamily();
  const pendingInvite = role === 'owner' ? loadInvite() : null;
  return (
    <main className="page stack">
      <h1>設定</h1>
      <Card>
        <p><strong>{family?.name}</strong>{child ? `・${child.nickname}` : ''}{child?.isSample && <> <span className="acc-badge">練習データ</span></>}</p>
        <p className="small muted">{user?.email ?? user?.displayName}・{role === 'owner' ? '管理者' : 'メンバー'}</p>
      </Card>
      {pendingInvite && (
        <Card tone="handover"><Link to="family">招待リンクがまだ有効です。家族画面で相手に渡せます。</Link></Card>
      )}
      <nav className="acc-menu" aria-label="設定メニュー">
        {ITEMS.map((i) => (
          <Link key={i.to} to={i.to} className="acc-menu__item">
            <span>{i.title}<small>{i.sub}</small></span><span aria-hidden="true">›</span>
          </Link>
        ))}
      </nav>
    </main>
  );
}
