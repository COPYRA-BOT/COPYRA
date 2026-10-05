#!/usr/bin/env node
/**
 * Live provider verification.
 *
 * Every check here performs a real network call against a real provider and
 * records the real response. Nothing is stubbed and nothing passes by default:
 * a check that cannot reach its provider is reported as a failure.
 *
 * Output is written to `evidence/providers-<timestamp>.json` so a claim in the
 * production checklist can be traced back to an actual response.
 *
 * Usage:  npm run verify:providers
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Chain } from '@copyra/db';
import {
  CHAIN_CONFIGS,
  chainConfig,
  decodeSolanaTransaction,
  evmPool,
  getDexscreenerMarket,
  getErc20Metadata,
  getEvmBlockNumber,
  getJupiterPrices,
  getJupiterQuote,
  getMarketSnapshot,
  getSlot,
  MAX_SUPPORTED_TX_VERSION,
  monitorableChains,
  solanaPool,
  telegram,
  WRAPPED_SOL_MINT_STR,
} from '@copyra/core';

interface CheckResult {
  name: string;
  category: string;
  ok: boolean;
  detail: string;
  evidence?: unknown;
  latencyMs?: number;
}

const results: CheckResult[] = [];

async function check(
  name: string,
  category: string,
  fn: () => Promise<{ detail: string; evidence?: unknown }>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const { detail, evidence } = await fn();
    const latencyMs = Date.now() - startedAt;
    results.push({ name, category, ok: true, detail, evidence, latencyMs });
    console.log(`  ✓ ${name} (${latencyMs}ms)\n      ${detail}`);
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, category, ok: false, detail, latencyMs });
    console.log(`  ✗ ${name} (${latencyMs}ms)\n      ${detail}`);
  }
}

console.log('\n=== COPYRA live provider verification ===\n');

// ---------------------------------------------------------------------------
console.log('Solana RPC');
await check('Solana getSlot via Helius', 'solana-rpc', async () => {
  const { slot, endpoint, latencyMs } = await getSlot();
  if (slot < 300_000_000) throw new Error(`Implausible slot ${slot}`);
  return {
    detail: `slot=${slot} from ${endpoint} in ${latencyMs}ms`,
    evidence: { slot, endpoint, latencyMs },
  };
});

await check('Solana RPC failover pool health', 'solana-rpc', async () => {
  const health = solanaPool().health();
  return {
    detail: `${health.length} endpoint(s): ${health.map((h) => `${h.safeUrl}=${h.healthy ? 'healthy' : 'degraded'}`).join(', ')}`,
    evidence: health,
  };
});

// ---------------------------------------------------------------------------
console.log('\nSolana transaction decoding (real mainnet transactions)');
await check('Decode a real Jupiter swap from mainnet', 'solana-decode', async () => {
  // Walk recent signatures of a live Jupiter-heavy account until a swap with a
  // quote-asset spend leg is found, then decode it. Uses only real chain data.
  const { PublicKey } = await import('@solana/web3.js');
  const raydium = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

  const sigResult = await solanaPool().call('getSignaturesForAddress', (client) =>
    client.getSignaturesForAddress(raydium, { limit: 12 }),
  );
  const signatures = sigResult.value.filter((s) => !s.err).map((s) => s.signature);
  if (signatures.length === 0) throw new Error('No recent successful signatures found');

  for (const signature of signatures.slice(0, 8)) {
    const txResult = await solanaPool().call('getParsedTransaction', (client) =>
      client.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        commitment: 'confirmed',
      }),
    );
    const tx = txResult.value;
    if (!tx?.meta) continue;

    // Decode from the perspective of the transaction's own fee payer, which is
    // a real trader wallet.
    const feePayer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
    if (!feePayer) continue;

    const decoded = decodeSolanaTransaction({ tx, signature, traderAddress: feePayer });
    if (decoded.classification === 'BUY' || decoded.classification === 'SELL') {
      return {
        detail:
          `signature=${signature} classified=${decoded.classification} venue=${decoded.venue} ` +
          `in=${decoded.tokenIn?.address.slice(0, 8)}(${decoded.tokenIn?.amountRaw}) ` +
          `out=${decoded.tokenOut?.address.slice(0, 8)}(${decoded.tokenOut?.amountRaw})`,
        evidence: {
          signature,
          wallet: feePayer,
          classification: decoded.classification,
          basis: decoded.classificationBasis,
          venue: decoded.venue,
          tokenIn: decoded.tokenIn,
          tokenOut: decoded.tokenOut,
          slot: decoded.blockNumber?.toString(),
        },
      };
    }
  }
  throw new Error('Scanned 8 recent transactions without finding a decodable BUY/SELL');
});

// ---------------------------------------------------------------------------
console.log('\nJupiter (Solana swap routing)');
await check('Jupiter quote: 0.1 SOL -> USDC', 'jupiter', async () => {
  const quote = await getJupiterQuote({
    inputMint: WRAPPED_SOL_MINT_STR,
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountRaw: '100000000',
    slippageBps: 100,
  });
  if (BigInt(quote.quote.outAmount) <= 0n) throw new Error('Quote returned zero out');
  return {
    detail:
      `out=${quote.quote.outAmount} USDC base units, minOut=${quote.quote.otherAmountThreshold}, ` +
      `impact=${quote.priceImpactPct.toFixed(6)}%, route=${quote.routeLabels.join(' > ')}, endpoint=${quote.endpoint}`,
    evidence: {
      inAmount: quote.quote.inAmount,
      outAmount: quote.quote.outAmount,
      minOut: quote.quote.otherAmountThreshold,
      priceImpactPct: quote.priceImpactPct,
      route: quote.routeLabels,
      contextSlot: quote.quote.contextSlot,
      latencyMs: quote.latencyMs,
      endpoint: quote.endpoint,
    },
  };
});

await check('Jupiter price feed (SOL)', 'jupiter', async () => {
  const prices = await getJupiterPrices([WRAPPED_SOL_MINT_STR]);
  const sol = prices.get(WRAPPED_SOL_MINT_STR);
  if (!sol) throw new Error('No SOL price returned');
  if (sol.usdPrice < 1 || sol.usdPrice > 10_000) {
    throw new Error(`Implausible SOL price ${sol.usdPrice}`);
  }
  return {
    detail: `SOL = $${sol.usdPrice.toFixed(2)} at blockId ${sol.blockId}`,
    evidence: sol,
  };
});

await check('Jupiter swap transaction build (unsigned)', 'jupiter', async () => {
  const { buildJupiterSwap } = await import('@copyra/core');
  const quote = await getJupiterQuote({
    inputMint: WRAPPED_SOL_MINT_STR,
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountRaw: '10000000',
    slippageBps: 100,
  });
  // A well-known mainnet account is used purely as the fee payer in the build
  // request. The transaction is never signed and never broadcast; this proves
  // the build path produces a real, deserialisable Solana transaction.
  const built = await buildJupiterSwap({
    quote: quote.quote,
    userPublicKey: 'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG',
  });
  const { VersionedTransaction } = await import('@solana/web3.js');
  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
  const instructionCount = tx.message.compiledInstructions.length;
  return {
    detail:
      `Built and deserialised a real VersionedTransaction: ${instructionCount} instructions, ` +
      `blockhash=${tx.message.recentBlockhash}, lastValidBlockHeight=${built.lastValidBlockHeight}, ` +
      `${tx.signatures.length} signature slot(s) — unsigned, not broadcast`,
    evidence: {
      instructionCount,
      recentBlockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
      addressTableLookups: tx.message.addressTableLookups.length,
      base64Length: built.swapTransaction.length,
    },
  };
});

// ---------------------------------------------------------------------------
console.log('\nEVM RPC (all configured chains)');
for (const config of monitorableChains().filter((c) => c.kind === 'evm')) {
  await check(`${config.label} eth_chainId + eth_blockNumber`, 'evm-rpc', async () => {
    const { blockNumber, endpoint, latencyMs } = await getEvmBlockNumber(config.chain);
    const idResult = await evmPool(config.chain).call('getChainId', (client) => client.getChainId());
    if (idResult.value !== config.chainId) {
      throw new Error(
        `Chain id mismatch: endpoint reports ${idResult.value}, registry expects ${config.chainId}`,
      );
    }
    return {
      detail:
        `chainId=${idResult.value} block=${blockNumber} endpoint=${endpoint} in ${latencyMs}ms ` +
        `(execution ${config.canExecute ? 'ENABLED' : 'DISABLED — monitor only'})`,
      evidence: {
        chainId: idResult.value,
        blockNumber: blockNumber.toString(),
        canExecute: config.canExecute,
        routeProvider: config.routeProvider,
        blockedReason: config.executionBlockedReason ?? null,
      },
    };
  });
}

// ---------------------------------------------------------------------------
console.log('\nEVM token metadata (read from the contract, never assumed)');
await check('Read USDC decimals from the Base contract', 'evm-token', async () => {
  const usdc = chainConfig(Chain.BASE).stableAsset as string;
  const metadata = await getErc20Metadata(Chain.BASE, usdc);
  if (metadata.decimals !== 6) {
    throw new Error(`Base USDC should have 6 decimals, contract reported ${metadata.decimals}`);
  }
  return {
    detail: `${metadata.symbol} (${metadata.name}) decimals=${metadata.decimals} totalSupply=${metadata.totalSupply}`,
    evidence: {
      ...metadata,
      totalSupply: metadata.totalSupply?.toString() ?? null,
    },
  };
});

// ---------------------------------------------------------------------------
console.log('\nKyberSwap (EVM swap routing)');
for (const config of [CHAIN_CONFIGS.BASE, CHAIN_CONFIGS.ARBITRUM, CHAIN_CONFIGS.BSC]) {
  if (!config.canExecute) continue;
  await check(`KyberSwap route on ${config.label}`, 'kyberswap', async () => {
    const { getKyberRoute, buildKyberSwap } = await import('@copyra/core');
    const amount = (10n ** BigInt(config.quoteAssetDecimals - 2)).toString();
    const route = await getKyberRoute({
      chain: config.chain,
      tokenIn: config.quoteAsset,
      tokenOut: config.stableAsset as string,
      amountInRaw: amount,
    });
    const built = await buildKyberSwap({
      chain: config.chain,
      route,
      sender: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000001',
      slippageBps: 100,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });
    if (!built.data.startsWith('0x') || built.data.length < 100) {
      throw new Error('Route build returned no usable calldata');
    }
    return {
      detail:
        `in=${route.amountInUsd.toFixed(2)} USD out=${route.amountOutUsd.toFixed(2)} USD ` +
        `impact=${route.priceImpactPct.toFixed(4)}% router=${built.routerAddress} ` +
        `calldata=${built.data.length} bytes (unsigned, not broadcast)`,
      evidence: {
        router: built.routerAddress,
        amountIn: built.amountIn,
        amountOut: built.amountOut,
        amountOutMin: built.amountOutMin,
        amountInUsd: route.amountInUsd,
        amountOutUsd: route.amountOutUsd,
        priceImpactPct: route.priceImpactPct,
        calldataBytes: built.data.length,
        gas: built.gas.toString(),
      },
    };
  });
}

// ---------------------------------------------------------------------------
console.log('\nMarket data');
await check('Dexscreener market cap + liquidity (BONK on Solana)', 'market', async () => {
  const bonk = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const market = await getDexscreenerMarket(Chain.SOLANA, bonk);
  if (market.missing) throw new Error('Dexscreener returned no pairs for BONK');
  if (market.marketCapUsd === null) throw new Error('No market cap returned');
  return {
    detail:
      `${market.symbol}: price=$${market.priceUsd} MC=$${Math.round(market.marketCapUsd).toLocaleString()} ` +
      `Liq=$${Math.round(market.liquidityUsd ?? 0).toLocaleString()} source=${market.source} dex=${market.dexId}`,
    evidence: market,
  };
});

await check('Unified snapshot cross-checks Jupiter against Dexscreener', 'market', async () => {
  const bonk = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const snapshot = await getMarketSnapshot(Chain.SOLANA, bonk);
  if (snapshot.missing) throw new Error('Unified snapshot missing');
  if (!snapshot.source.includes('jupiter')) {
    throw new Error(`Expected a Jupiter cross-check in the source, got "${snapshot.source}"`);
  }
  return {
    detail: `price=$${snapshot.priceUsd} MC=$${Math.round(snapshot.marketCapUsd ?? 0).toLocaleString()} source=${snapshot.source}`,
    evidence: snapshot,
  };
});

// ---------------------------------------------------------------------------
console.log('\nTelegram');
await check('Telegram bot token + group reachability', 'telegram', async () => {
  const verification = await telegram.verify();
  if (!verification.tokenValid) {
    throw new Error(verification.error ?? 'Bot token invalid');
  }
  if (!verification.canPostToChat) {
    throw new Error(
      `Token is valid (bot @${verification.botUsername}) but the configured chat is NOT reachable. ` +
        `${verification.error ?? ''} ACTION REQUIRED: add the bot to the group and allow it to post.`,
    );
  }
  return {
    detail: `bot=@${verification.botUsername} chat="${verification.chatTitle}" reachable and writable`,
    evidence: verification,
  };
});

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;

mkdirSync('evidence', { recursive: true });
const file = `evidence/providers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      summary: { total: results.length, passed, failed },
      results,
    },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  ),
);

console.log(`\n=== ${passed}/${results.length} checks passed ===`);
if (failed > 0) {
  console.log('\nFailed checks:');
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  ✗ [${r.category}] ${r.name}\n      ${r.detail}`);
  }
}
console.log(`\nEvidence written to ${file}\n`);

process.exit(failed > 0 ? 1 : 0);
