import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  block?: boolean;
  loading?: boolean;
}

/** 文字付きボタン（最小 48px）。primary は強い操作（確定）用 */
export function Button({ variant = 'secondary', block, loading, className = '', children, disabled, type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      className={`ch-btn ch-btn--${variant}${block ? ' ch-btn--block' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? '処理中…' : children}
    </button>
  );
}
