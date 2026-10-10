import { Route, Routes } from 'react-router-dom';
import { HealthPage } from './HealthPage';
import { VitalsPage } from './VitalsPage';
import { ProfilePage } from './ProfilePage';
import { MedicationsPage } from './MedicationsPage';
import { VisitDetailPage, VisitsPage } from './VisitsPage';
import { VaccinationsPage } from './VaccinationsPage';
import { GrowthPage } from './GrowthPage';
import { ReportPage } from './ReportPage';

/** /health/* 配下のサブルート（親 Route は `/health/*`。ここでは相対パス） */
export function HealthRoutes() {
  return (
    <Routes>
      <Route index element={<HealthPage />} />
      <Route path="vitals" element={<VitalsPage />} />
      <Route path="profile" element={<ProfilePage />} />
      <Route path="medications" element={<MedicationsPage />} />
      <Route path="visits" element={<VisitsPage />} />
      <Route path="visits/:id" element={<VisitDetailPage />} />
      <Route path="vaccinations" element={<VaccinationsPage />} />
      <Route path="growth" element={<GrowthPage />} />
      <Route path="report" element={<ReportPage />} />
      <Route path="*" element={<HealthPage />} />
    </Routes>
  );
}
