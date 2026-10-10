import { Navigate, Route, Routes } from 'react-router-dom';
import { AboutSection } from './AboutSection';
import { AccountSection } from './AccountSection';
import { ChildSection } from './ChildSection';
import { ContactsSection } from './ContactsSection';
import { DeviceSection } from './DeviceSection';
import { DisplaySection } from './DisplaySection';
import { ExportSection } from './ExportSection';
import { FamilySection } from './FamilySection';
import { NotificationSection } from './NotificationSection';

/** /more/* のサブ画面 */
export function MoreRoutes() {
  return (
    <Routes>
      <Route path="family" element={<FamilySection />} />
      <Route path="children" element={<ChildSection />} />
      <Route path="display" element={<DisplaySection />} />
      <Route path="notifications" element={<NotificationSection />} />
      <Route path="device" element={<DeviceSection />} />
      <Route path="export" element={<ExportSection />} />
      <Route path="contacts" element={<ContactsSection />} />
      <Route path="account" element={<AccountSection />} />
      <Route path="about" element={<AboutSection />} />
      <Route path="*" element={<Navigate to="/more" replace />} />
    </Routes>
  );
}
