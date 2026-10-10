import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface ToastOptions {
  /** 「戻す」など。押すとトーストを閉じて onClick を実行 */
  action?: { label: string; onClick: () => void };
  /** 表示ミリ秒（既定 5000、action 付きは 8000。0 で自動消去しない） */
  duration?: number;
  tone?: 'default' | 'error';
}
interface ToastItem extends ToastOptions { id: number; message: string }
interface ToastApi {
  show(message: string, options?: ToastOptions): number;
  dismiss(id: number): void;
}
const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = ++seq.current;
      setItems((l) => [...l.slice(-2), { id, message, ...options }]);
      const d = options.duration ?? (options.action ? 8000 : 5000);
      if (d > 0) setTimeout(() => dismiss(id), d);
      return id;
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="ch-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`ch-toast${t.tone === 'error' ? ' ch-toast--error' : ''}`}>
            <span>{t.message}</span>
            {t.action && (
              <button type="button" className="ch-toast__action" onClick={() => { dismiss(t.id); t.action!.onClick(); }}>
                {t.action.label}
              </button>
            )}
            <button type="button" className="ch-toast__close" onClick={() => dismiss(t.id)} aria-label="閉じる">閉じる</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('ToastProvider が必要です');
  return v;
}
