import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import { solana, mainnet, base, arbitrum } from '@reown/appkit/networks';
import { QueryClient } from '@tanstack/react-query';

const PROJECT_ID =
  import.meta.env.VITE_REOWN_PROJECT_ID ||
  import.meta.env.NEXT_PUBLIC_REOWN_PROJECT_ID ||
  '';

export type WalletMode = 'sol' | 'evm';

export interface ConnectedWallet {
  address: string;
  chain: 'SOLANA' | 'BASE' | 'ETHEREUM' | 'ARBITRUM';
  mode: WalletMode;
}

type WalletApi = {
  ready: boolean;
  projectIdConfigured: boolean;
  error: string | null;
  connect: (mode: WalletMode) => Promise<ConnectedWallet>;
  disconnect: () => Promise<void>;
  getAddress: (mode: WalletMode) => string | null;
  signMessage: (message: string, address: string, mode: WalletMode) => Promise<string>;
  signSolanaTransaction: (swapTransactionBase64: string) => Promise<string>;
};

function emptyApi(error: string | null): WalletApi {
  return {
    ready: false,
    projectIdConfigured: Boolean(PROJECT_ID),
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
  };
}

function evmChainFromId(chainId: number | undefined): ConnectedWallet['chain'] {
  if (chainId === 8453) return 'BASE';
  if (chainId === 42161) return 'ARBITRUM';
  return 'ETHEREUM';
}

async function init(): Promise<WalletApi> {
  if (!PROJECT_ID) {
    return emptyApi(
      'VITE_REOWN_PROJECT_ID / NEXT_PUBLIC_REOWN_PROJECT_ID is not set. Phantom and MetaMask still work.',
    );
  }

  const networks = [solana, mainnet, base, arbitrum] as [
    typeof solana,
    typeof mainnet,
    typeof base,
    typeof arbitrum,
  ];

  const wagmiAdapter = new WagmiAdapter({
    projectId: PROJECT_ID,
    networks: [mainnet, base, arbitrum],
  });
  const solanaAdapter = new SolanaAdapter();
  new QueryClient();

  const modal = createAppKit({
    adapters: [wagmiAdapter, solanaAdapter],
    networks,
    projectId: PROJECT_ID,
    metadata: {
      name: 'COPYRA',
      description: 'Copy the smartest wallets on Solana and EVM.',
      url: window.location.origin,
      icons: [`${window.location.origin}/icons/copyra.png`],
    },
    features: { analytics: false },
  });

  return {
    ready: true,
    projectIdConfigured: true,
    error: null,
    async connect(mode) {
      await modal.open({ view: 'Connect' });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const address = modal.getAddress();
        if (address) {
          if (mode === 'sol' && !address.startsWith('0x')) {
            return { address, chain: 'SOLANA', mode };
          }
          if (mode === 'evm' && address.startsWith('0x')) {
            return { address, chain: evmChainFromId(modal.getChainId() as number | undefined), mode };
          }
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 400); // copyra-audit-allow: poll Reown modal until user connects
        });
      }
      throw new Error('Wallet connect timed out. You can still use Phantom or MetaMask.');
    },
    async disconnect() {
      await modal.disconnect();
    },
    getAddress(mode) {
      const address = modal.getAddress();
      if (!address) return null;
      if (mode === 'sol' && !address.startsWith('0x')) return address;
      if (mode === 'evm' && address.startsWith('0x')) return address;
      return null;
    },
    async signMessage(message, address, mode) {
      if (mode === 'sol') {
        const provider = window.solana ?? window.phantom?.solana;
        if (!provider?.signMessage) throw new Error('No Solana wallet available to sign.');
        const result = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
        const signature = result.signature ?? result;
        const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
        return bs58(bytes);
      }
      const provider = window.ethereum;
      if (!provider) throw new Error('No EVM wallet available to sign.');
      return provider.request({ method: 'personal_sign', params: [message, address] });
    },
    async signSolanaTransaction(swapTransactionBase64) {
      const provider = window.solana ?? window.phantom?.solana;
      if (!provider) throw new Error('Connect a Solana wallet to sign this Jupiter transaction.');
      const raw = Uint8Array.from(atob(swapTransactionBase64), (c) => c.charCodeAt(0));
      if (typeof provider.signTransaction === 'function') {
        const { VersionedTransaction } = await import('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(raw);
        const signed = await provider.signTransaction(tx);
        const serialized = signed.serialize();
        return btoa(String.fromCharCode(...serialized));
      }
      throw new Error('The connected wallet cannot sign a Solana transaction.');
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

declare global {
  interface Window {
    CopyraWallet?: WalletApi;
    solana?: {
      connect: () => Promise<{ publicKey: { toString: () => string } }>;
      signMessage?: (msg: Uint8Array, enc: string) => Promise<{ signature: Uint8Array }>;
      signTransaction?: (tx: unknown) => Promise<{ serialize: () => Uint8Array }>;
    };
    phantom?: { solana?: Window['solana'] };
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<string> };
  }
}

void init()
  .then((api) => {
    window.CopyraWallet = api;
  })
  .catch((error: unknown) => {
    window.CopyraWallet = emptyApi(error instanceof Error ? error.message : String(error));
  });
