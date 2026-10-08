import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { markOnce } from './lib/perf';
import { applyTheme, readThemePreference } from './theme/theme';

markOnce('hf:boot');
applyTheme(readThemePreference());

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
