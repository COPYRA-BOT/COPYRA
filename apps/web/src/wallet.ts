/**
 * COPYRA wallet — Reown AppKit formula (same as <w3m-core-button> / <appkit-button>).
 *
 * Vanilla HTML pattern from Reown docs:
 *   <appkit-button></appkit-button>
 *   <script type="module" src="wallet.js"></script>
 *
 * We createAppKit once, mount the official button, and expose window.CopyraWallet
 * for platform connect / SIWE / deposit / withdraw.
 */
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
import { getAddress, http } from 'viem';
import { getAccount } from '@wagmi/core';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { mountWeb3Provider } from './web3/mount';
import type { EvmAccountStatus } from './web3/AccountBridge';

export type WalletMode = 'sol' | 'evm';

export interface ConnectedWallet {
  address: string;
  chain: 'SOLANA' | 'BASE' | 'ETHEREUM' | 'ARBITRUM' | 'BSC' | 'POLYGON' | 'OPTIMISM';
  chainId?: number;
  mode: WalletMode;
}

export type AccountSnapshot = {
  evm: EvmAccountStatus;
  solAddress: string | null;
};

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
  /** Opens official AppKit multi-wallet modal (All Wallets + QR). */
  connect: (mode: WalletMode, opts?: { skipOpen?: boolean }) => Promise<ConnectedWallet>;
  /** Open modal only — call from a click handler (required for desktop browsers). */
  openModal: (mode?: WalletMode) => void;
  /** Wait until a wallet address appears after openModal. */
  waitForConnection: (mode: WalletMode) => Promise<ConnectedWallet>;
  disconnect: (mode?: WalletMode) => Promise<void>;
  getAddress: (mode: WalletMode) => string | null;
  getChainId: () => number | null;
  getAccountStatus: () => AccountSnapshot;
  /** Ensure <appkit-button> is visible in a host element (Connect modal). */
  mountConnectButton: (host: HTMLElement, mode: WalletMode) => void;
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
    __COPYRA_CONFIG__?: {
      reownProjectId?: string;
      site?: string;
    };
    COPYRA_API?: string;
    solana?: SolanaProvider & {
      connect?: () => Promise<{ publicKey: { toString: () => string } }>;
    };
    phantom?: { solana?: Window['solana'] };
    ethereum?: EvmProvider;
  }
}

const DISCONNECTED_EVM: EvmAccountStatus = {
  address: undefined,
  isConnecting: false,
  isDisconnected: true,
  isConnected: false,
  status: 'disconnected',
  chainId: undefined,
};

function emptyApi(error: string | null, projectIdConfigured = false): WalletApi {
  return {
    ready: false,
    projectIdConfigured,
    error,
    async connect() {
      throw new Error(error ?? 'Wallet connect is not ready.');
    },
    openModal() {
      return;
    },
    async waitForConnection() {
      throw new Error(error ?? 'Wallet connect is not ready.');
    },
    async disconnect() {
      return;
    },
    getAddress() {
      return null;
    },
    getChainId() {
      return null;
    },
    getAccountStatus() {
      return { evm: { ...DISCONNECTED_EVM }, solAddress: null };
    },
    mountConnectButton() {
      return;
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

function networkForChainId(chainId: number) {
  if (chainId === 8453) return base;
  if (chainId === 42161) return arbitrum;
  if (chainId === 56) return bsc;
  if (chainId === 137) return polygon;
  if (chainId === 10) return optimism;
  return mainnet;
}

function alchemyRpcForChain(chainId: number, alchemyId: string): string | undefined {
  const path =
    chainId === 1
      ? 'eth-mainnet'
      : chainId === 8453
        ? 'base-mainnet'
        : chainId === 42161
          ? 'arb-mainnet'
          : chainId === 56
            ? 'bnb-mainnet'
            : chainId === 137
              ? 'polygon-mainnet'
              : chainId === 10
                ? 'opt-mainnet'
                : null;
  if (!path) return undefined;
  return `https://${path}.g.alchemy.com/v2/${alchemyId}`;
}

async function resolveProjectId(): Promise<string> {
  const baked =
    (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined)?.trim() ||
    (import.meta.env.NEXT_PUBLIC_REOWN_PROJECT_ID as string | undefined)?.trim() ||
    (import.meta.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() ||
    (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() ||
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms); // copyra-audit-allow: brief pause between wallet connect and SIWE sign
  });
}

/** Keep a persistent <appkit-button> on the page (Reown HTML formula). */
function ensureAppKitButtonHost(): HTMLElement {
  let host = document.getElementById('copyra-appkit-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'copyra-appkit-host';
    // Off-screen but in DOM so the custom element stays registered/clickable.
    host.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(host);
  }
  return host;
}

function renderAppKitButton(host: HTMLElement, mode: WalletMode, visible: boolean): HTMLElement {
  const namespace = mode === 'sol' ? 'solana' : 'eip155';
  host.innerHTML = '';
  const btn = document.createElement('appkit-button') as HTMLElement;
  btn.setAttribute('namespace', namespace);
  btn.setAttribute('label', 'Connect Wallet');
  if (visible) {
    host.style.cssText = 'display:block;width:100%;margin:12px 0;';
    btn.style.cssText = 'width:100%;display:block;';
  }
  host.appendChild(btn);
  // Also keep w3m-button alias for older formula screenshots.
  const legacy = document.createElement('w3m-button') as HTMLElement;
  legacy.setAttribute('label', 'Connect Wallet');
  legacy.style.display = 'none';
  host.appendChild(legacy);
  return btn;
}

async function init(): Promise<WalletApi> {
  const PROJECT_ID = await resolveProjectId();
  if (!PROJECT_ID) {
    return emptyApi(
      'WalletConnect project id missing. Set VITE_REOWN_PROJECT_ID / NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID on DigitalOcean, then redeploy.',
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

  const alchemyId =
    (import.meta.env.VITE_ALCHEMY_ID as string | undefined)?.trim() ||
    (import.meta.env.NEXT_PUBLIC_ALCHEMY_ID as string | undefined)?.trim() ||
    '';
  const evmNetworks = [mainnet, base, arbitrum, bsc, polygon, optimism] as const;
  const transports = Object.fromEntries(
    evmNetworks.map((network) => {
      const rpc = alchemyId ? alchemyRpcForChain(network.id, alchemyId) : undefined;
      return [network.id, http(rpc)];
    }),
  );

  // EVM: WagmiAdapter brings MetaMask, WalletConnect QR, Coinbase, injected EIP-6963, …
  const wagmiAdapter = new WagmiAdapter({
    projectId: PROJECT_ID,
    networks: [...evmNetworks],
    transports,
  });

  // Solana: without explicit wallets AppKit only detects injected Wallet Standard
  // (often just Phantom). Register Phantom + Solflare + WalletConnect explicitly.
  const solanaAdapter = new SolanaAdapter({
    registerWalletStandard: true,
    wallets: [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
  });

  const queryClient = new QueryClient();
  const siteOrigin = window.location.origin || 'https://copyra.fun';

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
    // Match platform UI fonts; high z-index so desktop AppKit sits above our modals.
    themeMode: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    themeVariables: {
      '--w3m-font-family': 'Figtree, system-ui, sans-serif',
      '--apkt-font-family': 'Figtree, system-ui, sans-serif',
      '--w3m-z-index': 100000,
      '--apkt-z-index': 100000,
      '--w3m-accent': '#D87558',
      '--apkt-accent': '#D87558',
    },
    // Force the full explorer ("All Wallets") — not just the one injected extension.
    allWallets: 'SHOW',
    enableWalletGuide: true,
    enableNetworkSwitch: true,
    allowUnsupportedChain: true,
    featuredWalletIds: [
      // MetaMask, Phantom, Trust, Coinbase, Rainbow, Solflare
      'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
      '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0',
      'a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c974',
      'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3bfb774b1909aa5b4',
      '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369',
      'a67cfe14b0026da23205eefdd4ad2d442b033e3b91ea9bdb7858caa6ca24eb28',
    ],
    includeWalletIds: undefined,
    excludeWalletIds: undefined,
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
  });

  // Official Reown HTML formula: keep <appkit-button> in the document.
  const hiddenHost = ensureAppKitButtonHost();
  renderAppKitButton(hiddenHost, 'evm', false);

  let evmAccount: EvmAccountStatus = { ...DISCONNECTED_EVM };
  mountWeb3Provider({
    config: wagmiAdapter.wagmiConfig,
    queryClient,
    onAccountChange: (status) => {
      evmAccount = status;
    },
  });

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

  function readSolAddress(): string | null {
    const byNs = modal.getAddress?.('solana');
    if (byNs && !String(byNs).startsWith('0x')) return String(byNs);
    const address = modal.getAddress?.();
    if (!address || String(address).startsWith('0x')) return null;
    return String(address);
  }

  function readEvmAddress(): string | null {
    const fromWagmi = evmAccount.address || getAccount(wagmiAdapter.wagmiConfig).address;
    if (fromWagmi) return String(fromWagmi);
    const byNs = modal.getAddress?.('eip155');
    if (byNs && String(byNs).startsWith('0x')) return String(byNs);
    const address = modal.getAddress?.();
    if (!address || !String(address).startsWith('0x')) return null;
    return String(address);
  }

  function readEvmChainId(): number | null {
    if (evmAccount.chainId) return evmAccount.chainId;
    const fromWagmi = getAccount(wagmiAdapter.wagmiConfig).chainId;
    if (typeof fromWagmi === 'number') return fromWagmi;
    const raw = modal.getChainId?.();
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function isAppKitOpen(): boolean {
    try {
      if (modal.getState?.()?.open) return true;
    } catch {
      /* ignore */
    }
    // w3m-modal always exists in the DOM; only `.open` means the list is visible.
    return Boolean(
      document.querySelector('w3m-modal.open') || document.querySelector('appkit-modal.open'),
    );
  }

  function openAppKit(mode: WalletMode): void {
    const namespace = mode === 'sol' ? 'solana' : 'eip155';
    // Must stay sync (no await) so desktop browsers keep the user-gesture.
    // Always force the Connect wallet list — even if this address is already linked.
    try {
      void modal.open({ view: 'Connect', namespace });
    } catch {
      try {
        void modal.open({ view: 'Connect' });
      } catch {
        /* ignore */
      }
    }
    window.setTimeout(() => {
      if (!isAppKitOpen()) {
        try {
          void modal.open({ view: 'Connect', namespace });
        } catch {
          /* ignore */
        }
      }
    }, 120);
  }

  async function waitForConnection(mode: WalletMode): Promise<ConnectedWallet> {
    // Snapshot any already-connected address so we don't instant-resolve and skip the popup
    // when the user opens the list again for the same wallet.
    const prior = mode === 'sol' ? readSolAddress() : readEvmAddress();
    const priorNorm = prior ? prior.toLowerCase() : null;
    const started = Date.now();
    let sawModalOpen = false;

    while (Date.now() - started < 180_000) {
      const isOpen = isAppKitOpen();
      if (isOpen) sawModalOpen = true;

      // Wait until the list actually opens — never fake "open".
      if (!sawModalOpen) {
        await sleep(180);
        continue;
      }

      if (mode === 'sol') {
        const address = readSolAddress();
        // Modal opened then closed with a Solana address (same or new) — accept.
        if (address && !isOpen) {
          await sleep(120);
          return { address, chain: 'SOLANA', mode };
        }
        // Address changed while modal still open — accept the new pick.
        if (address && priorNorm && address.toLowerCase() !== priorNorm) {
          try {
            await modal.close();
          } catch {
            /* ignore */
          }
          await sleep(120);
          return { address, chain: 'SOLANA', mode };
        }
      } else {
        if (evmAccount.isConnecting) {
          await sleep(120);
          continue;
        }
        const address = readEvmAddress();
        if (address && !isOpen) {
          const chainId = readEvmChainId() ?? 1;
          await sleep(120);
          return {
            address,
            chain: evmChainFromId(chainId),
            chainId,
            mode,
          };
        }
        if (address && priorNorm && address.toLowerCase() !== priorNorm) {
          const chainId = readEvmChainId() ?? 1;
          try {
            await modal.close();
          } catch {
            /* ignore */
          }
          await sleep(120);
          return {
            address,
            chain: evmChainFromId(chainId),
            chainId,
            mode,
          };
        }
      }
      await sleep(180);
    }
    throw new Error('Wallet connect timed out. Tap Connect Wallet again to reopen the list.');
  }

  return {
    ready: true,
    projectIdConfigured: true,
    error: null,

    mountConnectButton(host, mode) {
      renderAppKitButton(host, mode, true);
    },

    // Sync void — must stay sync so desktop browsers keep the user-gesture.
    openModal(mode = 'evm') {
      openAppKit(mode);
    },

    waitForConnection,

    async connect(mode, opts) {
      if (!opts?.skipOpen) {
        openAppKit(mode);
      }
      return waitForConnection(mode);
    },

    async disconnect(mode) {
      if (mode === 'sol') {
        await modal.disconnect('solana');
        return;
      }
      if (mode === 'evm') {
        await modal.disconnect('eip155');
        return;
      }
      await modal.disconnect();
    },

    getAddress(mode) {
      return mode === 'sol' ? readSolAddress() : readEvmAddress();
    },

    getChainId() {
      return readEvmChainId();
    },

    getAccountStatus() {
      return {
        evm: { ...evmAccount },
        solAddress: readSolAddress(),
      };
    },

    async signMessage(message, address, mode) {
      if (mode === 'sol') {
        const provider = solanaProvider();
        if (!provider?.signMessage) {
          throw new Error(
            'Connected Solana wallet cannot sign messages. Pick Phantom, Solflare, or WalletConnect from All Wallets.',
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
          'Connected EVM wallet cannot sign messages. Pick MetaMask, Trust, Coinbase, or WalletConnect QR.',
        );
      }
      let signingAddress = address;
      try {
        signingAddress = getAddress(address);
      } catch {
        /* keep */
      }
      const sig = await provider.request({
        method: 'personal_sign',
        params: [message, signingAddress],
      });
      return String(sig);
    },

    async signSolanaTransaction(swapTransactionBase64) {
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
      try {
        await modal.switchNetwork(networkForChainId(input.chainId));
        await sleep(250);
      } catch {
        /* continue on current chain */
      }
      const provider = evmProvider();
      if (!provider?.request) throw new Error('No EVM wallet available to send.');
      const from = readEvmAddress();
      if (!from) throw new Error('Connect an EVM wallet first.');
      let checksumFrom = from;
      try {
        checksumFrom = getAddress(from);
      } catch {
        /* keep */
      }
      const hexValue = `0x${BigInt(input.valueWei).toString(16)}`;
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: checksumFrom,
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
