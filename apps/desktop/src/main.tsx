import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Шрифты вшиты в сборку: приложение стартует до подключения VPN и не должно
// зависеть от доступности внешних CDN.
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

import './styles/theme.css';
import './styles/components.css';
import './styles/scale.css';
import './styles/app.css';
import './styles/fork.css';

import { applyCachedTheme } from './lib/theme';
import App from './App';

applyCachedTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
