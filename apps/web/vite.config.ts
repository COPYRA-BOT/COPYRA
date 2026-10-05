import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(process.cwd(), '../..'), '');
  const projectId = env.VITE_REOWN_PROJECT_ID || env.NEXT_PUBLIC_REOWN_PROJECT_ID || '';

  return {
    envDir: resolve(process.cwd(), '../..'),
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: {
      'import.meta.env.VITE_REOWN_PROJECT_ID': JSON.stringify(projectId),
      'import.meta.env.NEXT_PUBLIC_REOWN_PROJECT_ID': JSON.stringify(projectId),
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
  };
});
