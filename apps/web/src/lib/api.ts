import type {
  AuthMe,
  BalancesResponse,
  Chain,
  NotificationLog,
  OnchainWallet,
  PnlResponse,
  Position,
  SettingsResponse,
  Signal,
  StatusResponse,
  StrategyRow,
  SystemEvent,
  Trade,
  Trader,
} from './types';

const API_PREFIX = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${response.status})`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; service: string; at: string }>('/health'),
  status: () => request<StatusResponse>('/api/status'),
  settings: () => request<SettingsResponse>('/api/settings'),
  patchSettings: (body: Partial<StrategyRow>) =>
    request<SettingsResponse>('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }),
  emergencyStop: (reason: string) =>
    request<StrategyRow>('/api/settings/emergency-stop', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  emergencyClear: () => request<StrategyRow>('/api/settings/emergency-clear', { method: 'POST' }),
  traders: () => request<Trader[]>('/api/traders'),
  addTrader: (body: { chain: Chain; address: string; label: string; notes?: string }) =>
    request<Trader>('/api/traders', { method: 'POST', body: JSON.stringify(body) }),
  patchTrader: (id: string, body: { enabled?: boolean; label?: string; notes?: string | null }) =>
    request<Trader>(`/api/traders/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTrader: (id: string) => request<{ ok: boolean }>(`/api/traders/${id}`, { method: 'DELETE' }),
  positions: () => request<Position[]>('/api/positions'),
  signals: () => request<Signal[]>('/api/signals'),
  trades: () => request<Trade[]>('/api/trades'),
  events: () => request<SystemEvent[]>('/api/events'),
  pnl: () => request<PnlResponse>('/api/pnl'),
  balances: () => request<BalancesResponse>('/api/balances'),
  onchain: (address: string, chain: Chain) =>
    request<OnchainWallet>(`/api/wallet/onchain?address=${encodeURIComponent(address)}&chain=${chain}`),
  notifications: () => request<NotificationLog[]>('/api/notifications'),
  me: () => request<AuthMe>('/api/auth/me'),
  nonce: (address: string, chain: Chain) =>
    request<{ nonce: string; address: string; chain: Chain; message: string; expiresAt: string }>(
      '/api/auth/nonce',
      { method: 'POST', body: JSON.stringify({ address, chain }) },
    ),
  verify: (body: { address: string; chain: Chain; message: string; signature: string }) =>
    request<{ ok: boolean; address: string; chain: Chain; expiresAt: string }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
};

export function wsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/ws`;
}
