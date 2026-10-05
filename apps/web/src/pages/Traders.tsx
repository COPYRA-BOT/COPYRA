import { FormEvent, useCallback, useState } from 'react';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/StateBlock';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAsyncData } from '@/hooks/useApi';
import { api } from '@/lib/api';
import { CHAINS, type Chain } from '@/lib/types';
import { ageLabel, shortAddress } from '@/lib/utils';

export function TradersPage() {
  const load = useCallback(() => api.traders(), []);
  const { data, error, loading, reload } = useAsyncData(load, 15_000);
  const [form, setForm] = useState({ chain: 'SOLANA' as Chain, address: '', label: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.addTrader({
        chain: form.chain,
        address: form.address.trim(),
        label: form.label.trim(),
        notes: form.notes.trim() || undefined,
      });
      setForm({ chain: form.chain, address: '', label: '', notes: '' });
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Watched traders</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          The worker subscribes to each enabled Solana address through Helius logs. Only a real first buy
          inside the market-cap window can open a position.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add wallet</CardTitle>
          <CardDescription>Paste a mainnet address you actually want copied. Invalid addresses are rejected.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={(e) => void submit(e)}>
            <div className="space-y-2">
              <Label htmlFor="chain">Chain</Label>
              <select
                id="chain"
                className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                value={form.chain}
                onChange={(e) => setForm((f) => ({ ...f, chain: e.target.value as Chain }))}
              >
                {CHAINS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                required
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                aria-label="Trader label"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                required
                className="font-mono"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                aria-label="Trader wallet address"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Input
                id="notes"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                aria-label="Trader notes"
              />
            </div>
            {formError ? <p className="text-sm text-destructive md:col-span-2">{formError}</p> : null}
            <div>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Watch this wallet'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {loading && !data ? <LoadingBlock label="Loading traders…" /> : null}
      {error ? <ErrorBlock message={error} onRetry={() => void reload()} /> : null}
      {data && data.length === 0 ? (
        <EmptyBlock
          title="Nobody is being watched"
          body="Add a Solana wallet above. Until then the worker has nothing to subscribe to and the signal feed stays empty."
        />
      ) : null}

      {data && data.length > 0 ? (
        <div className="grid gap-3">
          {data.map((trader) => (
            <Card key={trader.id}>
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{trader.label}</p>
                    <Badge variant="outline">{trader.chain}</Badge>
                    {trader.enabled ? <Badge variant="live">Watching</Badge> : <Badge variant="muted">Paused</Badge>}
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground break-all">{trader.address}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Last activity {ageLabel(trader.lastActivityAt)}
                    {trader.lastSignature ? ` · ${shortAddress(trader.lastSignature, 6, 6)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Enabled</span>
                    <Switch
                      checked={trader.enabled}
                      onCheckedChange={(enabled) => {
                        void api.patchTrader(trader.id, { enabled }).then(() => reload());
                      }}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (window.confirm(`Stop watching ${trader.label}?`)) {
                        void api.deleteTrader(trader.id).then(() => reload());
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
