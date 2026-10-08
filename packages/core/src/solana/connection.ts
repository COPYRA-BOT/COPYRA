import { Chain } from '@copyra/db';
import { Connection, PublicKey, type Commitment } from '@solana/web3.js';
import { chainConfig } from '../config/chains.js';
import { componentLogger } from '../obs/logger.js';
import { RpcPool } from '../rpc/pool.js';

const log = componentLogger('solana-rpc');

/**
 * Highest Solana transaction version this client will accept.
 *
 * Must be raised as the network ships new versions. Requesting a version lower
 * than what a block contains makes the RPC reject the whole `getTransaction`
 * call, which silently blinds the monitor to exactly the modern
 * address-lookup-table transactions that aggregator swaps use. Found by live
 * verification against mainnet, where v1 transactions are now in production.
 */
export const MAX_SUPPORTED_TX_VERSION = 1;

export const WRAPPED_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const WRAPPED_SOL_MINT_STR = 'So11111111111111111111111111111111111111112';
export const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT_STR = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Assets treated as "money spent" when deciding whether a swap was a real buy. */
export const SOLANA_QUOTE_ASSETS = new Set([
  WRAPPED_SOL_MINT_STR,
  USDC_MINT_STR,
  USDT_MINT_STR,
]);

/** Known swap venues, used to attribute a trade and to reject non-DEX activity. */
export const SOLANA_DEX_PROGRAMS: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter v6',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: 'Jupiter v4',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  routeUb9GDLDqBfHjmGZUwqBUFuNr3EpqqDPvPFnQxFL: 'Raydium Route',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca v1',
  SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ: 'Saber',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'Pump.fun AMM',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora Pools',
  PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP: 'Penguin',
  obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y: 'Obric',
  SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe: 'SolFi',
  ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY: 'Zeta',
  stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq: 'Stake Pool',
};

/** Programs that indicate the transaction was not a trade. */
export const SOLANA_NON_TRADE_PROGRAMS: Record<string, string> = {
  Stake11111111111111111111111111111111111111: 'stake',
  SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: 'stake-pool',
  MerkDistrqLPEFHnKcVnDJZEkqJJcRRpC9L4b1PkbQF: 'merkle-distributor',
  mERKcfxMC5SqJn4Ld4BUris3WKZZ1ojjWJ3A3J5CKxv: 'merkle-distributor',
  wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb: 'bridge',
  worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth: 'bridge',
  DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh: 'bridge',
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 'nft-marketplace',
  mv3ekLzLbnVPNxjSKvqBpU3ZeZXPQdEC3bp5MDEBG68: 'nft-marketplace',
};

function createConnection(url: string, wsEndpoint?: string): Connection {
  return new Connection(url, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
    confirmTransactionInitialTimeout: 60_000,
    // Helius/Alchemy require the dedicated WSS URL for onLogs; deriving from HTTPS
    // often leaves subscriptions dead after idle disconnects.
    ...(wsEndpoint ? { wsEndpoint } : {}),
  });
}

let pool: RpcPool<Connection> | undefined;
/** Dedicated subscription connection (always uses SOLANA_WS_URL when set). */
let subscriptionConnection: Connection | undefined;

export function solanaPool(): RpcPool<Connection> {
  if (!pool) {
    const config = chainConfig(Chain.SOLANA);
    if (!config.rpcUrl) {
      throw new Error('SOLANA_RPC_URL is not configured; Solana monitoring is unavailable.');
    }
    const primaryUrl = config.rpcUrl;
    const primaryWs = config.wsUrl;
    pool = new RpcPool<Connection>(
      { chain: Chain.SOLANA, urls: [config.rpcUrl, ...config.rpcFallbacks] },
      (url) => createConnection(url, url === primaryUrl ? primaryWs : undefined),
    );
    log.info(
      { endpoints: pool.size, ws: Boolean(primaryWs) },
      'Solana RPC pool initialised',
    );
  }
  return pool;
}

/** Primary connection, for WebSocket subscriptions which cannot fail over mid-stream. */
export function solanaConnection(): Connection {
  return solanaSubscriptionConnection();
}

/**
 * Fresh subscription connection bound to SOLANA_WS_URL.
 * Call again after a forced resubscribe so a dead WS socket is replaced.
 */
export function solanaSubscriptionConnection(recreate = false): Connection {
  if (!subscriptionConnection || recreate) {
    const config = chainConfig(Chain.SOLANA);
    if (!config.rpcUrl) {
      throw new Error('SOLANA_RPC_URL is not configured; Solana monitoring is unavailable.');
    }
    // Replace the Connection object; web3.js does not reliably recover onLogs after idle WS death.
    subscriptionConnection = createConnection(config.rpcUrl, config.wsUrl);
    log.info({ ws: Boolean(config.wsUrl), recreate }, 'Solana subscription connection ready');
  }
  return subscriptionConnection;
}

/** Current slot, confirming the RPC is genuinely live. */
export async function getSlot(commitment: Commitment = 'confirmed'): Promise<{
  slot: number;
  endpoint: string;
  latencyMs: number;
}> {
  const result = await solanaPool().call('getSlot', (client) => client.getSlot(commitment));
  return { slot: result.value, endpoint: result.endpoint, latencyMs: result.latencyMs };
}

export async function getBlockHeight(): Promise<number> {
  const result = await solanaPool().call('getBlockHeight', (client) => client.getBlockHeight());
  return result.value;
}
