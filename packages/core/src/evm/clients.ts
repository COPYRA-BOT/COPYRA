import { Chain } from '@copyra/db';
import {
  createPublicClient,
  defineChain,
  http,
  webSocket,
  type PublicClient,
  type Chain as ViemChain,
} from 'viem';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';
import { chainConfig, evmChains, type ChainConfig } from '../config/chains.js';
import { componentLogger } from '../obs/logger.js';
import { RpcPool } from '../rpc/pool.js';

const log = componentLogger('evm-rpc');

/**
 * Chains viem does not ship a definition for are defined here from their real
 * on-chain parameters. The chain ids were read from each endpoint with
 * `eth_chainId` rather than copied from documentation — see docs/AUDIT.md §1.
 */
const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const hyperliquidEvm = defineChain({
  id: 999,
  name: 'Hyperliquid EVM',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const tronEvm = defineChain({
  id: 728126428,
  name: 'Tron (JSON-RPC shim)',
  nativeCurrency: { name: 'TRX', symbol: 'TRX', decimals: 6 },
  rpcUrls: { default: { http: [] } },
});

const VIEM_CHAINS: Partial<Record<Chain, ViemChain>> = {
  ETHEREUM: mainnet,
  BASE: base,
  ARBITRUM: arbitrum,
  BSC: bsc,
  POLYGON: polygon,
  OPTIMISM: optimism,
  ARC: arc,
  ROBINHOOD: robinhoodChain,
  HYPERLIQUID: hyperliquidEvm,
  TRON: tronEvm,
};

export function viemChain(chain: Chain): ViemChain {
  const definition = VIEM_CHAINS[chain];
  if (!definition) throw new Error(`No viem chain definition for ${chain}`);
  return definition;
}

const pools = new Map<Chain, RpcPool<PublicClient>>();

export function evmPool(chain: Chain): RpcPool<PublicClient> {
  let pool = pools.get(chain);
  if (!pool) {
    const config = chainConfig(chain);
    if (config.kind !== 'evm') throw new Error(`${chain} is not an EVM chain`);
    if (!config.rpcUrl) throw new Error(`No RPC URL configured for ${chain}`);

    pool = new RpcPool<PublicClient>(
      { chain, urls: [config.rpcUrl, ...config.rpcFallbacks] },
      (url) =>
        createPublicClient({
          chain: viemChain(chain),
          transport: http(url, { timeout: 10_000, retryCount: 1 }),
          batch: { multicall: { wait: 16 } },
        }) as PublicClient,
    );
    pools.set(chain, pool);
    log.info({ chain, endpoints: pool.size }, 'EVM RPC pool initialised');
  }
  return pool;
}

export function evmClient(chain: Chain): PublicClient {
  return evmPool(chain).primary().client;
}

const wsClients = new Map<Chain, PublicClient>();
const wsEndpointIndex = new Map<Chain, number>();

function wsEndpoints(config: ChainConfig): string[] {
  return [config.wsUrl, ...config.wsFallbacks].filter((u): u is string => Boolean(u));
}

/** WebSocket client for live subscriptions. Separate from the HTTP pool. */
export function evmWsClient(chain: Chain, recreate = false): PublicClient | null {
  const config = chainConfig(chain);
  const endpoints = wsEndpoints(config);
  if (endpoints.length === 0) return null;

  if (recreate) {
    wsClients.delete(chain);
    const prev = wsEndpointIndex.get(chain) ?? 0;
    wsEndpointIndex.set(chain, (prev + 1) % endpoints.length);
  }

  let client = wsClients.get(chain);
  if (!client) {
    const idx = wsEndpointIndex.get(chain) ?? 0;
    const url = endpoints[idx % endpoints.length]!;
    client = createPublicClient({
      chain: viemChain(chain),
      transport: webSocket(url, {
        reconnect: { attempts: Number.POSITIVE_INFINITY, delay: 1_000 },
        keepAlive: { interval: 15_000 },
        timeout: 20_000,
      }),
    }) as PublicClient;
    wsClients.set(chain, client);
    log.info(
      { chain, wsIndex: idx, wsEndpoints: endpoints.length },
      'EVM WebSocket client ready',
    );
  }
  return client;
}

export async function getEvmBlockNumber(chain: Chain): Promise<{
  blockNumber: bigint;
  endpoint: string;
  latencyMs: number;
}> {
  const result = await evmPool(chain).call('getBlockNumber', (client) => client.getBlockNumber());
  return { blockNumber: result.value, endpoint: result.endpoint, latencyMs: result.latencyMs };
}

/** Chains with a configured RPC, regardless of whether execution is allowed. */
export function configuredEvmChains(): ChainConfig[] {
  return evmChains();
}

/** Quote assets treated as genuine expenditure on an EVM chain. */
export function evmQuoteAssets(chain: Chain): Set<string> {
  const config = chainConfig(chain);
  const assets = new Set<string>();
  if (config.quoteAsset) assets.add(config.quoteAsset.toLowerCase());
  if (config.stableAsset) assets.add(config.stableAsset.toLowerCase());
  // Native ETH/BNB is represented by the zero/sentinel address in router calls.
  assets.add('0x0000000000000000000000000000000000000000');
  assets.add('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  return assets;
}
