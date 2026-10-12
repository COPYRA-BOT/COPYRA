import { PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { MAX_SUPPORTED_TX_VERSION, solanaPool } from '../solana/connection.js';
import { DEFAULT_PUMP_FUN_PROGRAM_ID, DEFAULT_PUMP_SWAP_PROGRAM_ID } from './constants.js';
import type { SniperDiscoveryEvent, SniperLaunchpad } from './types.js';

const log = componentLogger('sniper-discovery');

export type DiscoveryHandler = (event: SniperDiscoveryEvent) => void | Promise<void>;

const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Live WS decode counters for sniper worker heartbeat (process-local). */
const discoveryStats = {
  wsNotifications: 0,
  decodeOk: 0,
  decodeFail: 0,
  subs: 0,
  wsConnected: false,
  wsUrlHost: null as string | null,
  lastNotificationAt: null as string | null,
  reconnects: 0,
};

export function getSniperDiscoveryStats(): Readonly<typeof discoveryStats> {
  return { ...discoveryStats };
}

function launchpadForProgram(programId: string): SniperLaunchpad {
  if (programId === (env.PUMP_FUN_PROGRAM_ID || DEFAULT_PUMP_FUN_PROGRAM_ID)) return 'pump.fun';
  if (programId === DEFAULT_PUMP_SWAP_PROGRAM_ID) return 'pumpswap';
  return 'unknown';
}

function classifyLogs(logs: string[]): { eventKind: SniperDiscoveryEvent['eventKind']; migrated: boolean } {
  const joined = logs.join('\n').toLowerCase();
  if (joined.includes('migrate') || joined.includes('migration')) {
    return { eventKind: 'migrate', migrated: true };
  }
  if (joined.includes('create') || joined.includes('initialize mint') || joined.includes('init_mint')) {
    return { eventKind: 'create', migrated: false };
  }
  if (joined.includes('buy')) return { eventKind: 'buy', migrated: false };
  return { eventKind: 'pool', migrated: false };
}

const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

function programSkipSet(programId: string): Set<string> {
  return new Set([
    programId,
    env.PUMP_FUN_PROGRAM_ID || DEFAULT_PUMP_FUN_PROGRAM_ID,
    DEFAULT_PUMP_FUN_PROGRAM_ID,
    DEFAULT_PUMP_SWAP_PROGRAM_ID,
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    '11111111111111111111111111111111',
    'ComputeBudget111111111111111111111111111111',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  ]);
}

/** Best-effort mint from raw logs (works when getParsedTransaction lags). */
function mintFromLogs(logs: string[], programId: string): string | null {
  const skip = programSkipSet(programId);
  const fromLogs = logs.join(' ').match(MINT_RE) ?? [];
  for (const a of fromLogs) {
    if (a.length < 32 || QUOTE_MINTS.has(a) || skip.has(a)) continue;
    try {
      new PublicKey(a);
      return a;
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * Extract candidate mints from a confirmed tx involving pump.fun.
 * Prefers token balances created/received; falls back to log pubkeys.
 */
async function extractEvent(
  signature: string,
  programId: string,
  logs: string[],
): Promise<SniperDiscoveryEvent | null> {
  const launchpad = launchpadForProgram(programId);
  const { eventKind, migrated } = classifyLogs(logs);
  const logMint = mintFromLogs(logs, programId);

  try {
    const result = await solanaPool().call('getParsedTransaction', (c) =>
      c.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        commitment: 'confirmed',
      }),
    );
    const tx = result.value;
    if (tx) {
      const mints = new Set<string>();
      for (const bal of tx.meta?.postTokenBalances ?? []) {
        if (bal.mint) mints.add(bal.mint);
      }
      for (const bal of tx.meta?.preTokenBalances ?? []) {
        if (bal.mint) mints.add(bal.mint);
      }
      for (const q of QUOTE_MINTS) mints.delete(q);

      const tokenAddress = [...mints][0] ?? logMint;
      if (!tokenAddress) return null;

      const creator =
        tx.transaction.message.accountKeys
          .find((k: { signer?: boolean }) => k.signer)
          ?.pubkey.toBase58() ?? null;

      return {
        launchpad,
        eventKind,
        sourceTxHash: signature,
        tokenAddress,
        creatorAddress: creator,
        bondingState: migrated ? 'migrated' : launchpad === 'pump.fun' ? 'bonding_curve' : 'unknown',
        migrated,
        observedAt: new Date(),
        slot: tx.slot ?? null,
        rawLog: logs.slice(0, 8).join(' | '),
      };
    }
  } catch (error) {
    log.warn({ signature, err: error }, 'sniper tx fetch/decode failed — trying log mint');
  }

  // Fail-open to log mint so Pump.fun creates still reach Discovery while RPC lags.
  if (logMint && (eventKind === 'create' || eventKind === 'migrate' || eventKind === 'pool')) {
    return {
      launchpad,
      eventKind,
      sourceTxHash: signature,
      tokenAddress: logMint,
      creatorAddress: null,
      bondingState: migrated ? 'migrated' : launchpad === 'pump.fun' ? 'bonding_curve' : 'unknown',
      migrated,
      observedAt: new Date(),
      slot: null,
      rawLog: logs.slice(0, 8).join(' | '),
    };
  }
  return null;
}

function candidateWsUrls(): string[] {
  const urls: string[] = [];
  // Prefer backup so Pump.fun flood does not starve copy-trade primary subscriptions.
  if (env.SOLANA_BACKUP_WS_URL) urls.push(env.SOLANA_BACKUP_WS_URL);
  if (env.SOLANA_WS_URL && env.SOLANA_WS_URL !== env.SOLANA_BACKUP_WS_URL) {
    urls.push(env.SOLANA_WS_URL);
  }
  return urls;
}

/**
 * Helius / Solana WS logsSubscribe for Pump.fun (+ PumpSwap) program events.
 * Rotates across backup + primary WS so a dead endpoint cannot idle discovery forever.
 */
export async function startPumpFunDiscovery(
  onEvent: DiscoveryHandler,
  opts?: { programIds?: string[] },
): Promise<() => void> {
  const urls = candidateWsUrls();
  if (!urls.length) {
    discoveryStats.wsConnected = false;
    const msg = 'SNIPER discovery idle — SOLANA_WS_URL / SOLANA_BACKUP_WS_URL not configured';
    log.error({}, msg);
    throw new Error(msg);
  }
  log.info(
    {
      endpoints: urls.length,
      usingBackupFirst: Boolean(env.SOLANA_BACKUP_WS_URL),
      hasPrimary: Boolean(env.SOLANA_WS_URL),
    },
    'Sniper discovery WS endpoints selected (backup preferred for isolation)',
  );

  const programs = opts?.programIds?.length
    ? opts.programIds
    : [env.PUMP_FUN_PROGRAM_ID || DEFAULT_PUMP_FUN_PROGRAM_ID, DEFAULT_PUMP_SWAP_PROGRAM_ID];

  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let reqId = 1;
  let urlIndex = 0;
  let connectedAt = 0;
  /** JSON-RPC request id → program id (while waiting for subscribe ACK). */
  const pending = new Map<number, string>();
  /** Subscription id → program id (stable mapping for notifications). */
  const subToProgram = new Map<number, string>();
  const seenSig = new Set<string>();
  const SEEN_CAP = 4_000;

  const handleLogsNotification = (programId: string, value: {
    signature: string;
    err: unknown;
    logs: string[];
  }) => {
    if (value.err) return;
    discoveryStats.wsNotifications += 1;
    discoveryStats.lastNotificationAt = new Date().toISOString();
    if (seenSig.has(value.signature)) return;
    seenSig.add(value.signature);
    if (seenSig.size > SEEN_CAP) {
      const drop = [...seenSig].slice(0, SEEN_CAP / 2);
      for (const s of drop) seenSig.delete(s);
    }
    void extractEvent(value.signature, programId, value.logs ?? []).then((event) => {
      if (event) {
        discoveryStats.decodeOk += 1;
        void onEvent(event);
      } else {
        discoveryStats.decodeFail += 1;
      }
    });
  };

  const subscribeAll = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    subToProgram.clear();
    pending.clear();
    for (const programId of programs) {
      try {
        new PublicKey(programId);
      } catch {
        log.warn({ programId }, 'invalid sniper program id — skip');
        continue;
      }
      const id = reqId++;
      pending.set(id, programId);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [programId] }, { commitment: 'processed' }],
        }),
      );
    }
  };

  const scheduleReconnect = (delayMs: number) => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const connect = () => {
    if (closed) return;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    const wsUrl = urls[urlIndex % urls.length]!;
    urlIndex += 1;
    discoveryStats.reconnects += 1;
    try {
      discoveryStats.wsUrlHost = new URL(wsUrl).host;
    } catch {
      discoveryStats.wsUrlHost = 'invalid';
    }
    log.info({ host: discoveryStats.wsUrlHost, attempt: discoveryStats.reconnects }, 'Sniper WS connecting');
    ws = new WebSocket(wsUrl);
    let opened = false;
    const openTimeout = setTimeout(() => {
      if (!opened && ws && ws.readyState !== WebSocket.OPEN) {
        log.warn({ host: discoveryStats.wsUrlHost }, 'Sniper WS open timeout — rotate endpoint');
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, 12_000);
    ws.on('open', () => {
      opened = true;
      clearTimeout(openTimeout);
      connectedAt = Date.now();
      discoveryStats.wsConnected = true;
      log.info({ programs, host: discoveryStats.wsUrlHost }, 'Sniper Helius/WS logsSubscribe connected');
      subscribeAll();
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          id?: number;
          result?: number;
          method?: string;
          params?: { result?: { value?: { signature: string; err: unknown; logs: string[] } }; subscription?: number };
        };
        if (msg.id != null && typeof msg.result === 'number') {
          const programId = pending.get(msg.id);
          pending.delete(msg.id);
          if (programId) subToProgram.set(msg.result, programId);
          discoveryStats.subs = subToProgram.size;
          return;
        }
        if (msg.method === 'logsNotification' && msg.params?.result?.value) {
          const sub = msg.params.subscription;
          const programId =
            (sub != null ? subToProgram.get(sub) : undefined) ?? programs[0]!;
          handleLogsNotification(programId, msg.params.result.value);
        }
      } catch (error) {
        log.warn({ err: error }, 'sniper ws message parse failed');
      }
    });
    ws.on('close', () => {
      clearTimeout(openTimeout);
      discoveryStats.wsConnected = false;
      discoveryStats.subs = 0;
      if (closed) return;
      log.warn({ host: discoveryStats.wsUrlHost }, 'Sniper WS closed — rotating reconnect');
      scheduleReconnect(1_200);
    });
    ws.on('error', (err) => {
      log.warn({ err, host: discoveryStats.wsUrlHost }, 'Sniper WS error');
    });
  };

  // Pump.fun is busy — silence while "connected" means a stale socket; force rotate.
  watchdogTimer = setInterval(() => {
    if (closed) return;
    if (!discoveryStats.wsConnected) {
      if (!reconnectTimer) scheduleReconnect(500);
      return;
    }
    const last = discoveryStats.lastNotificationAt
      ? Date.parse(discoveryStats.lastNotificationAt)
      : 0;
    const quietMs = last ? Date.now() - last : Date.now() - connectedAt;
    const forceClose = () => {
      log.warn({ quietMs, host: discoveryStats.wsUrlHost }, 'Sniper WS quiet — forcing reconnect');
      try {
        ws?.close();
      } catch {
        scheduleReconnect(500);
      }
    };
    // After first notification, 90s quiet is abnormal for pump.fun.
    if (discoveryStats.wsNotifications > 0 && quietMs > 90_000) {
      forceClose();
      return;
    }
    // Connected but never received anything for 45s after open — rotate endpoint.
    if (discoveryStats.wsNotifications === 0 && connectedAt > 0 && Date.now() - connectedAt > 45_000) {
      forceClose();
    }
  }, 20_000);

  connect();

  return () => {
    closed = true;
    discoveryStats.wsConnected = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}
