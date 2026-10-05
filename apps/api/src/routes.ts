import {
  buildLatencyReport,
  chainConfig,
  CHAIN_CONFIGS,
  evmSigner,
  executableChains,
  explorerTxUrl,
  getDexscreenerMarket,
  getEvmBlockNumber,
  getQuoteAssetPriceUsd,
  getSettings,
  getSlot,
  getSolanaBalances,
  getStrategyConfig,
  monitorableChains,
  publicReownProjectId,
  resolveWebOrigin,
  solanaSigner,
  telegram,
  tradingBlockedReason,
  tradingWalletAddress,
} from '@copyra/core';
import { Chain, prisma, type Prisma } from '@copyra/db';
import { PublicKey } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import {
  buildSiweMessage,
  buildSiwsMessage,
  createSession,
  issueNonce,
  readSession,
  revokeSession,
  verifyWalletSignature,
} from './auth.js';
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

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerSwapRoutes(app);
  // /health is registered in main.ts before plugins so App Platform liveness
  // does not depend on route registration order.

  app.get('/api/status', async () => {
    const settings = await getSettings();
    const signerAvailable = solanaSigner.available || evmSigner.available;
    const telegramStatus = await telegram.verify().catch((error: unknown) => ({
      tokenValid: false,
      botUsername: null,
      canPostToChat: false,
      chatTitle: null,
      error: error instanceof Error ? error.message : String(error),
    }));

    const chains = await Promise.all(
      monitorableChains().map(async (config) => {
        let head: string | null = null;
        let latencyMs: number | null = null;
        let error: string | null = null;
        try {
          if (config.kind === 'solana') {
            const slot = await getSlot();
            head = String(slot.slot);
            latencyMs = slot.latencyMs;
          } else {
            const block = await getEvmBlockNumber(config.chain);
            head = block.blockNumber.toString();
            latencyMs = block.latencyMs;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        return {
          chain: config.chain,
          label: config.label,
          code: config.code,
          kind: config.kind,
          canExecute: config.canExecute,
          executionBlockedReason: config.executionBlockedReason ?? null,
          explorerName: config.explorerName,
          nativeSymbol: config.nativeSymbol,
          head,
          latencyMs,
          error,
        };
      }),
    );

    const heartbeats = await prisma.workerHeartbeat.findMany();
    const [openPositions, signals24h, confirmedTrades] = await Promise.all([
      prisma.position.count({ where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_OPEN'] } } }),
      prisma.signal.count({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
      prisma.trade.findMany({
        where: { status: 'CONFIRMED', totalLatencyMs: { not: null } },
        select: { totalLatencyMs: true, broadcastAt: true, sourceDetectedAt: true },
        take: 200,
      }),
    ]);

    const confirmSamples = confirmedTrades
      .map((t) => t.totalLatencyMs)
      .filter((n): n is number => typeof n === 'number');
    const broadcastSamples = confirmedTrades
      .map((t) =>
        t.broadcastAt && t.sourceDetectedAt
          ? t.broadcastAt.getTime() - t.sourceDetectedAt.getTime()
          : null,
      )
      .filter((n): n is number => typeof n === 'number');

    return jsonSafe({
      trading: {
        envGuard: process.env.TRADING_ENABLED === 'true',
        settingsEnabled: settings.tradingEnabled,
        emergencyStop: settings.emergencyStop,
        blockedReason: tradingBlockedReason(settings, signerAvailable),
        observeOnly: !signerAvailable,
      },
      signers: {
        solana: { available: solanaSigner.available, address: solanaSigner.address },
        evm: { available: evmSigner.available, address: evmSigner.address },
      },
      /** Present/absent only — never includes URL values. */
      rpcConfigured: {
        solana: Boolean(process.env.SOLANA_RPC_URL?.trim()),
        ethereum: Boolean(process.env.EVM_ETHEREUM_RPC_URL?.trim()),
        base: Boolean(process.env.EVM_BASE_RPC_URL?.trim()),
        arbitrum: Boolean(process.env.EVM_ARBITRUM_RPC_URL?.trim()),
        bsc: Boolean(process.env.EVM_BSC_RPC_URL?.trim()),
        polygon: Boolean(process.env.EVM_POLYGON_RPC_URL?.trim()),
        optimism: Boolean(process.env.EVM_OPTIMISM_RPC_URL?.trim()),
      },
      telegram: telegramStatus,
      chains,
      executableChains: executableChains().map((c) => c.chain),
      workers: heartbeats,
      counts: { openPositions, signals24h, confirmedTrades: confirmedTrades.length },
      latency: buildLatencyReport(broadcastSamples, confirmSamples),
      socials: {
        x: 'https://x.com/copyrafun',
        telegram: 'https://t.me/copyrafun',
        domain: 'https://copyra.fun',
      },
    });
  });

  app.get('/api/settings', async () => {
    const row = await getSettings();
    const config = await getStrategyConfig();
    return jsonSafe({
      row,
      effective: config,
      blockedReason: tradingBlockedReason(row, solanaSigner.available || evmSigner.available),
    });
  });

  app.patch('/api/settings', async (request) => {
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
        enabledChains: z.array(chainSchema).optional(),
        ui: z.record(z.unknown()).optional(),
      })
      .parse(request.body);

    const updated = await prisma.strategySettings.update({
      where: { id: 1 },
      data: { ...body, ui: body.ui as Prisma.InputJsonValue | undefined, updatedBy: 'dashboard' },
    });
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
    telegram.send('✅ <b>EMERGENCY STOP CLEARED</b>\nCopy trading may resume if other guards allow it.', {
      kind: 'emergency-clear',
    });
    return jsonSafe(updated);
  });

  app.get('/api/traders', async () => {
    const traders = await prisma.trader.findMany({ orderBy: { createdAt: 'desc' } });
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
    let address: string;
    try {
      address = parseChainAddress(body.chain, body.address.trim());
    } catch {
      return reply.code(400).send({ error: 'Invalid address for the selected chain.' });
    }
    const trader = await prisma.trader.upsert({
      where: { chain_address: { chain: body.chain, address } },
      create: { chain: body.chain, address, label: body.label, notes: body.notes ?? null },
      update: { label: body.label, notes: body.notes ?? null, enabled: true },
    });
    return jsonSafe(trader);
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
    try {
      const trader = await prisma.trader.update({ where: { id }, data: body });
      return jsonSafe(trader);
    } catch {
      return reply.code(404).send({ error: 'Trader not found' });
    }
  });

  app.delete('/api/traders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await prisma.trader.delete({ where: { id } });
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: 'Trader not found' });
    }
  });

  app.get('/api/positions', async () => {
    const positions = await prisma.position.findMany({
      orderBy: { createdAt: 'desc' },
      include: { token: true, trades: { orderBy: { createdAt: 'desc' }, take: 8 } },
    });
    return jsonSafe(positions);
  });

  app.get('/api/signals', async () => {
    const signals = await prisma.signal.findMany({
      orderBy: { createdAt: 'desc' },
      take: 80,
      include: { trader: true, token: true },
    });
    return jsonSafe(signals);
  });

  app.get('/api/trades', async () => {
    const trades = await prisma.trade.findMany({
      orderBy: { createdAt: 'desc' },
      take: 80,
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

  app.get('/api/pnl', async () => {
    const settings = await getSettings();
    const since = settings.pnlResetAt;
    const [closed, open] = await Promise.all([
      prisma.position.findMany({
        where: { status: 'CLOSED', closedAt: { gte: since } },
      }),
      prisma.position.findMany({
        where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
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

  app.get('/api/balances', async () => {
    const out = [];
    for (const chain of [Chain.SOLANA, Chain.BASE] as const) {
      const address = tradingWalletAddress(chain);
      if (!address) {
        out.push({
          chain,
          configured: false,
          address: null,
          detail: 'No bot signing key configured. Trading balance cannot be read because there is no trading wallet.',
        });
        continue;
      }
      try {
        const { getTradingAvailableQuote } = await import('@copyra/core');
        const funds = await getTradingAvailableQuote(chain);
        if (chain === Chain.SOLANA) {
          const balances = await getSolanaBalances(address);
          out.push({
            chain,
            configured: true,
            address,
            nativeRaw: balances.lamports.toString(),
            native: funds.availableQuote,
            onChainNative: funds.onChainQuote,
            savings: funds.savingsQuote,
            tokens: balances.tokens,
            slot: balances.slot.toString(),
            source: 'rpc',
          });
        } else {
          out.push({
            chain,
            configured: true,
            address,
            native: funds.availableQuote,
            onChainNative: funds.onChainQuote,
            savings: funds.savingsQuote,
            source: 'rpc',
          });
        }
      } catch (error) {
        out.push({
          chain,
          configured: true,
          address,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return jsonSafe({
      buckets: {
        trading: 'Available trading balance after savings reservation and fee buffer (RPC).',
        savings: 'Reserved ledger bucket on the bot wallet — move between buckets in the dashboard; withdraw sends on-chain to your connected wallet.',
      },
      wallets: out,
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
    return { ok: true, address: verifyAddress, chain: body.chain, expiresAt: session.expiresAt };
  });

  app.get('/api/auth/me', async (request) => {
    const session = await readSession(request);
    if (!session) return { authenticated: false, user: null };
    return {
      authenticated: true,
      user: {
        id: session.user.id,
        address: session.user.address,
        chain: session.user.chain,
        label: session.user.label,
      },
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await revokeSession(request, reply);
    return { ok: true };
  });

  app.get('/api/notifications', async () => {
    const logs = await prisma.notificationLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    return jsonSafe(logs);
  });

  app.get('/api/snapshot', async () => {
    const [statusRes, settingsRes, traders, positions, signals, trades, pnlRes, balancesRes] =
      await Promise.all([
        app.inject({ method: 'GET', url: '/api/status' }),
        app.inject({ method: 'GET', url: '/api/settings' }),
        app.inject({ method: 'GET', url: '/api/traders' }),
        app.inject({ method: 'GET', url: '/api/positions' }),
        app.inject({ method: 'GET', url: '/api/signals' }),
        app.inject({ method: 'GET', url: '/api/trades' }),
        app.inject({ method: 'GET', url: '/api/pnl' }),
        app.inject({ method: 'GET', url: '/api/balances' }),
      ]);

    let solUsd = 0;
    try {
      solUsd = await getQuoteAssetPriceUsd(Chain.SOLANA);
    } catch {
      solUsd = 0;
    }

    return jsonSafe({
      status: statusRes.json(),
      settings: settingsRes.json(),
      traders: traders.json(),
      positions: positions.json(),
      signals: signals.json(),
      trades: trades.json(),
      pnl: pnlRes.json(),
      balances: balancesRes.json(),
      solUsd,
      readAt: new Date().toISOString(),
    });
  });
}
