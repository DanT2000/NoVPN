import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './store/AppStore';
import './styles/theme.css';
import './styles/components.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
