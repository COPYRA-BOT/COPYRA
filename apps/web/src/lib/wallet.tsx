import { createAppKit, useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect } from '@reown/appkit/react';
import { SolanaAdapter } from '@reown/appkit-adapter-solana/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { useSignMessage } from 'wagmi';
import { arbitrum, base, bsc, mainnet, solana } from '@reown/appkit/networks';
import bs58 from 'bs58';
import type { Chain } from './types';

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID ?? 'e57af3334d4275f1aa5cd3309a4b15fb';

const evmNetworks = [base, mainnet, arbitrum, bsc] as const;
const networks = [solana, ...evmNetworks] as const;

const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [...evmNetworks],
});

const solanaAdapter = new SolanaAdapter();

const metadata = {
  name: 'COPYRA',
  description: 'On-chain copy trading for Solana and EVM. Wallet connect is for sign-in only — the trading bot signs from the server.',
  url: typeof window === 'undefined' ? 'https://copyra.fun' : window.location.origin,
  icons: ['https://copyra.fun/favicon.ico'],
};

createAppKit({
  adapters: [wagmiAdapter, solanaAdapter],
  networks: [...networks],
  projectId,
  metadata,
  defaultNetwork: solana,
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#c8f542',
    '--w3m-border-radius-master': '2px',
  },
});

const queryClient = new QueryClient();

export function WalletTree({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

interface WalletApi {
  address: string | null;
  connected: boolean;
  chain: Chain | null;
  openModal: () => void;
  disconnect: () => Promise<void>;
  signAuthMessage: (message: string) => Promise<string>;
}

const WalletCtx = createContext<WalletApi | null>(null);

export function useWallet(): WalletApi {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider');
  return ctx;
}

function inferChain(caipAddress?: string, namespace?: string): Chain | null {
  const id = (caipAddress ?? '').toLowerCase();
  if (namespace === 'solana' || id.startsWith('solana:')) return 'SOLANA';
  if (id.includes(':8453:')) return 'BASE';
  if (id.includes(':42161:')) return 'ARBITRUM';
  if (id.includes(':56:')) return 'BSC';
  if (id.includes(':1:')) return 'ETHEREUM';
  if (id.includes(':137:')) return 'POLYGON';
  if (id.includes(':10:')) return 'OPTIMISM';
  if (namespace === 'eip155') return 'BASE';
  return null;
}

function WalletBridge({ children }: { children: ReactNode }) {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const account = useAppKitAccount();
  const { walletProvider: solProvider } = useAppKitProvider<SolanaSigner>('solana');
  const { signMessageAsync } = useSignMessage();

  const namespace = account.caipAddress?.split(':')[0];
  const chain = inferChain(account.caipAddress, namespace);

  const value = useMemo<WalletApi>(
    () => ({
      address: account.address ?? null,
      connected: Boolean(account.isConnected && account.address),
      chain,
      openModal: () => open(),
      disconnect: async () => {
        await disconnect();
      },
      signAuthMessage: async (message: string) => {
        if (chain === 'SOLANA') {
          if (!solProvider || typeof solProvider.signMessage !== 'function') {
            throw new Error('Connected Solana wallet cannot sign messages.');
          }
          const encoded = new TextEncoder().encode(message);
          const signed = await solProvider.signMessage(encoded);
          const bytes = signed instanceof Uint8Array ? signed : new Uint8Array(signed as ArrayBuffer);
          return bs58.encode(bytes);
        }
        return signMessageAsync({ message });
      },
    }),
    [account.address, account.isConnected, chain, disconnect, open, signMessageAsync, solProvider],
  );

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

interface SolanaSigner {
  signMessage?: (message: Uint8Array) => Promise<Uint8Array | ArrayBuffer>;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <WalletTree>
      <WalletBridge>{children}</WalletBridge>
    </WalletTree>
  );
}
