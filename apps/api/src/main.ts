import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedWebOrigins, env, ensureSettings, initSentry, logger, publicReownProjectId } from '@copyra/core';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { registerRoutes } from './routes.js';
import { registerFundsRoutes } from './funds.js';

initSentry('copyra-api');

const app = Fastify({
  logger: false,
  trustProxy: true,
});

/**
 * Liveness for DigitalOcean App Platform / load balancers.
 * Registered first, before DB/Redis work, and returns 200 with no secrets.
 */
app.get('/health', async (_request, reply) =>
  reply.code(200).type('application/json').send({
    ok: true,
    service: 'copyra-api',
  }),
);

const corsOrigins = allowedWebOrigins();
await app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : true,
  credentials: true,
});
await app.register(cookie);
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
  allowList: (request) => {
    const path = request.url.split('?')[0] ?? request.url;
    return path === '/health';
  },
});
await app.register(websocket);

try {
  await ensureSettings();
} catch (error) {
  // Still listen so /health can pass while operators fix DB connectivity.
  logger.error({ err: error }, 'ensureSettings failed during API boot — continuing so /health stays up');
}

await registerRoutes(app);
await registerFundsRoutes(app);

function browserConfigJs(): string {
  return (
    `window.COPYRA_API='';` +
    `window.__COPYRA_CONFIG__=${JSON.stringify({
      reownProjectId: publicReownProjectId(),
      site: 'https://copyra.fun',
    })};`
  );
}

app.get('/api/ws', { websocket: true }, (socket) => {
  // Lightweight tick only — never fan-out chain RPCs (that wedged basic-xxs → Degraded).
  const tick = () => {
    try {
      socket.send(JSON.stringify({ type: 'tick', at: new Date().toISOString() }));
    } catch {
      /* client may have gone */
    }
  };
  tick();
  const timer = setInterval(tick, 15_000);
  socket.on('close', () => clearInterval(timer));
});

/** Built dashboard (apps/web/dist) — served from the API so copyra.fun is same-origin. */
function resolveWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../web/dist'),
    join(process.cwd(), 'apps/web/dist'),
    join(process.cwd(), '../web/dist'),
    join(process.cwd(), '../../apps/web/dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

const webDist = resolveWebDist();
if (webDist) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    wildcard: false,
    decorateReply: true,
    // Never let the built static config.js steal this path — runtime env injection.
    allowedPath: (pathName) => pathName !== '/config.js' && !pathName.endsWith('/config.js'),
  });
  // Explicit icon route — some static setups fall through .svg to the SPA HTML shell.
  app.get('/icons/:file', async (request, reply) => {
    const file = String((request.params as { file?: string }).file ?? '');
    if (!/^[a-zA-Z0-9._-]+\.(svg|png|webp|ico|jpg|jpeg)$/.test(file)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const abs = join(webDist, 'icons', file);
    if (!existsSync(abs)) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile(join('icons', file));
  });
  // Register AFTER static so we own /config.js exclusively (no FST_ERR_DUPLICATED_ROUTE).
  app.get('/config.js', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(browserConfigJs()),
  );
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    // Never SPA-fallback asset-like paths (icons, built JS/CSS) — return real 404.
    if (
      /\.(svg|png|webp|ico|js|css|map|woff2?|ttf|json)$/i.test(path) ||
      path.startsWith('/assets/') ||
      path.startsWith('/icons/')
    ) {
      return reply.code(404).type('application/json').send({ error: 'Not found' });
    }
    if (request.method === 'GET' && !path.startsWith('/api') && path !== '/health') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).type('application/json').send({ error: 'Not found' });
  });
  logger.info({ webDist }, 'Serving copyra. dashboard from API (same-origin /api)');
} else {
  app.get('/config.js', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(browserConfigJs()),
  );
  logger.warn({}, 'apps/web/dist not found — API-only mode (no dashboard on /)');
}

const port = env.listenPort;
const host = env.API_HOST;

await app.listen({ port, host });
logger.info(
  { port, host, apiPort: env.API_PORT, publicWeb: env.PUBLIC_WEB_URL, publicApi: env.PUBLIC_API_URL },
  'COPYRA API listening',
);

const { startOpsWatch } = await import('./ops-watch.js');
const stopOpsWatch = startOpsWatch();
logger.info({}, 'Ops Telegram watchdog armed (worker stale + trading-off alerts)');

const shutdown = async () => {
  stopOpsWatch();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
