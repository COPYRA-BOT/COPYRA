import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolve } from 'node:path';

/** Local stand-in for the API's runtime /config.js (not shipped in dist). */
function copyraConfigPlugin(env: Record<string, string>): Plugin {
  const body = () =>
    `window.COPYRA_API='';window.__COPYRA_CONFIG__=${JSON.stringify({
      reownProjectId: env.VITE_REOWN_PROJECT_ID || env.NEXT_PUBLIC_REOWN_PROJECT_ID || '',
      site: 'https://copyra.fun',
    })};`;

  return {
    name: 'copyra-config-js',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/config.js') {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body());
          return;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/config.js') {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body());
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(process.cwd(), '../..'), '');
  const projectId = env.VITE_REOWN_PROJECT_ID || env.NEXT_PUBLIC_REOWN_PROJECT_ID || '';

  return {
    envDir: resolve(process.cwd(), '../..'),
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    plugins: [copyraConfigPlugin(env)],
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
      proxy: {
        '/api': { target: 'http://127.0.0.1:41717', changeOrigin: true, ws: true },
        '/health': { target: 'http://127.0.0.1:41717', changeOrigin: true },
      },
    },
  };
});
