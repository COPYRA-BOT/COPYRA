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

  try {
    const result = await solanaPool().call('getParsedTransaction', (c) =>
      c.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        commitment: 'confirmed',
      }),
    );
    const tx = result.value;
    if (!tx) return null;

    const mints = new Set<string>();
    for (const bal of tx.meta?.postTokenBalances ?? []) {
      if (bal.mint) mints.add(bal.mint);
    }
    for (const bal of tx.meta?.preTokenBalances ?? []) {
      if (bal.mint) mints.add(bal.mint);
    }
    // Drop well-known quote mints.
    mints.delete('So11111111111111111111111111111111111111112');
    mints.delete('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    let tokenAddress = [...mints][0] ?? null;
    if (!tokenAddress) {
      const fromLogs = logs.join(' ').match(MINT_RE) ?? [];
      tokenAddress = fromLogs.find((a) => a.length >= 32) ?? null;
    }
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
  } catch (error) {
    log.warn({ signature, err: error }, 'sniper tx fetch/decode failed');
    return null;
  }
}

/**
 * Helius / Solana WS logsSubscribe for Pump.fun (+ PumpSwap) program events.
 * Reuses SOLANA_WS_URL (same Helius stream family as the copy worker).
 */
export async function startPumpFunDiscovery(
  onEvent: DiscoveryHandler,
  opts?: { programIds?: string[] },
): Promise<() => void> {
  const wsUrl = env.SOLANA_WS_URL || env.SOLANA_BACKUP_WS_URL;
  if (!wsUrl) {
    log.warn({}, 'SNIPER discovery idle — SOLANA_WS_URL not configured');
    return () => undefined;
  }

  const programs = opts?.programIds?.length
    ? opts.programIds
    : [env.PUMP_FUN_PROGRAM_ID || DEFAULT_PUMP_FUN_PROGRAM_ID, DEFAULT_PUMP_SWAP_PROGRAM_ID];

  let closed = false;
  let ws: WebSocket | null = null;
  let subIds: number[] = [];
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reqId = 1;
  const pending = new Map<number, string>();

  const handleLogsNotification = (programId: string, value: {
    signature: string;
    err: unknown;
    logs: string[];
  }) => {
    if (value.err) return;
    void extractEvent(value.signature, programId, value.logs ?? []).then((event) => {
      if (event) void onEvent(event);
    });
  };

  const subscribeAll = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    subIds = [];
    for (const programId of programs) {
      try {
        // Validate program id early.
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
          params: [{ mentions: [programId] }, { commitment: 'confirmed' }],
        }),
      );
    }
  };

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      log.info({ programs }, 'Sniper Helius/WS logsSubscribe connected');
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
          if (programId) subIds.push(msg.result);
          return;
        }
        if (msg.method === 'logsNotification' && msg.params?.result?.value) {
          // Map subscription → program via round-robin order (same as subscribe).
          const sub = msg.params.subscription;
          const idx = subIds.indexOf(sub ?? -1);
          const programId = programs[idx >= 0 ? idx : 0] ?? programs[0]!;
          handleLogsNotification(programId, msg.params.result.value);
        }
      } catch (error) {
        log.warn({ err: error }, 'sniper ws message parse failed');
      }
    });
    ws.on('close', () => {
      if (closed) return;
      log.warn({}, 'Sniper WS closed — reconnecting');
      reconnectTimer = setTimeout(connect, 2_500);
    });
    ws.on('error', (err) => {
      log.warn({ err }, 'Sniper WS error');
    });
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}
