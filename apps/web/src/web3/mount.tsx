import { createRoot, type Root } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import type { Config } from 'wagmi';
import { Web3Provider } from './Web3Provider';
import { AccountBridge, type EvmAccountStatus } from './AccountBridge';

let root: Root | null = null;

/** Mount the WagmiProvider island so useAccount stays live for the session. */
export function mountWeb3Provider(input: {
  config: Config;
  queryClient: QueryClient;
  onAccountChange: (status: EvmAccountStatus) => void;
}): void {
  let host = document.getElementById('copyra-web3-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'copyra-web3-root';
    host.setAttribute('hidden', '');
    document.body.appendChild(host);
  }
  if (!root) root = createRoot(host);
  root.render(
    <Web3Provider config={input.config} queryClient={input.queryClient}>
      <AccountBridge onChange={input.onAccountChange} />
    </Web3Provider>,
  );
}
