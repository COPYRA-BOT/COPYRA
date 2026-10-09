import { Chain } from '@copyra/db';
import { env } from './env.js';

/**
 * Chain registry.
 *
 * `canExecute` is the honest answer to "can COPYRA actually place a swap here".
 * It is false wherever no real swap route source has been verified. Execution
 * on such a chain throws rather than returning a fabricated success — see
 * docs/AUDIT.md §2.
 */
export interface ChainConfig {
  chain: Chain;
  /** Human label used in Telegram titles and the UI. */
  label: string;
  /** Short code used in the Telegram title line: SOL / BASE / ARB / BNB. */
  code: string;
  kind: 'solana' | 'evm';
  /** EVM chain id. Undefined for Solana. */
  chainId?: number;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Mint (Solana) or wrapped-native ERC-20 used as the quote asset. */
  quoteAsset: string;
  quoteAssetSymbol: string;
  quoteAssetDecimals: number;
  /** Stablecoin used for USD-denominated routing checks, when available. */
  stableAsset?: string;
  stableAssetSymbol?: string;
  stableAssetDecimals?: number;
  explorerTxBase: string;
  explorerTokenBase: string;
  explorerName: string;
  /** Where a real swap route comes from, or null if none is verified. */
  routeProvider: 'jupiter' | 'kyberswap' | null;
  /** KyberSwap network slug. */
  kyberSlug?: string;
  /** Dexscreener chain slug for market data. */
  dexscreenerSlug?: string;
  rpcUrl?: string;
  wsUrl?: string;
  /** Extra WSS endpoints (paid backups). Used when the primary subscription socket dies. */
  wsFallbacks: string[];
  rpcFallbacks: string[];
  /**
   * False = monitor only. The executor refuses to build a transaction and the
   * dashboard renders a "Monitor only" badge.
   */
  canExecute: boolean;
  /** Shown verbatim in the UI when canExecute is false. */
  executionBlockedReason?: string;
  /** Approximate block time, used to size confirmation deadlines. */
  blockTimeMs: number;
  requiredConfirmations: number;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  SOLANA: {
    chain: Chain.SOLANA,
    label: 'Solana',
    code: 'SOL',
    kind: 'solana',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    quoteAsset: SOL_MINT,
    quoteAssetSymbol: 'SOL',
    quoteAssetDecimals: 9,
    stableAsset: USDC_SOLANA,
    stableAssetSymbol: 'USDC',
    stableAssetDecimals: 6,
    explorerTxBase: 'https://solscan.io/tx/',
    explorerTokenBase: 'https://solscan.io/token/',
    explorerName: 'Solscan',
    routeProvider: 'jupiter',
    dexscreenerSlug: 'solana',
    rpcUrl: env.SOLANA_RPC_URL,
    wsUrl: env.SOLANA_WS_URL,
    wsFallbacks: [env.SOLANA_BACKUP_WS_URL].filter((u): u is string => Boolean(u)),
    // Paid backup first, then CSV fallbacks, then public endpoints.
    rpcFallbacks: [
      env.SOLANA_BACKUP_RPC_URL,
      ...env.SOLANA_RPC_FALLBACK_URLS,
      'https://solana-rpc.publicnode.com',
      'https://api.mainnet-beta.solana.com',
    ].filter((url, i, all): url is string => Boolean(url) && all.indexOf(url) === i),
    canExecute: Boolean(env.SOLANA_RPC_URL),
    blockTimeMs: 400,
    requiredConfirmations: 1,
  },
  ETHEREUM: {
    chain: Chain.ETHEREUM,
    label: 'Ethereum',
    code: 'ETH',
    kind: 'evm',
    chainId: 1,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    quoteAsset: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    quoteAssetSymbol: 'WETH',
    quoteAssetDecimals: 18,
    stableAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    stableAssetSymbol: 'USDC',
    stableAssetDecimals: 6,
    explorerTxBase: 'https://etherscan.io/tx/',
    explorerTokenBase: 'https://etherscan.io/token/',
    explorerName: 'Etherscan',
    routeProvider: 'kyberswap',
    kyberSlug: 'ethereum',
    dexscreenerSlug: 'ethereum',
    rpcUrl: env.EVM_ETHEREUM_RPC_URL,
    wsUrl: env.EVM_ETHEREUM_WS_URL,
    wsFallbacks: [],
    // Public fallbacks survive Alchemy 429s so custody balances stay readable.
    rpcFallbacks: ['https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth'],
    canExecute: Boolean(env.EVM_ETHEREUM_RPC_URL),
    blockTimeMs: 12_000,
    requiredConfirmations: 1,
  },
  BASE: {
    chain: Chain.BASE,
    label: 'Base',
    code: 'BASE',
    kind: 'evm',
    chainId: 8453,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    quoteAsset: '0x4200000000000000000000000000000000000006',
    quoteAssetSymbol: 'WETH',
    quoteAssetDecimals: 18,
    stableAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    stableAssetSymbol: 'USDC',
    stableAssetDecimals: 6,
    explorerTxBase: 'https://basescan.org/tx/',
    explorerTokenBase: 'https://basescan.org/token/',
    explorerName: 'Basescan',
    routeProvider: 'kyberswap',
    kyberSlug: 'base',
    dexscreenerSlug: 'base',
    rpcUrl: env.EVM_BASE_RPC_URL,
    wsUrl: env.EVM_BASE_WS_URL,
    wsFallbacks: [],
    rpcFallbacks: ['https://base.publicnode.com', 'https://mainnet.base.org'],
    canExecute: Boolean(env.EVM_BASE_RPC_URL),
    blockTimeMs: 2_000,
    requiredConfirmations: 1,
  },
  ARBITRUM: {
    chain: Chain.ARBITRUM,
    label: 'Arbitrum',
    code: 'ARB',
    kind: 'evm',
    chainId: 42161,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    quoteAsset: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    quoteAssetSymbol: 'WETH',
    quoteAssetDecimals: 18,
    stableAsset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    stableAssetSymbol: 'USDC',
    stableAssetDecimals: 6,
    explorerTxBase: 'https://arbiscan.io/tx/',
    explorerTokenBase: 'https://arbiscan.io/token/',
    explorerName: 'Arbiscan',
    routeProvider: 'kyberswap',
    kyberSlug: 'arbitrum',
    dexscreenerSlug: 'arbitrum',
    rpcUrl: env.EVM_ARBITRUM_RPC_URL,
    wsUrl: env.EVM_ARBITRUM_WS_URL,
    wsFallbacks: [],
    rpcFallbacks: ['https://arbitrum-one.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    canExecute: Boolean(env.EVM_ARBITRUM_RPC_URL),
    blockTimeMs: 250,
    requiredConfirmations: 1,
  },
  BSC: {
    chain: Chain.BSC,
    label: 'BNB Chain',
    code: 'BNB',
    kind: 'evm',
    chainId: 56,
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    quoteAsset: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    quoteAssetSymbol: 'WBNB',
    quoteAssetDecimals: 18,
    stableAsset: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    stableAssetSymbol: 'USDC',
    stableAssetDecimals: 18,
    explorerTxBase: 'https://bscscan.com/tx/',
    explorerTokenBase: 'https://bscscan.com/token/',
    explorerName: 'BscScan',
    routeProvider: 'kyberswap',
    kyberSlug: 'bsc',
    dexscreenerSlug: 'bsc',
    rpcUrl: env.EVM_BSC_RPC_URL,
    wsUrl: env.EVM_BSC_WS_URL,
    wsFallbacks: [env.EVM_BSC_BACKUP_WS_URL].filter((u): u is string => Boolean(u)),
    // Paid QuickNode backup first, then public endpoints.
    rpcFallbacks: [
      env.EVM_BSC_BACKUP_RPC_URL,
      'https://bsc.publicnode.com',
      'https://bsc-dataseed.binance.org',
    ].filter((url, i, all): url is string => Boolean(url) && all.indexOf(url) === i),
    canExecute: Boolean(env.EVM_BSC_RPC_URL),
    blockTimeMs: 1_500,
    requiredConfirmations: 1,
  },
  POLYGON: {
    chain: Chain.POLYGON,
    label: 'Polygon',
    code: 'POL',
    kind: 'evm',
    chainId: 137,
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    quoteAsset: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    quoteAssetSymbol: 'WPOL',
    quoteAssetDecimals: 18,
    stableAsset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    stableAssetSymbol: 'USDC',
    stableAssetDecimals: 6,
    explorerTxBase: 'https://polygonscan.com/tx/',
    explorerTokenBase: 'https://polygonscan.com/token/',
    explorerName: 'PolygonScan',
    routeProvider: 'kyberswap',
    kyberSlug: 'polygon',
    dexscreenerSlug: 'polygon',
    rpcUrl: env.EVM_POLYGON_RPC_URL,
    wsUrl: env.EVM_POLYGON_WS_URL,
    wsFallbacks: [],
    rpcFallbacks: [],
    canExecute: Boolean(env.EVM_POLYGON_RPC_URL),
    blockTimeMs: 2_000,
    requiredConfirmations: 1,
  },
  OPTIMISM: {
    chain: Chain.OPTIMISM,
    label: 'Optimism',
    code: 'OP',
    kind: 'evm',
    chainId: 10,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    quoteAsset: '0x4200000000000000000000000000000000000006',
    quoteAssetSymbol: 'WETH',
    quoteAssetDecimals: 18,
    stableAsset: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    stableAssetSymbol: 'USDC',
    stableAssetDecimals: 6,
    explorerTxBase: 'https://optimistic.etherscan.io/tx/',
    explorerTokenBase: 'https://optimistic.etherscan.io/token/',
    explorerName: 'Optimistic Etherscan',
    routeProvider: 'kyberswap',
    kyberSlug: 'optimism',
    dexscreenerSlug: 'optimism',
    rpcUrl: env.EVM_OPTIMISM_RPC_URL,
    wsUrl: env.EVM_OPTIMISM_WS_URL,
    wsFallbacks: [],
    rpcFallbacks: [],
    canExecute: Boolean(env.EVM_OPTIMISM_RPC_URL),
    blockTimeMs: 2_000,
    requiredConfirmations: 1,
  },

  // --- Tier 2: reachable RPC, but no verified swap route source. ---
  ARC: {
    chain: Chain.ARC,
    label: 'Arc',
    code: 'ARC',
    kind: 'evm',
    chainId: 5042,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    quoteAsset: '',
    quoteAssetSymbol: 'ETH',
    quoteAssetDecimals: 18,
    explorerTxBase: 'https://explorer.arc.network/tx/',
    explorerTokenBase: 'https://explorer.arc.network/token/',
    explorerName: 'Arc Explorer',
    routeProvider: null,
    rpcUrl: env.EVM_ARC_RPC_URL,
    wsUrl: env.EVM_ARC_WS_URL,
    wsFallbacks: [],
    rpcFallbacks: [],
    canExecute: false,
    executionBlockedReason:
      'No swap aggregator with verified liquidity routing on Arc (chain 5042). Monitoring and decoding are live; execution is disabled rather than faked.',
    blockTimeMs: 2_000,
    requiredConfirmations: 1,
  },
  ROBINHOOD: {
    chain: Chain.ROBINHOOD,
    label: 'Robinhood Chain',
    code: 'RHC',
    kind: 'evm',
    chainId: 4663,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    quoteAsset: '',
    quoteAssetSymbol: 'ETH',
    quoteAssetDecimals: 18,
    explorerTxBase: 'https://explorer.robinhood.com/tx/',
    explorerTokenBase: 'https://explorer.robinhood.com/token/',
    explorerName: 'Robinhood Explorer',
    routeProvider: null,
    rpcUrl: env.EVM_ROBINHOOD_RPC_URL,
    wsUrl: env.EVM_ROBINHOOD_WS_URL,
    wsFallbacks: [],
    rpcFallbacks: [],
    canExecute: false,
    executionBlockedReason:
      'No DEX aggregator coverage found for Robinhood Chain (4663). Monitoring only.',
    blockTimeMs: 2_000,
    requiredConfirmations: 1,
  },
  HYPERLIQUID: {
    chain: Chain.HYPERLIQUID,
    label: 'Hyperliquid EVM',
    code: 'HYPE',
    kind: 'evm',
    chainId: 999,
    nativeSymbol: 'HYPE',
    nativeDecimals: 18,
    quoteAsset: '',
    quoteAssetSymbol: 'HYPE',
    quoteAssetDecimals: 18,
    explorerTxBase: 'https://hyperevmscan.io/tx/',
    explorerTokenBase: 'https://hyperevmscan.io/token/',
    explorerName: 'HyperEVMScan',
    routeProvider: null,
    rpcUrl: env.EVM_HYPERLIQUID_RPC_URL,
    wsUrl: env.EVM_HYPERLIQUID_WS_URL,
    wsFallbacks: [],
    rpcFallbacks: [],
    canExecute: false,
    executionBlockedReason:
      'KyberSwap reports Hyperliquid as an unsupported chain. HyperCore order placement is a separate non-EVM API and is not a swap router. Monitoring only.',
    blockTimeMs: 2_000,
    requiredConfirmations: 1,
  },
  TRON: {
    chain: Chain.TRON,
    label: 'Tron',
    code: 'TRX',
    kind: 'evm',
    chainId: 728126428,
    nativeSymbol: 'TRX',
    nativeDecimals: 6,
    quoteAsset: '',
    quoteAssetSymbol: 'TRX',
    quoteAssetDecimals: 6,
    explorerTxBase: 'https://tronscan.org/#/transaction/',
    explorerTokenBase: 'https://tronscan.org/#/token20/',
    explorerName: 'Tronscan',
    routeProvider: null,
    rpcUrl: env.EVM_TRON_RPC_URL,
    wsFallbacks: [],
    rpcFallbacks: [],
    canExecute: false,
    executionBlockedReason:
      'Tron is TVM, not EVM: different address encoding and a different transaction envelope. The JSON-RPC endpoint is a read-only compatibility shim, so an EVM-signed transaction would not be a valid Tron transaction. Monitoring only; real support needs TronWeb.',
    blockTimeMs: 3_000,
    requiredConfirmations: 1,
  },
};

export function chainConfig(chain: Chain): ChainConfig {
  const config = CHAIN_CONFIGS[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);
  return config;
}

/** Chains with a configured RPC — monitoring is possible. */
export function monitorableChains(): ChainConfig[] {
  return Object.values(CHAIN_CONFIGS).filter((c) => Boolean(c.rpcUrl));
}

/** Chains where a real swap can actually be built and broadcast. */
export function executableChains(): ChainConfig[] {
  return monitorableChains().filter((c) => c.canExecute && c.routeProvider !== null);
}

export function evmChains(): ChainConfig[] {
  return monitorableChains().filter((c) => c.kind === 'evm');
}

export function explorerTxUrl(chain: Chain, txHash: string): string {
  return `${chainConfig(chain).explorerTxBase}${txHash}`;
}

export function explorerTokenUrl(chain: Chain, address: string): string {
  return `${chainConfig(chain).explorerTokenBase}${address}`;
}

export class ChainNotExecutableError extends Error {
  readonly chain: Chain;
  readonly code = 'CHAIN_NOT_EXECUTABLE';

  constructor(chain: Chain) {
    const config = chainConfig(chain);
    super(
      `${config.label} is monitor-only and cannot execute swaps. ` +
        (config.executionBlockedReason ?? 'No verified swap route provider.'),
    );
    this.name = 'ChainNotExecutableError';
    this.chain = chain;
  }
}

export function assertExecutable(chain: Chain): ChainConfig {
  const config = chainConfig(chain);
  if (!config.canExecute || config.routeProvider === null) {
    throw new ChainNotExecutableError(chain);
  }
  return config;
}
