/**
 * Tiny liveness HTTP server for dedicated worker / sniper components.
 * DigitalOcean health-checks a Web Service / Worker that exposes a port;
 * trading itself does not need HTTP — this only answers / and /health.
 *
 * Set COPYRA_HEALTH_ROLE=sniper for the sniper worker (status file + service name).
 * Default role is the copy-trade worker.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const port = Number(process.env.PORT || process.env.HEALTH_PORT || 8080);
const started = Date.now();
const role = String(process.env.COPYRA_HEALTH_ROLE || 'worker')
  .trim()
  .toLowerCase();
const isSniper = role === 'sniper' || role === 'sniper-worker';
const STATUS_PATH = isSniper
  ? '/tmp/copyra-sniper-status.json'
  : '/tmp/copyra-worker-status.json';
const SERVICE = isSniper ? 'copyra-sniper-worker' : 'copyra-worker';

function readStatus() {
  try {
    if (!existsSync(STATUS_PATH)) return null;
    return JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function ageSec(ts) {
  if (typeof ts === 'string' && ts) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return Math.round((Date.now() - ms) / 1000);
  }
  if (!ts || typeof ts !== 'number' || ts <= 0) return null;
  return Math.round((Date.now() - ts) / 1000);
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/health' || path === '/' || path === '/api/health') {
    const st = readStatus();
    const body = {
      ok: true,
      service: SERVICE,
      role: isSniper ? 'sniper' : 'worker',
      uptimeSec: Math.round((Date.now() - started) / 1000),
      monitor: st
        ? {
            status: st.status || null,
            sniperEnabled: st.sniperEnabled ?? null,
            sniperMode: st.sniperMode ?? null,
            discoveryCount: st.discoveryCount ?? null,
            lastDiscoveryAgeSec: ageSec(st.lastDiscoveryAt),
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
  console.log(`COPYRA ${SERVICE} health listening on :${port}`);
});

server.on('error', (err) => {
  console.error('COPYRA worker health server error', err);
  // Do not exit — the trading process is what matters; DO may retry health.
});
