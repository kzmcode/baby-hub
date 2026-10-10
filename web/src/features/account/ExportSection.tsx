import { useState } from 'react';
import { api, apiErrorMessage, type ExportData } from '../../lib/api';
import { useFamily } from '../../context';
import { Button, Card, useToast } from '../../components';
import { buildCsvFiles, type CsvFile } from './logic/csv';
import { downloadText } from './util';
import { SubPage } from './SubPage';

export function ExportSection() {
  const { familyId } = useFamily();
  const toast = useToast();
  const [data, setData] = useState<ExportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const csv: CsvFile[] = data ? buildCsvFiles(data) : [];

  async function fetchData() {
    if (!familyId) return;
    setBusy(true); setError('');
    try { setData(await api.exportFamilyData({ familyId })); }
    catch (e) { setError(apiErrorMessage(e)); }
    setBusy(false);
  }
  const date = data?.exportedAt.slice(0, 10) ?? '';
  const json = () => data && downloadText(`baby-hub-${date}.json`, JSON.stringify({ schemaVersion: 1, ...data }, null, 2), 'application/json;charset=utf-8');
  const allCsv = () => csv.forEach((f, i) => setTimeout(() => downloadText(f.filename, f.content, 'text/csv;charset=utf-8'), i * 400));

  return (
    <SubPage title="データ出力">
      <Card className="stack">
        <p className="small">家族の記録（子ども、日常の記録、健康、予定、ToDo、買い物、申し送り、連絡先）を JSON または CSV で持ち出せます。CSV は種類ごとに別ファイル（UTF-8、Excel 対応）です。</p>
        <Card tone="warning" className="small">出力したファイルには子どもの健康情報などが含まれます。端末に保存されたファイルはアプリから遠隔で消すことはできません。取り扱いにご注意ください。</Card>
        {!data && <Button variant="primary" loading={busy} onClick={fetchData} disabled={!familyId}>出力データを準備する</Button>}
        {error && <p className="acc-err" role="alert">{error}</p>}
      </Card>
      {data && (
        <Card className="stack">
          <p className="small muted">{new Date(data.exportedAt).toLocaleString('ja-JP')} 時点のデータ</p>
          <Button variant="primary" onClick={json}>JSON をダウンロード</Button>
          <h2>CSV</h2>
          <ul className="acc-list">
            {csv.map((f) => (
              <li key={f.key}>
                <span>{f.label}<span className="small muted">（{f.rows} 件）</span></span>
                <Button onClick={() => downloadText(f.filename, f.content, 'text/csv;charset=utf-8')}>ダウンロード</Button>
              </li>
            ))}
          </ul>
          {csv.length > 1 && <Button onClick={() => { allCsv(); toast.show('複数のファイルをダウンロードします。'); }}>CSV をすべてダウンロード</Button>}
          <Button variant="ghost" onClick={fetchData} loading={busy}>最新の内容で準備し直す</Button>
        </Card>
      )}
    </SubPage>
  );
}
