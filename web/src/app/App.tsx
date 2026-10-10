import { BrowserRouter } from 'react-router-dom';
import { AuthProvider, FamilyProvider, UserSettingsProvider } from '../context';
import { ToastProvider, UpdatePrompt } from '../components';
import { AppRoutes } from './routes';

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <UserSettingsProvider>
            <FamilyProvider>
              <AppRoutes />
              <UpdatePrompt />
            </FamilyProvider>
          </UserSettingsProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
