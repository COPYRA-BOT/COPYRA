import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(root, '../..'),
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
    },
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['buffer', 'bs58'],
  },
  server: {
    host: '0.0.0.0',
    port: 43127,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:41717', changeOrigin: true, ws: true },
      '/health': { target: 'http://127.0.0.1:41717', changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 43127,
  },
});
