import { useState } from 'react';
import { api } from '@/lib/api';
import { shortAddress } from '@/lib/utils';
import { useWallet } from '@/lib/wallet';
import type { AuthMe } from '@/lib/types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

export function ConnectWallet({ session, onSession }: { session: AuthMe | null; onSession: () => void }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    if (!wallet.address || !wallet.chain) {
      setError('Connect a Solana or EVM wallet first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const issued = await api.nonce(wallet.address, wallet.chain);
      const signature = await wallet.signAuthMessage(issued.message);
      await api.verify({
        address: issued.address,
        chain: issued.chain,
        message: issued.message,
        signature,
      });
      onSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await api.logout();
      await wallet.disconnect();
      onSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {session?.authenticated && session.user ? (
          <Badge variant="live">Signed in {shortAddress(session.user.address)}</Badge>
        ) : wallet.connected && wallet.address ? (
          <Badge variant="secondary">{shortAddress(wallet.address)}</Badge>
        ) : null}
        {!wallet.connected ? (
          <Button size="sm" onClick={() => wallet.openModal()}>
            Connect wallet
          </Button>
        ) : !session?.authenticated ? (
          <>
            <Button size="sm" variant="outline" onClick={() => wallet.openModal()}>
              Switch
            </Button>
            <Button size="sm" onClick={() => void signIn()} disabled={busy}>
              {busy ? 'Signing…' : 'Sign in'}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </Button>
        )}
      </div>
      {error ? <p className="max-w-[18rem] text-right text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
