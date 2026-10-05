import {
  buildJupiterSwap,
  chainConfig,
  confirmSolanaTransaction,
  explorerTxUrl,
  getJupiterQuote,
  solanaPool,
} from '@copyra/core';
import { Chain, prisma, TradeReason, TradeSide, TxStatus } from '@copyra/db';
import { VersionedTransaction } from '@solana/web3.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readSession } from './auth.js';
import { jsonSafe } from './serialize.js';

async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const session = await readSession(request);
  if (!session) {
    reply.code(401).send({
      error: 'Connect a wallet and sign in first. COPYRA never asks for your private key.',
    });
    return null;
  }
  return session;
}

export async function registerSwapRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/swap/quote', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        inputMint: z.string().min(32),
        outputMint: z.string().min(32),
        amountRaw: z.string().regex(/^[0-9]+$/),
        slippageBps: z.number().int().positive().max(5_000).default(100),
      })
      .parse(request.body);

    const quote = await getJupiterQuote({
      inputMint: body.inputMint,
      outputMint: body.outputMint,
      amountRaw: body.amountRaw,
      slippageBps: body.slippageBps,
    });
    return jsonSafe({
      quote: quote.quote,
      receivedAt: quote.receivedAt,
      latencyMs: quote.latencyMs,
      endpoint: quote.endpoint,
      priceImpactPct: quote.priceImpactPct,
      routeLabels: quote.routeLabels,
      wallet: session.user.address,
      note: 'This is a live Jupiter quote. It is not a fill.',
    });
  });

  app.post('/api/swap/build', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (session.user.chain !== Chain.SOLANA) {
      return reply.code(400).send({ error: 'User-signed Jupiter builds are Solana-only. Sign in with a Solana wallet.' });
    }
    const body = z
      .object({
        quote: z.record(z.unknown()),
        userPublicKey: z.string().min(32),
      })
      .parse(request.body);
    if (body.userPublicKey !== session.user.address) {
      return reply.code(403).send({ error: 'Build address must match the signed-in Solana wallet.' });
    }

    const built = await buildJupiterSwap({
      quote: body.quote as unknown as Parameters<typeof buildJupiterSwap>[0]['quote'],
      userPublicKey: body.userPublicKey,
      wrapAndUnwrapSol: true,
    });
    return jsonSafe({
      swapTransaction: built.swapTransaction,
      lastValidBlockHeight: built.lastValidBlockHeight,
      latencyMs: built.latencyMs,
      signed: false,
      note: 'Unsigned Jupiter transaction. Sign it in your wallet. COPYRA does not store user keys.',
    });
  });

  app.post('/api/swap/broadcast', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        signedTransaction: z.string().min(32),
        lastValidBlockHeight: z.number().int().positive(),
        inputMint: z.string().optional(),
        outputMint: z.string().optional(),
        amountRaw: z.string().optional(),
      })
      .parse(request.body);

    let transaction: VersionedTransaction;
    try {
      transaction = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, 'base64'));
    } catch {
      return reply.code(400).send({ error: 'signedTransaction is not a valid base64 VersionedTransaction.' });
    }

    const send = await solanaPool().call('sendRawTransaction', (client) =>
      client.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 0,
        preflightCommitment: 'confirmed',
      }),
    );
    const signature = send.value;

    const trade = await prisma.trade.create({
      data: {
        idempotencyKey: `user-swap:${session.user.address}:${signature}`,
        chain: Chain.SOLANA,
        side: TradeSide.BUY,
        reason: TradeReason.MANUAL,
        tokenAddress: body.outputMint ?? 'user-swap',
        quoteAsset: chainConfig(Chain.SOLANA).quoteAsset,
        quoteAssetSymbol: 'SOL',
        quoteDecimals: 9,
        status: TxStatus.BROADCAST,
        txHash: signature,
        explorerUrl: explorerTxUrl(Chain.SOLANA, signature),
        requestedAmountRaw: body.amountRaw ?? '0',
        broadcastAt: new Date(),
      },
    });

    const confirmation = await confirmSolanaTransaction(signature, body.lastValidBlockHeight, 60_000);
    await prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: confirmation.status,
        confirmations: confirmation.confirmations,
        confirmedAt: confirmation.status === TxStatus.CONFIRMED ? confirmation.confirmedAt : null,
        failedAt: confirmation.status === TxStatus.CONFIRMED ? null : new Date(),
        errorMessage: confirmation.error,
        blockNumber: confirmation.slot,
      },
    });

    return jsonSafe({
      txHash: signature,
      explorerUrl: explorerTxUrl(Chain.SOLANA, signature),
      status: confirmation.status,
      confirmations: confirmation.confirmations,
      error: confirmation.error,
      executed: confirmation.status === TxStatus.CONFIRMED,
      note:
        confirmation.status === TxStatus.CONFIRMED
          ? 'Confirmed on-chain via getSignatureStatuses.'
          : 'Not confirmed. The explorer link is the only proof path — this response is not a fill.',
    });
  });

  app.get('/api/swap/tx/:signature', async (request, reply) => {
    const { signature } = request.params as { signature: string };
    if (!signature || signature.length < 32) {
      return reply.code(400).send({ error: 'Missing signature' });
    }
    const confirmation = await confirmSolanaTransaction(signature, 9_999_999_999, 4_000);
    return jsonSafe({
      txHash: signature,
      explorerUrl: explorerTxUrl(Chain.SOLANA, signature),
      status: confirmation.status,
      confirmations: confirmation.confirmations,
      error: confirmation.error,
      executed: confirmation.status === TxStatus.CONFIRMED,
    });
  });
}
