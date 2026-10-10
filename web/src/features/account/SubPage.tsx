import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './account.css';

export function SubPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page stack">
      <div className="acc-sub">
        <Link to="/more" className="acc-back" aria-label="その他に戻る">‹ その他</Link>
      </div>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
