import {
  chainConfig,
  CHAIN_CONFIGS,
  evmSigner,
  explorerTxUrl,
  getDexscreenerMarket,
  getQuoteAssetPriceUsd,
  getSettings,
  getSolanaBalances,
  getStrategyConfig,
  invalidateSettingsCache,
  killSwitchSellAll,
  multiUserCustodyEnabled,
  publicReownProjectId,
  resolveWebOrigin,
  solanaSigner,
  telegram,
  tradingBlockedReason,
} from '@copyra/core';
import { Chain, prisma, type Prisma } from '@copyra/db';
import { PublicKey } from '@solana/web3.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import {
  type AuthMode,
  authModeFromRequest,
  buildSiweMessage,
  buildSiwsMessage,
  createSession,
  issueNonce,
  readBothSessions,
  readSession,
  revokeSession,
  verifyWalletSignature,
} from './auth.js';
import { buildModeBalances, buildWorkerWalletBalances } from './balances.js';
import { buildLiveStatus } from './live-status.js';
import { jsonSafe } from './serialize.js';
import { registerSwapRoutes } from './swap.js';

const chainSchema = z.nativeEnum(Chain);

function parseChainAddress(chain: Chain, raw: string): string {
  if (chain === Chain.SOLANA) {
    return new PublicKey(raw).toBase58();
  }
  if (!isAddress(raw)) throw new Error('Invalid EVM address');
  return getAddress(raw).toLowerCase();
}

/** Require a signed-in wallet for the requested mode (or X-Copyra-Mode). */
async function requireAuthed(
  request: FastifyRequest,
  reply: FastifyReply,
  mode?: AuthMode,
) {
  const resolved = mode ?? authModeFromRequest(request);
  const session = await readSession(request, resolved);
  if (!session) {
    reply.code(401).send({
      error: `Connect your ${resolved === 'evm' ? 'EVM' : 'Solana'} wallet and sign in first. Each wallet has its own private account.`,
    });
    return null;
  }
  return session;
}

function modeForChain(chain: Chain): AuthMode {
  return chain === Chain.SOLANA ? 'sol' : 'evm';
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerSwapRoutes(app);
  // /health is registered in main.ts before plugins so App Platform liveness
  // does not depend on route registration order.

  app.get('/api/status', async (request) => buildLiveStatus(request));

  app.get('/api/settings', async () => {
    const row = await getSettings();
    const config = await getStrategyConfig();
    return jsonSafe({
      row,
      effective: config,
      blockedReason: tradingBlockedReason(
        row,
        multiUserCustodyEnabled() || solanaSigner.available || evmSigner.available,
      ),
    });
  });

  app.patch('/api/settings', async (request, reply) => {
    const body = z
      .object({
        tradingEnabled: z.boolean().optional(),
        exitStrategy: z.enum(['MANUAL', 'TRAILING']).optional(),
        minMarketCapUsd: z.number().positive().optional(),
        maxMarketCapUsd: z.number().positive().optional(),
        maxDeploymentPct: z.number().positive().max(100).optional(),
        maxOpenPositions: z.number().int().positive().max(50).optional(),
        reservePct: z.number().min(0).max(99).optional(),
        minTradeUsd: z.number().positive().optional(),
        maxSlippageBps: z.number().int().positive().max(5000).optional(),
        maxPriceImpactPct: z.number().positive().max(50).optional(),
        minLiquidityUsd: z.number().positive().optional(),
        takeProfitPct: z.number().positive().optional(),
        stopLossPct: z.number().positive().lt(100).optional(),
        trailingTriggerPct: z.number().positive().optional(),
        trailingPartialSellPct: z.number().positive().max(100).optional(),
        trailingDropPct: z.number().positive().lt(100).optional(),
        followTraderSells: z.boolean().optional(),
        firstBuyOnly: z.boolean().optional(),
        enabledChains: z.array(chainSchema).optional(),
        ui: z.record(z.unknown()).optional(),
      })
      .parse(request.body);

    if (
      body.minMarketCapUsd !== undefined &&
      body.maxMarketCapUsd !== undefined &&
      !(body.minMarketCapUsd < body.maxMarketCapUsd)
    ) {
      return reply.code(400).send({
        error: 'Min market cap must be below max market cap.',
      });
    }

    const updated = await prisma.strategySettings.update({
      where: { id: 1 },
      data: { ...body, ui: body.ui as Prisma.InputJsonValue | undefined, updatedBy: 'dashboard' },
    });
    invalidateSettingsCache();
    // Worker reads settings with a short cache; invalidate so the next tick is fresh.
    return jsonSafe({ row: updated, effective: await getStrategyConfig() });
  });

  app.post('/api/settings/emergency-stop', async (request) => {
    const body = z.object({ reason: z.string().min(1).max(400) }).parse(request.body ?? { reason: 'Dashboard kill switch' });
    const updated = await prisma.strategySettings.update({
      where: { id: 1 },
      data: {
        emergencyStop: true,
        emergencyStopReason: body.reason,
        emergencyStopAt: new Date(),
        updatedBy: 'dashboard',
      },
    });
    invalidateSettingsCache();
    telegram.send(
      `🛑 <b>EMERGENCY STOP ENGAGED</b>\n\nReason: ${body.reason}\nNo new positions will be opened.`,
      { kind: 'emergency-stop' },
    );
    return jsonSafe(updated);
  });

  app.post('/api/settings/emergency-clear', async () => {
    const updated = await prisma.strategySettings.update({
      where: { id: 1 },
      data: {
        emergencyStop: false,
        emergencyStopReason: null,
        emergencyStopAt: null,
        updatedBy: 'dashboard',
      },
    });
    invalidateSettingsCache();
    telegram.send('✅ <b>EMERGENCY STOP CLEARED</b>\nCopy trading may resume if other guards allow it.', {
      kind: 'emergency-clear',
    });
    return jsonSafe(updated);
  });

  /**
   * Per-mode kill switch: stop new buys for this mode and market-sell all of
   * that account’s open positions back to custody (SOL or USDC).
   */
  app.post('/api/kill-switch', async (request, reply) => {
    const body = z.object({ mode: z.enum(['sol', 'evm']) }).parse(request.body ?? {});
    const session = await requireAuthed(request, reply, body.mode);
    if (!session) return;

    const row = await getSettings();
    const prevUi =
      row.ui && typeof row.ui === 'object' && !Array.isArray(row.ui)
        ? (row.ui as Record<string, unknown>)
        : {};
    const prevMode =
      prevUi[body.mode] && typeof prevUi[body.mode] === 'object' && !Array.isArray(prevUi[body.mode])
        ? (prevUi[body.mode] as Record<string, unknown>)
        : {};
    const nextUi = {
      ...prevUi,
      [body.mode]: {
        ...prevMode,
        engine: 'STOPPED',
        killSwitchAt: new Date().toISOString(),
      },
    };
    await prisma.strategySettings.update({
      where: { id: 1 },
      data: { ui: nextUi as Prisma.InputJsonValue, updatedBy: 'dashboard' },
    });
    invalidateSettingsCache();

    const result = await killSwitchSellAll({
      userId: session.user.id,
      mode: body.mode,
    });

    telegram.send(
      `☠️ <b>KILL SWITCH (${body.mode.toUpperCase()})</b>\nAccount: <code>${session.user.address.slice(0, 6)}…${session.user.address.slice(-4)}</code>\nPositions attempted: ${result.attempted}\nSold: ${result.sold} · Failed: ${result.failed}\nProceeds return to custody trading balance.`,
      { kind: 'kill-switch', userId: session.user.id },
    );

    return jsonSafe({ ok: true, ...result });
  });

  app.get('/api/traders', async (request, reply) => {
    const sessions = await readBothSessions(request);
    const userIds = [sessions.sol?.user.id, sessions.evm?.user.id].filter(
      (id): id is string => Boolean(id),
    );
    if (userIds.length === 0) {
      return reply.code(401).send({
        error: 'Connect a wallet and sign in first. Traders are private to each account.',
      });
    }
    // Prefer the active mode session when both are signed in.
    const mode = authModeFromRequest(request);
    const activeId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
    const scopeIds = activeId ? [activeId] : userIds;
    const traders = await prisma.trader.findMany({
      where: { userId: { in: scopeIds } },
      orderBy: { createdAt: 'desc' },
    });
    return jsonSafe(traders);
  });

  app.post('/api/traders', async (request, reply) => {
    const body = z
      .object({
        chain: chainSchema,
        address: z.string().min(4),
        label: z.string().min(1).max(64),
        notes: z.string().max(500).optional(),
      })
      .parse(request.body);
    const session = await requireAuthed(request, reply, modeForChain(body.chain));
    if (!session) return;
    let address: string;
    try {
      address = parseChainAddress(body.chain, body.address.trim());
    } catch {
      return reply.code(400).send({ error: 'Invalid address for the selected chain.' });
    }
    const existing = await prisma.trader.findUnique({
      where: {
        userId_chain_address: {
          userId: session.user.id,
          chain: body.chain,
          address,
        },
      },
    });
    if (existing) {
      return reply.code(409).send({
        error: 'You are already copying this account.',
        traderId: existing.id,
      });
    }
    try {
      const trader = await prisma.trader.create({
        data: {
          userId: session.user.id,
          chain: body.chain,
          address,
          label: body.label,
          notes: body.notes ?? null,
        },
      });
      return jsonSafe(trader);
    } catch (error) {
      // Race: unique (userId, chain, address) — never allow the same wallet twice per account.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        return reply.code(409).send({
          error: 'You are already copying this account.',
        });
      }
      throw error;
    }
  });

  app.patch('/api/traders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        enabled: z.boolean().optional(),
        label: z.string().min(1).max(64).optional(),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(request.body);
    const sessions = await readBothSessions(request);
    const userIds = [sessions.sol?.user.id, sessions.evm?.user.id].filter(
      (id): id is string => Boolean(id),
    );
    if (userIds.length === 0) {
      return reply.code(401).send({ error: 'Sign in to manage your traders.' });
    }
    const owned = await prisma.trader.findFirst({ where: { id, userId: { in: userIds } } });
    if (!owned) return reply.code(404).send({ error: 'Trader not found on this account.' });
    const trader = await prisma.trader.update({ where: { id: owned.id }, data: body });
    return jsonSafe(trader);
  });

  app.delete('/api/traders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessions = await readBothSessions(request);
    const userIds = [sessions.sol?.user.id, sessions.evm?.user.id].filter(
      (id): id is string => Boolean(id),
    );
    if (userIds.length === 0) {
      return reply.code(401).send({ error: 'Sign in to manage your traders.' });
    }
    const owned = await prisma.trader.findFirst({ where: { id, userId: { in: userIds } } });
    if (!owned) return reply.code(404).send({ error: 'Trader not found on this account.' });
    await prisma.trader.delete({ where: { id: owned.id } });
    return { ok: true };
  });

  app.get('/api/positions', async (request, reply) => {
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    const userId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in to view your positions.' });
    }
    const positions = await prisma.position.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        token: true,
        trades: { orderBy: { createdAt: 'desc' }, take: 8 },
        signals: { include: { trader: true }, orderBy: { createdAt: 'asc' }, take: 4 },
      },
    });
    return jsonSafe(positions);
  });

  app.get('/api/signals', async (request, reply) => {
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    const userId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in to view your signals.' });
    }
    const signals = await prisma.signal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 80,
      include: { trader: true, token: true },
    });
    return jsonSafe(signals);
  });

  app.get('/api/trades', async (request, reply) => {
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    const userId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in to view your trades.' });
    }
    const trades = await prisma.trade.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 80,
      include: { signal: { include: { trader: true } } },
    });
    return jsonSafe(
      trades.map((t) => ({
        ...t,
        explorerUrl: t.txHash ? explorerTxUrl(t.chain, t.txHash) : null,
      })),
    );
  });

  app.get('/api/events', async () => {
    const events = await prisma.systemEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 80,
    });
    return jsonSafe(events);
  });

  app.get('/api/pnl', async (request, reply) => {
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    const userId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in to view your PnL.' });
    }
    const settings = await getSettings();
    const since = settings.pnlResetAt;
    const [closed, open] = await Promise.all([
      prisma.position.findMany({
        where: { userId, status: 'CLOSED', closedAt: { gte: since } },
      }),
      prisma.position.findMany({
        where: { userId, status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
      }),
    ]);
    const realized = closed.reduce((s, p) => s + Number(p.realizedPnlQuote), 0);
    const unrealized = open.reduce((s, p) => s + Number(p.unrealizedPnlQuote ?? 0), 0);
    return jsonSafe({
      since,
      realizedQuote: realized,
      unrealizedQuote: unrealized,
      openCount: open.length,
      closedCount: closed.length,
    });
  });

  app.get('/api/balances', async (request) => {
    const sessions = await readBothSessions(request);
    const [sol, evm, worker] = await Promise.all([
      buildModeBalances('sol', sessions.sol?.user.id),
      buildModeBalances('evm', sessions.evm?.user.id),
      buildWorkerWalletBalances(),
    ]);
    return jsonSafe({
      multiUserCustody: sol.multiUserCustody,
      buckets: {
        trading: 'Available trading balance after savings reservation and fee buffer (RPC).',
        savings: 'Reserved ledger bucket on your custody wallet. Move between buckets in the dashboard; withdraw sends on chain to your connected wallet.',
      },
      sol,
      evm,
      worker,
      wallets: [...sol.wallets, ...evm.wallets],
    });
  });

  app.get('/api/wallet/onchain', async (request, reply) => {
    const query = z
      .object({ address: z.string(), chain: chainSchema.default(Chain.SOLANA) })
      .parse(request.query);
    try {
      if (query.chain === Chain.SOLANA) {
        const address = new PublicKey(query.address).toBase58();
        const balances = await getSolanaBalances(address);
        return jsonSafe({
          chain: query.chain,
          address,
          native: Number(balances.lamports) / 1e9,
          nativeSymbol: 'SOL',
          tokens: balances.tokens,
          slot: balances.slot.toString(),
          source: 'helius+alchemy rpc',
          readAt: new Date().toISOString(),
        });
      }
      const { getNativeBalance } = await import('@copyra/core');
      const address = getAddress(query.address);
      const native = await getNativeBalance(query.chain, address);
      const config = chainConfig(query.chain);
      return jsonSafe({
        chain: query.chain,
        address,
        native: Number(native.amountRaw) / 10 ** config.nativeDecimals,
        nativeSymbol: config.nativeSymbol,
        block: native.blockNumber.toString(),
        source: 'alchemy rpc',
        readAt: new Date().toISOString(),
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/market/:chain/:address', async (request, reply) => {
    const params = z
      .object({ chain: chainSchema, address: z.string() })
      .parse(request.params);
    try {
      const market = await getDexscreenerMarket(params.chain, params.address);
      return jsonSafe(market);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Public browser config — Reown project id is safe to expose. */
  app.get('/api/public-config', async () => {
    const reownProjectId = publicReownProjectId();
    return {
      reownProjectId,
      reownConfigured: Boolean(reownProjectId),
      site: 'https://copyra.fun',
    };
  });

  app.post('/api/auth/nonce', async (request) => {
    const body = z
      .object({
        address: z.string(),
        chain: chainSchema,
        /** Actual browser origin — same-origin POSTs often omit Origin header. */
        clientOrigin: z.string().url().optional(),
        /** location.host — wallets compare SIWE/SIWS domain to this exactly. */
        clientHost: z.string().min(1).max(253).optional(),
        /** Wallet's active EVM chain id (required for SIWE to match MetaMask). */
        chainId: z.number().int().positive().optional(),
      })
      .parse(request.body);

    // EVM: SIWE messages MUST use EIP-55 checksum addresses. Lowercasing the
    // address in the message makes MetaMask refuse with
    // "address does not match the provided address for verification."
    const checksumEvm =
      body.chain === Chain.SOLANA ? null : getAddress(body.address);
    const address =
      body.chain === Chain.SOLANA
        ? new PublicKey(body.address).toBase58()
        : checksumEvm!.toLowerCase();
    const messageAddress =
      body.chain === Chain.SOLANA ? address : checksumEvm!;

    const { nonce, expiresAt } = await issueNonce(address, body.chain);
    const issuedAt = new Date().toISOString();
    let webOrigin = resolveWebOrigin({
      requestHost: String(request.headers['x-forwarded-host'] ?? request.headers.host ?? ''),
      originHeader:
        body.clientOrigin ||
        (typeof request.headers.origin === 'string' ? request.headers.origin : undefined),
      referer: typeof request.headers.referer === 'string' ? request.headers.referer : undefined,
      forwardedProto:
        typeof request.headers['x-forwarded-proto'] === 'string'
          ? request.headers['x-forwarded-proto']
          : undefined,
    });
    // Browser location.host / location.origin are ground truth for wallet domain
    // checks. Keep URI + domain as one consistent pair from the page the user opened.
    let domainHost: string | undefined;
    try {
      const originHost = new URL(webOrigin).host;
      const stripWww = (h: string) => h.replace(/^www\./i, '').toLowerCase();
      const clientHost = body.clientHost?.trim();
      const clientOrigin = body.clientOrigin?.trim();
      let clientOriginHost: string | undefined;
      if (clientOrigin) {
        try {
          clientOriginHost = new URL(clientOrigin).host;
        } catch {
          clientOriginHost = undefined;
        }
      }
      const pairConsistent =
        Boolean(clientHost && clientOriginHost) &&
        clientHost!.toLowerCase() === clientOriginHost!.toLowerCase();
      // Prefer the exact page the browser is on when that origin is allowlisted
      // (covers www vs apex / http vs https without inventing a different domain).
      const clientAllowed =
        pairConsistent &&
        (() => {
          try {
            const host = stripWww(clientHost!);
            // resolveWebOrigin already validated via Origin header path; re-check host kinship.
            return (
              host === stripWww(originHost) ||
              host === 'copyra.fun' ||
              host === 'localhost' ||
              host.startsWith('127.0.0.1') ||
              host.endsWith('.ondigitalocean.app')
            );
          } catch {
            return false;
          }
        })();
      if (clientAllowed) {
        webOrigin = clientOrigin!.replace(/\/+$/, '');
        domainHost = clientHost;
      } else if (clientHost && stripWww(clientHost) === stripWww(originHost)) {
        domainHost = clientHost;
      } else {
        domainHost = originHost;
      }
    } catch {
      domainHost = body.clientHost;
    }

    const evmChainId =
      body.chainId ??
      CHAIN_CONFIGS[body.chain]?.chainId ??
      1;
    const message =
      body.chain === Chain.SOLANA
        ? buildSiwsMessage({
            address: messageAddress,
            nonce,
            issuedAt,
            webOrigin,
            domainHost,
          })
        : buildSiweMessage({
            address: messageAddress,
            nonce,
            chainId: evmChainId,
            issuedAt,
            webOrigin,
            domainHost,
          });
    return {
      nonce,
      address: messageAddress,
      storageAddress: address,
      chain: body.chain,
      chainId: body.chain === Chain.SOLANA ? null : evmChainId,
      message,
      expiresAt,
      webOrigin,
      domainHost,
    };
  });

  app.post('/api/auth/verify', async (request, reply) => {
    const body = z
      .object({
        address: z.string(),
        chain: chainSchema,
        message: z.string(),
        signature: z.string(),
      })
      .parse(request.body);
    const checksumEvm =
      body.chain === Chain.SOLANA ? null : getAddress(body.address);
    const address =
      body.chain === Chain.SOLANA
        ? new PublicKey(body.address).toBase58()
        : checksumEvm!.toLowerCase();
    const verifyAddress =
      body.chain === Chain.SOLANA ? address : checksumEvm!;
    const ok = await verifyWalletSignature({
      ...body,
      address: verifyAddress,
      storageAddress: address,
    });
    if (!ok) return reply.code(401).send({ error: 'Signature verification failed.' });
    const session = await createSession(address, body.chain, reply, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      cookies: request.cookies as Record<string, string | undefined>,
      secureCookie: (() => {
        const proto = String(request.headers['x-forwarded-proto'] ?? '')
          .split(',')[0]
          ?.trim()
          .toLowerCase();
        if (proto === 'http') return false;
        if (proto === 'https') return true;
        const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
        if (origin.startsWith('http://')) return false;
        if (origin.startsWith('https://')) return true;
        return undefined;
      })(),
    });
    return {
      ok: true,
      address: verifyAddress,
      chain: body.chain,
      mode: session.mode,
      expiresAt: session.expiresAt,
    };
  });

  app.get('/api/auth/me', async (request) => {
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    const active = mode === 'evm' ? sessions.evm : sessions.sol;
    const modeUser = (session: typeof sessions.sol) => {
      if (!session) return null;
      const addr = session.user.address?.startsWith('acct_') ? null : session.user.address;
      return {
        id: session.user.id,
        /** Real login wallet only — email/Google sentinels are not wallets. */
        address: addr,
        chain: session.user.chain,
        label: session.user.label,
        email: session.user.email || session.user.googleEmail || null,
        accountOnly: !addr,
      };
    };
    return {
      authenticated: Boolean(sessions.sol || sessions.evm),
      mode,
      user: modeUser(active),
      sol: modeUser(sessions.sol),
      evm: modeUser(sessions.evm),
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const body = z
      .object({ mode: z.enum(['sol', 'evm', 'all']).optional() })
      .catch({})
      .parse(request.body ?? {});
    const mode = (body.mode ?? authModeFromRequest(request)) as AuthMode | 'all';
    await revokeSession(request, reply, mode === 'all' ? 'all' : mode);
    return { ok: true, mode };
  });

  app.get('/api/notifications', async (request, reply) => {
    const query = z
      .object({
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().positive().max(50).default(10),
      })
      .parse(request.query);
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    const userId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in to view your notifications.' });
    }
    const skip = (query.page - 1) * query.pageSize;
    // Only this mode account's trade alerts — never ops / other users / other mode.
    const where = {
      userId,
      kind: { in: ['buy-confirmed', 'sell-confirmed', 'buy-submitted', 'sell-submitted', 'buy-failed', 'sell-failed'] },
    };
    const [total, logs] = await Promise.all([
      prisma.notificationLog.count({ where }),
      prisma.notificationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
      }),
    ]);
    return jsonSafe({
      items: logs,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    });
  });

  app.get('/api/snapshot', async (request) => {
    const sessions = await readBothSessions(request);
    const solUserId = sessions.sol?.user.id;
    const evmUserId = sessions.evm?.user.id;
    const userIds = [solUserId, evmUserId].filter((id): id is string => Boolean(id));
    // Account-private queries for BOTH mode sessions — SOL and EVM never share a userId.
    const emptyPnl = {
      since: null,
      realizedQuote: 0,
      unrealizedQuote: 0,
      openCount: 0,
      closedCount: 0,
    };

    const [status, settingsRes, traders, positions, signals, trades, solBal, evmBal, workerWallets, notifications, transfers, deposits, pnl, solUsd] =
      await Promise.all([
        buildLiveStatus(request),
        getSettings().then(async (row) => {
          const config = await getStrategyConfig();
          return {
            row,
            effective: config,
            blockedReason: tradingBlockedReason(
              row,
              multiUserCustodyEnabled() || solanaSigner.available || evmSigner.available,
            ),
          };
        }),
        userIds.length
          ? prisma.trader.findMany({ where: { userId: { in: userIds } }, orderBy: { createdAt: 'desc' } })
          : Promise.resolve([]),
        userIds.length
          ? prisma.position.findMany({
              where: { userId: { in: userIds } },
              orderBy: { createdAt: 'desc' },
              include: {
                token: true,
                trades: { orderBy: { createdAt: 'desc' }, take: 8 },
                signals: { include: { trader: true }, orderBy: { createdAt: 'asc' }, take: 4 },
              },
            })
          : Promise.resolve([]),
        userIds.length
          ? prisma.signal.findMany({
              where: { userId: { in: userIds } },
              orderBy: { createdAt: 'desc' },
              take: 120,
              include: { trader: true, token: true },
            })
          : Promise.resolve([]),
        userIds.length
          ? prisma.trade.findMany({
              where: { userId: { in: userIds } },
              orderBy: { createdAt: 'desc' },
              take: 120,
              include: { signal: { include: { trader: true } } },
            })
          : Promise.resolve([]),
        // Independent custody reads — never the shared bot signer when a mode session exists.
        buildModeBalances('sol', solUserId),
        buildModeBalances('evm', evmUserId),
        // Transparent worker/bot signer balances (informational — not your trading custody).
        buildWorkerWalletBalances(),
        userIds.length
          ? prisma.notificationLog.findMany({
              // Account Recent Activity: BUY/SELL alerts + Telegram link confirmation.
              // Ops / redeploy stay out of the dashboard feed.
              where: {
                userId: { in: userIds },
                kind: {
                  in: [
                    'buy-confirmed',
                    'sell-confirmed',
                    'buy-submitted',
                    'sell-submitted',
                    'buy-failed',
                    'sell-failed',
                    'telegram-link',
                  ],
                },
              },
              orderBy: { createdAt: 'desc' },
              take: 80,
            })
          : Promise.resolve([]),
        userIds.length
          ? prisma.transfer.findMany({
              where: { userId: { in: userIds } },
              orderBy: { requestedAt: 'desc' },
              take: 80,
            })
          : Promise.resolve([]),
        userIds.length
          ? prisma.custodyDeposit.findMany({
              where: { userId: { in: userIds } },
              orderBy: { createdAt: 'desc' },
              take: 80,
            })
          : Promise.resolve([]),
        userIds.length
          ? (async () => {
              const settings = await getSettings();
              const since = settings.pnlResetAt;
              const [closed, open] = await Promise.all([
                prisma.position.findMany({
                  where: { userId: { in: userIds }, status: 'CLOSED', closedAt: { gte: since } },
                }),
                prisma.position.findMany({
                  where: { userId: { in: userIds }, status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
                }),
              ]);
              return {
                since,
                realizedQuote: closed.reduce((s, p) => s + Number(p.realizedPnlQuote), 0),
                unrealizedQuote: open.reduce((s, p) => s + Number(p.unrealizedPnlQuote ?? 0), 0),
                openCount: open.length,
                closedCount: closed.length,
              };
            })()
          : Promise.resolve(emptyPnl),
        getQuoteAssetPriceUsd(Chain.SOLANA).catch(() => 0),
      ]);

    return jsonSafe({
      status,
      settings: settingsRes,
      traders,
      positions,
      signals,
      trades: trades.map((t) => ({
        ...t,
        explorerUrl: t.txHash ? explorerTxUrl(t.chain, t.txHash) : t.explorerUrl,
      })),
      pnl,
      notifications,
      transfers: transfers.map((tr) => ({
        ...tr,
        explorerUrl: tr.explorerUrl || (tr.txHash ? explorerTxUrl(tr.chain, tr.txHash) : null),
      })),
      deposits: deposits.map((d) => ({
        ...d,
        explorerUrl: d.txHash ? explorerTxUrl(d.chain, d.txHash) : null,
      })),
      auth: {
        sol: sessions.sol
          ? {
              address: sessions.sol.user.address?.startsWith('acct_') ? null : sessions.sol.user.address,
              chain: sessions.sol.user.chain,
              userId: sessions.sol.user.id,
              email: sessions.sol.user.email || sessions.sol.user.googleEmail || null,
              accountOnly: Boolean(sessions.sol.user.address?.startsWith('acct_')),
            }
          : null,
        evm: sessions.evm
          ? {
              address: sessions.evm.user.address?.startsWith('acct_') ? null : sessions.evm.user.address,
              chain: sessions.evm.user.chain,
              userId: sessions.evm.user.id,
              email: sessions.evm.user.email || sessions.evm.user.googleEmail || null,
              accountOnly: Boolean(sessions.evm.user.address?.startsWith('acct_')),
            }
          : null,
      },
      balances: {
        multiUserCustody: solBal.multiUserCustody,
        sol: solBal,
        evm: evmBal,
        worker: workerWallets,
        // Flat list is custody-only when multi-user is on (never mix in the bot signer).
        wallets: [...solBal.wallets, ...evmBal.wallets],
      },
      solUsd,
      readAt: new Date().toISOString(),
    });
  });
}
