import { PublicKey } from '@solana/web3.js';
import { componentLogger } from '../obs/logger.js';
import { solanaPool } from './connection.js';

const log = componentLogger('token-supply');

/**
 * Circulating/ui amount for market-cap = price × supply when Dexscreener has
 * not indexed marketCap/fdv yet (common on brand-new pump launches).
 */
export async function getSolanaTokenUiSupply(mint: string): Promise<number | null> {
  try {
    const pubkey = new PublicKey(mint);
    const result = await solanaPool().call('getTokenSupply', (client) =>
      client.getTokenSupply(pubkey, 'confirmed'),
    );
    const ui = result.value.value.uiAmount;
    if (typeof ui === 'number' && Number.isFinite(ui) && ui > 0) return ui;
    const amount = result.value.value.amount;
    const decimals = result.value.value.decimals;
    if (amount && typeof decimals === 'number') {
      const raw = Number(amount);
      if (Number.isFinite(raw) && raw > 0) return raw / 10 ** decimals;
    }
    return null;
  } catch (error) {
    log.warn({ mint, err: error }, 'getTokenSupply failed');
    return null;
  }
}
