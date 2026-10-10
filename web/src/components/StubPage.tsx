import { EmptyState } from './EmptyState';

/** 機能担当が置き換えるまでの仮ページ */
export function StubPage({ name }: { name: string }) {
  return (
    <div className="page">
      <EmptyState title="準備中です" description={name} />
    </div>
  );
}
