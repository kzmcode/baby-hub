import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import './components/components.css';
import { applyStoredTheme } from './context/UserSettingsContext';
import { App } from './app/App';

applyStoredTheme(); // 描画前に前回のテーマを反映（ちらつき防止）

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
