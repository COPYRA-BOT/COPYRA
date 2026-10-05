import { FormEvent, useCallback, useState } from 'react';
import { ConnectWallet } from '@/components/ConnectWallet';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/StateBlock';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAsyncData } from '@/hooks/useApi';
import { api } from '@/lib/api';
import { CHAINS, type AuthMe, type Chain, type OnchainWallet } from '@/lib/types';
import { useWallet } from '@/lib/wallet';
import { formatWhen } from '@/lib/utils';

export function WalletPage({ session, onSession }: { session: AuthMe | null; onSession: () => void }) {
  const wallet = useWallet();
  const loadBalances = useCallback(() => api.balances(), []);
  const balances = useAsyncData(loadBalances, 20_000);
  const [lookupChain, setLookupChain] = useState<Chain>('SOLANA');
  const [lookupAddress, setLookupAddress] = useState('');
  const [lookup, setLookup] = useState<OnchainWallet | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const runLookup = async (event: FormEvent) => {
    event.preventDefault();
    setLookupBusy(true);
    setLookupError(null);
    try {
      const result = await api.onchain(lookupAddress.trim(), lookupChain);
      setLookup(result);
    } catch (err) {
      setLookup(null);
      setLookupError(err instanceof Error ? err.message : String(err));
    } finally {
      setLookupBusy(false);
    }
  };

  const fillConnected = () => {
    if (wallet.address) {
      setLookupAddress(wallet.address);
      if (wallet.chain) setLookupChain(wallet.chain);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Wallet</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Connect with Reown AppKit to prove you control a wallet (SIWE / SIWS). That session is for the
          dashboard only. COPYRA still trades — if it trades at all — from the server-side bot key.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connect + sign in</CardTitle>
          <CardDescription>
            Private keys never leave your wallet extension. COPYRA does not store a user signing key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ConnectWallet session={session} onSession={onSession} />
          <p className="text-sm text-muted-foreground">
            {session?.authenticated && session.user
              ? `Session: ${session.user.address} on ${session.user.chain}`
              : wallet.connected
                ? `Wallet connected. Sign in to create an HTTP session cookie.`
                : 'No wallet connected.'}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trading-bucket bot wallet</CardTitle>
          <CardDescription>Read from chain for the configured server signer, if one exists.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {balances.loading && !balances.data ? <LoadingBlock label="Reading bot balances…" /> : null}
          {balances.error ? <ErrorBlock message={balances.error} onRetry={() => void balances.reload()} /> : null}
          {balances.data ? (
            <>
              <p className="text-muted-foreground">{balances.data.buckets.trading}</p>
              {balances.data.wallets.length === 0 ? (
                <EmptyBlock title="No wallet rows" body="The API returned no balance records." />
              ) : (
                balances.data.wallets.map((w) => (
                  <div key={w.chain} className="rounded-lg border border-border px-3 py-3">
                    <p className="font-medium">{w.chain}</p>
                    {w.configured ? (
                      <>
                        <p className="font-mono text-xs break-all">{w.address}</p>
                        {w.error ? <p className="text-destructive">{w.error}</p> : null}
                        {typeof w.native === 'number' ? (
                          <p className="mt-1 tabular">
                            {w.native} native · slot {w.slot ?? '—'} · {w.source}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-muted-foreground">{w.detail}</p>
                    )}
                  </div>
                ))
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>On-chain lookup</CardTitle>
          <CardDescription>Reads the live native balance for any address through the same RPC pool.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-[10rem,1fr,auto,auto]" onSubmit={(e) => void runLookup(e)}>
            <div className="space-y-2">
              <Label htmlFor="lookup-chain">Chain</Label>
              <select
                id="lookup-chain"
                className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                value={lookupChain}
                onChange={(e) => setLookupChain(e.target.value as Chain)}
              >
                {CHAINS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lookup-address">Address</Label>
              <Input
                id="lookup-address"
                className="font-mono"
                value={lookupAddress}
                onChange={(e) => setLookupAddress(e.target.value)}
                required
              />
            </div>
            <Button type="button" variant="outline" className="md:mt-7" onClick={fillConnected} disabled={!wallet.address}>
              Use connected
            </Button>
            <Button type="submit" className="md:mt-7" disabled={lookupBusy}>
              {lookupBusy ? 'Reading…' : 'Read chain'}
            </Button>
          </form>
          {lookupError ? <p className="mt-3 text-sm text-destructive">{lookupError}</p> : null}
          {lookup ? (
            <div className="mt-4 rounded-lg border border-border px-3 py-3 text-sm">
              <p className="font-mono text-xs break-all">{lookup.address}</p>
              <p className="mt-2 text-lg tabular">
                {lookup.native} {lookup.nativeSymbol}
              </p>
              <p className="text-xs text-muted-foreground">
                {lookup.source} · {formatWhen(lookup.readAt)}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
