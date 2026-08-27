import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { AppErrorBoundary } from './components/app-error-boundary';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
