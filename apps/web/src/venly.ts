/**
 * Venly (EVM) — organized wrapper around @venly/web3-provider.
 *
 * Venly is a custodial widget (email / social login), NOT the Reown
 * multi-wallet catalog. COPYRA uses Reown AppKit for Trust / MetaMask /
 * Phantom / All Wallets QR, and Venly as an optional EVM path when
 * VITE_VENLY_CLIENT_ID is set.
 *
 * We use the EIP-1193 provider directly (provider.request) — no web3.js.
 */
import { VenlyProvider, SecretType, WindowMode } from '@venly/web3-provider';

export type VenlyChain = 'ETHEREUM' | 'BASE' | 'ARBITRUM' | 'BSC' | 'POLYGON' | 'OPTIMISM';

export type VenlyPublicConfig = {
  clientId: string;
  environment: 'production' | 'sandbox';
};

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

let venly: VenlyProvider | null = null;
let provider: Eip1193Provider | null = null;
let activeAddress: string | null = null;
let activeChain: VenlyChain = 'ETHEREUM';

function normalizeEnvironment(raw: string | undefined): 'production' | 'sandbox' {
  const v = (raw ?? 'production').trim().toLowerCase();
  if (v === 'sandbox' || v === 'staging' || v === 'dev' || v === 'development') return 'sandbox';
  return 'production';
}

function secretTypeFor(chain: VenlyChain): SecretType {
  const map: Record<VenlyChain, SecretType> = {
    ETHEREUM: SecretType.ETHEREUM,
    BSC: SecretType.BSC,
    POLYGON: SecretType.MATIC,
    // Newer Venly chains — fall back to ETHEREUM if the enum build is older.
    BASE: (SecretType as Record<string, SecretType>).BASE ?? SecretType.ETHEREUM,
    ARBITRUM: (SecretType as Record<string, SecretType>).ARBITRUM ?? SecretType.ETHEREUM,
    OPTIMISM: (SecretType as Record<string, SecretType>).OPTIMISM ?? SecretType.ETHEREUM,
  };
  return map[chain];
}

function chainIdFor(chain: VenlyChain): number {
  switch (chain) {
    case 'BASE':
      return 8453;
    case 'ARBITRUM':
      return 42161;
    case 'BSC':
      return 56;
    case 'POLYGON':
      return 137;
    case 'OPTIMISM':
      return 10;
    default:
      return 1;
  }
}

export function venlyChainFromId(chainId: number | undefined): VenlyChain {
  if (chainId === 8453) return 'BASE';
  if (chainId === 42161) return 'ARBITRUM';
  if (chainId === 56) return 'BSC';
  if (chainId === 137) return 'POLYGON';
  if (chainId === 10) return 'OPTIMISM';
  return 'ETHEREUM';
}

export function isVenlyConfigured(config: VenlyPublicConfig | null | undefined): boolean {
  return Boolean(config?.clientId?.trim());
}

export async function connectVenly(
  config: VenlyPublicConfig,
  preferred: VenlyChain = 'ETHEREUM',
): Promise<{ address: string; chain: VenlyChain; provider: Eip1193Provider }> {
  const clientId = config.clientId.trim();
  if (!clientId) {
    throw new Error('Venly client id missing. Set VITE_VENLY_CLIENT_ID on the host.');
  }

  venly = new VenlyProvider();
  provider = (await venly.createProvider({
    clientId,
    environment: normalizeEnvironment(config.environment),
    windowMode: WindowMode.POPUP,
    secretType: secretTypeFor(preferred),
    skipAuthentication: false,
  })) as Eip1193Provider;

  // Prefer the requested chain after auth (Venly may open on ETHEREUM by default).
  if (preferred !== 'ETHEREUM') {
    try {
      provider = (await venly.changeSecretType(
        secretTypeFor(preferred),
        String(chainIdFor(preferred)),
      )) as Eip1193Provider;
    } catch {
      /* stay on whatever Venly authenticated */
    }
  }

  const accounts = (await provider.request({
    method: 'eth_requestAccounts',
    params: [],
  })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error('Venly returned no EVM account.');

  let chainId = chainIdFor(preferred);
  try {
    const raw = await provider.request({ method: 'eth_chainId', params: [] });
    chainId = Number.parseInt(String(raw), 16) || chainId;
  } catch {
    /* use preferred */
  }

  activeAddress = address;
  activeChain = venlyChainFromId(chainId);
  return { address, chain: activeChain, provider };
}

export function getVenlyProvider(): Eip1193Provider | null {
  return provider;
}

export function getVenlyAddress(): string | null {
  return activeAddress;
}

export async function switchVenlyChain(chain: VenlyChain): Promise<Eip1193Provider> {
  if (!venly) throw new Error('Connect Venly first.');
  provider = (await venly.changeSecretType(
    secretTypeFor(chain),
    String(chainIdFor(chain)),
  )) as Eip1193Provider;
  activeChain = chain;
  try {
    const accounts = (await provider.request({
      method: 'eth_accounts',
      params: [],
    })) as string[];
    if (accounts?.[0]) activeAddress = accounts[0];
  } catch {
    /* keep previous address */
  }
  return provider;
}

export async function disconnectVenly(): Promise<void> {
  try {
    await venly?.logout();
  } catch {
    /* ignore */
  }
  venly = null;
  provider = null;
  activeAddress = null;
  activeChain = 'ETHEREUM';
}

export async function venlyProfile(): Promise<unknown | null> {
  try {
    // VenlyConnect exposes widget APIs on `.api` (not connect().api).
    return (await venly?.connect?.api?.getProfile?.()) ?? null;
  } catch {
    return null;
  }
}
