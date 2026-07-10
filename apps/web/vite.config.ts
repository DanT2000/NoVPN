import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Фронтенд отдаётся Vite в деве (5173) и статикой из manager в проде.
// В деве /api проксируется на manager (3000).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@novpn/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
