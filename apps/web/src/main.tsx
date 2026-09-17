import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './store/AppStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/theme.css';
import './styles/components.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <App />
      </AppProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
