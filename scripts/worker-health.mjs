/**
 * Tiny liveness HTTP server for the dedicated copy-trade worker component.
 * DigitalOcean health-checks a Web Service / Worker that exposes a port;
 * trading itself does not need HTTP — this only answers / and /health.
 *
 * When the trading process writes /tmp/copyra-worker-status.json, /health
 * includes last sync / WS / processed ages so ops can tell stall vs quiet market.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const port = Number(process.env.PORT || process.env.HEALTH_PORT || 8080);
const started = Date.now();
const STATUS_PATH = '/tmp/copyra-worker-status.json';

function readStatus() {
  try {
    if (!existsSync(STATUS_PATH)) return null;
    return JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function ageSec(ts) {
  if (!ts || typeof ts !== 'number' || ts <= 0) return null;
  return Math.round((Date.now() - ts) / 1000);
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/health' || path === '/' || path === '/api/health') {
    const st = readStatus();
    const body = {
      ok: true,
      service: 'copyra-worker',
      uptimeSec: Math.round((Date.now() - started) / 1000),
      monitor: st
        ? {
            status: st.status || null,
            watching: st.watching ?? null,
            lastSolanaSyncAgeSec: ageSec(st.lastSolanaSyncAt),
            lastSolanaWsEventAgeSec: ageSec(st.lastSolanaWsEventAt),
            lastSolanaProcessedAgeSec: ageSec(st.lastSolanaProcessedAt),
            lastSolanaSlot: st.lastSolanaSlot || null,
            lastEvmTickAgeSec: ageSec(st.lastEvmTickAt),
            lastEvmProcessedAgeSec: ageSec(st.lastEvmProcessedAt),
            catchUpOk: st.catchUpOk ?? null,
            catchUpErr: st.catchUpErr ?? null,
          }
        : null,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`COPYRA worker health listening on :${port}`);
});

server.on('error', (err) => {
  console.error('COPYRA worker health server error', err);
  // Do not exit — the trading process is what matters; DO may retry health.
});
