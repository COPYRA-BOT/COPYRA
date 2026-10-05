import {
  buildEvmDepositIntent,
  buildSolanaDepositTransaction,
  broadcastSolanaDeposit,
  getTradingAvailableQuote,
  moveBucket,
  withdrawToWallet,
} from '@copyra/core';
import { Chain } from '@copyra/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readSession } from './auth.js';
import { jsonSafe } from './serialize.js';

const chainSchema = z.nativeEnum(Chain);

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

function modeChain(mode: 'sol' | 'evm', preferred?: Chain): Chain {
  if (mode === 'sol') return Chain.SOLANA;
  if (preferred && preferred !== Chain.SOLANA) return preferred;
  return Chain.BASE;
}

export async function registerFundsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/funds', async (request, reply) => {
    const query = z
      .object({
        chain: chainSchema.optional(),
        mode: z.enum(['sol', 'evm']).optional(),
      })
      .parse(request.query);
    const chain = query.chain ?? (query.mode === 'evm' ? Chain.BASE : Chain.SOLANA);
    try {
      const funds = await getTradingAvailableQuote(chain);
      return jsonSafe({
        chain,
        ...funds,
        buckets: {
          trading: funds.availableQuote,
          savings: funds.savingsQuote,
          onChain: funds.onChainQuote,
        },
        note: funds.configured
          ? 'Trading available = on-chain bot wallet minus savings reservation and fee buffer. Savings is a ledger reservation on the same wallet.'
          : 'No bot signing key — deposit destination and withdraw are unavailable until the host secret store has the Solana/EVM bot signing material.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(503).send({
        error: message,
        chain,
        hint:
          'Set SOLANA_RPC_URL / EVM_*_RPC_URL (and WS) as encrypted App-Level env vars scoped to ALL components, then redeploy. Bot keys alone are not enough to read balances.',
      });
    }
  });

  app.post('/api/funds/move', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        direction: z.enum(['t2s', 's2t']),
        amount: z.number().positive(),
        chain: chainSchema.optional(),
      })
      .parse(request.body);
    try {
      const result = await moveBucket({
        chain: modeChain(body.mode, body.chain),
        direction: body.direction,
        amountQuote: body.amount,
      });
      return jsonSafe({ ok: true, ...result });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/build', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        amount: z.number().positive(),
        chain: chainSchema.optional(),
      })
      .parse(request.body);

    try {
      if (body.mode === 'sol') {
        if (session.user.chain !== Chain.SOLANA) {
          return reply.code(400).send({ error: 'Sign in with a Solana wallet to deposit SOL.' });
        }
        const built = await buildSolanaDepositTransaction({
          fromAddress: session.user.address,
          amountSol: body.amount,
        });
        return jsonSafe({
          kind: 'solana',
          ...built,
          fromAddress: session.user.address,
          note: 'Sign this transfer in your wallet. Funds move on-chain to the COPYRA trading wallet.',
        });
      }
      const chain = modeChain('evm', body.chain);
      const intent = buildEvmDepositIntent({ chain, amountNative: body.amount });
      return jsonSafe({
        kind: 'evm',
        ...intent,
        fromAddress: session.user.address,
        note: 'Send this transaction from your connected EVM wallet. Funds move on-chain to the COPYRA trading wallet.',
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/broadcast', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        signedTransaction: z.string().min(32),
        lastValidBlockHeight: z.number().int().positive(),
        lamports: z.string().regex(/^[0-9]+$/),
      })
      .parse(request.body);
    try {
      const result = await broadcastSolanaDeposit({
        signedTransactionBase64: body.signedTransaction,
        lastValidBlockHeight: body.lastValidBlockHeight,
        fromAddress: session.user.address,
        lamports: body.lamports,
      });
      return jsonSafe(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/record-evm', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        chain: chainSchema,
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        amount: z.number().positive(),
      })
      .parse(request.body);
    // User already broadcast via their wallet; we only confirm via RPC and ledger the Transfer row.
    try {
      const { confirmEvmTransaction, explorerTxUrl, chainConfig } = await import('@copyra/core');
      const config = chainConfig(body.chain);
      const confirmation = await confirmEvmTransaction(
        body.chain,
        body.txHash as `0x${string}`,
        90_000,
        config.requiredConfirmations,
      );
      const { prisma, BalanceBucket, TxStatus } = await import('@copyra/db');
      await prisma.transfer.create({
        data: {
          chain: body.chain,
          fromBucket: BalanceBucket.TRADING,
          toBucket: BalanceBucket.TRADING,
          assetAddress: 'native',
          assetSymbol: config.nativeSymbol,
          amountRaw: BigInt(Math.floor(body.amount * 10 ** config.nativeDecimals)).toString(),
          status: confirmation.status,
          txHash: body.txHash,
          explorerUrl: explorerTxUrl(body.chain, body.txHash),
          errorMessage: confirmation.error,
          confirmedAt: confirmation.status === TxStatus.CONFIRMED ? new Date() : null,
        },
      });
      return jsonSafe({
        txHash: body.txHash,
        explorerUrl: explorerTxUrl(body.chain, body.txHash),
        status: confirmation.status,
        executed: confirmation.status === 'CONFIRMED',
        error: confirmation.error,
        wallet: session.user.address,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/withdraw', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        amount: z.number().positive(),
        fromBucket: z.enum(['savings', 'trading']).default('savings'),
        chain: chainSchema.optional(),
      })
      .parse(request.body);

    const chain = modeChain(body.mode, body.chain);
    if (body.mode === 'sol' && session.user.chain !== Chain.SOLANA) {
      return reply.code(400).send({ error: 'Sign in with a Solana wallet to withdraw SOL.' });
    }
    if (body.mode === 'evm' && session.user.chain === Chain.SOLANA) {
      return reply.code(400).send({ error: 'Sign in with an EVM wallet to withdraw on EVM.' });
    }

    try {
      const result = await withdrawToWallet({
        chain,
        toAddress: session.user.address,
        amountQuote: body.amount,
        fromBucket: body.fromBucket,
      });
      return jsonSafe({ ok: true, ...result });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
