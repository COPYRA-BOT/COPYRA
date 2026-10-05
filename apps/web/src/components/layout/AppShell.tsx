import { NavLink, Outlet } from 'react-router-dom';
import { ConnectWallet } from '@/components/ConnectWallet';
import type { AuthMe, StatusResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

const LINKS = [
  { to: '/', label: 'Overview' },
  { to: '/traders', label: 'Traders' },
  { to: '/positions', label: 'Positions' },
  { to: '/activity', label: 'Activity' },
  { to: '/settings', label: 'Settings' },
  { to: '/wallet', label: 'Wallet' },
];

export function AppShell({
  status,
  session,
  onSession,
}: {
  status: StatusResponse | null;
  session: AuthMe | null;
  onSession: () => void;
}) {
  const blocked = status?.trading.blockedReason;
  const observe = status?.trading.observeOnly;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <div>
              <p className="font-semibold tracking-[0.22em] text-primary">COPYRA</p>
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">On-chain copy trading</p>
            </div>
            <nav className="hidden items-center gap-1 md:flex">
              {LINKS.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground',
                      isActive && 'bg-secondary text-foreground',
                    )
                  }
                >
                  {link.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <ConnectWallet session={session} onSession={onSession} />
        </div>
        <div className="border-t border-border/60 bg-card/40">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
            <StatusDot
              ok={!blocked}
              label={observe ? 'Observe only' : blocked ? 'Trading blocked' : 'Trading armed'}
            />
            <StatusDot ok={Boolean(status?.telegram.canPostToChat)} label="Telegram" />
            <StatusDot
              ok={Boolean(status?.workers.some((w) => w.status === 'running'))}
              label="Worker"
            />
            <p className="min-w-0 flex-1 text-muted-foreground">
              {blocked ?? 'Engine can broadcast if a signing key is present and a qualifying first buy arrives.'}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <div className="mb-4 flex gap-1 overflow-x-auto md:hidden">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) =>
                cn(
                  'shrink-0 rounded-md px-3 py-1.5 text-sm text-muted-foreground',
                  isActive && 'bg-secondary text-foreground',
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
        </div>
        <Outlet />
      </main>

      <footer className="border-t border-border/80 px-4 py-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>COPYRA never asks for a trading private key in the browser. Bot keys stay on the server.</p>
          <div className="flex gap-4">
            <a className="hover:text-foreground" href="https://x.com/copyrafun" target="_blank" rel="noreferrer">
              X @copyrafun
            </a>
            <a className="hover:text-foreground" href="https://t.me/copyrafun" target="_blank" rel="noreferrer">
              Telegram
            </a>
            <a className="hover:text-foreground" href="https://copyra.fun" target="_blank" rel="noreferrer">
              copyra.fun
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-accent' : 'bg-amber-400')} />
      {label}
    </span>
  );
}
