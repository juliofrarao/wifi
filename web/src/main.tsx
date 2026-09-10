import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { ToastProvider } from './components/Toast';
import { ConfigProvider } from './config/ConfigProvider';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ConfigProvider>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </ConfigProvider>
    </BrowserRouter>
  </StrictMode>
);

// Service worker: production builds only (the dev server would fight with caching).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(__APP_VERSION__)}`, { scope: '/' }).catch(() => {
      /* offline features unavailable */
    });
  });
}
