import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// Порт фиксирован: Tauri ждёт дев-сервер именно на нём.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  clearScreen: false,
  server: { port: 5273, strictPort: true },
  build: { target: 'chrome110', outDir: 'dist' },
});
