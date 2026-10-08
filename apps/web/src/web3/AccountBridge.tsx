import { useEffect, useRef } from 'react';
import { useAccount, useChainId } from 'wagmi';

export type EvmAccountStatus = {
  address: string | undefined;
  isConnecting: boolean;
  isDisconnected: boolean;
  isConnected: boolean;
  status: 'connecting' | 'reconnecting' | 'connected' | 'disconnected';
  chainId: number | undefined;
};

/** Pushes wagmi useAccount() status to the vanilla dashboard. */
export function AccountBridge({
  onChange,
}: {
  onChange: (status: EvmAccountStatus) => void;
}) {
  const { address, isConnecting, isDisconnected, isConnected, status } = useAccount();
  const chainId = useChainId();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const next: EvmAccountStatus = {
      address,
      isConnecting,
      isDisconnected,
      isConnected,
      status: status as EvmAccountStatus['status'],
      chainId,
    };
    onChangeRef.current(next);
    window.dispatchEvent(new CustomEvent('copyra-wallet-account', { detail: next }));
  }, [address, isConnecting, isDisconnected, isConnected, status, chainId]);

  return null;
}
