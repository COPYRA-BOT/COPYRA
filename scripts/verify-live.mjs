#!/usr/bin/env node
/**
 * Live deploy verification against copyra.fun (HTTP — HTTPS may be CF 526).
 * Never prints secrets. Exits non-zero when trading/funds are not ready.
 */
const BASE = process.env.COPYRA_LIVE_URL || 'http://copyra.fun';

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { redirect: 'follow' });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: r.status, json, text: text.slice(0, 200) };
}

const issues = [];
console.log(`\nCOPYRA live verify → ${BASE}\n`);

const health = await get('/health');
console.log(`health: ${health.status}`, health.json || health.text);
if (health.status !== 200 || !health.json?.ok) issues.push('health not ok');

const status = await get('/api/status');
const trading = status.json?.trading;
const signers = status.json?.signers;
console.log('trading:', JSON.stringify(trading));
console.log('signers:', JSON.stringify(signers));
console.log('rpcConfigured:', JSON.stringify(status.json?.rpcConfigured || null));
console.log('chains:', (status.json?.chains || []).length, 'workers:', status.json?.workers);

if (!signers?.solana?.available && !signers?.evm?.available) {
  issues.push('no bot signer available — set bot signing material as App-Level encrypted secrets');
}
if (!trading?.envGuard) {
  issues.push('TRADING_ENABLED is not true on the server (use lowercase true, App-Level, redeploy)');
}
if (trading?.blockedReason) {
  issues.push(`trading blocked: ${trading.blockedReason}`);
}
if (!(status.json?.chains || []).length) {
  issues.push('no chain heads — set Solana/EVM RPC URL env vars on App-Level for ALL components');
}

const funds = await get('/api/funds?mode=sol');
console.log('funds sol:', funds.status, JSON.stringify(funds.json));
if (funds.status !== 200 || funds.json?.configured !== true) {
  issues.push('GET /api/funds failed — RPC URLs missing on the api component');
}

const balances = await get('/api/balances');
const wallets = balances.json?.wallets || [];
for (const w of wallets) {
  console.log(
    `balance ${w.chain}: configured=${w.configured} address=${w.address || 'none'} native=${w.native ?? 'n/a'} err=${w.error || 'none'}`,
  );
  if (w.configured && w.error) issues.push(`${w.chain} balance error: ${w.error}`);
}

if (issues.length) {
  console.log('\n✗ Live not ready:\n');
  for (const i of issues) console.log(`  - ${i}`);
  console.log('');
  process.exit(1);
}

console.log('\n✓ Live ready for small real-chain deposit / move / withdraw tests.\n');
console.log(`  Solana bot: ${signers?.solana?.address || '—'}`);
console.log(`  EVM bot:    ${signers?.evm?.address || '—'}`);
console.log(`  Dashboard:  ${BASE}/\n`);
