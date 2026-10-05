import { useCallback } from 'react';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/StateBlock';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useAsyncData } from '@/hooks/useApi';
import { api } from '@/lib/api';
import { formatPct, formatUsd, shortAddress } from '@/lib/utils';

export function PositionsPage() {
  const load = useCallback(() => api.positions(), []);
  const { data, error, loading, reload } = useAsyncData(load, 10_000);

  if (loading && !data) return <LoadingBlock label="Loading positions from Postgres…" />;
  if (error && !data) return <ErrorBlock message={error} onRetry={() => void reload()} />;
  if (data && data.length === 0) {
    return (
      <div className="space-y-4">
        <Header />
        <EmptyBlock
          title="No positions"
          body="COPYRA opens a position only after a watched wallet's first qualifying buy is decoded, sized, and — if a bot key exists — confirmed on-chain. Observe-only mode records the signal instead of opening."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Header />
      {error ? <ErrorBlock message={error} onRetry={() => void reload()} /> : null}
      <div className="grid gap-3">
        {data?.map((position) => (
          <Card key={position.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {position.tokenSymbol ?? shortAddress(position.tokenAddress)}{' '}
                    <span className="text-xs text-muted-foreground">{position.chain}</span>
                  </p>
                  <p className="font-mono text-xs text-muted-foreground break-all">{position.tokenAddress}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={position.status === 'OPEN' ? 'live' : 'secondary'}>{position.status}</Badge>
                  <Badge variant="outline">{position.exitStrategy === 'TRAILING' ? 'Option B' : 'Option A'}</Badge>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Metric label="Entry" value={formatUsd(position.entryValueUsd)} />
                <Metric label="Last mark" value={formatUsd(position.lastPriceUsd)} />
                <Metric label="Unrealized" value={`${formatUsd(position.unrealizedPnlUsd)} (${formatPct(position.unrealizedPnlPct)})`} />
                <Metric label="Realized" value={formatUsd(position.realizedPnlUsd)} />
              </div>
              {position.trades && position.trades.length > 0 ? (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {position.trades.map((trade) => (
                    <li key={trade.id} className="flex flex-wrap justify-between gap-2">
                      <span>
                        {trade.side} · {trade.reason} · {trade.status}
                      </span>
                      {trade.explorerUrl ? (
                        <a className="text-primary" href={trade.explorerUrl} target="_blank" rel="noreferrer">
                          Explorer
                        </a>
                      ) : (
                        <span>No hash — not broadcast</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Positions</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        One open position per token. Marks update from Dexscreener/Jupiter, never from invented prices.
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="tabular">{value}</p>
    </div>
  );
}
