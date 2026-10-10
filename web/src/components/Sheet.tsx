import { useEffect, useRef, type ReactNode } from 'react';
import { CategoryIcon } from './CategoryIcon';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** 下部固定の操作領域（保存ボタンなど） */
  footer?: ReactNode;
}

/** 下から出るモーダル。Esc／背景タップ／閉じるボタンで閉じる。開いている間は背景スクロールを止める */
export function Sheet({ open, onClose, title, children, footer }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && panel.current) {
        const f = panel.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (f.length === 0) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      (prevFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="ch-sheet__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ch-sheet" role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}>
        <div className="ch-sheet__head">
          <h2>{title}</h2>
          <button type="button" className="ch-iconbtn" onClick={onClose} aria-label="閉じる">
            <CategoryIcon name="close" />
          </button>
        </div>
        <div className="ch-sheet__body">{children}</div>
        {footer && <div className="ch-sheet__foot">{footer}</div>}
      </div>
    </div>
  );
}
