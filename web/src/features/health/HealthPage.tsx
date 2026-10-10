// 健康（S09）入口
import { Link } from 'react-router-dom';
import { query, where } from 'firebase/firestore';
import { useFamily } from '../../context';
import { paths, useCollection, useDocument } from '../../lib/db';
import { formatDateJa, formatElapsed } from '../../lib/time';
import { Card, CategoryIcon, type CategoryName } from '../../components';
import { tsToDate, useIds, useRecentEvents } from './shared';
import { gramsToKgText } from './logic/units';
import { lastDoseMap } from './logic/dose';
import { confLabel } from './ProfilePage';
import type { HealthProfile, MedicalVisit, Medication, Vaccination } from '../../types/models';
import './health.css';

function Entry({ to, icon, title, children }: { to: string; icon: CategoryName; title: string; children?: React.ReactNode }) {
  return (
    <Link to={to} className="hl-card-link">
      <Card>
        <div className="hl-card-title"><CategoryIcon name={icon} /><span>{title}</span></div>
        <div className="small">{children}</div>
      </Card>
    </Link>
  );
}

export function HealthPage() {
  const { familyId, childId, loading } = useIds();
  const { memberName } = useFamily();
  const vit = useRecentEvents(['temperature', 'symptom'], 3);
  const vom = useRecentEvents(['vomit'], 1);
  const taken = useRecentEvents(['medication_taken'], 30);
  const gr = useRecentEvents(['growth'], 1);
  const meds = useCollection<Medication>(familyId && childId ? query(paths.medications(familyId, childId), where('status', '==', 'active')) : null);
  const visits = useCollection<MedicalVisit>(familyId && childId ? paths.medicalVisits(familyId, childId) : null);
  const vacs = useCollection<Vaccination>(familyId && childId ? paths.vaccinations(familyId, childId) : null);
  const prof = useDocument<HealthProfile>(familyId && childId ? paths.healthProfile(familyId, childId) : null);

  if (loading) return <div className="page"><p className="muted" role="status">読み込み中…</p></div>;
  const v0 = vit.data[0];
  const lastDose = lastDoseMap(taken.data.map((e) => ({ id: e.id, occurredAt: tsToDate(e.occurredAt), caregiverUid: e.caregiverUid, medicationId: String((e.payload as { medicationId?: string }).medicationId ?? '') })));
  const latestDose = [...lastDose.values()].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  const latestMedName = latestDose ? meds.data.find((m) => m.id === latestDose.medicationId)?.name : undefined;
  const latestVisit = [...visits.data].sort((a, b) => b.occurredOn.localeCompare(a.occurredOn))[0];
  const upcoming = vacs.data.filter((v) => (v.status === 'planned' || v.status === 'reserved') && v.scheduledDate).sort((a, b) => (a.scheduledDate! < b.scheduledDate! ? -1 : 1))[0];
  const g = gr.data[0]?.payload as { heightCm?: number; weightGrams?: number } | undefined;

  return (
    <div className="page">
      <h1>健康</h1>
      <p className="small muted">記録と確認のためのページです。診断や判断はしません。急なときは医療機関や小児救急電話相談(#8000。受付時間・対象地域は公式情報で確認)へ。</p>
      <div className="stack">
        <Entry to="/health/vitals" icon="temperature" title="体温・症状">
          {v0 ? <>直近: {formatElapsed(tsToDate(v0.occurredAt))} {v0.type === 'temperature' ? `${(v0.payload as { celsius: number }).celsius}℃` : `症状（保護者の観察）${((v0.payload as { symptomTags: string[] }).symptomTags ?? []).join('、')}`}</> : '記録なし'}
        </Entry>
        <Entry to="/records" icon="vomit" title="吐いた（記録タブの記録）">
          {vom.data[0] ? `直近: ${formatElapsed(tsToDate(vom.data[0].occurredAt))}` : '記録なし'}
        </Entry>
        <Entry to="/health/medications" icon="medication" title="薬">
          {meds.data.length === 0 ? '有効な薬はありません' : <>有効な薬 {meds.data.length}件（{meds.data.map((m) => m.name).join('、')}）<br />{latestDose ? `最後に飲ませたのは ${formatElapsed(latestDose.occurredAt)}（${memberName(latestDose.caregiverUid)}）${latestMedName ? ` ${latestMedName}` : ''}` : '記録上、実績なし'}</>}
        </Entry>
        <Entry to="/health/visits" icon="schedule" title="受診メモ">
          {latestVisit ? `直近: ${formatDateJa(latestVisit.occurredOn)} ${latestVisit.provider}` : 'まだありません'}
        </Entry>
        <Entry to="/health/vaccinations" icon="schedule" title="予防接種・健診">
          {upcoming ? `次の予定: ${formatDateJa(upcoming.scheduledDate!)} ${upcoming.name}（${upcoming.status === 'reserved' ? '予約済み' : '未予約'}）` : '予定はありません'}
        </Entry>
        <Entry to="/health/growth" icon="growth" title="身長・体重">
          {g ? `直近: ${g.heightCm !== undefined ? `身長 ${g.heightCm}cm ` : ''}${g.weightGrams !== undefined ? `体重 ${gramsToKgText(g.weightGrams)}kg` : ''}` : '記録なし'}
        </Entry>
        <Entry to="/health/profile" icon="other" title="アレルギー・かかりつけ">
          {prof.data ? <>アレルギー {prof.data.allergies.length}件{prof.data.allergies[0] ? `（${prof.data.allergies[0].name}: ${confLabel(prof.data.allergies[0].confirmation)}など）` : ''}／かかりつけ {prof.data.primaryClinic?.name ?? '未登録'}</> : '未登録'}
        </Entry>
        <Entry to="/health/report" icon="handover" title="受診用表示・印刷">期間を指定して、記録をまとめて見せられます</Entry>
      </div>
    </div>
  );
}
