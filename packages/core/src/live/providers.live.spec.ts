import { Chain } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import { chainConfig } from '../config/chains.js';
import { evmPool, getEvmBlockNumber } from '../evm/clients.js';
import { getErc20Metadata } from '../evm/tokens.js';
import { getDexscreenerMarket } from '../market/dexscreener.js';
import { getMarketSnapshot } from '../market/index.js';
import { telegram } from '../notify/telegram.js';
import { decodeSolanaTransaction } from '../solana/decoder.js';
import { confirmSolanaTransaction, executeSolanaSwap } from '../solana/executor.js';
import { buildJupiterSwap, getJupiterPrices, getJupiterQuote } from '../solana/jupiter.js';
import { MAX_SUPPORTED_TX_VERSION, WRAPPED_SOL_MINT_STR, getSlot, solanaPool } from '../solana/connection.js';
import { getKyberRoute } from '../evm/kyberswap.js';
import { TelemetryTracker } from '../engine/telemetry.js';
import { solanaSigner } from '../security/signer.js';
import { TxStatus } from '@copyra/db';

const live = process.env.LIVE_RPC_TESTS === '1';

describe.skipIf(!live)('live Solana RPC', () => {
  it('reads a real slot from Helius', async () => {
    const { slot, endpoint } = await getSlot();
    expect(slot).toBeGreaterThan(300_000_000);
    expect(endpoint).toContain('helius-rpc.com');
  }, 20_000);

  it('decodes a real mainnet swap into BUY or SELL with a real signature', async () => {
    const { PublicKey } = await import('@solana/web3.js');
    const program = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    const sigs = await solanaPool().call('getSignaturesForAddress', (client) =>
      client.getSignaturesForAddress(program, { limit: 12 }),
    );
    const signatures = sigs.value.filter((s) => !s.err).map((s) => s.signature);
    expect(signatures.length).toBeGreaterThan(0);

    let decoded = null;
    for (const signature of signatures.slice(0, 8)) {
      const fetched = await solanaPool().call('getParsedTransaction', (client) =>
        client.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
          commitment: 'confirmed',
        }),
      );
      const tx = fetched.value;
      const feePayer = tx?.transaction.message.accountKeys[0]?.pubkey.toBase58();
      if (!tx || !feePayer) continue;
      const result = decodeSolanaTransaction({ tx, signature, traderAddress: feePayer });
      if (result.classification === 'BUY' || result.classification === 'SELL') {
        decoded = result;
        break;
      }
    }
    expect(decoded, 'no BUY/SELL in the recent sample').not.toBeNull();
    expect(decoded?.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(decoded?.tokenIn || decoded?.tokenOut).toBeTruthy();
  }, 30_000);

  it('confirms a known historical signature by reading chain status, not by trusting send()', async () => {
    // Real mainnet signature previously decoded in evidence/providers-*.json.
    const signature = '5QQ4cZKfWxXaZ959UULnHbsLhRZikm7Ar8WpqSVRmoXdr1CQTT5dYHH3f9JEy8D84k1eSZNHWzdMkXMqxyLzCyLn';
    const status = await solanaPool().call('getSignatureStatuses', (client) =>
      client.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    );
    const value = status.value.value[0];
    expect(value, 'RPC returned no status for a known landed signature').toBeTruthy();
    expect(value?.err).toBeNull();
    expect(['confirmed', 'finalized']).toContain(value?.confirmationStatus);
    expect(value?.slot).toBeGreaterThan(0);
  }, 20_000);
});

describe.skipIf(!live)('live Jupiter', () => {
  it('returns a real 0.1 SOL → USDC quote with a non-zero outAmount', async () => {
    const quote = await getJupiterQuote({
      inputMint: WRAPPED_SOL_MINT_STR,
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountRaw: '100000000',
      slippageBps: 100,
    });
    expect(BigInt(quote.quote.outAmount)).toBeGreaterThan(0n);
    expect(quote.quote.otherAmountThreshold).toBeTruthy();
    expect(Number.isFinite(quote.priceImpactPct)).toBe(true);
  }, 20_000);

  it('builds an unsigned VersionedTransaction against live pool state', async () => {
    const { VersionedTransaction } = await import('@solana/web3.js');
    const quote = await getJupiterQuote({
      inputMint: WRAPPED_SOL_MINT_STR,
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountRaw: '10000000',
      slippageBps: 100,
    });
    const built = await buildJupiterSwap({
      quote: quote.quote,
      userPublicKey: 'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG',
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
    expect(tx.message.compiledInstructions.length).toBeGreaterThan(0);
    expect(built.lastValidBlockHeight).toBeGreaterThan(0);
  }, 20_000);

  it('reads a live SOL USD price with a blockId', async () => {
    const prices = await getJupiterPrices([WRAPPED_SOL_MINT_STR]);
    const sol = prices.get(WRAPPED_SOL_MINT_STR);
    expect(sol).toBeTruthy();
    expect(sol!.usdPrice).toBeGreaterThan(1);
    expect(sol!.usdPrice).toBeLessThan(10_000);
  }, 15_000);
});

describe.skipIf(!live)('live EVM RPC + KyberSwap', () => {
  it('matches configured chain ids on Ethereum, Base, Arbitrum and BNB', async () => {
    for (const chain of [Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM, Chain.BSC]) {
      const { blockNumber } = await getEvmBlockNumber(chain);
      const id = await evmPool(chain).call('getChainId', (client) => client.getChainId());
      expect(id.value).toBe(chainConfig(chain).chainId);
      expect(blockNumber).toBeGreaterThan(0n);
    }
  }, 30_000);

  it('reads USDC decimals from the Base contract (never assumes 18)', async () => {
    const usdc = chainConfig(Chain.BASE).stableAsset as string;
    const metadata = await getErc20Metadata(Chain.BASE, usdc);
    expect(metadata.decimals).toBe(6);
    expect(metadata.symbol).toBe('USDC');
  }, 15_000);

  it('returns a real KyberSwap route on Base', async () => {
    const config = chainConfig(Chain.BASE);
    const route = await getKyberRoute({
      chain: Chain.BASE,
      tokenIn: config.quoteAsset,
      tokenOut: config.stableAsset as string,
      amountInRaw: (10n ** BigInt(config.quoteAssetDecimals - 2)).toString(),
    });
    expect(BigInt(route.amountOutRaw)).toBeGreaterThan(0n);
    expect(route.routerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 20_000);
});

describe.skipIf(!live)('live market data', () => {
  it('reads BONK market cap and liquidity from Dexscreener', async () => {
    const bonk = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const market = await getDexscreenerMarket(Chain.SOLANA, bonk);
    expect(market.missing).toBe(false);
    expect(market.marketCapUsd).toBeGreaterThan(0);
    expect(market.liquidityUsd).toBeGreaterThan(0);
  }, 15_000);

  it('cross-checks the Jupiter price into the unified snapshot', async () => {
    const snapshot = await getMarketSnapshot(
      Chain.SOLANA,
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    );
    expect(snapshot.source).toMatch(/jupiter/);
    expect(snapshot.priceUsd).toBeGreaterThan(0);
  }, 15_000);
});

describe.skipIf(!live)('live Telegram', () => {
  it('can see the Copyra bot group', async () => {
    const verification = await telegram.verify();
    expect(verification.tokenValid).toBe(true);
    expect(verification.botUsername).toBe('copyrafun_bot');
    expect(verification.canPostToChat).toBe(true);
    expect(verification.chatTitle).toBe('Copyra bot');
  }, 15_000);
});

describe.skipIf(!live)('live execution guards', () => {
  it('refuses to broadcast a Solana swap when no signing key is configured', async () => {
    expect(solanaSigner.available).toBe(false);
    const outcome = await executeSolanaSwap({
      inputMint: WRAPPED_SOL_MINT_STR,
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountRaw: '1000000',
      slippageBps: 100,
      maxPriceImpactPct: 3,
      quoteMaxAgeMs: 3_000,
      confirmTimeoutMs: 1_000,
      maxAttempts: 1,
      telemetry: new TelemetryTracker(),
      idempotencyKey: 'test-no-signer',
    });
    expect(outcome.status).toBe(TxStatus.FAILED);
    expect(outcome.errorCode).toBe('NO_SIGNER');
    expect(outcome.txHash).toBeNull();
    expect(outcome.attemptLog.some((a) => a.stage === 'broadcast' && a.outcome === 'ok')).toBe(false);
  }, 10_000);

  it('does not treat confirmSolanaTransaction timeout as CONFIRMED', async () => {
    // A signature that cannot exist. The poller must return UNKNOWN or EXPIRED,
    // never CONFIRMED, because the chain never saw this transaction.
    const result = await confirmSolanaTransaction('1'.repeat(88), 1, 800);
    expect(result.status).not.toBe(TxStatus.CONFIRMED);
    expect([TxStatus.UNKNOWN, TxStatus.EXPIRED, TxStatus.FAILED]).toContain(result.status);
  }, 15_000);
});
