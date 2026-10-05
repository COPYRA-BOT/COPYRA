import { useCallback, useState, type ReactNode } from 'react';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/StateBlock';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAsyncData } from '@/hooks/useApi';
import { api } from '@/lib/api';
import { formatWhen, shortAddress } from '@/lib/utils';

type Tab = 'signals' | 'trades' | 'events' | 'telegram';

export function ActivityPage() {
  const [tab, setTab] = useState<Tab>('signals');
  const loadSignals = useCallback(() => api.signals(), []);
  const loadTrades = useCallback(() => api.trades(), []);
  const loadEvents = useCallback(() => api.events(), []);
  const loadNotes = useCallback(() => api.notifications(), []);
  const signals = useAsyncData(loadSignals, 10_000);
  const trades = useAsyncData(loadTrades, 10_000);
  const events = useAsyncData(loadEvents, 15_000);
  const notes = useAsyncData(loadNotes, 20_000);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signals, COPYRA trades, system events, and Telegram delivery logs. Empty means nothing happened yet.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {(['signals', 'trades', 'events', 'telegram'] as const).map((id) => (
          <Button key={id} size="sm" variant={tab === id ? 'default' : 'outline'} onClick={() => setTab(id)}>
            {id}
          </Button>
        ))}
      </div>

      {tab === 'signals' ? (
        <Feed
          loading={signals.loading && !signals.data}
          error={signals.error}
          empty={Boolean(signals.data && signals.data.length === 0)}
          emptyTitle="No signals"
          emptyBody="The worker has not decoded a watched-wallet transaction since it started."
          onRetry={() => void signals.reload()}
        >
          {signals.data?.map((row) => (
            <Row key={row.id}>
              <div>
                <p className="font-medium">
                  {row.classification} · {row.token?.symbol ?? shortAddress(row.tokenAddress)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.trader?.label ?? 'trader'} · {row.chain} · {formatWhen(row.createdAt)}
                </p>
              </div>
              <Badge variant={row.status.startsWith('BLOCKED') || row.status === 'SKIPPED' ? 'warn' : 'secondary'}>
                {row.skipReason ?? row.status}
              </Badge>
            </Row>
          ))}
        </Feed>
      ) : null}

      {tab === 'trades' ? (
        <Feed
          loading={trades.loading && !trades.data}
          error={trades.error}
          empty={Boolean(trades.data && trades.data.length === 0)}
          emptyTitle="No COPYRA trades"
          emptyBody="A trade row is written only when the engine attempts a real swap. Observe-only mode does not invent hashes."
          onRetry={() => void trades.reload()}
        >
          {trades.data?.map((row) => (
            <Row key={row.id}>
              <div>
                <p className="font-medium">
                  {row.side} · {row.reason} · {row.tokenSymbol ?? shortAddress(row.tokenAddress)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.status}
                  {row.errorMessage ? ` · ${row.errorMessage}` : ''} · {formatWhen(row.createdAt)}
                </p>
              </div>
              {row.explorerUrl ? (
                <a className="text-xs text-primary" href={row.explorerUrl} target="_blank" rel="noreferrer">
                  {shortAddress(row.txHash ?? '', 6, 6)}
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">unsigned</span>
              )}
            </Row>
          ))}
        </Feed>
      ) : null}

      {tab === 'events' ? (
        <Feed
          loading={events.loading && !events.data}
          error={events.error}
          empty={Boolean(events.data && events.data.length === 0)}
          emptyTitle="No system events"
          emptyBody="Operational events appear here when the API or worker writes them."
          onRetry={() => void events.reload()}
        >
          {events.data?.map((row) => (
            <Row key={row.id}>
              <div>
                <p className="font-medium">
                  {row.component} · {row.code}
                </p>
                <p className="text-xs text-muted-foreground">{row.message}</p>
              </div>
              <span className="text-xs text-muted-foreground">{formatWhen(row.createdAt)}</span>
            </Row>
          ))}
        </Feed>
      ) : null}

      {tab === 'telegram' ? (
        <Feed
          loading={notes.loading && !notes.data}
          error={notes.error}
          empty={Boolean(notes.data && notes.data.length === 0)}
          emptyTitle="No Telegram deliveries"
          emptyBody="A log row is stored after each send attempt, including failures."
          onRetry={() => void notes.reload()}
        >
          {notes.data?.map((row) => (
            <Row key={row.id}>
              <div>
                <p className="font-medium">{row.kind}</p>
                <p className="text-xs text-muted-foreground">{row.error ?? (row.delivered ? 'delivered' : 'not delivered')}</p>
              </div>
              <span className="text-xs text-muted-foreground">{formatWhen(row.createdAt)}</span>
            </Row>
          ))}
        </Feed>
      ) : null}
    </div>
  );
}

function Feed({
  loading,
  error,
  empty,
  emptyTitle,
  emptyBody,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyBody: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (loading) return <LoadingBlock label="Loading…" />;
  if (error) return <ErrorBlock message={error} onRetry={onRetry} />;
  if (empty) return <EmptyBlock title={emptyTitle} body={emptyBody} />;
  return <Card><CardContent className="divide-y divide-border/70 px-0 py-0">{children}</CardContent></Card>;
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">{children}</div>;
}
