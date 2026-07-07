import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the (tokenless, same-origin) service worker for background push, and silently
// re-subscribe if permission was already granted — endpoints rotate, so this keeps the
// subscription fresh. Never request permission here; that only happens on a user gesture.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then(() => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        void import('./lib/push').then((m) => m.subscribePush());
      }
    })
    .catch(() => {});
}
