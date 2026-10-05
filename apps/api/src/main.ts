import { env, ensureSettings, initSentry, logger } from '@copyra/core';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { registerRoutes } from './routes.js';

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

await app.register(cors, {
  origin: true,
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

app.get('/api/ws', { websocket: true }, (socket) => {
  const tick = async () => {
    try {
      const response = await app.inject({ method: 'GET', url: '/api/status' });
      socket.send(response.body);
    } catch {
      /* client may have gone */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 8_000);
  socket.on('close', () => clearInterval(timer));
});

const port = env.listenPort;
const host = env.API_HOST;

await app.listen({ port, host });
logger.info({ port, host, apiPort: env.API_PORT }, 'COPYRA API listening');

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
