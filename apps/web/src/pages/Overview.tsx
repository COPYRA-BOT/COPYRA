import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/StateBlock';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAsyncData } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { StatusResponse } from '@/lib/types';
import { ageLabel, formatMs, formatUsd, shortAddress } from '@/lib/utils';

export function OverviewPage({ status, statusError, onRefresh }: {
  status: StatusResponse | null;
  statusError: string | null;
  onRefresh: () => void;
}) {
  const loadSignals = useCallback(() => api.signals(), []);
  const loadPnl = useCallback(() => api.pnl(), []);
  const signals = useAsyncData(loadSignals, 12_000);
  const pnl = useAsyncData(loadPnl, 12_000);

  if (statusError && !status) {
    return <ErrorBlock message={statusError} onRetry={onRefresh} />;
  }
  if (!status) {
    return <LoadingBlock label="Reading live chain heads and engine status…" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Live engine</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every number on this page comes from the running API, Postgres, Redis, and the configured RPC
          providers. Empty lists mean nothing has been detected yet — not invented activity.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Mode" value={status.trading.observeOnly ? 'Observe only' : 'Can broadcast'} />
        <Stat label="Open positions" value={String(status.counts.openPositions)} />
        <Stat label="Signals (24h)" value={String(status.counts.signals24h)} />
        <Stat
          label="Confirmed COPYRA trades"
          value={String(status.counts.confirmedTrades)}
          hint={status.latency.claimsVerified ? 'Latency from confirmed fills' : 'No COPYRA fill has confirmed yet'}
        />
      </div>

      <Card className={status.trading.blockedReason ? 'border-amber-400/30' : 'border-accent/30'}>
        <CardHeader>
          <CardTitle>Trading guard</CardTitle>
          <CardDescription>
            Host env TRADING_ENABLED={String(status.trading.envGuard)} · settings={String(status.trading.settingsEnabled)} ·
            emergency={String(status.trading.emergencyStop)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{status.trading.blockedReason ?? 'All guards are clear. A qualifying first buy can be copied.'}</p>
          <p className="text-muted-foreground">
            Solana signer {status.signers.solana.available ? shortAddress(status.signers.solana.address ?? '') : 'not configured'}
            {' · '}
            EVM signer {status.signers.evm.available ? shortAddress(status.signers.evm.address ?? '') : 'not configured'}
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Chain heads</CardTitle>
            <CardDescription>Live slot / block from Helius and Alchemy. Errors are real RPC failures.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Chain</th>
                  <th className="pb-2 font-medium">Head</th>
                  <th className="pb-2 font-medium">Latency</th>
                  <th className="pb-2 font-medium">Execution</th>
                </tr>
              </thead>
              <tbody>
                {status.chains.map((chain) => (
                  <tr key={chain.chain} className="border-t border-border/70">
                    <td className="py-2">
                      <div className="font-medium">{chain.label}</div>
                      <div className="text-xs text-muted-foreground">{chain.nativeSymbol}</div>
                    </td>
                    <td className="py-2 font-mono text-xs tabular">
                      {chain.error ? <span className="text-destructive">{chain.error}</span> : (chain.head ?? '—')}
                    </td>
                    <td className="py-2 tabular">{formatMs(chain.latencyMs)}</td>
                    <td className="py-2">
                      {chain.canExecute ? (
                        <Badge variant="live">Executable</Badge>
                      ) : (
                        <Badge variant="warn">Monitor only</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>P&L since reset</CardTitle>
              <CardDescription>Realized only from closed positions with on-chain fills.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {pnl.error ? <p className="text-destructive">{pnl.error}</p> : null}
              <p>Realized: {formatUsd(pnl.data?.realizedQuote ?? 0)}</p>
              <p>Unrealized: {formatUsd(pnl.data?.unrealizedQuote ?? 0)}</p>
              <p className="text-muted-foreground">
                {pnl.data ? `${pnl.data.openCount} open · ${pnl.data.closedCount} closed` : 'Reading…'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Telegram</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>
                {status.telegram.tokenValid
                  ? `@${status.telegram.botUsername ?? 'bot'}`
                  : 'Bot token rejected'}
              </p>
              <p className="text-muted-foreground">
                {status.telegram.canPostToChat
                  ? `Can post to ${status.telegram.chatTitle ?? 'configured chat'}`
                  : (status.telegram.error ?? 'Cannot post')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Workers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {status.workers.length === 0 ? (
                <p className="text-muted-foreground">No heartbeat yet. Start `npm run dev:worker`.</p>
              ) : (
                status.workers.map((w) => (
                  <div key={w.name} className="flex items-center justify-between">
                    <span>{w.name}</span>
                    <span className="text-muted-foreground">
                      {w.status} · {ageLabel(w.beatAt)}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Recent signals</CardTitle>
            <CardDescription>Decoded from watched wallets. Skips keep their real reason.</CardDescription>
          </div>
          <Link to="/activity" className="text-xs uppercase tracking-wider text-primary">
            All activity
          </Link>
        </CardHeader>
        <CardContent>
          {signals.loading && !signals.data ? <LoadingBlock label="Loading signals…" /> : null}
          {signals.error ? <ErrorBlock message={signals.error} onRetry={() => void signals.reload()} /> : null}
          {signals.data && signals.data.length === 0 ? (
            <EmptyBlock
              title="No signals yet"
              body="Add a trader wallet on the Traders page. The worker will subscribe to that address on Helius and record the next real transaction."
            />
          ) : null}
          {signals.data && signals.data.length > 0 ? (
            <ul className="divide-y divide-border/70 text-sm">
              {signals.data.slice(0, 8).map((signal) => (
                <li key={signal.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <span className="font-medium">{signal.classification}</span>{' '}
                    <span className="text-muted-foreground">{signal.token?.symbol ?? shortAddress(signal.tokenAddress)}</span>
                    <div className="text-xs text-muted-foreground">
                      {signal.trader?.label ?? 'trader'} · {signal.chain}
                    </div>
                  </div>
                  <Badge variant={signal.status === 'SKIPPED' || signal.status.startsWith('BLOCKED') ? 'warn' : 'secondary'}>
                    {signal.skipReason ?? signal.status}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 pt-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
