import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(process.cwd(), '../..'), '');
  const projectId = env.VITE_REOWN_PROJECT_ID || env.NEXT_PUBLIC_REOWN_PROJECT_ID || '';
  const venlyClientId = env.VITE_VENLY_CLIENT_ID || env.NEXT_PUBLIC_VENLY_CLIENT_ID || '';
  const venlyEnvironment = env.VITE_VENLY_ENVIRONMENT || 'production';

  return {
    envDir: resolve(process.cwd(), '../..'),
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: {
      'import.meta.env.VITE_REOWN_PROJECT_ID': JSON.stringify(projectId),
      'import.meta.env.NEXT_PUBLIC_REOWN_PROJECT_ID': JSON.stringify(projectId),
      'import.meta.env.VITE_VENLY_CLIENT_ID': JSON.stringify(venlyClientId),
      'import.meta.env.NEXT_PUBLIC_VENLY_CLIENT_ID': JSON.stringify(venlyClientId),
      'import.meta.env.VITE_VENLY_ENVIRONMENT': JSON.stringify(venlyEnvironment),
    },
    optimizeDeps: {
      include: ['@venly/web3-provider', '@venly/connect'],
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
      proxy: {
        '/api': { target: 'http://127.0.0.1:41717', changeOrigin: true, ws: true },
        '/health': { target: 'http://127.0.0.1:41717', changeOrigin: true },
      },
    },
  };
});
