import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { CategoryIcon, type UiIconName } from './CategoryIcon';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  /** 任意項目の表示 */
  optional?: boolean;
  /** 子の input に付ける id を受け取る render prop、または通常の子要素 */
  children: ReactNode | ((p: { id: string; describedBy?: string; invalid: boolean }) => ReactNode);
}

/** ラベル＋入力欄＋ヒント／エラーの組。children に関数を渡すと id/aria を受け取れる */
export function Field({ label, hint, error, optional, children }: FieldProps) {
  const id = useId();
  const descId = hint || error ? `${id}-d` : undefined;
  return (
    <div className="ch-field">
      <label htmlFor={id} className="ch-field__label">
        {label}
        {optional && <span className="muted small">（任意）</span>}
      </label>
      {typeof children === 'function' ? children({ id, describedBy: descId, invalid: !!error }) : children}
      {(hint || error) && (
        <div id={descId} className={`small ${error ? 'ch-field__error' : 'muted'}`} role={error ? 'alert' : undefined}>
          {error ?? hint}
        </div>
      )}
    </div>
  );
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`ch-input ${className}`} {...rest} />;
}

export function TextArea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`ch-input ch-textarea ${className}`} {...rest} />;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options: { value: string; label: string }[];
  onChange?: (value: string) => void;
}
export function Select({ options, onChange, className = '', ...rest }: SelectProps) {
  return (
    <span className="ch-select-wrap">
      <select className={`ch-input ch-select ${className}`} onChange={(e) => onChange?.(e.target.value)} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {!rest.multiple && !(rest.size && rest.size > 1) && <CategoryIcon className="ch-select-arrow" name="chevronDown" size={20} />}
    </span>
  );
}

interface SegProps<V extends string> {
  options: { value: V; label: string; icon?: UiIconName }[];
  value: V;
  onChange: (v: V) => void;
  ariaLabel: string;
}
/** 排他選択（ラジオ相当）。文字付きで色だけに依存しない */
export function SegmentedControl<V extends string>({ options, value, onChange, ariaLabel }: SegProps<V>) {
  return (
    <div className="ch-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`ch-seg__item${o.value === value ? ' is-active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.value === value && <CategoryIcon name="check" size={16} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
