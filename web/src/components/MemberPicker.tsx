import { useFamily } from '../context';

interface Props {
  /** 選択中の uid。null＝実施者未確認 */
  value: string | null;
  onChange: (uid: string | null) => void;
  label?: string;
  /** 「実施者未確認」を選択肢に含める（既定 true） */
  includeUnknown?: boolean;
}

/** 実施者などのメンバー選択（有効メンバー＋未確認） */
export function MemberPicker({ value, onChange, label = '実施者', includeUnknown = true }: Props) {
  const { activeMembers } = useFamily();
  const items: { uid: string | null; name: string }[] = [
    ...activeMembers.map((m) => ({ uid: m.uid, name: m.displayName })),
    ...(includeUnknown ? [{ uid: null, name: '実施者未確認' }] : []),
  ];
  return (
    <div className="ch-seg" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.uid ?? 'unknown'}
          type="button"
          role="radio"
          aria-checked={it.uid === value}
          className={`ch-seg__item${it.uid === value ? ' is-active' : ''}`}
          onClick={() => onChange(it.uid)}
        >
          {it.name}
        </button>
      ))}
    </div>
  );
}
