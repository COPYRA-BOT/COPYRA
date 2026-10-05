import type { Chain } from '@copyra/db';
import { erc20Abi, getAddress, type Address } from 'viem';
import { componentLogger } from '../obs/logger.js';
import { evmPool } from './clients.js';

const log = componentLogger('evm-tokens');

export interface Erc20Metadata {
  address: string;
  symbol: string | null;
  name: string | null;
  /** Read from the contract. Never defaulted to 18. */
  decimals: number;
  totalSupply: bigint | null;
}

/**
 * Decimals cache.
 *
 * Decimals are immutable for a sane ERC-20, so caching is safe and removes a
 * round trip from the hot execution path. A wrong decimals value mis-sizes a
 * trade by orders of magnitude, so it is never assumed — a token whose
 * `decimals()` call reverts is treated as un-tradeable.
 */
const metadataCache = new Map<string, Erc20Metadata>();

function cacheKey(chain: Chain, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

export class TokenMetadataUnavailableError extends Error {
  readonly code = 'TOKEN_METADATA_UNAVAILABLE';
  constructor(chain: Chain, address: string, detail: string) {
    super(
      `Could not read ERC-20 metadata for ${address} on ${chain}: ${detail}. ` +
        'Decimals are never assumed, so this token cannot be traded.',
    );
    this.name = 'TokenMetadataUnavailableError';
  }
}

export async function getErc20Metadata(chain: Chain, address: string): Promise<Erc20Metadata> {
  const key = cacheKey(chain, address);
  const cached = metadataCache.get(key);
  if (cached) return cached;

  let checksummed: Address;
  try {
    checksummed = getAddress(address);
  } catch {
    throw new TokenMetadataUnavailableError(chain, address, 'not a valid EVM address');
  }

  const result = await evmPool(chain).call('erc20Metadata', async (client) => {
    const contract = { address: checksummed, abi: erc20Abi } as const;
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      client.readContract({ ...contract, functionName: 'decimals' }),
      client.readContract({ ...contract, functionName: 'symbol' }).catch(() => null),
      client.readContract({ ...contract, functionName: 'name' }).catch(() => null),
      client.readContract({ ...contract, functionName: 'totalSupply' }).catch(() => null),
    ]);
    return { decimals, symbol, name, totalSupply };
  });

  const decimals = Number(result.value.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new TokenMetadataUnavailableError(
      chain,
      address,
      `contract reported an implausible decimals value (${String(result.value.decimals)})`,
    );
  }

  const metadata: Erc20Metadata = {
    address: address.toLowerCase(),
    symbol: result.value.symbol,
    name: result.value.name,
    decimals,
    totalSupply: result.value.totalSupply,
  };
  metadataCache.set(key, metadata);
  log.debug({ chain, address, decimals, symbol: metadata.symbol }, 'ERC-20 metadata read from chain');
  return metadata;
}

export async function getErc20Balance(
  chain: Chain,
  token: string,
  owner: string,
): Promise<{ amountRaw: bigint; blockNumber: bigint }> {
  const result = await evmPool(chain).call('erc20BalanceOf', async (client) => {
    const [amount, blockNumber] = await Promise.all([
      client.readContract({
        address: getAddress(token),
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [getAddress(owner)],
      }),
      client.getBlockNumber(),
    ]);
    return { amount, blockNumber };
  });
  return { amountRaw: result.value.amount, blockNumber: result.value.blockNumber };
}

export async function getNativeBalance(
  chain: Chain,
  owner: string,
): Promise<{ amountRaw: bigint; blockNumber: bigint }> {
  const result = await evmPool(chain).call('getBalance', async (client) => {
    const [balance, blockNumber] = await Promise.all([
      client.getBalance({ address: getAddress(owner) }),
      client.getBlockNumber(),
    ]);
    return { balance, blockNumber };
  });
  return { amountRaw: result.value.balance, blockNumber: result.value.blockNumber };
}

export async function getErc20Allowance(
  chain: Chain,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const result = await evmPool(chain).call('erc20Allowance', (client) =>
    client.readContract({
      address: getAddress(token),
      abi: erc20Abi,
      functionName: 'allowance',
      args: [getAddress(owner), getAddress(spender)],
    }),
  );
  return result.value;
}

export function clearTokenCache(): void {
  metadataCache.clear();
}
