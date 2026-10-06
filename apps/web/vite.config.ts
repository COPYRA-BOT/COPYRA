import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/** Only VITE_REOWN_PROJECT_ID — no NEXT_PUBLIC_ / Alchemy aliases in the browser. */
function resolveReownProjectId(env: Record<string, string>): string {
  return env.VITE_REOWN_PROJECT_ID?.trim() || '';
}

/** Local stand-in for the API's runtime /config.js (not shipped in dist). */
function copyraConfigPlugin(env: Record<string, string>): Plugin {
  const body = () =>
    `window.COPYRA_API='';window.__COPYRA_CONFIG__=${JSON.stringify({
      reownProjectId: resolveReownProjectId(env),
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
  const projectId = resolveReownProjectId(env);

  return {
    envDir: resolve(process.cwd(), '../..'),
    envPrefix: ['VITE_'],
    plugins: [react(), copyraConfigPlugin(env)],
    resolve: {
      alias: {
        fs: resolve(__dirname, 'src/empty-module.ts'),
        net: resolve(__dirname, 'src/empty-module.ts'),
        tls: resolve(__dirname, 'src/empty-module.ts'),
      },
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    define: {
      'import.meta.env.VITE_REOWN_PROJECT_ID': JSON.stringify(projectId),
      global: 'globalThis',
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 2500,
      minify: 'esbuild',
      cssMinify: true,
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
