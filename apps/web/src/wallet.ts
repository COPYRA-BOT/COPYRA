/**
 * COPYRA wallet — Reown AppKit (Vite).
 *
 * Formula (Reown HTML):
 *   <script type="module" src="wallet.js"></script>
 *   <appkit-button></appkit-button>   // modern <w3m-core-button>
 *
 * Why Phantom-only used to appear:
 *   1) SolanaAdapter was constructed with only PhantomWalletAdapter (+ Solflare),
 *      so the injected list was capped to those adapters.
 *   2) Connect opened with namespace:'solana' while default mode was SOL, so EVM
 *      wallets never showed in that modal.
 *   3) Wallet Standard surfaces the browser-injected extension first (usually Phantom).
 * Fix: SolanaAdapter with registerWalletStandard only (AppKit ships WalletConnect
 * for Solana), WagmiAdapter for all EVM injected + WC, allWallets:'SHOW', and
 * open Connect / AllWallets for the active namespace every click.
 *
 * Project id: VITE_REOWN_PROJECT_ID only (plus same-origin /config.js from the API).
 * No Alchemy / paid RPC keys in the browser — public default transports only.
 */
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import { solana, mainnet, base, arbitrum, bsc } from '@reown/appkit/networks';
import { QueryClient } from '@tanstack/react-query';
import { getAddress, http } from 'viem';
import { getAccount } from '@wagmi/core';
import { mountWeb3Provider } from './web3/mount';
import type { EvmAccountStatus } from './web3/AccountBridge';

export type WalletMode = 'sol' | 'evm';

export interface ConnectedWallet {
  address: string;
  chain: 'SOLANA' | 'BASE' | 'ETHEREUM' | 'ARBITRUM' | 'BSC';
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
  connect: (mode: WalletMode, opts?: { skipOpen?: boolean }) => Promise<ConnectedWallet>;
  openModal: (mode?: WalletMode) => void;
  clickConnectButton: () => boolean;
  setMode: (mode: WalletMode) => void;
  waitForConnection: (mode: WalletMode) => Promise<ConnectedWallet>;
  disconnect: (mode?: WalletMode) => Promise<void>;
  getAddress: (mode: WalletMode) => string | null;
  getChainId: () => number | null;
  getAccountStatus: () => AccountSnapshot;
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
    openModal() {},
    clickConnectButton() {
      return false;
    },
    setMode() {},
    async waitForConnection() {
      throw new Error(error ?? 'Wallet connect is not ready.');
    },
    async disconnect() {},
    getAddress() {
      return null;
    },
    getChainId() {
      return null;
    },
    getAccountStatus() {
      return { evm: { ...DISCONNECTED_EVM }, solAddress: null };
    },
    mountConnectButton() {},
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
  return 'ETHEREUM';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms); // copyra-audit-allow: brief pause between wallet connect and SIWE sign
  });
}

/** VITE_REOWN_PROJECT_ID only (+ runtime /config.js / public-config). */
async function resolveProjectId(): Promise<string> {
  const baked = (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined)?.trim() || '';
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

function ensureAppKitButtonHost(): HTMLElement {
  let host = document.getElementById('copyra-appkit-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'copyra-appkit-host';
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
  btn.setAttribute('data-copyra-connect', '1');
  if (visible) {
    host.style.cssText = 'display:block;width:100%;margin:12px 0;min-height:48px;';
    btn.style.cssText = 'width:100%;display:block;';
  }
  host.appendChild(btn);
  const legacy = document.createElement('w3m-button') as HTMLElement;
  legacy.setAttribute('label', 'Connect Wallet');
  legacy.setAttribute('data-copyra-connect', '1');
  legacy.style.display = 'none';
  host.appendChild(legacy);
  return btn;
}

function mountHeaderConnectOverlay(mode: WalletMode): void {
  const wrap = document.getElementById('cn-wrap');
  if (!wrap) return;
  let overlay = wrap.querySelector('[data-copyra-overlay="1"]') as HTMLElement | null;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.setAttribute('data-copyra-overlay', '1');
    wrap.appendChild(overlay);
  }
  renderAppKitButton(overlay, mode, true);
  overlay.style.cssText =
    'position:absolute;inset:0;z-index:2;opacity:0.011;overflow:hidden;border-radius:16px;';
  const btn = overlay.querySelector('appkit-button') as HTMLElement | null;
  if (btn) btn.style.cssText = 'width:100%;height:100%;display:block;min-height:100%;';
}

function clickOfficialConnectButton(): boolean {
  const candidates = [
    ...Array.from(document.querySelectorAll('#cn-wrap [data-copyra-connect="1"]')),
    ...Array.from(document.querySelectorAll('#akhost [data-copyra-connect="1"]')),
    ...Array.from(document.querySelectorAll('#copyra-appkit-host [data-copyra-connect="1"]')),
  ] as HTMLElement[];
  for (const el of candidates) {
    try {
      el.click();
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function init(): Promise<WalletApi> {
  const PROJECT_ID = await resolveProjectId();
  if (!PROJECT_ID) {
    return emptyApi(
      'WalletConnect project id missing. Set VITE_REOWN_PROJECT_ID on the API host, then redeploy.',
      false,
    );
  }

  const networks = [solana, mainnet, base, arbitrum, bsc] as [
    typeof solana,
    typeof mainnet,
    typeof base,
    typeof arbitrum,
    typeof bsc,
  ];
  const evmNetworks = [mainnet, base, arbitrum, bsc] as const;

  // Public default transports only — no Alchemy / paid RPC keys in the browser.
  const transports = Object.fromEntries(evmNetworks.map((network) => [network.id, http()]));

  const wagmiAdapter = new WagmiAdapter({
    projectId: PROJECT_ID,
    networks: [...evmNetworks],
    transports,
  });

  // Do NOT pass a wallets: [...] list — that was the Phantom-only root cause.
  // registerWalletStandard discovers every injected Solana wallet; AppKit adds WalletConnect QR.
  const solanaAdapter = new SolanaAdapter({
    registerWalletStandard: true,
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
      icons: [`${siteOrigin}/icons/copyra.webp`],
    },
    themeMode: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    themeVariables: {
      '--w3m-font-family': 'Figtree, system-ui, sans-serif',
      '--apkt-font-family': 'Figtree, system-ui, sans-serif',
      '--w3m-z-index': 100000,
      '--apkt-z-index': 100000,
      '--w3m-accent': '#D87558',
      '--apkt-accent': '#D87558',
    },
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
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
  });

  const hiddenHost = ensureAppKitButtonHost();
  renderAppKitButton(hiddenHost, 'sol', false);
  mountHeaderConnectOverlay('sol');

  let activeMode: WalletMode = 'sol';
  let evmAccount: EvmAccountStatus = { ...DISCONNECTED_EVM };
  mountWeb3Provider({
    config: wagmiAdapter.wagmiConfig,
    queryClient,
    onAccountChange: (status) => {
      evmAccount = status;
      window.dispatchEvent(
        new CustomEvent('copyra-wallet-account', {
          detail: { evm: status, solAddress: readSolAddress() },
        }),
      );
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
    return Boolean(
      document.querySelector('w3m-modal.open') || document.querySelector('appkit-modal.open'),
    );
  }

  function openAppKit(mode: WalletMode): void {
    activeMode = mode;
    const namespace = mode === 'sol' ? 'solana' : 'eip155';
    mountHeaderConnectOverlay(mode);
    // Sync — desktop browsers require the user-gesture. Always force the list,
    // including when the same address is already linked.
    try {
      void modal.open({ view: 'AllWallets', namespace });
    } catch {
      try {
        void modal.open({ view: 'Connect', namespace });
      } catch {
        try {
          void modal.open({ view: 'Connect' });
        } catch {
          /* ignore */
        }
      }
    }
    window.setTimeout(() => {
      if (!isAppKitOpen()) {
        try {
          void modal.open({ view: 'Connect', namespace });
        } catch {
          try {
            void modal.open({ view: 'AllWallets', namespace });
          } catch {
            /* ignore */
          }
        }
      }
    }, 100);
  }

  async function waitForConnection(mode: WalletMode): Promise<ConnectedWallet> {
    const prior = mode === 'sol' ? readSolAddress() : readEvmAddress();
    const priorNorm = prior ? prior.toLowerCase() : null;
    const started = Date.now();
    let sawModalOpen = false;

    while (Date.now() - started < 180_000) {
      const isOpen = isAppKitOpen();
      if (isOpen) sawModalOpen = true;
      if (!sawModalOpen) {
        await sleep(180);
        continue;
      }

      if (mode === 'sol') {
        const address = readSolAddress();
        if (address && !isOpen) {
          await sleep(120);
          return { address, chain: 'SOLANA', mode };
        }
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
          return { address, chain: evmChainFromId(chainId), chainId, mode };
        }
        if (address && priorNorm && address.toLowerCase() !== priorNorm) {
          const chainId = readEvmChainId() ?? 1;
          try {
            await modal.close();
          } catch {
            /* ignore */
          }
          await sleep(120);
          return { address, chain: evmChainFromId(chainId), chainId, mode };
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
      activeMode = mode;
      renderAppKitButton(host, mode, true);
    },

    openModal(mode = 'evm') {
      openAppKit(mode);
    },

    clickConnectButton() {
      mountHeaderConnectOverlay(activeMode);
      return clickOfficialConnectButton();
    },

    setMode(mode) {
      activeMode = mode;
      mountHeaderConnectOverlay(mode);
      renderAppKitButton(hiddenHost, mode, false);
    },

    waitForConnection,

    async connect(mode, opts) {
      if (!opts?.skipOpen) openAppKit(mode);
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
      return { evm: { ...evmAccount }, solAddress: readSolAddress() };
    },

    async signMessage(message, address, mode) {
      if (mode === 'sol') {
        const provider = solanaProvider();
        if (!provider?.signMessage) {
          throw new Error(
            'Connected Solana wallet cannot sign messages. Open All Wallets and pick Phantom, Solflare, or WalletConnect.',
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
          'Connected EVM wallet cannot sign messages. Open All Wallets and pick MetaMask, Coinbase, Rainbow, or WalletConnect.',
        );
      }
      const checksum = getAddress(address);
      const signature = await provider.request({
        method: 'personal_sign',
        params: [message, checksum],
      });
      return String(signature);
    },

    async signSolanaTransaction(swapTransactionBase64) {
      const provider = solanaProvider();
      if (!provider?.signTransaction) {
        throw new Error('Solana wallet cannot sign transactions. Reconnect from All Wallets.');
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
      const provider = evmProvider();
      if (!provider?.request) throw new Error('EVM wallet not connected.');
      const from = readEvmAddress();
      if (!from) throw new Error('EVM wallet address missing.');
      const checksumFrom = getAddress(from);
      const hexValue = `0x${BigInt(input.valueWei).toString(16)}`;
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${input.chainId.toString(16)}` }],
        });
      } catch {
        /* wallet may already be on the chain, or add-chain is needed */
      }
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
