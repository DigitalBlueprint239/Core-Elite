import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { initAPM } from './lib/apm';
import './index.css';

// APM — prod-only, no-op in dev/test. See src/lib/apm.ts for activation
// rules (import.meta.env.PROD, VITE_APM_DISABLED, VITE_APM_ENDPOINT).
initAPM();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
