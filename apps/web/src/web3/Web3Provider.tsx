'use client';

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, type Config } from 'wagmi';

/**
 * Wagmi + React Query shell — equivalent to the ConnectKit Web3Provider snippet.
 * ConnectKit itself cannot install here (peers: react 17/18 + wagmi 2.x); Reown
 * AppKit’s WagmiAdapter supplies the same WalletConnect project + transports.
 */
export function Web3Provider({
  config,
  queryClient,
  children,
}: {
  config: Config;
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
