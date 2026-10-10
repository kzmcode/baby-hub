import { useState } from 'react';
import { query } from 'firebase/firestore';
import { api, apiErrorMessage } from '../../lib/api';
import { createFamilyDoc, paths, useCollection, type WithMeta } from '../../lib/db';
import { useFamily } from '../../context';
import { Button, Card, EmptyState, Field, Select, Sheet, TextArea, TextInput, useToast } from '../../components';
import type { Contact } from '../../types/models';
import { safeHttpsUrl, telHref } from './util';
import { SubPage } from './SubPage';

const CATEGORY: Record<Contact['category'], string> = { clinic: '医療機関', municipality: '自治体', consultation: '相談窓口', other: 'その他' };

export function ContactsSection() {
  const { familyId } = useFamily();
  const toast = useToast();
  const list = useCollection<Contact>(familyId ? query(paths.contacts(familyId)) : null);
  const [editing, setEditing] = useState<WithMeta<Contact> | 'new' | null>(null);
  const [f, setF] = useState({ name: '', category: 'clinic' as Contact['category'], phone: '', url: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function open(c: WithMeta<Contact> | 'new') {
    setError('');
    setF(c === 'new' ? { name: '', category: 'clinic', phone: '', url: '', note: '' }
      : { name: c.name, category: c.category, phone: c.phone ?? '', url: c.url ?? '', note: c.note ?? '' });
    setEditing(c);
  }
  async function save() {
    if (!familyId || !editing) return;
    const url = f.url.trim();
    if (url && !safeHttpsUrl(url)) { setError('URL は https:// で始まるものだけ登録できます。'); return; }
    setBusy(true); setError('');
    try {
      if (editing === 'new') {
        await createFamilyDoc(paths.contacts(familyId).path, {
          name: f.name.trim(), category: f.category, phone: f.phone.trim() || undefined, url: url || undefined, note: f.note.trim() || undefined,
        });
      } else {
        await api.updateDoc({
          familyId, kind: 'contact', docId: editing.id, expectedRevision: editing.revision,
          patch: { name: f.name.trim(), category: f.category, phone: f.phone.trim() || null, url: url || null, note: f.note.trim() || null },
        });
      }
      setEditing(null); toast.show('保存しました。');
    } catch (e) { setError(apiErrorMessage(e)); }
    setBusy(false);
  }
  async function remove(c: WithMeta<Contact>) {
    if (!familyId || !window.confirm(`「${c.name}」を削除しますか？`)) return;
    try { await api.deleteDoc({ familyId, kind: 'contact', docId: c.id, expectedRevision: c.revision }); toast.show('削除しました。'); }
    catch (e) { toast.show(apiErrorMessage(e), { tone: 'error' }); }
  }

  return (
    <SubPage title="連絡先・参考先">
      <p className="small muted">かかりつけ医、自治体の窓口、相談先などを家族で共有します。緊急時は連絡先メモに頼らず、119番など公式の窓口を利用してください。</p>
      <Button variant="primary" onClick={() => open('new')}>追加する</Button>
      {list.data.length === 0 && !list.loading && <EmptyState title="まだ登録がありません" description="よく使う連絡先を追加しておくと便利です。" />}
      {list.data.map((c) => {
        const tel = telHref(c.phone); const url = safeHttpsUrl(c.url);
        return (
          <Card key={c.id} className="stack">
            <div><strong>{c.name}</strong> <span className="acc-badge">{CATEGORY[c.category] ?? c.category}</span></div>
            {c.phone && (tel ? <a href={tel}>電話: {c.phone}</a> : <span>電話: {c.phone}</span>)}
            {url && <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>}
            {c.note && <p className="small">{c.note}</p>}
            <div className="row"><Button onClick={() => open(c)}>編集</Button><Button variant="danger" onClick={() => remove(c)}>削除</Button></div>
          </Card>
        );
      })}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? '連絡先を追加' : '連絡先を編集'}
        footer={<div className="row"><Button onClick={() => setEditing(null)}>キャンセル</Button><Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={save}>保存</Button></div>}>
        <div className="stack">
          <Field label="名称">{(p) => <TextInput {...p} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="種類">{(p) => <Select {...p} value={f.category} options={Object.entries(CATEGORY).map(([value, label]) => ({ value, label }))} onChange={(v) => setF({ ...f, category: v as Contact['category'] })} />}</Field>
          <Field label="電話番号" optional>{(p) => <TextInput {...p} type="tel" inputMode="tel" maxLength={50} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
          <Field label="URL" optional hint="https:// で始まるもの">{(p) => <TextInput {...p} type="url" maxLength={500} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />}</Field>
          <Field label="メモ" optional>{(p) => <TextArea {...p} maxLength={2000} rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
          {error && <p className="acc-err" role="alert">{error}</p>}
        </div>
      </Sheet>
    </SubPage>
  );
}
