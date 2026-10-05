import { useCallback } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAsyncData } from '@/hooks/useApi';
import { api, wsUrl } from '@/lib/api';
import type { StatusResponse } from '@/lib/types';
import { ActivityPage } from '@/pages/Activity';
import { OverviewPage } from '@/pages/Overview';
import { PositionsPage } from '@/pages/Positions';
import { SettingsPage } from '@/pages/Settings';
import { TradersPage } from '@/pages/Traders';
import { WalletPage } from '@/pages/Wallet';
import { useEffect, useState } from 'react';

export function App() {
  const loadStatus = useCallback(() => api.status(), []);
  const loadMe = useCallback(() => api.me(), []);
  const status = useAsyncData(loadStatus, 15_000);
  const session = useAsyncData(loadMe);
  const [live, setLive] = useState<StatusResponse | null>(null);

  useEffect(() => {
    if (status.data) setLive(status.data);
  }, [status.data]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(wsUrl());
      socket.onmessage = (event) => {
        try {
          setLive(JSON.parse(event.data) as StatusResponse);
        } catch {
          /* ignore malformed frames */
        }
      };
    } catch {
      /* browser without WS still has HTTP polling */
    }
    return () => socket?.close();
  }, []);

  const current = live ?? status.data;

  return (
    <Routes>
      <Route
        element={
          <AppShell status={current} session={session.data} onSession={() => void session.reload()} />
        }
      >
        <Route
          path="/"
          element={
            <OverviewPage
              status={current}
              statusError={status.error}
              onRefresh={() => void status.reload()}
            />
          }
        />
        <Route path="/traders" element={<TradersPage />} />
        <Route path="/positions" element={<PositionsPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/settings" element={<SettingsPage onChanged={() => void status.reload()} />} />
        <Route
          path="/wallet"
          element={<WalletPage session={session.data} onSession={() => void session.reload()} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
