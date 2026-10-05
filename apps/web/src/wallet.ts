import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import {
  solana,
  mainnet,
  base,
  arbitrum,
  bsc,
  polygon,
  optimism,
} from '@reown/appkit/networks';
import { QueryClient } from '@tanstack/react-query';

export type WalletMode = 'sol' | 'evm';

export interface ConnectedWallet {
  address: string;
  chain: 'SOLANA' | 'BASE' | 'ETHEREUM' | 'ARBITRUM' | 'BSC' | 'POLYGON' | 'OPTIMISM';
  mode: WalletMode;
}

type SolanaProvider = {
  signMessage?: (msg: Uint8Array, enc?: string) => Promise<Uint8Array | { signature: Uint8Array }>;
  signTransaction?: (tx: unknown) => Promise<{ serialize: () => Uint8Array } | Uint8Array>;
  publicKey?: { toBase58: () => string };
};

type EvmProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type WalletApi = {
  ready: boolean;
  projectIdConfigured: boolean;
  error: string | null;
  connect: (mode: WalletMode) => Promise<ConnectedWallet>;
  disconnect: () => Promise<void>;
  getAddress: (mode: WalletMode) => string | null;
  signMessage: (message: string, address: string, mode: WalletMode) => Promise<string>;
  signSolanaTransaction: (swapTransactionBase64: string) => Promise<string>;
  sendEvmNative: (input: {
    to: string;
    valueWei: string;
    chainId: number;
  }) => Promise<string>;
};

declare global {
  interface Window {
    CopyraWallet?: WalletApi;
    __COPYRA_CONFIG__?: { reownProjectId?: string; site?: string };
    COPYRA_API?: string;
    solana?: SolanaProvider & {
      connect?: () => Promise<{ publicKey: { toString: () => string } }>;
    };
    phantom?: { solana?: Window['solana'] };
    ethereum?: EvmProvider;
  }
}

function emptyApi(error: string | null, projectIdConfigured = false): WalletApi {
  return {
    ready: false,
    projectIdConfigured,
    error,
    async connect() {
      throw new Error(error ?? 'Wallet connect is not ready.');
    },
    async disconnect() {
      return;
    },
    getAddress() {
      return null;
    },
    async signMessage() {
      throw new Error(error ?? 'Wallet is not ready.');
    },
    async signSolanaTransaction() {
      throw new Error(error ?? 'Wallet is not ready.');
    },
    async sendEvmNative() {
      throw new Error(error ?? 'Wallet is not ready.');
    },
  };
}

function evmChainFromId(chainId: number | undefined): ConnectedWallet['chain'] {
  if (chainId === 8453) return 'BASE';
  if (chainId === 42161) return 'ARBITRUM';
  if (chainId === 56) return 'BSC';
  if (chainId === 137) return 'POLYGON';
  if (chainId === 10) return 'OPTIMISM';
  return 'ETHEREUM';
}

function networkForMode(mode: WalletMode) {
  return mode === 'sol' ? solana : mainnet;
}

function networkForChainId(chainId: number) {
  if (chainId === 8453) return base;
  if (chainId === 42161) return arbitrum;
  if (chainId === 56) return bsc;
  if (chainId === 137) return polygon;
  if (chainId === 10) return optimism;
  return mainnet;
}

/** Resolve Reown project id: baked Vite env → runtime config.js → /api/public-config. */
async function resolveProjectId(): Promise<string> {
  const baked =
    (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined)?.trim() ||
    (import.meta.env.NEXT_PUBLIC_REOWN_PROJECT_ID as string | undefined)?.trim() ||
    '';
  if (baked) return baked;

  const fromWindow = window.__COPYRA_CONFIG__?.reownProjectId?.trim();
  if (fromWindow) return fromWindow;

  try {
    const response = await fetch('/api/public-config', { credentials: 'same-origin' });
    if (response.ok) {
      const data = (await response.json()) as { reownProjectId?: string };
      if (data.reownProjectId?.trim()) {
        window.__COPYRA_CONFIG__ = {
          ...(window.__COPYRA_CONFIG__ ?? {}),
          reownProjectId: data.reownProjectId.trim(),
        };
        return data.reownProjectId.trim();
      }
    }
  } catch {
    /* fall through */
  }
  return '';
}

async function init(): Promise<WalletApi> {
  const PROJECT_ID = await resolveProjectId();
  if (!PROJECT_ID) {
    return emptyApi(
      'Reown project id missing. Set VITE_REOWN_PROJECT_ID (or NEXT_PUBLIC_REOWN_PROJECT_ID) as an App-Level env var on DigitalOcean, then redeploy.',
      false,
    );
  }

  const networks = [solana, mainnet, base, arbitrum, bsc, polygon, optimism] as [
    typeof solana,
    typeof mainnet,
    typeof base,
    typeof arbitrum,
    typeof bsc,
    typeof polygon,
    typeof optimism,
  ];

  const wagmiAdapter = new WagmiAdapter({
    projectId: PROJECT_ID,
    networks: [mainnet, base, arbitrum, bsc, polygon, optimism],
  });
  const solanaAdapter = new SolanaAdapter();
  new QueryClient();

  const siteOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'https://copyra.fun';

  const modal = createAppKit({
    adapters: [wagmiAdapter, solanaAdapter],
    networks,
    projectId: PROJECT_ID,
    metadata: {
      name: 'COPYRA',
      description: 'Copy the smartest wallets on Solana and EVM.',
      url: siteOrigin,
      icons: [`${siteOrigin}/icons/copyra.png`],
    },
    // Full catalog matching Reown “Connect Wallet” UI (Trust, MetaMask, Phantom, … + All Wallets QR).
    allWallets: 'SHOW',
    featuredWalletIds: [
      // Trust, MetaMask, Phantom, Coinbase, Rainbow — verified WalletConnect explorer ids.
      '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0',
      'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
      'a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c974',
      'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3bfb774b1909aa5b4',
      '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369',
    ],
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
    allowUnsupportedChain: false,
  });

  async function ensureNamespace(mode: WalletMode): Promise<void> {
    try {
      await modal.switchNetwork(networkForMode(mode));
    } catch {
      /* user may cancel; connect() still opens the modal */
    }
  }

  function solanaProvider(): SolanaProvider | undefined {
    return (
      (modal.getProvider?.('solana') as SolanaProvider | undefined) ||
      (modal.getWalletProvider?.() as SolanaProvider | undefined) ||
      window.solana ||
      window.phantom?.solana
    );
  }

  function evmProvider(): EvmProvider | undefined {
    return (
      (modal.getProvider?.('eip155') as EvmProvider | undefined) ||
      (modal.getWalletProvider?.() as EvmProvider | undefined) ||
      window.ethereum
    );
  }

  return {
    ready: true,
    projectIdConfigured: true,
    error: null,
    async connect(mode) {
      await ensureNamespace(mode);
      const namespace = mode === 'sol' ? 'solana' : 'eip155';
      // Opens the full multi-wallet Reown list filtered to Solana or EVM.
      await modal.open({ view: 'Connect', namespace });
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const address =
          mode === 'sol'
            ? modal.getAddress?.('solana') || modal.getAddress?.()
            : modal.getAddress?.('eip155') || modal.getAddress?.();
        if (address) {
          if (mode === 'sol' && !String(address).startsWith('0x')) {
            try {
              await modal.close();
            } catch {
              /* ignore */
            }
            return { address: String(address), chain: 'SOLANA', mode };
          }
          if (mode === 'evm' && String(address).startsWith('0x')) {
            const chainId = Number(modal.getChainId?.() ?? 1);
            try {
              await modal.close();
            } catch {
              /* ignore */
            }
            return {
              address: String(address),
              chain: evmChainFromId(chainId),
              mode,
            };
          }
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 400); // copyra-audit-allow: poll Reown modal until user connects
        });
      }
      throw new Error('Wallet connect timed out. Open Connect again or use All Wallets / QR.');
    },
    async disconnect() {
      await modal.disconnect();
    },
    getAddress(mode) {
      const address =
        mode === 'sol'
          ? modal.getAddress?.('solana') || modal.getAddress?.()
          : modal.getAddress?.('eip155') || modal.getAddress?.();
      if (!address) return null;
      if (mode === 'sol' && !String(address).startsWith('0x')) return String(address);
      if (mode === 'evm' && String(address).startsWith('0x')) return String(address);
      return null;
    },
    async signMessage(message, address, mode) {
      await ensureNamespace(mode);
      if (mode === 'sol') {
        const provider = solanaProvider();
        if (!provider?.signMessage) {
          throw new Error(
            'Connected Solana wallet cannot sign messages. Try Phantom, Solflare, or another wallet from All Wallets.',
          );
        }
        const result = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
        const signature =
          result && typeof result === 'object' && 'signature' in result
            ? (result as { signature: Uint8Array }).signature
            : (result as Uint8Array);
        const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature as ArrayBuffer);
        return bs58(bytes);
      }
      const provider = evmProvider();
      if (!provider?.request) {
        throw new Error(
          'Connected EVM wallet cannot sign messages. Try MetaMask, Trust, or another wallet from All Wallets.',
        );
      }
      const sig = await provider.request({
        method: 'personal_sign',
        params: [message, address],
      });
      return String(sig);
    },
    async signSolanaTransaction(swapTransactionBase64) {
      await ensureNamespace('sol');
      const provider = solanaProvider();
      if (!provider?.signTransaction) {
        throw new Error('Connect a Solana wallet that can sign transactions.');
      }
      const raw = Uint8Array.from(atob(swapTransactionBase64), (c) => c.charCodeAt(0));
      const { VersionedTransaction } = await import('@solana/web3.js');
      const tx = VersionedTransaction.deserialize(raw);
      const signed = await provider.signTransaction(tx);
      const serialized =
        signed instanceof Uint8Array
          ? signed
          : typeof (signed as { serialize?: () => Uint8Array }).serialize === 'function'
            ? (signed as { serialize: () => Uint8Array }).serialize()
            : null;
      if (!serialized) throw new Error('Wallet returned an unexpected signed transaction shape.');
      return btoa(String.fromCharCode(...serialized));
    },
    async sendEvmNative(input) {
      await modal.switchNetwork(networkForChainId(input.chainId)).catch(() => undefined);
      const provider = evmProvider();
      if (!provider?.request) throw new Error('No EVM wallet available to send.');
      const from = modal.getAddress?.('eip155') || modal.getAddress?.();
      if (!from) throw new Error('Connect an EVM wallet first.');
      const hexValue = `0x${BigInt(input.valueWei).toString(16)}`;
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from,
            to: input.to,
            value: hexValue,
            chainId: `0x${input.chainId.toString(16)}`,
          },
        ],
      });
      return String(hash);
    },
  };
}

function bs58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => alphabet[d]).join('');
}

void init()
  .then((api) => {
    window.CopyraWallet = api;
    window.dispatchEvent(new CustomEvent('copyra-wallet-ready', { detail: { ready: api.ready } }));
  })
  .catch((error: unknown) => {
    window.CopyraWallet = emptyApi(error instanceof Error ? error.message : String(error));
    window.dispatchEvent(new CustomEvent('copyra-wallet-ready', { detail: { ready: false } }));
  });
