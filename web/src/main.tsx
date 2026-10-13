import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { loadDashboardService } from './app/lazy-pages';
import { markOnce } from './lib/perf';
import { applyTheme, readThemePreference } from './theme/theme';

markOnce('hf:boot');
applyTheme(readThemePreference());
// Landing on Today: fetch the dashboard service's chunk now, before auth has answered (ADR-050).
if (window.location.pathname === '/') void loadDashboardService().catch(() => undefined);

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
