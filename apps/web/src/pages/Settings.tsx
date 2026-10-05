import { FormEvent, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ErrorBlock, LoadingBlock } from '@/components/StateBlock';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAsyncData } from '@/hooks/useApi';
import { api } from '@/lib/api';
import { CHAINS, type Chain, type StrategyRow } from '@/lib/types';

export function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const load = useCallback(() => api.settings(), []);
  const { data, error, loading, reload } = useAsyncData(load);
  const [draft, setDraft] = useState<Partial<StrategyRow> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState('Dashboard kill switch');

  useEffect(() => {
    if (data?.row) setDraft(data.row);
  }, [data]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.patchSettings({
        tradingEnabled: draft.tradingEnabled,
        exitStrategy: draft.exitStrategy,
        minMarketCapUsd: Number(draft.minMarketCapUsd),
        maxMarketCapUsd: Number(draft.maxMarketCapUsd),
        maxDeploymentPct: Number(draft.maxDeploymentPct),
        maxOpenPositions: Number(draft.maxOpenPositions),
        reservePct: Number(draft.reservePct),
        minTradeUsd: Number(draft.minTradeUsd),
        maxSlippageBps: Number(draft.maxSlippageBps),
        maxPriceImpactPct: Number(draft.maxPriceImpactPct),
        minLiquidityUsd: Number(draft.minLiquidityUsd),
        takeProfitPct: Number(draft.takeProfitPct),
        stopLossPct: Number(draft.stopLossPct),
        trailingTriggerPct: Number(draft.trailingTriggerPct),
        trailingPartialSellPct: Number(draft.trailingPartialSellPct),
        trailingDropPct: Number(draft.trailingDropPct),
        followTraderSells: draft.followTraderSells,
        enabledChains: draft.enabledChains,
      });
      await reload();
      onChanged();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !draft) return <LoadingBlock label="Loading strategy settings…" />;
  if (error && !draft) return <ErrorBlock message={error} onRetry={() => void reload()} />;
  if (!draft) return null;

  const num = (key: keyof StrategyRow) => String(draft[key] ?? '');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Strategy settings</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          These values are the single settings row the worker reads. The TRADING_ENABLED host flag still
          overrides the dashboard switch.
        </p>
      </div>

      {data?.blockedReason ? (
        <Card className="border-amber-400/40">
          <CardContent className="py-4 text-sm">{data.blockedReason}</CardContent>
        </Card>
      ) : null}

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Emergency stop</CardTitle>
          <CardDescription>Halts new entries immediately. Open positions are not closed automatically.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="stop-reason">Reason</Label>
            <Input id="stop-reason" value={stopReason} onChange={(e) => setStopReason(e.target.value)} />
          </div>
          {draft.emergencyStop ? (
            <Button
              variant="secondary"
              onClick={() => {
                void api.emergencyClear().then(() => {
                  void reload();
                  onChanged();
                });
              }}
            >
              Clear stop
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={() => {
                void api.emergencyStop(stopReason || 'Dashboard kill switch').then(() => {
                  void reload();
                  onChanged();
                });
              }}
            >
              Engage stop
            </Button>
          )}
        </CardContent>
      </Card>

      <form onSubmit={(e) => void save(e)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Entries</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Toggle
              label="Trading enabled (dashboard)"
              checked={Boolean(draft.tradingEnabled)}
              onChange={(tradingEnabled) => setDraft((d) => ({ ...d, tradingEnabled }))}
            />
            <Toggle
              label="Follow trader sells"
              checked={Boolean(draft.followTraderSells)}
              onChange={(followTraderSells) => setDraft((d) => ({ ...d, followTraderSells }))}
            />
            <Field label="Exit strategy">
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                value={draft.exitStrategy}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, exitStrategy: e.target.value as StrategyRow['exitStrategy'] }))
                }
              >
                <option value="MANUAL">Option A — TP 100% / SL</option>
                <option value="TRAILING">Option B — partial + trail</option>
              </select>
            </Field>
            <Num label="Min market cap USD" value={num('minMarketCapUsd')} onChange={(minMarketCapUsd) => setDraft((d) => ({ ...d, minMarketCapUsd }))} />
            <Num label="Max market cap USD" value={num('maxMarketCapUsd')} onChange={(maxMarketCapUsd) => setDraft((d) => ({ ...d, maxMarketCapUsd }))} />
            <Num label="Max deploy %" value={num('maxDeploymentPct')} onChange={(maxDeploymentPct) => setDraft((d) => ({ ...d, maxDeploymentPct }))} />
            <Num label="Reserve %" value={num('reservePct')} onChange={(reservePct) => setDraft((d) => ({ ...d, reservePct }))} />
            <Num label="Max open positions" value={num('maxOpenPositions')} onChange={(maxOpenPositions) => setDraft((d) => ({ ...d, maxOpenPositions: Number(maxOpenPositions) }))} />
            <Num label="Min trade USD" value={num('minTradeUsd')} onChange={(minTradeUsd) => setDraft((d) => ({ ...d, minTradeUsd }))} />
            <Num label="Max slippage bps" value={num('maxSlippageBps')} onChange={(maxSlippageBps) => setDraft((d) => ({ ...d, maxSlippageBps: Number(maxSlippageBps) }))} />
            <Num label="Max price impact %" value={num('maxPriceImpactPct')} onChange={(maxPriceImpactPct) => setDraft((d) => ({ ...d, maxPriceImpactPct }))} />
            <Num label="Min liquidity USD" value={num('minLiquidityUsd')} onChange={(minLiquidityUsd) => setDraft((d) => ({ ...d, minLiquidityUsd }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Exits</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Num label="Take profit %" value={num('takeProfitPct')} onChange={(takeProfitPct) => setDraft((d) => ({ ...d, takeProfitPct }))} />
            <Num label="Stop loss %" value={num('stopLossPct')} onChange={(stopLossPct) => setDraft((d) => ({ ...d, stopLossPct }))} />
            <Num label="Trail trigger %" value={num('trailingTriggerPct')} onChange={(trailingTriggerPct) => setDraft((d) => ({ ...d, trailingTriggerPct }))} />
            <Num label="Trail partial sell %" value={num('trailingPartialSellPct')} onChange={(trailingPartialSellPct) => setDraft((d) => ({ ...d, trailingPartialSellPct }))} />
            <Num label="Trail drop %" value={num('trailingDropPct')} onChange={(trailingDropPct) => setDraft((d) => ({ ...d, trailingDropPct }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Enabled chains</CardTitle>
            <CardDescription>Monitor-only chains still cannot execute even if selected.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {CHAINS.map((chain) => {
              const on = draft.enabledChains?.includes(chain);
              return (
                <button
                  key={chain}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-xs ${on ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground'}`}
                  onClick={() =>
                    setDraft((d) => {
                      const current = new Set(d?.enabledChains ?? []);
                      if (current.has(chain)) current.delete(chain);
                      else current.add(chain);
                      return { ...d, enabledChains: [...current] as Chain[] };
                    })
                  }
                >
                  {chain}
                </button>
              );
            })}
          </CardContent>
        </Card>

        {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Input type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
      <Label className="normal-case tracking-normal text-foreground">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
