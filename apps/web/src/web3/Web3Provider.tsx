import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, type Config } from 'wagmi';

/** Wagmi + React Query shell for the AppKit WagmiAdapter account bridge. */
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
