import { useUserSettings } from '../../context';
import { Button, Card, SegmentedControl, useToast } from '../../components';
import type { HomeItemKey, QuickRecordKey, UserSettings } from '../../types/models';
import { SubPage } from './SubPage';

const HOME_LABEL: Record<HomeItemKey, string> = {
  status: '状態（最後の哺乳・おむつ・睡眠）', quickRecord: '記録ボタン', todayRhythm: '今日の生活リズム',
  recent: '最近の記録', handovers: '申し送り', todayPlans: '今日の予定・用事', shopping: '買い物',
};
const QUICK_LABEL: Record<QuickRecordKey, string> = {
  diaper: 'おむつ', feeding: '哺乳', vomit: '吐いた', sleep: '睡眠', bath: '沐浴', other: 'その他・赤ちゃんの変化',
};

export function DisplaySection() {
  const { settings, update } = useUserSettings();
  const toast = useToast();
  const save = (p: Partial<UserSettings>) => update(p).catch(() => toast.show('保存できませんでした。', { tone: 'error' }));

  const move = (i: number, d: -1 | 1) => {
    const items = [...settings.homeItems];
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    save({ homeItems: items });
  };
  const toggleItem = (i: number) => save({ homeItems: settings.homeItems.map((h, k) => (k === i ? { ...h, visible: !h.visible } : h)) });
  const toggleQuick = (k: QuickRecordKey) => {
    const has = settings.quickRecordTypes.includes(k);
    const order = Object.keys(QUICK_LABEL) as QuickRecordKey[];
    const next = has ? settings.quickRecordTypes.filter((x) => x !== k) : order.filter((x) => x === k || settings.quickRecordTypes.includes(x));
    save({ quickRecordTypes: next });
  };

  return (
    <SubPage title="表示設定">
      <Card className="stack">
        <h2>テーマ</h2>
        <SegmentedControl<UserSettings['theme']>
          ariaLabel="テーマ"
          options={[{ value: 'system', label: '端末に合わせる' }, { value: 'light', label: '明るい' }, { value: 'dark', label: '暗い（夜間）' }]}
          value={settings.theme} onChange={(theme) => save({ theme })}
        />
      </Card>
      <Card className="stack">
        <h2>ホームの項目</h2>
        <p className="small muted">使わない項目は非表示にできます。上下ボタンで順序を変えます（この設定はあなたの端末・アカウントだけに適用されます）。</p>
        <ul className="acc-list">
          {settings.homeItems.map((h, i) => (
            <li key={h.key}>
              <label className="acc-check">
                <input type="checkbox" checked={h.visible} onChange={() => toggleItem(i)} />
                <span>{HOME_LABEL[h.key]}</span>
              </label>
              <span className="row">
                <Button aria-label={`${HOME_LABEL[h.key]}を上へ`} disabled={i === 0} onClick={() => move(i, -1)}>上へ</Button>
                <Button aria-label={`${HOME_LABEL[h.key]}を下へ`} disabled={i === settings.homeItems.length - 1} onClick={() => move(i, 1)}>下へ</Button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="stack">
        <h2>記録ボタン</h2>
        <p className="small muted">ホームに表示する記録ボタンを選びます。</p>
        {(Object.keys(QUICK_LABEL) as QuickRecordKey[]).map((k) => (
          <label key={k} className="acc-check">
            <input type="checkbox" checked={settings.quickRecordTypes.includes(k)} onChange={() => toggleQuick(k)} />
            <span>{QUICK_LABEL[k]}</span>
          </label>
        ))}
      </Card>
    </SubPage>
  );
}
