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

await app.register(cors, {
  origin: true,
  credentials: true,
});
await app.register(cookie);
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
});
await app.register(websocket);

await ensureSettings();
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

const port = env.API_PORT;
const host = env.API_HOST;

await app.listen({ port, host });
logger.info({ port, host }, 'COPYRA API listening');

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
