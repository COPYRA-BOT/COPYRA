/**
 * Tiny liveness HTTP server for the dedicated copy-trade worker component.
 * DigitalOcean health-checks a Web Service / Worker that exposes a port;
 * trading itself does not need HTTP — this only answers / and /health.
 */
import http from 'node:http';

const port = Number(process.env.PORT || process.env.HEALTH_PORT || 8080);
const started = Date.now();

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/health' || path === '/' || path === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'copyra-worker',
        uptimeSec: Math.round((Date.now() - started) / 1000),
      }),
    );
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
