import { defineConfig } from 'vite';

export default defineConfig({
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
